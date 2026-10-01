/**
 * lookTransform（engine/look.ts）验收测试。
 * 覆盖：neutral 恒等 / 黑位抬升（褪色）/ 家族B 对比增大 / 家族A 黑位锚定与白点保持 / 与 LUT 烘焙兼容。
 */
import { describe, expect, it } from 'vitest';
import { rgbToLab, deltaE76 } from './color';
import { bakeLUT, applyLUT } from './lut';
import {
  lookTransform, NEUTRAL_LOOK, refCurveA, splitHueRGB, splitBalanceGains, SPLIT_SCALE,
  type LookParams,
} from './look';

/** 可复现伪随机（mulberry32） */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function de76(a: [number, number, number], b: [number, number, number]): number {
  const l1 = rgbToLab(a[0], a[1], a[2]);
  const l2 = rgbToLab(b[0], b[1], b[2]);
  return deltaE76(l1[0], l1[1], l1[2], l2[0], l2[1], l2[2]);
}

const luma = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

describe('lookTransform', () => {
  it('neutral look 恒等：1000 随机点 ΔE76 < 0.5', () => {
    const fn = lookTransform({ ...NEUTRAL_LOOK });
    const r = rng(7);
    let maxDE = 0;
    for (let i = 0; i < 1000; i++) {
      const p: [number, number, number] = [r(), r(), r()];
      maxDE = Math.max(maxDE, de76(fn(p), p));
    }
    console.info('[look neutral] max ΔE76 =', maxDE.toFixed(6));
    expect(maxDE).toBeLessThan(0.5);
  });

  it('fade > 0 时黑位抬升：黑点输出显著大于 0，且暗部整体上移', () => {
    const fn = lookTransform({ ...NEUTRAL_LOOK, fade: 0.8 });
    const black = fn([0, 0, 0]);
    console.info('[look fade] 黑点输出 =', black.map((v) => v.toFixed(4)).join(','));
    // blk = 0.8*0.10 = 0.08，wht = 0.064 → 黑点 ≈ 0.08
    expect(luma(black)).toBeGreaterThan(0.04);
    expect(luma(black)).toBeLessThan(0.12);
    // 暗灰也整体抬升
    expect(luma(fn([0.1, 0.1, 0.1]))).toBeGreaterThan(0.1);
    // 白位收拢：白点 < 1（fade*0.08 = 0.064）
    expect(luma(fn([1, 1, 1]))).toBeLessThan(0.985);
  });

  it('家族B（contrast）对比增大：0.25/0.75 两点间距扩大且方向正确', () => {
    const fn = lookTransform({ ...NEUTRAL_LOOK, contrast: 0.9 });
    const lo = fn([0.25, 0.25, 0.25]);
    const hi = fn([0.75, 0.75, 0.75]);
    const spread = luma(hi) - luma(lo);
    console.info('[look 家族B] 输出间距 =', spread.toFixed(4), '（输入 0.5）');
    expect(spread).toBeGreaterThan(0.5);
    expect(luma(lo)).toBeLessThan(0.25);
    expect(luma(hi)).toBeGreaterThan(0.75);
  });

  it('家族A（film_s=1）黑位锚定 ≈0.030、白点严格保持', () => {
    const fn = lookTransform({ ...NEUTRAL_LOOK, film_s: 1 });
    const black = luma(fn([0, 0, 0]));
    const white = fn([1, 1, 1]);
    console.info('[look 家族A] 黑位 =', black.toFixed(4), '白点 =', white.map((v) => v.toFixed(5)).join(','));
    expect(Math.abs(black - refCurveA(0))).toBeLessThan(1e-6);
    expect(black).toBeGreaterThan(0.02);
    expect(black).toBeLessThan(0.045);
    expect(white[0]).toBeCloseTo(1, 5);
    expect(white[1]).toBeCloseTo(1, 5);
    expect(white[2]).toBeCloseTo(1, 5);
  });

  it('复合变换可烘焙：bakeLUT(65) 采样与直接变换 ΔE76 < 1.0（预览/导出同源前提）', () => {
    const look = { ...NEUTRAL_LOOK, film_s: 0.6, fade: 0.3, warmth: 0.2, saturation: 0.9, dye_coupling: 0.1 };
    const fn = lookTransform(look);
    const lut = bakeLUT(fn, 65);
    const r = rng(31);
    let maxDE = 0;
    for (let i = 0; i < 800; i++) {
      const p: [number, number, number] = [r(), r(), r()];
      maxDE = Math.max(maxDE, de76(applyLUT(lut, p), fn(p)));
    }
    console.info('[look LUT 保真] max ΔE76 =', maxDE.toFixed(4));
    expect(maxDE).toBeLessThan(1.0);
  });
});

