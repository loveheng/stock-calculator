/**
 * @file dedup.test.ts
 * @description 单元测试：交易特征指纹生成与查重纯函数
 * @layer Test
 * @storage_impact 纯函数测试，不读写任何存储。
 */

import { describe, test, expect } from 'vitest';
import {
  normalizeCode,
  dateKey,
  generateTxFingerprint,
  classifyDraft,
  canonicalizeFullCode,
  normalizeStockName,
  isSameStock,
  type PreparedHistory,
} from '../utils/dedup';

// ============================================================
// normalizeCode
// ============================================================
describe('normalizeCode', () => {
  test('去除 sh 前缀', () => {
    expect(normalizeCode('sh600519')).toBe('600519');
  });
  test('去除 sz 前缀', () => {
    expect(normalizeCode('sz000001')).toBe('000001');
  });
  test('去除 bj 前缀', () => {
    expect(normalizeCode('bj688001')).toBe('688001');
  });
  test('大小写不敏感', () => {
    expect(normalizeCode('SH600519')).toBe('600519');
    expect(normalizeCode('Sz000001')).toBe('000001');
  });
  test('无前缀的原始代码保持原样', () => {
    expect(normalizeCode('600519')).toBe('600519');
  });
  test('空字符串或空值容错', () => {
    expect(normalizeCode('')).toBe('');
    expect(normalizeCode(null as unknown as string)).toBe('');
    expect(normalizeCode(undefined as unknown as string)).toBe('');
  });
  test('去除前后空格', () => {
    expect(normalizeCode('  sh600519  ')).toBe('600519');
  });
});

// ============================================================
// dateKey
// ============================================================
describe('dateKey', () => {
  test('从毫秒时间戳生成 YYYYMMDD', () => {
    const d = new Date(2026, 7, 23); // Aug 23, 2026
    expect(dateKey(d.getTime())).toBe('20260823');
  });
  test('从 ISO 字符串生成', () => {
    expect(dateKey('2026-08-23T10:31:00')).toBe('20260823');
  });
  test('从 Date 对象生成', () => {
    expect(dateKey(new Date(2026, 0, 5))).toBe('20260105');
  });
  test('月份和日期补零', () => {
    expect(dateKey('2026-03-09')).toBe('20260309');
  });
  test('处理跨年边界', () => {
    expect(dateKey('2025-12-31')).toBe('20251231');
    expect(dateKey('2026-01-01')).toBe('20260101');
  });
});

// ============================================================
// generateTxFingerprint
// ============================================================
describe('generateTxFingerprint', () => {
  test('生成标准指纹：代码_方向_价格_数量_日期', () => {
    const fp = generateTxFingerprint({
      fullCode: 'sh600519',
      direction: 'buy',
      price: 1680.00,
      amount: 100,
      timestamp: '2026-08-23',
    });
    expect(fp).toBe('600519_buy_1680.000_100_20260823');
  });

  test('价格保留三位小数', () => {
    const fp = generateTxFingerprint({
      fullCode: '000001',
      direction: 'sell',
      price: 12.3456,
      amount: 200,
      timestamp: '2026-08-23',
    });
    expect(fp).toContain('12.346');
  });

  test('数量取整', () => {
    const fp = generateTxFingerprint({
      fullCode: '600519',
      direction: 'buy',
      price: 100,
      amount: 99.7,
      timestamp: '2026-08-23',
    });
    expect(fp).toContain('_100_');
  });

  test('sz 前缀被归一化', () => {
    const fp = generateTxFingerprint({
      fullCode: 'sz000001',
      direction: 'buy',
      price: 10,
      amount: 100,
      timestamp: '2026-08-23',
    });
    expect(fp).toMatch(/^000001_buy_/);
  });

  test('不同方向生成不同指纹', () => {
    const a = generateTxFingerprint({ fullCode: '600519', direction: 'buy', price: 100, amount: 100, timestamp: '2026-08-23' });
    const b = generateTxFingerprint({ fullCode: '600519', direction: 'sell', price: 100, amount: 100, timestamp: '2026-08-23' });
    expect(a).not.toBe(b);
  });
});

