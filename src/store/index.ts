/**
 * @file index.ts
 * @description 全局内存状态中心（Zustand）：管理费率配置、做T流水池（FIFO 撮合）、
 *              Round 生命周期归档库、持仓账本与数据导入导出。
 *              v6 重构：类型拆分到 types.ts，工具函数拆分到 utils.ts。
 *              v6.1 修复：deletePositionBatch 实现修复（改为调用单条删除 + 更新持仓）、
 *              safePersist 增加指数退避重试（最多 3 次，1s→2s→4s→8s）与失败队列，
 *              移除 window.dispatchEvent DOM 耦合，使用 persistError 模块状态替代。
 * @layer Store
 * @author 开发团队
 */

import Decimal from 'decimal.js';
import { create } from 'zustand';
import {
  processAllStreams,
  processStockStream,
  validateStreamTrade,
  type TStreamRecord,
  type StockStreamResult,
} from '../utils/tStreamEngine';
import { calcTradeFees, roundTo, matchSecurityKind, type FeeConfig } from '../utils/mathUtils';
import { validateSellOrder } from '../utils/validation';
import {
  putFeeConfig,
  putPosition,
  deletePositionWithBatches,
  deletePositionBatch,
  putPositionBatch,
  putPositionWithBatches,
  addBatchToPosition,
  replacePositionSnapshotWithBatches,
  deleteAdjustmentBatches,
  putTRound,
  putRoundWithTransactions,
  deleteTRoundWithTransactions,
  putTransaction,
  deleteTransaction,
  putLongTermRecord,
  deleteLongTermRecord,
  completeRoundWithMerge,
  completeRoundClear,
  safeImportAllData,
  loadPositionsFromDB,
  loadTRoundsFromDB,
  loadStocksFromDB,
  } from '../db/index';
import { isInitialLoadDone } from '../db/storeInit';
import { positionAdjustmentPort } from '../services/positionAdjustmentPort';
import {
  generateId,
  formatTradeNo,
  buildBasePositionCosts,
  recomputePositionSnapshot,
  finalizeRoundIfCleared,
  activeStreamsFromRounds,
} from './utils';
import type {
  PositionBatch,
  Position,
  RoundTxn,
  TRoundArchive,
  LongTermRecord,
  FeePresetName,
  StreamAddResult,
  AppStoreExport,
  AppStore,
} from './types';
import { EXPORT_VERSION } from './types';

// Re-export all types for backward compatibility
export type {
  PositionBatch,
  Position,
  RoundTxn,
  TRoundArchive,
  LongTermRecord,
  FeePresetName,
  StreamAddResult,
  AppStoreExport,
  AppStore,
} from './types';
export { EXPORT_VERSION } from './types';
export { generateId, buildBasePositionCosts, recomputePositionSnapshot, getCloseBlockReason, useStreamResults, activeStreamsFromRounds } from './utils';
export type { TStreamRecord, StockStreamResult } from '../utils/tStreamEngine';

let persistError: string | null = null;
let pendingQueue: Array<() => Promise<void>> = [];
let isProcessingQueue = false;

/**
 * 远端同步标记：当从云端恢复/合并数据时（importData 的 silent 模式），
 * 此标记设为 true，防止自动同步监听器将刚导入的数据又上传回云端。
 * 自动同步触发器（如 store.subscribe / useEffect）必须检查此标记：
 *   if (isSyncingFromRemote) { isSyncingFromRemote = false; return; }
 * 使用完成后立即复位，避免影响后续用户手动操作。
 */
let isSyncingFromRemote = false;
export function getIsSyncingFromRemote(): boolean { return isSyncingFromRemote; }

export function getPersistError(): string | null { return persistError; }
export function clearPersistError(): void { persistError = null; }

/**
 * 带指数退避重试机制的持久化函数。
 * - 最多重试 3 次（第 0 次为首次尝试，之后最多 3 次重试）
 * - 退避间隔为 1s → 2s → 4s（最大 8s，实际第 3 次重试间隔 4s）
 * - 所有重试均失败后，将操作加入待处理队列（pendingQueue），
 *   等待下次 safePersist 成功时自动重放（processPendingQueue）
 * - 不再直接操作 DOM（移除 window.dispatchEvent），
 *   改为设置 persistError 模块状态，由 UI 层通过 getPersistError() 读取
 * - 成功时自动清除 persistError 并触发队列重放
 */
