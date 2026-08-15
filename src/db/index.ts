/**
 * @file index.ts
 * @description IndexedDB 数据读写中枢（DAO 层）：提供全局 `db` 实例、行级视图模型、实体转换函数，
 *              以及冷启动精简加载 + 按需分页查询/批量落盘的持久化 API，供 Store 层初始化与刷新时调用。
 *              v6.1 重构：统一类型系统 —— PositionRow/TRoundRow/LongTermRecordRow
 *              定义为 Store 层类型的别名，消除双体系；移除所有实体转换函数中的 as any 强制转换；
 *              safeImportAllData 增加事务包裹确保导入失败时回滚。
 *              v8 重构：移除 tStreams —— 做T流水唯一持久化为 tTransactions（归属于 Round），
 *              增量写入入口为 putTransaction（per-entry）+ putTRound（概览）。
 * @layer DAO
 * @storage_impact 启动时仅读取 4 张表（feeConfigs / positions / positionBatches / tRounds）；
 *                 已平仓持仓、已完成 Round、中长期记录等归档数据通过按需分页查询接口延迟加载；
 *                 所有写库均自动补充 `createdAt` / `updatedAt` / `isDeleted=0`，并通过 cleanUndefined 剔除 undefined 字段防序列化错误。
 * @author 开发团队
 */
// ============================================================
// IndexedDB Database via Dexie.js
// New normalized storage schema for TradingLedgerDB_v3
// ============================================================
import Dexie, { type Table } from 'dexie';
import { matchSecurityKind, type FeeConfig, type SecurityKind } from '../utils/mathUtils';
import type { PositionBatch, Position, RoundTxn, TRoundArchive } from '../store';
import type { StockMeta } from '../types/stock';
import { ulid } from 'ulid';
import { cleanUndefined } from './cleanUndefined';
import {
  db as tradingDb,
  type AccountCashEntity,
  type CashFlowEntity,
  type FeeConfigEntity,
  type LongTermRecordEntity,
  type PositionBatchEntity,
  type PositionEntity,
  type StockEntity,
  type TTransactionEntity,
  type TRoundEntity,
  type TradeNoteEntity,
} from './schema';

/** 分页查询结果包装 */
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

import type { LongTermRecord } from '../store/types';
export type { FeeConfig } from '../utils/mathUtils';
export type { Position, PositionBatch, TRoundArchive, RoundTxn } from '../store';
export type { LongTermRecord } from '../store/types';
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

/** 持仓的行级视图模型 = Store 层 Position 类型（两者完全一致，统一为单一定义） */
export type PositionRow = Position;

/** 做T Round 的行级视图模型 = Store 层 TRoundArchive 类型（统一为单一定义） */
export type TRoundRow = TRoundArchive;

/** 股票行视图模型 = StockMeta（行情搜索返回结构） */
export type StockRow = StockMeta;

/** 中长期操作记录的行级视图模型 = Store 层 LongTermRecord 类型（两者完全一致） */
export type LongTermRecordRow = LongTermRecord;

/** 全局数据库实例（别名转发自 ./schema） */
export const db = tradingDb;

/**
 * 生成全局唯一 ID。
 *
 * @returns {string} 唯一字符串 ID
 */
