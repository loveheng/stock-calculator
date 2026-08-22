/**
 * @file OrderTimeline.tsx
 * @description 沙盘操作时间线编辑区（规格书 §9.2-②③④）：按时间序渲染订单行，
 *              user 分支可编辑（价格 ±0.01 步进、数量 100 股步进、日期 ◀前1日/前5日/
 *              后5日/后1日▶ 微调、恢复为基线值、删除），顶部提供批量变换
 *              （买单 ×50%/×150%/×200%、价格全局偏移 ±2%、卖单平移 N 交易日）。
 *              baseline/preset 分支只读展示（悬浮 Tooltip 引导「复制并微调」）。
 *              被修改过的行（相对基线值有差异）以琥珀色描边高亮，配合底部
 *              「▶ 运行并保存 / 撤销修改」浮动栏形成显式提交闭环（§9.6）。
 *
 * 【Hooks 规范】行级编辑需要长按连加 Hook，故每行拆分为独立组件 OrderRow，
 *  确保 Hook 调用次数在各次渲染间稳定（不在 map 内联调用 Hook）。
 * @layer UI
 * @storage_impact 纯展示组件；编辑动作通过 onChange 回调父级 → store.updateUserOrders
 *                 （草稿：仅内存 + 标记未保存，不落库）。
 * @author 开发团队
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, Plus, RotateCcw, Trash2, TrendingUp, TrendingDown } from 'lucide-react';
import type { EngineRejection } from '../../utils/sandboxEngine';
import type { KlineItem, SandboxOrder } from '../../types/sandbox';
import { useSandboxStore } from '../../store/sandboxStore';

/** 长按连加 Hook：按住按钮持续触发（120ms 间隔），松手/移出停止 */
function useHoldRepeat(callback: () => void, disabled: boolean) {
  const timerRef = useRef<number | null>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const stop = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const start = () => {
    if (disabled) return;
    callbackRef.current();
    timerRef.current = window.setInterval(() => callbackRef.current(), 120);
  };

  useEffect(() => stop, []);

  return {
    onMouseDown: (e: React.MouseEvent) => { e.preventDefault(); start(); },
    onMouseUp: stop,
    onMouseLeave: stop,
    onTouchStart: (e: React.TouchEvent) => { e.preventDefault(); start(); },
    onTouchEnd: stop,
  };
}

/** 日期平移：在 K 线序列中找当前日期（或最近前一日），平移 delta 个交易日 */
export function shiftDate(ts: string, kline: KlineItem[], deltaDays: number): string {
  const day = ts.slice(0, 10);
  const idx = kline.findIndex((k) => k.date === day);
  const baseIdx = idx >= 0 ? idx : kline.findIndex((k) => k.date > day);
  if (baseIdx < 0) return ts;
  const targetIdx = Math.min(kline.length - 1, Math.max(0, baseIdx + deltaDays));
  return `${kline[targetIdx].date}T09:30:00+08:00`;
}

/** 100 股取整（最少 100） */
export function toLot(qty: number): number {
  return Math.max(100, Math.round(qty / 100) * 100);
}

/** 价格四舍五入到分 */
export function roundPrice(p: number): number {
  return Math.round(p * 100) / 100;
}

// ============================================================
// 单行组件（独立组件保证 Hook 稳定）
// ============================================================

interface OrderRowProps {
  order: SandboxOrder;
  index: number;
  readonly: boolean;
  /** 相对基线值是否被修改 */
  changed: boolean;
  kline: KlineItem[];
  asOfDate?: string;
  /** 该行命中资金不足拒绝（仅展示醒目的警告徽章，不弹窗阻断） */
  cashWarning?: string;
  onPatch: (id: string, patch: Partial<SandboxOrder>) => void;
  onRemove: (id: string) => void;
  /** 恢复为基线值（由父级按日期+方向查基线订单） */
  onRestore: (order: SandboxOrder) => void;
}

