/**
 * @file bootstrap.ts
 * @description Store 启动引导：应用启动时仅从 IndexedDB 加载费率配置到 Zustand Store。
 *              从 db/storeInit.ts 迁入 —— 「水合 Store」是 Store 层职责，放在 DAO 层会形成
 *              DAO → Store 的反向运行期依赖（原循环依赖链
 *              store/index → risk/auditLogger → store/persistence → db/storeInit → store/index 的一环）。
 *              v7 语义保持：冷启动只加载 feeConfig，其余数据由各视图通过 useDataLoader 按需加载。
 * @layer Store (Bootstrap)
 * @storage_impact 启动时仅读取 feeConfigs 表（1 行），不加载 positions / tRounds / stocks 等数据。
 * @author 开发团队
 */

import { ensureDefaultData, loadFeeConfigFromDB } from '../db';
import { useAppStore } from './index';
import { markInitialLoadDone } from './persistence';

/**
 * 初始化应用 Store：仅冷启动加载费率配置，其余数据由各视图按需加载。
 *
 * @description 执行顺序：① ensureDefaultData() 确保现金账户与费率配置单行存在；
 *              ② loadFeeConfigFromDB() 冷启动加载费率配置（仅 1 行），存在则写入 Store；
 *              ③ 标记 initialLoadDone（标志本体在 store/persistence.ts），
 *              此后 safePersist 才开始真实落库。
 * @note 仅在启动时调用一次（main.tsx bootstrap / 集成测试 beforeEach）
 */
export async function initStore(): Promise<void> {
  await ensureDefaultData();

  const feeConfig = await loadFeeConfigFromDB();
  if (feeConfig) {
    useAppStore.setState((current) => ({
      ...current,
      feeConfig,
    }));
  }

  markInitialLoadDone();
}
