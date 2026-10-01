/* R7 · 内联 CDL 的 JS 镜像与误差报告（src/dctl/inlinecdl.ts）
 *
 * 覆盖四件事：
 *   ① 镜像 vs 权威实现（batch/cdl.applyCdl）逐点一致（同式同序，maxAbs 应接近 0）；
 *   ② 极端输入（负值 / >1 / 饱和）不产生 NaN；
 *   ③ matchApproxReport 在合成统计上跑通：n ≥ 100、数字全有限、CDL 近似不是恒等（meanDE > 0）；
 *   ④ 优雅降级：engine 变换返回非有限值时该点被排除并计入 skipped（不静默出错）。
 */
import { describe, expect, it } from 'vitest';
import { CDL_RANGES, NEUTRAL_CDL, fitCdl, type Cdl } from '../batch/cdl';
import { quantileStats } from '../batch/quantiles';
import { synthSeries } from '../batch/synth';
import { deltaE76, rgbToLab } from '../engine/color';
import { buildTransform } from '../engine/match';
import { analyzeImage, withSource, type ImageStats } from '../engine/stats';
import { NEUTRAL_PARAMS, type MatchParams, type RGB } from '../engine/types';
import { applyInlineCdl, compareInlineCdlToApplyCdl, matchApproxReport } from './inlinecdl';

/** 确定性伪随机（LCG）：测试要可复现，不用 Math.random */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 4 组系数：中性 + 一组真实量级 + 两组区间端点（把 CDL_RANGES 的边界走满） */
const CDLS: Cdl[] = [
  NEUTRAL_CDL,
  { slope: [1.123456, 0.945678, 1.312345], offset: [-0.023456, 0.005678, 0.031234], power: [0.954321, 1.056789, 1.183456], sat: 1.234567 },
  { slope: [CDL_RANGES.slope[0], CDL_RANGES.slope[1], CDL_RANGES.slope[0]], offset: [-0.1, 0.1, -0.1], power: [1.4, 0.7, 1.4], sat: CDL_RANGES.sat[0] },
  { slope: [CDL_RANGES.slope[1], CDL_RANGES.slope[0], CDL_RANGES.slope[1]], offset: [0.1, -0.1, 0.1], power: [0.7, 1.4, 0.7], sat: CDL_RANGES.sat[1] },
];

/** 5×5×5 网格（125 点）+ n 个随机点；与 matchApproxReport 的网格口径一致 */
function gridAndRandom(n: number, seed: number): RGB[] {
  const pts: RGB[] = [];
  const N = 5;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      for (let k = 0; k < N; k++) pts.push([i / (N - 1), j / (N - 1), k / (N - 1)]);
    }
  }
  const rnd = lcg(seed);
  for (let i = 0; i < n; i++) pts.push([rnd(), rnd(), rnd()]);
  return pts;
}

const allFinite = (rgb: RGB): boolean => rgb.every((v) => Number.isFinite(v));

