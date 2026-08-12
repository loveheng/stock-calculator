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
import {
  putFeeConfig,
  putPosition,
  deletePositionWithBatches,
  deletePositionBatch,
  putPositionBatch,
  putPositionWithBatches,
  addBatchToPosition,
  putTRound,
  deleteTRoundWithTransactions,
  putTStream,
  deleteTStream,
  bulkDeleteTStreams,
  putLongTermRecord,
  deleteLongTermRecord,
  deleteRoundWithCascade,
  completeRoundWithMerge,
  completeRoundClear,
  safeImportAllData,
  loadPositionsFromDB,
  loadTStreamsFromDB,
  loadTRoundsFromDB,
  loadStocksFromDB,
  } from '../db/index';
import { isInitialLoadDone } from '../db/storeInit';
import {
  generateId,
  buildBasePositionCosts,
  recomputePositionSnapshot,
  rollbackTransferPosition,
  archiveRoundIfCleared,
} from './utils';
import type {
  TRecord,
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
  TRecord,
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
export { generateId, buildBasePositionCosts, recomputePositionSnapshot, rollbackTransferPosition, useStreamResults } from './utils';
export type { TStreamRecord, StockStreamResult } from '../utils/tStreamEngine';

let persistError: string | null = null;
let pendingQueue: Array<() => Promise<void>> = [];
let isProcessingQueue = false;

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

// Helper: normalize short-T deductions inline (kept here due to coupling with get())
function normalizeShortTDeductions(
  rawStreams: TStreamRecord[], positions: Position[]
): { streams: TStreamRecord[]; positions: Position[] } {
  const normalizedPositions = [...positions];
  const grouped = new Map<string, TStreamRecord[]>();
  for (const s of rawStreams) { const list = grouped.get(s.fullCode); if (list) list.push(s); else grouped.set(s.fullCode, [s]); }
  const updatedStreams: TStreamRecord[] = rawStreams.map((s) => ({ ...s }));
  for (const [fullCode, streams] of grouped) {
    const sorted = [...streams].sort((a, b) => { const ta = new Date(a.timestamp).getTime(); const tb = new Date(b.timestamp).getTime(); if (Number.isNaN(ta)) return -1; if (Number.isNaN(tb)) return 1; return ta - tb; });
    let initialSellCount = 0;
    for (const s of sorted) { if (s.direction === 'sell') initialSellCount += s.amount; else break; }
    if (initialSellCount === 0) continue;
    const pos = normalizedPositions.find((p) => p.fullCode === fullCode && !p.isClosed);
    const currentDeducted = sorted.filter(s => s.direction === 'sell').reduce((sum, s) => sum + (s.baseDeductedAmount ?? 0), 0);
    const diff = initialSellCount - currentDeducted;
    if (diff > 0 && pos) {
      for (let i = 0; i < normalizedPositions.length; i++) {
        if (normalizedPositions[i].fullCode === fullCode && !normalizedPositions[i].isClosed) {
          const na = Math.max(0, normalizedPositions[i].currentAmount - diff);
          normalizedPositions[i] = { ...normalizedPositions[i], currentAmount: na, isClosed: na <= 0 };
          break;
        }
      }
      for (const s of updatedStreams) { if (s.fullCode === fullCode && s.direction === 'sell') s.baseDeductedAmount = (s.baseDeductedAmount ?? 0) + diff / initialSellCount * s.amount; }
    }
  }
  return { streams: updatedStreams, positions: normalizedPositions };
}

export const useAppStore = create<AppStore>()((set, get) => ({
  feeConfig: { ...DEFAULT_FEE_CONFIG }, tRecords: [], tStreams: [], tRounds: [],
  positions: [], stocks: [], longTermRecords: [], coreDataLoaded: false,
  persistError: null,

  loadPositions: async () => { const positions = await loadPositionsFromDB(); if (positions.length) set(s => ({ positions: [...s.positions.filter(p => !positions.some(np => np.id === p.id)), ...positions] })); },
  loadTStreams: async () => { const streams = await loadTStreamsFromDB(); if (streams.length) set(s => ({ tStreams: [...s.tStreams.filter(st => !streams.some(ns => ns.id === st.id)), ...streams] })); },
  loadTRounds: async () => { const rounds = await loadTRoundsFromDB(); if (rounds.length) set(s => ({ tRounds: [...s.tRounds.filter(r => !rounds.some(nr => nr.id === r.id)), ...rounds] })); },
  loadStocks: async () => { const stocks = await loadStocksFromDB(); if (stocks.length) set(s => ({ stocks: [...s.stocks.filter(st => !stocks.some(ns => ns.fullCode === st.fullCode)), ...stocks] })); },
  setCoreDataLoaded: (loaded: boolean) => { set({ coreDataLoaded: loaded }); },

  setFeeConfig: (partial) => { set(s => ({ feeConfig: { ...s.feeConfig, ...partial } })); safePersist(() => putFeeConfig(get().feeConfig)); },
  resetFeeConfig: (config) => { set({ feeConfig: { ...config } }); safePersist(() => putFeeConfig(config)); },

  addStreamRecord: (record) => {
    if (!get().coreDataLoaded) return { cleared: false, rejected: true, rejectedReason: '系统数据加载中，请稍后重试' };
    if (record.direction === 'sell') {
      const existing = get().tStreams.filter(s => s.fullCode === record.fullCode);
      if (existing.length === 0) {
        const baseAmount = get().positions.find(p => p.fullCode === record.fullCode && !p.isClosed)?.currentAmount ?? 0;
        const check = validateStreamTrade(null, baseAmount, 'sell', record.price, record.amount, true);
        if (!check.valid) return { cleared: false, rejected: true, rejectedReason: check.error };
      }
    }
    const { tStreams, feeConfig, tRounds, positions } = get();
    const rawNext = [...tStreams, record];
    const normalized = normalizeShortTDeductions(rawNext, positions);
    const baseCosts = buildBasePositionCosts(normalized.positions);
    const results = processAllStreams(normalized.streams, feeConfig, baseCosts);
    const stream = results.find(r => r.fullCode === record.fullCode);
    const rounds = stream ? archiveRoundIfCleared(stream, tRounds) : tRounds;
    set({ tStreams: normalized.streams, tRounds: rounds, positions: normalized.positions });
    safePersist(async () => { await putTStream(record); const nr = rounds.find(r => !tRounds.some(tr => tr.id === r.id)); if (nr) await putTRound(nr); for (const np of normalized.positions) { const old = positions.find(p => p.id === np.id); if (old && (old.currentAmount !== np.currentAmount || old.isClosed !== np.isClosed)) await putPosition(np); } });
    return { cleared: stream?.status === 'CLEARED', netProfit: stream?.transferProfit, avgPrice: stream?.avgPrice };
  },

  removeStreamRecord: (id) => {
    const { tStreams, feeConfig, tRounds, positions } = get();
    const filtered = tStreams.filter(s => s.id !== id);
    const normalized = normalizeShortTDeductions(filtered, positions);
    const baseCosts = buildBasePositionCosts(normalized.positions);
    const results = processAllStreams(normalized.streams, feeConfig, baseCosts);
    let rounds = [...tRounds];
    for (const r of results) { if (r.status === 'CLEARED') rounds = archiveRoundIfCleared(r, rounds); }
    set({ tStreams: normalized.streams, tRounds: rounds, positions: normalized.positions });
    safePersist(async () => { await deleteTStream(id); const nr = rounds.find(r => !tRounds.some(tr => tr.id === r.id)); if (nr) await putTRound(nr); for (const np of normalized.positions) { const old = positions.find(p => p.id === np.id); if (old && (old.currentAmount !== np.currentAmount || old.isClosed !== np.isClosed)) await putPosition(np); } });
  },

  updateStreamRecord: (id, updates) => {
    const { tStreams, feeConfig, tRounds, positions } = get();
    const updatedStreams = tStreams.map(st => st.id === id ? { ...st, ...updates } : st);
    const normalized = normalizeShortTDeductions(updatedStreams, positions);
    const baseCosts = buildBasePositionCosts(normalized.positions);
    const results = processAllStreams(normalized.streams, feeConfig, baseCosts);
    let rounds = [...tRounds];
    for (const r of results) { if (r.status === 'CLEARED') rounds = archiveRoundIfCleared(r, rounds); }
    set({ tStreams: normalized.streams, tRounds: rounds, positions: normalized.positions });
    const updated = normalized.streams.find(s => s.id === id);
    safePersist(async () => {
      if (updated) await putTStream(updated);
      const nr = rounds.find(r => !tRounds.some(tr => tr.id === r.id));
      if (nr) await putTRound(nr);
      for (const np of normalized.positions) {
        const old = positions.find(p => p.id === np.id);
        if (old && (old.currentAmount !== np.currentAmount || old.isClosed !== np.isClosed))
          await putPosition(np);
      }
    });
  },
  clearStreams: () => { const ids = get().tStreams.map(s => s.id); const oldPositions = get().positions; const fixedPositions = oldPositions.map(p => { const batchAmount = p.batches.reduce((sum, b) => sum + b.amount, 0); if (batchAmount !== p.currentAmount) { return { ...p, currentAmount: batchAmount, isClosed: batchAmount <= 0 }; } return p; }); const changed = fixedPositions.filter((p, i) => p !== oldPositions[i]); set({ tStreams: [], positions: fixedPositions }); safePersist(async () => { await bulkDeleteTStreams(ids); for (const p of changed) { await putPosition(p); } }); },

  importLegacyTRecords: () => {
    const { tRecords } = get(); if (tRecords.length === 0) return 0;
    const converted: TStreamRecord[] = [];
    for (const r of tRecords) {
      if (r.buyPrice > 0 && r.buyAmount > 0) converted.push({ id: `${r.id}-buy`, timestamp: r.timestamp, fullCode: r.fullCode, stockName: r.stockName, direction: 'buy', price: r.buyPrice, amount: r.buyAmount, fee: 0, note: `${r.mode === 'long' ? '正T' : '倒T'}买入（历史导入）`, quoteId: r.quoteId, selectedStock: r.selectedStock });
      if (r.sellPrice > 0 && r.sellAmount > 0) converted.push({ id: `${r.id}-sell`, timestamp: r.timestamp, fullCode: r.fullCode, stockName: r.stockName, direction: 'sell', price: r.sellPrice, amount: r.sellAmount, fee: 0, note: `${r.mode === 'long' ? '正T' : '倒T'}卖出（历史导入）`, quoteId: r.quoteId, selectedStock: r.selectedStock });
    }
    set(s => ({ tStreams: [...s.tStreams, ...converted] }));
    safePersist(async () => { for (const st of converted) await putTStream(st); });
    return converted.length;
  },

  validateSellWithPosition: (stockFullCode, _direction, _price, amount) => {
    const existing = get().tStreams.filter(s => s.fullCode === stockFullCode);
    if (existing.length > 0) return { valid: true, maxSellable: 999999999 };
    const baseAmount = get().positions.find(p => p.fullCode === stockFullCode && !p.isClosed)?.currentAmount ?? 0;
    return validateStreamTrade(null, baseAmount, 'sell', 0, amount, true);
  },

  addRound: (round) => { set(s => ({ tRounds: [...s.tRounds, round] })); safePersist(() => putTRound(round)); },

  removeRound: (id) => {
    const state = get(); const round = state.tRounds.find(r => r.id === id);
    if (!round) return { ok: false, message: '战报不存在或已被删除' };
    let nextPositions = state.positions;
    if (round.transferAmount && round.transferAmount > 0) {
      const rb = rollbackTransferPosition(state.positions, round.fullCode, round.transferAmount, round.avgPrice ?? 0);
      if (!rb.ok) return { ok: false, message: rb.message };
      nextPositions = rb.positions;
    }
    set({
      tRounds: state.tRounds.filter(r => r.id !== id),
      positions: nextPositions,
      longTermRecords: state.longTermRecords.filter(r => r.sourceReportId !== id && r.id !== id),
    });
    safePersist(() => deleteRoundWithCascade(id, id, nextPositions));
    return { ok: true };
  },

  clearRounds: () => { const ids = get().tRounds.map(r => r.id); set({ tRounds: [] }); safePersist(async () => { for (const id of ids) await deleteTRoundWithTransactions(id); }); },

  transferToPosition: (fullCode, transferAmount, transferPrice) => {
    const { tStreams, tRounds, positions, feeConfig } = get();
    const baseCosts = buildBasePositionCosts(positions);
    const streams = tStreams.filter(s => s.fullCode === fullCode);
    if (streams.length === 0) return { ok: false, message: '该股票没有做T流水，无法划转' };
    const result = processAllStreams(streams, feeConfig, baseCosts).find(r => r.fullCode === fullCode);
    const stream = result ?? processStockStream(streams, feeConfig, baseCosts.get(fullCode));
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
    const totalBefore = posDef.currentAmount; const investedBefore = posDef.totalInvested ?? 0;
    const addInvested = avg * addQty + txnFee; const newAmount = totalBefore + addQty;
    const newInvested = investedBefore + addInvested; const newCost = newAmount > 0 ? newInvested / newAmount : 0;
    const batch: PositionBatch = { id: generateId(), timestamp: now, type: 'add', price: avg, amount: addQty, costAfter: newCost, amountAfter: newAmount, note: `做T划转底仓（P_avg=${avg}）`, fee: txnFee };
    if (created) {
      const ob: PositionBatch = { id: generateId(), timestamp: now, type: 'open', price: avg, amount: addQty, costAfter: newCost, amountAfter: newAmount, note: `做T划转新建底仓（P_avg=${avg}）`, fee: txnFee };
      newPositions = [...newPositions, { ...posDef, currentCost: newCost, currentAmount: newAmount, totalInvested: newInvested, batches: [ob] }];
    } else {
      newPositions = newPositions.map(p => p.id === posDef.id ? { ...p, currentCost: newCost, currentAmount: newAmount, totalInvested: newInvested, batches: [...p.batches, batch] } : p);
    }
    const maxRound = tRounds.filter(r => r.fullCode === fullCode).reduce((m, r) => Math.max(m, r.roundNo), 0);
    const archiveRound: TRoundArchive = { id: generateId(), fullCode, stockName: stream.stockName, mode: stream.mode, roundNo: maxRound + 1, settleType: 'partial', transactions: stream.entries.map(e => ({ id: e.id, timestamp: e.timestamp, direction: e.direction, price: e.price, amount: e.amount, fee: e.fee, realizedProfit: e.realizedProfit ?? 0, note: e.note })), netProfit: stream.transferProfit, totalFees: stream.totalFee, sellAmount: stream.realizedSellAmount, avgPrice: stream.avgPrice, buyAmount: stream.buyAmount, tradeCount: stream.tradeCount, holdingDays: stream.holdingDays, win: stream.transferProfit >= 0, openedAt: stream.openedAt ?? stream.entries[0]?.timestamp ?? now, closedAt: now, transferAmount: toTransfer };
    const ltRecord: LongTermRecord = { id: generateId(), fullCode, stockName: stream.stockName, timestamp: now, type: 'merge', price: avg, amount: toTransfer, fee: txnFee, sourceReportId: archiveRound.id, note: `做T划转底仓（第${maxRound + 1}轮）` };
    set(s => ({ tStreams: s.tStreams.filter(st => st.fullCode !== fullCode), tRounds: [...s.tRounds, archiveRound], positions: newPositions, longTermRecords: [...s.longTermRecords, ltRecord] }));
    safePersist(() => completeRoundWithMerge(fullCode, streams.map(st => st.id), archiveRound, ltRecord, newPositions));
    return { ok: true, message: `已将 ${toTransfer} 股划转至底仓（P_avg=${avg.toFixed(2)}）` };
  },

  settleShortRound: (fullCode) => {
    const { tStreams, tRounds, feeConfig, positions } = get();
    const baseCosts = buildBasePositionCosts(positions);
    const streams = tStreams.filter(s => s.fullCode === fullCode);
    if (streams.length === 0) return { ok: false, message: '没有可结算的倒T流水' };
    const result = processAllStreams(streams, feeConfig, baseCosts).find(r => r.fullCode === fullCode);
    if (!result || result.mode !== 'short') return { ok: false, message: '当前不是倒T模式' };
    const now = new Date().toISOString();
    const maxRound = tRounds.filter(r => r.fullCode === fullCode).reduce((m, r) => Math.max(m, r.roundNo), 0);
    const round: TRoundArchive = { id: generateId(), fullCode, stockName: result.stockName, mode: 'short', roundNo: maxRound + 1, settleType: result.shortPendingAmount === 0 ? 'clear' : 'partial', transactions: result.entries.map(e => ({ id: e.id, timestamp: e.timestamp, direction: e.direction, price: e.price, amount: e.amount, fee: e.fee, realizedProfit: e.realizedProfit ?? 0, note: e.note })), netProfit: result.transferProfit, totalFees: result.totalFee, sellAmount: result.realizedSellAmount, avgPrice: result.avgPrice, buyAmount: result.buyAmount, tradeCount: result.tradeCount, holdingDays: result.holdingDays, win: result.transferProfit >= 0, openedAt: result.openedAt ?? result.entries[0]?.timestamp ?? now, closedAt: now };
    set(s => ({ tStreams: s.tStreams.filter(st => st.fullCode !== fullCode), tRounds: [...s.tRounds, round] }));
    safePersist(() => completeRoundClear(fullCode, streams.map(st => st.id), round));
    return { ok: true, message: `倒T已结算，净收益 ¥${result.transferProfit.toFixed(2)}` };
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

  exportData: () => { const state = get(); return { version: EXPORT_VERSION, feeConfig: state.feeConfig, tRecords: state.tRecords, tStreams: state.tStreams, tRounds: state.tRounds, positions: state.positions, stocks: state.stocks, longTermRecords: state.longTermRecords }; },

  importData: (data) => {
    set({ feeConfig: data.feeConfig, tRecords: data.tRecords ?? [], tStreams: data.tStreams ?? [], tRounds: data.tRounds ?? [], positions: data.positions ?? [], stocks: data.stocks ?? [], longTermRecords: data.longTermRecords ?? [] });
    safePersist(() => safeImportAllData(data.feeConfig, data.positions ?? [], data.tRounds ?? [], data.tStreams ?? [], data.stocks ?? [], data.longTermRecords ?? []));
  },

  exportJSON: async () => {
    const state = get();
    const [closedPositions, completedRounds, ltRecs] = await Promise.all([
      import('../db/index').then(m => m.fetchAllClosedPositions()),
      import('../db/index').then(m => m.fetchAllCompletedRounds()),
      import('../db/index').then(m => m.fetchAllLongTermRecords()),
    ]);
    return { version: EXPORT_VERSION, feeConfig: state.feeConfig, tRecords: state.tRecords, tStreams: state.tStreams, tRounds: [...state.tRounds, ...completedRounds], positions: [...state.positions, ...closedPositions], stocks: state.stocks, longTermRecords: [...state.longTermRecords, ...ltRecs] };
  },

  importJSON: (data) => {
    if (data.version !== EXPORT_VERSION) console.warn(`[Store] 导入数据版本 (${data.version}) 与当前版本 (${EXPORT_VERSION}) 不一致，尝试继续导入，但部分字段可能不兼容。`);
    get().importData(data);
  },

  exportCSV: () => {
    const records = get().tRecords;
    const headers = ['日期', '股票名称', '模式', '买入价', '买入数量', '卖出价', '卖出数量', '摩擦成本', '净利润', '收益率', '状态'];
    const rows = records.map(r => [new Date(r.timestamp).toLocaleDateString(), r.stockName, r.mode === 'long' ? '正T' : '倒T', String(r.buyPrice), String(r.buyAmount), String(r.sellPrice), String(r.sellAmount), String(r.totalFee), r.netProfit !== null ? String(r.netProfit) : '--', r.profitRate !== null ? String(r.profitRate) : '--', r.status === 'CLOSED' ? '已平仓' : '未平仓']);
    return [headers.join(','), ...rows.map(row => row.map(cell => `"${cell}"`).join(','))].join('\n');
  },
}));
