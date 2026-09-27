/**
 * @file notesSlice.ts
 * @description 笔记切片（Store Action 示例）：内存态更新 + safePersist 增量落库。
 *              写入纪律：先 set 内存态（UI 即时响应），再 safePersist 落库（失败自动退避重试 + 队列重放）。
 * @layer Store
 * @author 骨架模板
 */

import { ulid } from 'ulid';
import type { StateCreator } from 'zustand';
import { deleteNote, loadNotesFromDB, putNote } from '../../db';
import type { Note } from '../../types/domain';
import { safePersist } from '../../utils/persistence';
import type { AppStore } from '../types';

export interface NotesSlice {
  loadNotes: () => Promise<void>;
  addNote: (input: { title: string; content: string; tags?: string[] }) => Promise<void>;
  updateNote: (id: string, patch: Partial<Pick<Note, 'title' | 'content' | 'tags' | 'done'>>) => Promise<void>;
  removeNote: (id: string) => Promise<void>;
}

export const createNotesSlice: StateCreator<AppStore, [], [], NotesSlice> = (set, get) => ({
  loadNotes: async () => {
    const notes = await loadNotesFromDB();
    set({ notes });
  },

  addNote: async (input) => {
    const now = new Date().toISOString();
    const note: Note = {
      id: ulid(),
      title: input.title,
      content: input.content,
      tags: input.tags ?? [],
      done: false,
      createdAt: now,
      updatedAt: now,
    };
    set({ notes: [note, ...get().notes] });
    await safePersist(() => putNote(note));
  },

  updateNote: async (id, patch) => {
    const target = get().notes.find((n) => n.id === id);
    if (!target) return;
    const next: Note = { ...target, ...patch, updatedAt: new Date().toISOString() };
    set({ notes: get().notes.map((n) => (n.id === id ? next : n)) });
    await safePersist(() => putNote(next));
  },

  removeNote: async (id) => {
    set({ notes: get().notes.filter((n) => n.id !== id) });
    await safePersist(() => deleteNote(id));
  },
});
