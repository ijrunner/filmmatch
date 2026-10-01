/**
 * 颗粒/光晕档位矩阵（film/grainmatrix.ts）测试：
 * 12 档完整性、画幅/感光度物理方向、applyProfile 纯函数与字段覆盖、normalizeProfileRef 容错。
 * 单位约定同 Schema：size=画面高度‰、radius=画面高度%、其余无量纲权重。
 */
import { describe, expect, it } from 'vitest';
import { defaultTexture } from './params';
import {
  DEFAULT_PROFILE, GRAIN_PROFILES, HALATION_PROFILES, applyProfile, grainProfileById,
  normalizeProfileRef, type FilmFormat, type IsoStep,
} from './grainmatrix';

const FORMATS: FilmFormat[] = ['8', '16', '35', '65'];
const ISO_STEPS: IsoStep[] = [50, 250, 500];

/** 档位管辖的 grain 字段（applyProfile 会写） */
const GRAIN_FIELDS = ['size', 'correlation', 'shadow', 'midtone', 'highlight', 'film_resolution'] as const;
/** 档位管辖的 halation 字段（applyProfile 会写） */
const HALATION_FIELDS = ['amount', 'radius', 'amplify', 'smoothness', 'blue_comp'] as const;

describe('GRAIN_PROFILES 矩阵完整性', () => {
  it('恰好 12 档，id 唯一且形如 g-<fmt>-<iso>', () => {
    expect(GRAIN_PROFILES.length).toBe(12);
    const ids = GRAIN_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(12);
    for (const p of GRAIN_PROFILES) {
      expect(p.id).toBe(`g-${p.format}-${p.iso}`);
      expect(p.id).toMatch(/^g-(8|16|35|65)-(50|250|500)$/);
      expect(FORMATS).toContain(p.format);
      expect(ISO_STEPS).toContain(p.iso);
    }
    // 画幅 × 感光度 的笛卡尔积齐全
    for (const f of FORMATS) for (const iso of ISO_STEPS) {
      expect(grainProfileById(`g-${f}-${iso}`)).toBeDefined();
    }
  });
});

describe('物理方向：画幅越大颗粒越细', () => {
  it('同 ISO 下 size 严格递减 8 > 16 > 35 > 65', () => {
    for (const iso of ISO_STEPS) {
      const sizes = FORMATS.map((f) => grainProfileById(`g-${f}-${iso}`)!.size);
      for (let i = 0; i < sizes.length - 1; i++) expect(sizes[i]).toBeGreaterThan(sizes[i + 1]);
    }
  });
});

describe('物理方向：感光度越高暗部颗粒越明显', () => {
  it('同画幅下 shadow 严格递增 50 < 250 < 500，且 ISO500 的 size > ISO50 的 size', () => {
    for (const f of FORMATS) {
      const shadows = ISO_STEPS.map((iso) => grainProfileById(`g-${f}-${iso}`)!.shadow);
      for (let i = 0; i < shadows.length - 1; i++) expect(shadows[i]).toBeLessThan(shadows[i + 1]);
      const s50 = grainProfileById(`g-${f}-50`)!.size;
      const s500 = grainProfileById(`g-${f}-500`)!.size;
      expect(s500).toBeGreaterThan(s50);
    }
  });
});

describe('applyProfile', () => {
  it('是纯函数（不改入参）且写入全部档位字段', () => {
    const ref = { grain: 'g-8-500', halation: 'noremjet' } as const;
    const g = grainProfileById(ref.grain)!;
    const h = HALATION_PROFILES[ref.halation];
    const input = defaultTexture();
    const before = JSON.parse(JSON.stringify(input));
    const out = applyProfile(input, ref);
    // 纯函数：入参深比较前后相等
    expect(input).toEqual(before);
    expect(out).not.toBe(input);
    // 逐字段断言 grain 档位字段
    for (const k of GRAIN_FIELDS) expect(out.grain[k]).toBe(g[k]);
    expect(out.grain.type).toBe(g.type);
    expect(out.grain.iso).toBe(g.iso);
    // 逐字段断言 halation 档位字段
    for (const k of HALATION_FIELDS) expect(out.halation[k]).toBe(h[k]);
  });

  it('保留非档位字段（enabled / tint_rgb / threshold / bloom 不变）', () => {
    const ref = { grain: 'g-65-50', halation: 'std' } as const;
    const input = defaultTexture();
    input.halation.enabled = true;
    input.halation.tint_rgb = [0.9, 0.4, 0.25];
    input.halation.threshold = 0.66;
    input.halation.background_gain = 0.42;
    input.halation.impact = 0.31;
    input.grain.enabled = false;
    input.grain.mode = 'noise';
    input.bloom.enabled = false;
    input.bloom.amount = 0.77;
    input.bloom.details = 0.33;
    const out = applyProfile(input, ref);
    expect(out.halation.enabled).toBe(true);
    expect(out.halation.tint_rgb).toEqual([0.9, 0.4, 0.25]);
    expect(out.halation.threshold).toBe(0.66);
    expect(out.halation.background_gain).toBe(0.42);
    expect(out.halation.impact).toBe(0.31);
    expect(out.grain.enabled).toBe(false);
    expect(out.grain.mode).toBe('noise');
    expect(out.bloom.enabled).toBe(false);
    expect(out.bloom.amount).toBe(0.77);
    expect(out.bloom.details).toBe(0.33);
  });
});

describe('normalizeProfileRef 容错', () => {
  it('非法 grain id / 非法 halation → 回落 DEFAULT_PROFILE；合法值原样返回', () => {
    expect(normalizeProfileRef({ grain: 'g-99-999', halation: 'xxx' })).toEqual(DEFAULT_PROFILE);
    expect(normalizeProfileRef(undefined)).toEqual(DEFAULT_PROFILE);
    expect(normalizeProfileRef(null)).toEqual(DEFAULT_PROFILE);
    expect(normalizeProfileRef({})).toEqual(DEFAULT_PROFILE);
    const ok = { grain: 'g-16-500', halation: 'noremjet' } as const;
    expect(normalizeProfileRef(ok)).toEqual(ok);
    // 部分合法：非法 grain 回默认，合法 halation 保留
    expect(normalizeProfileRef({ grain: 'bogus', halation: 'noremjet' }))
      .toEqual({ grain: DEFAULT_PROFILE.grain, halation: 'noremjet' });
  });
});

describe('HALATION_PROFILES 物理设定方向', () => {
  it('去防光晕层的 amount 更大且 radius 更大', () => {
    expect(HALATION_PROFILES.noremjet.amount).toBeGreaterThan(HALATION_PROFILES.std.amount);
    expect(HALATION_PROFILES.noremjet.radius).toBeGreaterThan(HALATION_PROFILES.std.radius);
    expect(HALATION_PROFILES.noremjet.amplify).toBeGreaterThan(HALATION_PROFILES.std.amplify);
  });
});
