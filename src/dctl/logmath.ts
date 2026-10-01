/* FilmMatch 菲林工坊 · DCTL 数学层（R4）
 *
 * 为什么需要「归一化对数域」：达芬奇里的 look（对比度 / toe / shoulder / 串扰）本质是
 * 在感知均匀的编码域里做「相对量」操作。直接对 sRGB gamma 编码做幂律 S 曲线，暗部会
 * 欠采样、且换管线（YRGB / RCM / ACES）时数值含义不一致。统一到 x∈[0,1] 的归一化对数域后：
 *   - 对比度 = 绕 pivot 的斜率（相对量，与管线无关）；
 *   - toe / shoulder = 相对 pivot 的两段压缩/滚降；
 *   - 串扰 / 饱和度 / 冷暖 = 与 gamma 空间同系数的相对操作。
 *
 * 管线 TF：
 *   yrgb：BT.1886 EOTF（简化幂律 2.4）→ linear → log2 → 归一化。锚点 0→0、0.18→0.5、1→1。
 *         log2 需要有限自变量，故在 linear 域加黑位偏移 eps=0.050625——该值由「0.18 必须
 *         落在 0.5」唯一确定（见下方推导注释），保证往返可逆、无黑位截断。
 *   rcm ：DaVinci Intermediate 本身就是归一化对数编码（0=黑、1=白、中灰≈0.333），
 *         故「对数编码域直接重归一化」= 恒等（仅钳位），pivot 取 0.333。
 *   aces：预留（reserved）。生成时退化为 rcm 的 TF，并给出警告，等待实测校准。
 *
 * 本模块为纯函数、无 DOM 依赖，可在 node 中直接单测；DCTL 生成器逐式镜像这些公式。
 */
import { clamp01, luma, anchorsToLookCal, lookTonalLandings, type CardAnchors, type PipelineAnchors } from '../film/effectmath';
import type { LookParams } from '../film/params';
import {
  splitBalanceGains, splitHueRGB, SPLIT_SCALE, normalizeCoupling, hslAdjustRgb, hslIsIdentity,
  type CouplingCoeffs, type HslAdjustments,
} from '../engine/look';
import type { RGB } from '../engine/types';

export type PipelineTF = 'yrgb' | 'rcm' | 'aces';

export interface PipelineInfo {
  id: PipelineTF;
  name: string;
  note: string;
  reserved?: boolean;
}

/** 支持的管线 TF 列表（aces 为预留：生成时给出警告并退化） */
export const PIPELINES: PipelineInfo[] = [
  {
    id: 'yrgb',
    name: 'YRGB / Rec.709',
    note: 'BT.1886 EOTF → linear → log2 → 归一化（pivot 0.18→0.5）',
  },
  {
    id: 'rcm',
    name: 'RCM / DaVinci Intermediate',
    note: '对数编码域直接重归一化（pivot≈0.333）',
  },
  {
    id: 'aces',
    name: 'ACES',
    note: '预留：尚未实测校准，生成时退化为 RCM（DaVinci Intermediate）的 TF',
    reserved: true,
  },
];

