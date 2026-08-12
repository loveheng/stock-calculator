/**
 * @file main.tsx
 * @description 应用入口文件：异步引导启动流程——
 *              先 initStore() 从 IndexedDB 水合内存 Store，最终挂载 React 根节点渲染 <App>。
 *              v4 重构：移除 startStorePersistence()，持久化改为 Store Action 内增量写库。
 * @layer Entry
 * @storage_impact 仅提供启动引导，不直接参与持久化写入。
 * @author 开发团队
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { initStore } from './db/storeInit';

/**
 * 应用引导启动函数。
 *
 * @description 按序执行两步初始化：
 *  1. initStore() —— 从 IndexedDB 水合内存 Store
 *  2. ReactDOM.createRoot(...).render() —— 挂载根组件
 * @returns {Promise<void>} 引导完成后 resolve
 * @throws {Error} 当 IndexedDB 初始化失败或根 DOM 节点缺失时抛出
 */
async function bootstrap(): Promise<void> {
  // 1) Hydrate in-memory Zustand store from IndexedDB
  await initStore();

  // 2) Render the app (persistence is handled incrementally inside Zustand actions)
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

bootstrap();
