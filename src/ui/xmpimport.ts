/**
 * R15 · XMP 预设导入 UI：「估算起点」卡（图库入口 → 解析/映射 → 风格卡 tab 独立网格）。
 * R19 增：风格卡 tab 三分组筛选（全部/内置风格/我的卡）——纯显示层，见「R19」小节。
 *
 * 职责与边界：
 *  - 本模块由 main.ts **动态 import**（异步 chunk，不进首屏包）；真正的解析/映射
 *    （estimate/xmp · estimate/xmpmap）再按需二级动态 import（parseAndMap）——两层懒加载，
 *    保证 parseXmp/mapXmpToFilm 及其词表只在「点了导入」时才下载。
 *  - 卡存储：localStorage key `fm.xmpcards`，上限 XMP_CARD_LIMIT=100（超出丢最旧 + toast 提示）；
 *    localStorage 不可用退化为内存 Map（写法同 ui/storage.ts）。
 *  - 卡片应用：构造 LibraryEntry（kind 'stock'，origins 全 'estimated'）交给 main 的 selectRef ——
 *    与风格卡同一条「直出配方」路径（色彩匹配保持中性）；用户随后走既有 ⑤ 保存/导出通道。
 *  - 缩略图：当前帧（未载入回退程序化夜景）过映射后的 look+texture，384×216 JPEG q0.8
 *    dataURL（写法同 ui/stockwall.ts：临时 canvas + 一次性 renderer + dispose），按
 *    thumbCacheKey(帧, 参数) 缓存；渲染失败回退空 thumb 占位，不阻塞导入。
 *
 * 合规：卡片显示名/来源一律走 cleanCardName 清洗（UI 不出现第三方品牌词）；
 * DEMO_XMP_* 合成 fixture 中的品牌词只用于断言清洗生效（允许出现在测试/演示数据里）。
 */
import { drawNeon } from '../film/scenes';
import { renderThumbDataURL } from './stockwall';
import {
  LOOK_KEYS, defaultLook, defaultTexture, normalizeParams as normalizeFilm,
  type FilmParams, type LookParams, type Origin, type TextureParams,
} from '../film/params';
import type { LibraryEntry } from './library';
import type { XmpMapping } from '../estimate/xmpmap';
import { setMeta } from './e2emeta';

/* ---------------- 类型 ---------------- */

/** 「估算起点」卡（localStorage 持久化结构，全部字段可 JSON 序列化） */
export interface XmpCard {
  id: string;                         // 'xmp_' + 时间戳 + 随机后缀
  name: string;                       // cleanCardName(原文件名)——显示名，已清洗品牌词
  source: string;                     // 'xmp:<清洗后文件名>'（溯源；同样只含清洗后的名）
  createdAt: string;
  look: LookParams;
  texture: TextureParams;
  origins: Record<string, Origin>;    // 全量 'estimated'（mapXmpToFilm 给出的写出路径保留在内）
  note: string;                       // 估算起点说明 + 来源 + unmapped 前 3 项 + 「需人工调校」
  unmappedCount: number;
  unmappedTop: string[];              // unmapped 前 3 项
  thumb: string;                      // JPEG dataURL（384×216 q0.8）；空串 = 渲染失败占位
}

/** main.ts 注入的宿主能力（保持本模块与 store/配方装配解耦） */
export interface XmpDeps {
  toast(msg: string): void;
  /** 与风格卡同路径：条目交给 main 的 selectRef 直出配方 */
  applyEntry(entry: LibraryEntry): void;
  switchTab(tab: string): void;
  /** 当前帧画布（未载入画面 → null，缩略图回退程序化夜景） */
  frameCanvas(): HTMLCanvasElement | null;
  /** 缩略图缓存键的帧侧标识（如 'frame:xxx.png' / 'scene:neon'） */
  frameKey(): string;
  getState(): { look: LookParams; texture: TextureParams; origins: Record<string, Origin> } | null;
  /** main 的 currentRecipe()（应用卡后核对配方参数一致性） */
  getRecipe(): unknown;
}

