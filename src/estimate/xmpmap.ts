/**
 * XMP IR → FilmMatch 参数映射（R15；R18 接管 HSL 与 Calibration.ShadowTint）。
 *
 * 输入 parseXmp() 的中间表示，输出 FilmParams（以 defaultParams() 为底，只写有依据的路径）
 * + origins（全部 'estimated'）+ unmapped（无对应物的维度如实列出）+ warnings（诚实标注）。
 *
 * 设计原则：
 *  - 「估算起点」：曲线族是有损形状反解（明示需人工调校），SplitToning 近似一一对应；
 *  - 恒等护栏：全中性 XMP 映射结果与 defaultParams() 逐字相等（有测试）；
 *  - 所有写出值落在既有参数合法区间内（有测试遍历）；
 *  - HSL 8 色相 → look.hsl（R18 新维度，仅网页预览与 .cube 承载）；Calibration 仅 ShadowTint
 *    可折入 split_shadow（绿↔品红语义对位），三原色 Hue·Saturation 无对应物 → unmapped。
 *
 * 合规：BRAND_WORDS / cleanCardName 用于卡名清洗，产品 UI 不出现第三方品牌词（宁可多洗）。
 */
import { defaultParams, type FilmParams, type Origin } from '../film/params';
import { HSL_HUES, type HslAdjustments, type HslHueKey } from '../engine/look';
import { refCurveA } from '../engine/look';
import type { XmpCurvePoint, XmpIR } from './xmp';
import { curveToFn } from './xmp';

export interface XmpMapping {
  params: FilmParams;
  /** 被本次映射写出的参数路径（如 look.film_s / look.hsl.red.hue / grain.size）→ 一律 'estimated' */
  origins: Record<string, Origin>;
  /** 无对应物的 XMP 维度（分组名或键名，如实列出） */
  unmapped: string[];
  /** 人工复核提示（有损映射 / 方向不支持 / 未识别键等） */
  warnings: string[];
}

/* ---------------- 小工具 ---------------- */

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const smooth01 = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const smoothstep = (a: number, b: number, x: number): number => {
  if (b <= a) return x >= b ? 1 : 0;
  return smooth01((x - a) / (b - a));
};
/** 写出值统一保留 4 位小数（与配方 Schema 的 toFixed(4) 口径一致） */
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

type CurveFn = (x: number) => number;

/* ---------------- 第 1 步：把 XMP 曲线输入折叠成一条 0..1 亮度曲线 ----------------
 * 折叠只是「特征提取」的近似（不用于渲染）：顺序 = 点曲线 → 参数曲线 → 分区滑杆 → Contrast2012。
 * 各分组尺度是工程近似，反解精度由后面的拟合误差评估并如实警告。 */

/** 参数曲线（Parametric）±100 折算到 ±0.30 的曲线位移 */
const PARAMETRIC_SCALE = 0.3;
/** Highlights/Shadows/Whites/Blacks2012 ±100 的折算尺度 */
const RANGE_HIGHLIGHT_SCALE = 0.22;
const RANGE_SHADOW_SCALE = 0.22;
const RANGE_WHITE_SCALE = 0.35;
const RANGE_BLACK_SCALE = 0.35;

function applyParametric(y: number, x: number, ir: XmpIR): number {
  const dSh = (ir.parametricShadows ?? 0) / 100;
  const dDa = (ir.parametricDarks ?? 0) / 100;
  const dLi = (ir.parametricLights ?? 0) / 100;
  const dHi = (ir.parametricHighlights ?? 0) / 100;
  if (dSh === 0 && dDa === 0 && dLi === 0 && dHi === 0) return y;
  const u1 = clamp01((ir.parametricShadowSplit ?? 25) / 100);
  const u2 = clamp01((ir.parametricMidtoneSplit ?? 50) / 100);
  const u3 = clamp01((ir.parametricHighlightSplit ?? 75) / 100);
  /* 四带权重（和恒为 1）：各带跨相邻分档 smoothstep 过渡 */
  const a = smoothstep(u1, u2, x);
  const b = smoothstep(u2, u3, x);
  const c = smoothstep(u3, 1, x);
  const wSh = 1 - a, wDa = a * (1 - b), wLi = b * (1 - c), wHi = c;
  return y + PARAMETRIC_SCALE * (dSh * wSh + dDa * wDa + dLi * wLi + dHi * wHi);
}

