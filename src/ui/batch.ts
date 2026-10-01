/**
 * F14 批量匹配页控制器（渲染进 index.html 的 #batch-page）。
 *
 * 工作流：多帧上传（每段一帧，支持批量拖拽）→ 逐段 CDL（分位数三点拟合）→
 *        统一风格层（当前工作台 look 烘焙成统一 .cube）→ 选导出模式 → 导出 zip。
 *
 * 导出模式（R7 新增，#batch-mode，默认 'cdl'）：
 *   'cdl'    与 R6 完全一致：包内 1 个统一 .dctl（look + 质感），匹配走逐段 CDL 节点；
 *            包 = cdl.json / cdl.csv / <code>.cube / <code>.dctl / <code>_mount.py / 三份文档（8 个）。
 *   'single' 逐段单节点 DCTL：**每段**用 generateDctl 生成一个 .dctl，把该段解算出的 CDL
 *            内联进匹配段（match 参数）——一个节点完成「匹配 + look + 质感」；
 *            包 = cdl.json / cdl.csv / <code>.cube / N 个逐段 .dctl / <code>_mount.py / 三份文档（7 + N 个）。
 *            .cube 与 _mount.py 保留为兜底物料（连 DCTL 都用不了时），文档措辞随模式切换。
 *        .dctl 一律现场生成，默认**兼容模式**（ASCII 标签 + 0/1 滑杆，已实机验证过的安全形态）；
 *        管线可选 RCM（默认）/ YRGB。
 *
 * 参考策略：
 *   A 统一参考 —— 以全部段的分位数统计均值作为同一条参考，各段共同收敛到该基准；
 *   B 主段锚定 —— 以第一段（主段）原始统计为锚，其余段对齐它。
 *   （C 自动分组按用户拍板留后续版本。）
 *
 * 纯函数依赖 src/batch/*（分位数统计 / CDL 求解 / 合成测试集 / 导出打包）+ src/dctl/*（DCTL 生成），
 * 本模块只负责 DOM 装配、状态编排与 E2E 元数据上报（#e2e-meta）。
 */
import {
  quantileStats,
  type QuantileStats,
} from '../batch/quantiles';
import {
  clampCdl, CDL_RANGES,
  type Cdl, type CdlEntry,
} from '../batch/cdl';
import { synthSeries } from '../batch/synth';
import {
  type BatchPackMode, type PackFile,
} from '../batch/export';
import type { PipelineTF } from '../dctl/logmath';
import { cloneParams, PRESETS } from '../film/params';
import { defaultColorParams, shareCodeOf, type RecipeState } from './recipe';
import { store } from './store';
import { setMeta } from './e2emeta';
import { createWorkerClient, type WorkerLike } from '../workers/client';
import {
  buildPackOp,
  type PackReq, type PackRes,
} from '../workers/ops-pack';
import {
  solveMatchOp,
  type SolveReq, type SolveRes,
} from '../workers/ops-match';

export type BatchStrategy = 'A' | 'B';

interface BatchDeps {
  toast: (m: string) => void;
}

/** 单段素材：工作画布（算统计/应用 CDL）+ 缩略画布（≤120px）+ 拟合结果 */
interface BatchFrame {
  name: string;
  /** 工作画布（长边 ≤480，统计与 CDL 施加都在此分辨率） */
  work: HTMLCanvasElement;
  /** 缩略图（宽 ≤120px，直接挂进 DOM） */
  thumb: HTMLCanvasElement;
  stats: QuantileStats;
  /** 拟合产物（未拟合为 null） */
  cdl: Cdl | null;
  before: number; // 与参考的统计距离（拟合前）
  after: number;  // 与参考的统计距离（拟合后）
  iterations: number;
  converged: boolean;
}

const WORK_MAX = 480;
const THUMB_MAX = 120;

let deps: BatchDeps = { toast: () => {} };
let frames: BatchFrame[] = [];
let strategy: BatchStrategy = 'A';
let lutSize: 33 | 65 = 65;
/** DCTL 管线（并入包的 .dctl 用）：RCM 为达芬奇原生管线，默认；切换后下次导出生效 */
let pipeline: PipelineTF = 'rcm';
/** 导出模式（R7）：'cdl' = R6 形态（统一 DCTL + 逐段 CDL）；'single' = 逐段单节点 DCTL */
let packMode: BatchPackMode = 'cdl';
let ready = false;
/** 上次打包结果（供下载与 meta 上报） */
let lastPack: { files: PackFile[]; zip: Uint8Array } | null = null;
/** 上次拟合的段间两两距离（由 worker/同步求解产出并缓存，避免每次刷新重算像素） */
let lastPairwise: { before: number; after: number; dropPct: number } = { before: 0, after: 0, dropPct: 0 };
/** refit 代次：策略/素材快速变化时只接受最新一次结果 */
let refitToken = 0;

