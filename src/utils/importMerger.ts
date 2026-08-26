/**
 * @file importMerger.ts
 * @description 批量导入【中长期交易】同标的聚合工具：解决截图/CSV 导入时同标的
 *              多笔流水被错误拆分为多个独立仓位的 Bug。
 *
 *              核心逻辑：
 *              1. 以 stock_code (fullCode) 为 Key 对所有 LONG_TERM_BATCH 流水进行分组
 *              2. 多笔买入 → 加权平均成本价合并为一条「加仓」指令
 *              3. 卖出 → 对合并后的持仓执行扣减（减仓）
 *              4. 确保同一标的在导入时只创建一个持仓（或追加到已有持仓）
 *
 * @layer Utility
 * @author 开发团队
 */

import type { ImportDraftRow } from '../types/import';
import type { Position } from '../store/types';
import { normalizeCode, canonicalizeFullCode } from './dedup';

// ──────────────────────────────────────────────
// 1. 类型定义
// ──────────────────────────────────────────────

/** 买入汇总 */
export interface BuySummary {
  totalAmount: number;       // 总买入股数
  totalCost: number;         // 总买入金额（price × amount，不含费用）
  weightedPrice: number;     // 加权平均买入价
  count: number;             // 合并了多少笔买入
}

/** 卖出汇总 */
export interface SellSummary {
  totalAmount: number;       // 总卖出股数
  totalProceeds: number;     // 总卖出金额（price × amount，不含费用）
  count: number;             // 合并了多少笔卖出
}

/**
 * 合并后的导入指令：同标的的多笔流水聚合为一条指令，
 * 用于指导「创建持仓」或「追加到已有持仓」。
 */
export interface MergedImportInstruction {
  /** 完整证券代码（含市场前缀） */
  fullCode: string;
  /** 证券名称 */
  stockName: string;
  /** 操作类型：新建持仓 / 追加到已有持仓 */
  action: 'create_position' | 'add_to_position';
  /** 已有持仓 ID（仅 add_to_position 时有值） */
  existingPositionId?: string;
  /** 已有持仓对象（仅 add_to_position 时有值，用于计算快照） */
  existingPosition?: Position;
  /** 按时间排序的所有原始行（保留用于审计与 UI 追溯） */
  allRows: ImportDraftRow[];

  /** 买入汇总（加权平均） */
  buySummary: BuySummary | null;
  /** 卖出汇总 */
  sellSummary: SellSummary | null;
}

// ──────────────────────────────────────────────
// 2. 聚合函数
// ──────────────────────────────────────────────

/**
 * 将导入流水按 stock_code 聚合，合并同标的的买入/卖出操作。
 *
 * 核心逻辑：
 * 1. 筛选出 LONG_TERM_BATCH / NEW_POSITION 类别的行
 * 2. 按 fullCode 分组
 * 3. 每组内按时间排序
 * 4. 汇总买入（加权平均价）和卖出
 * 5. 检查是否存在已有持仓（未结仓）
 * 6. 返回合并后的指令，每个标的唯一一条
 *
 * 生命周期插入点：在 `handleCommitRows` 中调用，位于正式过账之前。
 * 这确保了在调用 addPosition / addBatch 之前，所有同标的流水已被合并，
 * 不会出现同一个标的对应多个独立仓位的情况。
 *
 * @param rows              导入暂存行（ImportDraftRow[]）
 * @param existingPositions 系统已有持仓列表
 * @returns 合并后的导入指令列表，每个标的唯一一条指令
 *
 * @example
 * // 3 笔买入 *ST闻泰，1 笔卖出 → 合并为 1 条指令
 * const instructions = mergeImportedTradesToPositions(rows, positions);
 * // instructions[0].buySummary.weightedPrice = 总买入金额 / 总股数
 * // instructions[0].sellSummary.totalAmount = 卖出总股数
 */
export function mergeImportedTradesToPositions(
  rows: ImportDraftRow[],
  existingPositions: Position[],
): MergedImportInstruction[] {
  // 只处理中长期相关的行（跳过短线做T、计划单履约等）
  const ltRows = rows.filter(
    (r) =>
      (r.targetCategory === 'LONG_TERM_BATCH' || r.targetCategory === 'NEW_POSITION') &&
      !r.skipImport,
  );
  if (ltRows.length === 0) return [];

  // 按归一化代码分组（消除 sh600519 / 600519 / SH600519 等不同格式的差异）
  const groups = new Map<string, { rows: ImportDraftRow[]; canonicalFullCode: string }>();
  for (const r of ltRows) {
    const key = normalizeCode(r.fullCode);
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(r);
      // 优先选择带市场前缀的 fullCode 作为权威代码（剪贴板导入可能无前缀）
      if (/^(sh|sz|bj)/i.test(r.fullCode) && !/^(sh|sz|bj)/i.test(existing.canonicalFullCode)) {
        existing.canonicalFullCode = r.fullCode;
      }
    } else {
      groups.set(key, { rows: [r], canonicalFullCode: r.fullCode });
    }
  }

  const instructions: MergedImportInstruction[] = [];

  for (const [normKey, { rows: groupRows, canonicalFullCode }] of groups) {
    // 按时间排序（确保加权平均和建仓顺序正确）
    groupRows.sort((a, b) => a.timestamp - b.timestamp);

    const buys = groupRows.filter((r) => r.direction === 'buy');
    const sells = groupRows.filter((r) => r.direction === 'sell');

    // 汇总买入
    let buyTotalAmount = 0;
    let buyTotalCost = 0;
    for (const b of buys) {
      buyTotalAmount += b.amount;
      buyTotalCost += b.price * b.amount;
    }
    const buySummary: BuySummary | null =
      buyTotalAmount > 0
        ? {
            totalAmount: buyTotalAmount,
            totalCost: buyTotalCost,
            weightedPrice: buyTotalCost / buyTotalAmount,
            count: buys.length,
          }
        : null;

    // 汇总卖出
    let sellTotalAmount = 0;
    let sellTotalProceeds = 0;
    for (const s of sells) {
      sellTotalAmount += s.amount;
      sellTotalProceeds += s.price * s.amount;
    }
    const sellSummary: SellSummary | null =
      sellTotalAmount > 0
        ? {
            totalAmount: sellTotalAmount,
            totalProceeds: sellTotalProceeds,
            count: sells.length,
          }
        : null;

    // 匹配已有持仓：用归一化代码匹配，消除代码格式差异
    const existingPos = existingPositions.find(
      (p) => normalizeCode(p.fullCode) === normKey && !p.isClosed,
    );

    // 统一键：优先用持仓上的权威代码，其次用规范化后的代码（消除 SH:600519 / 600519.SH 等格式差异）
    const resolvedFullCode = existingPos ? existingPos.fullCode : canonicalizeFullCode(canonicalFullCode);
    // 统一名称：优先用持仓上的权威名称，其次用导入名称
    const resolvedName = existingPos?.stockName || groupRows[0].stockName || resolvedFullCode;

    instructions.push({
      fullCode: resolvedFullCode,
      stockName: resolvedName,
      action: existingPos ? 'add_to_position' : 'create_position',
      existingPositionId: existingPos?.id,
      existingPosition: existingPos,
      allRows: groupRows,
      buySummary,
      sellSummary,
    });
  }

  return instructions;
}