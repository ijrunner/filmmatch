/* FilmMatch 菲林工坊 · DCTL 侧内联 CDL 的 JS 镜像 + 误差工具（R7）
 *
 * R7 把 R3 解算出的 ASC CDL 内联进 DCTL（单节点导出：匹配 + look + 质感）。生成的源码里
 *   fm_cdl_ch / fm_apply_cdl（见 codegen.ts 的「匹配段」）
 * 与这里的 applyInlineCdl **必须逐式同形**——本文件就是它的 JS 镜像。数学权威实现是
 * `../batch/cdl` 的 applyCdl（R3 导出走的那条路），DCTL 侧与镜像侧都不得偏离它。
 *
 * 本文件三件事：
 *   1) applyInlineCdl              与生成的 DCTL helper 1:1 同式
 *   2) compareInlineCdlToApplyCdl  镜像 vs 权威实现 applyCdl 的逐点分量差（回归守门）
 *   3) matchApproxReport           R7 验收③：engine 匹配 vs CDL 近似的误差报告（ΔE76 + 分量差）
 *
 * ⚠ 改 DCTL 侧（codegen.ts 里匹配段的字符串）必须同步改这里的 applyInlineCdl，
 *   反之亦然——两边一旦分叉，「网页端误差报告」就不再代表达芬奇里的实际数学。
 */
import { applyCdl, fitCdl, type Cdl } from '../batch/cdl';
import type { QuantileStats } from '../batch/quantiles';
import { deltaE76, labToRgbInto, rgbToLab } from '../engine/color';
import { buildTransform } from '../engine/match';
import { withSource, type ImageStats } from '../engine/stats';
import type { MatchParams, RGB } from '../engine/types';

/** DCTL 里 `FmMatchParams` 的 JS 等价物（字段顺序与生成源码逐字对应） */
interface FmMatchParams {
  sr: number; sg: number; sb: number;
  ofr: number; ofg: number; ofb: number;
  pr: number; pg: number; pb: number;
  sat: number;
}

/** CDL → 结构体（对应 transform 里把 FM_MATCH_* 读进 mp 的那几行） */
function packMatchParams(cdl: Cdl): FmMatchParams {
  return {
    sr: cdl.slope[0], sg: cdl.slope[1], sb: cdl.slope[2],
    ofr: cdl.offset[0], ofg: cdl.offset[1], ofb: cdl.offset[2],
    pr: cdl.power[0], pg: cdl.power[1], pb: cdl.power[2],
    sat: cdl.sat,
  };
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 单通道 CDL —— DCTL 侧 `fm_cdl_ch` 的逐字镜像（底数非正按 0 处理，保持单调、无 NaN） */
function cdlChannelMirror(x: number, s: number, o: number, p: number): number {
  const base = x * s + o;
  if (base <= 0) return 0;
  return Math.pow(base, p);
}

/**
 * 内联匹配段的完整正向：逐通道 (x*slope+offset)^power → 绕 Rec.709 亮度做饱和度 → 钳制 [0,1]。
 * 与 codegen.ts 生成的 `fm_apply_cdl` 1:1 同式；数值上也与 `../batch/cdl` 的 applyCdl 一致
 * （同一套公式与运算顺序）。
 */
export function applyInlineCdl(rgb: RGB, cdl: Cdl): RGB {
  const m = packMatchParams(cdl);
  const r = cdlChannelMirror(rgb[0], m.sr, m.ofr, m.pr);
  const g = cdlChannelMirror(rgb[1], m.sg, m.ofg, m.pg);
  const b = cdlChannelMirror(rgb[2], m.sb, m.ofb, m.pb);
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [
    clamp01(luma + m.sat * (r - luma)),
    clamp01(luma + m.sat * (g - luma)),
    clamp01(luma + m.sat * (b - luma)),
  ];
}

export interface InlineCdlDiff {
  /** 参与比较的点数 */
  n: number;
  /** 逐分量平均绝对差（0..1 域；分母为 3n） */
  meanAbs: number;
  /** 逐分量最大绝对差 */
  maxAbs: number;
}

/**
 * 镜像 vs 权威实现的逐点分量差（0..1 域）。
 * 为什么需要：DCTL 侧数学无法在 node 里执行，只能靠「同式镜像 + 权威实现」双端对拍来守回归；
 * 期望 maxAbs 极小（同式同序，理论上只差浮点表示）。
 */
export function compareInlineCdlToApplyCdl(points: RGB[], cdl: Cdl): InlineCdlDiff {
  let n = 0;
  let sum = 0;
  let max = 0;
  for (const p of points) {
    const a = applyInlineCdl(p, cdl);
    const b = applyCdl(p, cdl);
    n++;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[c] - b[c]);
      sum += d;
      if (d > max) max = d;
    }
  }
  return { n, meanAbs: n > 0 ? sum / (3 * n) : 0, maxAbs: max };
}

