/**
 * @file storeInit.ts
 * @description Store 初始化与持久化桥接层：应用启动时仅从 IndexedDB 加载费率配置到 Zustand Store。
 *              v7 重构：彻底采用按需加载模式，冷启动只加载 feeConfig，其他数据由各视图通过 useDataLoader 钩子按需加载。
 * @layer DAO
 * @storage_impact 启动时仅读取 feeConfigs 表（1 张），不再加载 positions / tRounds / stocks 等数据。
 * @author 开发团队
 */

// ============================================================
// Store Initialization – Minimal Cold Start.
// Persistence is now handled incrementally inside Zustand actions.
// Data loading is deferred to view-level hooks (useDataLoader).
// ============================================================

import {
  ensureDefaultData,
  loadFeeConfigFromDB,
} from './index';
import { useAppStore, DEFAULT_FEE_CONFIG } from '../store';

/** 标记：首次初始化加载是否已完成；未完成前禁止触发任何向 DB 的写入操作 */
let initialLoadDone = false;

/**
 * 查询初始化加载是否已完成。
 *
 * 供 Store Action 在写库前作为防护检查。
 */
export function isInitialLoadDone(): boolean {
  return initialLoadDone;
}

/**
 * 初始化应用 Store：仅冷启动加载费率配置，其余数据由各视图按需加载。
 *
 * @description 执行顺序：① ensureDefaultData() 确保现金账户与费率配置单行存在；
 *              ② loadFeeConfigFromDB() 冷启动加载费率配置（仅 1 行）；
 *              ③ 若 feeConfig 存在，则 setState 更新 Store。
 *              ④ positions / tRounds / stocks 等数据由各视图通过 useDataLoader 钩子按需加载。
 * @returns {Promise<void>}
 * @note 仅在启动时调用一次；装载完成后将 initialLoadDone 置 true，后续 Store Action 才开始增量写库
 */
export async function initStore(): Promise<void> {
  await ensureDefaultData();

  const feeConfig = await loadFeeConfigFromDB();

  if (feeConfig) {
    useAppStore.setState((current) => ({
      ...current,
      feeConfig: feeConfig ?? { ...DEFAULT_FEE_CONFIG },
    }));
  }

  initialLoadDone = true;
}
