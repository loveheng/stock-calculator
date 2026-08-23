/**
 * @file importAdapter.test.ts
 * @description 单元测试：批量导入适配器（格式归一化、智能关联、防重批处理）
 * @layer Test
 * @storage_impact 纯函数测试，不读写任何存储。Mock store 数据直接传入。
 */

import { describe, test, expect } from 'vitest';
import {
  parseClipboardText,
  parseOcrPayload,
  enrichDraftRow,
  completeDedupCheck,
  buildHistoryFromStore,
  inferPlanBind,
  groupRowsByStock,
  toFullCode,
  getAvailablePositions,
  getActivePlannedOrders,
} from '../services/importAdapter';
import type { ImportDraftRow } from '../types/import';
import type { Position, PlannedOrder } from '../store/types';

// ============================================================
// toFullCode
// ============================================================
describe('toFullCode', () => {
  test('已有前缀保持不变', () => {
    expect(toFullCode('sh600519')).toBe('sh600519');
    expect(toFullCode('SZ000001')).toBe('sz000001');
    expect(toFullCode('bj688001')).toBe('bj688001');
  });
  test('6 开头 → sh', () => {
    expect(toFullCode('600519')).toBe('sh600519');
    expect(toFullCode('688001')).toBe('sh688001');
  });
  test('4/8 开头 → bj', () => {
    expect(toFullCode('430001')).toBe('bj430001');
    expect(toFullCode('830001')).toBe('bj830001');
  });
  test('其他 6 位数字 → sz', () => {
    expect(toFullCode('000001')).toBe('sz000001');
    expect(toFullCode('300750')).toBe('sz300750');
  });
  test('非 6 位数字原样返回', () => {
    expect(toFullCode('12345')).toBe('12345');
    expect(toFullCode('')).toBe('');
  });
});

// ============================================================
// parseClipboardText
// ============================================================
describe('parseClipboardText', () => {
  test('解析完整格式：日期+时间+代码+名称+方向+价格+数量', () => {
    const result = parseClipboardText('2026-08-23 10:31\t600519\t贵州茅台\t买入\t1680.00\t100');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ fullCode: '600519', stockName: '贵州茅台', direction: 'buy', price: 1680, amount: 100 });
  });
  test('解析简写格式：代码+方向+价格+数量', () => {
    const result = parseClipboardText('600519\t买\t1680\t100');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ fullCode: '600519', direction: 'buy', price: 1680, amount: 100 });
  });
  test('解析卖出方向', () => {
    const result = parseClipboardText('000001\t卖出\t12.50\t200');
    expect(result[0]).toMatchObject({ direction: 'sell' });
  });
  test('多行解析', () => {
    const text = '600519\t买入\t1680\t100\n000001\t卖出\t12.5\t200';
    const result = parseClipboardText(text);
    expect(result).toHaveLength(2);
  });
  test('无效行自动跳过', () => {
    const text = '600519\t买入\t1680\t100\nnot a valid line\n000001\t卖出\t12.5\t200';
    const result = parseClipboardText(text);
    expect(result).toHaveLength(2);
  });
  test('空格分隔替代制表符', () => {
    const result = parseClipboardText('600519 买入 1680 100');
    expect(result).toHaveLength(1);
  });
  test('空字符串返回空数组', () => {
    expect(parseClipboardText('')).toHaveLength(0);
    expect(parseClipboardText('  \n  ')).toHaveLength(0);
  });
  test('字段不足的行跳过', () => {
    expect(parseClipboardText('600519\t买入')).toHaveLength(0);
  });
  test('日期格式兼容 YYYY/MM/DD', () => {
    const result = parseClipboardText('2026/08/23\t600519\t买入\t1680\t100');
    expect(result[0].timestamp).toMatch(/^2026\/08\/23/);
  });
});

// ============================================================
// parseOcrPayload
// ============================================================
describe('parseOcrPayload', () => {
  test('解析 { items: [...] } 包装格式', () => {
    const payload = {
      items: [
        { stockCode: '600519', tradeTime: '2026-08-23 10:31:05', direction: '买入', price: 1680.00, amount: 100 },
        { stockCode: '000001', tradeTime: '2026-08-23 09:25:00', direction: '卖出', price: 12.50, amount: 200 },
      ],
    };
    const result = parseOcrPayload(payload);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ fullCode: 'sh600519', direction: 'buy', price: 1680, amount: 100 });
    expect(result[1]).toMatchObject({ fullCode: 'sz000001', direction: 'sell', price: 12.5, amount: 200 });
  });
  test('解析裸数组格式', () => {
    const payload = [{ fullCode: '600519', direction: 'buy', price: 100, amount: 100 }];
    const result = parseOcrPayload(payload);
    expect(result).toHaveLength(1);
  });
  test('解析中文字段名', () => {
    const payload = [{ '证券代码': '600519', '成交价格': 100, '成交数量': 100, '交易方向': '买入' }];
    const result = parseOcrPayload(payload);
    expect(result[0]).toMatchObject({ fullCode: 'sh600519', direction: 'buy', price: 100, amount: 100 });
  });
  test('无效行自动跳过', () => {
    const payload = [{ stockCode: '600519', price: 100, amount: 100 }]; // 缺少 direction
    const result = parseOcrPayload(payload);
    expect(result).toHaveLength(0);
  });
  test('非数组/空输入返回空数组', () => {
    expect(parseOcrPayload(null)).toHaveLength(0);
    expect(parseOcrPayload({})).toHaveLength(0);
    expect(parseOcrPayload({ items: [] })).toHaveLength(0);
  });
  test('价格自动补市场前缀', () => {
    const result = parseOcrPayload([{ stockCode: '688001', direction: '买入', price: 100, amount: 100 }]);
    expect(result[0].fullCode).toBe('sh688001');
  });
});

