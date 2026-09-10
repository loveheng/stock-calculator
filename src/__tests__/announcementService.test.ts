/**
 * @file announcementService.test.ts
 * @description 公告订阅服务单元测试（fetch mock，不触网）：
 *              - fetchSubscriptions：信封 200 / string[]、{stockId}[]、{items:[...]} 三形状兼容解析 / 未知形状 recognized=false
 *              - subscribeStock：POST body { stockId } 与请求头
 *              - unsubscribeStock：DELETE 路径拼接
 *              - 401 → SessionExpiredError；信封 code 400 → AuthApiError（message 透出）
 * @layer Test
 * @storage_impact 纯函数测试，不触达网络与存储。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError, SessionExpiredError } from '../services/apiClient';
import {
  fetchSubscriptions,
  subscribeStock,
  unsubscribeStock,
} from '../services/announcementService';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const TOKEN = 'test-token';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchSubscriptions', () => {
  it('信封 200 + string[]：原样返回，GET 携带 Bearer token', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 200, message: 'ok', data: ['600745', 'sh601318'] }),
    );
    const parsed = await fetchSubscriptions(TOKEN);
    expect(parsed.stockIds).toEqual(['600745', 'sh601318']);
    expect(parsed.recognized).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/announcement/subscriptions');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ' + TOKEN);
  });

  it('兼容 { stockId }[] 形状：提取 stockId 字段', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        code: 200,
        message: 'ok',
        data: [{ stockId: '600745' }, { stockId: '000001' }, '300750'],
      }),
    );
    const parsed = await fetchSubscriptions(TOKEN);
    expect(parsed.stockIds).toEqual(['600745', '000001', '300750']);
    expect(parsed.recognized).toBe(true);
  });

  it('后端实际形状 { items: [{stockId,...}] }：提取 items 内 stockId 字段', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        code: 200,
        message: 'ok',
        data: {
          items: [
            { stockId: '600745', orgId: '9900040226', createdAt: '2026-09-01T10:00:00' },
            { stockId: '000001', orgId: '9900023851', createdAt: '2026-08-15T09:00:00' },
          ],
        },
      }),
    );
    const parsed = await fetchSubscriptions(TOKEN);
    expect(parsed.stockIds).toEqual(['600745', '000001']);
    expect(parsed.recognized).toBe(true);
  });

  it('items 内条目缺 stockId：跳过该条目，形状仍可识别', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 200, message: 'ok', data: { items: [{ orgId: 'x' }, { stockId: '600745' }] } }),
    );
    const parsed = await fetchSubscriptions(TOKEN);
    expect(parsed.stockIds).toEqual(['600745']);
    expect(parsed.recognized).toBe(true);
  });

  it('data null / 无 items 字段的对象：recognized=false（调用方保留重试机会，不得置「已加载」）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 200, message: 'ok', data: null }));
    expect(await fetchSubscriptions(TOKEN)).toEqual({ stockIds: [], recognized: false });
    fetchMock.mockResolvedValue(jsonResponse({ code: 200, message: 'ok', data: { foo: 1 } }));
    expect(await fetchSubscriptions(TOKEN)).toEqual({ stockIds: [], recognized: false });
  });
});

describe('subscribeStock', () => {
  it('POST body 携带 { stockId }，Content-Type 为 JSON', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 200, message: 'ok', data: null }));
    await subscribeStock(TOKEN, '600745');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/announcement/subscriptions');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ stockId: '600745' }));
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('业务错误（信封 code 400）：抛 AuthApiError 且 message 为后端文案', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 400, message: '订阅数量已达上限', data: null }));
    await expect(subscribeStock(TOKEN, '600745')).rejects.toThrow(AuthApiError);
    await expect(subscribeStock(TOKEN, '600745')).rejects.toThrow('订阅数量已达上限');
  });

  it('会话失效（信封 code 401）：抛 SessionExpiredError', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 401, message: '会话已失效', data: null }));
    await expect(subscribeStock(TOKEN, '600745')).rejects.toThrow(SessionExpiredError);
  });
});

describe('unsubscribeStock', () => {
  it('DELETE 拼接 stockId 路径', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 200, message: 'ok', data: null }));
    await unsubscribeStock(TOKEN, '600745');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/announcement/subscriptions/600745');
    expect(init.method).toBe('DELETE');
  });
});
