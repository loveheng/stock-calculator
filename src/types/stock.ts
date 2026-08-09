/**
 * @file stock.ts
 * @description 股票基础类型定义：行情服务搜索返回的标的条目（StockSearchItem）、
 *              应用内规范化元数据（StockMeta）与搜索接口响应结构（StockSearchResponse）。
 * @layer DAO（类型层）
 * @storage_impact 纯类型定义，无运行时代码，不读写任何存储。
 * @author 开发团队
 */

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
  /** 行情 QuoteID（可选） */
  quoteId?: string;
  /** 简称（可选） */
  shortName?: string;
  /** 统一编码（可选） */
  unifiedCode?: string;
}

/**
 * 股票搜索接口的响应结构。
 *
 * @description 行情服务统一返回包裹层：数据位于 `QuotationCodeTable.Data`；
 *              Status 非 0 时 Message 描述失败原因。
 */
export interface StockSearchResponse {
  QuotationCodeTable: {
    /** 搜索结果列表 */
    Data: StockSearchItem[];
    /** 状态码（0 表示成功） */
    Status: number;
    /** 状态消息 */
    Message: string;
    /** 命中总数 */
    TotalCount: number;
  };
}
