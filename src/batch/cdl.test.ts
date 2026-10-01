/**
 * CDL 求解器测试：中性恒等、单调性、三点拟合收敛与区间合法、序列化，
 * 以及 R3 验收核心——合成多帧序列的段间统计距离降幅（策略 A/B）。
 */
import { describe, expect, it } from 'vitest';
import { RGB } from '../engine/types';
import {
  applyCdl,
  cdlToCsv,
  cdlToJson,
  clampCdl,
  CDL_RANGES,
  fitCdl,
  NEUTRAL_CDL,
  type Cdl,
  type CdlEntry,
} from './cdl';
import { meanPairwiseDistance, quantileStats, type QuantileStats } from './quantiles';
import { synthScene, synthSeries } from './synth';

/* ---------------- 测试工具 ---------------- */

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

/** 逐像素施加 CDL（把 0..1 浮点变换后写回字节） */
function applyToPixels(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  cdl: Cdl,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  const rgb: RGB = [0, 0, 0];
  for (let i = 0, o = 0; i < w * h; i++, o += 4) {
    rgb[0] = data[o] / 255;
    rgb[1] = data[o + 1] / 255;
    rgb[2] = data[o + 2] / 255;
    const r = applyCdl(rgb, cdl);
    out[o] = r[0] * 255;
    out[o + 1] = r[1] * 255;
    out[o + 2] = r[2] * 255;
    out[o + 3] = 255;
  }
  return out;
}

/** 策略 A 的统一参考：各分位点/均值的逐通道平均 */
function unified(list: QuantileStats[]): QuantileStats {
  const n = list.length;
  const avg = (sel: (s: QuantileStats) => RGB): RGB => {
    const out: RGB = [0, 0, 0];
    for (const s of list) {
      const v = sel(s);
      out[0] += v[0] / n;
      out[1] += v[1] / n;
      out[2] += v[2] / n;
    }
    return out;
  };
  const mean = avg((s) => s.mean);
  return {
    p1: avg((s) => s.p1),
    p50: avg((s) => s.p50),
    p99: avg((s) => s.p99),
    mean,
    luma: 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2],
    samples: list.reduce((a, s) => a + s.samples, 0),
  };
}

function mkStats(p1: RGB, p50: RGB, p99: RGB, mean: RGB = p50): QuantileStats {
  return { p1, p50, p99, mean, luma: 0.5, samples: 1000 };
}

/* ---------------- 用例 ---------------- */

describe('cdl: 正向变换与钳制', () => {
  it('5. applyCdl 中性 CDL 为恒等（1000 随机点误差 < 1e-6）', () => {
    const rnd = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const rgb: RGB = [rnd(), rnd(), rnd()];
      const out = applyCdl(rgb, NEUTRAL_CDL);
      for (let c = 0; c < 3; c++) expect(Math.abs(out[c] - rgb[c])).toBeLessThan(1e-6);
    }
  });

  it('6. applyCdl 单调性：slope>0、power>0 时逐通道单调不减', () => {
    const cdl: Cdl = { slope: [1.3, 0.8, 1.1], offset: [0.02, -0.01, 0.03], power: [0.9, 1.1, 1.0], sat: 1 };
    const cdlDesat: Cdl = { ...cdl, sat: 0.7 };
    for (const test of [cdl, cdlDesat]) {
      for (const ch of [0, 1, 2]) {
        let prev = -1;
        for (let i = 0; i <= 200; i++) {
          const x = i / 200;
          const rgb: RGB = [0.4, 0.4, 0.4];
          rgb[ch] = x;
          const out = applyCdl(rgb, test);
          expect(out[ch]).toBeGreaterThanOrEqual(prev - 1e-9);
          prev = out[ch];
        }
      }
    }
  });

  it('7. clampCdl：越界值收敛到区间端点，非有限值回退中性', () => {
    const c = clampCdl({
      slope: [3, 0.1, 1],
      offset: [0.5, -0.5, 0],
      power: [0.1, 5, 1],
      sat: 5,
    });
    expect(c.slope).toEqual([CDL_RANGES.slope[1], CDL_RANGES.slope[0], 1]);
    expect(c.offset).toEqual([CDL_RANGES.offset[1], CDL_RANGES.offset[0], 0]);
    expect(c.power).toEqual([CDL_RANGES.power[0], CDL_RANGES.power[1], 1]);
    expect(c.sat).toBe(CDL_RANGES.sat[1]);
    const bad = clampCdl({
      slope: [NaN, 1, 1], offset: [0, 0, 0], power: [1, Infinity, 1], sat: NaN,
    });
    expect(bad.slope[0]).toBe(1);
    expect(bad.power[1]).toBe(1);
    expect(bad.sat).toBe(1);
  });
});