// ============================================================
// inferPlanBind
// ============================================================
describe('inferPlanBind', () => {
  const plans: PlannedOrder[] = [
    { id: 'p1', fullCode: 'sh600519', direction: 'buy', plannedPrice: 100, plannedAmount: 100, status: 'active', createdAt: 0, targetPosition: 'pos1' },
    { id: 'p2', fullCode: 'sz000001', direction: 'sell', plannedPrice: 50, plannedAmount: 200, status: 'active', createdAt: 0, targetPosition: 'pos2' },
    { id: 'p3', fullCode: 'sh600519', direction: 'buy', plannedPrice: 100, plannedAmount: 100, status: 'executed', createdAt: 0, targetPosition: 'pos1' }, // 已执行
  ] as PlannedOrder[];

  test('方向一致且价格在容差内 → 匹配', () => {
    const result = inferPlanBind({ fullCode: 'sh600519', direction: 'buy', price: 102, amount: 100 }, plans);
    expect(result?.id).toBe('p1');
  });
  test('方向不一致 → 不匹配', () => {
    const result = inferPlanBind({ fullCode: 'sh600519', direction: 'sell', price: 100, amount: 100 }, plans);
    expect(result).toBeUndefined();
  });
  test('已执行计划单不匹配', () => {
    const result = inferPlanBind({ fullCode: 'sh600519', direction: 'buy', price: 100, amount: 100 }, plans);
    expect(result?.id).toBe('p1'); // p3 是 executed，不匹配
  });
  test('价格超出容差 → 不匹配', () => {
    const result = inferPlanBind({ fullCode: 'sh600519', direction: 'buy', price: 200, amount: 100 }, plans);
    expect(result).toBeUndefined();
  });
  test('数量容差允许 ±1 股', () => {
    const result = inferPlanBind({ fullCode: 'sh600519', direction: 'buy', price: 100, amount: 101 }, plans);
    expect(result?.id).toBe('p1');
  });
  test('数量超出容差 → 不匹配', () => {
    const result = inferPlanBind({ fullCode: 'sh600519', direction: 'buy', price: 100, amount: 500 }, plans);
    expect(result).toBeUndefined();
  });
  test('自定义容差参数', () => {
    const result = inferPlanBind(
      { fullCode: 'sz000001', direction: 'sell', price: 55, amount: 200 },
      plans,
      { priceTolerance: 0.1, qtyTolerance: 0 },
    );
    expect(result?.id).toBe('p2');
  });
  test('无匹配计划单返回 undefined', () => {
    const result = inferPlanBind({ fullCode: '300750', direction: 'buy', price: 100, amount: 100 }, plans);
    expect(result).toBeUndefined();
  });
});

// ============================================================
// groupRowsByStock
// ============================================================
describe('groupRowsByStock', () => {
  const rows: ImportDraftRow[] = [
    { id: '1', fingerprint: 'f1', fullCode: 'sh600519', stockName: '贵州茅台', direction: 'buy', price: 100, amount: 100, timestamp: 100, targetCategory: 'LONG_TERM_BATCH', duplicateStatus: 'UNIQUE', skipImport: false, validationStatus: 'PENDING' },
    { id: '2', fingerprint: 'f2', fullCode: 'sz000001', stockName: '平安银行', direction: 'buy', price: 10, amount: 200, timestamp: 100, targetCategory: 'SHORT_TERM_T', duplicateStatus: 'UNIQUE', skipImport: false, validationStatus: 'PENDING' },
    { id: '3', fingerprint: 'f3', fullCode: 'sh600519', stockName: '贵州茅台', direction: 'sell', price: 105, amount: 50, timestamp: 100, targetCategory: 'SHORT_TERM_T', duplicateStatus: 'UNIQUE', skipImport: false, validationStatus: 'PENDING' },
  ] as ImportDraftRow[];

  test('按代码分组', () => {
    const groups = groupRowsByStock(rows);
    expect(groups).toHaveLength(2);
    const g1 = groups.find((g) => g.key === '600519');
    const g2 = groups.find((g) => g.key === '000001');
    expect(g1?.items).toHaveLength(2);
    expect(g2?.items).toHaveLength(1);
  });
  test('空数组返回空数组', () => {
    expect(groupRowsByStock([])).toHaveLength(0);
  });
  test('无代码行归入 __unassigned__', () => {
    const badRow = { ...rows[0], fullCode: '' };
    const groups = groupRowsByStock([badRow]);
    expect(groups[0].key).toBe('__unassigned__');
  });
});

