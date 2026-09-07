/**
 * @file idGenerator.ts
 * @description 全局唯一 ID 生成（原 store/utils.ts 内置实现下沉至此）：
 *              services 等非 store 模块需要生成 ID 时从本模块导入，
 *              避免 services → store 的值依赖违反分层护栏。
 * @layer Utility
 * @storage_impact 纯函数，无持久化副作用。
 * @author 开发团队
 */

/**
 * 生成全局唯一 ID。
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
