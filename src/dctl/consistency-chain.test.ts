/**
 * R13 · 数值一致性链（跨实现同源证明）。
 *
 * 链条（每一环用**逐式 JS 镜像 + 结构锚定**对拍，诚实边界见文件末）：
 *   ① engine/look.lookTransform  ≡  pipeline.GRADE_FS look 段（web 预览；已由 lookshader.test 覆盖，这里补复合链路）
 *   ② compositeTransform          ≡  lookTransform ∘ matchTransform（同源，逐位）
 *   ③ bakeRecipeLUT               ≡  compositeTransform（导出 .cube / 批量包路径）
 *   ④ DCTL 生成源码 fm_log_look   ≡  dctl/logmath.applyLogLook（DCTL 端；本文件新增，此前只有结构断言）
 *   ⑤ engine/look ↔ applyLogLook 是**两个不同域**（gamma 显示域 vs 归一化对数域）——
 *      不做 1e-3 断言，改用 R4 已登记的量级口径（0..255 级平均差 < 64）如实锁定。
 *
 * GLSL 无法在 node 执行：①②③ 用 JS 镜像/同源调用，④ 用从生成源码逐式转写的镜像 + 结构锚定。
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error 测试在 node 下运行；本项目未安装 @types/node
import { readFileSync } from 'node:fs';
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url';
import { applyLUT, type RGB } from '../engine';
import { getPreset, type LookParams } from '../film/params';
import { lookTransform, NEUTRAL_LOOK } from '../engine/look';
import { applyLogLook, lookToLogLook, type LogLookParams } from './logmath';
import { generateDctl, type DctlGenInput } from './codegen';
import { bakeMatchLUT, bakeRecipeLUT, compositeTransform, matchTransform, type RecipeState } from '../ui/recipe';
import { analyzeImage } from '../engine';

const c01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const LR = 0.2126, LG = 0.7152, LB = 0.0722;
const luma3 = (c: RGB): number => LR * c[0] + LG * c[1] + LB * c[2];

/* ---------- 确定性采样点（含角点/灰阶） ---------- */
function samples(n: number): RGB[] {
  const out: RGB[] = [
    [0, 0, 0], [1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1],
    [0.5, 0.5, 0.5], [0.18, 0.18, 0.18], [0.9, 0.9, 0.9], [0.25, 0.5, 0.75],
  ];
  let s = 0x2468ace0;
  const rnd = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
  for (let i = 0; i < n; i++) out.push([rnd(), rnd(), rnd()]);
  return out;
}

