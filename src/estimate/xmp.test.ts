/**
 * XMP 解析器（estimate/xmp.ts）验收测试。
 * 全部 fixture 为手工合成的结构样本（键形态模仿 LR/ACR 预设，数值自编），
 * 不含任何真实预设内容（合规红线）。
 */
import { describe, expect, it } from 'vitest';
import { curveToFn, parseXmp, type XmpIR } from './xmp';

/** 合成 XMP 文档包装：attrs = crs:Key → 原始字符串值；elements = 附加的元素式子块 */
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

const NAME_ELEMENT = `   <crs:Name>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">合成测试预设</rdf:li>
    </rdf:Alt>
   </crs:Name>`;

/* ---------------- 属性式 ---------------- */

const ATTR_FIXTURE = wrap({
  PresetType: 'Normal',
  UUID: 'A1B2C3D4E5F60718293A4B5C6D7E8F90',
  Version: '12.4',
  ProcessVersion: '11.0',
  CameraProfile: 'Adobe Standard',
  Exposure2012: '+0.5',
  Contrast2012: '+15',
  Highlights2012: '-20',
  Shadows2012: '+30',
  Whites2012: '+5',
  Blacks2012: '-10',
  ParametricShadows: '+10',
  ParametricDarks: '0',
  ParametricLights: '-5',
  ParametricHighlights: '+8',
  ParametricShadowSplit: '14',
  ParametricMidtoneSplit: '60',
  ParametricHighlightSplit: '75',
  SplitToningShadowHue: '42',
  SplitToningShadowSaturation: '60',
  SplitToningHighlightHue: '210',
  SplitToningHighlightSaturation: '50',
  SplitToningBalance: '-15',
  GrainAmount: '40',
  GrainSize: '60',
  GrainFrequency: '70',
  GrainSeed: '1234',
  PostCropVignetteAmount: '-30',
  PostCropVignetteMidpoint: '60',
  PostCropVignetteFeather: '55',
  Saturation: '+5',
  Vibrance: '0',
  IncrementalTemperature: '12',
  IncrementalTint: '-4',
  HueAdjustmentRed: '+12',
  SaturationAdjustmentRed: '-10',
  LuminanceAdjustmentRed: '-20',
  HueAdjustmentBlue: '+5',
  SaturationAdjustmentBlue: '0',
  LuminanceAdjustmentBlue: '-10',
  ShadowTint: '+5',
  RedHue: '+10',
  RedSaturation: '+5',
  GreenHue: '-10',
  GreenSaturation: '-10',
  BlueHue: '-15',
  BlueSaturation: '+25',
  SomeUnknownSlider: '+3',
}, [NAME_ELEMENT]);

