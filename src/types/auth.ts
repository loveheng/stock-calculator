/**
 * @file auth.ts
 * @description E2EE 鉴权体系的共享类型定义：后端会话/档案响应、本地 IndexedDB 记录、
 *              注册期待备份内存态、待传队列结构。
 *              密码学约定参见 docs/e2ee-auth-spec.md §3；
 *              后端接口契约参见《E2EE 用户服务 · 接口文档 v1.0》（Spring Boot :18080）。
 * @layer Types
 * @storage_impact 本文件仅声明类型；AuthDB_v1 持久化结构见 sessionPersistence.ts。
 */

/** 后端信封 data：注册 / 登录 / 找回 confirm 返回的会话信息 */
export interface AuthSessionResponse {
  /** 用户 id（uuid），即密文档案归属 id */
  userId: string;
  /** 会话令牌：43 字符 base64url（256-bit 熵），服务端落库为 SHA-256 */
  token: string;
  /** ISO-8601 带时区的会话过期时间 */
  expiresAt: string;
  /**
   * 档案存在性三态：
   * - true  → 正常拉取密文档案解锁
   * - false → 账号存在但档案缺行（孤儿引导 / 补传信号，合法中间态）
   * - null  → 仅注册流出现
   */
  hasProfile: boolean | null;
}

/** 已登录用户的最小信息（后端不返回邮箱，由本地会话存储补充） */
export interface AuthUser {
  id: string;
  email: string;
}

/** 客户端封装产物：Base64 密文 + Base64 12 字节 IV */
export interface WrappedPayload {
  payload: string;
  iv: string;
}

/** 四密文集合（PUT /profile 请求体 / GET /profile 响应共通部分） */
export interface ProfilePayloads {
  /** KEK 封装 MEK raw bytes 的密文 */
  passwordPayload: string;
  passwordIv: string;
  /** Recovery Key 封装 MEK raw bytes 的密文 */
  recoveryPayload: string;
  recoveryIv: string;
}

/** GET /profile 响应（updatedAt 兼作 If-Match 乐观锁版本号） */
export interface ProfileResponse extends ProfilePayloads {
  /** 服务端版本号，规范 UTC 文本（如 2026-08-31T05:25:17.230304Z）；无行时无意义 */
  updatedAt: string | null;
}

/**
 * 独立 IndexedDB AuthDB_v1.auth_device_keys 单记录：
 * 设备免密会话（DeviceKey 非导出 CryptoKey 原生存储）。
 */
export interface DeviceSessionRecord {
  id: 'current_session';
  /** Base64: DeviceKey 加密的 MEK raw bytes */
  encryptedMekRaw: string;
  /** Base64: 12 字节 IV */
  deviceIv: string;
  /** 非导出设备密钥（extractable: false），structured clone 原生存储 */
  deviceKey: CryptoKey;
  /** 过期时间戳 (ms) */
  expiresAt: number;
  /** 滑动续期步长 (ms)，如 7 * 24 * 3600 * 1000 */
  ttlMs: number;
}

/** AuthDB_v1.auth_meta 键值记录 */
export interface AuthMetaRecord {
  key: string;
  value: unknown;
}

/**
 * 注册期待备份内存态（仅存 Zustand 内存，不入库不入 localStorage）。
 * 不变量 D9：recovery_payload 只能为「用户已通过抽查证明已记录」的助记词上传，
 * 因此该状态先于任何上传存在，抽查通过后才尝试落库。
 */
export interface PendingBackup {
  mnemonic: string;
  passwordPayload: WrappedPayload;
  recoveryPayload: WrappedPayload;
}

/**
 * auth_meta 待传队列：注册/补传 PUT /profile 网络失败时落盘（密文安全）。
 * ifMatch 记录失败当时的档案版本，重连重放时回传；409 时以服务端版本决策。
 */
export interface PendingProfileUpload extends ProfilePayloads {
  ifMatch: string | null;
  savedAt: number;
}

/** 后端信封业务错误码（HTTP 恒 200，唯一例外：拦截器直写 HTTP 401） */
export type AuthApiErrorCode = 400 | 401 | 404 | 409 | 429 | 500;
