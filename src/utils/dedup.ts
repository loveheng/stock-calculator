/**
 * @file dedup.ts
 * @description 交易特征指纹生成与查重纯函数。所有函数无副作用，仅做字符串/集合运算，
 *              供批量导入暂存区（Intra-Batch）与历史库（Cross-Store）两道防线调用。
 * @layer Utility
 * @author 开发团队
 */

export type DuplicateStatus = 'UNIQUE' | 'POTENTIAL' | 'EXACT_DUPLICATE';


/** 归一化证券代码：去前缀转大写，如 'sh600519' -> '600519'。支持多种格式（600519、sh600519、SH:600519、600519.SH）。 */
export function normalizeCode(raw: string): string {
  const c = String(raw ?? '').trim();
  // 优先从所有格式中提取 6 位数字代码
  const m = c.match(/(\d{6})/);
  if (m) return m[1];
  // 回退：去市场前缀 + 大写
  return c.replace(/^(sh|sz|bj)/i, '').toUpperCase();
}

/** 归一化证券名称：大写 + 去风险/除权/新股前缀 + 去空白，用于口径不一致时的名称匹配 */
export function normalizeStockName(raw: string): string {
  return String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/^\*/, '')
    .replace(/^(ST|XD|XR|DR|N|C)\s*/g, '')
    .replace(/\s/g, '');
}

/** 本地时区 'YYYYMMDD' 密钥 */
export function dateKey(ts: number | string | Date): string {
  const d = typeof ts === 'string' || typeof ts === 'number' ? new Date(ts) : ts;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * 将任意代码表达归一化为带市场前缀的规范形（如 '600519' / 'SH:600519' / '600519.SH' -> 'sh600519'）。
 * 市场前缀只能从文本推导，故仅提供规范化，不保证市场猜测一定正确（交由权威源校正）。
 */
export function canonicalizeFullCode(raw: string): string {
  const c = String(raw ?? '').trim();
  // 已含市场前缀：sh600519 / SH:600519 / sh_600519
  const p = c.match(/^(sh|sz|bj)\s*[:._-]?\s*(\d{6})/i);
  if (p) return p[1].toLowerCase() + p[2];
  // 后缀格式：600519.SH / 600519-sh / 600519.sz
  const s = c.match(/^(\d{6})\s*[._:\-]?\s*(sh|sz|bj)$/i);
  if (s) return s[2].toLowerCase() + s[1];
  // 纯 6 位数字：按首位推测市场（沪 6/9/5，北 4/8，其余深）
  if (/^\d{6}$/.test(c)) {
    if (/^[695]/.test(c)) return 'sh' + c;
    if (/^[48]/.test(c)) return 'bj' + c;
    return 'sz' + c;
  }
  return c;
}

/**
 * 判断两条增强记录是否指向同一标的：优先按代码（权威），其次按归一化名称（辅助）。
 */
export function isSameStock(a: { fullCode?: string; stockName?: string }, b: { fullCode?: string; stockName?: string }): boolean {
  const ca = a.fullCode ? normalizeCode(a.fullCode) : '';
  const cb = b.fullCode ? normalizeCode(b.fullCode) : '';
  if (ca && cb && ca === cb) return true;
  const na = a.stockName ? normalizeStockName(a.stockName) : '';
  const nb = b.stockName ? normalizeStockName(b.stockName) : '';
  return !!na && !!nb && na === nb;
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

