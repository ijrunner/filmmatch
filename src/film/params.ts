/* FilmMatch 效果层 · 参数卡（配方 Schema v1 texture 段 + color.look 段 + master）
 * 单位约定：半径=画面高度%（%H），颗粒尺寸=画面高度‰，边缘色散=画面高度比例
 *（chroma_shift 0.004 ≈ 1080p 画面角落约 4px 分离，随 r² 衰减，见 pipeline.ts 注释）
 * 六张预设卡对应效果规格曲线家族：neutral / FL-04(C-B) / FL-05(C-D) / FL-06(C-A) / FL-07(C-A) / FL-08(C-C)
 * 全部值 origin 标 annotated（图库标注底稿）；用户一动滑杆应翻转为 user。
 */

import { DEFAULT_PROFILE, type TextureProfileRef } from './grainmatrix';
/* R18：coupling / hsl 的类型与默认值单一真源在 engine/look（film→engine 允许方向）。
 * 缺省语义：coupling 缺省 = DEFAULT_COUPLING（历史固定矩阵，逐位兼容）；
 * hsl 缺省/全 0 = 恒等。 */
import {
  DEFAULT_COUPLING, HSL_HUES, type CouplingCoeffs, type HslAdjustments,
} from '../engine/look';
import type { CardAnchors, PipelineAnchors } from './effectmath';

export type Origin = 'annotated' | 'estimated' | 'user';
export type ViewMode = 0 | 1 | 2 | 3; // 0 效果 / 1 原图 / 2 分屏（原图在右）/ 3 Mask 效果隔离预览
export type GrainType = 'negative' | 'positive'; // 负片（高光颗粒更明显）/ 正片（更柔、高光弱）
export type GrainMode = 'analogue' | 'noise';    // 絮状模拟 / 白噪声快速模式（兼作防 banding dither）

/** R18 染料串扰六系数（off-diagonal；键 = 输出通道×输入通道，如 rg = G 串入 R） */
export type CouplingParams = CouplingCoeffs;
/** R18 按管线锚点（归一化域 black/white/pivot） */
export type PipelineAnchorsT = PipelineAnchors;
export type CardAnchorsT = CardAnchors;
/** R18 HSL 8 色相调整（hue/sat/lum 各 −1..1） */
export type HslParams = HslAdjustments;
export { DEFAULT_COUPLING, HSL_HUES };

/* Schema v1.1 新增字段一律「默认值=恒等变换」，见 film/effectmath.ts 的注释约定。
 * 单位与取值范围见 docs/prd/配方Schema-v1.1.md。 */

export interface HalationParams {
  enabled: boolean;
  amount: number;     // 0-1 强度
  radius: number;     // %H 宽晕半径（紧晕固定 ≈0.3%H，见 pipeline）
  tint_rgb: [number, number, number]; // 晕染色，默认橙红
  threshold: number;  // 亮通软膝阈值（0-1，最大通道）
  /* —— Schema v1.1 —— */
  background_gain: number; // 0-1 光晕在亮背景上的可见度（0=亮背景不出现；1=恒等）
  amplify: number;         // 0-2 乳剂散射敏感度（再分配晕形，不改叠加不透明度；1=恒等）
  impact: number;          // 0-1 叠加不透明度（与 amplify 分离；0=效果不可见）
  hue: number;             // 0-1 绿层灵敏度（0 红 ↔ 1 黄；0.5=恒等）
  blue_comp: number;       // 0-1 冷背景补偿（0=恒等）
  smoothness: number;      // 0-1 大小光源分配（低=细节光晕，高=大区域；0.5=恒等）
}
export interface GrainParams {
  enabled: boolean;
  iso: number;          // 感光度档：幅度按 √(iso/400)，ISO400=1.0×
  size: number;         // ‰H 颗粒基准间距（3 尺度金字塔权重由它推导）
  correlation: number;  // 1=单色颗粒（黑白） 0=每通道独立（彩色）
  shadow_weight: number;// 旧字段（v1 兼容）：暗部加权，叠加在 shadow 段上
  /* —— Schema v1.1 —— */
  shadow: number;       // 0-3 阴影段权重（1=恒等）
  midtone: number;      // 0-3 中间调段权重（1=恒等）
  highlight: number;    // 0-3 高光段权重（0.2=默认，保留旧「高光近零」先验）
  type: GrainType;      // 负片/正片两种颗粒算法
  film_resolution: number; // 0-1 颗粒-细节平衡（高=颗粒更细；0.5=恒等）
  mode: GrainMode;      // analogue / noise
  /* —— R9 质感深度 —— */
  cluster: number;      // 0-1 扫描颗粒团簇感（0 = 恒等：纯随机颗粒；越大越有真实扫描的颗粒团）
}
export interface BloomParams {
  enabled: boolean;
  amount: number;
  radius: number;     // %H，独立于 halation
  threshold: number;  // 亮度软阈值（默认 0.85）
  /* —— Schema v1.1 —— */
  save_lights: number; // 0-1 高光防溢出保护（0=恒等）
  details: number;     // 0-1 大小光源分配（0.5=恒等）
  saturation: number;  // 0-1 效果降饱和（1=恒等）
}
export interface VignetteParams {
  enabled: boolean;
  amount: number;
  radius: number;       // 起始半径（1=画面半对角）
  chroma_shift: number; // 边缘色散量（画面高度比例，0.004≈1080p 角落 4px）
}
/**
 * R9 片门抖动（gate weave）：模拟胶片在片门里逐帧轻微位移。
 * 为什么没有 enabled 开关：amount = 0 即恒等（默认关闭），少一个 UI 参数——DCTL 参数上限 64，
 * 含内联匹配段时已用到 63，留 1 个余量给后续轮次。
 */
export interface GateWeaveParams {
  /** 抖动幅度（画面高度比例；0 = 恒等/关闭） */
  amount: number;
  /** 抖动速度（相位/秒），默认 1.0 */
  speed: number;
}
export interface TextureParams {
  halation: HalationParams;
  grain: GrainParams;
  bloom: BloomParams;
  vignette: VignetteParams;
  /** R9 片门抖动（默认关闭：amount = 0） */
  gate_weave: GateWeaveParams;
}
export interface LookParams {
  fade: number;           // 褪色总量（黑位提升+白位收拢）
  black_lift: number;     // 黑位提升
  dye_coupling: number;   // 染料耦合（通道串扰矩阵强度）
  shadow_bias: number;    // 暗部青蓝偏置
  highlight_bias: number; // 高光暖黄偏置
  film_s: number;         // 曲线家族A 电影负片软S 强度（参考曲线：中段斜率0.76/黑位锚定/肩部保白点）
  contrast: number;       // 曲线家族B 正片反S 强度（Schema v1.1 建议新增字段）
  saturation: number;
  warmth: number;         // 冷暖（-1 冷 → 1 暖）
  /* —— Schema v1.2 分离色调（split toning）——
   * 暗部/高光各有独立色相 + 饱和度，外加平衡；全部默认 0 = 恒等（见 effectmath/look 注释）。
   * 色相环：0=红 → 0.33=绿 → 0.66=蓝；sat=0 时逐位恒等（不改变画面）。 */
  split_shadow_hue: number;      // 0..1 暗部色相
  split_shadow_sat: number;      // 0..1 暗部饱和度（0 = 恒等）
  split_highlight_hue: number;   // 0..1 高光色相
  split_highlight_sat: number;   // 0..1 高光饱和度（0 = 恒等）
  split_balance: number;         // -1..1 平衡：0 中性；负 → 偏暗部权重，正 → 偏高光权重
  /* —— Schema v1.3（R18）——
   * coupling：染料串扰六系数（off-diagonal）。**可选字段**：缺省/缺键 = DEFAULT_COUPLING
   * （历史固定矩阵对应项），配合 dye_coupling 总强度 → 旧配方读入后逐位等于今天的输出。
   * hsl：HSL 8 色相 × hue/sat/lum（各 −1..1）。**可选字段**：缺省/全 0 = 恒等；
   * 只进网页预览与 .cube 导出，不进 DCTL 面板/源码。 */
  coupling?: Partial<CouplingParams>;
  hsl?: Partial<HslParams>;
}
export interface FilmParams {
  texture: TextureParams;
  look: LookParams;
  master: number; // 全局质感强度倍率
}

