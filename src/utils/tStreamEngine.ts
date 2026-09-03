/**
 * @file tStreamEngine.ts
 * @description 短线 T+0 套利计算引擎：正T（先买后卖）与倒T（先卖后买）的状态机、
 *              步骤推进、结算归并与超限防御逻辑。所有计算均为纯函数，摩擦成本
 *              统一通过系统费率配置（FeeConfig）动态计算。
 * @layer Utility
 * @storage_impact 纯计算引擎，不读写任何存储；由 Store 层驱动并持久化。
 */

import Decimal from 'decimal.js';
import { calcTradeFees, roundTo, matchSecurityKind, type FeeConfig, type SecurityKind } from './mathUtils';
import type { Position, TRoundArchive } from '../types/domain';
import type {
  BasePosition,
  TMode,
  TradeDirection,
  TStepNode,
  TSettlementCard,
  SettlementType,
  TStateMachineState,
  TEngineStepInput,
  TEngineStepOutput,
  TStreamRecord,
} from '../types/tStrategy';

// Re-export for backward compatibility with existing code
export type { TStreamRecord };

// ──────────────────────────────────────────────
// 辅助函数
// ──────────────────────────────────────────────

/**
 * 创建初始状态机状态。
 *
 * @param basePosition - 初始底仓对象
 * @returns 初始化的状态机状态
 */
export function createInitialState(basePosition: BasePosition): TStateMachineState {
  return {
    mode: 'long', // 默认正T，由首笔流水方向自动切换
    basePosition: { ...basePosition },

    totalBuyQuantity: 0,
    totalBuyTurnover: 0,
    totalBuyFriction: 0,

    totalSellQuantity: 0,
    totalSellTurnover: 0,
    totalSellFriction: 0,

    realizedProfit: 0,

    currentCost: basePosition.cost,
    currentQuantity: basePosition.quantity,

    pendingBuys: [],
    pendingSells: [],
    initialShortSellQty: 0,

    steps: [],
    isClosed: false,
    closeReason: null,
    settlementCard: null,
    defenseDialog: null,
  };
}

/** 是否为正T卖出可以平仓 */
function isLongSellMatch(state: TStateMachineState, sellQty: number): boolean {
  return state.mode === 'long' && state.totalBuyQuantity > 0 && sellQty <= state.totalBuyQuantity;
}

/** 是否正T卖超 */
function isLongOverSell(state: TStateMachineState, sellQty: number): boolean {
  return state.mode === 'long' && sellQty > state.totalBuyQuantity;
}

/** 是否为倒T借仓卖出 */
function isShortInitialSell(state: TStateMachineState, direction: TradeDirection): boolean {
  return direction === 'sell' && state.mode === 'short' && state.totalSellQuantity === 0 && state.totalBuyQuantity === 0;
}

/** 是否倒T买回可以平仓 */
function isShortBuyBackMatch(state: TStateMachineState, buyQty: number): boolean {
  return state.mode === 'short' && state.totalSellQuantity > 0 && buyQty <= state.totalSellQuantity;
}

/** 是否倒T买超 */
function isShortOverBuy(state: TStateMachineState, buyQty: number): boolean {
  return state.mode === 'short' && buyQty > state.totalSellQuantity;
}

// ──────────────────────────────────────────────
// 步骤节点构建
// ──────────────────────────────────────────────

function buildStepNode(
  state: TStateMachineState,
  record: TStreamRecord,
  stepIndex: number,
): TStepNode {
  const turnover = new Decimal(record.price).mul(record.amount).toNumber();

  const isBuy = record.direction === 'buy';

  return {
    index: stepIndex,
    direction: record.direction,
    price: record.price,
    amount: record.amount,
    turnover: roundTo(turnover, 2),

    netOutflow: isBuy ? roundTo(turnover + record.fee, 2) : null,
    netInflow: !isBuy ? roundTo(turnover - record.fee, 2) : null,

    stepFrictionCost: record.fee,

    cumulativeProfit: roundTo(state.realizedProfit, 2),
    cumulativeFrictionCost: roundTo(
      state.totalBuyFriction + state.totalSellFriction,
      2,
    ),

    currentCost: roundTo(state.currentCost, 3),
    currentQuantity: state.currentQuantity,

    recordId: record.id,
    timestamp: record.timestamp,
    note: record.note,
  };
}

// ──────────────────────────────────────────────
// 结算卡片构建
// ──────────────────────────────────────────────

function buildLongAutoCloseCard(state: TStateMachineState): TSettlementCard {
  return {
    settlementType: 'long_auto_close',
    label: '[正T 自动结束]',
    labelColor: 'green',
    mode: 'long',

    totalOutflow: roundTo(state.totalBuyTurnover + state.totalBuyFriction, 2),
    totalInflow: roundTo(state.totalSellTurnover - state.totalSellFriction, 2),
    totalFrictionCost: roundTo(state.totalBuyFriction + state.totalSellFriction, 2),
    realizedArbitrageProfit: roundTo(state.realizedProfit, 2),

    updatedBaseCost: roundTo(state.basePosition.cost, 3),
    finalQuantity: state.basePosition.quantity,

    mergeQuantity: null,
    mergeAmount: null,

    steps: [...state.steps],
  };
}

function buildLongMergeCard(
  state: TStateMachineState,
  mergeQuantity: number,
  mergeAmount: number,
  newBaseCost: number,
  newBaseQuantity: number,
): TSettlementCard {
  return {
    settlementType: 'long_merge',
    label: '[正T 归并]',
    labelColor: 'blue',
    mode: 'long',

    totalOutflow: roundTo(state.totalBuyTurnover + state.totalBuyFriction, 2),
    totalInflow: roundTo(state.totalSellTurnover - state.totalSellFriction, 2),
    totalFrictionCost: roundTo(state.totalBuyFriction + state.totalSellFriction, 2),
    realizedArbitrageProfit: roundTo(state.realizedProfit, 2),

    updatedBaseCost: roundTo(newBaseCost, 3),
    finalQuantity: newBaseQuantity,

    mergeQuantity,
    mergeAmount: roundTo(mergeAmount, 2),

    steps: [...state.steps],
  };
}

function buildShortAutoCloseCard(state: TStateMachineState): TSettlementCard {
  return {
    settlementType: 'short_auto_close',
    label: '[倒T 自动结束]',
    labelColor: 'red',
    mode: 'short',

    totalOutflow: roundTo(state.totalBuyTurnover + state.totalBuyFriction, 2),
    totalInflow: roundTo(state.totalSellTurnover - state.totalSellFriction, 2),
    totalFrictionCost: roundTo(state.totalBuyFriction + state.totalSellFriction, 2),
    realizedArbitrageProfit: roundTo(state.realizedProfit, 2),

    updatedBaseCost: roundTo(state.currentCost, 3),
    finalQuantity: state.currentQuantity,

    mergeQuantity: null,
    mergeAmount: null,

    steps: [...state.steps],
  };
}

