/**
 * 配方存储封装（决策 0003 · F7 本地降级契约）。
 *
 * 接口签名按未来云端 API 形状设计：save/load/list/remove/exportFile/importFile/码本。
 * V2 换云端后端时只改本模块，UI 与配方模型不动。
 *
 * MVP 实现：
 * - localStorage 持久化（不可用时退化为内存 Map，功能不中断）；
 * - .json 文件导出/导入走 Blob + <a download>（仅浏览器可用，node 测试走 parse/serialize 纯函数）；
 * - 配方码（FM-XXXX）为本地短码，码本（share_code → id）随配方列表一起持久化；
 * - F11：短码带校验位，码本冲突自增（bumpShortCode），码本可导出/导入 .json 分享。
 */
import { bumpShortCode } from '../share/code';

const SHORT_ALPHABET_LEN = 31;

/** 配方 JSON 结构（Schema v1，见 docs/prd/配方Schema-v1.md；字段由 ui/recipe.ts 组装）。
 *  只约定存储层必需的三字段，其余按 unknown 透传（云端实现同样只做透明持久化）。 */
export interface RecipeLike {
  schema_version: number;
  id: string;
  share_code: string;
}

export interface StoredRecipe {
  id: string;
  saved_at: string;
  recipe: RecipeLike;
}

const LS_RECIPES = 'filmmatch.recipes.v1';
const LS_CODEBOOK = 'filmmatch.codebook.v1';
const LS_USERREFS = 'filmmatch.userrefs.v1';

/* ---------------- 底层存取（localStorage / 内存兜底） ---------------- */

interface MemStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const mem: Map<string, string> = new Map();
const memoryStore: MemStore = {
  getItem: (k) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k, v) => void mem.set(k, v),
  removeItem: (k) => void mem.delete(k),
};

function backend(): MemStore {
  try {
    const ls = (globalThis as { localStorage?: MemStore }).localStorage;
    if (ls && typeof ls.getItem === 'function') {
      // 探测可写（隐私模式可能只读或抛错）
      const probe = '__fm_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return ls;
    }
  } catch {
    /* 落到内存 */
  }
  return memoryStore;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = backend().getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    backend().setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 配方列表 ---------------- */

export function listRecipes(): StoredRecipe[] {
  return readJson<StoredRecipe[]>(LS_RECIPES, []);
}

/** 保存（按 recipe.id upsert），成功返回 true（配额满等写失败返回 false） */
export function saveRecipe(recipe: RecipeLike): boolean {
  if (!recipe || typeof recipe.id !== 'string' || !recipe.id) return false;
  const list = listRecipes().filter((r) => r.id !== recipe.id);
  list.unshift({ id: recipe.id, saved_at: new Date().toISOString(), recipe });
  return writeJson(LS_RECIPES, list);
}

export function loadRecipe(id: string): RecipeLike | null {
  return listRecipes().find((r) => r.id === id)?.recipe ?? null;
}

export function removeRecipe(id: string): void {
  writeJson(LS_RECIPES, listRecipes().filter((r) => r.id !== id));
  const book = codeBook();
  delete book[id];
  writeJson(LS_CODEBOOK, book);
}

/* ---------------- 码本（share_code → id） ---------------- */

export function codeBook(): Record<string, string> {
  return readJson<Record<string, string>>(LS_CODEBOOK, {});
}

export function registerCode(code: string, id: string): void {
  const book = codeBook();
  book[id] = code;
  writeJson(LS_CODEBOOK, book);
}

/** 按配方码查配方（P1 分享码导入的本地实现） */
export function findByCode(code: string): RecipeLike | null {
  const want = code.trim().toUpperCase();
  const hit = Object.entries(codeBook()).find(([, c]) => c.toUpperCase() === want);
  return hit ? loadRecipe(hit[0]) : null;
}

/** 短码冲突自增（F11）：码本中已有其他配方占用该码时按 31 进制 +1 重算校验位，直到空位 */
export function registerUniqueCode(id: string, code: string): string {
  let c = code.trim().toUpperCase();
  let guard = 0;
  while (guard++ < SHORT_ALPHABET_LEN ** 3) {
    const clash = Object.entries(codeBook()).some(([rid, rc]) => rid !== id && rc.toUpperCase() === c);
    if (!clash) break;
    c = bumpShortCode(c);
  }
  registerCode(c, id);
  return c;
}

/* ---------------- 码本导入/导出（.json，F11） ---------------- */

export interface CodebookFile {
  version: 1;
  kind: 'filmmatch-codebook';
  exported_at: string;
  /** 短码 ↔ 配方 id 绑定（短码分享需配对码本） */
  codes: Array<{ code: string; id: string; name?: string }>;
}

/** 本地码本 → 可分享 .json 文本 */
export function serializeCodeBook(): string {
  const book = codeBook();
  const file: CodebookFile = {
    version: 1,
    kind: 'filmmatch-codebook',
    exported_at: new Date().toISOString(),
    codes: Object.entries(book).map(([id, code]) => ({
      code,
      id,
      name: (loadRecipe(id) as { name?: string } | null)?.name,
    })),
  };
  return JSON.stringify(file, null, 2);
}

/** 解析并校验码本文件文本（解析即校验） */
export function parseCodeBook(text: string): CodebookFile {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('码本文件不是合法 JSON');
  }
  const f = obj as CodebookFile;
  if (!f || typeof f !== 'object' || f.kind !== 'filmmatch-codebook' || f.version !== 1)
    throw new Error('不是 FilmMatch 码本文件（缺少 kind/version 标识）');
  if (!Array.isArray(f.codes)) throw new Error('码本缺少 codes 数组');
  return f;
}

