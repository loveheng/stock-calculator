/**
 * @file api/webdav.js
 * @description Vercel 原生 Serverless Function（API 路由，随 Vercel 标准构建自动发现）。
 *
 * 【运行环境】Node.js Runtime（显式声明，覆盖历史配置里的 edge）。
 *
 * 【为什么用它替代 middleware.js 的 /api/webdav】
 *   Vercel 的 /api/* 目录下的文件会被编译为独立 Serverless Function（文件系统路由），
 *   其优先级【高于】 vercel.json 里的 catch-all rewrite（/(.*) → /index.html）。
 *   /api/webdav 必然命中本函数，不会滑落到 SPA 静态层报 405。
 *
 * 【零拦截原则】
 *   本函数【不做任何底层方法白名单/48x 拦截】——除 OPTIONS 预检外，把所有方法与
 *   PROPFIND/MKCOL/MOVE/COPY 原样转发给上游。上游返回什么状态就透传什么状态，
 *   不再在函数内部额外产生 405。
 *
 * 【核心设计】
 *   1) 在函数【首行】为所有响应设置全量 CORS 头（含 400/502 等错误响应）。
 *   2) OPTIONS 预检直接返回 200。
 *   3) 严格白名单头转发（authorization / content-type / depth / destination /
 *      overwrite / if-match / if-none-match），剥离浏览器特征头（host / origin /
 *      referer / cookie / …，含 X-Webdav-Target 本身），解决上游 403。
 *   4) 统一干净的 User-Agent，不携带浏览器指纹。
 *
 * 【目标寻址】（与同源 Nginx 透明代理约定一致）
 *   - 新版：前端请求发往同源 /api/webdav/<path>，目标根地址由请求头
 *     X-Webdav-Target 携带，上游 URL = 目标根 + 去除 /api/webdav 前缀后的子路径；
 *   - 兼容：PWA 缓存的旧版客户端仍以 /api/webdav?url=<完整目标URL> 发请求，
 *     该模式继续支持（目标即完整上游 URL，不拼接子路径）。
 *   - MOVE/COPY 的 Destination 头由前端拼为【第三方服务器绝对 URL】并原样透传，
 *     绝不能改写成代理侧域名。
 *
 * 【注意】Vercel Node 函数里 req.body 不会自动解析，必须读取请求流（stream）才能拿到
 *   PUT/PROPFIND 的请求体，否则上传/备份会发出空文件。
 */

export const config = {
  runtime: 'nodejs',
};

const ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PROPFIND', 'MKCOL', 'MOVE', 'COPY'];

/** 读取 Node 请求流，返回完整 Buffer（无 body 时为空 Buffer）。 */
function readRequestBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

export default async function handler(req, res) {
  // 1. 设置全量 CORS 响应头（对所有响应生效，含 400/502 错误）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS.join(', '));
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');

  // 2. 拦截 OPTIONS 预检请求，直接返回 200
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 3. 提取目标根地址：优先 X-Webdav-Target 请求头（同源代理约定），
  //    兼容旧版 PWA 客户端的 ?url= 查询参数
  const headerTarget = String(req.headers['x-webdav-target'] || '').trim();
  const legacyTarget = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  const targetUrlStr = headerTarget || legacyTarget;
  if (!targetUrlStr) {
    return res.status(400).json({ error: 'Missing X-Webdav-Target header (or legacy ?url= parameter)' });
  }

  try {
    // 上游地址：
    //   - 头模式：目标根地址 + 去除 /api/webdav 前缀后的请求路径（编码原样透传）；
    //   - 兼容模式（?url=）：目标即完整上游 URL，不再拼接子路径。
    const targetUrl = new URL(targetUrlStr);
    if (headerTarget) {
      const reqUrl = new URL(req.url, 'https://proxy.internal');
      let subPath = reqUrl.pathname.startsWith('/api/webdav')
        ? reqUrl.pathname.slice('/api/webdav'.length)
        : reqUrl.pathname;
      if (!subPath) subPath = '/';
      targetUrl.pathname = (targetUrl.pathname.replace(/\/+$/, '') + subPath) || '/';
    }
    console.log(`[WebDAV Proxy] ${req.method} -> ${targetUrl.toString()}`);

    // 4. 清洗请求头（白名单传递，坚决剔除 host/origin/referer 杜绝 403）
    const upstreamHeaders = {
      'User-Agent': 'Stock-Calculator-WebDAV/1.0',
    };

    // destination：MOVE/COPY 必需（前端已拼为第三方服务器绝对 URL，原样透传）
    const ALLOWED_HEADERS = ['authorization', 'content-type', 'depth', 'destination', 'overwrite', 'if-match', 'if-none-match'];
    for (const [key, value] of Object.entries(req.headers)) {
      if (ALLOWED_HEADERS.includes(key.toLowerCase()) && value) {
        upstreamHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
      }
    }

    // 5. 读取 Body（PUT / POST / PROPFIND / MKCOL 等写/探测方法都可能携带请求体；
    //    GET / HEAD / OPTIONS 不携带。Vercel Node 函数需手动消费请求流。）
    let body;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const raw = await readRequestBody(req);
      body = raw.length > 0 ? raw : undefined;
    }

    // 6. 发起上游 WebDAV 请求（方法原样转发，不做拦截）
    const upstreamResponse = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: upstreamHeaders,
      body,
    });

    console.log(`[WebDAV Upstream] Response Status: ${upstreamResponse.status} ${upstreamResponse.statusText}`);

    // 7. 透传上游响应头与状态码（剔除 hop-by-hop 头）
    upstreamResponse.headers.forEach((val, key) => {
      if (!['content-encoding', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
        res.setHeader(key, val);
      }
    });

    res.status(upstreamResponse.status);
    const arrayBuffer = await upstreamResponse.arrayBuffer();
    return res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error('[WebDAV Proxy Error]:', err);
    return res.status(502).json({ error: err.message });
  }
}