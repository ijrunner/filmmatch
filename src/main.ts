/* FilmMatch MVP 工作台入口：装配五步流程（①传帧 ②选参考 ③出配方 ④调配方 ⑤保存/导出）
 *
 * 结构：
 *   - 预览：EffectRenderer（film/pipeline）；LUT 只承载匹配（ui/recipe.bakeMatchLUT），
 *      look 走 GRADE_FS uniform（拖动零重烘）；导出 .cube/批量包用复合 LUT（bakeRecipeLUT）
 *   - 状态：ui/store（单 store + 订阅）；配方 JSON：ui/recipe；存储：ui/storage；图库：ui/library
 *   - P1：分享码（share/code）、型号卡片墙（ui/stockwall）、指南抽屉（ui/guide）、
 *         标注编辑器（ui/annotate）；参数规格共用 ui/paramui
 *   - 预览与导出所见即所得：engine 匹配烘焙进匹配 LUT，look/质感由 shader 计算
 *   - 多视图：#view=workbench|batch|dctl 切换；批量匹配页控制器见 ui/batch.ts（F14）、
 *     DCTL 生成页见 ui/dctlpage.ts（R4，动态 import 懒加载）；节点包导出区见 ui/drxexport.ts（R5）
 *   - URL 辅助（演示/验收）：#src #ref #mode #split #demo #smoke #view（见 index.html 头注释）
 *     #demo=batch|batchb（F14 批量匹配：合成测试集 + 策略 A/B 端到端）
 *     #demo=dctl|dctl-rcm|dctl-stages|dctl-labels|dctl-match（R4/R6/R7 DCTL 生成页：全层 / 分层 / 双语标签 / 内联匹配）
 *     #demo=batch|batchb|batchsingle（R3/R7 批量页：策略 A/B / 逐段单节点 DCTL）
 *     #demo=perf[&drag=match]（R10 性能基线：拖动 look 滑杆 60 次，度量主线程同步工作量）
 *     #demo=drx（R5 节点包导出区：搭建清单 + 实验性 .drx）
 *     #demo=overlay（R16 预览浮层同步态：浮层/④入口分段控件 + HUD 快照 + 组名搜索自检）
 *     #demo=groupreset[&reset=1]（R16 组级重置前后：改光晕组 → 截图前 / 点「重置本组」→ 截图后）
 *     #demo=styles（R8 风格卡片墙：写 #e2e-meta.styles = { count, ids, rects }）
 *     #demo=presetio（R8 预设导出→导入回环 + 本地存卡 + 坏文件被拒：写 #e2e-meta.presetIO）
 *     #demo=xmpimport[&apply=brand]（R15 XMP 预设导入：合成 fixture → 估算起点卡 → 风格卡 tab，写 #e2e-meta.xmpImport）
 *     #ref=stock:fl05 / #ref=style:st03（直接选型号卡 / 风格卡直出配方）
 */
import { analyzeImage, normalizeDataRange, toCube, withSource, type DataRange, type ImageStats } from './engine';
import { matchBakeData, type MatchBakeData } from './engine/match';
import {
  cloneParams, defaultLook, defaultTexture, getPreset, DEFAULT_COUPLING,
  type FilmParams, type LookParams, type Origin, type TextureParams, type ViewMode,
} from './film/params';
import { EffectRenderer, type LutData } from './film/pipeline';
import { drawChart, drawDusk, drawNeon } from './film/scenes';
import {
  DEFAULT_PROFILE, FORMATS, HALATION_PROFILE_IDS, HALATION_PROFILES, ISO_STEPS,
  applyProfile, grainProfileById, grainProfileLabel, normalizeProfileRef,
  type FilmFormat, type HalationProfileId, type IsoStep, type TextureProfileRef,
} from './film/grainmatrix';
import {
  allEntries, findEntry, ingestRefImage, stockCards, styleCards, type LibraryEntry, type SceneId,
} from './ui/library';
import {
  buildRecipe, makeId, matchTransform, recipeToState, shareCodeOf,
  type Recipe, type RecipeState,
} from './ui/recipe';
import * as storage from './ui/storage';
import { emit, initRecipeState, store, subscribe, type RefKind } from './ui/store';
import { decodeFull, encodeFull, verifyShortCode } from './share/code';
import { stockThumbUrl } from './ui/stockwall';
import { fmtVal, GROUPS, hexToRgb, rgbToHex, type SpecGroup, type SpecParam } from './ui/paramui';
import { setMeta } from './ui/e2emeta';
import { installTokens } from './ui/tokens';
import {
  ariaLabel, isVisible, isTypingTarget, matchAvailable, matchShortcut,
  MATCH_UNAVAILABLE_NOTE, MATCH_UNAVAILABLE_TITLE, SHORTCUTS, simpleKeys, type UiMode,
} from './ui/controls';
import { createWorkerClient, type WorkerLike } from './workers/client';
import { bakeLutOp, type BakeLutReq, type BakeLutRes } from './workers/ops-lut';

/* ================= 设计令牌（R11）=================
 * :root CSS 变量的唯一定义处是 ui/tokens.ts；此处尽早注入，早于任何 DOM 装配。 */
installTokens();

/* ================= 错误兜底（无头调试可见） ================= */
const errbanner = document.getElementById('errbanner')!;
window.addEventListener('error', (e) => {
  errbanner.style.display = 'block';
  errbanner.textContent = 'JS错误: ' + e.message + ' @' + (e.lineno ?? '?');
  document.title = 'ERR ' + e.message;
});

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const $d = (id: string): HTMLDetailsElement => document.getElementById(id) as HTMLDetailsElement;
function toast(msg: string): void {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, 2600);
}
let toastTimer: ReturnType<typeof setTimeout>;

/* ================= 多视图切换（工作台 / 批量匹配 / DCTL 生成） =================
 * 视图容器在 index.html：#view-workbench（既有工作台）/ #view-batch / #view-dctl。
 * 非活动视图置 hidden（CSS 显式写了 .view[hidden]{display:none}），因此不参与布局——
 * 既有 E2E 的预览区/面板区坐标断言不受影响。 */
const VIEWS = ['workbench', 'batch', 'dctl'] as const;
type ViewName = (typeof VIEWS)[number];
let currentView: ViewName = 'workbench';
export function switchView(v: string): void {
  const name: ViewName = (VIEWS as readonly string[]).includes(v) ? (v as ViewName) : 'workbench';
  currentView = name;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#viewnav button')) {
    b.classList.toggle('on', b.dataset.view === name);
  }
  for (const n of VIEWS) ($('view-' + n) as HTMLElement).hidden = n !== name;
  if (name === 'batch') void ensureBatch();
  if (name === 'dctl') void ensureDctl();
  setMeta({ view: name });
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#viewnav button')) {
  b.addEventListener('click', () => switchView(b.dataset.view!));
}

/* 非首屏视图按需动态加载：批量匹配页（F14）体积不进首屏包（E2E R2-5 断言「首屏 gzip ≤70KB」） */
let batchMod: typeof import('./ui/batch') | null = null;
async function ensureBatch(): Promise<typeof import('./ui/batch')> {
  if (!batchMod) {
    batchMod = await import('./ui/batch');
    batchMod.initBatchPage({ toast });
  }
  return batchMod;
}

/* DCTL 生成页（R4）同样动态 import：dctl 数学/生成器不进首屏包（首屏 gzip ≤70KB） */
let dctlMod: typeof import('./ui/dctlpage') | null = null;
async function ensureDctl(): Promise<typeof import('./ui/dctlpage')> {
  if (!dctlMod) {
    dctlMod = await import('./ui/dctlpage');
    dctlMod.initDctlPage({ toast });
  }
  return dctlMod;
}

/* R12 首屏瘦身：标注编辑器 / 节点包导出区 / 指南抽屉均为「打开才需要」的附件，
 * 改为动态 import（写法同 ensureBatch/ensureDctl）——三者及其私有依赖不再进首屏静态图。
 * 启动后仍 fire-and-forget 调用一次 ensure*，行为与「静态 import 后立即 init」一致。 */
let annotateMod: typeof import('./ui/annotate') | null = null;
let annotateInit: Promise<typeof import('./ui/annotate')> | null = null;
async function ensureAnnotate(): Promise<typeof import('./ui/annotate')> {
  if (!annotateInit) {
    annotateInit = (async () => {
      const m = await import('./ui/annotate');
      annotateMod = m;
      m.initAnnotate({
        toast,
        onChange: (entryId) => {
          buildRefUI();
          renderStockThumbs();
          // 若编辑中的条目正是当前参考：以新标注重建配方
          if (entryId && store.ref?.id === entryId && store.frame) {
            const e = findEntry(entryId);
            if (e) selectRef(e);
          }
        },
      });
      return m;
    })();
  }
  return annotateInit;
}

let drxMod: typeof import('./ui/drxexport') | null = null;
let drxInit: Promise<typeof import('./ui/drxexport')> | null = null;
async function ensureDrx(): Promise<typeof import('./ui/drxexport')> {
  if (!drxInit) {
    drxInit = (async () => {
      const m = await import('./ui/drxexport');
      drxMod = m;
      m.initDrxExport({ toast });
      return m;
    })();
  }
  return drxInit;
}

let guideMod: typeof import('./ui/guide') | null = null;
async function ensureGuide(): Promise<typeof import('./ui/guide')> {
  if (!guideMod) guideMod = await import('./ui/guide');
  return guideMod;
}

/* R15：XMP 预设导入（图库入口 → 估算起点卡）。整条链路（解析/映射/卡存储/缩略图）按需动态加载：
 * 二级 import('../estimate/xmp') 等只在点了导入时下载，保证不进首屏 gzip（预算 ≤66KB）。 */
let xmpMod: typeof import('./ui/xmpimport') | null = null;
async function ensureXmpImport(): Promise<typeof import('./ui/xmpimport')> {
  if (!xmpMod) {
    xmpMod = await import('./ui/xmpimport');
    xmpMod.initXmpImport({
      toast,
      applyEntry: selectRef,
      switchTab,
      frameCanvas: () => store.frame?.canvas ?? null,
      frameKey: () => (store.frame ? 'frame:' + store.frame.name : 'scene:neon'),
      getState: () => store.state,
      getRecipe: () => currentRecipe(),
    });
  }
  return xmpMod;
}

/* ================= 渲染后端 ================= */
const canvas = $('glcanvas') as HTMLCanvasElement;
const renderer = new EffectRenderer();
renderer.init(canvas, { internalScale: 0.5 });
$('stat-backend').textContent = renderer.backendLabel();

