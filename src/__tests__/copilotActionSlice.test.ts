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
import {
  sanitizeCopilotActions,
  asCanvasAddBlockPayload,
  asCanvasSetStockPayload,
  asCanvasUpdateTextPayload,
  asCanvasSetMetricPayload,
  asCanvasUpdateTablePayload,
  asCanvasAddHLinePayload,
  asCanvasAddTrendlinePayload,
  asCanvasRemoveBlockPayload,
  asCanvasRefreshPayload,
} from '../utils/copilotActions';
import { allCanvasOperationMeta, CANVAS_TEMPLATES } from '../utils/canvasTemplates';
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

describe('canvas 动作注册表分发等价性（docs/free-canvas-template-registry.md §四/§五-5）', () => {
  /** 九个 canvas_* 动作的最小合法载荷（守卫整形后通过）+ add_widget（DSL 动态模板） */
  const VALID_PAYLOADS: Record<string, unknown> = {
    add_block: { type: 'text', content: 'hi' },
    add_widget: { dsl: { kind: 'stack', title: '面板', nodes: [{ c: 'divider' }] } },
    refresh_klines: {},
    set_stock: { blockId: 'A1', fullCode: 'sh600519', stockName: '茅台' },
    update_text: { blockId: 'A1', content: 'x' },
    set_metric: { blockId: 'A1', label: 'L', value: 1 },
    update_table: { blockId: 'A1', columns: [{ key: 'c1', title: '列' }], rows: [{ c1: 'v' }] },
    add_hline: { blockId: 'A1', price: 12.5 },
    add_trendline: { blockId: 'A1', startTime: '2026-01-05', startPrice: 1, endTime: '2026-02-01', endPrice: 2 },
    remove_block: { blockId: 'A1' },
  };
  /** 无参载荷恒通过的守卫（refresh_klines 无「垃圾载荷拒绝」语义） */
  const GUARD_ALWAYS_PASS = new Set(['refresh_klines']);

  it('注册表元数据覆盖全部 canvas_* 动作：tier 与 sanitize 分级一致、guard 与集中守卫行为一致', () => {
    const meta = allCanvasOperationMeta();
    for (const [op, payload] of Object.entries(VALID_PAYLOADS)) {
      const type = `canvas_${op}`;
      // ① 完备性：注册表登记了该操作
      expect(meta.has(op), `${op} 未注册`).toBe(true);
      // ② 分级等价：sanitize 白名单路由出的 tier === 注册表元数据 tier
      const out = sanitizeCopilotActions([{ type, payload }]);
      expect(out, `${op} sanitize 未通过`).toHaveLength(1);
      expect(out[0].tier, `${op} tier 不一致`).toBe(meta.get(op)!.tier);
      // ③ 守卫等价：合法载荷通过、垃圾载荷拒绝（refresh_klines 恒通过除外）
      expect(meta.get(op)!.guard(payload), `${op} 合法载荷被拒`).not.toBeNull();
      if (!GUARD_ALWAYS_PASS.has(op)) {
        expect(meta.get(op)!.guard({ junk: 1 }), `${op} 垃圾载荷未拒`).toBeNull();
      }
    }
    // annotate_block 不收编注册表（写分析结论维持独立分支逐条确认）
    expect(meta.has('annotate_block')).toBe(false);
  });

  it('auto 级 canvas_add_block 经 handleCopilotActions 直执行（分发缺口修复回归）', () => {
    const before = useAppStore.getState().canvasBlocks.length;
    useAppStore.getState().handleCopilotActions([
      { type: 'canvas_add_block', payload: { type: 'text', content: 'hi' } },
    ]);
    const blocks = useAppStore.getState().canvasBlocks;
    expect(blocks.length).toBe(before + 1);
    expect((blocks[blocks.length - 1].data as { content?: string }).content).toBe('hi');
  });

  it('auto 级 canvas_add_widget 直执行：widget 区块落库且 data.dsl 为规范化图纸；非法 DSL 静默丢弃', () => {
    const before = useAppStore.getState().canvasBlocks.length;
    useAppStore.getState().handleCopilotActions([
      { type: 'canvas_add_widget', payload: { dsl: { kind: 'stack', title: '  速览  ', nodes: [{ c: 'metric', metric: { label: '最新价', value: '310.40' } }] } } },
    ]);
    const blocks = useAppStore.getState().canvasBlocks;
    expect(blocks.length).toBe(before + 1);
    const last = blocks[blocks.length - 1];
    expect(last.type).toBe('widget');
    const dsl = (last.data as { dsl?: { title?: string; nodes: unknown[] } }).dsl!;
    expect(dsl.title).toBe('速览');
    expect(dsl.nodes).toHaveLength(1);
    // 非法 DSL：sanitize 白名单守卫整条拒绝，画布零变化
    useAppStore.getState().handleCopilotActions([
      { type: 'canvas_add_widget', payload: { dsl: { kind: 'stack', title: 'x', nodes: [{ c: 'iframe' }] } } },
    ]);
    expect(useAppStore.getState().canvasBlocks.length).toBe(before + 1);
  });

  it('confirm 级 canvas_set_stock：确认卡入队（带人话摘要）→ 执行经 runBlockTask 落地', async () => {
    const blockId = useAppStore.getState().addCanvasBlock('kline');
    useAppStore.getState().handleCopilotActions([
      { type: 'canvas_set_stock', payload: { blockId, fullCode: 'sh600519', stockName: '茅台' } },
    ]);
    // confirm 级：不入执行，入队等拍板；摘要可读
    const pending = useAppStore.getState().pendingCopilotActions;
    expect(pending).toHaveLength(1);
    expect(pending[0].summary).toContain('换股');
    // 执行：经 runBlockTask（微任务链）落地
    useAppStore.getState().executePendingCopilotAction(pending[0].id);
    await new Promise((r) => setTimeout(r, 0));
    const data = useAppStore.getState().canvasBlocks.find((b) => b.blockId === blockId)!.data as {
      fullCode: string;
      stockName: string;
    };
    expect(data.fullCode).toBe('sh600519');
    expect(data.stockName).toBe('茅台');
  });

  it('未注册 canvas 操作静默丢弃口径不变（sanitize 白名单外整条丢弃）', () => {
    useAppStore.getState().handleCopilotActions([{ type: 'canvas_not_registered', payload: {} }]);
    expect(useAppStore.getState().pendingCopilotActions).toEqual([]);
  });
});
