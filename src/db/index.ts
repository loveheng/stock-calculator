/**
 * @file index.ts
 * @description IndexedDB 数据读写中枢（DAO 层）：提供全局 `db` 实例、行级视图模型、实体转换函数，
 *              以及全量加载/批量落盘的持久化 API，供 Store 层初始化与刷新时调用。
 * @layer DAO
 * @storage_impact 读写 IndexedDB 全部 10 张表（feeConfigs / stocks / positions / positionBatches / tRounds / tTransactions / tStreams / accountCash / cashFlows / tradeNotes）；
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
  type LongTermRecordEntity,
  type PositionBatchEntity,
  type PositionEntity,
  type StockEntity,
  type TStreamEntity,
  type TTransactionEntity,
  type TRoundEntity,
  type TradeNoteEntity,
} from './schema';

export type { FeeConfig } from '../utils/mathUtils';
export type { Position, PositionBatch, TRoundArchive, RoundTxn } from '../store';
export type { LongTermRecord } from '../store';
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
  /** ETF 佣金率（缺省回退到 commissionRate） */
  etfCommissionRate?: number;
  /** ETF 是否免五（缺省回退到 isFreeFive） */
  etfIsFreeFive?: boolean;
  /** ETF 最低佣金（元，缺省回退到 minCommission） */
  etfMinCommission?: number;
  /** ETF 过户费率（缺省回退到 transferRate；ETF 通常为 0） */
  etfTransferRate?: number;
  /** ETF 印花税率（缺省回退到 stampRate；ETF 通常为 0） */
  etfStampRate?: number;
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
  /** 选股条目快照（恢复 UI 自动补全展示用） */
  selectedStock?: Record<string, unknown>;
  /** 倒T首笔卖出已扣减的底仓数量（股） */
  baseDeductedAmount?: number;
}

