/**
 * @file StockImportCard.tsx
 * @description 按标的分组的折叠卡片流组件：折叠头部展示汇总信息与状态徽标，
 *              展开体展示标的全局绑定选择器与行级精简编辑列表。
 *              支持响应式布局：PC 宽屏保持行内快速编辑，移动端窄屏自动切换为
 *              紧凑摘要卡片 + 底部抽屉编辑模式。
 * @layer View
 * @author 开发团队
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  ChevronDown, ChevronRight, Send, Trash2, Plus, AlertCircle, CheckCircle, AlertTriangle, XCircle,
  Edit3, X, Save,
} from 'lucide-react';
import type { ImportDraftRow, ImportTargetCategory, GroupRiskLevel } from '../../types/import';
import type { Position, PlannedOrder } from '../../store/types';
import { getAvailablePositions, getActivePlannedOrders, inferPlanBind } from '../../services/importAdapter';
import { normalizeCode } from '../../utils/dedup';

// ---- 响应式断点 ----
const MOBILE_BREAKPOINT = 768;

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return mobile;
}

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
  allExpanded: boolean;
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
  group, positions, plannedOrders, allExpanded,
  onUpdateRow, onDeleteRow, onAddRow, onCommitGroup, onDiscardGroup, onBindPosition,
}: StockImportCardProps) {
  const [expanded, setExpanded] = useState(allExpanded);

  // 父级「全部展开/折叠」同步：allExpanded 变化时驱动所有卡片同步
  useEffect(() => {
    setExpanded(allExpanded);
  }, [allExpanded]);

  const isMobile = useIsMobile();
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
        <button className="text-slate-400 hover:text-slate-200 shrink-0" onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}>
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-semibold text-slate-200">{group.key !== '__unassigned__' ? group.name || group.key : '未分配标的'}</span>
          {group.key !== '__unassigned__' && <span className="ml-2 text-xs text-slate-500">{group.key}</span>}
        </div>
        {/* 手机端：仅显示笔数和风险状态 */}
        <span className="text-xs text-slate-400 shrink-0">{group.items.length} 笔</span>
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${badge.c}`}>{badge.label}</span>
        {/* 桌面端：额外显示金额和操作 */}
        <span className="hidden md:inline text-xs text-slate-400 shrink-0">¥{group.totalAmount.toFixed(2)}</span>
        {groupPlanLabel && <span className="hidden md:inline text-[10px] text-blue-400 truncate max-w-[200px] shrink-0">{groupPlanLabel}</span>}
        <div className="hidden md:flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
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
          <div className="flex flex-col md:flex-row items-start md:items-center gap-2 md:gap-3 text-xs text-slate-400">
            <span className="shrink-0">关联持仓:</span>
            <select
              value=""
              onChange={(e) => {
                const val = e.target.value;
                if (val === '__new__') onBindPosition(group.items, undefined, true);
                else if (val) onBindPosition(group.items, val, false);
              }}
              className="w-full md:w-auto bg-slate-900 border border-slate-700 rounded px-2 py-1.5 md:py-1 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
            >
              <option value="">-- 继承全局绑定 --</option>
              {availPositions.map((p) => (
                <option key={p.id} value={p.id}>{p.stockName} (成本¥{p.currentCost.toFixed(2)}×{p.currentAmount})</option>
              ))}
              <option value="__new__">🆕 全新开仓</option>
            </select>
            <span className="text-slate-600 text-[10px]">绑定后组内所有流水默认继承此持仓</span>
          </div>

          {/* 行级编辑列表 */}
          <div className="space-y-1.5">
            {/* 表头 — 桌面端显示 */}
            <div className="hidden md:flex items-center gap-2 text-[10px] text-slate-500 uppercase tracking-wider px-1">
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
              isMobile ? (
                <MobileRowCard
                  key={row.id}
                  row={row}
                  positions={positions}
                  plannedOrders={plannedOrders}
                  onUpdate={(p) => onUpdateRow(row.id, p)}
                  onDelete={() => onDeleteRow(row.id)}
                />
              ) : (
                <RowLine
                  key={row.id}
                  row={row}
                  positions={positions}
                  plannedOrders={plannedOrders}
                  onUpdate={(p) => onUpdateRow(row.id, p)}
                  onDelete={() => onDeleteRow(row.id)}
                />
              )
            ))}
          </div>

          {/* 添加流水 — 桌面端保留全宽按钮，手机端用紧凑样式 */}
          <button
            onClick={() => onAddRow(group.key !== '__unassigned__' ? group.key : '', group.name)}
            className="w-full flex items-center justify-center gap-1.5 py-2.5 md:py-2 rounded-lg border border-dashed border-slate-600 text-xs text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> 为该标的新增一笔流水
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================
// 桌面端：行内编辑（原有逻辑，仅微调）
// ============================================================
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

// ============================================================
// 移动端：紧凑摘要卡片 + 底部抽屉编辑
// ============================================================
function MobileRowCard({ row, positions, plannedOrders, onUpdate, onDelete }: {
  row: ImportDraftRow;
  positions: Position[];
  plannedOrders: PlannedOrder[];
  onUpdate: (p: Partial<ImportDraftRow>) => void;
  onDelete: () => void;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <>
      {/* 紧凑摘要卡片 */}
      <div
        className="flex items-center gap-2 px-2 py-2.5 rounded-lg bg-slate-800/20 border border-slate-700/40 active:bg-slate-700/30 transition-colors cursor-pointer"
        onClick={() => setDrawerOpen(true)}
      >
        {/* 左侧核心信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-xs text-slate-200">
            <span className="text-[10px] text-slate-400">
              {row.timestamp ? formatTimeCompact(row.timestamp) : '--'}
            </span>
            <span className={`text-[10px] font-bold ${row.direction === 'buy' ? 'text-red-400' : 'text-green-400'}`}>
              {row.direction === 'buy' ? '买' : '卖'}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-slate-200 font-medium">¥{row.price.toFixed(2)}</span>
            <span className="text-[10px] text-slate-400">× {row.amount.toLocaleString()}</span>
            {/* 业务归类标签 — 显眼展示，方便确认归类状态 */}
            <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded font-medium ${CAT_TAG_COLOR[row.targetCategory]}`}>
              {CAT_LABEL_SHORT[row.targetCategory]}
            </span>
          </div>
        </div>

        {/* 右侧状态 */}
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={`text-[10px] font-medium ${DUP_COLOR[row.duplicateStatus]}`}>
            {DUP_LABEL[row.duplicateStatus]}
          </span>
          {row.validationStatus !== 'PENDING' && (
            <span className={`inline-flex items-center ${VAL_COLOR[row.validationStatus]}`}>
              {VAL_ICON[row.validationStatus]}
            </span>
          )}
          <Edit3 className="w-3.5 h-3.5 text-blue-400" />
        </div>
      </div>

      {/* 底部编辑抽屉 */}
      {drawerOpen && (
        <RowEditorDrawer
          row={row}
          positions={positions}
          plannedOrders={plannedOrders}
          onUpdate={onUpdate}
          onDelete={() => { onDelete(); setDrawerOpen(false); }}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </>
  );
}

