/**
 * @file sandboxFixture.ts
 * @description 沙盘推演测试共享夹具：持续持仓 + 倒T归并 的中长期标的（中国平安）。
 *              提供：
 *              - FULL_CODE / STOCK_NAME：标的标识；
 *              - makePosition()：4 笔真实批次（开 1000 → 加 500 → 减 300 → 归并 +200 →
 *                末端 1400 股），供基线派生与引擎自洽校验；
 *              - weekdayDates()：跳过周末的交易日日期序列（UTC）；
 *              - makeKline()：90 根前复权日 K 线从 10.0 缓涨到 13.5（振幅 2%，
 *                MA20/MA60 均有值）。
 *
 *              批次 fee 与引擎 calcTradeFees 口径一致（默认费率：佣金 0.025% 不免五 →
 *              最低 5 元；过户 0.001%；印花 0.05% 仅卖出），保证基线峰值资金
 *              （16010.16）与引擎重演现金流出完全自洽，基线自身永不触资金约束：
 *              - b1 买 10000：佣金 5.00 + 过户 0.10 = 5.10
 *              - b2 买 6000：佣金 5.00 + 过户 0.06 = 5.06
 *              - b3 卖 3900：佣金 5.00 + 过户 0.04 + 印花 1.95 = 6.99
 *              - b4 买 2500：佣金 5.00 + 过户 0.03 = 5.03
 * @layer Test
 * @storage_impact 纯数据夹具，无任何副作用。
 * @author 开发团队
 */

import type { Position } from '../../store/types';
import type { KlineItem } from '../../types/sandbox';

export const FULL_CODE = 'sh601318';
export const STOCK_NAME = '中国平安';

/**
 * 真实持仓：开 1000 → 加 500 → 减 300 → 归并 +200 → 1400 股。
 */
export function makePosition(): Position {
  return {
    id: 'pos-1',
    stockName: STOCK_NAME,
    fullCode: FULL_CODE,
    currentCost: 10.93, // (10.67×1200 + 12.5×200) / 1400（约）
    currentAmount: 1400,
    realizedPnL: 0,
    totalInvested: 15300,
    isClosed: false,
    createdAt: '2026-01-05T09:30:00+08:00',
    batches: [
      { id: 'b1', timestamp: '2026-01-05T09:30:00+08:00', type: 'open', price: 10, amount: 1000, costAfter: 10, amountAfter: 1000, fee: 5.1 },
      { id: 'b2', timestamp: '2026-01-15T09:30:00+08:00', type: 'add', price: 12, amount: 500, costAfter: 10.67, amountAfter: 1500, fee: 5.06 },
      { id: 'b3', timestamp: '2026-02-05T09:30:00+08:00', type: 'reduce', price: 13, amount: -300, costAfter: 10.67, amountAfter: 1200, fee: 6.99 },
      // 倒T超额买回归并（短线交易归入中长期底仓）
      { id: 'b4', timestamp: '2026-02-10T09:30:00+08:00', type: 'add', kind: 'merge', price: 12.5, amount: 200, costAfter: 10.93, amountAfter: 1400, fee: 5.03 },
    ],
  };
}

/** 生成从 start 起 count 个交易日（跳过周末）的日期序列（UTC，与引擎测试一致） */
export function weekdayDates(start: string, count: number): string[] {
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

/** 前复权日 K 线：90 根从 10.0 缓涨到 13.5（振幅 2%，MA20/MA60 均有值） */
export function makeKline(count = 90): KlineItem[] {
  const dates = weekdayDates('2025-11-03', count);
  const round2 = (v: number) => Math.round(v * 100) / 100;
  return dates.map((date, i) => {
    const close = round2(10 * (1 + (0.35 * i) / (count - 1)));
    const open = i === 0 ? close : round2(10 * (1 + (0.35 * (i - 1)) / (count - 1)));
    return { date, open, close, high: round2(close * 1.02), low: round2(close * 0.98), volume: 1000 };
  });
}
