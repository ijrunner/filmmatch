#!/usr/bin/env node
/**
 * R11 视觉回归基线：把 tools/e2e/*.png 的「紧凑签名」存成 JSON 基线，之后每次跑完 E2E 自动比对。
 *
 * 为什么存签名而不是整张 PNG：
 *   - 仓库体积：26 张截图约 3–5MB，签名只有几 KB；
 *   - 抗噪：无头 SwiftShader 的软件光栅化在不同负载下有轻微像素抖动，逐位比对会假失败；
 *     签名用「64×64 灰度均值差 + dHash 汉明距离 + 亮度均值差」三个指标，能抓住布局/配色/内容回归，
 *     又不被亚像素抖动干扰。
 *
 * 用法：
 *   node tools/visual-baseline.mjs --record     # 记录/更新基线（改动 UI 后确认过再跑）
 *   node tools/visual-baseline.mjs              # 校验（默认；E2E 链尾部自动调用）
 *   node tools/visual-baseline.mjs --verbose    # 打印每张的三个指标
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'tools', 'e2e');
const BASELINE = join(SHOTS, 'visual-baseline.json');

/* 阈值（经验值，改动 UI 时若确认是有意变更就 --record 更新基线） */
const TH = {
  /* R13 稳定性：无头 SwiftShader 在不同负载下会有 1–3 级的灰度抖动（实测 p1-04b 曾达 2.52，
   * 紧贴原阈值 2.5 导致假失败）。放宽到 3.5 / 3.5 / 12：仍能抓住布局/配色/内容回归
   * （真实回归的灰度差通常是 10+ 级、dHash 距离 20+ 位），但不被光栅化抖动干扰。 */
  grayMeanAbs: 3.5,   // 64×64 灰度平均绝对差（0..255）
  lumMeanAbs: 3.5,    // 全图亮度均值差
  dHashDist: 12,      // dHash 汉明距离（64 位里允许的位数）
};

/** 64×64 灰度缩略（盒式下采样）+ 9×9 dHash + 全图亮度均值 */
function signature(file) {
  const png = PNG.sync.read(readFileSync(file));
  const { width: W, height: H, data } = png;
  const N = 64;
  const gray = new Float64Array(N * N);
  const cnt = new Float64Array(N * N);
  let lumSum = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const g = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      lumSum += g;
      const gx = Math.min(N - 1, Math.floor((x / W) * N));
      const gy = Math.min(N - 1, Math.floor((y / H) * N));
      gray[gy * N + gx] += g;
      cnt[gy * N + gx]++;
    }
  }
  for (let i = 0; i < gray.length; i++) gray[i] = cnt[i] > 0 ? gray[i] / cnt[i] : 0;
  /* dHash：9×8 采样，比较相邻列亮度 → 64 位 */
  const M = 9;
  const dhash = [];
  for (let ry = 0; ry < 8; ry++) {
    for (let rx = 0; rx < 8; rx++) {
      const a = gray[Math.floor((ry / 8) * N) * N + Math.floor((rx / M) * N)];
      const b = gray[Math.floor((ry / 8) * N) * N + Math.floor(((rx + 1) / M) * N)];
      dhash.push(a > b ? 1 : 0);
    }
  }
  /* 灰度缩略量化为 0..255 再 base64：比 JSON 数组小 4.5 倍（4096 字节/张） */
  const q = Buffer.from(gray, (_, v) => Math.max(0, Math.min(255, Math.round(v)))).toString('base64');
  return {
    gray: q,
    dhash: dhash.join(''),
    lum: +(lumSum / (W * H)).toFixed(2),
    w: W,
    h: H,
  };
}

const hashDist = (a, b) => {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) d++;
  return d;
};

const pngs = existsSync(SHOTS)
  ? readdirSync(SHOTS).filter((f) => f.endsWith('.png')).sort()
  : [];
if (!pngs.length) {
  console.error('[visual] tools/e2e 下没有截图 —— 先跑 bash tools/e2e-shots.sh');
  process.exit(1);
}

const record = process.argv.includes('--record');
const verbose = process.argv.includes('--verbose');

if (record) {
  const out = { at: new Date().toISOString(), note: 'R11 视觉回归基线（紧凑签名）', shots: {} };
  for (const f of pngs) out.shots[f] = signature(join(SHOTS, f));
  writeFileSync(BASELINE, JSON.stringify(out) + '\n');
  console.log(`[visual] 已记录 ${pngs.length} 张截图基线 → ${BASELINE}`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error('[visual] 缺基线文件 —— 先执行 node tools/visual-baseline.mjs --record');
  process.exit(1);
}
const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
let fail = 0;
let checked = 0;
const rows = [];
for (const f of pngs) {
  const b = base.shots[f];
  if (!b) { rows.push([f, 'NEW', '—', '—', '基线里没有这张（新截图）']); fail++; continue; }
  const s = signature(join(SHOTS, f));
  const ga = Buffer.from(s.gray, 'base64');
  const gb = Buffer.from(b.gray, 'base64');
  let gSum = 0;
  for (let i = 0; i < ga.length; i++) gSum += Math.abs(ga[i] - (gb[i] ?? 0));
  const grayMean = gSum / ga.length;
  const lumDiff = Math.abs(s.lum - b.lum);
  const dh = hashDist(s.dhash, b.dhash);
  const bad = grayMean > TH.grayMeanAbs || lumDiff > TH.lumMeanAbs || dh > TH.dHashDist;
  if (bad) fail++;
  checked++;
  rows.push([f, grayMean.toFixed(2), lumDiff.toFixed(2), String(dh), bad ? 'FAIL' : 'ok']);
}
const missing = Object.keys(base.shots).filter((f) => !pngs.includes(f));

console.log('===== R11 视觉回归（紧凑签名比对） =====');
if (verbose) {
  console.log('截图'.padEnd(30) + '灰度差  亮度差  dHash  判定');
  for (const r of rows) console.log(String(r[0]).padEnd(30) + String(r[1]).padEnd(8) + String(r[2]).padEnd(8) + String(r[3]).padEnd(7) + r[4]);
} else {
  for (const r of rows) if (r[4] !== 'ok') console.log(`  ${r[4]} ${r[0]}（灰度差 ${r[1]} / 亮度差 ${r[2]} / dHash ${r[3]}）`);
}
if (missing.length) console.log(`  （基线里有、本次未生成的截图 ${missing.length} 张：${missing.join(', ')}）`);
console.log(`阈值：灰度差 ≤${TH.grayMeanAbs} · 亮度差 ≤${TH.lumMeanAbs} · dHash ≤${TH.dHashDist}`);
console.log(fail === 0
  ? `✅ 视觉回归通过：${checked}/${pngs.length} 张与基线一致`
  : `❌ 视觉回归失败：${fail}/${pngs.length} 张超出阈值（确认是有意改动后跑 --record 更新基线）`);
process.exit(fail === 0 ? 0 : 1);
