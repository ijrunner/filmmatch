#!/usr/bin/env node
/**
 * 卡片质量门（R19）：对「估算起点卡」（XMP 批量转换产物或 --cards JSON）逐卡跑三道门，
 * 输出 PASS/FAIL + 原因到 ../ref-materials/xmp/analysis/质量门报告.md + .json（合规白区）。
 * FAIL 的卡不是删掉，是如实列出待人工调校。
 *
 * 用法：
 *   node tools/card-quality-gate.mjs --dir <xmp目录>            # 读 <dir>/analysis/xmp-summary.json（R15 单目录口径）
 *   node tools/card-quality-gate.mjs --root <xmp根目录>         # 多包口径：读 <root>/analysis/xmp-summary-<包>.json 全部
 *   node tools/card-quality-gate.mjs --summary <summary.json>   # 直接指定 summary JSON（与 --dir 同用）
 *   node tools/card-quality-gate.mjs --cards <cards.json>       # 直接喂卡：[{name, params, class?, source?}] 或 {cards:[...]}
 *   选项：--out <目录>（默认 <app>/../ref-materials/xmp/analysis）；--class style|model（--cards 输入的缺省类，默认 style）
 *
 * 三道门与门值出处（以代码现状为准，全部现读不手抄）：
 *   ① 参数区间合法：
 *      - look 14 键：区间现读自 src/ui/storage.ts 的 LOOK_BOUNDS 字面量（其注释明示口径 =
 *        「运行时钳制范围 engine/look 的 clamp」而非面板滑杆范围——用它不会把历史合法值误判为越界）；
 *      - HSL 通道 / coupling 六系数：现读自同文件 HSL_BOUNDS / COUPLING_BOUNDS（R18）；
 *      - texture 数值键：滑杆区间现读自 src/ui/paramui.ts 的 GROUPS（面板范围比运行时窄，
 *        超面板 = WARN「面板滑杆表达不了」而非 FAIL）；无区间定义的数值键要求有限且非负
 *        （同 storage.ts TEX 口径），tint_rgb 数组逐分量 0..1。look/hsl/coupling 越界或非有限 = FAIL。
 *   ② 卡名/来源品牌词零泄漏：词表现读自 src/estimate/xmpmap.ts 的 BRAND_WORDS（导出常量），
 *      按其两遍正则口径（词边界遍 + 复合词放宽右边界遍）重建匹配器；命中 = FAIL。
 *   ③ 与内置卡两两均值差门（同帧 look 渲染口径，src/film/styles.test.ts meanLookDiff 同式：
 *      lookTransform 逐像素、0..255 级平均绝对差；只覆盖 look 段，质感层不计入——既有口径）：
 *      - 风格卡类：与 6 张内置风格卡（STYLES，src/film/params.ts 现读）两两均值差最小值 > 8 级
 *        （R8 门，styles.test.ts「两两观感差 > 8 级」）且与中性 > 8 级（同文件）；
 *      - 型号卡类：与 10 张内置型号卡（PRESETS fl01–fl10）两两均值差最小值 > 5 级、与原图差 ≥ 4 级
 *        （**既有型号卡门值是 >5 / ≥4，不是任务书草稿写的 >3**：tools/e2e-verify.mjs ①②/R2-1/R2-2
 *        断言「两两均值差>5」「每张与原图差≥4」，出处 tools/EFFECT-REPORT-R2.md §R2-1/R2-2）。
 *      渲染帧 = 程序化校色卡数组（scenes.ts drawChart 同一调色板：24 色块 + 17 级灰阶 +
 *      3 肤色 + 6 饱和条 + 50% 半透条叠 #6a6a6a 底 + 黑白点），node 可复现、无 canvas 依赖。
 *
 * 合规：本工具只读 src 代码常量与 ref-materials 白区产物；报告只写 analysis/；不进 git。
 */
import { build } from 'esbuild';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');

