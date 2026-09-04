/**
 * @file streamsSlice.ts
 * @description Store 流水池切片：做T流水的增删清（addStreamRecord / removeStreamRecord /
 *              clearStreams）。v8 语义：流水归属 Round（OPENED Round.transactions 即流水池），
 *              每次写操作后经 reconcilePositionsWithStreams 全量对账并检测结清。
 *              从 store/index.ts 拆出，index 只负责组装。
 * @layer Store (Slice)
 * @storage_impact 写 tTransactions / tRounds / positions / longTermRecords 表（经 safePersist）。
 * @author 开发团队
 */

import type { StateCreator } from 'zustand';
import type { TStreamRecord } from '../../utils/tStreamEngine';
import {
  finalizeRoundIfCleared,
  activeStreamsFromRounds,
  generateId,
  formatTradeNo,
} from '../utils';
import { RiskController } from '../../risk';
import { amountSanityRule, priceDeviationRule } from '../../risk/validator';
import { recordAudit } from '../../risk/auditLogger';
import {
  putTransaction,
  putTRound,
  deleteTransaction,
  deleteTRoundWithTransactions,
  replacePositionSnapshotWithBatches,
} from '../../db/index';
import { safePersist } from '../persistence';
import {
  reconcilePositionsWithStreams,
  persistPositionDiffs,
  runRiskValidation,
  positionChanged,
} from '../reconcile';
import type { AppStore } from '../types';
import type { RoundTxn, TRoundArchive, LongTermRecord } from '../types';

// ──────────────────────────────────────────────
// v8 Helpers：Round × 流水桥接（tStreams 已移除）
// ──────────────────────────────────────────────

/** 将引擎流水记录转换为 Round 交易明细（方向归一化为 buy/sell） */
function recordToTxn(record: TStreamRecord): RoundTxn {
  return {
    id: record.id,
    timestamp: record.timestamp,
    fullCode: record.fullCode,
    stockName: record.stockName,
    direction: record.direction,
    price: record.price,
    amount: record.amount,
    fee: record.fee,
    note: record.note,
    quoteId: record.quoteId,
    selectedStock: record.selectedStock,
  };
}

/** 查找该 fullCode 的 OPENED Round，无则创建（单标的单 OPENED Round 规则） */
function findOrCreateOpenRound(
  rounds: TRoundArchive[],
  record: TStreamRecord,
): { rounds: TRoundArchive[]; round: TRoundArchive } {
  const existing = rounds.find(
    (r) => r.fullCode === record.fullCode && (r.status ?? 'OPENED') !== 'COMPLETED'
  );
  if (existing) return { rounds, round: existing };
  const round: TRoundArchive = {
    id: generateId(),
    fullCode: record.fullCode,
    stockName: record.stockName,
    mode: record.direction === 'buy' ? 'long' : 'short',
    status: 'OPENED',
    roundCode: formatTradeNo(record.timestamp),
    settleType: 'clear',
    netProfit: 0,
    totalFees: 0,
    fees: 0,
    openedAt: record.timestamp,
    buyAmount: 0,
    sellAmount: 0,
    avgPrice: 0,
    tradeCount: 0,
    holdingDays: 0,
    win: false,
    transactions: [],
    lastTouched: record.timestamp,
    lastUpdated: Date.now(),
  };
  return { rounds: [...rounds, round], round };
}

export type StreamsSlice = Pick<
  AppStore,
  'addStreamRecord' | 'removeStreamRecord' | 'clearStreams'
>;

