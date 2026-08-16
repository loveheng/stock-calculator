/**
 * @file utils.ts
 * @description Store 层纯工具函数：ID 生成、底仓成本映射、归并回滚、撮合结果派生 Hook、
 *              Round 结清（finalizeRoundIfCleared）等。均为纯函数或 React Hook，不直接写 IndexedDB。
 * @layer Store (Utils)
 * @author 开发团队
 */

import { useMemo } from 'react';
import Decimal from 'decimal.js';
import { processAllStreams, type TStreamRecord, type StockStreamResult, type StreamEntry } from '../utils/tStreamEngine';
import { useAppStore } from './index';
import type { Position, PositionBatch, TRoundArchive, RoundTxn } from './types';

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
 * 从持仓/成本摊薄账本构建 全Code -> 真实底仓（成本 + 数量）映射，
 * 供引擎在倒T首笔卖出时继承该均价作为对冲成本基准（P_base），
 * 并以真实底仓数量驱动移动加权成本与 shortPendingAmount 精确推导。
 */
export function buildBasePositionCosts(positions: Position[]): Map<string, { cost: number; quantity: number }> {
  const map = new Map<string, { cost: number; quantity: number }>();
  for (const pos of positions) {
    if (pos.isClosed) continue;
    const open = pos.batches.some((b) => b.type === 'open' || b.amount > 0);
    if (!open) continue;
    map.set(pos.fullCode, { cost: pos.currentCost, quantity: pos.currentAmount });
  }
  return map;
}

/**
 * 从批次履历重建持仓快照（成本/数量/已实现盈亏/累计投入）。
 *
 * @description 采用「总资金抽回法」按时间顺序遍历批次：
 *  - 买入（open/add）：按 价格×数量＋规费 累计投入资金与数量；
 *  - 卖出（reduce）：按当前摊薄成本抽回资金，同时累计已实现盈亏（净收入－摊薄成本）。
 * 用于删除批次后重建权威快照，与建仓/加减仓的写入路径保持同一口径。
 * @param batches 持仓的完整批次履历（含 open/add/reduce，先后顺序由 timestamp 决定）
 * @returns {{ currentCost: number; currentAmount: number; realizedPnL: number; totalInvested: number }}
 */
export function recomputePositionSnapshot(batches: PositionBatch[]): {
  currentCost: number;
  currentAmount: number;
  realizedPnL: number;
  totalInvested: number;
} {
  const sorted = [...batches].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  let totalInvested = 0;
  let totalAmount = 0;
  let realizedPnL = 0;

  for (const batch of sorted) {
    const qty = Math.abs(batch.amount);
    const batchFee = batch.fee || 0;
    if (batch.amount > 0) {
      totalInvested += batch.price * qty + batchFee;
      totalAmount += qty;
    } else if (batch.kind === 'borrow') {
      // 出借：只减数量与成本基数，不产生盈亏（借仓卖出，非真实落袋）
      if (totalAmount > 0) {
        const costBasisPerShare = totalInvested / totalAmount;
        totalInvested -= costBasisPerShare * qty;
      }
      totalAmount -= qty;
      if (totalAmount <= 0) {
        totalInvested = 0;
        totalAmount = 0;
      }
    } else {
      if (totalAmount > 0) {
        const costBasisPerShare = totalInvested / totalAmount;
        const costBasisOfSold = costBasisPerShare * qty;
        const netProceeds = batch.price * qty - batchFee;
        realizedPnL += netProceeds - costBasisOfSold;
        totalInvested -= costBasisOfSold;
      }
      totalAmount -= qty;
      if (totalAmount <= 0) {
        totalInvested = 0;
        totalAmount = 0;
      }
    }
  }

  return {
    currentCost: totalAmount > 0 ? totalInvested / totalAmount : 0,
    currentAmount: totalAmount,
    realizedPnL,
    totalInvested,
  };
}

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
  if (remaining > 0) {
    return `该持仓还有 ${remaining} 股未卖出，需全部卖出后才能结仓。`;
  }

  const hasOpenTRound =
    streamResults.some((r) => r.fullCode === pos.fullCode && r.status !== 'CLEARED') ||
    tRounds.some(
      (r) =>
        r.fullCode === pos.fullCode &&
        (r.status === 'OPENED' || (r.status === undefined && !r.closedAt)),
    );
  if (hasOpenTRound) {
    return '该标的仍有进行中的做T轮次，请先结算或归档后再结仓。';
  }

  return null;
}

/** @deprecated 已由 positionAdjustmentPort.rollbackRound 取代，不再使用 */
export function rollbackTransferPosition(
  _positions: Position[],
  _fullCode: string,
  _transferAmount: number,
  _avgPrice: number,
  _fee?: number,
): { positions: Position[]; ok: boolean; message?: string } {
  throw new Error('rollbackTransferPosition 已废弃，请使用 positionAdjustmentPort.rollbackRound');
}

/**
 * 从 Round 库派生「活跃流水池」：仅 OPENED Round 的 transactions 参与撮合。
 *
 * @description v8 核心派生函数 —— tStreams 不再独立存在，流水全部归属于 Round：
 *  - OPENED Round 的 transactions 即进行中做T项目的全部单边流水；
 *  - COMPLETED Round 的流水是归档明细，退出活跃池（防重复归档/跨轮污染）。
 * @param rounds 全量 Round 库（OPENED + COMPLETED）
 * @returns 引擎所需的 TStreamRecord[]（方向归一化为 buy/sell）
 */
export function activeStreamsFromRounds(rounds: TRoundArchive[]): TStreamRecord[] {
  const streams: TStreamRecord[] = [];
  for (const r of rounds) {
    if ((r.status ?? 'OPENED') === 'COMPLETED') continue;
    const stockName = r.stockName || r.fullCode;
    for (const t of r.transactions ?? []) {
      const rawDir = String(t.direction);
      if (rawDir === 'merge' || rawDir === 'transfer') continue;
      streams.push({
        id: t.id,
        timestamp: t.timestamp,
        fullCode: r.fullCode,
        stockName,
        direction: rawDir as 'buy' | 'sell',
        price: t.price,
        amount: t.amount,
        fee: t.fee,
        note: t.note,
        quoteId: t.quoteId,
        selectedStock: t.selectedStock,
      });
    }
  }
  return streams;
}

/**
 * 派生全市场撮合结果 Hook（级联重算核心）。
 *
 * @description 订阅 tRounds（OPENED 流水池）+ feeConfig + positions，
 *              任何变化自动级联重算全市场 FIFO 撮合结果。
 */
export function useStreamResults(): StockStreamResult[] {
  const tRounds = useAppStore((s) => s.tRounds);
  const feeConfig = useAppStore((s) => s.feeConfig);
  const positions = useAppStore((s) => s.positions);
  return useMemo(() => {
    const baseCosts = buildBasePositionCosts(positions);
    const activeStreams = activeStreamsFromRounds(tRounds);
    return processAllStreams(activeStreams, feeConfig, baseCosts);
  }, [tRounds, feeConfig, positions]);
}

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

