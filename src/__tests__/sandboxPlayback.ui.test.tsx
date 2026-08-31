/**
 * @file sandboxPlayback.ui.test.tsx
 * @description 沙盘复盘页面组件级 UI 测试（规格书 §13.3 #4/#5/#6 的 UI 层）：
 *              - ④ MetricsPanel 新手模式：默认只显示 4 个核心数字（最终收益额 / 累计
 *                收益率 / 持仓均价变化 / 最大回撤），切「专业模式」展开全量高阶指标，
 *                模式记忆在 localStorage（sandbox-expert-mode）；
 *              - ⑤ 未保存修改浮动栏：编辑 user 分支 → 浮动栏出现（检测到 N 处修改 /
 *                ▶ 运行并保存推演 / 撤销修改）→ 撤销从库还原 → 再次编辑 → 运行落库；
 *              - ⑥ RejectionDialog 结构化拒绝：INSUFFICIENT_CASH 弹窗渲染白话原因 +
 *                ①②③ 一键补救按钮，点击「减至最大可买量」后引擎重算通过、弹窗自动关闭。
 *
 *              基建要点：
 *              - 渲染整个 SandboxPlayback 页面（真实组件树，store 全链路）；
 *              - vi.mock klineService：getKline 返回确定性前复权 K 线（同 E2E 夹具）；
 *              - vi.mock KlineChart：jsdom 无 canvas，lightweight-charts 无法渲染，
 *                用无 canvas 桩替换（其余组件全部真实渲染）；
 *              - fake-indexeddb + initStore()：safePersist 真实落库（撤销恢复 / 重载
 *                校验依赖落库语义）；localStorage 每用例前清空。
 * @layer Test
 * @storage_impact 使用 fake-indexeddb 内存数据库；localStorage 记录极简/专业模式。
 */

// @vitest-environment jsdom

import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxOrder } from '../types/sandbox';

import { useAppStore } from '../store';
import { useSandboxStore } from '../store/sandboxStore';
import { initStore } from '../store/bootstrap';
import { db } from '../db';
import SandboxPlayback from '../views/SandboxPlayback';
import { FULL_CODE, makeKline, makePosition } from './helpers/sandboxFixture';

// ---- klineService 网络层 mock（vi.mock 提升到所有 import 之前） ----
const { mockGetKline, mockClearMemoryCache } = vi.hoisted(() => ({
  mockGetKline: vi.fn(),
  mockClearMemoryCache: vi.fn(),
}));

vi.mock('../services/klineService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/klineService')>();
  return { ...actual, getKline: mockGetKline, clearMemoryCache: mockClearMemoryCache };
});

// ---- KlineChart 桩（jsdom 无 canvas，lightweight-charts 不可渲染；其余组件真实渲染） ----
vi.mock('../components/sandbox/KlineChart', () => ({
  __esModule: true,
  default: ({ kline }: { kline: { date: string }[] | null }) => (
    <div data-testid="mock-kline-chart" data-bars={kline ? kline.length : 0} />
  ),
}));

// ============================================================
// 测试环境
// ============================================================

beforeEach(async () => {
  await db.delete();
  await db.open();
  // initStore 置 initialLoadDone=true → safePersist 真实落库（撤销/重载校验依赖落库语义）
  await initStore();
  useAppStore.setState({ positions: [makePosition()] });
  useSandboxStore.getState().clearSandboxState();
  localStorage.clear();
  mockGetKline.mockReset();
  mockClearMemoryCache.mockReset();
  mockGetKline.mockResolvedValue({ klines: makeKline(), adjustFactors: {} });
});

/** 选标的 + 复制基线 → user 分支自动选中（返回 userId） */
async function setupUserBranch(): Promise<string> {
  // 注意：zustand set() 生成新 state 对象，不能持有旧的 getState() 引用（会读到旧分支数组）
  await useSandboxStore.getState().selectStock(FULL_CODE);
  const baselineId = useSandboxStore.getState().branches[0].id;
  await useSandboxStore.getState().copyBranch(baselineId);
  return useSandboxStore.getState().selectedBranchId!;
}

