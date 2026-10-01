/**
 * look 变换（曲线家族 A/B/C）的 TS 逐像素实现。
 *
 * 数学与 src/film/pipeline.ts 的 GRADE_FS（GLSL）逐式对应：
 *   1) 家族B 正片反S（contrast）→ 家族A 电影负片软S（film_s），逐通道；
 *   2) 染料耦合 dyeCross（通道串扰矩阵；R18 起六系数可调，缺省=历史固定矩阵）；
 *   3) 暗部青蓝 / 高光暖黄 分通道反向偏置（按亮度幂加权）；
 *   3b) 分离色调（R8）；
 *   3c) HSL 8 色相（R18；可选维度，缺省/全 0 = 逐位恒等，仅网页与 .cube 承载）；
 *   4) 褪色（黑位提升 + 白位收拢）；
 *   5) 饱和（向亮度收敛）→ 冷暖（RGB 乘性微移）。
 *
 * 用途：与色彩匹配变换复合后烘焙 3D LUT（预览与 .cube 导出同源），
 * 因此 neutral（全默认）时必须严格恒等，且整条曲线可被 65³ LUT 忠实重建
 * （逐像素纯函数，不依赖邻域/位置）。
 * 本文件为 engine 目录新增文件，不修改既有稳定代码。
 */
import { RGB } from './types';

/** look 参数（结构与 src/film/params.ts 的 LookParams 结构兼容，engine 不反向依赖 film） */
export interface LookParams {
  /** 褪色总量（黑位提升 + 白位收拢） */
  fade: number;
  /** 黑位提升 */
  black_lift: number;
  /** 染料耦合（通道串扰矩阵强度） */
  dye_coupling: number;
  /** 暗部青蓝偏置 */
  shadow_bias: number;
  /** 高光暖黄偏置 */
  highlight_bias: number;
  /** 家族A 电影负片软S 强度 */
  film_s: number;
  /** 家族B 正片反S 强度 */
  contrast: number;
  /** 饱和（1 = 不变） */
  saturation: number;
  /** 冷暖（-1 冷 → 1 暖） */
  warmth: number;
  /** 分离色调（Schema v1.2）：暗部色相 0..1（0=红 → 0.33=绿 → 0.66=蓝） */
  split_shadow_hue: number;
  /** 分离色调：暗部饱和度 0..1（0 = 恒等） */
  split_shadow_sat: number;
  /** 分离色调：高光色相 0..1 */
  split_highlight_hue: number;
  /** 分离色调：高光饱和度 0..1（0 = 恒等） */
  split_highlight_sat: number;
  /** 分离色调：平衡 -1..1（0 中性；负 → 偏暗部权重，正 → 偏高光权重） */
  split_balance: number;
  /** R18 染料串扰六系数（off-diagonal；缺省 = DEFAULT_COUPLING = 历史固定矩阵，逐位兼容） */
  coupling?: Partial<CouplingCoeffs>;
  /** R18 HSL 8 色相（可选维度；缺省/全 0 = 恒等。仅网页预览与 .cube 承载，不进 DCTL） */
  hsl?: Partial<HslAdjustments>;
}

