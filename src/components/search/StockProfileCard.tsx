/**
 * @file StockProfileCard.tsx
 * @description 股票确定性档案卡（spec F2 场景 1）：卡头涨跌圆点/现价涨跌幅
 *              （useLiveQuotes，红涨绿跌全局约定；档案卡只有 6 位码，先经
 *              canonicalizeFullCode 转带前缀码再取行情）+【最新公告摘要】+
 *              【财联社提及】（clsMention=null 时隐藏该区块，接口文档 §5）。
 *              操作区仅【订阅公告】（与交易卡片共享订阅态，D6）与【问 AI】两个动作
 *              （D2：明确不做「加为持仓」）。
 * @layer UI
 * @storage_impact 无直接持久化读写；订阅经 store action 同步服务端。
 * @author 开发团队
 */

import { useLiveQuotes } from '../../hooks/useLiveQuotes';
import { canonicalizeFullCode } from '../../utils/dedup';
import AnnouncementSubscribeButton from '../ui/AnnouncementSubscribeButton';
import BlockFocusButton from '../copilot/BlockFocusButton';
import type { StockProfile } from '../../types/search';

const SEARCH_SCOPE_ID = 'news_search';

export default function StockProfileCard({ profile }: { profile: StockProfile }) {
  const fullCode = canonicalizeFullCode(profile.stockId);
  const { quotes } = useLiveQuotes([fullCode]);
  const quote = quotes[fullCode] ?? null;
  const name = profile.stockName || quote?.stockName || profile.stockId;
  const hasQuote = !!quote && quote.currentPrice > 0;
  const up = (quote?.changePercent ?? 0) >= 0;

  return (
    <div className="card space-y-3 !mb-0 border-blue-500/20">
      {/* 卡头：🟢 代码 名称 + 现价/涨跌幅 */}
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${hasQuote ? (up ? 'bg-red-500' : 'bg-green-500') : 'bg-slate-600'}`}
          title={hasQuote ? (up ? '上涨' : '下跌') : '暂无行情'}
        />
        <span className="font-mono text-sm text-slate-400">{profile.stockId}</span>
        <span className="text-base font-semibold text-slate-100">{name}</span>
        {hasQuote && quote && (
          <span
            className={`ml-auto text-xs px-2 py-0.5 rounded-full font-bold ${
              up ? 'bg-red-500/10 text-red-400' : 'bg-green-500/10 text-green-400'
            }`}
          >
            现价 ¥{quote.currentPrice.toFixed(2)}（{up ? '+' : ''}
            {quote.changePercent.toFixed(2)}%）
          </span>
        )}
      </div>

      {/* 区块一：最新公告摘要（最新 1~3 条，按 annDate 倒序） */}
      <div className="space-y-2">
        <div className="text-xs font-medium text-slate-500">【最新公告摘要】</div>
        {profile.latestAnnouncements.length === 0 ? (
          <p className="text-xs text-slate-500">
            暂无公告摘要：该股可能尚未被语料收录，订阅后数据将在几分钟内陆续入库。
          </p>
        ) : (
          profile.latestAnnouncements.map((a) => (
            <div key={a.annId} className="rounded-lg bg-slate-900/70 px-3 py-2 space-y-1">
              <div className="text-xs text-slate-400">
                <span className="font-mono text-slate-500">({a.annDate})</span>{' '}
                <span className="font-medium text-slate-300">{a.title}</span>
              </div>
              <p className="text-xs leading-relaxed text-slate-400">{a.summary}</p>
            </div>
          ))
        )}
      </div>

      {/* 区块二：财联社提及（P2 数据，clsMention=null 时隐藏） */}
      {profile.clsMention && profile.clsMention.items.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-slate-500">
            【财联社提及】（近 7 天 {profile.clsMention.count7d} 次）
          </div>
          {profile.clsMention.items.slice(0, 3).map((item, i) => (
            <div key={i} className="rounded-lg bg-slate-900/70 px-3 py-2">
              <div className="text-xs font-mono text-slate-500">{item.publishedAt}</div>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-400">{item.summary}</p>
            </div>
          ))}
        </div>
      )}

      {/* 操作区：订阅 + 追问 AI（D2：无其他动作） */}
      <div className="flex items-center justify-end gap-2 border-t border-slate-800 pt-2">
        <AnnouncementSubscribeButton fullCode={profile.stockId} />
        <BlockFocusButton
          scopeId={SEARCH_SCOPE_ID}
          blockId={SEARCH_SCOPE_ID + ':profile'}
          title="唤醒 AI 深入追问该股"
        />
      </div>
    </div>
  );
}
