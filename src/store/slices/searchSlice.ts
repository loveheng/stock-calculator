/**
 * @file searchSlice.ts
 * @description 资讯搜索切片：搜索页状态机与查询编排。runSearch 内部完成——
 *              形态检测（6 位码直判 / 名称消歧严格全等，失败静默降级关键词）、
 *              股票档案卡装载（400 时按 A10 降级为该码关键词检索且不注入持仓过滤）、
 *              持仓注入（announcement 范围取未平仓持仓 6 位码，去重 ≤50，为空短路引导）、
 *              composite 流式回调接入（meta 引用先上屏 + delta 渐进拼接）、
 *              seq 竞态守卫（响应/流式回调序号过期即丢弃，SSE 流经 isCancelled 主动断开）。
 *              结果状态一律落本切片（D5/R2：Copilot 快照经 getState() 同源读取）；
 *              检索历史不持久化，刷新即回初始态（spec §4.2）。
 * @layer Store (Slice)
 * @storage_impact 内存态，不持久化。
 * @author 开发团队
 */

import type { StateCreator } from 'zustand';
import type { AppStore } from '../types';
import {
  extractRetryAfterSeconds,
  fetchStockProfile,
  searchAnnouncements,
  searchCls,
  searchCompositeStream,
} from '../../services/searchService';
import { AuthApiError } from '../../services/apiClient';
import { searchStocks } from '../../services/stockService';
import { loadStoredAuthSession } from '../../services/authSession';
import { useAuthStore } from '../useAuthStore';
import { toStockId } from '../../utils/dedup';
import { detectQueryIntent, matchStockDisambiguation } from '../../utils/searchPrompts';
import type {
  CompositeResult,
  RunSearchInput,
  SearchRequest,
  SearchResultItem,
  SearchScope,
  SearchStatus,
  StockProfile,
} from '../../types/search';

/** 后端 stockCodes 校验上限（接口文档 §2：去重后 ≤ 50），超出前端先行截断 */
const STOCK_CODES_LIMIT = 50;

/** 会话令牌：未登录 / 无本地会话返回 null（调用方给用户可读文案，不发请求） */
function currentToken(): string | null {
  if (!useAuthStore.getState().isAuthenticated) return null;
  return loadStoredAuthSession()?.token ?? null;
}

/** 未平仓持仓 → 6 位码集合（去重 + 截断；全程读 store 内存状态，不读 db） */
function collectHoldingCodes(positions: AppStore['positions']): string[] {
  const codes = positions
    .filter((p) => !p.isClosed)
    .map((p) => toStockId(p.fullCode ?? ''))
    .filter((c): c is string => !!c);
  return Array.from(new Set(codes)).slice(0, STOCK_CODES_LIMIT);
}

export type SearchSlice = Pick<AppStore, 'runSearch' | 'resetSearch'>;

/** 模块级请求序号（N5 竞态守卫）：新查询自增，旧响应/流式回调按序号作废 */
let requestSeq = 0;