/** 全中性 look：lookTransform(NEUTRAL_LOOK) 对任意输入严格恒等 */
export const NEUTRAL_LOOK: LookParams = {
  fade: 0,
  black_lift: 0,
  dye_coupling: 0,
  shadow_bias: 0,
  highlight_bias: 0,
  film_s: 0,
  contrast: 0,
  saturation: 1,
  warmth: 0,
  split_shadow_hue: 0,
  split_shadow_sat: 0,
  split_highlight_hue: 0,
  split_highlight_sat: 0,
  split_balance: 0,
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const smoothstep = (a: number, b: number, x: number): number => {
  if (b <= a) return x >= b ? 1 : 0;
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/* ---------------- R18 染料串扰六系数（单一真源；GLSL/对数域/DCTL 四处逐式镜像） ----------------
 * 语义（冻结，改这里即改四处）：有效串扰矩阵 M = I + k·(C − I)，k = dye_coupling（总强度），
 * C 为「完全串扰矩阵」：非对角 = coupling 六系数（可调），对角 = 乳剂自抑制先验（冻结常量
 * 0 / 0.2 / −0.6，不进 UI/面板）。C − I 的对角即 (−1, −0.8, −1.6)。
 * DEFAULT_COUPLING = 历史固定矩阵的对应项 → 旧配方（无 coupling 字段或全默认）逐位等于
 * R18 之前的输出（k=0 时六系数不参与，任意 coupling 均恒等）。
 * 键名约定：XY = X 行（输出通道）× Y 列（输入通道），如 rg = G 串入 R 的强度。 */
export interface CouplingCoeffs {
  rg: number; rb: number;
  gr: number; gb: number;
  br: number; bg: number;
}
/** 默认 = 历史固定矩阵 off-diagonal（R4 冻结值；改这里即破坏逐位兼容，禁止） */
export const DEFAULT_COUPLING: CouplingCoeffs = { rg: 0.55, rb: 0.30, gr: 0.35, gb: 0.45, br: 0.25, bg: 0.35 };
/** 对角自抑制（C 的对角 = 0 / 0.2 / −0.6 → C−I 的对角），冻结不进 UI */
export const COUPLING_DIAG = [-1, -0.8, -1.6] as const;
/** 六系数合法区间（防御 JSON 脏数据；1 = 与历史固定矩阵同量级的强串扰） */
export const COUPLING_COEFF_MAX = 2;

const clampCoeff = (v: number | undefined, d: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return d;
  return Math.min(COUPLING_COEFF_MAX, Math.max(0, v));
};

/** 归一（补默认 + 钳区间）：任意 Partial 输入 → 完整六系数 */
export function normalizeCoupling(c?: Partial<CouplingCoeffs>): CouplingCoeffs {
  return {
    rg: clampCoeff(c?.rg, DEFAULT_COUPLING.rg),
    rb: clampCoeff(c?.rb, DEFAULT_COUPLING.rb),
    gr: clampCoeff(c?.gr, DEFAULT_COUPLING.gr),
    gb: clampCoeff(c?.gb, DEFAULT_COUPLING.gb),
    br: clampCoeff(c?.br, DEFAULT_COUPLING.br),
    bg: clampCoeff(c?.bg, DEFAULT_COUPLING.bg),
  };
}

/** coupling 是否与默认逐字段相等（GLSL uniform / GPU 烘焙回退判断用） */
export function couplingIsDefault(c?: Partial<CouplingCoeffs>): boolean {
  return !c || (c.rg === DEFAULT_COUPLING.rg && c.rb === DEFAULT_COUPLING.rb && c.gr === DEFAULT_COUPLING.gr
    && c.gb === DEFAULT_COUPLING.gb && c.br === DEFAULT_COUPLING.br && c.bg === DEFAULT_COUPLING.bg);
}

/* ---------------- Schema v1.2 分离色调（单一真源；GLSL/对数域/DCTL 四处逐式镜像） ----------------
 * 数学定义（冻结，改这里即改四处）：
 *   1) 色相 → RGB 倾向：6 段线性色相轮（h*6 落在哪一段取 (1,f,0)/(q,1,0)/(0,1,f)/(0,q,1)/(f,0,1)/(1,0,q)，
 *      q=1-f），再减去自身 Rec.709 亮度 → 得到零亮度方向向量（只改色相不改整体明暗）。
 *   2) 权重：沿用 shadow_bias/highlight_bias 的亮度幂曲线 sh=(1-l)^2.2 / hi=l^2.2；
 *      split_balance=b∈[-1,1] 按 (1-0.5b) / (1+0.5b) 调整暗部/高光权重比（b=0 恒等）。
 *   3) 叠加：rgb += SPLIT_SCALE * (dirS * split_shadow_sat * wS + dirH * split_highlight_sat * wH)。
 *   sat=0 时贡献恒为 +0（浮点精确），故分离色调在默认值/零饱和度下逐位恒等。 */
export const SPLIT_SCALE = 0.2;
export const SPLIT_BALANCE_FACTOR = 0.5;

/** 色相 → 零亮度 RGB 方向向量（h 任意实数，内部按小数部分环绕；返回 Rec.709 加权亮度为 0 的方向，故只改色相不改整体明暗） */
export function splitHueRGB(hue: number): RGB {
  const h = ((hue % 1) + 1) % 1;
  const h6 = h * 6;
  const i = Math.floor(h6) % 6;
  const f = h6 - Math.floor(h6);
  const q = 1 - f;
  let raw: RGB;
  if (i === 0) raw = [1, f, 0];
  else if (i === 1) raw = [q, 1, 0];
  else if (i === 2) raw = [0, 1, f];
  else if (i === 3) raw = [0, q, 1];
  else if (i === 4) raw = [f, 0, 1];
  else raw = [1, 0, q];
  const l = LUMA_R * raw[0] + LUMA_G * raw[1] + LUMA_B * raw[2];
  return [raw[0] - l, raw[1] - l, raw[2] - l];
}

/** 平衡 → 暗部/高光权重增益（b=0 → {1,1} 恒等；b>0 抬高光、b<0 抬暗部） */
export function splitBalanceGains(balance: number): { shadow: number; highlight: number } {
  const b = Math.min(1, Math.max(-1, balance));
  return { shadow: 1 - SPLIT_BALANCE_FACTOR * b, highlight: 1 + SPLIT_BALANCE_FACTOR * b };
}

/* ---------------- R18 HSL 8 色相（单一真源；GLSL GRADE_FS 逐式镜像） ----------------
 * LR HSL 语义近似（冻结，改这里即改 GLSL 镜像）：
 *   1) 8 窄带色相中心 = LR 色相轮（红 0° / 橙 30° / 黄 60° / 绿 120° / 青 180° / 蓝 240° /
 *      紫 280° / 品红 320°，单位=圈 0..1）；权重按色相圆距平滑衰减（CORE..EDGE），再按总和
 *      归一（相邻带最大间隔 60° = 2×EDGE，全轮无死区）。
 *   2) hue ±1 → ±30°（LR HueAdjustment 满量程 ±30°）；sat ±1 → 饱和 ×(1±0.75)；
 *      lum ±1 → 明度 ×(1±0.30)。方向与 LR 一致：正 hue = 顺时针（红→橙）。
 *   3) 权重从原始色相计算（不随 hue 偏移重算）；灰（s=0）不受 hue/sat 影响、lum 仍生效。
 *   4) 全 0（或 hsl 缺省）→ 整段跳过（逐位恒等，不做 HSV 往返）。 */
export const HSL_HUES = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
export type HslHueKey = (typeof HSL_HUES)[number];
/** 单色相通道：hue/sat/lum 各 −1..1（0 = 不调整） */
export interface HslChannel { hue: number; sat: number; lum: number }
/** 8 色相 × 3 通道（Partial 任意键缺省按 0） */
export type HslAdjustments = Record<HslHueKey, HslChannel>;
/** 色相带中心（圈数 0..1；与 GLSL HSL_C 逐值一致） */
export const HSL_BAND_CENTERS: readonly number[] = [0, 1 / 12, 1 / 6, 1 / 3, 0.5, 2 / 3, 7 / 9, 8 / 9];
/** 带宽：CORE 内全权重、EDGE 外零权重（相邻带最大间隔 60° = 2×EDGE → 全轮覆盖） */
export const HSL_CORE = 1 / 24;   // 15°
export const HSL_EDGE = 1 / 8;    // 45°
export const HSL_HUE_SCALE = 30 / 360;  // hue ±1 → ±30°
export const HSL_SAT_GAIN = 0.75;       // sat ±1 → 饱和 ×(1±0.75)
export const HSL_LUM_GAIN = 0.30;       // lum ±1 → 明度 ×(1±0.30)

/** 8 色相是否全 0（全 0 = 恒等，跳过整段） */
export function hslIsIdentity(hsl?: Partial<HslAdjustments>): boolean {
  if (!hsl) return true;
  for (const key of HSL_HUES) {
    const ch = hsl[key];
    if (!ch) continue;
    if ((ch.hue ?? 0) !== 0 || (ch.sat ?? 0) !== 0 || (ch.lum ?? 0) !== 0) return false;
  }
  return true;
}

/** RGB → HSV（h 0..1 / s,v 0..1；纯灰 h=0） */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    const rr = (mx - r) / d, gg = (mx - g) / d, bb = (mx - b) / d;
    const hh = mx === r ? bb - gg : mx === g ? 2 + rr - bb : 4 + gg - rr;
    h = hh / 6;
    if (h < 0) h += 1;
  }
  return [h, mx <= 0 ? 0 : d / mx, mx];
}