function buildShortPartialReduceCard(
  state: TStateMachineState,
  reduceQuantity: number,
  reduceAmount: number,
): TSettlementCard {
  return {
    settlementType: 'short_partial_reduce',
    label: '[倒T 部分减持]',
    labelColor: 'purple',
    mode: 'short',

    totalOutflow: roundTo(state.totalBuyTurnover + state.totalBuyFriction, 2),
    totalInflow: roundTo(state.totalSellTurnover - state.totalSellFriction, 2),
    totalFrictionCost: roundTo(state.totalBuyFriction + state.totalSellFriction, 2),
    realizedArbitrageProfit: roundTo(state.realizedProfit, 2),

    updatedBaseCost: roundTo(state.currentCost, 3),
    finalQuantity: state.currentQuantity,

    mergeQuantity: reduceQuantity,
    mergeAmount: roundTo(reduceAmount, 2),

    steps: [...state.steps],
  };
}

function buildShortTransferCard(
  state: TStateMachineState,
  transferQuantity: number,
  transferAmount: number,
): TSettlementCard {
  return {
    settlementType: 'short_transfer',
    label: '[倒T 划转]',
    labelColor: 'orange',
    mode: 'short',

    totalOutflow: roundTo(state.totalBuyTurnover + state.totalBuyFriction, 2),
    totalInflow: roundTo(state.totalSellTurnover - state.totalSellFriction, 2),
    totalFrictionCost: roundTo(state.totalBuyFriction + state.totalSellFriction, 2),
    realizedArbitrageProfit: roundTo(state.realizedProfit, 2),

    updatedBaseCost: roundTo(state.currentCost, 3),
    finalQuantity: state.currentQuantity,

    mergeQuantity: transferQuantity,
    mergeAmount: roundTo(transferAmount, 2),

    steps: [...state.steps],
  };
}

// ──────────────────────────────────────────────
// 正T 执行逻辑
// ──────────────────────────────────────────────

/**
 * 正T 买入（建 T）：仅计算支出，将买入推入 FIFO 队列。
 */
function executeLongBuy(state: TStateMachineState, record: TStreamRecord): TStateMachineState {
  const turnover = new Decimal(record.price).mul(record.amount).toNumber();

  const newState: TStateMachineState = {
    ...state,
    totalBuyQuantity: state.totalBuyQuantity + record.amount,
    totalBuyTurnover: state.totalBuyTurnover + turnover,
    totalBuyFriction: state.totalBuyFriction + record.fee,
    currentQuantity: state.currentQuantity + record.amount,
    // 正T 买入不改变底仓成本，但持有数量增加
    // currentCost 在正T中保持底仓成本不变（买入不影响底仓成本）
    currentCost: state.currentCost,

    // FIFO 队列：按时间顺序追加未平仓买入（保持原始数量/成交额/摩擦）
    pendingBuys: [
      ...(state.pendingBuys ?? []),
      { quantity: record.amount, turnover, friction: record.fee },
    ],

    steps: [
      ...state.steps,
      buildStepNode(
        { ...state, realizedProfit: state.realizedProfit },
        record,
        state.steps.length + 1,
      ),
    ],
  };

  return newState;
}

/**
 * 正T 卖出平仓（真 FIFO）：从最早的未平仓买入逐笔消耗，计算已实现利润。
 *
 * 与旧「加权平均比例法」不同，FIFO 严格按买入时间顺序配对：
 *   已实现套利利润 = 卖出净回款 - Σ(FIFO 匹配买入支出 + 匹配买入摩擦)
 * 部分卖出跨越多笔不同价买入时，先配对最早期买入，成本口径精确到逐笔。
 */
function executeLongSell(
  state: TStateMachineState,
  record: TStreamRecord,
): TStateMachineState {
  const sellQty = record.amount;
  const sellTurnover = new Decimal(record.price).mul(record.amount).toNumber();
  const sellFee = record.fee;

  // 深拷贝 FIFO 队列并按先进先出逐笔消耗
  const buys = (state.pendingBuys ?? []).map((b) => ({ ...b }));
  let toConsume = sellQty;
  let matchedBuyTurnover = 0;
  let matchedBuyFriction = 0;

  for (const b of buys) {
    if (toConsume <= 0) break;
    const consume = Math.min(toConsume, b.quantity);
    // 该笔买入被消耗的比例（用于拆分其成交额/摩擦；剩余部分同步按比例缩减，
    // 确保 remaining 口径的 turnover/friction 精确反映未平仓部分）
    const ratio = consume / b.quantity;
    matchedBuyTurnover += b.turnover * ratio;
    matchedBuyFriction += b.friction * ratio;
    b.quantity -= consume;
    b.turnover -= b.turnover * ratio;
    b.friction -= b.friction * ratio;
    toConsume -= consume;
  }

  // 剩余未平仓买入（FIFO 队列中未被消耗的部分）
  const remainingBuys = buys.filter((b) => b.quantity > 0);

  // 已实现利润 = (卖出回收 - 卖出摩擦) - (FIFO 匹配买入支出 + 匹配买入摩擦)
  const saleProceeds = new Decimal(sellTurnover).minus(sellFee).toNumber();
  const costBasis = new Decimal(matchedBuyTurnover).plus(matchedBuyFriction).toNumber();
  const stepProfit = new Decimal(saleProceeds).minus(costBasis).toNumber();

  const remainingBuyQuantity = remainingBuys.reduce((s, b) => s + b.quantity, 0);
  const remainingBuyTurnover = remainingBuys.reduce((s, b) => s + b.turnover, 0);
  const remainingBuyFriction = remainingBuys.reduce((s, b) => s + b.friction, 0);
  const isFullyClosed = remainingBuyQuantity === 0;

  const steps = [
    ...state.steps,
    buildStepNode(
      {
        ...state,
        realizedProfit: state.realizedProfit + stepProfit,
      },
      record,
      state.steps.length + 1,
    ),
  ];

  let newState: TStateMachineState = {
    ...state,
    totalBuyQuantity: remainingBuyQuantity,
    totalBuyTurnover: remainingBuyTurnover,
    totalBuyFriction: remainingBuyFriction,
    totalSellQuantity: state.totalSellQuantity + sellQty,
    totalSellTurnover: state.totalSellTurnover + sellTurnover,
    totalSellFriction: state.totalSellFriction + sellFee,
    realizedProfit: state.realizedProfit + stepProfit,
    currentQuantity: state.currentQuantity - sellQty,
    pendingBuys: remainingBuys,
    steps,
  };

  // 自动结束
  if (isFullyClosed) {
    newState = {
      ...newState,
      isClosed: true,
      closeReason: 'long_auto_close',
      settlementCard: buildLongAutoCloseCard(newState),
    };
  }

  return newState;
}

// ──────────────────────────────────────────────
// 倒T 执行逻辑
// ──────────────────────────────────────────────

/**
 * 倒T 借仓卖出：卖出底仓产生回收现金，卖出腿推入 FIFO 待回补队列。
 * 按移动平均法，卖出时不改变账面持仓单价成本。
 */
function executeShortSell(
  state: TStateMachineState,
  record: TStreamRecord,
): TStateMachineState {
  const sellQty = record.amount;
  const sellTurnover = new Decimal(record.price).mul(record.amount).toNumber();
  const sellFee = record.fee;

  // 卖出后底仓数量减少，但单价不变（移动平均法）
  const newBaseQuantity = state.basePosition.quantity - sellQty;

  const newState: TStateMachineState = {
    ...state,
    totalSellQuantity: state.totalSellQuantity + sellQty,
    totalSellTurnover: state.totalSellTurnover + sellTurnover,
    totalSellFriction: state.totalSellFriction + sellFee,

    currentQuantity: newBaseQuantity,
    currentCost: state.basePosition.cost,

    basePosition: {
      ...state.basePosition,
      quantity: newBaseQuantity,
    },

    // FIFO 队列：按时间顺序追加未回补卖出；累计借出总量（用于推导 shortPendingAmount）
    pendingSells: [
      ...(state.pendingSells ?? []),
      { quantity: sellQty, turnover: sellTurnover, friction: sellFee },
    ],
    initialShortSellQty: (state.initialShortSellQty ?? 0) + sellQty,

    steps: [
      ...state.steps,
      buildStepNode(
        { ...state, realizedProfit: state.realizedProfit },
        record,
        state.steps.length + 1,
      ),
    ],
  };

  return newState;
}

