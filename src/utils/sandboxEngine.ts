/**
 * @file sandboxEngine.ts
 * @description 沙盘推演引擎（纯函数，可单测）：以历史真实资金峰值为硬预算，
 *              按时间顺序重演用户/基线/预设的买卖订单，内嵌 A 股真实交易约束：
 *              - 资金约束（可用现金 + 规费，禁止透支/加杠杆）
 *              - T+1 锁定（当日买入不可当日卖出；kind='borrow' 倒T出借属于昨日底仓豁免）
 *              - 统一评估日市价清算（已实现 / 未实现盈亏显式拆分）
 *              - 动态价格抖动（基于周围 K 线真实波动率的确定性随机滑点）
 *              - 规费全对齐（复用 calcTradeFees，含净佣金/最低保底/经手费/证管费/过户费/印花税）
 *              - 结构化拒绝（EngineRejection：白话原因 + 可执行行动选项，替代干瘪报错）
 *
 * 引擎为纯函数：输入订单 + K 线 + 配置 → 输出结果或拒绝，无任何存储副作用。
 * 同一种子（seedPrefix + orderId）下抖动结果可复现。
 * @layer Logic
 * @storage_impact 纯函数，不读写任何存储。
 * @author 开发团队
 */

import Decimal from 'decimal.js';
import { calcTradeFees, type FeeConfig, type SecurityKind } from './mathUtils';
import type { CashInjection, KlineItem, SandboxOrder, SandboxResult, SandboxSnapshot } from '../types/sandbox';

// ============================================================
// 类型定义
// ============================================================

/** 引擎配置 */
export interface EngineOptions {
  /** 模拟资金（元），默认 = 历史最高占用资金；推演总预算 */
  simulatedCash: number;
  /** 全局费率配置（复用费率配置页） */
  feeConfig: FeeConfig;
  /** 证券类型（股票/ETF/债券），走对应费率 */
  securityKind: SecurityKind;
  /** 抖动系数（默认 0.25：基准波动率 × 系数 = 抖动范围） */
  jitterFactor?: number;
  /** 抖动窗口（默认 5：取目标日期前后各 N 根 K 线统计波动率） */
  jitterWindowSize?: number;
  /** 随机种子前缀（通常传分支 id，保证不同分支不同抖动、同分支可复现） */
  seedPrefix?: string;
  /** 统一评估日（YYYY-MM-DD）。缺省取最后一根 K 线日期（所有方案共享同一评估日由 store 层传入） */
  asOfDate?: string;
  /** 盘中时序现金注入（DCA）：逐笔 {date, amount}，盘前先结算再撮合当日订单。
   *  注入资金既参与撮合可用现金，也计入累计本金（totalInjectedCash）。 */
  cashInjections?: CashInjection[];
}

/** 结构化拒绝（§4.1.1：白话原因 + 可执行行动选项） */
export interface EngineRejection {
  code: 'INSUFFICIENT_CASH' | 'INSUFFICIENT_POSITION' | 'T1_LOCK' | 'BEYOND_ASOF';
  /** 被拒绝订单 id */
  orderId: string;
  /** 白话原因（直接展示给用户） */
  message: string;
  /** 可执行的补救选项（UI 渲染为按钮，点击直接执行） */
  actions: Array<{
    label: string;
    kind: 'reduce-qty' | 'insert-sell' | 'insert-buy' | 'raise-cash' | 'move-date' | 'cancel';
    payload?: Record<string, number>;
  }>;
}

/** 引擎运行结果：成功返回结果，失败返回全部结构化拒绝 */
export interface EngineRunResult {
  ok: boolean;
  result?: SandboxResult;
  rejections: EngineRejection[];
  /** 非致命提示（如：振幅过大无法成交提示、中途浮盈回吐提示） */
  warnings: string[];
  /** 方案运行所需瞬时最大资金峰值（元）：任意时点累计净投入（买入流水 − 卖出回款）的峰值。
   *  即使存在拒单也照常计算输出，供 UI 提供「一键调高模拟资金至该值」的闭环解法
   *  （预设分支合并基线时，若基线先把预算用尽，生成的追加买单会在此暴露真实缺口）。 */
  peakRequiredCash: number;
}

