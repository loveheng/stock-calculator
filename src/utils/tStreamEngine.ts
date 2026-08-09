/**
 * @file tStreamEngine.ts
 * @description 做T流水池核心撮合引擎：以「单边流水 + FIFO 双队列」模型执行
 *              正T/倒T 撮合，输出全市场持仓状态、P_avg、已实现盈亏、Round 生命周期汇总，
 *              并对外提供倒T首笔卖出的严格底仓校验。全程数据不可变（纯函数）。
 * @layer Utility
 * @storage_impact 纯计算引擎，不读写任何存储；但 Store 层（src/store/index.ts）会以
 *                 本引擎结果为准归档 tRounds 战报、调整 positions 底仓状态。
 * @author 开发团队
 */

// ============================================================
// 做T流水池核心撮合引擎（Round 生命周期 + 绝对现金流法）
// ------------------------------------------------------------
// 设计模型：
//  - 每笔交易流水 (TStreamRecord) 只记录单边方向：buy / sell
//  - 正做T = 先产生 buy 流水，后续 sell 流水与之 FIFO 撮合
//  - 倒做T = 先产生 sell 流水（受底仓限制），后续 buy 流水回补
//  - 同一股票维护两个队列：
//      longQueue  买入待对冲（买多未卖）
//      shortQueue 卖出待回补（倒T卖空未买回）
//  - 撮合规则：
//      buy  -> 优先与 shortQueue FIFO 配对（回补利润）
//              剩余进入 longQueue
//      sell -> 优先与 longQueue FIFO 配对（正T利润）
//              剩余进入 shortQueue（需通过底仓校验）
//
//  Round 生命周期：
//  - 以 fullCode 为一个做T项目；池从空 -> 非空 自动开启 Round X
//  - 池持仓归零（Holding_Quantity == 0）触发 Round 归档：
//      锁定战报（净收益/胜率/持股天数/交易笔数）-> 历史归档库 -> 重置池
//  - 池持仓归零后下一次买入自动开启 Round + 1
//
//  绝对现金流法（Transfer to Base Position）：
//  - 正T：P_avg = Σ(买入单价×买入数量) / Σ买入数量
//  - 倒T：P_avg = [(P_base×N_sell) + Σ(后续买入单价×数量)] / (N_sell + Σ后续买入数量)
//          （倒T首笔卖出将底仓持仓均价 P_base × 卖出数量 N_sell 并入 P_avg 加权计算池）
//  - 归档净收益 = Σ((卖出单价 - P_avg)×卖出数量) - 系统计算总规费
//  - 剩余持仓按 P_avg 平价划转入底仓，做T持仓归零触发归档
// ============================================================
import Decimal from 'decimal.js';
import { calcTradeFees, roundTo, type FeeConfig } from './mathUtils';
import type { StockSearchItem } from '../types/stock';

// ---- 流水池流水 ----
export interface TStreamRecord {
  id: string;
  /** 时间戳（ISO 或 'YYYY-MM-DD HH:mm'），撮合按此自早至晚 FIFO 排序 */
  timestamp: string;
  /** 完整证券代码（含市场前缀，如 sh601318），作为流水池唯一主键 */
  fullCode: string;
  stockName: string;
  /** 交易方向 */
  direction: 'buy' | 'sell';
  price: number;
  /** 正数股数 */
  amount: number;
  /** 单边规费快照（保存时计算；每次级联重算会用系统 feeConfig 重算以联动费率） */
  fee: number;
  note?: string;
  quoteId?: string;
  selectedStock?: StockSearchItem;
  /** 倒T首笔卖出时已从底仓扣减数量 */
  baseDeductedAmount?: number;
}

// ---- 单笔流水的撮合状态 ----
export interface StreamEntry {
  id: string;
  timestamp: string;
  direction: 'buy' | 'sell';
  price: number;
  amount: number;
  /** 重算后的单边规费 */
  fee: number;
  /** 该笔与对方队列撮合（对冲掉）的数量 */
  matchedAmount: number;
  /** 该笔贡献的已实现盈亏（FIFO 口径：买入流水撮合=溢价利润；卖出流水撮合=价差利润） */
  realizedProfit: number;
  /** 该笔买入流水剩余待对冲数量（卖出流水恒为 0） */
  remaining: number;
  /** 是否完全结清（待对冲数量归零） */
  closed: boolean;
  /** 备注 */
  note?: string;
}