async function safePersist(fn: () => Promise<void>): Promise<void> {
  if (!isInitialLoadDone()) return;

  const maxRetries = 3;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await fn();
      // 成功时清除错误并尝试处理队列中的待办操作
      if (persistError) {
        persistError = null;
        processPendingQueue();
      }
      return;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
        console.warn(`[StorePersistence] 第 ${attempt + 1} 次重试失败，${delay}ms 后重试...`, err);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  persistError = msg;
  console.error('[StorePersistence] 所有重试均失败，已加入待处理队列:', lastError);

  // 将失败操作加入队列，下次成功时重放
  pendingQueue.push(fn);
}

/**
 * 重放待处理队列中的操作。
 * - 当 safePersist 所有重试均失败后，操作被加入 pendingQueue；
 * - 下次任何 safePersist 调用成功时，自动触发本函数重放队列；
 * - 重放期间若再次失败，操作重新入队，2s 后自动重试，避免无限递归；
 * - 使用 isProcessingQueue 互斥锁防止并发重放。
 */
async function processPendingQueue(): Promise<void> {
  if (isProcessingQueue || pendingQueue.length === 0) return;
  isProcessingQueue = true;

  const queue = [...pendingQueue];
  pendingQueue = [];

  for (const task of queue) {
    try {
      await task();
    } catch (err) {
      console.error('[StorePersistence] 队列处理失败，重新加入队列:', err);
      pendingQueue.push(task);
    }
  }

  isProcessingQueue = false;
  if (pendingQueue.length > 0) {
    // 仍有待处理项，延迟重试
    setTimeout(() => processPendingQueue(), 2000);
  }
}

export const DEFAULT_FEE_CONFIG: FeeConfig = {
  commissionRate: 0.00025, isFreeFive: false, minCommission: 0.5,
  transferRate: 0.00001, stampRate: 0.0005,
  etfCommissionRate: 0.00025, etfIsFreeFive: true, etfMinCommission: 0.2,
  etfTransferRate: 0, etfStampRate: 0,
};

export const FEE_PRESETS: Record<FeePresetName, FeeConfig> = {
  '默认A股': { commissionRate: 0.00025, isFreeFive: false, minCommission: 0.5, transferRate: 0.00001, stampRate: 0.0005, etfCommissionRate: 0.00025, etfIsFreeFive: true, etfMinCommission: 0.2, etfTransferRate: 0, etfStampRate: 0 },
  'A股标准模板': { commissionRate: 0.00025, isFreeFive: false, minCommission: 0.5, transferRate: 0.00001, stampRate: 0.0005, etfCommissionRate: 0.00025, etfIsFreeFive: true, etfMinCommission: 0.2, etfTransferRate: 0, etfStampRate: 0 },
  'ETF模板': { commissionRate: 0.00025, isFreeFive: true, minCommission: 0.2, transferRate: 0, stampRate: 0, etfCommissionRate: 0.00025, etfIsFreeFive: true, etfMinCommission: 0.2, etfTransferRate: 0, etfStampRate: 0 },
  '港股/美股免佣模板': { commissionRate: 0.0001, isFreeFive: true, minCommission: 0.5, transferRate: 0.000025, stampRate: 0.0013, etfCommissionRate: 0.0001, etfIsFreeFive: true, etfMinCommission: 0.2, etfTransferRate: 0, etfStampRate: 0 },
};

/** @deprecated Use FEE_PRESETS. Alias for backward compatibility. */
export const FEE_TEMPLATES = FEE_PRESETS;

// Helper: normalize short-T deductions using positionAdjustmentPort.emitRoundAdjustments
/**
 * 使用 emitRoundAdjustments 投影倒T出借（borrow）命令，在内存中创建出借批次。
 * 取代旧的 normalizeShortTDeductions 和 applyShortExcessMerge（超额买回归并现由端口在结算时处理）。
 */
