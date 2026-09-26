/**
 * @file planFilter.ts
 * @description 计划单展示过滤单一事实源：已取消剔除 + 已执行/已过期仅保留 3 天展示窗口
 *              （供复盘）+ 上下文白名单（短线/中长期强隔离）。首页、短线交易页、中长期
 *              交易页、AI 选股台计划单 Tab 与 Copilot 快照（buildHomePlanContext）同源，
 *              杜绝「视图一套、快照一套」的口径漂移。
 * @layer Utils
 * @storage_impact 纯函数，无存储读写。
 * @author 开发团队
 */

import type { PlannedOrder } from '../types/domain';

/** 已执行/已过期计划单的展示窗口（3 天，供复盘） */
export const PLAN_DISPLAY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export interface PlanFilterOptions {
  /** 上下文白名单；缺省 = 不过滤上下文（全部展示） */
  contexts?: ReadonlyArray<PlannedOrder['context']>;
  /** 展示窗口（ms）；缺省 PLAN_DISPLAY_WINDOW_MS */
  windowMs?: number;
  /** 时间基准（注入便于测试与快照）；缺省 Date.now() */
  now?: number;
}

/**
 * 过滤出「当前应展示」的计划单。
 *
 * @description 口径：cancelled 一律剔除；expired/executed 仅在过期后窗口内保留；
 *              active 全量保留（status 滞后由时间实时判断兜底）。
 * @param {PlannedOrder[]} orders - 全量计划单
 * @param {PlanFilterOptions} [options] - 上下文白名单 / 窗口 / 时间基准
 * @returns {PlannedOrder[]} 应展示的计划单（输入顺序保持）
 */
export function filterDisplayablePlans(
  orders: PlannedOrder[],
  options: PlanFilterOptions = {},
): PlannedOrder[] {
  const { contexts, windowMs = PLAN_DISPLAY_WINDOW_MS, now = Date.now() } = options;
  return orders.filter((p) => {
    if (p.status === 'cancelled') return false;
    if (contexts && !contexts.includes(p.context)) return false;
    if (p.status === 'expired' || p.status === 'executed') {
      return now - new Date(p.expiresAt).getTime() <= windowMs;
    }
    return true;
  });
}

/**
 * 过滤出「进行中」的计划单（status=active 且未过期——不信任滞后的 status）。
 *
 * @param {PlannedOrder[]} orders - 计划单（通常先过 filterDisplayablePlans）
 * @param {number} [now] - 时间基准；缺省 Date.now()
 * @returns {PlannedOrder[]} 进行中的计划单
 */
export function filterActivePlans(orders: PlannedOrder[], now: number = Date.now()): PlannedOrder[] {
  return orders.filter((p) => p.status === 'active' && new Date(p.expiresAt).getTime() > now);
}
