/**
 * @file fixtures.ts
 * @description 自定义统计沙箱夹具：正式执行前的两轮预跑数据（spec FR2/implementation §4.3）。
 *              ① 空数组夹具：全集合为空，消灭 rounds[0].x 类崩溃；
 *              ② 样例夹具：每集合 2~3 行真实形状数据，验证结果形状 + Guard 热身。
 *              夹具为常量构造（非用户数据），单测直接复用。
 * @layer Utils (Pure) —— 只依赖 types，禁碰 store/db（R2）
 * @storage_impact 纯常量，无存储。
 * @author 开发团队
 */

import type { CustomStatDefinition, CustomStatsContextWire, CustomStatStream, CustomStatTxn, Position, TRoundArchive } from '../../types/domain';
import { CUSTOM_STAT_SCHEMA_VERSION } from '../../types/domain';

/** 夹具固定时间锚点（ISO），保证断言可复现 */
export const FIXTURE_NOW = '2026-09-07T10:00:00.000Z';

/** 夹具费率配置（A股典型值，rate 为 0-1 小数） */
export const FIXTURE_FEE_CONFIG = {
  commissionRate: 0.00025,
  isFreeFive: false,
  minCommission: 5,
  transferRate: 0.00001,
  stampRate: 0.0005,
};

/** 空数组夹具：库内无任何数据时首次生成统计的执行环境 */
export function buildEmptyFixtureCtx(): CustomStatsContextWire {
  return {
    schemaVersion: CUSTOM_STAT_SCHEMA_VERSION,
    now: FIXTURE_NOW,
    rounds: [],
    openRounds: [],
    txns: [],
    positions: [],
    activeStreams: [],
    feeConfig: { ...FIXTURE_FEE_CONFIG },
  };
}

// ---- 样例夹具（真实形状，2~3 行/集合） ----

const SAMPLE_ROUNDS: TRoundArchive[] = [
  {
    id: 'fx-round-1', fullCode: 'sh600519', stockName: '贵州茅台', mode: 'long', status: 'COMPLETED',
    roundCode: 'R20260801-001', settleType: 'clear',
    netProfit: 236.5, totalFees: 12.34, fees: 12.34, buyAmount: 20000, sellAmount: 20248.84,
    avgPrice: 2000, tradeCount: 2, holdingDays: 1, win: true,
    openedAt: '2026-08-01T09:35:00.000Z', closedAt: '2026-08-01T14:55:00.000Z',
  },
  {
    id: 'fx-round-2', fullCode: 'sz000001', stockName: '平安银行', mode: 'short', status: 'COMPLETED',
    roundCode: 'R20260802-001', settleType: 'clear',
    netProfit: -58.2, totalFees: 8.1, fees: 8.1, buyAmount: 10000, sellAmount: 9933.7,
    avgPrice: 10, tradeCount: 2, holdingDays: 2, win: false,
    openedAt: '2026-08-02T10:00:00.000Z', closedAt: '2026-08-04T13:20:00.000Z',
  },
  {
    id: 'fx-round-3', fullCode: 'sh600519', stockName: '贵州茅台', mode: 'long', status: 'COMPLETED',
    roundCode: 'R20260803-001', settleType: 'clear',
    netProfit: 120.0, totalFees: 10.0, fees: 10.0, buyAmount: 15000, sellAmount: 15110,
    avgPrice: 1500, tradeCount: 2, holdingDays: 1, win: true,
    openedAt: '2026-08-03T09:40:00.000Z', closedAt: '2026-08-03T15:00:00.000Z',
  },
];

const SAMPLE_OPEN_ROUNDS: TRoundArchive[] = [
  {
    id: 'fx-round-open-1', fullCode: 'sh601318', stockName: '中国平安', mode: 'long', status: 'OPENED',
    roundCode: 'R20260906-001', settleType: 'clear', netProfit: 0,
    openedAt: '2026-09-06T09:35:00.000Z',
  },
];