function makeId(): string {
  return ulid();
  //return crypto.randomUUID();
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
    kind: matchSecurityKind(stock.securityType, stock.code),
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
    isClosed: position.isClosed ? 1 : 0,
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
    kind: batch.kind,
    costPrice: batch.costPrice,
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
    roundCode: round.roundCode,
    settleType: round.settleType === 'transfer' ? 'partial' : 'clear',
    netProfit: round.netProfit,
    totalFees: round.fees ?? round.totalFees ?? 0,
    openedAt: parseTimestamp(round.openedAt),
    closedAt: round.closedAt ? parseTimestamp(round.closedAt) : undefined,
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
 * 将成交明细视图模型转换为事务实体（transfer/merge 方向归一化为 buy）。
 *
 * @description v8 起 tTransactions 是流水的唯一持久化表，字段与引擎 TStreamRecord 对齐，
 *              因此转换函数直接透传全部流水字段（含倒T扣减/归并幂等标记）。
 * @param {RoundTxn} transaction - 成交明细视图模型
 * @param {string} roundId - 所属 Round id
 * @returns {TTransactionEntity} 事务实体
 */
function toTransactionEntity(transaction: RoundTxn, roundId: string): TTransactionEntity {
  const rawDirection = String(transaction.direction);
  return {
    id: transaction.id,
    roundId,
    fullCode: transaction.fullCode ?? '',
    stockName: transaction.stockName ?? transaction.fullCode ?? '',
    direction: (rawDirection === 'transfer' || rawDirection === 'merge') ? 'buy' : (transaction.direction as 'buy' | 'sell'),
    price: transaction.price,
    amount: transaction.amount,
    fee: transaction.fee,
    matchedAmount: transaction.matchedAmount ?? 0,
    realizedProfit: transaction.realizedProfit ?? 0,
    timestamp: transaction.timestamp,
    note: transaction.note,
    quoteId: transaction.quoteId,
    selectedStock: transaction.selectedStock as Record<string, unknown> | undefined,
    baseDeductedAmount: transaction.baseDeductedAmount,
    baseMergedAmount: transaction.baseMergedAmount,
    borrowBatchId: transaction.borrowBatchId,
    mergeBatchId: transaction.mergeBatchId,
    createdAt: parseTimestamp(transaction.timestamp),
    updatedAt: parseTimestamp(transaction.timestamp),
    isDeleted: 0,
  };
}

/**
 * 将事务实体映射回成交明细视图模型（兼容 v8 前 number 时间戳的存量数据）。
 *
 * @param {TTransactionEntity} transaction - 事务实体
 * @returns {RoundTxn} 成交明细视图模型
 */
function toRoundTxn(transaction: TTransactionEntity): RoundTxn {
  const ts = typeof transaction.timestamp === 'number'
    ? new Date(transaction.timestamp).toISOString()
    : transaction.timestamp;
  return {
    id: transaction.id,
    timestamp: ts,
    fullCode: transaction.fullCode,
    stockName: transaction.stockName,
    direction: transaction.direction,
    price: transaction.price,
    amount: transaction.amount,
    fee: transaction.fee,
    matchedAmount: transaction.matchedAmount,
    realizedProfit: transaction.realizedProfit,
    note: transaction.note,
    quoteId: transaction.quoteId,
    selectedStock: transaction.selectedStock,
    baseDeductedAmount: transaction.baseDeductedAmount,
    baseMergedAmount: transaction.baseMergedAmount,
    borrowBatchId: transaction.borrowBatchId,
    mergeBatchId: transaction.mergeBatchId,
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
    stockName: entity.fullCode,
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

// ============================================================
// 按需加载函数族（Per-domain Lazy Loaders）
// ------------------------------------------------------------
// 替代原本的 loadAllFromDB() 全量加载，每个函数只加载一种数据类型，
// 供 Store 层按需调用，降低冷启动开销与内存占用。
// ============================================================

/**
 * 按需加载费率配置。
 *
 * @returns {Promise<FeeConfigEntity | null>} 费率配置实体，不存在时返回 null
 */
export async function loadFeeConfigFromDB(): Promise<FeeConfigEntity | null> {
  const rows = await db.feeConfigs.toArray();
  return rows.length > 0 ? rows[0] : null;
}

/**
 * 按需加载未平仓持仓（含批次聚合）。
 *
 * @description 仅加载未平仓且未删除的持仓及其批次，已平仓/已删除持仓不加载。
 *              返回的 positions 已是 Store 层所需的 Position[] 格式（含嵌套 batches）。
 * @returns {Promise<PositionRow[]>} 未平仓持仓数组
 */
export async function loadPositionsFromDB(): Promise<PositionRow[]> {
  const openPositions = await db.positions.where('[isClosed+isDeleted]').equals([0, 0]).toArray();
  // 只加载有持仓的股票代码相关的股票信息，避免全量加载 stocks 表
  const relevantFullCodes = [...new Set(openPositions.map((p) => p.fullCode))];
  const stocksRaw = relevantFullCodes.length > 0
    ? await db.stocks.where('fullCode').anyOf(relevantFullCodes).toArray()
    : [];
  const positionBatchesRaw = await db.positionBatches.toArray();

  const stockMap = new Map(stocksRaw.map((item) => [item.fullCode, item]));
  const openPositionIds = new Set(openPositions.map((p) => p.id));
  const positionBatches = positionBatchesRaw.filter((b) => (b.isDeleted ?? 0) === 0 && openPositionIds.has(b.positionId));

  const positionMap = new Map<string, PositionRow>();
  for (const position of openPositions) {
    positionMap.set(position.id, {
      id: position.id,
      stockName: stockMap.get(position.fullCode)?.stockName ?? position.fullCode,
      fullCode: position.fullCode,
      currentCost: position.currentCost,
      currentAmount: position.currentAmount,
      batches: [],
      isClosed: position.isClosed === 1,
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
        kind: batch.kind,
        costPrice: batch.costPrice,
      });
    }
  }

  return Array.from(positionMap.values());
}

/**
 * 按需加载所有未删除的做T轮次（OPENED + COMPLETED）。
 *
 * @description 将全部 Round 加载到 Zustand 的 tRounds 中，确保删除操作
 *              （removeRound）能通过 ID 找到已完成战报；成交明细通过
 *              fetchTransactionsByRoundId 按需加载，不在初始加载时拉取。
 *              v8：OPENED 状态的 Round 额外携带 transactions（即当前流水池），
 *              供 useStreamResults 在刷新后无损恢复撮合。
 * @returns {Promise<TRoundRow[]>} 所有未删除的轮次数组（OPENED 含 transactions）
 */
export async function loadTRoundsFromDB(): Promise<TRoundRow[]> {
  const entities = await db.tRounds
    .where('isDeleted').equals(0)
    .toArray();
  const relevantFullCodes = [...new Set(entities.map((r) => r.fullCode))];
  const stocks = relevantFullCodes.length > 0
    ? await db.stocks.where('fullCode').anyOf(relevantFullCodes).toArray()
    : [];
  const stockMap = new Map(stocks.map((s) => [s.fullCode, s]));
  // 仅 OPENED 轮次加载流水（COMPLETED 明细按需懒加载，避免归档体积拖慢冷启动）
  const openRoundIds = entities.filter((r) => r.status === 'OPENED').map((r) => r.id);
  const txnEntities = openRoundIds.length > 0
    ? await db.tTransactions
        .where('roundId').anyOf(openRoundIds)
        .filter((t) => (t.isDeleted ?? 0) === 0)
        .sortBy('timestamp')
    : [];
  const txnMap = new Map<string, RoundTxn[]>();
  for (const t of txnEntities) {
    const list = txnMap.get(t.roundId);
    const row = toRoundTxn(t);
    if (list) list.push(row);
    else txnMap.set(t.roundId, [row]);
  }
  return entities.map((r) => ({
    id: r.id,
    positionId: r.positionId,
    fullCode: r.fullCode,
    stockName: stockMap.get(r.fullCode)?.stockName ?? r.fullCode,
    roundCode: r.roundCode,
    mode: r.mode,
    status: r.status,
    settleType: r.settleType === 'partial' ? 'transfer' : 'clear',
    netProfit: r.netProfit,
    fees: r.totalFees,
    sellAmount: r.sellAmount ?? 0,
    transferAmount: r.transferAmount,
    avgPrice: r.avgPrice ?? 0,
    buyAmount: r.buyAmount ?? 0,
    tradeCount: r.tradeCount ?? 0,
    holdingDays: r.holdingDays ?? 0,
    win: r.win ?? false,
    openedAt: new Date(r.openedAt).toISOString(),
    closedAt: r.closedAt ? new Date(r.closedAt).toISOString() : '',
    lastUpdated: r.lastUpdated,
    transactions: txnMap.get(r.id),
  }));
}

/**
 * 按需加载股票基础信息。
 *
 * @returns {Promise<StockRow[]>} 未删除的股票信息数组
 */
export async function loadStocksFromDB(): Promise<StockRow[]> {
  const stocksRaw = await db.stocks.toArray();
  return stocksRaw.filter((r) => (r.isDeleted ?? 0) === 0).map((item) => ({
    fullCode: item.fullCode,
    code: item.code,
    stockName: item.stockName,
    pinYin: item.pinYin,
    marketType: item.marketType,
    securityType: item.securityType,
    kind: item.kind as StockMeta['kind'],
    quoteId: item.quoteId,
    shortName: item.shortName,
    unifiedCode: item.unifiedCode,
  }));
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
    await db.feeConfigs.put(cleanUndefined({ id: 1, updatedAt: now, createdAt: now, isDeleted: 0, ...config }));
  });
}

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

