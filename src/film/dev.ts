/* FilmMatch 效果层 · 开发预览页控制器
 * 职责：驱动 EffectRenderer（pipeline.ts），提供参数面板/测试帧/分屏/颗粒动画/
 *       帧率打点/bench；URL hash 控制初始状态（见 effects.html 头注释）。
 * #bare=1 为截图测量模式：隐藏界面，canvas 以 1:1 固定在视口左上，保留后端/FPS 角标。
 */
import { EffectRenderer } from './pipeline';
import {
  PRESETS, LOOK_KEYS, cloneParams, getPreset, lookToSchema, textureToSchema,
  type FilmParams, type LookParams, type Origin, type TextureParams, type ViewMode,
} from './params';
import { drawBlown, drawChart, drawDusk, drawNeon } from './scenes';

/* ================= 错误兜底（无头调试可见） ================= */
const errbanner = document.getElementById('errbanner')!;
window.addEventListener('error', (e) => {
  errbanner.style.display = 'block';
  errbanner.textContent = 'JS错误: ' + e.message + ' @' + (e.lineno ?? '?');
  document.title = 'ERR ' + e.message;
});
function showFatal(title: string, detail: string): void {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:#141210';
  ov.innerHTML = `<div style="max-width:560px;padding:32px;background:#1d1a15;border:1px solid #373023;border-radius:8px">
    <div style="color:#e8a33d;font-weight:700;font-size:16px;margin-bottom:12px">${title}</div>
    <div style="color:#d8d0c2;line-height:1.8;white-space:pre-wrap">${detail}</div>
    <div style="margin-top:16px;color:#8a7f6d;font-size:12px;word-break:break-all">${navigator.userAgent}</div>
  </div>`;
  document.body.appendChild(ov);
}

/* ================= 参数面板定义 ================= */
interface SpecParam {
  k: string; label: string; min?: number; max?: number; step?: number; unit?: string;
  log?: boolean; fmt?: (v: number) => string;
  /** 控件类型：color=取色器；select=字符串枚举下拉（grain.type/mode）；缺省=滑杆 */
  type?: 'color' | 'select';
  options?: { value: string; label: string }[];
}
interface SpecGroup { group: string; name: string; en: string; noEnable?: boolean; open?: boolean; params: SpecParam[]; }

