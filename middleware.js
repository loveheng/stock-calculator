/**
 * @file middleware.js
 * @description Vercel Edge Middleware：纯白名单代理转发体系。
 *
 * 拦截以下路径并转发到上游：
 *   - /api-gtimg/*      → https://smartbox.gtimg.cn/*
 *   - /api-qt/*         → https://qt.gtimg.cn/*
 *   - /api/eastmoney/*  → https://searchapi.eastmoney.com/*
 *   - /api-webdav       → 动态目标 URL（从 ?url= 查询参数获取，纯白名单头转发）
 *   - /api/webdav       → 兼容别名（同上）
 *
 * 【纯白名单代理层 · WebDAV 核心设计】
 *   1. OPTIONS 预检请求在函数【首行】直接拦截返回 200（解决 405）：
 *      预检必须由中间件立即响应，严禁转发给上游（转发会导致 405）。
 *   2. 严格白名单头转发（解决 403）：只透传 WebDAV 必需头
 *      （authorization / content-type / depth / overwrite / if-match /
 *      if-none-match），彻底剥离浏览器特征头（host / origin / referer /
 *      cookie / sec-fetch-* / accept-language / accept-encoding /
 *      x-vercel-* / x-forwarded-*）。这些特征头被 Koofr 等 WebDAV 服务器
 *      判定为异常，会触发 403。
 *   3. 统一设置干净的 User-Agent，不携带任何浏览器指纹。
 *
 * @deployment 部署至 Vercel Edge Runtime，运行于全球边缘节点。
 */

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
  '/api/eastmoney': {
    base: 'https://searchapi.eastmoney.com',
    headers: {
      Referer: 'https://quote.eastmoney.com',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  },
  /** WebDAV 动态代理：从 ?url= 查询参数解析目标地址，纯白名单头转发。 */
  '/api/webdav': { base: '', headers: {}, dynamic: true },
  '/api-webdav': { base: '', headers: {}, dynamic: true },
};

/** 匹配路径前缀（按长度降序，避免 `/api/eastmoney` 被 `/api` 误匹配）。 */
const SORTED_PREFIXES = Object.keys(UPSTREAMS).sort((a, b) => b.length - a.length);

/** WebDAV 严格白名单：仅透传以下必需头。 */
const WEBDAV_ALLOWED_HEADERS = new Set([
  'authorization', 'content-type', 'depth', 'overwrite',
  'if-match', 'if-none-match',
]);

/** 静态代理需剔除的 Vercel 内部头前缀。 */
const BLOCKED_PREFIXES = ['x-vercel-', 'x-forwarded-'];

/** 统一 CORS 头：所有跨源响应（包括 400/404/500/502 等错误响应）都必须携带，
    否则浏览器会拦截错误信息，前端无法读取失败原因。 */
const CORS_ALLOW_ORIGIN = { 'Access-Control-Allow-Origin': '*' };

// ============================================================
// 2. Vercel Edge Middleware 配置
// ============================================================

export const config = {
  matcher: [
    '/api/:path*',
    '/api-webdav',
    '/api-webdav/:path*',
    '/api/webdav',
    '/api/webdav/:path*',
    '/api-gtimg/:path*',
    '/api-qt/:path*',
    '/api/eastmoney/:path*',
  ],
};

// ============================================================
// 3. 中间件处理函数
// ============================================================

/**
 * 默认中间件处理函数。
 *
 * 对 WebDAV（/api-webdav）执行纯白名单代理；对静态上游（gtimg/qt/eastmoney）
 * 注入业务头并转发。所有跨源响应都追加统一 CORS 头。
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
        'Access-Control-Allow-Methods':
          'GET, POST, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
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
  const forwardHeaders = new Headers();
  let upstreamUrl;

  if (upstream.dynamic) {
    // ---------- WebDAV 动态代理：纯白名单转发 ----------
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      return new Response('Missing url parameter', { status: 400, headers: CORS_ALLOW_ORIGIN });
    }
    upstreamUrl = targetUrl;

    // 严格白名单：仅透传 WebDAV 必需头，绝不透传浏览器特征头。
    for (const [key, value] of request.headers.entries()) {
      if (WEBDAV_ALLOWED_HEADERS.has(key.toLowerCase())) {
        forwardHeaders.set(key, value);
      }
    }
    // 统一干净的 User-Agent，不带浏览器指纹。
    forwardHeaders.set('User-Agent', 'Stock-Calculator-WebDAV/1.0');
  } else {
    // ---------- 静态代理：注入上游所需头 + 剔除 Vercel 内部头 ----------
    const upstreamPath = pathname.slice(matchedPrefix.length) || '/';
    upstreamUrl = `${upstream.base}${upstreamPath}${url.search}`;

    for (const [key, value] of Object.entries(upstream.headers)) {
      forwardHeaders.set(key, value);
    }
    for (const [key, value] of request.headers.entries()) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'host') continue;
      if (BLOCKED_PREFIXES.some((prefix) => lowerKey.startsWith(prefix))) continue;
      forwardHeaders.set(key, value);
    }
  }

  // ----------------------------------------------------------
  // 3c. 构造上游请求
  // ----------------------------------------------------------
  const requestInit = {
    method: request.method,
    headers: forwardHeaders,
  };

  // 非 GET/HEAD 请求透传 body。流式 PUT 请求体必须声明 duplex: 'half'，
  // 否则 Edge Runtime 会拒绝流式 body，导致上游/代理返回 405 或 100。
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    requestInit.body = request.body;
    requestInit.duplex = 'half';
  }

  // ----------------------------------------------------------
  // 3d. 转发请求并返回响应
  // ----------------------------------------------------------
  try {
    const upstreamResponse = await fetch(upstreamUrl, requestInit);

    // 透传上游头 + 统一追加 CORS 头。
    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY, OPTIONS',
    );
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
