/**
 * @file stock.ts
 * @description 股票基础类型定义：行情服务搜索返回的标的条目（StockSearchItem）、
 *              应用内规范化元数据（StockMeta）、腾讯实时行情摘要（StockQuoteSummary）。
 * @layer DAO（类型层）
 * @storage_impact 纯类型定义，无运行时代码，不读写任何存储。
 * @author 开发团队
 */

import type { SecurityKind } from '../utils/mathUtils';

/**
 * 行情服务返回的单条股票/标的搜索结果。
 *
 * @description 字段命名遵循行情服务原始返回（大驼峰）；应用内部统一以
 *              `fullCode`（含市场前缀，如 sh601318）作为唯一主键存储。
 */
export interface StockSearchItem {
  /** 完整证券代码（含市场前缀），如 sh601318 / sz000001。作为持仓与做T记录的唯一主键。 */
  fullCode: string;
  /** 6 位数字证券代码（不含市场前缀） */
  Code: string;
  /** 证券名称（如 中国平安） */
  Name: string;
  /** 拼音缩写（如 zgpa），供搜索联想 */
  PinYin: string;
  /** 证券类型名称（如 股票 / 基金） */
  SecurityTypeName: string;
  /** 证券类型编码 */
  SecurityType: string;
  /** 市场编号（内部字段） */
  MktNum: string;
  /** 市场类型（如 SH / SZ） */
  MarketType: string;
  /** 分类（内部字段） */
  Classify: string;
  /** 类型（内部字段） */
  Type: string;
  /** 统一编码 */
  UnifiedCode: string;
  /** 行情 QuoteID，可用于订阅实时行情 */
  QuoteID: string;
  /** 简称 */
  ShortName: string;
  /** 内部编码（可选） */
  InnerCode?: string;
}

/**
 * 应用内规范化的股票元数据。
 *
 * @description 由 StockSearchItem 裁剪映射而来，用于持仓/做T记录中以精简结构持久化，
 *              避免存储冗余的大驼峰搜索字段。
 */
export interface StockMeta {
  /** 完整证券代码（含市场前缀），唯一主键 */
  fullCode: string;
  /** 6 位数字证券代码 */
  code: string;
  /** 证券名称 */
  stockName: string;
  /** 拼音缩写 */
  pinYin: string;
  /** 市场类型（SH / SZ 等） */
  marketType: string;
  /** 证券类型 */
  securityType: string;
  /** 快捷类型判断，直接映射费率引擎: 'stock' | 'etf' | 'bond' */
  kind: SecurityKind;
  /** 行情 QuoteID（可选） */
  quoteId?: string;
  /** 简称（可选） */
  shortName?: string;
  /** 统一编码（可选） */
  unifiedCode?: string;
}

/**
 * 腾讯实时行情接口（qt.gtimg.cn）返回的核心行情摘要。
 *
 * @description 由原始 ~ 分隔载荷裁剪而来：已剔除内外盘（索引 7、8）与
 *              买一~卖五五档挂单（索引 9~28），仅保留核心行情字段；
 *              数值字段由字符串统一转为 number。字段命名遵循行情接口
 *              约定，其中 fullCode 为 6 位数字证券代码（不含市场前缀）。
 */
export interface StockQuoteSummary {
  /** 股票名称 */
  stockName: string;
  /** 股票代码（6 位数字证券代码，不含市场前缀） */
  fullCode: string;
  /** 最新现价 */
  currentPrice: number;
  /** 昨收价 */
  lastClose: number;
  /** 今开价 */
  openPrice: number;
  /** 成交量（手） */
  volume: number;
  /** 数据更新时间（yyyyMMddHHmmss） */
  updateTime: string;
  /** 涨跌额 */
  changeAmount: number;
  /** 涨跌幅（%） */
  changePercent: number;
  /** 最高价 */
  highPrice: number;
  /** 最低价 */
  lowPrice: number;
  /** 成交额（万元） */
  turnoverAmount: number;
  /** 换手率（%） */
  turnoverRatio: number;
  /** 动态市盈率 */
  peRatio: number;
  /** 总市值（亿元） */
  marketCap: number;
  /** 流通市值（亿元） */
  circulatingCap: number;
  /** 市净率 */
  pbRatio: number;
}