function applyRangeSliders(y: number, x: number, ir: XmpIR): number {
  let out = y;
  const hi = (ir.highlights2012 ?? 0) / 100;
  const sh = (ir.shadows2012 ?? 0) / 100;
  const wh = (ir.whites2012 ?? 0) / 100;
  const bl = (ir.blacks2012 ?? 0) / 100;
  if (hi !== 0) out += RANGE_HIGHLIGHT_SCALE * hi * smoothstep(0.3, 1.0, x);
  if (sh !== 0) out += RANGE_SHADOW_SCALE * sh * (1 - smoothstep(0.0, 0.7, x));
  if (wh !== 0) out += RANGE_WHITE_SCALE * wh * smoothstep(0.7, 1.0, x);
  if (bl !== 0) out += RANGE_BLACK_SCALE * bl * (1 - smoothstep(0.0, 0.3, x));
  return out;
}

function applyContrast2012(y: number, ir: XmpIR): number {
  const c = (ir.contrast2012 ?? 0) / 100;
  if (c === 0) return y;
  /* 与引擎家族B 同形（smoothstep S），方向一致：+ → 提反差，− → 压反差 */
  return y + c * (smooth01(y) - y);
}

/** 特征采样点：0..1 步长 0.05（x=0 锚定黑位；x=1 由 fade 先验吸收） */
const FAMILY_SAMPLES: number[] = Array.from({ length: 21 }, (_, i) => i * 0.05);

/** 折叠全部曲线输入为一条亮度曲线；没有任何非零输入、或点曲线与恒等无异时返回 null
 * （= 曲线族未被触碰，映射侧不写 film_s/contrast/fade/black_lift）。 */
function buildMeasuredCurve(ir: XmpIR): CurveFn | null {
  const hasSliders = [ir.contrast2012, ir.highlights2012, ir.shadows2012, ir.whites2012, ir.blacks2012,
    ir.parametricShadows, ir.parametricDarks, ir.parametricLights, ir.parametricHighlights,
  ].some((v) => v !== undefined && v !== 0);
  const base = curveToFn(ir.toneCurvePV2012);
  if (!hasSliders && !base) return null;
  const f: CurveFn = (x) => {
    let y = base ? base(x) : x;
    y = applyParametric(y, x, ir);
    y = applyRangeSliders(y, x, ir);
    y = applyContrast2012(y, ir);
    return clamp01(y);
  };
  if (!hasSliders) {
    let identity = true;
    for (const x of FAMILY_SAMPLES) {
      if (Math.abs(f(x) - x) > 1e-6) { identity = false; break; }
    }
    if (identity) return null;
  }
  return f;
}

/* ---------------- 第 2 步：曲线族反解（有损，估算起点） ----------------
 * 引擎合成顺序（engine/look.ts，与 GLSL 同式）：
 *   out = blk + shapeNeg(shapePos(x, contrast), film_s) × (1 − blk − wht)
 *   其中 blk = black_lift + fade×0.1（黑位），wht = fade×0.08（白位收拢）。
 * 反解策略：
 *   1) 白位：家族端点恒为 1 → F1 = f(1) 的亏空全部来自 fade → fade = (1−F1)/0.08（钳 0..1）；
 *   2) 黑位/对比/软S：对 (blk, contrast, film_s) 三参数做 21³ 粗网格 + ±0.05 细化的
 *      最小二乘拟合（采样 0..1 步长 0.05，拟合目标 = 含 fade 变换的完整引擎式），
 *      家族B 在前、家族A 在后，与引擎同序；fit 直接吸收乳剂趾（0.03×film_s）对黑位的贡献；
 *   3) black_lift = blk − fade×0.1（负值取 0 并警告：引擎 fade 必然连带抬黑位）；
 *   4) 拟合残差如实折算成 maxDev 警告（「估算起点，需人工调校」）。 */

