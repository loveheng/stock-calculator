/**
 * @file schema.ts
 * @description 定义 TradingLedgerDB_v3 的全部 IndexedDB 实体类型（Entity）与 Dexie 数据库表结构，是整个应用数据持久化的类型基石。
 * @layer DAO
 * @storage_impact 声明 stocks / positions / positionBatches / tRounds / tTransactions / accountCash / cashFlows / tradeNotes / feeConfigs / longTermRecords 共 10 张表的实体结构，并导出 Dexie 实例 db。
 * @author 开发团队
 */

import Dexie, { type Table } from 'dexie';

/**
 * 所有持久化实体的公共基础字段。
 *
 * @description 提供全局统一的主键与审计时间戳；`isDeleted` 采用软删除标记（0=正常，1=已删除），物理删除前均以此字段过滤。
 */
export interface BaseEntity {
  /** 全局唯一主键，字符串 UUID */
  id: string;
  /** 创建时间戳（毫秒） */
  createdAt: number;
  /** 最近更新时间戳（毫秒），写入/更新记录时必须同步维护 */
  updatedAt: number;
  /** 软删除标记：0 = 正常，1 = 已软删除。查询时应过滤 `(isDeleted ?? 0) === 0` */
  isDeleted?: number; // 0 = normal, 1 = soft-deleted
}

/** 股票基础信息实体（stocks 表）。`fullCode` 为唯一业务主键，关联持仓与做T记录。 */
export interface StockEntity extends BaseEntity {
  /** 完整证券代码（含市场前缀），如 sh601318 / sz000001 */
  fullCode: string;
  /** 纯数字证券代码 */
  code: string;
  /** 股票名称 */
  stockName: string;
  /** 拼音缩写，用于快速搜索 */
  pinYin: string;
  /** 市场类型，如 SH / SZ */
  marketType: string;
  /** 证券类型 */
  securityType: string;
  /** 快捷类型判断，直接映射费率引擎: 'stock' | 'etf' | 'bond' */
  kind: 'stock' | 'etf' | 'bond';
  /** 行情快照 ID */
  quoteId?: string;
  /** 简称 */
  shortName?: string;
  /** 统一代码 */
  unifiedCode?: string;
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
  /** 累计投入金额（元） */
  totalInvested: number;
  /** 已实现盈亏（元） */
  realizedPnL: number;
  /** 累计做 T 落袋净利润（元）。整轮/对冲对配口径：一轮等量对冲后 = 高抛净回款 - 低吸买入总成本；存量数据可能缺省 */
  accumulatedTPnL?: number;
  /** 初始建仓均价（元）：底仓真实买入（open 与未被做T对配消耗的 add）按数量加权的含规费均价；存量数据可能缺省 */
  initialCost?: number;
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
}

/** 做T轮次实体（tRounds 表）。一个 Round 代表一次完整/进行中的做T项目，采用绝对现金流法核算净收益。 */
export interface TRoundEntity extends BaseEntity {
  /** 关联持仓 id（可选，做T可与底仓解耦） */
  positionId?: string;
  /** 股票完整代码 */
  fullCode: string;
  /** 做T方向：long=正T（先买后卖），short=倒T（先卖后买） */
  mode: 'long' | 'short';
  /** 轮次状态：OPENED=进行中，COMPLETED=已结清归档 */
  status: 'OPENED' | 'COMPLETED';
  /** 做T战报业务流水号：#YYYYMMDD-HHmm（纯时间戳，不再维护序号） */
  roundCode: string;
  /** 结算方式：clear=清仓式结清，partial=部分/划转底仓 */
  settleType: 'clear' | 'partial';
  /** 本轮净收益（元） */
  netProfit: number;
  /** 本轮累计手续费（元） */
  totalFees: number;
  /** 开启时间戳（毫秒） */
  openedAt: number;
  /** 关闭时间戳（毫秒），未结清时缺省 */
  closedAt?: number;
  /** 累计买入金额（元） */
  buyAmount?: number;
  /** 累计卖出金额（元） */
  sellAmount?: number;
  /** 划转底仓数量（股，仅划转结算时存在） */
  transferAmount?: number;
  /** 加权平均价（元） */
  avgPrice?: number;
  /** 成交笔数 */
  tradeCount?: number;
  /** 持股天数 */
  holdingDays?: number;
  /** 是否盈利 */
  win?: boolean;
  /** 最近一次活动时间戳（毫秒） */
  lastUpdated?: number;
  /** 该 round 对应在中长期仓位中的自动调整批次 ID（出借/归并），删除时级联移除 */
  adjustmentBatchIds?: string[];
}

