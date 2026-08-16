/**
 * @file stockService.ts
 * @description 股票行情服务：封装腾讯 Smartbox 行情搜索接口与 qt.gtimg.cn 实时行情接口，
 *              支持按代码/中文名/拼音首字母搜索股票，并将原始 GBK 响应解析为统一的
 *              StockSearchItem 条目（含市场/证券类型/拼音等）或 StockQuoteSummary 行情摘要
 *              （剔除五档挂单后的核心行情字段）；
 *              实时行情支持多代码批量合并（q=sh600745,sz002594 单次请求），
 *              并对相同代码集合的进行中请求做去重（并发共享同一 HTTP 请求）；
 *              另提供防抖工具函数供 UI 输入场景复用。
 * @layer Service
 * @storage_impact 本文件为纯网络服务层，不直接读写 IndexedDB；搜索结果由
 *                 调用方（视图/Store）决定是否缓存落库。
 * @author 开发团队
 */

import type { StockQuoteSummary, StockSearchItem } from '../types/stock';

/** 行情摘要类型同时从服务层导出，便于 UI 侧统一从服务模块引用。 */
export type { StockQuoteSummary };

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

<<<<<<< HEAD
  // 通过 Vite 代理转发请求，避免跨域问题
  const params = new URLSearchParams({
    input: input.trim(),
    type: '14',
    count: '10',
  });

  const res = await fetch(`/api/suggest/get?${params.toString()}`, {
    method: 'GET',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signe',
=======
  const url = `/api-gtimg/s3/?q=${encodeURIComponent(input.trim())}&t=gp`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Referer: 'https://finance.qq.com/',
>>>>>>> dev
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
 * 腾讯行情接口（qt.gtimg.cn）载荷所需覆盖的最大字段索引（市净率 = 46），
 * 即分割后字段数须 ≥ 47（含索引 0 的市场标志）。
 */
const QUOTE_REQUIRED_FIELDS = 47;

/**
 * 将字符串安全转换为 number。
 *
 * @param {string | undefined} value - 原始字符串字段（索引越界时可能为 undefined）
 * @returns {number} 转换成功返回数值；空值 / 非法值 / Infinity 统一归零
 */
function toNumber(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

/**
 * 将腾讯行情接口（qt.gtimg.cn）的原始响应文本解析为行情摘要。
 *
 * 原始格式示例（以 ~ 分隔，字段以双引号包裹）：
 *   v_sh600745="1~*ST闻泰~600745~17.15~17.48~17.24~342523~144623~197900~
 *               17.15~1125~...~428~~20260812161440~-0.33~-1.89~17.37~17.10~
 *               17.15/342523/589609161~342523~58961~2.69~-2.38~~...~1.54~
 *               218.47~218.47~0.93~";
 * 其中索引 7、8 为内外盘、索引 9~28 为买一~卖五五档挂单，均按要求跳过。
 *
 * @param {string} raw - 腾讯行情接口的原始响应文本（GBK 已解码）
 * @returns {StockQuoteSummary | null} 解析后的行情摘要；载荷无效（引号缺失/字段不足）时返回 null
 */
function parseQuoteSummaryPayload(raw: string): StockQuoteSummary | null {
  const firstQuote = raw.indexOf('"');
  const lastQuote = raw.lastIndexOf('"');
  if (firstQuote === -1 || lastQuote <= firstQuote) return null;

  const fields = raw.slice(firstQuote + 1, lastQuote).split('~');
  if (fields.length < QUOTE_REQUIRED_FIELDS) return null;

  return {
    // 索引 1~6：基础行情
    stockName: fields[1] ?? '',
    fullCode: fields[2] ?? '',
    currentPrice: toNumber(fields[3]),
    lastClose: toNumber(fields[4]),
    openPrice: toNumber(fields[5]),
    volume: toNumber(fields[6]),
    // 索引 7、8（内外盘）与索引 9~28（买一~卖五挂单）已跳过
    // 索引 30~39：更新时间 / 涨跌 / 最高最低 / 成交额 / 换手率 / 市盈率
    updateTime: fields[30] ?? '',
    changeAmount: toNumber(fields[31]),
    changePercent: toNumber(fields[32]),
    highPrice: toNumber(fields[33]),
    lowPrice: toNumber(fields[34]),
    turnoverAmount: toNumber(fields[37]),
    turnoverRatio: toNumber(fields[38]),
    peRatio: toNumber(fields[39]),
    // 索引 44~46：实测 44=流通市值、45=总市值、46=市净率
    marketCap: toNumber(fields[45]),
    circulatingCap: toNumber(fields[44]),
    pbRatio: toNumber(fields[46]),
  };
}

/**
 * 解析腾讯批量行情响应文本为 fullCode → 行情摘要映射。
 *
 * @description 批量接口（q=sh600745,sz002594）的响应为多行拼接，形如：
 *   v_sh600745="1~*ST闻泰~600745~17.15~...~";\nv_sz002594="0~比亚迪~002594~100.00~...~";
 * 本函数按行（以 ; 或换行分隔）提取变量名 v_<fullCode> 作为映射键（与请求代码对齐），
 * 每行复用 parseQuoteSummaryPayload 解析；非行情行（如 v_pv_none_match="1"）直接跳过。
 *
 * @param {string} raw - 腾讯行情接口的原始批量响应文本（GBK 已解码）
 * @returns {Record<string, StockQuoteSummary | null>} fullCode → 行情摘要；
 *          单个标的载荷无效时对应 null，无效行不进入映射
 */
export function parseQuoteSummaryBatchPayload(
  raw: string
): Record<string, StockQuoteSummary | null> {
  const result: Record<string, StockQuoteSummary | null> = {};

  for (const line of raw.split(/[\r\n;]+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;

    // 变量名形如 v_sh600745；非行情行（如 v_pv_none_match）无法匹配合法代码则跳过
    const fullCode = trimmed
      .slice(0, eqIdx)
      .trim()
      .replace(/^v_/i, '')
      .toLowerCase();
    if (!/^[a-z]{2}\d{6}$/.test(fullCode)) continue;

    result[fullCode] = parseQuoteSummaryPayload(trimmed);
  }

  return result;
}

/**
 * 模块级进行中批量请求去重缓存：相同代码集合的并发请求共享同一个 HTTP 请求，
 * 避免 React StrictMode 双挂载或两个视图同时请求时重复打接口。
 */
const inFlightSummaries = new Map<string, Promise<Record<string, StockQuoteSummary | null>>>();

/**
 * 批量获取多个标的的实时行情摘要（腾讯 qt.gtimg.cn 多代码拼接，单次请求）。
 *
 * @description fullCodes 去重后以逗号拼接（q=sh600745,sz002594）一次请求，
 *              响应逐行解析后仅返回请求过的代码（未返回/解析失败对应 null），
 *              单个标的缺失不影响其余标的。请求经本地 Vite 代理 / 线上 Vercel
 *              代理（/api-qt）访问避免跨域，响应以 GBK 二进制流解码。
 * @param {string[]} fullCodes - 完整证券代码数组（含市场前缀），如 ['sh600745', 'sz002594']
 * @returns {Promise<Record<string, StockQuoteSummary | null>>} fullCode → 行情摘要；空数组返回 {}
 * @throws {Error} 当网络请求失败（非 2xx 状态）时抛出「股票行情请求失败」异常
 * @note 无 IndexedDB 副作用；返回值结构见 {@link StockQuoteSummary}
 */
export async function fetchStockSummaries(
  fullCodes: string[]
): Promise<Record<string, StockQuoteSummary | null>> {
  const codes = Array.from(new Set(fullCodes.map((c) => c.trim()).filter((c) => c.length > 0)));
  if (codes.length === 0) return {};

  // 相同代码集合（与顺序无关）的在途请求直接复用，避免重复打接口
  const cacheKey = codes.slice().sort().join(',');
  const cached = inFlightSummaries.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const url = `/api-qt/q=${encodeURIComponent(codes.join(','))}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Referer: 'https://finance.qq.com/',
      },
    });

    if (!res.ok) {
      throw new Error(`股票行情请求失败: ${res.status} ${res.statusText}`);
    }

    // 获取二进制流并用 GBK 解码（兼容中文等其他编码）
    const buffer = await res.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buffer);

    const parsed = parseQuoteSummaryBatchPayload(text);

    // 只返回请求过的代码，未返回/解析失败的补齐 null
    const result: Record<string, StockQuoteSummary | null> = {};
    for (const code of codes) result[code] = parsed[code] ?? null;
    return result;
  })();

  inFlightSummaries.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inFlightSummaries.delete(cacheKey);
  }
}

/**
 * 获取个股实时行情摘要（腾讯 qt.gtimg.cn）。
 *
 * @description 单标的薄封装：委托 fetchStockSummaries 走批量请求路径，
 *              保持历史调用方（单标的）兼容。
 * @param {string} fullCode - 完整证券代码（含市场前缀），如 sh600745
 * @returns {Promise<StockQuoteSummary | null>} 行情摘要；空代码或载荷无法解析时返回 null
 * @throws {Error} 当网络请求失败（非 2xx 状态）时抛出「股票行情请求失败」异常
 * @note 无 IndexedDB 副作用；返回值结构见 {@link StockQuoteSummary}
 */
export async function fetchStockSummary(
  fullCode: string
): Promise<StockQuoteSummary | null> {
  const result = await fetchStockSummaries([fullCode]);
  return result[fullCode.trim()] ?? null;
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