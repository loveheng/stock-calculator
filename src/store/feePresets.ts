/**
 * @file feePresets.ts
 * @description 费率模板常量。从 store/index.ts 拆出，纯常量、无副作用，
 *              仅依赖类型定义，供 store、视图与导入导出共用。
 * @layer Store (Constants)
 * @author 开发团队
 */
import type { FeeConfig } from '../utils/mathUtils';
import type { FeePresetName } from './types';

export const DEFAULT_FEE_CONFIG: FeeConfig = {
  commissionRate: 0.00025, isFreeFive: false, minCommission: 0.5,
  transferRate: 0.00001, stampRate: 0.0005,
  etfCommissionRate: 0.00025, etfIsFreeFive: true, etfMinCommission: 0.2,
  etfTransferRate: 0, etfStampRate: 0,
};

export const FEE_PRESETS: Record<FeePresetName, FeeConfig> = {
  '默认A股': { commissionRate: 0.00025, isFreeFive: false, minCommission: 0.5, transferRate: 0.00001, stampRate: 0.0005, etfCommissionRate: 0.00025, etfIsFreeFive: true, etfMinCommission: 0.2, etfTransferRate: 0, etfStampRate: 0 },
  'A股标准模板': { commissionRate: 0.00025, isFreeFive: false, minCommission: 0.5, transferRate: 0.00001, stampRate: 0.0005, etfCommissionRate: 0.00025, etfIsFreeFive: true, etfMinCommission: 0.2, etfTransferRate: 0, etfStampRate: 0 },
  'ETF模板': { commissionRate: 0.00025, isFreeFive: true, minCommission: 0.2, transferRate: 0, stampRate: 0, etfCommissionRate: 0.00025, etfIsFreeFive: true, etfMinCommission: 0.2, etfTransferRate: 0, etfStampRate: 0 },
  '港股/美股免佣模板': { commissionRate: 0.0001, isFreeFive: true, minCommission: 0.5, transferRate: 0.000025, stampRate: 0.0013, etfCommissionRate: 0.0001, etfIsFreeFive: true, etfMinCommission: 0.2, etfTransferRate: 0, etfStampRate: 0 },
};

/** @deprecated Use FEE_PRESETS. Alias for backward compatibility. */
export const FEE_TEMPLATES = FEE_PRESETS;