export interface XmpImportSummary {
  requested: number;
  imported: number;
  failed: number;
  failures: Array<{ file: string; error: string }>;
  dropped: number;            // 超出数量上限被丢弃的卡数
  saved: boolean;             // 本地存储写入是否成功
  cards: Array<{ id: string; name: string; source: string; note: string;
    unmappedCount: number; unmappedTop: string[]; hasThumb: boolean }>;
}

/* ---------------- 本地存储（fm.xmpcards；写法同 ui/storage.ts 的降级契约） ---------------- */

const LS_XMP_CARDS = 'fm.xmpcards';
export const XMP_CARD_LIMIT = 100;

interface MemStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
const mem = new Map<string, string>();
const memoryStore: MemStore = {
  getItem: (k) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k, v) => void mem.set(k, v),
  removeItem: (k) => void mem.delete(k),
};
function backend(): MemStore {
  try {
    const ls = (globalThis as { localStorage?: MemStore }).localStorage;
    if (ls && typeof ls.getItem === 'function') {
      const probe = '__fm_xmp_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return ls;
    }
  } catch { /* 落到内存 */ }
  return memoryStore;
}

function readRaw(): unknown[] {
  try {
    const raw = backend().getItem(LS_XMP_CARDS);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function writeRaw(cards: XmpCard[]): boolean {
  try {
    backend().setItem(LS_XMP_CARDS, JSON.stringify(cards));
    return true;
  } catch {
    return false;
  }
}

const ORIGINS: readonly Origin[] = ['annotated', 'estimated', 'user'];

/** 存储脏数据防御：缺字段回落默认（texture/look 走 normalizeParams 补齐），坏条目丢弃 */
function normalizeCard(raw: unknown): XmpCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || typeof r.name !== 'string' || !r.name) return null;
  const film = normalizeFilm({ texture: (r.texture ?? {}) as never, look: (r.look ?? {}) as never });
  const origins: Record<string, Origin> = {};
  for (const [k, v] of Object.entries((r.origins ?? {}) as Record<string, unknown>)) {
    origins[k] = ORIGINS.includes(v as Origin) ? (v as Origin) : 'estimated';
  }
  return {
    id: r.id,
    name: r.name,
    source: typeof r.source === 'string' ? r.source : 'xmp:' + r.name,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    look: film.look,
    texture: film.texture,
    origins,
    note: typeof r.note === 'string' ? r.note : '',
    unmappedCount: typeof r.unmappedCount === 'number' ? r.unmappedCount : 0,
    unmappedTop: Array.isArray(r.unmappedTop) ? r.unmappedTop.filter((s): s is string => typeof s === 'string') : [],
    thumb: typeof r.thumb === 'string' ? r.thumb : '',
  };
}

export function listXmpCards(): XmpCard[] {
  return readRaw().map(normalizeCard).filter((c): c is XmpCard => c !== null);
}

export function clearXmpCards(): void {
  writeRaw([]);
}

/** 保存全量（已按上限裁剪的列表；配额满等写失败返回 false） */
export function saveXmpCards(cards: XmpCard[]): boolean {
  return writeRaw(cards);
}

/**
 * 追加（同 id upsert；本批新的在前），超过 XMP_CARD_LIMIT 丢最旧。
 * saved=false 表示写入失败（存储配额？），调用方提示。
 */
export function addXmpCards(cards: XmpCard[]): { total: number; dropped: number; saved: boolean } {
  if (cards.length === 0) {
    const list = listXmpCards();
    return { total: list.length, dropped: 0, saved: true };
  }
  const kept = listXmpCards().filter((old) => !cards.some((c) => c.id === old.id));
  const merged = [...cards.slice().reverse(), ...kept];
  const dropped = Math.max(0, merged.length - XMP_CARD_LIMIT);
  const list = dropped > 0 ? merged.slice(0, XMP_CARD_LIMIT) : merged;
  return { total: list.length, dropped, saved: writeRaw(list) };
}

/* ---------------- 纯逻辑：解析/映射接入 + 卡片组装 ---------------- */

