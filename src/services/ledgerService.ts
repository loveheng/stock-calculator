/**
 * @file ledgerService.ts
 * @description 统一账本 Service 门面（Facade）：集中封装 IndexedDB 的读写事务与 Store 行为，
 *              供 UI 组件统一调用。涵盖持仓、批次、做T Round、手续费配置与现金账户的读写。
 * @layer Service
 * @storage_impact 读写 IndexedDB 的 stocks / positions / positionBatches / tRounds / tTransactions / accountCash / feeConfigs 表，
 *                 所有写入均自动维护 `createdAt` / `updatedAt` / `isDeleted` 字段，并采用软删除策略。
 * @author 开发团队
 */

import { db, type StockRow } from '../db/index';
import type {
  AccountCashEntity,
  PositionBatchEntity,
  PositionEntity,
  StockEntity,
  TTransactionEntity,
  TRoundEntity,
} from '../db/schema';
import type { Position, PositionBatch } from '../store';
import type { TRoundArchive, RoundTxn } from '../store';
import type { FeeConfig } from '../utils/mathUtils';

/**
 * 读取当前生效的费率配置（单行记录，id=1）。
 *
 * @description 从 feeConfigs 表读取配置，过滤已软删除记录；不存在则返回 null。
 * @returns {Promise<FeeConfig | null>} 费率配置对象；若未初始化或已软删除则返回 null
 */
export async function getFeeConfig(): Promise<FeeConfig | null> {
  const row = await db.feeConfigs.get(1 as any);
  if (!row || (row.isDeleted ?? 0) === 1) return null;
  const cfg: FeeConfig = {
    commissionRate: row.commissionRate,
    isFreeFive: row.isFreeFive,
    minCommission: row.minCommission,
    transferRate: row.transferRate,
    stampRate: row.stampRate,
  };
  return cfg;
}

// ---------- Mutation API wrapping store behaviors ----------
import { useAppStore } from '../store';
import type { TStreamRecord } from '../utils/tStreamEngine';

/**
 * 新建持仓（委托给 Store 层的 addPosition，保留其复杂副作用逻辑）。
 *
 * @param {any} pos - 持仓数据（含 fullCode、currentCost、currentAmount 等字段）
 * @returns {Promise<void>}
 * @note 本方法会经由 Store 触发全局状态更新并持久化到 IndexedDB
 */
export async function createPosition(pos: any): Promise<void> {
  // keep existing store behavior for complex side-effects
  const addPosition = useAppStore.getState().addPosition;
  addPosition(pos);
}

/**
 * 为指定持仓追加一个批次（委托给 Store 层 addBatch）。
 *
 * @param {string} positionId - 持仓主键 id
 * @param {any} batch - 批次数据（type、price、amount、fee 等）
 * @returns {Promise<void>}
 */
export async function addBatchToPosition(positionId: string, batch: any): Promise<void> {
  const addBatch = useAppStore.getState().addBatch;
  addBatch(positionId, batch);
}

/**
 * 按 id 更新持仓字段（委托给 Store 层 updatePosition）。
 *
 * @param {string} positionId - 持仓主键 id
 * @param {Partial<any>} updates - 需要更新的字段集合
 * @returns {Promise<void>}
 */
export async function updatePositionById(positionId: string, updates: Partial<any>): Promise<void> {
  const updatePosition = useAppStore.getState().updatePosition;
  updatePosition(positionId, updates);
}

/**
 * 删除指定持仓下的某个批次（委托给 Store 层 deletePositionBatch，采用软删除）。
 *
 * @param {string} positionId - 持仓主键 id
 * @param {string} batchId - 批次主键 id
 * @returns {Promise<void>}
 */
export async function deleteBatchForPosition(positionId: string, batchId: string): Promise<void> {
  const deletePositionBatch = useAppStore.getState().deletePositionBatch;
  deletePositionBatch(positionId, batchId);
}

/**
 * 删除指定持仓（委托给 Store 层 removePosition，采用软删除）。
 *
 * @param {string} positionId - 持仓主键 id
 * @returns {Promise<void>}
 */
export async function removePositionById(positionId: string): Promise<void> {
  const removePosition = useAppStore.getState().removePosition;
  removePosition(positionId);
}

