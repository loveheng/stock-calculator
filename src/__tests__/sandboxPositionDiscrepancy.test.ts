/**
 * @file sandboxPositionDiscrepancy.test.ts
 * @description 复现排查：用户真实中长期持仓「建仓 100 股 + 加仓 200 股 = 300 股」，
 *              沙盘基线重演却只有 200 股可用。本文件逐一验证可能机制：
 *              ① 正常路径：两笔批次齐全 → 基线末端 300 股，无拒绝、无警告；
 *              ② BEYOND_ASOF：建仓日期落在 K 线起点之前 → 建仓单被跳过 → 200 股 +
 *                拒绝记录 + 「基线校验异常」警告（H7）；
 *              ③ 批次缺失：position 快照 300 股但批次只有加仓 200 → 基线 200 股 +
 *                「基线校验异常」警告（H6，模拟 reconcile 剥离/落库缺失的后果）；
 *              ④ 在途倒T出借：批次含 borrow 卖出 100（未回补）→ 基线按真实履历
 *                重演为 200 股，与快照自洽（设计如此，无警告）。
 *
 *              费用口径与 sandboxFixture 一致（默认费率：佣金 0.025% 不免五 → 最低 5 元；
 *              过户 0.001%；印花 0.05% 仅卖出），夹具 fee 用 calcTradeFees 现算，保证
 *              峰值资金与引擎重演流出自洽。
 * @layer Test
 * @storage_impact 使用 fake-indexeddb 内存数据库；klineService 网络层被 mock，不触达真实网络。
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeKline } from './helpers/sandboxFixture';
import { calcTradeFees, type SecurityKind } from '../utils/mathUtils';
import { DEFAULT_FEE_CONFIG } from '../store/feePresets';
import type { Position } from '../store';
import type { KlineItem } from '../types/sandbox';

// ---- klineService 网络层 mock（vi.mock 提升到所有 import 之前） ----
const { mockGetKline } = vi.hoisted(() => ({
  mockGetKline: vi.fn(),
}));

vi.mock('../services/klineService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/klineService')>();
  return { ...actual, getKline: mockGetKline };
});

import { useAppStore } from '../store';
import { useSandboxStore } from '../store/sandboxStore';
import { initStore } from '../db/storeInit';
import { db } from '../db';

const FULL_CODE = 'sh600000';
const KIND: SecurityKind = 'stock';

/** 买入手续费（与 CostAveraging 建仓/加仓口径一致） */
function buyFee(price: number, qty: number): number {
  return calcTradeFees(price, qty, 'buy', DEFAULT_FEE_CONFIG, KIND).total;
}

/** 构造「建仓 100 + 加仓 200」的持仓（可覆盖日期/批次） */
function makePosition300(over: {
  openDate?: string;
  addDate?: string;
  batches?: Position['batches'];
  currentAmount?: number;
} = {}): Position {
  const openDate = over.openDate ?? '2026-01-05T09:30:00+08:00';
  const addDate = over.addDate ?? '2026-01-15T09:30:00+08:00';
  const batches =
    over.batches ??
    [
      {
        id: 'b1',
        timestamp: openDate,
        type: 'open' as const,
        price: 15,
        amount: 100,
        costAfter: (15 * 100 + buyFee(15, 100)) / 100,
        amountAfter: 100,
        fee: buyFee(15, 100),
      },
      {
        id: 'b2',
        timestamp: addDate,
        type: 'add' as const,
        price: 16,
        amount: 200,
        costAfter: (15 * 100 + buyFee(15, 100) + 16 * 200 + buyFee(16, 200)) / 300,
        amountAfter: 300,
        fee: buyFee(16, 200),
      },
    ];
  const amount = batches.reduce((s, b) => s + (b.amount > 0 ? b.amount : 0), 0);
  return {
    id: 'pos-300',
    stockName: '测试标的',
    fullCode: FULL_CODE,
    currentCost: (15 * 100 + buyFee(15, 100) + 16 * 200 + buyFee(16, 200)) / 300,
    currentAmount: over.currentAmount ?? amount,
    realizedPnL: 0,
    totalInvested: 15 * 100 + buyFee(15, 100) + 16 * 200 + buyFee(16, 200),
    isClosed: false,
    createdAt: openDate,
    batches,
  };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  await initStore();
  useSandboxStore.getState().clearSandboxState();
  mockGetKline.mockReset();
  mockGetKline.mockResolvedValue({ klines: makeKline(), adjustFactors: {} });
});

// ============================================================
// ① 正常路径：建仓 100 + 加仓 200 → 基线末端 300 股
// ============================================================

