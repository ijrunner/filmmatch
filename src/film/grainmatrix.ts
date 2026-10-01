/* FilmMatch · 预设矩阵化（R2）数据层
 *
 * 回应「选择多」：型号卡之外再给两个正交维度——
 *   ① 颗粒 profile：画幅 8/16/35/65mm × 感光度 50/250/500 → 12 档；
 *   ② 光晕档：标准 / 去防光晕层（No Remjet，对应 FL-05 光匣的物理设定）。
 * 纯数据 + 纯函数，无 DOM/渲染依赖，便于单测与配方 JSON 溯源。
 *
 * 单位与既有 Schema 一致：size=画面高度‰，radius=画面高度%，其余为无量纲权重。
 * 文案遵守商标红线：只描述物理特性与观感，不出现第三方品牌/胶片商标。
 */
import type { GrainType, TextureParams } from './params';

export type FilmFormat = '8' | '16' | '35' | '65';
export type IsoStep = 50 | 250 | 500;

export interface GrainProfile {
  id: string;             // 'g-35-250'
  format: FilmFormat;
  iso: IsoStep;
  /** ‰H 颗粒基准间距：画幅越小颗粒越粗 */
  size: number;
  /** 1=单色颗粒 / 0=每通道独立 */
  correlation: number;
  shadow: number;
  midtone: number;
  highlight: number;
  /** 乳剂分辨率（高=颗粒更细、细节保留更好） */
  film_resolution: number;
  type: GrainType;
  note: string;
}

/* 画幅基准：尺寸/相关性/乳剂分辨率（画幅越大乳剂越细、颗粒越细） */
const FORMAT_BASE: Record<FilmFormat, { size: number; correlation: number; film_resolution: number; note: string }> = {
  '8': { size: 2.2, correlation: 0.35, film_resolution: 0.25, note: '小画幅：颗粒最粗、细节最少，强烈的年代感' },
  '16': { size: 1.7, correlation: 0.40, film_resolution: 0.40, note: '中画幅：颗粒明显但结构可读，纪录片气质' },
  '35': { size: 1.1, correlation: 0.45, film_resolution: 0.60, note: '标准画幅：颗粒细腻均匀，叙事片通用' },
  '65': { size: 0.75, correlation: 0.50, film_resolution: 0.80, note: '大画幅：颗粒极细、细节丰富，宽银幕观感' },
};

/* 感光度基准：尺寸微调 + 三段分布（越快暗部颗粒越明显） */
const ISO_BASE: Record<IsoStep, { sizeK: number; shadow: number; midtone: number; highlight: number; note: string }> = {
  50: { sizeK: 0.90, shadow: 0.80, midtone: 0.95, highlight: 0.15, note: '低感：颗粒最细、暗部干净' },
  250: { sizeK: 1.00, shadow: 1.00, midtone: 1.00, highlight: 0.20, note: '中感：均衡的颗粒结构' },
  500: { sizeK: 1.12, shadow: 1.20, midtone: 1.05, highlight: 0.30, note: '高感：暗部颗粒明显、整体更粗' },
};

export const FORMATS: FilmFormat[] = ['8', '16', '35', '65'];
export const ISO_STEPS: IsoStep[] = [50, 250, 500];

function buildProfiles(): GrainProfile[] {
  const out: GrainProfile[] = [];
  for (const f of FORMATS) {
    for (const iso of ISO_STEPS) {
      const fb = FORMAT_BASE[f], ib = ISO_BASE[iso];
      out.push({
        id: `g-${f}-${iso}`,
        format: f,
        iso,
        size: +(fb.size * ib.sizeK).toFixed(3),
        correlation: fb.correlation,
        shadow: ib.shadow,
        midtone: ib.midtone,
        highlight: ib.highlight,
        film_resolution: fb.film_resolution,
        type: 'negative',
        note: `${f}mm · ISO ${iso}：${fb.note}；${ib.note}`,
      });
    }
  }
  return out;
}

export const GRAIN_PROFILES: GrainProfile[] = buildProfiles();

export function grainProfileOf(format: FilmFormat, iso: IsoStep): GrainProfile {
  return GRAIN_PROFILES.find((p) => p.format === format && p.iso === iso) ?? GRAIN_PROFILES[0];
}
export function grainProfileById(id: string): GrainProfile | undefined {
  return GRAIN_PROFILES.find((p) => p.id === id);
}
export function grainProfileLabel(p: GrainProfile): string {
  return `${p.format}mm · ISO ${p.iso}`;
}

export type HalationProfileId = 'std' | 'noremjet';

export interface HalationProfile {
  id: HalationProfileId;
  name: string;
  note: string;
  amount: number;
  radius: number;
  amplify: number;
  smoothness: number;
  blue_comp: number;
}

/** 标准（带防光晕层，散射被吸收）/ 去防光晕层（散射直冲乳剂背面，晕大而敏感） */
export const HALATION_PROFILES: Record<HalationProfileId, HalationProfile> = {
  std: {
    id: 'std', name: '标准', note: '带防光晕层：散射被吸收，晕紧致、只在高光边缘可见',
    amount: 0.6, radius: 1.8, amplify: 1.0, smoothness: 0.5, blue_comp: 0.15,
  },
  noremjet: {
    id: 'noremjet', name: '去防光晕层', note: '去掉防光晕层：散射直冲乳剂背面，晕大、敏感度高、易在亮背景铺开',
    amount: 0.95, radius: 3.0, amplify: 1.35, smoothness: 0.65, blue_comp: 0.4,
  },
};
export const HALATION_PROFILE_IDS: HalationProfileId[] = ['std', 'noremjet'];

export interface TextureProfileRef {
  grain: string;             // GrainProfile.id
  halation: HalationProfileId;
}

/** 默认档位（新配方未显式选择时） */
export const DEFAULT_PROFILE: TextureProfileRef = { grain: 'g-35-250', halation: 'std' };

/** 把 profile 档位套到质感参数上（保留 enabled/tint/threshold 等非档位字段，纯函数不修改入参） */
export function applyProfile(
  texture: TextureParams, ref: TextureProfileRef,
): TextureParams {
  const g = grainProfileById(ref.grain);
  const h = HALATION_PROFILES[ref.halation] ?? HALATION_PROFILES.std;
  const out: TextureParams = JSON.parse(JSON.stringify(texture)) as TextureParams;
  if (g) {
    out.grain.size = g.size;
    out.grain.correlation = g.correlation;
    out.grain.shadow = g.shadow;
    out.grain.midtone = g.midtone;
    out.grain.highlight = g.highlight;
    out.grain.film_resolution = g.film_resolution;
    out.grain.type = g.type;
    out.grain.iso = g.iso;
  }
  out.halation.amount = h.amount;
  out.halation.radius = h.radius;
  out.halation.amplify = h.amplify;
  out.halation.smoothness = h.smoothness;
  out.halation.blue_comp = h.blue_comp;
  return out;
}

/** 校验 profile 引用（读配方/分享码时容错） */
export function normalizeProfileRef(raw: unknown): TextureProfileRef {
  const o = (raw ?? {}) as Partial<TextureProfileRef>;
  const grain = typeof o.grain === 'string' && grainProfileById(o.grain) ? o.grain : DEFAULT_PROFILE.grain;
  const halation: HalationProfileId =
    o.halation === 'noremjet' || o.halation === 'std' ? o.halation : DEFAULT_PROFILE.halation;
  return { grain, halation };
}
