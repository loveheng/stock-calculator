/**
 * @file types.ts
 * @description Store 层类型定义：AppStore / AppStoreActions 等状态容器契约 + 导入导出结构。
 *              领域数据契约（Position/PositionBatch/RoundTxn/TRoundArchive/LongTermRecord/
 *              PlannedOrder）已下沉至 src/types/domain.ts，本文件 re-export 保持兼容。
 *              包含做T记录、Round、中长期记录、现金流、导入导出等核心数据结构。
 *              v6.1 重构：统一类型系统 —— 所有类型不再与 db/index.ts 重复定义，
 *              db/index.ts 中的 Row 类型改用本文件中的类型别名；
 *              TRoundArchive 新增 lastUpdated 兼容字段（@deprecated）。
 *              v8.1 解耦：领域类型迁移至 types/domain.ts（叶子模块），消除循环依赖根因。
 * @layer Store (Types)
 * @author 开发团队
 */

import type { FeeConfig } from '../utils/mathUtils';
import type { StockMeta, StockSearchItem } from '../types/stock';
import type { TStreamRecord, StockStreamResult } from '../utils/tStreamEngine';
import type {
  CompositeResult,
  RunSearchInput,
  SearchScope,
  SearchStatus,
  SearchResultItem,
  StockProfile,
} from '../types/search';
import type {
  Position,
  PositionBatch,
  RoundTxn,
  TRoundArchive,
  LongTermRecord,
  PlannedOrder,
  PageContextSnapshot,
  CopilotMessage,
  CopilotAction,
  CopilotRunStatPayload,
  CustomStatDefinition,
  CustomStatsResult,
  HomeTimeRange,
} from '../types/domain';

/** 自定义统计草稿（内存态单槽位，刷新即失；attempt = 第 N 版） */
export interface CustomStatsDraft {
  code: string;
  name: string;
  description: string;
  /** 原始需求锚点（迭代协议组成部分，保存时随定义留存） */
  prompt: string;
  /** 重新生成来源（保存弹层「替换」选项依据；无来源 = 首次生成只可另存） */
  originDefId?: string;
  /** 第 N 版（每次 run_custom_stat 落草稿 +1） */
  attempt: number;
  lastResult?: CustomStatsResult;
  running: boolean;
  error?: string;
  /** 沙箱错误行号（「AI 修复」提示词携带） */
  errorLine?: number;
}

/**
 * 领域类型下沉：持仓/批次/Round/中长期记录/计划单等纯数据契约已迁移至
 * src/types/domain.ts（零依赖叶子模块），db / services / utils 层直接从那里导入，
 * 消除「下层反向依赖 store」造成的循环依赖。
 * 此处 re-export 保持 '../store'、'../store/types' 两条既有导入路径向后兼容。
 */
export type {
  Position,
  PositionBatch,
  RoundTxn,
  TRoundArchive,
  LongTermRecord,
  PlannedOrder,
} from '../types/domain';

/** 费率模板名称（定义已下沉 types/domain.ts 零依赖叶子，此处 re-export 兼容） */
export type { FeePresetName } from '../types/domain';

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

/** Copilot 待确认动作（confirm 级入队，用户在浮窗中执行/忽略后出队；不持久化，刷新即失） */
export interface PendingCopilotAction {
  /** 队列内唯一标识（自增序列） */
  id: string;
  /** 动作类型（已过白名单，具体业务语义见 copilotActionSlice 执行器注册表） */
  type: string;
  /** 卡片展示文案（入队时生成的人话摘要） */
  label: string;
  /** 动作参数（sanitize 阶段原样保留，执行器落地前按类型二次校验） */
  payload: Record<string, unknown>;
}

/** 提问附加选项：任务类型路由与临时上下文键（自定义统计生成/迭代复用 sendMessage 通道） */
export interface CopilotSendOptions {
  /** 'custom_stat' → 后端路由自定义统计生成模板（后端 docs/custom-stats-api.md §2.1） */
  taskType?: string;
  /** 追加进 contextSummary.detail 的临时键（如 sampleRows/draftContext），受 12KB 护栏约束 */
  extraDetail?: Record<string, unknown>;
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

