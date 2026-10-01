/**
 * R10-B Worker 化：一致性 + 回退 + 超时（node 纯测试，不启动真 worker）。
 *
 * 一致性验证方式：
 *   - ops 是 worker 入口与主线程回退的**同一函数**（结构保证）；这里再做两重断言：
 *     ① ops 的结果与「直接用底层库函数重算」逐位/逐值一致（防止 ops 悄悄偏离库）；
 *     ② 经 RPC 层（client + 桩 worker）往返后的结果与直接调用逐位一致（序列化不改变结果）。
 *   - LUT：Float32 表逐元素相等；匹配求解：CDL 数值/统计距离相等；打包：zip 字节相等。
 */
import { describe, expect, it } from 'vitest';
import { analyzeImage } from '../engine';
import { getPreset } from '../film/params';
import { bakeMatchLUT, bakeRecipeLUT, type RecipeState } from '../ui/recipe';
import { quantileStats, statDistance, meanPairwiseDistance, type QuantileStats } from '../batch/quantiles';
import { applyCdl, fitCdl, type Cdl, type CdlEntry } from '../batch/cdl';
import { buildPackOp, type PackReq } from './ops-pack';
import { solveMatchOp, type SolveReq } from './ops-match';
import { bakeLutOp } from './ops-lut';
import { createWorkerClient, type WorkerLike } from './client';

/* ---------------- 测试夹具 ---------------- */

/** 合成一对「相近但有差异」的参考/被调色统计（与 lookshader.test 同思路） */
function synthStats(): { ref: ReturnType<typeof analyzeImage>; user: ReturnType<typeof analyzeImage> } {
  const S = 96;
  const mk = (f: (x: number, y: number) => [number, number, number]): ReturnType<typeof analyzeImage> => {
    const a = new Uint8ClampedArray(S * S * 4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4, [r, g, b] = f(x / S, y / S);
      a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = 255;
    }
    return analyzeImage(a, S, S);
  };
  return {
    ref: mk((x, y) => [40 + 180 * x, 60 + 150 * y, 90 + 120 * (1 - x * y)]),
    user: mk((x, y) => [45 + 178 * x, 64 + 148 * y, 92 + 119 * (1 - x * y)]),
  };
}

function stateFixture(): RecipeState {
  const card = getPreset('fl05');
  const stats = synthStats();
  return {
    colorParams: { match_strength: 0.75, skin_hue: 0, skin_sat: 1, skin_isolation: 0, split_tone: 0, tone_contrast: 1, shadow_lift: 0, global_sat: 1, highlight_rolloff: 0 },
    look: card.params.look,
    texture: card.params.texture,
    master: 1,
    origins: { ...card.origins },
    refStats: stats.ref,
    userStats: stats.user,
  };
}

/** 确定性 RGBA 段（不同曝光/色偏，模拟批量素材） */
function segData(w: number, h: number, k: number): Uint8ClampedArray {
  const a = new Uint8ClampedArray(w * h * 4);
  let s = 0x9e3779b9 ^ k;
  const rnd = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const base = 20 + 200 * (x / w) * (0.4 + 0.6 * k);
    a[i] = Math.max(0, Math.min(255, base + 18 * k + 10 * rnd()));
    a[i + 1] = Math.max(0, Math.min(255, base * 0.92 + 6 * rnd()));
    a[i + 2] = Math.max(0, Math.min(255, base * 1.05 + 12 * rnd()));
    a[i + 3] = 255;
  }
  return a;
}