export const LOOK_KEYS = [
  'fade', 'black_lift', 'dye_coupling', 'shadow_bias',
  'highlight_bias', 'film_s', 'contrast', 'saturation', 'warmth',
  /* Schema v1.2：分离色调 5 键（追加在末尾，避免打乱既有序列化顺序与既有断言） */
  'split_shadow_hue', 'split_shadow_sat', 'split_highlight_hue', 'split_highlight_sat', 'split_balance',
] as const;

export function defaultLook(): LookParams {
  return {
    fade: 0, black_lift: 0, dye_coupling: 0, shadow_bias: 0,
    highlight_bias: 0, film_s: 0, contrast: 0, saturation: 1, warmth: 0,
    split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0,
  };
}
export function defaultTexture(): TextureParams {
  return {
    halation: {
      enabled: false, amount: 0.42, radius: 1.2, tint_rgb: [1.0, 0.35, 0.2], threshold: 0.75,
      // v1.1 默认 = 恒等（见 effectmath 注释约定）
      background_gain: 1, amplify: 1, impact: 1, hue: 0.5, blue_comp: 0, smoothness: 0.5,
    },
    grain: {
      enabled: true, iso: 400, size: 1.2, correlation: 0.4, shadow_weight: 0.8,
      shadow: 1, midtone: 1, highlight: 0.2, type: 'negative', film_resolution: 0.5, mode: 'analogue',
      cluster: 0,
    },
    bloom: {
      enabled: true, amount: 0.25, radius: 2.0, threshold: 0.85,
      save_lights: 0, details: 0.5, saturation: 1,
    },
    vignette: { enabled: false, amount: 0.3, radius: 1.1, chroma_shift: 0.004 },
    gate_weave: { amount: 0, speed: 1 },
  };
}
export function defaultParams(): FilmParams {
  return { texture: defaultTexture(), look: defaultLook(), master: 1 };
}

export function cloneParams(p: FilmParams): FilmParams {
  return JSON.parse(JSON.stringify(p)) as FilmParams;
}

/* ---------- 预设参数卡 ---------- */

/** F12 型号卡元数据：观感一句话（商标安全命名）、适配场景标签、适用建议 */
export interface StockMeta {
  tagline: string;    // 一句观感文案（不出现第三方品牌）
  sceneTags: string[];// 适配场景：night / portrait / dusk / daylight / indoor / retro …
  advice: string;     // 适用建议（给新手的一句话）
}

export interface PresetCard {
  id: string;
  name: string;
  /** 曲线家族：neutral / C-A..C-D 为型号卡；'S' 为 R8 新增的「风格卡」维度（冲印工艺/时代感） */
  family: 'neutral' | 'C-A' | 'C-B' | 'C-C' | 'C-D' | 'S';
  note: string;
  /** F12 型号卡元数据：观感一句话（商标安全命名）、适配场景标签、适用建议 */
  meta: StockMeta;
  /** R2：该型号卡默认颗粒/光晕档位（配方 JSON 溯源 + UI 初始选中；neutral 用 DEFAULT_PROFILE） */
  profile: TextureProfileRef;
  params: FilmParams;
  origins: Record<string, Origin>; // 路径如 "halation.amount" / "look.fade"
  /** R18 Schema v1.3（可选）：按管线锚点（归一化域 black/white/pivot）。
   *  切 DCTL 管线时用目标管线锚点重标定 look（切管线语义不漂移）；无 anchors → 行为不变。 */
  anchors?: CardAnchorsT;
}

const NO_META: StockMeta = { tagline: '', sceneTags: [], advice: '' };

function withOrigins(
  id: string, name: string, family: PresetCard['family'], note: string, params: FilmParams,
  meta: StockMeta = NO_META, profile: TextureProfileRef = DEFAULT_PROFILE,
  anchors?: CardAnchorsT,
): PresetCard {
  const origins: Record<string, Origin> = {};
  for (const [g, obj] of Object.entries(params.texture)) {
    for (const k of Object.keys(obj as Record<string, unknown>)) {
      if (typeof (obj as Record<string, unknown>)[k] !== 'boolean') origins[`${g}.${k}`] = 'annotated';
    }
  }
  for (const k of LOOK_KEYS) origins[`look.${k}`] = 'annotated';
  origins['master'] = 'annotated';
  return anchors ? { id, name, family, note, meta, profile, params, origins, anchors } : { id, name, family, note, meta, profile, params, origins };
}

/** 质感段部分覆盖：以 defaultTexture 为底，只写需要偏离恒等的字段（v1.1 起用） */
type TexOverride = {
  halation?: Partial<HalationParams>;
  grain?: Partial<GrainParams>;
  bloom?: Partial<BloomParams>;
  vignette?: Partial<VignetteParams>;
  gate_weave?: Partial<GateWeaveParams>;
};
function tex(o: TexOverride): TextureParams {
  const d = defaultTexture();
  return {
    halation: { ...d.halation, ...o.halation },
    grain: { ...d.grain, ...o.grain },
    bloom: { ...d.bloom, ...o.bloom },
    vignette: { ...d.vignette, ...o.vignette },
    gate_weave: { ...d.gate_weave, ...o.gate_weave },
  };
}

/** R2 十款型号（展示顺序即卡片墙顺序）：fl01–fl03 新增前段，fl04–fl08 为 R1 首批，fl09–fl10 新增后段 */
export const STOCK_IDS = ['fl01', 'fl02', 'fl03', 'fl04', 'fl05', 'fl06', 'fl07', 'fl08', 'fl09', 'fl10'] as const;

