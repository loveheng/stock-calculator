/**
 * @file middleware.js
 * @description Vercel Edge Middleware：统一代理与请求头清洗体系。
 *
 * 拦截以下路径并转发到上游：
 *   - /api-gtimg/*      → https://smartbox.gtimg.cn/*
 *   - /api-qt/*         → https://qt.gtimg.cn/*
 *   - /api/eastmoney/*  → https://searchapi.eastmoney.com/*
 *   - /api/webdav       → 动态目标 URL（从 ?url= 查询参数获取）
 *
 * 【WebDAV 代理核心设计】
 *   1. 所有 WebDAV 请求统一走 /api/webdav?url=... 同源路径，
 *      彻底规避浏览器端 CORS 跨域限制。
 *   2. OPTIONS 预检请求直接返回 200 + 允许所有 WebDAV 方法的 CORS 头。
 *   3. 请求头严格清洗：剔除 host / referer / origin / cookie /
 *      x-vercel-* / x-forwarded-*，保留 authorization / content-type /
 *      depth / overwrite / if-match，设置统一 User-Agent。
 *   4. 请求体完整透传至上游。
 *
 * @deployment 部署至 Vercel Edge Runtime，运行于全球边缘节点。
 */

// ============================================================
// 1. 上游代理配置映射表
// ============================================================

const UPSTREAMS = {
  '/api-gtimg': {
    base: 'https://smartbox.gtimg.cn',
    headers: {
      Referer: 'https://finance.qq.com/',
    },
  },
  '/api-qt': {
    base: 'https://qt.gtimg.cn',
    headers: {
      Referer: 'https://finance.qq.com/',
    },
  },
  '/api/eastmoney': {
    base: 'https://searchapi.eastmoney.com',
    headers: {
      Referer: 'https://quote.eastmoney.com',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  },
  /**
   * WebDAV 代理：动态转发到目标 WebDAV 服务器。
   * 客户端通过 /api/webdav?url=<encodeURIComponent(目标URL)> 传递地址。
   * 不匹配子路径，仅匹配 /api/webdav 精确路径（查询参数不影响路径匹配）。
   */
  '/api/webdav': {
    base: '',      // 动态 base：从 ?url= 查询参数提取
    headers: {},   // 动态注入：从请求头清洗后透传
    dynamic: true, // 标记为动态路由，需特殊处理
  },
};

/**
 * 匹配路径前缀（按长度降序排序，避免 `/api/eastmoney` 被 `/api` 误匹配）。
 */
const SORTED_PREFIXES = Object.keys(UPSTREAMS).sort((a, b) => b.length - a.length);

/**
 * 请求头清洗配置：
 *  - BLOCKED_HEADERS：严格剔除的请求头（小写）
 *  - BLOCKED_PREFIXES：剔除的前缀（小写）
 *  - ALLOWED_HEADERS：显式保留的请求头（小写），优先级高于 BLOCKED_*
 */
const BLOCKED_HEADERS = new Set([
  'host', 'referer', 'origin', 'cookie',
]);
const BLOCKED_PREFIXES = ['x-vercel-', 'x-forwarded-'];
const ALLOWED_HEADERS = new Set([
  'authorization', 'content-type', 'depth', 'overwrite', 'if-match',
]);

/**
 * 判断请求头是否应被剔除。
 * @param {string} lowerKey - 小写的请求头名称
 * @returns {boolean}
 */
function isHeaderBlocked(lowerKey) {
  // 显式允许的头始终保留
  if (ALLOWED_HEADERS.has(lowerKey)) return false;
  // 命中剔除前缀
  if (BLOCKED_PREFIXES.some((prefix) => lowerKey.startsWith(prefix))) return true;
  // 命中剔除名单
  return BLOCKED_HEADERS.has(lowerKey);
}

// ============================================================
// 2. Vercel Edge Middleware 配置
// ============================================================

export const config = {
  matcher: [
    '/api-gtimg/:path*',
    '/api-qt/:path*',
    '/api/eastmoney/:path*',
    '/api/webdav',
  ],
};

// ============================================================
// 3. 中间件处理函数
// ============================================================

/**
 * 默认中间件处理函数。
 *
 * @param {Request} request - 原始请求对象（Web API Request）
 * @returns {Promise<Response>} 转发后的响应对象
 */
export default async function middleware(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // ----------------------------------------------------------
  // 3a. 处理 OPTIONS 预检请求（必须在匹配上游之前响应）
  // ----------------------------------------------------------
  if (request.method === 'OPTIONS' && pathname === '/api/webdav') {
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
    return new Response('Proxy route not found', { status: 404 });
  }

  const upstream = UPSTREAMS[matchedPrefix];

  // ----------------------------------------------------------
  // 3c. 构建转发请求头（严格清洗）
  // ----------------------------------------------------------
  const forwardHeaders = new Headers();
  let upstreamUrl;

  if (upstream.dynamic) {
    // ============ 动态路由：/api/webdav ============
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      return new Response('Missing url parameter', { status: 400 });
    }
    upstreamUrl = targetUrl;

    // 严格清洗：仅保留允许的请求头，剔除所有可能干扰上游的浏览器/代理头
    for (const [key, value] of request.headers.entries()) {
      const lowerKey = key.toLowerCase();
      if (!isHeaderBlocked(lowerKey)) {
        forwardHeaders.set(key, value);
      }
    }

    // 设置统一 User-Agent（部分 WebDAV 服务器要求）
    forwardHeaders.set('User-Agent', 'Mozilla/5.0 (compatible; WebDAVClient/1.0)');
  } else {
    // ============ 静态路由：/api-gtimg / /api-qt / /api/eastmoney ============
    const upstreamPath = pathname.slice(matchedPrefix.length) || '/';
    upstreamUrl = `${upstream.base}${upstreamPath}${url.search}`;

    // 1. 注入上游要求的头（Referer, User-Agent 等）
    for (const [key, value] of Object.entries(upstream.headers)) {
      forwardHeaders.set(key, value);
    }
    // 2. 透传原始请求头（仅剔除 host 和 Vercel 内部头）
    for (const [key, value] of request.headers.entries()) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'host') continue;
      if (BLOCKED_PREFIXES.some((prefix) => lowerKey.startsWith(prefix))) continue;
      forwardHeaders.set(key, value);
    }
  }

  // ----------------------------------------------------------
  // 3d. 构造上游请求
  // ----------------------------------------------------------
  const requestInit = {
    method: request.method,
    headers: forwardHeaders,
  };

  // 非 GET/HEAD 请求透传 body
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    requestInit.body = request.body;
  }

  // ----------------------------------------------------------
  // 3e. 转发请求并返回响应
  // ----------------------------------------------------------
  try {
    const upstreamResponse = await fetch(upstreamUrl, requestInit);

    // 构建响应头：透传上游头 + CORS 头
    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY, OPTIONS',
    );
    responseHeaders.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Depth, Destination, Overwrite',
    );
    responseHeaders.set(
      'Access-Control-Expose-Headers',
      'Content-Type, Content-Length, ETag',
    );

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(`Proxy error: ${message}`, { status: 502 });
  }
}