export type StreamStatus = 'PENDING' | 'PARTIAL' | 'CLEARED' | 'SHORT_PENDING';

// ---- 单只股票的流水池撮合结果 ----
export interface StockStreamResult {
  fullCode: string;
  stockName: string;
  /** 累计已实现做T净收益（FIFO 精确撮合，实时口径） */
  realizedPnL: number;
  /** 累计已实现摩擦成本（已完成撮合的买卖规费） */
  realizedFee: number;
  /** 当前待对冲持仓量（longQueue 总量 - shortQueue 总量） */
  netPendingAmount: number;
  /** 待对冲加权买入价（Σ价×量 / Σ量，不含费）—— 严格按需求公式 */
  weightedBuyCost: number;
  /** 待对冲加权买入总成本（含买入规费） */
  pendingTotalCost: number;
  /** 待对冲数量中正在等待回补的卖出量（倒T裸卖量） */
  shortPendingAmount: number;
  /** 倒T首笔裸卖数量（作为归档恢复底仓的基准） */
  initialShortSellQty?: number;
  /** 该 Round 模式：正T / 倒T */
  mode: 'long' | 'short';
  /** 状态：完全结清 | 部分对冲 (剩余X股) | 待对冲 | 倒T待回补 */
  status: StreamStatus;
  /** 该股票全部流水（按时间戳自早至晚有序） */
  entries: StreamEntry[];
  /** 最近一次卖出后的剩余待对冲量（用于持仓清零 Toast 判断） */
  lastSellRemaining: number;
  /** 最近一次卖出后是否完全结清（用于持仓清零 Toast 判断） */
  lastSellCleared: boolean;
  lastClosedAt?: string;

  // ================= Round 生命周期汇总（绝对现金流法） =================
  /** 本 Round 是否已开启（池内有流水） */
  roundStarted: boolean;
  /** 本 Round 开启时间（第一笔流水时间戳） */
  openedAt?: string;
  /** 本 Round 加权均价 P_avg：正T = Σ(买入单价×买入数量)/Σ买入数量；
   * 倒T（先卖后买）= [(P_base×N_sell) + Σ(后续买入单价×数量)] / (N_sell + Σ后续买入数量)，底仓成本并入加权池 */
  avgPrice: number;
  /** 本 Round 总买入数量 */
  buyAmount: number;
  /** 本 Round 总买入金额 */
  buyTotal: number;
  /** 本 Round 总卖出数量（含未回补裸卖） */
  sellAmount: number;
  /** 本 Round 总卖出金额 */
  sellValue: number;
  /** 已对冲卖出数量（已实现的卖出） */
  realizedSellAmount: number;
  /** 已对冲卖出金额 */
  realizedSellValue: number;
  /** 本 Round 已发生总规费（系统费率实时联动重算） */
  totalFee: number;
  /** 绝对现金流法净收益 = Σ(已对冲卖价×卖量) - P_avg×已对冲卖量 - 总规费 */
  transferProfit: number;
  /** 本 Round 全部卖出按各自成本基准（倒T首卖=P_base，其余=P_avg）计算的成本总额 */
  sellCostTotal: number;
  /** 已实现（已对冲）卖出的成本基准总额 */
  realizedSellCost: number;
  /** 倒T首笔卖出继承的底仓持仓均价 P_base（仅当 Round 以倒T首卖开启且有底仓成本时） */
  firstSellCostBasis?: number;
  /** 倒T成本继承：并入 P_avg 加权计算池的底仓卖出数量 N_sell */
  inheritedBaseAmount?: number;
  /** 交易笔数 */
  tradeCount: number;
  /** 持股天数（开启至最后交易，至少 1 天） */
  holdingDays: number;
}