/** 码本合并：仅接受格式合法的短码条目，返回（导入数, 跳过数） */
export function mergeCodeBook(file: CodebookFile): { imported: number; skipped: number } {
  let imported = 0;
  let skipped = 0;
  for (const e of file.codes ?? []) {
    if (!e || typeof e.code !== 'string' || typeof e.id !== 'string' ||
      !/^FM-[A-Z2-9]{4}$/.test(e.code.toUpperCase()) || !e.id) {
      skipped++;
      continue;
    }
    registerCode(e.code.toUpperCase(), e.id);
    imported++;
  }
  return { imported, skipped };
}

/* ---------------- 用户自传参考图（图库入库，localStorage） ---------------- */

export interface StoredRef {
  id: string;
  name: string;
  /** 缩略图 dataURL（≤480px JPEG） */
  thumb: string;
  /** analyzeImage 统计（JSON 可序列化） */
  stats: unknown;
  /** 旧条目 = estimateTexture 估算结果；v1.1 标注编辑器保存后 = 完整 TextureParams */
  texture: unknown;
  created_at: string;
  /** v1.1 扩展（标注编辑器）：完整 look 参数（缺省 = 中性 look） */
  look?: unknown;
  /** v1.1 扩展：origin 表（路径如 "grain.iso" / "look.fade"），缺省全按 estimated */
  origins?: Record<string, string>;
  /** v1.1 扩展：标注来源与说明（缺省 = 估算起点文案） */
  annotation?: { origin: string; note: string };
  /** v1.1 扩展：true = 用户编辑/另存的标注（区别于纯估算条目） */
  edited?: boolean;
}

const MAX_USERREFS = 12;

export function listUserRefs(): StoredRef[] {
  return readJson<StoredRef[]>(LS_USERREFS, []);
}

export function saveUserRef(ref: StoredRef): boolean {
  const list = listUserRefs().filter((r) => r.id !== ref.id);
  list.unshift(ref);
  while (list.length > MAX_USERREFS) list.pop();
  return writeJson(LS_USERREFS, list);
}

