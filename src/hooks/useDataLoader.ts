/**
 * @file useDataLoader.ts
 * @description 按需加载钩子：应用挂载后异步加载业务数据，避免冷启动全量读库。
 *              使用 useCallback(useAppStore.getState().xxx, []) 稳定函数引用，
 *              消除因 Selector 每次返回新引用导致的 useEffect 重复触发竞态。
 * @layer Hooks
 * @storage_impact 仅读取 IndexedDB，不直接写入。
 * @author 骨架模板
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';

/**
 * 加载核心数据（笔记）。
 *
 * @description 在 AppLayout 挂载时调用一次；加载完成后置 coreDataLoaded = true，
 *              供 Store Action 做防护检查。加载失败也标记为已加载，避免用户被永久阻塞。
 * @returns {{ loading: boolean }} 加载状态
 */
export function useLoadCoreData(): { loading: boolean } {
  const loaded = useRef(false);
  const [loading, setLoading] = useState(true);

  const loadNotes = useCallback(useAppStore.getState().loadNotes, []);
  const setCoreDataLoaded = useCallback(useAppStore.getState().setCoreDataLoaded, []);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    setLoading(true);
    loadNotes()
      .then(() => {
        setCoreDataLoaded(true);
        setLoading(false);
      })
      .catch((err) => {
        console.error('[DataLoader] Failed to load core data:', err);
        setCoreDataLoaded(true);
        setLoading(false);
      });
  }, [loadNotes, setCoreDataLoaded]);

  return { loading };
}
