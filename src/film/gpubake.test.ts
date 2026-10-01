/**
 * R17 GPU tile-atlas LUT 烘焙测试（node 环境，无法执行 GLSL —— 口径与 R8/R10 一致的诚实边界）：
 *
 * 1) 纯数学一致性：把 BAKE_FS 的逐像素公式**逐式转写为 JS 镜像**（从 GLSL 文本抄写，
 *    含 float32 曲线/包络、pow 替代 cbrt 等与 CPU 实现的真实差异点），与 CPU/worker
 *    路径（bakeMatchLUT / bakeRecipeLUT）在 ≥500 个格点上对拍，max 差 < 1e-3（R10 口径）。
 * 2) GLSL 结构断言：关键行存在、公式顺序一致（atlas 解码 → 匹配 → look → legal 回编）、
 *    关键常数与 TS 单一真源一致（皮肤域/亮度窗/膝点/分离色调 0.2/锚点 128 等）。
 * 3) 能力探测与 atlas→引擎表布局：RGBA32F 优先、readPixels(RGBA,FLOAT)、atlasToEngine
 *    与既有 uploadLut 的「atlas 像素 (g*n²+b*n+r)」一一对应。
 * 4) 浏览器端的端到端一致性（SwiftShader 真实 GPU 烘焙 vs CPU 烘焙）走 E2E demo=range
 *    （#e2e-meta.bakeConsistency，e2e-verify R17-1 断言 <1e-3、≥500 点）。
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error 测试在 node 下运行；本项目未安装 @types/node
import { readFileSync } from 'node:fs';
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url';
import { analyzeImage, withSource, type RGB } from '../engine';
import { LEGAL_HIGH, LEGAL_LOW, bakeLUT } from '../engine/lut';
import { matchBakeData, type MatchBakeData } from '../engine/match';
import type { LookParams } from '../engine/look';
import { getPreset } from './params';
import { bakeMatchLUT, bakeRecipeLUT, type RecipeState } from '../ui/recipe';
import { atlasToEngine, BAKE_FS, VERT300 } from './gpubake';

const MODULE_SRC = readFileSync(fileURLToPath(new URL('./gpubake.ts', import.meta.url)), 'utf8');

/* ---------------- 测试夹具（与 workers.test.ts 同思路） ---------------- */

function synthStats(): { ref: ReturnType<typeof analyzeImage>; user: ReturnType<typeof analyzeImage> } {
  const S = 96;
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
}

/** 非中性 look（覆盖全部 14 个 look 维度，含 v1.2 分离色调） */
const ACTIVE_LOOK: LookParams = {
  fade: 0.2, black_lift: 0.05, dye_coupling: 0.15, shadow_bias: -0.2, highlight_bias: 0.3,
  film_s: 0.4, contrast: 0.25, saturation: 1.1, warmth: 0.15,
  split_shadow_hue: 0.55, split_shadow_sat: 0.2, split_highlight_hue: 0.1,
  split_highlight_sat: 0.15, split_balance: -0.2,
};

function stateFixture(withStats: boolean, look: LookParams = ACTIVE_LOOK): RecipeState {
  const card = getPreset('fl05');
  const stats = synthStats();
  return {
    colorParams: { match_strength: 0.75, skin_hue: 0, skin_sat: 1, skin_isolation: 0, split_tone: 0, tone_contrast: 1, shadow_lift: 0, global_sat: 1, highlight_rolloff: 0 },
    look,
    texture: card.params.texture,
    master: 1,
    origins: { ...card.origins },
    refStats: withStats ? stats.ref : null,
    userStats: withStats ? stats.user : null,
  };
}

function mdFixture(): MatchBakeData {
  const st = stateFixture(true);
  return matchBakeData(withSource(st.refStats!, st.userStats!), st.colorParams);
}

/* ---------------- BAKE_FS 逐像素公式的 JS 镜像（从 GLSL 逐式抄写） ----------------
 * 注意镜像的是 **GLSL 的写法**（而非 CPU 实现）：
 *   - labF 用 pow(t, 1/3)（GLSL 无 cbrt；CPU 用 Math.cbrt —— 真实数值差异，进对拍）；
 *   - 曲线/包络取 MatchBakeData 的 Float32 表（GPU 收到的就是它，CPU 用 float64 曲线）；
 *   - mix(x, y, s) = x*(1-s)+y*s；smoothstep 为 GLSL 内置语义。
 */
