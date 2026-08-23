/**
 * @file sandboxStore.test.ts
 * @description 沙盘推演状态层（Step 3 成果）纯函数单元测试：
 *              - adjustBaselineOrdersToQfq：真实成交价 → 前复权口径换算（缺系数=1）
 *              - mergeBaselineAndGenerated：基线与预设订单合并（同日基线优先 + seqIndex 重排）
 *              - computeKlineStartDate：首笔建仓日（UTC 日历日，时区无关）
 *              - checkBranchStale：三源过期检测（⚠️ K线 / ⚡ 资金 / 🔄 基线）
 *              - computeBranchResult：基线（jitter 强制 0 锚定真实价）、预设（数量=生成资金、
 *                预算=模拟资金的分离语义 + memo 命中复用）
 * @layer Test
 * @storage_impact 纯函数测试；模块加载链含 Dexie（fake-indexeddb 兜底），不触发任何真实读写。
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  adjustBaselineOrdersToQfq,
  checkBranchStale,
  computeBranchResult,
  computeKlineEndDate,
  computeKlineStartDate,
  mergeBaselineAndGenerated,
  type BranchComputeContext,
} from '../store/sandboxStore';
import { calcTradeFees, type FeeConfig, type SecurityKind } from '../utils/mathUtils';
import type { KlineItem, SandboxBranch, SandboxOrder } from '../types/sandbox';
import type { Position } from '../store';

const FEE: FeeConfig = {
  commissionRate: 0.00025,
  isFreeFive: false,
  minCommission: 0.5,
  transferRate: 0.00001,
  stampRate: 0.0005,
  exchangeFeeRate: 0.0000341,
  regulatoryFeeRate: 0.00002,
  etfCommissionRate: 0.00025,
  etfIsFreeFive: true,
  etfMinCommission: 0.2,
  etfTransferRate: 0,
  etfStampRate: 0,
};
const KIND: SecurityKind = 'stock';

// ============================================================
// 工具：构造夹具
// ============================================================

/** 生成从 start 起 count 个交易日（跳过周末）的日期序列（UTC，与引擎测试一致） */
function weekdayDates(start: string, count: number): string[] {
  const [y, m, d] = start.split('-').map(Number);
  const dates: string[] = [];
  let t = Date.UTC(y, m - 1, d);
  while (dates.length < count) {
    const dt = new Date(t);
    const wd = dt.getUTCDay();
    if (wd !== 0 && wd !== 6) {
      dates.push(
        `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`,
      );
    }
    t += 86400000;
  }
  return dates;
}

/** 由收盘价序列构造 K 线 */
function makeKline(closes: number[], start = '2026-01-05'): KlineItem[] {
  const dates = weekdayDates(start, closes.length);
  return dates.map((date, i) => {
    const close = closes[i];
    const open = i === 0 ? close : closes[i - 1];
    return {
      date,
      open,
      close,
      high: Math.max(open, close) * 1.01,
      low: Math.min(open, close) * 0.99,
      volume: 1000,
    };
  });
}

/** 构造订单 */
function order(over: Partial<SandboxOrder> & { id: string; timestamp: string }): SandboxOrder {
  return {
    branchId: 'test',
    seqIndex: 0,
    action: 'buy',
    price: 10,
    quantity: 100,
    ...over,
  };
}

/** 构造分支 */
function makeBranch(over: Partial<SandboxBranch>): SandboxBranch {
  return {
    id: 'branch-1',
    fullCode: 'sh600000',
    stockName: '测试标的',
    branchType: 'baseline',
    branchName: '测试',
    status: 'draft',
    peakCapitalLock: 10000,
    simulatedCash: 10000,
    dataAsOfDate: '2026-01-16',
    lastRunAt: 0,
    generatedAtCash: 10000,
    lastBaselineSignature: 'sig',
    jitterFactor: 0.25,
    jitterWindowSize: 5,
    createdAt: 1,
    updatedAt: 1,
    isDeleted: 0,
    ...over,
  };
}

/** 构造计算上下文 */
function makeCtx(over: Partial<BranchComputeContext> = {}): BranchComputeContext {
  return {
    kline: makeKline([10, 10.2, 10.1, 10.5, 10.8]),
    factors: {},
    baselineOrders: [],
    baselineSignature: 'sig',
    position: null,
    feeConfig: FEE,
    securityKind: KIND,
    ...over,
  };
}

