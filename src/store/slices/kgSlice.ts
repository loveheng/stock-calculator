/**
 * @file kgSlice.ts
 * @description 新闻联播图谱切片：时间轴卡片流状态机与查询编排。默认浏览（无过滤参数 =
 *              「最近时间轴」）与搜索态（keyword / entityId 二选一下发）共用 timeline 端点；
 *              page 按「日」递增续拉，累积追加 + articleId 去重；seq 竞态守卫镜像 searchSlice
 *              （新查询自增序号，旧响应/续拉按序号作废）。实体建议/热榜/详情卡为一次性读，
 *              由视图直调 kgService（I3：不进状态机）；本切片只管时间轴主流转。
 *              内存态不持久化，刷新即回初始态（与资讯搜索一致）。
 * @layer Store (Slice)
 * @storage_impact 内存态，不持久化。
 * @author 开发团队
 */

import type { StateCreator } from 'zustand';
import type { AppStore } from '../types';
import { fetchKgTimeline } from '../../services/kgService';
import { useAuthStore } from '../useAuthStore';
import { loadStoredAuthSession } from '../../services/authSession';
import type {
  KgMatchedEntity,
  KgStatus,
  KgTimelineDay,
  KgTimelineInput,
  KgTimelineQuery,
} from '../../types/kg';

/** 每页天数（前端定案 3：每篇汇编稿 20~30 条事件，默认 5 天一屏约百卡过重，见 docs/news-kg-spec.md） */
export const KG_PAGE_SIZE = 3;

/** 空态热榜 chips 条数（接口文档 §四默认 20，前端确认沿用） */
export const KG_HOT_LIMIT = 20;

/** 实体检索建议条数（接口文档 §三默认 10，前端确认沿用） */
export const KG_SUGGEST_LIMIT = 10;

/** 会话令牌：未登录 / 无本地会话返回 null（调用方给用户可读文案，不发请求） */
function currentToken(): string | null {
  if (!useAuthStore.getState().isAuthenticated) return null;
  return loadStoredAuthSession()?.token ?? null;
}

export type KgSlice = Pick<AppStore, 'runKgTimeline' | 'loadMoreKgTimeline' | 'resetKgTimeline'>;

/** 模块级请求序号（N5 竞态守卫镜像 searchSlice）：新查询自增，旧响应/续拉按序号作废 */
let requestSeq = 0;

/** 全量重置的公共状态形状（idle / 未登录短路 / 新查询预热共用） */
function baseState() {
  return {
    kgStatus: 'idle' as KgStatus,
    kgError: null as string | null,
    kgDays: [] as KgTimelineDay[],
    kgPage: 0,
    kgHasMore: false,
    kgLoadingMore: false,
    kgMatchedEntities: [] as KgMatchedEntity[],
    kgTotalDays: 0,
  };
}

export const createKgSlice: StateCreator<AppStore, [], [], KgSlice> = (set, get) => ({
  resetKgTimeline: () => {
    requestSeq++; // 进行中的首拉/续拉一并作废
    set({ ...baseState(), kgKeyword: null, kgEntityId: null, kgEntityName: null });
  },

  runKgTimeline: async (input) => {
    const keyword = typeof input.keyword === 'string' ? input.keyword.trim() : '';
    const entityId = typeof input.entityId === 'number' ? input.entityId : null;
    // 互斥口径：entityId 优先（比 keyword 更准，接口文档 §二）；两者都无 = 默认态
    const effectiveKeyword = entityId ? null : keyword || null;

    const token = currentToken();
    if (!token) {
      // 防御性检查（门控主判断在视图）：未登录不发请求
      set({ ...baseState(), kgStatus: 'failed', kgError: '请先登录后再浏览新闻联播图谱' });
      return;
    }

    const seq = ++requestSeq;
    const isCancelled = () => seq !== requestSeq;
    set({
      ...baseState(),
      kgStatus: 'loading',
      kgKeyword: effectiveKeyword,
      kgEntityId: entityId,
      kgEntityName: entityId ? (input.entityName ?? null) : null,
    });

    const query: KgTimelineQuery = {
      ...(effectiveKeyword ? { keyword: effectiveKeyword } : {}),
      ...(entityId ? { entityId } : {}),
      page: 0,
      pageSize: KG_PAGE_SIZE,
    };

    try {
      const data = await fetchKgTimeline(token, query);
      if (isCancelled()) return;
      set({
        kgStatus: 'succeeded',
        kgDays: data.days,
        kgPage: 1, // 首页已载，下一页页码 = 1
        kgHasMore: data.hasMore,
        kgMatchedEntities: data.matchedEntities,
        kgTotalDays: data.totalDays,
      });
    } catch (e) {
      if (isCancelled()) return;
      set({
        kgStatus: 'failed',
        kgError: e instanceof Error ? e.message : '时间轴加载失败，请稍后重试',
      });
    }
  },

  loadMoreKgTimeline: async () => {
    const s = get();
    // 幂等守卫：仅 succeeded 且后端确认有下一页时续拉；loadingMore 防观察器/连点重复触发
    if (s.kgStatus !== 'succeeded' || !s.kgHasMore || s.kgLoadingMore) return;
    const token = currentToken();
    if (!token) return;

    // 续拉不推进 requestSeq：仅新 runKgTimeline 使本续拉作废（N5 同源竞态守卫）
    const seq = requestSeq;
    const isCancelled = () => seq !== requestSeq;
    set({ kgLoadingMore: true });
    try {
      const data = await fetchKgTimeline(token, {
        ...(s.kgEntityId ? { entityId: s.kgEntityId } : {}),
        ...(s.kgKeyword && !s.kgEntityId ? { keyword: s.kgKeyword } : {}),
        page: s.kgPage,
        pageSize: KG_PAGE_SIZE,
      });
      if (isCancelled()) return;
      set((st) => {
        // 追加去重：页间数据漂移（回填乱序落库/新数据入库）可能带回已展示日组
        const seen = new Set(st.kgDays.map((d) => d.articleId + '@' + d.date));
        const fresh = data.days.filter((d) => !seen.has(d.articleId + '@' + d.date));
        return {
          kgDays: [...st.kgDays, ...fresh],
          kgTotalDays: st.kgTotalDays + fresh.length,
          kgPage: st.kgPage + 1,
          kgHasMore: data.hasMore,
          kgLoadingMore: false,
        };
      });
    } catch {
      // 续拉失败静默：已加载列表保持，hasMore 不变，可再次触发
      if (!isCancelled()) set({ kgLoadingMore: false });
    }
  },
});
