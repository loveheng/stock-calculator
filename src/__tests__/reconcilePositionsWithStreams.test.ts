/**
 * @file reconcilePositionsWithStreams.test.ts
 * @description 单元测试：倒T 超额买回归并到底仓后，删除/清空流水池时，
 *              归并批次与倒T扣减必须随流水删除而正确回滚。
 *
 *              场景（Bug 回归）：底仓 1000 股 @24.11
 *                卖出 200 股 @17.43（倒T首笔卖出 → 扣减底仓 200）
 *                买入 300 股 @16.00（超额 100 股 → 归并底仓）
 *                → 删除买入流水：100 股归并必须撤销（回到扣减后 800 股）
 *                → 再删除卖出流水：200 股扣减必须撤销（回到基线 1000 股）
 * @layer Test
 * @storage_impact 纯函数测试，不读写任何存储。
 */

import { describe, test, expect } from 'vitest';
import { reconcilePositionsWithStreams, type Position, type PositionBatch } from '../store';
import type { TStreamRecord } from '../types/tStrategy';
import type { FeeConfig } from '../utils/mathUtils';

// ---- 测试用费率配置（与 tStreamEngine.test.ts 一致） ----
const FEE_CONFIG: FeeConfig = {
  commissionRate: 0.00025,
  isFreeFive: false,
  minCommission: 0.5,
  stampRate: 0.0005,
  transferRate: 0.00001,
};

// ---- 辅助函数 ----
function createMockPosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'pos-1',
    stockName: '浦发银行',
    fullCode: 'sh600000',
    currentCost: 0,
    currentAmount: 0,
    batches: [],
    isClosed: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    realizedPnL: 0,
    totalInvested: 0,
    ...overrides,
  };
}