describe('XMP 解析器：属性式方言', () => {
  let ir: XmpIR;
  it('解析成功且键数/名称/版本正确', () => {
    ir = parseXmp(ATTR_FIXTURE);
    expect(ir.name).toBe('合成测试预设');
    expect(ir.processVersion).toBe('11.0');
    expect(ir.cameraProfile).toBe('Adobe Standard');
    expect(ir.keyCount).toBe(Object.keys({
      PresetType: 1, UUID: 1, Version: 1, ProcessVersion: 1, CameraProfile: 1,
      Exposure2012: 1, Contrast2012: 1, Highlights2012: 1, Shadows2012: 1, Whites2012: 1, Blacks2012: 1,
      ParametricShadows: 1, ParametricDarks: 1, ParametricLights: 1, ParametricHighlights: 1,
      ParametricShadowSplit: 1, ParametricMidtoneSplit: 1, ParametricHighlightSplit: 1,
      SplitToningShadowHue: 1, SplitToningShadowSaturation: 1, SplitToningHighlightHue: 1,
      SplitToningHighlightSaturation: 1, SplitToningBalance: 1,
      GrainAmount: 1, GrainSize: 1, GrainFrequency: 1, GrainSeed: 1,
      PostCropVignetteAmount: 1, PostCropVignetteMidpoint: 1, PostCropVignetteFeather: 1,
      Saturation: 1, Vibrance: 1, IncrementalTemperature: 1, IncrementalTint: 1,
      HueAdjustmentRed: 1, SaturationAdjustmentRed: 1, LuminanceAdjustmentRed: 1,
      HueAdjustmentBlue: 1, SaturationAdjustmentBlue: 1, LuminanceAdjustmentBlue: 1,
      ShadowTint: 1, RedHue: 1, RedSaturation: 1, GreenHue: 1, GreenSaturation: 1, BlueHue: 1, BlueSaturation: 1,
      SomeUnknownSlider: 1, Name: 1,
    }).length);
  });
  it('基础影调/参数曲线/分区滑杆全部数值化（+/− 前缀正确处理）', () => {
    expect(ir.exposure2012).toBe(0.5);
    expect(ir.contrast2012).toBe(15);
    expect(ir.highlights2012).toBe(-20);
    expect(ir.shadows2012).toBe(30);
    expect(ir.whites2012).toBe(5);
    expect(ir.blacks2012).toBe(-10);
    expect(ir.parametricShadows).toBe(10);
    expect(ir.parametricDarks).toBe(0);
    expect(ir.parametricLights).toBe(-5);
    expect(ir.parametricHighlights).toBe(8);
    expect(ir.parametricShadowSplit).toBe(14);
    expect(ir.parametricMidtoneSplit).toBe(60);
    expect(ir.parametricHighlightSplit).toBe(75);
  });
  it('分离色调五键/颗粒四键/暗角三键/全局色四键', () => {
    expect(ir.splitToningShadowHue).toBe(42);
    expect(ir.splitToningShadowSaturation).toBe(60);
    expect(ir.splitToningHighlightHue).toBe(210);
    expect(ir.splitToningHighlightSaturation).toBe(50);
    expect(ir.splitToningBalance).toBe(-15);
    expect(ir.grainAmount).toBe(40);
    expect(ir.grainSize).toBe(60);
    expect(ir.grainFrequency).toBe(70);
    expect(ir.grainSeed).toBe(1234);
    expect(ir.postCropVignetteAmount).toBe(-30);
    expect(ir.postCropVignetteMidpoint).toBe(60);
    expect(ir.postCropVignetteFeather).toBe(55);
    expect(ir.saturation).toBe(5);
    expect(ir.vibrance).toBe(0);
    expect(ir.incrementalTemperature).toBe(12);
    expect(ir.incrementalTint).toBe(-4);
  });
  it('HSL 8 色相结构：已写色相有值、未写色相为空对象', () => {
    expect(ir.hsl.red).toEqual({ hue: 12, saturation: -10, luminance: -20 });
    expect(ir.hsl.blue).toEqual({ hue: 5, saturation: 0, luminance: -10 });
    expect(ir.hsl.orange).toEqual({});
    expect(ir.hsl.magenta).toEqual({});
  });
  it('Calibration 七键', () => {
    expect(ir.calibration).toEqual({
      shadowTint: 5, redHue: 10, redSaturation: 5,
      greenHue: -10, greenSaturation: -10, blueHue: -15, blueSaturation: 25,
    });
  });
  it('未识别键显式计数；元数据键不进未识别', () => {
    expect(ir.unrecognizedKeys).toEqual(['SomeUnknownSlider']);
    expect(ir.unrecognizedKeys).not.toContain('UUID');
    expect(ir.unrecognizedKeys).not.toContain('PresetType');
  });
  it('原始字符串保真（raw）', () => {
    expect(ir.raw.Exposure2012).toBe('+0.5');
    expect(ir.raw.SomeUnknownSlider).toBe('+3');
  });
  it('空字符串值 → 键存在但无数值（absent 语义）', () => {
    const ir2 = parseXmp(wrap({ GrainAmount: '', Contrast2012: '' }));
    expect(ir2.grainAmount).toBeUndefined();
    expect(ir2.contrast2012).toBeUndefined();
  });
  it('单引号属性可正常取值', () => {
    const text = wrap({ Exposure2012: '+0.5' }).replace('crs:Exposure2012="+0.5"', "crs:Exposure2012='+0.5'");
    expect(parseXmp(text).exposure2012).toBe(0.5);
  });
  it('属性值内换行容忍（曲线属性跨行）', () => {
    const text = wrap({ ToneCurvePV2012: '0, 0,\n  128, 118,\n  255, 255' });
    const ir4 = parseXmp(text);
    expect(ir4.toneCurvePV2012).toEqual([
      { x: 0, y: 0 }, { x: 128, y: 118 }, { x: 255, y: 255 },
    ]);
  });
});

