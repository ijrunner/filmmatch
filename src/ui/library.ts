/**
 * 参考图库（F2/F4）：
 * - 内置 ≥6 个标注条目：film/scenes.ts 程序化场景 × FL 预设卡派生标注。
 *   缩略图 = 场景图经 lookTransform（预设卡 look）调色后的 JPEG dataURL，
 *   stats 用 analyzeImage 对缩略图现算（JSON 可持久化），texture/look 标注 origin=annotated。
 * - 用户自传参考图入库（localStorage）：自动分析 + 质感估算（estimated）。
 * - 选型号（stock）：不产生参考图，只派生标注卡。
 */
import { analyzeImage, type ImageStats } from '../engine';
import { lookTransform } from '../engine/look';
import { drawChart, drawDusk, drawNeon } from '../film/scenes';
import {
  getPreset, normalizeParams as normalizeFilm, STOCK_IDS, STYLE_IDS,
  type GrainParams, type HalationParams, type LookParams, type Origin, type TextureParams,
} from '../film/params';
import type { EstimateDebug, TextureEstimate } from '../estimate/estimate';
import type { TextureProfileRef } from '../film/grainmatrix';
import * as storage from './storage';

export type SceneId = 'neon' | 'dusk' | 'chart';

export interface RefAnnotation {
  /** texture/look 的 origin（'annotated' | 'estimated'）与说明 */
  origin: Origin;
  note: string;
}

export interface LibraryEntry {
  id: string;
  name: string;
  kind: 'library' | 'upload' | 'stock';
  scene: SceneId | null;
  presetId: string;
  /** 缩略图 dataURL（stock 类为空） */
  thumb: string;
  stats: ImageStats | null;
  look: LookParams;
  texture: TextureParams;
  origins: Record<string, Origin>;
  annotation: RefAnnotation;
  /** R2：型号卡的档位来源（颗粒 profile + 光晕档）；图库/上传条目缺省 */
  profile?: TextureProfileRef;
}

const THUMB_W = 480;
const THUMB_H = 270;

/** 内置条目定义：场景 × FL 卡派生标注 */
const BUILTIN_DEFS: Array<{ scene: SceneId; preset: string; title: string }> = [
  { scene: 'neon', preset: 'fl05', title: '霓虹夜色 × 光匣' },
  { scene: 'neon', preset: 'fl07', title: '霓虹夜色 × 灯下' },
  { scene: 'neon', preset: 'fl06', title: '霓虹夜色 × 晨负' },
  { scene: 'dusk', preset: 'fl06', title: '黄昏逆光 × 晨负' },
  { scene: 'dusk', preset: 'fl08', title: '黄昏逆光 × 褪色' },
  { scene: 'dusk', preset: 'fl04', title: '黄昏逆光 × 印相' },
  { scene: 'dusk', preset: 'neutral', title: '黄昏逆光 × 中性基准' },
];

function drawScene(scene: SceneId, c: CanvasRenderingContext2D, w: number, h: number): void {
  if (scene === 'neon') drawNeon(c, w, h);
  else if (scene === 'dusk') drawDusk(c, w, h);
  else drawChart(c, w, h);
}

let builtinCache: LibraryEntry[] | null = null;

/** 内置图库（懒构建，进程内缓存） */
export function builtinLibrary(): LibraryEntry[] {
  if (builtinCache) return builtinCache;
  const cv = document.createElement('canvas');
  cv.width = THUMB_W;
  cv.height = THUMB_H;
  const c = cv.getContext('2d')!;
  builtinCache = BUILTIN_DEFS.map((def) => {
    const card = getPreset(def.preset);
    drawScene(def.scene, c, THUMB_W, THUMB_H);
    // 缩略图经预设卡 look 调色，代表「一张已带胶片特征的参考剧照」
    const img = c.getImageData(0, 0, THUMB_W, THUMB_H);
    const fn = lookTransform(card.params.look);
    const rgb: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < img.data.length; i += 4) {
      rgb[0] = img.data[i] / 255;
      rgb[1] = img.data[i + 1] / 255;
      rgb[2] = img.data[i + 2] / 255;
      const o = fn(rgb);
      img.data[i] = o[0] * 255;
      img.data[i + 1] = o[1] * 255;
      img.data[i + 2] = o[2] * 255;
    }
    c.putImageData(img, 0, 0);
    const stats = analyzeImage(img.data, THUMB_W, THUMB_H);
    return {
      id: `lib_${def.scene}_${def.preset}`,
      name: `${def.title} · ${card.name}`,
      kind: 'library' as const,
      scene: def.scene,
      presetId: card.id,
      thumb: cv.toDataURL('image/jpeg', 0.82),
      stats,
      look: card.params.look,
      texture: card.params.texture,
      origins: card.origins,
      annotation: { origin: 'annotated' as Origin, note: card.note },
    };
  });
  return builtinCache;
}

const NEUTRAL_LOOK_KEYS: Record<string, number> = {
  fade: 0, black_lift: 0, dye_coupling: 0, shadow_bias: 0, highlight_bias: 0,
  film_s: 0, contrast: 0, saturation: 1, warmth: 0,
  /* Schema v1.2 分离色调（默认恒等） */
  split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0,
};
const NEUTRAL_LOOK: LookParams = { ...NEUTRAL_LOOK_KEYS } as unknown as LookParams;

