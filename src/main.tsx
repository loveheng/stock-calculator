/**
 * @file main.tsx
 * @description 应用入口文件：异步引导启动流程——
 *              先 initStore() 从 IndexedDB 水合内存 Store，再 startStorePersistence() 订阅
 *              Store 变更并持久化落库，最终挂载 React 根节点渲染 <App>。
 * @layer Utility
 * @storage_impact 启动阶段触发全量读取 IndexedDB（loadAllFromDB），并启动
 *                 随 Store 变化的节流持久化写入；涉及全部 10 张数据表。
 * @author 开发团队
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { initStore, startStorePersistence } from './db/storeInit';

/**
 * 应用引导启动函数。
 *
 * @description 按序执行三步初始化：
 *  1. initStore() —— 从 IndexedDB 水合内存 Store
 *  2. startStorePersistence() —— 订阅 Store 变更并持久化到 IndexedDB
 *  3. ReactDOM.createRoot(...).render() —— 挂载根组件
 * @returns {Promise<void>} 引导完成后 resolve
 * @throws {Error} 当 IndexedDB 初始化失败或根 DOM 节点缺失时抛出
 */
async function bootstrap(): Promise<void> {
  // 1) Hydrate in-memory Zustand store from IndexedDB
  await initStore();

  // 2) Start subscribing to store changes and persist to IndexedDB
  startStorePersistence();

  // 3) Render the app
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

bootstrap();