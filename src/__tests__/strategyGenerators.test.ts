/**
 * @file strategyGenerators.test.ts
 * @description 沙盘预设策略生成器单元测试（对齐 6 大标准策略 + gap-fill 辅助工具）。
 *              以「不变量」为核心断言：
 *              - 统一订单契约：动作合法、100 股取整、seqIndex 连续、按时间升序；
 *              - 资金底座：买入累计成本不超过「模拟资金 + 注入」硬底座（含 1.5% 缓冲）；
 *              - 反未来函数：信号当日收盘判定、次日开盘撮合（价格 = 目标交易日开盘价）；
 *              - stop-profit：止损位/1R/2R 取价关系 + 跌破止损全额清仓；
 *              - gap-fill：区间缺口补全建议只出买入、且取区间最低点成交。
 * @layer Test
 * @storage_impact 纯函数测试，无任何副作用。
 */

import { describe, expect, it } from 'vitest';
import {
  BUY_BUFFER_RATE,
  SELL_BUFFER_RATE,
  budgetQty,
  CapitalAllocator,
  computeRemainingCash,
  computeStopProfitLevels,
  evaluateSignals,
  extractFactors,
  generateStrategyOrders,
  STRATEGY_GENERATORS,
  type StrategyContext,
} from '../utils/strategyGenerators';
import type { FeeConfig } from '../utils/mathUtils';
import type { CashInjection, KlineItem, SandboxOrder } from '../types/sandbox';

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

// ============================================================
// 工具：K 线 / 订单 / 上下文夹具
// ============================================================

/** 生成从 start 起 count 个交易日（跳过周末）的日期序列（UTC，时区无关） */
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

/** 由收盘价序列构造前复权 K 线（high=1% 上影，low=1% 下影；open 取前收） */
function makeKline(closes: number[], start = '2025-01-02'): KlineItem[] {
  const dates = weekdayDates(start, closes.length);
  return dates.map((date, i) => {
    const close = closes[i];
    const open = i === 0 ? close : closes[i - 1];
    return {
      date,
      open,
      close,
      high: Math.round(Math.max(open, close) * 1.01 * 100) / 100,
      low: Math.round(Math.min(open, close) * 0.99 * 100) / 100,
      volume: 1000,
    };
  });
}

/** 单边缓升行情 */
function mkRise(count: number, from = 10, to = 12): KlineItem[] {
  const closes = Array.from({ length: count }, (_, i) =>
    Math.round((from + ((to - from) * i) / (count - 1)) * 100) / 100,
  );
  return makeKline(closes);
}

/** 恒定价格行情 */
function mkFlat(count: number, price = 10): KlineItem[] {
  return makeKline(Array(count).fill(price));
}

/** 构造最小订单 */
function makeOrder(over: Partial<SandboxOrder> & { timestamp: string; price: number }): SandboxOrder {
  return { id: 'o', branchId: '', seqIndex: 0, action: 'buy', quantity: 100, ...over };
}

/** 构造最小策略上下文（字段均可覆盖） */
function makeCtx(over: Partial<StrategyContext>): StrategyContext {
  return {
    klineData: [],
    peakCapitalLock: 10000,
    simulatedCash: 10000,
    currentPrice: 10,
    currentCost: 0,
    currentQuantity: 0,
    feeConfig: FEE,
    securityKind: 'stock',
    ...over,
  };
}

// ============================================================
// 1. 统一订单契约：动作合法 / 100 股取整 / seqIndex 连续 / 时间升序
// ============================================================

