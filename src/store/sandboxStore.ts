/**
 * @file sandboxStore.ts
 * @description 沙盘推演（事后复盘 / What-if）状态中心（Zustand）：管理三类分支
 *              （baseline 基线 / preset 预设 / user 用户方案）的生命周期、K 线数据、
 *              过期检测（⚠️ K线更新 / ⚡ 资金变动 / 🔄 基线变化，全部用户点击触发，
 *              系统绝不自动刷新，见规格书 §8）与非响应式结果 Memo（§6.3）。
 *
 * 【分支三态派生规则】
 *  - baseline：订单 = extractBaseline(position) → 复权系数换算（qfq）实时派生，不落库；
 *    仅存 baselinePositionId 关联；jitterFactor 强制 0（基线是真实成交锚点，不做滑点）。
 *  - preset  ：只存策略元数据（presetStrategyId/presetParams）；订单 = 基线 + 策略生成
 *    合并派生；数量基准 = generatedAtCash（⚡ 重算前保持原仓位），预算基准 = simulatedCash。
 *  - user    ：savedOrders 完整时间线（复制时深拷贝，含 isBaseline 标记的真实历史拷贝）
 *    落库；用户可自由增删改（草稿先存内存，[▶ 运行并保存] 才落库，撤销恢复从库重载）。
 *
 * 【缓存架构】
 *  - 模块级 memoCache（非响应式）：key = branch.id|simulatedCash|generatedAtCash|
 *    jitterFactor|jitterWindowSize|presetParams|基线指纹#基线内容摘要|费率指纹|
 *    K线长度|末根日期|末根收盘；资金/持仓/K线/基线内容/费率任一变化自动失效；
 *    用户订单编辑显式 invalidate。基线内容摘要解决了「批次数/末笔时间/持股数
 *    均未变但中间批次内容变化（如修正首笔建仓日期）导致缓存键碰撞」的问题。
 *  - savedOrdersCache（非响应式）：user 分支订单内存副本。
 *  - K 线三级缓存由 services/klineService.ts 负责（内存 → IndexedDB → 网络增量）。
 * @layer Store
 * @storage_impact 读写 IndexedDB sandboxBranches / sandboxOrders 表（经 db/index.ts
 *                 的 putSandboxBranch / bulkPutSandboxOrders / deleteSandboxBranch 等，
 *                 统一走 safePersist 重试队列）；K 线数据经 klineService 读写 klineCache。
 * @author 开发团队
 */

import { create } from 'zustand';
import type { Position } from './types';
import { generateId } from './utils';
import { useAppStore } from './index';
import { safePersist } from './persistence';
import { recordAudit } from '../risk/auditLogger';
import { matchSecurityKind, type FeeConfig } from '../utils/mathUtils';
import { extractBaseline } from '../utils/baselineExtractor';
import { runSandboxEngine, type EngineOptions, type EngineRejection } from '../utils/sandboxEngine';
import { enrichResult } from '../utils/metricsEngine';
import {
  generateStrategyOrders,
  STRATEGY_GENERATORS,
  type StrategyContext,
} from '../utils/strategyGenerators';
import {
  getKline,
  getAdjustFactor,
  clearMemoryCache,
  type AdjustFactorMap,
} from '../services/klineService';
import {
  putSandboxBranch,
  loadSandboxBranchesFromDB,
  deleteSandboxBranch,
  bulkPutSandboxOrders,
  loadSandboxOrdersByBranchId,
  fetchAllClosedPositions,
} from '../db';
import type {
  CashInjection,
  KlineItem,
  PresetStrategyId,
  SandboxBranch,
  SandboxOrder,
  SandboxResult,
} from '../types/sandbox';

// ============================================================
// 模块级非响应式缓存（规格书 §6.3：派生数据不进响应式 state）
// ============================================================

/** 分支计算结果缓存（LRU 上限） */
const memoCache = new Map<string, BranchComputed>();
const MEMO_LIMIT = 300;

/** user 分支订单内存副本（branchId → orders；[▶ 运行并保存] 才写库） */
const savedOrdersCache = new Map<string, SandboxOrder[]>();

/** 当前选中标的的上下文（单标的工作台） */
let positionCache: Position | null = null;
let currentFullCode = '';
/** 当前基线的前复权订单（已按复权系数换算，全分支共享的锚点） */
let currentBaselineOrders: SandboxOrder[] = [];
/** 当前基线指纹（extractBaseline(position).signature） */
let currentBaselineSignature = '';

/** 选股并发令牌：防止快速切换标的时旧请求覆盖新状态 */
let loadToken = 0;

// ============================================================
// 类型定义
// ============================================================

/** 分支计算结果（memo 缓存值；result 为 null 表示存在结构化拒绝） */
export interface BranchComputed {
  /** 实际参与推演的订单（基线换算后 / 基线+预设合并 / 用户完整时间线） */
  orders: SandboxOrder[];
  /** 推演结果（引擎成功时非空，已补齐波动率与 B&H） */
  result: SandboxResult | null;
  /** 结构化拒绝（白话原因 + 行动指引，UI 渲染对话框） */
  rejections: EngineRejection[];
  /** 非致命警示（如中途浮盈回吐、基线自校验异常） */
  warnings: string[];
  /** 方案运行所需瞬时最大资金峰值（元）：即使存在拒单也照常计算，
   *  供 UI「一键调高模拟资金至 ¥X」闭环解法使用。 */
  peakRequiredCash: number;
  /** 评估日（= 末根 K 线日期，全分支共享） */
  asOfDate: string;
  /** 数据截至日期 */
  dataAsOfDate: string;
  /**
   * 预设策略零成交时的策略自身原因（仅 preset 分支、orders 为空时给出），
   * 供 UI 在空时间线处解释“为何没买卖”（属策略门槛而非引擎/资金拒绝）。
   */
  inactivityReason?: string;
  /** 策略自身生成的订单数（不计入基线合并订单；baseline/user 分支为 0） */
  generatedOrdersCount: number;
  /** 是否为策略可用预算 ≤ 0（baseline 预留后无剩余资金开仓） */
  strategyBudgetExhausted: boolean;
}

/** 分支计算上下文（纯函数入参，便于单测） */
export interface BranchComputeContext {
  /** 前复权日 K 线 */
  kline: KlineItem[];
  /** 复权系数表 */
  factors: AdjustFactorMap;
  /** 当前基线订单（已换算到前复权口径） */
  baselineOrders: SandboxOrder[];
  /** 当前基线指纹（memo 键的一部分：持仓变化自动失效） */
  baselineSignature: string;
  /** 真实持仓（供策略生成器取当前成本/股数；可为 null） */
  position: Position | null;
  /** 全局费率配置 */
  feeConfig: FeeConfig;
  /** 证券类型（股票/ETF/债券，走对应费率） */
  securityKind: 'stock' | 'etf' | 'bond';
}

