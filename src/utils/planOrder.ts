/**
 * @file planOrder.ts
 * @description 计划单构建与去重逻辑单一事实源：统一 PlannedOrder 字段映射（buildPlannedOrder）、
 *              进行中个股×方向去重判断（findActiveDuplicate）。短线页 / 中长期页（构造复用
 *              buildPlannedOrder）+ AI 选股台计划单 Tab（含去重，经 useCreatePlanOrder 复用）同源，
 *              杜绝「各页面各写一套」的字段漂移。股票检索的模糊匹配由 StockAutocomplete
 *              （services/stockService.searchStocks）承担，选中即落库 meta。
 * @layer Utils（纯函数，禁依赖 store/db —— 满足 check-layers R2）
 * @storage_impact 纯函数，无存储读写；落库由调用方（hooks/store/services）负责。
 * @author 开发团队
 */

import type { PlannedOrder } from '../types/domain';
import { generateId } from './idGenerator';

/** 方向中文标签（计划单通用展示） */
export const DIRECTION_LABEL: Record<PlannedOrder['direction'], string> = { buy: '买入', sell: '卖出' };

/** buildPlannedOrder 入参 */
export interface PlanOrderBuildInput {
  /** 完整证券代码（含市场前缀，如 sh601318） */
  fullCode: string;
  /** 股票名称（缺省回退 fullCode） */
  stockName: string;
  /** 上下文（决定执行后跳转页） */
  context: PlannedOrder['context'];
  /** 方向（买 / 卖） */
  direction: PlannedOrder['direction'];
  /** 计划价格 */
  plannedPrice: number;
  /** 计划数量 */
  plannedAmount: number;
  /** 有效期（天） */
  validityDays: number;
  /** 价格阈值带（围绕计划价的两端，可选） */
  thresholdRange?: { low: number; high: number };
  /** 基准时间（缺省 = 当前）；注入便于测试 */
  validityBase?: Date;
}

/**
 * 统一构建一条「进行中」计划单（PlannedOrder）。
 *
 * @description 字段映射唯一来源：id / 时间戳 / expiresAt / status 均由此处计算，
 *              各页面不再各自 new Date() 拼装，避免口径漂移。
 */
export function buildPlannedOrder(input: PlanOrderBuildInput): PlannedOrder {
  const now = input.validityBase ?? new Date();
  const expiresAt = new Date(now.getTime() + input.validityDays * 24 * 60 * 60 * 1000);
  const stockName = input.stockName.trim() || input.fullCode;
  return {
    id: generateId(),
    fullCode: input.fullCode,
    stockName,
    context: input.context,
    direction: input.direction,
    plannedPrice: input.plannedPrice,
    plannedAmount: input.plannedAmount,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    validityDays: input.validityDays,
    status: 'active',
    ...(input.thresholdRange
      ? { thresholdRange: { low: input.thresholdRange.low, high: input.thresholdRange.high } }
      : {}),
  };
}

/**
 * 按比例自动推断价格阈值带：以 center 为中心，按 ratioPct%（相对比例）向两侧对称展开。
 *
 * @example inferThresholdRange(100, 5) => { low: 95, high: 105 }
 * @param {number} center - 中心价（通常为计划价）
 * @param {number} ratioPct - 单边比例（百分比，如 5 表示 ±5%）
 * @returns {{ low: number; high: number }} 下/上端点价
 */
export function inferThresholdRange(center: number, ratioPct: number): { low: number; high: number } {
  const r = Math.max(0, ratioPct) / 100;
  return { low: center * (1 - r), high: center * (1 + r) };
}

/**
 * 查找是否已有「未结束」的相同个股 + 相同方向的计划单（去重判断）。
 *
 * @description 口径：同 fullCode + 同 direction + status==='active' + 未过期即视为重复；
 *              已过期 / 已执行 / 已取消不拦截（允许重排）。与「每个还没结束的个股每个方向
 *              只能添加一次」需求一致。
 * @returns {PlannedOrder | undefined} 命中的重复单（供提示文案引用），无则 undefined
 */
export function findActiveDuplicate(
  orders: PlannedOrder[],
  fullCode: string,
  direction: PlannedOrder['direction'],
  now: number = Date.now(),
): PlannedOrder | undefined {
  return orders.find(
    (o) =>
      o.fullCode === fullCode &&
      o.direction === direction &&
      o.status === 'active' &&
      new Date(o.expiresAt).getTime() > now,
  );
}
