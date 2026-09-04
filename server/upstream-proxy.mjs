/**
 * @file server/upstream-proxy.mjs
 * @description Docker 运行时的静态上游代理（行为 1:1 对应 Vercel Edge Middleware middleware.js）。
 *
 * 仅拦截以下白名单前缀并转发：
 *   - /api-gtimg/*      → https://smartbox.gtimg.cn/*
 *   - /api-qt/*         → https://qt.gtimg.cn/*
 *   - /api-kline/*      → https://ifzq.gtimg.cn/*
 *   - /api/eastmoney/*  → https://searchapi.eastmoney.com/*
 *   - /api/import/*     → OCR 交割单识别服务（保留前缀，可用 IMPORT_UPSTREAM 覆盖）
 *   - /api/auth/*       → E2EE 认证服务（保留前缀，可用 AUTH_UPSTREAM 覆盖）
 *
 * 与 middleware.js 一致的设计：
 *   1. OPTIONS 预检直接返回 200；
 *   2. 标准方法白名单（GET/HEAD/POST/PUT/DELETE/OPTIONS），之外 405；
 *   3. 注入上游业务头（Referer / User-Agent），剥离 host 与 x-vercel-* / x-forwarded-*；
 *   4. 所有响应（含错误）统一追加 CORS 头。
 *
 * @layer Config
 */

import { UPSTREAMS as ONLINE_UPSTREAMS } from '../proxy.config.js';

/**
 * 上游代理配置映射表（结构同 middleware.js）。
 * /api/import 与 /api/auth 默认取 proxy.config.js 的线上地址，
 * Docker 场景可用环境变量覆盖（例如指向自建后端容器）。
 */
export const UPSTREAMS = {
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
  '/api/import': {
    base: process.env.IMPORT_UPSTREAM || ONLINE_UPSTREAMS.online.import,
    headers: {},
    stripPrefix: false,
  },
  '/api/auth': {
    base: process.env.AUTH_UPSTREAM || ONLINE_UPSTREAMS.online.auth,
    headers: {},
    stripPrefix: false,
  },
};

/** 匹配路径前缀（按长度降序，避免 /api/eastmoney 被 /api 误匹配）。 */
const SORTED_PREFIXES = Object.keys(UPSTREAMS).sort((a, b) => b.length - a.length);

/** 需剔除的内部头前缀（同 middleware.js）。 */
const BLOCKED_PREFIXES = ['x-vercel-', 'x-forwarded-'];

/** 标准 HTTP 方法白名单（HEAD 必须显式放行）。 */
export const ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'];

/** 统一 CORS 头：所有响应（含错误）必须携带。 */
export const CORS_ALLOW_ORIGIN = { 'Access-Control-Allow-Origin': '*' };

/** 该路径是否命中静态上游代理（/api/webdav 不在此列，由 webdav-proxy 处理）。 */
export function matchUpstream(pathname) {
  return SORTED_PREFIXES.find((prefix) => pathname.startsWith(prefix)) || null;
}

/** OPTIONS 预检统一响应（同 middleware.js 3a）。 */
export function preflightResponse() {
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

/**
 * 转发请求到匹配的上游（对应 middleware.js 3b–3d）。
 *
 * @param {string} matchedPrefix 命中的前缀（matchUpstream 的返回值）
 * @param {Request} request Web API Request
 * @returns {Promise<Response>}
 */
export async function forwardUpstream(matchedPrefix, request) {
  const url = new URL(request.url);
  const upstream = UPSTREAMS[matchedPrefix];

  if (!ALLOWED_METHODS.includes(request.method)) {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { ...CORS_ALLOW_ORIGIN, Allow: ALLOWED_METHODS.join(', ') },
    });
  }

  const upstreamPath =
    upstream.stripPrefix === false
      ? url.pathname
      : url.pathname.slice(matchedPrefix.length) || '/';
  const upstreamUrl = `${upstream.base}${upstreamPath}${url.search}`;

  // 注入上游业务头 + 剔除内部头（host / x-vercel-* / x-forwarded-*）
  const forwardHeaders = new Headers();
  for (const [key, value] of Object.entries(upstream.headers)) {
    forwardHeaders.set(key, value);
  }
  for (const [key, value] of request.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'host') continue;
    if (BLOCKED_PREFIXES.some((prefix) => lowerKey.startsWith(prefix))) continue;
    forwardHeaders.set(key, value);
  }

  // HEAD/GET 不携带 body，其余透传
  const requestInit = { method: request.method, headers: forwardHeaders };
  if (request.method === 'GET' || request.method === 'HEAD') {
    requestInit.body = undefined;
  } else {
    requestInit.body = request.body;
  }

  try {
    const upstreamResponse = await fetch(upstreamUrl, requestInit);

    // 透传上游头 + 统一追加 CORS 头
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