/** 构造最小持仓 */
function makePosition(over: Partial<Position> = {}): Position {
  return {
    id: 'p1',
    stockName: '测试标的',
    fullCode: 'sh600000',
    currentCost: 10,
    currentAmount: 100,
    batches: [
      {
        id: 'b1',
        timestamp: '2026-04-01T09:30:00+08:00',
        type: 'open',
        price: 10,
        amount: 100,
        costAfter: 10,
        amountAfter: 100,
      },
    ],
    isClosed: false,
    createdAt: '2026-04-01T09:30:00+08:00',
    ...over,
  };
}

// ============================================================
// 测试用例
// ============================================================

describe('adjustBaselineOrdersToQfq（真实成交价 → 前复权口径）', () => {
  it('按订单日期取系数换算价格，系数缺失的日期视为 1 不变', () => {
    const orders = [
      order({ id: 'a', timestamp: '2024-01-02T09:30:00+08:00', price: 40 }),
      order({ id: 'b', timestamp: '2024-06-20T09:30:00+08:00', price: 30 }),
      order({ id: 'c', timestamp: '2020-01-02T09:30:00+08:00', price: 50 }), // 系数表外 → 不变
    ];
    const factors = { '2024-01-02': 0.8333, '2024-06-20': 0.9 };
    const out = adjustBaselineOrdersToQfq(orders, factors);
    expect(out[0].price).toBeCloseTo(40 * 0.8333, 2);
    expect(out[1].price).toBeCloseTo(27, 2);
    expect(out[2].price).toBe(50);
    expect(out[0].id).toBe('a'); // 其他字段保持不变
  });

  it('非交易日自动向前回退最多 10 个自然日取系数', () => {
    const orders = [order({ id: 'a', timestamp: '2024-01-06T09:30:00+08:00', price: 40 })]; // 周六
    const out = adjustBaselineOrdersToQfq(orders, { '2024-01-05': 0.5 });
    expect(out[0].price).toBe(20);
  });
});

describe('mergeBaselineAndGenerated（基线与预设订单合并）', () => {
  it('同日基线优先于预设，整体按时间升序，seqIndex 连续重排', () => {
    const baseline = [
      order({ id: 'b1', timestamp: '2026-01-05T09:30:00+08:00', action: 'buy', price: 10 }),
      order({ id: 'b2', timestamp: '2026-01-08T09:30:00+08:00', action: 'sell', price: 11 }),
    ];
    const generated = [
      order({ id: 'g1', timestamp: '2026-01-06T09:30:00+08:00', action: 'buy', price: 9 }),
      order({ id: 'g2', timestamp: '2026-01-08T09:30:00+08:00', action: 'buy', price: 10.5 }), // 与 b2 同日
    ];
    const out = mergeBaselineAndGenerated(baseline, generated);
    expect(out.map((o) => o.id)).toEqual(['b1', 'g1', 'b2', 'g2']); // 同日 b2 在 g2 前
    expect(out.map((o) => o.seqIndex)).toEqual([0, 1, 2, 3]);
  });

  it('生成订单为空时原样返回基线', () => {
    const baseline = [order({ id: 'b1', timestamp: '2026-01-05T09:30:00+08:00' })];
    expect(mergeBaselineAndGenerated(baseline, [])).toBe(baseline);
  });
});

describe('computeKlineStartDate（K 线起点 = 首笔建仓日，UTC 日历日）', () => {
  it('首笔操作 2026-04-01 → 起点 2026-04-01（时区无关）', () => {
    expect(computeKlineStartDate(makePosition())).toBe('2026-04-01');
  });

  it('无批次时返回 undefined（走近 10 年缺省）', () => {
    expect(computeKlineStartDate(makePosition({ batches: [] }))).toBeUndefined();
  });
});

describe('computeKlineEndDate（K 线终点 = 平仓日，UTC 日历日）', () => {
  it('已平仓且带 closedAt → 终点 = 平仓日', () => {
    expect(
      computeKlineEndDate(
        makePosition({ isClosed: true, closedAt: '2026-06-30T10:00:00+08:00' }),
      ),
    ).toBe('2026-06-30');
  });

  it('未平仓（isClosed=false）→ undefined（取最新 K 线）', () => {
    expect(computeKlineEndDate(makePosition())).toBeUndefined();
  });

  it('已平仓但无 closedAt → undefined（取最新 K 线兜底）', () => {
    expect(computeKlineEndDate(makePosition({ isClosed: true, closedAt: undefined }))).toBeUndefined();
  });
});

