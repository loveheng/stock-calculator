/**
 * @file KgEntityCard.tsx
 * @description 实体详情摘要卡（接口文档 §五）：搜索态置顶展示——规范名 + 类型/锚点徽章 +
 *              别名（点击 = 以别名作 keyword 检索）+ 提及/参与事件计数 + 首末出现日期 +
 *              高频共现实体 chips（点击 = 以该实体 id 重新搜索，即「漫游」）。
 *              取数由父组件（KgPanel）直调 kgService 下发；本组件纯展示。
 * @layer UI
 * @storage_impact 纯展示组件，无存储读写。
 * @author 开发团队
 */

import { X } from 'lucide-react';
import type { KgEntityDetail, KgEntityRef } from '../../types/kg';
import { KgEntityChip, KgTypeBadge } from './KgShared';

interface KgEntityCardProps {
  detail: KgEntityDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  /** 共现实体 chip 点击（entityId 漫游检索） */
  onSelectEntity: (entity: Pick<KgEntityRef, 'id' | 'name'>) => void;
  /** 别名点击（keyword 检索） */
  onSelectAlias: (alias: string) => void;
}

export default function KgEntityCard({
  detail,
  loading,
  error,
  onClose,
  onSelectEntity,
  onSelectAlias,
}: KgEntityCardProps) {
  if (loading) {
    return (
      <div className="card animate-pulse space-y-2 !mb-0">
        <div className="h-4 w-1/3 rounded bg-slate-800" />
        <div className="h-3 w-2/3 rounded bg-slate-800" />
        <div className="h-3 w-1/2 rounded bg-slate-800" />
      </div>
    );
  }
  if (error || !detail) {
    return (
      <div className="card flex items-center justify-between gap-2 !mb-0">
        <p className="text-xs text-slate-500">{error ?? '实体详情暂不可用'}</p>
        <button
          type="button"
          onClick={onClose}
          className="tap-target flex-shrink-0 rounded-full p-1 text-slate-500 hover:text-slate-300"
          aria-label="关闭实体详情"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="card space-y-2.5 !mb-0">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-slate-100">{detail.name}</h4>
            <KgTypeBadge type={detail.entityType} />
            {detail.anchorType === 'STOCK' && (
              <span className="inline-flex items-center rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] leading-none text-emerald-300">
                锚定股票{detail.anchorId ? ' · ' + detail.anchorId : ''}
              </span>
            )}
            {detail.anchorType === 'CLS_SUBJECT' && (
              <span className="inline-flex items-center rounded border border-violet-500/20 bg-violet-500/10 px-1.5 py-0.5 text-[10px] leading-none text-violet-300">
                锚定题材{detail.anchorId ? ' · ' + detail.anchorId : ''}
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            提及 {detail.mentionCount} 次 · 参与 {detail.eventCount} 个事件
            {detail.firstSeenAt && detail.lastSeenAt ? ' · ' + detail.firstSeenAt + ' ~ ' + detail.lastSeenAt : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="tap-target flex-shrink-0 rounded-full p-1 text-slate-500 hover:text-slate-300"
          aria-label="关闭实体详情"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {detail.aliases.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="flex-shrink-0 text-[11px] text-slate-600">别名</span>
          {detail.aliases.map((alias) => (
            <button
              key={alias}
              type="button"
              onClick={() => onSelectAlias(alias)}
              className="tap-target rounded-full bg-slate-800/70 px-2 py-0.5 text-[11px] text-slate-400 transition-colors hover:text-blue-300"
              title="点击按该别名检索"
            >
              {alias}
            </button>
          ))}
        </div>
      )}

      {detail.relatedEntities.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="flex-shrink-0 text-[11px] text-slate-600">共现</span>
          {detail.relatedEntities.map((rel) => (
            <KgEntityChip
              key={rel.id}
              entity={rel}
              count={rel.coMentionCount}
              onSelect={onSelectEntity}
            />
          ))}
        </div>
      )}
    </div>
  );
}
