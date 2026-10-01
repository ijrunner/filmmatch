#!/usr/bin/env node
/**
 * XMP → FilmMatch「估算起点卡」批量转换 CLI（R15；R19 增强多包/递归/全参数输出/聚合统计）。
 *
 * 用法：
 *   node tools/xmp-to-cards.mjs                     # 缺省目录 = <app>/../ref-materials/xmp（只扫顶层 .xmp）
 *                                                   # → 输出 <目录>/analysis/xmp-summary.json + 人工复核清单.md（R15 行为不变）
 *   node tools/xmp-to-cards.mjs <目录>              # 单目录模式（R19 起递归扫描子目录内的 .xmp）
 *                                                   # → 输出 <目录>/analysis/（同上）
 *   node tools/xmp-to-cards.mjs --root <目录>       # 多包模式（R19）：每个一级子目录 = 一个包，包内递归扫描
 *                                                   # → 每包输出 <root>/analysis/xmp-summary-<包名>.json +
 *                                                   #   人工复核清单-<包名>.md，另有汇总 xmp-summary-all.json +
 *                                                   #   人工复核清单-总览.md
 *   附加选项（两种模式通用）：
 *     --out <目录>   覆盖输出目录（默认按模式推导；多包模式输出恒在 root/analysis）
 *
 * 输出内容（全部只写 analysis/，git 仓库外，合规白区）：
 *   - summary JSON：每文件 文件名 / 清洗后卡名 / 解析键数 / 未识别键 / 未映射分组 / 警告 /
 *     参数摘要（旧字段 params）+ **params_full（完整 FilmParams 序列化，含 hsl，供质量门工具读取）**
 *   - 人工复核清单 md：表格 + 每张卡「建议人工关注点」（来自 unmapped / warnings）
 *   - 聚合统计：成功/失败、unmapped 分布、warnings 高频项、曲线族/分离色调/颗粒/暗角/HSL 触发率
 *
 * 合规：XMP 文件本体与提取的参数表不进 git、不分发（analysis/ 位于 ref-materials 下，已被忽略）。
 * 任意单文件解析失败不中断：记「失败 + 错误消息」继续下一个。
 *
 * TS 复用：用项目现成的 esbuild（vite 依赖）把 src/estimate/xmp.ts + xmpmap.ts
 * bundle 成临时 mjs 再动态 import（不新增依赖、不跑 tsc）。
 */
import { build } from 'esbuild';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');

/* ---------------- TS → 临时 bundle（esbuild，stdin 入口，无临时源文件） ---------------- */

async function loadEstimateModules() {
  const entry =
    `export * from ${JSON.stringify(path.join(appRoot, 'src/estimate/xmp.ts'))};\n` +
    `export * from ${JSON.stringify(path.join(appRoot, 'src/estimate/xmpmap.ts'))};\n`;
  const outfile = path.join(appRoot, 'node_modules', '.cache', `xmp-bundle-${process.pid}.mjs`);
  await mkdir(path.dirname(outfile), { recursive: true });
  await build({
    stdin: { contents: entry, resolveDir: appRoot, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { parseXmp: mod.parseXmp, mapXmpToFilm: mod.mapXmpToFilm, cleanCardName: mod.cleanCardName };
}

/* ---------------- 递归收集 .xmp（相对包目录的路径，POSIX 分隔符排序） ---------------- */

async function listXmpFiles(dir, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === 'analysis') continue; // 输出目录不回扫
      out.push(...(await listXmpFiles(path.join(dir, e.name), rel)));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.xmp') && !e.name.startsWith('._')) {
      out.push(rel);
    }
  }
  return out.sort((a, b) => a.localeCompare(b, 'zh'));
}

/* ---------------- 汇总产物 ---------------- */

/** 映射后关键参数摘要（只取本次映射会写的维度，供人工快速浏览） */
function paramSummary(params) {
  return {
    look: {
      film_s: params.look.film_s,
      contrast: params.look.contrast,
      fade: params.look.fade,
      black_lift: params.look.black_lift,
      saturation: params.look.saturation,
      warmth: params.look.warmth,
      split_shadow_hue: params.look.split_shadow_hue,
      split_shadow_sat: params.look.split_shadow_sat,
      split_highlight_hue: params.look.split_highlight_hue,
      split_highlight_sat: params.look.split_highlight_sat,
      split_balance: params.look.split_balance,
    },
    grain: {
      enabled: params.texture.grain.enabled,
      size: params.texture.grain.size,
      film_resolution: params.texture.grain.film_resolution,
    },
    vignette: {
      enabled: params.texture.vignette.enabled,
      amount: params.texture.vignette.amount,
      radius: params.texture.vignette.radius,
    },
  };
}

