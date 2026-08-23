/**
 * @file strategyGenerators.ts
 * @description 沙盘预设策略生成器（纯函数，可单测）：以「初始模拟资金 + 时序现金注入（DCA）」
 *             为硬底座，内置 1.5% 规费/滑点缓冲垫，生成纪律化的买卖订单。
 *
 * 【反未来函数（下影线撮合风险）】策略信号以当日收盘（Close）判定，订单执行时间戳记录为
 *  下一个交易日，成交价锚定次日开盘价（Next Open）——严格事后视角，杜绝用当日盘中/最低价
 * 提前成交的「未来函数」/「下影线」撮合。
 *
 * 【资金底座】初始可用现金 = 初始模拟资金；注入事件 cashInjections 于盘前入账（可用现金 +=
 * amount，计入累计本金）。策略在任一日计算可用预算时，一律基于引擎已入账的当日及历史注入
 * （撮合日盘前入账，sign 在外结算），严禁在第 0 天透支使用未来的 DCA 资金。
 *
 * 【核心算法加固（本次 Bug 修复）】
 *  1. pyramid：levelBought 严格逐档（16.7% / 33.3% / 50%）触发，杜绝单日多档重复及无休止买入；
 *              突破均价 +5% 全额解套后重置 ref 与 levelBought 开启新一轮波段。
 *  2. stop-profit：引入 tp1Triggered 标志（替代 position!==qty 死锁），首次触 1R 减半并上移保本，
 *     触 2R 或破止损全清。
 *  3. ma20-bounce：PoolA/PoolB 槽位状态 + 减仓 50% 释放 Pool A 槽位，允许下次回踩继续低吸做 T。
 *  4. grid：箱体统计仅用「前向历史窗口」（前 boxSize 根），杜绝未来函数。
 *  5. 全策略可用的预算是基于当日及历史注入；修正 budgetQty 缓冲公式，避免双重 ÷(1+Buff)。
 *
 * 【六大技法】
 *  1. ma20-bounce   均线回踩低吸：Pool A(50%) MA20 回踩低吸 + Pool B(50%) MA60 深度回踩加仓；
 *                   向上偏离 MA20 达 +8%~10% 减仓 50% 释放 Pool A 槽位回流现金池。
 *  2. pyramid       金字塔左侧摊薄：1:2:3 加权递增（首 16.7%、跌 4% 补 33.3%、跌 8% 补 50%）；
 *                   反弹突破综合持仓均价 +5% 减持全体解套、重置波段。
 *  3. grid          波动箱体网格：前向 N 日高低点将资金 N 等分（Slot），跌穿网格线买 1 份、
 *                   涨穿上一档卖对应份额。
 *  4. stop-profit   止损止盈风控：按账户 2% 单笔风险反推建仓量，跌破止损全额清仓、
 *                   达 1R 减半仓并保本跟踪、达 2R 全部清仓。
 *  5. max-opportunity 最大机会满仓出击：平时持币，多维共振（回踩 MA60 + 站稳 MA20 +
 *                   距近期大底止损 ≤4%）时动用 ≤80% 一键打满，绑定硬止损 + 1.5 ATR 移动止盈。
 *  6. pure-dca      纯被动定期定额定投：固定周期开盘，仅用当日已入账资金按单期预算买入，
 *                   不主动卖出，持有至评估日清算。
 * @layer Logic
 * @storage_impact 纯函数，不读写任何存储。
 * @author 开发团队
 */

import type { BlankStrategyState, CashInjection, KlineItem, PresetStrategyId, SandboxOrder, TradeIntent } from '../types/sandbox';
import type { FeeConfig, SecurityKind } from './mathUtils';

// ============================================================
// 策略上下文与统一接口
// ============================================================

/** 策略生成上下文 */
export interface StrategyContext {
  /** 前复权日 K 线（时间升序） */
  klineData: KlineItem[];
  /** 基线订单（历史/兼容保留；当前无生成器使用） */
  baselineOrders?: SandboxOrder[];
  /** 历史资金占用峰值（预算上限） */
  peakCapitalLock: number;
  /** 模拟资金（默认=峰值，可调） */
  simulatedCash: number;
  /** 时序现金注入（DCA）：某日盘前入账，计入可用现金 */
  cashInjections?: CashInjection[];
  /** 最后一根 K 线收盘价（现价） */
  currentPrice: number;
  /** 当前持仓均价 */
  currentCost: number;
  /** 当前持仓股数 */
  currentQuantity: number;
  /** 全局费率配置（卡片展示用） */
  feeConfig: FeeConfig;
  /** 证券类型 */
  securityKind: SecurityKind;
  /** 预设策略推演起始日（YYYY-MM-DD，来源于选中仓位的开仓日 positions.openAt）：
   *  传入后策略出单起始点对齐到该日，确保第一笔买入信号不早于真实开仓日 */
  strategyStartDate?: string;
}

/** 策略生成器统一接口 */
export interface StrategyGenerator {
  id: PresetStrategyId;
  /** 策略名（Ui 展示） */
  name: string;
  /** 一行描述 */
  description: string;
  defaultParams: Record<string, number>;
  paramLabels: Record<string, string>;
  /** 确定性生成订单（时间升序，seqIndex 连续） */
  generate: (ctx: StrategyContext, params: Record<string, number>) => SandboxOrder[];
  /**
   * 策略自身“零成交”时的原因（可选）：返回 undefined / null 表示该策略在给定上下文下
   * “本可产生交易或无法一概而论”，页面在 0 笔时用此字段解释为何空仓（属策略自身门槛）。
   */
  inactivityReason?: (ctx: StrategyContext) => string | null | undefined;
}

// ============================================================
// 工具函数
// ============================================================

/** 规费/滑点缓冲垫（1.5%） */
export const BUY_BUFFER_RATE = 0.015;
/** 卖出扣费率（对称记账）：印花税+佣金+过户费，卖出时冲减回流现金，模拟交易阻力 */
export const SELL_BUFFER_RATE = 0.001;
/** 固定费用估计（元）：盘前保守测算最大可买量 */
const FIXED_FEE = 5;

/** 剩余可用资金 = 模拟资金 − 当前持仓市值（按成本价），下限 0 */
export function computeRemainingCash(ctx: StrategyContext): number {
  return Math.max(0, ctx.simulatedCash - ctx.currentQuantity * ctx.currentCost);
}

/** 向下取整到 100 股整数倍 */
function roundTo100(qty: number): number {
  return Math.max(0, Math.floor(qty / 100) * 100);
}

/**
 * 预算买入量（含 1.5% 缓冲 + 固定规费）：为 100 股向下取整。
 * 缓冲只施加一次（计入成交价），不二次除以，避免预算被双重稀释而过度保守。
 * maxQty = floor((budget - fixedFee) / (price * (1 + BUFFER) * 100)) * 100
 */
export function budgetQty(price: number, budget: number): number {
  if (price <= 0 || budget <= 0) return 0;
  const affordable = budget - FIXED_FEE;
  if (affordable <= 0) return 0;
  const qty = Math.floor(affordable / (price * (1 + BUY_BUFFER_RATE) * 100)) * 100;
  return Math.max(0, qty);
}

/** 计算均线序列（不足周期时返回 null 前缀，长度与输入一致） */
function calcMA(klines: KlineItem[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < klines.length; i++) {
    sum += klines[i].close;
    if (i >= period) sum -= klines[i - period].close;
    result.push(i >= period - 1 ? sum / period : null);
  }
  return result;
}

/** 取近 N 根 K 线的最低价 / 最高价 */
function recentLowHigh(klines: KlineItem[], n: number): { low: number; high: number } {
  const slice = klines.slice(-n);
  return {
    low: slice.reduce((m, k) => Math.min(m, k.low), Infinity),
    high: slice.reduce((m, k) => Math.max(m, k.high), -Infinity),
  };
}

/**
 * 防未来函数撮合：信号在索引 i 以收盘成立，订单执行于下一交易日开盘价。
 * 返回下一交易日 {date, price=open}；若已无下一日，退化为当前日（末尾不新增）。
 */
function execAtNext(i: number, kline: KlineItem[]): { date: string; price: number } | null {
  const next = kline[i + 1];
  if (!next) return null;
  return { date: next.date, price: next.open };
}

