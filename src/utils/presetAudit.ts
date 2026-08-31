/**
 * @file presetAudit.ts
 * @description 预设策略「静态审计」：给定真实 K 线 + 初始现金 + 参数，逐笔重放某策略
 *              生成的订单，用统一台账（买记成本含买费、卖记净回流扣卖费）追踪每步的
 *              现金 / 持仓 / 市值 / 浮动盈亏，并附上订单自带的触发原因。== 完全可复现（纯函数）。
 *
 * @why 客观验证策略输出买卖点：订单由 generateStrategyOrders 确定性生成（信号当日
 *      收盘判定、次日开盘撮合），审计仅做旁路记账，不修改订单；审计器据此核对
 *      「现金恒非负」与「净买入成本 ≤ 初始资金」两条硬不变量，用数据而非主观判断
 *      判定买卖点是否符合客观规则。
 * @layer Util
 * @storage_impact 纯函数，无副作用。
 */

import {
  BUY_BUFFER_RATE,
  SELL_BUFFER_RATE,
  STRATEGY_GENERATORS,
  generateStrategyOrders,
  type StrategyContext,
} from './strategyGenerators';
import { DEFAULT_FEE_CONFIG } from './feePresets';
import type { KlineItem, PresetStrategyId, SandboxOrder } from '../types/sandbox';

/** 单笔审计行：订单 + 重放后的现金/持仓/市值/浮动盈亏 + 触发原因 */
export interface AuditStep {
  seqIndex: number;
  date: string;
  action: 'buy' | 'sell';
  price: number;
  quantity: number;
  /** 成交额（买 = 含买费成本；卖 = 扣卖费净回流） */
  amount: number;
  reason: string;
  cash: number;
  position: number;
  marketValue: number;
}

/** 审计结果 */
export interface AuditResult {
  strategyId: string;
  strategyName: string;
  params: Record<string, number>;
  start: string;
  end: string;
  bars: number;
  initialCash: number;
  steps: AuditStep[];
  final: { cash: number; position: number; marketValue: number; realizedPnl: number; buyCount: number; sellCount: number };
  /** 资金不变量：任一时点现金 ≥ -ε */
  invariantOk: boolean;
  invariantError?: string;
  /**
   * 整策略无买卖时的“策略自身原因”：当且仅当 steps 为空（buyCount=sellCount=0）时给出来源，
   * 由策略自身门槛条件决定（如共振信号未满足），用于页面解释“为什么这笔没成交”。
   * 有交易时为空（undefined）。
   */
  inactivityReason?: string;
}

/**
 * 策略自身可能“零成交”的原因（仅供说明，不带入回测结果）。
 * 键 = 预设策略 id，值 = 该策略所有权下 0 笔交易的自然语言原因。
 * 未列出的策略默认返回 undefined（表示“本数据区间产生了交易，或策略本身不依赖择时”）。
 */
const INACTIVITY_REASONS: Partial<Record<PresetStrategyId, string>> = {
  'max-opportunity':
    '多维共振未满足（需同时成立：回踩 MA60、站上 MA20、距 60 日大底 ≤4%）；所选区间从未同时满足 → 全程空仓，属策略自身风控设计',
  'ma20-bounce': 'Pool A/B 均地未被回踩触发：池内预算或可投现金不足，或槽位全程被占用且无减仓缺口',
  pyramid: '入场参考确立后，动态始终未跌到底仓触发价，或跌破后可用现金不足 → 未产生可撮合订单',
  grid: '前向箱体窗口内价格未跌穿/涨穿任何网格线，或箱体波动区间过窄 → 无成交',
  'stop-profit': '入场参考确立后，价位既未触发止损/止盈，也未达减仓线 → 持有不动（无交易不代表无逻辑）',
  'pure-dca': '定投周期尚未到达首个定投日，或账户可用现金 < 固定规费 → 无法买入',
};

/** 构造最小策略上下文（生成器只用 klineData/simulatedCash/currentPrice/currentCost/baselineOrders） */
function makeAuditCtx(klineData: KlineItem[], simulatedCash: number, baselineOrders?: SandboxOrder[]): StrategyContext {
  return {
    klineData,
    simulatedCash,
    peakCapitalLock: simulatedCash,
    currentPrice: klineData[klineData.length - 1]?.close ?? 0,
    currentCost: 0,
    currentQuantity: 0,
    feeConfig: DEFAULT_FEE_CONFIG,
    securityKind: 'stock',
    baselineOrders,
  };
}

/**
 * 逐笔重放统一台账：返回步进 + 资金不变量校验。
 * @param baselineOrders 历史/兼容保留的基线订单（当前无生成器使用）
 */