/** HSV → RGB（与 rgbToHsv 互逆到浮点精度） */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const h6 = ((h % 1) + 1) % 1 * 6;
  const i = Math.floor(h6) % 6;
  const f = h6 - Math.floor(h6);
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  if (i === 0) return [v, t, p];
  if (i === 1) return [q, v, p];
  if (i === 2) return [p, v, t];
  if (i === 3) return [p, q, v];
  if (i === 4) return [t, p, v];
  return [v, p, q];
}

/** 单色相权重（圆距平滑衰减，未归一）：与 GLSL hslBandWeight 同式 */
export function hslBandWeight(hue: number, center: number): number {
  let d = Math.abs(hue - center);
  if (d > 0.5) d = 1 - d;
  return 1 - smoothstep(HSL_CORE, HSL_EDGE, d);
}

/** HSL 8 色相调整（显示域；输入先钳到 0..1）。全 0 通道贡献为 0；调用方负责全 0 时跳过。 */
export function hslAdjustRgb(rgb: readonly number[], hsl: Partial<HslAdjustments>): [number, number, number] {
  const r = clamp01(rgb[0]), g = clamp01(rgb[1]), b = clamp01(rgb[2]);
  const [h0, s0, v0] = rgbToHsv(r, g, b);
  let wSum = 0, dHue = 0, dSat = 0, dLum = 0;
  for (let i = 0; i < 8; i++) {
    const ch = hsl[HSL_HUES[i]];
    if (!ch) continue;
    const hue = ch.hue ?? 0, sat = ch.sat ?? 0, lum = ch.lum ?? 0;
    if (hue === 0 && sat === 0 && lum === 0) continue;
    const w = hslBandWeight(h0, HSL_BAND_CENTERS[i]);
    if (w <= 0) continue;
    wSum += w;
    dHue += w * hue;
    dSat += w * sat;
    dLum += w * lum;
  }
  if (wSum <= 0) return [r, g, b];
  const wn = 1 / wSum;
  const h1 = h0 + dHue * wn * HSL_HUE_SCALE;
  const s1 = Math.min(1, Math.max(0, s0 * (1 + dSat * wn * HSL_SAT_GAIN)));
  const v1 = Math.min(1, Math.max(0, v0 * (1 + dLum * wn * HSL_LUM_GAIN)));
  return hsvToRgb(h1, s1, v1);
}

