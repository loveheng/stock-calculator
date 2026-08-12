/**
 * @file vite.config.ts
 * @description Vite 构建配置：React 插件、PWA 支持（Workbox 运行时缓存）、
 *              开发服务器代理（腾讯 Smartbox 行情搜索 / 腾讯实时行情 / 东方财富搜索 API）、
 *              以及构建输出配置。
 * @layer Config
 * @storage_impact 无 IndexedDB 读写；仅影响构建产物与开发环境网络代理。
 * @author 开发团队
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [],
      manifest: {
        name: '股票做T账本与成本计算器',
        short_name: '做T账本',
        description: 'A股股票做T计算器与成本摊薄工具，支持正T倒T计算、多批次建仓账本管理、做T数据统计与费率配置。',
        theme_color: '#1677ff',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 100 100\'><rect width=\'100\' height=\'100\' rx=\'20\' fill=\'%231677ff\'/><path d=\'M20 70 L40 40 L60 55 L80 25\' stroke=\'white\' stroke-width=\'8\' fill=\'none\' stroke-linecap=\'round\'/></svg>',
            sizes: '192x192',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
          {
            src: 'data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 100 100\'><rect width=\'100\' height=\'100\' rx=\'20\' fill=\'%231677ff\'/><path d=\'M20 70 L40 40 L60 55 L80 25\' stroke=\'white\' stroke-width=\'8\' fill=\'none\' stroke-linecap=\'round\'/></svg>',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,json}'],
        runtimeCaching: [
          {
            urlPattern: /^https?:\/\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'stock-calculator-cache',
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 30 * 24 * 60 * 60,
              },
            },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api-gtimg': {
        target: 'https://smartbox.gtimg.cn',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-gtimg/, ''),
        headers: {
          Referer: 'https://finance.qq.com/',
        },
      },
      '/api-qt': {
        target: 'https://qt.gtimg.cn',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-qt/, ''),
        headers: {
          Referer: 'https://finance.qq.com/',
        },
      },
      '/api/eastmoney': {
        target: 'https://searchapi.eastmoney.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/eastmoney/, ''),
        headers: {
          Referer: 'https://quote.eastmoney.com',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    modulePreload: {
      polyfill: false,
    },
  },
});
