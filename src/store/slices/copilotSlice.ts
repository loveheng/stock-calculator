/**
 * @file copilotSlice.ts
 * @description Store Copilot 切片（P0）：页面上下文注册表、会话内存缓存（尾部 20 条）、
 *              提问/重发闭环（乐观更新 pending → ok/failed）、级联清理与墓碑对账、
 *              浮窗开关与知情同意。从 store/index.ts 装配。
 *              关键约束：
 *              - unregisterContext 仅在 owner 引用相等时注销（防路由竞态误删新页注册）；
 *              - 快照必须显式执行 getData()（命令式取数，禁闭包捕获组件态）；
 *              - 重发复用同 clientMessageId（幂等）并用最新快照重建（D7，旧 ephemeral 已焚毁）；
 *              - 离线级联删除失败落墓碑，ensureThreadLoaded 时对账补发（P2 #13 防复活）。
 * @layer Store (Slice)
 * @storage_impact 内存态为主；墓碑/知情同意经 copilotService 持久化到 localStorage。
 * @author 开发团队
 */

import type { StateCreator } from 'zustand';
import { ulid } from 'ulid';
import type { AppStore } from '../types';
import type { CopilotAskRequest, CopilotMessage } from '../../types/domain';
import {
  buildAskRequest,
  clearThread,
  fetchMessages,
  saveCopilotConsent,
  saveCopilotTombstones,
  sendQuestion,
  toCopilotError,
} from '../../services/copilotService';

/** 内存缓存上限：每会话仅保留尾部 20 条（更早历史经 keyset 分页从后端拉取） */
const THREAD_TAIL_LIMIT = 20;

/** 裁剪到尾部 N 条 */
function capThread(list: CopilotMessage[]): CopilotMessage[] {
  return list.length > THREAD_TAIL_LIMIT ? list.slice(list.length - THREAD_TAIL_LIMIT) : list;
}

/** 服务端消息行 → 本地 CopilotMessage（id 统一字符串化，status 缺省 ok） */
function fromServerMessage(m: {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  contextOverview?: string;
  timeAnchor?: string;
  clientMessageId?: string;
  status?: 'ok' | 'failed' | 'pending';
  ctime: number;
}): CopilotMessage {
  return {
    id: String(m.id),
    role: m.role,
    content: m.content,
    status: m.status ?? 'ok',
    contextOverview: m.contextOverview,
    timeAnchor: m.timeAnchor,
    clientMessageId: m.clientMessageId,
    ctime: m.ctime,
  };
}

export type CopilotSlice = Pick<
  AppStore,
  | 'registerContext'
  | 'unregisterContext'
  | 'ensureThreadLoaded'
  | 'sendMessage'
  | 'retryMessage'
  | 'clearCurrentThread'
  | 'purgeScopeOnEntityDelete'
  | 'setCopilotOpen'
  | 'acknowledgeConsent'
>;

