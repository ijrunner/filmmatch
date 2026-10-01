/**
 * ASC CDL 拟合与序列化。
 *
 * 交付通道「逐段 CDL」的求解器：对每段素材，用其分位数统计（p1/p50/p99）与
 * 参考统计反解一组 slope/offset/power（+ 全局饱和度），把该段推向统一参考观感。
 *
 * 为什么是三点分位数而非最小二乘逐像素：CDL 恰好有三个自由度（每通道），
 * 用阴影/中间调/高光三个锚点可以闭式反解、再用 Newton 精修，收敛快且可解释。
 * 饱和度为第四个自由度，由中位亮度处的色度比单独推出（避免与逐通道增益重复计色）。
 *
 * 约定：分量均为 sRGB gamma 编码 0..1，与 engine/types 的 RGB 一致。
 */
import { RGB } from '../engine/types';
import { clamp01 } from '../engine/util';
import { QuantileStats, statDistance } from './quantiles';

export interface Cdl {
  slope: RGB;
  offset: RGB;
  power: RGB;
  sat: number;
}

export interface CdlRange {
  slope: [number, number];
  offset: [number, number];
  power: [number, number];
  sat: [number, number];
}

/**
 * 合法区间：与 R3 验收口径一致。
 * slope 0.5–2（约 ±1EV 的 gamma 空间增益）、offset ±0.1（防黑位翻负）、
 * power 0.7–1.4（约 ±0.5 档反差）、sat 0.5–2。
 */
export const CDL_RANGES: CdlRange = {
  slope: [0.5, 2],
  offset: [-0.1, 0.1],
  power: [0.7, 1.4],
  sat: [0.5, 2],
};

export const NEUTRAL_CDL: Cdl = {
  slope: [1, 1, 1],
  offset: [0, 0, 0],
  power: [1, 1, 1],
  sat: 1,
};

export interface CdlFit {
  cdl: Cdl;
  /** Newton/Gauss-Newton 迭代步数（取三通道最大值，≤12） */
  iterations: number;
  converged: boolean;
  /** 与参考的统计距离（拟合前） */
  before: number;
  /** 与参考的统计距离（把源分位点过一遍拟合结果后） */
  after: number;
}

export interface CdlEntry {
  name: string;
  cdl: Cdl;
  before: number;
  after: number;
  iterations: number;
}

/** Rec.709 亮度权重，与 quantiles.ts 保持一致 */
const LUMA_W: RGB = [0.2126, 0.7152, 0.0722];
/** 幂运算的最小底数，避免负底数/ln(0) 产生 NaN */
const MIN_BASE = 1e-6;
/** Newton 最大迭代步数（验收口径 ≤12） */
const MAX_ITERS = 12;

function clampTo(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 单通道 CDL 正向：(x*slope + offset)^power，底数非正时按 0 处理（保持单调、无 NaN） */
function cdlChannel(x: number, s: number, o: number, p: number): number {
  const base = x * s + o;
  return base <= 0 ? 0 : Math.pow(base, p);
}

/**
 * ASC CDL 正向：先逐通道 (in*slope+offset)^power，再绕 Rec.709 亮度做饱和度调整。
 * 输出钳制到 [0,1]（sRGB 合法域）。
 */
export function applyCdl(rgb: RGB, cdl: Cdl): RGB {
  const r = cdlChannel(rgb[0], cdl.slope[0], cdl.offset[0], cdl.power[0]);
  const g = cdlChannel(rgb[1], cdl.slope[1], cdl.offset[1], cdl.power[1]);
  const b = cdlChannel(rgb[2], cdl.slope[2], cdl.offset[2], cdl.power[2]);
  const luma = LUMA_W[0] * r + LUMA_W[1] * g + LUMA_W[2] * b;
  const sat = cdl.sat;
  return [
    clamp01(luma + sat * (r - luma)),
    clamp01(luma + sat * (g - luma)),
    clamp01(luma + sat * (b - luma)),
  ];
}

/** 把 CDL 收敛到 CDL_RANGES；非有限值回退为中性，防止坏输入污染导出 */
export function clampCdl(cdl: Cdl): Cdl {
  const c = (v: number, r: [number, number], fb: number): number =>
    Number.isFinite(v) ? clampTo(v, r[0], r[1]) : fb;
  return {
    slope: [
      c(cdl.slope[0], CDL_RANGES.slope, 1),
      c(cdl.slope[1], CDL_RANGES.slope, 1),
      c(cdl.slope[2], CDL_RANGES.slope, 1),
    ],
    offset: [
      c(cdl.offset[0], CDL_RANGES.offset, 0),
      c(cdl.offset[1], CDL_RANGES.offset, 0),
      c(cdl.offset[2], CDL_RANGES.offset, 0),
    ],
    power: [
      c(cdl.power[0], CDL_RANGES.power, 1),
      c(cdl.power[1], CDL_RANGES.power, 1),
      c(cdl.power[2], CDL_RANGES.power, 1),
    ],
    sat: c(cdl.sat, CDL_RANGES.sat, 1),
  };
}

/** 3x3 线性方程 A x = b（Cramer 法则）；奇异返回 null */
function solve3(A: number[][], b: number[]): number[] | null {
  const a = A[0][0], bb = A[0][1], cc = A[0][2];
  const d = A[1][0], e = A[1][1], f = A[1][2];
  const g = A[2][0], h = A[2][1], i = A[2][2];
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + cc * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-20) return null;
  const inv = 1 / det;
  return [
    (b[0] * (e * i - f * h) - bb * (b[1] * i - f * b[2]) + cc * (b[1] * h - e * b[2])) * inv,
    (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + cc * (d * b[2] - b[1] * g)) * inv,
    (a * (e * b[2] - b[1] * h) - bb * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) * inv,
  ];
}

