import { useEffect, useState } from 'react';
import { ledgerService } from '../services/ledgerService';
import type { TRoundRow } from '../db/index';

/**
 * 按需加载已完成 Round 的 Hook。
 *
 * @description 页面挂载时异步加载所有已归档（COMPLETED）的做T战报摘要
 *              （含 tradeCount 等汇总字段，不含成交明细 transactions），
 *              仅加载一次，返回 loading 状态与数据数组。
 *              成交明细在展开「查看成交明细」时通过
 *              ledgerService.fetchTransactionsByRoundId 按需查询。
 *
 * @note 一次性加载全部摘要而非真分页：Statistics 与 TCalculator 的胜率/累计
 *       净收益等指标需要对全量轮次做汇总；轮次摘要行数据量远小于明细，
 *       此处按需省掉的是明细（占列表数据体积的绝大部分）。
 *
 * @returns {{ archivedRounds: TRoundRow[]; archivedLoading: boolean }}
 *          - archivedRounds: 已完成 Round 摘要列表
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