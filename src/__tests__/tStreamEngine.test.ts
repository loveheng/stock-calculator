/**
 * @file tStreamEngine.test.ts
 * @description 单元测试：短线做 T（正T/倒T）战报净收益结算口径。
 *              覆盖 Bug 回归：正T 平仓结算必须严格与本次 Round 内先买入流水
 *              FIFO 配对，严禁引用中长期底仓成本 P_base（历史底仓成本）。
 *
 *              公式约定（与需求一致）：
 *                正T净收益 = 卖出回收净现金(成交额 - 规费)
 *                          - 对应匹配的买入总支出(成交额 + 规费)
 *              倒T净收益 = 匹配的卖出净回款(成交额 - 规费)
 *                        - 对应回补买入总支出(成交额 + 规费)
 * @layer Test
 * @storage_impact 纯函数测试，不读写任何存储。
 */

import { describe, test, expect } from 'vitest';
import { processStockStream } from '../utils/tStreamEngine';
import type { TStreamRecord } from '../types/tStrategy';
import type { FeeConfig } from '../utils/mathUtils';

// ---- 测试用费率配置（佣金 0.025% 最低 0.5 元 / 印花税卖出 0.05% / 过户费 0.001%） ----
const FEE_CONFIG: FeeConfig = {
  commissionRate: 0.00025,
  isFreeFive: false,
  minCommission: 0.5,
  stampRate: 0.0005,
  transferRate: 0.00001,
};

