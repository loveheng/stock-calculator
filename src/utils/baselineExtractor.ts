/**
 * @file baselineExtractor.ts
 * @description 沙盘推演基线提取器：把真实持仓批次履历（Position.batches）转换为
 *              沙盘订单时间线（SandboxOrder[]），并计算历史资金占用峰值（Peak Capital Lock）
 *              与基线指纹（用于 🔄 持仓变动过期检测）。
 *
 * 【提取规则】（见 docs/sandbox-replay-spec.md §3）
 *  ① 全量纳入 —— 不过滤 kind，borrow/merge 做T调整批次全部进入时间线
 *  ② 时间升序排序
 *  ③ 方向映射：open/add/merge → buy；reduce/close/borrow → sell
 *  ④ 数量取绝对值；amount < 0 兼容为卖出（与 recalculatePosition 口径一致）
 *  ⑤ 每条订单保留 kind + sourceRoundId，UI 标注"倒T出借/倒T归并"
 *  ⑥ 峰值资金 = 全量批次时间线上的最大资金占用（含做T现金节奏）
 *  ⑦ 基线指纹 = `${批次数量}|${末笔时间戳}|${当前持股数}` → 用于 🔄 过期检测
 *
 * 【峰值资金口径（与引擎完全一致）】
 *  以现金 0 起步模拟批次现金流：买入扣（成交额+规费）、卖出加（成交额−规费），
 *  取历史最深净流出作为峰值。引擎以该峰值作为初始现金重演时，基线自身
 *  必然不会触碰资金约束（自洽性由同口径算术保证）。
 * @layer Logic
 * @storage_impact 纯函数，不读写任何存储。
 * @author 开发团队
 */

import type { Position } from '../store/types';
import type { SandboxOrder } from '../types/sandbox';

/** 基线提取结果 */
export interface BaselineExtraction {
  /** 基线订单时间线（时间升序） */
  orders: SandboxOrder[];
  /** 历史资金占用峰值（元，含规费），沙盘预算硬上限 */
  peakCapitalLock: number;
  /** 基线指纹：`${批次数量}|${末笔时间戳}|${当前持股数}` */
  signature: string;
  /** 按订单净额推导的末端持股数（buy 加 / sell 减），供自校验快速比对 */
  netPosition: number;
}

/** 四舍五入到分（与规费口径一致） */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 从真实持仓提取沙盘基线。
 *
 * @param {Position} position - 持仓（含批次履历），需传入未平仓或已平仓的完整批次
 * @returns {BaselineExtraction} 基线订单 + 峰值资金 + 指纹 + 净持仓
 */
export function extractBaseline(position: Position): BaselineExtraction {
  const sorted = [...position.batches].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const orders: SandboxOrder[] = [];
  // 峰值资金模拟（现金 0 起步）
  let cash = 0;
  let peak = 0;
  let netPosition = 0;

  sorted.forEach((batch, index) => {
    const qty = Math.abs(batch.amount);
    if (qty <= 0) return;
    const fee = batch.fee ?? 0;

    // 方向判定（与 recalculatePosition 一致）：type=reduce/close 优先，异常数据按 amount 符号兜底
    const typeIsSell = batch.type === 'reduce' || batch.type === 'close';
    const isSell = typeIsSell || batch.amount < 0;
    const action: 'buy' | 'sell' = isSell ? 'sell' : 'buy';

    orders.push({
      id: `baseline-${position.id}-${index}`,
      branchId: '', // 基线分支 id 由 store 层注入
      seqIndex: index,
      action,
      timestamp: new Date(batch.timestamp).toISOString(),
      price: batch.price,
      quantity: qty,
      fee,
      kind: batch.kind,
      sourceRoundId: batch.sourceRoundId,
      note: batch.note,
      isBaseline: true,
    });

    // 现金流模拟（与引擎同口径）→ 峰值资金
    if (action === 'buy') {
      cash -= batch.price * qty + fee;
      netPosition += qty;
    } else {
      cash += batch.price * qty - fee;
      netPosition -= qty;
    }
    if (-cash > peak) peak = -cash;
  });

  const lastBatch = sorted[sorted.length - 1];
  const signature = `${sorted.length}|${lastBatch ? new Date(lastBatch.timestamp).getTime() : 0}|${position.currentAmount}`;

  return {
    orders,
    peakCapitalLock: round2(peak),
    signature,
    netPosition,
  };
}
