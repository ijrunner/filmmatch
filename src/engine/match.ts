/**
 * 色彩匹配变换：由参考图/被调色图统计 + 9 参数构建逐像素纯函数 f(rgb)->rgb。
 *
 * 硬约束：f 不依赖空间位置与邻域（可烘焙进 3D LUT）。
 * 管线（单像素）：
 *   1) sRGB -> Lab
 *   2) 明度：分区均值/方差对齐(×strength) -> 中间调对比 -> 黑位提升 -> 高光肩部，
 *      全部合成进一条密集单调锚点表（插值输出，保证无 banding、可烘焙）
 *   3) 色度：全局色偏对齐(×strength，掩码内随 isolation 抑制)
 *      -> 肤色 hue/sat（仅掩码内）-> 分离色调（参考图派生，两端叠加）
 *      -> 全局饱和（最后）-> 平滑色域包络软膝压缩（保 L*，随 strength 缩放）
 *   4) Lab -> sRGB（色域残余越界时沿 a*b* 收缩兜底，保持明度）
 *
 * 注意：buildTransform 只冻结单统计参数（ref = 参考图/观感目标）；
 * 被调色图统计通过 ImageStats.source 挂载（见 withSource）。
 * 未挂载时按「中性标准画面」处理，即把参考观感套在标准源上。
 */
import { labInGamut, labToRgbInto, rgbToLabInto } from './color';
import {
  ImageStats,
  neutralSourceStats,
  ZoneStats,
  zoneWeights,
} from './stats';
import { MatchParams, normalizeParams, RGB } from './types';
import { clamp, clamp01, smoothstep } from './util';

/** 明度曲线锚点数（0..100 均匀 129 点） */
const LUT_ANCHORS = 128;
/** 分区标准差比对齐斜率的钳制范围，防止过冲 */
const SD_K_MIN = 0.55;
const SD_K_MAX = 1.8;
/** 全局色偏对齐的单轴上限（Lab 的 a 轴/b 轴单位），防御异常统计 */
const CAST_AB_LIMIT = 25;
/** 分离色调强度阻尼（分区相对色度偏移直接叠加会过头） */
const SPLIT_DAMP = 0.5;
/** 分离色调的明度过渡区间（l 归一化） */
const SPLIT_LOW = 0.2;
const SPLIT_HIGH = 0.8;
/** 肤色域中心/尺度（CIELAB a*b*，实测肤域拟合的宽松高斯） */
const SKIN_A = 14;
const SKIN_B = 18;
const SKIN_SA = 9;
const SKIN_SB = 10;
/** 肤色掩码的亮度窗（中亮区权重） */
const SKIN_L_LO1 = 28, SKIN_L_LO2 = 46, SKIN_L_HI1 = 76, SKIN_L_HI2 = 94;
/** skin_hue=±1 对应的最大色相旋转（弧度） */
const SKIN_HUE_MAX = (12 * Math.PI) / 180;
/** 黑位提升最大幅度（L* 单位，黑处） */
const LIFT_MAX = 12;
/** 高光肩部起始点与最大下压幅度（L* 单位） */
const ROLLOFF_START = 68;
const ROLLOFF_MAX = 10;
/**
 * 单调化时的最小斜率（输出 L* / 输入 L*）。
 * 曲线被钳制成平台时，插值角点因 RGB 三通道对亮度贡献不对称
 * （G 权重远大于 R+B）会在灰轴上产生微小逆序；最小斜率让趋势压过该扰动。
 */
const MONO_MIN_SLOPE = 0.1;
/**
 * 顶部斜率封顶（y* >= TOP_ZONE_Y 段，斜率 <= TOP_SLOPE_MAX）。
 * 白点尖端处色域边界随 L* 塌陷极快（每 L* 可达 -15 色度），明度映射
 * 斜率 > 1 会把饱和色成片推进塌陷区，导致 LUT 不可插值；高光滚降的
 * 本义即是顶部斜率不超过线性，故在此强制。
 */
const TOP_SLOPE_MAX = 1.0;
const TOP_ZONE_Y = 88;

/* ---------------- 平滑色域包络 ----------------
 * 真实 sRGB 色域边界在 Lab 的主色 cusp 与白点尖端处随色相/明度变化极陡，
 * 逐像素钳制到真实边界会让变换函数无法被 65³ LUT 插值忠实重建。
 * 解决：预计算真实边界 -> 模糊 -> 留安全余量，得到一条光滑包络，
 * 色度超出包络时沿原色相方向做 C1 软膝压缩（保持 L*）。
 * 压缩量随 match_strength 缩放：strength=0 时变换严格恒等。
 */
