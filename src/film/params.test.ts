/**
 * 参数卡（film/params.ts）Schema v1.1 测试：
 * 默认值、向后兼容（v1 旧对象）、枚举容错、Schema 导出、预设卡恒等回归。
 */
import { describe, expect, it } from 'vitest';
import {
  defaultLook, defaultTexture, normalizeParams, PRESETS, STOCK_IDS, STYLES, STYLE_IDS, textureToSchema,
  type LookParams,
} from './params';
import {
  grainProfileById, normalizeProfileRef, HALATION_PROFILE_IDS, HALATION_PROFILES,
  type HalationProfileId,
} from './grainmatrix';
import { BRAND_WORDS } from '../estimate/xmpmap';

/** 合法曲线家族集合 */
const FAMILIES = ['neutral', 'C-A', 'C-B', 'C-C', 'C-D'];
/** R2 新增的 5 张卡（既有 fl04–fl08 为 R1 冻结值，不参与档位一致性断言） */
const NEW_IDS = ['fl01', 'fl02', 'fl03', 'fl09', 'fl10'] as const;
/** 档位管辖的 grain 数值字段 */
const GRAIN_FIELDS = ['size', 'correlation', 'shadow', 'midtone', 'highlight', 'film_resolution'] as const;
/** 档位管辖的 halation 数值字段 */
const HALATION_FIELDS = ['amount', 'radius', 'amplify', 'smoothness', 'blue_comp'] as const;

/** 相对误差在 tol 内（以档位值为基准） */
function near(actual: number, ref: number, tol = 0.15): boolean {
  return Math.abs(actual - ref) <= tol * Math.abs(ref);
}

describe('defaultTexture（Schema v1.1 默认值）', () => {
  it('halation / grain / bloom 新字段等于规定默认值', () => {
    const t = defaultTexture();
    expect(t.halation.background_gain).toBe(1);
    expect(t.halation.amplify).toBe(1);
    expect(t.halation.impact).toBe(1);
    expect(t.halation.hue).toBe(0.5);
    expect(t.halation.blue_comp).toBe(0);
    expect(t.halation.smoothness).toBe(0.5);

    expect(t.grain.shadow).toBe(1);
    expect(t.grain.midtone).toBe(1);
    expect(t.grain.highlight).toBe(0.2);
    expect(t.grain.type).toBe('negative');
    expect(t.grain.film_resolution).toBe(0.5);
    expect(t.grain.mode).toBe('analogue');
    expect(t.grain.shadow_weight).toBe(0.8); // 旧字段保留

    expect(t.bloom.save_lights).toBe(0);
    expect(t.bloom.details).toBe(0.5);
    expect(t.bloom.saturation).toBe(1);
  });
});

describe('normalizeParams 兼容性', () => {
  it('Schema v1 旧对象：新字段取默认、旧字段保留', () => {
    const p = normalizeParams({ texture: { grain: { iso: 800, shadow_weight: 0.9 } } });
    expect(p.texture.grain.iso).toBe(800);
    expect(p.texture.grain.shadow_weight).toBe(0.9);
    // 未提供的 v1.1 新字段回落到默认
    expect(p.texture.grain.highlight).toBe(0.2);
    expect(p.texture.grain.type).toBe('negative');
    expect(p.texture.grain.film_resolution).toBe(0.5);
    expect(p.texture.grain.mode).toBe('analogue');
    expect(p.texture.halation.background_gain).toBe(1);
    expect(p.texture.bloom.save_lights).toBe(0);
  });

  it('枚举容错：非法 type 静默忽略保持默认，合法 mode 生效', () => {
    const p = normalizeParams({
      texture: { grain: { type: 'bogus', mode: 'noise' } },
    } as never);
    expect(p.texture.grain.type).toBe('negative'); // 非法值 → 默认
    expect(p.texture.grain.mode).toBe('noise');    // 合法值 → 采用
  });
});