/** 二级动态 import：parseXmp/mapXmpToFilm（含品牌词表）只在导入时下载，不进首屏包 */
export async function parseAndMap(text: string): Promise<XmpMapping> {
  const [{ parseXmp }, { mapXmpToFilm }] = await Promise.all([
    import('../estimate/xmp'),
    import('../estimate/xmpmap'),
  ]);
  return mapXmpToFilm(parseXmp(text));
}

/** origins 全量 'estimated'：texture 各组全键 + look 全键 + master，再叠加 mapXmpToFilm 给出的写出路径（保留） */
function fullOrigins(params: FilmParams, mapped: Record<string, Origin>): Record<string, Origin> {
  const origins: Record<string, Origin> = {};
  for (const [g, obj] of Object.entries(params.texture)) {
    for (const k of Object.keys(obj as Record<string, unknown>)) origins[`${g}.${k}`] = 'estimated';
  }
  for (const k of LOOK_KEYS) origins[`look.${k}`] = 'estimated';
  origins['master'] = 'estimated';
  for (const [k, v] of Object.entries(mapped)) origins[k] = v;
  return origins;
}

/**
 * 映射结果 → 估算起点卡（纯逻辑，node 可测；缩略图由调用方渲染后传入，node 传缺省 ''）。
 * 失败抛错（parseXmp/mapXmpToFilm 的可读错误原样上抛），调用方逐文件兜底、不中断整批。
 */
export async function buildXmpCard(filename: string, mapping: XmpMapping, thumb = ''): Promise<XmpCard> {
  const { cleanCardName } = await import('../estimate/xmpmap');
  const name = cleanCardName(filename);
  const unmapped = mapping.unmapped;
  const note = '估算起点 · XMP 导入（来源：' + name + '）' +
    (unmapped.length > 0
      ? '。未映射 ' + unmapped.length + ' 项：' + unmapped.slice(0, 3).join('；') +
        (unmapped.length > 3 ? ' 等' : '') + '——需人工调校'
      : '。无未映射维度');
  return {
    id: 'xmp_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e8).toString(36),
    name,
    source: 'xmp:' + name,
    createdAt: new Date().toISOString(),
    look: mapping.params.look,
    texture: mapping.params.texture,
    origins: fullOrigins(mapping.params, mapping.origins),
    note,
    unmappedCount: unmapped.length,
    unmappedTop: unmapped.slice(0, 3),
    thumb,
  };
}

/** 卡 → LibraryEntry（kind 'stock'：与风格卡同一条直出配方路径，origins 全 estimated） */
export function xmpEntry(card: XmpCard): LibraryEntry {
  return {
    id: card.id,
    name: card.name,
    kind: 'stock',
    scene: null,
    presetId: 'estimated',
    thumb: card.thumb,
    stats: null,
    look: card.look,
    texture: card.texture,
    origins: { ...card.origins },
    annotation: { origin: 'estimated', note: card.note },
  };
}

/* ---------------- 比对工具（demo 自检 + 单测共用） ---------------- */

/** 结构化深度相等（键序无关；数值按严格相等——两侧都来自同一 4 位小数管线） */
export function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** 配方 Schema 的 {value, origin} 包装 → 裸值（递归；tint_rgb 数组一并展开） */
function unwrapAll(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(unwrapAll);
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    const keys = Object.keys(o);
    if ('value' in o && keys.length <= 2) return unwrapAll(o.value);
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = unwrapAll(o[k]);
    return out;
  }
  return x;
}

const TEX_GROUPS = ['halation', 'grain', 'bloom', 'vignette', 'gate_weave'] as const;

/** currentRecipe() 的 look/texture 段是否与卡参数一致（应用链路自检，demo 用） */
export function recipeMatchesCard(recipe: unknown, card: XmpCard): boolean {
  if (!recipe || typeof recipe !== 'object') return false;
  const r = recipe as { color?: { look?: Record<string, unknown> }; texture?: Record<string, unknown> };
  const look = r.color?.look;
  const tex = r.texture;
  if (!look || !tex) return false;
  if (!deepEq(unwrapAll(look), card.look)) return false;
  for (const g of TEX_GROUPS) {
    if (!deepEq(unwrapAll(tex[g]), (card.texture as unknown as Record<string, unknown>)[g])) return false;
  }
  return true;
}

