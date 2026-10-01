/**
 * R10 一致性测试（验收③）：look 数学搬进片元着色器后，
 *   「shader look 的 JS 镜像」 ≡ engine/look.lookTransform（≥1000 采样点，差 < 1e-3）；
 *   「匹配 LUT ∘ shader look」 ≡ 「复合 LUT（bakeRecipeLUT）」（≥500 采样点，差 < 1e-3）；
 *   默认中性 look 下两条路径逐位一致。
 *
 * 证明方式（诚实边界）：
 *   - GLSL 文本无法在 node 里执行。这里用**逐式转写的 JS 镜像**（glslLookMirror，
 *     严格照 GRADE_FS 的 look 段写）与 lookTransform 对拍 → 证明二者数学同源；
 *   - 同时**结构断言** GRADE_FS：look 段在 LUT 取样之后无条件执行、17 个 look uniform
 *     已声明与赋值、关键常数（染料耦合/偏置/分离色调 0.2/褪色/冷暖）与 look.ts 一致；
 *   - CPU 后端**直接调用 lookTransform**（结构断言），故 CPU 预览与 shader 路径同源。
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error 测试在 node 下运行；本项目未安装 @types/node
import { readFileSync } from 'node:fs';
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url';
import { analyzeImage, applyLUT, type RGB } from '../engine';
import { getPreset } from './params';
import { lookTransform, NEUTRAL_LOOK, type LookParams } from '../engine/look';
import { bakeMatchLUT, bakeRecipeLUT, matchTransform, type RecipeState } from '../ui/recipe';

const SRC = readFileSync(fileURLToPath(new URL('./pipeline.ts', import.meta.url)), 'utf8');

/* ---------------- GRADE_FS look 段的逐式 JS 镜像 ----------------
 * 与 pipeline.ts 的 GRADE_FS 一一对应（uniform 取 params.look 原始值，即 GPU 收到的值）。 */
