/**
 * R4 · DCTL 生成页控制器（渲染进 index.html 的 #dctl-page）。
 *
 * 工作流：选配方（当前工作台配方 / fl01..fl10 型号卡）→ 选管线（YRGB / RCM / ACES 预留）
 *        → 「生成 .dctl」→ 展示参数面板声明数 / warnings / 源码预览 / 静态校验 →
 *        下载 .dctl（storage.exportFile）。
 *
 * 一致性核验（R4 验收要求）：并排两个小画布，把同一张采样色卡分别经
 *   左：现有 gamma 空间 look（logmath.gammaLook，镜像 pipeline.GRADE_FS 非 LUT 分支）
 *   右：归一化对数域 look（tfEncode → applyLogLook → tfDecode）
 * 处理后用 putImageData 自绘；再对 N≥64 个采样色点做数值化差异（0..255 级分量差 + ΔE76）。
 *
 * 纯依赖已冻结的 dctl/* 接口；本模块只做 DOM 装配、状态编排与 #e2e-meta 上报。
 * 多视图懒加载：由 main.ts 动态 import（DCTL 数学/生成器不进首屏包）。
 */
import { rgbToLab, deltaE76 } from '../engine/color';
import type { RGB } from '../engine/types';
import { generateDctl, validateDctl, type DctlGenResult } from '../dctl/codegen';
import {
  PIPELINES, anchorsForPipeline, applyLogLook, gammaLook, lookToLogLook, tfDecode, tfEncode,
  type LogLookParams, type PipelineTF,
} from '../dctl/logmath';
import { DCTL_SAMPLES, LABEL_SPIKE_SAMPLES, MATCH_SAMPLES, buildLabelSpike, buildMatchSample, buildSample } from '../dctl/samples';
import { fitCdl, type Cdl } from '../batch/cdl';
import { matchApproxReport, quantilesFromImageStats, type MatchApproxReport } from '../dctl/inlinecdl';
import {
  cloneParams, getPreset, STOCK_IDS,
  type CardAnchorsT, type LookParams, type PresetCard, type TextureParams,
} from '../film/params';
import { defaultColorParams, shareCodeOf, type RecipeState } from './recipe';
import { store } from './store';
import { setMeta } from './e2emeta';
import * as storage from './storage';

interface DctlDeps {
  toast: (m: string) => void;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const PRESET_IDS: readonly string[] = STOCK_IDS;

/* ================= 一致性核验：采样色卡 =================
 * 画布上绘「灰阶 11 级 + 24 色块」共 35 块；数值核验在 35 块之外再补 4×4×4 RGB 网格（64），
 * 合计 99 个采样色点（满足 N≥64）。 */

const CHART_W = 320;
const CHART_H = 180;
const GRAY_LEVELS = 11;

function hslToRgb(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

/** 色卡贴块（灰阶 11 + 色块 24 = 35）：既用于画布自绘 */
const CHART_PATCHES: RGB[] = (() => {
  const out: RGB[] = [];
  for (let i = 0; i < GRAY_LEVELS; i++) {
    const v = i / (GRAY_LEVELS - 1);
    out.push([v, v, v]);
  }
  for (const h of [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]) {
    out.push(hslToRgb(h, 0.75, 0.55));
    out.push(hslToRgb(h, 0.5, 0.3));
  }
  return out;
})();

/** 数值核验采样点：35 贴块 + 4×4×4 RGB 网格（64）= 99 */
const SAMPLE_POINTS: RGB[] = (() => {
  const out: RGB[] = CHART_PATCHES.map((p) => [p[0], p[1], p[2]] as RGB);
  const step = [0, 0.33, 0.66, 1];
  for (const r of step) for (const g of step) for (const b of step) out.push([r, g, b]);
  return out;
})();

interface Consistency {
  samples: number;
  meanAbs: number;   // 平均分量差（0..255 级）
  maxAbs: number;    // 最大分量差（0..255 级）
  meanDE: number;    // 平均 ΔE76
}

/** gamma 空间 look：直接作用于显示编码 */
function applyGammaLook(rgb: RGB, look: LookParams): RGB {
  return gammaLook(rgb, look);
}

/** 对数域 look：显示编码 → 归一化对数域 → look → 回显示编码 */
function applyLogDomainLook(rgb: RGB, tf: PipelineTF, log: LogLookParams): RGB {
  const enc: RGB = [tfEncode(tf, rgb[0]), tfEncode(tf, rgb[1]), tfEncode(tf, rgb[2])];
  const out = applyLogLook(enc, log);
  return [tfDecode(tf, out[0]), tfDecode(tf, out[1]), tfDecode(tf, out[2])];
}

/** 把色卡按 apply 处理后用 putImageData 自绘到画布（320×180） */
function drawChart(canvas: HTMLCanvasElement, apply: (rgb: RGB) => RGB): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(CHART_W, CHART_H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = 10; d[i + 1] = 9; d[i + 2] = 8; d[i + 3] = 255; }
  const rect = (x: number, y: number, w: number, h: number, c: RGB): void => {
    const R = Math.round(clamp01(c[0]) * 255);
    const G = Math.round(clamp01(c[1]) * 255);
    const B = Math.round(clamp01(c[2]) * 255);
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        if (xx < 0 || xx >= CHART_W || yy < 0 || yy >= CHART_H) continue;
        const i = (yy * CHART_W + xx) * 4;
        d[i] = R; d[i + 1] = G; d[i + 2] = B; d[i + 3] = 255;
      }
    }
  };
  // 顶行：灰阶 11 级
  const gw = Math.floor((CHART_W - 4) / GRAY_LEVELS);
  for (let i = 0; i < GRAY_LEVELS; i++) rect(2 + i * gw, 8, gw - 2, 50, apply(CHART_PATCHES[i]));
  // 两行：24 色块（12×2）
  const cw = Math.floor((CHART_W - 4) / 12);
  for (let i = 0; i < 24; i++) {
    const row = Math.floor(i / 12);
    const col = i % 12;
    rect(2 + col * cw, 66 + row * 56, cw - 2, 48, apply(CHART_PATCHES[GRAY_LEVELS + i]));
  }
  ctx.putImageData(img, 0, 0);
}

/** 数值核验：同一组 look 下，gamma 空间 vs 对数域，N≥64 采样点的分量差与 ΔE76。
 *  R18：带锚点时对数域 look 先按目标管线锚点重标定（与 generate 同一口径）。 */
