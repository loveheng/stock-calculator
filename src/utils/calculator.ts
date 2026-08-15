/**
 * @file calculator.ts
 * @description 持仓统计与对冲（做T）核心算法：从批次履历重建持仓快照，
 *              采用「总资金抽回法 + 整轮/对冲对配法」计算动态保本单价、累计做T落袋利润
 *              与传统券商口径已实现盈亏。
 * @layer Utility
 * @storage_impact 纯计算模块，无任何 IndexedDB 读写，不产生副作用。
 * @author 开发团队
 */

import type { PositionBatchEntity, PositionEntity } from '../db/schema';

/**
 * `recalculatePosition` 的返回结构：一次重建后的持仓权威快照。
 *
 * @description 结构上满足 `Partial<PositionEntity>`，可直接与持仓实体合并后落库。
 */
export interface PositionSnapshot extends Partial<PositionEntity> {
  /** 动态保本单价（元）：currentAmount > 0 时为 totalInvested / currentAmount，否则为 0 */
  currentCost: number;
  /** 当前持有数量（股） */
  currentAmount: number;
  /** 是否已平仓：0 = 未平仓，1 = 已平仓 */
  isClosed: 0 | 1;
  /** 平仓时间戳（毫秒），未平仓时不返回 */
  closedAt?: number;
  /** 实际净投入现金（元） */
  totalInvested: number;
  /** 传统券商口径已实现盈亏（元） */
  realizedPnL: number;
  /** 累计做 T 落袋净利润（元，可为负）。采用整轮/对冲对配法：无论正T（先低吸买入后高抛卖出）
   *  还是倒T（先高抛卖出后低吸回补），完整一轮等量对冲后的落袋利润恰好等于
   *  该轮高抛卖出净回款 − 低吸买入总成本；未配对的底仓减仓按初始建仓均价结算 */
  accumulatedTPnL: number;
  /** 初始建仓均价（元）：底仓真实买入（open 与未被做T对配消耗的 add）按数量加权的含规费均价；
   *  做T轮次的低吸腿不参与刷新 */
  initialCost: number;
}

/**
 * 从批次履历重建持仓快照（持仓统计与做T对冲核心算法）。
 *
 * @description 采用「总资金抽回法 + 整轮/对冲对配法」按时间顺序遍历批次（内部先按 timestamp
 *              升序排序，与录入顺序无关）。做T轮次的买卖双腿都进入对冲台账，等量对冲后
 *              落袋利润统一结算为「高抛卖出净回款 − 低吸买入总成本」：
 *  - 正T（先低吸买入、后高抛卖出）：`add` 类型加仓在计入底仓均价的同时登记进「待高抛台账」
 *    （pendingLowQty/pendingLowCost）。后续卖出时优先与该台账对冲，整轮落袋 =
 *    「高抛净回款 − 低吸买入总成本」，并把对冲掉的买入腿从底仓均价成本中回冲（做T腿不计入
 *    底仓、不刷新 `initialCost`）。
 *  - 倒T（先高抛卖出、后低吸回补）：卖出时暂记「净回款 − 底仓初始均价 × 数量」进
 *    `accumulatedTPnL`，并登记进「待回补台账」（uncoveredQty）；买入时优先回补，补记低吸折让
 *    （`(initialCost − 回补价) × 数量 − 回补规费`），使整轮落袋恰好等于「高抛净回款 − 回补总成本」。
 *  - 未配对的底仓减仓按初始建仓均价结算；`realizedPnL` 仅在跌破底仓均价（真正的割肉亏损）时记账。
 *  - 保本单价：`currentCost = totalInvested / currentAmount`（纯现金流水口径，与做T对配无关）；
 *    股数为 0 或已平仓时为 0。
 *  - 平仓状态：当 `currentAmount` 归零时 `isClosed = 1` 并记录 `closedAt`（取清仓那笔的
 *    timestamp）、清空全部对冲台账（一轮做T周期结束，后续重新开仓不再按回补/对配结算）；
 *    后续再次买入则自动恢复未平仓并清除 `closedAt`。
 *
 * @param batches 持仓的完整批次履历。`type` 仅支持 'open' | 'add' | 'reduce'；
 *                `amount` 兼容正数（新增约定）与负数（存量约定，reduce 用负数），
 *                内部统一取绝对值并按 type/符号判定方向；`fee` 可缺省（按 0 处理）。
 * @returns 持仓快照（各字段均为按当前履历重算后的权威值）
 */