function normalizeShortTDeductionsViaPort(
  streams: TStreamRecord[],
  positions: Position[],
  rounds: TRoundArchive[],
): { streams: TStreamRecord[]; positions: Position[] } {
  let updatedPositions = [...positions];
  for (const round of rounds) {
    if ((round.status ?? 'OPENED') === 'COMPLETED') continue;
    if (round.mode !== 'short') continue;
    const txns = round.transactions ?? [];
    if (txns.length === 0) continue;
    // ① 用 settle=false 投影出借（borrow）命令（在途净借出）
    const cmds = positionAdjustmentPort.emitRoundAdjustments(round.id, round.mode, txns, false);
    const borrowCmds = cmds.filter(c => c.kind === 'borrow');
    const sellTxns = txns.filter(t => t.direction === 'sell');
    const buyTxns = txns.filter(t => t.direction === 'buy');
    const totalSell = sellTxns.reduce((s, t) => s + t.amount, 0);
    const totalSellValue = sellTxns.reduce((s, t) => s + t.price * t.amount, 0);
    const avgSellPrice = totalSell > 0 ? totalSellValue / totalSell : 0;
    const totalBuy = buyTxns.reduce((s, t) => s + t.amount, 0);
    const totalBuyValue = buyTxns.reduce((s, t) => s + t.price * t.amount, 0);
    const avgBuyPrice = totalBuy > 0 ? totalBuyValue / totalBuy : 0;
    // ② 超额买回归并（excessBuy = max(0, totalBuy - totalSell)）
    const excessBuy = Math.max(0, totalBuy - totalSell);

    // 批量处理 borrow 命令
    for (const cmd of borrowCmds) {
      if (cmd.qty <= 0) continue;
      const pos = updatedPositions.find((p) => p.fullCode === cmd.fullCode && !p.isClosed);
      if (!pos) continue;
      const borrowBatch: PositionBatch = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        type: 'reduce',
        price: avgSellPrice,
        amount: -cmd.qty,
        kind: 'borrow',
        costPrice: pos.currentCost,
        costAfter: pos.currentCost,
        amountAfter: Math.max(0, pos.currentAmount - cmd.qty),
        note: `倒T出借（${formatTradeNo(new Date().toISOString())}）`,
        sourceRoundId: round.id,
      };
      const newBatches = [...pos.batches, borrowBatch];
      const snap = recomputePositionSnapshot(newBatches);
      updatedPositions = updatedPositions.map((p) =>
        p.id === pos.id
          ? { ...p, batches: newBatches, currentAmount: snap.currentAmount, currentCost: snap.currentCost, totalInvested: snap.totalInvested, realizedPnL: snap.realizedPnL, isClosed: snap.currentAmount <= 0 }
          : p,
      );
    }

    // ③ 批量处理超额买回归并（excessBuy > 0 时创建 merge 批次）
    if (excessBuy > 0) {
      for (const pos of updatedPositions) {
        if (pos.fullCode !== round.fullCode || pos.isClosed) continue;
        const mergeBatch: PositionBatch = {
          id: generateId(),
          timestamp: new Date().toISOString(),
          type: 'add',
          price: avgBuyPrice,
          amount: excessBuy,
          kind: 'merge',
          costAfter: 0,
          amountAfter: 0,
          note: `倒T超额归并（${formatTradeNo(new Date().toISOString())}）`,
          sourceRoundId: round.id,
        };
        const newBatches = [...pos.batches, mergeBatch];
        const snap = recomputePositionSnapshot(newBatches);
        updatedPositions = updatedPositions.map((p) =>
          p.id === pos.id
            ? { ...p, batches: newBatches, currentAmount: snap.currentAmount, currentCost: snap.currentCost, totalInvested: snap.totalInvested, realizedPnL: snap.realizedPnL, isClosed: snap.currentAmount <= 0 }
            : p,
        );
        break; // 只处理一次
      }
    }
  }
  return { streams, positions: updatedPositions };
}

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