/** 由三对锚点估计幂次初值：log-log 回归斜率（纯幂律时即为真值） */
function logLogSlope(xs: number[], ys: number[]): number {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < 3; i++) {
    const x = xs[i];
    const y = ys[i];
    if (x > 1e-4 && y > 1e-4) {
      const lx = Math.log(x);
      const ly = Math.log(y);
      n++;
      sx += lx;
      sy += ly;
      sxx += lx * lx;
      sxy += lx * ly;
    }
  }
  if (n < 2) return 1;
  const vx = sxx - (sx * sx) / n;
  if (vx < 1e-12) return 1;
  const p = (sxy - (sx * sy) / n) / vx;
  return Number.isFinite(p) ? p : 1;
}

/** 给定幂次 p，对 v = y^(1/p) 做 s*x+o 的最小二乘，得到斜率/偏移初值 */
function linearInit(xs: number[], ys: number[], p: number): [number, number] {
  const vs = ys.map((y) => Math.pow(Math.max(y, MIN_BASE), 1 / p));
  let sx = 0;
  let sv = 0;
  let sxx = 0;
  let sxv = 0;
  for (let i = 0; i < 3; i++) {
    sx += xs[i];
    sv += vs[i];
    sxx += xs[i] * xs[i];
    sxv += xs[i] * vs[i];
  }
  const vx = sxx - (sx * sx) / 3;
  if (vx < 1e-10) {
    // 源通道近乎常量：无法反解增益，退化为平移
    return [1, sv / 3 - sx / 3];
  }
  const s = (sxv - (sx * sv) / 3) / vx;
  const o = sv / 3 - s * (sx / 3);
  return [Number.isFinite(s) ? s : 1, Number.isFinite(o) ? o : 0];
}

interface ChanFit {
  s: number;
  o: number;
  p: number;
  iterations: number;
  converged: boolean;
}

/**
 * 单通道三点拟合：
 *   1) log-log 回归得幂次初值，再线性最小二乘得 slope/offset 初值；
 *   2) Gauss-Newton 迭代（等价于三点恰好定方程上的 Newton）精修，≤12 步。
 * 每步把参数钳制到合法区间，保证坏输入下也返回合法结果。
 */
function fitChannel(xs: number[], ys: number[]): ChanFit {
  let p = clampTo(logLogSlope(xs, ys), CDL_RANGES.power[0], CDL_RANGES.power[1]);
  let [s, o] = linearInit(xs, ys, p);
  s = clampTo(s, CDL_RANGES.slope[0], CDL_RANGES.slope[1]);
  o = clampTo(o, CDL_RANGES.offset[0], CDL_RANGES.offset[1]);

  let converged = false;
  let iterations = 0;
  for (let it = 0; it < MAX_ITERS; it++) {
    iterations = it + 1;
    let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0;
    let g0 = 0, g1 = 0, g2 = 0;
    for (let i = 0; i < 3; i++) {
      const x = xs[i];
      const y = ys[i];
      const base = x * s + o;
      const f = base <= 0 ? 0 : Math.pow(base, p);
      const r = f - y;
      let ds = 0, doo = 0, dp = 0;
      if (base > MIN_BASE) {
        const b1 = p * Math.pow(base, p - 1);
        ds = b1 * x;
        doo = b1;
        dp = f * Math.log(base);
      }
      a00 += ds * ds; a01 += ds * doo; a02 += ds * dp;
      a11 += doo * doo; a12 += doo * dp; a22 += dp * dp;
      g0 += ds * r; g1 += doo * r; g2 += dp * r;
    }
    // 轻微 Levenberg 阻尼：三点恰定下防雅可比退化导致的步长爆炸
    const damp = 1e-9 * (a00 + a11 + a22 + 1e-12);
    const delta = solve3(
      [[a00 + damp, a01, a02], [a01, a11 + damp, a12], [a02, a12, a22 + damp]],
      [-g0, -g1, -g2],
    );
    if (!delta) break;
    const [d0, d1, d2] = delta;
    if (![d0, d1, d2].every(Number.isFinite)) break;
    s = clampTo(s + d0, CDL_RANGES.slope[0], CDL_RANGES.slope[1]);
    o = clampTo(o + d1, CDL_RANGES.offset[0], CDL_RANGES.offset[1]);
    p = clampTo(p + d2, CDL_RANGES.power[0], CDL_RANGES.power[1]);
    if (Math.abs(d0) + Math.abs(d1) + Math.abs(d2) < 1e-10) {
      converged = true;
      break;
    }
  }
  return { s, o, p, iterations, converged };
}

