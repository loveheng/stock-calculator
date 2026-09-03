/**
 * @file utils.ts
 * @description Store 层纯工具函数：ID 生成、底仓成本映射、Round 结清（finalizeRoundIfCleared）、
 *              结仓资格校验、撮合结果派生等。均为纯函数，不直接写 IndexedDB，
 *              且不 import useAppStore —— 依赖 store 的派生 Hook 已迁移至 hooks/useStreamResults.ts，
 *              快照重建纯计算已迁移至 utils/calculator.ts（两者原本使本模块与 store/index
 *              形成循环依赖）。
 * @layer Store (Utils)
 * @author 开发团队
 */

import { type StockStreamResult } from '../utils/tStreamEngine';
import type { Position, TRoundArchive, RoundTxn, PlannedOrder } from './types';
import type { FeeConfig } from '../utils/mathUtils';
import { calcTradeFees, matchSecurityKind } from '../utils/mathUtils';
import { RiskController } from '../risk';
import { recomputePositionSnapshot } from '../utils/calculator';

/**
 * 生成全局唯一 ID。
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 格式化时间戳为做T战报业务流水号格式：#YYYYMMDD-HHmm。
 * @param timestamp ISO 时间字符串
 * @returns 格式化的流水号，如 #20260813-1142
 */
export function formatTradeNo(timestamp: string): string {
  const d = new Date(timestamp);
  const y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `#${y}${M}${D}-${h}${m}`;
}

/**
 * 从持仓/成本摊薄账本构建 全Code -> 真实底仓（成本 + 数量）映射。
 * 实现已下沉至 utils/tStreamEngine.ts（utils 层拥有纯引擎装配），此处 re-export 兼容。
 */
export { buildBasePositionCosts } from '../utils/tStreamEngine';

/**
 * 结仓资格校验：判断持仓当前是否可以完结归档（手动结仓 / 清仓自动结仓共用）。
 *
 * @description 返回不可结仓的原因（字符串），满足结仓条件时返回 null。判定条件：
 *  1. 仍持有未卖出的数量（剩余持股 > 0），需全部卖出后才能结仓；
 *  2. 该标的存在进行中的做T轮次 —— 撮合结果（processAllStreams）中该标的
 *     status 非 CLEARED（流水池尚未完全配对结算），或 tRounds 中存在
 *     未完结（OPENED / 无 closedAt）的做T战报。
 * @param pos 目标持仓（读取 fullCode 与批次履历）
 * @param streamResults 全市场做T撮合结果（来自 useStreamResults()，status 取值
 *        CLEARED=已结清 / PENDING / PARTIAL / SHORT_PENDING=进行中）
 * @param tRounds 做T战报归档（进行中 OPENED / 已归档 COMPLETED）
 * @param remainingAmountOverride 剩余持股覆盖值：默认按 pos 批次履历重建当前数量；
 *        在「减仓清仓到 0」场景可显式传入 0，跳过数量校验只看做T轮次
 * @returns 不可结仓原因字符串；满足结仓条件时返回 null
 */
export function getCloseBlockReason(
  pos: Position,
  streamResults: StockStreamResult[],
  tRounds: TRoundArchive[],
  remainingAmountOverride?: number,
): string | null {
  const remaining = remainingAmountOverride ?? recomputePositionSnapshot(pos.batches).currentAmount;
  const hasOpenTRound =
    streamResults.some((r) => r.fullCode === pos.fullCode && r.status !== 'CLEARED') ||
    tRounds.some(
      (r) =>
        r.fullCode === pos.fullCode &&
        (r.status === 'OPENED' || (r.status === undefined && !r.closedAt)),
    );
  // 代理调用统一风控门面（保持对外签名 string | null 兼容）
  const { report } = RiskController.evaluateClosePosition({ remaining, hasOpenTRound, positionId: pos.id });
  if (!report.blocked) return null;
  const firstError = report.checks.find((c) => !c.passed && c.severity === 'error');
  return firstError?.message ?? report.summary;
}

/**
 * 从 Round 库派生「活跃流水池」：仅 OPENED Round 的 transactions 参与撮合。
 * 实现已下沉至 utils/tStreamEngine.ts，此处 re-export 兼容。
 */
export { activeStreamsFromRounds } from '../utils/tStreamEngine';

/**
 * Round 结清：撮合结果 CLEARED 且发生过卖出时，将对应的 OPENED Round 标记为 COMPLETED。
 *
 * @description v8 语义：Round 在首笔流水录入时即创建（OPENED），结清时**复用同一 Round**
 *              翻转 status 并回填概览字段，不再新建 Round（消除原「重复归档」缺陷）。
 *              找不到 OPENED Round 时回退为创建归档（兼容旧数据/手工导入）。
 */
