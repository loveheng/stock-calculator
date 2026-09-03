/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare module '*.css' {
  const content: string;
  export default content;
}

interface ImportMetaEnv {
  /** E2EE 认证服务基地址（Spring Boot :18080），如 http://localhost:18080/api/auth */
  readonly VITE_AUTH_API_BASE_URL?: string;
  /** Copilot 服务基地址（默认 /api/copilot，同源代理） */
  readonly VITE_COPILOT_API_BASE_URL?: string;
  /** 置 '1' 启用 Copilot 本地 Mock 桩（不发起真实网络请求） */
  readonly VITE_COPILOT_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}