// ---- 超卖校验结果 ----
export interface SellValidation {
  valid: boolean;
  /** 当前最大可卖数量 */
  maxSellable: number;
  error?: string;
  /** 倒T首笔卖出时是否因缺少底仓持仓而校验失败 */
  missingPosition?: boolean;
  /** 是否为倒T首笔卖出（触发严格底仓校验） */
  isFirstSell?: boolean;
}

/**
 * 按时间戳比较两条流水先后顺序（FIFO 排序回调）。
 *
 * @description 先比较时间戳毫秒值（NaN 视为最早/最晚兜底），保证排序稳定唯一。
 * @param {string} a - 第一条流水时间戳
 * @param {string} b - 第二条流水时间戳
 * @returns {number} 负数表示 a 更早；0 相等；正数表示 b 更早
 * @note 纯函数；供 processStockStream 内部对流水按时间序撮合使用
 */
export function compareByTimestamp(a: string, b: string): number {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta)) return -1;
  if (Number.isNaN(tb)) return 1;
  return ta - tb;
}

/**
 * 持股天数：自开启至结束（至少 1 天）
 */
function calcHoldingDays(open: string | undefined, close: string | undefined): number {
  if (!open || !close) return 0;
  const o = new Date(open).getTime();
  const c = new Date(close).getTime();
  if (Number.isNaN(o) || Number.isNaN(c)) return 0;
  return Math.max(1, Math.ceil((c - o) / 86400000));
}

/**
 * 计算单只股票的流水池撮合结果（Round 引擎核心）。
 *
 * @description 将全部流水按时间序 FIFO 撮合：buy 优先回补 shortQueue，剩余进 longQueue；
 *              sell 优先对冲 longQueue，剩余进 shortQueue（受底仓数量约束）。
 *              维护每笔流水的 matchedAmount / realizedProfit / remaining，
 *              输出 P_avg（绝对现金流法）、transferProfit、持股天数与 Round 状态机。
 * @param {TStreamRecord[]} records - 该标的全部流水（任意顺序，内部按时间戳排序）
 * @param {FeeConfig} feeConfig - 全局费率配置（每次级联重算联动最新费率）
 * @param {number} [baseCost] - 底仓持仓均价 P_base（供倒T首笔卖出并入 P_avg 加权池）
 * @returns {StockStreamResult} 撮合结果（持仓状态、P_avg、已实现盈亏、Round 汇总等）
 * @note 纯函数；不修改入参 records，不写任何存储
 */
