/**
 * R17 演示与探针（动态 import，独立 chunk 不进首屏包——gzip 余量护栏）。
 *
 * 承载三类「测量/验收」逻辑：
 *   - bakeProbeOnce：一次 65³ 匹配烘焙探针（GPU 优先/回退 CPU），demo=perf 随 meta 上报路径与耗时；
 *   - bakePerfDemo：GPU 与 CPU 各计 N 次烘焙耗时（perf-baseline.mjs --bake 的页面侧）；
 *   - rangeDemo：GPU vs CPU 烘焙逐点一致性（SwiftShader 下真实对拍）+ 数据范围导出对比。
 *
 * 口径：
 *   - GPU 档 = renderer.bakeLutAtlas（tile-atlas 渲染 + readPixels，含数据纹理上传——如实计时）；
 *   - CPU 档 = bakeLutOp（worker 入口与主线程回退的同一函数；worker 化只是搬线程，不省计算）。
 *   - SwiftShader 的 GPU 数字只能证明路径通、量级正确，不代表真实 GPU 收益（见 R17 报告）。
 */
import { analyzeImage, withSource, type DataRange } from '../engine';
import { matchBakeData, type MatchBakeData } from '../engine/match';
import { LEGAL_HIGH, LEGAL_LOW } from '../engine/lut';
import type { EffectRenderer } from '../film/pipeline';
import { bakeLutOp, type BakeLutReq, type BakeLutRes } from '../workers/ops-lut';
import type { WorkerClient } from '../workers/client';
import { setMeta } from './e2emeta';
import type { RecipeState } from './recipe';

/** main.ts 注入的运行时上下文（只传接口，不传大对象） */
export interface R17Ctx {
  renderer: Pick<EffectRenderer, 'bakeLutAtlas' | 'gpuBakeFormat' | 'backendKind' | 'backendLabel'>;
  lutClient: WorkerClient<BakeLutReq, BakeLutRes>;
  getState(): RecipeState | null;
  matchDataOf(st: RecipeState): MatchBakeData;
  cubeText(range: DataRange): Promise<{ text: string; code: string; size: number; range: DataRange }>;
  setExportRange(v: 'full' | 'legal'): void;
  openStep5(): void;
  setTitle(t: string): void;
}

interface BakeStats { n: number; msTotal: number; msMean: number; msP50: number; msMin: number; msMax: number }
function bakeStatsOf(xs: number[]): BakeStats {
  const total = xs.reduce((a, b) => a + b, 0);
  const sorted = [...xs].sort((x, y) => x - y);
  const p50 = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
  return {
    n: xs.length,
    msTotal: +total.toFixed(2),
    msMean: xs.length ? +(total / xs.length).toFixed(2) : 0,
    msP50: +p50.toFixed(2),
    msMin: xs.length ? +Math.min(...xs).toFixed(2) : 0,
    msMax: xs.length ? +Math.max(...xs).toFixed(2) : 0,
  };
}

/** 合成探针统计（与 workers.test.ts 同思路的确定性渐变对）：无统计配方（型号直出）时供烘焙探针用 */
function probeStatsPair(): { ref: ReturnType<typeof analyzeImage>; user: ReturnType<typeof analyzeImage> } {
  const S = 64;
  const mk = (f: (x: number, y: number) => [number, number, number]): ReturnType<typeof analyzeImage> => {
    const a = new Uint8ClampedArray(S * S * 4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const [r, g, b] = f(x / S, y / S);
      a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = 255;
    }
    return analyzeImage(a, S, S);
  };
  return {
    ref: mk((x, y) => [40 + 180 * x, 60 + 150 * y, 90 + 120 * (1 - x * y)]),
    user: mk((x, y) => [45 + 178 * x, 64 + 148 * y, 92 + 119 * (1 - x * y)]),
  };
}
let probeStatsCache: { ref: ReturnType<typeof analyzeImage>; user: ReturnType<typeof analyzeImage> } | null = null;

