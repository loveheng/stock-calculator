/**
 * @file copilotActionSlice.ts
 * @description Store Copilot 动作后处理切片（V1 Action Pipeline）：消费 LLM 响应中的
 *              actions（不可信输入，先经 utils/copilotActions 白名单 + 形状守卫），
 *              auto 级立即执行（notify 全局弹窗 / focus_block 聚焦 / apply_filter 筛选），
 *              confirm 级入队等待用户在浮窗确认卡上执行/忽略。
 *              关键约束：
 *              - 动作仅在响应返回时执行一次（dispatchAsk 挂载点），不随消息渲染/历史回放重放
 *                （actions 不落库，刷新即失，与 contextSummary 同属「在线在场态」）；
 *              - 业务写操作（confirm 级）严禁跳过确认直接执行 —— AI 只建议，用户拍板；
 *              - auto 级聚焦/筛选均为幂等 UI 效果，未注册目标静默忽略，不做跨页强跳。
 * @layer Store (Slice)
 * @storage_impact 全内存态（copilotNotice / pendingCopilotActions），不落库，刷新即失。
 * @author 开发团队
 */

import type { StateCreator } from 'zustand';
import type { AppStore, PendingCopilotAction } from '../types';
import type {
  CopilotCanvasAddBlockPayload,
  CopilotCanvasAddWidgetPayload,
  CopilotCanvasSetStockPayload,
  CopilotCanvasUpdateTextPayload,
  CopilotCanvasSetMetricPayload,
  CopilotCanvasUpdateTablePayload,
  CopilotCanvasAddHLinePayload,
  CopilotCanvasAddTrendlinePayload,
  CopilotCanvasRemoveBlockPayload,
  CanvasBlockData,
} from '../../types/domain';
import {
  sanitizeCopilotActions,
  asNotifyPayload,
  asFocusBlockPayload,
  asApplyFilterPayload,
  asRunStatPayload,
  type SanitizedCopilotPayload,
} from '../../utils/copilotActions';
import { allCanvasOperationMeta, getCanvasTemplate } from '../../utils/canvasTemplates';
import { prewarmSandbox } from '../../utils/customStats/client';

/** 待确认动作 id 序列（内存态，无需 ulid 级别防撞） */
let pendingSeq = 0;

/** 放行通道队列转发：已批准类型的新动作直接进执行器（与确认卡执行同一落点） */
function queueCanvasAction(get: () => AppStore, type: string, payload: SanitizedCopilotPayload): void {
  dispatchCanvasAction(get, type, payload);
}

/**
 * 画布动作「人话摘要」（确认卡/会话内放行 toast 共用）：按类型 + 载荷生成一句话，
 * 让用户在聊天流内看懂要确认/已执行的是什么，不必去猜动作名。
 */
function summarizeCanvasAction(type: string, payload: unknown): string {
  const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  const id = typeof p.blockId === 'string' ? p.blockId : '';
  switch (type) {
    case 'annotate_block':
      return `给 ${id} 写备注`;
    case 'canvas_add_block':
      return `新建${typeof p.type === 'string' ? p.type : ''}区块${typeof p.stockCode === 'string' ? `（${p.stockCode}）` : ''}`;
    case 'canvas_add_widget': {
      const dsl = (typeof p.dsl === 'object' && p.dsl !== null ? p.dsl : {}) as Record<string, unknown>;
      return `新建动态面板「${typeof dsl.title === 'string' ? dsl.title : '未命名'}」（${Array.isArray(dsl.nodes) ? dsl.nodes.length : 0} 项）`;
    }
    case 'canvas_set_stock':
      return `${id} 换股为 ${typeof p.fullCode === 'string' ? p.fullCode : ''}`;
    case 'canvas_update_text':
      return `覆写 ${id} 文本`;
    case 'canvas_set_metric':
      return `设置 ${id} 指标「${typeof p.label === 'string' ? p.label : ''}」`;
    case 'canvas_update_table':
      return `写入 ${id} 表格（${Array.isArray(p.rows) ? p.rows.length : 0} 行）`;
    case 'canvas_add_hline':
      return `${id} 加水平线 @ ${typeof p.price === 'number' ? p.price.toFixed(2) : ''}`;
    case 'canvas_add_trendline':
      return `${id} 加趋势线 ${typeof p.startTime === 'string' ? p.startTime : ''} → ${typeof p.endTime === 'string' ? p.endTime : ''}`;
    case 'canvas_remove_block':
      return `删除区块 ${id}`;
    default:
      return `AI 建议执行：${type}`;
  }
}

