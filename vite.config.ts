/**
 * @file vite.config.ts
 * @description Vite 构建配置：React 插件、PWA 支持（Workbox 运行时缓存）、
 *              开发服务器代理（腾讯 Smartbox 行情搜索 / 腾讯实时行情 / 东方财富搜索 API /
 *              WebDAV 代理），以及构建输出配置。
 *
 * 【WebDAV 代理说明】
 *   开发环境下，Vite 代理 /api/webdav 请求到动态目标 URL，使用 bypass 函数
 *   实现与线上 Vercel Serverless Function（api/webdav.js）完全一致的请求头清洗逻辑
 *   （剔除 host/referer/origin/cookie/x-vercel-* / x-forwarded-*，
 *   保留 authorization/content-type/depth/overwrite/if-match），
 *   确保本地开发与线上行为一致，不再出现本地 404 或 CORS 问题。
 * @layer Config
 * @storage_impact 无 IndexedDB 读写；仅影响构建产物与开发环境网络代理。
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    // 本地开发：/api/webdav 由下方 server.proxy 的 bypass 回调代理（行为与线上
    // Vercel Serverless Function api/webdav.js 一致），无需独立中间件插件。
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
        // 显式设置 SPA 导航回退到 index.html，确保 SW 正确处理路由导航
        navigateFallback: 'index.html',
        // 导航回退拒绝列表：绝对不拦截 /api、/webdav 等代理/路由，
        // 确保 Service Worker 不把 WebDAV 流量当作 SPA 导航去回退缓存。
        navigateFallbackDenylist: [
          /^\/api($|\/)/, // 覆盖 /api/webdav
          /^\/api-gtimg/,
          /^\/api-qt/,
          /^\/api-kline/,
          /^\/api\/eastmoney/,
          /^\/webdav/, // 客户端 /webdav 路由也不做导航缓存
        ],
        runtimeCaching: [
          {
            // 仅为"带扩展名的跨域静态资源"做 NetworkFirst 缓存。
            // 通过负向前瞻显式排除 /api、/api/webdav、/webdav，
            // 并限定 method: 'GET'，保证 WebDAV 的 PUT/GET/PROPFIND/MKCOL 等
            // 请求绝不进入任何 NetworkFirst / StaleWhileRevalidate /
            // BackgroundSync 缓存与后台重试策略。
            urlPattern: /^(?!.*\/api\/webdav)(?!.*\/api\/)(?!.*\/webdav)https?:\/\/.*\.(?:js|css|html|svg|png|ico|json|jpg|woff2?)(?:\?.*)?$/i,
            handler: 'NetworkFirst',
            method: 'GET',
            options: {
              cacheName: 'stock-calculator-static',
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
      '/api-kline': {
        target: 'https://ifzq.gtimg.cn',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-kline/, ''),
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
      // WebDAV 代理：使用全局 fetch() 转发，避免动态 require
      '/api/webdav': {
        target: 'http://localhost:5173',
        bypass: async (req, res) => {
          if (req.method === 'OPTIONS') {
            res.writeHead(200, {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods':
                'GET, HEAD, POST, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY, OPTIONS',
              'Access-Control-Allow-Headers': '*',
              'Access-Control-Max-Age': '86400',
            });
            res.end();
            return '/__bypass__';
          }
          const u = new URL(req.url || '', 'http://localhost:5173');
          const targetUrl = u.searchParams.get('url');
          if (!targetUrl) { res.statusCode = 400; res.end('Missing url parameter'); return '/__bypass__'; }

          // 请求头清洗（与 middleware.js 一致）
          const blocked = new Set(['host', 'referer', 'origin', 'cookie']);
          const blockedPrefix = ['x-vercel-', 'x-forwarded-'];
          const allowed = new Set(['authorization', 'content-type', 'depth', 'overwrite', 'if-match']);
          const isBlocked = (k) => {
            if (allowed.has(k)) return false;
            if (blockedPrefix.some((p) => k.startsWith(p))) return true;
            return blocked.has(k);
          };
          const fwdHeaders = {};
          for (let i = 0; i < req.rawHeaders.length; i += 2) {
            const k = req.rawHeaders[i], v = req.rawHeaders[i + 1];
            if (!isBlocked(k.toLowerCase())) fwdHeaders[k] = v;
          }
          fwdHeaders['User-Agent'] = 'Mozilla/5.0 (compatible; WebDAVClient/1.0)';

          // 收集请求体
          const chunks = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const body = chunks.length > 0 ? Buffer.concat(chunks) : null;

          try {
            // 使用全局 fetch() 转发请求
            const upstreamRes = await fetch(targetUrl, {
              method: req.method,
              headers: fwdHeaders,
              body: body,
              // 非 GET/HEAD 不自动跟随重定向，透传原始状态码
              redirect: 'manual',
            });

            // 构建响应头（透传上游 + CORS 头）
            const rh = {};
            upstreamRes.headers.forEach((value, key) => {
              const lower = key.toLowerCase();
              // 跳过 Node.js 自动生成的 hop-by-hop 头
              if (lower === 'transfer-encoding' || lower === 'connection') return;
              rh[key] = value;
            });
            rh['Access-Control-Allow-Origin'] = '*';
            rh['Access-Control-Allow-Methods'] =
              'GET, POST, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY, OPTIONS';
            rh['Access-Control-Allow-Headers'] =
              'Content-Type, Authorization, Depth, Destination, Overwrite';
            rh['Access-Control-Expose-Headers'] =
              'Content-Type, Content-Length, ETag';

            res.writeHead(upstreamRes.status, rh);
            // 将上游响应体转为 Node.js Readable 并 pipe
            const reader = upstreamRes.body?.getReader();
            if (reader) {
              const pump = async () => {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) { res.end(); break; }
                  res.write(Buffer.from(value));
                }
              };
              pump().catch((e) => { res.statusCode = 502; res.end(`Proxy error: ${e.message}`); });
            } else {
              res.end();
            }
          } catch (e) {
            res.statusCode = 502;
            res.end(`Proxy error: ${e instanceof Error ? e.message : 'Unknown'}`);
          }
          return '/__bypass__';
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