/** 二分定位 kline 中 date >= 目标日期的第一根 K 线索引；全部早于目标则返回 -1 */
function firstBarOnOrAfter(kline: KlineItem[], date: string): number {
  let lo = 0;
  let hi = kline.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (kline[mid].date >= date) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

// ============================================================
// 通用执行引擎与策略意图协议（Strategy Reducer + Engine）
// ============================================================

/**
 * 策略意图：策略只“想做什么”，不负责如何撮合 / 记账。
 * - 买入：给目标预算 `notional`（元，含费前）或目标股数 `shares`；引擎按次日开盘价、
 *   1.5% 规费缓冲与 100 股取整再转换为成交股数，并受当日可用现金硬性约书。
 * - 卖出：给目标股数 `shares`（最好优先用股数）或目标回提金额 `notional`；引擎按次日开盘价
 *   结算净回提（扣卖费），并受当前持仓上限。
 */
export interface StrategyIntent {
  action: 'buy' | 'sell';
  /** 目标金额（元，含费前）。买入=本笔预算上限；卖出=按价折算拟抛货额度（与 shares 二选一） */
  notional?: number;
  /** 目标股数（与否二选一，优先于 notional 换算） */
  shares?: number;
  /** 触发原因（供 UI 展示） */
  reason: string;
  /** 策略内部路由标签（如 grid 的档位索引、ma20 的池标识），仅供 reducers.commit 校对本次实际成交。 */
  tag?: string;
}

/** 步行到某一信号日时，引擎给策略的状态 + 账户快照（均不可被策略修改） */
export interface StrategyStepContext {
  /** 信号日索引（用于判断策略自身哨位：定投周期 / 档位触发） */
  i: number;
  /** 信号日 K 线（以收盘判定，不建房盘中/低价成交） */
  bar: KlineItem;
  /** 撮合目标日（次日开盘）；无下一交易日为 null，此轮丢弃 */
  next: { date: string; price: number } | null;
  /** 账户当前可用现金（引擎记账；= 初始 + 已 DCA 入账 − 净买耗） */
  cash: number;
  /** 当前持仓股数 */
  position: number;
  /** 持仓总成本（含买费） */
  costBasis: number;
  /** 移动加权持仓均价 = costBasis / position */
  avgCost: number;
  /** 截至撮合日已入账的 DCA 注入累计 */
  injectedSoFar: number;
}

/** 实际成交记录（由引擎在执行 intent 后回喂给 reduer.commit，供其把真实股数/成本写入私有状态） */
export interface StrategyFill {
  /** 对应 intent 的 tag */
  tag?: string;
  action: 'buy' | 'sell';
  price: number;
  qty: number;
  /** 成交额（买=含买费成本；卖=扣卖费净回笼） */
  notionalUsed: number;
}

/** 策略“可执行状态机”：初始状态 + 单日决策 +（可选）按实际成交提交私有状态。引擎持有全部账户/撮合/记账职责。 */
export interface StrategyReducer<TState> {
  /** 策略私有初始状态（如 levelBought[]、refPrice、heldByLevel[]），由引擎创建并存取 */
  initialState: () => TState;
  /** 给定信号日账户信息与当前状态，返回本轮意图（可能为空=持有）与中间状态 */
  step: (ctx: StrategyStepContext, state: TState) => { state: TState; intents: StrategyIntent[] };
  /**
   * 可选：引擎执行完本轮所有实际撮合后调用，把真实成交（股数/成本）回喂给策略，
   * 供其更新依赖实际成交量的私有状态（如网格 heldByLevel、均线池清 basis）。
   * 若不提供，则 step 返回的 state 即作为下一轮状态。
   */
  commit?: (ctx: StrategyStepContext, stepState: TState, fills: StrategyFill[]) => TState;
}

/** 引擎配置 */
export interface StrategyEngineOptions {
  /** 信号日循环起始索引（默认 0）；如 pyramid 需从 1 开始以对齐参考位） */
  startIndex?: number;
  /** 开仓日（YYYY-MM-DD）：若提供，信号日起始索引对齐到 kline 中 date >= 该日的第一根 */
  strategyStartDate?: string;
}

/** 按 100 股向下取整个买卖目标股数 */
function intentQty(intent: StrategyIntent, price: number, position: number, cash: number): { qty: number; notionalUsed: number } | null {
  if (intent.action === 'buy') {
    // 预算 = 意图目标金额 与 可用现金 之小者（还残扣固定规费），再经 budgetQty 取含费缓冲与 100 股取整
    const budget = Math.max(0, Math.min(intent.notional ?? Number.POSITIVE_INFINITY, cash));
    if (budget <= FIXED_FEE) return null;
    const qty = budgetQty(price, budget);
    if (qty <= 0) return null;
    return { qty, notionalUsed: qty * price * (1 + BUY_BUFFER_RATE) };
  }
  // sell：目标股数优先；否则按回款金额折算；均受当前持仓与 100 股取整约束
  let raw = 0;
  if (intent.shares != null && intent.shares > 0) {
    raw = intent.shares;
  } else if (intent.notional != null && intent.notional > 0) {
    raw = Math.floor(intent.notional / price);
  } else {
    raw = position;
  }
  const qty = roundTo100(Math.min(raw, position));
  if (qty <= 0) return null;
  return { qty, notionalUsed: qty * price * (1 - SELL_BUFFER_RATE) };
}

/**
 * 通用执行循环（与策略无关）：负责全部“跑策略”的机械工作——
 *   盘前 DCA 入账同步 / 信号→次日开盘撮合 / 规费缓冲 / 100 股取整 /
 *   对称账本（cash / position / costBasis / avgCost）/ seqIndex 编号与时间戳。
 * 反未来函数、资金线程、规费缓冲都由引擎统一保证，策略本身不再重复实现。
 */
export function runStrategyEngine<TState>(
  reducer: StrategyReducer<TState>,
  klineData: KlineItem[],
  initialCash: number,
  cashInjections: CashInjection[],
  options: StrategyEngineOptions = {},
): SandboxOrder[] {
  if (klineData.length < 2) return [];
  // 起始信号日索引：策略自身温启动位（startIndex）与开仓日对齐位取较大者，
  // 保证不早于真实开仓日（firstBarOnOrAfter 在按日升序的日线上二分定位）。
  // 若开仓日晚于全部 K 线（无任何合法信号日），直接把起点推到 end 之后 → 本轮空仓。
  let startIndex = options.startIndex ?? 0;
  if (options.strategyStartDate) {
    const alignIdx = firstBarOnOrAfter(klineData, options.strategyStartDate);
    if (alignIdx < 0) {
      startIndex = klineData.length; // 无合法信号日，令 for(i<end) 空转
    } else {
      startIndex = Math.max(startIndex, alignIdx);
    }
  }
  const end = klineData.length - 1;

  let cash = initialCash;
  let position = 0;
  let costBasis = 0;
  let avgCost = 0;
  let state = reducer.initialState();

  // DCA 入账游标（严格时序：撮合日盘前至多入账当日及历史）
  const injects = cashInjections.slice().sort((a, b) => a.date.localeCompare(b.date));
  let injectIdx = 0;
  let injectedSoFar = 0;

  const items: Array<{ date: string; price: number; quantity: number; action: 'buy' | 'sell'; note: string }> = [];

  for (let i = startIndex; i < end; i++) {
    const next = execAtNext(i, klineData);
    if (!next) continue; // 无下一交易日，本信号不撮合
    // 撮合日盘前 DCA 入账
    while (injectIdx < injects.length && injects[injectIdx].date <= next.date) {
      cash += injects[injectIdx].amount;
      injectedSoFar += injects[injectIdx].amount;
      injectIdx++;
    }
    const ctx: StrategyStepContext = {
      i,
      bar: klineData[i],
      next,
      cash,
      position,
      costBasis,
      avgCost,
      injectedSoFar,
    };
    const { state: stepState, intents } = reducer.step(ctx, state);
    state = stepState;
    const fills: StrategyFill[] = [];
    for (const intent of intents) {
      const resolved = intentQty(intent, next.price, position, cash);
      if (!resolved || resolved.qty <= 0) continue;
      fills.push({ tag: intent.tag, action: intent.action, price: next.price, qty: resolved.qty, notionalUsed: resolved.notionalUsed });
      items.push({
        date: next.date,
        price: next.price,
        quantity: resolved.qty,
        action: intent.action,
        note: intent.reason,
      });
      if (intent.action === 'buy') {
        cash -= resolved.notionalUsed;
        costBasis += resolved.notionalUsed;
        position += resolved.qty;
      } else {
        cash += resolved.notionalUsed;
        position -= resolved.qty;
        costBasis = Math.max(0, costBasis - resolved.qty * avgCost);
      }
      avgCost = position > 0 ? costBasis / position : 0;
    }
    // 把本轮真实成交回喂策略（若实现了 commit），供其更新依赖实际成交量的私有状态
    if (reducer.commit) state = reducer.commit(ctx, state, fills);
  }

  return items.map((o, index) => ({
    id: `gen-${index}-${o.date}-${o.price}`,
    branchId: '',
    seqIndex: index,
    action: o.action,
    timestamp: `${o.date}T09:30:00+08:00`,
    price: Math.round(o.price * 100) / 100,
    quantity: o.quantity,
    note: o.note,
    kind: undefined,
  }));
}

// ============================================================
// 1. 均线回踩低吸（ma20-bounce）
// ============================================================

const ma20BounceGenerator: StrategyGenerator = {
  id: 'ma20-bounce',
  name: '均线回踩低吸',
  description: '上升趋势回调低吸：Pool A(50%) 回踩 MA20 低吸，Pool B(50%) 深度回踩 MA60 加仓；向上偏离 MA20 达 +8%~10% 减仓 50% 释放 Pool A 槽位。',
  defaultParams: { maFast: 20, maSlow: 60, deviation: 9 },
  paramLabels: { maFast: '快线周期', maSlow: '慢线周期', deviation: '减仓偏离度(%)' },
  generate: (ctx, params) => {
    const { klineData } = ctx;
    const maFast = Math.max(5, Math.round(params.maFast ?? 20));
    const maSlow = Math.max(10, Math.round(params.maSlow ?? 60));
    const deviation = Math.max(2, params.deviation ?? 9);
    if (klineData.length <= maSlow) return [];
    const fast = calcMA(klineData, maFast);
    const slow = calcMA(klineData, maSlow);
    // 资金底座：初始 + 全部注入；Pool A / B 各占 50% 本金上限
    const totalCapital = ctx.simulatedCash + (ctx.cashInjections ?? []).reduce((s, c) => s + c.amount, 0);
    interface MbState {
      poolAUsed: boolean;
      poolBUsed: boolean;
      poolABasis: number; // Pool A 已占用的实际成本（元）
      poolAShares: number; // 当前归属 Pool A 的持股份额（减仓时只减持这部分，绝不误伤 Pool B）
      lastBuyPrice: number; // 最近一个买入成交价（风控止损参考）
    }
    const reducer: StrategyReducer<MbState> = {
      initialState: () => ({ poolAUsed: false, poolBUsed: false, poolABasis: 0, poolAShares: 0, lastBuyPrice: 0 }),
      step: (sctx, state) => {
        const { bar, position } = sctx;
        const f = fast[sctx.i];
        const s = slow[sctx.i];
        if (f == null || s == null) return { state, intents: [] };
        let ns = state;
        const intents: StrategyIntent[] = [];
        // 出场风控：跌破最近买入价 8% 或跌破 MA60 下方 4% → 清仓止损（杜绝单边死扛）
        if (position > 0 && ns.lastBuyPrice > 0) {
          const hitBuyStop = bar.close <= ns.lastBuyPrice * 0.92;
          const hitMa60Stop = s > 0 && bar.close <= s * 0.96;
          if (hitBuyStop || hitMa60Stop) {
            intents.push({ action: 'sell', shares: position, tag: 'ma-stop', reason: `出场风控止损：`+`${hitBuyStop ? '跌破买入价 8%' : '跌破 MA60 下方 4%'}` });
            return { state: { poolAUsed: false, poolBUsed: false, poolABasis: 0, poolAShares: 0, lastBuyPrice: 0 }, intents };
          }
        }
        // 减仓：偏离 MA20 ≥ deviation% → 仅当存在 Pool A 仓位时，减持“Pool A”的 50%（绝不切 Pool B）
        if (state.poolAUsed && position > 0 && state.poolAShares > 0 && bar.close >= f * (1 + deviation / 100)) {
          const qty = roundTo100(state.poolAShares * 0.5); // 只减持 Pool A 份额的一半
          if (qty > 0) {
            const frac = state.poolAShares > 0 ? qty / state.poolAShares : 0;
            intents.push({ action: 'sell', shares: qty, tag: 'ma-sell', reason: `偏离 MA${maFast} +${deviation}% 减仓 50%（仅 Pool A）` });
            ns = { ...state, poolABasis: Math.max(0, state.poolABasis * (1 - frac)), poolAShares: state.poolAShares - qty, poolAUsed: false };
          }
        }
        // 同日单向互斥：当日已卖出则不再买入，避免买卖抖动
        const sold = intents.some((it) => it.action === 'sell');
        if (!sold && !state.poolAUsed && bar.close < f && bar.close >= s) {
          intents.push({ action: 'buy', notional: Math.max(0, totalCapital * 0.5 - state.poolABasis), tag: 'ma-poola', reason: `MA${maFast}回踩低吸（Pool A）` });
        }
        if (!sold && !state.poolBUsed && bar.close <= s) {
          intents.push({ action: 'buy', notional: totalCapital * 0.5, tag: 'ma-poolb', reason: `MA${maSlow}深度回踩加仓（Pool B）` });
        }
        return { state: ns, intents };
      },
      // 真实成交回喂：买 Pool A 写入实际成本并占用；卖释放 A 槽位
      commit: (sctx, stepState, fills) => {
        let ns = stepState;
        for (const fill of fills) {
          if (fill.action === 'buy') ns = { ...ns, lastBuyPrice: fill.price };
          if (fill.tag === 'ma-poola' && fill.action === 'buy') ns = { ...ns, poolAUsed: true, poolABasis: fill.notionalUsed, poolAShares: fill.qty };
          else if (fill.tag === 'ma-poolb' && fill.action === 'buy') ns = { ...ns, poolBUsed: true };
          else if (fill.tag === 'ma-sell' && fill.action === 'sell') ns = { ...ns, poolAUsed: false };
        }
        return ns;
      },
    };
    return runStrategyEngine(reducer, klineData, ctx.simulatedCash, ctx.cashInjections ?? [], { startIndex: maSlow, strategyStartDate: ctx.strategyStartDate });
  },
  inactivityReason: (ctx) => {
    if (ctx.klineData.length === 0 || ctx.klineData.length < 10) return 'K 线不足（缺少慢线均线），无法判断回踩';
    return '所选区间内 MA20/MA60 回踩信号未现（价格未回落至快/慢线下），或池内预算/可投现金不足 → 未低吸';
  },
};

// ============================================================
// 2. 金字塔左侧摊薄（pyramid）
// ============================================================

const pyramidGenerator: StrategyGenerator = {
  id: 'pyramid',
  name: '金字塔摊薄',
  description: '左侧摊薄自救：1:2:3 加权递增（首 16.7%，跌 4% 补 33.3%，跌 8% 补 50%）；反弹突破综合持仓均价 +5% 全额解套、并重置波段。',
  defaultParams: { stepPercent: 4, levels: 3 },
  paramLabels: { stepPercent: '每档跌幅(%)', levels: '补仓档数' },
  generate: (ctx, params) => {
    const { klineData } = ctx;
    const stepPercent = Math.max(1, params.stepPercent ?? 4);
    const levels = Math.min(3, Math.max(2, Math.round(params.levels ?? 3)));
    if (klineData.length === 0) return [];

    // 资金底座 = 初始 + 全部注入（用于档位资金比例）；实际买入受当日已入账现金硬约束
    const totalPool = ctx.simulatedCash + (ctx.cashInjections ?? []).reduce((s, c) => s + c.amount, 0);
    // 1:2:3 → 资金比例 16.7% / 33.3% / 50%
    const weightAt = (k: number) => (k === 0 ? 1 / 6 : k === 1 ? 2 / 6 : 3 / 6);
    interface PState {
      ref: number;
      levelBought: boolean[];
    }

    const reducer: StrategyReducer<PState> = {
      initialState: () => ({ ref: 0, levelBought: new Array(levels).fill(false) }),
      step: (sctx, state) => {
        const { bar, position, avgCost } = sctx;
        if (state.ref === 0) {
          const lb = state.levelBought.slice();
          lb[0] = true;
          return {
            state: { ref: bar.close, levelBought: lb },
            intents: [
              {
                action: 'buy',
                notional: totalPool * weightAt(0),
                reason: `金字塔建第 1 档底仓（16.7%，入场参考 ¥${bar.close.toFixed(2)}）`,
              },
            ],
          };
        }
        // 风控熔断：综合持仓浮亏超 12% → 强制全额止损离场，重置波段
        if (position > 0 && avgCost > 0 && bar.close <= avgCost * 0.88) {
          return {
            state: { ref: bar.close, levelBought: new Array(levels).fill(false) },
            intents: [
              { action: 'sell', shares: position, reason: `风控熔断：综合浮亏超 12% 强制止损离场（均价 ¥${avgCost.toFixed(2)}，现价 ¥${bar.close.toFixed(2)}）` },
            ],
          };
        }
        // 解套减持：反弹突破综合持仓均价 +5% → 全额卖出并重置本轮（现金/持仓/档位全复位）
        if (position > 0 && avgCost > 0 && bar.close >= avgCost * 1.05) {
          return {
            state: { ref: bar.close, levelBought: new Array(levels).fill(false) },
            intents: [
              { action: 'sell', shares: position, reason: `反弹突破均价 +5% 全额解套（均价 ¥${avgCost.toFixed(2)}）` },
            ],
          };
        }
        // 左侧摊薄：按档位顺序严格触发，每档仅 1 次，且单日最多 1 档
        const step = stepPercent / 100;
        for (let k = 0; k < levels; k++) {
          if (state.levelBought[k]) continue;
          const trigger = state.ref * (1 - step * (k + 1));
          if (bar.close <= trigger) {
            const lb = state.levelBought.slice();
            lb[k] = true; // 该档已触发（无论现金是否够，均标记避免死锁）
            return {
              state: { ref: state.ref, levelBought: lb },
              intents: [
                {
                  action: 'buy',
                  notional: totalPool * weightAt(k),
                  reason: `金字塔补仓第 ${k + 1} 档（较入场 -${Math.round(step * (k + 1) * 100)}%，资金 ${Math.round(weightAt(k) * 100)}%）`,
                },
              ],
            };
          }
        }
        return { state, intents: [] };
      },
    };

    return runStrategyEngine(reducer, klineData, ctx.simulatedCash, ctx.cashInjections ?? [], { startIndex: 1, strategyStartDate: ctx.strategyStartDate });
  },
  inactivityReason: (ctx) => {
    if (ctx.klineData.length === 0) return '无 K 线数据';
    return '入场参考确立后价位一路未跌破底仓触发价，或跌破后可用现金不足 → 未产生可撮合订单（左侧摊薄需等到反向确认）';
  },
};

// ============================================================
// 3. 波动区间箱体网格（grid）
// ============================================================

const gridGenerator: StrategyGenerator = {
  id: 'grid',
  name: '箱体网格',
  description: '震荡箱体网格：前向 N 日高低点将资金 N 等分（Slot），跌穿网格线买 1 份，涨穿上一档卖对应份额。',
  defaultParams: { boxSize: 60, parts: 6 },
  paramLabels: { boxSize: '箱体统计周期(N)', parts: '网格份数(4~8)' },
  generate: (ctx, params) => {
    const { klineData } = ctx;
    const boxSize = Math.min(250, Math.max(10, Math.round(params.boxSize ?? 60)));
    const parts = Math.min(8, Math.max(4, Math.round(params.parts ?? 6)));
    if (klineData.length < 11) return [];
    const windowSize = Math.min(boxSize, Math.max(10, klineData.length));
    if (windowSize >= klineData.length) return [];
    const window = klineData.slice(0, windowSize);
    const boxLow = window.reduce((m, k) => Math.min(m, k.low), Infinity);
    const boxHigh = window.reduce((m, k) => Math.max(m, k.high), -Infinity);
    const range = boxHigh - boxLow;
    if (range <= 0) return [];
    const levels = Array.from({ length: parts }, (_, k) => boxLow + ((k + 1) * range) / (parts + 1));
    const totalCapital = ctx.simulatedCash + (ctx.cashInjections ?? []).reduce((s, c) => s + c.amount, 0);
    const slotNotional = totalCapital / parts;

    interface GState {
      heldByLevel: number[];
      lastLevel: number;
    }

    const reducer: StrategyReducer<GState> = {
      initialState: () => ({ heldByLevel: new Array(parts).fill(0), lastLevel: parts - 1 }),
      step: (sctx, state) => {
        const { bar } = sctx;
        let level = parts - 1;
        for (let k = 0; k < parts; k++) {
          if (bar.close <= levels[k]) { level = k; break; }
        }
        const intents: StrategyIntent[] = [];
        if (level < state.lastLevel) {
          for (let k = level; k < state.lastLevel; k++) {
            if (state.heldByLevel[k] === 0) {
              intents.push({ action: 'buy', notional: slotNotional, tag: 'grid-' + k, reason: '网格第 ' + (k + 1) + ' 档触发低吸' });
            }
          }
        }
        if (level > state.lastLevel) {
          for (let k = state.lastLevel; k < level; k++) {
            if (state.heldByLevel[k] > 0) {
              intents.push({ action: 'sell', shares: state.heldByLevel[k], tag: 'grid-' + k, reason: '网格第 ' + (k + 1) + ' 档回收卖出' });
            }
          }
        }
        return { state: { ...state, lastLevel: level }, intents };
      },
      commit: (sctx, stepState, fills) => {
        const held = stepState.heldByLevel.slice();
        for (const fill of fills) {
          if (fill.tag?.startsWith('grid-')) {
            const idx = Number(fill.tag.slice(5));
            if (Number.isInteger(idx) && idx >= 0 && idx < parts) {
              held[idx] = fill.action === 'buy' ? fill.qty : 0;
            }
          }
        }
        return { ...stepState, heldByLevel: held };
      },
    };

    return runStrategyEngine(reducer, klineData, ctx.simulatedCash, ctx.cashInjections ?? [], { startIndex: windowSize, strategyStartDate: ctx.strategyStartDate });
  },
  inactivityReason: (ctx) => {
    const { klineData } = ctx;
    if (klineData.length < 11) return 'K 线不足，无法构成前向箱体窗口';
    const boxSize = Math.min(250, Math.max(10, Math.round(60)));
    if (boxSize >= klineData.length) return '前向箱体窗口已覆盖全部行情，无后续价格可供穿越网格线 → 无成交';
    return '箱体窗口内价格未跌穿/涨穿任何网格线，或箱体波动区间过窄 → 无成交（网格策略需要行情穿越分档线）';
  },
};

// ============================================================
// 4. 止损止盈风控（stop-profit）
// ============================================================

/** 止损/止盈水平计算（供 UI 预览与单测验证 1R/2R） */
export interface StopProfitLevels {
  entry: number;
  stop: number;
  takeProfit1R: number;
  takeProfit2R: number;
  riskPerShare: number;
  /** 按账户风险比例反推的建仓量（100 股取整，受可用资金上限） */
  qty: number;
}

/** 止损止盈水平：止损=近 20 日最低；1R=+R；2R=+2R（R=entry−stop） */
export function computeStopProfitLevels(ctx: StrategyContext, params: Record<string, number> = {}): StopProfitLevels | null {
  const { klineData, currentPrice, currentCost, simulatedCash } = ctx;
  const stopPercent = Math.max(1, params.stopPercent ?? 5);
  const riskPercent = Math.max(0.5, params.riskPercent ?? 2);
  const rewardRatio = Math.max(1, params.rewardRatio ?? 2);
  if (klineData.length === 0) return null;

  const entry = currentCost > 0 ? currentCost : currentPrice;
  const low = recentLowHigh(klineData, 20).low;
  const stop = Math.min(low, entry * (1 - stopPercent / 100));
  const riskPerShare = entry - stop;
  if (riskPerShare <= 0) return null;

  const principal = simulatedCash + (ctx.cashInjections ?? []).reduce((s, c) => s + c.amount, 0);
  const riskBudget = (principal * riskPercent) / 100; // 账户最大单笔风险
  const qty = roundTo100(Math.min(riskBudget / riskPerShare, (principal * 0.2) / entry)); // 单押 ≤20%

  return {
    entry,
    stop,
    takeProfit1R: entry + riskPerShare,
    takeProfit2R: entry + rewardRatio * riskPerShare,
    riskPerShare,
    qty,
  };
}

// ============================================================
// 4. 止损止盈风控（stop-profit）
// ============================================================

const stopProfitGenerator: StrategyGenerator = {
  id: 'stop-profit',
  name: '止损止盈风控',
  description: '严格风控：账户 2% 风险反推仓位；动态 ATR 跟踪止损 + 1R 减半保本 + 2R 清仓 + 持仓超时离场，杜绝死锁。',
  defaultParams: { stopPercent: 5, riskPercent: 2, rewardRatio: 2, maxHoldingDays: 20, atrMultiplier: 2.0 },
  paramLabels: { stopPercent: '止损跌幅(%)', riskPercent: '账户风险(%)', rewardRatio: '盈亏比(R)', maxHoldingDays: '最大持仓天数', atrMultiplier: 'ATR跟踪倍数' },
  generate: (ctx, params) => {
    const { klineData } = ctx;
    // 入场与止盈/止损水平均在入场时按实际入场价动态计算（见下方 reducer），
    // 因此不依赖终端价格预计算；仅需足够 K 线（≥2 根以有次日撮合）。
    if (klineData.length < 2) return [];

    const stopPercent = Math.max(1, params.stopPercent ?? 5);
    const riskPercent = Math.max(0.5, params.riskPercent ?? 2);
    const rewardRatio = Math.max(1, params.rewardRatio ?? 2);

    const maxHoldingDays = Math.max(3, Math.round(params.maxHoldingDays ?? 20));
    const atrMultiplier = Math.max(0.5, params.atrMultiplier ?? 2.0);
    const atr14 = calcATR(klineData, 14);
    const ma5 = calcMA(klineData, 5);

    interface StopProfitState {
      entered: boolean;
      tp1Triggered: boolean; // 首次触 1R 已减半并止损上移保本
      entry: number; // 实际入场价（= 撮合次日开盘价）
      stop: number; // 动态止损价（初始=近20日低与 −stopPercent% 之小者；1R 后上移至 entry）
      tp1: number; // 1R 减半价 = entry + R
      tp2: number; // 2R 清仓价 = entry + rewardRatio·R（恒 > entry）
      highestPriceSinceEntry: number; // 入场后最高价（累计 bar.high 取大）
      holdingDays: number; // 持仓天数计数器
    }

    const reducer: StrategyReducer<StopProfitState> = {
      initialState: () => ({ entered: false, tp1Triggered: false, entry: 0, stop: 0, tp1: 0, tp2: 0, highestPriceSinceEntry: 0, holdingDays: 0 }),
      step: (sctx, state) => {
        const { bar, position, cash, i } = sctx;
        const nextOpen = sctx.next?.price;
        // 未入场：首个收盘 > 0 日建仓（风控入场），用当日已入账 cash 与 R 反推风险仓位
        if (!state.entered) {
          if (bar.close <= 0 || !nextOpen || nextOpen <= 0) return { state, intents: [] };
          const ma5v = ma5[i];
          const atrV = atr14[i];
          const aboveMA5 = ma5v != null && bar.close >= ma5v;
          const atrCalmed = atrV != null && !Number.isNaN(atrV) && atrV > 0 && (bar.high - bar.low) <= atrV * 1.5;
          if (!aboveMA5 && !atrCalmed) return { state, intents: [] }; // 开仓过滤：无强动能/波动未企稳则空仓等待
          const entryPrice = nextOpen;
          // 只用当日及以前数据定义止损（不含未来）：近20日低 与 −stopPercent% 之小者
          const low20 = recentLowHigh(klineData.slice(0, i + 1), 20).low;
          const stopPrice = Math.min(low20, entryPrice * (1 - stopPercent / 100));
          const risk = entryPrice - stopPrice;
          if (risk <= 0) return { state, intents: [] }; // 无法定义风险敞口 → 不建仓
          const tp1Price = entryPrice + risk;
          const tp2Price = entryPrice + rewardRatio * risk; // 恒 > entryPrice
          const dayCash = cash;
          const riskBudget = (dayCash * riskPercent) / 100;
          const riskQty = roundTo100(Math.min(riskBudget / risk, (dayCash * 0.2) / entryPrice));
          const entryQty = Math.min(riskQty, budgetQty(nextOpen, dayCash));
          if (entryQty <= 0) return { state, intents: [] };
          // 反推预算：使引擎 budgetQty 精确还原目标建仓量（含费缓冲）；入场当日不重复做退出判定
          const notional = entryQty * nextOpen * (1 + BUY_BUFFER_RATE) + FIXED_FEE;
          return {
            state: { entered: true, tp1Triggered: false, entry: entryPrice, stop: stopPrice, tp1: tp1Price, tp2: tp2Price, highestPriceSinceEntry: Math.max(entryPrice, bar.high), holdingDays: 1 },
            intents: [{ action: 'buy', notional, reason: '风控入场' }],
          };
        }
        // 已入场：每日先更新最高价与动态 ATR 跟踪止损，再做 2R/止损/1R/超时判定
        const highest = Math.max(state.highestPriceSinceEntry, bar.high);
        const holdingDays = state.holdingDays + 1;
        const atrNow = atr14[i];
        let stop = state.stop;
        if (atrNow && !Number.isNaN(atrNow)) {
          stop = Math.max(stop, Math.round((highest - atrMultiplier * atrNow) * 100) / 100);
        }
        const persist = { ...state, highestPriceSinceEntry: highest, stop, holdingDays };
        const reset = { entered: false, tp1Triggered: false, entry: 0, stop: 0, tp1: 0, tp2: 0, highestPriceSinceEntry: 0, holdingDays: 0 };
        // 2R 全额止盈
        if (state.tp2 > 0 && position > 0 && bar.close >= state.tp2) {
          return { state: reset, intents: [{ action: 'sell', shares: position, reason: '达 2R 全部清仓落袋' }] };
        }
        // 动态跟踪止损
        if (stop > 0 && position > 0 && bar.low <= stop) {
          return { state: reset, intents: [{ action: 'sell', shares: position, reason: `跌破动态跟踪止损线（¥${stop.toFixed(2)}）全额离场` }] };
        }
        // 1R 减半：找一个不限、保本
        if (!state.tp1Triggered && position > 0 && state.tp1 > 0 && bar.close >= state.tp1) {
          const sellQty = roundTo100(position * 0.5);
          const ns = { ...persist, tp1Triggered: true, stop: Math.max(stop, state.entry) };
          if (sellQty <= 0) return { state: ns, intents: [] };
          return { state: ns, intents: [{ action: 'sell', shares: sellQty, reason: '达 1R 减半，止损上移保本线' }] };
        }
        // 时间超时：持有满周期且未达 1R → 出清释放资金
        if (!state.tp1Triggered && holdingDays >= maxHoldingDays) {
          return { state: reset, intents: [{ action: 'sell', shares: position, reason: `持仓达 ${maxHoldingDays} 日动能衰竭，超时平仓释放资金` }] };
        }
        return { state: persist, intents: [] };
      },
    };

    return runStrategyEngine(reducer, klineData, ctx.simulatedCash, ctx.cashInjections ?? [], { strategyStartDate: ctx.strategyStartDate });
  },
  inactivityReason: (ctx) => {
    if (ctx.klineData.length === 0) return '无 K 线数据';
    return '入场后价位既未触发动态止损/1R/2R，也未达持仓超时线 → 保持持有无交易（无交易不代表无逻辑，属风控等待或超时离场间隙）';
  },
};

// ============================================================
// 5. 最大机会满仓出击（max-opportunity）
// ============================================================

const maxOpportunityGenerator: StrategyGenerator = {
  id: 'max-opportunity',
  name: '最大机会满仓出击',
  description: '多维共振满仓，硬止损 + 1.5 ATR 移动止盈。',
  defaultParams: { maFast: 20, maSlow: 60, atrPeriod: 14, maxUse: 0.8 },
  paramLabels: { maFast: '站上MA', maSlow: '回踩MA', atrPeriod: 'ATR周期', maxUse: '最大仓位比例' },
generate: (ctx, params) => genMaxOpportunity(ctx, params),
  inactivityReason: (ctx) => {
    if (ctx.klineData.length < 60) return 'K 线不足 60 根，无法计算慢线均值与 60 日低点';
    return '多维共振未满足（需同时成立：回踩 MA60、站上 MA20、距 60 日大底 ≤4%）→ 所选区间从未同时满足，全程空仓（属策略自身风控设计）';
  },
};

function calcATR(kline: KlineItem[], n: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < kline.length; i++) {
    const bar = kline[i];
    const prev = i > 0 ? kline[i - 1].close : bar.open;
    const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prev), Math.abs(bar.low - prev));
    out.push(tr);
    sum += tr;
    if (i >= n) sum -= out[i - n];
  }
  return out.map((tr, i) => (i >= n - 1 ? sum / n : NaN));
}

