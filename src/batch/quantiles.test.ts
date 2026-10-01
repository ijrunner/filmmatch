/**
 * 分位数统计测试：已知分布的理论分位数、单调性、距离度量性质与输入校验。
 * 全部为纯函数（node 环境直接跑）。
 */
import { describe, expect, it } from 'vitest';
import {
  meanPairwiseDistance,
  quantileStats,
  statDistance,
  type QuantileStats,
} from './quantiles';

/** 构造 RGBA 斜坡：值 0..255 每个各出现 h 次（x 通道值 = x） */
function ramp(w: number, h: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      d[o] = x;
      d[o + 1] = x;
      d[o + 2] = x;
      d[o + 3] = 255;
    }
  }
  return d;
}

function flat(w: number, h: number, v: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = v;
    d[i * 4 + 1] = v;
    d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  return d;
}

describe('quantiles: 分位数统计', () => {
  it('1. 已知均匀斜坡：p1/p50/p99 与理论值误差 < 1/255，且 p1<=p50<=p99', () => {
    const s = quantileStats(ramp(256, 100), 256, 100);
    const tol = 1 / 255;
    // 均匀离散 0..255 的理论分位数 = q*255/255 = q
    for (const c of [0, 1, 2]) {
      expect(Math.abs(s.p1[c] - 0.01)).toBeLessThan(tol);
      expect(Math.abs(s.p50[c] - 0.5)).toBeLessThan(tol);
      expect(Math.abs(s.p99[c] - 0.99)).toBeLessThan(tol);
      expect(s.p1[c]).toBeLessThanOrEqual(s.p50[c]);
      expect(s.p50[c]).toBeLessThanOrEqual(s.p99[c]);
    }
    expect(s.samples).toBe(25600);
    expect(s.mean[0]).toBeCloseTo(0.5, 2);
  });

  it('2. statDistance：自身为 0、对称、值域 0..1，且随差异单调增大', () => {
    const a = quantileStats(ramp(256, 100), 256, 100);
    const b = quantileStats(flat(64, 64, 128), 64, 64);
    expect(statDistance(a, a)).toBe(0);
    expect(statDistance(a, b)).toBeCloseTo(statDistance(b, a), 12);
    expect(statDistance(a, b)).toBeGreaterThan(0);
    expect(statDistance(a, b)).toBeLessThanOrEqual(1);
    // 更接近参考 → 距离更小
    const c = quantileStats(flat(64, 64, 120), 64, 64);
    expect(statDistance(c, b)).toBeLessThan(statDistance(a, b));
  });

  it('3. meanPairwiseDistance：含对角线为 0（不计入），单元素返回 0', () => {
    const a = quantileStats(ramp(256, 100), 256, 100);
    const b = quantileStats(flat(64, 64, 128), 64, 64);
    expect(meanPairwiseDistance([a])).toBe(0);
    expect(meanPairwiseDistance([a, a])).toBe(0);
    // 两两平均 = 唯一一对的距离
    expect(meanPairwiseDistance([a, b])).toBeCloseTo(statDistance(a, b), 12);
  });

  it('4. 边界：全同值稳定、非法尺寸/长度抛错', () => {
    const s = quantileStats(flat(32, 32, 128), 32, 32);
    for (const c of [0, 1, 2]) {
      expect(Math.abs(s.p1[c] - 128 / 255)).toBeLessThan(1 / 255);
      expect(Math.abs(s.p99[c] - 128 / 255)).toBeLessThan(1 / 255);
    }
    expect(() => quantileStats(ramp(4, 4), 0, 4)).toThrow();
    expect(() => quantileStats(new Uint8ClampedArray(8), 4, 4)).toThrow();
  });
});

/** 类型层面确认 QuantileStats 可被外部构造（UI/测试复用） */
const _typecheck: QuantileStats = {
  p1: [0, 0, 0], p50: [0, 0, 0], p99: [0, 0, 0],
  mean: [0, 0, 0], luma: 0, samples: 0,
};
void _typecheck;
