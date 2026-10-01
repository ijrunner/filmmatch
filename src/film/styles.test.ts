/**
 * R8 风格卡（film/params.ts 的 STYLES）验收测试。
 *
 * 覆盖：6 张卡存在且参数合法（区间内）/ origins 全量 annotated / profile 合法；
 * 「风格差异要大」——两两均值差 > 8 级；型号卡回归（STOCK_IDS / getPreset 语义不变）。
 *
 * 口径说明（诚实边界）：vitest 环境为 node，无 canvas/WebGL，无法调用 EffectRenderer
 * 真正渲染示例帧；这里用「同帧 look 渲染口径」——在一张固定的合成示例帧上逐像素跑
 * lookTransform（与 pipeline.GRADE_FS 非 LUT 分支同源），按 0..255 级求两两平均绝对差。
 * 该口径只覆盖 look 段（分离色调/曲线/饱和/冷暖/褪色），不覆盖质感层（颗粒/光晕/柔光/暗角）
 * 的差异——质感层差异由各卡参数本身保证，但未计入本数值。
 */
import { describe, expect, it } from 'vitest';
import { lookTransform, type LookParams } from '../engine/look';
import {
  DEFAULT_PROFILE, HALATION_PROFILE_IDS, grainProfileById, normalizeProfileRef,
  type HalationProfileId,
} from './grainmatrix';
import {
  defaultLook, defaultTexture, getPreset, getStyle, PRESETS, STOCK_IDS, STYLE_IDS, STYLES,
  type LookParams as FilmLookParams, type PresetCard,
} from './params';

/** 固定合成示例帧：色相 × 亮度扫掠 + 肤色/霓虹色块（无 canvas 依赖，纯数值可复现） */
function sampleFrame(): Array<[number, number, number]> {
  const px: Array<[number, number, number]> = [];
  const N = 24;
  for (let y = 0; y < N; y++) {
    const l = y / (N - 1); // 0 暗部 → 1 高光
    for (let x = 0; x < N; x++) {
      const h = x / N;
      const h6 = h * 6;
      const i = Math.floor(h6) % 6;
      const f = h6 - Math.floor(h6);
      const q = 1 - f;
      let rgb: [number, number, number];
      if (i === 0) rgb = [1, f, 0];
      else if (i === 1) rgb = [q, 1, 0];
      else if (i === 2) rgb = [0, 1, f];
      else if (i === 3) rgb = [0, q, 1];
      else if (i === 4) rgb = [f, 0, 1];
      else rgb = [1, 0, q];
      // 向中间灰混入亮度，避免纯饱和色（更接近真实画面）
      px.push([0.25 + 0.6 * l * rgb[0] + 0.05, 0.25 + 0.6 * l * rgb[1] + 0.05, 0.25 + 0.6 * l * rgb[2] + 0.05]);
    }
  }
  // 肤色 / 霓虹 / 中性灰 代表点
  px.push([0.82, 0.62, 0.5], [0.9, 0.55, 0.42], [0.18, 0.2, 0.28], [0.5, 0.5, 0.5], [0.95, 0.95, 0.95], [0.04, 0.04, 0.05]);
  return px;
}

const FRAME = sampleFrame();

/** 同帧 look 渲染口径：平均绝对差（0..255 级） */
function meanLookDiff(a: LookParams, b: LookParams): number {
  const fa = lookTransform(a as never);
  const fb = lookTransform(b as never);
  let s = 0;
  for (const p of FRAME) {
    const oa = fa(p);
    const ob = fb(p);
    s += (Math.abs(oa[0] - ob[0]) + Math.abs(oa[1] - ob[1]) + Math.abs(oa[2] - ob[2])) / 3;
  }
  return (s / FRAME.length) * 255;
}

/** look 参数区间（与 ui/paramui LOOK_GROUP / engine/look 钳制一致） */
const LOOK_RANGE: Record<Exclude<keyof FilmLookParams, 'coupling' | 'hsl'>, [number, number]> = {
  fade: [0, 1], black_lift: [0, 0.2], dye_coupling: [0, 0.4], shadow_bias: [0, 1], highlight_bias: [0, 1],
  film_s: [0, 1], contrast: [0, 1], saturation: [0, 1.4], warmth: [-1, 1],
  split_shadow_hue: [0, 1], split_shadow_sat: [0, 1], split_highlight_hue: [0, 1], split_highlight_sat: [0, 1],
  split_balance: [-1, 1],
};