describe('checkBranchStale（三源过期检测，全部用户点击触发）', () => {
  it('⚠️ K 线已更新：dataAsOfDate 早于当前末根日期', () => {
    const branch = makeBranch({ branchType: 'baseline', dataAsOfDate: '2026-08-19' });
    expect(checkBranchStale(branch, 'sig', '2026-08-20').kline).toBe(true);
    expect(checkBranchStale(branch, 'sig', '2026-08-19').kline).toBe(false);
    expect(checkBranchStale(branch, 'sig', '').kline).toBe(false); // 无 K 线不提示
    expect(checkBranchStale({ ...branch, dataAsOfDate: '' }, 'sig', '2026-08-20').kline).toBe(false);
  });

  it('⚡ 资金变动：仅 preset 分支且 simulatedCash ≠ generatedAtCash', () => {
    const preset = makeBranch({ branchType: 'preset', simulatedCash: 20000, generatedAtCash: 15000 });
    expect(checkBranchStale(preset, 'sig', '2026-08-20').cash).toBe(true);
    expect(checkBranchStale({ ...preset, generatedAtCash: 20000 }, 'sig', '2026-08-20').cash).toBe(false);
    // user 分支永不自动重配
    const user = makeBranch({ branchType: 'user', simulatedCash: 20000, generatedAtCash: 15000 });
    expect(checkBranchStale(user, 'sig', '2026-08-20').cash).toBe(false);
  });

  it('🔄 基线变化：指纹不一致（baseline/preset 检测，user 副本冻结不检测）', () => {
    const baseline = makeBranch({ branchType: 'baseline', lastBaselineSignature: 'old' });
    expect(checkBranchStale(baseline, 'new', '2026-08-20').baseline).toBe(true);
    expect(checkBranchStale({ ...baseline, lastBaselineSignature: 'new' }, 'new', '2026-08-20').baseline).toBe(false);
    const user = makeBranch({ branchType: 'user', lastBaselineSignature: 'old' });
    expect(checkBranchStale(user, 'new', '2026-08-20').baseline).toBe(false);
  });
});