const PARAM_SPEC: SpecGroup[] = [
  { group: 'halation', name: '光晕', en: 'halation', params: [
    { k: 'amount', label: '强度', min: 0, max: 1, step: 0.01, unit: '' },
    { k: 'radius', label: '半径', min: 0.2, max: 5, step: 0.05, unit: ' %H' },
    { k: 'threshold', label: '阈值', min: 0.3, max: 1, step: 0.01, unit: '' },
    { k: 'tint_rgb', label: '染色', type: 'color' },
    /* —— Schema v1.1 —— */
    { k: 'background_gain', label: '背景增益', min: 0, max: 1, step: 0.01, unit: '' },
    { k: 'amplify', label: '散射敏感', min: 0, max: 2, step: 0.05, unit: '' },
    { k: 'impact', label: '叠加透明', min: 0, max: 1, step: 0.01, unit: '' },
    { k: 'hue', label: '色相', min: 0, max: 1, step: 0.01, unit: '' },
    { k: 'blue_comp', label: '冷背景补偿', min: 0, max: 1, step: 0.01, unit: '' },
    { k: 'smoothness', label: '大小光源', min: 0, max: 1, step: 0.01, unit: '' },
  ]},
  { group: 'grain', name: '颗粒', en: 'grain', params: [
    { k: 'iso', label: '感光度', min: 25, max: 3200, step: 1, unit: '', log: true,
      fmt: (v) => 'ISO ' + Math.round(v) + '（' + Math.sqrt(v / 400).toFixed(2) + '×）' },
    { k: 'size', label: '尺寸', min: 0.4, max: 5, step: 0.05, unit: ' ‰H' },
    { k: 'correlation', label: '通道相关', min: 0, max: 1, step: 0.01, unit: '' },
    { k: 'shadow_weight', label: '暗部加权', min: 0, max: 1, step: 0.01, unit: '' },
    /* —— Schema v1.1 —— */
    { k: 'shadow', label: '阴影段', min: 0, max: 3, step: 0.05, unit: '' },
    { k: 'midtone', label: '中间调段', min: 0, max: 3, step: 0.05, unit: '' },
    { k: 'highlight', label: '高光段', min: 0, max: 3, step: 0.05, unit: '' },
    { k: 'type', label: '颗粒类型', type: 'select', options: [
      { value: 'negative', label: '负片' }, { value: 'positive', label: '正片' },
    ]},
    { k: 'film_resolution', label: '乳剂分辨率', min: 0, max: 1, step: 0.01, unit: '' },
    { k: 'mode', label: '颗粒模式', type: 'select', options: [
      { value: 'analogue', label: '絮状' }, { value: 'noise', label: '白噪声' },
    ]},
  ]},
  { group: 'bloom', name: '柔光', en: 'bloom', params: [
    { k: 'amount', label: '强度', min: 0, max: 1, step: 0.01, unit: '' },
    { k: 'radius', label: '半径', min: 0.5, max: 8, step: 0.05, unit: ' %H' },
    { k: 'threshold', label: '阈值', min: 0.5, max: 1, step: 0.01, unit: '' },
    /* —— Schema v1.1 —— */
    { k: 'save_lights', label: '高光保护', min: 0, max: 1, step: 0.01, unit: '' },
    { k: 'details', label: '大小光源', min: 0, max: 1, step: 0.01, unit: '' },
    { k: 'saturation', label: '效果饱和', min: 0, max: 1, step: 0.01, unit: '' },
  ]},
  { group: 'vignette', name: '暗角色散', en: 'vignette', params: [
    { k: 'amount', label: '暗角强度', min: 0, max: 1, step: 0.01, unit: '' },
    { k: 'radius', label: '起始半径', min: 0.5, max: 2, step: 0.01, unit: '' },
    { k: 'chroma_shift', label: '边缘色散', min: 0, max: 0.02, step: 0.001, unit: '' },
  ]},
  { group: 'look', name: '复古褪色', en: 'color / look（预览用）', noEnable: true, open: true, params: [
    { k: 'fade', label: '褪色总量', min: 0, max: 1, step: 0.01, unit: '' },
    { k: 'black_lift', label: '黑位提升', min: 0, max: 0.2, step: 0.005, unit: '' },
    { k: 'dye_coupling', label: '染料耦合', min: 0, max: 0.4, step: 0.01, unit: '' },
    { k: 'shadow_bias', label: '暗部青蓝', min: 0, max: 1, step: 0.01, unit: '' },
    { k: 'highlight_bias', label: '高光暖黄', min: 0, max: 1, step: 0.01, unit: '' },
    { k: 'film_s', label: '软S曲线', min: 0, max: 1, step: 0.01, unit: '' },
    { k: 'contrast', label: '正片反S', min: 0, max: 1, step: 0.01, unit: '' },
    { k: 'saturation', label: '饱和度', min: 0, max: 1.4, step: 0.01, unit: '' },
    { k: 'warmth', label: '冷暖偏移', min: -1, max: 1, step: 0.02, unit: '' },
  ]},
  { group: 'master', name: '全局强度', en: 'master', noEnable: true, params: [
    { k: 'master', label: '全部质感层', min: 0, max: 2, step: 0.01, unit: '×' },
  ]},
];

/* ================= 状态 ================= */
let state: FilmParams = cloneParams(getPreset('neutral').params);
let origins: Record<string, Origin> = {};
let currentPreset = 'neutral';
let animate = true;
let frozen = false;
let freezeT = 0.5;              // 冻结时的颗粒相位（秒）
let viewMode: ViewMode = 0;
let splitX = 0.5;
let benchMode = false;
let halTight = 1, halWide = 1;  // H2 验证钩子