/**
 * 写入一条做T流水记录并触发撮合引擎重算（委托给 Store 层 addStreamRecord）。
 *
 * @description 流水进入 Store 的 tStreams 池后，会经 FIFO/加权平均撮合并级联重算 Round。
 * @param {TStreamRecord} rec - 做T流水记录（含方向、价格、数量、手续费、时间戳等）
 * @returns {Promise<any>} 撮合结果：`cleared` 表示本轮结清，`rejected` 表示校验拒绝并附 `rejectedReason`
 */
export async function applyStreamRecord(rec: TStreamRecord) {
  const addStreamRecord = useAppStore.getState().addStreamRecord;
  return addStreamRecord(rec);
}

/**
 * 一键划转底仓（绝对现金流法结算，委托给 Store 层 transferToPosition）。
 *
 * @param {string} fullCode - 股票完整代码（含市场前缀）
 * @param {number} [transferAmount] - 可选：划转数量（股），缺省按待对冲持仓全量
 * @param {number} [transferPrice] - 可选：划转价格（元），缺省使用加权均价
 * @returns {Promise<any>} 操作结果 `{ ok, message, ... }`
 */
export async function transferToPositionService(fullCode: string, transferAmount?: number, transferPrice?: number) {
  const transferToPosition = useAppStore.getState().transferToPosition;
  return transferToPosition(fullCode, transferAmount, transferPrice);
}

/**
 * 结算倒T（short）轮次并划转底仓（委托给 Store 层 settleShortRound）。
 *
 * @param {string} fullCode - 股票完整代码
 * @returns {Promise<any>} 操作结果 `{ ok, message }`
 */
export async function settleShortRoundService(fullCode: string) {
  const settleShortRound = useAppStore.getState().settleShortRound;
  return settleShortRound(fullCode);
}

/** 持仓视图模型：在 Position 基础上附带股票信息与展示名 */
export interface PositionWithStockInfo extends Position {
  /** 关联的股票实体（可能缺省，此时以 fullCode 兜底展示） */
  stock?: StockEntity;
  /** 用于 UI 展示的股票名称（缺省时回退为 fullCode） */
  stockNameDisplay: string;
}

/** 新增持仓事务的入参：股票 + 持仓 + 首个批次 */
export interface AddPositionTransactionData {
  /** 股票实体（不存在则自动写入 stocks 表） */
  stock: StockEntity;
  /** 持仓实体 */
  position: PositionEntity;
  /** 首笔批次数据（positionId 由方法内部补充） */
  batch: Omit<PositionBatchEntity, 'positionId'>;
}

/**
 * 生成基于时间戳的降级唯一 ID。
 *
 * @description 在 crypto.randomUUID 不可用时兜底使用，格式 `时间戳-随机串`。
 * @returns {string} 唯一字符串 ID
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 生成全局唯一 ID（优先使用标准 UUID）。
 *
 * @description 优先调用 `crypto.randomUUID()`，不可用时降级为 generateId()。
 * @returns {string} 唯一字符串 ID
 */
function makeId(): string {
  try {
    // prefer standard UUID when available
    // @ts-ignore
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (e) {
    // ignore
  }
  return generateId();
}

/**
 * 自动维护实体的审计时间戳与软删除标记。
 *
 * @description 为传入对象补齐 `id`（缺省时生成）、`updatedAt`（恒为当前时间）、`isDeleted`（缺省为 0）。
 *              新记录（isNew=true）还会补齐 `createdAt`。
 * @param {T} obj - 待修补的实体对象（可含可选 id/createdAt/updatedAt/isDeleted）
 * @param {boolean} [isNew=false] - 是否为新建记录，true 时补充 createdAt
 * @returns {T} 修补后的同一对象引用
 * @note 直接修改入参对象并返回，调用方需注意引用共享
 */
function ensureTimestamps<T extends { id?: string; createdAt?: number; updatedAt?: number; isDeleted?: number }>(obj: T, isNew = false): T {
  const now = Date.now();
  if (!obj.id) obj.id = makeId();
  if (isNew) {
    obj.createdAt = obj.createdAt ?? now;
  }
  obj.updatedAt = now;
  obj.isDeleted = obj.isDeleted ?? 0;
  return obj;
}

/**
 * 递归剔除对象中的 undefined 字段。
 *
 * @description 防止 undefined 字段引发 IndexedDB 结构化克隆序列化错误；写入 DB 前必须调用。
 * @param {T} obj - 任意对象
 * @returns {T} 剔除 undefined 字段后的新对象
 * @note 建议与 ensureTimestamps 搭配使用：先补时间戳，再 cleanUndefined 后入库
 */
function cleanUndefined<T extends Record<string, any>>(obj: T): T {
  const result: any = {};
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val !== undefined) {
      result[key] = val;
    }
  }
  return result;
}

