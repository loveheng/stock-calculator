/**
 * @file auditLogger.ts
 * @description 审计日志模块：记录关键数据变更的不可变操作日志。
 *              日志只追加、不修改、不删除。
 *              写入使用 safePersist（异步），不阻塞主流程。
 * @layer Risk
 * @storage_impact 写入 IndexedDB auditLogs 表（只追加），需通过 db/index.ts 的 CRUD 函数。
 * @author 开发团队
 */

import { ulid } from 'ulid';
import type { AuditEntry, AuditActionType } from './types';
import { safePersist } from '../store/persistence';

/** 简化的上下文快照，用于记录 before/after */
export interface AuditSnapshot {
  /** 关联目标主键（部分场景下无独立 id，改为可选） */
  id?: string;
  [key: string]: unknown;
}

/**
 * 记录一条审计日志（异步写入，不阻塞）。
 *
 * @param action  操作类型
 * @param targetType 目标类型（position / round / batch / sandbox / system）
 * @param targetId   目标主键
 * @param result     操作结果
 * @param options    可选参数（before/after/reason/tags）
 */
export function recordAudit(
  action: AuditActionType,
  targetType: string,
  targetId: string,
  result: 'success' | 'rejected',
  options?: {
    before?: AuditSnapshot;
    after?: AuditSnapshot;
    reason?: string;
    tags?: Record<string, string>;
  },
): void {
  const entry: AuditEntry = {
    id: ulid(),
    timestamp: Date.now(),
    action,
    targetType,
    targetId,
    result,
    ...(options?.before ? { before: options.before } : {}),
    ...(options?.after ? { after: options.after } : {}),
    ...(options?.reason ? { reason: options.reason } : {}),
    ...(options?.tags ? { tags: options.tags } : {}),
  };

  // 异步写入，不阻塞主流程
  safePersist(async () => {
    const { putAuditLog } = await import('../db/index');
    await putAuditLog(entry);
  });
}

/**
 * 查询审计日志（按时间倒序）。
 *
 * @param options 查询参数
 * @returns 审计日志条目数组
 */
export async function queryAuditLogs(options?: {
  action?: AuditActionType;
  targetType?: string;
  targetId?: string;
  limit?: number;
  offset?: number;
  since?: number;
}): Promise<AuditEntry[]> {
  const { queryAuditLogs: dbQuery } = await import('../db/index');
  return dbQuery(options);
}