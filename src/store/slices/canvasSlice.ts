/**
 * @file canvasSlice.ts
 * @description Store 自由画布切片：区块增删改 / K线划线 / 备注 / 布局回写 / 行情保鲜。
 *              写路径统一经本切片（spec §8.3）：变更 → set → 800ms 防抖 safePersist 整块写回
 *              canvasBoards。动作消费（annotate_block/execute_local_calc）经 blockId 串行队列，
 *              执行最后一刻二次校验区块存活（spec §6.3 时序冲突防线）。
 * @layer Store (Slice)
 * @storage_impact 经 safePersist 写 canvasBoards 表（整块序列化，规避 Dexie 同 tick 隐式 put 覆盖）。
 * @author 开发团队
 */

import type { StateCreator } from 'zustand';
import type {
  CanvasBlock,
  CanvasBlockType,
  CanvasBlockData,
  TrendLine,
  HLine,
  BlockNote,
} from '../../types/domain';
import { nextBlockId, nextLayout } from '../../utils/canvasLayout';
import { getCanvasTemplate } from '../../utils/canvasTemplates';
import { safePersist } from '../../utils/persistence';
import { saveBoard, loadBoard, refreshAllKlines } from '../../services/canvasService';
import { generateId } from '../../utils/idGenerator';
import type { AppStore } from '../types';

/** 800ms 防抖保存（spec §8.3：拖拽/编辑结束静默 800ms 后整块写回） */
const PERSIST_DEBOUNCE_MS = 800;

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 防抖调度：触发时读取最新 blocks + labelSeq 整块写回（每次触发重置计时器）。
 * @param getState - 触发时刻的状态读取器（防抖窗口内的多次变更合并为一次落库）
 * @param onSettled - 落库结算回调（保存态指示翻转用）
 */
function scheduleCanvasPersist(
  getState: () => { blocks: CanvasBlock[]; labelSeq: number },
  onSettled?: () => void,
): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const { blocks, labelSeq } = getState();
    void safePersist(() => saveBoard(blocks, labelSeq))
      .then(() => onSettled?.())
      .catch(() => onSettled?.());
  }, PERSIST_DEBOUNCE_MS);
}

// ============================================================
// blockId 串行队列（多 SSE 流并发防线，spec §2.5-5）
// ============================================================

/** 每个标号一条 promise 链：同区块任务严格串行，跨区块并行 */
const blockTaskQueues = new Map<string, Promise<void>>();

/**
 * 入队一个针对某区块的任务：同 blockId 串行执行（前一个完成才轮到下一个）。
 * 任务内部抛错被吞掉（记 console），不阻断队列后续任务。
 */
function enqueueBlockTask(blockId: string, task: () => Promise<void> | void): Promise<void> {
  const prev = blockTaskQueues.get(blockId) ?? Promise.resolve();
  const next = prev.then(task).catch((e) => console.warn('[canvasSlice] block task failed', blockId, e));
  blockTaskQueues.set(blockId, next);
  // 链尾清理：完成后若仍是队尾则移除，防 Map 无界增长
  void next.finally(() => {
    if (blockTaskQueues.get(blockId) === next) blockTaskQueues.delete(blockId);
  });
  return next;
}

export type CanvasSlice = Pick<
  AppStore,
  | 'loadCanvas'
  | 'addCanvasBlock'
  | 'removeCanvasBlock'
  | 'updateCanvasBlockData'
  | 'updateCanvasLayouts'
  | 'addTrendLine'
  | 'addHLine'
  | 'removeDrawing'
  | 'clearDrawings'
  | 'addBlockNote'
  | 'removeBlockNote'
  | 'refreshCanvasKlines'
  | 'runBlockTask'
>;