/* 与 engine/look.ts 同式的两个家族形变（此处只做拟合评估，不改引擎） */
function shapePos(x: number, s: number): number {
  return s <= 0.001 ? x : x + (x * x * (3 - 2 * x) - x) * s;
}
function shapeNeg(x: number, s: number): number {
  return s <= 0.001 ? x : x + (refCurveA(x) - x) * s;
}

interface CurveFit { blk: number; contrast: number; filmS: number; maxDev: number }

function fitCurveFamily(f: CurveFn, wht: number): CurveFit {
  const err = (blk: number, c: number, fs: number): number => {
    let sum = 0;
    for (const x of FAMILY_SAMPLES) {
      const y = blk + shapeNeg(shapePos(x, c), fs) * (1 - blk - wht);
      const d = y - f(x);
      sum += d * d;
    }
    return sum;
  };
  let bestBlk = 0, bestC = 0, bestF = 0, bestE = err(0, 0, 0);
  for (let i = 0; i <= 20; i++) {
    for (let j = 0; j <= 20; j++) {
      for (let k = 0; k <= 20; k++) {
        const e = err(i / 20, j / 20, k / 20);
        if (e < bestE - 1e-12) { bestE = e; bestBlk = i / 20; bestC = j / 20; bestF = k / 20; }
      }
    }
  }
  for (let di = -5; di <= 5; di++) {
    for (let dj = -5; dj <= 5; dj++) {
      for (let dk = -5; dk <= 5; dk++) {
        const blk = clamp(bestBlk + di * 0.01, 0, 1);
        const c = clamp01(bestC + dj * 0.01);
        const fs = clamp01(bestF + dk * 0.01);
        const e = err(blk, c, fs);
        if (e < bestE - 1e-12) { bestE = e; bestBlk = blk; bestC = c; bestF = fs; }
      }
    }
  }
  let maxDev = 0;
  for (const x of FAMILY_SAMPLES) {
    const y = bestBlk + shapeNeg(shapePos(x, bestC), bestF) * (1 - bestBlk - wht);
    maxDev = Math.max(maxDev, Math.abs(y - f(x)));
  }
  return { blk: bestBlk, contrast: bestC, filmS: bestF, maxDev };
}

const MAX_DEV_WARN = 0.06;

function invertCurveFamily(f: CurveFn, warnings: string[]): CurveFit & { fade: number; blackLift: number } {
  const F1 = clamp01(f(1));
  const fadeRaw = (1 - F1) / 0.08;
  const fade = clamp01(fadeRaw);
  if (fadeRaw > 1.05) {
    warnings.push(`白位收拢 ${(1 - F1).toFixed(2)} 超出引擎 fade 可表达范围（上限 0.08），已取 fade=1：高光会比原预设更亮。`);
  }
  const wht = Math.min(0.5, fade * 0.08);
  const fit = fitCurveFamily(f, wht);

  const blackLift = clamp01(fit.blk - 0.1 * fade);
  if (fit.blk - 0.1 * fade < -1e-6 && fade > 0.02) {
    warnings.push('引擎的 fade 会连带抬高黑位（black_lift = fade×0.1）；原预设黑位更低，已取 black_lift=0，暗部会比原预设略灰。');
  }
  if (fit.maxDev > MAX_DEV_WARN) {
    warnings.push(`曲线反解最大偏差 ≈${fit.maxDev.toFixed(2)}（亮度 0..1 尺度），形状有损，需人工调校。`);
  }
  return { blk: fit.blk, contrast: fit.contrast, filmS: fit.filmS, maxDev: fit.maxDev, fade, blackLift };
}

/* ---------------- 第 3 步：分组映射 ---------------- */

function mapCurveFamily(ir: XmpIR, params: FilmParams, origins: Record<string, Origin>, warnings: string[]): void {
  const f = buildMeasuredCurve(ir);
  if (!f) return;
  warnings.push('曲线族（film_s / contrast / fade / black_lift）为形状反解的「估算起点」，导入后需人工调校。');
  const inv = invertCurveFamily(f, warnings);
  const look = params.look as unknown as Record<string, number>;
  const set = (k: string, v: number) => { look[k] = round4(v); origins[`look.${k}`] = 'estimated'; };
  set('film_s', inv.filmS);
  set('contrast', inv.contrast);
  set('fade', inv.fade);
  set('black_lift', inv.blackLift);
}