/* R10-B：匹配求解与批量打包 worker（Vite 原生 worker，独立 chunk）。
 * 不可用/超时/崩溃时自动退回主线程同步路径（调用 workers/ops.ts 同一函数 → 结果逐位一致）。 */
const matchClient = createWorkerClient<SolveReq, SolveRes>({
  name: 'match',
  makeWorker: () => new Worker(new URL('../workers/match.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
  timeoutMs: 1500,
  sync: solveMatchOp,
});
const packClient = createWorkerClient<PackReq, PackRes>({
  name: 'pack',
  makeWorker: () => new Worker(new URL('../workers/pack.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
  timeoutMs: 2000,
  sync: buildPackOp,
});

/* ================= DOM 装配 ================= */

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** 批量页专属样式（复用既有变量，不改 index.html 外壳） */
const BATCH_CSS = `
.batch-drop{border:1px dashed var(--line); border-radius:6px; padding:10px 12px; margin:6px 0;
  color:var(--dim); font-size:var(--fs-md); text-align:center; background:var(--panel2)}
.batch-drop.on{border-color:var(--amber); color:var(--amber2); background:var(--amber-a08)}
#batch-rows{margin-top:8px; display:flex; flex-direction:column; gap:6px}
.batch-row{display:flex; gap:10px; align-items:center; padding:6px 8px;
  border:1px solid var(--line); border-radius:6px; background:var(--panel2)}
.batch-row canvas{flex:0 0 auto; border:1px solid var(--line); border-radius:3px; background:var(--canvas); display:block}
.batch-row .batch-info{flex:1; min-width:0}
.batch-row .batch-name{color:var(--text); font-size:var(--fs-md); overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.batch-row .batch-cdl{color:var(--dim); font-size:var(--fs-sm); font-variant-numeric:tabular-nums; line-height:1.7}
.batch-row .batch-cdl b{color:var(--text); font-weight:600}
.batch-row .batch-dist{color:var(--dim); font-size:var(--fs-sm); font-variant-numeric:tabular-nums}
#batch-style-note code{background:var(--code-bg); border:1px solid var(--line); border-radius:3px; padding:0 4px;
  font:var(--fs-sm) var(--font-mono); color:var(--code-fg)}
`;

function injectStyle(): void {
  if (document.getElementById('batch-style')) return;
  const s = document.createElement('style');
  s.id = 'batch-style';
  s.textContent = BATCH_CSS;
  document.head.appendChild(s);
}

/** 切到批量页：点顶栏导航按钮（走 main.ts 的 switchView，避免模块循环依赖） */
function showBatchView(): void {
  document.querySelector<HTMLButtonElement>('#viewnav button[data-view="batch"]')?.click();
}

export function initBatchPage(d: BatchDeps): void {
  if (ready) return;
  deps = d;
  const root = document.getElementById('batch-page');
  if (!root) return;
  ready = true;
  injectStyle();
  root.innerHTML = '';

  root.appendChild(h('h2', undefined, '批量匹配'));
  const lede = h('div', 'lede');
  lede.innerHTML =
    '多段素材统一调色：每段上传一帧 → 逐段 CDL（分位数三点拟合 p1/p50/p99）→ ' +
    '统一风格层（<b>.cube</b> 承载色彩 look，质感层由同包 <b>.dctl</b> 承载）→ 一键导出 zip。' +
    '导出模式可选：<b>统一 DCTL + 逐段 CDL</b>（默认，与 R6 一致）或 <b>逐段单节点 DCTL</b>' +
    '（把该段匹配也内联进 DCTL，一个节点完成匹配 + look + 质感）。' +
    '逐段 CDL 只统一段间色彩基准，不改动统一风格层。';
  root.appendChild(lede);

  /* --- 参考策略 --- */
  const cardStrat = h('div', 'card-blk');
  cardStrat.appendChild(h('h3', undefined, '参考策略'));
  const mkRadio = (val: BatchStrategy, label: string, tip: string): void => {
    const row = h('div', 'row');
    const lab = h('label');
    lab.style.display = 'flex';
    lab.style.gap = '6px';
    lab.style.alignItems = 'center';
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = 'batch-strategy';
    r.value = val;
    r.checked = val === strategy;
    r.addEventListener('change', () => {
      if (r.checked) { strategy = val; void refit(); }
    });
    lab.appendChild(r);
    lab.appendChild(document.createTextNode(label));
    lab.title = tip;
    row.appendChild(lab);
    cardStrat.appendChild(row);
  };
  mkRadio('A', 'A 统一参考（所有段对齐到同一条参考统计）', '以全部段的分位数统计均值作为统一参考基准');
  mkRadio('B', 'B 主段锚定（以第一段为锚，其余段对齐它）', '以第一段原始统计为锚，其余段向它收敛');
  cardStrat.appendChild(h('div', 'note', 'C 自动分组（按镜头自动聚类）留后续版本。切换策略后立即重算。'));
  root.appendChild(cardStrat);

  /* --- 帧列表 --- */
  const cardFrames = h('div', 'card-blk');
  cardFrames.appendChild(h('h3', undefined, '帧列表（每段一帧）'));
  const rowBtns = h('div', 'row');
  const btnPick = h('button', 'primary', '选择多张帧…');
  btnPick.type = 'button';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/jpeg,image/png,image/webp';
  fileInput.multiple = true;
  fileInput.hidden = true;
  btnPick.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const fs = [...(fileInput.files ?? [])];
    if (fs.length) void addFiles(fs);
    fileInput.value = '';
  });
  const btnSynth = h('button', 'mini', '生成合成测试集（7 段）');
  btnSynth.type = 'button';
  btnSynth.addEventListener('click', () => { void loadSynthSeries(); });
  const btnClear = h('button', 'mini', '清空');
  btnClear.type = 'button';
  btnClear.addEventListener('click', () => { frames = []; lastPack = null; lastPairwise = { before: 0, after: 0, dropPct: 0 }; renderRows(); updateSummary(); updateExportBtn(); });
  rowBtns.appendChild(btnPick);
  rowBtns.appendChild(fileInput);
  rowBtns.appendChild(btnSynth);
  rowBtns.appendChild(btnClear);
  cardFrames.appendChild(rowBtns);

  const drop = h('div', 'batch-drop', '把多张图片拖到本页任意位置即可批量接收（每段一帧）');
  cardFrames.appendChild(drop);
  cardFrames.appendChild(h('div', 'note', '支持批量拖拽/多选；长边 >480 自动缩放用于统计与 CDL 求解，原图仅在达芬奇中由 .py 套用。'));
  const rows = h('div');
  rows.id = 'batch-rows';
  cardFrames.appendChild(rows);
  root.appendChild(cardFrames);

  // 页面级拖拽接收（拖到该页即接收多张图）
  const onDragOver = (e: DragEvent): void => {
    e.preventDefault();
    drop.classList.add('on');
  };
  const onDragLeave = (): void => drop.classList.remove('on');
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    drop.classList.remove('on');
    const fs = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (fs.length) void addFiles(fs);
    else deps.toast('未识别到图片文件');
  };
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('dragleave', onDragLeave);
  root.addEventListener('drop', onDrop);

  /* --- 统一风格层 --- */
  const cardStyle = h('div', 'card-blk');
  cardStyle.appendChild(h('h3', undefined, '统一风格层与 DCTL（.cube = 色彩 look；.dctl = look + 质感）'));
  const rowStyle = h('div', 'row');
  rowStyle.appendChild(h('label', undefined, 'LUT 尺寸'));
  const selSize = document.createElement('select');
  selSize.id = 'batch-lutsize';
  for (const s of ['33', '65'] as const) {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = s + '³';
    if (Number(s) === lutSize) o.selected = true;
    selSize.appendChild(o);
  }
  selSize.addEventListener('change', () => { lutSize = Number(selSize.value) === 33 ? 33 : 65; updateSummary(); });
  rowStyle.appendChild(selSize);
  const btnExport = h('button', 'primary', '导出批量包 zip');
  btnExport.type = 'button';
  btnExport.id = 'batch-export';
  btnExport.disabled = true;
  btnExport.addEventListener('click', () => { void exportPack(true); });
  rowStyle.appendChild(btnExport);
  cardStyle.appendChild(rowStyle);

  /* --- 导出模式（R7）：默认与 R6 完全一致；single = 逐段单节点 DCTL（匹配内联） --- */
  const rowMode = h('div', 'row');
  rowMode.appendChild(h('label', undefined, '导出模式'));
  const selMode = document.createElement('select');
  selMode.id = 'batch-mode';
  const modes: Array<{ id: BatchPackMode; label: string; tip: string }> = [
    {
      id: 'cdl',
      label: '统一 DCTL + 逐段 CDL（默认）',
      tip: '包内 1 个统一 .dctl（look + 质感）+ cdl.csv 逐段 CDL 节点；与 R6 导出一致',
    },
    {
      id: 'single',
      label: '逐段单节点 DCTL（匹配+look+质感）',
      tip: '每段一个 .dctl（内联该段解算出的 CDL），一个节点完成匹配 + look + 质感，不必再挂 CDL 节点',
    },
  ];
  for (const m of modes) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    o.title = m.tip;
    if (m.id === packMode) o.selected = true;
    selMode.appendChild(o);
  }
  selMode.addEventListener('change', () => {
    packMode = selMode.value === 'single' ? 'single' : 'cdl';
    // 模式只影响包内容与文档：上次的打包结果作废，下次导出按新模式重新生成
    lastPack = null;
    updateSummary();
  });
  rowMode.appendChild(selMode);
  cardStyle.appendChild(rowMode);
  const modeNote = h('div', 'note');
  modeNote.id = 'batch-mode-note';
  cardStyle.appendChild(modeNote);

  /* --- DCTL 管线（并入包的 .dctl 用；切换后下次导出生效） --- */
  const rowPipe = h('div', 'row');
  rowPipe.appendChild(h('label', undefined, 'DCTL 管线'));
  const selPipe = document.createElement('select');
  selPipe.id = 'batch-pipeline';
  const pipes: Array<{ id: PipelineTF; label: string; tip: string }> = [
    { id: 'rcm', label: 'RCM（达芬奇原生，推荐）', tip: 'RCM / DaVinci Intermediate：对数编码域直接重归一化（pivot≈0.333）' },
    { id: 'yrgb', label: 'YRGB', tip: 'YRGB / Rec.709：BT.1886 EOTF → linear → log2 → 归一化（pivot 0.18→0.5）' },
  ];
  for (const p of pipes) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.label;
    o.title = p.tip;
    if (p.id === pipeline) o.selected = true;
    selPipe.appendChild(o);
  }
  selPipe.addEventListener('change', () => {
    pipeline = selPipe.value === 'yrgb' ? 'yrgb' : 'rcm';
    // 管线只影响包内 .dctl：上次的打包结果作废，下次导出按新管线重新生成
    lastPack = null;
    updateSummary();
  });
  rowPipe.appendChild(selPipe);
  cardStyle.appendChild(rowPipe);
  const dctlNote = h('div', 'note');
  dctlNote.id = 'batch-dctl-note';
  cardStyle.appendChild(dctlNote);

  const styleNote = h('div', 'note');
  styleNote.id = 'batch-style-note';
  cardStyle.appendChild(styleNote);
  root.appendChild(cardStyle);

  /* --- 结果摘要 --- */
  const cardSum = h('div', 'card-blk');
  cardSum.appendChild(h('h3', undefined, '结果摘要'));
  const sum = h('div', 'note');
  sum.id = 'batch-summary';
  sum.textContent = '尚无素材。点「生成合成测试集」或拖入多张帧开始。';
  cardSum.appendChild(sum);
  root.appendChild(cardSum);

  renderRows();
  updateSummary();
  updateExportBtn();
}

