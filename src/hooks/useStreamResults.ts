/**
 * @file useStreamResults.ts
 * @description 全市场做T撮合结果派生 Hook（级联重算核心）：订阅 tRounds（OPENED 流水池）
 *              + feeConfig + positions，任何变化自动级联重算全市场 FIFO 撮合结果。
 *              从 store/utils.ts 拆出 —— Hook 必须依赖 useAppStore，而 store/utils 需保持
 *              纯函数定位（不反向依赖 store/index），否则两模块互相引用形成循环依赖。
 * @layer Hook
 * @storage_impact 纯内存派生，不读写任何存储。
 * @author 开发团队
 */

import { useMemo } from 'react';
import { processAllStreams, type StockStreamResult } from '../utils/tStreamEngine';
import { useAppStore } from '../store';
import { buildBasePositionCosts, activeStreamsFromRounds } from '../store/utils';

/**
 * 派生全市场撮合结果 Hook（级联重算核心）。
 *
 * @description 订阅 tRounds（OPENED 流水池）+ feeConfig + positions，
 *              任何变化自动级联重算全市场 FIFO 撮合结果。
 */
export function useStreamResults(): StockStreamResult[] {
  const tRounds = useAppStore((s) => s.tRounds);
  const feeConfig = useAppStore((s) => s.feeConfig);
  const positions = useAppStore((s) => s.positions);
  return useMemo(() => {
    const baseCosts = buildBasePositionCosts(positions);
    const activeStreams = activeStreamsFromRounds(tRounds);
    return processAllStreams(activeStreams, feeConfig, baseCosts);
  }, [tRounds, feeConfig, positions]);
}