  // -- 服务端密文同步（登录即备份，M3） --
  /**
   * 推送当前快照到服务端：exportData → serializeSnapshot → encryptText(mek) →
   * buildBackupEnvelope → pushBackup（baseVersion = lastSeenCloudVersion，CAS）。
   * 空快照守卫（D9）：非 force 一律跳过；409 冲突自动拉取合并重推一轮；
   * 42901 按 retryAfter 释放锁后重调度（E9，不计失败退避）；网络失败静默退避（§8.3）。
   */
  pushServerSnapshot: (opts?: { force?: boolean }) => Promise<void>;
  /** 从云端拉取密文 → 解密 → deserializeSnapshot → 智能合并进本地（不覆盖本地，isSyncingFromRemote 防回环） */
  restoreFromServer: () => Promise<void>;
  /** 冲突处理（§5.5）：merge-cloud = 云端合并进本地（云端暂不动）；overwrite-cloud = 合并后 force 重推 */
  resolveServerConflict: (mode: 'merge-cloud' | 'overwrite-cloud') => Promise<void>;
  /** 启动/前台对账（§7.3 决策树）+ visibilitychange/15min 对账监听注册（幂等） */
  startupServerSyncCheck: () => Promise<void>;
  /** 清除服务端同步错误提示（回退告警卡 [忽略]）；仅清 UI 态，不动云端与 lastSeen */
  dismissServerError: () => void;

  // -- Copilot（AI 助手，P0） --
  /** 页面挂载时注册上下文快照（同 scopeId 覆盖幂等，并置为激活 scope） */
  registerContext: (snapshot: PageContextSnapshot) => void;
  /** 页面卸载注销：仅当 registry[scopeId] === owner（引用相等）才删，防路由竞态误删新页注册 */
  unregisterContext: (scopeId: string, owner: PageContextSnapshot) => void;
  /** 聚焦区块（V2 Click-to-Focus）：校验区块已注册 → 展开浮窗并激活对应 scope；未注册静默忽略 */
  focusBlock: (scopeId: string, blockId: string) => void;
  /** 退出区块聚焦，回到整页上下文 */
  unfocusBlock: () => void;
  /** 激活会话：墓碑对账 → 缓存优先（D8）→ 远端拉尾部 20 条 */
  ensureThreadLoaded: (scopeId: string) => Promise<void>;
  /** 提问：乐观更新 pending → ok/failed（sending 锁防并发重复提交）。
   *  opts：任务类型路由（'custom_stat' → 自定义统计生成模板）与临时上下文键（sampleRows/draftContext） */
  sendMessage: (question: string, opts?: CopilotSendOptions) => Promise<void>;
  /** 重发失败消息：同 clientMessageId 幂等 + 最新 getData() 重采快照（D7） */
  retryMessage: (messageId: string) => Promise<void>;
  /** 中断进行中的流式提问（面板关闭/停止按钮触发；无进行中提问时空操作，幂等） */
  cancelCopilotStream: () => void;
  /** 清空当前激活会话（本地 + 远端软删除 + 失败落墓碑） */
  clearCurrentThread: () => Promise<void>;
  /** 级联清理指定 scope（实体删除钩子调用，空 scope 幂等返回） */
  purgeScopeOnEntityDelete: (scopeId: string) => Promise<void>;
  /** 全局浮窗展开/折叠 */
  setCopilotOpen: (open: boolean) => void;
  /** 首次使用知情同意（localStorage 持久化） */
  acknowledgeConsent: () => void;

  // -- Copilot 动作后处理（V1 Action Pipeline：LLM 返回 actions 的前端执行管线） --
  /** 响应动作入口：白名单过滤 → 分级路由（auto 立即执行 / confirm 入队等确认）；仅在响应返回时执行一次 */
  handleCopilotActions: (actions?: readonly CopilotAction[]) => void;
  /** 关闭全局提醒弹窗（notify 动作落地态） */
  dismissCopilotNotice: () => void;
  /** 直接落地一条全局提醒（跨切片复用弹窗槽位，如自定义统计草稿覆盖/保存轻提示） */
  setCopilotNotice: (payload: { title: string; message: string; severity: 'info' | 'warning' | 'danger' }) => void;
  /** 忽略待确认动作（出队） */
  dismissPendingCopilotAction: (id: string) => void;
  /** 执行待确认动作（按执行器注册表分发业务 action；未登记类型出队并忽略） */
  executePendingCopilotAction: (id: string) => void;

  // -- 首页仪表盘（视图偏好上提 Store：Copilot 区块快照需经 getState() 同源重算，R2） --
  /** 设置首页时间筛选维度（1d/7d/30d/all） */
  setHomeTimeRange: (range: HomeTimeRange) => void;