function measureConsistency(look: LookParams, tf: PipelineTF, anchors?: CardAnchorsT): Consistency {
  const log = lookToLogLook(look, tf, anchorsForPipeline(anchors, tf));
  let sum = 0;
  let max = 0;
  let sumDE = 0;
  for (const p of SAMPLE_POINTS) {
    const a = applyGammaLook(p, look);
    const b = applyLogDomainLook(p, tf, log);
    const d = (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3 * 255;
    sum += d;
    if (d > max) max = d;
    const la = rgbToLab(a[0], a[1], a[2]);
    const lb = rgbToLab(b[0], b[1], b[2]);
    sumDE += deltaE76(la[0], la[1], la[2], lb[0], lb[1], lb[2]);
  }
  const n = SAMPLE_POINTS.length;
  return {
    samples: n,
    meanAbs: +(sum / n).toFixed(2),
    maxAbs: +max.toFixed(2),
    meanDE: +(sumDE / n).toFixed(2),
  };
}

/* ================= 配方选择 ================= */

interface Selection {
  id: string;          // 'workbench' 或 fl01..fl10
  name: string;
  shareCode: string;
  look: LookParams;
  texture: TextureParams;
  fromWorkbench: boolean;
  /** R18：按管线锚点（卡或工作台配方携带；可选）。切管线时用于重标定 look（语义不漂移） */
  anchors?: CardAnchorsT;
  /** R21：质感总强度（工作台配方携带；卡恒 1）。透传 generateDctl → FM_MASTER 默认值 */
  master: number;
}

/** 无工作台状态时，用型号卡的 look+texture 构造临时配方运行时状态（只取 hash 需要的字段） */
function tempState(card: PresetCard): RecipeState {
  return {
    colorParams: defaultColorParams(true),
    look: { ...card.params.look },
    texture: cloneParams(card.params).texture,
    master: 1,
    origins: { ...card.origins },
    refStats: null,
    userStats: null,
    profile: card.profile,
  };
}

/* ================= 模块状态 ================= */

let deps: DctlDeps = { toast: () => {} };
let selected = 'workbench';
let pipeline: PipelineTF = 'yrgb';
/** R6/R14：标签模式。中英混排 + tooltip 已于 2026-09-23 实机验证通过 → 默认开启 */
let labelMode: 'bilingual' | 'ascii' = 'bilingual';
let groupPrefix = true;
let tooltips = true;
/** R14：开关形态。0/1 滑杆已实机验证（默认）；勾选框形态尚未实机验证。
 *  true = 传 compat:true 的开关写法（DCTLUI_SLIDER_FLOAT 0..1），false = DCTLUI_CHECK_BOX。 */
let boolSlider = true;
/** R6：分层导出——只勾选要导出的质感层（色彩层恒导出） */
const stages = { halation: true, bloom: true, grain: true, vignette: true, gate_weave: true };
/** R7：内联 CDL 匹配段（单节点导出）。默认关——不内联时产物与 R6 逐字节一致 */
let matchOn = false;
let lastMatchReport: MatchApproxReport | null = null;
let lastResult: DctlGenResult | null = null;
let lastValid: { ok: boolean; errors: string[] } | null = null;
let lastConsistency: Consistency | null = null;
let lastSelection: Selection | null = null;
let ready = false;

let elPreset: HTMLSelectElement | null = null;
let elCards: HTMLElement | null = null;
let elRecipe: HTMLElement | null = null;
let elPipe: HTMLElement | null = null;
let elSummary: HTMLElement | null = null;
let elWarn: HTMLElement | null = null;
let elValid: HTMLElement | null = null;
let elSrc: HTMLElement | null = null;
let elDl: HTMLButtonElement | null = null;
let elCons: HTMLElement | null = null;
let cvGamma: HTMLCanvasElement | null = null;
let cvLog: HTMLCanvasElement | null = null;

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

/** 质感层的中文名（面板与摘要共用） */
const LAYER_CN: Record<'halation' | 'bloom' | 'grain' | 'vignette' | 'gate_weave', string> = {
  halation: '光晕', bloom: '柔光', grain: '颗粒', vignette: '暗角', gate_weave: '片门抖动',
};

/** 把模块状态回写到面板控件（模式切换/一键按钮后调用，避免控件与状态不一致） */
function syncPanelOpts(): void {
  const set = (id: string, v: boolean): void => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.checked = v;
  };
  set('dctl-groupprefix', groupPrefix);
  set('dctl-tooltips', tooltips);
  const sw = document.getElementById('dctl-switchform') as HTMLSelectElement | null;
  if (sw) sw.value = boolSlider ? 'slider' : 'checkbox';
  for (const k of ['halation', 'bloom', 'grain', 'vignette', 'gate_weave'] as const) set(`dctl-stage-${k}`, stages[k]);
}

const DCTL_CSS = `
.dctl-cards{display:grid; grid-template-columns:repeat(5,1fr); gap:6px; margin:6px 0}
.dctl-card{padding:6px 4px; border:1px solid var(--line); border-radius:5px; background:var(--panel2);
  color:var(--dim); font-size:var(--fs-sm); cursor:pointer; text-align:center; line-height:1.4}
.dctl-card:hover{border-color:var(--amber); color:var(--amber2)}
.dctl-card.on{border-color:var(--amber); background:var(--amber-a12); color:var(--amber2); font-weight:600}
.dctl-recipe{font-size:var(--fs-md); color:var(--text); line-height:1.9}
.dctl-recipe .k{color:var(--dim); display:inline-block; width:64px}
.dctl-recipe .code{color:var(--amber2); font-weight:700; letter-spacing:1px}
.dctl-pipes{display:flex; gap:6px; margin:6px 0; flex-wrap:wrap}
.dctl-pipe{flex:1; min-width:150px; text-align:left; padding:6px 8px; border:1px solid var(--line);
  border-radius:5px; background:var(--panel2); color:var(--dim); font-size:var(--fs-sm); cursor:pointer; line-height:1.5}
.dctl-pipe:hover{border-color:var(--amber); color:var(--amber2)}
.dctl-pipe.on{border-color:var(--amber); background:var(--amber-a12); color:var(--amber2)}
.dctl-pipe .res{display:inline-block; margin-left:4px; font-size:var(--fs-xs); padding:0 4px; border-radius:6px;
  border:1px solid var(--line); color:var(--dim)}
.dctl-preview{margin:8px 0 4px}
.dctl-src{width:100%; height:190px; background:var(--code-bg); color:var(--code-fg); border:1px solid var(--line);
  border-radius:4px; font:var(--fs-sm)/1.5 var(--font-mono); padding:8px; resize:vertical;
  white-space:pre; overflow:auto}
.dctl-warnings{margin:4px 0 0 16px; color:var(--dim); font-size:var(--fs-sm); line-height:1.7}
.dctl-valid{font-size:var(--fs-md); margin:4px 0}
.dctl-charts{display:flex; gap:10px; flex-wrap:wrap; margin:6px 0}
.dctl-charts figure{margin:0}
.dctl-charts canvas{width:320px; height:180px; border:1px solid var(--line); border-radius:4px;
  background:var(--canvas); display:block; image-rendering:pixelated}
.dctl-charts figcaption{color:var(--dim); font-size:var(--fs-sm); margin-top:3px; text-align:center}
.dctl-consistency{font-size:var(--fs-md); line-height:1.9; color:var(--text)}
.dctl-consistency .k{color:var(--dim); display:inline-block; width:96px}
.dctl-samples{font-size:var(--fs-md); line-height:1.9; color:var(--text)}
.dctl-samples .f{color:var(--amber2); font-family:var(--font-mono)}
.dctl-samples .ok{color:var(--ok)}
.dctl-samples .bad{color:var(--err)}
.dctl-matchgrid{display:grid; grid-template-columns:repeat(5,1fr); gap:4px 8px; margin:6px 0}
.dctl-matchgrid .k{color:var(--dim); font-size:var(--fs-sm); display:block}
.dctl-matchgrid input{width:100%; box-sizing:border-box; background:var(--panel2); color:var(--text);
  border:1px solid var(--line); border-radius:4px; padding:3px 5px;
  font:var(--fs-sm) var(--font-mono)}
.dctl-matchgrid input:focus{border-color:var(--amber); outline:none}
.dctl-loadhint{margin:6px 0; padding:8px 10px; border:1px solid var(--amber); border-left-width:4px;
  border-radius:5px; background:var(--amber-a12); color:var(--text); font-size:var(--fs-sm); line-height:1.7}
.dctl-loadhint b{color:var(--amber2)}
.dctl-loadhint code{font-family:var(--font-mono); color:var(--amber2)}
`;

