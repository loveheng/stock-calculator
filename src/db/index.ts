// ============================================================
// IndexedDB Database via Dexie.js
// New normalized storage schema for TradingLedgerDB_v3
// ============================================================
import Dexie, { type Table } from 'dexie';
import type { FeeConfig } from '../utils/mathUtils';
import type { PositionBatch, Position, RoundTxn, TRoundArchive } from '../store';
import type { TStreamRecord } from '../utils/tStreamEngine';
import type { StockMeta } from '../types/stock';
import {
  db as tradingDb,
  type AccountCashEntity,
  type CashFlowEntity,
  type FeeConfigEntity,
  type PositionBatchEntity,
  type PositionEntity,
  type StockEntity,
  type TTransactionEntity,
  type TRoundEntity,
  type TradeNoteEntity,
} from './schema';

export type { FeeConfig } from '../utils/mathUtils';
export type { Position, PositionBatch, TRoundArchive, RoundTxn } from '../store';
export type { TStreamRecord } from '../utils/tStreamEngine';
export type { StockMeta } from '../types/stock';

export interface FeeConfigRow {
  id?: number;
  commissionRate: number;
  isFreeFive: boolean;
  minCommission: number;
  transferRate: number;
  stampRate: number;
}

export interface PositionRow {
  id: string;
  stockName: string;
  fullCode: string;
  currentCost: number;
  currentAmount: number;
  batches: PositionBatch[];
  isClosed: boolean;
  createdAt: string;
  closedAt?: string;
  realizedPnL?: number;
  totalInvested?: number;
}

export interface TRoundRow {
  id: string;
  positionId?: string;
  fullCode: string;
  stockName: string;
  roundNo: number;
  mode: 'long' | 'short';
  settleType: 'clear' | 'transfer';
  transactions: RoundTxn[];
  netProfit: number;
  fees: number;
  sellAmount: number;
  transferAmount?: number;
  avgPrice: number;
  buyAmount: number;
  tradeCount: number;
  holdingDays: number;
  win: boolean;
  openedAt: string;
  closedAt: string;
  lastUpdated?: number;
}

export type StockRow = StockMeta;

export interface TStreamRow {
  id: string;
  roundId?: string;
  fullCode: string;
  stockName: string;
  direction: 'buy' | 'sell';
  price: number;
  amount: number;
  fee: number;
  timestamp: string;
  note?: string;
  quoteId?: string;
  baseDeductedAmount?: number;
}

export const db = tradingDb;

/** Recursively strip undefined values from an object to prevent IndexedDB serialization errors */
function cleanUndefined<T extends Record<string, any>>(obj: T): T {
  const result: any = {};
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val !== undefined) {
      result[key] = val;
    }
  }
  return result;
}

