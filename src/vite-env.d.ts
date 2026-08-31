/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare module '*.css' {
  const content: string;
  export default content;
}

interface ImportMetaEnv {
  /** E2EE 认证服务基地址（Spring Boot :18080），如 http://localhost:18080/api/auth */
  readonly VITE_AUTH_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}