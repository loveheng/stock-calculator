/**
 * @file mnemonicService.ts
 * @description BIP-39 助记词管理：12 词生成、归一化、合法性校验、Recovery Key 派生。
 *              基于 @scure/bip39（经审计实现）+ 英文词表。
 * @layer Service
 * @storage_impact 纯内存计算；助记词仅存在于 PendingBackup 内存态与用户自行备份，禁止落盘。
 *
 * 【注意】此处刻意不使用 @scure/bip39 的 mnemonicToSeed*（其内部是 BIP-39 约定的
 * 2048 轮 PBKDF2、固定 salt 'mnemonic'），而是按前端规范 §3 以归一化助记词字符串作
 * PBKDF2 口令、固定 salt 'mnemonic_recovery_salt'、100k 轮直接派生 Recovery Key。
 * 两条派生路径不得混用。助记词熵 ≈128-bit，远高于口令熵，固定 salt 无实际削弱。
 */

import { generateMnemonic, validateMnemonic as bip39Validate } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const PBKDF2_ITERATIONS = 100_000;
const RECOVERY_SALT = 'mnemonic_recovery_salt';

/** 助记词归一化：trim + 小写 + 按空白切分后单空格重组（支持一键粘贴多行/多空格输入） */
export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

/** 生成 12 词标准 BIP-39 助记词（128-bit 熵 + 4-bit 校验和） */
export function generateMnemonic12(): string {
  return generateMnemonic(wordlist, 128);
}

/** 校验助记词合法性（先归一化再走 BIP-39 校验和校验）；任何异常一律返回 false */
export function validateMnemonic(mnemonic: string): boolean {
  try {
    return bip39Validate(normalizeMnemonic(mnemonic), wordlist);
  } catch {
    return false;
  }
}

/**
 * 派生 Recovery Key（助记词封装密钥）：PBKDF2-HMAC-SHA-256，100k 轮，
 * 口令 = 归一化助记词，salt = 固定 'mnemonic_recovery_salt' → AES-GCM-256。
 * extractable:false——仅用于封装/解封 MEK raw bytes，永不导出。
 */
export async function deriveRecoveryKey(mnemonic: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(normalizeMnemonic(mnemonic)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const salt = new TextEncoder().encode(RECOVERY_SALT);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false, // extractable:false
    ['encrypt', 'decrypt'],
  );
}