/** 旧条目判定：texture 为估算包装（grain.iso 是 {value} 对象）且无完整参数扩展 */
function isLegacyEstimate(stored: storage.StoredRef): boolean {
  if (stored.look !== undefined || stored.edited) return false;
  const iso = (stored.texture as { grain?: { iso?: unknown } } | null)?.grain?.iso;
  return typeof iso === 'object' && iso !== null;
}

/** 标注编辑保存的补丁（完整参数 + origin 表 + 说明） */
export interface AnnotationPatch {
  name?: string;
  look: LookParams;
  texture: TextureParams;
  origins: Record<string, Origin>;
  annotation: RefAnnotation;
}

/** 用户入库条目（localStorage）→ 图库条目视图。
 *  v1.1：标注编辑器保存过/另存的条目按存储的完整参数还原；旧条目走估算包装转换。 */
export function userLibrary(): LibraryEntry[] {
  return storage.listUserRefs().map((r) => {
    const legacy = isLegacyEstimate(r);
    const texture = legacy
      ? estimateToTexture(r.texture as TextureEstimate)
      : normalizeFilm({ texture: (r.texture ?? {}) as never }).texture;
    const look = { ...NEUTRAL_LOOK, ...((r.look as LookParams | undefined) ?? {}) };
    const origins: Record<string, Origin> = {};
    if (r.origins) {
      for (const [k, v] of Object.entries(r.origins)) origins[k] = v as Origin;
    } else {
      for (const g of ['halation', 'grain', 'bloom', 'vignette', 'gate_weave'] as const) {
        for (const k of Object.keys(texture[g] as unknown as Record<string, unknown>)) {
          if (k !== 'enabled') origins[`${g}.${k}`] = 'estimated';
        }
      }
      for (const k of Object.keys(NEUTRAL_LOOK_KEYS)) origins[`look.${k}`] = 'estimated';
      origins['master'] = 'estimated';
    }
    return {
      id: r.id,
      name: r.name,
      kind: 'upload' as const,
      scene: null,
      presetId: legacy ? 'estimated' : (r.edited ? 'annotated' : 'estimated'),
      thumb: r.thumb,
      stats: r.stats as ImageStats,
      look,
      texture,
      origins,
      annotation: (r.annotation as RefAnnotation | undefined) ?? {
        origin: 'estimated' as Origin,
        note: r.edited ? '用户标注' : '算法估算起点：颗粒/光晕/色散由参考图推得，可手动微调',
      },
    };
  });
}

/** 估算结果 → 运行时 TextureParams（估算只填 iso/size/amount/radius/tint/chroma_shift，其余用先验） */
export function estimateToTexture(est: TextureEstimate | null): TextureParams {
  const base = getPreset('neutral').params.texture;
  if (!est) return JSON.parse(JSON.stringify(base)) as TextureParams;
  return {
    halation: {
      enabled: est.halation.amount.value > 0.05,
      amount: est.halation.amount.value,
      radius: est.halation.radius.value,
      tint_rgb: est.halation.tint_rgb.value,
      threshold: base.halation.threshold,
      ...V11_HALATION,
    },
    grain: {
      enabled: true,
      iso: est.grain.iso.value,
      size: est.grain.size.value,
      correlation: base.grain.correlation,
      shadow_weight: base.grain.shadow_weight,
      ...V11_GRAIN,
      cluster: base.grain.cluster,
    },
    bloom: { ...base.bloom },
    vignette: {
      enabled: base.vignette.enabled,
      amount: base.vignette.amount,
      radius: base.vignette.radius,
      chroma_shift: est.vignette.chroma_shift.value,
    },
    gate_weave: { ...base.gate_weave },
  };
}

/** Schema v1.1 新增字段的估算起点 = 中性恒等默认（算法暂不推断这些维度，留给用户手调） */
const V11_HALATION = {
  background_gain: 1, amplify: 1, impact: 1, hue: 0.5, blue_comp: 0, smoothness: 0.5,
} satisfies Partial<HalationParams>;
const V11_GRAIN = {
  shadow: 1, midtone: 1, highlight: 0.2, type: 'negative', film_resolution: 0.5, mode: 'analogue',
} satisfies Partial<GrainParams>;

/** 全部图库条目 = 内置 + 用户入库 */
export function allEntries(): LibraryEntry[] {
  return [...builtinLibrary(), ...userLibrary()];
}

export function findEntry(id: string): LibraryEntry | undefined {
  return allEntries().find((e) => e.id === id);
}

export interface IngestResult {
  entry: LibraryEntry;
  debug: EstimateDebug;
}

/**
 * 参考图入库（上传参考 / 图库「导入自己的参考图」共用）：
 * 缩略图 ≤480 长边 JPEG；统计与估算在同一缩放数据上现算。
 */