/** 中长期操作记录的行级视图模型 */
export interface LongTermRecordRow {
  /** 主键 id */
  id: string;
  /** 关联标的完整代码 */
  fullCode: string;
  /** 股票名称 */
  stockName: string;
  /** 操作类型：buy / sell / merge */
  type: 'buy' | 'sell' | 'merge';
  /** 成交单价（元） */
  price: number;
  /** 成交数量（股） */
  amount: number;
  /** 手续费（元） */
  fee: number;
  /** 操作时间戳（ISO 字符串） */
  timestamp: string;
  /** 关联短线战报 id */
  sourceReportId?: string;
  /** 备注 */
  note?: string;
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
 * 生成全局唯一 ID。
 *
 * @returns {string} 唯一字符串 ID
 */
function makeId(): string {
  return crypto.randomUUID();
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
  // ETF 默认：佣金率同股票、免五、最低 0.2 元、免印花税、免过户费
  etfCommissionRate: 0.00025,
  etfIsFreeFive: true,
  etfMinCommission: 0.2,
  etfTransferRate: 0,
  etfStampRate: 0,
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
 * 将做T流水行视图模型转换为 tStreams 实体（保留 selectedStock 快照）。
 *
 * @param {TStreamRow} stream - 做T流水行视图模型
 * @returns {TStreamEntity} tStreams 实体
 */
function toTStreamEntity(stream: TStreamRow): TStreamEntity {
  return {
    id: stream.id,
    timestamp: stream.timestamp,
    fullCode: stream.fullCode,
    stockName: stream.stockName,
    direction: stream.direction,
    price: stream.price,
    amount: stream.amount,
    fee: stream.fee,
    note: stream.note,
    quoteId: stream.quoteId,
    selectedStock: stream.selectedStock,
    baseDeductedAmount: stream.baseDeductedAmount,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isDeleted: 0,
  };
}

/**
 * 将 tStreams 实体映射回做T流水行视图模型。
 *
 * @param {TStreamEntity} entity - tStreams 实体
 * @returns {TStreamRow} 做T流水行视图模型
 */
function toTStreamRow(entity: TStreamEntity): TStreamRow {
  return {
    id: entity.id,
    fullCode: entity.fullCode,
    stockName: entity.stockName,
    direction: entity.direction,
    price: entity.price,
    amount: entity.amount,
    fee: entity.fee,
    timestamp: entity.timestamp,
    note: entity.note,
    quoteId: entity.quoteId,
    selectedStock: entity.selectedStock,
    baseDeductedAmount: entity.baseDeductedAmount,
  };
}

/**
 * 将中长期操作记录视图模型转换为实体。
 *
 * @param {LongTermRecordRow} record - 中长期操作记录行视图模型
 * @returns {LongTermRecordEntity} 实体
 */
function toLongTermRecordEntity(record: LongTermRecordRow): LongTermRecordEntity {
  return {
    id: record.id,
    fullCode: record.fullCode,
    stockName: record.stockName,
    type: record.type,
    price: record.price,
    amount: record.amount,
    fee: record.fee,
    timestamp: parseTimestamp(record.timestamp),
    sourceReportId: record.sourceReportId,
    note: record.note,
    createdAt: parseTimestamp(record.timestamp),
    updatedAt: parseTimestamp(record.timestamp),
    isDeleted: 0,
  };
}

/**
 * 将中长期操作记录实体映射回行视图模型。
 *
 * @param {LongTermRecordEntity} entity - 实体
 * @returns {LongTermRecordRow} 行视图模型
 */
function toLongTermRecordRow(entity: LongTermRecordEntity): LongTermRecordRow {
  return {
    id: entity.id,
    fullCode: entity.fullCode,
    stockName: entity.stockName ?? '',
    type: entity.type,
    price: entity.price,
    amount: entity.amount,
    fee: entity.fee,
    timestamp: new Date(entity.timestamp).toISOString(),
    sourceReportId: entity.sourceReportId,
    note: entity.note,
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
 * @description 并行读取 7 张核心表，过滤软删除记录，装配 持仓/批次、Round/成交 两级聚合并映射股票名称。
 * @returns {Promise<{ feeConfig: FeeConfigEntity | null; positions: PositionRow[]; tRounds: TRoundRow[]; tStreams: TStreamRow[]; stocks: StockRow[] }>}
 *          Store 初始化数据包
 */
export async function loadAllFromDB() {
  const [feeConfigsRaw, positionsRaw, positionBatchesRaw, tRoundsRaw, tTransactionsRaw, tStreamsRaw, stocksRaw, longTermRecordsRaw] = await Promise.all([
    db.feeConfigs.toArray(),
    db.positions.toArray(),
    db.positionBatches.toArray(),
    db.tRounds.toArray(),
    db.tTransactions.toArray(),
    db.tStreams.toArray(),
    db.stocks.toArray(),
    db.longTermRecords.toArray(),
  ]);

  const feeConfigs = feeConfigsRaw.filter((r) => (r.isDeleted ?? 0) === 0);
  const positions = positionsRaw.filter((r) => (r.isDeleted ?? 0) === 0);
  const positionBatches = positionBatchesRaw.filter((r) => (r.isDeleted ?? 0) === 0);
  const tRounds = tRoundsRaw.filter((r) => (r.isDeleted ?? 0) === 0);
  const tTransactions = tTransactionsRaw.filter((r) => (r.isDeleted ?? 0) === 0);
  const tStreams = tStreamsRaw.filter((r) => (r.isDeleted ?? 0) === 0);
  const stocks = stocksRaw.filter((r) => (r.isDeleted ?? 0) === 0);
  const longTermRecords = longTermRecordsRaw.filter((r) => (r.isDeleted ?? 0) === 0);

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
    tStreams: tStreams.map((item) => toTStreamRow(item)),
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
    longTermRecords: longTermRecords.map((item) => toLongTermRecordRow(item)),
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

// ============================================================
// 安全的增量持久化操作（Incremental Write）
// ============================================================
// 严格遵守增量更新原则：绝不调用 table.clear()，统一使用 put / bulkPut / delete / bulkDelete，
// 保证数据安全且性能维持在毫秒级。

/** 辅助函数：生成带时间戳的实体审计字段 */
function withTimestamps<T>(data: T): T & { updatedAt: number; createdAt: number; isDeleted: 0 } {
  const now = Date.now();
  return { ...data, updatedAt: now, createdAt: now, isDeleted: 0 as const };
}

// ---- 费率配置（增量 upsert，复用 saveFeeConfigToDB 逻辑） ----
/** 存放/更新费率配置（id=1，单行，存在即更新） */
export async function putFeeConfig(config: FeeConfigRow): Promise<void> {
  await saveFeeConfigToDB(config);
}

// ---- 股票 ----
/** 新增/更新单个股票 */
export async function putStock(stock: StockRow): Promise<void> {
  await db.stocks.put(cleanUndefined(withTimestamps(toStockEntity(stock)) as any));
}

/** 批量新增/更新股票 */
export async function bulkPutStocks(stocks: StockRow[]): Promise<void> {
  if (stocks.length === 0) return;
  const now = Date.now();
  await db.stocks.bulkPut(stocks.map((s) => cleanUndefined({ ...toStockEntity(s), updatedAt: now, createdAt: now, isDeleted: 0 } as any)));
}

/** 按 fullCode 删除股票 */
export async function deleteStock(fullCode: string): Promise<void> {
  await db.stocks.where({ fullCode }).delete();
}

// ---- 持仓 & 批次 ----
/** 新增/更新单个持仓 */
export async function putPosition(position: PositionRow): Promise<void> {
  await db.positions.put(cleanUndefined(withTimestamps(toPositionEntity(position)) as any));
}

/** 删除单个持仓及其所有批次 */
export async function deletePositionWithBatches(id: string): Promise<void> {
  await db.transaction('rw', db.positions, db.positionBatches, async () => {
    await db.positions.delete(id);
    await db.positionBatches.where({ positionId: id }).delete();
  });
}

/** 新增/更新单个持仓批次 */
export async function putPositionBatch(batch: PositionBatch, positionId: string): Promise<void> {
  await db.positionBatches.put(cleanUndefined(withTimestamps(toPositionBatchEntity(batch, positionId)) as any));
}

/** 按 id 删除单个批次 */
export async function deletePositionBatch(id: string): Promise<void> {
  await db.positionBatches.delete(id);
}

/** 替换某持仓下的所有批次（先删旧再写新） */
export async function replacePositionBatches(positionId: string, batches: PositionBatch[]): Promise<void> {
  await db.transaction('rw', db.positionBatches, async () => {
    await db.positionBatches.where({ positionId }).delete();
    if (batches.length > 0) {
      const now = Date.now();
      await db.positionBatches.bulkPut(batches.map((b) => cleanUndefined({ ...toPositionBatchEntity(b, positionId), updatedAt: now, createdAt: now, isDeleted: 0 } as any)));
    }
  });
}

// ---- 做T Round ----
/** 新增/更新单个 Round */
export async function putTRound(round: TRoundRow): Promise<void> {
  await db.tRounds.put(cleanUndefined(withTimestamps(toRoundEntity(round)) as any));
}

/** 删除单个 Round 及其所有交易明细 */
export async function deleteTRoundWithTransactions(id: string): Promise<void> {
  await db.transaction('rw', db.tRounds, db.tTransactions, async () => {
    await db.tRounds.delete(id);
    await db.tTransactions.where({ roundId: id }).delete();
  });
}

/** 新增/更新单笔交易明细 */
export async function putTransaction(txn: RoundTxn, roundId: string): Promise<void> {
  await db.tTransactions.put(cleanUndefined(withTimestamps(toTransactionEntity(txn, roundId)) as any));
}

/** 替换某 Round 下的所有交易明细 */
export async function replaceRoundTransactions(roundId: string, transactions: RoundTxn[]): Promise<void> {
  await db.transaction('rw', db.tTransactions, async () => {
    await db.tTransactions.where({ roundId }).delete();
    if (transactions.length > 0) {
      const now = Date.now();
      await db.tTransactions.bulkPut(transactions.map((t) => cleanUndefined({ ...toTransactionEntity(t, roundId), updatedAt: now, createdAt: now, isDeleted: 0 } as any)));
    }
  });
}

// ---- 做T流水池 ----
/** 新增/更新单条做T流水 */
export async function putTStream(stream: TStreamRow): Promise<void> {
  await db.tStreams.put(cleanUndefined(withTimestamps(toTStreamEntity(stream)) as any));
}

/** 按 id 删除单条做T流水 */
export async function deleteTStream(id: string): Promise<void> {
  await db.tStreams.delete(id);
}

/** 批量删除做T流水 */
export async function bulkDeleteTStreams(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.tStreams.bulkDelete(ids);
}

// ---- 中长期操作记录 ----
/** 新增/更新单条中长期记录 */
export async function putLongTermRecord(record: LongTermRecordRow): Promise<void> {
  await db.longTermRecords.put(cleanUndefined(withTimestamps(toLongTermRecordEntity(record)) as any));
}

/** 按 id 删除单条中长期记录 */
export async function deleteLongTermRecord(id: string): Promise<void> {
  await db.longTermRecords.delete(id);
}

/** 按 sourceReportId 删除关联的中长期记录（用于级联删除战报） */
export async function deleteLongTermRecordsBySourceReportId(sourceReportId: string): Promise<void> {
  await db.longTermRecords.where({ sourceReportId }).delete();
}

// ============================================================
// 安全的全量数据导入（仅用于用户 JSON 导入场景）
// ============================================================
/**
 * 安全的全量数据导入：使用 bulkPut 增量覆写，随后删除 DB 中存在但新数据中不存在的记录。
 * 绝不调用 table.clear()，消除清空数据库带来的数据丢失隐患。
 */
export async function safeImportAllData(
  feeConfig: FeeConfigRow,
  positions: PositionRow[],
  tRounds: TRoundRow[],
  tStreams: TStreamRow[],
  stocks: StockRow[],
  longTermRecords: LongTermRecordRow[] = [],
): Promise<void> {
  await db.transaction('rw', [db.feeConfigs, db.stocks, db.positions, db.positionBatches, db.tRounds, db.tTransactions, db.tStreams, db.longTermRecords], async () => {
    const now = Date.now();

    // 1. 费率配置：直接 put（id=1 单行 upsert）
    await db.feeConfigs.put(cleanUndefined({ id: 1, updatedAt: now, isDeleted: 0, ...feeConfig } as any));

    // 2. 股票：收集新数据 fullCode 集合，bulkPut 后删除不在集合中的
    const newStockFullCodes = new Set(stocks.map((s) => s.fullCode));
    if (stocks.length > 0) {
      await db.stocks.bulkPut(stocks.map((s) => cleanUndefined({ ...toStockEntity(s), updatedAt: now, createdAt: now, isDeleted: 0 } as any)));
    }
    const oldStockFullCodes = (await db.stocks.toArray()).map((e) => e.fullCode);
    const staleStockFullCodes = oldStockFullCodes.filter((fc) => !newStockFullCodes.has(fc));
    if (staleStockFullCodes.length > 0) {
      await db.stocks.where('fullCode').anyOf(staleStockFullCodes).delete();
    }

    // 3. 持仓 + 批次：收集新数据 id 集合，先写后删旧
    const newPositionIds = new Set(positions.map((p) => p.id));
    if (positions.length > 0) {
      await db.positions.bulkPut(positions.map((p) => cleanUndefined({ ...toPositionEntity(p), updatedAt: now, createdAt: now, isDeleted: 0 } as any)));
      const allBatches = positions.flatMap((p) => p.batches.map((b) => cleanUndefined({ ...toPositionBatchEntity(b, p.id), updatedAt: now, createdAt: now, isDeleted: 0 } as any)));
      // 先删各持仓旧批次，再批量写入
      for (const pid of positions.map((p) => p.id)) {
        await db.positionBatches.where({ positionId: pid }).delete();
      }
      if (allBatches.length > 0) {
        await db.positionBatches.bulkPut(allBatches);
      }
    }
    const oldPositionIds = (await db.positions.toArray()).map((e) => e.id);
    const stalePositionIds = oldPositionIds.filter((id) => !newPositionIds.has(id));
    for (const pid of stalePositionIds) {
      await db.positions.delete(pid);
      await db.positionBatches.where({ positionId: pid }).delete();
    }

    // 4. Round + 交易明细
    const newRoundIds = new Set(tRounds.map((r) => r.id));
    if (tRounds.length > 0) {
      await db.tRounds.bulkPut(tRounds.map((r) => cleanUndefined({ ...toRoundEntity(r), updatedAt: now, createdAt: now, isDeleted: 0 } as any)));
      const allTxns = tRounds.flatMap((r) => r.transactions.map((t) => cleanUndefined({ ...toTransactionEntity(t, r.id), updatedAt: now, createdAt: now, isDeleted: 0 } as any)));
      for (const rid of tRounds.map((r) => r.id)) {
        await db.tTransactions.where({ roundId: rid }).delete();
      }
      if (allTxns.length > 0) {
        await db.tTransactions.bulkPut(allTxns);
      }
    }
    const oldRoundIds = (await db.tRounds.toArray()).map((e) => e.id);
    const staleRoundIds = oldRoundIds.filter((id) => !newRoundIds.has(id));
    for (const rid of staleRoundIds) {
      await db.tRounds.delete(rid);
      await db.tTransactions.where({ roundId: rid }).delete();
    }

    // 5. 做T流水池
    const newStreamIds = new Set(tStreams.map((s) => s.id));
    if (tStreams.length > 0) {
      await db.tStreams.bulkPut(tStreams.map((s) => cleanUndefined({ ...toTStreamEntity(s), updatedAt: now, createdAt: now, isDeleted: 0 } as any)));
    }
    const oldStreamIds = (await db.tStreams.toArray()).map((e) => e.id);
    const staleStreamIds = oldStreamIds.filter((id) => !newStreamIds.has(id));
    if (staleStreamIds.length > 0) {
      await db.tStreams.bulkDelete(staleStreamIds);
    }

    // 6. 中长期操作记录
    const newLtrIds = new Set(longTermRecords.map((r) => r.id));
    if (longTermRecords.length > 0) {
      await db.longTermRecords.bulkPut(longTermRecords.map((r) => cleanUndefined({ ...toLongTermRecordEntity(r), updatedAt: now, createdAt: now, isDeleted: 0 } as any)));
    }
    const oldLtrIds = (await db.longTermRecords.toArray()).map((e) => e.id);
    const staleLtrIds = oldLtrIds.filter((id) => !newLtrIds.has(id));
    if (staleLtrIds.length > 0) {
      await db.longTermRecords.bulkDelete(staleLtrIds);
    }
  });
}