/** 过期检测结果（§8：三个过期源，全部用户点击触发） */
export interface StaleFlags {
  /** ⚠️ K 线已更新至新日期，点击刷新（重新推演并盖章 dataAsOfDate） */
  kline: boolean;
  /** ⚡ 资金已变动，点击重算（仅 preset：按新资金重算股数，价格点位不变） */
  cash: boolean;
  /** 🔄 基线已变化，点击重建（重建基线 + 重跑） */
  baseline: boolean;
}

// ---- 响应式状态最小集（§6.3） ----

interface SandboxStoreState {
  /** 当前标的的全部分支（baseline + preset + user，按 updatedAt 降序由 DB 返回） */
  branches: SandboxBranch[];
  /** 当前选中分支 */
  selectedBranchId: string | null;
  /** 参与对比的分支（对比表与散点图消费） */
  comparedBranchIds: string[];
  /** 当前显示结果（selectBranch 等 action 内同步计算后 set 一次） */
  activeComputed: BranchComputed | null;
  /** 有未保存修改的 user 分支（底部浮动保存栏 [▶ 运行并保存] / [撤销修改]） */
  dirtyBranchIds: string[];

  /** 当前标的的前复权日 K 线 */
  kline: KlineItem[];
  /** 复权系数表（真实成交价 → 前复权口径换算用） */
  adjustFactors: AdjustFactorMap;
  /** 已选标的（K 线归属） */
  klineFullCode: string | null;
  /** K 线加载中 */
  klineLoading: boolean;
  /** K 线加载错误（白话提示） */
  klineError: string | null;
}

interface SandboxStoreActions {
  /** 从 DB 加载某标的的全部分支（并预载 user 分支订单到内存缓存） */
  loadBranches: (fullCode: string) => Promise<void>;
  /** 选择标的：解析持仓（开放或已平仓）→ 加载 K 线 → 确保基线分支 → 选中基线 */
  selectStock: (fullCode: string, stockName?: string) => Promise<void>;
  /** 选中分支（同步计算，memo 命中 0ms） */
  selectBranch: (branchId: string) => void;
  /** 勾选/取消勾选对比分支 */
  toggleCompare: (branchId: string) => void;
  /** 调整模拟资金（基线不动；preset 出现 ⚡，user 直接生效） */
  setSimulatedCash: (branchId: string, cash: number) => void;
  /** 一键把模拟资金上调到所需资金量（向上取整到千位）并自动重跑；基线不动 */
  raiseCashToRequired: (branchId: string, requiredCash: number) => void;
  /** 一键把某笔订单缩减到指定数量（100 股取整）并重跑（仅 user 分支，标记未保存） */
  adjustOrderQty: (branchId: string, orderId: string, newQty: number) => void;
  /** 按比例缩放方案下所有买入订单（100 股取整，仅 user 分支）并重跑 */
  scaleAllBuyOrders: (branchId: string, scaleFactor: number) => void;
  addCashInjection: (branchId: string, date: string, amount: number) => void;
  setMonthlyDCA: (branchId: string, amount: number) => void;
  clearCashInjections: (branchId: string) => void;
  /** 一键生成预设方案（策略 + 参数 + 模拟资金 + 抖动系数）→ 建 preset 分支并选中 */
  generatePreset: (
    strategyId: PresetStrategyId,
    params: Record<string, number>,
    options?: { simulatedCash?: number; jitterFactor?: number },
  ) => Promise<void>;
  /** 更新已有预设方案：按新约束（策略参数 / 模拟资金 / 滑点）重新生成这一份（同策略唯一，不改动基准则不新建） */
  updatePreset: (
    branchId: string,
    params: Record<string, number>,
    options?: { simulatedCash?: number; jitterFactor?: number },
  ) => Promise<void>;
  /** 复制分支为可编辑的用户演练（深拷贝订单，preset 溯源 parentPresetId） */
  copyBranch: (branchId: string) => Promise<void>;
  /** 删除分支（软删 + 订单级联软删） */
  deleteBranch: (branchId: string) => Promise<void>;
  /** 编辑 user 分支订单（草稿：仅更新内存副本 + 标记未保存，不落库） */
  updateUserOrders: (branchId: string, orders: SandboxOrder[]) => void;
  /** 撤销修改：从 DB 重载该分支订单 */
  discardChanges: (branchId: string) => Promise<void>;
  /** ▶ 运行并保存推演：重算 → 落库订单（user 草稿）→ 盖章结果/评估日 → 清除未保存标记 */
  runSimulation: (branchId: string) => Promise<void>;
  /** ⚡ 按最新模拟资金重算预设股数（价格点位不变），并盖章 generatedAtCash */
  rescalePreset: (branchId: string) => Promise<void>;
  /** 🔄 重建基线：重新提取真实持仓批次 + 更新峰值资金 + 重跑 */
  rebuildBaseline: (branchId: string) => Promise<void>;
  /** 强制刷新 K 线（清内存缓存重拉，除权重锚定后重换算基线订单） */
  refreshKline: () => Promise<void>;
  /** 读取分支计算结果（非响应式 getter，对比表在 useMemo 中调用） */
  getComputed: (branchId: string) => BranchComputed | null;
  /** 分支过期检测标记（⚠️ / ⚡ / 🔄） */
  staleFlagsFor: (branchId: string) => StaleFlags;
  /** 退出沙盘页：清空当前标的上下文与响应式状态（memo 保留加速再进入） */
  clearSandboxState: () => void;
}

export interface SandboxStore extends SandboxStoreState, SandboxStoreActions {}

// ============================================================
// 纯工具函数（可单测）
// ============================================================

/** 四舍五入到分 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 生成预设方案时的默认模拟资金：与基线历史资金峰值占用严格 1:1 对齐，
 * 保证「模拟资金」与「预算硬上限」数值完全一致，不叠加、不倍数放大。
 * 预设分支为纯策略独立推演（从 0 股开始），全量预算即归策略自行规划。
 *
 * @param {number} peakCapitalLock - 基线历史最高占用资金
 * @returns {number} 建议的默认模拟资金（= 1 × 峰值，允许清底为 0 时给最低 20000）
 */
export function suggestPresetCash(peakCapitalLock: number): number {
  const base = Math.round(peakCapitalLock * 100) / 100;
  return base > 0 ? base : 20000;
}

