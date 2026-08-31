/**
 * @file ordersSlice.ts
 * @description Store 计划单切片：计划单的加载 / 设置（同标的覆盖 active 单）/ 删除 /
 *              标记执行 / 取消。从 store/index.ts 拆出，index 只负责组装。
 * @layer Store (Slice)
 * @storage_impact 经 safePersist 写 plannedOrders 表。
 * @author 开发团队
 */

import type { StateCreator } from 'zustand';
import { loadPlannedOrdersFromDB, putPlannedOrder, deletePlannedOrder } from '../../db/index';
import { safePersist } from '../persistence';
import type { AppStore } from '../types';

export type OrdersSlice = Pick<
  AppStore,
  'loadPlannedOrders' | 'setPlannedOrder' | 'removePlannedOrder' | 'markPlanExecuted' | 'cancelPlan'
>;

export const createOrdersSlice: StateCreator<AppStore, [], [], OrdersSlice> = (set, get) => ({

  loadPlannedOrders: async () => {
    const orders = await loadPlannedOrdersFromDB();
    if (orders.length) set({ plannedOrders: orders });
  },
  setPlannedOrder: (order) => {
    set((s) => {
      // 同标的覆盖：移除该标的已有的 active 计划单
      const filtered = s.plannedOrders.filter((p) => !(p.fullCode === order.fullCode && p.status === 'active'));
      return { plannedOrders: [...filtered, order] };
    });
    safePersist(() => putPlannedOrder(order));
  },
  removePlannedOrder: (id) => {
    set((s) => ({ plannedOrders: s.plannedOrders.filter((p) => p.id !== id) }));
    safePersist(() => deletePlannedOrder(id));
  },
  markPlanExecuted: (id, actual) => {
    set((s) => ({
      plannedOrders: s.plannedOrders.map((p) =>
        p.id === id ? { ...p, status: 'executed' as const, actual } : p
      ),
    }));
    const order = get().plannedOrders.find((p) => p.id === id);
    if (order) safePersist(() => putPlannedOrder(order));
  },
  cancelPlan: (id) => {
    set((s) => ({
      plannedOrders: s.plannedOrders.map((p) =>
        p.id === id ? { ...p, status: 'cancelled' as const } : p
      ),
    }));
    const order = get().plannedOrders.find((p) => p.id === id);
    if (order) safePersist(() => putPlannedOrder(order));
  },
});
