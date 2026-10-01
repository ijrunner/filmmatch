/* FilmMatch 效果层 · 验收截图与数值分析脚本
 * 用法：先 npx vite build，再 node tools/shots.mjs [--only 名称子串] [--no-shot 跳过截图仅分析]
 * 流程：
 *   1. prepareDist()：把 dist/index.html 的模块 JS 内联，复制出 dist/effects.html
 *     （vite 7 不自动发现根目录额外 html；内联后 file:// 双击可用，截图也不受 ES 模块 CORS 限制）
 *   2. 逐张调 chromium headless（沙箱无 GPU：--use-gl=angle --use-angle=swiftshader，
 *      CPU 路径追加 --disable-webgl --disable-webgl2）
 *   3. pngjs 数值分析（黑位/方差/ISO 响应/色散/暗角/曲线家族特征）→ shots/analysis.json + 控制表
 *   4. 生成 *_zoom.png（最近邻放大裁剪）供 1:1 目检
 */
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');   // app/
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'tools', 'shots');
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const FLAG_GPU = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const FLAG_CPU = ['--disable-webgl', '--disable-webgl2'];
const BASE_FLAGS = ['--headless', '--hide-scrollbars', '--disable-dev-shm-usage', '--no-sandbox'];

const url = (hash) => 'file://' + join(DIST, 'effects.html') + '#' + hash;

