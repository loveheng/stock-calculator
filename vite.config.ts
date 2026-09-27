/**
 * @file vite.config.ts
 * @description Vite 构建配置：React 插件 + PWA（Workbox 运行时缓存）+ 构建输出。
 *              需要后端接口时，在 server.proxy 增条目即可（勿把上游地址硬编码进业务代码）。
 * @layer Config
 * @storage_impact 无 IndexedDB 读写；仅影响构建产物与开发环境网络代理。
 * @author 骨架模板
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const APP_ICON =
  "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%231677ff'/><path d='M20 70 L40 40 L60 55 L80 25' stroke='white' stroke-width='8' fill='none' stroke-linecap='round'/></svg>";

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [],
      manifest: {
        name: '应用骨架',
        short_name: '骨架',
        description: 'React 19 + TypeScript + Vite + Dexie + Zustand + Tailwind 的本地优先 PWA 骨架。',
        theme_color: '#1677ff',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: APP_ICON, sizes: '192x192', type: 'image/svg+xml', purpose: 'any maskable' },
          { src: APP_ICON, sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,json}'],
        // SPA 导航回退到 index.html；/api 等后端路径绝不进导航缓存
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api($|\/)/],
        runtimeCaching: [
          {
            // 仅缓存「带扩展名的跨域静态资源」，GET 限定；API 流量不进任何缓存与后台重试
            urlPattern: /^(?!.*\/api\/)https?:\/\/.*\.(?:js|css|html|svg|png|ico|json|jpg|woff2?)(?:\?.*)?$/i,
            handler: 'NetworkFirst',
            method: 'GET',
            options: {
              cacheName: 'app-skeleton-static',
              expiration: { maxEntries: 200, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
        ],
      },
    }),
  ],
  build: {
    outDir: 'dist',
    modulePreload: {
      polyfill: false,
    },
  },
});