/* ================= R8 · Schema v1.2 分离色调 =================
 * 数学真源见 look.ts 文件头冻结定义；四处镜像（engine/GLSL/对数域/DCTL）必须逐式一致。
 * 这里钉死三件事：① 默认（split 全 0）与「R7 之前的实现」逐位一致（默认恒等硬要求）；
 * ② 色相方向正确（蓝 → 暗部 B↑R↓；红反向；高光同理）；③ 平衡单调性。 */

/** R7 之前的实现（无分离色调项）——独立复算的参照实现，用于默认恒等断言 */
function legacyLookTransform(look: LookParams): (rgb: [number, number, number]) => [number, number, number] {
  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
  const smoothstep = (a: number, b: number, x: number): number => {
    if (b <= a) return x >= b ? 1 : 0;
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  };
  const LR = 0.2126, LG = 0.7152, LB = 0.0722;
  const refCurveA = (x: number): number => {
    const lin = 0.42 + (x - 0.42) * 0.76;
    const toe = 0.03 + (lin - 0.03) * Math.pow(clamp01(x / 0.42), 0.75);
    let y = toe + (lin - toe) * smoothstep(0.02, 0.24, x);
    if (x > 0.55) { const u = (x - 0.55) / 0.45; y = 0.5188 + u * (0.342 + u * (0.7596 - u * 0.6204)); }
    return y;
  };
  const shapeNeg = (x: number, s: number): number => (s <= 0.001 ? x : x + (refCurveA(x) - x) * s);
  const shapePos = (x: number, s: number): number => (s <= 0.001 ? x : x + (x * x * (3 - 2 * x) - x) * s);
  const fade = clamp01(look.fade), black = clamp01(look.black_lift);
  const coupling = Math.min(0.5, Math.max(0, look.dye_coupling));
  const shBias = Math.min(1, Math.max(-1, look.shadow_bias));
  const hiBias = Math.min(1, Math.max(-1, look.highlight_bias));
  const filmS = clamp01(look.film_s), contrast = clamp01(look.contrast);
  const sat = Math.min(2, Math.max(0, look.saturation));
  const warm = Math.min(1, Math.max(-1, look.warmth));
  const blk = black + fade * 0.1, wht = fade * 0.08;
  return (rgb) => {
    let r = clamp01(rgb[0]), g = clamp01(rgb[1]), b = clamp01(rgb[2]);
    r = shapeNeg(shapePos(r, contrast), filmS);
    g = shapeNeg(shapePos(g, contrast), filmS);
    b = shapeNeg(shapePos(b, contrast), filmS);
    const k = coupling;
    const r2 = r * (1 - k) + g * (k * 0.55) + b * (k * 0.3);
    const g2 = r * (k * 0.35) + g * (1 - k * 0.8) + b * (k * 0.45);
    const b2 = r * (k * 0.25) + g * (k * 0.35) + b * (1 - k * 1.6);
    r = r2; g = g2; b = b2;
    const l = LR * r + LG * g + LB * b;
    const sh = Math.pow(clamp01(1 - l), 2.2), hi = Math.pow(clamp01(l), 2.2);
    r += shBias * -0.1 * sh + hiBias * 0.1 * hi;
    g += shBias * 0.02 * sh + hiBias * 0.08 * hi;
    b += shBias * 0.16 * sh + hiBias * -0.18 * hi;
    r = clamp01(r); g = clamp01(g); b = clamp01(b);
    r = blk + r * (1 - blk - wht); g = blk + g * (1 - blk - wht); b = blk + b * (1 - blk - wht);
    const l2 = LR * r + LG * g + LB * b;
    r = (l2 + (r - l2) * sat) * (1 + warm * 0.05);
    g = (l2 + (g - l2) * sat) * (1 + warm * 0.01);
    b = (l2 + (b - l2) * sat) * (1 - warm * 0.05);
    return [clamp01(r), clamp01(g), clamp01(b)];
  };
}

/** 一组非中性的 look（覆盖各参数分支），split 全 0 */
const NONZERO_LOOKS: LookParams[] = [
  { ...NEUTRAL_LOOK, film_s: 0.6, fade: 0.3, warmth: 0.2, saturation: 0.9, dye_coupling: 0.1 },
  { ...NEUTRAL_LOOK, contrast: 0.8, black_lift: 0.05, shadow_bias: 0.3, highlight_bias: 0.2 },
  { ...NEUTRAL_LOOK, film_s: 1, contrast: 1, fade: 0.5, saturation: 0.4, warmth: -0.5, dye_coupling: 0.35 },
];

