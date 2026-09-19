/**
 * @file ResultCardList.tsx
 * @description 检索命中卡片列表（spec F2 场景 2）：公告行卡（代码/名称/日期 + 2~3 句
 *              提炼摘要，默认 line-clamp 点击展开全文 + 命中关键词高亮）与 CLS 电报卡
 *              （edition 徽章 + 提及股票 chips，点击 chip 等价以该股发起档案卡查询）。
 *              卡片操作区：【问 AI】（复用 BlockFocusButton，blockId = news_search:result:
 *              {resultId}，与 Copilot 区块注册锚点一致；区块独立会话互不叠加）。
 *              公告订阅入口已按产品要求从搜索页移除（订阅仍在档案卡与持仓页提供）。
 * @layer UI
 * @storage_impact 纯展示组件，无存储读写。
 * @author 开发团队
 */

import { useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import BlockFocusButton from '../copilot/BlockFocusButton';
import type { AnnouncementHit, ClsHit, SearchResultItem } from '../../types/search';

const SEARCH_SCOPE_ID = 'news_search';

/** edition 徽章文案（接口文档 Q3：一期恒 telegraph；映射保留仅为契约稳定） */
const EDITION_LABEL: Record<ClsHit['edition'], string> = {
  morning: '早报',
  evening: '晚报',
  telegraph: '电报',
};

/** 查询词分词（空格分隔、≥2 字符）转义后合并为高亮正则；无有效词返回 null */
function buildHighlightRegex(query: string): RegExp | null {
  const tokens = query.trim().split(/\s+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  const escaped = tokens.map((t) => t.replace(/[.*+?^'"{}()|[\]\\]/g, '\\$&'));
  try {
    return new RegExp('(' + escaped.join('|') + ')', 'gi');
  } catch {
    return null;
  }
}

/** 关键词高亮渲染：命中片段包 <mark>，其余原样输出 */
function HighlightedText({ text, query }: { text: string; query: string }) {
  const regex = useMemo(() => buildHighlightRegex(query), [query]);
  if (!regex) return <>{text}</>;
  const parts = text.split(regex);
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

/** 公告行卡：点击展开/收起摘要全文；原文外链巨潮 */
function AnnouncementCard({ hit, query }: { hit: AnnouncementHit; query: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="card space-y-2 !mb-0">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs text-slate-500">{hit.stockId}</span>
            <span className="text-sm font-semibold text-slate-200">{hit.stockName}</span>
            <span className="text-xs text-slate-500">({hit.annDate})</span>
          </div>
          {hit.title && (
            <div className="mt-1 text-xs font-medium text-slate-300">
              <HighlightedText text={hit.title} query={query} />
            </div>
          )}
          <p className={`mt-1 text-xs leading-relaxed text-slate-400 ${expanded ? '' : 'line-clamp-2'}`}>
            <HighlightedText text={hit.summary} query={query} />
          </p>
          {!expanded && <span className="mt-0.5 inline-block text-[11px] text-slate-600">点击展开全文</span>}
        </button>
        {hit.sourceUrl && (
          <a
            href={hit.sourceUrl}
            target="_blank"
            rel="noreferrer"
            title="查看巨潮原文"
            className="tap-target flex flex-shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-blue-400 transition-colors hover:bg-slate-800 hover:text-blue-300"
          >
            <ExternalLink className="h-3 w-3" />
            原文
          </a>
        )}
      </div>
      <div className="flex items-center justify-end gap-2">
        <BlockFocusButton
          scopeId={SEARCH_SCOPE_ID}
          blockId={SEARCH_SCOPE_ID + ':result:' + hit.resultId}
          title="针对此条追问 AI"
        />
      </div>
    </div>
  );
}

/** CLS 电报卡：edition 徽章 + 提及股票 chips（点击 chip 以该股发起查询） */
function ClsCard({
  hit,
  query,
  onSelectStock,
}: {
  hit: ClsHit;
  query: string;
  onSelectStock: (stockId: string) => void;
}) {
  return (
    <div className="card space-y-2 !mb-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="rounded-full bg-purple-500/15 px-1.5 py-0.5 text-xs font-bold text-purple-300">
          {EDITION_LABEL[hit.edition] ?? '电报'}
        </span>
        <span className="font-mono text-xs text-slate-500">{hit.publishedAt}</span>
      </div>
      {hit.title && (
        <div className="text-xs font-medium text-slate-300">
          <HighlightedText text={hit.title} query={query} />
        </div>
      )}
      <p className="text-xs leading-relaxed text-slate-400">
        <HighlightedText text={hit.summary} query={query} />
      </p>
      {hit.mentions.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] text-slate-600">提及：</span>
          {hit.mentions.map((m) => (
            <button
              key={m.stockId}
              type="button"
              onClick={() => onSelectStock(m.stockId)}
              title={'查询 ' + m.stockName + ' 的档案'}
              className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300 transition-colors hover:bg-blue-600/20 hover:text-blue-300"
            >
              {m.stockName} {m.stockId}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <BlockFocusButton
          scopeId={SEARCH_SCOPE_ID}
          blockId={SEARCH_SCOPE_ID + ':result:' + hit.resultId}
          title="针对此条追问 AI"
        />
      </div>
    </div>
  );
}

interface ResultCardListProps {
  items: SearchResultItem[];
  /** 当前查询词（关键词高亮） */
  query: string;
  /** CLS 提及 chip 点击：以该股票发起档案卡查询 */
  onSelectStock: (stockId: string) => void;
}

export default function ResultCardList({ items, query, onSelectStock }: ResultCardListProps) {
  return (
    <div className="space-y-3">
      {items.map((item) =>
        item.kind === 'announcement' ? (
          <AnnouncementCard key={item.resultId} hit={item} query={query} />
        ) : (
          <ClsCard key={item.resultId} hit={item} query={query} onSelectStock={onSelectStock} />
        ),
      )}
    </div>
  );
}
