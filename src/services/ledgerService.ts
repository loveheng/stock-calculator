/**
 * @file ledgerService.ts
 * @description 统一账本 Service 门面（Read-Only Facade）：封装 IndexedDB 只读查询，
 *              供 UI 组件获取持仓、做T Round、费率配置等数据。
 *              所有数据写入统一通过 Store Action（参见 src/store/index.ts）。
 * @layer Service
 * @author 开发团队
 */

import { db } from '../db/index';
import type { PositionEntity, StockEntity, TRoundEntity, TTransactionEntity } from '../db/schema';
import type { Position, PositionBatch } from '../store/types';
import type { TRoundArchive, RoundTxn } from '../store/types';
import type { FeeConfig } from '../utils/mathUtils';

/**
 * 读取当前生效的费率配置（单行记录，id=1）。
 */
export async function getFeeConfig(): Promise<FeeConfig | null> {
  const row = await db.feeConfigs.get(1);
  if (!row || (row.isDeleted ?? 0) === 1) return null;
  return {
    commissionRate: row.commissionRate,
    isFreeFive: row.isFreeFive,
    minCommission: row.minCommission,
    transferRate: row.transferRate,
    stampRate: row.stampRate,
  };
}

// ---- 类型 ----

export interface PositionWithStockInfo extends Position {
  stock?: StockEntity;
  stockNameDisplay: string;
}

// ---- 内部映射 ----

function mapPositionBatchEntityToStore(batch: {
  id: string; timestamp: number; type: string; price: number; amount: number;
  costAfter: number; amountAfter: number; note?: string; fee?: number;
}): PositionBatch {
  return { ...batch, timestamp: new Date(batch.timestamp).toISOString() } as PositionBatch;
}

function mapPositionEntityToStore(
  position: PositionEntity,
  stockName: string,
): Omit<Position, 'batches'> {
  return {
    ...position,
    stockName,
    // 实体层 isClosed 为 0|1 数字（IndexedDB 索引不支持 boolean），读回 Store 层时转回 boolean
    isClosed: position.isClosed === 1,
    createdAt: new Date(position.createdAt).toISOString(),
    closedAt: position.closedAt ? new Date(position.closedAt).toISOString() : undefined,
  };
}

// ---- 只读查询 ----

/**
 * 查询所有未平仓持仓（含股票信息与批次）。
 */
export async function getPositionsWithStockInfo(): Promise<PositionWithStockInfo[]> {
  const positions = await db.positions
    .where('[isClosed+isDeleted]').equals([0, 0])
    .toArray();
  const openPositionIds = new Set(positions.map((p) => p.id));
  const batches = (await db.positionBatches.toArray())
    .filter((b) => (b.isDeleted ?? 0) === 0 && openPositionIds.has(b.positionId));
  const stocks = (await db.stocks.toArray())
    .filter((s) => (s.isDeleted ?? 0) === 0);

  const batchMap = new Map<string, typeof batches>();
  for (const b of batches) {
    const list = batchMap.get(b.positionId);
    if (list) list.push(b);
    else batchMap.set(b.positionId, [b]);
  }

  return positions.map((position) => {
    const stock = stocks.find((item) => item.fullCode === position.fullCode);
    const positionBatches = (batchMap.get(position.id) ?? [])
      .sort((a, b) => a.timestamp - b.timestamp);

    return {
      ...mapPositionEntityToStore(position, stock?.stockName ?? position.fullCode),
      stockName: stock?.stockName ?? position.fullCode,
      stock,
      stockNameDisplay: stock?.stockName ?? position.fullCode,
      batches: positionBatches.map(mapPositionBatchEntityToStore),
    };
  });
}

/**
 * 查询所有 OPENED 状态的做T Round（含成交明细与股票名称）。
 */
export async function getTRoundsWithTransactions(): Promise<TRoundArchive[]> {
  const rounds = await db.tRounds
    .where('[status+isDeleted]').equals(['OPENED', 0])
    .toArray();
  const stocks = (await db.stocks.toArray())
    .filter((s) => (s.isDeleted ?? 0) === 0);
  const stockMap = new Map(stocks.map((s) => [s.fullCode, s]));

  const result: TRoundArchive[] = [];
  for (const r of rounds) {
    const txns = await db.tTransactions
      .where({ roundId: r.id })
      .filter((t) => (t.isDeleted ?? 0) === 0)
      .sortBy('timestamp');
    const transactions: RoundTxn[] = txns.map((t) => ({
      id: t.id,
      timestamp: new Date(t.timestamp).toISOString(),
      direction: t.direction,
      price: t.price,
      amount: t.amount,
      fee: t.fee,
      matchedAmount: t.matchedAmount,
      realizedProfit: t.realizedProfit,
      note: t.note,
    }));

    result.push({
      id: r.id,
      fullCode: r.fullCode,
      stockName: stockMap.get(r.fullCode)?.stockName ?? r.fullCode,
      roundNo: r.roundNo,
      mode: r.mode,
      settleType: r.settleType === 'partial' ? 'transfer' : 'clear',
      transactions,
      netProfit: r.netProfit,
      fees: r.totalFees,
      sellAmount: r.sellAmount ?? 0,
      transferAmount: r.transferAmount,
      avgPrice: r.avgPrice ?? 0,
      buyAmount: r.buyAmount ?? 0,
      tradeCount: r.tradeCount ?? 0,
      holdingDays: r.holdingDays ?? 0,
      win: !!r.win,
      openedAt: new Date(r.openedAt).toISOString(),
      closedAt: r.closedAt ? new Date(r.closedAt).toISOString() : '',
    });
  }
  return result;
}

// ---- 按需分页查询 ----

export async function fetchClosedPositionsPage(
  page: number,
  pageSize: number,
): Promise<import('../db/index').PageResult<import('../db/index').PositionRow>> {
  const { fetchClosedPositionsPage: dbQuery } = await import('../db/index');
  return dbQuery(page, pageSize);
}

export async function fetchCompletedRoundsPage(
  page: number,
  pageSize: number,
): Promise<import('../db/index').PageResult<import('../db/index').TRoundRow>> {
  const { fetchCompletedRoundsPage: dbQuery } = await import('../db/index');
  return dbQuery(page, pageSize);
}

export async function fetchTransactionsByRoundId(
  roundId: string,
): Promise<import('../store').RoundTxn[]> {
  const { fetchTransactionsByRoundId: dbQuery } = await import('../db/index');
  return dbQuery(roundId);
}

export async function fetchAllLongTermRecords(): Promise<import('../db/index').LongTermRecordRow[]> {
  const { fetchAllLongTermRecords: dbQuery } = await import('../db/index');
  return dbQuery();
}

// ---- 门面 ----

export const ledgerService = {
  getFeeConfig,
  getPositionsWithStockInfo,
  getTRoundsWithTransactions,
  fetchClosedPositionsPage,
  fetchCompletedRoundsPage,
  fetchTransactionsByRoundId,
  fetchAllLongTermRecords,
};