export const PRESETS: Record<string, PresetCard> = {
  neutral: withOrigins('neutral', '默认 · 中性', 'neutral',
    '按先验：halation/暗角默认关，仅保底颗粒+柔光（Schema v1.1 新参数全为恒等默认）',
    {
      texture: tex({}),
      look: { fade: 0, black_lift: 0, dye_coupling: 0, shadow_bias: 0, highlight_bias: 0, film_s: 0, contrast: 0, saturation: 1.0, warmth: 0, split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0 },
      master: 1,
    }),

  fl01: withOrigins('fl01', 'FL-01 银盐', 'C-A',
    '黑白银盐：去色走高反差灰阶，负片颗粒偏单色、乳剂分辨率中等；光晕关闭保持干净',
    {
      texture: tex({
        halation: { enabled: false, amount: 0.6, radius: 1.8, tint_rgb: [1.0, 0.35, 0.2], threshold: 0.75,
          background_gain: 1, amplify: 1.0, impact: 1, hue: 0.5, blue_comp: 0.15, smoothness: 0.5 },
        grain: { enabled: true, iso: 250, size: 1.1, correlation: 0.5, shadow_weight: 0.8,
          shadow: 1.0, midtone: 1.0, highlight: 0.2, type: 'negative', film_resolution: 0.55, mode: 'analogue' },
        bloom: { enabled: true, amount: 0.12, radius: 1.6, threshold: 0.88,
          save_lights: 0.3, details: 0.5, saturation: 1 },
      }),
      look: { fade: 0, black_lift: 0, dye_coupling: 0, shadow_bias: 0, highlight_bias: 0, film_s: 0.5, contrast: 0.35, saturation: 0, warmth: 0, split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0 },
      master: 1,
    },
    {
      tagline: '黑白银盐：高反差灰阶、单色颗粒',
      sceneTags: ['portrait', 'street', 'retro'],
      advice: '黑白人像/街拍；彩色题材请改用彩色型号，去色会丢失色彩信息。',
    },
    { grain: 'g-35-250', halation: 'std' }),

  fl02: withOrigins('fl02', 'FL-02 清透', 'C-B',
    '正片型：反S轻抬对比、通透高光、干净饱和；细颗粒正片算法 + 高光防溢出保护',
    {
      texture: tex({
        halation: { enabled: true, amount: 0.6, radius: 1.8, tint_rgb: [1.0, 0.4, 0.25], threshold: 0.72,
          background_gain: 0.5, amplify: 1.0, impact: 0.55, hue: 0.5, blue_comp: 0.15, smoothness: 0.5 },
        grain: { enabled: true, iso: 250, size: 0.75, correlation: 0.5, shadow_weight: 0.8,
          shadow: 1.0, midtone: 1.0, highlight: 0.2, type: 'positive', film_resolution: 0.7, mode: 'analogue' },
        bloom: { enabled: true, amount: 0.15, radius: 1.6, threshold: 0.88,
          save_lights: 0.6, details: 0.5, saturation: 1 },
      }),
      look: { fade: 0, black_lift: 0, dye_coupling: 0, shadow_bias: 0, highlight_bias: 0.05, film_s: 0, contrast: 0.6, saturation: 1.2, warmth: 0, split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0 },
      master: 1,
    },
    {
      tagline: '正片清透：通透高光、干净饱和',
      sceneTags: ['daylight', 'landscape', 'portrait'],
      advice: '日光风景/人像；需要浓郁暖调时再叠加暖度，避免过饱和。',
    },
    { grain: 'g-65-250', halation: 'std' }),

  fl03: withOrigins('fl03', 'FL-03 夜巡', 'C-D',
    '高感夜景：16mm 粗颗粒 + Noise 模式兼防 banding；去防光晕层强开，灯光晕染铺得开',
    {
      texture: tex({
        halation: { enabled: true, amount: 0.95, radius: 3.0, tint_rgb: [1.0, 0.3, 0.18], threshold: 0.55,
          background_gain: 0.5, amplify: 1.35, impact: 1, hue: 0.42, blue_comp: 0.4, smoothness: 0.65 },
        grain: { enabled: true, iso: 500, size: 1.9, correlation: 0.4, shadow_weight: 0.9,
          shadow: 1.2, midtone: 1.05, highlight: 0.3, type: 'negative', film_resolution: 0.4, mode: 'noise' },
        bloom: { enabled: true, amount: 0.3, radius: 2.4, threshold: 0.8,
          save_lights: 0.45, details: 0.55, saturation: 0.95 },
        vignette: { enabled: true, amount: 0.25, radius: 1.05, chroma_shift: 0.004 },
      }),
      look: { fade: 0, black_lift: 0.04, dye_coupling: 0, shadow_bias: 0.3, highlight_bias: 0.2, film_s: 0.5, contrast: 0, saturation: 0.9, warmth: 0.12, split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0 },
      master: 1,
    },
    {
      tagline: '高感夜巡：粗颗粒、灯光晕染的纪实夜色',
      sceneTags: ['night', 'street', 'documentary'],
      advice: '夜景/街头纪实；白天使用颗粒会显得过重，建议改低感型号。',
    },
    { grain: 'g-16-500', halation: 'noremjet' }),

  fl04: withOrigins('fl04', 'FL-04 印相', 'C-B',
    '家族B 正片高对比：反S加强对比、黑位压实、饱和抬升；正片颗粒型、高光防溢出',
    {
      texture: tex({
        halation: { enabled: true, amount: 0.35, radius: 1.4, tint_rgb: [1.0, 0.31, 0.19], threshold: 0.7,
          background_gain: 0.75, amplify: 1.0, impact: 1, hue: 0.45, blue_comp: 0.2, smoothness: 0.4 },
        grain: { enabled: true, iso: 200, size: 1.0, correlation: 0.5, shadow_weight: 0.7,
          shadow: 0.8, midtone: 1.05, highlight: 0.3, type: 'positive', film_resolution: 0.6, mode: 'analogue' },
        bloom: { enabled: true, amount: 0.15, radius: 1.6, threshold: 0.88,
          save_lights: 0.5, details: 0.45, saturation: 0.95 },
        vignette: { enabled: true, amount: 0.18, radius: 1.15, chroma_shift: 0.003 },
      }),
      look: { fade: 0, black_lift: 0, dye_coupling: 0.04, shadow_bias: 0, highlight_bias: 0.05, film_s: 0, contrast: 0.85, saturation: 1.14, warmth: 0.02, split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0 },
      master: 1,
    },
    {
      tagline: '正片高对比：黑位压实、色彩浓烈明快',
      sceneTags: ['daylight', 'landscape', 'street'],
      advice: '日光外景、需要「提神」的画面；暗部占比大的夜景慎用。',
    },
    { grain: 'g-35-50', halation: 'std' }),

  fl05: withOrigins('fl05', 'FL-05 光匣', 'C-D',
    '家族A 软S + halation 强开（光晕展示位）；去防光晕层物理设定 → 散射敏感度高、晕铺得开',
    {
      texture: tex({
        halation: { enabled: true, amount: 1.0, radius: 3.2, tint_rgb: [1.0, 0.31, 0.19], threshold: 0.55,
          background_gain: 0.8, amplify: 1.25, impact: 1, hue: 0.42, blue_comp: 0.35, smoothness: 0.6 },
        grain: { enabled: true, iso: 400, size: 1.1, correlation: 0.45, shadow_weight: 0.85,
          shadow: 1.05, midtone: 1.0, highlight: 0.25, type: 'negative', film_resolution: 0.5, mode: 'analogue' },
        bloom: { enabled: true, amount: 0.3, radius: 2.5, threshold: 0.8,
          save_lights: 0.45, details: 0.6, saturation: 0.9 },
      }),
      look: { fade: 0, black_lift: 0.02, dye_coupling: 0.05, shadow_bias: 0.1, highlight_bias: 0.1, film_s: 0.35, contrast: 0, saturation: 0.97, warmth: 0.15, split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0 },
      master: 1,
    },
    {
      tagline: '强光晕暖调：高光泛橙红光雾，夜晚氛围拉满',
      sceneTags: ['night', 'neon', 'indoor'],
      advice: '夜景灯光/霓虹/路灯首推；天空过亮或白衣画面请压低光晕强度。',
    },
    { grain: 'g-35-250', halation: 'noremjet' },
    /* R18 锚点示例（推导式见 EFFECT-REPORT-R18 §anchors）：
     * 显示域落点 D = black_lift + 0.1×fade = 0.02、W = 1 − 0.08×fade = 1；
     * yrgb: black=enc_yrgb(D)（BT.1886→log2 归一化）、white=enc_yrgb(W)、pivot=0.5；
     * rcm:  black=D、white=W（DI 重归一化=恒等）、pivot=0.333。 */
    {
      yrgb: { black: 0.0005444, white: 1, pivot: 0.5 },
      rcm: { black: 0.02, white: 1, pivot: 0.333 },
    }),

  fl06: withOrigins('fl06', 'FL-06 晨负', 'C-A',
    '家族A 电影负片软S：阴影抬升约+6级、中段斜率≈0.81、肩部保白点；乳剂分辨率偏高（细颗粒）',
    {
      texture: tex({
        halation: { enabled: false, amount: 0.3, radius: 1.5, tint_rgb: [1.0, 0.35, 0.2], threshold: 0.75,
          background_gain: 0.9, amplify: 0.95, impact: 1, hue: 0.5, blue_comp: 0.15, smoothness: 0.5 },
        grain: { enabled: true, iso: 250, size: 1.0, correlation: 0.5, shadow_weight: 0.8,
          shadow: 1.1, midtone: 1.0, highlight: 0.2, type: 'negative', film_resolution: 0.55, mode: 'analogue' },
        bloom: { enabled: true, amount: 0.2, radius: 1.8, threshold: 0.85,
          save_lights: 0.35, details: 0.5, saturation: 1.0 },
        vignette: { enabled: false, amount: 0.2, radius: 1.2, chroma_shift: 0.003 },
      }),
      look: { fade: 0, black_lift: 0.004, dye_coupling: 0.05, shadow_bias: 0.08, highlight_bias: 0.15, film_s: 0.8, contrast: 0, saturation: 0.97, warmth: 0.1, split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0 },
      master: 1,
    },
    {
      tagline: '电影负片软S：阴影微抬、肩部柔和，宽容度观感',
      sceneTags: ['daylight', 'portrait', 'dusk'],
      advice: '叙事镜头通用起点，肤色柔和；日景与黄昏尤佳。',
    },
    { grain: 'g-35-250', halation: 'std' },
    /* R18 锚点示例（推导式见 EFFECT-REPORT-R18 §anchors）：D = 0.004、W = 1
     * （fade=0 / black_lift=0.004）；yrgb 经 TF 编码，rcm 恒等直取。 */
    {
      yrgb: { black: 0.00001145, white: 1, pivot: 0.5 },
      rcm: { black: 0.004, white: 1, pivot: 0.333 },
    }),

  fl07: withOrigins('fl07', 'FL-07 灯下', 'C-A',
    '家族A + 钨光夜景：暖高光/青暗部，颗粒重（ISO800 大尺寸）；冷背景补偿强',
    {
      texture: tex({
        halation: { enabled: true, amount: 0.45, radius: 1.8, tint_rgb: [1.0, 0.33, 0.2], threshold: 0.65,
          background_gain: 0.3, amplify: 1.15, impact: 1, hue: 0.4, blue_comp: 0.5, smoothness: 0.55 },
        grain: { enabled: true, iso: 800, size: 1.6, correlation: 0.4, shadow_weight: 0.85,
          shadow: 1.15, midtone: 1.05, highlight: 0.3, type: 'negative', film_resolution: 0.45, mode: 'analogue' },
        bloom: { enabled: true, amount: 0.2, radius: 2.2, threshold: 0.85,
          save_lights: 0.55, details: 0.55, saturation: 0.85 },
        vignette: { enabled: true, amount: 0.28, radius: 1.05, chroma_shift: 0.004 },
      }),
      look: { fade: 0, black_lift: 0.03, dye_coupling: 0.08, shadow_bias: 0.25, highlight_bias: 0.25, film_s: 0.75, contrast: 0, saturation: 0.95, warmth: 0.18, split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0 },
      master: 1,
    },
    {
      tagline: '钨光夜色：暖高光、青暗部，重颗粒的灯下质感',
      sceneTags: ['night', 'indoor', 'portrait'],
      advice: '室内钨丝灯/烛光/酒吧场景；白天画面会偏色，慎用。',
    },
    { grain: 'g-16-500', halation: 'std' }),

  fl08: withOrigins('fl08', 'FL-08 褪色', 'C-C',
    '家族C 负片染料褪色：染料耦合+暗青/高黄反向偏置+黑位提升白位收拢；Noise 颗粒模式（兼防 banding）',
    {
      texture: tex({
        halation: { enabled: false, amount: 0.3, radius: 1.5, tint_rgb: [1.0, 0.35, 0.2], threshold: 0.75,
          background_gain: 0.6, amplify: 1.0, impact: 1, hue: 0.55, blue_comp: 0.1, smoothness: 0.5 },
        grain: { enabled: true, iso: 500, size: 1.6, correlation: 0.55, shadow_weight: 0.9,
          shadow: 1.2, midtone: 1.1, highlight: 0.35, type: 'positive', film_resolution: 0.35, mode: 'noise' },
        bloom: { enabled: true, amount: 0.15, radius: 2.0, threshold: 0.85,
          save_lights: 0.4, details: 0.5, saturation: 0.8 },
        vignette: { enabled: true, amount: 0.25, radius: 1.0, chroma_shift: 0.004 },
      }),
      look: { fade: 0.75, black_lift: 0.1, dye_coupling: 0.22, shadow_bias: 0.55, highlight_bias: 0.45, film_s: 0.25, contrast: 0, saturation: 0.8, warmth: 0.05, split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0 },
      master: 1,
    },
    {
      tagline: '染料褪色：黑位发灰、暗青高黄，老胶片的时间痕迹',
      sceneTags: ['retro', 'dusk', 'portrait'],
      advice: '怀旧/年代感叙事；需要干净黑位的画面请回调「褪色总量」。',
    },
    { grain: 'g-16-500', halation: 'std' }),

  fl09: withOrigins('fl09', 'FL-09 暮色', 'C-A',
    '黄昏低对比暖调：褪色+黑位抬升压平层次、金色高光大幅柔化；35mm 中感颗粒 + 标准光晕弱叠加',
    {
      texture: tex({
        halation: { enabled: true, amount: 0.6, radius: 2.0, tint_rgb: [1.0, 0.38, 0.22], threshold: 0.72,
          background_gain: 0.35, amplify: 1.0, impact: 0.6, hue: 0.5, blue_comp: 0.15, smoothness: 0.5 },
        grain: { enabled: true, iso: 250, size: 1.1, correlation: 0.45, shadow_weight: 0.8,
          shadow: 1.0, midtone: 1.0, highlight: 0.2, type: 'negative', film_resolution: 0.55, mode: 'analogue' },
        bloom: { enabled: true, amount: 0.4, radius: 2.6, threshold: 0.85,
          save_lights: 0.3, details: 0.3, saturation: 0.9 },
        vignette: { enabled: true, amount: 0.2, radius: 1.1, chroma_shift: 0.004 },
      }),
      look: { fade: 0.25, black_lift: 0.06, dye_coupling: 0, shadow_bias: 0.2, highlight_bias: 0.3, film_s: 0.5, contrast: 0, saturation: 0.92, warmth: 0.35, split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0 },
      master: 1,
    },
    {
      tagline: '暮色暖调：金色高光、柔和过渡',
      sceneTags: ['dusk', 'landscape', 'portrait'],
      advice: '黄昏/日落场景；正午强光下暖调会显得偏黄，请下调暖度。',
    },
    { grain: 'g-35-250', halation: 'std' }),

  fl10: withOrigins('fl10', 'FL-10 冷印', 'C-C',
    '冷调印片：青灰调 + 染料耦合，硬朗工业质感；65mm 低感细颗粒、标准光晕弱可见',
    {
      texture: tex({
        halation: { enabled: true, amount: 0.6, radius: 1.8, tint_rgb: [0.85, 0.4, 0.3], threshold: 0.78,
          background_gain: 0.6, amplify: 1.0, impact: 0.45, hue: 0.5, blue_comp: 0.15, smoothness: 0.5 },
        grain: { enabled: true, iso: 50, size: 0.675, correlation: 0.5, shadow_weight: 0.8,
          shadow: 0.8, midtone: 0.95, highlight: 0.15, type: 'negative', film_resolution: 0.75, mode: 'analogue' },
        bloom: { enabled: true, amount: 0.15, radius: 1.8, threshold: 0.88,
          save_lights: 0.5, details: 0.5, saturation: 0.95 },
      }),
      look: { fade: 0, black_lift: 0.01, dye_coupling: 0.06, shadow_bias: 0.05, highlight_bias: 0, film_s: 0, contrast: 0.5, saturation: 1.05, warmth: -0.3, split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0 },
      master: 1,
    },
    {
      tagline: '冷印：青灰调、硬朗的工业质感',
      sceneTags: ['urban', 'night', 'architecture'],
      advice: '城市/建筑/工业题材；人像肤色会偏冷，暖光人像慎用。',
    },
    { grain: 'g-65-50', halation: 'std' }),
};

