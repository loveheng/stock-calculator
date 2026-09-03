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
  Position,
  PositionBatch,
  RoundTxn,
  TRoundArchive,
  LongTermRecord,
  PlannedOrder,
  PageContextSnapshot,
  CopilotMessage,
} from '../types/domain';

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

  // -- Copilot（AI 助手，P0） --
  /** 页面挂载时注册上下文快照（同 scopeId 覆盖幂等，并置为激活 scope） */
  registerContext: (snapshot: PageContextSnapshot) => void;
  /** 页面卸载注销：仅当 registry[scopeId] === owner（引用相等）才删，防路由竞态误删新页注册 */
  unregisterContext: (scopeId: string, owner: PageContextSnapshot) => void;
  /** 激活会话：墓碑对账 → 缓存优先（D8）→ 远端拉尾部 20 条 */
  ensureThreadLoaded: (scopeId: string) => Promise<void>;
  /** 提问：乐观更新 pending → ok/failed（sending 锁防并发重复提交） */
  sendMessage: (question: string) => Promise<void>;
  /** 重发失败消息：同 clientMessageId 幂等 + 最新 getData() 重采快照（D7） */
  retryMessage: (messageId: string) => Promise<void>;
  /** 清空当前激活会话（本地 + 远端软删除 + 失败落墓碑） */
  clearCurrentThread: () => Promise<void>;
  /** 级联清理指定 scope（实体删除钩子调用，空 scope 幂等返回） */
  purgeScopeOnEntityDelete: (scopeId: string) => Promise<void>;
  /** 全局浮窗展开/折叠 */
  setCopilotOpen: (open: boolean) => void;
  /** 首次使用知情同意（localStorage 持久化） */
  acknowledgeConsent: () => void;
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
}

/** 导出数据版本号，用于跨版本导入校验 */
export const EXPORT_VERSION = 1;