// ============================================================
// enrichDraftRow
// ============================================================
describe('enrichDraftRow', () => {
  const positions: Position[] = [
    { id: 'pos1', fullCode: 'sh600519', stockName: '贵州茅台', currentCost: 100, currentAmount: 200, isClosed: false, createdAt: 0, realizedPnL: 0, batches: [], tRounds: 0 },
    { id: 'pos2', fullCode: 'sz000001', stockName: '平安银行', currentCost: 10, currentAmount: 1000, isClosed: true, createdAt: 0, realizedPnL: 0, batches: [], tRounds: 0 }, // 已结仓
  ] as Position[];

  const plannedOrders: PlannedOrder[] = [
    { id: 'p1', fullCode: 'sh600519', direction: 'buy', plannedPrice: 100, plannedAmount: 100, status: 'active', createdAt: 0, targetPosition: 'pos1' },
  ] as PlannedOrder[];

  test('有持仓 → 默认归类 SHORT_TERM_T', () => {
    const row = enrichDraftRow(
      { fullCode: 'sh600519', direction: 'buy', price: 102, amount: 100 },
      positions,
      [],
    );
    expect(row.targetCategory).toBe('SHORT_TERM_T');
    expect(row.targetPositionId).toBe('pos1');
    expect(row.isNewPosition).toBeFalsy();
  });
  test('无持仓 → 默认归类 LONG_TERM_BATCH', () => {
    const row = enrichDraftRow(
      { fullCode: '300750', direction: 'buy', price: 100, amount: 100 },
      positions,
      [],
    );
    expect(row.targetCategory).toBe('LONG_TERM_BATCH');
    expect(row.isNewPosition).toBe(true);
  });
  test('已结仓视为无持仓', () => {
    const row = enrichDraftRow(
      { fullCode: 'sz000001', direction: 'buy', price: 10, amount: 100 },
      positions,
      [],
    );
    expect(row.targetCategory).toBe('LONG_TERM_BATCH');
    expect(row.targetPositionId).toBeUndefined();
  });
  test('有活跃计划单且价格匹配 → 自动 BIND_PLANNED_ORDER', () => {
    const row = enrichDraftRow(
      { fullCode: 'sh600519', direction: 'buy', price: 102, amount: 100 },
      positions,
      plannedOrders,
    );
    expect(row.targetCategory).toBe('BIND_PLANNED_ORDER');
    expect(row.targetPlannedOrderId).toBe('p1');
  });
  test('保留用户已指定的归类', () => {
    const row = enrichDraftRow(
      { fullCode: 'sh600519', direction: 'buy', price: 102, amount: 100, targetCategory: 'LONG_TERM_BATCH' as any },
      positions,
      plannedOrders,
    );
    expect(row.targetCategory).toBe('LONG_TERM_BATCH');
  });
  test('生成指纹', () => {
    const row = enrichDraftRow(
      { fullCode: 'sh600519', direction: 'buy', price: 102, amount: 100, timestamp: '2026-08-23' },
      positions,
      [],
    );
    expect(row.fingerprint).toMatch(/^600519_buy_/);
    expect(row.fingerprint).toContain('20260823');
  });
});

