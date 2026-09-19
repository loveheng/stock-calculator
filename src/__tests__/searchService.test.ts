/**
 * @file searchService.test.ts
 * @description 资讯搜索服务层单测：常规三端点（路径/方法/body/Bearer 头、信封 200/400/429/401、
 *              非信封 HTTP 状态、网络异常文案）、composite SSE 流解析（meta→delta*→done 事件序、
 *              跨 chunk 断帧容错、error 事件抛 AuthApiError）、内容协商回落（同步 JSON 信封）、
 *              isCancelled 竞态作废（返回 null 且断流）、extractRetryAfterSeconds 类型守卫。
 *              运行环境：Node；fetch 以 vi.stubGlobal 替换，Response 为手写假对象
 *              （SSE reader 手写 {read, cancel}，不依赖 ReadableStream）。
 * @layer 测试
 * @author 开发团队
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError, SessionExpiredError } from '../services/apiClient';
import {
  extractRetryAfterSeconds,
  fetchStockProfile,
  searchAnnouncements,
  searchCls,
  searchCompositeStream,
} from '../services/searchService';
import type { ClsHit, SearchRequest } from '../types/search';

const TOKEN = 'test-token';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** JSON 假 Response：body 直接由 json() 返回（非信封 HTML 用字符串 body 模拟解析失败） */
function jsonResponse(status: number, body: unknown, contentType = 'application/json'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
    body: null,
  } as unknown as Response;
}

/** SSE 假 Response：chunks 逐段返回的手写 reader（不依赖 ReadableStream） */
function sseResponse(chunks: string[], opts: { cancel?: ReturnType<typeof vi.fn> } = {}): Response {
  let i = 0;
  const encoder = new TextEncoder();
  const cancel = opts.cancel ?? vi.fn(async () => {});
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: encoder.encode(chunks[i++]) }
            : { done: true, value: undefined },
        cancel,
      }),
    },
  } as unknown as Response;
}

