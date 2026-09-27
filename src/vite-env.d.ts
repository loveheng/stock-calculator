/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare module '*.css' {
  const content: string;
  export default content;
}

interface ImportMetaEnv {
  /** 后端接口基地址（需要接后端时新增，配合 vite.config.ts 的 server.proxy 使用） */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
