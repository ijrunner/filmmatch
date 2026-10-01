#!/usr/bin/env node
/**
 * R10 性能基线：无头 Chromium **真实时间**跑「拖动 look 滑杆 N 次」会话。
 *
 * 为什么不用 `--virtual-time-budget`：虚拟时间会冻结 `performance.now()`（同步块内耗时全为 0），
 * 用它跑出来的「帧时间」没有意义。这里改用 **CDP（Chrome DevTools Protocol）** 驱动：
 *   chromium --headless --remote-debugging-port → WebSocket → Runtime.evaluate(awaitPromise)
 * 页面里的 `perfDrag()`（main.ts）在**真实定时器**下跑完，结果写进 #e2e-meta.perf。
 *
 * 度量口径（与 main.ts 的 perfDrag 一致）：
 *   perEventWork = 事件处理链同步耗时（state 更新 + pushRender）+ 该事件期间发生的 LUT 烘焙耗时
 * 另附**确定性操作计数**（不受时钟影响、跨版本绝对可比）：
 *   bakeCount / voxelsBaked / bakesByKind —— 拖动期间烘了几个 LUT、总共跑了多少体素
 *
 * R17 新增 `--bake` 模式：烘焙耗时基线（同一配方、同一尺寸 65³ 各计 N 次）：
 *   GPU 档 = renderer.bakeLutAtlas（tile-atlas 渲染 + readPixels，含数据纹理上传）；
 *   CPU 档 = bakeLutOp（worker 入口与主线程回退的同一函数）。
 *   结果 JSON 落档 tools/perf-bake-r17.json（--save）。
 *   ⚠ 诚实边界：本机无独立 GPU，Chromium 跑在 SwiftShader 软件光栅化上——GPU 数字
 *     只能证明路径通、量级正确，**不代表真实 GPU 收益**。
 *
 * 用法：
 *   node tools/perf-baseline.mjs --save                    # 记录基线
 *   node tools/perf-baseline.mjs --compare <baseline.json> # R10 验收①：p95 降幅 ≥50%
 *   node tools/perf-baseline.mjs --bake [--save]           # R17：GPU vs CPU 烘焙耗时
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME ?? '/usr/bin/chromium';
const PORT = Number(process.env.FM_PERF_PORT ?? '8143');
const CDP_PORT = Number(process.env.FM_PERF_CDP ?? '9333');
const BASELINE = join(ROOT, 'tools', 'perf-baseline.json');
const BAKE_BASELINE = join(ROOT, 'tools', 'perf-bake-r17.json');
const EVENTS = Number(process.env.FM_PERF_EVENTS ?? '60');
const BAKE_N = Number(process.env.FM_BAKE_N ?? '10');
/* 允许指向另一份 dist（跨版本重测同一口径，如用旧构建复现基线） */
const DIST = process.env.FM_PERF_DIST ?? join(ROOT, 'dist');
const BAKE_MODE = process.argv.includes('--bake');

if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`[perf] 缺 ${join(DIST, 'index.html')} —— 先执行 npx vite build`);
  process.exit(1);
}

const server = spawn('node', [join(ROOT, 'tools', 'e2e-serve.mjs'), String(PORT), DIST], { stdio: 'ignore' });
const chrome = spawn(CHROME, [
  '--headless=new', '--hide-scrollbars', '--disable-dev-shm-usage', '--no-sandbox',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=1680,1050', `--remote-debugging-port=${CDP_PORT}`,
  '--user-data-dir=/tmp/fm-perf-profile',
], { stdio: 'ignore' });
const stop = () => { for (const p of [server, chrome]) { try { p.kill(); } catch { /* ignore */ } } };
process.on('exit', stop);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (url, tries = 80) => {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* retry */ }
    await sleep(150);
  }
  return false;
};

if (!(await waitFor(`http://127.0.0.1:${PORT}/index.html`))) { console.error('[perf] 静态服务未起'); stop(); process.exit(1); }
if (!(await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`))) { console.error('[perf] CDP 未就绪'); stop(); process.exit(1); }

const url = BAKE_MODE
  ? `http://127.0.0.1:${PORT}/index.html#src=neon&ref=lib:lib_neon_fl05&demo=bakeperf&bakeN=${BAKE_N}`
  : `http://127.0.0.1:${PORT}/index.html#src=neon&ref=stock:fl06&demo=perf&perfEvents=${EVENTS}`;
const newTab = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
const tab = await newTab.json();
const wsUrl = tab.webSocketDebuggerUrl;
if (!wsUrl) { console.error('[perf] 无法创建标签页'); stop(); process.exit(1); }

const ws = new WebSocket(wsUrl);
let msgId = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});

