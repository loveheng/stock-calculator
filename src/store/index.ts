/**
 * @file index.ts
 * @description AppStore 组装层：定义初始状态，按 feature 装配各 action 切片
 *              （core / streams / rounds / positions / orders / io），并保留
 *              自动同步监听（initAutoSync）与向后兼容的 re-export 出口。
 *
 *              v8.1 拆分：action 实现体已按 feature 迁至 ./slices/*Slice.ts，
 *              对账引擎与跨切片共享辅助迁至 ./reconcile.ts，持久化军械在 ./persistence.ts，
 *              费率模板在 ../utils/feePresets.ts —— 新增功能请优先新建切片，避免本文件再膨胀。
 * @layer Store
 * @author 开发团队
 */

import { create } from 'zustand';
import { DEFAULT_FEE_CONFIG } from '../utils/feePresets';
import type { AppStore } from './types';
import { createCoreSlice } from './slices/coreSlice';
import { createStreamsSlice } from './slices/streamsSlice';
import { createRoundsSlice } from './slices/roundsSlice';
import { createPositionsSlice } from './slices/positionsSlice';
import { createOrdersSlice } from './slices/ordersSlice';
import { createIoSlice } from './slices/ioSlice';
import { createCopilotSlice } from './slices/copilotSlice';
import { createCopilotActionSlice } from './slices/copilotActionSlice';
import { createHomeSlice } from './slices/homeSlice';
import { getIsSyncingFromRemote } from './persistence';
import { loadCopilotTombstones, loadCopilotConsent } from '../services/copilotService';
import { getWebDAVConfig, scheduleBackup } from '../services/webdavSync';

// Re-export all types for backward compatibility
export type {
  PositionBatch,
  Position,
  RoundTxn,
  TRoundArchive,
  LongTermRecord,
  PlannedOrder,
  FeePresetName,
  StreamAddResult,
  AppStoreExport,
  AppStore,
} from './types';
export { EXPORT_VERSION } from './types';
export { generateId, buildBasePositionCosts, getCloseBlockReason, activeStreamsFromRounds, calcPlanComparison, calcBatchExecution } from './utils';
export { recomputePositionSnapshot } from '../utils/calculator';
// useStreamResults 已迁移至 hooks/useStreamResults.ts：Hook 依赖 useAppStore，
// 不能经本桶 re-export（否则 store/index → hooks → store/index 循环），消费方请直接从 hooks 导入
export { DEFAULT_FEE_CONFIG, FEE_PRESETS, FEE_TEMPLATES } from '../utils/feePresets';
export { getPersistError, clearPersistError, getIsSyncingFromRemote } from './persistence';
export type { TStreamRecord, StockStreamResult } from '../utils/tStreamEngine';
export { reconcilePositionsWithStreams } from './reconcile';

export const useAppStore = create<AppStore>()((...a) => ({
  feeConfig: { ...DEFAULT_FEE_CONFIG }, tRounds: [],
  positions: [], stocks: [], longTermRecords: [], plannedOrders: [], coreDataLoaded: false,
  persistError: null,
  // Copilot（P0）：墓碑/知情同意从 localStorage 恢复，其余为内存态初值
  registry: {}, threads: {}, sending: false, activeScopeId: null, lastArchived: null,
  focusedBlock: null,
  // Copilot 动作后处理（V1 Action Pipeline）：全内存态，刷新即失
  copilotNotice: null, pendingCopilotActions: [],
  // 事实数据变动提示（P2）：scope → 上次提问时快照相对上上轮是否变化
  contextChangedScopes: {},
  deletedScopes: loadCopilotTombstones(), consentAcknowledged: loadCopilotConsent(), copilotOpen: false,
  // 首页时间 Tab（视图偏好上提：区块快照经 getState() 同源读取，R2）
  homeTimeRange: '7d',

  ...createCoreSlice(...a),
  ...createStreamsSlice(...a),
  ...createRoundsSlice(...a),
  ...createPositionsSlice(...a),
  ...createOrdersSlice(...a),
  ...createIoSlice(...a),
  ...createCopilotSlice(...a),
  ...createCopilotActionSlice(...a),
  ...createHomeSlice(...a),
}));

/**
 * 初始化自动同步：监听 Zustand Store 状态变化，
 * 当 autoSync 开启且有数据变更时，自动触发 WebDAV 备份。
 *
 * 安全机制（从外到内）：
 * 1. `coreDataLoaded` 守卫：冷启动加载阶段不触发，防止半载数据上传
 * 2. `isSyncingFromRemote` 守卫：远端同步导入时不触发，
 *    配合 importData 中的 setTimeout(0) 复位，防回环
 * 3. `autoSync` 配置开关：仅用户启用时生效
 * 4. 引用比较：仅 tRounds/positions/stocks/longTermRecords/feeConfig
 *    真正变化时触发，避免 coreDataLoaded/persistError 等元字段误触发
 * 5. `scheduleBackup` 防抖（800ms）：连续操作合并为一次上传
 * 6. `backupToWebDAV` 冷却（10s）+ Promise 互斥锁 + 跨标签 Web Locks：
 *    不产生并发 PUT，避免远端文件损坏
 *
 * @returns {() => void} 取消订阅函数（应用生命周期内无需调用）
 */
export function initAutoSync(): () => void {
  return useAppStore.subscribe((state, prevState) => {
    // ① 冷启动加载中，跳过
    if (!state.coreDataLoaded) return;

    // ② 远端同步导入进行中，跳过（防回环）
    if (getIsSyncingFromRemote()) return;

    // ③ 用户未开启自动同步，跳过
    const config = getWebDAVConfig();
    if (!config.autoSync) return;

    // ④ 检查数据是否真的变更（避免元字段变化误触发）
    if (
      state.tRounds === prevState.tRounds &&
      state.positions === prevState.positions &&
      state.stocks === prevState.stocks &&
      state.longTermRecords === prevState.longTermRecords &&
      state.feeConfig === prevState.feeConfig &&
      state.plannedOrders === prevState.plannedOrders
    ) {
      return;
    }

    // ⑤ 导出当前快照并调度备份
    //    scheduleBackup 内部有 800ms 防抖，
    //    backupToWebDAV 内部有 10s 冷却 + Promise 互斥锁 + Web Locks
    const snapshot = useAppStore.getState().exportData();
    scheduleBackup(snapshot);
  });
}