/** 做T成交流水实体（tTransactions 表）。记录 Round 内每笔买卖及撮合对冲结果。 */
export interface TTransactionEntity extends BaseEntity {
  /** 所属做T轮次 id */
  roundId: string;
  /** 成交方向：买入 / 卖出（划转在写入时统一转为 buy） */
  direction: 'buy' | 'sell';
  /** 成交单价（元） */
  price: number;
  /** 成交数量（股） */
  amount: number;
  /** 手续费（元） */
  fee: number;
  /** 被撮合对冲的数量（股） */
  matchedAmount: number;
  /** 本笔已实现盈亏（元，卖出方向才产生） */
  realizedProfit: number;
  /** 成交时间戳（毫秒） */
  timestamp: number;
  /** 备注 */
  note?: string;
}

/** 未完成做T项目流水实体（tStreams 表）。记录进行中 Round 的单边买卖流水，供刷新后恢复做T项目。 */
export interface TStreamEntity extends BaseEntity {
  /** 做T流水的展示时间戳（ISO 字符串或 'YYYY-MM-DD HH:mm'，与撮合引擎 FIFO 排序格式一致） */
  timestamp: string;
  /** 完整证券代码（含市场前缀，如 sh601318），作为流水池唯一主键 */
  fullCode: string;
  /** 交易方向：买入 / 卖出 */
  direction: 'buy' | 'sell';
  /** 成交单价（元） */
  price: number;
  /** 成交数量（股，正数） */
  amount: number;
  /** 单边规费快照（元） */
  fee: number;
  /** 备注 */
  note?: string;
  /** 行情快照 ID */
  quoteId?: string;
  /** 选股条目快照（恢复 UI 自动补全展示用） */
  selectedStock?: Record<string, unknown>;
  /** 倒T首笔卖出已扣减的底仓数量（股） */
  baseDeductedAmount?: number;
  /** 该卖出流对应的出借批次 ID（normalizeShortTDeductions 设置） */
  borrowBatchId?: string;
  /** 该买入流对应的归并批次 ID（applyShortExcessMerge 设置） */
  mergeBatchId?: string;
}

/** 现金账户实体（accountCash 表）。单行记录（id 固定为 1）。 */
// TODO: 该表目前仅 ensureDefaultData() 初始化 + addPositionTransaction() 写入，
//       但无 UI 组件读取展示。后续需实现现金账户页面或仪表盘资金卡片。
export interface AccountCashEntity {
  /** 主键，固定为 1（单例） */
  id: number;
  /** 可用现金（元） */
  availableCash: number;
  /** 冻结现金（元） */
  frozenCash: number;
  /** 累计入金总额（元） */
  totalDeposit: number;
  /** 最后更新时间戳（毫秒） */
  lastUpdated: number;
  /** 创建时间戳（毫秒） */
  createdAt: number;
  /** 更新时间戳（毫秒） */
  updatedAt: number;
  /** 软删除标记 */
  isDeleted?: number;
}

/** 现金流水实体（cashFlows 表）。记录入金/出金/分红/利息等资金变动。 */
// TODO: 该表虽已定义实体与索引，但尚未有任何读写代码。
//       后续需实现现金流水页面，支持入金/出金/分红/利息记录 + 历史流水查看。
export interface CashFlowEntity extends BaseEntity {
  /** 流水类型：入金 / 出金 / 分红 / 利息 */
  type: 'deposit' | 'withdraw' | 'dividend' | 'interest';
  /** 关联股票完整代码（分红时填写） */
  fullCode?: string;
  /** 金额（元，出金为负） */
  amount: number;
  /** 备注 */
  note?: string;
  /** 发生时间戳（毫秒） */
  timestamp: number;
}

