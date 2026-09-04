/**
 * @file roundsSlice.ts
 * @description Store Round 切片：战报删除（removeRound）、划转底仓（transferToPosition）、
 *              倒T结算（settleShortRound）。从 store/index.ts 拆出，index 只负责组装。
 * @layer Store (Slice)
 * @storage_impact 经 safePersist 写 tRounds / tTransactions / positions / longTermRecords 表，
 *              并通过 positionAdjustmentPort.rollbackRound 回滚调整登记。
 * @author 开发团队
 */

import type { StateCreator } from 'zustand';
import { processAllStreams, processStockStream } from '../../utils/tStreamEngine';
import {
  buildBasePositionCosts,
  activeStreamsFromRounds,
  generateId,
  formatTradeNo,
} from '../utils';
import { calcTradeFees, matchSecurityKind } from '../../utils/mathUtils';
import { recomputePositionSnapshot } from '../../utils/calculator';
import { positionAdjustmentPort } from '../../services/positionAdjustmentPort';
import {
  deleteTRoundWithTransactions,
  completeRoundWithMerge,
  completeRoundClear,
  putLongTermRecord,
} from '../../db/index';
import { safePersist } from '../persistence';
import { reconcilePositionsWithStreams, persistPositionDiffs } from '../reconcile';
import type { AppStore } from '../types';
import type { PositionBatch, TRoundArchive, LongTermRecord } from '../types';

/** 自动调整批次的备注前缀（用于识别/剥离倒T超额买回归并批次） */
const STREAM_MERGE_NOTE_PREFIX = '倒T超额归并';
const STREAM_BORROW_NOTE_PREFIX = '倒T出借';

/**
 * 判断是否为流水驱动的自动调整批次（出借/归并）。
 * 优先通过 kind 字段，兼容存量 note 前缀。
 */
function isStreamAdjustmentBatch(b: PositionBatch): boolean {
  if (b.kind === 'borrow' || b.kind === 'merge') return true;
  return !!b.note && (b.note.startsWith(STREAM_MERGE_NOTE_PREFIX) || b.note.startsWith(STREAM_BORROW_NOTE_PREFIX));
}

export type RoundsSlice = Pick<
  AppStore,
  'removeRound' | 'transferToPosition' | 'settleShortRound'
>;