  // -- 自定义统计（AI 生成代码 + 端上沙箱执行，P0） --
  /** 执行 run_custom_stat 动作：守卫后的载荷 → 夹具预跑 → 全量执行 → 入草稿（单槽位覆盖语义） */
  startCustomStatDraft: (payload: CopilotRunStatPayload) => Promise<void>;
  /** 草稿迭代（D15 单码覆盖）：prompt 种子 + 当前 code + 本次反馈 → sendMessage(custom_stat) */
  iterateCustomStatDraft: (feedback: string) => Promise<void>;
  /** 丢弃草稿 */
  clearCustomStatDraft: () => void;
  /** 保存草稿（信任动作，唯一写路径）：另存新定义 / 替换原定义（钉选迁移，需 originDefId） */
  saveCustomStatDraft: (option: 'new' | 'replace', overrides?: { name?: string; description?: string }) => Promise<void>;
  /** 钉选/取消钉选（画廊双区） */
  toggleCustomStatPin: (id: string, pinned: boolean) => Promise<void>;
  /** 收藏/取消收藏 */
  toggleCustomStatFavorite: (id: string, favorite: boolean) => Promise<void>;
  /** 软删除定义 */
  deleteCustomStatDef: (id: string) => Promise<void>;
  /** 服务端同步（登录即备份）：拉取 LWW 合并 + 推送本地较新定义 + 传播墓碑删除；未登录静默跳过 */
  syncCustomStatsFromServer: () => Promise<{ pulled: number; pushed: number; deleted: number }>;
  /** 加载画廊元数据（进入 custom tab 时调用，幂等） */
  loadCustomStatsGallery: () => Promise<void>;
  /** 批量刷新已加载条目（SWR）：1× ctx 注入 + N× 执行，分批让出（单批 ≤6） */
  refreshLoadedCustomStats: () => Promise<void>;
  /** 运行单个定义（画廊卡「运行」/手动刷新） */
  runCustomStatDef: (id: string) => Promise<void>;
  /** 重新生成：复用存储 prompt 种子发起 custom_stat 提问，新草稿携带 originDefId（另存/替换双选项） */
  regenerateCustomStatDef: (id: string, extraRequest?: string) => Promise<void>;
  /** 查看画廊后清除 NEW 角标基准（localStorage 持久化） */
  markCustomStatsSeen: () => void;
  /** 组装 custom_stat 提问样例上下文（字段字典 + 每集合 ≤3 行真实形状样例；仅进 prompt 不落库） */
  buildCustomStatPromptContext: () => Promise<Record<string, unknown>>;

  // -- 公告订阅 --
  /** 拉取当前用户公告订阅列表（幂等：成功后标记已加载，重复调用直接跳过；未登录静默跳过） */
  loadAnnouncementSubscriptions: () => Promise<void>;
  /** 订阅公告摘要（乐观更新，失败回滚）；message 为后端/本地用户可读文案 */
  subscribeAnnouncement: (stockId: string) => Promise<{ ok: boolean; message?: string }>;
  /** 取消订阅公告摘要（乐观更新，失败回滚） */
  unsubscribeAnnouncement: (stockId: string) => Promise<{ ok: boolean; message?: string }>;

  // -- 资讯搜索 --
  /** 执行资讯检索：形态检测（6 位码/名称消歧）→ 档案卡装载（400 降级，A10）→
   *  按 scope 调对应端点；announcement 范围自动注入未平仓持仓代码（去重 ≤50，
   *  为空短路引导空态），股票形态覆盖为单票硬过滤；seq 竞态守卫内置 */
  runSearch: (input: RunSearchInput) => Promise<void>;
  /** 重置搜索页状态回初始态（进行中的检索/流式请求一并作废；spec §4.2 刷新即回初始态） */
  resetSearch: () => void;
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

  // -- 服务端密文同步（登录即备份，M3） --
  /** 服务端推送进行中（UI 态镜像；跨标签页并发互斥由 services/serverSync 管线承担） */
  serverSyncing: boolean;
  /** 本设备最后确认的云端版本（lastSeenCloudVersion 镜像，UI 显示；null = 尚未对账/云端为空） */
  serverLastVersion: number | null;
  /** 服务端同步错误提示（冲突未解决/回退告警/拉取失败；null = 无；网络失败静默不置位） */
  serverLastError: string | null;

  // -- 公告订阅（服务端为准，本地镜像） --
  /** 已订阅的股票代码（归一化 6 位数字码，如 '600745'）；服务端订阅列表的本地镜像 */
  subscribedStockIds: string[];
  /** 订阅列表是否已完成首次拉取（防重复加载） */
  announcementSubsLoaded: boolean;
  /** 订阅列表拉取进行中（防并发重复请求） */
  announcementSubsLoading: boolean;

