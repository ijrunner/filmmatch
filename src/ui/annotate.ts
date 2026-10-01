/**
 * 图库标注编辑器（F4 完整版）：查看/编辑图库条目的 look+texture 标注。
 * - 滑杆组复用 ui/paramui.ts 的同一份参数规格（与工作台④面板一致）；
 * - 实时预览：用编辑中的参数把条目缩略图重新渲染到预览画布；
 * - 用户条目「保存到条目」写回 localStorage；内置条目「另存为我的标注」生成新条目
 *   （复制缩略图与统计）——图库由此可自行扩充。
 */
import { EffectRenderer } from '../film/pipeline';
import type { ImageStats } from '../engine';
import {
  defaultLook, defaultTexture, type LookParams, type Origin, type TextureParams,
} from '../film/params';
import {
  allEntries, cloneAsUserAnnotation, saveAnnotation,
  type AnnotationPatch, type LibraryEntry,
} from './library';
import { removeUserRef } from './storage';
import { fmtVal, hexToRgb, LOOK_GROUP, rgbToHex, TEXTURE_GROUPS, type SpecGroup } from './paramui';
import { setMeta } from './e2emeta';

export interface AnnotateDeps {
  toast(msg: string): void;
  /** 条目变化（保存/另存/删除）后回调：重建图库 UI，参数 = 变更条目 id */
  onChange(entryId: string | null): void;
}

interface EditCopy {
  id: string;
  kind: LibraryEntry['kind'];
  name: string;
  thumb: string;
  scene: LibraryEntry['scene'];
  look: LookParams;
  texture: TextureParams;
  origins: Record<string, Origin>;
  note: string;
}

let deps: AnnotateDeps | null = null;
let copy: EditCopy | null = null;
let built = false;
let previewR: EffectRenderer | null = null;
let previewSrc: HTMLCanvasElement | null = null;
let previewTimer: ReturnType<typeof setTimeout> | null = null;

const drawer = (): HTMLElement => document.getElementById('annotate-drawer')!;

/** 当前编辑副本（E2E/调试读取） */
export function editCopy(): EditCopy | null {
  return copy;
}
export function isAnnotateOpen(): boolean {
  return drawer().classList.contains('open');
}

export function initAnnotate(d: AnnotateDeps): void {
  deps = d;
}

/* ---------------- 滑杆绑定（工作副本，不动 store） ---------------- */

function getVal(g: SpecGroup, k: string): number {
  if (!copy) return 0;
  if (g.kind === 'look') return copy.look[k as keyof LookParams] as number;
  return (copy.texture[g.id as keyof TextureParams] as unknown as Record<string, number>)[k];
}
/** select 枚举字段（grain.type / grain.mode）读取：返回字符串 */
function getSelVal(g: SpecGroup, k: string): string {
  if (!copy) return '';
  return String((copy.texture[g.id as keyof TextureParams] as unknown as Record<string, string>)[k]);
}
function setVal(g: SpecGroup, k: string, v: number): void {
  if (!copy) return;
  if (g.kind === 'look') copy.look[k as keyof LookParams] = v;
  else (copy.texture[g.id as keyof TextureParams] as unknown as Record<string, number>)[k] = v;
  copy.origins[`${g.id}.${k}`] = 'user';
}