/* ================= R7 验收③：engine 匹配 vs CDL 近似的误差报告 ================= */

export interface MatchApproxReport {
  /** 用于 CDL 近似的拟合结果（已按 CDL_RANGES 收敛） */
  cdl: Cdl;
  /** 实际参与统计的采样点数 */
  n: number;
  /** 被排除的点数（engine 变换抛错或返回非有限值——优雅降级，不静默出错） */
  skipped: number;
  /** 逐分量平均绝对差（0..1 域；分母为 3n） */
  meanAbs: number;
  /** 逐分量最大绝对差 */
  maxAbs: number;
  /** ΔE76 平均 */
  meanDE: number;
  /** ΔE76 最大 */
  maxDE: number;
}

/** Lab 三元组 → sRGB（越界时沿 a*b* 收缩兜底，与 engine 的色域处理同一条路径） */
function labToRgb(lab: readonly [number, number, number]): RGB {
  const out = new Float64Array(3);
  labToRgbInto(lab[0], lab[1], lab[2], out, 0);
  return [out[0], out[1], out[2]];
}

/**
 * 由 engine 的 ImageStats（Lab 分区统计）构造 CDL 拟合所需的「锚点分位统计」：
 * 阴影/中间调/高光分区均值 ↔ p1/p50/p99，全局均值 ↔ mean（均转到 sRGB 0..1）。
 *
 * 为什么这样够用：CDL 的三点拟合本来就只需要三个锚点 + 一个中位色度参照；
 * 分区均值与分位点在语义上同指「暗部/中段/亮部」。差异是**有界的近似**——
 * 真实像素分位数与分区均值不完全相等，故报告的数值是「量级参考」而非逐位预测，
 * 这一点在生成页的告警里也写明了（诚实边界）。
 */
export function quantilesFromImageStats(s: ImageStats): QuantileStats {
  const p1 = labToRgb(s.zones.shadow.mean);
  const p50 = labToRgb(s.zones.mid.mean);
  const p99 = labToRgb(s.zones.high.mean);
  const mean = labToRgb(s.global.mean);
  return {
    p1,
    p50,
    p99,
    mean,
    luma: 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2],
    samples: s.samples,
  };
}

/** 5×5×5 RGB 网格边长（网格点 125 个，满足验收「采样点 ≥100」） */
const GRID_N = 5;

/**
 * 采样点 = 两图的分区/全局锚点（阴影/中段/高光/均值 × 2 图，共 8 点）
 *          + 5×5×5 RGB 网格（125 点）→ 合计 133 点。
 * 网格覆盖全色域（含灰轴与极端饱和），锚点保证「两图实际所处的色域」也被计到。
 */
function reportSamplePoints(userStats: ImageStats, refStats: ImageStats): RGB[] {
  const pts: RGB[] = [];
  for (const s of [userStats, refStats]) {
    pts.push(labToRgb(s.zones.shadow.mean), labToRgb(s.zones.mid.mean));
    pts.push(labToRgb(s.zones.high.mean), labToRgb(s.global.mean));
  }
  const last = GRID_N - 1;
  for (let i = 0; i < GRID_N; i++) {
    for (let j = 0; j < GRID_N; j++) {
      for (let k = 0; k < GRID_N; k++) {
        pts.push([i / last, j / last, k / last]);
      }
    }
  }
  return pts;
}

export interface MatchApproxOpts {
  /** 已经解算好的 CDL（R3 导出/批量页的那一组）。传了就**直接用它**——
   *  这样报告描述的就是真正内联进 DCTL 的那条数学，比现场拟合更准。 */
  cdl?: Cdl;
  /** 两图的真实逐通道分位数（批量页有）。传了就按 R3 的输入口径拟合（最接近 cdl.json 的解算结果）。 */
  quantiles?: { user: QuantileStats; ref: QuantileStats };
}