describe('textureToSchema 导出', () => {
  it('输出含全部 v1.1 新字段且带 origin；type/mode 为纯字符串', () => {
    const t = defaultTexture();
    const origins = {
      'halation.background_gain': 'annotated' as const,
      'grain.type': 'annotated' as const,
      'bloom.save_lights': 'user' as const,
    };
    const s = textureToSchema(t, origins);
    const h = s.halation as unknown as Record<string, unknown>;
    const gr = s.grain as unknown as Record<string, unknown>;
    const bl = s.bloom as unknown as Record<string, unknown>;
    // halation 新字段
    for (const k of ['background_gain', 'amplify', 'impact', 'hue', 'blue_comp', 'smoothness']) {
      expect(h[k]).toBeDefined();
      expect(h[k]).toHaveProperty('value');
      expect(h[k]).toHaveProperty('origin');
    }
    expect(s.halation.background_gain).toEqual({ value: 1, origin: 'annotated' });
    // grain 新字段
    for (const k of ['shadow', 'midtone', 'highlight', 'film_resolution']) {
      expect(gr[k]).toHaveProperty('value');
    }
    expect(s.grain.type).toBe('negative'); // 纯字符串，非包装对象
    expect(s.grain.mode).toBe('analogue');
    // bloom 新字段
    expect(s.bloom.save_lights).toEqual({ value: 0, origin: 'user' });
    for (const k of ['details', 'saturation']) expect(bl[k]).toHaveProperty('value');
  });
});

describe('预设卡回归', () => {
  it('PRESETS.neutral 新字段全为恒等默认', () => {
    const t = PRESETS.neutral.params.texture;
    const d = defaultTexture();
    expect(t.halation.background_gain).toBe(d.halation.background_gain);
    expect(t.halation.amplify).toBe(d.halation.amplify);
    expect(t.halation.impact).toBe(d.halation.impact);
    expect(t.halation.hue).toBe(d.halation.hue);
    expect(t.halation.blue_comp).toBe(d.halation.blue_comp);
    expect(t.halation.smoothness).toBe(d.halation.smoothness);
    expect(t.grain.shadow).toBe(d.grain.shadow);
    expect(t.grain.midtone).toBe(d.grain.midtone);
    expect(t.grain.highlight).toBe(d.grain.highlight);
    expect(t.grain.type).toBe(d.grain.type);
    expect(t.grain.film_resolution).toBe(d.grain.film_resolution);
    expect(t.grain.mode).toBe(d.grain.mode);
    expect(t.bloom.save_lights).toBe(d.bloom.save_lights);
    expect(t.bloom.details).toBe(d.bloom.details);
    expect(t.bloom.saturation).toBe(d.bloom.saturation);
  });

  it('PRESETS.fl05 的非恒等字段存在（背景增益/散射敏感度/冷背景补偿等）', () => {
    const t = PRESETS.fl05.params.texture;
    expect(t.halation.background_gain).not.toBe(1);
    expect(t.halation.amplify).not.toBe(1);
    expect(t.halation.blue_comp).not.toBe(0);
    expect(t.bloom.save_lights).not.toBe(0);
    expect(t.bloom.saturation).not.toBe(1);
    expect(t.halation.enabled).toBe(true);
  });
});

