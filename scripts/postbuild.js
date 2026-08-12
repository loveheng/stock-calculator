/**
 * @file postbuild.js
 * @description 构建后处理脚本：移除 Vite 构建产物 index.html 中默认添加的 crossorigin 属性，
 *              以适配 PWA 离线场景下跨域策略的兼容性。
 * @layer Utility
 * @storage_impact 无 IndexedDB 读写；仅修改构建产物 dist/index.html。
 * @author 开发团队
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(__dirname, '..', 'dist', 'index.html');
const html = readFileSync(htmlPath, 'utf-8');
// 移除 crossorigin 属性（布尔形式与带值形式均匹配）
const modified = html.replace(/\s+crossorigin(?:="[^"]*")?/g, '');
writeFileSync(htmlPath, modified, 'utf-8');
console.log('[postbuild] Removed crossorigin attributes from index.html');