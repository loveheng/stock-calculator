/**
 * @file cryptoService.ts
 * @description E2EE 密码学核心：随机 MEK 生成、PBKDF2 派生（Auth Hash / KEK）、
 *              MEK 封装/解封、业务 JSON 加解密、Base64 工具。
 *              全部基于浏览器原生 WebCrypto（window.crypto.subtle），禁止引入第三方加解密库。
 * @layer Service
 * @storage_impact 纯内存计算；MEK raw bytes 仅经此模块导出/导入，禁止落盘、禁止进 localStorage。
 *
 * 【密码学参数——严禁修改】docs/e2ee-auth-spec.md §3：
 * - KDF：PBKDF2-HMAC-SHA-256，迭代固定 100,000 次。
 *   安全注记：100k 低于 OWASP 2023 建议（600k），属评审接受的约束——Auth Hash 仅作为
 *   "发给后端的密码"（服务端另有 bcrypt(10) 兜底）；KEK/Recovery Key 被离线爆破的前提
 *   是攻击者已持有对应密文。
 * - Auth Hash：salt = 'auth_salt_' + 归一化邮箱 → 256 位 → 64 位小写 hex。
 * - KEK：salt = 'kek_salt_' + 归一化邮箱 → AES-GCM-256，extractable:false。
 * - Recovery Key（见 mnemonicService）：salt = 'mnemonic_recovery_salt'。
 * - AES-GCM：IV 每次随机 12 字节（crypto.getRandomValues），TagLength 默认 128 位。
 * - MEK：AES-GCM-256，extractable:true（导出 raw 供三层封装必需）。
 */

const PBKDF2_ITERATIONS = 100_000;

/** 邮箱归一化：trim + 小写（派生 salt 与后端请求必须使用同一结果） */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function textEncode(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s);
}

/** Uint8Array → Base64：分块转换，避免大缓冲区触发 btoa 调用栈溢出 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Base64 → Uint8Array（返回 ArrayBuffer 背靠，可直接作为 BufferSource 传入 WebCrypto） */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 每次加密生成 12 字节随机 IV（规范强制，禁止复用） */
function randomIv(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(12));
}

/**
 * 生成随机 MEK：256-bit AES-GCM，extractable:true（三层封装需导出 raw）。
 * MEK 终生不变；主密码/助记词/设备密钥仅作为它的封装密钥。
 */
export async function generateRandomMEK(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable：供 wrapMEK 导出 raw bytes
    ['encrypt', 'decrypt'],
  );
}

/**
 * 派生 Auth Hash（登录凭证）：PBKDF2(100k, auth_salt_email) → 64 位小写 hex。
 * 该值作为"密码"提交给后端 /register /login（主密码明文不出浏览器）。
 */
export async function deriveAuthHash(password: string, email: string): Promise<string> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    textEncode(password),
    'PBKDF2',
    false, // 派生密钥无需导出
    ['deriveBits'],
  );
  const salt = textEncode(`auth_salt_${normalizeEmail(email)}`);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    baseKey,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

/**
 * 派生 KEK（密码封装密钥）：PBKDF2(100k, kek_salt_email) → AES-GCM-256。
 * extractable:false——KEK 仅用于加解密 MEK raw bytes，永不导出。
 */
export async function deriveKEK(password: string, email: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    textEncode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const salt = textEncode(`kek_salt_${normalizeEmail(email)}`);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false, // extractable:false
    ['encrypt', 'decrypt'],
  );
}

/** 导出 MEK raw bytes（32 字节）。仅限封装流程内部使用。 */
export async function exportRawKey(key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

/** 重新导入为 AES-GCM-256 MEK（extractable:true，保持可再封装能力） */
export async function importRawKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

/**
 * 封装 MEK：导出 raw bytes → 用 wrappingKey（KEK/Recovery/DeviceKey）AES-GCM 加密 → Base64。
 * 密钥不匹配导致的解封失败在 unwrapMEK 侧以 OperationError 体现。
 */
export async function wrapMEK(
  mek: CryptoKey,
  wrappingKey: CryptoKey,
): Promise<{ payload: string; iv: string }> {
  const raw = await exportRawKey(mek);
  const iv = randomIv();
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, raw);
  return { payload: bytesToBase64(new Uint8Array(cipher)), iv: bytesToBase64(iv) };
}

/**
 * 解封 MEK：Base64 解码 → AES-GCM 解密 → 重新导入为 AES-GCM Key。
 * @throws OperationError 当 wrappingKey 不匹配 / 密文被篡改 / IV 错误（调用方需语义化为
 *         "主密码错误" / "助记词不正确"，严禁把解密失败的产物当 MEK 使用）。
 */
export async function unwrapMEK(
  payload: string,
  iv: string,
  wrappingKey: CryptoKey,
): Promise<CryptoKey> {
  const cipher = base64ToBytes(payload);
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv) }, wrappingKey, cipher);
  return importRawKey(new Uint8Array(raw));
}

/** 通用 JSON 加密（二期云端密文同步预留接口）：JSON → UTF-8 → AES-GCM(MEK) → Base64 */
export async function encryptPayload(
  data: unknown,
  mek: CryptoKey,
): Promise<{ cipherText: string; iv: string }> {
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    throw new Error('数据序列化失败：对象不可 JSON 化（可能存在循环引用）');
  }
  const iv = randomIv();
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, mek, textEncode(json));
  return { cipherText: bytesToBase64(new Uint8Array(cipher)), iv: bytesToBase64(iv) };
}

/** 通用 JSON 解密：Base64 → AES-GCM 解密 → JSON.parse */
export async function decryptPayload<T>(cipherText: string, iv: string, mek: CryptoKey): Promise<T> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv) },
    mek,
    base64ToBytes(cipherText),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
