/**
 * @file index.ts
 * @description AppStore 组装层：定义初始状态，按 feature 装配各 Action 切片
 *              （core / notes / settings / io）。新增功能请优先新建切片，避免本文件膨胀。
 * @layer Store
 * @author 骨架模板
 */

import { create } from 'zustand';
import { DEFAULT_SETTINGS } from '../types/domain';
import { clearPersistError, getPersistError } from '../utils/persistence';
import type { AppStore } from './types';
import { createCoreSlice } from './slices/coreSlice';
import { createNotesSlice } from './slices/notesSlice';
import { createSettingsSlice } from './slices/settingsSlice';
import { createIoSlice } from './slices/ioSlice';

export type { AppSettings, AppSnapshot, Note } from '../types/domain';
export type { AppStore } from './types';
export { clearPersistError, getPersistError } from '../utils/persistence';

export const useAppStore = create<AppStore>()((...a) => ({
  // ---- 初始状态 ----
  notes: [],
  settings: { ...DEFAULT_SETTINGS },
  coreDataLoaded: false,

  // ---- 切片装配 ----
  ...createCoreSlice(...a),
  ...createNotesSlice(...a),
  ...createSettingsSlice(...a),
  ...createIoSlice(...a),
}));