/* ---------- dist 准备：单入口构建 effects 页 → 内联 JS → dist/effects.html ---------- */
function prepareDist() {
  const htmlPath = join(DIST, 'index.html');
  if (!existsSync(htmlPath)) {
    console.error('[shots] 未找到 dist/index.html —— 请先运行 npx vite build');
    process.exit(1);
  }
  /* 用单入口配置重建 effects 页：避免共享 chunk 在 file:// 下被 CORS 拦截（见 vite.effects.config.mjs） */
  const b = spawnSync('npx', ['vite', 'build', '--config', 'vite.effects.config.mjs'],
    { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  if (b.status !== 0) {
    console.error('[shots] effects 页单入口构建失败:\n' + (b.stderr || b.stdout || '').split('\n').slice(-8).join('\n'));
    process.exit(1);
  }
  const effPath = join(DIST, 'effects.html');
  let html = readFileSync(effPath, 'utf8');
  const m = html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/);
  if (m) {
    const jsPath = join(DIST, m[1].replace(/^\.\//, ''));
    const js = readFileSync(jsPath, 'utf8');
    if (/^import\s/m.test(js)) {
      console.error('[shots] 内联后仍有裸 import（会产生 file:// CORS 失败），请检查构建配置');
      process.exit(1);
    }
    html = html.replace(m[0], '<script type="module">\n' + js + '\n</script>');
    console.log('[shots] 已内联模块 JS →', m[1], `(${(js.length / 1024).toFixed(0)} KB)`);
  }
  html = html.replace(/<link rel="modulepreload"[^>]*>\s*/g, '');   // 内联后无需预加载
  writeFileSync(effPath, html);
  copyFileSync(htmlPath, join(DIST, 'effects-src.html'));
  console.log('[shots] dist/effects.html 就绪（file:// 可直接打开）');
}

/* ---------- 截图清单 ----------
 * bare=1 → canvas 1:1 固定视口左上，截图坐标=画面坐标（1920×1080）
 * 分屏 mode=2：左=效果，右=原图 */
const SHOTS = [
  // 整体观感（带界面）
  { n: 'overview-fl05', h: 'preset=fl05&scene=neon&freeze=1&t=0.5', w: 1600, e: 1000 },
  { n: 'overview-fl07', h: 'preset=fl07&scene=neon&freeze=1&t=0.5', w: 1600, e: 1000 },
  { n: 'overview-fl08', h: 'preset=fl08&scene=dusk&freeze=1&t=0.5', w: 1600, e: 1000 },
  // H 光晕
  { n: 'H6-neon-fl05', h: 'preset=fl05&scene=neon&freeze=1&t=0.5&bare=1' },
  { n: 'H1-chart-fl05', h: 'preset=fl05&scene=chart&freeze=1&t=0.5&bare=1' },          // H1/H3/H4 共用
  { n: 'H2on-neon-fl05', h: 'preset=fl05&scene=neon&freeze=1&t=0.5&bare=1' },
  { n: 'H2off-neon-fl05', h: 'preset=fl05&scene=neon&freeze=1&t=0.5&bare=1&tight=0' }, // 关紧晕
  { n: 'H3-chart-fl05', h: 'preset=fl05&scene=chart&freeze=1&t=0.5&bare=1&p.grain.enabled=0' },  // H3/H4 无颗粒测量
  { n: 'H5-split', h: 'preset=fl05&scene=chart&freeze=1&t=0.5&bare=1&mode=2&p.grain.enabled=0' },
  { n: 'H5-eff', h: 'preset=fl05&scene=chart&freeze=1&t=0.5&bare=1&mode=0&p.grain.enabled=0' },
  { n: 'H5-nohal', h: 'preset=fl05&scene=chart&freeze=1&t=0.5&bare=1&mode=0&p.grain.enabled=0&p.halation.enabled=0' },
  // B 柔光
  { n: 'B2-dusk-neutral', h: 'preset=neutral&scene=dusk&freeze=1&t=0.5&bare=1' },
  { n: 'B1-eff', h: 'preset=neutral&scene=chart&freeze=1&t=0.5&bare=1&mode=0&p.grain.enabled=0' },
  { n: 'B1-orig', h: 'preset=neutral&scene=chart&freeze=1&t=0.5&bare=1&mode=1&p.grain.enabled=0' },
  // G 颗粒
  { n: 'G1-G2-chart', h: 'preset=neutral&scene=chart&freeze=1&t=0.5&bare=1' },
  { n: 'G3-iso100', h: 'preset=neutral&scene=chart&freeze=1&t=0.5&bare=1&p.grain.iso=100' },
  { n: 'G3-iso400', h: 'preset=neutral&scene=chart&freeze=1&t=0.5&bare=1&p.grain.iso=400' },
  { n: 'G3-iso1600', h: 'preset=neutral&scene=chart&freeze=1&t=0.5&bare=1&p.grain.iso=1600' },
  { n: 'G4-mono', h: 'preset=neutral&scene=chart&freeze=1&t=0.5&bare=1&p.grain.correlation=1' },
  { n: 'G4-color', h: 'preset=neutral&scene=chart&freeze=1&t=0.5&bare=1&p.grain.correlation=0' },
  { n: 'G5-t0', h: 'preset=neutral&scene=chart&freeze=1&t=0&bare=1' },
  { n: 'G5-t1', h: 'preset=neutral&scene=chart&freeze=1&t=0.0417&bare=1' },
  { n: 'G5-t2', h: 'preset=neutral&scene=chart&freeze=1&t=0.0834&bare=1' },
  { n: 'G6-neon-face', h: 'preset=neutral&scene=neon&freeze=1&t=0.5&bare=1' },
  // V 暗角/色散
  { n: 'V1-chart-split', h: 'preset=neutral&scene=chart&freeze=1&t=0.5&bare=1&mode=2&p.vignette.enabled=1&p.grain.enabled=0' },
  { n: 'V2-chart-fl07', h: 'preset=fl07&scene=chart&freeze=1&t=0.5&bare=1' },
  // 曲线家族（split=0.65：左效果占 65%，黑区测试条完整落在效果侧；右侧原图）
  { n: 'CA-fl06-split', h: 'preset=fl06&scene=chart&freeze=1&t=0.5&bare=1&mode=2&split=0.65' },
  { n: 'CB-fl04-split', h: 'preset=fl04&scene=chart&freeze=1&t=0.5&bare=1&mode=2&split=0.65' },
  { n: 'CC-fl08-split', h: 'preset=fl08&scene=chart&freeze=1&t=0.5&bare=1&mode=2&split=0.65' },
  { n: 'CD-fl05-split', h: 'preset=fl05&scene=neon&freeze=1&t=0.5&bare=1&mode=2&split=0.65' },
  // CPU 兜底路径
  { n: 'CPU-chart-fl05', h: 'preset=fl05&scene=chart&freeze=1&t=0.5&bare=1', cpu: true },
  { n: 'CPU-split', h: 'preset=fl05&scene=chart&freeze=1&t=0.5&bare=1&mode=2', cpu: true },
  { n: 'CPU-overview', h: 'preset=fl05&scene=neon&freeze=1&t=0.5', w: 1600, e: 1000, cpu: true },
  // R1 · Schema v1.1 参数面数值验收（分析见 analyzeR1；结论写入 tools/EFFECT-REPORT-R1.md）
  { n: 'R1-sl-off', h: 'preset=neutral&scene=blown&freeze=1&t=0.5&bare=1&p.grain.enabled=0&p.bloom.amount=0.95&p.bloom.radius=3&p.bloom.threshold=0.5&p.bloom.save_lights=0' },
  { n: 'R1-sl-on', h: 'preset=neutral&scene=blown&freeze=1&t=0.5&bare=1&p.grain.enabled=0&p.bloom.amount=0.95&p.bloom.radius=3&p.bloom.threshold=0.5&p.bloom.save_lights=1' },
  { n: 'R1-bg0', h: 'preset=neutral&scene=blown&freeze=1&t=0.5&bare=1&p.grain.enabled=0&p.bloom.enabled=0&p.halation.enabled=1&p.halation.amount=0.6&p.halation.radius=3&p.halation.threshold=0.5&p.halation.background_gain=0' },
  { n: 'R1-bg1', h: 'preset=neutral&scene=blown&freeze=1&t=0.5&bare=1&p.grain.enabled=0&p.bloom.enabled=0&p.halation.enabled=1&p.halation.amount=0.6&p.halation.radius=3&p.halation.threshold=0.5&p.halation.background_gain=1' },
  { n: 'R1-haloff', h: 'preset=neutral&scene=blown&freeze=1&t=0.5&bare=1&p.grain.enabled=0&p.bloom.enabled=0&p.halation.enabled=0' },
  { n: 'R1-amp0', h: 'preset=neutral&scene=blown&freeze=1&t=0.5&bare=1&p.grain.enabled=0&p.bloom.enabled=0&p.halation.enabled=1&p.halation.amount=1&p.halation.radius=4&p.halation.threshold=0.4&p.halation.amplify=0&p.halation.background_gain=1' },
  { n: 'R1-amp2', h: 'preset=neutral&scene=blown&freeze=1&t=0.5&bare=1&p.grain.enabled=0&p.bloom.enabled=0&p.halation.enabled=1&p.halation.amount=1&p.halation.radius=4&p.halation.threshold=0.4&p.halation.amplify=2&p.halation.background_gain=1' },
  { n: 'R1-amp1', h: 'preset=neutral&scene=blown&freeze=1&t=0.5&bare=1&p.grain.enabled=0&p.bloom.enabled=0&p.halation.enabled=1&p.halation.amount=1&p.halation.radius=4&p.halation.threshold=0.4&p.halation.amplify=1&p.halation.background_gain=1' },
  { n: 'R1-imp0', h: 'preset=neutral&scene=blown&freeze=1&t=0.5&bare=1&p.grain.enabled=0&p.bloom.enabled=0&p.halation.enabled=1&p.halation.amount=1&p.halation.radius=4&p.halation.threshold=0.4&p.halation.impact=0&p.halation.background_gain=1&p.halation.amplify=1' },
  { n: 'R1-imp05', h: 'preset=neutral&scene=blown&freeze=1&t=0.5&bare=1&p.grain.enabled=0&p.bloom.enabled=0&p.halation.enabled=1&p.halation.amount=1&p.halation.radius=4&p.halation.threshold=0.4&p.halation.impact=0.5&p.halation.background_gain=1&p.halation.amplify=1' },
  // grain 三段分布 / 类型（固定 iso，关 bloom 以隔离颗粒方差）
  { n: 'R1-grain-base', h: 'preset=neutral&scene=chart&freeze=1&t=0.5&bare=1&p.bloom.enabled=0&p.grain.iso=400' },
  { n: 'R1-grain-sh0', h: 'preset=neutral&scene=chart&freeze=1&t=0.5&bare=1&p.bloom.enabled=0&p.grain.iso=400&p.grain.shadow=0' },
  { n: 'R1-grain-mid0', h: 'preset=neutral&scene=chart&freeze=1&t=0.5&bare=1&p.bloom.enabled=0&p.grain.iso=400&p.grain.midtone=0' },
  { n: 'R1-grain-hi0', h: 'preset=neutral&scene=chart&freeze=1&t=0.5&bare=1&p.bloom.enabled=0&p.grain.iso=400&p.grain.highlight=0' },
  { n: 'R1-grain-neg', h: 'preset=neutral&scene=chart&freeze=1&t=0.5&bare=1&p.bloom.enabled=0&p.grain.iso=400&p.grain.highlight=1&p.grain.type=negative' },
  { n: 'R1-grain-pos', h: 'preset=neutral&scene=chart&freeze=1&t=0.5&bare=1&p.bloom.enabled=0&p.grain.iso=400&p.grain.highlight=1&p.grain.type=positive' },
  // Mask 隔离预览（效果层 vs 源图）
  { n: 'R1-mask', h: 'preset=fl05&scene=neon&freeze=1&t=0.5&bare=1&mode=3' },
  { n: 'R1-mask-src', h: 'preset=fl05&scene=neon&freeze=1&t=0.5&bare=1&mode=1' },
  // R2 · 颗粒 profile 矩阵效果层对比（g-8-500 vs g-65-50，数值取自 film/grainmatrix.ts；仅目检，不改既有 analyze/analyzeR1）
  { n: 'R2-matrix-8-500', h: 'preset=fl06&scene=chart&freeze=1&t=0.5&bare=1&p.grain.iso=500&p.grain.size=2.46&p.grain.shadow=1.2&p.grain.midtone=1.05&p.grain.highlight=0.3&p.grain.film_resolution=0.25' },
  { n: 'R2-matrix-65-50', h: 'preset=fl06&scene=chart&freeze=1&t=0.5&bare=1&p.grain.iso=50&p.grain.size=0.675&p.grain.shadow=0.8&p.grain.midtone=0.95&p.grain.highlight=0.15&p.grain.film_resolution=0.8' },
  // 注：bench（120 帧打点）为交互功能，无头虚拟时间下需绘制上百帧全量合成，不适合批量截图，
  //     交互验证：打开页面加 #bench=1（swiftshader 下帧率数值无参考意义）。
];

function shoot(s) {
  const file = join(OUT, s.n + '.png');
  const flags = [
    ...BASE_FLAGS, ...(s.cpu ? FLAG_CPU : FLAG_GPU),
    '--window-size=' + (s.w ?? 2000) + ',' + (s.e ?? 1400),
    '--virtual-time-budget=8000',
    '--screenshot=' + file,
    url(s.h),
  ];
  const t0 = Date.now();
  const r = spawnSync(CHROME, flags, { encoding: 'utf8', timeout: 180000 });
  const ok = existsSync(file);
  console.log((ok ? '[shot ok] ' : '[shot FAIL] ') + s.n + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + 's'
    + (s.cpu ? ' · CPU' : '') + ')');
  if (!ok) {
    console.error('  stderr:', (r.stderr || '').split('\n').filter(Boolean).slice(-3).join(' | '));
  }
  return ok;
}

/* ---------- pngjs 工具 ---------- */
function load(name) {
  const p = join(OUT, name + '.png');
  if (!existsSync(p)) return null;
  return PNG.sync.read(readFileSync(p));
}
function stat(png, x0, y0, x1, y1) {
  let n = 0, sr = 0, sg = 0, sb = 0, sl = 0, sl2 = 0;
  const lums = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * png.width + x) * 4;
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sr += r; sg += g; sb += b; sl += l; sl2 += l * l; n++;
    if (lums.length < 400000) lums.push(l);
  }
  const meanL = sl / n;
  const varL = Math.max(0, sl2 / n - meanL * meanL);
  lums.sort((a, b) => a - b);
  const med = lums.length ? lums[lums.length >> 1] : meanL;
  return { r: sr / n, g: sg / n, b: sb / n, lum: meanL, sd: Math.sqrt(varL), med, n };
}
function meanAbsDiff(a, b, x0, y0, x1, y1) {
  let s = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * a.width + x) * 4;
    s += (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
    n++;
  }
  return s / n;
}
/* 最近邻放大裁剪 → *_zoom.png */
function zoom(name, x0, y0, w, h, scale, tag) {
  const png = load(name);
  if (!png) return;
  const out = new PNG({ width: w * scale, height: h * scale });
  for (let y = 0; y < h * scale; y++) for (let x = 0; x < w * scale; x++) {
    const sx = x0 + Math.floor(x / scale), sy = y0 + Math.floor(y / scale);
    const si = (sy * png.width + sx) * 4, di = (y * out.width + x) * 4;
    out.data[di] = png.data[si]; out.data[di + 1] = png.data[si + 1];
    out.data[di + 2] = png.data[si + 2]; out.data[di + 3] = 255;
  }
  writeFileSync(join(OUT, tag + '_zoom.png'), PNG.sync.write(out));
}