/** 烘焙探针用的 RecipeState（优先当前配方；无统计则用合成探针统计，保证总能真实烘一次 65³） */
function probeState(ctx: R17Ctx): { st: RecipeState; md: MatchBakeData } {
  const cur: RecipeState | null = ctx.getState();
  if (cur && cur.refStats && cur.userStats) return { st: cur, md: ctx.matchDataOf(cur) };
  if (!probeStatsCache) probeStatsCache = probeStatsPair();
  const ps = probeStatsCache;
  const withStats: RecipeState = {
    colorParams: cur?.colorParams ?? { match_strength: 0.75, skin_hue: 0, skin_sat: 1, skin_isolation: 0, split_tone: 0, tone_contrast: 1, shadow_lift: 0, global_sat: 1, highlight_rolloff: 0 },
    look: cur?.look ?? ({
      fade: 0, black_lift: 0, dye_coupling: 0, shadow_bias: 0, highlight_bias: 0,
      film_s: 0, contrast: 0, saturation: 1, warmth: 0,
      split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0,
    } as RecipeState['look']),
    texture: cur?.texture ?? ({} as RecipeState['texture']),
    master: cur?.master ?? 1,
    origins: cur?.origins ?? {},
    refStats: ps.ref,
    userStats: ps.user,
    profile: cur?.profile,
    range: cur?.range,
  };
  return { st: withStats, md: matchBakeData(withSource(withStats.refStats!, withStats.userStats!), withStats.colorParams) };
}

/** 一次 65³ 匹配烘焙探针：GPU 优先、失败回退 worker/CPU；结果随 perf meta 上报（路径 + 耗时） */
export async function bakeProbeOnce(ctx: R17Ctx): Promise<{ path: 'gpu' | 'cpu-fallback'; ms: number; format: string | null }> {
  const { st, md } = probeState(ctx);
  const t0 = performance.now();
  const lut = await ctx.renderer.bakeLutAtlas({ size: 65, kind: 'match', match: md, look: null, range: 'full' });
  if (lut) return { path: 'gpu', ms: +(performance.now() - t0).toFixed(2), format: ctx.renderer.gpuBakeFormat };
  const t1 = performance.now();
  bakeLutOp({ state: st, size: 65, kind: 'match' });
  return { path: 'cpu-fallback', ms: +(performance.now() - t1).toFixed(2), format: null };
}

/** R17 bakeperf：同一配方、同一尺寸（65³ 匹配）GPU 与 CPU 各计 N 次 → #e2e-meta.bakePerf */
export async function bakePerfDemo(ctx: R17Ctx, n: number): Promise<void> {
  const { st, md } = probeState(ctx);
  const N = Math.max(1, Math.min(50, n));
  const gpu: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const r = await ctx.renderer.bakeLutAtlas({ size: 65, kind: 'match', match: md, look: null, range: 'full' });
    if (!r) break;
    gpu.push(performance.now() - t0);
  }
  const cpu: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    bakeLutOp({ state: st, size: 65, kind: 'match' });
    cpu.push(performance.now() - t0);
  }
  setMeta({
    bakePerf: {
      size: 65, voxels: 65 * 65 * 65, kind: 'match', backend: ctx.renderer.backendLabel(),
      gpu: { ...bakeStatsOf(gpu), available: gpu.length === N, format: ctx.renderer.gpuBakeFormat },
      cpu: bakeStatsOf(cpu),
    },
  });
  ctx.setTitle('BAKEPERF DONE');
}

function tableMaxDiff(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Infinity;
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
  }
  return max;
}

/** R17 range 演示：GPU vs CPU 烘焙逐点一致性（match/recipe 两目标，全表 ≥500 点）
 *  + 数据范围导出对比（同一配方 full vs legal 的 .cube 文本）→ rangeCheck/bakeConsistency */