function reviewNote(r) {
  if (r.error) return `解析失败：${r.error}`;
  const notes = [];
  if (r.unmapped.length > 0) notes.push(`未映射：${r.unmapped.join('；')}`);
  notes.push(...r.warnings);
  if (notes.length === 0) notes.push('无特别提醒（仍为估算起点，需人工调校）');
  return notes.join('\n');
}

/** Markdown 表格单元格转义（| 与换行） */
function esc(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/* ---------------- 聚合统计（R19） ---------------- */

const UNMAPPED_LABEL_MAX = 24; // unmapped 分组按「（」前标签聚合
function unmappedBucket(u) {
  const i = u.indexOf('（');
  return (i > 0 ? u.slice(0, i) : u).trim();
}
function warningBucket(w) {
  if (w.includes('未识别 crs 键')) return '未识别键（Clarity/Dehaze/Texture/Local* 等真实无对应物键）';
  if (w.includes('估算起点')) return '曲线族为形状反解「估算起点」';
  if (w.includes('白位收拢')) return '白位收拢超出 fade 上限（已取 fade=1，高光更亮）';
  if (w.includes('连带抬高黑位')) return 'fade 连带抬黑位（black_lift 已取 0，暗部略灰）';
  if (w.includes('最大偏差')) return '曲线反解残差偏大（形状有损）';
  if (w.includes('暗角提亮')) return '暗角提亮方向不支持（量已忽略）';
  if (w.includes('黑白转换')) return '黑白转换（saturation=0，混色通道未映射）';
  if (w.includes('ShadowTint')) return 'Calibration.ShadowTint 与 SplitToning 冲突';
  return w.slice(0, 30);
}
function topCounts(list, n = 8) {
  const m = new Map();
  for (const x of list) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => ({ item: k, count: v }));
}

function aggregate(results) {
  const ok = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);
  const unmappedAll = [];
  const warnAll = [];
  for (const r of ok) {
    for (const u of r.unmapped) unmappedAll.push(unmappedBucket(u));
    for (const w of r.warnings) warnAll.push(warningBucket(w));
  }
  const t = (pred) => ok.filter(pred).length;
  return {
    total: results.length,
    ok: ok.length,
    failed: failed.length,
    keyCountSum: ok.reduce((s, r) => s + r.keyCount, 0),
    unrecognizedSum: ok.reduce((s, r) => s + r.unrecognizedKeys.length, 0),
    triggered: {
      /* 曲线族/分离色调/HSL/暗角 = 写出了非恒等值或显式开启；
       * 颗粒 = 映射触碰了颗粒段（GrainSize/Frequency/Amount 任一存在——注意 LR 默认值会映射成恒等值） */
      curveFamily: t((r) => r.paramsFull && (r.paramsFull.look.film_s > 0 || r.paramsFull.look.contrast > 0
        || r.paramsFull.look.fade > 0 || r.paramsFull.look.black_lift > 0)),
      splitToning: t((r) => r.paramsFull && (r.paramsFull.look.split_shadow_sat > 0 || r.paramsFull.look.split_highlight_sat > 0)),
      grain: t((r) => r.grainTouched === true),
      vignette: t((r) => r.paramsFull && r.paramsFull.texture.vignette.enabled),
      hsl: t((r) => r.paramsFull && r.paramsFull.look.hsl && Object.keys(r.paramsFull.look.hsl).length > 0),
      saturationNonDefault: t((r) => r.paramsFull && r.paramsFull.look.saturation !== 1),
      warmthNonDefault: t((r) => r.paramsFull && r.paramsFull.look.warmth !== 0),
    },
    unmappedTop: topCounts(unmappedAll),
    warningsTop: topCounts(warnAll),
  };
}

/* ---------------- 单目录处理（读文件 → 解析 → 映射 → 记录） ---------------- */

