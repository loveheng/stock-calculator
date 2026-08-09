/**
 * @file index.ts
 * @description IndexedDB 数据读写中枢（DAO 层）：提供全局 `db` 实例、行级视图模型、实体转换函数，
 *              以及全量加载/批量落盘的持久化 API，供 Store 层初始化与刷新时调用。
 * @layer DAO
 * @storage_impact 读写 IndexedDB 全部 9 张表（feeConfigs / stocks / positions / positionBatches / tRounds / tTransactions / accountCash / cashFlows / tradeNotes）；
 *                 所有写库均自动补充 `createdAt` / `updatedAt` / `isDeleted=0`，并通过 cleanUndefined 剔除 undefined 字段防序列化错误。
 * @author 开发团队
 */
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

/** 费率配置的行级视图模型（用于 UI 展示，非实体） */
export interface FeeConfigRow {
  /** 主键（固定 1） */
  id?: number;
  /** 佣金费率（如 0.00025） */
  commissionRate: number;
  /** 是否免五 */
  isFreeFive: boolean;
  /** 最低佣金（元） */
  minCommission: number;
  /** 过户费率 */
  transferRate: number;
  /** 印花税率 */
  stampRate: number;
}

/** 持仓的行级视图模型（含股票名称与批次列表） */
export interface PositionRow {
  /** 持仓主键 id */
  id: string;
  /** 股票展示名称 */
  stockName: string;
  /** 股票完整代码 */
  fullCode: string;
  /** 当前加权成本（元） */
  currentCost: number;
  /** 当前数量（股） */
  currentAmount: number;
  /** 批次明细列表 */
  batches: PositionBatch[];
  /** 是否已平仓 */
  isClosed: boolean;
  /** 创建时间（ISO 字符串） */
  createdAt: string;
  /** 平仓时间（ISO 字符串，未平仓缺省） */
  closedAt?: string;
  /** 已实现盈亏（元） */
  realizedPnL?: number;
  /** 累计投入（元） */
  totalInvested?: number;
}

/** 做T Round 的行级视图模型（含成交明细） */
export interface TRoundRow {
  /** Round 主键 id */
  id: string;
  /** 关联持仓 id（可选） */
  positionId?: string;
  /** 股票完整代码 */
  fullCode: string;
  /** 股票展示名称 */
  stockName: string;
  /** 轮次号（从 1 递增） */
  roundNo: number;
  /** 做T方向 */
  mode: 'long' | 'short';
  /** 结算方式（transfer=划转底仓） */
  settleType: 'clear' | 'transfer';
  /** 成交明细列表 */
  transactions: RoundTxn[];
  /** 净收益（元） */
  netProfit: number;
  /** 累计手续费（元） */
  fees: number;
  /** 卖出数量（股） */
  sellAmount: number;
  /** 划转底仓数量（股，可选） */
  transferAmount?: number;
  /** 加权均价（元） */
  avgPrice: number;
  /** 累计买入金额（元） */
  buyAmount: number;
  /** 成交笔数 */
  tradeCount: number;
  /** 持股天数 */
  holdingDays: number;
  /** 是否盈利 */
  win: boolean;
  /** 开启时间（ISO 字符串） */
  openedAt: string;
  /** 关闭时间（ISO 字符串，未关闭为空串） */
  closedAt: string;
  /** 最近活动时间戳 */
  lastUpdated?: number;
}

/** 股票行视图模型 = StockMeta（行情搜索返回结构） */
export type StockRow = StockMeta;

/** 做T流水的行级视图模型（Store 内存流水池结构） */
export interface TStreamRow {
  /** 流水主键 id */
  id: string;
  /** 关联 Round id（可选，未归档前缺省） */
  roundId?: string;
  /** 股票完整代码 */
  fullCode: string;
  /** 股票展示名称 */
  stockName: string;
  /** 方向：买入 / 卖出 */
  direction: 'buy' | 'sell';
  /** 成交单价（元） */
  price: number;
  /** 成交数量（股） */
  amount: number;
  /** 手续费（元） */
  fee: number;
  /** 成交时间（ISO 字符串） */
  timestamp: string;
  /** 备注 */
  note?: string;
  /** 行情快照 ID */
  quoteId?: string;
  /** 倒T首笔卖出已扣减的底仓数量（股） */
  baseDeductedAmount?: number;
}

/** 全局数据库实例（别名转发自 ./schema） */
export const db = tradingDb;

/**
 * 递归剔除对象中的 undefined 字段。
 *
 * @description 防止 undefined 字段引发 IndexedDB 结构化克隆序列化错误；所有写库前必须调用。
 * @param {T} obj - 任意对象
 * @returns {T} 剔除 undefined 字段后的新对象
 */
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

/**
 * 生成全局唯一 ID（优先标准 UUID，降级时间戳组合）。
 *
 * @returns {string} 唯一字符串 ID
 */
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

/** 现金账户默认行：可用/冻结现金均为 0，累计入金 0 */
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

/** 费率配置默认行：佣金 0.025%、最低 0.5 元、过户 0.001%、印花 0.05% */
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

/**
 * 解析时间戳：兼容数字毫秒与 ISO 字符串，非法值回退为当前时间。
 *
 * @param {string | number | undefined} value - 时间值
 * @returns {number} 毫秒时间戳
 */