/**
 * 画布操作执行器表（slice 层持有 store 闭包；注册表只存元数据 tier/guard——R2 禁 utils→store）。
 * 键 = canvas_ 动作后缀（op 名）；行为与注册表分发前一比一（等价性由单测对拍保障）。
 */
interface CanvasExecCtx {
  get: () => AppStore;
  toast: (msg: string) => void;
  report: (ok: boolean) => void;
  summary: string;
}

const CANVAS_EXECUTORS: Record<string, (ctx: CanvasExecCtx, payload: SanitizedCopilotPayload) => boolean> = {
  add_block: ({ get, toast, summary }, payload) => {
    const p = payload as unknown as CopilotCanvasAddBlockPayload;
    get().addCanvasBlock(p.type);
    if (p.type === 'kline' && p.stockCode) {
      // 带码直接绑定：取最新区块标号写入 fullCode
      const blocks = get().canvasBlocks;
      const last = blocks[blocks.length - 1];
      if (last) get().updateCanvasBlockData(last.blockId, { fullCode: p.stockCode, stockName: p.stockCode, maVisible: true, trendLines: [], hLines: [] } as CanvasBlockData['kline']);
    }
    if (p.type === 'text' && p.content) {
      const blocks = get().canvasBlocks;
      const last = blocks[blocks.length - 1];
      if (last) get().updateCanvasBlockData(last.blockId, { content: p.content });
    }
    if (p.type === 'brief' && p.stockCode) {
      // 带码直接绑定：data 形状复用模板 initData 单一事实源（与 kline 同款「建块后写标的」形态）
      const blocks = get().canvasBlocks;
      const last = blocks[blocks.length - 1];
      const briefData = getCanvasTemplate('brief')?.initData?.({ stockCode: p.stockCode });
      if (last && briefData) get().updateCanvasBlockData(last.blockId, briefData as CanvasBlockData['brief']);
    }
    toast(`✅ ${summary} 完成`);
    return true;
  },
  add_widget: ({ get, toast, summary }, payload) => {
    const p = payload as unknown as CopilotCanvasAddWidgetPayload;
    // DSL 已过双守卫（sanitize + dispatch 二次校验，validateWidgetDsl 单一入口），直接带 data 落块
    get().addCanvasBlock('widget', { dsl: p.dsl } as CanvasBlockData['widget']);
    toast(`✅ ${summary} 完成`);
    return true;
  },
  refresh_klines: ({ get, toast }) => {
    void get().refreshCanvasKlines();
    toast('✅ 画布行情刷新中');
    return true;
  },
  set_stock: ({ get, report }, payload) => {
    const p = payload as unknown as CopilotCanvasSetStockPayload;
    const name = p.stockName ?? p.fullCode;
    void get().runBlockTask(p.blockId, () => {
      get().updateCanvasBlockData(p.blockId, { fullCode: p.fullCode, stockName: name, maVisible: true, trendLines: [], hLines: [] } as CanvasBlockData['kline']);
      report(true);
    });
    return true;
  },
  update_text: ({ get, report }, payload) => {
    const p = payload as unknown as CopilotCanvasUpdateTextPayload;
    void get().runBlockTask(p.blockId, () => {
      get().updateCanvasBlockData(p.blockId, { content: p.content });
      report(true);
    });
    return true;
  },
  set_metric: ({ get, report }, payload) => {
    const p = payload as unknown as CopilotCanvasSetMetricPayload;
    void get().runBlockTask(p.blockId, () => {
      const next: CanvasBlockData['metric'] = { label: p.label };
      if (p.value !== undefined) next.value = p.value;
      else if (p.calc) next.calc = p.calc;
      get().updateCanvasBlockData(p.blockId, next);
      report(true);
    });
    return true;
  },
  update_table: ({ get, report }, payload) => {
    const p = payload as unknown as CopilotCanvasUpdateTablePayload;
    void get().runBlockTask(p.blockId, () => {
      get().updateCanvasBlockData(p.blockId, { columns: p.columns, rows: p.rows });
      report(true);
    });
    return true;
  },
  add_hline: ({ get, report }, payload) => {
    const p = payload as unknown as CopilotCanvasAddHLinePayload;
    void get().runBlockTask(p.blockId, () => {
      get().addHLine(p.blockId, { price: p.price, label: p.label ?? `水平线 ${p.price.toFixed(2)}` });
      report(true);
    });
    return true;
  },
  add_trendline: ({ get, report }, payload) => {
    const p = payload as unknown as CopilotCanvasAddTrendlinePayload;
    void get().runBlockTask(p.blockId, () => {
      get().addTrendLine(p.blockId, {
        startTime: p.startTime, startPrice: p.startPrice,
        endTime: p.endTime, endPrice: p.endPrice,
      });
      report(true);
    });
    return true;
  },
  remove_block: ({ get, toast, summary }, payload) => {
    const p = payload as unknown as CopilotCanvasRemoveBlockPayload;
    // 删除前校验存活：已删则 toast 说明，不空报成功
    const exists = get().canvasBlocks.some((b) => b.blockId === p.blockId);
    if (!exists) {
      toast(`⚠️ ${summary} 未生效（区块不存在）`);
      return true;
    }
    get().removeCanvasBlock(p.blockId);
    toast(`✅ ${summary} 完成`);
    return true;
  },
};