function genMaxOpportunity(ctx: StrategyContext, params: Record<string, number>): SandboxOrder[] {
  const { klineData, cashInjections, simulatedCash } = ctx;
  const maFast = Math.max(5, Math.round(params.maFast ?? 20));
  const maSlow = Math.max(10, Math.round(params.maSlow ?? 60));
  const atrPeriod = Math.max(5, Math.round(params.atrPeriod ?? 14));
  const maxUse = Math.min(0.9, Math.max(0.3, params.maxUse ?? 0.8));
  if (klineData.length < maSlow) return [];
  const fast = calcMA(klineData, maFast);
  const slow = calcMA(klineData, maSlow);
  const atr = calcATR(klineData, atrPeriod);

  return maxLoop(klineData, fast, slow, atr, simulatedCash, cashInjections ?? [], maxUse, ctx.strategyStartDate);
}

function maxLoop(klineData: KlineItem[], fast: (number | null)[], slow: (number | null)[], atr: number[], simulatedCash: number, cashInjections: CashInjection[], maxUse: number, strategyStartDate?: string): SandboxOrder[] {
  interface MaxState { stopLoss: number; trail: number; }
  const reducer: StrategyReducer<MaxState> = {
    initialState: () => ({ stopLoss: 0, trail: 0 }),
    step: (sctx, state) => {
      const { bar, position, cash, i } = sctx;
      const f = fast[i]; const s = slow[i]; const a = atr[i];
      if (f == null || s == null || Number.isNaN(a)) return { state, intents: [] };
      if (position > 0) {
        if (bar.low <= state.stopLoss || (state.trail > 0 && bar.close <= state.trail)) {
          return { state: { stopLoss: 0, trail: 0 }, intents: [{ action: 'sell', shares: position, reason: '止损/1.5ATR离场' }] };
        }
        return { state: { ...state, trail: Math.max(state.trail, bar.close - 1.5 * a) }, intents: [] };
      }
      const aboveFast = bar.close >= f;
      const pulled = s > 0 && bar.close <= s * 1.02 && aboveFast;
      const low60 = recentLowHigh(klineData.slice(Math.max(0, i - 60), i + 1), 60).low;
      const gap = low60 > 0 ? (bar.close - low60) / bar.close : 1;
      if (!pulled || gap > 0.04) return { state, intents: [] };
      const notional = Math.max(0, cash) * maxUse;
      if (notional <= FIXED_FEE) return { state, intents: [] };
      return { state: { stopLoss: Number((low60 * 0.98).toFixed(2)), trail: bar.close }, intents: [{ action: 'buy', notional, reason: '多维共振满仓' }] };
    },
  };
  return runStrategyEngine(reducer, klineData, simulatedCash, cashInjections, { strategyStartDate });
}