function injectStyle(): void {
  if (document.getElementById('dctl-style')) return;
  const s = document.createElement('style');
  s.id = 'dctl-style';
  s.textContent = DCTL_CSS;
  document.head.appendChild(s);
}

/* ================= 选择逻辑 ================= */

function currentSelection(): Selection {
  if (selected === 'workbench' && store.state) {
    return {
      id: 'workbench',
      name: store.recipeName || '当前工作台配方',
      shareCode: shareCodeOf(store.state),
      look: store.state.look,
      texture: store.state.texture,
      fromWorkbench: true,
      anchors: store.state.anchors,
      master: store.state.master,
    };
  }
  const card = getPreset(selected === 'workbench' ? 'fl06' : selected);
  const st = tempState(card);
  return {
    id: card.id,
    name: card.name,
    shareCode: shareCodeOf(st),
    look: st.look,
    texture: st.texture,
    fromWorkbench: false,
    anchors: card.anchors,
    master: st.master,
  };
}

function syncRecipeLabel(): void {
  const sel = currentSelection();
  if (!elRecipe) return;
  elRecipe.innerHTML =
    `<div><span class="k">配方名</span>${sel.name}</div>` +
    `<div><span class="k">配方码</span><span class="code">${sel.shareCode}</span></div>` +
    `<div><span class="k">来源</span>${sel.fromWorkbench ? '当前工作台配方' : '型号卡 ' + sel.id.toUpperCase()}</div>`;
  if (elPreset) elPreset.value = sel.fromWorkbench ? 'workbench' : sel.id;
  if (elCards) {
    for (const b of elCards.querySelectorAll<HTMLElement>('.dctl-card')) {
      b.classList.toggle('on', b.dataset.id === sel.id);
    }
  }
}

function selectPreset(id: string): void {
  selected = id === 'workbench' ? 'workbench' : (PRESET_IDS.includes(id) ? id : 'fl06');
  syncRecipeLabel();
}

function selectPipeline(tf: PipelineTF): void {
  pipeline = tf;
  if (elPipe) {
    for (const b of elPipe.querySelectorAll<HTMLElement>('.dctl-pipe')) {
      b.classList.toggle('on', b.dataset.pipe === tf);
    }
  }
}

/* ================= 生成 ================= */

function renderResult(res: DctlGenResult, sel: Selection, tf: PipelineTF): void {
  const v = validateDctl(res.source);
  lastValid = v;
  if (elSummary) {
    const info = PIPELINES.find((p) => p.id === tf);
    const on = (['halation', 'bloom', 'grain', 'vignette', 'gate_weave'] as const).filter((k) => stages[k]);
    const layerTxt = on.length === 5 ? '全层（色彩 + 光晕/柔光/颗粒/暗角/片门抖动）'
      : on.length === 0 ? '仅色彩层' : `色彩 + ${on.map((k) => LAYER_CN[k]).join('/')}`;
    const labelTxt = labelMode === 'bilingual'
      ? `中英混排${groupPrefix ? ' + 分组前缀' : ''}${tooltips ? ' + tooltip' : ''}（已实机验证）`
      : '纯英文（安全形态，与已实测样例同形）';
    const switchTxt = boolSlider ? '0/1 滑杆（已实机验证）' : '勾选框（未实机验证）';
    const sigTxt = on.length === 5 ? '纹理签名 → ResolveFX DCTL 插件加载'
      : on.length === 0 ? '逐像素签名 → 可走 LUT 路径（无面板）' : '纹理签名 → ResolveFX DCTL 插件加载';
    elSummary.innerHTML =
      `<div>配方：<b>${sel.name}</b> · 配方码 <b>${sel.shareCode}</b></div>` +
      `<div>管线：<b>${info?.name ?? tf}</b>${info?.reserved ? '（预留）' : ''}</div>` +
      `<div>导出层：<b>${layerTxt}</b> · 标签：<b>${labelTxt}</b></div>` +
      `<div>开关形态：<b>${switchTxt}</b> · 入口：<b>${sigTxt}</b></div>` +
      `<div>匹配段：<b>${matchOn ? '内联 CDL（单节点）' : '不内联（需另挂 CDL 节点）'}</b></div>` +
      `<div>参数面板声明数：<b>${res.params.length}</b> · 源码 <b>${res.source.length}</b> 字节</div>` +
      `<div>warnings：<b>${res.warnings.length}</b> 条</div>`;
  }
  if (elWarn) {
    elWarn.innerHTML = res.warnings.map((w) => `<li>${w}</li>`).join('');
  }
  if (elValid) {
    elValid.innerHTML = v.ok
      ? `<span style="color:var(--ok)">静态校验：通过（括号配平 / 入口 / 参数声明 / 无残留 GLSL 符号）</span>`
      : `<span style="color:var(--err)">静态校验：失败 —— ${v.errors.join('；')}</span>`;
  }
  if (elSrc) {
    const lines = res.source.split('\n');
    const head = lines.slice(0, 200).join('\n');
    elSrc.textContent = head + (lines.length > 200 ? `\n…（共 ${lines.length} 行，仅预览前 200 行）` : '');
  }
  if (elDl) elDl.disabled = false;
}

function runConsistency(look: LookParams, tf: PipelineTF, anchors?: CardAnchorsT): Consistency {
  const log = lookToLogLook(look, tf, anchorsForPipeline(anchors, tf));
  if (cvGamma) drawChart(cvGamma, (rgb) => applyGammaLook(rgb, look));
  if (cvLog) drawChart(cvLog, (rgb) => applyLogDomainLook(rgb, tf, log));
  const c = measureConsistency(look, tf, anchors);
  lastConsistency = c;
  // R4 验收：一致性核验结果写入 #e2e-meta（供 E2E 断言）
  setMeta({ dctlConsistency: { samples: c.samples, meanAbs: c.meanAbs, maxAbs: c.maxAbs, meanDE: c.meanDE } });
  if (elCons) {
    elCons.innerHTML =
      `<div><span class="k">采样色点</span><b>${c.samples}</b>（灰阶 11 + 色块 24 + RGB 网格 64）</div>` +
      `<div><span class="k">平均分量差</span><b>${c.meanAbs.toFixed(2)}</b> / 255 级</div>` +
      `<div><span class="k">最大分量差</span><b>${c.maxAbs.toFixed(2)}</b> / 255 级</div>` +
      `<div><span class="k">平均 ΔE76</span><b>${c.meanDE.toFixed(2)}</b></div>` +
      `<div class="note">对数域 look 与 gamma 空间 look 为同参不同域的两种实现：差异来自域映射与曲线形状，` +
      `同源但不逐像素相等；数值越小表示两者观感越接近。</div>`;
  }
  return c;
}