/** 家族A 参考曲线（与 GLSL refS / pipeline CPU refS 同式）：黑位锚定 0.030、中段斜率 0.76@0.42、肩部 hermite 保白点 */
export function refCurveA(x: number): number {
  const lin = 0.42 + (x - 0.42) * 0.76;
  const toe = 0.03 + (lin - 0.03) * Math.pow(clamp01(x / 0.42), 0.75);
  let y = toe + (lin - toe) * smoothstep(0.02, 0.24, x);
  if (x > 0.55) {
    const u = (x - 0.55) / 0.45;
    y = 0.5188 + u * (0.342 + u * (0.7596 - u * 0.6204));
  }
  return y;
}

/** 家族A 软S（负片观感），s=0 退化为恒等 */
function shapeNeg(x: number, s: number): number {
  return s <= 0.001 ? x : x + (refCurveA(x) - x) * s;
}

/** 家族B 正片反S：端点斜率 0、中点斜率 1.5、黑位压实，s=0 退化为恒等 */
function shapePos(x: number, s: number): number {
  return s <= 0.001 ? x : x + (x * x * (3 - 2 * x) - x) * s;
}

/** 染料耦合通道串扰矩阵（k=0 时为单位阵；六系数缺省 = 历史固定矩阵，逐位兼容） */
function dyeCross(r: number, g: number, b: number, k: number, coupling: CouplingCoeffs, out: RGB): void {
  out[0] = r * (1 - k) + g * (k * coupling.rg) + b * (k * coupling.rb);
  out[1] = r * (k * coupling.gr) + g * (1 - k * 0.8) + b * (k * coupling.gb);
  out[2] = r * (k * coupling.br) + g * (k * coupling.bg) + b * (1 - k * 1.6);
}

/**
 * 构建 look 变换 f(rgb) -> rgb。
 * neutral look 恒等；输出钳制到 [0,1]（sRGB gamma 空间）。
 * 参数越界值会被钳制到合理区间（防御 JSON 导入的脏数据）。
 */