/* R10-B：LUT 烘焙 worker（Vite 原生 worker，独立 chunk）。worker 不可用/超时/崩溃自动退回主线程同步路径。 */
const lutClient = createWorkerClient<BakeLutReq, BakeLutRes>({
  name: 'lut',
  makeWorker: () => new Worker(new URL('./workers/lut.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
  timeoutMs: 1500,
  sync: bakeLutOp,
});
/* 质感质量档（R10-B 降分辨率）+ worker 可用性：写进 #e2e-meta.quality 供验收/诊断。
 * R17：gpuBake 能力一并上报（meta.bakePath / bakeProbe 可观察回退事实）。 */
setMeta({
  quality: {
    ...renderer.quality,
    backend: renderer.backendKind,
    internalScale: 0.5,
    gpuBake: { backend: renderer.backendKind, note: renderer.backendKind === 'webgl2' ? 'pending-probe' : 'unavailable' },
  },
});

/* ================= 预览循环 ================= */
let lutCurrent: LutData | null = null;
let needsApply = true;
let lastT = 0;
/* E2E 冻结时间：#freeze=1&t=0.5 → 颗粒相位固定，截图逐像素可复现 */
let frozen = false;
let freezeT = 0.5;

function filmParams(): FilmParams {
  const st = store.state;
  if (!st) return { texture: defaultTexture(), look: defaultLook(), master: 0 };
  return { texture: st.texture, look: st.look, master: st.master };
}
function pushRender(): void {
  renderer.apply(filmParams(), {
    mode: store.viewMode,
    splitX: store.splitX,
    master: store.state?.master ?? 0,
    lut: lutCurrent,
  });
  needsApply = false;
}
/* R10 性能基线：帧内同步工作量（perf 会话期间累计；平时零开销，只是一个 if） */
let perfFrameWork: number[] = [];
let perfRenderWork: number[] = [];
let perfCollect = false;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const t = frozen ? freezeT : now / 1000;
  lastT = t;
  const t0 = perfCollect ? performance.now() : 0;
  if (needsApply) pushRender();
  const t1 = perfCollect ? performance.now() : 0;
  renderer.render(t);
  if (perfCollect) {
    /* 拆开记：applyMs = 我们控制的 JS 工作量（uniform/LUT 更新）；renderMs = draw 调用
     * （无头 SwiftShader 软件光栅化的耗时，方差极大、与产品优化无关）。 */
    perfFrameWork.push(t1 - t0);
    perfRenderWork.push(performance.now() - t1);
  }
}
requestAnimationFrame(frame);

/* ================= 预览 LUT 烘焙（R10：LUT 只承载匹配；look 走 shader uniform） =================
 * 拖动 look 滑杆 → 只 pushRender（uniform 更新），**零烘焙**；
 * 只有匹配参数（colorParams / 参考统计）变化才 scheduleBake。
 * 导出 .cube / 批量包仍用 bakeRecipeLUT（匹配∘look 复合，完整观感）。 */
let bakeTimer33: ReturnType<typeof setTimeout> | null = null;
let bakeTimer65: ReturnType<typeof setTimeout> | null = null;
let lastBakeMs = 0;
/* R10-B：烘焙请求代次。worker 异步返回时只接受**最新一次**（拖动期间不排队堆积、不写回过期结果）。 */
let bakeToken = 0;
/* R10 性能基线：烘焙次数与耗时（拖动期间的同步工作量就靠这两个数度量） */
let bakeCount = 0;
let bakeMsTotal = 0;
let bakeMsSamples: number[] = [];
let voxelsBaked = 0;
let bakesByKind: Record<number, number> = {};
/* R17：最近一次预览烘焙的路径与 GPU 格式（meta 可观察回退事实） */
let lastBakePath: 'gpu' | 'cpu-fallback' | 'none' = 'none';
let lastBakeFormat: string | null = null;

/** R17：匹配烘焙常数（与 buildTransform 同一预计算，单一真源） */
function matchDataOf(st: NonNullable<typeof store.state>): MatchBakeData {
  return matchBakeData(withSource(st.refStats!, st.userStats!), st.colorParams);
}

function bake(size: 33 | 65): void {
  if (!store.state) { lutCurrent = null; return; }
  const st = store.state;
  /* 无参考/被调色统计（型号直出）→ 匹配恒等，无需 LUT（shader 仅算 look） */
  if (!matchTransform(st)) { lutCurrent = null; pushRender(); return; }
  /* R10-B：异步返回后按代次判定：只有最新一次请求才 pushRender（同一帧多次请求只保留最新）。
   * R17：先试 GPU tile-atlas 烘焙（渲染 2D atlas → readPixels）；
   *   不可用/失败返回 null → 回退既有 worker/CPU 路径（行为与 R10-B 完全一致）。 */
  const token = ++bakeToken;
  const t0 = performance.now();
  const finish = (lut: LutData | null, path: 'gpu' | 'cpu-fallback'): void => {
    if (token !== bakeToken || !lut) return;
    lutCurrent = { size: lut.size, table: lut.table };
    lastBakeMs = performance.now() - t0;
    lastBakePath = path;
    lastBakeFormat = renderer.gpuBakeFormat;
    bakeCount++;
    bakeMsTotal += lastBakeMs;
    bakeMsSamples.push(lastBakeMs);
    /* 确定性计数（不受虚拟时钟影响）：烘了几个 LUT、跑了多少体素 */
    voxelsBaked += size * size * size;
    bakesByKind[size] = (bakesByKind[size] ?? 0) + 1;
    pushRender();
    refreshSummary();
  };
  void renderer.bakeLutAtlas({ size, kind: 'match', match: matchDataOf(st), look: null, range: 'full' }).then((lut) => {
    if (lut) { finish(lut, 'gpu'); return; }
    /* 回退 worker/CPU（不可用/超时自动退回主线程同步路径，见 workers/client.ts） */
    void lutClient.run({ state: st, size, kind: 'match' }).then((res) => {
      finish({ size: res.size, table: res.table }, 'cpu-fallback');
    });
  });
}
/** 计划重烘。affectsMatch=false（look/质感/master 变化）→ 直接返回，零烘焙；
 *  fast=true 时先 120ms 出 33³ 快图，再 600ms 出 65³ 精图。 */
function scheduleBake(affectsMatch = true, fast = true): void {
  if (!affectsMatch) return;
  if (bakeTimer33) clearTimeout(bakeTimer33);
  if (bakeTimer65) clearTimeout(bakeTimer65);
  if (fast) {
    bakeTimer33 = setTimeout(() => bake(33), 120);
    bakeTimer65 = setTimeout(() => bake(65), 600);
  } else {
    bakeTimer65 = setTimeout(() => bake(65), 30);
  }
}

/* ================= 参数面板（④ 调配方） =================
 * 参数规格（SpecParam/SpecGroup/GROUPS）与格式化工具统一在 ui/paramui.ts，
 * 与图库标注编辑器共用同一份定义。 */

interface SliderRefs { rg?: HTMLInputElement; ci?: HTMLInputElement; sel?: HTMLSelectElement; out?: HTMLOutputElement; od?: HTMLElement; cb?: HTMLInputElement; p?: SpecParam; g?: SpecGroup; row?: HTMLElement; lab?: HTMLElement }
const sliders: Record<string, SliderRefs> = {};
/* R14-B：「色彩匹配」组标题状态与组内说明行（buildParamPanel 装配，refreshMatchAvailability 更新） */
let colorGroupStatus: HTMLElement | null = null;
let colorGroupNote: HTMLElement | null = null;

/* ---------- R11：简单 / 高级模式（状态记忆 + #e2e-meta 暴露） ---------- */
const MODE_KEY = 'fm.ui.mode';
function loadUiMode(): UiMode {
  try { return localStorage.getItem(MODE_KEY) === 'advanced' ? 'advanced' : 'simple'; } catch { return 'simple'; }
}
let uiMode: UiMode = loadUiMode();
/* R14-B：色彩匹配可用性（唯一真值来源 ui/controls.matchAvailable）。不可用时：
 *  - 「色彩匹配」组标题显示「不适用」+ 组内一行说明，组内滑杆全部禁用；
 *  - 简单模式改为露出 look 关键项（SIMPLE_KEYS_LOOK），不再默认露死滑杆。 */
let matchOk = false;
let simpleKeySet: readonly string[] = simpleKeys(false);
const focusVisible = typeof CSS !== 'undefined' && !!CSS.supports && CSS.supports('selector(:focus-visible)');
function countRanges(onlyVisible: boolean): number {
  const rows = document.querySelectorAll<HTMLElement>('#param-groups .param');
  let n = 0;
  for (const row of rows) {
    if (!row.querySelector('input[type=range]')) continue;
    if (!onlyVisible || uiMode === 'advanced' || row.dataset.simple === '1') n++;
  }
  return n;
}
/** 把模式/可见滑杆数/匹配可用性/简单模式键位/无障碍信息写进 #e2e-meta.ui（供 E2E 断言） */
function publishUiMeta(): void {
  setMeta({
    ui: {
      mode: uiMode,
      visibleParams: countRanges(true),
      totalParams: countRanges(false),
      matchAvailable: matchOk,
      simpleKeys: [...simpleKeySet],
      a11y: { focusVisible, keyboard: SHORTCUTS.map((s) => s.label) },
    },
  });
}
/** 按模式 + 搜索词过滤参数行（DOM 全量渲染，仅隐藏——保证 dump-dom 仍含全部文案）。
 *  R16：搜索同时匹配组名（中英，details 的 data-grp）——命中组名的组整组保持展开可见。 */
function applyParamFilter(): void {
  const box = document.getElementById('param-search') as HTMLInputElement | null;
  const q = (box?.value ?? '').trim().toLowerCase();
  for (const det of document.querySelectorAll<HTMLDetailsElement>('#param-groups details')) {
    /* R16：组名命中（仅在有搜索词时判定）→ 整组行都视为命中，且组保持展开 */
    const grpHit = !!q && (det.dataset.grp ?? '').includes(q);
    let any = false;
    for (const row of Array.from(det.querySelectorAll<HTMLElement>('.param'))) {
      const modeOk = uiMode === 'advanced' || row.dataset.simple === '1';
      const hit = !q || grpHit || (row.dataset.lbl ?? '').includes(q) || (row.dataset.k ?? '').includes(q);
      const on = modeOk && hit;
      row.style.display = on ? '' : 'none';
      if (on) any = true;
    }
    /* 匹配不可用时色彩组无可见滑杆，但仍要显示标题「不适用」与说明行（让缺陷可见） */
    const forced = det.dataset.group === 'color' && !matchOk;
    det.hidden = !any && !forced;
    if (grpHit && !det.hidden) det.open = true;
  }
  const btn = document.getElementById('btn-mode') as HTMLButtonElement | null;
  if (btn) {
    btn.textContent = uiMode === 'simple' ? '简单模式' : '高级模式';
    btn.setAttribute('aria-pressed', uiMode === 'advanced' ? 'true' : 'false');
  }
  publishUiMeta();
}
function setUiMode(m: UiMode): void {
  uiMode = m;
  try { localStorage.setItem(MODE_KEY, m); } catch { /* 隐私模式忽略 */ }
  applyParamFilter();
}
/** 双击/重置：把单个参数恢复到「选定参考时的初始值」 */
function resetParam(g: SpecGroup, k: string): void {
  const ini = store.initial;
  if (!ini || !store.state) return;
  /* R14-B：匹配不可用时色彩组禁用，双击「复位」同样不生效 */
  if (g.kind === 'color' && !matchOk) return;
  let v: number | undefined;
  if (g.kind === 'color') v = (ini.colorParams as unknown as Record<string, number>)[k];
  else if (g.kind === 'look') v = lookGet(ini.look, k);
  else if (g.kind === 'master') v = ini.master;
  else v = (ini.texture[g.id as keyof TextureParams] as unknown as Record<string, number>)[k];
  if (typeof v !== 'number') return;
  setParam(g, k, v);
  markUser(g.kind === 'color' ? 'color.' + k : g.kind === 'look' ? 'look.' + k : g.kind === 'master' ? 'master' : g.id + '.' + k);
  pushRender(); scheduleBake(g.kind === 'color'); refreshAll();
}

/* R16：组级重置——「一键重置」（#btn-reset）的组内版：把该组参数（质感组含启用开关，
 * 含 select 枚举与取色器字段）恢复为 store.initial 对应值；origins 同步恢复初始标记
 * （与 #btn-reset 恢复 {…initial.origins} 同语义，只限本组键）；随后重烘焙 + 刷新面板。 */
function resetGroup(g: SpecGroup): void {
  const ini = store.initial;
  const st = store.state;
  if (!ini || !st) return;
  /* R14-B：匹配不可用时色彩组整组禁用，组级重置同样不生效 */
  if (g.kind === 'color' && !matchOk) return;
  const restoreOrigin = (key: string): void => {
    if (key in ini.origins) st.origins[key] = ini.origins[key];
    else delete st.origins[key];
  };
  if (g.kind === 'texture') {
    (st.texture[g.id as keyof TextureParams] as unknown as { enabled: boolean }).enabled =
      (ini.texture[g.id as keyof TextureParams] as unknown as { enabled: boolean }).enabled;
    restoreOrigin(g.id + '.enabled');
  }
  for (const p of g.params) {
    const key = g.kind === 'color' ? 'color.' + p.k : g.kind === 'look' ? 'look.' + p.k : g.kind === 'master' ? 'master' : g.id + '.' + p.k;
    if (p.type === 'select') {
      const v = g.kind === 'look'
        ? String((ini.look as unknown as Record<string, string>)[p.k])
        : String((ini.texture[g.id as keyof TextureParams] as unknown as Record<string, string>)[p.k]);
      setParamStr(g, p.k, v);
      restoreOrigin(key);
      continue;
    }
    if (p.type === 'color') {
      const t = ini.texture.halation.tint_rgb;
      st.texture.halation.tint_rgb = [t[0], t[1], t[2]];
      restoreOrigin(key);
      continue;
    }
    let v: number | undefined;
    if (g.kind === 'color') v = (ini.colorParams as unknown as Record<string, number>)[p.k];
    else if (g.kind === 'look') v = lookGet(ini.look, p.k);
    else if (g.kind === 'master') v = ini.master;
    else v = (ini.texture[g.id as keyof TextureParams] as unknown as Record<string, number>)[p.k];
    if (typeof v === 'number') setParam(g, p.k, v);
    restoreOrigin(key);
  }
  bake(65);
  pushRender();
  refreshAll();
  toast('已重置本组：' + g.name);
}
/** R16：组级重置按钮可用性（无参考/无初始配方时禁用；匹配不可用时色彩组的按钮禁用） */
function refreshGroupResets(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#param-groups button.greset')) {
    const g = GROUPS.find((x) => x.id === b.dataset.g);
    b.disabled = !store.initial || !store.state || (!!g && g.kind === 'color' && !matchOk);
  }
}