/** SplitToning → split_*（几乎一一对应；LR 色相轮 0°=红/120°=绿/240°=蓝 与引擎 0/⅓/⅔ 线性同相） */
function mapSplitToning(ir: XmpIR, params: FilmParams, origins: Record<string, Origin>): void {
  const anyDefined = ir.splitToningShadowHue !== undefined || ir.splitToningShadowSaturation !== undefined
    || ir.splitToningHighlightHue !== undefined || ir.splitToningHighlightSaturation !== undefined
    || ir.splitToningBalance !== undefined;
  if (!anyDefined) return;
  const look = params.look as unknown as Record<string, number>;
  const set = (k: string, v: number) => { look[k] = round4(v); origins[`look.${k}`] = 'estimated'; };
  if (ir.splitToningShadowHue !== undefined) set('split_shadow_hue', clamp01(ir.splitToningShadowHue / 360));
  if (ir.splitToningShadowSaturation !== undefined) set('split_shadow_sat', clamp01(ir.splitToningShadowSaturation / 100));
  if (ir.splitToningHighlightHue !== undefined) set('split_highlight_hue', clamp01(ir.splitToningHighlightHue / 360));
  if (ir.splitToningHighlightSaturation !== undefined) set('split_highlight_sat', clamp01(ir.splitToningHighlightSaturation / 100));
  if (ir.splitToningBalance !== undefined) set('split_balance', clamp(ir.splitToningBalance / 100, -1, 1));
}

/* R18 HSL 映射锚点（落档）：
 *  - LR HueAdjustment/SaturationAdjustment/LuminanceAdjustment（各 −100..100）→
 *    look.hsl.<色相>.{hue,sat,lum}（各 /100 → −1..1）；色相键一一对应（red..magenta）。
 *  - 内部量纲（engine/look 单一真源）：hue ±1 = ±30°（LR 满量程一致）、sat ±1 = 饱和 ×(1±0.75)、
 *    lum ±1 = 明度 ×(1±0.30)（后两者为近似折算，方向与 LR 一致）。
 *  - 全 0 通道不写（显式 0 无信息量，保持「中性预设 → 逐字恒等」）；写出的通道三键齐全。 */
function mapHsl(ir: XmpIR, params: FilmParams, origins: Record<string, Origin>): void {
  const hs: Record<string, { hue: number; sat: number; lum: number }> = {};
  for (const hue of HSL_HUES) {
    const ch = ir.hsl[hue];
    if (!ch) continue;
    const hueV = ch.hue !== undefined ? clamp(ch.hue / 100, -1, 1) : 0;
    const satV = ch.saturation !== undefined ? clamp(ch.saturation / 100, -1, 1) : 0;
    const lumV = ch.luminance !== undefined ? clamp(ch.luminance / 100, -1, 1) : 0;
    if (hueV === 0 && satV === 0 && lumV === 0) continue;
    hs[hue] = { hue: hueV, sat: satV, lum: lumV };
    if (ch.hue !== undefined) origins[`look.hsl.${hue}.hue`] = 'estimated';
    if (ch.saturation !== undefined) origins[`look.hsl.${hue}.sat`] = 'estimated';
    if (ch.luminance !== undefined) origins[`look.hsl.${hue}.lum`] = 'estimated';
  }
  if (Object.keys(hs).length > 0) params.look.hsl = hs as Partial<HslAdjustments>;
}

/* R18 Calibration 映射（落档）：
 *  - ShadowTint（−100..100，绿 ↔ 品红，作用于阴影）→ 折入 split_shadow_*：
 *    正（绿）→ split_shadow_hue = 1/3、负（品红）→ 0.85（6 段色相轮的品红段内），
 *    split_shadow_sat = |v|/100。SplitToning 显式值优先：两者同时出现时不写并警告。
 *  - 三原色（Red/Green/Blue）Hue·Saturation 为相机校准原色重标定，引擎无对应物 → unmapped。 */
