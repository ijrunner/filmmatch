/**
 * DCTL 数学层（src/dctl/logmath.ts）单元测试：纯函数、node 环境、无 DOM。
 * 覆盖：TF 往返/单调/端点、LookParams→对数域映射的恒等性、applyLogLook 单调性与
 * 绕 pivot 的对比度语义、gammaLook 与 pipeline.GRADE_FS 非 LUT 分支的逐式一致性、
 * 饱和度为 0 的去色语义。
 */
import { describe, expect, it } from 'vitest';
import { clamp01, luma } from '../film/effectmath';
import { defaultLook, type LookParams } from '../film/params';
import type { RGB } from '../engine/types';
import {
  applyLogLook, gammaLook, lookToLogLook, tfDecode, tfEncode, tfRoundTripError,
  PIPELINES, type LogLookParams, type PipelineTF,
} from './logmath';

/** 确定性 PRNG（mulberry32）：测试可复现 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 中性对数域参数（applyLogLook 恒等） */
function neutralLogLook(pivot = 0.5): LogLookParams {
  return {
    contrast: 1, toe: 0, shoulder: 0, pivot, crosstalk: 0, saturation: 1, warmth: 0,
    fade: 0, shadow_bias: 0, highlight_bias: 0, film_s: 0, gamma_contrast: 0,
    split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0,
  };
}

/** GRADE_FS 非 LUT 分支的逐式参考实现（用于核对 gammaLook 的转录是否漂移） */
function gradeFsNoLut(rgb: RGB, look: LookParams): RGB {
  const ss = (a: number, b: number, x: number): number => {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  };
  const refS = (x: number): number => {
    const lin = 0.42 + (x - 0.42) * 0.76;
    const toe = 0.03 + (lin - 0.03) * Math.pow(clamp01(x / 0.42), 0.75);
    let y = toe + (lin - toe) * ss(0.02, 0.24, x);
    if (x > 0.55) {
      const u = (x - 0.55) / 0.45;
      y = 0.5188 + u * (0.342 + u * (0.7596 - u * 0.6204));
    }
    return y;
  };
  const shapePos = (x: number): number => (look.contrast <= 0.001 ? x : x + (x * x * (3 - 2 * x) - x) * look.contrast);
  const shapeNeg = (x: number): number => (look.film_s <= 0.001 ? x : x + (refS(x) - x) * look.film_s);
  let r = shapeNeg(shapePos(rgb[0]));
  let g = shapeNeg(shapePos(rgb[1]));
  let b = shapeNeg(shapePos(rgb[2]));
  const k = look.dye_coupling;
  const r2 = r * (1 - k) + g * (k * 0.55) + b * (k * 0.3);
  const g2 = r * (k * 0.35) + g * (1 - k * 0.8) + b * (k * 0.45);
  const b2 = r * (k * 0.25) + g * (k * 0.35) + b * (1 - k * 1.6);
  r = r2; g = g2; b = b2;
  const l = luma([r, g, b]);
  const sh = Math.pow(clamp01(1 - l), 2.2);
  const hi = Math.pow(clamp01(l), 2.2);
  r += look.shadow_bias * (-0.1 * sh) + look.highlight_bias * (0.1 * hi);
  g += look.shadow_bias * (0.02 * sh) + look.highlight_bias * (0.08 * hi);
  b += look.shadow_bias * (0.16 * sh) + look.highlight_bias * (-0.18 * hi);
  const blk = look.black_lift + look.fade * 0.1;
  const wht = look.fade * 0.08;
  r = blk + clamp01(r) * (1 - blk - wht);
  g = blk + clamp01(g) * (1 - blk - wht);
  b = blk + clamp01(b) * (1 - blk - wht);
  const l2 = luma([r, g, b]);
  r = (l2 + (r - l2) * look.saturation) * (1 + look.warmth * 0.05);
  g = (l2 + (g - l2) * look.saturation) * (1 + look.warmth * 0.01);
  b = (l2 + (b - l2) * look.saturation) * (1 - look.warmth * 0.05);
  return [clamp01(r), clamp01(g), clamp01(b)];
}