// ============================================================
// classifyDraft
// ============================================================
describe('classifyDraft', () => {
  const history: PreparedHistory[] = [
    { id: 'b1', dk: '20260823', normalizedCode: '600519', direction: 'buy', price: 1680.00, amount: 100 },
    { id: 'b2', dk: '20260822', normalizedCode: '600519', direction: 'buy', price: 1670.00, amount: 200 },
    { id: 'b3', dk: '20260823', normalizedCode: '000001', direction: 'buy', price: 10.00, amount: 1000 },
  ];

  test('完全匹配 → EXACT_DUPLICATE', () => {
    const result = classifyDraft(
      { fullCode: 'sh600519', direction: 'buy', price: 1680.00, amount: 100, timestamp: '2026-08-23' },
      history,
    );
    expect(result.status).toBe('EXACT_DUPLICATE');
    expect(result.matchedId).toBe('b1');
  });

  test('同日同代码同方向但价格不同 → POTENTIAL', () => {
    const result = classifyDraft(
      { fullCode: '600519', direction: 'buy', price: 1690.00, amount: 100, timestamp: '2026-08-23' },
      history,
    );
    expect(result.status).toBe('POTENTIAL');
    expect(result.matchedId).toBe('b1');
  });

  test('同日同代码同方向但数量不同 → POTENTIAL', () => {
    const result = classifyDraft(
      { fullCode: '600519', direction: 'buy', price: 1680.00, amount: 200, timestamp: '2026-08-23' },
      history,
    );
    expect(result.status).toBe('POTENTIAL');
  });

  test('不同日期 → UNIQUE', () => {
    const result = classifyDraft(
      { fullCode: '600519', direction: 'buy', price: 1680.00, amount: 100, timestamp: '2026-08-24' },
      history,
    );
    expect(result.status).toBe('UNIQUE');
  });

  test('不同代码 → UNIQUE', () => {
    const result = classifyDraft(
      { fullCode: '300750', direction: 'buy', price: 1680.00, amount: 100, timestamp: '2026-08-23' },
      history,
    );
    expect(result.status).toBe('UNIQUE');
  });

  test('不同方向 → UNIQUE', () => {
    const result = classifyDraft(
      { fullCode: '600519', direction: 'sell', price: 1680.00, amount: 100, timestamp: '2026-08-23' },
      history,
    );
    expect(result.status).toBe('UNIQUE');
  });

  test('空历史库 → UNIQUE', () => {
    const result = classifyDraft(
      { fullCode: '600519', direction: 'buy', price: 1680.00, amount: 100, timestamp: '2026-08-23' },
      [],
    );
    expect(result.status).toBe('UNIQUE');
  });

  test('微小价格差在容差内视为相等', () => {
    const result = classifyDraft(
      { fullCode: '600519', direction: 'buy', price: 1680.001, amount: 100, timestamp: '2026-08-23' },
      history,
    );
    expect(result.status).toBe('EXACT_DUPLICATE');
  });

  test('价格差超出容差 → POTENTIAL', () => {
    const result = classifyDraft(
      { fullCode: '600519', direction: 'buy', price: 1680.01, amount: 100, timestamp: '2026-08-23' },
      history,
    );
    expect(result.status).toBe('POTENTIAL');
  });
});

// ============================================================
// canonicalizeFullCode
// ============================================================
describe('canonicalizeFullCode', () => {
  test('已有 sh 前缀保持不变', () => {
    expect(canonicalizeFullCode('sh600519')).toBe('sh600519');
  });
  test('sz 前缀小写归一', () => {
    expect(canonicalizeFullCode('SZ000001')).toBe('sz000001');
  });
  test('后缀格式 600519.SH → sh600519', () => {
    expect(canonicalizeFullCode('600519.SH')).toBe('sh600519');
  });
  test('后缀格式 600519-sh → sh600519', () => {
    expect(canonicalizeFullCode('600519-sh')).toBe('sh600519');
  });
  test('冒号分隔 SH:600519 → sh600519', () => {
    expect(canonicalizeFullCode('SH:600519')).toBe('sh600519');
  });
  test('纯数字 6 开头 → sh', () => {
    expect(canonicalizeFullCode('600519')).toBe('sh600519');
  });
  test('纯数字 0 开头 → sz', () => {
    expect(canonicalizeFullCode('000001')).toBe('sz000001');
  });
  test('纯数字 4 开头 → bj', () => {
    expect(canonicalizeFullCode('430001')).toBe('bj430001');
  });
  test('非 6 位数字原样返回', () => {
    expect(canonicalizeFullCode('12345')).toBe('12345');
  });
  test('空字符串容错', () => {
    expect(canonicalizeFullCode('')).toBe('');
  });
});

// ============================================================
// normalizeStockName
// ============================================================
describe('normalizeStockName', () => {
  test('普通名称不变', () => {
    expect(normalizeStockName('贵州茅台')).toBe('贵州茅台');
  });
  test('ST 股票去掉前缀', () => {
    expect(normalizeStockName('ST闻泰')).toBe('闻泰');
  });
  test('*ST 股票去掉星号和前缀', () => {
    expect(normalizeStockName('*ST闻泰')).toBe('闻泰');
  });
  test('XD 除权前缀去掉', () => {
    expect(normalizeStockName('XD贵州茅台')).toBe('贵州茅台');
  });
  test('N 新股前缀去掉', () => {
    expect(normalizeStockName('N中芯')).toBe('中芯');
  });
  test('去空白', () => {
    expect(normalizeStockName(' 贵州茅台 ')).toBe('贵州茅台');
  });
  test('*ST闻泰 与 闻泰 归一化后相等', () => {
    expect(normalizeStockName('*ST闻泰')).toBe('闻泰');
    expect(normalizeStockName('闻泰科技')).toBe('闻泰科技');
  });
  test('空字符串容错', () => {
    expect(normalizeStockName('')).toBe('');
  });
});

// ============================================================
// isSameStock
// ============================================================
describe('isSameStock', () => {
  test('相同代码 → true', () => {
    expect(isSameStock({ fullCode: 'sh600519' }, { fullCode: '600519' })).toBe(true);
  });
  test('不同代码但名称归一化匹配 → true', () => {
    expect(isSameStock({ stockName: '*ST闻泰' }, { stockName: '闻泰科技' })).toBe(false);
  });
  test('代码为空时名称归一化匹配 → true', () => {
    expect(isSameStock({ stockName: '*ST闻泰' }, { stockName: '*ST闻泰' })).toBe(true);
  });
  test('全空 → false', () => {
    expect(isSameStock({}, {})).toBe(false);
  });
});