export interface LogLookParams {
  contrast: number;    // 0..2（1=恒等）：对数域绕 pivot 的斜率
  toe: number;         // 0..1：阴影压缩量
  shoulder: number;    // 0..1：高光滚降量
  pivot: number;       // 0..1 归一化对数域枢轴（yrgb 0.5 / rcm 0.333）
  crosstalk: number;   // 0..0.4：染料串扰（通道交叉混合，与 gamma 空间的 dye_coupling 同语义）
  saturation: number;  // 0..2
  warmth: number;      // -1..1
  fade: number;        // 0..1 褪色（黑位提升+白位收拢）
  shadow_bias: number; // 0..1 暗部青蓝
  highlight_bias: number; // 0..1 高光暖黄
  film_s: number;      // 0..1 软S（对数域 S 形）
  gamma_contrast: number; // 0..1 正片反S
  /* Schema v1.2 分离色调（显示域 look 语义，与 LookParams 同名同义；默认全 0 = 恒等） */
  split_shadow_hue: number;    // 0..1
  split_shadow_sat: number;    // 0..1
  split_highlight_hue: number; // 0..1
  split_highlight_sat: number; // 0..1
  split_balance: number;       // -1..1
  /* —— R18 ——
   * black_lift：对数域黑位提升（0..1，默认 0）。仅由「管线锚点重标定」写入（见 anchorsToLookCal）；
   * 无锚点路径恒为 0 → blk = fade×0.10，与 R18 之前逐位一致。DCTL 侧烘焙为常量（不占 UI 参数）。
   * coupling：串扰六系数（缺省 = 历史固定矩阵）；DCTL 侧烘焙为常量（不占 UI 参数）。
   * hsl：存在标记（applyLogLook 不消费——DCTL 不承载 HSL 维度）；生成器据此给出诚实警告。 */
  black_lift?: number;
  coupling?: Partial<CouplingCoeffs>;
  hsl?: Partial<HslAdjustments>;
}

/* ================= 管线 TF ================= */

/* 黑位偏移：令 log2(L+eps) 有限，且同时满足 encode(0)=0、encode(1)=1、encode(0.18)=0.5。
 * 推导：设 A=log2(eps)（L=0）、B=log2(1+eps)（L=1），归一化 x=(log2(L+eps)-A)/(B-A)。
 * 要求 x(0.18)=0.5 ⇔ 0.18+eps = sqrt(eps·(1+eps)) ⇔ 0.0324 + 0.36eps = eps ⇔ eps=0.050625。 */
export const YRGB_EPS = 0.050625;
export const YRGB_LOG_LO = Math.log2(YRGB_EPS);        // ≈ -4.3047
export const YRGB_LOG_HI = Math.log2(1 + YRGB_EPS);    // ≈ 0.07126
const YRGB_GAMMA = 2.4;                                 // BT.1886 简化幂律
const YRGB_INV_GAMMA = 1 / YRGB_GAMMA;

function yrgbEncode(v: number): number {
  const L = Math.pow(clamp01(v), YRGB_GAMMA);           // EOTF：显示编码 → linear
  const t = Math.log2(L + YRGB_EPS);
  return clamp01((t - YRGB_LOG_LO) / (YRGB_LOG_HI - YRGB_LOG_LO));
}

function yrgbDecode(x: number): number {
  const t = YRGB_LOG_LO + clamp01(x) * (YRGB_LOG_HI - YRGB_LOG_LO);
  const L = Math.max(0, Math.pow(2, t) - YRGB_EPS);     // 反向去偏移，防负数再开幂
  return clamp01(Math.pow(L, YRGB_INV_GAMMA));
}

/** 显示编码（sRGB gamma 0..1）→ 归一化对数域 x∈[0,1] */
export function tfEncode(tf: PipelineTF, v: number): number {
  const c = clamp01(v);
  // rcm/aces：DI 已是归一化对数编码，直接重归一化 = 恒等
  return tf === 'yrgb' ? yrgbEncode(c) : c;
}

/** 归一化对数域 x∈[0,1] → 显示编码 0..1 */
export function tfDecode(tf: PipelineTF, v: number): number {
  const c = clamp01(v);
  return tf === 'yrgb' ? yrgbDecode(c) : c;
}

/** 往返恒等性检查：tfDecode(tf, tfEncode(tf, v)) 与 v 的最大误差（返回 {maxErr, at}） */
export function tfRoundTripError(tf: PipelineTF, n = 1024): { maxErr: number; at: number } {
  let maxErr = 0;
  let at = 0;
  const N = Math.max(2, Math.floor(n));
  for (let i = 0; i < N; i++) {
    const v = i / (N - 1);                              // 含端点 0 与 1
    const e = Math.abs(tfDecode(tf, tfEncode(tf, v)) - v);
    if (e > maxErr) { maxErr = e; at = v; }
  }
  return { maxErr, at };
}

