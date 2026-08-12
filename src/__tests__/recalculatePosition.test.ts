/**
 * @file recalculatePosition.test.ts
 * @description 单元测试：持仓统计与做T对冲核心算法 recalculatePosition。
 *              覆盖空履历 / 纯建仓 / 加仓摊薄 / 做T高抛（不触发传统已实现亏损）/
 *              正T整轮与倒T整轮（整轮/对冲对配：落袋 = 高抛净回款 - 低吸买入总成本）/
 *              割肉减仓 / 清仓平仓 / 平仓后再开仓 / 乱序输入 /
 *              正负数量约定 / 超卖保护 / 多轮做T整轮累计 等口径。
 * @layer Test
 * @storage_impact 纯函数测试，不读写任何存储。
 */

import { describe, test, expect } from 'vitest';
import { recalculatePosition } from '../utils/calculator';
import type { PositionBatchEntity } from '../db/schema';

// ---- 辅助函数 ----
let seq = 0;
function createBatch(overrides: Partial<PositionBatchEntity> = {}): PositionBatchEntity {
  seq += 1;
  return {
    id: 'batch-' + seq,
    positionId: 'pos-1',
    type: 'open',
    price: 40,
    amount: 1000,
    fee: 5,
    costAfter: 40.005,
    amountAfter: 1000,
    timestamp: 1700000000000,
    ...overrides,
  };
}

const T1 = 1700000000000; // 建仓时间戳
const T2 = 1700000086400; // 第二次操作时间戳
const T3 = 1700000172800; // 第三次操作时间戳

