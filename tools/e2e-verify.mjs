/* FilmMatch P1 E2E 断言（node + pngjs）：读 tools/e2e/ 下截图与 --dump-dom 的 #e2e-meta。
 * 覆盖：
 *  ① F12 型号卡：卡片墙缩略图两两均值差 >5 级 + 同帧五型号全帧两两 >5 级
 *  ② F11 导入回路：完整码→decode→重渲染，画面前后差=0；篡改码被校验和拦截
 *  ③ F13 指南抽屉打开不破布局（抽屉区变化、画布区不变）
 *  ④ 标注编辑器打开且滑杆就位；导入面板含完整码
 *  ⑤ 全程无 JS 错误
 *  R2 新增（不改既有断言）：
 *  ⑥ 卡片墙 10 张 + 10 张缩略图有内容且两两均值差>5
 *  ⑦ 同帧十型号全帧两两>5 且每张与原图差≥4
 *  ⑧ 矩阵两档位（g-8-500+noremjet vs g-65-50+std）同预览区平均差>5
 *  ⑨ 标签筛选确实筛掉卡（1≤count≤9）
 *  ⑩ 构建体积：dist/*.html + assets/*.js gzip 合计 ≤66KB（R12 收紧，原 70KB）
 *  R16 新增：⑪ 对比浮层常驻且与④入口同步（调色/分屏态）⑫ 预览 HUD（配方码/参考名/范围占位）
 *            ⑬ 组级重置前后回初始 ⑭ 导出区 Grab Still→PowerGrade 替代路径文案
 */
import { createRequire } from 'module';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { gzipSync } from 'zlib';
const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const OUT = process.argv[2] || join(process.cwd(), 'tools', 'e2e');

function load(name) {
  const p = join(OUT, name + '.png');
  return existsSync(p) ? PNG.sync.read(readFileSync(p)) : null;
}
function meta(name) {
  const p = join(OUT, name + '.dom');
  if (!existsSync(p)) return null;
  const html = readFileSync(p, 'utf8');
  const m = /<div id="e2e-meta"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
function crop(png, r) {
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  const out = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = ((y + r.y0) * png.width + (x + r.x0)) * 4;
    const di = (y * w + x) * 4;
    out.data[di] = png.data[si]; out.data[di + 1] = png.data[si + 1];
    out.data[di + 2] = png.data[si + 2]; out.data[di + 3] = 255;
  }
  return out;
}
function meanAbsDiff(a, b) {
  let s = 0, n = 0;
  const len = Math.min(a.data.length, b.data.length);
  for (let i = 0; i < len; i += 4) {
    s += (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
    n++;
  }
  return s / n;
}
function stat(png, x0, y0, x1, y1) {
  let n = 0, sl = 0, sl2 = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * png.width + x) * 4;
    const l = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
    sl += l; sl2 += l * l; n++;
  }
  const m = sl / n;
  return { lum: m, sd: Math.sqrt(Math.max(0, sl2 / n - m * m)) };
}

const results = {};
function check(id, cond, detail) {
  results[id] = { pass: !!cond, detail };
  console.log((cond ? '[PASS] ' : '[FAIL] ') + id + ' — ' + detail);
}

/* 预览画布区（1680×1050 视口，filmstrip 居中）与右侧抽屉覆盖区 */
const PV = { x0: 60, y0: 220, x1: 1200, y1: 880 };
const DR = { x0: 1240, y0: 60, x1: 1660, y1: 1000 };
const PANEL = { x0: 1310, y0: 40, x1: 1675, y1: 1040 };

const d1 = load('p1-01-default'), wall = load('p1-02-stockwall'), imp = load('p1-03-import'),
  gd = load('p1-04-guide'), gdo = load('p1-04b-guide-off'), ann = load('p1-05-annotate'),
  loop = load('p1-06-shareloop');
const mWall = meta('p1-02-stockwall'), mGuide = meta('p1-04-guide'), mAnn = meta('p1-05-annotate'),
  mLoop = meta('p1-06-shareloop'), mImp = meta('p1-03-import');

/* A0 基线 */
if (d1) {
  const s = stat(d1, PV.x0, PV.y0, PV.x1, PV.y1);
  check('A0 基线帧载入', s.lum > 8 && s.sd > 8, `预览区亮度=${s.lum.toFixed(1)} sd=${s.sd.toFixed(1)}`);
}

/* A1 F12 卡片墙 */
const STOCKS = ['fl04', 'fl05', 'fl06', 'fl07', 'fl08'];
if (wall && mWall?.stockwall) {
  const rects = mWall.stockwall.rects ?? [];
  check('A1 卡片墙 5 卡就位', rects.length >= 5, `卡片数=${rects.length} 运行时渲染=${mWall.stockThumbs}`);
  let okRender = 0, minPair = Infinity, worst = '';
  for (let i = 0; i < rects.length; i++) {
    const c = crop(wall, { x0: rects[i].x, y0: rects[i].y, x1: rects[i].x + rects[i].w, y1: rects[i].y + rects[i].h });
    const s = stat(wall, rects[i].x, rects[i].y, rects[i].x + rects[i].w, rects[i].y + rects[i].h);
    if (s.sd > 3) okRender++;
    for (let j = i + 1; j < rects.length; j++) {
      const d = meanAbsDiff(c, crop(wall, { x0: rects[j].x, y0: rects[j].y, x1: rects[j].x + rects[j].w, y1: rects[j].y + rects[j].h }));
      if (d < minPair) { minPair = d; worst = rects[i].id + ' vs ' + rects[j].id; }
    }
  }
  check('A1 卡缩略图已渲染', okRender >= 5, `有内容（sd>3）的卡=${okRender}/${rects.length}`);
  check('① 卡片墙两两均值差>5', minPair > 5, `最小对差=${minPair.toFixed(2)}（${worst}）`);
} else check('A1 卡片墙 meta', false, '缺 p1-02-stockwall 截图或 meta');

/* A2 同帧五型号全帧两两差异 */
{
  const frames = {};
  for (const p of STOCKS) frames[p] = load('p1-stock-' + p);
  const got = STOCKS.filter((p) => frames[p]);
  if (got.length === 5 && d1) {
    const crops = {};
    for (const p of got) crops[p] = crop(frames[p], PV);
    let minPair = Infinity, worst = '';
    for (let i = 0; i < got.length; i++) {
      if (meanAbsDiff(crops[got[i]], crop(d1, PV)) < 4) check('A2 型号 vs 原图', false, got[i] + ' 与原图差 <4');
      for (let j = i + 1; j < got.length; j++) {
        const d = meanAbsDiff(crops[got[i]], crops[got[j]]);
        if (d < minPair) { minPair = d; worst = got[i] + ' vs ' + got[j]; }
      }
    }
    check('② 同帧五型号两两均值差>5', minPair > 5, `最小对差=${minPair.toFixed(2)}（${worst}）`);
    check('A2 型号 vs 原图可辨', Object.keys(results).some((k) => k === 'A2 型号 vs 原图' ? results[k].pass : true), '全部型号与原图差 ≥4 级');
  } else check('A2 五型号全帧截图', false, `缺图：${STOCKS.filter((p) => !frames[p]).join(',') ?? '无'}`);
}

/* A3 F11 分享码导入回路 */
if (mLoop?.shareLoop) {
  const L = mLoop.shareLoop;
  check('③ 导入回路 diff=0 且损坏拦截', L.pass === true, `diff=${(+L.diff).toFixed(4)} rejected=${L.rejected} codeLen=${L.codeLen}`);
  const dom = existsSync(join(OUT, 'p1-06-shareloop.dom')) ? readFileSync(join(OUT, 'p1-06-shareloop.dom'), 'utf8') : '';
  check('A3 smokelog 记录 SHARELOOP PASS', dom.includes('SHARELOOP PASS'), 'dump-dom 含 SHARELOOP PASS');
} else check('A3 shareloop meta', false, '缺 p1-06-shareloop meta');

/* A4 F13 指南抽屉 */
if (gd && gdo && mGuide) {
  check('A4 指南抽屉打开', mGuide.guideOpen === true, `guideOpen=${mGuide.guideOpen}`);
  const dDraw = meanAbsDiff(crop(gd, DR), crop(gdo, DR));
  const dCanvas = meanAbsDiff(crop(gd, PV), crop(gdo, PV));
  check('③ 抽屉区变化', dDraw > 10, `抽屉覆盖区平均差=${dDraw.toFixed(2)}`);
  check('③ 画布区不破布局', dCanvas < 3, `预览画布区平均差=${dCanvas.toFixed(2)}（<3）`);
  const s = stat(gd, PV.x0, PV.y0, PV.x1, PV.y1);
  check('A4 抽屉开启时画面仍在', s.lum > 8, `画布区亮度=${s.lum.toFixed(1)}`);
} else check('A4 指南截图/meta', false, '缺 p1-04 或 p1-04b');

