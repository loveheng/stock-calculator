/**
 * @file getCloseBlockReason.test.ts
 * @description 单元测试：验证结案资格校验（未卖出持仓 + 进行中的做T轮次），
 *              覆盖手动结案阻止 / 清仓到0自动结案 / 不同标的隔离等场景。
 * @layer Test
 * @storage_impact 纯函数测试，不读写任何存储。
 */

import { describe, test, expect } from 'vitest';
import {
  getCloseBlockReason,
  type Position,
  type PositionBatch,
  type TRoundArchive,
  type StockStreamResult,
} from '../store';

// ---- 辅助函数：构造测试数据 ----

function createBatch(overrides: Partial<PositionBatch> = {}): PositionBatch {
  return {
    id: 'batch-' + Math.random().toString(36).slice(2, 8),
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

function createPosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'pos-1',
    stockName: '中国平安',
    fullCode: 'sh601318',
    currentCost: 40,
    currentAmount: 1000,
    batches: [createBatch({ id: 'b-open' })],
    isClosed: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    realizedPnL: 0,
    totalInvested: 40005,
    ...overrides,
  };
}

/** 建仓 1000 股后全额减仓的清仓（持仓履历合计为 0） */
const CLEARED_BATCHES: PositionBatch[] = [
  createBatch({
    id: 'b-open',
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'open',
    price: 40,
    amount: 1000,
    costAfter: 40,
    amountAfter: 1000,
    fee: 5,
  }),
  createBatch({
    id: 'b-reduce',
    timestamp: '2026-01-02T00:00:00.000Z',
    type: 'reduce',
    price: 45,
    amount: -1000,
    costAfter: 40,
    amountAfter: 0,
    fee: 4,
  }),
];

function createStreamResult(status: StockStreamResult['status'], overrides: Partial<StockStreamResult> = {}): StockStreamResult {
  return {
    fullCode: 'sh601318',
    stockName: '中国平安',
    realizedPnL: 0,
    realizedFee: 0,
    netPendingAmount: 0,
    weightedBuyCost: 40,
    pendingTotalCost: 0,
    shortPendingAmount: 0,
    mode: 'long',
    status,
    entries: [],
    lastSellRemaining: 0,
    lastSellCleared: status === 'CLEARED',
    roundStarted: true,
    openedAt: '2026-01-02T00:00:00.000Z',
    avgPrice: 40,
    buyAmount: 1000,
    buyTotal: 40000,
    sellAmount: 1000,
    sellValue: 41000,
    realizedSellAmount: 1000,
    realizedSellValue: 41000,
    totalFee: 2,
    transferProfit: 0,
    sellCostTotal: 40000,
    realizedSellCost: 40000,
    tradeCount: 2,
    holdingDays: 1,
    ...overrides,
  };
}

