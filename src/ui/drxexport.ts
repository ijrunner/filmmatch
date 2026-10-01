/**
 * R5 · 工作台 ⑤「节点包导出」区控制器（插入 #g-step5 内，不新增 index.html 结构）。
 *
 * 主交付：**节点树搭建清单生成器**（drx/nodetree.buildNodeTree）——把质感层（光晕/柔光/颗粒/暗角）
 * 语义翻译成可复制照做的达芬奇节点搭建清单（含每个节点参数与 1080p/2160p 像素换算），
 * 供用户在达芬奇 Color 页手动建节点后 Grab Still 存为 PowerGrade。
 *
 * 实验性交付：`.drx` 模板生成器（drx/drxfile.generateDrx）。因 spike①（.drx 格式实测）未回执，
 * 该文件为自洽文本容器，**未在达芬奇实测**，一律标注「实验性」，不得当作可用节点包。
 *
 * F13 指南升级：guide.ts 抽屉新增「一键生成你的配方的搭建清单」一节，
 * 调用本模块导出的 drxMarkdownForGuide() 把当前配方 Markdown 注入抽屉 textarea。
 */
import {
  buildNodeTree,
  type BuildList, type BuildListInput, type PixelConversion,
} from '../drx/nodetree';
import { generateDrx, parseDrx, type DrxResult } from '../drx/drxfile';
import { cloneParams, getPreset, type PresetCard } from '../film/params';
import { defaultColorParams, shareCodeOf, type RecipeState } from './recipe';
import { store } from './store';
import { setMeta } from './e2emeta';
import * as storage from './storage';

interface DrxDeps {
  toast: (m: string) => void;
}

/** 本模块需要的最小配方视图（hash 与清单生成都只读这几项） */
type StateView = Pick<RecipeState, 'colorParams' | 'look' | 'texture' | 'master' | 'profile'>;

