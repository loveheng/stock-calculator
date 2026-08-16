/**
 * @file tradingTime.test.ts
 * @description 单元测试：A股交易时段判断 isTradingTime。
 *              覆盖开盘/收盘边界、午休、盘前盘后与周末；全部用例基于
 *              Asia/Shanghai 时区构造时间（以 2026-08-12 周三为锚点）。
 * @layer Test
 * @storage_impact 纯函数测试，不读写任何存储。
 */

import { describe, expect, test } from 'vitest';
import { isTradingTime } from '../utils/tradingTime';

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * 构造 Asia/Shanghai 时间线中指定星期与时刻的 Date 对象。
 * 锚点：2026-08-12 00:00:00 +08:00 为周三。
 */
function at(weekday: string, hour: number, minute: number): Date {
  const anchor = new Date('2026-08-12T00:00:00+08:00'); // 周三
  const dayDiff = WEEKDAY_INDEX[weekday] - 3; // 3 = Wed
  return new Date(
    anchor.getTime() + dayDiff * 86400000 + (hour * 60 + minute) * 60000
  );
}

describe('isTradingTime', () => {
  test('上午 09:30-11:30 连续竞价', () => {
    expect(isTradingTime(at('Mon', 9, 30))).toBe(true); // 开盘边界：进入交易
    expect(isTradingTime(at('Wed', 10, 15))).toBe(true);
    expect(isTradingTime(at('Fri', 11, 29))).toBe(true);
    expect(isTradingTime(at('Fri', 11, 30))).toBe(false); // 上午收盘边界
  });

  test('下午 13:00-15:00 连续竞价', () => {
    expect(isTradingTime(at('Tue', 13, 0))).toBe(true); // 下午开盘边界
    expect(isTradingTime(at('Thu', 14, 59))).toBe(true);
    expect(isTradingTime(at('Mon', 15, 0))).toBe(false); // 收盘边界
  });

  test('午休 11:30-13:00 非交易', () => {
    expect(isTradingTime(at('Wed', 12, 0))).toBe(false);
    expect(isTradingTime(at('Wed', 12, 59))).toBe(false);
  });

  test('盘前盘后非交易', () => {
    expect(isTradingTime(at('Mon', 9, 29))).toBe(false);
    expect(isTradingTime(at('Mon', 0, 0))).toBe(false);
    expect(isTradingTime(at('Mon', 15, 1))).toBe(false);
    expect(isTradingTime(at('Mon', 23, 59))).toBe(false);
  });

  test('周末休市', () => {
    expect(isTradingTime(at('Sat', 10, 0))).toBe(false);
    expect(isTradingTime(at('Sun', 14, 0))).toBe(false);
  });
});