function build(): void {
  if (built) return;
  built = true;
  const d = drawer();
  const groups: SpecGroup[] = [LOOK_GROUP, ...TEXTURE_GROUPS];
  d.innerHTML =
    '<div class="drawer-head"><span class="logo">标注编辑器</span>' +
    '<span class="sub">look + 质感参数（绿点=手调）</span>' +
    '<button id="btn-annotate-close" class="mini" title="关闭">✕</button></div>' +
    '<canvas id="annotate-preview" width="384" height="216"></canvas>' +
    '<div class="row"><input type="text" id="annotate-name" title="条目名"></div>' +
    '<div id="annotate-groups"></div>' +
    '<div class="row"><textarea id="annotate-note" rows="2" spellcheck="false" title="标注说明"></textarea></div>' +
    '<div class="row">' +
    '<button id="btn-annotate-save" class="primary">保存到条目</button>' +
    '<button id="btn-annotate-saveas">另存为「我的标注」</button>' +
    '</div>' +
    '<div class="row"><button id="btn-annotate-del">删除该条目</button></div>' +
    '<div class="note">「另存为」会把当前编辑副本复制成一个新的用户条目（图库扩充入口）；内置条目不可覆盖，请另存。</div>';
  d.querySelector('#btn-annotate-close')!.addEventListener('click', closeAnnotate);

  // 滑杆组（与工作台同一份规格）
  const root = d.querySelector('#annotate-groups')!;
  for (const g of groups) {
    const det = document.createElement('details');
    det.className = 'group';
    det.dataset.group = g.id;
    if (g.id === 'look') det.open = true;
    const su = document.createElement('summary');
    su.innerHTML = '<span class="arrow">▶</span>';
    const tt = document.createElement('span');
    tt.textContent = g.name;
    const en = document.createElement('span');
    en.className = 'gtitle-en';
    en.textContent = g.en;
    su.appendChild(tt);
    su.appendChild(en);
    det.appendChild(su);
    const body = document.createElement('div');
    body.className = 'body';
    for (const p of g.params) {
      const row = document.createElement('div');
      row.className = 'param';
      const lab = document.createElement('label');
      lab.textContent = p.label;
      row.appendChild(lab);
      if (p.type === 'color') {
        const ci = document.createElement('input');
        ci.type = 'color';
        ci.addEventListener('input', () => {
          if (!copy) return;
          copy.texture.halation.tint_rgb = hexToRgb(ci.value);
          copy.origins['halation.tint_rgb'] = 'user';
          schedulePreview();
        });
        row.appendChild(ci);
        row.appendChild(document.createElement('output'));
        row.appendChild(Object.assign(document.createElement('span'), { className: 'odot' }));
      } else if (p.type === 'select') {
        // Schema v1.1 枚举字段（grain.type / grain.mode）：字符串直接写入工作副本
        const sel = document.createElement('select');
        sel.dataset.g = g.id;
        sel.dataset.k = p.k;
        for (const o of p.options ?? []) {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label;
          sel.appendChild(opt);
        }
        sel.addEventListener('change', () => {
          if (!copy) return;
          (copy.texture[g.id as keyof TextureParams] as unknown as Record<string, string>)[p.k] = sel.value;
          copy.origins[`${g.id}.${p.k}`] = 'user';
          (row.querySelector('.odot') as HTMLElement).className = 'odot o-user';
          schedulePreview();
        });
        row.appendChild(sel);
        row.appendChild(document.createElement('output'));
        row.appendChild(Object.assign(document.createElement('span'), { className: 'odot' }));
      } else {
        const rg = document.createElement('input');
        rg.type = 'range';
        rg.min = String(p.min);
        rg.max = String(p.max);
        rg.step = String(p.step);
        rg.dataset.g = g.id;
        rg.dataset.k = p.k;
        const out = document.createElement('output');
        rg.addEventListener('input', () => {
          const v = parseFloat(rg.value);
          setVal(g, p.k, v);
          out.textContent = fmtVal(p, v);
          (row.querySelector('.odot') as HTMLElement).className = 'odot o-user';
          schedulePreview();
        });
        row.appendChild(rg);
        row.appendChild(out);
        row.appendChild(Object.assign(document.createElement('span'), { className: 'odot' }));
      }
      body.appendChild(row);
    }
    det.appendChild(body);
    root.appendChild(det);
  }

  d.querySelector('#btn-annotate-save')!.addEventListener('click', onSave);
  d.querySelector('#btn-annotate-saveas')!.addEventListener('click', onSaveAs);
  d.querySelector('#btn-annotate-del')!.addEventListener('click', onDelete);
}

/* ---------------- 预览（编辑参数实时渲染缩略图） ---------------- */

function schedulePreview(): void {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 120);
}

function renderPreview(): void {
  if (!copy || !previewR || !previewSrc) return;
  previewR.apply({ texture: copy.texture, look: copy.look, master: 1 }, { master: 1, mode: 0 });
  previewR.setSource(previewSrc);
  previewR.render(0.5);
}

function loadPreviewSrc(): void {
  if (!copy) return;
  const cv = document.createElement('canvas');
  cv.width = 384;
  cv.height = 216;
  const img = new Image();
  img.onload = () => {
    if (!copy) return;
    cv.getContext('2d')!.drawImage(img, 0, 0, 384, 216);
    previewSrc = cv;
    if (!previewR) {
      const pv = document.getElementById('annotate-preview') as HTMLCanvasElement;
      previewR = new EffectRenderer();
      previewR.init(pv);
    }
    renderPreview();
  };
  img.src = copy.thumb;
}

/* ---------------- 打开 / 关闭 / 保存 ---------------- */