/* ---------------- 缩略图（当前帧过 look+texture；写法同 ui/stockwall.ts） ---------------- */

const THUMB_W = 384;
const THUMB_H = 216;
const THUMB_Q = 0.8;   // 规格：质量 ≤0.8，控制 localStorage 体积

/** 缓存键 = 帧标识 + look/texture 稳定摘要（同帧同参输出确定，跨卡复用渲染结果） */
export function thumbCacheKey(frameKey: string, look: LookParams, texture: TextureParams): string {
  let h = 5381;
  const s = JSON.stringify([look, texture]);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return frameKey + '|' + h.toString(36);
}

const thumbCache = new Map<string, string>();

/**
 * 渲染缩略图（同步）：源帧（null → 程序化夜景）画进临时 2D 画布 → 共享单例渲染器
 * （见 stockwall.renderThumbDataURL：全站 1 个 GL 上下文，避免逐卡建/毁挤掉主画布）
 * 过映射后的 look+texture → JPEG dataURL。失败返回 ''（卡回退占位），绝不阻塞导入。
 */
export function renderXmpThumb(
  source: HTMLCanvasElement | null, frameKey: string, look: LookParams, texture: TextureParams,
): string {
  const key = thumbCacheKey(frameKey, look, texture);
  const hit = thumbCache.get(key);
  if (hit !== undefined) return hit;
  try {
    const src = document.createElement('canvas');
    src.width = THUMB_W;
    src.height = THUMB_H;
    const c = src.getContext('2d')!;
    if (source) c.drawImage(source, 0, 0, THUMB_W, THUMB_H);
    else drawNeon(c, THUMB_W, THUMB_H);
    const url = renderThumbDataURL(src, look, texture, THUMB_Q);
    thumbCache.set(key, url);
    return url;
  } catch {
    thumbCache.set(key, '');
    return '';
  }
}

/* ---------------- R19 · 风格卡 tab 三分组筛选（全部 / 内置风格 / 我的卡） ----------------
 * 口径：卡片墙三分组 = 型号卡（选型号 tab）/ 风格卡（本 tab）/ 我的卡（用户自己的卡）。
 * 「我的卡」当前 = 导入的 XMP 估算起点卡（R8 ⑤ 本地存卡是配方级，不进卡片墙——产品化远期）。
 * 筛选是纯显示层：R15 的 XMP 卡位置/行为不变。chips 复用 R2 标签筛选（#tagfilter）的
 * mx-row/mx-btn 令牌类，整行由本模块（动态 chunk）首次进入风格卡 tab 时插入 #tab-style 顶部
 * —— index.html / main.ts 零改动，首屏 gzip 零增。 */

/** 分组筛选项（第三个分组「我的卡」；title 说明诚实口径） */
export const STYLE_FILTERS: ReadonlyArray<{ v: StyleGroupFilter; label: string; title: string }> = [
  { v: 'all', label: '全部', title: '内置风格卡与「我的卡」都显示' },
  { v: 'builtin', label: '内置风格', title: '只显示内置风格卡（冲印工艺/时代感维度）' },
  { v: 'mine', label: '我的卡', title: '我的卡 = 图库页「导入 XMP 预设」生成的估算起点卡（⑤ 保存的配方在配方列表，不进卡片墙）' },
];

export type StyleGroupFilter = 'all' | 'builtin' | 'mine';

let styleFilter: StyleGroupFilter = 'all';

export function getStyleFilter(): StyleGroupFilter {
  return styleFilter;
}

/**
 * 纯逻辑：分组筛选 → 各元素的显示计划（node 可测；applyStyleFilter 是它的薄应用层）。
 * xmpEmpty 沿用 R15 语义（无卡提示），但只在「全部」视图生效——「我的卡」视图由专用空态接管。
 */
