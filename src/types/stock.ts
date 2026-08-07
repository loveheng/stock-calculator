export interface StockSearchItem {
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