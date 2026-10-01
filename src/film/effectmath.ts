/* FilmMatch 质感层 · 纯数学（Schema v1.1 新增参数的单一真源）
 *
 * 为什么单独成模块：GLSL 与 CPU 两个后端必须逐式一致，而 node 测试环境无 canvas/WebGL。
 * 把「带权分配 / 分带 / 补偿」这类可判定的数学抽成纯函数：
 *   - CPU 后端直接调用（pipeline.runFinalCPU / runChainsCPU）；
 *   - GLSL 侧逐式镜像（pipeline 中同名常量 + 同式注释）；
 *   - vitest 直接断言（effectmath.test.ts），不依赖渲染后端。
 *
 * 【中性恒等约定】所有新参数在其默认值上必须是恒等变换，保证既有 5 张预设卡与
 * EFFECT-REPORT / E2E 基线观感逐像素不变（回归安全）。见各函数注释里的 default 标注。
 */

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
export const LUMA_R = 0.2126, LUMA_G = 0.7152, LUMA_B = 0.0722;
export const luma = (c: readonly number[]): number => LUMA_R * c[0] + LUMA_G * c[1] + LUMA_B * c[2];

/* 与 pipeline 共用的几何常量（改这里即改两后端；GLSL 侧同值） */
export const TIGHT_RADIUS_H = 0.3;   // 紧晕半径 %H
export const TIGHT_WEIGHT = 0.85;    // 紧晕合成权重（旧双半径基线）
export const WIDE_WEIGHT = 0.75;     // 宽晕合成权重（旧双半径基线）
export const GRAIN_BASE = 0.14;      // ISO400 基准颗粒幅度
export const GRAIN_BAND_LO = 0.43;   // 分带下沿（暗部/中间调）
export const GRAIN_BAND_HI = 0.85;   // 分带上沿（中间调/高光）
export const HAL_BG_LO = 0.30;       // background_gain 生效的背景亮度下沿
export const HAL_BG_HI = 0.85;       // background_gain 生效的背景亮度上沿
export const BLOOM_SAVE_LO = 0.75;   // save_lights 生效的高光下沿

/* ================= grain：三段分布 + 类型 + 乳剂分辨率 ================= */

export interface GrainBands { shadow: number; midtone: number; highlight: number }

/** 亮度三段分区函数（三者之和恒为 1，故默认权重下幅度与旧单段行为连续） */
export function grainBands(l: number): GrainBands {
  const bSh = 1 - smoothstep(0, GRAIN_BAND_LO, l);
  const bHi = smoothstep(GRAIN_BAND_LO, GRAIN_BAND_HI, l);
  return { shadow: bSh, midtone: 1 - bSh - bHi, highlight: bHi };
}

export interface GrainBandParams {
  shadow: number; midtone: number; highlight: number;
  shadow_weight: number;               // 旧字段（v1 兼容）：作用在 shadow 段
  type: 'negative' | 'positive';
}

/**
 * 负片/正片颗粒类型增益：负片（默认）= 恒等 1.0（保持既有观感）；
 * 正片更柔、高光颗粒弱、暗部相对更明显（对标业界两种颗粒算法）。
 */
export function grainTypeGains(type: 'negative' | 'positive'): { shadow: number; highlight: number } {
  return type === 'positive' ? { shadow: 1.35, highlight: 0.3 } : { shadow: 1.0, highlight: 1.0 };
}

/** 某亮度处的有效段权重（未乘基础幅度）：三段的加权和 */
export function grainBandWeights(l: number, g: GrainBandParams): GrainBands {
  const b = grainBands(l);
  const t = grainTypeGains(g.type);
  const sh = g.shadow * (1 + g.shadow_weight * 1.2) * t.shadow;
  return { shadow: b.shadow * sh, midtone: b.midtone * g.midtone, highlight: b.highlight * g.highlight * t.highlight };
}

/** 颗粒幅度包络（= 三段权重和）。设某段为 0 则该段包络为 0 → 该段方差 ≈0 */
export function grainWeightAt(l: number, g: GrainBandParams): number {
  const w = grainBandWeights(l, g);
  return w.shadow + w.midtone + w.highlight;
}

/** 乳剂分辨率 → 颗粒基准间距倍率：film_resolution 0.5 为恒等（旧观感） */
export function grainSizeEff(size: number, film_resolution: number): number {
  return size * (1.25 - 0.5 * clamp01(film_resolution));
}

/** 乳剂分辨率 → 幅度微调：高分辨率乳剂颗粒更细、可见度略低（0.5 恒等） */
export function grainResolutionAmp(film_resolution: number): number {
  return 1 - 0.5 * (clamp01(film_resolution) - 0.5);
}

