/**
 * @file copilotSnapshots.test.ts
 * @description Copilot 快照纯引擎单测：applySizeGuard 体积护栏（透传/裁剪/标量保留）、
 *              buildStatisticsContext（胜率/净收益口径）、buildHomeContext（市值=数量×成本口径、有效计划单口径与视图对齐）。
 * @layer 测试
 * @author 开发团队
 */

import { describe, it, expect } from 'vitest';
import {
  applySizeGuard,
  buildStatisticsContext,
  buildHomeContext,
  buildHomeShortTermContext,
  buildHomePositionContext,
  buildHomePlanContext,
  buildTProjectContext,
  buildLedgerPositionContext,
} from '../utils/copilotSnapshots';
import { recalculatePosition } from '../utils/calculator';
import { DEFAULT_FEE_CONFIG } from '../utils/feePresets';
import type { CopilotContextData, PlannedOrder, Position, PositionBatchEntity, RoundTxn, TRoundArchive } from '../types/domain';

// ---- fixtures ----

function makeRound(partial: Partial<TRoundArchive>): TRoundArchive {
  return {
    id: 'r1',
    fullCode: '600519.SH',
    stockName: '贵州茅台',
    mode: 'long',
    roundCode: 'R-001',
    settleType: 'clear',
    netProfit: 0,
    openedAt: '2026-01-01T09:30:00.000Z',
    ...partial,
  };
}

function makePosition(partial: Partial<Position>): Position {
  return {
    id: 'p1',
    stockName: '贵州茅台',
    fullCode: '600519.SH',
    currentCost: 100,
    currentAmount: 100,
    batches: [],
    isClosed: false,
    createdAt: '2026-01-01T09:30:00.000Z',
    ...partial,
  };
}

function makePlan(partial: Partial<PlannedOrder>): PlannedOrder {
  return {
    id: 'pl1',
    fullCode: '600519.SH',
    stockName: '贵州茅台',
    context: 'short-term',
    direction: 'sell',
    plannedPrice: 100,
    plannedAmount: 100,
    createdAt: '2026-01-01T09:30:00.000Z',
    // 远期过期时间，避免依赖真实时钟
    expiresAt: '2999-01-01T00:00:00.000Z',
    validityDays: 30,
    status: 'active',
    ...partial,
  };
}

function makeTxn(partial: Partial<RoundTxn>): RoundTxn {
  return {
    id: 't1',
    timestamp: new Date().toISOString(),
    direction: 'buy',
    price: 10,
    amount: 100,
    fee: 1,
    ...partial,
  };
}

const daysAgoIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

describe('applySizeGuard（体积护栏 D5④）', () => {
  it('未超限时透传：truncated=false，data/_units/capturedAt 原样', () => {
    const snap: CopilotContextData = {
      overview: { pnl: 123.45 },
      timeAnchor: { asOf: 1_756_713_600, range: 'all' },
      detail: { rows: [{ a: 1 }, { a: 2 }] },
      units: { pnl: '元(CNY)' },
    };
    const out = applySizeGuard(snap);
    expect(out.truncated).toBe(false);
    expect(out.data.rows).toHaveLength(2);
    expect(out._units.pnl).toBe('元(CNY)');
    expect(out.capturedAt).toBe(1_756_713_600);
  });

  it('超限时逐数组裁尾：truncated=true，数组行数缩减且标量字段保留', () => {
    const bigRows = Array.from({ length: 2000 }, (_, i) => ({ idx: i, pad: 'x'.repeat(50) }));
    const snap: CopilotContextData = {
      overview: { count: 2000 },
      timeAnchor: { asOf: 1, range: 'all' },
      detail: { rows: bigRows, note: '标量保留' },
      units: {},
    };
    const out = applySizeGuard(snap, 2_000);
    expect(out.truncated).toBe(true);
    expect((out.data.rows as unknown[]).length).toBeLessThan(2000);
    expect(out.data.note).toBe('标量保留');
  });
});