const SAMPLE_TXNS: CustomStatTxn[] = [
  {
    id: 'fx-txn-1', roundId: 'fx-round-1', fullCode: 'sh600519', stockName: '贵州茅台',
    timestamp: '2026-08-01T09:35:00.000Z', direction: 'buy', price: 2000, amount: 10, fee: 5.5,
    matchedAmount: 10, realizedProfit: 0,
  },
  {
    id: 'fx-txn-2', roundId: 'fx-round-1', fullCode: 'sh600519', stockName: '贵州茅台',
    timestamp: '2026-08-01T14:55:00.000Z', direction: 'sell', price: 2024.88, amount: 10, fee: 6.84,
    matchedAmount: 10, realizedProfit: 236.5,
  },
  {
    id: 'fx-txn-3', roundId: 'fx-round-2', fullCode: 'sz000001', stockName: '平安银行',
    timestamp: '2026-08-02T10:00:00.000Z', direction: 'sell', price: 10.05, amount: 1000, fee: 4.1,
    matchedAmount: 1000, realizedProfit: 0,
  },
  {
    id: 'fx-txn-4', roundId: 'fx-round-2', fullCode: 'sz000001', stockName: '平安银行',
    timestamp: '2026-08-04T13:20:00.000Z', direction: 'buy', price: 9.99, amount: 1000, fee: 4.0,
    matchedAmount: 1000, realizedProfit: -58.2,
  },
];

const SAMPLE_POSITIONS: Position[] = [
  {
    id: 'fx-pos-1', stockName: '贵州茅台', fullCode: 'sh600519', currentCost: 1990, currentAmount: 100,
    batches: [], isClosed: false, createdAt: '2026-01-05T09:30:00.000Z',
    openAt: '2026-01-05T09:30:00.000Z', realizedPnL: 356.5, totalInvested: 199000,
  },
  {
    id: 'fx-pos-2', stockName: '平安银行', fullCode: 'sz000001', currentCost: 10.2, currentAmount: 0,
    batches: [], isClosed: true, createdAt: '2026-02-01T09:30:00.000Z',
    openAt: '2026-02-01T09:30:00.000Z', closedAt: '2026-08-04T13:20:00.000Z',
    realizedPnL: -58.2, totalInvested: 10200,
  },
];

const SAMPLE_ACTIVE_STREAMS: CustomStatStream[] = [
  {
    fullCode: 'sh601318', stockName: '中国平安', status: 'PARTIAL',
    netPendingAmount: 1500, weightedBuyCost: 45.2, realizedPnL: 88.8,
  },
];

/** 样例夹具：每集合 2~3 行真实形状数据 */
export function buildSampleFixtureCtx(): CustomStatsContextWire {
  return {
    schemaVersion: CUSTOM_STAT_SCHEMA_VERSION,
    now: FIXTURE_NOW,
    rounds: SAMPLE_ROUNDS.map((r) => ({ ...r })),
    openRounds: SAMPLE_OPEN_ROUNDS.map((r) => ({ ...r })),
    txns: SAMPLE_TXNS.map((t) => ({ ...t })),
    positions: SAMPLE_POSITIONS.map((p) => ({ ...p })),
    activeStreams: SAMPLE_ACTIVE_STREAMS.map((s) => ({ ...s })),
    feeConfig: { ...FIXTURE_FEE_CONFIG },
  };
}

/** 两轮预跑夹具（顺序执行：先空数组后样例） */
export function buildFixtureContexts(): CustomStatsContextWire[] {
  return [buildEmptyFixtureCtx(), buildSampleFixtureCtx()];
}

/** 样例定义（保存流程/画廊测试用，非沙箱夹具） */
export function buildSampleDefinition(over: Partial<CustomStatDefinition> = {}): CustomStatDefinition {
  return {
    id: 'fx-def-1',
    name: '各股做T净收益排行',
    description: '统计已归档轮净收益按股票求和，柱状降序',
    prompt: '统计各股做T净收益排行，柱状图降序',
    code: '(ctx) => ({ kind: "card", title: "示例", kpis: [{ label: "总收益", value: "¥0" }] })',
    schemaVersion: CUSTOM_STAT_SCHEMA_VERSION,
    kind: 'card',
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...over,
  };
}
