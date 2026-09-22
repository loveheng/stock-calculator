/**
 * @file PushNoticeCard.tsx
 * @description Web Push 推送通知设置区块：权限状态展示、订阅/退订开关，以及
 *              消息面板（未读徽标 + 最近 50 条列表 + 全部已读）——推送漏达时
 *              打开页面即可拉取服务端落库消息，双通道互补。
 *              iOS 16.4+ 需先「添加到主屏幕」才支持推送；不支持环境整体降级隐藏。
 * @layer UI
 * @storage_impact 无直接持久化；订阅与消息状态经 pushService 与浏览器 PushManager/服务端交互。
 * @author 开发团队
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff, Loader2, AlertTriangle, ChevronDown, ChevronUp, MailOpen } from 'lucide-react';
import {
  isPushSupported, getNotificationPermission,
  subscribeToPush, unsubscribeFromPush, getExistingSubscription,
  fetchPushMessages, fetchUnreadCount, markAllMessagesRead,
  type PushMessageItem,
} from '../../services/pushService';
import { useAuthStore } from '../../store/useAuthStore';

/**
 * 推送通知设置卡片（WebDAVConfig 设置页内嵌区块）。
 * 登录后打开页面即拉取未读数；展开面板加载消息列表。
 */
export function PushNoticeCard() {
  const is_logged_in = useAuthStore((s) => s.isAuthenticated);
  const [supported] = useState(isPushSupported);
  const [permission, setPermission] = useState<string>(() => getNotificationPermission());
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 消息面板状态
  const [expanded, setExpanded] = useState(false);
  const [unread, setUnread] = useState(0);
  const [messages, setMessages] = useState<PushMessageItem[] | null>(null);
  const [listLoading, setListLoading] = useState(false);

  useEffect(() => {
    if (!supported) return;
    getExistingSubscription().then((sub) => setSubscribed(!!sub)).catch(() => undefined);
  }, [supported]);

  // 登录后打开页面即拉未读数（漏达补拉通道的入口信号）；
  // 多端未读对齐不用 SSE 长连接——页面重新可见/聚焦时重拉一次即可（秒级延迟足够）
  useEffect(() => {
    if (!is_logged_in) return;
    const refresh = () => fetchUnreadCount().then(setUnread).catch(() => undefined);
    refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [is_logged_in]);

  // 展开面板时拉取消息列表
  const onToggleExpand = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      if (next && messages === null) {
        setListLoading(true);
        fetchPushMessages()
          .then(setMessages)
          .catch(() => setMessages([]))
          .finally(() => setListLoading(false));
      }
      return next;
    });
  }, [messages]);

  const onToggle = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (subscribed) {
        await unsubscribeFromPush();
        setSubscribed(false);
      } else {
        const p = await subscribeToPush();
        setPermission(p);
        setSubscribed(p === 'granted' && !!(await getExistingSubscription()));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }, [subscribed]);

  const onMarkAllRead = useCallback(async () => {
    try {
      await markAllMessagesRead();
      setUnread(0);
      setMessages((prev) =>
        prev ? prev.map((m) => ({ ...m, readAt: m.readAt ?? new Date().toISOString() })) : prev,
      );
    } catch {
      // 已读失败不阻塞 UI（下次打开重拉）
    }
  }, []);

  if (!supported) return null; // 环境不支持（含 iOS 浏览器内打开）→ 整块隐藏

  const denied = permission === 'denied';

  return (
    <div className="bg-slate-800/60 rounded-xl p-4 border border-slate-700">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {subscribed ? <Bell className="w-4 h-4 text-blue-400" /> : <BellOff className="w-4 h-4 text-slate-500" />}
          <div>
            <div className="text-sm font-medium text-slate-200">推送通知</div>
            <div className="text-xs text-slate-500">
              {subscribed ? '已订阅，服务端可推送提醒' : denied ? '通知权限被拒绝，请到系统设置开启' : '开启后可接收提醒推送'}
            </div>
          </div>
        </div>
        {is_logged_in ? (
          <button onClick={onToggle} disabled={busy || denied}
            className="px-3 py-1.5 text-xs rounded-lg bg-blue-600/20 text-blue-400 border border-blue-600/30 hover:bg-blue-600/30 disabled:opacity-40 flex items-center gap-1.5 transition-colors">
            {busy && <Loader2 className="w-3 h-3 animate-spin" />}
            {subscribed ? '关闭推送' : '开启推送'}
          </button>
        ) : (
          <span className="text-xs text-slate-500">登录后可用</span>
        )}
      </div>
      {error && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-400">
          <AlertTriangle className="w-3 h-3" />{error}
        </div>
      )}

      {/* 消息面板（登录后可见）：未读徽标 + 列表 + 全部已读 */}
      {is_logged_in && (
        <div className="mt-3 border-t border-slate-700/60 pt-3">
          <button onClick={onToggleExpand}
            className="w-full flex items-center justify-between text-xs text-slate-400 hover:text-slate-200 transition-colors">
            <span className="flex items-center gap-1.5">
              通知消息
              {unread > 0 && (
                <span className="inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-red-500/80 text-[10px] text-white">
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </span>
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>

          {expanded && (
            <div className="mt-2 space-y-1.5 max-h-64 overflow-y-auto">
              {listLoading && (
                <div className="flex items-center justify-center py-4 text-slate-500">
                  <Loader2 className="w-4 h-4 animate-spin" />
                </div>
              )}
              {!listLoading && messages !== null && messages.length === 0 && (
                <div className="py-4 text-center text-xs text-slate-500">暂无消息</div>
              )}
              {!listLoading && messages !== null && messages.length > 0 && (
                <>
                  {messages.map((m) => (
                    <a key={m.id} href={m.url || '#'}
                      className={`block rounded-lg px-3 py-2 transition-colors ${m.readAt ? 'bg-slate-800/40' : 'bg-blue-600/10 border border-blue-600/20'}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-xs font-medium truncate ${m.readAt ? 'text-slate-400' : 'text-slate-200'}`}>{m.title}</span>
                        {!m.readAt && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />}
                      </div>
                      <div className="text-xs text-slate-500 line-clamp-2 mt-0.5">{m.body}</div>
                      <div className="text-[10px] text-slate-600 mt-1">{new Date(m.createdAt).toLocaleString()}</div>
                    </a>
                  ))}
                  {unread > 0 && (
                    <button onClick={onMarkAllRead}
                      className="w-full flex items-center justify-center gap-1.5 py-2 text-xs text-slate-400 hover:text-slate-200 transition-colors">
                      <MailOpen className="w-3 h-3" />全部已读
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