/** 当前分层选择：全开 → undefined（走生成器默认，源码与 R4 完全一致） */
function stagesInput(): Record<string, boolean> | undefined {
  const all = stages.halation && stages.bloom && stages.grain && stages.vignette && stages.gate_weave;
  return all ? undefined : { ...stages };
}

/** 导出文件名后缀：只导出色彩层 / 部分层时区分，避免与全层文件重名 */
function stageSuffix(): string {
  const on = (['halation', 'bloom', 'grain', 'vignette', 'gate_weave'] as const).filter((k) => stages[k]);
  if (on.length === 5) return '';
  if (on.length === 0) return '-color';
  return `-${on.join('')}`;
}

/* ================= R7 匹配段（内联 CDL） ================= */

/** 匹配系数的 10 个输入框 id（顺序：slope RGB / offset RGB / power RGB / sat） */
const MATCH_FIELD_IDS: string[] = [
  'dctl-match-s-r', 'dctl-match-s-g', 'dctl-match-s-b',
  'dctl-match-o-r', 'dctl-match-o-g', 'dctl-match-o-b',
  'dctl-match-p-r', 'dctl-match-p-g', 'dctl-match-p-b',
  'dctl-match-sat',
];

const matchInput = (id: string): HTMLInputElement | null =>
  document.getElementById(id) as HTMLInputElement | null;

/**
 * 由工作台状态解算该镜头的 CDL：被调色图（当前帧）统计 → 参考图统计。
 * 与批量页同一套解算（`fitCdl` + 分区锚点近似），所以内联进 DCTL 的系数就是「匹配」的近似。
 */
function solvedCdl(): Cdl | null {
  const st = store.state;
  if (!st?.refStats || !st?.userStats) return null;
  return fitCdl(quantilesFromImageStats(st.userStats), quantilesFromImageStats(st.refStats)).cdl;
}

/** 读面板上的 10 个系数（非法输入回退到该字段的默认中性值） */
function readMatchCdl(): Cdl {
  const v = (id: string, fb: number): number => {
    const el = matchInput(id);
    const n = el ? Number(el.value) : NaN;
    return Number.isFinite(n) ? n : fb;
  };
  return {
    slope: [v('dctl-match-s-r', 1), v('dctl-match-s-g', 1), v('dctl-match-s-b', 1)],
    offset: [v('dctl-match-o-r', 0), v('dctl-match-o-g', 0), v('dctl-match-o-b', 0)],
    power: [v('dctl-match-p-r', 1), v('dctl-match-p-g', 1), v('dctl-match-p-b', 1)],
    sat: v('dctl-match-sat', 1),
  };
}

/** 把一组系数写进面板输入框 */
function fillMatchInputs(cdl: Cdl): void {
  const vals = [...cdl.slope, ...cdl.offset, ...cdl.power, cdl.sat];
  MATCH_FIELD_IDS.forEach((id, i) => {
    const el = matchInput(id);
    if (el) el.value = String(Number(vals[i].toFixed(6)));
  });
}

const fmt6 = (x: number): string => x.toFixed(6);
const cdlTriple = (v: readonly number[]): string => v.map(fmt6).join(' / ');

/** 误差报告（R7 验收③）：engine 匹配 vs 内联 CDL 近似，同一组采样点 */
function runMatchReport(cdl: Cdl): MatchApproxReport | null {
  const st = store.state;
  if (!st?.refStats || !st?.userStats) {
    lastMatchReport = null;
    return null;
  }
  const rep = matchApproxReport(st.userStats, st.refStats, st.colorParams, { cdl });
  lastMatchReport = rep;
  return rep;
}

function renderMatchReport(rep: MatchApproxReport | null): void {
  const el = document.getElementById('dctl-match-report');
  if (!el) return;
  const st = store.state;
  if (!st?.refStats || !st?.userStats) {
    el.innerHTML = '<span class="note">未挂参考：误差报告需「当前帧 + 参考」两份统计（工作台选定参考后自动解算 CDL）。</span>';
    return;
  }
  if (!rep) {
    el.textContent = '（尚未计算）';
    return;
  }
  el.innerHTML =
    `<div><span class="k">采样点</span><b>${rep.n}</b>${rep.skipped ? `（跳过 ${rep.skipped}）` : ''}</div>` +
    `<div><span class="k">平均 ΔE76</span><b>${rep.meanDE.toFixed(2)}</b> · 最大 <b>${rep.maxDE.toFixed(2)}</b></div>` +
    `<div><span class="k">分量差</span>平均 <b>${(rep.meanAbs * 255).toFixed(2)}</b> / 最大 <b>${(rep.maxAbs * 255).toFixed(2)}</b>（0..255 级）</div>` +
    `<div class="note">CDL 是对完整匹配变换的<b>近似</b>（10 个自由度 vs engine 的曲线+色偏+肤色保护）：` +
    `数值为量级参考，不代表逐像素预测。采样点含高饱和色域边缘，均值会被极端点抬高。</div>`;
}

function renderMatchStatus(): void {
  const el = document.getElementById('dctl-match-status');
  if (!el) return;
  const c = solvedCdl();
  const st = store.state;
  if (!c || !st?.refStats || !st?.userStats) {
    el.innerHTML = '<div><span class="k">CDL 来源</span>未挂参考（工作台选一张参考图后自动解算；也可手填系数）</div>';
    return;
  }
  const card = store.ref?.label ?? '参考';
  el.innerHTML =
    `<div><span class="k">CDL 来源</span>当前帧 → ${card} 的分位数解算（与批量页同一套 fitCdl）</div>` +
    `<div><span class="k">slope</span>${cdlTriple(c.slope)} · <span class="k">offset</span>${cdlTriple(c.offset)}</div>` +
    `<div><span class="k">power</span>${cdlTriple(c.power)} · <span class="k">sat</span>${fmt6(c.sat)}</div>`;
}

