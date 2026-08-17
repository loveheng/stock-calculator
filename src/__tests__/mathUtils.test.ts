/**
 * @file mathUtils.test.ts
 * @description 单元测试：核心数学工具函数
 * @layer Test
 * @storage_impact 纯函数测试，不读写任何存储。
 */

import { describe, test, expect } from 'vitest';
import {
  roundTo,
  calcChangeRate,
  calcTargetPrice,
  calcTradeFees,
  isValidLotSize,
  matchSecurityKind,
  calcFeeBreakdown,
  calcCostAveraging,
  calcTargetCostAveraging,
} from '../utils/mathUtils';
import type { FeeConfig } from '../utils/mathUtils';

const DEFAULT_FEE: FeeConfig = {
  commissionRate: 0.00025,
  isFreeFive: false,
  minCommission: 0.5,
  transferRate: 0.00001,
  stampRate: 0.0005,
  etfCommissionRate: 0.00025,
  etfIsFreeFive: true,
  etfMinCommission: 0.2,
  etfTransferRate: 0,
  etfStampRate: 0,
};

// ============================================================
// roundTo
// ============================================================
describe('roundTo', () => {
  test('四舍五入到指定小数位', () => {
    expect(roundTo(3.14159, 2)).toBe(3.14);
    expect(roundTo(3.14159, 0)).toBe(3);
    expect(roundTo(3.14159, 4)).toBe(3.1416);
  });
  test('处理负数', () => expect(roundTo(-3.14159, 2)).toBe(-3.14));
  test('处理整数', () => expect(roundTo(100, 2)).toBe(100));
  test('处理 Decimal 字符串', () => expect(roundTo('3.14159', 2)).toBe(3.14));
});

// ============================================================
// calcChangeRate / calcTargetPrice
// ============================================================
describe('calcChangeRate', () => {
  test('计算涨幅', () => {
    const r = calcChangeRate(10, 11);
    expect(r.percent).toBe(10);
    expect(r.diff).toBe(1);
  });
  test('计算跌幅', () => {
    const r = calcChangeRate(10, 9);
    expect(r.percent).toBeCloseTo(-10, 10);
    expect(r.diff).toBe(-1);
  });
  test('零价格返回 0 涨幅', () => {
    const r = calcChangeRate(0, 10);
    expect(r.percent).toBe(Infinity);
    expect(r.diff).toBe(10);
  });
});

describe('calcTargetPrice', () => {
  test('涨幅目标价', () => expect(calcTargetPrice(10, 10).target).toBe(11));
  test('跌幅目标价', () => expect(calcTargetPrice(10, -10).target).toBe(9));
});

// ============================================================
// calcTradeFees
// ============================================================
describe('calcTradeFees', () => {
  test('买入股票（非免五）：佣金不足 5 元按 5 元收取', () => {
    const f = calcTradeFees(10, 1000, 'buy', DEFAULT_FEE, 'stock');
    // 佣金 = max(10000 * 0.00025, 5) = 5
    expect(f.commission).toBe(5);
    expect(f.transfer).toBe(0.1);
    expect(f.stamp).toBe(0);
    expect(f.total).toBe(5.1);
  });
  test('卖出股票（非免五）：佣金+过户费+印花税', () => {
    const f = calcTradeFees(10, 1000, 'sell', DEFAULT_FEE, 'stock');
    expect(f.commission).toBe(5);
    expect(f.transfer).toBe(0.1);
    expect(f.stamp).toBe(5);
    expect(f.total).toBe(10.1);
  });
  test('买入 ETF：免印花税、免过户费', () => {
    const f = calcTradeFees(10, 1000, 'buy', DEFAULT_FEE, 'etf');
    expect(f.commission).toBe(2.5);
    expect(f.transfer).toBe(0);
    expect(f.stamp).toBe(0);
  });
  test('佣金不足最低佣金时使用最低佣金（非免五 = 5 元）', () => {
    const f = calcTradeFees(1, 100, 'buy', DEFAULT_FEE, 'stock');
    expect(f.commission).toBe(5);
  });
  test('免五模式：最低佣金 0.5', () => {
    const cfg: FeeConfig = { ...DEFAULT_FEE, isFreeFive: true, minCommission: 0.5 };
    const f = calcTradeFees(10, 100, 'buy', cfg, 'stock');
    expect(f.commission).toBe(0.5);
  });
});

