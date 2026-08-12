/**
 * @file stockService.test.ts
 * @description stockService 批量行情解析单测：验证腾讯多代码响应
 *              （v_sh600745="...";\nv_sz002594="...";）逐行解析、无效行跳过、
 *              载荷不足降级 null、空输入等边界。
 * @author 开发团队
 */

import { describe, expect, it } from 'vitest';
import { parseQuoteSummaryBatchPayload } from '../services/stockService';

/** 构造一条合法的腾讯行情行（补齐 47 个必要字段）。 */
function makeQuoteLine(fullCode: string, fields: Record<number, string | number>): string {
  const arr = Array.from({ length: 47 }, () => '');
  for (const [idx, value] of Object.entries(fields)) {
    arr[Number(idx)] = String(value);
  }
  return `v_${fullCode}="${arr.join('~')}"`;
}

const shWentai = makeQuoteLine('sh600745', {
  1: '*ST闻泰', 2: '600745', 3: '17.15', 4: '17.48', 5: '17.24', 6: '342523',
  30: '20260812161440', 31: '-0.33', 32: '-1.89', 33: '17.37', 34: '17.10',
  37: '58961', 38: '2.69', 39: '-2.38', 44: '218.47', 45: '218.47', 46: '0.93',
});

const szByd = makeQuoteLine('sz002594', {
  1: '比亚迪', 2: '002594', 3: '100.00', 4: '99.00', 5: '99.50', 6: '100000',
  30: '20260812161440', 31: '1.00', 32: '1.01',
});

describe('parseQuoteSummaryBatchPayload', () => {
  it('将多行批量响应解析为 fullCode → 行情摘要映射', () => {
    const raw = `${shWentai};\n${szByd};\n`;
    const result = parseQuoteSummaryBatchPayload(raw);

    expect(result['sh600745']?.fullCode).toBe('600745');
    expect(result['sh600745']?.stockName).toBe('*ST闻泰');
    expect(result['sh600745']?.currentPrice).toBe(17.15);
    expect(result['sh600745']?.changePercent).toBe(-1.89);
    expect(result['sh600745']?.updateTime).toBe('20260812161440');
    expect(result['sz002594']?.stockName).toBe('比亚迪');
    expect(result['sz002594']?.currentPrice).toBe(100);
    expect(result['sz002594']?.changePercent).toBe(1.01);
  });

  it('跳过非行情行（v_pv_none_match）与空行', () => {
    const raw = `v_pv_none_match="1";\n\n${szByd};\n`;
    const result = parseQuoteSummaryBatchPayload(raw);
    expect(result['pv_none_match']).toBeUndefined();
    expect(result['sz002594']?.stockName).toBe('比亚迪');
  });

  it('单个标的载荷字段不足时映射为 null 且不影响其余标的', () => {
    const raw = `v_sh600745="1~*ST闻泰";\n${szByd};\n`;
    const result = parseQuoteSummaryBatchPayload(raw);
    expect(result['sh600745']).toBeNull();
    expect(result['sz002594']?.currentPrice).toBe(100);
  });

  it('响应末尾带换行符时正常解析', () => {
    const raw = `${shWentai};\n`;
    const result = parseQuoteSummaryBatchPayload(raw);
    expect(result['sh600745']?.currentPrice).toBe(17.15);
  });

  it('空输入 / 全空白输入返回空映射', () => {
    expect(parseQuoteSummaryBatchPayload('')).toEqual({});
    expect(parseQuoteSummaryBatchPayload(';\n;')).toEqual({});
  });
});