/**
 * 把基线订单价格从未复权换算到前复权口径（真实成交价 × 当日复权系数）。
 *
 * @param {SandboxOrder[]} orders - 基线订单（extractBaseline 输出，未复权）
 * @param {AdjustFactorMap} factors - 复权系数表（qfq收盘 / raw收盘）
 * @returns {SandboxOrder[]} 换算后的订单（价格已乘系数，缺系数日期视为 1 不变）
 */
export function adjustBaselineOrdersToQfq(orders: SandboxOrder[], factors: AdjustFactorMap): SandboxOrder[] {
  return orders.map((o) => {
    const factor = getAdjustFactor(o.timestamp.slice(0, 10), factors);
    return { ...o, price: round2(o.price * factor) };
  });
}

/**
 * 合并基线与策略生成订单（预设分支推演输入）。
 *
 * @description 同日订单执行顺序：基线（真实流水）优先于预设（假设操作）——
 *              预设买卖建立在真实历史之上；重排 seqIndex 保证引擎
 *              （按 timestamp + seqIndex 排序）与合并顺序一致。
 * @param {SandboxOrder[]} baseline - 基线订单（前复权）
 * @param {SandboxOrder[]} generated - 策略生成订单
 * @returns {SandboxOrder[]} 合并后的时间线（时间升序，seqIndex 连续）
 */
export function mergeBaselineAndGenerated(baseline: SandboxOrder[], generated: SandboxOrder[]): SandboxOrder[] {
  if (generated.length === 0) return baseline;
  return [...baseline.map((o) => ({ o, pri: 0 })), ...generated.map((o) => ({ o, pri: 1 }))]
    .sort((a, b) => {
      const d = a.o.timestamp.localeCompare(b.o.timestamp);
      return d !== 0 ? d : a.pri - b.pri || a.o.seqIndex - b.o.seqIndex;
    })
    .map(({ o }, i) => ({ ...o, seqIndex: i }));
}

/**
 * 计算 K 线行情起点：以「第一次建仓的 opentime」（首条 type='open' 批次的时间戳）
 * 作为推演起始日（开仓日），不再额外前推 90 天。无批次时返回 undefined（近 10 年缺省）。
 *
 * @param {Position} position - 真实持仓（含批次履历）
 * @returns {string | undefined} YYYY-MM-DD；无批次时返回 undefined（近 10 年缺省）
 */