/** 点击触发「异步 store action」的按钮：在 act 内推进宏任务，吞掉 act 警告 */
async function clickInAct(btn: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(btn);
    // 让 discardChanges / runSimulation 内部的 IndexedDB 异步链在 act 内完成
    await new Promise((r) => setTimeout(r, 30));
  });
}

/** 修改受控输入（RTL fireEvent 不带 act 包装，需手动包裹） */
function changeInAct(el: HTMLElement, value: string): void {
  act(() => {
    fireEvent.change(el, { target: { value } });
  });
}

// ============================================================
// 4. 新手模式：极简 4 数字 ⇄ 专业全量（§13.3 #4 的 UI 层）
// ============================================================

describe('Step5 UI：④ 新手模式指标面板（极简 4 数字 / 专业全量）', () => {
  it('默认只显示 4 个核心数字；切专业模式展开全量并记忆到 localStorage', async () => {
    await useSandboxStore.getState().selectStock(FULL_CODE);
    render(<SandboxPlayback />);

    // 极简模式：4 个核心数字齐备
    expect(screen.getByText('最终收益额')).toBeInTheDocument();
    expect(screen.getByText('累计收益率')).toBeInTheDocument();
    expect(screen.getByText('持仓均价变化')).toBeInTheDocument();
    expect(screen.getByText('最大回撤')).toBeInTheDocument();

    // 专业模式指标默认隐藏（注意：侧栏 ScenarioCard 常驻展示已实现盈亏/未实现(股数)，
    // 因此只用 MetricsPanel 专业区块独有的标签做断言）
    expect(screen.queryByText('持仓波动率')).not.toBeInTheDocument();
    expect(screen.queryByText('未实现盈亏')).not.toBeInTheDocument();
    expect(screen.queryByText('死拿不动 · 收益率')).not.toBeInTheDocument();
    expect(screen.queryByText('累计手续费')).not.toBeInTheDocument();
    expect(screen.queryByText('累计印花税')).not.toBeInTheDocument();
    expect(screen.queryByText('资金占用周期')).not.toBeInTheDocument();

    // 顶部「极简」→ 切专业模式：全量指标展开 + localStorage 记忆
    fireEvent.click(screen.getByRole('button', { name: /^极简$/ }));
    expect(screen.getByText('持仓波动率')).toBeInTheDocument();
    expect(screen.getByText('未实现盈亏')).toBeInTheDocument();
    expect(screen.getByText('死拿不动 · 收益率')).toBeInTheDocument();
    expect(screen.getByText('累计手续费')).toBeInTheDocument();
    expect(screen.getByText('累计印花税')).toBeInTheDocument();
    expect(screen.getByText('资金占用周期')).toBeInTheDocument();
    expect(localStorage.getItem('sandbox-expert-mode')).toBe('1');

    // 指标面板头部按钮切回极简：全量收起 + 记忆清除
    fireEvent.click(screen.getByRole('button', { name: /专业模式/ }));
    expect(screen.queryByText('持仓波动率')).not.toBeInTheDocument();
    expect(screen.queryByText('死拿不动 · 收益率')).not.toBeInTheDocument();
    expect(localStorage.getItem('sandbox-expert-mode')).toBe('0');
  });
});

// ============================================================
// 5. 未保存修改浮动栏（§13.3 #5 的 UI 层）
// ============================================================