/* ---------- R8 风格卡（新维度：冲印工艺 / 时代感） ----------
 * 与「型号卡 = 胶片型号」并列：STOCK_IDS（fl01–fl10）仍只含型号卡，语义不变；
 * 风格卡走独立的 STYLE_IDS / STYLES 表，由 getPreset 统一兜底读取（UI 卡片墙两处共用）。
 * 全部 meta 文案商标安全、origins 全量 annotated、profile 用 DEFAULT_PROFILE。
 * 设计要点：至少 4 张真正用上 Schema v1.2 分离色调（暗部/高光异色相）或黑白（saturation=0），
 * 两两观感差（风格测试用同帧 look 渲染口径）目标 > 8 级。 */
/* ---------- R20 精选调校卡（fx01–fx08，用户授权入库） ----------
 * 来源：ref-materials/xmp 根目录 18 个精选 XMP 的映射结果，经 R20 调校流程重编为自有表达
 * （决策 0008：映射原值表不进 git；调校后卡参数可入库）。卡 ← 来源对应表见决策文档。
 * origins 全量 estimated（估算起点调校卡，区别于 st01–st06 的人工标注卡）；
 * 曲线族签名 + 分离色调为观感主体，质感档对齐场景（夜景 g-35-500+低档光晕、食物 g-65-250、
 * 人像 g-35-250）；两两 look 差双帧口径（chart + hue sweep）均 >8 级（styles.test 管）。
 * fxNN 数据用紧凑 helper 生成：look 只写偏离恒等的键，texture 只写偏离档位的键。 */
