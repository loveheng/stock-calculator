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

/** 做T Round 的行级视图模型 = TRoundArchive（单一定义；db 桶 re-export 保持兼容，非 db 模块一律从此处导入） */
export type TRoundRow = TRoundArchive;

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

// ---- 自由画布（Free Canvas）----
/** K 线区块趋势线段：起终点时间戳必须强等于 kline 序列中真实存在的交易日（YYYY-MM-DD） */
export interface TrendLine {
  id: string;
  startTime: string;
  startPrice: number;
  endTime: string;
  endPrice: number;
}

/** K 线区块关键水平线（createPriceLine，带语义标签） */
export interface HLine {
  id: string;
  price: number;
  label: string;
}

/** 区块备注：manual 用户手写（可编辑）| ai AI 生成（只读可删） */
export interface BlockNote {
  id: string;
  source: 'manual' | 'ai';
  content: string;
  createdAt: string;
}

/** 表格模板列定义 */
export interface CanvasTableColumn {
  key: string;
  title: string;
}

/** 简单图表数据点 */
export interface CanvasChartPoint {
  label: string;
  value: number;
}

/** 区块数据多态（按 type 收窄） */
export interface CanvasBlockData {
  kline: {
    fullCode: string;
    stockName: string;
    trendLines: TrendLine[];
    hLines: HLine[];
    maVisible: boolean;
  };
  table: {
    columns: CanvasTableColumn[];
    rows: Record<string, string>[];
  };
  file: {
    fileName: string;
    fileType: string;
    /** canvasBlobs 表引用 id */
    dataRef?: string;
  };
  chart: {
    seriesType: 'line' | 'bar';
    points: CanvasChartPoint[];
    /** 绑定的 K 线区块标号（自动取收盘价序列） */
    sourceBlockId?: string;
  };
  metric: {
    label: string;
    /** 手动固定值 */
    value?: number;
    /** 绑定区块取值 */
    sourceBlockId?: string;
    /** 取值路径（如 latestClose / rangeChange） */
    sourcePath?: string;
    /** 常量四则运算表达式（递归下降解析，禁 eval） */
    calc?: string;
    /** agent 指标（compute 端点结果，算完即弃写回本地）：value 取序列最后一个非 null 槽位 */
    agent?: {
      /** 指标计算名（能力端点白名单内） */
      indicator: string;
      /** 展示名 */
      label: string;
      /** 来源 K 线区块（切片出处） */
      sourceBlockId: string;
      /** 结果值（暖机期全 null 时为 null → 显示占位） */
      value: number | null;
      /** 计算失败标记（429/5xx/超时 → 「agent 指标暂不可用」占位） */
      unavailable?: boolean;
    };
  };
  image: {
    /** canvasBlobs 表引用 id */
    imageRef?: string;
  };
  text: {
    content: string;
  };
  widget: {
    /** DSL 声明式图纸（utils/widgetDsl.validateWidgetDsl 校验后的合法形态） */
    dsl: WidgetDsl;
  };
}

// ---- 画布 DSL 动态模板（widget 区块；docs/free-canvas-template-registry.md「DSL 动态模板」节）----
// 安全原则：LLM 只输出受 schema 约束的 JSON 图纸，前端封闭白名单渲染，全链路零代码传输。

/** 语气标记（决定配色） */
export type WidgetTone = 'info' | 'warn' | 'danger';

/** DSL 叶子组件白名单（8 种；容器 2 种 stack/grid，均不含可执行语义） */
export type WidgetNodeKind =
  | 'text'
  | 'metric'
  | 'kv'
  | 'list'
  | 'table'
  | 'progress'
  | 'tag'
  | 'divider';

/** DSL 节点（叶子）：c = 组件种类，其余字段按种类收窄（形状校验在 utils/widgetDsl） */
export interface WidgetNode {
  c: WidgetNodeKind;
  text?: { content: string; tone?: WidgetTone };
  metric?: { label: string; value: string; tone?: WidgetTone };
  kv?: { rows: { label: string; value: string }[] };
  list?: { title?: string; items: { text: string; tone?: WidgetTone }[] };
  table?: { columns: string[]; rows: string[][] };
  progress?: { label: string; value: number };
  tag?: { tags: string[] };
}

/** widget 区块图纸：单层容器 + 叶子节点（不允许嵌套容器） */
export interface WidgetDsl {
  kind: 'stack' | 'grid';
  title: string;
  nodes: WidgetNode[];
}