// ============================================================
// 6. 纯被动定期定额定投（pure-dca → zero-skill 基准线）
// ============================================================

/**
 * 空白策略单步结果
 */
export interface StrategyResult<TState> {
  intents: StrategyIntent[];
  state: TState;
}

/**
 * 空白策略单步纯函数：默认持币观望，按 state.pendingIntents 执行手动挂单。
 *
 * @param sc 策略步进上下文（含账户快照）
 * @param state 空白策略私有状态（pendingIntents / customStopLossPrice）
 * @returns 转换后的交易意图与更新后的状态
 */
export function blankStrategyStep(
  sc: StrategyStepContext,
  state: BlankStrategyState,
): StrategyResult<BlankStrategyState> {
  // 默认：无 pendingIntents → 纯粹持币/锁仓观望，不自动触发任何交易
  if (!state.pendingIntents || state.pendingIntents.length === 0) {
    return { intents: [], state: { ...state, pendingIntents: undefined } };
  }

  // 存在 pendingIntents：逐条校验资金/持仓后转换为正式 intents
  const intents: StrategyIntent[] = [];
  const remaining: TradeIntent[] = [];

  for (const intent of state.pendingIntents) {
    if (intent.action === 'buy') {
      // 买入校验：整百手 且 总额（含费缓冲） <= 可用现金
      const qty = Math.floor(intent.shares / 100) * 100;
      if (qty <= 0) {
        remaining.push(intent);
        continue;
      }
      const totalCost = qty * intent.price * (1 + BUY_BUFFER_RATE);
      if (totalCost > sc.cash) {
        remaining.push(intent);
        continue;
      }
      intents.push({
        action: 'buy',
        shares: qty,
        reason: intent.reason,
      });
    } else {
      // 卖出校验：<= 可用持仓
      const qty = Math.min(intent.shares, sc.position);
      if (qty <= 0) {
        remaining.push(intent);
        continue;
      }
      intents.push({
        action: 'sell',
        shares: qty,
        reason: intent.reason,
      });
    }
  }

  return {
    intents,
    state: {
      ...state,
      pendingIntents: remaining.length > 0 ? remaining : undefined,
    },
  };
}

