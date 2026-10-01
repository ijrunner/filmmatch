/**
 * 引擎公共类型。本文件接口签名冻结，UI / 导出层 / 配方系统直接消费。
 *
 * 工作空间约定：RGB 分量为 sRGB gamma 编码（非线性）的 0..1 取值；
 * 统计与明度映射内部使用 CIELAB（D65 白点）。
 */

/** 9 参数色彩匹配配置，对应配方 Schema v1 的 engine.color.params */
export interface MatchParams {
  /** 0..1 整体匹配强度（作用于统计对齐：明度分区 + 全局色偏） */
  match_strength: number;
  /** -1..1 肤色色相微移（正值向黄），仅在肤色掩码内生效 */
  skin_hue: number;
  /** 0..2 肤色饱和系数（1=不变），仅在肤色掩码内生效 */
  skin_sat: number;
  /** 0..1 肤色保护强度（1=完全保护）：掩码内抑制参考图派生的色偏/分离色调 */
  skin_isolation: number;
  /** 0..1 分离色调强度（目标色由参考图阴影/高光平均色度推导） */
  split_tone: number;
  /** 0..2 中间调对比（1=不变），绕 L=50 的单调 S 曲线 */
  tone_contrast: number;
  /** 0..1 黑位提升 */
  shadow_lift: number;
  /** 0..2 全局饱和（1=不变），最后施加 */
  global_sat: number;
  /** 0..1 高光肩部滚降（保白点 1.0） */
  highlight_rolloff: number;
}

/** sRGB gamma 空间三元组，取值 0..1（引擎输出会钳制到该区间） */
export type RGB = [number, number, number];

/** 全中性参数：对任意输入恒等 */
export const NEUTRAL_PARAMS: MatchParams = {
  match_strength: 0,
  skin_hue: 0,
  skin_sat: 1,
  skin_isolation: 0,
  split_tone: 0,
  tone_contrast: 1,
  shadow_lift: 0,
  global_sat: 1,
  highlight_rolloff: 0,
};

const clamp = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;

/**
 * 把任意（可能来自 JSON/用户输入的）参数收敛到合法区间，
 * 非法值回退为中性值。UI 存储前与引擎入口各调用一次均可。
 */
export function normalizeParams(p: Partial<MatchParams> | null | undefined): MatchParams {
  const n = NEUTRAL_PARAMS;
  return {
    match_strength: clamp(p?.match_strength ?? n.match_strength, 0, 1),
    skin_hue: clamp(p?.skin_hue ?? n.skin_hue, -1, 1),
    skin_sat: clamp(p?.skin_sat ?? n.skin_sat, 0, 2),
    skin_isolation: clamp(p?.skin_isolation ?? n.skin_isolation, 0, 1),
    split_tone: clamp(p?.split_tone ?? n.split_tone, 0, 1),
    tone_contrast: clamp(p?.tone_contrast ?? n.tone_contrast, 0, 2),
    shadow_lift: clamp(p?.shadow_lift ?? n.shadow_lift, 0, 1),
    global_sat: clamp(p?.global_sat ?? n.global_sat, 0, 2),
    highlight_rolloff: clamp(p?.highlight_rolloff ?? n.highlight_rolloff, 0, 1),
  };
}