/**
 * 倒T 回补买入（真 FIFO）：从最早的待回补卖出逐笔消耗，计算已实现利润；
 * 移动加权更新整体持仓成本。超出待回补的部分自动归并到底仓。
 *
 * 新持有成本 = (剩余底仓总成本 + 本次买入纯支出) / (剩余底仓数量 + 本次买入数量)
 * 已实现利润 = Σ(FIFO 匹配卖出净回款) - (匹配买入支出 + 匹配买入摩擦)
 */
function executeShortBuyBack(
  state: TStateMachineState,
  record: TStreamRecord,
): TStateMachineState {
  const buyQty = record.amount;
  const buyTurnover = new Decimal(record.price).mul(record.amount).toNumber();
  const buyFee = record.fee;

  // 深拷贝 FIFO 待回补卖出队列并逐笔消耗
  const sells = (state.pendingSells ?? []).map((s) => ({ ...s }));
  let toConsume = buyQty;
  let matchedSellTurnover = 0;
  let matchedSellFriction = 0;

  for (const s of sells) {
    if (toConsume <= 0) break;
    const consume = Math.min(toConsume, s.quantity);
    // 该笔卖出被回补的比例（用于拆分其回收/摩擦；剩余部分同步按比例缩减，
    // 确保 remaining 口径的 turnover/friction 精确反映未回补部分）
    const ratio = consume / s.quantity;
    matchedSellTurnover += s.turnover * ratio;
    matchedSellFriction += s.friction * ratio;
    s.quantity -= consume;
    s.turnover -= s.turnover * ratio;
    s.friction -= s.friction * ratio;
    toConsume -= consume;
  }

  // 剩余待回补卖出（FIFO 队列中未被回补的部分）
  const remainingSells = sells.filter((s) => s.quantity > 0);

  // 实际对冲量 = 本次买入中用于回补的部分
  const effectiveQty = buyQty - toConsume;
  // 买入端对冲比例 = 实际对冲量 / 本次买入总量（用于拆分买入支出中对冲部分）
  const buyHedgeRatio = buyQty > 0 ? effectiveQty / buyQty : 0;
  const effectiveTurnover = new Decimal(buyTurnover).mul(buyHedgeRatio).toNumber();
  const effectiveFee = new Decimal(buyFee).mul(buyHedgeRatio).toNumber();

  // 纯支出（对冲部分的成交额）
  const pureOutflow = effectiveTurnover;

  // 剩余底仓总成本（P1-1 修复：state.currentQuantity 来自真实底仓数量）
  const remainingBaseTotalCost = new Decimal(state.basePosition.cost).mul(
    state.currentQuantity,
  );

  // 新持有成本 = (剩余底仓总成本 + 对冲部分支出 + 超出部分支出) / (剩余底仓数量 + 买入总数量)
  const newQuantity = state.currentQuantity + buyQty;
  const newTotalCost = remainingBaseTotalCost.plus(buyTurnover);
  const newCost = newQuantity > 0 ? newTotalCost.div(newQuantity).toNumber() : 0;

  // 已实现利润：回补买入时，按 FIFO 匹配确认利润
  // Σ(匹配卖出净回款) - 买入支出(对冲部分) - 买入摩擦(对冲部分)
  const stepProfit = new Decimal(matchedSellTurnover)
    .minus(matchedSellFriction)
    .minus(pureOutflow)
    .minus(effectiveFee)
    .toNumber();

  const remainingSellQuantity = remainingSells.reduce((s, x) => s + x.quantity, 0);
  const remainingSellTurnover = remainingSells.reduce((s, x) => s + x.turnover, 0);
  const remainingSellFriction = remainingSells.reduce((s, x) => s + x.friction, 0);
  const isFullyClosed = remainingSellQuantity === 0;

  const steps = [
    ...state.steps,
    buildStepNode(
      {
        ...state,
        realizedProfit: state.realizedProfit + stepProfit,
      },
      record,
      state.steps.length + 1,
    ),
  ];

  let newState: TStateMachineState = {
    ...state,
    totalBuyQuantity: state.totalBuyQuantity + buyQty,
    totalBuyTurnover: state.totalBuyTurnover + buyTurnover,
    totalBuyFriction: state.totalBuyFriction + buyFee,

    totalSellQuantity: remainingSellQuantity,
    totalSellTurnover: remainingSellTurnover,
    totalSellFriction: remainingSellFriction,

    realizedProfit: state.realizedProfit + stepProfit,

    currentQuantity: newQuantity,
    currentCost: roundTo(newCost, 3),

    basePosition: {
      ...state.basePosition,
      cost: roundTo(newCost, 3),
      quantity: newQuantity,
    },

    pendingSells: remainingSells,
    initialShortSellQty: state.initialShortSellQty,

    steps,
  };

  // 自动结束（完全回补）
  if (isFullyClosed) {
    newState = {
      ...newState,
      isClosed: true,
      closeReason: 'short_auto_close',
      settlementCard: buildShortAutoCloseCard(newState),
    };
  } else {
    // 部分回补后，未补满部分为减持
    // 减持确认：未回补的部分直接确认已实现，已买回部分已锁定新持仓成本
    // 剩下的卖出数量就是减持量
  }

  return newState;
}

// ──────────────────────────────────────────────
// 防御弹窗构建
// ──────────────────────────────────────────────

function buildOverSellDefense(state: TStateMachineState, record: TStreamRecord): TStateMachineState {
  const overSellQty = record.amount - state.totalBuyQuantity;

  return {
    ...state,
    defenseDialog: {
      visible: true,
      type: 'over_sell',
      title: '正T 卖出数量超出累积买入量',
      description: `当前正T累积买入 ${state.totalBuyQuantity} 股，您尝试卖出 ${record.amount} 股，超出 ${overSellQty} 股。请选择处理方式：`,
      options: [
        {
          key: 'auto_hedge',
          label: `选项 A：自动对冲已有正T ${state.totalBuyQuantity} 股并结清`,
          action: 'auto_hedge',
        },
        {
          key: 'hedge_then_start_reverse',
          label: `选项 B：结清正T ${state.totalBuyQuantity} 股，超出 ${overSellQty} 股自动开启倒T`,
          action: 'hedge_then_start_reverse',
        },
        {
          key: 'cancel',
          label: '选项 C：返回修改',
          action: 'cancel',
        },
      ],
      pendingRecord: { ...record },
    },
  };
}

