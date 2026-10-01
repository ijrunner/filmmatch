/**
 * R18 · 六项独立染料串扰（C4）验收测试。
 *
 * 语义（单一真源 engine/look.ts）：有效矩阵 M = I + k·(C − I)，k = dye_coupling，
 * C 的非对角 = coupling 六系数（缺省 = DEFAULT_COUPLING = 历史固定矩阵）、对角 = 冻结自抑制
 * （0 / 0.2 / −0.6）。护栏：
 *   ① 旧配方（无 coupling 字段或全默认）→ 输出与 R18 之前的固定矩阵实现**逐位**一致；
 *   ② k = 0 时任意 coupling 均恒等（默认值恒等，护栏 2）；
 *   ③ 旧配方 JSON round-trip 不添新键、输出逐位不变；
 *   ④ 四处同源的结构锚定（GLSL uniform / DCTL 常量 / paramui 滑杆行）。
 */
import { describe, expect, it } from 'vitest';
import { lookTransform, DEFAULT_COUPLING, normalizeCoupling, type LookParams } from '../engine/look';
import { gammaLook, lookToLogLook, applyLogLook } from '../dctl/logmath';
import { defaultParams, normalizeParams, lookToSchema, getPreset } from './params';
import { generateDctl } from '../dctl/codegen';