export const createRoundsSlice: StateCreator<AppStore, [], [], RoundsSlice> = (set, get) => ({

  removeRound: (id) => {
    const state = get(); const round = state.tRounds.find(r => r.id === id);
    if (!round) return { ok: false, message: '战报不存在或已被删除' };
    const nextRounds = state.tRounds.filter(r => r.id !== id);
    const { feeConfig, positions } = state;
    // 全量对账：剥离该 round 的调整批次（round 已不在 rounds 中 → 批次不受保护 → 被剥离）
    // 同时 activeStreams 仅包含 OPENED 轮次的流水，COMPLETED 轮次的流水不会再生效
    const activeStreams = activeStreamsFromRounds(nextRounds);
    const { positions: finalPositions } = reconcilePositionsWithStreams(positions, activeStreams, feeConfig, nextRounds);
    set({
      tRounds: nextRounds,
      positions: finalPositions,
      longTermRecords: state.longTermRecords.filter(r => r.sourceReportId !== id && r.id !== id),
    });
    safePersist(async () => {
      // 通过 positionAdjustmentPort 回滚底仓变更（若该 round 在 positionAdjustments 中有登记）
      await positionAdjustmentPort.rollbackRound(id, { capacityConflict: 'truncate' }).catch(() => {});
      // 持久化对账后的底仓差异（reconcilePositionsWithStreams 已剥离该 round 的调整批次）
      await persistPositionDiffs(positions, finalPositions);
    });
    // 该标的已无 OPENED Round（项目实体被删）→ 级联清理按标的 Copilot 会话（P2 #13）
    const hasOpenRound = nextRounds.some(
      (r) => r.fullCode === round.fullCode && (r.status ?? 'OPENED') !== 'COMPLETED',
    );
    if (round.fullCode && !hasOpenRound) {
      void get().purgeScopeOnEntityDelete(`t_calculator:${round.fullCode}`);
    }
    return { ok: true };
  },

  transferToPosition: (fullCode, transferAmount, transferPrice) => {
    const { tRounds, positions, feeConfig } = get();
    const baseCosts = buildBasePositionCosts(positions);
    const streams = activeStreamsFromRounds(tRounds).filter(s => s.fullCode === fullCode);
    if (streams.length === 0) return { ok: false, message: '该股票没有做T流水，无法划转' };
    const result = processAllStreams(streams, feeConfig, baseCosts).find(r => r.fullCode === fullCode);
    const stream = result ?? processStockStream(streams, feeConfig, baseCosts.get(fullCode));
    // 倒T（short）模式下 netPendingAmount = shortPendingAmount（未回补卖出量），
    // 不是可划转的买入持仓，不允许划转，必须走 settleShortRound
    if (stream.mode === 'short') {
      return { ok: false, message: '倒T模式不支持划转底仓，请使用「结算倒T」' };
    }
    const pending = stream.netPendingAmount;
    const avg = transferPrice && transferPrice > 0 ? transferPrice : stream.avgPrice;
    const toTransfer = transferAmount && transferAmount > 0 ? Math.min(transferAmount, pending) : pending;
    if (toTransfer <= 0) return { ok: false, message: '当前做T项目持仓已归零，无需划转' };
    const now = new Date().toISOString();
    const kind = matchSecurityKind('', fullCode.replace(/^sh|sz|bj/, ''));
    const txnFee = calcTradeFees(avg, toTransfer, 'buy', feeConfig, kind).total;
    let newPositions = positions; let created = false;
    let pos = positions.find(p => p.fullCode === fullCode && !p.isClosed);
    if (!pos) { pos = { id: generateId(), stockName: stream.stockName, fullCode, currentCost: 0, currentAmount: 0, batches: [], isClosed: false, createdAt: now, openAt: now, realizedPnL: 0, totalInvested: 0 }; created = true; }
    const posDef = pos; const addQty = toTransfer;
    // 剥离流水驱动的调整批次（出借/归并），以真实底仓基线计算划转
    const cleanBatches = posDef.batches.filter(b => !isStreamAdjustmentBatch(b));
    const cleanSnap = recomputePositionSnapshot(cleanBatches);
    const totalBefore = cleanSnap.currentAmount;
    const investedBefore = cleanSnap.totalInvested;
    const addInvested = avg * addQty + txnFee; const newAmount = totalBefore + addQty;
    const newInvested = investedBefore + addInvested; const newCost = newAmount > 0 ? newInvested / newAmount : 0;
    // 预先查找 OPENED Round，获取 roundId 用于批次关联（删除战报时可回滚划转批次）
    const openRound = tRounds.find(r => r.fullCode === fullCode && (r.status ?? 'OPENED') !== 'COMPLETED');
    const roundId = openRound?.id ?? generateId();
    const batch: PositionBatch = { id: generateId(), timestamp: now, type: 'add', price: avg, amount: addQty, costAfter: newCost, amountAfter: newAmount, note: `做T划转底仓（P_avg=${avg}）`, fee: txnFee, sourceRoundId: roundId };
    if (created) {
      const ob: PositionBatch = { id: generateId(), timestamp: now, type: 'open', price: avg, amount: addQty, costAfter: newCost, amountAfter: newAmount, note: `做T划转新建底仓（P_avg=${avg}）`, fee: txnFee, sourceRoundId: roundId };
      newPositions = [...newPositions, { ...posDef, currentCost: newCost, currentAmount: newAmount, totalInvested: newInvested, batches: [ob] }];
    } else {
      newPositions = newPositions.map(p => p.id === posDef.id ? { ...p, currentCost: newCost, currentAmount: newAmount, totalInvested: newInvested, batches: [...cleanBatches, batch] } : p);
    }
    // v8：复用已有 OPENED Round 结清（不再新建），流水保持完整
    const round: TRoundArchive = openRound
      ? {
          ...openRound,
          settleType: 'partial',
          status: 'COMPLETED',
          netProfit: stream.transferProfit,
          totalFees: stream.totalFee,
          fees: stream.totalFee,
          sellAmount: stream.realizedSellAmount,
          avgPrice: stream.avgPrice,
          buyAmount: stream.buyAmount,
          tradeCount: stream.tradeCount,
          holdingDays: stream.holdingDays,
          win: stream.transferProfit >= 0,
          transferAmount: toTransfer,
          closedAt: now,
          lastTouched: now,
          lastUpdated: Date.now(),
        }
      : { id: roundId, fullCode, stockName: stream.stockName, mode: stream.mode, status: 'COMPLETED', roundCode: formatTradeNo(now), settleType: 'partial', transactions: stream.entries.map(e => ({ id: e.id, timestamp: e.timestamp, fullCode, stockName: stream.stockName, direction: e.direction, price: e.price, amount: e.amount, fee: e.fee, matchedAmount: e.matchedAmount ?? 0, realizedProfit: e.realizedProfit ?? 0, note: e.note })), netProfit: stream.transferProfit, totalFees: stream.totalFee, sellAmount: stream.realizedSellAmount, avgPrice: stream.avgPrice, buyAmount: stream.buyAmount, tradeCount: stream.tradeCount, holdingDays: stream.holdingDays, win: stream.transferProfit >= 0, openedAt: stream.openedAt ?? stream.entries[0]?.timestamp ?? now, closedAt: now, transferAmount: toTransfer };
    const ltRecord: LongTermRecord = { id: generateId(), fullCode, stockName: stream.stockName, timestamp: now, type: 'merge', price: avg, amount: toTransfer, fee: txnFee, sourceReportId: roundId, note: `做T划转底仓（${formatTradeNo(now)}）` };
    set(s => ({ tRounds: [...s.tRounds.filter(r => r.id !== roundId), round], positions: newPositions, longTermRecords: [...s.longTermRecords, ltRecord] }));
    safePersist(() => completeRoundWithMerge(round, ltRecord, newPositions));
    // 划转即项目结清（Round 翻转 COMPLETED）→ 级联清理按标的 Copilot 会话
    void get().purgeScopeOnEntityDelete(`t_calculator:${fullCode}`);
    return { ok: true, message: `已将 ${toTransfer} 股划转至底仓（P_avg=${avg.toFixed(2)}）` };
  },

  settleShortRound: (fullCode) => {
    const { tRounds, feeConfig, positions } = get();
    const baseCosts = buildBasePositionCosts(positions);
    const streams = activeStreamsFromRounds(tRounds).filter(s => s.fullCode === fullCode);
    if (streams.length === 0) return { ok: false, message: '没有可结算的倒T流水' };
    const result = processAllStreams(streams, feeConfig, baseCosts).find(r => r.fullCode === fullCode);
    if (!result || result.mode !== 'short') return { ok: false, message: '当前不是倒T模式' };
    const now = new Date().toISOString();
    // 复用已有 OPENED Round 结清
    const openRound = tRounds.find(r => r.fullCode === fullCode && (r.status ?? 'OPENED') !== 'COMPLETED');
    const shortPendingAmount = result.shortPendingAmount ?? 0;
    const isPartial = shortPendingAmount > 0;
    const avgSellPrice = result.sellAmount > 0 ? result.sellValue / result.sellAmount : result.avgPrice;
    const avgBuyPrice = result.buyAmount > 0 ? result.buyTotal / result.buyAmount : 0;
    const totalBorrow = result.sellAmount + shortPendingAmount; // 总借出数量（已匹配 + 未回补）
    const round: TRoundArchive = openRound
      ? { ...openRound, mode: 'short', settleType: isPartial ? 'partial' : 'clear', status: 'COMPLETED', netProfit: result.transferProfit, totalFees: result.totalFee, fees: result.totalFee, sellAmount: result.realizedSellAmount, avgPrice: result.avgPrice, buyAmount: result.buyAmount, tradeCount: result.tradeCount, holdingDays: result.holdingDays, win: result.transferProfit >= 0, closedAt: now, lastTouched: now, lastUpdated: Date.now() }
      : { id: generateId(), fullCode, stockName: result.stockName, mode: 'short', status: 'COMPLETED', roundCode: formatTradeNo(now), settleType: isPartial ? 'partial' : 'clear', transactions: result.entries.map(e => ({ id: e.id, timestamp: e.timestamp, fullCode, stockName: result.stockName, direction: e.direction, price: e.price, amount: e.amount, fee: e.fee, matchedAmount: e.matchedAmount ?? 0, realizedProfit: e.realizedProfit ?? 0, note: e.note })), netProfit: result.transferProfit, totalFees: result.totalFee, sellAmount: result.realizedSellAmount, avgPrice: result.avgPrice, buyAmount: result.buyAmount, tradeCount: result.tradeCount, holdingDays: result.holdingDays, win: result.transferProfit >= 0, openedAt: result.openedAt ?? result.entries[0]?.timestamp ?? now, closedAt: now };
    let newLongTermRecords: LongTermRecord[] = [];
    const cleanedPositions = positions.map(p => {
      if (p.fullCode !== fullCode || p.isClosed) return p;
      // 结算方案：移除出借批次（解除），未回补部分转为真实卖出，长期记录记解除+回补
      const kind = matchSecurityKind('', fullCode.replace(/^sh|sz|bj/, ''));
      // 移除所有出借批次（解除出借，归还底仓）
      let mergedBatches = p.batches.filter(b => b.kind !== 'borrow');
      if (isPartial) {
        // 部分结清：未回补部分转为真实卖出批次
        const unmatchedAmount = shortPendingAmount;
        if (unmatchedAmount > 0) {
          const sellFee = calcTradeFees(avgSellPrice, unmatchedAmount, 'sell', feeConfig, kind).total;
          const reduceBatch: PositionBatch = {
            id: generateId(),
            timestamp: now,
            type: 'reduce',
            price: avgSellPrice,
            amount: -unmatchedAmount,
            costAfter: 0,
            amountAfter: 0,
            note: `倒T未回补转真实卖出（${formatTradeNo(now)}）`,
            fee: sellFee,
            sourceRoundId: round.id,
          };
          mergedBatches.push(reduceBatch);
        }
      }
      // 中长期记录：解除出借（视为卖出）
      if (totalBorrow > 0) {
        const sellFee = calcTradeFees(avgSellPrice, totalBorrow, 'sell', feeConfig, kind).total;
        newLongTermRecords.push({
          id: generateId(),
          fullCode,
          stockName: result.stockName,
          timestamp: now,
          type: 'sell',
          price: avgSellPrice,
          amount: totalBorrow,
          fee: sellFee,
          sourceReportId: round.id,
          note: `做T出借解除${totalBorrow}股（${formatTradeNo(now)}）`,
        });
      }
      // 中长期记录：回补（视为买入）
      if (result.buyAmount > 0) {
        const buyFee = calcTradeFees(avgBuyPrice, result.buyAmount, 'buy', feeConfig, kind).total;
        newLongTermRecords.push({
          id: generateId(),
          fullCode,
          stockName: result.stockName,
          timestamp: now,
          type: 'buy',
          price: avgBuyPrice,
          amount: result.buyAmount,
          fee: buyFee,
          sourceReportId: round.id,
          note: `做T回补${result.buyAmount}股（${formatTradeNo(now)}）`,
        });
      }
      const snap = recomputePositionSnapshot(mergedBatches);
      // realizedPnL = 真实卖出盈亏(snap.realizedPnL) + 做T利润(transferProfit)
      return { ...p, batches: mergedBatches, ...snap, realizedPnL: snap.realizedPnL + result.transferProfit, isClosed: snap.currentAmount <= 0 };
    });
    set(s => ({ tRounds: [...s.tRounds.filter(r => r.id !== round.id), round], positions: cleanedPositions, longTermRecords: [...s.longTermRecords, ...newLongTermRecords] }));
    safePersist(async () => {
      await completeRoundClear(round);
      await persistPositionDiffs(positions, cleanedPositions);
      for (const ltr of newLongTermRecords) {
        await putLongTermRecord(ltr);
      }
    });
    const msg = isPartial
      ? `倒T已结算（部分结清），做T收益 ¥${result.transferProfit.toFixed(2)}，未回补 ${shortPendingAmount} 股已转为底仓卖出`
      : `倒T已结算，净收益 ¥${result.transferProfit.toFixed(2)}`;
    // 结算即项目结清（Round 翻转 COMPLETED）→ 级联清理按标的 Copilot 会话
    void get().purgeScopeOnEntityDelete(`t_calculator:${fullCode}`);
    return { ok: true, message: msg };
  },
});
