/**
 * @file CustomStatsPanel.tsx
 * @description 自定义统计画廊（数据统计页 custom tab）：双区钉选布局。
 *              - 数字卡区（card 类钉选）/ 图表区（chart 类钉选），区由 lastResult.kind 唯一决定；
 *              - 每区默认 5 条，「加载更多」分页（visibleCount 游标）；「全部定义」折叠列表含管理入口；
 *              - 打开页面后台批量刷新已加载条目（SWR：缓存秒显 + 「截至 HH:mm」角标）；
 *              - NEW 角标：pinnedAt > lastSeenAt（localStorage 基准）；
 *              - 删除弹层展示生成提示词并提供复制（FR7 提示词保全）；
 *              - 重新生成：复用存储 prompt 种子发起聊天（FR8）。
 * @layer Views —— 只依赖 store/components/types/utils，禁碰 db（R1）
 * @storage_impact 经 store 动作间接读写 customStats 表（钉选/删除/运行态写回）。
 * @author 开发团队
 */

import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  RefreshCw,
  Pin,
  PinOff,
  Trash2,
  Play,
  Wand2,
  ChevronDown,
  ChevronUp,
  Copy,
  Plus,
} from 'lucide-react';
import { useAppStore } from '../../store';
import type { CustomStatDefinition, CustomStatsResult } from '../../types/domain';

/** recharts 图表渲染走独立 chunk（仅图表条目可见时拉取） */
const CustomStatChartView = lazy(() => import('./CustomStatCharts'));

/** 每区默认可见条数（分页页大小，D11） */
const PAGE_SIZE = 5;

/** 截至时间角标（HH:mm） */
function asOfLabel(lastRunAt: string | undefined): string | null {
  if (!lastRunAt) return null;
  const d = new Date(lastRunAt);
  if (Number.isNaN(d.getTime())) return null;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `截至 ${hh}:${mm}`;
}

/** tone → 色彩（红涨绿跌，good=红，D16-⑤） */
function toneClass(tone: string | undefined): string {
  if (tone === 'good') return 'text-red-400';
  if (tone === 'bad') return 'text-green-400';
  return 'text-slate-100';
}

/** 数字卡区条目：紧凑 KPI 卡 */
function CardItem({ def, isNew }: { def: CustomStatDefinition; isNew: boolean }) {
  const runCustomStatDef = useAppStore((s) => s.runCustomStatDef);
  const result = def.lastResult;
  if (!result || result.kind !== 'card') return null;
  const asOf = asOfLabel(def.lastRunAt);
  return (
    <div className={`rounded-[20px] border bg-gradient-to-br from-slate-900 to-slate-950 p-3.5 shadow-sm ${isNew ? 'ring-1 ring-blue-500/60' : 'border-slate-800'}`}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-slate-300 truncate flex-1">{def.name}</span>
        {asOf && <span className="shrink-0 text-[10px] text-slate-600">{asOf}</span>}
        {isNew && <span className="shrink-0 rounded-full bg-blue-600/20 px-1.5 py-0.5 text-[10px] text-blue-300">NEW</span>}
      </div>
      <div className="mt-2 flex gap-2">
        {result.kpis.map((kpi, i) => (
          <div key={i} className="flex-1 min-w-0">
            <div className="text-[10px] text-slate-500 truncate">{kpi.label || '—'}</div>
            <div className={`text-sm font-semibold truncate ${toneClass(kpi.tone)}`}>{kpi.value || '—'}</div>
          </div>
        ))}
      </div>
      {result.caption && <p className="mt-1.5 text-[10px] text-slate-600 truncate">{result.caption}</p>}
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={() => void runCustomStatDef(def.id)}
          className="tap-target flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-slate-500 hover:text-slate-300"
        >
          <Play className="h-3 w-3" />
          刷新
        </button>
      </div>
    </div>
  );
}