// ---- 预告单（Advance Notice；views/AdvanceNotice + services/advanceNoticeService）----

/** 预告单理由标签：固定枚举（结构化检索）+ reasonNote 自由文本补充 */
export type ReasonTag = '业绩' | '政策' | '技术面' | '消息面' | '基本面' | '其他';

/**
 * 交易预告单：选股关注记录（区别于 plannedOrders 的执行意图——预告单是"待决策"备忘）。
 * status.active/expired 中 expired 读取时按 expiresAt 派生，不落库（对齐 plannedOrders 纪律）。
 */
export interface AdvanceNotice {
  id: string;
  /** 股票完整代码（腾讯形态 sh600519） */
  fullCode: string;
  stockName: string;
  reasonTag: ReasonTag;
  /** 自由文本补充理由（≤200 字） */
  reasonNote?: string;
  /** 来源画布 id（一期只记不展开；P2 快照联动预留） */
  sourceBoardId?: string;
  /** active | cancelled（expired 为读取派生态，不写入） */
  status: 'active' | 'cancelled';
  /** 到期时间（ISO）；派生 expired */
  expiresAt: string;
  /** 有效期天数（1 | 3 | 7 | 14 | 30；续期 = 当前时间 + validityDays 重算） */
  validityDays: number;
}

/** 画布区块类型 */
export type CanvasBlockType = keyof CanvasBlockData;

/** 画布区块：标号（A1/B2）为画布内唯一稳定句柄，删除后不复用 */
export interface CanvasBlock {
  blockId: string;
  type: CanvasBlockType;
  /** react-grid-layout 网格位置尺寸 */
  layout: { x: number; y: number; w: number; h: number };
  data: CanvasBlockData[CanvasBlockType];
  notes: BlockNote[];
}

/** 画布实体（canvasBoards 表，行级契约；一期单画布 isDefault=true，模型支持多画布） */
export interface CanvasBoardEntity {
  id: string;
  title: string;
  blocks: CanvasBlock[];
  isDefault: boolean;
  /** 标号分配单调计数器（列优先协议；删除不复用的保证——与现存区块无关，只增不减） */
  labelSeq?: number;
  createdAt: string;
  updatedAt: string;
  isDeleted?: boolean;
}

