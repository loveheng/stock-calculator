/**
 * @file cleanUndefined.test.ts
 * @description 单元测试：递归剔除 undefined 字段工具函数
 * @layer Test
 * @storage_impact 纯函数测试，不读写任何存储。
 */

import { describe, test, expect } from 'vitest';
import { cleanUndefined } from '../db/cleanUndefined';

describe('cleanUndefined', () => {
  test('剔除顶层 undefined 字段，保留其他字段', () => {
    const cleaned = cleanUndefined({ a: 1, b: undefined, c: 'x' });
    expect(cleaned).toEqual({ a: 1, c: 'x' });
    expect('b' in cleaned).toBe(false);
  });

  test('递归剔除嵌套对象中的 undefined 字段', () => {
    const cleaned = cleanUndefined({
      id: 'p1',
      name: 'test',
      meta: { colorTag: undefined, tag: 't1' },
    });
    expect(cleaned).toEqual({ id: 'p1', name: 'test', meta: { tag: 't1' } });
  });

  test('多层嵌套逐层剔除 undefined', () => {
    const cleaned = cleanUndefined({
      a: { b: { c: undefined, d: { e: undefined, f: 1 } } },
    });
    expect(cleaned).toEqual({ a: { b: { d: { f: 1 } } } });
  });

  test('递归处理数组：清理数组内对象并剔除 undefined 元素', () => {
    const cleaned = cleanUndefined({
      items: [{ a: 1, b: undefined }, { a: 2 }, undefined],
    });
    expect(cleaned).toEqual({ items: [{ a: 1 }, { a: 2 }] });
  });

  test('Date / 空对象等特殊对象原样保留', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const cleaned = cleanUndefined({ created: date, empty: {} });
    expect(cleaned.created instanceof Date).toBe(true);
    expect(cleaned).toEqual({ created: date, empty: {} });
  });

  test('null / 0 / false / 空字符串等合法值不被误删', () => {
    const cleaned = cleanUndefined({ n: null, zero: 0, f: false, s: '' });
    expect(cleaned).toEqual({ n: null, zero: 0, f: false, s: '' });
  });

  test('不修改原对象，返回新结构', () => {
    const original = { a: 1, b: undefined, nested: { x: undefined, y: 2 } };
    const cleaned = cleanUndefined(original);
    expect(cleaned).not.toBe(original);
    expect(original).toEqual({ a: 1, b: undefined, nested: { x: undefined, y: 2 } });
  });
});
