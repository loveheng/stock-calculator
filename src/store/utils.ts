/**
 * @file utils.ts
 * @description Store 层纯工具函数：ID 生成、底仓成本映射、归并回滚、撮合结果派生 Hook、
 *              Round 自动归档（archiveRoundIfCleared）等。均为纯函数或 React Hook，不直接写 IndexedDB。
 * @layer Store (Utils)
 * @author 开发团队
 */

import { useMemo } from 'react';
import Decimal from 'decimal.js';
import { processAllStreams, type TStreamRecord, type StockStreamResult, type StreamEntry } from '../utils/tStreamEngine';
import { useAppStore } from './index';
import type { Position, TRoundArchive, RoundTxn } from './types';

/**
 * 生成全局唯一 ID。
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 从持仓/成本摊薄账本构建 全Code -> 底仓持仓均价(P_base) 映射，
 * 供引擎在倒T首笔卖出时继承该均价作为对冲成本基准。
 */
export function buildBasePositionCosts(positions: Position[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const pos of positions) {
    if (pos.isClosed) continue;
    const open = pos.batches.some((b) => b.type === 'open' || b.amount > 0);
    if (!open) continue;
    map.set(pos.fullCode, pos.currentCost);
  }
  return map;
}

/**
 * 归并回滚：从底仓剥离指定数量的归并持仓。
 *
 * @description 当删除带有归并信息的 Round 时，需要从底仓中扣除对应数量，
 *              并回退加权成本；若最后一笔批次类型为 'add' 且金额匹配，则直接删除该批次；
 *              否则追加一笔 'reduce' 批次以还原仓位。
 */
export function rollbackTransferPosition(
  positions: Position[],
  fullCode: string,
  transferAmount: number,
  avgPrice: number,
  fee?: number,
): { positions: Position[]; ok: boolean; message?: string } {
  // 无归并量时不操作底仓
  if (transferAmount <= 0) return { positions, ok: true };

  const posIdx = positions.findIndex(
    (p) => p.fullCode === fullCode && !p.isClosed,
  );
  // 无匹配底仓或已平仓 → 不做任何修改（Ok）
  if (posIdx === -1) {
    return { positions, ok: true, message: '未找到对应底仓，跳过剥离' };
  }

  const pos = { ...positions[posIdx], batches: [...positions[posIdx].batches] };
  const nextPositions = [...positions];
  nextPositions[posIdx] = pos;

  if (pos.currentAmount < transferAmount) {
    return { positions, ok: false, message: '无法删除该战报：底仓数量不足，后续交易已消耗该归并持仓' };
  }

  const newAmount = pos.currentAmount - transferAmount;
  const transferValue = new Decimal(avgPrice).mul(transferAmount);
  const currentTotalValue = new Decimal(pos.currentCost).mul(pos.currentAmount);
  const newTotalValue = currentTotalValue.minus(transferValue);
  const newCost = newAmount > 0 ? newTotalValue.div(newAmount).toNumber() : 0;

  pos.currentAmount = newAmount;
  pos.currentCost = newCost;

  const lastBatch = pos.batches[pos.batches.length - 1];
  if (
    lastBatch &&
    lastBatch.type === 'add' &&
    Math.abs(lastBatch.amount - transferAmount) < 0.001 &&
    Math.abs(lastBatch.price - avgPrice) < 0.001
  ) {
    pos.batches.pop();
  } else {
    pos.batches.push({
      id: generateId(),
      timestamp: new Date().toISOString(),
      type: 'reduce',
      price: avgPrice,
      amount: transferAmount,
      costAfter: newCost,
      amountAfter: newAmount,
      note: `剥离归并持仓（回滚 Round）`,
      fee: fee ?? 0,
    });
  }

  // totalInvested from remaining batches (price × amount + fee)
  pos.totalInvested = pos.batches.reduce(
    (sum, b) => sum + new Decimal(b.price).mul(b.amount).plus(b.fee ?? 0).toNumber(),
    0,
  );

  if (newAmount <= 0) {
    pos.isClosed = true;
    pos.closedAt = new Date().toISOString();
  }

  return { positions: nextPositions, ok: true };
}

/**
 * 派生全市场撮合结果 Hook（级联重算核心）。
 */
export function useStreamResults(): StockStreamResult[] {
  const tStreams = useAppStore((s) => s.tStreams);
  const feeConfig = useAppStore((s) => s.feeConfig);
  const positions = useAppStore((s) => s.positions);
  return useMemo(() => {
    const baseCosts = buildBasePositionCosts(positions);
    return processAllStreams(tStreams, feeConfig, baseCosts);
  }, [tStreams, feeConfig, positions]);
}

/**
 * Round 自动归档：池归零且发生过卖出时生成战报。
 */
export function archiveRoundIfCleared(
  stream: StockStreamResult,
  rounds: TRoundArchive[],
): TRoundArchive[] {
  const hasSell = stream.entries.some((e) => e.direction === 'sell');
  if (stream.status !== 'CLEARED' || !hasSell) return rounds;

  const existing = rounds.filter((r) => r.fullCode === stream.fullCode);
  const maxRound = existing.reduce((m, r) => Math.max(m, r.roundNo), 0);

  const transactions: RoundTxn[] = stream.entries.map((e) => ({
    id: e.id,
    timestamp: e.timestamp,
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
    roundNo: maxRound + 1,
    settleType: 'clear',
    transactions,
    netProfit: stream.transferProfit,
    totalFees: stream.totalFee,
    sellAmount: stream.realizedSellAmount,
    avgPrice: stream.avgPrice,
    buyAmount: stream.buyAmount,
    tradeCount: stream.tradeCount,
    holdingDays: stream.holdingDays,
    win: stream.transferProfit >= 0,
    openedAt: stream.openedAt ?? stream.entries[0]?.timestamp ?? new Date().toISOString(),
    closedAt: stream.lastClosedAt ?? new Date().toISOString(),
  };
  return [...rounds, round];
}

