import { useEffect, useState } from 'react';
import { ledgerService } from '../services/ledgerService';
import type { TRoundRow } from '../db/index';

/**
 * 按需加载已完成 Round 的 Hook。
 *
 * @description 页面挂载时异步加载所有已归档（COMPLETED）的做T战报，
 *              仅加载一次，返回 loading 状态与数据数组。
 *              用于替代启动时全量加载，降低首屏时间和内存占用。
 *
 * @returns {{ archivedRounds: TRoundRow[]; archivedLoading: boolean }}
 *          - archivedRounds: 已完成 Round 列表
 *          - archivedLoading: 是否正在加载中
 */
export function useArchivedRounds(): {
  archivedRounds: TRoundRow[];
  archivedLoading: boolean;
} {
  const [archivedRounds, setArchivedRounds] = useState<TRoundRow[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setArchivedLoading(true);
    // 一次性加载所有已完成的 Round（统计页需要全量汇总）
    ledgerService.fetchCompletedRoundsPage(1, 999999).then((result) => {
      if (!cancelled) {
        setArchivedRounds(result.items);
        setArchivedLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { archivedRounds, archivedLoading };
}