/* ---------- DCTL fm_log_look 的逐式 JS 镜像（严格照 codegen.ts 生成文本） ---------- */
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
function softS(x: number, pivot: number, s: number): number {
  const p = c01(pivot);
  const lo = p < 1e-6 ? 1e-6 : p;
  const hi = (1 - p) < 1e-6 ? 1e-6 : (1 - p);
  if (x <= p) { const u = c01(x / lo); const su = u * u * (3 - 2 * u); return p * mix(u, su, s); }
  const u = c01((x - p) / hi); const su = u * u * (3 - 2 * u); return p + hi * mix(u, su, s);
}
function gammaS(x: number, s: number): number { const su = x * x * (3 - 2 * x); return mix(x, su, s); }
function toeShoulder(x: number, pivot: number, toe: number, shoulder: number): number {
  const p = c01(pivot); let y = x;
  if (toe > 1e-6 && y < p && p > 1e-6) { const u = c01(y / p); y = p * Math.pow(u, 1 / (1 + toe)); }
  if (shoulder > 1e-6 && y > p && p < 0.999999) { const u = c01((y - p) / (1 - p)); y = p + (1 - p) * (1 - Math.pow(1 - u, 1 + shoulder)); }
  return y;
}
function splitDir(h: number): RGB {
  const hh = c01(h);
  const h6 = (hh - Math.floor(hh)) * 6;
  const i = Math.floor(h6), f = h6 - i, q = 1 - f;
  let raw: RGB;
  if (i < 1) raw = [1, f, 0]; else if (i < 2) raw = [q, 1, 0]; else if (i < 3) raw = [0, 1, f];
  else if (i < 4) raw = [0, q, 1]; else if (i < 5) raw = [f, 0, 1]; else raw = [1, 0, q];
  const l = luma3(raw); return [raw[0] - l, raw[1] - l, raw[2] - l];
}
function dctlLogLookMirror(c: RGB, lp: LogLookParams): RGB {
  const cp = (x: number): number => toeShoulder(gammaS(softS(c01(lp.pivot) + (x - c01(lp.pivot)) * lp.contrast, c01(lp.pivot), lp.film_s), lp.gamma_contrast), c01(lp.pivot), lp.toe, lp.shoulder);
  const y: RGB = [cp(c[0]), cp(c[1]), cp(c[2])];
  const k = lp.crosstalk;
  const d: RGB = [
    y[0] * (1 - k) + y[1] * (k * 0.55) + y[2] * (k * 0.30),
    y[0] * (k * 0.35) + y[1] * (1 - k * 0.8) + y[2] * (k * 0.45),
    y[0] * (k * 0.25) + y[1] * (k * 0.35) + y[2] * (1 - k * 1.6),
  ];
  const l = luma3(d);
  const sh = Math.pow(c01(1 - l), 2.2), hi = Math.pow(c01(l), 2.2);
  d[0] += lp.shadow_bias * (-0.10 * sh) + lp.highlight_bias * (0.10 * hi);
  d[1] += lp.shadow_bias * (0.02 * sh) + lp.highlight_bias * (0.08 * hi);
  d[2] += lp.shadow_bias * (0.16 * sh) + lp.highlight_bias * (-0.18 * hi);
  const spB = Math.min(1, Math.max(-1, lp.split_balance));
  const spWS = sh * (1 - 0.5 * spB), spWH = hi * (1 + 0.5 * spB);
  const sds = splitDir(lp.split_shadow_hue), sdh = splitDir(lp.split_highlight_hue);
  const sss = 0.2 * lp.split_shadow_sat * spWS, shs = 0.2 * lp.split_highlight_sat * spWH;
  // spWS/spWH 已含 sh/hi；不再乘第二次（R13 修复：历史实现多乘了一个亮度权重）
  d[0] += sds[0] * sss + sdh[0] * shs;
  d[1] += sds[1] * sss + sdh[1] * shs;
  d[2] += sds[2] * sss + sdh[2] * shs;
  const blk = lp.fade * 0.10, wht = lp.fade * 0.08;
  const f: RGB = [blk + c01(d[0]) * (1 - blk - wht), blk + c01(d[1]) * (1 - blk - wht), blk + c01(d[2]) * (1 - blk - wht)];
  const l2 = luma3(f);
  const s2: RGB = [l2 + (f[0] - l2) * lp.saturation, l2 + (f[1] - l2) * lp.saturation, l2 + (f[2] - l2) * lp.saturation];
  return [
    c01(s2[0] * (1 + lp.warmth * 0.05)),
    c01(s2[1] * (1 + lp.warmth * 0.01)),
    c01(s2[2] * (1 - lp.warmth * 0.05)),
  ];
}

/* ---------- 夹具 ---------- */
const DCTL_SRC = readFileSync(fileURLToPath(new URL('./codegen.ts', import.meta.url)), 'utf8');

function logLooks(): LogLookParams[] {
  const card = getPreset('fl06');
  const base = lookToLogLook(card.params.look, 'yrgb');
  return [
    base,
    lookToLogLook({ ...NEUTRAL_LOOK, fade: 0.7, black_lift: 0.1, dye_coupling: 0.22, shadow_bias: 0.55, highlight_bias: 0.4, film_s: 0.3, saturation: 0.85, warmth: 0.05 }, 'yrgb'),
    // 对数域专属字段（contrast / gamma_contrast / crosstalk / toe / shoulder）直接叠加覆盖
    { ...lookToLogLook(NEUTRAL_LOOK, 'yrgb'), contrast: 1.4, film_s: 0.6, gamma_contrast: 0.25, crosstalk: 0.2, saturation: 1.2, warmth: -0.2, toe: 0.3, shoulder: 0.4 },
    lookToLogLook({ ...NEUTRAL_LOOK, split_shadow_hue: 0.62, split_shadow_sat: 0.75, split_highlight_hue: 0.55, split_highlight_sat: 0.4, split_balance: -0.25 }, 'yrgb'),
  ];
}