const c01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a: number, b: number, x: number): number => {
  if (b <= a) return x >= b ? 1 : 0;
  const t = c01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const sstepGl = (a: number, b: number, x: number): number => {
  const t = c01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (x: number, y: number, s: number): number => x * (1 - s) + y * s;
const LR = 0.2126, LG = 0.7152, LB = 0.0722;
const LAB_EPS = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

function srgbToLinear(c: number): number { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function linearToSrgb(c: number): number { return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }
function labF(t: number): number { return t > LAB_EPS ? Math.pow(t, 1 / 3) : (LAB_KAPPA * t + 16) / 116; }

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const x = 0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = 0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb;
  const fx = labF(x / 0.95047), fy = labF(y / 1.0), fz = labF(z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function linAtScaled(L: number, a: number, b: number, s: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const yr = L > 8.0 ? fy * fy * fy : L / LAB_KAPPA;
  const fx = fy + (s * a) / 500;
  const fz = fy - (s * b) / 200;
  const xr = fx * fx * fx > LAB_EPS ? fx * fx * fx : (116 * fx - 16) / LAB_KAPPA;
  const zr = fz * fz * fz > LAB_EPS ? fz * fz * fz : (116 * fz - 16) / LAB_KAPPA;
  const x = xr * 0.95047, y = yr * 1.0, z = zr * 1.08883;
  return [3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z];
}
const inG = (l: [number, number, number]): boolean =>
  l[0] >= -1e-9 && l[0] <= 1 + 1e-9 && l[1] >= -1e-9 && l[1] <= 1 + 1e-9 && l[2] >= -1e-9 && l[2] <= 1 + 1e-9;

function labToRgb(L: number, a: number, b: number): [number, number, number] {
  let lin = linAtScaled(L, a, b, 1);
  if (!inG(lin)) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) * 0.5;
      if (inG(linAtScaled(L, a, b, mid))) lo = mid; else hi = mid;
    }
    lin = linAtScaled(L, a, b, lo);
  }
  return [c01(linearToSrgb(c01(lin[0]))), c01(linearToSrgb(c01(lin[1]))), c01(linearToSrgb(c01(lin[2])))];
}

function curveAt(md: MatchBakeData, L0: number): number {
  const x = c01v(L0, 0, 100) * (128.0 / 100.0);
  const i0 = x >= 128.0 ? 127 : Math.floor(x);
  const ft = x - i0;
  const a = md.curve[i0], b = md.curve[i0 + 1];
  return a + (b - a) * ft;
}
const c01v = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function envLookup(md: MatchBakeData, L: number, hueRad: number): number {
  let h = (hueRad * 180) / Math.PI;
  h = h - 360 * Math.floor(h / 360);   // GLSL mod：结果非负
  const fh = h / md.envHStep;
  const fl = c01v(L, 0, 100) / md.envLStep;
  const ih0 = Math.min(md.envW - 1, Math.floor(fh));
  const il0 = Math.min(md.envH - 1, Math.floor(fl));
  const th = fh - ih0, tl = fl - il0;
  const ih1 = (ih0 + 1) % md.envW;
  const il1 = Math.min(md.envH - 1, il0 + 1);
  const v00 = md.env[il0 * md.envW + ih0];
  const v01 = md.env[il0 * md.envW + ih1];
  const v10 = md.env[il1 * md.envW + ih0];
  const v11 = md.env[il1 * md.envW + ih1];
  const a0 = v00 + (v01 - v00) * th;
  const a1 = v10 + (v11 - v10) * th;
  return a0 + (a1 - a0) * tl;
}

function matchXf(md: MatchBakeData, rgb: RGB): RGB {
  if (!md.hasMatch) return [c01(rgb[0]), c01(rgb[1]), c01(rgb[2])];
  const r = c01(rgb[0]), g = c01(rgb[1]), b = c01(rgb[2]);
  const [L0, a0, b0] = rgbToLab(r, g, b);
  const L1 = curveAt(md, L0);
  const da = (a0 + md.rawDA - 14.0) / 9.0;
  const db = (b0 + md.rawDB - 18.0) / 10.0;
  const m = Math.exp(-0.5 * (da * da + db * db)) * sstep(28.0, 46.0, L0) * (1.0 - sstep(76.0, 94.0, L0));
  let a1 = a0 + md.dA * (1.0 - md.iso * m);
  let b1 = b0 + md.dB * (1.0 - md.iso * m);
  if (md.skinTweak && m > 1e-4) {
    const c = Math.sqrt(a1 * a1 + b1 * b1);
    if (c > 1e-6) {
      const h = Math.atan2(b1, a1) + md.hueOff * m;
      const c2 = c * (1.0 + (md.satK - 1.0) * m);
      a1 = c2 * Math.cos(h);
      b1 = c2 * Math.sin(h);
    }
  }
  if (md.splitOn) {
    const l01 = L1 / 100.0;
    const wH = sstep(0.2, 0.8, l01);
    const prot = 1.0 - md.iso * m;
    a1 += prot * ((1.0 - wH) * md.stA + wH * md.htA);
    b1 += prot * ((1.0 - wH) * md.stB + wH * md.htB);
  }
  a1 *= md.gs;
  b1 *= md.gs;
  const C = Math.sqrt(a1 * a1 + b1 * b1);
  if (C > 1e-9) {
    const x = C / Math.max(1e-6, envLookup(md, L1, Math.atan2(b1, a1)));
    if (x > 0.65) {
      const gk = 1.0 - 0.35 * Math.exp(-(x - 1.0 + 0.35) / 0.35);
      const w = md.ms * sstep(0.65, 1.3, x) * (1.0 - md.iso * m);
      const mult = (x + w * (gk - x)) / x;
      a1 *= mult;
      b1 *= mult;
    }
  }
  return labToRgb(L1, a1, b1);
}

function refS(x: number): number {
  const lin = 0.42 + (x - 0.42) * 0.76;
  const toe = 0.030 + (lin - 0.030) * Math.pow(c01v(x / 0.42, 0, 1), 0.75);
  let y = mix(toe, lin, sstepGl(0.02, 0.24, x));
  if (x > 0.55) {
    const u = (x - 0.55) / 0.45;
    y = 0.5188 + u * (0.342 + u * (0.7596 - u * 0.6204));
  }
  return y;
}
const shapeNeg = (x: number, s: number): number => (s <= 0.001 ? x : mix(x, refS(x), s));
const shapePos = (x: number, s: number): number => (s <= 0.001 ? x : mix(x, x * x * (3 - 2 * x), s));

function splitDir(h: number): [number, number, number] {
  const hh = c01v(h, 0, 1);
  const h6 = (hh - Math.floor(hh)) * 6.0;
  const i = Math.floor(h6), f = h6 - i, q = 1 - f;
  let raw: [number, number, number];
  if (i < 1) raw = [1, f, 0];
  else if (i < 2) raw = [q, 1, 0];
  else if (i < 3) raw = [0, 1, f];
  else if (i < 4) raw = [0, q, 1];
  else if (i < 5) raw = [f, 0, 1];
  else raw = [1, 0, q];
  const l = LR * raw[0] + LG * raw[1] + LB * raw[2];
  return [raw[0] - l, raw[1] - l, raw[2] - l];
}

function lookXf(L: LookParams, cIn: RGB): RGB {
  let c: RGB = [
    shapePos(cIn[0], L.contrast), shapePos(cIn[1], L.contrast), shapePos(cIn[2], L.contrast),
  ];
  c = [shapeNeg(c[0], L.film_s), shapeNeg(c[1], L.film_s), shapeNeg(c[2], L.film_s)];
  const k = L.dye_coupling;
  c = [
    c[0] * (1.0 - k) + c[1] * (k * 0.55) + c[2] * (k * 0.30),
    c[0] * (k * 0.35) + c[1] * (1.0 - k * 0.8) + c[2] * (k * 0.45),
    c[0] * (k * 0.25) + c[1] * (k * 0.35) + c[2] * (1.0 - k * 1.6),
  ];
  const l = LR * c[0] + LG * c[1] + LB * c[2];
  const sh = Math.pow(c01(1.0 - l), 2.2);
  const hi = Math.pow(c01(l), 2.2);
  const r2 = c[0] + L.shadow_bias * (-0.10 * sh) + L.highlight_bias * (0.10 * hi);
  const g2 = c[1] + L.shadow_bias * (0.02 * sh) + L.highlight_bias * (0.08 * hi);
  const b2 = c[2] + L.shadow_bias * (0.16 * sh) + L.highlight_bias * (-0.18 * hi);
  const spB = c01v(L.split_balance, -1, 1);
  const spWS = sh * (1.0 - 0.5 * spB);
  const spWH = hi * (1.0 + 0.5 * spB);
  const ds = splitDir(L.split_shadow_hue);
  const dh = splitDir(L.split_highlight_hue);
  let r3 = r2 + (ds[0] * (L.split_shadow_sat * spWS) + dh[0] * (L.split_highlight_sat * spWH)) * 0.2;
  let g3 = g2 + (ds[1] * (L.split_shadow_sat * spWS) + dh[1] * (L.split_highlight_sat * spWH)) * 0.2;
  let b3 = b2 + (ds[2] * (L.split_shadow_sat * spWS) + dh[2] * (L.split_highlight_sat * spWH)) * 0.2;
  const blk = L.black_lift + L.fade * 0.10;
  const wht = L.fade * 0.08;
  r3 = c01(r3); g3 = c01(g3); b3 = c01(b3);
  r3 = blk + r3 * (1.0 - blk - wht);
  g3 = blk + g3 * (1.0 - blk - wht);
  b3 = blk + b3 * (1.0 - blk - wht);
  const l2 = LR * r3 + LG * g3 + LB * b3;
  r3 = mix(l2, r3, L.saturation) * (1.0 + L.warmth * 0.05);
  g3 = mix(l2, g3, L.saturation) * (1.0 + L.warmth * 0.01);
  b3 = mix(l2, b3, L.saturation) * (1.0 - L.warmth * 0.05);
  return [c01(r3), c01(g3), c01(b3)];
}

/** BAKE_FS main() 的镜像：atlas 网格点 → legal 包裹 → 匹配 →（recipe）look → 回编 */
function bakeFsMirror(md: MatchBakeData | null, look: LookParams | null, kind: 'match' | 'recipe', legal: boolean, rgb: RGB): RGB {
  const lo = legal ? LEGAL_LOW : 0;
  const hi = legal ? LEGAL_HIGH : 1;
  const span = hi - lo;
  const x: RGB = [c01((rgb[0] - lo) / span), c01((rgb[1] - lo) / span), c01((rgb[2] - lo) / span)];
  const eff = md ?? MD_NONE;   // null → hasMatch=false 恒等（GLSL u_hasMatch=0 分支）
  let c = matchXf(eff, x);
  if (kind === 'recipe' && look) c = lookXf(look, c);
  const out: RGB = [c01(c[0]) * span + lo, c01(c[1]) * span + lo, c01(c[2]) * span + lo];
  return [c01(out[0]), c01(out[1]), c01(out[2])];
}

/** hasMatch=false 的退化常数（GLSL u_hasMatch=0：clamp01 恒等；常数表值不参与计算） */
const MD_NONE: MatchBakeData = {
  hasMatch: false,
  curve: new Float32Array(129), env: new Float32Array([1]),
  envW: 1, envH: 1, envLStep: 100, envHStep: 360,
  rawDA: 0, rawDB: 0, dA: 0, dB: 0, stA: 0, stB: 0, htA: 0, htB: 0,
  iso: 0, hueOff: 0, satK: 1, gs: 1, ms: 0, skinTweak: false, splitOn: false,
};

/** 与 bakeLUT 同布局：table[((b*n+g)*n+r)*3+c] = mirror([r/m, g/m, b/m])[c] */
function mirrorTable(md: MatchBakeData | null, look: LookParams | null, kind: 'match' | 'recipe', legal: boolean, n: number): Float32Array {
  const out = new Float32Array(n * n * n * 3);
  const m = n - 1;
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    const o = bakeFsMirror(md, look, kind, legal, [r / m, g / m, b / m]);
    const i = ((b * n + g) * n + r) * 3;
    out[i] = o[0]; out[i + 1] = o[1]; out[i + 2] = o[2];
  }
  return out;
}

