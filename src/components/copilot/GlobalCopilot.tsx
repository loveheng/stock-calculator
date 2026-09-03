/**
 * @file GlobalCopilot.tsx
 * @description Context-Aware Copilot 全局浮窗（P0）：折叠态悬浮按钮 + 展开态对话面板。
 *              - 折叠态：右下角常驻按钮；未登录点击转登录弹窗（D19，不静默）；
 *              - 展开态：顶部上下文胶囊（已关联页面标题）+ 清空会话（ConfirmModal 二次确认 D18）
 *                + 折叠按钮；切页归档指示条（§7.3）与离线指示条；
 *              - 消息列表：纯文本渲染（whitespace-pre-wrap）、失败红框 + subCode 提示 + 可重发、
 *                user 行底部回显 contextOverview 概览与 timeAnchor 标签（D32：V1 仅概览，不做明细重放）；
 *              - 输入区：Enter 发送 / Shift+Enter 换行（含 IME 组合输入守卫），sending/离线禁用；
 *              - 首次使用知情同意弹窗（localStorage 持久化）。
 * @layer UI
 * @storage_impact 不直接读写 IndexedDB；会话状态经 store（copilotSlice），
 *                 墓碑/知情同意由 copilotService 持久化到 localStorage。
 * @author 开发团队
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Sparkles,
  Paperclip,
  Trash2,
  ChevronDown,
  RefreshCw,
  WifiOff,
  X,
} from 'lucide-react';
import { useAppStore } from '../../store';
import { useAuthStore } from '../../store/useAuthStore';
import ConfirmModal from '../ui/ConfirmModal';
import type { CopilotMessage } from '../../types/domain';

/** 空数组常量：避免 zustand selector 每次返回新引用触发多余重渲染 */
const EMPTY_MESSAGES: CopilotMessage[] = [];

/** timeAnchor.range → 中文标签（解析失败返回 null，不出标签） */
function formatAnchorLabel(timeAnchor?: string): string | null {
  if (!timeAnchor) return null;
  try {
    const parsed = JSON.parse(timeAnchor) as { range?: string };
    if (!parsed?.range) return null;
    const map: Record<string, string> = {
      all: '全量',
      '7d': '近7天',
      '30d': '近30天',
      month: '本月',
      today: '今日',
      '1d': '今日',
      now: '当前',
    };
    return map[parsed.range] ?? parsed.range;
  } catch {
    return null;
  }
}

/** 概览字段 → 中文标签（未登记字段回退原键名） */
const OVERVIEW_LABELS: Record<string, string> = {
  roundCount: '轮数',
  completedRoundCount: '已完成轮',
  activeRoundCount: '进行中轮',
  winRate: '胜率',
  totalNetProfit: '总净收益',
  avgNetPerRound: '轮均净收益',
  pendingRealizedPnl: '在途盈亏',
  totalFees: '费用',
  positionCount: '持仓数',
  openPositionCount: '持仓中',
  closedPositionCount: '已平仓',
  totalMarketValue: '市值(成本)',
  totalRealizedPnL: '已实现盈亏',
  activePlanCount: '计划单',
};

/** contextOverview JSON → 紧凑摘要（解析失败回退原文截断） */
function formatOverview(overview?: string): string | null {
  if (!overview) return null;
  try {
    const obj = JSON.parse(overview) as Record<string, unknown>;
    const text = Object.entries(obj)
      .map(([k, v]) => `${OVERVIEW_LABELS[k] ?? k}=${String(v)}`)
      .join(' · ');
    return text.length > 72 ? `${text.slice(0, 72)}…` : text || null;
  } catch {
    return overview.length > 72 ? `${overview.slice(0, 72)}…` : overview;
  }
}