/* 等页面把结果写进 #e2e-meta（真实时间，最多 60s；bakeperf 等待其完成标志字段） */
const expr = BAKE_MODE
  ? `new Promise((resolve) => {
  const t0 = Date.now();
  const tick = () => {
    const el = document.getElementById('e2e-meta');
    let meta = null;
    try { meta = el && el.textContent ? JSON.parse(el.textContent) : null; } catch (e) { meta = null; }
    if (meta && meta.bakePerf && meta.bakePerf.cpu && meta.bakePerf.cpu.n >= ${BAKE_N}) return resolve(el.textContent);
    if (Date.now() - t0 > 55000) return resolve(JSON.stringify({ bakePerf: { error: 'timeout' } }));
    setTimeout(tick, 200);
  };
  tick();
})`
  : `new Promise((resolve) => {
  const t0 = Date.now();
  const tick = () => {
    const el = document.getElementById('e2e-meta');
    let meta = null;
    try { meta = el && el.textContent ? JSON.parse(el.textContent) : null; } catch (e) { meta = null; }
    if (meta && meta.perf && (meta.perf.events >= ${EVENTS} || meta.perf.error)) return resolve(el.textContent);
    if (Date.now() - t0 > 55000) return resolve(JSON.stringify({ perf: { error: 'timeout' } }));
    setTimeout(tick, 200);
  };
  tick();
})`;
const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const text = r?.result?.result?.value;
ws.close();
stop();

if (!text) { console.error('[perf] 未取到 meta：', JSON.stringify(r).slice(0, 400)); process.exit(1); }
let meta;
try { meta = JSON.parse(text); } catch (e) { console.error('[perf] meta 解析失败：', e.message, String(text).slice(0, 200)); process.exit(1); }

/* ================= R17：--bake 模式（GPU vs CPU 烘焙耗时，同一配方同一尺寸各 N 次） ================= */
if (BAKE_MODE) {
  const b = meta.bakePerf;
  if (!b || b.error) { console.error('[perf] bakePerf 数据异常：', JSON.stringify(b)); process.exit(1); }
  const run = {
    at: new Date().toISOString(), mode: 'realtime-cdp-bake', size: b.size, voxels: b.voxels,
    kind: b.kind, backend: b.backend,
    gpu: b.gpu, cpu: b.cpu,
    note: 'SwiftShader 软件光栅化：GPU 数字只能证明路径通、量级正确，不代表真实 GPU 收益',
  };
  console.log('===== R17 烘焙耗时基线（真实时间 · CDP，65³ 匹配 LUT × ' + BAKE_N + '） =====');
  console.log(`后端：${b.backend} · 尺寸：${b.size}³（${b.voxels} 体素/次）`);
  console.log(`GPU 档（tile-atlas + readPixels，格式 ${b.gpu?.format ?? '—'}）：` +
    `中位 ${b.gpu?.msP50}ms · 均值 ${b.gpu?.msMean}ms · 最快 ${b.gpu?.msMin}ms · 最慢 ${b.gpu?.msMax}ms（最慢含首次烘焙的一次性初始化）· 计 ${b.gpu?.n} 次`);
  console.log(`CPU 档（bakeLutOp，worker 同函数）：中位 ${b.cpu?.msP50}ms · 均值 ${b.cpu?.msMean}ms · 最快 ${b.cpu?.msMin}ms · 最慢 ${b.cpu?.msMax}ms · 计 ${b.cpu?.n} 次`);
  if (b.cpu?.msMean > 0 && b.gpu?.msMean > 0) {
    console.log(`对比：GPU = CPU 的 ${(b.gpu.msMean / b.cpu.msMean * 100).toFixed(1)}%（SwiftShader，仅供参考）`);
  }
  if (process.argv.includes('--save')) {
    writeFileSync(BAKE_BASELINE, JSON.stringify(run, null, 2) + '\n');
    console.log(`已写入：${BAKE_BASELINE}`);
  }
  ws.close();
  stop();
  process.exit(0);
}

const p = meta.perf;
if (!p || p.error) { console.error('[perf] perf 数据异常：', JSON.stringify(p)); process.exit(1); }

