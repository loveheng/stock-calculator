/**
 * @file pushService.ts
 * @description PWA Web Push 订阅服务：权限请求 → pushManager.subscribe(VAPID 公钥) →
 *              订阅三元组（endpoint/p256dh/auth）上报服务端登记；注销反向同步。
 *              兼容性：iOS 16.4+ 要求「已添加到主屏幕」的 standalone PWA 才暴露
 *              PushManager；Android 走 FCM Web Push（谷歌标准通道）。
 * @layer Service
 * @storage_impact 无 IndexedDB 读写；订阅状态由浏览器/推送服务持有，服务端存 push_subscription 表。
 * @author 开发团队
 */

import { apiRequest, AUTH_API_BASE_URL } from './apiClient';
import { loadStoredAuthSession } from './authSession';

/** 推送 API 基址（与 auth 同源网关，默认 /api/push） */
const PUSH_API_BASE_URL: string = import.meta.env.VITE_PUSH_API_BASE_URL ?? '/api/push';

/** 浏览器是否支持 Web Push（iOS 需 standalone 模式） */
export function isPushSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  // iOS 16.4+：仅 standalone（已添加到主屏幕）可见推送能力
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  const isIOS = /iPad|iPhone|iPod/.test(window.navigator.userAgent);
  if (isIOS) return standalone;
  return true;
}

/** 当前通知权限 */
export function getNotificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/** base64url（无填充）→ Uint8Array，用于 applicationServerKey */
function base64UrlToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  // 显式 ArrayBuffer 泛型：TS 5.7+ 的 Uint8Array<ArrayBufferLike> 不满足 BufferSource 约束
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

/** 从服务端取 VAPID 公钥（避免硬编码进构建产物） */
async function fetchVapidPublicKey(): Promise<string> {
  const resp = await fetch(`${PUSH_API_BASE_URL}/vapid-public-key`, {
    headers: authHeaders(),
  });
  const body = (await resp.json()) as { code: number; data: string };
  if (!resp.ok || body.code !== 200) throw new Error(`获取 VAPID 公钥失败: ${body.code}`);
  return body.data;
}

/** 会话鉴权头（未登录为空对象） */
function authHeaders(): Record<string, string> {
  const session = loadStoredAuthSession();
  return session ? { Authorization: `Bearer ${session.token}` } : {};
}

/** 订阅三元组上报服务端登记（幂等 upsert） */
async function reportSubscription(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('订阅缺少必要密钥（endpoint/p256dh/auth）');
  }
  await fetch(`${PUSH_API_BASE_URL}/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth }),
  }).then(async (resp) => {
    if (!resp.ok) throw new Error(`订阅登记失败: ${resp.status}`);
  });
}

/**
 * 完整订阅流程：请求权限 → SW 就绪 → pushManager.subscribe → 上报登记。
 *
 * @returns 最终权限状态；'denied' 时调用方应提示去系统设置开启
 * @throws 订阅失败（网络/服务端/浏览器不支持）时抛出
 */
export async function subscribeToPush(): Promise<NotificationPermission> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission;

  const registration = await navigator.serviceWorker.ready;
  const applicationServerKey = base64UrlToUint8Array(await fetchVapidPublicKey());
  // userVisibleOnly 必须为 true：浏览器强制推送必须伴随可见通知（防静默骚扰）
  const sub = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });
  await reportSubscription(sub);
  return permission;
}

/**
 * 注销推送：先浏览器退订，再同步服务端（尽力而为，服务端失败不阻塞）。
 */
export async function unsubscribeFromPush(): Promise<void> {
  const registration = await navigator.serviceWorker.ready;
  const sub = await registration.pushManager.getSubscription();
  if (sub) {
    await sub.unsubscribe().catch(() => undefined);
    await fetch(`${PUSH_API_BASE_URL}/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => undefined);
  }
}

/** 查询当前是否已存在有效订阅（浏览器侧，不查服务端） */
export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

// ---------- 消息拉取通道（推送漏达兜底：打开 PWA 拉未读） ----------

/** 服务端落库的推送消息（与推送 payload 同构，另带已读时间与落库时间） */
export interface PushMessageItem {
  id: number;
  title: string;
  body: string;
  url: string | null;
  readAt: string | null;
  createdAt: string;
}

/** 解析 ApiResponse 信封，非 200 抛错 */
async function unwrap<T>(resp: Response): Promise<T> {
  const body = (await resp.json()) as { code: number; data: T };
  if (!resp.ok || body.code !== 200) throw new Error(`推送消息接口失败: ${body.code ?? resp.status}`);
  return body.data;
}

/** 消息列表（最近 50 条，倒序） */
export async function fetchPushMessages(): Promise<PushMessageItem[]> {
  const resp = await fetch(`${PUSH_API_BASE_URL}/messages`, { headers: authHeaders() });
  return unwrap<PushMessageItem[]>(resp);
}

/** 未读数（角标） */
export async function fetchUnreadCount(): Promise<number> {
  const resp = await fetch(`${PUSH_API_BASE_URL}/messages/unread-count`, { headers: authHeaders() });
  return unwrap<number>(resp);
}

/** 全部标记已读（幂等） */
export async function markAllMessagesRead(): Promise<void> {
  const resp = await fetch(`${PUSH_API_BASE_URL}/messages/read-all`, {
    method: 'POST',
    headers: authHeaders(),
  });
  await unwrap<null>(resp);
}
