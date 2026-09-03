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

// ---- Copilot（Context-Aware AI 助手）----
/**
 * @description Copilot 前后端共享契约（scopeId 协议 + 请求/响应 DTO）。
 *              scopeId 格式：`页面标识[:股票代码]`（实体键统一且仅为股票代码，
 *              round/批次/订单不得作顶层实体键）；纯页面级保持单标识（如 statistics）。
 *              传输/存储分离（D28）：contextSummary 为 ephemeral 明细（阅后即焚，
 *              仅内存组装 Prompt 不落库）；contextOverview/timeAnchor 为落库标量概览。
 */

/** 页面标识常量表（与路由字符串解耦的 scopeId 协议，新增页面在此登记） */
export const COPILOT_SCOPES = [
  'statistics',
  'home',
  't_calculator',
  'cost_averaging',
  'sandbox',
  'change_rate',
  'fee_config',
  'webdav',
  'batch_import',
] as const;

/** Copilot 页面级 scope 标识 */
export type CopilotScopeId = (typeof COPILOT_SCOPES)[number];

/**
 * 组装 scopeId：实体级页面拼接股票代码（如 cost_averaging:600519），
 * 纯页面级返回单标识（如 statistics）。换股即换会话（旧会话后端归档不丢失）。
 */
export function composeScopeId(page: CopilotScopeId, entityCode?: string): string {
  return entityCode ? `${page}:${entityCode}` : page;
}

/** 时间截面标记（落库 time_anchor，JSON 字符串 ≤100 字符） */
export interface CopilotTimeAnchor {
  /** 快照采集时刻（epoch 秒） */
  asOf: number;
  /** 时间区间标记：all / 7d / 30d / month / today / now 等 */
  range: string;
}

/**
 * 快照上下文数据：builder 一次产出、两路分发（D28）。
 * - overview/timeAnchor → 落库（历史卡片回放）
 * - detail/units → ephemeral contextSummary（仅内存组装 Prompt）
 */
export interface CopilotContextData {
  /** 落库标量概览（仅 string/number/boolean，序列化后 ≤255 字符，严禁明细数组） */
  overview: Record<string, string | number | boolean>;
  /** 时间截面标记 */
  timeAnchor: CopilotTimeAnchor;
  /** ephemeral 明细（经 applySizeGuard ≤12KB 裁剪，不落库不打日志） */
  detail: Record<string, unknown>;
  /** 单位字典（歧义字段口径声明，如 元/小数比例/股） */
  units: Record<string, string>;
}

/** 区块级快照契约（V2 Click-to-Focus 预留，P0 不建 UI） */
export interface ContextBlockSnapshot {
  /** 区块标识（如 planned_orders） */
  blockId: string;
  title: string;
  getData: () => CopilotContextData;
}

/** 页面上下文快照（usePageContext 注册契约） */
export interface PageContextSnapshot {
  scopeId: string;
  title: string;
  /** 命令式快照：实现必须 getState() + 纯引擎重算，禁闭包捕获组件态 */
  getData: () => CopilotContextData;
  /** 区块级快照（V2 预留） */
  blocks?: ContextBlockSnapshot[];
}

/** Copilot 消息（前端内存态，映射后端 ai_chat_message 行） */
export interface CopilotMessage {
  /** 本地 id：user 行 = clientMessageId（ulid），assistant 行 = 后端消息 id 字符串 */
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'pending' | 'ok' | 'failed';
  /** 提问轮标量概览（仅 user 行，历史卡片回显） */
  contextOverview?: string;
  /** 时间截面标记（仅 user 行） */
  timeAnchor?: string;
  /** 幂等重发键（仅 user 行，ulid） */
  clientMessageId?: string;
  /** 创建时间（epoch 秒） */
  ctime: number;
  /** 失败时的用户可读提示（subCode 映射） */
  errorHint?: string;
  /** 是否可重发（UPSTREAM_ERROR / SESSION_NOT_FOUND 等，同 clientMessageId 幂等） */
  retryable?: boolean;
}

/** 提问请求（POST /api/copilot/threads/{scopeId}/messages，恒 200 信封） */
export interface CopilotAskRequest {
  question: string;
  sessionTitle: string;
  /** ulid，幂等重发键 */
  clientMessageId: string;
  /** ephemeral 明细 JSON 字符串（阅后即焚：不落库不打日志，仅内存组装 Prompt；
   *  线格式 = JSON.stringify({ data, _units, capturedAt, truncated })，后端 DTO 为 String） */
  contextSummary: string;
  /** 落库标量概览（JSON 字符串 ≤255 字符） */
  contextOverview: string;
  /** 落库时间截面标记（JSON 字符串） */
  timeAnchor: string;
}

/** 提问响应 data */
export interface CopilotAskResponse {
  assistantMessageId: number;
  content: string;
  promptTokens: number;
  completionTokens: number;
  channel: string;
  userMessageId: number;
  /** epoch 秒 */
  ctime: number;
}

/** 历史消息分页（GET /threads/{scopeId}/messages，keyset：id < before 的前 limit 条，倒序取出后正序返回） */
export interface CopilotThreadPage {
  sessionId: number;
  scopeId: string;
  title: string;
  messages: Array<{
    id: number;
    role: 'user' | 'assistant';
    content: string;
    contextOverview?: string;
    timeAnchor?: string;
    clientMessageId?: string;
    status?: 'ok' | 'failed' | 'pending';
    ctime: number;
  }>;
  hasMore: boolean;
  oldestId: number;
}
