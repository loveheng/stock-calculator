/**
 * @file StockImportCard.tsx
 * @description 按标的分组的折叠卡片流组件：折叠头部展示汇总信息与状态徽标，
 *              展开体展示标的全局绑定选择器与行级精简编辑列表。
 *              替代原有的扁平大表格 ImportTable.tsx。
 * @layer View
 * @author 开发团队
 */

import React, { useState } from 'react';
import {
  ChevronDown, ChevronRight, Send, Trash2, Plus, AlertCircle, CheckCircle, AlertTriangle, XCircle,
} from 'lucide-react';
import type { ImportDraftRow, ImportTargetCategory, GroupRiskLevel } from '../../types/import';
import type { Position, PlannedOrder } from '../../store/types';
import { getAvailablePositions, getActivePlannedOrders, inferPlanBind } from '../../services/importAdapter';
import { normalizeCode } from '../../utils/dedup';

interface CardGroup {
  key: string;
  items: ImportDraftRow[];
  name: string;
  totalAmount: number;
  riskLevel: GroupRiskLevel;
}

interface StockImportCardProps {
  group: CardGroup;
  positions: Position[];
  plannedOrders: PlannedOrder[];
  onUpdateRow: (id: string, patch: Partial<ImportDraftRow>) => void;
  onDeleteRow: (id: string) => void;
  onAddRow: (fullCode: string, stockName?: string) => void;
  onCommitGroup: (rows: ImportDraftRow[]) => void;
  onDiscardGroup: (rows: ImportDraftRow[]) => void;
  onBindPosition: (rows: ImportDraftRow[], positionId: string | undefined, isNew: boolean) => void;
}

const CAT_OPTIONS: { v: ImportTargetCategory; l: string }[] = [
  { v: 'LONG_TERM_BATCH', l: '📍 关联持仓 (中长期批次)' },
  { v: 'SHORT_TERM_T', l: '📍 关联持仓 (短线做T流水)' },
  { v: 'BIND_PLANNED_ORDER', l: '📋 履约挂载计划单' },
  { v: 'NEW_POSITION', l: '✨ 全新开仓' },
];

const RISK_BADGE: Record<GroupRiskLevel, { c: string; label: string }> = {
  PASSED: { c: 'bg-green-500/20 text-green-400', label: '🟢 全部通过' },
  WARNING: { c: 'bg-amber-500/20 text-amber-400', label: '🟡 存在警告' },
  ERROR: { c: 'bg-red-500/20 text-red-400', label: '🔴 拦截阻断' },
};

const DUP_LABEL: Record<string, string> = { UNIQUE: '新', POTENTIAL: '疑', EXACT_DUPLICATE: '重' };
const DUP_COLOR: Record<string, string> = { UNIQUE: 'text-green-400', POTENTIAL: 'text-amber-400', EXACT_DUPLICATE: 'text-red-400' };
const VAL_ICON: Record<string, React.ReactNode> = {
  PENDING: <AlertCircle className="w-3 h-3" />, PASSED: <CheckCircle className="w-3 h-3" />,
  WARNING: <AlertTriangle className="w-3 h-3" />, ERROR: <XCircle className="w-3 h-3" />,
};
const VAL_COLOR: Record<string, string> = { PENDING: 'text-slate-400', PASSED: 'text-green-400', WARNING: 'text-amber-400', ERROR: 'text-red-400' };

