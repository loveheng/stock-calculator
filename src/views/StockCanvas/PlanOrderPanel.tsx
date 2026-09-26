/**
 * @file PlanOrderPanel.tsx
 * @description AI 选股台 · 计划单 Tab：聚合展示全部计划单（进行中优先；已执行/已过期保留 3 天
 *              展示窗口，已取消不展示——与首页「计划单待办」同口径），支持执行/取消/跳转。
 *              提供「新增计划单」气泡入口（弹框录入）：股票经 StockAutocomplete 调接口模糊匹配，
 *              去重规则（个股 × 方向唯一，未结束不可重复）由 useCreatePlanOrder 统一承载。
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
import { DIRECTION_LABEL, inferThresholdRange } from '../../utils/planOrder';
import { deriveMonitorInput } from '../../utils/planReminder';
import PlanReminderField from '../../components/monitor/PlanReminderField';
import type { PlannedOrder } from '../../store/types';
import type { StockSearchItem } from '../../types/stock';
import PlanOrderList from '../../components/plan/PlanOrderList';
import StockAutocomplete from '../../components/ui/StockAutocomplete';
import EmptyState from '../../components/ui/EmptyState';

const CONTEXT_OPTIONS: { id: PlannedOrder['context']; label: string }[] = [
  { id: 'short-term', label: '短线' },
  { id: 'long-term', label: '中长期' },
];

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
  const [stock, setStock] = useState<StockSearchItem | null>(null);
  const [direction, setDirection] = useState<PlannedOrder['direction']>('buy');
  const [context, setContext] = useState<PlannedOrder['context']>('short-term');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [validity, setValidity] = useState(3);
  const [error, setError] = useState('');
  // 价格阈值范围（可选）：两个端点价 + 自动推断比例
  const [thresholdLow, setThresholdLow] = useState('');
  const [thresholdHigh, setThresholdHigh] = useState('');
  const [ratio, setRatio] = useState('');
  // 价格提醒（预告单）：是否与计划单一并开启 + 容差
  const [reminderEnabled, setReminderEnabled] = useState(false);
  const [reminderBand, setReminderBand] = useState('');

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

  /** 重置弹框表单 */
  const resetForm = () => {
    setStock(null);
    setDirection('buy');
    setContext('short-term');
    setPrice('');
    setAmount('');
    setValidity(3);
    setError('');
    setThresholdLow('');
    setThresholdHigh('');
    setRatio('');
    setReminderEnabled(false);
    setReminderBand('');
  };

  /** 按比例自动推断阈值带：以计划价为圆心、ratio% 向两侧展开 */
  const handleInferRange = () => {
    const p = parseFloat(price);
    const r = parseFloat(ratio);
    if (!p || p <= 0) {
      showToast('请先填写计划价格');
      return;
    }
    if (!r || r <= 0) {
      showToast('请输入有效比例（%）');
      return;
    }
    const { low, high } = inferThresholdRange(p, r);
    setThresholdLow(low.toFixed(2));
    setThresholdHigh(high.toFixed(2));
  };

  /** 提交：校验 + 个股×方向去重（未结束不可重复），逻辑统一走 useCreatePlanOrder */
  const handleSubmit = async () => {
    setError('');
    if (!stock?.fullCode) {
      setError('请选择股票');
      return;
    }
    const p = parseFloat(price);
    const a = parseFloat(amount);
    if (!p || p <= 0) {
      setError('请输入有效价格');
      return;
    }
    if (!a || a <= 0) {
      setError('请输入有效数量');
      return;
    }
    // 阈值范围校验（可选）：填了则两端必须有效且 低<高
    let thresholdRange: { low: number; high: number } | undefined;
    if (thresholdLow !== '' || thresholdHigh !== '') {
      const lo = parseFloat(thresholdLow);
      const hi = parseFloat(thresholdHigh);
      if (Number.isNaN(lo) || Number.isNaN(hi) || lo <= 0 || hi <= 0) {
        setError('阈值价格无效');
        return;
      }
      if (lo >= hi) {
        setError('下端点价须小于上端点价');
        return;
      }
      thresholdRange = { low: lo, high: hi };
    }
    const res = createPlan({
      stock,
      context,
      direction,
      plannedPrice: p,
      plannedAmount: a,
      validityDays: validity,
      thresholdRange,
    });
    if (!res.ok) {
      showToast(res.reason);
      return;
    }
    showToast(`📋 计划单已创建 · ${res.order.stockName} ${DIRECTION_LABEL[direction]}`);
    if (reminderEnabled) {
      const bandNum = reminderBand === '' ? 0 : parseFloat(reminderBand);
      await reminder.start(res.order, deriveMonitorInput(res.order, bandNum));
    }
    setOpen(false);
    resetForm();
  };

  return (
    <div className="space-y-3">
      {/* 新增计划单气泡入口 */}
      <div className="flex items-center justify-end">
        <button
          onClick={() => {
            resetForm();
            setOpen(true);
          }}
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

      {/* 新增计划单弹框 */}
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

            <div className="space-y-3">
              {/* 股票（调接口模糊匹配） */}
              <div>
                <label className="mb-1 block text-xs text-slate-400">股票</label>
                <StockAutocomplete value={stock} onChange={setStock} />
              </div>

              {/* 方向 */}
              <div>
                <label className="mb-1 block text-xs text-slate-400">方向</label>
                <div className="flex gap-2">
                  {(['buy', 'sell'] as const).map((d) => (
                    <button
                      key={d}
                      onClick={() => setDirection(d)}
                      className={
                        'flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ' +
                        (direction === d
                          ? d === 'buy'
                            ? 'border-emerald-500 bg-emerald-500/15 text-emerald-400'
                            : 'border-red-500 bg-red-500/15 text-red-400'
                          : 'border-slate-700 text-slate-400 hover:border-slate-500')
                      }
                    >
                      {DIRECTION_LABEL[d]}
                    </button>
                  ))}
                </div>
              </div>

              {/* 上下文（决定执行后跳转页） */}
              <div>
                <label className="mb-1 block text-xs text-slate-400">类型</label>
                <div className="flex gap-2">
                  {CONTEXT_OPTIONS.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => setContext(c.id)}
                      className={
                        'flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ' +
                        (context === c.id
                          ? 'border-blue-500 bg-blue-500/15 text-blue-400'
                          : 'border-slate-700 text-slate-400 hover:border-slate-500')
                      }
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 价格 / 数量 */}
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="mb-1 block text-xs text-slate-400">计划价格</label>
                  <input
                    type="number"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    placeholder="0.00"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500"
                  />
                </div>
                <div className="flex-1">
                  <label className="mb-1 block text-xs text-slate-400">计划数量</label>
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              {/* 价格阈值范围（可选）：手动填两端点价，或按比例自动推断 */}
              <div>
                <label className="mb-1 block text-xs text-slate-400">价格阈值范围（可选）</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={thresholdLow}
                    onChange={(e) => setThresholdLow(e.target.value)}
                    placeholder="下端点价"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500"
                  />
                  <span className="text-slate-500">~</span>
                  <input
                    type="number"
                    value={thresholdHigh}
                    onChange={(e) => setThresholdHigh(e.target.value)}
                    placeholder="上端点价"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500"
                  />
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    type="number"
                    value={ratio}
                    onChange={(e) => setRatio(e.target.value)}
                    placeholder="比例"
                    className="w-20 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-blue-500"
                  />
                  <span className="text-xs text-slate-500">%</span>
                  <button
                    type="button"
                    onClick={handleInferRange}
                    className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:border-blue-500 hover:text-blue-400"
                  >
                    按比例自动推断
                  </button>
                </div>
              </div>

              {/* 有效期 */}
              <div>
                <label className="mb-1 block text-xs text-slate-400">有效期（天）</label>
                <input
                  type="number"
                  min={1}
                  value={validity}
                  onChange={(e) => setValidity(Math.max(1, parseInt(e.target.value || '1', 10)))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500"
                />
              </div>

              {/* 价格提醒（预告单）：与计划单一并开启后端到价推送 */}
              <PlanReminderField
                direction={direction}
                threshold={parseFloat(price)}
                thresholdRange={
                  thresholdLow !== '' && thresholdHigh !== '' &&
                  parseFloat(thresholdLow) > 0 &&
                  parseFloat(thresholdHigh) > 0 &&
                  parseFloat(thresholdLow) < parseFloat(thresholdHigh)
                    ? { low: parseFloat(thresholdLow), high: parseFloat(thresholdHigh) }
                    : undefined
                }
                stock={stock}
                enabled={reminderEnabled}
                onEnabledChange={setReminderEnabled}
                band={reminderBand}
                onBandChange={setReminderBand}
              />

              {error && <p className="text-xs text-red-400">{error}</p>}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="rounded-xl px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-700"
              >
                取消
              </button>
              <button
                onClick={handleSubmit}
                className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