function fxCard(
  id: string, name: string, note: string, look: Partial<LookParams>,
  texO: TexOverride, meta: StockMeta, profile: TextureProfileRef = DEFAULT_PROFILE,
): PresetCard {
  const c = withOrigins(id, name, 'S', note,
    { texture: tex(texO), look: { ...defaultLook(), ...look }, master: 1 }, meta, profile);
  for (const k of Object.keys(c.origins)) c.origins[k] = 'estimated';
  return c;
}
/** g-35-250 档位字段（默认档卡的 grain 存储值与档位一致；size/fr 为映射恒等信号微调） */
const G35250: Partial<GrainParams> = { iso: 250, size: 1.1, correlation: 0.45, film_resolution: 0.6 };

export const STYLE_IDS = ['st01', 'st02', 'st03', 'st04', 'st05', 'st06', 'fx01', 'fx02', 'fx03', 'fx04', 'fx05', 'fx06', 'fx07', 'fx08'] as const;

export const STYLES: Record<string, PresetCard> = {
  st01: withOrigins('st01', '漂白旁路', 'S',
    '银盐漂白：高反差 + 低饱和的银灰质感，高光微冷、暗部压住，保留金属感',
    {
      texture: tex({
        halation: { enabled: false, amount: 0.35, radius: 1.6, threshold: 0.7,
          background_gain: 0.7, amplify: 1.0, impact: 1, hue: 0.5, blue_comp: 0.25, smoothness: 0.5 },
        grain: { enabled: true, iso: 100, size: 0.9, correlation: 0.6, shadow_weight: 0.75,
          shadow: 0.95, midtone: 1.0, highlight: 0.15, type: 'negative', film_resolution: 0.65, mode: 'analogue' },
        bloom: { enabled: true, amount: 0.1, radius: 1.8, threshold: 0.88,
          save_lights: 0.55, details: 0.5, saturation: 0.85 },
        vignette: { enabled: true, amount: 0.2, radius: 1.1, chroma_shift: 0.003 },
      }),
      look: { fade: 0, black_lift: 0, dye_coupling: 0.12, shadow_bias: 0.15, highlight_bias: 0.25,
        film_s: 0.3, contrast: 0.85, saturation: 0.35, warmth: -0.05,
        split_shadow_hue: 0.5, split_shadow_sat: 0.1, split_highlight_hue: 0.58, split_highlight_sat: 0.12, split_balance: 0 },
      master: 1,
    },
    {
      tagline: '漂白旁路：高反差银灰、低饱和金属感',
      sceneTags: ['street', 'documentary', 'urban'],
      advice: '战争/纪实/工业题材的硬朗质感；人像肤色会发灰，美妆题材慎用。',
    }),

  st02: withOrigins('st02', '交叉冲洗', 'S',
    '交叉冲洗：绿青暗部 + 暖黄高光，饱和外扩、对比上冲，药水错配的年代错位感',
    {
      texture: tex({
        halation: { enabled: true, amount: 0.5, radius: 1.9, threshold: 0.68,
          background_gain: 0.55, amplify: 1.1, impact: 0.85, hue: 0.45, blue_comp: 0.2, smoothness: 0.55 },
        grain: { enabled: true, iso: 400, size: 1.3, correlation: 0.4, shadow_weight: 0.85,
          shadow: 1.1, midtone: 1.05, highlight: 0.3, type: 'negative', film_resolution: 0.45, mode: 'analogue' },
        bloom: { enabled: true, amount: 0.2, radius: 2.2, threshold: 0.82,
          save_lights: 0.4, details: 0.5, saturation: 0.95 },
        vignette: { enabled: true, amount: 0.24, radius: 1.05, chroma_shift: 0.004 },
      }),
      look: { fade: 0, black_lift: 0.02, dye_coupling: 0.12, shadow_bias: 0.0, highlight_bias: 0.0,
        film_s: 0.12, contrast: 0.85, saturation: 1.4, warmth: 0.28,
        split_shadow_hue: 0.42, split_shadow_sat: 0.6, split_highlight_hue: 0.1, split_highlight_sat: 0.5, split_balance: -0.15 },
      master: 1,
    },
    {
      tagline: '交叉冲洗：绿青暗部、暖黄高光的年代错位',
      sceneTags: ['retro', 'street', 'portrait'],
      advice: '复古/胶片翻拍/年代叙事；肤色会偏绿黄，正剧人像慎用。',
    }),

  st03: withOrigins('st03', '青橙商业', 'S',
    '青橙商业：暗部压青、高光推橙的互补分离，肤色透亮、画面通透有电影海报感',
    {
      texture: tex({
        halation: { enabled: true, amount: 0.3, radius: 1.7, threshold: 0.74,
          background_gain: 0.6, amplify: 1.0, impact: 0.6, hue: 0.5, blue_comp: 0.15, smoothness: 0.5 },
        grain: { enabled: true, iso: 200, size: 0.95, correlation: 0.5, shadow_weight: 0.75,
          shadow: 0.9, midtone: 1.0, highlight: 0.2, type: 'positive', film_resolution: 0.6, mode: 'analogue' },
        bloom: { enabled: true, amount: 0.18, radius: 2.0, threshold: 0.86,
          save_lights: 0.5, details: 0.5, saturation: 0.95 },
        vignette: { enabled: true, amount: 0.16, radius: 1.15, chroma_shift: 0.003 },
      }),
      look: { fade: 0, black_lift: 0, dye_coupling: 0.05, shadow_bias: 0.0, highlight_bias: 0.0,
        film_s: 0.2, contrast: 0.45, saturation: 1.15, warmth: 0.12,
        split_shadow_hue: 0.52, split_shadow_sat: 0.42, split_highlight_hue: 0.08, split_highlight_sat: 0.38, split_balance: 0.1 },
      master: 1,
    },
    {
      tagline: '青橙商业：青暗部与橙高光的互补分离',
      sceneTags: ['portrait', 'urban', 'daylight'],
      advice: '商业人像/城市夜景/预告片质感；大面积绿色场景会与暗部青撞色。',
    }),

  st04: withOrigins('st04', '高反差黑白', 'S',
    '黑白硬调：完全去色 + 正片反S压实黑位、软S托住中段，灰阶层次硬朗',
    {
      texture: tex({
        halation: { enabled: false, amount: 0.4, radius: 1.6, threshold: 0.72,
          background_gain: 0.7, amplify: 1.0, impact: 1, hue: 0.5, blue_comp: 0.1, smoothness: 0.5 },
        grain: { enabled: true, iso: 400, size: 1.2, correlation: 0.7, shadow_weight: 0.8,
          shadow: 1.0, midtone: 1.0, highlight: 0.2, type: 'negative', film_resolution: 0.5, mode: 'analogue' },
        bloom: { enabled: true, amount: 0.12, radius: 1.8, threshold: 0.9,
          save_lights: 0.5, details: 0.5, saturation: 1 },
        vignette: { enabled: true, amount: 0.28, radius: 1.0, chroma_shift: 0.003 },
      }),
      look: { fade: 0, black_lift: 0, dye_coupling: 0, shadow_bias: 0, highlight_bias: 0,
        film_s: 0.35, contrast: 0.9, saturation: 0, warmth: 0,
        split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0 },
      master: 1,
    },
    {
      tagline: '高反差黑白：完全去色的硬朗灰阶',
      sceneTags: ['portrait', 'street', 'documentary'],
      advice: '黑白人像/街拍/纪实；需要保留色彩信息时请改用彩色风格卡。',
    }),

  st05: withOrigins('st05', '褪色复古', 'S',
    '褪色复古：黑位大幅抬升 + 染料耦合偏黄绿，白位收拢、层次压平，旧照片的时间痕迹',
    {
      texture: tex({
        halation: { enabled: false, amount: 0.35, radius: 1.6, threshold: 0.72,
          background_gain: 0.6, amplify: 1.0, impact: 1, hue: 0.55, blue_comp: 0.1, smoothness: 0.5 },
        grain: { enabled: true, iso: 500, size: 1.5, correlation: 0.5, shadow_weight: 0.9,
          shadow: 1.2, midtone: 1.1, highlight: 0.35, type: 'positive', film_resolution: 0.4, mode: 'noise' },
        bloom: { enabled: true, amount: 0.15, radius: 2.2, threshold: 0.85,
          save_lights: 0.35, details: 0.45, saturation: 0.85 },
        vignette: { enabled: true, amount: 0.3, radius: 0.98, chroma_shift: 0.005 },
      }),
      look: { fade: 0.75, black_lift: 0.12, dye_coupling: 0.2, shadow_bias: 0.2, highlight_bias: 0.2,
        film_s: 0.2, contrast: 0, saturation: 0.72, warmth: 0.15,
        split_shadow_hue: 0.42, split_shadow_sat: 0.2, split_highlight_hue: 0.08, split_highlight_sat: 0.16, split_balance: 0 },
      master: 1,
    },
    {
      tagline: '褪色复古：黑位发灰、偏黄绿的时间痕迹',
      sceneTags: ['retro', 'dusk', 'portrait'],
      advice: '怀旧/回忆/年代感叙事；需要干净黑位的画面请下调褪色总量。',
    }),

  st06: withOrigins('st06', '夜戏冷调', 'S',
    '夜戏冷调：暗部蓝青分离 + 高光冷青，整体压暖、软S托底，冷峻的都市夜景',
    {
      texture: tex({
        halation: { enabled: true, amount: 0.6, radius: 2.4, threshold: 0.62,
          background_gain: 0.45, amplify: 1.15, impact: 0.9, hue: 0.42, blue_comp: 0.45, smoothness: 0.6 },
        grain: { enabled: true, iso: 800, size: 1.6, correlation: 0.4, shadow_weight: 0.9,
          shadow: 1.15, midtone: 1.05, highlight: 0.3, type: 'negative', film_resolution: 0.45, mode: 'analogue' },
        bloom: { enabled: true, amount: 0.25, radius: 2.6, threshold: 0.8,
          save_lights: 0.5, details: 0.55, saturation: 0.9 },
        vignette: { enabled: true, amount: 0.3, radius: 1.02, chroma_shift: 0.005 },
      }),
      look: { fade: 0, black_lift: 0.04, dye_coupling: 0.08, shadow_bias: 0.12, highlight_bias: 0,
        film_s: 0.5, contrast: 0.45, saturation: 0.82, warmth: -0.5,
        split_shadow_hue: 0.62, split_shadow_sat: 0.75, split_highlight_hue: 0.55, split_highlight_sat: 0.4, split_balance: -0.25 },
      master: 1,
    },
    {
      tagline: '夜戏冷调：蓝青暗部的冷峻都市夜色',
      sceneTags: ['night', 'urban', 'architecture'],
      advice: '夜景/雨夜/科幻都市；暖光人像与烛光场景会与冷调打架。',
    }),

  /* —— R20 精选调校卡（fx01–fx08）：估算起点（origins 全 estimated）—— */
  fx01: fxCard('fx01', '暮芒', '暮光余晖调校：收白位、暗部大幅抬升，暖调高光分离是夕阳余温的表达',
    { fade: 0.42, black_lift: 0.17, saturation: 1.3, warmth: 0.5,
      split_highlight_hue: 0.1, split_highlight_sat: 0.3, split_balance: -0.3 },
    { grain: { ...G35250 } },
    {
      tagline: '暮光余温：白位轻收、暗部微抬的日落后暖调',
      sceneTags: ['dusk', 'portrait', 'street'],
      advice: '日落/黄昏逆光与华灯初上时最佳；正午白光下暖调会过重。',
    }),

  fx02: fxCard('fx02', '夜汀', '低照度调校：暗部青蓝与高光暖灯的对位分离（青蓝衬暖灯），来源暗角信号保留在质感段',
    { fade: 0.5, saturation: 0.75, warmth: 0.45,
      split_shadow_hue: 0.6, split_shadow_sat: 0.3, split_highlight_hue: 0.09, split_highlight_sat: 0.6, split_balance: -0.2 },
    {
      halation: { enabled: true, amount: 0.55, radius: 1.8, threshold: 0.7,
        background_gain: 0.6, amplify: 1.0, impact: 1, hue: 0.5, blue_comp: 0.15, smoothness: 0.5 },
      grain: { enabled: true, iso: 500, size: 1.232, correlation: 0.45, shadow_weight: 0.8,
        shadow: 1.2, midtone: 1.05, highlight: 0.3, type: 'negative', film_resolution: 0.6, mode: 'analogue' },
      vignette: { enabled: true, amount: 0.11, radius: 1.0, chroma_shift: 0.004 },
    },
    {
      tagline: '夜汀：暗部泛青、灯光泛暖的低照度夜色',
      sceneTags: ['night', 'urban', 'neon'],
      advice: '夜景/霓虹/路灯首推；日光场景会显得脏青，慎用。',
    },
    { grain: 'g-35-500', halation: 'std' }),

  fx03: fxCard('fx03', '素日', '日常底色归并调校：多张近同 fade 预设收编为一张素净底色，只留轻褪色与微抬黑位',
    { fade: 0.5, black_lift: 0.05, saturation: 0.94 },
    { grain: { enabled: true, iso: 500, size: 1.4, correlation: 0.45, shadow_weight: 0.8,
      shadow: 1.2, midtone: 1.05, highlight: 0.3, type: 'negative', film_resolution: 0.6, mode: 'analogue' } },
    {
      tagline: '素日：轻褪色的日常底色，安静耐看',
      sceneTags: ['daylight', 'street', 'documentary'],
      advice: '日常扫街/随拍通用底色；需要强风格化的题材请再叠加其他卡。',
    },
    { grain: 'g-35-500', halation: 'std' }),

  fx04: fxCard('fx04', '绘本', '高调粉彩调校：正片反差与重褪色并存，白位朦胧而黑位仍压得住',
    { fade: 0.5, black_lift: 0.2, contrast: 1, saturation: 0.9 },
    { grain: { ...G35250 } },
    {
      tagline: '绘本：白位朦胧、对比仍在的高调粉彩',
      sceneTags: ['portrait', 'indoor', 'daylight'],
      advice: '高调人像/儿童/静物；暗调场景会丢失黑位层次。',
    }),

  fx05: fxCard('fx05', '樱粉', '春日人像调校：蓝紫暗部衬粉暖高光，反差保留通透，映射的微弱分离增强到可见档',
    { contrast: 0.85, black_lift: 0.13, saturation: 1.05,
      split_shadow_hue: 0.72, split_shadow_sat: 0.35, split_highlight_hue: 0.05, split_highlight_sat: 0.12 },
    { grain: { ...G35250 } },
    {
      tagline: '樱粉：蓝紫暗部衬暖高光的春日通透',
      sceneTags: ['portrait', 'daylight', 'spring'],
      advice: '春日人像/花景/浅色静物；夜景会显得反差过硬。',
    }),

  fx06: fxCard('fx06', '食光', '餐桌暖调调校：软S 托底 + 高饱和 + 暖调分离表达食欲感，细颗粒保持食物干净',
    { film_s: 0.65, black_lift: 0.08, saturation: 1.3, warmth: 0.5,
      split_shadow_hue: 0.1, split_shadow_sat: 0.25, split_highlight_hue: 0.12, split_highlight_sat: 0.3, split_balance: 0.1 },
    { grain: { enabled: true, iso: 250, size: 0.75, correlation: 0.5, shadow_weight: 0.8,
      shadow: 1.0, midtone: 1.0, highlight: 0.2, type: 'negative', film_resolution: 0.8, mode: 'analogue' } },
    {
      tagline: '食光：软调高饱和的餐桌暖意',
      sceneTags: ['food', 'indoor', 'daylight'],
      advice: '食物/静物/暖光室内；冷调题材会与暖色相撞。',
    },
    { grain: 'g-65-250', halation: 'std' }),

  fx07: fxCard('fx07', '硬调', '硬朗反差归并调校：两版直推反差预设收编为一张正片硬调，褪色压住高光不溢',
    { contrast: 1, fade: 0.5, black_lift: 0.05, saturation: 1.05 },
    { grain: { ...G35250 } },
    {
      tagline: '硬调：正片式直推反差，爽利干脆',
      sceneTags: ['street', 'daylight', 'landscape'],
      advice: '街拍/风景/需要「提神」的画面；人像肤色会偏硬。',
    }),

  fx08: fxCard('fx08', '新绿', '乳剂软调调校：软S 托底 + 绿黄分离提亮绿意，映射的微弱分离增强到可见档',
    { film_s: 0.75, black_lift: 0.13, saturation: 1.25,
      split_shadow_hue: 0.4861, split_shadow_sat: 0.25, split_highlight_hue: 0.4333, split_highlight_sat: 0.25 },
    { grain: { ...G35250 } },
    {
      tagline: '新绿：乳剂软调、绿意透亮的清爽人像',
      sceneTags: ['portrait', 'daylight', 'dusk'],
      advice: '日系人像/绿荫/清晨场景；暗夜场景颗粒感会偏重。',
    }),
};

