/**
 * 色彩匹配引擎公共出口。UI / 导出层从这里导入，
 * 具体签名约定见各模块（types 签名冻结）。
 */
export type { MatchParams, RGB } from './types';
export { NEUTRAL_PARAMS, normalizeParams } from './types';
export {
  deltaE76,
  labToRgbInto,
  linearToSrgb,
  rgbToLab,
  rgbToLabInto,
  srgbToLinear,
} from './color';
export type { ImageStats, ZoneStats } from './stats';
export {
  analyzeImage,
  neutralSourceStats,
  withSource,
  zoneWeights,
} from './stats';
export { buildTransform, matchBakeData } from './match';
export type { MatchBakeData } from './match';
export type { DataRange, LUT3D } from './lut';
export { applyLUT, bakeLUT, normalizeDataRange, parseCube, rangeWrap, toCube } from './lut';
