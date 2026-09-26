/**
 * @file planReminder.ts
 * @description 计划单 → 后端价格提醒（预告单）参数映射：将本地 PlannedOrder 的
 *              方向 / 目标价 / 价格阈值带推导为 monitorService.startMonitor 入参。
 *              映射口径与 docs/monitor/api.md §6.1 单边判定一致：
 *              BUY + 容差 0 → PRICE_BELOW（跌破目标价即提醒）；其余 → PRICE_NEAR（区间）。
 *              SELL 仅容 PRICE_NEAR（后端组合校验），容差默认 0（价格涨到目标价即提醒）。
 * @layer Utils（纯函数；类型仅 import type，零运行时依赖）
 * @storage_impact 纯函数，无存储读写。
 * @author 开发团队
 */

import type { PlannedOrder } from '../types/domain';
import type { MonitorStartInput } from '../services/monitorService';

/**
 * 由计划单与用户设定的容差推导监控入参。
 *
 * @param order - 已创建的本地计划单（提供 fullCode / 方向 / 目标价）
 * @param band - 容差（元）；≤0 时 BUY 走 PRICE_BELOW、SELL 走 PRICE_NEAR(band=0)
 * @returns startMonitor 入参
 */
export function deriveMonitorInput(order: PlannedOrder, band: number): MonitorStartInput {
  const direction = order.direction === 'buy' ? 'BUY' : 'SELL';
  const threshold = order.plannedPrice;
  const safeBand = Number.isFinite(band) && band > 0 ? band : 0;
  if (direction === 'BUY' && safeBand === 0) {
    return { fullCode: order.fullCode, direction, type: 'PRICE_BELOW', threshold };
  }
  return { fullCode: order.fullCode, direction, type: 'PRICE_NEAR', threshold, band: safeBand };
}

/**
 * 由计划单的价格阈值带推导默认容差（用于预填表单）：
 * BUY → 上端点 − 目标价（跌入区间上沿即触发）；SELL → 目标价 − 下端点（涨入区间下沿即触发）。
 * 无阈值带时返回 0（价格到目标价即触发，BUY 即跌破）。
 *
 * @param order - 计划单（含可选 thresholdRange）
 * @returns 默认容差（元），≥0
 */
export function defaultBand(order: PlannedOrder): number {
  const r = order.thresholdRange;
  if (!r || !(r.low > 0) || !(r.high > 0)) return 0;
  const band = order.direction === 'buy' ? r.high - order.plannedPrice : order.plannedPrice - r.low;
  return band > 0 ? band : 0;
}
