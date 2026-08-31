/**
 * @file domain.ts
 * @description 跨层领域类型（叶子模块）：持仓、批次、做T Round、中长期记录、计划单等
 *              纯数据契约的唯一权威定义。
 *
 *              解耦说明：这些类型原先定义在 store/types.ts，导致 db（DAO 层）、services、
 *              utils 都不得不反向依赖 store 层，形成 store/index ↔ db/index、
 *              store/index ↔ store/utils 等运行期循环依赖。
 *              下沉到本叶子模块后，依赖方向统一为：store / db / services / utils → types/domain，
 *              本模块不 import 任何项目内模块（真正的零依赖叶子）。
 * @layer Types
 * @storage_impact 纯类型定义，无运行时代码。
 * @author 开发团队
 */

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
  /** 计划创建时评估的动态金字塔健康度（仅中长期买入计划单） */
  planPyramidHealth?: { score: number; level: 'HEALTHY' | 'NEUTRAL' | 'RISKY'; centerDeviation: number };
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

// ---- 持久化实体类型（行级契约） ----
/**
 * @description 持仓/批次相关 IndexedDB 实体（行级）类型。原先定义在 db/schema.ts，
 *              但 utils/calculator、views、services 等非 db 模块也需要该行级契约，
 *              统一下沉到本叶子模块；db/schema.ts 从此处 re-export 保持既有导入路径兼容。
 */
export interface BaseEntity {
  /** 全局唯一主键，字符串 UUID */
  id: string;
  /** 创建时间戳（毫秒） */
  createdAt: number;
  /** 最近更新时间戳（毫秒），写入/更新记录时必须同步维护 */
  updatedAt: number;
  /** 软删除标记：0 = 正常，1 = 已软删除。查询时应过滤 `(isDeleted ?? 0) === 0` */
  isDeleted?: number;
}

/** 持仓实体（positions 表）。记录某一股票的底仓成本、数量与平仓状态。 */
export interface PositionEntity extends BaseEntity {
  /** 关联股票完整代码 */
  fullCode: string;
  /** 当前加权成本（元） */
  currentCost: number;
  /** 当前持有数量（股） */
  currentAmount: number;
  /**
   * 是否已平仓：0 = 未平仓，1 = 已平仓。
   * 注意必须使用 0|1 数字而非 boolean —— IndexedDB 的索引 key 仅支持 number/string/Date/binary/Array，
   * boolean 不是合法 key 类型，boolean 字段不会被 isClosed / [isClosed+isDeleted] 索引收录，
   * 导致按索引查询（[0,0]/[1,0]）查不出任何数据。
   */
  isClosed: 0 | 1;
  /** 平仓时间戳（毫秒），未平仓时缺省 */
  closedAt?: number;
  /** 开仓时间戳（毫秒）：第一笔买入（open 批次）的成交时间，存量数据可能默认，缺省时回退 createdAt */
  openAt?: number;
  /** 累计投入金额（元） */
  totalInvested: number;
  /** 已实现盈亏（元） */
  realizedPnL: number;
  /** 累计做 T 落袋净利润（元）。整轮/对冲对配口径：一轮等量对冲后 = 高抛净回款 - 低吸买入总成本；存量数据可能缺省 */
  accumulatedTPnL?: number;
  /** 初始建仓均价（元）：底仓真实买入（open 与未被做T对配消耗的 add）按数量加权的含规费均价；存量数据可能缺省 */
  initialCost?: number;
  /**
   * 做T在途占用的底仓股数（reservedForT）：物化快照字段，与 positionAdjustments 中的 in-flight 命令同步更新。
   * 日常读底仓时 O(1) 直取，无需扫描 positionAdjustments 表。
   * 仅中长线侧维护（applyRoundAdjustments / rollbackRound），做T侧只读。
   */
  reservedForT?: number;
}

/** 持仓批次实体（positionBatches 表）。记录每次开仓/加仓/减仓操作对成本与数量的影响。 */
export interface PositionBatchEntity extends BaseEntity {
  /** 所属持仓的主键 id */
  positionId: string;
  /** 批次类型：开仓 / 加仓 / 减仓 */
  type: 'open' | 'add' | 'reduce';
  /** 成交单价（元） */
  price: number;
  /** 成交数量（股） */
  amount: number;
  /** 该笔交易手续费（元） */
  fee: number;
  /** 本次操作后的加权成本（元） */
  costAfter: number;
  /** 本次操作后的持仓数量（股） */
  amountAfter: number;
  /** 成交时间戳（毫秒） */
  timestamp: number;
  /** 备注 */
  note?: string;
  /** 自动调整标识：borrow=倒T出借（借仓卖出），merge=倒T超额买回归并 */
  kind?: 'borrow' | 'merge';
  /** 该笔操作发生时的底仓成本价（元），仅借仓卖出时记录，用于显示成本对照 */
  costPrice?: number;
  /** 关联做T轮次 id：做T归档产生的批次用于回滚定位 */
  sourceRoundId?: string;
}

// ---- 费率模板名称 ----
/** 费率模板名称（原先定义在 store/types.ts，下沉至此供 feePresets 常量模块使用） */
export type FeePresetName = '默认A股' | 'A股标准模板' | 'ETF模板' | '港股/美股免佣模板';
