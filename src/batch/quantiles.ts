/**
 * 批量匹配用「逐通道分位数统计」。
 *
 * 为什么自建而不用 engine/stats.ts：ImageStats 是 Lab 亮度三分区的均值/方差统计，
 * 不含逐通道分位数；而 CDL 三点拟合需要 p1/p50/p99（阴影/中间调/高光锚点）。
 * 这里用 256 桶直方图一次遍历 O(n) 求出分位数，避免排序的 O(n log n) 与内存峰值。
 * 约定与工作空间一致：输入 RGBA（Uint8ClampedArray，stride 4），分量 sRGB gamma 编码 0..1。
 */
import { RGB } from '../engine/types';

export interface QuantileStats {
  /** 各通道 1% 分位（0..1，sRGB 编码） */
  p1: RGB;
  /** 各通道 50% 分位（中位） */
  p50: RGB;
  /** 各通道 99% 分位 */
  p99: RGB;
  /** 各通道算术均值 */
  mean: RGB;
  /** 均值处的 Rec.709 相对亮度（仅诊断/加权用，非 Lab 明度） */
  luma: number;
  /** 参与统计的像素数 */
  samples: number;
}

const BUCKETS = 256;
const LAST = BUCKETS - 1;
/** Rec.709 亮度权重（与 CDL 饱和度的绕轴亮度一致） */
const LUMA_W: RGB = [0.2126, 0.7152, 0.0722];

/**
 * 直方图分位数：定位跨越桶后在桶内线性插值，并取桶中心做偏置校正。
 * 对离散整数分布，中心插值把最坏误差压到约 0.5 个桶（< 1/255），
 * 优于直接取桶左沿（偏多约 1 个桶）。
 */
function quantileFromHist(hist: Uint32Array, n: number, q: number): number {
  if (n <= 0) return 0;
  const target = q * n;
  let acc = 0;
  for (let b = 0; b < BUCKETS; b++) {
    const c = hist[b];
    if (c === 0) continue;
    if (acc + c >= target) {
      const frac = (target - acc) / c;
      const v = (b + frac - 0.5) / LAST;
      return v < 0 ? 0 : v > 1 ? 1 : v;
    }
    acc += c;
  }
  return 1;
}

/**
 * 从 RGBA 像素算各通道 p1/p50/p99、均值与亮度。
 * 直方图路径 O(n)、无排序、无中间数组分配（三张 256 桶表）。
 */
export function quantileStats(data: Uint8ClampedArray, w: number, h: number): QuantileStats {
  if (!(w > 0) || !(h > 0)) throw new Error('quantileStats: 尺寸必须为正');
  const n = w * h;
  if (data.length < n * 4) {
    throw new Error('quantileStats: 数据长度与尺寸不符（需 RGBA，stride 4）');
  }
  const hr = new Uint32Array(BUCKETS);
  const hg = new Uint32Array(BUCKETS);
  const hb = new Uint32Array(BUCKETS);
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    hr[r]++;
    hg[g]++;
    hb[b]++;
    sr += r;
    sg += g;
    sb += b;
  }
  const mean: RGB = [sr / n / 255, sg / n / 255, sb / n / 255];
  return {
    p1: [quantileFromHist(hr, n, 0.01), quantileFromHist(hg, n, 0.01), quantileFromHist(hb, n, 0.01)],
    p50: [quantileFromHist(hr, n, 0.5), quantileFromHist(hg, n, 0.5), quantileFromHist(hb, n, 0.5)],
    p99: [quantileFromHist(hr, n, 0.99), quantileFromHist(hg, n, 0.99), quantileFromHist(hb, n, 0.99)],
    mean,
    luma: LUMA_W[0] * mean[0] + LUMA_W[1] * mean[1] + LUMA_W[2] * mean[2],
    samples: n,
  };
}

/**
 * 两图统计距离：三个分位点 × 三通道的绝对差加权平均（等权，故值域 0..1）。
 * 为什么用分位数而非均值：分位数对极值/遮挡更鲁棒，且正好是 CDL 拟合的锚点，
 * 用它度量能直接反映拟合质量。
 */
export function statDistance(a: QuantileStats, b: QuantileStats): number {
  let sum = 0;
  for (let c = 0; c < 3; c++) {
    sum += Math.abs(a.p1[c] - b.p1[c]);
    sum += Math.abs(a.p50[c] - b.p50[c]);
    sum += Math.abs(a.p99[c] - b.p99[c]);
  }
  return sum / 9;
}

/** 一组帧的平均两两距离（i<j 去重；含对角线为 0 故不计入）。样本 < 2 返回 0。 */
export function meanPairwiseDistance(list: QuantileStats[]): number {
  const n = list.length;
  if (n < 2) return 0;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      sum += statDistance(list[i], list[j]);
      pairs++;
    }
  }
  return pairs > 0 ? sum / pairs : 0;
}
