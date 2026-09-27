/**
 * @file coreSlice.ts
 * @description 核心状态切片：首载完成标记等元状态。
 * @layer Store
 * @author 骨架模板
 */

import type { StateCreator } from 'zustand';
import type { AppStore } from '../types';

export interface CoreSlice {
  setCoreDataLoaded: (loaded: boolean) => void;
}

export const createCoreSlice: StateCreator<AppStore, [], [], CoreSlice> = (set) => ({
  setCoreDataLoaded: (loaded) => set({ coreDataLoaded: loaded }),
});