// ============================================================
// 按需加载 / 分页查询接口
// ============================================================

/**
 * 按 positionId 查询某持仓的所有批次。
 */
export async function fetchBatchesByPositionId(positionId: string): Promise<PositionBatch[]> {
  const entities = await db.positionBatches
    .where({ positionId })
    .filter((b) => (b.isDeleted ?? 0) === 0)
    .sortBy('timestamp');
  return entities.map((b) => ({
    id: b.id,
    timestamp: new Date(b.timestamp).toISOString(),
    type: b.type as PositionBatch['type'],
    price: b.price,
    amount: b.amount,
    fee: b.fee,
    costAfter: b.costAfter,
    amountAfter: b.amountAfter,
    note: b.note,
    kind: b.kind,
  }));
}

/**
 * 分页查询已平仓持仓（isClosed === 1, isDeleted === 0）。
 */
export async function fetchClosedPositionsPage(
  page: number,
  pageSize: number,
): Promise<PageResult<PositionRow>> {
  const total = await db.positions
    .where('[isClosed+isDeleted]').equals([1, 0])
    .count();
  const entities = await db.positions
    .where('[isClosed+isDeleted]').equals([1, 0])
    .offset((page - 1) * pageSize)
    .limit(pageSize)
    .toArray();
  const relevantFullCodes = [...new Set(entities.map((p) => p.fullCode))];
  const stocks = relevantFullCodes.length > 0
    ? await db.stocks.where('fullCode').anyOf(relevantFullCodes).toArray()
    : [];
  const stockMap = new Map(stocks.map((s) => [s.fullCode, s]));
  const items: PositionRow[] = [];
  for (const p of entities) {
    const batches = await fetchBatchesByPositionId(p.id);
    items.push({
      id: p.id,
      stockName: stockMap.get(p.fullCode)?.stockName ?? p.fullCode,
      fullCode: p.fullCode,
      currentCost: p.currentCost,
      currentAmount: p.currentAmount,
      batches,
      isClosed: p.isClosed === 1,
      createdAt: new Date(p.createdAt).toISOString(),
      closedAt: p.closedAt ? new Date(p.closedAt).toISOString() : undefined,
      realizedPnL: p.realizedPnL,
      totalInvested: p.totalInvested,
    });
  }
  return { items, total, page, pageSize, hasMore: page * pageSize < total };
}

