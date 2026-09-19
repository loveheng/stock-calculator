/**
 * @file KgEventDrawer.tsx
 * @description 事件详情抽屉（接口文档 §六「卡片详情抽屉」）：detail 全文 + 事件元信息 +
 *              实体 chips（点击 = entityId 检索漫游）+ 溯源脚注（源汇编稿标题 + articleId）。
 *              一期溯源仅展示文本（资讯页无按 articleId 打开详情的路由，见 docs/news-kg-spec.md
 *              待确认定案 #4）。关闭路径：背景点击 / 右上按钮 / Escape 键。
 * @layer UI
 * @storage_impact 纯展示组件，无存储读写。
 * @author 开发团队
 */

import { useEffect } from 'react';
import { X } from 'lucide-react';
import type { KgEntityRef, KgTimelineDay, KgTimelineEvent } from '../../types/kg';
import { kgEventTimeText } from '../../utils/kgText';
import { KgHighlightText, KgEntityChip } from './KgShared';

interface KgEventDrawerProps {
  event: KgTimelineEvent;
  day: KgTimelineDay | null;
  terms: string[];
  onClose: () => void;
  onSelectEntity: (entity: Pick<KgEntityRef, 'id' | 'name'>) => void;
}

export default function KgEventDrawer({
  event,
  day,
  terms,
  onClose,
  onSelectEntity,
}: KgEventDrawerProps) {
  // Escape 关闭（打开期间注册，卸载即注销）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="事件详情"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex-shrink-0 text-xs text-slate-500">{kgEventTimeText(event)}</span>
              {event.eventType && (
                <span className="inline-flex flex-shrink-0 items-center rounded border border-slate-700 bg-slate-800/60 px-1.5 py-0.5 text-[10px] leading-none text-slate-400">
                  {event.eventType}
                </span>
              )}
            </div>
            <h4 className="text-base font-semibold leading-snug text-slate-100">
              <KgHighlightText text={event.title} terms={terms} />
            </h4>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="tap-target flex-shrink-0 rounded-full p-1.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
            aria-label="关闭详情"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {event.detail ? (
          <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
            <KgHighlightText text={event.detail} terms={terms} />
          </p>
        ) : (
          <p className="mt-3 text-xs text-slate-600">该事件暂无补充细节，标题即汇编原文。</p>
        )}

        {event.entities.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {event.entities.map((e) => (
              <KgEntityChip key={e.id} entity={e} onSelect={onSelectEntity} />
            ))}
          </div>
        )}

        <footer className="mt-4 border-t border-slate-800 pt-3 text-[11px] leading-relaxed text-slate-600">
          溯源：{day?.articleTitle || '《新闻联播》要闻汇编'}
          {day?.date ? '（' + day.date + '）' : ''}
          {' · 源稿 ID ' + event.articleId}
        </footer>
      </div>
    </div>
  );
}
