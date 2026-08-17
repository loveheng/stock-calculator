/**
 * @file api/webdav.js
 * @description Vercel 原生 Serverless Function（API 路由，随 Vercel 标准构建自动发现）：
 *              用于 WebDAV 的纯白名单反向代理。
 *
 * 【为什么用它替代 middleware.js 的 /api/webdav】
 *   Vercel 的 /api/* 目录下的文件会被编译为独立 Serverless Function（文件系统路由），
 *   其优先级【高于】 vercel.json 里的 catch-all rewrite（/(.*) → /index.html）。
 *   而 middleware.js 对 /api/webdav 的匹配/转发在 rewrite 落点上游，请求一旦滑落
 *   就会命中 SPA 静态层报 405 Method Not Allowed —— 这正是之前的根因。
 *   迁到 api/webdav.js 后，/api/webdav 必然命中本函数，彻底根治 405。
 *
 * 【核心设计】
 *   1) OPTIONS 预检在函数【首行】直接响应 200（解决 405）。
 *   2) 严格白名单头转发（authorization / content-type / depth / overwrite /
 *      if-match / if-none-match），剥离浏览器特征头（host / origin / referer /
 *      cookie / sec-fetch-* / x-vercel-* / x-forwarded-*），解决上游 403。
 *   3) 统一干净的 User-Agent，不携带浏览器指纹。
 *
 * @runtime Edge（全球边缘节点，支持流式传输）
 */

export const config = {
  runtime: 'edge', // 使用 Edge 运行环境，全球极速且支持流式传输
};

export default async function handler(req) {
  // 1. 处理 OPTIONS 预检请求
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS, PROPFIND, MKCOL, MOVE, COPY',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const url = new URL(req.url);
  const targetUrlStr = url.searchParams.get('url');

  if (!targetUrlStr) {
    return new Response(JSON.stringify({ error: 'Missing ?url= parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    const targetUrl = new URL(targetUrlStr);
    const upstreamHeaders = new Headers();

    // 2. 白名单请求头清洗（杜绝 403）
    const ALLOWED_HEADERS = ['authorization', 'content-type', 'depth', 'overwrite', 'if-match', 'if-none-match'];
    for (const [key, val] of req.headers.entries()) {
      if (ALLOWED_HEADERS.includes(key.toLowerCase())) {
        upstreamHeaders.set(key, val);
      }
    }
    upstreamHeaders.set('User-Agent', 'Stock-Calculator-WebDAV/1.0');

    const hasBody = !['GET', 'HEAD', 'OPTIONS', 'PROPFIND'].includes(req.method) && req.body;

    // 3. 向上游发起 WebDAV 请求
    const upstreamResponse = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: upstreamHeaders,
      body: hasBody ? req.body : undefined,
      duplex: 'half',
    });

    const resHeaders = new Headers(upstreamResponse.headers);
    resHeaders.set('Access-Control-Allow-Origin', '*');
    resHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS, PROPFIND, MKCOL, MOVE, COPY');
    resHeaders.set('Access-Control-Allow-Headers', '*');

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: resHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}