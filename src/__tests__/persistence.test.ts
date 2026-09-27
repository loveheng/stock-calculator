/**
 * @file persistence.test.ts
 * @description 持久化军械用例：safePersist 的首载闸门与失败重试行为。
 * @layer Tests
 * @author 骨架模板
 */

import { describe, expect, it, vi } from 'vitest';
import { isInitialLoadDone, markInitialLoadDone, safePersist } from '../utils/persistence';

describe('safePersist（持久化闸门）', () => {
  it('首载完成前不写库（防止半载数据落库覆盖正确值）', async () => {
    if (isInitialLoadDone()) return; // 同进程内已打开闸门则跳过
    const write = vi.fn(async () => {});
    await safePersist(write);
    expect(write).not.toHaveBeenCalled();
  });

  it('闸门打开后执行写入，并在失败时按退避重试', async () => {
    markInitialLoadDone();
    const ok = vi.fn(async () => {});
    await safePersist(ok);
    expect(ok).toHaveBeenCalledTimes(1);

    let calls = 0;
    const flaky = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
    });
    await safePersist(flaky);
    expect(calls).toBe(2);
  });
});
