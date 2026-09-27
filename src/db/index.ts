/**
 * @file index.ts
 * @description IndexedDB 数据读写中枢（DAO 层）：实体 ↔ 领域模型转换、
 *              冷启动按需加载、增量写入（put / update / delete），
 *              全库禁用 table.clear()，写库前统一经 cleanUndefined 剔除 undefined 字段。
 * @layer DAO
 * @storage_impact 冷启动仅读 settings 单行；业务数据（notes）由 Store 通过 useLoadCoreData 按需加载。
 * @author 骨架模板
 */

import { db, type NoteEntity, type SettingsEntity } from './schema';
import { cleanUndefined } from './cleanUndefined';
import { DEFAULT_SETTINGS, type AppSettings, type Note } from '../types/domain';

export type { AppSettings, Note } from '../types/domain';
export { cleanUndefined } from './cleanUndefined';

/** 全局数据库实例（别名转发自 ./schema） */
export const database = db;

/** 设置默认行（单行 id=1） */
function defaultSettingsEntity(): SettingsEntity {
  return {
    id: 1,
    theme: DEFAULT_SETTINGS.theme,
    autoBackup: DEFAULT_SETTINGS.autoBackup ? 1 : 0,
    updatedAt: Date.now(),
  };
}

/** 领域模型 → 实体 */
function toNoteEntity(note: Note): NoteEntity {
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    tagsJson: JSON.stringify(note.tags ?? []),
    done: note.done ? 1 : 0,
    createdAt: Date.parse(note.createdAt) || Date.now(),
    updatedAt: Date.parse(note.updatedAt) || Date.now(),
    isDeleted: 0,
  };
}

/** 实体 → 领域模型 */
function toNote(entity: NoteEntity): Note {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(entity.tagsJson) as unknown;
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    /* 载荷损坏时降级为空标签，不影响列表渲染 */
  }
  return {
    id: entity.id,
    title: entity.title,
    content: entity.content,
    tags,
    done: entity.done === 1,
    createdAt: new Date(entity.createdAt).toISOString(),
    updatedAt: new Date(entity.updatedAt).toISOString(),
  };
}

/** 实体 → 领域设置 */
function toSettings(entity: SettingsEntity | undefined): AppSettings {
  if (!entity) return { ...DEFAULT_SETTINGS };
  return {
    theme: entity.theme,
    autoBackup: entity.autoBackup === 1,
  };
}

/**
 * 确保默认数据存在（settings 单行）。
 *
 * @description 在读写事务内检查 settings 的 id=1 行，缺失则写入默认值。
 */
export async function ensureDefaultData(): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const existing = await db.settings.get(1);
    if (!existing) await db.settings.put(defaultSettingsEntity());
  });
}

/** 按需加载设置（单行，缺省回退默认值） */
export async function loadSettingsFromDB(): Promise<AppSettings> {
  const entity = await db.settings.get(1);
  return toSettings(entity);
}

/** 保存设置（单行 upsert，id=1） */
export async function saveSettingsToDB(settings: AppSettings): Promise<void> {
  await db.settings.put(
    cleanUndefined({
      id: 1 as const,
      theme: settings.theme,
      autoBackup: settings.autoBackup ? 1 : 0,
      updatedAt: Date.now(),
    }),
  );
}

/** 按需加载全部未删除笔记（按更新时间倒序） */
export async function loadNotesFromDB(): Promise<Note[]> {
  const entities = await db.notes.where('isDeleted').equals(0).toArray();
  return entities
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(toNote);
}

/** 新增/更新单条笔记（增量 upsert） */
export async function putNote(note: Note): Promise<void> {
  await db.notes.put(cleanUndefined(toNoteEntity(note)));
}

/** 软删除单条笔记（禁止物理清空，墓碑保留以便后续同步/审计） */
export async function deleteNote(id: string): Promise<void> {
  await db.notes.update(id, { isDeleted: 1, updatedAt: Date.now() });
}

/** 批量写入笔记（导入场景；已存在主键覆盖，不做清空） */
export async function bulkPutNotes(notes: Note[]): Promise<void> {
  if (notes.length === 0) return;
  await db.notes.bulkPut(notes.map((n) => cleanUndefined(toNoteEntity(n))));
}
