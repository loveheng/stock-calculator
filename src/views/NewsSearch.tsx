/**
 * @file NewsSearch.tsx
 * @description 资讯搜索页（一级菜单「资讯」，route /news）：search-first 落地页。
 *              组装搜索框（普通受控 input，自由文本提交；6 位码/名称消歧由 slice
 *              形态检测承担）+ 意图分流 Tabs + 日期预设 chips + 预置提问模板 +
 *              结果流（档案卡 / 结果卡片列表 / AI 综合摘要面板）+ Copilot 页面上下文注册
 *              （scopeId=news_search，结果卡 blockId=news_search:result:{resultId}）。
 *              结果状态全部落 searchSlice（D5/R2），本视图只持有表单草稿等纯 UI 态（I3）。
 * @layer View
 * @storage_impact 无直接持久化读写；检索走 store action（searchSlice → searchService）。
 * @author 开发团队
 */

import { useMemo, useState } from 'react';
import { LogIn, Search } from 'lucide-react';
import { useAppStore } from '../store';
import { useAuthStore } from '../store/useAuthStore';
import { usePageContext } from '../hooks/usePageContext';
import {
  buildBlockContext,
  buildProfileContext,
  buildSearchContext,
} from '../utils/searchCopilot';
import { presetDateRange } from '../utils/searchPrompts';
import type {
  DatePreset,
  RunSearchInput,
  SearchPromptTemplate,
  SearchResultItem,
  SearchScope,
} from '../types/search';
import IntentFilterTabs from '../components/search/IntentFilterTabs';
import PromptTemplates from '../components/search/PromptTemplates';
import StockProfileCard from '../components/search/StockProfileCard';
import ResultCardList from '../components/search/ResultCardList';
import CompositeResultPanel from '../components/search/CompositeResultPanel';

const SEARCH_SCOPE_ID = 'news_search';

const SCOPE_LABEL: Record<SearchScope, string> = {
  announcement: '持仓公告',
  cls: '财联社电报',
  composite: 'AI 智能综合',
};

/** 日期预设 chips（「自定义」范围延后，spec F1 P2） */
const DATE_PRESETS: Array<{ preset: DatePreset; label: string }> = [
  { preset: 'all', label: '全部' },
  { preset: '7d', label: '近 7 天' },
  { preset: '30d', label: '近 30 天' },
];

/** Copilot 区块标题（注册签名的一部分，随结果集热更新） */
function blockTitleOf(r: SearchResultItem): string {
  if (r.kind === 'announcement') {
    return r.stockId + ' ' + r.stockName + ' · ' + r.annDate + ' 公告';
  }
  return '财联社电报 · ' + r.publishedAt;
}

/** 检索中骨架屏（3 张卡片占位，spec §4.1） */
function SearchSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="card animate-pulse space-y-2 !mb-0">
          <div className="h-4 w-1/3 rounded bg-slate-800" />
          <div className="h-3 w-full rounded bg-slate-800" />
          <div className="h-3 w-5/6 rounded bg-slate-800" />
        </div>
      ))}
    </div>
  );
}