export function styleFilterPlan(f: StyleGroupFilter, mineCount: number): {
  builtinGrid: boolean; topNote: boolean; mineGrid: boolean; mineEmpty: boolean; xmpEmpty: boolean;
} {
  return {
    builtinGrid: f !== 'mine',
    topNote: f !== 'mine',          // 顶部说明只描述内置风格墙
    mineGrid: f !== 'builtin',
    mineEmpty: f === 'mine' && mineCount === 0,
    xmpEmpty: f === 'all' && mineCount === 0,
  };
}

const MINE_EMPTY_TEXT = '还没有「我的卡」。用图库页的「导入 XMP 预设」生成第一张卡。';

/** 幂等构建 chips 行 + 「我的卡」空态提示，插入 #tab-style 顶部（内置墙说明之上） */
function buildStyleFilter(): void {
  if (typeof document === 'undefined' || document.getElementById('stylefilter')) return;
  const body = document.getElementById('tab-style');
  if (!body || !document.getElementById('style-grid')) return;
  const row = document.createElement('div');
  row.className = 'mx-row';
  row.style.margin = '0 0 6px';
  const lab = document.createElement('span');
  lab.className = 'mx-lab';
  lab.textContent = '分组';
  lab.title = STYLE_FILTERS[2].title;
  const btns = document.createElement('div');
  btns.className = 'mx-btns';
  btns.id = 'stylefilter';
  for (const f of STYLE_FILTERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mx-btn';
    b.dataset.filter = f.v;
    b.textContent = f.label;
    b.title = f.title;
    b.addEventListener('click', () => setStyleFilter(f.v));
    btns.appendChild(b);
  }
  row.appendChild(lab);
  row.appendChild(btns);
  const empty = document.createElement('div');
  empty.className = 'mx-note';
  empty.id = 'stylefilter-empty';
  empty.style.display = 'none';
  empty.textContent = MINE_EMPTY_TEXT;
  body.insertBefore(empty, body.firstChild);
  body.insertBefore(row, body.firstChild);
  applyStyleFilter();
}

function applyStyleFilter(): void {
  if (typeof document === 'undefined') return;
  const body = document.getElementById('tab-style');
  const grid = document.getElementById('style-grid');
  const xgrid = document.getElementById('xmp-grid');
  if (!body || !grid || !xgrid) return;
  const title = body.querySelector('.xmp-sec-title');
  const topNote = grid.previousElementSibling;   // 静态 HTML：#style-grid 的前一兄弟 = 内置墙说明
  const show = (el: Element | null, on: boolean): void => {
    if (el) (el as HTMLElement).style.display = on ? '' : 'none';
  };
  const p = styleFilterPlan(styleFilter, xgrid.childElementCount);
  for (const b of document.querySelectorAll<HTMLButtonElement>('#stylefilter .mx-btn')) {
    b.classList.toggle('on', b.dataset.filter === styleFilter);
  }
  show(grid, p.builtinGrid);
  show(topNote, p.topNote);
  show(xgrid, p.mineGrid);
  show(title, p.mineGrid);
  show(title ? title.nextElementSibling : null, p.mineGrid);   // XMP 小节的说明行
  show(document.getElementById('stylefilter-empty'), p.mineEmpty);
  show(document.getElementById('xmp-empty'), p.xmpEmpty);
}

/** 切分组（chips 点击与 demo 共用） */
export function setStyleFilter(f: StyleGroupFilter): void {
  styleFilter = f;
  applyStyleFilter();
}

/** 结构事实（E2E/demo 断言用；node 无 DOM 返回 null） */
export interface StyleFilterFacts {
  filter: StyleGroupFilter;
  chips: number;
  builtinVisible: boolean;
  mineVisible: boolean;
  topNoteVisible: boolean;
  mineCount: number;
  mineEmptyVisible: boolean;
}

