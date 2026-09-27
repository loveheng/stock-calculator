/**
 * @file backupService.ts
 * @description 备份服务（Services 层示例）：快照构建与整库导入。
 *              Services 层做「跨层编排」，只依赖 db + types，禁止反向依赖 store（防循环）。
 * @layer Services
 * @storage_impact importSnapshot 会整批覆写 notes / settings（导入前请先自行备份）。
 * @author 骨架模板
 */

import { bulkPutNotes, loadNotesFromDB, saveSettingsToDB } from '../db';
import { SNAPSHOT_VERSION, type AppSettings, type AppSnapshot, type Note } from '../types/domain';

/** 快照构建入参 */
export interface SnapshotInput {
  settings: AppSettings;
  notes: Note[];
}

/**
 * 构建导出快照（版本号 + 导出时间 + 全量数据）。
 */
export function buildSnapshot(input: SnapshotInput): AppSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    settings: input.settings,
    notes: input.notes,
  };
}

/**
 * 解析快照文本：校验版本与结构，失败抛出可直接展示给用户的错误。
 */
export function parseSnapshot(text: string): AppSnapshot {
  const parsed = JSON.parse(text) as Partial<AppSnapshot>;
  if (!parsed || typeof parsed !== 'object') throw new Error('快照格式不正确');
  if (parsed.version !== SNAPSHOT_VERSION) {
    throw new Error(`快照版本不兼容（期望 ${SNAPSHOT_VERSION}，实际 ${String(parsed.version)}）`);
  }
  if (!Array.isArray(parsed.notes) || !parsed.settings) throw new Error('快照缺少 notes / settings 字段');
  return {
    version: SNAPSHOT_VERSION,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : new Date().toISOString(),
    settings: parsed.settings,
    notes: parsed.notes,
  };
}

/**
 * 应用快照到数据库（settings upsert + notes 批量覆写）。
 *
 * @returns {Promise<Note[]>} 导入后从库里回读的最新笔记列表（保证内存与库一致）
 */
export async function applySnapshot(snapshot: AppSnapshot): Promise<Note[]> {
  await saveSettingsToDB(snapshot.settings);
  await bulkPutNotes(snapshot.notes);
  return loadNotesFromDB();
}