/**
 * 画布动作执行统一入口（注册表分发，docs/free-canvas-template-registry.md §四）：
 * 元数据（guard）查 utils 注册表，执行器闭包留 slice 层（R2 禁 utils→store）。
 * 全部写操作经 canvasSlice.runBlockTask（blockId 串行队列 + 执行最后一刻存活校验），
 * 成功/失败经 app-toast 反馈落点到聊天流。未注册操作/无执行器 → false（静默丢弃口径不变）。
 */
function dispatchCanvasAction(get: () => AppStore, type: string, payload: SanitizedCopilotPayload): boolean {
  // toast 仅浏览器反馈通道：node 环境（单测/SSR）无 window，静默跳过防崩溃
  const toast = (msg: string) => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('app-toast', { detail: msg }));
  };
  const summary = summarizeCanvasAction(type, payload);
  // 执行成功反馈（区块已删时 runBlockTask 静默跳过任务，此处以 toast 说明执行结果边界）
  const report = (ok: boolean) => toast(ok ? `✅ ${summary} 完成` : `⚠️ ${summary} 未生效（区块可能已删除）`);
  const opName = type.replace(/^canvas_/, '');
  const meta = allCanvasOperationMeta().get(opName);
  const exec = CANVAS_EXECUTORS[opName];
  if (!meta || !exec) return false;
  // 二次守卫（防御纵深：与 sanitize 同一集中守卫，幂等等效）
  const p = meta.guard(payload);
  if (!p) return false;
  return exec({ get, toast, report, summary }, p);
}

export type CopilotActionSlice = Pick<
  AppStore,
  | 'handleCopilotActions'
  | 'dismissCopilotNotice'
  | 'setCopilotNotice'
  | 'dismissPendingCopilotAction'
  | 'executePendingCopilotAction'
>;

