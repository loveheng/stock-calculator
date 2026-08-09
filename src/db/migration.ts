/**
 * @file migration.ts
 * @description 旧版本数据迁移入口。当前项目已完全切换到 TradingLedgerDB_v3（IndexedDB），
 *              localStorage → IndexedDB 的迁移被有意禁用，本模块保留为兼容性占位。
 * @layer DAO
 * @storage_impact 本文件不执行任何 IndexedDB / localStorage 读写，仅为后续迁移逻辑预留入口。
 * @author 开发团队
 */

// ============================================================
// localStorage → IndexedDB migration is intentionally disabled.
// This project now uses TradingLedgerDB_v3 only.
// ============================================================

/**
 * 执行旧版本数据迁移（当前为禁用态，直接返回 0）。
 *
 * @description 版本 v3 起仅使用 IndexedDB 存储，LocalStorage 已不再是数据源；
 *              返回迁移记录数始终为 0，保持接口兼容以便将来按需启用。
 * @returns {Promise<number>} 迁移的记录条数（当前恒为 0，表示无迁移）
 * @note 若未来恢复旧数据导入，需在此处实现 LocalStorage 键扫描与实体转换逻辑
 */
export async function migrateFromLocalStorage(): Promise<number> {
  return 0;
}