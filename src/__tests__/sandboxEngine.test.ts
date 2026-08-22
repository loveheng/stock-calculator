/**
 * @file sandboxEngine.test.ts
 * @description 沙盘推演引擎单元测试（规格书 §13.1）：
 *              - 资金硬约束（INSUFFICIENT_CASH：反算最大可买量，先扣规费再取整 100 股）
 *              - T+1 锁定（当日买入不可当日卖出；倒T出借 borrow 豁免）
 *              - 持仓不足（INSUFFICIENT_POSITION）与超评估日（BEYOND_ASOF）
 *              - 统一评估日市价清算（已实现/未实现拆分）
 *              - 动态抖动：同种子可复现；高波动区抖动幅度 > 低波动区
 *              - 规费与 calcTradeFees 逐笔一致；基线自洽（引擎末端持仓 == 净持仓）
 * @layer Test
 * @storage_impact 纯函数测试，不读写任何存储。
 */

import { describe, expect, it } from 'vitest';
import { runSandboxEngine } from '../utils/sandboxEngine';
import { calcTradeFees, type FeeConfig, type SecurityKind } from '../utils/mathUtils';
import type { KlineItem, SandboxOrder } from '../types/sandbox';

const DEFAULT_FEE: FeeConfig = {
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
// 工具：构造 K 线夹具
// ============================================================

/** 生成从 start 起 count 个交易日（跳过周末）的日期序列 */
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

/** 由收盘价序列构造 K 线（振幅可配，用于抖动测试） */
function makeKline(closes: number[], amplitude = 0.01, start = '2026-01-05'): KlineItem[] {
  const dates = weekdayDates(start, closes.length);
  return dates.map((date, i) => {
    const close = closes[i];
    const open = i === 0 ? close : closes[i - 1];
    return {
      date,
      open,
      close,
      high: Math.max(open, close) * (1 + amplitude),
      low: Math.min(open, close) * (1 - amplitude),
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

/** 引擎基础配置（默认关抖动，保证确定性断言） */
function baseOptions(over: Partial<Parameters<typeof runSandboxEngine>[2]> = {}) {
  return {
    simulatedCash: 20000,
    feeConfig: DEFAULT_FEE,
    securityKind: KIND,
    jitterFactor: 0,
    ...over,
  };
}

// ============================================================
// 资金约束
// ============================================================

describe('资金约束（Peak Capital Lock 硬上限）', () => {
  it('买入超出预算 → INSUFFICIENT_CASH，且反算最大可买量先扣规费再取整 100 股', () => {
    // 现金 10000，股价 50，尝试买 300 股（成交额 15000）→ 必然超出
    const kline = makeKline([50, 50, 50]);
    const orders = [order({ id: 'o1', timestamp: `${kline[0].date}T09:30:00+08:00`, price: 50, quantity: 300 })];
    const res = runSandboxEngine(orders, kline, baseOptions({ simulatedCash: 10000 }));

    expect(res.ok).toBe(false);
    const rejection = res.rejections.find((r) => r.code === 'INSUFFICIENT_CASH');
    expect(rejection).toBeDefined();
    expect(rejection!.message).toContain('预算上限');
    expect(rejection!.actions.length).toBeGreaterThan(0);

    // 反算最大可买量：100 股可买（5000+规费 ≤ 10000），200 股不可买（10000+规费 > 10000）
    const reduce = rejection!.actions.find((a) => a.kind === 'reduce-qty');
    expect(reduce).toBeDefined();
    const maxQty = reduce!.payload!.maxQty;
    expect(maxQty % 100).toBe(0);
    const outlayOk = 50 * maxQty + calcTradeFees(50, maxQty, 'buy', DEFAULT_FEE, KIND).total;
    const outlayNext = 50 * (maxQty + 100) + calcTradeFees(50, maxQty + 100, 'buy', DEFAULT_FEE, KIND).total;
    expect(outlayOk).toBeLessThanOrEqual(10000);
    expect(outlayNext).toBeGreaterThan(10000);
  });

  it('提供"先卖释放现金"与"调高模拟资金"的行动选项', () => {
    const kline = makeKline([50, 50]);
    const orders = [order({ id: 'o1', timestamp: `${kline[0].date}T09:30:00+08:00`, price: 50, quantity: 300 })];
    const res = runSandboxEngine(orders, kline, baseOptions({ simulatedCash: 10000 }));
    const rejection = res.rejections.find((r) => r.code === 'INSUFFICIENT_CASH')!;
    const kinds = rejection.actions.map((a) => a.kind);
    expect(kinds).toContain('insert-sell');
    expect(kinds).toContain('raise-cash');
  });
});

// ============================================================
// T+1 锁定
// ============================================================

describe('T+1 锁定', () => {
  const kline = makeKline([10, 11, 12, 13, 14]);

  it('当日买入 → 当日卖出被拒（T1_LOCK），次日可卖', () => {
    const orders = [
      order({ id: 'b1', seqIndex: 0, timestamp: `${kline[0].date}T09:30:00+08:00`, price: 10, quantity: 100 }),
      order({ id: 's1', seqIndex: 1, timestamp: `${kline[0].date}T14:00:00+08:00`, action: 'sell', price: 11, quantity: 100 }),
    ];
    const res = runSandboxEngine(orders, kline, baseOptions());
    expect(res.ok).toBe(false);
    const t1 = res.rejections.find((r) => r.code === 'T1_LOCK');
    expect(t1).toBeDefined();
    expect(t1!.message).toContain('T+1');
    expect(t1!.actions.some((a) => a.kind === 'move-date')).toBe(true);
    expect(t1!.actions.some((a) => a.kind === 'reduce-qty')).toBe(true);
  });

  it('把卖出移到下一个交易日 → 正常成交', () => {
    const orders = [
      order({ id: 'b1', seqIndex: 0, timestamp: `${kline[0].date}T09:30:00+08:00`, price: 10, quantity: 100 }),
      order({ id: 's1', seqIndex: 1, timestamp: `${kline[1].date}T09:30:00+08:00`, action: 'sell', price: 11, quantity: 100 }),
    ];
    const res = runSandboxEngine(orders, kline, baseOptions());
    expect(res.ok).toBe(true);
    expect(res.result!.finalPosition).toBe(0);
    // 已实现 = (11−10)×100 − 双边规费（含卖出印花税）
    const buyFee = calcTradeFees(10, 100, 'buy', DEFAULT_FEE, KIND).total;
    const sellFee = calcTradeFees(11, 100, 'sell', DEFAULT_FEE, KIND).total;
    expect(res.result!.realizedProfit).toBeCloseTo(100 - buyFee - sellFee, 2);
    expect(res.result!.totalStampTax).toBe(calcTradeFees(11, 100, 'sell', DEFAULT_FEE, KIND).stamp);
  });

  it('倒T出借（kind=borrow）卖出昨日底仓 → 豁免 T+1', () => {
    // 同一日：先买 100（今日仓），再倒T出借卖出 100（视为昨日底仓）→ 允许
    const orders = [
      order({ id: 'b1', seqIndex: 0, timestamp: `${kline[0].date}T09:30:00+08:00`, price: 10, quantity: 100 }),
      order({ id: 's1', seqIndex: 1, timestamp: `${kline[0].date}T14:00:00+08:00`, action: 'sell', price: 11, quantity: 100, kind: 'borrow' }),
    ];
    const res = runSandboxEngine(orders, kline, baseOptions());
    expect(res.ok).toBe(true);
    expect(res.result!.finalPosition).toBe(0);
  });
});

// ============================================================
// 持仓不足 / 超评估日
// ============================================================

describe('持仓不足与超评估日拒绝', () => {
  it('卖出超过持仓 → INSUFFICIENT_POSITION（含减仓与先买行动项）', () => {
    const kline = makeKline([10, 10]);
    const orders = [
      order({ id: 'b1', timestamp: `${kline[0].date}T09:30:00+08:00`, price: 10, quantity: 100 }),
      order({ id: 's1', seqIndex: 1, timestamp: `${kline[1].date}T09:30:00+08:00`, action: 'sell', price: 10, quantity: 300 }),
    ];
    const res = runSandboxEngine(orders, kline, baseOptions());
    expect(res.ok).toBe(false);
    const r = res.rejections.find((rej) => rej.code === 'INSUFFICIENT_POSITION');
    expect(r).toBeDefined();
    expect(r!.message).toContain('当前持仓只有');
    expect(r!.actions.some((a) => a.kind === 'reduce-qty' && a.payload!.maxQty === 100)).toBe(true);
    expect(r!.actions.some((a) => a.kind === 'insert-buy')).toBe(true);
  });

  it('订单晚于评估日 → BEYOND_ASOF；订单早于行情起始 → 同样拒绝', () => {
    const kline = makeKline([10, 11, 12]);
    const late = runSandboxEngine(
      [order({ id: 'o1', timestamp: '2099-01-01T09:30:00+08:00', price: 10, quantity: 100 })],
      kline,
      baseOptions(),
    );
    expect(late.ok).toBe(false);
    expect(late.rejections[0].code).toBe('BEYOND_ASOF');
    expect(late.rejections[0].message).toContain('晚于评估日');

    const early = runSandboxEngine(
      [order({ id: 'o1', timestamp: '2000-01-01T09:30:00+08:00', price: 10, quantity: 100 })],
      kline,
      baseOptions(),
    );
    expect(early.ok).toBe(false);
    expect(early.rejections[0].code).toBe('BEYOND_ASOF');
    expect(early.rejections[0].message).toContain('早于行情起始日');
  });
});

// ============================================================
// 统一评估日清算
// ============================================================

describe('统一评估日市价清算', () => {
  it('持仓至评估日：未实现盈亏 = 持股 ×（评估日收盘 − 持仓均价），已实现为 0', () => {
    const kline = makeKline([10, 10.5, 11, 12, 12]);
    const orders = [order({ id: 'b1', timestamp: `${kline[0].date}T09:30:00+08:00`, price: 10, quantity: 100 })];
    const res = runSandboxEngine(orders, kline, baseOptions());

    expect(res.ok).toBe(true);
    const result = res.result!;
    const buyFee = calcTradeFees(10, 100, 'buy', DEFAULT_FEE, KIND).total;
    const avgCost = (10 * 100 + buyFee) / 100;
    expect(result.asOfDate).toBe(kline[kline.length - 1].date);
    expect(result.finalPosition).toBe(100);
    expect(result.realizedProfit).toBe(0);
    expect(result.unrealizedProfit).toBeCloseTo(100 * (12 - avgCost), 2);
    expect(result.finalProfit).toBeCloseTo(result.unrealizedProfit, 2);
    // 快照逐日：从首笔操作日到评估日
    expect(result.snapshots.length).toBe(kline.length);
    expect(result.snapshots[0].position).toBe(100);
    expect(result.snapshots[0].cost).toBeCloseTo(avgCost, 2);
  });

  it('中途止盈落袋：已实现盈亏进入结果，评估日无持仓', () => {
    const kline = makeKline([10, 11, 12]);
    const orders = [
      order({ id: 'b1', seqIndex: 0, timestamp: `${kline[0].date}T09:30:00+08:00`, price: 10, quantity: 100 }),
      order({ id: 's1', seqIndex: 1, timestamp: `${kline[1].date}T09:30:00+08:00`, action: 'sell', price: 11, quantity: 100 }),
    ];
    const res = runSandboxEngine(orders, kline, baseOptions());
    expect(res.result!.finalPosition).toBe(0);
    expect(res.result!.unrealizedProfit).toBe(0);
    expect(res.result!.realizedProfit).toBeGreaterThan(0);
  });
});

// ============================================================
// 动态抖动
// ============================================================

describe('动态价格抖动（基于周围 K 线波动率）', () => {
  it('同种子可复现：两次运行结果完全一致', () => {
    const kline = makeKline([10, 10.5, 11, 10.8, 11.2], 0.02);
    const orders = [order({ id: 'j1', timestamp: `${kline[2].date}T09:30:00+08:00`, price: 11, quantity: 100 })];
    const opts = baseOptions({ jitterFactor: 0.25, seedPrefix: 'branch-x' });
    const r1 = runSandboxEngine(orders, kline, opts);
    const r2 = runSandboxEngine(orders, kline, opts);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    // 抖动系数 0.25 × 振幅 ~4% → 成交价偏离期望价在合理范围
    const cost = r1.result!.snapshots[0].cost;
    expect(Math.abs(cost - 11)).toBeLessThan(0.5);
  });

  it('高波动区抖动幅度 > 低波动区（振幅差异被抖动如实放大）', () => {
    // 前 30 根低振幅（0.1%），后 30 根高振幅（10%），收盘价恒定 10
    const closes = Array.from({ length: 60 }, () => 10);
    const lowRegion = makeKline(closes.slice(0, 30), 0.001, '2026-01-05');
    const highRegion = makeKline(closes.slice(30), 0.1, lowRegion[lowRegion.length - 1].date);

    // 低波动区订单（每个订单单独跑一次，从快照成本读成交价）
    const lowDeviations: number[] = [];
    for (let i = 5; i <= 15; i++) {
      const orders = [order({ id: `lo-${i}`, timestamp: `${lowRegion[i].date}T09:30:00+08:00`, price: 10, quantity: 100 })];
      const res = runSandboxEngine(orders, lowRegion, baseOptions({ jitterFactor: 1, seedPrefix: 'vol' }));
      const cost = res.result!.snapshots[0].cost;
      lowDeviations.push(Math.abs(cost - 10) / 10);
    }
    const highDeviations: number[] = [];
    for (let i = 5; i <= 15; i++) {
      const orders = [order({ id: `hi-${i}`, timestamp: `${highRegion[i].date}T09:30:00+08:00`, price: 10, quantity: 100 })];
      const res = runSandboxEngine(orders, highRegion, baseOptions({ jitterFactor: 1, seedPrefix: 'vol' }));
      const cost = res.result!.snapshots[0].cost;
      highDeviations.push(Math.abs(cost - 10) / 10);
    }

    const lowAvg = lowDeviations.reduce((a, b) => a + b, 0) / lowDeviations.length;
    const highAvg = highDeviations.reduce((a, b) => a + b, 0) / highDeviations.length;
    // 低波动区：range = 中位振幅 0.2% × 1 → 偏离 ≤ ~0.35%（含规费抬升成本）
    expect(lowAvg).toBeLessThan(0.005);
    // 高波动区：range = 中位振幅 20% × 1，钳制在 ±10% 内 → 平均偏离 ≈ 7.5% + 规费
    expect(highAvg).toBeGreaterThan(0.04);
    expect(highAvg).toBeGreaterThan(lowAvg * 5);
  });
});

// ============================================================
// 规费对齐 & 基线自洽
// ============================================================

describe('规费对齐与基线自洽', () => {
  it('累计规费 = 逐笔 calcTradeFees 之和；印花税仅卖出收取', () => {
    const kline = makeKline([10, 11, 12, 13]);
    const orders = [
      order({ id: 'b1', seqIndex: 0, timestamp: `${kline[0].date}T09:30:00+08:00`, price: 10, quantity: 100 }),
      order({ id: 'b2', seqIndex: 1, timestamp: `${kline[1].date}T09:30:00+08:00`, price: 11, quantity: 200 }),
      order({ id: 's1', seqIndex: 2, timestamp: `${kline[2].date}T09:30:00+08:00`, action: 'sell', price: 12, quantity: 150 }),
    ];
    const res = runSandboxEngine(orders, kline, baseOptions());
    expect(res.ok).toBe(true);
    const expectedFees =
      calcTradeFees(10, 100, 'buy', DEFAULT_FEE, KIND).total +
      calcTradeFees(11, 200, 'buy', DEFAULT_FEE, KIND).total +
      calcTradeFees(12, 150, 'sell', DEFAULT_FEE, KIND).total;
    expect(res.result!.totalFees).toBeCloseTo(expectedFees, 2);
    expect(res.result!.totalStampTax).toBe(calcTradeFees(12, 150, 'sell', DEFAULT_FEE, KIND).stamp);
    expect(res.result!.tradeCount).toBe(3);
  });

  it('基线自洽：引擎末端持仓 == 基线净持仓（买加卖减）', () => {
    const kline = makeKline([10, 10.5, 11, 11.5, 12, 12.5]);
    const dates = weekdayDates(kline[0].date, 6);
    const orders = [
      order({ id: 'o1', seqIndex: 0, timestamp: `${dates[0]}T09:30:00+08:00`, price: 10, quantity: 300, isBaseline: true }),
      order({ id: 'o2', seqIndex: 1, timestamp: `${dates[1]}T09:30:00+08:00`, action: 'sell', price: 10.5, quantity: 100, isBaseline: true }),
      order({ id: 'o3', seqIndex: 2, timestamp: `${dates[2]}T09:30:00+08:00`, price: 11, quantity: 200, isBaseline: true }),
    ];
    const res = runSandboxEngine(orders, kline, baseOptions());
    expect(res.ok).toBe(true);
    expect(res.result!.finalPosition).toBe(300 - 100 + 200);
  });
});