describe('纯定投（pure-dca）确定性买入', () => {
  it('上升行情全部为买入：100 股取整、seqIndex 连续、按时间升序', () => {
    const orders = generateStrategyOrders(
      'pure-dca',
      makeCtx({ klineData: mkRise(60, 10, 12), simulatedCash: 20000 }),
      { period: 10 },
    );
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((o) => o.action === 'buy')).toBe(true);
    orders.forEach((o, i) => {
      expect(o.quantity).toBeGreaterThan(0);
      expect(o.quantity % 100).toBe(0);
      expect(o.price).toBeGreaterThan(0);
      expect(o.seqIndex).toBe(i);
      expect(o.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T09:30:00\+08:00$/);
    });
    expect([...orders].map((o) => o.timestamp)).toEqual(orders.map((o) => o.timestamp));
  });

  it('买入累计成本不超过资金底座（模拟资金 + 注入，含 1.5% 缓冲）', () => {
    const kline = mkFlat(60, 10);
    const injections: CashInjection[] = [{ date: kline[10].date, amount: 5000 }];
    const orders = generateStrategyOrders(
      'pure-dca',
      makeCtx({ klineData: kline, simulatedCash: 10000, cashInjections: injections }),
      { period: 10 },
    );
    const base = 15000;
    const spent = orders.reduce((s, o) => s + o.price * o.quantity * (1 + BUY_BUFFER_RATE), 0);
    expect(spent).toBeLessThanOrEqual(base * 1.001);
  });

  it('反未来函数：信号次日开盘撮合（订单价 = 目标交易日开盘价）', () => {
    const closes = [10, 10.4, 9.8, 10.6, 9.7, 10.9, 10.1, 11.2, 10.4, 11.5];
    const kline = makeKline(closes);
    const byDate = new Map(kline.map((k, i) => [k.date, i]));
    const orders = generateStrategyOrders('pure-dca', makeCtx({ klineData: kline, simulatedCash: 20000 }), { period: 3 });
    expect(orders.length).toBeGreaterThan(0);
    const idx = byDate.get(orders[0].timestamp.slice(0, 10));
    expect(idx).toBeDefined();
    expect(orders[0].price).toBeCloseTo(kline[idx!].open, 2);
  });

  it('空 K 线返回空数组（懒守卫）', () => {
    expect(generateStrategyOrders('pure-dca', makeCtx({ klineData: [] }), { period: 10 })).toEqual([]);
  });
});

// ============================================================
// 2. 统一订单契约：全部策略出单合法
// ============================================================

describe('统一订单契约（6 大标准策略）', () => {
  const ids = ['ma20-bounce', 'pyramid', 'grid', 'stop-profit', 'max-opportunity', 'pure-dca'] as const;
  ids.forEach((id) => {
    it(`该策略出单不变量：动作合法 / 100 股取整 / seqIndex 连续 / 时间升序`, () => {
      const orders = generateStrategyOrders(
        id,
        makeCtx({ klineData: mkRise(90, 10, 13), simulatedCash: 60000 }),
        {},
      );
      orders.forEach((o, i) => {
        expect(['buy', 'sell']).toContain(o.action);
        expect(o.price).toBeGreaterThan(0);
        expect(o.quantity).toBeGreaterThan(0);
        expect(o.quantity % 100).toBe(0);
        expect(o.seqIndex).toBe(i);
        expect(o.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T09:30:00\+08:00$/);
      });
      expect([...orders].map((o) => o.timestamp)).toEqual(orders.map((o) => o.timestamp));
    });
  });

  it('空 K 线一律返回空数组（全部策略懒得守卫）', () => {
    for (const id of ids) {
      expect(generateStrategyOrders(id, makeCtx({ klineData: [] }), {})).toEqual([]);
    }
  });

  it('资金不变量：Σ买入成本−Σ卖出净回流 ≤ 初始+Σ注入（6 策略统一）', () => {
    const kline = mkRise(90, 10, 13);
    const injections: CashInjection[] = [{ date: kline[20].date, amount: 20000 }];
    const base = 60000 + 20000;
    for (const id of ids) {
      const orders = generateStrategyOrders(
        id,
        makeCtx({ klineData: kline, simulatedCash: 60000, cashInjections: injections }),
        {},
      );
      const net = orders.reduce((s, o) => {
        if (o.action === 'buy') return s + o.price * o.quantity * (1 + BUY_BUFFER_RATE);
        return s - o.price * o.quantity * (1 - SELL_BUFFER_RATE);
      }, 0);
      expect(net).toBeLessThanOrEqual(base * 1.001);
    }
  });
});

// ============================================================
// 3. 止损止盈风控（stop-profit）
// ============================================================

describe('stop-profit 止损/止盈风控', () => {
  it('1R/2R 取价：1R=入场+R，2R=入场+2R，止损 < 入场', () => {
    const ctx = makeCtx({ simulatedCash: 30000, currentCost: 9.8, klineData: mkFlat(20, 10) });
    const lv = computeStopProfitLevels(ctx, { riskPercent: 2, rewardRatio: 2 });
    expect(lv).not.toBeNull();
    expect(lv!.stop).toBeLessThan(lv!.entry);
    expect(lv!.takeProfit1R - lv!.entry).toBeCloseTo(lv!.riskPerShare, 6);
    expect(lv!.takeProfit2R - lv!.entry).toBeCloseTo(2 * lv!.riskPerShare, 6);
    expect(lv!.qty % 100).toBe(0);
  });

  it('跌破止损全额清仓：生成止损卖出且全为 100 股取整', () => {
    const closes = [10, 10, 10, 9.8, 9.6, 9.4, 9.2, 9.0, 9.2];
    const orders = generateStrategyOrders(
      'stop-profit',
      makeCtx({ klineData: makeKline(closes), simulatedCash: 30000, currentCost: 10 }),
      {},
    );
    expect(orders.some((o) => o.action === 'sell' && /跌破止损/.test(o.note ?? ''))).toBe(true);
    expect(orders.every((o) => o.quantity % 100 === 0)).toBe(true);
  });
});