describe('管线 TF（tfEncode / tfDecode）', () => {
  it('1. tfRoundTripError 对 yrgb / rcm 在 1024 点上的最大误差 < 2e-3（打印实测）', () => {
    for (const tf of ['yrgb', 'rcm'] as PipelineTF[]) {
      const r = tfRoundTripError(tf, 1024);
      // eslint-disable-next-line no-console
      console.log(`[TF 往返] ${tf}: maxErr=${r.maxErr.toExponential(3)} at v=${r.at}`);
      expect(r.maxErr).toBeLessThan(2e-3);
    }
  });

  it('2. tfEncode 单调递增，且 tfEncode(tf,0)≈0 / tfEncode(tf,1)≈1', () => {
    for (const tf of ['yrgb', 'rcm', 'aces'] as PipelineTF[]) {
      expect(tfEncode(tf, 0)).toBeCloseTo(0, 9);
      expect(tfEncode(tf, 1)).toBeCloseTo(1, 9);
      let prev = -Infinity;
      for (let i = 0; i <= 512; i++) {
        const x = tfEncode(tf, i / 512);
        expect(x).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = x;
      }
      // 严格递增（每步至少推进一点）
      expect(tfEncode(tf, 0.25)).toBeLessThan(tfEncode(tf, 0.5));
      expect(tfEncode(tf, 0.5)).toBeLessThan(tfEncode(tf, 0.75));
    }
  });

  it('2b. yrgb 归一化锚点：linear 0.18（code 0.4895）落在对数域 0.5', () => {
    const code = Math.pow(0.18, 1 / 2.4);
    expect(tfEncode('yrgb', code)).toBeCloseTo(0.5, 4);
  });
});

describe('lookToLogLook 与 applyLogLook 恒等性', () => {
  it('3. 中性 LookParams 映射后 applyLogLook 为恒等（1000 随机点 < 1e-6）', () => {
    const neutral = defaultLook();
    const rnd = rng(20260921);
    for (const tf of ['yrgb', 'rcm'] as PipelineTF[]) {
      const p = lookToLogLook(neutral, tf);
      for (let i = 0; i < 1000; i++) {
        const rgb: RGB = [rnd(), rnd(), rnd()];
        const out = applyLogLook(rgb, p);
        for (let c = 0; c < 3; c++) expect(Math.abs(out[c] - rgb[c])).toBeLessThan(1e-6);
      }
    }
  });

  it('3b. 全零 LookParams（saturation=1）也映射为恒等', () => {
    const p = lookToLogLook(defaultLook(), 'yrgb');
    expect(p.contrast).toBe(1);
    expect(p.crosstalk).toBe(0);
    expect(p.saturation).toBe(1);
    expect(applyLogLook([0.2, 0.55, 0.91], p)).toEqual([0.2, 0.55, 0.91]);
  });
});

describe('applyLogLook 曲线语义', () => {
  it('4. 单调不减：contrast>1、toe/shoulder>0 时逐通道随输入递增', () => {
    const p: LogLookParams = {
      ...neutralLogLook(0.5),
      contrast: 1.6, toe: 0.4, shoulder: 0.4, film_s: 0.5, gamma_contrast: 0.3, crosstalk: 0.1,
    };
    let prev: RGB = [-1, -1, -1];
    for (let i = 0; i <= 400; i++) {
      const x = i / 400;
      const out = applyLogLook([x, x, x], p);
      for (let c = 0; c < 3; c++) {
        expect(out[c]).toBeGreaterThanOrEqual(prev[c] - 1e-9);
        prev[c] = out[c];
      }
    }
  });

  it('5. 对数域对比度绕 pivot：x=pivot 处不动（误差 < 1e-6）', () => {
    const p: LogLookParams = { ...neutralLogLook(0.5), contrast: 1.5 };
    const out = applyLogLook([0.5, 0.5, 0.5], p);
    for (const c of out) expect(Math.abs(c - 0.5)).toBeLessThan(1e-6);
    // 远离 pivot 的点确实被拉开（对比度生效）
    const hi = applyLogLook([0.7, 0.7, 0.7], p);
    expect(hi[0]).toBeGreaterThan(0.7);
    const lo = applyLogLook([0.3, 0.3, 0.3], p);
    expect(lo[0]).toBeLessThan(0.3);
  });

  it('7. saturation=0 时输出三通道相等（误差 < 1e-6）', () => {
    const p: LogLookParams = { ...neutralLogLook(0.5), saturation: 0 };
    const rnd = rng(7);
    for (let i = 0; i < 200; i++) {
      const out = applyLogLook([rnd(), rnd(), rnd()], p);
      expect(Math.abs(out[0] - out[1])).toBeLessThan(1e-6);
      expect(Math.abs(out[1] - out[2])).toBeLessThan(1e-6);
    }
  });
});