/**
 * 查询全部已平仓持仓（用于导出）。
 */
export async function fetchAllClosedPositions(): Promise<PositionRow[]> {
  const entities = await db.positions
    .where('[isClosed+isDeleted]').equals([1, 0])
    .toArray();
  const relevantFullCodes = [...new Set(entities.map((p) => p.fullCode))];
  const stocks = relevantFullCodes.length > 0
    ? await db.stocks.where('fullCode').anyOf(relevantFullCodes).toArray()
    : [];
  const stockMap = new Map(stocks.map((s) => [s.fullCode, s]));
  const result: PositionRow[] = [];
  for (const p of entities) {
    const batches = await fetchBatchesByPositionId(p.id);
    result.push({
      id: p.id,
      stockName: stockMap.get(p.fullCode)?.stockName ?? p.fullCode,
      fullCode: p.fullCode,
      currentCost: p.currentCost,
      currentAmount: p.currentAmount,
      batches,
      isClosed: p.isClosed === 1,
      createdAt: new Date(p.createdAt).toISOString(),
      closedAt: p.closedAt ? new Date(p.closedAt).toISOString() : undefined,
      realizedPnL: p.realizedPnL,
      totalInvested: p.totalInvested,
    });
  }
  return result;
}

// ---- 股票 ----
/** 新增/更新单个股票 */
export async function putStock(stock: StockRow): Promise<void> {
  await db.stocks.put(cleanUndefined(withTimestamps(toStockEntity(stock))));
}

/** 批量新增/更新股票 */
/**
 * 按 roundId 查询某战报的交易明细。
 */
export async function fetchTransactionsByRoundId(roundId: string): Promise<RoundTxn[]> {
  const entities = await db.tTransactions
    .where({ roundId })
    .filter((t) => (t.isDeleted ?? 0) === 0)
    .sortBy('id');
  return entities.map((t) => toRoundTxn(t));
}

/**
 * 查询所有 OPENED 状态的 Round（含交易明细）。
 */
export async function fetchOpenRoundsWithTransactions(): Promise<TRoundRow[]> {
  const entities = await db.tRounds
    .where('[status+isDeleted]').equals(['OPENED', 0])
    .toArray();
  // 只加载相关股票信息，避免全量加载 stocks 表
  const relevantFullCodes = [...new Set(entities.map((r) => r.fullCode))];
  const stocks = relevantFullCodes.length > 0
    ? await db.stocks.where('fullCode').anyOf(relevantFullCodes).toArray()
    : [];
  const stockMap = new Map(stocks.map((s) => [s.fullCode, s]));
  const result: TRoundRow[] = [];
  for (const r of entities) {
    const txns = await fetchTransactionsByRoundId(r.id);
    result.push({
      id: r.id,
      positionId: r.positionId,
      fullCode: r.fullCode,
      stockName: stockMap.get(r.fullCode)?.stockName ?? r.fullCode,
      roundCode: r.roundCode,
      mode: r.mode,
      settleType: r.settleType === 'partial' ? 'transfer' : 'clear',
      transactions: txns,
      netProfit: r.netProfit,
      fees: r.totalFees,
      sellAmount: r.sellAmount ?? 0,
      transferAmount: r.transferAmount,
      avgPrice: r.avgPrice ?? 0,
      buyAmount: r.buyAmount ?? 0,
      tradeCount: r.tradeCount ?? 0,
      holdingDays: r.holdingDays ?? 0,
      win: r.win ?? false,
      openedAt: new Date(r.openedAt).toISOString(),
      closedAt: r.closedAt ? new Date(r.closedAt).toISOString() : '',
      lastUpdated: r.lastUpdated,
    });
  }
  return result;
}