function createStream(overrides: Partial<TStreamRecord> & { direction: 'buy' | 'sell'; price: number; amount: number }): TStreamRecord {
  return {
    id: overrides.id ?? `tx-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: overrides.timestamp ?? '2026-08-13T01:00:00.000Z',
    fullCode: 'sh600000',
    stockName: '浦发银行',
    fee: 0,
    ...overrides,
  };
}

/** 底仓基线：1000 股 @24.11 */
function basePosition(): Position {
  const batch: PositionBatch = {
    id: 'batch-open',
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'open',
    price: 24.11,
    amount: 1000,
    costAfter: 24.11,
    amountAfter: 1000,
  };
  return createMockPosition({
    currentCost: 24.11,
    currentAmount: 1000,
    totalInvested: 24110,
    batches: [batch],
  });
}

describe('reconcilePositionsWithStreams 倒T 归并随流水删除而回滚（Bug 回归）', () => {
  test('基线：无流水时持仓保持批次履历状态不变', () => {
    const { positions } = reconcilePositionsWithStreams([basePosition()], [], FEE_CONFIG);
    const p = positions[0];
    expect(p.currentAmount).toBe(1000);
    expect(p.currentCost).toBeCloseTo(24.11, 3);
    expect(p.batches.length).toBe(1);
  });

  test('新增卖出 200：底仓扣减 200 → 800 股，成本不变', () => {
    const sell = createStream({ id: 's1', direction: 'sell', price: 17.43, amount: 200, timestamp: '2026-08-13T01:00:00.000Z' });
    const { positions, streams } = reconcilePositionsWithStreams([basePosition()], [sell], FEE_CONFIG);
    const p = positions[0];
    expect(p.currentAmount).toBe(800);
    expect(p.currentCost).toBeCloseTo(24.11, 3);
    // 出借批次已写入履历（kind='borrow'）
    expect(p.batches.length).toBe(2);
    expect(p.batches[1].kind).toBe('borrow');
    expect(p.batches[1].amount).toBe(-200);
    expect(streams[0].baseDeductedAmount).toBe(200); // 幂等标记已记录
  });

  test('卖出 200 + 买入 300：超额 100 股归并底仓 → 900 股，加权成本 = (24.11*800+16*100)/900', () => {
    const sell = createStream({ id: 's1', direction: 'sell', price: 17.43, amount: 200, timestamp: '2026-08-13T01:00:00.000Z' });
    const buy = createStream({ id: 'b1', direction: 'buy', price: 16.00, amount: 300, timestamp: '2026-08-13T02:00:00.000Z' });
    const { positions, streams, results } = reconcilePositionsWithStreams([basePosition()], [sell, buy], FEE_CONFIG);

    const p = positions[0];
    expect(p.currentAmount).toBe(900);
    expect(p.currentCost).toBeCloseTo((24.11 * 800 + 16 * 100) / 900, 3);

    // 归并批次已追加：amount=100 @16，note 以「倒T超额归并」开头
    const mergeBatch = p.batches.find((b) => b.note?.startsWith('倒T超额归并'));
    expect(mergeBatch).toBeTruthy();
    expect(mergeBatch!.amount).toBe(100);
    expect(mergeBatch!.price).toBeCloseTo(16, 3);
    expect(mergeBatch!.type).toBe('add');

    // 撮合结果确认超额量
    const sr = results.find((r) => r.fullCode === 'sh600000');
    expect(sr?.mode).toBe('short');
    expect(sr?.status).toBe('CLEARED');
    expect(sr!.buyAmount - sr!.realizedSellAmount).toBe(100);

    // 幂等标记已记录
    expect(streams.find((s) => s.id === 'b1')?.baseMergedAmount).toBe(100);
    expect(streams.find((s) => s.id === 's1')?.baseDeductedAmount).toBe(200);
  });

  test('删除买入流水：100 股归并随流水删除而撤销 → 回到扣减后 800 股', () => {
    // 先构造「已归并」的持仓状态（等价于 addStreamRecord 后的持久化状态）
    const sell = createStream({ id: 's1', direction: 'sell', price: 17.43, amount: 200, timestamp: '2026-08-13T01:00:00.000Z' });
    const buy = createStream({ id: 'b1', direction: 'buy', price: 16.00, amount: 300, timestamp: '2026-08-13T02:00:00.000Z' });
    const first = reconcilePositionsWithStreams([basePosition()], [sell, buy], FEE_CONFIG);
    expect(first.positions[0].currentAmount).toBe(900);

    // 删除买入流水（模拟 removeStreamRecord）
    const { positions, streams } = reconcilePositionsWithStreams(first.positions, [sell], FEE_CONFIG);
    const p = positions[0];

    // 归并的 100 股已撤销：900 - 100 = 800，成本还原为 24.11
    expect(p.currentAmount).toBe(800);
    expect(p.currentCost).toBeCloseTo(24.11, 3);

    // 归并批次已随流水删除而剥离
    const mergeBatch = p.batches.find((b) => b.note?.startsWith('倒T超额归并'));
    expect(mergeBatch).toBeUndefined();
    // 卖出扣减对应的出借批次保留（卖出流水仍在）
    expect(p.batches.length).toBe(2);
    expect(p.batches.find((b) => b.kind === 'borrow')).toBeDefined();

    // 卖出扣减保留（卖出流水仍在）
    expect(streams.find((s) => s.id === 's1')?.baseDeductedAmount).toBe(200);
  });

  test('再删除卖出流水：200 股扣减随流水删除而撤销 → 回到基线 1000 股', () => {
    const sell = createStream({ id: 's1', direction: 'sell', price: 17.43, amount: 200, timestamp: '2026-08-13T01:00:00.000Z' });
    const buy = createStream({ id: 'b1', direction: 'buy', price: 16.00, amount: 300, timestamp: '2026-08-13T02:00:00.000Z' });
    const first = reconcilePositionsWithStreams([basePosition()], [sell, buy], FEE_CONFIG);

    // 先删买入，再删卖出（完整倒T 删除）
    const afterBuyDeleted = reconcilePositionsWithStreams(first.positions, [sell], FEE_CONFIG);
    const { positions } = reconcilePositionsWithStreams(afterBuyDeleted.positions, [], FEE_CONFIG);
    const p = positions[0];

    expect(p.currentAmount).toBe(1000);
    expect(p.currentCost).toBeCloseTo(24.11, 3);
    expect(p.batches.length).toBe(1);
    expect(p.isClosed).toBe(false);
  });

  test('清空流水池（clearStreams 路径）：归并与扣减全部撤销 → 回到基线', () => {
    const sell = createStream({ id: 's1', direction: 'sell', price: 17.43, amount: 200, timestamp: '2026-08-13T01:00:00.000Z' });
    const buy = createStream({ id: 'b1', direction: 'buy', price: 16.00, amount: 300, timestamp: '2026-08-13T02:00:00.000Z' });
    const first = reconcilePositionsWithStreams([basePosition()], [sell, buy], FEE_CONFIG);
    expect(first.positions[0].currentAmount).toBe(900);

    const { positions } = reconcilePositionsWithStreams(first.positions, [], FEE_CONFIG);
    const p = positions[0];
    expect(p.currentAmount).toBe(1000);
    expect(p.currentCost).toBeCloseTo(24.11, 3);
    expect(p.batches.length).toBe(1);
  });

  test('幂等：对已归并状态重复执行相同流水池，不重复归并/扣减', () => {
    const sell = createStream({ id: 's1', direction: 'sell', price: 17.43, amount: 200, timestamp: '2026-08-13T01:00:00.000Z' });
    const buy = createStream({ id: 'b1', direction: 'buy', price: 16.00, amount: 300, timestamp: '2026-08-13T02:00:00.000Z' });
    const first = reconcilePositionsWithStreams([basePosition()], [sell, buy], FEE_CONFIG);
    const second = reconcilePositionsWithStreams(first.positions, [sell, buy], FEE_CONFIG);

    const p = second.positions[0];
    expect(p.currentAmount).toBe(900);
    expect(p.currentCost).toBeCloseTo((24.11 * 800 + 16 * 100) / 900, 3);

    // 归并批次只应存在一条（100 股），不得重复叠加
    const mergeBatches = p.batches.filter((b) => b.note?.startsWith('倒T超额归并'));
    expect(mergeBatches.length).toBe(1);
    expect(mergeBatches[0].amount).toBe(100);
  });
});