const CAT_LABEL_SHORT: Record<string, string> = {
  LONG_TERM_BATCH: '底仓',
  SHORT_TERM_T: '做T',
  BIND_PLANNED_ORDER: '计划单',
  NEW_POSITION: '新开仓',
};

const CAT_TAG_COLOR: Record<string, string> = {
  LONG_TERM_BATCH: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
  SHORT_TERM_T: 'bg-purple-500/20 text-purple-400 border border-purple-500/30',
  BIND_PLANNED_ORDER: 'bg-amber-500/20 text-amber-400 border border-amber-500/30',
  NEW_POSITION: 'bg-green-500/20 text-green-400 border border-green-500/30',
};

// ============================================================
// 移动端底部编辑抽屉（Bottom Sheet）
// ============================================================
function RowEditorDrawer({ row, positions, plannedOrders, onUpdate, onDelete, onClose }: {
  row: ImportDraftRow;
  positions: Position[];
  plannedOrders: PlannedOrder[];
  onUpdate: (p: Partial<ImportDraftRow>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [local, setLocal] = useState<Partial<ImportDraftRow>>({});
  const drawerRef = useRef<HTMLDivElement>(null);

  // 写入本地状态
  const patch = useCallback((p: Partial<ImportDraftRow>) => {
    setLocal((prev) => ({ ...prev, ...p }));
  }, []);

  // 保存并关闭
  const handleSave = useCallback(() => {
    if (Object.keys(local).length > 0) onUpdate(local);
    onClose();
  }, [local, onUpdate, onClose]);

  // 点击遮罩关闭
  const handleBackdrop = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  const merged = { ...row, ...local };

  const availPositions = getAvailablePositions(positions, merged.fullCode);
  const availPlans = getActivePlannedOrders(plannedOrders, merged.fullCode);
  const autoPlan = merged.targetCategory === 'BIND_PLANNED_ORDER' ? inferPlanBind(merged, plannedOrders) : undefined;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/50 animate-fade-in"
      onClick={handleBackdrop}
    >
      <div
        ref={drawerRef}
        className="relative w-full max-h-[85vh] overflow-y-auto rounded-t-2xl bg-slate-800 border-t border-slate-600 shadow-2xl animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 拖拽指示条 */}
        <div className="sticky top-0 z-10 bg-slate-800 pt-2 pb-1 flex justify-center">
          <div className="w-10 h-1 rounded-full bg-slate-600" />
        </div>

        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-2 border-b border-slate-700">
          <h3 className="text-sm font-semibold text-slate-200">
            {merged.stockName || merged.fullCode || '编辑流水'}
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 表单内容 */}
        <div className="px-5 py-4 space-y-5">
          {/* 成交时间 */}
          <FieldGroup label="成交时间">
            <input type="datetime-local" value={merged.timestamp ? toLocalDatetime(merged.timestamp) : ''}
              onChange={(e) => { const v = e.target.value; if (v) { const t = new Date(v).getTime(); if (!isNaN(t)) patch({ timestamp: t }); } }}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500" />
          </FieldGroup>

          {/* 买卖方向 */}
          <FieldGroup label="买卖方向">
            <div className="flex gap-2">
              <button
                onClick={() => patch({ direction: 'buy' })}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  merged.direction === 'buy'
                    ? 'bg-red-500/20 text-red-400 border border-red-500/50'
                    : 'bg-slate-900 text-slate-400 border border-slate-700'
                }`}
              >
                买入
              </button>
              <button
                onClick={() => patch({ direction: 'sell' })}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  merged.direction === 'sell'
                    ? 'bg-green-500/20 text-green-400 border border-green-500/50'
                    : 'bg-slate-900 text-slate-400 border border-slate-700'
                }`}
              >
                卖出
              </button>
            </div>
          </FieldGroup>

          {/* 成交价格 & 数量 */}
          <div className="grid grid-cols-2 gap-3">
            <FieldGroup label="成交价格 (¥)">
              <input type="number" step="0.001" min="0" value={merged.price || ''}
                onChange={(e) => { const v = parseFloat(e.target.value); patch({ price: isNaN(v) ? 0 : v }); }}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200 text-right focus:outline-none focus:border-blue-500" />
            </FieldGroup>
            <FieldGroup label="成交数量 (股)">
              <input type="number" step="1" min="0" value={merged.amount || ''}
                onChange={(e) => { const v = parseInt(e.target.value, 10); patch({ amount: isNaN(v) ? 0 : v }); }}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200 text-right focus:outline-none focus:border-blue-500" />
            </FieldGroup>
          </div>

          {/* 归类与目标 */}
          <FieldGroup label="业务归类">
            <select value={merged.targetCategory} onChange={(e) => {
              const cat = e.target.value as ImportTargetCategory;
              const updates: Partial<ImportDraftRow> = { targetCategory: cat, targetPlannedOrderId: undefined, isNewPosition: cat === 'NEW_POSITION' };
              if (cat === 'NEW_POSITION') updates.targetPositionId = undefined;
              if (cat === 'BIND_PLANNED_ORDER' && availPlans.length > 0) updates.targetPlannedOrderId = availPlans[0].id;
              patch(updates);
            }}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500">
              {CAT_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </FieldGroup>

          {/* 关联目标 */}
          {merged.targetCategory === 'BIND_PLANNED_ORDER' ? (
            <FieldGroup label="关联计划单">
              <select value={merged.targetPlannedOrderId ?? ''} onChange={(e) => patch({ targetPlannedOrderId: e.target.value || undefined })}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500">
                <option value="">-- 选择计划单 --</option>
                {availPlans.map((p) => <option key={p.id} value={p.id}>{(p.direction === 'buy' ? '买入' : '卖出')} ¥{p.plannedPrice}×{p.plannedAmount}</option>)}
              </select>
            </FieldGroup>
          ) : merged.targetCategory === 'NEW_POSITION' ? (
            <div className="text-xs text-blue-400 bg-blue-500/10 rounded-lg px-3 py-2">🆕 将作为全新开仓处理</div>
          ) : (
            <FieldGroup label="关联持仓">
              <div className="flex gap-2">
                <select value={merged.targetPositionId ?? ''} onChange={(e) => {
                  const val = e.target.value;
                  patch({ targetPositionId: val || undefined, isNewPosition: false });
                }}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500">
                  <option value="">-- 选择持仓 --</option>
                  {availPositions.map((p) => <option key={p.id} value={p.id}>{p.stockName} (¥{p.currentCost.toFixed(2)}×{p.currentAmount})</option>)}
                </select>
                <button
                  onClick={() => patch({ targetPositionId: undefined, isNewPosition: true, targetCategory: 'NEW_POSITION' })}
                  className="shrink-0 px-3 py-2.5 rounded-lg bg-blue-500/10 text-blue-400 text-xs border border-blue-500/30 hover:bg-blue-500/20"
                >
                  新开仓
                </button>
              </div>
            </FieldGroup>
          )}

          {/* 防重 & 风控状态 */}
          <div className="flex items-center gap-3 text-xs">
            <span className="text-slate-500">防重:</span>
            <span className={`font-medium ${DUP_COLOR[row.duplicateStatus]}`}>
              {DUP_LABEL[row.duplicateStatus]} {row.duplicateStatus === 'EXACT_DUPLICATE' ? '(完全重复，自动跳过)' : row.duplicateStatus === 'POTENTIAL' ? '(疑似重复)' : ''}
            </span>
            {row.matchedRecordId && <span className="text-slate-600">匹配记录: {row.matchedRecordId.slice(0, 8)}</span>}
          </div>
          {row.validationMessage && (
            <div className={`text-xs px-3 py-2 rounded-lg ${
              row.validationStatus === 'ERROR' ? 'bg-red-500/10 text-red-400' :
              row.validationStatus === 'WARNING' ? 'bg-amber-500/10 text-amber-400' :
              'bg-green-500/10 text-green-400'
            }`}>
              {row.validationMessage}
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex gap-3 pt-2 pb-4">
            <button
              onClick={handleSave}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors active:scale-[0.98]"
            >
              <Save className="w-4 h-4" /> 保存修改
            </button>
            <button
              onClick={onDelete}
              className="px-4 py-3 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 text-sm font-medium border border-red-500/30 transition-colors active:scale-[0.98]"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- 表单字段组 ----
function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs text-slate-400 font-medium">{label}</label>
      {children}
    </div>
  );
}

// ============================================================
// 工具函数
// ============================================================
function toLocalDatetime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatTimeCompact(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}