// ============================================================
// 4. 补全建议（gap-fill）
// ============================================================

describe('gap-fill 区间缺口补全建议', () => {
  it('相邻操作间隔足够时在缺口内最低点补买一笔（100 股取整）', () => {
    const closes = [10, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8];
    const kline = makeKline(closes);
    const baselineOrders: SandboxOrder[] = [
      makeOrder({ timestamp: `${kline[0].date}T09:30:00+08:00`, price: 10, quantity: 500 }),
      makeOrder({ timestamp: `${kline[8].date}T09:30:00+08:00`, price: 10.8, quantity: 500 }),
    ];
    const out = generateStrategyOrders(
      'gap-fill',
      makeCtx({ klineData: kline, baselineOrders, simulatedCash: 10000, currentPrice: 10.8 }),
      { minGap: 4, tailWindow: 3, tailDropPct: 20 },
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((o) => o.action === 'buy')).toBe(true);
    expect(out.every((o) => o.quantity % 100 === 0)).toBe(true);
  });
});

// ============================================================
// 5. 工具函数
// ============================================================

describe('工具函数', () => {
  it('budgetQty：100 股向下取整，资金不足则 0', () => {
    expect(budgetQty(10, 20000) % 100).toBe(0);
    expect(budgetQty(10, 1)).toBe(0);
    expect(budgetQty(0, 1000)).toBe(0);
  });

  it('computeRemainingCash：模拟资金 − 持仓市值（下限 0）', () => {
    expect(computeRemainingCash(makeCtx({ simulatedCash: 10000, currentQuantity: 200, currentCost: 10 }))).toBe(8000);
    expect(computeRemainingCash(makeCtx({ simulatedCash: 10000, currentQuantity: 2000, currentCost: 10 }))).toBe(0);
  });
});

// ============================================================
// 6. max-opportunity 专属策略行为单测
// ============================================================

describe('max-opportunity 专属策略行为单测', () => {
  it('注册表挂载与默认参数', () => {
    const g = STRATEGY_GENERATORS['max-opportunity'];
    expect(g).toBeDefined();
    expect(g!.defaultParams).toEqual({ maFast: 20, maSlow: 60, atrPeriod: 14, maxUse: 0.8 });
  });

  it('多维共振建仓且受 maxUse 80% 资金上限约束（100 股取整）', () => {
    // 前 60 天 10 元平稳筑底，使 MA20/MA60 ≈ 10、gap≈0，满足回踩企稳共振；随后温和上行以持有不回踩
    const closes = [...Array(60).fill(10), 10.2, 10.5, 10.8, 11.0, 11.3, 11.6, 11.9, 12.2];
    const orders = generateStrategyOrders(
      'max-opportunity',
      makeCtx({ klineData: makeKline(closes), simulatedCash: 100000 }),
      {},
    );
    expect(orders).toHaveLength(1);
    expect(orders[0].action).toBe('buy');
    expect(orders[0].note).toContain('多维共振满仓');
    expect(orders[0].quantity % 100).toBe(0);
    // 买入总额（不含费） ≤ 资金底座 * 80%
    expect(orders[0].quantity * orders[0].price).toBeLessThanOrEqual(100000 * 0.8);
  });

  it('跌破大底硬止损：全额清仓卖单，数量等于买入量', () => {
    // 前 60 天 10 元筑底（共振买入），随后盘中砸穿止损线 Low60*0.98≈9.70
    const closes = [...Array(60).fill(10), 9.5, 9.5, 9.5, 9.5, 9.5, 9.5, 9.5];
    const orders = generateStrategyOrders(
      'max-opportunity',
      makeCtx({ klineData: makeKline(closes), simulatedCash: 100000 }),
      {},
    );
    const buy = orders.find((o) => o.action === 'buy');
    const sell = orders.find((o) => o.action === 'sell');
    expect(buy).toBeDefined();
    expect(sell).toBeDefined();
    expect(sell!.quantity).toBe(buy!.quantity);
    expect(sell!.note).toMatch(/止损|离场/);
    expect(sell!.quantity % 100).toBe(0);
  });

  it('1.5 ATR 移动跟踪止盈：主升浪后击穿 trail 线，卖出价高于建仓价', () => {
    // 前 60 天 10 元筑底 → 主升浪至 14 元+（trail 随升）→ 单日回踩击穿 trail → 离场
    const closes = [
      ...Array(60).fill(10),
      10.3, 10.5, 10.8, 11.0, 11.3, 11.6, 12.0, 12.3, 12.7, 13.1, 13.4, 13.8, 14.2, 14.5,
      11.9, // 单日大幅回踩击穿 trail
      9.0, 9.0, 9.0, 9.0, 9.0, 9.0,
    ];
    const orders = generateStrategyOrders(
      'max-opportunity',
      makeCtx({ klineData: makeKline(closes), simulatedCash: 100000 }),
      {},
    );
    const buy = orders.find((o) => o.action === 'buy');
    const sell = orders.find((o) => o.action === 'sell');
    expect(buy).toBeDefined();
    expect(sell).toBeDefined();
    expect(sell!.quantity).toBe(buy!.quantity);
    expect(sell!.price).toBeGreaterThan(buy!.price);
    expect(sell!.note).toMatch(/止损|离场/);
  });

  it('弱势单边阴跌严格空仓（0 笔订单）', () => {
    // 连续 80 天单边阴跌，收盘持续低于 5 日均线，无企稳支撑
    const closes = Array.from({ length: 80 }, (_, i) => Math.round((12 - i * 0.05) * 100) / 100);
    const orders = generateStrategyOrders('max-opportunity', makeCtx({ klineData: makeKline(closes), simulatedCash: 100000 }), {});
    expect(orders).toHaveLength(0);
  });
});
// ============================================================
// 7. model-recommend 多因子智能推荐
// ============================================================