export function processStockStream(
  records: TStreamRecord[],
  feeConfig: FeeConfig,
  baseCost?: number
): StockStreamResult {
  const sorted = [...records].sort((a, b) => compareByTimestamp(a.timestamp, b.timestamp));

  // 待对冲买入队列：FIFO 槽位，amount 为剩余未对冲数量
  // 加权成本：总成本（含买入规费）/ 总数量的精确值，用 Decimal 保持
  const longQueue: Array<{
    id: string;
    timestamp: string;
    price: number;
    amount: number;
    fee: number;
    totalCost: Decimal; // Σ(价×量) + 买入规费
    totalAmount: number;
    note?: string;
  }> = [];

  // 待回补卖出队列（倒T裸卖）：slot 记录卖出价与净回款
  const shortQueue: Array<{
    id: string;
    timestamp: string;
    price: number;
    amount: number; // 待回补数量
    fee: number;
    netProceeds: Decimal; // 卖出总额 - 卖出规费
    note?: string;
  }> = [];

  const entries: StreamEntry[] = [];
  let realizedPnL = 0;
  let realizedFee = 0;
  let totalFeeAccumulated = 0; // 全部已产生流水规费（含未撮合部分）
  let lastSellRemaining = 0;
  let lastSellCleared = false;
  let lastClosedAt: string | undefined;
  // ---- 倒T首卖成本继承：第一笔卖出使用底仓持仓均价 P_base 作为对冲成本基准 ----
  let firstSellId: string | undefined;

  // ---- 倒T底仓成本并入 P_avg 加权计算池 ----
  // 倒T（先卖后买）：首笔卖出时把 (P_base × N_sell) 作为初始基准填入 P_avg 池，
  // 后续买入按标准公式平滑合成：
  //   P_avg = [(P_base × N_sell) + Σ(后续买入单价 × 后续买入数量)] / (N_sell + Σ后续买入数量)
  let inheritedBaseQty = 0;
  let inheritedBaseTotal = 0;
  let initialShortSellQty = 0;
  if (
    sorted.length > 0 &&
    sorted[0].direction === 'sell' &&
    baseCost !== undefined &&
    baseCost > 0
  ) {
    const firstBuyIndex = sorted.findIndex((r) => r.direction === 'buy');
    const shortSlice = firstBuyIndex === -1 ? sorted : sorted.slice(0, firstBuyIndex);
    initialShortSellQty = shortSlice.reduce((sum, r) => sum + (r.direction === 'sell' ? r.amount : 0), 0);
    inheritedBaseQty = initialShortSellQty;
    inheritedBaseTotal = baseCost * inheritedBaseQty;
  }

  // ---- Round 汇总累加器 ----
  let openedAt: string | undefined;
  let buyAmount = 0;
  let buyTotal = 0;
  let sellAmount = 0;
  let sellValue = 0;
  let realizedSellAmount = 0;
  let realizedSellValue = 0;
  let tradeCount = 0;

  for (let i = 0; i < sorted.length; i++) {
    const rec = sorted[i];
    if (openedAt === undefined) openedAt = rec.timestamp;
    tradeCount += 1;

    // ---- 动态读取系统费率重算本笔规费（保证费率变更即时联动） ----
    const feeCalc = calcTradeFees(rec.price, rec.amount, rec.direction, feeConfig);
    const fee = roundTo(feeCalc.total, 2);
    totalFeeAccumulated += fee;

    if (rec.direction === 'buy') {
      buyAmount += rec.amount;
      buyTotal += rec.price * rec.amount;

      // ======== 买入 ========
      let toMatch = rec.amount;
      let matched = 0;
      let realized = 0;

      // 1) 优先对冲 shortQueue（倒T回补：卖价已固定，低买赚差价）
      while (toMatch > 0 && shortQueue.length > 0) {
        const slot = shortQueue[0];
        const take = Math.min(slot.amount, toMatch);

        // 倒T利润 = 卖出净回款 - 买入总额 - 买入规费(分摊)
        const sellNetShare = slot.netProceeds.mul(take).div(slot.amount);
        const buyTotal = new Decimal(rec.price).mul(take).plus(
          new Decimal(fee).mul(take).div(rec.amount)
        );
        realized += sellNetShare.minus(buyTotal).toNumber();

        slot.amount -= take;
        matched += take;
        toMatch -= take;
        if (slot.amount <= 0) shortQueue.shift();
      }

      // 2) 剩余进入 longQueue
      if (toMatch > 0) {
        const buyTurnover = new Decimal(rec.price).mul(toMatch);
        longQueue.push({
          id: rec.id,
          timestamp: rec.timestamp,
          price: rec.price,
          amount: toMatch,
          fee: new Decimal(fee).mul(toMatch).div(rec.amount).toNumber(),
          totalCost: buyTurnover.plus(new Decimal(fee).mul(toMatch).div(rec.amount)),
          totalAmount: toMatch,
          note: rec.note,
        });
      }

      entries.push({
        id: rec.id,
        timestamp: rec.timestamp,
        direction: 'buy',
        price: rec.price,
        amount: rec.amount,
        fee,
        matchedAmount: matched,
        realizedProfit: roundTo(realized, 2),
        remaining: toMatch,
        closed: toMatch === 0,
        note: rec.note,
      });
    } else {
      // 倒T首笔卖出：Round 第一条流水即卖出（先卖后买），继承底仓持仓均价为对冲成本基准
      if (i === 0) firstSellId = rec.id;
      sellAmount += rec.amount;
      sellValue += rec.price * rec.amount;

      // ======== 卖出 ========
      let toMatch = rec.amount;
      let matched = 0;
      let realized = 0;

      // 1) 优先对冲 longQueue（正T：卖回买入仓位赚差价）
      while (toMatch > 0 && longQueue.length > 0) {
        const slot = longQueue[0];
        const take = Math.min(slot.amount, toMatch);

        // 正T利润 = 卖出总额(分摊) - 买入加权总成本(含买入规费) - 卖出规费(分摊)
        const sellTotal = new Decimal(rec.price).mul(take);
        const sellFeeShare = new Decimal(fee).mul(take).div(rec.amount);
        const buyCostShare = slot.totalCost.mul(take).div(slot.totalAmount);
        realized += sellTotal.minus(sellFeeShare).minus(buyCostShare).toNumber();

        slot.amount -= take;
        // 从加权池中按比例扣减总成本，保持剩余加权成本精确
        slot.totalCost = slot.totalCost.mul(slot.amount).div(slot.totalAmount);
        slot.totalAmount = take <= slot.totalAmount ? slot.amount : 0;
        matched += take;
        toMatch -= take;
        if (slot.amount <= 0) longQueue.shift();
      }

      // 已对冲卖出（匹配上的部分）计入绝对现金流已实现
      if (matched > 0) {
        realizedSellAmount += matched;
        realizedSellValue += rec.price * matched;
      }

      // 2) 剩余进入 shortQueue（倒T裸卖，待回补；需底仓校验由 UI 层执行）
      if (toMatch > 0) {
        shortQueue.push({
          id: rec.id,
          timestamp: rec.timestamp,
          price: rec.price,
          amount: toMatch,
          fee: new Decimal(fee).mul(toMatch).div(rec.amount).toNumber(),
          netProceeds: new Decimal(rec.price).mul(toMatch).minus(
            new Decimal(fee).mul(toMatch).div(rec.amount)
          ),
          note: rec.note,
        });
      }

      entries.push({
        id: rec.id,
        timestamp: rec.timestamp,
        direction: 'sell',
        price: rec.price,
        amount: rec.amount,
        fee,
        matchedAmount: matched,
        realizedProfit: roundTo(realized, 2),
        remaining: 0,
        closed: true,
        note: rec.note,
      });

      // 记录最近一次卖出后的对冲池状态（用于持仓清零 Toast 判断）
      lastSellRemaining = longQueue.reduce((s, q) => s + q.amount, 0) - shortQueue.reduce((s, q) => s + q.amount, 0);
      lastSellCleared = longQueue.length === 0 && shortQueue.length === 0;
      if (lastSellCleared) lastClosedAt = rec.timestamp;
    }
  }

  // ---- 汇总 ----
  const longTotal = longQueue.reduce((s, q) => s + q.amount, 0);
  const shortTotal = shortQueue.reduce((s, q) => s + q.amount, 0);
  const netPendingAmount = longTotal - shortTotal;

  // 待对冲加权买入价 = Σ(买价×买量) / Σ买量（不含规费，严格按需求公式——池内剩余）
  const weightedBuyCost = longTotal > 0
    ? roundTo(
        longQueue.reduce((s, q) => s + q.price * q.amount, 0) / longTotal,
        3
      )
    : 0;

  // 待对冲加权总成本（含买入规费，用于归档沉淀）
  const pendingTotalCost = roundTo(
    longQueue.reduce((s, q) => s + q.totalCost.toNumber(), 0),
    2
  );

  // 已实现规费：全部流水规费 - 当前未撮合池子中沉淀的规费
  const pendingBuyFee = longQueue.reduce((s, q) => s + q.fee, 0);
  const pendingSellFee = shortQueue.reduce((s, q) => s + q.fee, 0);
  realizedFee = roundTo(totalFeeAccumulated - pendingBuyFee - pendingSellFee, 2);

  // ---- Round 绝对现金流汇总 ----
  // 统一 P_avg：
  //  - 正T：仅按买入流水加权
  //  - 倒T：初始基准 = 底仓成本 (P_base × N_sell) 并入加权池，与后续买入平滑合成
  const effectiveBuyAmount = buyAmount + inheritedBaseQty;
  const effectiveBuyTotal = buyTotal + inheritedBaseTotal;
  const avgPrice = effectiveBuyAmount > 0 ? effectiveBuyTotal / effectiveBuyAmount : 0; // P_avg
  // 倒T成本继承：底仓成本 (P_base × N_sell) 已并入 P_avg 加权池，
  // 故本 Round 全部卖出（含倒T首卖）统一使用融合后的 P_avg 作为对冲成本基准结算。
  let sellCostTotal = 0; // Σ(P_avg × 卖出数量)
  let realizedSellCost = 0; // Σ(P_avg × 已对冲卖出数量)
  for (const e of entries) {
    if (e.direction !== 'sell') continue;
    sellCostTotal += avgPrice * e.amount;
    realizedSellCost += avgPrice * e.matchedAmount;
  }
  // 归档净收益 = Σ((卖出单价 - 成本基准)×卖出数量) - 系统计算总规费(已实现部分)
  //  - realizedFee = 全部流水规费 - 未对冲池内沉淀规费 = 与已对冲撮合相关的规费
  //  - 场景一（纯买入转底仓，无卖出）：sellValue=0 -> 收益 0 - 0 = 0 ✅
  //  - 场景二（卖200@12，P_avg=10.25）：2400-2050=350 -> 350 - 规费 ✅
  //  - 场景三（倒T首卖100@12 继承 P_base=10，未买回）：P_avg=10 -> 1200-1000=200 -> 200 - 规费 ✅
  const transferProfit = roundTo(
    sellValue - sellCostTotal - realizedFee,
    2
  );
  const holdingDays = calcHoldingDays(openedAt, lastClosedAt ?? sorted[sorted.length - 1]?.timestamp);

  let status: StreamStatus = 'PENDING';
  if (entries.length === 0) {
    status = 'PENDING';
  } else if (longQueue.length === 0 && shortQueue.length === 0) {
    status = 'CLEARED';
  } else if (longTotal > 0 && shortTotal === 0) {
    // 有买多未卖：是否存在过一次卖出后剩余 -> 部分对冲
    const hasMatchedSell = entries.some(
      (e) => e.direction === 'sell' && e.matchedAmount > 0
    );
    status = hasMatchedSell ? 'PARTIAL' : 'PENDING';
  } else if (shortTotal > 0) {
    status = 'SHORT_PENDING';
  } else {
    status = 'PENDING';
  }

  return {
    fullCode: sorted[0]?.fullCode ?? '',
    stockName: sorted[0]?.stockName ?? '未命名',
    realizedPnL: roundTo(realizedPnL, 2),
    realizedFee,
    netPendingAmount,
    weightedBuyCost,
    pendingTotalCost,
    shortPendingAmount: shortTotal,
    initialShortSellQty: initialShortSellQty > 0 ? initialShortSellQty : undefined,
    mode: sorted[0]?.direction === 'sell' ? 'short' : 'long',
    status,
    entries,
    lastSellRemaining,
    lastSellCleared,
    lastClosedAt,

    // ---- Round 汇总 ----
    roundStarted: sorted.length > 0,
    openedAt,
    avgPrice: roundTo(avgPrice, 3),
    buyAmount,
    buyTotal: roundTo(buyTotal, 2),
    sellAmount,
    sellValue: roundTo(sellValue, 2),
    realizedSellAmount,
    realizedSellValue: roundTo(realizedSellValue, 2),
    totalFee: roundTo(totalFeeAccumulated, 2),
    transferProfit,
    sellCostTotal: roundTo(sellCostTotal, 2),
    realizedSellCost: roundTo(realizedSellCost, 2),
    firstSellCostBasis:
      firstSellId && baseCost !== undefined && baseCost > 0
        ? roundTo(baseCost, 3)
        : undefined,
    inheritedBaseAmount: inheritedBaseQty > 0 ? inheritedBaseQty : undefined,
    tradeCount,
    holdingDays,
  };
}