/** recursive=false 时只扫顶层（R15 缺省行为）；显式传目录 / 包目录一律递归 */
async function processDir(dir, mods, recursive = true) {
  const files = recursive ? await listXmpFiles(dir) : (await readdir(dir))
    .filter((f) => f.toLowerCase().endsWith('.xmp') && !f.startsWith('._'))
    .sort((a, b) => a.localeCompare(b, 'zh'));
  const results = [];
  for (const rel of files) {
    const rec = {
      file: rel, cardName: '', presetName: '', keyCount: 0,
      unrecognizedKeys: [], unmapped: [], warnings: [],
      params: null, paramsFull: null, grainTouched: false, error: '',
    };
    try {
      const text = await readFile(path.join(dir, rel), 'utf8');
      const ir = mods.parseXmp(text);
      const mapped = mods.mapXmpToFilm(ir);
      rec.cardName = mods.cleanCardName(path.basename(rel));
      rec.presetName = ir.name ?? '';
      rec.keyCount = ir.keyCount;
      rec.unrecognizedKeys = ir.unrecognizedKeys;
      rec.unmapped = mapped.unmapped;
      rec.warnings = mapped.warnings;
      rec.params = paramSummary(mapped.params);
      // 完整参数（含 hsl / coupling / 全 texture 段）供质量门与逐卡导入使用
      rec.paramsFull = JSON.parse(JSON.stringify(mapped.params));
      rec.grainTouched = mapped.origins['grain.size'] !== undefined
        || mapped.origins['grain.film_resolution'] !== undefined;
    } catch (e) {
      rec.error = e?.message ?? String(e);
      rec.cardName = mods.cleanCardName(path.basename(rel));
    }
    results.push(rec);
  }
  return results;
}

function okOf(results) { return results.filter((r) => !r.error); }
function failedOf(results) { return results.filter((r) => r.error); }

async function writeReviewMd(mdPath, title, dir, results) {
  const ok = okOf(results);
  const failed = failedOf(results);
  const md = [];
  md.push(`# ${title}`);
  md.push('');
  md.push(`> 生成时间 ${new Date().toISOString()}；来源目录 \`${dir}\`；共 ${results.length} 个文件，成功 ${ok.length}，失败 ${failed.length}。`);
  md.push('> 全部映射为**有损估算起点**：逐卡人工调校后才可入库为风格卡。参数表与 XMP 本体留在 ref-materials（不进 git、不分发）。');
  md.push('');
  md.push('| # | 卡名 | 来源文件 | 预设名 | 键数 | 未识别 | 未映射维度 | 建议人工关注点 |');
  md.push('|---|------|----------|--------|------|--------|------------|----------------|');
  for (let i = 0; i < ok.length; i++) {
    const r = ok[i];
    md.push(`| ${i + 1} | ${esc(r.cardName)} | ${esc(r.file)} | ${esc(r.presetName || '—')} | ${r.keyCount} | ${r.unrecognizedKeys.length} | ${r.unmapped.length} 组 | ${esc(reviewNote(r))} |`);
  }
  if (failed.length > 0) {
    md.push('');
    md.push('## 失败文件（需要单独处理）');
    md.push('');
    for (const r of failed) md.push(`- ${r.file}：${r.error}`);
  }
  md.push('');
  await writeFile(mdPath, md.join('\n'), 'utf8');
}

function printResults(label, results) {
  for (const r of results) {
    if (r.error) console.log(`FAIL  [${label}] ${r.file}  ${r.error}`);
    else console.log(`OK    [${label}] ${r.cardName}  <-  ${r.file}（键 ${r.keyCount} · 未识别 ${r.unrecognizedKeys.length} · 未映射 ${r.unmapped.length} 组 · 警告 ${r.warnings.length}）`);
  }
}

/* ---------------- 主流程 ---------------- */