/** 金字塔尺度权重（由有效颗粒尺寸推导，高分辨率偏向细尺度；film_resolution=0.5 恒等） */
export function grainScaleWeights(sizeEff: number, film_resolution: number): { coarse: number; mid: number; fine: number } {
  const fs = clamp01((sizeEff - 0.8) / 3.2);
  const dr = clamp01(film_resolution) - 0.5;
  const coarse = 0.26 + 0.28 * fs - 0.10 * dr;
  const fine = 0.32 - 0.28 * fs + 0.10 * dr;
  return { coarse, mid: 0.42, fine };
}

/* ================= halation：背景增益 / amplify·impact 二分 / 色相 / 冷背景补偿 ================= */

/**
 * 背景增益：光晕在亮背景上的可见度。background_gain=1 → 恒等（旧观感）；
 * =0 → 亮背景（luma≥0.85）上光晕被完全压制（治「脏背景」）。
 */
export function halationBackgroundAtten(bgLuma: number, background_gain: number): number {
  return 1 - (1 - clamp01(background_gain)) * smoothstep(HAL_BG_LO, HAL_BG_HI, bgLuma);
}

export interface HalationWeights { tight: number; wide: number }

/**
 * 双半径权重分配。
 * - amplify（0-2，默认 1）：乳剂散射敏感度 → 宽晕占比上升（晕更铺开），
 *   但 **权重和恒定**，即叠加不透明度不受 amplify 影响（与 impact 分离）；
 * - impact（0-1，默认 1）：整体叠加不透明度，=0 时效果不可见；
 * - smoothness（0-1，默认 0.5）：大小光源分配，高=大区域柔光、低=细节光晕。
 * 默认 (amplify=1, smoothness=0.5) 时退化回旧 TIGHT_WEIGHT/WIDE_WEIGHT 配比（恒等）。
 */
export function halationWeights(
  amount: number, master: number, impact: number, amplify: number, smoothness: number,
): HalationWeights {
  const a = clamp01(amplify / 2);
  const s = clamp01(smoothness);
  const base = (TIGHT_WEIGHT + WIDE_WEIGHT) * amount * master * clamp01(impact);
  const wideFrac = WIDE_WEIGHT / (TIGHT_WEIGHT + WIDE_WEIGHT) + 0.20 * (a - 0.5) + 0.10 * (s - 0.5);
  const wf = Math.min(0.85, Math.max(0.10, wideFrac));
  return { tight: base * (1 - wf), wide: base * wf };
}

/** 宽晕半径倍率：amplify 抬高散射尺度、smoothness 做大区域柔光；默认 (1, 0.5) 恒等 */
export function halationRadiusEff(radius: number, amplify: number, smoothness: number): number {
  const a = clamp01(amplify / 2);
  const s = clamp01(smoothness);
  return radius * (0.85 + 0.3 * a) * (1 + 0.25 * (s - 0.5));
}

/** amplify 的「向黄相偏移」增益（作用于 tint.g）：默认 amplify=1 → 1.0 恒等 */
export function halationAmplifyTintGain(amplify: number): number {
  return 0.85 + 0.3 * clamp01(amplify / 2);
}

/** 绿层灵敏度（红↔黄）：hue=0.5 恒等；→0 更红、→1 更黄（压低蓝通道） */
export function halationHueTint(tint: readonly number[], hue: number): [number, number, number] {
  const h = clamp01(hue);
  const gGain = 0.6 + 0.8 * h;                       // 0.6 .. 1.4（0.5 → 1.0）
  const bGain = 1 - 0.8 * Math.abs(h - 0.5);         // 0.6 .. 1.0（0.5 → 1.0）
  return [clamp01(tint[0]), clamp01(tint[1] * gGain), clamp01(tint[2] * bGain)];
}

/** 冷背景补偿：蓝背景（bg.b−bg.r 大）上补回光晕能量；blue_comp=0 恒等 */
export function halationBlueCompGain(bgR: number, bgB: number, blue_comp: number): number {
  const cold = clamp01((bgB - bgR) / 0.35);
  return 1 + clamp01(blue_comp) * 0.8 * cold;
}

/* ================= bloom：Save Lights / Details / Saturation ================= */

/** 高光防溢出保护：亮部（luma≥0.75）按 save_lights 衰减效果贡献；默认 0 → 恒等 */
export function bloomSaveLightsFactor(bloomLuma: number, save_lights: number): number {
  return 1 - clamp01(save_lights) * smoothstep(BLOOM_SAVE_LO, 1.0, bloomLuma);
}

/** 大小光源分配：details=0.5 恒等；高=细节（半径收窄），低=大范围柔光 */
export function bloomRadiusEff(radius: number, details: number): number {
  return radius * (1.4 - 0.8 * clamp01(details));
}

/** 效果降饱和：saturation=1 恒等；=0 时效果层变灰（只留亮度贡献） */
export function bloomSaturationMix(blm: readonly number[], saturation: number): [number, number, number] {
  const s = clamp01(saturation);
  const l = luma(blm);
  return [l + (blm[0] - l) * s, l + (blm[1] - l) * s, l + (blm[2] - l) * s];
}