function buildOverBuyDefense(state: TStateMachineState, record: TStreamRecord): TStateMachineState {
  const overBuyQty = record.amount - state.totalSellQuantity;

  return {
    ...state,
    defenseDialog: {
      visible: true,
      type: 'over_buy',
      title: '倒T 买入数量超出借仓卖出量',
      description: `当前倒T借仓卖出 ${state.totalSellQuantity} 股，您尝试买入 ${record.amount} 股，超出 ${overBuyQty} 股。请选择处理方式：`,
      options: [
        {
          key: 'auto_hedge',
          label: `选项 A：自动对冲已借出 ${state.totalSellQuantity} 股并结清`,
          action: 'auto_hedge',
        },
        {
          key: 'hedge_then_start_reverse',
          label: `选项 B：结清倒T ${state.totalSellQuantity} 股，超出 ${overBuyQty} 股自动开启正T`,
          action: 'hedge_then_start_reverse',
        },
        {
          key: 'cancel',
          label: '选项 C：返回修改',
          action: 'cancel',
        },
      ],
      pendingRecord: { ...record },
    },
  };
}

// ──────────────────────────────────────────────
// 主入口：单步推进
// ──────────────────────────────────────────────

/**
 * 单步推进做 T 状态机。
 *
 * @description 根据当前状态机状态与新流水记录，计算下一步状态。
 *              自动处理正T/倒T的模式切换、利润计算、结算归并与超限防御。
 * @param input - 包含当前状态、新流水记录、费率配置与底仓
 * @returns 更新后的状态、是否触发防御弹窗、是否需要归并等信息
 */
export function stepTEngine(input: TEngineStepInput): TEngineStepOutput {
  const { state, record, feeConfig, basePosition } = input;

  // 确保底仓信息同步
  const syncedState: TStateMachineState = {
    ...state,
    basePosition: { ...basePosition },
  };

  // ── 首笔流水：自动确定模式 ──
  if (syncedState.totalBuyQuantity === 0 && syncedState.totalSellQuantity === 0) {
    if (record.direction === 'buy') {
      syncedState.mode = 'long';
    } else {
      syncedState.mode = 'short';
    }
  }

  // ── 根据模式与方向分发 ──
  if (syncedState.mode === 'long') {
    if (record.direction === 'buy') {
      // 正T 买入建仓
      const newState = executeLongBuy(syncedState, record);
      return {
        newState,
        triggeredDefense: false,
        needsMergeToBase: false,
        mergeInfo: null,
      };
    } else {
      // 正T 卖出
      if (isLongOverSell(syncedState, record.amount)) {
        // 触发超卖防御弹窗
        const newState = buildOverSellDefense(syncedState, record);
        return {
          newState,
          triggeredDefense: true,
          needsMergeToBase: false,
          mergeInfo: null,
        };
      }
      // 正常卖出平仓
      const newState = executeLongSell(syncedState, record);
      return {
        newState,
        triggeredDefense: false,
        needsMergeToBase: false,
        mergeInfo: null,
      };
    }
  } else {
    // 倒T 模式
    if (record.direction === 'sell') {
      // 倒T 卖出借仓
      const newState = executeShortSell(syncedState, record);
      return {
        newState,
        triggeredDefense: false,
        needsMergeToBase: false,
        mergeInfo: null,
      };
    } else {
      // 倒T 买入回补（含超买自动处理：超出部分归并到底仓）
      const newState = executeShortBuyBack(syncedState, record);
      return {
        newState,
        triggeredDefense: false,
        needsMergeToBase: false,
        mergeInfo: null,
      };
    }
  }
}

/**
 * 正T 归并底仓：将未平仓的买入持仓按纯成交金额与数量合并到底仓。
 *
 * @description 摩擦成本不重复计算，底仓只吸收纯成交金额与数量进行加权。
 * @param state - 当前状态机状态（正T模式，有未平仓买入）
 * @param basePosition - 当前底仓
 * @returns 归并后的状态、更新后的底仓信息
 */
export function mergeLongToBase(
  state: TStateMachineState,
  basePosition: BasePosition,
): {
  newState: TStateMachineState;
  newBasePosition: BasePosition;
} {
  const mergeQuantity = state.totalBuyQuantity;
  const mergeTurnover = state.totalBuyTurnover;

  if (mergeQuantity <= 0) {
    return {
      newState: { ...state },
      newBasePosition: { ...basePosition },
    };
  }

  // 底仓只吸收纯成交金额与数量进行加权，不重复计算摩擦成本
  const oldBaseTotalCost = new Decimal(basePosition.cost).mul(basePosition.quantity);
  const newBaseQuantity = basePosition.quantity + mergeQuantity;
  const newBaseTotalCost = oldBaseTotalCost.plus(mergeTurnover);
  const newBaseCost = newBaseQuantity > 0
    ? newBaseTotalCost.div(newBaseQuantity).toNumber()
    : 0;

  const newBasePosition: BasePosition = {
    cost: roundTo(newBaseCost, 3),
    quantity: newBaseQuantity,
  };

  const newState: TStateMachineState = {
    ...state,
    totalBuyQuantity: 0,
    totalBuyTurnover: 0,
    totalBuyFriction: 0,
    currentQuantity: newBaseQuantity,
    currentCost: roundTo(newBaseCost, 3),
    basePosition: { ...newBasePosition },
    pendingBuys: [],
    isClosed: true,
    closeReason: 'long_merge',
    settlementCard: buildLongMergeCard(
      state,
      mergeQuantity,
      mergeTurnover,
      newBaseCost,
      newBaseQuantity,
    ),
  };

  return { newState, newBasePosition };
}

/**
 * 倒T 部分减持：未回补部分直接确认减持，已买回部分锁定加权后的新持仓成本。
 *
 * @description 剩余卖出数量对应的就是减持部分，直接确认。
 * @param state - 当前状态机状态（倒T模式，有未回补卖出）
 * @returns 结算后的状态
 */
export function finalizeShortPartialReduce(
  state: TStateMachineState,
): TStateMachineState {
  const reduceQuantity = state.totalSellQuantity;
  const reduceTurnover = state.totalSellTurnover;
  const reduceFriction = state.totalSellFriction;

  // 减持部分已确认利润（在之前的步骤中已按比例计算）
  // 这里只需结算剩余状态

  const newState: TStateMachineState = {
    ...state,
    totalSellQuantity: 0,
    totalSellTurnover: 0,
    totalSellFriction: 0,
    pendingSells: [],
    isClosed: true,
    closeReason: 'short_partial_reduce',
    settlementCard: buildShortPartialReduceCard(
      state,
      reduceQuantity,
      reduceTurnover - reduceFriction,
    ),
  };

  return newState;
}

/**
 * 倒T 划转到底仓。
 *
 * @description 完成对倒T剩余持仓的划转处理，更新底仓。
 */
export function finalizeShortTransfer(
  state: TStateMachineState,
  transferQuantity: number,
  transferAmount: number,
): TStateMachineState {
  const newState: TStateMachineState = {
    ...state,
    totalSellQuantity: 0,
    totalSellTurnover: 0,
    totalSellFriction: 0,
    pendingSells: [],
    isClosed: true,
    closeReason: 'short_transfer',
    settlementCard: buildShortTransferCard(state, transferQuantity, transferAmount),
  };

  return newState;
}

/**
 * 处理正T 超卖防御 - 选项 A：自动对冲已有正T数量并结清
 */