/* R8 六张人工标注卡 + R20 八张精选调校卡（估算起点） */
const ST_IDS = ['st01', 'st02', 'st03', 'st04', 'st05', 'st06'] as const;
const FX_IDS = ['fx01', 'fx02', 'fx03', 'fx04', 'fx05', 'fx06', 'fx07', 'fx08'] as const;

describe('R8 风格卡：存在性与参数合法性', () => {
  it('14 张卡齐备（st01–st06 + fx01–fx08），每张都在 STYLES 中且 id/name/family=S', () => {
    expect(STYLE_IDS.length).toBe(14);
    expect([...STYLE_IDS]).toEqual([...ST_IDS, ...FX_IDS]);
    for (const id of STYLE_IDS) {
      const c = STYLES[id];
      expect(c, `缺少风格卡 ${id}`).toBeDefined();
      expect(c.id).toBe(id);
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.family).toBe('S');
      expect(getStyle(id)).toBe(c);
      expect(getPreset(id)).toBe(c);
    }
    // 卡名与计划一致（R8 六张 + R20 八张精选调校卡）
    expect(STYLE_IDS.map((id) => STYLES[id].name)).toEqual([
      '漂白旁路', '交叉冲洗', '青橙商业', '高反差黑白', '褪色复古', '夜戏冷调',
      '暮芒', '夜汀', '素日', '绘本', '樱粉', '食光', '硬调', '新绿',
    ]);
  });

  it('R8 六张：meta 完整、origins 全量 annotated、profile 为默认档', () => {
    for (const id of ST_IDS) {
      const c = STYLES[id];
      expect(c.meta.tagline.trim().length, `${id} tagline`).toBeGreaterThan(0);
      expect(c.meta.sceneTags.length, `${id} sceneTags`).toBeGreaterThanOrEqual(2);
      expect(c.meta.advice.trim().length, `${id} advice`).toBeGreaterThan(0);
      expect(normalizeProfileRef(c.profile)).toEqual(DEFAULT_PROFILE);
      expect(grainProfileById(c.profile.grain), `${id} grain profile`).toBeDefined();
      expect(HALATION_PROFILE_IDS).toContain(c.profile.halation as HalationProfileId);
      // origins 全量 annotated（含 texture / look / master 全部路径）
      const vals = Object.values(c.origins);
      expect(vals.length).toBeGreaterThan(0);
      expect(vals.every((o) => o === 'annotated'), `${id} 存在非 annotated origin`).toBe(true);
      for (const k of Object.keys(defaultLook())) expect(c.origins[`look.${k}`], `${id} 缺 look.${k}`).toBe('annotated');
      expect(c.origins['master']).toBe('annotated');
    }
  });

  it('R20 精选组：meta 完整、origins 全量 estimated（估算起点卡）、profile 引用合法', () => {
    for (const id of FX_IDS) {
      const c = STYLES[id];
      expect(c.meta.tagline.trim().length, `${id} tagline`).toBeGreaterThan(0);
      expect(c.meta.sceneTags.length, `${id} sceneTags`).toBeGreaterThanOrEqual(2);
      expect(c.meta.advice.trim().length, `${id} advice`).toBeGreaterThan(0);
      // profile 引用合法且可原样往返（fx 组允许非默认档：夜景 g-35-500 / 食物 g-65-250）
      expect(normalizeProfileRef(c.profile)).toEqual(c.profile);
      expect(grainProfileById(c.profile.grain), `${id} grain profile`).toBeDefined();
      expect(HALATION_PROFILE_IDS).toContain(c.profile.halation as HalationProfileId);
      // origins 全量 estimated（区别于 st 组的人工标注卡）
      const vals = Object.values(c.origins);
      expect(vals.length).toBeGreaterThan(0);
      expect(vals.every((o) => o === 'estimated'), `${id} 存在非 estimated origin`).toBe(true);
      for (const k of Object.keys(defaultLook())) expect(c.origins[`look.${k}`], `${id} 缺 look.${k}`).toBe('estimated');
      expect(c.origins['master']).toBe('estimated');
    }
  });

  it('每张卡 look 字段全在区间内；texture 数值字段有限且非负', () => {
    for (const id of STYLE_IDS) {
      const look = STYLES[id].params.look;
      for (const k of Object.keys(LOOK_RANGE) as Array<Exclude<keyof FilmLookParams, 'coupling' | 'hsl'>>) {
        const v = look[k];
        expect(Number.isFinite(v), `${id} look.${k} 非有限`).toBe(true);
        expect(v, `${id} look.${k}=${v}`).toBeGreaterThanOrEqual(LOOK_RANGE[k][0]);
        expect(v, `${id} look.${k}=${v}`).toBeLessThanOrEqual(LOOK_RANGE[k][1]);
      }
      const t = STYLES[id].params.texture;
      for (const g of Object.keys(t) as Array<keyof typeof t>) {
        for (const [k, v] of Object.entries(t[g] as unknown as Record<string, unknown>)) {
          if (typeof v === 'number') expect(Number.isFinite(v) && v >= 0, `${id} texture.${g}.${k}=${v}`).toBe(true);
          else if (Array.isArray(v)) expect(v.every((x) => Number.isFinite(x) && x >= 0), `${id} texture.${g}.${k}`).toBe(true);
        }
      }
      expect(STYLES[id].params.master).toBe(1);
    }
  });

  it('至少 4 张卡真正用上新维度（分离色调或黑白 saturation=0）', () => {
    let used = 0;
    for (const id of STYLE_IDS) {
      const l = STYLES[id].params.look;
      const split = l.split_shadow_sat > 0 || l.split_highlight_sat > 0;
      const bw = l.saturation === 0;
      if (split || bw) used++;
    }
    expect(used).toBeGreaterThanOrEqual(4);
  });
});

