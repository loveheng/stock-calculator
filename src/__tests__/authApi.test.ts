/**
 * @file authApi.test.ts
 * @description authApi / apiClient 单元测试（stub 全局 fetch，响应均为 Node 原生 Response）：
 *              - 信封解析：code 200 → 返回 data
 *              - 业务错误：409 / 400 → AuthApiError（code/message/data 原样透传）
 *              - 会话失效：HTTP 401 拦截器响应 → SessionExpiredError
 *              - 请求形态：URL、方法、Bearer 注入、If-Match 头、请求体
 *              - 网络失败 / 非 JSON 响应 → 用户可读中文错误
 * @layer Test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getProfile,
  login,
  putProfile,
  recoveryConfirm,
  recoveryRequest,
  recoveryVerify,
  register,
} from '../services/authApi';
import { AuthApiError, SessionExpiredError } from '../services/apiClient';
import type { ProfilePayloads } from '../types/auth';

const SESSION = {
  userId: 'u-1',
  token: 'tok',
  expiresAt: '2026-09-07T00:00:00+08:00',
  hasProfile: null,
};

const PAYLOADS: ProfilePayloads = {
  passwordPayload: 'p',
  passwordIv: 'i',
  recoveryPayload: 'r',
  recoveryIv: 'v',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function okEnvelope(data: unknown): Response {
  return jsonResponse({ code: 200, message: 'success', data });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('register / login', () => {
  it('信封 code 200 → 返回 data，请求体形态正确', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(SESSION));
    vi.stubGlobal('fetch', fetchMock);

    await expect(register('user@test.com', 'a'.repeat(64))).resolves.toEqual(SESSION);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/register');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ email: 'user@test.com', password: 'a'.repeat(64) });
  });

  it('409 邮箱已注册 → AuthApiError（message 透传）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ code: 409, message: '该邮箱已注册', data: null })),
    );
    await expect(register('user@test.com', 'a'.repeat(64))).rejects.toMatchObject({
      name: 'AuthApiError',
      code: 409,
      message: '该邮箱已注册',
    });
  });

  it('登录请求体携带 ttlDays，hasProfile 三态透传', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okEnvelope({ ...SESSION, hasProfile: false }));
    vi.stubGlobal('fetch', fetchMock);

    const resp = await login('u@t.com', 'a'.repeat(64), 30);
    expect(resp.hasProfile).toBe(false);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      email: 'u@t.com',
      password: 'a'.repeat(64),
      ttlDays: 30,
    });
  });

  it('400 统一文案（邮箱或密码错误，防枚举）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ code: 400, message: '邮箱或主密码错误' })),
    );
    await expect(login('u@t.com', 'b'.repeat(64), 7)).rejects.toBeInstanceOf(AuthApiError);
  });
});

describe('getProfile / putProfile', () => {
  it('GET 携带 Bearer，updatedAt 透传', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okEnvelope({ ...PAYLOADS, updatedAt: '2026-08-31T05:25:17.230304Z' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const resp = await getProfile('tok-1');
    expect(resp.updatedAt).toBe('2026-08-31T05:25:17.230304Z');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/profile');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tok-1');
  });

  it('PUT 无 If-Match 时不带该头；带 If-Match 时回传', async () => {
    // mockImplementation 每次调用返回全新 Response（body 只能读一次）
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(okEnvelope({ ...PAYLOADS, updatedAt: 'v1' })));
    vi.stubGlobal('fetch', fetchMock);

    await putProfile('tok', PAYLOADS, null);
    const [url1, init1] = fetchMock.mock.calls[0];
    expect(url1).toContain('/profile');
    expect(init1.method).toBe('PUT');
    expect(init1.headers['If-Match']).toBeUndefined();
    expect(JSON.parse(init1.body)).toEqual(PAYLOADS);

    const version = '2026-08-31T05:25:17.230304Z';
    await putProfile('tok', PAYLOADS, version);
    const init2 = fetchMock.mock.calls[1][1];
    expect(init2.headers['If-Match']).toBe(version);
  });

  it('409 版本冲突 → AuthApiError.data 携带服务端版本', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ code: 409, message: '档案版本冲突，请以助记词恢复', data: { updatedAt: 'server-v' } }),
      ),
    );
    const err = await putProfile('tok', PAYLOADS, 'stale').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthApiError);
    expect((err as AuthApiError).code).toBe(409);
    expect((err as AuthApiError).data).toEqual({ updatedAt: 'server-v' });
  });

  it('404 档案缺行（合法中间态）→ AuthApiError code 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ code: 404, message: '用户档案尚未创建' })),
    );
    await expect(getProfile('tok')).rejects.toMatchObject({ code: 404 });
  });
});

describe('recovery 三步', () => {
  it('request / verify / confirm 请求体与 Bearer 正确', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(okEnvelope(SESSION)));
    vi.stubGlobal('fetch', fetchMock);

    await recoveryRequest('u@t.com');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ email: 'u@t.com' });

    await recoveryVerify('u@t.com', '123456');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      email: 'u@t.com',
      code: '123456',
    });

    await recoveryConfirm('recovery-token', 'a'.repeat(64), {
      passwordPayload: 'p',
      passwordIv: 'i',
    });
    const [url, init] = fetchMock.mock.calls[2];
    expect(url).toContain('/recovery/confirm');
    expect(init.headers.Authorization).toBe('Bearer recovery-token');
    expect(JSON.parse(init.body)).toEqual({
      newPassword: 'a'.repeat(64),
      passwordPayload: 'p',
      passwordIv: 'i',
    });
  });

  it('验证码错误 400 → AuthApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ code: 400, message: '验证码错误或已过期' })),
    );
    await expect(recoveryVerify('u@t.com', '000000')).rejects.toMatchObject({ code: 400 });
  });
});

describe('错误处理', () => {
  it('HTTP 401 拦截器响应 → SessionExpiredError（code 401）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ code: 401, message: '会话无效' }, 401)),
    );
    await expect(getProfile('dead-token')).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('fetch 网络失败 → 用户可读网络异常', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(getProfile('tok')).rejects.toThrow('网络异常');
  });

  it('非 JSON 响应 → 服务响应异常', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html></html>', { status: 200 })));
    await expect(getProfile('tok')).rejects.toThrow('服务响应异常');
  });

  it('JSON 但缺 code 字段 → 服务响应格式异常', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ foo: 1 })));
    await expect(getProfile('tok')).rejects.toThrow('服务响应格式异常');
  });
});