/** 画布 Blob 存储实体（canvasBlobs 表，行级契约）：图片/文件二进制，区块 data 仅存引用 id */
export interface CanvasBlobEntity {
  id: string;
  mime: string;
  data: Blob;
  createdAt: string;
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

/**
 * 中间表实体（positionAdjustments 表）：命令登记簿 + 占用视图 + 物化快照三职责合一。
 * 中长线侧独占维护，做T侧只经端口读。
 * @see docs/position-ledger-spec.md §1.4
 */
export interface PositionAdjustmentEntity extends BaseEntity {
  /** 命令 id = `${roundId}-${seq}` */
  id: string;
  /** 关联做T轮次 */
  roundId: string;
  /** 序号（0 起）：同一 round 内命令全序 */
  seq: number;
  /** 命令种类 */
  kind: 'borrow' | 'return-borrow' | 'finalize-sell' | 'merge-buy';
  /** 股票完整代码 */
  fullCode: string;
  /** 数量 */
  qty: number;
  /** 参考成交价 */
  price?: number;
  /** 归档落定命令产生的真实批次 id（回滚时按此精确删除批次） */
  batchId?: string;
  /** 在途占用 / 已归档落定 */
  status: 'in-flight' | 'settled';
  /** 应用时间戳 */
  appliedAt: number;
}

/**
 * 底仓变动痕迹实体（positionEvents 表）：append-only 事件流。
 * 凡动底仓必记（出借/归还/落定/回滚/手工），删除战报追加 rollback 事件。
 * 可推导事件（borrow/return/finalize-sell/merge-buy）可从流水重推导，
 * 但**不参与重放重建**；不可推导事件（rollback/manual-add/manual-reduce）是独立事实记录。
 * @see docs/position-ledger-spec.md §1.5
 */
export interface PositionEventEntity extends BaseEntity {
  /** 全局唯一 ID */
  id: string;
  /** 股票完整代码 */
  fullCode: string;
  /** 做T驱动时关联轮次 */
  roundId?: string;
  /** 事件类型 */
  eventType: 'borrow' | 'return' | 'finalize-sell' | 'merge-buy' | 'manual-add' | 'manual-reduce' | 'rollback';
  /** 数量 */
  qty: number;
  /** 参考价格 */
  price?: number;
  /** 手续费 */
  fee?: number;
  /** 真实批次 id（若有） */
  batchId?: string;
  /** 事件发生时间戳 */
  timestamp: number;
  /** 备注 */
  note?: string;
}

// ---- 费率模板名称 ----
/** 费率模板名称（原先定义在 store/types.ts，下沉至此供 feePresets 常量模块使用） */
export type FeePresetName = '默认A股' | 'A股标准模板' | 'ETF模板' | '港股/美股免佣模板';

/** 首页仪表盘时间筛选维度（Store 态：视图 Tab 与 Copilot 区块快照同源读取，R2 合规） */
export type HomeTimeRange = '1d' | '7d' | '30d' | 'all';

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

/** 区块级快照契约（V2 Click-to-Focus：卡片级聚焦上下文） */
export interface ContextBlockSnapshot {
  /** 区块标识（全局唯一，scopeId 前缀 + 区块名，如 home:short_term） */
  blockId: string;
  /** 胶囊展示名（可随视图筛选态热更新，如 "首页 · 短线统计 (近7天)"） */
  title: string;
  /** 推荐提问气泡（Prompt Starters，2~3 个，聚焦态渲染于输入框上方） */
  suggestedPrompts?: string[];
  /** 命令式快照：实现必须 getState() + 纯引擎重算，禁闭包捕获组件态 */
  getData: () => CopilotContextData;
}

/**
 * 聊天快捷按钮（页面上下文注册，GlobalCopilot 输入框上方常驻渲染）：
 * 三模式分流——draft 填草稿（用户可改后发送）；send 直接走 sendMessage 管线（confirm 动作照常出确认卡）；
 * local 本地拦截直执行（纯前端操作不经 AI，如建区块/刷新行情，handler 由注册页提供）。
 */
export interface CopilotQuickAction {
  /** 按钮文案（≤12 字，胶囊 chip） */
  label: string;
  /** draft/send 模式的 prompt 话术（local 模式忽略） */
  prompt?: string;
  /** 执行模式，默认 draft */
  mode?: 'draft' | 'send' | 'local';
  /** local 模式的本地执行器（纯前端操作，结果经 app-toast 反馈） */
  handler?: () => void;
}

/** 页面上下文快照（usePageContext 注册契约） */
export interface PageContextSnapshot {
  scopeId: string;
  title: string;
  /** 命令式快照：实现必须 getState() + 纯引擎重算，禁闭包捕获组件态 */
  getData: () => CopilotContextData;
  /** 快捷按钮条（可选；页面注册时自带，GlobalCopilot 输入框上方常驻渲染） */
  quickActions?: CopilotQuickAction[];
  /** 区块级快照（V2 预留） */
  blocks?: ContextBlockSnapshot[];
}

/** Copilot 消息（前端内存态，映射后端 ai_chat_message 行） */
export interface CopilotMessage {
  /** 本地 id：user 行 = clientMessageId（ulid），assistant 行 = 后端消息 id 字符串，system 卡片 = card-前缀 */
  id: string;
  /** system = 受限取数数据卡片（本地拦截产线，不上报服务端、刷新即失；见 docs/free-canvas-template-registry.md §三） */
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** 生命周期：pending 排队/等待首块 → streaming 流式接收中（增量渲染）→ ok/failed 终态 */
  status: 'pending' | 'streaming' | 'ok' | 'failed';
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
  /** 聚焦区块标识（V2 Click-to-Focus，缺省=整页口径）：后端据此路由区块级 Prompt 策略
   *  （如 home:short_term → 做T风控顾问），未命中回落 scopeId 页面级策略；仅参与编排不落库 */
  focusBlockId?: string;
  /** 任务类型（可选；缺省 = 现有聊天模板，行为零变化）。
   *  'custom_stat' = 自定义统计生成/迭代模板（后端 docs/custom-stats-api.md §2.1） */
  taskType?: string;
  /** 画布能力提示（可选，copilot-spec D33；仅 canvas scope 携带）：前端常量承载
   *  canvas_add_widget 图纸 schema 用法说明（utils/canvasWidgetPrompt），ephemeral 随请求
   *  每轮上行不落库不打日志；后端按不可信输入处理（≤8KB 截断）原样拼接进系统提示固定区段 */
  promptHints?: string;
}

/**
 * AI 建议动作信封（V0 预留，暂无生产者/消费者）：仅固定「信封」结构，
 * 具体动作语义待第一个真实场景落地时固化为可辨识联合（discriminated union）扩展。
 * 刻意不预枚举 type 取值、不定义执行分发器（YAGNI）；严禁演进为空接口/纯 any。
 * 预期动作类别：建议操作（chips）、数据请求（反向取数）、客户端动作（跳转/筛选/下单）。
 */
export interface CopilotAction {
  /** 动作类型标识（如 navigate / apply_filter / data_request / create_order，当前仅为注释示例非类型约束） */
  type: string;
  /** 动作参数，schema 由各 type 自行定义 */
  payload?: Record<string, unknown>;
}

// ---- Copilot 已注册动作载荷（V1 Action Pipeline）----
// 新增动作三步：① 此处加载荷类型；② utils/copilotActions.ts 加形状守卫 + 分级；
// ③ store/slices/copilotActionSlice.ts 执行器登记（auto 级）或确认卡落地（confirm 级）。

/** notify：全局强制提醒弹窗（auto 级：仅 UI 效果，无数据写） */
export interface CopilotNotifyPayload {
  title: string;
  message: string;
  severity?: 'info' | 'warning' | 'danger';
}

/** focus_block：聚焦指定页面区块（auto 级：复用 focusBlock，未注册静默忽略） */
export interface CopilotFocusBlockPayload {
  scopeId: string;
  blockId: string;
}

/** apply_filter：设置视图筛选（auto 级：白名单键值，当前仅首页时间维度） */
export interface CopilotApplyFilterPayload {
  filter: 'homeTimeRange';
  value: HomeTimeRange;
}

/** run_custom_stat：AI 生成统计代码载荷（auto 级：沙箱只读计算 + 本地渲染，无业务副作用） */
export interface CopilotRunStatPayload {
  /** 统计名（结果面板标题 / 保存默认名） */
  name: string;
  /** 口径说明（结果面板必展示） */
  description: string;
  /** 规范化需求种子（≤2KB），随定义存储，删除时可复制保全、重新生成时复用 */
  prompt: string;
  /** 统计代码（≤16KB）：完整箭头函数表达式 (ctx) => CustomStatsResult */
  code: string;
}

/** annotate_block：AI 给画布区块写备注（confirm 级：写入用户内容必须确认；执行最后一刻校验区块存活） */
export interface CopilotAnnotateBlockPayload {
  /** 画布区块标号（如 A1）；存活校验在 canvasSlice.runBlockTask 执行时刻兜底 */
  blockId: string;
  /** 备注内容（≤200 字，守卫裁剪） */
  content: string;
}

/** canvas_add_block：AI 新建画布区块（auto 级：只新增不覆盖；K线带 stockCode 时直接绑定标的） */
export interface CopilotCanvasAddBlockPayload {
  /** 区块类型（七类之一） */
  type: CanvasBlockType;
  /** K线区块可直接绑定标的（腾讯形态 sh600519）；其他类型忽略 */
  stockCode?: string;
  /** text 区块的初始内容（≤500 字）；其他类型忽略 */
  content?: string;
}

/** canvas_set_stock：AI 给 K 线区块换股（confirm 级：覆盖用户已选标的） */
export interface CopilotCanvasSetStockPayload {
  blockId: string;
  /** 腾讯形态代码（sh600519） */
  fullCode: string;
  /** 股票名（可选，缺省守卫不填） */
  stockName?: string;
}

/** canvas_update_text：AI 覆写文本区块内容（confirm 级：覆盖用户内容） */
export interface CopilotCanvasUpdateTextPayload {
  blockId: string;
  /** 新文本（≤500 字） */
  content: string;
}

/** canvas_set_metric：AI 设置单指标区块（confirm 级：label+value 或常量四则 calc，二选一） */
export interface CopilotCanvasSetMetricPayload {
  blockId: string;
  /** 指标标签（≤40 字） */
  label: string;
  /** 手动固定值（与 calc 二选一，优先 value） */
  value?: number;
  /** 常量四则表达式（如 "(12.5+3)*2"，禁脚本） */
  calc?: string;
}

/** canvas_update_table：AI 写表格区块（confirm 级：整表覆写，守卫限 10 列 50 行） */
export interface CopilotCanvasUpdateTablePayload {
  blockId: string;
  /** 列定义（key 唯一） */
  columns: { key: string; title: string }[];
  /** 行数据（键与 columns.key 对齐，缺失格为空串） */
  rows: Record<string, string>[];
}

/** canvas_add_hline：AI 给 K 线区块加水平线（confirm 级：写划线数据） */
export interface CopilotCanvasAddHLinePayload {
  blockId: string;
  /** 价格轴位置 */
  price: number;
  /** 标签（≤40 字，缺省取价格） */
  label?: string;
}

/** canvas_add_trendline：AI 给 K 线区块加两点趋势线段（confirm 级：交易日吸附在执行时兜底） */
export interface CopilotCanvasAddTrendlinePayload {
  blockId: string;
  /** 起点交易日（YYYY-MM-DD）+ 价格 */
  startTime: string;
  startPrice: number;
  /** 终点交易日（YYYY-MM-DD）+ 价格 */
  endTime: string;
  endPrice: number;
}

/** canvas_remove_block：AI 删除画布区块（confirm 级：破坏性，执行最后一刻存活校验） */
export interface CopilotCanvasRemoveBlockPayload {
  blockId: string;
}

/** canvas_refresh_klines：AI 请求刷新画布全部 K 线行情（auto 级：只读行情刷新，无业务写） */
export interface CopilotCanvasRefreshPayload {
  /** 无参数载荷（占位，保持载荷对象统一形状） */
  _none?: never;
}

/**
 * canvas_add_widget：AI 新建 DSL 动态面板区块（auto 级：只读数据可视化，只新增不覆盖）。
 * dsl 为 utils/widgetDsl.validateWidgetDsl 校验通过的规范化图纸（扁平单层、8 组件白名单）。
 * 无 update 动作（拍板：改 = 删旧 canvas_remove_block + 加新 canvas_add_widget）。
 */
export interface CopilotCanvasAddWidgetPayload {
  /** 校验后的 DSL 图纸（守卫整形，非 LLM 原始 JSON） */
  dsl: WidgetDsl;
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
  /** AI 建议动作（V0 预留，可选缺省）：前端当前不消费不渲染；后端未升级前缺省即向前兼容。
   *  不落库（历史回看重载后不含），与 contextSummary 同属「在线在场态」语义，
   *  持久化与否留待动作真实启用时决策 */
  actions?: readonly CopilotAction[];
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

// ---- 自定义统计（AI 生成代码 + 端上沙箱执行）----
/**
 * @description 自定义统计执行契约与存储实体（schemaVersion 演进，Runner / Guard / 生成代码共同遵守）。
 *              结果为 XOR 判别联合：一次生成 = 一个标题卡 或 一个统计图表（P0 无表格）。
 *              金额单位：元；rate 类为 0-1 小数；沙箱内无宿主时钟，一切「今天/本月」以 ctx.now 为基准。
 */

/** 契约版本：Runner 执行前校验定义.schemaVersion 与此值一致，不一致走「AI 修复」而非静默失败 */
export const CUSTOM_STAT_SCHEMA_VERSION = 1;

/** 标题卡的 KPI 项（tone 色彩由宿主统一映射：红涨绿跌，good=红） */
export interface CustomStatKpi {
  label: string;
  value: string;
  tone?: 'default' | 'good' | 'bad';
}

/** 标题卡统计（kpis ≤3，Guard 截断） */
export interface CustomStatCard {
  kind: 'card';
  title: string;
  /** 口径说明 */
  caption?: string;
  kpis: CustomStatKpi[];
}

/** 图表数据点（bar 排行降序 / line 趋势升序 / pie 占比，上限由 Guard 强制） */
export interface CustomStatChartPoint {
  label: string;
  value: number;
}

export type CustomStatChart =
  | { type: 'bar'; data: CustomStatChartPoint[] }
  | { type: 'line'; data: CustomStatChartPoint[] }
  | { type: 'pie'; data: CustomStatChartPoint[] };

/** 图表统计（单图，XOR：与 CustomStatCard 二选一） */
export interface CustomStatChartResult {
  kind: 'chart';
  title: string;
  caption?: string;
  chart: CustomStatChart;
}

/** 沙箱执行结果（Guard 归一化后的唯一合法形状） */
export type CustomStatsResult = CustomStatCard | CustomStatChartResult;

/** ctx.feeConfig 的结构子集（domain 零依赖，不 import utils/mathUtils；净额复算用） */
export interface CustomStatFeeConfig {
  commissionRate: number;
  isFreeFive: boolean;
  minCommission: number;
  transferRate: number;
  stampRate: number;
}

/**
 * ctx.txns 行类型：tTransactions 全量（timestamp 升序）。在 RoundTxn 基础上收紧关联字段——
 * 行级实体 tTransactions 必带 roundId/fullCode/stockName，统计按天/按股分组依赖它们。
 */
export interface CustomStatTxn extends RoundTxn {
  /** 所属轮次 id（关联 rounds[].id） */
  roundId: string;
  fullCode: string;
  stockName: string;
}

/** ctx.activeStreams 的序列化安全子集（service 组装时从 StockStreamResult 裁剪映射） */
export interface CustomStatStream {
  fullCode: string;
  stockName: string;
  status: 'PENDING' | 'PARTIAL' | 'CLEARED' | 'SHORT_PENDING';
  /** 净持仓敞口（元） */
  netPendingAmount: number;
  /** 加权买入成本（元/股） */
  weightedBuyCost: number;
  /** 已实现盈亏（元） */
  realizedPnL: number;
}

/** 宿主注入沙箱的纯函数工具（QuickJS 内无 decimal.js，金额口径靠这里对齐 mathUtils） */
export interface CustomStatHelpers {
  /** 四舍五入保留 2 位（规费/金额展示口径） */
  round2(n: number): number;
  /** 占比（part/total），除零安全返回 0，结果为 0-1 小数 */
  pct(part: number, total: number): number;
  /** 按键分组 */
  groupBy<T>(xs: T[], f: (x: T) => string): Record<string, T[]>;
  /** 求和 */
  sumBy<T>(xs: T[], f: (x: T) => number): number;
  /** 千分位 + 2 位小数 + 负号 */
  fmtMoney(n: number): string;
}

/** 自定义统计执行契约（全量数据仅在端上沙箱注入，不出设备、不进 LLM prompt） */
export interface CustomStatsContext {
  schemaVersion: number;
  /** 宿主注入时间锚点（ISO）。沙箱内无 Date.now，保证可复现可测试 */
  now: string;
  /** 已归档轮（COMPLETED 全量标量） */
  rounds: TRoundArchive[];
  /** 进行中轮（OPENED） */
  openRounds: TRoundArchive[];
  /** 逐笔做T流水（tTransactions 全量，timestamp 升序）——按天/星期统计的原料 */
  txns: CustomStatTxn[];
  /** 持仓全量（含已平仓） */
  positions: Position[];
  /** 进行中轮撮合结果（tStreamEngine 管线重算，与统计页同口径） */
  activeStreams: CustomStatStream[];
  /** 费率配置（净额口径用） */
  feeConfig: CustomStatFeeConfig;
  /** 宿主注入纯函数工具（Worker 内 eval HELPERS_SOURCE 后挂载，不出现在线格式） */
  helpers: CustomStatHelpers;
}

/** 沙箱执行前注入的上下文（helpers 由 Worker 内挂载，不序列化） */
export type CustomStatsContextWire = Omit<CustomStatsContext, 'helpers'>;

/**
 * 统计定义（custom_stats 表，权威定义；db/schema.ts re-export）。
 * 不可变约束：保存后不提供 updateCode，修改只走「重新生成」（另存或替换+钉选迁移）。
 */
export interface CustomStatDefinition {
  id: string;
  name: string;
  description?: string;
  /** 生成时的需求种子快照（删除时可复制保全，重新生成时复用） */
  prompt?: string;
  code: string;
  /** 运行前与 CUSTOM_STAT_SCHEMA_VERSION 校验 */
  schemaVersion: number;
  /** 冗余 lastResult.kind：画廊分区与列表渲染直读，保存时写入 */
  kind: 'card' | 'chart';
  /** stale-while-revalidate 缓存：先秒显缓存，后台刷新原位替换 */
  lastResult?: CustomStatsResult;
  /** 最近一次成功执行时间（ISO），「截至 HH:mm」角标 */
  lastRunAt?: string;
  favorite?: boolean;
  /** 画廊双区钉选（区由 kind 推导），区内按 pinnedAt 倒序 */
  pinned?: boolean;
  pinnedAt?: string;
  runCount?: number;
  /** 溯源：来自哪条 AI 会话消息 */
  originMessageId?: string;
  createdAt: string;
  updatedAt: string;
  /** 软删，与全库惯例对齐，为 P1 同步铺路 */
  isDeleted?: 0 | 1;
}
