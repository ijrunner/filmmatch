/**
 * 配方模型（Schema v1）与引擎/效果层之间的桥。
 *
 * 职责：
 * - 组装/解析完整配方 JSON（docs/prd/配方Schema-v1.md 全结构 + 两处向后兼容扩展）；
 * - 配方 → 预览运行时参数（film/params 的 FilmParams + 引擎 MatchParams）；
 * - 「匹配变换 ∘ look 变换」复合纯函数 → 3D LUT 烘焙（预览与 .cube 导出同源）；
 * - 本地配方码（FM-XXXX，内容 hash）与 id 生成。
 *
 * Schema v1 扩展（只增不删，读方忽略未知字段）：
 * - meta.stats: { ref, source } —— 参考图/被调色图统计快照，使配方可离线重建预览与 LUT；
 * - master: { value, origin } —— 质感全局强度（texture 段之外的运行时参数）；
 * - texture.profile: { grain, halation } —— R2 档位来源（颗粒 profile id + 光晕档），
 *   读方缺省回落 DEFAULT_PROFILE（见 film/grainmatrix.ts）。
 */
import {
  buildTransform,
  normalizeDataRange,
  normalizeParams as normalizeMatch,
  rangeWrap,
  withSource,
  type DataRange,
  type ImageStats,
  type MatchParams,
  type RGB,
} from '../engine';
import { bakeLUT, type LUT3D } from '../engine/lut';
import { lookTransform, type LookParams as EngineLook } from '../engine/look';
import {
  lookToSchema,
  normalizeParams as normalizeFilm,
  textureToSchema,
  type CardAnchorsT,
  type LookParams,
  type Origin,
  type TextureParams,
} from '../film/params';
import { normalizeProfileRef, type TextureProfileRef } from '../film/grainmatrix';
import { shortCodeWithCheck } from '../share/code';

export type { Origin };

/** 当前写出的配方 Schema 版本（R18/Schema v1.3：color.look 新增可选 coupling/hsl + 顶层可选 anchors） */
export const SCHEMA_VERSION = 1.3;
/** 可读入的版本（含历史 v1 / v1.1 / v1.2：缺字段由 normalizeParams 按恒等默认补齐）。
 *  v1.1 与 v1 的 JSON 都以 1 写出；1.1/1.2/1.3 为文档版本号，读方一并接受。 */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1, 1.1, 1.2, 1.3];
export function isSupportedSchemaVersion(v: unknown): boolean {
  return typeof v === 'number' && SUPPORTED_SCHEMA_VERSIONS.includes(v);
}

/** 配方 JSON 全结构（schema_version 1.3；读方兼容 1 / 1.1 / 1.2） */
export interface Recipe {
  schema_version: 1 | 1.1 | 1.2 | 1.3;
  id: string;
  share_code: string;
  name: string;
  meta: {
    created_at: string;
    author: string;
    source: {
      type: 'library' | 'upload' | 'stock';
      ref_image_id: string | null;
      stock_id: string | null;
    };
    /** 扩展字段：统计快照（离线重建预览/LUT 用） */
    stats?: { ref: ImageStats | null; source: ImageStats | null };
  };
  color: {
    engine: 'colormatch-v1';
    params: MatchParams;
    /** look 段（Schema v1.1 建议；预览/导出均消费。v1.3 起可含 coupling/hsl 可选子对象） */
    look: Record<string, { value: number; origin: Origin }>;
    lut_size: 33 | 65;
  };
  texture: {
    halation: Record<string, unknown>;
    grain: Record<string, unknown>;
    bloom: Record<string, unknown>;
    vignette: Record<string, unknown>;
    /** R9 片门抖动（默认关闭；读方缺省回落 amount=0/speed=1） */
    gate_weave?: Record<string, unknown>;
    /** R2 扩展字段：颗粒/光晕档位来源（读方缺省回落 DEFAULT_PROFILE） */
    profile?: TextureProfileRef;
  };
  /** 扩展字段：质感全局强度 */
  master?: { value: number; origin: Origin };
  /** R18（Schema v1.3，可选）：按管线锚点（归一化域 black/white/pivot）。
   *  切 DCTL 管线时用目标管线锚点重标定 look；旧配方无此字段 → 行为逐位不变。 */
  anchors?: CardAnchorsT;
  output: {
    working_space: 'rec709';
    export_targets: string[];
    /** R17 可选扩展：.cube 导出数据范围声明（'full'=Full/Data 0..1；'legal'=Video/Legal）。
     *  预览画面不变，仅导出语义；缺省/缺字段/非法值读为 'full'（旧配方观感与导出逐位不变）。 */
    range?: DataRange;
  };
}