export function recalculatePosition(batches: PositionBatchEntity[]): PositionSnapshot {
  // 按成交时间升序处理，保证结果与录入顺序无关
  const sorted = [...batches].sort((a, b) => a.timestamp - b.timestamp);

  // ---- 累计状态 ----
  let currentAmount = 0; // 当前持有数量（股）
  let totalInvested = 0; // 实际净投入现金（元）
  let realizedPnL = 0; // 传统券商口径已实现盈亏（仅累计真正跌破底仓均价的割肉亏损）
  let accumulatedTPnL = 0; // 累计做T落袋利润（净额，可为负）
  let buyCostSum = 0; // 底仓纯买入成本累计（含规费），用于维护 initialCost
  let buyQtySum = 0; // 底仓纯买入数量累计
  let initialCost = 0; // 底仓建仓均价（元）：底仓真实买入（open 与未被做T对配消耗的 add）加权均价
  let uncoveredQty = 0; // 倒T「待回补台账」：已高抛、尚未低吸买回的数量
  let pendingLowQty = 0; // 正T「待高抛台账」：已低吸买入、等待高抛配对的数量
  let pendingLowCost = 0; // 正T「待高抛台账」对应买入总成本（含规费）
  let isClosed: 0 | 1 = 0; // 平仓标记
  let closedAt: number | undefined; // 平仓时间戳

  for (const batch of sorted) {
    // 数量统一取绝对值，兼容「reduce 用负数」与「统一用正数」两种录入约定
    const qty = Math.abs(batch.amount);
    if (qty <= 0) continue;
    const fee = batch.fee ?? 0;

    // 方向判定：type === 'reduce' 优先；异常数据按 amount 符号兜底
    const isSell = batch.type === 'reduce' || batch.amount < 0;

    if (isSell) {
      // ---- 减仓 / 做T卖出 ----
      if (currentAmount <= 0) continue; // 无持仓可卖，忽略异常批次
      // 防御：最多卖出当前持仓数量，避免产生负持仓
      const sellable = Math.min(qty, currentAmount);

      // ① 出借批次（倒T借仓卖出）：状态合并——出借当卖出看待，计入落袋利润。
      // kind 保留用于删除保护，不做正T对配/不登记待回补台账。
      if (batch.kind === 'borrow') {
        const unitFee = fee / sellable;
        const baseFee = unitFee * sellable;
        const costBasis = initialCost * sellable;
        const netProceeds = batch.price * sellable - baseFee;
        accumulatedTPnL += netProceeds - costBasis; // 出借当卖出，计入做T落袋利润
        totalInvested -= costBasis; // 按底仓成本抽回，非按卖出价
        currentAmount -= sellable;
        // 不做正T对配、不登记待回补台账
        if (currentAmount <= 0) {
          currentAmount = 0;
          totalInvested = 0;
          uncoveredQty = 0;
          pendingLowQty = 0;
          pendingLowCost = 0;
          isClosed = 1;
          closedAt = batch.timestamp;
        }
        continue;
      }

      const unitFee = fee / sellable;
      let remaining = sellable;

      // ② 正T对配：优先与「待高抛台账」中的低吸买入对冲。整轮落袋 = 高抛净回款 − 低吸总成本
      if (pendingLowQty > 0) {
        const paired = Math.min(remaining, pendingLowQty);
        const sellFee = unitFee * paired;
        const sellProceeds = batch.price * paired - sellFee; // 高抛卖出净回款（成交额 - 规费）
        const buyCostPaired = pendingLowCost * (paired / pendingLowQty); // 对应低吸买入总成本
        accumulatedTPnL += sellProceeds - buyCostPaired; // 整轮做T落袋利润
        totalInvested -= sellProceeds; // 抽回净现金
        currentAmount -= paired; // 扣减数量
        // 该低吸腿属于做T轮次而非底仓：从底仓均价成本中回冲，做T腿不刷新底仓均价
        buyCostSum -= buyCostPaired;
        buyQtySum -= paired;
        if (buyQtySum > 0) initialCost = buyCostSum / buyQtySum;
        pendingLowQty -= paired; // 销台账
        pendingLowCost -= buyCostPaired;
        remaining -= paired;
      }

      // ③ 剩余部分为底仓减仓（倒T候选）：暂记「净回款 − 底仓初始均价×数量」，
      //    登记进「待回补台账」等待低吸买回
      if (remaining > 0) {
        const baseFee = unitFee * remaining;
        const netProceeds = batch.price * remaining - baseFee;
        const costBasis = initialCost * remaining;
        const tProfit = netProceeds - costBasis;
        totalInvested -= netProceeds; // 抽回净现金
        currentAmount -= remaining; // 扣减数量
        accumulatedTPnL += tProfit; // 做T落袋利润（净额，可为负，暂记：若后续低吸回补再补记折让）
        uncoveredQty += remaining; // 登记待回补台账（等待后续买入配对）
        // 传统券商口径已实现盈亏：只在真正跌破底仓均价时记入（真正的割肉亏损）
        if (tProfit < 0) {
          realizedPnL += tProfit;
        }
      }

      if (currentAmount <= 0) {
        currentAmount = 0;
        totalInvested = 0; // 清仓后不再有资金沉淀在仓内
        uncoveredQty = 0; // 清仓即一轮做T周期结束，后续重新开仓不再按回补结算
        pendingLowQty = 0;
        pendingLowCost = 0;
        isClosed = 1;
        closedAt = batch.timestamp;
      }
    } else {
      // ---- 建仓 / 加仓（先回补未完成的高抛缺口，剩余才登记待高抛/底仓）----
      // ① 倒T回补：优先买回未完成的高抛缺口。卖出时已暂记「净回款 − 底仓均价×数量」，
      //    此处补记低吸折让，使整轮配对的落袋利润恰好 =「高抛净回款 − 回补总成本」。
      const buyBack = Math.min(qty, uncoveredQty);
      const buyBackFee = fee * (buyBack / qty); // 规费按数量比例分摊
      if (buyBack > 0) {
        accumulatedTPnL += (initialCost - batch.price) * buyBack - buyBackFee; // 补记低吸折让
        totalInvested += batch.price * buyBack + buyBackFee; // 回补资金真实流出
        currentAmount += buyBack; // 累加回补数量
        uncoveredQty -= buyBack; // 销台账
      }

      // ② 剩余为真实买入：计入底仓均价（initialCost）。type=add 的加仓同时登记进
      //    「待高抛台账」——后续若卖出 N 股，则按整轮/对冲对配计算做T落袋并回冲底仓成本；
      //    未配对的加仓仍属于底仓，维持加权均价。
      const addQty = qty - buyBack;
      if (addQty > 0) {
        const addFee = fee * (addQty / qty); // 余下规费
        const cost = batch.price * addQty + addFee;
        totalInvested += cost; // 累计投入现金（成交额 + 规费）
        currentAmount += addQty; // 累加数量
        buyCostSum += cost; // 底仓成本累计（待对配回冲）
        buyQtySum += addQty; // 底仓数量累计
        initialCost = buyCostSum / buyQtySum; // 底仓加权均价（含规费）
        if (batch.type === 'add') {
          pendingLowQty += addQty; // 登记待高抛台账（等待后续卖出配对）
          pendingLowCost += cost;
        }
      }
      isClosed = 0; // 重新开仓
      closedAt = undefined;
    }
  }

  const snapshot: PositionSnapshot = {
    currentCost: currentAmount > 0 ? totalInvested / currentAmount : 0,
    currentAmount,
    isClosed,
    totalInvested,
    realizedPnL,
    accumulatedTPnL,
    initialCost,
  };
  if (closedAt !== undefined) {
    snapshot.closedAt = closedAt;
  }

  return snapshot;
}
