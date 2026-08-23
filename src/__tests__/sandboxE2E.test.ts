/**
 * @file sandboxE2E.test.ts
 * @description 沙盘推演 Step 5 端到端集成测试（规格书 §13.3）：
 *              Store 全链路（selectStock → generatePreset → copyBranch → updateUserOrders
 *              → runSimulation → toggleCompare → deleteBranch）+ 持续持仓标的已实现/未实现
 *              盈亏拆分 + 三源过期检测（⚠️ K线 / ⚡ 资金）+ 未保存修改撤销/保存 +
 *              结构化拒绝行动指引（INSUFFICIENT_CASH ①②③ / T1_LOCK）。
 *
 *              基建要点：
 *              - fake-indexeddb + initStore()：safePersist 真实落库（discardChanges
 *                撤销恢复与 loadBranches 重载依赖落库，区别于 isInitialLoadDone=false
 *                的纯内存用例）；
 *              - vi.mock klineService：getKline 返回确定性前复权 K 线（90 根日 K 上升
 *                趋势 10→13.5，MA60 前置窗口充足），不触达真实网络；
 *              - 夹具为"持续持仓 + 倒T归并"的中长期标的：4 笔批次（开/加/减/归并）→
 *                末端 1400 股，峰值资金 16000。
 * @layer Test
 * @storage_impact 使用 fake-indexeddb 内存数据库；klineService 网络层被 mock，不触达真实网络。
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxOrder } from '../types/sandbox';
import { FULL_CODE, STOCK_NAME, makeKline, makePosition } from './helpers/sandboxFixture';

// ---- klineService 网络层 mock（vi.mock 提升到所有 import 之前） ----
const { mockGetKline, mockClearMemoryCache } = vi.hoisted(() => ({
  mockGetKline: vi.fn(),
  mockClearMemoryCache: vi.fn(),
}));

vi.mock('../services/klineService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/klineService')>();
  return { ...actual, getKline: mockGetKline, clearMemoryCache: mockClearMemoryCache };
});

import { useAppStore } from '../store';
import { useSandboxStore } from '../store/sandboxStore';
import { initStore } from '../db/storeInit';
import { db } from '../db';

// ============================================================
// 测试环境（夹具见 ./helpers/sandboxFixture.ts）
// ============================================================

beforeEach(async () => {
  await db.delete();
  await db.open();
  // initStore 置 initialLoadDone=true → safePersist 真实落库（本文件需要落库语义）
  await initStore();
  useAppStore.setState({ positions: [makePosition()] });
  useSandboxStore.getState().clearSandboxState();
  mockGetKline.mockReset();
  mockClearMemoryCache.mockReset();
  mockGetKline.mockResolvedValue({ klines: makeKline(), adjustFactors: {} });
});

// ============================================================
// 1. 全流程：选标的 → 基线 → 预设 → 复制 → 运行 → 对比（§13.3 #1）
// ============================================================

describe('Step5 E2E：全流程（选标的 → 预设 → 复制 → 运行 → 对比）', () => {
  it('选标的 → 基线分支加载并选中，结果非空（持续持仓 1400 股）', async () => {
    await useSandboxStore.getState().selectStock(FULL_CODE);
    const s = useSandboxStore.getState();

    expect(s.klineFullCode).toBe(FULL_CODE);
    expect(s.kline).toHaveLength(90);
    expect(s.klineLoading).toBe(false);
    expect(s.klineError).toBeNull();
    expect(s.branches).toHaveLength(1);

    const baseline = s.branches[0];
    expect(baseline.branchType).toBe('baseline');
    expect(baseline.stockName).toBe(STOCK_NAME);
    expect(s.selectedBranchId).toBe(baseline.id);

    expect(s.activeComputed).not.toBeNull();
    expect(s.activeComputed!.result).not.toBeNull();
    expect(s.activeComputed!.rejections).toHaveLength(0);
    expect(s.activeComputed!.result!.finalPosition).toBe(1400);
    expect(s.activeComputed!.asOfDate).toBe(s.kline[s.kline.length - 1].date);

    // memo 命中：同一分支重复读取返回同一对象（0ms 切换）
    expect(s.getComputed(baseline.id)).toBe(s.activeComputed);
  });

it('6 大标准策略全部可一键生成并跑通引擎（不变量校验）', async () => {
    await useSandboxStore.getState().selectStock(FULL_CODE);
    const s = () => useSandboxStore.getState();

    const ids = ['ma20-bounce', 'pyramid', 'grid', 'stop-profit', 'max-opportunity', 'pure-dca'] as const;
    for (const id of ids) {
      await s().generatePreset(id, {}, { simulatedCash: 60000 });
      const st = s();
      const preset = st.branches.find((b) => b.branchType === 'preset' && b.presetStrategyId === id);
      expect(preset).toBeDefined();
      expect(st.activeComputed).not.toBeNull();
      const all = st.activeComputed!.orders;
      all.forEach((o, i) => {
        expect(['buy', 'sell']).toContain(o.action);
        expect(o.price).toBeGreaterThan(0);
        expect(o.quantity).toBeGreaterThan(0);
        expect(o.quantity % 100).toBe(0);
        expect(o.seqIndex).toBe(i);
      });
    }
    expect(s().branches.filter((b) => b.branchType === 'preset')).toHaveLength(6);
  });
  it('复制预设为可编辑演练 → 编辑草稿 → 撤销还原 → 运行并保存 → 落库重载', async () => {
    const store = useSandboxStore.getState();
    await store.selectStock(FULL_CODE);
    const baselineId = useSandboxStore.getState().branches[0].id;
    await useSandboxStore.getState().generatePreset('pure-dca', { period: 29 }, { simulatedCash: 30000 });
    const presetId = useSandboxStore.getState().selectedBranchId!;

    // 复制 → user 分支（深拷贝完整时间线，基线标记保留）
    await useSandboxStore.getState().copyBranch(presetId);
    let s = useSandboxStore.getState();
    const user = s.branches.find((b) => b.branchType === 'user')!;
    expect(user.parentPresetId).toBe(presetId);
    expect(s.selectedBranchId).toBe(user.id);
    expect(s.activeComputed!.orders).toHaveLength(3); // 纯策略独立推演：仅 3 笔生成买入（无基线）
    expect(s.activeComputed!.orders.filter((o) => o.isBaseline)).toHaveLength(0);
    expect(s.dirtyBranchIds).toHaveLength(0); // 复制即落库，非草稿

    // 编辑：删除第一笔派生买入（非基线）→ 草稿态（未保存标记）
    // 基线是共享/只读锚点：只删策略派生的派生买入，不碰基线订单（含基线卖出）。
    const genIdx = s.activeComputed!.orders.findIndex((o) => !o.isBaseline);
    const edited = genIdx >= 0 ? s.activeComputed!.orders.filter((_, i) => i !== genIdx) : s.activeComputed!.orders;
    useSandboxStore.getState().updateUserOrders(user.id, edited);
    s = useSandboxStore.getState();
    expect(s.dirtyBranchIds).toContain(user.id);
    expect(s.activeComputed!.orders).toHaveLength(2);

    // 撤销修改 → 从 DB 还原复制时的 3 笔
    await useSandboxStore.getState().discardChanges(user.id);
    s = useSandboxStore.getState();
    expect(s.dirtyBranchIds).not.toContain(user.id);
    expect(s.activeComputed!.orders).toHaveLength(3);

    // 再次编辑 → ▶ 运行并保存（落库 + 盖章评估日 + 清未保存标记）
    useSandboxStore.getState().updateUserOrders(user.id, edited);
    await useSandboxStore.getState().runSimulation(user.id);
    s = useSandboxStore.getState();
    expect(s.dirtyBranchIds).toHaveLength(0);
    const saved = s.branches.find((b) => b.id === user.id)!;
    expect(saved.status).toBe('completed');
    expect(saved.dataAsOfDate).toBe(s.kline[s.kline.length - 1].date);

    // loadBranches 重载：分支与订单均从库恢复
    await useSandboxStore.getState().loadBranches(FULL_CODE);
    s = useSandboxStore.getState();
    expect(s.branches).toHaveLength(3); // baseline + preset + user
    expect(s.getComputed(user.id)!.orders).toHaveLength(2);
  });

  it('勾选对比分支 / 切换选中 / 删除分支', async () => {
    const store = useSandboxStore.getState();
    await store.selectStock(FULL_CODE);
    const baselineId = useSandboxStore.getState().branches[0].id;
    await useSandboxStore.getState().generatePreset('pyramid', { levels: 3, stepPercent: 3 }, { simulatedCash: 30000 });
    const presetId = useSandboxStore.getState().selectedBranchId!;

    const s = () => useSandboxStore.getState();
    s().toggleCompare(baselineId);
    expect(s().comparedBranchIds).toEqual([baselineId]);
    s().toggleCompare(presetId);
    expect(s().comparedBranchIds).toEqual([baselineId, presetId]);
    s().toggleCompare(presetId); // 再点取消
    expect(s().comparedBranchIds).toEqual([baselineId]);

    // 切换选中：基线（memo 0ms）
    s().selectBranch(baselineId);
    expect(s().selectedBranchId).toBe(baselineId);
    expect(s().activeComputed!.result!.finalPosition).toBe(1400);

    // 复制并删除 user 分支
    await s().copyBranch(presetId);
    const userId = s().selectedBranchId!;
    expect(s().branches).toHaveLength(3);
    await s().deleteBranch(userId);
    expect(s().branches).toHaveLength(2);
    expect(s().branches.every((b) => b.id !== userId)).toBe(true);
  });
});

// ============================================================
// 2. 持续持仓标的：已实现 / 未实现盈亏显式拆分（§13.3 #2）
// ============================================================

describe('Step5 E2E：持续持仓标的（已实现 / 未实现拆分 + 峰值资金锁定）', () => {
  it('基线：锁定峰值资金、已实现>0、未实现=剩余持仓浮盈、自校验通过、归并批次入线', async () => {
    await useSandboxStore.getState().selectStock(FULL_CODE);
    const s = () => useSandboxStore.getState();
    const baseline = s().branches[0];
    const computed = s().activeComputed!;

    // 基线永远锁历史峰值（16010.16 = 10005.10 + 6005.06，含规费），setSimulatedCash 对基线是 no-op
    expect(baseline.peakCapitalLock).toBe(16010.16);
    expect(baseline.simulatedCash).toBe(16010.16);
    s().setSimulatedCash(baseline.id, 99999);
    expect(s().branches.find((b) => b.id === baseline.id)!.simulatedCash).toBe(16010.16);

    // 已实现 / 未实现显式拆分（评估日统一清算）
    const r = computed.result!;
    expect(r.asOfDate).toBe(computed.asOfDate);
    expect(r.finalPosition).toBe(1400); // 持仓中（含归并批次）
    expect(r.realizedProfit).toBeGreaterThan(0); // 减仓 300 股已落袋
    expect(r.unrealizedProfit).toBeGreaterThan(0); // 剩余 1400 股浮盈
    expect(r.finalProfit).toBeCloseTo(r.realizedProfit + r.unrealizedProfit, 2);
    expect(r.totalFees).toBeGreaterThan(0);
    expect(r.totalStampTax).toBeGreaterThan(0); // 卖出需缴纳印花税

    // 基线自校验通过：推演末端持股 = 真实当前持股 → 无警示
    expect(computed.warnings.some((w) => w.includes('基线校验异常'))).toBe(false);
  });
});

// ============================================================
// 3. 过期检测：⚠️ K线 / ⚡ 资金（§13.3 #3，全部用户点击触发）
// ============================================================

describe('Step5 E2E：过期检测（⚠️ K线更新 / ⚡ 资金变动）', () => {
  it('行情更新（下次访问）→ ⚠️ 出现 → refreshKline 更新指标 → runSimulation 盖章清除', async () => {
    await useSandboxStore.getState().selectStock(FULL_CODE);
    const baselineId = useSandboxStore.getState().branches[0].id;
    expect(useSandboxStore.getState().staleFlagsFor(baselineId)).toEqual({
      kline: false,
      cash: false,
      baseline: false,
    });

    // 模拟下次访问：上游新增一个交易日，重新进入工作台
    // （基线分支从 DB 载入，dataAsOfDate 仍是上次盖章日期 → ⚠️ 出现）
    const extended = makeKline(91);
    mockGetKline.mockResolvedValue({ klines: extended, adjustFactors: {} });
    await useSandboxStore.getState().selectStock(FULL_CODE);
    const s = () => useSandboxStore.getState();
    expect(s().kline).toHaveLength(91);
    expect(s().selectedBranchId).toBe(baselineId); // 复访仍选中基线
    expect(s().staleFlagsFor(baselineId).kline).toBe(true); // ⚠️ 出现

    // 点击刷新：用最新 K 线重新推演（指标按新评估日重算）
    await s().refreshKline();
    expect(s().kline).toHaveLength(91);
    expect(s().activeComputed!.asOfDate).toBe(extended[extended.length - 1].date);
    expect(s().activeComputed!.result!.asOfDate).toBe(extended[extended.length - 1].date);
    expect(s().staleFlagsFor(baselineId).kline).toBe(true); // dataAsOfDate 尚未盖章

    // ▶ 运行并保存 → 盖章 dataAsOfDate → ⚠️ 清除
    await s().runSimulation(baselineId);
    expect(s().staleFlagsFor(baselineId).kline).toBe(false);
  });

  it('资金变动 → ⚡ 出现（订单数量保持原生成基准）→ rescalePreset 重算股数 → ⚡ 清除', async () => {
    await useSandboxStore.getState().selectStock(FULL_CODE);
    await useSandboxStore.getState().generatePreset('stop-profit', {}, { simulatedCash: 20000 });
    const s = () => useSandboxStore.getState();
    const presetId = s().selectedBranchId!;
    expect(s().staleFlagsFor(presetId).cash).toBe(false);

    // 全额独立预算：纯策略自建仓（无基线）→ 至少一笔入场（资金足够勿 5000 触到 20% 手数取整为 0）
    const baseCount = s().activeComputed!.orders.length;
    expect(baseCount).toBeGreaterThanOrEqual(2);
    expect(s().activeComputed!.orders.filter((o) => !o.isBaseline)).toHaveLength(baseCount);

    // 调高模拟资金 → ⚡ 出现；但 ⚡ 重算前订单（数量）保持原生成基准不变（延迟重算）
    s().setSimulatedCash(presetId, 60000);
    expect(s().staleFlagsFor(presetId).cash).toBe(true);
    expect(s().activeComputed!.orders).toHaveLength(baseCount);

    // 点击 ⚡ 重配：按新资金重算股数 → 预案单数增长/用量放大，⚡ 清除
    await s().rescalePreset(presetId);
    expect(s().staleFlagsFor(presetId).cash).toBe(false);
    expect(s().activeComputed!.orders.length).toBeGreaterThanOrEqual(baseCount);
    // 点击 ⚡ 重配完成后结果生效
    expect(s().activeComputed!.result).not.toBeNull();
    expect(s().activeComputed!.rejections).toHaveLength(0);
  });
});

// ============================================================
// 5. 未保存修改：草稿 → 撤销 / 保存（§13.3 #5）
// ============================================================

describe('Step5 E2E：未保存修改（草稿标记 → 撤销还原 / 运行落库）', () => {
  it('编辑产生未保存标记，撤销从库还原，运行后落库且标记清除', async () => {
    await useSandboxStore.getState().selectStock(FULL_CODE);
    const baselineId = useSandboxStore.getState().branches[0].id;
    await useSandboxStore.getState().copyBranch(baselineId);
    const s = () => useSandboxStore.getState();
    const userId = s().selectedBranchId!;
    const original = s().activeComputed!.orders;
    expect(original).toHaveLength(4); // 4 笔基线拷贝

    // 改一笔买入价格 → 草稿态
    const priceBefore = s().activeComputed!.result!.finalProfit;
    const edited = original.map((o, i) =>
      i === 1 ? { ...o, price: 11.5, note: '修改买入价' } : o,
    );
    s().updateUserOrders(userId, edited);
    expect(s().dirtyBranchIds).toContain(userId);
    expect(s().activeComputed!.result!.finalProfit).not.toBe(priceBefore); // 指标实时刷新

    // 撤销修改 → 从库还原（复制时落库的 4 笔原始订单）
    await s().discardChanges(userId);
    expect(s().dirtyBranchIds).not.toContain(userId);
    expect(s().activeComputed!.orders).toHaveLength(4);
    expect(s().activeComputed!.orders[1].price).toBe(12); // 还原为复制时的价格

    // 再次编辑 → 运行并保存 → 落库 + 标记清除
    s().updateUserOrders(userId, edited);
    await s().runSimulation(userId);
    expect(s().dirtyBranchIds).toHaveLength(0);
    const savedBranch = s().branches.find((b) => b.id === userId)!;
    expect(savedBranch.status).toBe('completed');

    // 换分支再切回：订单从库重载（修改已持久化）
    s().selectBranch(baselineId);
    await s().loadBranches(FULL_CODE);
    expect(s().getComputed(userId)!.orders[1].price).toBe(11.5);
  });
});

// ============================================================
// 6. 拦截引导：结构化拒绝 + 可执行行动选项（§13.3 #6）
// ============================================================

describe('Step5 E2E：结构化拒绝行动指引（白话原因 + 一键补救）', () => {
  it('INSUFFICIENT_CASH：资金不足 → ①②③ 行动选项，减至最大可买量后重跑通过', async () => {
    await useSandboxStore.getState().selectStock(FULL_CODE);
    const baselineId = useSandboxStore.getState().branches[0].id;
    await useSandboxStore.getState().copyBranch(baselineId);
    const s = () => useSandboxStore.getState();
    const userId = s().selectedBranchId!;
    const lastDate = s().kline[s().kline.length - 1].date;

    // 在基线末尾追加一笔远超剩余现金的买入（1000 股 × ¥13.5）
    const bigBuy: SandboxOrder = {
      id: 'buy-big',
      branchId: userId,
      seqIndex: 99,
      action: 'buy',
      timestamp: `${lastDate}T09:30:00+08:00`,
      price: 13.5,
      quantity: 1000,
    };
    s().updateUserOrders(userId, [...s().activeComputed!.orders, bigBuy]);

    const computed = s().activeComputed!;
    expect(computed.result).toBeNull(); // 任一订单被拒 → 无结果
    const rej = computed.rejections.find((r) => r.code === 'INSUFFICIENT_CASH');
    expect(rej).toBeDefined();
    expect(rej!.orderId).toBe('buy-big');
    expect(rej!.message).toContain('超出当前方案预算上限');

    // ①②③ 行动选项齐备
    const reduce = rej!.actions.find((a) => a.kind === 'reduce-qty');
    const raise = rej!.actions.find((a) => a.kind === 'raise-cash');
    const insertSell = rej!.actions.find((a) => a.kind === 'insert-sell');
    expect(reduce).toBeDefined();
    expect(reduce!.payload!.maxQty).toBeGreaterThan(0); // 先扣规费再取整 100 股
    expect(raise).toBeDefined();
    expect(raise!.payload!.shortfall).toBeGreaterThan(0);
    expect(insertSell).toBeDefined();

    // 执行 ① 减至最大可买量 → 重跑通过
    const fixed = computed.orders.map((o) =>
      o.id === 'buy-big' ? { ...o, quantity: reduce!.payload!.maxQty } : o,
    );
    s().updateUserOrders(userId, fixed);
    const after = s().activeComputed!;
    expect(after.rejections).toHaveLength(0);
    expect(after.result).not.toBeNull();
  });

  it('T1_LOCK：当日买入后超额卖出 → 改卖昨日底仓后通过', async () => {
    await useSandboxStore.getState().selectStock(FULL_CODE);
    const baselineId = useSandboxStore.getState().branches[0].id;
    await useSandboxStore.getState().copyBranch(baselineId);
    const s = () => useSandboxStore.getState();
    const userId = s().selectedBranchId!;
    const lastDate = s().kline[s().kline.length - 1].date;

    // 复制基线（1400 股底仓）→ 在评估日追加：当日买入 100 股后想卖出 1500 股
    // （可卖 = 底仓 1400，超额 100 触发 T+1 锁定）
    const baseOrders = s().activeComputed!.orders; // 4 笔基线拷贝
    const extra: SandboxOrder[] = [
      { id: 't1-buy', branchId: userId, seqIndex: 99, action: 'buy', timestamp: `${lastDate}T09:30:00+08:00`, price: 13.5, quantity: 100 },
      { id: 't1-sell', branchId: userId, seqIndex: 99, action: 'sell', timestamp: `${lastDate}T10:00:00+08:00`, price: 13.8, quantity: 1500 },
    ];
    s().updateUserOrders(userId, [...baseOrders, ...extra]);

    const computed = s().activeComputed!;
    const rej = computed.rejections.find((r) => r.code === 'T1_LOCK');
    expect(rej).toBeDefined();
    expect(rej!.message).toContain('T+1');
    expect(rej!.actions.some((a) => a.kind === 'move-date')).toBe(true);
    const reduce = rej!.actions.find((a) => a.kind === 'reduce-qty');
    expect(reduce).toBeDefined();
    expect(reduce!.payload!.maxQty).toBe(1400); // 当日最多可卖 = 底仓 1400

    // 执行 ② 改卖昨日底仓 1400 股 → 通过，剩余 100 股持仓
    const fixed = computed.orders.map((o) =>
      o.id === 't1-sell' ? { ...o, quantity: reduce!.payload!.maxQty } : o,
    );
    s().updateUserOrders(userId, fixed);
    const after = s().activeComputed!;
    expect(after.rejections).toHaveLength(0);
    expect(after.result).not.toBeNull();
    expect(after.result!.finalPosition).toBe(100);
  });
});