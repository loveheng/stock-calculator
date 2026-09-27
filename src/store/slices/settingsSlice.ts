/**
 * @file settingsSlice.ts
 * @description 设置切片：单行设置的读取与增量保存。
 * @layer Store
 * @author 骨架模板
 */

import type { StateCreator } from 'zustand';
import { loadSettingsFromDB, saveSettingsToDB } from '../../db';
import type { AppSettings } from '../../types/domain';
import { safePersist } from '../../utils/persistence';
import type { AppStore } from '../types';

export interface SettingsSlice {
  loadSettings: () => Promise<void>;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

export const createSettingsSlice: StateCreator<AppStore, [], [], SettingsSlice> = (set, get) => ({
  loadSettings: async () => {
    const settings = await loadSettingsFromDB();
    set({ settings });
  },

  saveSettings: async (patch) => {
    const next: AppSettings = { ...get().settings, ...patch };
    set({ settings: next });
    await safePersist(() => saveSettingsToDB(next));
  },
});