describe('正常路径（批次齐全）', () => {
  it('建仓100+加仓200 → 基线末端 300 股，无拒绝、无警告', async () => {
    useAppStore.setState({ positions: [makePosition300()] });
    await useSandboxStore.getState().selectStock(FULL_CODE);
    const s = useSandboxStore.getState();

    expect(s.activeComputed).not.toBeNull();
    expect(s.activeComputed!.rejections).toHaveLength(0);
    expect(s.activeComputed!.warnings).toHaveLength(0);
    expect(s.activeComputed!.result!.finalPosition).toBe(300);
    // 峰值资金 = 两笔买入流出之和（现金 0 起步）
    const pos = useAppStore.getState().positions[0];
    const expectedPeak = Math.round(
      (15 * 100 + buyFee(15, 100) + 16 * 200 + buyFee(16, 200)) * 100,
    ) / 100;
    const baseline = s.branches[0];
    expect(baseline.peakCapitalLock).toBeCloseTo(expectedPeak, 2);
  });
});

// ============================================================
// ② H7：建仓日期早于 K 线起点 → BEYOND_ASOF 跳过 → 200 股
// ============================================================

describe('H7：建仓日期落在 K 线覆盖之外', () => {
  it('建仓早于 K 线首根 → BEYOND_ASOF 拒绝建仓；设计行为为整体无结果 + 「基线重演不完整」警告', async () => {
    // makeKline(90) 首根 2025-11-03；建仓放 2025-10-01（K 线外）
    useAppStore.setState({
      positions: [makePosition300({ openDate: '2025-10-01T09:30:00+08:00' })],
    });
    await useSandboxStore.getState().selectStock(FULL_CODE);
    const s = useSandboxStore.getState();

    // 任一订单被拒 → 整体无结果（设计决策，见 sandboxE2E 结构化拒绝用例）
    expect(s.activeComputed!.rejections.some((r) => r.code === 'BEYOND_ASOF')).toBe(true);
    expect(s.activeComputed!.result).toBeNull();
    // 基线分支拒绝时给出持久可见的诊断，避免关掉弹窗后无任何线索
    expect(
      s.activeComputed!.warnings.some((w) => w.includes('基线重演不完整')),
    ).toBe(true);
  });
});

// ============================================================
// ③ H6：批次缺失（快照 300 / 批次仅 200）→ 200 股 + 校验警告
// ============================================================

describe('H6：批次履历缺失建仓（快照 300 / 批次仅 200）', () => {
  it('模拟 reconcile 剥离或落库缺失的后果 → 基线 200 股 + 基线校验异常', async () => {
    // 只有加仓批次，但快照仍为 300（批次表与快照表失同步的后果）
    const pos = makePosition300();
    const [openBatch, addBatch] = pos.batches;
    useAppStore.setState({
      positions: [{ ...pos, currentAmount: 300, batches: [addBatch] }],
    });
    await useSandboxStore.getState().selectStock(FULL_CODE);
    const s = useSandboxStore.getState();

    expect(s.activeComputed!.rejections).toHaveLength(0);
    expect(s.activeComputed!.result!.finalPosition).toBe(200);
    expect(
      s.activeComputed!.warnings.some((w) => w.includes('基线校验异常')),
    ).toBe(true);
    expect(openBatch.id).toBe('b1'); // 引用保序，避免未使用告警
  });
});

// ============================================================
// ④ 在途倒T出借：borrow 卖出 100 → 基线 200 股（与快照自洽）
// ============================================================

describe('在途倒T出借（borrow 批次）', () => {
  it('含 borrow 卖出 100 且快照同步为 200 → 基线 200 股，无校验警告（设计如此）', async () => {
    const pos = makePosition300();
    const addDate = '2026-01-15T09:30:00+08:00';
    const sellFee = calcTradeFees(16.2, 100, 'sell', DEFAULT_FEE_CONFIG, KIND).total;
    const borrowBatch: Position['batches'][number] = {
      id: 'b3',
      timestamp: '2026-01-20T09:30:00+08:00',
      type: 'reduce',
      price: 16.2,
      amount: -100,
      kind: 'borrow',
      costAfter: 0,
      amountAfter: 200,
      fee: sellFee,
      sourceRoundId: 'round-1',
      note: '倒T出借（在途）',
    };
    // 快照 = 建仓100 + 加仓200 − 出借100 = 200（与 normalizeShortTDeductionsViaPort 口径一致）
    useAppStore.setState({
      positions: [{ ...pos, currentAmount: 200, batches: [...pos.batches, borrowBatch] }],
    });
    await useSandboxStore.getState().selectStock(FULL_CODE);
    const s = useSandboxStore.getState();

    expect(s.activeComputed!.rejections).toHaveLength(0);
    expect(s.activeComputed!.result!.finalPosition).toBe(200);
    expect(
      s.activeComputed!.warnings.some((w) => w.includes('基线校验异常')),
    ).toBe(false);
    expect(addDate.length).toBeGreaterThan(0); // 保序引用
  });
});