/** 门值与出处（写进 JSON 报告供追溯；md 报告同文） */
const GATE_JSON = {
  style: { pairwise: 8, pairwiseInclusiveFail: true, vsNeutral: 8, vsNeutralInclusiveFail: true,
    source: 'src/film/styles.test.ts（R8 风格卡两两观感差 >8 级、与中性 >8 级）' },
  model: { pairwise: 5, pairwiseInclusiveFail: true, vsNeutral: 4, vsNeutralInclusiveFail: false,
    source: 'tools/e2e-verify.mjs R2-1/R2-2 + tools/EFFECT-REPORT-R2.md §R2-1/R2-2（型号卡两两 >5、与原图 ≥4；非任务书草稿的 >3，以代码现状为准）' },
  scope: '同帧 look 渲染口径（lookTransform，0..255 级平均绝对差；质感层不计入，与 styles.test.ts 一致）',
};

/* ---------------- TS → 临时 bundle（esbuild，同 xmp-to-cards.mjs 的老办法） ---------------- */

const ENTRY_FILES = [
  'src/estimate/xmp.ts',       // parseXmp（旧版 summary 缺 params_full 时的重解析回退）
  'src/estimate/xmpmap.ts',    // mapXmpToFilm / cleanCardName / BRAND_WORDS（词表现读）
  'src/engine/look.ts',        // lookTransform / NEUTRAL_LOOK（渲染口径单一真源）
  'src/film/params.ts',        // PRESETS / STYLES / STOCK_IDS / STYLE_IDS / GROUPS 所在链（内置卡现读）
  'src/ui/paramui.ts',         // GROUPS（texture/look/master 面板滑杆区间现读；纯规格无 DOM）
];