function applyPreset(id: string): void {
  const card = getPreset(id);
  state = cloneParams(card.params);
  origins = { ...card.origins };
  currentPreset = card.id;
}

/* hash #p.<路径>=值 参数覆盖（路径：look 键直接写，texture 组用 组.字段）
 * 字符串枚举（grain.type/mode）走白名单校验，非法值静默忽略（保持默认）。 */
const ENUM_OVERRIDES: Record<string, readonly string[]> = {
  'grain.type': ['negative', 'positive'],
  'grain.mode': ['analogue', 'noise'],
};
function applyOverrides(hash: URLSearchParams): void {
  for (const [key, raw] of hash.entries()) {
    if (!key.startsWith('p.')) continue;
    const path = key.slice(2);
    const setNum = (obj: Record<string, unknown>, k: string, v: string): void => {
      if (/^(true|false|0|1)$/i.test(v) && (typeof obj[k] === 'boolean' || k === 'enabled')) {
        obj[k] = v !== '0' && v.toLowerCase() !== 'false';
      } else {
        const n = parseFloat(v);
        if (isFinite(n)) obj[k] = n;
      }
    };
    if ((LOOK_KEYS as readonly string[]).includes(path)) {
      setNum(state.look as unknown as Record<string, unknown>, path, raw);
    } else if (path === 'master') {
      setNum(state as unknown as Record<string, unknown>, 'master', raw);
    } else {
      const dot = path.indexOf('.');
      if (dot > 0) {
        const g = path.slice(0, dot) as keyof TextureParams;
        const k = path.slice(dot + 1);
        const grp = state.texture[g] as unknown as Record<string, unknown> | undefined;
        if (grp && k in grp) {
          const allowed = ENUM_OVERRIDES[path];
          if (allowed) {
            // 枚举覆盖：只接受白名单值，非法则整条忽略（不标记 origin）
            if (!allowed.includes(raw)) continue;
            grp[k] = raw;
          } else {
            setNum(grp, k, raw);
          }
        }
      }
    }
    origins[path] = 'user';
  }
}

/* ================= 渲染后端 ================= */
const canvas = document.getElementById('glcanvas') as HTMLCanvasElement;
const renderer = new EffectRenderer();
const rsHash = new URLSearchParams(location.hash.slice(1)).get('rs');
try {
  renderer.init(canvas, { internalScale: rsHash ? parseFloat(rsHash) || 0.5 : 0.5 });
} catch (e) {
  showFatal('渲染后端不可用', String(e));
  throw e;
}
document.getElementById('stat-gpu')!.textContent = renderer.backendLabel();

/* ================= 测试帧与源管理 ================= */
const srcCanvas = document.createElement('canvas');
function loadScene(id: string): void {
  const W = 1920, H = 1080;
  srcCanvas.width = W; srcCanvas.height = H;
  const c = srcCanvas.getContext('2d')!;
  if (id === 'neon') drawNeon(c, W, H);
  else if (id === 'dusk') drawDusk(c, W, H);
  else if (id === 'blown') drawBlown(c, W, H);
  else drawChart(c, W, H);
  renderer.setSource(srcCanvas);
  currentSrcType = 'stock:' + id;
  refreshJSON();
}
function uploadImage(src: CanvasImageSource & { width: number; height: number }, srcType: string): void {
  let w = src.width, h = src.height;
  const cap = 2560;
  if (Math.max(w, h) > cap) {
    const s = cap / Math.max(w, h);
    w = Math.round(w * s); h = Math.round(h * s);
  }
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d')!.drawImage(src as CanvasImageSource, 0, 0, w, h);
  renderer.setSource(cv);
  currentSrcType = srcType;
  refreshJSON();
}
/* #img=testimg/xxx.jpg —— 载入任意 URL 帧（相对页面；同源无污染） */
function loadImg(url: string): void {
  const im = new Image();
  im.onload = () => {
    uploadImage(im, 'url:' + url);
    const sel = document.getElementById('sel-scene') as HTMLSelectElement | null;
    if (sel) { const o = document.createElement('option'); o.value = 'img:' + url; o.textContent = '外部帧 · ' + url.split('/').pop(); sel.appendChild(o); sel.value = 'img:' + url; }
  };
  im.onerror = () => console.error('img load fail: ' + url);
  im.src = url;
}
let currentSrcType = 'stock:neon';

