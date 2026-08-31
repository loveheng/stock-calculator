/**
 * @file cryptoService.test.ts
 * @description cryptoService 单元测试：Base64 编解码、邮箱归一化、随机 MEK 生成、
 *              authHash / KEK 派生、封装/解封回环、业务 payload 加解密回环与防篡改。
 *              运行环境：Node（WebCrypto 由全局 crypto 提供，Node 18+）。
 * @layer Test
 */

import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  decryptPayload,
  deriveAuthHash,
  deriveKEK,
  encryptPayload,
  exportRawKey,
  generateRandomMEK,
  importRawKey,
  normalizeEmail,
  unwrapMEK,
  wrapMEK,
} from '../services/cryptoService';

const HEX64 = /^[0-9a-f]{64}$/;
/** 12 字节 IV 的 Base64 编码长度恒为 16（含 padding） */
const IV_B64_LEN = 16;

describe('normalizeEmail', () => {
  it('trim + 小写归一化', () => {
    expect(normalizeEmail('  User@Example.COM ')).toBe('user@example.com');
  });
});

describe('Base64 编解码', () => {
  it('标准向量', () => {
    expect(bytesToBase64(new TextEncoder().encode('hello'))).toBe('aGVsbG8=');
  });

  it('空数组往返一致', () => {
    expect(base64ToBytes('')).toEqual(new Uint8Array(0));
  });

  it('任意字节往返一致', () => {
    const bytes = new Uint8Array([0, 1, 250, 255, 128, 7, 3]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('大数组（分块编码路径，> 0x8000）往返一致', () => {
    // getRandomValues 单次调用上限 65536 字节（Web Crypto 规范），分块填充
    const bytes = new Uint8Array(100_000);
    for (let off = 0; off < bytes.length; off += 65536) {
      bytes.set(crypto.getRandomValues(new Uint8Array(Math.min(65536, bytes.length - off))), off);
    }
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

describe('generateRandomMEK', () => {
  it('生成可导出的 AES-GCM 256 密钥（usages 正确）', async () => {
    const mek = await generateRandomMEK();
    expect(mek.algorithm.name).toBe('AES-GCM');
    expect((mek.algorithm as AesKeyAlgorithm).length).toBe(256);
    expect(mek.extractable).toBe(true);
    expect([...mek.usages].sort()).toEqual(['decrypt', 'encrypt']);
  });

  it('两次生成得到不同密钥，raw 长度 32 字节', async () => {
    const [a, b] = await Promise.all([generateRandomMEK(), generateRandomMEK()]);
    const [ra, rb] = await Promise.all([exportRawKey(a), exportRawKey(b)]);
    expect(ra).toHaveLength(32);
    expect(rb).toHaveLength(32);
    expect([...ra]).not.toEqual([...rb]);
  });
});

describe('deriveAuthHash', () => {
  it('产出 64 位小写 hex，且确定性（邮箱归一化同盐）', async () => {
    const h1 = await deriveAuthHash('password123', 'User@Test.com');
    const h2 = await deriveAuthHash('password123', '  user@test.com  ');
    expect(h1).toMatch(HEX64);
    expect(h1).toBe(h2);
  });

  it('不同密码 → 不同哈希', async () => {
    const a = await deriveAuthHash('password123', 'a@b.com');
    const b = await deriveAuthHash('password124', 'a@b.com');
    expect(a).not.toBe(b);
  });

  it('不同邮箱 → 不同哈希（盐含邮箱）', async () => {
    const a = await deriveAuthHash('same-pass', 'a@b.com');
    const b = await deriveAuthHash('same-pass', 'b@b.com');
    expect(a).not.toBe(b);
  });
});

describe('deriveKEK + wrap/unwrap 回环', () => {
  it('正确 KEK 解封出相同 MEK raw', async () => {
    const mek = await generateRandomMEK();
    const kek = await deriveKEK('password123', 'user@test.com');
    const wrapped = await wrapMEK(mek, kek);
    expect(wrapped.iv).toHaveLength(IV_B64_LEN);
    const unwrapped = await unwrapMEK(wrapped.payload, wrapped.iv, kek);
    expect(await exportRawKey(unwrapped)).toEqual(await exportRawKey(mek));
  });

  it('错误 KEK 解封失败（AES-GCM OperationError）', async () => {
    const mek = await generateRandomMEK();
    const kek = await deriveKEK('password123', 'user@test.com');
    const wrong = await deriveKEK('wrong-password', 'user@test.com');
    const wrapped = await wrapMEK(mek, kek);
    await expect(unwrapMEK(wrapped.payload, wrapped.iv, wrong)).rejects.toThrow();
  });

  it('每次封装 IV 随机（同 MEK 同 KEK 两次封装密文不同）', async () => {
    const mek = await generateRandomMEK();
    const kek = await deriveKEK('password123', 'u@t.com');
    const w1 = await wrapMEK(mek, kek);
    const w2 = await wrapMEK(mek, kek);
    expect(w1.iv).not.toBe(w2.iv);
    expect(w1.payload).not.toBe(w2.payload);
  });
});

describe('encryptPayload / decryptPayload 回环', () => {
  it('嵌套对象往返一致', async () => {
    const mek = await generateRandomMEK();
    const data = { a: 1, b: ['x', 'y'], c: { d: true, e: null }, f: 1.25 };
    const { cipherText, iv } = await encryptPayload(data, mek);
    expect(iv).toHaveLength(IV_B64_LEN);
    await expect(decryptPayload(cipherText, iv, mek)).resolves.toEqual(data);
  });

  it('密文被篡改 → 解密失败（GCM Tag 校验）', async () => {
    const mek = await generateRandomMEK();
    const { cipherText, iv } = await encryptPayload({ v: 1 }, mek);
    const bytes = base64ToBytes(cipherText);
    bytes[0] ^= 0xff;
    await expect(decryptPayload(bytesToBase64(bytes), iv, mek)).rejects.toThrow();
  });

  it('错误密钥解密失败', async () => {
    const mek = await generateRandomMEK();
    const other = await generateRandomMEK();
    const { cipherText, iv } = await encryptPayload({ v: 1 }, mek);
    await expect(decryptPayload(cipherText, iv, other)).rejects.toThrow();
  });
});

describe('exportRawKey / importRawKey', () => {
  it('导出再导入回环一致', async () => {
    const mek = await generateRandomMEK();
    const raw = await exportRawKey(mek);
    expect(raw).toHaveLength(32);
    const re = await importRawKey(raw);
    expect(await exportRawKey(re)).toEqual(raw);
  });
});