/** 比较持仓是否需要落库（diff 检测） */
function positionChanged(a: Position, b: Position): boolean {
  return a.currentAmount !== b.currentAmount
    || a.currentCost !== b.currentCost
    || a.isClosed !== b.isClosed
    || a.batches.length !== b.batches.length
    || JSON.stringify(a.batches) !== JSON.stringify(b.batches);
}

/** 只持久化被修改的持仓（增量写库） */
async function persistPositionDiffs(positions: Position[], finalPositions: Position[]): Promise<void> {
  for (const np of finalPositions) {
    const old = positions.find((p) => p.id === np.id);
    if (old && positionChanged(old, np)) {
      await replacePositionSnapshotWithBatches(np, np.batches);
    }
  }
}

/**
 * 全量对账：以持仓批次履历为基线，依据当前流水池状态重建底仓。
 *
 * 每个写操作（新增/删除/修改流水、清空流水池）后调用，保证：
 *  - 倒T首笔卖出扣减（通过 emitRoundAdjustments 投影）始终与当前流水池状态一致；
 *  - 删除/修改流水后，已不存在的调整批次会自动回滚（不再残留于底仓）；
 *  - 天然幂等：每次从「剥离调整批次后的基线」出发重新计算，扣减/归并不会重复叠加。
 *
 * @param positions 当前底仓（可能已含历史调整批次残留）
 * @param streams 当前流水池（新增/删除/修改后的最新状态）
 * @param feeConfig 系统费率配置
 * @param rounds 当前所有 Round（用于识别 COMPLETED 轮次保护固化批次）
 * @returns 对账后的底仓与撮合结果
 */
export function reconcilePositionsWithStreams(
  positions: Position[],
  streams: TStreamRecord[],
  feeConfig: FeeConfig,
  rounds?: TRoundArchive[],
): { positions: Position[]; streams: TStreamRecord[]; results: StockStreamResult[] } {
  // 已归档（COMPLETED）轮次引用的调整批次视为「固化履历」：其归并/扣减已随轮次
  // 归档落定，不能再被剥离回滚；否则多轮倒T中上一轮的归并效果会在下一轮
  // reconcile 时被错误撤销（如两轮各归并 100 → 底仓应 +200，旧逻辑只剩 +100）。
  // 保护策略：根据批次 kind + sourceRoundId 判断是否属于 COMPLETED 轮次
  const completedRoundIds = new Set<string>();
  if (rounds) {
    for (const r of rounds) {
      if ((r.status ?? 'OPENED') === 'COMPLETED') {
        completedRoundIds.add(r.id);
      }
    }
  }

  // ① 剥离历史调整批次，回到批次履历基线（数量/成本以批次为准）
  // 按 sourceRoundId 识别：不在 completedRoundIds 中的轮次对应的批次全部剥离
  // 覆盖：出借/归并（borrow/merge）、结算卖出（finalize-sell）、结算买入（merge-buy）
  const cleanPositions = positions.map((p) => {
    const cleanBatches = p.batches.filter((b) => {
      // 无 sourceRoundId 的批次为永久履历（如手工加减仓），保留
      if (!b.sourceRoundId) return true;
      // 保留 COMPLETED 轮次的固化批次（受保护不剥离）
      if (completedRoundIds.has(b.sourceRoundId)) return true;
      return false;
    });
    const snap = recomputePositionSnapshot(cleanBatches);
    const reOpened = snap.currentAmount > 0;
    return {
      ...p,
      batches: cleanBatches,
      currentCost: snap.currentCost,
      currentAmount: snap.currentAmount,
      realizedPnL: snap.realizedPnL,
      totalInvested: snap.totalInvested,
      isClosed: !reOpened,
      closedAt: reOpened ? undefined : p.closedAt,
    };
  });

  // ② 通过 emitRoundAdjustments 投影出借命令（取代旧的 normalizeShortTDeductions + applyShortExcessMerge）
  const { positions: deductedPositions } = normalizeShortTDeductionsViaPort(streams, cleanPositions, rounds ?? []);

  // ③ 计算撮合结果（用于结清检测）
  const baseCosts = buildBasePositionCosts(deductedPositions);
  const results = processAllStreams(streams, feeConfig, baseCosts);

  return { positions: deductedPositions, streams, results };
}