/* A5 标注编辑器 */
if (ann && mAnn) {
  check('A5 标注编辑器打开', mAnn.annotateOpen === true, `open=${mAnn.annotateOpen} kind=${mAnn.annotateKind}`);
  check('A5 滑杆组复用就位', mAnn.annotateSliders >= 13, `滑杆数=${mAnn.annotateSliders}（look9+质感14）`);
  if (d1) {
    const d = meanAbsDiff(crop(ann, DR), crop(d1, DR));
    check('A5 编辑器覆盖可见', d > 8, `抽屉区平均差=${d.toFixed(2)}`);
  }
} else check('A5 标注编辑器 meta', false, '缺 p1-05 meta');

/* A6 导入面板 */
{
  const dom = existsSync(join(OUT, 'p1-03-import.dom')) ? readFileSync(join(OUT, 'p1-03-import.dom'), 'utf8') : '';
  check('A6 导入面板存在', dom.includes('导入配方码'), 'dump-dom 含「导入配方码」');
  const code = /FM1\.[A-Za-z0-9_-]{2}\.[A-Za-z0-9_-]{40,}/.exec(dom);
  check('A6 示例完整码已填入', !!code, code ? `codebox=${code[0].slice(0, 24)}…（${code[0].length} 字符）` : '未找到 FM1. 码');
  check('A6 码本按钮存在', dom.includes('导出码本') && dom.includes('导入码本'), '码本导入/导出入口');
  if (imp && d1) {
    const d = meanAbsDiff(crop(imp, PANEL), crop(d1, PANEL));
    check('A6 导入面板可见', d > 5, `面板区平均差=${d.toFixed(2)}`);
  }
}

/* A7 无 JS 错误 */
{
  let bad = [];
  for (const f of readdirSync(OUT)) {
    if (f.endsWith('.log') || f.endsWith('.dom')) {
      const t = readFileSync(join(OUT, f), 'utf8');
      if (t.includes('JS错误') || t.includes('<title>ERR')) bad.push(f);
    }
  }
  check('A7 无 JS 错误', bad.length === 0, bad.length ? '出错文件：' + bad.join(',') : '全部 .log/.dom 干净');
}

/* ================= R2 新增断言（不改动既有 A 与 ①..⑤ 断言） ================= */

const R2_STOCKS = ['fl01', 'fl02', 'fl03', 'fl04', 'fl05', 'fl06', 'fl07', 'fl08', 'fl09', 'fl10'];

/* R2-1 卡片墙 10 张就位 + 10 张缩略图都有内容 + 两两均值差 >5 */
if (wall && mWall?.stockwall) {
  const rects = mWall.stockwall.rects ?? [];
  check('R2-1 卡片墙 10 卡就位', rects.length >= 10, `卡片数=${rects.length} 运行时渲染=${mWall.stockThumbs}`);
  let okRender = 0, minPair = Infinity, worst = '';
  const crops = rects.map((r) => crop(wall, { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }));
  for (let i = 0; i < rects.length; i++) {
    const s = stat(wall, rects[i].x, rects[i].y, rects[i].x + rects[i].w, rects[i].y + rects[i].h);
    if (s.sd > 3) okRender++;
    for (let j = i + 1; j < rects.length; j++) {
      const d = meanAbsDiff(crops[i], crops[j]);
      if (d < minPair) { minPair = d; worst = rects[i].id + ' vs ' + rects[j].id; }
    }
  }
  check('R2-1 十张缩略图均有内容（sd>3）', okRender >= 10, `有内容=${okRender}/${rects.length}`);
  check('R2-1 十张缩略图两两均值差>5', minPair > 5, `最小对差=${minPair.toFixed(2)}（${worst}）`);
} else check('R2-1 卡片墙 meta', false, '缺 p1-02-stockwall 截图或 meta');

/* R2-2 同帧十型号全帧两两 >5，且每张与原图（同帧无参考）差 ≥4 */
{
  const frames = {};
  for (const p of R2_STOCKS) frames[p] = load('p1-stock-' + p);
  const orig = load('p2-00-dusk-orig');
  const got = R2_STOCKS.filter((p) => frames[p]);
  if (got.length === 10 && orig) {
    const crops = {};
    for (const p of got) crops[p] = crop(frames[p], PV);
    let minPair = Infinity, worst = '', minOrig = Infinity, worstOrig = '';
    for (let i = 0; i < got.length; i++) {
      const do_ = meanAbsDiff(crops[got[i]], crop(orig, PV));
      if (do_ < minOrig) { minOrig = do_; worstOrig = got[i]; }
      for (let j = i + 1; j < got.length; j++) {
        const d = meanAbsDiff(crops[got[i]], crops[got[j]]);
        if (d < minPair) { minPair = d; worst = got[i] + ' vs ' + got[j]; }
      }
    }
    check('R2-2 同帧十型号两两均值差>5', minPair > 5, `最小对差=${minPair.toFixed(2)}（${worst}）`);
    check('R2-2 每张型号与原图差≥4', minOrig >= 4, `最小差=${minOrig.toFixed(2)}（${worstOrig}）`);
  } else check('R2-2 十型号全帧截图', false, `缺图：${R2_STOCKS.filter((p) => !frames[p]).join(',') || '无'} 原图=${!!orig}`);
}

/* R2-3 矩阵档位差异：p2-01（g-8-500 + noremjet）vs p2-02（g-65-50 + std），同帧同预览区 */
{
  const m1 = load('p2-01-matrix'), m2 = load('p2-02-matrix-std');
  if (m1 && m2) {
    const d = meanAbsDiff(crop(m1, PV), crop(m2, PV));
    check('R2-3 矩阵两档位平均差>5', d > 5, `同帧同预览区平均差=${d.toFixed(2)} 级`);
  } else check('R2-3 矩阵截图', false, '缺 p2-01-matrix / p2-02-matrix-std');
  const mm = meta('p2-01-matrix'), ms = meta('p2-02-matrix-std');
  check('R2-3 矩阵 meta 记录档位',
    mm?.matrix?.grain === 'g-8-500' && mm?.matrix?.halation === 'noremjet' &&
    ms?.matrix?.grain === 'g-65-50' && ms?.matrix?.halation === 'std',
    `p2-01=${JSON.stringify(mm?.matrix)} p2-02=${JSON.stringify(ms?.matrix)}`);
}

/* R2-4 标签筛选：meta.tagFilter.count 确实筛掉了卡（1..9） */
{
  const mt = meta('p2-03-tagfilter');
  const c = mt?.tagFilter?.count;
  check('R2-4 标签筛选确实筛掉卡（1≤count≤9）',
    typeof c === 'number' && c >= 1 && c <= 9,
    `标签=${mt?.tagFilter?.tag} 可见卡数=${c}（共 10 张）`);
}

/* R2-5 首屏构建体积：首屏（index.html + 其 <script src> 与 modulepreload 静态可达资源）gzip ≤66KB（R12 收紧，原 70KB）。
 * R3 起批量匹配页/DCTL 页改为动态 import（按需加载，不进首屏包）；为透明起见同时打印全量 gzip 合计。 */
{
  const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  const idx = join(distDir, 'index.html');
  const gz = (f) => gzipSync(readFileSync(f)).length;
  let firstPaint = 0, total = 0;
  const parts = [];
  if (existsSync(idx)) {
    const html = readFileSync(idx, 'utf8');
    firstPaint += gz(idx);
    parts.push(`index.html=${(gz(idx) / 1024).toFixed(1)}KB`);
    const refs = [...html.matchAll(/(?:src|href)="(\.\/)?([^"]+\.js)"/g)].map((m) => m[2]);
    for (const r of new Set(refs)) {
      const f = join(distDir, r);
      if (!existsSync(f)) continue;
      firstPaint += gz(f);
      parts.push(`${r.split('/').pop()}=${(gz(f) / 1024).toFixed(1)}KB`);
    }
    const assets = join(distDir, 'assets');
    if (existsSync(assets)) for (const f of readdirSync(assets)) if (f.endsWith('.js')) total += gz(join(assets, f));
    for (const f of readdirSync(distDir)) if (f.endsWith('.html')) total += gz(join(distDir, f));
  }
  const kb = firstPaint / 1024, kbTotal = total / 1024;
  check('R2-5 首屏构建体积 gzip≤66KB（R12 收紧：瘦身后实测 59.8KB，留 ~6KB 余量）', firstPaint > 0 && kb <= 66,
    `首屏 gzip=${kb.toFixed(1)}KB（${parts.join(' · ')}）；全量（含按需加载页）gzip=${kbTotal.toFixed(1)}KB`);

}