/* ---------------- 元素式 / 混合式 ---------------- */

const CURVE_ELEMENTS = [
  `   <crs:ToneCurvePV2012>
    <rdf:Seq>
     <rdf:li>0, 0</rdf:li>
     <rdf:li>64, 52</rdf:li>
     <rdf:li>128, 118</rdf:li>
     <rdf:li>255, 255</rdf:li>
    </rdf:Seq>
   </crs:ToneCurvePV2012>`,
  `   <crs:ToneCurvePV2012Red>
    <rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>255, 250</rdf:li></rdf:Seq>
   </crs:ToneCurvePV2012Red>`,
  `   <crs:ToneCurvePV2012Green>
    <rdf:Seq><rdf:li>0, 4</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq>
   </crs:ToneCurvePV2012Green>`,
  `   <crs:ToneCurvePV2012Blue>
    <rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>255, 245</rdf:li></rdf:Seq>
   </crs:ToneCurvePV2012Blue>`,
  `   <crs:ToneCurveName2012>Custom</crs:ToneCurveName2012>`,
];

const MULTI_LANG_NAME = `   <crs:Name>
    <rdf:Alt>
     <rdf:li xml:lang="fr">Nom de test</rdf:li>
     <rdf:li xml:lang="x-default">默认名称</rdf:li>
    </rdf:Alt>
   </crs:Name>`;

describe('XMP 解析器：元素式方言与混合', () => {
  it('rdf:Seq 点列 → 曲线点数组；RGB 三条曲线各自解析', () => {
    const ir = parseXmp(wrap({ ProcessVersion: '15.0' }, [...CURVE_ELEMENTS, MULTI_LANG_NAME]));
    expect(ir.toneCurvePV2012).toEqual([
      { x: 0, y: 0 }, { x: 64, y: 52 }, { x: 128, y: 118 }, { x: 255, y: 255 },
    ]);
    expect(ir.toneCurvePV2012Red).toEqual([{ x: 0, y: 0 }, { x: 255, y: 250 }]);
    expect(ir.toneCurvePV2012Green).toEqual([{ x: 0, y: 4 }, { x: 255, y: 255 }]);
    expect(ir.toneCurvePV2012Blue).toEqual([{ x: 0, y: 0 }, { x: 255, y: 245 }]);
    expect(ir.name).toBe('默认名称');
  });
  it('混合式：元素式覆盖同名属性式', () => {
    const text = wrap(
      { ToneCurvePV2012: '0, 0, 255, 255', Exposure2012: '+1' },
      [CURVE_ELEMENTS[0]],
    );
    const ir = parseXmp(text);
    expect(ir.toneCurvePV2012).toEqual([
      { x: 0, y: 0 }, { x: 64, y: 52 }, { x: 128, y: 118 }, { x: 255, y: 255 },
    ]);
    expect(ir.exposure2012).toBe(1);
  });
  it('属性式扁平点列（同串多对数字）', () => {
    const ir = parseXmp(wrap({ ToneCurvePV2012: '0, 0, 64, 40, 192, 220, 255, 255' }));
    expect(ir.toneCurvePV2012).toEqual([
      { x: 0, y: 0 }, { x: 64, y: 40 }, { x: 192, y: 220 }, { x: 255, y: 255 },
    ]);
  });
  it('不成对的尾部数字被丢弃', () => {
    const ir = parseXmp(wrap({ ToneCurvePV2012: '0, 0, 128, 118, 255' }));
    expect(ir.toneCurvePV2012).toEqual([{ x: 0, y: 0 }, { x: 128, y: 118 }]);
  });
  it('已知曲线名等元数据键不进未识别', () => {
    const ir = parseXmp(wrap({ ProcessVersion: '15.0' }, CURVE_ELEMENTS));
    expect(ir.unrecognizedKeys).toEqual([]);
  });
});