export const createStreamsSlice: StateCreator<AppStore, [], [], StreamsSlice> = (set, get) => ({

  addStreamRecord: (record) => {
    if (!get().coreDataLoaded) return { cleared: false, rejected: true, rejectedReason: '系统数据加载中，请稍后重试' };
    if (record.direction === 'sell') {
      // 【风控】卖出方向：统一走 RiskController 做T交易评估（含 R1/R2 + tBorrowRule）
      const pos = get().positions.find(p => p.fullCode === record.fullCode && !p.isClosed);
      const pendingBuyAmount = Math.max(0, (() => {
        const existing = activeStreamsFromRounds(get().tRounds).filter(s => s.fullCode === record.fullCode);
        return existing.reduce((sum, r) => sum + (r.direction === 'buy' ? r.amount : -r.amount), 0);
      })());
      const currentAmount = pos?.currentAmount ?? 0;
      const availableForT = Math.max(0, currentAmount);
      const { report } = RiskController.evaluateTTrade({
        sellAmount: record.amount,
        pendingBuyAmount,
        availableForT,
        price: record.price,
        fullCode: record.fullCode,
        direction: 'sell',
      });
      if (report.blocked) {
        const firstError = report.checks.find(c => !c.passed && c.severity === 'error');
        return { cleared: false, rejected: true, rejectedReason: firstError?.message ?? report.summary };
      }
    } else {
      // 【风控 R1/R2】买入方向：数量与价格合理性校验
      const riskReport = runRiskValidation(
        [amountSanityRule(record.amount, '买入数量'), priceDeviationRule(record.price, record.fullCode, '买入价格')],
        record,
      );
      if (riskReport.blocked) {
        return { cleared: false, rejected: true, rejectedReason: riskReport.summary };
      }
    }
    const { feeConfig, tRounds, positions } = get();
    // ① 找/建 OPENED Round（单标的单 OPENED Round 规则），追加流水
    const { rounds: withRound, round } = findOrCreateOpenRound(tRounds, record);
    const roundTxn = recordToTxn(record);
    const updatedRound: TRoundArchive = {
      ...round,
      transactions: [...(round.transactions ?? []), roundTxn],
      lastTouched: record.timestamp,
      lastUpdated: Date.now(),
    };
    const rounds = withRound.map(r => r.id === updatedRound.id ? updatedRound : r);
    // ② 全量对账（输入 = OPENED rounds 派生的活跃流水）
    const activeStreams = activeStreamsFromRounds(rounds);
    const { positions: finalPositions, streams: finalStreams, results } = reconcilePositionsWithStreams(positions, activeStreams, feeConfig, rounds);
    const stream = results.find(r => r.fullCode === record.fullCode);
    // ③ 结清检测 → 翻转 COMPLETED（复用同一 Round，不再新建）
    const finalRounds = stream ? finalizeRoundIfCleared(stream, rounds) : rounds;

    // 检测超额归并：若底仓数量增加，说明发生了倒T超额买回归并，创建中长期记录
    const excessMergeLTRecord: LongTermRecord | null = (() => {
      for (const fp of finalPositions) {
        const op = positions.find(p => p.id === fp.id);
        if (op && fp.currentAmount > op.currentAmount) {
          const diff = fp.currentAmount - op.currentAmount;
          const sr = results.find(r => r.fullCode === fp.fullCode);
          if (sr && sr.mode === 'short' && sr.status === 'CLEARED') {
            return {
              id: generateId(),
              fullCode: fp.fullCode,
              stockName: fp.stockName,
              timestamp: new Date().toISOString(),
              type: 'merge',
              price: sr.avgPrice,
              amount: diff,
              fee: 0,
              note: `倒T超额归并底仓（${formatTradeNo(new Date().toISOString())}）`,
            };
          }
        }
      }
      return null;
    })();

    if (excessMergeLTRecord) {
      set({ tRounds: finalRounds, positions: finalPositions, longTermRecords: [...get().longTermRecords, excessMergeLTRecord] });
    } else {
      set({ tRounds: finalRounds, positions: finalPositions });
    }
    // ④ 项目结清（OPENED→COMPLETED 翻转）→ 级联清理按标的 Copilot 会话（事实已终结，
    //    旧历史不得污染该标的的下一次项目提问）
    const roundBefore = rounds.find((r) => r.id === updatedRound.id);
    const roundAfter = finalRounds.find((r) => r.id === updatedRound.id);
    if (
      record.fullCode &&
      roundBefore && roundAfter &&
      (roundBefore.status ?? 'OPENED') !== 'COMPLETED' &&
      (roundAfter.status ?? 'OPENED') === 'COMPLETED'
    ) {
      void get().purgeScopeOnEntityDelete(`t_calculator:${record.fullCode}`);
    }
    safePersist(async () => {
      // 流水逐笔落库（v8 per-entry 写入）+ Round 概览更新
      await putTransaction(updatedRound.id, roundTxn);
      const finalRound = finalRounds.find(r => r.id === updatedRound.id);
      if (finalRound) await putTRound(finalRound);
      await persistPositionDiffs(positions, finalPositions);
      if (excessMergeLTRecord) {
        const { putLongTermRecord } = await import('../../db/index');
        await putLongTermRecord(excessMergeLTRecord);
      }
    });
    // 【风控审计】记录流水操作
    recordAudit('add_stream_record', 'round', updatedRound.id, 'success', {
      tags: { fullCode: record.fullCode, direction: record.direction },
      after: { id: record.id, price: record.price, amount: record.amount },
    });
    return { cleared: stream?.status === 'CLEARED', netProfit: stream?.transferProfit, avgPrice: stream?.avgPrice };
  },

  removeStreamRecord: (id) => {
    const { feeConfig, tRounds, positions } = get();
    // 找到包含该流水的 Round，从中移除；OPENED Round 流水清空则删除整轮
    let removedRound: TRoundArchive | null = null;
    const nextRounds: TRoundArchive[] = [];
    for (const r of tRounds) {
      const txns = (r.transactions ?? []).filter(t => t.id !== id);
      if (txns.length === (r.transactions ?? []).length) { nextRounds.push(r); continue; }
      removedRound = r;
      if (txns.length === 0 && (r.status ?? 'OPENED') !== 'COMPLETED') continue; // 空项目不再展示
      nextRounds.push({ ...r, transactions: txns, lastUpdated: Date.now() });
    }
    const activeStreams = activeStreamsFromRounds(nextRounds);
    const { positions: finalPositions, streams: finalStreams, results } = reconcilePositionsWithStreams(positions, activeStreams, feeConfig, nextRounds);
    let rounds = nextRounds;
    for (const r of results) { if (r.status === 'CLEARED') rounds = finalizeRoundIfCleared(r, rounds); }
    // 空 OPENED 项目被整体删除 → 级联清理按标的 Copilot 会话
    const roundDeleted = !!removedRound && !nextRounds.some((r) => r.id === removedRound!.id);
    set({ tRounds: rounds, positions: finalPositions });
    if (roundDeleted && removedRound!.fullCode) {
      void get().purgeScopeOnEntityDelete(`t_calculator:${removedRound!.fullCode}`);
    }
    safePersist(async () => {
      await deleteTransaction(id);
      if (roundDeleted) {
        await deleteTRoundWithTransactions(removedRound!.id);
      } else {
        const updatedRound = rounds.find(r => r.id === removedRound?.id);
        if (updatedRound) await putTRound(updatedRound);
      }
      await persistPositionDiffs(positions, finalPositions);
    });
    // 【风控审计】记录删除流水操作
    recordAudit('remove_stream_record', 'round', removedRound?.id ?? id, 'success', {
      tags: { streamId: id },
    });
  },

  clearStreams: () => {
    const { tRounds, positions, feeConfig } = get();
    const openIds = tRounds.filter(r => (r.status ?? 'OPENED') !== 'COMPLETED').map(r => r.id);
    const keptRounds = tRounds.filter(r => (r.status ?? 'OPENED') === 'COMPLETED');
    // 清空活跃流水后全量对账：剥离自动归并批次、回滚倒T扣减，恢复批次履历基线；
    // 已归档轮次（COMPLETED）的归并/扣减作为固化履历保留（keptRounds 传入 reconcile）
    const { positions: fixedPositions } = reconcilePositionsWithStreams(positions, [], feeConfig, keptRounds);
    const changed = fixedPositions.filter((p, i) => {
      const old = positions[i];
      if (!old) return true;
      return positionChanged(old, p);
    });
    set({ tRounds: keptRounds, positions: fixedPositions });
    // 全部 OPENED 项目被清空 → 级联清理各标的的 Copilot 会话
    const clearedScopes = tRounds
      .filter((r) => (r.status ?? 'OPENED') !== 'COMPLETED' && !!r.fullCode)
      .map((r) => `t_calculator:${r.fullCode}`);
    for (const scopeId of new Set(clearedScopes)) {
      void get().purgeScopeOnEntityDelete(scopeId);
    }
    safePersist(async () => { for (const id of openIds) await deleteTRoundWithTransactions(id); for (const p of changed) { await replacePositionSnapshotWithBatches(p, p.batches); } });
    // 【风控审计】记录清空流水操作
    recordAudit('clear_streams', 'system', 'all', 'success', {
      tags: { clearedRounds: openIds.join(',') },
    });
  },
});