function generate(): void {
  const sel = currentSelection();
  const st = stagesInput();
  const useMatch = matchOn;
  const cdl = useMatch ? readMatchCdl() : null;
  const res = generateDctl({
    recipeName: sel.name,
    shareCode: sel.shareCode,
    pipeline,
    /* R18：卡/配方带目标管线锚点时重标定 look（切管线语义不漂移）；无锚点 = 原行为逐位一致 */
    look: lookToLogLook(sel.look, pipeline, anchorsForPipeline(sel.anchors, pipeline)),
    texture: sel.texture,
    /* R21：工作台配方的质感总强度透传为 FM_MASTER 默认值（卡恒 1） */
    master: sel.master,
    resolution: { w: 1920, h: 1080 },
    /* R14：开关形态用 compat 承载（compat=true → 0/1 滑杆；显式 labelMode 保证标签不受影响）。 */
    compat: boolSlider,
    labelMode,
    groupPrefix,
    tooltips,
    ...(st ? { stages: st } : {}),
    ...(cdl ? { match: { cdl } } : {}),
  });
  lastResult = res;
  lastSelection = sel;
  renderResult(res, sel, pipeline);
  runConsistency(sel.look, pipeline, sel.anchors);
  renderMatchReport(useMatch ? runMatchReport(cdl!) : null);
  const layers = stageSuffix() ? `分层（${stageSuffix().slice(1)}）` : '全层';
  const m = useMatch ? ' · 内联匹配段' : '';
  deps.toast(`已生成 ${sel.name} · ${pipeline.toUpperCase()} · ${layers}${m} · ${res.params.length} 个参数`);
}

/* ================= 样例文件列表 ================= */

function renderSamples(root: HTMLElement): void {
  const box = h('div', 'dctl-samples');
  box.id = 'dctl-samples';
  const lines: string[] = [];
  for (const s of DCTL_SAMPLES) {
    // 样例 .dctl 文本由 dctl/samples.buildSample 现场生成，并做静态校验（与生成器同源）
    const card = getPreset(s.presetId);
    const res = buildSample(s);
    const v = validateDctl(res.source);
    lines.push(
      `<div>· <span class="f">${s.fileName}</span> · 管线 <b>${s.pipeline.toUpperCase()}</b> · ` +
      `配方 ${card.name} · ${res.params.length} 参数 · ${res.source.length}B · ` +
      `<span class="${v.ok ? 'ok' : 'bad'}">${v.ok ? '校验通过' : '校验失败：' + v.errors.join('；')}</span></div>`,
    );
  }
  box.innerHTML = `<div class="note">内置样例产物（与生成器同源，导出到 tools/dctl-samples/ 供达芬奇实测）：</div>` + lines.join('');
  root.appendChild(box);
  /* R7：单节点样例（带内联 CDL 匹配段）——单列，避免与 DCTL_SAMPLES 的计数断言混淆 */
  const mlines: string[] = [];
  for (const s of MATCH_SAMPLES) {
    const card = getPreset(s.presetId);
    const res = buildMatchSample(s);
    const v = validateDctl(res.source);
    mlines.push(
      `<div>· <span class="f">${s.fileName}</span> · 管线 <b>${s.pipeline.toUpperCase()}</b> · 配方 ${card.name} · ` +
      `<b>${res.params.length} 参数（含 11 个匹配）</b> · ` +
      `<span class="${v.ok ? 'ok' : 'bad'}">${v.ok ? '校验通过' : '校验失败：' + v.errors.join('；')}</span></div>`,
    );
  }
  const mbox = h('div', 'dctl-samples');
  mbox.id = 'dctl-match-samples';
  mbox.innerHTML = `<div class="note">R7 单节点样例（内联 CDL：一个节点 = 匹配 + look + 质感；系数为现场解算，非硬编码）：</div>` + mlines.join('');
  root.appendChild(mbox);
}

/**
 * R6 标签 spike：3 个「3 参数」文件，单一变量对照，用来在达芬奇里确认
 * 「中英混排标签 / 分组前缀 / tooltip」这三种写法能不能被解析（有前科：标签里的括号会报
 * unknown type of DCTLUIParams definition）。三个都能加载 → 生成页可放心切到中英混排。
 */