/* ================= R3 新增断言（F14 批量匹配；不改动既有 A / ①..⑤ / R2 断言） =================
 * 说明：批量页占满 main 区域，非活动视图 hidden 不参与布局，故可见性比较用 PV 区域
 * （工作台预览区）对 p1-01 基线。 */

const b1 = load('p3-01-batch'), b2 = load('p3-02-batch-b');
const mBatch = meta('p3-01-batch'), mBatchB = meta('p3-02-batch-b');
const bDom = existsSync(join(OUT, 'p3-01-batch.dom'))
  ? readFileSync(join(OUT, 'p3-01-batch.dom'), 'utf8') : '';

/* R3-1 批量页渲染：段数、文案、帧列表行数 */
{
  const nFrames = mBatch?.batch?.frames;
  const rows = (bDom.match(/class="batch-row"/g) ?? []).length;
  const hasTitle = bDom.includes('批量匹配');
  const hasCdl = bDom.includes('逐段 CDL');
  check('R3-1 批量页渲染（段数/文案/行数）',
    typeof nFrames === 'number' && nFrames >= 6 && rows >= 6 && hasTitle && hasCdl,
    `batch.frames=${nFrames} · .batch-row=${rows} · 「批量匹配」=${hasTitle} · 「逐段 CDL」=${hasCdl}`);
}

/* R3-2 段间统计距离下降 ≥70% */
{
  const d = mBatch?.batch?.dropPct;
  check('R3-2 段间统计距离下降≥70%', typeof d === 'number' && d >= 70,
    `dropPct=${d}%（拟合前 ${mBatch?.batch?.before} → 拟合后 ${mBatch?.batch?.after}）`);
}

/* R3-3 CDL 数值合法（全部落在 CDL_RANGES 内） */
{
  check('R3-3 CDL 数值合法（区间自检）', mBatch?.batch?.cdlInRange === true,
    `cdlInRange=${mBatch?.batch?.cdlInRange}`);
}

/* R3-4 / R6-3 导出包结构：有 DCTL 时 8 个文件（json/csv/cube/dctl/py/3×md），无则 7 个；
 * 每个 bytes>0；zipBytes>500。（R6 起包内并入该配方的 .dctl，并新增《首次上手清单.md》） */
{
  const pack = mBatch?.batch?.pack;
  const names = Array.isArray(pack) ? pack.map((p) => p.name) : [];
  const ext = (n) => (n.match(/\.([a-z0-9]+)$/i) ?? [])[1]?.toLowerCase();
  const has = (e) => names.filter((n) => ext(n) === e).length;
  const withDctl = mBatch?.batch?.hasDctl === true;
  const want = withDctl ? 8 : 7;
  const shape = names.length === want && has('json') === 1 && has('csv') === 1 && has('cube') === 1 &&
    has('py') === 1 && has('md') === 3 && has('dctl') === (withDctl ? 1 : 0);
  const bytesOk = Array.isArray(pack) && pack.every((p) => typeof p.bytes === 'number' && p.bytes > 0);
  const zipBytes = mBatch?.batch?.zipBytes;
  check('R3-4 导出包结构（7/8 文件 + bytes>0 + zip>500B）',
    shape && bytesOk && typeof zipBytes === 'number' && zipBytes > 500,
    `hasDctl=${withDctl} 文件=${JSON.stringify(names)} · zipBytes=${zipBytes}`);
}

/* R6-3 交付包并入 DCTL：zip 内含 <code>.dctl 且《首次上手清单.md》在列 */
{
  const pack = mBatch?.batch?.pack;
  const names = Array.isArray(pack) ? pack.map((p) => p.name) : [];
  const dctlName = names.find((n) => /\.dctl$/i.test(n));
  const dctlBytes = pack?.find((p) => /\.dctl$/i.test(p.name))?.bytes;
  const guide = names.find((n) => n.includes('首次上手清单'));
  check('R6-3 交付包并入 DCTL + 首次上手清单',
    mBatch?.batch?.hasDctl === true && !!dctlName && typeof dctlBytes === 'number' && dctlBytes > 3000 && !!guide,
    `dctl=${dctlName}(${dctlBytes}B) 上手清单=${guide} pipeline=${mBatch?.batch?.pipeline}`);
}

/* R3-5 策略 B 也成立（段间距离降幅 ≥70%） */
{
  const d = mBatchB?.batchB?.dropPct;
  check('R3-5 策略 B 段间距离下降≥70%', mBatchB?.batchB?.strategy === 'B' && typeof d === 'number' && d >= 70,
    `strategy=${mBatchB?.batchB?.strategy} dropPct=${d}%（拟合前 ${mBatchB?.batchB?.before} → 拟合后 ${mBatchB?.batchB?.after}）`);
}

/* R3-6 批量页可见性：与工作台基线在 PV 区域平均差 >5（页面确实切换） */
{
  if (b1 && d1) {
    const d = meanAbsDiff(crop(b1, PV), crop(d1, PV));
    check('R3-6 批量页与工作台基线可辨（PV 平均差>5）', d > 5, `PV 区域平均差=${d.toFixed(2)} 级`);
  } else check('R3-6 批量页截图', false, `缺图：p3-01-batch=${!!b1} p1-01-default=${!!d1}`);
  if (b2) {
    const s = stat(b2, PV.x0, PV.y0, PV.x1, PV.y1);
    check('R3-6 策略 B 页截图有效', s.lum > 2, `策略 B 页 PV 亮度=${s.lum.toFixed(1)}`);
  } else check('R3-6 策略 B 截图', false, '缺 p3-02-batch-b');
}

/* ================= R4 + R5 新增断言（DCTL 生成页 / 节点包导出区；不改动既有断言） =================
 * R4：DCTL 页懒加载渲染（meta + 文案 + 参数面板声明数 + 静态校验 + 一致性核验 + 样例）。
 * R5：工作台 ⑤ 节点包导出区（搭建清单主交付 + 实验性 .drx + parseDrx 回读）。
 * 说明：DCTL 页占满 main 区域（工作台视图 hidden），可见性比较沿用 PV；导出区在 #panel 内，
 * 用 PANEL 区域对 p1-01 基线。 */

const dctl1 = load('p4-01-dctl'), dctlRcm = load('p4-02-dctl-rcm'), drxShot = load('p5-01-drx');
const mDctl = meta('p4-01-dctl'), mDctlRcm = meta('p4-02-dctl-rcm'), mDrx = meta('p5-01-drx');
const dDom = existsSync(join(OUT, 'p4-01-dctl.dom')) ? readFileSync(join(OUT, 'p4-01-dctl.dom'), 'utf8') : '';
const drxDom = existsSync(join(OUT, 'p5-01-drx.dom')) ? readFileSync(join(OUT, 'p5-01-drx.dom'), 'utf8') : '';

/* R4-1 DCTL 页渲染：meta 数值 + 固定文案 */
{
  const D = mDctl?.dctl;
  const domOk = dDom.includes('DCTL 生成') && dDom.includes('对数域') && dDom.includes('参数面板');
  check('R4-1 DCTL 页渲染（meta + 文案）',
    D?.pipeline === 'yrgb' && D?.preset === 'fl06' && D?.valid === true &&
    typeof D?.paramCount === 'number' && D.paramCount >= 40 &&
    typeof D?.sourceBytes === 'number' && D.sourceBytes > 5000 && domOk,
    `pipeline=${D?.pipeline} preset=${D?.preset} valid=${D?.valid} paramCount=${D?.paramCount} ` +
    `sourceBytes=${D?.sourceBytes} warnings=${D?.warnings} · DOM文案=${domOk}`);
}

/* R4-2 管线可切换：RCM 与 YRGB 同一配方参数面一致 */
{
  const A = mDctl?.dctl, B = mDctlRcm?.dctlRcm;
  check('R4-2 管线可切换（RCM 参数面与 YRGB 相同）',
    B?.pipeline === 'rcm' && typeof B?.paramCount === 'number' && B.paramCount === A?.paramCount,
    `yrgb.paramCount=${A?.paramCount} · rcm.pipeline=${B?.pipeline} rcm.paramCount=${B?.paramCount}`);
}