describe('buildStatisticsContext（数据统计快照）', () => {
  it('已完成轮标量汇总：胜率/净收益/费用口径正确', () => {
    const ctx = buildStatisticsContext({
      tRounds: [
        makeRound({ id: 'r1', netProfit: 100, win: true, status: 'COMPLETED', closedAt: '2026-01-02', fees: 5 }),
        makeRound({ id: 'r2', netProfit: -50, win: false, status: 'COMPLETED', closedAt: '2026-01-03' }),
      ],
      positions: [],
      plannedOrders: [],
      feeConfig: DEFAULT_FEE_CONFIG,
    });
    expect(ctx.overview.completedRoundCount).toBe(2);
    expect(ctx.overview.activeRoundCount).toBe(0);
    expect(ctx.overview.winRate).toBe(0.5);
    expect(ctx.overview.totalNetProfit).toBe(50);
    expect(ctx.overview.totalFees).toBe(5);
    expect(ctx.timeAnchor.range).toBe('all');
  });
});

describe('buildHomeContext（首页仪表盘快照）', () => {
  it('市值为成本口径（数量×成本价），已平仓不计入市值但计入已实现盈亏', () => {
    const ctx = buildHomeContext({
      tRounds: [],
      positions: [
        makePosition({ id: 'p1', currentCost: 10, currentAmount: 100, realizedPnL: 50 }),
        makePosition({ id: 'p2', currentCost: 20, currentAmount: 200, realizedPnL: -30 }),
        makePosition({ id: 'p3', currentCost: 5, currentAmount: 10, isClosed: true }),
      ],
      plannedOrders: [],
      feeConfig: DEFAULT_FEE_CONFIG,
    });
    expect(ctx.overview.openPositionCount).toBe(2);
    expect(ctx.overview.closedPositionCount).toBe(1);
    expect(ctx.overview.totalMarketValue).toBe(100 * 10 + 200 * 20);
    expect(ctx.overview.totalRealizedPnL).toBe(20);
    expect((ctx.detail.openPositions as unknown[]).length).toBe(2);
  });

  it('有效计划单口径与视图对齐：仅 status=active 且未过期计入', () => {
    const ctx = buildHomeContext({
      tRounds: [],
      positions: [],
      plannedOrders: [
        // 未过期 active → 计入
        makePlan({ id: 'pl1' }),
        // status 滞后为 active 但已过期 → 剔除（以时间实时判断，不信任 status 字段）
        makePlan({ id: 'pl2', expiresAt: '2020-01-01T00:00:00.000Z' }),
        // cancelled → 剔除
        makePlan({ id: 'pl3', status: 'cancelled' }),
        // executed → 剔除
        makePlan({ id: 'pl4', status: 'executed' }),
      ],
      feeConfig: DEFAULT_FEE_CONFIG,
    });
    expect(ctx.overview.activePlanCount).toBe(1);
    expect((ctx.detail.activePlans as unknown[]).length).toBe(1);
  });
});