  // -- 资讯搜索（内存态：检索历史不持久化，刷新即回初始态） --
  /** 最近一次查询关键词（驱动 Copilot scope getData 与结果头展示） */
  searchQuery: string;
  /** 最近一次执行的检索范围（视图表单态另存 useState，切换不自动重搜） */
  searchScope: SearchScope;
  /** 页面状态机：idle | loading | succeeded | failed | generating（综合摘要流式专用） */
  searchStatus: SearchStatus;
  /** 结果列表（判别联合，按 scope 装载公告/CLS 命中；composite 时为空） */
  searchResults: SearchResultItem[];
  /** AI 综合摘要（scope=composite 时装载；meta 引用先上屏 + delta 渐进拼接） */
  compositeResult: CompositeResult | null;
  /** 股票档案卡（形态检测命中具体股票时装载；null = 关键词形态/A10 降级） */
  stockProfile: StockProfile | null;
  /** 失败文案（信封 message 直出或网络异常文案；空持仓引导文案同源） */
  searchError: string | null;
  /** 结果计数（列表头「匹配到 N 条」；composite 时 = 引用数） */
  searchTotal: number;
  /** 限流倒计时秒数（信封 429 data.retryAfterSeconds；null = 非限流错误/缺省） */
  retryAfterSeconds: number | null;

  // -- Copilot（AI 助手，P0：mock 全链路） --
  /** 页面上下文注册表（scopeId → 快照，同 scopeId 覆盖幂等） */
  registry: Record<string, PageContextSnapshot>;
  /** 各会话内存缓存（每会话仅尾部 20 条，切换 scope 整段替换） */
  threads: Record<string, CopilotMessage[]>;
  /** 提问互斥锁（防并发提问与重复提交） */
  sending: boolean;
  /** 当前激活 scope（最近一次 registerContext 的页面；离开已注册页置 null） */
  activeScopeId: string | null;
  /** 切页归档提示：离开的 scope 存在会话时记录，浮窗展示「上一页对话已归档」 */
  lastArchived: { scopeId: string; title: string } | null;
  /** 离线级联删除墓碑（localStorage 持久化，ensureThreadLoaded 时对账补发 DELETE） */
  deletedScopes: string[];
  /** 首次使用知情同意（localStorage 持久化） */
  consentAcknowledged: boolean;
  /** 全局浮窗展开态 */
  copilotOpen: boolean;
  /** 区块聚焦态（V2 Click-to-Focus）：null = 整页上下文；聚焦后提问/重发取区块快照 */
  focusedBlock: { scopeId: string; blockId: string } | null;

  // -- Copilot 动作后处理（V1 Action Pipeline） --
  /** AI 动作强制提醒（notify 落地态，全局弹窗读取；null = 无；后到覆盖先到） */
  copilotNotice: { title: string; message: string; severity: 'info' | 'warning' | 'danger' } | null;
  /** 待确认动作队列（confirm 级，仅内存态，用户执行/忽略后出队） */
  pendingCopilotActions: PendingCopilotAction[];

  // -- 事实数据变动提示（P0 时间隔离配套 UX） --
  /** 各 scope 上次提问时快照概览相对上上轮是否变化（提问时由 copilotSlice 重算；
   *  true = 浮窗展示「数据自上轮已更新」提示条；清会话时随删） */
  contextChangedScopes: Record<string, boolean>;

  // -- 首页仪表盘（视图偏好） --
  /** 首页时间筛选维度（自 Home useState 上提；V2 区块级快照同源读取，R2） */
  homeTimeRange: HomeTimeRange;

  // -- 自定义统计（AI 生成代码 + 端上沙箱执行，P0） --
  /** 草稿单槽位（内存态，刷新即失；新生成自动覆盖 + toast，FR3） */
  customStatDraft: CustomStatsDraft | null;
  /** 画廊元数据（含 lastResult 缓存；进入 custom tab 一次轻量读入，UI 切片分页） */
  customStatsGallery: CustomStatDefinition[];
  /** 批量刷新进行中（gallery 手动刷新/打开页面后台刷新共用） */
  customStatsRefreshing: boolean;
  /** 服务端同步进行中（打开 custom tab / 保存/删除后触发，失败静默降级为本地态） */
  customStatsSyncing: boolean;
  /** NEW 角标基准（pinnedAt > lastSeenAt 高亮；localStorage 持久化） */
  customStatsLastSeenAt: string;
}

/** 导出数据版本号，用于跨版本导入校验 */
export const EXPORT_VERSION = 1;
