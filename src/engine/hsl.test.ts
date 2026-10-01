/**
 * R18 · HSL 8 色相（可选维度）验收测试。
 *
 * 语义（单一真源 engine/look.ts；GLSL GRADE_FS 逐式镜像，一致性由 lookshader.test 覆盖）：
 *   - 8 窄带色相（LR 色相轮：红 0°/橙 30°/黄 60°/绿 120°/青 180°/蓝 240°/紫 280°/品红 320°）；
 *   - hue ±1 → ±30°（LR 满量程）、sat ±1 → 饱和 ×(1±0.75)、lum ±1 → 明度 ×(1±0.30)；
 *   - 权重按色相圆距平滑衰减（CORE 15°..EDGE 45°）后归一，方向与 LR 一致（正 = 顺时针）；
 * 护栏：缺省 / 全 0 → 逐位恒等（不做 HSV 往返）；值域钳制；恒等不破（中性配方输出不变）。
 */
import { describe, expect, it } from 'vitest';
import {
  hslAdjustRgb, hslBandWeight, hslIsIdentity, hsvToRgb, lookTransform, rgbToHsv,
  HSL_BAND_CENTERS, HSL_CORE, HSL_EDGE, HSL_HUE_SCALE, HSL_HUES,
  NEUTRAL_LOOK, type HslAdjustments, type HslChannel,
} from './look';
import { defaultParams } from '../film/params';

const ch = (hue = 0, sat = 0, lum = 0): HslChannel => ({ hue, sat, lum });
const hslOf = (key: keyof HslAdjustments, c: HslChannel): Partial<HslAdjustments> => ({ [key]: c });

describe('R18 HSL：恒等护栏', () => {
  it('hsl 缺省 → lookTransform 严格恒等（与 NEUTRAL_LOOK 输出逐位一致）', () => {
    const f = lookTransform(NEUTRAL_LOOK);
    for (const c of [[0, 0, 0], [0.2, 0.5, 0.8], [1, 0.3, 0]] as const) {
      expect(f([...c])).toEqual([c[0], c[1], c[2]]);
    }
  });

  it('hsl 存在但全 0 → 逐位恒等（跳过 HSV 往返）；hslIsIdentity 判定正确', () => {
    const zero: Partial<HslAdjustments> = Object.fromEntries(HSL_HUES.map((h) => [h, ch()])) as Partial<HslAdjustments>;
    expect(hslIsIdentity(zero)).toBe(true);
    expect(hslIsIdentity(undefined)).toBe(true);
    expect(hslIsIdentity({ red: ch(0.1) })).toBe(false);
    const L = { ...NEUTRAL_LOOK, hsl: zero };
    const f = lookTransform(L);
    for (const c of [[0.2, 0.5, 0.8], [0.9, 0.3, 0.1]] as const) {
      expect(f([...c])).toEqual([c[0], c[1], c[2]]);
    }
  });

  it('部分通道缺失按 0 处理；远带色相不受调整（权重归一后仍集中）', () => {
    /* 只调红带：蓝入（h≈0.667）在蓝带中心、红带权重为 0 → 输出不变 */
    const out = hslAdjustRgb(hsvToRgb(2 / 3, 1, 0.5), { red: ch(1, 1, 1) });
    expect(out[0]).toBeCloseTo(hsvToRgb(2 / 3, 1, 0.5)[0], 12);
  });
});

