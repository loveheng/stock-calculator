/**
 * @file mathUtils.ts
 * @description 核心金融计算工具库：基于 decimal.js（20 位金融精度）提供 A 股规费计算、
 *              做T盈亏测算、涨跌幅/目标价/网格/分批建仓成本摊薄等纯函数计算。
 * @layer Utility
 * @storage_impact 纯计算模块，无任何 IndexedDB 读写，不产生副作用。
 * @author 开发团队
 */

// ============================================================
// 核心金融计算工具函数
// 使用 decimal.js 处理浮点数精度
// 中国 A 股标准规费计算规则
// ============================================================
import Decimal from 'decimal.js';

// 设置 Decimal 精度（金融计算保留 20 位中间精度）
/** 根据品种类型从 FeeConfig 中提取实际使用的费率参数 */
function resolveFeeConfig(feeConfig: FeeConfig, kind: SecurityKind) {
  // bond 与 etf 共享免税低费逻辑
  if (kind === 'etf' || kind === 'bond') {
    return {
      commissionRate: feeConfig.etfCommissionRate ?? feeConfig.commissionRate,
      isFreeFive: feeConfig.etfIsFreeFive ?? feeConfig.isFreeFive,
      minCommission: feeConfig.etfMinCommission ?? feeConfig.minCommission,
      transferRate: feeConfig.etfTransferRate ?? feeConfig.transferRate,
      stampRate: feeConfig.etfStampRate ?? feeConfig.stampRate,
    };
  }
  return {
    commissionRate: feeConfig.commissionRate,
    isFreeFive: feeConfig.isFreeFive,
    minCommission: feeConfig.minCommission,
    transferRate: feeConfig.transferRate,
    stampRate: feeConfig.stampRate,
  };
}
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

/** 交易费率引擎识别的标的类型 */
export type SecurityKind = 'stock' | 'etf' | 'bond';

/**
 * 根据腾讯 API 返回的类型标识与股票代码，精准映射到对应的费率类型。
 *
 * 优先级：
 *   1. 优先根据 rawType 判断（JJ → ETF, ZQ → bond）
 *   2. 二级保底：根据代码前缀特征兜底（51/56/58/15/16 → ETF, 11/12 → bond）
 *   3. 默认 → stock
 *
 * @param rawType - 腾讯接口第 5 个字段（如 'GP-A', 'FJ', 'ZQ'），缺省时仅靠 code 前缀
 * @param code    - 6 位数字证券代码（如 '510300', '113000', '601318'）
 */
export function matchSecurityKind(rawType: string = '', code: string = ''): SecurityKind {
  const upperType = rawType.toUpperCase();

  // 1. 优先根据 API 返回的 rawType 判断
  if (upperType.startsWith('JJ')) {
    return 'etf';
  }
  if (upperType.startsWith('ZQ')) {
    return 'bond';
  }

  // 2. 二级保底：根据 A 股代码前缀特征兜底
  //    ETF 前缀: 51, 56, 58 (沪市 ETF); 15, 16 (深市 ETF/LOF)
  if (/^(51|56|58|15|16)/.test(code)) {
    return 'etf';
  }
  //    可转债前缀: 11 (沪市); 12 (深市)
  if (/^(11|12)/.test(code)) {
    return 'bond';
  }

  // 3. 默认均为普通 A 股股票
  return 'stock';
}



/**
 * 费率配置（全局税率参数）。
 *
 * @description 由费率配置页维护，唯一单例注入全局 Store；所有规费计算函数共享该参数。
 */
export interface FeeConfig {
  commissionRate: number;
  isFreeFive: boolean;
  minCommission: number;
  transferRate: number;
  stampRate: number;
  /** ETF 佣金率（缺省回退到 commissionRate） */
  etfCommissionRate?: number;
  /** ETF 是否免五（缺省回退到 isFreeFive） */
  etfIsFreeFive?: boolean;
  /** ETF 最低佣金（元，缺省回退到 minCommission） */
  etfMinCommission?: number;
  /** ETF 过户费率（缺省回退到 transferRate；ETF 通常为 0） */
  etfTransferRate?: number;
  /** ETF 印花税率（缺省回退到 stampRate；ETF 通常为 0） */
  etfStampRate?: number;
}

/**
 * 单边交易规费明细。
 *
 * @description 由 calcTradeFees 返回，包含印花税、佣金、过户费及合计。
 */
