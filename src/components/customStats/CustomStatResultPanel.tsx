/**
 * @file CustomStatResultPanel.tsx
 * @description 自定义统计结果面板（聊天浮窗内）：草稿单槽位的运行结果展示与操作。
 *              - 保存 = 唯一信任动作（用户显式点击）；代码折叠可查、透明不设卡（D6）；
 *              - 迭代：用户在输入框继续说 → iterateCustomStatDraft（D15 单码覆盖协议）；
 *              - 错误态：友好卡片 + 「一键让 AI 修复」（携带错误消息 + 行号 + 代码）；
 *              - 空态/Loading/未保存标识（刷新即失的视觉提示，D16-⑥）。
 * @layer Components —— 只依赖 store/types/utils，禁碰 db（R1）
 * @storage_impact 纯 UI；保存/丢弃经 store 动作落库或清内存态。
 * @author 开发团队
 */

import React, { lazy, Suspense, useState } from 'react';
import { Loader2, Save, Trash2, Wrench, ChevronDown, ChevronUp } from 'lucide-react';
import { useAppStore } from '../../store';
import type { CustomStatsResult } from '../../types/domain';

/** recharts 独立 chunk：仅面板渲染图表时拉取 */
const CustomStatChartView = lazy(() => import('./CustomStatCharts'));

/** kpi tone 色彩映射：红涨绿跌（A 股习惯，good=红，D16-⑤），宿主统一控制 */
function toneClass(tone: string | undefined): string {
  if (tone === 'good') return 'text-red-400';
  if (tone === 'bad') return 'text-green-400';
  return 'text-slate-100';
}

function ResultBody({ result }: { result: CustomStatsResult }) {
  if (result.kind === 'card') {
    return (
      <div className="flex gap-2">
        {result.kpis.length === 0 ? (
          <div className="text-sm text-slate-500">无可用数据</div>
        ) : (
          result.kpis.map((kpi, i) => (
            <div key={i} className="flex-1 rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2.5 min-w-0">
              <div className="text-[11px] text-slate-500 truncate">{kpi.label || '—'}</div>
              <div className={`mt-0.5 text-base font-semibold truncate ${toneClass(kpi.tone)}`}>{kpi.value || '—'}</div>
            </div>
          ))
        )}
      </div>
    );
  }
  return (
    <Suspense fallback={<div className="h-[220px] flex items-center justify-center text-slate-500 text-sm"><Loader2 className="w-4 h-4 animate-spin mr-2" />图表加载中…</div>}>
      <CustomStatChartView result={result} />
    </Suspense>
  );
}

export function CustomStatResultPanel() {
  const draft = useAppStore((s) => s.customStatDraft);
  const [saving, setSaving] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const clearDraft = useAppStore((s) => s.clearCustomStatDraft);
  const iterateCustomStatDraft = useAppStore((s) => s.iterateCustomStatDraft);
  const saveCustomStatDraft = useAppStore((s) => s.saveCustomStatDraft);

  if (!draft) return null;

  const handleFix = () => {
    // 「一键让 AI 修复」：注入沙箱错误 + 代码 + 反馈到聊天（FR2 错误态）
    const lineHint = draft.errorLine ? `（错误行号约 ${draft.errorLine}）` : '';
    void iterateCustomStatDraft(`生成的统计代码执行失败${lineHint}：${draft.error ?? '未知错误'}。请修复代码并重新返回完整代码。`);
  };

  const handleSave = () => {
    setSaving(true);
    void saveCustomStatDraft('new').finally(() => setSaving(false));
  };

  return (
    <div className="mx-2.5 mb-2 rounded-2xl border border-blue-900/60 bg-slate-900/90 p-3">
      {/* 标题行：名称 + 第 N 版 + 未保存标识 */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-slate-200 truncate">{draft.name}</span>
        <span className="shrink-0 rounded-full bg-blue-600/20 px-2 py-0.5 text-[11px] text-blue-300">第 {draft.attempt} 版</span>
        <span className="shrink-0 rounded-full bg-slate-700/60 px-2 py-0.5 text-[11px] text-slate-400">未保存 · 刷新即失</span>
      </div>
      {/* 口径说明（必展示） */}
      {draft.description && <p className="mt-1 text-xs text-slate-500 line-clamp-2">{draft.description}</p>}

      <div className="mt-2.5">
        {draft.running ? (
          <div className="h-[88px] flex items-center justify-center text-slate-500 text-sm">
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            AI 代码沙箱计算中…
          </div>
        ) : draft.error ? (
          /* 错误态：友好捕获卡 + 一键 AI 修复 */
          <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-3 py-2.5">
            <div className="text-sm text-amber-300">计算遇到异常</div>
            <div className="mt-1 text-xs text-slate-500 line-clamp-2 break-all">{draft.error}</div>
            <button
              type="button"
              onClick={handleFix}
              className="tap-target mt-2 flex items-center gap-1.5 rounded-lg bg-amber-600/20 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-600/30"
            >
              <Wrench className="h-3.5 w-3.5" />
              一键让 AI 修复
            </button>
          </div>
        ) : draft.lastResult ? (
          <ResultBody result={draft.lastResult} />
        ) : null}
      </div>

      {/* AI 生成代码（折叠可查，透明不设卡 D6） */}
      <div className="mt-2">
        <button
          type="button"
          onClick={() => setCodeOpen((v) => !v)}
          className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-400"
        >
          {codeOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          AI 生成代码
        </button>
        {codeOpen && (
          <pre className="mt-1 max-h-32 overflow-auto rounded-lg bg-slate-950/80 p-2 text-[10px] leading-relaxed text-slate-500 whitespace-pre-wrap break-all">
            {draft.code}
          </pre>
        )}
      </div>

      {/* 操作区：保存（信任动作）/ 丢弃；继续调整 → 聊天输入框直接说 */}
      {!draft.running && !draft.error && (
        <div className="mt-2.5 flex items-center gap-2">
          {draft.originDefId ? (
            /* 重新生成场景：另存新定义 / 替换原定义（FR4 双选项） */
            <>
              <button
                type="button"
                onClick={() => void saveCustomStatDraft('new')}
                className="tap-target flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500"
              >
                <Save className="h-3.5 w-3.5" />
                另存为新定义
              </button>
              <button
                type="button"
                onClick={() => void saveCustomStatDraft('replace')}
                className="tap-target flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-blue-700 px-3 py-2 text-xs font-medium text-blue-300 hover:bg-blue-900/40"
              >
                替换原定义
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="tap-target flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-60"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              保存到统计页
            </button>
          )}
          <button
            type="button"
            onClick={clearDraft}
            className="tap-target flex items-center justify-center gap-1.5 rounded-xl border border-slate-700 px-3 py-2 text-xs font-medium text-slate-400 hover:bg-slate-800"
          >
            <Trash2 className="h-3.5 w-3.5" />
            丢弃
          </button>
        </div>
      )}
      {!draft.running && !draft.error && (
        <p className="mt-1.5 text-[11px] text-slate-600">不满意？在下方输入框继续说，如「改成按月分组」</p>
      )}
    </div>
  );
}

export default CustomStatResultPanel;