/**
 * 处理全市场所有股票的流水池（级联重算入口）。
 *
 * @description 按 fullCode（兜底 stockName）分组后逐个调用 processStockStream，
 *              并按每只股票最新流水时间戳降序返回（最新在前）。
 * @param {TStreamRecord[]} records - 全市场流水
 * @param {FeeConfig} feeConfig - 全局费率配置
 * @param {Map<string, number>} [baseCosts] - 底仓均价映射：fullCode → P_base
 * @returns {StockStreamResult[]} 各标的撮合结果数组（按最新流水时间降序）
 * @note 纯函数；供 useStreamResults Hook 在流水/费率/持仓任一变化时全量重算
 */
export function processAllStreams(
  records: TStreamRecord[],
  feeConfig: FeeConfig,
  baseCosts?: Map<string, number>
): StockStreamResult[] {
  const byStock = new Map<string, TStreamRecord[]>();
  for (const rec of records) {
    const key = rec.fullCode || rec.stockName || '未命名';
    const list = byStock.get(key);
    if (list) list.push(rec);
    else byStock.set(key, [rec]);
  }
  const results: StockStreamResult[] = [];
  for (const [key, list] of byStock) {
    results.push(processStockStream(list, feeConfig, baseCosts?.get(key)));
  }
  // 按最新流水时间降序展示
  return results.sort((a, b) => {
    const ta = new Date(a.entries[a.entries.length - 1]?.timestamp ?? 0).getTime();
    const tb = new Date(b.entries[b.entries.length - 1]?.timestamp ?? 0).getTime();
    return tb - ta;
  });
}