function buildParamPanel(): void {
  const root = $('param-groups');
  root.innerHTML = '';
  for (const g of GROUPS) {
    const d = document.createElement('details');
    d.className = 'group';
    d.dataset.group = g.id;
    /* R16：参数搜索匹配组名（中英，applyParamFilter 读 data-grp） */
    d.dataset.grp = (g.name + ' ' + g.en).toLowerCase();
    if (g.open) d.open = true;
    const su = document.createElement('summary');
    su.innerHTML = '<span class="arrow">▶</span>';
    if (g.kind === 'texture') {
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'onoff';
      cb.setAttribute('aria-label', g.name + ' 开关');
      cb.addEventListener('change', () => {
        if (!store.state) return;
        (store.state.texture[g.id as keyof TextureParams] as unknown as { enabled: boolean }).enabled = cb.checked;
        markUser(g.id + '.enabled');
        pushRender(); refreshAll();
      });
      sliders[g.id + '.enabled'] = { cb, g };
      su.appendChild(cb);
    }
    const tt = document.createElement('span'); tt.textContent = g.name;
    /* R14-B：色彩匹配组标题旁的可用状态（匹配不可用时可见，见 refreshMatchAvailability） */
    let status: HTMLElement | null = null;
    if (g.kind === 'color') {
      status = document.createElement('span');
      status.className = 'gstatus';
      status.id = 'color-status';
      status.hidden = true;
      colorGroupStatus = status;
    }
    const en = document.createElement('span'); en.className = 'gtitle-en'; en.textContent = g.en;
    su.appendChild(tt);
    if (status) su.appendChild(status);
    su.appendChild(en);
    /* R16：组级「重置本组」（组内版一键重置；可用性见 refreshGroupResets） */
    const gr = document.createElement('button');
    gr.type = 'button';
    gr.className = 'greset';
    gr.dataset.g = g.id;
    gr.textContent = '重置本组';
    gr.title = '把本组参数恢复为选定参考时的初始值';
    gr.addEventListener('click', (e) => {
      e.preventDefault();   // 不收起/展开该组
      e.stopPropagation();
      resetGroup(g);
    });
    su.appendChild(gr);
    d.appendChild(su);
    const body = document.createElement('div'); body.className = 'body';
    /* R14-B：匹配不可用时的组内说明行（为什么滑杆没反应 / 怎么才能用匹配） */
    if (g.kind === 'color') {
      const note = document.createElement('div');
      note.className = 'gnote';
      note.id = 'color-note';
      note.textContent = MATCH_UNAVAILABLE_NOTE;
      note.hidden = true;
      body.appendChild(note);
      colorGroupNote = note;
    }
    for (const p of g.params) {
      const key = g.kind === 'color' ? 'color.' + p.k : g.kind === 'look' ? 'look.' + p.k : g.kind === 'master' ? 'master' : g.id + '.' + p.k;
      const row = document.createElement('div'); row.className = 'param';
      row.dataset.k = key;
      row.dataset.lbl = (g.name + p.label).toLowerCase();
      row.dataset.simple = isVisible(g, p, 'simple', simpleKeySet) ? '1' : '0';
      const lab = document.createElement('label'); lab.textContent = p.label;
      row.appendChild(lab);
      if (p.type === 'color') {
        const ci = document.createElement('input'); ci.type = 'color';
        ci.setAttribute('aria-label', ariaLabel(g, p));
        ci.addEventListener('input', () => {
          if (!store.state) return;
          store.state.texture.halation.tint_rgb = hexToRgb(ci.value);
          markUser(key); pushRender(); scheduleBake(false); refreshAll();
        });
        row.appendChild(ci);
        row.appendChild(document.createElement('output'));
        const od = document.createElement('span'); od.className = 'odot'; row.appendChild(od);
        sliders[key] = { ci, od, p, g, row, lab };
      } else if (p.type === 'select') {
        const sel = document.createElement('select');
        sel.setAttribute('aria-label', ariaLabel(g, p));
        for (const o of p.options ?? []) {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label;
          sel.appendChild(opt);
        }
        sel.addEventListener('change', () => {
          if (!store.state) return;
          setParamStr(g, p.k, sel.value);
          markUser(key);
          pushRender(); scheduleBake(false); refreshAll();
        });
        row.appendChild(sel);
        row.appendChild(document.createElement('output'));
        const od = document.createElement('span'); od.className = 'odot'; row.appendChild(od);
        sliders[key] = { sel, od, p, g, row, lab };
      } else {
        const rg = document.createElement('input'); rg.type = 'range';
        rg.min = String(p.min); rg.max = String(p.max); rg.step = String(p.step);
        rg.setAttribute('aria-label', ariaLabel(g, p));
        rg.title = p.label + '（←/→ 微调，PageUp/PageDown 大步，双击复位）';
        const out = document.createElement('output');
        out.title = '单击可直接输入数值 · 双击复位';
        const commit = (v: number): void => { rg.value = String(v); rg.dispatchEvent(new Event('input', { bubbles: true })); };
        rg.addEventListener('input', () => {
          if (!store.state) return;
          /* R14-B：匹配不可用时色彩组滑杆禁用；拖到禁用滑杆不得改变任何状态 */
          if (rg.disabled) return;
          const v = parseFloat(rg.value);
          setParam(g, p.k, v);
          out.textContent = fmtVal(p, v);
          markUser(key);
          pushRender();
          /* R10：仅匹配参数（color）变化才重烘 LUT；look/质感/master 只走 uniform */
          scheduleBake(g.kind === 'color');
          refreshAll();
        });
        /* 双击滑杆/标签 → 复位到初始配方值 */
        rg.addEventListener('dblclick', () => resetParam(g, p.k));
        lab.classList.add('scrub');
        lab.title = '拖动左右擦除改值 · 双击复位';
        lab.addEventListener('dblclick', () => resetParam(g, p.k));
        let scrub: { x: number; start: number } | null = null;
        lab.addEventListener('pointerdown', (e) => {
          if (e.button !== 0 || !store.state || rg.disabled) return;
          lab.setPointerCapture(e.pointerId);
          scrub = { x: e.clientX, start: parseFloat(rg.value) };
          e.preventDefault();
        });
        lab.addEventListener('pointermove', (e) => {
          if (!scrub) return;
          const span = p.max - p.min;
          const v = scrub.start + (e.clientX - scrub.x) * (span / 260);
          rg.value = String(Math.min(p.max, Math.max(p.min, v)));
          rg.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const endScrub = (): void => { scrub = null; };
        lab.addEventListener('pointerup', endScrub);
        lab.addEventListener('pointercancel', endScrub);
        /* 单击数值 → 就地输入（回车提交 / Esc 取消） */
        out.addEventListener('click', () => {
          if (out.dataset.editing) return;
          const inp = document.createElement('input');
          inp.type = 'text'; inp.className = 'numedit'; inp.value = String(parseFloat(rg.value));
          inp.setAttribute('aria-label', p.label + ' 直接输入');
          out.dataset.editing = '1'; out.style.display = 'none';
          row.insertBefore(inp, out);
          inp.focus(); inp.select();
          const restore = (): void => {
            out.dataset.editing = ''; out.style.display = '';
            out.textContent = fmtVal(p, parseFloat(rg.value));
            inp.remove();
          };
          inp.addEventListener('keydown', (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter') { const v = parseFloat(inp.value); if (isFinite(v)) commit(v); restore(); ev.preventDefault(); }
            else if (ev.key === 'Escape') { restore(); ev.preventDefault(); }
          });
          inp.addEventListener('blur', restore);
        });
        row.appendChild(rg); row.appendChild(out);
        const od = document.createElement('span'); od.className = 'odot'; row.appendChild(od);
        sliders[key] = { rg, out, od, p, g, row, lab };
      }
      body.appendChild(row);
    }
    d.appendChild(body);
    root.appendChild(d);
  }
  applyParamFilter();
}
/* R18：look 组的 coupling 六系数是嵌套对象，滑杆键走点路径（'coupling.rg'）。
 * 取值缺省回落 DEFAULT_COUPLING（历史固定矩阵）；赋值按需创建对象（序列化只写出现过的键）。 */
function lookGet(l: LookParams, k: string): number {
  const dot = k.indexOf('.');
  if (dot < 0) return l[k as keyof LookParams] as number;
  const b = k.slice(dot + 1) as keyof typeof DEFAULT_COUPLING;
  const obj = l[k.slice(0, dot) as 'coupling'] as Record<string, number> | undefined;
  return obj && obj[b] !== undefined ? obj[b] : DEFAULT_COUPLING[b];
}
function lookSet(l: LookParams, k: string, v: number): void {
  const dot = k.indexOf('.');
  if (dot < 0) { (l as unknown as Record<string, number>)[k] = v; return; }
  const b = k.slice(dot + 1);
  const obj = (l[k.slice(0, dot) as 'coupling'] ??= {}) as Record<string, number>;
  obj[b] = v;
}

function getParam(g: SpecGroup, k: string): number {
  const st = store.state!;
  if (g.kind === 'color') return (st.colorParams as unknown as Record<string, number>)[k];
  if (g.kind === 'look') return lookGet(st.look, k);
  if (g.kind === 'master') return st.master;
  return (st.texture[g.id as keyof TextureParams] as unknown as Record<string, number>)[k];
}
function setParam(g: SpecGroup, k: string, v: number): void {
  const st = store.state!;
  if (g.kind === 'color') (st.colorParams as unknown as Record<string, number>)[k] = v;
  else if (g.kind === 'look') lookSet(st.look, k, v);
  else if (g.kind === 'master') st.master = v;
  else (st.texture[g.id as keyof TextureParams] as unknown as Record<string, number>)[k] = v;
}
/* select 枚举字段（Schema v1.1 的 grain.type / grain.mode）走字符串分支，不破坏既有数字路径 */
function getParamStr(g: SpecGroup, k: string): string {
  const st = store.state!;
  if (g.kind === 'look') return String(st.look[k as keyof LookParams]);
  return String((st.texture[g.id as keyof TextureParams] as unknown as Record<string, string>)[k]);
}
function setParamStr(g: SpecGroup, k: string, v: string): void {
  const st = store.state!;
  if (g.kind === 'look') (st.look as unknown as Record<string, string>)[k] = v;
  else (st.texture[g.id as keyof TextureParams] as unknown as Record<string, string>)[k] = v;
}
function markUser(key: string): void {
  if (!store.state) return;
  store.state.origins[key] = 'user';
}

function syncSliders(): void {
  for (const [key, s] of Object.entries(sliders)) {
    if (!store.state) continue;
    if (s.cb) {
      const gid = key.split('.')[0];
      s.cb.checked = (store.state.texture[gid as keyof TextureParams] as unknown as { enabled: boolean }).enabled;
      continue;
    }
    if (s.ci) { s.ci.value = rgbToHex(store.state.texture.halation.tint_rgb); }
    if (s.sel && s.p && s.g) { s.sel.value = getParamStr(s.g, s.p.k); }
    if (s.rg && s.p && s.g && s.out) {
      const v = getParam(s.g, s.p.k);
      s.rg.value = String(v);
      s.out.textContent = fmtVal(s.p, v);
    }
    if (s.od) {
      const o = store.state.origins[key] ?? 'user';
      s.od.className = 'odot o-' + o;
      s.od.title = ({ annotated: '图库标注', estimated: '算法估算', user: '用户手调' } as Record<string, string>)[o];
    }
  }
}

/* ================= 配方摘要 / JSON（③ 出配方） ================= */
function currentRecipe(): Recipe | null {
  if (!store.state || !store.ref) return null;
  return buildRecipe({
    name: store.recipeName,
    sourceType: store.ref.kind,
    refImageId: store.ref.kind === 'stock' ? null : store.ref.id,
    stockId: store.ref.kind === 'stock' ? store.ref.id.replace(/^stock_/, '') : null,
    state: store.state,
  });
}

let jsonTimer: ReturnType<typeof setTimeout> | null = null;
function refreshSummary(): void {
  const el = $('recipe-summary');
  const r = currentRecipe();
  if (!r) { el.innerHTML = '<div class="disabled-hint">载入画面并选定参考后，引擎自动合成配方（色彩匹配 + 质感 + look）。</div>'; return; }
  const kindName = ({ library: '图库', upload: '上传参考', stock: '型号直出' } as Record<RefKind, string>)[store.ref!.kind];
  el.innerHTML =
    `<div><span class="k">名称</span>${r.name}</div>` +
    `<div><span class="k">配方码</span><span id="recipe-code">${r.share_code}</span> <span class="badge">id ${r.id}</span></div>` +
    `<div><span class="k">来源</span>${kindName} · ${r.meta.source.ref_image_id ?? r.meta.source.stock_id ?? '-'}</div>` +
    `<div><span class="k">引擎</span>${r.color.engine} · LUT ${r.color.lut_size}³ · 匹配强度 ${r.color.params.match_strength.toFixed(2)}</div>` +
    `<div><span class="k">烘焙</span>上次 ${lastBakeMs.toFixed(0)}ms${lutCurrent ? ' · 已就绪' : ' · …'}</div>`;
}
function refreshJSON(): void {
  if (jsonTimer) return;
  jsonTimer = setTimeout(() => {
    jsonTimer = null;
    const r = currentRecipe();
    ($('jsonbox') as HTMLTextAreaElement).value = r ? JSON.stringify(r, null, 2) : '';
  }, 200);
}

/* ================= 步骤指示与按钮可用性 ================= */
function refreshSteps(): void {
  const on = (n: number): void => { $('step' + n).classList.add('on'); };
  const off = (n: number): void => { $('step' + n).classList.remove('on'); };
  for (let i = 1; i <= 5; i++) off(i);
  if (store.frame) on(1);
  if (store.ref) { on(2); on(3); }
  if (store.state) { on(4); on(5); }
  const has = !!store.state;
  for (const id of ['btn-save', 'btn-export-json', 'btn-copy-json', 'btn-copy-code', 'btn-copy-full', 'btn-cube']) {
    ($(id) as HTMLButtonElement).disabled = !has;
  }
  /* R17：数据范围开关随配方可用性启用（无配方时只读展示 Full） */
  for (const b of document.querySelectorAll<HTMLButtonElement>('#seg-range .seg-btn')) b.disabled = !has;
  ($('btn-cube-dir') as HTMLButtonElement).disabled = !has || !('showDirectoryPicker' in window);
  ($('empty') as HTMLElement).style.display = store.frame ? 'none' : 'flex';
  /* R16：预览浮层（查看方式 + HUD）只在载入画面后常驻；未载入时随 #empty 一起隐藏 */
  ($('viewhud') as HTMLElement).hidden = !store.frame;
  ($('hud') as HTMLElement).hidden = !store.frame;
  ($('frame-info') as HTMLElement).textContent = store.frame
    ? `当前画面：${store.frame.name} · ${store.frame.canvas.width}×${store.frame.canvas.height} · 统计 ${store.frame.stats.samples} 样本`
    : '未载入画面。示例帧为程序生成测试画面（无网络依赖）。';
}

let listTimer: ReturnType<typeof setTimeout> | null = null;
function refreshRecipeList(): void {
  if (listTimer) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    const sel = $('reflist') as HTMLSelectElement;
    const list = storage.listRecipes();
    sel.innerHTML = `<option value="">本地配方（${list.length}）</option>` +
      list.map((r) => {
        const meta = r.recipe as { name?: string; share_code?: string };
        return `<option value="${r.id}">${meta.name ?? r.id} · ${meta.share_code ?? ''}</option>`;
      }).join('');
    sel.disabled = list.length === 0;
    ($('btn-load') as HTMLButtonElement).disabled = list.length === 0;
    ($('btn-del') as HTMLButtonElement).disabled = list.length === 0;
  }, 120);
}