function OrderRow({ order, index, readonly, changed, kline, asOfDate, cashWarning, onPatch, onRemove, onRestore }: OrderRowProps) {
  const day = order.timestamp.slice(0, 10);

  const moveDate = (delta: number) => {
    const next = shiftDate(order.timestamp, kline, delta);
    if (delta > 0 && asOfDate && next.slice(0, 10) > asOfDate) return; // 不允许移过评估日
    onPatch(order.id, { timestamp: next });
  };

  // 长按连按（日期 ±1 / 价格 ±0.01 / 数量 ±100）
  const prevDayHold = useHoldRepeat(() => moveDate(-1), false);
  const nextDayHold = useHoldRepeat(() => moveDate(1), false);
  const priceMinusHold = useHoldRepeat(() => onPatch(order.id, { price: roundPrice(order.price - 0.01) }), false);
  const pricePlusHold = useHoldRepeat(() => onPatch(order.id, { price: roundPrice(order.price + 0.01) }), false);
  const qtyMinusHold = useHoldRepeat(() => onPatch(order.id, { quantity: Math.max(100, order.quantity - 100) }), false);
  const qtyPlusHold = useHoldRepeat(() => onPatch(order.id, { quantity: order.quantity + 100 }), false);

  return (
    <div
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-2 py-1.5 text-xs transition-colors ${
        changed ? 'border-amber-500/50 bg-amber-500/5' : 'border-slate-700/50 bg-slate-800/30'
      }`}
      title={changed ? '该操作与真实操作不同（点底部【▶ 运行并保存】可落库）' : undefined}
    >
      {/* 序号 + 买卖徽章 */}
      <span className="w-5 text-slate-600 font-mono text-[10px]">{index + 1}</span>
      {order.action === 'buy' ? (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/15 text-red-400 border border-red-500/30">
          <TrendingUp className="w-2.5 h-2.5" />买
        </span>
      ) : (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-500/15 text-green-400 border border-green-500/30">
          <TrendingDown className="w-2.5 h-2.5" />卖
        </span>
      )}
      {order.kind === 'borrow' && <span className="text-[9px] px-1 py-0.5 rounded bg-sky-500/15 text-sky-400">倒T出借</span>}
      {order.kind === 'merge' && <span className="text-[9px] px-1 py-0.5 rounded bg-purple-500/15 text-purple-400">归并</span>}
      {order.isBaseline && <span className="text-[9px] px-1 py-0.5 rounded bg-slate-500/15 text-slate-400">真实操作</span>}

      {/* 资金不足行内警告（非阻断）：点击行外上方横幅可一键解决 */}
      {cashWarning && (
        <span
          className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/40 inline-flex items-center gap-0.5"
          title={cashWarning}
        >
          <AlertTriangle className="w-2.5 h-2.5" />超出预算
        </span>
      )}

      {/* 日期 + 微调 */}
      <span className="font-mono text-slate-300">{day}</span>
      {!readonly && (
        <span className="inline-flex items-center gap-0.5">
          <button
            className="p-0.5 rounded bg-slate-700/50 text-slate-400 hover:text-slate-200 hover:bg-slate-700"
            title="前 1 个交易日"
            {...prevDayHold}
          >
            <ArrowLeft className="w-3 h-3" />
          </button>
          <button
            className="p-0.5 rounded bg-slate-700/50 text-slate-400 hover:text-slate-200 hover:bg-slate-700"
            title="前 5 个交易日"
            onClick={() => moveDate(-5)}
          >
            ◀5
          </button>
          <button
            className="p-0.5 rounded bg-slate-700/50 text-slate-400 hover:text-slate-200 hover:bg-slate-700"
            title="后 5 个交易日"
            onClick={() => moveDate(5)}
          >
            5▶
          </button>
          <button
            className="p-0.5 rounded bg-slate-700/50 text-slate-400 hover:text-slate-200 hover:bg-slate-700"
            title="后 1 个交易日"
            {...nextDayHold}
          >
            <ArrowRight className="w-3 h-3" />
          </button>
        </span>
      )}

      {/* 价格 */}
      <span className="flex items-center gap-1">
        <span className="text-slate-500">价</span>
        {readonly ? (
          <span className="font-mono text-slate-200">¥{order.price.toFixed(2)}</span>
        ) : (
          <span className="inline-flex items-center gap-0.5">
            <button
              className="w-5 h-5 rounded bg-slate-700/50 text-slate-400 hover:text-slate-200 hover:bg-slate-700 font-mono"
              {...priceMinusHold}
            >
              −
            </button>
            <input
              type="number"
              step={0.01}
              value={order.price}
              onChange={(e) => onPatch(order.id, { price: Number(e.target.value) || 0 })}
              className="w-16 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 font-mono text-slate-200 focus:outline-none focus:border-blue-500"
            />
            <button
              className="w-5 h-5 rounded bg-slate-700/50 text-slate-400 hover:text-slate-200 hover:bg-slate-700 font-mono"
              {...pricePlusHold}
            >
              +
            </button>
          </span>
        )}
      </span>

      {/* 数量 */}
      <span className="flex items-center gap-1">
        <span className="text-slate-500">量</span>
        {readonly ? (
          <span className="font-mono text-slate-200">{order.quantity}股</span>
        ) : (
          <span className="inline-flex items-center gap-0.5">
            <button
              className="w-5 h-5 rounded bg-slate-700/50 text-slate-400 hover:text-slate-200 hover:bg-slate-700 font-mono"
              {...qtyMinusHold}
            >
              −
            </button>
            <input
              type="number"
              step={100}
              value={order.quantity}
              onChange={(e) => onPatch(order.id, { quantity: toLot(Number(e.target.value) || 0) })}
              className="w-16 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 font-mono text-slate-200 focus:outline-none focus:border-blue-500"
            />
            <button
              className="w-5 h-5 rounded bg-slate-700/50 text-slate-400 hover:text-slate-200 hover:bg-slate-700 font-mono"
              {...qtyPlusHold}
            >
              +
            </button>
          </span>
        )}
      </span>

      {/* 金额小计 */}
      <span className="text-slate-500 font-mono text-[10px]">
        ≈¥{(order.price * order.quantity).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}
      </span>

      {/* 触发原因（预设生成器携带的 note，如策略信号说明） */}
      {order.note && (
        <span className="basis-full flex items-start gap-1 text-[10px] leading-snug text-slate-400 border-t border-slate-700/50 pt-1 mt-0.5">
          <span className="shrink-0 mt-0.5 text-slate-600 select-none">↳</span>
          <span className="min-w-0">{order.note}</span>
        </span>
      )}

      {/* 右侧操作 */}
      {!readonly && (
        <span className="ml-auto inline-flex items-center gap-0.5">
          <button
            className="p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-700/60"
            title="恢复为基线值（真实操作的原始价格与数量）"
            onClick={() => onRestore(order)}
          >
            <RotateCcw className="w-3 h-3" />
          </button>
          <button
            className="p-1 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10"
            title="删除这笔操作"
            onClick={() => onRemove(order.id)}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </span>
      )}
    </div>
  );
}

// ============================================================
// 主组件
// ============================================================

interface OrderTimelineProps {
  /** 分支类型（baseline/preset → 只读） */
  branchType: 'baseline' | 'preset' | 'user';
  /** 当前时间线订单（时间升序） */
  orders: SandboxOrder[];
  /** 基线订单（真实操作的原始值，恢复与变更高亮用；user 分支传入基线分支的订单） */
  baselineOrders: SandboxOrder[];
  kline: KlineItem[];
  /** 评估日（日期微调/卖单平移的上限） */
  asOfDate?: string;
  /** 引擎结构化拒绝（资金不足等）：用于在对应订单行显示行内警告，不弹阻断弹窗 */
  rejections?: EngineRejection[];
  /** 预设策略零成交时的策略自身原因（空时间线处展示，解释为何无买卖） */
  inactivityReason?: string;
  /** 添加订单入口（user 分支显示，父级弹出下单面板） */
  onAddOrder?: () => void;
  onChange: (orders: SandboxOrder[]) => void;
}

/**
 * 操作时间线组件。
 *
 * @param {OrderTimelineProps} props - 见接口定义
 * @returns {JSX.Element} 时间线视图
 */
export default function OrderTimeline({
  branchType,
  orders,
  baselineOrders,
  kline,
  asOfDate,
  rejections = [],
  onAddOrder,
  onChange,
  inactivityReason,
}: OrderTimelineProps) {
  const readonly = branchType !== 'user';
  const [shiftDays, setShiftDays] = useState('1');

  // 快捷修复（非阻断警示条）：直连 store 取当前分支、资金峰值与修复 action
  const branchId = useSandboxStore((s) => s.selectedBranchId);
  const peakRequiredCash = useSandboxStore((s) => s.activeComputed?.peakRequiredCash ?? 0);
  const raiseCashToRequired = useSandboxStore((s) => s.raiseCashToRequired);
  const adjustOrderQty = useSandboxStore((s) => s.adjustOrderQty);
  const scaleAllBuyOrders = useSandboxStore((s) => s.scaleAllBuyOrders);

  // 首笔超支单：用于「✂️ 该笔缩减至最大可买量」与行内提示
  const overBudgetRej = useMemo(
    () => rejections.find((r) => r.code === 'INSUFFICIENT_CASH' && r.orderId),
    [rejections],
  );
  const reduceMaxQty =
    overBudgetRej?.actions.find((a) => a.kind === 'reduce-qty')?.payload?.maxQty ?? 0;
  const hasOverBudget = rejections.some((r) => r.code === 'INSUFFICIENT_CASH');
  const canReduce = branchType === 'user' && !!overBudgetRej && reduceMaxQty > 0;

  // 索引：orderId → 命中「资金不足」拒绝的白话原因（行内警告徽章）
  const cashWarnings = useMemo(() => {
    const map: Record<string, string> = {};
    for (const rej of rejections) {
      if (rej.code === 'INSUFFICIENT_CASH' && rej.orderId && !map[rej.orderId]) {
        map[rej.orderId] = rej.message;
      }
    }
    return map;
  }, [rejections]);

  // ---- 行级编辑 ----
  const patchOrder = (id: string, patch: Partial<SandboxOrder>) => {
    onChange(orders.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  };

  const removeOrder = (id: string) => {
    onChange(orders.filter((o) => o.id !== id));
  };

  /** 恢复为基线值：按（日期, 方向）匹配基线订单，还原价格/数量/日期 */
  const restoreOrder = (o: SandboxOrder) => {
    const base = baselineOrders.find(
      (b) => b.timestamp.slice(0, 10) === o.timestamp.slice(0, 10) && b.action === o.action,
    );
    if (!base) return;
    onChange(
      orders.map((ord) =>
        ord.id === o.id
          ? { ...ord, price: base.price, quantity: base.quantity, timestamp: base.timestamp, isBaseline: true }
          : ord,
      ),
    );
  };

  // ---- 批量变换 ----
  const scaleBuys = (factor: number) => {
    onChange(orders.map((o) => (o.action === 'buy' ? { ...o, quantity: toLot(o.quantity * factor) } : o)));
  };

  const shiftAllPrices = (pct: number) => {
    onChange(orders.map((o) => ({ ...o, price: roundPrice(o.price * (1 + pct / 100)) })));
  };

  const shiftSells = (days: number) => {
    const n = Number(days) || 1;
    onChange(
      orders.map((o) => {
        if (o.action !== 'sell') return o;
        const next = shiftDate(o.timestamp, kline, n);
        if (asOfDate && next.slice(0, 10) > asOfDate) return { ...o, timestamp: `${asOfDate}T09:30:00+08:00` };
        return { ...o, timestamp: next };
      }),
    );
  };

  /** 相对基线值是否被修改（用于高亮未提交变更；日期被平移/新增订单也视为变更） */
  const isChanged = (o: SandboxOrder): boolean => {
    if (branchType !== 'user') return false;
    const base = baselineOrders.find(
      (b) => b.timestamp.slice(0, 10) === o.timestamp.slice(0, 10) && b.action === o.action,
    );
    if (!base) return true; // 新增订单或日期已被平移 → 与真实操作不同
    return base.price !== o.price || base.quantity !== o.quantity || base.timestamp !== o.timestamp;
  };

  if (orders.length === 0) {
    return (
      <div className="text-center text-xs text-slate-500 py-6 space-y-2">
        <div>暂无操作记录</div>
        {inactivityReason && (
          <div className="mx-auto max-w-md text-[11px] leading-snug text-slate-400 bg-slate-800/40 border border-slate-700/40 rounded-lg px-3 py-2 text-left">
            <span className="text-slate-500">策略自身原因：</span>
            {inactivityReason}
          </div>
        )}
        {onAddOrder && (
          <button onClick={onAddOrder} className="ml-2 text-blue-400 hover:text-blue-300 inline-flex items-center gap-0.5">
            <Plus className="w-3 h-3" />添加第一笔
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* 超支非阻断警告条 + 3 个快捷修复（不再弹阻断 Modal） */}
      {hasOverBudget && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span className="min-w-[8rem]">{overBudgetRej?.message ?? '存在超出预算上限的买入订单。'}</span>
          <span className="flex flex-wrap gap-1.5">
            {branchId && (
              <button
                onClick={() => raiseCashToRequired(branchId, peakRequiredCash)}
                disabled={branchType === 'baseline' || peakRequiredCash <= 0}
                className="px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 disabled:opacity-40 inline-flex items-center gap-1"
              >
                ⚡ 一键调高模拟资金至 ¥{(peakRequiredCash > 0 ? Math.ceil(peakRequiredCash / 1000) * 1000 : 0).toLocaleString('zh-CN')}
              </button>
            )}
            {canReduce && overBudgetRej && (
              <button
                onClick={() => adjustOrderQty(branchId as string, overBudgetRej.orderId, reduceMaxQty)}
                className="px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 inline-flex items-center gap-1"
              >
                ✂️ 该笔缩减至最大可买量 ({reduceMaxQty}股)
              </button>
            )}
            {branchId && branchType === 'user' && (
              <button
                onClick={() => scaleAllBuyOrders(branchId, 0.5)}
                className="px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 inline-flex items-center gap-1"
              >
                📉 全局等比缩减买单 (×50%)
              </button>
            )}
          </span>
        </div>
      )}

      {/* 批量变换工具（仅 user 分支） */}
      {!readonly && (
        <div className="flex flex-wrap items-center gap-1.5 px-1 pb-1 border-b border-slate-700/50">
          <span className="text-[10px] text-slate-500 mr-1">批量：</span>
          <button onClick={() => scaleBuys(0.5)} className="text-[10px] px-2 py-1 rounded bg-slate-700/50 text-slate-300 hover:bg-slate-700">买单 ×50%</button>
          <button onClick={() => scaleBuys(1.5)} className="text-[10px] px-2 py-1 rounded bg-slate-700/50 text-slate-300 hover:bg-slate-700">买单 ×150%</button>
          <button onClick={() => scaleBuys(2)} className="text-[10px] px-2 py-1 rounded bg-slate-700/50 text-slate-300 hover:bg-slate-700">买单 ×200%</button>
          <span className="mx-1 text-slate-700">|</span>
          <button onClick={() => shiftAllPrices(-2)} className="text-[10px] px-2 py-1 rounded bg-slate-700/50 text-slate-300 hover:bg-slate-700">价格 −2%</button>
          <button onClick={() => shiftAllPrices(2)} className="text-[10px] px-2 py-1 rounded bg-slate-700/50 text-slate-300 hover:bg-slate-700">价格 +2%</button>
          <span className="mx-1 text-slate-700">|</span>
          <span className="text-[10px] text-slate-500">卖单平移</span>
          <input
            type="number"
            min={1}
            max={120}
            value={shiftDays}
            onChange={(e) => setShiftDays(e.target.value)}
            className="w-12 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[10px] text-slate-200 focus:outline-none focus:border-blue-500"
          />
          <span className="text-[10px] text-slate-500">个交易日</span>
          <button onClick={() => shiftSells(Number(shiftDays) || 1)} className="text-[10px] px-2 py-1 rounded bg-slate-700/50 text-slate-300 hover:bg-slate-700">执行</button>
        </div>
      )}

      <div className="space-y-1.5">
        {orders.map((o, idx) => (
          <OrderRow
            key={o.id}
            order={o}
            index={idx}
            readonly={readonly}
            changed={isChanged(o)}
            kline={kline}
            asOfDate={asOfDate}
            cashWarning={cashWarnings[o.id]}
            onPatch={patchOrder}
            onRemove={removeOrder}
            onRestore={restoreOrder}
          />
        ))}
      </div>

      {!readonly && onAddOrder && (
        <button
          onClick={onAddOrder}
          className="w-full py-2 rounded-lg border border-dashed border-slate-600 text-xs text-slate-400 hover:text-blue-400 hover:border-blue-500/50 transition-colors inline-flex items-center justify-center gap-1"
        >
          <Plus className="w-3.5 h-3.5" />
          点击 K 线或此处添加一笔操作
        </button>
      )}

      {readonly && branchType === 'preset' && (
        <p className="text-[10px] text-slate-500 px-1">
          这是系统标准策略基准，不可直接修改。请点击右上角【📋 复制并微调】创建你的专属沙盒。
        </p>
      )}
      {readonly && branchType === 'baseline' && (
        <p className="text-[10px] text-slate-500 px-1">
          这是你的真实历史操作（前复权口径），只读展示。想对比不同打法？点击【我的方案】→【新建演练】。
        </p>
      )}
    </div>
  );
}