export function removeUserRef(id: string): void {
  writeJson(LS_USERREFS, listUserRefs().filter((r) => r.id !== id));
}

/** 原位更新用户条目（标注编辑器保存；保持列表顺序，不清将旧条目挤出新列） */
export function updateUserRef(id: string, patch: Partial<StoredRef>): boolean {
  const list = listUserRefs();
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) return false;
  list[i] = { ...list[i], ...patch };
  return writeJson(LS_USERREFS, list);
}

/* ---------------- 文件导出/导入（浏览器） ---------------- */

/** 配方 → .json 文件文本（导入导出共用，测试覆盖） */
export function serializeRecipe(recipe: RecipeLike): string {
  return JSON.stringify(recipe, null, 2);
}

/** 解析并校验配方文件文本（解析即校验） */
export function parseRecipe(text: string): RecipeLike {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('配方文件不是合法 JSON');
  }
  const r = obj as RecipeLike;
  if (!r || typeof r !== 'object') throw new Error('配方文件内容为空');
  /* Schema 版本：接受 1 / 1.1 / 1.2 / 1.3（v1.2 分离色调、v1.3 coupling/hsl/anchors；
   * 读方对旧配方按恒等默认补齐；见 docs/prd/配方Schema-v1.3.md） */
  if (![1, 1.1, 1.2, 1.3].includes(r.schema_version)) throw new Error(`不支持的配方版本：${String(r.schema_version)}（期望 1 / 1.1 / 1.2 / 1.3）`);
  if (typeof r.id !== 'string' || !r.id) throw new Error('配方缺少 id');
  const full = r as unknown as { color?: unknown; texture?: unknown };
  if (!full.color || !full.texture) throw new Error('配方缺少 color/texture 段');
  validateRecipeRanges(r);
  return r;
}

/* ---------------- 字段区间校验（R8 导入健壮性） ----------------
 * 目的：坏文件（越界/非有限值）给出可读错误，而不是静默钳制或崩在渲染里。
 * 区间取「运行时钳制范围」（engine/look 的 clamp）而非面板滑杆范围——面板范围更窄，
 * 用它会把历史配方里合法的 1.5× 饱和等值误判为越界。 */
type Bounds = [number, number];
const LOOK_BOUNDS: Record<string, Bounds> = {
  fade: [0, 1], black_lift: [0, 1], dye_coupling: [0, 0.5], shadow_bias: [-1, 1], highlight_bias: [-1, 1],
  film_s: [0, 1], contrast: [0, 1], saturation: [0, 2], warmth: [-1, 1],
  split_shadow_hue: [0, 1], split_shadow_sat: [0, 1], split_highlight_hue: [0, 1], split_highlight_sat: [0, 1],
  split_balance: [-1, 1],
};
/* —— Schema v1.3（R18）：嵌套的 coupling 六系数与 HSL 8 色相、顶层 anchors —— */
const COUPLING_BOUNDS: Record<string, Bounds> = {
  rg: [0, 2], rb: [0, 2], gr: [0, 2], gb: [0, 2], br: [0, 2], bg: [0, 2],
};
const HSL_BOUNDS: Record<string, Bounds> = { hue: [-1, 1], sat: [-1, 1], lum: [-1, 1] };
const ANCHOR_BOUNDS: Bounds = [0, 1];
/** 质感段：数值必须有限；tint_rgb 逐分量 0..1，其余非负且量级合理（防御脏数据） */
const TEX_NONNEG_MAX = 1e4;
const TEX_PATHS: Record<string, Bounds> = {
  'halation.tint_rgb': [0, 1],
};

function isWrapped(v: unknown): v is { value: number } {
  return typeof v === 'object' && v !== null && 'value' in (v as Record<string, unknown>);
}

