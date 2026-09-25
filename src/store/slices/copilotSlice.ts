/**
 * @file copilotSlice.ts
 * @description Store Copilot 切片：页面上下文注册表、区块聚焦态（V2 Click-to-Focus）、
 *              会话内存缓存（尾部 20 条）、提问/重发闭环（乐观更新 pending → ok/failed）、
 *              级联清理与墓碑对账、浮窗开关与知情同意。从 store/index.ts 装配。
 *              区块独立会话（V2.1）：区块聚焦时线程键下沉为 scopeId:blockId，
 *              每个区块（公告/日报/卡片）各自独立会话互不叠加；整页态回落页面会话。
 *              关键约束：
 *              - unregisterContext 仅在 owner 引用相等时注销（防路由竞态误删新页注册）；
 *              - 快照必须显式执行 getData()（命令式取数，禁闭包捕获组件态）；
 *              - 区块聚焦优先解析生效快照：聚焦态快照缺失时丢弃本轮，严禁回落整页串口径；
 *              - 重发复用同 clientMessageId（幂等）并用最新快照重建（D7，旧 ephemeral 已焚毁）；
 *              - 离线级联删除失败落墓碑，ensureThreadLoaded 时对账补发（P2 #13 防复活）。
 * @layer Store (Slice)
 * @storage_impact 内存态为主；墓碑/知情同意经 copilotService 持久化到 localStorage。
 * @author 开发团队
 */

import type { StateCreator } from 'zustand';
import type { AppStore } from '../types';
import type { CopilotAskRequest, CopilotMessage, PageContextSnapshot } from '../../types/domain';
import {
  buildAskRequest,
  clearThread,
  fetchMessages,
  newClientMessageId,
  saveCopilotConsent,
  saveCopilotTombstones,
  streamQuestion,
  toCopilotError,
} from '../../services/copilotService';
import { CANVAS_SCOPE_ID } from '../../utils/canvasSummary';
import { tryInterceptDataQuery } from '../../utils/canvasDataQuery';
import { buildCanvasPromptHints } from '../../utils/canvasTemplates';

/** 画布能力提示（copilot-spec D33 条件携带）：仅 canvas scope 组装——公共段 + 命中触发词的
 *  模板专属段（触发词/提示文本由注册表承载，与守卫同仓演进）；重发按原消息内容重判零状态 */
function canvasPromptHints(scopeId: string, question: string): string | undefined {
  return scopeId === CANVAS_SCOPE_ID ? buildCanvasPromptHints(question) : undefined;
}

/** 内存缓存上限：每会话仅保留尾部 20 条（更早历史经 keyset 分页从后端拉取） */
const THREAD_TAIL_LIMIT = 20;

/**
 * 生效会话线程键（V2.1 区块独立会话）：区块聚焦时下沉为 scopeId:blockId——
 * 每条公告/日报等区块各自独立会话（后端 /threads/{scopeId} 按 key 隔离），互不叠加；
 * 整页态回落原 scopeId。切片与 GlobalCopilot 共用，保证展示/上报/清理同一口径。
 */
export function copilotThreadKey(scopeId: string, blockId?: string | null): string {
  return blockId ? scopeId + ':' + blockId : scopeId;
}

/** 进行中的流式提问（非响应式）：面板关闭/停止按钮经 cancelCopilotStream 中断流，
 *  服务端随连接断开取消上游 LLM 订阅（省 token）。同一时刻至多一条（sending 锁保证） */
let activeAsk: AbortController | null = null;

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
  | 'focusBlock'
  | 'unfocusBlock'
  | 'ensureThreadLoaded'
  | 'sendMessage'
  | 'retryMessage'
  | 'cancelCopilotStream'
  | 'clearCurrentThread'
  | 'purgeScopeOnEntityDelete'
  | 'setCopilotOpen'
  | 'acknowledgeConsent'
>;