/* ================= 对数域 look（纯函数） ================= */

/** 以 pivot 为不动点、端点 0/1 锚定的软 S（对数域 S 形；s=0 恒等，单调不减） */
function softS(x: number, pivot: number, s: number): number {
  if (s <= 1e-6) return x;
  const p = clamp01(pivot);
  const lo = p < 1e-6 ? 1e-6 : p;                       // 防 pivot 落在端点导致除零
  const hi = 1 - p < 1e-6 ? 1e-6 : 1 - p;
  if (x <= p) {
    const u = clamp01(x / lo);
    const su = u * u * (3 - 2 * u);
    return p * (u + (su - u) * s);
  }
  const u = clamp01((x - p) / hi);
  const su = u * u * (3 - 2 * u);
  return p + hi * (u + (su - u) * s);
}

/** 正片反 S：全 [0,1] 范围的软 S（与 pipeline shapePos 同式，端点/中点锚定；s=0 恒等） */
function gammaS(x: number, s: number): number {
  if (s <= 1e-6) return x;
  const su = x * x * (3 - 2 * x);
  return x + (su - x) * s;
}

/** toe（阴影压缩=抬升暗部、降暗部对比）/ shoulder（高光滚降）；均为单调不减、端点锚定 */
function toeShoulder(x: number, pivot: number, toe: number, shoulder: number): number {
  const p = clamp01(pivot);
  let y = x;
  if (toe > 1e-6 && y < p && p > 1e-6) {
    const u = clamp01(y / p);
    y = p * Math.pow(u, 1 / (1 + toe));                 // 指数<1 → 抬升暗部
  }
  if (shoulder > 1e-6 && y > p && p < 1 - 1e-6) {
    const u = clamp01((y - p) / (1 - p));
    y = p + (1 - p) * (1 - Math.pow(1 - u, 1 + shoulder)); // 指数>1 → 高光滚降
  }
  return y;
}

/** 染料串扰矩阵（与 GRADE_FS dyeCross 同系数；k=0 时逐位恒等；六系数缺省 = 历史固定矩阵） */
function applyCrosstalk(c: RGB, k: number, coupling: CouplingCoeffs): RGB {
  return [
    c[0] * (1 - k) + c[1] * (k * coupling.rg) + c[2] * (k * coupling.rb),
    c[0] * (k * coupling.gr) + c[1] * (1 - k * 0.8) + c[2] * (k * coupling.gb),
    c[0] * (k * coupling.br) + c[1] * (k * coupling.bg) + c[2] * (1 - k * 1.6),
  ];
}

/**
 * 对数域 look（纯函数，逐通道 + 通道交叉）。
 * 操作顺序与 pipeline.GRADE_FS 的非 LUT 分支对齐（对比度→S→toe/shoulder→串扰→
 * 分通道偏置→褪色→饱和→冷暖→钳位），保证网页预览与 DCTL 输出同源。
 * 中性参数（contrast=1，其余 0/1）→ 恒等。
 */