export function computeKlineStartDate(position: Position): string | undefined {
  if (position.batches.length === 0) return undefined;
  // 以「第一次建仓的 opentime」（首条 type='open' 批次时间戳）作为推演起始日；
  // 若存在意外缺失 open 批次（如历史导入数据），则退回最早任意批次。
  const sorted = [...position.batches].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const firstOpen = sorted.find((b) => b.type === 'open');
  const anchor = firstOpen ?? sorted[0];
  const d = new Date(anchor.timestamp);
  if (Number.isNaN(d.getTime())) return undefined;
  // 按 UTC 日历日返回（与交易日期口径一致，且测试不随本机时区漂移）
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 计算 K 线终点：仓位已完结（平仓）则以「平仓日」作为末根 K 线；仍持仓（未平仓）返回
 * undefined 表示取到最新一根 K 线。与 computeKlineStartDate（首笔建仓日）配合，让沙盘
 * 推演时间线对齐真实持有区间：已平仓就到平仓日，未平仓就到最后交易日。
 *
 * @param {Position} position - 真实持仓
 * @returns {string | undefined} YYYY-MM-DD；未平仓时返回 undefined（最新 K 线）
 */
export function computeKlineEndDate(position: Position): string | undefined {
  if (!position.isClosed || !position.closedAt) return undefined;
  const d = new Date(position.closedAt);
  if (Number.isNaN(d.getTime())) return undefined;
  // 与 computeKlineStartDate 口径一致，按 UTC 日历日返回
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 按月定期定额（monthly DCA）展开为逐笔注入：取 K 线里每个日历月的首个交易日作为入金日。
 * 盘中引擎按日期盘前结算，故本月首交易日入金、盘中即可撮合。
 */
export function buildMonthlyDCA(kline: KlineItem[], amount: number): CashInjection[] {
  if (kline.length === 0 || amount <= 0) return [];
  const byMonth = new Map<string, KlineItem>();
  for (const bar of kline) {
    const key = bar.date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, bar);
  }
  return [...byMonth.values()].map((bar) => ({ date: bar.date, amount: round2(amount) }));
}

/**
 * 分支过期检测（规格书 §8.1）。全部由用户点击触发，系统绝不自动刷新。
 *
 * @param {SandboxBranch} branch - 目标分支
 * @param {string} currentBaselineSignature - 当前基线指纹（extractBaseline(position).signature）
 * @param {string} klineLastDate - 当前 K 线末根日期（YYYY-MM-DD，空串表示无 K 线）
 * @returns {StaleFlags} 三个过期源的布尔标记
 */
export function checkBranchStale(
  branch: SandboxBranch,
  currentBaselineSignature: string,
  klineLastDate: string,
): StaleFlags {
  return {
    kline: !!klineLastDate && !!branch.dataAsOfDate && branch.dataAsOfDate < klineLastDate,
    cash: branch.branchType === 'preset' && branch.simulatedCash !== branch.generatedAtCash,
    baseline:
      branch.branchType !== 'user' && !!currentBaselineSignature && branch.lastBaselineSignature !== currentBaselineSignature,
  };
}

// ============================================================
// Memo 缓存操作
// ============================================================

/** 写入 memo（LRU：重插保持顺序，超限淘汰最旧） */
function memoSet(key: string, value: BranchComputed): void {
  if (memoCache.has(key)) memoCache.delete(key);
  memoCache.set(key, value);
  while (memoCache.size > MEMO_LIMIT) {
    const oldest = memoCache.keys().next().value;
    if (oldest === undefined) break;
    memoCache.delete(oldest);
  }
}

/** 显式失效某分支的全部 memo 条目（订单编辑/资金/基线重配时调用） */
function memoInvalidate(branchId: string): void {
  const prefix = `${branchId}|`;
  for (const key of memoCache.keys()) {
    if (key.startsWith(prefix)) memoCache.delete(key);
  }
}

/** FNV-1a 32 位哈希（确定性，足够防 memo 键碰撞） */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 基线订单内容指纹缓存：按数组身份记忆，避免每次计算都全量序列化 */
const baselineDigestCache = new WeakMap<SandboxOrder[], string>();

/**
 * 基线订单内容摘要：`批次数|FNV-1a(全量订单 JSON)`。
 *
 * @description baselineSignature（批次数|末笔时间戳|持股数）无法感知中间批次
 *              内容变化（如修正首笔建仓日期），会导致 computeBranchResult 的
 *              memo 键碰撞、返回过期结果；本摘要对订单全量字段做哈希补上该盲区。
 *              branchId 由 store 层注入，不属于基线内容，不参与指纹。
 */
function baselineDigest(orders: SandboxOrder[]): string {
  if (orders.length === 0) return '0';
  const cached = baselineDigestCache.get(orders);
  if (cached) return cached;
  const stable = orders.map(({ branchId: _branchId, ...rest }) => rest);
  const digest = `${orders.length}|${fnv1a(JSON.stringify(stable))}`;
  baselineDigestCache.set(orders, digest);
  return digest;
}

// ============================================================
// 分支结果计算（纯函数 + memo，规格书 §6.3）
// ============================================================

/**
 * 计算分支推演结果（memo 缓存，命中 0ms）。
 *
 * @description 按分支类型派生订单后跑引擎：
 *  - baseline：基线订单（jitter 强制 0，锚定真实成交）；
 *  - preset：基线 + 策略生成合并（数量基准 = generatedAtCash，预算 = simulatedCash，
 *    体现"资金变动只弹 ⚡ 提示、点击后才重算股数"的语义）；
 *  - user：savedOrders 完整时间线（含 isBaseline 拷贝，用户可自由改）。
 * @param {SandboxBranch} branch - 目标分支
 * @param {BranchComputeContext} ctx - 计算上下文（K线/系数/基线/费率等）
 * @returns {BranchComputed | null} K 线为空时返回 null
 */
export function computeBranchResult(branch: SandboxBranch, ctx: BranchComputeContext): BranchComputed | null {
  const { kline, factors, baselineOrders, baselineSignature, position, feeConfig, securityKind } = ctx;
  if (kline.length === 0) return null;
  const last = kline[kline.length - 1];

  // 缓存键：分支身份 + 资金（预算/生成） + 抖动 + 策略参数 + 基线指纹 + K线版本（弱信号）
  const key = [
    branch.id,
    branch.simulatedCash,
    branch.generatedAtCash,
    branch.jitterFactor,
    branch.jitterWindowSize,
    JSON.stringify(branch.presetParams ?? {}),
    JSON.stringify(branch.cashInjections ?? []),
    `${baselineSignature}#${baselineDigest(baselineOrders)}`,
    JSON.stringify(feeConfig),
    kline.length,
    last.date,
    last.close,
  ].join('|');
  const hit = memoCache.get(key);
  if (hit) return hit;

  // ---- 派生订单 ----
  let orders: SandboxOrder[];
  // 预设策略零成交时的策略自身原因（仅在空时间线处展示）
  let inactivityReason: string | undefined;
  // 策略自身生成的订单数（baseline/user 分支为 0）
  let generatedOrdersCount = 0;
  // 是否为策略可用预算 ≤ 0（baseline 预留后无剩余资金开仓）
  let strategyBudgetExhausted = false;
  if (branch.branchType === 'baseline') {
    orders = baselineOrders.map((o) => ({ ...o, branchId: branch.id }));
  } else if (branch.branchType === 'preset' && branch.presetStrategyId) {
    // 纯策略独立推演：不合并基线订单，也不预留基线资金占用；
    // 从 0 股开始，策略自动全额模拟。生成量基准用 generatedAtCash（全额、未被基线占用），
    // 保留「调资金→⚡→rescalePreset 才重算股数」的枣后延迟重算语义变量。
    strategyBudgetExhausted = branch.generatedAtCash <= 0;
    const strategyCtx: StrategyContext = {
      klineData: kline,
      baselineOrders: [],
      peakCapitalLock: 0,
      simulatedCash: Math.max(0, branch.generatedAtCash), // 全额生成资金，未被基线峰值占用预扣
      currentPrice: last.close,
      currentCost: 0, // 独立推演：无初始底仓成本
      currentQuantity: 0, // 独立推演：从 0 股开始
      strategyStartDate: position?.openAt ? position.openAt.slice(0, 10) : undefined,
      cashInjections: branch.cashInjections,
      feeConfig,
      securityKind,
    };
    const generated = generateStrategyOrders(branch.presetStrategyId, strategyCtx, branch.presetParams).map((o) => ({
      ...o,
      branchId: branch.id,
    }));
    generatedOrdersCount = generated.length;
    orders = generated;
    // 预设策略自身零成交原因：策略门槛（而非引擎/资金拒绝）
    if (orders.length === 0) {
      const gen = STRATEGY_GENERATORS[branch.presetStrategyId];
      inactivityReason = gen?.inactivityReason?.(strategyCtx) ?? undefined;
    }
  } else {
    orders = savedOrdersCache.get(branch.id) ?? [];
  }

  // ---- 跑引擎 ----
  const engineOpts: EngineOptions = {
    simulatedCash: branch.simulatedCash, // 推演预算（基线永远 = 峰值；预设可在峰值上浮，UI 标注"模拟"）
    feeConfig,
    securityKind,
    jitterFactor: branch.branchType === 'baseline' ? 0 : branch.jitterFactor, // 基线不做滑点
    jitterWindowSize: branch.jitterWindowSize,
    seedPrefix: branch.id,
    asOfDate: last.date, // 全分支共享同一评估日（末根 K 线日期）
    cashInjections: branch.cashInjections, // DCA：盘前结算入金再撮合
  };
  const run = runSandboxEngine(orders, kline, engineOpts);

  const warnings = [...run.warnings];
  let result: SandboxResult | null = null;
  if (run.ok && run.result) {
    result = enrichResult(run.result, orders, kline);
  }

  // 基线自校验（规格书 §3.2）：引擎末端持仓须等于账本当前持股。
  // 分为两种形态：
  // ① result 存在 → 用引擎末端持仓比对（批次缺失/含意外卖出等数据问题）；
  // ② result 为空（任一订单被拒，如建仓日早于 K 线起点）→ 用拒绝数给出
  //    「基线重演不完整」警告，避免用户关掉弹窗后对「为何少一笔」毫无线索。
  if (branch.branchType === 'baseline' && position) {
    if (result && result.finalPosition !== position.currentAmount) {
      warnings.push(
        `基线校验异常：推演末端持股 ${result.finalPosition} 股 ≠ 账本当前持股 ${position.currentAmount} 股。` +
          '常见原因：批次履历不完整（做T划转/归并批次可能随战报删除被剥离）、' +
          '或 K 线未覆盖早前建仓日。请在时间线核对操作点，或点击 🔄 重建基线。',
      );
    } else if (!result && run.rejections.length > 0) {
      warnings.push(
        `基线重演不完整：${run.rejections.length} 笔真实操作被引擎拒绝（详见弹窗提示），未计入推演结果。` +
          '常见原因：操作日期早于 K 线起点或超出评估日。可在时间线核对被拒操作，或点击 🔄 重建基线。',
      );
    }
  }

  const computed: BranchComputed = {
    orders,
    result,
    rejections: run.rejections,
    warnings,
    peakRequiredCash: run.peakRequiredCash,
    asOfDate: last.date,
    dataAsOfDate: last.date,
    inactivityReason,
    generatedOrdersCount,
    strategyBudgetExhausted,
  };
  memoSet(key, computed);
  return computed;
}

// ============================================================
// Store 内部辅助
// ============================================================

/** 组装当前标的的计算上下文（读取模块缓存 + 全局费率） */
function buildComputeContext(): BranchComputeContext {
  const { kline, adjustFactors } = useSandboxStore.getState();
  const app = useAppStore.getState();
  return {
    kline,
    factors: adjustFactors,
    baselineOrders: currentBaselineOrders,
    baselineSignature: currentBaselineSignature,
    position: positionCache,
    feeConfig: app.feeConfig,
    securityKind: matchSecurityKind('', (currentFullCode || '').replace(/^sh|sz|bj/, '')),
  };
}

/** 每个标的下真实操作基线（baseline）的固定唯一 ID：同一标的永远只有一份 */
function baselineIdFor(fullCode: string): string {
  return `baseline-${fullCode}`;
}

/** 确保基线分支存在（不存在则创建并落库） */
function ensureBaselineBranch(position: Position, kline: KlineItem[]): SandboxBranch | null {
  if (!position) return null;
  const existing = useSandboxStore.getState().branches.find(
    (b) => b.branchType === 'baseline' && (b.id === baselineIdFor(b.fullCode) || b.fullCode === position.fullCode),
  );
  if (existing) return existing;

  const extraction = extractBaseline(position);
  const lastDate = kline.length > 0 ? kline[kline.length - 1].date : '';
  const now = Date.now();
  const branch: SandboxBranch = {
    id: baselineIdFor(position.fullCode),
    fullCode: position.fullCode,
    stockName: position.stockName,
    branchType: 'baseline',
    branchName: `${position.stockName} · 真实操作基线`,
    status: 'draft',
    baselinePositionId: position.id,
    peakCapitalLock: extraction.peakCapitalLock,
    simulatedCash: extraction.peakCapitalLock, // 基线永远用历史峰值，不可调
    dataAsOfDate: lastDate,
    lastRunAt: 0,
    generatedAtCash: extraction.peakCapitalLock,
    lastBaselineSignature: extraction.signature,
    jitterFactor: 0, // 基线为真实成交锚点，不做滑点模拟
    jitterWindowSize: 5,
    createdAt: now,
    updatedAt: now,
    isDeleted: 0,
  };
  safePersist(() => putSandboxBranch(branch));
  useSandboxStore.setState((s) => ({ branches: [...s.branches, branch] }));
  return branch;
}

/** 加载分支基线去重：同标的 fullCode 只保留一份 baseline，多余的历史重复基线软删除 */
async function dedupeBaselineBranches(branches: SandboxBranch[]): Promise<SandboxBranch[]> {
  const seen = new Set<string>();
  const result: SandboxBranch[] = [];
  const dup: SandboxBranch[] = [];
  // 规范 id 的基线优先保留
  const sorted = [...branches].sort((a, b) => {
    const pa = a.branchType === 'baseline' && a.id === baselineIdFor(a.fullCode) ? 0 : 1;
    const pb = b.branchType === 'baseline' && b.id === baselineIdFor(b.fullCode) ? 0 : 1;
    return pa - pb;
  });
  for (const b of sorted) {
    if (b.branchType === 'baseline') {
      if (seen.has(b.fullCode)) dup.push(b);
      else {
        seen.add(b.fullCode);
        result.push(b);
      }
    } else result.push(b);
  }
  if (dup.length > 0) await Promise.allSettled(dup.map((d) => deleteSandboxBranch(d.id)));
  return result;
}

// ============================================================
// Store 实例
// ============================================================

export const useSandboxStore = create<SandboxStore>()((set, get) => ({
  branches: [],
  selectedBranchId: null,
  comparedBranchIds: [],
  activeComputed: null,
  dirtyBranchIds: [],
  kline: [],
  adjustFactors: {},
  klineFullCode: null,
  klineLoading: false,
  klineError: null,

  loadBranches: async (fullCode) => {
    const raw = await loadSandboxBranchesFromDB(fullCode);
    const branches = await dedupeBaselineBranches(raw);
    // 预载 user 分支订单到内存（对比/编辑零等待）
    await Promise.all(
      branches
        .filter((b) => b.branchType === 'user' && !savedOrdersCache.has(b.id))
        .map(async (b) => {
          savedOrdersCache.set(b.id, await loadSandboxOrdersByBranchId(b.id));
        }),
    );
    set({ branches });
  },

  selectStock: async (fullCode) => {
    const token = ++loadToken;
    const app = useAppStore.getState();
    let position = app.positions.find((p) => p.fullCode === fullCode) ?? null;
    if (!position) {
      const closed = await fetchAllClosedPositions();
      position = closed.find((p) => p.fullCode === fullCode) ?? null;
    }
    if (token !== loadToken) return; // 已切换标的，丢弃过期结果
    positionCache = position;
    currentFullCode = fullCode;
    currentBaselineOrders = [];
    currentBaselineSignature = '';
    set({ klineLoading: true, klineError: null, klineFullCode: fullCode, comparedBranchIds: [] });

    try {
      const [bundle, dbBranches] = await Promise.all([
        getKline(fullCode, { startDate: position ? computeKlineStartDate(position) : undefined }),
        loadSandboxBranchesFromDB(fullCode),
      ]);
      if (token !== loadToken) return;

      // 已平仓仓位：K 线终点取「平仓日」；未平仓则到最新交易日（起点为首笔建仓日，见 startDate）
      const klineEnd = position ? computeKlineEndDate(position) : undefined;
      const klines = klineEnd ? bundle.klines.filter((k) => k.date <= klineEnd) : bundle.klines;

      // 基线订单换算到前复权口径（真实成交价 × 当日复权系数）
      if (position) {
        const extraction = extractBaseline(position);
        currentBaselineOrders = adjustBaselineOrdersToQfq(extraction.orders, bundle.adjustFactors);
        currentBaselineSignature = extraction.signature;
      }
      // 预载 user 分支订单
      await Promise.all(
        dbBranches
          .filter((b) => b.branchType === 'user' && !savedOrdersCache.has(b.id))
          .map(async (b) => {
            savedOrdersCache.set(b.id, await loadSandboxOrdersByBranchId(b.id));
          }),
      );
      const dedupedBranches = await dedupeBaselineBranches(dbBranches);
      set({ branches: dedupedBranches, kline: klines, adjustFactors: bundle.adjustFactors, klineLoading: false });

      // 确保基线分支存在并选中
      const baseline = position ? ensureBaselineBranch(position, klines) : null;
      const targetId = baseline?.id ?? dbBranches[0]?.id ?? null;
      if (targetId) get().selectBranch(targetId);
      if (!position) {
        set({ klineError: '未找到该标的的持仓记录，无法建立基线。' });
      }
    } catch (err) {
      if (token !== loadToken) return;
      set({ klineLoading: false, klineError: err instanceof Error ? err.message : 'K 线加载失败，请检查网络后重试。' });
    }
    // 【风控审计】记录沙盘选股操作
    recordAudit('sandbox_select_stock', 'sandbox', fullCode, 'success', {
      tags: { fullCode },
    });
  },

  selectBranch: (branchId) => {
    const branch = get().branches.find((b) => b.id === branchId);
    if (!branch) return;
    const computed = computeBranchResult(branch, buildComputeContext());
    set({ selectedBranchId: branchId, activeComputed: computed });
  },

  toggleCompare: (branchId) => {
    const { comparedBranchIds } = get();
    set({
      comparedBranchIds: comparedBranchIds.includes(branchId)
        ? comparedBranchIds.filter((id) => id !== branchId)
        : [...comparedBranchIds, branchId],
    });
  },

  setSimulatedCash: (branchId, cash) => {
    const branch = get().branches.find((b) => b.id === branchId);
    // 基线永远锁定历史峰值（不可调）；预设调高后显示 ⚡ 待重算；user 直接生效
    if (!branch || branch.branchType === 'baseline') return;
    const value = round2(Math.max(0, cash));
    if (value === branch.simulatedCash) return;
    memoInvalidate(branchId);
    const updated: SandboxBranch = { ...branch, simulatedCash: value, updatedAt: Date.now() };
    const computed = computeBranchResult(updated, buildComputeContext());
    safePersist(() => putSandboxBranch(updated));
    set({
      branches: get().branches.map((b) => (b.id === branchId ? updated : b)),
      activeComputed: get().selectedBranchId === branchId ? computed : get().activeComputed,
    });
  },

  raiseCashToRequired: (branchId, requiredCash) => {
    const branch = get().branches.find((b) => b.id === branchId);
    if (!branch || branch.branchType === 'baseline' || requiredCash <= 0) return;
    // 向上取整到千位；且不低于当前模拟资金（缺口的封闭解法：一次调够）
    const target = Math.ceil(Math.max(requiredCash, branch.simulatedCash) / 1000) * 1000;
    if (target === branch.simulatedCash) return;
    get().setSimulatedCash(branchId, target);
  },

  adjustOrderQty: (branchId, orderId, newQty) => {
    const branch = get().branches.find((b) => b.id === branchId && b.branchType === 'user');
    if (!branch) return;
    const orders = savedOrdersCache.get(branchId) ?? [];
    const next = orders.map((o) =>
      o.id === orderId ? { ...o, quantity: Math.max(0, Math.floor(newQty / 100) * 100) } : o,
    );
    get().updateUserOrders(branchId, next);
  },

  scaleAllBuyOrders: (branchId, scaleFactor) => {
    const branch = get().branches.find((b) => b.id === branchId && b.branchType === 'user');
    if (!branch || !Number.isFinite(scaleFactor) || scaleFactor <= 0) return;
    const orders = savedOrdersCache.get(branchId) ?? [];
    const next = orders.map((o) =>
      o.action === 'buy' ? { ...o, quantity: Math.max(0, Math.round((o.quantity * scaleFactor) / 100) * 100) } : o,
    );
    get().updateUserOrders(branchId, next);
  },

  addCashInjection: (branchId, date, amount) => {
    const branch = get().branches.find((b) => b.id === branchId);
    if (!branch || branch.branchType === 'baseline' || !date || amount <= 0) return;
    const base = branch.cashInjections ?? [];
    if (base.some((c) => c.date === date)) return;
    const normalized = [...base, { date, amount: round2(amount) }].sort((a, b) => a.date.localeCompare(b.date));
    const updated = { ...branch, injectionType: 'custom' as const, cashInjections: normalized, updatedAt: Date.now() };
    memoInvalidate(branchId);
    const computed = computeBranchResult(updated, buildComputeContext());
    safePersist(() => putSandboxBranch(updated));
    set({ branches: get().branches.map((b) => (b.id === branchId ? updated : b)), activeComputed: get().selectedBranchId === branchId ? computed : get().activeComputed });
  },

  setMonthlyDCA: (branchId, amount) => {
    const branch = get().branches.find((b) => b.id === branchId);
    if (!branch || branch.branchType === 'baseline' || amount <= 0) return;
    const injections = buildMonthlyDCA(get().kline, amount);
    const updated = { ...branch, injectionType: 'monthly' as const, cashInjections: injections, updatedAt: Date.now() };
    memoInvalidate(branchId);
    const computed = computeBranchResult(updated, buildComputeContext());
    safePersist(() => putSandboxBranch(updated));
    set({ branches: get().branches.map((b) => (b.id === branchId ? updated : b)), activeComputed: get().selectedBranchId === branchId ? computed : get().activeComputed });
  },

  clearCashInjections: (branchId) => {
    const branch = get().branches.find((b) => b.id === branchId);
    if (!branch || branch.branchType === 'baseline') return;
    const updated = { ...branch, injectionType: 'none' as const, cashInjections: undefined, totalInjectedCash: undefined, updatedAt: Date.now() };
    memoInvalidate(branchId);
    const computed = computeBranchResult(updated, buildComputeContext());
    safePersist(() => putSandboxBranch(updated));
    set({ branches: get().branches.map((b) => (b.id === branchId ? updated : b)), activeComputed: get().selectedBranchId === branchId ? computed : get().activeComputed });
  },

  generatePreset: async (strategyId, params, options = {}) => {
    const { kline, branches } = get();
    const baseline = branches.find((b) => b.branchType === 'baseline');
    if (!baseline || kline.length === 0) return;
    // 同策略唯一性校验：每种预设策略只能有一份（不可重复生成）
    const exists = branches.some((b) => b.branchType === 'preset' && b.presetStrategyId === strategyId);
    if (exists) return;
    const generator = STRATEGY_GENERATORS[strategyId];
    if (!generator) return;
    const cash = round2(options.simulatedCash ?? suggestPresetCash(baseline.peakCapitalLock));
    const now = Date.now();
    const branch: SandboxBranch = {
      id: generateId(),
      fullCode: baseline.fullCode,
      stockName: baseline.stockName,
      branchType: 'preset',
      branchName: `${generator.name}方案`,
      status: 'draft',
      baselinePositionId: baseline.baselinePositionId,
      peakCapitalLock: baseline.peakCapitalLock,
      simulatedCash: cash,
      dataAsOfDate: kline[kline.length - 1].date,
      lastRunAt: now,
      generatedAtCash: cash,
      lastBaselineSignature: currentBaselineSignature,
      presetStrategyId: strategyId,
      presetParams: params,
      jitterFactor: options.jitterFactor ?? 0.25,
      jitterWindowSize: 5,
      createdAt: now,
      updatedAt: now,
      isDeleted: 0,
    };
    const computed = computeBranchResult(branch, buildComputeContext());
    if (computed?.result) {
      branch.status = 'completed';
      branch.resultJson = JSON.stringify(computed.result);
    }
    await safePersist(() => putSandboxBranch(branch));
    set({ branches: [...get().branches, branch], selectedBranchId: branch.id, activeComputed: computed });
    // 【风控审计】记录预设生成
    recordAudit('sandbox_generate_preset', 'sandbox', branch.id, 'success', {
      tags: { fullCode: branch.fullCode, strategyId, branchName: branch.branchName },
    });
  },

  updatePreset: async (branchId, params, options = {}) => {
    const { kline, branches } = get();
    const branch = branches.find((b) => b.id === branchId && b.branchType === 'preset');
    if (!branch || !branch.presetStrategyId || kline.length === 0) return;
    const generator = STRATEGY_GENERATORS[branch.presetStrategyId];
    if (!generator) return;
    const cash = round2(options.simulatedCash ?? branch.simulatedCash);
    const now = Date.now();
    const updated: SandboxBranch = {
      ...branch,
      presetParams: params,
      simulatedCash: cash,
      generatedAtCash: cash,
      jitterFactor: options.jitterFactor ?? branch.jitterFactor,
      dataAsOfDate: kline[kline.length - 1].date,
      lastRunAt: now,
      updatedAt: now,
    };
    const computed = computeBranchResult(updated, buildComputeContext());
    if (computed?.result) {
      updated.status = 'completed';
      updated.resultJson = JSON.stringify(computed.result);
    }
    await safePersist(() => putSandboxBranch(updated));
    set({
      branches: branches.map((b) => (b.id === branchId ? updated : b)),
      selectedBranchId: updated.id,
      activeComputed: computed,
    });
  },

  copyBranch: async (branchId) => {
    const branch = get().branches.find((b) => b.id === branchId);
    if (!branch) return;
    const computed = computeBranchResult(branch, buildComputeContext());
    const srcOrders =
      computed?.orders ??
      (branch.branchType === 'user' ? (savedOrdersCache.get(branch.id) ?? []) : []);
    const now = Date.now();
    const newBranch: SandboxBranch = {
      id: generateId(),
      fullCode: branch.fullCode,
      stockName: branch.stockName,
      branchType: 'user',
      branchName: `${branch.branchName} · 我的演练`,
      status: 'draft',
      baselinePositionId: branch.baselinePositionId,
      peakCapitalLock: branch.peakCapitalLock,
      simulatedCash: branch.simulatedCash,
      injectionType: branch.injectionType,
      cashInjections: branch.cashInjections ? [...branch.cashInjections] : undefined,
      totalInjectedCash: branch.totalInjectedCash,
      dataAsOfDate: branch.dataAsOfDate,
      lastRunAt: 0,
      generatedAtCash: branch.simulatedCash,
      lastBaselineSignature: currentBaselineSignature,
      parentPresetId: branch.branchType === 'preset' ? branch.id : undefined,
      jitterFactor: branch.jitterFactor,
      jitterWindowSize: branch.jitterWindowSize,
      createdAt: now,
      updatedAt: now,
      isDeleted: 0,
    };
    // 深拷贝订单为独立完整时间线（含 isBaseline 标记的真实历史拷贝，可自由增删改）
    const orders = srcOrders.map((o, i) => ({
      ...o,
      id: generateId(),
      branchId: newBranch.id,
      seqIndex: i,
    }));
    savedOrdersCache.set(newBranch.id, orders);
    await Promise.all([
      safePersist(() => putSandboxBranch(newBranch)),
      safePersist(() => bulkPutSandboxOrders(newBranch.id, orders)),
    ]);
    const computedNew = computeBranchResult(newBranch, buildComputeContext());
    set({ branches: [...get().branches, newBranch], selectedBranchId: newBranch.id, activeComputed: computedNew });
  },

  deleteBranch: async (branchId) => {
    const branch = get().branches.find((b) => b.id === branchId);
    await deleteSandboxBranch(branchId); // 软删 + 订单级联软删
    savedOrdersCache.delete(branchId);
    memoInvalidate(branchId);
    const { selectedBranchId, comparedBranchIds } = get();
    set({
      branches: get().branches.filter((b) => b.id !== branchId),
      selectedBranchId: selectedBranchId === branchId ? null : selectedBranchId,
      comparedBranchIds: comparedBranchIds.filter((id) => id !== branchId),
      activeComputed: selectedBranchId === branchId ? null : get().activeComputed,
      dirtyBranchIds: get().dirtyBranchIds.filter((id) => id !== branchId),
    });
    // 【风控审计】记录沙盘分支删除
    recordAudit('sandbox_delete_branch', 'sandbox', branchId, 'success', {
      tags: { branchName: branch?.branchName ?? '', branchType: branch?.branchType ?? '' },
    });
  },

  updateUserOrders: (branchId, orders) => {
    const branch = get().branches.find((b) => b.id === branchId);
    if (!branch || branch.branchType !== 'user') return;
    const normalized = [...orders]
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .map((o, i) => ({ ...o, branchId, seqIndex: i }));
    savedOrdersCache.set(branchId, normalized);
    memoInvalidate(branchId);
    const computed = computeBranchResult(branch, buildComputeContext());
    set({
      branches: get().branches.map((b) => (b.id === branchId ? { ...b, updatedAt: Date.now() } : b)),
      activeComputed: get().selectedBranchId === branchId ? computed : get().activeComputed,
      dirtyBranchIds: get().dirtyBranchIds.includes(branchId)
        ? get().dirtyBranchIds
        : [...get().dirtyBranchIds, branchId],
    });
    // 【风控审计】记录用户方案订单编辑
    recordAudit('sandbox_update_orders', 'sandbox', branchId, 'success', {
      tags: { branchName: branch.branchName },
      after: { orderCount: normalized.length },
    });
  },

  discardChanges: async (branchId) => {
    const orders = await loadSandboxOrdersByBranchId(branchId);
    savedOrdersCache.set(branchId, orders);
    memoInvalidate(branchId);
    const branch = get().branches.find((b) => b.id === branchId);
    const computed = branch ? computeBranchResult(branch, buildComputeContext()) : null;
    set({
      branches: get().branches.map((b) => (b.id === branchId ? { ...b, updatedAt: Date.now() } : b)),
      activeComputed: get().selectedBranchId === branchId ? computed : get().activeComputed,
      dirtyBranchIds: get().dirtyBranchIds.filter((id) => id !== branchId),
    });
  },

  runSimulation: async (branchId) => {
    const branch = get().branches.find((b) => b.id === branchId);
    if (!branch) return;
    memoInvalidate(branchId);
    const computed = computeBranchResult(branch, buildComputeContext());
    const klineLastDate = get().kline[get().kline.length - 1]?.date ?? branch.dataAsOfDate;
    const updated: SandboxBranch = {
      ...branch,
      status: computed?.result ? 'completed' : 'draft',
      resultJson: computed?.result ? JSON.stringify(computed.result) : branch.resultJson,
      dataAsOfDate: klineLastDate,
      lastRunAt: Date.now(),
      updatedAt: Date.now(),
    };
    const ops: Promise<void>[] = [safePersist(() => putSandboxBranch(updated))];
    if (branch.branchType === 'user') {
      // 落库草稿订单（幂等：先软删旧单再插入）
      ops.push(safePersist(() => bulkPutSandboxOrders(branchId, savedOrdersCache.get(branchId) ?? [])));
    }
    await Promise.all(ops);
    set({
      branches: get().branches.map((b) => (b.id === branchId ? updated : b)),
      activeComputed: get().selectedBranchId === branchId ? computed : get().activeComputed,
      dirtyBranchIds: get().dirtyBranchIds.filter((id) => id !== branchId),
    });
    // 【风控审计】记录模拟运行
    recordAudit('sandbox_run_simulation', 'sandbox', branchId, 'success', {
      tags: { fullCode: branch.fullCode, branchType: branch.branchType, branchName: branch.branchName },
      after: { status: updated.status, ordersCount: computed?.result?.snapshots?.length ?? 0 },
    });
  },

  rescalePreset: async (branchId) => {
    const branch = get().branches.find((b) => b.id === branchId && b.branchType === 'preset');
    if (!branch || branch.simulatedCash === branch.generatedAtCash) return;
    // 按最新模拟资金盖章生成资金 → 重算股数（价格点位不变）→ 运行保存
    set({
      branches: get().branches.map((b) =>
        b.id === branchId ? { ...b, generatedAtCash: b.simulatedCash, updatedAt: Date.now() } : b,
      ),
    });
    await get().runSimulation(branchId);
  },

  rebuildBaseline: async (branchId) => {
    const branch = get().branches.find((b) => b.id === branchId);
    const position = positionCache;
    if (!branch || !position) return;
    const extraction = extractBaseline(position);
    currentBaselineOrders = adjustBaselineOrdersToQfq(extraction.orders, get().adjustFactors);
    currentBaselineSignature = extraction.signature;
    const isBaseline = branch.branchType === 'baseline';
    const updated: SandboxBranch = {
      ...branch,
      peakCapitalLock: isBaseline ? extraction.peakCapitalLock : branch.peakCapitalLock,
      simulatedCash: isBaseline ? extraction.peakCapitalLock : branch.simulatedCash,
      generatedAtCash: isBaseline ? extraction.peakCapitalLock : branch.generatedAtCash,
      lastBaselineSignature: extraction.signature,
      updatedAt: Date.now(),
    };
    memoInvalidate(branchId);
    set({
      branches: get().branches.map((b) => (b.id === branchId ? updated : b)),
      activeComputed: get().selectedBranchId === branchId ? computeBranchResult(updated, buildComputeContext()) : get().activeComputed,
    });
    await get().runSimulation(branchId);
  },

  refreshKline: async () => {
    const fullCode = get().klineFullCode;
    if (!fullCode) return;
    const token = ++loadToken;
    set({ klineLoading: true, klineError: null });
    try {
      clearMemoryCache();
      const bundle = await getKline(fullCode, {
        startDate: positionCache ? computeKlineStartDate(positionCache) : undefined,
      });
      if (token !== loadToken) return;
      // 除权重锚定可能改变系数表 → 重新换算基线订单
      if (positionCache) {
        const extraction = extractBaseline(positionCache);
        currentBaselineOrders = adjustBaselineOrdersToQfq(extraction.orders, bundle.adjustFactors);
        currentBaselineSignature = extraction.signature;
      }
      // 已平仓仓位：K 线终点取「平仓日」；未平仓则到最新交易日（与 selectStock 口径一致）
      const klineEnd = positionCache ? computeKlineEndDate(positionCache) : undefined;
      const klines = klineEnd ? bundle.klines.filter((k) => k.date <= klineEnd) : bundle.klines;
      // 全部分支 memo 因 K 线版本变化自动失效（key 含末根日期+收盘）
      set({ kline: klines, adjustFactors: bundle.adjustFactors, klineLoading: false });
      const selected = get().branches.find((b) => b.id === get().selectedBranchId);
      if (selected) {
        set({ activeComputed: computeBranchResult(selected, buildComputeContext()) });
      }
    } catch (err) {
      if (token !== loadToken) return;
      set({ klineLoading: false, klineError: err instanceof Error ? err.message : 'K 线刷新失败，请检查网络后重试。' });
    }
  },

  getComputed: (branchId) => {
    const branch = get().branches.find((b) => b.id === branchId);
    if (!branch) return null;
    return computeBranchResult(branch, buildComputeContext());
  },

  staleFlagsFor: (branchId) => {
    const branch = get().branches.find((b) => b.id === branchId);
    if (!branch) return { kline: false, cash: false, baseline: false };
    const last = get().kline[get().kline.length - 1];
    return checkBranchStale(branch, currentBaselineSignature, last?.date ?? '');
  },

  clearSandboxState: () => {
    savedOrdersCache.clear();
    positionCache = null;
    currentFullCode = '';
    currentBaselineOrders = [];
    currentBaselineSignature = '';
    loadToken += 1; // 使在途 selectStock/refreshKline 失效
    set({
      branches: [],
      selectedBranchId: null,
      comparedBranchIds: [],
      activeComputed: null,
      dirtyBranchIds: [],
      kline: [],
      adjustFactors: {},
      klineFullCode: null,
      klineLoading: false,
      klineError: null,
    });
  },
}));