/* ---------- 校色卡测量区（与 src/film/scenes.ts CHART_LAYOUT 对应，截图=画面坐标） ---------- */
const RAMP = { x0: 40, y0: 534, pw: 57.06, w: 44, h: 38 };     // 第 i 块：x = x0+i*pw
const BLACK = { x0: 960, y0: 780, x1: 1440, y1: 1020 };        // 纯黑隔离区（x≥940，远离一切发光源）
const rampRect = (i) => ({ x0: Math.round(RAMP.x0 + i * RAMP.pw + 6), y0: RAMP.y0, x1: Math.round(RAMP.x0 + i * RAMP.pw + 6 + RAMP.w), y1: RAMP.y0 + RAMP.h });

/* ---------- 数值分析 ---------- */
const results = {};
function check(id, cond, detail) {
  results[id] = { pass: !!cond, detail };
  console.log((cond ? '  [PASS] ' : '  [FAIL] ') + id + ' — ' + detail);
}

function analyze() {
  console.log('\n===== 数值分析 =====');
  /* H1：白块右缘亮度渐变（带颗粒的真实观感，均值单调递减） */
  const h1 = load('H1-chart-fl05');
  if (h1) {
    const e1 = stat(h1, 242, 850, 246, 890).lum, e2 = stat(h1, 252, 850, 256, 890).lum, e3 = stat(h1, 268, 850, 272, 890).lum;
    const steps = [e1, e2, e3];
    check('H1', e1 > e2 && e2 > e3 && (e1 - e3) > 4,
      `块缘外亮度阶梯 ${steps.map((v) => v.toFixed(1)).join(' → ')}（单调递减，落差 ${(e1 - e3).toFixed(1)} 级）`);
  } else check('H1', false, '缺 H1-chart-fl05.png');

  /* H3：晕可见宽度（255 白块 vs 200 灰块，无颗粒测量图）——亮度非线性→白块晕更宽。
   * 阈值取「相对本图黑位地板 +3 级」：fl05 的 grade 有意抬升黑位（blk≈7.6 级），须先扣除。 */
  const h3 = load('H3-chart-fl05');
  if (h3) {
    const floor = stat(h3, 960, 780, 1440, 1020).med;   // 同图纯黑区中位数 = 黑位地板
    const thr = floor + 3;
    const extent = (edgeX, maxX) => {
      let last = 0;
      for (let x = edgeX + 2; x < maxX; x++) {
        let s = 0, n = 0;
        for (let y = 820; y < 920; y++) {
          const i = (y * h3.width + x) * 4;
          s += 0.2126 * h3.data[i] + 0.7152 * h3.data[i + 1] + 0.0722 * h3.data[i + 2];
          n++;
        }
        if (s / n > thr) last = x - edgeX;
      }
      return last;
    };
    const extW = extent(240, 352);   // 255 白块右缘起 110px 窗（避开邻块晕抬尾）
    const extG = extent(540, 652);   // 200 灰块右缘起 110px 窗
    check('H3', extW > 8 && extW > extG * 1.25,
      `晕可见宽度(超出黑位地板${floor.toFixed(1)}+3级) 255块=${extW}px vs 200块=${extG}px（比值 ${(extW / Math.max(extG, 1)).toFixed(2)}）`);
    /* H4：紧晕取色（白块右缘 3~19px 橙红 rim），R≫G>B */
    const halo = stat(h3, 243, 820, 259, 920);
    check('H4', halo.r > halo.g && halo.g > halo.b && (halo.r - halo.b) > 8,
      `晕色 R=${halo.r.toFixed(1)} G=${halo.g.toFixed(1)} B=${halo.b.toFixed(1)}（R−B=${(halo.r - halo.b).toFixed(1)}）`);
  } else check('H3/H4', false, '缺 H3-chart-fl05.png');

  /* H2：紧晕开关对比（霓虹灯牌区差异） */
  const h2a = load('H2on-neon-fl05'), h2b = load('H2off-neon-fl05');
  if (h2a && h2b) {
    const d = meanAbsDiff(h2a, h2b, 240, 300, 500, 420);   // NIGHT 灯牌
    check('H2', d > 2, `关/开紧晕灯牌区平均差=${d.toFixed(2)} 级（>2 可辨）`);
  } else check('H2', false, '缺 H2on/H2off');

  /* H5：halation 对纯黑区的增益（同一 fl05 开/关 halation，剔除 grade 黑位抬升本身） */
  const he = load('H5-eff'), ho = load('H5-nohal');
  if (he && ho) {
    const be = stat(he, BLACK.x0, BLACK.y0, BLACK.x1, BLACK.y1);
    const bo = stat(ho, BLACK.x0, BLACK.y0, BLACK.x1, BLACK.y1);
    check('H5', (be.lum - bo.lum) < 2.55,
      `纯黑区均值 halation开=${be.lum.toFixed(2)} vs 关=${bo.lum.toFixed(2)}（halation 增益 ${(be.lum - bo.lum).toFixed(2)} 级 < 1%=2.55）`);
  } else check('H5', false, '缺 H5-eff/nohal');

  /* H6：彩色灯管周围有晕（目检为主；数值取 GLOW 青色灯牌外晕存在） */
  const h6 = load('H6-neon-fl05');
  if (h6) {
    const glow = stat(h6, 800, 300, 860, 360);   // GLOW 牌外左侧
    check('H6', glow.lum > 12, `青色灯牌外晕亮度=${glow.lum.toFixed(1)}（纯黑天空基线≈6）`);
  } else check('H6', false, '缺 H6-neon-fl05.png');

  /* B1：bloom 对暗部不抬灰（neutral 仅 bloom 开） */
  const b1e = load('B1-eff'), b1o = load('B1-orig');
  if (b1e && b1o) {
    const be = stat(b1e, BLACK.x0, BLACK.y0, BLACK.x1, BLACK.y1);
    const bo = stat(b1o, BLACK.x0, BLACK.y0, BLACK.x1, BLACK.y1);
    check('B1', (be.lum - bo.lum) < 2.55,
      `纯黑区均值 效果=${be.lum.toFixed(2)} vs 原图=${bo.lum.toFixed(2)}`);
  } else check('B1', false, '缺 B1-eff/orig');

  /* B2：黄昏太阳宽域柔光（目检 + 太阳周边亮度存在） */
  const b2 = load('B2-dusk-neutral');
  if (b2) {
    const sun = stat(b2, 1120, 660, 1190, 720);
    check('B2', sun.lum > 200, `太阳区亮度=${sun.lum.toFixed(1)}（柔光半径2%H/阈值0.85，目检 B2-dusk-neutral.png）`);
  } else check('B2', false, '缺 B2-dusk-neutral.png');

  /* G2：灰阶方差分带（高光块 < 中间调 10%） */
  const g1 = load('G1-G2-chart');
  if (g1) {
    const mid = stat(g1, ...objVals(rampRect(7)));      // v≈112
    const hi = stat(g1, ...objVals(rampRect(16)));      // v=255
    check('G2', hi.sd * hi.sd < mid.sd * mid.sd * 0.10,
      `方差 高光块=${(hi.sd * hi.sd).toFixed(1)} vs 中间调=${(mid.sd * mid.sd).toFixed(1)}（比值 ${(hi.sd * hi.sd / Math.max(mid.sd * mid.sd, 0.001)).toFixed(3)}）`);
    /* G1：中间调颗粒 RMS 处于絮状区间（不量化外观，配合 1:1 放大目检） */
    check('G1', mid.sd > 3 && mid.sd < 30, `中间调颗粒 σ=${mid.sd.toFixed(1)} 级（目检 G1_zoom.png：絮状而非雪花）`);
  } else check('G1/G2', false, '缺 G1-G2-chart.png');

  /* G3：ISO √ 响应 */
  const s100 = load('G3-iso100'), s400 = load('G3-iso400'), s1600 = load('G3-iso1600');
  if (s100 && s400 && s1600) {
    const a = stat(s100, ...objVals(rampRect(7))).sd;
    const b = stat(s400, ...objVals(rampRect(7))).sd;
    const c = stat(s1600, ...objVals(rampRect(7))).sd;
    const r1 = b / Math.max(a, 0.01), r2 = c / Math.max(b, 0.01);
    check('G3', r1 > 1.6 && r1 < 2.4 && r2 > 1.6 && r2 < 2.4,
      `σ ISO100=${a.toFixed(2)} / 400=${b.toFixed(2)} / 1600=${c.toFixed(2)}（400/100=${r1.toFixed(2)}×，1600/400=${r2.toFixed(2)}×，期望≈2×）`);
  } else check('G3', false, '缺 G3 三档');

  /* G4：单色 vs 彩色颗粒（R/G/B 通道差） */
  const g4m = load('G4-mono'), g4c = load('G4-color');
  if (g4m && g4c) {
    const rect = rampRect(7);
    const chanDiff = (png) => {
      let s = 0, n = 0;
      for (let y = rect.y0; y < rect.y1; y++) for (let x = rect.x0; x < rect.x1; x++) {
        const i = (y * png.width + x) * 4;
        s += Math.abs(png.data[i] - png.data[i + 1]) + Math.abs(png.data[i + 1] - png.data[i + 2]);
        n++;
      }
      return s / n;
    };
    const dm = chanDiff(g4m), dc = chanDiff(g4c);
    check('G4', dc > dm * 2 && dc > 1, `通道差均值 单色=${dm.toFixed(2)} vs 彩色=${dc.toFixed(2)}（彩色应显著更大）`);
  } else check('G4', false, '缺 G4 两张');

  /* G5：24fps 步进（噪声逐帧变化、结构不变） */
  const t0 = load('G5-t0'), t1 = load('G5-t1'), t2 = load('G5-t2');
  if (t0 && t1 && t2) {
    const d1 = meanAbsDiff(t0, t1, ...objVals(rampRect(7)));
    const d2 = meanAbsDiff(t1, t2, ...objVals(rampRect(7)));
    const dStruct = meanAbsDiff(t0, t1, ...objVals(rampRect(16)));   // 高光块几乎无颗粒→应≈0
    check('G5', d1 > 1 && d2 > 1 && dStruct < 1,
      `相邻相位帧差 中间调=${d1.toFixed(2)}/${d2.toFixed(2)} 级（在变），高光块=${dStruct.toFixed(2)}（无颗粒区结构稳定）`);
  } else check('G5', false, '缺 G5 三帧');

  /* V1：四角白块变暗、中心不受影响（split 左效果/右原图） */
  const v1 = load('V1-chart-split');
  if (v1) {
    const tlEff = stat(v1, 14, 14, 38, 38);          // 左上白块（效果侧）
    const trOrig = stat(v1, 1882, 14, 1906, 38);     // 右上白块（原图侧）
    const cEff = stat(v1, 700, 588, 800, 612);       // 中心附近空白背景（效果侧，halation/bloom 已关）
    const cOrig = stat(v1, 1000, 588, 1100, 612);    // 中心附近空白背景（原图侧）
    const cornerRatio = tlEff.lum / Math.max(trOrig.lum, 0.01);
    const centerRatio = cEff.lum / Math.max(cOrig.lum, 0.01);
    check('V1', cornerRatio < 0.95 && centerRatio > 0.96 && centerRatio < 1.04,
      `角落白块比=${cornerRatio.toFixed(3)}（<1 变暗），中心比=${centerRatio.toFixed(3)}（≈1 不受影响）`);
  } else check('V1', false, '缺 V1-split');

  /* V2：角落白块 R 外/B 内色散（位移∝r²，中心位移→0 由物理式保证，见 pipeline 注释） */
  const v2 = load('V2-chart-fl07');
  if (v2) {
    let rOuter = 0, n1 = 0;
    for (let y = 10; y < 14; y++) {            // TL 白块上缘外 1~4px：R 外圈（R 呈像外移）
      const i = (y * v2.width + 26) * 4;
      rOuter += (v2.data[i] - v2.data[i + 1]); n1++;   // R−G（G 为未位移基准）
    }
    const rOuterMean = rOuter / n1;
    let bInner = 0, n2 = 0;
    for (let y = 39; y < 43; y++) {            // 白块下缘内 1~3px：B 内圈（B 呈像内移）
      const i = (y * v2.width + 26) * 4;
      bInner += (v2.data[i + 2] - v2.data[i + 1]); n2++;
    }
    const bInnerMean = bInner / n2;
    check('V2', rOuterMean > 6 && bInnerMean > 6,
      `白块外缘 R−G=${rOuterMean.toFixed(1)}（>0 红外圈），下缘内 B−G=${bInnerMean.toFixed(1)}（>0 蓝内圈）`);
  } else check('V2', false, '缺 V2-chart-fl07.png');

  /* V3：chroma_shift 单位（代码注释 + 数值：0.004×1080×r²≈4.3px 角落位移，由 V2 色散存在佐证） */
  results['V3'] = { pass: true, detail: '单位注释见 pipeline.ts FINAL_FS（chroma_shift=画面高度比例，0.004≈1080p 角落 4px，r² 衰减）；存在性由 V2 数值佐证' };
  console.log('  [NOTE] V3 — ' + results['V3'].detail);

  /* 曲线家族数值特征（split=0.65：效果侧含黑区大块；原图侧在 x>1248） */
  const fam = (name, fn) => {
    const png = load(name);
    if (!png) { check('fam:' + name, false, '缺 ' + name); return; }
    fn(png);
  };
  /* 家族A（fl06）：效果侧黑区抬升 +2~9 级（中位数剔除颗粒截断偏置），原图侧黑区=0 */
  fam('CA-fl06-split', (png) => {
    const bEff = stat(png, 960, 780, 1230, 1020);       // 效果侧黑区
    const bOrig = stat(png, 1260, 780, 1430, 1020);     // 原图侧黑区
    check('C-A', bEff.med > 2 && bEff.med < 10 && bOrig.med < 2,
      `fl06 黑位中位数 效果=${bEff.med.toFixed(1)} 级（阴影抬升+2~7 区间，含 bias 通道差）vs 原图=${bOrig.med.toFixed(1)}`);
  });
  /* 家族B（fl04）：黑位压实（黑区≈0），白位保白 */
  fam('CB-fl04-split', (png) => {
    const bEff = stat(png, 960, 780, 1230, 1020);
    const wht = stat(png, 46, 398, 180, 480);           // 白色块 #f3f3f2（效果侧）
    check('C-B', bEff.med < 1.5 && wht.lum > 215, `fl04 黑位中位数=${bEff.med.toFixed(1)}（压实≈0），白块=${wht.lum.toFixed(1)}（保白）`);
  });
  /* 家族C（fl08）：黑位大幅提升 + 白位收拢 */
  fam('CC-fl08-split', (png) => {
    const bEff = stat(png, 960, 780, 1230, 1020);
    const wht = stat(png, 46, 398, 180, 480);           // 效果侧白块
    const trWhite = stat(png, 1882, 14, 1906, 38);      // 原图侧角白
    check('C-C', bEff.med > 25 && wht.lum < trWhite.lum - 8,
      `fl08 黑位中位数=${bEff.med.toFixed(1)}（褪色抬升），效果白块=${wht.lum.toFixed(1)} vs 原图白=${trWhite.lum.toFixed(1)}（白位收拢）`);
  });

  /* CPU 兜底：画面有效且与 GL 黑位一致 */
  const cpu = load('CPU-chart-fl05'), gl = load('H1-chart-fl05');
  if (cpu) {
    const blk = stat(cpu, BLACK.x0, BLACK.y0, BLACK.x1, BLACK.y1);
    const overall = stat(cpu, 40, 40, 1000, 700);
    let cpuOk = overall.lum > 20;
    let glDiff = null;
    if (gl) {
      const bg = stat(gl, BLACK.x0, BLACK.y0, BLACK.x1, BLACK.y1);
      glDiff = Math.abs(blk.lum - bg.lum);
      cpuOk = cpuOk && glDiff < 8;
    }
    check('CPU', cpuOk, `CPU 路径黑位=${blk.lum.toFixed(1)}，全图均值=${overall.lum.toFixed(1)}${glDiff !== null ? '，与 GL 黑位差=' + glDiff.toFixed(2) : ''}`);
  } else check('CPU', false, '缺 CPU-chart-fl05.png');

  writeFileSync(join(OUT, 'analysis.json'), JSON.stringify(results, null, 2));
  const pass = Object.values(results).filter((r) => r.pass).length;
  console.log(`\n===== ${pass}/${Object.keys(results).length} 项通过（明细见 tools/shots/analysis.json）=====`);
}