/**
 * 分页查询已完成的 Round（status === 'COMPLETED'）。
 * 只返回轮次摘要（不含 transactions 明细）；成交明细在 UI 展开
 * 「查看成交明细」时通过 fetchTransactionsByRoundId 按需查询。
 */
export async function fetchCompletedRoundsPage(
  page: number,
  pageSize: number,
): Promise<PageResult<TRoundRow>> {
  const total = await db.tRounds
    .where('[status+isDeleted]').equals(['COMPLETED', 0])
    .count();
  const entities = await db.tRounds
    .where('[status+isDeleted]').equals(['COMPLETED', 0])
    .offset((page - 1) * pageSize)
    .limit(pageSize)
    .toArray();
  const relevantFullCodes = [...new Set(entities.map((r) => r.fullCode))];
  const stocks = relevantFullCodes.length > 0
    ? await db.stocks.where('fullCode').anyOf(relevantFullCodes).toArray()
    : [];
  const stockMap = new Map(stocks.map((s) => [s.fullCode, s]));
  const items: TRoundRow[] = entities.map((r) => ({
    id: r.id,
    positionId: r.positionId,
    fullCode: r.fullCode,
    stockName: stockMap.get(r.fullCode)?.stockName ?? r.fullCode,
    roundCode: r.roundCode,
    mode: r.mode,
    settleType: r.settleType === 'partial' ? 'transfer' : 'clear',
    netProfit: r.netProfit,
    fees: r.totalFees,
    sellAmount: r.sellAmount ?? 0,
    transferAmount: r.transferAmount,
    avgPrice: r.avgPrice ?? 0,
    buyAmount: r.buyAmount ?? 0,
    tradeCount: r.tradeCount ?? 0,
    holdingDays: r.holdingDays ?? 0,
    win: r.win ?? false,
    openedAt: new Date(r.openedAt).toISOString(),
    closedAt: r.closedAt ? new Date(r.closedAt).toISOString() : '',
    lastUpdated: r.lastUpdated,
  }));
  return { items, total, page, pageSize, hasMore: page * pageSize < total };
}

/**
 * 查询所有已完成的 Round（用于导出）。
 */
export async function fetchAllCompletedRounds(): Promise<TRoundRow[]> {
  const entities = await db.tRounds
    .where('[status+isDeleted]').equals(['COMPLETED', 0])
    .toArray();
  const relevantFullCodes = [...new Set(entities.map((r) => r.fullCode))];
  const stocks = relevantFullCodes.length > 0
    ? await db.stocks.where('fullCode').anyOf(relevantFullCodes).toArray()
    : [];
  const stockMap = new Map(stocks.map((s) => [s.fullCode, s]));
  const result: TRoundRow[] = [];
  for (const r of entities) {
    const txns = await fetchTransactionsByRoundId(r.id);
    result.push({
      id: r.id,
      positionId: r.positionId,
      fullCode: r.fullCode,
      stockName: stockMap.get(r.fullCode)?.stockName ?? r.fullCode,
      roundCode: r.roundCode,
      mode: r.mode,
      settleType: r.settleType === 'partial' ? 'transfer' : 'clear',
      transactions: txns,
      netProfit: r.netProfit,
      fees: r.totalFees,
      sellAmount: r.sellAmount ?? 0,
      transferAmount: r.transferAmount,
      avgPrice: r.avgPrice ?? 0,
      buyAmount: r.buyAmount ?? 0,
      tradeCount: r.tradeCount ?? 0,
      holdingDays: r.holdingDays ?? 0,
      win: r.win ?? false,
      openedAt: new Date(r.openedAt).toISOString(),
      closedAt: r.closedAt ? new Date(r.closedAt).toISOString() : '',
      lastUpdated: r.lastUpdated,
    });
  }
  return result;
}

/**
 * 查询所有中长期操作记录（用于导出）。
 */
