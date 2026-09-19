/**
 * @file kgService.test.ts
 * @description 图谱服务层单测：请求底座（路径/query 拼接/Bearer 头、信封 200/40001/404/401、
 *              非信封 HTTP 状态、网络异常文案）、四端点归一（脏行丢弃 / 类型窄化兜底 /
 *              date 空串保留 / anchorId 数字转字符串 / suggest 空白短路不发请求）。
 *              运行环境：Node；fetch 以 vi.stubGlobal 替换，Response 为手写假对象。
 * @layer 测试
 * @author 开发团队
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError, SessionExpiredError } from '../services/apiClient';
import {
  fetchKgEntityDetail,
  fetchKgEntitySuggest,
  fetchKgHotEntities,
  fetchKgTimeline,
} from '../services/kgService';

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

/** 最小合法事件行 */
function mkEvent(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    eventDate: '2023-09-10',
    eventTimeText: null,
    title: '事件 ' + id,
    detail: null,
    eventType: '其他',
    articleId: 100,
    entities: [],
    ...overrides,
  };
}

describe('fetchKgTimeline：请求构造与归一', () => {
  it('默认态无过滤参数：路径仅 /timeline，携带 Bearer', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { code: 200, message: 'success', data: { days: [], matchedEntities: [] } }),
    );
    await fetchKgTimeline(TOKEN, {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url.startsWith('/api/kg/timeline')).toBe(true);
    expect(url).not.toContain('?');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ' + TOKEN);
  });

  it('keyword + 分页参数正确拼入 query string', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { code: 200, message: 'success', data: { days: [], matchedEntities: [] } }),
    );
    await fetchKgTimeline(TOKEN, { keyword: '杭州 亚运', page: 2, pageSize: 3 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('keyword=' + encodeURIComponent('杭州 亚运'));
    expect(url).toContain('page=2');
    expect(url).toContain('pageSize=3');
  });

  it('entityId 参数拼入 query；响应归一：脏事件/空日组丢弃、date 空串保留', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        code: 200,
        message: 'success',
        data: {
          page: 0,
          pageSize: 3,
          totalDays: 1,
          hasMore: false,
          matchedEntities: [
            { id: 31, name: '亚运', entityType: 'EVENT', anchorType: 'CLS_SUBJECT', mentionCount: 4 },
            null, // 脏行丢弃
            { name: '缺 id', entityType: 'ORG', mentionCount: 1 }, // 缺 id 丢弃
          ],
          days: [
            {
              articleId: 1,
              date: '',
              articleTitle: '标题',
              eventCount: 2,
              events: [
                mkEvent(57),
                { id: 58, title: '' }, // 缺标题丢弃
                null, // 脏行丢弃
              ],
            },
            { articleId: 2, date: '2023-09-09', articleTitle: '空日组', eventCount: 0, events: [] }, // 空日组丢弃
          ],
        },
      }),
    );
    const result = await fetchKgTimeline(TOKEN, { entityId: 31 });
    expect(fetchMock.mock.calls[0][0] as string).toContain('entityId=31');
    expect(result.matchedEntities).toHaveLength(1);
    expect(result.matchedEntities[0].mentionCount).toBe(4);
    expect(result.days).toHaveLength(1);
    expect(result.days[0].date).toBe(''); // 空串保留，前端防御展示
    expect(result.days[0].events).toHaveLength(1);
    expect(result.days[0].events[0].id).toBe(57);
    expect(result.totalDays).toBe(1);
    expect(result.hasMore).toBe(false);
  });

  it('实体类型契约外值窄化为 OTHER（行保留）', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        code: 200,
        message: 'success',
        data: {
          days: [
            {
              articleId: 1,
              date: '2023-09-10',
              articleTitle: 't',
              eventCount: 1,
              events: [mkEvent(1, { entities: [{ id: 5, name: 'X', entityType: 'NEW_TYPE', anchorType: 'bad' }] })],
            },
          ],
        },
      }),
    );
    const result = await fetchKgTimeline(TOKEN, {});
    expect(result.days[0].events[0].entities[0].entityType).toBe('OTHER');
    expect(result.days[0].events[0].entities[0].anchorType).toBeNull();
  });

  it('信封业务错误（40001/500）→ AuthApiError', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { code: 40001, message: '日期格式无效', data: null }),
    );
    await expect(fetchKgTimeline(TOKEN, {})).rejects.toMatchObject({ code: 40001 });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { code: 500, message: 'boom', data: null }));
    await expect(fetchKgTimeline(TOKEN, {})).rejects.toBeInstanceOf(AuthApiError);
  });

  it('信封 401 → SessionExpiredError（静默降级依据）', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { code: 401, message: '会话失效', data: null }));
    await expect(fetchKgTimeline(TOKEN, {})).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('非信封 HTTP 401（拦截器直写）→ SessionExpiredError', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }, 'text/html'));
    await expect(fetchKgTimeline(TOKEN, {})).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('网络失败 → 网络异常文案', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(fetchKgTimeline(TOKEN, {})).rejects.toThrow('网络异常');
  });
});

