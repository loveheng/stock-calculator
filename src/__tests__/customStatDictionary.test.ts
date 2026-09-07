/**
 * @file customStatDictionary.test.ts
 * @description 自定义统计字段字典防腐测试：字典登记的每个字段必须真实存在于对应集合的
 *              样例行上（编译期 as const satisfies 已挡改名，此处防「字典与运行时形状漂移」），
 *              全量字典载荷分组完整非空。LLM 依据字典写代码，字段失真 = 生成代码必然空跑。
 * @layer 测试
 * @author 开发团队
 */

import { describe, expect, it } from 'vitest';
import {
  CONTEXT_EXTRA_DICTIONARY,
  POSITIONS_FIELD_DICTIONARY,
  ROUNDS_FIELD_DICTIONARY,
  STREAMS_FIELD_DICTIONARY,
  TXNS_FIELD_DICTIONARY,
  buildFieldDictionaryPayload,
} from '../utils/customStats/dictionary';
import { buildSampleFixtureCtx } from '../utils/customStats/fixtures';

/** 样例夹具逐字段存在性校验（以真实形状数据为基准） */
function expectAllFieldsExist(
  fields: readonly { field: string; desc: string }[],
  rows: readonly object[],
  label: string,
) {
  expect(rows.length).toBeGreaterThan(0);
  for (const { field } of fields) {
    const hit = rows.some((row) => field in row);
    if (!hit) {
      throw new Error(`字段字典防腐报警：${label}.${field} 未出现在任何样例行上（领域字段已改名/删除？）`);
    }
  }
}

describe('customStat 字段字典防腐（运行时层）', () => {
  const ctx = buildSampleFixtureCtx();

  it('rounds 字典字段全部存在于样例轮次', () => {
    expectAllFieldsExist(ROUNDS_FIELD_DICTIONARY, [...ctx.rounds, ...ctx.openRounds], 'rounds');
  });

  it('txns 字典字段全部存在于样例流水', () => {
    expectAllFieldsExist(TXNS_FIELD_DICTIONARY, ctx.txns, 'txns');
  });

  it('positions 字典字段全部存在于样例持仓', () => {
    expectAllFieldsExist(POSITIONS_FIELD_DICTIONARY, ctx.positions, 'positions');
  });

  it('activeStreams 字典字段全部存在于样例撮合结果', () => {
    expectAllFieldsExist(STREAMS_FIELD_DICTIONARY, ctx.activeStreams, 'activeStreams');
  });

  it('context 级字段说明覆盖 now/feeConfig/helpers', () => {
    const fields = CONTEXT_EXTRA_DICTIONARY.map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['now', 'feeConfig', 'helpers']));
  });

  it('全量字典载荷五组齐全且非空', () => {
    const payload = buildFieldDictionaryPayload();
    for (const group of ['rounds', 'txns', 'positions', 'activeStreams', 'context']) {
      expect(payload[group]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('每条字段说明非空（口径可读性下限）', () => {
    for (const group of Object.values(buildFieldDictionaryPayload())) {
      for (const doc of group) {
        expect(doc.desc.trim().length).toBeGreaterThan(0);
        expect(doc.field.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