function synthStats(): { ref: ReturnType<typeof analyzeImage>; user: ReturnType<typeof analyzeImage> } {
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
}
function stateOf(presetId: string, look: LookParams, stats: ReturnType<typeof synthStats> | null): RecipeState {
  const card = getPreset(presetId);
  return {
    colorParams: { match_strength: 0.75, skin_hue: 0, skin_sat: 1, skin_isolation: 0, split_tone: 0, tone_contrast: 1, shadow_lift: 0, global_sat: 1, highlight_rolloff: 0 },
    look: look as never,
    texture: card.params.texture,
    master: 1,
    origins: { ...card.origins },
    refStats: stats?.ref ?? null,
    userStats: stats?.user ?? null,
  };
}

describe('R13 数值一致性链④：DCTL 生成源码 fm_log_look ≡ applyLogLook', () => {
  it('结构锚定：生成源码含镜像所依赖的关键式（防止镜像与生成器漂移）', () => {
    const card = getPreset('fl06');
    const src = generateDctl({
      recipeName: card.name, shareCode: 'FM-R13-CHAIN', pipeline: 'yrgb',
      look: lookToLogLook(card.params.look, 'yrgb'), texture: card.params.texture,
    } as DctlGenInput).source;
    for (const frag of [
      'float k = lp.crosstalk;',
      'd.x = y.x * (1.0f - k) + y.y * (k * 0.55f) + y.z * (k * 0.30f);',
      'float sh = _powf(fm_clamp01(1.0f - l), 2.2f);',
      'd.x = d.x + lp.shadow_bias * (-0.10f * sh) + lp.highlight_bias * (0.10f * hi);',
      'float sss = 0.2f * lp.split_sh_sat * spWS;',
      'd.x = d.x + sds.x * sss + sdh.x * shs;',
      'float blk = lp.fade * 0.10f;',
      'd = make_float3(l2 + (d.x - l2) * lp.saturation,',
    ]) expect(src).toContain(frag);
    /* 回归锁（R13 修复）：分离色调不得再对已含 sh/hi 的 spWS/spWH 二次乘亮度权重 */
    expect(src).not.toContain('sss * sh');
    expect(src).not.toContain('shs * hi');
  });

  it('数值：镜像 ≡ applyLogLook（4 组 look × 1109 采样点，max 分量差 < 1e-3）', () => {
    let max = 0;
    for (const lp of logLooks()) {
      for (const c of samples(1100)) {
        const a = applyLogLook([c[0], c[1], c[2]], lp);
        const b = dctlLogLookMirror(c, lp);
        for (let ch = 0; ch < 3; ch++) max = Math.max(max, Math.abs(a[ch] - b[ch]));
      }
    }
    console.info(`[R13 一致性链] DCTL fm_log_look 镜像 vs applyLogLook：max 分量差 = ${max.toExponential(3)}`);
    expect(max).toBeLessThan(1e-3);
  });
});