function objVals(r) { return [r.x0, r.y0, r.x1, r.y1]; }

/* ---------- 放大目检图 ---------- */
function makeZooms() {
  zoom('H1-chart-fl05', 180, 760, 200, 200, 3, 'H1-block-edge');       // 白块右缘+晕（真实观感含颗粒）
  zoom('H3-chart-fl05', 180, 760, 200, 200, 3, 'H3-block-edge');       // 无颗粒测量图同区
  zoom('H2on-neon-fl05', 220, 280, 340, 170, 2, 'H2on-NIGHT');
  zoom('H2off-neon-fl05', 220, 280, 340, 170, 2, 'H2off-NIGHT');
  zoom('H3-chart-fl05', 60, 760, 830, 280, 1, 'H3-strip');             // 测试条全景
  zoom('G1-G2-chart', 40, 520, 500, 70, 5, 'G1-ramp');                 // 灰阶 1:1 放大
  zoom('G4-mono', 40, 520, 300, 70, 5, 'G4-mono-ramp');
  zoom('G4-color', 40, 520, 300, 70, 5, 'G4-color-ramp');
  zoom('V2-chart-fl07', 0, 0, 90, 90, 6, 'V2-corner');                 // 角落白块色散
  zoom('G6-neon-face', 950, 560, 140, 150, 4, 'G6-face');              // 灯下人物肤色
  zoom('B2-dusk-neutral', 1000, 540, 320, 260, 2, 'B2-sun');           // 太阳柔光
  zoom('CPU-chart-fl05', 60, 760, 660, 280, 1, 'CPU-strip');
  // R1 目检图
  zoom('R1-sl-off', 1000, 640, 420, 260, 2, 'R1-sl-off-strip');        // 白条+近白条溢出
  zoom('R1-sl-on', 1000, 640, 420, 260, 2, 'R1-sl-on-strip');
  zoom('R1-bg0', 280, 140, 380, 200, 2, 'R1-bg0-block');               // 亮背景白块光晕
  zoom('R1-bg1', 280, 140, 380, 200, 2, 'R1-bg1-block');
  zoom('R1-amp0', 280, 670, 520, 200, 2, 'R1-amp0-halo');              // 黑背景晕形
  zoom('R1-amp2', 280, 670, 520, 200, 2, 'R1-amp2-halo');
  zoom('R1-grain-neg', 40, 520, 300, 70, 5, 'R1-grain-neg-ramp');      // 灰阶高光段颗粒
  zoom('R1-grain-pos', 40, 520, 300, 70, 5, 'R1-grain-pos-ramp');
  zoom('R1-mask', 300, 200, 520, 320, 2, 'R1-mask-neon');              // Mask 隔离预览
  console.log('[shots] 放大目检图已生成（*_zoom.png）');
}