export function resolveOverSellAutoHedge(
  state: TStateMachineState,
): TStateMachineState {
  const pendingRecord = state.defenseDialog?.pendingRecord;
  if (!pendingRecord) return state;

  // 只对冲已有正T买入数量
  const hedgedQty = state.totalBuyQuantity;
  const hedgedRecord: TStreamRecord = {
    ...pendingRecord,
    amount: hedgedQty,
  };

  // 重新计算摩擦成本（使用实际对冲数量）
  // fee 已经在原 record 中按比例对应，这里简化处理
  const ratio = hedgedQty / pendingRecord.amount;
  hedgedRecord.fee = roundTo(pendingRecord.fee * ratio, 2);

  const result = executeLongSell(
    { ...state, defenseDialog: null },
    hedgedRecord,
  );

  return {
    ...result,
    defenseDialog: null,
  };
}

/**
 * 处理正T 超卖防御 - 选项 B：结清正T，超出部分自动开启倒T
 */
export function resolveOverSellHedgeThenReverse(
  state: TStateMachineState,
  feeConfig: FeeConfig,
): TStateMachineState {
  const pendingRecord = state.defenseDialog?.pendingRecord;
  if (!pendingRecord) return state;

  // 对冲已有正T部分
  const hedgedQty = state.totalBuyQuantity;
  const ratio = hedgedQty / pendingRecord.amount;
  const hedgedRecord: TStreamRecord = {
    ...pendingRecord,
    amount: hedgedQty,
    fee: roundTo(pendingRecord.fee * ratio, 2),
  };

  let newState = executeLongSell(
    { ...state, defenseDialog: null },
    hedgedRecord,
  );

  // 超出部分开启倒T
  const overQty = pendingRecord.amount - hedgedQty;
  if (overQty > 0) {
    const overFee = calcTradeFees(pendingRecord.price, overQty, 'sell', feeConfig, matchSecurityKind('', pendingRecord.fullCode.replace(/^sh|sz|bj/, ''))).total;
    const overRecord: TStreamRecord = {
      ...pendingRecord,
      id: pendingRecord.id + '_reverse',
      amount: overQty,
      fee: overFee,
    };

    // 开启倒T模式
    newState = {
      ...newState,
      mode: 'short',
      isClosed: false,
      closeReason: null,
      settlementCard: null,
    };

    newState = executeShortSell(newState, overRecord);
  }

  return newState;
}

/**
 * 处理倒T 超买防御 - 选项 A：自动对冲已借出数量并结清
 */
export function resolveOverBuyAutoHedge(
  state: TStateMachineState,
): TStateMachineState {
  const pendingRecord = state.defenseDialog?.pendingRecord;
  if (!pendingRecord) return state;

  const hedgedQty = state.totalSellQuantity;
  const ratio = hedgedQty / pendingRecord.amount;
  const hedgedRecord: TStreamRecord = {
    ...pendingRecord,
    amount: hedgedQty,
    fee: roundTo(pendingRecord.fee * ratio, 2),
  };

  const result = executeShortBuyBack(
    { ...state, defenseDialog: null },
    hedgedRecord,
  );

  return {
    ...result,
    defenseDialog: null,
  };
}

/**
 * 处理倒T 超买防御 - 选项 B：结清倒T，超出部分自动开启正T
 */
export function resolveOverBuyHedgeThenReverse(
  state: TStateMachineState,
  feeConfig: FeeConfig,
): TStateMachineState {
  const pendingRecord = state.defenseDialog?.pendingRecord;
  if (!pendingRecord) return state;

  const hedgedQty = state.totalSellQuantity;
  const ratio = hedgedQty / pendingRecord.amount;
  const hedgedRecord: TStreamRecord = {
    ...pendingRecord,
    amount: hedgedQty,
    fee: roundTo(pendingRecord.fee * ratio, 2),
  };

  let newState = executeShortBuyBack(
    { ...state, defenseDialog: null },
    hedgedRecord,
  );

  // 超出部分开启正T
  const overQty = pendingRecord.amount - hedgedQty;
  if (overQty > 0) {
    const overFee = calcTradeFees(pendingRecord.price, overQty, 'buy', feeConfig, matchSecurityKind('', pendingRecord.fullCode.replace(/^sh|sz|bj/, ''))).total;
    const overRecord: TStreamRecord = {
      ...pendingRecord,
      id: pendingRecord.id + '_reverse',
      amount: overQty,
      fee: overFee,
    };

    // 开启正T模式
    newState = {
      ...newState,
      mode: 'long',
      isClosed: false,
      closeReason: null,
      settlementCard: null,
    };

    newState = executeLongBuy(newState, overRecord);
  }

  return newState;
}

/**
 * 取消防御弹窗（选项 C：返回修改）
 */
export function cancelDefenseDialog(state: TStateMachineState): TStateMachineState {
  return {
    ...state,
    defenseDialog: null,
  };
}

// Re-export for backward compatibility - the processStockStream and processAllStreams
// These are kept to maintain compatibility with existing store code that references them

/** Process-based stream entry interface */
export interface StreamEntry {
  id: string;
  timestamp: string;
  direction: 'buy' | 'sell';
  price: number;
  amount: number;
  fee: number;
  matchedAmount: number;
  realizedProfit: number;
  remaining: number;
  closed: boolean;
  note?: string;
}

export type StreamStatus = 'PENDING' | 'PARTIAL' | 'CLEARED' | 'SHORT_PENDING';

/** Stream-level result returned by the engine for each stock */
export interface StockStreamResult {
  fullCode: string;
  stockName: string;
  realizedPnL: number;
  realizedFee: number;
  netPendingAmount: number;
  weightedBuyCost: number;
  pendingTotalCost: number;
  shortPendingAmount: number;
  initialShortSellQty?: number;
  mode: 'long' | 'short';
  status: StreamStatus;
  entries: StreamEntry[];
  lastSellRemaining: number;
  lastSellCleared: boolean;
  lastClosedAt?: string;
  roundStarted: boolean;
  openedAt?: string;
  avgPrice: number;
  buyAmount: number;
  buyTotal: number;
  sellAmount: number;
  sellValue: number;
  realizedSellAmount: number;
  realizedSellValue: number;
  totalFee: number;
  transferProfit: number;
  sellCostTotal: number;
  realizedSellCost: number;
  firstSellCostBasis?: number;
  inheritedBaseAmount?: number;
  tradeCount: number;
  holdingDays: number;
}

export interface SellValidation {
  valid: boolean;
  maxSellable: number;
  error?: string;
  missingPosition?: boolean;
  isFirstSell?: boolean;
  /** 借仓对冲提示（仅在需要占用底仓时设置） */
  warning?: string;
}

/**
 * Timestamp comparison helper for sorting stream records.
 */
export function compareByTimestamp(a: string, b: string): number {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta)) return -1;
  if (Number.isNaN(tb)) return 1;
  return ta - tb;
}

// ──────────────────────────────────────────────
// 注意：汇总行中「在途敞口 / 底仓基准」的决策辅助由 UI 直接消费 result 字段；
//       「保本对冲价」为纯计算决策阈值，不参与任何状态机/撮合状态改写。
// ──────────────────────────────────────────────

/**
 * 求成交单价 P，使得该笔对冲交易的「每股净手续费后回款/成本」恰等于目标值。
 * 通过定长迭代逼近费率中的最低佣金硬地板等非线性项。
 *
 * - direction 'sell'：净回款 = P - feeSell(P)/qty，求 P = target + feeSell(P)/qty；
 * - direction 'buy' ：净支出 = P + feeBuy(P)/qty， 求 P = target - feeBuy(P)/qty。
 */