export async function fetchAllLongTermRecords(): Promise<LongTermRecordRow[]> {
  const entities = await db.longTermRecords
    .filter((r) => (r.isDeleted ?? 0) === 0)
    .toArray();
  const relevantFullCodes = [...new Set(entities.map((r) => r.fullCode))];
  const stocks = relevantFullCodes.length > 0
    ? await db.stocks.where('fullCode').anyOf(relevantFullCodes).toArray()
    : [];
  const stockMap = new Map(stocks.map((s) => [s.fullCode, s.stockName]));
  return entities.map((r) => ({
    id: r.id,
    fullCode: r.fullCode,
    stockName: stockMap.get(r.fullCode) ?? r.fullCode,
    type: r.type,
    price: r.price,
    amount: r.amount,
    fee: r.fee,
    sourceReportId: r.sourceReportId,
    timestamp: new Date(r.timestamp).toISOString(),
    note: r.note,
  }));
}
export async function bulkPutStocks(stocks: StockRow[]): Promise<void> {
  if (stocks.length === 0) return;
  const now = Date.now();
  await db.stocks.bulkPut(stocks.map((s) => cleanUndefined({ ...toStockEntity(s), updatedAt: now, createdAt: now, isDeleted: 0 })));
}

/** 按 fullCode 删除股票 */
export async function deleteStock(fullCode: string): Promise<void> {
  await db.stocks.where({ fullCode }).delete();
}

// ---- 持仓 & 批次 ----
/** 新增/更新单个持仓 */
export async function putPosition(position: PositionRow): Promise<void> {
  await db.positions.put(cleanUndefined(withTimestamps(toPositionEntity(position))));
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
  await db.positionBatches.put(cleanUndefined(withTimestamps(toPositionBatchEntity(batch, positionId))));
}

/**
 * 原子化写入持仓及所有批次（单事务）。
 * 用于新建持仓场景，保证 position 和其 batches 同步落库。
 */
export async function putPositionWithBatches(
  position: PositionRow,
  batches: PositionBatch[],
): Promise<void> {
  await db.transaction('rw', db.positions, db.positionBatches, async () => {
    await db.positions.put(cleanUndefined(withTimestamps(toPositionEntity(position))));
    for (const batch of batches) {
      await db.positionBatches.put(cleanUndefined(withTimestamps(toPositionBatchEntity(batch, position.id))));
    }
  });
}

/**
 * 原子化追加单个批次到已有持仓（单事务）。
 * 同时更新持仓快照与批次记录，保证不会出现"持仓已更新但批次未落库"的中间态。
 */
export async function addBatchToPosition(
  position: PositionRow,
  batch: PositionBatch,
): Promise<void> {
  await db.transaction('rw', db.positions, db.positionBatches, async () => {
    // 兜底防脏写：批次自带本次操作后的权威快照（costAfter/amountAfter）。
    // 即使调用方传入的 position 快照是旧值（例如先加批次、再单独更新快照的旧写法），
    // 成本/数量也以批次为准落库，避免「旧值覆盖新值」。
    const snapshot: PositionRow = {
      ...position,
      currentCost: batch.costAfter ?? position.currentCost,
      currentAmount: batch.amountAfter ?? position.currentAmount,
    };
    await db.positions.put(cleanUndefined(withTimestamps(toPositionEntity(snapshot))));
    await db.positionBatches.put(cleanUndefined(withTimestamps(toPositionBatchEntity(batch, position.id))));
  });
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
      await db.positionBatches.bulkPut(batches.map((b) => cleanUndefined({ ...toPositionBatchEntity(b, positionId), updatedAt: now, createdAt: now, isDeleted: 0 })));
    }
  });
}

/**
 * 原子化更新持仓快照并替换所有批次（单事务）。
 * 用于 reconcile 对账后的持久化：positions 表写快照，positionBatches 表全量替换。
 */
export async function replacePositionSnapshotWithBatches(
  position: PositionRow,
  batches: PositionBatch[],
): Promise<void> {
  await db.transaction('rw', db.positions, db.positionBatches, async () => {
    await db.positions.put(cleanUndefined(withTimestamps(toPositionEntity(position))));
    await db.positionBatches.where({ positionId: position.id }).delete();
    if (batches.length > 0) {
      const now = Date.now();
      await db.positionBatches.bulkPut(batches.map((b) => cleanUndefined({ ...toPositionBatchEntity(b, position.id), updatedAt: now, createdAt: now, isDeleted: 0 })));
    }
  });
}

/** 删除某持仓下所有带 kind 标识的调整批次（borrow/merge） */
export async function deleteAdjustmentBatches(positionId: string): Promise<void> {
  await db.positionBatches
    .where({ positionId })
    .filter((b) => b.kind === 'borrow' || b.kind === 'merge')
    .delete();
}

// ---- 做T Round 与流水（v8：tTransactions 为流水唯一持久化表） ----
/** 新增/更新单个 Round 概览（v8：只写 tRounds 行；流水由 putTransaction 增量写入） */
export async function putTRound(round: TRoundRow): Promise<void> {
  await db.tRounds.put(cleanUndefined(withTimestamps(toRoundEntity(round))));
}

