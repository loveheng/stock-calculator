/**
 * @file ledgerService.ts
 * @description 统一账本 Service 门面（Read-Only Facade）：按需动态 import db 层
 *              只读查询并按层映射成 Store/UI 类型，避免冷启动全量加载 DAO。
 *              所有数据写入统一通过 Store Action（参见 src/store/index.ts）。
 *              持仓/做T Round 概览与费率配置经由 store 加载，此处仅保留
 *              UI 实际使用的分页/明细查询。
 * @layer Service
 * @author 开发团队
 */

import type { RoundTxn } from '../store/types';

export async function fetchCompletedRoundsPage(
  page: number,
  pageSize: number,
): Promise<import('../db/index').PageResult<import('../db/index').TRoundRow>> {
  const { fetchCompletedRoundsPage: dbQuery } = await import('../db/index');
  return dbQuery(page, pageSize);
}

export async function fetchTransactionsByRoundId(
  roundId: string,
): Promise<RoundTxn[]> {
  const { fetchTransactionsByRoundId: dbQuery } = await import('../db/index');
  return dbQuery(roundId);
}

export async function fetchAllLongTermRecords(): Promise<import('../db/index').LongTermRecordRow[]> {
  const { fetchAllLongTermRecords: dbQuery } = await import('../db/index');
  return dbQuery();
}

// ---- 门面 ----

export const ledgerService = {
  fetchCompletedRoundsPage,
  fetchTransactionsByRoundId,
  fetchAllLongTermRecords,
};