describe('buildHomeShortTermContext（V2 区块快照：时间筛选口径）', () => {
  it('7d 窗口：窗外流水/战报不计入盈亏与活跃数，胜率/完成数恒全量，timeAnchor 同步 Tab', () => {
    const ctx = buildHomeShortTermContext({
      tRounds: [
        // 窗内已完成（3 天前平仓）→ 计入盈亏
        makeRound({ id: 'r1', status: 'COMPLETED', closedAt: daysAgoIso(3), netProfit: 100, win: true, mode: 'long' }),
        // 窗外已完成（20 天前平仓）→ 不计入盈亏，但计入胜率基数（视图 1b 全量口径）
        makeRound({ id: 'r2', status: 'COMPLETED', closedAt: daysAgoIso(20), netProfit: -50, win: false, mode: 'short' }),
        // 窗外进行中流水（10 天前买入）→ 不计入活跃数
        makeRound({
          id: 'r3', status: 'OPENED', mode: 'long',
          transactions: [makeTxn({ id: 't1', timestamp: daysAgoIso(10), direction: 'buy', price: 10, amount: 100, fee: 1 })],
        }),
      ],
      positions: [],
      plannedOrders: [],
      feeConfig: DEFAULT_FEE_CONFIG,
      homeTimeRange: '7d',
    });
    expect(ctx.overview.totalProfit).toBe(100);
    expect(ctx.overview.longProfit).toBe(100);
    expect(ctx.overview.shortProfit).toBe(0);
    expect(ctx.overview.activeCount).toBe(0);
    expect(ctx.overview.completedRounds).toBe(2);
    expect(ctx.overview.winRounds).toBe(1);
    expect(ctx.overview.winRate).toBe(0.5);
    expect(ctx.overview.rebuyAlerts).toBe(0);
    expect(ctx.timeAnchor.range).toBe('7d');
    expect(ctx.detail.timeRange).toBe('7d');
  });

  it('all 全量：窗外流水计入活跃数；PENDING 流水规费按方向归集（entry.fee 源自流水记录）', () => {
    const ctx = buildHomeShortTermContext({
      tRounds: [
        makeRound({
          id: 'r3', status: 'OPENED', mode: 'long',
          transactions: [
            makeTxn({ id: 'tb', timestamp: daysAgoIso(10), direction: 'buy', price: 10, amount: 100, fee: 3 }),
            makeTxn({ id: 'ts', timestamp: daysAgoIso(9), direction: 'sell', price: 10.5, amount: 50, fee: 2 }),
          ],
        }),
      ],
      positions: [],
      plannedOrders: [],
      feeConfig: DEFAULT_FEE_CONFIG,
      homeTimeRange: 'all',
    });
    expect(ctx.overview.activeCount).toBe(1);
    expect(ctx.timeAnchor.range).toBe('all');
    const fees = ctx.detail.feeBreakdown as { buyFee: number; sellFee: number };
    expect(fees.buyFee).toBe(3);
    expect(fees.sellFee).toBe(2);
  });

  it('倒T待回补预警：全量 active 口径，文案与视图 1h 对齐', () => {
    const ctx = buildHomeShortTermContext({
      tRounds: [
        // 倒T：卖 200 买 100 → 剩余 100 股待回补（参照 roundLifecycle.test 同款 fixture）
        makeRound({
          id: 'rs', fullCode: 'sh600000', stockName: '浦发银行', status: 'OPENED', mode: 'short',
          transactions: [
            makeTxn({ id: 'ts1', timestamp: daysAgoIso(1), direction: 'sell', price: 17.43, amount: 200, fee: 3 }),
            makeTxn({ id: 'tb1', timestamp: daysAgoIso(0.5), direction: 'buy', price: 16, amount: 100, fee: 2 }),
          ],
        }),
      ],
      positions: [makePosition({ id: 'p1', fullCode: 'sh600000', stockName: '浦发银行', currentAmount: 200, currentCost: 18 })],
      plannedOrders: [],
      feeConfig: DEFAULT_FEE_CONFIG,
      homeTimeRange: '1d',
    });
    expect(ctx.overview.rebuyAlerts).toBe(1);
    const alerts = ctx.detail.rebuyAlerts as Array<{ message: string; pendingAmount: number; isBaseExhausted: boolean }>;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].pendingAmount).toBe(100);
    expect(alerts[0].isBaseExhausted).toBe(false);
    expect(alerts[0].message).toBe('倒T待回补 100 股');
  });

  it('区间最大盈/亏单笔与分标的归集；overview 落库标量 ≤255 字符（D28 列宽约束）', () => {
    const ctx = buildHomeShortTermContext({
      tRounds: [
        makeRound({ id: 'r1', status: 'COMPLETED', closedAt: daysAgoIso(1), netProfit: 300, win: true, mode: 'long', stockName: 'A股' }),
        makeRound({ id: 'r2', fullCode: '000858.SZ', status: 'COMPLETED', closedAt: daysAgoIso(2), netProfit: -80, win: false, mode: 'short', stockName: 'B股' }),
        makeRound({ id: 'r3', status: 'COMPLETED', closedAt: daysAgoIso(3), netProfit: 20, win: true, mode: 'long', stockName: 'A股' }),
      ],
      positions: [],
      plannedOrders: [],
      feeConfig: DEFAULT_FEE_CONFIG,
      homeTimeRange: '30d',
    });
    const top = ctx.detail.topProfit as { stockName: string; profit: number };
    const loss = ctx.detail.topLoss as { stockName: string; profit: number };
    expect(top.stockName).toBe('A股');
    expect(top.profit).toBe(300);
    expect(loss.stockName).toBe('B股');
    expect(loss.profit).toBe(-80);
    const perSymbol = ctx.detail.perSymbolProfit as Array<{ fullCode: string; totalProfit: number }>;
    expect(perSymbol[0].totalProfit).toBe(320); // A股 300+20 排序居首
    expect(JSON.stringify(ctx.overview).length).toBeLessThanOrEqual(255);
  });
});

