/**
 * @file tradingTime.ts
 * @description A股交易时段判断工具：连续竞价时段为周一至周五 09:30-11:30 与 13:00-15:00
 *              （Asia/Shanghai 时区判定，与设备本地时区解耦）。
 *              注意：未内置法定节假日交易日历，节假日仍按工作日时段判断，
 *              如需更精确可在此基础上扩展节假日表。
 * @layer Utils
 * @storage_impact 纯函数，无任何存储读写。
 * @author 开发团队
 */

/** 上午开盘 09:30 → 当日分钟数 */
const MORNING_OPEN_MINUTES = 9 * 60 + 30;
/** 上午收盘 11:30 → 当日分钟数 */
const MORNING_CLOSE_MINUTES = 11 * 60 + 30;
/** 下午开盘 13:00 → 当日分钟数 */
const AFTERNOON_OPEN_MINUTES = 13 * 60;
/** 下午收盘 15:00 → 当日分钟数 */
const AFTERNOON_CLOSE_MINUTES = 15 * 60;

/**
 * 判断给定时间是否处于 A 股连续竞价交易时段。
 *
 * @description 交易时段 = 周一至周五 09:30-11:30 / 13:00-15:00。
 *              边界规则：09:30 / 13:00 整点视为已开盘（交易中）；
 *              11:30 / 15:00 整点视为已收盘（非交易）。
 *              使用 Asia/Shanghai 时区判定，与设备本地时区无关。
 * @param {Date} date - 待判断的时间点
 * @returns {boolean} 处于交易时段返回 true，否则返回 false
 */
export function isTradingTime(date: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  // 周末（周六/周日）休市
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const now = hour * 60 + minute;

  return (
    (now >= MORNING_OPEN_MINUTES && now < MORNING_CLOSE_MINUTES) ||
    (now >= AFTERNOON_OPEN_MINUTES && now < AFTERNOON_CLOSE_MINUTES)
  );
}
