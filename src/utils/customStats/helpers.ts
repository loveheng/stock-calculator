/**
 * @file helpers.ts
 * @description 宿主注入沙箱的纯函数工具源码（HELPERS_SOURCE）。
 *              QuickJS 沙箱内无 decimal.js/宿主函数，金额口径与除零保护靠这段
 *              纯 JS 在沙箱内 eval 后挂到 globalThis.__helpers；每次批次注入时
 *              由 Worker 合入 ctx（Object.assign(JSON.parse(ctxJson), __helpers)）。
 *              零宿主函数注入 —— RELEASE_SYNC 变体可用的前提。
 * @layer Utils (Pure) —— 只依赖 types，禁碰 store/db（R2）
 * @storage_impact 纯常量字符串，无存储。
 * @author 开发团队
 */

/**
 * 沙箱内执行的 helpers 源码（纯 JS 字符串，无任何宿主引用）：
 * 求值后把工具对象挂到 globalThis.__helpers，随后 Worker 注入 ctx 时与 JSON 合并。
 * - round2：四舍五入 2 位（规费/金额展示口径）
 * - pct：占比，除零安全返回 0，结果 0-1 小数
 * - groupBy / sumBy：分组与求和
 * - fmtMoney：千分位 + 2 位小数 + 负号（如 -1,234.50）
 */
export const HELPERS_SOURCE = [
  'globalThis.__helpers = (function () {',
  '  function round2(n) {',
  '    if (typeof n !== "number" || !isFinite(n)) return 0;',
  '    return Math.round(n * 100) / 100;',
  '  }',
  '  function pct(part, total) {',
  '    if (typeof part !== "number" || typeof total !== "number" || !isFinite(part) || !isFinite(total) || total === 0) return 0;',
  '    return part / total;',
  '  }',
  '  function groupBy(xs, f) {',
  '    var out = {};',
  '    (xs || []).forEach(function (x) {',
  '      var k = String(f(x));',
  '      if (Object.prototype.hasOwnProperty.call(out, k)) out[k].push(x);',
  '      else out[k] = [x];',
  '    });',
  '    return out;',
  '  }',
  '  function sumBy(xs, f) {',
  '    var s = 0;',
  '    (xs || []).forEach(function (x) {',
  '      var v = f(x);',
  '      if (typeof v === "number" && isFinite(v)) s += v;',
  '    });',
  '    return s;',
  '  }',
  '  function fmtMoney(n) {',
  '    if (typeof n !== "number" || !isFinite(n)) return "—";',
  '    var neg = n < 0;',
  '    var abs = Math.round(Math.abs(n) * 100) / 100;',
  '    var parts = abs.toFixed(2).split(".");',
  '    parts[0] = parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");',
  '    return (neg ? "-" : "") + parts[0] + "." + parts[1];',
  '  }',
  '  return { round2: round2, pct: pct, groupBy: groupBy, sumBy: sumBy, fmtMoney: fmtMoney };',
  '})();',
].join('\n');