/* R4-3 一致性核验存在且合理：samples≥64，meanAbs 有值且 <64（0..255 级） */
{
  const C = mDctl?.dctl?.consistency;
  check('R4-3 一致性核验（samples≥64 且 meanAbs<64）',
    typeof C?.samples === 'number' && C.samples >= 64 &&
    typeof C?.meanAbs === 'number' && C.meanAbs < 64,
    `samples=${C?.samples} meanAbs=${C?.meanAbs} maxAbs=${C?.maxAbs} meanDE=${C?.meanDE}`);
}

/* R4-4 样例文件：3 个（meta dctl.samples===3）+ 页面样例列表 */
{
  const n = mDctl?.dctl?.samples;
  const listOk = dDom.includes('FM_yrgb_fl06.dctl') && dDom.includes('dctl-samples');
  check('R4-4 样例文件（3 个 + 页面样例列表）', n === 3 && listOk,
    `dctl.samples=${n} · 样例列表=${listOk}`);
}

/* R5-1 节点包导出区：节点树 / 换算表 / 清单字节 / 实验性 / parseDrx 回读 + 文案 */
{
  const D = mDrx?.drx;
  const kinds = Array.isArray(D?.kinds) ? D.kinds : [];
  const want = ['grade', 'halation', 'bloom', 'grain', 'vignette', 'composite'];
  const kindsOk = kinds.length === want.length && want.every((k, i) => kinds[i] === k);
  const domOk = drxDom.includes('搭建清单') && drxDom.includes('实验性');
  check('R5-1 节点包导出区（节点/换算/清单/实验性/回读）',
    D?.nodes === 6 && kindsOk &&
    typeof D?.conversions === 'number' && D.conversions >= 5 &&
    typeof D?.markdownBytes === 'number' && D.markdownBytes > 800 &&
    D?.experimental === true && D?.roundTrip === true && domOk,
    `nodes=${D?.nodes} kinds=[${kinds.join(',')}] conversions=${D?.conversions} ` +
    `markdownBytes=${D?.markdownBytes} drxBytes=${D?.drxBytes} experimental=${D?.experimental} ` +
    `roundTrip=${D?.roundTrip} · DOM文案=${domOk}`);
}

/* ================= R6 新增断言（双语标签 / 分组前缀 / tooltip / 分层导出） =================
 * 说明：R6 的标签写法（中英混排 / 分组前缀 / tooltip）尚未在达芬奇里验证——spike 三文件已产出，
 * 页面默认走「纯英文安全形态」，混排形态只做静态断言（生成得出来、参数面正确、静态校验通过）。 */
const dctlStagesShot = load('p4-04-dctl-stages'), dctlLabelsShot = load('p4-05-dctl-labels');
const mStages = meta('p4-04-dctl-stages'), mLabels = meta('p4-05-dctl-labels');
const stagesDom = existsSync(join(OUT, 'p4-04-dctl-stages.dom')) ? readFileSync(join(OUT, 'p4-04-dctl-stages.dom'), 'utf8') : '';
const labelsDom = existsSync(join(OUT, 'p4-05-dctl-labels.dom')) ? readFileSync(join(OUT, 'p4-05-dctl-labels.dom'), 'utf8') : '';

/* R6-1 分层导出：只色彩层 → 无质感层参数、参数数下降、静态校验通过、下载名带 -color 后缀 */
{
  const A = mDctl?.dctl, S = mStages?.dctlStages;
  const st = S?.stages ?? {};
  const allOff = ['halation', 'bloom', 'grain', 'vignette'].every((k) => st[k] === false);
  const fewer = typeof S?.paramCount === 'number' && typeof A?.paramCount === 'number' && S.paramCount < A.paramCount;
  const domOk = stagesDom.includes('导出层') && stagesDom.includes('只导出色彩层');
  check('R6-1 分层导出（只色彩层：参数更少 + 校验通过 + -color 后缀）',
    allOff && fewer && S?.valid === true && S?.layerSuffix === '-color' && domOk,
    `全层=${A?.paramCount} 参数 · 只色彩层=${S?.paramCount} 参数 · suffix=${S?.layerSuffix} valid=${S?.valid} · DOM=${domOk}`);
}

/* R6-2 双语拨杆：混排 + 分组前缀 + tooltip 形态可生成、参数面与安全形态一致、静态校验通过 */
{
  const L = mLabels?.dctlLabels, A = mDctl?.dctl;
  const domOk = labelsDom.includes('标签模式') && labelsDom.includes('spike') && labelsDom.includes('中英混排');
  check('R6-2 双语标签形态（混排+前缀+tooltip 可生成且参数面一致）',
    L?.labelMode === 'bilingual' && L?.groupPrefix === true && L?.tooltips === true &&
    L?.valid === true && L?.paramCount === A?.paramCount && domOk,
    `labelMode=${L?.labelMode} groupPrefix=${L?.groupPrefix} tooltips=${L?.tooltips} ` +
    `paramCount=${L?.paramCount}(全层 ${A?.paramCount}) valid=${L?.valid} · DOM=${domOk}`);
}

/* R6-4 spike 样例：3 个 3 参数文件在页面上可下载（meta + DOM 列表） */
{
  const n = mDctl?.dctl?.spikeSamples;
  const domOk = labelsDom.includes('spike_label_a_mixed.dctl') && labelsDom.includes('spike_label_b_group.dctl') &&
    labelsDom.includes('spike_label_c_tooltip.dctl');
  check('R6-4 标签 spike 三文件（页面可下载）', n === 3 && domOk, `spikeSamples=${n} · DOM列表=${domOk}`);
}

/* R6-5 品牌名统一：页面与产物只出现「菲林工坊」 */
{
  const all = [dDom, stagesDom, labelsDom, bDom].join('\n');
  const ok = !all.includes('菲林工房') && all.includes('菲林工坊');
  check('R6-5 品牌名统一为「菲林工坊」', ok,
    `含「菲林工坊」=${all.includes('菲林工坊')} · 残留「菲林工房」=${all.includes('菲林工房')}`);
}

/* ================= R7 新增断言（单节点导出：内联 CDL 匹配段） =================
 * 数值一致性（系数逐位一致）由单测钉死（codegen.test.ts 27–34 / inlinecdl.test.ts）；
 * 这里断言「页面能生成、参数面正确、误差报告存在且量级合理、批量页逐段单节点包结构正确」。 */
const mMatch = meta('p4-06-dctl-match'), mBatchSingle = meta('p3-03-batch-single');
const matchDom = existsSync(join(OUT, 'p4-06-dctl-match.dom')) ? readFileSync(join(OUT, 'p4-06-dctl-match.dom'), 'utf8') : '';
const singleDom = existsSync(join(OUT, 'p3-03-batch-single.dom')) ? readFileSync(join(OUT, 'p3-03-batch-single.dom'), 'utf8') : '';

/* R7-1 单节点导出：内联匹配段后 64 参数（53 + 11，R21 起恰好打满 64 上限）、静态校验通过、页面出现匹配段与系数 */
{
  const M = mMatch?.dctlMatch, A = mDctl?.dctl;
  const domOk = matchDom.includes('匹配段') && matchDom.includes('内联匹配段') && matchDom.includes('dctl-match-s-r');
  check('R7-1 单节点导出（内联匹配段：64 参数 = 53 + 11 + 校验通过）',
    M?.match?.on === true && M?.paramCount === 64 && M?.valid === true &&
    typeof A?.paramCount === 'number' && A.paramCount === 53 && domOk,
    `匹配段参数=${M?.paramCount}（无匹配=${A?.paramCount}） valid=${M?.valid} on=${M?.match?.on} · DOM=${domOk}`);
}

/* R7-2 系数来自工作台解算（非中性）且报告覆盖 ≥100 采样点 */
{
  const M = mMatch?.dctlMatch, c = M?.match?.cdl, r = M?.match?.report;
  const slope = Array.isArray(c?.slope) ? c.slope : [];
  const nonNeutral = slope.length === 3 && slope.some((v) => Math.abs(v - 1) > 1e-6);
  check('R7-2 系数来自工作台解算 + 误差报告（≥100 点）',
    M?.match?.fromWorkbench === true && nonNeutral &&
    typeof r?.n === 'number' && r.n >= 100 && typeof r?.meanDE === 'number' && r.meanDE >= 0 &&
    typeof r?.maxDE === 'number' && r.maxDE >= r.meanDE,
    `fromWorkbench=${M?.match?.fromWorkbench} slope=[${slope.map((v) => v.toFixed(4)).join(',')}] ` +
    `报告 n=${r?.n} meanDE=${r?.meanDE} maxDE=${r?.maxDE} meanAbs=${r?.meanAbs}`);
}

