/**
 * @file importAdapter.ts
 * @description 批量导入统一适配器：原始数据（手动填表 / 剪贴板粘贴 / OCR 输出）的格式归一化、
 *              智能关联 Position/PlannedOrder、默认分类推断与指纹生成。
 *              转译结果直接输出 ImportDraftRow[]，供 BatchImport 工作台消费。
 * @layer Service
 * @author 开发团队
 */

import { generateId } from '../store/utils';
import { generateTxFingerprint, classifyDraft, dateKey, type PreparedHistory } from '../utils/dedup';
import { normalizeCode } from '../utils/dedup';
export { normalizeCode };
import type { ImportDraftRow, ImportTargetCategory, RawTxRecord } from '../types/import';
export type { RawTxRecord };
import type { Position, PlannedOrder } from '../store/types';

/** 简易代码规范化：补市场前缀 + 去前缀统一大写（供 OCR 数字代码转 fullCode） */
export function toFullCode(code: string): string {
  const c = String(code ?? '').trim();
  if (/^(sh|sz|bj)/i.test(c)) return c.toLowerCase();
  if (!/^\d{6}$/.test(c)) return c;
  if (/^[695]/.test(c)) return 'sh' + c;
  if (/^[48]/.test(c)) return 'bj' + c;
  return 'sz' + c;
}

/** 从字符串提取方向枚举 */
function toDirection(v: unknown): 'buy' | 'sell' | undefined {
  const s = String(v ?? '').trim();
  if (/^(买|buy)/i.test(s)) return 'buy';
  if (/^(卖|sell)/i.test(s)) return 'sell';
  return undefined;
}

/**
 * 将 OCR / 后端解析接口返回的 JSON 载荷归一化为 RawTxRecord[]。
 * 兼容 { items: [...] } 包装对象 或 裸数组。
 */
export function parseOcrPayload(payload: unknown): RawTxRecord[] {
  const raw = (payload as any)?.items ?? payload;
  if (!Array.isArray(raw)) return [];
  const out: RawTxRecord[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const code = it.fullCode ?? it.stockCode ?? it.code ?? it.证券代码;
    const priceNum = Number(it.price ?? it.tradePrice ?? it.成交价格 ?? it.成交价);
    const amountNum = Number(it.amount ?? it.quantity ?? it.成交数量 ?? it.volume);
    if (!code || isNaN(priceNum) || priceNum <= 0 || isNaN(amountNum) || amountNum <= 0) continue;
    const dir = toDirection(it.direction ?? it.buySell ?? it.交易方向 ?? it.买卖);
    if (!dir) continue;
    const ts = it.timestamp ?? it.tradeTime ?? it.成交时间;
    out.push({
      fullCode: toFullCode(String(code)),
      stockName: it.stockName ?? it.name ?? it.证券名称,
      timestamp: ts ? String(ts).trim() : undefined,
      direction: dir,
      price: Number(priceNum.toFixed(3)),
      amount: Math.round(amountNum),
    });
  }
  return out;
}

/**
 * 解析制表符分隔的多行文本（同花顺/东财导出格式）。
 * 支持格式示例：
 *   2026-08-23 10:31	600519	贵州茅台	买入	1680.00	100
 *   600519	买	1680	100
 * 行内字段用制表符 / 空格分隔皆可。
 */
export function parseClipboardText(text: string): RawTxRecord[] {
  const lines = text.trim().split('\n').filter(Boolean);
  const results: RawTxRecord[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\t| +/).filter(Boolean);
    if (parts.length < 4) continue;

    let idx = 0;
    let timestamp: string | undefined;
    let fullCode: string;
    let stockName: string | undefined;
    let direction: string;
    let price: number;
    let amount: number;

    const first = parts[idx];
    if (/^\d{4}[\-\/]\d{1,2}[\-\/]\d{1,2}/.test(first)) {
      timestamp = first;
      idx++;
      if (parts[idx] && /^\d{2}:\d{2}/.test(parts[idx])) {
        timestamp += ' ' + parts[idx++];
      }
    }

    fullCode = parts[idx++];
    if (parts[idx] && !/^(买|卖|buy|sell)/i.test(parts[idx]) && !/^\d+(\.\d+)?$/.test(parts[idx])) {
      stockName = parts[idx++];
    }

    direction = parts[idx++];
    price = parseFloat(parts[idx++]);
    amount = parseInt(parts[idx++], 10);

    if (isNaN(price) || isNaN(amount)) continue;

    const dir: 'buy' | 'sell' = /^(买|buy)/i.test(direction) ? 'buy' : 'sell';
    results.push({ fullCode, stockName, timestamp, direction: dir, price, amount });
  }
  return results;
}