describe('R18 HSL：方向与量纲（LR 语义近似）', () => {
  it('红带 hue 正 → 红→橙（G 上升）；hue 负 → 红→品红（B 上升）', () => {
    const red = hsvToRgb(0, 1, 0.8);
    const plus = hslAdjustRgb(red, { red: ch(1) });
    const minus = hslAdjustRgb(red, { red: ch(-1) });
    expect(plus[1]).toBeGreaterThan(red[1] + 0.2);   // 向橙（黄绿方向）
    expect(minus[2]).toBeGreaterThan(red[2] + 0.2);  // 向品红
    /* 色相角：+30° → 1/12（橙向）；−30° → 330°（品红向） */
    expect(rgbToHsv(plus[0], plus[1], plus[2])[0]).toBeCloseTo(1 / 12, 3);
    expect(rgbToHsv(minus[0], minus[1], minus[2])[0]).toBeCloseTo(11 / 12, 3);
  });

  it('色相偏移满量程 = ±30°（HSL_HUE_SCALE）', () => {
    const red = hsvToRgb(0, 1, 0.8);
    const plus = hslAdjustRgb(red, { red: ch(1) });
    const [h1] = rgbToHsv(plus[0], plus[1], plus[2]);
    expect(h1).toBeCloseTo(HSL_HUE_SCALE, 3);
  });

  it('sat 正 → 更饱和（通道间差异放大）；sat 负 → 趋灰', () => {
    const red = hsvToRgb(0, 0.6, 0.8);
    const up = hslAdjustRgb(red, { red: ch(0, 1) });
    const down = hslAdjustRgb(red, { red: ch(0, -1) });
    const satOf = (c: number[]): number => rgbToHsv(c[0], c[1], c[2])[1];
    expect(satOf(up)).toBeGreaterThan(satOf(red));
    expect(satOf(down)).toBeLessThan(satOf(red));
    expect(satOf(up)).toBeCloseTo(Math.min(1, 0.6 * 1.75), 3);
    expect(satOf(down)).toBeCloseTo(0.6 * 0.25, 3);
  });

  it('lum 正 → 明度抬升；lum 负 → 压暗（量纲 ×(1±0.30)）', () => {
    const red = hsvToRgb(0, 1, 0.5);
    const up = hslAdjustRgb(red, { red: ch(0, 0, 1) });
    const down = hslAdjustRgb(red, { red: ch(0, 0, -1) });
    expect(rgbToHsv(up[0], up[1], up[2])[2]).toBeCloseTo(0.5 * 1.3, 3);
    expect(rgbToHsv(down[0], down[1], down[2])[2]).toBeCloseTo(0.5 * 0.7, 3);
  });

  it('相邻带平滑过渡（橙与红之间各占一半权重）；全轮无死区', () => {
    /* 15°（红/橙正中）：两带各 1.0 权重 → hue 满量程时各贡献一半 → 总偏移仍为 ±30°/2×2 */
    const w = hslBandWeight(1 / 24, 0);
    expect(w).toBe(1);
    /* 相邻带中心间距 ≥ 30° 且 EDGE=45° → 任意 hue 至少落在一个带内（权重和 > 0） */
    for (let i = 0; i < 360; i += 3) {
      const h = i / 360;
      const sum = HSL_BAND_CENTERS.reduce((acc, c) => acc + hslBandWeight(h, c), 0);
      expect(sum, `hue ${i}°`).toBeGreaterThan(0);
    }
  });

  it('灰（s=0）不受 hue/sat 影响、lum 仍生效', () => {
    const gray = [0.5, 0.5, 0.5];
    expect(hslAdjustRgb(gray, { red: ch(1, 1) }).every((v, i) => v === gray[i])).toBe(true);
    const lit = hslAdjustRgb(gray, { red: ch(0, 0, 1) });
    expect(lit[0]).toBeGreaterThan(0.5);
  });

  it('输出恒在 0..1；值域钳制（hue/sat/lum 输入越界不产生越界输出）', () => {
    for (const hue of HSL_HUES) {
      for (const v of [ch(5, 5, 5), ch(-5, -5, -5)]) {
        const out = hslAdjustRgb([0.9, 0.2, 0.1], { [hue]: v });
        for (const x of out) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('rgbToHsv/hsvToRgb 互逆；带中心与 LR 色相轮一致', () => {
    for (const [r, g, b] of [[0.9, 0.2, 0.1], [0.1, 0.8, 0.3], [0.4, 0.4, 0.9]] as const) {
      const [h, s, v] = rgbToHsv(r, g, b);
      const back = hsvToRgb(h, s, v);
      expect(back[0]).toBeCloseTo(r, 12);
      expect(back[1]).toBeCloseTo(g, 12);
      expect(back[2]).toBeCloseTo(b, 12);
    }
    expect(HSL_BAND_CENTERS).toEqual([0, 1 / 12, 1 / 6, 1 / 3, 0.5, 2 / 3, 7 / 9, 8 / 9]);
    expect(HSL_CORE).toBeCloseTo(15 / 360, 12);
    expect(HSL_EDGE).toBeCloseTo(45 / 360, 12);
  });
});

describe('R18 HSL：管线接入', () => {
  it('HSL 只改色彩维度：brightness 阶层（fade/saturation/warmth）仍在 HSL 之后生效', () => {
    /* 带 HSL 的 look 在饱和度=0（黑白）时：hue/sat 无效化，但 lum 的亮度贡献保留 */
    const L = { ...NEUTRAL_LOOK, saturation: 0, hsl: { red: ch(0.5, 0.5, 0.8) } };
    const f = lookTransform(L);
    const redIn = hsvToRgb(0, 1, 0.6);
    const blueIn = hsvToRgb(2 / 3, 1, 0.6);
    const outRed = f(redIn);
    const outBlue = f(blueIn);
    /* 红入被 lum 抬亮（luma 更高），蓝入不受影响 → 两者亮度不同（黑白下仍可见） */
    const luma = (c: number[]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    expect(luma(outRed)).toBeGreaterThan(luma(outBlue));
  });

  it('恒等不破：defaultParams()（无 hsl/coupling）的全卡渲染与 NEUTRAL 逐位一致', () => {
    const f = lookTransform(defaultParams().look as never);
    const g = lookTransform(NEUTRAL_LOOK);
    for (const c of [[0.2, 0.5, 0.8], [0.9, 0.3, 0.1], [0, 0, 0], [1, 1, 1]] as const) {
      expect(f([...c])).toEqual(g([...c]));
    }
  });
});
