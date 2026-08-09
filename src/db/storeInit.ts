/**
 * @file storeInit.ts
 * @description Store 初始化与持久化桥接层：应用启动时从 IndexedDB 全量装载数据到 Zustand Store，
 *              并在 Store 状态变更后自动订阅回写（含旧 LocalStorage 数据迁移）。
 * @layer DAO
 * @storage_impact 读取 IndexedDB 的 feeConfigs / positions / positionBatches / tRounds / tTransactions / stocks 表；
 *                 通过 saveAllToDB 将 Store 状态整体覆盖回写（先清空后写入）。
 * @author 开发团队
 */

// ============================================================
// Store Initialization – Load from IndexedDB, then subscribe
// to state changes for automatic persistence back to Dexie.
// ============================================================

import { migrateFromLocalStorage } from './migration';
import {
  ensureDefaultData,
  loadAllFromDB,
  saveAllToDB,
  type FeeConfigRow,
  type PositionRow,
  type TRoundRow,
  type TStreamRow,
  type StockRow,
} from './index';
import { useAppStore, DEFAULT_FEE_CONFIG, type AppStore } from '../store';

/** 标记：首次初始化加载是否已完成；未完成前不触发持久化订阅回写，避免覆盖初始数据 */
let initialLoadDone = false;

/**
 * 初始化应用 Store：迁移旧数据 → 确保默认行 → 全量装载 DB → 注入 Store 状态。
 *
 * @description 执行顺序：① migrateFromLocalStorage() 将旧 LocalStorage 数据迁入 IndexedDB；
 *              ② ensureDefaultData() 确保现金账户与费率配置单行存在；
 *              ③ loadAllFromDB() 全量读取各表；
 *              ④ 若任一数据源非空，则 setState 覆盖当前 Store（feeConfig / positions / tRounds / tStreams / stocks）。
 * @returns {Promise<void>}
 * @note 仅在启动时调用一次；装载完成后将 initialLoadDone 置 true，后续 Store 变更才开始持久化
 */
export async function initStore(): Promise<void> {
  await migrateFromLocalStorage();
  await ensureDefaultData();

  const { feeConfig, positions, tRounds, tStreams, stocks } = await loadAllFromDB();

  if (feeConfig || positions.length > 0 || tRounds.length > 0 || tStreams.length > 0 || stocks.length > 0) {
    useAppStore.setState((current) => ({
      ...current,
      feeConfig: (feeConfig as FeeConfigRow) ?? { ...DEFAULT_FEE_CONFIG },
      positions: (positions as unknown as AppStore['positions']) ?? [],
      tRounds: (tRounds as unknown as AppStore['tRounds']) ?? [],
      tStreams: (tStreams as unknown as AppStore['tStreams']) ?? [],
      stocks: (stocks as unknown as AppStore['stocks']) ?? [],
    }));
  }

  initialLoadDone = true;
}

/**
 * 启动 Store 自动持久化订阅，返回取消订阅函数。
 *
 * @description 订阅 useAppStore 全部状态变更；initialLoadDone 为 true 时，
 *              将当前 feeConfig / positions / tRounds / tStreams / stocks 整体写回 IndexedDB。
 * @returns {() => void} 取消订阅函数（组件卸载或应用关闭时调用）
 * @note 写库失败仅 console.error 记录，不阻断 UI；全量覆盖写，保证内存状态与 DB 一致
 */
export function startStorePersistence(): () => void {
  return useAppStore.subscribe((state) => {
    if (!initialLoadDone) return;

    saveAllToDB(
      (state.feeConfig as FeeConfigRow),
      (state.positions as unknown as PositionRow[]),
      (state.tRounds as unknown as TRoundRow[]),
      (state.tStreams as unknown as TStreamRow[]),
      (state.stocks as unknown as StockRow[]),
    ).catch((err) => {
      console.error('[StorePersistence] Failed to save to IndexedDB:', err);
    });
  });
}