/**
 * R14-B：按 store.state 的匹配可用性刷新色彩组表现与简单模式可见集合。
 * 匹配不可用（型号卡直出，refStats=null）→ 标题标记「不适用」、组内说明可见、
 * 组内滑杆全部禁用；简单模式改用 look 关键项。切换参考后由 refreshAll 立即重算。
 */
function refreshMatchAvailability(): void {
  const ok = matchAvailable(store.state);
  const changed = ok !== matchOk;
  matchOk = ok;
  simpleKeySet = simpleKeys(ok);
  if (colorGroupStatus) {
    colorGroupStatus.textContent = ok ? '' : MATCH_UNAVAILABLE_TITLE;
    colorGroupStatus.hidden = ok;
  }
  if (colorGroupNote) colorGroupNote.hidden = ok;
  const dis = !ok;
  for (const s of Object.values(sliders)) {
    if (!s.g || s.g.kind !== 'color') continue;
    const els: Array<HTMLInputElement | HTMLSelectElement | undefined> = [s.rg, s.sel, s.ci];
    for (const el of els) {
      if (!el) continue;
      el.disabled = dis;
      el.setAttribute('aria-disabled', dis ? 'true' : 'false');
      if (dis) el.title = MATCH_UNAVAILABLE_TITLE;
      else if (s.rg && s.p) el.title = s.p.label + '（←/→ 微调，PageUp/PageDown 大步，双击复位）';
    }
  }
  /* 可见集合随可用性变化：更新每行的简单模式标记后再过滤 */
  for (const s of Object.values(sliders)) {
    if (s.p && s.g && s.row) s.row.dataset.simple = isVisible(s.g, s.p, 'simple', simpleKeySet) ? '1' : '0';
  }
  if (changed) applyParamFilter();
  else publishUiMeta();
}

function refreshAll(): void {
  refreshMatchAvailability();
  syncSliders();
  syncMatrixUI();
  syncRangeUI();
  refreshSummary();
  refreshSteps();
  refreshGroupResets();
  refreshHud();
  refreshJSON();
}

subscribe(refreshAll);
subscribe(refreshRecipeList);

/* ================= ① 传帧 ================= */
const FRAME_W = 1280;
const FRAME_H = 720;
const frameCanvas = document.createElement('canvas');

function analyzeCanvas(cv: HTMLCanvasElement): ImageStats {
  const c = cv.getContext('2d')!;
  const img = c.getImageData(0, 0, cv.width, cv.height);
  return analyzeImage(img.data, cv.width, cv.height);
}

function loadFrameFromCanvas(cv: HTMLCanvasElement, name: string): void {
  store.frame = { name, canvas: cv, stats: analyzeCanvas(cv) };
  renderer.setSource(cv);
  // 换帧后：已有参考则重估被调色图统计并重烘焙
  if (store.state) {
    store.state.userStats = store.frame.stats;
    store.initial = store.initial ? { ...store.initial, userStats: store.frame.stats } : null;
  }
  /* 换帧后：被调色图统计变化 → 匹配变换变化，需重烘匹配 LUT */
  scheduleBake(true, false);
  pushRender();
  refreshAll();
}

function loadSampleFrame(scene: SceneId): void {
  frameCanvas.width = FRAME_W; frameCanvas.height = FRAME_H;
  const c = frameCanvas.getContext('2d')!;
  if (scene === 'neon') drawNeon(c, FRAME_W, FRAME_H);
  else if (scene === 'dusk') drawDusk(c, FRAME_W, FRAME_H);
  else drawChart(c, FRAME_W, FRAME_H);
  loadFrameFromCanvas(frameCanvas, '示例帧 · ' + ({ neon: '霓虹夜景', dusk: '黄昏逆光', chart: '校色卡' } as Record<SceneId, string>)[scene]);
}

function loadFrameFile(f: File): void {
  const img = new Image();
  img.onload = () => {
    // 长边 > 2560 自动缩
    const cap = 2560;
    const s = Math.min(1, cap / Math.max(img.width, img.height));
    const w = Math.round(img.width * s);
    const h = Math.round(img.height * s);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d')!.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(img.src);
    loadFrameFromCanvas(cv, f.name);
    toast('已载入 ' + f.name);
  };
  img.src = URL.createObjectURL(f);
}

$('btn-sample').addEventListener('click', () => loadSampleFrame('neon'));
$('btn-sample-dusk').addEventListener('click', () => loadSampleFrame('dusk'));
$('btn-sample-chart').addEventListener('click', () => loadSampleFrame('chart'));
$('btn-sample-empty').addEventListener('click', () => loadSampleFrame('neon'));
$('btn-file').addEventListener('click', () => ($('file-frame') as HTMLInputElement).click());
$('file-frame').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) loadFrameFile(f);
});
const stage = $('stage');
stage.addEventListener('dragover', (e) => { e.preventDefault(); $('dropmask').style.display = 'flex'; });
stage.addEventListener('dragleave', () => { $('dropmask').style.display = 'none'; });
stage.addEventListener('drop', (e) => {
  e.preventDefault(); $('dropmask').style.display = 'none';
  const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith('image/'));
  if (f) loadFrameFile(f);
});
window.addEventListener('paste', (e) => {
  if (!store.state && !store.frame) { /* 粘贴帧任何时候都允许 */ }
  const it = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  const f = it?.getAsFile();
  if (f) { loadFrameFile(f); toast('已粘贴画面'); }
});

/* ================= ② 选参考 ================= */
function switchTab(tab: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#ref-tabs .tab')) {
    b.classList.toggle('on', b.dataset.tab === tab);
  }
  $('tab-gallery').style.display = tab === 'gallery' ? 'block' : 'none';
  $('tab-upload').style.display = tab === 'upload' ? 'block' : 'none';
  $('tab-stock').style.display = tab === 'stock' ? 'block' : 'none';
  $('tab-style').style.display = tab === 'style' ? 'block' : 'none';
  if (tab === 'stock') renderStockThumbs(); // 卡片墙缩略图懒渲染
  if (tab === 'style') {
    renderStyleThumbs(); // R8 风格卡片墙缩略图懒渲染
    void ensureXmpImport().then((m) => m.renderXmpGrid()); // R15：XMP 估算起点卡（模块懒加载后刷新独立网格）
  }
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#ref-tabs .tab')) {
  b.addEventListener('click', () => switchTab(b.dataset.tab!));
}