interface DrxContext {
  name: string;
  shareCode: string;
  hasRecipe: boolean;
  list: BuildList;
  drx: DrxResult;
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

/* ================= 上下文（当前工作台配方 / 无则 fl06 示例） ================= */

function tempState(card: PresetCard): StateView {
  return {
    colorParams: defaultColorParams(true),
    look: { ...card.params.look },
    texture: cloneParams(card.params).texture,
    master: 1,
    profile: card.profile,
  };
}

function contextState(): { state: StateView; name: string; hasRecipe: boolean } {
  if (store.state) {
    return { state: store.state, name: store.recipeName || '当前工作台配方', hasRecipe: true };
  }
  const card = getPreset('fl06');
  return { state: tempState(card), name: `${card.name}（默认示例）`, hasRecipe: false };
}

function buildContext(): DrxContext {
  const { state, name, hasRecipe } = contextState();
  const input: BuildListInput = {
    recipeName: name,
    shareCode: shareCodeOf(state),
    texture: state.texture,
    look: state.look,
    resolution: { w: 1920, h: 1080 },
    lutFileName: null,
  };
  const list = buildNodeTree(input);
  const drx = generateDrx(input);
  return { name, shareCode: shareCodeOf(state), hasRecipe, list, drx };
}

/* ================= 参数对照表 Markdown（仅换算表 + 色彩空间） ================= */

function conversionsMarkdown(list: BuildList): string {
  const lines: string[] = [];
  lines.push('# FilmMatch 节点参数对照表（1080p / 2160p）');
  lines.push('');
  lines.push('> 单位：半径 = 画面高度 %H；颗粒尺寸 = 画面高度 ‰H；色散 = 画面高度比例。三者随画面高度线性换算。');
  lines.push('');
  lines.push(`- 时间线色彩空间：${list.colorSpace.timeline}`);
  lines.push(`- 节点色彩空间：${list.colorSpace.node}`);
  lines.push('');
  lines.push('| 参数 | 单位 | 1080p 像素 | 2160p 像素 | 说明 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const c of list.conversions as PixelConversion[]) {
    lines.push(`| ${c.label} | ${c.unit} | ${c.value1080} | ${c.value2160} | ${c.note} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/* ================= 指南用：当前配方的搭建清单 ================= */

export interface GuideDrx {
  name: string;
  markdown: string;
  hasRecipe: boolean;
  nodes: number;
  conversions: number;
}

/** F13 指南抽屉调用：返回当前配方（无则 fl06 示例）的 Markdown 搭建清单 */
export function drxMarkdownForGuide(): GuideDrx {
  const ctx = buildContext();
  return {
    name: ctx.name,
    markdown: ctx.list.markdown,
    hasRecipe: ctx.hasRecipe,
    nodes: ctx.list.nodes.length,
    conversions: ctx.list.conversions.length,
  };
}

/* ================= DOM 装配（插入 #g-step5） ================= */

let deps: DrxDeps = { toast: () => {} };
let ready = false;
let elSummary: HTMLElement | null = null;
let elMd: HTMLTextAreaElement | null = null;

const DRX_CSS = `
.drx-md{width:100%; height:130px; background:var(--code-bg); color:var(--code-fg); border:1px solid var(--line);
  border-radius:4px; font:var(--fs-sm)/1.5 var(--font-mono); padding:8px; resize:vertical;
  white-space:pre; overflow:auto}
.drx-summary{font-size:var(--fs-md); line-height:1.9; color:var(--text)}
.drx-summary .k{color:var(--dim); display:inline-block; width:88px}
.drx-exp{color:var(--err); font-size:var(--fs-sm)}
`;

function injectStyle(): void {
  if (document.getElementById('drx-style')) return;
  const s = document.createElement('style');
  s.id = 'drx-style';
  s.textContent = DRX_CSS;
  document.head.appendChild(s);
}

function download(name: string, text: string, mime = 'text/markdown'): void {
  storage.exportFile(name, text, mime);
  deps.toast(`已下载 ${name}`);
}

async function copyText(t: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function refresh(ctx: DrxContext): void {
  if (elSummary) {
    elSummary.innerHTML =
      `<div><span class="k">配方</span><b>${ctx.name}</b> · 配方码 <b>${ctx.shareCode}</b></div>` +
      `<div><span class="k">节点数</span><b>${ctx.list.nodes.length}</b>（${ctx.list.nodes.map((n) => n.kind).join(' / ')}）</div>` +
      `<div><span class="k">换算表项数</span><b>${ctx.list.conversions.length}</b>（1080p / 2160p 两套像素换算）</div>` +
      `<div><span class="k">清单字符数</span><b>${ctx.list.markdown.length}</b> · 实验性 .drx <b>${ctx.drx.text.length}</b> 字节</div>`;
  }
  if (elMd) {
    elMd.value = ctx.list.markdown;
    elMd.textContent = elMd.value; // dump-dom 序列化默认值（子文本）需要
  }
}

export function initDrxExport(d: DrxDeps): void {
  if (ready) return;
  const body = document.querySelector<HTMLElement>('#g-step5 > .body');
  if (!body) return;
  ready = true;
  deps = d;
  injectStyle();

  const det = h('details', 'group');
  det.id = 'g-drx';
  const sum = h('summary');
  sum.innerHTML = '<span class="arrow">▶</span>节点包导出（搭建清单）<span class="gtitle-en">node pack</span>';
  det.appendChild(sum);
  const inner = h('div', 'body');

  const note = h('div', 'note');
  note.innerHTML =
    '节点树（光晕 / 柔光 / 颗粒 / 暗角）在达芬奇里手动搭建；本区生成<b>可复制的搭建清单</b>' +
    '（含每个节点参数与 1080p/2160p 像素换算），并附<b>实验性</b> .drx 模板。' +
    '搭建清单是主交付；.drx 未在达芬奇实测，仅供 spike 校准，请勿当作可用节点包。';
  inner.appendChild(note);

  const row1 = h('div', 'row');
  const btnMd = h('button', 'primary', '下载搭建清单.md');
  btnMd.type = 'button';
  btnMd.id = 'btn-drx-md';
  btnMd.addEventListener('click', () => {
    const ctx = buildContext();
    download(`${ctx.shareCode}-搭建清单.md`, ctx.list.markdown);
  });
  const btnCopy = h('button', 'mini', '复制搭建清单');
  btnCopy.type = 'button';
  btnCopy.id = 'btn-drx-copy';
  btnCopy.addEventListener('click', () => {
    const ctx = buildContext();
    void copyText(ctx.list.markdown).then(() => deps.toast('搭建清单已复制到剪贴板'));
  });
  row1.appendChild(btnMd);
  row1.appendChild(btnCopy);
  inner.appendChild(row1);

  const row2 = h('div', 'row');
  const btnDrx = h('button', undefined, '下载 .drx（实验性）');
  btnDrx.type = 'button';
  btnDrx.id = 'btn-drx-file';
  btnDrx.title = '实验性：.drx 为达芬奇私有格式，本模板未在达芬奇实测导入，仅供格式校准；请优先使用搭建清单。';
  btnDrx.addEventListener('click', () => {
    const ctx = buildContext();
    download(`${ctx.shareCode}.drx`, ctx.drx.text, 'text/plain');
  });
  const btnTable = h('button', 'mini', '下载参数对照表.md');
  btnTable.type = 'button';
  btnTable.id = 'btn-drx-table';
  btnTable.addEventListener('click', () => {
    const ctx = buildContext();
    download(`${ctx.shareCode}-参数对照表.md`, conversionsMarkdown(ctx.list));
  });
  row2.appendChild(btnDrx);
  row2.appendChild(btnTable);
  inner.appendChild(row2);

  const exp = h('div', 'drx-exp', '⚠ .drx 为实验性模板：未在达芬奇实测导入，格式待 spike① 回执后校准。');
  inner.appendChild(exp);

  /* C6/R16：.drx 未校准期间的官方替代路径——按清单手动建节点后 Grab Still 存成 PowerGrade。
   * 品牌词口径与既有文案一致（只用「达芬奇」与功能名 Grab Still / PowerGrade）。 */
  const alt = h('div', 'note');
  alt.innerHTML =
    '<b>不下载 .drx 也能拿到节点包</b>：按搭建清单在达芬奇 Color 页建好节点树后，' +
    '选中节点（可多选整棵树）→ 右键 → <b>Grab Still</b> → 存入你的 PowerGrade 目录，' +
    '即得到官方格式的 .drx 节点包；在其他时间线/项目里打开 PowerGrade 面板拖入即可复用。' +
    '要点：Grab Still 保存的是<b>节点树当前全部参数</b>；之后改了参数需重新 Grab Still 覆盖同名文件。';
  inner.appendChild(alt);

  elSummary = h('div', 'drx-summary');
  elSummary.id = 'drx-summary';
  inner.appendChild(elSummary);

  elMd = document.createElement('textarea');
  elMd.id = 'drx-md';
  elMd.className = 'drx-md';
  elMd.readOnly = true;
  elMd.spellcheck = false;
  inner.appendChild(elMd);

  det.appendChild(inner);
  body.appendChild(det);

  refresh(buildContext());
}

/* ================= 演示 / E2E 入口 ================= */

/**
 * #demo=drx：用当前工作台配方（无则 fl06）生成搭建清单与实验性 .drx，
 * 写 meta.drx；并展开 ⑤ 与导出区、滚动到可见位置，便于截图断言「导出区确实出现」。
 */
export function drxDemo(): void {
  const ctx = buildContext();
  const parsed = parseDrx(ctx.drx.text);
  const roundTrip = !!parsed && parsed.nodes.length === ctx.list.nodes.length;
  setMeta({
    drx: {
      nodes: ctx.list.nodes.length,
      kinds: ctx.list.nodes.map((n) => n.kind),
      conversions: ctx.list.conversions.length,
      markdownBytes: ctx.list.markdown.length,
      drxBytes: ctx.drx.text.length,
      experimental: true,
      roundTrip,
    },
  });
  refresh(ctx);
  const step5 = document.getElementById('g-step5') as HTMLDetailsElement | null;
  if (step5) step5.open = true;
  const drxDet = document.getElementById('g-drx') as HTMLDetailsElement | null;
  if (drxDet) drxDet.open = true;
  const panel = document.getElementById('panel');
  if (panel) panel.scrollTop = panel.scrollHeight;
}

/** 供 main.ts 在启动时刷新导出区（当前配方变化时调用，例如选卡后） */
export function refreshDrxExport(): void {
  if (!ready) return;
  refresh(buildContext());
}