describe('cdl: 三点拟合', () => {
  it('8. fitCdl 收敛：对已知 CDL 处理后的统计拟合，after < before', () => {
    const w = 160;
    const h = 120;
    const srcData = synthScene(w, h);
    const src = quantileStats(srcData, w, h);
    const known: Cdl = {
      slope: [1.15, 0.95, 1.05],
      offset: [0.02, -0.01, 0.0],
      power: [0.95, 1.02, 1.0],
      sat: 1,
    };
    const refData = applyToPixels(srcData, w, h, known);
    const ref = quantileStats(refData, w, h);
    const fit = fitCdl(src, ref);
    expect(fit.after).toBeLessThan(fit.before);
    expect(fit.iterations).toBeLessThanOrEqual(12);
    // 拟合结果应接近已知 CDL（逐通道增益是主导项）
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(fit.cdl.slope[c] - known.slope[c])).toBeLessThan(0.08);
    }
  });

  it('9. fitCdl 输出全部落在 CDL_RANGES 内（随机 + 极端输入）', () => {
    const rnd = mulberry32(2026);
    const cases: Array<[QuantileStats, QuantileStats]> = [];
    for (let i = 0; i < 60; i++) {
      const mk = (): QuantileStats => {
        const chan = (): RGB => {
          const a = rnd();
          const b = a + rnd() * (1 - a);
          const c = b + rnd() * (1 - b);
          return [a, b, c];
        };
        return mkStats(chan(), chan(), chan());
      };
      cases.push([mk(), mk()]);
    }
    // 极端：全黑 → 全白、全白 → 全黑、平通道
    cases.push([mkStats([0, 0, 0], [0, 0, 0], [0, 0, 0]), mkStats([1, 1, 1], [1, 1, 1], [1, 1, 1])]);
    cases.push([mkStats([1, 1, 1], [1, 1, 1], [1, 1, 1]), mkStats([0, 0, 0], [0, 0, 0], [0, 0, 0])]);
    cases.push([mkStats([0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]), mkStats([0.1, 0.9, 0.4], [0.2, 0.8, 0.5], [0.3, 0.7, 0.6])]);

    let maxAbsSlopeErr = 0;
    for (const [src, ref] of cases) {
      const fit = fitCdl(src, ref);
      const { cdl } = fit;
      maxAbsSlopeErr = Math.max(maxAbsSlopeErr, Math.abs(cdl.slope[0] - 1), Math.abs(cdl.power[0] - 1));
      expect(Number.isFinite(fit.before)).toBe(true);
      expect(Number.isFinite(fit.after)).toBe(true);
      expect(fit.iterations).toBeLessThanOrEqual(12);
      for (let c = 0; c < 3; c++) {
        expect(cdl.slope[c]).toBeGreaterThanOrEqual(CDL_RANGES.slope[0]);
        expect(cdl.slope[c]).toBeLessThanOrEqual(CDL_RANGES.slope[1]);
        expect(cdl.offset[c]).toBeGreaterThanOrEqual(CDL_RANGES.offset[0]);
        expect(cdl.offset[c]).toBeLessThanOrEqual(CDL_RANGES.offset[1]);
        expect(cdl.power[c]).toBeGreaterThanOrEqual(CDL_RANGES.power[0]);
        expect(cdl.power[c]).toBeLessThanOrEqual(CDL_RANGES.power[1]);
      }
      expect(cdl.sat).toBeGreaterThanOrEqual(CDL_RANGES.sat[0]);
      expect(cdl.sat).toBeLessThanOrEqual(CDL_RANGES.sat[1]);
    }
    const bw = fitCdl(cases[cases.length - 3][0], cases[cases.length - 3][1]).cdl;
    console.log(
      `[F14 区间] cases=${cases.length} 全部在区间内; 最大|参数-1|=${maxAbsSlopeErr.toFixed(3)}; ` +
        `黑→白 slope=${bw.slope.map((v) => v.toFixed(3)).join('/')} power=${bw.power
          .map((v) => v.toFixed(3))
          .join('/')} sat=${bw.sat.toFixed(3)}`,
    );
  });

  it('10. 验收核心·策略 A（统一参考）：段间平均两两统计距离下降 >= 70%', () => {
    const w = 320;
    const h = 180;
    const frames = synthSeries(w, h, 7);
    const stats = frames.map((f) => quantileStats(f.data, f.w, f.h));
    const before = meanPairwiseDistance(stats);
    const ref = unified(stats);
    const applied = frames.map((f, i) => {
      const { cdl } = fitCdl(stats[i], ref);
      return quantileStats(applyToPixels(f.data, f.w, f.h, cdl), f.w, f.h);
    });
    const after = meanPairwiseDistance(applied);
    const drop = before > 0 ? (before - after) / before : 0;
    console.log(
      `[F14 策略A] before=${before.toFixed(5)} after=${after.toFixed(5)} 降幅=${(drop * 100).toFixed(2)}%`,
    );
    expect(before).toBeGreaterThan(0);
    expect(drop).toBeGreaterThanOrEqual(0.7);
  });

  it('11. 验收核心·策略 B（主段锚定）：段间平均两两统计距离下降 >= 70%', () => {
    const w = 320;
    const h = 180;
    const frames = synthSeries(w, h, 7);
    const stats = frames.map((f) => quantileStats(f.data, f.w, f.h));
    const before = meanPairwiseDistance(stats);
    const anchor = 3; // n=7 时 i=3 恰为 EV0/WB0 的中性主段
    const ref = stats[anchor];
    const applied = frames.map((f, i) => {
      const { cdl } = fitCdl(stats[i], ref);
      return quantileStats(applyToPixels(f.data, f.w, f.h, cdl), f.w, f.h);
    });
    const after = meanPairwiseDistance(applied);
    const drop = before > 0 ? (before - after) / before : 0;
    console.log(
      `[F14 策略B] before=${before.toFixed(5)} after=${after.toFixed(5)} 降幅=${(drop * 100).toFixed(2)}%`,
    );
    expect(drop).toBeGreaterThanOrEqual(0.7);
  });
});