function refCard(entry: LibraryEntry): HTMLElement {
  const d = document.createElement('div');
  d.className = 'card';
  d.dataset.id = entry.id;
  /* R11 无障碍：卡片作为可聚焦按钮（Enter/Space 选中），屏幕阅读器可辨识 */
  d.setAttribute('role', 'button');
  d.tabIndex = 0;
  d.setAttribute('aria-label', '选择参考：' + entry.name);
  if (entry.thumb) {
    const img = document.createElement('img');
    img.src = entry.thumb;
    img.alt = entry.name;
    d.appendChild(img);
  } else if (entry.kind === 'stock') {
    // 型号卡：占位 img（无 src 渲染为黑底），卡片墙懒渲染时回填 dataURL
    const img = document.createElement('img');
    img.alt = entry.name;
    d.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'emptyimg';
    ph.textContent = '渲染中…';
    d.appendChild(ph);
  }
  const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = entry.name; d.appendChild(nm);
  const tag = document.createElement('div'); tag.className = 'tag';
  if (entry.kind === 'stock') {
    // 型号卡：tagline + 适用建议（悬停完整说明）
    const meta = getPreset(entry.presetId).meta;
    tag.textContent = meta.tagline;
    tag.title = meta.advice ? '适用：' + meta.advice : entry.annotation.note;
  } else {
    tag.innerHTML = `<span class="o-${entry.annotation.origin}"></span>${entry.annotation.origin === 'annotated' ? '标注' : '估算'}`;
  }
  d.appendChild(tag);
  if (entry.kind !== 'stock') {
    // 标注编辑器入口（F4）：不触发选卡
    const eb = document.createElement('button');
    eb.className = 'editbtn';
    eb.type = 'button';
    eb.textContent = '标注';
    eb.title = '查看/编辑该条目的 look+质感标注';
    eb.addEventListener('click', (e) => {
      e.stopPropagation();
      void ensureAnnotate().then((m) => m.openAnnotate(entry));
    });
    d.appendChild(eb);
  }
  d.addEventListener('click', () => selectRef(entry));
  d.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectRef(entry); }
  });
  return d;
}

function buildRefUI(): void {
  const gg = $('gallery-grid');
  gg.innerHTML = '';
  for (const e of allEntries()) gg.appendChild(refCard(e));
  // 重建卡片墙会丢掉已回填的缩略图，重置懒渲染标记，让后续 render*Thumbs 能重新渲染
  stockThumbsDone = false;
  styleThumbsDone = false;
  buildStockWall();
  buildStyleWall();
}

/** F12 型号卡片墙：缩略图 = 该型号 look+质感 实时渲染的同一示例帧（懒渲染） */
function buildStockWall(): void {
  const sg = $('stock-grid');
  sg.innerHTML = '';
  for (const e of stockCards()) sg.appendChild(refCard(e));
  applyStockFilter();
}

/** R8 风格卡片墙（新维度：冲印工艺/时代感）：与型号卡同一渲染/选中路径 */
function buildStyleWall(): void {
  const sg = $('style-grid');
  sg.innerHTML = '';
  for (const e of styleCards()) sg.appendChild(refCard(e));
}

let stockThumbsDone = false;
function renderStockThumbs(): void {
  if (stockThumbsDone) return;
  stockThumbsDone = true;
  const t0 = performance.now();
  const cards = stockCards();
  let done = 0;
  for (const e of cards) {
    const url = stockThumbUrl(e.presetId);
    if (!url) continue;
    const card = document.querySelector<HTMLElement>(`#stock-grid .card[data-id="${e.id}"]`);
    const img = card?.querySelector('img');
    if (img) { img.src = url; done++; }
  }
  console.info(`[stockwall] ${done}/${cards.length} 张运行时渲染 ${(performance.now() - t0).toFixed(0)}ms`);
  setMeta({ stockThumbs: done });
}

let styleThumbsDone = false;
/** R8 风格卡缩略图渲染（复用 stockThumbUrl：同帧同参输出确定，缓存键含 presetId） */
function renderStyleThumbs(): void {
  if (styleThumbsDone) return;
  styleThumbsDone = true;
  const t0 = performance.now();
  const cards = styleCards();
  let done = 0;
  for (const e of cards) {
    const url = stockThumbUrl(e.presetId);
    if (!url) continue;
    const card = document.querySelector<HTMLElement>(`#style-grid .card[data-id="${e.id}"]`);
    const img = card?.querySelector('img');
    if (img) { img.src = url; done++; }
  }
  console.info(`[stylewall] ${done}/${cards.length} 张运行时渲染 ${(performance.now() - t0).toFixed(0)}ms`);
  setMeta({ styleThumbs: done });
}

/* ================= R2 矩阵选择器（画幅 × 感光度 × 光晕档） =================
 * 与「选型号」卡片墙正交：卡片决定 look+质感基调，矩阵决定颗粒 profile 与光晕档。
 * 应用即写回 store.state.texture（applyProfile 纯函数输出）与 store.state.profile，
 * 并把被覆盖的字段 origin 标为 user，再重烘焙 LUT / 重渲染 / 刷新面板。 */
let mxRef: TextureProfileRef = { ...DEFAULT_PROFILE };

function currentGrain(): { format: FilmFormat; iso: IsoStep } {
  const g = grainProfileById(mxRef.grain) ?? grainProfileById(DEFAULT_PROFILE.grain)!;
  return { format: g.format, iso: g.iso };
}

/** 应用矩阵档位（UI 点击与 URL 演示共用）。未选定参考时仅提示，不抛错 */
function applyMatrixRef(ref: TextureProfileRef): void {
  if (!store.state || !store.frame) { toast('请先载入画面并选定型号/参考'); return; }
  const norm = normalizeProfileRef(ref);
  const st = store.state;
  st.texture = applyProfile(st.texture, norm);
  st.profile = norm;
  // 档位覆盖的字段 = 用户手调（颗粒 8 项 + 光晕 5 项）
  for (const k of ['size', 'correlation', 'shadow', 'midtone', 'highlight', 'film_resolution', 'type', 'iso']) {
    st.origins['grain.' + k] = 'user';
  }
  for (const k of ['amount', 'radius', 'amplify', 'smoothness', 'blue_comp']) {
    st.origins['halation.' + k] = 'user';
  }
  // 光晕档位需要光晕层开启才可见（applyProfile 只写档位数值，不改开关）
  st.texture.halation.enabled = true;
  st.origins['halation.enabled'] = 'user';
  mxRef = norm;
  syncMatrixUI();
  pushRender(); scheduleBake(false); refreshAll();
}

function onMatrixPick(p: { format?: FilmFormat; iso?: IsoStep; halation?: HalationProfileId }): void {
  if (!store.state || !store.frame) { toast('请先载入画面并选定型号/参考'); return; }
  const cur = currentGrain();
  applyMatrixRef({
    grain: `g-${p.format ?? cur.format}-${p.iso ?? cur.iso}`,
    halation: p.halation ?? mxRef.halation,
  });
}

function buildMatrixUI(): void {
  const mkBtn = (parent: HTMLElement, text: string, title: string, on: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'mx-btn'; b.textContent = text; b.title = title;
    b.addEventListener('click', on);
    parent.appendChild(b);
    return b;
  };
  const fmt = $('mx-format');
  for (const f of FORMATS) {
    const b = mkBtn(fmt, f + 'mm', `画幅 ${f}mm（画幅越小颗粒越粗、乳剂分辨率越低）`, () => onMatrixPick({ format: f }));
    b.dataset.fmt = f;
  }
  const iso = $('mx-iso');
  for (const v of ISO_STEPS) {
    const b = mkBtn(iso, 'ISO ' + v, `感光度 ISO ${v}（越快暗部颗粒越明显）`, () => onMatrixPick({ iso: v }));
    b.dataset.iso = String(v);
  }
  const hal = $('mx-halation');
  for (const id of HALATION_PROFILE_IDS) {
    const b = mkBtn(hal, HALATION_PROFILES[id].name, HALATION_PROFILES[id].note, () => onMatrixPick({ halation: id }));
    b.dataset.hal = id;
  }
  buildTagFilter();
  syncMatrixUI();
}

/** 档位选择器同步到当前 store.state.profile（载入配方/选卡/点档位后调用） */
function syncMatrixUI(): void {
  if (store.state?.profile) mxRef = normalizeProfileRef(store.state.profile);
  const g = grainProfileById(mxRef.grain) ?? grainProfileById(DEFAULT_PROFILE.grain)!;
  const mark = (sel: string, attr: string, val: string): void => {
    for (const b of document.querySelectorAll<HTMLButtonElement>(`#${sel} .mx-btn`)) {
      b.classList.toggle('on', (b.dataset as Record<string, string | undefined>)[attr] === val);
    }
  };
  mark('mx-format', 'fmt', g.format);
  mark('mx-iso', 'iso', String(g.iso));
  mark('mx-halation', 'hal', mxRef.halation);
  const hp = HALATION_PROFILES[mxRef.halation] ?? HALATION_PROFILES.std;
  const sum = $('mx-summary');
  sum.textContent = `当前档位：${grainProfileLabel(g)} · 光晕 ${hp.name} —— ${hp.note}`;
  sum.title = g.note;
}

/* ================= R2 标签筛选（由 10 张卡的 sceneTags 去重） ================= */
const TAG_ALL = '__all__';
const TAG_LABEL: Record<string, string> = {
  night: '夜景', neon: '霓虹', indoor: '室内', daylight: '日光', portrait: '人像',
  dusk: '黄昏', landscape: '风光', street: '街拍', retro: '怀旧',
  documentary: '纪实', urban: '城市', architecture: '建筑',
};
let activeTag: string | null = null;

function stockTagCounts(): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of stockCards()) {
    for (const t of getPreset(e.presetId).meta.sceneTags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
  }
  return m;
}

function buildTagFilter(): void {
  const root = $('tagfilter');
  root.innerHTML = '';
  const counts = stockTagCounts();
  const mk = (label: string, val: string | null): void => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'mx-btn';
    b.dataset.tag = val ?? TAG_ALL;
    b.textContent = label;
    b.addEventListener('click', () => { setTagFilter(val); });
    root.appendChild(b);
  };
  mk('全部', null);
  for (const t of [...counts.keys()].sort()) mk(`${TAG_LABEL[t] ?? t}(${counts.get(t)})`, t);
}

function setTagFilter(tag: string | null): void {
  activeTag = tag;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tagfilter .mx-btn')) {
    b.classList.toggle('on', (b.dataset.tag ?? TAG_ALL) === (tag ?? TAG_ALL));
  }
  applyStockFilter();
}

/** 只显示含当前标签的卡；无命中时显示提示行。返回可见卡数 */
function applyStockFilter(): number {
  let visible = 0;
  for (const e of stockCards()) {
    const card = document.querySelector<HTMLElement>(`#stock-grid .card[data-id="${e.id}"]`);
    if (!card) continue;
    const tags = getPreset(e.presetId).meta.sceneTags ?? [];
    const show = !activeTag || tags.includes(activeTag);
    card.style.display = show ? '' : 'none';
    if (show) visible++;
  }
  $('tagfilter-empty').style.display = visible === 0 ? 'block' : 'none';
  return visible;
}

/** 演示用：优先选 night，否则挑一个「非全量」标签（1..N-1 张），确保筛选确实生效 */
function pickFilterTag(): string {
  const counts = stockTagCounts();
  const total = stockCards().length;
  const ok = (n: number | undefined): boolean => !!n && n >= 1 && n < total;
  if (ok(counts.get('night'))) return 'night';
  for (const [t, n] of counts) if (ok(n)) return t;
  return 'night';
}