describe('buildHomePositionContext（V2 区块快照：仓位统计口径）', () => {
  it('市值/集中度/最多金额/最大持有天数与模块 2 对齐；浮动盈亏仅含开启仓位标的', () => {
    const ctx = buildHomePositionContext({
      tRounds: [
        // 开启仓位标的的已完成战报 → 计入 2f 合并（视图 combinedProfitByCode 口径）
        makeRound({ id: 'rc', fullCode: '000858.SZ', status: 'COMPLETED', closedAt: daysAgoIso(1), netProfit: 50, win: true, mode: 'long' }),
        // 非开启仓位标的 → 2e/2f 均排除
        makeRound({ id: 'rx', fullCode: '300750.SZ', status: 'COMPLETED', closedAt: daysAgoIso(2), netProfit: 999, win: true, mode: 'long' }),
        // 开启仓位标的的流水：全买卖平 → CLEARED 流水（视图 2f 含 CLEARED），零费 fixture → transferProfit=100
        makeRound({
          id: 'rs', fullCode: '600519.SH', status: 'OPENED', mode: 'long',
          transactions: [
            makeTxn({ id: 'tb', timestamp: daysAgoIso(1), direction: 'buy', price: 10, amount: 100, fee: 0 }),
            makeTxn({ id: 'ts', timestamp: daysAgoIso(0.5), direction: 'sell', price: 11, amount: 100, fee: 0 }),
          ],
        }),
      ],
      positions: [
        makePosition({ id: 'p1', fullCode: '600519.SH', currentCost: 10, currentAmount: 100, createdAt: daysAgoIso(10) }),
        makePosition({ id: 'p2', fullCode: '000858.SZ', currentCost: 20, currentAmount: 200, createdAt: daysAgoIso(39.5) }),
        makePosition({ id: 'p3', fullCode: '300750.SZ', currentCost: 5, currentAmount: 10, isClosed: true }),
      ],
      plannedOrders: [],
      feeConfig: DEFAULT_FEE_CONFIG,
    });
    expect(ctx.overview.positionCount).toBe(2); // 已平仓 p3 剔除
    expect(ctx.overview.totalMarketValue).toBe(100 * 10 + 200 * 20); // 成本口径
    // 浮动盈亏 = 开启仓位标的：CLEARED 流水 100 + 已完成战报 50；非持仓标的 999 排除
    expect(ctx.overview.totalFloatingPnL).toBe(150);
    // 集中度 = 最大仓位 4000 / 总市值 5000；持有 39.5 天 ceil 后为 40（ε 不跨整数边界）
    expect(ctx.overview.concentration).toBe(0.8);
    expect(ctx.overview.maxHoldingDays).toBe(40);
    const maxCap = ctx.detail.maxCapitalPosition as { fullCode: string; marketValue: number };
    expect(maxCap.fullCode).toBe('000858.SZ');
    expect(maxCap.marketValue).toBe(4000);
    const best = ctx.detail.bestCostReduction as { fullCode: string; totalProfit: number };
    expect(best.fullCode).toBe('600519.SH');
    expect(best.totalProfit).toBe(100);
    expect(JSON.stringify(ctx.overview).length).toBeLessThanOrEqual(255);
  });

  it('空仓降级：concentration/maxHoldingDays 归零，bestCostReduction 为 null', () => {
    const ctx = buildHomePositionContext({
      tRounds: [],
      positions: [makePosition({ id: 'p3', isClosed: true })],
      plannedOrders: [],
      feeConfig: DEFAULT_FEE_CONFIG,
    });
    expect(ctx.overview.positionCount).toBe(0);
    expect(ctx.overview.concentration).toBe(0);
    expect(ctx.overview.maxHoldingDays).toBe(0);
    expect(ctx.detail.bestCostReduction).toBeNull();
  });
});

