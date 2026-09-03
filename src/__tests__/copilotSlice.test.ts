/**
 * @file copilotSlice.test.ts
 * @description Copilot 切片单测（mock copilotService）：注册/注销引用相等语义、
 *              提问乐观更新闭环（pending → ok/failed）、sending 互斥锁、
 *              级联清理墓碑（DELETE 失败落墓碑、对账补发成功/失败两分支）、缓存优先（D8）。
 *              node 环境：localStorage 需 try/catch；导 store 链触发 Dexie，须先 fake-indexeddb。
 * @layer 测试
 * @author 开发团队
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../services/copilotService', () => ({
  buildAskRequest: (sessionTitle: string, question: string, clientMessageId: string) => ({
    question,
    sessionTitle,
    clientMessageId,
    contextSummary: JSON.stringify({ data: {}, _units: {}, capturedAt: 0, truncated: false }),
    contextOverview: JSON.stringify({ mockOverview: 1 }),
    timeAnchor: JSON.stringify({ asOf: 1_700_000_000, range: 'all' }),
  }),
  sendQuestion: vi.fn(),
  fetchMessages: vi.fn(),
  clearThread: vi.fn(),
  toCopilotError: vi.fn(() => ({
    message: 'err',
    hint: 'AI 服务暂不可用，请稍后重试',
    retryable: true,
  })),
  loadCopilotTombstones: vi.fn(() => []),
  saveCopilotTombstones: vi.fn(),
  loadCopilotConsent: vi.fn(() => true),
  saveCopilotConsent: vi.fn(),
}));

import { useAppStore } from '../store';
import { sendQuestion, fetchMessages, clearThread, saveCopilotTombstones } from '../services/copilotService';
import type { CopilotContextData, CopilotMessage, PageContextSnapshot } from '../types/domain';

// ---- fixtures / helpers ----

const EMPTY_DATA: CopilotContextData = {
  overview: {},
  timeAnchor: { asOf: 1_700_000_000, range: 'all' },
  detail: {},
  units: {},
};

function makeSnapshot(scopeId: string, title: string): PageContextSnapshot {
  return { scopeId, title, getData: () => EMPTY_DATA };
}

function makeMsg(partial: Partial<CopilotMessage>): CopilotMessage {
  return { id: 'm1', role: 'user', content: 'q', status: 'ok', ctime: 1, ...partial };
}

/** 组装带 registry + activeScopeId 的就绪态 */
function setActiveScope(scopeId: string) {
  useAppStore.setState({
    registry: { [scopeId]: makeSnapshot(scopeId, '测试页') },
    activeScopeId: scopeId,
  });
}

const ASK_OK = {
  assistantMessageId: 501,
  content: '模拟回答',
  promptTokens: 1,
  completionTokens: 1,
  channel: 'mock',
  userMessageId: 1,
  ctime: 1_700_000_001,
};

beforeEach(() => {
  vi.clearAllMocks();
  (fetchMessages as Mock).mockResolvedValue({
    sessionId: 1, scopeId: 'x', title: 'x', messages: [], hasMore: false, oldestId: 0,
  });
  (clearThread as Mock).mockResolvedValue(undefined);
  (sendQuestion as Mock).mockResolvedValue({ ...ASK_OK });
  useAppStore.setState({
    registry: {}, threads: {}, sending: false, activeScopeId: null, lastArchived: null,
    deletedScopes: [], consentAcknowledged: true, copilotOpen: false,
  });
});

