/**
 * @file PlanOrderPanel.tsx
 * @description AI 选股台 · 计划单 Tab：聚合展示全部计划单（进行中优先；已执行/已过期保留 3 天
 *              展示窗口，已取消不展示——与首页「计划单待办」同口径），支持执行/取消/跳转。
 *              提供「新增计划单」气泡入口（弹框录入）：表单统一复用公共模板 PlanOrderForm，
 *              去重规则（个股 × 方向唯一，未结束不可重复）由 useCreatePlanOrder 承载。
 *              行情订阅 / 底仓匹配 / 卡片网格由公共 PlanOrderList 承担，执行链路复用
 *              usePlanExecutor（与首页、短线页、中长期页同源）。
 * @layer View
 * @storage_impact 新增经 useCreatePlanOrder（store addPlannedOrder）落库；执行/取消经 ordersSlice。
 * @author 开发团队
 */

import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, Plus } from 'lucide-react';
import { useAppStore } from '../../store';
import { showToast } from '../../utils/toast';
import { filterDisplayablePlans, filterActivePlans } from '../../utils/planFilter';
import { usePlanExecutor } from '../../hooks/usePlanExecutor';
import { useCreatePlanOrder } from '../../hooks/useCreatePlanOrder';
import { usePlanReminder } from '../../hooks/usePlanReminder';
import { DIRECTION_LABEL } from '../../utils/planOrder';
import { deriveMonitorInput } from '../../utils/planReminder';
import type { PlannedOrder } from '../../store/types';
import PlanOrderList from '../../components/plan/PlanOrderList';
import PlanOrderForm, { type PlanOrderFormValues } from '../../components/plan/PlanOrderForm';
import EmptyState from '../../components/ui/EmptyState';

/**
 * AI 选股台 · 计划单 Tab 面板。
 *
 * @returns {JSX.Element} 计划单列表视图 + 新增入口
 */
export default function PlanOrderPanel() {
  const navigate = useNavigate();
  const plannedOrders = useAppStore((s) => s.plannedOrders);
  const cancelPlan = useAppStore((s) => s.cancelPlan);
  const createPlan = useCreatePlanOrder();
  const reminder = usePlanReminder();

  // 新增计划单弹框状态
  const [open, setOpen] = useState(false);

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

  /** 提交：校验 + 个股×方向去重（未结束不可重复）统一走 useCreatePlanOrder；提醒一并开启 */
  const handleSubmit = (values: PlanOrderFormValues): boolean => {
    const res = createPlan({
      stock: values.stock,
      context: values.context,
      direction: values.direction,
      plannedPrice: values.plannedPrice,
      plannedAmount: values.plannedAmount,
      validityDays: values.validityDays,
      thresholdRange: values.thresholdRange,
    });
    if (!res.ok) {
      showToast(res.reason);
      return false;
    }
    showToast(`📋 计划单已创建 · ${res.order.stockName} ${DIRECTION_LABEL[values.direction]}`);
    if (values.reminderEnabled) {
      const bandNum = values.reminderBand === '' ? 0 : parseFloat(values.reminderBand);
      void reminder.start(res.order, deriveMonitorInput(res.order, bandNum));
    }
    setOpen(false);
    return true;
  };

  return (
    <div className="space-y-3">
      {/* 新增计划单气泡入口 */}
      <div className="flex items-center justify-end">
        <button
          onClick={() => setOpen(true)}
          className="tap-target inline-flex items-center gap-1 rounded-full bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-xs font-medium text-white transition-colors"
          title="新增计划单"
        >
          <Plus className="h-3.5 w-3.5" />
          新增计划单
        </button>
      </div>

      {plans.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="暂无计划单"
          description="在短线交易 / 中长期交易页创建计划后，会在这里统一跟进"
        />
      ) : (
        <>
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
            onStopReminder={(order) => void reminder.stop(order)}
          />
        </>
      )}

      {/* 新增计划单弹框（表单复用公共模板 PlanOrderForm） */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-slate-600 bg-slate-800 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 text-base font-semibold text-slate-100">新增计划单</h3>
            <PlanOrderForm selectableContext onSubmit={handleSubmit} onCancel={() => setOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