/* ================= 帧装配 ================= */

function makeThumb(src: CanvasImageSource, w: number, ht: number): HTMLCanvasElement {
  const s = Math.min(1, THUMB_MAX / Math.max(w, ht));
  const cv = h('canvas');
  cv.width = Math.max(1, Math.round(w * s));
  cv.height = Math.max(1, Math.round(ht * s));
  cv.getContext('2d')!.drawImage(src, 0, 0, cv.width, cv.height);
  return cv;
}

function frameFromCanvas(cv: HTMLCanvasElement, name: string): BatchFrame {
  const ctx = cv.getContext('2d')!;
  const img = ctx.getImageData(0, 0, cv.width, cv.height);
  return {
    name,
    work: cv,
    thumb: makeThumb(cv, cv.width, cv.height),
    stats: quantileStats(img.data, cv.width, cv.height),
    cdl: null,
    before: 0,
    after: 0,
    iterations: 0,
    converged: false,
  };
}

/** 由 RGBA 数据构造工作画布（长边 ≤WORK_MAX），供合成测试集使用 */
function canvasFromData(data: Uint8ClampedArray | Uint8Array, w: number, ht: number): HTMLCanvasElement {
  const src = h('canvas');
  src.width = w; src.height = ht;
  const need = w * ht * 4;
  // 复制进自有 ArrayBuffer 的 Uint8ClampedArray（ImageData 不接受 SharedArrayBuffer 视图）
  const arr = new Uint8ClampedArray(need);
  arr.set(data.subarray(0, Math.min(need, data.length)));
  src.getContext('2d')!.putImageData(new ImageData(arr, w, ht), 0, 0);
  if (Math.max(w, ht) <= WORK_MAX) return src;
  const s = WORK_MAX / Math.max(w, ht);
  const cv = h('canvas');
  cv.width = Math.round(w * s);
  cv.height = Math.round(ht * s);
  cv.getContext('2d')!.drawImage(src, 0, 0, cv.width, cv.height);
  return cv;
}

