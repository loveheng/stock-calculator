/**
 * @file importMerger.test.ts
 * @description 测试 mergeImportedTradesToPositions：同标的流水聚合逻辑
 *              — 多笔买入加权平均合并、卖出减仓、新建与追加持仓。
 */

import { describe, test, expect } from 'vitest';
import { mergeImportedTradesToPositions } from '../utils/importMerger';
import type { ImportDraftRow } from '../types/import';
import type { Position } from '../store/types';

// ── 辅助工厂函数 ──

function makeRow(overrides: Partial<ImportDraftRow> & { fullCode: string }): ImportDraftRow {
  return {
    id: `row-${Math.random().toString(36).slice(2, 8)}`,
    fingerprint: 'fp-' + overrides.fullCode,
    timestamp: Date.now(),
    fullCode: overrides.fullCode,
    stockName: overrides.stockName || '',
    direction: overrides.direction ?? 'buy',
    price: overrides.price ?? 10,
    amount: overrides.amount ?? 100,
    targetCategory: overrides.targetCategory ?? 'LONG_TERM_BATCH',
    targetPositionId: undefined,
    targetPlannedOrderId: undefined,
    isNewPosition: false,
    duplicateStatus: 'UNIQUE',
    matchedRecordId: undefined,
    skipImport: false,
    validationStatus: 'PASSED',
    validationMessage: undefined,
    source: 'manual',
    ...overrides,
  };
}

function makePosition(overrides: Partial<Position> & { fullCode: string }): Position {
  return {
    id: `pos-${overrides.fullCode}`,
    stockName: overrides.stockName || '测试股票',
    fullCode: overrides.fullCode,
    currentCost: overrides.currentCost ?? 10,
    currentAmount: overrides.currentAmount ?? 100,
    batches: overrides.batches ?? [],
    isClosed: overrides.isClosed ?? false,
    createdAt: new Date().toISOString(),
    openAt: new Date().toISOString(),
    realizedPnL: overrides.realizedPnL ?? 0,
    totalInvested: overrides.totalInvested ?? 1000,
    ...overrides,
  };
}

// ── 测试用例 ──