// ============================================================
// 测试套件：recalculatePosition
// ============================================================
describe('recalculatePosition', () => {
  // 1. 空履历：全部归零、未平仓
  test('空批次：成本/数量/投入/盈亏全部归零且未平仓', () => {
    const snap = recalculatePosition([]);
    expect(snap.currentAmount).toBe(0);
    expect(snap.currentCost).toBe(0);
    expect(snap.totalInvested).toBe(0);
    expect(snap.realizedPnL).toBe(0);
    expect(snap.accumulatedTPnL).toBe(0);
    expect(snap.initialCost).toBe(0);
    expect(snap.isClosed).toBe(0);
    expect(snap.closedAt).toBeUndefined();
  });

  // 2. 纯建仓：成本 = (成交额 + 规费) / 数量
  test('纯建仓：初始均价与保本价均含规费', () => {
    const snap = recalculatePosition([
      createBatch({ id: 'open', price: 40, amount: 1000, fee: 5 }),
    ]);
    expect(snap.currentAmount).toBe(1000);
    expect(snap.totalInvested).toBeCloseTo(40005, 3);
    expect(snap.currentCost).toBeCloseTo(40.005, 3);
    expect(snap.initialCost).toBeCloseTo(40.005, 3);
    expect(snap.accumulatedTPnL).toBe(0);
    expect(snap.realizedPnL).toBe(0);
    expect(snap.isClosed).toBe(0);
  });

  // 3. 建仓 + 加仓：initialCost 为纯买入动作加权均价
  test('建仓+加仓：加权均价正确', () => {
    const snap = recalculatePosition([
      createBatch({ id: 'open', timestamp: T1, price: 40, amount: 1000, fee: 5 }),
      createBatch({ id: 'add', timestamp: T2, type: 'add', price: 42, amount: 500, fee: 3 }),
    ]);
    // 投入 = 40*1000+5 + 42*500+3 = 40005 + 21003 = 61008；数量 = 1500
    expect(snap.currentAmount).toBe(1500);
    expect(snap.totalInvested).toBeCloseTo(61008, 2);
    expect(snap.initialCost).toBeCloseTo(61008 / 1500, 3);
    expect(snap.currentCost).toBeCloseTo(61008 / 1500, 3);
    expect(snap.accumulatedTPnL).toBe(0);
    expect(snap.realizedPnL).toBe(0);
  });

  // 4. 建仓 + 高抛减仓（负数 amount 约定）：做T盈利只进 accumulatedTPnL，不触发传统已实现亏损
  test('建仓+高抛：做T利润计入 accumulatedTPnL，realizedPnL 不触发', () => {
    const snap = recalculatePosition([
      createBatch({ id: 'open', timestamp: T1, price: 40, amount: 1000, fee: 5 }),
      createBatch({ id: 'reduce', timestamp: T2, type: 'reduce', price: 45, amount: -400, fee: 4 }),
    ]);
    const netProceeds = 45 * 400 - 4; // 17996
    const costBasis = 40.005 * 400; // 16002
    expect(snap.currentAmount).toBe(600);
    expect(snap.totalInvested).toBeCloseTo(40005 - netProceeds, 2); // 22009
    expect(snap.currentCost).toBeCloseTo((40005 - netProceeds) / 600, 3); // 36.6817 保本价下降
    expect(snap.accumulatedTPnL).toBeCloseTo(netProceeds - costBasis, 2); // +1994
    expect(snap.realizedPnL).toBe(0); // 高抛不做割肉亏损记账
    expect(snap.isClosed).toBe(0);
  });

  // 5. 正T整轮（先低吸加仓、后高抛减仓，等量股数恢复）：整轮落袋 = 高抛净回款 - 低吸买入总成本
  test('正T整轮：加仓后卖出等量股，落袋=高抛净回款-低吸买入总成本', () => {
    const snap = recalculatePosition([
      createBatch({ id: 'open', timestamp: T1, price: 40, amount: 1000, fee: 5 }),
      createBatch({ id: 'add', timestamp: T2, type: 'add', price: 39, amount: 200, fee: 2 }),
      createBatch({ id: 'reduce', timestamp: T3, type: 'reduce', price: 41, amount: 200, fee: 2 }),
    ]);
    // 高抛净回款 = 41*200-2 = 8198；低吸总成本 = 39*200+2 = 7802；整轮落袋 = +396
    expect(snap.accumulatedTPnL).toBeCloseTo(8198 - 7802, 2);
    expect(snap.realizedPnL).toBe(0);
    expect(snap.currentAmount).toBe(1000);
    expect(snap.totalInvested).toBeCloseTo(47807 - 8198, 2); // 39609
    expect(snap.currentCost).toBeCloseTo(39609 / 1000, 3);
    // 低吸腿属于做T轮次而非底仓：initialCost 保持首次建仓含规费均价，不因做T腿刷新
    expect(snap.initialCost).toBeCloseTo(40.005, 3);
  });

  // 6. 割肉减仓：卖价跌破初始均价时，传统已实现盈亏才记亏损
  test('割肉减仓：跌破初始均价才记 realizedPnL 亏损', () => {
    const snap = recalculatePosition([
      createBatch({ id: 'open', timestamp: T1, price: 40, amount: 1000, fee: 5 }),
      createBatch({ id: 'reduce', timestamp: T2, type: 'reduce', price: 35, amount: -200, fee: 2 }),
    ]);
    // 净拿回 = 35*200-2 = 6998；成本 = 40.005*200 = 8001；割肉 = -1003
    expect(snap.accumulatedTPnL).toBeCloseTo(-1003, 2);
    expect(snap.realizedPnL).toBeCloseTo(-1003, 2);
    expect(snap.currentAmount).toBe(800);
    expect(snap.totalInvested).toBeCloseTo(40005 - 6998, 2); // 33007
    expect(snap.currentCost).toBeCloseTo(33007 / 800, 3);
    expect(snap.isClosed).toBe(0);
  });


  // 7. 清仓到 0：isClosed = 1，closedAt 取清仓批次时间戳，保本价与投入归零
  test('清仓到 0：自动平仓并记录 closedAt', () => {
    const snap = recalculatePosition([
      createBatch({ id: 'open', timestamp: T1, price: 40, amount: 1000, fee: 5 }),
      createBatch({ id: 'reduce', timestamp: T2, type: 'reduce', price: 45, amount: -1000, fee: 5 }),
    ]);
    const netProceeds = 45 * 1000 - 5; // 44995
    expect(snap.currentAmount).toBe(0);
    expect(snap.currentCost).toBe(0);
    expect(snap.totalInvested).toBe(0);
    expect(snap.isClosed).toBe(1);
    expect(snap.closedAt).toBe(T2);
    expect(snap.accumulatedTPnL).toBeCloseTo(netProceeds - 40005, 2); // +4990
    expect(snap.realizedPnL).toBe(0);
  });

  // 8. 平仓后再开仓：isClosed 恢复 0，closedAt 清除
  test('平仓后再开仓：自动恢复未平仓状态', () => {
    const snap = recalculatePosition([
      createBatch({ id: 'open', timestamp: T1, price: 40, amount: 1000, fee: 5 }),
      createBatch({ id: 'reduce', timestamp: T2, type: 'reduce', price: 45, amount: -1000, fee: 5 }),
      createBatch({ id: 'add', timestamp: T3, type: 'add', price: 44, amount: 200, fee: 2 }),
    ]);
    expect(snap.currentAmount).toBe(200);
    expect(snap.totalInvested).toBeCloseTo(8802, 2);
    expect(snap.isClosed).toBe(0);
    expect(snap.closedAt).toBeUndefined();
    expect(snap.accumulatedTPnL).toBeCloseTo(4990, 2); // 历史做T利润保留
    expect(snap.initialCost).toBeCloseTo((40005 + 8802) / 1200, 3); // 纯买入加权均价含全部买入
  });

  // 9. 乱序输入：按 timestamp 排序后结果一致
  test('批次乱序传入：按 timestamp 排序后计算结果一致', () => {
    const unordered = [
      createBatch({ id: 'reduce', timestamp: T2, type: 'reduce', price: 45, amount: -400, fee: 4 }),
      createBatch({ id: 'add', timestamp: T1 + 86400000, type: 'add', price: 42, amount: 500, fee: 3 }),
      createBatch({ id: 'open', timestamp: T1, price: 40, amount: 1000, fee: 5 }),
    ];
    const ordered = [unordered[2], unordered[0], unordered[1]];
    const snapUnordered = recalculatePosition(unordered);
    const snapOrdered = recalculatePosition(ordered);
    expect(snapUnordered.currentAmount).toBe(snapOrdered.currentAmount);
    expect(snapUnordered.currentCost).toBeCloseTo(snapOrdered.currentCost, 3);
    expect(snapUnordered.totalInvested).toBeCloseTo(snapOrdered.totalInvested, 2);
    expect(snapUnordered.accumulatedTPnL).toBeCloseTo(snapOrdered.accumulatedTPnL, 2);
    expect(snapUnordered.realizedPnL).toBeCloseTo(snapOrdered.realizedPnL, 2);
  });

  // 10. reduce 使用正数 amount（新增约定）与负数约定结果一致
  test('reduce 正数数量约定：结果与负数约定完全一致', () => {
    const snapPositive = recalculatePosition([
      createBatch({ id: 'open', timestamp: T1, price: 40, amount: 1000, fee: 5 }),
      createBatch({ id: 'reduce', timestamp: T2, type: 'reduce', price: 45, amount: 400, fee: 4 }),
    ]);
    const snapNegative = recalculatePosition([
      createBatch({ id: 'open', timestamp: T1, price: 40, amount: 1000, fee: 5 }),
      createBatch({ id: 'reduce', timestamp: T2, type: 'reduce', price: 45, amount: -400, fee: 4 }),
    ]);
    expect(snapPositive.currentAmount).toBe(snapNegative.currentAmount);
    expect(snapPositive.currentCost).toBeCloseTo(snapNegative.currentCost, 3);
    expect(snapPositive.totalInvested).toBeCloseTo(snapNegative.totalInvested, 2);
    expect(snapPositive.accumulatedTPnL).toBeCloseTo(snapNegative.accumulatedTPnL, 2);
    expect(snapPositive.realizedPnL).toBe(snapNegative.realizedPnL);
  });

  // 11. 超卖保护：卖出数量超过持仓时按持仓上限处理，不产生负持仓
  test('超卖保护：卖出数量封顶为当前持仓', () => {
    const snap = recalculatePosition([
      createBatch({ id: 'open', timestamp: T1, price: 40, amount: 1000, fee: 5 }),
      createBatch({ id: 'reduce', timestamp: T2, type: 'reduce', price: 45, amount: -2000, fee: 4 }),
    ]);
    expect(snap.currentAmount).toBe(0);
    expect(snap.totalInvested).toBe(0);
    expect(snap.isClosed).toBe(1);
    expect(snap.closedAt).toBe(T2);
    // 仅按可卖 1000 股计算做T利润：(45*1000-4) - 40.005*1000 = 44996 - 40005 = 4991
    expect(snap.accumulatedTPnL).toBeCloseTo(4991, 2);
    expect(snap.realizedPnL).toBe(0);
  });

  // 12. 无持仓时的减仓异常批次：安全忽略
  test('无持仓时出现减仓：忽略该异常批次，快照保持空仓', () => {
    const snap = recalculatePosition([
      createBatch({ id: 'reduce', timestamp: T1, type: 'reduce', price: 45, amount: -400, fee: 4 }),
    ]);
    expect(snap.currentAmount).toBe(0);
    expect(snap.totalInvested).toBe(0);
    expect(snap.currentCost).toBe(0);
    expect(snap.accumulatedTPnL).toBe(0);
    expect(snap.realizedPnL).toBe(0);
    expect(snap.isClosed).toBe(0);
  });

  // 13. 多轮做T累计：完整配对轮次按整轮口径累计，未回补的减仓按初始均价结算
  test('多轮做T：整轮配对累计落袋利润', () => {
    const snap = recalculatePosition([
      createBatch({ id: 'open', timestamp: T1, price: 40, amount: 1000, fee: 5 }),
      // 第 1 轮高抛：暂记 (41*200-2) - 40.005*200 = 8198 - 8001 = 197
      createBatch({ id: 'reduce1', timestamp: T2, type: 'reduce', price: 41, amount: -200, fee: 2 }),
      // 低吸买回 200@39 视为回补：补记折让 (40.005-39)*200-2 = 199；initialCost 不刷新
      createBatch({ id: 'add', timestamp: T3, type: 'add', price: 39, amount: 200, fee: 2 }),
      // 第 2 轮高抛：尚未回补，按初始均价 40.005 结算 (42*200-2) - 40.005*200 = 8398 - 8001 = 397
      createBatch({ id: 'reduce2', timestamp: T3 + 86400000, type: 'reduce', price: 42, amount: -200, fee: 2 }),
    ]);
    // 第 1 轮为完整配对：落袋 = 高抛净拿回 8198 - 回补总成本 7802 = 396
    const round1 = (41 * 200 - 2) - (39 * 200 + 2); // 396
    // 第 2 轮仅高抛未回补：按初始均价结算 = 8398 - 40.005*200 = 397
    const round2 = (42 * 200 - 2) - 40.005 * 200; // 397
    expect(snap.accumulatedTPnL).toBeCloseTo(round1 + round2, 2); // 793
    expect(snap.realizedPnL).toBe(0);
    // 低吸回补不刷新 initialCost：保持首次建仓含规费均价
    expect(snap.initialCost).toBeCloseTo(40.005, 3);
    // 1000 底仓 - 第1轮高抛 200 + 低吸买回 200 - 第2轮高抛 200 = 800
    expect(snap.currentAmount).toBe(800);
    expect(snap.isClosed).toBe(0);
  });

  // 14. 高抛→低吸回补整轮（用户场景回归）：落袋 = 高抛净拿回 - 回补总成本
  test('高抛低吸整轮：落袋利润等于高抛净拿回减去回补总成本', () => {
    const snap = recalculatePosition([
      createBatch({ id: 'open', timestamp: T1, price: 24.55, amount: 8200, fee: 52.34 }),
      createBatch({ id: 'reduce', timestamp: T2, type: 'reduce', price: 26, amount: -4100, fee: 81.02 }),
      createBatch({ id: 'add', timestamp: T3, type: 'add', price: 16, amount: 4100, fee: 17.06 }),
    ]);
    const netProceeds = 26 * 4100 - 81.02; // 106518.98
    const buyBackCost = 16 * 4100 + 17.06; // 65617.06
    // 整轮做T落袋 = 高抛净拿回 - 回补总成本 = +40901.92
    expect(snap.accumulatedTPnL).toBeCloseTo(netProceeds - buyBackCost, 2);
    expect(snap.realizedPnL).toBe(0);
    // 持仓回到 8200；保本价因做T落袋同步下降（净投入减少 = 落袋利润）
    expect(snap.currentAmount).toBe(8200);
    expect(snap.totalInvested).toBeCloseTo(201362.34 - netProceeds + buyBackCost, 2); // 160460.42
    expect(snap.currentCost).toBeCloseTo(160460.42 / 8200, 3);
    // 低吸回补不刷新 initialCost：仍为首次建仓含规费均价
    expect(snap.initialCost).toBeCloseTo(201362.34 / 8200, 3);
    expect(snap.isClosed).toBe(0);
  });
  // 15. 用户回归：建仓 → 低吸加仓 → 高抛减仓（等量恢复股数），做T落袋 = +74.06
  test('用户回归：做T/调仓落袋利润 +74.06（正T整轮对配，不再误按底仓均价割肉）', () => {
    const snap = recalculatePosition([
      createBatch({ id: 'open', timestamp: T1, price: 24.55, amount: 8200, fee: 52.34 }),
      createBatch({ id: 'add', timestamp: T2, type: 'add', price: 17.15, amount: 100, fee: 5.02 }),
      createBatch({ id: 'reduce', timestamp: T3, type: 'reduce', price: 18, amount: -100, fee: 5.92 }),
    ]);
    // 高抛净回款 = 18*100-5.92 = 1794.08；低吸总成本 = 17.15*100+5.02 = 1720.02；整轮落袋 = +74.06
    expect(snap.accumulatedTPnL).toBeCloseTo(1794.08 - 1720.02, 2); // +74.06
    expect(snap.realizedPnL).toBe(0);
    expect(snap.currentAmount).toBe(8200); // 股数恢复
    expect(snap.totalInvested).toBeCloseTo(201288.28, 2);
    expect(snap.currentCost).toBeCloseTo(24.547, 3);
    // 低吸腿为做T轮次而非底仓：底仓均价保持首次建仓含规费均价
    expect(snap.initialCost).toBeCloseTo(201362.34 / 8200, 3);
    expect(snap.isClosed).toBe(0);
  });
});

