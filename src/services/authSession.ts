/**
 * @file authSession.ts
 * @description 会话令牌本地持久化（localStorage）：token/userId/email/expiresAt。
 *              等价 Supabase persistSession 的行为——令牌无条件持久化，
 *              "记住登录"仅控制 AuthDB 设备免密（MEK 恢复），与本存储无关。
 *              红线：此处只存会话令牌（服务端 256-bit 随机数），严禁存 MEK raw bytes /
 *              主密码 / 助记词 / 任何封装密文（封装密文仅落 AuthDB_v1.auth_meta）。
 * @layer Service
 * @storage_impact localStorage 单键读写；跨标签页通过 storage 事件同步（见 AuthGate）。
 */

export const AUTH_SESSION_STORAGE_KEY = 'stockcalc.e2ee.session.v1';

export interface StoredAuthSession {
  token: string;
  userId: string;
  /** 登录/注册时归一化的邮箱（后端不返回邮箱，用于 UI 展示与 KEK 派生 salt） */
  email: string;
  /** ISO-8601 过期时间（服务端签发） */
  expiresAt: string;
}

export function loadStoredAuthSession(): StoredAuthSession | null {
  try {
    const raw = localStorage.getItem(AUTH_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAuthSession>;
    if (!parsed.token || !parsed.userId || !parsed.email) return null;
    return parsed as StoredAuthSession;
  } catch {
    return null;
  }
}

export function saveStoredAuthSession(session: StoredAuthSession): void {
  localStorage.setItem(AUTH_SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearStoredAuthSession(): void {
  try {
    localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
  } catch {
    // 幂等
  }
}
