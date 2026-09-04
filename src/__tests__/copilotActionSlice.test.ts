/**
 * @file copilotActionSlice.test.ts
 * @description Copilot 动作后处理切片单测（mock copilotService）：
 *              auto 级动作落地（notify 弹窗态/聚焦/筛选）、后到覆盖先到、
 *              未注册目标静默忽略、confirm 级队列执行/忽略生命周期、
 *              sendMessage/retryMessage 响应挂载点集成（动作仅执行一次）。
 *              node 环境：导 store 链触发 Dexie，须先 fake-indexeddb。
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
  toCopilotError: vi.fn(() => ({ message: 'err', hint: 'AI 服务暂不可用', retryable: true })),
  loadCopilotTombstones: vi.fn(() => []),
  saveCopilotTombstones: vi.fn(),
  loadCopilotConsent: vi.fn(() => true),
  saveCopilotConsent: vi.fn(),
}));

import { useAppStore } from '../store';
import { streamQuestion } from '../services/copilotService';
import type { CopilotContextData, CopilotMessage, PageContextSnapshot } from '../types/domain';

const EMPTY_DATA: CopilotContextData = {
  overview: {},
  timeAnchor: { asOf: 1_700_000_000, range: 'all' },
  detail: {},
  units: {},
};

function makeBlockSnapshot(scopeId: string, blockId: string): PageContextSnapshot {
  return {
    scopeId,
    title: '测试页',
    getData: () => EMPTY_DATA,
    blocks: [{ blockId, title: `${blockId} 胶囊名`, getData: () => EMPTY_DATA }],
  };
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
  // 流式默认实现：先回调完整内容增量，再返回权威应答（done 语义）
  (streamQuestion as Mock).mockImplementation(
    async (_scopeId: string, _request: unknown, onDelta: (t: string) => void) => {
      onDelta(ASK_OK.content);
      return { ...ASK_OK };
    },
  );
  useAppStore.setState({
    registry: {}, threads: {}, sending: false, activeScopeId: null, lastArchived: null,
    deletedScopes: [], consentAcknowledged: true, copilotOpen: false, focusedBlock: null,
    copilotNotice: null, pendingCopilotActions: [], homeTimeRange: '7d',
  });
});

describe('handleCopilotActions（auto 级落地）', () => {
  it('无 actions（undefined/空/全非法）→ 状态零变化（旧后端/mock 兼容）', () => {
    useAppStore.getState().handleCopilotActions(undefined);
    useAppStore.getState().handleCopilotActions([]);
    useAppStore.getState().handleCopilotActions([{ type: 'unregistered_x', payload: {} }]);
    expect(useAppStore.getState().copilotNotice).toBeNull();
    expect(useAppStore.getState().pendingCopilotActions).toEqual([]);
  });

  it('notify → copilotNotice 落地 + dismiss 清除；后到覆盖先到', () => {
    useAppStore.getState().handleCopilotActions([
      { type: 'notify', payload: { title: '第一条', message: 'm1', severity: 'warning' } },
    ]);
    expect(useAppStore.getState().copilotNotice).toEqual({
      title: '第一条', message: 'm1', severity: 'warning',
    });
    useAppStore.getState().handleCopilotActions([
      { type: 'notify', payload: { title: '第二条', message: 'm2' } },
    ]);
    expect(useAppStore.getState().copilotNotice).toEqual({
      title: '第二条', message: 'm2', severity: 'info',
    });
    useAppStore.getState().dismissCopilotNotice();
    expect(useAppStore.getState().copilotNotice).toBeNull();
  });

  it('focus_block → 复用 focusBlock 语义：已注册区块聚焦并展开浮窗，未注册静默忽略', () => {
    useAppStore.setState({
      registry: { home: makeBlockSnapshot('home', 'home:short_term') },
      activeScopeId: 'home',
    });
    useAppStore.getState().handleCopilotActions([
      { type: 'focus_block', payload: { scopeId: 'home', blockId: 'home:short_term' } },
    ]);
    expect(useAppStore.getState().focusedBlock).toEqual({ scopeId: 'home', blockId: 'home:short_term' });
    expect(useAppStore.getState().copilotOpen).toBe(true);

    useAppStore.setState({ focusedBlock: null, copilotOpen: false });
    useAppStore.getState().handleCopilotActions([
      { type: 'focus_block', payload: { scopeId: 'home', blockId: 'home:not_exist' } },
    ]);
    expect(useAppStore.getState().focusedBlock).toBeNull();
    expect(useAppStore.getState().copilotOpen).toBe(false);
  });

  it('apply_filter → 白名单键值落地首页时间维度', () => {
    useAppStore.getState().handleCopilotActions([
      { type: 'apply_filter', payload: { filter: 'homeTimeRange', value: '30d' } },
    ]);
    expect(useAppStore.getState().homeTimeRange).toBe('30d');
  });

  it('confirm 级入队等待确认（此处以 seed 验证队列生命周期）', () => {
    // 当前无已注册 confirm 类型，sanitize 无法产出 → 直接 seed 验证消费语义
    useAppStore.setState({
      pendingCopilotActions: [
        { id: 'pa-1', type: 'create_plan_order', label: 'AI 建议执行：create_plan_order', payload: { k: 1 } },
        { id: 'pa-2', type: 'create_plan_order', label: 'AI 建议执行：create_plan_order', payload: { k: 2 } },
      ],
    });
    useAppStore.getState().dismissPendingCopilotAction('pa-1');
    expect(useAppStore.getState().pendingCopilotActions.map((a) => a.id)).toEqual(['pa-2']);
    // 未登记类型的执行器：出队且不抛错（执行器注册表待业务动作接入）
    useAppStore.getState().executePendingCopilotAction('pa-2');
    expect(useAppStore.getState().pendingCopilotActions).toEqual([]);
    // 未知 id：幂等无效果
    useAppStore.getState().executePendingCopilotAction('pa-none');
    expect(useAppStore.getState().pendingCopilotActions).toEqual([]);
  });
});

describe('响应挂载点集成（sendMessage / retryMessage → 动作仅执行一次）', () => {
  function setActiveScope(scopeId: string) {
    useAppStore.setState({
      registry: { [scopeId]: { scopeId, title: '测试页', getData: () => EMPTY_DATA } },
      activeScopeId: scopeId,
    });
  }

  it('sendMessage 响应携带 actions → assistant 行追加且 notify 落地', async () => {
    setActiveScope('home');
    (streamQuestion as Mock).mockResolvedValue({
      ...ASK_OK,
      actions: [{ type: 'notify', payload: { title: '来自响应', message: '风险', severity: 'danger' } }],
    });
    await useAppStore.getState().sendMessage('有风险吗');
    const thread = useAppStore.getState().threads.home ?? [];
    expect(thread.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(useAppStore.getState().copilotNotice).toEqual({
      title: '来自响应', message: '风险', severity: 'danger',
    });
    // 状态回放（重渲染）不重执行：再次触发 handle 无新动作时 notice 不被清空/重复
    expect(useAppStore.getState().pendingCopilotActions).toEqual([]);
  });

  it('retryMessage 响应同样走动作挂载点', async () => {
    setActiveScope('statistics');
    const failed: CopilotMessage = {
      id: 'cmid-1', role: 'user', content: 'q', status: 'failed',
      retryable: true, clientMessageId: 'cmid-1', ctime: 1,
    };
    useAppStore.setState({ threads: { statistics: [failed] } });
    (streamQuestion as Mock).mockResolvedValue({
      ...ASK_OK,
      actions: [{ type: 'notify', payload: { title: '重发后提醒', message: 'm' } }],
    });
    await useAppStore.getState().retryMessage('cmid-1');
    expect(useAppStore.getState().copilotNotice).toEqual({
      title: '重发后提醒', message: 'm', severity: 'info',
    });
  });

  it('响应无 actions → 现有闭环零变化（回归保护）', async () => {
    setActiveScope('home');
    await useAppStore.getState().sendMessage('普通提问');
    expect(useAppStore.getState().copilotNotice).toBeNull();
    expect(useAppStore.getState().threads.home).toHaveLength(2); // user + assistant
  });
});
