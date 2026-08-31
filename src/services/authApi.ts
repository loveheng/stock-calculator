/**
 * @file authApi.ts
 * @description E2EE 用户服务端点封装（接口文档 v1.0 §4）：
 *              注册 / 登录 / 登出 / 密文档案读写（If-Match 乐观锁）/ 找回三步。
 *              Supabase 兼容映射：signUp→register、signInWithPassword→login、
 *              signOut→logout、select→getProfile、upsert→putProfile、
 *              resetPasswordForEmail→recoveryRequest、verifyOtp→recoveryVerify、
 *              updateUser 由 recoveryConfirm 承担（服务端原子改密）。
 * @layer Service
 * @storage_impact 无直接持久化；令牌由调用方从 authSession 取得后传入。
 */

import { apiRequest } from './apiClient';
import type { AuthSessionResponse, ProfilePayloads, ProfileResponse } from '../types/auth';

/** 4.1 注册（注册即登录，TTL 固定 7 天）。password 为 64 位小写 hex authHash */
export function register(email: string, authHash: string): Promise<AuthSessionResponse> {
  return apiRequest<AuthSessionResponse>('/register', {
    method: 'POST',
    body: { email, password: authHash },
  });
}

/** 4.2 登录。ttlDays 由服务端夹取 [1,30]；hasProfile 三态驱动孤儿引导/补传分支 */
export function login(email: string, authHash: string, ttlDays: number): Promise<AuthSessionResponse> {
  return apiRequest<AuthSessionResponse>('/login', {
    method: 'POST',
    body: { email, password: authHash, ttlDays },
  });
}

/** 4.3 登出（幂等；仅吊销当前会话）。失败不向上抛（本地清理必须继续） */
export async function logout(token: string): Promise<void> {
  try {
    await apiRequest<null>('/logout', { method: 'POST', token });
  } catch {
    // 幂等：网络失败/令牌已失效均按登出成功处理
  }
}

/** 4.4 读密文档案。404 = 合法中间态（AuthApiError code 404），驱动孤儿引导/补传 */
export function getProfile(token: string): Promise<ProfileResponse> {
  return apiRequest<ProfileResponse>('/profile', { token });
}

/**
 * 4.5 写密文档案（upsert + If-Match 乐观锁）。
 * @param ifMatch 上一次响应（PUT/GET/409）的 updatedAt 原文；无版本（首建）时省略。
 *                注意：有行且 If-Match 缺失或不匹配 → 409（data.updatedAt 携带服务端最新版本）。
 */
export function putProfile(
  token: string,
  payloads: ProfilePayloads,
  ifMatch: string | null,
): Promise<ProfileResponse> {
  return apiRequest<ProfileResponse>('/profile', {
    method: 'PUT',
    token,
    body: payloads,
    headers: ifMatch ? { 'If-Match': ifMatch } : undefined,
  });
}

/** 4.6 请求找回验证码。未知邮箱也 200（防枚举）；429=冷却/限流；500=邮件发送失败 */
export function recoveryRequest(email: string): Promise<null> {
  return apiRequest<null>('/recovery/request', { method: 'POST', body: { email } });
}

/** 4.7 校验验证码 → 签发 recovery 受限会话（10 分钟硬过期，仅可调 confirm/logout） */
export function recoveryVerify(email: string, code: string): Promise<AuthSessionResponse> {
  return apiRequest<AuthSessionResponse>('/recovery/verify', {
    method: 'POST',
    body: { email, code },
  });
}

/**
 * 4.8 确认改密（recovery 会话鉴权；单事务原子：bcrypt 新 authHash → 更新 password 密文
 * → 吊销他端全部会话 → 签发全量新会话）。recovery_payload 不变（助记词未更换）。
 */
export function recoveryConfirm(
  recoveryToken: string,
  newPasswordHash: string,
  payloads: Pick<ProfilePayloads, 'passwordPayload' | 'passwordIv'>,
): Promise<AuthSessionResponse> {
  return apiRequest<AuthSessionResponse>('/recovery/confirm', {
    method: 'POST',
    token: recoveryToken,
    body: {
      newPassword: newPasswordHash,
      passwordPayload: payloads.passwordPayload,
      passwordIv: payloads.passwordIv,
    },
  });
}
