/**
 * @file KgPanel.tsx
 * @description 新闻联播图谱主面板（资讯页「图谱」模式容器）：kg 搜索框（suggest 防抖 300ms
 *              下拉，选中 = entityId 检索，回车 = keyword 检索）+ 默认态实体热榜 chips +
 *              搜索态命中实体 chips（点开展开详情摘要卡，共现 chips 漫游）+ 时间轴卡片流
 *              （store 状态机 + 无限滑动续拉）+ 事件详情抽屉。时间轴主流转落 kgSlice（D5/R2）；
 *              suggest/热榜/实体详情为一次性读，直调 kgService（I3：纯 UI 态留组件）。
 *              取数契约见《kg 时间轴查询 API · 前端对接文档》§六交互落点。
 * @layer UI
 * @storage_impact 无直接持久化读写；时间轴检索走 store action（kgSlice → kgService）。
 * @author 开发团队
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Flame, Loader2, Network, Search } from 'lucide-react';
import { useAppStore } from '../../store';
import { useAuthStore } from '../../store/useAuthStore';
import { loadStoredAuthSession } from '../../services/authSession';
import {
  fetchKgEntityDetail,
  fetchKgEntitySuggest,
  fetchKgHotEntities,
} from '../../services/kgService';
import { KG_HOT_LIMIT, KG_SUGGEST_LIMIT } from '../../store/slices/kgSlice';
import { buildKgHighlightTerms } from '../../utils/kgText';
import type {
  KgEntityDetail,
  KgEntitySuggest,
  KgTimelineDay,
  KgTimelineEvent,
} from '../../types/kg';
import { KgEntityChip, KgTypeBadge } from './KgShared';
import KgTimeline from './KgTimeline';
import KgEntityCard from './KgEntityCard';
import KgEventDrawer from './KgEventDrawer';

/** 会话令牌（未登录返回 null；登录门控主判断在 NewsSearch 视图，此处防御） */
function currentToken(): string | null {
  if (!useAuthStore.getState().isAuthenticated) return null;
  return loadStoredAuthSession()?.token ?? null;
}