/** 图表区条目：完整图表块 */
function ChartItem({ def, isNew }: { def: CustomStatDefinition; isNew: boolean }) {
  const runCustomStatDef = useAppStore((s) => s.runCustomStatDef);
  const result = def.lastResult;
  if (!result || result.kind !== 'chart') return null;
  const asOf = asOfLabel(def.lastRunAt);
  return (
    <div className={`rounded-[20px] border bg-gradient-to-br from-slate-900 to-slate-950 p-4 shadow-sm ${isNew ? 'ring-1 ring-blue-500/60' : 'border-slate-800'}`}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-slate-200 truncate flex-1">{def.name}</span>
        {asOf && <span className="shrink-0 text-[10px] text-slate-600">{asOf}</span>}
        {isNew && <span className="shrink-0 rounded-full bg-blue-600/20 px-1.5 py-0.5 text-[10px] text-blue-300">NEW</span>}
      </div>
      {result.caption && <p className="mt-0.5 text-[10px] text-slate-600 line-clamp-1">{result.caption}</p>}
      <div className="mt-2">
        <Suspense fallback={<div className="h-[220px] flex items-center justify-center text-slate-500 text-sm"><Loader2 className="w-4 h-4 animate-spin mr-2" />图表加载中…</div>}>
          <CustomStatChartView result={result} />
        </Suspense>
      </div>
      <div className="mt-1 flex justify-end">
        <button
          type="button"
          onClick={() => void runCustomStatDef(def.id)}
          className="tap-target flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-slate-500 hover:text-slate-300"
        >
          <Play className="h-3 w-3" />
          刷新
        </button>
      </div>
    </div>
  );
}

/** 结果为空的已钉选定义：空态占位（数据还没录，或尚未运行过） */
function EmptyItem({ def }: { def: CustomStatDefinition }) {
  return (
    <div className="rounded-[20px] border border-slate-800 bg-slate-900/60 p-4">
      <div className="text-xs font-medium text-slate-400">{def.name}</div>
      <p className="mt-1 text-[11px] text-slate-600">尚未生成过结果，点击运行即可首次计算</p>
    </div>
  );
}

/** NEW 角标判定：钉选时间晚于上次查看基准（FR9） */
function isNewDef(def: CustomStatDefinition, lastSeenAt: string): boolean {
  return !!def.pinnedAt && def.pinnedAt > lastSeenAt;
}

/** 删除确认弹层（FR7：展示生成提示词 + 一键复制，提示词将一并删除） */
function DeleteModal({ def, onClose }: { def: CustomStatDefinition; onClose: () => void }) {
  const deleteCustomStatDef = useAppStore((s) => s.deleteCustomStatDef);
  const [copied, setCopied] = useState(false);

  const copyPrompt = async () => {
    if (!def.prompt) return;
    try {
      await navigator.clipboard.writeText(def.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板不可用（非安全上下文/权限拒绝）：提示词文本仍可手动选中复制
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-4" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-semibold text-slate-200">删除「{def.name}」？</div>
        <p className="mt-1 text-xs text-slate-500">删除后该统计不再展示；其生成提示词将一并删除，如需保留请先复制。</p>
        {def.prompt ? (
          <div className="mt-2.5 rounded-xl border border-slate-800 bg-slate-950/60 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-500">生成提示词（贴回聊天框可重建）</span>
              <button
                type="button"
                onClick={() => void copyPrompt()}
                className="tap-target flex items-center gap-1 rounded-lg bg-slate-800 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-700"
              >
                <Copy className="h-3 w-3" />
                {copied ? '已复制' : '复制提示词'}
              </button>
            </div>
            <p className="mt-1.5 max-h-24 overflow-auto text-xs leading-relaxed text-slate-400 break-all">{def.prompt}</p>
          </div>
        ) : (
          <p className="mt-2.5 text-[11px] text-slate-600">该定义没有存储生成提示词</p>
        )}
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={onClose} className="tap-target flex-1 rounded-xl border border-slate-700 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800">
            取消
          </button>
          <button
            type="button"
            onClick={() => {
              void deleteCustomStatDef(def.id);
              onClose();
            }}
            className="tap-target flex-1 rounded-xl bg-red-600 py-2 text-xs font-medium text-white hover:bg-red-500"
          >
            确认删除
          </button>
        </div>
      </div>
    </div>
  );
}

/** 图标操作钮（管理列表用） */
function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick} className="tap-target rounded-lg p-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-300">
      {children}
    </button>
  );
}

