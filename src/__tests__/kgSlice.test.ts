/**
 * @file kgSlice.test.ts
 * @description 新闻联播图谱切片编排单测：runKgTimeline 状态机（loading→succeeded/failed）、
 *              默认态/keyword 态/entityId 态三种入参下发口径（entityId 优先、keyword 互斥）、
 *              未登录短路不发请求、seq 竞态守卫（慢的旧响应被丢弃）、
 *              loadMoreKgTimeline 续拉（翻页/追加去重/幂等守卫）、resetKgTimeline 复位与作废。
 *              运行环境：Node（fake-indexeddb + localStorage 桩 + useAuthStore 替身），
 *              kgService HTTP 层全部 mock，只测编排。
 * @layer 测试
 * @author 开发团队
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted 先于全部 import 执行：store/index 模块体在 import 阶段就读
// loadCopilotTombstones()，localStorage mock 必须在此时已就位。
vi.hoisted(() => {
  const store: Record<string, string> = {};
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => (key in store ? store[key] : null),
      setItem: (key: string, value: string) => {
        store[key] = String(value);
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k];
      },
      get length() {
        return Object.keys(store).length;
      },
      key: (index: number) => Object.keys(store)[index] ?? null,
    },
    configurable: true,
  });
});

// useAuthStore 替身：可变状态对象（kgSlice 的 currentToken 现读）
const authState = vi.hoisted(() => ({
  isAuthenticated: true,
}));

vi.mock('../store/useAuthStore', () => ({
  useAuthStore: {
    getState: () => authState,
    subscribe: vi.fn(() => () => {}),
    setState: vi.fn(),
  },
}));

// 会话令牌桩：kgSlice 经 loadStoredAuthSession 自取 token
vi.mock('../services/authSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/authSession')>();
  return {
    ...actual,
    loadStoredAuthSession: vi.fn(() => ({
      token: 'test-token',
      userId: 'u1',
      email: 't@t.io',
      expiresAt: '2099-01-01T00:00:00Z',
    })),
  };
});

// kgService：仅 mock 四个 HTTP 入口
vi.mock('../services/kgService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/kgService')>();
  return {
    ...actual,
    fetchKgTimeline: vi.fn(),
    fetchKgEntitySuggest: vi.fn(),
    fetchKgHotEntities: vi.fn(),
    fetchKgEntityDetail: vi.fn(),
  };
});

import { useAppStore } from '../store';
import { fetchKgTimeline } from '../services/kgService';
import type { KgTimelineDay, KgTimelineResult } from '../types/kg';

const fetchKgTimelineMock = vi.mocked(fetchKgTimeline);
const TOKEN = 'test-token';

/** 最小日组替身 */
function mkDay(articleId: number, date: string): KgTimelineDay {
  return {
    articleId,
    date,
    articleTitle: '要闻汇编 ' + articleId,
    eventCount: 1,
    events: [
      {
        id: articleId * 10,
        eventDate: date || null,
        eventTimeText: date ? null : '今天',
        title: '事件 ' + articleId,
        detail: null,
        eventType: '其他',
        articleId,
        entities: [],
      },
    ],
  };
}

/** 时间轴响应替身 */
function mkResult(overrides: Partial<KgTimelineResult>): KgTimelineResult {
  return {
    page: 0,
    pageSize: 3,
    totalDays: 0,
    hasMore: false,
    matchedEntities: [],
    days: [],
    ...overrides,
  };
}

function kgState() {
  const s = useAppStore.getState();
  return {
    kgStatus: s.kgStatus,
    kgError: s.kgError,
    kgDays: s.kgDays,
    kgPage: s.kgPage,
    kgHasMore: s.kgHasMore,
    kgLoadingMore: s.kgLoadingMore,
    kgMatchedEntities: s.kgMatchedEntities,
    kgTotalDays: s.kgTotalDays,
    kgKeyword: s.kgKeyword,
    kgEntityId: s.kgEntityId,
    kgEntityName: s.kgEntityName,
  };
}