export const createCanvasSlice: StateCreator<AppStore, [], [], CanvasSlice> = (set, get) => {
  /** 统一变更出口：set 新 blocks → 防抖落库（保存态指示同步翻转） */
  const applyBlocks = (blocks: CanvasBlock[]) => {
    set({ canvasBlocks: blocks, canvasSaveState: 'saving' });
    scheduleCanvasPersist(
      () => ({ blocks: get().canvasBlocks, labelSeq: get().canvasLabelSeq }),
      () => {
        // 防抖窗口内无新调度才回 idle（否则保持 saving）
        if (!persistTimer) set({ canvasSaveState: 'idle' });
      },
    );
  };

  return {
    loadCanvas: async () => {
      const board = await loadBoard();
      set({
        canvasBlocks: board?.blocks ?? [],
        canvasLabelSeq: board?.labelSeq ?? 0,
        canvasLoaded: true,
        canvasSaveState: 'idle',
      });
    },

    addCanvasBlock: (type, data) => {
      const seq = get().canvasLabelSeq + 1;
      const blockId = nextBlockId(seq);
      const layout = nextLayout(get().canvasBlocks, type);
      // 各类型初始 data 由模板注册表提供（spec §4.5 初始态；kline 留空 fullCode 走占位态选股；
      // 注册表缺 initData 的静态模板兜底空对象——一期八类均有 initData，兜底为防御）
      const defaults = getCanvasTemplate(type)?.initData?.() ?? ({} as CanvasBlockData[CanvasBlockType]);
      const block: CanvasBlock = {
        blockId,
        type,
        layout,
        data: data ?? defaults,
        notes: [],
      };
      applyBlocks([...get().canvasBlocks, block]);
      // labelSeq 与 blocks 同批防抖落库（applyBlocks 触发时刻读取最新 state，含本次 seq）
      set({ canvasLabelSeq: seq });
      return blockId;
    },

    removeCanvasBlock: (blockId) => {
      applyBlocks(get().canvasBlocks.filter((b) => b.blockId !== blockId));
    },

    updateCanvasBlockData: (blockId, data) => {
      applyBlocks(get().canvasBlocks.map((b) => (b.blockId === blockId ? { ...b, data } : b)));
    },

    updateCanvasLayouts: (layouts) => {
      const map = new Map(layouts.map((l) => [l.blockId, l.layout]));
      applyBlocks(get().canvasBlocks.map((b) => (map.has(b.blockId) ? { ...b, layout: map.get(b.blockId)! } : b)));
    },

    // -- K 线划线（spec §5：划线即数据，改写区块 data.trendLines/hLines） --

    addTrendLine: (blockId, line) => {
      const block = get().canvasBlocks.find((b) => b.blockId === blockId);
      if (!block || block.type !== 'kline') return;
      const data = block.data as CanvasBlockData['kline'];
      const newLine: TrendLine = { ...line, id: generateId() };
      applyBlocks(
        get().canvasBlocks.map((b) =>
          b.blockId === blockId ? { ...b, data: { ...data, trendLines: [...data.trendLines, newLine] } } : b,
        ),
      );
    },

    addHLine: (blockId, line) => {
      const block = get().canvasBlocks.find((b) => b.blockId === blockId);
      if (!block || block.type !== 'kline') return;
      const data = block.data as CanvasBlockData['kline'];
      const newLine: HLine = { ...line, id: generateId() };
      applyBlocks(
        get().canvasBlocks.map((b) =>
          b.blockId === blockId ? { ...b, data: { ...data, hLines: [...data.hLines, newLine] } } : b,
        ),
      );
    },

    removeDrawing: (blockId, kind, lineId) => {
      const block = get().canvasBlocks.find((b) => b.blockId === blockId);
      if (!block || block.type !== 'kline') return;
      const data = block.data as CanvasBlockData['kline'];
      applyBlocks(
        get().canvasBlocks.map((b) =>
          b.blockId === blockId
            ? {
                ...b,
                data: {
                  ...data,
                  trendLines: kind === 'trend' ? data.trendLines.filter((l) => l.id !== lineId) : data.trendLines,
                  hLines: kind === 'h' ? data.hLines.filter((l) => l.id !== lineId) : data.hLines,
                },
              }
            : b,
        ),
      );
    },

    clearDrawings: (blockId) => {
      const block = get().canvasBlocks.find((b) => b.blockId === blockId);
      if (!block || block.type !== 'kline') return;
      const data = block.data as CanvasBlockData['kline'];
      applyBlocks(
        get().canvasBlocks.map((b) =>
          b.blockId === blockId ? { ...b, data: { ...data, trendLines: [], hLines: [] } } : b,
        ),
      );
    },

    // -- 备注（spec §6.1） --

    addBlockNote: (blockId, content, source) => {
      const note: BlockNote = { id: generateId(), source, content, createdAt: new Date().toISOString() };
      applyBlocks(
        get().canvasBlocks.map((b) => (b.blockId === blockId ? { ...b, notes: [...b.notes, note] } : b)),
      );
      return note.id;
    },

    removeBlockNote: (blockId, noteId) => {
      applyBlocks(
        get().canvasBlocks.map((b) =>
          b.blockId === blockId ? { ...b, notes: b.notes.filter((n) => n.id !== noteId) } : b,
        ),
      );
    },

    // -- 行情保鲜（spec §5.1.1：绕内存缓存增量刷新，失败静默保留旧数据） --

    refreshCanvasKlines: async () => {
      const klineBlocks = get()
        .canvasBlocks.filter((b) => b.type === 'kline' && (b.data as CanvasBlockData['kline']).fullCode);
      if (!klineBlocks.length) return { ok: [], failed: [] };
      // 统一取数入口（模板注册表）：传区块引用，refreshAllKlines 内经 kline.fetchData force 强拉
      return refreshAllKlines(klineBlocks);
    },

    // -- 动作消费队列（spec §6.3：执行最后一刻二次校验区块存活，不存在静默拦截） --

    runBlockTask: (blockId, task) =>
      enqueueBlockTask(blockId, () => {
        // 执行最后一刻存活校验：AI 思考期间区块可能已被删除
        if (!get().canvasBlocks.some((b) => b.blockId === blockId)) {
          console.warn('[canvasSlice] block gone, task dropped:', blockId);
          return;
        }
        return task();
      }),
  };
};