describe('R8 分离色调：默认恒等（与 R7 之前实现逐位一致）', () => {
  it('split_* 全 0 时，lookTransform 与独立复算的旧实现最大分量差 < 1e-12', () => {
    const r = rng(101);
    let maxDiff = 0;
    for (const look of NONZERO_LOOKS) {
      const fn = lookTransform(look);
      const legacy = legacyLookTransform(look);
      for (let i = 0; i < 500; i++) {
        const p: [number, number, number] = [r(), r(), r()];
        const a = fn(p), b = legacy(p);
        for (let c = 0; c < 3; c++) maxDiff = Math.max(maxDiff, Math.abs(a[c] - b[c]));
      }
    }
    console.info('[R8 split 恒等] 与旧实现最大分量差 =', maxDiff.toExponential(3));
    expect(maxDiff).toBeLessThan(1e-12);
  });

  it('split 全 0 时 NEUTRAL_LOOK 仍严格恒等；只改色相/平衡（饱和为 0）也不改变画面', () => {
    const neutral = lookTransform({ ...NEUTRAL_LOOK });
    const hueOnly = lookTransform({ ...NEUTRAL_LOOK, split_shadow_hue: 0.66, split_highlight_hue: 0.1, split_balance: 1 });
    const r = rng(202);
    for (let i = 0; i < 300; i++) {
      const p: [number, number, number] = [r(), r(), r()];
      const a = neutral(p), b = hueOnly(p);
      for (let c = 0; c < 3; c++) expect(Math.abs(a[c] - b[c])).toBeLessThan(1e-12);
    }
  });
});

describe('R8 分离色调：色相方向正确', () => {
  const DARK: [number, number, number] = [0.1, 0.1, 0.1];
  const BRIGHT: [number, number, number] = [0.9, 0.9, 0.9];

  it('splitHueRGB：零亮度方向（Rec.709 加权和≈0）；蓝 0.66 → B 正 R 负；红 0 → R 正 B 负', () => {
    for (const h of [0, 0.16, 0.33, 0.5, 0.66, 0.83]) {
      const d = splitHueRGB(h);
      expect(Math.abs(0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2])).toBeLessThan(1e-12);
    }
    const blue = splitHueRGB(0.66);
    expect(blue[2]).toBeGreaterThan(0);
    expect(blue[0]).toBeLessThan(0);
    const red = splitHueRGB(0);
    expect(red[0]).toBeGreaterThan(0);
    expect(red[2]).toBeLessThan(0);
  });

  it('暗部像素：蓝（0.66）→ B↑R↓；红（0）→ 反向（R↑B↓）', () => {
    const blue = lookTransform({ ...NEUTRAL_LOOK, split_shadow_sat: 0.5, split_shadow_hue: 0.66 })(DARK);
    const red = lookTransform({ ...NEUTRAL_LOOK, split_shadow_sat: 0.5, split_shadow_hue: 0 })(DARK);
    console.info('[R8 暗部] 蓝 h=0.66 Δ(B-R)=', (blue[2] - blue[0]).toFixed(4), '红 h=0 Δ(R-B)=', (red[0] - red[2]).toFixed(4));
    expect(blue[2]).toBeGreaterThan(DARK[2]);
    expect(blue[0]).toBeLessThan(DARK[0]);
    expect(red[0]).toBeGreaterThan(DARK[0]);
    expect(red[2]).toBeLessThan(DARK[2]);
    // 蓝与红方向相反
    expect(Math.sign(blue[2] - blue[0])).toBe(-Math.sign(red[2] - red[0]));
  });

  it('高光像素：蓝（0.66）→ B↑R↓；红（0）→ 反向；且暗部权重不波及高光（反之亦然）', () => {
    const hiBlue = lookTransform({ ...NEUTRAL_LOOK, split_highlight_sat: 0.5, split_highlight_hue: 0.66 })(BRIGHT);
    const hiRed = lookTransform({ ...NEUTRAL_LOOK, split_highlight_sat: 0.5, split_highlight_hue: 0 })(BRIGHT);
    console.info('[R8 高光] 蓝 h=0.66 Δ(B-R)=', (hiBlue[2] - hiBlue[0]).toFixed(4), '红 h=0 Δ(R-B)=', (hiRed[0] - hiRed[2]).toFixed(4));
    expect(hiBlue[2]).toBeGreaterThan(BRIGHT[2]);
    expect(hiBlue[0]).toBeLessThan(BRIGHT[0]);
    expect(hiRed[0]).toBeGreaterThan(BRIGHT[0]);
    expect(hiRed[2]).toBeLessThan(BRIGHT[2]);
    // 只设暗部染色：高光像素几乎不动（权重 hi 在亮部≈1 但暗部染色按 sh 加权，亮部 sh≈0）
    const shOnly = lookTransform({ ...NEUTRAL_LOOK, split_shadow_sat: 0.5, split_shadow_hue: 0.66 })(BRIGHT);
    expect(Math.abs(shOnly[2] - BRIGHT[2])).toBeLessThan(1e-3);
    // 只设高光染色：暗部像素几乎不动
    const hiOnly = lookTransform({ ...NEUTRAL_LOOK, split_highlight_sat: 0.5, split_highlight_hue: 0.66 })(DARK);
    expect(Math.abs(hiOnly[2] - DARK[2])).toBeLessThan(1e-3);
  });
});

