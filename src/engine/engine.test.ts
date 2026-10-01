/**
 * 色彩引擎验收测试。
 * 测试数据全部代码合成（渐变 + 色卡 + 肤色块 + 抖动），不使用外部图片。
 * 覆盖：恒等性 / 收敛性 / 肤色保护 / LUT 保真 / .cube 回环 / 单调性 / 性能。
 */
import { describe, expect, it } from 'vitest';
import { deltaE76, rgbToLab } from './color';
import { buildTransform } from './match';
import { applyLUT, bakeLUT, parseCube, toCube } from './lut';
import { analyzeImage, ImageStats, withSource } from './stats';
import { MatchParams, NEUTRAL_PARAMS, RGB } from './types';

/* ---------------- 测试工具 ---------------- */

/** 可复现伪随机（mulberry32） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIZE = 256;
const PATCH = 34;
const GAP = 62;
const ORIGIN = 14;

// 色块：肤色两块 + 高饱和色卡 + 黑白灰，铺满画面上 2/3，下方保留亮度渐变
const PATCHES: Array<{ rgb: [number, number, number]; skin?: boolean }> = [
  { rgb: [230, 180, 150], skin: true },
  { rgb: [205, 130, 100] },
  { rgb: [198, 60, 52] },
  { rgb: [72, 158, 82] },
  { rgb: [58, 92, 198] },
  { rgb: [222, 202, 92] },
  { rgb: [92, 190, 188] },
  { rgb: [178, 100, 172] },
  { rgb: [238, 238, 238] },
  { rgb: [16, 16, 20] },
  { rgb: [128, 128, 128] },
  { rgb: [244, 158, 62] },
];

interface Scene {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** 合成场景：对角亮度渐变打底（暗->亮）+ 12 块带抖动的色块 */
function makeScene(): Scene {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  const rng = mulberry32(1234);
  for (let y = 0; y < SIZE; y++) {
    const t = y / (SIZE - 1);
    const v = 0.04 + 0.92 * t;
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      data[i] = Math.round(v * 255);
      data[i + 1] = Math.round(v * 0.97 * 255);
      data[i + 2] = Math.round(v * 0.9 * 255);
      data[i + 3] = 255;
    }
  }
  PATCHES.forEach((p, pi) => {
    const x0 = ORIGIN + (pi % 4) * GAP;
    const y0 = ORIGIN + Math.floor(pi / 4) * GAP;
    const jitter = p.skin ? 12 : 8;
    for (let y = y0; y < y0 + PATCH; y++) {
      for (let x = x0; x < x0 + PATCH; x++) {
        const i = (y * SIZE + x) * 4;
        data[i] = p.rgb[0] + (rng() - 0.5) * 2 * jitter;
        data[i + 1] = p.rgb[1] + (rng() - 0.5) * 2 * jitter;
        data[i + 2] = p.rgb[2] + (rng() - 0.5) * 2 * jitter;
      }
    }
  });
  return { data, width: SIZE, height: SIZE };
}

/** 肤色主块矩形（x0,y0,x1,y1），与 PATCHES[0] 对应 */
const SKIN_RECT = {
  x0: ORIGIN,
  y0: ORIGIN,
  x1: ORIGIN + PATCH,
  y1: ORIGIN + PATCH,
};

/** 对整图应用逐像素变换，返回新图 */
function applyFnToImage(fn: (rgb: RGB) => RGB, scene: Scene): Scene {
  const out = new Uint8ClampedArray(scene.data.length);
  const rgb: RGB = [0, 0, 0];
  for (let i = 0; i < scene.data.length; i += 4) {
    rgb[0] = scene.data[i] / 255;
    rgb[1] = scene.data[i + 1] / 255;
    rgb[2] = scene.data[i + 2] / 255;
    const o = fn(rgb);
    out[i] = Math.round(o[0] * 255);
    out[i + 1] = Math.round(o[1] * 255);
    out[i + 2] = Math.round(o[2] * 255);
    out[i + 3] = 255;
  }
  return { data: out, width: scene.width, height: scene.height };
}

function randPoints(n: number, rng: () => number): RGB[] {
  const pts: RGB[] = [];
  for (let i = 0; i < n; i++) {
    pts.push([rng(), rng(), rng()]);
  }
  return pts;
}

function de76(a: RGB, b: RGB): number {
  const l1 = rgbToLab(a[0], a[1], a[2]);
  const l2 = rgbToLab(b[0], b[1], b[2]);
  return deltaE76(l1[0], l1[1], l1[2], l2[0], l2[1], l2[2]);
}

/**
 * 收敛性度量：Lab 统计加权距离。
 * 覆盖引擎显式对齐的量：分区 L 均值/标准差 + 全局 L/a/b 均值。
 * 分母仅作量纲归一（判据是比值，不受缩放影响）。
 */