/** 型号卡（PRESETS）与风格卡（STYLES）统一读取；未知 id 回落 neutral（既有语义不变） */
export function getPreset(id: string): PresetCard {
  return PRESETS[id] ?? STYLES[id] ?? PRESETS.neutral;
}

/** R8 风格卡读取（与 getPreset 同表；未知 id 回落 neutral） */
export function getStyle(id: string): PresetCard {
  return STYLES[id] ?? PRESETS.neutral;
}

/* ---------- Schema 兼容 ---------- */

type WrappedValue = number | { value: number | number[]; origin?: Origin };
type RawValue = WrappedValue | boolean | string;

const GRAIN_ENUMS: Record<string, readonly string[]> = {
  'grain.type': ['negative', 'positive'],
  'grain.mode': ['analogue', 'noise'],
};

/** 接受扁平值或 Schema 的 {value, origin} 包装，输出运行时参数 */
export function normalizeParams(raw: {
  texture?: Partial<{ [K in keyof TextureParams]: Partial<TextureParams[K]> }>;
  look?: Partial<LookParams>;
  master?: number;
}): FilmParams {
  const out = defaultParams();
  const num = (v: WrappedValue | undefined, d: number): number =>
    typeof v === 'object' && v !== null ? Number((v as { value: number }).value) || d :
      (typeof v === 'number' && isFinite(v) ? v : d);
  if (raw.texture) {
    for (const g of Object.keys(out.texture) as (keyof TextureParams)[]) {
      const src = raw.texture[g] as Record<string, RawValue> | undefined;
      if (!src) continue;
      const dst = out.texture[g] as unknown as Record<string, number | boolean | number[] | string>;
      for (const k of Object.keys(dst)) {
        const v = src[k];
        if (v === undefined) continue;
        if (typeof dst[k] === 'boolean') dst[k] = Boolean(v);
        else if (typeof dst[k] === 'string') {
          // v1.1 枚举字段（grain.type / grain.mode）：非法值静默忽略，保持默认
          const sv = typeof v === 'object' ? (v as { value?: unknown }).value : v;
          const allowed = GRAIN_ENUMS[`${g}.${k}`];
          if (typeof sv === 'string' && allowed?.includes(sv)) dst[k] = sv;
        } else if (Array.isArray(dst[k])) {
          const arr = typeof v === 'object' ? (v as { value: number[] }).value : (v as unknown as number[]);
          if (Array.isArray(arr) && arr.length === 3) dst[k] = arr.map((x) => Number(x) || 0);
        } else dst[k] = num(v as WrappedValue, dst[k] as number);
      }
    }
  }
  if (raw.look) {
    for (const k of LOOK_KEYS) {
      const v = (raw.look as Record<string, WrappedValue | undefined>)[k];
      if (v !== undefined) out.look[k] = num(v, out.look[k]);
    }
    /* —— Schema v1.3（R18）：coupling 六系数 + HSL 8 色相（可选；缺省不写 = 恒等/历史默认）——
     * 显式 0 是有意义值（如关闭某项串扰），故用保留 0 的读取器（区别于上方 num 的回退语义）。 */
    const rd = (v: unknown, d: number): number => {
      const x = typeof v === 'object' && v !== null ? (v as { value: unknown }).value : v;
      return typeof x === 'number' && isFinite(x) ? x : d;
    };
    const rc = (raw.look as Record<string, unknown>).coupling;
    if (rc && typeof rc === 'object') {
      const src = rc as Record<string, unknown>;
      const c: Record<string, number> = {};
      for (const k of Object.keys(DEFAULT_COUPLING) as (keyof CouplingParams)[]) {
        c[k] = rd(src[k], DEFAULT_COUPLING[k]);
      }
      out.look.coupling = c as Partial<CouplingParams>;
    }
    const rh = (raw.look as Record<string, unknown>).hsl;
    if (rh && typeof rh === 'object') {
      const src = rh as Record<string, Record<string, unknown>>;
      const hs: Record<string, { hue: number; sat: number; lum: number }> = {};
      for (const hue of HSL_HUES) {
        const ch = src[hue];
        if (!ch || typeof ch !== 'object') continue;
        hs[hue] = { hue: rd(ch.hue, 0), sat: rd(ch.sat, 0), lum: rd(ch.lum, 0) };
      }
      if (Object.keys(hs).length > 0) out.look.hsl = hs as Partial<HslParams>;
    }
  }
  if (raw.master !== undefined) out.master = num(raw.master, 1);
  return out;
}