/** 时间轴加载骨架屏（2 个日组占位） */
function KgSkeleton() {
  return (
    <div className="space-y-4">
      {[0, 1].map((i) => (
        <div key={i} className="space-y-2">
          <div className="h-6 w-2/3 animate-pulse rounded bg-slate-800" />
          <div className="card animate-pulse space-y-2 !mb-0">
            <div className="h-4 w-1/2 rounded bg-slate-800" />
            <div className="h-3 w-full rounded bg-slate-800" />
            <div className="h-3 w-5/6 rounded bg-slate-800" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function KgPanel() {
  // ── store 状态（时间轴主流转，D5） ──
  const kgStatus = useAppStore((s) => s.kgStatus);
  const kgError = useAppStore((s) => s.kgError);
  const kgDays = useAppStore((s) => s.kgDays);
  const kgHasMore = useAppStore((s) => s.kgHasMore);
  const kgLoadingMore = useAppStore((s) => s.kgLoadingMore);
  const kgMatchedEntities = useAppStore((s) => s.kgMatchedEntities);
  const kgTotalDays = useAppStore((s) => s.kgTotalDays);
  const kgKeyword = useAppStore((s) => s.kgKeyword);
  const kgEntityId = useAppStore((s) => s.kgEntityId);
  const kgEntityName = useAppStore((s) => s.kgEntityName);
  const runKgTimeline = useAppStore((s) => s.runKgTimeline);
  const loadMoreKgTimeline = useAppStore((s) => s.loadMoreKgTimeline);
  const resetKgTimeline = useAppStore((s) => s.resetKgTimeline);

  // ── 纯 UI 态（I3）：搜索草稿 / suggest / 热榜 / 实体详情卡 / 事件抽屉 ──
  const [draft, setDraft] = useState('');
  const [suggests, setSuggests] = useState<KgEntitySuggest[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const suggestSeqRef = useRef(0);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [hot, setHot] = useState<KgEntitySuggest[]>([]);
  const [hotState, setHotState] = useState<'loading' | 'ok' | 'failed'>('loading');

  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<KgEntityDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [drawer, setDrawer] = useState<{ event: KgTimelineEvent; day: KgTimelineDay | null } | null>(null);

  const isSearchState = kgKeyword !== null || kgEntityId !== null;

  /** 命中词高亮词集：keyword 分词 + 实体名 + matched 实体名（接口文档 §六，前端本地高亮） */
  const terms = useMemo(
    () =>
      buildKgHighlightTerms({
        keyword: kgKeyword,
        entityName: kgEntityName,
        matchedNames: kgMatchedEntities.map((m) => m.name),
      }),
    [kgKeyword, kgEntityName, kgMatchedEntities],
  );

  // ── 挂载：默认态首拉 + 热榜一次取数（失败静默降级为隐藏区块；接口文档 §六空态） ──
  useEffect(() => {
    if (useAppStore.getState().kgStatus === 'idle') void runKgTimeline({});
    let cancelled = false;
    const token = currentToken();
    if (!token) {
      setHotState('failed');
      return;
    }
    setHotState('loading');
    fetchKgHotEntities(token, KG_HOT_LIMIT)
      .then((list) => {
        if (cancelled) return;
        setHot(list);
        setHotState('ok');
      })
      .catch(() => {
        if (!cancelled) setHotState('failed'); // 热榜缺席不阻塞时间轴
      });
    return () => {
      cancelled = true;
    };
    // 仅挂载执行一次（runKgTimeline 引用稳定）；切回 Tab 时 kgStatus 已非 idle 不重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── suggest 防抖 300ms（接口文档 §三：≥1 字符再发；seq 守卫竞态） ──
  useEffect(() => {
    return () => {
      if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    };
  }, []);

  function onDraftChange(value: string) {
    setDraft(value);
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    const kw = value.trim();
    if (!kw) {
      suggestSeqRef.current++;
      setSuggests([]);
      setSuggestOpen(false);
      return;
    }
    const seq = ++suggestSeqRef.current;
    suggestTimerRef.current = setTimeout(async () => {
      const token = currentToken();
      if (!token) return;
      try {
        const list = await fetchKgEntitySuggest(token, kw, KG_SUGGEST_LIMIT);
        if (seq !== suggestSeqRef.current) return;
        setSuggests(list);
        setSuggestOpen(list.length > 0);
      } catch {
        // 建议通道不可用：静默降级为纯 keyword 检索
      }
    }, 300);
  }

  /** 清空 suggest 与实体详情卡（发起新检索前的公共收尾） */
  function resetTransient() {
    suggestSeqRef.current++;
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    setSuggests([]);
    setSuggestOpen(false);
    setDetailId(null);
    setDetail(null);
    setDetailError(null);
  }

  /** 实体检索（suggest/热榜/事件卡 chips/共现漫游统一入口） */
  function searchByEntity(id: number, name: string) {
    resetTransient();
    setDraft(name);
    void runKgTimeline({ entityId: id, entityName: name });
  }

  /** 共现实体漫游：检索 + 同时打开该实体详情卡 */
  function roamToEntity(id: number, name: string) {
    searchByEntity(id, name);
    setDetailId(id);
  }

  /** keyword 检索（回车/搜索按钮）；空词 = 清过滤回默认态 */
  function submitKeyword() {
    const q = draft.trim();
    resetTransient();
    if (!q) {
      resetKgTimeline();
      return;
    }
    void runKgTimeline({ keyword: q });
  }

  /** 回默认态（清除过滤按钮） */
  function backToDefault() {
    resetTransient();
    setDraft('');
    void runKgTimeline({});
  }

  /** matched 实体 chip 点击：展开/收起详情摘要卡 */
  function toggleDetail(id: number) {
    if (detailId === id) {
      setDetailId(null);
      setDetail(null);
      setDetailError(null);
    } else {
      setDetailId(id);
    }
  }

  // ── 实体详情摘要卡取数（detailId 驱动；404/网络失败降级为卡内错误文案） ──
  useEffect(() => {
    if (detailId === null) return;
    let cancelled = false;
    const token = currentToken();
    if (!token) return;
    setDetailLoading(true);
    setDetailError(null);
    fetchKgEntityDetail(token, detailId)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setDetailLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setDetail(null);
        setDetailError(e instanceof Error ? e.message : '实体详情加载失败');
        setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detailId]);

  // ── 无限滑动续拉：哨兵进入视口即续拉（镜像 NewsSearch；依赖 hasMore/loadingMore 重新武装） ──
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !kgHasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMoreKgTimeline();
      },
      { rootMargin: '240px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMoreKgTimeline, kgHasMore, kgLoadingMore]);

  return (
    <div className="space-y-4">
      {/* 搜索框 + suggest 下拉（防抖建议：选中 = entityId 检索；回车 = keyword 检索） */}
      <div className="card space-y-3">
        <div className="relative flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitKeyword();
              }}
              onFocus={() => {
                if (suggests.length > 0) setSuggestOpen(true);
              }}
              onBlur={() => setSuggestOpen(false)}
              placeholder="搜索实体、事件关键词…（例如：杭州亚运会 / 一带一路）"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 py-2.5 pl-9 pr-3 text-sm text-slate-200 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
              aria-label="搜索图谱实体或事件关键词"
            />
          </div>
          <button
            type="button"
            onClick={submitKeyword}
            disabled={kgStatus === 'loading'}
            className="tap-target flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            搜索
          </button>
          {suggestOpen && suggests.length > 0 && (
            <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-xl">
              {suggests.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  // onMouseDown 抢在输入框 blur 前触发，避免下拉先收起导致点击丢失
                  onMouseDown={() => searchByEntity(s.id, s.name)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-300 transition-colors hover:bg-slate-800"
                >
                  <KgTypeBadge type={s.entityType} />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <span className="flex-shrink-0 text-[10px] text-slate-600">{s.mentionCount} 次</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 当前过滤上下文 + 清除（搜索态） */}
        {isSearchState && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="min-w-0 flex-1 truncate">
              {kgEntityId !== null
                ? '按实体过滤：' + (kgEntityName ?? '实体 #' + kgEntityId)
                : '关键词：' + (kgKeyword ?? '')}
              {kgTotalDays > 0 ? ' · 命中 ' + kgTotalDays + ' 天' : ''}
            </span>
            <button
              type="button"
              onClick={backToDefault}
              className="tap-target flex-shrink-0 rounded-full bg-slate-800/50 px-2.5 py-1 text-[11px] text-slate-500 transition-colors hover:text-slate-300"
            >
              清除过滤
            </button>
          </div>
        )}
      </div>

      {/* keyword 搜索态命中实体 chips（点开展开摘要卡；接口文档 §六搜索态置顶卡） */}
      {isSearchState && kgKeyword !== null && kgMatchedEntities.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="flex-shrink-0 text-[11px] text-slate-600">命中实体</span>
          {kgMatchedEntities.map((m) => (
            <KgEntityChip key={m.id} entity={m} count={m.mentionCount} onSelect={() => toggleDetail(m.id)} />
          ))}
        </div>
      )}

      {/* 实体详情摘要卡（matched chips 展开 / 共现漫游共用槽位） */}
      {detailId !== null && (
        <KgEntityCard
          detail={detail}
          loading={detailLoading}
          error={detailError}
          onClose={() => {
            setDetailId(null);
            setDetail(null);
            setDetailError(null);
          }}
          onSelectEntity={(e) => roamToEntity(e.id, e.name)}
          onSelectAlias={(alias) => {
            resetTransient();
            setDraft(alias);
            void runKgTimeline({ keyword: alias });
          }}
        />
      )}

      {/* 默认态：实体热榜 chips（点击 = entityId 检索；拉取失败整块隐藏） */}
      {!isSearchState && hotState !== 'failed' && hot.length > 0 && (
        <div className="card space-y-2 !mb-0">
          <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <Flame className="h-3 w-3 text-amber-400" />
            实体热榜
          </div>
          <div className="flex flex-wrap gap-1.5">
            {hot.map((h) => (
              <KgEntityChip key={h.id} entity={h} count={h.mentionCount} onSelect={(e) => searchByEntity(e.id, e.name)} />
            ))}
          </div>
        </div>
      )}

      {/* 状态区：失败 / 骨架屏 / 时间轴 / 空态 */}
      {kgStatus === 'failed' && (
        <div className="card space-y-2 border-red-500/20 !mb-0">
          <p className="text-sm text-red-400">{kgError ?? '时间轴加载失败，请稍后重试'}</p>
          <button
            type="button"
            onClick={() =>
              void runKgTimeline({
                ...(kgKeyword ? { keyword: kgKeyword } : {}),
                ...(kgEntityId !== null ? { entityId: kgEntityId, entityName: kgEntityName ?? undefined } : {}),
              })
            }
            className="tap-target rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-blue-500/60 hover:text-blue-300"
          >
            重试
          </button>
        </div>
      )}

      {kgStatus === 'loading' && <KgSkeleton />}

      {kgStatus === 'succeeded' && kgDays.length > 0 && (
        <>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Network className="h-3.5 w-3.5 flex-shrink-0 text-slate-600" />
            <span>
              已加载 {kgDays.length} / {kgTotalDays} 天{kgHasMore ? '，下滑继续加载' : ''}
            </span>
          </div>
          <KgTimeline
            days={kgDays}
            terms={terms}
            onOpenEvent={(event, day) => setDrawer({ event, day })}
            onSelectEntity={(e) => searchByEntity(e.id, e.name)}
          />
          {kgHasMore ? (
            <div ref={sentinelRef} className="flex justify-center py-1">
              {kgLoadingMore ? (
                <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
              ) : (
                <button
                  type="button"
                  onClick={() => void loadMoreKgTimeline()}
                  className="tap-target rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-blue-500/60 hover:text-blue-300"
                >
                  加载更多
                </button>
              )}
            </div>
          ) : (
            <p className="text-center text-xs text-slate-600">已到底部</p>
          )}
        </>
      )}

      {kgStatus === 'succeeded' && kgDays.length === 0 && (
        <div className="card space-y-2 text-center !mb-0">
          <p className="text-sm text-slate-400">{isSearchState ? '未找到相关事件' : '时间轴暂无数据'}</p>
          <p className="text-xs leading-relaxed text-slate-500">
            {isSearchState
              ? '换个关键词，或从命中实体 / 热榜 chips 选择实体检索。'
              : '事件数据正在持续抽取入库，可稍后再来看看。'}
          </p>
        </div>
      )}

      {/* 事件详情抽屉（detail 全文 + 溯源脚注） */}
      {drawer && (
        <KgEventDrawer
          event={drawer.event}
          day={drawer.day}
          terms={terms}
          onClose={() => setDrawer(null)}
          onSelectEntity={(e) => {
            setDrawer(null);
            searchByEntity(e.id, e.name);
          }}
        />
      )}
    </div>
  );
}