/** 全部定义列表条目（管理入口：运行 / 重新生成 / 钉选切换 / 删除，FR5/FR8） */
function DefRow({ def, onDelete }: { def: CustomStatDefinition; onDelete: (d: CustomStatDefinition) => void }) {
  const togglePin = useAppStore((s) => s.toggleCustomStatPin);
  const runCustomStatDef = useAppStore((s) => s.runCustomStatDef);
  const regenerateCustomStatDef = useAppStore((s) => s.regenerateCustomStatDef);
  const asOf = asOfLabel(def.lastRunAt);
  return (
    <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2">
      <span className="shrink-0 rounded-md bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
        {def.kind === 'card' ? '数字卡' : '图表'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-slate-300">{def.name}</div>
        {asOf && <div className="text-[10px] text-slate-600">{asOf} · 已运行 {def.runCount ?? 0} 次</div>}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconBtn title="运行" onClick={() => void runCustomStatDef(def.id)}><Play className="h-3.5 w-3.5" /></IconBtn>
        <IconBtn title="重新生成" onClick={() => void regenerateCustomStatDef(def.id)}><Wand2 className="h-3.5 w-3.5" /></IconBtn>
        <IconBtn title={def.pinned ? '取消钉选' : '钉选'} onClick={() => void togglePin(def.id, !def.pinned)}>
          {def.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
        </IconBtn>
        <IconBtn title="删除" onClick={() => onDelete(def)}><Trash2 className="h-3.5 w-3.5" /></IconBtn>
      </div>
    </div>
  );
}

interface ZoneProps {
  kind: 'card' | 'chart';
  defs: CustomStatDefinition[];
  lastSeenAt: string;
  onDelete: (d: CustomStatDefinition) => void;
}

/** 双区之一：钉选条目分页展示（区内 pinnedAt 倒序）+ 页外新钉选胶囊（FR9） */
function PinZone({ kind, defs, lastSeenAt, onDelete }: ZoneProps) {
  const [visible, setVisible] = useState(PAGE_SIZE);
  const sorted = useMemo(
    () =>
      [...defs]
        .filter((d) => d.pinned)
        .sort((a, b) => (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? '')),
    [defs],
  );
  const shown = sorted.slice(0, visible);
  const hiddenNewCount = sorted.slice(visible).filter((d) => isNewDef(d, lastSeenAt)).length;

  if (sorted.length === 0) return null;
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-400">{kind === 'card' ? '数字卡' : '统计图表'}</span>
        {hiddenNewCount > 0 && (
          <button
            type="button"
            onClick={() => setVisible(sorted.length)}
            className="tap-target rounded-full bg-blue-600/20 px-2.5 py-1 text-[11px] text-blue-300"
          >
            ↑ 顶部有 {hiddenNewCount} 条新钉选，点击查看
          </button>
        )}
      </div>
      <div className={kind === 'card' ? 'mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2' : 'mt-2 space-y-2'}>
        {shown.map((d) =>
          d.lastResult?.kind === 'card' ? (
            <CardItem key={d.id} def={d} isNew={isNewDef(d, lastSeenAt)} />
          ) : d.lastResult?.kind === 'chart' ? (
            <ChartItem key={d.id} def={d} isNew={isNewDef(d, lastSeenAt)} />
          ) : (
            <EmptyItem key={d.id} def={d} />
          ),
        )}
      </div>
      {visible < sorted.length && (
        <button
          type="button"
          onClick={() => setVisible((v) => v + PAGE_SIZE)}
          className="tap-target mt-2 w-full rounded-xl border border-slate-800 py-2 text-xs text-slate-400 hover:bg-slate-900"
        >
          加载更多（{sorted.length - visible} 条）
        </button>
      )}
    </div>
  );
}

/**
 * 自定义统计画廊（数据统计页 custom tab 挂载点）。
 *
 * @description 挂载时：① 加载画廊元数据；② 沙箱预热（wasm 懒加载）；
 *              ③ 后台批量刷新已加载条目（SWR，缓存秒显 + 渐进替换）；
 *              ④ NEW 角标本轮可见后延时清除基准（查看后淡出，FR9）。
 */
export function CustomStatsPanel() {
  const defs = useAppStore((s) => s.customStatsGallery);
  const lastSeenAt = useAppStore((s) => s.customStatsLastSeenAt);
  const refreshing = useAppStore((s) => s.customStatsRefreshing);
  const loadCustomStatsGallery = useAppStore((s) => s.loadCustomStatsGallery);
  const refreshLoadedCustomStats = useAppStore((s) => s.refreshLoadedCustomStats);
  const syncCustomStatsFromServer = useAppStore((s) => s.syncCustomStatsFromServer);
  const markCustomStatsSeen = useAppStore((s) => s.markCustomStatsSeen);
  const setCopilotOpen = useAppStore((s) => s.setCopilotOpen);
  const [deleteTarget, setDeleteTarget] = useState<CustomStatDefinition | null>(null);
  const [allOpen, setAllOpen] = useState(false);

  useEffect(() => {
    void loadCustomStatsGallery();
    // 登录即备份：进入 tab 先对账（拉取合并/推送/传播删除，静默），再后台刷新缓存结果
    void syncCustomStatsFromServer();
    void refreshLoadedCustomStats();
    const timer = setTimeout(() => markCustomStatsSeen(), 4000);
    return () => clearTimeout(timer);
    // 挂载时执行一次（进入 tab 即视为查看）
  }, []);

  const cardDefs = useMemo(() => defs.filter((d) => d.kind === 'card'), [defs]);
  const chartDefs = useMemo(() => defs.filter((d) => d.kind === 'chart'), [defs]);

  if (defs.length === 0) {
    return (
      <div className="rounded-[28px] border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-950 p-8 text-center">
        <p className="text-sm text-slate-400">还没有自定义统计</p>
        <p className="mt-1 text-xs text-slate-600">打开 AI 助手，用一句话描述你想要的统计，例如「各股做T净收益排行」</p>
        <button
          type="button"
          onClick={() => setCopilotOpen(true)}
          className="tap-target mt-3 rounded-xl bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500"
        >
          <Plus className="mr-1 inline h-3.5 w-3.5" />
          去 AI 助手生成
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-300">我的自定义统计</span>
        <button
          type="button"
          onClick={() => void refreshLoadedCustomStats()}
          disabled={refreshing}
          className="tap-target flex items-center gap-1.5 rounded-xl border border-slate-800 px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-900 disabled:opacity-60"
        >
          {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          刷新
        </button>
      </div>

      <PinZone kind="card" defs={cardDefs} lastSeenAt={lastSeenAt} onDelete={setDeleteTarget} />
      <PinZone kind="chart" defs={chartDefs} lastSeenAt={lastSeenAt} onDelete={setDeleteTarget} />

      {/* 全部定义（折叠列表，含未钉选 + 管理入口，FR5） */}
      <div className="rounded-[20px] border border-slate-800 bg-slate-900/50">
        <button
          type="button"
          onClick={() => setAllOpen((v) => !v)}
          className="tap-target flex w-full items-center justify-between px-4 py-3"
        >
          <span className="text-xs font-medium text-slate-400">全部定义（{defs.length}）</span>
          {allOpen ? <ChevronUp className="h-4 w-4 text-slate-500" /> : <ChevronDown className="h-4 w-4 text-slate-500" />}
        </button>
        {allOpen && (
          <div className="space-y-1.5 px-3 pb-3">
            {defs.map((d) => (
              <DefRow key={d.id} def={d} onDelete={setDeleteTarget} />
            ))}
          </div>
        )}
      </div>

      {deleteTarget && <DeleteModal def={deleteTarget} onClose={() => setDeleteTarget(null)} />}
    </div>
  );
}

export default CustomStatsPanel;
