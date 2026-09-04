/**
 * @file server/index.mjs
 * @description Docker 运行时入口：静态资源服务 + SPA 回退 + 代理路由。
 *
 * 【与 Vercel 部署的对应关系】
 *   - vercel.json 的 rewrites /(.*) → /index.html   → SPA 回退（见 serveStatic/spaFallback）
 *   - vercel.json 的 /sw.js 缓存头                  → SW_CACHE_CONTROL
 *   - middleware.js 的 6 条静态上游代理             → upstream-proxy.mjs
 *   - api/webdav.js 的 WebDAV Serverless Function   → webdav-proxy.mjs
 *
 * 【零依赖】仅使用 node:http 与全局 fetch/Request/Response（Node 18+），
 * 不引入任何 npm 依赖，package.json 保持不动 → Vercel 部署完全不受影响。
 *
 * 【环境变量】
 *   PORT             监听端口（默认 3000）
 *   HOST             监听地址（默认 0.0.0.0）
 *   AUTH_UPSTREAM    /api/auth 上游（默认取 proxy.config.js 线上地址）
 *   IMPORT_UPSTREAM  /api/import 上游（同上）
 *
 * @layer Config
 */

import { createServer } from 'node:http';
import { stat, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import {
  matchUpstream,
  forwardUpstream,
  preflightResponse,
} from './upstream-proxy.mjs';
import { handleWebdav } from './webdav-proxy.mjs';

const DIST_DIR = resolve(fileURLToPath(import.meta.url), '..', '..', 'dist');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

/** MIME 类型表（覆盖 PWA 构建产物出现的全部类型）。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

/** sw.js 缓存策略（与 vercel.json headers 一致）。 */
const SW_CACHE_CONTROL = 'public, max-age=0, s-maxage=0, must-revalidate';
/** index.html / SPA 回退：始终校验，保证 PWA 更新可被发现。 */
const HTML_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
/** 带内容哈希的构建产物：一年 immutable。 */
const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** 其余静态资源。 */
const DEFAULT_CACHE_CONTROL = 'public, max-age=3600';

/** 把 Node 的 IncomingMessage 头转成 Headers 实例。 */
function toHeaders(nodeHeaders) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

/**
 * 把 Node 请求转换为 Web API Request（供代理模块复用与 Vercel 一致的逻辑）。
 * 非 GET/HEAD 使用流式 body（duplex: 'half'），避免大请求体（如 WebDAV 上传）占内存。
 */
function toWebRequest(req) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const init = {
    method: req.method || 'GET',
    headers: toHeaders(req.headers),
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }
  return new Request(url, init);
}

/** 把 Web API Response 写回 Node 响应（流式转发，透传状态码与响应头）。 */
async function sendWebResponse(res, response) {
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  // getSetCookie 可用（Node 18.14+），保证 Set-Cookie 不被合并丢参数
  if (typeof response.headers.getSetCookie === 'function') {
    for (const cookie of response.headers.getSetCookie()) {
      res.appendHeader('Set-Cookie', cookie);
    }
  }
  res.statusCode = response.status;
  if (!response.body) {
    res.end();
    return;
  }
  const nodeStream = Readable.fromWeb(response.body);
  nodeStream.pipe(res);
  nodeStream.on('error', () => res.destroy());
}

/** 按路径决定 Cache-Control（哈希资源 immutable，sw.js 不缓存，HTML 须校验）。 */
function cacheControlFor(pathname) {
  if (pathname === '/sw.js') return SW_CACHE_CONTROL;
  if (pathname === '/index.html' || pathname === '/') return HTML_CACHE_CONTROL;
  if (pathname.startsWith('/assets/')) return ASSET_CACHE_CONTROL;
  return DEFAULT_CACHE_CONTROL;
}

/**
 * 静态文件服务 + SPA 回退（对应 vercel.json 的 catch-all rewrite）。
 * 命中真实文件则按 MIME/缓存头返回；否则一律回退到 index.html（与 Vercel 一致）。
 */
async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD');
    res.end('Method Not Allowed');
    return;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }

  // 防目录穿越：规范化后必须仍位于 dist 目录内
  const filePath = normalize(join(DIST_DIR, decoded));
  if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + sep)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  let target = filePath;
  try {
    const st = await stat(target);
    if (st.isDirectory()) target = join(target, 'index.html');
    await stat(target);
  } catch {
    // 未命中真实文件 → SPA 回退到 index.html（catch-all rewrite）
    target = join(DIST_DIR, 'index.html');
  }

  // 缓存策略按实际返回的文件决定：回退到 index.html 时必须按 HTML 策略（不可长缓存），
  // 否则 PWA 更新会被浏览器/SW 的旧缓存延迟发现
  const isHtml = target.toLowerCase().endsWith('index.html');
  const ext = extname(target).toLowerCase();
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', isHtml ? HTML_CACHE_CONTROL : cacheControlFor(pathname));

  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(target)
    .on('error', () => res.destroy())
    .pipe(res);
}

/** 主请求路由：healthz → WebDAV → 静态上游代理 → 静态/SPA。 */
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // 0. 健康检查（Docker HEALTHCHECK 用）
    if (pathname === '/healthz') {
      res.statusCode = 200;
      res.end('ok');
      return;
    }

    // 1. WebDAV 代理（对应 api/webdav.js Serverless Function）
    if (pathname === '/api/webdav' || pathname.startsWith('/api/webdav/')) {
      await sendWebResponse(res, await handleWebdav(toWebRequest(req)));
      return;
    }

    // 2. 静态上游代理（对应 middleware.js）
    const matchedPrefix = matchUpstream(pathname);
    if (matchedPrefix) {
      if (req.method === 'OPTIONS') {
        await sendWebResponse(res, preflightResponse());
        return;
      }
      await sendWebResponse(res, await forwardUpstream(matchedPrefix, toWebRequest(req)));
      return;
    }

    // 3. 静态资源 / SPA 回退
    await serveStatic(req, res, pathname);
  } catch (err) {
    console.error('[server] Unhandled error:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Internal Server Error');
    } else {
      res.destroy();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[server] stock-calculator listening on http://${HOST}:${PORT}`);
  console.log(`[server] serving dist from: ${DIST_DIR}`);
  console.log(
    `[server] auth upstream: ${process.env.AUTH_UPSTREAM || '(default from proxy.config.js)'}, ` +
      `import upstream: ${process.env.IMPORT_UPSTREAM || '(default from proxy.config.js)'}`,
  );
});

// 容器内 node 以 PID 1 运行时不会获得默认信号处置（SIGTERM 会被忽略），
// 必须显式处理，否则 docker stop/podman stop 只能等超时后 SIGKILL。
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received, shutting down...');
  server.close(() => process.exit(0));
  // 兑底：长连接（keep-alive）可能阻塞 close 回调，3 秒后强制退出
  setTimeout(() => process.exit(0), 3000).unref();
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
