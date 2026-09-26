/**
 * @file canvasLayout.ts
 * @description 自由画布布局纯函数集：标号分配协议（列优先、删除不复用）+ 模板默认尺寸字典
 *              （注册表派生）+ 区块数据形状守卫。零 store/db 依赖（R2 护栏），显式入参显式返回值。
 * @layer Utils
 * @storage_impact 无持久化读写；调用方（canvasSlice）持久化其返回结果。
 * @author 开发团队
 */

import type { CanvasBlock, CanvasBlockType, CanvasBlockData } from '../types/domain';
import { CANVAS_TEMPLATES } from './canvasTemplates';
import { validateWidgetDsl } from './widgetDsl';

// ============================================================
// 标号分配协议（spec §3.3 / §4.6）
// ============================================================

/** 列字母表：A..Z（一期 26 列足够；超出时抛错由调用方提示） */
const COLUMN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * 由单调计数器生成下一个标号（列优先：A1,A2,...,A26,B1,...）。
 *
 * @description 标号永不复用：seq 只增不减（持久化在 canvasBoards.labelSeq），
 *              删除区块不影响后续分配——历史备注/图表引用中的标号永远指向旧区块语境。
 * @param {number} seq - 单调计数器（调用方负责持久化递增后的值）
 * @returns {string} 标号，如 "A1" / "B3"
 */
export function nextBlockId(seq: number): string {
  if (seq < 1) throw new Error('labelSeq 必须从 1 开始');
  const col = Math.floor((seq - 1) / 26);
  if (col >= COLUMN_LETTERS.length) throw new Error('画布标号已超出列字母表容量');
  const row = ((seq - 1) % 26) + 1;
  return COLUMN_LETTERS[col] + String(row);
}

// ============================================================
// 默认尺寸字典（spec §4.6，react-grid-layout 新增区块必须携带 w/h）
// ============================================================

/** RGL 网格参数（spec §七）：12 列基准，行高 40px，最小 w=2/h=3 */
export const CANVAS_GRID = { cols: 12, rowHeight: 40, minW: 2, minH: 3, margin: [8, 8] } as const;

/** 七类模板默认尺寸——由模板注册表派生（单一事实源 utils/canvasTemplates） */
export const DEFAULT_LAYOUT: Record<CanvasBlockType, { w: number; h: number }> = Object.fromEntries(
  Object.entries(CANVAS_TEMPLATES).map(([type, tpl]) => [type, tpl.defaultSize]),
) as Record<CanvasBlockType, { w: number; h: number }>;

/**
 * 计算新区块的完整 layout：默认尺寸 + 首个空闲格（自上而下逐行扫描，列优先填入）。
 *
 * @description 空闲格判定：与现有区块矩形求交，无交即空。O(n·格数) 画布规模下足够。
 * @param {CanvasBlock[]} blocks - 现存区块
 * @param {CanvasBlockType} type - 新区块类型
 * @returns {CanvasBlock['layout']} 新区块 layout
 */
export function nextLayout(blocks: CanvasBlock[], type: CanvasBlockType): CanvasBlock['layout'] {
  const { w, h } = DEFAULT_LAYOUT[type];
  const occupied = blocks.map((b) => b.layout);
  // 逐行扫描（行高步进 1），每行内列优先
  for (let y = 0; ; y++) {
    for (let x = 0; x + w <= CANVAS_GRID.cols; x++) {
      const free = occupied.every(
        (o) => x + w <= o.x || o.x + o.w <= x || y + h <= o.y || o.y + o.h <= y,
      );
      if (free) return { x, y, w, h };
    }
    // 兜底：扫描 200 行仍无空位（理论不达）→ 追加到底部
    if (y > 200) {
      const maxY = occupied.reduce((m, o) => Math.max(m, o.y + o.h), 0);
      return { x: 0, y: maxY, w, h };
    }
  }
}

// ============================================================
// 区块数据形状守卫（copilotActions 载荷守卫 / 持久化前校验共用）
// ============================================================

/** 各类型 data 的必填字段检查器（宽松：多余字段不拒，缺必填才拒） */
const DATA_GUARDS: Record<CanvasBlockType, (data: unknown) => boolean> = {
  kline: (d) => {
    const o = d as CanvasBlockData['kline'];
    return typeof o?.fullCode === 'string' && o.fullCode.length > 0
      && Array.isArray(o?.trendLines) && Array.isArray(o?.hLines)
      && typeof o?.maVisible === 'boolean';
  },
  table: (d) => {
    const o = d as CanvasBlockData['table'];
    return Array.isArray(o?.columns) && Array.isArray(o?.rows);
  },
  file: (d) => {
    const o = d as CanvasBlockData['file'];
    return typeof o?.fileName === 'string' && typeof o?.fileType === 'string';
  },
  chart: (d) => {
    const o = d as CanvasBlockData['chart'];
    return (o?.seriesType === 'line' || o?.seriesType === 'bar') && Array.isArray(o?.points);
  },
  metric: (d) => {
    const o = d as CanvasBlockData['metric'];
    return typeof o?.label === 'string' && o.label.length > 0;
  },
  image: () => true, // imageRef 可选（空图片模板占位态）
  text: (d) => {
    const o = d as CanvasBlockData['text'];
    return typeof o?.content === 'string';
  },
  brief: (d) => {
    const o = d as CanvasBlockData['brief'];
    return typeof o?.stockId === 'string' && o.stockId.length > 0
      && typeof o?.stockName === 'string' && typeof o?.days === 'number'
      && typeof o?.mention?.count === 'number' && Array.isArray(o?.mention?.articles)
      && Array.isArray(o?.subjects) && Array.isArray(o?.announcements);
  },
  widget: (d) => {
    // 唯一校验入口复用（utils/widgetDsl）：落库 DSL 均经校验器规范化，此处兜底防手改/脏数据
    const o = d as CanvasBlockData['widget'];
    return o?.dsl !== undefined && validateWidgetDsl(o.dsl) !== null;
  },
};

/**
 * 校验区块数据形状（按 type 收窄）。不合法返回 false，调用方静默丢弃或提示。
 * @param {CanvasBlockType} type - 区块类型
 * @param {unknown} data - 待校验数据（不可信输入）
 * @returns {boolean} 是否合法
 */
export function isValidBlockData(type: CanvasBlockType, data: unknown): boolean {
  const guard = DATA_GUARDS[type];
  if (!guard || data === null || typeof data !== 'object') return false;
  return guard(data);
}

/**
 * 校验完整区块（blockId 形状 + data 守卫 + layout 数值合法）。
 * @param {unknown} block - 待校验区块（不可信输入，如反序列化数据）
 * @returns {boolean} 是否合法
 */
export function isValidBlock(block: unknown): boolean {
  const b = block as CanvasBlock;
  if (!b || typeof b !== 'object') return false;
  if (typeof b.blockId !== 'string' || !/^[A-Z][1-9][0-9]*$/.test(b.blockId)) return false;
  if (typeof b.type !== 'string' || !(b.type in DEFAULT_LAYOUT)) return false;
  const l = b.layout;
  if (!l || typeof l.x !== 'number' || typeof l.y !== 'number'
    || typeof l.w !== 'number' || typeof l.h !== 'number'
    || l.w < CANVAS_GRID.minW || l.h < CANVAS_GRID.minH) return false;
  if (!Array.isArray(b.notes)) return false;
  return isValidBlockData(b.type, b.data);
}