export const useAppStore = create<AppStore>()((set, get) => ({
  feeConfig: { ...DEFAULT_FEE_CONFIG }, tRounds: [],
  positions: [], stocks: [], longTermRecords: [], coreDataLoaded: false,
  persistError: null,

  loadPositions: async () => { const positions = await loadPositionsFromDB(); if (positions.length) set(s => ({ positions: [...s.positions.filter(p => !positions.some(np => np.id === p.id)), ...positions] })); },
  loadTRounds: async () => { const rounds = await loadTRoundsFromDB(); if (rounds.length) set(s => ({ tRounds: [...s.tRounds.filter(r => !rounds.some(nr => nr.id === r.id)), ...rounds] })); },
  loadStocks: async () => { const stocks = await loadStocksFromDB(); if (stocks.length) set(s => ({ stocks: [...s.stocks.filter(st => !stocks.some(ns => ns.fullCode === st.fullCode)), ...stocks] })); },
  setCoreDataLoaded: (loaded: boolean) => { set({ coreDataLoaded: loaded }); },

  setFeeConfig: (partial) => { set(s => ({ feeConfig: { ...s.feeConfig, ...partial } })); safePersist(() => putFeeConfig(get().feeConfig)); },
  resetFeeConfig: (config) => { set({ feeConfig: { ...config } }); safePersist(() => putFeeConfig(config)); },

  addStreamRecord: (record) => {
    if (!get().coreDataLoaded) return { cleared: false, rejected: true, rejectedReason: '系统数据加载中，请稍后重试' };
    if (record.direction === 'sell') {
      const existing = activeStreamsFromRounds(get().tRounds).filter(s => s.fullCode === record.fullCode);
      const pos = get().positions.find(p => p.fullCode === record.fullCode && !p.isClosed);
      // 可卖上限 = 底仓当前数量（currentAmount 已含 normalizeShortTDeductionsViaPort 写入的 borrow batch 扣减，
      // reconcile 每次从基线「剥离→重算」，因此这里的 currentAmount 是上一轮 reconcile 后的权威值）
      const maxSellable = Math.max(0, pos?.currentAmount ?? 0);
      if (record.amount > maxSellable) {
        return { cleared: false, rejected: true, rejectedReason: `卖出数量(${record.amount}股)超出可卖上限(${maxSellable}股)：当前底仓 ${maxSellable} 股` };
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
    safePersist(async () => {
      // 流水逐笔落库（v8 per-entry 写入）+ Round 概览更新
      await putTransaction(updatedRound.id, roundTxn);
      const finalRound = finalRounds.find(r => r.id === updatedRound.id);
      if (finalRound) await putTRound(finalRound);
      await persistPositionDiffs(positions, finalPositions);
      if (excessMergeLTRecord) {
        const { putLongTermRecord } = await import('../db/index');
        await putLongTermRecord(excessMergeLTRecord);
      }
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
    set({ tRounds: rounds, positions: finalPositions });
    safePersist(async () => {
      await deleteTransaction(id);
      if (removedRound && !nextRounds.some(r => r.id === removedRound!.id)) {
        await deleteTRoundWithTransactions(removedRound.id);
      } else {
        const updatedRound = rounds.find(r => r.id === removedRound?.id);
        if (updatedRound) await putTRound(updatedRound);
      }
      await persistPositionDiffs(positions, finalPositions);
    });
  },

  updateStreamRecord: (id, updates) => {
    const { feeConfig, tRounds, positions } = get();
    // 更新对应 Round 中的流水（保留 fullCode/stockName 归属）
    const nextRounds: TRoundArchive[] = tRounds.map(r => ({
      ...r,
      transactions: (r.transactions ?? []).map(t => t.id === id ? { ...t, ...updates, fullCode: t.fullCode ?? r.fullCode, stockName: t.stockName ?? r.stockName } as RoundTxn : t),
      lastUpdated: Date.now(),
    }));
    const activeStreams = activeStreamsFromRounds(nextRounds);
    const { positions: finalPositions, streams: finalStreams, results } = reconcilePositionsWithStreams(positions, activeStreams, feeConfig, nextRounds);
    let rounds = nextRounds;
    for (const r of results) { if (r.status === 'CLEARED') rounds = finalizeRoundIfCleared(r, rounds); }
    set({ tRounds: rounds, positions: finalPositions });
    safePersist(async () => {
      const updatedRound = rounds.find(r => (r.transactions ?? []).some(t => t.id === id));
      if (updatedRound) {
        const txn = (updatedRound.transactions ?? []).find(t => t.id === id);
        if (txn) await putTransaction(updatedRound.id, txn);
        await putTRound(updatedRound);
      }
      await persistPositionDiffs(positions, finalPositions);
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
    safePersist(async () => { for (const id of openIds) await deleteTRoundWithTransactions(id); for (const p of changed) { await replacePositionSnapshotWithBatches(p, p.batches); } });
  },

  validateSellWithPosition: (stockFullCode, _direction, _price, amount) => {
    const stockStreams = activeStreamsFromRounds(get().tRounds).filter(s => s.fullCode === stockFullCode);
    // 从原始流水中估算待处理买入数量（买入总量 - 卖出总量）
    const totalBuy = stockStreams.filter(s => s.direction === 'buy').reduce((sum, s) => sum + s.amount, 0);
    const totalSell = stockStreams.filter(s => s.direction === 'sell').reduce((sum, s) => sum + s.amount, 0);
    const pendingBuyAmount = Math.max(0, totalBuy - totalSell);
    const baseAmount = get().positions.find(p => p.fullCode === stockFullCode && !p.isClosed)?.currentAmount ?? 0;
    return validateSellOrder(amount, pendingBuyAmount, baseAmount);
  },

  addRound: (round) => { set(s => ({ tRounds: [...s.tRounds, round] })); safePersist(() => putRoundWithTransactions(round)); },

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
    return { ok: true };
  },

  clearRounds: () => { const ids = get().tRounds.map(r => r.id); set({ tRounds: [] }); safePersist(async () => { for (const id of ids) await deleteTRoundWithTransactions(id); }); },

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
    if (!pos) { pos = { id: generateId(), stockName: stream.stockName, fullCode, currentCost: 0, currentAmount: 0, batches: [], isClosed: false, createdAt: now, realizedPnL: 0, totalInvested: 0 }; created = true; }
    const posDef = pos; const addQty = toTransfer;
    // 剥离流水驱动的调整批次（出借/归并），以真实底仓基线计算划转
    const cleanBatches = posDef.batches.filter(b => !isStreamAdjustmentBatch(b));
    const cleanSnap = recomputePositionSnapshot(cleanBatches);
    const totalBefore = cleanSnap.currentAmount;
    const investedBefore = cleanSnap.totalInvested;
    const addInvested = avg * addQty + txnFee; const newAmount = totalBefore + addQty;
    const newInvested = investedBefore + addInvested; const newCost = newAmount > 0 ? newInvested / newAmount : 0;
    const batch: PositionBatch = { id: generateId(), timestamp: now, type: 'add', price: avg, amount: addQty, costAfter: newCost, amountAfter: newAmount, note: `做T划转底仓（P_avg=${avg}）`, fee: txnFee };
    if (created) {
      const ob: PositionBatch = { id: generateId(), timestamp: now, type: 'open', price: avg, amount: addQty, costAfter: newCost, amountAfter: newAmount, note: `做T划转新建底仓（P_avg=${avg}）`, fee: txnFee };
      newPositions = [...newPositions, { ...posDef, currentCost: newCost, currentAmount: newAmount, totalInvested: newInvested, batches: [ob] }];
    } else {
      newPositions = newPositions.map(p => p.id === posDef.id ? { ...p, currentCost: newCost, currentAmount: newAmount, totalInvested: newInvested, batches: [...cleanBatches, batch] } : p);
    }
    // v8：复用已有 OPENED Round 结清（不再新建），流水保持完整
    const openRound = tRounds.find(r => r.fullCode === fullCode && (r.status ?? 'OPENED') !== 'COMPLETED');
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
      : { id: generateId(), fullCode, stockName: stream.stockName, mode: stream.mode, status: 'COMPLETED', roundCode: formatTradeNo(now), settleType: 'partial', transactions: stream.entries.map(e => ({ id: e.id, timestamp: e.timestamp, fullCode, stockName: stream.stockName, direction: e.direction, price: e.price, amount: e.amount, fee: e.fee, matchedAmount: e.matchedAmount ?? 0, realizedProfit: e.realizedProfit ?? 0, note: e.note })), netProfit: stream.transferProfit, totalFees: stream.totalFee, sellAmount: stream.realizedSellAmount, avgPrice: stream.avgPrice, buyAmount: stream.buyAmount, tradeCount: stream.tradeCount, holdingDays: stream.holdingDays, win: stream.transferProfit >= 0, openedAt: stream.openedAt ?? stream.entries[0]?.timestamp ?? now, closedAt: now, transferAmount: toTransfer };
    const ltRecord: LongTermRecord = { id: generateId(), fullCode, stockName: stream.stockName, timestamp: now, type: 'merge', price: avg, amount: toTransfer, fee: txnFee, sourceReportId: round.id, note: `做T划转底仓（${formatTradeNo(now)}）` };
    set(s => ({ tRounds: [...s.tRounds.filter(r => r.id !== round.id), round], positions: newPositions, longTermRecords: [...s.longTermRecords, ltRecord] }));
    safePersist(() => completeRoundWithMerge(round, ltRecord, newPositions));
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
    return { ok: true, message: msg };
  },

  addPosition: (pos) => { set(s => ({ positions: [...s.positions, pos] })); safePersist(() => putPositionWithBatches(pos, pos.batches)); },
  updatePosition: (id, updates) => { set(s => ({ positions: s.positions.map(p => p.id === id ? { ...p, ...updates } : p) })); const u = get().positions.find(p => p.id === id); if (u) safePersist(() => putPosition(u)); },
  closePosition: (id) => { set(s => ({ positions: s.positions.map(p => p.id === id ? { ...p, isClosed: true, closedAt: new Date().toISOString() } : p) })); const u = get().positions.find(p => p.id === id); if (u) safePersist(() => putPosition(u)); },
  addBatch: (pid, batch, updates) => {
    const base = get().positions.find(p => p.id === pid);
    if (!base) return;
    // 一次性合并「追加批次 + 快照更新」，只做一次 set 与一次 safePersist 写库。
    // 旧写法（先 addBatch 写旧快照，再 updatePosition 写新快照）会产生两次异步写，
    // 而 Dexie 在同一 tick 内总是先执行隐式单表 put、后执行显式 db.transaction：
    // updatePosition 的新值先落库，随后 addBatchToPosition 的旧快照显式事务必然覆盖新值 → 总是旧值。
    // 合并为单次写库后不存在该问题。
    const updated: Position = { ...base, ...updates, batches: [...base.batches, batch] };
    set(s => ({ positions: s.positions.map(p => (p.id === pid ? updated : p)) }));
    safePersist(() => addBatchToPosition(updated, batch));
  },
  deletePositionBatch: (pid, bid) => {
    const base = get().positions.find((p) => p.id === pid);
    if (!base) return;
    // 删除批次后按剩余履历重建权威快照（成本/数量/已实现盈亏/累计投入）。
    // 口径与建仓/加减仓一致（总资金抽回法，见 recomputePositionSnapshot），
    // 一次 set + 单次持久化，避免「批次已删但快照仍是旧值」的脏数据。
    const nextBatches = base.batches.filter((b) => b.id !== bid);
    const snapshot = recomputePositionSnapshot(nextBatches);
    const updated: Position = { ...base, batches: nextBatches, ...snapshot };
    set((s) => ({ positions: s.positions.map((p) => (p.id === pid ? updated : p)) }));
    safePersist(async () => {
      await deletePositionBatch(bid);
      await putPosition(updated);
    });
  },
  removePosition: (id) => { set(s => ({ positions: s.positions.filter(p => p.id !== id) })); safePersist(() => deletePositionWithBatches(id)); },

  addLongTermRecord: (record) => { set(s => ({ longTermRecords: [...s.longTermRecords, record] })); safePersist(() => putLongTermRecord(record)); },
  removeLongTermRecord: (id) => { set(s => ({ longTermRecords: s.longTermRecords.filter(r => r.id !== id) })); safePersist(() => deleteLongTermRecord(id)); },

  exportData: () => { const state = get(); return { version: EXPORT_VERSION, feeConfig: state.feeConfig, tRounds: state.tRounds, positions: state.positions, stocks: state.stocks, longTermRecords: state.longTermRecords }; },

  importData: (data, silent) => {
    const rounds = data.tRounds ?? [];
    set({ feeConfig: data.feeConfig, tRounds: rounds, positions: data.positions ?? [], stocks: data.stocks ?? [], longTermRecords: data.longTermRecords ?? [] });
    safePersist(() => safeImportAllData(data.feeConfig, data.positions ?? [], rounds, data.stocks ?? [], data.longTermRecords ?? []));
    // silent 模式：来自远端拉取合并（Pull & Merge），跳过后续自动上传/同步逻辑
    // 设置 isSyncingFromRemote 标记，自动同步监听器必须检查此标记后跳过触发
    if (silent) {
      isSyncingFromRemote = true;
      // 下轮微任务中自动复位，确保不影响后续用户手动触发同步
      // 使用 setTimeout(0) 而非 Promise.resolve().then()，因为 Zustand set 同步执行，
      // 自动同步监听器若使用 store.subscribe 会同步/微任务内触发，需要在此之后才复位
      setTimeout(() => { isSyncingFromRemote = false; }, 0);
    }
  },

  exportJSON: async () => {
    const state = get();
    const [closedPositions, completedRounds, ltRecs] = await Promise.all([
      import('../db/index').then(m => m.fetchAllClosedPositions()),
      import('../db/index').then(m => m.fetchAllCompletedRounds()),
      import('../db/index').then(m => m.fetchAllLongTermRecords()),
    ]);
    // 合并 state.tRounds（OPENED 含流水 + COMPLETED 概览）与 DB 完整明细，
    // 按 id 去重并保留含 transactions 的完整版本（导入后流水不丢失）
    const roundMap = new Map<string, TRoundArchive>();
    for (const r of [...state.tRounds, ...completedRounds]) {
      const existing = roundMap.get(r.id);
      if (!existing || (r.transactions?.length ?? 0) > (existing.transactions?.length ?? 0)) {
        roundMap.set(r.id, r);
      }
    }
    return { version: EXPORT_VERSION, feeConfig: state.feeConfig, tRounds: Array.from(roundMap.values()), positions: [...state.positions, ...closedPositions], stocks: state.stocks, longTermRecords: [...state.longTermRecords, ...ltRecs] };
  },

  importJSON: (data) => {
    if (data.version !== EXPORT_VERSION) console.warn(`[Store] 导入数据版本 (${data.version}) 与当前版本 (${EXPORT_VERSION}) 不一致，尝试继续导入，但部分字段可能不兼容。`);
    get().importData(data);
  },

  exportCSV: () => {
    // v8：Round 是唯一数据源，CSV 从 tRounds 导出（OPENED + COMPLETED）
    const rounds = get().tRounds;
    const headers = ['日期', '股票名称', '模式', '状态', '净收益', '买入量', '卖出量', '手续费', '成交笔数'];
    const rows = rounds.map(r => [new Date(r.closedAt ?? r.openedAt).toLocaleDateString(), r.stockName, r.mode === 'long' ? '正T' : '倒T', r.status === 'COMPLETED' ? '已结清' : '进行中', (r.netProfit ?? 0).toFixed(2), String(r.buyAmount ?? ''), String(r.sellAmount ?? ''), String(r.totalFees ?? 0), String(r.tradeCount ?? r.transactions?.length ?? 0)]);
    return [headers.join(','), ...rows.map(row => row.map(cell => `"${cell}"`).join(','))].join('\n');
  },
}));
