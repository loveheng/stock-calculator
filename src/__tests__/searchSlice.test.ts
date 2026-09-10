/**
 * @file searchSlice.test.ts
 * @description 资讯搜索切片编排单测：runSearch 状态机（loading→succeeded/failed）、
 *              持仓注入（未平仓 → toStockId → 去重；为空短路引导不发请求）、
 *              形态检测分流（6 位码直判 / 名称消歧严格全等 / 消歧失败静默降级）、
 *              档案卡 400 降级（A10：该码作关键词且不注入 stockCodes）、
 *              seq 竞态守卫（慢的旧响应被丢弃）、composite 流式回调接入、
 *              429 retryAfterSeconds 提取、resetSearch 复位。
 *              运行环境：Node（fake-indexeddb + localStorage 桩 + useAuthStore 替身），
 *              searchService/stockService HTTP 层全部 mock，只测编排。
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

// useAuthStore 替身：可变状态对象（announcementSlice/searchSlice 的 currentToken 现读）
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

// 会话令牌桩：searchSlice 经 loadStoredAuthSession 自取 token
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

// searchService：仅 mock 四个 HTTP 入口；extractRetryAfterSeconds 保持真实实现
vi.mock('../services/searchService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/searchService')>();
  return {
    ...actual,
    searchAnnouncements: vi.fn(),
    searchCls: vi.fn(),
    searchCompositeStream: vi.fn(),
    fetchStockProfile: vi.fn(),
  };
});

// stockService：仅 mock 消歧入口（Smartbox 网络层不入编排测试）
vi.mock('../services/stockService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/stockService')>();
  return {
    ...actual,
    searchStocks: vi.fn(),
  };
});

import { useAppStore } from '../store';
import type { AppStore } from '../store/types';
import { AuthApiError } from '../services/apiClient';
import {
  fetchStockProfile,
  searchAnnouncements,
  searchCls,
  searchCompositeStream,
} from '../services/searchService';
import { searchStocks } from '../services/stockService';
import type { StockProfile } from '../types/search';

const searchAnnouncementsMock = vi.mocked(searchAnnouncements);
const searchClsMock = vi.mocked(searchCls);
const searchCompositeStreamMock = vi.mocked(searchCompositeStream);
const fetchStockProfileMock = vi.mocked(fetchStockProfile);
const searchStocksMock = vi.mocked(searchStocks);

const TOKEN = 'test-token';

const annHit = {
  kind: 'announcement' as const,
  resultId: 'AN1',
  stockId: '600745',
  stockName: '闻泰科技',
  annDate: '2026-09-01',
  title: '关于补充协议的公告',
  summary: '签署补充对赌协议……',
};

const profileFixture: StockProfile = {
  stockId: '600745',
  stockName: '闻泰科技',
  latestAnnouncements: [{ annId: 'AN2', annDate: '2026-09-08', title: 't', summary: 's' }],
  clsMention: null,
};

/** 最小持仓替身（编排测试只关心 fullCode/isClosed） */
function mkPosition(fullCode: string, isClosed = false): AppStore['positions'][number] {
  return { fullCode, isClosed } as unknown as AppStore['positions'][number];
}

function searchState() {
  const s = useAppStore.getState();
  return {
    searchStatus: s.searchStatus,
    searchResults: s.searchResults,
    searchTotal: s.searchTotal,
    searchError: s.searchError,
    searchQuery: s.searchQuery,
    stockProfile: s.stockProfile,
    compositeResult: s.compositeResult,
    retryAfterSeconds: s.retryAfterSeconds,
  };
}

