/**
 * @file PlanOrderForm.tsx
 * @description 计划单创建通用模板（抽自 AI 选股台 · 计划单 Tab 的「新增计划单」表单）：
 *  - 股票 / 方向 / 计划价格 / 计划数量
 *  - 有效期：固定 3·7·14·30 天，不可自由填写（prop VALIDITY_PRESETS）
 *  - 「价格阈值范围」并入「开启价格提醒」区块，仅开启提醒后可填，支持比例(%)或绝对值(元)（默认比例 1%）
 *  纯 UI + 本地状态 + 基础字段校验，提交时经 onSubmit 回传结构化字段，由调用方落库 / 开提醒。
 *  抽离后供 AI 选股台、短线交易、中长期交易三处「新增计划单」复用，消除三套表单漂移。
 * @layer UI
 * @author 开发团队
 */

import { useState } from 'react';
import { computeThresholdRange, DIRECTION_LABEL, type ThresholdUnit } from '../../utils/planOrder';
import type { PlannedOrder } from '../../store/types';
import type { StockSearchItem } from '../../types/stock';
import StockAutocomplete from '../ui/StockAutocomplete';
import PlanReminderField from '../monitor/PlanReminderField';

/** 有效期固定选项（天），不让用户自由填写 */
export const VALIDITY_PRESETS = [3, 7, 14, 30] as const;

/** 模板对外回传的字段 */
export interface PlanOrderFormValues {
  stock: StockSearchItem;
  context: PlannedOrder['context'];
  direction: PlannedOrder['direction'];
  plannedPrice: number;
  plannedAmount: number;
  validityDays: number;
  /** 价格阈值带：仅开启提醒且填了幅度时存在（无论比例/值口径，均换算为绝对价存储） */
  thresholdRange?: { low: number; high: number };
  reminderEnabled: boolean;
  reminderBand: string;
}

/** 编辑回填用的初始值（缺省字段用默认） */
export interface PlanOrderInitialValues {
  stock?: StockSearchItem | null;
  context?: PlannedOrder['context'];
  direction?: PlannedOrder['direction'];
  plannedPrice?: number;
  plannedAmount?: number;
  validityDays?: number;
  thresholdRange?: { low: number; high: number };
  reminderEnabled?: boolean;
  reminderBand?: string;
}

interface PlanOrderFormProps {
  /** 固定上下文；selectableContext 为 true 时本字段仅作初始值 */
  context?: PlannedOrder['context'];
  /** 是否展示「类型」选择（AI 选股台为 true；短线/中长期页为 false，由 context 固定） */
  selectableContext?: boolean;
  /** 编辑回填初始值 */
  initialValues?: PlanOrderInitialValues;
  /** 提交：返回 false 表示失败（如去重未通过），表单保持打开；其余视为成功并重置 */
  onSubmit: (values: PlanOrderFormValues) => boolean | void;
  /** 取消回调（提供则渲染「取消」按钮） */
  onCancel?: () => void;
  /** 提交按钮文案 */
  submitLabel?: string;
}

const DEFAULT_CONTEXT: PlannedOrder['context'] = 'short-term';

/** 由阈值带反推比例（%），用于编辑回填 */
function rangeToPct(range: { low: number; high: number }, center: number): string {
  if (!(center > 0)) return '1';
  const pct = ((range.high - range.low) / (2 * center)) * 100;
  return Number.isFinite(pct) && pct > 0 ? String(Math.round(pct)) : '1';
}

/**
 * 计划单创建通用模板。
 *
 * @returns {JSX.Element} 表单字段 + 底部操作按钮
 */
export default function PlanOrderForm({
  context = DEFAULT_CONTEXT,
  selectableContext = false,
  initialValues,
  onSubmit,
  onCancel,
  submitLabel = '创建',
}: PlanOrderFormProps) {
  const [stock, setStock] = useState<StockSearchItem | null>(initialValues?.stock ?? null);
  const [ctx, setCtx] = useState<PlannedOrder['context']>(initialValues?.context ?? context);
  const [direction, setDirection] = useState<PlannedOrder['direction']>(initialValues?.direction ?? 'buy');
  const [price, setPrice] = useState(initialValues?.plannedPrice != null ? String(initialValues.plannedPrice) : '');
  const [amount, setAmount] = useState(initialValues?.plannedAmount != null ? String(initialValues.plannedAmount) : '');
  const [validity, setValidity] = useState<number>(initialValues?.validityDays ?? 3);
  const [reminderEnabled, setReminderEnabled] = useState(initialValues?.reminderEnabled ?? false);
  const [reminderBand, setReminderBand] = useState(initialValues?.reminderBand ?? '');
  /** 阈值范围填写单位：'pct' 比例(%)，'value' 绝对值(元)；默认比例 */
  const [thresholdUnit, setThresholdUnit] = useState<ThresholdUnit>('pct');
  const [thresholdInput, setThresholdInput] = useState(
    initialValues?.thresholdRange ? rangeToPct(initialValues.thresholdRange, initialValues.plannedPrice ?? 1) : '1',
  );
  const [error, setError] = useState('');

  const handleSubmit = () => {
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
    const amt = thresholdInput === '' ? 0 : parseFloat(thresholdInput);
    const thresholdRange =
      reminderEnabled && amt > 0 ? computeThresholdRange(p, thresholdUnit, amt) : undefined;
    const ok = onSubmit({
      stock,
      context: ctx,
      direction,
      plannedPrice: p,
      plannedAmount: a,
      validityDays: validity,
      thresholdRange,
      reminderEnabled,
      reminderBand,
    });
    if (ok !== false) {
      setStock(null);
      setCtx(context);
      setDirection('buy');
      setPrice('');
      setAmount('');
      setValidity(3);
      setReminderEnabled(false);
      setReminderBand('');
      setThresholdUnit('pct');
      setThresholdInput('1');
      setError('');
    }
  };

  return (
    <div className="space-y-3">
      {/* 股票 */}
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
              type="button"
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

      {/* 类型（仅 AI 选股台可选） */}
      {selectableContext && (
        <div>
          <label className="mb-1 block text-xs text-slate-400">类型</label>
          <div className="flex gap-2">
            {([{ id: 'short-term', label: '短线' }, { id: 'long-term', label: '中长期' }] as const).map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCtx(c.id)}
                className={
                  'flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ' +
                  (ctx === c.id
                    ? 'border-blue-500 bg-blue-500/15 text-blue-400'
                    : 'border-slate-700 text-slate-400 hover:border-slate-500')
                }
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
      )}

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

      {/* 有效期：固定 3/7/14/30 天，不可自由填写 */}
      <div>
        <label className="mb-1 block text-xs text-slate-400">有效期（天）</label>
        <div className="flex gap-1.5">
          {VALIDITY_PRESETS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setValidity(d)}
              className={`flex-1 rounded-lg py-1.5 text-xs transition-colors ${
                validity === d ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}
            >
              {d}天
            </button>
          ))}
        </div>
      </div>

      {/* 价格提醒（含价格阈值范围） */}
      <PlanReminderField
        direction={direction}
        threshold={parseFloat(price)}
        stock={stock}
        enabled={reminderEnabled}
        onEnabledChange={setReminderEnabled}
        band={reminderBand}
        onBandChange={setReminderBand}
        thresholdUnit={thresholdUnit}
        onThresholdUnitChange={setThresholdUnit}
        thresholdInput={thresholdInput}
        onThresholdInputChange={setThresholdInput}
      />

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-700"
          >
            取消
          </button>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
