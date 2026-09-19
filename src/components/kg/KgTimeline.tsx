/**
 * @file KgTimeline.tsx
 * @description 新闻联播图谱时间轴卡片流（接口文档 §六）：按日组分节渲染（日头 = 日期 +
 *              汇编稿标题 + 事件数），组内事件按汇编原文阅读序平铺为事件卡（时间表述 +
 *              类型徽章 + 标题 + detail 摘要 + 实体 chips）。命中词高亮（前端本地，
 *              terms 由 KgPanel 构建下发）；事件卡点击打开详情抽屉。
 * @layer UI
 * @storage_impact 纯展示组件，无存储读写。
 * @author 开发团队
 */

import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import type { KgEntityRef, KgTimelineDay, KgTimelineEvent } from '../../types/kg';
import { kgDayHeaderText, kgEventTimeText } from '../../utils/kgText';
import { KgHighlightText, KgEntityChip } from './KgShared';

/** 事件卡：detail 默认 3 行截断，点击展开全文（再点收起）；整卡头部区域点击开抽屉 */
function KgEventCard({
  event,
  terms,
  onOpenDetail,
  onSelectEntity,
}: {
  event: KgTimelineEvent;
  terms: string[];
  onOpenDetail: () => void;
  onSelectEntity: (entity: Pick<KgEntityRef, 'id' | 'name'>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <button
        type="button"
        onClick={onOpenDetail}
        className="block w-full text-left"
        aria-label="查看事件详情"
      >
        <div className="flex items-center gap-2">
          <span className="flex-shrink-0 text-[11px] text-slate-500">{kgEventTimeText(event)}</span>
          {/* eventType 为 LLM 自由文本（如「其他」），非实体八类枚举，故用普通徽章直出 */}
          {event.eventType && (
            <span className="inline-flex flex-shrink-0 items-center rounded border border-slate-700 bg-slate-800/60 px-1.5 py-0.5 text-[10px] leading-none text-slate-400">
              {event.eventType}
            </span>
          )}
        </div>
        <div className="mt-1 text-sm font-medium leading-snug text-slate-200">
          <KgHighlightText text={event.title} terms={terms} />
        </div>
        {event.detail && (
          <div className="mt-1 text-xs leading-relaxed text-slate-400">
            <span className={expanded ? '' : 'line-clamp-3'}>
              <KgHighlightText text={event.detail} terms={terms} />
            </span>
          </div>
        )}
      </button>
      {event.detail && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-300"
        >
          <ChevronDown className={'h-3 w-3 transition-transform ' + (expanded ? 'rotate-180' : '')} />
          {expanded ? '收起' : '展开全文'}
        </button>
      )}
      {event.entities.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {event.entities.map((e) => (
            <KgEntityChip key={e.id} entity={e} onSelect={onSelectEntity} />
          ))}
        </div>
      )}
    </div>
  );
}

interface KgTimelineProps {
  days: KgTimelineDay[];
  terms: string[];
  onOpenEvent: (event: KgTimelineEvent, day: KgTimelineDay) => void;
  onSelectEntity: (entity: Pick<KgEntityRef, 'id' | 'name'>) => void;
}

/** 日组分节：日头（日期 + 标题 + 事件数）+ 事件卡列表 */
export default function KgTimeline({ days, terms, onOpenEvent, onSelectEntity }: KgTimelineProps) {
  return (
    <div className="space-y-4">
      {days.map((day) => (
        <section key={day.articleId + '@' + day.date} className="space-y-2">
          <header className="flex items-center gap-2 border-b border-slate-800 pb-1.5">
            <span className="flex-shrink-0 rounded bg-blue-600/15 px-2 py-0.5 text-xs font-semibold text-blue-300">
              {kgDayHeaderText(day.date, day.articleTitle)}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-slate-500">
              {day.articleTitle || '《新闻联播》要闻汇编'}
            </span>
            <span className="flex-shrink-0 text-[11px] text-slate-600">{day.events.length} 条</span>
          </header>
          <div className="space-y-2 border-l border-slate-800 pl-3">
            {day.events.map((event) => (
              <KgEventCard
                key={event.id}
                event={event}
                terms={terms}
                onOpenDetail={() => onOpenEvent(event, day)}
                onSelectEntity={onSelectEntity}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