function createRound(overrides: Partial<TRoundArchive> = {}): TRoundArchive {
  return {
    id: 'round-1',
    fullCode: 'sh601318',
    stockName: '中国平安',
    mode: 'long',
    status: 'COMPLETED',
    roundNo: 1,
    settleType: 'clear',
    netProfit: 120,
    openedAt: '2026-01-02T00:00:00.000Z',
    closedAt: '2026-01-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('getCloseBlockReason', () => {
  // 1. 仍有未卖出持仓 → 阻止
  test('仍有未卖出持仓：返回阻止原因并携带剩余数量', () => {
    const reason = getCloseBlockReason(createPosition(), [], []);
    expect(reason).not.toBeNull();
    expect(reason).toContain('1000');
    expect(reason).toContain('未卖出');
  });

  // 2. 清仓到 0 且无做T轮次 → 可自动结案
  test('清仓到 0 且无做T轮次：返回 null（可结案）', () => {
    const pos = createPosition({ currentAmount: 0, batches: CLEARED_BATCHES });
    expect(getCloseBlockReason(pos, [], [])).toBeNull();
  });

  // 3. 清仓到 0 但流水池该标的存在进行中的撮合（PENDING/PARTIAL/SHORT_PENDING）→ 阻止
  test('该标的存在进行中的撮合结果：阻止结案', () => {
    const pos = createPosition({ currentAmount: 0, batches: CLEARED_BATCHES });
    for (const status of ['PENDING', 'PARTIAL', 'SHORT_PENDING'] as const) {
      const reason = getCloseBlockReason(pos, [createStreamResult(status)], []);
      expect(reason).not.toBeNull();
      expect(reason).toContain('做T');
    }
  });

  // 4. 流水池已有 CLEARED 记录（做T已完成，仅残留流水）→ 不阻止
  test('该标的撮合结果已 CLEARED（轮次完成）：可结案', () => {
    const pos = createPosition({ currentAmount: 0, batches: CLEARED_BATCHES });
    expect(getCloseBlockReason(pos, [createStreamResult('CLEARED')], [])).toBeNull();
  });

  // 5. tRounds 存在 OPENED 战报 → 阻止
  test('该标的存在 OPENED 战报：阻止结案', () => {
    const pos = createPosition({ currentAmount: 0, batches: CLEARED_BATCHES });
    const reason = getCloseBlockReason(pos, [], [createRound({ status: 'OPENED', closedAt: undefined })]);
    expect(reason).not.toBeNull();
    expect(reason).toContain('做T');
  });

  // 6. tRounds 仅 COMPLETED 战报 → 可结案
  test('该标的仅存在已完结（COMPLETED）战报：可结案', () => {
    const pos = createPosition({ currentAmount: 0, batches: CLEARED_BATCHES });
    expect(getCloseBlockReason(pos, [], [createRound()])).toBeNull();
  });

  // 7. 内存态已归档战报（无 status 字段但 closedAt 已设置）→ 可结案
  test('内存态已归档战报（无 status 但带 closedAt）：可结案', () => {
    const pos = createPosition({ currentAmount: 0, batches: CLEARED_BATCHES });
    const archived = createRound({ status: undefined, closedAt: '2026-01-03T00:00:00.000Z' });
    expect(getCloseBlockReason(pos, [], [archived])).toBeNull();
  });

  // 8. 无 status 且无 closedAt 的战报（导入的进行中轮次）→ 阻止
  test('无 status 且无 closedAt 的战报：视为进行中，阻止结案', () => {
    const pos = createPosition({ currentAmount: 0, batches: CLEARED_BATCHES });
    const openRound = createRound({ status: undefined, closedAt: undefined });
    const reason = getCloseBlockReason(pos, [], [openRound]);
    expect(reason).not.toBeNull();
    expect(reason).toContain('做T');
  });

  // 9. 其他标的的做T流水/战报不影响本标的
  test('其他标的的做T流水/战报不影响本标的结案', () => {
    const pos = createPosition({ currentAmount: 0, batches: CLEARED_BATCHES });
    const otherResult = createStreamResult('PENDING', { fullCode: 'sz000001', stockName: '平安银行' });
    const otherRound = createRound({ id: 'round-other', fullCode: 'sz000001', stockName: '平安银行', status: 'OPENED', closedAt: undefined });
    expect(getCloseBlockReason(pos, [otherResult], [otherRound])).toBeNull();
  });

  // 10. remainingAmountOverride=0：跳过数量校验，只看做T轮次（清仓到 0 场景）
  test('remainingAmountOverride=0：跳过数量校验，只看做T轮次', () => {
    // 减仓后持股实际已为 0，但 pos.batches 尚未更新（仍累计 > 0）
    const pos = createPosition({ currentAmount: 1000 });
    expect(getCloseBlockReason(pos, [], [], 0)).toBeNull();
    expect(getCloseBlockReason(pos, [createStreamResult('PARTIAL')], [], 0)).not.toBeNull();
  });
});