describe('cdl: 序列化', () => {
  const entries: CdlEntry[] = [
    {
      name: 'seg01',
      cdl: { slope: [1.1, 0.98, 1.03], offset: [0.01, -0.02, 0], power: [0.95, 1.05, 1], sat: 1.02 },
      before: 0.05, after: 0.001, iterations: 4,
    },
    {
      name: 'seg02',
      cdl: { slope: [0.9, 1.02, 0.97], offset: [-0.01, 0.02, 0.005], power: [1.08, 0.97, 1.01], sat: 0.98 },
      before: 0.06, after: 0.002, iterations: 5,
    },
    {
      name: 'seg03',
      cdl: NEUTRAL_CDL,
      before: 0.0, after: 0.0, iterations: 1,
    },
  ];

  it('12. cdlToCsv：行数=段数+1、列数正确、数值可解析且在合法区间', () => {
    const csv = cdlToCsv(entries);
    const lines = csv.trim().split('\n');
    expect(lines.length).toBe(entries.length + 1);
    const header = lines[0].split(',');
    expect(header.length).toBe(13);
    expect(header).toEqual([
      'clip', 'slope_r', 'slope_g', 'slope_b', 'offset_r', 'offset_g', 'offset_b',
      'power_r', 'power_g', 'power_b', 'sat', 'before', 'after',
    ]);
    console.log(
      `[F14 CSV] 行数=${lines.length}(段数+1=${entries.length + 1}) 列数=${header.length} 首行=${lines[1]}`,
    );
    for (let i = 0; i < entries.length; i++) {
      const cols = lines[i + 1].split(',');
      expect(cols.length).toBe(13);
      const nums = cols.slice(1).map(Number);
      expect(nums.every((v) => Number.isFinite(v))).toBe(true);
      for (let c = 0; c < 3; c++) {
        expect(nums[0 + c]).toBeGreaterThanOrEqual(CDL_RANGES.slope[0]);
        expect(nums[0 + c]).toBeLessThanOrEqual(CDL_RANGES.slope[1]);
        expect(nums[3 + c]).toBeGreaterThanOrEqual(CDL_RANGES.offset[0]);
        expect(nums[3 + c]).toBeLessThanOrEqual(CDL_RANGES.offset[1]);
        expect(nums[6 + c]).toBeGreaterThanOrEqual(CDL_RANGES.power[0]);
        expect(nums[6 + c]).toBeLessThanOrEqual(CDL_RANGES.power[1]);
      }
      expect(nums[9]).toBeGreaterThanOrEqual(CDL_RANGES.sat[0]);
      expect(nums[9]).toBeLessThanOrEqual(CDL_RANGES.sat[1]);
      expect(nums[10]).toBeGreaterThanOrEqual(0);
      expect(nums[11]).toBeGreaterThanOrEqual(0);
    }
  });

  it('13. cdlToJson：meta/clips 结构完整且 JSON.parse 往返一致', () => {
    const s = cdlToJson(entries, {
      created_at: '2026-09-21T00:00:00.000Z',
      strategy: 'A',
      lut_size: 33,
    });
    const o = JSON.parse(s);
    expect(o.meta.strategy).toBe('A');
    expect(o.meta.lut_size).toBe(33);
    expect(o.meta.created_at).toBe('2026-09-21T00:00:00.000Z');
    expect(o.clips.length).toBe(entries.length);
    expect(o.clips[0].name).toBe('seg01');
    expect(o.clips[0].cdl.slope).toEqual(entries[0].cdl.slope);
    expect(o.clips[0].cdl.sat).toBe(entries[0].cdl.sat);
    // 往返：解析后再序列化应逐字符一致
    expect(JSON.stringify(JSON.parse(s), null, 2) + '\n').toBe(s);
  });
});