describe('computeBranchResult（分支结果计算 + memo）', () => {
  it('基线：jitter 强制 0 锚定真实成交价，末端持仓与未实现盈亏精确', () => {
    const branch = makeBranch({ branchType: 'baseline', jitterFactor: 0.5 }); // 即使配置滑点也不生效
    const ctx = makeCtx({
      kline: makeKline([10, 10.2, 10.1, 10.5, 10.8]),
      baselineOrders: [order({ id: 'b1', timestamp: '2026-01-05T09:30:00+08:00', price: 10, quantity: 100 })],
    });
    const computed = computeBranchResult(branch, ctx);
    expect(computed).not.toBeNull();
    expect(computed!.rejections).toHaveLength(0);
    expect(computed!.result!.finalPosition).toBe(100);
    expect(computed!.result!.realizedProfit).toBe(0);

    const fee = calcTradeFees(10, 100, 'buy', FEE, KIND).total;
    const avgCost = (10 * 100 + fee) / 100;
    const asOfClose = 10.8;
    expect(computed!.result!.unrealizedProfit).toBeCloseTo(100 * (asOfClose - avgCost), 2);
    expect(computed!.result!.finalProfit).toBeCloseTo(100 * asOfClose - 1000 - fee, 2);
    expect(computed!.warnings).toHaveLength(0);
  });

  it('基线自校验：末端持仓 ≠ 真实当前持股时给出警示（不阻断）', () => {
    const branch = makeBranch({ branchType: 'baseline' });
    const ctx = makeCtx({
      baselineOrders: [order({ id: 'b1', timestamp: '2026-01-05T09:30:00+08:00', price: 10, quantity: 100 })],
      position: makePosition({ currentAmount: 200 }), // 真实持股 200 ≠ 推演 100
    });
    const computed = computeBranchResult(branch, ctx);
    expect(computed!.warnings.some((w) => w.includes('基线校验异常'))).toBe(true);
  });

  it('预设（pure-dca）：纯策略独立推演 —— 全额 simulatedCash、不合并基线、不扣峰值占用', () => {
    const branch = makeBranch({
      branchType: 'preset',
      presetStrategyId: 'pure-dca',
      presetParams: { period: 20 },
      generatedAtCash: 10000,
      simulatedCash: 10000,
      peakCapitalLock: 8000, // 即便存在历史峰值占用，也不预扣
      jitterFactor: 0,
    });
    // 基线订单 + 真实持仓存在：新语义下不应被合并进 preset 时间线，也不应占用预算
    const ctx = makeCtx({
      kline: makeKline(Array(40).fill(10)),
      baselineOrders: [order({ id: 'b1', timestamp: '2026-01-05T09:30:00+08:00', action: 'buy', price: 10, quantity: 100 })],
      position: makePosition({ currentAmount: 100 }),
    });
    const computed = computeBranchResult(branch, ctx);
    expect(computed).not.toBeNull();
    expect(computed!.result!.finalPosition).toBeGreaterThan(0);
    expect(computed!.rejections).toHaveLength(0);
    expect(computed!.strategyBudgetExhausted).toBe(false);
    expect(computed!.orders.some((o) => o.id === 'b1')).toBe(false);
    expect(computed!.orders.every((o) => o.branchId === branch.id)).toBe(true);
    const totalNotional = computed!.orders.reduce((s, o) => s + o.price * o.quantity, 0);
    expect(totalNotional).toBeLessThanOrEqual(10000 * 1.001);

    // ③ 提高模拟资金（⚡ 延迟重算）：仅抬预算，生成单保持 generatedAtCash 基准不变
    const raised = computeBranchResult({ ...branch, simulatedCash: 20000 }, ctx);
    expect(raised!.orders).toEqual(computed!.orders);
    // 点击 ⚡ 重配（generatedAtCash 盖章为新资金）→ 预案用量随之放大
    const rescaled = computeBranchResult({ ...branch, simulatedCash: 20000, generatedAtCash: 20000 }, ctx);
    const rescaledNotional = rescaled!.orders.reduce((s, o) => s + o.price * o.quantity, 0);
    expect(rescaledNotional).toBeGreaterThan(totalNotional);
  });

  it('预设（pure-dca）：position.openAt 对齐策略起始点，全部生成单不早于开仓日', () => {
    const kline = makeKline(Array(40).fill(10), '2026-01-05'); // 40 根：2026-01-05 ~ 2026-03 初
    const openDate = kline[20].date; // 开仓日取 20 号 K 线
    const branch = makeBranch({
      branchType: 'preset',
      presetStrategyId: 'pure-dca',
      presetParams: { period: 5 },
      generatedAtCash: 30000,
      simulatedCash: 30000,
      jitterFactor: 0,
      peakCapitalLock: 0,
    });
    const ctx = makeCtx({
      kline,
      position: makePosition({ openAt: openDate + 'T09:30:00+08:00' }),
    });
    const computed = computeBranchResult(branch, ctx);
    expect(computed).not.toBeNull();
    expect(computed!.rejections).toHaveLength(0);
    const generated = computed!.orders.filter((o) => o.branchId === branch.id);
    expect(generated.length).toBeGreaterThan(0);
    const openTs = Date.parse(openDate);
    for (const o of generated) {
      expect(Date.parse(o.timestamp.slice(0, 10))).toBeGreaterThanOrEqual(openTs);
    }
  });

  it('memo 命中：相同输入返回同一对象引用（0ms 切换）', () => {
    const branch = makeBranch({ branchType: 'baseline' });
    const ctx = makeCtx({
      baselineOrders: [order({ id: 'b1', timestamp: '2026-01-05T09:30:00+08:00', price: 10, quantity: 100 })],
    });
    const a = computeBranchResult(branch, ctx);
    const b = computeBranchResult(branch, ctx);
    expect(a).toBe(b);
  });

  it('K 线为空返回 null（懒计算守卫）', () => {
    const branch = makeBranch({ branchType: 'baseline' });
    expect(computeBranchResult(branch, makeCtx({ kline: [] }))).toBeNull();
  });

  it('评估日 = 末根 K 线日期（全分支共享同一清算日）', () => {
    const kline = makeKline([10, 10.2, 10.1, 10.5, 10.8]);
    const branch = makeBranch({ branchType: 'baseline' });
    const ctx = makeCtx({
      kline,
      baselineOrders: [order({ id: 'b1', timestamp: '2026-01-05T09:30:00+08:00', price: 10, quantity: 100 })],
    });
    const computed = computeBranchResult(branch, ctx);
    expect(computed!.asOfDate).toBe(kline[kline.length - 1].date);
    expect(computed!.result!.asOfDate).toBe(kline[kline.length - 1].date);
  });
});
