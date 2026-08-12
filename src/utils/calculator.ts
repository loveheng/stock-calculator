/**
 * @file calculator.ts
 * @description 持仓统计与对冲（做T）核心算法：从批次履历重建持仓快照，
 *              采用「总资金抽回法 + 初始建仓均价基准」计算动态保本单价、累计做T落袋利润
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
  /** 累计做 T 落袋净利润（元，可为负）。完整一轮「高抛→低吸回补」配对后，恰好等于
   *  该轮高抛净拿回现金 − 回补总成本；未回补的减仓部分按初始建仓均价结算 */
  accumulatedTPnL: number;
  /** 初始建仓均价（元）：真实加仓（非回补）按数量加权的含规费均价，低吸回补不刷新 */
  initialCost: number;
}

/**
 * 从批次履历重建持仓快照（持仓统计与做T对冲核心算法）。
 *
 * @description 采用「总资金抽回法 + 整轮配对台账」按时间顺序遍历批次（内部先按 timestamp
 *              升序排序，与录入顺序无关）：
 *  - 卖出（reduce）：`currentAmount` 扣减成交数量；`totalInvested` 扣除卖出收回的净现金
 *    （成交额 - 规费），并把卖出数量登记进「待回补台账」（uncoveredQty）。做T收益暂记
 *    「净拿回现金 - 对应股数 × `initialCost`」进 `accumulatedTPnL`。传统券商口径的
 *    `realizedPnL` 仅在本次卖出确实跌破初始建仓均价（真正的割肉亏损）时才记账。
 *  - 买入（open/add）：优先回补未完成的高抛缺口 —— 对回补部分补记低吸折让
 *    （`(initialCost - 回补价) × 数量 - 回补规费`）进 `accumulatedTPnL`，使完整一轮
 *    配对的落袋利润恰好等于「高抛净拿回现金 - 回补总成本」；回补不刷新 `initialCost`。
 *    剩余部分才是真实加仓：`currentAmount` 累加数量、`totalInvested` 累加「成交额 + 规费」，
 *    并刷新 `initialCost`（真实加仓加权均价）。
 *  - 保本单价：`currentCost = totalInvested / currentAmount`；股数为 0 或已平仓时为 0。
 *  - 平仓状态：当 `currentAmount` 归零时 `isClosed = 1` 并记录 `closedAt`（取清仓那笔的
 *    timestamp）、清空待回补台账（一轮做T周期结束，后续重新开仓不再按回补结算）；
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
  let realizedPnL = 0; // 传统券商口径已实现盈亏（仅累计真正跌破初始均价的割肉亏损）
  let accumulatedTPnL = 0; // 累计做T落袋利润（净额，可为负）
  let buyCostSum = 0; // 纯买入动作成本累计（含规费），用于维护 initialCost
  let buyQtySum = 0; // 纯买入动作数量累计
  let initialCost = 0; // 初始建仓均价（元）：真实加仓（非回补）加权均价
  let uncoveredQty = 0; // 待回补台账：已高抛、尚未被买入回补的数量（整轮配对核心）
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
      // 本次卖出净拿回现金（成交额 - 规费）
      const netProceeds = batch.price * sellable - fee;
      // 对应股数的初始建仓成本
      const costBasis = initialCost * sellable;
      // 做T收益：净拿回现金 - 初始建仓成本（低吸高抛的中间卖出据此不再被强行记为割肉亏损）
      const tProfit = netProceeds - costBasis;

      totalInvested -= netProceeds; // 抽回净现金
      currentAmount -= sellable; // 扣减数量
      accumulatedTPnL += tProfit; // 做T落袋利润（净额，可为负，暂记：若后续低吸回补再补记折让）
      uncoveredQty += sellable; // 登记待回补台账（等待后续买入配对）

      // 传统券商口径已实现盈亏：只在真正跌破初始建仓均价时记入（真正的割肉亏损）
      if (tProfit < 0) {
        realizedPnL += tProfit;
      }

      if (currentAmount <= 0) {
        currentAmount = 0;
        totalInvested = 0; // 清仓后不再有资金沉淀在仓内
        uncoveredQty = 0; // 清仓即一轮做T周期结束，后续重新开仓不再按回补结算
        isClosed = 1;
        closedAt = batch.timestamp;
      }
    } else {
      // ---- 建仓 / 加仓（先回补未完成的高抛缺口，剩余才是真实加仓）----
      // 回补段：卖出时已暂记「净拿回 - 初始建仓成本」，此处补记低吸折让，使完整一轮
      // 配对的落袋利润恰好 =「高抛净拿回现金 - 回补总成本」。回补不刷新 initialCost。
      const buyBack = Math.min(qty, uncoveredQty);
      if (buyBack > 0) {
        const buyBackFee = fee * (buyBack / qty); // 规费按数量比例分摊
        accumulatedTPnL += (initialCost - batch.price) * buyBack - buyBackFee; // 补记低吸折让
        totalInvested += batch.price * buyBack + buyBackFee; // 回补资金真实流出
        currentAmount += buyBack; // 累加回补数量
        uncoveredQty -= buyBack; // 销台账
      }
      // 加仓段：剩余部分为真实加仓，计入 buyCostSum/buyQtySum 并刷新 initialCost
      const addQty = qty - buyBack;
      if (addQty > 0) {
        const addFee = fee * (addQty / qty); // 余下规费
        const cost = batch.price * addQty + addFee;
        totalInvested += cost; // 累计投入现金（成交额 + 规费）
        currentAmount += addQty; // 累加数量
        buyCostSum += cost; // 真实加仓成本累计
        buyQtySum += addQty; // 真实加仓数量累计
        initialCost = buyCostSum / buyQtySum; // 真实加仓加权均价（含规费）
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