async function loadModules() {
  const entry = ENTRY_FILES.map((f) => `export * from ${JSON.stringify(path.join(appRoot, f))};\n`).join('');
  const outfile = path.join(appRoot, 'node_modules', '.cache', `card-gate-bundle-${process.pid}.mjs`);
  await mkdir(path.dirname(outfile), { recursive: true });
  await build({
    stdin: { contents: entry, resolveDir: appRoot, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

/* ---------------- 区间表现读（src/ui/storage.ts 的 LOOK/HSL/COUPLING_BOUNDS 字面量） ---------------- */

async function readStorageBounds() {
  const src = await readFile(path.join(appRoot, 'src/ui/storage.ts'), 'utf8');
  const grab = (name) => {
    const m = src.match(new RegExp(`const ${name}[^=]*=\\s*\\{([\\s\\S]*?)\\};`));
    if (!m) throw new Error(`src/ui/storage.ts 中找不到 ${name}（区间表现读失败，请核对源码）`);
    const out = {};
    for (const em of m[1].matchAll(/([A-Za-z_0-9.']+):\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]/g)) {
      out[em[1]] = [parseFloat(em[2]), parseFloat(em[3])];
    }
    return out;
  };
  return { LOOK_BOUNDS: grab('LOOK_BOUNDS'), HSL_BOUNDS: grab('HSL_BOUNDS'), COUPLING_BOUNDS: grab('COUPLING_BOUNDS') };
}

/* ---------------- 面板滑杆区间（src/ui/paramui.ts GROUPS 现读 → {look:{k:[min,max]}, texture:{组:{k:[min,max]}}}） ---------------- */

function panelSpecOf(mods) {
  const look = {};
  const texture = {};
  for (const g of mods.GROUPS) {
    if (g.kind === 'look' || g.kind === 'master') {
      for (const p of g.params) look[p.k] = [p.min, p.max];
    } else {
      const spec = {};
      for (const p of g.params) {
        if (p.type === 'select') continue;
        spec[p.k] = [p.min, p.max];
      }
      texture[g.id] = spec;
    }
  }
  return { look, texture };
}

/* ---------------- 品牌词匹配器（词表来自 xmpmap.BRAND_WORDS，正则口径同其 buildBrandRegex） ---------------- */

function buildBrandMatchers(words) {
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mk = (ws, rightGuard) => {
    const pattern = ws.slice().sort((a, b) => b.length - a.length).map(escapeRe).join('|');
    const right = rightGuard ? '(?![A-Za-z0-9])' : '';
    return new RegExp(`(?<![A-Za-z0-9])(${pattern})${right}`, 'gi');
  };
  /* 复合词高发子表（连写如 ExposureX7 也要洗）——与 xmpmap.ts 的 BRAND_COMPOUND_WORDS 同口径 */
  const compound = words.filter((w) => /^(Exposure|Vision3|CineStill|Dehancer|Kodak|Fuji|RNI)$/i.test(w));
  return { main: mk(words, true), compound: mk(compound, false) };
}

function findBrandHit(matchers, text) {
  for (const re of [matchers.main, matchers.compound]) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) return m[1] ?? m[0];
  }
  return null;
}

/* ---------------- 渲染帧：程序化校色卡数组（scenes.ts drawChart 同调色板） ---------------- */

function hexToRgb01(h) {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const CC_COLORS = ['#735244', '#c29682', '#627a9d', '#576c43', '#8580b1', '#67bdaa',
  '#d67e2c', '#505ba6', '#c15a63', '#5e3c6c', '#9dbc40', '#e0a32e',
  '#383d96', '#469449', '#af363c', '#e7c71f', '#bb5695', '#0885a1',
  '#f3f3f2', '#c8c8c8', '#a0a0a0', '#7a7a7a', '#555555', '#343434']; // 同 src/film/scenes.ts drawChart
const SKIN_COLORS = ['#f0c8a0', '#c8956c', '#8d5a3c'];               // 同 drawChart 肤色条
const SAT_COLORS = ['#ff0000', '#00ff00', '#0000ff', '#ff00ff', '#ffff00', '#00ffff']; // 同 drawChart 饱和条

function chartFrame() {
  const px = [];
  for (const c of CC_COLORS) px.push(hexToRgb01(c));
  for (let i = 0; i < 17; i++) { const v = Math.round(255 * i / 16) / 255; px.push([v, v, v]); }
  for (const c of SKIN_COLORS) px.push(hexToRgb01(c));
  const bg = 0x6a / 255; // drawChart 的 #6a6a6a 底色（50% 半透条叠在其上）
  for (const c of SAT_COLORS) {
    const a = hexToRgb01(c);
    px.push(a);
    px.push([0.5 * a[0] + 0.5 * bg, 0.5 * a[1] + 0.5 * bg, 0.5 * a[2] + 0.5 * bg]);
  }
  px.push([1, 1, 1], [0, 0, 0]);
  return px;
}

/** 同帧 look 渲染口径（styles.test.ts meanLookDiff 同式）：0..255 级平均绝对差 */
function meanLookDiff(fa, fb, frame) {
  let s = 0;
  for (const p of frame) {
    const oa = fa(p);
    const ob = fb(p);
    s += (Math.abs(oa[0] - ob[0]) + Math.abs(oa[1] - ob[1]) + Math.abs(oa[2] - ob[2])) / 3;
  }
  return (s / frame.length) * 255;
}

/* ---------------- ① 区间门 ---------------- */

function checkRanges(params, bounds, panelSpec) {
  const reasons = [];
  const warnings = [];
  const look = params.look ?? {};
  for (const [k, [lo, hi]] of Object.entries(bounds.LOOK_BOUNDS)) {
    const v = look[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      reasons.push(`look.${k}=${String(v)} 非有限数`);
      continue;
    }
    if (v < lo || v > hi) reasons.push(`look.${k}=${v} 越界（运行时区间 ${lo}..${hi}）`);
    const p = panelSpec.look[k];
    if (p && (v < p[0] || v > p[1])) {
      warnings.push(`look.${k}=${v} 超出面板滑杆区间 ${p[0]}..${p[1]}（合法但面板滑杆表达不了，需导入/JSON 路径调校）`);
    }
  }
  if (look.hsl && typeof look.hsl === 'object') {
    for (const [hue, ch] of Object.entries(look.hsl)) {
      if (!ch || typeof ch !== 'object') continue;
      for (const [sk, sv] of Object.entries(ch)) {
        const b = bounds.HSL_BOUNDS[sk];
        if (!b) continue;
        if (typeof sv !== 'number' || !Number.isFinite(sv)) reasons.push(`look.hsl.${hue}.${sk} 非有限数`);
        else if (sv < b[0] || sv > b[1]) reasons.push(`look.hsl.${hue}.${sk}=${sv} 越界（${b[0]}..${b[1]}）`);
      }
    }
  }
  if (look.coupling && typeof look.coupling === 'object') {
    for (const [ck, cv] of Object.entries(look.coupling)) {
      const b = bounds.COUPLING_BOUNDS[ck];
      if (!b) continue;
      if (typeof cv !== 'number' || !Number.isFinite(cv)) reasons.push(`look.coupling.${ck} 非有限数`);
      else if (cv < b[0] || cv > b[1]) reasons.push(`look.coupling.${ck}=${cv} 越界（${b[0]}..${b[1]}）`);
    }
  }
  const tex = params.texture ?? {};
  for (const [g, spec] of Object.entries(panelSpec.texture)) {
    const grp = tex[g];
    if (!grp || typeof grp !== 'object') continue;
    for (const [k, v] of Object.entries(grp)) {
      if (typeof v === 'boolean' || typeof v === 'string') continue;
      if (Array.isArray(v)) {
        if (!v.every((x) => Number.isFinite(x))) reasons.push(`texture.${g}.${k} 含非有限分量`);
        else if (!v.every((x) => x >= 0 && x <= 1)) reasons.push(`texture.${g}.${k} 分量越界（应 0..1）`);
        continue;
      }
      if (typeof v !== 'number') continue;
      if (!Number.isFinite(v)) { reasons.push(`texture.${g}.${k} 非有限数`); continue; }
      if (v < 0) { reasons.push(`texture.${g}.${k}=${v} 为负（质感段应非负）`); continue; }
      const p = spec[k];
      if (p && (v < p[0] || v > p[1])) {
        warnings.push(`texture.${g}.${k}=${v} 超出面板滑杆区间 ${p[0]}..${p[1]}（合法但需注意）`);
      }
    }
  }
  const master = params.master;
  if (master !== undefined) {
    const p = panelSpec.look.master ?? [0, 2];
    if (typeof master !== 'number' || !Number.isFinite(master)) reasons.push('master 非有限数');
    else if (master < p[0] || master > p[1]) reasons.push(`master=${master} 越界（面板区间 ${p[0]}..${p[1]}）`);
  }
  return { reasons, warnings };
}

/* ---------------- 卡来源（summary JSON / --cards） ---------------- */

async function cardsFromSummary(summaryPath, dir, mods) {
  const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  const cards = [];
  for (const r of summary.results ?? []) {
    if (r.error) continue;
    let params = r.paramsFull ?? null;
    if (!params) {
      // 旧版 summary 无 params_full：从白区 XMP 重解析（解析器/映射与转换时同一套 TS）
      const text = await readFile(path.join(dir, r.file), 'utf8');
      params = mods.mapXmpToFilm(mods.parseXmp(text)).params;
    }
    /* source/note 按产品实际存储形态构造（src/ui/xmpimport.ts：source = 'xmp:<清洗后文件名>'，
     * 注释含来源清洗名——溯源面不含原始路径，品牌词门只对用户可见面负责） */
    const source = `xmp:${r.cardName}`;
    const note = `估算起点 · XMP 导入（来源：${r.cardName}）`;
    cards.push({ name: r.cardName, source, note, params, cardClass: 'style' });
  }
  return cards;
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const args = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir') opt.dir = args[++i];
    else if (args[i] === '--root') opt.root = args[++i];
    else if (args[i] === '--summary') opt.summary = args[++i];
    else if (args[i] === '--cards') opt.cards = args[++i];
    else if (args[i] === '--out') opt.out = args[++i];
    else if (args[i] === '--class') opt.class = args[++i];
  }
  if (!opt.dir && !opt.root && !opt.summary && !opt.cards) {
    console.error('用法：node tools/card-quality-gate.mjs --dir <xmp目录> | --root <根目录> | --summary <json> | --cards <json> [--out <目录>] [--class style|model]');
    process.exitCode = 1;
    return;
  }

  const mods = await loadModules();
  const bounds = await readStorageBounds();
  const panelSpec = panelSpecOf(mods);
  const matchers = buildBrandMatchers([...mods.BRAND_WORDS]);
  const frame = chartFrame();

  const neutralFn = mods.lookTransform(mods.NEUTRAL_LOOK);
  const builtinFns = new Map();
  for (const [cls, ids, table] of [['style', mods.STYLE_IDS, mods.STYLES], ['model', mods.STOCK_IDS, mods.PRESETS]]) {
    for (const id of ids) {
      builtinFns.set(`${cls}:${id}`, {
        cls, id, name: table[id].name, fn: mods.lookTransform(table[id].params.look),
        lookKey: JSON.stringify(table[id].params.look),
      });
    }
  }

  /* 组装待检卡：[{ pkg, cards: [{name, source, note, params, cardClass}] }] */
  const groups = [];
  if (opt.cards) {
    const raw = JSON.parse(await readFile(opt.cards, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.cards ?? [];
    groups.push({
      pkg: path.basename(opt.cards),
      cards: list.map((c) => ({ ...c, cardClass: c.class ?? c.cardClass ?? opt.class ?? 'style' })),
    });
  } else if (opt.root) {
    const root = path.resolve(opt.root);
    const analysisDir = path.join(root, 'analysis');
    const files = (await readdir(analysisDir))
      .filter((f) => /^xmp-summary-.+\.json$/.test(f) && f !== 'xmp-summary-all.json')
      .sort((a, b) => a.localeCompare(b, 'zh'));
    for (const f of files) {
      const pkg = f.replace(/^xmp-summary-/, '').replace(/\.json$/, '');
      groups.push({ pkg, cards: await cardsFromSummary(path.join(analysisDir, f), path.join(root, pkg), mods) });
    }
  } else {
    const dir = path.resolve(opt.dir ?? path.join(appRoot, '..', 'ref-materials', 'xmp'));
    const summaryPath = path.resolve(opt.summary ?? path.join(dir, 'analysis', 'xmp-summary.json'));
    groups.push({ pkg: path.basename(dir), cards: await cardsFromSummary(summaryPath, dir, mods) });
  }

  /* 逐卡跑门 */
  const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, '；');
  const report = { tool: 'tools/card-quality-gate.mjs', generatedAt: new Date().toISOString(), gates: GATE_JSON, packages: {} };

  for (const grp of groups) {
    const rows = [];
    let pass = 0, fail = 0, warnCount = 0;
    for (const card of grp.cards) {
      const cls = card.cardClass === 'model' ? 'model' : 'style';
      const gate = GATE_JSON[cls];
      const reasons = [];
      const warnings = [];
      /* ① 区间门 */
      const range = checkRanges(card.params ?? {}, bounds, panelSpec);
      reasons.push(...range.reasons);
      warnings.push(...range.warnings);
      /* ② 品牌词门（卡名 + 来源 + 注释） */
      const name = String(card.name ?? '');
      for (const t of [name, String(card.source ?? ''), String(card.note ?? '')]) {
        const hit = findBrandHit(matchers, t);
        if (hit) { reasons.push(`品牌词泄漏：「${hit}」（文本：${t.slice(0, 60)}）`); break; }
      }
      /* ③ 两两均值差门 */
      let minPair = null, nearest = '', vsNeutral = null;
      if (!card.params) {
        reasons.push('缺少 params（无法渲染）');
      } else {
        const fn = mods.lookTransform(card.params.look ?? {});
        const selfKey = JSON.stringify(card.params.look ?? {}); // 与某内置卡 look 全等 = 同一张卡，不计入两两门
        minPair = Infinity; nearest = '';
        for (const b of builtinFns.values()) {
          if (b.cls !== cls || b.lookKey === selfKey) continue;
          const d = meanLookDiff(fn, b.fn, frame);
          if (d < minPair) { minPair = d; nearest = `${b.id} ${b.name}`; }
        }
        vsNeutral = meanLookDiff(fn, neutralFn, frame);
        if (gate.pairwiseInclusiveFail ? minPair <= gate.pairwise : minPair < gate.pairwise) {
          reasons.push(`与内置卡「${nearest}」观感差仅 ${minPair.toFixed(2)} 级（门 ${gate.pairwiseInclusiveFail ? '>' : '≥'}${gate.pairwise}，${cls === 'style' ? 'R8 风格卡门' : 'R2 型号卡门'}）→ 观感重复，需人工调校拉开或放弃`);
        }
        if (gate.vsNeutralInclusiveFail ? vsNeutral <= gate.vsNeutral : vsNeutral < gate.vsNeutral) {
          reasons.push(`与中性（原图）差仅 ${vsNeutral.toFixed(2)} 级（门 ${gate.vsNeutralInclusiveFail ? '>' : '≥'}${gate.vsNeutral}）→ 近恒等，需人工调校`);
        }
        minPair = +minPair.toFixed(2);
        vsNeutral = +vsNeutral.toFixed(2);
      }
      const ok = reasons.length === 0;
      if (ok) pass++; else fail++;
      warnCount += warnings.length;
      rows.push({
        name, class: cls, verdict: ok ? 'PASS' : 'FAIL',
        minPairDiff: minPair, nearest, vsNeutral, warnings, reasons,
      });
    }
    report.packages[grp.pkg] = { total: rows.length, pass, fail, warnings: warnCount, cards: rows };
    console.log(`质量门[${grp.pkg}]：PASS ${pass} / FAIL ${fail}（warnings ${warnCount}）`);
  }

  /* md 报告 */
  const outDir = path.resolve(opt.out ?? path.join(appRoot, '..', 'ref-materials', 'xmp', 'analysis'));
  await mkdir(outDir, { recursive: true });
  const totPass = Object.values(report.packages).reduce((s, p) => s + p.pass, 0);
  const totFail = Object.values(report.packages).reduce((s, p) => s + p.fail, 0);
  const md = [];
  md.push('# 估算起点卡 · 质量门报告');
  md.push('');
  md.push(`> 生成时间 ${report.generatedAt}；工具 \`tools/card-quality-gate.mjs\`。`);
  md.push('> 门值出处（代码现状，非本报告发明）：风格卡两两差 **>8 级** 且与中性 **>8 级**（`src/film/styles.test.ts`，R8）；型号卡两两差 **>5 级** 且与原图 **≥4 级**（`tools/e2e-verify.mjs` R2-1/R2-2，`tools/EFFECT-REPORT-R2.md` §R2-1/R2-2 —— 既有门值是 5/4 而非任务书草稿的 >3）。');
  md.push('> 口径：同帧 look 渲染（`lookTransform` 逐像素、0..255 级平均绝对差，`styles.test.ts` 同式；只覆盖 look 段，质感层不计入）；渲染帧 = 程序化校色卡数组（`src/film/scenes.ts` drawChart 同调色板）；区间现读 `src/ui/storage.ts` LOOK/HSL/COUPLING_BOUNDS + `src/ui/paramui.ts` 滑杆规格；品牌词表现读 `src/estimate/xmpmap.ts` BRAND_WORDS。');
  md.push('> **估算起点 ≠ 精确复刻**：FAIL 的卡不是删掉，是如实列出待人工调校（数值台逐卡调后可复跑本门）。');
  md.push('');
  md.push(`## 汇总：PASS ${totPass} / FAIL ${totFail}`);
  md.push('');
  md.push('| 包 | 卡数 | PASS | FAIL | warnings |');
  md.push('|---|---|---|---|---|');
  for (const [pkg, p] of Object.entries(report.packages)) {
    md.push(`| ${esc(pkg)} | ${p.total} | ${p.pass} | ${p.fail} | ${p.warnings} |`);
  }
  for (const [pkg, p] of Object.entries(report.packages)) {
    md.push('');
    md.push(`## ${pkg}（${p.total} 卡 · PASS ${p.pass} / FAIL ${p.fail}）`);
    md.push('');
    md.push('| 卡名 | 判定 | 与最近内置卡差（级） | 最近卡 | 与中性差（级） | FAIL 原因 / warnings |');
    md.push('|---|---|---|---|---|---|');
    for (const c of p.cards) {
      const note = [...c.reasons, ...c.warnings].join('；') || '—';
      md.push(`| ${esc(c.name)} | ${c.verdict} | ${c.minPairDiff ?? '—'} | ${esc(c.nearest || '—')} | ${c.vsNeutral ?? '—'} | ${esc(note)} |`);
    }
  }
  md.push('');
  await writeFile(path.join(outDir, '质量门报告.md'), md.join('\n'), 'utf8');
  await writeFile(path.join(outDir, '质量门报告.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`质量门汇总：PASS ${totPass} / FAIL ${totFail}；输出 → ${path.join(outDir, '质量门报告.md')} + .json`);
  if (totFail > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error(`CLI 异常：${e?.message ?? e}`);
  process.exitCode = 1;
});
