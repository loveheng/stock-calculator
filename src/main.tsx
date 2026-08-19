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
import { initAutoSync } from './store';
import { registerSW } from 'virtual:pwa-register';

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

  // 2) Initialize auto-sync (subscribes to store changes, triggers WebDAV backup when autoSync enabled)
  initAutoSync();

  // 3) Render the app (persistence is handled incrementally inside Zustand actions)
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

// 注册 Service Worker 并启用自动更新（registerType: 'autoUpdate' 配置已在 vite.config.ts 中设置）
// 当检测到新版本时，SW 会自动执行 skipWaiting + clients.claim + 页面刷新
registerSW({
  onOfflineReady() {
    console.log('[PWA] 应用已可离线使用');
  },
  onRegistered(registration) {
    if (registration) {
      console.log('[PWA] Service Worker 已注册，作用域:', registration.scope);
      // 定期检查更新（每 30 分钟），防止浏览器默认的 24h 周期过长
      setInterval(() => {
        registration.update();
        console.log('[PWA] 检查更新...');
      }, 30 * 60 * 1000);
    }
  },
  onRegisterError(error) {
    console.error('[PWA] Service Worker 注册失败:', error);
  },
});

bootstrap();