beforeEach(() => {
  searchAnnouncementsMock.mockReset();
  searchClsMock.mockReset();
  searchCompositeStreamMock.mockReset();
  fetchStockProfileMock.mockReset();
  searchStocksMock.mockReset();
  authState.isAuthenticated = true;
  useAppStore.setState({
    positions: [],
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
});

describe('runSearch：关键词 + 持仓注入', () => {
  it('announcement 范围：未平仓持仓 → toStockId → 去重 → 注入 stockCodes', async () => {
    useAppStore.setState({
      positions: [mkPosition('sh600745'), mkPosition('sz000001', true), mkPosition('sh600745')],
    });
    searchStocksMock.mockResolvedValue([]); // 消歧不命中 → 关键词模式
    searchAnnouncementsMock.mockResolvedValueOnce({ total: 1, items: [annHit] });

    await useAppStore.getState().runSearch({ query: '对赌', scope: 'announcement' });

    expect(searchAnnouncementsMock).toHaveBeenCalledTimes(1);
    expect(searchAnnouncementsMock).toHaveBeenCalledWith(TOKEN, {
      query: '对赌',
      stockCodes: ['600745'],
    });
    const s = searchState();
    expect(s.searchStatus).toBe('succeeded');
    expect(s.searchResults).toHaveLength(1);
    expect(s.searchTotal).toBe(1);
    expect(s.searchError).toBeNull();
  });

  it('announcement 范围持仓超 50 只 → 截断至 50', async () => {
    const positions = Array.from({ length: 60 }, (_, i) =>
      mkPosition('6' + String(i).padStart(5, '0')),
    );
    useAppStore.setState({ positions });
    searchStocksMock.mockResolvedValue([]);
    searchAnnouncementsMock.mockResolvedValueOnce({ total: 0, items: [] });

    await useAppStore.getState().runSearch({ query: '对赌', scope: 'announcement' });

    const req = searchAnnouncementsMock.mock.calls[0][1];
    expect(req.stockCodes).toHaveLength(50);
  });

  it('announcement 范围无进行中持仓 → 短路引导空态，不发检索请求（spec F1）', async () => {
    await useAppStore.getState().runSearch({ query: '对赌', scope: 'announcement' });

    // 消歧通道照常执行（形态检测优先级高于 Filter），但不发检索请求
    expect(searchStocksMock).toHaveBeenCalledTimes(1);
    expect(searchAnnouncementsMock).not.toHaveBeenCalled();
    const s = searchState();
    expect(s.searchStatus).toBe('failed');
    expect(s.searchError).toContain('持仓');
  });

  it('cls 范围：不注入 stockCodes（接口 §3 无该参数），持仓为空也不短路', async () => {
    searchClsMock.mockResolvedValueOnce({ total: 0, items: [] });

    await useAppStore.getState().runSearch({ query: '半导体', scope: 'cls' });

    expect(searchClsMock).toHaveBeenCalledWith(TOKEN, { query: '半导体' });
    expect(searchAnnouncementsMock).not.toHaveBeenCalled();
    expect(searchState().searchStatus).toBe('succeeded');
  });

  it('429 → failed + retryAfterSeconds 提取；其余错误 retryAfterSeconds=null', async () => {
    useAppStore.setState({ positions: [mkPosition('sh600745')] });
    searchStocksMock.mockResolvedValue([]);
    searchAnnouncementsMock.mockRejectedValueOnce(
      new AuthApiError(429, '请求过于频繁，请稍后重试', { retryAfterSeconds: 8 }),
    );
    await useAppStore.getState().runSearch({ query: '对赌', scope: 'announcement' });
    let s = searchState();
    expect(s.searchStatus).toBe('failed');
    expect(s.searchError).toBe('请求过于频繁，请稍后重试');
    expect(s.retryAfterSeconds).toBe(8);

    searchAnnouncementsMock.mockRejectedValueOnce(new AuthApiError(400, '检索关键词过长', null));
    await useAppStore.getState().runSearch({ query: '对赌', scope: 'announcement' });
    s = searchState();
    expect(s.retryAfterSeconds).toBeNull();
    expect(s.searchError).toBe('检索关键词过长');
  });
});

describe('runSearch：形态检测与档案卡', () => {
  it('6 位码直判 stock 模式：先装档案卡，检索覆盖为单票硬过滤（无持仓也可查）', async () => {
    fetchStockProfileMock.mockResolvedValueOnce(profileFixture);
    searchAnnouncementsMock.mockResolvedValueOnce({ total: 0, items: [] });

    await useAppStore.getState().runSearch({ query: '600745', scope: 'announcement' });

    expect(fetchStockProfileMock).toHaveBeenCalledWith(TOKEN, '600745');
    expect(searchAnnouncementsMock).toHaveBeenCalledWith(TOKEN, {
      query: '600745',
      stockCodes: ['600745'],
    });
    const s = searchState();
    expect(s.stockProfile).toEqual(profileFixture);
    expect(s.searchStatus).toBe('succeeded');
  });

  it('名称消歧严格全等命中 → stock 模式', async () => {
    searchStocksMock.mockResolvedValueOnce([{ Code: '600745', Name: '闻泰科技', fullCode: 'sh600745' }]);
    fetchStockProfileMock.mockResolvedValueOnce(profileFixture);
    searchAnnouncementsMock.mockResolvedValueOnce({ total: 0, items: [] });

    await useAppStore.getState().runSearch({ query: '闻泰科技', scope: 'announcement' });

    expect(fetchStockProfileMock).toHaveBeenCalledWith(TOKEN, '600745');
  });

  it('消歧不命中（宽泛词）→ 静默降级关键词，不发档案卡请求', async () => {
    useAppStore.setState({ positions: [mkPosition('sh600745')] });
    searchStocksMock.mockResolvedValueOnce([{ Code: '601318', Name: '中国平安', fullCode: 'sh601318' }]);
    searchAnnouncementsMock.mockResolvedValueOnce({ total: 0, items: [] });

    await useAppStore.getState().runSearch({ query: '平安银行', scope: 'announcement' });

    expect(fetchStockProfileMock).not.toHaveBeenCalled();
    expect(searchAnnouncementsMock).toHaveBeenCalledWith(TOKEN, {
      query: '平安银行',
      stockCodes: ['600745'],
    });
  });

  it('A10 降级：档案卡 400 → 该码作关键词检索且不注入 stockCodes（skipHoldingsFilter）', async () => {
    useAppStore.setState({ positions: [mkPosition('sh600745')] });
    fetchStockProfileMock.mockRejectedValueOnce(new AuthApiError(400, 'stockId 非法', null));
    searchAnnouncementsMock.mockResolvedValueOnce({ total: 0, items: [] });

    await useAppStore.getState().runSearch({ query: '600745', scope: 'announcement' });

    expect(fetchStockProfileMock).toHaveBeenCalledWith(TOKEN, '600745');
    expect(searchAnnouncementsMock).toHaveBeenCalledWith(TOKEN, { query: '600745' });
    const s = searchState();
    expect(s.stockProfile).toBeNull();
    expect(s.searchStatus).toBe('succeeded'); // 无错误 toast，结果列表照常展示
  });

  it('档案卡网络失败（非 400）→ 档案卡缺席但检索继续，单票过滤语义保留', async () => {
    fetchStockProfileMock.mockRejectedValueOnce(new Error('网络异常：无法连接检索服务'));
    searchAnnouncementsMock.mockResolvedValueOnce({ total: 0, items: [] });

    await useAppStore.getState().runSearch({ query: '600745', scope: 'announcement' });

    expect(searchAnnouncementsMock).toHaveBeenCalledWith(TOKEN, {
      query: '600745',
      stockCodes: ['600745'],
    });
    expect(searchState().searchStatus).toBe('succeeded');
  });

  it('消歧通道网络失败 → 静默按关键词检索', async () => {
    useAppStore.setState({ positions: [mkPosition('sh600745')] });
    searchStocksMock.mockRejectedValueOnce(new Error('股票搜索请求失败'));
    searchAnnouncementsMock.mockResolvedValueOnce({ total: 0, items: [] });

    await useAppStore.getState().runSearch({ query: '闻泰科技', scope: 'announcement' });

    expect(fetchStockProfileMock).not.toHaveBeenCalled();
    expect(searchAnnouncementsMock).toHaveBeenCalledWith(TOKEN, {
      query: '闻泰科技',
      stockCodes: ['600745'],
    });
  });
});

describe('runSearch：composite 流式与竞态守卫', () => {
  it('composite：status=generating → onMeta/onDelta 渐进落 store → succeeded + 引用数', async () => {
    searchCompositeStreamMock.mockImplementation(async (_token, _req, opts) => {
      opts?.onMeta?.([{ kind: 'announcement', resultId: 'AN9', date: '2026-09-01', title: 'c1' }]);
      opts?.onDelta?.('半导体');
      opts?.onDelta?.('板块利好');
      return {
        summary: '半导体板块利好',
        citations: [{ kind: 'announcement', resultId: 'AN9', date: '2026-09-01', title: 'c1' }],
      };
    });

    await useAppStore.getState().runSearch({ query: '半导体', scope: 'composite' });

    expect(searchCompositeStreamMock).toHaveBeenCalledWith(
      TOKEN,
      { query: '半导体' },
      expect.objectContaining({ isCancelled: expect.any(Function) }),
    );
    const s = searchState();
    expect(s.searchStatus).toBe('succeeded');
    expect(s.compositeResult?.summary).toBe('半导体板块利好');
    expect(s.compositeResult?.citations).toHaveLength(1);
    expect(s.searchTotal).toBe(1);
    expect(s.searchResults).toEqual([]);
  });

  it('seq 竞态：慢的旧响应被丢弃，UI 只展示最后一次查询结果（N5）', async () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));
    let resolveProfile1!: (v: StockProfile) => void;
    let resolveAnn1!: (v: { total: number; items: unknown[] }) => void;
    // 查询①（600745）：档案卡与检索响应均可控挂起
    fetchStockProfileMock.mockImplementationOnce(
      () => new Promise((res) => {
        resolveProfile1 = res;
      }),
    );
    searchAnnouncementsMock.mockImplementationOnce(
      () => new Promise((res) => {
        resolveAnn1 = res;
      }),
    );
    // 查询②：档案卡/检索均立即成功
    fetchStockProfileMock.mockResolvedValueOnce(profileFixture);
    searchAnnouncementsMock.mockResolvedValueOnce({ total: 0, items: [] });

    const p1 = useAppStore.getState().runSearch({ query: '600745', scope: 'announcement' });
    resolveProfile1(profileFixture);
    await flush(); // 查询①推进到检索在途
    expect(searchAnnouncementsMock).toHaveBeenCalledTimes(1);

    await useAppStore.getState().runSearch({ query: '600745', scope: 'announcement' });
    expect(useAppStore.getState().searchQuery).toBe('600745');
    expect(useAppStore.getState().searchTotal).toBe(0);

    resolveAnn1({ total: 5, items: [annHit] }); // 旧响应迟到
    await p1;

    const s = searchState();
    expect(s.searchTotal).toBe(0); // 旧响应未写入
    expect(s.searchResults).toEqual([]);
    expect(s.searchStatus).toBe('succeeded');
  });

  it('空查询（纯空白）→ resetSearch 回初始态，不发请求', async () => {
    useAppStore.setState({ searchStatus: 'succeeded', searchResults: [annHit as never] });
    await useAppStore.getState().runSearch({ query: '   ', scope: 'announcement' });
    const s = searchState();
    expect(s.searchStatus).toBe('idle');
    expect(s.searchResults).toEqual([]);
    expect(searchAnnouncementsMock).not.toHaveBeenCalled();
  });

  it('未登录（防御性检查）→ failed 引导文案，不发请求', async () => {
    authState.isAuthenticated = false;
    await useAppStore.getState().runSearch({ query: '对赌', scope: 'announcement' });
    expect(searchAnnouncementsMock).not.toHaveBeenCalled();
    const s = searchState();
    expect(s.searchStatus).toBe('failed');
    expect(s.searchError).toContain('登录');
  });

  it('resetSearch：全部状态复位（检索历史不持久化，刷新即回初始态）', async () => {
    useAppStore.setState({ positions: [mkPosition('sh600745')] });
    searchStocksMock.mockResolvedValue([]);
    searchAnnouncementsMock.mockResolvedValueOnce({ total: 1, items: [annHit] });
    await useAppStore.getState().runSearch({ query: '对赌', scope: 'announcement' });

    useAppStore.getState().resetSearch();

    const s = searchState();
    expect(s).toMatchObject({
      searchStatus: 'idle',
      searchQuery: '',
      searchResults: [],
      searchTotal: 0,
      stockProfile: null,
      compositeResult: null,
      searchError: null,
      retryAfterSeconds: null,
    });
  });
});