export function styleFilterFacts(): StyleFilterFacts | null {
  if (typeof document === 'undefined') return null;
  const grid = document.getElementById('style-grid');
  const xgrid = document.getElementById('xmp-grid');
  if (!grid || !xgrid) return null;
  const vis = (el: Element | null): boolean => !!el && (el as HTMLElement).style.display !== 'none';
  return {
    filter: styleFilter,
    chips: document.querySelectorAll('#stylefilter .mx-btn').length,
    builtinVisible: vis(grid),
    mineVisible: vis(xgrid),
    topNoteVisible: vis(grid.previousElementSibling),
    mineCount: xgrid.childElementCount,
    mineEmptyVisible: vis(document.getElementById('stylefilter-empty')),
  };
}

/* ---------------- 宿主接线 ---------------- */

let deps: XmpDeps | null = null;

/** main.ts 动态加载后注入宿主能力（幂等） */
export function initXmpImport(d: XmpDeps): void {
  deps = d;
  buildStyleFilter();
  renderXmpGrid();
}

/** 渲染 #xmp-grid（风格卡 tab 内的小节；node 无 DOM 时安全空操作） */
export function renderXmpGrid(): void {
  if (typeof document === 'undefined') return;
  const grid = document.getElementById('xmp-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const cards = listXmpCards();
  for (const card of cards) grid.appendChild(xmpCardEl(card));
  applyStyleFilter();   // R19：空态提示/分组可见性统一由筛选层同步（「全部」视图保持 R15 语义）
}

function xmpCardEl(card: XmpCard): HTMLElement {
  const d = document.createElement('div');
  d.className = 'card';
  d.dataset.id = card.id;
  d.setAttribute('role', 'button');
  d.tabIndex = 0;
  d.setAttribute('aria-label', '应用 XMP 估算起点卡：' + card.name);
  d.title = card.note;
  if (card.thumb) {
    const img = document.createElement('img');
    img.src = card.thumb;
    img.alt = card.name;
    d.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'emptyimg';
    ph.textContent = '无缩略图';
    d.appendChild(ph);
  }
  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = card.name;
  d.appendChild(nm);
  const tag = document.createElement('div');
  tag.className = 'tag';
  tag.innerHTML = '<span class="o-estimated"></span>估算起点 · XMP 导入' +
    (card.unmappedCount > 0 ? ` · 未映射 ${card.unmappedCount} 项，需人工调校` : ' · 无未映射维度');
  d.appendChild(tag);
  const apply = (): void => {
    if (deps) deps.applyEntry(xmpEntry(card));
  };
  d.addEventListener('click', apply);
  d.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(); }
  });
  return d;
}

/**
 * 导入入口（真实按钮与 demo 共用）：逐个 解析→映射→建卡，单文件失败只记 failures，
 * 绝不中断整批；随后统一入库（上限裁剪）、刷新网格、toast 汇总并切到风格 tab。
 */
export async function importXmpEntries(entries: Array<{ name: string; text: string }>): Promise<XmpImportSummary> {
  const cards: XmpCard[] = [];
  const failures: Array<{ file: string; error: string }> = [];
  for (const ent of entries) {
    try {
      const mapping = await parseAndMap(ent.text);
      const thumb = renderXmpThumb(
        deps ? deps.frameCanvas() : null,
        deps ? deps.frameKey() : 'scene:neon',
        mapping.params.look,
        mapping.params.texture,
      );
      cards.push(await buildXmpCard(ent.name, mapping, thumb));
    } catch (err) {
      failures.push({ file: ent.name, error: (err as Error).message });
    }
  }
  const res = addXmpCards(cards);
  renderXmpGrid();
  const summary: XmpImportSummary = {
    requested: entries.length,
    imported: cards.length,
    failed: failures.length,
    failures,
    dropped: res.dropped,
    saved: res.saved,
    cards: cards.map((c) => ({
      id: c.id, name: c.name, source: c.source, note: c.note,
      unmappedCount: c.unmappedCount, unmappedTop: c.unmappedTop, hasThumb: c.thumb !== '',
    })),
  };
  let msg = `已导入 ${cards.length} 张（失败 ${failures.length}）`;
  if (res.dropped > 0) msg += `，超出上限丢弃 ${res.dropped} 张（上限 ${XMP_CARD_LIMIT}）`;
  if (!res.saved && cards.length > 0) msg = 'XMP 卡写入本地存储失败（存储空间不足？），刷新后将丢失。' + msg;
  if (failures.length > 0) {
    console.warn('[xmpimport] 失败明细：', failures);
    const detail = failures.map((f) => `${f.file}：${f.error}`).join('；');
    msg += ' ' + (detail.length > 140 ? detail.slice(0, 137) + '…（明细见控制台）' : detail);
  }
  if (deps) deps.toast(msg);
  setMeta({ xmpImport: summary });
  if (deps) deps.switchTab('style');
  return summary;
}