export default function NewsSearch() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setAuthModalOpen = useAuthStore((s) => s.setAuthModalOpen);

  const status = useAppStore((s) => s.searchStatus);
  const results = useAppStore((s) => s.searchResults);
  const compositeResult = useAppStore((s) => s.compositeResult);
  const stockProfile = useAppStore((s) => s.stockProfile);
  const searchError = useAppStore((s) => s.searchError);
  const searchTotal = useAppStore((s) => s.searchTotal);
  const retryAfterSeconds = useAppStore((s) => s.retryAfterSeconds);
  const positions = useAppStore((s) => s.positions);
  const runSearch = useAppStore((s) => s.runSearch);
  const resetSearch = useAppStore((s) => s.resetSearch);

  // 表单态（I3：纯 UI 态留视图 useState；结果态一律在 searchSlice）
  const [draft, setDraft] = useState('');
  const [scope, setScope] = useState<SearchScope>('announcement');
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  /** 最近一次实际执行的查询（驱动「筛选已变化」提示）；preset=null = 模板自带 dateRange，不参与预设对比 */
  const [lastRun, setLastRun] = useState<{ input: RunSearchInput; preset: DatePreset | null } | null>(null);

  const hasHoldings = positions.some((p) => !p.isClosed);
  const generating = status === 'generating';

  function buildInput(q: string, sc: SearchScope, preset: DatePreset): RunSearchInput {
    return {
      query: q,
      scope: sc,
      ...(preset === 'all' ? {} : { dateRange: presetDateRange(preset, new Date()) }),
    };
  }

  /** 表单路径执行（日期预设参与陈旧对比） */
  function executeForm(q: string) {
    const input = buildInput(q, scope, datePreset);
    setLastRun({ input, preset: datePreset });
    void runSearch(input);
  }

  function handleSubmit() {
    const q = draft.trim();
    if (!q) {
      setLastRun(null);
      resetSearch();
      return;
    }
    executeForm(q);
  }

  function handlePickTemplate(t: SearchPromptTemplate) {
    const req = t.buildRequest({ today: new Date() });
    setDraft(req.query);
    setScope(req.scope);
    setLastRun({ input: req, preset: null }); // 模板自带 dateRange，不参与预设对比
    void runSearch(req);
  }

  /** CLS 提及 chip / 档案卡联动：以该股票发起查询（等价档案卡查询路径） */
  function handleSelectStock(stockId: string) {
    setDraft(stockId);
    executeForm(stockId);
  }

  // scope 切换不自动重搜（spec F1）：筛选与上次执行不一致时提示手动重查
  const stale =
    lastRun !== null &&
    status === 'succeeded' &&
    (draft.trim() !== lastRun.input.query ||
      scope !== lastRun.input.scope ||
      (lastRun.preset !== null && lastRun.preset !== datePreset));

  // ── Copilot 页面上下文注册（D5/I5）：getData 经 getState() 同源读取，禁闭包取数 ──
  usePageContext(
    useMemo(() => {
      const blocks = [
        ...(stockProfile
          ? [
              {
                blockId: SEARCH_SCOPE_ID + ':profile',
                title: (stockProfile.stockName || stockProfile.stockId) + ' · 档案卡',
                suggestedPrompts: [
                  '这只股票近期有哪些风险信号？',
                  '最新公告对股价可能有什么影响？',
                  '它最近被财联社电报提及过吗？',
                ],
                getData: () => buildProfileContext(useAppStore.getState()),
              },
            ]
          : []),
        ...results.map((r) => ({
          blockId: SEARCH_SCOPE_ID + ':result:' + r.resultId,
          title: blockTitleOf(r),
          suggestedPrompts: [
            '这条公告对股价有什么影响？',
            '帮我梳理这条快讯的时间线',
            '这和我持仓里哪只股票相关？',
          ],
          getData: () => buildBlockContext(useAppStore.getState(), r.resultId),
        })),
      ];
      return {
        scopeId: SEARCH_SCOPE_ID,
        title: '资讯搜索',
        getData: () => buildSearchContext(useAppStore.getState()),
        blocks,
      };
    }, [results, stockProfile]),
  );

  /** 列表头：匹配条数 + 所用范围（列表形态专属；composite/纯档案卡形态不展示） */
  function scopeNote() {
    const executedScope = lastRun?.input.scope ?? 'announcement';
    if (executedScope === 'composite' || results.length === 0) return null;
    return (
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span>
          📄 匹配到 {searchTotal} 条{executedScope === 'announcement' ? '相关公告摘要' : '电报'}
        </span>
        <span className="text-slate-600">（范围：{SCOPE_LABEL[executedScope]}）</span>
      </div>
    );
  }

  // ── 未登录门控（A7）：引导登录空态，打开既有 AuthModal ──
  if (!isAuthenticated) {
    return (
      <div className="card mx-auto max-w-md space-y-4 p-8 text-center">
        <Search className="mx-auto h-10 w-10 text-slate-600" />
        <div className="space-y-1">
          <h3 className="text-base font-semibold text-slate-200">登录后可检索公告与快讯</h3>
          <p className="text-xs leading-relaxed text-slate-500">
            支持持仓公告检索、财联社电报检索与 AI 综合摘要；
            持仓数据不出本机，仅上送 6 位股票代码作为过滤参数。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAuthModalOpen(true)}
          className="tap-target mx-auto flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
        >
          <LogIn className="h-4 w-4" />
          去登录
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 搜索框 + 预置模板（D8 三不原则：永不弹空白 Chat） */}
      <div className="card space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSubmit();
              }}
              placeholder="输入股票代码、名称或事件关键词…（例如：600745 / 闻泰科技 / 对赌）"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 py-2.5 pl-9 pr-3 text-sm text-slate-200 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
              aria-label="搜索股票代码、名称或事件关键词"
            />
          </div>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={status === 'loading' || generating}
            className="tap-target flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            搜索
          </button>
        </div>

        <IntentFilterTabs scope={scope} onChange={setScope} />

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-600">日期</span>
          {DATE_PRESETS.map(({ preset, label }) => (
            <button
              key={preset}
              type="button"
              onClick={() => setDatePreset(preset)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                preset === datePreset
                  ? 'bg-slate-700 text-slate-100'
                  : 'bg-slate-800/50 text-slate-500 hover:text-slate-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {stale && (
          <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            筛选条件已变化，点击「搜索」重新查询
          </div>
        )}

        {status === 'idle' && (
          <div className="border-t border-slate-800 pt-3">
            <PromptTemplates hasHoldings={hasHoldings} onPick={handlePickTemplate} />
          </div>
        )}
      </div>

      {/* 状态区：失败 / 生成中 / 骨架屏 / 结果 / 空态 */}
      {status === 'failed' && (
        <div className="card space-y-2 border-red-500/20 !mb-0">
          <p className="text-sm text-red-400">{searchError ?? '检索失败，请稍后重试'}</p>
          {retryAfterSeconds != null && (
            <p className="text-xs text-amber-300">请求过于频繁，请 {retryAfterSeconds} 秒后重试</p>
          )}
          <button
            type="button"
            onClick={handleSubmit}
            className="tap-target rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-blue-500/60 hover:text-blue-300"
          >
            重试
          </button>
        </div>
      )}

      {status === 'loading' && <SearchSkeleton />}

      {generating && <CompositeResultPanel result={compositeResult} generating />}

      {status === 'succeeded' && (
        <>
          {stockProfile && <StockProfileCard profile={stockProfile} />}

          {compositeResult && !generating && (
            <CompositeResultPanel result={compositeResult} generating={false} />
          )}

          {scopeNote()}

          {results.length > 0 ? (
            <ResultCardList items={results} query={lastRun?.input.query ?? ''} onSelectStock={handleSelectStock} />
          ) : (
            !compositeResult && !stockProfile && (
              <div className="card space-y-2 text-center !mb-0">
                <p className="text-sm text-slate-400">未找到相关内容</p>
                <p className="text-xs leading-relaxed text-slate-500">
                  {scope === 'announcement'
                    ? '公告语料按订阅标的采集：若该股尚未被订阅，可能暂未收录——可先订阅该股，数据将在几分钟内陆续入库。'
                    : '换个关键词，或切换检索范围 / 日期范围试试。'}
                </p>
                <div className="pt-1">
                  <PromptTemplates hasHoldings={hasHoldings} onPick={handlePickTemplate} />
                </div>
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}