function markSelectedRef(id: string | null): void {
  for (const c of document.querySelectorAll<HTMLElement>('.card')) {
    c.classList.toggle('sel', c.dataset.id === id);
  }
}

/** 选中参考 → ③ 自动合成配方 */
function selectRef(entry: LibraryEntry): void {
  if (!store.frame) { toast('请先载入画面（① 传帧）'); return; }
  const kind: RefKind = entry.kind;
  store.ref = { kind, id: entry.id, label: entry.name, stats: entry.stats } as never;
  store.state = initRecipeState({
    kind,
    neutralMatch: kind === 'stock',
    look: { ...defaultLook(), ...entry.look },
    texture: cloneParams({ texture: entry.texture, look: defaultLook(), master: 1 }).texture,
    origins: { ...entry.origins },
    refStats: entry.stats,
  });
  // R2：型号卡带档位来源 → 同步到配方运行时（矩阵选择器随 refreshAll 同步）
  if (entry.profile) store.state.profile = normalizeProfileRef(entry.profile);
  // 色彩参数起点徽标：引擎推导的默认（估算）；user 一动即改
  for (const k of Object.keys(store.state.colorParams)) markInitialColor(store.state.origins, 'color.' + k);
  store.initial = {
    ...store.state,
    colorParams: { ...store.state.colorParams },
    look: { ...store.state.look },
    texture: cloneParams({ texture: store.state.texture, look: defaultLook(), master: 1 }).texture,
    origins: { ...store.state.origins },
  };
  store.recipeId = makeId();
  store.recipeName = entry.name + ' · ' + (store.frame?.name.split('·')[0].trim() ?? '');
  markSelectedRef(entry.id);
  bake(65);
  pushRender();
  refreshAll();
  void ensureDrx().then((m) => m.refreshDrxExport());   // R5/R12：配方变化后刷新节点包导出区摘要（懒加载）
  if (kind === 'upload') switchTab('upload');
  toast('配方已生成：' + store.recipeName);
}
function markInitialColor(origins: Record<string, Origin>, key: string): void {
  if (!origins[key]) origins[key] = 'estimated';
}

function ingestRef(f: File): void {
  const img = new Image();
  img.onload = () => {
    /* R18：estimateTexture 懒加载（估算只在入库时发生，不进首屏包；gzip 预算纪律） */
    void ingestRefImage(img, '我的参考 · ' + f.name).then(({ entry, debug }) => {
      URL.revokeObjectURL(img.src);
      buildRefUI();
      console.info('[估算]', f.name, JSON.stringify(debug));
      switchTab('gallery');
      selectRef(entry);
    });
  };
  img.src = URL.createObjectURL(f);
}
$('btn-import-ref').addEventListener('click', () => ($('file-ref') as HTMLInputElement).click());
$('file-ref').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) ingestRef(f);
});
$('btn-upload-ref').addEventListener('click', () => ($('file-ref2') as HTMLInputElement).click());
$('file-ref2').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) ingestRef(f);
});

/* R15：XMP 预设导入（图库入口；多选逐个解析，坏文件不中断整批——逻辑在 ui/xmpimport 懒加载模块） */
$('btn-import-xmp').addEventListener('click', () => ($('file-xmp') as HTMLInputElement).click());
$('file-xmp').addEventListener('change', (e) => {
  const files = Array.from((e.target as HTMLInputElement).files ?? []);
  if (files.length) void ensureXmpImport().then((m) => m.importXmpFiles(files));
});

/* ================= ④ 查看/重置 ================= */
/* R11：视图模式分段控件（调色 / 隔离 / 分屏 / 原图）；快捷键 v 循环、a 切 A/B
 * R16：同一套查看方式有两个入口——④ 里 #seg-view + 预览左上角常驻浮层 #viewhud，
 * on/aria-selected 统一在 setViewMode 里一起刷新（快捷键 v/a 也走这里），两处永远同步。 */
function setViewMode(m: ViewMode): void {
  store.viewMode = m;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#seg-view .seg-btn, #viewhud .seg-btn')) {
    const on = Number(b.dataset.mode) === m;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  updateSplitUI(); pushRender();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#seg-view .seg-btn, #viewhud .seg-btn')) {
  b.addEventListener('click', () => setViewMode(Number(b.dataset.mode) as ViewMode));
}
const VIEW_CYCLE: ViewMode[] = [0, 2, 1];
function cycleViewMode(): void {
  const i = VIEW_CYCLE.indexOf(store.viewMode);
  setViewMode(VIEW_CYCLE[(i + 1) % VIEW_CYCLE.length]);
}
function toggleAB(): void { setViewMode(store.viewMode === 2 ? 0 : 2); }

/* ================= R16：预览 HUD（右下角：配方码 / 参考名 / 数据范围） =================
 * 开关状态记忆在 localStorage（fm.hud，默认开）；取值在 refreshHud（refreshAll 驱动）刷新；
 * 数据范围（Video/Legal ↔ Full/Data）R17 接入：显示当前配方 range（Full/Legal，无配方时「--」）。 */
const HUD_KEY = 'fm.hud';
let hudOn: boolean = (() => {
  try { return localStorage.getItem(HUD_KEY) !== 'off'; } catch { return true; }
})();
/** R17：HUD/导出区共用的范围标签（预览画面本身不随 range 变化——只声明导出目标） */
function rangeLabel(): string {
  if (!store.state) return '--';
  return store.state.range === 'legal' ? 'Legal' : 'Full';
}
function refreshHud(): void {
  const hud = $('hud');
  hud.classList.toggle('off', !hudOn);
  ($('hud-toggle') as HTMLButtonElement).setAttribute('aria-pressed', hudOn ? 'true' : 'false');
  $('hud-code').textContent = store.state ? shareCodeOf(store.state) : '--';
  $('hud-ref').textContent = store.ref?.label ?? '--';
  $('hud-range').textContent = rangeLabel();
}
$('hud-toggle').addEventListener('click', () => {
  hudOn = !hudOn;
  try { localStorage.setItem(HUD_KEY, hudOn ? 'on' : 'off'); } catch { /* 隐私模式忽略 */ }
  refreshHud();
});

/* ================= R17：数据范围开关（⑤ 保存/导出区） =================
 * 语义：网页预览工作在 Full/Data（0..1），预览画面**不随开关变化**；开关声明 .cube 导出目标
 * ——'legal'（达芬奇时间线常见 Video/Legal）时导出表做 Legal→Full 展开 + Full→Legal 回编。
 * 选中值进配方（output.range，可选字段，缺省 'full' 旧配方逐位不变）；不参与配方码 hash。 */
function syncRangeUI(): void {
  const cur = store.state?.range === 'legal' ? 'legal' : 'full';
  for (const b of document.querySelectorAll<HTMLButtonElement>('#seg-range .seg-btn')) {
    const on = b.dataset.range === cur;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
}
function setExportRange(v: 'full' | 'legal'): void {
  if (!store.state) return;
  store.state.range = v;
  syncRangeUI();
  refreshHud();
  refreshJSON();
  setMeta({ exportRange: v });
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#seg-range .seg-btn')) {
  b.addEventListener('click', () => setExportRange(b.dataset.range === 'legal' ? 'legal' : 'full'));
}
$('btn-reset').addEventListener('click', () => {
  if (!store.initial) return;
  store.state = {
    ...store.initial,
    colorParams: { ...store.initial.colorParams },
    look: { ...store.initial.look },
    texture: cloneParams({ texture: store.initial.texture, look: defaultLook(), master: 1 }).texture,
    origins: { ...store.initial.origins },
  };
  bake(65);
  pushRender();
  refreshAll();
  toast('已恢复初始配方');
});

/* 分屏拖柄 */
const splitline = $('splitline');
function updateSplitUI(): void {
  const on = store.viewMode === 2;
  splitline.style.display = on ? 'block' : 'none';
  $('chip-eff').style.display = on ? 'block' : 'none';
  $('chip-orig').style.display = on ? 'block' : 'none';
  splitline.style.left = (store.splitX * 100) + '%';
}
splitline.addEventListener('pointerdown', (e) => {
  splitline.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    store.splitX = Math.min(0.98, Math.max(0.02, (ev.clientX - rect.left) / rect.width));
    splitline.style.left = (store.splitX * 100) + '%';
    pushRender();
  };
  const up = (): void => {
    splitline.removeEventListener('pointermove', move);
    splitline.removeEventListener('pointerup', up);
  };
  splitline.addEventListener('pointermove', move);
  splitline.addEventListener('pointerup', up);
});

/* ================= R11 键盘快捷键 / 参数搜索 / 模式按钮 =================
 * 仅裸键（v/a/m/），带 Ctrl/Alt/Meta 一律放行浏览器默认；输入控件内不触发。 */
($('param-search') as HTMLInputElement).addEventListener('input', applyParamFilter);
$('btn-mode').addEventListener('click', () => setUiMode(uiMode === 'simple' ? 'advanced' : 'simple'));
window.addEventListener('keydown', (e) => {
  if (isTypingTarget(e.target as HTMLElement)) {
    if (e.key === 'Escape') (e.target as HTMLElement).blur();
    return;
  }
  const a = matchShortcut(e);
  if (!a) return;
  if (a === 'view') cycleViewMode();
  else if (a === 'ab') toggleAB();
  else if (a === 'mode') setUiMode(uiMode === 'simple' ? 'advanced' : 'simple');
  else if (a === 'search') { $d('g-step4').open = true; ($('param-search') as HTMLInputElement).focus(); }
  e.preventDefault();
});

/* ================= ⑤ 保存 / 导出 ================= */
function showCubeHint(msg: string): void {
  const el = $('cube-hint');
  el.style.display = 'block';
  el.textContent = msg;
}

async function cubeText(range: DataRange): Promise<{ text: string; code: string; size: number; range: DataRange }> {
  const st = store.state!;
  /* R10-B：65³ 复合 LUT（匹配∘look）烘焙走 worker（约 10 万+ 体素），不阻塞主线程；
   * R17：range='legal' 时烘焙侧做 Legal↔Full 包裹（仅导出语义，预览不变），CPU/GPU 同式。 */
  const res = await lutClient.run({ state: st, size: 65, kind: 'recipe', range });
  const lut = { size: res.size, table: res.table };
  const code = shareCodeOf(st);
  /* R17：legal 导出在头部注释声明数据范围与映射公式（full 保持既有头部，逐字节一致） */
  const comments = range === 'legal'
    ? [
      'data-range: video-legal (Full/Data preview unchanged)',
      'input legal->full: D(x)=clamp01((x-0.0627451)/(0.9215686-0.0627451))',
      'output full->legal: E(y)=y*(0.9215686-0.0627451)+0.0627451',
    ]
    : [];
  return { text: toCube(lut, `${store.recipeName} ${code}`, { comments }), code, size: lut.size, range };
}

async function currentCube(): Promise<{ text: string; code: string; size: number }> {
  return cubeText(normalizeDataRange(store.state?.range));
}

function afterCubeExport(text: string, code: string, how: string): void {
  showCubeHint(
    `✓ ${how}：${code}.cube（65³，${(text.length / 1024).toFixed(0)} KB 文本）。` +
    `达芬奇使用：在节点上右键 → Settings → LUT 载入该文件（或放入达芬奇 LUT 目录后刷新）。` +
    `LUT 已含色彩匹配与 look 全部色彩；质感层（光晕/颗粒/柔光/暗角）请按节点树搭建指南在达芬奇手动搭建（Phase3 图文指南）。`,
  );
  smokeLog(`cube导出(${how}) ${text.length}B 首行: ${text.split('\n')[0]}`);
}