/**
 * R7 验收③的误差报告：同一组采样点上比较
 *   ① engine 匹配：buildTransform(参考统计，被调色图统计挂在 ref.source) —— 网页端的实际路径
 *   ② CDL 近似：applyCdl(点, cdl) —— R7 内联进 DCTL 的那条路
 * 返回逐分量绝对差（0..1 域）与 ΔE76 的均值/最大值。
 *
 * CDL 的来源按优先级取：`opts.cdl`（调用方已有的解算结果）→ `opts.quantiles`（真实分位数拟合）
 * → 由两图分区均值近似的锚点拟合（只需 ImageStats 时的兜底，与 R3 解算同量级但不逐位相同）。
 *
 * 优雅降级：engine 变换在某个点上抛错或返回非有限值时，该点被排除并计入 `skipped`
 * （n + skipped = 候选采样点总数），不静默出错、也不让 NaN 污染均值。
 * 若 engine 变换整体构建失败（极端统计），则全部点计入 skipped、n=0、各均值为 0。
 *
 * 报告怎么读（诚实边界）：
 *   - 采样点 = 两图锚点 + 5×5×5 全 RGB 立方，**含高饱和边缘点**：那里 engine 会沿 a*b* 收缩色域
 *     （软膝），而 CDL 只是逐通道曲线 + 钳制 → 单点 ΔE 可达上百，均值被这些点抬高。
 *     所以 meanDE 是「偏悲观的量级参考」，maxDE 是「最坏点」，不等于实拍素材上的观感差。
 *   - CDL 的可表达范围有限（CDL_RANGES：slope 0.5–2 / power 0.7–1.4）：大曝光差会让解算顶到
 *     边界（拟合饱和），这时两条路的差会明显放大——报告会照实反映。
 *   - CDL 拟合锚点是逐通道分位数（R3 口径），engine 的明度曲线锚点是 Lab 分区均值：
 *     两者锚定统计不同，中段形状也可能不同（CDL 只有 10 个浮点）。
 */
export function matchApproxReport(
  userStats: ImageStats,
  refStats: ImageStats,
  colorParams: MatchParams,
  opts: MatchApproxOpts = {},
): MatchApproxReport {
  const cdl = opts.cdl
    ?? fitCdl(
      opts.quantiles?.user ?? quantilesFromImageStats(userStats),
      opts.quantiles?.ref ?? quantilesFromImageStats(refStats),
    ).cdl;
  const points = reportSamplePoints(userStats, refStats);

  let engine: ((rgb: RGB) => RGB) | null = null;
  try {
    /* buildTransform 只冻结参考图统计，被调色图统计经 withSource 挂在 ref.source 上 */
    engine = buildTransform(withSource(refStats, userStats), colorParams);
  } catch {
    engine = null;
  }

  let n = 0;
  let skipped = 0;
  let sumAbs = 0;
  let maxAbs = 0;
  let sumDE = 0;
  let maxDE = 0;
  for (const p of points) {
    let e: RGB | null = null;
    if (engine) {
      try {
        e = engine(p);
      } catch {
        e = null;
      }
    }
    if (!e || !Number.isFinite(e[0]) || !Number.isFinite(e[1]) || !Number.isFinite(e[2])) {
      skipped++;
      continue;
    }
    const c = applyCdl(p, cdl);
    const d0 = Math.abs(e[0] - c[0]);
    const d1 = Math.abs(e[1] - c[1]);
    const d2 = Math.abs(e[2] - c[2]);
    const le = rgbToLab(e[0], e[1], e[2]);
    const lc = rgbToLab(c[0], c[1], c[2]);
    const de = deltaE76(le[0], le[1], le[2], lc[0], lc[1], lc[2]);
    n++;
    sumAbs += d0 + d1 + d2;
    if (d0 > maxAbs) maxAbs = d0;
    if (d1 > maxAbs) maxAbs = d1;
    if (d2 > maxAbs) maxAbs = d2;
    sumDE += de;
    if (de > maxDE) maxDE = de;
  }
  return {
    cdl,
    n,
    skipped,
    meanAbs: n > 0 ? sumAbs / (3 * n) : 0,
    maxAbs,
    meanDE: n > 0 ? sumDE / n : 0,
    maxDE,
  };
}