/** 合成测试集：synthSeries(480,270,7)（同场景不同曝光/白平衡，无网络依赖） */
function loadSynthSeries(): Promise<void> {
  const list = synthSeries(480, 270, 7);
  frames = list.map((f) => frameFromCanvas(canvasFromData(f.data, f.w, f.h), f.name));
  return refit();
}

async function addFiles(fs: File[]): Promise<void> {
  const loaded = await Promise.all(fs.map(loadOneFile));
  const ok = loaded.filter((f): f is BatchFrame => !!f);
  if (!ok.length) { deps.toast('未能读取图片'); return; }
  frames = [...frames, ...ok];
  deps.toast(`已接收 ${ok.length} 段素材`);
  await refit();
}

function loadOneFile(f: File): Promise<BatchFrame | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, WORK_MAX / Math.max(img.width, img.height));
      const cv = h('canvas');
      cv.width = Math.max(1, Math.round(img.width * s));
      cv.height = Math.max(1, Math.round(img.height * s));
      cv.getContext('2d')!.drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(img.src);
      resolve(frameFromCanvas(cv, f.name));
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); resolve(null); };
    img.src = URL.createObjectURL(f);
  });
}

/* ================= 参考统计与拟合（R10-B：求解移出主线程） ================= */

/** 取每段工作画布的 RGBA（stride 4）——统计/拟合在 worker 内做，主线程只搬运像素 */
function segPayloads(): Array<{ name: string; data: Uint8ClampedArray; w: number; h: number }> {
  return frames.map((f) => {
    const ctx = f.work.getContext('2d')!;
    const img = ctx.getImageData(0, 0, f.work.width, f.work.height);
    return { name: f.name, data: img.data, w: f.work.width, h: f.work.height };
  });
}