/** 真实文件入口：多选 .xmp 逐个读文本（读取失败同样只记失败、不中断整批） */
export async function importXmpFiles(files: File[]): Promise<XmpImportSummary> {
  const entries: Array<{ name: string; text: string }> = [];
  const failures: Array<{ file: string; error: string }> = [];
  for (const f of files) {
    try {
      entries.push({ name: f.name, text: await f.text() });
    } catch (err) {
      failures.push({ file: f.name, error: (err as Error).message });
    }
  }
  const summary = await importXmpEntries(entries);
  if (failures.length > 0 && deps) {
    deps.toast(`文件读取失败 ${failures.length} 个：` + failures.map((f) => f.file).join('、'));
  }
  return summary;
}

/** 点卡应用（与卡片 click 同一函数路径，demo 复用） */
export function applyXmpCard(card: XmpCard): void {
  if (deps) deps.applyEntry(xmpEntry(card));
}

/* ---------------- E2E demo：demo=xmpimport ----------------
 * 页面内合成 XMP（全部为合成 fixture；品牌词仅用于断言清洗生效），
 * 走与真实按钮完全相同的 importXmpEntries → 自检 + 写 #e2e-meta。
 * fixture 含品牌词 / 全中性 / 损坏 三类：断言「2 成功 + 1 失败不中断整批」。 */

export const DEMO_XMP = {
  brandFilename: 'Dehancer Warm Matte.xmp',   // 清洗后 → 'Warm Matte'
  brand: `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description crs:Version="15.4" crs:PresetType="Look" crs:Name="Warm Matte Demo" ` +
    `crs:Contrast2012="+25" crs:Shadows2012="-10" crs:IncrementalTemperature="+20" ` +
    `crs:SplitToningShadowHue="35" crs:SplitToningShadowSaturation="35" ` +
    `crs:SplitToningHighlightHue="45" crs:SplitToningHighlightSaturation="22" crs:SplitToningBalance="-10" ` +
    `crs:GrainAmount="30" crs:GrainSize="35" crs:GrainFrequency="65" ` +
    `crs:PostCropVignetteAmount="-28" crs:PostCropVignetteMidpoint="55" ` +
    `crs:SaturationAdjustmentRed="-15" crs:LuminanceAdjustmentOrange="+10" crs:Exposure2012="+0.25" ` +
    `crs:Vibrance="+12"></rdf:Description></rdf:RDF></x:xmpmeta>`,
  neutralFilename: 'Neutral Check.xmp',       // 清洗后同名；全中性参数 → 映射结果须与 defaultParams 逐字相等
  neutral: `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description crs:Version="15.4" crs:PresetType="Look" ` +
    `crs:Contrast2012="0" crs:Highlights2012="0" crs:Shadows2012="0" crs:Whites2012="0" crs:Blacks2012="0" ` +
    `crs:ParametricShadows="0" crs:ParametricDarks="0" crs:ParametricLights="0" crs:ParametricHighlights="0" ` +
    `crs:Saturation="0" crs:IncrementalTemperature="0" crs:Exposure2012="0" crs:Vibrance="0" crs:IncrementalTint="0" ` +
    `crs:SplitToningShadowHue="0" crs:SplitToningShadowSaturation="0" ` +
    `crs:SplitToningHighlightHue="0" crs:SplitToningHighlightSaturation="0" crs:SplitToningBalance="0" ` +
    `crs:GrainAmount="0" crs:GrainSize="25" crs:GrainFrequency="50" ` +
    `crs:PostCropVignetteAmount="0" crs:PostCropVignetteMidpoint="50">` +
    `<crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012>` +
    `</rdf:Description></rdf:RDF></x:xmpmeta>`,
  brokenFilename: 'broken-not-xmp.xmp',
  broken: 'this is not an xmp preset, just plain text',
};

