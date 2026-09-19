/**
 * @file KgShared.tsx
 * @description 新闻联播图谱共享展示原子：关键词高亮文本（分段渲染防 XSS，不拼 innerHTML）、
 *              实体 chip（点击回调 = entityId 检索漫游）、实体类型徽章（八类配色映射）。
 *              仅 Kg 域组件复用，不跨域抽公共层（与 search 域 HighlightedText 实现口径
 *              不同：kg 需支持多词集合高亮，来自 keyword 分词 + 实体名）。
 * @layer UI
 * @storage_impact 纯展示组件，无存储读写。
 * @author 开发团队
 */

import { useMemo } from 'react';
import type { KgEntityRef, KgEntityType } from '../../types/kg';
import { kgEntityTypeLabel, splitKgHighlight } from '../../utils/kgText';

/** 实体类型 → 徽章配色（暗色底细边框，八类一色） */
const TYPE_BADGE_CLASS: Record<KgEntityType, string> = {
  STOCK: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  SUBJECT: 'bg-violet-500/10 text-violet-300 border-violet-500/20',
  ORG: 'bg-sky-500/10 text-sky-300 border-sky-500/20',
  PERSON: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
  PLACE: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/20',
  POLICY: 'bg-rose-500/10 text-rose-300 border-rose-500/20',
  EVENT: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
  OTHER: 'bg-slate-500/10 text-slate-300 border-slate-500/20',
};

/** 实体类型徽章（类型 + 中文名） */
export function KgTypeBadge({ type }: { type: KgEntityType }) {
  return (
    <span className={'inline-flex flex-shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] leading-none ' + TYPE_BADGE_CLASS[type]}>
      {kgEntityTypeLabel(type)}
    </span>
  );
}

/** 关键词高亮文本：terms 来自 buildKgHighlightTerms；无有效词时原样渲染 */
export function KgHighlightText({ text, terms }: { text: string; terms: string[] }) {
  const parts = useMemo(() => splitKgHighlight(text, terms), [text, terms]);
  if (!parts) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-amber-500/30 px-0.5 text-slate-100">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

interface KgEntityChipProps {
  entity: Pick<KgEntityRef, 'id' | 'name' | 'entityType'>;
  /** 点击 = 以该实体 id 检索（漫游）；缺省渲染为非交互徽章（事件卡内 chips） */
  onSelect?: (entity: Pick<KgEntityRef, 'id' | 'name'>) => void;
  /** 附加计数（mentionCount / coMentionCount 等），有值时追加展示 */
  count?: number;
}

/** 实体 chip：带类型徽章的可点击胶囊（热榜 / 命中实体 / 共现漫游共用） */
export function KgEntityChip({ entity, onSelect, count }: KgEntityChipProps) {
  const clickable = typeof onSelect === 'function';
  const className =
    'tap-target inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ' +
    (clickable
      ? 'border-slate-700 bg-slate-800/70 text-slate-300 hover:border-blue-500/60 hover:text-blue-300'
      : 'border-slate-800 bg-slate-800/40 text-slate-400');
  const inner = (
    <>
      <KgTypeBadge type={entity.entityType} />
      <span className="truncate">{entity.name}</span>
      {typeof count === 'number' && count > 0 && (
        <span className="flex-shrink-0 text-[10px] text-slate-500">×{count}</span>
      )}
    </>
  );
  if (!clickable) return <span className={className}>{inner}</span>;
  return (
    <button type="button" className={className} onClick={() => onSelect(entity)}>
      {inner}
    </button>
  );
}
