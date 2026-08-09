export interface StockSearchItem {
  /** 完整证券代码（含市场前缀），如 sh601318 / sz000001。作为持仓与做T记录的唯一主键。 */
  fullCode: string;
  Code: string;
  Name: string;
  PinYin: string;
  SecurityTypeName: string;
  SecurityType: string;
  MktNum: string;
  MarketType: string;
  Classify: string;
  Type: string;
  UnifiedCode: string;
  QuoteID: string;
  ShortName: string;
  InnerCode?: string;
}

export interface StockSearchResponse {
  QuotationCodeTable: {
    Data: StockSearchItem[];
    Status: number;
    Message: string;
    TotalCount: number;
  };
}