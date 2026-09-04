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
import { cancelServerBackup, scheduleServerBackup } from '../services/serverSync';
import { useAuthStore } from './useAuthStore';
import { buildServerSyncGate, markServerPushPending } from './slices/ioSlice';

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

  // 服务端密文同步（M3）：UI 态初值（编排状态在 services/ioSlice 模块级）
  serverSyncing: false, serverLastVersion: null, serverLastError: null,

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
 * 3. 引用比较：仅 tRounds/positions/stocks/longTermRecords/feeConfig/plannedOrders
 *    真正变化时触发，避免 coreDataLoaded/persistError 等元字段误触发
 * 4. 双通道分流：
 *    - WebDAV：仅用户开启 autoSync 时 scheduleBackup（800ms 防抖 + 10s 冷却 + 互斥）
 *    - 服务端密文同步：登录即备份，scheduleServerBackup（门控在管线内判定，不依赖 WebDAV 配置）
 *
 * @returns {() => void} 取消订阅函数（应用生命周期内无需调用）
 */
export function initAutoSync(): () => void {
  return useAppStore.subscribe((state, prevState) => {
    // ① 冷启动加载中，跳过
    if (!state.coreDataLoaded) return;

    // ② 远端同步导入进行中，跳过（防回环）
    if (getIsSyncingFromRemote()) return;

    // ③ 检查数据是否真的变更（避免元字段变化误触发）
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

    // ④ 导出当前快照并调度双通道备份
    const snapshot = useAppStore.getState().exportData();

    // 通道一：WebDAV（用户开启 autoSync 才触发，原逻辑不变）
    if (getWebDAVConfig().autoSync) scheduleBackup(snapshot);

    // 通道二：服务端密文同步（登录即备份；门控在管线内判定，D9 空快照守卫在 doPush 内）
    markServerPushPending();
    scheduleServerBackup(
      snapshot,
      buildServerSyncGate(() => useAppStore.getState().pushServerSnapshot()),
    );
  });
}

/**
 * 初始化服务端密文同步的启动对账（M3）：监听 auth store，
 * 登录完成 / MEK 解封可用（isAuthenticated && mek）时执行一次 §7.3 决策树；
 * 登出时取消挂起中的服务端防抖推送。
 *
 * @returns {() => void} 取消订阅函数（应用生命周期内无需调用）
 */
export function initServerSync(): () => void {
  return useAuthStore.subscribe((state, prevState) => {
    const ready = state.isAuthenticated && !!state.mek;
    const wasReady = prevState.isAuthenticated && !!prevState.mek;
    if (ready && !wasReady) {
      void useAppStore.getState().startupServerSyncCheck();
    }
    if (!ready && wasReady) {
      cancelServerBackup();
    }
  });
}