/** 色度代理：max-min（比 sqrt(a²+b²) 更廉价且对 WB 扰动线性） */
function chroma(rgb: RGB): number {
  const mx = Math.max(rgb[0], rgb[1], rgb[2]);
  const mn = Math.min(rgb[0], rgb[1], rgb[2]);
  return mx - mn;
}

/** 把统计的分位点/均值过一遍 CDL，用于估计拟合后的统计距离 */
function transformStats(stats: QuantileStats, cdl: Cdl): QuantileStats {
  const p1 = applyCdl(stats.p1, cdl);
  const p50 = applyCdl(stats.p50, cdl);
  const p99 = applyCdl(stats.p99, cdl);
  const mean = applyCdl(stats.mean, cdl);
  return {
    p1,
    p50,
    p99,
    mean,
    luma: LUMA_W[0] * mean[0] + LUMA_W[1] * mean[1] + LUMA_W[2] * mean[2],
    samples: stats.samples,
  };
}

/**
 * 分位数三点拟合：p1→p1、p50→p50、p99→p99 逐通道反解 slope/offset/power，
 * Newton（Gauss-Newton）迭代收敛；sat 由两图中位亮度处平均色度的比值推出。
 * 返回值一定已 clamp 到 CDL_RANGES。
 */
export function fitCdl(src: QuantileStats, ref: QuantileStats): CdlFit {
  const before = statDistance(src, ref);
  const slope: RGB = [1, 1, 1];
  const offset: RGB = [0, 0, 0];
  const power: RGB = [1, 1, 1];
  let iterations = 0;
  let converged = true;
  for (let c = 0; c < 3; c++) {
    const cf = fitChannel(
      [src.p1[c], src.p50[c], src.p99[c]],
      [ref.p1[c], ref.p50[c], ref.p99[c]],
    );
    slope[c] = cf.s;
    offset[c] = cf.o;
    power[c] = cf.p;
    iterations = Math.max(iterations, cf.iterations);
    converged = converged && cf.converged;
  }
  // 先只用逐通道部分，测量映射后中位色度与参考中位色度的残差比
  const gainOnly: Cdl = clampCdl({ slope, offset, power, sat: 1 });
  const cSrc = chroma(applyCdl(src.p50, gainOnly));
  const cRef = chroma(ref.p50);
  const sat = cSrc > 1e-4 ? clampTo(cRef / cSrc, CDL_RANGES.sat[0], CDL_RANGES.sat[1]) : 1;
  const cdl = clampCdl({ slope, offset, power, sat });
  const after = statDistance(transformStats(src, cdl), ref);
  return { cdl, iterations, converged, before, after };
}

/** 生成 cdl.json（meta + clips；结构稳定，供下游/复现解析） */
export function cdlToJson(
  entries: CdlEntry[],
  meta: { created_at: string; strategy: 'A' | 'B'; lut_size: number; note?: string },
): string {
  const obj = {
    meta: {
      created_at: meta.created_at,
      strategy: meta.strategy,
      lut_size: meta.lut_size,
      ...(meta.note ? { note: meta.note } : {}),
    },
    clips: entries.map((e) => ({
      name: e.name,
      cdl: {
        slope: [...e.cdl.slope],
        offset: [...e.cdl.offset],
        power: [...e.cdl.power],
        sat: e.cdl.sat,
      },
      before: e.before,
      after: e.after,
      iterations: e.iterations,
    })),
  };
  return JSON.stringify(obj, null, 2) + '\n';
}

const CSV_HEADER =
  'clip,slope_r,slope_g,slope_b,offset_r,offset_g,offset_b,power_r,power_g,power_b,sat,before,after';

/** 名称含分隔符时按 CSV 规则加引号，避免下游解析串列 */
function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const f6 = (v: number): string => (Number.isFinite(v) ? v.toFixed(6) : '0.000000');

/** 生成 cdl.csv（表头固定，每段一行，数值可直接 parseFloat） */
export function cdlToCsv(entries: CdlEntry[]): string {
  const lines = [CSV_HEADER];
  for (const e of entries) {
    lines.push(
      [
        csvField(e.name),
        ...e.cdl.slope.map(f6),
        ...e.cdl.offset.map(f6),
        ...e.cdl.power.map(f6),
        f6(e.cdl.sat),
        f6(e.before),
        f6(e.after),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}