/** 校验配方 JSON 的 look/texture 数值区间；越界或非有限值抛可读错误（含字段路径与允许范围） */
export function validateRecipeRanges(r: RecipeLike): void {
  const bad = (path: string, v: unknown, lo: number, hi: number): never => {
    throw new Error(`配方字段越界：${path}=${String(v)}（应为有限数且在 ${lo}..${hi} 之间）`);
  };
  const num = (path: string, raw: unknown, lo: number, hi: number): void => {
    const v = isWrapped(raw) ? (raw as { value: unknown }).value : raw;
    if (typeof v !== 'number' || !Number.isFinite(v)) bad(path, v, lo, hi);
    const n = v as number;
    if (n < lo || n > hi) bad(path, v, lo, hi);
  };
  const color = (r as unknown as { color?: { look?: Record<string, unknown> } }).color;
  const look = color?.look;
  if (look && typeof look === 'object') {
    for (const [k, v] of Object.entries(look)) {
      if (v === undefined || v === null) continue;
      if (k === 'coupling' && typeof v === 'object') {
        /* Schema v1.3：coupling 六系数（包装值或裸数值，逐键校验） */
        for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) {
          const b = COUPLING_BOUNDS[ck];
          if (!b) continue;
          num(`color.look.coupling.${ck}`, cv, b[0], b[1]);
        }
        continue;
      }
      if (k === 'hsl' && typeof v === 'object') {
        /* Schema v1.3：HSL 8 色相 × hue/sat/lum（逐通道逐键校验） */
        for (const [hk, hv] of Object.entries(v as Record<string, unknown>)) {
          if (!hv || typeof hv !== 'object') continue;
          for (const [sk, sv] of Object.entries(hv as Record<string, unknown>)) {
            const b = HSL_BOUNDS[sk];
            if (!b) continue;
            num(`color.look.hsl.${hk}.${sk}`, sv, b[0], b[1]);
          }
        }
        continue;
      }
      const b = LOOK_BOUNDS[k];
      if (b) num(`color.look.${k}`, v, b[0], b[1]);
    }
  }
  /* Schema v1.3：顶层 anchors（yrgb/rcm × black/white/pivot，全部 0..1） */
  const anchors = (r as unknown as { anchors?: Record<string, unknown> }).anchors;
  if (anchors && typeof anchors === 'object') {
    for (const pipe of ['yrgb', 'rcm'] as const) {
      const a = anchors[pipe];
      if (!a || typeof a !== 'object') continue;
      for (const k of ['black', 'white', 'pivot'] as const) {
        const v = (a as Record<string, unknown>)[k];
        if (v === undefined || v === null) continue;
        num(`anchors.${pipe}.${k}`, v, ANCHOR_BOUNDS[0], ANCHOR_BOUNDS[1]);
      }
    }
  }
  const tex = (r as unknown as { texture?: Record<string, unknown> }).texture;
  if (tex && typeof tex === 'object') {
    for (const g of ['halation', 'grain', 'bloom', 'vignette', 'gate_weave'] as const) {
      const grp = tex[g];
      if (!grp || typeof grp !== 'object') continue;
      for (const [k, v] of Object.entries(grp as Record<string, unknown>)) {
        if (v === undefined || v === null || typeof v === 'boolean' || typeof v === 'string') continue;
        const raw = isWrapped(v) ? (v as { value: unknown }).value : v;
        if (raw === undefined || raw === null) continue;
        const b = TEX_PATHS[`${g}.${k}`] ?? [0, TEX_NONNEG_MAX];
        if (Array.isArray(raw)) {
          for (const x of raw) num(`texture.${g}.${k}[]`, x, b[0], b[1]);
        } else {
          num(`texture.${g}.${k}`, raw, b[0], b[1]);
        }
      }
    }
  }
}

/** 触发浏览器下载 .json（headless/测试环境可能无效，调用方自行提示） */
export function exportFile(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/** 从 File 读配方（浏览器） */
export async function importRecipeFile(file: File): Promise<RecipeLike> {
  return parseRecipe(await file.text());
}