const SHADOW_TINT_GREEN_HUE = 1 / 3;   // 分离色调色相轮上的绿
const SHADOW_TINT_MAGENTA_HUE = 0.85;  // 分离色调色相轮上的品红（5/6 边界内收，避免落在红段）

function mapCalibration(ir: XmpIR, params: FilmParams, origins: Record<string, Origin>, warnings: string[]): void {
  const st = ir.calibration.shadowTint;
  if (st === undefined || st === 0) return;
  const explicit = ir.splitToningShadowHue !== undefined || ir.splitToningShadowSaturation !== undefined;
  if (explicit) {
    warnings.push('Calibration.ShadowTint 与 SplitToning 暗部值同时出现：SplitToning 为显式值，ShadowTint 未映射（见 unmapped）。');
    return;
  }
  const look = params.look as unknown as Record<string, number>;
  look.split_shadow_hue = round4(st > 0 ? SHADOW_TINT_GREEN_HUE : SHADOW_TINT_MAGENTA_HUE);
  look.split_shadow_sat = round4(clamp01(Math.abs(st) / 100));
  origins['look.split_shadow_hue'] = 'estimated';
  origins['look.split_shadow_sat'] = 'estimated';
}

/* 颗粒映射锚点（落档）：
 *  - GrainAmount>0 → grain.enabled=true（我们没有连续幅度滑杆，幅度由 ISO 档驱动；amount 只当开关）；
 *  - GrainSize（LR 默认 25）→ grain.size ‰H：1.2 × size/25（LR 25 ↔ 默认 1.2‰H），钳 [0.5, 2.4]；
 *  - GrainFrequency（LR 默认 50，越高颗粒越细）→ grain.film_resolution = freq/100
 *    （LR 50 ↔ 恒等 0.5）；团簇感 cluster 不动（LR 无对应概念）。 */
const GRAIN_SIZE_ANCHOR = 1.2;   // ‰H，LR GrainSize=25 的对应值
const GRAIN_SIZE_DEFAULT_LR = 25;

function mapGrain(ir: XmpIR, params: FilmParams, origins: Record<string, Origin>): void {
  if (ir.grainAmount !== undefined && ir.grainAmount > 0) {
    params.texture.grain.enabled = true;
    origins['grain.enabled'] = 'estimated';
  }
  if (ir.grainSize !== undefined) {
    params.texture.grain.size = round4(clamp(GRAIN_SIZE_ANCHOR * (ir.grainSize / GRAIN_SIZE_DEFAULT_LR), 0.5, 2.4));
    origins['grain.size'] = 'estimated';
  }
  if (ir.grainFrequency !== undefined) {
    params.texture.grain.film_resolution = round4(clamp01(ir.grainFrequency / 100));
    origins['grain.film_resolution'] = 'estimated';
  }
}

/* 暗角映射锚点（落档）：LR 负值=压暗角落（引擎同向），映射 amount = min(0.5, −v/100×0.6)；
 * Midpoint（0..100，默认 50）→ vignette.radius：0.7 + mid/100×0.8（50 ↔ 默认 1.1），钳 [0.8, 1.5]；
 * LR 正值=提亮角落，引擎只支持压暗 → 警告且不写量。 */
const VIGNETTE_GAIN = 0.6;
const VIGNETTE_MAX = 0.5;

function mapVignette(ir: XmpIR, params: FilmParams, origins: Record<string, Origin>, warnings: string[]): void {
  const amt = ir.postCropVignetteAmount;
  if (amt === undefined) return;
  if (amt < 0) {
    params.texture.vignette.enabled = true;
    origins['vignette.enabled'] = 'estimated';
    params.texture.vignette.amount = round4(Math.min(VIGNETTE_MAX, (-amt / 100) * VIGNETTE_GAIN));
    origins['vignette.amount'] = 'estimated';
    if (ir.postCropVignetteMidpoint !== undefined) {
      params.texture.vignette.radius = round4(clamp(0.7 + (ir.postCropVignetteMidpoint / 100) * 0.8, 0.8, 1.5));
      origins['vignette.radius'] = 'estimated';
    }
  } else if (amt > 0) {
    warnings.push('暗角提亮方向（PostCropVignetteAmount > 0）引擎不支持（只支持压暗），该量已忽略。');
  }
}