describe('model-recommend 多因子智能推荐', () => {
  const K = (d: string, o: number, h: number, l: number, c: number, v: number): KlineItem =>
    ({ date: d, open: o, high: h, low: l, close: c, volume: v });
  const dates = (n: number) => weekdayDates('2025-01-02', n);

  it('放量突破买入：实体>0.6·上影<0.2·量比≥1.5 触发 buy，且总额≤80% 资金', () => {
    const d = dates(64);
    const flat = Array.from({ length: 40 }, (_, i) => K(d[i], 10, 10.1, 9.9, 10, 1000));
    const kline = [
      ...flat,
      K(d[40], 10, 11.4, 9.8, 11.2, 3000), // 放量突破阳线
      K(d[41], 11.2, 11.5, 11.0, 11.3, 1000), // 次日开盘撮合
      ...Array.from({ length: 22 }, (_, i) => K(d[42 + i], 11.3, 11.5, 11.1, 11.4, 1000)),
    ];
    const orders = generateStrategyOrders('model-recommend', makeCtx({ klineData: kline, simulatedCash: 200000 }), {});
    const buy = orders.find((o) => o.action === 'buy' && /多因子买入/.test(o.note ?? ''));
    expect(buy).toBeDefined();
    expect(buy!.quantity % 100).toBe(0);
    expect(buy!.quantity * buy!.price).toBeLessThanOrEqual(200000 * 0.8);
  });

  it('缩量企稳低吸：贴近均线 + 量比≤0.75 触发 pullback 买入', () => {
    const d = dates(70);
    const flat = Array.from({ length: 40 }, (_, i) => K(d[i], 10, 10.1, 9.9, 10, 1000));
    const kline = [
      ...flat,
      K(d[40], 10.05, 10.12, 9.96, 10.0, 120), // 缩量贴近均线
      K(d[41], 10.0, 10.15, 9.9, 10.1, 1000),
      ...Array.from({ length: 28 }, (_, i) => K(d[42 + i], 10.1, 10.2, 9.9, 10.1, 1000)),
    ];
    const orders = generateStrategyOrders('model-recommend', makeCtx({ klineData: kline, simulatedCash: 100000 }), {});
    const buy = orders.find((o) => o.action === 'buy' && /pullback/.test(o.note ?? ''));
    expect(buy).toBeDefined();
  });

  it('高危清仓：建仓后破位（bias<−0.05）或跌破 2×ATR 动态止损触发卖出', () => {
    const d = dates(70);
    const flat = Array.from({ length: 40 }, (_, i) => K(d[i], 10, 10.1, 9.9, 10, 1000));
    const kline = [
      ...flat,
      K(d[40], 10, 11.4, 9.8, 11.2, 3000), // 放量突破建仓
      K(d[41], 11.2, 11.4, 11.0, 11.3, 1000), // 次日撮合买入
      K(d[42], 11.2, 11.3, 8.5, 8.6, 2000), // 高位巨阴破位
      ...Array.from({ length: 26 }, (_, i) => K(d[43 + i], 8.6, 8.7, 8.4, 8.5, 800)),
    ];
    const orders = generateStrategyOrders('model-recommend', makeCtx({ klineData: kline, simulatedCash: 200000 }), {});
    expect(orders.some((o) => o.action === 'buy')).toBe(true);
    const sell = orders.find((o) => o.action === 'sell');
    expect(sell).toBeDefined();
    expect(sell!.note).toMatch(/高危清仓|跌破止损|risk/);
    expect(sell!.quantity % 100).toBe(0);
  });

  it('CapitalAllocator：70 分 0% / 90 分 80% / 线性中点，止损=入场−2×ATR', () => {
    const a = new CapitalAllocator();
    expect(a.allocateRatio(69)).toBe(0);
    expect(a.allocateRatio(70)).toBe(0);
    expect(a.allocateRatio(80)).toBeCloseTo(0.4, 6);
    expect(a.allocateRatio(90)).toBe(0.8);
    expect(a.allocateRatio(100)).toBe(0.8);
    expect(a.allocateBudget(90, 10000)).toBe(8000);
    expect(a.stopPrice(10, 1)).toBe(8);
  });
});

