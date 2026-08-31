#!/usr/bin/env node
/**
 * @file check-layers.mjs
 * @description 分层依赖护栏：静态扫描 src/ 下的静态/动态 import，强制层间依赖方向。
 *              规则（违反任意一条则退出码 1）：
 *              R1  views/components 不得直连 db   —— 持久化细节须收敛在 store / hooks / 服务层
 *              R2  utils 不得依赖 store           —— 计算层保持纯函数，领域类型取自 types/domain
 *              R3  types/domain.ts 零依赖叶子     —— 领域类型唯一权威定义，禁止反向依赖任何项目内模块
 *              说明：risk/ 与 utils 同级，属纯计算层（不碰 store 状态机），views 直调
 *              RiskController 等门面属项目有意设计，不在禁止之列。
 *              用法：node scripts/check-layers.mjs（零依赖，CI 与本地均可运行）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const RULES = [
  {
    name: 'R1 no-views-direct-db',
    message: 'views/components 不得直连 db 层（持久化细节请走 store / hooks / services）',
    matchesFile: (p) => p.startsWith('views/') || p.startsWith('components/'),
    matchesTarget: (p) => p.startsWith('db/'),
  },
  {
    name: 'R2 no-utils-store',
    message: 'utils 不得依赖 store（保持纯函数；类型取自 types/domain，常量放 utils）',
    matchesFile: (p) => p.startsWith('utils/'),
    matchesTarget: (p) => p.startsWith('store/'),
  },
  {
    name: 'R3 domain-is-leaf',
    message: 'types/domain.ts 必须是零依赖叶子（禁止 import 任何项目内模块）',
    matchesFile: (p) => p === 'types/domain.ts',
    matchesTarget: () => true,
  },
];

const IMPORT_PATTERNS = [
  /^\s*import\s+[^'"]*?from\s*['"]([^'"]+)['"]/gm, // import ... from '...'
  /^\s*import\s*['"]([^'"]+)['"]/gm, // import '...'（副作用导入）
  /^\s*export\s+[^'"]*?from\s*['"]([^'"]+)['"]/gm, // export ... from '...'（再导出同样构成耦合）
  /import\(\s*['"]([^'"]+)['"]\s*\)/g, // 动态 import('...')
];

/** 测试为白盒用例，不参与分层约束；.d.ts 与 *.test.* 一并跳过 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') && !/\.test\./.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** 剥离注释，避免文档注释里提到的路径被误判为 import */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 解析相对导入到实际文件；只约束项目内相对路径（本项目未配置路径别名） */
function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return null;
}

const files = walk(SRC);
const violations = [];

for (const file of files) {
  const relFile = relative(SRC, file).split(sep).join('/');
  const content = stripComments(readFileSync(file, 'utf8'));
  const specs = new Set();
  for (const re of IMPORT_PATTERNS) {
    for (const m of content.matchAll(re)) specs.add(m[1]);
  }
  for (const spec of specs) {
    const target = resolveSpecifier(file, spec);
    if (!target) continue;
    const relTarget = relative(SRC, target).split(sep).join('/');
    if (!relTarget || relTarget.startsWith('..')) continue;
    for (const rule of RULES) {
      if (rule.matchesFile(relFile) && rule.matchesTarget(relTarget)) {
        violations.push({ rule: rule.name, message: rule.message, file: relFile, target: relTarget, spec });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`✗ 分层依赖检查失败：发现 ${violations.length} 处违例\n`);
  for (const v of violations) {
    console.error(`  [${v.rule}] src/${v.file}`);
    console.error(`    → import '${v.spec}' (目标: src/${v.target})`);
    console.error(`    ${v.message}\n`);
  }
  process.exit(1);
}

console.log(`✓ 分层依赖检查通过：${files.length} 个文件，0 违例（R1 视图禁连 db / R2 utils 禁依赖 store / R3 domain 叶子纯净）`);