describe('gammaLook 与 GRADE_FS 一致性', () => {
  it('6. gammaLook 与 GRADE_FS 非 LUT 分支逐式一致（256 采样点）', () => {
    const look: LookParams = {
      fade: 0.35, black_lift: 0.05, dye_coupling: 0.12, shadow_bias: 0.3,
      highlight_bias: 0.25, film_s: 0.6, contrast: 0.45, saturation: 0.85, warmth: 0.2,
      split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0,
    };
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const rgb: RGB = [(t * 7) % 1, (t * 13) % 1, (t * 29) % 1];
      const a = gammaLook(rgb, look);
      const b = gradeFsNoLut(rgb, look);
      for (let c = 0; c < 3; c++) expect(Math.abs(a[c] - b[c])).toBeLessThan(1e-12);
    }
  });

  it('6b. 中性参数下 gammaLook 与 applyLogLook 都不改变输入', () => {
    const rnd = rng(99);
    const gl = lookToLogLook(defaultLook(), 'yrgb');
    for (let i = 0; i < 100; i++) {
      const rgb: RGB = [rnd(), rnd(), rnd()];
      const a = gammaLook(rgb, defaultLook());
      const b = applyLogLook(rgb, gl);
      for (let c = 0; c < 3; c++) {
        expect(Math.abs(a[c] - rgb[c])).toBeLessThan(1e-9);
        expect(Math.abs(b[c] - rgb[c])).toBeLessThan(1e-6);
      }
    }
  });
});

describe('管线清单', () => {
  it('PIPELINES 含 yrgb / rcm / aces，且 aces 标记为预留', () => {
    const ids = PIPELINES.map((p) => p.id);
    expect(ids).toEqual(['yrgb', 'rcm', 'aces']);
    expect(PIPELINES.find((p) => p.id === 'aces')?.reserved).toBe(true);
    expect(PIPELINES.find((p) => p.id === 'yrgb')?.reserved).toBeUndefined();
  });

  it('lookToLogLook 的默认 pivot 随管线：yrgb=0.5，rcm=0.333', () => {
    expect(lookToLogLook(defaultLook(), 'yrgb').pivot).toBe(0.5);
    expect(lookToLogLook(defaultLook(), 'rcm').pivot).toBeCloseTo(0.333, 6);
    expect(lookToLogLook(defaultLook(), 'aces').pivot).toBeCloseTo(0.333, 6);
  });
});

/* ================= R8 · Schema v1.2 分离色调（对数域路径） =================
 * 与 engine/look、GRADE_FS、DCTL 四处逐式镜像；这里钉死：
 *   ① split 全 0 时与「R7 之前的实现」逐位一致（默认恒等硬要求，参照实现独立复算）；
 *   ② 色相方向正确（暗部蓝 → B↑R↓；红反向）；
 *   ③ lookToLogLook 对新字段的透传/钳制。 */