export interface TradeFees {
  stamp: number;
  commission: number;
  transfer: number;
  total: number;
}

/**
 * 买卖双边规费汇总（含往返合计）。
 *
 * @description calcRoundTripFees 的返回结构，buyFee/sellFee 分别对应买入与卖出单边明细。
 */
export interface RoundTripFees {
  buyFee: TradeFees;
  sellFee: TradeFees;
  totalFee: number;
}

export interface ChangeRateResult {
  percent: number;
  diff: number;
}

export interface TargetPriceResult {
  target: number;
  diff: number;
}

export interface LadderItem {
  day: number;
  price: number;
  changeRate: number;
  cumulativePercent: number;
  diff: number;
}

export interface TTradeParams {
  mode: 'long' | 'short';
  buyPrice: number;
  buyAmount: number;
  sellPrice: number;
  sellAmount: number;
}

export interface TTradeResult {
  buyFee: TradeFees | null;
  sellFee: TradeFees | null;
  totalFee: number | null;
  isClosed: boolean;
  netProfit: number | null;
  profitRate: number | null;
  capitalRequired: number | null;
  breakevenPrice: number | null;
  capitalReleased: number | null;
  buybackPrice: number | null;
  status: string;
}

export interface CostAveragingResult {
  totalCost: number;
  totalAmount: number;
  avgCost: number;
}

export interface LotResult {
  amount: number;
  capital: number;
  actualCost: number;
}

export interface TargetCostResult {
  needAmount: number;
  needCapital: number;
  actualCost: number;
  suggestions: string[];
  exact: LotResult | null;
  downLot: LotResult | null;
  upLot: LotResult | null;
}

/**
 * 四舍五入到指定小数位（金融安全精度）。
 *
 * @description 内部基于 Decimal.toDecimalPlaces，避免 IEEE754 浮点误差累积。
 * @param {number | string | Decimal} value - 待舍入数值
 * @param {number} [decimals=2] - 保留小数位，默认 2 位（金额口径）
 * @returns {number} 舍入后的数字
 * @note 纯函数，无副作用；所有金额计算建议统一走本函数取整展示
 */
export function roundTo(value: number | string | Decimal, decimals: number = 2): number {
  return new Decimal(value).toDecimalPlaces(decimals).toNumber();
}

/**
 * 计算涨跌幅。
 *
 * @description 以 basePrice 为基准计算 targetPrice 相对涨跌幅与价差。
 * @param {number} basePrice - 基准价（如昨收）
 * @param {number} targetPrice - 目标价（如现价）
 * @returns {ChangeRateResult} { percent: 涨跌幅%, diff: 价差 }；基准价为 0 时返回 0
 */
export function calcChangeRate(basePrice: number, targetPrice: number): ChangeRateResult {
  const base = new Decimal(basePrice);
  const target = new Decimal(targetPrice);
  const diff = target.minus(base);
  const percent = diff.div(base).mul(100);
  return {
    percent: percent.toNumber(),
    diff: diff.toNumber(),
  };
}

/**
 * 按目标涨跌幅反推目标价。
 *
 * @description 输入基准价与涨跌幅（可为负），计算对应目标价与价差。
 * @param {number} basePrice - 基准价
 * @param {number} percent - 涨跌幅（如 5 表示 +5%）
 * @returns {TargetPriceResult} { target: 目标价, diff: 价差 }
 */
export function calcTargetPrice(basePrice: number, percent: number): TargetPriceResult {
  const base = new Decimal(basePrice);
  const pct = new Decimal(percent);
  const diff = base.mul(pct).div(100);
  const target = base.plus(diff);
  return {
    target: target.toNumber(),
    diff: diff.toNumber(),
  };
}

/**
 * 计算连续 N 天按固定涨跌幅 r 的复利价格阶梯（支持负值即连跌）
 * 公式：P_i = P_(i-1) × (1 + r)，即 P_i = 基准价 × (1 + r)^i
 * @param basePrice 基准价格
 * @param days 连续天数 N
 * @param ratePercent 单日涨跌幅百分比（如 +10 → 连涨，-7.5 → 连跌）
 */