function statsDistance(a: ImageStats, b: ImageStats): number {
  const sq = (v: number) => v * v;
  let sum = 0;
  for (const z of ['shadow', 'mid', 'high'] as const) {
    sum += sq((a.zones[z].mean[0] - b.zones[z].mean[0]) / 15);
    sum += sq(
      (Math.sqrt(a.zones[z].variance[0]) - Math.sqrt(b.zones[z].variance[0])) / 15,
    );
  }
  sum += sq((a.global.mean[0] - b.global.mean[0]) / 15);
  sum += sq((a.global.mean[1] - b.global.mean[1]) / 8);
  sum += sq((a.global.mean[2] - b.global.mean[2]) / 8);
  return Math.sqrt(sum);
}

/** 已知变换 A：tone（提黑位、压高光）+ 暖色偏 —— 收敛性用 */
const knownK = (rgb: RGB): RGB => {
  const tone = (v: number) => 0.06 + 0.88 * Math.pow(v, 1.15);
  return [
    Math.min(1, tone(rgb[0]) + 0.055),
    Math.min(1, tone(rgb[1]) + 0.012),
    Math.max(0, tone(rgb[2]) - 0.045),
  ];
};

/** 已知变换 B：强色彩偏置（基本不动明度）—— 肤色保护用 */
const strongCastK = (rgb: RGB): RGB => [
  Math.min(1, rgb[0] + 0.1),
  Math.min(1, rgb[1] - 0.01),
  Math.max(0, rgb[2] - 0.09),
];

/* ---------------- 验收用例 ---------------- */

