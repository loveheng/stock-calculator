/**
 * @file server/webdav-proxy.mjs
 * @description Docker 运行时的 WebDAV 代理（行为 1:1 对应 Vercel Serverless Function api/webdav.js）。
 *
 * 【零拦截原则】除 OPTIONS 预检外，把所有方法（含 PROPFIND/MKCOL/MOVE/COPY）
 * 原样转发给上游，上游返回什么状态就透传什么状态。
 *
 * 【核心设计】（与 api/webdav.js 一致）
 *   1) 所有响应（含 400/502 错误）设置全量 CORS 头；
 *   2) OPTIONS 预检直接返回 200；
 *   3) 严格白名单头转发（authorization / content-type / depth / overwrite /
 *      if-match / if-none-match），剥离浏览器特征头（host / origin / referer / cookie）；
 *   4) 统一干净的 User-Agent，不携带浏览器指纹。
 *
 * @layer Config
 */

const ALLOWED_METHODS = [
  'GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PROPFIND', 'MKCOL', 'MOVE', 'COPY',
];

/** 严格白名单头：仅这些头会转发给上游。 */
const ALLOWED_HEADERS = [
  'authorization', 'content-type', 'depth', 'overwrite', 'if-match', 'if-none-match',
];

/**
 * 处理 /api/webdav 请求（同 api/webdav.js handler）。
 *
 * @param {Request} request Web API Request
 * @returns {Promise<Response>}
 */
export async function handleWebdav(request) {
  // 1. 全量 CORS 头（对所有响应生效，含 400/502 错误）
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': ALLOWED_METHODS.join(', '),
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };

  // 2. OPTIONS 预检直接 200
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // 3. 提取目标 URL
  const url = new URL(request.url);
  const targetUrlStr = url.searchParams.get('url');
  if (!targetUrlStr) {
    return new Response(JSON.stringify({ error: 'Missing ?url= parameter' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    console.log(`[WebDAV Proxy] ${request.method} -> ${targetUrlStr}`);
    const targetUrl = new URL(targetUrlStr);

    // 4. 清洗请求头（白名单传递，坚决剔除 host/origin/referer 杜绝 403）
    const upstreamHeaders = { 'User-Agent': 'Stock-Calculator-WebDAV/1.0' };
    for (const [key, value] of request.headers.entries()) {
      if (ALLOWED_HEADERS.includes(key.toLowerCase()) && value) {
        upstreamHeaders[key] = value;
      }
    }

    // 5. Body：GET/HEAD/OPTIONS 不携带，其余透传（PUT/PROPFIND 等都可能带体）
    let body;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      body = await request.arrayBuffer();
      if (body.byteLength === 0) body = undefined;
    }

    // 6. 发起上游 WebDAV 请求（方法原样转发，不做拦截）
    const upstreamResponse = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: upstreamHeaders,
      body,
    });

    console.log(
      `[WebDAV Upstream] Response Status: ${upstreamResponse.status} ${upstreamResponse.statusText}`,
    );

    // 7. 透传上游头与状态码（剔除 hop-by-hop / 编码头）
    const responseHeaders = new Headers();
    upstreamResponse.headers.forEach((val, key) => {
      if (!['content-encoding', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
        responseHeaders.set(key, val);
      }
    });
    for (const [key, value] of Object.entries(corsHeaders)) {
      responseHeaders.set(key, value);
    }

    const bodyBuffer = await upstreamResponse.arrayBuffer();
    return new Response(bodyBuffer, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error('[WebDAV Proxy Error]:', err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown' }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