export function calcLadder(
  basePrice: number,
  days: number,
  ratePercent: number
): LadderItem[] {
  const results: LadderItem[] = [];
  if (!isFinite(basePrice) || basePrice <= 0 || days < 1) return results;

  const base = new Decimal(basePrice);
  const factor = new Decimal(1).plus(new Decimal(ratePercent).div(100));

  for (let day = 1; day <= days; day++) {
    const price = base.mul(factor.pow(day));
    const cumulativePercent = new Decimal(100).mul(factor.pow(day).minus(1));
    results.push({
      day,
      price: roundTo(price.toNumber(), 3),
      changeRate: roundTo(ratePercent, 2),
      cumulativePercent: roundTo(cumulativePercent.toNumber(), 2),
      diff: roundTo(price.minus(base).toNumber(), 3),
    });
  }

  return results;
}

/**
 * 计算单笔交易（买入或卖出）的手续费。
 *
 * @description 中国 A 股规费规则：印花税（成交额 × 印花税率，仅卖出收取）；
 *              佣金（成交额 × 佣金率，免五则按 minCommission 兜底，不免五则强制最低 5 元）；
 *              过户费（成交额 × 过户费率，双向收取）。各项费用先各自四舍五入保留 2 位（分）再汇总。
 * @param {number} price - 成交单价（元/股）
 * @param {number} amount - 成交数量（股）
 * @param {'buy' | 'sell'} direction - 交易方向；卖出才计印花税
 * @param {FeeConfig} feeConfig - 全局费率配置
 * @returns {TradeFees} 单边规费拆解（stamp / commission / transfer / total，单位元）
 * @note 纯函数；所有中间计算使用 decimal.js，最终金额保留 2 位小数
 */
