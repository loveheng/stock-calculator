/**
 * @file tStreamEngine.ts
 * @description 短线 T+0 套利计算引擎：正T（先买后卖）与倒T（先卖后买）的状态机、
 *              步骤推进、结算归并与超限防御逻辑。所有计算均为纯函数，摩擦成本
 *              统一通过系统费率配置（FeeConfig）动态计算。
 * @layer Utility
 * @storage_impact 纯计算引擎，不读写任何存储；由 Store 层驱动并持久化。
 */

import Decimal from 'decimal.js';
import { calcTradeFees, roundTo, matchSecurityKind, type FeeConfig } from './mathUtils';
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
 * 正T 买入（建 T）：仅计算支出，更新累积持有。
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
 * 正T 卖出平仓：匹配累积买入数量，计算已实现利润。
 * 摩擦成本全部计入做T本身的成本，按比例分摊。
 *
 * 利润公式：
 * 已实现套利利润 = 总回收 - 总支出 - 总摩擦成本
 * 其中支出与回收按匹配比例计算。
 */
function executeLongSell(
  state: TStateMachineState,
  record: TStreamRecord,
): TStateMachineState {
  const sellQty = record.amount;
  const sellTurnover = new Decimal(record.price).mul(record.amount).toNumber();
  const sellFee = record.fee;

  // 按比例计算匹配部分的买出支出与买入摩擦
  const matchRatio = new Decimal(sellQty).div(state.totalBuyQuantity);
  const matchedBuyTurnover = matchRatio.mul(state.totalBuyTurnover).toNumber();
  const matchedBuyFriction = matchRatio.mul(state.totalBuyFriction).toNumber();

  // 已实现利润 = (卖出回收 - 卖出摩擦) - (匹配买入支出 + 匹配买入摩擦)
  const saleProceeds = new Decimal(sellTurnover).minus(sellFee).toNumber();
  const costBasis = new Decimal(matchedBuyTurnover).plus(matchedBuyFriction).toNumber();
  const stepProfit = new Decimal(saleProceeds).minus(costBasis).toNumber();

  const isFullyClosed = state.totalBuyQuantity === sellQty;
  const remainingBuyQuantity = state.totalBuyQuantity - sellQty;
  const remainingBuyTurnover = new Decimal(state.totalBuyTurnover).minus(matchedBuyTurnover).toNumber();
  const remainingBuyFriction = new Decimal(state.totalBuyFriction).minus(matchedBuyFriction).toNumber();

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
 * 倒T 借仓卖出：卖出底仓产生回收现金。
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
 * 倒T 回补买入：移动加权更新整体持仓成本。
 * 新持有成本 = (剩余底仓总成本 + 本次买入纯支出) / (剩余底仓数量 + 本次买入数量)
 *
 * 纯支出 = turnover + fee（不含卖出摩擦，摩擦成本已计入做T本身）
 */
function executeShortBuyBack(
  state: TStateMachineState,
  record: TStreamRecord,
): TStateMachineState {
  const buyQty = record.amount;
  const buyTurnover = new Decimal(record.price).mul(record.amount).toNumber();
  const buyFee = record.fee;

  // 纯支出（不含摩擦那部分单独跟踪，摩擦成本只计入做T总摩擦）
  const pureOutflow = buyTurnover;

  // 剩余底仓总成本
  const remainingBaseTotalCost = new Decimal(state.basePosition.cost).mul(
    state.currentQuantity,
  );

  // 新持有成本 = (剩余底仓总成本 + 纯支出) / (剩余底仓数量 + 买入数量)
  const newQuantity = state.currentQuantity + buyQty;
  const newTotalCost = remainingBaseTotalCost.plus(pureOutflow);
  const newCost = newQuantity > 0 ? newTotalCost.div(newQuantity).toNumber() : 0;

  // 已实现利润：回补买入时，按比例确认利润
  // 卖出回收(按比例) - 卖出摩擦(按比例) - 买入支出(按比例) - 买入摩擦(按比例)
  const matchRatio = new Decimal(buyQty).div(state.totalSellQuantity);
  const matchedSellTurnover = matchRatio.mul(state.totalSellTurnover).toNumber();
  const matchedSellFriction = matchRatio.mul(state.totalSellFriction).toNumber();
  const stepProfit = new Decimal(matchedSellTurnover)
    .minus(matchedSellFriction)
    .minus(pureOutflow)
    .minus(buyFee)
    .toNumber();

  const isFullyClosed = buyQty === state.totalSellQuantity;
  const remainingSellQuantity = state.totalSellQuantity - buyQty;
  const remainingSellTurnover = new Decimal(state.totalSellTurnover)
    .minus(matchedSellTurnover)
    .toNumber();
  const remainingSellFriction = new Decimal(state.totalSellFriction)
    .minus(matchedSellFriction)
    .toNumber();

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
      // 倒T 买入回补
      if (isShortOverBuy(syncedState, record.amount)) {
        // 触发超买防御弹窗
        const newState = buildOverBuyDefense(syncedState, record);
        return {
          newState,
          triggeredDefense: true,
          needsMergeToBase: false,
          mergeInfo: null,
        };
      }
      // 正常买入回补
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
 */
export function processAllStreams(
  rawStreams: TStreamRecord[],
  feeConfig: FeeConfig,
  baseCostsMap?: Map<string, number>,
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
    const baseCostVal = baseCostsMap?.get(fullCode);
    const run = processStockStream(
      sorted,
      feeConfig,
      baseCostVal ?? 0,
    );
    results.push(run);
  }
  return results;
}

/**
 * Process a single stock's stream records sequentially.
 * Used by processAllStreams and for individual stock recalculation.
 */
export function processStockStream(
  sorted: TStreamRecord[],
  feeConfig: FeeConfig,
  baseCost?: number,
  _skipFifo?: boolean,
  _baseCostOverride?: number,
): StockStreamResult {
  const fullCode = sorted.length > 0 ? sorted[0].fullCode : '';
  const stockName = sorted.length > 0 ? sorted[0].stockName : '';

  const baseCostVal = baseCost ?? 0;

  // Use new engine to compute results
  const stateFrom = createInitialState({ cost: baseCostVal, quantity: 0 });

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
      basePosition: { cost: baseCostVal, quantity: 0 },
    };

    const output = stepTEngine(input);
    state = output.newState;

    // If defense was triggered, skip this record (it will be handled by UI)
    if (output.triggeredDefense) {
      entry.matchedAmount = 0;
      entry.remaining = record.amount;
      entries.push(entry);
      continue;
    }

    // Map new state to old entry
    entry.matchedAmount = record.amount;
    entry.realizedProfit = state.realizedProfit;
    entry.remaining = 0;
    entry.closed = state.isClosed;

    entries.push(entry);
  }

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
  const realizedFee = totalFee;
  const netPendingAmount = state.totalBuyQuantity - state.totalSellQuantity;
  const weightedBuyCost = state.currentCost;
  const pendingTotalCost = state.totalBuyTurnover;
  const shortPendingAmount = state.totalSellQuantity - state.totalBuyQuantity;

  const lastSellEntry = sellEntries.length > 0 ? sellEntries[sellEntries.length - 1] : null;
  const lastSellCleared = lastSellEntry ? lastSellEntry.closed : false;

  // Transfer profit for short-mode archiving
  const sellCostTotal = sellAmount * weightedBuyCost;
  const realizedSellCost = 0;
  const transferProfit = sellValue - sellAmount * weightedBuyCost - totalFee;

  return {
    fullCode,
    stockName,
    realizedPnL,
    realizedFee,
    netPendingAmount,
    weightedBuyCost,
    pendingTotalCost,
    shortPendingAmount,
    mode,
    status: state.isClosed ? 'CLEARED' : (state.totalBuyQuantity > state.totalSellQuantity ? 'PARTIAL' : 'PENDING'),
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
 * Sell validation: checks if a sell order is valid given the base position.
 * Used by both Store and UI for pre-trade validation.
 */
export function validateStreamTrade(
  _stream: StockStreamResult | null,
  baseAmount: number,
  _direction: string,
  _price: number,
  amount: number,
  _isFirstSell?: boolean,
): SellValidation {
  if (amount <= 0) {
    return {
      valid: false,
      maxSellable: 0,
      error: '请输入有效的卖出数量',
      isFirstSell: _isFirstSell ?? false,
    };
  }
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
