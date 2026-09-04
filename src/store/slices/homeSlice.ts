/**
 * @file homeSlice.ts
 * @description 首页仪表盘视图偏好切片。timeRange 自组件 useState 上提的原因：
 *              V2 Click-to-Focus 区块级快照必须由纯函数经 useAppStore.getState()
 *              同源重算（R2 护栏：快照严禁读取视图组件局部 useState / hook 闭包），
 *              因此时间 Tab 属于跨层共享状态，落 Store 由视图与快照 builder 共同消费。
 * @layer Store (Slice)
 * @storage_impact 内存态，不持久化（刷新回默认 '7d'，与视图初始 Tab 对齐）。
 * @author 开发团队
 */

import type { StateCreator } from 'zustand';
import type { AppStore } from '../types';
import type { HomeTimeRange } from '../../types/domain';

export type HomeSlice = Pick<AppStore, 'setHomeTimeRange'>;

export const createHomeSlice: StateCreator<AppStore, [], [], HomeSlice> = (set) => ({
  setHomeTimeRange: (range: HomeTimeRange) => set({ homeTimeRange: range }),
});