function maxDiff(a: Float32Array, b: Float32Array): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
  }
  return max;
}

/* ---------------- 1) 纯数学一致性（GLSL 镜像 vs CPU/worker 路径） ---------------- */

describe('R17 gpubake：BAKE_FS JS 镜像 vs CPU 烘焙（R10 口径 <1e-3、≥500 点）', () => {
  const md = mdFixture();
  const n = 33;
  const points = n * n * n; // 35937 ≥ 500

  it('kind=match（仅匹配，预览目标）：全表 max 差 <1e-3', () => {
    const st = stateFixture(true);
    const cpu = bakeMatchLUT(st, n as 33 | 65);
    const mirror = mirrorTable(md, null, 'match', false, n);
    expect(cpu.table.length).toBe(points * 3);
    const d = maxDiff(mirror, cpu.table);
    console.info(`[R17 一致性] match 33³ 全表 ${points} 点 max 差 = ${d.toExponential(2)}`);
    expect(d).toBeLessThan(1e-3);
  });

  it('kind=recipe（匹配∘look，导出目标）：全表 max 差 <1e-3', () => {
    const st = stateFixture(true);
    const cpu = bakeRecipeLUT(st, n as 33 | 65, 'full');
    const mirror = mirrorTable(md, ACTIVE_LOOK, 'recipe', false, n);
    const d = maxDiff(mirror, cpu.table);
    console.info(`[R17 一致性] recipe 33³ 全表 ${points} 点 max 差 = ${d.toExponential(2)}`);
    expect(d).toBeLessThan(1e-3);
  });

  it('kind=recipe + legal（数据范围包裹）：全表 max 差 <1e-3', () => {
    const st = stateFixture(true);
    const cpu = bakeRecipeLUT(st, n as 33 | 65, 'legal');
    const mirror = mirrorTable(md, ACTIVE_LOOK, 'recipe', true, n);
    const d = maxDiff(mirror, cpu.table);
    console.info(`[R17 一致性] recipe+legal 33³ 全表 ${points} 点 max 差 = ${d.toExponential(2)}`);
    expect(d).toBeLessThan(1e-3);
  });

  it('无统计恒等（hasMatch=false）：镜像与 bakeMatchLUT 恒等表 max 差 = 0', () => {
    const st = stateFixture(false, { ...ACTIVE_LOOK, saturation: 1, fade: 0, black_lift: 0, dye_coupling: 0, shadow_bias: 0, highlight_bias: 0, film_s: 0, contrast: 0, warmth: 0, split_shadow_sat: 0, split_highlight_sat: 0 });
    const cpu = bakeMatchLUT(st, n as 33 | 65);
    const mirror = mirrorTable(null, null, 'match', false, n);
    // bakeMatchLUT 无统计时 = clamp01 恒等表；镜像（hasMatch=false → clamp01）应与之全等
    const d = maxDiff(mirror, cpu.table);
    expect(d).toBeLessThan(1e-12);
  });

  it('legal 包裹端点：black→LEGAL_LOW、white→LEGAL_HIGH（D/E 方向正确）', () => {
    const st = stateFixture(false, { ...ACTIVE_LOOK, saturation: 1, fade: 0, black_lift: 0, dye_coupling: 0, shadow_bias: 0, highlight_bias: 0, film_s: 0, contrast: 0, warmth: 0, split_shadow_sat: 0, split_highlight_sat: 0 });
    const cpu = bakeRecipeLUT(st, 33 as 33 | 65, 'legal');
    const m = 32;
    // 网格点 (0,0,0) → 输入 legal(0)=黑位以下 → D→0 → f 恒等 → E→LEGAL_LOW
    expect(cpu.table[0]).toBeCloseTo(LEGAL_LOW, 5);
    // 网格点 (1,1,1)（index 末尾）→ E→LEGAL_HIGH
    const last = cpu.table[cpu.table.length - 1];
    expect(last).toBeCloseTo(LEGAL_HIGH, 5);
    expect(m).toBe(32); // （占位断言防误改网格）
  });
});