// ---- 辅助：按 calcTradeFees 口径构建一条 T 流水 ----
function makeRecord(overrides: Partial<TStreamRecord> & { price: number; amount: number; direction: 'buy' | 'sell'; fee: number }): TStreamRecord {
  return {
    id: `tx-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: '2026-08-13T01:00:00.000Z',
    fullCode: 'sh600000',
    stockName: '浦发银行',
    ...overrides,
  };
}

// ---- 复现场景：原 Bug 报告中「16.67 买入 → 16.93 卖出」 ----
// 底仓 P_base = 24.11（历史中长期账本成本），正T 平仓严禁引用该成本。
// 原 Bug：transferProfit = 1693 - 100×24.11 - 双向规费 ≈ -764.53（误判亏损）
// 修复后：transferProfit = (1693 - 卖出规费) - (1667 + 买入规费) ≈ +26（盈利）
describe('processStockStream 正T 战报净收益（Bug 回归）', () => {
  test('正T 16.67 买 100 股 → 16.93 卖 100 股：净收益 ≈ +26 盈利', () => {
    const buyFee = 1; // 佣金 1667×0.00025=0.42 < 最低 0.5 → 0.5，过户费 0.02，取整 fixture
    const sellFee = 1.5; // 佣金 0.5 + 印花税 1693×0.0005=0.85 + 过户费 0.02 ≈ 1.37，取整 fixture
    const result = processStockStream(
      [
        makeRecord({ id: 'b1', direction: 'buy', price: 16.67, amount: 100, fee: buyFee, timestamp: '2026-08-13T01:00:00.000Z' }),
        makeRecord({ id: 's1', direction: 'sell', price: 16.93, amount: 100, fee: sellFee, timestamp: '2026-08-13T02:00:00.000Z' }),
      ],
      FEE_CONFIG,
      24.11, // 历史底仓成本 P_base —— 正T 平仓严禁引用！
    );

    // 战报净收益 = 卖出净回款 - 匹配买入总支出
    const expected = (16.93 * 100 - sellFee) - (16.67 * 100 + buyFee);
    expect(result.transferProfit).toBeCloseTo(expected, 2);
    // 盈利 ~26 元
    expect(result.transferProfit).toBeGreaterThan(20);
    expect(result.transferProfit).toBeLessThan(30);
    // 与底仓成本 24.11 完全无关（严禁 -764 误判）
    expect(result.transferProfit).not.toBeCloseTo(-764.53, 0);
    expect(result.transferProfit).toBeGreaterThan(0);
    // Round 已结清、净收益与状态机 FIFO 累计一致
    expect(result.status).toBe('CLEARED');
    expect(result.realizedPnL).toBeCloseTo(expected, 2);
  });

  test('正T 平仓净收益严格等于 FIFO 配对公式（含规费）', () => {
    const buyFee = 1;
    const sellFee = 1.4;
    const result = processStockStream(
      [
        makeRecord({ id: 'b1', direction: 'buy', price: 16.67, amount: 100, fee: buyFee }),
        makeRecord({ id: 's1', direction: 'sell', price: 16.93, amount: 100, fee: sellFee }),
      ],
      FEE_CONFIG,
      24.11,
    );

    const sellNet = 16.93 * 100 - sellFee;
    const buyTotal = 16.67 * 100 + buyFee;
    expect(result.transferProfit).toBeCloseTo(sellNet - buyTotal, 2);
    // 卖出对冲成本 = 匹配买入总支出（与底仓成本无关）
    expect(result.sellCostTotal).toBeCloseTo(buyTotal, 2);
    // 回归：不与 P_base × 100 有任何关系
    expect(result.sellCostTotal).not.toBeCloseTo(24.11 * 100, 0);
  });

  test('多重买入 FIFO 配对：分批买入后一次性卖出，按顺序配对', () => {
    const result = processStockStream(
      [
        makeRecord({ id: 'b1', direction: 'buy', price: 16.6, amount: 60, fee: 0.5 }),
        makeRecord({ id: 'b2', direction: 'buy', price: 16.7, amount: 40, fee: 0.5 }),
        makeRecord({ id: 's1', direction: 'sell', price: 16.93, amount: 100, fee: 1.5 }),
      ],
      FEE_CONFIG,
      24.11,
    );

    const expected = (16.93 * 100 - 1.5) - ((16.6 * 60 + 16.7 * 40) + 1.0);
    expect(result.transferProfit).toBeCloseTo(expected, 2);
    expect(result.transferProfit).toBeGreaterThan(0);
    expect(result.status).toBe('CLEARED');
  });

  test('正T 部分卖出（Round 未结清）：战报净收益仅按 Round 内买入摊配，与 P_base 无关', () => {
    const result = processStockStream(
      [
        makeRecord({ id: 'b1', direction: 'buy', price: 16.67, amount: 100, fee: 1 }),
        makeRecord({ id: 'b2', direction: 'buy', price: 16.7, amount: 50, fee: 0.5 }),
        makeRecord({ id: 's1', direction: 'sell', price: 16.93, amount: 100, fee: 1.5 }),
      ],
      FEE_CONFIG,
      24.11,
    );

    // 卖出 100 / 累积买入 150 → 按比例 2/3 摊配本次 Round 买入总支出
    // 匹配买入总成本 = 买入成交额 2502 × (100/150) + 买入规费 1.5 × (100/150)
    // 净收益 = (卖出净回款 1691.5) - (匹配买入总成本 1669) = 22.5（与 P_base 24.11 完全无关）
    const matchRatio = 100 / 150;
    const matchedBuyTotal = (16.67 * 100 + 16.7 * 50) * matchRatio + (1 + 0.5) * matchRatio;
    const expected = (16.93 * 100 - 1.5) - matchedBuyTotal;
    expect(result.transferProfit).toBeCloseTo(expected, 2);
    // 回归保护：严禁引用 P_base（24.11 × 匹配数量）
    expect(result.transferProfit).not.toBeCloseTo(1693 - 24.11 * 100 - (1 + 0.5 + 1.5), 0);
    // 引擎既有状态语义：未结清且 totalBuyQuantity(50) < totalSellQuantity(100) 时标记为 PENDING
    expect(result.status).toBe('PENDING');
  });

  test('Bug 回归「买入→卖出→再买入」：200@16 → 卖100@17 → 买100@16，数量/规费/明细撮合映射', () => {
    const buyFee1 = 0.83; // 200×16.00=3200：佣金 0.8 + 过户费 0.03（取整 fixture）
    const sellFee = 1.37; // 100×17.00=1700：佣金最低 0.5 + 印花税 0.85 + 过户费 0.02（取整 fixture）
    const buyFee2 = 0.52; // 100×16.00=1600：佣金最低 0.5 + 过户费 0.02（取整 fixture）
    const result = processStockStream(
      [
        makeRecord({ id: 'b1', direction: 'buy', price: 16.0, amount: 200, fee: buyFee1, timestamp: '2026-08-13T01:00:00.000Z' }),
        makeRecord({ id: 's1', direction: 'sell', price: 17.0, amount: 100, fee: sellFee, timestamp: '2026-08-13T02:00:00.000Z' }),
        makeRecord({ id: 'b2', direction: 'buy', price: 16.0, amount: 100, fee: buyFee2, timestamp: '2026-08-13T03:00:00.000Z' }),
      ],
      FEE_CONFIG,
      24.11,
    );

    // 1) 数量口径：已卖对冲 100 股；剩余待处理持仓 = 总买入 300 - 已卖 100 = 200 股
    expect(result.realizedSellAmount).toBe(100);
    expect(result.netPendingAmount).toBe(200);

    // 2) FIFO 收益：卖出 100@17 仅匹配第一笔买入的前 100@16（未被后续 100@16 污染）
    //    成交时累积买入池仅为 200@16，比例匹配 = FIFO 匹配 → 成本 = 1600 + 买入规费 0.415
    const matchedBuyCost = 16.0 * 100;
    const matchedBuyFee = buyFee1 * (100 / 200); // 0.415
    const expected = (17.0 * 100 - sellFee) - (matchedBuyCost + matchedBuyFee); // 98.22
    expect(result.transferProfit).toBeCloseTo(expected, 2);
    expect(result.transferProfit).toBeGreaterThan(0);

    // 3) 规费口径：realizedFee 仅含已平仓 100 股的买卖规费（0.415 + 1.37 = 1.785），
    //    严禁包含第三笔未对冲买入的 0.52 元规费
    const expectedRealizedFee = matchedBuyFee + sellFee; // 1.785
    expect(result.realizedFee).toBeCloseTo(expectedRealizedFee, 2);
    expect(result.realizedFee).not.toBeCloseTo(buyFee1 + sellFee + buyFee2, 2);

    // 4) 明细撮合映射（CurrentProjectCard 展开列表）：收益标签只挂在真正完成
    //    FIFO 对冲的卖出腿（s1）上；第一笔买入腿仅显示被对冲消耗的 100 股（+¥0.00）；
    //    第三笔未平仓买入腿显示撮合 0 股 +¥0.00
    const [b1, s1, b2] = result.entries;
    expect(b1.direction).toBe('buy');
    expect(b1.matchedAmount).toBeCloseTo(100, 2);
    expect(b1.remaining).toBeCloseTo(100, 2);
    expect(b1.realizedProfit).toBe(0);

    expect(s1.direction).toBe('sell');
    expect(s1.matchedAmount).toBe(100);
    expect(s1.realizedProfit).toBeCloseTo(expected, 2);

    expect(b2.direction).toBe('buy');
    expect(b2.matchedAmount).toBeCloseTo(0, 2);
    expect(b2.remaining).toBeCloseTo(100, 2);
    expect(b2.realizedProfit).toBe(0);

    // 5) 卖出对冲成本 = 匹配买入总支出（与 P_base 24.11 无关）
    expect(result.sellCostTotal).toBeCloseTo(matchedBuyCost + matchedBuyFee, 2);
    // 6) Round 未结清（仍有 200 股待处理持仓）
    expect(result.status).toBe('PARTIAL');
  });
});

// ---- 倒T 回归：确保 P_base 仅用于倒 T 首笔对冲定值，波段收益逻辑不受影响 ----
describe('processStockStream 倒T 战报净收益（回归保护）', () => {
  test('倒T 16.93 卖 100 股 → 16.67 买 100 股：净收益 = 卖出净回款 - 买入总支出', () => {
    const result = processStockStream(
      [
        makeRecord({ id: 's1', direction: 'sell', price: 16.93, amount: 100, fee: 1.5 }),
        makeRecord({ id: 'b1', direction: 'buy', price: 16.67, amount: 100, fee: 1 }),
      ],
      FEE_CONFIG,
      24.11,
    );

    const expected = (16.93 * 100 - 1.5) - (16.67 * 100 + 1);
    expect(result.mode).toBe('short');
    expect(result.transferProfit).toBeCloseTo(expected, 2);
    expect(result.transferProfit).toBeGreaterThan(20);
    expect(result.status).toBe('CLEARED');
  });

  test('倒T 卖出 300 股 @17.43 → 买入 400 股 @16.00：超额买回自动对冲 + 剩余归并底仓', () => {
    // 场景：倒T 先卖出 300 股，再买入 400 股（超出 100 股）
    // 预期：300 股配对成功，100 股超出归并到底仓
    // 净收益 = (17.43 * 300 - 卖出规费) - (16.00 * 300 + 买入规费对冲部分)
    const sellFee = 2.5; // 17.43*300=5229：佣金 0.5 + 印花税 2.6145 + 过户费 0.052 ≈ 3.17，取整 fixture
    const buyFee = 2.0;  // 16.00*400=6400：佣金 0.5 + 过户费 0.064 ≈ 0.564，取整 fixture
    const result = processStockStream(
      [
        makeRecord({ id: 's1', direction: 'sell', price: 17.43, amount: 300, fee: sellFee, timestamp: '2026-08-13T01:00:00.000Z' }),
        makeRecord({ id: 'b1', direction: 'buy', price: 16.00, amount: 400, fee: buyFee, timestamp: '2026-08-13T02:00:00.000Z' }),
      ],
      FEE_CONFIG,
      24.11,
    );

    // 1) 模式为倒T
    expect(result.mode).toBe('short');

    // 2) 300 股配对成功，净收益 = 卖出净回款 - 匹配买入总支出
    // 对冲比例 = 300/400 = 0.75，买入规费对冲部分 = 2.0 * 0.75 = 1.5
    const matchedBuyFee = buyFee * 0.75;
    const expected = (17.43 * 300 - sellFee) - (16.00 * 300 + matchedBuyFee);
    expect(result.transferProfit).toBeCloseTo(expected, 1);
    expect(result.transferProfit).toBeGreaterThan(400); // ~423 元

    // 3) 状态已结清（CLEARED）
    expect(result.status).toBe('CLEARED');

    // 4) 做T池待处理数量为 0（超额部分已归并到底仓）
    expect(result.netPendingAmount).toBe(0);

    // 5) 明细撮合映射：卖出腿 300 股全部被对冲
    const [s1, b1] = result.entries;
    expect(s1.direction).toBe('sell');
    expect(s1.matchedAmount).toBeCloseTo(300, 2);
    expect(s1.remaining).toBeCloseTo(0, 2);

    // 6) 买入腿：撮合 300 股（对冲部分），剩余 100 股（归并到底仓）
    expect(b1.direction).toBe('buy');
    expect(b1.matchedAmount).toBeCloseTo(300, 1);
    expect(b1.remaining).toBeCloseTo(100, 1);

    // 7) 收益标签挂在买入腿上（倒T 回补买入 = 收益实现腿）
    expect(b1.realizedProfit).toBeCloseTo(expected, 1);
    expect(b1.realizedProfit).toBeGreaterThan(0);
  });
});