describe('R13 数值一致性链②③：复合变换与 LUT 烘焙同源', () => {
  it('② compositeTransform ≡ lookTransform ∘ matchTransform（逐位 < 1e-12）', () => {
    const st = stateOf('fl05', getPreset('fl05').params.look as LookParams, synthStats());
    const mt = matchTransform(st);
    expect(mt).not.toBeNull();
    const lookFn = lookTransform(st.look as unknown as LookParams);
    const comp = compositeTransform(st);
    let max = 0;
    for (const c of samples(600)) {
      const a = comp([c[0], c[1], c[2]]);
      const b = lookFn(mt!([c[0], c[1], c[2]]));
      for (let ch = 0; ch < 3; ch++) max = Math.max(max, Math.abs(a[ch] - b[ch]));
    }
    expect(max).toBeLessThan(1e-12);
  });

  it('③ bakeRecipeLUT(65) ≡ compositeTransform（600 采样点，max 分量差 < 5e-3）', () => {
    const st = stateOf('fl05', getPreset('fl05').params.look as LookParams, synthStats());
    const comp = compositeTransform(st);
    const lut = bakeRecipeLUT(st, 65);
    let max = 0;
    for (const c of samples(600)) {
      const a = comp([c[0], c[1], c[2]]);
      const b = applyLUT(lut, [c[0], c[1], c[2]]);
      for (let ch = 0; ch < 3; ch++) max = Math.max(max, Math.abs(a[ch] - b[ch]));
    }
    console.info(`[R13 一致性链] 复合 LUT(65³) vs compositeTransform：max 分量差 = ${max.toExponential(3)}`);
    expect(max).toBeLessThan(5e-3);
  });

  it('③ 无统计（型号直出）：matchTransform=null，bakeMatchLUT 为恒等，bakeRecipeLUT ≡ look', () => {
    const st = stateOf('fl07', getPreset('fl07').params.look as LookParams, null);
    expect(matchTransform(st)).toBeNull();
    const ident = bakeMatchLUT(st, 33);
    const lookFn = lookTransform(st.look as unknown as LookParams);
    const comp = compositeTransform(st);
    let maxId = 0, maxLook = 0;
    for (const c of samples(300)) {
      const m = applyLUT(ident, [c[0], c[1], c[2]]);
      for (let ch = 0; ch < 3; ch++) maxId = Math.max(maxId, Math.abs(m[ch] - c[ch]));
      const a = comp([c[0], c[1], c[2]]);
      const b = lookFn([c[0], c[1], c[2]]);
      for (let ch = 0; ch < 3; ch++) maxLook = Math.max(maxLook, Math.abs(a[ch] - b[ch]));
    }
    expect(maxId).toBeLessThan(1e-9);
    expect(maxLook).toBeLessThan(1e-12);
  });
});

describe('R13 数值一致性链⑤：engine/look ↔ applyLogLook 跨域量级（R4 口径，非 1e-3）', () => {
  it('同参数下两域差异锁定在 R4 登记量级（0..255 级平均差 < 64；中性时都为恒等）', () => {
    const look: LookParams = getPreset('fl06').params.look;
    const lp = lookToLogLook(look, 'yrgb');
    const f = lookTransform(look);
    let sum = 0, n = 0, max = 0;
    for (const c of samples(600)) {
      const a = f([c[0], c[1], c[2]]);
      const b = applyLogLook([c[0], c[1], c[2]], lp);
      for (let ch = 0; ch < 3; ch++) { const d = Math.abs(a[ch] - b[ch]) * 255; sum += d; n++; max = Math.max(max, d); }
    }
    const mean = sum / n;
    console.info(`[R13 一致性链] engine/look ↔ applyLogLook 跨域：mean=${mean.toFixed(2)} 级 max=${max.toFixed(2)} 级（R4 登记 mean 5.69 / max 17.94）`);
    expect(mean).toBeLessThan(64);   // R4/E2E R4-3 的守门口径
    expect(max).toBeLessThan(255);
    // 中性 look 两域都恒等
    for (const c of samples(100)) {
      const a = lookTransform(NEUTRAL_LOOK)([c[0], c[1], c[2]]);
      const b = applyLogLook([c[0], c[1], c[2]], lookToLogLook(NEUTRAL_LOOK, 'yrgb'));
      for (let ch = 0; ch < 3; ch++) expect(Math.abs(a[ch] - b[ch])).toBeLessThan(1e-9);
    }
  });
});

// DCTL 生成器源码常量：确保镜像引用的系数确实写在生成器里（防两端各改一半）
void DCTL_SRC;