export const createCopilotSlice: StateCreator<AppStore, [], [], CopilotSlice> = (set, get) => {
  /**
   * 发送/重发共享闭环（V3 流式）：
   * - 首个 delta → user 行标 ok，追加 streaming 占位 assistant 行（增量内容渲染）；
   * - done → 占位行替换为正式 assistant 行（id = 后端消息 id，content = 权威全文自愈丢块）；
   * - 失败（含流中 error/中断）→ 丢弃占位行，user 行标 failed + errorHint + retryable。
   */
  const dispatchAsk = async (
    scopeId: string,
    request: CopilotAskRequest,
    userMsgId: string,
  ): Promise<void> => {
    // 流式占位行 id：前缀隔离，永不与后端数字 id 撞车
    const placeholderId = `stream:${request.clientMessageId}`;
    let placeholderCreated = false;
    const upsertPlaceholder = (text: string) => {
      set((s) => {
        const rows = s.threads[scopeId] ?? [];
        if (!placeholderCreated) {
          placeholderCreated = true;
          return {
            threads: {
              ...s.threads,
              [scopeId]: capThread(
                rows
                  .map((m) => (m.id === userMsgId ? { ...m, status: 'ok' as const } : m))
                  .concat({
                    id: placeholderId,
                    role: 'assistant' as const,
                    content: text,
                    status: 'streaming' as const,
                    ctime: Math.floor(Date.now() / 1000),
                  }),
              ),
            },
          };
        }
        return {
          threads: {
            ...s.threads,
            [scopeId]: rows.map((m) =>
              m.id === placeholderId ? { ...m, content: m.content + text } : m,
            ),
          },
        };
      });
    };
    // 外部取消句柄：面板关闭/停止按钮经 cancelCopilotStream() abort（主动取消非故障，
    // 映射 CANCELLED 子码）；finally 身份校验防迟到 cleanup 误清新一轮
    // （controller 必须声明在 try 外：catch/finally 块访问不到 try 块内的 const）
    const controller = new AbortController();
    activeAsk = controller;
    try {
      const resp = await streamQuestion(scopeId, request, upsertPlaceholder, controller.signal);
      // done：占位行 → 正式落库行（content 以 done 权威全文为准，自愈传输丢块）
      set((s) => ({
        threads: {
          ...s.threads,
          [scopeId]: capThread(
            (s.threads[scopeId] ?? [])
              .filter((m) => m.id !== placeholderId)
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
      // 动作后处理（V1 Action Pipeline）：响应内 actions 白名单校验后分级执行/入队。
      // 仅在响应返回时执行一次，不随消息渲染/历史回放重放；无 actions（旧后端/mock）时零开销
      get().handleCopilotActions(resp.actions);
    } catch (e) {
      const err = toCopilotError(e);
      set((s) => ({
        threads: {
          ...s.threads,
          [scopeId]: capThread(
            (s.threads[scopeId] ?? [])
              .filter((m) => m.id !== placeholderId)
              .map((m) =>
                m.id === userMsgId ? { ...m, status: 'failed' as const, errorHint: err.hint, retryable: err.retryable } : m,
              ),
          ),
        },
      }));
    } finally {
      if (activeAsk === controller) activeAsk = null;
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

  /**
   * 事实数据变动检测（P0 时间隔离配套 UX）：本轮快照概览 vs 上一轮用户行的落库概览，
   * 字符串不等 = 数据已变。scope 维度存储，浮窗提示条「数据自上轮已更新」依据。
   * 首次提问无上轮可比 → false（提示无意义）；每轮提问重算覆盖。
   */
  const markContextChanged = (scopeId: string, prevOverview: string | undefined, currentOverview: string): void => {
    const changed = prevOverview !== undefined && prevOverview !== currentOverview;
    set((s) => ({ contextChangedScopes: { ...s.contextChangedScopes, [scopeId]: changed } }));
  };

  /** 取线程中最后一条 user 行的落库概览（无则 undefined） */
  const lastUserOverview = (scopeId: string): string | undefined => {
    const rows = get().threads[scopeId] ?? [];
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].role === 'user') return rows[i].contextOverview;
    }
    return undefined;
  };

  /**
   * 解析生效快照（V2 Click-to-Focus）：区块聚焦优先，回落整页注册。
   * 返回 null = 无可用上下文（未注册页 / 聚焦区块已随页面注销）。
   * 聚焦态快照缺失时严禁回落整页取数 —— 胶囊展示口径与实际上报口径必须一致。
   */
  const resolveSnapshot = (): {
    scopeId: string;
    /** 会话线程键：区块聚焦时为 scopeId:blockId（区块独立会话），整页为 scopeId */
    threadKey: string;
    pageSnap: PageContextSnapshot;
    snapshot: Pick<PageContextSnapshot, 'getData'>;
    blockId: string | undefined;
  } | null => {
    const s = get();
    const focus = s.focusedBlock;
    const scopeId = focus ? focus.scopeId : s.activeScopeId;
    const pageSnap = scopeId ? s.registry[scopeId] : undefined;
    if (!scopeId || !pageSnap) return null;
    if (!focus) return { scopeId, threadKey: scopeId, pageSnap, snapshot: pageSnap, blockId: undefined };
    const blockSnap = pageSnap.blocks?.find((b) => b.blockId === focus.blockId);
    if (!blockSnap) return null;
    return { scopeId, threadKey: copilotThreadKey(scopeId, blockSnap.blockId), pageSnap, snapshot: blockSnap, blockId: blockSnap.blockId };
  };

  return {
    registerContext: (snapshot) => {
      // 同 scopeId 覆盖幂等；activeScopeId 跟随最新挂载页面。
      // 路由切到其他页时退出区块聚焦；同 scope 的快照热更新重注册（如筛选态变化）保留聚焦
      set((s) => ({
        registry: { ...s.registry, [snapshot.scopeId]: snapshot },
        activeScopeId: snapshot.scopeId,
        focusedBlock:
          s.focusedBlock && s.focusedBlock.scopeId !== snapshot.scopeId ? null : s.focusedBlock,
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

    focusBlock: (scopeId, blockId) => {
      const page = get().registry[scopeId];
      // 未注册页面/区块防御：按钮已渲染但快照未挂载时静默忽略，不弹空浮窗
      if (!page?.blocks?.some((b) => b.blockId === blockId)) return;
      set({ focusedBlock: { scopeId, blockId }, copilotOpen: true, activeScopeId: scopeId });
    },

    unfocusBlock: () => set({ focusedBlock: null }),

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

    sendMessage: async (question, opts) => {
      const s = get();
      if (s.sending) return; // 互斥锁：防并发重复提交
      const resolved = resolveSnapshot();
      if (!resolved) return; // 当前页未注册上下文 / 聚焦区块已失效（严禁回落整页串口径）
      const { threadKey, pageSnap, snapshot, blockId } = resolved;
      const trimmed = question.trim();
      if (!trimmed) return;

      // ── 受限取数语法拦截（仅画布 scope，docs/free-canvas-template-registry.md §三）：
      // 「标号 数据词」命中词表 → 本地直出数据卡片（用户可见 + 零 token），本轮不进 LLM；
      // 卡片文本经后续轮 dataCards 携带（AI 可见，计入上下文）。取数失败也落 ⚠️ 卡片可见告知。
      if (pageSnap.scopeId === CANVAS_SCOPE_ID) {
        const pendingCard = tryInterceptDataQuery(trimmed, s.canvasBlocks);
        if (pendingCard) {
          const clientMessageId = newClientMessageId();
          const cardText = await pendingCard
            .then((c) => c.toPromptText())
            .catch((e) => `⚠️ [数据获取失败] ${e instanceof Error ? e.message : '请稍后重试'}`);
          const ctime = Math.floor(Date.now() / 1000);
          const rows: CopilotMessage[] = [
            { id: clientMessageId, role: 'user', content: trimmed, status: 'ok', clientMessageId, ctime },
            { id: `card-${clientMessageId}`, role: 'system', content: cardText, status: 'ok', ctime },
          ];
          set((st) => ({
            threads: { ...st.threads, [threadKey]: capThread([...(st.threads[threadKey] ?? []), ...rows]) },
          }));
          return; // 零 token 本地轮结束（不联网、不上报服务端）
        }
      }

      set({ sending: true });
      try {
        // 显式执行命令式快照：getState() + 纯引擎重算，禁读组件闭包
        const data = snapshot.getData();
        const clientMessageId = newClientMessageId();
        // 数据卡片文本计入上下文（§三：卡片为本地行不进服务端历史，故每轮经 dataCards 显式携带；
        // 取尾部 5 张防上下文膨胀，applySizeGuard 兜底总量）
        const historyCards = (get().threads[threadKey] ?? [])
          .filter((m) => m.role === 'system')
          .slice(-5)
          .map((m) => m.content);
        // sessionTitle 恒用页面标题（会话身份稳定）；区块口径经 focusBlockId 交后端编排
        const request = buildAskRequest(
          pageSnap.title,
          trimmed,
          clientMessageId,
          data,
          blockId,
          historyCards.length
            ? { ...opts, promptHints: canvasPromptHints(pageSnap.scopeId, trimmed), extraDetail: { ...opts?.extraDetail, dataCards: historyCards } }
            : { ...opts, promptHints: canvasPromptHints(pageSnap.scopeId, trimmed) },
        );
        // 事实数据变动检测（P2）：本轮概览 vs 上轮用户行落库概览（必须在追加本轮 user 行之前取）
        markContextChanged(threadKey, lastUserOverview(threadKey), request.contextOverview);
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
          threads: { ...st.threads, [threadKey]: capThread([...(st.threads[threadKey] ?? []), userMsg]) },
        }));
        await dispatchAsk(threadKey, request, clientMessageId);
      } finally {
        set({ sending: false });
      }
    },

    retryMessage: async (messageId) => {
      const s = get();
      if (s.sending) return;
      // 与 sendMessage 同一套聚焦解析（V2）：重发永远重采当前生效口径（D7），聚焦失效则丢弃
      const resolved = resolveSnapshot();
      if (!resolved) return;
      const { threadKey, pageSnap, snapshot, blockId } = resolved;
      const target = (s.threads[threadKey] ?? []).find((m) => m.id === messageId);
      if (!target || target.status !== 'failed' || !target.retryable || !target.clientMessageId) return;

      set({ sending: true });
      try {
        // 重发必须重采最新快照（D7）：旧 ephemeral 明细已阅后即焚
        const data = snapshot.getData();
        const request = buildAskRequest(pageSnap.title, target.content, target.clientMessageId, data, blockId, {
          promptHints: canvasPromptHints(pageSnap.scopeId, target.content),
        });
        // 事实数据变动检测（P2）：重采概览 vs 被重发行的落库概览（被重发行即上一轮提问）
        markContextChanged(threadKey, target.contextOverview, request.contextOverview);
        markPending(threadKey, messageId);
        await dispatchAsk(threadKey, request, messageId);
      } finally {
        set({ sending: false });
      }
    },

    clearCurrentThread: async () => {
      // 区块聚焦时清的是区块独立会话（scopeId:blockId），整页态清页面会话
      const focus = get().focusedBlock;
      const scopeId = focus ? copilotThreadKey(focus.scopeId, focus.blockId) : get().activeScopeId;
      if (scopeId) await get().purgeScopeOnEntityDelete(scopeId);
    },

    purgeScopeOnEntityDelete: async (scopeId) => {
      if (!scopeId) return;
      // ① 本地立即清空（UI 即时反馈，不等网络）
      set((s) => {
        const threads = { ...s.threads };
        delete threads[scopeId];
        // 变动提示随会话一并清除（无会话即无对比基准）
        const contextChangedScopes = { ...s.contextChangedScopes };
        delete contextChangedScopes[scopeId];
        return { threads, contextChangedScopes };
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

    /** 中断进行中的流式提问（面板关闭/停止按钮）：幂等，无进行中提问时空操作 */
    cancelCopilotStream: () => {
      activeAsk?.abort();
    },

    acknowledgeConsent: () => {
      saveCopilotConsent(true);
      set({ consentAcknowledged: true });
    },
  };
};
