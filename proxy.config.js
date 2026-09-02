/**
 * @file proxy.config.js
 * @description 代理上游地址统一配置（单一事实来源）· 防呆版。
 *
 * 结构：online（线上固定地址）/ local（本机联调地址）两套 + 一个仅影响本地开发的开关。
 *
 * 【防呆设计】
 *   1. DEV_UPSTREAM_ENV 开关只被 vite.config.ts（本地开发代理）读取；
 *   2. middleware.js（Vercel 线上）结构上只读 UPSTREAMS.online，物理上不可能用到
 *      local 地址 → 本地切到 local 后忘改回来，线上也完全不受影响；
 *   3. middleware.js 另有运行时护栏：线上/预览环境下若解析到本地地址，
 *      直接返回 502 并给出明确中文提示，而不是难排查的 Connection refused；
 *   4. vite dev server 启动时对开关值做 fail-fast 校验，写错立即报错。
 *
 * @layer Config
 */

/** 线上固定上游（Vercel 生产/预览唯一来源，勿改为本地地址） */
export const UPSTREAMS = {
  online: {
    /** E2EE 认证服务 /api/auth/*（Spring Boot，与 OCR 同源部署） */
    auth: 'https://sc.oklhj.eu.org',
    /** OCR 交割单识别 /api/import/*（与认证服务同一 Spring Boot 应用） */
    import: 'https://sc.oklhj.eu.org',
  },
  local: {
    /** 本机 Spring Boot（联调用） */
    auth: 'http://localhost:18080',
    import: 'http://localhost:18080',
  },
};

/**
 * 本地开发代理上游选择（仅 vite dev 生效，对线上零影响）：
 *   'online' → 本地开发也走线上服务（默认）
 *   'local'  → 本地开发连本机 Spring Boot（联调用）
 */
export const DEV_UPSTREAM_ENV = 'online'; // 'online' | 'local'
