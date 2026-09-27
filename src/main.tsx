/**
 * @file main.tsx
 * @description 应用入口：异步引导启动 —— initStore() 水合内存 Store → 挂载 React 根节点；
 *              启动即注册 Service Worker（PWA 自动更新）。
 * @layer Entry
 * @storage_impact 仅提供启动引导，不直接参与持久化写入。
 * @author 骨架模板
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { initStore } from './store/bootstrap';
import { registerSW } from 'virtual:pwa-register';

/**
 * 应用引导启动函数。
 *
 * @description ① initStore() 从 IndexedDB 水合 Store；② 挂载根组件渲染 <App>。
 * @throws {Error} 根 DOM 节点缺失时抛出
 */
async function bootstrap(): Promise<void> {
  await initStore();

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

// 注册 Service Worker（registerType: 'autoUpdate' 已在 vite.config.ts 配置）
registerSW({
  onOfflineReady() {
    console.log('[PWA] 应用已可离线使用');
  },
  onRegistered(registration) {
    if (registration) {
      console.log('[PWA] Service Worker 已注册，作用域:', registration.scope);
      // 定期检查更新（每 30 分钟），防止浏览器默认 24h 周期过长
      setInterval(() => {
        void registration.update();
      }, 30 * 60 * 1000);
    }
  },
  onRegisterError(error) {
    console.error('[PWA] Service Worker 注册失败:', error);
  },
});

void bootstrap();