// ============================================================
// completeDedupCheck
// ============================================================
describe('completeDedupCheck', () => {
  const history = [
    { id: 'h1', dk: '20260823', normalizedCode: '600519', direction: 'buy', price: 100, amount: 100 },
  ];

  test('第一道防线：表内相同指纹 → EXACT_DUPLICATE', () => {
    const rows: ImportDraftRow[] = [
      { id: 'a', fingerprint: '600519_buy_100.000_100_20260823', fullCode: 'sh600519', direction: 'buy', price: 100, amount: 100, timestamp: 100, targetCategory: 'LONG_TERM_BATCH', duplicateStatus: 'UNIQUE', skipImport: false, validationStatus: 'PENDING' },
      { id: 'b', fingerprint: '600519_buy_100.000_100_20260823', fullCode: 'sh600519', direction: 'buy', price: 100, amount: 100, timestamp: 100, targetCategory: 'LONG_TERM_BATCH', duplicateStatus: 'UNIQUE', skipImport: false, validationStatus: 'PENDING' },
    ] as ImportDraftRow[];
    const result = completeDedupCheck(rows, []);
    expect(result[0].duplicateStatus).toBe('UNIQUE');
    expect(result[0].skipImport).toBe(false);
    expect(result[1].duplicateStatus).toBe('EXACT_DUPLICATE');
    expect(result[1].skipImport).toBe(true);
  });
  const ts20260823 = new Date('2026-08-23').getTime();

  test('第二道防线：与历史库匹配 → EXACT_DUPLICATE', () => {
    const rows: ImportDraftRow[] = [
      { id: 'a', fingerprint: '600519_buy_100.000_100_20260823', fullCode: 'sh600519', direction: 'buy', price: 100, amount: 100, timestamp: ts20260823, targetCategory: 'LONG_TERM_BATCH', duplicateStatus: 'UNIQUE', skipImport: false, validationStatus: 'PENDING' },
    ] as ImportDraftRow[];
    const result = completeDedupCheck(rows, history);
    expect(result[0].duplicateStatus).toBe('EXACT_DUPLICATE');
    expect(result[0].skipImport).toBe(true);
  });
  test('历史库无匹配 → POTENTIAL', () => {
    const rows: ImportDraftRow[] = [
      { id: 'a', fingerprint: '600519_buy_200.000_100_20260823', fullCode: 'sh600519', direction: 'buy', price: 200, amount: 100, timestamp: ts20260823, targetCategory: 'LONG_TERM_BATCH', duplicateStatus: 'UNIQUE', skipImport: false, validationStatus: 'PENDING' },
    ] as ImportDraftRow[];
    const result = completeDedupCheck(rows, history);
    expect(result[0].duplicateStatus).toBe('POTENTIAL');
  });
});

// ============================================================
// buildHistoryFromStore
// ============================================================
describe('buildHistoryFromStore', () => {
  test('从 Position 的 batches 构建历史', () => {
    const positions = [
      { id: 'pos1', fullCode: 'sh600519', isClosed: false, batches: [{ id: 'b1', type: 'add', price: 100, amount: 100, timestamp: '2026-08-23', costAfter: 0, amountAfter: 0, fee: 0 }] },
    ] as Position[];
    const result = buildHistoryFromStore(positions, []);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'b1', dk: '20260823', normalizedCode: '600519', direction: 'buy', price: 100, amount: 100 });
  });
  test('从 longTermRecords 构建历史', () => {
    const records = [{ id: 'r1', fullCode: 'sz000001', type: 'sell', price: 10, amount: 200, timestamp: '2026-08-22' }];
    const result = buildHistoryFromStore([], records);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ normalizedCode: '000001', direction: 'sell' });
  });
  test('无数据返回空数组', () => {
    expect(buildHistoryFromStore([], [])).toHaveLength(0);
  });
});

// ============================================================
// getAvailablePositions / getActivePlannedOrders
// ============================================================
describe('getAvailablePositions', () => {
  const positions = [
    { id: 'p1', fullCode: 'sh600519', stockName: '贵州茅台', isClosed: false, currentCost: 100, currentAmount: 200, createdAt: 0, realizedPnL: 0, batches: [], tRounds: 0 },
    { id: 'p2', fullCode: 'sh600519', stockName: '贵州茅台', isClosed: true, currentCost: 100, currentAmount: 0, createdAt: 0, realizedPnL: 0, batches: [], tRounds: 0 },
  ] as Position[];

  test('返回未结仓的持仓', () => {
    const result = getAvailablePositions(positions, 'sh600519');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p1');
  });
  test('排除已结仓', () => {
    const result = getAvailablePositions(positions, 'sh600519');
    expect(result.every((p) => !p.isClosed)).toBe(true);
  });
  test('无匹配返回空数组', () => {
    expect(getAvailablePositions(positions, '300750')).toHaveLength(0);
  });
});

describe('getActivePlannedOrders', () => {
  const plans = [
    { id: 'p1', fullCode: 'sh600519', status: 'active', direction: 'buy', plannedPrice: 100, plannedAmount: 100, createdAt: 0, targetPosition: 'pos1' },
    { id: 'p2', fullCode: 'sh600519', status: 'executed', direction: 'buy', plannedPrice: 100, plannedAmount: 100, createdAt: 0, targetPosition: 'pos1' },
  ] as PlannedOrder[];

  test('返回活跃计划单', () => {
    const result = getActivePlannedOrders(plans, 'sh600519');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p1');
  });
  test('排除已执行计划单', () => {
    const result = getActivePlannedOrders(plans, 'sh600519');
    expect(result.some((p) => p.status !== 'active')).toBe(false);
  });
  test('无匹配返回空数组', () => {
    expect(getActivePlannedOrders(plans, '000001')).toHaveLength(0);
  });
});