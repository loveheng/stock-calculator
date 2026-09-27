/**
 * @file notesStore.test.ts
 * @description 骨架链路冒烟：initStore → Store Action → IndexedDB → 回读校验。
 *              新增业务切片时，请照此模板补一条「落库后可回读」的用例。
 * @layer Tests
 * @author 骨架模板
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { loadNotesFromDB } from '../db';
import { initStore } from '../store/bootstrap';
import { useAppStore } from '../store';

/** 清空 notes 表（骨架纪律：禁用 table.clear()，按主键批量删除） */
async function resetNotes(): Promise<void> {
  const ids = await db.notes.toCollection().primaryKeys();
  await db.notes.bulkDelete(ids);
}

describe('notes store（Store → IndexedDB 全链路）', () => {
  beforeEach(async () => {
    await resetNotes();
    useAppStore.setState({ notes: [], coreDataLoaded: false });
    await initStore();
  });

  it('新增笔记后内存与库一致', async () => {
    await useAppStore.getState().addNote({ title: '第一条', content: '内容', tags: ['示例'] });

    expect(useAppStore.getState().notes).toHaveLength(1);
    const rows = await loadNotesFromDB();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('第一条');
    expect(rows[0].tags).toEqual(['示例']);
  });

  it('更新与删除均落库', async () => {
    await useAppStore.getState().addNote({ title: '待更新' });
    const id = useAppStore.getState().notes[0].id;

    await useAppStore.getState().updateNote(id, { done: true });
    expect((await loadNotesFromDB())[0].done).toBe(true);

    await useAppStore.getState().removeNote(id);
    expect(await loadNotesFromDB()).toHaveLength(0);
  });

  it('导出快照可原样导入', async () => {
    await useAppStore.getState().addNote({ title: '往返' });
    const text = JSON.stringify(useAppStore.getState().exportData());

    await resetNotes();
    await useAppStore.getState().importData(text);

    expect(useAppStore.getState().notes).toHaveLength(1);
    expect((await loadNotesFromDB())[0].title).toBe('往返');
  });
});