const ENV_L_STEP = 1.5;
const ENV_H_STEP = 2.5;
const ENV_NL = Math.round(100 / ENV_L_STEP) + 1;
const ENV_NH = Math.round(360 / ENV_H_STEP);
const ENV_MARGIN = 1.5;
/** 软膝参数：压缩自 x = 1-KNEE_K 开始（x = 色度/包络），x→∞ 渐近包络 */
const KNEE_K = 0.35;
const KNEE_LO = 1 - KNEE_K;
const KNEE_HI = 1.3;

let ENVELOPE: Float32Array | null = null;

/** 真实色域边界色度：二分求沿 (L,hue) 射线入域的最大色度 */
function boundaryChroma(L: number, hueRad: number): number {
  const ca = Math.cos(hueRad);
  const sb = Math.sin(hueRad);
  if (!labInGamut(L, 0.5 * ca, 0.5 * sb)) return 0;
  let lo = 0;
  let hi = 40;
  while (hi < 200 && labInGamut(L, hi * ca, hi * sb)) {
    lo = hi;
    hi *= 2;
  }
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (labInGamut(L, mid * ca, mid * sb)) lo = mid;
    else hi = mid;
  }
  return lo;
}

function buildEnvelope(): Float32Array {
  const raw = new Float64Array(ENV_NL * ENV_NH);
  for (let il = 0; il < ENV_NL; il++) {
    const L = il * ENV_L_STEP;
    for (let ih = 0; ih < ENV_NH; ih++) {
      raw[il * ENV_NH + ih] = boundaryChroma(L, (ih * ENV_H_STEP * Math.PI) / 180);
    }
  }
  // 盒式模糊 x2（色相循环、L 端点延伸），得到光滑但仍保守的包络
  let src = raw;
  for (let pass = 0; pass < 2; pass++) {
    const dst = new Float64Array(ENV_NL * ENV_NH);
    for (let il = 0; il < ENV_NL; il++) {
      for (let ih = 0; ih < ENV_NH; ih++) {
        let sum = 0;
        let cnt = 0;
        for (let dl = -2; dl <= 2; dl++) {
          const jl = Math.min(ENV_NL - 1, Math.max(0, il + dl));
          for (let dh = -2; dh <= 2; dh++) {
            const jh = (ih + dh + ENV_NH) % ENV_NH;
            sum += src[jl * ENV_NH + jh];
            cnt++;
          }
        }
        dst[il * ENV_NH + ih] = sum / cnt;
      }
    }
    src = dst;
  }
  // 安全余量 + 逐点不超过真实边界（防止 cusp 处模糊上冲导致真实裁剪）
  const env = new Float32Array(ENV_NL * ENV_NH);
  for (let i = 0; i < env.length; i++) {
    env[i] = Math.max(0, Math.min(src[i], raw[i]) - ENV_MARGIN);
  }
  return env;
}

function getEnvelope(): Float32Array {
  if (!ENVELOPE) ENVELOPE = buildEnvelope();
  return ENVELOPE;
}

/** 双线性查询平滑包络色度（L: 0..100，hueRad 任意） */
function envLookup(env: Float32Array, L: number, hueRad: number): number {
  let h = (hueRad * 180) / Math.PI;
  h = ((h % 360) + 360) % 360;
  const fh = h / ENV_H_STEP;
  const fl = clamp(L, 0, 100) / ENV_L_STEP;
  const ih0 = Math.min(ENV_NH - 1, fh | 0);
  const il0 = Math.min(ENV_NL - 1, fl | 0);
  const th = fh - ih0;
  const tl = fl - il0;
  const ih1 = (ih0 + 1) % ENV_NH;
  const il1 = Math.min(ENV_NL - 1, il0 + 1);
  const v00 = env[il0 * ENV_NH + ih0];
  const v01 = env[il0 * ENV_NH + ih1];
  const v10 = env[il1 * ENV_NH + ih0];
  const v11 = env[il1 * ENV_NH + ih1];
  const a0 = v00 + (v01 - v00) * th;
  const a1 = v10 + (v11 - v10) * th;
  return a0 + (a1 - a0) * tl;
}

