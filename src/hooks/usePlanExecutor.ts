/**
 * @file usePlanExecutor.ts
 * @description 计划单执行链路唯一实现（原在首页/AI 选股台/短线/中长期四处各写一份）：
 *              按 order.context 分流 —— 短线记流水（addStreamRecord）、中长期记批次
 *              （addBatch + calcBatchExecution）、both 两者都记，最后统一 markPlanExecuted。
 *              提示方式由调用方决定（silent 静默 + 返回结果对象，供页面自带 Toast / 履约审计）。
 * @layer Hooks
 * @storage_impact 经 store ordersSlice / positions 落库；本 hook 不直连 db。
 * @author 开发团队
 */

import { useCallback, useRef } from 'react';
import { useAppStore } from '../store';
import { generateId, calcBatchExecution } from '../store/utils';
import { roundTo, calcTradeFees, matchSecurityKind } from '../utils/mathUtils';
import { showToast } from '../utils/toast';
import type { PlannedOrder, Position, PositionBatch, StreamAddResult } from '../store/types';
import type { TStreamRecord } from '../utils/tStreamEngine';

/** 中长期执行结果（供履约审计 / 页面副作用使用） */
export interface PlanLongLeg {
  position: Position;
  type: 'add' | 'reduce';
  batch: PositionBatch;
  calc: ReturnType<typeof calcBatchExecution>;
}

/** 一次执行的完整结果载荷 */
export interface PlanExecutePayload {
  order: PlannedOrder;
  actualPrice: number;
  actualAmount: number;
  note?: string;
  executedAt: string;
  /** 短线腿结果（context 含 short-term 时） */
  short?: StreamAddResult;
  /** 中长期腿结果（context 含 long-term 且有持仓时） */
  long?: PlanLongLeg;
}

/** 执行结果：ok=false 时不落任何账，reason 供调用方提示 */
export interface PlanExecuteResult {
  ok: boolean;
  reason?: string;
  payload?: PlanExecutePayload;
}

export interface UsePlanExecutorOptions {
  /** 静默模式：不弹全局 Toast（页面自带提示 UI 时使用，如短线页的本地 Toast） */
  silent?: boolean;
  /** 中长期腿必须有持仓，否则整单失败（中长期页语义：无底仓不允许执行） */
  requirePosition?: boolean;
  /** 执行成功后的页面特有副作用（履约审计等） */
  onExecuted?: (payload: PlanExecutePayload) => void;
}

/**
 * 计划单执行器 Hook。
 *
 * @description 读 store 最新态执行（positions/feeConfig 现场取，禁闭包捕获过期渲染态）；
 *              失败路径一律「零落账 + 返回 reason」，由调用方决定提示方式。
 * @param {UsePlanExecutorOptions} [options] - 静默/必须持仓/成功回调
 * @returns {(order, actualPrice, actualAmount, note) => PlanExecuteResult} 执行函数
 */
export function usePlanExecutor(options: UsePlanExecutorOptions = {}): (
  order: PlannedOrder,
  actualPrice: number,
  actualAmount: number,
  note: string,
) => PlanExecuteResult {
  const addBatch = useAppStore((s) => s.addBatch);
  const addStreamRecord = useAppStore((s) => s.addStreamRecord);
  const markPlanExecuted = useAppStore((s) => s.markPlanExecuted);

  // options 每次渲染刷新但引用稳定，避免执行函数依赖抖动（页面常把新对象字面量传入）
  const optionsRef = useRef(options);
  optionsRef.current = options;

  return useCallback(
    (order: PlannedOrder, actualPrice: number, actualAmount: number, note: string): PlanExecuteResult => {
      const { silent = false, requirePosition = false, onExecuted } = optionsRef.current;
      // 命令式取值：执行时刻的最新态（渲染态可能已过期）
      const { positions, feeConfig } = useAppStore.getState();
      const executedAt = new Date().toISOString();
      const payload: PlanExecutePayload = { order, actualPrice, actualAmount, note: note || undefined, executedAt };

      const isShort = order.context === 'short-term' || order.context === 'both';
      const isLong = order.context === 'long-term' || order.context === 'both';

      // -- 短线腿：写流水（addStreamRecord 内含风控/防重校验，rejected 即零落账） --
      if (isShort) {
        const txnFee = calcTradeFees(
          actualPrice,
          actualAmount,
          order.direction,
          feeConfig,
          matchSecurityKind('', order.fullCode.replace(/^sh|sz|bj/, '')),
        );
        const record: TStreamRecord = {
          id: generateId(),
          timestamp: executedAt,
          fullCode: order.fullCode,
          stockName: order.stockName,
          direction: order.direction,
          price: actualPrice,
          amount: actualAmount,
          fee: roundTo(txnFee.total, 2),
          note: note || undefined,
        };
        const streamResult = addStreamRecord(record);
        if (streamResult?.rejected) {
          return { ok: false, reason: `🛑 ${streamResult.rejectedReason ?? '校验未通过'}` };
        }
        payload.short = streamResult;
      }

      // -- 中长期腿：写持仓批次 --
      if (isLong) {
        const pos = positions.find((p) => p.fullCode === order.fullCode && !p.isClosed);
        if (!pos) {
          if (requirePosition || order.context === 'long-term') {
            return { ok: false, reason: '❌ 未找到对应持仓，请先建仓' };
          }
          // both 且无底仓：跳过中长期腿，短线结果照常入账（首页/选股台兼容语义）
        } else {
          const type = order.direction === 'buy' ? 'add' : 'reduce';
          const calc = calcBatchExecution(pos, type, actualPrice, actualAmount, feeConfig);
          const batch: PositionBatch = {
            id: generateId(),
            timestamp: executedAt,
            type,
            price: actualPrice,
            amount: type === 'add' ? actualAmount : -actualAmount,
            costAfter: calc.newCost,
            amountAfter: calc.newAmount,
            note: note || undefined,
            fee: calc.totalFee,
          };
          addBatch(pos.id, batch, {
            currentCost: calc.newCost,
            currentAmount: calc.newAmount,
            realizedPnL: calc.newRealizedPnL,
            totalInvested: calc.newTotalInvested,
          });
          payload.long = { position: pos, type, batch, calc };
        }
      }

      const isAchieved =
        order.direction === 'buy' ? actualPrice <= order.plannedPrice : actualPrice >= order.plannedPrice;
      markPlanExecuted(order.id, {
        executedAt,
        actualPrice,
        actualAmount,
        note: note || undefined,
        isAchieved,
        newCost: payload.long?.calc.newCost,
        newAmount: payload.long?.calc.newAmount,
        newTotalInvested: payload.long?.calc.newTotalInvested,
        totalFee: payload.long?.calc.totalFee,
        avgPrice: payload.short?.avgPrice,
        netProfit: payload.short?.netProfit,
      });

      onExecuted?.(payload);
      if (!silent) showToast(`✅ 计划单已执行 · ${order.stockName}`);
      return { ok: true, payload };
    },
    [addBatch, addStreamRecord, markPlanExecuted],
  );
}
