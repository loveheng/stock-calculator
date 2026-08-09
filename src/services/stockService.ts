/**
 * @file stockService.ts
 * @description 股票行情搜索服务：封装腾讯 Smartbox 行情接口，
 *              支持按代码/中文名/拼音首字母搜索股票，并将原始 GBK 响应
 *              解析为统一的 StockSearchItem 条目（含市场/证券类型/拼音等）；
 *              另提供防抖工具函数供 UI 输入场景复用。
 * @layer Service
 * @storage_impact 本文件为纯网络服务层，不直接读写 IndexedDB；搜索结果由
 *                 调用方（视图/Store）决定是否缓存落库。
 * @author 开发团队
 */

import type { StockSearchItem } from '../types/stock';

/** 腾讯 Smartbox 返回的证券类型 → 可读简称映射 */
const SECURITY_TYPE_NAME_MAP: Record<string, string> = {
  'GP-A': 'A股',
  'GP-B': 'B股',
  'GP-HK': '港股',
  'GP-US': '美股',
  ZS: '指数',
  FJ: '基金',
  LOF: '基金',
  ETF: '基金',
  QFII: 'QFII',
};

/** 市场前缀 → 东财 MktNum（沪=1，深=0） */
const MKT_NUM_MAP: Record<string, string> = {
  sh: '1',
  sz: '0',
};

/**
 * 还原响应文本中的 \uXXXX 字面转义为真实 Unicode 字符。
 * 腾讯 Smartbox 返回的股票名称（如 \u5e73\u5b89\u94f6\u884c）是以
 * JS 字符串转义形式输出，需要手动还原。
 *
 * @param {string} text - 含 \uXXXX 字面转义的原始文本
 * @returns {string} 还原为真实 Unicode 字符后的字符串
 */
function decodeUnicodeEscapes(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

/**
 * 将腾讯 Smartbox 的原始 v_hint 字符串解析为个股条目数组。
 * 原始格式示例：
 *   v_hint="sz~000001~\u5e73\u5b89\u94f6\u884c~payh~GP-A^sh~601318~\u4e2d\u56fd\u5e73\u5b89~zgpa~GP-A";
 *
 * @param {string} raw - 腾讯 Smartbox 接口的原始响应文本
 * @returns {StockSearchItem[]} 解析后的股票条目数组；载荷无效时返回 []
 */
function parseSmartboxPayload(raw: string): StockSearchItem[] {
  // 提取引号包裹的载荷（剔除 v_hint=" 前缀与结尾的 ";"）
  const firstQuote = raw.indexOf('"');
  const lastQuote = raw.lastIndexOf('"');
  if (firstQuote === -1 || lastQuote <= firstQuote) return [];

  const payload = raw.slice(firstQuote + 1, lastQuote);
  if (!payload) return [];

  const results: StockSearchItem[] = [];

  // 以 ^ 分隔多个股票结果项
  for (const item of payload.split('^')) {
    const fields = item.split('~');
    if (fields.length < 5) continue;

    const market = fields[0]; // 市场前缀: sh / sz
    const code = fields[1]; // 纯代码
    const name = decodeUnicodeEscapes(fields[2]); // 中文名（\u 转义还原）
    const pinYin = fields[3]; // 拼音缩写
    const securityType = fields[4]; // 证券类型: GP-A / GP-HK / ZS / FJ ...

    if (!market || !code) continue;

    const fullCode = `${market}${code}`; // 例如 sh601318，作为持仓/做T记录唯一主键
    const stock: StockSearchItem = {
      fullCode,
      Code: code,
      Name: name,
      PinYin: pinYin,
      SecurityTypeName: SECURITY_TYPE_NAME_MAP[securityType] ?? securityType,
      SecurityType: securityType,
      MktNum: MKT_NUM_MAP[market] ?? '',
      MarketType: market === 'sh' ? '1' : '2',
      Classify: `${market.toUpperCase()}-${securityType}`,
      Type: securityType,
      UnifiedCode: code,
      QuoteID: fullCode,
      ShortName: name,
      InnerCode: code,
    };

    results.push(stock);
  }

  return results;
}

/**
 * 搜索股票（腾讯 Smartbox API）。
 *
 * @description 搜索关键词支持：股票代码、中文名称、拼音首字母；
 *              请求经本地 Vite 代理 / 线上 Vercel 代理访问避免跨域，
 *              响应以 GBK 二进制流解码（兼容中文编码），再解析为条目数组。
 * @param {string} input - 搜索关键词（代码/名称/拼音）
 * @returns {Promise<StockSearchItem[]>} 匹配的股票条目数组；空关键词返回 []
 * @throws {Error} 当网络请求失败（非 2xx 状态）时抛出「股票搜索请求失败」异常
 * @note 无 IndexedDB 副作用；返回值结构见 {@link StockSearchItem}
 */
export async function searchStocks(input: string): Promise<StockSearchItem[]> {
  if (!input || input.trim().length === 0) return [];

  const url = `/api-gtimg/s3/?q=${encodeURIComponent(input.trim())}&t=gp`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Referer: 'https://finance.qq.com/',
    },
  });

  if (!res.ok) {
    throw new Error(`股票搜索请求失败: ${res.status} ${res.statusText}`);
  }

  // 获取二进制流并用 GBK 解码（兼容中文等其他编码）
  const buffer = await res.arrayBuffer();
  const text = new TextDecoder('gbk').decode(buffer);

  return parseSmartboxPayload(text);
}

/**
 * 防抖工具函数。
 *
 * @description 将多次连续调用合并为一次延迟执行；若在延迟期间再次调用，
 *              则重置计时器。适用于搜索框输入等高频触发场景。
 * @template T - 被防抖的函数类型
 * @param {T} fn - 需要防抖的原始函数
 * @param {number} delay - 延迟执行毫秒数
 * @returns {(args: Parameters<T>) => void} 防抖后的包装函数（返回值恒为 void，
 *          原始函数返回值被丢弃）
 * @note 无 IndexedDB 副作用
 */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      fn(...args);
      timer = null;
    }, delay);
  };
}