interface AppliedCheck {
  card: string;
  viaDomClick: boolean;
  stateMatchesCard: boolean;
  recipeMatchesCard: boolean;
  originsAllEstimated: boolean;
}

/** 在真实 DOM 上点卡（走卡片 click 监听同一路径）后核对配方与卡参数一致 */
function applyViaDomClick(card: XmpCard): AppliedCheck {
  const el = document.querySelector<HTMLElement>(`#xmp-grid .card[data-id="${card.id}"]`);
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const st = deps ? deps.getState() : null;
  const recipe = deps ? deps.getRecipe() : null;
  return {
    card: card.name,
    viaDomClick: !!el,
    stateMatchesCard: !!st && deepEq({ look: st.look, texture: st.texture }, { look: card.look, texture: card.texture }),
    recipeMatchesCard: recipeMatchesCard(recipe, card),
    originsAllEstimated: !!st && Object.values(st.origins).every((o) => o === 'estimated'),
  };
}

/**
 * demo=xmpimport[&apply=brand][&filter=mine|builtin]：清卡 → 合成 3 文件导入（2 好 1 坏）→ 断言/上报。
 * apply=brand 时最后再点品牌卡（p8-06 截图用：画面可辨的暖调哑光效果）。
 * R19：另跑三分组筛选往返（空态 → 我的卡 → 内置风格 → 恢复），&filter 让场景结束在指定分组
 * （p8-07 截图用「我的卡」态）；filter 参数在本模块（动态 chunk）自读 hash——main.ts 零改动。
 */
export async function demoXmpImport(applyBrand = false): Promise<void> {
  clearXmpCards();
  renderXmpGrid();                            // 网格与存储同步（同页重复跑 demo 也确定）
  setStyleFilter('mine');                     // 空态事实：0 卡 + 「我的卡」→ 专用空态提示
  const mineEmpty = styleFilterFacts();
  setStyleFilter('all');
  const summary = await importXmpEntries([
    { name: DEMO_XMP.brandFilename, text: DEMO_XMP.brand },
    { name: DEMO_XMP.neutralFilename, text: DEMO_XMP.neutral },
    { name: DEMO_XMP.brokenFilename, text: DEMO_XMP.broken },
  ]);
  const cards = listXmpCards();
  const neutral = cards.find((c) => c.source === 'xmp:Neutral Check') ?? null;
  const brand = cards.find((c) => c.source === 'xmp:Warm Matte') ?? null;
  const neutralIsDefault = !!neutral &&
    deepEq({ look: neutral.look, texture: neutral.texture }, { look: defaultLook(), texture: defaultTexture() });
  let applied: AppliedCheck | null = null;
  let appliedBrand: AppliedCheck | null = null;
  if (neutral) applied = applyViaDomClick(neutral);
  if (applyBrand && brand) appliedBrand = applyViaDomClick(brand);
  /* R19 三分组筛选往返（纯显示层）：「我的卡」只显 XMP 卡 → 「内置风格」反之 → 恢复「全部」 */
  setStyleFilter('mine');
  const mine = styleFilterFacts();
  setStyleFilter('builtin');
  const builtin = styleFilterFacts();
  const fh = typeof location !== 'undefined' ? new URLSearchParams(location.hash.slice(1)).get('filter') : null;
  const final: StyleGroupFilter = fh === 'mine' || fh === 'builtin' ? fh : 'all';
  setStyleFilter(final);
  const restored = styleFilterFacts();
  setMeta({
    xmpImport: {
      ...summary,
      neutralIsDefault,
      applied,
      appliedBrand,
      cardCount: cards.length,
      styleFilter: {
        chips: mine?.chips ?? 0,
        mineEmpty,
        mine,
        builtin,
        final,
        restored,
      },
    },
  });
}