/* push 当前状态到渲染器 */
let needsApply = true;
function pushRender(): void {
  renderer.apply(state, { mode: viewMode, splitX, master: state.master, halationTight: halTight, halationWide: halWide });
  needsApply = false;
}

/* ================= UI 构建 ================= */
const groupsEl = document.getElementById('groups')!;
function fmtVal(p: SpecParam, v: number): string {
  if (p.fmt) return p.fmt(v);
  const dec = ((p.step ?? 0.01).toString().split('.')[1] || '').length;
  return (+v).toFixed(dec) + (p.unit || '');
}
function hexToRgb(hx: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hx.slice(i, i + 2), 16) / 255) as [number, number, number];
}
function rgbToHex(a: [number, number, number] | number[]): string {
  return '#' + a.map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}
interface SliderRefs { rg?: HTMLInputElement; ci?: HTMLInputElement; cb?: HTMLInputElement; sel?: HTMLSelectElement; out?: HTMLOutputElement; od?: HTMLElement; p?: SpecParam; }
const sliders: Record<string, SliderRefs> = {};

function odot(key: string): HTMLElement {
  const od = document.createElement('span');
  od.className = 'odot';
  od.dataset.key = key;
  return od;
}
function markUser(key: string): void {
  origins[key] = 'user';
  refreshDots();
  refreshJSON();
}
function refreshDots(): void {
  for (const key of Object.keys(sliders)) {
    const s = sliders[key];
    if (s.od) {
      const o = origins[key] || 'user';
      s.od.className = 'odot o-' + o;
      s.od.title = ({ annotated: '图库标注', estimated: '算法估算', user: '用户手调' } as Record<string, string>)[o];
    }
    if (s.cb) s.cb.checked = (state.texture as unknown as Record<string, { enabled: boolean }>)[key.split('.')[0]]?.enabled ?? false;
  }
}
function buildUI(): void {
  for (const g of PARAM_SPEC) {
    const d = document.createElement('details');
    d.className = 'group';
    if (g.open) d.open = true;
    const su = document.createElement('summary');
    su.innerHTML = '<span class="arrow">▶</span>';
    if (!g.noEnable) {
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'onoff';
      cb.checked = (state.texture as unknown as Record<string, { enabled: boolean }>)[g.group].enabled;
      cb.addEventListener('change', () => {
        (state.texture as unknown as Record<string, { enabled: boolean }>)[g.group].enabled = cb.checked;
        markUser(g.group + '.enabled');
        pushRender();
      });
      sliders[g.group + '.enabled'] = { cb };
      su.appendChild(cb);
    }
    const tt = document.createElement('span'); tt.textContent = g.name;
    const en = document.createElement('span'); en.className = 'gtitle-en'; en.textContent = g.en;
    su.appendChild(tt); su.appendChild(en);
    const rst = document.createElement('button');
    rst.className = 'mini'; rst.textContent = '↺'; rst.title = '恢复当前预设值';
    rst.addEventListener('click', (e) => {
      e.preventDefault();
      const src = getPreset(currentPreset).params;
      if (g.group === 'look') state.look = { ...src.look };
      else if (g.group === 'master') state.master = src.master;
      else (state.texture as unknown as Record<string, unknown>)[g.group] = cloneParams(src).texture[g.group as keyof TextureParams];
      pushRender(); syncUI();
    });
    su.appendChild(rst);
    d.appendChild(su);
    const body = document.createElement('div'); body.className = 'body';
    for (const p of g.params) {
      const key = g.group + '.' + p.k;
      const row = document.createElement('div'); row.className = 'param';
      const lab = document.createElement('label'); lab.textContent = p.label; row.appendChild(lab);
      if (p.type === 'color') {
        const ci = document.createElement('input'); ci.type = 'color';
        ci.value = rgbToHex(state.texture.halation.tint_rgb);
        ci.addEventListener('input', () => {
          state.texture.halation.tint_rgb = hexToRgb(ci.value);
          markUser(key); pushRender();
        });
        row.appendChild(ci);
        const od = odot(key);
        row.appendChild(document.createElement('output')); row.appendChild(od);
        sliders[key] = { ci, od };
      } else if (p.type === 'select') {
        /* 字符串枚举下拉（grain.type / grain.mode）：直接读写 texture 字段 */
        const sel = document.createElement('select');
        for (const o of p.options ?? []) {
          const op = document.createElement('option');
          op.value = o.value; op.textContent = o.label;
          sel.appendChild(op);
        }
        sel.value = String((state.texture as unknown as Record<string, Record<string, string>>)[g.group][p.k]);
        sel.addEventListener('change', () => {
          (state.texture as unknown as Record<string, Record<string, string>>)[g.group][p.k] = sel.value;
          markUser(key); pushRender();
        });
        row.appendChild(sel);
        const od = odot(key);
        row.appendChild(document.createElement('output')); row.appendChild(od);
        sliders[key] = { sel, od, p };
      } else {
        const rg = document.createElement('input'); rg.type = 'range';
        rg.min = String(p.min); rg.max = String(p.max); rg.step = String(p.step);
        const getV = (): number => {
          if (g.group === 'look') return state.look[p.k as keyof LookParams] as number;
          if (g.group === 'master') return state.master;
          return (state.texture as unknown as Record<string, Record<string, number>>)[g.group][p.k];
        };
        rg.value = String(p.log ? 100 * Math.log2(getV() / 25) / 7 : getV());
        const out = document.createElement('output');
        out.textContent = fmtVal(p, getV());
        rg.addEventListener('input', () => {
          const v = p.log ? 25 * Math.pow(2, parseFloat(rg.value) / 100 * 7) : parseFloat(rg.value);
          if (g.group === 'look') state.look[p.k as keyof LookParams] = v;
          else if (g.group === 'master') state.master = v;
          else (state.texture as unknown as Record<string, Record<string, number>>)[g.group][p.k] = v;
          out.textContent = fmtVal(p, v);
          markUser(key);
          pushRender();
        });
        row.appendChild(rg); row.appendChild(out);
        const od = odot(key); row.appendChild(od);
        sliders[key] = { rg, out, od, p };
      }
      body.appendChild(row);
    }
    d.appendChild(body);
    groupsEl.appendChild(d);
  }
}
function syncUI(): void {
  for (const key of Object.keys(sliders)) {
    const s = sliders[key];
    const [g, k] = key.split('.');
    if (s.cb) { s.cb.checked = (state.texture as unknown as Record<string, { enabled: boolean }>)[g].enabled; continue; }
    if (s.ci) { s.ci.value = rgbToHex(state.texture.halation.tint_rgb); continue; }
    if (s.sel) { s.sel.value = String((state.texture as unknown as Record<string, Record<string, string>>)[g][k]); continue; }
    if (s.rg && s.p && s.out) {
      const getV = (): number => {
        if (g === 'look') return state.look[k as keyof LookParams] as number;
        if (g === 'master') return state.master;
        return (state.texture as unknown as Record<string, Record<string, number>>)[g][k];
      };
      s.rg.value = String(s.p.log ? 100 * Math.log2(getV() / 25) / 7 : getV());
      s.out.textContent = fmtVal(s.p, getV());
    }
  }
  refreshDots();
  refreshJSON();
}