$('btn-cube').addEventListener('click', async () => {
  if (!store.state) return;
  const { text, code } = await currentCube();
  storage.exportFile(`${code}.cube`, text, 'text/plain');
  afterCubeExport(text, code, '已触发浏览器下载');
  toast('已下载 ' + code + '.cube');
});

$('btn-cube-dir').addEventListener('click', async () => {
  if (!store.state) return;
  const w = window as unknown as { showDirectoryPicker?: (o?: unknown) => Promise<FileSystemDirectoryHandle> };
  if (!w.showDirectoryPicker) { toast('当前浏览器不支持目录直写，请用「下载 .cube」'); return; }
  try {
    const dir = await w.showDirectoryPicker({ mode: 'readwrite' });
    const { text, code } = await currentCube();
    const fh = await dir.getFileHandle(`${code}.cube`, { create: true });
    const ws = await fh.createWritable();
    await ws.write(text);
    await ws.close();
    afterCubeExport(text, code, '已直写目录 ' + (dir.name ?? ''));
  } catch (err) {
    toast('目录直写取消或失败：' + (err as Error).message);
  }
});

$('btn-save').addEventListener('click', () => {
  const r = currentRecipe();
  if (!r) return;
  // 短码冲突自增（F11）：码本中已被其他配方占用则 +1 重算校验位
  const finalCode = storage.registerUniqueCode(r.id, r.share_code);
  if (finalCode !== r.share_code) { r.share_code = finalCode; toast('短码冲突，已自增为 ' + finalCode); }
  if (storage.saveRecipe(r)) {
    storage.registerCode(r.share_code, r.id);
    refreshRecipeList();
    toast(`已保存：${r.name}（${r.share_code}）`);
    smokeLog(`本地保存 ${r.id} ${r.share_code} 列表=${storage.listRecipes().length}`);
  } else toast('保存失败（存储空间不足？）');
});

$('btn-export-json').addEventListener('click', () => {
  const r = currentRecipe();
  if (!r) return;
  const text = storage.serializeRecipe(r);
  storage.exportFile(`${r.share_code}.json`, text);
  setMeta({ presetExport: { code: r.share_code, bytes: text.length, schemaVersion: r.schema_version } });
  toast('已导出配方 JSON');
});

$('btn-import-json').addEventListener('click', () => ($('file-json') as HTMLInputElement).click());
$('file-json').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) storage.importRecipeFile(f)
    .then((r) => {
      applyRecipe(r as unknown as Recipe);
      setMeta({ presetImport: { ok: true, id: r.id, schemaVersion: (r as unknown as { schema_version: number }).schema_version } });
    })
    .catch((err) => {
      setMeta({ presetImport: { ok: false, error: (err as Error).message } });
      toast('导入失败：' + err.message);
    });
});

function applyRecipe(r: Recipe, sourceNote?: string): void {
  const st = recipeToState(r);
  if (!store.frame && st.userStats) {
    // 无帧载入导入配方：以统计快照驱动（预览源缺失，仅恢复配方参数）
    toast('配方参数已恢复；载入画面后可预览');
  }
  store.ref = { kind: r.meta.source.type, id: r.meta.source.ref_image_id ?? r.meta.source.stock_id ?? '', label: r.name, stats: st.refStats } as never;
  store.state = st;
  store.initial = {
    ...st,
    colorParams: { ...st.colorParams },
    look: { ...st.look },
    texture: cloneParams({ texture: st.texture, look: defaultLook(), master: 1 }).texture,
    origins: { ...st.origins },
  };
  store.recipeId = r.id;
  store.recipeName = r.name;
  markSelectedRef(r.meta.source.ref_image_id);
  bake(65);
  pushRender();
  refreshAll();
  void ensureDrx().then((m) => m.refreshDrxExport());   // R5/R12：载入配方后刷新节点包导出区摘要（懒加载）
  toast(`已载入配方：${r.name}（${r.share_code}）${sourceNote ? ' · 来源：' + sourceNote : ''}`);
}

$('reflist').addEventListener('change', () => { /* 选择时仅高亮，点载入生效 */ });
$('btn-load').addEventListener('click', () => {
  const id = ($('reflist') as HTMLSelectElement).value;
  const r = storage.loadRecipe(id);
  if (r) applyRecipe(r as unknown as Recipe);
});
$('btn-del').addEventListener('click', () => {
  const id = ($('reflist') as HTMLSelectElement).value;
  if (id) { storage.removeRecipe(id); refreshRecipeList(); toast('已删除'); }
});

async function copyText(t: string): Promise<void> {
  try { await navigator.clipboard.writeText(t); } catch {
    const ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
}
$('btn-copy-json').addEventListener('click', async () => {
  const r = currentRecipe();
  if (r) { await copyText(storage.serializeRecipe(r)); toast('配方 JSON 已复制'); }
});
$('btn-copy-code').addEventListener('click', async () => {
  const r = currentRecipe();
  if (r) { await copyText(r.share_code); toast('配方码 ' + r.share_code + ' 已复制'); }
});
$('btn-copy-full').addEventListener('click', async () => {
  const r = currentRecipe();
  if (!r) return;
  const code = encodeFull(r);
  await copyText(code);
  toast(`完整分享码已复制（${code.length} 字符，粘贴即可导入）`);
});

/* ================= F11 导入配方码 / 码本 ================= */
function importCodeText(): void {
  const box = $('codebox') as HTMLTextAreaElement;
  const t = box.value.trim();
  if (!t) { toast('请先粘贴完整码（FM1. 开头）或短码（FM-XXXX）'); return; }
  if (t.startsWith('FM1.')) {
    const r = decodeFull(t);
    if (!r) { toast('完整码无效：格式/校验和不匹配，请重新完整复制'); return; }
    applyRecipe(r as unknown as Recipe, '完整分享码导入');
    box.value = '';
    return;
  }
  if (/^FM-[A-Z2-9]{4}$/i.test(t)) {
    const up = t.toUpperCase();
    if (!verifyShortCode(up)) { toast('短码校验位不符：请核对抄写（末位为校验位）'); return; }
    const r = storage.findByCode(up);
    if (!r) { toast('码本中找不到该短码：请让分享方同时导出码本 .json 给你'); return; }
    applyRecipe(r as unknown as Recipe, '短码 + 本地码本');
    box.value = '';
    return;
  }
  toast('无法识别：完整码以 FM1. 开头，短码形如 FM-XXXX');
}
$('btn-import-code').addEventListener('click', importCodeText);

$('btn-book-export').addEventListener('click', () => {
  storage.exportFile('filmmatch-码本.json', storage.serializeCodeBook());
  toast('码本已导出（随短码一起分享）');
});
$('btn-book-import').addEventListener('click', () => ($('file-book') as HTMLInputElement).click());
$('file-book').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  f.text().then((text) => {
    const { imported, skipped } = storage.mergeCodeBook(storage.parseCodeBook(text));
    toast(`码本已导入：绑定 ${imported} 条${skipped ? `（跳过非法 ${skipped} 条）` : ''}`);
    refreshRecipeList();
  }).catch((err) => toast('码本导入失败：' + err.message));
});

/* ================= F13 指南抽屉 / F4 标注编辑器（R12：均懒加载） ================= */
$('btn-guide').addEventListener('click', () => { void ensureGuide().then((m) => m.toggleGuide()); });
void ensureAnnotate();   // 注册标注编辑器依赖（模块懒加载，行为同静态 import）

/* ================= 冒烟日志 ================= */
const smokeLines: string[] = [];
function smokeLog(line: string): void {
  smokeLines.push(line);
  const el = $('smokelog');
  el.style.display = 'block';
  el.textContent = smokeLines.join('\n');
  console.info('[SMOKE]', line);
}

/* ================= 启动 & URL 辅助 ================= */
const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/* ================= R17：烘焙路径/耗时探针与 bakeperf/range 演示（动态 import，不进首屏包） =================
 * 实现在 src/ui/r17demo.ts（gzip 余量护栏）；口径与回退语义见该文件头注释。 */
let r17mod: typeof import('./ui/r17demo') | null = null;
async function ensureR17(): Promise<typeof import('./ui/r17demo')> {
  if (!r17mod) r17mod = await import('./ui/r17demo');
  return r17mod;
}
function r17ctx(): import('./ui/r17demo').R17Ctx {
  return {
    renderer,
    lutClient,
    getState: () => store.state,
    matchDataOf,
    cubeText,
    setExportRange,
    openStep5: () => { $d('g-step5').open = true; },
    setTitle: (t: string): void => { document.title = t; },
  };
}

/* ================= E2E/演示钩子（低频，R20 起动态 import：ui/e2edemos.ts，gzip 护栏） =================
 * adjust/split/overlay/groupreset/export/stockwall/styles/presetio/matrix/tagfilter/import 的
 * 实现在 ui/e2edemos.ts；本处只保留加载器与窄 ctx（页面动作面），语义与迁出前一致。 */
let e2eDemosMod: typeof import('./ui/e2edemos') | null = null;
async function ensureE2eDemos(): Promise<typeof import('./ui/e2edemos')> {
  if (!e2eDemosMod) e2eDemosMod = await import('./ui/e2edemos');
  return e2eDemosMod;
}
function e2eDemoCtx(): import('./ui/e2edemos').E2eDemoCtx {
  return {
    selectRef,
    setParam,
    markUser,
    getParam,
    pushRender,
    scheduleBake,
    switchTab,
    renderStockThumbs,
    renderStyleThumbs,
    switchView,
    setViewMode,
    loadSampleFrame,
    applyMatrixRef,
    pickFilterTag,
    setTagFilter,
    applyStockFilter,
    applyParamFilter,
    refreshRecipeList,
    currentRecipe,
    currentCube,
    showCubeHint,
    rangeLabel,
    smokeLog,
    smokeLines,
    bake,
    renderer,
    canvasEl: () => canvas,
    lastBakeMs: () => lastBakeMs,
    lutReady: () => !!lutCurrent,
  };
}

/* ================= R10 性能基线：拖动会话 =================
 * 度量「拖动一个 look 滑杆 N 次」期间的主线程同步工作量：
 *   - 每次事件的帧内工作量（renderer.apply + render）
 *   - 期间发生的 LUT 烘焙次数与耗时（当前实现：look 在 LUT 里 → 拖动会触发重烘）
 * 为什么用「同步工作量」而不是墙钟帧间隔：E2E 用 --virtual-time-budget 跑无头 Chromium，
 * 墙钟被虚拟时间快进，帧间隔不可比；同步工作量只依赖真实 CPU 时间，跨版本可比。
 */
interface PerfSession {
  events: number; frameWork: number[]; renderWork: number[]; handlerMs: number[]; applyWork: number[];
  bakeCount: number; bakeMsTotal: number; bakeMs: number[];
  t0: number; t1: number;
}
let perfSession: PerfSession | null = null;

const percentile = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return a[i];
};