describe('R2 型号卡扩到 10 张', () => {
  it('STOCK_IDS 恰为 fl01–fl10，且每张卡都在 PRESETS 中存在', () => {
    expect(STOCK_IDS.length).toBe(10);
    expect([...STOCK_IDS]).toEqual(['fl01', 'fl02', 'fl03', 'fl04', 'fl05', 'fl06', 'fl07', 'fl08', 'fl09', 'fl10']);
    for (const id of STOCK_IDS) {
      const card = PRESETS[id];
      expect(card, `缺少型号卡 ${id}`).toBeDefined();
      expect(card.id).toBe(id);
      expect(card.name.length).toBeGreaterThan(0);
    }
  });

  it('每张卡 meta 完整（tagline/sceneTags/advice）且 family 合法', () => {
    for (const id of STOCK_IDS) {
      const card = PRESETS[id];
      expect(card.meta.tagline.trim().length, `${id} tagline`).toBeGreaterThan(0);
      expect(card.meta.sceneTags.length, `${id} sceneTags`).toBeGreaterThanOrEqual(2);
      expect(card.meta.advice.trim().length, `${id} advice`).toBeGreaterThan(0);
      expect(FAMILIES, `${id} family`).toContain(card.family);
    }
  });

  it('每张卡的 profile 可经 normalizeProfileRef 原样往返（grain id 存在、halation 合法）', () => {
    for (const id of STOCK_IDS) {
      const card = PRESETS[id];
      expect(grainProfileById(card.profile.grain), `${id} grain id`).toBeDefined();
      expect(HALATION_PROFILE_IDS).toContain(card.profile.halation as HalationProfileId);
      expect(normalizeProfileRef(card.profile)).toEqual(card.profile);
    }
  });

  it('每张卡之间 look 参数不完全相同（防复制粘贴）', () => {
    const seen = new Set<string>();
    for (const id of STOCK_IDS) {
      const key = JSON.stringify(PRESETS[id].params.look);
      expect(seen.has(key), `${id} look 与其它卡重复`).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(STOCK_IDS.length);
  });
});

describe('R2 新卡 texture 与 profile 档位一致', () => {
  it('grain/halation 被档位管辖字段在 ±15% 内，且 iso 严格相等', () => {
    for (const id of NEW_IDS) {
      const card = PRESETS[id];
      const g = grainProfileById(card.profile.grain);
      expect(g, `${id} grain 档位存在`).toBeDefined();
      const tex = card.params.texture;
      for (const k of GRAIN_FIELDS) {
        expect(near(tex.grain[k], g![k]), `${id} grain.${k}=${tex.grain[k]} vs 档位 ${g![k]}`).toBe(true);
      }
      expect(tex.grain.iso, `${id} iso 必须等于档位 ISO`).toBe(g!.iso);
      const ref = HALATION_PROFILES[card.profile.halation];
      expect(ref, `${id} halation 档位合法`).toBeDefined();
      for (const k of HALATION_FIELDS) {
        expect(near(tex.halation[k], ref[k]), `${id} halation.${k}=${tex.halation[k]} vs 档位 ${ref[k]}`).toBe(true);
      }
    }
  });
});

/* ================= R20 精选调校卡（fx01–fx08，估算起点入库） ================= */

/** R20 精选组 id（与 styles.test.ts 的 FX_IDS 同源口径） */
const FX_CARDS = ['fx01', 'fx02', 'fx03', 'fx04', 'fx05', 'fx06', 'fx07', 'fx08'] as const;

/** fx 组 look 区间（调校先验：fade≤0.5、black_lift≤0.2（styles 区间 0.2 为更紧约束）、sat 0.75..1.3） */
const FX_LOOK_RANGE: Record<Exclude<keyof LookParams, 'coupling' | 'hsl'>, [number, number]> = {
  fade: [0, 0.5], black_lift: [0, 0.2], dye_coupling: [0, 0.4], shadow_bias: [0, 1], highlight_bias: [0, 1],
  film_s: [0, 1], contrast: [0, 1], saturation: [0.75, 1.3], warmth: [-1, 1],
  split_shadow_hue: [0, 1], split_shadow_sat: [0, 1], split_highlight_hue: [0, 1], split_highlight_sat: [0, 1],
  split_balance: [-1, 1],
};

describe('R20 精选调校卡（fx01–fx08）', () => {
  it('恰为 8 张（fx01–fx08），都在 STYLES 中、family=S、不入 PRESETS/STOCK_IDS', () => {
    expect(FX_CARDS.length).toBe(8);
    for (const id of FX_CARDS) {
      const c = STYLES[id];
      expect(c, `缺少精选卡 ${id}`).toBeDefined();
      expect(c.id).toBe(id);
      expect(c.family).toBe('S');
      expect(PRESETS[id as string], `${id} 误入 PRESETS`).toBeUndefined();
      expect(STOCK_IDS as readonly string[]).not.toContain(id);
    }
    expect(STYLE_IDS.filter((x) => x.startsWith('fx'))).toEqual([...FX_CARDS]);
  });

  it('命名与文案零品牌词（词表现读 estimate/xmpmap BRAND_WORDS，卡名/tagline/advice/note 全查）', () => {
    const compound = /^(Exposure|Vision3|CineStill|Dehancer|Kodak|Fuji|RNI)$/i;
    const hitIn = (text: string): string | null => {
      for (const w of BRAND_WORDS) {
        const main = new RegExp(`(?<![A-Za-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i');
        const loose = new RegExp(`(?<![A-Za-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
        if (main.test(text) || (compound.test(w) && loose.test(text))) return w;
      }
      return null;
    };
    for (const id of FX_CARDS) {
      const c = STYLES[id];
      for (const [label, text] of [['name', c.name], ['tagline', c.meta.tagline], ['advice', c.meta.advice], ['note', c.note]] as const) {
        const hit = hitIn(text);
        expect(hit, `${id} ${label} 命中品牌词「${hit}」：${text}`).toBeNull();
      }
      for (const tag of c.meta.sceneTags) expect(hitIn(tag), `${id} sceneTag 命中品牌词：${tag}`).toBeNull();
    }
  });

  it('origins 全量 estimated（估算起点调校卡，区别于 st 组的 annotated）', () => {
    for (const id of FX_CARDS) {
      const vals = Object.values(STYLES[id].origins);
      expect(vals.length).toBeGreaterThan(0);
      expect(vals.every((o) => o === 'estimated'), `${id} 存在非 estimated origin`).toBe(true);
      for (const k of Object.keys(defaultLook())) expect(STYLES[id].origins[`look.${k}`]).toBe('estimated');
      expect(STYLES[id].origins['master']).toBe('estimated');
    }
  });

  it('look 全键在调校先验区间内（fade≤0.5、black_lift≤0.2、sat 0.75..1.3、其余同面板区间）', () => {
    for (const id of FX_CARDS) {
      const look = STYLES[id].params.look as unknown as Record<string, number>;
      for (const [k, [lo, hi]] of Object.entries(FX_LOOK_RANGE)) {
        const v = look[k];
        expect(Number.isFinite(v), `${id} look.${k} 非有限`).toBe(true);
        expect(v, `${id} look.${k}=${v} 越下界`).toBeGreaterThanOrEqual(lo);
        expect(v, `${id} look.${k}=${v} 越上界`).toBeLessThanOrEqual(hi);
      }
      // 曲线族/分离色调至少触碰一项（估算起点必须有观感主体）
      const l = STYLES[id].params.look;
      const touched = l.film_s > 0 || l.contrast > 0 || l.fade > 0 || l.black_lift > 0
        || l.saturation !== 1 || l.warmth !== 0 || l.split_shadow_sat > 0 || l.split_highlight_sat > 0;
      expect(touched, `${id} 未触碰任何观感维度`).toBe(true);
    }
  });

  it('texture 档位一致：grain 档位管辖字段 ±15%、iso 严格相等；开启的光晕档字段 ±15%', () => {
    for (const id of FX_CARDS) {
      const card = STYLES[id];
      const g = grainProfileById(card.profile.grain);
      expect(g, `${id} grain 档位存在`).toBeDefined();
      const tex = card.params.texture;
      for (const k of GRAIN_FIELDS) {
        expect(near(tex.grain[k], g![k]), `${id} grain.${k}=${tex.grain[k]} vs 档位 ${g![k]}`).toBe(true);
      }
      expect(tex.grain.iso, `${id} iso 必须等于档位 ISO`).toBe(g!.iso);
      const ref = HALATION_PROFILES[card.profile.halation];
      expect(ref, `${id} halation 档位合法`).toBeDefined();
      if (tex.halation.enabled) {
        for (const k of HALATION_FIELDS) {
          expect(near(tex.halation[k], ref[k]), `${id} halation.${k}=${tex.halation[k]} vs 档位 ${ref[k]}`).toBe(true);
        }
      }
    }
  });
});