/**
 * 重算拟合（策略切换 / 帧集合变化时调用）。
 * R10-B：逐段分位数统计 + CDL 三点拟合 + 拟合后像素重算全部在 worker（或同步回退）内完成；
 * 主线程只写回结果并刷新 UI。refitToken 保证只接受最新一次结果（快速切策略不串台）。
 */
async function refit(): Promise<void> {
  lastPack = null;
  if (frames.length === 0) {
    lastPairwise = { before: 0, after: 0, dropPct: 0 };
    renderRows(); updateSummary(); updateExportBtn();
    return;
  }
  const token = ++refitToken;
  const res = await matchClient.run({ segs: segPayloads(), strategy });
  if (token !== refitToken) return;   // 已被更新的 refit 取代 → 丢弃
  frames.forEach((f, i) => {
    const s = res.segs[i];
    f.stats = s.stats;
    f.cdl = s.cdl;
    f.iterations = s.iterations;
    f.converged = s.converged;
    f.before = s.before;
    f.after = s.after;
  });
  lastPairwise = res.pairwise;
  renderRows();
  updateSummary();
  updateExportBtn();
}

/** 平均两两统计距离（拟合前 / 拟合后）——取 refit 求解结果的缓存 */
function pairwise(): { before: number; after: number; dropPct: number } {
  return lastPairwise;
}