describe('buildHomePlanContext（V2 区块快照：计划单待办口径）', () => {
  it('列表/待执行口径对齐：cancelled 剔除、过期 3 天窗口、status 滞后以时间实时判断', () => {
    const ctx = buildHomePlanContext({
      tRounds: [],
      positions: [],
      plannedOrders: [
        makePlan({ id: 'pl1', fullCode: '600519.SH', direction: 'buy', plannedPrice: 100 }), // active 未过期 → 待执行
        makePlan({ id: 'pl2', fullCode: '000858.SZ', direction: 'sell', plannedPrice: 50, expiresAt: daysAgoIso(1) }), // status 滞后 active 但已过期 → 列表保留不计待执行
        makePlan({ id: 'pl3', status: 'expired', expiresAt: daysAgoIso(1) }), // 过期 3 天窗口内 → 列表保留
        makePlan({ id: 'pl4', status: 'expired', expiresAt: daysAgoIso(5) }), // 窗口外 → 剔除
        makePlan({ id: 'pl5', status: 'cancelled' }), // 剔除
        makePlan({ id: 'pl6', status: 'executed', expiresAt: daysAgoIso(1) }), // 窗口内 → 列表保留
      ],
      feeConfig: DEFAULT_FEE_CONFIG,
      getMarketPrice: (code) => (code === '600519.SH' ? 105 : code === '000858.SZ' ? 45 : undefined),
    });
    expect(ctx.overview.planCount).toBe(4); // pl1/pl2/pl3/pl6
    expect(ctx.overview.activePlanCount).toBe(1); // 仅 pl1（pl2 时间过期）
    expect(ctx.overview.activeBuyCount).toBe(1);
    expect(ctx.overview.activeSellCount).toBe(0);
    // 活跃偏离聚合仅计活跃单（视图紧凑偏离徽标仅 active 展示）
    expect(ctx.overview.quotedCount).toBe(1);
    expect(ctx.overview.maxAbsDeviationPercent).toBe(5); // |105-100|/100
    const plans = ctx.detail.plans as Array<{
      fullCode: string;
      currentPrice?: number;
      deviationPercent?: number;
    }>;
    expect(plans).toHaveLength(4);
    const pl1 = plans.find((p) => p.fullCode === '600519.SH');
    expect(pl1?.currentPrice).toBe(105);
    expect(pl1?.deviationPercent).toBe(5);
    const pl2 = plans.find((p) => p.fullCode === '000858.SZ');
    // 非活跃单行仍带行情对比（视图详情区对任意状态展示），但不计入概览活跃偏离
    expect(pl2?.deviationPercent).toBe(-10);
    expect(JSON.stringify(ctx.overview).length).toBeLessThanOrEqual(255);
  });

  it('无行情优雅降级：行省略现价/偏离度字段，概览省略 maxAbsDeviationPercent（严禁塞 0）', () => {
    const ctx = buildHomePlanContext({
      tRounds: [],
      positions: [],
      plannedOrders: [makePlan({ id: 'pl1' }), makePlan({ id: 'pl2', fullCode: '000858.SZ' })],
      feeConfig: DEFAULT_FEE_CONFIG,
      getMarketPrice: () => undefined,
    });
    expect(ctx.overview.quotedCount).toBe(0);
    expect(ctx.overview.maxAbsDeviationPercent).toBeUndefined();
    const plans = ctx.detail.plans as Array<Record<string, unknown>>;
    expect(plans).toHaveLength(2);
    for (const row of plans) {
      expect(row.currentPrice).toBeUndefined();
      expect(row.deviationPercent).toBeUndefined();
    }
  });

  it('明细最多 10 条 + plansOmitted 计数；不注入行情桥时整体降级', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      makePlan({ id: `pl${i}`, fullCode: `60051${i}.SH` }),
    );
    const ctx = buildHomePlanContext({
      tRounds: [],
      positions: [],
      plannedOrders: many,
      feeConfig: DEFAULT_FEE_CONFIG,
    });
    expect(ctx.overview.planCount).toBe(12);
    expect(ctx.overview.activePlanCount).toBe(12);
    expect((ctx.detail.plans as unknown[]).length).toBe(10);
    expect(ctx.detail.plansOmitted).toBe(2);
    expect(ctx.overview.quotedCount).toBe(0);
  });
});