/**
 * 创建空白方案初始配置。
 *
 * @param stockCode 含市场前缀的标的代码，如 'sh601318'
 * @param initialCash 初始模拟资金
 * @returns 空白方案初始配置
 */
export function createBlankScenario(
  stockCode: string,
  initialCash: number,
): { fullCode: string; simulatedCash: number } {
  return {
    fullCode: stockCode,
    simulatedCash: Math.max(0, initialCash),
  };
}

const manualBlankGenerator: StrategyGenerator = {
  id: 'manual-blank',
  name: '空白手动操盘',
  description: '纯粹持币/锁仓观望，不自动触发任何交易。你可以在时间线上手动添加买卖订单，进行步进式演练。',
  defaultParams: {},
  paramLabels: {},
  generate: () => [],
  inactivityReason: () => '空白方案：无自动交易信号，请在时间线上手动添加订单。',
};

const pureDcaGenerator: StrategyGenerator = {
  id: 'pure-dca',
  name: '纯被动定投',
  description: '定期定额基准线：每 N 个交易日开盘，仅用当日已入账资金按单期预算买入最大可买量，不主动卖出，持有至评估日清算。',
  defaultParams: { period: 20 },
  paramLabels: { period: '定投周期(交易日)' },
  generate: (ctx, params) => {
    const { klineData } = ctx;
    if (klineData.length === 0) return [];
    const period = Math.min(60, Math.max(5, Math.round(params.period ?? 20)));

    const totalPool = ctx.simulatedCash + (ctx.cashInjections ?? []).reduce((s, c) => s + c.amount, 0);
    const expectedPeriods = Math.max(1, Math.floor(klineData.length / period));
    const perPeriod = totalPool / expectedPeriods;

    // 纯被动定投：无私有状态，仅在序号 i ≡ period-1 (mod period) 的信号日发起买入
    const reducer: StrategyReducer<null> = {
      initialState: () => null,
      step: (sctx) => {
        const { i, cash } = sctx;
        if ((i - (period - 1)) % period !== 0) return { state: null, intents: [] };
        // 单期预算 = 目标每期额度 与 当日已入账可用现金 之小者；预算不足则本期不买
        const budget = Math.min(perPeriod, cash);
        if (budget <= FIXED_FEE) return { state: null, intents: [] };
        return {
          state: null,
          intents: [
            {
              action: 'buy',
              notional: budget,
              reason: `定期定额买入（第 ${Math.floor(i / period) + 1} 期，¥${Math.round(budget)}/期）`,
            },
          ],
        };
      },
    };

    return runStrategyEngine(reducer, klineData, ctx.simulatedCash, ctx.cashInjections ?? [], { strategyStartDate: ctx.strategyStartDate });
  },
  inactivityReason: (ctx) => {
    if (ctx.klineData.length === 0) return '无 K 线数据';
    return '首枚定投日尚未到达，或账户可用现金 < 固定规费，未产生买入（纯被动定期定额，需足一个定投周期与最小可买额）';
  },
};