/* ================= CDL 区间自检 ================= */

function num(v: unknown): number[] {
  if (typeof v === 'number') return [v];
  if (Array.isArray(v)) return v.filter((x): x is number => typeof x === 'number');
  return [];
}

/** 全部 CDL 数值是否落在 CDL_RANGES 内（形状容错：数组 [min,max] 或 {min,max}） */
function cdlInRange(): boolean {
  if (!frames.length || frames.some((f) => !f.cdl)) return false;
  const ranges = CDL_RANGES as unknown as Record<string, unknown>;
  for (const f of frames) {
    const cdl = f.cdl!;
    for (const k of ['slope', 'offset', 'power', 'sat'] as const) {
      const r = ranges[k];
      let lo: number | undefined;
      let hi: number | undefined;
      if (Array.isArray(r) && r.length >= 2) { lo = r[0] as number; hi = r[1] as number; }
      else if (r && typeof r === 'object') {
        const o = r as { min?: number; max?: number };
        lo = o.min; hi = o.max;
      }
      const vals = num(cdl[k]);
      if (lo !== undefined && hi !== undefined) {
        for (const v of vals) if (!(v >= lo - 1e-9 && v <= hi + 1e-9)) return false;
      } else {
        // 兜底：clampCdl 恒等即视为在区间内
        const cl = num(clampCdl(cdl)[k]);
        for (let i = 0; i < vals.length; i++) if (Math.abs(vals[i] - (cl[i] ?? vals[i])) > 1e-9) return false;
      }
    }
  }
  return true;
}

/* ================= 统一风格层与导出 ================= */

/** 统一风格层 state：沿用工作台配方；未选定参考时用中性卡构造（仍烘焙出恒等 LUT） */
function styleState(): RecipeState {
  if (store.state) return store.state;
  const card = PRESETS.neutral;
  return {
    colorParams: defaultColorParams(true),
    look: { ...card.params.look },
    texture: cloneParams(card.params).texture,
    master: 1,
    origins: { ...card.origins },
    refStats: null,
    userStats: null,
  };
}

function buildEntries(): CdlEntry[] {
  return frames.map((f) => ({
    name: f.name,
    cdl: f.cdl ?? clampCdl({ slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 }),
    before: f.before,
    after: f.after,
    iterations: f.iterations,
  }));
}

/**
 * 打包（不下载）：R10-B 走 pack worker —— LUT 烘焙（65³）+ DCTL 生成 + buildBatchPack + zip
 * 全部在 worker（或同步回退）内完成，主线程只收文件清单与 zip 字节。
 * createdAt 由主线程给定 → worker / 同步两条路径产出**逐位一致**的 zip。
 */
async function buildPack(): Promise<{ files: PackFile[]; zip: Uint8Array; res: PackRes }> {
  const state = styleState();
  const entries = buildEntries();
  const res = await packClient.run({
    state,
    recipeName: store.recipeName || '批量匹配 · 统一风格层',
    lutSize,
    entries,
    strategy,
    packMode,
    pipeline,
    createdAt: new Date().toISOString(),
  });
  const files: PackFile[] = res.files.map((f) => ({ name: f.name, text: f.text }));
  lastPack = { files, zip: res.zip };
  return { files, zip: res.zip, res };
}

function packMeta(files: PackFile[]): Array<{ name: string; bytes: number }> {
  const enc = new TextEncoder();
  return files.map((f) => ({ name: f.name, bytes: enc.encode(f.text).length }));
}