async function main() {
  /* 参数解析：--root <dir> / --out <dir> / 若干位置目录 */
  const args = process.argv.slice(2);
  let rootArg = null;
  let outArg = null;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') rootArg = args[++i];
    else if (args[i] === '--out') outArg = args[++i];
    else positional.push(args[i]);
  }
  const defaultDir = path.join(appRoot, '..', 'ref-materials', 'xmp');
  const mods = await loadEstimateModules();

  if (rootArg !== null) {
    /* ===== 多包模式：root 下一级子目录 = 包，包内递归；输出恒在 <root>/analysis/ ===== */
    const root = path.resolve(rootArg);
    const outDir = path.resolve(outArg ?? path.join(root, 'analysis'));
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (e) {
      console.error(`无法读取目录 ${root}：${e?.message ?? e}`);
      process.exitCode = 1;
      return;
    }
    const packages = entries.filter((e) => e.isDirectory() && e.name !== 'analysis')
      .map((e) => e.name).sort((a, b) => a.localeCompare(b, 'zh'));
    if (packages.length === 0) {
      console.error(`--root 模式：${root} 下没有子目录（包）。`);
      process.exitCode = 1;
      return;
    }
    await mkdir(outDir, { recursive: true });

    const rollup = { tool: 'tools/xmp-to-cards.mjs --root', generatedAt: new Date().toISOString(), root, packages: {} };
    let anyFail = 0;
    for (const pkg of packages) {
      const dir = path.join(root, pkg);
      const results = await processDir(dir, mods);
      const stats = aggregate(results);
      const summary = {
        tool: 'tools/xmp-to-cards.mjs', mode: 'package', generatedAt: new Date().toISOString(),
        directory: dir, package: pkg, ...stats, results,
      };
      await writeFile(path.join(outDir, `xmp-summary-${pkg}.json`), JSON.stringify(summary, null, 2), 'utf8');
      await writeReviewMd(path.join(outDir, `人工复核清单-${pkg}.md`), `XMP → 估算起点卡 · 人工复核清单（${pkg}）`, dir, results);
      rollup.packages[pkg] = { ok: stats.ok, failed: stats.failed, triggered: stats.triggered };
      anyFail += stats.failed;
      printResults(pkg, results);
      const s = stats;
      console.log(`汇总[${pkg}]：成功 ${s.ok} / 失败 ${s.failed}；触发率：曲线族 ${s.triggered.curveFamily}/${s.ok} · 分离色调 ${s.triggered.splitToning} · 颗粒 ${s.triggered.grain} · 暗角 ${s.triggered.vignette} · HSL ${s.triggered.hsl} · 饱和≠1 ${s.triggered.saturationNonDefault} · 暖度≠0 ${s.triggered.warmthNonDefault}`);
    }
    await writeFile(path.join(outDir, 'xmp-summary-all.json'), JSON.stringify(rollup, null, 2), 'utf8');
    const totalOk = Object.values(rollup.packages).reduce((s, p) => s + p.ok, 0);
    const totalFail = Object.values(rollup.packages).reduce((s, p) => s + p.failed, 0);
    const md = [];
    md.push('# XMP → 估算起点卡 · 多包转换总览');
    md.push('');
    md.push(`> 生成时间 ${rollup.generatedAt}；root \`${root}\`；包数 ${packages.length}，合计成功 ${totalOk}，失败 ${totalFail}。`);
    md.push('> 全部为**有损估算起点**；逐包明细见同目录 `人工复核清单-<包名>.md`。参数表与 XMP 本体不进 git、不分发。');
    md.push('');
    md.push('| 包 | 成功 | 失败 | 曲线族 | 分离色调 | 颗粒 | 暗角 | HSL |');
    md.push('|---|---|---|---|---|---|---|---|');
    for (const [pkg, p] of Object.entries(rollup.packages)) {
      const t = p.triggered;
      md.push(`| ${esc(pkg)} | ${p.ok} | ${p.failed} | ${t.curveFamily} | ${t.splitToning} | ${t.grain} | ${t.vignette} | ${t.hsl} |`);
    }
    md.push('');
    await writeFile(path.join(outDir, '人工复核清单-总览.md'), md.join('\n'), 'utf8');
    console.log(`多包汇总：包 ${packages.length} · 成功 ${totalOk} / 失败 ${totalFail}；输出 → ${outDir}`);
    if (anyFail > 0) process.exitCode = 2;
    return;
  }

  /* ===== 单目录模式（R15 缺省 = 只扫顶层；显式目录 = 递归，R19 增强） ===== */
  const explicitDir = positional[0] ?? null;
  const dir = path.resolve(explicitDir ?? defaultDir);
  const outDir = path.resolve(outArg ?? path.join(dir, 'analysis'));
  const results = await processDir(dir, mods, explicitDir !== null);
  const stats = aggregate(results);
  const ok = okOf(results);
  const failed = failedOf(results);

  await mkdir(outDir, { recursive: true });
  const summary = {
    tool: 'tools/xmp-to-cards.mjs', mode: 'single', generatedAt: new Date().toISOString(),
    directory: dir, ...stats, results,
  };
  await writeFile(path.join(outDir, 'xmp-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  await writeReviewMd(path.join(outDir, '人工复核清单.md'), 'XMP → 估算起点卡 · 人工复核清单', dir, results);

  printResults('', results);
  const s = stats;
  console.log(`汇总：成功 ${ok.length} / 失败 ${failed.length}；触发率：曲线族 ${s.triggered.curveFamily}/${ok.length} · 分离色调 ${s.triggered.splitToning} · 颗粒 ${s.triggered.grain} · 暗角 ${s.triggered.vignette} · HSL ${s.triggered.hsl}；输出 → ${outDir}`);
  if (failed.length > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error(`CLI 异常：${e?.message ?? e}`);
  process.exitCode = 1;
});