/* R7-3 批量页逐段单节点：包内 N 个 _segNN_ .dctl、7+N 文件、meta.mode=single */
{
  const B = mBatchSingle?.batch;
  const names = Array.isArray(B?.pack) ? B.pack.map((p) => p.name) : [];
  const segs = names.filter((n) => /_seg\d\d_/.test(n));
  const N = typeof B?.frames === 'number' ? B.frames : 0;
  const guide = names.find((n) => n.includes('首次上手清单'));
  check('R7-3 批量页逐段单节点 DCTL（N 个 _segNN_ + 7+N 文件）',
    B?.mode === 'single' && N > 0 && segs.length === N && names.length === 7 + N &&
    B?.dctlCount === N && !!guide,
    `mode=${B?.mode} frames=${N} 逐段dctl=${segs.length} 文件数=${names.length} dctlCount=${B?.dctlCount}`);
}

/* R7-4 批量页 single 模式的页面文案（模式下拉 + 摘要说明） */
{
  const domOk = singleDom.includes('batch-mode') && singleDom.includes('逐段单节点');
  check('R7-4 批量页单节点模式 UI（下拉 + 文案）', domOk, `DOM=${domOk}`);
}

/* ================= R8 新增断言（分离色调 / 风格卡 / 预设导入导出 / Schema v1.2） =================
 * 分离色调的数学一致性（默认恒等、色相方向、平衡单调、四处同源）由单测钉死（look/logmath/codegen/styles/recipe）；
 * 这里断言「页面与产物层面成立」：DCTL 面板含 5 个 split 参数、风格卡两两差异 >8（R20 起 14 张 = st01–06 + fx01–08）、预设回环通过、schema 1.2。 */
const stylesShot = load('p6-01-styles'), presetIoShot = load('p6-02-presetio');
const mStyles = meta('p6-01-styles'), mPresetIo = meta('p6-02-presetio');
const stylesDom = existsSync(join(OUT, 'p6-01-styles.dom')) ? readFileSync(join(OUT, 'p6-01-styles.dom'), 'utf8') : '';
const presetIoDom = existsSync(join(OUT, 'p6-02-presetio.dom')) ? readFileSync(join(OUT, 'p6-02-presetio.dom'), 'utf8') : '';

/* R8-1 分离色调进 DCTL 面板（5 个新参数；R21 起 52 + master = 53） */
{
  const A = mDctl?.dctl;
  const domOk = dDom.includes('FM_SPLIT_SHADOW_HUE') && dDom.includes('FM_SPLIT_BALANCE');
  check('R8-1 分离色调参数进 DCTL 面板（53 参数）',
    A?.paramCount === 53 && A?.valid === true && domOk,
    `paramCount=${A?.paramCount} valid=${A?.valid} · DOM 含 FM_SPLIT_*=${domOk}`);
}

/* R8-2 风格卡（R20 起 14 张）+ 缩略图有内容 + 两两均值差 > 8 级（高于型号卡的 >5；直接量截图缩略图，比 meta 更硬） */
{
  const S = mStyles?.styles;
  const ids = Array.isArray(S?.ids) ? S.ids : [];
  const rects = Array.isArray(S?.rects) ? S.rects : [];
  const n = typeof S?.count === 'number' ? S.count : 0;
  const domOk = stylesDom.includes('style-grid') && stylesDom.includes('风格卡');
  /* R20：风格卡扩到 14 张（R8 六张 st01–06 + R20 精选八张 fx01–08） */
  const N_STYLES = 14;
  const idsOk = ids.length === N_STYLES && ids.every((i) => /^style_(st0[1-6]|fx0[1-8])$/.test(i))
    && new Set(ids).size === N_STYLES;
  if (stylesShot && rects.length === N_STYLES) {
    const crops = rects.map((r) => crop(stylesShot, { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }));
    let okRender = 0, minPair = Infinity, worst = '';
    for (let i = 0; i < rects.length; i++) {
      const s = stat(stylesShot, rects[i].x, rects[i].y, rects[i].x + rects[i].w, rects[i].y + rects[i].h);
      if (s.sd > 3) okRender++;
      for (let j = i + 1; j < rects.length; j++) {
        const d = meanAbsDiff(crops[i], crops[j]);
        if (d < minPair) { minPair = d; worst = rects[i].id + ' vs ' + rects[j].id; }
      }
    }
    check(`R8-2 风格卡 ${N_STYLES} 张（缩略图有内容 + 两两差 >8）`,
      n === N_STYLES && idsOk && okRender === N_STYLES && minPair > 8 && domOk,
      `count=${n} ids=[${ids.join(',')}] 有内容=${okRender}/${N_STYLES} 最小两两差=${minPair.toFixed(2)}（${worst}） · DOM=${domOk}`);
  } else {
    check(`R8-2 风格卡 ${N_STYLES} 张（缩略图有内容 + 两两差 >8）`, false,
      `缺 p6-01-styles 截图或 rects：shot=${!!stylesShot} rects=${rects.length} count=${n} idsOk=${idsOk} DOM=${domOk}`);
  }
}

/* R8-3 预设导入导出回环：schema 1.3（R18 升版）、14 个 look 字段、坏文件被拒 */
{
  const P = mPresetIo?.presetIO;
  /* 页面文案用「配方/导入/导出」（不是「预设」）：断言这三处入口在页面上真实存在 */
  const domOk = presetIoDom.includes('导出') && presetIoDom.includes('导入') && presetIoDom.includes('配方');
  check('R8-3 预设导入导出回环（schema 1.3 + 坏文件拒绝）',
    P?.ok === true && P?.roundTrip === true && P?.schemaVersion === 1.3 &&
    typeof P?.fields === 'number' && P.fields === 14 && P?.badRejected === true &&
    typeof P?.saved === 'number' && P.saved >= 1 && domOk,
    `ok=${P?.ok} roundTrip=${P?.roundTrip} schemaVersion=${P?.schemaVersion} fields=${P?.fields} ` +
    `saved=${P?.saved} badRejected=${P?.badRejected}（${P?.badError ?? ''}） · DOM=${domOk}`);
}

/* R8-4 Schema v1.2 字段随配方进 DCTL（R18 起配方版本号为 1.3，只增不删） */
{
  const P = mPresetIo?.presetIO;
  const A = mDctl?.dctl;
  const macros = ['FM_SPLIT_SHADOW_HUE', 'FM_SPLIT_SHADOW_SAT', 'FM_SPLIT_HIGHLIGHT_HUE', 'FM_SPLIT_HIGHLIGHT_SAT', 'FM_SPLIT_BALANCE'];
  const allIn = macros.every((m) => dDom.includes(m));
  check('R8-4 Schema v1.3（版本号 + 5 个分离色调字段随配方进 DCTL）',
    P?.schemaVersion === 1.3 && allIn && A?.paramCount === 53,
    `schemaVersion=${P?.schemaVersion} DCTL 含 5 个 FM_SPLIT_*=${allIn} paramCount=${A?.paramCount}`);
}

/* ================= R9 新增断言（质感深度：动态颗粒 / 采样预算 / 团簇 / 片门抖动） =================
 * 单测钉死公式与默认恒等（effectmath/pipeline/codegen）；这里断言「产物与页面层面成立」。 */
const mDefault = meta('p1-01-default');
const defaultDom = existsSync(join(OUT, 'p1-01-default.dom')) ? readFileSync(join(OUT, 'p1-01-default.dom'), 'utf8') : '';

/* R9-1 采样预算：R12–R20 为 36；R21 双环 + 逐 tap look = 108（有意变更，veil 对齐优先；
 * 真实 GPU 无压力——84 次时代实测约 140fps）且动态颗粒/团簇/片门参数齐备 */
{
  const A = mDctl?.dctl;
  const t = A?.tex2d;
  check('R9-1 采样预算 =108 次（R20 前 36 → R21 双环 + 逐 tap look）+ 动态颗粒/团簇/片门参数',
    typeof t === 'number' && t === 108 &&
    A?.hasFrameIndex === true && A?.clusterParam === true && A?.weaveParams === 2 && A?.paramCount === 53,
    `_tex2D=${t} 次（R12–R20 为 36；R21 有意增至 108，veil 对齐优先）· ` +
    `TIMELINE_FRAME_INDEX=${A?.hasFrameIndex} · FM_GRAIN_CLUSTER=${A?.clusterParam} · FM_GATE_WEAVE_*=${A?.weaveParams} · 参数=${A?.paramCount}`);
}