/**
 * 规范化批次数量：减仓（reduce）批次将数量转为负数表示。
 *
 * @description 便于后续 metrics 计算统一减仓语义：`amount = -Math.abs(batch.amount)`。
 * @param {Omit<PositionBatchEntity, 'positionId'>} batch - 批次数据
 * @returns {Omit<PositionBatchEntity, 'positionId'>} 规范化后的批次数据
 */
function normalizeBatch(batch: Omit<PositionBatchEntity, 'positionId'>): Omit<PositionBatchEntity, 'positionId'> {
  return {
    ...batch,
    amount: batch.type === 'reduce' ? -Math.abs(batch.amount) : batch.amount,
  };
}

/**
 * 将批次实体映射为 Store 层 PositionBatch（时间戳转为 ISO 字符串）。
 *
 * @param {PositionBatchEntity} batch - 数据库批次实体
 * @returns {PositionBatch} Store 层批次结构
 */
function mapPositionBatchEntityToStore(batch: PositionBatchEntity): PositionBatch {
  return {
    ...batch,
    timestamp: new Date(batch.timestamp).toISOString(),
  };
}

/**
 * 将持仓实体映射为 Store 层 Position（去掉 batches 字段）。
 *
 * @param {PositionEntity} position - 数据库持仓实体
 * @param {string} stockName - 股票名称（用于 UI 展示）
 * @returns {Omit<Position, 'batches'>} Store 层持仓结构（不含批次数组）
 */
function mapPositionEntityToStore(
  position: PositionEntity,
  stockName: string,
): Omit<Position, 'batches'> {
  return {
    ...position,
    stockName,
    createdAt: new Date(position.createdAt).toISOString(),
    closedAt: position.closedAt ? new Date(position.closedAt).toISOString() : undefined,
  };
}

/**
 * 依据批次时间顺序滚动计算持仓的核心指标。
 *
 * @description 遍历按时间排序的批次：开仓/加仓累加成本与数量；减仓按移动加权成本结出已实现盈亏。
 * @param {PositionBatchEntity[]} batches - 某持仓的全部批次（未过滤软删除时需由调用方过滤）
 * @returns {{ currentAmount: number; currentCost: number; totalInvested: number; realizedPnL: number }}
 *          当前数量 / 加权成本 / 累计投入 / 已实现盈亏
 */
function calcPositionMetrics(batches: PositionBatchEntity[]) {
  const sorted = [...batches].sort((a, b) => a.timestamp - b.timestamp);
  let remainingAmount = 0;
  let invested = 0;
  let realizedPnL = 0;

  for (const batch of sorted) {
    const qty = Math.abs(batch.amount);
    const fee = batch.fee ?? 0;
    if (batch.type === 'open' || batch.type === 'add') {
      const cost = batch.price * qty + fee;
      invested += cost;
      remainingAmount += qty;
    } else {
      if (remainingAmount > 0) {
        const costBasisPerShare = invested / remainingAmount;
        const costBasis = costBasisPerShare * qty;
        const proceeds = batch.price * qty - fee;
        realizedPnL += proceeds - costBasis;
        invested -= costBasis;
      }
      remainingAmount = Math.max(0, remainingAmount - qty);
      if (remainingAmount === 0) {
        invested = 0;
      }
    }
  }

  return {
    currentAmount: remainingAmount,
    currentCost: remainingAmount > 0 ? invested / remainingAmount : 0,
    totalInvested: invested,
    realizedPnL,
  };
}

/**
 * 查询全部持仓并附带股票名称与批次明细。
 *
 * @description 并行读取 positions / positionBatches / stocks 三表，过滤软删除记录，
 *              按 positionId 聚合批次并映射为 UI 友好的 PositionWithStockInfo 结构。
 * @returns {Promise<PositionWithStockInfo[]>} 持仓列表（按股票名映射、含批次）
 */