// ============================================================
// isValidLotSize
// ============================================================
describe('isValidLotSize', () => {
  test('整数倍 100 有效', () => {
    expect(isValidLotSize(100)).toBe(true);
    expect(isValidLotSize(1000)).toBe(true);
  });
  test('非整数倍 100 无效', () => {
    expect(isValidLotSize(50)).toBe(false);
    expect(isValidLotSize(0)).toBe(false);
  });
  test('负数无效', () => expect(isValidLotSize(-100)).toBe(false));
});

// ============================================================
// matchSecurityKind
// ============================================================
describe('matchSecurityKind', () => {
  test('空字符串默认返回 stock', () => expect(matchSecurityKind('', '')).toBe('stock'));
  test('stock 类型', () => expect(matchSecurityKind('stock', '')).toBe('stock'));
  test('JJ 前缀识别为 etf', () => expect(matchSecurityKind('JJ123', '')).toBe('etf'));
  test('ZQ 前缀识别为 bond', () => expect(matchSecurityKind('ZQ456', '')).toBe('bond'));
  test('51 开头代码识别为 etf', () => expect(matchSecurityKind('', '510050')).toBe('etf'));
  test('11 开头代码识别为 bond', () => expect(matchSecurityKind('', '110001')).toBe('bond'));
  test('未知类型默认回退为股票', () => expect(matchSecurityKind('unknown', '')).toBe('stock'));
});

// ============================================================
// calcFeeBreakdown
// ============================================================
describe('calcFeeBreakdown', () => {
  test('买入股票（非免五）：佣金 5 元', () => {
    const f = calcFeeBreakdown(10000, 'buy', DEFAULT_FEE, 'stock');
    expect(f.commission).toBe(5);
    expect(f.transfer).toBe(0.1);
    expect(f.stamp).toBe(0);
  });
  test('卖出股票：佣金+过户费+印花税', () => {
    const f = calcFeeBreakdown(10000, 'sell', DEFAULT_FEE, 'stock');
    expect(f.stamp).toBe(5);
  });
});

// ============================================================
// calcCostAveraging (成本摊薄)
// ============================================================
describe('calcCostAveraging', () => {
  test('买入摊薄后成本正确', () => {
    const r = calcCostAveraging([
      { price: 40, amount: 500 },
    ], 50, 1000);
    // (50000 + 20000) / 1500 = 46.667
    expect(r.avgCost).toBeCloseTo(46.667, 2);
    expect(r.totalAmount).toBe(1500);
  });
  test('空买入列表时返回原持仓成本', () => {
    const r = calcCostAveraging([], 50, 1000);
    expect(r.avgCost).toBe(50);
    expect(r.totalAmount).toBe(1000);
  });
  test('持仓为 0 时', () => {
    const r = calcCostAveraging([
      { price: 40, amount: 1000 },
    ], 0, 0);
    // (0 + 40000) / 1000 = 40
    expect(r.avgCost).toBe(40);
    expect(r.totalAmount).toBe(1000);
  });
});

// ============================================================
// calcTargetCostAveraging (目标成本摊薄)
// ============================================================
describe('calcTargetCostAveraging', () => {
  test('计算达到目标成本所需买入数量', () => {
    const r = calcTargetCostAveraging(50, 1000, 40, 45);
    // needAmount = (50-45)*1000/(45-40) = 5000/5 = 1000
    expect(r.needAmount).toBe(1000);
    expect(r.needCapital).toBe(40000);
    expect(r.actualCost).toBe(45);
    expect(r.suggestions.length).toBeGreaterThan(0);
  });
  test('当前成本已低于目标成本时无需补仓', () => {
    const r = calcTargetCostAveraging(40, 1000, 40, 45);
    expect(r.needAmount).toBe(0);
    expect(r.suggestions[0]).toContain('无需补仓');
  });
});