let jsonTimer: ReturnType<typeof setTimeout> | null = null;
function refreshJSON(): void {
  if (jsonTimer) return;
  jsonTimer = setTimeout(() => {
    jsonTimer = null;
    const el = document.getElementById('jsonbox') as HTMLTextAreaElement | null;
    if (el) el.value = JSON.stringify(buildRecipe(), null, 2);
  }, 150);
}
function buildRecipe(): Record<string, unknown> {
  const card = getPreset(currentPreset);
  return {
    schema_version: 1,
    id: 'fm_dev_preview', share_code: 'FM-DEV1',
    name: card.name + ' · 效果层预览',
    meta: {
      created_at: new Date().toISOString(), author: 'dev',
      source: { type: currentSrcType.startsWith('upload') ? 'upload' : 'stock',
        ref_image_id: null, stock_id: currentSrcType.startsWith('stock:') ? currentSrcType.slice(6) : null },
    },
    color: {
      engine: 'colormatch-v1', params: {},
      look: lookToSchema(state.look, origins),
      lut_size: 65,
    },
    texture: textureToSchema(state.texture, origins),
    output: { working_space: 'rec709', export_targets: ['cube', 'drx', 'recipe_code'] },
  };
}

/* ================= 交互 ================= */
document.getElementById('sel-preset')!.addEventListener('change', (e) => {
  applyPreset((e.target as HTMLSelectElement).value);
  pushRender(); syncUI();
});
document.getElementById('sel-mode')!.addEventListener('change', (e) => {
  viewMode = Number((e.target as HTMLSelectElement).value) as ViewMode;
  updateSplitUI(); pushRender();
});
document.getElementById('sel-scene')!.addEventListener('change', (e) => {
  const v = (e.target as HTMLSelectElement).value;
  if (v.startsWith('emb:')) {                     // 内嵌帧（单文件验收包）
    const emb = (window as unknown as { __FM_FRAMES?: { name: string; dataURL: string }[] }).__FM_FRAMES;
    const i = parseInt(v.slice(4), 10);
    if (emb && emb[i]) loadImg(emb[i].dataURL);
    return;
  }
  if (v.startsWith('img:')) { loadImg(v.slice(4)); return; }
  loadScene(v);
});
document.getElementById('btn-anim')!.addEventListener('click', (e) => {
  animate = !animate;
  (e.target as HTMLButtonElement).textContent = animate ? '⏸ 暂停颗粒动画' : '▶ 播放颗粒动画';
});
document.getElementById('btn-100')!.addEventListener('click', (e) => {
  const st = document.getElementById('stage')!;
  st.classList.toggle('one2one');
  (e.target as HTMLButtonElement).textContent = st.classList.contains('one2one') ? '适应窗口' : '100% 查看';
});
document.getElementById('btn-copy')!.addEventListener('click', async () => {
  const txt = JSON.stringify(buildRecipe(), null, 2);
  try { await navigator.clipboard.writeText(txt); } catch {
    const ta = document.createElement('textarea');
    ta.value = txt; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy'); ta.remove();
  }
  const b = document.getElementById('btn-copy')!;
  b.textContent = '已复制 ✓';
  setTimeout(() => { b.textContent = '复制配方 JSON'; }, 1200);
});
document.getElementById('btn-file')!.addEventListener('click', () => (document.getElementById('file') as HTMLInputElement).click());
document.getElementById('file')!.addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) readFile(f);
});
function readFile(f: File): void {
  const img = new Image();
  img.onload = () => { uploadImage(img, 'upload:' + f.name); URL.revokeObjectURL(img.src); };
  img.src = URL.createObjectURL(f);
}
const stage = document.getElementById('stage')!;
stage.addEventListener('dragover', (e) => { e.preventDefault(); document.getElementById('dropmask')!.style.display = 'flex'; });
stage.addEventListener('dragleave', () => { document.getElementById('dropmask')!.style.display = 'none'; });
stage.addEventListener('drop', (e) => {
  e.preventDefault(); document.getElementById('dropmask')!.style.display = 'none';
  const f = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
  if (f) readFile(f);
});
window.addEventListener('paste', (e) => {
  const it = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  if (it) { const f = it.getAsFile(); if (f) readFile(f); }
});
/* 分屏拖动 */
const splitline = document.getElementById('splitline')!;
function updateSplitUI(): void {
  const on = viewMode === 2;
  splitline.style.display = on ? 'block' : 'none';
  document.getElementById('chip-eff')!.style.display = on ? 'block' : 'none';
  document.getElementById('chip-orig')!.style.display = on ? 'block' : 'none';
  splitline.style.left = (splitX * 100) + '%';
}
splitline.addEventListener('pointerdown', (e) => {
  splitline.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    splitX = Math.min(0.98, Math.max(0.02, (ev.clientX - rect.left) / rect.width));
    splitline.style.left = (splitX * 100) + '%';
    pushRender();
  };
  const up = (): void => {
    splitline.removeEventListener('pointermove', move);
    splitline.removeEventListener('pointerup', up);
  };
  splitline.addEventListener('pointermove', move);
  splitline.addEventListener('pointerup', up);
});