/* ---------------- curveToFn ---------------- */

describe('XMP 解析器：curveToFn 求值', () => {
  it('线性插值 + 0..1 归一 + 端点外钳制', () => {
    const f = curveToFn([{ x: 0, y: 0 }, { x: 128, y: 118 }, { x: 255, y: 255 }])!;
    expect(f(0)).toBeCloseTo(0, 6);
    expect(f(128 / 255)).toBeCloseTo(118 / 255, 6);
    expect(f(1)).toBeCloseTo(1, 6);
    expect(f(-0.5)).toBeCloseTo(0, 6);
    expect(f(1.5)).toBeCloseTo(1, 6);
    /* 点列未覆盖 0 起点时按首末点域钳制 */
    const g = curveToFn([{ x: 64, y: 80 }, { x: 255, y: 255 }])!;
    expect(g(0)).toBeCloseTo(80 / 255, 6);
  });
  it('点列不足或 x 全等 → null', () => {
    expect(curveToFn([])).toBeNull();
    expect(curveToFn([{ x: 0, y: 0 }])).toBeNull();
    expect(curveToFn([{ x: 128, y: 10 }, { x: 128, y: 99 }])).toBeNull();
  });
  it('乱序点列自动按 x 排序', () => {
    const f = curveToFn([{ x: 255, y: 255 }, { x: 0, y: 0 }])!;
    expect(f(0.5)).toBeCloseTo(0.5, 6);
  });
});

/* ---------------- 可读错误 ---------------- */

describe('XMP 解析器：可读错误', () => {
  it('空输入 → 「输入为空」', () => {
    expect(() => parseXmp('')).toThrow(/为空/);
    expect(() => parseXmp('   \n  ')).toThrow(/为空/);
  });
  it('非 XMP 文本 → 「不是 XMP 文本」', () => {
    expect(() => parseXmp('随便一段普通文本，不是 XML')).toThrow(/不是 XMP 文本/);
  });
  it('标签不配对 → 「疑似损坏」', () => {
    const broken = `<?xpacket begin="" id="X"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description crs:Exposure2012="+1" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/">
 </x:xmpmeta>`;
    expect(() => parseXmp(broken)).toThrow(/疑似损坏/);
  });
  it('未闭合标签 → 「疑似损坏」', () => {
    const broken = `<?xpacket begin="" id="X"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description crs:Exposure2012="+1" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/">
</rdf:Description>`;
    expect(() => parseXmp(broken)).toThrow(/疑似损坏/);
  });
  it('闭合名错配 → 「疑似损坏」', () => {
    const broken = `<?xpacket begin="" id="X"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description crs:Exposure2012="+1" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/">
  </rdf:Description>
 </rdf:RDF>
</rdf:RDF>`;
    expect(() => parseXmp(broken)).toThrow(/疑似损坏/);
  });
  it('合法 XML 但无 crs 键 → 「不是相机原始预设」', () => {
    const noCrs = `<?xpacket begin="" id="X"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" dc:title="Photo">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
    expect(() => parseXmp(noCrs)).toThrow(/不是相机原始|预设/);
  });
});