beforeEach(() => {
  fetchKgTimelineMock.mockReset();
  authState.isAuthenticated = true;
  useAppStore.setState({
    kgStatus: 'idle',
    kgError: null,
    kgDays: [],
    kgPage: 0,
    kgHasMore: false,
    kgLoadingMore: false,
    kgMatchedEntities: [],
    kgTotalDays: 0,
    kgKeyword: null,
    kgEntityId: null,
    kgEntityName: null,
  });
});

describe('runKgTimeline', () => {
  it('默认态：无过滤参数下发，page=0 + KG_PAGE_SIZE，成功落日组', async () => {
    fetchKgTimelineMock.mockResolvedValueOnce(
      mkResult({ totalDays: 2, hasMore: true, days: [mkDay(1, '2023-09-10'), mkDay(2, '2023-09-09')] }),
    );
    await useAppStore.getState().runKgTimeline({});
    expect(fetchKgTimelineMock).toHaveBeenCalledWith(TOKEN, { page: 0, pageSize: 3 });
    const s = kgState();
    expect(s.kgStatus).toBe('succeeded');
    expect(s.kgDays).toHaveLength(2);
    expect(s.kgPage).toBe(1);
    expect(s.kgHasMore).toBe(true);
    expect(s.kgTotalDays).toBe(2);
    expect(s.kgKeyword).toBeNull();
    expect(s.kgEntityId).toBeNull();
  });

  it('keyword 态：trim 后下发，matchedEntities 落状态', async () => {
    fetchKgTimelineMock.mockResolvedValueOnce(
      mkResult({
        matchedEntities: [
          { id: 31, name: '亚运', entityType: 'EVENT', anchorType: 'CLS_SUBJECT', mentionCount: 4 },
        ],
        days: [mkDay(1, '2023-09-10')],
      }),
    );
    await useAppStore.getState().runKgTimeline({ keyword: '  亚运会  ' });
    expect(fetchKgTimelineMock).toHaveBeenCalledWith(TOKEN, {
      keyword: '亚运会',
      page: 0,
      pageSize: 3,
    });
    expect(kgState().kgMatchedEntities).toHaveLength(1);
    expect(kgState().kgKeyword).toBe('亚运会');
  });

  it('entityId 态：entityId 下发且 keyword 互斥省略，entityName 落状态', async () => {
    fetchKgTimelineMock.mockResolvedValueOnce(mkResult({ days: [mkDay(1, '2023-09-10')] }));
    await useAppStore.getState().runKgTimeline({ keyword: '亚运', entityId: 31, entityName: '亚运会' });
    expect(fetchKgTimelineMock).toHaveBeenCalledWith(TOKEN, {
      entityId: 31,
      page: 0,
      pageSize: 3,
    });
    expect(kgState().kgKeyword).toBeNull();
    expect(kgState().kgEntityId).toBe(31);
    expect(kgState().kgEntityName).toBe('亚运会');
  });

  it('未登录：短路 failed + 引导文案，不发请求', async () => {
    authState.isAuthenticated = false;
    await useAppStore.getState().runKgTimeline({});
    expect(fetchKgTimelineMock).not.toHaveBeenCalled();
    const s = kgState();
    expect(s.kgStatus).toBe('failed');
    expect(s.kgError).toBe('请先登录后再浏览新闻联播图谱');
  });

  it('seq 竞态守卫：慢的旧响应被新查询作废', async () => {
    let resolveFirst: (r: KgTimelineResult) => void = () => {};
    fetchKgTimelineMock.mockImplementationOnce(
      () => new Promise<KgTimelineResult>((res) => (resolveFirst = res)),
    );
    const first = useAppStore.getState().runKgTimeline({ keyword: '旧查询' });
    fetchKgTimelineMock.mockResolvedValueOnce(mkResult({ days: [mkDay(9, '2023-09-12')] }));
    await useAppStore.getState().runKgTimeline({ keyword: '新查询' });
    resolveFirst(mkResult({ days: [mkDay(1, '2023-01-01'), mkDay(2, '2023-01-02')] }));
    await first;
    const s = kgState();
    expect(s.kgDays.map((d) => d.articleId)).toEqual([9]); // 旧响应整体丢弃
    expect(s.kgKeyword).toBe('新查询');
  });

  it('请求失败：failed + 错误文案落状态', async () => {
    fetchKgTimelineMock.mockRejectedValueOnce(new Error('网络异常：请求超时，请检查连接后重试'));
    await useAppStore.getState().runKgTimeline({});
    const s = kgState();
    expect(s.kgStatus).toBe('failed');
    expect(s.kgError).toContain('网络异常');
  });
});