/* ================= R9 扫描颗粒团簇（DCTL 侧逐式镜像） =================
 * 真实扫描的颗粒不是纯随机的，而是呈低频「团簇」：颗粒在团簇处更重。
 * SRC 低噪用与主颗粒同一套 value-noise（坐标 = 基准颗粒坐标 × GRAIN_CLUSTER_FREQ）。
 * 注意：团簇用的坐标是「基准颗粒坐标（p_X/p_Y / grainPx）」，**不受片门抖动影响**——
 * DCTL 侧同样如此，两后端务必一致。 */
export const GRAIN_CLUSTER_DEPTH = 0.6;   // 团簇增益深度（gain ∈ 1±DEPTH）
export const GRAIN_CLUSTER_FREQ = 0.18;   // 低频噪声相对基准颗粒坐标的频率倍率
export const GRAIN_CLUSTER_SEED = 91.7;   // 低频噪声种子
/** low = 低频噪声（0..1）；cluster=0 → 恒等 1 */
export function grainClusterGain(low: number, cluster: number): number {
  return 1 + cluster * (low - 0.5) * 2 * GRAIN_CLUSTER_DEPTH;
}

/* ================= R9 片门抖动 gate weave（DCTL 侧逐式镜像） =================
 * 模拟胶片在片门里逐帧的轻微位移：水平 sin(w)、垂直为异频异相的 sin（更接近真实抖动谱）。
 * amount 单位为「画面高度比例」；amount=0 → 恒等 {0,0}（默认关闭）。 */
export const GATE_WEAVE_VERT_RATIO = 0.6;  // 垂直位移 / 水平位移 幅度比
export const GATE_WEAVE_FREQ_RATIO = 1.37; // 垂直相位角频率 / 水平角频率
export const GATE_WEAVE_PHASE = 1.7;       // 垂直相位偏移（弧度）
/** tSec = 秒；H = 画面高度像素；amount = 画面高度比例（0 → 恒等 0,0） */
export function gateWeaveOffsetPx(amount: number, speed: number, tSec: number, H: number): { dx: number; dy: number } {
  const w = 2 * Math.PI * speed * tSec;
  return {
    dx: amount * H * Math.sin(w),
    dy: amount * H * GATE_WEAVE_VERT_RATIO * Math.sin(w * GATE_WEAVE_FREQ_RATIO + GATE_WEAVE_PHASE),
  };
}

/* ================= R18 按管线锚点标定（C3；TF 编码在对数域侧，见 dctl/logmath） =================
 * 锚点语义（冻结）：anchors 描述「卡的关键点位在该管线归一化工作域中的落点」——
 *   black：输入黑经 look 后的落点（该管线归一化域，0..1）；
 *   white：输入白经 look 后的落点（0..1）；
 *   pivot：该管线的中灰枢轴（yrgb 0.5 / rcm 0.333，与 logmath 管线 pivot 同源）。
 * look 的黑/白落点公式（显示域与对数域同式）：blk = black_lift + fade×0.10，wht = 1 − fade×0.08。
 * 重标定 = 由锚点反解 (fade, black_lift, pivot)：白位收拢是 fade 的第一语义 →
 *   fade = (1 − white)/0.08；black_lift = black − fade×0.10（负值取 0，残差如实保留在锚点外）。
 * 切管线（yrgb ↔ rcm）时取目标管线的 anchors 重标定 → 同一张卡在两条管线的关键点位落点一致
 * （「切管线语义不漂移」）。无锚点的卡/配方不触发重标定，行为逐位不变。 */

/** 单条管线的锚点三元组（归一化域 0..1） */
export interface PipelineAnchors { black: number; white: number; pivot: number }
/** 卡/配方的按管线锚点表（两管线均可选） */
export interface CardAnchors { yrgb?: PipelineAnchors; rcm?: PipelineAnchors }

/** 显示域 look 参数 → 显示域关键点位（blk/wht；与 engine/look、GRADE_FS 同式） */
export function lookTonalLandings(fade: number, blackLift: number): { black: number; white: number } {
  return { black: clamp01(blackLift + 0.1 * fade), white: clamp01(1 - 0.08 * fade) };
}

/** 锚点 → 重标定后的 look 参数（fade / black_lift / pivot；全部钳制到合法区间） */
export function anchorsToLookCal(a: PipelineAnchors): { fade: number; black_lift: number; pivot: number } {
  const black = clamp01(a.black), white = clamp01(a.white);
  const fade = clamp01((1 - white) / 0.08);
  const blackLift = clamp01(black - 0.1 * fade);
  return { fade, black_lift: blackLift, pivot: clamp01(a.pivot) };
}

/** look 参数 → 锚点（anchorsToLookCal 的逆；负值钳制过的 black_lift 不可逆，残差如实反映） */
export function lookCalToAnchors(fade: number, blackLift: number, pivot: number): PipelineAnchors {
  return { black: clamp01(blackLift + 0.1 * clamp01(fade)), white: clamp01(1 - 0.08 * clamp01(fade)), pivot: clamp01(pivot) };
}