export function lookTransform(look: LookParams): (rgb: RGB) => RGB {
  const fade = clamp01(look?.fade ?? 0);
  const black = clamp01(look?.black_lift ?? 0);
  const coupling = Math.min(0.5, Math.max(0, look?.dye_coupling ?? 0));
  const shBias = Math.min(1, Math.max(-1, look?.shadow_bias ?? 0));
  const hiBias = Math.min(1, Math.max(-1, look?.highlight_bias ?? 0));
  const filmS = clamp01(look?.film_s ?? 0);
  const contrast = clamp01(look?.contrast ?? 0);
  const sat = Math.min(2, Math.max(0, look?.saturation ?? 1));
  const warm = Math.min(1, Math.max(-1, look?.warmth ?? 0));
  const spShHue = clamp01(look?.split_shadow_hue ?? 0);
  const spShSat = clamp01(look?.split_shadow_sat ?? 0);
  const spHiHue = clamp01(look?.split_highlight_hue ?? 0);
  const spHiSat = clamp01(look?.split_highlight_sat ?? 0);
  const spBal = Math.min(1, Math.max(-1, look?.split_balance ?? 0));
  /* R18：串扰六系数（缺省 = 历史固定矩阵）与 HSL（缺省/全 0 = 恒等） */
  const coup = normalizeCoupling(look?.coupling);
  const hsl = look?.hsl;
  const hslOn = !hslIsIdentity(hsl);
  /* 两个饱和度都为 0 时分离色调贡献恒为 +0（色相/平衡不影响），故中性判定只看饱和度 */
  const splitOn = spShSat > 0 || spHiSat > 0;

  const neutral =
    fade === 0 && black === 0 && coupling === 0 && shBias === 0 && hiBias === 0 &&
    filmS === 0 && contrast === 0 && sat === 1 && warm === 0 && !splitOn && !hslOn;

  if (neutral) {
    // 严格恒等（含引用语义：返回输入的拷贝，避免调用方复用缓冲被改写）
    return (rgb) => [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];
  }

  const blk = black + fade * 0.1;
  const wht = fade * 0.08;
  const c0: RGB = [0, 0, 0];
  /* 分离色调：色相方向与平衡增益与像素无关，循环外预算 */
  const splitGains = splitBalanceGains(spBal);
  const splitDS = splitOn ? splitHueRGB(spShHue) : [0, 0, 0] as RGB;
  const splitDH = splitOn ? splitHueRGB(spHiHue) : [0, 0, 0] as RGB;
  const splitSS = SPLIT_SCALE * spShSat * splitGains.shadow;
  const splitHS = SPLIT_SCALE * spHiSat * splitGains.highlight;

  return (rgb: RGB): RGB => {
    let r = clamp01(rgb[0]);
    let g = clamp01(rgb[1]);
    let b = clamp01(rgb[2]);
    // 1) 曲线家族：先家族B（正片反S）后家族A（软S），与 GLSL 一致
    r = shapeNeg(shapePos(r, contrast), filmS);
    g = shapeNeg(shapePos(g, contrast), filmS);
    b = shapeNeg(shapePos(b, contrast), filmS);
    // 2) 染料耦合（六系数：缺省 = 历史固定矩阵，逐位兼容；k=0 恒等）
    dyeCross(r, g, b, coupling, coup, c0);
    r = c0[0];
    g = c0[1];
    b = c0[2];
    // 3) 分通道反向偏置：暗部青、高光黄（按亮度 ^2.2 加权）
    const l = LUMA_R * r + LUMA_G * g + LUMA_B * b;
    const sh = Math.pow(clamp01(1 - l), 2.2);
    const hi = Math.pow(clamp01(l), 2.2);
    r += shBias * -0.1 * sh + hiBias * 0.1 * hi;
    g += shBias * 0.02 * sh + hiBias * 0.08 * hi;
    b += shBias * 0.16 * sh + hiBias * -0.18 * hi;
    // 3b) 分离色调：暗部/高光各自色相方向 × 饱和度 × 亮度权重（sat=0 时贡献为 +0）
    if (splitOn) {
      r += splitDS[0] * splitSS * sh + splitDH[0] * splitHS * hi;
      g += splitDS[1] * splitSS * sh + splitDH[1] * splitHS * hi;
      b += splitDS[2] * splitSS * sh + splitDH[2] * splitHS * hi;
    }
    // 3c) R18 HSL 8 色相（显示域；缺省/全 0 跳过 → 逐位恒等；仅网页与 .cube 承载）
    if (hslOn) {
      [r, g, b] = hslAdjustRgb([r, g, b], hsl!);
    }
    // 4) 褪色：黑位提升 + 白位收拢
    r = clamp01(r);
    g = clamp01(g);
    b = clamp01(b);
    r = blk + r * (1 - blk - wht);
    g = blk + g * (1 - blk - wht);
    b = blk + b * (1 - blk - wht);
    // 5) 饱和 + 冷暖
    const l2 = LUMA_R * r + LUMA_G * g + LUMA_B * b;
    r = (l2 + (r - l2) * sat) * (1 + warm * 0.05);
    g = (l2 + (g - l2) * sat) * (1 + warm * 0.01);
    b = (l2 + (b - l2) * sat) * (1 - warm * 0.05);
    return [clamp01(r), clamp01(g), clamp01(b)];
  };
}