/** 工作台当前的配方运行时状态（recipe 的 TS 侧镜像，UI 直接驱动预览） */
export interface RecipeState {
  colorParams: MatchParams;
  look: LookParams;
  texture: TextureParams;
  master: number;
  origins: Record<string, Origin>;
  refStats: ImageStats | null;   // 参考图统计（未挂 source）
  userStats: ImageStats | null;  // 被调色图统计
  /** R2：当前颗粒/光晕档位来源。可选——initRecipeState（ui/store.ts）不产出，
   *  读取方一律经 normalizeProfileRef 兜底为 DEFAULT_PROFILE。 */
  profile?: TextureProfileRef;
  /** R17：.cube 导出数据范围声明（'full' 默认，预览不变；undefined 读为 'full'） */
  range?: DataRange;
  /** R18：按管线锚点（可选；卡/配方携带时 DCTL 切管线重标定 look，undefined = 行为不变） */
  anchors?: CardAnchorsT;
}

/* ---------------- 生成 ---------------- */

const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去 I/L/O/0/1 防混淆

function randChars(n: number): string {
  let s = '';
  const buf = new Uint32Array(n);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < n; i++) s += ID_ALPHABET[buf[i] % ID_ALPHABET.length];
  } else {
    for (let i = 0; i < n; i++) s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return s;
}

export function makeId(): string {
  return 'fm_' + randChars(5).toLowerCase();
}

/** FNV-1a 32 位 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 配方码：由配方内容（color/texture/master/profile，不含 id/时间）hash 生成，FM-XXXX = 3 数据位 + 1 校验位（F11） */
export function shareCodeOf(state: Pick<RecipeState, 'colorParams' | 'look' | 'texture' | 'master' | 'profile'>): string {
  const basis = JSON.stringify({
    c: state.colorParams,
    l: state.look,
    t: state.texture,
    m: Math.round(state.master * 100),
    // R2：档位来源是配方内容的一部分（未指定时回落默认档）
    p: normalizeProfileRef(state.profile),
  });
  let h = fnv1a(basis);
  let data = '';
  for (let i = 0; i < 3; i++) {
    data += ID_ALPHABET[h % ID_ALPHABET.length];
    h = Math.floor(h / ID_ALPHABET.length);
  }
  return shortCodeWithCheck(data)!;
}

/** 色彩九参数起点：图库/上传 = match_strength 0.75 其余中性；选型号 = 无统计对齐（全中性） */
export function defaultColorParams(neutral: boolean): MatchParams {
  const base = normalizeMatch(null);
  return neutral ? base : { ...base, match_strength: 0.75 };
}

export interface BuildRecipeOpts {
  name: string;
  sourceType: Recipe['meta']['source']['type'];
  refImageId: string | null;
  stockId: string | null;
  state: RecipeState;
  id?: string;
  createdFrom?: string; // 调试用作者标注，MVP 固定 'local'
}

/** 组装完整配方 JSON（schema_version 1.2 全结构，id/share_code 本地生成） */
export function buildRecipe(opts: BuildRecipeOpts): Recipe {
  const s = opts.state;
  return {
    schema_version: SCHEMA_VERSION,
    id: opts.id ?? makeId(),
    share_code: shareCodeOf(s),
    name: opts.name,
    meta: {
      created_at: new Date().toISOString(),
      author: 'local',
      source: { type: opts.sourceType, ref_image_id: opts.refImageId, stock_id: opts.stockId },
      stats: { ref: s.refStats, source: s.userStats },
    },
    color: {
      engine: 'colormatch-v1',
      params: normalizeMatch(s.colorParams),
      look: lookToSchema(s.look, s.origins) as Recipe['color']['look'],
      lut_size: 65,
    },
    texture: { ...textureToSchema(s.texture, s.origins), profile: normalizeProfileRef(s.profile) },
    master: { value: +s.master.toFixed(3), origin: s.origins['master'] ?? 'user' },
    /* R18：锚点仅在配方携带时写出（旧配方不添新键；schema_version 仍为 1.3） */
    ...(s.anchors ? { anchors: s.anchors } : {}),
    output: {
      working_space: 'rec709',
      export_targets: ['cube', 'drx', 'recipe_code'],
      range: s.range === 'legal' ? 'legal' : 'full',
    },
  };
}

/* ---------------- 解析（配方 → 运行时） ---------------- */