export const createCopilotSlice: StateCreator<AppStore, [], [], CopilotSlice> = (set, get) => {
  /**
   * 发送/重发共享闭环：
   * - 成功 → user 行标 ok，追加 assistant 行（id = 后端消息 id 字符串化）；
   * - 失败 → user 行标 failed，写入 subCode 映射的 errorHint 与 retryable（「重发」按钮依据）。
   */
  const dispatchAsk = async (
    scopeId: string,
    request: CopilotAskRequest,
    userMsgId: string,
  ): Promise<void> => {
    try {
      const resp = await sendQuestion(scopeId, request);
      set((s) => ({
        threads: {
          ...s.threads,
          [scopeId]: capThread(
            (s.threads[scopeId] ?? [])
              .map((m) => (m.id === userMsgId ? { ...m, status: 'ok' as const } : m))
              .concat({
                id: String(resp.assistantMessageId),
                role: 'assistant',
                content: resp.content,
                status: 'ok',
                ctime: resp.ctime,
              }),
          ),
        },
      }));
    } catch (e) {
      const err = toCopilotError(e);
      set((s) => ({
        threads: {
          ...s.threads,
          [scopeId]: capThread(
            (s.threads[scopeId] ?? []).map((m) =>
              m.id === userMsgId ? { ...m, status: 'failed' as const, errorHint: err.hint, retryable: err.retryable } : m,
            ),
          ),
        },
      }));
    }
  };

  /** 将消息标回 pending 并清除失败痕迹（重发入口共用） */
  const markPending = (scopeId: string, userMsgId: string): void => {
    set((s) => ({
      threads: {
        ...s.threads,
        [scopeId]: (s.threads[scopeId] ?? []).map((m) => {
          if (m.id !== userMsgId) return m;
          const next: CopilotMessage = { ...m, status: 'pending' };
          delete next.errorHint;
          delete next.retryable;
          return next;
        }),
      },
    }));
  };

  return {
    registerContext: (snapshot) => {
      // 同 scopeId 覆盖幂等；activeScopeId 跟随最新挂载页面
      set((s) => ({
        registry: { ...s.registry, [snapshot.scopeId]: snapshot },
        activeScopeId: snapshot.scopeId,
      }));
    },

    unregisterContext: (scopeId, owner) => {
      set((s) => {
        // 引用不匹配 = 旧视图的迟到 cleanup，严禁误删新页注册（补丁规则 1）
        if (s.registry[scopeId] !== owner) return {};
        const registry = { ...s.registry };
        delete registry[scopeId];
        // 注销的就是激活 scope → 置空；若该页存在会话则记录归档提示（§7.3）
        if (s.activeScopeId !== scopeId) return { registry };
        return {
          registry,
          activeScopeId: null,
          lastArchived:
            (s.threads[scopeId]?.length ?? 0) > 0 ? { scopeId, title: owner.title } : s.lastArchived,
        };
      });
    },

    ensureThreadLoaded: async (scopeId) => {
      if (!scopeId) return;

      // ① 墓碑对账：离线级联删除未送达时补发 DELETE（P2 #13 防旧会话复活）
      if (get().deletedScopes.includes(scopeId)) {
        try {
          await clearThread(scopeId);
        } catch {
          return; // 补发失败：保留墓碑并拦截历史加载
        }
        const remaining = get().deletedScopes.filter((t) => t !== scopeId);
        saveCopilotTombstones(remaining);
        set({ deletedScopes: remaining });
      }

      // ② 已有内存缓存则跳过（D8：缓存优先，避免每次开浮窗都打后端）
      if ((get().threads[scopeId]?.length ?? 0) > 0) return;

      // ③ 拉取历史（尾部 20 条；加载失败静默，不阻塞新提问）
      try {
        const page = await fetchMessages(scopeId);
        set((s) => ({
          threads: { ...s.threads, [scopeId]: page.messages.map(fromServerMessage) },
        }));
      } catch {
        // 静默
      }
    },

    sendMessage: async (question) => {
      const s = get();
      if (s.sending) return; // 互斥锁：防并发重复提交
      const scopeId = s.activeScopeId;
      const snapshot = scopeId ? s.registry[scopeId] : undefined;
      if (!scopeId || !snapshot) return; // 当前页未注册上下文
      const trimmed = question.trim();
      if (!trimmed) return;

      set({ sending: true });
      try {
        // 显式执行命令式快照：getState() + 纯引擎重算，禁读组件闭包
        const data = snapshot.getData();
        const clientMessageId = ulid();
        const request = buildAskRequest(snapshot.title, trimmed, clientMessageId, data);
        const userMsg: CopilotMessage = {
          id: clientMessageId,
          role: 'user',
          content: trimmed,
          status: 'pending',
          contextOverview: request.contextOverview,
          timeAnchor: request.timeAnchor,
          clientMessageId,
          ctime: Math.floor(Date.now() / 1000),
        };
        set((st) => ({
          threads: { ...st.threads, [scopeId]: capThread([...(st.threads[scopeId] ?? []), userMsg]) },
        }));
        await dispatchAsk(scopeId, request, clientMessageId);
      } finally {
        set({ sending: false });
      }
    },

    retryMessage: async (messageId) => {
      const s = get();
      if (s.sending) return;
      const scopeId = s.activeScopeId;
      if (!scopeId) return;
      const target = (s.threads[scopeId] ?? []).find((m) => m.id === messageId);
      if (!target || target.status !== 'failed' || !target.retryable || !target.clientMessageId) return;
      const snapshot = s.registry[scopeId];
      if (!snapshot) return;

      set({ sending: true });
      try {
        // 重发必须重采最新快照（D7）：旧 ephemeral 明细已阅后即焚
        const data = snapshot.getData();
        const request = buildAskRequest(snapshot.title, target.content, target.clientMessageId, data);
        markPending(scopeId, messageId);
        await dispatchAsk(scopeId, request, messageId);
      } finally {
        set({ sending: false });
      }
    },

    clearCurrentThread: async () => {
      const scopeId = get().activeScopeId;
      if (scopeId) await get().purgeScopeOnEntityDelete(scopeId);
    },

    purgeScopeOnEntityDelete: async (scopeId) => {
      if (!scopeId) return;
      // ① 本地立即清空（UI 即时反馈，不等网络）
      set((s) => {
        const threads = { ...s.threads };
        delete threads[scopeId];
        return { threads };
      });
      // ② 服务端软删除；失败落墓碑，待下次进入该 scope 时对账补发（P2 #13）
      try {
        await clearThread(scopeId);
      } catch {
        set((s) => {
          if (s.deletedScopes.includes(scopeId)) return {};
          const deletedScopes = [...s.deletedScopes, scopeId];
          saveCopilotTombstones(deletedScopes);
          return { deletedScopes };
        });
      }
    },

    setCopilotOpen: (open) => set({ copilotOpen: open }),

    acknowledgeConsent: () => {
      saveCopilotConsent(true);
      set({ consentAcknowledged: true });
    },
  };
};