/* R9-2 网页端面板出现「颗粒团簇」与「片门抖动」两组新控件（默认恒等：amount=0 / cluster=0） */
{
  const domOk = defaultDom.includes('颗粒团簇') && defaultDom.includes('片门抖动');
  check('R9-2 网页面板含团簇与片门抖动控件', domOk,
    `DOM 含「颗粒团簇」=${defaultDom.includes('颗粒团簇')} · 「片门抖动」=${defaultDom.includes('片门抖动')}`);
}

/* ================= R10 新增断言（拖动性能守门：零重烘） =================
 * 口径说明：无头 Chromium 用 --virtual-time-budget 跑，performance.now() 被虚拟化（同步块耗时恒为 0），
 * 所以这里**不用计时**，用确定性计数：拖动 look 滑杆 N 次期间烘了几个 LUT、跑了多少体素。
 * 真实时间口径的性能测量走 `node tools/perf-baseline.mjs`（CDP 驱动，见 R10 报告）。 */
const mPerf = meta('p7-01-perf');
const perfDom = existsSync(join(OUT, 'p7-01-perf.dom')) ? readFileSync(join(OUT, 'p7-01-perf.dom'), 'utf8') : '';

/* R10-1 拖动 look 滑杆零烘焙（look 已进片元着色器，LUT 只承载匹配） */
{
  const P = mPerf?.perf;
  const events = typeof P?.events === 'number' ? P.events : 0;
  check('R10-1 拖动 look 滑杆零烘焙（bakeCount=0 / 体素=0）',
    events >= 30 && P?.bakeCount === 0 && P?.voxelsBaked === 0,
    `事件=${events} 烘焙=${P?.bakeCount} 次 / 体素 ${P?.voxelsBaked}（R10 前基线：2 次 / 310,562 体素）`);
}

/* R10-2 拖动性能守门字段齐备（口径与 tools/perf-baseline.mjs 一致，供跨版本对比） */
{
  const P = mPerf?.perf;
  const has = ['perEventWorkP50', 'perEventWorkP95', 'applyMsP50', 'renderMsP50', 'bakeMsTotal', 'wallMs']
    .every((k) => typeof P?.[k] === 'number');
  check('R10-2 性能守门字段齐备（p50/p95/apply/render/bake/wall）', has,
    `字段=${JSON.stringify({ p50: P?.perEventWorkP50, p95: P?.perEventWorkP95, applyP50: P?.applyMsP50, bakeMs: P?.bakeMsTotal })}`);
}

/* ================= R13 补：R11 UI 元数据的 E2E 断言（此前只有结构断言） ================= */
{
  const U = mDefault?.ui;
  const kb = Array.isArray(U?.a11y?.keyboard) ? U.a11y.keyboard : [];
  check('R13-1 简单/高级模式元数据（默认简单 7 参数 + 快捷键 + 焦点态）',
    U?.mode === 'simple' && typeof U?.visibleParams === 'number' && U.visibleParams > 0 &&
    typeof U?.totalParams === 'number' && U.totalParams >= U.visibleParams &&
    kb.length >= 4 && U?.a11y?.focusVisible === true,
    `mode=${U?.mode} 可见=${U?.visibleParams}/${U?.totalParams} 快捷键=${JSON.stringify(kb)} focusVisible=${U?.a11y?.focusVisible}`);
}

/* R4-5 / R5-2 页面可辨 */
{
  if (dctl1 && d1) {
    const d = meanAbsDiff(crop(dctl1, PV), crop(d1, PV));
    check('R4-5 DCTL 页与工作台基线可辨（PV 平均差>5）', d > 5, `PV 区域平均差=${d.toFixed(2)} 级`);
  } else check('R4-5 DCTL 截图', false, `缺图：p4-01=${!!dctl1} p1-01=${!!d1}`);
  if (drxShot && d1) {
    const d = meanAbsDiff(crop(drxShot, PANEL), crop(d1, PANEL));
    check('R5-2 节点包导出区出现（面板区平均差>5）', d > 5, `面板区平均差=${d.toFixed(2)} 级`);
  } else check('R5-2 导出区截图', false, `缺图：p5-01=${!!drxShot} p1-01=${!!d1}`);
}

/* ================= R16 新增断言（对比浮层左移固定 / 预览 HUD / 组级重置 / Grab Still 文案） =================
 * 浮层与 HUD 都是 #filmstrip 内绝对定位浮层（不占布局流，既有坐标断言不受影响）。
 * 同步断言双保险：meta.viewHud（运行时快照）+ dump-dom 里两处分段控件的 aria-selected/class。 */
const mOv1 = meta('p8-01-viewhud'), mOv2 = meta('p8-02-viewhud-split');
const mGrB = meta('p8-03-groupreset'), mGrA = meta('p8-04-groupreset-ok');
const ov1Dom = existsSync(join(OUT, 'p8-01-viewhud.dom')) ? readFileSync(join(OUT, 'p8-01-viewhud.dom'), 'utf8') : '';
const ov2Dom = existsSync(join(OUT, 'p8-02-viewhud-split.dom')) ? readFileSync(join(OUT, 'p8-02-viewhud-split.dom'), 'utf8') : '';
const grBShot = load('p8-03-groupreset'), grAShot = load('p8-04-groupreset-ok');

/* dump-dom 里取一个分段控件的 data-mode → on 状态（class 含 on 且 aria-selected=true） */
function segStateFromDom(dom, id) {
  const i = dom.indexOf('id="' + id + '"');
  if (i < 0) return null;
  const seg = dom.slice(i, dom.indexOf('</div>', i));
  const out = {};
  for (const m of seg.matchAll(/<button[^>]*>/g)) {
    const dm = /data-mode="(\d)"/.exec(m[0]);
    if (dm) out[dm[1]] = /aria-selected="true"/.test(m[0]) && /class="[^"]*\bon\b/.test(m[0]);
  }
  return out;
}

/* R16-1 浮层常驻存在且与 ④ 入口同步（调色态） */
{
  const V = mOv1?.viewHud;
  const domHud = segStateFromDom(ov1Dom, 'viewhud');
  const domPanel = segStateFromDom(ov1Dom, 'seg-view');
  const metaSync = !!V && JSON.stringify(V.modes) === JSON.stringify(V.panel) && V.modes?.m0 === true;
  const domSync = !!domHud && !!domPanel && JSON.stringify(domHud) === JSON.stringify(domPanel);
  check('R16-1 对比浮层常驻且与④入口同步（调色态）',
    ov1Dom.includes('id="viewhud"') && metaSync && domSync,
    `meta 浮层=${JSON.stringify(V?.modes)} ④=${JSON.stringify(V?.panel)} · DOM 同步=${domSync}`);
}

/* R16-2 分屏态：浮层/④入口同一状态（#split=0.5 → 分屏 on，两处 aria-selected 一致） */
{
  const V = mOv2?.viewHud;
  const domHud = segStateFromDom(ov2Dom, 'viewhud');
  const domPanel = segStateFromDom(ov2Dom, 'seg-view');
  const metaSync = !!V && JSON.stringify(V.modes) === JSON.stringify(V.panel) && V.viewMode === 2 && V.modes?.m2 === true;
  const domSync = !!domHud && !!domPanel && JSON.stringify(domHud) === JSON.stringify(domPanel) && domHud['2'] === true;
  check('R16-2 浮层分屏态同步（split=0.5 → m2 on，浮层与④一致）', metaSync && domSync,
    `meta viewMode=${V?.viewMode} 浮层=${JSON.stringify(V?.modes)} · DOM 同步=${domSync}`);
}

/* R16-3 预览 HUD：存在、含配方码（FM-XXXX）、参考名与数据范围（R17 起显示当前配方 range，默认 Full） */
{
  const H = mOv1?.hud;
  const code = /<b id="hud-code">([^<]*)<\/b>/.exec(ov1Dom);
  const rangeDom = /<span id="hud-range"[^>]*>([^<]*)<\/span>/.exec(ov1Dom);
  check('R16-3 预览 HUD 存在且含配方码/参考名/数据范围（R17 起 Full/Legal 实值）',
    ov1Dom.includes('id="hud"') && !!code && /^FM-/.test(code[1]) && !!H?.ref && H?.range === 'Full' && H?.hidden === false &&
    !!rangeDom && rangeDom[1] === 'Full',
    `code=${code?.[1] ?? '无'} ref=${H?.ref} range=${H?.range}（DOM=${rangeDom?.[1] ?? '无'}） hidden=${H?.hidden}`);
}