/** 消息气泡：user 右蓝 / assistant 左灰；failed 红框 + 提示 + 可重发 */
function MessageBubble({ message, sending, onRetry }: {
  message: CopilotMessage;
  sending: boolean;
  onRetry: (id: string) => void;
}) {
  const isUser = message.role === 'user';
  const overviewText = isUser ? formatOverview(message.contextOverview) : null;
  const anchorText = isUser ? formatAnchorLabel(message.timeAnchor) : null;

  return (
    <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
      <div
        className={`max-w-[85%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words ${
          isUser
            ? 'bg-blue-600 text-white rounded-br-sm'
            : 'bg-slate-800 border border-slate-700 text-slate-200 rounded-bl-sm'
        } ${message.status === 'failed' ? '!border-red-500/70' : ''} ${
          message.status === 'pending' ? 'opacity-60 animate-pulse' : ''
        }`}
      >
        {message.content}
      </div>

      {/* 失败提示 + 重发（subCode 交互指引闭环） */}
      {message.status === 'failed' && (
        <div className="mt-1 flex items-center gap-2 max-w-[85%]">
          <span className="text-xs text-red-400">{message.errorHint ?? '发送失败，请稍后重试'}</span>
          {message.retryable && (
            <button
              onClick={() => onRetry(message.id)}
              disabled={sending}
              className="flex items-center gap-1 px-2 py-0.5 rounded-md border border-red-500/50 text-red-400 text-xs hover:bg-red-500/10 disabled:opacity-40 transition-colors"
            >
              <RefreshCw className="w-3 h-3" />
              重发
            </button>
          )}
        </div>
      )}

      {/* user 行回显概览 + 时间锚点（D32：V1 仅标量概览卡片，无明细重放） */}
      {isUser && (overviewText || anchorText) && (
        <div className="mt-0.5 text-[10px] text-slate-500 max-w-[85%] break-all">
          {overviewText && <span>📊 {overviewText}</span>}
          {overviewText && anchorText && <span> ｜ </span>}
          {anchorText && <span>⏱ {anchorText}</span>}
        </div>
      )}
    </div>
  );
}

