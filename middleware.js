/**
 * @file middleware.js
 * @description Vercel Edge Middleware：静态行情上游的纯白名单代理转发体系。
 *
 * 仅拦截以下【静态上游】路径并转发：
 *   - /api-gtimg/*      → https://smartbox.gtimg.cn/*
 *   - /api-qt/*         → https://qt.gtimg.cn/*
 *   - /api-kline/*      → https://ifzq.gtimg.cn/*
 *   - /api/eastmoney/*  → https://searchapi.eastmoney.com/*
 *
 * 【重要说明 · WebDAV 已迁出】
 *   WebDAV（/api/webdav）已不再由本中间件承担，改由 Vercel 原生 Serverless
 *   Function（api/webdav.js）接管。因此本文件【不含】任何 WebDAV 路由，且
 *   matcher 刻意【不匹配】/api/* 通配，避免中间件在 rewrite 落点上游拦截
 *   /api/webdav 导致请求滑落到 SPA 静态层报 405 Method Not Allowed。
 *
 * 【2025-08-24 新增 · /api/import】
 *   OCR 交割单识别服务（sc.oklhj.eu.org）也通过 Edge Middleware 代理，
 *   与静态行情上游采用相同的白名单转发模式，保证 Vercel 部署后 /api/import
 *   也能正常被代理转发，不会滑落到 SPA 层报 405。
 *   本地开发时由 Vite 的 server.proxy 完成同等转发。
 *
 * 【2026-09-02 新增 · /api/auth】
 *   E2EE 用户服务（Spring Boot :18080，与 OCR 交割单识别同源部署于
 *   sc.oklhj.eu.org）。前端同源请求 /api/auth/*，由本中间件转发到上游
 *   （stripPrefix: false 保留前缀）。认证令牌经 Authorization 头透传
 *   （不在剔除名单内），无 Cookie/CSRF 面。
 *   本地开发时由 Vite 的 server.proxy 完成同等转发。
 *
 * 【设计】
 *   1. OPTIONS 预检直接返回 200（解决 405）。
 *   2. 静态上游注入业务头（Referer / User-Agent 等），剥离 Vercel 内部头
 *      （x-vercel-* / x-forwarded-*）。
 *   3. 所有跨源响应统一追加 CORS 头。
 *
 * @deployment 部署至 Vercel Edge Runtime，运行于全球边缘节点。
 */

// 代理上游地址统一配置（防呆版：线上中间件结构上只读 UPSTREAMS.online，
// 本地开发开关 DEV_UPSTREAM_ENV 对此处零影响，见 proxy.config.js）
import { UPSTREAMS as PROXY_UPSTREAMS } from './proxy.config.js';

// ============================================================
// 1. 上游代理配置映射表
// ============================================================

