/**
 * @file monitorService.test.ts
 * @description 价格预告单三端点服务测试：请求体形态（direction 顶层 / alertRule 内嵌 / 跌破不带容差）、
 *              信封解析与错误分类（401 → SessionExpiredError、429 → MonitorLimitError、
 *              400 → MonitorBadRequestError 带后端文案、5xx/网络 → MonitorServiceError）、无会话拦截。
 * @layer Test
 * @storage_impact 无存储读写（会话经 vi.mock 桩，fetch 经 vi.stubGlobal 桩）。
 * @author 开发团队
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionExpiredError } from '../services/apiClient';
import {
  MONITOR_MAX_ALERTS,
  MONITOR_MAX_RUNNING,
  MonitorBadRequestError,
  MonitorLimitError,
  MonitorServiceError,
  listMonitor,
  startMonitor,
  stopMonitor,
} from '../services/monitorService';

/** 会话桩（可变，用于「无会话」用例） */
const { currentSession } = vi.hoisted(() => {
  const state: { session: unknown } = {
    session: { token: 'tk-1', userId: 'u-1', email: 'a@b.c', expiresAt: '2030-01-01T00:00:00.000Z' },
  };
  return { currentSession: state };
});

vi.mock('../services/authSession', () => ({
  loadStoredAuthSession: () => currentSession.session,
}));

const fetchMock = vi.fn();

/** 构造 HTTP 200 + 业务信封响应 */
function envelope(code: number, data: unknown, message = 'success'): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ code, message, data }),
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  currentSession.session = { token: 'tk-1', userId: 'u-1', email: 'a@b.c', expiresAt: '2030-01-01T00:00:00.000Z' };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startMonitor 请求形态', () => {
  it('direction 为顶层字段；区间型 alertRule 带 band', async () => {
    fetchMock.mockResolvedValue(envelope(200, { taskId: 12, status: 'RUNNING' }));

    const res = await startMonitor({
      fullCode: 'sh600519',
      direction: 'BUY',
      type: 'PRICE_NEAR',
      threshold: 1450,
      band: 20,
    });

    expect(res).toEqual({ taskId: 12, status: 'RUNNING' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/broker/monitor/start');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tk-1');
    expect(JSON.parse(init.body)).toEqual({
      fullCode: 'sh600519',
      interval: '1d',
      direction: 'BUY',
      alertRule: { type: 'PRICE_NEAR', threshold: 1450, band: 20 },
    });
  });

  it('跌破型不带 band（后端忽略该字段）', async () => {
    fetchMock.mockResolvedValue(envelope(200, { taskId: 9, status: 'RUNNING' }));
    await startMonitor({ fullCode: 'sz000001', direction: 'BUY', type: 'PRICE_BELOW', threshold: 10.5 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).alertRule).toEqual({
      type: 'PRICE_BELOW',
      threshold: 10.5,
    });
  });
});

describe('信封与错误分类', () => {
  it('code 200 → 返回 data', async () => {
    fetchMock.mockResolvedValue(
      envelope(200, { runningCount: 2, tasks: [{ taskId: 12, direction: 'BUY', alertCount: 1 }] }),
    );
    const data = await listMonitor();
    expect(data.runningCount).toBe(2);
    expect(data.tasks[0].alertCount).toBe(1);
  });

  it('code 400 → MonitorBadRequestError 且携带后端文案', async () => {
    fetchMock.mockResolvedValue(envelope(400, null, '未收录该股票'));
    await expect(
      startMonitor({ fullCode: 'sh999999', direction: 'BUY', type: 'PRICE_NEAR', threshold: 1, band: 0 }),
    ).rejects.toThrow(MonitorBadRequestError);
    await expect(
      startMonitor({ fullCode: 'sh999999', direction: 'BUY', type: 'PRICE_NEAR', threshold: 1, band: 0 }),
    ).rejects.toThrow('未收录该股票');
  });

  it('code 429 → MonitorLimitError（额度已满，提示先结束部分）', async () => {
    fetchMock.mockResolvedValue(envelope(429, null, 'too many'));
    await expect(
      startMonitor({ fullCode: 'sh600519', direction: 'BUY', type: 'PRICE_NEAR', threshold: 1450, band: 20 }),
    ).rejects.toBeInstanceOf(MonitorLimitError);
  });

  it('HTTP 401 与 code 401 均 → SessionExpiredError', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as unknown as Response);
    await expect(listMonitor()).rejects.toBeInstanceOf(SessionExpiredError);

    fetchMock.mockResolvedValue(envelope(401, null, '会话已失效'));
    await expect(listMonitor()).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('HTTP 500 / code 500 → MonitorServiceError', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    await expect(listMonitor()).rejects.toBeInstanceOf(MonitorServiceError);

    fetchMock.mockResolvedValue(envelope(500, null, 'boom'));
    await expect(listMonitor()).rejects.toBeInstanceOf(MonitorServiceError);
  });

  it('fetch reject（超时/网络故障）→ MonitorServiceError', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(listMonitor()).rejects.toBeInstanceOf(MonitorServiceError);
  });

  it('响应非信封（缺 code）→ MonitorServiceError', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: null }) } as unknown as Response);
    await expect(listMonitor()).rejects.toBeInstanceOf(MonitorServiceError);
  });

  it('无本地会话 → SessionExpiredError（登录前置，不发请求）', async () => {
    currentSession.session = null;
    await expect(listMonitor()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('stopMonitor', () => {
  it('POST /stop 携带 taskId，成功即 resolve（幂等）', async () => {
    fetchMock.mockResolvedValue(envelope(200, { status: 'STOPPED' }));
    await expect(stopMonitor(12)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/broker/monitor/stop');
    expect(JSON.parse(init.body)).toEqual({ taskId: 12 });
  });

  it('taskId 不属于当前用户（400）→ MonitorBadRequestError', async () => {
    fetchMock.mockResolvedValue(envelope(400, null, '预告单不存在'));
    await expect(stopMonitor(999)).rejects.toThrow('预告单不存在');
  });
});

describe('常量口径', () => {
  it('额度上限 5、单条提醒上限 3（与 docs/monitor 契约一致）', () => {
    expect(MONITOR_MAX_RUNNING).toBe(5);
    expect(MONITOR_MAX_ALERTS).toBe(3);
  });
});