describe('buildTProjectContext（V2 推广：进行中短线项目按标的）', () => {
  const CODE = 'sh600519';

  function makeTPosition(): Position {
    return makePosition({
      id: 'p1',
      fullCode: CODE,
      currentCost: 24.11,
      currentAmount: 1000,
      batches: [
        { id: 'b1', timestamp: '2026-08-01T00:00:00.000Z', type: 'open', price: 24.11, amount: 1000, costAfter: 24.11, amountAfter: 1000 },
      ],
    });
  }

  function makeShortPendingRound(): TRoundArchive {
    return makeRound({
      id: 'r1',
      fullCode: CODE,
      status: 'OPENED',
      mode: 'short',
      openedAt: '2026-08-13T01:00:00.000Z',
      transactions: [
        makeTxn({ id: 't1', fullCode: CODE, direction: 'sell', price: 17.43, amount: 200, fee: 0, timestamp: '2026-08-13T01:00:00.000Z' }),
        makeTxn({ id: 't2', fullCode: CODE, direction: 'buy', price: 16, amount: 100, fee: 0, timestamp: '2026-08-13T02:00:00.000Z' }),
      ],
    });
  }

  const BASE_SRC = {
    positions: [makeTPosition()],
    plannedOrders: [],
    feeConfig: DEFAULT_FEE_CONFIG,
  };

  it('活跃倒T项目：mode/status/待回补量与撮合管线一致，overview ≤255 字符', () => {
    const ctx = buildTProjectContext(CODE, { ...BASE_SRC, tRounds: [makeShortPendingRound()] });
    expect(ctx.overview.exists).toBe(true);
    expect(ctx.overview.mode).toBe('short');
    expect(ctx.overview.status).toBe('PARTIAL'); // 卖 200 买回 100 → 部分回补（引擎口径）
    expect(ctx.overview.pend).toBe(100); // 卖 200 买回 100 → 未回补 100 股
    expect(ctx.overview.shortPend).toBe(100);
    expect(JSON.stringify(ctx.overview).length).toBeLessThanOrEqual(255);
    expect((ctx.detail.recentEntries as unknown[]).length).toBe(2);
    expect(ctx.detail.breakeven).not.toBeNull();
    expect((ctx.detail.completedRounds as unknown[]).length).toBe(0);
  });

  it('行情注入：现价/保本偏离写入 overview；无行情降级省略字段严禁塞 0', () => {
    const withPrice = buildTProjectContext(CODE, {
      ...BASE_SRC,
      tRounds: [makeShortPendingRound()],
      getMarketPrice: (code) => (code === CODE ? 17 : undefined),
    });
    expect(withPrice.overview.px).toBe(17);
    expect(withPrice.overview.beGapPct).toBeDefined();
    expect(withPrice.detail.currentPrice).toBe(17);

    const withoutPrice = buildTProjectContext(CODE, {
      ...BASE_SRC,
      tRounds: [makeShortPendingRound()],
    });
    expect(withoutPrice.overview.px).toBeUndefined();
    expect(withoutPrice.overview.beGapPct).toBeUndefined();
    expect(withoutPrice.detail.currentPrice).toBeNull();
  });

  it('无活跃项目（已结清）：exists=false 降级，仅输出该标的归档战报统计', () => {
    const ctx = buildTProjectContext(CODE, {
      tRounds: [
        makeRound({ id: 'r9', fullCode: CODE, status: 'COMPLETED', netProfit: 88, win: true, closedAt: '2026-01-02T00:00:00.000Z' }),
        // 其他标的的轮次不串入
        makeRound({ id: 'r10', fullCode: 'sz000858', status: 'COMPLETED', netProfit: 999, win: true, closedAt: '2026-01-03T00:00:00.000Z' }),
      ],
      positions: [],
      plannedOrders: [],
      feeConfig: DEFAULT_FEE_CONFIG,
    });
    expect(ctx.overview.exists).toBe(false);
    expect(ctx.overview.doneRounds).toBe(1);
    expect(ctx.overview.wins).toBe(1);
    expect(ctx.overview.doneNetProfit).toBe(88);
    expect((ctx.detail.completedRounds as unknown[]).length).toBe(1);
  });
});