describe('R8 分离色调：平衡单调性', () => {
  it('splitBalanceGains：b -1→+1 高光增益单调升、暗部增益单调降，b=0 恒等 {1,1}', () => {
    expect(splitBalanceGains(0)).toEqual({ shadow: 1, highlight: 1 });
    const bs = [-1, -0.5, 0, 0.5, 1];
    for (let i = 1; i < bs.length; i++) {
      const a = splitBalanceGains(bs[i - 1]), b = splitBalanceGains(bs[i]);
      expect(b.highlight).toBeGreaterThan(a.highlight);
      expect(b.shadow).toBeLessThan(a.shadow);
    }
    // 越界钳制
    expect(splitBalanceGains(5)).toEqual(splitBalanceGains(1));
    expect(splitBalanceGains(-5)).toEqual(splitBalanceGains(-1));
  });

  it('中间调像素：balance -1→+1，高光权重上升 → 蓝通道单调不增（高光橙、暗部蓝）', () => {
    const mid: [number, number, number] = [0.5, 0.5, 0.5];
    const mk = (balance: number) => lookTransform({
      ...NEUTRAL_LOOK,
      split_shadow_sat: 0.6, split_shadow_hue: 0.62,
      split_highlight_sat: 0.6, split_highlight_hue: 0.08,
      split_balance: balance,
    })(mid);
    const bs = [-1, -0.5, 0, 0.5, 1];
    const blues = bs.map((b) => mk(b)[2]);
    console.info('[R8 平衡] 蓝通道随 balance =', blues.map((v) => v.toFixed(5)).join(' → '));
    for (let i = 1; i < blues.length; i++) expect(blues[i]).toBeLessThanOrEqual(blues[i - 1] + 1e-12);
    expect(blues[0]).toBeGreaterThan(blues[blues.length - 1]); // 确实有单调下降（非恒定）
    // 平衡中性点：色相/饱和不变时，balance=0 的暗/高光权重相等（按 sh/hi 各自的权重）
    const a = splitBalanceGains(0);
    expect(a.shadow).toBe(a.highlight);
  });
});

describe('R8 分离色调：GLSL 与 JS 同源（结构断言）', () => {
  it('pipeline.GRADE_FS 含 splitDir 与权重曲线形式、常数与 JS 一致；并诚实标注未执行 GLSL', async () => {
    // 无 GLSL 执行 harness（vitest 环境为 node，无 WebGL），故这里只做结构断言，不假装跑过 GLSL。
    const fs = await import(/* @vite-ignore */ 'node:fs' as string);
    const url = await import(/* @vite-ignore */ 'node:url' as string);
    const file = url.fileURLToPath(new URL('../film/pipeline.ts', import.meta.url));
    const src = fs.readFileSync(file, 'utf8') as string;
    // 分离色调 GLSL 段存在，且与 engine/look 同式
    expect(src).toContain('vec3 splitDir(float h)');
    expect(src).toContain('u_spShHue');
    expect(src).toContain('u_spHiSat');
    // 权重曲线：sh * (1 - 0.5*b) / hi * (1 + 0.5*b)（与 splitBalanceGains 同式）
    expect(src).toContain('1.0 - 0.5*spB');
    expect(src).toContain('1.0 + 0.5*spB');
    // 叠加常数：GLSL 字面量 0.2 == JS SPLIT_SCALE
    expect(SPLIT_SCALE).toBe(0.2);
    expect(/\(u_spShSat \* spWS\) \+ dh \* \(u_spHiSat \* spWH\)\) \* 0\.2/.test(src)).toBe(true);
    // 亮度权重幂曲线同式
    expect(src).toContain('pow(clamp(1.0-l,0.,1.), 2.2)');
    // 色相轮 6 段与 splitHueRGB 同式（同一条 vec3 分支表）
    expect(src).toContain('raw = vec3(1.0, f, 0.0)');
    expect(src).toContain('raw - vec3(dot(raw, vec3(0.2126, 0.7152, 0.0722)))');
  });
});