/**
 * 根据现有数据为 draft 行填充默认归类与关联目标。
 * 规则：
 * - 若该标的已有持仓，默认 SHORT_TERM_T（买入方向也可选 LONG_TERM_BATCH）
 * - 若该标的有活跃计划单，保留 BIND_PLANNED_ORDER 选项
 * - 无持仓 → 默认 LONG_TERM_BATCH（新开仓）
 */
export function enrichDraftRow(
  row: Partial<ImportDraftRow> & { fullCode: string; direction: 'buy' | 'sell'; price: number; amount: number },
  positions: Position[],
  plannedOrders: PlannedOrder[],
): ImportDraftRow {
  const fullCode = row.fullCode;
  const norm = normalizeCode(fullCode);
  const pos = positions.find((p) => normalizeCode(p.fullCode) === norm && !p.isClosed);
  const activePlans = plannedOrders.filter(
    (p) => normalizeCode(p.fullCode) === norm && p.status === 'active',
  );

  let targetCategory: ImportTargetCategory = pos ? 'SHORT_TERM_T' : 'LONG_TERM_BATCH';
  // 如果用户已有归类，保留
  if (row.targetCategory) targetCategory = row.targetCategory;

  // 智能预挂载计划单：当方向/价格/数量匹配时自动设为 BIND_PLANNED_ORDER
  const planBind = row.targetCategory ? undefined : inferPlanBind(
    { fullCode: row.fullCode, direction: row.direction, price: row.price, amount: row.amount },
    plannedOrders,
  );
  if (planBind && !row.targetCategory) {
    targetCategory = 'BIND_PLANNED_ORDER';
  }

  const timestamp = row.timestamp ?? Date.now();
  const ts = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();

  return {
    id: row.id ?? generateId(),
    fingerprint: generateTxFingerprint({
      fullCode,
      direction: row.direction,
      price: row.price,
      amount: row.amount,
      timestamp: ts,
    }),
    timestamp: ts,
    fullCode,
    stockName: row.stockName ?? pos?.stockName ?? '',
    direction: row.direction,
    price: row.price,
    amount: row.amount,

    targetCategory,
    targetPositionId: pos?.id,
    targetPlannedOrderId: planBind ? planBind.id : (activePlans.length > 0 ? activePlans[0].id : undefined),
    isNewPosition: !pos && targetCategory === 'LONG_TERM_BATCH',

    // 防重状态初始为 UNIQUE，由调用方触发 completeDedupCheck 后更新
    duplicateStatus: 'UNIQUE',
    matchedRecordId: undefined,
    skipImport: false,

    validationStatus: 'PENDING',
    validationMessage: undefined,
    source: row.source ?? 'manual',
  };
}

/**
 * 批量比对暂存区所有行与历史库，标记每行的 duplicateStatus + skipImport。
 * 同时执行两道防线：Intra-Batch（表内去重） + Cross-Store（历史库去重）。
 * 返回更新后的 rows。
 */
export function completeDedupCheck(
  rows: ImportDraftRow[],
  history: PreparedHistory[],
): ImportDraftRow[] {
  // 构建 Intra-Batch 指纹集（表内已出现的指纹）
  const seenFingerprints = new Set<string>();

  return rows.map((row) => {
    // 第一道防线：表内去重
    if (seenFingerprints.has(row.fingerprint)) {
      return { ...row, duplicateStatus: 'EXACT_DUPLICATE' as const, skipImport: true };
    }
    seenFingerprints.add(row.fingerprint);

    // 第二道防线：历史库去重
    const result = classifyDraft(row, history);
    return {
      ...row,
      duplicateStatus: result.status,
      matchedRecordId: result.matchedId,
      skipImport: result.status === 'EXACT_DUPLICATE',
    };
  });
}

