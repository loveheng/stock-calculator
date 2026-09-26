/**
 * @file monitorRule.ts
 * @description 价格预告单触发规则纯函数：按「方向 + 类型」计算**单边触发边界**
 *              （BUY：`price ≤ threshold + band`；SELL：`price ≥ threshold − band`），
 *              并派生建单提示所需的口径一致性数据：容差占比、距触发距离、两类风险判定
 *              （建单即触发 / 容差过窄可能永不触发）。
 *              与 docs/monitor/design.md §3、docs/monitor/api.md §6.1 同口径——前端展示与后端判定共用一套表达式。
 * @layer Utils（纯函数叶子，零依赖）
 * @storage_impact 无存储读写。
 * @author 开发团队
 */

/** 预告单方向：BUY=低吸（等回落）/ SELL=高抛（等上涨） */
export type MonitorDirection = 'BUY' | 'SELL';

/** 触发类型：PRICE_NEAR=区间（配合容差，推荐）/ PRICE_BELOW=跌破（仅 BUY） */
export type MonitorAlertType = 'PRICE_NEAR' | 'PRICE_BELOW';

/** 规则入参（与 start 入参同构） */
export interface MonitorRuleInput {
  direction: MonitorDirection;
  type: MonitorAlertType;
  /** 目标价（元） */
  threshold: number;
  /** 容差（元），PRICE_BELOW 忽略 */
  band?: number | null;
}

/** 单边触发边界 */
export interface TriggerBoundary {
  /** 比较运算符（与后端判定同口径） */
  operator: '<=' | '>=';
  /** 触发边界值（元）：BUY 取上沿 threshold+band；SELL 取下沿 threshold−band */
  bound: number;
  /** 中文口径文案，供表单与结果卡直接展示 */
  text: string;
}

/** 容差过窄阈值（占参考价比例，api.md §6.1 建议 0.3%） */
export const NARROW_BAND_RATIO = 0.003;

/**
 * 计算单边触发边界。
 *
 * @param input - 方向 / 类型 / 目标价 / 容差
 * @returns 触发边界；参数非法或 SELL+PRICE_BELOW 组合时返回 null（调用方应禁用提交）
 */
export function computeTriggerBoundary(input: MonitorRuleInput): TriggerBoundary | null {
  const { direction, type, threshold, band } = input;
  if (!Number.isFinite(threshold) || threshold <= 0) return null;

  // SELL 仅容 PRICE_NEAR（跌破型只用于低吸）
  if (direction === 'SELL' && type === 'PRICE_BELOW') return null;

  if (type === 'PRICE_BELOW') {
    return { operator: '<=', bound: threshold, text: `价格 ≤ ${threshold.toFixed(2)} 时提醒` };
  }

  const safeBand = Number.isFinite(band ?? null) ? Math.max(0, band as number) : 0;
  if (direction === 'BUY') {
    const bound = threshold + safeBand;
    return { operator: '<=', bound, text: `价格 ≤ ${bound.toFixed(2)} 时提醒` };
  }
  const bound = threshold - safeBand;
  // 下沿不得为负（低价股容差大于目标价时兜底到 0）
  return { operator: '>=', bound: Math.max(0, bound), text: `价格 ≥ ${bound.toFixed(2)} 时提醒` };
}

/**
 * 判断某个价格是否已落在触发侧（建单即触发判定）。
 *
 * @param price - 参考价（K 线最后一根收盘价）
 * @param boundary - computeTriggerBoundary 的结果
 * @returns true 表示该价格已满足触发条件（下一轮即提醒，3 次额度开始倒计时）
 */
export function isPriceInTriggerSide(price: number, boundary: TriggerBoundary): boolean {
  if (!Number.isFinite(price)) return false;
  return boundary.operator === '<=' ? price <= boundary.bound : price >= boundary.bound;
}

/**
 * 距触发还差多少（正号 = 尚未到价，负号 = 已越过）。
 *
 * @param price - 参考价
 * @param boundary - 触发边界
 * @returns 绝对差额（元）与百分比（相对边界值）；非有限输入返回 null
 */
export function distanceToTrigger(
  price: number,
  boundary: TriggerBoundary,
): { diff: number; pct: number } | null {
  if (!Number.isFinite(price) || boundary.bound <= 0) return null;
  // BUY：价格高于边界 → 还需下跌（diff 为正）；SELL：价格低于边界 → 还需上涨（diff 为正）
  const diff = boundary.operator === '<=' ? price - boundary.bound : boundary.bound - price;
  return { diff, pct: (diff / boundary.bound) * 100 };
}

/**
 * 容差占目标价百分比（PRICE_BELOW 无容差，返回 0）。
 */
export function bandPctOfThreshold(input: MonitorRuleInput): number {
  if (input.type !== 'PRICE_NEAR') return 0;
  const band = Number.isFinite(input.band ?? null) ? Math.max(0, input.band as number) : 0;
  if (!Number.isFinite(input.threshold) || input.threshold <= 0) return 0;
  return (band / input.threshold) * 100;
}

/**
 * 容差是否过窄（30 分钟采样下可能两次采样之间穿过区间 → 永不触发、白占额度）。
 *
 * @param band - 容差（元）
 * @param referencePrice - 参考价（现价或目标价）
 * @returns true 表示应提示「容差偏窄，可能错过」；band=0（精确跌破型）不算窄
 */
export function isBandTooNarrow(band: number | null | undefined, referencePrice: number): boolean {
  if (!Number.isFinite(band ?? null) || (band as number) <= 0) return false;
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return false;
  return (band as number) / referencePrice < NARROW_BAND_RATIO;
}
