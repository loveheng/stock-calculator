/**
 * @file PlanOrderPanel.tsx
 * @description AI 选股台 · 计划单 Tab：聚合展示全部计划单（进行中优先；已执行/已过期保留 3 天
 *              展示窗口，已取消不展示——与首页「计划单待办」同口径），支持执行/取消/跳转。
 *              行情订阅 / 底仓匹配 / 卡片网格由公共 PlanOrderList 承担，执行链路复用
 *              usePlanExecutor（与首页、短线页、中长期页同源）。
 * @layer View
 * @storage_impact 不直接读写 IndexedDB；执行/取消经 store ordersSlice 落库。
 * @author 开发团队
 */

import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList } from 'lucide-react';
import { useAppStore } from '../../store';
import { showToast } from '../../utils/toast';
import { filterDisplayablePlans, filterActivePlans } from '../../utils/planFilter';
import { usePlanExecutor } from '../../hooks/usePlanExecutor';
import type { PlannedOrder } from '../../store/types';
import PlanOrderList from '../../components/plan/PlanOrderList';
import EmptyState from '../../components/ui/EmptyState';


/**
 * AI 选股台 · 计划单 Tab 面板。
 *
 * @returns {JSX.Element} 计划单列表视图
 */
export default function PlanOrderPanel() {
  const navigate = useNavigate();
  const plannedOrders = useAppStore((s) => s.plannedOrders);
  const cancelPlan = useAppStore((s) => s.cancelPlan);

  // 展示窗口过滤：与首页/短线/中长期页同源（cancelled 剔除；executed/expired 仅 3 天内）
  const plans = useMemo(
    () =>
      filterDisplayablePlans(plannedOrders).sort((a, b) => {
        // 进行中置顶，其余按过期时间倒序
        const rank = (p: PlannedOrder) => (p.status === 'active' ? 0 : 1);
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        return new Date(b.expiresAt).getTime() - new Date(a.expiresAt).getTime();
      }),
    [plannedOrders],
  );

  const activeCount = useMemo(() => filterActivePlans(plans).length, [plans]);

  /** 执行计划单：统一走 usePlanExecutor（与首页/短线页/中长期页同源） */
  const executePlan = usePlanExecutor();
  const handleExecute = useCallback(
    (order: PlannedOrder, actualPrice: number, actualAmount: number, note: string) => {
      const res = executePlan(order, actualPrice, actualAmount, note);
      if (!res.ok && res.reason) showToast(res.reason);
    },
    [executePlan],
  );

  /** 跳转：短线 → 短线交易页；中长期 → 中长期交易页 */
  const handleNavigate = useCallback(
    (order: PlannedOrder) => {
      navigate(order.context === 'short-term' || order.context === 'both' ? '/t-calculator' : '/cost-averaging');
    },
    [navigate],
  );

  if (plans.length === 0) {
    return (
      <EmptyState
        icon={ClipboardList}
        title="暂无计划单"
        description="在短线交易 / 中长期交易页创建计划后，会在这里统一跟进"
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span>共 {plans.length} 条</span>
        <span className="text-slate-700">|</span>
        <span className="text-emerald-400">进行中 {activeCount} 条</span>
      </div>
      <PlanOrderList
        orders={plans}
        onExecute={handleExecute}
        onCancel={cancelPlan}
        onNavigate={handleNavigate}
      />
    </div>
  );
}
