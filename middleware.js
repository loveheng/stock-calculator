/**
 * @file middleware.js
 * @description Vercel Edge Middleware：拦截 /api-gtimg、/api-qt、/api/eastmoney 请求，
 *              以服务端 fetch 方式转发到上游，并添加浏览器端无法设置的
 *              Referer、User-Agent 等请求头，解决生产环境外部 API 无法访问的问题。
 * @deployment 本文件部署至 Vercel Edge Runtime，运行于全球边缘节点，
 *             不占用 Node.js Serverless 冷启动时间。
 */

/**
 * 上游代理配置映射表。
 * 键为本地路径前缀，值为上游基础 URL 和需要注入的请求头。
 */
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
   * WebDAV 代理：用于转发跨域 WebDAV 请求。
   * 客户端通过 /api-webdav/proxy?url=... 传递目标 URL，
   * 服务端在拦截后注入 Basic Auth 头并转发，避免浏览器端 CORS 限制。
   */
  '/api-webdav': {
    base: '', // 动态 base：从查询参数 ?url= 中提取
    headers: {}, // 动态注入：从查询参数中提取 Authorization
    dynamic: true, // 标记为动态路由，需要特殊处理
  },
};

/**
 * 匹配路径前缀（按长度降序排序，避免 `/api/eastmoney` 被 `/api` 误匹配）。
 */
const SORTED_PREFIXES = Object.keys(UPSTREAMS).sort((a, b) => b.length - a.length);

/**
 * Vercel Edge Middleware 配置：仅匹配需要代理的路径，减少边缘函数调用次数。
 */
export const config = {
  matcher: ['/api-gtimg/:path*', '/api-qt/:path*', '/api/eastmoney/:path*', '/api-webdav/:path*'],
};

/**
 * 默认中间件处理函数。
 *
 * @param {Request} request - 原始请求对象（Web API Request）
 * @returns {Promise<Response>} 转发后的响应对象
 */
export default async function middleware(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // 处理浏览器 CORS 预检请求（OPTIONS）
  // 必须在匹配上游之前响应，避免预检请求被转发到上游
  if (request.method === 'OPTIONS' && pathname.startsWith('/api-webdav')) {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // 查找匹配的上游配置
  const matchedPrefix = SORTED_PREFIXES.find((prefix) => pathname.startsWith(prefix));
  if (!matchedPrefix) {
    return new Response('Proxy route not found', { status: 404 });
  }

  const upstream = UPSTREAMS[matchedPrefix];

  // 构建转发请求头：注入上游要求的头 + 透传原始请求头（除 host）
  const forwardHeaders = new Headers();
  const excludedPrefixes = ['x-vercel-', 'x-forwarded-'];

  let upstreamUrl;

  if (upstream.dynamic) {
    // 动态路由（/api-webdav）：从查询参数中提取 url 和 Authorization 头
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      return new Response('Missing url parameter', { status: 400 });
    }
    upstreamUrl = targetUrl;

    // 透传原始请求头（Authorization 由客户端携带，透传即可）
    for (const [key, value] of request.headers.entries()) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'host') continue;
      if (excludedPrefixes.some((prefix) => lowerKey.startsWith(prefix))) continue;
      forwardHeaders.set(key, value);
    }
  } else {
    // 静态路由：拼接 upstream base + path
    const upstreamPath = pathname.slice(matchedPrefix.length) || '/';
    upstreamUrl = `${upstream.base}${upstreamPath}${url.search}`;

    // 1. 注入上游要求的头（Referer, User-Agent 等）
    for (const [key, value] of Object.entries(upstream.headers)) {
      forwardHeaders.set(key, value);
    }
    // 2. 透传原始请求头
    for (const [key, value] of request.headers.entries()) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'host') continue;
      if (excludedPrefixes.some((prefix) => lowerKey.startsWith(prefix))) continue;
      forwardHeaders.set(key, value);
    }
  }

  // 构造上游请求
  const requestInit = {
    method: request.method,
    headers: forwardHeaders,
  };

  // 非 GET/HEAD 请求传递 body
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    requestInit.body = request.body;
  }

  try {
    // 转发请求到上游
    const upstreamResponse = await fetch(upstreamUrl, requestInit);

    // 构建响应头（透传上游响应头 + 添加 CORS 头）
    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PROPFIND, PUT, DELETE, MKCOL, MOVE, COPY');
    responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Depth, Destination, Overwrite');
    responseHeaders.set('Access-Control-Expose-Headers', 'Content-Type, Content-Length, ETag');

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    // 网络错误时返回友好提示
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(`Proxy error: ${message}`, { status: 502 });
  }
}