describe('suggest / hot / detail', () => {
  it('suggest 空白 keyword 短路返回空数组（不发请求）', async () => {
    const list = await fetchKgEntitySuggest(TOKEN, '   ');
    expect(list).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('suggest 正常取数：keyword + limit 拼入 query，脏行过滤', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        code: 200,
        message: 'success',
        data: [
          { id: 31, name: '杭州第19届亚洲运动会', entityType: 'EVENT', anchorType: 'CLS_SUBJECT', mentionCount: 4 },
          { id: 32, name: '', mentionCount: 9 }, // 缺 name 丢弃
        ],
      }),
    );
    const list = await fetchKgEntitySuggest(TOKEN, '杭州亚运会', 10);
    expect(fetchMock.mock.calls[0][0] as string).toBe(
      '/api/kg/entities/suggest?keyword=' + encodeURIComponent('杭州亚运会') + '&limit=10',
    );
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('杭州第19届亚洲运动会');
  });

  it('hot：limit 参数生效，mentionCount 缺省兜底 0', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        code: 200,
        message: 'success',
        data: [{ id: 1, name: '习近平', entityType: 'PERSON', anchorType: null }],
      }),
    );
    const list = await fetchKgHotEntities(TOKEN, 20);
    expect(fetchMock.mock.calls[0][0] as string).toBe('/api/kg/entities/hot?limit=20');
    expect(list[0].mentionCount).toBe(0);
  });

  it('detail：路径含实体 id；anchorId 数字转字符串；aliases 过滤非字符串', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        code: 200,
        message: 'success',
        data: {
          id: 31,
          name: '杭州第19届亚洲运动会',
          entityType: 'EVENT',
          anchorType: 'CLS_SUBJECT',
          anchorId: 9213,
          aliases: ['杭州亚运会', '', 42 as unknown as string],
          mentionCount: 4,
          eventCount: 4,
          firstSeenAt: '2023-09-08',
          lastSeenAt: '2023-09-15',
          relatedEntities: [{ id: 1, name: '习近平', entityType: 'PERSON', anchorType: null, coMentionCount: 2 }],
        },
      }),
    );
    const detail = await fetchKgEntityDetail(TOKEN, 31);
    expect(fetchMock.mock.calls[0][0] as string).toBe('/api/kg/entities/31');
    expect(detail.anchorId).toBe('9213');
    expect(detail.aliases).toEqual(['杭州亚运会']);
    expect(detail.relatedEntities[0].coMentionCount).toBe(2);
  });

  it('detail 实体不存在：信封 code=404 → AuthApiError', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { code: 404, message: '实体不存在', data: null }));
    await expect(fetchKgEntityDetail(TOKEN, 999)).rejects.toMatchObject({ code: 404 });
  });
});