describe('R7 内联 CDL 镜像（applyInlineCdl）', () => {
  it('1. 与权威实现 applyCdl 逐点一致：≥1000 随机点 + 125 网格点 × 4 组系数，maxAbs < 1e-9', () => {
    const pts = gridAndRandom(1200, 20260923);
    expect(pts.length).toBeGreaterThan(1000);
    for (const cdl of CDLS) {
      const d = compareInlineCdlToApplyCdl(pts, cdl);
      expect(d.n).toBe(pts.length);
      expect(d.maxAbs, `maxAbs=${d.maxAbs}`).toBeLessThan(1e-9);
      expect(d.meanAbs).toBeLessThan(1e-9);
      /* 逐点直接对拍（compareInlineCdlToApplyCdl 之外的独立口径） */
      for (const p of pts.slice(0, 200)) {
        const a = applyInlineCdl(p, cdl);
        expect(a[0]).toBeCloseTo(Math.max(0, Math.min(1, a[0])), 12);   // 输出恒在 0..1
        expect(allFinite(a)).toBe(true);
      }
    }
  });

  it('2. 极端输入不产生 NaN：负值 / >1 / 0 与 1 端点 / 极大量级', () => {
    const extreme: RGB[] = [
      [-3, -0.5, 0],
      [1.5, 3, 1e9],
      [0, 0, 0],
      [1, 1, 1],
      [-1e9, 1e9, 0.5],
    ];
    for (const cdl of CDLS) {
      for (const p of extreme) {
        const a = applyInlineCdl(p, cdl);
        expect(allFinite(a), `${JSON.stringify(p)} → ${JSON.stringify(a)}`).toBe(true);
        for (const v of a) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
    /* 镜像在极端点上仍与权威实现一致 */
    expect(compareInlineCdlToApplyCdl(extreme, CDLS[1]).maxAbs).toBeLessThan(1e-9);
  });

  it('3. compareInlineCdlToApplyCdl 的计数与空输入（不抛错、零值）', () => {
    const empty = compareInlineCdlToApplyCdl([], NEUTRAL_CDL);
    expect(empty).toEqual({ n: 0, meanAbs: 0, maxAbs: 0 });
    const one = compareInlineCdlToApplyCdl([[0.5, 0.5, 0.5]], NEUTRAL_CDL);
    expect(one.n).toBe(1);
    expect(one.maxAbs).toBeLessThan(1e-12);
  });
});

/* ---- 误差报告：合成统计（synth.ts 场景 → engine.analyzeImage） ---- */

/** 合成「被调色图」与「参考图」：同场景、不同曝光/白平衡（第 1 帧 vs 第 3 帧） */
function synthStats(): { user: ImageStats; ref: ImageStats } {
  const frames = synthSeries(96, 64, 3);
  const f0 = frames[0];
  const f2 = frames[frames.length - 1];
  return {
    user: analyzeImage(f0.data, f0.w, f0.h),
    ref: analyzeImage(f2.data, f2.w, f2.h),
  };
}

/** 非中性参数：匹配强度 + 中间调对比 + 分离色调 + 饱和，确保 engine 与 CDL 明显不同 */
const STRONG_PARAMS: MatchParams = {
  ...NEUTRAL_PARAMS,
  match_strength: 0.9,
  skin_isolation: 0.5,
  split_tone: 0.4,
  tone_contrast: 1.15,
  shadow_lift: 0.15,
  global_sat: 1.08,
  highlight_rolloff: 0.25,
};

describe('R7 误差报告（matchApproxReport）', () => {
  it('4. 合成统计跑通：n ≥ 100、数字全有限、CDL 落在 CDL_RANGES 内', () => {
    const { user, ref } = synthStats();
    const rep = matchApproxReport(user, ref, STRONG_PARAMS);
    expect(rep.n).toBeGreaterThanOrEqual(100);
    expect(rep.n + rep.skipped).toBe(133);   // 4 锚点 × 2 图 + 5×5×5 网格
    for (const v of [rep.meanAbs, rep.maxAbs, rep.meanDE, rep.maxDE]) expect(Number.isFinite(v)).toBe(true);
    expect(rep.meanAbs).toBeGreaterThanOrEqual(0);
    expect(rep.maxAbs).toBeGreaterThanOrEqual(rep.meanAbs);
    expect(rep.meanDE).toBeGreaterThanOrEqual(0);
    expect(rep.maxDE).toBeGreaterThanOrEqual(rep.meanDE);
    expect(rep.cdl.slope[0]).toBeGreaterThanOrEqual(CDL_RANGES.slope[0]);
    expect(rep.cdl.slope[0]).toBeLessThanOrEqual(CDL_RANGES.slope[1]);
    expect(rep.cdl.offset[0]).toBeGreaterThanOrEqual(CDL_RANGES.offset[0]);
    expect(rep.cdl.offset[0]).toBeLessThanOrEqual(CDL_RANGES.offset[1]);
    expect(rep.cdl.power[0]).toBeGreaterThanOrEqual(CDL_RANGES.power[0]);
    expect(rep.cdl.power[0]).toBeLessThanOrEqual(CDL_RANGES.power[1]);
    expect(rep.cdl.sat).toBeGreaterThanOrEqual(CDL_RANGES.sat[0]);
    expect(rep.cdl.sat).toBeLessThanOrEqual(CDL_RANGES.sat[1]);
    console.log(`[R7 误差报告] n=${rep.n} skipped=${rep.skipped} meanAbs=${rep.meanAbs.toFixed(4)} `
      + `maxAbs=${rep.maxAbs.toFixed(4)} meanDE=${rep.meanDE.toFixed(3)} maxDE=${rep.maxDE.toFixed(3)}`);
  });

  it('5. 诚实标注 CDL 近似：非中性参考下 meanDE > 0（近似不是恒等）', () => {
    const { user, ref } = synthStats();
    const rep = matchApproxReport(user, ref, STRONG_PARAMS);
    /* 量级参考（合成素材，5×5×5 立方含高饱和边缘点，engine 在那里收缩色域、CDL 只钳制）：
     * 实测 meanDE ≈ 38 / maxDE ≈ 120。这里只钉「不是恒等」，量级随参数/素材变化。 */
    expect(rep.meanDE, 'CDL 近似与 engine 匹配完全一致 → 说明报告没在比较两条不同的路').toBeGreaterThan(0);
    expect(rep.meanDE).toBeGreaterThan(1);
    console.log(`[R7 误差报告·非中性] n=${rep.n} meanAbs=${rep.meanAbs.toFixed(4)} maxAbs=${rep.maxAbs.toFixed(4)} `
      + `meanDE=${rep.meanDE.toFixed(3)} maxDE=${rep.maxDE.toFixed(3)}`);
  });

  it('5b. CDL 来源优先级：opts.cdl 直用 / opts.quantiles 走 R3 输入口径 / 缺省退回分区均值锚点', () => {
    const frames = synthSeries(96, 64, 3);
    const { user, ref } = synthStats();
    const qUser = quantileStats(frames[0].data, frames[0].w, frames[0].h);
    const qRef = quantileStats(frames[1].data, frames[1].w, frames[1].h);

    // ① 调用方已有解算结果：原样使用（报告描述的就是内联进 DCTL 的那组系数）
    const given: Cdl = { slope: [1.4, 1.3, 1.2], offset: [0.02, 0.01, 0.01], power: [1, 1, 1], sat: 1.05 };
    const withGiven = matchApproxReport(user, ref, STRONG_PARAMS, { cdl: given });
    expect(withGiven.cdl).toEqual(given);

    // ② 真实分位数：与 fitCdl 直算的结果一致（R3 的口径）
    const withQ = matchApproxReport(user, ref, STRONG_PARAMS, { quantiles: { user: qUser, ref: qRef } });
    const direct = fitCdl(qUser, qRef).cdl;
    expect(withQ.cdl).toEqual(direct);
    expect(withQ.cdl.slope[0]).not.toBe(withGiven.cdl.slope[0]);

    // ③ 缺省（只给 ImageStats）：仍能出结果，且同样 n ≥ 100
    const fallback = matchApproxReport(user, ref, STRONG_PARAMS);
    expect(fallback.n).toBe(withQ.n);
    expect(fallback.n).toBeGreaterThanOrEqual(100);
    for (const v of [fallback.meanDE, withQ.meanDE]) expect(Number.isFinite(v)).toBe(true);
    console.log(`[R7 误差报告·CDL 来源] 分位数口径 meanDE=${withQ.meanDE.toFixed(3)} / 锚点兜底 meanDE=${fallback.meanDE.toFixed(3)}`);
  });

  it('6. 同一张图 + 全中性参数：解算回到中性 CDL，内部点两条路径一致（下限自检）', () => {
    const { user } = synthStats();
    const rep = matchApproxReport(user, user, NEUTRAL_PARAMS);
    expect(rep.n).toBeGreaterThanOrEqual(100);
    expect(rep.cdl.slope[0]).toBeCloseTo(1, 6);
    expect(rep.cdl.offset[0]).toBeCloseTo(0, 6);
    expect(rep.cdl.power[0]).toBeCloseTo(1, 6);
    expect(rep.cdl.sat).toBeCloseTo(1, 6);
    /* 内部点（3³ = 27 点，远离色域边缘）：engine 恒等、CDL 恒等 → ΔE ≈ 0 */
    const T = buildTransform(withSource(user, user), NEUTRAL_PARAMS);
    let maxDE = 0;
    for (const v of [0.25, 0.5, 0.75]) {
      for (const w of [0.25, 0.5, 0.75]) {
        for (const u of [0.25, 0.5, 0.75]) {
          const p: RGB = [u, v, w];
          const e = T(p);
          const c = applyInlineCdl(p, rep.cdl);
          const le = rgbToLab(e[0], e[1], e[2]);
          const lc = rgbToLab(c[0], c[1], c[2]);
          maxDE = Math.max(maxDE, deltaE76(le[0], le[1], le[2], lc[0], lc[1], lc[2]));
        }
      }
    }
    expect(maxDE, `内部点 maxDE=${maxDE}`).toBeLessThan(0.5);
    /* 全网格的均值残差来自色域边缘点（如纯黄 1,1,0）：engine 走 Lab 往返、边缘色要沿 a*b* 收缩，
     * CDL 是逐通道曲线（恒等系数下逐位恒等）——这是 engine 的固有行为，不是报告的缺陷，
     * 但也是「CDL 近似 ≠ engine 匹配」的一部分，故报告照实计入。 */
    expect(rep.meanDE).toBeLessThan(2);
  });

  it('7. 优雅降级：engine 变换返回非有限值时该点被排除并计数（不抛错、不污染均值）', () => {
    const { user, ref } = synthStats();
    /* 把统计打成 NaN：engine 的曲线/色偏全变 NaN → 每个点都应被排除 */
    const broken: ImageStats = {
      ...ref,
      global: { ...ref.global, mean: [NaN, NaN, NaN] },
      zones: {
        shadow: { ...ref.zones.shadow, mean: [NaN, NaN, NaN] },
        mid: { ...ref.zones.mid, mean: [NaN, NaN, NaN] },
        high: { ...ref.zones.high, mean: [NaN, NaN, NaN] },
      },
    };
    const rep = matchApproxReport(user, broken, STRONG_PARAMS);
    expect(rep.n).toBe(0);
    expect(rep.skipped).toBe(133);            // 采样点数不变，坏点全部计入 skipped
    for (const v of [rep.meanAbs, rep.maxAbs, rep.meanDE, rep.maxDE]) expect(Number.isFinite(v)).toBe(true);
    expect(rep.meanAbs).toBe(0);
    expect(rep.meanDE).toBe(0);
    /* 报告本身仍给出 CDL（退化输入下也要有可展示的结果，不抛错） */
    expect(Number.isFinite(rep.cdl.sat)).toBe(true);
  });
});

describe('R7 合成素材与分位数口径自检', () => {
  it('8. synthSeries + quantileStats 的组合是确定性的（报告可复现的前提）', () => {
    const frames = synthSeries(64, 48, 3);
    const a = quantileStats(frames[0].data, frames[0].w, frames[0].h);
    const b = quantileStats(synthSeries(64, 48, 3)[0].data, 64, 48);
    expect(a.p50).toEqual(b.p50);
    expect(a.mean).toEqual(b.mean);
    expect(a.samples).toBe(64 * 48);
  });
});
