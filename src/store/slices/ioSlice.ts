/**
 * @file ioSlice.ts
 * @description 备份/恢复切片：调用 services/backupService 做快照导出与整库导入。
 * @layer Store
 * @author 骨架模板
 */

import type { StateCreator } from 'zustand';
import { applySnapshot, buildSnapshot, parseSnapshot } from '../../services/backupService';
import type { AppStore } from '../types';

export interface IoSlice {
  exportData: () => ReturnType<typeof buildSnapshot>;
  importData: (text: string) => Promise<void>;
}

export const createIoSlice: StateCreator<AppStore, [], [], IoSlice> = (set, get) => ({
  exportData: () => buildSnapshot({ settings: get().settings, notes: get().notes }),

  importData: async (text) => {
    const snapshot = parseSnapshot(text);
    const notes = await applySnapshot(snapshot);
    set({ settings: snapshot.settings, notes });
  },
});
