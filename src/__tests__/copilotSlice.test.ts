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
  newClientMessageId: (() => {
    let n = 0;
    return () => 'cmid-' + (++n);
  })(),
  buildAskRequest: vi.fn((sessionTitle: string, question: string, clientMessageId: string) => ({
    question,
    sessionTitle,
    clientMessageId,
    contextSummary: JSON.stringify({ data: {}, _units: {}, capturedAt: 0, truncated: false }),
    contextOverview: JSON.stringify({ mockOverview: 1 }),
    timeAnchor: JSON.stringify({ asOf: 1_700_000_000, range: 'all' }),
  })),
  streamQuestion: vi.fn(),
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
import { streamQuestion, fetchMessages, clearThread, saveCopilotTombstones, buildAskRequest } from '../services/copilotService';
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

/** 带区块的页面快照（V2 Click-to-Focus） */
function makeBlockSnapshot(scopeId: string, title: string, blockId: string): PageContextSnapshot {
  return {
    scopeId,
    title,
    getData: () => EMPTY_DATA,
    blocks: [{ blockId, title: `${blockId} 胶囊名`, getData: () => EMPTY_DATA }],
  };
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
  // 流式默认实现：先回调一次完整内容增量，再返回权威应答（done 语义）
  (streamQuestion as Mock).mockImplementation(
    async (_scopeId: string, _request: unknown, onDelta: (t: string) => void) => {
      onDelta(ASK_OK.content);
      return { ...ASK_OK };
    },
  );
  useAppStore.setState({
    registry: {}, threads: {}, sending: false, activeScopeId: null, lastArchived: null,
    deletedScopes: [], consentAcknowledged: true, copilotOpen: false, focusedBlock: null,
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

describe('focusBlock / unfocusBlock（V2 Click-to-Focus）', () => {
  it('聚焦已注册区块：记录聚焦态 + 展开浮窗 + 激活 scope；未注册静默忽略', () => {
    const snap = makeBlockSnapshot('home', '首页', 'home:short_term');
    useAppStore.setState({ registry: { home: snap }, activeScopeId: 'home' });

    // 未注册区块 → 静默忽略，不弹空浮窗
    useAppStore.getState().focusBlock('home', 'home:unknown');
    expect(useAppStore.getState().focusedBlock).toBeNull();
    expect(useAppStore.getState().copilotOpen).toBe(false);

    useAppStore.getState().focusBlock('home', 'home:short_term');
    expect(useAppStore.getState().focusedBlock).toEqual({ scopeId: 'home', blockId: 'home:short_term' });
    expect(useAppStore.getState().copilotOpen).toBe(true);
    expect(useAppStore.getState().activeScopeId).toBe('home');
  });

  it('unfocusBlock：退出聚焦回整页，激活 scope 保留', () => {
    const snap = makeBlockSnapshot('home', '首页', 'home:short_term');
    useAppStore.setState({ registry: { home: snap }, activeScopeId: 'home' });
    useAppStore.getState().focusBlock('home', 'home:short_term');

    useAppStore.getState().unfocusBlock();
    expect(useAppStore.getState().focusedBlock).toBeNull();
    expect(useAppStore.getState().activeScopeId).toBe('home');
  });

  it('registerContext：路由切到其他页退出聚焦；同 scope 快照热更新保留聚焦', () => {
    const homeSnap = makeBlockSnapshot('home', '首页', 'home:short_term');
    useAppStore.setState({ registry: { home: homeSnap }, activeScopeId: 'home' });
    useAppStore.getState().focusBlock('home', 'home:short_term');

    // 同 scope 重注册（筛选态热更新）→ 保留聚焦
    useAppStore.getState().registerContext({ ...homeSnap, title: '首页仪表盘' });
    expect(useAppStore.getState().focusedBlock).toEqual({ scopeId: 'home', blockId: 'home:short_term' });

    // 其他页注册（路由切换）→ 退出聚焦
    useAppStore.getState().registerContext(makeSnapshot('statistics', '数据统计'));
    expect(useAppStore.getState().focusedBlock).toBeNull();
  });

  it('sendMessage 聚焦态：取区块快照并透传 focusBlockId，sessionTitle 恒页面标题', async () => {
    const blockGetData = vi.fn(() => EMPTY_DATA);
    const snap: PageContextSnapshot = {
      scopeId: 'home',
      title: '首页仪表盘',
      getData: () => EMPTY_DATA,
      blocks: [{ blockId: 'home:short_term', title: '首页 · 短线统计 (近7天)', getData: blockGetData }],
    };
    useAppStore.setState({ registry: { home: snap }, activeScopeId: 'home' });
    useAppStore.getState().focusBlock('home', 'home:short_term');

    await useAppStore.getState().sendMessage('做T盈亏如何？');
    expect(blockGetData).toHaveBeenCalledTimes(1);
    expect(streamQuestion).toHaveBeenCalledWith('home', expect.objectContaining({ question: '做T盈亏如何？' }), expect.any(Function));
    const thread = useAppStore.getState().threads.home;
    expect(thread).toHaveLength(2);
    // sessionTitle 恒页面标题（会话身份稳定）；第 5 参透传区块标识（后端 Prompt 路由）
    const buildCall = (buildAskRequest as Mock).mock.calls[0] as unknown[];
    expect(buildCall[0]).toBe('首页仪表盘');
    expect(buildCall[4]).toBe('home:short_term');
  });

  it('聚焦态快照失效（页面已注销/区块已移除）→ 提问与重发均丢弃，严禁回落整页串口径', async () => {
    const snap = makeBlockSnapshot('home', '首页', 'home:short_term');
    useAppStore.setState({
      registry: { home: snap }, activeScopeId: 'home',
      threads: { home: [makeMsg({ id: 'fail-1', status: 'failed', retryable: true, clientMessageId: 'cmid-x' })] },
    });
    useAppStore.getState().focusBlock('home', 'home:short_term');
    useAppStore.setState({ registry: {} }); // 页面卸载，聚焦区块失效

    await useAppStore.getState().sendMessage('不该发出去');
    await useAppStore.getState().retryMessage('fail-1');
    expect(streamQuestion).not.toHaveBeenCalled();
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
    expect(streamQuestion).toHaveBeenCalledTimes(1);
    expect(streamQuestion).toHaveBeenCalledWith('statistics', expect.objectContaining({ question: '你好' }), expect.any(Function));
  });

  it('失败分支：标 failed + errorHint + retryable（重发按钮依据）', async () => {
    (streamQuestion as Mock).mockRejectedValue(new Error('boom'));
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
    (streamQuestion as Mock).mockReturnValue(new Promise((res) => { resolveAsk = res; }));

    const p1 = useAppStore.getState().sendMessage('第一条');
    const p2 = useAppStore.getState().sendMessage('第二条');
    expect(streamQuestion).toHaveBeenCalledTimes(1);

    resolveAsk({ ...ASK_OK });
    await Promise.all([p1, p2]);
    expect(useAppStore.getState().threads.statistics).toHaveLength(2);
  });

  it('重发：同 clientMessageId 幂等并重采快照（D7），成功后恢复 ok', async () => {
    setActiveScope('statistics');
    (streamQuestion as Mock).mockRejectedValueOnce(new Error('first'));
    await useAppStore.getState().sendMessage('重试我');
    let thread = useAppStore.getState().threads.statistics;
    expect(thread[0].status).toBe('failed');

    (streamQuestion as Mock).mockResolvedValueOnce({ ...ASK_OK });
    await useAppStore.getState().retryMessage(thread[0].id);
    thread = useAppStore.getState().threads.statistics;
    expect(thread[0].status).toBe('ok');
    expect(thread[0].clientMessageId).toBeTruthy();
    // 两次调用共享同一幂等键
    const firstCall = (streamQuestion as Mock).mock.calls[0][1] as { clientMessageId: string };
    const secondCall = (streamQuestion as Mock).mock.calls[1][1] as { clientMessageId: string };
    expect(firstCall.clientMessageId).toBe(secondCall.clientMessageId);
  });
});

describe('sendMessage 流式渲染（V3 SSE）', () => {
  it('流中：首 delta 即建 streaming 占位行增量渲染且 user 行提前标 ok；done 后占位行替换为正式行', async () => {
    setActiveScope('statistics');
    let onDeltaRef!: (t: string) => void;
    let resolveAsk!: (v: unknown) => void;
    (streamQuestion as Mock).mockImplementation(
      (_s: string, _r: unknown, onDelta: (t: string) => void) =>
        new Promise((res) => {
          onDeltaRef = onDelta;
          resolveAsk = res;
        }),
    );
    const p = useAppStore.getState().sendMessage('流式问题');
    // 模拟服务端两个增量块（zustand set 同步，无需等待）
    onDeltaRef('第一段');
    let thread = useAppStore.getState().threads.statistics;
    expect(thread).toHaveLength(2);
    expect(thread[0].status).toBe('ok'); // 首 delta 即确认 user 行（服务端阶段一已落库）
    expect(thread[1].status).toBe('streaming');
    expect(thread[1].id).toBe('stream:' + thread[0].id); // 占位 id = stream:clientMessageId
    expect(thread[1].content).toBe('第一段');
    onDeltaRef('第二段');
    thread = useAppStore.getState().threads.statistics;
    expect(thread[1].content).toBe('第一段第二段');
    // done：占位行替换为正式行（权威全文 + 服务端 id），且不留 streaming 行
    resolveAsk({ ...ASK_OK });
    await p;
    thread = useAppStore.getState().threads.statistics;
    expect(thread).toHaveLength(2);
    expect(thread[1].id).toBe('501');
    expect(thread[1].status).toBe('ok');
    expect(thread[1].content).toBe('模拟回答');
    expect(thread.every((m) => m.status !== 'streaming')).toBe(true);
  });

  it('流中失败：占位行被丢弃，user 行标 failed 可重发（服务端未归档 assistant 行）', async () => {
    setActiveScope('statistics');
    let onDeltaRef!: (t: string) => void;
    let rejectAsk!: (e: unknown) => void;
    (streamQuestion as Mock).mockImplementation(
      (_s: string, _r: unknown, onDelta: (t: string) => void) =>
        new Promise((_res, rej) => {
          onDeltaRef = onDelta;
          rejectAsk = rej;
        }),
    );
    const p = useAppStore.getState().sendMessage('流式中断');
    onDeltaRef('已输出的半截');
    expect(useAppStore.getState().threads.statistics[1].status).toBe('streaming');
    rejectAsk(new Error('stream broke'));
    await p;
    const thread = useAppStore.getState().threads.statistics;
    expect(thread).toHaveLength(1); // streaming 占位行已丢弃
    expect(thread[0].status).toBe('failed');
    expect(thread[0].retryable).toBe(true);
    expect(useAppStore.getState().sending).toBe(false);
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

describe('事实数据变动检测（P0 时间隔离配套 UX）', () => {
  function setActiveScope(scopeId: string) {
    useAppStore.setState({
      registry: { [scopeId]: makeSnapshot(scopeId, '测试页') },
      activeScopeId: scopeId,
    });
  }

  function lastUserRow(scopeId: string): CopilotMessage | undefined {
    const rows = useAppStore.getState().threads[scopeId] ?? [];
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].role === 'user') return rows[i];
    }
    return undefined;
  }

  it('首次提问无上轮可比 → flag false（提示无意义）', async () => {
    setActiveScope('scope-first');
    await useAppStore.getState().sendMessage('q1');
    expect(useAppStore.getState().contextChangedScopes['scope-first']).toBe(false);
  });

  it('二次提问数据未变（落库概览一致）→ flag false', async () => {
    setActiveScope('scope-same');
    await useAppStore.getState().sendMessage('q1');
    await useAppStore.getState().sendMessage('q2');
    expect(useAppStore.getState().contextChangedScopes['scope-same']).toBe(false);
  });

  it('二次提问数据已变（本轮快照概览与上轮落库概览不等）→ flag true', async () => {
    setActiveScope('scope-changed');
    await useAppStore.getState().sendMessage('q1');
    expect(lastUserRow('scope-changed')?.contextOverview).toBeDefined();
    // 第二轮快照变化：覆盖 buildAskRequest 一次，返回不同 contextOverview
    (buildAskRequest as Mock).mockImplementationOnce(
      (sessionTitle: string, question: string, clientMessageId: string) => ({
        question,
        sessionTitle,
        clientMessageId,
        contextSummary: JSON.stringify({ data: {}, _units: {}, capturedAt: 9, truncated: false }),
        contextOverview: JSON.stringify({ changed: 2 }),
        timeAnchor: JSON.stringify({ asOf: 9, range: 'all' }),
      }),
    );
    await useAppStore.getState().sendMessage('q2');
    expect(useAppStore.getState().contextChangedScopes['scope-changed']).toBe(true);
  });

  it('重发路径：重采概览 vs 被重发行落库概览不等 → flag true', async () => {
    setActiveScope('scope-retry');
    const failed: CopilotMessage = {
      id: 'cmid-1', role: 'user', content: 'q', status: 'failed',
      retryable: true, clientMessageId: 'cmid-1',
      contextOverview: JSON.stringify({ old: 1 }), ctime: 1,
    };
    useAppStore.setState({ threads: { 'scope-retry': [failed] } });
    (buildAskRequest as Mock).mockImplementationOnce(
      (sessionTitle: string, question: string, clientMessageId: string) => ({
        question,
        sessionTitle,
        clientMessageId,
        contextSummary: JSON.stringify({ data: {}, _units: {}, capturedAt: 9, truncated: false }),
        contextOverview: JSON.stringify({ fresh: 2 }),
        timeAnchor: JSON.stringify({ asOf: 9, range: 'all' }),
      }),
    );
    await useAppStore.getState().retryMessage('cmid-1');
    expect(useAppStore.getState().contextChangedScopes['scope-retry']).toBe(true);
  });

  it('清空会话（purgeScopeOnEntityDelete）→ 变动提示条目随删', async () => {
    setActiveScope('scope-purge');
    useAppStore.setState({ contextChangedScopes: { 'scope-purge': true } });
    await useAppStore.getState().purgeScopeOnEntityDelete('scope-purge');
    expect(useAppStore.getState().contextChangedScopes['scope-purge']).toBeUndefined();
  });
});