function parseTimestamp(value: string | number | undefined): number {
  if (typeof value === 'number') {
    return value;
  }
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) && !Number.isNaN(parsed) ? parsed : Date.now();
}

/**
 * 将股票行视图模型转换为股票实体（补齐审计字段）。
 *
 * @param {StockRow} stock - 股票行视图模型
 * @returns {StockEntity} 股票实体
 */
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

/**
 * 将持仓行视图模型转换为持仓实体（补齐审计字段）。
 *
 * @param {PositionRow} position - 持仓行视图模型
 * @returns {PositionEntity} 持仓实体
 */
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

/**
 * 将批次视图模型转换为批次实体（close 类型归一化为 reduce）。
 *
 * @param {PositionBatch} batch - 批次视图模型
 * @param {string} positionId - 所属持仓 id
 * @returns {PositionBatchEntity} 批次实体
 */
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

/**
 * 将 Round 行视图模型转换为 Round 实体（transfer 结算转译为 partial）。
 *
 * @param {TRoundRow} round - Round 行视图模型
 * @returns {TRoundEntity} Round 实体
 */
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

/**
 * 将成交明细视图模型转换为事务实体（transfer 方向归一化为 buy）。
 *
 * @param {RoundTxn} transaction - 成交明细视图模型
 * @param {string} roundId - 所属 Round id
 * @returns {TTransactionEntity} 事务实体
 */
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

/**
 * 将事务实体映射回成交明细视图模型（时间戳转 ISO 字符串）。
 *
 * @param {TTransactionEntity} transaction - 事务实体
 * @returns {RoundTxn} 成交明细视图模型
 */
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

/**
 * 确保默认数据存在（现金账户 + 费率配置单行记录）。
 *
 * @description 在读写事务内检查 accountCash 与 feeConfigs 的 id=1 行，缺失则写入默认值。
 * @returns {Promise<void>}
 * @note 运行在 `rw` 事务；自动维护 `createdAt` / `updatedAt`
 */
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

/**
 * 全量读取数据库并重组为 Store 初始化所需的视图模型集合。
 *
 * @description 并行读取 6 张核心表，过滤软删除记录，装配 持仓/批次、Round/成交 两级聚合并映射股票名称。
 * @returns {Promise<{ feeConfig: FeeConfigEntity | null; positions: PositionRow[]; tRounds: TRoundRow[]; tStreams: TStreamRow[]; stocks: StockRow[] }>}
 *          Store 初始化数据包
 */
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

/**
 * 保存费率配置到数据库（单行 upsert，id=1）。
 *
 * @param {FeeConfigRow} config - 费率配置
 * @returns {Promise<void>}
 * @note 运行在 `rw` 事务；自动维护 `createdAt` / `updatedAt` / `isDeleted`
 */
export async function saveFeeConfigToDB(config: FeeConfigRow): Promise<void> {
  await db.transaction('rw', db.feeConfigs, async () => {
    const now = Date.now();
    await db.feeConfigs.put(cleanUndefined({ id: 1, updatedAt: now, createdAt: now, isDeleted: 0, ...config } as any));
  });
}

/**
 * 全量重写持仓及批次表（先清空后 bulkAdd）。
 *
 * @description 以 Store 内存中的 positions 为唯一事实源，整体覆盖落盘。
 * @param {PositionRow[]} positions - 持仓行视图模型列表
 * @returns {Promise<void>}
 * @note 运行在 `rw` 事务（positions + positionBatches）；清空会物理删除旧记录；
 *      所有记录统一补充当前 `updatedAt` 与 `isDeleted=0`
 */
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

/**
 * 全量重写做T Round 及事务表（先清空后 bulkAdd）。
 *
 * @param {TRoundRow[]} rounds - Round 行视图模型列表
 * @returns {Promise<void>}
 * @note 运行在 `rw` 事务（tRounds + tTransactions）；清空会物理删除旧记录；
 *      所有记录统一补充当前 `updatedAt` 与 `isDeleted=0`
 */
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

/**
 * 保存存量做T流水到事务表（兼容旧数据迁移）。
 *
 * @description 仅写入带 roundId 的流水记录；无 roundId 的孤立流水会被过滤。
 * @param {TStreamRow[]} streams - 做T流水列表
 * @returns {Promise<void>}
 * @note 运行在 `rw` 事务（tTransactions）；新架构已分离归档事务，本方法仅作兜底迁移
 */
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

/**
 * 一次性全量落盘（费率 + 股票 + 持仓/批次 + Round/事务）。
 *
 * @description 在单个大事务内先清空相关表再整体写入，保证数据一致性与幂等性。
 * @param {FeeConfigRow} feeConfig - 费率配置
 * @param {PositionRow[]} positions - 持仓列表
 * @param {TRoundRow[]} tRounds - Round 列表
 * @param {TStreamRow[]} tStreams - 做T流水列表
 * @param {StockRow[]} stocks - 股票列表
 * @returns {Promise<void>}
 * @note 运行在 `rw` 大事务（6 张表）；清空会物理删除旧记录；
 *      所有记录统一补充当前 `createdAt` / `updatedAt` 与 `isDeleted=0`
 */
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