describe('buildLedgerPositionContext（V2 推广：实盘账本按标的）', () => {
  const CODE = 'sh600519';

  function makeLedgerPosition(): Position {
    return makePosition({
      id: 'p1',
      fullCode: CODE,
      openAt: '2026-01-01T00:00:00.000Z',
      batches: [
        { id: 'b1', timestamp: '2026-01-01T00:00:00.000Z', type: 'open', price: 10, amount: 1000, costAfter: 10, amountAfter: 1000 },
        { id: 'b2', timestamp: '2026-02-01T00:00:00.000Z', type: 'add', price: 12, amount: 500, costAfter: 10.67, amountAfter: 1500 },
        { id: 'b3', timestamp: '2026-03-01T00:00:00.000Z', type: 'reduce', price: 15, amount: -200, costAfter: 10.67, amountAfter: 1300 },
        // 倒T出借批次：只减数量不记盈亏
        { id: 'b4', timestamp: '2026-03-02T00:00:00.000Z', type: 'reduce', price: 16, amount: -100, costAfter: 10.67, amountAfter: 1200, kind: 'borrow' },
      ],
    });
  }

  it('批次履历重算口径与视图 recalculatePosition 一致；出借量入 overview；overview ≤255 字符', () => {
    const pos = makeLedgerPosition();
    const expected = recalculatePosition(
      pos.batches.map((b) => ({ ...b, positionId: pos.id, timestamp: new Date(b.timestamp).getTime() }) as PositionBatchEntity),
    );
    const ctx = buildLedgerPositionContext(CODE, {
      tRounds: [],
      positions: [pos],
      plannedOrders: [],
      feeConfig: DEFAULT_FEE_CONFIG,
    });
    expect(ctx.overview.exists).toBe(true);
    expect(ctx.overview.open).toBe(true);
    expect(ctx.overview.amount).toBe(expected.currentAmount);
    expect(ctx.overview.cost).toBe(Number(expected.currentCost.toFixed(3)));
    expect(ctx.overview.tprofit).toBe(Number(expected.accumulatedTPnL.toFixed(2)));
    expect(ctx.overview.borrow).toBe(100);
    expect(JSON.stringify(ctx.overview).length).toBeLessThanOrEqual(255);
    expect((ctx.detail.recentBatches as unknown[]).length).toBe(4);
  });

  it('行情注入浮盈/回本涨幅；无行情降级省略字段严禁塞 0；该标的做T战报统计归集', () => {
    const pos = makeLedgerPosition();
    const src = {
      tRounds: [
        makeRound({ id: 'r1', fullCode: CODE, status: 'COMPLETED', netProfit: 120, win: true, closedAt: '2026-02-02T00:00:00.000Z' }),
        makeRound({ id: 'r2', fullCode: CODE, status: 'COMPLETED', netProfit: -30, win: false, closedAt: '2026-03-02T00:00:00.000Z' }),
        // 其他标的战报不串入
        makeRound({ id: 'rx', fullCode: 'sz000858', status: 'COMPLETED', netProfit: 999, win: true, closedAt: '2026-03-03T00:00:00.000Z' }),
      ],
      positions: [pos],
      plannedOrders: [],
      feeConfig: DEFAULT_FEE_CONFIG,
    };

    const withPrice = buildLedgerPositionContext(CODE, { ...src, getMarketPrice: (c) => (c === CODE ? 12.5 : undefined) });
    expect(withPrice.overview.px).toBe(12.5);
    expect(withPrice.overview.float).toBeDefined();
    expect(withPrice.overview.floatPct).toBeDefined();
    expect(withPrice.overview.reportCount).toBe(2);
    expect(withPrice.overview.reportWins).toBe(1);
    expect((withPrice.detail.tReports as { netProfit: number }).netProfit).toBe(90);

    const withoutPrice = buildLedgerPositionContext(CODE, src);
    expect(withoutPrice.overview.px).toBeUndefined();
    expect(withoutPrice.overview.float).toBeUndefined();
    expect(withoutPrice.overview.floatPct).toBeUndefined();
    expect(withoutPrice.detail.currentPrice).toBeNull();
    expect(withoutPrice.detail.requiredRisePercent).toBeNull();
  });

  it('持仓不存在：exists=false 降级，仅输出该标的做T战报统计', () => {
    const ctx = buildLedgerPositionContext(CODE, {
      tRounds: [makeRound({ id: 'r1', fullCode: CODE, status: 'COMPLETED', netProfit: 120, win: true })],
      positions: [],
      plannedOrders: [],
      feeConfig: DEFAULT_FEE_CONFIG,
    });
    expect(ctx.overview.exists).toBe(false);
    expect(ctx.overview.reportCount).toBe(1);
    expect(ctx.detail.fullCode).toBe(CODE);
  });

  it('已结仓兑底：仅剩 closed 持仓时仍可取数，open=false', () => {
    const onlyClosed = buildLedgerPositionContext(CODE, {
      tRounds: [],
      positions: [{ ...makeLedgerPosition(), isClosed: true, currentAmount: 0 }],
      plannedOrders: [],
      feeConfig: DEFAULT_FEE_CONFIG,
    });
    expect(onlyClosed.overview.exists).toBe(true);
    expect(onlyClosed.overview.open).toBe(false);
  });
});