/** R18 之前的固定矩阵实现（从 R17 的 engine/look.dyeCross 原样复制，作逐位对照基准） */
function legacyLookTransform(look: LookParams): (rgb: [number, number, number]) => [number, number, number] {
  const fade = Math.min(1, Math.max(0, look?.fade ?? 0));
  const black = Math.min(1, Math.max(0, look?.black_lift ?? 0));
  const coupling = Math.min(0.5, Math.max(0, look?.dye_coupling ?? 0));
  const shBias = Math.min(1, Math.max(-1, look?.shadow_bias ?? 0));
  const hiBias = Math.min(1, Math.max(-1, look?.highlight_bias ?? 0));
  const filmS = Math.min(1, Math.max(0, look?.film_s ?? 0));
  const contrast = Math.min(1, Math.max(0, look?.contrast ?? 0));
  const sat = Math.min(2, Math.max(0, look?.saturation ?? 1));
  const warm = Math.min(1, Math.max(-1, look?.warmth ?? 0));
  const spShHue = Math.min(1, Math.max(0, look?.split_shadow_hue ?? 0));
  const spShSat = Math.min(1, Math.max(0, look?.split_shadow_sat ?? 0));
  const spHiHue = Math.min(1, Math.max(0, look?.split_highlight_hue ?? 0));
  const spHiSat = Math.min(1, Math.max(0, look?.split_highlight_sat ?? 0));
  const spBal = Math.min(1, Math.max(-1, look?.split_balance ?? 0));
  const c01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
  const ss = (a: number, b: number, x: number): number => {
    if (b <= a) return x >= b ? 1 : 0;
    const t = c01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  };
  const LR = 0.2126, LG = 0.7152, LB = 0.0722;
  const refS = (x: number): number => {
    const lin = 0.42 + (x - 0.42) * 0.76;
    const toe = 0.03 + (lin - 0.03) * Math.pow(c01(x / 0.42), 0.75);
    let y = toe + (lin - toe) * ss(0.02, 0.24, x);
    if (x > 0.55) { const u = (x - 0.55) / 0.45; y = 0.5188 + u * (0.342 + u * (0.7596 - u * 0.6204)); }
    return y;
  };
  const pos = (x: number, s: number): number => (s <= 0.001 ? x : x + (x * x * (3 - 2 * x) - x) * s);
  const neg = (x: number, s: number): number => (s <= 0.001 ? x : x + (refS(x) - x) * s);
  const blk = black + fade * 0.1;
  const wht = fade * 0.08;
  const splitOn = spShSat > 0 || spHiSat > 0;
  const neutral = fade === 0 && black === 0 && coupling === 0 && shBias === 0 && hiBias === 0
    && filmS === 0 && contrast === 0 && sat === 1 && warm === 0 && !splitOn;
  /* R8 分离色调的 R17 实现（splitHueRGB + balance gains + SPLIT_SCALE=0.2） */
  const splitHueRGB = (hue: number): [number, number, number] => {
    const h = ((hue % 1) + 1) % 1;
    const h6 = h * 6;
    const i = Math.floor(h6) % 6;
    const f = h6 - Math.floor(h6);
    const q = 1 - f;
    const raw: [number, number, number] = i === 0 ? [1, f, 0] : i === 1 ? [q, 1, 0] : i === 2 ? [0, 1, f] : i === 3 ? [0, q, 1] : i === 4 ? [f, 0, 1] : [1, 0, q];
    const l = LR * raw[0] + LG * raw[1] + LB * raw[2];
    return [raw[0] - l, raw[1] - l, raw[2] - l];
  };
  const ds = splitHueRGB(spShHue), dh = splitHueRGB(spHiHue);
  const ssS = 0.2 * spShSat * (1 - 0.5 * spBal);
  const hsS = 0.2 * spHiSat * (1 + 0.5 * spBal);
  if (neutral) return (rgb) => [c01(rgb[0]), c01(rgb[1]), c01(rgb[2])];
  return (rgb: [number, number, number]): [number, number, number] => {
    let r = c01(rgb[0]), g = c01(rgb[1]), b = c01(rgb[2]);
    r = neg(pos(r, contrast), filmS);
    g = neg(pos(g, contrast), filmS);
    b = neg(pos(b, contrast), filmS);
    /* —— R17 固定矩阵（历史字面量，逐位基准） —— */
    const r2 = r * (1 - coupling) + g * (coupling * 0.55) + b * (coupling * 0.3);
    const g2 = r * (coupling * 0.35) + g * (1 - coupling * 0.8) + b * (coupling * 0.45);
    const b2 = r * (coupling * 0.25) + g * (coupling * 0.35) + b * (1 - coupling * 1.6);
    r = r2; g = g2; b = b2;
    const l = LR * r + LG * g + LB * b;
    const sh = Math.pow(c01(1 - l), 2.2), hi = Math.pow(c01(l), 2.2);
    r += shBias * -0.1 * sh + hiBias * 0.1 * hi;
    g += shBias * 0.02 * sh + hiBias * 0.08 * hi;
    b += shBias * 0.16 * sh + hiBias * -0.18 * hi;
    if (splitOn) {
      r += ds[0] * ssS * sh + dh[0] * hsS * hi;
      g += ds[1] * ssS * sh + dh[1] * hsS * hi;
      b += ds[2] * ssS * sh + dh[2] * hsS * hi;
    }
    r = c01(r); g = c01(g); b = c01(b);
    r = blk + r * (1 - blk - wht); g = blk + g * (1 - blk - wht); b = blk + b * (1 - blk - wht);
    const l2 = LR * r + LG * g + LB * b;
    r = (l2 + (r - l2) * sat) * (1 + warm * 0.05);
    g = (l2 + (g - l2) * sat) * (1 + warm * 0.01);
    b = (l2 + (b - l2) * sat) * (1 - warm * 0.05);
    return [c01(r), c01(g), c01(b)];
  };
}

/** 确定性采样点（角点 + 灰阶 + LCG 随机） */
function samples(n: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [
    [0, 0, 0], [1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.5, 0.5, 0.5], [0.18, 0.18, 0.18], [0.9, 0.62, 0.3],
  ];
  let s = 0x87654321;
  const rnd = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
  for (let i = 0; i < n; i++) out.push([rnd(), rnd(), rnd()]);
  return out;
}

