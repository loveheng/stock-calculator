/**
 * @file mnemonicService.test.ts
 * @description mnemonicService 单元测试：12 词助记词生成、BIP-39 校验、
 *              归一化、Recovery Key 派生与封装/解封回环。
 * @layer Test
 */

import { describe, expect, it } from 'vitest';
import { exportRawKey, generateRandomMEK, unwrapMEK, wrapMEK } from '../services/cryptoService';
import {
  deriveRecoveryKey,
  generateMnemonic12,
  normalizeMnemonic,
  validateMnemonic,
} from '../services/mnemonicService';

describe('generateMnemonic12', () => {
  it('生成 12 个小写英文单词', () => {
    const words = generateMnemonic12().split(' ');
    expect(words).toHaveLength(12);
    for (const w of words) expect(w).toMatch(/^[a-z]+$/);
  });

  it('两次生成互不相同', () => {
    expect(generateMnemonic12()).not.toBe(generateMnemonic12());
  });
});

describe('validateMnemonic', () => {
  it('合法助记词通过（大小写/多余空白归一化后仍通过）', () => {
    const m = generateMnemonic12();
    expect(validateMnemonic(m)).toBe(true);
    expect(validateMnemonic('  ' + m.toUpperCase() + ' ')).toBe(true);
  });

  it('被替换单词 → 校验和破坏 → 不合法', () => {
    const words = generateMnemonic12().split(' ');
    const bad = words.map((w, i) => (i === 0 && w !== 'abandon' ? 'abandon' : 'zoo')).join(' ');
    expect(validateMnemonic(bad)).toBe(false);
  });

  it('词数不足 / 乱串 → 不合法', () => {
    expect(validateMnemonic('abandon')).toBe(false);
    expect(validateMnemonic('not a real mnemonic phrase at all')).toBe(false);
  });
});

describe('normalizeMnemonic', () => {
  it('多空白 / 换行 / 大小写归一化', () => {
    expect(normalizeMnemonic('  Abandon\n Ability\t able  ')).toBe('abandon ability able');
  });
});

describe('deriveRecoveryKey 回环', () => {
  it('同一助记词派生的 Recovery Key 可解封 MEK', async () => {
    const mnemonic = generateMnemonic12();
    const recoveryKey = await deriveRecoveryKey(mnemonic);
    expect(recoveryKey.algorithm.name).toBe('AES-GCM');

    const mek = await generateRandomMEK();
    const wrapped = await wrapMEK(mek, recoveryKey);
    // 归一化后的助记词必须派生出同一把 Key（找回流程用户输入不可控）
    const again = await deriveRecoveryKey(normalizeMnemonic(mnemonic));
    const unwrapped = await unwrapMEK(wrapped.payload, wrapped.iv, again);
    expect(await exportRawKey(unwrapped)).toEqual(await exportRawKey(mek));
  });

  it('不同助记词派生的 Key 解封失败', async () => {
    const recoveryKey = await deriveRecoveryKey(generateMnemonic12());
    const wrapped = await wrapMEK(await generateRandomMEK(), recoveryKey);
    const wrongKey = await deriveRecoveryKey(generateMnemonic12());
    await expect(unwrapMEK(wrapped.payload, wrapped.iv, wrongKey)).rejects.toThrow();
  });
});