describe('色彩匹配引擎', () => {
  const scene = makeScene();
  const sceneStats = analyzeImage(scene.data, scene.width, scene.height);

  it('1. 恒等性：参考=目标且参数全中性，1000 随机点 ΔE76 < 0.5', () => {
    const fn = buildTransform(withSource(sceneStats, sceneStats), {
      ...NEUTRAL_PARAMS,
    });
    const pts = randPoints(1000, mulberry32(7));
    let maxDE = 0;
    for (const p of pts) {
      maxDE = Math.max(maxDE, de76(fn(p), p));
    }
    console.info('[恒等性] max ΔE76 =', maxDE.toFixed(5));
    expect(maxDE).toBeLessThan(0.5);
  });

  it('2. 收敛性：应用已知变换后，匹配使 Lab 统计距离下降 >= 70%', () => {
    const refStats = sceneStats;
    const tgt = applyFnToImage(knownK, scene);
    const tgtStats = analyzeImage(tgt.data, tgt.width, tgt.height);
    const before = statsDistance(tgtStats, refStats);

    const fn = buildTransform(withSource(refStats, tgtStats), {
      ...NEUTRAL_PARAMS,
      match_strength: 1,
    });
    const result = applyFnToImage(fn, tgt);
    const resultStats = analyzeImage(result.data, result.width, result.height);
    const after = statsDistance(resultStats, refStats);

    console.info(
      '[收敛性] before =',
      before.toFixed(4),
      'after =',
      after.toFixed(4),
      '降幅 =',
      ((1 - after / before) * 100).toFixed(1) + '%',
    );
    expect(after).toBeLessThanOrEqual(before * 0.3);
  });

  it('3. 肤色保护：强色偏 + isolation=1，肤色块平均 ΔE < 全图平均的 1/3', () => {
    const refStats = sceneStats;
    const tgt = applyFnToImage(strongCastK, scene);
    const tgtStats = analyzeImage(tgt.data, tgt.width, tgt.height);
    const fn = buildTransform(withSource(refStats, tgtStats), {
      ...NEUTRAL_PARAMS,
      match_strength: 1,
      skin_isolation: 1,
    });
    const result = applyFnToImage(fn, tgt);

    // ΔE 度量变换对像素的移动量（保护 = 肤色几乎不动）
    let skinSum = 0;
    let skinN = 0;
    for (let y = SKIN_RECT.y0; y < SKIN_RECT.y1; y++) {
      for (let x = SKIN_RECT.x0; x < SKIN_RECT.x1; x++) {
        const i = (y * SIZE + x) * 4;
        const inC: RGB = [tgt.data[i] / 255, tgt.data[i + 1] / 255, tgt.data[i + 2] / 255];
        const outC: RGB = [
          result.data[i] / 255,
          result.data[i + 1] / 255,
          result.data[i + 2] / 255,
        ];
        skinSum += de76(outC, inC);
        skinN++;
      }
    }
    let allSum = 0;
    let allN = 0;
    for (let i = 0; i < tgt.data.length; i += 4) {
      const inC: RGB = [tgt.data[i] / 255, tgt.data[i + 1] / 255, tgt.data[i + 2] / 255];
      const outC: RGB = [
        result.data[i] / 255,
        result.data[i + 1] / 255,
        result.data[i + 2] / 255,
      ];
      allSum += de76(outC, inC);
      allN++;
    }
    const skinAvg = skinSum / skinN;
    const allAvg = allSum / allN;
    console.info(
      '[肤色保护] 肤色块 avg ΔE =',
      skinAvg.toFixed(3),
      '全图 avg ΔE =',
      allAvg.toFixed(3),
      '比值 =',
      (skinAvg / allAvg).toFixed(3),
    );
    expect(skinAvg).toBeLessThan(allAvg / 3);
  });

  it('4. LUT 保真：bakeLUT(65) 后 1000 随机点与直接变换 ΔE76 < 1.0', () => {
    const tgt = applyFnToImage(knownK, scene);
    // 参数取配方 Schema v1 示例风格的代表性观感
    const fn = buildTransform(withSource(sceneStats, analyzeImage(tgt.data, tgt.width, tgt.height)), {
      ...NEUTRAL_PARAMS,
      match_strength: 0.9,
      split_tone: 0.6,
      tone_contrast: 0.9,
      shadow_lift: 0.25,
      global_sat: 1.0,
      highlight_rolloff: 0.85,
    } satisfies MatchParams);
    const lut = bakeLUT(fn, 65);
    const pts = randPoints(1000, mulberry32(99));
    let maxDE = 0;
    for (const p of pts) {
      maxDE = Math.max(maxDE, de76(applyLUT(lut, p), fn(p)));
    }
    console.info('[LUT 保真] max ΔE76 =', maxDE.toFixed(4));
    expect(maxDE).toBeLessThan(1.0);
  });

  it('5. .cube 回环：toCube -> parseCube 逐点一致（1e-3），含 65^3 数据行', () => {
    const fn = buildTransform(withSource(sceneStats, sceneStats), {
      ...NEUTRAL_PARAMS,
      match_strength: 1,
      tone_contrast: 1.6,
      global_sat: 1.2,
    } satisfies MatchParams);
    const lut = bakeLUT(fn, 65);
    const text = toCube(lut, 'engine-roundtrip');

    expect(text).toContain('LUT_3D_SIZE 65');
    expect(text).toContain('DOMAIN_MIN');
    expect(text).toContain('DOMAIN_MAX');

    const dataLines = text
      .split(/\r?\n/)
      .filter((l) => {
        const s = l.trim();
        return /^\d/.test(s) && s.split(/\s+/).length >= 3;
      }).length;
    expect(dataLines).toBe(65 ** 3);

    const parsed = parseCube(text);
    expect(parsed.size).toBe(65);
    let maxDiff = 0;
    for (let i = 0; i < lut.table.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(parsed.table[i] - lut.table[i]));
    }
    console.info('[cube 回环] max 分量差 =', maxDiff.toExponential(3));
    expect(maxDiff).toBeLessThanOrEqual(1e-3);

    expect(() => parseCube('not a cube')).toThrow();
  });

  it('6. 单调性：L 通道烘焙映射沿亮度无逆序，且无 banding 台阶', () => {
    const tgt = applyFnToImage(knownK, scene);
    const fn = buildTransform(withSource(sceneStats, analyzeImage(tgt.data, tgt.width, tgt.height)), {
      ...NEUTRAL_PARAMS,
      match_strength: 0.6,
      tone_contrast: 1.8,
      shadow_lift: 0.5,
      highlight_rolloff: 0.6,
    } satisfies MatchParams);
    const lut = bakeLUT(fn, 65);

    let prevL = -Infinity;
    const prevOut: RGB = [0, 0, 0];
    let monotone = true;
    let maxStep = 0;
    for (let i = 0; i < 200; i++) {
      const v = i / 199;
      const out = applyLUT(lut, [v, v, v]);
      const L = rgbToLab(out[0], out[1], out[2])[0];
      if (L < prevL - 1e-6) monotone = false;
      prevL = L;
      if (i > 0) {
        for (let c = 0; c < 3; c++) {
          maxStep = Math.max(maxStep, Math.abs(out[c] - prevOut[c]));
        }
      }
      prevOut[0] = out[0];
      prevOut[1] = out[1];
      prevOut[2] = out[2];
    }
    console.info('[单调性] monotone =', monotone, 'max 相邻输出步长 =', maxStep.toFixed(5));
    expect(monotone).toBe(true);
    expect(maxStep).toBeLessThan(3 / 255);
  });

  it('7. 性能：buildTransform + 烘焙 65^3 在宽松上限 2s 内', () => {
    const tgt = applyFnToImage(knownK, scene);
    const tgtStats = analyzeImage(tgt.data, tgt.width, tgt.height);
    const t0 = performance.now();
    const fn = buildTransform(withSource(sceneStats, tgtStats), {
      ...NEUTRAL_PARAMS,
      match_strength: 1,
      tone_contrast: 1.4,
      global_sat: 1.25,
      split_tone: 0.6,
      skin_isolation: 0.5,
    } satisfies MatchParams);
    const lut = bakeLUT(fn, 65);
    const dt = performance.now() - t0;
    console.info('[性能] buildTransform + bakeLUT(65) =', dt.toFixed(1), 'ms');
    expect(lut.size).toBe(65);
    expect(dt).toBeLessThan(2000);
  });

  it('附加：ImageStats JSON 可序列化（图库标注持久化前提）', () => {
    const round = JSON.parse(JSON.stringify(sceneStats)) as ImageStats;
    expect(round).toEqual(sceneStats);
    // JSON 往返后的统计仍可直接用于构建变换
    const fn = buildTransform(withSource(round, round), { ...NEUTRAL_PARAMS });
    const o = fn([0.5, 0.5, 0.5]);
    expect(de76(o, [0.5, 0.5, 0.5])).toBeLessThan(0.5);
  });
});
