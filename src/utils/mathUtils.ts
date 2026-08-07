// ============================================================
// 核心金融计算工具函数
// 使用 decimal.js 处理浮点数精度
// 中国 A 股标准规费计算规则
// ============================================================
import Decimal from 'decimal.js';

// 设置 Decimal 精度（金融计算保留 20 位中间精度）
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export interface FeeConfig {
  commissionRate: number;
  isFreeFive: boolean;
  minCommission: number;
  transferRate: number;
  stampRate: number;
}

export interface TradeFees {
  stamp: number;
  commission: number;
  transfer: number;
  total: number;
}

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

export interface ContinuousLimitResult {
  day: number;
  upPrice: number;
  downPrice: number;
  upPercent: number;
  downPercent: number;
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
 * 四舍五入保留指定小数位数
 * 中国股市规费计算：单项规费各自先四舍五入保留2位小数（分），然后再相加汇总
 */
export function roundTo(value: number | string | Decimal, decimals: number = 2): number {
  return new Decimal(value).toDecimalPlaces(decimals).toNumber();
}

/**
 * 计算涨跌幅
 * @param basePrice 基准价格
 * @param targetPrice 目标价格
 * @returns percent 涨跌幅百分比, diff 涨跌值
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
 * 根据基准价格和百分比计算目标价格
 * @param basePrice 基准价格
 * @param percent 百分比（如 10 表示 +10%）
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
 * 计算连续涨/跌停天数（复利累计）
 * @param basePrice 基准价格
 * @param days 天数
 * @param limitPercent 涨跌幅限制百分比（如10表示±10%）
 */
export function calcContinuousLimits(
  basePrice: number,
  days: number,
  limitPercent: number = 10
): ContinuousLimitResult[] {
  const results: ContinuousLimitResult[] = [];
  const limit = new Decimal(limitPercent);

  for (let day = 1; day <= days; day++) {
    // 涨停价：连续按日复利 (1 + limit%)^day
    const upPrice = new Decimal(basePrice).mul(
      new Decimal(1).plus(limit.div(100)).pow(day)
    );

    // 跌停价：连续按日复利 (1 - limit%)^day
    const downPrice = new Decimal(basePrice).mul(
      new Decimal(1).minus(limit.div(100)).pow(day)
    );

    // 累计涨跌幅
    const upPercent = new Decimal(100).mul(
      new Decimal(1).plus(limit.div(100)).pow(day).minus(1)
    );
    const downPercent = new Decimal(-100).mul(
      new Decimal(1).minus(new Decimal(1).minus(limit.div(100)).pow(day))
    );

    results.push({
      day,
      upPrice: roundTo(upPrice.toNumber(), 2),
      downPrice: roundTo(downPrice.toNumber(), 2),
      upPercent: roundTo(upPercent.toNumber(), 2),
      downPercent: roundTo(downPercent.toNumber(), 2),
    });
  }

  return results;
}

/**
 * 计算单笔交易（买入或卖出）的手续费
 * 中国 A 股规费规则：
 *  - 印花税：成交金额的 0.05%，仅卖出时收取
 *  - 佣金：成交金额 × 佣金率，最低 5 元（免五则使用最低佣金配置）
 *  - 过户费：成交金额的 0.001%，买卖双向收取
 * 各项费用先各自四舍五入保留两位小数再汇总
 */
export function calcTradeFees(
  price: number,
  amount: number,
  direction: 'buy' | 'sell',
  feeConfig: FeeConfig
): TradeFees {
  const {
    commissionRate = 0.00025,
    isFreeFive = false,
    minCommission = 0.5,
    transferRate = 0.00001,
    stampRate = 0.0005,
  } = feeConfig || {};

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
 * 计算买卖双向的摩擦成本（规费总和）
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
 * 成本摊薄计算：多批次买入后的平均成本
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
 * 目标成本推算：解套/补仓计算
 * 包含整手对比逻辑（向下整手/向上整手）
 *
 * @param currentCost 当前持仓成本价
 * @param currentAmount 当前持仓数量（必须为100整数倍）
 * @param plannedPrice 计划补仓单价
 * @param targetCost 目标成本价
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
 * 计算费用明细（用于实时测算表格展示）
 * 直接传入成交金额，返回买入或卖出方向的费用拆解
 */
export function calcFeeBreakdown(
  turnover: number,
  direction: 'buy' | 'sell',
  feeConfig: FeeConfig
): TradeFees {
  const { commissionRate = 0.00025, isFreeFive = false, minCommission = 0.5, transferRate = 0.00001, stampRate = 0.0005 } = feeConfig;
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
 * 校验是否为 100 的整数倍
 */
export function isValidLotSize(value: number): boolean {
  return value > 0 && value % 100 === 0;
}