/**
 * 从 store 中的 positions / tRounds / longTermRecords 构建 PreparedHistory 列表。
 * 供 Cross-Store 防重比对使用。
 */
export function buildHistoryFromStore(
  positions: Position[],
  longTermRecords: { id: string; fullCode: string; type: string; price: number; amount: number; timestamp: string }[],
): PreparedHistory[] {
  const history: PreparedHistory[] = [];

  for (const pos of positions) {
    for (const b of pos.batches) {
      const dk = b.timestamp
        ? new Date(b.timestamp).toISOString().slice(0, 10).replace(/-/g, '')
        : '';
      history.push({
        id: b.id,
        dk,
        normalizedCode: normalizeCode(pos.fullCode),
        direction: b.type === 'reduce' ? 'sell' : 'buy',
        price: b.price,
        amount: Math.abs(b.amount),
      });
    }
  }

  for (const r of longTermRecords) {
    const dk = r.timestamp
      ? new Date(r.timestamp).toISOString().slice(0, 10).replace(/-/g, '')
      : '';
    history.push({
      id: r.id,
      dk,
      normalizedCode: normalizeCode(r.fullCode),
      direction: r.type === 'sell' ? 'sell' : 'buy',
      price: r.price,
      amount: Math.abs(r.amount),
    });
  }

  return history;
}

/**
 * 根据目标分类获取可选的 Position 列表（排除已结仓）。
 */
/**
 * 计划单智能预挂载：当某标的存在待履约（active）计划单，
 * 且流水方向与计划一致、价格/数量落在合理偏差范围内时，返回该计划单。
 * 价格容差默认 5%，数量容差默认允许 ±1 股或 ±10%。
 */
export function inferPlanBind(
  row: { fullCode: string; direction: 'buy' | 'sell'; price: number; amount: number },
  plannedOrders: PlannedOrder[],
  opts?: { priceTolerance?: number; qtyTolerance?: number },
): PlannedOrder | undefined {
  const norm = normalizeCode(row.fullCode);
  const priceTol = opts?.priceTolerance ?? 0.05;
  const qtyTol = opts?.qtyTolerance ?? 0.1;
  const candidates = plannedOrders.filter(
    (p) => normalizeCode(p.fullCode) === norm && p.status === 'active' && p.direction === row.direction,
  );
  for (const p of candidates) {
    const priceDev = p.plannedPrice > 0 ? Math.abs(row.price - p.plannedPrice) / p.plannedPrice : 1;
    const qtyDev = p.plannedAmount > 0 ? Math.abs(row.amount - p.plannedAmount) / p.plannedAmount : 1;
    if (priceDev <= priceTol && (qtyDev <= qtyTol || Math.abs(row.amount - p.plannedAmount) <= 1)) return p;
  }
  return undefined;
}

/** 将扁平行按股票代码聚合成卡片组数组 */
export function groupRowsByStock(rows: ImportDraftRow[]): { key: string; items: ImportDraftRow[] }[] {
  const map = new Map<string, ImportDraftRow[]>();
  for (const r of rows) {
    const key = r.fullCode ? normalizeCode(r.fullCode) : '__unassigned__';
    const arr = map.get(key);
    if (arr) arr.push(r);
    else map.set(key, [r]);
  }
  return Array.from(map.entries()).map(([key, items]) => ({ key, items }));
}

export function getAvailablePositions(positions: Position[], fullCode: string): Position[] {
  const norm = normalizeCode(fullCode);
  return positions.filter((p) => normalizeCode(p.fullCode) === norm && !p.isClosed);
}

/**
 * 根据标的获取活跃计划单列表。
 */
export function getActivePlannedOrders(plannedOrders: PlannedOrder[], fullCode: string): PlannedOrder[] {
  const norm = normalizeCode(fullCode);
  return plannedOrders.filter((p) => normalizeCode(p.fullCode) === norm && p.status === 'active');
}