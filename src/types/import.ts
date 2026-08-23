/**
 * @file import.ts
 * @description 批量导入（Batch Import）相关的数据类型契约：暂存行数据模型、业务归类枚举、
 *              防重状态与风控校验状态。作为 OCR / CSV / 剪贴板接入的公共中间层。
 * @layer Types
 * @author 开发团队
 */

import type { DuplicateStatus } from '../utils/dedup';

/** 业务归类：分流过账目标 */
export type ImportTargetCategory =
  | 'LONG_TERM_BATCH' // 关联持仓（中长期底仓批次） -> addBatch
  | 'SHORT_TERM_T' // 关联持仓（短线做T流水） -> addStreamRecord
  | 'BIND_PLANNED_ORDER' // 履约挂载计划单 -> addBatch + markPlanExecuted
  | 'NEW_POSITION'; // 全新开仓 -> addPosition 再记账

/** 卡片组整体风控/防重状态（用于 Summary Bar 徽标） */
export type GroupRiskLevel = 'PASSED' | 'WARNING' | 'ERROR';

/** 风控校验状态（RiskController 回填） */
export type ValidationStatus = 'PENDING' | 'PASSED' | 'WARNING' | 'ERROR';

/** 剪贴板 / OCR / CSV 解析出的原始基础字段（未归类、未关联） */
export interface RawTxRecord {
  fullCode: string;
  stockName?: string;
  timestamp?: number | string;
  direction?: 'buy' | 'sell';
  price?: number;
  amount?: number;
}

/**
 * 暂存区行数据模型（Staging Row）。
 * 一行代表一笔待过账交易，含基础交易信息、业务归类、关联目标、防重状态与风控状态。
 */
export interface ImportDraftRow {
  /** 前端临时行唯一键 */
  id: string;
  /** 确定性交易指纹（代码_方向_价格_数量_日期） */
  fingerprint: string;

  /** 基础交易数据 */
  timestamp: number; // 成交时间戳（ms）
  fullCode: string; // 完整证券代码（含市场前缀，如 sh600519）
  stockName?: string;
  direction: 'buy' | 'sell';
  price: number;
  amount: number;

  /** 归类与绑定 */
  targetCategory: ImportTargetCategory;
  targetPositionId?: string; // 绑定的持仓 ID
  targetPlannedOrderId?: string; // 绑定的计划单 ID
  isNewPosition?: boolean; // 无对应 Position 时是否作为全新开仓

  /** 防重状态 */
  duplicateStatus: DuplicateStatus;
  matchedRecordId?: string; // 命中的历史记录 ID
  skipImport: boolean; // 防重/校验拦截时是否为 true（跳过过账）

  /** 风控校验状态 */
  validationStatus: ValidationStatus;
  validationMessage?: string;

  /** 来源系统留痕（'manual' | 'clipboard' | 'ocr' | 'csv'）便于审计 */
  source?: string;
}

/** 应用内跨库历史指纹集合：用于 Cross-Store 防重比对 */
export interface FingerprintHistory {
  /** 历史记录 ID（批次 / 流水 / 计划单 id） */
  id: string;
  source: 'batch' | 'stream' | 'long-term' | 'plan';
  fullCode: string;
  direction: 'buy' | 'sell';
  price: number;
  amount: number;
  timestamp: number;
}