async function exportPack(download: boolean): Promise<void> {
  if (frames.length === 0 || frames.some((f) => !f.cdl)) { deps.toast('请先载入素材并完成拟合'); return; }
  const { files, zip } = await buildPack();
  const pw = pairwise();
  if (download) {
    const blob = new Blob([zip as BlobPart], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${shareCodeOf(styleState())}-batch.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    deps.toast(`已导出批量包（${packMode === 'single' ? '逐段单节点 DCTL' : '统一 DCTL + 逐段 CDL'}，`
      + `${files.length} 个文件，${(zip.length / 1024).toFixed(0)} KB）`);
  }
  /* R10-B：worker 路径可用性上报（独立键，不改 #e2e-meta.batch 结构） */
  setMeta({ batchWorkers: { match: matchClient.usingWorker, pack: packClient.usingWorker } });
  setMeta({
    batch: {
      frames: frames.length,
      strategy,
      before: +pw.before.toFixed(4),
      after: +pw.after.toFixed(4),
      dropPct: +pw.dropPct.toFixed(2),
      cdlInRange: cdlInRange(),
      pack: packMeta(files),
      zipBytes: zip.length,
      /** R6：包内是否含该配方的 .dctl（按实际文件清单判定，便于 E2E 断言） */
      hasDctl: files.some((f) => f.name.toLowerCase().endsWith('.dctl')),
      /** R7：导出模式与包内 .dctl 条目数（single 模式通常 = 段数） */
      mode: packMode,
      dctlCount: files.filter((f) => f.name.toLowerCase().endsWith('.dctl')).length,
      pipeline,
    },
  });
  updateSummary();
}

/* ================= 渲染 ================= */

function fmt3(v: number): string {
  return v.toFixed(3);
}
function fmtTriple(v: unknown): string {
  return num(v).map(fmt3).join('/');
}

function renderRows(): void {
  const root = document.getElementById('batch-rows');
  if (!root) return;
  root.innerHTML = '';
  frames.forEach((f, i) => {
    const row = h('div', 'batch-row');
    row.dataset.index = String(i);
    row.appendChild(f.thumb);
    const info = h('div', 'batch-info');
    const nm = h('div', 'batch-name', f.name);
    info.appendChild(nm);
    if (f.cdl) {
      const cdlLine = h('div', 'batch-cdl');
      cdlLine.innerHTML =
        `<b>slope</b> ${fmtTriple(f.cdl.slope)} · <b>offset</b> ${fmtTriple(f.cdl.offset)} · ` +
        `<b>power</b> ${fmtTriple(f.cdl.power)} · <b>sat</b> ${fmt3(num(f.cdl.sat)[0] ?? 1)}`;
      info.appendChild(cdlLine);
      const dist = h('div', 'batch-dist');
      dist.textContent =
        `与参考统计距离：前 ${fmt3(f.before)} → 后 ${fmt3(f.after)}` +
        ` · 迭代 ${f.iterations} 次 · ${f.converged ? '已收敛' : '未收敛'}`;
      info.appendChild(dist);
    } else {
      info.appendChild(h('div', 'batch-dist', '未拟合'));
    }
    row.appendChild(info);
    const del = h('button', 'mini', '删除');
    del.type = 'button';
    del.addEventListener('click', () => {
      frames.splice(i, 1);
      lastPack = null;
      void refit();
    });
    row.appendChild(del);
    root.appendChild(row);
  });
}

function updateExportBtn(): void {
  const b = document.getElementById('batch-export') as HTMLButtonElement | null;
  if (b) b.disabled = frames.length === 0 || frames.some((f) => !f.cdl);
}

function updateSummary(): void {
  const el = document.getElementById('batch-summary');
  if (!el) return;
  const note = document.getElementById('batch-style-note');
  const dctlNote = document.getElementById('batch-dctl-note');
  const modeNote = document.getElementById('batch-mode-note');
  const st = styleState();
  const single = packMode === 'single';
  if (note) {
    const src = store.state ? '当前工作台配方' : '中性卡（工作台未选定参考）';
    // R6：质感层已能由 DCTL 承载（实机验证通过），旧的「只能靠 _mount.py + 手录」说法已删除
    note.innerHTML =
      `风格层来源：${src} · 配方码 ${shareCodeOf(st)} · LUT ${lutSize}³ · DCTL 管线 <b>${pipeline.toUpperCase()}</b>。` +
      (single
        ? '逐段单节点模式：每段 .dctl 内联该段 CDL（匹配）+ look + 质感，一个节点搞定；'
          + '<code>.cube</code> 只作兜底，正常流程不挂（详见包内《首次上手清单.md》）。'
        : '质感层（光晕/颗粒/柔光/暗角）由同包 <code>.dctl</code> 承载（DCTL 节点），'
          + '<code>.cube</code> 只含色彩 look——两者都承载 look，节点里<b>二选一</b>，同时开会重复叠加。');
  }
  if (dctlNote) {
    dctlNote.textContent = single
      ? '逐段单节点模式：导出包为每段生成一个 .dctl（内联该段解算出的 CDL，匹配+look+质感一个节点搞定），'
        + '不要再叠加统一风格层 LUT（look 已含在内）；匹配段可在面板用 FM_MATCH_ON 关闭、10 个系数可微调。'
        + '管线切换后下次导出生效。'
      : '导出包内含该配方的 .dctl（look + 质感全层，兼容模式：纯 ASCII 标签 + 0/1 滑杆）。'
        + '达芬奇里 ③ DCTL 节点与 ④ 统一 LUT 二选一（两者都承载 look，同时开会重复叠加）；'
        + '管线切换后下次导出生效。';
  }
  if (modeNote) {
    modeNote.textContent = single
      ? '逐段单节点 DCTL：包内 7 + 段数 个文件（每段一个 .dctl，文件名对应片段名）；'
        + '.cube / _mount.py 仅作兜底（连 DCTL 都用不了时），文档措辞随模式切换。'
      : '统一 DCTL + 逐段 CDL：包内 8 个文件（1 个统一 .dctl + cdl.csv 逐段数值），与 R6 导出一致。';
  }
  if (!frames.length) {
    el.textContent = '尚无素材。点「生成合成测试集」或拖入多张帧开始。';
    return;
  }
  const pw = pairwise();
  const inRange = cdlInRange();
  const conv = frames.filter((f) => f.converged).length;
  const ranges = CDL_RANGES as unknown as Record<string, unknown>;
  el.innerHTML =
    `<div>段数：<b>${frames.length}</b> · 策略：<b>${strategy === 'A' ? 'A 统一参考' : 'B 主段锚定'}</b> · 收敛：${conv}/${frames.length}` +
    ` · 导出模式：<b>${single ? '逐段单节点 DCTL' : '统一 DCTL + 逐段 CDL'}</b></div>` +
    `<div>平均两两统计距离：拟合前 <b>${fmt3(pw.before)}</b> → 拟合后 <b>${fmt3(pw.after)}</b> · 降幅 <b>${pw.dropPct.toFixed(1)}%</b></div>` +
    `<div>CDL 区间自检（slope ${num(ranges.slope).join('–') || '0.5–2'} / offset ${num(ranges.offset).join('–') || '±0.1'} / power ${num(ranges.power).join('–') || '0.7–1.4'}）：` +
    `<b style="color:${inRange ? 'var(--ok)' : 'var(--err)'}">${inRange ? '全部合法' : '存在越界'}</b></div>` +
    (lastPack ? `<div>上次导出包：${lastPack.files.length} 个文件 · ${(lastPack.zip.length / 1024).toFixed(0)} KB</div>` : '');
}

/* ================= 演示 / E2E 入口 ================= */

/**
 * #demo=batch|batchb|batchsingle：
 *   batch  —— 切批量页 + 生成合成测试集 + 策略 A + 默认模式（统一 DCTL + 逐段 CDL）完成拟合与打包（不下载），写 meta.batch；
 *   batchb —— 同上但策略 B，写 meta.batchB（仅策略/距离三值）；
 *   batchsingle —— R7 逐段单节点 DCTL 模式：合成测试集 + 策略 A + single 模式打包（不下载），写 meta.batch
 *                  （含 mode='single' 与 dctlCount=段数）。
 *   注：URL 路由在 main.ts 的 demo 分发处（本文件不负责路由，需同步放行 `batchsingle`）。
 */
export async function batchDemo(kind: string): Promise<void> {
  showBatchView();
  if (kind === 'batchsingle') {
    packMode = 'single';
    syncModeUI();
    strategy = 'A';
    syncStrategyUI();
    await loadSynthSeries();
    await exportPack(false);
  } else if (kind === 'batch') {
    packMode = 'cdl';
    syncModeUI();
    strategy = 'A';
    syncStrategyUI();
    await loadSynthSeries();
    await exportPack(false);
  } else if (kind === 'batchb') {
    strategy = 'B';
    syncStrategyUI();
    await loadSynthSeries();
    const pw = pairwise();
    setMeta({
      batchB: {
        frames: frames.length,
        strategy: 'B',
        before: +pw.before.toFixed(4),
        after: +pw.after.toFixed(4),
        dropPct: +pw.dropPct.toFixed(2),
      },
    });
  }
}

function syncStrategyUI(): void {
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="batch-strategy"]')) {
    r.checked = r.value === strategy;
  }
}

function syncModeUI(): void {
  const sel = document.getElementById('batch-mode') as HTMLSelectElement | null;
  if (sel) sel.value = packMode;
}