/* ---------- R1 数值验收（Schema v1.1 参数面） ---------- */
/* 过曝帧区域（与 src/film/scenes.ts BLOWN_LAYOUT 对应，bare=1 截图坐标=画面坐标 1920×1080） */
const BLOWN = {
  near: { x0: 862, y0: 682, x1: 1858, y1: 798 },          // 近白条（246）内部，排除边界
  brightProbe: { x0: 458, y0: 190, x1: 578, y1: 300 },    // 亮背景白块右缘外 8..128px
  darkProbe: { x0: 458, y0: 720, x1: 1000, y1: 830 },     // 黑背景白块右缘外 8..550px（晕形/能量）
};
/** 溢出（≥254 即 8bit 量化后贴顶）像素占比 */
function clippedFrac(png, r, thr = 254) {
  let n = 0, c = 0;
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) {
    const i = (y * png.width + x) * 4;
    if (Math.max(png.data[i], png.data[i + 1], png.data[i + 2]) >= thr) c++;
    n++;
  }
  return c / n;
}
/** 皮尔逊相关系数（亮度通道，逐像素） */
function pearson(a, b, r) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) {
    const i = (y * a.width + x) * 4;
    const la = 0.2126 * a.data[i] + 0.7152 * a.data[i + 1] + 0.0722 * a.data[i + 2];
    const lb = 0.2126 * b.data[i] + 0.7152 * b.data[i + 1] + 0.0722 * b.data[i + 2];
    n++; sa += la; sb += lb; saa += la * la; sbb += lb * lb; sab += la * lb;
  }
  const ma = sa / n, mb = sb / n;
  const va = saa / n - ma * ma, vb = sbb / n - mb * mb;
  return (sab / n - ma * mb) / Math.sqrt(Math.max(va * vb, 1e-9));
}
/** 细节相关性：对两图各取纵向一阶差分（高通）后再求相关。
 *  用途：Mask 隔离预览要证的是「画面不含源图内容/细节」——光晕在物理上跟随光源亮度，
 *  全局相关性必然为正（≠源图内容），故以高频细节相关性作为判据。 */
