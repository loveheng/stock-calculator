#!/usr/bin/env node
/**
 * @file feature-map.mjs
 * @description 功能→文件触点速查表：实时扫描 src/ 按功能分组输出，不落盘、永不过期。
 *              修改某功能前先跑 npm run map:features 查它的全部触点（视图/状态/服务/计算/测试）。
 *              新文件按「功能词」命名即可自动归组；命名不含功能词的特例登记进 GROUPS 关键词。
 *              「未归类」清单就是漂移探测器：出现新条目 = 新功能待登记，或文件命名缺功能词。
 * @layer 工程脚本（零依赖，node >= 18）
 * @author 开发团队
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');

// 分组按数组顺序匹配（先具体后一般），关键词为小写子串，匹配对象是 src/ 下相对路径
const GROUPS = [
  ['auth（E2EE 认证）', ['auth', 'crypto', 'mnemonic', 'apiclient', 'sessionpersistence', 'resetpassword', 'sessionlock']],
  ['sandbox（沙盘推演）', ['sandbox', 'baselineextractor', 'presetaudit', 'metricsengine']],
  ['tstrategy（做T策略）', ['tstream', 'streammerge', 'streams', 'usestreamresults', 'statistics', 'tstrategy', 'tcalculator', 'strategygenerators', 'shorttermtrial', 'tradingtime', 'positionadjustment']],
  ['kline（K线/行情）', ['kline', 'livequotes', 'pricecache']],
  ['stock（股票元数据/行情源）', ['stockservice', 'stockautocomplete', 'types/stock']],
  ['import（批量导入）', ['import', 'ocr', 'dedup']],
  ['sync（WebDAV 同步/备份）', ['webdav', 'ioslice']],
  ['fee（费率）', ['feepresets', 'feeconfig', 'mathutils']],
  ['ledger（持仓/账本）', ['ledger', 'calculator', 'costaveraging', 'home', 'coreslice', 'positions', 'orders', 'rounds', 'reconcile', 'usearchivedrounds', 'planorder', 'recalculat', 'recomputeposition', 'roundlifecycle']],
  ['risk（风控规则）', ['risk', 'getcloseblockreason']],
  ['calc（涨跌幅计算器）', ['changerate']],
  ['copilot（AI 助手）', ['copilot', 'pagecontext']],
  ['app（应用骨架/通用）', ['app.tsx', 'main.tsx', 'usedataloader', 'bootstrap', 'persistence', 'store/index', 'store/types', 'store/utils', 'db/index', 'db/schema', 'domain', 'installprompt', 'confirmmodal', 'migration', 'cleanundefined']],
];

const ROLES = [
  ['views/', '视图'],
  ['components/', '组件'],
  ['hooks/', 'hooks'],
  ['store/', '状态'],
  ['services/', '服务'],
  ['utils/', '计算'],
  ['risk/', 'risk'],
  ['db/', '持久化'],
  ['types/', '类型'],
];

function walk(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (/\.tsx$/.test(ent.name) || (/\.ts$/.test(ent.name) && !ent.name.endsWith('.d.ts'))) out.push(p);
  }
  return out;
}

function roleOf(rel) {
  if (rel.startsWith('__tests__')) return '测试';
  for (const [seg, label] of ROLES) if (rel.includes(seg)) return label;
  return '其他';
}

// 中日韩字符按 2 列宽计，用于角色列对齐
function width(s) {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
  return w;
}

function pad(s, n) {
  return s + ' '.repeat(Math.max(0, n - width(s)));
}

const files = walk(SRC)
  .map((p) => p.slice(SRC.length + 1))
  .sort();

const grouped = new Map(GROUPS.map(([name]) => [name, new Map()]));
const unmatched = [];
for (const rel of files) {
  const lower = rel.toLowerCase();
  const hit = GROUPS.find(([, kws]) => kws.some((k) => lower.includes(k)));
  if (!hit) {
    unmatched.push(rel);
    continue;
  }
  const roles = grouped.get(hit[0]);
  const role = roleOf(rel);
  if (!roles.has(role)) roles.set(role, []);
  roles.get(role).push(rel);
}

let total = 0;
console.log('功能→文件触点速查（npm run map:features 实时扫描生成，非静态文档，永不过期）');
console.log('');
for (const [name, roles] of grouped) {
  const count = [...roles.values()].reduce((n, list) => n + list.length, 0);
  if (count === 0) continue;
  total += count;
  console.log('■ ' + name + ' · ' + count + ' 文件');
  for (const [role, list] of roles) {
    console.log('   ' + pad(role, 8) + ' ' + list.join(', '));
  }
  console.log('');
}
console.log('已归组 ' + total + ' / ' + files.length + ' 个文件');
if (unmatched.length > 0) {
  console.log('');
  console.log('⚠ 未归类 ' + unmatched.length + ' 个（新功能待登记关键词，或文件命名缺功能词）：');
  for (const rel of unmatched) console.log('   ' + rel);
}
