/**
 * @file announcementSlice.ts
 * @description 公告订阅切片：短线/中长期交易卡片「订阅公告摘要」按钮的共享状态容器。
 *              订阅关系以服务端为准（GET /api/announcement/subscriptions），本地
 *              subscribedStockIds 仅为镜像缓存，供 TCalculator 与 CostAveraging
 *              的按钮同源展示订阅态；网络封装在 services/announcementService
 *              （token 注入式），本切片经 loadStoredAuthSession 自取会话令牌。
 *              订阅数据不落 Dexie：刷新后由按钮首次挂载重新拉取。
 * @layer Store (Slice)
 * @storage_impact 内存态，不持久化（服务端为准的镜像缓存）。
 * @author 开发团队
 */

import type { StateCreator } from 'zustand';
import type { AppStore } from '../types';
import {
  fetchSubscriptions,
  subscribeStock,
  unsubscribeStock,
} from '../../services/announcementService';
import { loadStoredAuthSession } from '../../services/authSession';
import { useAuthStore } from '../useAuthStore';
import { toStockId } from '../../utils/dedup';

/** 订阅操作结果（与 removeRound 等既有 action 的返回契约同构） */
interface SubActionResult {
  ok: boolean;
  message?: string;
}

/** 会话令牌：未登录 / 无本地会话返回 null（调用方给用户可读文案，不发请求） */
function currentToken(): string | null {
  if (!useAuthStore.getState().isAuthenticated) return null;
  return loadStoredAuthSession()?.token ?? null;
}

export type AnnouncementSlice = Pick<
  AppStore,
  'loadAnnouncementSubscriptions' | 'subscribeAnnouncement' | 'unsubscribeAnnouncement'
>;

export const createAnnouncementSlice: StateCreator<AppStore, [], [], AnnouncementSlice> = (set, get) => ({
  loadAnnouncementSubscriptions: async () => {
    if (get().announcementSubsLoaded || get().announcementSubsLoading) return;
    const token = currentToken();
    if (!token) return; // 未登录：不标记 loaded，登录后按钮再次挂载时重试
    set({ announcementSubsLoading: true });
    try {
      const parsed = await fetchSubscriptions(token);
      if (!parsed.recognized) {
        // 形状不识别（疑似后端契约变更）：不置 loaded，保留下次挂载重试机会；按钮按未订阅展示
        console.warn('[announcement] 订阅列表响应形状无法识别，已保留重试机会');
        return;
      }
      // 归一化 + 去重：兼容后端返回带前缀（sh600745）或纯 6 位码两种形态
      const normalized = Array.from(
        new Set(parsed.stockIds.map((c) => toStockId(c)).filter((c): c is string => !!c)),
      );
      set({ subscribedStockIds: normalized, announcementSubsLoaded: true });
    } catch {
      // 静默失败：按钮按未订阅展示，下次挂载重试；不打扰用户
    } finally {
      set({ announcementSubsLoading: false });
    }
  },

  subscribeAnnouncement: async (rawId) => {
    const stockId = toStockId(rawId);
    if (!stockId) return { ok: false, message: 'stockId 非法' };
    const token = currentToken();
    if (!token) return { ok: false, message: '请先登录后再订阅公告' };
    if (get().subscribedStockIds.includes(stockId)) return { ok: true };
    const prev = get().subscribedStockIds;
    set({ subscribedStockIds: [...prev, stockId] }); // 乐观更新，失败回滚
    try {
      await subscribeStock(token, stockId);
      return { ok: true };
    } catch (e) {
      set({ subscribedStockIds: prev });
      return { ok: false, message: e instanceof Error ? e.message : '订阅失败，请稍后重试' };
    }
  },

  unsubscribeAnnouncement: async (rawId) => {
    const stockId = toStockId(rawId);
    if (!stockId) return { ok: false, message: 'stockId 非法' };
    const token = currentToken();
    if (!token) return { ok: false, message: '请先登录后再操作订阅' };
    const prev = get().subscribedStockIds;
    if (!prev.includes(stockId)) return { ok: true };
    set({ subscribedStockIds: prev.filter((c) => c !== stockId) }); // 乐观更新，失败回滚
    try {
      await unsubscribeStock(token, stockId);
      return { ok: true };
    } catch (e) {
      set({ subscribedStockIds: prev });
      return { ok: false, message: e instanceof Error ? e.message : '取消订阅失败，请稍后重试' };
    }
  },
});