describe('R8 风格卡：两两观感差 > 8 级（同帧 look 渲染口径）', () => {
  it('任意两张风格卡的 look 渲染平均绝对差 > 8 级；打印最小对', () => {
    let minPair = Infinity;
    let worst = '';
    for (let i = 0; i < STYLE_IDS.length; i++) {
      for (let j = i + 1; j < STYLE_IDS.length; j++) {
        const d = meanLookDiff(STYLES[STYLE_IDS[i]].params.look, STYLES[STYLE_IDS[j]].params.look);
        if (d < minPair) { minPair = d; worst = `${STYLE_IDS[i]} vs ${STYLE_IDS[j]}`; }
      }
    }
    console.info('[styles 两两 look 差] 最小对 =', minPair.toFixed(2), '级（', worst, '）');
    expect(minPair, `最小对 ${worst}`).toBeGreaterThan(8);
  });

  it('每张风格卡与原图（中性 look）差 > 8 级（确实偏离基准）', () => {
    const neutral = defaultLook();
    for (const id of STYLE_IDS) {
      const d = meanLookDiff(STYLES[id].params.look, neutral);
      console.info(`[styles ${id}] 与中性差 =`, d.toFixed(2), '级');
      expect(d, `${id} 与中性 look 差过小`).toBeGreaterThan(8);
    }
  });
});

describe('R8 风格卡：型号卡回归', () => {
  it('STOCK_IDS 仍恰为 fl01–fl10（语义不变），风格卡不在其中', () => {
    expect([...STOCK_IDS]).toEqual(['fl01', 'fl02', 'fl03', 'fl04', 'fl05', 'fl06', 'fl07', 'fl08', 'fl09', 'fl10']);
    for (const id of STYLE_IDS) expect(STOCK_IDS as readonly string[]).not.toContain(id);
  });

  it('getPreset 对既有型号卡/neutral/未知 id 的语义不变', () => {
    expect(getPreset('fl05')).toBe(PRESETS.fl05);
    expect(getPreset('neutral')).toBe(PRESETS.neutral);
    expect(getPreset('不存在')).toBe(PRESETS.neutral);
  });

  it('型号卡的 texture/look 未被风格卡引入而改动（抽样比对恒等默认与冻结值）', () => {
    const d = defaultTexture();
    // 型号卡不因新增风格卡而改变：fl06 的关键字段仍为 R1/R2 冻结值
    const fl06 = PRESETS.fl06.params;
    expect(fl06.look.film_s).toBe(0.8);
    expect(fl06.look.warmth).toBe(0.1);
    expect(fl06.texture.grain.iso).toBe(250);
    // neutral 仍是全恒等默认
    expect(PRESETS.neutral.params.look).toEqual(defaultLook());
    expect(PRESETS.neutral.params.texture).toEqual(d);
    // 风格卡不得写入 PRESETS
    for (const id of STYLE_IDS) expect(PRESETS[id], `风格卡 ${id} 误入 PRESETS`).toBeUndefined();
  });
});