function solveHedgePrice(
  targetPerShare: number,
  qty: number,
  direction: 'buy' | 'sell',
  feeConfig: FeeConfig,
  kind: SecurityKind,
): number {
  let guess = targetPerShare;
  for (let i = 0; i < 50; i++) {
    const feePerShare = calcTradeFees(guess, qty, direction, feeConfig, kind).total / qty;
    const next = direction === 'sell' ? targetPerShare + feePerShare : targetPerShare - feePerShare;
    if (Math.abs(next - guess) < 1e-6) {
      guess = next;
      break;
    }
    guess = next;
  }
  return guess;
}

/**
 * 计算本 Round 的「保本对冲价」决策阈值。
 *
 * @description 对尚未对冲（正T 未平买入 / 倒T 未回补卖出）的剩余数量，反推「对冲时恰不亏本」的成交价门槛：
 *              - 正T（long）  ：剩余为待平买入，须以 ≥ 该价卖出才不亏 → symbol 'gte'；
 *              - 倒T（short） ：剩余为待回补卖出，须以 ≤ 该价买回才不亏 → symbol 'lte'。
 *              数量为 0、缺少费率或基准价非法时返回 null（UI 不展示）。
 * @param result - 撮合结果
 * @param feeConfig - 系统费率配置（可缺省，缺省时不计算）
 * @returns { price, symbol } 或 null
 */
export function calcHedgeBreakeven(
  result: StockStreamResult,
  feeConfig?: FeeConfig,
): { price: number; symbol: 'gte' | 'lte' } | null {
  if (!feeConfig) return null;
  const qty = Math.max(0, result.netPendingAmount);
  if (qty <= 0) return null;
  const kind = matchSecurityKind('', result.fullCode.replace(/^(sh|sz|bj)/, ''));

  if (result.mode === 'long') {
    // 正T：剩余为待平买入，基准 = 加权买入均价 + 该段买入规费，卖出净回款须覆盖之。
    const basisPerShare = result.weightedBuyCost;
    if (basisPerShare <= 0) return null;
    const buyFeePerShare = calcTradeFees(basisPerShare, qty, 'buy', feeConfig, kind).total / qty;
    const targetPerShare = basisPerShare + buyFeePerShare;
    const price = solveHedgePrice(targetPerShare, qty, 'sell', feeConfig, kind);
    return { symbol: 'gte', price: roundTo(price, 3) };
  }

  // 倒T：剩余为待回补卖出，其已保留的净回款 ≈ 平均卖出价扣卖出规费。
  const sellAmount = result.sellAmount > 0 ? result.sellAmount : 1;
  const avgSell = result.sellValue / sellAmount;
  if (avgSell <= 0) return null;
  const sellFeePerShare = calcTradeFees(avgSell, qty, 'sell', feeConfig, kind).total / qty;
  const retainedPerShare = avgSell - sellFeePerShare;
  const price = solveHedgePrice(retainedPerShare, qty, 'buy', feeConfig, kind);
  return { symbol: 'lte', price: roundTo(price, 3) };
}

// ──────────────────────────────────────────────
// Backward-compatible stubs for old engine API
// These keep existing store/UI code compiling while
// the refactored engine is integrated.
// Old signatures from v3 store: processAllStreams(rawStreams, feeConfig, Map<string, number>),
// processStockStream(sorted, feeConfig, number|undefined, skipFifo?, baseCostOverride?),
// validateStreamTrade(StreamResult|null, baseAmount, direction, price, amount, isFirstSell?)
// ──────────────────────────────────────────────

/**
 * Process all streams grouped by stock code using FIFO matching.
 * Core engine function used by the Store for settlement/recalculation.
 *
 * @param rawStreams 该标的的全部做T流水（按 fullCode 分组）
 * @param feeConfig 系统费率配置
 * @param basePositionsMap fullCode -> 真实底仓（成本 + 数量）。数量用于倒T移动加权成本
 *                         与 shortPendingAmount 精确推导；缺失时数量按 0 处理（兼容旧调用）。
 */
export function processAllStreams(
  rawStreams: TStreamRecord[],
  feeConfig: FeeConfig,
  basePositionsMap?: Map<string, BasePosition>,
): StockStreamResult[] {
  // Group by fullCode
  const grouped = new Map<string, TStreamRecord[]>();
  for (const s of rawStreams) {
    if (!s.fullCode) continue;
    const arr = grouped.get(s.fullCode) || [];
    arr.push(s);
    grouped.set(s.fullCode, arr);
  }

  const results: StockStreamResult[] = [];
  for (const [fullCode, streams] of grouped) {
    // Sort by timestamp
    const sorted = [...streams].sort((a, b) => compareByTimestamp(a.timestamp, b.timestamp));
    const base = basePositionsMap?.get(fullCode);
    const run = processStockStream(
      sorted,
      feeConfig,
      base ?? { cost: 0, quantity: 0 },
    );
    results.push(run);
  }
  return results;
}

/**
 * 明细撮合回填：仅影响 entries 的展示字段映射（matchedAmount / remaining），
 * 不改动状态机收益口径（transferProfit / realizedFee / sellCostTotal 等仍由状态机累计）。
 *
 * 与状态机撮合口径完全一致：真 FIFO —— 每一笔「收益实现腿」（正T卖出 / 倒T回补买入）
 * 从最早的未平仓「开仓腿」逐笔消耗（先开仓的先配对，精确到逐笔而非比例摊配）。
 *
 * 收益标签只挂在收益实现腿上（主循环已按该笔步进利润回填 realizedProfit）：
 *   - 正T：卖出腿 = 收益实现腿；买入腿仅回填被对冲消耗的 matchedAmount。
 *   - 倒T：回补买入腿 = 收益实现腿；卖出腿仅回填被回补消耗的 matchedAmount。
 */
function assignEntryMatchMapping(mode: 'long' | 'short', entries: StreamEntry[]): void {
  const isOpening = (e: StreamEntry): boolean =>
    mode === 'long' ? e.direction === 'buy' : e.direction === 'sell';
  const isClosing = (e: StreamEntry): boolean =>
    mode === 'long' ? e.direction === 'sell' : e.direction === 'buy';

  // 未平仓开仓腿池（按时间顺序，FIFO）
  const pool: { amount: number; consumed: number }[] = [];
  const poolEntryIds: string[] = [];

  for (const e of entries) {
    if (isOpening(e)) {
      poolEntryIds.push(e.id);
      pool.push({ amount: e.amount, consumed: 0 });
    } else if (isClosing(e) && e.matchedAmount > 0) {
      // 已撮合的对冲腿：从池头逐笔消耗（与 executeLongSell/executeShortBuyBack 的 FIFO 一致）
      let toConsume = e.matchedAmount;
      for (const p of pool) {
        if (toConsume <= 0) break;
        const available = p.amount - p.consumed;
        if (available <= 0) continue;
        const consume = Math.min(toConsume, available);
        p.consumed += consume;
        toConsume -= consume;
      }
      // 回填该收益实现腿的撮合量 = 实际消耗量（不超过池内剩余），
      // 超出部分（超额买入/卖出）归并到底仓，不计入做T池撮合量
      const effectiveMatch = e.matchedAmount - toConsume;
      e.matchedAmount = effectiveMatch;
      e.remaining = e.amount - effectiveMatch;
    }
  }

  const consumedById = new Map<string, number>();
  pool.forEach((p, i) => consumedById.set(poolEntryIds[i], p.consumed));

  // 回填开仓腿：matchedAmount = 被对冲消耗数量，remaining = 未消耗数量
  for (const e of entries) {
    if (isOpening(e)) {
      const consumed = roundTo(consumedById.get(e.id) ?? 0, 2);
      e.matchedAmount = consumed;
      e.remaining = roundTo(Math.max(0, e.amount - consumed), 2);
    }
  }
}