function makeId(): string {
  try {
    // @ts-ignore
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (e) {
    // ignore
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// Listen to DB changes - reserve hook for future SyncEngine
try {
  (db as any).on('changes', (changes: any[]) => {
    if (changes && changes.length > 0) {
      console.debug('[DB changes]', changes.map((c) => ({ table: c.table, key: c.key, type: c.type })));
    }
  });
} catch (e) {
  // ignore when not supported
}

const DEFAULT_ACCOUNT_CASH: AccountCashEntity = {
  id: 1,
  availableCash: 0,
  frozenCash: 0,
  totalDeposit: 0,
  lastUpdated: Date.now(),
  createdAt: Date.now(),
  updatedAt: Date.now(),
  isDeleted: 0,
};

const DEFAULT_FEE_CONFIG_ROW: FeeConfigEntity = {
  id: 1,
  commissionRate: 0.00025,
  isFreeFive: false,
  minCommission: 0.5,
  transferRate: 0.00001,
  stampRate: 0.0005,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  isDeleted: 0,
};

function parseTimestamp(value: string | number | undefined): number {
  if (typeof value === 'number') {
    return value;
  }
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) && !Number.isNaN(parsed) ? parsed : Date.now();
}

function toStockEntity(stock: StockRow): StockEntity {
  return {
    id: makeId(),
    fullCode: stock.fullCode,
    code: stock.code,
    stockName: stock.stockName,
    pinYin: stock.pinYin,
    marketType: stock.marketType,
    securityType: stock.securityType,
    quoteId: stock.quoteId,
    shortName: stock.shortName,
    unifiedCode: stock.unifiedCode,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isDeleted: 0,
  };
}

function toPositionEntity(position: PositionRow): PositionEntity {
  return {
    id: position.id,
    fullCode: position.fullCode,
    currentCost: position.currentCost,
    currentAmount: position.currentAmount,
    isClosed: position.isClosed,
    createdAt: parseTimestamp(position.createdAt),
    updatedAt: parseTimestamp(position.createdAt),
    closedAt: position.closedAt ? parseTimestamp(position.closedAt) : undefined,
    totalInvested: position.totalInvested ?? 0,
    realizedPnL: position.realizedPnL ?? 0,
    isDeleted: 0,
  };
}

function toPositionBatchEntity(batch: PositionBatch, positionId: string): PositionBatchEntity {
  return {
    id: batch.id,
    positionId,
    type: batch.type === 'close' ? 'reduce' : batch.type,
    price: batch.price,
    amount: batch.amount,
    fee: batch.fee ?? 0,
    costAfter: batch.costAfter,
    amountAfter: batch.amountAfter,
    timestamp: parseTimestamp(batch.timestamp),
    note: batch.note,
    createdAt: parseTimestamp(batch.timestamp),
    updatedAt: parseTimestamp(batch.timestamp),
    isDeleted: 0,
  };
}

function toRoundEntity(round: TRoundRow): TRoundEntity {
  return {
    id: round.id,
    positionId: round.positionId,
    fullCode: round.fullCode,
    mode: round.mode,
    status: round.closedAt ? 'COMPLETED' : 'OPENED',
    roundNo: round.roundNo,
    settleType: round.settleType === 'transfer' ? 'partial' : 'clear',
    netProfit: round.netProfit,
    totalFees: round.fees,
    openedAt: parseTimestamp(round.openedAt),
    closedAt: round.closedAt ? parseTimestamp(round.closedAt) : undefined,
    stockName: round.stockName,
    buyAmount: round.buyAmount,
    sellAmount: round.sellAmount,
    transferAmount: round.transferAmount,
    avgPrice: round.avgPrice,
    tradeCount: round.tradeCount,
    holdingDays: round.holdingDays,
    win: round.win,
    lastUpdated: round.lastUpdated,
    createdAt: parseTimestamp(round.openedAt),
    updatedAt: round.lastUpdated ?? parseTimestamp(round.openedAt),
    isDeleted: 0,
  };
}

function toTransactionEntity(transaction: RoundTxn, roundId: string): TTransactionEntity {
  return {
    id: transaction.id,
    roundId,
    direction: transaction.direction === 'transfer' ? 'buy' : transaction.direction,
    price: transaction.price,
    amount: transaction.amount,
    fee: transaction.fee,
    matchedAmount: transaction.matchedAmount,
    realizedProfit: transaction.realizedProfit,
    timestamp: parseTimestamp(transaction.timestamp),
    note: transaction.note,
    createdAt: parseTimestamp(transaction.timestamp),
    updatedAt: parseTimestamp(transaction.timestamp),
    isDeleted: 0,
  };
}

function toRoundTxn(transaction: TTransactionEntity): RoundTxn {
  return {
    id: transaction.id,
    timestamp: new Date(transaction.timestamp).toISOString(),
    direction: transaction.direction,
    price: transaction.price,
    amount: transaction.amount,
    fee: transaction.fee,
    matchedAmount: transaction.matchedAmount,
    realizedProfit: transaction.realizedProfit,
    note: transaction.note,
  };
}

export async function ensureDefaultData(): Promise<void> {
  await db.transaction('rw', db.accountCash, db.feeConfigs, async () => {
    const existingCash = await db.accountCash.get(1);
    if (!existingCash) {
      await db.accountCash.put(DEFAULT_ACCOUNT_CASH);
    }
    const existingFee = await db.feeConfigs.get(1);
    if (!existingFee) {
      await db.feeConfigs.put(DEFAULT_FEE_CONFIG_ROW);
    }
  });
}

export async function loadAllFromDB() {
  const [feeConfigsRaw, positionsRaw, positionBatchesRaw, tRoundsRaw, tTransactionsRaw, stocksRaw] = await Promise.all([
    db.feeConfigs.toArray(),
    db.positions.toArray(),
    db.positionBatches.toArray(),
    db.tRounds.toArray(),
    db.tTransactions.toArray(),
    db.stocks.toArray(),
  ]);

  const feeConfigs = feeConfigsRaw.filter((r) => (r.isDeleted ?? 0) === 0);
  const positions = positionsRaw.filter((r) => (r.isDeleted ?? 0) === 0);
  const positionBatches = positionBatchesRaw.filter((r) => (r.isDeleted ?? 0) === 0);
  const tRounds = tRoundsRaw.filter((r) => (r.isDeleted ?? 0) === 0);
  const tTransactions = tTransactionsRaw.filter((r) => (r.isDeleted ?? 0) === 0);
  const stocks = stocksRaw.filter((r) => (r.isDeleted ?? 0) === 0);

  const stockMap = new Map(stocks.map((item) => [item.fullCode, item]));

  const positionMap = new Map<string, PositionRow>();
  for (const position of positions) {
    positionMap.set(position.id, {
      id: position.id,
      stockName: stockMap.get(position.fullCode)?.stockName ?? position.fullCode,
      fullCode: position.fullCode,
      currentCost: position.currentCost,
      currentAmount: position.currentAmount,
      batches: [],
      isClosed: position.isClosed,
      createdAt: new Date(position.createdAt).toISOString(),
      closedAt: position.closedAt ? new Date(position.closedAt).toISOString() : undefined,
      realizedPnL: position.realizedPnL,
      totalInvested: position.totalInvested,
    });
  }
  for (const batch of positionBatches) {
    const parent = positionMap.get(batch.positionId);
    if (parent) {
      parent.batches.push({
        id: batch.id,
        timestamp: new Date(batch.timestamp).toISOString(),
        type: batch.type,
        price: batch.price,
        amount: batch.amount,
        fee: batch.fee,
        costAfter: batch.costAfter,
        amountAfter: batch.amountAfter,
        note: batch.note,
      });
    }
  }

  const roundMap = new Map<string, TRoundRow>();
  for (const round of tRounds) {
    roundMap.set(round.id, {
      id: round.id,
      positionId: round.positionId,
      fullCode: round.fullCode,
      stockName: stockMap.get(round.fullCode)?.stockName ?? round.fullCode,
      roundNo: round.roundNo,
      mode: round.mode,
      settleType: round.settleType === 'partial' ? 'transfer' : 'clear',
      transactions: [],
      netProfit: round.netProfit,
      fees: round.totalFees,
      sellAmount: round.sellAmount ?? 0,
      transferAmount: round.transferAmount,
      avgPrice: round.avgPrice ?? 0,
      buyAmount: round.buyAmount ?? 0,
      tradeCount: round.tradeCount ?? 0,
      holdingDays: round.holdingDays ?? 0,
      win: round.win ?? false,
      openedAt: new Date(round.openedAt).toISOString(),
      closedAt: round.closedAt ? new Date(round.closedAt).toISOString() : '',
      lastUpdated: round.lastUpdated,
    });
  }

  for (const transaction of tTransactions) {
    const round = roundMap.get(transaction.roundId);
    if (round) {
      round.transactions.push(toRoundTxn(transaction));
    }
  }

  return {
    feeConfig: feeConfigs.length > 0 ? feeConfigs[0] : null,
    positions: Array.from(positionMap.values()),
    tRounds: Array.from(roundMap.values()),
    tStreams: [] as TStreamRow[],
    stocks: stocks.map((item) => ({
      fullCode: item.fullCode,
      code: item.code,
      stockName: item.stockName,
      pinYin: item.pinYin,
      marketType: item.marketType,
      securityType: item.securityType,
      quoteId: item.quoteId,
      shortName: item.shortName,
      unifiedCode: item.unifiedCode,
    })),
  };
}

export async function saveFeeConfigToDB(config: FeeConfigRow): Promise<void> {
  await db.transaction('rw', db.feeConfigs, async () => {
    const now = Date.now();
    await db.feeConfigs.put(cleanUndefined({ id: 1, updatedAt: now, createdAt: now, isDeleted: 0, ...config } as any));
  });
}

export async function saveAllPositionsToDB(positions: PositionRow[]): Promise<void> {
  await db.transaction('rw', db.positions, db.positionBatches, async () => {
    await db.positions.clear();
    await db.positionBatches.clear();
    if (positions.length > 0) {
      const now = Date.now();
      await db.positions.bulkAdd(positions.map((p) => cleanUndefined({ ...toPositionEntity(p), updatedAt: now, isDeleted: 0 } as any)));
      const batches = positions.flatMap((position) => position.batches.map((batch) => cleanUndefined({ ...toPositionBatchEntity(batch, position.id), updatedAt: now, isDeleted: 0 } as any)));
      if (batches.length > 0) {
        await db.positionBatches.bulkAdd(batches);
      }
    }
  });
}

export async function saveAllTRoundsToDB(rounds: TRoundRow[]): Promise<void> {
  await db.transaction('rw', db.tRounds, db.tTransactions, async () => {
    await db.tRounds.clear();
    await db.tTransactions.clear();
    if (rounds.length > 0) {
      const now = Date.now();
      await db.tRounds.bulkAdd(rounds.map((r) => cleanUndefined({ ...toRoundEntity(r), updatedAt: now, isDeleted: 0 } as any)));
      const transactions = rounds.flatMap((round) => round.transactions.map((txn) => cleanUndefined({ ...toTransactionEntity(txn, round.id), updatedAt: now, isDeleted: 0 } as any)));
      if (transactions.length > 0) {
        await db.tTransactions.bulkAdd(transactions);
      }
    }
  });
}

export async function saveAllTStreamsToDB(streams: TStreamRow[]): Promise<void> {
  // 新的数据库架构已将做T流水与归档事务分离，
  // 目前不直接把旧的 tStreams 全量写入规范化表。
  await db.transaction('rw', db.tTransactions, async () => {
    const transactions = streams
      .filter((stream): stream is TStreamRow & { roundId: string } => typeof stream.roundId === 'string')
      .map((stream) => ({
        id: stream.id,
        roundId: stream.roundId as string,
        direction: stream.direction,
        price: stream.price,
        amount: stream.amount,
        fee: stream.fee,
        matchedAmount: 0,
        realizedProfit: 0,
        timestamp: parseTimestamp(stream.timestamp),
        note: stream.note ?? '',
      }));
    if (transactions.length > 0) {
      const now = Date.now();
      await db.tTransactions.bulkPut(transactions.map((t) => cleanUndefined({ ...t, updatedAt: now, createdAt: now, isDeleted: 0 } as any)));
    }
  });
}

export async function saveAllToDB(
  feeConfig: FeeConfigRow,
  positions: PositionRow[],
  tRounds: TRoundRow[],
  tStreams: TStreamRow[],
  stocks: StockRow[],
): Promise<void> {
  await db.transaction('rw', [db.feeConfigs, db.stocks, db.positions, db.positionBatches, db.tRounds, db.tTransactions], async () => {
    const now = Date.now();
    await db.feeConfigs.put(cleanUndefined({ id: 1, updatedAt: now, createdAt: now, isDeleted: 0, ...feeConfig } as any));
    await db.stocks.clear();
    if (stocks.length > 0) {
      await db.stocks.bulkAdd(stocks.map((s) => cleanUndefined({ ...toStockEntity(s), updatedAt: now, createdAt: now, isDeleted: 0 } as any)));
    }
    await db.positions.clear();
    await db.positionBatches.clear();
    if (positions.length > 0) {
      await db.positions.bulkAdd(positions.map((p) => cleanUndefined({ ...toPositionEntity(p), updatedAt: now, createdAt: now, isDeleted: 0 } as any)));
      const batches = positions.flatMap((position) => position.batches.map((batch) => cleanUndefined({ ...toPositionBatchEntity(batch, position.id), updatedAt: now, createdAt: now, isDeleted: 0 } as any)));
      if (batches.length > 0) {
        await db.positionBatches.bulkAdd(batches);
      }
    }
    await db.tRounds.clear();
    await db.tTransactions.clear();
    if (tRounds.length > 0) {
      await db.tRounds.bulkAdd(tRounds.map((r) => cleanUndefined({ ...toRoundEntity(r), updatedAt: now, createdAt: now, isDeleted: 0 } as any)));
      const transactions = tRounds.flatMap((round) => round.transactions.map((txn) => cleanUndefined({ ...toTransactionEntity(txn, round.id), updatedAt: now, createdAt: now, isDeleted: 0 } as any)));
      if (transactions.length > 0) {
        await db.tTransactions.bulkAdd(transactions);
      }
    }
  });
}