/**
 * 整轮写入（Round 概览 + 该轮全部流水，单事务原子操作）。
 *
 * @description 用于手动添加归档 Round / 导入 / 划转或结算结清等「整轮替换」场景。
 *              正常增量流水路径应使用 putTRound + putTransaction 分别落库。
 */
export async function putRoundWithTransactions(round: TRoundRow): Promise<void> {
  await db.transaction('rw', db.tRounds, db.tTransactions, async () => {
    await db.tRounds.put(cleanUndefined(withTimestamps(toRoundEntity(round))));
    await db.tTransactions.where({ roundId: round.id }).delete();
    const txns = round.transactions ?? [];
    if (txns.length > 0) {
      const now = Date.now();
      await db.tTransactions.bulkPut(txns.map((t) => cleanUndefined({ ...toTransactionEntity(t, round.id), updatedAt: now, createdAt: now, isDeleted: 0 })));
    }
  });
}

/** 删除单个 Round 及其所有交易明细 */
export async function deleteTRoundWithTransactions(id: string): Promise<void> {
  await db.transaction('rw', db.tRounds, db.tTransactions, async () => {
    await db.tRounds.delete(id);
    await db.tTransactions.where({ roundId: id }).delete();
  });
}

/** 新增/更新单笔成交明细（v8 增量流水写入主入口：roundId + 流水字段一并落库） */
export async function putTransaction(roundId: string, txn: RoundTxn): Promise<void> {
  await db.tTransactions.put(cleanUndefined(withTimestamps(toTransactionEntity(txn, roundId))));
}

/** 替换某 Round 下的所有交易明细（整轮替换，导入/迁移用） */
export async function replaceRoundTransactions(roundId: string, transactions: RoundTxn[]): Promise<void> {
  await db.transaction('rw', db.tTransactions, async () => {
    await db.tTransactions.where({ roundId }).delete();
    if (transactions.length > 0) {
      const now = Date.now();
      await db.tTransactions.bulkPut(transactions.map((t) => cleanUndefined({ ...toTransactionEntity(t, roundId), updatedAt: now, createdAt: now, isDeleted: 0 })));
    }
  });
}

/** 按 id 物理删除单笔成交明细 */
export async function deleteTransaction(id: string): Promise<void> {
  await db.tTransactions.delete(id);
}

/** 批量物理删除成交明细 */
export async function bulkDeleteTransactions(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.tTransactions.bulkDelete(ids);
}

