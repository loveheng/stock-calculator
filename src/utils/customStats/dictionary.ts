/**
 * @file dictionary.ts
 * @description 自定义统计字段字典：CustomStatsContext 各集合字段与口径语义的权威快照，
 *              供 LLM 提示词模板（FIELD_DICTIONARY）与样例行组装共用。
 *              防腐设计：字段键用 as const satisfies 编译期校验（领域类型改/删字段即 tsc 报错），
 *              配合运行时测试（customStatDictionary.test.ts）双重报警。
 * @layer Utils (Pure) —— 只依赖 types，禁碰 store/db（R2）
 * @storage_impact 纯常量，无存储。
 * @author 开发团队
 */

import type {
  CustomStatStream,
  CustomStatTxn,
  Position,
  TRoundArchive,
} from '../../types/domain';

/** 单字段口径说明 */
export interface CustomStatFieldDoc {
  field: string;
  desc: string;
}

/** 字典条目源：[字段名, 口径说明]，字段名编译期校验必须是对应集合的真实键 */
type FieldEntry<K extends string> = readonly [K, string];

// ---- rounds / openRounds（TRoundArchive，做T轮次）----
const ROUND_FIELDS = [
  ['fullCode', '证券代码（含市场前缀，如 sh601318）'],
  ['stockName', '股票名称'],
  ['mode', "先买后卖（正T）='long' / 先卖后买（反T）='short'"],
  ['status', "进行中='OPENED' / 已了结='COMPLETED'"],
  ['netProfit', '净收益（绝对现金流法，已扣规费，元）——收益统计主口径'],
  ['totalFees', '规费合计（元）；与 fees 并存时优先用 totalFees'],
  ['fees', '规费合计（旧字段，元）；优先用 totalFees'],
  ['buyAmount', '买入成交额（元）'],
  ['sellAmount', '卖出成交额（元）'],
  ['avgPrice', '成交均价（元/股）'],
  ['tradeCount', '成交笔数'],
  ['holdingDays', '持有天数'],
  ['win', '是否盈利轮（boolean）'],
  ['openedAt', '开仓时间（ISO 字符串）'],
  ['closedAt', '平仓时间（ISO 字符串，仅 COMPLETED 轮有）'],
  ['settleType', "了结方式：清仓='clear' / 部分了结='partial' / 划转底仓='transfer'"],
] as const satisfies readonly FieldEntry<keyof TRoundArchive>[];

// ---- txns（CustomStatTxn，逐笔做T流水，timestamp 升序）----
const TXN_FIELDS = [
  ['roundId', '所属轮次 id（关联 rounds[].id）'],
  ['fullCode', '证券代码（含市场前缀）'],
  ['stockName', '股票名称'],
  ['timestamp', '成交时间（ISO 字符串，升序）——按天/星期统计的时间基准'],
  ['direction', "方向：买入='buy' / 卖出='sell' / 划转归并='merge'"],
  ['price', '成交单价（元/股）'],
  ['amount', '成交数量（股，正数）'],
  ['fee', '该笔规费（元）'],
  ['matchedAmount', '被撮合对冲的数量（股）'],
  ['realizedProfit', '本笔已实现盈亏（元，卖出方向才产生）'],
] as const satisfies readonly FieldEntry<keyof CustomStatTxn>[];

// ---- positions（Position，持仓全量含已平仓）----
const POSITION_FIELDS = [
  ['fullCode', '证券代码（含市场前缀）'],
  ['stockName', '股票名称'],
  ['isClosed', '是否已平仓（boolean）'],
  ['currentCost', '当前加权成本价（元/股）'],
  ['currentAmount', '当前持有数量（股）'],
  ['realizedPnL', '已实现盈亏（元）'],
  ['totalInvested', '累计投入金额（元）'],
  ['openAt', '开仓时间（ISO 字符串，缺省回退 createdAt）'],
  ['closedAt', '平仓时间（ISO 字符串，仅已平仓有）'],
] as const satisfies readonly FieldEntry<keyof Position>[];

// ---- activeStreams（CustomStatStream，进行中轮撮合结果，序列化安全子集）----
const STREAM_FIELDS = [
  ['fullCode', '证券代码（含市场前缀）'],
  ['stockName', '股票名称'],
  ['status', "撮合状态：'PENDING'/'PARTIAL'/'CLEARED'/'SHORT_PENDING'"],
  ['netPendingAmount', '净持仓敞口（元）'],
  ['weightedBuyCost', '加权买入成本（元/股）'],
  ['realizedPnL', '已实现盈亏（元）'],
] as const satisfies readonly FieldEntry<keyof CustomStatStream>[];

function toDictionary(entries: readonly FieldEntry<string>[]): CustomStatFieldDoc[] {
  return entries.map(([field, desc]) => ({ field, desc }));
}

/** rounds/openRounds 字段字典 */
export const ROUNDS_FIELD_DICTIONARY: readonly CustomStatFieldDoc[] = toDictionary(ROUND_FIELDS);
/** txns 字段字典 */
export const TXNS_FIELD_DICTIONARY: readonly CustomStatFieldDoc[] = toDictionary(TXN_FIELDS);
/** positions 字段字典 */
export const POSITIONS_FIELD_DICTIONARY: readonly CustomStatFieldDoc[] = toDictionary(POSITION_FIELDS);
/** activeStreams 字段字典 */
export const STREAMS_FIELD_DICTIONARY: readonly CustomStatFieldDoc[] = toDictionary(STREAM_FIELDS);

/** 上下文级字段（now/feeConfig/helpers）口径说明，随字典一并进模板 */
export const CONTEXT_EXTRA_DICTIONARY: readonly CustomStatFieldDoc[] = [
  { field: 'now', desc: '宿主时间锚点（ISO 字符串），一切「今天/本月」以此为基准；沙箱内无 Date.now' },
  { field: 'feeConfig', desc: '费率配置：commissionRate/isFreeFive/minCommission/transferRate/stampRate（rate 均为 0-1 小数），净额复算用' },
  { field: 'helpers', desc: '宿主纯函数：round2(两位小数)/pct(除零安全返回0-1小数)/groupBy/sumBy/fmtMoney(千分位+2位小数)' },
];

/**
 * 全量字典（按集合分组），组装 LLM 提示词 FIELD_DICTIONARY 段的唯一入口。
 * @returns 如 { rounds: [...], txns: [...], positions: [...], activeStreams: [...], context: [...] }
 */
export function buildFieldDictionaryPayload(): Record<string, CustomStatFieldDoc[]> {
  return {
    rounds: [...ROUNDS_FIELD_DICTIONARY],
    txns: [...TXNS_FIELD_DICTIONARY],
    positions: [...POSITIONS_FIELD_DICTIONARY],
    activeStreams: [...STREAMS_FIELD_DICTIONARY],
    context: [...CONTEXT_EXTRA_DICTIONARY],
  };
}
