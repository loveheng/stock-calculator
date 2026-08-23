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
  /** 自动调整标识：borrow=倒T出借（借仓卖出，非真实落袋），merge=倒T超额买回归并 */
  kind?: 'borrow' | 'merge';
  /** 该笔操作发生时的底仓成本价（元），仅借仓卖出时记录，用于显示成本对照 */
  costPrice?: number;
  /** 关联做T轮次 id：做T归档产生的批次用于回滚定位 */
  sourceRoundId?: string;
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
  /** 开仓时间：第一笔买入（open 批次）的成交时间，ISO 字符串 */
  openAt?: string;
  closedAt?: string;
  realizedPnL?: number;
  totalInvested?: number;
}

// ---- Round 交易明细（每笔已撮合的做T交易） ----
/**
 * @description v8 起与引擎 TStreamRecord 字段对齐：Round 的 transactions 即该轮全部流水，
 *              既作为流水池恢复源（OPENED Round），也作为战报成交明细（COMPLETED Round）。
 */
export interface RoundTxn {
  id: string;
  timestamp: string;
  /** 完整证券代码（含市场前缀），OPENED 流水必须有；归档明细可缺省（从 Round 冗余） */
  fullCode?: string;
  /** 股票名称快照 */
  stockName?: string;
  direction: 'buy' | 'sell' | 'merge';
  price: number;
  amount: number;
  fee: number;
  matchedAmount?: number;
  realizedProfit?: number;
  note?: string;
  /** 行情快照 ID */
  quoteId?: string;
  /** 选股条目快照（恢复 UI 自动补全展示用） */
  selectedStock?: unknown;
  }

// ---- Round 战报归档 ----
export interface TRoundArchive {
  id: string;
  positionId?: string;
  fullCode: string;
  stockName: string;
  mode: 'long' | 'short';
  status?: 'OPENED' | 'COMPLETED';
  roundCode: string;
  settleType: 'clear' | 'partial' | 'transfer';
  netProfit: number;
  totalFees?: number;
  fees?: number;
  openedAt: string;
  closedAt?: string;
  buyAmount?: number;
  sellAmount?: number;
  avgPrice?: number;
  tradeCount?: number;
  holdingDays?: number;
  win?: boolean;
  /** 划转底仓数量（transferToPosition 时记录） */
  transferAmount?: number;
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
  type: 'buy' | 'sell' | 'merge' | 't-round';
  price: number;
  amount: number;
  fee: number;
  sourceReportId?: string;
  note?: string;
}

// ---- 计划单 ----
export interface PlannedOrder {
  id: string;
  fullCode: string;
  stockName: string;
  context: 'long-term' | 'short-term' | 'both';
  direction: 'buy' | 'sell';
  plannedPrice: number;
  plannedAmount: number;
  note?: string;
  createdAt: string;
  expiresAt: string;
  validityDays: number;
  status: 'active' | 'expired' | 'cancelled' | 'executed';
  actual?: {
    executedAt: string;
    actualPrice: number;
    actualAmount: number;
    note?: string;
    isAchieved: boolean;
    /** 中长期执行结果：新成本价 */
    newCost?: number;
    /** 中长期执行结果：新持有数量 */
    newAmount?: number;
    /** 中长期执行结果：新累计投入 */
    newTotalInvested?: number;
    /** 中长期执行结果：规费 */
    totalFee?: number;
    /** 短线执行结果：加权均价 */
    avgPrice?: number;
    /** 短线执行结果：净收益 */
    netProfit?: number;
  };
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
  tRounds: TRoundArchive[];
  positions: Position[];
  stocks: StockMeta[];
  longTermRecords: LongTermRecord[];
  plannedOrders: PlannedOrder[];
}

/** Store Action 接口：汇总所有可以操作的函数签名 */
export interface AppStoreActions {
  // -- 生命周期 --
  setCoreDataLoaded: (loaded: boolean) => void;
  loadPositions: () => Promise<void>;
  loadTRounds: () => Promise<void>;

  // -- 费率 --
  setFeeConfig: (partial: Partial<FeeConfig>) => void;

  // -- 流水池 --
  addStreamRecord: (record: TStreamRecord) => StreamAddResult;
  removeStreamRecord: (id: string) => void;
  clearStreams: () => void;

  // -- Round 归档 --
  removeRound: (id: string) => { ok: boolean; message?: string };
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
  /**
   * 原子化追加批次到已有持仓：批次与持仓快照（成本/数量等）在同一次 action 中一次性合并并单次落库。
   * 旧写法（先 addBatch 落库旧快照、再 updatePosition 落库新快照）会产生两次异步写，
   * 而 Dexie 同一 tick 内先执行隐式 put、后执行显式 db.transaction，旧快照必然最后覆盖新值。
   * @param positionId 持仓 id
   * @param batch 待追加的批次（costAfter/amountAfter 为本次操作后的权威快照）
   * @param updates 本次批次追加后同步更新的持仓快照字段
   */
  addBatch: (
    positionId: string,
    batch: PositionBatch,
    updates?: Partial<Pick<Position, 'currentCost' | 'currentAmount' | 'realizedPnL' | 'totalInvested'>>,
  ) => void;
  /**
   * 删除单笔批次：同步按剩余批次履历重算成本/数量/已实现盈亏/累计投入，单次落库。
   */
  deletePositionBatch: (positionId: string, batchId: string) => void;
  removePosition: (id: string) => void;

  // -- 计划单 --
  loadPlannedOrders: () => Promise<void>;
  setPlannedOrder: (order: PlannedOrder) => void;
  removePlannedOrder: (id: string) => void;
  markPlanExecuted: (id: string, actual: PlannedOrder['actual']) => void;
  cancelPlan: (id: string) => void;

  // -- 导入导出 --
  exportData: () => AppStoreExport;
  /**
   * 全量导入数据。
   * @param data - 导入的数据
   * @param silent - 若为 true，则表示此次导入来自远端同步（Pull & Merge），
   *                 不触发后续自动上传/自动同步逻辑，避免无限循环。
   */
  importData: (data: AppStoreExport, silent?: boolean) => void;
  exportJSON: () => Promise<AppStoreExport>;
  importJSON: (data: AppStoreExport) => void;
  exportCSV: () => string;
}

/** 完整的 Store 状态 + Action */
export interface AppStore extends AppStoreActions {
  coreDataLoaded: boolean;
  feeConfig: FeeConfig;
  /**
   * 做T战报库：OPENED（进行中，transactions 即当前流水池）+ COMPLETED（已归档）。
   * v8 起取代 tStreams —— 不再有独立流水池，流水全部归属于 Round。
   */
  tRounds: TRoundArchive[];
  positions: Position[];
  stocks: StockMeta[];
  longTermRecords: LongTermRecord[];
  plannedOrders: PlannedOrder[];
  persistError: string | null;
}

/** 导出数据版本号，用于跨版本导入校验 */
export const EXPORT_VERSION = 1;