describe('registerContext / unregisterContext（引用相等语义，补丁规则 1）', () => {
  it('同 scopeId 覆盖幂等；引用不匹配不注销，匹配才注销并置空激活 scope', () => {
    const snapA = makeSnapshot('statistics', 'A');
    const snapB = makeSnapshot('statistics', 'B');

    useAppStore.getState().registerContext(snapA);
    expect(useAppStore.getState().activeScopeId).toBe('statistics');

    useAppStore.getState().registerContext(snapB);
    expect(useAppStore.getState().registry.statistics).toBe(snapB);

    // 旧视图迟到的 cleanup（引用不匹配）→ 不注销
    useAppStore.getState().unregisterContext('statistics', snapA);
    expect(useAppStore.getState().registry.statistics).toBe(snapB);

    // 引用匹配 → 注销 + activeScopeId 置空
    useAppStore.getState().unregisterContext('statistics', snapB);
    expect(useAppStore.getState().registry.statistics).toBeUndefined();
    expect(useAppStore.getState().activeScopeId).toBeNull();
  });

  it('注销存在会话的激活 scope 时记录归档提示（§7.3）', () => {
    const snap = makeSnapshot('home', '首页');
    useAppStore.getState().registerContext(snap);
    useAppStore.setState({ threads: { home: [makeMsg({})] } });
    useAppStore.getState().unregisterContext('home', snap);
    expect(useAppStore.getState().lastArchived).toEqual({ scopeId: 'home', title: '首页' });
  });
});

describe('sendMessage / retryMessage（提问闭环）', () => {
  it('乐观更新：pending 用户行 → 成功标 ok 并追加 assistant 行', async () => {
    setActiveScope('statistics');
    await useAppStore.getState().sendMessage('你好');
    const thread = useAppStore.getState().threads.statistics;
    expect(thread).toHaveLength(2);
    expect(thread.map((m) => m.status)).toEqual(['ok', 'ok']);
    expect(thread[0].content).toBe('你好');
    expect(thread[0].contextOverview).toBe(JSON.stringify({ mockOverview: 1 }));
    expect(thread[1].role).toBe('assistant');
    expect(thread[1].id).toBe('501');
    expect(sendQuestion).toHaveBeenCalledTimes(1);
    expect(sendQuestion).toHaveBeenCalledWith('statistics', expect.objectContaining({ question: '你好' }));
  });

  it('失败分支：标 failed + errorHint + retryable（重发按钮依据）', async () => {
    (sendQuestion as Mock).mockRejectedValue(new Error('boom'));
    setActiveScope('statistics');
    await useAppStore.getState().sendMessage('问题');
    const thread = useAppStore.getState().threads.statistics;
    expect(thread).toHaveLength(1);
    expect(thread[0].status).toBe('failed');
    expect(thread[0].retryable).toBe(true);
    expect(thread[0].errorHint).toBe('AI 服务暂不可用，请稍后重试');
    expect(useAppStore.getState().sending).toBe(false);
  });

  it('sending 互斥锁：进行中第二次 sendMessage 被忽略', async () => {
    setActiveScope('statistics');
    let resolveAsk!: (v: unknown) => void;
    (sendQuestion as Mock).mockReturnValue(new Promise((res) => { resolveAsk = res; }));

    const p1 = useAppStore.getState().sendMessage('第一条');
    const p2 = useAppStore.getState().sendMessage('第二条');
    expect(sendQuestion).toHaveBeenCalledTimes(1);

    resolveAsk({ ...ASK_OK });
    await Promise.all([p1, p2]);
    expect(useAppStore.getState().threads.statistics).toHaveLength(2);
  });

  it('重发：同 clientMessageId 幂等并重采快照（D7），成功后恢复 ok', async () => {
    setActiveScope('statistics');
    (sendQuestion as Mock).mockRejectedValueOnce(new Error('first'));
    await useAppStore.getState().sendMessage('重试我');
    let thread = useAppStore.getState().threads.statistics;
    expect(thread[0].status).toBe('failed');

    (sendQuestion as Mock).mockResolvedValueOnce({ ...ASK_OK });
    await useAppStore.getState().retryMessage(thread[0].id);
    thread = useAppStore.getState().threads.statistics;
    expect(thread[0].status).toBe('ok');
    expect(thread[0].clientMessageId).toBeTruthy();
    // 两次调用共享同一幂等键
    const firstCall = (sendQuestion as Mock).mock.calls[0][1] as { clientMessageId: string };
    const secondCall = (sendQuestion as Mock).mock.calls[1][1] as { clientMessageId: string };
    expect(firstCall.clientMessageId).toBe(secondCall.clientMessageId);
  });
});