export default function GlobalCopilot() {
  const copilotOpen = useAppStore((s) => s.copilotOpen);
  const setCopilotOpen = useAppStore((s) => s.setCopilotOpen);
  const activeScopeId = useAppStore((s) => s.activeScopeId);
  const capsuleTitle = useAppStore((s) => (s.activeScopeId ? s.registry[s.activeScopeId]?.title : undefined));
  const thread = useAppStore((s) => (s.activeScopeId ? s.threads[s.activeScopeId] : undefined));
  const messages = thread ?? EMPTY_MESSAGES;
  const sending = useAppStore((s) => s.sending);
  const lastArchived = useAppStore((s) => s.lastArchived);
  const consentAcknowledged = useAppStore((s) => s.consentAcknowledged);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const retryMessage = useAppStore((s) => s.retryMessage);
  const clearCurrentThread = useAppStore((s) => s.clearCurrentThread);
  const ensureThreadLoaded = useAppStore((s) => s.ensureThreadLoaded);
  const acknowledgeConsent = useAppStore((s) => s.acknowledgeConsent);

  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setAuthModalOpen = useAuthStore((s) => s.setAuthModalOpen);

  const [draft, setDraft] = useState('');
  const [online, setOnline] = useState(true);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [archiveDismissed, setArchiveDismissed] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const offline = !online;

  // 离线/上线监听（弱网提示条）
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  // 会话加载：浮窗展开 + 已登录 + 存在激活 scope 时拉取（墓碑对账在 slice 内处理）
  useEffect(() => {
    if (!copilotOpen || !isAuthenticated || !activeScopeId) return;
    void ensureThreadLoaded(activeScopeId);
  }, [copilotOpen, isAuthenticated, activeScopeId, ensureThreadLoaded]);

  // 切页或归档提示变化时重置关闭态
  useEffect(() => {
    setArchiveDismissed(false);
  }, [activeScopeId, lastArchived?.scopeId]);

  // 消息变化自动滚底
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, sending]);

  const handleSend = () => {
    const q = draft.trim();
    if (!q || sending || offline || !activeScopeId) return;
    setDraft('');
    void sendMessage(q);
  };

  const handleRetry = (messageId: string) => {
    if (sending) return;
    void retryMessage(messageId);
  };

  // ---- 折叠态：右下角悬浮按钮（未登录 → 登录弹窗，D19） ----
  if (!copilotOpen) {
    return (
      <button
        onClick={() => (isAuthenticated ? setCopilotOpen(true) : setAuthModalOpen(true))}
        title={isAuthenticated ? 'AI 助手' : '登录后使用 AI 助手'}
        className="fixed bottom-5 right-5 z-40 w-14 h-14 rounded-full bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/30 flex items-center justify-center transition-all hover:scale-105"
      >
        <Sparkles className="w-6 h-6" />
      </button>
    );
  }

  // ---- 展开态：对话面板 ----
  return (
    <div className="fixed bottom-20 right-5 z-40">
      <div className="relative flex flex-col w-[calc(100vw-2.5rem)] max-w-[380px] h-[520px] bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden">
        {/* 头部：上下文胶囊 + 清空 + 折叠 */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-slate-700 bg-slate-800/60">
          <div
            className={`flex items-center gap-1.5 min-w-0 px-2 py-1 rounded-full text-xs ${
              capsuleTitle ? 'bg-blue-600/20 text-blue-300' : 'bg-slate-700/60 text-slate-400'
            }`}
            title={capsuleTitle ? `当前上下文：${capsuleTitle}` : '当前页面未注册 AI 上下文'}
          >
            <Paperclip className="w-3 h-3 flex-shrink-0" />
            <span className="truncate">
              {capsuleTitle ? `已关联： ${capsuleTitle}` : '当前页面未接入 AI 上下文'}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => setClearConfirmOpen(true)}
              disabled={messages.length === 0}
              title="清空当前会话"
              className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-slate-700/60 disabled:opacity-30 disabled:hover:text-slate-400 disabled:hover:bg-transparent transition-colors"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button
              onClick={() => setCopilotOpen(false)}
              title="收起"
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-700/60 transition-colors"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 切页归档指示条（§7.3：内容按页面归档，未丢失） */}
        {lastArchived && lastArchived.scopeId !== activeScopeId && !archiveDismissed && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/20 text-[11px] text-amber-300">
            <span className="truncate">
              上一页对话已归档：{lastArchived.title}（回到该页可继续）
            </span>
            <button
              onClick={() => setArchiveDismissed(true)}
              className="ml-auto p-0.5 rounded hover:bg-amber-500/20 flex-shrink-0"
              title="关闭提示"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* 离线指示条 */}
        {offline && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 border-b border-red-500/20 text-[11px] text-red-300">
            <WifiOff className="w-3 h-3 flex-shrink-0" />
            网络已断开，发送与历史加载暂不可用
          </div>
        )}

        {/* 消息列表 */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
          {!activeScopeId || !capsuleTitle ? (
            <div className="h-full flex flex-col items-center justify-center text-center text-slate-500 text-sm gap-2 px-6">
              <Sparkles className="w-8 h-8 text-slate-600" />
              <p>当前页面暂未接入 AI 上下文</p>
              <p className="text-xs text-slate-600">P0 已支持：首页仪表盘、数据统计</p>
            </div>
          ) : messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center text-slate-500 text-sm gap-2 px-6">
              <Sparkles className="w-8 h-8 text-slate-600" />
              <p>询问当前页面的任何数据</p>
              <p className="text-xs text-slate-600">
                例如：「总结近期做T胜率」「市值变化如何？」
              </p>
            </div>
          ) : (
            <>
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} sending={sending} onRetry={handleRetry} />
              ))}
              {sending && (
                <div className="flex justify-start">
                  <div className="px-3 py-2 rounded-2xl rounded-bl-sm bg-slate-800 border border-slate-700 text-slate-400 text-sm animate-pulse">
                    正在思考…
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </>
          )}
        </div>

        {/* 输入区 */}
        <div className="p-2.5 border-t border-slate-700">
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              rows={2}
              disabled={!capsuleTitle}
              placeholder={
                capsuleTitle
                  ? `就「${capsuleTitle}」提问…（Enter 发送，Shift+Enter 换行）`
                  : '当前页面未接入 AI 上下文'
              }
              className="flex-1 resize-none bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-blue-500 disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={!draft.trim() || sending || offline || !capsuleTitle}
              className="px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-40 disabled:hover:bg-blue-600 transition-colors"
            >
              {sending ? '…' : '发送'}
            </button>
          </div>
        </div>

        {/* 首次使用知情同意（面板内覆盖层） */}
        {!consentAcknowledged && (
          <div className="absolute inset-0 z-10 bg-slate-900/95 backdrop-blur-sm flex flex-col items-center justify-center text-center px-6 gap-4">
            <Sparkles className="w-10 h-10 text-blue-500" />
            <h3 className="text-base font-bold text-white">使用 AI 助手前请确认</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              提问时，当前页面白名单内的业务数据摘要（标量概览与少量明细）将发送至 LLM
              服务商用于生成回答；问答历史按页面隔离保存，可随时一键清空。
              请勿在提问中输入密码、助记词等敏感信息。
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setCopilotOpen(false)}
                className="px-4 py-2 rounded-xl text-sm bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors"
              >
                暂不使用
              </button>
              <button
                onClick={acknowledgeConsent}
                className="px-4 py-2 rounded-xl text-sm bg-blue-600 hover:bg-blue-500 text-white transition-colors"
              >
                同意并开始使用
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 清空会话二次确认（D18） */}
      <ConfirmModal
        open={clearConfirmOpen}
        title="清空当前会话"
        message={`将删除「${capsuleTitle ?? '当前页面'}」的全部问答记录（含服务端历史），不可恢复。`}
        confirmLabel="清空"
        danger
        onConfirm={() => {
          setClearConfirmOpen(false);
          void clearCurrentThread();
        }}
        onCancel={() => setClearConfirmOpen(false)}
      />
    </div>
  );
}