describe('loadMoreKgTimeline', () => {
  it('hasMore=true：按 page=1 续拉，追加去重，游标推进', async () => {
    fetchKgTimelineMock.mockResolvedValueOnce(
      mkResult({ totalDays: 4, hasMore: true, days: [mkDay(1, '2023-09-10'), mkDay(2, '2023-09-09')] }),
    );
    await useAppStore.getState().runKgTimeline({});
    fetchKgTimelineMock.mockResolvedValueOnce(
      mkResult({
        hasMore: false,
        days: [mkDay(2, '2023-09-09'), mkDay(3, '2023-09-08')], // 2 = 重复页间漂移，仅 3 追加
      }),
    );
    await useAppStore.getState().loadMoreKgTimeline();
    expect(fetchKgTimelineMock).toHaveBeenLastCalledWith(TOKEN, { page: 1, pageSize: 3 });
    const s = kgState();
    expect(s.kgDays.map((d) => d.articleId)).toEqual([1, 2, 3]);
    expect(s.kgPage).toBe(2);
    expect(s.kgHasMore).toBe(false);
    expect(s.kgLoadingMore).toBe(false);
  });

  it('entityId 搜索态续拉：复用 entityId 过滤基座', async () => {
    fetchKgTimelineMock.mockResolvedValueOnce(
      mkResult({ hasMore: true, days: [mkDay(1, '2023-09-10')] }),
    );
    await useAppStore.getState().runKgTimeline({ entityId: 31, entityName: '亚运会' });
    fetchKgTimelineMock.mockResolvedValueOnce(mkResult({ hasMore: false, days: [] }));
    await useAppStore.getState().loadMoreKgTimeline();
    expect(fetchKgTimelineMock).toHaveBeenLastCalledWith(TOKEN, {
      entityId: 31,
      page: 1,
      pageSize: 3,
    });
  });

  it('hasMore=false / 非成功态：幂等空操作不发请求', async () => {
    await useAppStore.getState().loadMoreKgTimeline(); // idle 态
    expect(fetchKgTimelineMock).not.toHaveBeenCalled();

    fetchKgTimelineMock.mockResolvedValueOnce(mkResult({ days: [mkDay(1, '2023-09-10')] }));
    await useAppStore.getState().runKgTimeline({});
    await useAppStore.getState().loadMoreKgTimeline(); // hasMore=false
    expect(fetchKgTimelineMock).toHaveBeenCalledTimes(1);
  });
});

describe('resetKgTimeline', () => {
  it('复位全量状态，进行中的首拉一并作废', async () => {
    let resolveFirst: (r: KgTimelineResult) => void = () => {};
    fetchKgTimelineMock.mockImplementationOnce(
      () => new Promise<KgTimelineResult>((res) => (resolveFirst = res)),
    );
    const pending = useAppStore.getState().runKgTimeline({ keyword: '进行中' });
    useAppStore.getState().resetKgTimeline();
    resolveFirst(mkResult({ days: [mkDay(1, '2023-09-10')] }));
    await pending;
    const s = kgState();
    expect(s.kgStatus).toBe('idle');
    expect(s.kgDays).toEqual([]);
    expect(s.kgKeyword).toBeNull();
    expect(s.kgPage).toBe(0);
  });
});