function renderLabelSpikes(root: HTMLElement): void {
  const box = h('div', 'dctl-samples');
  box.id = 'dctl-spikes';
  box.appendChild(h('div', 'note',
    'R6 标签 spike（3 个文件各 3 个参数，单一变量）：在达芬奇里逐个加载，确认标签显示正常、tooltip 悬停有说明。' +
    '三个都通过 → 生成页可切「中英混排」；某个失败 → 对应写法回退（文件头写明了每个文件验证哪一种）。'));
  for (const s of LABEL_SPIKE_SAMPLES) {
    const res = buildLabelSpike(s);
    const v = validateDctl(res.source);
    const labels = [...res.source.matchAll(/DEFINE_UI_PARAMS\s*\(\s*FM_[A-Z0-9_]+\s*,\s*([\s\S]*?)\s*,\s*DCTLUI_/g)]
      .map((m) => m[1]);
    const row = h('div');
    row.innerHTML =
      `<span class="f">${s.fileName}</span> · ${s.purpose} · ${res.params.length} 参数 · ` +
      `标签：${labels.map((l) => `「${l}」`).join(' ')} · ` +
      `<span class="${v.ok ? 'ok' : 'bad'}">${v.ok ? '校验通过' : '校验失败：' + v.errors.join('；')}</span> `;
    const btn = h('button', 'mini', '下载');
    btn.type = 'button';
    btn.dataset.file = s.fileName;
    btn.addEventListener('click', () => {
      storage.exportFile(s.fileName, res.source, 'text/plain');
      deps.toast(`已下载 ${s.fileName}`);
    });
    row.appendChild(btn);
    box.appendChild(row);
  }
  root.appendChild(box);
}

/* ================= DOM 装配 ================= */

export function initDctlPage(d: DctlDeps): void {
  if (ready) return;
  const root = document.getElementById('dctl-page');
  if (!root) return;
  ready = true;
  deps = d;
  injectStyle();
  root.innerHTML = '';

  root.appendChild(h('h2', undefined, 'DCTL 生成'));
  const lede = h('div', 'lede');
  lede.innerHTML =
    '把配方翻译成可在达芬奇直接加载的 <b>.dctl</b>：色彩 look 走<b>归一化对数域</b>数学，' +
    '质感层（光晕/柔光/颗粒/暗角）按 effectmath 语义生成，全部参数以达芬奇 OFX <b>参数面板</b>滑杆/开关呈现。' +
    '生成后可用「一致性核验」对比对数域 look 与现有 gamma 空间 look 的数值差异。';
  root.appendChild(lede);

  /* --- 配方选择 --- */
  const cardRecipe = h('div', 'card-blk');
  cardRecipe.appendChild(h('h3', undefined, '配方选择'));
  const rowSel = h('div', 'row');
  rowSel.appendChild(h('label', undefined, '配方'));
  elPreset = document.createElement('select');
  elPreset.id = 'dctl-preset';
  const optWork = document.createElement('option');
  optWork.value = 'workbench';
  optWork.textContent = '当前工作台配方';
  elPreset.appendChild(optWork);
  for (const id of PRESET_IDS) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = `${id.toUpperCase()} ${getPreset(id).name}`;
    elPreset.appendChild(o);
  }
  elPreset.addEventListener('change', () => selectPreset(elPreset!.value));
  rowSel.appendChild(elPreset);
  cardRecipe.appendChild(rowSel);

  elCards = h('div', 'dctl-cards');
  elCards.id = 'dctl-cards';
  for (const id of PRESET_IDS) {
    const b = h('button', 'dctl-card');
    b.type = 'button';
    b.dataset.id = id;
    b.textContent = `${id.toUpperCase()}\n${getPreset(id).name.replace(/^FL-\d+\s*/, '')}`;
    b.title = getPreset(id).meta.tagline;
    b.addEventListener('click', () => selectPreset(id));
    elCards.appendChild(b);
  }
  cardRecipe.appendChild(elCards);
  elRecipe = h('div', 'dctl-recipe');
  elRecipe.id = 'dctl-recipe';
  cardRecipe.appendChild(elRecipe);
  root.appendChild(cardRecipe);

  /* --- 管线选择 --- */
  const cardPipe = h('div', 'card-blk');
  cardPipe.appendChild(h('h3', undefined, '管线选择（对数域 TF）'));
  elPipe = h('div', 'dctl-pipes');
  elPipe.id = 'dctl-pipes';
  for (const p of PIPELINES) {
    const b = h('button', 'dctl-pipe');
    b.type = 'button';
    b.dataset.pipe = p.id;
    b.title = p.note;
    b.innerHTML = `<b>${p.name}</b>${p.reserved ? '<span class="res">预留</span>' : ''}<br>${p.note}`;
    b.addEventListener('click', () => selectPipeline(p.id));
    elPipe.appendChild(b);
  }
  cardPipe.appendChild(elPipe);
  cardPipe.appendChild(h('div', 'note', 'ACES 为预留：尚未实测校准，生成时退化为 RCM（DaVinci Intermediate）的 TF，并给出警告。'));
  /* R18 诚实标注：HSL 维度仅网页与 .cube 承载（DCTL 参数余量不足，六系数亦为常量烘焙）。 */
  const r18Note = h('div', 'note');
  r18Note.innerHTML =
    '<b>HSL 维度仅网页与 .cube 承载</b>：DCTL 不含 HSL 8 色相面板/数学（配方带 HSL 时生成器会显式警告）；'
    + '串扰六系数与锚点黑位以常量烘焙进源码，不占 64 个 UI 参数额度。'
    + '带锚点（anchors）的卡在切换管线时会自动重标定 black/white/pivot（切管线语义不漂移）。';
  cardPipe.appendChild(r18Note);
  root.appendChild(cardPipe);

  /* --- 参数面板与分层导出（R6） --- */
  const cardPanel = h('div', 'card-blk');
  cardPanel.appendChild(h('h3', undefined, '参数面板与分层导出'));
  const panelNote = h('div', 'note');
  panelNote.innerHTML =
    '达芬奇的 DCTL 参数面板是平铺列表：分组前缀负责把同层参数聚拢，tooltip 负责一句话说明。' +
    '<b>中英混排 + tooltip 已于 2026-09-23 实机验证通过，默认开启</b>；如遇解析异常可切回纯英文（安全形态）。' +
    '开关形态默认 <b>0/1 滑杆（已实机验证）</b>；勾选框形态尚未实机验证。';
  cardPanel.appendChild(panelNote);

  const rowLabel = h('div', 'row');
  rowLabel.appendChild(h('label', undefined, '标签模式'));
  const selLabel = document.createElement('select');
  selLabel.id = 'dctl-labelmode';
  for (const [v, t] of [['bilingual', '中英混排（已实机验证，默认）'], ['ascii', '纯英文（安全形态）']] as const) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    if (v === labelMode) o.selected = true;
    selLabel.appendChild(o);
  }
  selLabel.addEventListener('change', () => {
    labelMode = selLabel.value === 'bilingual' ? 'bilingual' : 'ascii';
    // tooltip 与分组前缀只在混排模式有意义：跟着模式给出安全默认，用户仍可手改
    tooltips = labelMode === 'bilingual';
    groupPrefix = true;
    syncPanelOpts();
    generate();
  });
  rowLabel.appendChild(selLabel);

  /* R14：开关形态（0/1 滑杆已实机验证 / 勾选框未验证） */
  rowLabel.appendChild(h('label', undefined, '开关形态'));
  const selSwitch = document.createElement('select');
  selSwitch.id = 'dctl-switchform';
  for (const [v, t] of [['slider', '0/1 滑杆（已实机验证，默认）'], ['checkbox', '勾选框（未实机验证）']] as const) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    if ((v === 'slider') === boolSlider) o.selected = true;
    selSwitch.appendChild(o);
  }
  selSwitch.addEventListener('change', () => {
    boolSlider = selSwitch.value !== 'checkbox';
    syncPanelOpts();
    generate();
  });
  rowLabel.appendChild(selSwitch);

  const mkCheck = (id: string, text: string, get: () => boolean, set: (v: boolean) => void): HTMLLabelElement => {
    const lab = h('label');
    lab.style.display = 'inline-flex';
    lab.style.gap = '5px';
    lab.style.alignItems = 'center';
    lab.style.marginRight = '10px';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = id;
    cb.checked = get();
    cb.addEventListener('change', () => { set(cb.checked); generate(); });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(text));
    return lab;
  };
  const rowOpts = h('div', 'row');
  rowOpts.id = 'dctl-panel-opts';
  rowOpts.appendChild(mkCheck('dctl-groupprefix', '分组前缀', () => groupPrefix, (v) => { groupPrefix = v; }));
  rowOpts.appendChild(mkCheck('dctl-tooltips', 'tooltip 说明', () => tooltips, (v) => { tooltips = v; }));
  cardPanel.appendChild(rowLabel);
  cardPanel.appendChild(rowOpts);

  const rowStages = h('div', 'row');
  rowStages.id = 'dctl-stages';
  rowStages.appendChild(h('label', undefined, '导出层'));
  for (const k of ['halation', 'bloom', 'grain', 'vignette', 'gate_weave'] as const) {
    rowStages.appendChild(mkCheck(`dctl-stage-${k}`, LAYER_CN[k], () => stages[k], (v) => { stages[k] = v; }));
  }
  const btnColorOnly = h('button', 'mini', '只导出色彩层');
  btnColorOnly.type = 'button';
  btnColorOnly.id = 'dctl-color-only';
  btnColorOnly.addEventListener('click', () => {
    for (const k of ['halation', 'bloom', 'grain', 'vignette', 'gate_weave'] as const) stages[k] = false;
    syncPanelOpts();
    generate();
  });
  const btnAllLayers = h('button', 'mini', '恢复全层');
  btnAllLayers.type = 'button';
  btnAllLayers.id = 'dctl-all-layers';
  btnAllLayers.addEventListener('click', () => {
    for (const k of ['halation', 'bloom', 'grain', 'vignette', 'gate_weave'] as const) stages[k] = true;
    syncPanelOpts();
    generate();
  });
  rowStages.appendChild(btnColorOnly);
  rowStages.appendChild(btnAllLayers);
  cardPanel.appendChild(rowStages);
  const stagesNote = h('div', 'note');
  stagesNote.innerHTML =
    '「只导出色彩层」= 不带邻域采样的纯色彩 DCTL（渲染最快，适合先确认匹配/look；此时会生成<b>逐像素签名</b>版本，'
    + '可走「节点右键 → LUT → DCTL」加载，但没有参数面板）；'
    + '取消勾选某一层时，该层的参数声明与代码块会同时裁剪（不会留下未定义宏）。';
  cardPanel.appendChild(stagesNote);
  root.appendChild(cardPanel);

  /* --- 匹配段（R7 单节点导出） --- */
  const cardMatch = h('div', 'card-blk');
  cardMatch.appendChild(h('h3', undefined, '匹配段（单节点导出：一个节点完成「匹配 + look + 质感」）'));
  const matchNote = h('div', 'note');
  matchNote.innerHTML =
    '把 R3 的 CDL 解算结果内联进 DCTL：信号链变成 <b>采样 → CDL 匹配 → 对数域 look → 质感层</b>，' +
    '用户不必再单独连一个 CDL 节点。系数是 10 个 UI 参数，达芬奇面板里可微调、可用 <code>FM_MATCH_ON</code> 整体关掉。' +
    'CDL 是对 engine 匹配变换的<b>近似</b>（下表给出量级）。';
  cardMatch.appendChild(matchNote);

  const status = h('div', 'dctl-recipe');
  status.id = 'dctl-match-status';
  cardMatch.appendChild(status);

  const rowMatchOn = h('div', 'row');
  const labOn = h('label');
  labOn.style.display = 'inline-flex';
  labOn.style.gap = '5px';
  labOn.style.alignItems = 'center';
  const cbMatch = document.createElement('input');
  cbMatch.type = 'checkbox';
  cbMatch.id = 'dctl-match-on';
  cbMatch.checked = matchOn;
  cbMatch.addEventListener('change', () => { matchOn = cbMatch.checked; generate(); });
  labOn.appendChild(cbMatch);
  labOn.appendChild(document.createTextNode('内联匹配段'));
  rowMatchOn.appendChild(labOn);
  const btnRefit = h('button', 'mini', '重新解算');
  btnRefit.type = 'button';
  btnRefit.id = 'dctl-match-refit';
  btnRefit.addEventListener('click', () => {
    const c = solvedCdl();
    if (!c) { deps.toast('未挂参考：先在工作台选一张参考图'); return; }
    fillMatchInputs(c);
    generate();
  });
  const btnNeutral = h('button', 'mini', '中性系数');
  btnNeutral.type = 'button';
  btnNeutral.id = 'dctl-match-neutral';
  btnNeutral.addEventListener('click', () => {
    fillMatchInputs({ slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 });
    generate();
  });
  rowMatchOn.appendChild(btnRefit);
  rowMatchOn.appendChild(btnNeutral);
  cardMatch.appendChild(rowMatchOn);

  const grid = h('div', 'dctl-matchgrid');
  grid.id = 'dctl-matchgrid';
  const mkField = (id: string, label: string): void => {
    const cell = h('div');
    cell.appendChild(h('span', 'k', label));
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = '0.001';
    inp.id = id;
    inp.value = '1';
    inp.addEventListener('change', () => { if (matchOn) generate(); });
    cell.appendChild(inp);
    grid.appendChild(cell);
  };
  mkField('dctl-match-s-r', 'slope R');
  mkField('dctl-match-s-g', 'slope G');
  mkField('dctl-match-s-b', 'slope B');
  mkField('dctl-match-o-r', 'offset R');
  mkField('dctl-match-o-g', 'offset G');
  mkField('dctl-match-o-b', 'offset B');
  mkField('dctl-match-p-r', 'power R');
  mkField('dctl-match-p-g', 'power G');
  mkField('dctl-match-p-b', 'power B');
  mkField('dctl-match-sat', 'sat');
  cardMatch.appendChild(grid);
  const rep = h('div', 'dctl-consistency');
  rep.id = 'dctl-match-report';
  rep.textContent = '（尚未计算）';
  cardMatch.appendChild(rep);
  root.appendChild(cardMatch);

  /* --- 生成 --- */
  const cardGen = h('div', 'card-blk');
  cardGen.appendChild(h('h3', undefined, '生成 .dctl'));
  /* R14：加载途径提示——放在「生成」按钮正上方（这是用户实机报 wrong argument int p_Width 的直接原因） */
  const loadHint = h('div', 'dctl-loadhint');
  loadHint.id = 'dctl-loadpath';
  loadHint.innerHTML =
    '<b>加载途径（重要）</b>：带质感层（邻域采样）或参数面板的 DCTL <b>必须</b>用 ' +
    '<b>Color 页 → OpenFX/特效库 → ResolveFX Color → DCTL</b> 加载，然后在检查器里选文件；' +
    '用「节点右键 → LUT → DCTL」的路径加载会报 <code>wrong argument int p_Width</code>。' +
    '只导出色彩层时会生成<b>逐像素签名</b>版本，那个可以走 LUT 路径（但没有参数面板）。';
  cardGen.appendChild(loadHint);
  const rowGen = h('div', 'row');
  const btnGen = h('button', 'primary', '生成 .dctl');
  btnGen.type = 'button';
  btnGen.id = 'btn-dctl-gen';
  btnGen.addEventListener('click', () => generate());
  elDl = h('button', undefined, '下载 .dctl');
  elDl.type = 'button';
  elDl.id = 'btn-dctl-dl';
  elDl.disabled = true;
  elDl.addEventListener('click', () => {
    if (!lastResult || !lastSelection) return;
    const name = `${lastSelection.shareCode}${stageSuffix()}.dctl`;
    storage.exportFile(name, lastResult.source, 'text/plain');
    deps.toast(`已下载 ${name}`);
  });
  rowGen.appendChild(btnGen);
  rowGen.appendChild(elDl);
  cardGen.appendChild(rowGen);
  elSummary = h('div', 'dctl-recipe');
  elSummary.id = 'dctl-summary';
  elSummary.textContent = '尚未生成。选择配方与管线后点「生成 .dctl」。';
  cardGen.appendChild(elSummary);
  elValid = h('div', 'dctl-valid');
  elValid.id = 'dctl-valid';
  cardGen.appendChild(elValid);
  const warnBox = h('div');
  warnBox.appendChild(h('div', 'note', 'warnings（生成器已知偏差与使用提示）：'));
  elWarn = h('ul', 'dctl-warnings');
  elWarn.id = 'dctl-warnings';
  warnBox.appendChild(elWarn);
  cardGen.appendChild(warnBox);
  const prev = h('div', 'dctl-preview');
  prev.appendChild(h('div', 'note', '源码预览（前 200 行）：'));
  elSrc = h('pre', 'dctl-src');
  elSrc.id = 'dctl-src';
  elSrc.textContent = '（生成后显示 .dctl 源码）';
  prev.appendChild(elSrc);
  cardGen.appendChild(prev);
  root.appendChild(cardGen);

  /* --- 一致性核验 --- */
  const cardCons = h('div', 'card-blk');
  cardCons.appendChild(h('h3', undefined, '一致性核验：gamma 空间 look vs 对数域 look'));
  cardCons.appendChild(h('div', 'note',
    '同一张采样色卡（灰阶 11 级 + 24 色块）分别经两种 look 处理后自绘；下方给出 N≥64 采样点的数值差异（0..255 级）。'));
  const charts = h('div', 'dctl-charts');
  charts.id = 'dctl-charts';
  cvGamma = h('canvas');
  cvGamma.width = CHART_W; cvGamma.height = CHART_H;
  cvGamma.className = 'dctl-canvas';
  cvGamma.id = 'dctl-canvas-gamma';
  const fg = h('figure');
  fg.appendChild(cvGamma);
  fg.appendChild(h('figcaption', undefined, '左：gamma 空间 look（gammaLook）'));
  cvLog = h('canvas');
  cvLog.width = CHART_W; cvLog.height = CHART_H;
  cvLog.className = 'dctl-canvas';
  cvLog.id = 'dctl-canvas-log';
  const fl = h('figure');
  fl.appendChild(cvLog);
  fl.appendChild(h('figcaption', undefined, '右：对数域 look（tfEncode → applyLogLook → tfDecode）'));
  charts.appendChild(fg);
  charts.appendChild(fl);
  cardCons.appendChild(charts);
  elCons = h('div', 'dctl-consistency');
  elCons.id = 'dctl-consistency';
  elCons.textContent = '尚未核验（生成后自动计算）。';
  cardCons.appendChild(elCons);
  root.appendChild(cardCons);

  /* --- 样例文件 --- */
  const cardSamples = h('div', 'card-blk');
  cardSamples.appendChild(h('h3', undefined, '样例文件（DCTL_SAMPLES）'));
  renderSamples(cardSamples);
  root.appendChild(cardSamples);

  /* --- 标签 spike（R6） --- */
  const cardSpike = h('div', 'card-blk');
  cardSpike.appendChild(h('h3', undefined, '标签 spike（中英混排验证，3 文件 × 3 参数）'));
  renderLabelSpikes(cardSpike);
  root.appendChild(cardSpike);

  syncRecipeLabel();
  selectPipeline('yrgb');
  syncPanelOpts();
  // R7：首屏用工作台解算结果预填匹配系数（未挂参考时留中性值）
  fillMatchInputs(solvedCdl() ?? { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 });
  renderMatchStatus();
  // 首屏预绘一致性色卡（中性参数下两者接近恒等，作为对照）
  {
    const sel0 = currentSelection();
    runConsistency(sel0.look, pipeline, sel0.anchors);
  }
}

