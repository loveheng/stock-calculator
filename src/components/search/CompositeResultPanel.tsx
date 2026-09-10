/**
 * @file CompositeResultPanel.tsx
 * @description AI 综合摘要面板（spec F2/D9）：显式「生成中」态（骨架屏 + 光标闪烁），
 *              SSE delta 渐进渲染摘要文本；完成后展示引用来源列表
 *              （citations：公告/电报徽章 + 标题 + 日期/代码）。
 * @layer UI
 * @storage_impact 纯展示组件，无存储读写。
 * @author 开发团队
 */

import { Loader2, Sparkles } from 'lucide-react';
import type { CompositeResult } from '../../types/search';

interface CompositeResultPanelProps {
  result: CompositeResult | null;
  /** 生成中（status === 'generating'）：显示进度提示与流式光标 */
  generating: boolean;
}

export default function CompositeResultPanel({ result, generating }: CompositeResultPanelProps) {
  const summary = result?.summary ?? '';
  const citations = result?.citations ?? [];

  return (
    <div className="card space-y-3 !mb-0 border-blue-500/20">
      <div className="flex items-center gap-2 flex-wrap">
        <Sparkles className="h-4 w-4 flex-shrink-0 text-blue-400" />
        <span className="text-sm font-semibold text-slate-200">AI 综合摘要</span>
        {generating && (
          <span className="flex items-center gap-1 text-xs text-blue-300">
            <Loader2 className="h-3 w-3 animate-spin" />
            AI 正在综合两个库的信息…
          </span>
        )}
      </div>

      {summary ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
          {summary}
          {generating && (
            <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-blue-400 align-middle" />
          )}
        </p>
      ) : generating ? (
        <div className="animate-pulse space-y-2">
          <div className="h-3 w-full rounded bg-slate-800" />
          <div className="h-3 w-5/6 rounded bg-slate-800" />
          <div className="h-3 w-2/3 rounded bg-slate-800" />
        </div>
      ) : (
        <p className="text-xs text-slate-500">未检索到足够相关信息，换个关键词或扩大日期范围试试。</p>
      )}

      {citations.length > 0 && (
        <div className="space-y-1.5 border-t border-slate-800 pt-2">
          <div className="text-xs font-medium text-slate-500">引用来源（{citations.length}）</div>
          {citations.map((c) => (
            <div key={c.kind + ':' + c.resultId} className="flex items-center gap-2 text-xs text-slate-400">
              <span
                className={`flex-shrink-0 rounded px-1 py-0.5 text-[10px] font-bold ${
                  c.kind === 'announcement'
                    ? 'bg-blue-500/15 text-blue-300'
                    : 'bg-purple-500/15 text-purple-300'
                }`}
              >
                {c.kind === 'announcement' ? '公告' : '电报'}
              </span>
              <span className="truncate">{c.title}</span>
              <span className="ml-auto flex-shrink-0 text-slate-600">
                {c.date}
                {c.stockId ? ' · ' + c.stockId : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