const c01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a: number, b: number, x: number): number => {
  if (b <= a) return x >= b ? 1 : 0;
  const t = c01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const LR = 0.2126, LG = 0.7152, LB = 0.0722;
function refS(x: number): number {
  const lin = 0.42 + (x - 0.42) * 0.76;
  const toe = 0.030 + (lin - 0.030) * Math.pow(c01(x / 0.42), 0.75);
  let y = toe + (lin - toe) * sstep(0.02, 0.24, x);
  if (x > 0.55) { const u = (x - 0.55) / 0.45; y = 0.5188 + u * (0.342 + u * (0.7596 - u * 0.6204)); }
  return y;
}
const shapePos = (x: number, s: number): number => (s <= 0.001 ? x : x + (x * x * (3 - 2 * x) - x) * s);
const shapeNeg = (x: number, s: number): number => (s <= 0.001 ? x : x + (refS(x) - x) * s);
function splitDir(h: number): RGB {
  const hh = Math.min(1, Math.max(0, h));
  const h6 = (hh - Math.floor(hh)) * 6;
  const i = Math.floor(h6), f = h6 - i, q = 1 - f;
  let raw: RGB;
  if (i < 1) raw = [1, f, 0];
  else if (i < 2) raw = [q, 1, 0];
  else if (i < 3) raw = [0, 1, f];
  else if (i < 4) raw = [0, q, 1];
  else if (i < 5) raw = [f, 0, 1];
  else raw = [1, 0, q];
  const l = LR * raw[0] + LG * raw[1] + LB * raw[2];
  return [raw[0] - l, raw[1] - l, raw[2] - l];
}
function glslLookMirror(L: LookParams, rgb: RGB): RGB {
  let [r, g, b] = [c01(rgb[0]), c01(rgb[1]), c01(rgb[2])];
  r = shapeNeg(shapePos(r, L.contrast), L.film_s);
  g = shapeNeg(shapePos(g, L.contrast), L.film_s);
  b = shapeNeg(shapePos(b, L.contrast), L.film_s);
  /* R18：串扰六系数（与 GRADE_FS u_cRg..u_cBg 同源：缺省 = DEFAULT_COUPLING） */
  const C = L.coupling ?? {};
  const cRg = C.rg ?? 0.55, cRb = C.rb ?? 0.30, cGr = C.gr ?? 0.35, cGb = C.gb ?? 0.45, cBr = C.br ?? 0.25, cBg = C.bg ?? 0.35;
  const k = L.dye_coupling;
  const r2 = r * (1 - k) + g * (k * cRg) + b * (k * cRb);
  const g2 = r * (k * cGr) + g * (1 - k * 0.8) + b * (k * cGb);
  const b2 = r * (k * cBr) + g * (k * cBg) + b * (1 - k * 1.6);
  r = r2; g = g2; b = b2;
  const l = LR * r + LG * g + LB * b;
  const sh = Math.pow(c01(1 - l), 2.2), hi = Math.pow(c01(l), 2.2);
  r += L.shadow_bias * (-0.10 * sh) + L.highlight_bias * (0.10 * hi);
  g += L.shadow_bias * (0.02 * sh) + L.highlight_bias * (0.08 * hi);
  b += L.shadow_bias * (0.16 * sh) + L.highlight_bias * (-0.18 * hi);
  const spB = Math.min(1, Math.max(-1, L.split_balance));
  const spWS = sh * (1 - 0.5 * spB), spWH = hi * (1 + 0.5 * spB);
  const ds = splitDir(L.split_shadow_hue), dh = splitDir(L.split_highlight_hue);
  const ss = L.split_shadow_sat * spWS, hs = L.split_highlight_sat * spWH;
  r += (ds[0] * ss + dh[0] * hs) * 0.2;
  g += (ds[1] * ss + dh[1] * hs) * 0.2;
  b += (ds[2] * ss + dh[2] * hs) * 0.2;
  /* R18 HSL 8 色相（与 GRADE_FS rgb2hsv/hsv2rgb/带表逐式镜像；全 0 跳过 → 逐位恒等） */
  if (L.hsl && !hslIdentity(L.hsl)) {
    [r, g, b] = hslMirror(r, g, b, L.hsl);
  }
  const blk = L.black_lift + L.fade * 0.10, wht = L.fade * 0.08;
  r = c01(r); g = c01(g); b = c01(b);
  r = blk + r * (1 - blk - wht); g = blk + g * (1 - blk - wht); b = blk + b * (1 - blk - wht);
  const l2 = LR * r + LG * g + LB * b;
  r = (l2 + (r - l2) * L.saturation) * (1 + L.warmth * 0.05);
  g = (l2 + (g - l2) * L.saturation) * (1 + L.warmth * 0.01);
  b = (l2 + (b - l2) * L.saturation) * (1 - L.warmth * 0.05);
  return [c01(r), c01(g), c01(b)];
}

/** HSL：8 色相是否全 0（与 engine/look.hslIsIdentity 同式） */
function hslIdentity(hsl: NonNullable<LookParams['hsl']>): boolean {
  return (HSL_HUES as readonly string[]).every((key) => {
    const ch = (hsl as Record<string, { hue?: number; sat?: number; lum?: number }>)[key];
    return !ch || ((ch.hue ?? 0) === 0 && (ch.sat ?? 0) === 0 && (ch.lum ?? 0) === 0);
  });
}

/** HSL 8 色相的 GLSL 逐式镜像（带表/权重/量纲与 engine/look、GRADE_FS 一致） */
const HSL_HUES = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
const HSL_C = [0, 1 / 12, 1 / 6, 1 / 3, 0.5, 2 / 3, 7 / 9, 8 / 9];
function hslBand(h: number, c: number): number {
  let d = Math.abs(h - c);
  if (d > 0.5) d = 1 - d;
  const t = c01((d - 1 / 24) / (1 / 8 - 1 / 24));
  return 1 - t * t * (3 - 2 * t);
}
function hslMirror(r0: number, g0: number, b0: number, hsl: NonNullable<LookParams['hsl']>): RGB {
  const c = [c01(r0), c01(g0), c01(b0)];
  const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    const rr = (mx - c[0]) / d, gg = (mx - c[1]) / d, bb = (mx - c[2]) / d;
    const hh = mx === c[0] ? bb - gg : mx === c[1] ? 2 + rr - bb : 4 + gg - rr;
    h = hh / 6;
    if (h < 0) h += 1;
  }
  const sv = mx <= 0 ? 0 : d / mx, v0 = mx;
  let wS = 0, dH = 0, dS = 0, dL = 0;
  for (let i = 0; i < 8; i++) {
    const ch = (hsl as Record<string, { hue?: number; sat?: number; lum?: number }>)[HSL_HUES[i]];
    if (!ch) continue;
    const hue = ch.hue ?? 0, sat = ch.sat ?? 0, lum = ch.lum ?? 0;
    if (hue === 0 && sat === 0 && lum === 0) continue;
    const w = hslBand(h, HSL_C[i]);
    if (w <= 0) continue;
    wS += w; dH += w * hue; dS += w * sat; dL += w * lum;
  }
  if (wS <= 0) return [c[0], c[1], c[2]];
  const wn = 1 / wS;
  const h1 = h + dH * wn * (30 / 360);
  const s1 = c01(sv * (1 + dS * wn * 0.75));
  const v1 = c01(v0 * (1 + dL * wn * 0.30));
  const h6 = ((h1 % 1) + 1) % 1 * 6;
  const i6 = Math.floor(h6) % 6, f = h6 - Math.floor(h6);
  const p = v1 * (1 - s1), q = v1 * (1 - f * s1), t = v1 * (1 - (1 - f) * s1);
  const segs: RGB[] = [[v1, t, p], [q, v1, p], [p, v1, t], [p, q, v1], [t, p, v1], [v1, p, q]];
  return segs[i6];
}