/**
 * Process a single stock's stream records sequentially.
 * Used by processAllStreams and for individual stock recalculation.
 */
export function processStockStream(
  sorted: TStreamRecord[],
  feeConfig: FeeConfig,
  basePosition?: BasePosition | number,
  _skipFifo?: boolean,
  _baseCostOverride?: number,
): StockStreamResult {
  const fullCode = sorted.length > 0 ? sorted[0].fullCode : '';
  const stockName = sorted.length > 0 ? sorted[0].stockName : '';

  // 兼容旧调用：传 number 时视为仅有底仓成本（数量按 0 处理）
  const base: BasePosition = typeof basePosition === 'number'
    ? { cost: basePosition, quantity: 0 }
    : basePosition ?? { cost: 0, quantity: 0 };
  const baseCostVal = base.cost;

  // Use new engine to compute results
  const stateFrom = createInitialState({ cost: base.cost, quantity: base.quantity });

  let state = stateFrom;
  let mode: 'long' | 'short' = 'long';
  let roundStarted = false;
  let openedAt: string | undefined;

  const entries: StreamEntry[] = [];
  let totalFee = 0;

  for (let i = 0; i < sorted.length; i++) {
    const record = sorted[i];
    if (i === 0) {
      openedAt = record.timestamp;
      roundStarted = true;
      mode = record.direction === 'buy' ? 'long' : 'short';
    }

    // ── 轮次边界隔离 ──
    // 状态机上一轮已完全结算关闭（isClosed=true，即 CLEARED）时，
    // 此流水属于新的一轮：重置状态机与累计口径，防止跨轮流水混入
    // 同一战报。正 T 自动归档后 Round 标记 COMPLETED（流水退出活跃池），重算时
    // 若不做隔离，新一轮首笔流水会在已关闭的 state 上继续推进
    // （executeLongBuy 不重置 isClosed），导致新流水并入上一轮且
    // 状态被误判为再次 CLEARED → 新轮次自动结束并生成错误战报。
    if (state.isClosed) {
      state = createInitialState({ cost: base.cost, quantity: base.quantity });
      state.mode = record.direction === 'buy' ? 'long' : 'short';
      mode = record.direction === 'buy' ? 'long' : 'short';
      roundStarted = true;
      openedAt = record.timestamp;
      // 清空累计口径，使 entries / totalFee / openedAt 等仅反映当前（最后）一轮
      entries.length = 0;
      totalFee = 0;
    }

    totalFee += record.fee;

    // Build entry for old API
    const entry: StreamEntry = {
      id: record.id,
      timestamp: record.timestamp,
      direction: record.direction,
      price: record.price,
      amount: record.amount,
      fee: record.fee,
      matchedAmount: 0,
      realizedProfit: 0,
      remaining: 0,
      closed: false,
      note: record.note,
    };

    // Run through new engine
    const input: TEngineStepInput = {
      state,
      record,
      feeConfig,
      basePosition: { cost: base.cost, quantity: base.quantity },
    };

    const profitBefore = state.realizedProfit;
    const output = stepTEngine(input);
    state = output.newState;

    // If defense was triggered, skip this record (it will be handled by UI)
    if (output.triggeredDefense) {
      entry.matchedAmount = 0;
      entry.remaining = record.amount;
      entries.push(entry);
      continue;
    }

    // Map new state to old entry：
    //   - matchedAmount 先按整笔记录回填（收益实现腿 = 该笔全额撮合）；
    //   - realizedProfit = 该笔流水自身实现的步进收益（开仓腿恒为 0，
    //     收益实现腿 = 卖出净回款 − 匹配买入成本），严禁使用状态机累计值
    //     导致未平仓腿错误显示上一笔收益；
    //   - 开仓腿（正T买入 / 倒T借出）的撮合量将在循环后由
    //     assignEntryMatchMapping 按状态机同一比例消耗口径回填。
    entry.matchedAmount = record.amount;
    entry.realizedProfit = state.realizedProfit - profitBefore;
    entry.remaining = 0;
    entry.closed = state.isClosed;

    entries.push(entry);
  }

  // 明细撮合回填：开仓腿按状态机同一比例消耗口径回填 matchedAmount / remaining
  assignEntryMatchMapping(mode, entries);

  // Compute old-style result from new state
  const buyEntries = entries.filter(e => e.direction === 'buy');
  const sellEntries = entries.filter(e => e.direction === 'sell');

  const buyAmount = buyEntries.reduce((s, e) => s + e.amount, 0);
  const buyTotal = buyEntries.reduce((s, e) => s + e.price * e.amount, 0);
  const sellAmount = sellEntries.reduce((s, e) => s + e.matchedAmount, 0);
  const sellValue = sellEntries.reduce((s, e) => s + e.price * e.matchedAmount, 0);

  const realizedSellAmount = sellEntries.reduce((s, e) => s + e.matchedAmount, 0);
  const realizedSellValue = sellEntries.reduce((s, e) => s + e.price * e.matchedAmount, 0);

  const avgPrice = buyAmount > 0 ? buyTotal / buyAmount : baseCostVal;
  const realizedPnL = state.realizedProfit;

  // ── 已实现规费（realizedFee）：严格仅计入已平仓（已对冲）Pair 对应的买卖规费，
  //    绝不把尚未平仓买入/卖出的规费提前计入 ──
  //  - 正T（long）：卖出全部用于平仓 → 卖出规费全部已实现（state.totalSellFriction）；
  //                买入规费已实现部分 = 本轮累积买入规费 - 剩余未平仓买入规费。
  //  - 倒T（short）：买入全部用于回补 → 买入规费全部已实现（state.totalBuyFriction）；
  //                 卖出规费已实现部分 = 本轮累积卖出规费 - 剩余未回补卖出规费。
  const buyFeesTotal = buyEntries.reduce((s, e) => s + e.fee, 0);
  const sellFeesTotal = sellEntries.reduce((s, e) => s + e.fee, 0);
  const realizedFee =
    mode === 'long'
      ? buyFeesTotal - state.totalBuyFriction + state.totalSellFriction
      : state.totalBuyFriction + (sellFeesTotal - state.totalSellFriction);

  // ── 剩余待处理数量语义（统一为「本模式待办」）：
  //   - 正T（long）：netPendingAmount = 本轮总买入 - 已对冲卖出（未平仓买入量），恒非负；
  //   - 倒T（short）：netPendingAmount = 未回补卖出量（= shortPendingAmount），恒非负。
  //     修复 P0-1/P1-2：旧实现用 totalSellQuantity - totalBuyQuantity 推导 shortPendingAmount，
  //     但 totalSellQuantity 在回补时被消耗，量纲不一致导致恒为 0；改用原始流水量差推导，
  //     UI 无需再 Math.max(0, ...) 打补丁。
  const rawSellTotal = sellEntries.reduce((s, e) => s + e.amount, 0);
  const rawBuyTotal = buyEntries.reduce((s, e) => s + e.amount, 0);
  const shortPendingAmount = mode === 'short'
    ? Math.max(0, rawSellTotal - rawBuyTotal)
    : 0;
  const netPendingAmount = mode === 'long'
    ? (state.isClosed ? 0 : Math.max(0, rawBuyTotal - rawSellTotal))
    : shortPendingAmount;

  // 待处理持仓加权成本：
  //   - 正T：剩余未平仓买入的加权均价（totalBuyTurnover / totalBuyQuantity，池内未消耗部分）；
  //   - 倒T：移动加权后的整体持仓成本（currentCost，P1-1 修复后来自真实底仓数量）。
  const weightedBuyCost = mode === 'long'
    ? (state.totalBuyQuantity > 0 ? state.totalBuyTurnover / state.totalBuyQuantity : baseCostVal)
    : state.currentCost;
  const pendingTotalCost = mode === 'long' ? state.totalBuyTurnover : state.totalSellTurnover;

  const lastSellEntry = sellEntries.length > 0 ? sellEntries[sellEntries.length - 1] : null;
  const lastSellCleared = lastSellEntry ? lastSellEntry.closed : false;

  // 正 T 战报净收益：采用状态机 FIFO 配对累计净收益（卖出净回款 - 匹配买入总支出），
  // 严格仅与本次 Round 内先买入流水配对，严禁引入中长期底仓成本 P_base。
  // 倒 T 波段收益同样由状态机累计（首笔借出以实际卖出净回款为基准，P_base 仅用于结算定值）。
  const transferProfit = state.realizedProfit;
  // 卖出对冲成本 = 卖出净回款(含匹配买入总支出) - 波段净收益，供 UI 分解展示
  const sellCostTotal = sellValue - state.totalSellFriction - transferProfit;
  const realizedSellCost = sellCostTotal;

  // ── 状态精确判定（P2-2）──
  //  CLEARED        = 本轮已完全结清；
  //  正T：PARTIAL   = 已发生卖出但仍有未平仓买入；PENDING = 仅买入未卖出；
  //  倒T：PARTIAL   = 已发生回补买入但仍有未回补卖出；SHORT_PENDING = 仅卖出未买入回补。
  const deriveStatus = (): StreamStatus => {
    if (state.isClosed) return 'CLEARED';
    if (mode === 'long') return rawSellTotal > 0 ? 'PARTIAL' : 'PENDING';
    return rawBuyTotal > 0 ? 'PARTIAL' : 'SHORT_PENDING';
  };

  return {
    fullCode,
    stockName,
    realizedPnL,
    realizedFee,
    netPendingAmount,
    weightedBuyCost,
    pendingTotalCost,
    shortPendingAmount,
    initialShortSellQty: state.initialShortSellQty,
    mode,
    status: deriveStatus(),
    entries,
    lastSellRemaining: lastSellEntry ? lastSellEntry.remaining : 0,
    lastSellCleared,
    lastClosedAt: state.isClosed ? entries[entries.length - 1]?.timestamp : undefined,
    roundStarted,
    openedAt,
    avgPrice,
    buyAmount,
    buyTotal,
    sellAmount,
    sellValue,
    realizedSellAmount,
    realizedSellValue,
    totalFee,
    transferProfit,
    sellCostTotal,
    realizedSellCost,
    tradeCount: entries.length,
    holdingDays: 0,
  };
}