export function applyLogLook(rgb: RGB, p: LogLookParams): RGB {
  const pivot = clamp01(p.pivot);
  const contrast = Math.max(0, p.contrast);
  let c: RGB = [rgb[0], rgb[1], rgb[2]];

  // 1) 对数域对比度：绕 pivot 的斜率
  if (Math.abs(contrast - 1) > 1e-9) {
    c = [pivot + (c[0] - pivot) * contrast, pivot + (c[1] - pivot) * contrast, pivot + (c[2] - pivot) * contrast];
  }
  // 2) 软 S（电影负片观感）
  if (p.film_s > 1e-6) c = [softS(c[0], pivot, p.film_s), softS(c[1], pivot, p.film_s), softS(c[2], pivot, p.film_s)];
  // 3) 正片反 S
  if (p.gamma_contrast > 1e-6) c = [gammaS(c[0], p.gamma_contrast), gammaS(c[1], p.gamma_contrast), gammaS(c[2], p.gamma_contrast)];
  // 4) toe / shoulder
  if (p.toe > 1e-6 || p.shoulder > 1e-6) {
    c = [
      toeShoulder(c[0], pivot, p.toe, p.shoulder),
      toeShoulder(c[1], pivot, p.toe, p.shoulder),
      toeShoulder(c[2], pivot, p.toe, p.shoulder),
    ];
  }
  // 5) 染料串扰（R18：六系数缺省 = 历史固定矩阵，逐位兼容）
  if (p.crosstalk > 1e-9) c = applyCrosstalk(c, p.crosstalk, normalizeCoupling(p.coupling));

  // 6) 分通道反向偏置（暗部青蓝 / 高光暖黄，相对量）
  const l = luma(c);
  const sh = Math.pow(clamp01(1 - l), 2.2);
  const hi = Math.pow(clamp01(l), 2.2);
  c[0] += p.shadow_bias * (-0.10 * sh) + p.highlight_bias * (0.10 * hi);
  c[1] += p.shadow_bias * (0.02 * sh) + p.highlight_bias * (0.08 * hi);
  c[2] += p.shadow_bias * (0.16 * sh) + p.highlight_bias * (-0.18 * hi);

  // 6b) 分离色调（Schema v1.2）：暗部/高光各自色相方向 × 饱和度 × 亮度权重
  //     与 engine/look、GRADE_FS 同式；sat=0 时贡献为 +0（逐位恒等）
  const spShSat = clamp01(p.split_shadow_sat ?? 0);
  const spHiSat = clamp01(p.split_highlight_sat ?? 0);
  if (spShSat > 1e-9 || spHiSat > 1e-9) {
    const gains = splitBalanceGains(p.split_balance ?? 0);
    const ds = splitHueRGB(clamp01(p.split_shadow_hue ?? 0));
    const dh = splitHueRGB(clamp01(p.split_highlight_hue ?? 0));
    const ss = SPLIT_SCALE * spShSat * gains.shadow;
    const hs = SPLIT_SCALE * spHiSat * gains.highlight;
    c[0] += ds[0] * ss * sh + dh[0] * hs * hi;
    c[1] += ds[1] * ss * sh + dh[1] * hs * hi;
    c[2] += ds[2] * ss * sh + dh[2] * hs * hi;
  }

  // 7) 褪色：黑位提升 + 白位收拢（R18：black_lift 为锚点重标定写入的对数域黑位，默认 0 → 逐位一致）
  const blk = p.fade * 0.10 + (p.black_lift ?? 0);
  const wht = p.fade * 0.08;
  const scale = 1 - blk - wht;
  c = [blk + clamp01(c[0]) * scale, blk + clamp01(c[1]) * scale, blk + clamp01(c[2]) * scale];

  // 8) 饱和度（以亮度为轴）
  const l2 = luma(c);
  c = [l2 + (c[0] - l2) * p.saturation, l2 + (c[1] - l2) * p.saturation, l2 + (c[2] - l2) * p.saturation];

  // 9) 冷暖
  c = [c[0] * (1 + p.warmth * 0.05), c[1] * (1 + p.warmth * 0.01), c[2] * (1 - p.warmth * 0.05)];

  // 10) 输出钳位（对应 GRADE_FS 末尾 gl_FragColor 的 clamp）
  return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
}

/* ================= 现有 gamma 空间 look 的纯函数镜像 ================= */

/** 家族A 参考曲线（与 GRADE_FS refS 逐式一致） */
function refS(x: number): number {
  const lin = 0.42 + (x - 0.42) * 0.76;
  const toe = 0.030 + (lin - 0.030) * Math.pow(clamp01(x / 0.42), 0.75);
  let y = toe + (lin - toe) * smoothstep01(0.02, 0.24, x);
  if (x > 0.55) {
    const u = (x - 0.55) / 0.45;
    y = 0.5188 + u * (0.342 + u * (0.7596 - u * 0.6204));
  }
  return y;
}