export function openAnnotate(entry: LibraryEntry): void {
  build();
  copy = {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    thumb: entry.thumb,
    scene: entry.scene,
    look: { ...defaultLook(), ...entry.look },
    texture: JSON.parse(JSON.stringify({ ...defaultTexture(), ...entry.texture })) as TextureParams,
    origins: { ...entry.origins },
    note: entry.annotation.note,
  };
  ($('annotate-name') as HTMLInputElement).value = copy.name;
  ($('annotate-note') as HTMLTextAreaElement).value = copy.note;
  // 同步滑杆位置与 origin 圆点
  for (const rg of Array.from(drawer().querySelectorAll<HTMLInputElement>('input[type=range]'))) {
    const g = TEXTURE_GROUPS.find((x) => x.id === rg.dataset.g) ?? LOOK_GROUP;
    const k = rg.dataset.k!;
    const p = g.params.find((x) => x.k === k)!;
    const v = getVal(g, k);
    rg.value = String(v);
    const out = rg.parentElement!.querySelector('output')!;
    out.textContent = fmtVal(p, v);
    const dot = rg.parentElement!.querySelector('.odot') as HTMLElement;
    const o = copy.origins[`${g.id}.${k}`] ?? 'user';
    dot.className = 'odot o-' + o;
  }
  // 回填 select（Schema v1.1 枚举字段）当前值与 origin 圆点
  for (const sel of Array.from(drawer().querySelectorAll<HTMLSelectElement>('select[data-g]'))) {
    const g = TEXTURE_GROUPS.find((x) => x.id === sel.dataset.g) ?? LOOK_GROUP;
    const k = sel.dataset.k!;
    sel.value = getSelVal(g, k);
    const dot = sel.parentElement!.querySelector('.odot') as HTMLElement;
    const o = copy.origins[`${g.id}.${k}`] ?? 'user';
    dot.className = 'odot o-' + o;
  }
  const ci = (drawer().querySelector('input[type=color]') as HTMLInputElement | null);
  if (ci) ci.value = rgbToHex(copy.texture.halation.tint_rgb);
  const saveBtn = drawer().querySelector('#btn-annotate-save') as HTMLButtonElement;
  const delBtn = drawer().querySelector('#btn-annotate-del') as HTMLButtonElement;
  const editable = entry.kind === 'upload' && !entry.id.startsWith('stock_');
  saveBtn.style.display = editable ? '' : 'none';
  delBtn.style.display = editable ? '' : 'none';
  loadPreviewSrc();
  drawer().classList.add('open');
  setMeta({ annotateOpen: true, annotateSliders: drawer().querySelectorAll('input[type=range]').length, annotateKind: entry.kind });
}

function $id(id: string): HTMLElement {
  return document.getElementById(id)!;
}
const $ = $id;

export function closeAnnotate(): void {
  drawer().classList.remove('open');
  setMeta({ annotateOpen: false });
}

function patchOf(): AnnotationPatch | null {
  if (!copy) return null;
  return {
    name: ($('annotate-name') as HTMLInputElement).value.trim() || undefined,
    look: copy.look,
    texture: copy.texture,
    origins: copy.origins,
    annotation: { origin: 'user', note: ($('annotate-note') as HTMLTextAreaElement).value.trim() || '用户标注' },
  };
}

function onSave(): void {
  if (!copy || !deps) return;
  const patch = patchOf()!;
  if (!saveAnnotation(copy.id, patch)) {
    deps.toast('保存失败：该条目不是本地用户条目（内置条目请「另存为我的标注」）');
    return;
  }
  deps.toast('标注已保存到条目：' + copy.id);
  const id = copy.id;
  closeAnnotate();
  deps.onChange(id);
}

function onSaveAs(): void {
  if (!copy || !deps) return;
  const created = cloneAsUserAnnotation(
    { name: copy.name, thumb: copy.thumb, stats: builtinStatsOf(copy.id) },
    patchOf()!,
  );  if (!created) {
    deps.toast('另存失败：型号卡没有参考图，只有图库条目可另存');
    return;
  }
  deps.toast('已另存为「我的标注」：' + created.name);
  const id = created.id;
  closeAnnotate();
  deps.onChange(id);
}

/** 另存需要源统计快照：用户条目从存储取，内置条目从图库缓存取 */
function builtinStatsOf(id: string): ImageStats | null {
  const e = allEntries().find((x) => x.id === id);
  return e?.stats ?? null;
}

function onDelete(): void {
  if (!copy || !deps) return;
  removeUserRef(copy.id);
  deps.toast('已删除条目：' + copy.id);
  closeAnnotate();
  deps.onChange(null);
}