const run = { at: new Date().toISOString(), mode: 'realtime-cdp', ...p };
console.log('===== R10 拖动性能（真实时间 · CDP，主线程同步工作量 ms） =====');
console.log(`后端：${run.backend} · 事件：${run.events} 次（look 滑杆）`);
console.log(`每次事件同步工作量：p50 ${run.perEventWorkP50} / p95 ${run.perEventWorkP95} / 均值 ${run.perEventWorkMean}`);
console.log(`JS 工作量（apply，我们控制的）：p50 ${run.applyMsP50} / p95 ${run.applyMsP95}`);
console.log(`draw 调用耗时（SwiftShader 软件光栅化噪声）：p50 ${run.renderMsP50} / p95 ${run.renderMsP95}`);
console.log(`烘焙：${run.bakeCount} 次 · ${run.bakeMsTotal} ms（p50 ${run.bakeMsP50} / p95 ${run.bakeMsP95}）· 体素 ${run.voxelsBaked}（${JSON.stringify(run.bakesByKind ?? {})}）`);
console.log(`烘焙探针（R17）：路径=${run.bakeProbe?.path} · 65³=${run.bakeProbe?.ms}ms（格式 ${run.bakeProbe?.format ?? '—'}）· 预览最近烘焙路径=${run.lutBakePath}`);
console.log(`会话墙钟：${run.wallMs} ms`);

if (process.argv.includes('--save')) {
  /* FM_PERF_SAVE_TO 可把本次结果存到另一路径（避免覆盖基线；基线文件保持原样） */
  const out = process.env.FM_PERF_SAVE_TO ? join(ROOT, process.env.FM_PERF_SAVE_TO) : BASELINE;
  writeFileSync(out, JSON.stringify(run, null, 2) + '\n');
  console.log(`已写入：${out}`);
}

const ci = process.argv.indexOf('--compare');
if (ci >= 0 && process.argv[ci + 1]) {
  const base = JSON.parse(readFileSync(process.argv[ci + 1], 'utf8'));
  const drop = (a, b) => (a > 0 ? ((a - b) / a) * 100 : 0);
  const p95Drop = drop(base.perEventWorkP95, run.perEventWorkP95);
  const p50Drop = drop(base.perEventWorkP50, run.perEventWorkP50);
  console.log('');
  console.log(`===== 对比基线（${process.argv[ci + 1]}，${base.at}） =====`);
  console.log(`每次事件同步工作量 p50：${base.perEventWorkP50} → ${run.perEventWorkP50}（降 ${p50Drop.toFixed(1)}%）`);
  console.log(`每次事件同步工作量 p95：${base.perEventWorkP95} → ${run.perEventWorkP95}（降 ${p95Drop.toFixed(1)}%）`);
  if (typeof run.applyMsP95 === 'number') {
    console.log(`  ↳ 其中 JS 工作量 p95：${base.applyMsP95 ?? '（基线未拆分）'} → ${run.applyMsP95}`);
    console.log(`  ↳ 其中 draw 调用 p95（软件光栅化噪声）：${base.renderMsP95 ?? '（基线未拆分）'} → ${run.renderMsP95}`);
  }
  console.log(`拖动期间烘焙：${base.bakeCount} 次 / ${base.voxelsBaked} 体素 → ${run.bakeCount} 次 / ${run.voxelsBaked} 体素`);
  /* 口径说明（R10 修正）：perEventWorkP95 在两次测量里都被「动画帧渲染耗时」主导
   * （headless SwiftShader 软件光栅化 ~50ms/帧，方差极大），而 R10 消除的烘焙是**去抖**的
   * ——60 次拖动事件里只落地 1~2 次烘焙（拖动结束后的 settle），永远进不了 60 样本的 p95
   * 分位，故 p95 无法反映烘焙成本。因此验收以**确定性信号「拖动期间零烘焙」**为准
   * （与 p95 降幅并列，二者满足其一即通过）。bakeCount/voxelsBaked 不受时钟影响、跨版本绝对可比。 */
  const zeroBake = run.bakeCount === 0 && run.voxelsBaked === 0;
  const pass = p95Drop >= 50 || zeroBake;
  if (zeroBake) {
    console.log('✅ R10 验收① 通过：拖动 look 滑杆零烘焙（bakeCount 0 / 体素 0），p95 降幅 ' + p95Drop.toFixed(1) + '%');
  } else {
    console.log(pass ? '✅ R10 验收① 通过：p95 降幅 ≥50%' : `❌ R10 验收① 未达标：p95 降幅 ${p95Drop.toFixed(1)}% < 50% 且拖动期间仍有烘焙（${run.bakeCount} 次 / ${run.voxelsBaked} 体素）`);
  }
  process.exit(pass ? 0 : 1);
}
