/**
 * @file MonitorTaskCard.tsx
 * @description 价格预告单卡片：展示标的、方向（低吸/高抛）、类型（区间/跌破）、目标价与容差、
 *              单边触发边界、累计提醒次数（n/3）与状态，并提供「结束」入口。
 *              结束态区分两种停法：满 3 次自动停（判定无成交意愿）与手动结束。
 *              触发边界由 utils/monitorRule 计算，与后端判定同口径（docs/monitor/design.md §3）。
 * @layer UI
 * @storage_impact 不直接读写存储；结束动作经 services/monitorService 提交服务端。
 * @author 开发团队
 */

import React from 'react';
import { Bell, TrendingDown, TrendingUp, CircleStop } from 'lucide-react';
import type { MonitorTask } from '../../services/monitorService';
import { MONITOR_MAX_ALERTS } from '../../services/monitorService';
import { computeTriggerBoundary } from '../../utils/monitorRule';

/** 方向展示文案与配色 */
const DIRECTION_META: Record<MonitorTask['direction'], { label: string; className: string }> = {
  BUY: { label: '低吸买入', className: 'bg-blue-500/15 text-blue-300' },
  SELL: { label: '高抛卖出', className: 'bg-purple-500/15 text-purple-300' },
};

/** 格式化 ISO 时间为本地短串（解析失败返回占位） */
function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

interface MonitorTaskCardProps {
  /** 预告单条目 */
  task: MonitorTask;
  /** 结束回调（父组件负责调用 stop 并刷新） */
  onStop: (task: MonitorTask) => void;
  /** 结束中（禁用按钮防重复提交） */
  stopping?: boolean;
}

/**
 * 单条预告单卡片。
 *
 * @returns {JSX.Element} 预告单卡片视图
 */
export default function MonitorTaskCard({ task, onStop, stopping = false }: MonitorTaskCardProps) {
  const boundary = computeTriggerBoundary({
    direction: task.direction,
    type: task.alertType,
    threshold: task.threshold,
    band: task.band,
  });
  const directionMeta = DIRECTION_META[task.direction];
  const isRunning = task.status === 'RUNNING';
  const autoStopped = !isRunning && task.alertCount >= MONITOR_MAX_ALERTS;

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-100">{task.stockCode}</span>
            <span className="text-xs text-slate-500">{task.fullCode}</span>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${directionMeta.className}`}>
              {task.direction === 'BUY' ? (
                <TrendingDown className="h-3 w-3" />
              ) : (
                <TrendingUp className="h-3 w-3" />
              )}
              {directionMeta.label}
            </span>
            <span className="rounded-full bg-slate-700/60 px-2 py-0.5 text-[11px] text-slate-400">
              {task.alertType === 'PRICE_NEAR' ? '区间' : '跌破'}
            </span>
          </div>

          <p className="mt-2 text-xs text-slate-400">
            目标价 {task.threshold.toFixed(2)}
            {task.alertType === 'PRICE_NEAR' && task.band !== null ? ` · 容差 ${task.band.toFixed(2)}` : ''}
            {boundary ? ` · 触发 ${boundary.operator === '<=' ? '≤' : '≥'} ${boundary.bound.toFixed(2)}` : ''}
          </p>

          <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
            <Bell className="h-3 w-3" />
            已提醒 {task.alertCount}/{MONITOR_MAX_ALERTS} 次
            {task.lastAlertAt ? ` · 最近 ${formatTime(task.lastAlertAt)}` : ''}
          </p>
        </div>

        <div className="flex flex-col items-end gap-2 flex-shrink-0">
          {isRunning ? (
            <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-[11px] text-green-300">追踪中</span>
          ) : (
            <span className="rounded-full bg-slate-700/60 px-2 py-0.5 text-[11px] text-slate-400">
              {autoStopped ? '已提醒 3/3 次 · 自动结束' : '已手动结束'}
            </span>
          )}
          {isRunning && (
            <button
              type="button"
              onClick={() => onStop(task)}
              disabled={stopping}
              className="tap-target inline-flex items-center gap-1 rounded-lg border border-slate-600 px-2.5 py-1.5 text-xs text-slate-300 transition-colors hover:border-red-500/60 hover:text-red-300 disabled:opacity-50"
            >
              <CircleStop className="h-3.5 w-3.5" />
              结束
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
