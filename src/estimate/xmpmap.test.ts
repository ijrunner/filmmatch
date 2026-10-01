/**
 * XMP IR → FilmMatch 映射（estimate/xmpmap.ts）验收测试。
 * fixture 全部手工合成（键形态模仿 LR 预设，数值自编），不含真实预设内容（合规红线）。
 * 重点：恒等护栏（JSON 逐字等于 defaultParams）、每条映射规则的方向断言、区间合法性遍历。
 */
import { describe, expect, it } from 'vitest';
import { defaultParams, LOOK_KEYS } from '../film/params';
import { curveToFn, parseXmp } from './xmp';
import type { XmpIR } from './xmp';
import { BRAND_WORDS, cleanCardName, mapXmpToFilm } from './xmpmap';

/** 合成 XMP 文档包装（与 xmp.test.ts 同构） */
function wrap(attrs: Record<string, string>, elements: string[] = []): string {
  const attrLines = Object.entries(attrs)
    .map(([k, v]) => `   crs:${k}="${v}"`)
    .join('\n');
  return `<?xpacket begin="" id="SYNTHETIC0000000000000000000000"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Synthetic Fixture">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
${attrLines}>
${elements.join('\n')}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
}

/** 解析+映射一步到位 */
function mapOf(attrs: Record<string, string>, elements: string[] = []) {
  return mapXmpToFilm(parseXmp(wrap(attrs, elements)));
}

/** 全中性 fixture：常见键全部存在但取值 0/False（比「空文件」更强的恒等护栏） */
const NEUTRAL_FIXTURE_ATTRS: Record<string, string> = {
  ProcessVersion: '11.0',
  CameraProfile: 'Adobe Standard',
  Exposure2012: '0',
  Contrast2012: '0',
  Highlights2012: '0',
  Shadows2012: '0',
  Whites2012: '0',
  Blacks2012: '0',
  ParametricShadows: '0',
  ParametricDarks: '0',
  ParametricLights: '0',
  ParametricHighlights: '0',
  SplitToningShadowHue: '0',
  SplitToningShadowSaturation: '0',
  SplitToningHighlightHue: '0',
  SplitToningHighlightSaturation: '0',
  SplitToningBalance: '0',
  GrainAmount: '0',
  GrainSize: '25',
  GrainFrequency: '50',
  PostCropVignetteAmount: '0',
  PostCropVignetteMidpoint: '50',
  Saturation: '0',
  Vibrance: '0',
  IncrementalTemperature: '0',
  IncrementalTint: '0',
};
const IDENTITY_CURVE_ELEMENT =
  '   <crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012>';

/** 按 origins 记录的路径读参数值（'look.film_s' / 'grain.size' / 'vignette.amount'）。
 * 路径口径与 PresetCard.origins 一致：texture 组省略 texture. 前缀。 */
function getByPath(params: unknown, path: string): number | boolean {
  const segs = path.split('.');
  if (segs[0] === 'grain' || segs[0] === 'vignette' || segs[0] === 'halation' || segs[0] === 'bloom' || segs[0] === 'gate_weave') {
    segs.unshift('texture');
  }
  let node: unknown = params;
  for (const s of segs) {
    node = (node as Record<string, unknown>)[s];
  }
  return node as number | boolean;
}

/* ---------------- 恒等护栏 ---------------- */

describe('XMP 映射：恒等护栏', () => {
  it('全中性 XMP（全键存在但取值 0/恒等）→ 参数与 defaultParams() JSON 逐字相等', () => {
    const r = mapOf(NEUTRAL_FIXTURE_ATTRS, [IDENTITY_CURVE_ELEMENT]);
    expect(JSON.parse(JSON.stringify(r.params))).toEqual(JSON.parse(JSON.stringify(defaultParams())));
  });
  it('空 IR（只有版本键）→ 同样逐字恒等', () => {
    const r = mapOf({ ProcessVersion: '11.0' });
    expect(JSON.parse(JSON.stringify(r.params))).toEqual(JSON.parse(JSON.stringify(defaultParams())));
  });
  it('origins 里被写的路径一律标 estimated', () => {
    const r = mapOf({ Contrast2012: '+50', GrainSize: '60', SplitToningBalance: '-15' });
    expect(Object.keys(r.origins).length).toBeGreaterThan(0);
    for (const v of Object.values(r.origins)) expect(v).toBe('estimated');
  });
  it('恒等 fixture 写出的 origins 全部是「显式出现的零值键」，值与默认相同', () => {
    const r = mapOf(NEUTRAL_FIXTURE_ATTRS, [IDENTITY_CURVE_ELEMENT]);
    expect(Object.keys(r.origins).length).toBeGreaterThan(0);
    for (const [path, origin] of Object.entries(r.origins)) {
      expect(origin).toBe('estimated');
      /* 写出的零值/中性值必须与默认值一致（否则破坏恒等护栏） */
      expect(getByPath(r.params, path)).toBe(getByPath(defaultParams(), path));
    }
    /* 曲线族未被触碰：无 film_s/contrast/fade/black_lift 的 origins */
    for (const p of ['look.film_s', 'look.contrast', 'look.fade', 'look.black_lift']) {
      expect(r.origins[p]).toBeUndefined();
    }
  });
});

/* ---------------- 曲线族映射 ---------------- */

describe('XMP 映射：曲线族反解（film_s / contrast / fade / black_lift）', () => {
  it('Contrast2012 +50 有精确解：contrast=0.5、film_s=0（引擎家族B 同形）', () => {
    const r = mapOf({ Contrast2012: '+50' });
    expect(r.params.look.contrast).toBeCloseTo(0.5, 3);
    expect(r.params.look.film_s).toBeLessThan(0.02);
  });
  it('Contrast2012 ±50 方向相反：+ 走家族B（contrast），− 走家族A（film_s 软化）', () => {
    const plus = mapOf({ Contrast2012: '+50' }).params.look;
    const minus = mapOf({ Contrast2012: '-50' }).params.look;
    expect(plus.contrast).toBeGreaterThan(0.45);
    expect(minus.contrast).toBeLessThan(0.1);
    expect(minus.film_s).toBeGreaterThan(plus.film_s);
    expect(plus.contrast).toBeGreaterThan(minus.contrast);
  });
  it('Blacks2012 +40 抬黑位（black_lift > 0）；−40 压黑（black_lift=0 且走对比方向）', () => {
    const plus = mapOf({ Blacks2012: '+40' }).params.look;
    const minus = mapOf({ Blacks2012: '-40' }).params.look;
    expect(plus.black_lift).toBeGreaterThan(0.03);
    expect(minus.black_lift).toBeLessThan(0.01);
    expect(minus.contrast).toBeGreaterThan(plus.contrast);
  });
  it('Highlights2012 −60（高光回收）→ 白位收拢 fade 抬升；+60 方向相反', () => {
    const plus = mapOf({ Highlights2012: '+60' }).params.look;
    const minus = mapOf({ Highlights2012: '-60' }).params.look;
    expect(minus.fade).toBeGreaterThan(0.5);
    expect(plus.fade).toBeLessThan(0.2);
  });
  it('ParametricShadows ±10 方向相反（+ 走软S抬阴影，− 走对比压暗）', () => {
    const plus = mapOf({ ParametricShadows: '+10' }).params.look;
    const minus = mapOf({ ParametricShadows: '-10' }).params.look;
    expect(plus.film_s).toBeGreaterThan(minus.film_s);
    expect(minus.contrast).toBeGreaterThan(plus.contrast);
  });
  it('点曲线黑位抬升（matte）→ black_lift', () => {
    const r = mapOf({}, [
      '   <crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 12</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012>',
    ]);
    expect(r.params.look.black_lift).toBeGreaterThan(0.03);
    expect(r.params.look.fade).toBeLessThan(0.01);
  });
  it('点曲线强 S → contrast 高位', () => {
    const r = mapOf({}, [
      '   <crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>64, 40</rdf:li><rdf:li>192, 220</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012>',
    ]);
    expect(r.params.look.contrast).toBeGreaterThan(0.6);
  });
  it('恒等点曲线不触碰曲线族（无曲线相关 origins / 无估算提示 warning）', () => {
    const r = mapOf({}, [IDENTITY_CURVE_ELEMENT]);
    expect(r.origins['look.film_s']).toBeUndefined();
    expect(r.warnings.some((w) => w.includes('曲线族'))).toBe(false);
  });
  it('曲线族被触碰时必带「估算起点，需人工调校」提示', () => {
    const r = mapOf({ Contrast2012: '+50' });
    expect(r.warnings.some((w) => w.includes('估算起点') && w.includes('人工调校'))).toBe(true);
  });
  it('反解残差过大时给出最大偏差警告', () => {
    /* Highlights +60 的上中段集中抬升是家族曲线不能局部表达的形状 → 必然有残差 */
    const r = mapOf({ Highlights2012: '+60' });
    expect(r.warnings.some((w) => w.includes('最大偏差'))).toBe(true);
  });
});

/* ---------------- SplitToning（几乎一一对应） ---------------- */

describe('XMP 映射：SplitToning → look.split_*', () => {
  it('数值一一对应（色相 /360，饱和 /100，平衡 /100）', () => {
    const r = mapOf({
      SplitToningShadowHue: '42',
      SplitToningShadowSaturation: '60',
      SplitToningHighlightHue: '210',
      SplitToningHighlightSaturation: '50',
      SplitToningBalance: '-15',
    });
    const l = r.params.look;
    expect(l.split_shadow_hue).toBeCloseTo(42 / 360, 3); /* 写出值统一 4 位小数 */
    expect(l.split_shadow_sat).toBeCloseTo(0.6, 6);
    expect(l.split_highlight_hue).toBeCloseTo(210 / 360, 3);
    expect(l.split_highlight_sat).toBeCloseTo(0.5, 6);
    expect(l.split_balance).toBeCloseTo(-0.15, 6);
  });
  it('色相轮方向同相：LR 0°=红/120°=绿/240°=蓝 ↔ 引擎 0/⅓/⅔', () => {
    const r = mapOf({ SplitToningShadowHue: '120', SplitToningHighlightHue: '240' });
    expect(r.params.look.split_shadow_hue).toBeCloseTo(1 / 3, 3);
    expect(r.params.look.split_highlight_hue).toBeCloseTo(2 / 3, 3);
  });
  it('只写出现的键', () => {
    const r = mapOf({ SplitToningBalance: '+25' });
    expect(r.params.look.split_balance).toBeCloseTo(0.25, 6);
    expect(r.origins['look.split_shadow_hue']).toBeUndefined();
  });
});

/* ---------------- 颗粒 / 暗角 ---------------- */

describe('XMP 映射：Grain → grain.*', () => {
  it('Amount>0 只当开关；Size 锚定 LR25↔1.2‰H；Frequency→film_resolution（LR50↔0.5）', () => {
    const r = mapOf({ GrainAmount: '40', GrainSize: '60', GrainFrequency: '70' });
    expect(r.params.texture.grain.enabled).toBe(true);
    expect(r.params.texture.grain.size).toBeCloseTo(2.4, 6); /* 1.2×60/25=2.88 → 钳 2.4 */
    expect(r.params.texture.grain.film_resolution).toBeCloseTo(0.7, 6);
    expect(r.origins['grain.enabled']).toBe('estimated');
    expect(r.origins['grain.size']).toBe('estimated');
    expect(r.origins['grain.film_resolution']).toBe('estimated');
  });
  it('GrainSize=25 精确回到默认间距 1.2', () => {
    const r = mapOf({ GrainSize: '25' });
    expect(r.params.texture.grain.size).toBeCloseTo(1.2, 6);
  });
  it('amount=0 → 颗粒段完全不写（enabled 原样、无 origins）', () => {
    const r = mapOf({ GrainAmount: '0', GrainSize: '99' });
    /* 注意：Size 仍写（键存在即写），但 enabled 不写 */
    expect(r.origins['grain.enabled']).toBeUndefined();
    expect(r.params.texture.grain.enabled).toBe(true); /* 默认值原样 */
  });
});

describe('XMP 映射：PostCropVignette → vignette.*', () => {
  it('负值（压暗）→ enabled + amount + radius（Midpoint 50↔1.1）', () => {
    const r = mapOf({ PostCropVignetteAmount: '-30', PostCropVignetteMidpoint: '60' });
    expect(r.params.texture.vignette.enabled).toBe(true);
    expect(r.params.texture.vignette.amount).toBeCloseTo(0.18, 6);
    expect(r.params.texture.vignette.radius).toBeCloseTo(0.7 + 0.6 * 0.8, 6);
  });
  it('正值（提亮）→ 引擎不支持，warning 且不写任何 vignette 路径', () => {
    const r = mapOf({ PostCropVignetteAmount: '+25', PostCropVignetteMidpoint: '60' });
    expect(r.warnings.some((w) => w.includes('提亮'))).toBe(true);
    expect(r.origins['vignette.enabled']).toBeUndefined();
    expect(r.origins['vignette.amount']).toBeUndefined();
    expect(r.origins['vignette.radius']).toBeUndefined();
    expect(r.params.texture.vignette.enabled).toBe(false);
  });
  it('Midpoint 极值钳制在合法区间', () => {
    const lo = mapOf({ PostCropVignetteAmount: '-100', PostCropVignetteMidpoint: '0' });
    const hi = mapOf({ PostCropVignetteAmount: '-100', PostCropVignetteMidpoint: '100' });
    expect(lo.params.texture.vignette.radius).toBeGreaterThanOrEqual(0.8);
    expect(hi.params.texture.vignette.radius).toBeLessThanOrEqual(1.5);
    expect(lo.params.texture.vignette.amount).toBeLessThanOrEqual(0.5);
  });
});

/* ---------------- 全局色彩 / 黑白 ---------------- */

describe('XMP 映射：Saturation / IncrementalTemperature / 黑白转换', () => {
  it('Saturation ±方向：+30 → 1.3；−100 → 0', () => {
    expect(mapOf({ Saturation: '+30' }).params.look.saturation).toBeCloseTo(1.3, 6);
    expect(mapOf({ Saturation: '-100' }).params.look.saturation).toBeCloseTo(0, 6);
  });
  it('IncrementalTemperature 方向对齐（+ 暖 − 冷）', () => {
    const plus = mapOf({ IncrementalTemperature: '+40' }).params.look.warmth;
    const minus = mapOf({ IncrementalTemperature: '-40' }).params.look.warmth;
    expect(plus).toBeCloseTo(0.4, 6);
    expect(minus).toBeCloseTo(-0.4, 6);
    expect(plus).toBeGreaterThan(minus);
  });
  it('ConvertToGrayscale=True → 完全去色 + 警告', () => {
    const r = mapOf({ ConvertToGrayscale: 'True', GrayMixerRed: '-15', GrayMixerBlue: '+20' });
    expect(r.params.look.saturation).toBe(0);
    expect(r.warnings.some((w) => w.includes('黑白'))).toBe(true);
    expect(r.unmapped.some((u) => u.includes('GrayMixer'))).toBe(true);
  });
});

/* ---------------- 未映射维度（如实列出） ---------------- */

describe('XMP 映射：R18 HSL 8 色相 → look.hsl', () => {
  it('数值一一对应（±100 → ±1）；色相键一一对应；只写出现过的通道', () => {
    const r = mapOf({
      HueAdjustmentRed: '+10', SaturationAdjustmentRed: '-30', LuminanceAdjustmentRed: '+20',
      SaturationAdjustmentGreen: '-100', HueAdjustmentBlue: '100',
    });
    const look = r.params.look as unknown as { hsl?: Record<string, { hue: number; sat: number; lum: number }> };
    expect(look.hsl).toBeDefined();
    expect(look.hsl!.red).toEqual({ hue: 0.1, sat: -0.3, lum: 0.2 });
    expect(look.hsl!.green).toEqual({ hue: 0, sat: -1, lum: 0 });
    expect(look.hsl!.blue).toEqual({ hue: 1, sat: 0, lum: 0 });
    expect(look.hsl!.orange).toBeUndefined();
    expect(r.origins['look.hsl.red.hue']).toBe('estimated');
    expect(r.origins['look.hsl.green.sat']).toBe('estimated');
    expect(r.origins['look.hsl.blue.hue']).toBe('estimated');
    expect(r.origins['look.hsl.green.hue']).toBeUndefined();
  });
  it('HSL 8 色相不再列入 unmapped（R18 已接管）', () => {
    const r = mapOf({ HueAdjustmentRed: '+10', SaturationAdjustmentGreen: '-5', LuminanceAdjustmentBlue: '+3' });
    expect(r.unmapped.some((u) => u.includes('HSL'))).toBe(false);
  });
  it('HSL 全 0 / 缺省 → look.hsl 不出现（恒等）', () => {
    const r0 = mapOf({ HueAdjustmentRed: '0' });
    expect((r0.params.look as unknown as { hsl?: unknown }).hsl).toBeUndefined();
    const r1 = mapOf({ Saturation: '0' });
    expect((r1.params.look as unknown as { hsl?: unknown }).hsl).toBeUndefined();
  });
});

describe('XMP 映射：R18 Calibration.ShadowTint → split_shadow', () => {
  it('正（绿）→ hue=1/3、负（品红）→ hue=0.85；sat=|v|/100', () => {
    const g = mapOf({ ShadowTint: '+50' });
    const lg = g.params.look as unknown as Record<string, number>;
    expect(lg.split_shadow_hue).toBeCloseTo(1 / 3, 4);
    expect(lg.split_shadow_sat).toBe(0.5);
    expect(g.origins['look.split_shadow_hue']).toBe('estimated');
    const m = mapOf({ ShadowTint: '-25' });
    const lm = m.params.look as unknown as Record<string, number>;
    expect(lm.split_shadow_hue).toBe(0.85);
    expect(lm.split_shadow_sat).toBe(0.25);
  });
  it('SplitToning 显式值优先：两者同时出现时不写并警告；ShadowTint=0 不写', () => {
    const both = mapOf({ ShadowTint: '+40', SplitToningShadowHue: '30', SplitToningShadowSaturation: '50' });
    expect(both.warnings.some((w) => w.includes('ShadowTint'))).toBe(true);
    const look = both.params.look as unknown as Record<string, number>;
    expect(look.split_shadow_hue).toBeCloseTo(30 / 360, 4);
    const zero = mapOf({ ShadowTint: '0' });
    expect(zero.warnings.some((w) => w.includes('ShadowTint'))).toBe(false);
    expect(zero.origins['look.split_shadow_hue']).toBeUndefined();
  });
});

describe('XMP 映射：unmapped 清单', () => {
  it('Calibration 仅三原色 Hue·Saturation 列出（ShadowTint 已折入 split_shadow）', () => {
    const r = mapOf({ RedHue: '+10', BlueSaturation: '+25' });
    expect(r.unmapped.some((u) => u.includes('Calibration') && u.includes('2 项'))).toBe(true);
    const st = mapOf({ ShadowTint: '+20' });
    expect(st.unmapped.some((u) => u.includes('Calibration'))).toBe(false);
  });
  it('Exposure / Vibrance / IncrementalTint / RGB 曲线 / Feather 各自列出', () => {
    const r = mapOf(
      { Exposure2012: '+0.5', Vibrance: '+10', IncrementalTint: '-4', PostCropVignetteFeather: '55' },
      ['   <crs:ToneCurvePV2012Red><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>255, 250</rdf:li></rdf:Seq></crs:ToneCurvePV2012Red>'],
    );
    expect(r.unmapped.some((u) => u.includes('Exposure2012'))).toBe(true);
    expect(r.unmapped.some((u) => u.includes('Vibrance'))).toBe(true);
    expect(r.unmapped.some((u) => u.includes('IncrementalTint'))).toBe(true);
    expect(r.unmapped.some((u) => u.includes('ToneCurvePV2012Red'))).toBe(true);
    expect(r.unmapped.some((u) => u.includes('Feather'))).toBe(true);
  });
  it('恒等 RGB 曲线不进 unmapped', () => {
    const r = mapOf({}, [
      '   <crs:ToneCurvePV2012Red><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012Red>',
    ]);
    expect(r.unmapped.some((u) => u.includes('ToneCurvePV2012Red'))).toBe(false);
  });
  it('未识别 crs 键 → warning 提示', () => {
    const r = mapOf({ SomeBrandNewSlider: '+7', AnotherOne: '0' });
    expect(r.warnings.some((w) => w.includes('未识别') && w.includes('2'))).toBe(true);
  });
});

/* ---------------- 区间合法性遍历 ---------------- */

describe('XMP 映射：写出值区间合法性', () => {
  const RANGES: Record<string, [number, number]> = {
    'look.fade': [0, 1],
    'look.black_lift': [0, 1],
    'look.film_s': [0, 1],
    'look.contrast': [0, 1],
    'look.saturation': [0, 2],
    'look.warmth': [-1, 1],
    'look.split_shadow_hue': [0, 1],
    'look.split_shadow_sat': [0, 1],
    'look.split_highlight_hue': [0, 1],
    'look.split_highlight_sat': [0, 1],
    'look.split_balance': [-1, 1],
    'grain.size': [0.5, 2.4],
    'grain.film_resolution': [0, 1],
    'vignette.amount': [0, 0.5],
    'vignette.radius': [0.8, 1.5],
  };

  const EXTREME_CURVE =
    '   <crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 200</rdf:li><rdf:li>128, 30</rdf:li><rdf:li>255, 250</rdf:li></rdf:Seq></crs:ToneCurvePV2012>';

  function extremeAttrs(v: number): Record<string, string> {
    return {
      Contrast2012: String(v),
      Highlights2012: String(v),
      Shadows2012: String(v),
      Whites2012: String(v),
      Blacks2012: String(v),
      ParametricShadows: String(v),
      ParametricDarks: String(v),
      ParametricLights: String(v),
      ParametricHighlights: String(v),
      SplitToningShadowHue: v >= 0 ? '360' : '0',
      SplitToningShadowSaturation: '100',
      SplitToningHighlightHue: v >= 0 ? '0' : '360',
      SplitToningHighlightSaturation: '100',
      SplitToningBalance: String(v),
      GrainAmount: '100',
      GrainSize: v >= 0 ? '100' : '0',
      GrainFrequency: v >= 0 ? '100' : '0',
      PostCropVignetteAmount: v >= 0 ? '+100' : '-100',
      PostCropVignetteMidpoint: v >= 0 ? '0' : '100',
      Saturation: String(v),
      IncrementalTemperature: String(v),
    };
  }

  it('极端输入（+100 / −100 / 恒等混合）下所有写出值落在既有参数合法区间', () => {
    for (const v of [100, -100, 0]) {
      const r = mapOf(extremeAttrs(v), [EXTREME_CURVE]);
      for (const [path, range] of Object.entries(RANGES)) {
        if (r.origins[path] === undefined) continue;
        const val = getByPath(r.params, path);
        expect(typeof val).toBe('number');
        expect(val as number).toBeGreaterThanOrEqual(range[0]);
        expect(val as number).toBeLessThanOrEqual(range[1]);
      }
      /* 布尔路径类型正确 */
      for (const p of ['grain.enabled', 'vignette.enabled']) {
        if (r.origins[p] !== undefined) expect(typeof getByPath(r.params, p)).toBe('boolean');
      }
      /* look 全键整体不超过引擎钳制域（防御未来新增写入路径） */
      for (const k of LOOK_KEYS) {
        const val = r.params.look[k];
        expect(val).toBeGreaterThanOrEqual(k === 'saturation' ? 0 : k === 'warmth' || k === 'split_balance' ? -1 : -0.001);
        expect(val).toBeLessThanOrEqual(k === 'saturation' ? 2 : 1.001);
      }
    }
  });
});

/* ---------------- cleanCardName / BRAND_WORDS ---------------- */

describe('XMP 映射：cleanCardName 品牌词清洗', () => {
  it('BRAND_WORDS 覆盖规格要求的词表', () => {
    for (const w of ['Kodak', 'Portra', 'Ektar', 'CineStill', 'Vision3', 'Dehancer', 'Exposure', 'RNI', 'Fuji', 'Velvia', '5207', '5219']) {
      expect(BRAND_WORDS).toContain(w);
    }
  });
  it('去除扩展名 + 大小写不敏感清洗品牌词', () => {
    expect(cleanCardName('02 - Kodak Film Sx2.xmp')).toBe('02 Film Sx2');
    expect(cleanCardName('KODAK Portra 400.XMP')).toBe('400');
    expect(cleanCardName('RNI All Films 5.xmp')).toBe('All Films 5');
    expect(cleanCardName('CineStill 800T.xmp')).toBe('导入预设');
    expect(cleanCardName('Dehancer Pro v2.xmp')).toBe('Pro v2');
  });
  it('连写复合词也清洗（ExposureX7 / [RL] 空括号）', () => {
    expect(cleanCardName('ExposureX7 pack.xmp')).toBe('X7 pack');
    expect(cleanCardName('[RL] Pro _ Afterglow III.xmp')).toBe('Pro Afterglow III');
  });
  it('无品牌词文件名原样保留（含中文）', () => {
    expect(cleanCardName('日常胶片 28.xmp')).toBe('日常胶片 28');
    expect(cleanCardName('Ro-03 N')).toBe('Ro-03 N');
    expect(cleanCardName('72.xmp')).toBe('72');
  });
  it('空白与分隔符收敛；全清洗后回退「导入预设」', () => {
    expect(cleanCardName('A   B ___  C.xmp')).toBe('A B C');
    expect(cleanCardName('  Fuji   Velvia  .xmp')).toBe('导入预设');
    expect(cleanCardName('.xmp')).toBe('导入预设');
  });
});

/* ---------------- curveToFn 供映射侧的契约 ---------------- */

describe('XMP 映射：曲线求值契约', () => {
  it('curveToFn 与映射使用同一归一口径（0..1 出入）', () => {
    const f = curveToFn([{ x: 0, y: 0 }, { x: 128, y: 118 }, { x: 255, y: 255 }])!;
    expect(f(128 / 255)).toBeCloseTo(118 / 255, 6);
    expect(f(0.5)).toBeCloseTo((118 * 127.5 / 128) / 255, 6); /* 0.5×255=127.5 落在首段插值内 */
  });
});