export async function rangeDemo(ctx: R17Ctx, rangeSel: string | null): Promise<void> {
  const st = ctx.getState();
  if (!st) return;
  /* 1) 数据范围开关（可选 &rangeSel=legal → 截图前切到 Legal，供视觉/状态断言；预览画面不变） */
  if (rangeSel === 'legal' || rangeSel === 'full') ctx.setExportRange(rangeSel);
  ctx.openStep5();
  /* 2) GPU vs CPU 一致性：33³ match + 33³ recipe 全表对比（35937 点 ≥500）。
   * CPU 侧走 lutClient（与真实导出同一请求路径）；GPU 侧同 gpubake。
   * 用 probeState()（当前配方优先，无统计时合成探针统计）保证任何配方下都能对比。 */
  const { st: pst, md } = probeState(ctx);
  const points = 33 * 33 * 33;
  let maxMatch = -1, maxRecipe = -1, gpuFormat: string | null = null, gpuUsed = false;
  if (md) {
    const g1 = await ctx.renderer.bakeLutAtlas({ size: 33, kind: 'match', match: md, look: null, range: 'full' });
    if (g1) {
      const c1 = await ctx.lutClient.run({ state: pst, size: 33, kind: 'match' });
      maxMatch = tableMaxDiff(g1.table, c1.table);
      const g2 = await ctx.renderer.bakeLutAtlas({ size: 33, kind: 'recipe', match: md, look: st.look, range: 'full' });
      if (g2) {
        const c2 = await ctx.lutClient.run({ state: pst, size: 33, kind: 'recipe' });
        maxRecipe = tableMaxDiff(g2.table, c2.table);
        gpuUsed = true;
      }
    }
  }
  gpuFormat = ctx.renderer.gpuBakeFormat;
  setMeta({
    bakeConsistency: {
      points,
      maxDiffMatch: maxMatch < 0 ? null : +maxMatch.toFixed(6),
      maxDiffRecipe: maxRecipe < 0 ? null : +maxRecipe.toFixed(6),
      threshold: 1e-3,
      gpuUsed, gpuFormat, backend: ctx.renderer.backendKind,
      pass: maxMatch >= 0 && maxMatch < 1e-3 && maxRecipe >= 0 && maxRecipe < 1e-3,
    },
  });
  /* 3) 数据范围导出对比（同一配方 full vs legal 的 .cube 文本） */
  const full = await ctx.cubeText('full');
  const legal = await ctx.cubeText('legal');
  /* 首条数据行（跳过 TITLE/COMMENT/LUT_3D_SIZE/DOMAIN 头部）= 网格点 (0,0,0) 的映射结果 */
  const firstRow = (t: string): number[] => {
    for (const line of t.split('\n')) {
      if (/^\s*-?[0-9]/.test(line)) return line.trim().split(/\s+/).map(Number);
    }
    return [NaN, NaN, NaN];
  };
  const f0 = firstRow(full.text), l0 = firstRow(legal.text);
  const span = LEGAL_HIGH - LEGAL_LOW;
  let encErr = -1;
  for (let c = 0; c < 3; c++) {
    if (Number.isFinite(f0[c]) && Number.isFinite(l0[c])) {
      encErr = Math.max(encErr, Math.abs(l0[c] - (f0[c] * span + LEGAL_LOW)));
    }
  }
  setMeta({
    rangeCheck: {
      current: st.range === 'legal' ? 'legal' : 'full',
      fullHasComment: full.text.includes('COMMENT'),
      legalHasComment: legal.text.includes('COMMENT'),
      differ: full.text !== legal.text,
      fullFirst: f0, legalFirst: l0,
      encodeErr: encErr < 0 ? null : +encErr.toPrecision(3),
      legalLow: +LEGAL_LOW.toPrecision(4), legalHigh: +LEGAL_HIGH.toPrecision(4),
      formula: 'E(f(D(x))): D(x)=clamp01((x-16/255)/(235/255-16/255)), E(y)=y*(hi-lo)+lo',
    },
  });
  ctx.setTitle('RANGE DONE');
}