function mapGlobalColor(ir: XmpIR, params: FilmParams, origins: Record<string, Origin>, warnings: string[]): void {
  const look = params.look as unknown as Record<string, number>;
  if (ir.saturation !== undefined) {
    look.saturation = round4(clamp(1 + ir.saturation / 100, 0, 2));
    origins['look.saturation'] = 'estimated';
  }
  if (ir.incrementalTemperature !== undefined) {
    /* 方向对齐：LR IncrementalTemperature 正=暖，引擎 warmth 正=暖（R 增 B 减） */
    look.warmth = round4(clamp(ir.incrementalTemperature / 100, -1, 1));
    origins['look.warmth'] = 'estimated';
  }
  if (ir.convertToGrayscale === true) {
    /* 黑白预设：完全去色（覆盖 Saturation 滑杆——LR 黑白模式下该滑杆本就禁用）；
     * GrayMixer 通道混合另列 unmapped */
    look.saturation = 0;
    origins['look.saturation'] = 'estimated';
    warnings.push('预设为黑白转换（ConvertToGrayscale）：已映射为完全去色；黑白混色通道未映射（见 unmapped）。');
  }
}

/* ---------------- 未映射维度（如实列出） ---------------- */

function isIdentityCurve(pts: XmpCurvePoint[]): boolean {
  if (pts.length < 2) return true;
  const a = pts[0], b = pts[pts.length - 1];
  if (a.x !== 0 || a.y !== 0 || b.x !== 255 || b.y !== 255) return false;
  for (let i = 1; i < pts.length - 1; i++) {
    if (pts[i].y !== pts[i].x) return false;
  }
  return true;
}

function collectUnmapped(ir: XmpIR, unmapped: string[]): void {
  /* R18：HSL 8 色相已映射（look.hsl），不再列为 unmapped；Calibration 仅三原色 Hue·Saturation 无对应物 */
  const calPrimaryKeys = Object.keys(ir.calibration).filter((k) => k !== 'shadowTint');
  if (calPrimaryKeys.length > 0) {
    unmapped.push(`Calibration 三原色 Hue·Saturation（相机原色重标定，共 ${calPrimaryKeys.length} 项，无对应参数）`);
  }
  if (ir.exposure2012 !== undefined) unmapped.push('Exposure2012（曝光偏移，无对应参数）');
  if (ir.vibrance !== undefined) unmapped.push('Vibrance（自然饱和度：与全局饱和语义不同，未映射）');
  if (ir.incrementalTint !== undefined) unmapped.push('IncrementalTint（绿-品红白平衡，无对应参数）');
  if (!isIdentityCurve(ir.toneCurvePV2012Red) || !isIdentityCurve(ir.toneCurvePV2012Green) || !isIdentityCurve(ir.toneCurvePV2012Blue)) {
    unmapped.push('ToneCurvePV2012Red/Green/Blue（RGB 通道曲线，暂不映射）');
  }
  if (ir.postCropVignetteFeather !== undefined) unmapped.push('PostCropVignetteFeather（暗角羽化，引擎无对应参数）');
  const mixerCount = Object.keys(ir.grayMixer).length;
  if (mixerCount > 0) unmapped.push(`GrayMixer 黑白混色通道（共 ${mixerCount} 项，未映射）`);
}

function warnUnrecognized(ir: XmpIR, warnings: string[]): void {
  if (ir.unrecognizedKeys.length === 0) return;
  const shown = ir.unrecognizedKeys.slice(0, 6).join(', ');
  const more = ir.unrecognizedKeys.length > 6 ? ` 等 ${ir.unrecognizedKeys.length} 个` : '';
  warnings.push(`有 ${ir.unrecognizedKeys.length} 个未识别 crs 键（方言差异，已计入 IR.unrecognizedKeys）：${shown}${more}。`);
}