/* 确定性采样点：LCG + 角点/灰阶（≥1000） */
function samples(n: number): RGB[] {
  const out: RGB[] = [];
  for (const c of [[0, 0, 0], [1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.5, 0.5, 0.5], [0.18, 0.18, 0.18], [0.9, 0.9, 0.9]] as RGB[]) out.push(c);
  let s = 0x12345678;
  const rnd = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
  for (let i = 0; i < n; i++) out.push([rnd(), rnd(), rnd()]);
  return out;
}

describe('R10 lookshader：GLSL look 段结构断言', () => {
  it('look 段在 LUT 取样之后无条件执行（不再有 else 分支）', () => {
    expect(SRC).toContain('if (u_useLut > 0.5) c = lutSample(c);');
    // LUT 取样后紧跟 shapePos/shapeNeg（同一无条件路径，顺序：匹配 → look）
    const at = SRC.indexOf('if (u_useLut > 0.5) c = lutSample(c);');
    const after = SRC.slice(at, at + 400);
    expect(after).toContain('c = vec3(shapePos(c.r), shapePos(c.g), shapePos(c.b));');
    expect(after).toContain('c = vec3(shapeNeg(c.r), shapeNeg(c.g), shapeNeg(c.b));');
    // GRADE_FS 内不应再有「LUT 命中则跳过 look」的 else
    expect(SRC).not.toContain('} else {\n  c = vec3(shapePos');
  });

  it('look uniform 已声明（9 + 5 分离色调 + R18 六系数/HSL 8 色相，另 u_useLut/u_lutN 为 LUT）', () => {
    expect(SRC).toContain('uniform float u_fade,u_black,u_coupling,u_shBias,u_hiBias,u_sat,u_filmS,u_contrast,u_warm;');
    expect(SRC).toContain('uniform float u_spShHue,u_spShSat,u_spHiHue,u_spHiSat,u_spBal;');
    expect(SRC).toContain('uniform float u_cRg,u_cRb,u_cGr,u_cGb,u_cBr,u_cBg;');
    expect(SRC).toContain('uniform vec3 u_hsl[8];');
  });

  it('runGrade 始终从 params.look 赋值 look uniform（不再按 LUT 命中清零）', () => {
    for (const u of ['u_fade', 'u_black', 'u_coupling', 'u_shBias', 'u_hiBias', 'u_sat', 'u_filmS', 'u_contrast', 'u_warm', 'u_spShHue', 'u_spShSat', 'u_spHiHue', 'u_spHiSat', 'u_spBal']) {
      expect(SRC).toContain(`pr.u['${u}']`);
    }
    expect(SRC).toContain("pr.u['u_fade'], L.fade");
    expect(SRC).toContain("pr.u['u_spBal'], L.split_balance ?? 0");
    for (const u of ['u_cRg', 'u_cRb', 'u_cGr', 'u_cGb', 'u_cBr', 'u_cBg']) expect(SRC).toContain(`pr.u['${u}']`);
    expect(SRC).toContain("pr.u['u_hsl'], hslUniforms(L.hsl)");
    // 旧的「LUT 命中即把 look uniform 清零」写法必须消失
    expect(SRC).not.toContain("pr.u['u_fade'], 0");
    expect(SRC).not.toContain("pr.u['u_sat'], 1");
  });

  it('CPU 后端直接调用 lookTransform（同源实现，非二次转写）', () => {
    expect(SRC).toContain('lookTransform(this.params.look');
    expect(SRC).toContain("import {\n  DEFAULT_COUPLING, HSL_HUES, couplingIsDefault, hslIsIdentity,");
  });

  it('关键常数与 engine/look 冻结值一致（染料耦合 / 偏置 / 分离色调 0.2 / 褪色 / 冷暖）', () => {
    for (const frag of [
      'c.r*(1.0-k)      + c.g*(k*u_cRg)    + c.b*(k*u_cRb)',
      'c.r*(k*u_cGr)    + c.g*(1.0-k*0.8)  + c.b*(k*u_cGb)',
      'c.r*(k*u_cBr)    + c.g*(k*u_cBg)    + c.b*(1.0-k*1.6)',
      'u_shBias*(-0.10*sh) + u_hiBias*( 0.10*hi)',
      '+ dh * (u_spHiSat * spWH)) * 0.2',
      'u_black + u_fade*0.10',
      'u_fade*0.08',
      'vec3(1.0+u_warm*0.05, 1.0+u_warm*0.01, 1.0-u_warm*0.05)',
    ]) expect(SRC).toContain(frag);
  });
});

