/**
 * @file roundLifecycle.test.ts
 * @description v8 数据模型回归测试：Round 生命周期 ——
 *              首笔流水创建 OPENED Round → 撮合 CLEARED 时复用同一 Round 标记 COMPLETED
 *              （不再新建/重复归档）→ 再次录入创建新 OPENED Round（跨轮隔离）。
 *              验证「单标的单 OPENED Round」规则与活跃流水派生。
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { useAppStore, DEFAULT_FEE_CONFIG, activeStreamsFromRounds, type Position, type PositionBatch } from '../store';
import type { TStreamRecord } from '../types/tStrategy';

function basePosition(): Position {
  return {
    id: 'p1', stockName: '浦发银行', fullCode: 'sh600000',
    currentCost: 24.11, currentAmount: 1000,
    batches: [{ id: 'b-open', timestamp: '2026-08-01T00:00:00.000Z', type: 'open', price: 24.11, amount: 1000, costAfter: 24.11, amountAfter: 1000 }] as PositionBatch[],
    isClosed: false, createdAt: '2026-08-01T00:00:00.000Z', realizedPnL: 0, totalInvested: 24110,
  };
}

function makeStream(overrides: Partial<TStreamRecord>): TStreamRecord {
  return {
    id: overrides.id ?? 'tx',
    timestamp: overrides.timestamp ?? '2026-08-13T01:00:00.000Z',
    fullCode: 'sh600000',
    stockName: '浦发银行',
    fee: 0,
    ...overrides,
  } as TStreamRecord;
}

describe('v8 Round 生命周期（tRounds + tTransactions，无 tStreams）', () => {
  beforeEach(() => {
    useAppStore.setState({
      feeConfig: { ...DEFAULT_FEE_CONFIG },
      tRounds: [],
      positions: [],
      longTermRecords: [],
      coreDataLoaded: true,
    });
  });

  test('首笔流水创建 OPENED Round；CLEARED 时复用同一 Round 标记 COMPLETED（不重复归档）', () => {
    useAppStore.setState({ positions: [basePosition()] });

    // 倒T：先卖 200 → 创建 OPENED Round
    const sell = makeStream({ id: 's1', direction: 'sell', price: 17.43, amount: 200, timestamp: '2026-08-13T01:00:00.000Z' });
    useAppStore.getState().addStreamRecord(sell);
    let rounds = useAppStore.getState().tRounds;
    expect(rounds).toHaveLength(1);
    expect(rounds[0].status ?? 'OPENED').toBe('OPENED');
    expect(rounds[0].transactions?.map((t) => t.id)).toEqual(['s1']);
    const roundId1 = rounds[0].id;

    // 买回 200 → CLEARED → 同一 Round COMPLETED
    const buy = makeStream({ id: 'b1', direction: 'buy', price: 16.0, amount: 200, timestamp: '2026-08-13T02:00:00.000Z' });
    const res = useAppStore.getState().addStreamRecord(buy);
    expect(res.cleared).toBe(true);
    rounds = useAppStore.getState().tRounds;
    expect(rounds).toHaveLength(1); // 不重复归档
    expect(rounds[0].id).toBe(roundId1); // 复用同一 Round
    expect(rounds[0].status).toBe('COMPLETED');
    expect(rounds[0].closedAt).toBeTruthy();
    expect(rounds[0].netProfit).toBeCloseTo(res.netProfit ?? 0, 3);
    // 活跃池为空：COMPLETED Round 的流水退出撮合
    expect(activeStreamsFromRounds(rounds)).toHaveLength(0);
  });

  test('CLEARED 后再录新流水创建新 OPENED Round（跨轮隔离，修复原重复归档缺陷）', () => {
    useAppStore.setState({ positions: [basePosition()] });
    const sell = makeStream({ id: 's1', direction: 'sell', price: 17.43, amount: 200, timestamp: '2026-08-13T01:00:00.000Z' });
    const buy = makeStream({ id: 'b1', direction: 'buy', price: 16.0, amount: 200, timestamp: '2026-08-13T02:00:00.000Z' });
    useAppStore.getState().addStreamRecord(sell);
    useAppStore.getState().addStreamRecord(buy);
    expect(useAppStore.getState().tRounds[0].status).toBe('COMPLETED');

    // 新一轮卖出 → 新 OPENED Round
    const sell2 = makeStream({ id: 's2', direction: 'sell', price: 17.5, amount: 100, timestamp: '2026-08-13T03:00:00.000Z' });
    useAppStore.getState().addStreamRecord(sell2);
    const rounds = useAppStore.getState().tRounds;
    expect(rounds).toHaveLength(2);
    const opened = rounds.filter((r) => (r.status ?? 'OPENED') !== 'COMPLETED');
    expect(opened).toHaveLength(1);
    expect(opened[0].transactions?.map((t) => t.id)).toEqual(['s2']);
    // 活跃池只含新一轮流水
    expect(activeStreamsFromRounds(rounds).map((s) => s.id)).toEqual(['s2']);
  });

  test('两轮倒T各自独立 Round：流水不跨轮污染，均 COMPLETED 且明细完整', () => {
    useAppStore.setState({ positions: [basePosition()] });
    // 第 1 轮
    useAppStore.getState().addStreamRecord(makeStream({ id: 's1', direction: 'sell', price: 17.43, amount: 200, timestamp: '2026-08-13T01:00:00.000Z' }));
    useAppStore.getState().addStreamRecord(makeStream({ id: 'b1', direction: 'buy', price: 16.0, amount: 200, timestamp: '2026-08-13T02:00:00.000Z' }));
    // 第 2 轮
    useAppStore.getState().addStreamRecord(makeStream({ id: 's2', direction: 'sell', price: 17.5, amount: 200, timestamp: '2026-08-13T03:00:00.000Z' }));
    useAppStore.getState().addStreamRecord(makeStream({ id: 'b2', direction: 'buy', price: 15.8, amount: 200, timestamp: '2026-08-13T04:00:00.000Z' }));
    const rounds = useAppStore.getState().tRounds;
    expect(rounds).toHaveLength(2);
    expect(rounds.every((r) => r.status === 'COMPLETED')).toBe(true);
    // 每轮只含自己的流水（无跨轮污染）
    expect(rounds[0].transactions?.map((t) => t.id).sort()).toEqual(['b1', 's1']);
    expect(rounds[1].transactions?.map((t) => t.id).sort()).toEqual(['b2', 's2']);
    expect(activeStreamsFromRounds(rounds)).toHaveLength(0);
  });

  test('removeStreamRecord 删除流水：OPENED Round 流水清空则整轮删除', () => {
    useAppStore.setState({ positions: [basePosition()] });
    const sell = makeStream({ id: 's1', direction: 'sell', price: 17.43, amount: 200, timestamp: '2026-08-13T01:00:00.000Z' });
    useAppStore.getState().addStreamRecord(sell);
    expect(useAppStore.getState().tRounds).toHaveLength(1);
    useAppStore.getState().removeStreamRecord('s1');
    expect(useAppStore.getState().tRounds).toHaveLength(0);
  });

  test('transferToPosition 划转：复用 OPENED Round 结清，不新建', () => {
    useAppStore.setState({ positions: [basePosition()] });
    // 正T：买 100 卖 50 → 剩余 50 股待处理 → 划转底仓
    useAppStore.getState().addStreamRecord(makeStream({ id: 'b1', direction: 'buy', price: 16, amount: 100, timestamp: '2026-08-13T01:00:00.000Z' }));
    useAppStore.getState().addStreamRecord(makeStream({ id: 's1', direction: 'sell', price: 17, amount: 50, timestamp: '2026-08-13T02:00:00.000Z' }));
    const before = useAppStore.getState().tRounds;
    expect(before).toHaveLength(1);
    expect(before[0].status ?? 'OPENED').toBe('OPENED');
    const roundId = before[0].id;

    const res = useAppStore.getState().transferToPosition('sh600000');
    expect(res.ok).toBe(true);
    const after = useAppStore.getState().tRounds;
    expect(after).toHaveLength(1); // 复用同一 Round
    expect(after[0].id).toBe(roundId);
    expect(after[0].status).toBe('COMPLETED');
    expect(after[0].settleType).toBe('partial');
    expect(after[0].transferAmount).toBe(50);
    // 底仓增加 50 股（1000 + 50）
    const pos = useAppStore.getState().positions.find((p) => p.fullCode === 'sh600000');
    expect(pos?.currentAmount).toBe(1050);
    expect(activeStreamsFromRounds(after)).toHaveLength(0);
  });

  test('settleShortRound 结算：复用 OPENED Round 结清，流水保留为归档明细', () => {
    useAppStore.setState({ positions: [basePosition()] });
    // 倒T：卖 200 买 100 → 100 股已回补，剩余 100 股未回补（引擎 shortPendingAmount=100）
    useAppStore.getState().addStreamRecord(makeStream({ id: 's1', direction: 'sell', price: 17.43, amount: 200, timestamp: '2026-08-13T01:00:00.000Z' }));
    useAppStore.getState().addStreamRecord(makeStream({ id: 'b1', direction: 'buy', price: 16, amount: 100, timestamp: '2026-08-13T02:00:00.000Z' }));
    const before = useAppStore.getState().tRounds;
    expect(before).toHaveLength(1);
    const roundId = before[0].id;

    const res = useAppStore.getState().settleShortRound('sh600000');
    expect(res.ok).toBe(true);
    const after = useAppStore.getState().tRounds;
    expect(after).toHaveLength(1); // 复用同一 Round
    expect(after[0].id).toBe(roundId);
    expect(after[0].status).toBe('COMPLETED');
    expect(after[0].settleType).toBe('partial');
    expect(after[0].netProfit).toBeGreaterThan(0);
    // 归档明细保留全部流水
    expect(after[0].transactions?.map((t) => t.id).sort()).toEqual(['b1', 's1']);
    // 出借批次全部解除；未回补 100 股转为真实卖出 → 底仓 = 1000 - 100 = 900
    const pos = useAppStore.getState().positions.find((p) => p.fullCode === 'sh600000');
    expect(pos?.currentAmount).toBe(900);
    expect(pos?.batches.every((b) => b.kind !== 'borrow')).toBe(true);
    expect(activeStreamsFromRounds(after)).toHaveLength(0);
  });
});
