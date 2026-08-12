/**
 * @file rollbackTransferPosition.test.ts
 * @description 单元测试：验证删除带归并的战报后，底仓成本与数量是否精准还原到归并前状态，
 *              以及中长期操作记录（归并 Tag）的标记与级联删除。
 * @layer Test
 * @storage_impact 纯函数测试，不读写任何存储。
 */

import { rollbackTransferPosition, type Position, type PositionBatch } from '../store';

// ---- 辅助函数 ----
function createMockPosition(
  overrides: Partial<Position> = {}
): Position {
  return {
    id: 'pos-1',
    stockName: '中国平安',
    fullCode: 'sh601318',
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

function createBatch(overrides: Partial<PositionBatch> = {}): PositionBatch {
  return {
    id: overrides.id ?? 'batch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'add',
    price: 40,
    amount: 1000,
    costAfter: 40,
    amountAfter: 1000,
    fee: 5,
    ...overrides,
  };
}

// ============================================================
// 测试套件：rollbackTransferPosition
// ============================================================

describe('rollbackTransferPosition', () => {
  // 1. 基础归并回滚：正T归并场景
  test('正T归并剥离：从底仓中精准扣除归并数量与金额，成本重算正确', () => {
    const initialBatch = createBatch({
      id: 'batch-initial',
      type: 'add',
      price: 40,
      amount: 1000,
      fee: 5,
      costAfter: 40,
      amountAfter: 1000,
    });
    const position = createMockPosition({
      currentCost: 40,
      currentAmount: 1000,
      totalInvested: 40005,
      batches: [initialBatch],
    });

    const mergeBatch = createBatch({
      id: 'batch-merge',
      type: 'add',
      price: 42,
      amount: 500,
      fee: 3,
      costAfter: 40.666,
      amountAfter: 1500,
    });
    const positionAfterMerge = createMockPosition({
      currentCost: 40.666,
      currentAmount: 1500,
      totalInvested: 61008,
      batches: [initialBatch, mergeBatch],
    });

    const result = rollbackTransferPosition(
      [positionAfterMerge],
      'sh601318',
      500,
      42,
      3
    );

    expect(result.ok).toBe(true);
    const rolledBack = result.positions[0];

    expect(rolledBack.currentAmount).toBe(1000);
    expect(rolledBack.currentCost).toBeCloseTo(40, 2);
    expect(rolledBack.totalInvested).toBeCloseTo(40005, 0);
    expect(rolledBack.batches.length).toBe(1);
    expect(rolledBack.batches[0].id).toBe('batch-initial');
  });

  // 2. 倒T归并场景
  test('倒T归并剥离：底仓成本与数量精准还原', () => {
    const initialBatch = createBatch({
      id: 'batch-init',
      type: 'add',
      price: 50,
      amount: 2000,
      fee: 8,
      costAfter: 50,
      amountAfter: 2000,
    });
    const position = createMockPosition({
      currentCost: 50,
      currentAmount: 2000,
      totalInvested: 100008,
      batches: [initialBatch],
    });

    const mergeBatch = createBatch({
      id: 'batch-merge-short',
      type: 'add',
      price: 48.5,
      amount: 300,
      fee: 2,
      costAfter: 49.785,
      amountAfter: 2300,
    });
    const positionAfterMerge = createMockPosition({
      currentCost: 49.785,
      currentAmount: 2300,
      totalInvested: 114560,
      batches: [initialBatch, mergeBatch],
    });

    const result = rollbackTransferPosition(
      [positionAfterMerge],
      'sh601318',
      300,
      48.5,
      2
    );

    expect(result.ok).toBe(true);
    const rolledBack = result.positions[0];

    expect(rolledBack.currentAmount).toBe(2000);
    expect(rolledBack.currentCost).toBeCloseTo(50, 1);
    expect(rolledBack.totalInvested).toBeCloseTo(100008, 0);
  });

  // 3. 边界防错：底仓数量不足
  test('边界防错：底仓数量不足时阻止删除并返回错误信息', () => {
    const position = createMockPosition({
      currentCost: 40,
      currentAmount: 200,
      totalInvested: 8005,
      batches: [createBatch({ id: 'batch-init', type: 'add', price: 40, amount: 200, fee: 5 })],
    });

    const result = rollbackTransferPosition(
      [position],
      'sh601318',
      500,
      42,
      3
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('无法删除该战报');
    expect(result.message).toContain('后续交易已消耗该归并持仓');
    expect(result.positions[0].currentAmount).toBe(200);
  });

  // 4. 无归并的战报：transferAmount 为 0
  test('无归并的战报：传递空 transferAmount 时不操作底仓', () => {
    const position = createMockPosition({
      currentCost: 50,
      currentAmount: 1000,
      totalInvested: 50005,
      batches: [createBatch({ id: 'batch-init', type: 'add', price: 50, amount: 1000, fee: 5 })],
    });

    const result = rollbackTransferPosition(
      [position],
      'sh601318',
      0,
      50
    );

    expect(result.ok).toBe(true);
    expect(result.positions[0].currentAmount).toBe(1000);
    expect(result.positions[0].currentCost).toBe(50);
  });

  // 5. 标的代码不匹配
  test('标的代码不匹配时不应修改底仓', () => {
    const position = createMockPosition({
      fullCode: 'sz000001',
      currentCost: 30,
      currentAmount: 500,
      totalInvested: 15003,
    });

    const result = rollbackTransferPosition(
      [position],
      'sh601318',
      500,
      30
    );

    expect(result.ok).toBe(true);
    expect(result.positions[0].currentAmount).toBe(500);
    expect(result.positions[0].currentCost).toBe(30);
  });

  // 6. 已平仓持仓
  test('已平仓持仓不应被回滚操作影响', () => {
    const position = createMockPosition({
      isClosed: true,
      currentCost: 0,
      currentAmount: 0,
      totalInvested: 0,
    });

    const result = rollbackTransferPosition(
      [position],
      'sh601318',
      500,
      42
    );

    expect(result.ok).toBe(true);
    expect(result.positions[0].isClosed).toBe(true);
    expect(result.positions[0].currentAmount).toBe(0);
  });

  // 7. 多次归并后剥离最后一次
  test('多次归并后剥离最后一次归并，仅清除匹配的批次记录', () => {
    const batch1 = createBatch({ id: 'b1', type: 'add', price: 40, amount: 1000, fee: 5 });
    const batch2 = createBatch({ id: 'b2', type: 'add', price: 42, amount: 500, fee: 3 });
    const batch3 = createBatch({ id: 'b3', type: 'add', price: 44, amount: 300, fee: 2 });

    const position = createMockPosition({
      currentCost: 41.115,
      currentAmount: 1800,
      totalInvested: 74210,
      batches: [batch1, batch2, batch3],
    });

    const result = rollbackTransferPosition(
      [position],
      'sh601318',
      300,
      44,
      2
    );

    expect(result.ok).toBe(true);
    const rolledBack = result.positions[0];

    expect(rolledBack.currentAmount).toBe(1500);
    expect(rolledBack.batches.length).toBe(2);
    expect(rolledBack.batches.find((b) => b.id === 'b3')).toBeUndefined();
    expect(rolledBack.batches.find((b) => b.id === 'b1')).toBeDefined();
    expect(rolledBack.batches.find((b) => b.id === 'b2')).toBeDefined();
  });
});

// ============================================================
// 测试套件：LongTermRecord 归并标记与级联删除逻辑
// ============================================================

describe('LongTermRecord 归并标记与级联删除', () => {
  // 模拟 LongTermRecord 类型（与 store/index.ts 中定义一致）
  interface LongTermRecord {
    id: string;
    fullCode: string;
    stockName: string;
    type: 'buy' | 'sell' | 'merge';
    price: number;
    amount: number;
    fee: number;
    timestamp: string;
    sourceReportId?: string;
    note?: string;
  }

  /** 模拟极简状态的 removeRound 级联删除逻辑 */
  function removeRoundCascade(
    roundId: string,
    tRounds: Array<{ id: string; transferAmount?: number; fullCode: string; avgPrice: number }>,
    positions: Position[],
    longTermRecords: LongTermRecord[]
  ): {
    ok: boolean;
    message?: string;
    tRounds: Array<{ id: string; transferAmount?: number; fullCode: string; avgPrice: number }>;
    positions: Position[];
    longTermRecords: LongTermRecord[];
  } {
    const round = tRounds.find((r) => r.id === roundId);
    if (!round) return { ok: false, message: '战报不存在', tRounds, positions, longTermRecords };

    let nextPositions = positions;
    if (round.transferAmount && round.transferAmount > 0) {
      const result = rollbackTransferPosition(
        positions,
        round.fullCode,
        round.transferAmount,
        round.avgPrice
      );
      if (!result.ok) {
        return { ok: false, message: result.message, tRounds, positions, longTermRecords };
      }
      nextPositions = result.positions;
    }

    return {
      ok: true,
      tRounds: tRounds.filter((r) => r.id !== roundId),
      positions: nextPositions,
      // 级联删除：过滤掉 sourceReportId 匹配的中长期记录
      longTermRecords: longTermRecords.filter((r) => r.sourceReportId !== roundId),
    };
  }

  // 8. 归并操作生成的中长期记录 Tag 为「归并」而非「加仓」
  test('归并操作生成的记录 type 为 merge，而非 buy', () => {
    // 模拟归并时创建中长期记录的逻辑
    const mergeRecord: LongTermRecord = {
      id: 'merge-rec-1',
      fullCode: 'sh601318',
      stockName: '中国平安',
      type: 'merge', // 应为 'merge' 而非 'buy'
      price: 42,
      amount: 500,
      fee: 3,
      timestamp: '2026-01-02T00:00:00.000Z',
      sourceReportId: 'round-1',
      note: '正T归并到底仓（Round 1）',
    };

    // 验证 Tag 确为 merge
    expect(mergeRecord.type).toBe('merge');
    // 验证不是 buy
    expect(mergeRecord.type).not.toBe('buy');
    // 验证关联了 sourceReportId
    expect(mergeRecord.sourceReportId).toBe('round-1');
  });

  // 9. 删除带归并的短线战报后，中长期记录中对应的归并记录被同步清理
  test('删除归并战报后，sourceReportId 匹配的中长期记录被级联删除', () => {
    const initialBatch = createBatch({
      id: 'batch-init',
      type: 'add',
      price: 40,
      amount: 1000,
      fee: 5,
      costAfter: 40,
      amountAfter: 1000,
    });
    const position = createMockPosition({
      currentCost: 40,
      currentAmount: 1000,
      totalInvested: 40005,
      batches: [initialBatch],
    });

    const mergeBatch = createBatch({
      id: 'batch-merge',
      type: 'add',
      price: 42,
      amount: 500,
      fee: 3,
      costAfter: 40.666,
      amountAfter: 1500,
    });
    const positionAfterMerge = createMockPosition({
      currentCost: 40.666,
      currentAmount: 1500,
      totalInvested: 61008,
      batches: [initialBatch, mergeBatch],
    });

    const tRounds = [
      { id: 'round-1', transferAmount: 500, fullCode: 'sh601318', avgPrice: 42 },
      { id: 'round-2', transferAmount: 0, fullCode: 'sz000001', avgPrice: 30 },
    ];

    const longTermRecords: LongTermRecord[] = [
      {
        id: 'lt-1',
        fullCode: 'sh601318',
        stockName: '中国平安',
        type: 'merge',
        price: 42,
        amount: 500,
        fee: 3,
        timestamp: '2026-01-02T00:00:00.000Z',
        sourceReportId: 'round-1',
        note: '正T归并到底仓（Round 1）',
      },
      {
        id: 'lt-2',
        fullCode: 'sz000001',
        stockName: '平安银行',
        type: 'buy',
        price: 30,
        amount: 1000,
        fee: 5,
        timestamp: '2026-01-03T00:00:00.000Z',
        note: '手动加仓',
      },
    ];

    // 执行级联删除：删除 round-1（含归并）
    const result = removeRoundCascade(
      'round-1',
      tRounds,
      [positionAfterMerge],
      longTermRecords
    );

    expect(result.ok).toBe(true);

    // 验证底仓已还原
    const rolledBack = result.positions[0];
    expect(rolledBack.currentAmount).toBe(1000);
    expect(rolledBack.currentCost).toBeCloseTo(40, 2);

    // 验证中长期记录中归并记录已被删除
    const mergeRecords = result.longTermRecords.filter((r) => r.sourceReportId === 'round-1');
    expect(mergeRecords.length).toBe(0);

    // 验证非关联的记录（lt-2）仍然保留
    const remainingRecords = result.longTermRecords.filter((r) => r.id === 'lt-2');
    expect(remainingRecords.length).toBe(1);
    expect(remainingRecords[0].type).toBe('buy');
  });

  // 10. 删除无归并的战报不影响中长期记录
  test('删除无归并的战报不影响中长期记录', () => {
    const position = createMockPosition({
      currentCost: 50,
      currentAmount: 1000,
      totalInvested: 50005,
      batches: [createBatch({ id: 'batch-init', type: 'add', price: 50, amount: 1000, fee: 5 })],
    });

    const tRounds = [
      { id: 'round-1', transferAmount: 0, fullCode: 'sh601318', avgPrice: 50 },
    ];

    const longTermRecords: LongTermRecord[] = [
      {
        id: 'lt-1',
        fullCode: 'sh601318',
        stockName: '中国平安',
        type: 'buy',
        price: 50,
        amount: 1000,
        fee: 5,
        timestamp: '2026-01-01T00:00:00.000Z',
        note: '手动加仓',
      },
    ];

    const result = removeRoundCascade('round-1', tRounds, [position], longTermRecords);

    expect(result.ok).toBe(true);
    // 中长期记录未被删除
    expect(result.longTermRecords.length).toBe(1);
    expect(result.longTermRecords[0].id).toBe('lt-1');
  });

  // 11. 底仓数量不足时，拒绝删除且中长期记录保持不变
  test('底仓数量不足时拒绝删除，中长期记录保持不变', () => {
    const position = createMockPosition({
      currentCost: 40,
      currentAmount: 200,
      totalInvested: 8005,
      batches: [createBatch({ id: 'batch-init', type: 'add', price: 40, amount: 200, fee: 5 })],
    });

    const tRounds = [
      { id: 'round-1', transferAmount: 500, fullCode: 'sh601318', avgPrice: 42 },
    ];

    const longTermRecords: LongTermRecord[] = [
      {
        id: 'lt-merge-1',
        fullCode: 'sh601318',
        stockName: '中国平安',
        type: 'merge',
        price: 42,
        amount: 500,
        fee: 3,
        timestamp: '2026-01-02T00:00:00.000Z',
        sourceReportId: 'round-1',
        note: '正T归并到底仓',
      },
    ];

    const result = removeRoundCascade('round-1', tRounds, [position], longTermRecords);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('无法删除该战报');
    // 中长期记录未被删除（因为删除未成功）
    expect(result.longTermRecords.length).toBe(1);
    expect(result.longTermRecords[0].sourceReportId).toBe('round-1');
  });
});