/** 独立重算「拟合后统计」（与 ops 同式但写在测试里，用于交叉验证 ops 未偏离库函数） */
function applyCdlToStatsRef(data: Uint8ClampedArray, w: number, h: number, cdl: Cdl): QuantileStats {
  const d = new Uint8ClampedArray(data.length); d.set(data);
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

/* ---------------- 桩 worker（在 node 里模拟真实 worker 往返） ---------------- */

function makeStubWorker(handler: (payload: unknown) => unknown, opts: { silent?: boolean } = {}): WorkerLike {
  const listeners: Record<string, Array<(ev: { data?: unknown }) => void>> = {};
  const emit = (type: string, ev: { data?: unknown }): void => { for (const cb of listeners[type] ?? []) cb(ev); };
  return {
    postMessage(msg: unknown) {
      if (opts.silent) return;   // 模拟不响应的 worker（触发超时回退）
      queueMicrotask(() => {
        const m = msg as { id: number; payload: unknown };
        try { emit('message', { data: { id: m.id, ok: true, result: handler(m.payload) } }); }
        catch (e) { emit('message', { data: { id: m.id, ok: false, error: String(e) } }); }
      });
    },
    addEventListener(type: string, cb: (ev: { data?: unknown }) => void) { (listeners[type] ??= []).push(cb); },
    terminate() { /* no-op */ },
  };
}

/* ---------------- 1) LUT 烘焙一致性 ---------------- */

describe('R10-B worker：LUT 烘焙（bakeLutOp）', () => {
  it('匹配 LUT（33³）与主线程 bakeMatchLUT 逐位相等', () => {
    const st = stateFixture();
    const viaOp = bakeLutOp({ state: st, size: 33, kind: 'match' });
    const direct = bakeMatchLUT(st, 33);
    expect(viaOp.size).toBe(direct.size);
    expect(viaOp.table.length).toBe(direct.table.length);
    let diff = 0;
    for (let i = 0; i < direct.table.length; i++) if (viaOp.table[i] !== direct.table[i]) diff++;
    expect(diff).toBe(0);
  });

  it('复合 LUT（33³，匹配∘look）与主线程 bakeRecipeLUT 逐位相等', () => {
    const st = stateFixture();
    const viaOp = bakeLutOp({ state: st, size: 33, kind: 'recipe' });
    const direct = bakeRecipeLUT(st, 33);
    let diff = 0;
    for (let i = 0; i < direct.table.length; i++) if (viaOp.table[i] !== direct.table[i]) diff++;
    expect(diff).toBe(0);
  });

  it('经 RPC（桩 worker）往返后与同步回退逐位相等', async () => {
    const st = stateFixture();
    const req = { state: st, size: 33 as const, kind: 'match' as const };
    const viaWorker = createWorkerClient<typeof req, ReturnType<typeof bakeLutOp>>({
      name: 'lut-stub', makeWorker: () => makeStubWorker((p) => bakeLutOp(p as typeof req)), sync: bakeLutOp, timeoutMs: 1000,
      workerGlobalAvailable: true,
    });
    const a = await viaWorker.run(req);
    expect(viaWorker.usingWorker).toBe(true);
    const b = bakeLutOp(req);   // 同步路径
    expect(a.size).toBe(b.size);
    let diff = 0;
    for (let i = 0; i < b.table.length; i++) if (a.table[i] !== b.table[i]) diff++;
    expect(diff).toBe(0);
  });
});

/* ---------------- 2) 匹配求解一致性 ---------------- */

describe('R10-B worker：匹配求解（solveMatchOp）', () => {
  const W = 48, H = 32;
  const req: SolveReq = {
    strategy: 'A',
    segs: [0, 1, 2].map((k) => ({ name: `seg${k}`, data: segData(W, H, k), w: W, h: H })),
  };

  it('策略 A：CDL / 统计距离与「库函数直接重算」逐值相等', () => {
    const res = solveMatchOp(req);
    // 独立重算：分位数 → 均值参考 → fitCdl → 拟合后距离
    const stats = req.segs.map((s) => quantileStats(s.data, s.w, s.h));
    const ref = stats.reduce((acc, s) => {
      for (let i = 0; i < 3; i++) { acc.p1[i] += s.p1[i] / 3; acc.p50[i] += s.p50[i] / 3; acc.p99[i] += s.p99[i] / 3; acc.mean[i] += s.mean[i] / 3; }
      acc.luma += s.luma / 3; acc.samples += s.samples;
      return acc;
    }, { p1: [0, 0, 0], p50: [0, 0, 0], p99: [0, 0, 0], mean: [0, 0, 0], luma: 0, samples: 0 } as QuantileStats);
    for (let i = 0; i < 3; i++) {
      const fit = fitCdl(stats[i], ref);
      const before = statDistance(stats[i], ref);
      const after = statDistance(applyCdlToStatsRef(req.segs[i].data, W, H, fit.cdl), ref);
      expect(res.segs[i].cdl).toEqual(fit.cdl);
      expect(res.segs[i].iterations).toBe(fit.iterations);
      expect(res.segs[i].converged).toBe(fit.converged);
      expect(res.segs[i].before).toBe(before);
      expect(res.segs[i].after).toBe(after);
    }
    const before = meanPairwiseDistance(stats);
    expect(res.pairwise.before).toBe(before);
    expect(res.pairwise.after).toBeGreaterThan(0);
  });

  it('策略 B（主段锚定）与库函数重算一致，且 ref = 首段统计', () => {
    const res = solveMatchOp({ ...req, strategy: 'B' });
    const stats = req.segs.map((s) => quantileStats(s.data, s.w, s.h));
    expect(res.ref).toEqual(stats[0]);
    expect(res.segs[1].cdl).toEqual(fitCdl(stats[1], stats[0]).cdl);
  });

  it('经 RPC（桩 worker）往返后与同步回退数值相等', async () => {
    const client = createWorkerClient<SolveReq, ReturnType<typeof solveMatchOp>>({
      name: 'match-stub', makeWorker: () => makeStubWorker((p) => solveMatchOp(p as SolveReq)), sync: solveMatchOp, timeoutMs: 1000,
      workerGlobalAvailable: true,
    });
    const a = await client.run(req);
    const b = solveMatchOp(req);
    expect(a.segs.map((s) => s.cdl)).toEqual(b.segs.map((s) => s.cdl));
    expect(a.pairwise).toEqual(b.pairwise);
  });
});

/* ---------------- 3) 批量打包一致性 ---------------- */

describe('R10-B worker：批量打包（buildPackOp）', () => {
  const packReq = (mode: 'cdl' | 'single'): PackReq => {
    const st = stateFixture();
    const entries: CdlEntry[] = [0, 1, 2].map((k) => ({
      name: `clip_${k}.png`,
      cdl: { slope: [1 + 0.1 * k, 1, 1 - 0.05 * k], offset: [0, 0, 0], power: [1, 1 + 0.02 * k, 1], sat: 1 },
      before: 0.1, after: 0.02, iterations: 5,
    }));
    return {
      state: st, recipeName: '批量匹配 · 测试', lutSize: 33, entries, strategy: 'A',
      packMode: mode, pipeline: 'rcm', createdAt: '2026-01-01T00:00:00.000Z',
    };
  };

  it('cdl 模式：8 个文件（含 1 个 .dctl）+ zip 魔数正确且 >500B', () => {
    const res = buildPackOp(packReq('cdl'));
    const names = res.files.map((f) => f.name);
    expect(names.length).toBe(8);
    expect(res.hasDctl).toBe(true);
    expect(res.dctlCount).toBe(1);
    expect(res.zip.length).toBeGreaterThan(500);
    expect([...res.zip.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('single 模式：7 + N 个文件（每段一个 .dctl）', () => {
    const res = buildPackOp(packReq('single'));
    expect(res.files.length).toBe(7 + 3);
    expect(res.dctlCount).toBe(3);
  });

  it('确定性：同输入两次调用 zip 字节完全相等', () => {
    const a = buildPackOp(packReq('cdl'));
    const b = buildPackOp(packReq('cdl'));
    expect(a.zip.length).toBe(b.zip.length);
    let diff = 0;
    for (let i = 0; i < a.zip.length; i++) if (a.zip[i] !== b.zip[i]) diff++;
    expect(diff).toBe(0);
  });

  it('经 RPC（桩 worker）往返后 zip 字节与同步回退相等', async () => {
    const req = packReq('cdl');
    const client = createWorkerClient<PackReq, ReturnType<typeof buildPackOp>>({
      name: 'pack-stub', makeWorker: () => makeStubWorker((p) => buildPackOp(p as PackReq)), sync: buildPackOp, timeoutMs: 1000,
      workerGlobalAvailable: true,
    });
    const a = await client.run(req);
    const b = buildPackOp(req);
    expect(a.files).toEqual(b.files);
    expect(a.zip.length).toBe(b.zip.length);
    let diff = 0;
    for (let i = 0; i < b.zip.length; i++) if (a.zip[i] !== b.zip[i]) diff++;
    expect(diff).toBe(0);
  });
});

/* ---------------- 4) 回退路径 ---------------- */

describe('R10-B worker：回退（不可用 / 构造失败 / 超时 / 崩溃）', () => {
  const req = { state: stateFixture(), size: 33 as const, kind: 'match' as const };

  it('typeof Worker === undefined（node 环境）→ 自动走同步路径且结果一致', async () => {
    // node 下无全局 Worker → ensureWorker 直接返回 null
    expect(typeof Worker).toBe('undefined');
    const client = createWorkerClient<typeof req, ReturnType<typeof bakeLutOp>>({
      name: 'no-worker', makeWorker: () => { throw new Error('不应被调用'); }, sync: bakeLutOp,
    });
    const a = await client.run(req);
    expect(client.usingWorker).toBe(false);
    const b = bakeLutOp(req);
    let diff = 0;
    for (let i = 0; i < b.table.length; i++) if (a.table[i] !== b.table[i]) diff++;
    expect(diff).toBe(0);
  });

  it('worker 构造抛异常 → 回退同步路径（usingWorker=false）', async () => {
    const client = createWorkerClient<typeof req, ReturnType<typeof bakeLutOp>>({
      name: 'ctor-throw', makeWorker: () => { throw new Error('构造失败'); }, sync: bakeLutOp, timeoutMs: 200,
      workerGlobalAvailable: true,
    });
    const a = await client.run(req);
    expect(client.usingWorker).toBe(false);
    expect(a.table.length).toBe(bakeLutOp(req).table.length);
  });

  it('worker 不响应 → 超时回退同步路径（结果可用且一致）', async () => {
    const client = createWorkerClient<typeof req, ReturnType<typeof bakeLutOp>>({
      name: 'silent', makeWorker: () => makeStubWorker(() => { throw new Error('不应被调用'); }, { silent: true }), sync: bakeLutOp, timeoutMs: 20,
      workerGlobalAvailable: true,
    });
    const a = await client.run(req);
    expect(client.usingWorker).toBe(false);   // 超时后已放弃该 worker
    const b = bakeLutOp(req);
    let diff = 0;
    for (let i = 0; i < b.table.length; i++) if (a.table[i] !== b.table[i]) diff++;
    expect(diff).toBe(0);
  });

  it('worker 触发 error 事件 → 待决请求回退同步路径', async () => {
    const listeners: Record<string, Array<(ev: { data?: unknown }) => void>> = {};
    const crash: WorkerLike = {
      postMessage() { queueMicrotask(() => { for (const cb of listeners['error'] ?? []) cb({}); }); },
      addEventListener(t, cb) { (listeners[t] ??= []).push(cb); },
      terminate() { /* no-op */ },
    };
    const client = createWorkerClient<typeof req, ReturnType<typeof bakeLutOp>>({
      name: 'crash', makeWorker: () => crash, sync: bakeLutOp, timeoutMs: 500,
      workerGlobalAvailable: true,
    });
    const a = await client.run(req);
    expect(client.usingWorker).toBe(false);
    expect(a.table.length).toBe(bakeLutOp(req).table.length);
  });

  it('disable() 后强制同步路径', async () => {
    const client = createWorkerClient<typeof req, ReturnType<typeof bakeLutOp>>({
      name: 'disabled', makeWorker: () => makeStubWorker((p) => bakeLutOp(p as typeof req)), sync: bakeLutOp, timeoutMs: 500,
      workerGlobalAvailable: true,
    });
    client.disable();
    const a = await client.run(req);
    expect(client.usingWorker).toBe(false);
    expect(a.table.length).toBe(bakeLutOp(req).table.length);
  });
});
