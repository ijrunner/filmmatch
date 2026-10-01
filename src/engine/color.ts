/**
 * 色彩空间原语：sRGB(gamma) <-> 线性 <-> XYZ <-> CIELAB（D65 白点）。
 * 全部为标量纯函数，Into 后缀版本写入调用方缓冲，热路径（LUT 烘焙）零分配。
 */

// sRGB(D65) 线性化 / 去线性化
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

// 线性 sRGB -> XYZ（D65）
const M00 = 0.4124564, M01 = 0.3575761, M02 = 0.1804375;
const M10 = 0.2126729, M11 = 0.7151522, M12 = 0.072175;
const M20 = 0.0193339, M21 = 0.119192, M22 = 0.9503041;
// XYZ -> 线性 sRGB
const I00 = 3.2404542, I01 = -1.5371385, I02 = -0.4985314;
const I10 = -0.969266, I11 = 1.8760108, I12 = 0.041556;
const I20 = 0.0556434, I21 = -0.2040259, I22 = 1.0572252;

const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;
// CIELAB 常数：ε = (6/29)^3，κ = 24389/27
const LAB_EPS = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

function labF(t: number): number {
  return t > LAB_EPS ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116;
}

/** sRGB gamma -> [L*,a*,b*]，写 out[o..o+2]（热路径零分配） */
export function rgbToLabInto(r: number, g: number, b: number, out: Float64Array, o = 0): void {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const x = M00 * lr + M01 * lg + M02 * lb;
  const y = M10 * lr + M11 * lg + M12 * lb;
  const z = M20 * lr + M21 * lg + M22 * lb;
  const fx = labF(x / XN);
  const fy = labF(y / YN);
  const fz = labF(z / ZN);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

/** sRGB gamma -> [L*,a*,b*]（测试等低频路径用便捷包装） */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const x = M00 * lr + M01 * lg + M02 * lb;
  const y = M10 * lr + M11 * lg + M12 * lb;
  const z = M20 * lr + M21 * lg + M22 * lb;
  const fx = labF(x / XN);
  const fy = labF(y / YN);
  const fz = labF(z / ZN);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** 色域判定浮点容差 */
const GAMUT_EPS = 1e-9;

// 热路径共用缓冲（同步单线程，无重入）
const LIN = new Float64Array(3);

/** Lab(L, s*a, s*b) -> 线性 sRGB，写入 LIN */
function linAtScaled(L: number, a: number, b: number, s: number): void {
  const fy = (L + 16) / 116;
  const yr = L > LAB_KAPPA * LAB_EPS ? fy * fy * fy : L / LAB_KAPPA;
  const y = yr * YN;
  const fx = fy + (s * a) / 500;
  const fz = fy - (s * b) / 200;
  const xr = fx * fx * fx > LAB_EPS ? fx * fx * fx : (116 * fx - 16) / LAB_KAPPA;
  const zr = fz * fz * fz > LAB_EPS ? fz * fz * fz : (116 * fz - 16) / LAB_KAPPA;
  const x = xr * XN;
  const z = zr * ZN;
  LIN[0] = I00 * x + I01 * y + I02 * z;
  LIN[1] = I10 * x + I11 * y + I12 * z;
  LIN[2] = I20 * x + I21 * y + I22 * z;
}

function linInGamut(): boolean {
  return (
    LIN[0] >= -GAMUT_EPS && LIN[0] <= 1 + GAMUT_EPS &&
    LIN[1] >= -GAMUT_EPS && LIN[1] <= 1 + GAMUT_EPS &&
    LIN[2] >= -GAMUT_EPS && LIN[2] <= 1 + GAMUT_EPS
  );
}

/**
 * CIELAB -> sRGB gamma，写 out[o..o+2]。
 * 色域处理：沿 a*b* 向中性二分收缩到恰好入域（对 (L,a,b) 连续，且严格保持 L*，
 * 即保持明度与灰轴单调性）；仅 L 本身越出 [0,100] 的极端情况才落到通道钳制。
 */
export function labToRgbInto(L: number, a: number, b: number, out: Float64Array, o = 0): void {
  linAtScaled(L, a, b, 1);
  if (!linInGamut()) {
    // 二分求最大色度比例 s∈[0,1]（灰点 s=0 恒入域）；10 轮已达亚 LSB 精度
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2;
      linAtScaled(L, a, b, mid);
      if (linInGamut()) lo = mid;
      else hi = mid;
    }
    linAtScaled(L, a, b, lo);
  }
  out[o] = Math.min(1, Math.max(0, linearToSrgb(Math.min(1, Math.max(0, LIN[0])))));
  out[o + 1] = Math.min(1, Math.max(0, linearToSrgb(Math.min(1, Math.max(0, LIN[1])))));
  out[o + 2] = Math.min(1, Math.max(0, linearToSrgb(Math.min(1, Math.max(0, LIN[2])))));
}

/** (L,a,b) 是否在 sRGB 色域内（线性 RGB ∈ [0,1]） */
export function labInGamut(L: number, a: number, b: number): boolean {
  linAtScaled(L, a, b, 1);
  return linInGamut();
}

/** CIE76 色差（任务约定的 ΔE76） */
export function deltaE76(
  L1: number, a1: number, b1: number,
  L2: number, a2: number, b2: number,
): number {
  const dL = L1 - L2;
  const da = a1 - a2;
  const db = b1 - b2;
  return Math.sqrt(dL * dL + da * da + db * db);
}