/** 交易笔记实体（tradeNotes 表）。用于记录做T/持仓的复盘心得。 */
// TODO: 该表虽已定义实体与索引，但尚未有任何读写代码。
//       后续需实现交易笔记页面，支持 Round/持仓关联笔记 + 标签/评分/复盘。
export interface TradeNoteEntity extends BaseEntity {
  /** 关联做T轮次 id（可选） */
  roundId?: string;
  /** 关联持仓 id（可选） */
  positionId?: string;
  /** 逗号分隔的标签 */
  tags: string;
  /** 交易原因 */
  reason: string;
  /** 复盘总结 */
  review: string;
  /** 评分（如 1-5） */
  rating: number;
  /** 笔记时间戳（毫秒） */
  timestamp: number;
}

/** 费率配置实体（feeConfigs 表）。单行记录（id 固定为 1）。 */
export interface FeeConfigEntity {
  /** 主键，固定为 1（单例） */
  id: number;
  /** 佣金费率（如 0.00025） */
  commissionRate: number;
  /** 最低佣金（元，如 0.5） */
  minCommission: number;
  /** 是否免五（免最低 5 元佣金限制） */
  isFreeFive: boolean;
  /** 过户费率 */
  transferRate: number;
  /** 印花税率（卖出收取） */
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
  /** 创建时间戳（毫秒） */
  createdAt: number;
  /** 更新时间戳（毫秒） */
  updatedAt: number;
  /** 软删除标记 */
  isDeleted?: number;
}

/** 中长期操作记录实体（longTermRecords 表）。记录底仓加仓/减仓/归并操作，与短线战报联动删除。 */
export interface LongTermRecordEntity extends BaseEntity {
  /** 关联标的完整代码 */
  fullCode: string;
  /** 操作类型：buy / sell / merge */
  type: 'buy' | 'sell' | 'merge';
  /** 成交单价 */
  price: number;
  /** 成交数量 */
  amount: number;
  /** 手续费 */
  fee: number;
  /** 操作时间戳 */
  timestamp: number;
  /** 关联短线战报 id（仅 type=merge 时有值） */
  sourceReportId?: string;
  /** 备注 */
  note?: string;
}

/**
 * 各版本不变的基础表结构（v2）。
 * 后续版本基于此增量叠加或覆盖，不再全量复制。
 */
const STORES_V2 = {
  stocks: 'fullCode, code, stockName, pinYin, marketType, securityType, updatedAt, isDeleted',
  positions: 'id, fullCode, isClosed, createdAt, updatedAt, isDeleted',
  positionBatches: 'id, positionId, type, timestamp, updatedAt, isDeleted',
  tRounds: 'id, positionId, fullCode, mode, status, openedAt, closedAt, updatedAt, isDeleted',
  tTransactions: 'id, roundId, timestamp, updatedAt, isDeleted',
  accountCash: 'id, updatedAt',
  cashFlows: 'id, type, timestamp, fullCode, updatedAt, isDeleted',
  tradeNotes: 'id, roundId, positionId, timestamp, updatedAt, isDeleted',
  feeConfigs: 'id, updatedAt',
} as const;

/** v3：新增 tStreams 表 */
const STORES_V3 = { ...STORES_V2, tStreams: 'id, fullCode, direction, timestamp, updatedAt, isDeleted' } as const;

/** v4：新增 longTermRecords 表 */
const STORES_V4 = { ...STORES_V3, longTermRecords: 'id, fullCode, type, sourceReportId, timestamp, updatedAt, isDeleted' } as const;

/** v5：stocks 表增加 kind 字段索引 */
const STORES_V5 = { ...STORES_V4, stocks: 'fullCode, code, stockName, pinYin, marketType, securityType, kind, updatedAt, isDeleted' } as const;