/* ================= 帧率打点 + bench ================= */
const spark = document.getElementById('spark') as HTMLCanvasElement;
const sparkCtx = spark.getContext('2d')!;
const sparkHist: number[] = [];
let fpsFrames = 0, fpsAcc = 0, lastT = 0;
const benchState = { frames: 0, acc: 0 };
function fpsTick(dt: number, drawn: boolean): void {
  if (drawn) { fpsFrames++; fpsAcc += dt; }
  if (fpsAcc >= 500 && fpsFrames > 0) {
    const ms = fpsAcc / fpsFrames;
    document.getElementById('stat-fps')!.innerHTML = '<b>' + Math.round(1000 / ms) + '</b> fps';
    document.getElementById('stat-ms')!.textContent = ms.toFixed(1) + ' ms';
    sparkHist.push(ms); if (sparkHist.length > 60) sparkHist.shift();
    sparkCtx.clearRect(0, 0, 120, 26);
    sparkCtx.strokeStyle = '#e8a33d';
    sparkCtx.beginPath();
    sparkHist.forEach((v, i) => {
      const y = 24 - Math.min(v, 66) / 66 * 22;
      if (i) sparkCtx.lineTo(i * 2, y); else sparkCtx.moveTo(i * 2, y);
    });
    sparkCtx.stroke();
    fpsFrames = 0; fpsAcc = 0;
  }
}
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = lastT ? now - lastT : 16;
  lastT = now;
  if (needsApply) pushRender();
  const t = frozen ? freezeT : now / 1000;
  const drawn = renderer.render(t);
  fpsTick(dt, drawn);
  updateBadge(drawn ? now : 0);
  if (benchMode && drawn) {
    benchState.frames++; benchState.acc += dt;
    const benchEl = document.getElementById('bench')!;
    if (benchState.frames >= 120) {
      benchMode = false;
      animate = false;
      const avg = benchState.acc / benchState.frames;
      const info = 'BENCH done: 120 frames, avg ' + avg.toFixed(2) + ' ms (' + Math.round(1000 / avg) + ' fps) @ ' +
        renderer.size.w + '×' + renderer.size.h + ' · ' + renderer.backendLabel() + '（软件渲染数值仅验证路径，真实性能以你的 GPU 为准）';
      benchEl.textContent = info;
      console.log('FM_BENCH ' + JSON.stringify({ ms: +avg.toFixed(2), fps: Math.round(1000 / avg),
        w: renderer.size.w, h: renderer.size.h, backend: renderer.backendKind }));
      (window as unknown as Record<string, unknown>).__FM_BENCH = { ms: +avg.toFixed(2), fps: Math.round(1000 / avg) };
    } else {
      benchEl.textContent = 'BENCH ' + benchState.frames + '/120 …';
    }
  }
}
let badgeFrames = 0;
let badgeLast = 0;
function updateBadge(now: number): void {
  const el = document.getElementById('barebadge');
  if (!el) return;
  badgeFrames++;
  if (now - badgeLast >= 500) {
    const fps = badgeLast > 0 ? Math.round(badgeFrames * 1000 / (now - badgeLast)) : null;
    badgeLast = now; badgeFrames = 0;
    el.textContent = renderer.backendLabel() + ' · ' + renderer.size.w + '×' + renderer.size.h +
      (fps !== null ? ' · ' + fps + ' fps' : '');
  }
}

