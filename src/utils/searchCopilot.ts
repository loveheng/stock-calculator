/**
 * @file searchCopilot.ts
 * @description 资讯搜索 Copilot 上下文纯函数：整页快照（buildSearchContext）、
 *              单结果区块快照（buildBlockContext）、档案卡区块快照（buildProfileContext）。
 *              入参为结构化最小状态切面（SearchCopilotState）——视图层传
 *              useAppStore.getState()（结构兼容），本模块严禁 import store（R2 护栏），
 *              严禁闭包捕获视图局部变量（快照只在提问时被显式执行，须同源读 store）。
 * @layer Utils
 * @storage_impact 纯计算，无存储。
 * @author 开发团队
 */

import type { CopilotContextData } from '../types/domain';
import type {
  AnnouncementHit,
  ClsHit,
  CompositeResult,
  SearchScope,
  SearchResultItem,
  StockProfile,
} from '../types/search';

/** 搜索页 Copilot 上下文所需的最小状态切面（AppStore 的结构子集） */
export interface SearchCopilotState {
  searchQuery: string;
  searchScope: SearchScope;
  searchStatus: 'idle' | 'loading' | 'succeeded' | 'failed' | 'generating';
  searchResults: SearchResultItem[];
  compositeResult: CompositeResult | null;
  stockProfile: StockProfile | null;
  searchTotal: number;
}

/** 明细字段截断上限（字符）：快照经 applySizeGuard ≤12KB 兜底，此处先做行级收敛 */
const DETAIL_CLIP = 600;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function clip(text: string, max = DETAIL_CLIP): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** 单位字典（歧义字段口径声明） */
function baseUnits(): Record<string, string> {
  return {
    annDate: 'YYYY-MM-DD（公告发布日）',
    publishedAt: 'YYYY-MM-DD HH:mm（快讯发布时间）',
    count7d: '次（近 7 天提及次数）',
  };
}

function timeAnchor(): CopilotContextData['timeAnchor'] {
  return { asOf: nowSec(), range: 'all' };
}

function emptyExistsFalse(resultId?: string): CopilotContextData {
  return {
    overview: { exists: false, ...(resultId ? { resultId } : {}) },
    timeAnchor: timeAnchor(),
    detail: {},
    units: baseUnits(),
  };
}

/** 公告/快讯命中统一收敛为扁平行（明细数组行数收敛：整页快照最多取 8 条） */
function resultRow(r: SearchResultItem): Record<string, unknown> {
  if (r.kind === 'announcement') {
    return {
      kind: 'announcement',
      resultId: r.resultId,
      stockId: r.stockId,
      stockName: r.stockName,
      annDate: r.annDate,
      title: r.title,
      summary: clip(r.summary, 240),
      sourceUrl: r.sourceUrl ?? '',
    };
  }
  return {
    kind: 'cls',
    resultId: r.resultId,
    publishedAt: r.publishedAt,
    edition: r.edition,
    title: r.title ?? '',
    summary: clip(r.summary, 240),
    mentions: r.mentions.map((m) => m.stockId + ' ' + m.stockName),
  };
}

/**
 * 整页上下文：当前查询/范围/状态 + 结果行收敛列表 + 档案卡与综合摘要概览。
 * overview 仅落库标量（≤255 字符），严禁塞明细数组。
 */
export function buildSearchContext(state: SearchCopilotState): CopilotContextData {
  const results = state.searchResults ?? [];
  const overview: Record<string, string | number | boolean> = {
    query: clip(state.searchQuery ?? '', 60),
    scope: state.searchScope ?? 'announcement',
    status: state.searchStatus ?? 'idle',
    resultCount: results.length,
  };
  if (state.stockProfile) {
    overview.profileStock = state.stockProfile.stockId + ' ' + (state.stockProfile.stockName || '');
  }
  if (state.compositeResult) {
    overview.compositeCitations = state.compositeResult.citations.length;
  }

  const detail: Record<string, unknown> = {
    results: results.slice(0, 8).map(resultRow),
    resultsOmitted: Math.max(0, results.length - 8),
    profile: state.stockProfile ? profileDetail(state.stockProfile) : null,
    composite: state.compositeResult
      ? {
          summary: clip(state.compositeResult.summary),
          citations: state.compositeResult.citations,
        }
      : null,
  };

  return { overview, timeAnchor: timeAnchor(), detail, units: baseUnits() };
}

/**
 * 单结果区块上下文：按 resultId 从 searchSlice 同源取该条命中，
 * 输出摘要全文（2~3 句，不做长文）+ 确定性元信息（股票/日期/来源）。
 * 结果已随新查询被替换（resultId 不存在）时安全降级 exists=false。
 */
export function buildBlockContext(state: SearchCopilotState, resultId: string): CopilotContextData {
  const hit = (state.searchResults ?? []).find((r) => r.resultId === resultId);
  if (!hit) return emptyExistsFalse(resultId);

  const a: AnnouncementHit | null = hit.kind === 'announcement' ? hit : null;
  const c: ClsHit | null = hit.kind === 'cls' ? hit : null;

  const overview: Record<string, string | number | boolean> = {
    exists: true,
    kind: hit.kind,
    date: a ? a.annDate : (c as ClsHit).publishedAt,
  };
  if (a) overview.stock = a.stockId + ' ' + a.stockName;
  if (c) overview.edition = c.edition;

  const detail: Record<string, unknown> = a
    ? {
        title: a.title,
        summary: clip(a.summary),
        sourceUrl: a.sourceUrl ?? '',
        query: state.searchQuery ?? '',
      }
    : {
        title: (c as ClsHit).title ?? '',
        summary: clip((c as ClsHit).summary),
        mentions: (c as ClsHit).mentions.map((m) => m.stockId + ' ' + m.stockName),
        query: state.searchQuery ?? '',
      };

  return { overview, timeAnchor: timeAnchor(), detail, units: baseUnits() };
}

/** 档案卡明细（整页/区块两处复用） */
function profileDetail(p: StockProfile): Record<string, unknown> {
  return {
    stockId: p.stockId,
    stockName: p.stockName,
    latestAnnouncements: p.latestAnnouncements.map((a) => ({
      annId: a.annId,
      annDate: a.annDate,
      title: a.title,
      summary: clip(a.summary, 240),
    })),
    clsMention: p.clsMention
      ? {
          count7d: p.clsMention.count7d,
          items: p.clsMention.items.slice(0, 3).map((i) => ({
            publishedAt: i.publishedAt,
            summary: clip(i.summary, 240),
          })),
        }
      : null,
  };
}

/**
 * 档案卡区块上下文（blockId = news_search:profile）：该股最新公告摘要 + CLS 提及。
 * 档案卡缺席（关键词形态/降级）时安全降级 exists=false。
 */
export function buildProfileContext(state: SearchCopilotState): CopilotContextData {
  const p = state.stockProfile;
  if (!p) return emptyExistsFalse();

  return {
    overview: {
      exists: true,
      stock: p.stockId + ' ' + (p.stockName || ''),
      announcementCount: p.latestAnnouncements.length,
      mention7d: p.clsMention?.count7d ?? 0,
    },
    timeAnchor: timeAnchor(),
    detail: profileDetail(p),
    units: baseUnits(),
  };
}