const UPSTREAMS = {
  '/api-gtimg': {
    base: 'https://smartbox.gtimg.cn',
    headers: { Referer: 'https://finance.qq.com/' },
  },
  '/api-qt': {
    base: 'https://qt.gtimg.cn',
    headers: { Referer: 'https://finance.qq.com/' },
  },
  '/api-kline': {
    base: 'https://ifzq.gtimg.cn',
    headers: { Referer: 'https://finance.qq.com/' },
  },
  '/api/eastmoney': {
    base: 'https://searchapi.eastmoney.com',
    headers: {
      Referer: 'https://quote.eastmoney.com',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  },
  // OCR 交割单识别服务代理（保留原始路径前缀，不剥离 /api/import；
  // 线上固定读 PROXY_UPSTREAMS.online，与本地开发开关隔离）
  '/api/import': {
    base: PROXY_UPSTREAMS.online.import,
    headers: {},
    stripPrefix: false,
  },
  // E2EE 用户服务代理（保留原始路径前缀，不剥离 /api/auth；同上）
  '/api/auth': {
    base: PROXY_UPSTREAMS.online.auth,
    headers: {},
    stripPrefix: false,
  },
};

/** 匹配路径前缀（按长度降序，避免 `/api/eastmoney` 被 `/api` 误匹配）。 */
const SORTED_PREFIXES = Object.keys(UPSTREAMS).sort((a, b) => b.length - a.length);

/** 静态代理需剔除的 Vercel 内部头前缀。 */
const BLOCKED_PREFIXES = ['x-vercel-', 'x-forwarded-'];

// --------------------------------------------------------------
// 防呆护栏：Vercel 线上/预览环境禁止本地上游（vercel dev 除外）。
// 若有人误把 proxy.config.js 的 UPSTREAMS.online 改成本地地址，
// 不再返回难排查的 502 Connection refused，而是直接给出明确中文提示。
// （仅影响 /api/import 与 /api/auth 两个受管路由，静态行情路由不受连坐）
// --------------------------------------------------------------
const LOCAL_ADDR_RE = /\/\/(localhost|127\.0\.0\.1|\[::1\])/;
const IS_VERCEL_DEPLOYED =
  process.env.VERCEL_ENV === 'production' || process.env.VERCEL_ENV === 'preview';

// ============================================================
// 2a. 标准 HTTP 方法白名单
// ============================================================
/** 允许并转发的全部方法：GET/HEAD/POST/PUT/DELETE/OPTIONS。
 *  HEAD 必须显式放行，否则浏览器/测试连接请求会被中间件或上游以 405 拦截。
 */
const ALLOWED_METHODS = [
  'GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS',
];

/** 统一 CORS 头：所有跨源响应（包括 400/404/405/500/502 等错误响应）都必须携带，
    否则浏览器会拦截错误信息，前端无法读取失败原因。 */
const CORS_ALLOW_ORIGIN = { 'Access-Control-Allow-Origin': '*' };

// ============================================================
// 2. Vercel Edge Middleware 配置
// ============================================================

export const config = {
  matcher: [
    '/api-gtimg/:path*',
    '/api-qt/:path*',
    '/api-kline/:path*',
    '/api/eastmoney/:path*',
    '/api/import/:path*',
    '/api/auth/:path*',
  ],
};

// ============================================================
// 3. 中间件处理函数
// ============================================================

/**
 * 默认中间件处理函数。
 *
 * 仅对静态上游（gtimg/qt/eastmoney）注入业务头并转发。所有跨源响应都追加统一 CORS 头。
 * WebDAV（/api/webdav）已交由 api/webdav.js（Serverless Function）处理，本函数不再涉及。
 *
 * @param {Request} request - 原始请求对象（Web API Request）
 * @returns {Promise<Response>} 转发后的响应对象
 */
export default async function middleware(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // ----------------------------------------------------------
  // 3a. 【首行】处理 OPTIONS 预检请求 → 直接返回 200（解决 405）
  // ----------------------------------------------------------
  // 预检请求必须由中间件立即响应，严禁转发给上游；无论是否有 ?url= 参数。
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': ALLOWED_METHODS.join(', '),
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // ----------------------------------------------------------
  // 3a-2. 方法白名单校验：仅放行标准 HTTP 方法（含 HEAD）。
  // 仅对白名单之外的方法返回 405；GET/HEAD/POST/PUT/DELETE/OPTIONS
  // 一律放行并转发到上游，绝不在中间件层误拦截 HEAD。
  // WebDAV 扩展方法（PROPFIND/MKCOL/MOVE/COPY）由 api/webdav.js 处理。
  // ----------------------------------------------------------
  if (!ALLOWED_METHODS.includes(request.method)) {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: {
        ...CORS_ALLOW_ORIGIN,
        Allow: ALLOWED_METHODS.join(', '),
      },
    });
  }

  // ----------------------------------------------------------
  // 3b. 查找匹配的上游配置
  // ----------------------------------------------------------
  const matchedPrefix = SORTED_PREFIXES.find((prefix) => pathname.startsWith(prefix));
  if (!matchedPrefix) {
    return new Response('Proxy route not found', { status: 404, headers: CORS_ALLOW_ORIGIN });
  }

  const upstream = UPSTREAMS[matchedPrefix];

  // 防呆护栏：线上部署环境解析到本地地址 → 立即报明确配置错误（不发起必然失败的转发）
  if (IS_VERCEL_DEPLOYED && LOCAL_ADDR_RE.test(upstream.base)) {
    return new Response(
      `[middleware] 代理配置错误：${matchedPrefix} 上游为本地地址（${upstream.base}）。` +
        'Vercel 线上必须使用线上地址，请检查项目根目录 proxy.config.js 的 UPSTREAMS.online',
      { status: 502, headers: CORS_ALLOW_ORIGIN },
    );
  }
  const forwardHeaders = new Headers();
  const upstreamPath = upstream.stripPrefix === false
    ? pathname
    : pathname.slice(matchedPrefix.length) || '/';
  const upstreamUrl = `${upstream.base}${upstreamPath}${url.search}`;

  // ---------- 静态代理：注入上游所需业务头 + 剔除 Vercel 内部头 ----------
  for (const [key, value] of Object.entries(upstream.headers)) {
    forwardHeaders.set(key, value);
  }
  for (const [key, value] of request.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'host') continue;
    if (BLOCKED_PREFIXES.some((prefix) => lowerKey.startsWith(prefix))) continue;
    forwardHeaders.set(key, value);
  }

  // ----------------------------------------------------------
  // 3c. 构造上游请求
  // ----------------------------------------------------------
  const requestInit = {
    method: request.method,
    headers: forwardHeaders,
  };

  // HEAD/GET/OPTIONS 请求不允许携带 body，显式置为 undefined，其余透传。
  if (request.method === 'GET' || request.method === 'HEAD') {
    requestInit.body = undefined;
  } else {
    requestInit.body = request.body;
  }

  // ----------------------------------------------------------
  // 3d. 转发请求并返回响应
  // ----------------------------------------------------------
  try {
    const upstreamResponse = await fetch(upstreamUrl, requestInit);

    // 透传上游头 + 统一追加 CORS 头。
    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', ALLOWED_METHODS.join(', '));
    responseHeaders.set('Access-Control-Allow-Headers', '*');

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(`Proxy error: ${message}`, {
      status: 502,
      headers: CORS_ALLOW_ORIGIN,
    });
  }
}