export const createCopilotActionSlice: StateCreator<AppStore, [], [], CopilotActionSlice> = (set, get) => ({
  handleCopilotActions: (actions) => {
    const sanitized = sanitizeCopilotActions(actions);
    if (sanitized.length === 0) return;
    for (const a of sanitized) {
      if (a.tier === 'confirm') {
        // 会话内降级（思维流）：canvas_* 动作类型已被用户执行过一次 → 同类后续直接放行，不再逐条确认。
        // annotate_block 不放行（写分析结论需逐条拍板）；集合为内存态，刷新即失（会话边界重置）。
        if (a.type.startsWith('canvas_') && get().copilotApprovedCanvasTypes.has(a.type)) {
          queueCanvasAction(get, a.type, a.payload);
          continue;
        }
        // confirm 级：入队等用户拍板，绝不直接执行
        const pending: PendingCopilotAction = {
          id: `pa-${++pendingSeq}`,
          type: a.type,
          label: `AI 建议执行：${a.type}`,
          // confirm 级 payload 在 sanitize 阶段已确认为普通对象（三个强类型载荷只随 auto 级出现）
          payload: a.payload as Record<string, unknown>,
          summary: summarizeCanvasAction(a.type, a.payload),
        };
        set((s) => ({ pendingCopilotActions: [...s.pendingCopilotActions, pending] }));
        continue;
      }
      // auto 级画布动作（add_block/refresh_klines）：注册表分发直执行
      //（修复分发缺口：此前 auto switch 无 canvas 分支，这两个 auto 动作落 default 被静默丢弃）
      if (a.type.startsWith('canvas_')) {
        dispatchCanvasAction(get, a.type, a.payload);
        continue;
      }
      // auto 级：按类型立即执行（载荷已过形状守卫，此处收窄后消费）
      switch (a.type) {
        case 'notify': {
          const p = asNotifyPayload(a.payload);
          // 后到覆盖先到（单弹窗槽位）；severity 归一化补省（store 态字段非可选）
          if (p) set({ copilotNotice: { title: p.title, message: p.message, severity: p.severity ?? 'info' } });
          break;
        }
        case 'focus_block': {
          const p = asFocusBlockPayload(a.payload);
          // focusBlock 内部校验注册态：未注册区块静默忽略，不弹空浮窗
          if (p) get().focusBlock(p.scopeId, p.blockId);
          break;
        }
        case 'apply_filter': {
          const p = asApplyFilterPayload(a.payload);
          // 白名单键值（当前仅首页时间维度），误发时不影响其他页面数据
          if (p && p.filter === 'homeTimeRange') get().setHomeTimeRange(p.value);
          break;
        }
        case 'run_custom_stat': {
          const p = asRunStatPayload(a.payload);
          // 守卫 → 夹具预跑 → 全量执行 → 入草稿（编排见 customStatsSlice.startCustomStatDraft）
          if (p) {
            prewarmSandbox(); // 顺带预热（首次动作时 wasm 可能尚未就绪）
            void get().startCustomStatDraft(p);
          }
          break;
        }
        default:
          // 理论不可达：分级表登记了 auto 却没实现执行器 → 静默忽略
          break;
      }
    }
  },

  dismissCopilotNotice: () => set({ copilotNotice: null }),

  setCopilotNotice: (payload) => set({ copilotNotice: payload }),

  dismissPendingCopilotAction: (id) => {
    set((s) => ({ pendingCopilotActions: s.pendingCopilotActions.filter((a) => a.id !== id) }));
  },

  executePendingCopilotAction: (id) => {
    const action = get().pendingCopilotActions.find((a) => a.id === id);
    if (!action) return;
    // 出队先行：确认卡只消费一次，无论后续执行成败
    set((s) => ({ pendingCopilotActions: s.pendingCopilotActions.filter((a) => a.id !== id) }));
    // 执行器注册表：新增 confirm 动作在此登记（payload 已过 sanitize 白名单，落地前按类型二次校验）
    // 画布动作统一走 dispatchCanvasAction；执行成功即登记放行集合（同类型后续会话内自动放行）
    if (action.type === 'annotate_block') {
      // 画布区块 AI 备注（spec §6.3）：经 runBlockTask 串行队列 + 执行最后一刻存活校验
      const p = action.payload as { blockId?: unknown; content?: unknown };
      // 先落局部常量：属性收窄不跨闭包，局部 const 收窄可带入任务闭包
      const blockId = p.blockId;
      const content = p.content;
      if (typeof blockId !== 'string' || typeof content !== 'string' || !blockId || !content) return;
      void get().runBlockTask(blockId, () => {
        get().addBlockNote(blockId, content, 'ai');
      });
      return;
    }
    if (action.type.startsWith('canvas_')) {
      const ok = dispatchCanvasAction(get, action.type, action.payload);
      // 载荷校验通过并已受理 → 登记同类型放行（思维流：一次确认，同类放行；刷新即失）
      if (ok) {
        set((s) => ({ copilotApprovedCanvasTypes: new Set(s.copilotApprovedCanvasTypes).add(action.type) }));
      }
      return;
    }
  },
});