export default function StockImportCard({
  group, positions, plannedOrders,
  onUpdateRow, onDeleteRow, onAddRow, onCommitGroup, onDiscardGroup, onBindPosition,
}: StockImportCardProps) {
  const [expanded, setExpanded] = useState(true);
  const norm = group.key;
  const availPositions = getAvailablePositions(positions, norm);
  const badge = RISK_BADGE[group.riskLevel];

  // 智能检测当前组是否有自动挂载计划单
  const groupPlanLabel = (() => {
    for (const r of group.items) {
      if (r.targetCategory === 'BIND_PLANNED_ORDER' && r.targetPlannedOrderId) {
        const p = plannedOrders.find((o) => o.id === r.targetPlannedOrderId);
        if (p) return `📋 自动挂载: ${p.direction === 'buy' ? '买入' : '卖出'} ¥${p.plannedPrice}×${p.plannedAmount} (待履约)`;
      }
    }
    return null;
  })();

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/40 overflow-hidden">
      {/* 折叠头部 Summary Bar */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-700/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <button className="text-slate-400 hover:text-slate-200" onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}>
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-semibold text-slate-200">{group.key !== '__unassigned__' ? group.name || group.key : '未分配标的'}</span>
          {group.key !== '__unassigned__' && <span className="ml-2 text-xs text-slate-500">{group.key}</span>}
        </div>
        <span className="text-xs text-slate-400">{group.items.length} 笔</span>
        <span className="text-xs text-slate-400">¥{group.totalAmount.toFixed(2)}</span>
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${badge.c}`}>{badge.label}</span>
        {groupPlanLabel && <span className="text-[10px] text-blue-400 truncate max-w-[200px]">{groupPlanLabel}</span>}
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => onCommitGroup(group.items)} className="p-1.5 rounded hover:bg-green-500/20 text-slate-400 hover:text-green-400 transition-colors" title="过账本组">
            <Send className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => onDiscardGroup(group.items)} className="p-1.5 rounded hover:bg-red-500/20 text-slate-400 hover:text-red-400 transition-colors" title="整组丢弃">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 展开体 */}
      {expanded && (
        <div className="border-t border-slate-700/50 px-4 py-3 space-y-3">
          {/* 标的全局绑定 Position 选择器 */}
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span className="shrink-0">关联持仓:</span>
            <select
              value=""
              onChange={(e) => {
                const val = e.target.value;
                if (val === '__new__') onBindPosition(group.items, undefined, true);
                else if (val) onBindPosition(group.items, val, false);
              }}
              className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
            >
              <option value="">-- 继承全局绑定 --</option>
              {availPositions.map((p) => (
                <option key={p.id} value={p.id}>{p.stockName} (成本¥{p.currentCost.toFixed(2)}×{p.currentAmount})</option>
              ))}
              <option value="__new__">🆕 全新开仓</option>
            </select>
            <span className="text-slate-600">绑定后组内所有流水默认继承此持仓</span>
          </div>

          {/* 行级编辑列表 */}
          <div className="space-y-1.5">
            {/* 表头 */}
            <div className="flex items-center gap-2 text-[10px] text-slate-500 uppercase tracking-wider px-1">
              <span className="w-32">成交时间</span>
              <span className="w-12 text-center">方向</span>
              <span className="w-20 text-right">价格</span>
              <span className="w-20 text-right">数量</span>
              <span className="w-8 text-center">重</span>
              <span className="flex-1">归类与目标</span>
              <span className="w-16 text-center">风控</span>
              <span className="w-6"></span>
            </div>
            {group.items.map((row) => (
              <RowLine
                key={row.id}
                row={row}
                positions={positions}
                plannedOrders={plannedOrders}
                onUpdate={(p) => onUpdateRow(row.id, p)}
                onDelete={() => onDeleteRow(row.id)}
              />
            ))}
          </div>

          {/* 添加流水 */}
          <button
            onClick={() => onAddRow(group.key !== '__unassigned__' ? group.key : '', group.name)}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border border-dashed border-slate-600 text-xs text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> 为该标的新增一笔流水
          </button>
        </div>
      )}
    </div>
  );
}

// ---- 行内编辑组件 ----
function RowLine({ row, positions, plannedOrders, onUpdate, onDelete }: {
  row: ImportDraftRow;
  positions: Position[];
  plannedOrders: PlannedOrder[];
  onUpdate: (p: Partial<ImportDraftRow>) => void;
  onDelete: () => void;
}) {
  const availPositions = getAvailablePositions(positions, row.fullCode);
  const availPlans = getActivePlannedOrders(plannedOrders, row.fullCode);
  const autoPlan = row.targetCategory === 'BIND_PLANNED_ORDER' ? inferPlanBind(row, plannedOrders) : undefined;

  return (
    <div className="flex items-center gap-2 px-1 py-1 rounded hover:bg-slate-700/20 transition-colors">
      {/* 时间 */}
      <input type="datetime-local" value={row.timestamp ? toLocalDatetime(row.timestamp) : ''}
        onChange={(e) => { const v = e.target.value; if (v) { const t = new Date(v).getTime(); if (!isNaN(t)) onUpdate({ timestamp: t }); } }}
        className="w-32 bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[10px] text-slate-200 focus:outline-none focus:border-blue-500" />

      {/* 方向 */}
      <select value={row.direction} onChange={(e) => onUpdate({ direction: e.target.value as 'buy' | 'sell' })}
        className="w-12 bg-slate-900 border border-slate-700 rounded px-1 py-1 text-[10px] text-slate-200 focus:outline-none focus:border-blue-500 text-center">
        <option value="buy">买</option>
        <option value="sell">卖</option>
      </select>

      {/* 价格 */}
      <input type="number" step="0.001" min="0" value={row.price || ''}
        onChange={(e) => { const v = parseFloat(e.target.value); onUpdate({ price: isNaN(v) ? 0 : v }); }}
        className="w-20 bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[10px] text-slate-200 text-right focus:outline-none focus:border-blue-500" />

      {/* 数量 */}
      <input type="number" step="1" min="0" value={row.amount || ''}
        onChange={(e) => { const v = parseInt(e.target.value, 10); onUpdate({ amount: isNaN(v) ? 0 : v }); }}
        className="w-20 bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[10px] text-slate-200 text-right focus:outline-none focus:border-blue-500" />

      {/* 防重 */}
      <span className={`w-8 text-center text-[10px] font-medium ${DUP_COLOR[row.duplicateStatus]}`}>
        {DUP_LABEL[row.duplicateStatus]}
      </span>

      {/* 归类 + 目标组合 */}
      <div className="flex-1 flex items-center gap-1">
        <select value={row.targetCategory} onChange={(e) => {
          const cat = e.target.value as ImportTargetCategory;
          const updates: Partial<ImportDraftRow> = { targetCategory: cat, targetPlannedOrderId: undefined, isNewPosition: cat === 'NEW_POSITION' };
          if (cat === 'BIND_PLANNED_ORDER' && availPlans.length > 0) updates.targetPlannedOrderId = availPlans[0].id;
          if (cat === 'NEW_POSITION') { updates.targetPositionId = undefined; }
          onUpdate(updates);
        }}
          className="max-w-[140px] bg-slate-900 border border-slate-700 rounded px-1 py-1 text-[10px] text-slate-200 focus:outline-none focus:border-blue-500">
          {CAT_OPTIONS.map((o) => {
            let label = o.l;
            if (o.v === 'BIND_PLANNED_ORDER' && autoPlan) label = `📋 自动挂载: ${autoPlan.direction === 'buy' ? '买入' : '卖出'} ¥${autoPlan.plannedPrice}×${autoPlan.plannedAmount}`;
            return <option key={o.v} value={o.v}>{label}</option>;
          })}
        </select>

        {row.targetCategory === 'BIND_PLANNED_ORDER' ? (
          <select value={row.targetPlannedOrderId ?? ''} onChange={(e) => onUpdate({ targetPlannedOrderId: e.target.value || undefined })}
            className="flex-1 bg-slate-900 border border-slate-700 rounded px-1 py-1 text-[10px] text-slate-200 focus:outline-none focus:border-blue-500">
            <option value="">-- 计划单 --</option>
            {availPlans.map((p) => <option key={p.id} value={p.id}>{(p.direction === 'buy' ? '买入' : '卖出')} ¥{p.plannedPrice}×{p.plannedAmount}</option>)}
          </select>
        ) : row.targetCategory === 'NEW_POSITION' ? (
          <span className="text-[10px] text-blue-400">🆕 全新开仓</span>
        ) : (
          <select value={row.targetPositionId ?? ''} onChange={(e) => {
            const val = e.target.value;
            onUpdate({ targetPositionId: val || undefined, isNewPosition: false });
          }}
            className="flex-1 bg-slate-900 border border-slate-700 rounded px-1 py-1 text-[10px] text-slate-200 focus:outline-none focus:border-blue-500">
            <option value="">-- 持仓 --</option>
            {availPositions.map((p) => <option key={p.id} value={p.id}>{p.stockName} (成本¥{p.currentCost.toFixed(2)}×{p.currentAmount})</option>)}
            {row.targetCategory === 'LONG_TERM_BATCH' && <option value="__new__">➕ 新开仓</option>}
          </select>
        )}
      </div>

      {/* 风控 */}
      <span className={`w-16 text-center inline-flex items-center justify-center gap-0.5 text-[10px] font-medium ${VAL_COLOR[row.validationStatus]}`}>
        {VAL_ICON[row.validationStatus]}
      </span>

      {/* 删除 */}
      <button onClick={onDelete} className="p-1 rounded hover:bg-red-500/20 text-slate-500 hover:text-red-400 transition-colors">
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  );
}

function toLocalDatetime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}