/** 运行时参数 → Schema v1 texture 段（带 origin），供导出/JSON 面板 */
export function textureToSchema(t: TextureParams, origins: Record<string, Origin>) {
  const pv = (g: string, k: string, v: number) => ({ value: +v.toFixed(4), origin: origins[`${g}.${k}`] ?? 'user' });
  return {
    halation: {
      enabled: t.halation.enabled,
      amount: pv('halation', 'amount', t.halation.amount),
      radius: pv('halation', 'radius', t.halation.radius),
      tint_rgb: { value: t.halation.tint_rgb.map((x) => +x.toFixed(3)), origin: origins['halation.tint_rgb'] ?? 'user' },
      threshold: pv('halation', 'threshold', t.halation.threshold),
      // Schema v1.1
      background_gain: pv('halation', 'background_gain', t.halation.background_gain),
      amplify: pv('halation', 'amplify', t.halation.amplify),
      impact: pv('halation', 'impact', t.halation.impact),
      hue: pv('halation', 'hue', t.halation.hue),
      blue_comp: pv('halation', 'blue_comp', t.halation.blue_comp),
      smoothness: pv('halation', 'smoothness', t.halation.smoothness),
    },
    grain: {
      enabled: t.grain.enabled,
      iso: pv('grain', 'iso', t.grain.iso),
      size: pv('grain', 'size', t.grain.size),
      correlation: pv('grain', 'correlation', t.grain.correlation),
      shadow_weight: pv('grain', 'shadow_weight', t.grain.shadow_weight),
      // Schema v1.1
      shadow: pv('grain', 'shadow', t.grain.shadow),
      midtone: pv('grain', 'midtone', t.grain.midtone),
      highlight: pv('grain', 'highlight', t.grain.highlight),
      type: t.grain.type,
      film_resolution: pv('grain', 'film_resolution', t.grain.film_resolution),
      mode: t.grain.mode,
      // R9
      cluster: pv('grain', 'cluster', t.grain.cluster),
    },
    bloom: {
      enabled: t.bloom.enabled,
      amount: pv('bloom', 'amount', t.bloom.amount),
      radius: pv('bloom', 'radius', t.bloom.radius),
      threshold: pv('bloom', 'threshold', t.bloom.threshold),
      // Schema v1.1
      save_lights: pv('bloom', 'save_lights', t.bloom.save_lights),
      details: pv('bloom', 'details', t.bloom.details),
      saturation: pv('bloom', 'saturation', t.bloom.saturation),
    },
    vignette: {
      enabled: t.vignette.enabled,
      amount: pv('vignette', 'amount', t.vignette.amount),
      radius: pv('vignette', 'radius', t.vignette.radius),
      chroma_shift: pv('vignette', 'chroma_shift', t.vignette.chroma_shift),
    },
    // R9 片门抖动（amount = 0 即关闭；无 enabled 开关，见 GateWeaveParams 注释）
    gate_weave: {
      amount: pv('gate_weave', 'amount', t.gate_weave.amount),
      speed: pv('gate_weave', 'speed', t.gate_weave.speed),
    },
  };
}
export function lookToSchema(l: LookParams, origins: Record<string, Origin>) {
  const out: Record<string, unknown> = {};
  for (const k of LOOK_KEYS) out[k] = { value: +l[k].toFixed(4), origin: origins[`look.${k}`] ?? 'user' };
  /* —— Schema v1.3（R18）：coupling / hsl 仅在存在时写出（旧配方读入不添新键，逐位兼容）。
   * origins 键与 UI 一致：look.coupling.rg / look.hsl.red.hue。 */
  const pv = (v: number): number => +(v.toFixed(4));
  if (l.coupling) {
    const c: Record<string, { value: number; origin: Origin }> = {};
    for (const k of Object.keys(l.coupling) as (keyof CouplingParams)[]) {
      c[k] = { value: pv(l.coupling[k] ?? 0), origin: origins[`look.coupling.${k}`] ?? 'user' };
    }
    out.coupling = c;
  }
  if (l.hsl) {
    const hs: Record<string, Record<string, { value: number; origin: Origin }>> = {};
    for (const hue of HSL_HUES) {
      const ch = l.hsl[hue];
      if (!ch) continue;
      const cells: Record<string, { value: number; origin: Origin }> = {};
      for (const k of ['hue', 'sat', 'lum'] as const) {
        if (ch[k] === undefined) continue;
        cells[k] = { value: pv(ch[k]!), origin: origins[`look.hsl.${hue}.${k}`] ?? 'user' };
      }
      if (Object.keys(cells).length > 0) hs[hue] = cells;
    }
    if (Object.keys(hs).length > 0) out.hsl = hs;
  }
  return out;
}