describe('clearCurrentThread / purgeScopeOnEntityDelete（级联清理 + 墓碑 P2 #13）', () => {
  it('DELETE 失败 → 本地 thread 清空且落墓碑（localStorage 持久化）', async () => {
    (clearThread as Mock).mockRejectedValue(new Error('offline'));
    useAppStore.setState({
      activeScopeId: 't_calculator:600519',
      threads: { 't_calculator:600519': [makeMsg({})] },
    });

    await useAppStore.getState().clearCurrentThread();
    expect(useAppStore.getState().threads['t_calculator:600519']).toBeUndefined();
    expect(useAppStore.getState().deletedScopes).toEqual(['t_calculator:600519']);
    expect(saveCopilotTombstones).toHaveBeenCalledWith(['t_calculator:600519']);
  });

  it('DELETE 成功 → 清本地缓存且不落墓碑', async () => {
    useAppStore.setState({ threads: { 'cost_averaging:600519': [makeMsg({})] } });

    await useAppStore.getState().purgeScopeOnEntityDelete('cost_averaging:600519');
    expect(clearThread).toHaveBeenCalledWith('cost_averaging:600519');
    expect(useAppStore.getState().threads['cost_averaging:600519']).toBeUndefined();
    expect(useAppStore.getState().deletedScopes).toEqual([]);
  });

  it('空 scope 幂等返回', async () => {
    await useAppStore.getState().purgeScopeOnEntityDelete('');
    expect(clearThread).not.toHaveBeenCalled();
  });
});

describe('ensureThreadLoaded（墓碑对账 + 缓存优先 D8）', () => {
  it('墓碑命中且补发失败 → 拦截历史加载并保留墓碑（防旧会话复活）', async () => {
    (clearThread as Mock).mockRejectedValue(new Error('still offline'));
    useAppStore.setState({ deletedScopes: ['statistics'] });

    await useAppStore.getState().ensureThreadLoaded('statistics');
    expect(fetchMessages).not.toHaveBeenCalled();
    expect(useAppStore.getState().deletedScopes).toEqual(['statistics']);
    expect(useAppStore.getState().threads.statistics).toBeUndefined();
  });

  it('墓碑补发成功 → 移除墓碑并正常拉取历史（服务端行映射：id 字符串化 / status 缺省 ok）', async () => {
    useAppStore.setState({ deletedScopes: ['statistics'] });
    (fetchMessages as Mock).mockResolvedValue({
      sessionId: 7, scopeId: 'statistics', title: '数据统计',
      messages: [{ id: 11, role: 'user', content: 'hi', ctime: 100, clientMessageId: 'cmid-1' }],
      hasMore: false, oldestId: 11,
    });

    await useAppStore.getState().ensureThreadLoaded('statistics');
    expect(useAppStore.getState().deletedScopes).toEqual([]);
    expect(saveCopilotTombstones).toHaveBeenCalledWith([]);
    expect(fetchMessages).toHaveBeenCalledWith('statistics');
    const thread = useAppStore.getState().threads.statistics;
    expect(thread).toHaveLength(1);
    expect(thread[0].id).toBe('11');
    expect(thread[0].status).toBe('ok');
    expect(thread[0].clientMessageId).toBe('cmid-1');
  });

  it('已有内存缓存时跳过远端拉取（D8）', async () => {
    useAppStore.setState({ threads: { home: [makeMsg({})] } });

    await useAppStore.getState().ensureThreadLoaded('home');
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  it('无缓存且无墓碑 → 正常拉取历史', async () => {
    (fetchMessages as Mock).mockResolvedValue({
      sessionId: 1, scopeId: 'home', title: '首页', messages: [], hasMore: false, oldestId: 0,
    });

    await useAppStore.getState().ensureThreadLoaded('home');
    expect(fetchMessages).toHaveBeenCalledTimes(1);
  });
});