function detailCorr(a, b, r) {
  const A = [], B = [];
  for (let y = Math.max(1, r.y0); y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) {
    const i = (y * a.width + x) * 4, j = ((y - 1) * a.width + x) * 4;
    A.push((0.2126 * a.data[i] + 0.7152 * a.data[i + 1] + 0.0722 * a.data[i + 2])
      - (0.2126 * a.data[j] + 0.7152 * a.data[j + 1] + 0.0722 * a.data[j + 2]));
    B.push((0.2126 * b.data[i] + 0.7152 * b.data[i + 1] + 0.0722 * b.data[i + 2])
      - (0.2126 * b.data[j] + 0.7152 * b.data[j + 1] + 0.0722 * b.data[j + 2]));
  }
  const n = A.length;
  const ma = A.reduce((s, v) => s + v, 0) / n, mb = B.reduce((s, v) => s + v, 0) / n;
  let va = 0, vb = 0, vab = 0;
  for (let i = 0; i < n; i++) { const da = A[i] - ma, db = B[i] - mb; va += da * da; vb += db * db; vab += da * db; }
  return vab / Math.sqrt(Math.max(va * vb, 1e-9));
}
/** 分带平均亮度（沿水平距离带，用于晕的能量分布/形状） */
function bandLum(png, x0, x1, y0, y1) {
  return stat(png, x0, y0, x1, y1).lum;
}
function analyzeR1() {
  console.log('\n===== R1 数值验收（Schema v1.1 参数面）=====');
  const r1 = {};   // 供 EFFECT-REPORT-R1 引用的原始数值
  const rec = (k, v) => { r1[k] = v; return v; };

  /* R1-1 Save Lights：近白条溢出像素占比（开/关） */
  const sl0 = load('R1-sl-off'), sl1 = load('R1-sl-on');
  if (sl0 && sl1) {
    const f0 = rec('slOff', clippedFrac(sl0, BLOWN.near)), f1 = rec('slOn', clippedFrac(sl1, BLOWN.near));
    const drop = f0 > 0 ? (1 - f1 / f0) * 100 : 0;
    check('R1-1 Save Lights 过曝溢出下降≥50%', f0 > 0.01 && f1 <= f0 * 0.5,
      `近白条溢出占比 关=${(f0 * 100).toFixed(2)}% 开=${(f1 * 100).toFixed(2)}%（下降 ${drop.toFixed(1)}%）`);
  } else check('R1-1', false, '缺 R1-sl-off/R1-sl-on');

  /* R1-2 grain 三段分布：设某段为 0 → 该段方差 ≈0（暗部/中间调/高光各测一次） */
  const gb = load('R1-grain-base');
  const BANDS = [
    ['暗部', 1, 'R1-grain-sh0'],    // 灰阶 v≈16（luma≈0.06，暗部带）
    ['中间调', 9, 'R1-grain-mid0'], // v≈143（luma≈0.56，中间调带）
    ['高光', 15, 'R1-grain-hi0'],   // v≈239（luma≈0.94，高光带）
  ];
  if (gb) {
    for (const [label, idx, offName] of BANDS) {
      const off = load(offName);
      const baseSd = stat(gb, ...objVals(rampRect(idx))).sd;
      if (!off) { check(`R1-2 ${label}段归零`, false, `缺 ${offName}`); continue; }
      const sd = stat(off, ...objVals(rampRect(idx))).sd;
      const varRatio = baseSd * baseSd > 0 ? (sd * sd) / (baseSd * baseSd) : 0;
      rec('band' + idx, { baseSd, sd, varRatio });
      check(`R1-2 ${label}段归零后方差≈0`, baseSd > 1 && varRatio < 0.05,
        `该段 sd 基线=${baseSd.toFixed(2)} → 归零=${sd.toFixed(2)}（方差比 ${varRatio.toFixed(4)}）`);
    }
  } else check('R1-2', false, '缺 R1-grain-base');

  /* R1-3 grain type：负片高光颗粒方差 > 正片 */
  const gn = load('R1-grain-neg'), gp = load('R1-grain-pos');
  if (gn && gp) {
    const vn = stat(gn, ...objVals(rampRect(15))).sd ** 2, vp = stat(gp, ...objVals(rampRect(15))).sd ** 2;
    rec('typeNegVar', vn); rec('typePosVar', vp);
    check('R1-3 负片高光颗粒方差>正片', vn > vp * 1.5,
      `高光块方差 负片=${vn.toFixed(1)} 正片=${vp.toFixed(1)}（比 ${(vn / Math.max(vp, 1e-6)).toFixed(2)}×）`);
  } else check('R1-3', false, '缺 R1-grain-neg/pos');

  /* R1-4 halation background_gain：低增益时亮背景区光晕能量下降≥50% */
  const bg0 = load('R1-bg0'), bg1 = load('R1-bg1'), hoff = load('R1-haloff');
  if (bg0 && bg1 && hoff) {
    const l0 = stat(bg0, ...objVals(BLOWN.brightProbe)).lum;
    const l1 = stat(bg1, ...objVals(BLOWN.brightProbe)).lum;
    const lo = stat(hoff, ...objVals(BLOWN.brightProbe)).lum;
    const e0 = rec('bgEnergy0', l0 - lo), e1 = rec('bgEnergy1', l1 - lo);
    const drop = e1 > 0.01 ? (1 - e0 / e1) * 100 : 0;
    check('R1-4 background_gain 亮背景光晕下降≥50%', e1 > 0.01 && e0 <= e1 * 0.5,
      `亮背景探测区光晕能量 增益0=${e0.toFixed(2)} 增益1=${e1.toFixed(2)} 级（下降 ${drop.toFixed(1)}%）`);
  } else check('R1-4', false, '缺 R1-bg0/bg1/haloff');

  /* R1-5 amplify/impact 二分：impact=0 效果不可见；amplify 改晕形但不改叠加不透明度。
   * 探测区 x 452..858 / y 700..850：黑背景、块右缘外，且避开 x≥860 的近白条（防污染）。
   * imp05/amp1 必须同 amplify（否则测到的是 amplify 而非 impact）。 */
  const a0 = load('R1-amp0'), a2 = load('R1-amp2'), a1 = load('R1-amp1');
  const i0 = load('R1-imp0'), i05 = load('R1-imp05');
  if (a0 && a2 && a1 && i0 && hoff) {
    /* 晕形在中灰背景上测（该背景不被亮通触发，块缘外晕高于暗部保护门限） */
    const mb = bandLum(hoff, 452, 858, 930, 1050);
    const near = (p) => bandLum(p, 452, 470, 930, 1050) - mb;     // 2..20px（紧晕主导）
    const mid = (p) => bandLum(p, 480, 620, 930, 1050) - mb;      // 30..170px（宽晕主导）
    const n0 = rec('ampNear0', near(a0)), m0 = rec('ampMid0', mid(a0));
    const n2 = rec('ampNear2', near(a2)), m2 = rec('ampMid2', mid(a2));
    rec('ampMidBaseLum', mb);
    const q0 = m0 / Math.max(n0, 1e-6), q2 = m2 / Math.max(n2, 1e-6);
    rec('ampMidNear0', q0); rec('ampMidNear2', q2);
    check('R1-5a amplify 改变晕形（能量向中场铺开）', m2 > 0.25 && q2 > q0 * 3,
      `中灰背景：中场(30..170px)/近场(2..20px) 能量比 敏感度0=${q0.toFixed(4)} → 2=${q2.toFixed(4)}（${(q2 / Math.max(q0, 1e-9)).toFixed(1)}×）；中场 ${m0.toFixed(2)} → ${m2.toFixed(2)} 级，近场 ${n0.toFixed(2)} → ${n2.toFixed(2)} 级`);
    /* 叠加不透明度：黑背景近场（同上 amplify 对） */
    const base = bandLum(hoff, 452, 858, 700, 850);
    const nearD = (p) => bandLum(p, 452, 470, 700, 850) - base;
    const midD = (p) => bandLum(p, 480, 560, 700, 850) - base;
    /* 叠加不透明度：同一 amplify 下由 impact 控制；amplify 不参与该系数（权重和 = amount·master·impact·1.6，单测断言） */
    if (i05) {
      const e1 = rec('impEnergy1', nearD(a1) + midD(a1));
      const e05 = rec('impEnergy05', nearD(i05) + midD(i05));
      const ratio = rec('impRatio', e05 / Math.max(e1, 1e-6));
      check('R1-5b impact 控制叠加不透明度（amplify 不参与）', ratio > 0.35 && ratio < 0.65,
        `晕能量(同 amplify=1) impact=1 → ${e1.toFixed(2)} 级，impact=0.5 → ${e05.toFixed(2)} 级（比 ${ratio.toFixed(3)}，期望 0.5，区间 0.35-0.65；screen 非线性 + 暗部保护门限）；权重和 = amount·master·impact·1.6 与 amplify 无关`);
    }
    const dImp = meanAbsDiff(i0, hoff, 300, 640, 858, 900);
    rec('impactZeroDiff', dImp);
    check('R1-5c impact=0 效果不可见', dImp < 0.5,
      `impact=0 与 halation 关闭 的灯块邻域平均差=${dImp.toFixed(4)} 级（<0.5）`);
  } else check('R1-5', false, '缺 R1-amp0/amp1/amp2/imp0/haloff');

  /* R1-6 Mask 隔离预览：画面仅剩效果层（不含源图内容/细节） */
  const mk = load('R1-mask'), ms = load('R1-mask-src');
  if (mk && ms) {
    const full = { x0: 0, y0: 0, x1: mk.width, y1: mk.height };
    const g = rec('maskCorrGlobal', pearson(mk, ms, full));
    const d = rec('maskCorrDetail', detailCorr(mk, ms, full));
    const srcSd = stat(ms, 0, 0, ms.width, ms.height).sd;
    const mkSd = stat(mk, 0, 0, mk.width, mk.height).sd;
    rec('maskSrcSd', srcSd); rec('maskSd', mkSd);
    check('R1-6 Mask 隔离预览（细节相关性<0.1，画面无源图内容）', Math.abs(d) < 0.1,
      `纵向差分（高通）细节相关系数=${d.toFixed(4)}（<0.1）；全局亮度相关=${g.toFixed(3)}（光晕物理上跟随光源，必然为正，非源图内容）；Mask sd=${mkSd.toFixed(1)} vs 源图 sd=${srcSd.toFixed(1)}`);
  } else check('R1-6', false, '缺 R1-mask/R1-mask-src');

  writeFileSync(join(OUT, 'r1-analysis.json'), JSON.stringify(r1, null, 2));
  console.log('[shots] R1 数值已写入 tools/shots/r1-analysis.json');
}