describe('常规检索端点（15s 底座）', () => {
  it('searchAnnouncements：POST /api/search/announcements + Bearer + body 透传，信封 200 归一化列表', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        code: 200,
        message: 'ok',
        data: {
          total: 1,
          items: [
            {
              kind: 'announcement',
              resultId: 'AN1',
              stockId: '600745',
              stockName: '闻泰科技',
              annDate: '2026-09-01',
              title: 't',
              summary: 's',
            },
          ],
        },
      }),
    );
    const data = await searchAnnouncements(TOKEN, { query: '对赌', stockCodes: ['600745'] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/search/announcements');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer ' + TOKEN);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ query: '对赌', stockCodes: ['600745'] });
    expect(data.total).toBe(1);
    expect(data.items[0].resultId).toBe('AN1');
  });

  it('searchCls：POST /api/search/cls，data 归一化', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { code: 200, message: 'ok', data: { total: 0, items: [] } }),
    );
    const data = await searchCls(TOKEN, { query: '半导体' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/search/cls');
    expect(data).toEqual({ total: 0, items: [], hasMore: false });
  });

  it('CLS 分页：hasMore 透传（无限滑动续拉依据），pageSize/page 请求体透传', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { code: 200, message: 'ok', data: { total: 10, items: [], hasMore: true } }),
    );
    const data = await searchCls(TOKEN, { query: '半导体', pageSize: 10, page: 2 });
    expect(data.hasMore).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      query: '半导体',
      pageSize: 10,
      page: 2,
    });
  });

  it('fetchStockProfile：GET /api/search/stock-profile?stockId=…（encodeURIComponent）', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        code: 200,
        message: 'ok',
        data: { stockId: '600745', stockName: '闻泰科技', latestAnnouncements: [], clsMention: null },
      }),
    );
    const profile = await fetchStockProfile(TOKEN, '600745');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/search/stock-profile?stockId=600745');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer ' + TOKEN);
    expect(profile.stockId).toBe('600745');
  });

  it('fetchStockProfile：档案卡数组混入 null 元素时元素级过滤（线上聊天快照崩溃回归）', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        code: 200,
        message: 'ok',
        data: {
          stockId: '600745',
          stockName: '闻泰科技',
          latestAnnouncements: [null, { annId: 'AN2', annDate: '2026-09-08', title: 't', summary: 's' }],
          clsMention: {
            count7d: 2,
            items: [null, { publishedAt: '2026-09-05 07:32', summary: 's1' }],
          },
        },
      }),
    );
    const profile = await fetchStockProfile(TOKEN, '600745');
    expect(profile.stockId).toBe('600745');
    expect(profile.latestAnnouncements).toHaveLength(1);
    expect(profile.latestAnnouncements[0].annId).toBe('AN2');
    expect(profile.clsMention?.items).toHaveLength(1);
    expect(profile.clsMention?.items[0].publishedAt).toBe('2026-09-05 07:32');
  });

  it('items 元素 kind 缺失时按字段形状修补（旧构建后端实测，区块快照降级为空的根因）', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        code: 200,
        message: 'ok',
        data: {
          total: 3,
          items: [
            { resultId: 'C1', publishedAt: '2026-09-05 07:32', edition: 'telegraph', title: 't', summary: 's', mentions: [null, { stockId: '600745', stockName: '闻泰科技' }] },
            { resultId: 'C2', publishedAt: '2026-09-06 08:00', edition: 'telegraph', title: 't2', summary: 's2' },
            { resultId: 'A1', stockId: '600745', stockName: '闻泰科技', annDate: '2026-09-01', title: 't3', summary: 's3' },
          ],
        },
      }),
    );
    const data = await searchAnnouncements(TOKEN, { query: 'x' });
    const items = data.items as unknown as ClsHit[];
    expect(items[0].kind).toBe('cls');
    expect(items[0].mentions).toEqual([{ stockId: '600745', stockName: '闻泰科技' }]);
    expect(items[1].kind).toBe('cls');
    expect(items[1].mentions).toEqual([]);
    expect(items[2].kind).toBe('announcement');
  });

  it('data 形状异常防御：items 非数组兜底空列表', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { code: 200, message: 'ok', data: null }));
    const data = await searchCls(TOKEN, { query: 'x' });
    expect(data).toEqual({ total: 0, items: [], hasMore: false });
  });

  it('信封 400 → AuthApiError（code/message 透出，用户可读直出）', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { code: 400, message: '检索关键词过长', data: null }),
    );
    const err = await searchAnnouncements(TOKEN, { query: '' }).catch((e) => e);
    expect(err).toBeInstanceOf(AuthApiError);
    expect(err.code).toBe(400);
    expect(err.message).toBe('检索关键词过长');
  });

  it('信封 429 → AuthApiError，data.retryAfterSeconds 可被类型守卫提取', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { code: 429, message: '请求过于频繁', data: { retryAfterSeconds: 8 } }),
    );
    const err = await searchAnnouncements(TOKEN, { query: 'x' }).catch((e) => e);
    expect(err.code).toBe(429);
    expect(extractRetryAfterSeconds(err.data)).toBe(8);
  });

  it('信封 401 → SessionExpiredError', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { code: 401, message: '会话已失效', data: null }),
    );
    await expect(searchAnnouncements(TOKEN, { query: 'x' })).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('HTTP 401 非信封（拦截器直写）→ SessionExpiredError', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, null));
    await expect(searchAnnouncements(TOKEN, { query: 'x' })).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('非信封 HTML（网关错误页）→ 携带 HTTP 状态的 Error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(502, '<html>bad gateway</html>', 'text/html'));
    const err = await searchCls(TOKEN, { query: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('502');
  });

  it('网络拒绝 → 网络异常文案', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(searchAnnouncements(TOKEN, { query: 'x' })).rejects.toThrow('网络异常');
  });
});

