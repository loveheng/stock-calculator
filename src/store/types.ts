/**
 * @file types.ts
 * @description Store 层所有类型定义，从 store/index.ts 中提取以保持单一职责。
 *              包含持仓、批次、做T记录、Round、中长期记录、现金流、导入导出等核心数据结构。
 *              v6.1 重构：统一类型系统 —— 所有类型不再与 db/index.ts 重复定义，
 *              db/index.ts 中的 Row 类型改用本文件中的类型别名；
 *              TRoundArchive 新增 lastUpdated 兼容字段（@deprecated）。
 * @layer Store (Types)
 * @author 开发团队
 */

import type { FeeConfig } from '../utils/mathUtils';
import type { StockMeta, StockSearchItem } from '../types/stock';
import type { TStreamRecord, StockStreamResult } from '../utils/tStreamEngine';

// ---- 做T记录（旧版：买卖成对，仅保留用于统计页兼容展示） ----
/** @deprecated tRecords 为 v5 以前旧版数据格式，仅保留用于统计页兼容展示。
 *  新代码应使用 tStreams（单边流水池）+ tRounds（Round 战报归档）替代。
 *  计划在 v7 中移除本字段及其关联的 importLegacyTRecords 接口。 */
export interface TRecord {
  id: string;
  timestamp: string;
  stockName: string;
  mode: 'long' | 'short';
  buyPrice: number;
  buyAmount: number;
  sellPrice: number;
  sellAmount: number;
  totalFee: number;
  netProfit: number | null;
  profitRate: number | null;
  status: string;
  fullCode: string;
  quoteId?: string;
  selectedStock?: StockSearchItem;
}

// ---- 建仓批次 ----
export interface PositionBatch {
  id: string;
  timestamp: string;
  type: 'open' | 'add' | 'reduce' | 'close';
  price: number;
  amount: number;
  costAfter: number;
  amountAfter: number;
  note?: string;
  fee?: number;
}

// ---- 持仓（成本摊薄账本中的单只股票持仓） ----
export interface Position {
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

// ---- Round 交易明细（每笔已撮合的做T交易） ----
export interface RoundTxn {
  id: string;
  timestamp: string;
  direction: 'buy' | 'sell' | 'merge';
  price: number;
  amount: number;
  fee: number;
  matchedAmount?: number;
  realizedProfit?: number;
  note?: string;
}

// ---- Round 战报归档 ----
export interface TRoundArchive {
  id: string;
  positionId?: string;
  fullCode: string;
  stockName: string;
  mode: 'long' | 'short';
  status?: 'OPENED' | 'COMPLETED';
  roundNo: number;
  settleType: 'clear' | 'partial' | 'transfer';
  netProfit: number;
  totalFees?: number;
  fees?: number;
  openedAt: string;
  closedAt?: string;
  buyAmount?: number;
  sellAmount?: number;
  transferAmount?: number;
  avgPrice?: number;
  tradeCount?: number;
  holdingDays?: number;
  win?: boolean;
  lastTouched?: string;
  /** @deprecated 兼容旧版 DB 字段名，应使用 `lastTouched` */
  lastUpdated?: number;
  /**
   * 做T成交明细（含撮合配对与划转记录）。
   * 可选：列表加载器只返回轮次摘要（不含明细），展开「查看成交明细」时
   * 才通过 fetchTransactionsByRoundId 按需查询 tTransactions 表。
   * 写入路径（归档/结算/导入）必须携带完整明细以保证持久化。
   */
  transactions?: RoundTxn[];
}

// ---- 中长期操作记录 ----
export interface LongTermRecord {
  id: string;
  fullCode: string;
  stockName: string;
  timestamp: string;
  type: 'buy' | 'sell' | 'merge';
  price: number;
  amount: number;
  fee: number;
  sourceReportId?: string;
  note?: string;
}

/** 费率模板名称 */
export type FeePresetName = '默认A股' | 'A股标准模板' | 'ETF模板' | '港股/美股免佣模板';

/** 流水追加结果：被 Store 层校验拒绝时 rejected=true */
export interface StreamAddResult {
  cleared: boolean;
  netProfit?: number;
  avgPrice?: number;
  rejected?: boolean;
  rejectedReason?: string;
}

/** 应用导出/导入的数据结构（JSON 序列化友好） */
export interface AppStoreExport {
  version: number;
  feeConfig: FeeConfig;
  /** @deprecated 旧版做T记录，v5 后改用 tStreams + tRounds */
  tRecords: TRecord[];
  tStreams: TStreamRecord[];
  tRounds: TRoundArchive[];
  positions: Position[];
  stocks: StockMeta[];
  longTermRecords: LongTermRecord[];
}

/** Store Action 接口：汇总所有可以操作的函数签名 */
export interface AppStoreActions {
  // -- 生命周期 --
  setCoreDataLoaded: (loaded: boolean) => void;
  loadTStreams: () => Promise<void>;
  loadPositions: () => Promise<void>;
  loadTRounds: () => Promise<void>;
  loadStocks: () => Promise<void>;

  // -- 费率 --
  setFeeConfig: (partial: Partial<FeeConfig>) => void;
  resetFeeConfig: (config: FeeConfig) => void;

  // -- 流水池 --
  addStreamRecord: (record: TStreamRecord) => StreamAddResult;
  removeStreamRecord: (id: string) => void;
  updateStreamRecord: (id: string, updates: Partial<TStreamRecord>) => void;
  clearStreams: () => void;
  importLegacyTRecords: () => number;
  validateSellWithPosition: (
    stockFullCode: string,
    direction: string,
    price: number,
    amount: number,
  ) => { valid: boolean; maxSellable: number; error?: string; missingPosition?: boolean };

  // -- Round 归档 --
  addRound: (round: TRoundArchive) => void;
  removeRound: (id: string) => { ok: boolean; message?: string };
  clearRounds: () => void;
  transferToPosition: (
    fullCode: string,
    transferAmount?: number,
    transferPrice?: number,
  ) => { ok: boolean; message?: string };
  settleShortRound: (fullCode: string) => { ok: boolean; message?: string };

  // -- 持仓 --
  addPosition: (pos: Position) => void;
  updatePosition: (id: string, updates: Partial<Position>) => void;
  closePosition: (id: string) => void;
  addBatch: (positionId: string, batch: PositionBatch) => void;
  deletePositionBatch: (positionId: string, batchId: string) => void;
  removePosition: (id: string) => void;

  // -- 中长期 --
  addLongTermRecord: (record: LongTermRecord) => void;
  removeLongTermRecord: (id: string) => void;

  // -- 导入导出 --
  exportData: () => AppStoreExport;
  importData: (data: AppStoreExport) => void;
  exportJSON: () => Promise<AppStoreExport>;
  importJSON: (data: AppStoreExport) => void;
  exportCSV: () => string;
}

/** 完整的 Store 状态 + Action */
export interface AppStore extends AppStoreActions {
  coreDataLoaded: boolean;
  feeConfig: FeeConfig;
  /** @deprecated 旧版做T记录，v5 后改用 tStreams + tRounds */
  tRecords: TRecord[];
  tStreams: TStreamRecord[];
  tRounds: TRoundArchive[];
  positions: Position[];
  stocks: StockMeta[];
  longTermRecords: LongTermRecord[];
  persistError: string | null;
}

/** 导出数据版本号，用于跨版本导入校验 */
export const EXPORT_VERSION = 1;