/** R7 之前的对数域 look（无分离色调项）——独立复算的参照实现 */
function applyLogLookLegacy(rgb: RGB, p: LogLookParams): RGB {
  const pivot = clamp01(p.pivot);
  const contrast = Math.max(0, p.contrast);
  const softS = (x: number, s: number): number => {
    if (s <= 1e-6) return x;
    const pp = clamp01(pivot);
    const lo = pp < 1e-6 ? 1e-6 : pp;
    const hi = 1 - pp < 1e-6 ? 1e-6 : 1 - pp;
    if (x <= pp) { const u = clamp01(x / lo); const su = u * u * (3 - 2 * u); return pp * (u + (su - u) * s); }
    const u = clamp01((x - pp) / hi); const su = u * u * (3 - 2 * u); return pp + hi * (u + (su - u) * s);
  };
  const gammaS = (x: number, s: number): number => { if (s <= 1e-6) return x; const su = x * x * (3 - 2 * x); return x + (su - x) * s; };
  const toeShoulder = (x: number, toe: number, shoulder: number): number => {
    const pp = clamp01(pivot); let y = x;
    if (toe > 1e-6 && y < pp && pp > 1e-6) { const u = clamp01(y / pp); y = pp * Math.pow(u, 1 / (1 + toe)); }
    if (shoulder > 1e-6 && y > pp && pp < 1 - 1e-6) { const u = clamp01((y - pp) / (1 - pp)); y = pp + (1 - pp) * (1 - Math.pow(1 - u, 1 + shoulder)); }
    return y;
  };
  let c: RGB = [rgb[0], rgb[1], rgb[2]];
  if (Math.abs(contrast - 1) > 1e-9) c = [pivot + (c[0] - pivot) * contrast, pivot + (c[1] - pivot) * contrast, pivot + (c[2] - pivot) * contrast];
  if (p.film_s > 1e-6) c = [softS(c[0], p.film_s), softS(c[1], p.film_s), softS(c[2], p.film_s)];
  if (p.gamma_contrast > 1e-6) c = [gammaS(c[0], p.gamma_contrast), gammaS(c[1], p.gamma_contrast), gammaS(c[2], p.gamma_contrast)];
  if (p.toe > 1e-6 || p.shoulder > 1e-6) c = [toeShoulder(c[0], p.toe, p.shoulder), toeShoulder(c[1], p.toe, p.shoulder), toeShoulder(c[2], p.toe, p.shoulder)];
  if (p.crosstalk > 1e-9) {
    const k = p.crosstalk;
    c = [c[0] * (1 - k) + c[1] * (k * 0.55) + c[2] * (k * 0.3),
      c[0] * (k * 0.35) + c[1] * (1 - k * 0.8) + c[2] * (k * 0.45),
      c[0] * (k * 0.25) + c[1] * (k * 0.35) + c[2] * (1 - k * 1.6)];
  }
  const l = luma(c); const sh = Math.pow(clamp01(1 - l), 2.2); const hi = Math.pow(clamp01(l), 2.2);
  c[0] += p.shadow_bias * (-0.1 * sh) + p.highlight_bias * (0.1 * hi);
  c[1] += p.shadow_bias * (0.02 * sh) + p.highlight_bias * (0.08 * hi);
  c[2] += p.shadow_bias * (0.16 * sh) + p.highlight_bias * (-0.18 * hi);
  const blk = p.fade * 0.1; const wht = p.fade * 0.08; const sc = 1 - blk - wht;
  c = [blk + clamp01(c[0]) * sc, blk + clamp01(c[1]) * sc, blk + clamp01(c[2]) * sc];
  const l2 = luma(c);
  c = [l2 + (c[0] - l2) * p.saturation, l2 + (c[1] - l2) * p.saturation, l2 + (c[2] - l2) * p.saturation];
  c = [c[0] * (1 + p.warmth * 0.05), c[1] * (1 + p.warmth * 0.01), c[2] * (1 - p.warmth * 0.05)];
  return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
}

const NONZERO_LOG: LogLookParams[] = [
  { ...neutralLogLook(0.5), contrast: 1.3, film_s: 0.4, crosstalk: 0.2, shadow_bias: 0.3, highlight_bias: 0.2, fade: 0.3, saturation: 0.85, warmth: 0.2 },
  { ...neutralLogLook(0.333), toe: 0.3, shoulder: 0.2, gamma_contrast: 0.5, crosstalk: 0.1, saturation: 1.2, warmth: -0.4 },
];