describe('searchCompositeStream（SSE + 内容协商回落）', () => {
  const REQ: SearchRequest = { query: '半导体' };

  const META =
    'event: meta\ndata: {"citations":[{"kind":"announcement","resultId":"AN1","stockId":"600745","date":"2026-09-01","title":"公告"}]}\n\n';
  const DELTA1 = 'event: delta\ndata: {"text":"半导体"}\n\n';
  const DELTA2 = 'event: delta\ndata: {"text":"板块利好"}\n\n';
  const DONE = 'event: done\ndata: {"code":200,"message":"ok"}\n\n';

  it('SSE 事件序 meta→delta*→done：引用先上屏，summary 渐进拼接，返回权威 CompositeResult', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([META, DELTA1, DELTA2, DONE]));
    const citations: Array<Record<string, unknown>> = [];
    let summary = '';
    const result = await searchCompositeStream(TOKEN, REQ, {
      onMeta: (c) => citations.push(...c),
      onDelta: (t) => {
        summary += t;
      },
    });
    expect(citations).toHaveLength(1);
    expect(summary).toBe('半导体板块利好');
    expect(result).toEqual({
      summary: '半导体板块利好',
      citations: [
        { kind: 'announcement', resultId: 'AN1', stockId: '600745', date: '2026-09-01', title: '公告' },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/search/composite');
    expect(init.method).toBe('POST');
    expect(init.headers.Accept).toBe('text/event-stream');
    expect(init.headers.Authorization).toBe('Bearer ' + TOKEN);
    expect(JSON.parse(init.body)).toEqual({ query: '半导体' });
  });

  it('跨 chunk 断帧容错：事件块被拆在两个 chunk 中仍可解析', async () => {
    const half = META.slice(0, 40);
    const rest = META.slice(40);
    fetchMock.mockResolvedValueOnce(sseResponse([half, rest, DONE]));
    const onMeta = vi.fn();
    const result = await searchCompositeStream(TOKEN, REQ, { onMeta });
    expect(onMeta).toHaveBeenCalledTimes(1);
    expect(result?.citations).toHaveLength(1);
  });

  it('error 事件 → AuthApiError（code/message/data.retryAfterSeconds）', async () => {
    const errEvent =
      'event: error\ndata: {"code":429,"message":"请求过于频繁，请 8 秒后重试","retryAfterSeconds":8}\n\n';
    fetchMock.mockResolvedValueOnce(sseResponse([errEvent]));
    const err = await searchCompositeStream(TOKEN, REQ).catch((e) => e);
    expect(err).toBeInstanceOf(AuthApiError);
    expect(err.code).toBe(429);
    expect(err.message).toContain('8 秒');
    expect(extractRetryAfterSeconds(err.data)).toBe(8);
  });

  it('内容协商回落：application/json 信封 → 同步返回 CompositeResult（不回调 onDelta/onMeta）', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { code: 200, message: 'ok', data: { summary: '同步摘要', citations: [] } }),
    );
    const onDelta = vi.fn();
    const onMeta = vi.fn();
    const result = await searchCompositeStream(TOKEN, REQ, { onDelta, onMeta });
    expect(onDelta).not.toHaveBeenCalled();
    expect(onMeta).not.toHaveBeenCalled();
    expect(result).toEqual({ summary: '同步摘要', citations: [] });
  });

  it('回落信封 401 → SessionExpiredError', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { code: 401, message: '会话已失效', data: null }),
    );
    await expect(searchCompositeStream(TOKEN, REQ)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('isCancelled 探针：竞态作废返回 null 且 reader.cancel 被调用（断流）', async () => {
    const cancel = vi.fn(async () => {});
    fetchMock.mockResolvedValueOnce(sseResponse([META, DELTA1, DONE], { cancel }));
    const onDelta = vi.fn();
    const result = await searchCompositeStream(TOKEN, REQ, { onDelta, isCancelled: () => true });
    expect(result).toBeNull();
    expect(onDelta).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  });

  it('token 缺省 → 快速抛错（不发请求）', async () => {
    await expect(searchCompositeStream('', REQ)).rejects.toThrow('请先登录');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('extractRetryAfterSeconds 类型守卫（429 信封 data 兼容）', () => {
  it('合法形状返回正整数秒（向上取整）', () => {
    expect(extractRetryAfterSeconds({ retryAfterSeconds: 8 })).toBe(8);
    expect(extractRetryAfterSeconds({ retryAfterSeconds: 7.4 })).toBe(8);
  });

  it('data 缺省/形状不符兜底 null（Q2 评审：缺省时兑底文案）', () => {
    expect(extractRetryAfterSeconds(null)).toBeNull();
    expect(extractRetryAfterSeconds(undefined)).toBeNull();
    expect(extractRetryAfterSeconds('x')).toBeNull();
    expect(extractRetryAfterSeconds({})).toBeNull();
    expect(extractRetryAfterSeconds({ retryAfterSeconds: 0 })).toBeNull();
    expect(extractRetryAfterSeconds({ retryAfterSeconds: -3 })).toBeNull();
    expect(extractRetryAfterSeconds({ retryAfterSeconds: '8' })).toBeNull();
  });
});