export async function ingestRefImage(
  src: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
  name: string,
): Promise<IngestResult> {
  const cap = 480;
  let w = src.width;
  let h = src.height;
  const s = Math.min(1, cap / Math.max(w, h));
  w = Math.max(2, Math.round(w * s));
  h = Math.max(2, Math.round(h * s));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const c = cv.getContext('2d', { willReadFrequently: true })!;
  c.drawImage(src as CanvasImageSource, 0, 0, w, h);
  const img = c.getImageData(0, 0, w, h);
  const stats = analyzeImage(img.data, w, h);
  /* R18：估算器懒加载（估算只在「导入自己的参考图」时发生；不进首屏 gzip 预算） */
  const { estimateTexture } = await import('../estimate/estimate');
  const { estimate, debug } = estimateTexture(img.data, w, h);
  const texture = estimateToTexture(estimate);
  const id = 'ref_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  const entry: LibraryEntry = {
    id,
    name,
    kind: 'upload',
    scene: null,
    presetId: 'estimated',
    thumb: cv.toDataURL('image/jpeg', 0.82),
    stats,
    look: { ...NEUTRAL_LOOK },
    texture,
    origins: (() => {
      const o: Record<string, Origin> = {};
      for (const g of ['halation', 'grain', 'bloom', 'vignette', 'gate_weave'] as const) {
        for (const k of Object.keys(texture[g] as unknown as Record<string, unknown>)) {
          if (k !== 'enabled') o[`${g}.${k}`] = 'estimated';
        }
      }
      for (const k of Object.keys(NEUTRAL_LOOK_KEYS)) o[`look.${k}`] = 'estimated';
      o['master'] = 'estimated';
      return o;
    })(),
    annotation: { origin: 'estimated', note: '算法估算起点（颗粒/光晕/暗角色散），可手动微调' },
  };
  storage.saveUserRef({
    id,
    name,
    thumb: entry.thumb,
    stats,
    // v1.1：直接存完整参数（标注编辑器可原样还原）；texture 兼容字段保留估算值供诊断
    texture: estimate,
    look: { ...NEUTRAL_LOOK },
    origins: entry.origins,
    annotation: { ...entry.annotation },
    created_at: new Date().toISOString(),
  });
  return { entry, debug };
}

/** 标注编辑器「保存到条目」：写回 localStorage 条目（仅用户条目；内置条目请走另存） */
export function saveAnnotation(id: string, patch: AnnotationPatch): boolean {
  return storage.updateUserRef(id, {
    name: patch.name,
    texture: patch.texture,
    look: patch.look,
    origins: patch.origins,
    annotation: patch.annotation,
    edited: true,
  });
}

/** 标注编辑器「另存为我的标注」：内置/任意图库条目的当前编辑副本 → 新的用户条目
 *  （复制缩略图与统计；型号卡无参考图返回 null）。返回新条目的 id/name。 */
export function cloneAsUserAnnotation(
  source: Pick<LibraryEntry, 'name' | 'thumb' | 'stats'>,
  patch: AnnotationPatch,
): { id: string; name: string } | null {
  if (!source.thumb || !source.stats) return null; // 型号卡无参考图，不可另存
  const id = 'ref_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  const name = patch.name ? patch.name : source.name + ' · 我的标注';
  const stored: storage.StoredRef = {
    id,
    name,
    thumb: source.thumb,
    stats: source.stats,
    texture: patch.texture,
    look: patch.look,
    origins: patch.origins,
    annotation: patch.annotation,
    edited: true,
    created_at: new Date().toISOString(),
  };
  if (!storage.saveUserRef(stored)) return null;
  return { id, name };
}

/** 型号卡（stock）条目视图：R2 十款（STOCK_IDS 顺序 = 卡片墙顺序），look+texture 来自参数卡 */
export function stockCards(): LibraryEntry[] {
  return STOCK_IDS.map((pid) => {
    const card = getPreset(pid);
    return {
      id: 'stock_' + card.id,
      name: card.name,
      kind: 'stock' as const,
      scene: null,
      presetId: card.id,
      thumb: '',
      stats: null,
      look: card.params.look,
      texture: card.params.texture,
      origins: card.origins,
      profile: card.profile,
      annotation: {
        origin: 'annotated' as Origin,
        note: card.meta.tagline ? `${card.meta.tagline}｜${card.meta.advice}` : card.note + '（直出：无统计对齐）',
      },
    };
  });
}

/** R8 风格卡（stock 类条目视图：与型号卡同样「直出配方」，id 前缀 style_ 以区分）。
 *  新维度 = 冲印工艺/时代感；缩略图由 stockThumbUrl 复用同一示例帧渲染。 */
export function styleCards(): LibraryEntry[] {
  return STYLE_IDS.map((pid) => {
    const card = getPreset(pid);
    return {
      id: 'style_' + card.id,
      name: card.name,
      kind: 'stock' as const,
      scene: null,
      presetId: card.id,
      thumb: '',
      stats: null,
      look: card.params.look,
      texture: card.params.texture,
      origins: card.origins,
      profile: card.profile,
      annotation: {
        origin: 'annotated' as Origin,
        note: card.meta.tagline ? `${card.meta.tagline}｜${card.meta.advice}` : card.note,
      },
    };
  });
}