/**
 * 超卖拦截校验
 * @param stream 该股票流水池撮合结果（可为 null）
 * @param basePositionAmount 系统底仓/主持仓现有持仓量（来自持仓账本）
 * @param direction 待提交方向
 * @param amount 待提交数量
 * @param price 待提交价格（校验 > 0）
 *
 * 规则：
 *  - 买入数量、价格必须 > 0
 *  - 卖出（平仓回补任意方向）：卖出数量不能大于当前最大可卖
 *    最大可卖 = 当前待对冲持仓量 + 底仓持仓量
 *    （正T：待对冲买入量；倒T：底仓持仓量；两者叠加允许倒T先卖底仓、正T卖回已买仓位）
 */
export function validateStreamTrade(
  stream: StockStreamResult | null,
  basePositionAmount: number,
  direction: 'buy' | 'sell',
  price: number,
  amount: number,
  isFirstSell?: boolean
): SellValidation {
  // 价格与数量必须 > 0
  if (!price || price <= 0 || !amount || amount <= 0) {
    return {
      valid: false,
      maxSellable: 0,
      error: '买卖数量和价格必须大于 0',
    };
  }

  if (direction === 'buy') {
    return { valid: true, maxSellable: 0 };
  }

  // ---- 倒T首笔卖出：严格底仓校验（先卖后买，Round 尚无该标的流水） ----
  const firstSell = isFirstSell ?? !stream;
  if (firstSell) {
    const baseHolding = Math.max(0, basePositionAmount);
    // 1) 标的存在性校验：持仓/成本摊薄账本中必须存在该标的
    if (baseHolding <= 0) {
      return {
        valid: false,
        maxSellable: 0,
        missingPosition: true,
        isFirstSell: true,
        error: '您没有该标的的持仓，无法进行倒 T 操作',
      };
    }
    // 2) 持仓数量校验：卖出数量不能超过底仓可用数量 N_base
    if (amount > baseHolding) {
      return {
        valid: false,
        maxSellable: baseHolding,
        isFirstSell: true,
        error: `卖出数量超过最大可卖数量（当前最大可卖: ${baseHolding} 股）`,
      };
    }
    return { valid: true, maxSellable: baseHolding, isFirstSell: true };
  }

  // ---- 后续卖出：正常校验（待对冲持仓 + 底仓） ----
  const pending = Math.max(0, stream?.netPendingAmount ?? 0);
  const baseHolding = Math.max(0, basePositionAmount);
  const maxSellable = pending + baseHolding;

  if (amount > maxSellable) {
    return {
      valid: false,
      maxSellable,
      error: `卖出数量不能大于当前持有数量（最大可卖: ${maxSellable} 股）`,
    };
  }
  return { valid: true, maxSellable };
}