// 闭包内热路径共用缓冲：同步单线程使用，无重入
const SCRATCH = new Float64Array(3);
const ZW = [0, 0, 0];

/** 分区对齐候选：c(l) = mr + (l - ms) * k（仿射，k>0 保证单调） */
interface ZoneAlign {
  ms: number;
  mr: number;
  k: number;
}

function alignOf(s: ZoneStats, r: ZoneStats): ZoneAlign {
  const sds = Math.sqrt(Math.max(0, s.variance[0]));
  const sdr = Math.sqrt(Math.max(0, r.variance[0]));
  const k = sds > 0.5 ? clamp(sdr / sds, SD_K_MIN, SD_K_MAX) : 1;
  return { ms: s.mean[0], mr: r.mean[0], k };
}

/**
 * 构建明度单调映射表（129 锚点）。
 * 统计对齐 -> 中间调对比 -> 黑位提升 -> 高光肩部 逐级复合；
 * 各级均为单调增函数，末尾再做一次数值单调化与 [0,100] 钳制兜底。
 */
function buildLumaCurve(src: ImageStats, ref: ImageStats, p: MatchParams): Float64Array {
  const minS = Math.max(16, 0.02 * src.samples);
  const minR = Math.max(16, 0.02 * ref.samples);
  const pairs: Array<[ZoneStats, ZoneStats]> = [
    [src.zones.shadow, ref.zones.shadow],
    [src.zones.mid, ref.zones.mid],
    [src.zones.high, ref.zones.high],
  ];
  const cands = pairs.map(([s, r]) =>
    s.weight >= minS && r.weight >= minR
      ? alignOf(s, r) // 分区样本充足：按分区对齐
      : alignOf(src.global, ref.global), // 空分区退回全局对齐
  );

  const curve = new Float64Array(LUT_ANCHORS + 1);
  for (let i = 0; i <= LUT_ANCHORS; i++) {
    const l = (100 * i) / LUT_ANCHORS;
    // 1) 分区软边界混合的统计对齐（×strength）
    zoneWeights(l / 100, ZW, 0);
    let y = 0;
    for (let zi = 0; zi < 3; zi++) {
      const c = cands[zi];
      const target = c.mr + (l - c.ms) * c.k;
      y += ZW[zi] * (l + p.match_strength * (target - l));
    }
    y = clamp(y, 0, 100);
    // 2) 中间调对比：绕 L=50 加窗斜率，端点钉死；数学上对 tone_contrast∈[0,2] 单调
    const uc = (y - 50) / 50;
    y += (p.tone_contrast - 1) * (y - 50) * (1 - uc * uc) * 0.5;
    // 3) 黑位提升：(1-y/50)^2 窗，C1 连接，黑处最大 LIFT_MAX
    if (y < 50) {
      const t = 1 - y / 50;
      y += p.shadow_lift * LIFT_MAX * t * t;
    }
    // 4) 高光肩部：4s(1-s) 窗两端归零 => 白点 1.0 严格保留
    const uo = clamp((y - ROLLOFF_START) / (100 - ROLLOFF_START), 0, 1);
    const so = uo * uo * (3 - 2 * uo);
    y -= p.highlight_rolloff * ROLLOFF_MAX * 4 * so * (1 - so);
    curve[i] = y;
  }
  // 数值单调化 + 值域钳制：任何参数组合下保证无逆序（无 banding 的前提）。
  // 最小斜率防平台抖动；顶部斜率封顶防碾过白点尖端色域塌陷区。
  const minRise = (MONO_MIN_SLOPE * 100) / LUT_ANCHORS;
  const capRise = (TOP_SLOPE_MAX * 100) / LUT_ANCHORS;
  curve[0] = clamp(curve[0], 0, 100);
  for (let i = 1; i <= LUT_ANCHORS; i++) {
    let y = Math.max(curve[i], curve[i - 1] + minRise);
    if (curve[i - 1] >= TOP_ZONE_Y) y = Math.min(y, curve[i - 1] + capRise);
    curve[i] = clamp(y, 0, 100);
  }
  return curve;
}

/**
 * 匹配变换预计算表（R17 提取：buildTransform 的闭包常数与 GPU 烘焙镜像共用同一份 → 单一真源）。
 * 纯代码搬移，公式与原 buildTransform 逐行一致（行为不变，由既有单测钉死）。
 */