/** 模拟拖动某个滑杆 n 次：每次改值 + dispatch input，然后等一帧 */
async function perfDrag(selector: string, n: number): Promise<void> {
  const el = document.querySelector<HTMLInputElement>(selector);
  if (!el) { setMeta({ perf: { error: '找不到滑杆 ' + selector } }); return; }
  const min = Number(el.min || 0);
  const max = Number(el.max || 1);
  const base = Number(el.value || (min + max) / 2);
  /* R17：烘焙探针（GPU 优先 / 回退 CPU），路径与耗时随 perf meta 上报。
   * 探针不经 bake()（不触碰 bakeCount/voxelsBaked/lutCurrent），R10-1「拖动期间零烘焙」判据不受影响。 */
  const probe = await (await ensureR17()).bakeProbeOnce(r17ctx());
  perfSession = { events: 0, frameWork: [], renderWork: [], handlerMs: [], applyWork: [], bakeCount: 0, bakeMsTotal: 0, bakeMs: [], t0: 0, t1: 0 };
  perfCollect = true;
  perfFrameWork = [];
  perfRenderWork = [];
  bakeCount = 0; bakeMsTotal = 0; bakeMsSamples = [];
  voxelsBaked = 0; bakesByKind = {};
  perfSession.t0 = performance.now();
  const bakeCountBefore = bakeCount;
  try {
    for (let i = 0; i < n; i++) {
      const v = min + (max - min) * (0.5 + 0.45 * Math.sin(i * 0.7));
      el.value = String(v);
      /* 度量口径：事件处理链的同步耗时（state 更新 + pushRender）+ 该事件期间发生的烘焙耗时。
       * 为什么等 setTimeout 而不是 rAF：无头 Chromium 用 --virtual-time-budget 跑，
       * 定时器会被虚拟时间推进、rAF 与渲染帧不稳定；同步工作量口径跨版本可比（见 tools/perf-baseline.mjs）。 */
      const e0 = performance.now();
      el.dispatchEvent(new Event('input', { bubbles: true }));
      const handlerMs = performance.now() - e0;
      await new Promise<void>((r) => setTimeout(r, 16));
      perfSession.events++;
      /* 拆分诊断：handlerMs = 事件处理链同步耗时；applyWork = 期间 rAF 帧内 apply 耗时 */
      const applyWork = perfFrameWork.reduce((a, b) => a + b, 0) || 0;
      perfSession.handlerMs.push(handlerMs);
      perfSession.applyWork.push(applyWork);
      perfSession.frameWork.push(handlerMs + applyWork);
      perfSession.renderWork.push(perfRenderWork.reduce((a, b) => a + b, 0) || 0);
      perfFrameWork = [];
      perfRenderWork = [];
      perfSession.bakeMs.push(bakeMsTotal);
      bakeMsTotal = 0;
    }
  } catch (err) {
    setMeta({ perf: { error: 'perfDrag 异常：' + (err as Error).message } });
    perfCollect = false;
    return;
  }
  // 收尾：等烘焙 debounce（120ms / 600ms）落地，把拖动后的烘焙成本也计进来
  await new Promise<void>((r) => setTimeout(r, 800));
  perfSession.t1 = performance.now();
  perfCollect = false;
  const s = perfSession;
  const bakes = bakeCount - bakeCountBefore;
  const totalBakeMs = bakeMsSamples.reduce((a, b) => a + b, 0);
  /* 每次事件的同步工作量 = 该次事件的帧工作量 + 该次事件期间发生的烘焙耗时 */
  const perEvent = s.frameWork.map((w, i) => w + (s.bakeMs[i] ?? 0));
  const wall = s.t1 - s.t0;
  setMeta({
    perf: {
      events: s.events,
      selector,
      bakeCount: bakes,
      voxelsBaked,
      bakesByKind,
      bakeMsTotal: +totalBakeMs.toFixed(2),
      bakeMsP50: +percentile(bakeMsSamples, 50).toFixed(2),
      bakeMsP95: +percentile(bakeMsSamples, 95).toFixed(2),
      frameWorkP50: +percentile(s.frameWork, 50).toFixed(3),
      frameWorkP95: +percentile(s.frameWork, 95).toFixed(3),
      applyMsP50: +percentile(s.frameWork, 50).toFixed(3),
      applyMsP95: +percentile(s.frameWork, 95).toFixed(3),
      renderMsP50: +percentile(s.renderWork, 50).toFixed(3),
      renderMsP95: +percentile(s.renderWork, 95).toFixed(3),
      /* R10-B 诊断：事件处理链与 rAF 帧内 apply 拆开看，定位 p95 尖峰来源 */
      handlerMsP50: +percentile(s.handlerMs, 50).toFixed(3),
      handlerMsP95: +percentile(s.handlerMs, 95).toFixed(3),
      handlerMsMax: +Math.max(0, ...s.handlerMs).toFixed(3),
      applyWorkP95: +percentile(s.applyWork, 95).toFixed(3),
      perEventWorkP50: +percentile(perEvent, 50).toFixed(3),
      perEventWorkP95: +percentile(perEvent, 95).toFixed(3),
      perEventWorkMean: +(perEvent.reduce((a, b) => a + b, 0) / Math.max(1, perEvent.length)).toFixed(3),
      wallMs: +wall.toFixed(1),
      backend: renderer.backendLabel(),
      /* R10-B：拖动会话期间的质量档与 worker 路径（验收/诊断） */
      rtScale: renderer.quality.rtScale,
      rtScaleReason: renderer.quality.reason,
      workerLut: lutClient.usingWorker,
      /* R17：烘焙路径（gpu/cpu-fallback，探针实测）与耗时（只上报不设门——SwiftShader 的
       * GPU 数字不代表真实收益）+ 预览最近一次烘焙路径（meta 可观察回退事实） */
      bakeProbe: { path: probe.path, size: 65, ms: probe.ms, format: probe.format },
      lutBakePath: lastBakePath,
      lutBakeFormat: lastBakeFormat,
    },
  });
  document.title = 'PERF DONE';
}

function applyHash(): void {
  const hash = new URLSearchParams(location.hash.slice(1));
  const q = (k: string): string | null => hash.get(k);
  buildParamPanel();
  buildRefUI();
  buildMatrixUI();
  updateSplitUI();
  refreshAll();
  refreshRecipeList();

  const demo = q('demo');
  const src = q('src') ?? (demo ? 'neon' : null);
  if (src && ['neon', 'dusk', 'chart'].includes(src)) loadSampleFrame(src as SceneId);
  const ref = q('ref');
  if (ref) {
    const [kind, id] = ref.split(':');
    const entry = kind === 'stock'
      ? stockCards().find((s) => s.id === 'stock_' + id)
      : kind === 'style'
        ? styleCards().find((s) => s.id === 'style_' + id)
        : findEntry(id);
    if (entry) selectRef(entry);
    if (kind === 'stock' || kind === 'style') switchTab(kind);
  }
  if (q('mode')) store.viewMode = (parseInt(q('mode')!, 10) || 0) as ViewMode;
  if (q('freeze')) {
    frozen = true; freezeT = parseFloat(q('t') ?? '') || 0.5;
    /* E2E 确定性：冻结时间时同时关掉 CSS 过渡/动画——抽屉/面板的入场动画会让同一场景
     * 在不同负载下停在不同中间帧（R13 实测 p1-04 画布区曾差 11 级导致假失败）。 */
    document.body.classList.add('fm-freeze');
  }
  if (q('split')) { store.splitX = parseFloat(q('split')!) || 0.5; store.viewMode = 2; }
  setViewMode(store.viewMode);
  if (q('tab')) switchTab(q('tab')!);
  if (q('view')) switchView(q('view')!);
  /* R11：#ui=advanced 强制高级模式（供截图基线/演示；默认简单模式，选择记忆在 localStorage） */
  if (q('ui')) setUiMode(q('ui') === 'advanced' ? 'advanced' : 'simple');
  // 演示/验收场景
  if (demo === 'refs') { $d('g-step2').open = true; $d('g-step3').open = true; if (!store.ref) { const e = allEntries()[0]; if (e) selectRef(e); } }
  /* R20：adjust/split/overlay/groupreset/export/stockwall/styles/presetio 低频演示钩子
   * 迁出到 ui/e2edemos.ts（动态 chunk，gzip 护栏）；语义逐字不变，见该模块。 */
  const demoName = demo ?? '';
  if (['adjust', 'split', 'overlay', 'groupreset', 'export', 'stockwall', 'styles', 'presetio']
    .includes(demoName)) {
    void ensureE2eDemos().then((m) => m.runE2eDemo(demoName, e2eDemoCtx()));
  }
  /* R15 XMP 预设导入演示：页面内合成 3 个 XMP（品牌词名 / 全中性 / 损坏），走与真实按钮相同的
   * importXmpEntries → 断言卡数/清洗名/中性卡参数逐字恒等/点卡应用后配方一致，写 #e2e-meta.xmpImport。
   * &apply=brand：最后再点品牌卡（p8-06 截图：应用后画面可辨的暖调哑光效果）。 */
  if (demo === 'xmpimport') {
    $d('g-step2').open = true;
    ($('panel') as HTMLElement).scrollTop = 0;
    void ensureXmpImport().then((m) => m.demoXmpImport(q('apply') === 'brand'));
  }
  if (demo === 'matrix' || demo === 'matrixstd' || demo === 'tagfilter' || demo === 'import') {
    void ensureE2eDemos().then((m) => m.runE2eDemo(demo, e2eDemoCtx()));
  }
  // F14 批量匹配（ui/batch.ts）：合成测试集 + 逐段 CDL + 统一风格层 + 打包（不下载）
  if (demo === 'batch' || demo === 'batchb' || demo === 'batchsingle') { switchView('batch'); void ensureBatch().then((m) => m.batchDemo(demo)); }
  // R4 DCTL 生成页（动态 import 后调用 demo）/ R5 节点包导出区
  /* R7 单节点演示需要「有统计的参考」才能解算 CDL：型号卡（stock:）没有参考统计，
   * 故这里自动挑一张图库参考（与 #demo=refs 同一路径），让 demo 自洽。 */
  if (demo === 'dctl-match' && !store.ref) {
    const e = allEntries()[0];
    if (e) selectRef(e);
  }
  if (demo === 'dctl' || demo === 'dctl-rcm' || demo === 'dctl-stages' || demo === 'dctl-labels' ||
      demo === 'dctl-match') {
    switchView('dctl'); void ensureDctl().then((m) => m.dctlDemo(demo));
  }
  /* R10 性能基线：拖动 look 滑杆 60 次，写 #e2e-meta.perf */
  if (demo === 'perf') {
    const sel = q('drag') === 'match'
      ? '#param-groups details[data-group="color"] input[type=range]'
      : '#param-groups details[data-group="look"] input[type=range]';
    ($d('g-step4') as HTMLDetailsElement).open = true;
    void perfDrag(sel, Math.max(1, parseInt(q('perfEvents') ?? '60', 10) || 60));
  }
  /* R17：烘焙耗时基线（GPU vs CPU/worker 回退，同一配方同一尺寸各 N 次）→ #e2e-meta.bakePerf */
  if (demo === 'bakeperf') void ensureR17().then((m) => m.bakePerfDemo(r17ctx(), parseInt(q('bakeN') ?? '10', 10) || 10));
  /* R17：数据范围（⑤ 区分段开关 + .cube 头部范围声明 + HUD 范围字段）
   * 与 GPU/CPU 烘焙一致性（SwiftShader 下真实跑 GPU 烘焙 vs CPU 烘焙逐点对比）→ rangeCheck/bakeConsistency */
  if (demo === 'range' && store.state) void ensureR17().then((m) => m.rangeDemo(r17ctx(), q('rangeSel')));
  if (demo === 'drx') void ensureDrx().then((m) => m.drxDemo());
  if (demo === 'guide') void ensureGuide().then((m) => m.openGuide());
  if (demo === 'guideoff') void ensureGuide().then((m) => m.closeGuide());
  if (demo === 'annotate') {
    const e = findEntry('lib_neon_fl05') ?? allEntries()[0];
    if (e) void ensureAnnotate().then((m) => m.openAnnotate(e));
  }
  if (demo === 'shareloop' || q('smoke') === '1') {
    void ensureE2eDemos().then(async (m) => {
      const c = e2eDemoCtx();
      if (demo === 'shareloop') m.runE2eDemo('shareloop', c);
      if (q('smoke') === '1') await m.runSmoke(c);
    });
  }
  pushRender();
  refreshAll();
}

void ensureBatch();   // 首屏只加载工作台；批量页按需动态加载（控制首屏体积）
void ensureDrx();     // R5/R12 ⑤ 节点包导出区：懒加载，启动后即初始化（行为同静态 import）
applyHash();
void lastT;
