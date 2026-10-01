/**
 * R10-B Worker 纯算子 —— 匹配求解（quantileStats + fitCdl 逐段拟合）。
 *
 * worker 入口（match.worker.ts）与主线程回退（ui/batch.ts 的 matchClient.sync）调用同一函数。
 * 依赖 batch/quantiles + batch/cdl（纯数学，无 DOM）。
 */
import {
  meanPairwiseDistance, quantileStats, statDistance,
  type QuantileStats,
} from '../batch/quantiles';
import { applyCdl, fitCdl, type Cdl } from '../batch/cdl';

export interface SolveSeg {
  name: string;
  /** RGBA 像素（stride 4），分量 sRGB 0..255 */
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

export interface SolveReq {
  segs: SolveSeg[];
  strategy: 'A' | 'B';
}

export interface SolveSegRes {
  stats: QuantileStats;
  cdl: Cdl;
  before: number;
  after: number;
  iterations: number;
  converged: boolean;
}

export interface SolveRes {
  ref: QuantileStats;
  segs: SolveSegRes[];
  pairwise: { before: number; after: number; dropPct: number };
}

/** 分位数统计逐字段均值（策略 A 的统一参考）——与 ui/batch.ts 原实现一致 */
export function meanStats(list: QuantileStats[]): QuantileStats {
  const n = list.length;
  const acc: QuantileStats = { p1: [0, 0, 0], p50: [0, 0, 0], p99: [0, 0, 0], mean: [0, 0, 0], luma: 0, samples: 0 };
  for (const s of list) {
    for (let i = 0; i < 3; i++) {
      acc.p1[i] += s.p1[i] / n;
      acc.p50[i] += s.p50[i] / n;
      acc.p99[i] += s.p99[i] / n;
      acc.mean[i] += s.mean[i] / n;
    }
    acc.luma += s.luma / n;
    acc.samples += s.samples;
  }
  return acc;
}

/** 把 CDL 施加到整段像素并重算统计（纯函数：内部复制，不改入参）——与 ui/batch.ts 原实现同式 */
export function applyCdlToStats(data: Uint8ClampedArray, w: number, h: number, cdl: Cdl): QuantileStats {
  const d = new Uint8ClampedArray(data.length);
  d.set(data);
  const rgb: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) {
    rgb[0] = d[i] / 255; rgb[1] = d[i + 1] / 255; rgb[2] = d[i + 2] / 255;
    const o = applyCdl(rgb, cdl);
    d[i] = Math.max(0, Math.min(255, Math.round(o[0] * 255)));
    d[i + 1] = Math.max(0, Math.min(255, Math.round(o[1] * 255)));
    d[i + 2] = Math.max(0, Math.min(255, Math.round(o[2] * 255)));
  }
  return quantileStats(d, w, h);
}

/**
 * 批量匹配求解：逐段分位数统计 → 参考（A=均值 / B=首段）→ fitCdl →
 * 拟合后统计距离（真实把 CDL 过一遍像素）→ 段间两两距离（拟合前/后）。
 */
export function solveMatchOp(req: SolveReq): SolveRes {
  const stats = req.segs.map((s) => quantileStats(s.data, s.w, s.h));
  if (!stats.length) throw new Error('solveMatchOp: 无素材');
  const ref = req.strategy === 'B' ? stats[0] : meanStats(stats);
  const segs: SolveSegRes[] = req.segs.map((s, i) => {
    const fit = fitCdl(stats[i], ref);
    const afterStats = applyCdlToStats(s.data, s.w, s.h, fit.cdl);
    return {
      stats: stats[i],
      cdl: fit.cdl,
      before: statDistance(stats[i], ref),
      after: statDistance(afterStats, ref),
      iterations: fit.iterations,
      converged: fit.converged,
    };
  });
  const before = meanPairwiseDistance(stats);
  const after = meanPairwiseDistance(segs.map((s, i) => applyCdlToStats(req.segs[i].data, req.segs[i].w, req.segs[i].h, s.cdl)));
  const dropPct = before > 1e-9 ? Math.max(0, (before - after) / before * 100) : 0;
  return { ref, segs, pairwise: { before, after, dropPct } };
}