describe('R10 lookshader：数值一致性（验收③）', () => {
  it('shader look JS 镜像 ≡ lookTransform（≥1000 采样点，差 < 1e-3）', () => {
    const looks: LookParams[] = [
      NEUTRAL_LOOK,
      { ...NEUTRAL_LOOK, fade: 0.75, black_lift: 0.1, dye_coupling: 0.22, shadow_bias: 0.55, highlight_bias: 0.45, film_s: 0.25, saturation: 0.8, warmth: 0.05 },
      { ...NEUTRAL_LOOK, film_s: 0.8, contrast: 0.5, saturation: 1.14, warmth: -0.3, shadow_bias: 0.3, highlight_bias: 0.2, black_lift: 0.04 },
      { ...NEUTRAL_LOOK, split_shadow_hue: 0.62, split_shadow_sat: 0.75, split_highlight_hue: 0.55, split_highlight_sat: 0.4, split_balance: -0.25 },
      { ...NEUTRAL_LOOK, split_shadow_hue: 0.42, split_shadow_sat: 0.6, split_highlight_hue: 0.1, split_highlight_sat: 0.5, split_balance: 0.15, contrast: 0.6, saturation: 1.2 },
      /* R18：非默认串扰六系数 + HSL 8 色相（镜像覆盖新维度） */
      { ...NEUTRAL_LOOK, dye_coupling: 0.18, coupling: { rg: 0.2, rb: 0.9, gr: 0.1, gb: 0.7, br: 0.4, bg: 0.05 }, hsl: { red: { hue: 0.5, sat: 0.3, lum: -0.2 }, green: { hue: -0.4, sat: 0.6, lum: 0.3 }, blue: { hue: 0, sat: -0.5, lum: 0 }, aqua: { hue: 1, sat: 0, lum: 0.4 }, magenta: { hue: -1, sat: 1, lum: -1 } } },
      { ...NEUTRAL_LOOK, dye_coupling: 0.22, hsl: { orange: { hue: -0.2, sat: -0.8, lum: 0.5 }, yellow: { hue: 0.9, sat: 0.1, lum: -0.6 }, purple: { hue: 0.3, sat: 0.9, lum: 0.1 } } },
    ];
    let max = 0;
    for (const L of looks) {
      const fn = lookTransform(L);
      for (const c of samples(1100)) {
        const a = fn([c[0], c[1], c[2]]);
        const b = glslLookMirror(L, c);
        for (let ch = 0; ch < 3; ch++) max = Math.max(max, Math.abs(a[ch] - b[ch]));
      }
    }
    expect(max).toBeLessThan(1e-3);
    console.info(`[R10 一致性] shader look JS 镜像 vs lookTransform：max 分量差 = ${max.toExponential(3)}（7 组 look × 1108 点）`);
  });

  /* 合成一对「相近但有差异」的参考/被调色图统计：模拟真实工作台（匹配校正温和、
   * 匹配变换输出不越界 → 65³ LUT 可忠实重建）。用极端色偏会让匹配输出被钳制、
   * 复合 LUT 出现折点，误差不再是 look 搬移引入的（见回执说明）。 */
  const synth = (): { ref: ReturnType<typeof analyzeImage>; user: ReturnType<typeof analyzeImage> } => {
    const S = 256;
    const mk = (f: (x: number, y: number) => [number, number, number]): ReturnType<typeof analyzeImage> => {
      const a = new Uint8ClampedArray(S * S * 4);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4, [r, g, b] = f(x / S, y / S);
        a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = 255;
      }
      return analyzeImage(a, S, S);
    };
    return {
      ref: mk((x, y) => [40 + 180 * x, 60 + 150 * y, 90 + 120 * (1 - x * y)]),
      user: mk((x, y) => [45 + 178 * x, 64 + 148 * y, 92 + 119 * (1 - x * y)]),
    };
  };
  const stateOf = (presetId: string, look: LookParams, stats: ReturnType<typeof synth> | null, matchStrength = 0.75): RecipeState => {
    const card = getPreset(presetId);
    return {
      colorParams: { match_strength: matchStrength, skin_hue: 0, skin_sat: 1, skin_isolation: 0, split_tone: 0, tone_contrast: 1, shadow_lift: 0, global_sat: 1, highlight_rolloff: 0 },
      look: look as never,
      texture: card.params.texture,
      master: 1,
      origins: { ...card.origins },
      refStats: stats?.ref ?? null,
      userStats: stats?.user ?? null,
    };
  };

  it('匹配 LUT ∘ shader look ≡ 复合 LUT（≥500 采样点，差 < 1e-3）', () => {
    const st = stateOf('fl05', getPreset('fl05').params.look as LookParams, synth());
    expect(matchTransform(st)).not.toBeNull();   // 确为「匹配 LUT ∘ look」路径
    const lookFn = lookTransform(st.look as unknown as LookParams);
    const matchLUT = bakeMatchLUT(st, 65);       // 预览：只匹配
    const composite = bakeRecipeLUT(st, 65);     // 导出：匹配∘look
    let max = 0;
    for (const c of samples(560)) {
      const a = lookFn(applyLUT(matchLUT, [c[0], c[1], c[2]]));
      const b = applyLUT(composite, [c[0], c[1], c[2]]);
      for (let ch = 0; ch < 3; ch++) max = Math.max(max, Math.abs(a[ch] - b[ch]));
    }
    expect(max).toBeLessThan(1e-3);
    console.info(`[R10 一致性] 匹配LUT∘shader look vs 复合LUT：max 分量差 = ${max.toExponential(3)}（560 点，fl05 look + 活跃匹配）`);
  });

  it('默认中性 look：两条路径逐位一致', () => {
    const st = stateOf('neutral', NEUTRAL_LOOK, synth());
    const lookFn = lookTransform(NEUTRAL_LOOK);
    const matchLUT = bakeMatchLUT(st, 65);
    const composite = bakeRecipeLUT(st, 65);
    expect(matchLUT.size).toBe(composite.size);
    expect(matchLUT.table.length).toBe(composite.table.length);
    let max = 0, exact = true;
    for (const c of samples(520)) {
      const a = lookFn(applyLUT(matchLUT, [c[0], c[1], c[2]]));
      const b = applyLUT(composite, [c[0], c[1], c[2]]);
      for (let ch = 0; ch < 3; ch++) { if (a[ch] !== b[ch]) exact = false; max = Math.max(max, Math.abs(a[ch] - b[ch])); }
    }
    // 逐位一致（中性 look = 恒等，两条路径都退化为仅匹配 LUT）
    expect(exact).toBe(true);
    expect(max).toBe(0);
  });
});