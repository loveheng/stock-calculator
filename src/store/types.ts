/**
 * @file types.ts
 * @description AppStore 契约：状态字段 + Action 签名集中声明，切片实现体在 ./slices/*。
 *              新增功能请新增切片（slices/xxxSlice.ts）并在本文件扩展对应 Action 签名。
 * @layer Store
 * @author 骨架模板
 */

import type { AppSettings, AppSnapshot, Note } from '../types/domain';

/** 应用主 Store：切片按功能拆分，此处为完整契约 */
export interface AppStore {
  // ---- 状态 ----
  /** 笔记列表（按需加载，冷启动不读库） */
  notes: Note[];
  /** 应用设置（冷启动唯一同步读取的数据） */
  settings: AppSettings;
  /** 核心数据是否加载完成（Store Action 防护用） */
  coreDataLoaded: boolean;

  // ---- Core 切片 ----
  setCoreDataLoaded: (loaded: boolean) => void;

  // ---- Notes 切片 ----
  loadNotes: () => Promise<void>;
  addNote: (input: { title: string; content: string; tags?: string[] }) => Promise<void>;
  updateNote: (id: string, patch: Partial<Pick<Note, 'title' | 'content' | 'tags' | 'done'>>) => Promise<void>;
  removeNote: (id: string) => Promise<void>;

  // ---- Settings 切片 ----
  loadSettings: () => Promise<void>;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;

  // ---- IO 切片（备份/恢复） ----
  exportData: () => AppSnapshot;
  importData: (text: string) => Promise<void>;
}