// ============================================================
// 9. 环境自适应混合策略（hybrid-regime）：市场识别 + 子策略路由
// ============================================================

/** 市场环境枚举：单边趋势 trend / 箱体震荡 oscillation / 极高风险 risk */
export type MarketRegime = 'trend' | 'oscillation' | 'risk';

/**
 * 市场环境识别器（纯函数，无未来函数）：
 * - risk：收盘 < MA60（跌破季线）或均线偏离 biasMa20 < −0.05（破位）→ 优先触发风控与止损；
 * - trend：MA20 > MA60（多头排列）且 MA20 斜率向上，且未破位；
 * - oscillation：其余（价格在均线附近纠缠、无显著单边方向）。
 * @param volMa20 20 日量能均线（保留签名供后续量能加权风控）。
 */
export function detectMarketRegime(
  bar: KlineItem,
  i: number,
  klines: KlineItem[],
  ma20: (number | null)[],
  ma60: (number | null)[],
  volMa20: (number | null)[],
): MarketRegime {
  void klines;
  void volMa20;
  const m20 = ma20[i];
  const m60 = ma60[i];
  if (m20 == null || m60 == null || m20 <= 0) return 'oscillation';
  const bias = (bar.close - m20) / m20;
  if (bar.close < m60 || bias < -0.05) return 'risk';
  const prev = i > 0 ? ma20[i - 1] : null;
  if (m20 > m60 && prev != null && m20 >= prev) return 'trend';
  return 'oscillation';
}
/** 网格子状态（复用 grid 策略账本：档位持仓 + 上一次所处档位） */
interface GridSubState {
  heldByLevel: number[];
  lastLevel: number;
}

/** 网格子 reducer 工厂：按档位高抛低吸，单档预算 slotNotional（hybrid 下缩半仓适配震荡） */
function createGridReducer(opts: {
  levels: number[];
  parts: number;
  slotNotional: number;
}): StrategyReducer<GridSubState> {
  const { levels, parts, slotNotional } = opts;
  return {
    initialState: () => ({ heldByLevel: new Array(parts).fill(0), lastLevel: parts - 1 }),
    step: (sctx, state) => {
      let level = parts - 1;
      for (let k = 0; k < parts; k++) {
        if (sctx.bar.close <= levels[k]) { level = k; break; }
      }
      const intents: StrategyIntent[] = [];
      if (level < state.lastLevel) {
        for (let k = level; k < state.lastLevel; k++) {
          if (state.heldByLevel[k] === 0) {
            intents.push({
              action: 'buy',
              notional: slotNotional,
              tag: 'grid-' + k,
              reason: '震荡网格第 ' + (k + 1) + ' 档低吸',
            });
          }
        }
      }
      else if (level > state.lastLevel) {
        for (let k = state.lastLevel; k < level; k++) {
          if (state.heldByLevel[k] > 0) {
            intents.push({
              action: 'sell',
              shares: state.heldByLevel[k],
              tag: 'grid-' + k,
              reason: '震荡网格第 ' + (k + 1) + ' 档回收卖出',
            });
          }
        }
      }
      return { state: { ...state, lastLevel: level }, intents };
    },
    commit: (sctx, stepState, fills) => {
      const held = stepState.heldByLevel.slice();
      for (const fill of fills) {
        if (fill.tag?.startsWith('grid-')) {
          const idx = Number(fill.tag.slice(5));
          if (Number.isInteger(idx) && idx >= 0 && idx < parts) {
            held[idx] = fill.action === 'buy' ? fill.qty : 0;
          }
        }
      }
      return { ...stepState, heldByLevel: held };
    },
  };
}
/** 风控止损止盈子状态（对齐 stop-profit 策略） */
interface StopSubState {
  entered: boolean;
  tp1Triggered: boolean;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
}

function createStopProfitReducer(opts: {
  klineData: KlineItem[];
  stopPercent: number;
  riskPercent: number;
  rewardRatio: number;
}): StrategyReducer<StopSubState> {
const { klineData, stopPercent, riskPercent, rewardRatio } = opts;
  return {
    initialState: () => ({ entered: false, tp1Triggered: false, entry: 0, stop: 0, tp1: 0, tp2: 0 }),
    step: (sctx, state) => {
      const nextOpen = sctx.next?.price;
      if (!state.entered) {
        if (sctx.bar.close <= 0 || !nextOpen || nextOpen <= 0) return { state, intents: [] };
const entryPrice = nextOpen;
        const low20 = recentLowHigh(klineData.slice(0, sctx.i + 1), 20).low;
        const stopPrice = Math.min(low20, entryPrice * (1 - stopPercent / 100));
        const risk = entryPrice - stopPrice;
        if (risk <= 0) return { state, intents: [] };
        const tp1Price = entryPrice + risk;
        const tp2Price = entryPrice + rewardRatio * risk;
        const riskBudget = (sctx.cash * riskPercent) / 100;
const riskQty = roundTo100(Math.min(riskBudget / risk, (sctx.cash * 0.2) / entryPrice));
        const entryQty = Math.min(riskQty, budgetQty(nextOpen, sctx.cash));
        if (entryQty <= 0) return { state, intents: [] };
        const notional = entryQty * nextOpen * (1 + BUY_BUFFER_RATE) + FIXED_FEE;
        return {
          state: { entered: true, tp1Triggered: false, entry: entryPrice, stop: stopPrice, tp1: tp1Price, tp2: tp2Price },
          intents: [{ action: 'buy', notional, reason: '风控入场' }],
        };
}
      if (state.tp2 > 0 && sctx.position > 0 && sctx.bar.close >= state.tp2) {
        return {
          state: { entered: false, tp1Triggered: false, entry: 0, stop: 0, tp1: 0, tp2: 0 },
          intents: [{ action: 'sell', shares: sctx.position, reason: '达 2R 全部清仓落袋' }],
        };
      }
      if (state.stop > 0 && sctx.position > 0 && sctx.bar.low <= state.stop) {
return {
        state: { entered: false, tp1Triggered: false, entry: 0, stop: 0, tp1: 0, tp2: 0 },
          intents: [{ action: 'sell', shares: sctx.position, reason: '跌破止损，全额清仓' }],
        };
      }
      if (!state.tp1Triggered && sctx.position > 0 && state.tp1 > 0 && sctx.bar.close >= state.tp1) {
        const sellQty = roundTo100(sctx.position * 0.5);
        const ns = { ...state, tp1Triggered: true, stop: state.entry };
        if (sellQty <= 0) return { state: ns, intents: [] };
        return { state: ns, intents: [{ action: 'sell', shares: sellQty, reason: '达 1R 减半，止损上移保本线' }] };
      }
      return { state, intents: [] };
},
    };
}
/** 多因子子状态 */
interface ModelSubState {
  inPosition: boolean;
  stopPrice: number;
}