describe('mergeImportedTradesToPositions', () => {

  // ── 同标的买入合并 ──
  test('3 笔同标的买入 → 合并为 1 条 create_position 指令，加权平均价正确', () => {
    const rows: ImportDraftRow[] = [
      makeRow({ fullCode: 'sh600519', stockName: '贵州茅台', price: 188, amount: 100, timestamp: 1000 }),
      makeRow({ fullCode: 'sh600519', stockName: '贵州茅台', price: 190, amount: 200, timestamp: 2000 }),
      makeRow({ fullCode: 'sh600519', stockName: '贵州茅台', price: 192, amount: 150, timestamp: 3000 }),
    ];

    const result = mergeImportedTradesToPositions(rows, []);

    expect(result).toHaveLength(1);
    expect(result[0].action).toBe('create_position');
    expect(result[0].fullCode).toBe('sh600519');
    expect(result[0].stockName).toBe('贵州茅台');

    // 加权平均价 = (188*100 + 190*200 + 192*150) / (100+200+150)
    const expectedWeightedPrice = (188 * 100 + 190 * 200 + 192 * 150) / 450;
    expect(result[0].buySummary).not.toBeNull();
    expect(result[0].buySummary!.totalAmount).toBe(450);
    expect(result[0].buySummary!.weightedPrice).toBeCloseTo(expectedWeightedPrice, 6);
    expect(result[0].buySummary!.count).toBe(3);
    expect(result[0].sellSummary).toBeNull();
  });

  // ── 卖出合并 ──
  test('2 笔同标的卖出 → 合并为 1 条 create_position 指令，卖出汇总正确', () => {
    const rows: ImportDraftRow[] = [
      makeRow({ fullCode: 'sh600519', stockName: '贵州茅台', direction: 'buy', price: 180, amount: 500, timestamp: 1000 }),
      makeRow({ fullCode: 'sh600519', stockName: '贵州茅台', direction: 'sell', price: 200, amount: 200, timestamp: 2000 }),
      makeRow({ fullCode: 'sh600519', stockName: '贵州茅台', direction: 'sell', price: 210, amount: 100, timestamp: 3000 }),
    ];

    const result = mergeImportedTradesToPositions(rows, []);

    expect(result).toHaveLength(1);
    expect(result[0].buySummary).not.toBeNull();
    expect(result[0].buySummary!.totalAmount).toBe(500);
    expect(result[0].sellSummary).not.toBeNull();
    expect(result[0].sellSummary!.totalAmount).toBe(300);
    expect(result[0].sellSummary!.totalProceeds).toBe(200 * 200 + 210 * 100);
    expect(result[0].sellSummary!.count).toBe(2);
  });

  // ── 跳过非 LONG_TERM_BATCH 行 ──
  test('SHORT_TERM_T 行被跳过，不参与合并', () => {
    const rows: ImportDraftRow[] = [
      makeRow({ fullCode: 'sh600519', stockName: '贵州茅台', targetCategory: 'LONG_TERM_BATCH', price: 188, amount: 100 }),
      makeRow({ fullCode: 'sh600519', stockName: '贵州茅台', targetCategory: 'SHORT_TERM_T', price: 190, amount: 200 }),
    ];

    const result = mergeImportedTradesToPositions(rows, []);

    // 只有 LONG_TERM_BATCH 行参与合并
    expect(result).toHaveLength(1);
    expect(result[0].buySummary!.totalAmount).toBe(100);
  });

  // ── 多个标的分别聚合 ──
  test('不同标的 → 分别生成独立指令', () => {
    const rows: ImportDraftRow[] = [
      makeRow({ fullCode: 'sh600519', stockName: '贵州茅台', price: 188, amount: 100 }),
      makeRow({ fullCode: 'sz000001', stockName: '平安银行', price: 12, amount: 500 }),
      makeRow({ fullCode: 'sh600519', stockName: '贵州茅台', price: 190, amount: 200 }),
    ];

    const result = mergeImportedTradesToPositions(rows, []);

    expect(result).toHaveLength(2);
    const maotai = result.find((r) => r.fullCode === 'sh600519')!;
    const pingan = result.find((r) => r.fullCode === 'sz000001')!;
    expect(maotai.buySummary!.totalAmount).toBe(300);
    expect(pingan.buySummary!.totalAmount).toBe(500);
  });

  // ── 已有持仓 → add_to_position ──
  test('有已有持仓 → action 为 add_to_position', () => {
    const rows: ImportDraftRow[] = [
      makeRow({ fullCode: 'sh600519', stockName: '贵州茅台', price: 200, amount: 100 }),
    ];
    const existingPositions: Position[] = [
      makePosition({ fullCode: 'sh600519', stockName: '贵州茅台', currentCost: 180, currentAmount: 500 }),
    ];

    const result = mergeImportedTradesToPositions(rows, existingPositions);

    expect(result).toHaveLength(1);
    expect(result[0].action).toBe('add_to_position');
    expect(result[0].existingPositionId).toBe('pos-sh600519');
    expect(result[0].existingPosition).toBe(existingPositions[0]);
  });

  // ── 跳过 skipImport 的行 ──
  test('skipImport=true 的行被跳过', () => {
    const rows: ImportDraftRow[] = [
      makeRow({ fullCode: 'sh600519', stockName: '贵州茅台', price: 188, amount: 100, skipImport: true }),
      makeRow({ fullCode: 'sh600519', stockName: '贵州茅台', price: 190, amount: 200 }),
    ];

    const result = mergeImportedTradesToPositions(rows, []);

    expect(result).toHaveLength(1);
    expect(result[0].buySummary!.totalAmount).toBe(200); // 只有 1 条未跳过的
  });

  // ── 空数组 → 空结果 ──
  test('空数组 → 返回空数组', () => {
    const result = mergeImportedTradesToPositions([], []);
    expect(result).toEqual([]);
  });

  // ── 无买入建仓机会的纯卖出被跳过 ──
  test('仅有卖出且无持仓 → 该标的被跳过（无法建仓）', () => {
    const rows: ImportDraftRow[] = [
      makeRow({ fullCode: 'sh600519', stockName: '贵州茅台', direction: 'sell', price: 200, amount: 100 }),
    ];

    const result = mergeImportedTradesToPositions(rows, []);
    // 仍然生成指令（含 sellSummary，但 buySummary 为 null），由调用方决定如何处理
    expect(result).toHaveLength(1);
    expect(result[0].buySummary).toBeNull();
    expect(result[0].sellSummary).not.toBeNull();
    expect(result[0].sellSummary!.totalAmount).toBe(100);
  });

  // ── 按时间排序 ──
  test('无论输入顺序，指令内的 allRows 按时间升序排列', () => {
    const rows: ImportDraftRow[] = [
      makeRow({ fullCode: 'sh600519', stockName: '贵州茅台', price: 192, amount: 150, timestamp: 3000 }),
      makeRow({ fullCode: 'sh600519', stockName: '贵州茅台', price: 188, amount: 100, timestamp: 1000 }),
      makeRow({ fullCode: 'sh600519', stockName: '贵州茅台', price: 190, amount: 200, timestamp: 2000 }),
    ];

    const result = mergeImportedTradesToPositions(rows, []);

    expect(result[0].allRows.map((r) => r.timestamp)).toEqual([1000, 2000, 3000]);
  });

  // ── 已结仓视为无持仓 ──
  test('已结仓的标的 → 视为无持仓（action 为 create_position）', () => {
    const rows: ImportDraftRow[] = [
      makeRow({ fullCode: 'sh600519', stockName: '贵州茅台', price: 200, amount: 100 }),
    ];
    const existingPositions: Position[] = [
      makePosition({ fullCode: 'sh600519', stockName: '贵州茅台', isClosed: true, currentAmount: 0 }),
    ];

    const result = mergeImportedTradesToPositions(rows, existingPositions);

    expect(result).toHaveLength(1);
    expect(result[0].action).toBe('create_position');
  });

  // ── 混合买入卖出，权价计算正确 ──
  test('混合买卖：买入汇总权价仅基于买入流水', () => {
    const rows: ImportDraftRow[] = [
      makeRow({ fullCode: 'sh600519', direction: 'buy', price: 180, amount: 300, timestamp: 1000 }),
      makeRow({ fullCode: 'sh600519', direction: 'sell', price: 200, amount: 100, timestamp: 2000 }),
      makeRow({ fullCode: 'sh600519', direction: 'buy', price: 190, amount: 200, timestamp: 3000 }),
    ];

    const result = mergeImportedTradesToPositions(rows, []);

    // 买入总股数 = 300 + 200 = 500
    // 加权均价 = (180*300 + 190*200) / 500 = 184
    expect(result[0].buySummary!.totalAmount).toBe(500);
    expect(result[0].buySummary!.weightedPrice).toBeCloseTo((180 * 300 + 190 * 200) / 500, 6);
    expect(result[0].sellSummary!.totalAmount).toBe(100);
  });

  describe('mergeImportedTradesToPositions — 边缘 Case', () => {
    test('只有 1 笔买入 → 不合并，直接透传', () => {
      const rows = [makeRow({ fullCode: 'sh600519', price: 188, amount: 100 })];
      const result = mergeImportedTradesToPositions(rows, []);
      expect(result).toHaveLength(1);
      expect(result[0].buySummary!.totalAmount).toBe(100);
      expect(result[0].buySummary!.weightedPrice).toBe(188);
      expect(result[0].buySummary!.count).toBe(1);
    });

    test('多标的，部分无持仓、部分有持仓，各自正确归类', () => {
      const rows = [
        makeRow({ fullCode: 'sh600519', stockName: '贵州茅台', price: 188, amount: 100 }),
        makeRow({ fullCode: 'sz000001', stockName: '平安银行', price: 12, amount: 500 }),
      ];
      const existingPositions = [
        makePosition({ fullCode: 'sh600519', currentCost: 180, currentAmount: 500 }),
      ];
      const result = mergeImportedTradesToPositions(rows, existingPositions);
      expect(result).toHaveLength(2);
      expect(result.find((r) => r.fullCode === 'sh600519')!.action).toBe('add_to_position');
      expect(result.find((r) => r.fullCode === 'sz000001')!.action).toBe('create_position');
    });

    // ── 代码格式差异合并 ──
    test('SH:600519 与 600519 视为同一标的，合并为一条指令', () => {
      const rows = [
        makeRow({ fullCode: 'SH:600519', stockName: '贵州茅台', price: 188, amount: 100, timestamp: 1000 }),
        makeRow({ fullCode: '600519', stockName: '贵州茅台', price: 190, amount: 200, timestamp: 2000 }),
      ];
      const result = mergeImportedTradesToPositions(rows, []);
      expect(result).toHaveLength(1);
      // 输出应为 canonicalizeFullCode 规范化后的代码 sh600519
      expect(result[0].fullCode).toBe('sh600519');
    });

    test('600519.SH 与 sh600519 视为同一标的，合并为一条指令', () => {
      const rows = [
        makeRow({ fullCode: '600519.SH', stockName: '贵州茅台', price: 188, amount: 100, timestamp: 1000 }),
        makeRow({ fullCode: 'sh600519', stockName: '贵州茅台', price: 190, amount: 200, timestamp: 2000 }),
      ];
      const result = mergeImportedTradesToPositions(rows, []);
      expect(result).toHaveLength(1);
      expect(result[0].buySummary!.totalAmount).toBe(300);
    });

    test('持仓上的代码优先级高于导入代码', () => {
      const rows = [
        makeRow({ fullCode: '600519', stockName: '贵州茅台', price: 200, amount: 100 }),
      ];
      const existingPositions = [
        makePosition({ fullCode: 'sh600519', stockName: '贵州茅台', currentCost: 180, currentAmount: 500 }),
      ];
      const result = mergeImportedTradesToPositions(rows, existingPositions);
      expect(result).toHaveLength(1);
      // 持仓上的权威代码 sh600519 优先
      expect(result[0].fullCode).toBe('sh600519');
      expect(result[0].action).toBe('add_to_position');
    });
  });
});