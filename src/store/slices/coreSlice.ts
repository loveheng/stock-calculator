/**
 * @file coreSlice.ts
 * @description Store 核心切片：冷启动生命周期（loadPositions / loadTRounds / setCoreDataLoaded）
 *              与费率配置（setFeeConfig）。从 store/index.ts 拆出，index 只负责组装。
 * @layer Store (Slice)
 * @storage_impact load* 从 DB 读；setFeeConfig 经 safePersist 写 feeConfigs 表。
 * @author 开发团队
 */

import type { StateCreator } from 'zustand';
import { loadPositionsFromDB, loadTRoundsFromDB, putFeeConfig } from '../../db/index';
import { safePersist } from '../persistence';
import { recordAudit } from '../../risk/auditLogger';
import type { AppStore } from '../types';

export type CoreSlice = Pick<
  AppStore,
  'loadPositions' | 'loadTRounds' | 'setCoreDataLoaded' | 'setFeeConfig'
>;

export const createCoreSlice: StateCreator<AppStore, [], [], CoreSlice> = (set, get) => ({
  loadPositions: async () => { const positions = await loadPositionsFromDB(); if (positions.length) set(s => ({ positions: [...s.positions.filter(p => !positions.some(np => np.id === p.id)), ...positions] })); },
  loadTRounds: async () => { const rounds = await loadTRoundsFromDB(); if (rounds.length) set(s => ({ tRounds: [...s.tRounds.filter(r => !rounds.some(nr => nr.id === r.id)), ...rounds] })); },
  setCoreDataLoaded: (loaded: boolean) => { set({ coreDataLoaded: loaded }); },

  setFeeConfig: (partial) => { set(s => ({ feeConfig: { ...s.feeConfig, ...partial } })); safePersist(() => putFeeConfig(get().feeConfig)); recordAudit('set_fee_config', 'system', 'fee-config', 'success', { after: { ...partial } }); },
});