export const createSearchSlice: StateCreator<AppStore, [], [], SearchSlice> = (set, get) => ({
  resetSearch: () => {
    requestSeq++; // 进行中的检索/流式一并作废
    set({
      searchQuery: '',
      searchScope: 'announcement',
      searchStatus: 'idle',
      searchResults: [],
      compositeResult: null,
      stockProfile: null,
      searchError: null,
      searchTotal: 0,
      retryAfterSeconds: null,
    });
  },

  runSearch: async (input) => {
    const query = String(input.query ?? '').trim();
    if (!query) {
      get().resetSearch();
      return;
    }
    const token = currentToken();
    if (!token) {
      // 防御性检查（门控主判断在视图）：未登录不发请求
      set({
        searchQuery: query,
        searchScope: input.scope,
        searchStatus: 'failed',
        searchResults: [],
        compositeResult: null,
        stockProfile: null,
        searchError: '请先登录后再检索资讯',
        searchTotal: 0,
        retryAfterSeconds: null,
      });
      return;
    }

    const seq = ++requestSeq;
    const isCancelled = () => seq !== requestSeq;
    const generating = input.scope === 'composite';
    set({
      searchQuery: query,
      searchScope: input.scope,
      searchStatus: generating ? 'generating' : 'loading',
      searchResults: [],
      compositeResult: null,
      stockProfile: null,
      searchError: null,
      searchTotal: 0,
      retryAfterSeconds: null,
    });

    // ── 形态检测：6 位码直判；其余经 Smartbox 消歧严格全等，失败静默降级关键词 ──
    let stockId: string | null = null;
    const intent = detectQueryIntent(query);
    if (intent.kind === 'stock') {
      stockId = intent.stockId;
    } else {
      try {
        const candidates = await searchStocks(query);
        if (isCancelled()) return;
        stockId = matchStockDisambiguation(query, candidates);
      } catch {
        // 消歧通道不可用：静默按关键词检索
      }
    }

    // ── 股票形态：先装档案卡（卡片早于结果列表上屏）；400（未知股票，A10）降级为该码关键词检索 ──
    let profile: StockProfile | null = null;
    let degradeToKeyword = false;
    if (stockId) {
      try {
        profile = await fetchStockProfile(token, stockId);
        if (isCancelled()) return;
      } catch (e) {
        if (isCancelled()) return;
        if (e instanceof AuthApiError && e.code === 400) {
          degradeToKeyword = true; // skipHoldingsFilter：不注入持仓/单票过滤，避免目标股被滤空
        }
        // 其他错误（网络等）：档案卡缺席不阻塞检索，股票过滤语义保留
      }
      if (profile) set({ stockProfile: profile });
    }

    // ── 构造检索请求（scope 决定端点；stockCodes 注入规则见各分支） ──
    const scope: SearchScope = input.scope;
    let req: SearchRequest;
    if (stockId && !degradeToKeyword) {
      // 股票形态：单票硬过滤（cls 端点无 stockCodes 参数，仅传词）
      req = scope === 'cls' ? { query: stockId } : { query: stockId, stockCodes: [stockId] };
    } else if (degradeToKeyword) {
      // A10 降级：未知 6 位码作普通关键词，不注入任何股票过滤
      req = { query };
    } else if (scope === 'announcement') {
      const holdings = collectHoldingCodes(get().positions);
      if (holdings.length === 0) {
        // spec F1：无进行中持仓 → 引导空态，不发请求
        set({
          searchStatus: 'failed',
          searchError: '当前没有进行中的持仓：请先在「中长期交易」录入持仓，或直接输入股票代码查询单票公告',
        });
        return;
      }
      req = { query, stockCodes: holdings };
    } else {
      req = { query };
    }

    // ── 分发检索（异常统一：SessionExpiredError 文案直出；429 提取倒计时秒数） ──
    try {
      if (scope === 'composite') {
        const result = await searchCompositeStream(token, req, {
          onMeta: (citations) => {
            if (isCancelled()) return;
            const prev = get().compositeResult;
            set({ compositeResult: { summary: prev?.summary ?? '', citations } });
          },
          onDelta: (text) => {
            if (isCancelled()) return;
            const prev = get().compositeResult;
            set({
              compositeResult: {
                summary: (prev?.summary ?? '') + text,
                citations: prev?.citations ?? [],
              },
            });
          },
          isCancelled,
        });
        if (isCancelled() || result === null) return;
        const finalResult: CompositeResult = result;
        set({
          compositeResult: finalResult,
          searchTotal: finalResult.citations.length,
          searchStatus: 'succeeded',
        });
        return;
      }

      const data =
        scope === 'cls'
          ? await searchCls(token, req)
          : await searchAnnouncements(token, req);
      if (isCancelled()) return;
      const items: SearchResultItem[] = data.items;
      set({ searchResults: items, searchTotal: data.total, searchStatus: 'succeeded' });
    } catch (e) {
      if (isCancelled()) return;
      const retryAfter =
        e instanceof AuthApiError && e.code === 429 ? extractRetryAfterSeconds(e.data) : null;
      set({
        searchStatus: 'failed',
        searchError: e instanceof Error ? e.message : '检索失败，请稍后重试',
        retryAfterSeconds: retryAfter,
      });
    }
  },
});

// 状态字段初值在 store/index.ts 组装层声明（SearchStatus 等类型见 types/search.ts）
export type { SearchStatus };