// ---- 中长期操作记录 ----
/** 新增/更新单条中长期记录 */
export async function putLongTermRecord(record: LongTermRecordRow): Promise<void> {
  await db.longTermRecords.put(cleanUndefined(withTimestamps(toLongTermRecordEntity(record))));
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
// 原子化组合操作（多步写入在同一 Dexie 事务中完成）
// ============================================================

/**
 * 删除 Round 及其关联数据（单事务原子操作）。
 * 同时删除 Round 本身、交易明细、中长期记录，并更新持仓。
 */
export async function deleteRoundWithCascade(
  roundId: string,
  sourceReportId: string,
  positions: PositionRow[],
): Promise<void> {
  await db.transaction('rw', db.tRounds, db.tTransactions, db.longTermRecords, db.positions, db.positionBatches, async () => {
    await db.tRounds.delete(roundId);
    await db.tTransactions.where({ roundId }).delete();
    await db.longTermRecords.where({ sourceReportId }).delete();
    for (const pos of positions) {
      await db.positions.put(cleanUndefined(withTimestamps(toPositionEntity(pos))));
      // 同步持久化批次履历，保证批次与快照一致
      await db.positionBatches.where({ positionId: pos.id }).delete();
      if (pos.batches.length > 0) {
        const now = Date.now();
        await db.positionBatches.bulkPut(pos.batches.map((b) =>
          cleanUndefined({ ...toPositionBatchEntity(b, pos.id), updatedAt: now, createdAt: now, isDeleted: 0 })
        ));
      }
    }
  });
}

/**
 * 做T划转底仓结算归档（单事务原子操作）。
 * v8：流水已随录入逐笔写入 tTransactions，此处只需更新 Round 概览（COMPLETED）
 *     并幂等补全明细，同时写入中长期归并记录并更新持仓。
 */
export async function completeRoundWithMerge(
  round: TRoundRow,
  mergeRecord: LongTermRecordRow,
  positions: PositionRow[],
): Promise<void> {
  await db.transaction('rw', [db.tRounds, db.tTransactions, db.longTermRecords, db.positions, db.positionBatches], async () => {
    await db.tRounds.put(cleanUndefined(withTimestamps(toRoundEntity(round))));
    const txns = round.transactions ?? [];
    if (txns.length > 0) {
      const now = Date.now();
      await db.tTransactions.bulkPut(txns.map((t) => cleanUndefined({ ...toTransactionEntity(t, round.id), updatedAt: now, createdAt: now, isDeleted: 0 })));
    }
    await db.longTermRecords.put(cleanUndefined(withTimestamps(toLongTermRecordEntity(mergeRecord))));
    for (const pos of positions) {
      await db.positions.put(cleanUndefined(withTimestamps(toPositionEntity(pos))));
      // 同步持久化批次履历，保证批次与快照一致
      await db.positionBatches.where({ positionId: pos.id }).delete();
      if (pos.batches.length > 0) {
        const now = Date.now();
        await db.positionBatches.bulkPut(pos.batches.map((b) =>
          cleanUndefined({ ...toPositionBatchEntity(b, pos.id), updatedAt: now, createdAt: now, isDeleted: 0 })
        ));
      }
    }
  });
}

/**
 * 清仓式结算做T Round（单事务原子操作）。
 * v8：流水已随录入逐笔写入 tTransactions，此处只需更新 Round 概览（COMPLETED）
 *     并幂等补全明细。
 */
export async function completeRoundClear(
  round: TRoundRow,
): Promise<void> {
  await db.transaction('rw', db.tRounds, db.tTransactions, async () => {
    await db.tRounds.put(cleanUndefined(withTimestamps(toRoundEntity(round))));
    const txns = round.transactions ?? [];
    if (txns.length > 0) {
      const now = Date.now();
      await db.tTransactions.bulkPut(txns.map((t) => cleanUndefined({ ...toTransactionEntity(t, round.id), updatedAt: now, createdAt: now, isDeleted: 0 })));
    }
  });
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
  stocks: StockRow[],
  longTermRecords: LongTermRecordRow[] = [],
): Promise<void> {
  await db.transaction('rw', [db.feeConfigs, db.stocks, db.positions, db.positionBatches, db.tRounds, db.tTransactions, db.longTermRecords], async () => {
    const now = Date.now();

    // 1. 费率配置：直接 put（id=1 单行 upsert）
    await db.feeConfigs.put(cleanUndefined({ id: 1, updatedAt: now, createdAt: now, isDeleted: 0, ...feeConfig }));

    // 2. 股票：收集新数据 fullCode 集合，bulkPut 后删除不在集合中的
    const newStockFullCodes = new Set(stocks.map((s) => s.fullCode));
    if (stocks.length > 0) {
      await db.stocks.bulkPut(stocks.map((s) => cleanUndefined({ ...toStockEntity(s), updatedAt: now, createdAt: now, isDeleted: 0 })));
    }
    const oldStockFullCodes = (await db.stocks.toArray()).map((e) => e.fullCode);
    const staleStockFullCodes = oldStockFullCodes.filter((fc) => !newStockFullCodes.has(fc));
    if (staleStockFullCodes.length > 0) {
      await db.stocks.where('fullCode').anyOf(staleStockFullCodes).delete();
    }

    // 3. 持仓 + 批次：收集新数据 id 集合，先写后删旧
    const newPositionIds = new Set(positions.map((p) => p.id));
    if (positions.length > 0) {
      await db.positions.bulkPut(positions.map((p) => cleanUndefined({ ...toPositionEntity(p), updatedAt: now, createdAt: now, isDeleted: 0 })));
      const allBatches = positions.flatMap((p) => p.batches.map((b) => cleanUndefined({ ...toPositionBatchEntity(b, p.id), updatedAt: now, createdAt: now, isDeleted: 0 })));
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
      await db.tRounds.bulkPut(tRounds.map((r) => cleanUndefined({ ...toRoundEntity(r), updatedAt: now, createdAt: now, isDeleted: 0 })));
      const allTxns = tRounds.flatMap((r) => (r.transactions ?? []).map((t) => cleanUndefined({ ...toTransactionEntity(t, r.id), updatedAt: now, createdAt: now, isDeleted: 0 })));
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

    // 5. 中长期操作记录
    const newLtrIds = new Set(longTermRecords.map((r) => r.id));
    if (longTermRecords.length > 0) {
      await db.longTermRecords.bulkPut(longTermRecords.map((r) => cleanUndefined({ ...toLongTermRecordEntity(r), updatedAt: now, createdAt: now, isDeleted: 0 })));
    }
    const oldLtrIds = (await db.longTermRecords.toArray()).map((e) => e.id);
    const staleLtrIds = oldLtrIds.filter((id) => !newLtrIds.has(id));
    if (staleLtrIds.length > 0) {
      await db.longTermRecords.bulkDelete(staleLtrIds);
    }
  });
}