/* ================= 启动 ================= */
(function boot(): void {
  const hash = new URLSearchParams(location.hash.slice(1));
  const q = (k: string): string | null => hash.get(k);
  const bare = q('bare') === '1';
  if (bare) document.body.classList.add('bare');
  applyPreset(PRESETS[q('preset') ?? ''] ? q('preset')! : 'neutral');
  // 验证钩子与参数覆盖
  if (q('tight') === '0') halTight = 0;
  if (q('wide') === '0') halWide = 0;
  applyOverrides(hash);
  buildUI();
  const sceneId = ['neon', 'dusk', 'chart', 'blown'].includes(q('scene') ?? '') ? q('scene')! : 'neon';
  (document.getElementById('sel-scene') as HTMLSelectElement).value = sceneId;
  (document.getElementById('sel-preset') as HTMLSelectElement).value = currentPreset;
  loadScene(sceneId);
  if (q('img')) loadImg(q('img')!);          // 外部帧（相对路径，如 testimg/xxx.jpg）
  /* 内嵌帧（单文件验收包注入 window.__FM_FRAMES = [{name, dataURL}]）：加入场景下拉并载入首帧 */
  const emb = (window as unknown as { __FM_FRAMES?: { name: string; dataURL: string }[] }).__FM_FRAMES;
  if (Array.isArray(emb) && emb.length) {
    const sel = document.getElementById('sel-scene') as HTMLSelectElement;
    emb.forEach((f, i) => {
      const o = document.createElement('option');
      o.value = 'emb:' + i; o.textContent = '实拍帧 · ' + f.name;
      sel.appendChild(o);
    });
    sel.value = 'emb:0';
    loadImg(emb[0].dataURL);
  }
  if (q('mode')) viewMode = (parseInt(q('mode')!, 10) || 0) as ViewMode;
  if (q('split')) { splitX = parseFloat(q('split')!) || 0.5; viewMode = 2; }
  (document.getElementById('sel-mode') as HTMLSelectElement).value = String(viewMode);
  updateSplitUI();
  if (q('freeze') === '1') {
    frozen = true; animate = false;
    freezeT = q('t') ? parseFloat(q('t')!) || 0 : 0.5;
    document.getElementById('btn-anim')!.textContent = '▶ 播放颗粒动画';
  }
  if (q('bench') === '1') {
    benchMode = true; frozen = false; animate = true;
    document.getElementById('bench')!.style.display = 'block';
  }
  if (q('dumpjson') === '1') {
    setTimeout(() => {
      const s = 'FM_JSON ' + JSON.stringify(buildRecipe());
      console.log(s);
      const b = document.getElementById('bench')!;
      b.style.display = 'block'; b.textContent = s;   // 供无头 dump 读取
    }, 800);
  }
  pushRender();
  refreshJSON();
  // 调试句柄（Phase2 集成参考）
  (window as unknown as Record<string, unknown>).__FM = { renderer, get params() { return state; }, recipe: buildRecipe };
  requestAnimationFrame(frame);
})();
