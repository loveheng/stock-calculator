/**
 * @file useDataLoader.ts
 * @description 应用冷启动的核心数据加载钩子：各视图通过 store 加载自身所需数据，
 *              冷启动仅加载 feeConfig，核心数据（tRounds / positions）在 AppLayout
 *              挂载时由 useLoadCoreData 异步加载，避免首屏全量加载，降低首屏时间与内存占用。
 *              v6.1 修复：使用 useCallback(useAppStore.getState().loadXxx, [])
 *              稳定函数引用，消除因 Zustand Selector 每次创建新引用导致的
 *              useEffect 重复触发竞态条件。
 *              v8：tStreams 表移除，流水随 OPENED Round 的 transactions 加载。
 * @layer Hooks
 * @storage_impact 仅在组件挂载时读取 IndexedDB，不直接写入数据。
 * @author 开发团队
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';

/**
 * 按需加载核心数据（tRounds + positions）。
 *
 * @description 在 AppLayout 挂载时调用一次，异步加载做T轮次（OPENED 含流水池）、持仓。
 *              冷启动时仅加载 feeConfig，核心数据在首次渲染后异步加载，
 *              降低首屏等待时间，同时确保 Store Action 能正确访问到已有数据。
 *              加载完成后设置 coreDataLoaded = true，供 Store Action 防护检查。
 *              使用 useCallback(useAppStore.getState().loadXxx, []) 稳定函数引用，
 *              避免因 Zustand Selector 每次创建新引用导致 useEffect 重复触发。
 * @returns {{ loading: boolean }} 加载状态
 */
export function useLoadCoreData(): { loading: boolean } {
  const loaded = useRef(false);
  const [loading, setLoading] = useState(true);

  // 使用 useCallback 稳定函数引用，避免 useEffect 因引用变化重复触发
  // 注意：这里直接调用 useAppStore.getState() 获取初始函数引用（而非通过 Selector 订阅），
  // 确保 loadXxx 函数在组件的整个生命周期内保持同一个引用，从而消除竞态条件。
  const loadPositions = useCallback(useAppStore.getState().loadPositions, []);
  const loadTRounds = useCallback(useAppStore.getState().loadTRounds, []);
  const setCoreDataLoaded = useCallback(useAppStore.getState().setCoreDataLoaded, []);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    setLoading(true);
    // 并行加载核心数据，不阻塞渲染
    Promise.all([
      loadPositions(),
      loadTRounds(),
    ]).then(() => {
      setCoreDataLoaded(true);
      setLoading(false);
    }).catch((err) => {
      console.error('[DataLoader] Failed to load core data:', err);
      // 即使加载失败也标记为已加载，避免用户被永久阻塞无法操作
      setCoreDataLoaded(true);
      setLoading(false);
    });
  }, [loadPositions, loadTRounds, setCoreDataLoaded]);

  return { loading };
}