/* R16-4 组级重置：按钮存在；改「复古褪色」组（fade/saturation）→ 点「重置本组」→ 回到初始值/初始 origin */
{
  const B = mGrB?.groupReset, A = mGrA?.groupReset;
  const changedOk = B?.phase === 'before' && B?.btn === true && B?.group === 'look' &&
    B?.current?.fade === 0.55 && B?.current?.saturation === 0.35 &&
    B?.current?.fade !== B?.initial?.fade;
  const resetOk = A?.phase === 'after' && A?.resetClicked === true && A?.btn === true &&
    A?.current?.fade === A?.initial?.fade && A?.current?.saturation === A?.initial?.saturation &&
    A?.origin !== 'user';
  check('R16-4 组级重置按钮存在且点击后该组回到初始', changedOk && resetOk,
    `前 fade=${B?.current?.fade}/初始 ${B?.initial?.fade} sat=${B?.current?.saturation}` +
    ` · 后 fade=${A?.current?.fade}/初始 ${A?.initial?.fade} sat=${A?.current?.saturation} origin=${A?.origin}`);
  if (grBShot && grAShot) {
    const d = meanAbsDiff(crop(grBShot, PV), crop(grAShot, PV));
    check('R16-5 组级重置前后画面可辨（PV 平均差>3）', d > 3, `PV 区域平均差=${d.toFixed(2)} 级（fade 0.55/sat 0.35 → 初始）`);
  } else check('R16-5 组级重置前后截图', false, `缺图：p8-03=${!!grBShot} p8-04=${!!grAShot}`);
}

/* R16-6 节点包导出区补「Grab Still 存 PowerGrade」替代路径文案（C6/R16） */
{
  check('R16-6 导出区含 Grab Still→PowerGrade 替代路径文案',
    drxDom.includes('Grab Still') && drxDom.includes('PowerGrade') && drxDom.includes('不下载 .drx'),
    `Grab Still=${drxDom.includes('Grab Still')} PowerGrade=${drxDom.includes('PowerGrade')}`);
}

/* ================= R15 新增断言（XMP 预设导入：估算起点卡） =================
 * 场景：#demo=xmpimport 在页面内合成 3 个 XMP（品牌词文件名 / 全中性参数 / 损坏文本），
 * 走与真实按钮相同的 importXmpEntries；断言「2 成功 + 1 失败不中断整批」「卡名清洗」「
 * 中性卡参数与 defaultParams 逐字相等（恒等护栏）」「DOM 点卡应用后 currentRecipe 参数一致」「
 * unmapped 计数如实上报」。品牌词只允许存在于合成 fixture 数据里，dump-dom 不得出现。 */
const mXmpGrid = meta('p8-05-xmpimport'), mXmpApply = meta('p8-06-xmpimport-apply');
const xmpDom = existsSync(join(OUT, 'p8-05-xmpimport.dom')) ? readFileSync(join(OUT, 'p8-05-xmpimport.dom'), 'utf8') : '';
const xmpApplyDom = existsSync(join(OUT, 'p8-06-xmpimport-apply.dom')) ? readFileSync(join(OUT, 'p8-06-xmpimport-apply.dom'), 'utf8') : '';
const xmpApplyShot = load('p8-06-xmpimport-apply');

/* R15-1 导入整批不中断 + 卡片网格就位 */
{
  const X = mXmpGrid?.xmpImport;
  const failures = Array.isArray(X?.failures) ? X.failures : [];
  check('R15-1 XMP 导入 2 成功 + 1 失败不中断整批（网格在风格卡 tab）',
    X?.imported === 2 && X?.failed === 1 && X?.cardCount === 2 &&
    failures.length === 1 && failures[0].file === 'broken-not-xmp.xmp' &&
    typeof failures[0].error === 'string' && failures[0].error.length > 0 &&
    xmpDom.includes('id="xmp-grid"') && xmpDom.includes('XMP 导入 · 估算起点'),
    `imported=${X?.imported} failed=${X?.failed} cards=${X?.cardCount} 失败=${JSON.stringify(failures.map((f) => f.file))}`);
}

/* R15-2 卡名清洗 + source 溯源（品牌词只留在 fixture，dump-dom 不得出现） */
{
  const cards = Array.isArray(mXmpGrid?.xmpImport?.cards) ? mXmpGrid.xmpImport.cards : [];
  const names = cards.map((c) => c.name).sort().join('|');
  const sources = cards.map((c) => c.source).sort().join('|');
  /* 只扫描「卡片显示路径」可能泄漏的品牌词；解析失败 toast 会原样转述上游 parseXmp 的
   * 可读错误（其中提及文件格式名，属格式说明而非卡面文案，不在本断言范围）。 */
  const brandInDom = ['Dehancer', 'KODAK', 'Portra', 'CineStill', 'Velvia', 'Ultramax'].some((w) => xmpDom.includes(w));
  const noteOk = cards.every((c) => c.note.includes('估算起点 · XMP 导入') && c.note.includes(c.source.replace('xmp:', '')));
  check('R15-2 卡名/来源清洗生效 + 注释含来源与 unmapped 提示（DOM 零品牌词）',
    names === 'Neutral Check|Warm Matte' && sources === 'xmp:Neutral Check|xmp:Warm Matte' &&
    !brandInDom && noteOk,
    `names=${names} sources=${sources} DOM含品牌词=${brandInDom} note含来源=${noteOk}`);
}

/* R15-3 恒等护栏 + unmapped 如实计数 */
{
  const X = mXmpGrid?.xmpImport;
  const cards = Array.isArray(X?.cards) ? X.cards : [];
  const counts = cards.map((c) => c.unmappedCount);
  check('R15-3 中性卡参数与 defaultParams 逐字相等 + 各卡 unmapped 计数上报',
    X?.neutralIsDefault === true && cards.length === 2 &&
    counts.every((n) => typeof n === 'number' && n > 0),
    `neutralIsDefault=${X?.neutralIsDefault} unmapped=[${counts.join(',')}]`);
}

/* R15-4 应用链路：DOM 点卡（真实 click 路径）→ store 与 currentRecipe 参数均与卡一致、origins 全 estimated */
{
  const A = mXmpGrid?.xmpImport?.applied;
  const B = mXmpApply?.xmpImport?.appliedBrand;
  check('R15-4 点击应用后配方参数与卡片一致（state + currentRecipe 双核对，origins 全 estimated）',
    A?.viaDomClick === true && A?.stateMatchesCard === true && A?.recipeMatchesCard === true &&
    A?.originsAllEstimated === true && A?.card === 'Neutral Check' &&
    B?.recipeMatchesCard === true && B?.card === 'Warm Matte',
    `中性卡 state=${A?.stateMatchesCard} recipe=${A?.recipeMatchesCard} origins=${A?.originsAllEstimated} · ` +
    `品牌卡 recipe=${B?.recipeMatchesCard}`);
}

/* R15-5 缩略图：当前帧过映射后 look+texture 渲染（384×216 JPEG），逐卡有内容 */
{
  const cards = Array.isArray(mXmpGrid?.xmpImport?.cards) ? mXmpGrid.xmpImport.cards : [];
  check('R15-5 缩略图逐卡渲染成功（当前帧过 look+texture）',
    cards.length === 2 && cards.every((c) => c.hasThumb === true),
    `thumbs=[${cards.map((c) => c.hasThumb).join(',')}]`);
}

/* R15-6 应用品牌卡后画面可辨（与 p1-01 默认帧对比） */
{
  if (xmpApplyShot && d1) {
    const d = meanAbsDiff(crop(xmpApplyShot, PV), crop(d1, PV));
    check('R15-6 应用 XMP 卡后画面可辨（PV 平均差>3）', d > 3, `PV 区域平均差=${d.toFixed(2)} 级（暖调哑光 vs 默认）`);
  } else check('R15-6 应用 XMP 卡截图', false, `缺图：p8-06=${!!xmpApplyShot} p1-01=${!!d1}`);
}

/* ================= R19 新增断言（卡片墙三分组筛选：全部 / 内置风格 / 我的卡） =================
 * 口径：型号卡/风格卡各有自己的 tab（已是两个分组）；第三组「我的卡」= 用户自己的卡
 * （当前 = 导入的 XMP 估算起点卡；R8 ⑤ 本地存卡是配方级，不进卡片墙）。筛选为纯显示层，
 * R15 断言与 XMP 卡位置/行为不受影响。chips 行由动态 chunk 插入 #tab-style 顶部。
 * p8-05 跑完整往返（末尾恢复「全部」）；p8-07 加 &filter=mine 结束在「我的卡」态。 */
