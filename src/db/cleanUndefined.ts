/**
 * @file cleanUndefined.ts
 * @description 递归剔除对象中的 undefined 字段（纯函数工具），供 DAO 层写库前统一调用，
 *              防止 undefined 字段引发 IndexedDB 结构化克隆（structured clone）序列化错误。
 * @layer DAO
 * @storage_impact 纯函数，无存储读写。
 * @author 开发团队
 */

/**
 * 递归剔除对象中的 undefined 字段。
 *
 * @description 会递归处理嵌套对象与数组：逐层剔除 undefined 字段，并剔除数组中的 undefined 元素；
 *              Date / Map / Set / RegExp 等特殊对象原样保留（结构化克隆本身支持这些类型，不应被拆解成空对象）。
 *              内部使用 `(obj as any)[key]` 是 JS 运行时反射的标准模式，无法避免。
 * @param {T} obj - 任意对象
 * @returns {T} 剔除 undefined 字段后的新对象（不修改原对象，返回新结构）
 */
export function cleanUndefined<T extends object>(obj: T): T {
  // 数组：逐元素递归清理，并剔除 undefined 元素（undefined 数组元素同样无法通过结构化克隆）
  if (Array.isArray(obj)) {
    return obj
      .map((item) => (item !== null && typeof item === 'object' ? cleanUndefined(item as object) : item))
      .filter((item) => item !== undefined) as T;
  }
  // 仅拆解普通对象（原型为 Object.prototype 或 null），Date/Map/Set 等特殊对象原样保留
  if (!isPlainObject(obj)) return obj;
  const result: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    const val = (obj as any)[key];
    if (val !== undefined) {
      result[key] = val !== null && typeof val === 'object' ? cleanUndefined(val as object) : val;
    }
  }
  return result as T;
}

/** 判断是否为普通对象（原型为 Object.prototype 或 null），排除 Date/Map/Set/RegExp 等特殊对象 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
