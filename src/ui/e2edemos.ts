/* E2E/演示钩子集（低频代码，动态 import —— R20 从 main.ts 迁出，给首屏 gzip 让预算）
 *
 * 与 r17demo / xmpimport 同一手法：main.ts 只留一行分发
 *   `void ensureE2eDemos().then((m) => m.runE2eDemo(demo, e2eDemoCtx()))`，
 * 逻辑集中在本模块。页面状态与动作一律经 ctx 访问（不反向 import main，避免循环依赖）；
 * URL 解析、DOM 查询、#e2e-meta 写入在本模块内自足。
 *
 * 覆盖的 #demo：adjust / split / overlay / groupreset / export / stockwall / styles /
 * presetio / matrix / matrixstd / tagfilter / import（其余 demo 仍留在 main.ts）。
 * 语义与迁出前逐字一致（含 meta 字段名），E2E 断言不受影响。
 */
import { encodeFull, decodeFull } from '../share/code';
import { cloneParams, defaultLook, getPreset, type ViewMode } from '../film/params';
import type { TextureProfileRef } from '../film/grainmatrix';
import type { EffectRenderer } from '../film/pipeline';
import { allEntries, findEntry, stockCards, type LibraryEntry, type SceneId } from './library';
import { buildRecipe, recipeToState, shareCodeOf, type Recipe } from './recipe';
import * as storage from './storage';
import { initRecipeState, store } from './store';
import { GROUPS, type SpecGroup } from './paramui';
import { setMeta } from './e2emeta';