function smoothstep01(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/**
 * 现有 gamma 空间 look 的纯函数镜像（必须与 pipeline.ts GRADE_FS 的非 LUT 分支逐式一致）。
 * 用于 R4 一致性核验：同一组 LookParams 下，gammaLook 与对数域 applyLogLook 的差异可量化。
 */
export function gammaLook(rgb: RGB, look: LookParams): RGB {
  const shapePos = (x: number): number => (look.contrast <= 0.001 ? x : x + (x * x * (3 - 2 * x) - x) * look.contrast);
  const shapeNeg = (x: number): number => (look.film_s <= 0.001 ? x : x + (refS(x) - x) * look.film_s);
  let r = shapeNeg(shapePos(rgb[0]));
  let g = shapeNeg(shapePos(rgb[1]));
  let b = shapeNeg(shapePos(rgb[2]));
  // 染料耦合（R18：六系数缺省 = 历史固定矩阵，逐位兼容）
  const k = look.dye_coupling;
  const cp = normalizeCoupling(look.coupling);
  const r2 = r * (1 - k) + g * (k * cp.rg) + b * (k * cp.rb);
  const g2 = r * (k * cp.gr) + g * (1 - k * 0.8) + b * (k * cp.gb);
  const b2 = r * (k * cp.br) + g * (k * cp.bg) + b * (1 - k * 1.6);
  r = r2; g = g2; b = b2;
  // 分通道反向偏置
  const l = luma([r, g, b]);
  const sh = Math.pow(clamp01(1 - l), 2.2);
  const hi = Math.pow(clamp01(l), 2.2);
  r += look.shadow_bias * (-0.10 * sh) + look.highlight_bias * (0.10 * hi);
  g += look.shadow_bias * (0.02 * sh) + look.highlight_bias * (0.08 * hi);
  b += look.shadow_bias * (0.16 * sh) + look.highlight_bias * (-0.18 * hi);
  // 分离色调（Schema v1.2，与 GRADE_FS 非 LUT 分支同式；sat=0 贡献为 +0）
  const spShSat = clamp01(look.split_shadow_sat ?? 0);
  const spHiSat = clamp01(look.split_highlight_sat ?? 0);
  if (spShSat > 1e-9 || spHiSat > 1e-9) {
    const gains = splitBalanceGains(look.split_balance ?? 0);
    const ds = splitHueRGB(clamp01(look.split_shadow_hue ?? 0));
    const dh = splitHueRGB(clamp01(look.split_highlight_hue ?? 0));
    const ss = SPLIT_SCALE * spShSat * gains.shadow;
    const hs = SPLIT_SCALE * spHiSat * gains.highlight;
    r += ds[0] * ss * sh + dh[0] * hs * hi;
    g += ds[1] * ss * sh + dh[1] * hs * hi;
    b += ds[2] * ss * sh + dh[2] * hs * hi;
  }
  // HSL 8 色相（R18，与 GRADE_FS / engine/look 同式；全 0 或缺省 → 跳过，逐位恒等）
  if (!hslIsIdentity(look.hsl)) {
    [r, g, b] = hslAdjustRgb([r, g, b], look.hsl!);
  }
  // 褪色（黑位提升 + 白位收拢）
  const blk = look.black_lift + look.fade * 0.10;
  const wht = look.fade * 0.08;
  r = blk + clamp01(r) * (1 - blk - wht);
  g = blk + clamp01(g) * (1 - blk - wht);
  b = blk + clamp01(b) * (1 - blk - wht);
  // 饱和度 + 冷暖
  const l2 = luma([r, g, b]);
  r = (l2 + (r - l2) * look.saturation) * (1 + look.warmth * 0.05);
  g = (l2 + (g - l2) * look.saturation) * (1 + look.warmth * 0.01);
  b = (l2 + (b - l2) * look.saturation) * (1 - look.warmth * 0.05);
  return [clamp01(r), clamp01(g), clamp01(b)];
}

/* ================= LookParams → 对数域等价参数 ================= */

/**
 * 显示域 look 的关键点位 → 该管线归一化域的锚点（C3 推导方向）。
 *   显示域落点 D = black_lift + 0.1×fade、W = 1 − 0.08×fade（与 engine/look 同式）；
 *   锚点 = 该落点经管线 TF 编码（yrgb：BT.1886→log2 归一化；rcm：DI 重归一化 = 恒等），
 *   pivot = 管线枢轴（yrgb 0.5 / rcm 0.333）。
 * 与 anchorsToLookCal（effectmath，反解方向）互为正逆，构成「切管线语义不漂移」的闭环。
 */
export function anchorsFromLook(look: LookParams, tf: PipelineTF): PipelineAnchors {
  const land = lookTonalLandings(look.fade ?? 0, look.black_lift ?? 0);
  return {
    black: tfEncode(tf, land.black),
    white: tfEncode(tf, land.white),
    pivot: tf === 'yrgb' ? 0.5 : 0.333,
  };
}

/**
 * 把现有 LookParams 映射为对数域等价参数（默认 pivot 取该管线值；保证中性参数→恒等）。
 * 语义对照：
 *   dye_coupling → crosstalk（同系数矩阵，R18 起六系数随 look.coupling 透传，DCTL 侧烘焙为常量）；
 *   contrast（家族B 反S 强度）→ gamma_contrast；film_s → film_s；
 *   black_lift 折入 fade（对数域没有独立黑位字段，褪色项已含黑位提升）。
 *   LogLookParams.contrast 保持 1（对数域斜率恒等），供 DCTL 面板单独调节。
 * R18 anchors（可选）：传入目标管线锚点时，fade / 对数域 black_lift / pivot 由锚点重标定
 *   （effectmath.anchorsToLookCal）——切管线用锚点重标定，关键点位落点不漂移；
 *   不传（或卡/配方无锚点）→ 与 R18 之前逐位一致。
 */
export function lookToLogLook(look: LookParams, tf: PipelineTF, anchors?: PipelineAnchors): LogLookParams {
  const pivot = tf === 'yrgb' ? 0.5 : 0.333;
  const out: LogLookParams = {
    contrast: 1,
    toe: 0,
    shoulder: 0,
    pivot,
    crosstalk: Math.min(0.4, Math.max(0, look.dye_coupling)),
    saturation: look.saturation,
    warmth: look.warmth,
    fade: clamp01(look.fade + look.black_lift),
    shadow_bias: look.shadow_bias,
    highlight_bias: look.highlight_bias,
    film_s: clamp01(look.film_s),
    gamma_contrast: clamp01(look.contrast),
    /* Schema v1.2 分离色调：显示域 look 语义，直接透传（色相钳到 [0,1]，平衡钳到 [-1,1]） */
    split_shadow_hue: clamp01(look.split_shadow_hue ?? 0),
    split_shadow_sat: clamp01(look.split_shadow_sat ?? 0),
    split_highlight_hue: clamp01(look.split_highlight_hue ?? 0),
    split_highlight_sat: clamp01(look.split_highlight_sat ?? 0),
    split_balance: Math.min(1, Math.max(-1, look.split_balance ?? 0)),
    /* R18：串扰六系数透传（DCTL 侧烘焙为常量；缺省 = 历史固定矩阵）；
     * hsl 仅作「配方带 HSL」的存在标记（DCTL 不承载，生成器据此诚实警告）。 */
    coupling: normalizeCoupling(look.coupling),
    ...(look.hsl ? { hsl: look.hsl } : {}),
  };
  if (anchors) {
    const cal = anchorsToLookCal(anchors);
    out.fade = cal.fade;
    out.black_lift = cal.black_lift;
    out.pivot = cal.pivot;
  }
  return out;
}

/** 卡/配方锚点表 → 指定管线的锚点（无则 undefined = 不重标定，行为不变） */
export function anchorsForPipeline(a: CardAnchors | undefined | null, tf: PipelineTF): PipelineAnchors | undefined {
  if (!a) return undefined;
  return tf === 'yrgb' ? a.yrgb : a.rcm;
}
