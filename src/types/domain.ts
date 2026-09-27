/**
 * @file domain.ts
 * @description 领域类型单一权威源：零依赖叶子（护栏 R3 强制）。
 *              db/schema.ts 只 re-export 本文件的类型，禁止反向依赖任何项目内模块。
 *              扩展新项目时：先在这里定义领域模型，再向下游（db → store → hooks → views）铺开。
 * @layer Types (领域权威)
 * @author 骨架模板
 */

/** 行级审计字段：所有持久化实体（Entity）的公共字段（epoch 毫秒） */
export interface BaseEntity {
  /** 主键 */
  id: string;
  /** 创建时间戳（epoch ms） */
  createdAt: number;
  /** 更新时间戳（epoch ms） */
  updatedAt: number;
  /** 软删除标记：0 正常，1 已删除（全库禁用 table.clear()，删除走软删或按主键物理删） */
  isDeleted: 0 | 1;
}

/** 示例领域模型：笔记（替换为你的业务模型即可，时间戳统一用 ISO 字符串） */
export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  done: boolean;
  /** 创建时间（ISO 字符串） */
  createdAt: string;
  /** 更新时间（ISO 字符串） */
  updatedAt: string;
}

/** 应用设置（settings 表单行示例） */
export interface AppSettings {
  theme: 'dark' | 'light';
  autoBackup: boolean;
}

/** 设置默认值（领域常量，无副作用） */
export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  autoBackup: false,
};

/** 导出快照结构版本号：导入时校验，不一致直接拒绝 */
export const SNAPSHOT_VERSION = 1;

/** 导出/备份快照（services/backupService 使用） */
export interface AppSnapshot {
  version: number;
  exportedAt: string;
  settings: AppSettings;
  notes: Note[];
}