/* ---------------- 2) GLSL 结构断言（R8 口径：仅结构，node 不执行 GLSL） ---------------- */

describe('R17 gpubake：GLSL 结构断言', () => {
  it('ES 3.00 头与 out 声明（float FBO 路径专用，不与 GRADE_FS 混用）', () => {
    expect(VERT300.startsWith('#version 300 es')).toBe(true);
    expect(BAKE_FS.startsWith('#version 300 es')).toBe(true);
    expect(BAKE_FS).toContain('out vec4 fragColor;');
    expect(BAKE_FS).toContain('precision highp float;');
    expect(BAKE_FS).toContain('texelFetch');
  });

  it('atlas 解码顺序：红维=列内最快（x % n）、蓝维=列号（x / n）、绿维=行（y）', () => {
    const iMod = BAKE_FS.indexOf('int r = px.x % n;');
    const iDiv = BAKE_FS.indexOf('int bIdx = px.x / n;');
    const iRow = BAKE_FS.indexOf('int gIdx = px.y;');
    expect(iMod).toBeGreaterThan(0);
    expect(iDiv).toBeGreaterThan(iMod);
    expect(iRow).toBeGreaterThan(iDiv);
    expect(BAKE_FS.indexOf('float(r) / u_m')).toBeGreaterThan(iRow);
  });

  it('公式顺序：legal 解码 → 匹配 →（recipe）look → 回编（与 rangeWrap/compositeTransform 同序）', () => {
    const iDecode = BAKE_FS.indexOf('(inp - u_legalLo) / (u_legalHi - u_legalLo)');
    const iMatch = BAKE_FS.indexOf('vec3 c = matchXf(x);');
    const iLook = BAKE_FS.indexOf('if (u_kind > 0.5) c = lookXf(c);');
    const iEncode = BAKE_FS.indexOf('* span + u_legalLo;');
    expect(iDecode).toBeGreaterThan(0);
    expect(iMatch).toBeGreaterThan(iDecode);
    expect(iLook).toBeGreaterThan(iMatch);
    expect(iEncode).toBeGreaterThan(iLook);
    expect(BAKE_FS.indexOf('vec3 matchXf')).toBeLessThan(BAKE_FS.indexOf('vec3 lookXf'));
  });

  it('匹配段关键常数与 engine/match.ts 单一真源一致（皮肤域/亮度窗/膝点/分离色调窗）', () => {
    expect(BAKE_FS).toContain('(a0 + u_rawDA - 14.0) / 9.0');      // SKIN_A/SA
    expect(BAKE_FS).toContain('(b0 + u_rawDB - 18.0) / 10.0');     // SKIN_B/SB
    expect(BAKE_FS).toContain('sstep(28.0, 46.0, L0)');            // SKIN_L_LO1/2
    expect(BAKE_FS).toContain('(1.0 - sstep(76.0, 94.0, L0))');    // SKIN_L_HI1/2
    expect(BAKE_FS).toContain('sstep(0.2, 0.8, l01)');             // SPLIT_LOW/HIGH
    expect(BAKE_FS).toContain('if (x > 0.65)');                    // KNEE_LO = 1-KNEE_K
    expect(BAKE_FS).toContain('1.0 - 0.35 * exp(-(x - 1.0 + 0.35) / 0.35)'); // KNEE_K
    expect(BAKE_FS).toContain('sstep(0.65, 1.3, x)');              // KNEE_LO/HI
    expect(BAKE_FS).toContain('m > 1e-4');                          // 肤色微调阈值
    expect(BAKE_FS).toContain('C > 1e-9');                          // 包络入口阈值
  });

  it('明度曲线锚点 128（129 texel）+ sRGB/Lab 矩阵常数与 color.ts 一致', () => {
    expect(BAKE_FS).toContain('128.0 / 100.0');
    expect(BAKE_FS).toContain('x >= 128.0 ? 127');
    expect(BAKE_FS).toContain('216.0 / 24389.0');
    expect(BAKE_FS).toContain('24389.0 / 27.0');
    expect(BAKE_FS).toContain('0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb');
    expect(BAKE_FS).toContain('3.2404542 * x - 1.5371385 * y - 0.4985314 * z');
    expect(BAKE_FS).toContain('for (int i = 0; i < 10; i++)');  // 色域二分收缩轮数
  });

  it('look 段与 GRADE_FS 同式（曲线家族 B→A / 染料耦合 / 分离色调 0.2 / 褪色 / 冷暖）', () => {
    expect(BAKE_FS.indexOf('shapePos(cIn.r, u_contrast)')).toBeGreaterThan(0);
    expect(BAKE_FS.indexOf('shapeNeg(c.r, u_filmS)')).toBeGreaterThan(BAKE_FS.indexOf('shapePos(cIn.r, u_contrast)'));
    expect(BAKE_FS).toContain('c.r * (k * 0.35)     + c.g * (1.0 - k * 0.8) + c.b * (k * 0.45)');
    expect(BAKE_FS).toContain(') * 0.2;');                       // SPLIT_SCALE
    expect(BAKE_FS).toContain('blk = u_black + u_fade * 0.10;');
    expect(BAKE_FS).toContain('wht = u_fade * 0.08;');
    expect(BAKE_FS).toContain('1.0 + u_warm * 0.05, 1.0 + u_warm * 0.01, 1.0 - u_warm * 0.05');
    expect(BAKE_FS).toContain('spWS = sh * (1.0 - 0.5 * spB)');
  });

  it('能力探测：WebGL2 + EXT_color_buffer_float + RGBA32F 优先/16F 兜底 + readPixels(RGBA,FLOAT)', () => {
    expect(MODULE_SRC).toContain("canvas.getContext('webgl2')");
    expect(MODULE_SRC).toContain("gl.getExtension('EXT_color_buffer_float')");
    expect(MODULE_SRC.indexOf('RGBA32F')).toBeGreaterThan(0);
    expect(MODULE_SRC.indexOf('RGBA32F')).toBeLessThan(MODULE_SRC.indexOf('RGBA16F'));
    expect(MODULE_SRC).toContain('gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, atlas)');
    expect(MODULE_SRC).toContain('FRAMEBUFFER_COMPLETE');
  });
});