/** 多因子子 reducer 工厂：多因子评分择时买入，risk>=70 或跌破 2×ATR 动态止损卖出 */
function createModelSubReducer(
  factors: CoreFactors[],
  scores: RecommendationScore[],
  allocator: CapitalAllocator,
): StrategyReducer<ModelSubState> {
  return {
    initialState: () => ({ inPosition: false, stopPrice: 0 }),
    step: (sc, state) => {
      const s = scores[sc.i] ?? { breakoutScore: 0, pullbackScore: 0, riskScore: 0 };
      const atr = factors[sc.i]?.atr14 ?? 0;
      const intents: StrategyIntent[] = [];
      let ns = state;
      if (!state.inPosition) {
        const buyScore = Math.max(s.breakoutScore, s.pullbackScore);
        if (buyScore >= 75 && sc.next) {
          const budget = allocator.allocateBudget(buyScore, sc.cash);
          if (budget > 0 && sc.next.price > 0) {
            intents.push({ action: 'buy', notional: budget, reason: `多因子买入 breakout=${Math.round(s.breakoutScore)} / pullback=${Math.round(s.pullbackScore)}` });
          }
          ns = { inPosition: true, stopPrice: allocator.stopPrice(sc.next.price, atr) };
        }
      } else if (s.riskScore >= 70 || (state.stopPrice > 0 && sc.bar.low <= state.stopPrice)) {
          intents.push({ action: 'sell', shares: sc.position, reason: `高危清仓 risk=${Math.round(s.riskScore)} / 跌破止损 ${state.stopPrice.toFixed(2)}` });
          ns = { inPosition: false, stopPrice: 0 };
      }
      return { state: ns, intents };
    },
  };
}
/** 混合策略私有状态：市场环境 + 三套子环境的私有 reducer 状态 */
export interface HybridStrategyState {
  currentRegime: MarketRegime;
  gridState: GridSubState;
  modelState: ModelSubState;
  stopProfitState: StopSubState;
}

const hybridRegimeGenerator: StrategyGenerator = {
  id: 'hybrid-regime',
  name: '环境自适应混合',
  description:
    '市场识别器（risk/trend/oscillation）当日路由：破位切断买入、强清仓；趋势走多因子评分；震荡走低耗网格。',
  defaultParams: { trendSensitivity: 1.0 },
  paramLabels: { trendSensitivity: '趋势灵敏度' },
  generate: (ctx, params) => {
    const { klineData } = ctx;
    if (klineData.length < 62) return [];
    const trendSensitivity = Math.min(2, Math.max(0.5, params.trendSensitivity ?? 1));
    const riskTolerance = String(params.riskTolerance ?? 'strict');
    void trendSensitivity;

    const ma20 = calcMA(klineData, 20);
    const ma60 = calcMA(klineData, 60);
    const volMa20 = rollingAvg(klineData, 20, (k) => k.volume);

    const totalCapital = ctx.simulatedCash + (ctx.cashInjections ?? []).reduce((s, c) => s + c.amount, 0);
    const gridParts = Math.min(8, Math.max(4, Math.round(params.parts ?? 6)));
    const window = klineData.slice(0, Math.min(Math.max(10, Math.round(params.boxSize ?? 60)), klineData.length));
    const winRng = window.reduce((acc, k) => ({ low: Math.min(acc.low, k.low), high: Math.max(acc.high, k.high) }), { low: Infinity, high: -Infinity });
    const gridRange = winRng.high - winRng.low;
    if (gridRange <= 0) return [];
    const gridLevels = Array.from({ length: gridParts }, (_, k) => winRng.low + ((k + 1) * gridRange) / (gridParts + 1));
    const gridLevelNotional = (totalCapital * 0.5) / gridParts; // 单档预算缩至总资本 50%/份
    const factors = extractFactors(klineData);
    const scores = evaluateSignals(factors);
    const allocator = new CapitalAllocator();
    const gridReducer = createGridReducer({ levels: gridLevels, parts: gridParts, slotNotional: gridLevelNotional });
    const modelReducer = createModelSubReducer(factors, scores, allocator);
    const stopReducer = createStopProfitReducer({ klineData, stopPercent: 5, riskPercent: 2, rewardRatio: 2 });
    const hybridReducer: StrategyReducer<HybridStrategyState> = {
      initialState: () => ({
        currentRegime: 'oscillation',
        gridState: gridReducer.initialState(),
        modelState: modelReducer.initialState(),
        stopProfitState: stopReducer.initialState(),
      }),
      step: (sctx, st) => {
        const regime = detectMarketRegime(sctx.bar, sctx.i, klineData, ma20, ma60, volMa20);
        const intents: StrategyIntent[] = [];
        let ns: HybridStrategyState = st;

        if (regime === 'risk') {
          // 极高风险：阻断买入；持有仓位则强制清仓避险（riskTolerance 控制是否立即强平）
          if (riskTolerance === 'strict' && sctx.position > 0) {
            intents.push({ action: 'sell', shares: sctx.position, reason: '破位风控，强制清仓避险' });
          } else if (sctx.position > 0) {
            intents.push({ action: 'sell', shares: sctx.position, reason: '破位风控，减仓避险' });
          }
          ns = { ...st, currentRegime: regime };
        } else if (regime === 'trend') {
          const { state: ms, intents: mi } = modelReducer.step(sctx, st.modelState);
          ns = { ...st, currentRegime: regime, modelState: ms };
          intents.push(...mi);
        } else {
          const { state: gs, intents: gi } = gridReducer.step(sctx, st.gridState);
          ns = { ...st, currentRegime: regime, gridState: gs };
          intents.push(...gi);
        }
        return { state: ns, intents };
      },
      commit: (sctx, stepState, fills) => {
        if (stepState.currentRegime === 'oscillation' && gridReducer.commit) {
          return { ...stepState, gridState: gridReducer.commit(sctx, stepState.gridState, fills) };
        }
        return stepState;
      },
    };
    return runStrategyEngine(hybridReducer, klineData, ctx.simulatedCash, ctx.cashInjections ?? [], { startIndex: 62, strategyStartDate: ctx.strategyStartDate });
  },
  inactivityReason: (ctx) =>
    ctx.klineData.length < 62 ? 'K 线不足 62 根，无法稳定计算 MA20/MA60 与 ATR' : undefined,
};

// ============================================================
// 9. 多因子智能推荐（model-recommend）
//    因子提取层（5 大基石因子）→ 评分模型 → 独立资金分配器 CapitalAllocator
//    → 接入 StrategyReducer 意图闭环，交由 runStrategyEngine 统一撮合/记账。
// ============================================================

/** 单根 K 线提取的 5 大核心基石因子（严格只保留这 5 个，供评分与仓位锚定） */
export interface CoreFactors {
  /** 均线偏离度：(Close − MA20) / MA20。≈0 回踩企稳，显著 >0 超买，< −0.05 破位 */
  biasMa20: number;
  /** 20 日量比：Volume / MA(Volume,20)。>1.5 放量，<0.75 缩量衰竭 */
  volumeRatio20: number;
  /** K 线实体比例：|Close − Open| / (High − Low)。>0.6 单边趋势强 */
  bodyRatio: number;
  /** 上影线比例：(High − max(Open, Close)) / (High − Low)。识别冲高回落阻力 */
  upperShadowRatio: number;
  /** 14 日真实波幅（ATR14）：波动率锚点，作为止损与仓位缩放 */
  atr14: number;
}