/* ================= 演示 / E2E 入口 ================= */

/**
 * #demo=dctl|dctl-rcm|dctl-stages|dctl-labels|dctl-match：
 *   dctl        —— 选 fl06 + YRGB 管线 → 生成 → 一致性核验 → 填源码预览，写 meta.dctl；
 *   dctl-rcm    —— 选 fl05 + RCM 管线 → 同上，写 meta.dctlRcm（用于管线可切换断言）；
 *   dctl-stages —— 只导出色彩层（R6 分层导出）→ 写 meta.dctlStages；
 *   dctl-labels —— 中英混排 + 分组前缀 + tooltip（R6 双语拨杆）→ 写 meta.dctlLabels；
 *   dctl-match  —— 内联 CDL 匹配段（R7 单节点导出；需配合 ref=stock:* 选定参考）→ 写 meta.dctlMatch。
 */
export function dctlDemo(kind: string): void {
  if (kind === 'dctl-rcm') {
    selected = 'fl05';
    pipeline = 'rcm';
  } else {
    selected = 'fl06';
    pipeline = 'yrgb';
  }
  /* R6 演示形态：分层导出（只色彩层）与中英混排标签各跑一遍，其余保持默认安全形态 */
  if (kind === 'dctl-stages') {
    for (const k of ['halation', 'bloom', 'grain', 'vignette', 'gate_weave'] as const) stages[k] = false;
  } else {
    for (const k of ['halation', 'bloom', 'grain', 'vignette', 'gate_weave'] as const) stages[k] = true;
  }
  /* R14：页面默认 = 中英混排 + 分组前缀 + tooltip + 0/1 滑杆（2026-09-23 实机验证通过）；
   * 所有演示形态都按默认走，纯英文仅在用户手动切换时出现。 */
  labelMode = 'bilingual';
  groupPrefix = true;
  tooltips = true;
  boolSlider = true;
  /* R7：内联匹配段——有工作台参考时用解算系数，否则退回中性（仍能跑通生成与报告路径） */
  matchOn = kind === 'dctl-match';
  const fitted = solvedCdl();
  fillMatchInputs(fitted ?? { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 });
  const cb = document.getElementById('dctl-match-on') as HTMLInputElement | null;
  if (cb) cb.checked = matchOn;
  renderMatchStatus();
  syncRecipeLabel();
  selectPipeline(pipeline);
  syncPanelOpts();
  generate();
  const res = lastResult;
  const sel = lastSelection;
  const cons = lastConsistency;
  if (!res || !sel || !cons) return;
  const meta = {
    pipeline,
    preset: sel.id,
    paramCount: res.params.length,
    valid: lastValid?.ok === true,
    warnings: res.warnings.length,
    sourceBytes: res.source.length,
    consistency: cons,
    samples: DCTL_SAMPLES.length,
    labelMode,
    groupPrefix,
    tooltips,
    boolSlider,
    stages: { ...stages },
    layerSuffix: stageSuffix(),
    spikeSamples: LABEL_SPIKE_SAMPLES.length,
    matchSamples: MATCH_SAMPLES.length,
    /* R9 质感深度：采样预算与动态颗粒的机器可读证据（源码级） */
    tex2d: (res.source.match(/_tex2D\(/g) || []).length,
    hasFrameIndex: res.source.includes('TIMELINE_FRAME_INDEX'),
    clusterParam: res.params.some((p) => p.macro === 'FM_GRAIN_CLUSTER'),
    weaveParams: res.params.filter((p) => p.macro.startsWith('FM_GATE_WEAVE')).length,
    match: {
      on: matchOn,
      cdl: readMatchCdl(),
      fromWorkbench: !!fitted,
      report: lastMatchReport
        ? {
          n: lastMatchReport.n,
          skipped: lastMatchReport.skipped,
          meanDE: +lastMatchReport.meanDE.toFixed(3),
          maxDE: +lastMatchReport.maxDE.toFixed(3),
          meanAbs: +lastMatchReport.meanAbs.toFixed(6),
          maxAbs: +lastMatchReport.maxAbs.toFixed(6),
        }
        : null,
    },
  };
  if (kind === 'dctl-rcm') setMeta({ dctlRcm: meta });
  else if (kind === 'dctl-stages') setMeta({ dctlStages: meta });
  else if (kind === 'dctl-labels') setMeta({ dctlLabels: meta });
  else if (kind === 'dctl-match') setMeta({ dctlMatch: meta });
  else setMeta({ dctl: meta });
}