/** v6：positions 增加复合索引 [isClosed+isDeleted]，tRounds 增加复合索引 [status+isDeleted] */
const STORES_V6 = {
  ...STORES_V5,
  positions: 'id, fullCode, isClosed, [isClosed+isDeleted], createdAt, updatedAt, isDeleted',
  tRounds: 'id, positionId, fullCode, mode, status, [status+isDeleted], openedAt, closedAt, updatedAt, isDeleted',
} as const;

/**
 * v7：存量数据迁移版本 —— positions 表 isClosed 由 boolean 迁移为 0|1 数字。
 * 索引定义与 v6 完全一致（isClosed 单字段索引自 v2 已存在，[isClosed+isDeleted] 复合索引自 v6 已存在），
 * 因此无需变更 schema，仅在 upgrade 回调中把存量 boolean 值转为数字，使索引开始收录这些记录。
 */
const STORES_V7: typeof STORES_V6 = STORES_V6;

/**
 * 交易账本 IndexedDB 数据库（Dexie 封装，库名 TradingLedgerDB_v3）。
 *
 * @description 集中管理全部 10 张规范化表，并声明各表的索引字段以支持高效查询。
 * @note 索引字符串格式为 Dexie schema：主键在前（`++` 自增 / 普通字段），逗号分隔的字段均会被建立索引。
 * @note 版本升级采用增量叠加模式，见 STORES_V2~STORES_V7 常量定义。
 */
export class TradingLedgerDB extends Dexie {
  /** 股票基础信息表 */
  stocks!: Table<StockEntity, string>;
  /** 持仓表 */
  positions!: Table<PositionEntity, string>;
  /** 持仓批次明细表 */
  positionBatches!: Table<PositionBatchEntity, string>;
  /** 做T轮次表 */
  tRounds!: Table<TRoundEntity, string>;
  /** 做T成交流水表 */
  tTransactions!: Table<TTransactionEntity, string>;
  /** 未完成做T项目流水表（进行中 Round 的单边流水池） */
  tStreams!: Table<TStreamEntity, string>;
  /** 现金账户表（单行） */
  accountCash!: Table<AccountCashEntity, number>;
  /** 现金流水表 */
  cashFlows!: Table<CashFlowEntity, string>;
  /** 交易笔记表 */
  tradeNotes!: Table<TradeNoteEntity, string>;
  /** 费率配置表（单行） */
  feeConfigs!: Table<FeeConfigEntity, number>;

  /** 中长期操作记录表 */
  longTermRecords!: Table<LongTermRecordEntity, string>;

  /**
   * 初始化数据库结构（版本链 v2→v7）。
   *
   * @description 声明各表的主键与索引；后续结构变更须升级 version 并添加 stores/upgrade 迁移逻辑。
   *              新增版本时在 STORES_Vx 链尾部追加增量定义即可，无需全量复制。
   */
  constructor() {
    super('TradingLedgerDB_v3');
    this.version(2).stores(STORES_V2 as Record<string, string>);
    this.version(3).stores(STORES_V3 as Record<string, string>);
    this.version(4).stores(STORES_V4 as Record<string, string>);
    this.version(5).stores(STORES_V5 as Record<string, string>);
    this.version(6).stores(STORES_V6 as Record<string, string>);
    this.version(7)
      .stores(STORES_V7 as Record<string, string>)
      .upgrade(async (tx) => {
        // v6 及更早版本 isClosed 为 boolean。IndexedDB 仅支持 number/string/Date/binary/Array 作为
        // 索引 key，boolean 不是合法 key 类型，导致 isClosed 与 [isClosed+isDeleted] 索引不收录任何记录，
        // 按索引查询（equals([0,0]) / equals([1,0])）查不出数据。迁移为 0|1 数字后索引即可生效。
        await tx
          .table('positions')
          .toCollection()
          .modify((pos: { isClosed?: unknown }) => {
            if (typeof pos.isClosed === 'boolean') {
              pos.isClosed = pos.isClosed ? 1 : 0;
            } else if (typeof pos.isClosed !== 'number') {
              // 兜底：缺失或异常值时视为未平仓
              pos.isClosed = 0;
            }
          });
      });
  }
}

/** 全局唯一的数据库实例，供 Service 与 Store 层读写使用 */
export const db = new TradingLedgerDB();