/** 通用滚动均值（按字段取值），与输入同索引对齐；不足周期返回 null */
function rollingAvg(klines: KlineItem[], period: number, pick: (k: KlineItem) => number): (number | null)[] {
  const src = klines.map(pick);
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    if (i >= period) sum -= src[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

const clampPct = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round2 = (v: number): number => Math.round(v * 100) / 100;
const clampScore = (v: number): number => round2(Math.max(0, Math.min(100, v)));

/** 因子提取层：逐根提取 5 大基石因子（无未来函数） */
export function extractFactors(klines: KlineItem[]): CoreFactors[] {
  const ma20 = calcMA(klines, 20);
  const volMA20 = rollingAvg(klines, 20, (k) => k.volume);
  const atr14 = calcATR(klines, 14);
  return klines.map((k, i) => {
    const amp = Math.max(k.high - k.low, 1e-6);
    const m20 = ma20[i];
    const vMA = volMA20[i];
    return {
      biasMa20: m20 != null && m20 > 0 ? (k.close - m20) / m20 : NaN,
      volumeRatio20: vMA != null && vMA > 0 ? k.volume / vMA : NaN,
      bodyRatio: Math.abs(k.close - k.open) / amp,
      upperShadowRatio: (k.high - Math.max(k.open, k.close)) / amp,
      atr14: atr14[i],
    };
  });
}
export interface RecommendationScore {
  breakoutScore: number;
  pullbackScore: number;
  riskScore: number;
}

/**
 * 评分推荐模型：阈值内把“强度”连续映射为 0~100 分（非 0/1 二值），供 CapitalAllocator 缩放仓位。
 * - breakout 放量突破：实体>0.6、上影<0.2、量比≥1.5
 * - pullback 缩量企稳低吸：|biasMa20|≤0.02 贴近均线 + 量比≤0.75 缩量衰竭
 * - risk 高危风控：biasMa20<−0.05（破位）或（上影>0.5 且量比>2.0 天量滞涨）
 */
export function evaluateSignals(factors: CoreFactors[]): RecommendationScore[] {
  return factors.map((f) => {
    let breakoutScore = 0;
    let pullbackScore = 0;
    let riskScore = 0;

    if (f.bodyRatio > 0.6 && f.upperShadowRatio < 0.2 && f.volumeRatio20 >= 1.5) {
      const body = clampPct((f.bodyRatio - 0.6) / 0.4, 0, 1);
      const shadow = clampPct((0.2 - f.upperShadowRatio) / 0.2, 0, 1);
      const vol = clampPct((f.volumeRatio20 - 1.5) / 2.5, 0, 1);
      breakoutScore = 60 + 40 * (0.4 * body + 0.3 * shadow + 0.3 * vol);
    }

    if (Math.abs(f.biasMa20) <= 0.02 && f.volumeRatio20 <= 0.75) {
      const near = clampPct((0.02 - Math.abs(f.biasMa20)) / 0.02, 0, 1);
      const shrink = clampPct((0.75 - f.volumeRatio20) / 0.75, 0, 1);
      pullbackScore = 60 + 40 * (0.5 * near + 0.5 * shrink);
    }
    if (f.biasMa20 < -0.05) { riskScore = Math.max(riskScore, 70 + 30 * clampPct((-0.05 - f.biasMa20) / 0.15, 0, 1)); }
    if (f.upperShadowRatio > 0.5 && f.volumeRatio20 > 2.0) { riskScore = Math.max(riskScore, 70); }
    return {
      breakoutScore: clampScore(breakoutScore),
      pullbackScore: clampScore(pullbackScore),
      riskScore: clampScore(riskScore),
    };
  });
}
/** 独立资金分配器：按分动态缩放仓位，并结合 ATR14 提供动态止损位（拒绝固定金额） */
export class CapitalAllocator {
  readonly scoreFloor: number;
  readonly scoreCeil: number;
  readonly maxAllocation: number;
  constructor() {
    this.scoreFloor = 70;
    this.scoreCeil = 90;
    this.maxAllocation = 0.8;
  }
  /** 评分 → 资金分配比例：70~90 分线性映射 0%~80%（<70=0，≥90=80%） */
  allocateRatio(score: number): number {
    if (score <= this.scoreFloor) return 0;
    if (score >= this.scoreCeil) return this.maxAllocation;
    return ((score - this.scoreFloor) / (this.scoreCeil - this.scoreFloor)) * this.maxAllocation;
  }
  /** 由评分与当前可用资金求预算金额（元） */
  allocateBudget(score: number, availableCash: number): number {
    return this.allocateRatio(score) * Math.max(0, availableCash);
  }

  /** 动态止损位：入场价 − 2 × ATR14 */
  stopPrice(entryPrice: number, atr14: number): number {
    return entryPrice - 2 * atr14;
  }
}
/** 意图状态机：仅发出买/卖意图，撮合/记账交由 runStrategyEngine 统一处理 */
const modelRecommendGenerator: StrategyGenerator = {
  id: 'model-recommend',
  name: '多因子智能推荐',
  description: '5 大基石因子评分，动态分配资金并挂 2×ATR 动态止损。',
  defaultParams: {},
  paramLabels: {},
  generate: (ctx) => {
    const factors = extractFactors(ctx.klineData);
    const allScores = evaluateSignals(factors);
    // MA20 斜率：用于极端崩盘（单边暴跌绞肉）陡峭破位的识别
    const ma20 = calcMA(ctx.klineData, 20);
    const allocator = new CapitalAllocator();

    interface MRState {
      inPosition: boolean;
      stopPrice: number;
      /** 连续止损次数：默认 0，止损离场且为负收益 +1，正收益/止盈归零 */
      consecutiveLosses: number;
      /** 熔断冷却截止索引：= 触发熔断信号日 + 4（暂停买入 4 个交易日） */
      cooldownUntil: number;
    }
    const reducer: StrategyReducer<MRState> = {
      initialState: () => ({ inPosition: false, stopPrice: 0, consecutiveLosses: 0, cooldownUntil: 0 }),
      step: (sc, state) => {
        const s = allScores[sc.i] ?? { breakoutScore: 0, pullbackScore: 0, riskScore: 0 };
        const atr = factors[sc.i]?.atr14 ?? 0;
        const intents: StrategyIntent[] = [];
        let inPosition = state.inPosition;
        let stopPrice = state.stopPrice;
        let consecutiveLosses = state.consecutiveLosses;
        let cooldownUntil = state.cooldownUntil;

        if (!inPosition) {
          const buyScore = Math.max(s.breakoutScore, s.pullbackScore);
          // 极端崩盘熔断：深水区破位 + 均线陡峭向下 + 当日无量阳/下影企稳 → 静默拦截抄底/做T
          const f = factors[sc.i];
          const mCur = sc.i >= 0 ? ma20[sc.i] : null;
          const mPrev = sc.i >= 3 ? ma20[sc.i - 3] : null;
          const range = sc.bar.high - sc.bar.low;
          const lowerShadow = range > 0 ? (Math.min(sc.bar.open, sc.bar.close) - sc.bar.low) / range : 0;
          const isSevereCrash = !!(
            f && f.biasMa20 < -0.08 &&
            mCur != null && mPrev != null && mPrev > 0 &&
            (mCur - mPrev) / mPrev < -0.01 &&
            // 未出现放量阳线（量比≥1.5 且收阳）或下影企稳（下影≥50%）则仍处崩盘绞肉状态
            !(f.volumeRatio20 >= 1.5 && sc.bar.close >= sc.bar.open) &&
            lowerShadow < 0.5
          );
          const inCooldown = sc.i < state.cooldownUntil;
          if (buyScore >= 75 && !isSevereCrash && !inCooldown && sc.next) {
            const budget = allocator.allocateBudget(buyScore, sc.cash);
            if (budget > 0 && sc.next.price > 0) {
              intents.push({ action: 'buy', notional: budget, reason: `多因子买入 breakout=${Math.round(s.breakoutScore)} / pullback=${Math.round(s.pullbackScore)}` });
              inPosition = true;
              stopPrice = allocator.stopPrice(sc.next.price, atr);
            }
          }
        } else if (s.riskScore >= 70 || (state.stopPrice > 0 && sc.bar.low <= state.stopPrice)) {
          // 离场判定：按卖出实现盈亏维护连亏/熔断状态（正收益/不做T利润归零，负收益累加）
          const exitPrice = sc.next ? sc.next.price : sc.bar.close;
          const sellProceeds = sc.position * exitPrice * (1 - SELL_BUFFER_RATE);
          const profitable = sellProceeds >= sc.costBasis;
          if (!profitable) {
            consecutiveLosses += 1;
            if (consecutiveLosses >= 2) cooldownUntil = sc.i + 4; // 连续两次被止损 → 熔断暂停买入 4 个交易日
          } else {
            consecutiveLosses = 0; // 止盈/正收益离场即重置连亏
          }
          intents.push({ action: 'sell', shares: sc.position, reason: `高危清仓 risk=${Math.round(s.riskScore)} / 跌破止损 ${state.stopPrice.toFixed(2)}（连亏${consecutiveLosses}${sc.i < cooldownUntil ? `，熔断至#${cooldownUntil}` : ''}）` });
          inPosition = false;
          stopPrice = 0;
        }
        const ns: MRState = { inPosition, stopPrice, consecutiveLosses, cooldownUntil };
        return { state: ns, intents };
      },
    };
    return runStrategyEngine(reducer, ctx.klineData, ctx.simulatedCash, ctx.cashInjections ?? [], { strategyStartDate: ctx.strategyStartDate });
  },
  inactivityReason: (ctx) =>
    ctx.klineData.length < 21 ? 'K 线不足 21 根，无法稳定计算 MA20 / ATR14 因子' : undefined,
};

export const STRATEGY_GENERATORS: Record<PresetStrategyId, StrategyGenerator> = {

  'ma20-bounce': ma20BounceGenerator,
  pyramid: pyramidGenerator,
  grid: gridGenerator,
  'stop-profit': stopProfitGenerator,
  'max-opportunity': maxOpportunityGenerator,
  'pure-dca': pureDcaGenerator,
  'hybrid-regime': hybridRegimeGenerator,
  'model-recommend': modelRecommendGenerator,
  'manual-blank': manualBlankGenerator,
};

export const STRATEGY_IDS: PresetStrategyId[] = ['ma20-bounce', 'pyramid', 'grid', 'stop-profit', 'max-opportunity', 'pure-dca', 'hybrid-regime', 'model-recommend', 'manual-blank'];

/**
 * 按策略 id 生成订单。
 */
export function generateStrategyOrders(
  strategyId: PresetStrategyId,
  ctx: StrategyContext,
  params?: Record<string, number>,
): SandboxOrder[] {
  const generator = STRATEGY_GENERATORS[strategyId];
  if (!generator) return [];
  const merged = { ...generator.defaultParams, ...(params ?? {}) };
  return generator.generate(ctx, merged);
}