/**
 * Trade validation: checks if a trade order is valid given the base position.
 * - BUY: no position cap check (允许无底仓直接买入)
 * - SELL: validates sellAmount <= positionAmount (仅卖出时校验持仓上限)
 * Used by both Store and UI for pre-trade validation.
 */
export function validateStreamTrade(
  _stream: StockStreamResult | null,
  baseAmount: number,
  direction: string,
  _price: number,
  amount: number,
  _isFirstSell?: boolean,
): SellValidation {
  if (amount <= 0) {
    return {
      valid: false,
      maxSellable: 0,
      error: '请输入有效的数量',
      isFirstSell: _isFirstSell ?? false,
    };
  }
  // 买入跳过持仓数量上限校验，允许无底仓直接提交
  if (direction === 'buy') {
    return {
      valid: true,
      maxSellable: 999999999,
      isFirstSell: false,
    };
  }
  // 卖出校验：数量不可超出持仓
  if (amount > baseAmount) {
    return {
      valid: false,
      maxSellable: baseAmount,
      error: `卖出数量(${amount}股)超出持仓(${baseAmount}股)`,
      missingPosition: baseAmount <= 0,
      isFirstSell: _isFirstSell ?? false,
    };
  }
  return {
    valid: true,
    maxSellable: baseAmount,
    isFirstSell: _isFirstSell ?? false,
  };
}

// ──────────────────────────────────────────────
// Round/Position 聚合辅助（自 store/utils.ts 下沉：utils 层消费方
//（如 Copilot 快照重建）直接从本模块导入，store/utils re-export 保持既有路径兼容）
// ──────────────────────────────────────────────

/**
 * 从持仓/成本摊薄账本构建 全Code -> 真实底仓（成本 + 数量）映射，
 * 供引擎在倒T首笔卖出时继承该均价作为对冲成本基准（P_base），
 * 并以真实底仓数量驱动移动加权成本与 shortPendingAmount 精确推导。
 */
export function buildBasePositionCosts(positions: Position[]): Map<string, { cost: number; quantity: number }> {
  const map = new Map<string, { cost: number; quantity: number }>();
  for (const pos of positions) {
    if (pos.isClosed) continue;
    const open = pos.batches.some((b) => b.type === 'open' || b.amount > 0);
    if (!open) continue;
    map.set(pos.fullCode, { cost: pos.currentCost, quantity: pos.currentAmount });
  }
  return map;
}

/**
 * 从 Round 库派生「活跃流水池」：仅 OPENED Round 的 transactions 参与撮合。
 *
 * @description v8 核心派生函数 —— tStreams 不再独立存在，流水全部归属于 Round：
 *  - OPENED Round 的 transactions 即进行中做T项目的全部单边流水；
 *  - COMPLETED Round 的流水是归档明细，退出活跃池（防重复归档/跨轮污染）。
 * @param rounds 全量 Round 库（OPENED + COMPLETED）
 * @returns 引擎所需的 TStreamRecord[]（方向归一化为 buy/sell）
 */
export function activeStreamsFromRounds(rounds: TRoundArchive[]): TStreamRecord[] {
  const streams: TStreamRecord[] = [];
  for (const r of rounds) {
    if ((r.status ?? 'OPENED') === 'COMPLETED') continue;
    const stockName = r.stockName || r.fullCode;
    for (const t of r.transactions ?? []) {
      const rawDir = String(t.direction);
      if (rawDir === 'merge' || rawDir === 'transfer') continue;
      streams.push({
        id: t.id,
        timestamp: t.timestamp,
        fullCode: r.fullCode,
        stockName,
        direction: rawDir as 'buy' | 'sell',
        price: t.price,
        amount: t.amount,
        fee: t.fee,
        note: t.note,
        quoteId: t.quoteId,
        selectedStock: t.selectedStock,
      });
    }
  }
  return streams;
}