export async function getPositionsWithStockInfo(): Promise<PositionWithStockInfo[]> {
  const [positionsRaw, batchesRaw, stocksRaw] = await Promise.all([
    db.positions.toArray(),
    db.positionBatches.toArray(),
    db.stocks.toArray(),
  ]);

  const positions = positionsRaw.filter((p) => (p.isDeleted ?? 0) === 0);
  const batches = batchesRaw.filter((b) => (b.isDeleted ?? 0) === 0);
  const stocks = stocksRaw.filter((s) => (s.isDeleted ?? 0) === 0);

  return positions.map((position) => {
    const stock = stocks.find((item) => item.fullCode === position.fullCode);
    const positionBatches = batches
      .filter((batch) => batch.positionId === position.id)
      .sort((a, b) => a.timestamp - b.timestamp);

    return {
      ...mapPositionEntityToStore(position, stock?.stockName ?? position.fullCode),
      stockName: stock?.stockName ?? position.fullCode,
      stock,
      stockNameDisplay: stock?.stockName ?? position.fullCode,
      batches: positionBatches.map(mapPositionBatchEntityToStore),
    };
  });
}

/**
 * 查询全部已归档做T Round（含成交明细与股票名称）。
 *
 * @description 并行读取 tRounds / tTransactions / stocks 三表，过滤软删除记录，
 *              按 roundId 聚合流水，映射为 TRoundArchive 结构（settleType 中 partial 转译为 transfer）。
 * @returns {Promise<TRoundArchive[]>} 归档 Round 列表
 */
export async function getTRoundsWithTransactions(): Promise<TRoundArchive[]> {
  const [roundsRaw, txnsRaw, stocksRaw] = await Promise.all([
    db.tRounds.toArray(),
    db.tTransactions.toArray(),
    db.stocks.toArray(),
  ]);

  const rounds = roundsRaw.filter((r) => (r.isDeleted ?? 0) === 0);
  const txns = txnsRaw.filter((t) => (t.isDeleted ?? 0) === 0);
  const stocks = stocksRaw.filter((s) => (s.isDeleted ?? 0) === 0);

  const stockMap = new Map(stocks.map((s) => [s.fullCode, s]));

  return rounds.map((r) => {
    const related = txns.filter((t) => t.roundId === r.id).sort((a, b) => a.timestamp - b.timestamp);
    const transactions: RoundTxn[] = related.map((t) => ({
      id: t.id,
      timestamp: new Date(t.timestamp).toISOString(),
      direction: t.direction,
      price: t.price,
      amount: t.amount,
      fee: t.fee,
      matchedAmount: t.matchedAmount,
      realizedProfit: t.realizedProfit,
      note: t.note,
    }));

    const archive: TRoundArchive = {
      id: r.id,
      fullCode: r.fullCode,
      stockName: stockMap.get(r.fullCode)?.stockName ?? r.fullCode,
      roundNo: r.roundNo,
      mode: r.mode,
      settleType: r.settleType === 'partial' ? 'transfer' : 'clear',
      transactions,
      netProfit: r.netProfit,
      fees: r.totalFees,
      sellAmount: r.sellAmount ?? 0,
      transferAmount: r.transferAmount,
      avgPrice: r.avgPrice ?? 0,
      buyAmount: r.buyAmount ?? 0,
      tradeCount: r.tradeCount ?? 0,
      holdingDays: r.holdingDays ?? 0,
      win: !!r.win,
      openedAt: new Date(r.openedAt).toISOString(),
      closedAt: r.closedAt ? new Date(r.closedAt).toISOString() : '',
    };

    return archive;
  });
}

/**
 * 新增持仓事务（原子写入 stocks / positions / positionBatches 三表，含首笔批次）。
 *
 * @description 事务内：① upsert 股票信息到 stocks；② upsert 持仓到 positions；③ 写入首笔批次到 positionBatches。
 * @param {AddPositionTransactionData} data - 股票 + 持仓 + 首笔批次
 * @returns {Promise<PositionEntity>} 写入成功后的持仓实体
 * @throws {Error} 当 IndexedDB 事务失败（任一表写入失败）时整体回滚
 * @note 运行在 `rw` 读写事务中；自动维护 `createdAt` / `updatedAt` / `isDeleted`；写入前经 cleanUndefined 剔除 undefined 字段
 */