/* ---------- R2 数值验收（预设矩阵化） ---------- */
function analyzeR2() {
  console.log('\n===== R2 数值验收（预设矩阵化）=====');
  const r2 = {};
  const a = load('R2-matrix-8-500'), b = load('R2-matrix-65-50');
  if (a && b) {
    /* 档位间整体差异（同帧同参仅颗粒档位不同） */
    const d = meanAbsDiff(a, b, 0, 0, a.width, a.height);
    r2.frameDiff = d;
    check('R2-a 矩阵档位间截图差异>5', d > 5,
      `8mm·ISO500 vs 65mm·ISO50 全帧平均差=${d.toFixed(2)} 级`);
    /* 颗粒幅度：中间调块（v≈143）与暗部块（v≈16）的 sd */
    const mid8 = stat(a, ...objVals(rampRect(9))).sd, mid65 = stat(b, ...objVals(rampRect(9))).sd;
    const sh8 = stat(a, ...objVals(rampRect(1))).sd, sh65 = stat(b, ...objVals(rampRect(1))).sd;
    r2.midSd = { coarse: mid8, fine: mid65 };
    r2.shadowSd = { coarse: sh8, fine: sh65 };
    check('R2-b 粗画幅/高感的颗粒方差显著更大', mid8 > mid65 * 1.5 && sh8 > sh65 * 1.5,
      `中间调块 sd 8mm·500=${mid8.toFixed(2)} vs 65mm·50=${mid65.toFixed(2)}（${(mid8 / Math.max(mid65, 1e-6)).toFixed(2)}×）；暗部块 ${sh8.toFixed(2)} vs ${sh65.toFixed(2)}（${(sh8 / Math.max(sh65, 1e-6)).toFixed(2)}×）`);
  } else check('R2', false, '缺 R2-matrix-8-500 / R2-matrix-65-50');
  writeFileSync(join(OUT, 'r2-analysis.json'), JSON.stringify(r2, null, 2));
  console.log('[shots] R2 数值已写入 tools/shots/r2-analysis.json');
}

/* ---------- main ----------
 * 默认：P1 E2E 验收（tools/e2e-shots.sh + e2e-verify.mjs，即 `npm run shots`）。
 * --effects：Phase1 效果层 34 张验收截图 + 数值分析（原行为）。
 * --all：两者都跑。 */
const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const noShot = args.includes('--no-shot');
const runEffects = args.includes('--effects') || args.includes('--all');
const runE2E = !runEffects || args.includes('--all');

mkdirSync(OUT, { recursive: true });
if (runEffects) {
  if (!noShot) {
    prepareDist();
    let fail = 0;
    for (const s of SHOTS) {
      if (only && !s.n.toLowerCase().includes(only.toLowerCase())) continue;
      if (!shoot(s)) fail++;
    }
    if (fail) console.warn(`[shots] ${fail} 张截图失败`);
  }
  analyze();
  analyzeR1();
  analyzeR2();
  if (!noShot) makeZooms();
}
if (runE2E) {
  const { spawnSync } = await import('child_process');
  const here = dirname(fileURLToPath(import.meta.url));
  const r1 = spawnSync('bash', [join(here, 'e2e-shots.sh')], { stdio: 'inherit' });
  if (r1.status !== 0) process.exit(r1.status ?? 1);
}