/* ---------------- 3) atlas → 引擎表布局 ---------------- */

describe('R17 gpubake：atlasToEngine 布局（与 uploadLut 采样约定一一对应）', () => {
  it('atlas 像素 (g*n²+b*n+r) ↔ 引擎 index ((b*n+g)*n+r)，且通道 clamp 到 [0,1]', () => {
    const n = 5;
    const atlas = new Float32Array(n * n * n * 4);
    // atlas 像素 (x=g*rowPx+b*n+r, y=g) 编码值 (r,g,b) 的序号
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
      const p = (g * n * n + b * n + r) * 4;
      atlas[p] = r / (n - 1);
      atlas[p + 1] = g / (n - 1);
      atlas[p + 2] = b / (n - 1);
      atlas[p + 3] = 1;
    }
    // 注入越界值验证 clamp（落在引擎 (0,0,0) 的 r/g 通道）
    atlas[0] = -0.5;
    atlas[1] = 1.5;
    const table = atlasToEngine(n, atlas);
    expect(table.length).toBe(n * n * n * 3);
    expect(table[0]).toBe(0);        // clamp(-0.5)
    expect(table[1]).toBe(1);        // clamp(1.5)
    expect(table[2]).toBeCloseTo(0, 6);
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
      if (b === 0 && g === 0 && r === 0) continue;   // 该体素已被注入值占用
      const i = ((b * n + g) * n + r) * 3;
      expect(table[i]).toBeCloseTo(r / (n - 1), 6);
      expect(table[i + 1]).toBeCloseTo(g / (n - 1), 6);
      expect(table[i + 2]).toBeCloseTo(b / (n - 1), 6);
    }
  });

  it('atlasToEngine 与 bakeLUT 的网格语义一致（同一输入网格）', () => {
    const n = 4;
    const identity = bakeLUT((rgb: RGB): RGB => [rgb[0], rgb[1], rgb[2]], n);
    const atlas = new Float32Array(n * n * n * 4);
    const m = n - 1;
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
      const p = (g * n * n + b * n + r) * 4;
      atlas[p] = r / m; atlas[p + 1] = g / m; atlas[p + 2] = b / m; atlas[p + 3] = 1;
    }
    const table = atlasToEngine(n, atlas);
    expect(maxDiff(table, identity.table)).toBeLessThan(1e-12);
  });
});