/** 引擎内部状态 */
interface EngineState {
  cash: number;
  position: number;
  /** 移动加权成本（含买入规费），position=0 时无意义 */
  avgCost: number;
  realizedPnL: number;
  /** 当日累计买入数量（T+1 锁定用，跨日重置） */
  boughtToday: number;
  tradeCount: number;
  totalFees: number;
  totalStampTax: number;
  /** 累计已结注入（DCA）：入金于盘前结算，计入累计本金 */
  cumInjected: number;
  /** 已结算注入的日期集合（防止同一天多次结算同一事件） */
  settledInjectionDays: Set<string>;
}

// ============================================================
// 工具函数
// ============================================================

/** 四舍五入到分 */
function round2(value: number): number {
  return new Decimal(value).toDecimalPlaces(2).toNumber();
}

/** 字符串哈希（FNV-1a），用于派生确定性随机种子 */
function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 确定性 PRNG：同种子产出同一序列 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 中位数 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 定位订单日期对应的 K 线索引：取该日或之前最近一根；早于首根或晚于末根返回 -1（越界） */
function locateBarIndex(kline: KlineItem[], date: string): number {
  if (kline.length === 0) return -1;
  if (date < kline[0].date) return -1;
  if (date > kline[kline.length - 1].date) return -1;
  // 二分查找最后一个 date <= target 的索引
  let lo = 0;
  let hi = kline.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (kline[mid].date <= date) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** 计算期望价在目标日的动态抖动成交价（§4.4：基于周围 K 线波动率） */
function jitterPrice(
  price: number,
  barIndex: number,
  kline: KlineItem[],
  factor: number,
  windowSize: number,
  seed: string,
): { price: number; range: number } {
  if (factor <= 0 || kline.length === 0) return { price, range: 0 };

  // 取目标日期前后各 windowSize 根 K 线
  const start = Math.max(0, barIndex - windowSize);
  const end = Math.min(kline.length - 1, barIndex + windowSize);
  const amps: number[] = [];
  for (let i = start; i <= end; i++) {
    const bar = kline[i];
    if (bar.close > 0) amps.push((bar.high - bar.low) / bar.close);
  }
  const baseVol = median(amps); // 基准波动率 = 振幅中位数
  const range = baseVol * factor; // 抖动范围
  if (range <= 0) return { price, range: 0 };

  const rand = mulberry32(hashString(seed));
  const delta = (rand() * 2 - 1) * range;
  // 将成交价限制在当日 [low, high] 区间内（实盘不可能在区间外成交）
  const bar = kline[barIndex];
  const raw = price * (1 + delta);
  const clamped = Math.min(bar.high, Math.max(bar.low, raw));
  return { price: round2(clamped), range };
}

/** 精确反算「最大可买量」：先扣除预估规费（calcTradeFees 逐笔试算），再向下取整 100 股 */
function calcMaxBuyableQty(
  cash: number,
  price: number,
  feeConfig: FeeConfig,
  securityKind: SecurityKind,
): number {
  if (cash <= 0 || price <= 0) return 0;
  // 从无规费上限开始向下修正（规费只会增加成本，故真实最大可买量 ≤ 该值）
  let qty = Math.floor(cash / price / 100) * 100;
  while (qty > 0) {
    const outlay = price * qty + calcTradeFees(price, qty, 'buy', feeConfig, securityKind).total;
    if (outlay <= cash) break;
    qty -= 100;
  }
  return Math.max(0, qty);
}

/** 自动吞并临界超支（假性超支）：缺口 ≤ max(¥50, 该单成交额 × 0.2%) 视为可自动降容积纳。
 *  只对非基线订单生效（基线是真实历史，必须精确重演），命中时数量自动下调到最大可买量，
 *  并把调整记入 warnings，而不是阻断整个方案 —— 消灭「差几块钱就弹窗」的体感问题。 */
function autoAbsorbThreshold(outlay: number): number {
  return Math.max(50, outlay * 0.002);
}

/** 计算评估日（§4.2：统一评估日 = 最后一根 K 线日期；订单晚于评估日会被 BEYOND_ASOF 拒绝） */
function resolveAsOfDate(asOfDate: string | undefined, kline: KlineItem[]): string {
  if (kline.length === 0) return '';
  if (asOfDate && asOfDate <= kline[kline.length - 1].date) return asOfDate;
  return kline[kline.length - 1].date;
}

// ============================================================
// 引擎主流程
// ============================================================

/**
 * 运行沙盘推演。
 *
 * @param {SandboxOrder[]} orders - 订单时间线（内部按时间升序处理）
 * @param {KlineItem[]} kline - 前复权日 K 线
 * @param {EngineOptions} options - 引擎配置
 * @returns {EngineRunResult} 成功含 result；任一订单被拒则 ok=false 返回全部拒绝与警示
 */
export function runSandboxEngine(
  orders: SandboxOrder[],
  kline: KlineItem[],
  options: EngineOptions,
): EngineRunResult {
  const {
    simulatedCash,
    feeConfig,
    securityKind,
    jitterFactor = 0.25,
    jitterWindowSize = 5,
    seedPrefix = 'sbx',
    asOfDate: asOfDateInput,
    cashInjections,
  } = options;

  const warnings: string[] = [];
  if (kline.length === 0) {
    return {
      ok: false,
      rejections: [{
        code: 'BEYOND_ASOF',
        orderId: '',
        message: '暂无 K 线数据，无法推演。请先加载行情。',
        actions: [{ label: '知道了', kind: 'cancel' }],
      }],
      warnings,
      peakRequiredCash: 0,
    };
  }

  const asOfDate = resolveAsOfDate(asOfDateInput, kline);
  const asOfBarIndex = locateBarIndex(kline, asOfDate);

  // 按 (时间, 序号) 升序处理
  const sorted = [...orders].sort((a, b) => {
    const d = a.timestamp.localeCompare(b.timestamp);
    return d !== 0 ? d : a.seqIndex - b.seqIndex;
  });

  const state: EngineState = {
    cash: simulatedCash,
    position: 0,
    avgCost: 0,
    realizedPnL: 0,
    boughtToday: 0,
    tradeCount: 0,
    totalFees: 0,
    totalStampTax: 0,
    cumInjected: 0,
    settledInjectionDays: new Set(),
  };

  // 注入事件按日期升序；用游标在日循环内一次性结算（O(n)，无死锁）
  const injections = (cashInjections ?? [])
    .filter((inj) => inj.amount > 0 && !!inj.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  let injCursor = 0;
  // 单日累计入金（计算时间加权收益时需按日归集，避免日内多次累加)
  const dailyInjected: Record<string, number> = {};
  /** 结算 ≤ 某日的全部注入：返回当日新增入金额 */
  const settleInjectionsUpTo = (day: string): number => {
    let dayAdded = 0;
    while (injCursor < injections.length && injections[injCursor].date <= day) {
      const amt = injections[injCursor].amount;
      // 同一注入日只生效一次（防止重复结算同一事件）
      if (!state.settledInjectionDays.has(injections[injCursor].date)) {
        state.cash = round2(state.cash + amt);
        state.cumInjected = round2(state.cumInjected + amt);
        state.settledInjectionDays.add(injections[injCursor].date);
        dayAdded = round2(dayAdded + amt);
        dailyInjected[injections[injCursor].date] = round2((dailyInjected[injections[injCursor].date] ?? 0) + amt);
      }
      injCursor += 1;
    }
    return dayAdded;
  };

  const rejections: EngineRejection[] = [];
  const snapshots: SandboxSnapshot[] = [];

  // 瞬时资金峰值：累计净投入（买入流水 − 卖出回款）在任意时点的最大值。
  // 与历史峰值（peakCapitalLock）语义不同——这里是「跑完整套订单实际至少需要多少本金」。
  let netCapitalUsed = 0;
  let peakRequiredCash = 0;

  // ---- 按 K 线逐日推进：先执行该日订单，再打当日快照 ----
  const firstOrderDay = sorted.length > 0 ? sorted[0].timestamp.slice(0, 10) : '';
  const startBar = firstOrderDay ? locateBarIndex(kline, firstOrderDay) : 0;
  const beginBar = startBar >= 0 ? startBar : 0;

  let processed = 0;
  let currentDay = ''; // 最近处理的订单日期（T+1 当日买入计数跨日重置）

  // DCA 盘前预结算：首根处理日之前的注入（早于首个订单日）也须计入本金与可用现金
  if (beginBar < kline.length && beginBar >= 0) {
    settleInjectionsUpTo(kline[beginBar].date);
  }

  for (let bi = beginBar; bi <= asOfBarIndex && bi < kline.length; bi++) {
    const bar = kline[bi];

    // 0. DCA 盘前结算：当日入金先入账，再撮合当日订单（不入金的普通日无副作用）
    settleInjectionsUpTo(bar.date);

    // 1. 执行所有日期 ≤ 当前 K 线日期的订单
    while (processed < sorted.length) {
      const order = sorted[processed];
      const day = order.timestamp.slice(0, 10);
      if (day > bar.date) break;

      // 日期切换 → 重置 T+1 当日买入计数
      if (day !== currentDay) {
        currentDay = day;
        state.boughtToday = 0;
      }

      const barIndex = locateBarIndex(kline, day);
      if (barIndex < 0 || day > asOfDate) {
        rejections.push({
          code: 'BEYOND_ASOF',
          orderId: order.id,
          message: day > asOfDate
            ? `这笔操作日期 ${day} 晚于评估日 ${asOfDate}，无法推演。`
            : `这笔操作日期 ${day} 早于行情起始日，无法定价。`,
          actions: [{
            label: '移到最近交易日',
            kind: 'move-date',
            payload: { targetTimestamp: Date.parse(asOfDate + 'T09:30:00+08:00') },
          }],
        });
        processed += 1;
        continue;
      }

      // 动态抖动成交价（确定性种子 = seedPrefix + orderId）
      // 基线订单（isBaseline）为真实成交锚点，任何分支下都不做滑点：
      // 峰值资金自洽性依赖基线按真实成交价重演（预设分支合并基线时
      // jitter 会把真实买入价上抬 → 误报超出历史峰值资金）。
      const jittered = jitterPrice(
        order.price,
        barIndex,
        kline,
        order.isBaseline ? 0 : jitterFactor,
        jitterWindowSize,
        `${seedPrefix}|${order.id}`,
      );
      const executedPrice = jittered.price;
      // 实际成交数量：买入可能因「临界超支」被自动下调节到最大可买量
      let execQty = order.quantity;
      let feeBreakdown = calcTradeFees(executedPrice, order.quantity, order.action, feeConfig, securityKind);
      let fee = feeBreakdown.total;
      let turnover = executedPrice * order.quantity;

      if (order.action === 'buy') {
        // 现金/成交额统一以分（round2）为精度比较与记账：真实基线峰值资金恰等于
        // 累计流出（最常规场景）时，浮点 epsilon 会把 0 差误判为资金不足（还差 ¥0）。
        let outlay = round2(turnover + fee);
        if (state.cash < outlay) {
          const shortfall = round2(outlay - state.cash);
          const maxQty = calcMaxBuyableQty(state.cash, executedPrice, feeConfig, securityKind);
          // L1 自动消化：非基线 + 缺口很小（≤ max(¥50, 成交额 0.2%)）且至少买得起 1 手 → 自动降档不阻断
          const absorbable =
            !order.isBaseline && shortfall > 0 && shortfall <= autoAbsorbThreshold(outlay);
          if (absorbable && maxQty >= 100) {
            execQty = maxQty;
            // 重算降档后的费用/成交额/占用
            feeBreakdown = calcTradeFees(executedPrice, execQty, order.action, feeConfig, securityKind);
            fee = feeBreakdown.total;
            turnover = executedPrice * execQty;
            outlay = round2(turnover + fee);
            warnings.push(
              `已按预算上限自动降档：原计划 ${order.quantity} 股 → ${execQty} 股（买入 ¥${executedPrice} × ${order.quantity} 股超出可用资金 ¥${shortfall.toFixed(2)}，已在引擎内降至最大可买量）。`,
            );
          } else {
            // 真实超限（缺口过大）或降档后仍 1 手都买不起 → 保留结构化拒绝
            rejections.push({
              code: 'INSUFFICIENT_CASH',
              orderId: order.id,
              message: `这笔买入（${order.quantity} 股 × ¥${executedPrice}）超出当前方案预算上限 ¥${simulatedCash.toLocaleString()}（历史最高占用资金），还差 ¥${shortfall.toLocaleString()}。`,
              actions: [
                ...(maxQty > 0
                  ? [{ label: `减至 ${maxQty} 股（按可用资金反算）`, kind: 'reduce-qty' as const, payload: { maxQty } }]
                  : []),
                { label: '先插入一笔卖出释放现金', kind: 'insert-sell' },
                { label: '去顶部把"模拟资金"调高', kind: 'raise-cash', payload: { shortfall } },
              ],
            });
            processed += 1;
            continue;
          }
        }
        state.cash = round2(state.cash - outlay);
        state.avgCost = state.position > 0
          ? (state.avgCost * state.position + turnover + fee) / (state.position + execQty)
          : (turnover + fee) / execQty;
        state.position += execQty;
        state.boughtToday += execQty;
        netCapitalUsed += outlay;
        peakRequiredCash = Math.max(peakRequiredCash, netCapitalUsed);
      } else {
        // sell
        // T+1：可卖 = 总持仓 − 当日买入；倒T出借（borrow）卖出的是昨日底仓，豁免
        const sellable = order.kind === 'borrow' ? state.position : state.position - state.boughtToday;
        if (order.quantity > sellable) {
          if (order.quantity > state.position) {
            rejections.push({
              code: 'INSUFFICIENT_POSITION',
              orderId: order.id,
              message: `当前持仓只有 ${state.position} 股，无法卖出 ${order.quantity} 股。`,
              actions: [
                { label: `减至 ${state.position} 股`, kind: 'reduce-qty', payload: { maxQty: state.position } },
                { label: '先插入一笔买入', kind: 'insert-buy' },
              ],
            });
          } else {
            const nextBar = kline[barIndex + 1];
            rejections.push({
              code: 'T1_LOCK',
              orderId: order.id,
              message: `A 股实行 T+1：当天买入的 ${state.boughtToday} 股需下一个交易日才能卖出，当日最多可卖 ${sellable} 股（除非用昨日已持有的底仓）。`,
              actions: [
                { label: '把卖出移到下一个交易日', kind: 'move-date', payload: { targetTimestamp: nextBar ? Date.parse(nextBar.date + 'T09:30:00+08:00') : 0 } },
                { label: `改卖昨日底仓 ${sellable} 股`, kind: 'reduce-qty', payload: { maxQty: sellable } },
              ],
            });
          }
          processed += 1;
          continue;
        }
        const proceeds = round2(turnover - fee);
        state.realizedPnL += proceeds - state.avgCost * order.quantity;
        state.cash = round2(state.cash + proceeds);
        state.position -= order.quantity;
        netCapitalUsed -= proceeds;
        state.totalStampTax += feeBreakdown.stamp;
        if (state.position === 0) state.avgCost = 0;
      }

      state.tradeCount += 1;
      state.totalFees += fee;
      processed += 1;
    }

    // 2. 当日快照
    const totalAsset = state.cash + state.position * bar.close;
    const unrealized = state.position > 0 ? state.position * (bar.close - state.avgCost) : 0;
    snapshots.push({
      timestamp: bar.date,
      position: state.position,
      cost: round2(state.avgCost),
      marketPrice: bar.close,
      cash: round2(state.cash),
      totalAsset: round2(totalAsset),
      unrealizedPnL: round2(unrealized),
      drawdown: 0, // 待后处理计算
    });
  }

  // ---- 评估日清算 ----
  // 兜底：仍有订单日期晚于行情末根（含晚于评估日）→ 必须显式拒绝，不能静默丢弃
  while (processed < sorted.length) {
    const order = sorted[processed];
    rejections.push({
      code: 'BEYOND_ASOF',
      orderId: order.id,
      message: `这笔操作日期 ${order.timestamp.slice(0, 10)} 晚于评估日 ${asOfDate}，无法推演。`,
      actions: [{
        label: '移到最近交易日',
        kind: 'move-date',
        payload: { targetTimestamp: Date.parse(asOfDate + 'T09:30:00+08:00') },
      }],
    });
    processed += 1;
  }

  const asOfBar = kline[asOfBarIndex];
  const unrealizedProfit = state.position > 0
    ? round2(state.position * (asOfBar.close - state.avgCost))
    : 0;
  const finalCash = round2(state.cash);
  const totalAssetFinal = round2(finalCash + state.position * asOfBar.close);
  // 累计投入本金 = 初始模拟资金 + 全部已结算 DCA 注入
  const totalInjectedCash = round2(simulatedCash + state.cumInjected);
  // 总收益以「累计投入本金」为基准（非仅模拟资金），避免分批加仓后简单收益失真
  const finalProfit = round2(totalAssetFinal - totalInjectedCash);

  // ---- 回撤后处理（相对峰值） ----
  let peakAsset = -Infinity;
  for (const s of snapshots) {
    if (s.totalAsset > peakAsset) peakAsset = s.totalAsset;
    s.drawdown = peakAsset > 0 ? round2(((s.totalAsset - peakAsset) / peakAsset) * 100) : 0;
  }

  // ---- 警示：中途浮盈回吐（§4.2 展示要求） ----
  let peakUnrealized = 0;
  for (const s of snapshots) {
    if (s.unrealizedPnL > peakUnrealized) peakUnrealized = s.unrealizedPnL;
  }
  if (peakUnrealized > 100 && finalProfit < peakUnrealized) {
    warnings.push(
      `该方案中途最高浮盈 +¥${peakUnrealized.toLocaleString()}，评估日结算为 ${finalProfit >= 0 ? '+' : ''}¥${finalProfit.toLocaleString()}（持有至今遇回调）。可在时间线上提前插入卖出落袋。`,
    );
  }

  const capitalOccupationDays = sorted.length > 0
    ? Math.max(1, Math.round((Date.parse(asOfDate) - Date.parse(sorted[0].timestamp)) / 86400000) + 1)
    : 0;

  // ---- 资金加权 / 时间加权收益（DCA 口径） ----
  // 资金加权：平均占用本金 = 每天 (现金 + 持仓成本) 的均值；资金加权收益 = 总收益 / 平均占用本金
  let capitalBaseSum = 0;
  let capitalBaseCount = 0;
  for (const s of snapshots) {
    // 持仓成本 = 股数 × 移动加权成本；加上现金即当日占用资本
    const employed = s.cash + s.position * s.cost;
    capitalBaseSum += employed;
    capitalBaseCount += 1;
  }
  // 无快照时以累计本金兜底
  const avgCapitalEmployed = capitalBaseCount > 0 ? capitalBaseSum / capitalBaseCount : totalInjectedCash;
  const capitalWeightedReturnRate =
    avgCapitalEmployed > 0 ? round2((finalProfit / avgCapitalEmployed) * 100) : 0;

  // 时间加权（TWR）：修正入金后逐日链式复合（几何 True）。
  // 入金日的日收益 = (当日总资产 − 当日入金) / 前一日总资产 − 1，剔除现金流扭曲。
  let twr = 1;
  let prevAsset = totalInjectedCash; // 首日前一期末净资产 = 累计投入本金
  for (const s of snapshots) {
    const inflow = dailyInjected[s.timestamp] ?? 0;
    const periodEnd = s.totalAsset - inflow; // 剔除当日新增入金
    if (prevAsset > 0) twr *= periodEnd / prevAsset;
    prevAsset = s.totalAsset;
  }
  const timeWeightedReturnRate = twr > 0 ? round2((twr - 1) * 100) : 0;

  const result: SandboxResult = {
    asOfDate,
    finalProfit,
    realizedProfit: round2(state.realizedPnL),
    unrealizedProfit,
    returnRate: simulatedCash > 0 ? round2((finalProfit / simulatedCash) * 100) : 0,
    peakRequiredCash: round2(peakRequiredCash),
    totalInjectedCash,
    principalReturnRate: totalInjectedCash > 0 ? round2((finalProfit / totalInjectedCash) * 100) : 0,
    capitalWeightedReturnRate,
    timeWeightedReturnRate,
    maxDrawdown: snapshots.length > 0
      ? Math.abs(Math.min(...snapshots.map((s) => s.drawdown)))
      : 0,
    volatility: 0, // 由 metricsEngine 从快照计算（避免引擎依赖统计逻辑）
    totalFees: round2(state.totalFees),
    totalStampTax: round2(state.totalStampTax),
    tradeCount: state.tradeCount,
    capitalOccupationDays,
    finalPosition: state.position,
    finalCash,
    buyAndHold: {
      finalProfit: 0,
      returnRate: 0,
      maxDrawdown: 0,
    },
    snapshots,
  };

  return {
    ok: rejections.length === 0,
    result: rejections.length === 0 ? result : undefined,
    rejections,
    warnings,
    peakRequiredCash: round2(peakRequiredCash),
  };
}