export function finalizeRoundIfCleared(
  stream: StockStreamResult,
  rounds: TRoundArchive[],
): TRoundArchive[] {
  const hasSell = stream.entries.some((e) => e.direction === 'sell');
  if (stream.status !== 'CLEARED' || !hasSell) return rounds;

  const closedAt = stream.lastClosedAt ?? new Date().toISOString();
  const openedAt = stream.openedAt ?? stream.entries[0]?.timestamp ?? new Date().toISOString();
  const roundCode = formatTradeNo(closedAt);

  const idx = rounds.findIndex(
    (r) => r.fullCode === stream.fullCode && (r.status ?? 'OPENED') !== 'COMPLETED'
  );
  if (idx >= 0) {
    const existing = rounds[idx];
    // 归档明细：用最终撮合后的权威 entries 重建，携带 matchedAmount + 单笔 realizedProfit
    const transactions: RoundTxn[] = stream.entries.map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      fullCode: stream.fullCode,
      stockName: stream.stockName,
      direction: e.direction,
      price: e.price,
      amount: e.amount,
      fee: e.fee,
      matchedAmount: e.matchedAmount ?? 0,
      realizedProfit: e.realizedProfit ?? 0,
      note: e.note,
    }));
    const updated: TRoundArchive = {
      ...existing,
      transactions,
      status: 'COMPLETED',
      roundCode: existing.roundCode || roundCode,
      settleType: 'clear',
      netProfit: stream.transferProfit,
      totalFees: stream.totalFee,
      fees: stream.totalFee,
      sellAmount: stream.realizedSellAmount,
      avgPrice: stream.avgPrice,
      buyAmount: stream.buyAmount,
      tradeCount: stream.tradeCount,
      holdingDays: stream.holdingDays,
      win: stream.transferProfit >= 0,
      closedAt,
      lastTouched: closedAt,
      lastUpdated: Date.now(),
    };
    const next = [...rounds];
    next[idx] = updated;
    return next;
  }

  // 回退：没有对应的 OPENED Round（异常/旧数据），创建 COMPLETED 归档
  const transactions: RoundTxn[] = stream.entries.map((e) => ({
    id: e.id,
    timestamp: e.timestamp,
    fullCode: stream.fullCode,
    stockName: stream.stockName,
    direction: e.direction,
    price: e.price,
    amount: e.amount,
    fee: e.fee,
    matchedAmount: e.matchedAmount ?? 0,
    realizedProfit: e.realizedProfit ?? 0,
    note: e.note,
  }));

  const round: TRoundArchive = {
    id: generateId(),
    fullCode: stream.fullCode,
    stockName: stream.stockName,
    mode: stream.mode,
    status: 'COMPLETED',
    roundCode,
    settleType: 'clear',
    transactions,
    netProfit: stream.transferProfit,
    totalFees: stream.totalFee,
    fees: stream.totalFee,
    sellAmount: stream.realizedSellAmount,
    avgPrice: stream.avgPrice,
    buyAmount: stream.buyAmount,
    tradeCount: stream.tradeCount,
    holdingDays: stream.holdingDays,
    win: stream.transferProfit >= 0,
    openedAt,
    closedAt,
  };
  return [...rounds, round];
}

/**
 * 计划单实时对比计算：对比计划价 vs 现价，返回差额与百分比。
 *
 * @description 纯函数，实时计算计划单与当前行情的差异，不缓存。
 * @param order 计划单
 * @param currentPrice 当前现价（0 表示无行情）
 * @returns { priceDiff: number; diffPercent: number; hasQuote: boolean }
 */
export function calcPlanComparison(
  order: PlannedOrder,
  currentPrice: number,
): { priceDiff: number; diffPercent: number; hasQuote: boolean } {
  const hasQuote = currentPrice > 0;
  if (!hasQuote) {
    return { priceDiff: 0, diffPercent: 0, hasQuote: false };
  }
  const priceDiff = currentPrice - order.plannedPrice;
  const diffPercent = order.plannedPrice > 0 ? (priceDiff / order.plannedPrice) * 100 : 0;
  return { priceDiff, diffPercent, hasQuote };
}

/**
 * 计划单执行前模拟计算：预演执行后的成本/数量变化。
 *
 * @description 纯函数，从中长期 `handleBatchConfirm` 中提取核心算力逻辑，
 *              不调用任何 store action，只返回计算结果。
 * @param position 当前持仓（含批次履历）
 * @param type 加仓或减仓
 * @param price 执行价格
 * @param amount 执行数量
 * @param feeConfig 费率配置
 * @returns 执行后的成本/数量/已实现盈亏/累计投入/规费明细
 */
export function calcBatchExecution(
  position: Position,
  type: 'add' | 'reduce',
  price: number,
  amount: number,
  feeConfig: FeeConfig,
): {
  newCost: number;
  newAmount: number;
  newRealizedPnL: number;
  newTotalInvested: number;
  totalFee: number;
} {
  const direction = type === 'add' ? 'buy' : 'sell';
  const tradeFee = calcTradeFees(price, amount, direction, feeConfig, matchSecurityKind('', position.fullCode.replace(/^sh|sz|bj/, '')));
  const totalFee = tradeFee.total;

  // 用总资金抽回法重新计算
  const snap = recomputePositionSnapshot(position.batches);
  let totalInvested = snap.totalInvested;
  let totalAmount = snap.currentAmount;
  let realizedPnL = snap.realizedPnL;

  let newCost: number;
  let newAmount: number;
  let newRealizedPnL = realizedPnL;
  let newTotalInvested = totalInvested;

  if (type === 'add') {
    newAmount = totalAmount + amount;
    newTotalInvested += price * amount + totalFee;
    newCost = newTotalInvested / newAmount;
  } else {
    // 减仓：保本摊薄法，实现动态保本成本。
    // 卖出回笼资金，从总投入中扣除并计入本次规费，剩余部分作为保本成本基数。
    const soldAmount = price * amount;                             // 卖出回笼资金
    newAmount = totalAmount - amount;                              // 剩余持仓股数
    if (newAmount < 0) newAmount = 0;                              // 超过持仓：上游已校验，此处兜底清仓
    if (newAmount <= 0) {
      // 完全清仓：成本归零，差额全部计入已实现盈亏
      newRealizedPnL += (soldAmount - totalFee) - totalInvested;
      newCost = 0;
      newTotalInvested = 0;
    } else {
      const remainingInvested = totalInvested - soldAmount + totalFee;  // 剩余总投入（含规费）
      newTotalInvested = remainingInvested;
      newCost = remainingInvested / newAmount;                          // 保本摊薄成本
    }
  }

  return { newCost, newAmount, newRealizedPnL, newTotalInvested, totalFee };
}