interface MatchPrecompute {
  curve: Float64Array;
  rawDA: number; rawDB: number; dA: number; dB: number;
  stA: number; stB: number; htA: number; htB: number;
  iso: number; hueOff: number; satK: number; gs: number; ms: number;
  skinTweak: boolean; splitOn: boolean;
  env: Float32Array;
}

function precomputeMatch(ref: ImageStats, p: MatchParams): MatchPrecompute {
  const src: ImageStats =
    ref.source && ref.source.samples > 0 ? ref.source : neutralSourceStats();

  const curve = buildLumaCurve(src, ref, p);

  // 全局色偏对齐量（raw 用于肤色检测去偏，d 为实际施加量）
  const rawDA = clamp(ref.global.mean[1] - src.global.mean[1], -CAST_AB_LIMIT, CAST_AB_LIMIT);
  const rawDB = clamp(ref.global.mean[2] - src.global.mean[2], -CAST_AB_LIMIT, CAST_AB_LIMIT);
  const dA = rawDA * p.match_strength;
  const dB = rawDB * p.match_strength;

  // 分离色调：参考图阴影/高光相对全图的平均色度（空分区退零）
  const minR = Math.max(16, 0.02 * ref.samples);
  const tintOf = (z: ZoneStats): [number, number] => {
    if (z.weight < minR) return [0, 0];
    return [
      (z.mean[1] - ref.global.mean[1]) * SPLIT_DAMP * p.split_tone,
      (z.mean[2] - ref.global.mean[2]) * SPLIT_DAMP * p.split_tone,
    ];
  };
  const stA = tintOf(ref.zones.shadow)[0];
  const stB = tintOf(ref.zones.shadow)[1];
  const htA = tintOf(ref.zones.high)[0];
  const htB = tintOf(ref.zones.high)[1];

  const iso = p.skin_isolation;
  const hueOff = p.skin_hue * SKIN_HUE_MAX;
  const satK = p.skin_sat;
  const gs = p.global_sat;
  const skinTweak = hueOff !== 0 || satK !== 1;
  const splitOn = stA !== 0 || stB !== 0 || htA !== 0 || htB !== 0;
  const env = getEnvelope();
  const ms = p.match_strength;
  return { curve, rawDA, rawDB, dA, dB, stA, stB, htA, htB, iso, hueOff, satK, gs, ms, skinTweak, splitOn, env };
}

/**
 * 构建匹配变换。
 * @param ref 参考图（观感目标）统计；可经 withSource 挂载被调色图统计
 * @param params 9 参数
 */
export function buildTransform(
  ref: ImageStats,
  params: MatchParams,
): (rgb: RGB) => RGB {
  const P = precomputeMatch(ref, normalizeParams(params));
  const { curve, rawDA, rawDB, dA, dB, stA, stB, htA, htB, iso, hueOff, satK, gs, ms, skinTweak, splitOn, env } = P;

  return (rgb: RGB): RGB => {
    const r = clamp01(rgb[0]);
    const g = clamp01(rgb[1]);
    const b = clamp01(rgb[2]);
    rgbToLabInto(r, g, b, SCRATCH, 0);
    const L0 = SCRATCH[0];
    const a0 = SCRATCH[1];
    const b0 = SCRATCH[2];

    // 明度：查单调表（线性插值）
    const x = clamp(L0, 0, 100) * (LUT_ANCHORS / 100);
    const i0 = x >= LUT_ANCHORS ? LUT_ANCHORS - 1 : x | 0;
    const ft = x - i0;
    const L1 = curve[i0] + (curve[i0 + 1] - curve[i0]) * ft;

    // 肤色掩码：在扣除整体色偏后的颜色上判定（强偏置输入下依旧稳定），
    // 高斯肤色域 × 中亮区窗
    const da = (a0 + rawDA - SKIN_A) / SKIN_SA;
    const db = (b0 + rawDB - SKIN_B) / SKIN_SB;
    const m =
      Math.exp(-0.5 * (da * da + db * db)) *
      smoothstep(SKIN_L_LO1, SKIN_L_LO2, L0) *
      (1 - smoothstep(SKIN_L_HI1, SKIN_L_HI2, L0));

    // 全局色偏对齐，isolation 在掩码内按比例抑制
    let a1 = a0 + dA * (1 - iso * m);
    let b1 = b0 + dB * (1 - iso * m);

    // 肤色微调：色相旋转 + 色度缩放，均按掩码加权（掩码外无操作）
    if (skinTweak && m > 1e-4) {
      const c = Math.sqrt(a1 * a1 + b1 * b1);
      if (c > 1e-6) {
        const h = Math.atan2(b1, a1) + hueOff * m;
        const c2 = c * (1 + (satK - 1) * m);
        a1 = c2 * Math.cos(h);
        b1 = c2 * Math.sin(h);
      }
    }

    // 分离色调：按输出明度两端叠加，掩码内随 isolation 抑制（保肤色原色）
    if (splitOn) {
      const l01 = L1 / 100;
      const wH = smoothstep(SPLIT_LOW, SPLIT_HIGH, l01);
      const prot = 1 - iso * m;
      a1 += prot * ((1 - wH) * stA + wH * htA);
      b1 += prot * ((1 - wH) * stB + wH * htB);
    }

    // 全局饱和（最后施加）
    a1 *= gs;
    b1 *= gs;

    // 色域软包络：色度超出光滑包络时沿原色相方向 C1 软膝压缩（保 L*）。
    // ratio 为相对包络的输出比例；乘性系数 ratio/x 在未压缩时恒为 1。
    // 压缩量随 match_strength 增长（strength=0 时严格恒等），
    // 且掩码内随 isolation 抑制（肤色保护同样覆盖包络压缩）。
    const C = Math.sqrt(a1 * a1 + b1 * b1);
    if (C > 1e-9) {
      const x = C / Math.max(1e-6, envLookup(env, L1, Math.atan2(b1, a1)));
      if (x > KNEE_LO) {
        const g = 1 - KNEE_K * Math.exp(-(x - 1 + KNEE_K) / KNEE_K);
        const w = ms * smoothstep(KNEE_LO, KNEE_HI, x) * (1 - iso * m);
        const mult = (x + w * (g - x)) / x;
        a1 *= mult;
        b1 *= mult;
      }
    }

    labToRgbInto(L1, a1, b1, SCRATCH, 0);
    return [SCRATCH[0], SCRATCH[1], SCRATCH[2]];
  };
}