/* ---------------- 主入口 ---------------- */

/** XMP IR → FilmMatch 参数（估算起点）。恒等护栏：全中性 IR 输出与 defaultParams() 逐字相等。 */
export function mapXmpToFilm(ir: XmpIR): XmpMapping {
  const params = defaultParams();
  const origins: Record<string, Origin> = {};
  const unmapped: string[] = [];
  const warnings: string[] = [];
  mapCurveFamily(ir, params, origins, warnings);
  mapSplitToning(ir, params, origins);
  mapHsl(ir, params, origins);
  mapCalibration(ir, params, origins, warnings);
  mapGrain(ir, params, origins);
  mapVignette(ir, params, origins, warnings);
  mapGlobalColor(ir, params, origins, warnings);
  collectUnmapped(ir, unmapped);
  warnUnrecognized(ir, warnings);
  return { params, origins, unmapped, warnings };
}

/* ---------------- 卡名清洗（合规：产品 UI 不出现第三方品牌词） ---------------- */

/** 第三方品牌/商标词（大小写不敏感；宁可多洗）。仅用于卡名清洗，不含任何样本内容。 */
export const BRAND_WORDS: readonly string[] = [
  /* 柯达系 */
  'Kodak', 'Portra', 'Ektar', 'Ektachrome', 'Gold 200', 'Ultramax', 'ColorPlus', 'TriX', 'TMax',
  'CineStill', 'Cine Still', 'Vision3', 'Vision 3', '250D', '500T', '800T', '5207', '5219', '5213',
  /* 预设/滤镜品牌 */
  'Dehancer', 'Exposure', 'RNI', 'FilmPack', 'DxO',
  /* 富士系 */
  'Fuji', 'Fujifilm', 'Fujicolor', 'Velvia', 'Provia', 'Astia', 'Eterna', 'Superia', 'Acros',
  /* 其他胶片/软件品牌 */
  'Agfa', 'Ilford', 'Polaroid', 'Lomography', 'Lomo', 'Rollei', 'Ferrania',
  'Lightroom', 'Photoshop', 'Adobe', 'ACR', 'LR',
  /* 预设包名缩写（样本文件名中出现，按「宁可多洗」处理） */
  'RL',
];

/** 复合词高发词（连写如 ExposureX7 也要洗：只保留左边界，放宽右边界） */
const BRAND_COMPOUND_WORDS = ['Exposure', 'Vision3', 'CineStill', 'Dehancer', 'Kodak', 'Fuji', 'RNI'];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildBrandRegex(words: readonly string[], withRightGuard: boolean): RegExp {
  const pattern = words.slice().sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  const right = withRightGuard ? '(?![A-Za-z0-9])' : '';
  return new RegExp(`(?<![A-Za-z0-9])(${pattern})${right}`, 'gi');
}

const BRAND_RE = buildBrandRegex(BRAND_WORDS, true);
const BRAND_COMPOUND_RE = buildBrandRegex(BRAND_COMPOUND_WORDS, false);

/**
 * 文件名 → 卡名：去扩展名 → 清洗品牌词 → 空白/分隔符收敛；全清洗后为空回退「导入预设」。
 * 保守策略（宁可多洗）：两遍正则，第二遍针对连写复合词放宽右边界。
 */
export function cleanCardName(filename: string): string {
  let base = filename.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/_+/g, ' ');
  base = base.replace(BRAND_RE, ' ').replace(BRAND_COMPOUND_RE, ' ');
  base = base.replace(/\s+/g, ' ').trim();
  /* 洗空后的括号对（如「[RL]」→「[ ]」）与多余分隔符收敛（连续分隔符只留一个；不碰「v1.2」这类点号夹数字） */
  base = base.replace(/\[\s*\]|\(\s*\)|\{\s*\}|【\s*】/g, ' ').trim();
  base = base.replace(/[ \-_.]{2,}/g, (s) => (s.includes(' ') ? ' ' : s[0]));
  base = base.replace(/^[ \-_.]+/, '').replace(/[ \-_.]+$/, '');
  if (base.length === 0) return '导入预设';
  return base;
}
