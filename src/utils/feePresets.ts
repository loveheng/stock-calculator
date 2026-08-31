/**
 * @file feePresets.ts
 * @description 费率模板常量。纯常量、无副作用，仅依赖类型定义，供 store、视图与导入导出共用。
 *              （原先位于 store/feePresets.ts；因 utils 层禁止依赖 store，常量模块统一下沉至本层）
 * @layer Utility (Constants)
 * @author 开发团队
 */
import type { FeeConfig } from './mathUtils';
import type { FeePresetName } from '../types/domain';

export const DEFAULT_FEE_CONFIG: FeeConfig = {
  commissionRate: 0.00025, isFreeFive: false, minCommission: 0.5,
  transferRate: 0.00001, stampRate: 0.0005,
  exchangeFeeRate: 0, regulatoryFeeRate: 0,
  etfCommissionRate: 0.00025, etfIsFreeFive: true, etfMinCommission: 0.2,
  etfTransferRate: 0, etfStampRate: 0,
  etfExchangeFeeRate: 0,
};

export const FEE_PRESETS: Record<FeePresetName, FeeConfig> = {
  '默认A股': { commissionRate: 0.00025, isFreeFive: false, minCommission: 0.5, transferRate: 0.00001, stampRate: 0.0005, exchangeFeeRate: 0, regulatoryFeeRate: 0, etfCommissionRate: 0.00025, etfIsFreeFive: true, etfMinCommission: 0.2, etfTransferRate: 0, etfStampRate: 0, etfExchangeFeeRate: 0 },
  'A股标准模板': { commissionRate: 0.00025, isFreeFive: false, minCommission: 0.5, transferRate: 0.00001, stampRate: 0.0005, exchangeFeeRate: 0, regulatoryFeeRate: 0, etfCommissionRate: 0.00025, etfIsFreeFive: true, etfMinCommission: 0.2, etfTransferRate: 0, etfStampRate: 0, etfExchangeFeeRate: 0 },
  'ETF模板': { commissionRate: 0.00025, isFreeFive: true, minCommission: 0.2, transferRate: 0, stampRate: 0, exchangeFeeRate: 0, regulatoryFeeRate: 0, etfCommissionRate: 0.00025, etfIsFreeFive: true, etfMinCommission: 0.2, etfTransferRate: 0, etfStampRate: 0, etfExchangeFeeRate: 0 },
  '港股/美股免佣模板': { commissionRate: 0.0001, isFreeFive: true, minCommission: 0.5, transferRate: 0.000025, stampRate: 0.0013, exchangeFeeRate: 0, regulatoryFeeRate: 0, etfCommissionRate: 0.0001, etfIsFreeFive: true, etfMinCommission: 0.2, etfTransferRate: 0, etfStampRate: 0, etfExchangeFeeRate: 0 },
};

/** @deprecated Use FEE_PRESETS. Alias for backward compatibility. */
export const FEE_TEMPLATES = FEE_PRESETS;