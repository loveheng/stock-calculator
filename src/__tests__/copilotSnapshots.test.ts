/**
 * @file copilotSnapshots.test.ts
 * @description Copilot 快照纯引擎单测：applySizeGuard 体积护栏（透传/裁剪/标量保留）、
 *              buildStatisticsContext（胜率/净收益口径）、buildHomeContext（市值=数量×成本口径）。
 * @layer 测试
 * @author 开发团队
 */

import { describe, it, expect } from 'vitest';
import {
  applySizeGuard,
  buildStatisticsContext,
  buildHomeContext,
} from '../utils/copilotSnapshots';
import { DEFAULT_FEE_CONFIG } from '../utils/feePresets';
import type { CopilotContextData, Position, TRoundArchive } from '../types/domain';

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
});
