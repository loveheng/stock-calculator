/**
 * @file bootstrap.ts
 * @description Store 启动引导：冷启动只从 IndexedDB 读取「设置」单行水合 Store，
 *              业务数据（notes）由视图挂载后经 useLoadCoreData 按需加载，降低首屏等待。
 *              水合完成后调用 markInitialLoadDone()，此后 safePersist 才真实落库。
 * @layer Store (Bootstrap)
 * @storage_impact 启动时仅读 settings 表（1 行）。
 * @author 骨架模板
 */

import { ensureDefaultData, loadSettingsFromDB } from '../db';
import { useAppStore } from './index';
import { markInitialLoadDone } from '../utils/persistence';

/**
 * 初始化应用 Store。
 *
 * @description ① ensureDefaultData() 确保设置单行存在；② loadSettingsFromDB() 读取设置写入 Store；
 *              ③ markInitialLoadDone() 打开持久化闸门。仅在启动时调用一次。
 */
export async function initStore(): Promise<void> {
  await ensureDefaultData();

  const settings = await loadSettingsFromDB();
  useAppStore.setState((current) => ({ ...current, settings }));

  markInitialLoadDone();
}