export function auditPresetOrders(strategyId: PresetStrategyId, klineData: KlineItem[], initialCash: number, baselineOrders?: SandboxOrder[]): AuditResult {
  const gen = STRATEGY_GENERATORS[strategyId];
  const params = { ...(gen?.defaultParams ?? {}) } as Record<string, number>;
  const ctx = makeAuditCtx(klineData, initialCash, baselineOrders);
  const orders = gen ? generateStrategyOrders(strategyId, ctx, params) : [];

  let cash = initialCash;
  let position = 0;
  let avgCost = 0; // 移动加权持仓成本（含买费）
  let realizedPnl = 0;
  let minCash = cash;
  const steps: AuditStep[] = [];
  for (const o of orders) {
    let amount: number;
    if (o.action === 'buy') {
      amount = o.price * o.quantity * (1 + BUY_BUFFER_RATE);
      avgCost = position + o.quantity > 0 ? (position * avgCost + amount) / (position + o.quantity) : 0;
      cash -= amount;
      position += o.quantity;
    } else {
      amount = o.price * o.quantity * (1 - SELL_BUFFER_RATE);
      realizedPnl += amount - o.quantity * avgCost;
      cash += amount;
      position -= o.quantity;
    }
    minCash = Math.min(minCash, cash);
    steps.push({ seqIndex: o.seqIndex, date: o.timestamp.slice(0, 10), action: o.action, price: o.price, quantity: o.quantity, amount, reason: o.note ?? '', cash, position, marketValue: position * o.price });
  }

  const lastPrice = klineData[klineData.length - 1]?.close ?? 0;
  // 硬不变量：任一时点现金不得为负（允许 1 分钱净差/浮点误差）
  const invariantOk = minCash >= -1e-6;
  const buys = steps.filter((s) => s.action === 'buy');
  const sells = steps.filter((s) => s.action === 'sell');
  // 策略自身无交易原因：优先取生成器自带的 inactiveReason，否则回退到静态说明表
  const inactivityReason = buys.length === 0 && sells.length === 0 ? (gen?.inactivityReason?.(ctx) ?? INACTIVITY_REASONS[strategyId]) : undefined;

  return {
    strategyId,
    strategyName: gen?.name ?? strategyId,
    params,
    start: klineData[0]?.date ?? '',
    end: klineData[klineData.length - 1]?.date ?? '',
    bars: klineData.length,
    initialCash,
    steps,
    final: {
      cash,
      position,
      marketValue: position * lastPrice,
      realizedPnl,
      buyCount: buys.length,
      sellCount: sells.length,
    },
    invariantOk,
    invariantError: invariantOk ? undefined : `资金不变量破坏：最低现金 ${minCash.toFixed(2)} < 0`,
    inactivityReason,
  };
}

/** 将审计结果渲染为可读文本（每行一步；含原因） */
export function renderAudit(a: AuditResult): string {
  const rows: string[] = [];
  rows.push(`【${a.strategyId}｜${a.strategyName}】 ${a.start} → ${a.end}  共${a.bars}根K线，初始资金 ¥${a.initialCash.toLocaleString()}`);
  rows.push(`参数: ${JSON.stringify(a.params)}`);
  if (a.steps.length === 0) {
    rows.push(`  无买卖（0 笔交易）`);
    if (a.inactivityReason) rows.push(`      ↳ 策略自身原因: ${a.inactivityReason}`);
  } else {
    for (const s of a.steps) {
      const side = s.action === 'buy' ? '买入' : '卖出';
      const amt = s.action === 'buy' ? `-${s.amount.toFixed(0)}` : `+${s.amount.toFixed(0)}`;
      rows.push(
        `  #${String(s.seqIndex).padStart(2, '0')} ${s.date} ${side} ${s.quantity}股 @${s.price.toFixed(2)}  ${amt}  现金¥${s.cash.toFixed(0)} 持仓${s.position}股 市值¥${s.marketValue.toFixed(0)}`,
      );
      rows.push(`      ↳ ${s.reason}`);
    }
  }
  rows.push(`末态: 现金 ¥${a.final.cash.toFixed(0)}  持仓 ${a.final.position}股  市值 ¥${a.final.marketValue.toFixed(0)}  已实现盈亏 ¥${a.final.realizedPnl.toFixed(0)}  买入${a.final.buyCount}笔/卖出${a.final.sellCount}笔`);
  rows.push(`资金不变量(现金恒非负): ${a.invariantOk ? '成立 ✓' : '破坏 ✗' + (a.invariantError ?? '')}`);
  return rows.join('\n');
}