/** main.ts 页面动作面（窄接口；实现见 main.ts e2eDemoCtx()） */
export interface E2eDemoCtx {
  selectRef(e: LibraryEntry): void;
  setParam(g: SpecGroup, k: string, v: number): void;
  markUser(key: string): void;
  getParam(g: SpecGroup, k: string): number;
  pushRender(): void;
  scheduleBake(affectsMatch?: boolean): void;
  switchTab(tab: string): void;
  renderStockThumbs(): void;
  renderStyleThumbs(): void;
  switchView(v: string): void;
  setViewMode(m: ViewMode): void;
  loadSampleFrame(scene: SceneId): void;
  applyMatrixRef(ref: TextureProfileRef): void;
  pickFilterTag(): string;
  setTagFilter(tag: string | null): void;
  applyStockFilter(): number;
  applyParamFilter(): void;
  refreshRecipeList(): void;
  currentRecipe(): Recipe | null;
  currentCube(): Promise<{ text: string; code: string; size: number }>;
  showCubeHint(msg: string): void;
  rangeLabel(): string;
  /* —— P1 smoke / shareloop 专用（写 #smokelog / 像素回路）—— */
  smokeLog(line: string): void;
  smokeLines: string[];
  bake(size: 33 | 65): void;
  renderer: EffectRenderer;
  canvasEl(): HTMLCanvasElement;
  lastBakeMs(): number;
  lutReady(): boolean;
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const $d = (id: string): HTMLDetailsElement => document.getElementById(id) as HTMLDetailsElement;
const q = (k: string): string | null => new URLSearchParams(location.hash.slice(1)).get(k);

/** 逐一执行迁出的 demo 钩子（main.ts 按 demo 名分发到这里；未命中 = 无操作） */
export function runE2eDemo(demo: string, ctx: E2eDemoCtx): void {
  if (demo === 'adjust' && store.state) {
    const g = GROUPS.find((x) => x.id === 'halation')!;
    ctx.setParam(g, 'amount', 0.85); ctx.markUser('halation.amount');
    $d('g-step4').open = true;
    const hg = document.querySelector<HTMLDetailsElement>('details[data-group="halation"]');
    if (hg) hg.open = true;
    ctx.scheduleBake(false);
  }
  if (demo === 'split' && store.state) { ctx.setViewMode(2); $d('g-step4').open = true; }
  /* R16 对比浮层演示：浮层/④入口两处分段控件状态 + HUD 快照写 meta（E2E 同步断言），
   * 并做一次「英文组名搜索」自检（命中组保持展开可见，检完还原，不影响截图）。 */
  if (demo === 'overlay') {
    $d('g-step4').open = true;
    const segState = (sel: string): Record<string, boolean> => {
      const out: Record<string, boolean> = {};
      for (const b of document.querySelectorAll<HTMLButtonElement>(sel + ' .seg-btn')) {
        out['m' + b.dataset.mode] = b.classList.contains('on');
      }
      return out;
    };
    const payload: Record<string, unknown> = {
      viewHud: { modes: segState('#viewhud'), panel: segState('#seg-view'), viewMode: store.viewMode },
      hud: {
        code: store.state ? shareCodeOf(store.state) : null,
        ref: store.ref?.label ?? null,
        /* R17：数据范围从「--」占位改为当前配方 range（Full/Legal）——有意变更，R16-3 断言同步更新 */
        range: ctx.rangeLabel(),
        hidden: ($('hud') as HTMLElement).hidden,
      },
    };
    const sb = document.getElementById('param-search') as HTMLInputElement | null;
    if (sb) {
      sb.value = 'grain';   // 「颗粒」组的英文名（R16 搜索支持组名）
      ctx.applyParamFilter();
      const det = document.querySelector<HTMLDetailsElement>('details[data-group="grain"]');
      payload.groupSearch = { q: 'grain', visible: !!det && !det.hidden, open: !!det && det.open };
      sb.value = '';
      ctx.applyParamFilter();
    }
    setMeta(payload);
  }
  /* R16 组级重置演示：改「复古褪色」组（fade 0.55 / 饱和 0.35 / 冷偏 -0.6，同组多字段）
   * → 截图前状态；&reset=1 时点「重置本组」→ 截图后状态（数值与 origin 都应回到初始）。
   * 选 look 组是因为它的画面变化量级大（像素断言可靠）；光晕是 screen 叠加、同帧差异太弱。 */
  if (demo === 'groupreset' && store.state && store.initial) {
    $d('g-step4').open = true;
    const lg = document.querySelector<HTMLDetailsElement>('details[data-group="look"]');
    if (lg) lg.open = true;
    const g = GROUPS.find((x) => x.id === 'look')!;
    const iniLook = store.initial.look;
    ctx.setParam(g, 'fade', 0.55);
    ctx.setParam(g, 'saturation', 0.35);
    ctx.setParam(g, 'warmth', -0.6);
    ctx.markUser('look.fade');
    ctx.markUser('look.saturation');
    ctx.markUser('look.warmth');
    ctx.pushRender();
    const ini = iniLook as unknown as { fade: number; saturation: number };
    const base = {
      group: 'look',
      initial: { fade: ini.fade, saturation: ini.saturation },
      btn: !!document.querySelector('#param-groups details[data-group="look"] button.greset'),
    };
    if (q('reset') === '1') {
      const btn = document.querySelector<HTMLButtonElement>('#param-groups details[data-group="look"] button.greset');
      btn?.click();
    }
    setMeta({ groupReset: {
      ...base,
      phase: q('reset') === '1' ? 'after' : 'before',
      resetClicked: q('reset') === '1',
      current: { fade: ctx.getParam(g, 'fade'), saturation: ctx.getParam(g, 'saturation') },
      origin: store.state.origins['look.fade'] ?? null,
    } });
  }
  if (demo === 'export' && store.state) {
    $d('g-step5').open = true;
    void ctx.currentCube().then(({ text, code }) => {
      ctx.showCubeHint(`（演示）${code}.cube 就绪：${(text.length / 1024).toFixed(0)} KB 文本，65³ 网格。点击「下载 .cube」保存，或用支持的浏览器直写达芬奇 LUT 目录。`);
    });
  }
  // P1 E2E/演示场景
  if (demo === 'stockwall') {
    $d('g-step1').open = false;
    $d('g-step2').open = true;
    ($('panel') as HTMLElement).scrollTop = 0;
    ctx.switchTab('stock');
    ctx.renderStockThumbs();
    const rects: Array<{ id: string; x: number; y: number; w: number; h: number }> = [];
    for (const img of Array.from(document.querySelectorAll<HTMLImageElement>('#stock-grid .card img'))) {
      const r = img.getBoundingClientRect();
      rects.push({ id: img.closest('.card')!.getAttribute('data-id') ?? '', x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    }
    setMeta({ stockwall: { count: rects.length, rects } });
  }
  /* R8 风格卡片墙演示：写 #e2e-meta.styles = { count, ids, rects }（供 E2E 断言，写法同 stockwall）。
   * R19 起 tab 顶部的分组 chips 由动态 chunk 异步插入（下方内容整体下移），坐标必须在
   * 模块就位、布局稳定后采集——否则 E2E 按旧 rect 裁剪缩略图会错位（R8-2 假失败）。
   * R20：本模块自身也是动态 chunk，chips（xmpimport）与坐标采集仍按「就位后采集」串行。 */
  if (demo === 'styles') {
    $d('g-step1').open = false;
    $d('g-step2').open = true;
    ($('panel') as HTMLElement).scrollTop = 0;
    ctx.switchTab('style');
    ctx.renderStyleThumbs();
    void import('./xmpimport').then(() => {
      const ids: string[] = [];
      const rects: Array<{ id: string; x: number; y: number; w: number; h: number }> = [];
      for (const img of Array.from(document.querySelectorAll<HTMLImageElement>('#style-grid .card img'))) {
        const r = img.getBoundingClientRect();
        const id = img.closest('.card')!.getAttribute('data-id') ?? '';
        ids.push(id);
        rects.push({ id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
      }
      setMeta({ styles: { count: rects.length, ids, rects } });
    });
  }
  /* R8 预设导入/导出演示：导出→导入回环逐位一致 + 本地存卡 + 坏文件被拒（写 #e2e-meta.presetIO） */
  if (demo === 'presetio') {
    $d('g-step5').open = true;
    ($d('g-import') as HTMLDetailsElement).open = true;
    const entry = stockCards().find((s) => s.id === 'stock_fl05') ?? stockCards()[0];
    if (entry && !store.state) ctx.selectRef(entry);
    const result = {
      ok: false, code: '', schemaVersion: 0, fields: 0, roundTrip: false,
      saved: 0, badRejected: false, badError: '',
    };
    const r = ctx.currentRecipe();
    if (r) {
      const text = storage.serializeRecipe(r);
      const back = storage.parseRecipe(text);
      result.roundTrip = JSON.stringify(back) === JSON.stringify(r);
      result.code = r.share_code;
      result.schemaVersion = r.schema_version as number;
      result.fields = Object.keys(r.color.look).length;
      storage.saveRecipe(r);
      storage.registerCode(r.share_code, r.id);
      result.saved = storage.listRecipes().length;
      ctx.refreshRecipeList();
      // 坏文件：不支持的版本必须被拒（可读错误而非崩）
      try {
        storage.parseRecipe(JSON.stringify({ ...r, schema_version: 3 }));
      } catch (e) {
        result.badRejected = true;
        result.badError = (e as Error).message;
      }
      result.ok = result.roundTrip && result.badRejected;
    }
    setMeta({ presetIO: result });
  }
  // R2 矩阵档位对比 / 标签筛选演示
  if (demo === 'matrix' || demo === 'matrixstd') {
    // 同一帧（校色卡）上应用两个差异显著的档位，供截图差异断言
    if (!q('src')) ctx.loadSampleFrame('chart');
    const entry = stockCards().find((s) => s.id === 'stock_fl06');
    if (entry) ctx.selectRef(entry);
    const ref: TextureProfileRef = demo === 'matrix'
      ? { grain: 'g-8-500', halation: 'noremjet' }
      : { grain: 'g-65-50', halation: 'std' };
    ctx.applyMatrixRef(ref);
    $d('g-step2').open = true;
    ($('panel') as HTMLElement).scrollTop = 0;
    ctx.switchTab('stock');
    setMeta({ matrix: { grain: ref.grain, halation: ref.halation } });
  }
  if (demo === 'tagfilter') {
    if (!q('src')) ctx.loadSampleFrame('chart');
    const first = stockCards()[0];
    if (first && !store.ref) ctx.selectRef(first);
    $d('g-step2').open = true;
    ($('panel') as HTMLElement).scrollTop = 0;
    ctx.switchTab('stock');
    ctx.renderStockThumbs();
    const tag = ctx.pickFilterTag();
    ctx.setTagFilter(tag);
    const count = ctx.applyStockFilter();
    setMeta({ tagFilter: { tag, count } });
  }
  if (demo === 'import') {
    $d('g-step5').open = true;
    ($d('g-import') as HTMLDetailsElement).open = true;
    // 示例完整码：从 FL-05 型号卡派生的配方（无统计直出）
    const card = getPreset('fl05');
    const st = initRecipeState({ kind: 'stock', neutralMatch: true, look: card.params.look, texture: card.params.texture, origins: { ...card.origins }, refStats: null });
    const demoRecipe = buildRecipe({ name: '示例 · FL-05 光匣', sourceType: 'stock', refImageId: null, stockId: 'fl05', state: st });
    const box = $('codebox') as HTMLTextAreaElement;
    box.value = encodeFull(demoRecipe);
    box.textContent = box.value; // dump-dom 序列化的是默认值（子文本），一并写入
    setMeta({ demoCodeLen: box.value.length });
  }
  if (demo === 'shareloop') runShareLoop(ctx);
}

/* ================= P1 E2E：F11 完整码导入回路（迁出自 main.ts，语义不变） =================
 * 导出完整码 → decode → 重渲染，画面前后像素必须一致；损坏码必须被拒。
 * 结果写 smokelog + #e2e-meta（tools/e2e-verify.mjs 断言）。 */
const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

function canvasPixels(cv: HTMLCanvasElement): Uint8ClampedArray {
  const c2 = document.createElement('canvas');
  c2.width = cv.width;
  c2.height = cv.height;
  c2.getContext('2d')!.drawImage(cv, 0, 0);
  return c2.getContext('2d')!.getImageData(0, 0, c2.width, c2.height).data;
}
function meanDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 4) s += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
  return s / (a.length / 4);
}
function runShareLoop(ctx: E2eDemoCtx): void {
  try {
    ctx.smokeLog('SHARELOOP 开始（F11 导出完整码→解码→重渲染）');
    ctx.loadSampleFrame('neon');
    const entry = findEntry('lib_neon_fl05') ?? allEntries()[0];
    ctx.selectRef(entry);
    ctx.bake(65);
    ctx.pushRender();
    ctx.renderer.render(0.5); // 固定颗粒相位，保证前后可精确对比
    const before = canvasPixels(ctx.canvasEl());
    const recipe = ctx.currentRecipe();
    if (!recipe) throw new Error('配方未生成');
    const full = encodeFull(recipe);
    const back = decodeFull(full);
    if (!back) throw new Error('自产完整码解码失败');
    // 篡改 payload 中部一个字符 → 必须被校验和拦截
    const mid = 4 + 2 + Math.floor((full.length - 6) / 2);
    const tampered = full.slice(0, mid) + (full[mid] === 'A' ? 'B' : 'A') + full.slice(mid + 1);
    const rejected = decodeFull(tampered) === null;
    // 解码 → 重渲染
    const st = recipeToState(back as unknown as Recipe);
    store.state = st;
    store.initial = {
      ...st,
      colorParams: { ...st.colorParams },
      look: { ...st.look },
      texture: cloneParams({ texture: st.texture, look: defaultLook(), master: 1 }).texture,
      origins: { ...st.origins },
    };
    store.recipeId = back.id as string;
    ctx.bake(65);
    ctx.pushRender();
    ctx.renderer.render(0.5);
    const after = canvasPixels(ctx.canvasEl());
    const diff = meanDiff(before, after);
    const pass = diff === 0 && rejected;
    ctx.smokeLog(`[SHARELOOP] 完整码 ${full.length}B decode=OK 画面前后平均差=${diff.toFixed(4)}（期望 0）损坏拦截=${rejected ? 'OK' : 'FAIL'}`);
    ctx.smokeLog(`SHARELOOP ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
    setMeta({ shareLoop: { diff, rejected, codeLen: full.length, pass } });
    document.title = pass ? 'SHARELOOP PASS' : 'SHARELOOP FAIL';
  } catch (err) {
    ctx.smokeLog('SHARELOOP FAIL: ' + (err as Error).message);
    setMeta({ shareLoop: { pass: false, error: (err as Error).message } });
    document.title = 'SHARELOOP FAIL';
  }
}

/** P1 E2E 冒烟（#smoke=1）：传帧→图库→调参→导出→保存/载入 roundtrip（迁出自 main.ts，语义不变） */
export async function runSmoke(ctx: E2eDemoCtx): Promise<void> {
  try {
    ctx.smokeLog('SMOKE 开始（端到端：传帧→图库→调参→导出）');
    ctx.loadSampleFrame('neon');
    await sleep(300);
    ctx.smokeLog(`① 示例帧 OK：${store.frame?.canvas.width}×${store.frame?.canvas.height} 统计样本=${store.frame?.stats.samples}`);
    const entry = findEntry('lib_neon_fl05') ?? allEntries()[0];
    ctx.selectRef(entry);
    await sleep(400);
    const code = shareCodeOf(store.state!);
    ctx.smokeLog(`② 选图库 ${entry.id} → 配方 ${store.recipeId} 码=${code} LUT烘焙=${ctx.lastBakeMs().toFixed(0)}ms lutReady=${ctx.lutReady()}`);
    // 模拟用户拖动滑杆（走同一交互路径）→ origin 变 user
    const g = GROUPS.find((x) => x.id === 'halation')!;
    ctx.setParam(g, 'amount', 0.85);
    ctx.markUser('halation.amount');
    ctx.scheduleBake(false);
    await sleep(300);
    ctx.smokeLog(`④ 滑杆 halation.amount=0.85 origin=${store.state?.origins['halation.amount']}（期望 user）`);
    // 导出 .cube（下载兜底路径）
    const { text, code: c2 } = await ctx.currentCube();
    storage.exportFile(`${c2}.cube`, text, 'text/plain');
    ctx.smokeLog(`⑤ .cube 兜底导出 ${text.length}B LUT_3D_SIZE=${text.match(/LUT_3D_SIZE (\d+)/)?.[1]} 数据行=${text.split('\n').length - 5}`);
    // 保存/载入
    const r = ctx.currentRecipe()!;
    storage.saveRecipe(r);
    storage.registerCode(r.share_code, r.id);
    const back = storage.loadRecipe(r.id);
    const backTex = back ? (back as unknown as { texture?: { grain?: { iso?: { value?: number } } } }).texture : undefined;
    ctx.smokeLog(`⑤ 保存→载入 roundtrip ${back ? 'OK' : 'FAIL'} 纹理iso=${JSON.stringify(backTex?.grain?.iso?.value)}`);
    ctx.smokeLines.unshift('SMOKE PASS ✅');
    $('smokelog').textContent = ctx.smokeLines.join('\n');
    document.title = 'SMOKE PASS';
  } catch (err) {
    ctx.smokeLog('SMOKE FAIL: ' + (err as Error).message);
    document.title = 'SMOKE FAIL';
  }
}
