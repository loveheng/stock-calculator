/**
 * @file recomputePositionSnapshot.test.ts
 * @description 单元测试：验证从批次履历重建持仓快照（成本/数量/已实现盈亏/累计投入）
 *              的「总资金抽回法」计算，覆盖纯建仓 / 加仓摊薄 / 减仓实现盈亏 /
 *              删除加仓与减仓批次后的重建口径。
 * @layer Test
 * @storage_impact 纯函数测试，不读写任何存储。
 */

import { describe, test, expect } from 'vitest';
import { recomputePositionSnapshot, type PositionBatch } from '../store';

// ---- 辅助函数 ----
function createBatch(overrides: Partial<PositionBatch> = {}): PositionBatch {
  return {
    id: 'batch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'open',
    price: 40,
    amount: 1000,
    costAfter: 40,
    amountAfter: 1000,
    fee: 5,
    ...overrides,
  };
}

// ============================================================
// 测试套件：recomputePositionSnapshot
// ============================================================

describe('recomputePositionSnapshot', () => {
  // 1. 空履历：全部归零
  test('空批次：成本/数量/盈亏/投入全部归零', () => {
    const snap = recomputePositionSnapshot([]);
    expect(snap.currentAmount).toBe(0);
    expect(snap.currentCost).toBe(0);
    expect(snap.realizedPnL).toBe(0);
    expect(snap.totalInvested).toBe(0);
  });

  // 2. 纯建仓：成本 = 价格 × 数量 + 规费 摊薄
  test('纯建仓：规费计入成本', () => {
    const snap = recomputePositionSnapshot([
      createBatch({ id: 'open', price: 40, amount: 1000, fee: 5 }),
    ]);
    expect(snap.currentAmount).toBe(1000);
    expect(snap.totalInvested).toBeCloseTo(40005, 2);
    expect(snap.currentCost).toBeCloseTo(40.005, 3);
    expect(snap.realizedPnL).toBe(0);
  });

  // 3. 建仓 + 加仓：加权成本正确
  test('建仓+加仓：加权成本正确', () => {
    const snap = recomputePositionSnapshot([
      createBatch({ id: 'open', timestamp: '2026-01-01T00:00:00.000Z', price: 40, amount: 1000, fee: 5 }),
      createBatch({ id: 'add', timestamp: '2026-01-02T00:00:00.000Z', type: 'add', price: 42, amount: 500, fee: 3 }),
    ]);
    // 投入 = 40*1000+5 + 42*500+3 = 40005 + 21003 = 61008；数量 = 1500
    expect(snap.currentAmount).toBe(1500);
    expect(snap.totalInvested).toBeCloseTo(61008, 2);
    expect(snap.currentCost).toBeCloseTo(61008 / 1500, 3);
    expect(snap.realizedPnL).toBe(0);
  });

  // 4. 建仓 + 减仓：按摊薄成本抽回并累计已实现盈亏
  test('建仓+减仓：按摊薄成本抽回并累计已实现盈亏', () => {
    const snap = recomputePositionSnapshot([
      createBatch({ id: 'open', timestamp: '2026-01-01T00:00:00.000Z', price: 40, amount: 1000, fee: 5 }),
      createBatch({ id: 'reduce', timestamp: '2026-01-03T00:00:00.000Z', type: 'reduce', price: 45, amount: -400, fee: 4 }),
    ]);
    const costBasisPerShare = 40005 / 1000; // 40.005
    const costBasisOfSold = costBasisPerShare * 400;
    const netProceeds = 45 * 400 - 4;
    expect(snap.currentAmount).toBe(600);
    expect(snap.currentCost).toBeCloseTo(costBasisPerShare, 3);
    expect(snap.totalInvested).toBeCloseTo(40005 - costBasisOfSold, 2);
    expect(snap.realizedPnL).toBeCloseTo(netProceeds - costBasisOfSold, 2);
  });

  // 5. 删除加仓批次：等同该笔加仓从未发生
  test('删除加仓批次后重建：与仅保留建仓的履历完全一致', () => {
    const withAdd = [
      createBatch({ id: 'open', timestamp: '2026-01-01T00:00:00.000Z', price: 40, amount: 1000, fee: 5 }),
      createBatch({ id: 'add', timestamp: '2026-01-02T00:00:00.000Z', type: 'add', price: 42, amount: 500, fee: 3 }),
    ];
    const snapAfterDelete = recomputePositionSnapshot(withAdd.filter((b) => b.id !== 'add'));
    const snapOnlyOpen = recomputePositionSnapshot([withAdd[0]]);
    expect(snapAfterDelete.currentAmount).toBe(snapOnlyOpen.currentAmount);
    expect(snapAfterDelete.currentCost).toBeCloseTo(snapOnlyOpen.currentCost, 3);
    expect(snapAfterDelete.totalInvested).toBeCloseTo(snapOnlyOpen.totalInvested, 2);
    expect(snapAfterDelete.realizedPnL).toBe(snapOnlyOpen.realizedPnL);
  });

  // 6. 删除减仓批次：已实现盈亏相应回退，仓位还原
  test('删除减仓批次后重建：已实现盈亏回退、仓位还原', () => {
    const batches = [
      createBatch({ id: 'open', timestamp: '2026-01-01T00:00:00.000Z', price: 40, amount: 1000, fee: 5 }),
      createBatch({ id: 'reduce', timestamp: '2026-01-03T00:00:00.000Z', type: 'reduce', price: 45, amount: -400, fee: 4 }),
    ];
    const snapWithReduce = recomputePositionSnapshot(batches);
    const snapAfterDelete = recomputePositionSnapshot(batches.filter((b) => b.id !== 'reduce'));
    expect(snapWithReduce.realizedPnL).toBeGreaterThan(0);
    expect(snapAfterDelete.realizedPnL).toBe(0);
    expect(snapAfterDelete.currentAmount).toBe(1000);
    expect(snapAfterDelete.currentCost).toBeCloseTo(40.005, 3);
    expect(snapAfterDelete.totalInvested).toBeCloseTo(40005, 2);
  });

  // 7. 顺序敏感：乱序传入时按 timestamp 排序后计算
  test('批次乱序传入：按 timestamp 排序后计算结果一致', () => {
    const unordered = [
      createBatch({ id: 'reduce', timestamp: '2026-01-03T00:00:00.000Z', type: 'reduce', price: 45, amount: -400, fee: 4 }),
      createBatch({ id: 'open', timestamp: '2026-01-01T00:00:00.000Z', price: 40, amount: 1000, fee: 5 }),
    ];
    const ordered = [unordered[1], unordered[0]];
    const snapUnordered = recomputePositionSnapshot(unordered);
    const snapOrdered = recomputePositionSnapshot(ordered);
    expect(snapUnordered.currentAmount).toBe(snapOrdered.currentAmount);
    expect(snapUnordered.currentCost).toBeCloseTo(snapOrdered.currentCost, 3);
    expect(snapUnordered.realizedPnL).toBeCloseTo(snapOrdered.realizedPnL, 2);
    expect(snapUnordered.totalInvested).toBeCloseTo(snapOrdered.totalInvested, 2);
  });
});