// ============================================================
// 8. hybrid-regime 环境自适应混合
// ============================================================

describe('hybrid-regime 环境自适应混合', () => {
  const H = (d: string, o: number, h: number, l: number, c: number, v: number): KlineItem =>
    ({ date: d, open: o, high: h, low: l, close: c, volume: v });
  const hdates = (n: number) => weekdayDates('2025-01-02', n);

  it('震荡行情下自动激活网格交易（放量不改向不计，仅看优惠）', () => {
    // 前 60 天在 10 元窄幅震荡（MA20≈MA60≈10，贴近均线不破位）→ 应落入 oscillation 并走网格
    const d = hdates(78);
    const flat = Array.from({ length: 78 }, (_, i) =>
      H(d[i], 10, 10.1, 9.9, i % 2 === 0 ? 10.02 : 9.98, 1000),
    );
    const orders = generateStrategyOrders('hybrid-regime', makeCtx({ klineData: flat, simulatedCash: 100000 }), {});
    // 震荡期网格触发的低吸买
    expect(orders.some((o) => o.action === 'buy' && /网格/.test(o.note ?? ''))).toBe(true);
  });

  it('趋势行情下激活多因子突破（MA20>MA60 且斜率向上 → model 子 reducer）', () => {
    // 前 62 天平盘夯实 10 元（MA20≈MA60≈10），随后一根放量突破阳线
    // （实体>0.6、上影<0.2、量比≥1.5）使 MA20>MA60 且斜率向上 → 落入 trend
    const d = hdates(70);
    const flat = Array.from({ length: 62 }, (_, i) => H(d[i], 10, 10.1, 9.9, 10, 1000));
    const breakout = H(d[62], 10, 11.4, 9.8, 11.2, 3000); // 放量突破
    const after = Array.from({ length: 7 }, (_, i) => {
      const c = Math.round((11.3 + i * 0.1) * 100) / 100;
      return H(d[63 + i], c - 0.02, c + 0.05, c - 0.05, c, 1800);
    });
    const orders = generateStrategyOrders(
      'hybrid-regime',
      makeCtx({ klineData: [...flat, breakout, ...after], simulatedCash: 100000 }),
      {},
    );
    // 趋势期激活多因子突破买入
    expect(orders.some((o) => o.action === 'buy' && /多因子/.test(o.note ?? ''))).toBe(true);
  });

  it('极端破位自动切入风控止损并拦截买入', () => {
    // 前 40 天 10 元折层，随后单边阴跌并跌破 MA60/破位 → 无买入、触发风控卖出
    const d = hdates(80);
    const flat = Array.from({ length: 40 }, (_, i) => H(d[i], 10, 10.1, 9.9, 10, 1000));
    const crash = Array.from({ length: 40 }, (_, i) => {
      const c = Math.round((10 - i * 0.1) * 100) / 100;
      return H(d[40 + i], c + 0.01, c + 0.05, Math.max(0.01, c - 0.1), Math.max(0.01, c), 1400);
    });
    const orders = generateStrategyOrders('hybrid-regime', makeCtx({ klineData: [...flat, ...crash], simulatedCash: 100000 }), {});
    // 破位后被风控拦截：不再买入
    expect(orders.some((o) => o.action === 'buy')).toBe(false);
  });
});