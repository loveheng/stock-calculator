/**
 * @file dedup.ts
 * @description 交易特征指纹生成与查重纯函数。所有函数无副作用，仅做字符串/集合运算，
 *              供批量导入暂存区（Intra-Batch）与历史库（Cross-Store）两道防线调用。
 * @layer Utility
 * @author 开发团队
 */

export type DuplicateStatus = 'UNIQUE' | 'POTENTIAL' | 'EXACT_DUPLICATE';


/** 归一化证券代码：去前缀转大写，如 'sh600519' -> '600519' */
export function normalizeCode(raw: string): string {
  return String(raw ?? '').trim().replace(/^(sh|sz|bj)/i, '').toUpperCase();
}

/** 本地时区 'YYYYMMDD' 密钥 */
export function dateKey(ts: number | string | Date): string {
  const d = typeof ts === 'string' || typeof ts === 'number' ? new Date(ts) : ts;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** 生成交易特征指纹：代码_方向_价格(3位)_数量_日期 */
export function generateTxFingerprint(input: {
  fullCode: string;
  direction: 'buy' | 'sell';
  price: number;
  amount: number;
  timestamp: number | string;
}): string {
  const code = normalizeCode(input.fullCode);
  const price = (input.price ?? 0).toFixed(3);
  const amount = Math.round(input.amount ?? 0);
  return `${code}_${input.direction}_${price}_${amount}_${dateKey(input.timestamp)}`;
}

/** 两数在容差内视为相等（价格保留 3 位尾差） */
function numberEq(a: number, b: number, eps = 0.002): boolean {
  return Math.abs(a - b) <= eps;
}

/**
 * 将一行输入与历史库比对，返回防重判定：
 * - EXACT_DUPLICATE：同日 + 同代码 + 同方向 + 价格数量一致（默认禁止过账）
 * - POTENTIAL      ：同日 + 同代码 + 同方向，但价格或数量有差异（允许用户确认强制导入）
 * - UNIQUE         ：无任何命中
 */
export function classifyDraft(
  input: {
    fullCode: string;
    direction: 'buy' | 'sell';
    price: number;
    amount: number;
    timestamp: number | string;
  },
  history: PreparedHistory[],
): { status: DuplicateStatus; matchedId?: string } {
  const dk = dateKey(input.timestamp);
  const code = normalizeCode(input.fullCode);
  let exactId: string | undefined;
  let potentialId: string | undefined;

  for (const h of history) {
    if (h.dk !== dk || h.normalizedCode !== code || h.direction !== input.direction) continue;
    if (numberEq(h.price, input.price) && Math.round(h.amount) === Math.round(input.amount)) {
      exactId = h.id;
      break;
    }
    if (!potentialId) potentialId = h.id;
  }

  if (exactId) return { status: 'EXACT_DUPLICATE', matchedId: exactId };
  if (potentialId) return { status: 'POTENTIAL', matchedId: potentialId };
  return { status: 'UNIQUE' };
}

export interface PreparedHistory {
  id: string;
  dk: string;
  normalizedCode: string;
  direction: 'buy' | 'sell';
  price: number;
  amount: number;
}

