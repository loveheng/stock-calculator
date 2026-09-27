/**
 * @file setup.ts
 * @description 测试环境初始化：为 node 环境注入 fake-indexeddb，
 *              使 Dexie（IndexedDB）相关用例无需真实浏览器即可运行。
 * @layer Tests
 * @author 骨架模板
 */

import 'fake-indexeddb/auto';