describe('R8 对数域分离色调：默认恒等', () => {
  it('split 全 0 时 applyLogLook 与独立复算的旧实现最大分量差 < 1e-12', () => {
    const rnd = rng(303);
    let maxDiff = 0;
    for (const p of NONZERO_LOG) {
      for (let i = 0; i < 500; i++) {
        const rgb: RGB = [rnd(), rnd(), rnd()];
        const a = applyLogLook(rgb, p);
        const b = applyLogLookLegacy(rgb, p);
        for (let c = 0; c < 3; c++) maxDiff = Math.max(maxDiff, Math.abs(a[c] - b[c]));
      }
    }
    console.info('[R8 对数域 split 恒等] 与旧实现最大分量差 =', maxDiff.toExponential(3));
    expect(maxDiff).toBeLessThan(1e-12);
  });

  it('gammaLook 与 GRADE_FS 旧参照（gradeFsNoLut）在 split 全 0 时逐位一致（对数域/显示域镜像不漂移）', () => {
    const rnd = rng(404);
    const look: LookParams = {
      fade: 0.3, black_lift: 0.05, dye_coupling: 0.15, shadow_bias: 0.3, highlight_bias: 0.2,
      film_s: 0.5, contrast: 0.6, saturation: 0.9, warmth: 0.15,
      split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0,
    };
    let maxDiff = 0;
    for (let i = 0; i < 500; i++) {
      const rgb: RGB = [rnd(), rnd(), rnd()];
      const a = gammaLook(rgb, look);
      const b = gradeFsNoLut(rgb, look);
      for (let c = 0; c < 3; c++) maxDiff = Math.max(maxDiff, Math.abs(a[c] - b[c]));
    }
    console.info('[R8 gammaLook vs 旧参照] 最大分量差 =', maxDiff.toExponential(3));
    expect(maxDiff).toBeLessThan(1e-12);
  });
});

describe('R8 对数域分离色调：色相方向', () => {
  it('暗部对数域像素：蓝（0.66）→ B↑R↓；红（0）反向', () => {
    const dark: RGB = [0.2, 0.2, 0.2];
    const blue = applyLogLook(dark, { ...neutralLogLook(0.5), split_shadow_sat: 0.5, split_shadow_hue: 0.66 });
    const red = applyLogLook(dark, { ...neutralLogLook(0.5), split_shadow_sat: 0.5, split_shadow_hue: 0 });
    console.info('[R8 对数域暗部] 蓝 Δ(B-R)=', (blue[2] - blue[0]).toFixed(4), '红 Δ(R-B)=', (red[0] - red[2]).toFixed(4));
    expect(blue[2]).toBeGreaterThan(dark[2]);
    expect(blue[0]).toBeLessThan(dark[0]);
    expect(red[0]).toBeGreaterThan(dark[0]);
    expect(red[2]).toBeLessThan(dark[2]);
    expect(Math.sign(blue[2] - blue[0])).toBe(-Math.sign(red[2] - red[0]));
  });
});

describe('R8 lookToLogLook 透传新字段', () => {
  it('分离色调 5 字段透传（色相/饱和钳到 0..1，平衡钳到 -1..1）', () => {
    const look = {
      ...defaultLook(),
      split_shadow_hue: 0.66, split_shadow_sat: 0.5,
      split_highlight_hue: 0.08, split_highlight_sat: 0.4, split_balance: 0.75,
    };
    const l = lookToLogLook(look, 'yrgb');
    expect(l.split_shadow_hue).toBe(0.66);
    expect(l.split_shadow_sat).toBe(0.5);
    expect(l.split_highlight_hue).toBe(0.08);
    expect(l.split_highlight_sat).toBe(0.4);
    expect(l.split_balance).toBe(0.75);
    // 越界钳制
    const wild = lookToLogLook({ ...defaultLook(), split_shadow_sat: 9, split_balance: -9 }, 'yrgb');
    expect(wild.split_shadow_sat).toBe(1);
    expect(wild.split_balance).toBe(-1);
  });
});
