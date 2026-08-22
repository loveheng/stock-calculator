/**
 * @file klineService.test.ts
 * @description K 线服务纯函数单元测试：
 *              - parseKlinePayload：腾讯 qfqday/day 载荷解析（字段序 = 日期/开/收/高/低/量）
 *              - buildAdjustFactors：复权系数表 = qfq收盘 / raw收盘
 *              - getAdjustFactor：精确命中 / 非交易日向前回退 / 缺省 1
 * @layer Test
 * @storage_impact 纯函数测试，不触达网络与存储。
 */

import { describe, expect, it } from 'vitest';
import { buildAdjustFactors, getAdjustFactor, parseKlinePayload } from '../services/klineService';
import type { KlineItem } from '../types/sandbox';

// 2026-08-20 实测的腾讯响应结构（qfqday 字段序：日期/开/收/高/低/量）
const QFQ_PAYLOAD = JSON.stringify({
  code: 0,
  msg: '',
  data: {
    sh601318: {
      qfqday: [
        ['2024-01-02', '33.589', '32.759', '33.599', '32.749', '437592.000'],
        ['2024-01-03', '32.759', '32.689', '32.949', '32.479', '363822.000'],
      ],
    },
  },
});

const RAW_PAYLOAD = JSON.stringify({
  code: 0,
  msg: '',
  data: {
    sh601318: {
      day: [
        ['2024-01-02', '40.300', '39.470', '40.310', '39.460', '437592.000'],
        ['2024-01-03', '39.470', '39.400', '39.660', '39.190', '363822.000'],
      ],
    },
  },
});

describe('parseKlinePayload', () => {
  it('解析 qfq 载荷：前复权优先读 qfqday，字段顺序正确', () => {
    const klines = parseKlinePayload(QFQ_PAYLOAD, 'sh601318', 'qfq');
    expect(klines).toHaveLength(2);
    expect(klines[0]).toEqual({
      date: '2024-01-02',
      open: 33.589,
      close: 32.759,
      high: 33.599,
      low: 32.749,
      volume: 437592,
    });
    // 日期升序
    expect(klines[0].date < klines[1].date).toBe(true);
  });

  it('raw 模式读 day（未复权），数值与 qfq 不同', () => {
    const raw = parseKlinePayload(RAW_PAYLOAD, 'sh601318', 'raw');
    const qfq = parseKlinePayload(QFQ_PAYLOAD, 'sh601318', 'qfq');
    expect(raw[0].open).toBe(40.3);
    expect(qfq[0].open).toBe(33.589);
  });

  it('code≠0 / 载荷损坏 / 非 JSON → 返回空数组', () => {
    expect(parseKlinePayload(JSON.stringify({ code: -1, msg: 'param error', data: [] }), 'sh601318')).toEqual([]);
    expect(parseKlinePayload('not json{{{', 'sh601318')).toEqual([]);
    expect(parseKlinePayload(JSON.stringify({ code: 0, data: {} }), 'sh601318')).toEqual([]);
  });

  it('行字段不足 6 个 → 跳过该行', () => {
    const payload = JSON.stringify({
      code: 0,
      data: { sh601318: { qfqday: [['2024-01-02', '33.589', '32.759'], ['2024-01-03', '1', '2', '3', '4', '5', '6']] } },
    });
    const klines = parseKlinePayload(payload, 'sh601318');
    expect(klines).toHaveLength(1);
    expect(klines[0].date).toBe('2024-01-03');
  });
});

describe('buildAdjustFactors', () => {
  it('factor = qfq收盘 / raw收盘（逐日期）', () => {
    const raw: KlineItem[] = [
      { date: '2024-01-02', open: 40.3, close: 39.47, high: 40.31, low: 39.46, volume: 1 },
      { date: '2024-01-03', open: 39.47, close: 39.4, high: 39.66, low: 39.19, volume: 1 },
    ];
    const qfq: KlineItem[] = [
      { date: '2024-01-02', open: 33.589, close: 32.759, high: 33.599, low: 32.749, volume: 1 },
      { date: '2024-01-03', open: 32.759, close: 32.689, high: 32.949, low: 32.479, volume: 1 },
    ];
    const factors = buildAdjustFactors(raw, qfq);
    expect(factors['2024-01-02']).toBeCloseTo(32.759 / 39.47, 6);
    expect(factors['2024-01-03']).toBeCloseTo(32.689 / 39.4, 6);
  });

  it('raw 缺失日期不生成系数（除权前新股 / 停牌等边界）', () => {
    const raw: KlineItem[] = [{ date: '2024-01-02', open: 10, close: 10, high: 10, low: 10, volume: 1 }];
    const qfq: KlineItem[] = [
      { date: '2024-01-02', open: 9.6, close: 9.6, high: 9.6, low: 9.6, volume: 1 },
      { date: '2024-01-03', open: 9.7, close: 9.7, high: 9.7, low: 9.7, volume: 1 },
    ];
    const factors = buildAdjustFactors(raw, qfq);
    expect(factors['2024-01-02']).toBeCloseTo(0.96, 6);
    expect(factors['2024-01-03']).toBeUndefined();
  });
});

describe('getAdjustFactor', () => {
  const factors = { '2024-01-02': 0.96, '2024-01-05': 0.97 };

  it('精确命中直接返回', () => {
    expect(getAdjustFactor('2024-01-02', factors)).toBe(0.96);
  });

  it('非交易日（周末/节假日）向前回退最近系数', () => {
    // 2024-01-06 是周六 → 回退到 2024-01-05（周五）
    expect(getAdjustFactor('2024-01-06', factors)).toBe(0.97);
    // 2024-01-07 是周日 → 回退 2 天到 01-05
    expect(getAdjustFactor('2024-01-07', factors)).toBe(0.97);
  });

  it('向前 10 个自然日仍无系数 → 视为 1（无除权差异）', () => {
    // 2024-01-16 往前数：01-06..01-15 均无系数（01-05 是第 11 天，超出回退窗口）
    expect(getAdjustFactor('2024-01-16', factors)).toBe(1);
  });
});
