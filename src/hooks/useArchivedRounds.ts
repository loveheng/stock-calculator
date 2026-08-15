import { useEffect, useRef, useState } from 'react';
import { ledgerService } from '../services/ledgerService';
import { useAppStore } from '../store';
import type { TRoundRow } from '../db/index';

/**
 * 按需加载已完成 Round 的 Hook。
 *
 * @description 页面挂载时异步加载所有已归档（COMPLETED）的做T战报摘要
 *              （含 tradeCount 等汇总字段，不含成交明细 transactions），
 *              返回 loading 状态与数据数组。
 *              成交明细在展开「查看成交明细」时通过
 *              ledgerService.fetchTransactionsByRoundId 按需查询。
 *              同时实时订阅 Store 中 tRounds 的变化：当日做T完结自动归档、
 *              删除战报、结算倒T、划转底仓等动作发生后，立即静默重新拉取
 *              归档摘要，使「今日战报归档库」无需刷新页面即可展示最新战报。
 *
 * @note 一次性加载全部摘要而非真分页：Statistics 与 TCalculator 的胜率/累计
 *       净收益等指标需要对全量轮次做汇总；轮次摘要行数据量远小于明细，
 *       此处按需省掉的是明细（占列表数据体积的绝大部分）。
 *       兼容 React StrictMode 的开发期「effect 双执行」：首次加载的 promise
 *       无论生效与否，resolve 时一律关闭 loading，避免一直停留在加载占位。
 *       归档后的重载为静默模式（不切换 loading），避免列表闪烁。
 *
 * @returns {{ archivedRounds: TRoundRow[]; archivedLoading: boolean }}
 *          - archivedRounds: 已完成 Round 摘要列表
 *          - archivedLoading: 是否正在首次加载中
 */
export function useArchivedRounds(): {
  archivedRounds: TRoundRow[];
  archivedLoading: boolean;
} {
  const [archivedRounds, setArchivedRounds] = useState<TRoundRow[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(true);
  // 实时订阅 Round 状态：做T完结自动归档 / 删除 / 结算倒T / 划转底仓后即时重载摘要
  const tRounds = useAppStore((s) => s.tRounds);
  // 是否已加载出首屏数据（用于区分「首次加载展示 loading」与「归档后静默重载」）
  const hasData = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (!hasData.current) {
      // 首次加载（含 StrictMode 双执行的第一轮）：展示 loading 占位
      setArchivedLoading(true);
    } else {
      // ── 非首次加载：同步 tRounds 变化，立即从本地 state 中移除已删除的战报 ──
      // 当 removeRound 执行后，Zustand 的 tRounds 已同步删除该战报，
      // 但 DB 的异步持久化（rollbackRound + persistPositionDiffs 经 safePersist）可能尚未完成。
      // 如果此时去 DB 重查，会拿到仍包含已删除战报的脏数据。
      // 这里先根据 tRounds 的 ID 集合进行本地过滤，实现毫秒级 UI 响应。
      const tRoundIds = new Set(tRounds.map((r) => r.id));
      setArchivedRounds((prev) => {
        const filtered = prev.filter((r) => tRoundIds.has(r.id));
        // 无变化时保持引用不变，避免不必要的重渲染
        return filtered.length === prev.length ? prev : filtered;
      });
    }

    // 全量从 DB 重新拉取，确保与持久化层最终一致（异步，不影响 UI 即时响应）
    ledgerService.fetchCompletedRoundsPage(1, 999999).then((result) => {
      if (!cancelled) {
        // ── 从 DB 拉取后，再以当前 tRounds 的 ID 集合做一次本地过滤 ──
        // 确保已被 removeRound 从 Zustand 中删除（但 safePersist 的异步
        // 删除尚未完成）的战报不会因为 DB 脏数据而重新出现在列表中。
        const tRoundIds = new Set(tRounds.map((r) => r.id));
        const filtered = result.items.filter((r) => tRoundIds.has(r.id));
        setArchivedRounds(filtered);
        hasData.current = true;
        // 无条件关闭 loading：无论首次加载生效的是第几次 effect 的请求，
        // 只要任一请求成功返回即结束 loading 状态，避免卡在「加载中」
        setArchivedLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tRounds]);

  return { archivedRounds, archivedLoading };
}