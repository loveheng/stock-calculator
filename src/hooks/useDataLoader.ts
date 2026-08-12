/**
 * @file useDataLoader.ts
 * @description 按需加载数据钩子（Lazy Data Loader Hooks）：
 *              各视图组件在挂载时调用对应的钩子，只加载该视图所需的数据，
 *              避免冷启动全量加载，降低首屏时间与内存占用。
 *              v6.1 修复：使用 useCallback(useAppStore.getState().loadXxx, [])
 *              稳定函数引用，消除因 Zustand Selector 每次创建新引用导致的
 *              useEffect 重复触发竞态条件。
 * @layer Hooks
 * @storage_impact 仅在组件挂载时读取 IndexedDB，不直接写入数据。
 * @author 开发团队
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';

/**
 * 按需加载核心数据（tStreams + positions + tRounds）。
 *
 * @description 在 AppLayout 挂载时调用一次，异步加载做T流水池、持仓和进行中的轮次。
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
  const loadTStreams = useCallback(useAppStore.getState().loadTStreams, []);
  const loadPositions = useCallback(useAppStore.getState().loadPositions, []);
  const loadTRounds = useCallback(useAppStore.getState().loadTRounds, []);
  const setCoreDataLoaded = useCallback(useAppStore.getState().setCoreDataLoaded, []);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    setLoading(true);
    // 并行加载核心数据，不阻塞渲染
    Promise.all([
      loadTStreams(),
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
  }, [loadTStreams, loadPositions, loadTRounds, setCoreDataLoaded]);

  return { loading };
}

/**
 * 按需加载未平仓持仓数据。
 *
 * @description 在 CostAveraging 等需要持仓数据的组件挂载时调用，
 *              只加载一次，避免重复请求。
 * @returns {{ loading: boolean }} 加载状态
 */
export function useLoadPositions(): { loading: boolean } {
  const loaded = useRef(false);
  const [loading, setLoading] = useState(true);
  const loadPositions = useCallback(useAppStore.getState().loadPositions, []);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    setLoading(true);
    loadPositions().then(() => setLoading(false)).catch(() => setLoading(false));
  }, [loadPositions]);

  return { loading };
}

/**
 * 按需加载做T流水池数据。
 *
 * @description 在 TCalculator 等需要 tStreams 数据的组件挂载时调用，
 *              只加载一次，避免重复请求。
 * @returns {{ loading: boolean }} 加载状态
 */
export function useLoadTStreams(): { loading: boolean } {
  const loaded = useRef(false);
  const [loading, setLoading] = useState(true);
  const loadTStreams = useCallback(useAppStore.getState().loadTStreams, []);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    setLoading(true);
    loadTStreams().then(() => setLoading(false)).catch(() => setLoading(false));
  }, [loadTStreams]);

  return { loading };
}

/**
 * 按需加载进行中的做T轮次数据。
 *
 * @description 在 TCalculator 等需要 tRounds 数据的组件挂载时调用，
 *              只加载一次，避免重复请求。
 * @returns {{ loading: boolean }} 加载状态
 */
export function useLoadTRounds(): { loading: boolean } {
  const loaded = useRef(false);
  const [loading, setLoading] = useState(true);
  const loadTRounds = useCallback(useAppStore.getState().loadTRounds, []);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    setLoading(true);
    loadTRounds().then(() => setLoading(false)).catch(() => setLoading(false));
  }, [loadTRounds]);

  return { loading };
}

/**
 * 按需加载股票基础信息数据。
 *
 * @description 在需要股票搜索/自动补全的组件挂载时调用，
 *              只加载一次，避免重复请求。
 * @returns {{ loading: boolean }} 加载状态
 */
export function useLoadStocks(): { loading: boolean } {
  const loaded = useRef(false);
  const [loading, setLoading] = useState(true);
  const loadStocks = useCallback(useAppStore.getState().loadStocks, []);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    setLoading(true);
    loadStocks().then(() => setLoading(false)).catch(() => setLoading(false));
  }, [loadStocks]);

  return { loading };
}