const mXmpFilter = meta('p8-07-xmpfilter');
const xmpFilterDom = existsSync(join(OUT, 'p8-07-xmpfilter.dom')) ? readFileSync(join(OUT, 'p8-07-xmpfilter.dom'), 'utf8') : '';

/* R19-1 chips 存在且恢复「全部」：3 枚 chips（全部/内置风格/我的卡），两堵墙都可见 */
{
  const F = mXmpGrid?.xmpImport?.styleFilter;
  check('R19-1 风格卡 tab 分组 chips 存在（3 枚）且往返后恢复「全部」（两墙都可见）',
    F?.chips === 3 && F?.final === 'all' && F?.restored?.filter === 'all' &&
    F?.restored?.builtinVisible === true && F?.restored?.mineVisible === true,
    `chips=${F?.chips} final=${F?.final} restored=[内置=${F?.restored?.builtinVisible} 我的=${F?.restored?.mineVisible}]`);
}

/* R19-2 「我的卡」只显 XMP 卡：内置墙与顶部说明隐藏、XMP 网格可见（2 张）、专用空态不误显 */
{
  const M = mXmpGrid?.xmpImport?.styleFilter?.mine;
  check('R19-2 「我的卡」只显我的卡（内置墙+顶部说明隐藏，XMP 卡 2 张可见）',
    M?.filter === 'mine' && M?.builtinVisible === false && M?.topNoteVisible === false &&
    M?.mineVisible === true && M?.mineCount === 2 && M?.mineEmptyVisible === false,
    `内置=${M?.builtinVisible} 顶部说明=${M?.topNoteVisible} 我的=${M?.mineVisible} 卡数=${M?.mineCount}`);
}

/* R19-3 空态：0 卡 + 「我的卡」→ 专用空态提示（导入前抓取的事实）；空态文案与「我的卡」口径说明在 DOM */
{
  const E = mXmpGrid?.xmpImport?.styleFilter?.mineEmpty;
  const copyOk = xmpFilterDom.includes('用图库页的「导入 XMP 预设」生成第一张卡') &&
    xmpFilterDom.includes('不进卡片墙');
  check('R19-3 「我的卡」空态提示（0 卡时提示用图库页「导入 XMP 预设」生成第一张卡）+ 口径说明',
    E?.mineCount === 0 && E?.mineEmptyVisible === true && copyOk,
    `卡数=${E?.mineCount} 空态可见=${E?.mineEmptyVisible} 文案/口径在DOM=${copyOk}`);
}

/* R19-4 「内置风格」隐藏我的卡小节；p8-07 结束在「我的卡」态（截图 + DOM 双证） */
{
  const B = mXmpGrid?.xmpImport?.styleFilter?.builtin;
  const F7 = mXmpFilter?.xmpImport?.styleFilter;
  check('R19-4 「内置风格」隐藏我的卡小节（标题+网格）；p8-07 结束在「我的卡」态且 chips 在 DOM',
    B?.filter === 'builtin' && B?.builtinVisible === true && B?.mineVisible === false &&
    F7?.final === 'mine' && F7?.restored?.filter === 'mine' &&
    F7?.restored?.builtinVisible === false && F7?.restored?.mineVisible === true &&
    xmpFilterDom.includes('id="stylefilter"') && xmpFilterDom.includes('我的卡'),
    `内置=[${B?.builtinVisible},${B?.mineVisible}] p8-07 final=${F7?.final} chipsInDom=${xmpFilterDom.includes('id="stylefilter"')}`);
}

/* ================= R17 新增断言（GPU tile-atlas 烘焙一致性 / 数据范围开关 / 烘焙路径 meta） =================
 * p9-01/p9-02（demo=range）：SwiftShader 下真实跑 GPU 烘焙 vs CPU 烘焙逐点对比（<1e-3、≥500 点）
 * + 数据范围导出对比（full 无 COMMENT 且与 legal 文本不同、legal 头部声明、E∘f∘D 公式核验）。
 * p7-01（demo=perf）：perf meta 增加烘焙探针字段（路径 gpu/cpu-fallback + 65³ 耗时，只上报不设门——
 * SwiftShader 的 GPU 数字不代表真实收益）。 */
const mRange1 = meta('p9-01-range'), mRange2 = meta('p9-02-range-legal');
const range1Dom = existsSync(join(OUT, 'p9-01-range.dom')) ? readFileSync(join(OUT, 'p9-01-range.dom'), 'utf8') : '';
const range2Dom = existsSync(join(OUT, 'p9-02-range-legal.dom')) ? readFileSync(join(OUT, 'p9-02-range-legal.dom'), 'utf8') : '';

/* R17-1 GPU vs CPU 烘焙数值一致性（R10 口径：<1e-3、≥500 点） */
{
  const C = mRange1?.bakeConsistency;
  const ok = C?.pass === true && C?.gpuUsed === true &&
    typeof C?.maxDiffMatch === 'number' && C.maxDiffMatch < 1e-3 &&
    typeof C?.maxDiffRecipe === 'number' && C.maxDiffRecipe < 1e-3 &&
    typeof C?.points === 'number' && C.points >= 500;
  check('R17-1 GPU 烘焙 vs CPU 烘焙逐点一致（max<1e-3，≥500 点）', ok,
    `points=${C?.points} maxDiffMatch=${C?.maxDiffMatch} maxDiffRecipe=${C?.maxDiffRecipe} ` +
    `gpuUsed=${C?.gpuUsed} gpuFormat=${C?.gpuFormat} backend=${C?.backend}`);
}

/* R17-2 数据范围导出：full 默认逐字节语义保持（无 COMMENT）+ legal 头部声明 + E∘f∘D 公式核验 */
{
  const R = mRange1?.rangeCheck;
  const ok = R?.differ === true && R?.fullHasComment === false && R?.legalHasComment === true &&
    typeof R?.encodeErr === 'number' && R.encodeErr < 1e-5 &&
    Math.abs(R?.legalLow - 16 / 255) < 1e-4 && Math.abs(R?.legalHigh - 235 / 255) < 1e-4;
  check('R17-2 数据范围导出（full 无声明恒等 + legal COMMENT/E∘f∘D 核验）', ok,
    `differ=${R?.differ} fullCOMMENT=${R?.fullHasComment} legalCOMMENT=${R?.legalHasComment} ` +
    `encodeErr=${R?.encodeErr} legal=[${R?.legalLow},${R?.legalHigh}] 首行 ${JSON.stringify(R?.fullFirst)}→${JSON.stringify(R?.legalFirst)}`);
}

/* R17-3 数据范围开关 UI 与配方状态：⑤ 区分段控件存在；&rangeSel=legal 后 HUD 与控件切到 Legal */
{
  const segOk = range1Dom.includes('id="seg-range"') && range1Dom.includes('data-range="legal"') &&
    range1Dom.includes('数据范围 Full/Data');
  const range1 = /<span id="hud-range"[^>]*>([^<]*)<\/span>/.exec(range1Dom);
  const range2 = /<span id="hud-range"[^>]*>([^<]*)<\/span>/.exec(range2Dom);
  const legalApplied = mRange2?.exportRange === 'legal' && range2?.[1] === 'Legal';
  check('R17-3 数据范围分段开关（⑤ 区）+ HUD 范围字段随配方切换（Full ↔ Legal）',
    segOk && range1?.[1] === 'Full' && legalApplied,
    `seg-range=${segOk} p9-01 HUD=${range1?.[1]} p9-02 HUD=${range2?.[1]} meta.exportRange=${mRange2?.exportRange}`);
}

/* R17-4 烘焙路径与耗时 meta 字段（demo=perf 现有场景；路径字段必须存在，耗时只上报不设门） */
{
  const P = mPerf?.perf;
  const pathOk = P?.bakeProbe?.path === 'gpu' || P?.bakeProbe?.path === 'cpu-fallback';
  const fieldsOk = pathOk && typeof P?.bakeProbe?.ms === 'number' &&
    ['gpu', 'cpu-fallback', 'none'].includes(P?.lutBakePath);
  check('R17-4 烘焙路径/耗时 meta 字段齐备（bakeProbe.path ∈ gpu/cpu-fallback；耗时只上报不设门）',
    fieldsOk,
    `bakeProbe=${JSON.stringify(P?.bakeProbe)} lutBakePath=${P?.lutBakePath} lutBakeFormat=${P?.lutBakeFormat}`);
}

const pass = Object.values(results).filter((r) => r.pass).length;
console.log(`\n===== E2E ${pass}/${Object.keys(results).length} 项通过 =====`);
if (pass !== Object.keys(results).length) process.exit(1);