export async function addPositionTransaction(
  data: AddPositionTransactionData,
): Promise<PositionEntity> {
  return db.transaction(
    'rw',
    [db.positions, db.positionBatches, db.stocks],
    async () => {
      const { stock, position, batch } = data;
      const normalizedBatch = normalizeBatch(batch);

      // prepare stock
      const existingStock = await db.stocks.get(stock.fullCode as any);
      if (!existingStock) {
        const toPut = ensureTimestamps({ ...stock } as any, true);
        await db.stocks.put(toPut as any);
      } else {
        await db.stocks.put(ensureTimestamps({ ...existingStock } as any, false) as any);
      }

      // prepare position
      const existingPosition = await db.positions.get(position.id);
      if (existingPosition) {
        await db.positions.put(ensureTimestamps({ ...existingPosition } as any, false) as any);
      } else {
        const posToAdd = ensureTimestamps({ ...position } as any, true);
        await db.positions.add(posToAdd as any);
      }

      // add batch
      const batchToAdd = ensureTimestamps({ ...normalizedBatch, positionId: position.id } as any, true) as PositionBatchEntity;
      if (!batchToAdd.id) batchToAdd.id = makeId();
      await db.positionBatches.add(batchToAdd);
      return await db.positions.get(position.id) as PositionEntity;
    },
  );
}

/**
 * 将指定持仓标记为已平仓。
 *
 * @description 软更新 positions 表：设置 `isClosed=true`、`closedAt` 与 `updatedAt`。
 * @param {string} positionId - 持仓主键 id
 * @returns {Promise<void>}
 * @note 自动更新 `updatedAt`；不物理删除记录
 */
export async function closePosition(positionId: string): Promise<void> {
  await db.positions.update(positionId, cleanUndefined({
    isClosed: true,
    closedAt: Date.now(),
    updatedAt: Date.now(),
  } as any));
}

/**
 * 删除指定持仓的某个批次，并在事务内级联重算持仓指标。
 *
 * @description 事务内：① 校验批次归属，软删除该批次；② 若持仓已无剩余批次则一并软删除持仓；
 *              ③ 否则基于剩余批次重算 currentAmount / currentCost / totalInvested / realizedPnL 并回写。
 * @param {string} positionId - 持仓主键 id
 * @param {string} batchId - 批次主键 id
 * @returns {Promise<void>}
 * @throws {Error} 当批次不存在或不属于该持仓时抛出 `Position batch not found`
 * @note 运行在 `rw` 事务；采用软删除（isDeleted=1）；自动维护 `updatedAt`
 */
export async function deletePositionBatch(
  positionId: string,
  batchId: string,
): Promise<void> {
  await db.transaction('rw', [db.positions, db.positionBatches], async () => {
    const existingBatch = await db.positionBatches.get(batchId);
    if (!existingBatch || existingBatch.positionId !== positionId) {
      throw new Error('Position batch not found');
    }
    // soft delete the batch
    await db.positionBatches.update(batchId, cleanUndefined({ isDeleted: 1, updatedAt: Date.now() } as any));

    const remainingBatches = await db.positionBatches
      .where('positionId')
      .equals(positionId)
      .toArray();

    if (remainingBatches.length === 0) {
      // soft delete position as well
      await db.positions.update(positionId, cleanUndefined({ isDeleted: 1, updatedAt: Date.now() } as any));
      return;
    }

    const metrics = calcPositionMetrics(remainingBatches);
    await db.positions.update(positionId, cleanUndefined({
      currentAmount: metrics.currentAmount,
      currentCost: metrics.currentCost,
      totalInvested: metrics.totalInvested,
      realizedPnL: metrics.realizedPnL,
      isClosed: metrics.currentAmount === 0,
      closedAt: metrics.currentAmount === 0 ? Date.now() : undefined,
      updatedAt: Date.now(),
    } as any));
  });
}

/**
 * 删除指定持仓及其全部批次（软删除事务）。
 *
 * @description 事务内遍历并软删除该持仓的全部批次，再软删除持仓本身。
 * @param {string} positionId - 持仓主键 id
 * @returns {Promise<void>}
 * @note 运行在 `rw` 事务；全部采用 isDeleted=1 软删除，不物理清除
 */
export async function removePosition(positionId: string): Promise<void> {
  await db.transaction('rw', [db.positions, db.positionBatches], async () => {
    // soft-delete all batches and the position
    const now = Date.now();
    const batches = await db.positionBatches.where('positionId').equals(positionId).toArray();
    for (const b of batches) {
      await db.positionBatches.update(b.id, cleanUndefined({ isDeleted: 1, updatedAt: now } as any));
    }
    await db.positions.update(positionId, cleanUndefined({ isDeleted: 1, updatedAt: now } as any));
  });
}