/* ---------------- R17：GPU tile-atlas 烘焙镜像所需的匹配常数 ----------------
 * 与 buildTransform 内部闭包**同一预计算**（precomputeMatch，单一真源）：
 * 曲线/包络/色偏对齐量等一次性常数在这里以 Float32 交给 GLSL（src/film/gpubake.ts），
 * GLSL 逐式镜像逐像素公式；一致性由 gpubake.test.ts（JS 镜像对拍）与 E2E（SwiftShader
 * 真实 GPU 烘焙 vs CPU 烘焙逐点对比，<1e-3）双重覆盖。 */

/** GPU 烘焙镜像的匹配常数表（数值与 buildTransform 闭包完全一致） */
export interface MatchBakeData {
  /** false = 无统计恒等（GLSL 退回 clamp01） */
  hasMatch: boolean;
  /** 明度单调曲线 129 锚点（L* 0..100）——Float32 交给 GPU */
  curve: Float32Array;
  /** 平滑色域包络色度（行主序 il*envW+ih；L 步长 envLStep、色相步长 envHStep、色相循环） */
  env: Float32Array;
  envW: number; envH: number; envLStep: number; envHStep: number;
  /** 色偏对齐（raw 供肤色检测去偏） */
  rawDA: number; rawDB: number; dA: number; dB: number;
  /** 分离色调（参考图派生） */
  stA: number; stB: number; htA: number; htB: number;
  /** 其余闭包常数 */
  iso: number; hueOff: number; satK: number; gs: number; ms: number;
  skinTweak: boolean; splitOn: boolean;
}

/** 提取匹配变换的一次性常数（供 GPU 烘焙；与 buildTransform 同源同值） */
export function matchBakeData(ref: ImageStats, params: MatchParams): MatchBakeData {
  const P = precomputeMatch(ref, normalizeParams(params));
  return {
    hasMatch: true,
    curve: Float32Array.from(P.curve),
    env: P.env,
    envW: ENV_NH, envH: ENV_NL, envLStep: ENV_L_STEP, envHStep: ENV_H_STEP,
    rawDA: P.rawDA, rawDB: P.rawDB, dA: P.dA, dB: P.dB,
    stA: P.stA, stB: P.stB, htA: P.htA, htB: P.htB,
    iso: P.iso, hueOff: P.hueOff, satK: P.satK, gs: P.gs, ms: P.ms,
    skinTweak: P.skinTweak, splitOn: P.splitOn,
  };
}
