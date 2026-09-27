/**
 * @file schema.ts
 * @description Dexie 表结构定义（DAO 层类型基石）：声明实体类型（Entity，epoch 毫秒时间戳）
 *              与数据库表索引。领域模型（ISO 字符串时间戳）在 types/domain.ts。
 * @layer DAO
 * @storage_impact 声明 notes / settings 两张示例表并导出 Dexie 实例 db。
 * @author 骨架模板
 */

import Dexie, { type Table } from 'dexie';
import type { BaseEntity } from '../types/domain';

/** 行级审计字段（权威定义在 types/domain.ts，此处 re-export 保持既有导入路径兼容） */
export type { BaseEntity };

/** 笔记实体（notes 表）：tags 以 JSON 字符串落库，done 用 0|1（boolean 不是合法索引 key） */
export interface NoteEntity extends BaseEntity {
  title: string;
  content: string;
  tagsJson: string;
  done: 0 | 1;
}

/** 设置实体（settings 表，单行 id=1） */
export interface SettingsEntity {
  id: 1;
  theme: 'dark' | 'light';
  autoBackup: 0 | 1;
  updatedAt: number;
}

/** v1：初始表结构（新增版本时在此链尾部增量叠加，勿全量复制） */
const STORES_V1 = {
  notes: 'id, updatedAt, isDeleted',
  settings: 'id',
} as const;

/**
 * 应用数据库（Dexie 封装，库名 AppSkeletonDB）。
 *
 * @description 索引字符串为 Dexie schema：主键在前，逗号分隔字段均建立索引。
 *              升级结构时新增 version 并在 STORES 链尾部追加增量定义。
 */
export class AppDatabase extends Dexie {
  /** 笔记表 */
  notes!: Table<NoteEntity, string>;
  /** 设置表（单行） */
  settings!: Table<SettingsEntity, number>;

  constructor() {
    super('AppSkeletonDB');
    this.version(1).stores(STORES_V1 as Record<string, string>);
  }
}

/** 全局唯一的数据库实例，供 store / services 层读写使用 */
export const db = new AppDatabase();