/**
 * 为指定做T Round 追加一笔卖出结算流水，并原子更新 Round 与现金账户。
 *
 * @description 事务内：① 校验 Round 存在、数量合法（0 < closeShares ≤ 剩余可卖）；
 *              ② 按 mode 计算盈亏（long=卖价-均价，short=均价-卖价）；
 *              ③ 写入 tTransactions 卖出流水；
 *              ④ 更新 tRounds 的净收益/手续费/状态（剩余 0 时置 COMPLETED）；
 *              ⑤ 更新 accountCash 可用现金（+卖出金额-手续费）并解冻。
 * @param {string} roundId - 做T Round 主键 id
 * @param {number} closePrice - 卖出成交价（元）
 * @param {number} closeShares - 卖出数量（股，须 > 0 且 ≤ 剩余可卖）
 * @param {number} fee - 本次卖出手续费（元）
 * @returns {Promise<TTransactionEntity>} 新写入的卖出流水实体
 * @throws {Error} Round 不存在、数量 ≤ 0、超过剩余数量、或现金账户行缺失时抛异常
 * @note 运行在 `rw` 事务（tRounds / tTransactions / accountCash）；
 *      自动维护三表 `updatedAt`，新流水自动补 `createdAt` / `id` / `isDeleted`
 */
export async function appendTSlice(
  roundId: string,
  closePrice: number,
  closeShares: number,
  fee: number,
): Promise<TTransactionEntity> {
  return db.transaction(
    'rw',
    [db.tRounds, db.tTransactions, db.accountCash],
    async () => {
      const round = await db.tRounds.get(roundId);
      if (!round) {
        throw new Error(`Round not found: ${roundId}`);
      }

      const buyAmount = round.buyAmount ?? 0;
      const sellAmount = round.sellAmount ?? 0;
      const remainingShares = Math.max(0, buyAmount - sellAmount);
      if (closeShares <= 0) {
        throw new Error('closeShares must be greater than 0');
      }
      if (closeShares > remainingShares) {
        throw new Error('closeShares cannot exceed remaining shares');
      }

      const profitPerShare = round.mode === 'short'
        ? (round.avgPrice ?? 0) - closePrice
        : closePrice - (round.avgPrice ?? 0);
      const realizedProfit = profitPerShare * closeShares - fee;

      const transaction: any = {
        id: makeId(),
        roundId,
        direction: 'sell',
        price: closePrice,
        amount: closeShares,
        fee,
        matchedAmount: closeShares,
        realizedProfit,
        timestamp: Date.now(),
      };

      ensureTimestamps(transaction, true);
      await db.tTransactions.add(cleanUndefined(transaction) as TTransactionEntity);

      const nextRemaining = remainingShares - closeShares;
      await db.tRounds.update(roundId, cleanUndefined({
        netProfit: (round.netProfit ?? 0) + realizedProfit,
        totalFees: (round.totalFees ?? 0) + fee,
        status: nextRemaining === 0 ? 'COMPLETED' : 'OPENED',
        sellAmount: (round.sellAmount ?? 0) + closeShares,
        updatedAt: Date.now(),
      } as any));

      const accountCash = await db.accountCash.get(1);
      if (!accountCash) {
        throw new Error('Account cash row missing');
      }

      const updateCash = cleanUndefined({
        ...accountCash,
        availableCash: accountCash.availableCash + closePrice * closeShares - fee,
        frozenCash: Math.max(0, accountCash.frozenCash - closePrice * closeShares),
        lastUpdated: Date.now(),
        updatedAt: Date.now(),
      } as any);
      await db.accountCash.put(updateCash as any);

      return transaction;
    },
  );
}

// ============================================================
// Unified LedgerService facade
// All DB access is concentrated here; UI components must route
// every read/write through this object instead of importing `db`.
// ============================================================
/** 统一账本服务门面：UI 组件应通过该对象读写数据，禁止直接 import `db` */
export const ledgerService = {
  getFeeConfig,
  getPositionsWithStockInfo,
  getTRoundsWithTransactions,
  createPosition,
  addBatchToPosition,
  updatePositionById,
  deleteBatchForPosition,
  removePositionById,
  applyStreamRecord,
  transferToPositionService,
  settleShortRoundService,
  addPositionTransaction,
  closePosition,
  deletePositionBatch,
  removePosition,
  appendTSlice,
};