describe('R18 串扰：逐位兼容（旧配方 = 历史固定矩阵输出）', () => {
  const legacy = legacyLookTransform;

  it('无 coupling 字段 + 任意 dye_coupling：lookTransform 与 R17 固定矩阵逐位一致（16 组 look × 采样点）', () => {
    const looks: LookParams[] = [
      { ...defaultParams().look, dye_coupling: 0.05 },
      { ...defaultParams().look, dye_coupling: 0.22, fade: 0.75, black_lift: 0.1, shadow_bias: 0.55, highlight_bias: 0.45 },
      { ...defaultParams().look, dye_coupling: 0.4, film_s: 0.8, contrast: 0.5, saturation: 1.14, warmth: -0.3 },
      { ...defaultParams().look, dye_coupling: 0.08, split_shadow_hue: 0.62, split_shadow_sat: 0.75, split_highlight_hue: 0.55, split_highlight_sat: 0.4, split_balance: -0.25 },
    ];
    /* 全部内置卡（look 均无 coupling 字段）也逐位 */
    for (const id of ['neutral', 'fl04', 'fl05', 'fl06', 'fl07', 'fl08', 'fl10', 'st01', 'st02', 'st03', 'st05', 'st06']) {
      looks.push(getPreset(id).params.look);
    }
    let checked = 0;
    for (const L of looks) {
      const a = lookTransform(L);
      const b = legacy(L);
      for (const c of samples(400)) {
        const oa = a(c);
        const ob = b(c);
        for (let ch = 0; ch < 3; ch++) expect(oa[ch]).toBe(ob[ch]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('coupling 全默认（= DEFAULT_COUPLING）：与历史固定矩阵逐位一致', () => {
    const L: LookParams = { ...defaultParams().look, dye_coupling: 0.31, fade: 0.4, contrast: 0.3, coupling: { ...DEFAULT_COUPLING } };
    const a = lookTransform(L);
    const b = legacy(L);
    for (const c of samples(400)) {
      const oa = a(c);
      const ob = b(c);
      for (let ch = 0; ch < 3; ch++) expect(oa[ch]).toBe(ob[ch]);
    }
  });

  it('k = dye_coupling = 0：任意 coupling（含极端值）= 无 coupling 的输出（逐位）', () => {
    const L: LookParams = {
      ...defaultParams().look, dye_coupling: 0,
      coupling: { rg: 2, rb: 0, gr: 1.5, gb: 0.3, br: 0, bg: 2 },
      fade: 0.3, contrast: 0.4, saturation: 1.2,
    };
    /* 基准 = 同 look 但不带 coupling 字段（即 R17 行为）；legacy 镜像本就不读 coupling */
    const b = legacy(L);
    const a = lookTransform(L);
    for (const c of samples(300)) {
      const oa = a(c);
      const ob = b(c);
      for (let ch = 0; ch < 3; ch++) expect(oa[ch]).toBe(ob[ch]);
    }
  });

  it('旧配方 normalizeParams（无 coupling/hsl 键）→ 不添新键；JSON round-trip 输出逐位不变', () => {
    /* v1.2 时代的配方 look（只有 LOOK_KEYS 14 键，包装值） */
    const v12look: Record<string, { value: number }> = {};
    for (const [k, v] of Object.entries(defaultParams().look)) v12look[k] = { value: v as number };
    v12look['dye_coupling'] = { value: 0.16 };
    v12look['fade'] = { value: 0.4 };
    const st = normalizeParams({ look: v12look as never });
    expect(st.look.coupling).toBeUndefined();
    expect(st.look.hsl).toBeUndefined();
    /* 序列化 → 读回 → 引擎输出逐位 */
    const schema = lookToSchema(st.look, {});
    const json = JSON.parse(JSON.stringify(schema));
    expect(json.coupling).toBeUndefined();
    expect(json.hsl).toBeUndefined();
    const back = normalizeParams({ look: json as never });
    const a = lookTransform(st.look);
    const b = lookTransform(back.look);
    for (const c of samples(300)) {
      const oa = a(c);
      const ob = b(c);
      for (let ch = 0; ch < 3; ch++) expect(oa[ch]).toBe(ob[ch]);
    }
  });

  it('自定义 coupling：JSON round-trip（写出→读回）后输出逐位一致', () => {
    const L: LookParams = {
      ...defaultParams().look, dye_coupling: 0.2, coupling: { rg: 0.48, rb: 0.72, gr: 0.11, gb: 0.9, br: 0.33, bg: 0.06 },
    };
    const origins = Object.fromEntries(Object.keys(L.coupling!).map((k) => [`look.coupling.${k}`, 'user'])) as Record<string, 'user'>;
    const json = JSON.parse(JSON.stringify(lookToSchema(L, {})));
    expect(json.coupling.rg.value).toBe(0.48);
    const back = normalizeParams({ look: json as never });
    const a = lookTransform(L);
    const b = lookTransform(back.look);
    for (const c of samples(300)) {
      const oa = a(c);
      const ob = b(c);
      for (let ch = 0; ch < 3; ch++) expect(oa[ch]).toBe(ob[ch]);
    }
    void origins;
  });

  it('normalizeCoupling：缺键补默认、越界钳 [0,2]、非有限回退默认', () => {
    expect(normalizeCoupling(undefined)).toEqual(DEFAULT_COUPLING);
    expect(normalizeCoupling({ rg: 5, gr: -1 }).rg).toBe(2);
    expect(normalizeCoupling({ rg: 5, gr: -1 }).gr).toBe(0);
    expect(normalizeCoupling({ gr: NaN }).gr).toBe(DEFAULT_COUPLING.gr);
    expect(normalizeCoupling({ bg: 0.1 })).toEqual({ ...DEFAULT_COUPLING, bg: 0.1 });
  });
});

describe('R18 串扰：对数域与 DCTL 同步', () => {
  it('lookToLogLook 透传六系数；applyLogLook 默认与历史矩阵逐位一致、自定义生效', () => {
    const base = defaultParams().look;
    /* 默认：crosstalk 路径与 gamma 域历史实现同矩阵（经 TF 前后不可比，改为 log 域内对照） */
    const logDefault = lookToLogLook({ ...base, dye_coupling: 0.3 }, 'yrgb');
    const legacyCrosstalk = (x: number, k: number): number => x * (1 - k) + x * 0; /* 占位，真实对照在下方逐通道 */
    void legacyCrosstalk;
    const mid: [number, number, number] = [0.42, 0.18, 0.73];
    const outDefault = applyLogLook(mid, logDefault);
    /* 历史固定矩阵手工展开（k=0.3） */
    const [r, g, b] = mid;
    const exp = [
      r * (1 - 0.3) + g * (0.3 * 0.55) + b * (0.3 * 0.30),
      r * (0.3 * 0.35) + g * (1 - 0.3 * 0.8) + b * (0.3 * 0.45),
      r * (0.3 * 0.25) + g * (0.3 * 0.35) + b * (1 - 0.3 * 1.6),
    ];
    for (let ch = 0; ch < 3; ch++) expect(outDefault[ch]).toBe(exp[ch]);
    /* 自定义：矩阵随六系数变化 */
    const logCustom = lookToLogLook({ ...base, dye_coupling: 0.3, coupling: { rg: 1.2, rb: 0, gr: 0, gb: 0, br: 0, bg: 0 } }, 'yrgb');
    const outCustom = applyLogLook(mid, logCustom);
    /* 手工展开 M = I + 0.3·(C−I)，C 对角冻结（0/0.2/−0.6） */
    const expC = [
      r * (1 - 0.3) + g * (0.3 * 1.2) + b * 0,
      r * 0 + g * (1 - 0.3 * 0.8) + b * 0,
      r * 0 + g * 0 + b * (1 - 0.3 * 1.6),
    ];
    expect(outCustom).toEqual(expC);
    expect(outCustom[0]).not.toBe(outDefault[0]);
  });

  it('DCTL：默认 coupling 按历史字面量输出（产物逐字节不变）；自定义按常量烘焙且不新增 UI 参数', () => {
    const card = getPreset('fl06');
    const gen = (look: LookParams) => generateDctl({
      recipeName: 'R18', shareCode: 'FM-R18', pipeline: 'yrgb',
      look: lookToLogLook(look, 'yrgb'), texture: card.params.texture,
    });
    /* 默认：字面量保持历史形态 → 参数数不变（R21 起 53：+FM_MASTER 质感总强度，无 match） */
    const def = gen(card.params.look);
    expect(def.source).toContain('d.x = y.x * (1.0f - k) + y.y * (k * 0.55f) + y.z * (k * 0.30f);');
    expect(def.params.length).toBe(53);
    /* 自定义：常量烘焙，UI 参数数不变（R21 起 53） */
    const custom = gen({ ...card.params.look, coupling: { rg: 0.21, rb: 0.87, gr: 0.12, gb: 0.65, br: 0.44, bg: 0.03 } });
    expect(custom.source).toContain('k * 0.2100f');
    expect(custom.source).toContain('k * 0.8700f');
    expect(custom.source).not.toContain('k * 0.55f');
    expect(custom.params.length).toBe(53);
    expect(custom.source).not.toContain('FM_COUPLING');
    void gammaLook;
  });
});