/** 配方 JSON → 工作台运行时状态（容忍缺字段；统计快照缺省为 null） */
export function recipeToState(recipe: Recipe): RecipeState {
  const film = normalizeFilm({
    texture: recipe.texture as never,
    look: recipe.color?.look as never,
    master: (recipe.master as { value?: number } | undefined)?.value ?? 1,
  });
  const origins: Record<string, Origin> = {};
  const grab = (prefix: string, obj: Record<string, { origin?: Origin }> | undefined) => {
    if (!obj) return;
    for (const [k, v] of Object.entries(obj)) {
      /* R18：嵌套子对象（look.coupling / look.hsl）下探收集 origins（look.coupling.rg / look.hsl.red.hue） */
      if (v && typeof v === 'object' && !('origin' in v) && (k === 'coupling' || k === 'hsl')) {
        if (k === 'coupling') grab(`${prefix}.coupling`, v as Record<string, { origin?: Origin }>);
        else {
          for (const [hue, cells] of Object.entries(v as Record<string, Record<string, { origin?: Origin }>>)) {
            grab(`look.hsl.${hue}`, cells);
          }
        }
        continue;
      }
      if (v && typeof v === 'object' && 'origin' in v) origins[`${prefix}.${k}`] = v.origin as Origin;
    }
  };
  for (const g of ['halation', 'grain', 'bloom', 'vignette', 'gate_weave'] as const) {
    grab(g, recipe.texture?.[g] as unknown as Record<string, { origin?: Origin }>);
  }
  grab('look', recipe.color?.look as unknown as Record<string, { origin?: Origin }>);
  origins['master'] = (recipe.master as { origin?: Origin } | undefined)?.origin ?? 'user';
  return {
    colorParams: normalizeMatch(recipe.color?.params),
    look: film.look,
    texture: film.texture,
    master: film.master,
    origins,
    refStats: recipe.meta?.stats?.ref ?? null,
    userStats: recipe.meta?.stats?.source ?? null,
    // R2：容错读回档位来源（缺字段/非法值 → DEFAULT_PROFILE）
    profile: normalizeProfileRef(recipe.texture?.profile),
    // R17：数据范围声明（缺字段/非法值 → 'full'；旧配方读入观感与导出逐位不变）
    range: normalizeDataRange((recipe.output as { range?: unknown } | undefined)?.range),
    // R18：按管线锚点（可选；缺字段/形状非法 → undefined，行为不变）
    anchors: normalizeAnchors((recipe as { anchors?: unknown }).anchors),
  };
}

/** R18：锚点字段容错读回（形状非法/数值非有限 → undefined；不做静默修正） */
function normalizeAnchors(raw: unknown): CardAnchorsT | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const ok = (a: unknown): boolean => {
    if (!a || typeof a !== 'object') return false;
    const o = a as Record<string, unknown>;
    return [o.black, o.white, o.pivot].every((v) => typeof v === 'number' && Number.isFinite(v));
  };
  const src = raw as Record<string, unknown>;
  const out: CardAnchorsT = {};
  if (ok(src.yrgb)) out.yrgb = src.yrgb as CardAnchorsT['yrgb'];
  if (ok(src.rcm)) out.rcm = src.rcm as CardAnchorsT['rcm'];
  return out.yrgb || out.rcm ? out : undefined;
}

/* ---------------- 预览/导出同源：复合变换与 LUT 烘焙 ---------------- */

/**
 * 「匹配变换 ∘ look 变换」复合纯函数。
 * - 有参考+被调色统计：match = buildTransform(withSource(ref, user), params)；
 * - 缺统计（选型号直出）：match 恒等，仅 look 生效。
 * neutral look 时 lookTransform 严格恒等。
 */
export function compositeTransform(state: RecipeState): (rgb: RGB) => RGB {
  const lookFn = lookTransform(state.look as unknown as EngineLook);
  if (!state.refStats || !state.userStats) return lookFn;
  const match = buildTransform(withSource(state.refStats, state.userStats), state.colorParams);
  return (rgb) => lookFn(match(rgb));
}

/**
 * 烘焙复合 LUT（65³；**导出 .cube / 批量包仍用此路径**——必须承载完整观感「匹配∘look」）。
 * R17 range：'full'（默认）与既有路径**同一函数引用**，逐位一致；'legal' 时输入端
 * Legal→Full 展开 + 输出端 Full→Legal 回编（见 engine/lut.rangeWrap，仅导出语义、预览不变）。
 */
export function bakeRecipeLUT(state: RecipeState, size: 33 | 65 = 65, range: DataRange = 'full'): LUT3D {
  return bakeLUT(rangeWrap(compositeTransform(state), range), size);
}

/**
 * 仅「匹配变换」（不含 look）。R10：预览把 look 搬进片元着色器（uniform），
 * LUT 只承载匹配 → look 滑杆拖动零重烘，只有匹配参数（colorParams/统计）变化才重烘。
 * 无参考/被调色统计（型号直出）时匹配恒等，返回 null（调用方无需挂 LUT）。
 */
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function matchTransform(state: RecipeState): ((rgb: RGB) => RGB) | null {
  if (!state.refStats || !state.userStats) return null;
  return buildTransform(withSource(state.refStats, state.userStats), state.colorParams);
}

/**
 * 烘焙**仅匹配**的 LUT（预览用；33³ 快 / 65³ 精）。
 * 无统计时返回恒等 LUT（调用方一般用 matchTransform===null 判断、直接不挂 LUT）。
 * 预览由 GRADE_FS 在 LUT 取样后叠加 shader look，故与 bakeRecipeLUT 复合路径等价（见 lookshader.test.ts）。
 */
export function bakeMatchLUT(state: RecipeState, size: 33 | 65 = 65): LUT3D {
  const m = matchTransform(state);
  return bakeLUT(m ?? ((rgb: RGB): RGB => [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])]), size);
}