describe('Step5 UI：⑤ 未保存修改浮动栏', () => {
  it('编辑 user 分支 → 浮动栏出现 → 撤销还原 → 再次编辑 → 运行并保存落库', async () => {
    const userId = await setupUserBranch();
    render(<SandboxPlayback />);

    // user 分支时间线 4 笔基线拷贝；改第 2 笔（加仓 500@12）买入价 → 草稿态
    const priceInput = screen.getByDisplayValue('12');
    changeInAct(priceInput, '11.5');

    // 浮动保存栏出现：提示 + ▶ 运行并保存 + 撤销修改
    expect(await screen.findByText(/检测到 1 处修改未保存/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /运行并保存推演/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /撤销修改/ })).toBeInTheDocument();

    // 撤销修改 → 从库还原（价格回到 12）+ 浮动栏消失
    await clickInAct(screen.getByRole('button', { name: /撤销修改/ }));
    await waitFor(() => {
      expect(screen.queryByText(/检测到 1 处修改未保存/)).not.toBeInTheDocument();
    });
    expect(useSandboxStore.getState().dirtyBranchIds).not.toContain(userId);
    expect(screen.getByDisplayValue('12')).toBeInTheDocument();

    // 再次编辑 → 运行并保存 → 落库 + 标记清除
    changeInAct(screen.getByDisplayValue('12'), '11.5');
    await screen.findByText(/检测到 1 处修改未保存/);
    await clickInAct(screen.getByRole('button', { name: /运行并保存推演/ }));
    await waitFor(() => {
      expect(useSandboxStore.getState().dirtyBranchIds).toHaveLength(0);
    });
    const saved = useSandboxStore.getState().branches.find((b) => b.id === userId)!;
    expect(saved.status).toBe('completed');

    // 换分支再切回 → 订单从库重载，修改已持久化
    const baselineId = useSandboxStore.getState().branches.find((b) => b.branchType === 'baseline')!.id;
    act(() => {
      useSandboxStore.getState().selectBranch(baselineId);
    });
    await act(async () => {
      await useSandboxStore.getState().loadBranches(FULL_CODE);
    });
    expect(useSandboxStore.getState().getComputed(userId)!.orders[1].price).toBe(11.5);
  });
});

// ============================================================
// 6. 结构化拒绝行动指引（§13.3 #6 的 UI 层）
// ============================================================

describe('Step5 UI：⑥ RejectionDialog 结构化拒绝', () => {
  it('INSUFFICIENT_CASH：弹窗渲染白话原因 + ①②③ 补救按钮，点击减至最大可买量后通过', async () => {
    const userId = await setupUserBranch();
    render(<SandboxPlayback />);
    const s = () => useSandboxStore.getState();
    const lastDate = s().kline[s().kline.length - 1].date;

    // 在基线末尾追加一笔远超剩余现金的买入（1000 股 × ¥13.5）→ 引擎拒绝
    const bigBuy: SandboxOrder = {
      id: 'buy-big',
      branchId: userId,
      seqIndex: 99,
      action: 'buy',
      timestamp: `${lastDate}T09:30:00+08:00`,
      price: 13.5,
      quantity: 1000,
    };
    act(() => {
      s().updateUserOrders(userId, [...s().activeComputed!.orders, bigBuy]);
    });

    // 弹窗：标题 + 白话原因 + ①②③ 行动按钮齐备
    expect(await screen.findByText('这笔操作被推演引擎拦下了')).toBeInTheDocument();
    expect(screen.getByText(/超出当前方案预算上限/)).toBeInTheDocument();
    const reduceBtn = screen.getByRole('button', { name: /按可用资金反算/ });
    expect(screen.getByRole('button', { name: /先插入一笔卖出释放现金/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /调高/ })).toBeInTheDocument();

    // 点击 ① 减至最大可买量 → 重算通过，弹窗自动关闭
    const maxQty = s()
      .activeComputed!.rejections.find((r) => r.code === 'INSUFFICIENT_CASH')!
      .actions.find((a) => a.kind === 'reduce-qty')!.payload!.maxQty!;
    fireEvent.click(reduceBtn);
    await waitFor(() => {
      expect(screen.queryByText('这笔操作被推演引擎拦下了')).not.toBeInTheDocument();
    });
    const after = s().activeComputed!;
    expect(after.rejections).toHaveLength(0);
    expect(after.result).not.toBeNull();
    expect(after.orders.find((o) => o.id === 'buy-big')!.quantity).toBe(maxQty);
  });
});
