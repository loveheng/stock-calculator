/**
 * @file useCreatePlanOrder.ts
 * @description 计划单创建流程 Hook（状态逻辑层）：聚合「去重校验 → 构建 → 落库」于单一入口，
 *              供 AI 选股台计划单 Tab 的新增弹框复用；短线 / 中长期页若需接入去重亦可直接复用。
 *              纯字段构造见 utils/planOrder.ts（满足 check-layers R2 分层）。股票 meta 落库由
 *              StockAutocomplete 在选中时经 services/stockService.persistStockMeta 完成，本 Hook 不重复处理。
 * @layer Hook（状态逻辑）
 * @storage_impact 经 store addPlannedOrder 落 plannedOrders 表。
 * @author 开发团队
 */

import { useCallback } from 'react';
import { useAppStore } from '../store';
import type { StockSearchItem } from '../types/stock';
import type { PlannedOrder } from '../types/domain';
import { buildPlannedOrder, findActiveDuplicate, DIRECTION_LABEL } from '../utils/planOrder';

/** useCreatePlanOrder 入参 */
export interface CreatePlanInput {
  /** 已搜索选择或手动构造的股票项 */
  stock: StockSearchItem;
  /** 上下文（决定执行后跳转页） */
  context: PlannedOrder['context'];
  /** 方向 */
  direction: PlannedOrder['direction'];
  /** 计划价格 */
  plannedPrice: number;
  /** 计划数量 */
  plannedAmount: number;
  /** 有效期（天） */
  validityDays: number;
  /** 价格阈值带（围绕计划价的两端，可选） */
  thresholdRange?: { low: number; high: number };
}

/** 创建结果 */
export type CreatePlanResult =
  | { ok: true; order: PlannedOrder }
  | { ok: false; reason: string };

/**
 * 计划单创建入口：去重 + 构建 + 落库一体化。
 *
 * @returns {(input: CreatePlanInput) => CreatePlanResult} 创建函数；重复时返回 reason（供调用方提示）
 */
export function useCreatePlanOrder() {
  const plannedOrders = useAppStore((s) => s.plannedOrders);
  const addPlannedOrder = useAppStore((s) => s.addPlannedOrder);

  return useCallback(
    (input: CreatePlanInput): CreatePlanResult => {
      const { stock, context, direction, plannedPrice, plannedAmount, validityDays } = input;
      const stockName = stock.Name || stock.ShortName || stock.fullCode;

      // 去重：未结束的相同个股 + 相同方向仅允许一条
      const dup = findActiveDuplicate(plannedOrders, stock.fullCode, direction);
      if (dup) {
        return {
          ok: false,
          reason: `「${stockName}」${DIRECTION_LABEL[direction]}计划单已存在（进行中），不可重复添加`,
        };
      }

      const order = buildPlannedOrder({
        fullCode: stock.fullCode,
        stockName,
        context,
        direction,
        plannedPrice,
        plannedAmount,
        validityDays,
      });
      addPlannedOrder(order);

      return { ok: true, order };
    },
    [plannedOrders, addPlannedOrder],
  );
}
