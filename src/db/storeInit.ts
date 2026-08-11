/**
 * @file storeInit.ts
 * @description Store 初始化与持久化桥接层：应用启动时从 IndexedDB 全量装载数据到 Zustand Store。
 *              v4 重构：移除全量覆盖写订阅（startStorePersistence），改用 Store Action 内增量写库。
 * @layer DAO
 * @storage_impact 读取 IndexedDB 的 feeConfigs / positions / positionBatches / tRounds / tTransactions / stocks 表。
 * @author 开发团队
 */

// ============================================================
// Store Initialization – Load from IndexedDB.
// Persistence is now handled incrementally inside Zustand actions.
// ============================================================

import {
  ensureDefaultData,
  loadAllFromDB,
  type FeeConfigRow,
  type LongTermRecordRow,
  type PositionRow,
  type TRoundRow,
  type TStreamRow,
  type StockRow,
} from './index';
import { useAppStore, DEFAULT_FEE_CONFIG, type AppStore } from '../store';

/** 标记：首次初始化加载是否已完成；未完成前禁止触发任何向 DB 的写入操作 */
let initialLoadDone = false;

/**
 * 查询初始化加载是否已完成。
 * 供 Store Action 在写库前作为防护检查。
 */
export function isInitialLoadDone(): boolean {
  return initialLoadDone;
}

/**
 * 初始化应用 Store：确保默认行 → 全量装载 DB → 注入 Store 状态。
 *
 * @description 执行顺序：① ensureDefaultData() 确保现金账户与费率配置单行存在；
 *              ② loadAllFromDB() 全量读取各表；
 *              ③ 若任一数据源非空，则 setState 覆盖当前 Store（feeConfig / positions / tRounds / tStreams / stocks / longTermRecords）。
 * @returns {Promise<void>}
 * @note 仅在启动时调用一次；装载完成后将 initialLoadDone 置 true，后续 Store Action 才开始增量写库
 */
export async function initStore(): Promise<void> {
  await ensureDefaultData();

  const { feeConfig, positions, tRounds, tStreams, stocks, longTermRecords } = await loadAllFromDB();

  if (feeConfig || positions.length > 0 || tRounds.length > 0 || tStreams.length > 0 || stocks.length > 0 || longTermRecords.length > 0) {
    useAppStore.setState((current) => ({
      ...current,
      feeConfig: (feeConfig as FeeConfigRow) ?? { ...DEFAULT_FEE_CONFIG },
      positions: (positions as unknown as AppStore['positions']) ?? [],
      tRounds: (tRounds as unknown as AppStore['tRounds']) ?? [],
      tStreams: (tStreams as unknown as AppStore['tStreams']) ?? [],
      stocks: (stocks as unknown as AppStore['stocks']) ?? [],
      longTermRecords: (longTermRecords as unknown as AppStore['longTermRecords']) ?? [],
    }));
  }

  initialLoadDone = true;
}