export function calcTradeFees(
  price: number,
  amount: number,
  direction: 'buy' | 'sell',
  feeConfig: FeeConfig,
  kind?: SecurityKind
): TradeFees {
  const resolved = resolveFeeConfig(feeConfig, kind ?? 'stock');
  const {
    commissionRate = 0.00025,
    isFreeFive = false,
    minCommission = 0.5,
    transferRate = 0.00001,
    stampRate = 0.0005,
  } = resolved;

  const turnover = new Decimal(price).mul(amount);

  // 印花税（仅卖出时收取）- 先四舍五入到分
  const stamp = direction === 'sell'
    ? turnover.mul(stampRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    : new Decimal(0);

  // 佣金 - 先四舍五入到分，再比较最低佣金
  let commission = turnover.mul(commissionRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (isFreeFive) {
    // 免五：使用自定义最低佣金配置
    if (commission.lt(minCommission)) {
      commission = new Decimal(minCommission).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }
  } else {
    // 不免五：强制最低 5 元
    if (commission.lt(5)) {
      commission = new Decimal(5);
    }
  }

  // 过户费 - 先四舍五入到分
  const transfer = turnover.mul(transferRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  // 各项费用已各自四舍五入，直接相加
  const total = stamp.plus(commission).plus(transfer);

  return {
    stamp: stamp.toNumber(),
    commission: commission.toNumber(),
    transfer: transfer.toNumber(),
    total: total.toNumber(),
  };
}

/**
 * 计算做T买卖双边的总摩擦成本（规费总和）。
 *
 * @description 分别计算买入与卖出单边规费后求和。
 * @param {number} buyPrice - 买入单价
 * @param {number} buyAmount - 买入数量
 * @param {number} sellPrice - 卖出单价
 * @param {number} sellAmount - 卖出数量
 * @param {FeeConfig} feeConfig - 全局费率配置
 * @returns {RoundTripFees} 包含 buyFee / sellFee 明细与 totalFee 合计
 */
export function calcRoundTripFees(
  buyPrice: number,
  buyAmount: number,
  sellPrice: number,
  sellAmount: number,
  feeConfig: FeeConfig
): RoundTripFees {
  const buyFee = calcTradeFees(buyPrice, buyAmount, 'buy', feeConfig);
  const sellFee = calcTradeFees(sellPrice, sellAmount, 'sell', feeConfig);
  return {
    buyFee,
    sellFee,
    totalFee: roundTo(buyFee.total + sellFee.total, 2),
  };
}

/**
 * 做T计算：正T（先买后卖）与倒T（先卖后买）
 *
 * 正T（加仓T）：
 *  - 买入占用资金 = 买入总成本 + 买入手续费
 *  - 保本卖出价 = (买入总成本 + 买入手续费 + 卖出手续费) / 买入数量
 *
 * 倒T（减仓T）：
 *  - 卖出释放资金 = 卖出净回款 = 卖出成交额 - 卖出手续费
 *  - 低位接回保本买入价 = (卖出净回款 - 买入手续费) / 买入数量
 */
export function calcTTrade(params: TTradeParams, feeConfig: FeeConfig): TTradeResult {
  const { mode, buyPrice, buyAmount, sellPrice, sellAmount } = params;

  const hasBuy = buyPrice > 0 && buyAmount > 0;
  const hasSell = sellPrice > 0 && sellAmount > 0;

  // 计算买卖手续费
  const buyFee = hasBuy ? calcTradeFees(buyPrice, buyAmount, 'buy', feeConfig) : null;
  const sellFee = hasSell ? calcTradeFees(sellPrice, sellAmount, 'sell', feeConfig) : null;

  const result: TTradeResult = {
    buyFee,
    sellFee,
    totalFee: null,
    isClosed: hasBuy && hasSell,
    netProfit: null,
    profitRate: null,
    capitalRequired: null,
    breakevenPrice: null,
    capitalReleased: null,
    buybackPrice: null,
    status: 'UNCLOSED',
  };

  // 总摩擦成本
  if (hasBuy && hasSell) {
    result.totalFee = roundTo(buyFee!.total + sellFee!.total, 2);
  } else if (hasBuy) {
    result.totalFee = buyFee!.total;
  } else if (hasSell) {
    result.totalFee = sellFee!.total;
  }

  if (hasBuy && hasSell) {
    // 已平仓 - 计算净利润
    const buyTotalCost = new Decimal(buyPrice).mul(buyAmount).plus(buyFee!.total);
    const sellNetReturn = new Decimal(sellPrice).mul(sellAmount).minus(sellFee!.total);
    const netProfit = sellNetReturn.minus(buyTotalCost);
    const totalInvest = buyTotalCost;
    result.netProfit = roundTo(netProfit.toNumber(), 2);
    result.profitRate = roundTo(
      netProfit.div(totalInvest).mul(100).toNumber(),
      2
    );
    result.status = 'CLOSED';
  }

  if (mode === 'long' && hasBuy) {
    // 正T：先买后卖
    const buyTotalCost = new Decimal(buyPrice).mul(buyAmount);
    result.capitalRequired = roundTo(buyTotalCost.plus(buyFee!.total).toNumber(), 2);

    // 保本卖出价
    if (hasSell) {
      const breakeven = buyTotalCost.plus(buyFee!.total).plus(sellFee!.total).div(buyAmount);
      result.breakevenPrice = roundTo(breakeven.toNumber(), 3);
    } else {
      // 仅买入，按买入价估算卖出手续费
      const estimatedSellFee = calcTradeFees(buyPrice, buyAmount, 'sell', feeConfig);
      const breakeven = buyTotalCost.plus(buyFee!.total).plus(estimatedSellFee.total).div(buyAmount);
      result.breakevenPrice = roundTo(breakeven.toNumber(), 3);
    }
  }

  if (mode === 'short' && hasSell) {
    // 倒T：先卖后买
    const sellTotal = new Decimal(sellPrice).mul(sellAmount);
    result.capitalReleased = roundTo(sellTotal.minus(sellFee!.total).toNumber(), 2);

    // 保本接回价
    if (hasBuy) {
      const buyback = sellTotal.minus(sellFee!.total).minus(buyFee!.total).div(buyAmount);
      result.buybackPrice = roundTo(buyback.toNumber(), 3);
    } else {
      // 仅卖出，估算买入手续费
      const estimatedBuyFee = calcTradeFees(sellPrice, sellAmount, 'buy', feeConfig);
      const buyback = sellTotal.minus(sellFee!.total).minus(estimatedBuyFee.total).div(sellAmount);
      result.buybackPrice = roundTo(buyback.toNumber(), 3);
    }
  }

  return result;
}

/**
 * 分批建仓成本摊薄计算。
 *
 * @description 在当前已持有成本基础上，叠加多笔新买入（价 × 量），
 *              返回累计总成本、总数量与摊薄后的平均成本价。
 * @param {Array<{ price: number; amount: number }>} buys - 新增买入批次列表（忽略非正价/量）
 * @param {number} [currentHoldCost=0] - 当前持仓成本价
 * @param {number} [currentHoldAmount=0] - 当前持仓数量
 * @returns {CostAveragingResult} { totalCost: 累计总成本, totalAmount: 累计数量, avgCost: 摊薄均价（3 位小数） }
 */
export function calcCostAveraging(
  buys: Array<{ price: number; amount: number }>,
  currentHoldCost: number = 0,
  currentHoldAmount: number = 0
): CostAveragingResult {
  let totalCost = new Decimal(currentHoldCost).mul(currentHoldAmount);
  let totalAmount = new Decimal(currentHoldAmount);

  for (const buy of buys) {
    if (buy.price > 0 && buy.amount > 0) {
      totalCost = totalCost.plus(new Decimal(buy.price).mul(buy.amount));
      totalAmount = totalAmount.plus(buy.amount);
    }
  }

  const avgCost = totalAmount.gt(0)
    ? totalCost.div(totalAmount).toDecimalPlaces(3).toNumber()
    : 0;

  return {
    totalCost: roundTo(totalCost.toNumber(), 2),
    totalAmount: totalAmount.toNumber(),
    avgCost,
  };
}

/**
 * 辅助函数：计算整手补仓结果
 */
function buildLotResult(
  currentCost: number,
  currentAmount: number,
  plannedPrice: number,
  lotAmount: number
): LotResult | null {
  if (lotAmount <= 0) return null;

  const cc = new Decimal(currentCost);
  const ca = new Decimal(currentAmount);
  const pp = new Decimal(plannedPrice);
  const la = new Decimal(lotAmount);

  const totalCost = cc.mul(ca).plus(pp.mul(la));
  const totalAmount = ca.plus(la);
  const actualCost = totalCost.div(totalAmount).toDecimalPlaces(3);
  const capital = pp.mul(la).toDecimalPlaces(2);

  return {
    amount: lotAmount,
    capital: capital.toNumber(),
    actualCost: actualCost.toNumber(),
  };
}

/**
 * 解套/补仓目标成本推算。
 *
 * @description 根据公式 needAmount = (currentCost - targetCost) × currentAmount / (targetCost - plannedPrice)
 *              推算理论补仓数量，并输出精确值、向下/向上整手方案与建议文案。
 * @param {number} currentCost - 当前持仓成本价
 * @param {number} currentAmount - 当前持仓数量（须为 100 整数倍）
 * @param {number} plannedPrice - 计划补仓单价
 * @param {number} targetCost - 期望摊薄后的目标成本价
 * @returns {TargetCostResult} 含理论需补数量/资金、精确与整手方案、建议列表；无解时返回空建议
 */
export function calcTargetCostAveraging(
  currentCost: number,
  currentAmount: number,
  plannedPrice: number,
  targetCost: number
): TargetCostResult {
  if (currentCost <= targetCost) {
    return {
      needAmount: 0,
      needCapital: 0,
      actualCost: currentCost,
      suggestions: ['当前成本已低于目标成本，无需补仓。'],
      exact: null,
      downLot: null,
      upLot: null,
    };
  }

  const cc = new Decimal(currentCost);
  const ca = new Decimal(currentAmount);
  const pp = new Decimal(plannedPrice);
  const tc = new Decimal(targetCost);

  // 公式：needAmount = (cc - tc) * ca / (tc - pp)
  const numerator = cc.minus(tc).mul(ca);
  const denominator = tc.minus(pp);

  if (denominator.lte(0)) {
    return {
      needAmount: 0,
      needCapital: 0,
      actualCost: currentCost,
      suggestions: ['补仓单价需低于目标成本价，才能有效摊薄。'],
      exact: null,
      downLot: null,
      upLot: null,
    };
  }

  const exactNeedAmount = numerator.div(denominator);

  // 精确结果（理论值）
  const exactAmount = exactNeedAmount.toNumber();
  const exactCapital = exactNeedAmount.mul(pp).toDecimalPlaces(2);
  const exactTotalCost = cc.mul(ca).plus(exactNeedAmount.mul(pp));
  const exactTotalAmount = ca.plus(exactNeedAmount);
  const exactActualCost = exactTotalAmount.gt(0)
    ? exactTotalCost.div(exactTotalAmount).toDecimalPlaces(3)
    : new Decimal(0);

  const exact: LotResult = {
    amount: exactNeedAmount.toNumber(),
    capital: exactCapital.toNumber(),
    actualCost: exactActualCost.toNumber(),
  };

  // 整手计算
  const lots = Math.ceil(exactNeedAmount.toNumber() / 100);
  const downLotAmount = Math.max(0, (lots - 1) * 100);
  const upLotAmount = lots * 100;

  // 向下整手
  const downLot = buildLotResult(currentCost, currentAmount, plannedPrice, downLotAmount);
  // 向上整手
  const upLot = buildLotResult(currentCost, currentAmount, plannedPrice, upLotAmount);

  const needAmount = exactNeedAmount.toDecimalPlaces(0, Decimal.ROUND_UP).toNumber();
  const needCapital = exactNeedAmount.toDecimalPlaces(0, Decimal.ROUND_UP).mul(pp).toDecimalPlaces(2);

  const suggestions: string[] = [];
  suggestions.push(`理论需补仓 ${exactNeedAmount.toDecimalPlaces(0).toNumber()} 股，所需资金约 ¥${needCapital.toNumber()}`);

  // A股整手建议
  if (lots * 100 !== needAmount) {
    suggestions.push(`建议整手下单 ${lots * 100} 股（约 ${lots} 手），需资金约 ¥${roundTo(lots * 100 * plannedPrice, 2)}`);
  }

  if (needAmount > currentAmount) {
    suggestions.push(`注：补仓数量 (${needAmount}股) 超过当前持仓 (${currentAmount}股)，请注意风险。`);
  }

  return {
    needAmount,
    needCapital: needCapital.toNumber(),
    actualCost: exactActualCost.toNumber(),
    suggestions,
    exact,
    downLot,
    upLot,
  };
}

/**
 * 计算费用明细（供实时测算表格展示）。
 *
 * @description 直接传入成交金额（turnover），按方向返回买入/卖出的规费拆解；
 *              口径与 calcTradeFees 完全一致。
 * @param {number} turnover - 成交金额（单价 × 数量）
 * @param {'buy' | 'sell'} direction - 交易方向
 * @param {FeeConfig} feeConfig - 全局费率配置
 * @returns {TradeFees} 规费拆解（stamp / commission / transfer / total）
 */
export function calcFeeBreakdown(
  turnover: number,
  direction: 'buy' | 'sell',
  feeConfig: FeeConfig,
  kind?: SecurityKind
): TradeFees {
  const resolved = resolveFeeConfig(feeConfig, kind ?? 'stock');
  const { commissionRate = 0.00025, isFreeFive = false, minCommission = 0.5, transferRate = 0.00001, stampRate = 0.0005 } = resolved;
  const tv = new Decimal(turnover);

  // 印花税（仅卖出）
  const stamp = direction === 'sell'
    ? tv.mul(stampRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    : new Decimal(0);

  // 佣金
  let commission = tv.mul(commissionRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (isFreeFive) {
    if (commission.lt(minCommission)) {
      commission = new Decimal(minCommission).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }
  } else {
    if (commission.lt(5)) {
      commission = new Decimal(5);
    }
  }

  // 过户费
  const transfer = tv.mul(transferRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  const total = stamp.plus(commission).plus(transfer);

  return {
    stamp: stamp.toNumber(),
    commission: commission.toNumber(),
    transfer: transfer.toNumber(),
    total: total.toNumber(),
  };
}

/**
 * 校验 A 股买入数量是否为 100 股的整数倍。
 *
 * @description 仅做合法性校验（正整数且 % 100 === 0），不涉及业务逻辑。
 * @param {number} value - 待校验股数
 * @returns {boolean} true 表示可下单的整手数量
 */
export function isValidLotSize(value: number): boolean {
  return value > 0 && value % 100 === 0;
}

/**
 * 格式化金额为人民币显示字符串。
 *
 * @description 使用 Intl.NumberFormat 格式化为带 ¥ 前缀、2 位小数的金额字符串。
 * @param {number} value - 金额数值
 * @returns {string} 格式化后的金额字符串，如 "¥1,234.56"
 */
export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
  }).format(value);
}

/**
 * 根据盈亏数值返回对应的 Tailwind CSS 颜色类名。
 *
 * @description 正数为绿色（盈利），负数为红色（亏损），零为灰色。
 * @param {number} value - 盈亏数值
 * @returns {string} Tailwind CSS 文本颜色类名
 */
export function pnlColor(value: number): string {
  if (value > 0) return 'text-emerald-400';
  if (value < 0) return 'text-rose-400';
  return 'text-slate-400';
}
