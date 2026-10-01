/* FilmMatch 菲林工坊 · DCTL 生成器（R4）
 *
 * 把配方（色彩 look + 质感层）翻译成可在达芬奇中直接加载的 `.dctl` 源码：
 *   - 参数以 DEFINE_UI_PARAMS 滑杆/开关出现在达芬奇的 OFX 面板；
 *   - 数学 = 归一化对数域 look（见 logmath.ts）+ effectmath 语义的质感层；
 *   - 质感层需要邻域采样，故入口固定为 `__DEVICE__ float3 transform(..., __TEXTURE__ ...)`。
 *
 * 关键约定：
 *   - 空间量（半径 %H、颗粒 ‰H、色散比例）的滑杆默认值按基准分辨率（默认 1080p）换算为像素，
 *     写进参数默认值 + 源码注释；R21 起这些滑杆语义为「1080p 基准 px」，transform 里按
 *     `p_Height / 1080` 运行时缩放——2160p 时间线自动 ×2，无需手动调整参数（warnings 里注明）。
 *   - 商标红线：生成源码只出现「达芬奇 / FilmMatch / 菲林工坊」，不含任何第三方品牌。
 *   - R6 起参数标签支持中英混排 + 分组前缀 + DEFINE_UI_TOOLTIP（文案表见 labels.ts，
 *     渲染见 defineLine）；这两项尚未实机验证，spike 文件见 samples.ts 的 LABEL_SPIKE_SAMPLES。
 *   - R7 起可选内联 CDL 匹配段（input.match）：信号链
 *     `采样 → 匹配（显示域 CDL）→ tf_encode → 对数域 look → 质感层 → tf_decode`，
 *     一个节点完成「匹配 + look + 质感」；**不传 match 时产物与 R6 逐字节一致**。
 *   - R21 起（用户实机回执修复轮）：
 *     ① FM_MASTER 质感总强度参数（与网页端 params.master 同源，默认 = 配方 master），
 *        与引擎同式乘进光晕/柔光/颗粒/暗角四层；只在含质感层的导出形态出现（参数预算 53/64）。
 *     ② 柔光/光晕 tap 升级为双环结构（柔光 中心+4@r+4@2r；光晕宽环 3×3@r + 外环 8@2r），
 *        环权重取高斯核值（σ = 环半径/2 的既有约定，见 GAUSS_EDGE 注释）。
 *     ③ 亮通阈值逐 tap 作用于「look 后的邻域值」（每 tap 走 匹配→tf_encode→fm_log_look→tf_decode，
 *        与中心像素同式）——修掉与网页端「阈值作用于已 look 图」的作用域差（实机实测源图亮通
 *        能量只有 look 后的 ≈1/4.7）。
 *   - 纯函数、无 DOM 依赖，可在 node 中生成与静态校验。
 *
 * 已知偏差（与网页 GLSL 预览的差异，均写进 warnings）：
 *   1) 邻域采样结构：网页端是亮通掩码 → ¼/⅛ 分辨率可分离高斯模糊（连续核）；DCTL 是稀疏 tap
 *      求积（R21 双环后光晕 34 tap / 柔光 9 tap）。平滑场上两者接近，亮区边缘的过渡带有结构差
 *      （见 docs/research/观感对齐清单-R9.md 的实测数字）。
 *   2) 邻域采样色度：光晕累积仍为亮度标量（每 tap 取 RGB 算 max3 亮通权重，但累积色由
 *      tint_rgb 上色——产品语义，R9 对齐清单「已接受」项）；柔光累积 look 后的源色（R21 起
 *      与网页端同为彩色累积，且阈值按亮度 max→luma 对齐网页 useMax=0）。
 *      每像素采样 3(src) + 27(紧晕 9tap×3) + 51(宽晕 17tap×3) + 27(柔光 9tap×3) = 108 次
 *      （R12–R20 为 36 次；逐 tap look 与双环是用户实机 veil 修复的代价，真实 GPU 余量充足）。
 *   3) 动态颗粒/片门抖动依赖达芬奇 19.1+ 的 TIMELINE_FRAME_INDEX（ResolveFX DCTL 插件）；
 *      作为 LUT 加载时该键恒为 1，颗粒/抖动仍静态。dynamicGrain:false 可回退 R8 静态形态。
 *   4) R7 匹配段内联的是 CDL（10 个浮点）——CDL 只是完整匹配变换的近似，与 engine 匹配
 *      存在数值差，量级由生成页的误差报告（inlinecdl.matchApproxReport）给出。
 */
import {
  BLOOM_SAVE_LO, GRAIN_BAND_HI, GRAIN_BAND_LO, GRAIN_BASE, HAL_BG_HI, HAL_BG_LO,
  TIGHT_RADIUS_H, TIGHT_WEIGHT, WIDE_WEIGHT,
  bloomRadiusEff, grainResolutionAmp, grainScaleWeights, grainSizeEff, grainTypeGains,
  halationRadiusEff,
} from '../film/effectmath';
import type { TextureParams } from '../film/params';
import { DEFAULT_COUPLING, couplingIsDefault, hslIsIdentity, normalizeCoupling } from '../engine/look';
import { CDL_RANGES, clampCdl, type Cdl } from '../batch/cdl';
import {
  applyGroupPrefix, asciiTip, composeLabel, paramText, type ParamGroup,
} from './labels';
import { PIPELINES, YRGB_EPS, YRGB_LOG_HI, YRGB_LOG_LO, type LogLookParams, type PipelineTF } from './logmath';

export type { ParamGroup } from './labels';

/** 标签语言模式：bilingual = 中英混排（标准）；ascii = 纯 ASCII（兼容模式，避开未验证字符） */
export type LabelMode = 'bilingual' | 'ascii';

export interface DctlParamDecl {
  macro: string;                 // 如 'FM_CONTRAST'（ASCII 宏名）
  /** 达芬奇面板显示名。标准模式下 = 分组前缀 + 中文短名 + 空格 + 英文名，
   *  如 `光晕-强度 Halation Amount`；look 组无前缀（如 `对比度 Contrast`）。 */
  label: string;
  /** 英文名（ASCII），如 'Contrast'；拼进标准模式标签 */
  en: string;
  /** 一句话说明（中文；标准模式的 DEFINE_UI_TOOLTIP） */
  tip: string;
  /** 一句话说明（ASCII；兼容模式的 DEFINE_UI_TOOLTIP，避免未验证字符）。
   *  可选：手写声明可以不填，此时退化为英文名。 */
  tipEn?: string;
  /** 参数分组（面板里靠中文前缀聚拢；look = 色彩层，match = R7 内联匹配段） */
  group: ParamGroup;
  type: 'float' | 'int' | 'bool';
  def: number | boolean;
  min?: number;
  max?: number;
  /** 浮点参数的写出小数位（默认 4）。R7 的 CDL 匹配系数用 6 位——
   *  验收②要求面板默认值与 R3 导出系数逐位一致（回读误差 < 1e-6）。 */
  decimals?: number;
  /** 浮点滑杆的步长（默认按量程取 0.01 / 0.1）。匹配系数用 0.001，便于在达芬奇面板里微调。 */
  step?: number;
}

/** R7 单节点导出：内联进 DCTL 的 CDL 匹配段（R3 解算结果） */
export interface DctlMatchInput {
  /** ASC CDL 系数（R3 解算结果）；10 个浮点全部内联为 UI 参数默认值 */
  cdl: Cdl;
  /** 默认是否开启匹配段（默认 true；面板上的 FM_MATCH_ON 可在达芬奇里关掉） */
  enabled?: boolean;
}

export interface DctlGenInput {
  recipeName: string;
  shareCode: string;
  pipeline: PipelineTF;
  look: LogLookParams;
  texture: TextureParams;
  /** R21：质感总强度（与网页端 params.master 同源；默认 1）。
   *  烘焙为 FM_MASTER 滑杆默认值（0..2），四层质感与引擎同式乘它；
   *  只在含质感层（光晕/柔光/颗粒/暗角任一开启）的导出形态出现。 */
  master?: number;
  /** 空间量换算基准分辨率（默认 1920×1080；滑杆语义为「该基准下的 px」，运行时按 p_Height 缩放） */
  resolution?: { w: number; h: number };
  /** 兼容模式：ASCII 标签 + 开关用 0/1 浮点滑杆（避开未验证的中文标签与 DCTLUI_CHECK_BOX）。
   *  语义与 R4 一致；等价于 labelMode: 'ascii'，但**显式传的 labelMode 优先**。 */
  compat?: boolean;
  /** 标签语言模式（默认 'bilingual'）。'ascii' 时标签与 tooltip 全走 ASCII */
  labelMode?: LabelMode;
  /** 标签是否带分组前缀（默认 true）：`光晕-强度 Halation Amount` vs `强度 Halation Amount` */
  groupPrefix?: boolean;
  /** 是否生成 DEFINE_UI_TOOLTIP（默认：仅 bilingual 模式为 true）。
   *  为什么 ascii/compat 默认关：tooltip 语法本身尚未实机验证，而 compat 产物（3 个样例）
   *  正是用户已实测可用的那一批——不能把未验证的语法塞进「已验证安全」的路径里。
   *  等 spike C 回执确认 tooltip 可用后，再把 ascii 模式的默认也打开。 */
  tooltips?: boolean;
  /** tooltip 第一个参数写标签还是宏名（默认 'label'，与官方文档示例一致；见 TooltipTarget 注释） */
  tooltipTarget?: TooltipTarget;
  /** 只导出指定质感层（缺省全开）。用途：①「只导出色彩层」的产品选项 ② 排查达芬奇闪退的二分定位。
   *  R7 追加 'match'：关掉时匹配段的参数与代码一起裁剪（面板与代码同进同退的不变量不变）。
   *  R9 追加 'gate_weave'：关掉时片门抖动的参数与代码一起裁剪。 */
  stages?: Partial<Record<'match' | 'halation' | 'bloom' | 'grain' | 'vignette' | 'gate_weave', boolean>>;
  /** 无分支模式：层开关不再写成 `if (SW) { 抽头 }`，改成先算完再乘 0/1 开关。
   *  动机：用户实测可用的 24_tex_9tap 抽头是裸块，而真实配方样例的抽头都包在 if 里；
   *  DCTL JIT 对「邻域采样落在条件块内」是否支持尚未确认，合成探针 40/41 正在区分这两者。 */
  branchless?: boolean;
  /** R7 单节点导出：内联 CDL 匹配段（缺省不内联，产物与 R6 完全一致） */
  match?: DctlMatchInput;
  /** R9 动态颗粒（默认 true）：颗粒相位由 `TIMELINE_FRAME_INDEX` 逐帧步进（达芬奇 19.1+ 的
   *  ResolveFX DCTL 插件；作为 LUT 加载时该键恒为 1，颗粒仍是静态）。false = 回退 R8 的静态相位，
   *  产物里不出现 `TIMELINE_FRAME_INDEX`（片门抖动也随之退化为 0）。 */
  dynamicGrain?: boolean;
}

export interface DctlGenResult {
  source: string;
  params: DctlParamDecl[];
  warnings: string[];
}

/* ================= 小工具 ================= */

const fnum = (x: number, d = 4): string => `${Number.isFinite(x) ? x.toFixed(d) : (0).toFixed(d)}f`;
const clampRange = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** 兼容模式下的 ASCII 标签：由宏名推导（FM_HALATION_AMOUNT → "Halation Amount"）。
 *  为什么需要：中文标签从未在达芬奇里实测通过（2026-09-22 的闪退根因最终定位为「UI 参数写进
 *  helper」，与标签无关，但中文标签本身仍未验证）；兼容模式一律走纯 ASCII 标签 + 0/1 浮点滑杆，
 *  作为「一定能加载」的退路。 */
export function asciiLabel(macro: string): string {
  return macro.replace(/^FM_/, '').toLowerCase().split('_')
    .map((w) => (w === 'px' ? 'px' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}
/** 开关参数在代码里的取值：普通模式是 bool 宏，兼容模式是 0/1 浮点滑杆 */
export function boolCond(macro: string, compat: boolean): string {
  return compat ? `${macro} > 0.5f` : macro;
}

/** 开关的 0/1 数值表达式（无分支模式用：用乘法代替 `if`，两种开关类型都能取值） */
export function switchExpr(macro: string, compat: boolean): string {
  return compat ? `${macro} > 0.5f ? 1.0f : 0.0f` : `${macro} ? 1.0f : 0.0f`;
}

/** tooltip 第一个参数写什么：官方文档示例与运行时校验都指向「标签文本」——
 *  README 示例 `DEFINE_UI_PARAMS(tgtColor, Target Color, ...)` + `DEFINE_UI_TOOLTIP(Target Color, "...")`；
 *  研究笔记 D8（自达芬奇二进制提取）：「标签须与 UI 参数标签一致」。
 *  宏名写法一并保留为可选项，方便 spike 现场二分。 */
export type TooltipTarget = 'label' | 'macro';

/** 标签与 tooltip 的生成选项（与 DctlGenInput 上的同名字段同义） */
export interface DefineLineOpts {
  labelMode?: LabelMode;
  groupPrefix?: boolean;
  tooltips?: boolean;
  /** 开关写成 0/1 浮点滑杆而不是 DCTLUI_CHECK_BOX（兼容模式语义；默认随 labelMode: 'ascii'）。
   *  与标签是两个独立轴：compat 模式的开关写法由它承载，显式 labelMode 覆盖时开关不受影响。 */
  boolSlider?: boolean;
  /** tooltip 的第一个参数（默认 'label'，即与 DEFINE_UI_PARAMS 里写出的标签逐字一致） */
  tooltipTarget?: TooltipTarget;
}

/** 标签的最终显示名：标准模式按 groupPrefix 补/剥分组前缀；兼容模式由宏名推导 ASCII 名 */
export function displayLabel(p: DctlParamDecl, opts: DefineLineOpts = {}): string {
  if ((opts.labelMode ?? 'bilingual') === 'ascii') return asciiLabel(p.macro);
  return applyGroupPrefix(p.label, p.group, opts.groupPrefix ?? true);
}

/** 生成一条参数声明：DEFINE_UI_PARAMS（+ 可选紧随其后的 DEFINE_UI_TOOLTIP）。
 *  返回数组而不是单行——tooltip 必须**紧接**声明行，两者一起产出才不会漏配对。
 *  兼容模式（ASCII）下 tooltip 文本也走 ASCII：中文与勾选框都还没在达芬奇里验证过，
 *  兼容产物的目标是「一定能加载」，不引入任何未验证字符。 */
export function defineLine(p: DctlParamDecl, opts: DefineLineOpts = {}): string[] {
  const labelMode = opts.labelMode ?? 'bilingual';
  const compat = labelMode === 'ascii';
  const boolSlider = opts.boolSlider ?? compat;
  const label = displayLabel(p, opts);
  const line = ((): string => {
    if (p.type === 'bool') {
      return boolSlider
        ? `DEFINE_UI_PARAMS(${p.macro}, ${label}, DCTLUI_SLIDER_FLOAT, ${p.def ? 1 : 0}, 0, 1, 1)`
        : `DEFINE_UI_PARAMS(${p.macro}, ${label}, DCTLUI_CHECK_BOX, ${p.def ? 1 : 0})`;
    }
    if (p.type === 'int') {
      return `DEFINE_UI_PARAMS(${p.macro}, ${label}, DCTLUI_SLIDER_INT, ${Math.round(Number(p.def))}, ${Math.round(p.min!)}, ${Math.round(p.max!)}, 1)`;
    }
    /* 小数位与步长可逐参数覆盖（R7 的 CDL 系数要 6 位小数 + 细步长）；
     * 未覆盖时保持 R4/R6 的既有写法（4 位小数 + 量程步长），产物逐字节不变。 */
    const d = p.decimals ?? 4;
    const range = p.max! - p.min!;
    const step = p.step !== undefined ? `${p.step}f` : `${(range > 10 ? 0.1 : 0.01).toFixed(2)}f`;
    return `DEFINE_UI_PARAMS(${p.macro}, ${label}, DCTLUI_SLIDER_FLOAT, ${fnum(Number(p.def), d)}, ${fnum(p.min!, d)}, ${fnum(p.max!, d)}, ${step})`;
  })();
  const out = [line];
  if (opts.tooltips ?? true) {
    const tip = compat ? asciiTip(p) : p.tip;
    const target = (opts.tooltipTarget ?? 'label') === 'macro' ? p.macro : label;
    out.push(`DEFINE_UI_TOOLTIP(${target}, "${tip}")`);
  }
  return out;
}

/** 参数默认值收敛到合法区间，避免越界默认值；标签/说明统一取自 labels.ts 的文案表 */
function declBase(macro: string, groupPrefix = true): Pick<DctlParamDecl, 'macro' | 'label' | 'en' | 'tip' | 'tipEn' | 'group'> {
  const t = paramText(macro);
  return {
    macro,
    label: composeLabel(t, groupPrefix),
    en: t.en,
    tip: t.tip,
    tipEn: t.tipEn,
    group: t.group,
  };
}
function numDecl(macro: string, def: number, min: number, max: number): DctlParamDecl {
  return { ...declBase(macro), type: 'float', def: round6(clampRange(def, min, max)), min, max };
}
function intDecl(macro: string, def: number, min: number, max: number): DctlParamDecl {
  return { ...declBase(macro), type: 'int', def: Math.round(clampRange(def, min, max)), min, max };
}
function boolDecl(macro: string, def: boolean): DctlParamDecl {
  return { ...declBase(macro), type: 'bool', def };
}

/* ================= 参数声明清单 =================
 * 名称虽为 textureParamDecls，但签名带 look，故返回「look + 质感层」的完整面板清单；
 * generateDctl 直接复用它，保证面板声明数与配方参数一一对应（单测断言长度相等）。 */

export function textureParamDecls(
  t: TextureParams, look: LogLookParams, resolution: { w: number; h: number }, master = 1,
): DctlParamDecl[] {
  const H = Math.max(1, resolution.h);
  const h = t.halation, g = t.grain, b = t.bloom, v = t.vignette;

  // 空间量换算为像素（以基准分辨率 H 为准）
  const tightPx = Math.max(1, Math.round((TIGHT_RADIUS_H / 100) * H));
  const widePx = Math.max(1, Math.round((halationRadiusEff(h.radius, h.amplify, h.smoothness) / 100) * H));
  const bloomPx = Math.max(1, Math.round((bloomRadiusEff(b.radius, b.details) / 100) * H));
  const sizeEff = grainSizeEff(g.size, g.film_resolution);
  const grainPx = Math.max(1.25, round6((sizeEff / 1000) * H));
  const chromaPx = round6(v.chroma_shift * H);
  const grainAmp = round6(GRAIN_BASE * Math.sqrt(g.iso / 400) * grainResolutionAmp(g.film_resolution));
  const tg = grainTypeGains(g.type);
  const shadowEff = round6(g.shadow * (1 + g.shadow_weight * 1.2) * tg.shadow);
  const highlightEff = round6(g.highlight * tg.highlight);
  // R9 片门抖动：参数按冻结契约换算为像素常量（默认 round(amount*H)，amount = 0 → 位移 0）
  const weavePx = Math.round(t.gate_weave.amount * H);

  return [
    // ---- 对数域 look ----
    numDecl('FM_CONTRAST', look.contrast, 0, 2),
    numDecl('FM_TOE', look.toe, 0, 1),
    numDecl('FM_SHOULDER', look.shoulder, 0, 1),
    numDecl('FM_PIVOT', look.pivot, 0, 1),
    numDecl('FM_CROSSTALK', look.crosstalk, 0, 0.4),
    numDecl('FM_SATURATION', look.saturation, 0, 2),
    numDecl('FM_WARMTH', look.warmth, -1, 1),
    numDecl('FM_FADE', look.fade, 0, 1),
    numDecl('FM_SHADOW_BIAS', look.shadow_bias, 0, 1),
    numDecl('FM_HIGHLIGHT_BIAS', look.highlight_bias, 0, 1),
    numDecl('FM_FILM_S', look.film_s, 0, 1),
    numDecl('FM_GAMMA_CONTRAST', look.gamma_contrast, 0, 1),
    /* ---- Schema v1.2 分离色调（5 个；look 组，无分组前缀） ---- */
    numDecl('FM_SPLIT_SHADOW_HUE', look.split_shadow_hue, 0, 1),
    numDecl('FM_SPLIT_SHADOW_SAT', look.split_shadow_sat, 0, 1),
    numDecl('FM_SPLIT_HIGHLIGHT_HUE', look.split_highlight_hue, 0, 1),
    numDecl('FM_SPLIT_HIGHLIGHT_SAT', look.split_highlight_sat, 0, 1),
    numDecl('FM_SPLIT_BALANCE', look.split_balance, -1, 1),
    // ---- R21 质感总强度（与网页端 params.master 同源；生成器层裁剪会在「无质感层」时去掉它） ----
    numDecl('FM_MASTER', master, 0, 2),
    // ---- 光晕 ----
    boolDecl('FM_HALATION_ON', h.enabled),
    numDecl('FM_HALATION_AMOUNT', h.amount, 0, 1),
    intDecl('FM_HALATION_RADIUS_PX', widePx, 1, 200),
    intDecl('FM_HALATION_TIGHT_PX', tightPx, 1, 100),
    numDecl('FM_HALATION_THRESHOLD', h.threshold, 0, 1),
    numDecl('FM_HALATION_TINT_R', h.tint_rgb[0], 0, 1),
    numDecl('FM_HALATION_TINT_G', h.tint_rgb[1], 0, 1),
    numDecl('FM_HALATION_TINT_B', h.tint_rgb[2], 0, 1),
    numDecl('FM_HALATION_BG_GAIN', h.background_gain, 0, 1),
    numDecl('FM_HALATION_BLUE_COMP', h.blue_comp, 0, 1),
    numDecl('FM_HALATION_HUE', h.hue, 0, 1),
    numDecl('FM_HALATION_IMPACT', h.impact, 0, 1),
    numDecl('FM_HALATION_AMPLIFY', h.amplify, 0, 2),
    numDecl('FM_HALATION_SMOOTH', h.smoothness, 0, 1),
    // ---- 颗粒 ----
    boolDecl('FM_GRAIN_ON', g.enabled),
    numDecl('FM_GRAIN_AMP', grainAmp, 0, 1),
    numDecl('FM_GRAIN_SIZE_PX', grainPx, 0.5, 20),
    numDecl('FM_GRAIN_CORRELATION', g.correlation, 0, 1),
    numDecl('FM_GRAIN_SHADOW', shadowEff, 0, 4),
    numDecl('FM_GRAIN_MIDTONE', g.midtone, 0, 4),
    numDecl('FM_GRAIN_HIGHLIGHT', highlightEff, 0, 4),
    // R9 扫描颗粒团簇（0 = 恒等：纯随机颗粒）
    numDecl('FM_GRAIN_CLUSTER', g.cluster, 0, 1),
    // ---- 柔光 ----
    boolDecl('FM_BLOOM_ON', b.enabled),
    numDecl('FM_BLOOM_AMOUNT', b.amount, 0, 1),
    intDecl('FM_BLOOM_RADIUS_PX', bloomPx, 1, 300),
    numDecl('FM_BLOOM_THRESHOLD', b.threshold, 0, 1),
    numDecl('FM_BLOOM_SAVE_LIGHTS', b.save_lights, 0, 1),
    numDecl('FM_BLOOM_DETAILS', b.details, 0, 1),
    numDecl('FM_BLOOM_SATURATION', b.saturation, 0, 1),
    // ---- 暗角 ----
    boolDecl('FM_VIGNETTE_ON', v.enabled),
    numDecl('FM_VIGNETTE_AMOUNT', v.amount, 0, 1),
    numDecl('FM_VIGNETTE_RADIUS', v.radius, 0.5, 2),
    numDecl('FM_VIGNETTE_CHROMA_PX', chromaPx, 0, 20),
    // ---- R9 片门抖动 ----
    intDecl('FM_GATE_WEAVE_PX', weavePx, 0, 40),
    numDecl('FM_GATE_WEAVE_SPEED', t.gate_weave.speed, 0, 4),
  ];
}

/* ================= R7 匹配段参数（内联 CDL，11 个） =================
 * 1 个总开关 + 10 个 CDL 系数（slope/offset/power 各 3 通道 + sat）。
 *   - 范围直接取 CDL_RANGES：与 R3 导出/网页端求解器同一张区间表（单一事实来源）；
 *   - 默认值 = 传入的 R3 解算结果，按 6 位小数写出（验收②：回读误差 < 1e-6），
 *     并用 clampCdl 先收敛一次——越界钳制、非有限回退中性，与导出通道同一规则；
 *   - 步长 0.001：匹配系数要能在达芬奇面板里微调，而 R6 的量程步长（0.01）太粗。
 * 注意：系数是「该镜头的解算结果」，换镜头要么重新生成，要么在面板上手动改。 */
export function matchParamDecls(m: DctlMatchInput): DctlParamDecl[] {
  const cdl = clampCdl(m.cdl);
  const r = CDL_RANGES;
  const decl = (macro: string, def: number, range: [number, number]): DctlParamDecl => ({
    ...declBase(macro),
    type: 'float',
    def: round6(clampRange(def, range[0], range[1])),
    min: range[0],
    max: range[1],
    decimals: 6,
    step: 0.001,
  });
  return [
    boolDecl('FM_MATCH_ON', m.enabled ?? true),
    decl('FM_MATCH_SLOPE_R', cdl.slope[0], r.slope),
    decl('FM_MATCH_SLOPE_G', cdl.slope[1], r.slope),
    decl('FM_MATCH_SLOPE_B', cdl.slope[2], r.slope),
    decl('FM_MATCH_OFFSET_R', cdl.offset[0], r.offset),
    decl('FM_MATCH_OFFSET_G', cdl.offset[1], r.offset),
    decl('FM_MATCH_OFFSET_B', cdl.offset[2], r.offset),
    decl('FM_MATCH_POWER_R', cdl.power[0], r.power),
    decl('FM_MATCH_POWER_G', cdl.power[1], r.power),
    decl('FM_MATCH_POWER_B', cdl.power[2], r.power),
    decl('FM_MATCH_SAT', cdl.sat, r.sat),
  ];
}

/** 传入 CDL 是否被 clampCdl 改动过（越界/非有限）——用于诚实告警：
 *  面板默认值与调用方给的系数不再逐位一致时必须说清，不能静默改数。 */
function cdlNeedsClamp(cdl: Cdl): boolean {
  const c = clampCdl(cdl);
  const same = (a: number, b: number): boolean => Number.isFinite(a) && Math.abs(a - b) < 1e-12;
  return !(
    same(c.slope[0], cdl.slope[0]) && same(c.slope[1], cdl.slope[1]) && same(c.slope[2], cdl.slope[2])
    && same(c.offset[0], cdl.offset[0]) && same(c.offset[1], cdl.offset[1]) && same(c.offset[2], cdl.offset[2])
    && same(c.power[0], cdl.power[0]) && same(c.power[1], cdl.power[1]) && same(c.power[2], cdl.power[2])
    && same(c.sat, cdl.sat)
  );
}

/* ================= GLSL → DCTL 机械语法映射 ================= */

/**
 * GLSL 片段 → DCTL 的机械语法映射（两者语法高度同源，DCTL 脱胎于 Academy CTL）。
 * 映射：vec2/3/4→float2/3/4、mat3→float3x3、texture2D→_tex2D、fract→fm_fract（官方无 _fract）、
 * mix→_mix、clamp→_clamp、pow→_powf、floor→_floor、gl_FragColor→return、
 * 入口 void main()→__DEVICE__ transform(...)、varying/uniform/attribute 声明剔除、
 * #define 与其余代码原样保留。
 * 注意：这是「机械」映射——texture2D(tex, uv) 与 _tex2D(tex, x, y) 的坐标语义不同，
 * 生成后再人工/上层补齐坐标即可；本函数服务于单测与语法层。
 */
export function glslToDctl(glsl: string): string {
  let s = glsl;
  s = s.replace(/^[ \t]*#version[^\n]*\n/gm, '');                                  // 去 #version
  s = s.replace(/^[ \t]*precision\s+\w+\s+\w+\s*;[ \t]*$/gm, '');                  // 去精度限定
  s = s.replace(/^[ \t]*(varying|uniform|attribute)\s+[^;]*;[ \t]*$/gm, '');       // 去声明（保留 #define）
  s = s.replace(/^[ \t]*(in|out)\s+[^;]*;[ \t]*$/gm, '');
  s = s.replace(
    /void\s+main\s*\(\s*\)/,
    '__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB)',
  );
  s = s.replace(/gl_FragCoord\.xy/g, 'make_float2((float)p_X, (float)p_Y)');
  s = s.replace(/gl_FragCoord/g, 'make_float4((float)p_X, (float)p_Y, 0.0f, 1.0f)');
  s = s.replace(/gl_FragColor\s*=/g, 'return');                                    // 赋值 → return
  s = s.replace(/gl_FragColor/g, 'make_float4(0.0f, 0.0f, 0.0f, 1.0f)');           // 其余残留占位
  s = s.replace(/\bvec([234])\b/g, 'float$1');
  s = s.replace(/\bmat3\b/g, 'float3x3');
  s = s.replace(/\bmat4\b/g, 'float4x4');
  s = s.replace(/\btexture2D\b/g, '_tex2D');
  s = s.replace(/(?<!_)\bfract\b/g, 'fm_fract');   // 官方函数清单无 _fract，用自写 fm_fract
  s = s.replace(/(?<!_)\bmix\b/g, '_mix');
  s = s.replace(/(?<!_)\bclamp\b/g, '_clamp');
  s = s.replace(/(?<!_)\bpow\b/g, '_powf');
  s = s.replace(/(?<!_)\bfloor\b/g, '_floor');
  return s;
}

/* ================= 静态校验 ================= */

function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '');
}

/** 切出每个顶层 __DEVICE__ 函数的函数体（用于「UI 参数不许进 helper」的扫描） */
function dctlFunctionBodies(code: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /^__DEVICE__\s+[A-Za-z0-9_]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/gm;
  for (const m of code.matchAll(re)) {
    const start = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    let i = start;
    for (; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') { depth--; if (depth === 0) break; }
    }
    out.push({ name: m[1], body: code.slice(start, i + 1) });
  }
  return out;
}

/** 静态校验：括号配平、__DEVICE__ 入口存在、DEFINE_UI_PARAMS 声明数、无残留 GLSL 符号、无 #version */
export function validateDctl(src: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const code = stripCommentsAndStrings(src);
  const pairs: Array<[string, string]> = [['{', '}'], ['(', ')'], ['[', ']']];
  for (const [open, close] of pairs) {
    const no = code.split(open).length - 1;
    const nc = code.split(close).length - 1;
    if (no !== nc) errors.push(`括号不配平：'${open}' ${no} 个 / '${close}' ${nc} 个`);
  }
  /* 项目策略（非 DCTL 硬限制）：生成的代码里所有向量运算一律走 fm_scale3/fm_add3/fm_mul3。
   * 依据：spike② 实测 `float3 * 标量` 可用（09/10 效果一致），但 `float3 - float3` 这类
   * 向量-向量运算尚未验证（02/FM_diag_slider 曾以 return-value 报错失败，疑即此因）。
   * 助手写法对两种情形都安全，故保留为强制策略并在此扫描。 */
  const VEC = 'blm|hal|halT|halW|gnoise|tint|rgb|tc';
  for (const m of src.matchAll(new RegExp(`^\\s*(?:float3\\s+)?(${VEC})\\s*=\\s*[^;]*;`, 'gm'))) {
    const stmt = m[0];
    if (new RegExp(`\\b(${VEC})\\b\\s*[+*\\-/]`).test(stmt) && !/\.x|\.y|\.z|make_float3|fm_(scale|add|mul|mix)3/.test(stmt)) {
      errors.push(`裸向量运算（项目策略要求走 fm_scale3/fm_add3/fm_mul3）：${stmt.trim().slice(0, 70)}`);
    }
  }
  /* 官方函数清单里不存在的名字（spike② 实测：_fract/_fabsf 会让达芬奇编译失败/闪退） */
  for (const bad of ['_fract', '_fabsf', '_floor(', '_ceil(', '_clamp(', '_saturate(']) {
    /* 词边界匹配：避免把自写助手 fm_fract / fm_clamp01 误判 */
    const re = new RegExp(`(?<![A-Za-z0-9_])${bad.replace(/[(]/g, '\\(')}`);
    if (re.test(src)) errors.push(`使用了官方清单中不存在的函数名：${bad}（应为 _fabs/_floorf/_ceilf/_clampf/_saturatef，或自写助手）`);
  }
  /* 每个顶层函数定义都必须带执行空间注解（否则 JIT 报 host function 错误） */
  for (const m of src.matchAll(/^(?!__DEVICE__)(\w+\s+)?(float3|float2|float|int|void)\s+(\w+)\s*\([^;{]*\)\s*\{/gm)) {
    errors.push(`函数 ${m[3]} 缺少 __DEVICE__ 注解（JIT 会拒绝 host 函数）`);
  }
  /* 入口签名：接受官方两种合法形态（逐像素 p_R/p_G/p_B / 纹理 p_TexR/G/B），且必须物理单行
   * （达芬奇按行扫描入口声明，折行会被判为 wrong argument int p_Width）。R14 追加一致性规则：
   * 签名形态必须与源码里是否真的做 `_tex2D` 采样同步——两者不一致直接报错，避免「改了签名忘了
   * 改采样」或反之（这正是用户实机 `wrong argument int p_Width` 的根因）。 */
  const sigLines = code.split('\n').filter((l) => /__DEVICE__\s+float3\s+transform\s*\(/.test(l));
  const oneLineSig = sigLines.find((l) => /\)\s*$/.test(l.trim()));
  const hasTexSig = oneLineSig !== undefined && /__DEVICE__\s+float3\s+transform\s*\(\s*int p_Width\s*,\s*int p_Height\s*,\s*int p_X\s*,\s*int p_Y\s*,\s*__TEXTURE__ p_TexR\s*,\s*__TEXTURE__ p_TexG\s*,\s*__TEXTURE__ p_TexB\s*\)/.test(oneLineSig);
  const hasPixelSig = oneLineSig !== undefined && /__DEVICE__\s+float3\s+transform\s*\(\s*int p_Width\s*,\s*int p_Height\s*,\s*int p_X\s*,\s*int p_Y\s*,\s*float p_R\s*,\s*float p_G\s*,\s*float p_B\s*\)/.test(oneLineSig);
  if (sigLines.length === 0) {
    errors.push('缺少 __DEVICE__ float3 transform(...) 入口');
  } else if (!hasTexSig && !hasPixelSig) {
    errors.push('transform 签名必须写在同一行，且为官方允许的逐像素（p_R/p_G/p_B）或纹理（__TEXTURE__ p_TexR/G/B）签名之一');
  } else {
    const hasTex2D = /_tex2D\s*\(/.test(code);
    if (hasPixelSig && hasTex2D) {
      errors.push('逐像素签名（p_R/p_G/p_B）却出现 _tex2D 采样：签名与采样方式不同步（有邻域采样必须改用纹理签名）');
    }
    if (hasTexSig && !hasTex2D) {
      errors.push('纹理签名（__TEXTURE__ p_TexR/G/B）却没有任何 _tex2D 采样：签名与采样方式不同步（无邻域采样应改用逐像素签名）');
    }
  }
  const nParams = (src.match(/^[ \t]*DEFINE_UI_PARAMS\s*\(/gm) || []).length;
  if (nParams === 0) errors.push('缺少 DEFINE_UI_PARAMS 参数声明');
  for (const bad of ['vec4', 'vec3', 'vec2', 'mat3', 'texture2D', 'gl_FragColor', '#version']) {
    if (src.includes(bad)) errors.push(`残留 GLSL 符号：${bad}`);
  }
  /* 引用了没声明的参数宏：达芬奇对这种错误只报一句含糊的
   * 「main DCTL function does not have return value」（实测 30/31/32 三份二分文件全军覆没
   * 即因层裁剪删掉了 FM_VIGNETTE_CHROMA_PX 的声明却留下引用），这里提前抓出来。 */
  const declared = new Set(
    Array.from(code.matchAll(/DEFINE_UI_PARAMS\s*\(\s*(FM_[A-Z0-9_]+)/g), (m) => m[1]),
  );
  const undeclared = new Set<string>();
  for (const m of code.matchAll(/\bFM_[A-Z0-9_]+\b/g)) if (!declared.has(m[0])) undeclared.add(m[0]);
  for (const name of undeclared) errors.push(`引用了未声明的参数宏：${name}（参数面板被裁剪但代码仍在用）`);
  /* ---- R6 标签/tooltip 规则（达芬奇侧血泪：标签带括号会报 unknown type of DCTLUIParams definition）---- */
  /* 标签抓取到 DCTLUI_ 类型名为止：这样标签里若混进逗号也会被完整捕获（而不是被当成参数分隔符切掉）。 */
  const decls: { macro: string; label: string }[] = [];
  for (const m of code.matchAll(/DEFINE_UI_PARAMS\s*\(\s*(FM_[A-Z0-9_]+)\s*,\s*([\s\S]*?)\s*,\s*DCTLUI_/g)) {
    decls.push({ macro: m[1], label: m[2] });
  }
  for (const d of decls) {
    const bad = /[()\[\],]/.exec(d.label);
    if (bad) {
      errors.push(`参数标签含非法字符 '${bad[0]}'（社区实测括号/方括号/逗号会让达芬奇报 unknown type of DCTLUIParams definition）：${d.label.trim()}`);
    }
  }
  if (decls.length > 64) {
    errors.push(`UI 参数共 ${decls.length} 个 > 64：达芬奇 DCTL 每类 UI 参数上限为 64，需分层导出或把低频参数改为常量`);
  }
  /* tooltip 配对：只在本文件**确实用了 tooltip**（标准模式）时要求全配对。
   * 这样既能拦住「生成器漏配」，也不会误伤两类合法产物：
   *   ① 兼容模式（ASCII 标签 + ASCII tooltip）② 标签 spike A/B（故意只有混排标签、不带 tooltip，
   *   用来单独验证「中文+英文+空格」这一种写法）——它们的 tooltip 数为 0，规则不介入。
   * 第一个参数按官方文档示例是**标签文本**（`DEFINE_UI_TOOLTIP(Target Color, "...")`），
   * 宏名写法也接受（两种都能过，现场二分用）。 */
  const tooltipCount = (code.match(/DEFINE_UI_TOOLTIP\s*\(/g) || []).length;
  const bilingual = decls.some((d) => /[^\x00-\x7F]/.test(d.label));
  if (bilingual && tooltipCount > 0) {
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^[ \t]*DEFINE_UI_PARAMS\s*\(\s*(FM_[A-Z0-9_]+)\s*,\s*([\s\S]*?)\s*,\s*DCTLUI_/.exec(lines[i]);
      if (!m) continue;
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      const t = j < lines.length ? /^[ \t]*DEFINE_UI_TOOLTIP\s*\(\s*([^,]*?)\s*,/.exec(lines[j]) : null;
      if (!t) {
        errors.push(`标准模式参数 ${m[1]} 缺少紧随其后的 DEFINE_UI_TOOLTIP（标签为混排时必须逐条配对）`);
      } else {
        const target = t[1].trim();
        const label = m[2].trim();
        if (target !== m[1] && target !== label) {
          errors.push(`DEFINE_UI_TOOLTIP 的第一个参数既不是宏名也不是该参数的标签：'${target}'（应为 '${m[1]}' 或 '${label}'）`);
        }
      }
    }
  }
  /* 宏名形式的 tooltip 引用了没声明的参数：和 DEFINE_UI_PARAMS 一样属于面板/代码不同步 */
  for (const m of code.matchAll(/DEFINE_UI_TOOLTIP\s*\(\s*(FM_[A-Z0-9_]+)\s*,/g)) {
    if (!declared.has(m[1])) errors.push(`DEFINE_UI_TOOLTIP 引用了未声明的参数宏：${m[1]}`);
  }
  /* UI 参数不许出现在自定义函数体里：Resolve 只把 DEFINE_UI_PARAMS 注入 transform 的局部作用域
   * （见 generateDctl 里的根因注释）。这是 30/43/三个样例「一用就闪退」的根因，在这里拦死。 */
  for (const fn of dctlFunctionBodies(code)) {
    if (fn.name === 'transform') continue;
    const hit = /\bFM_[A-Z0-9_]+\b/.exec(fn.body);
    if (hit) {
      errors.push(`自定义函数 ${fn.name} 里直接引用了 UI 参数 ${hit[0]}：Resolve 只把参数注入 transform 内，helper 里读参数会闪退（应显式传参）`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 生成后自检：层裁剪一旦吃掉 transform 尾部，达芬奇只会报含糊的 return value 错误，
 *  这里显式拦住「括号不配平 / 入口没有 return / 残留层标记」三种情况。 */
function assertDctlTail(src: string): void {
  const code = stripCommentsAndStrings(src);
  const no = code.split('{').length - 1;
  const nc = code.split('}').length - 1;
  if (no !== nc) throw new Error(`DCTL 生成器内部错误：花括号不配平（{ ${no} / } ${nc}）`);
  if (/>>>STAGE|<<<STAGE/.test(src)) throw new Error('DCTL 生成器内部错误：源码残留层标记');
  if (!/^[ \t]*return make_float3\(/m.test(code)) {
    throw new Error('DCTL 生成器内部错误：transform 缺少顶层 return make_float3(...)');
  }
}

/* ================= 生成器 ================= */

/** 官方允许的两种入口签名（必须物理单行）：
 *  - 纹理签名：含邻域采样（halation/bloom/vignette 色散/gate_weave 位移）时使用；
 *  - 逐像素签名：无任何纹理采样（只含色彩层，或只有程序化颗粒）时使用，
 *    此时可直接走「节点右键 → LUT → DCTL」加载（但没有参数面板）。
 *  达芬奇对两种签名都接受；关键是要与源码里是否真的采样保持一致（R14 血泪：纹理签名 + 52 个 UI
 *  参数用 LUT 路径加载会报 `wrong argument int p_Width`）。 */
export const TEXTURE_SIG = '__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB)';
export const PIXEL_SIG = '__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)';

/** 3×3 高斯 tap 的边权重（σ=R/2 → exp(-R²/(2σ²)) = exp(-2)） */
const GAUSS_EDGE = Math.exp(-2);
/** 高斯对角点权重：σ=d/2 的网格里对角距离 d√2 → exp(-2·2) = exp(-4)（= GAUSS_EDGE²，既有 3×3 约定） */
const GAUSS_DIAG = GAUSS_EDGE * GAUSS_EDGE;

/* ---- R21 tap 结构：双环 + 逐 tap look ----
 * 结构（用户实机回执：大面积亮区的雾状 veil 在旧 5tap/单环结构下收集不到）：
 *   光晕：紧晕 3×3@rT（保留 R9 结构）+ 宽晕双环 = 内环 3×3@rW + 外环 8 点@2rW（外环不重复采中心）；
 *   柔光：中心 + 4 正交@rB + 4 正交@2rB（R12 的 5 点交叉升级为双环）。
 * 环权重：按「半径与 σ 的关系」推导——环内间距 d 的网格取 σ = d/2（既有 GAUSS_EDGE 约定），
 *   正交点核值 exp(-2)、对角点核值 exp(-4)；外环（间距 2d）套用同一约定 → 权重同为 exp(-2)/exp(-4)，
 *   合成包络 ≈ 两条高斯链（d 与 2d）叠加，远场覆盖到 2d——网页端 blur 半径按 master 放大
 *   （σ_web = d·master/2，支持域 ±1.25·d·master）在 master ≤ 1.6 时都落在双环覆盖范围内。
 * 亮通：每 tap 读 RGB 三通道并先过完整链路（匹配 → tf encode → fm_log_look → tf decode，
 *   与中心像素同式）再算阈值——把阈值作用域从「源图」搬到「look 后的图」，与网页端一致。
 *   采样代价：每像素 3(src) + 27(紧晕) + 51(宽晕) + 27(柔光) = 108 次 _tex2D（R12–R20 为 36）。 */

/** 一个 tap 的采样文本块（公共前奏）：坐标钳制 → RGB 三通道 → 逐 tap 完整链路。
 *  lookArgs：无匹配段形态为 `lp, cp`；含匹配段形态为 `mp, tm, lp, cp`。 */
function emitTapSample(dxExpr: string, dyExpr: string, lookArgs: string): string[] {
  return [
    '        {',
    `            int xx = fm_clampi(cx + (${dxExpr}), p_Width);`,
    `            int yy = fm_clampi(cy + (${dyExpr}), p_Height);`,
    '            float lr = _tex2D(p_TexR, xx, yy);',
    '            float lg = _tex2D(p_TexG, xx, yy);',
    '            float lb = _tex2D(p_TexB, xx, yy);',
    `            float3 lk = fm_tap_look(make_float3(lr, lg, lb), ${lookArgs});   // 邻域点过完整链路（与中心像素同式）`,
  ];
}

/** tap 几何：[dx 表达式, dy 表达式, 权重字面量] */
type TapOffset = [string, string, string];

/** 3×3 网格几何（间距 s 为运行时表达式；withCenter=false = 外环去掉与内环重复的中心采样） */
function gridOffsets(s: string, withCenter: boolean): TapOffset[] {
  const out: TapOffset[] = [];
  for (const oy of [-1, 0, 1]) {
    for (const ox of [-1, 0, 1]) {
      if (ox === 0 && oy === 0 && !withCenter) continue;
      const dx = ox === 0 ? '0' : `${ox} * ${s}`;
      const dy = oy === 0 ? '0' : `${oy} * ${s}`;
      const w = ox === 0 && oy === 0 ? fnum(1, 6) : (ox === 0 || oy === 0) ? fnum(GAUSS_EDGE, 6) : fnum(GAUSS_DIAG, 6);
      out.push([dx, dy, w]);
    }
  }
  return out;
}

/** 正交十字几何（4 点，权重 exp(-2)；柔光双环用） */
function crossOffsets(s: string): TapOffset[] {
  const w = fnum(GAUSS_EDGE, 6);
  return [
    [`-1 * ${s}`, '0', w],
    [`${1} * ${s}`, '0', w],
    ['0', `-1 * ${s}`, w],
    ['0', `${1} * ${s}`, w],
  ];
}

/** 光晕 tap 块：标量累积（每 tap 只累积亮通权重 bw·gw；晕色由 tint_rgb 上色——产品语义，
 *  见观感对齐清单 v2 项 2）。亮通按最大通道（网页端 brightPass useMax=1 同语义）。
 *  powK：1=紧晕（保高光形状）2=宽晕（越亮晕越铺开）。 */
function emitHalTaps(offsets: TapOffset[], powK: number, threshMacro: string, acc: string, wsum: string, lookArgs: string): string[] {
  const out: string[] = [];
  const bw = powK === 1
    ? `fm_smoothstep(${threshMacro}, 1.0f, lv)`
    : `_powf(fm_smoothstep(${threshMacro}, 1.0f, lv), 2.0f)`;
  for (const [dx, dy, gw] of offsets) {
    out.push(...emitTapSample(dx, dy, lookArgs));
    out.push('            float lv = fm_max3(lk);   // 亮通按最大通道（网页端光晕 useMax=1）');
    out.push(`            float bw = ${bw};`);
    out.push(`            float gw = ${gw};`);
    out.push(`            ${acc} = ${acc} + bw * gw;`);
    out.push(`            ${wsum} = ${wsum} + gw;`);
    out.push('        }');
  }
  return out;
}

/** 柔光 tap 块：彩色累积（look 后源色 × 亮通权重；R21 起阈值按亮度——网页端 bloom brightPass
 *  useMax=0 同语义，R12 版为 max3+源图域）。累积色进 screen 混合 + 饱和度控制。 */
function emitBloomTaps(offsets: TapOffset[], threshMacro: string, acc: string, wsum: string, lookArgs: string): string[] {
  const out: string[] = [];
  for (const [dx, dy, gw] of offsets) {
    out.push(...emitTapSample(dx, dy, lookArgs));
    out.push('            float lv = fm_luma(lk);   // 亮通按亮度（网页端柔光 useMax=0）');
    out.push(`            float bw = fm_smoothstep(${threshMacro}, 1.0f, lv);`);
    out.push(`            float gw = ${gw};`);
    out.push(`            ${acc} = fm_add3(${acc}, fm_scale3(lk, bw * gw));`);
    out.push(`            ${wsum} = ${wsum} + gw;`);
    out.push('        }');
  }
  return out;
}

function pipelineInfo(tf: PipelineTF) {
  return PIPELINES.find((p) => p.id === tf) ?? PIPELINES[0];
}

function buildWarnings(
  input: DctlGenInput, res: { w: number; h: number }, labelMode: LabelMode, tooltips: boolean, matchOn: boolean,
  usesTexture: boolean, masterDefault: number,
): string[] {
  const w: string[] = [];
  w.push(`空间量滑杆以 ${res.w}×${res.h} 为基准换算为像素默认值，运行时按 p_Height/${res.h} 自动缩放`
    + `（2160p 时间线 ×2，无需按比例手调）。`);
  /* R14：加载途径与入口签名强绑定——这是用户实机报 `wrong argument int p_Width` 的直接原因。 */
  if (usesTexture) {
    w.push('本 DCTL 使用纹理签名（含邻域采样 / 参数面板）：**必须**用 Color 页 → OpenFX/特效库 → ResolveFX Color → DCTL '
      + '加载，再在检查器里选文件；用「节点右键 → LUT → DCTL」加载会报 wrong argument int p_Width。');
  } else {
    w.push('本 DCTL 为逐像素签名（只含色彩层，无邻域采样）：可用「节点右键 → LUT → DCTL」加载（但没有参数面板）；'
      + '需要检查器面板就改用 ResolveFX Color → DCTL 插件加载。');
  }
  if (input.pipeline === 'aces') {
    w.push('ACES 管线为预留，尚未实测校准；已退化为 RCM（DaVinci Intermediate）的 TF。');
  }
  if (matchOn) {
    w.push('CDL 是对完整匹配变换的近似，与网页端 engine 匹配存在数值差（见生成页误差报告）。');
    w.push('匹配段作用于显示域（采样之后、对数编码之前），与网页端「匹配 → look → 质感」的顺序一致；'
      + '系数是该镜头的解算结果，换镜头需重新生成或在面板上手动改。');
    if (input.match && cdlNeedsClamp(input.match.cdl)) {
      w.push('传入的 CDL 系数有越界或非有限项，已按导出通道同一规则收敛（面板默认值 = 收敛后的值）。');
    }
  }
  w.push('DCTL 基础形态已在达芬奇实测通过（Studio + Windows + CUDA 后端）：对数域 look + 质感层可加载、可运行、参数面板可用。');
  if (labelMode === 'bilingual') {
    w.push('中英混排参数标签尚未在达芬奇实机验证（前科：标签里的括号会报 unknown type of DCTLUIParams definition）；'
      + '异常时改用 compat 模式（纯 ASCII 标签）。');
  }
  if (tooltips) {
    w.push('R6 新增的 DEFINE_UI_TOOLTIP 行同样尚未实机验证；'
      + '请先用 tools/dctl-samples/spike_label_*.dctl 三份 3 参数文件确认面板与悬停说明正常（约 2 分钟）。');
  }
  w.push('观感差异逐项清单（R21 更新）：亮通阈值已逐 tap 作用于 look 后的图（与网页端同作用域）；'
    + '残余差异为 tap 求积近似（双环结构）与光晕晕色仍由 tint 决定，见 docs/research/观感对齐清单-R9.md。');
  w.push('光晕/柔光邻域采样为 R21 双环结构（光晕=紧晕 3×3 + 宽晕 3×3@r + 外环 8@2r；柔光=中心+4@r+4@2r），'
    + '每 tap 读 RGB 并过完整 look（匹配+对数域 look），每像素采样 108 次（R20 前 36 次；'
    + '真实 GPU 上 84 次时代实测约 140fps，余量充足）。光晕累积仍为亮度标量×tint 上色，柔光累积 look 后源色。');
  if (masterDefault !== 1) {
    w.push(`质感总强度已按配方 master（${round6(masterDefault)}）烘焙为 FM_MASTER 默认值：`
      + 'R20 前的产物忽略该维度（达芬奇侧整体比网页偏弱）；面板可在 0..2 调节。');
  }
  const dynamicGrain = input.dynamicGrain !== false;
  /* R18 诚实标注：HSL 8 色相维度不由 DCTL 承载（仅网页预览与 .cube 导出）。
   * 配方真的带 HSL 调整时必须显式警告——否则导出会在用户不知情时丢一整个维度。 */
  if (!hslIsIdentity(input.look.hsl)) {
    w.push('该配方含 HSL 8 色相调整：DCTL 不承载此维度（DCTL 参数余量不足，见 EFFECT-REPORT-R18）；'
      + 'HSL 仅由网页预览与 .cube 导出承载，达芬奇侧观感会缺少这部分色相/饱和/明度分区调整。');
  }
  if (dynamicGrain) {
    w.push('动态颗粒依赖达芬奇 19.1+ 的 TIMELINE_FRAME_INDEX（ResolveFX DCTL 插件；作为 LUT 加载时该键恒为 1，颗粒仍静态）；'
      + '若面板不动或逐帧不变，可用 dynamicGrain:false 回退静态颗粒。');
  } else {
    w.push('已关闭动态颗粒（dynamicGrain:false）：颗粒与片门抖动均退化为静态（产物不含 TIMELINE_FRAME_INDEX），'
      + '与网页端 24fps 动态颗粒观感不同。');
  }
  if (input.stages?.gate_weave !== false) {
    if (dynamicGrain) {
      w.push('片门抖动按 TIMELINE_FRAME_INDEX/24 派生相位（垂直分量 0.6、频率比 1.37）；'
        + 'FM_GATE_WEAVE_PX=0 时位移为 0（逐位恒等）。');
    } else {
      w.push('片门抖动依赖 TIMELINE_FRAME_INDEX，dynamicGrain:false 时位移恒为 0（面板参数保留但不生效）。');
    }
  }
  w.push('UI 参数只在 transform() 内读取后经结构体传给助手函数——Resolve 只把参数注入 transform 的局部作用域，助手函数里直接读参数会让达芬奇闪退。');
  return w;
}

/**
 * 生成语法自洽的 DCTL 源码。
 * 入口固定 `__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, __TEXTURE__ ...)`，
 * 参数区为 DEFINE_UI_PARAMS，数学为归一化对数域 look + effectmath 语义质感层。
 */
export function generateDctl(input: DctlGenInput): DctlGenResult {
  const compat = input.compat === true;
  const branchless = input.branchless === true;
  /* R9 动态颗粒默认开：相位由 TIMELINE_FRAME_INDEX 逐帧步进；false = R8 静态回退（不含帧索引）。 */
  const dynamicGrain = input.dynamicGrain !== false;
  /* 标签三开关：compat 的旧语义（ASCII 标签 + 0/1 浮点滑杆）保持不变，
   * 等价于 labelMode: 'ascii'，但显式传的 labelMode 优先（compat + bilingual = ASCII 开关写法 + 混排标签）。 */
  const labelMode: LabelMode = input.labelMode ?? (compat ? 'ascii' : 'bilingual');
  const groupPrefix = input.groupPrefix ?? true;
  /* tooltip 默认只开在 bilingual 模式：ascii/compat 是「已实机验证」的形态，不掺未验证语法（见 DctlGenInput.tooltips） */
  const tooltips = input.tooltips ?? (labelMode === 'bilingual');
  const declOpts: DefineLineOpts = { labelMode, groupPrefix, tooltips, boolSlider: compat, tooltipTarget: input.tooltipTarget };
  const res = input.resolution ?? { w: 1920, h: 1080 };
  /* 层开关：参数面板裁剪与代码块裁剪共用同一张表——两处若各算各的，就会出现
   * 「面板里删了参数、代码里还在引用」的未定义宏（达芬奇报 main DCTL function does
   * not have return value，实测 30/31/32 三份二分文件即因此全部编译失败）。
   * novignette 是暗角层的反向开关：暗角关闭时用不带边缘色散的退化取样替换 src。 */
  const st: Record<string, boolean> = {
    match: input.match !== undefined, halation: true, bloom: true, grain: true, vignette: true, gate_weave: true,
    ...(input.stages ?? {}),
  };
  st.novignette = !st.vignette;
  /* R14 入口签名选择：只有**完全不需要纹理采样**时才用逐像素签名。
   * 需要纹理采样的层：halation/bloom（邻域 tap）、vignette（边缘色散按 rx/ry/bx/by 取样）、
   * gate_weave（取样中心 cx/cy 逐帧位移）。grain 是程序化噪声（读 p_X/p_Y，不读纹理），
   * 故「只有颗粒」时仍可走逐像素签名。这样能保证「签名形态 ↔ 是否出现 _tex2D」严格同步。 */
  const usesTexture = st.halation || st.bloom || st.vignette || st.gate_weave;
  const sigLine = usesTexture ? TEXTURE_SIG : PIXEL_SIG;
  /* 匹配段是否真的内联：传了 match 且没有被 stages 关掉（两者缺一就不出参数、不出代码） */
  const matchOn = input.match !== undefined && st.match !== false;
  /* 只导出指定层时，参数面板也一并裁剪（否则面板里会留一堆无效滑杆）。
   * MATCH 与质感层走同一条过滤：stages.match === false 时匹配段的 11 个参数一起消失。
   * R21：FM_MASTER（质感总强度）只在含质感层（光晕/柔光/颗粒/暗角任一开启）的形态出现——
   * 色彩层-only / 分层导出的色彩段没有可总控的质感层，该参数无意义；片门抖动不受 master 缩放
   * （与网页端一致），仅片门开启时不出现。 */
  const masterDefault = input.master === undefined || !Number.isFinite(input.master) ? 1 : clampRange(input.master, 0, 2);
  const hasTexLayer = st.halation || st.bloom || st.grain || st.vignette;
  const params = [
    ...textureParamDecls(input.texture, input.look, res, masterDefault),
    ...(input.match ? matchParamDecls(input.match) : []),
  ].filter((p) => {
    if (p.macro === 'FM_MASTER') return hasTexLayer;
    const m = /^FM_(MATCH|HALATION|BLOOM|GRAIN|VIGNETTE|GATE_WEAVE)_/.exec(p.macro);
    if (!m) return true;
    return st[m[1].toLowerCase()] !== false;
  });
  const warnings = buildWarnings(input, res, labelMode, tooltips, matchOn, usesTexture, masterDefault);
  const info = pipelineInfo(input.pipeline);

  const t = input.texture;
  const h = t.halation, g = t.grain, b = t.bloom, v = t.vignette;
  const H = res.h;
  const tightPx = Math.max(1, Math.round((TIGHT_RADIUS_H / 100) * H));
  const widePx = Math.max(1, Math.round((halationRadiusEff(h.radius, h.amplify, h.smoothness) / 100) * H));
  const bloomPx = Math.max(1, Math.round((bloomRadiusEff(b.radius, b.details) / 100) * H));
  const sizeEff = grainSizeEff(g.size, g.film_resolution);
  const grainPx = Math.max(1.25, round6((sizeEff / 1000) * H));
  const chromaPx = round6(v.chroma_shift * H);
  const gw = grainScaleWeights(sizeEff, g.film_resolution);
  /* R21 逐 tap look 的实参表：含匹配段时 tap 侧复用同一份 CDL（mp + 开关 0/1 值 tm） */
  const lookArgs = matchOn ? 'mp, tm, lp, cp' : 'lp, cp';

  const L: string[] = [];
  const push = (...xs: string[]) => L.push(...xs);
  /* 层开关的两种写法：默认 `if (SW) { … }`；branchless 先算完再乘 0/1 开关（见 DctlGenInput.branchless）。
   * branchless 下用一个裸作用域块包住原 body，缩进保持原义、也贴合实机可用的 24_tex_9tap 写法。 */
  const openStage = (macro: string, guard: string): void => {
    if (branchless) {
      push(`    float ${guard} = ${switchExpr(macro, compat)};`);
      push('    {');
    } else {
      push(`    if (${boolCond(macro, compat)}) {`);
    }
  };
  const closeStage = (): void => { push('    }'); };

  /* ---- 文件头 ---- */
  push('// =====================================================================');
  push('// FilmMatch 菲林工坊 · 达芬奇 DCTL 配方');
  push(`// 配方：${input.recipeName}`);
  push(`// 分享码：${input.shareCode}`);
  push(`// 管线：${info.name}`);
  push(`//       ${info.note}`);
  push(`// 生成基准：${res.w}×${res.h}（半径/颗粒/色散滑杆 = 该基准 px，运行时按 p_Height/${res.h} 缩放）`);
  push(`//   光晕宽晕半径 ${widePx}px（源 ${round6(h.radius)}%H）`);
  push(`//   光晕紧晕半径 ${tightPx}px（固定 ${TIGHT_RADIUS_H}%H）`);
  push(`//   柔光半径 ${bloomPx}px（源 ${round6(b.radius)}%H）`);
  push(`//   颗粒间距 ${grainPx}px（源 ${round6(sizeEff)}‰H）`);
  push(`//   边缘色散 ${chromaPx}px（源 ${round6(v.chroma_shift)} 画面高度比）`);
  if (masterDefault !== 1) push(`// 质感总强度：FM_MASTER 默认 = 配方 master ${round6(masterDefault)}（0..2 可调；与网页端 master 同源）`);
  if (matchOn) push('// 匹配段：内联 CDL（与 R3 导出系数一致，可在面板微调）');
  push(compat
    ? `// 模式：兼容模式（ASCII 参数标签；开关为 0/1 滑杆而非勾选框${tooltips ? '；含 ASCII tooltip' : '，不含 tooltip'}）`
    : `// 模式：标准（中英混排参数标签${groupPrefix ? ' + 分组前缀' : ''}${tooltips ? ' + tooltip' : '（无 tooltip）'}；开关为勾选框）`);
  push(`// 参数标签：${labelMode}${labelMode === 'bilingual' ? '（中英混排，如「光晕-强度 Halation Amount」）' : '（纯 ASCII，避开未验证字符）'}`
    + `${tooltips ? '；每条参数附 DEFINE_UI_TOOLTIP 说明' : ''}`);
  push(`// 入口签名：${usesTexture
    ? '纹理（__TEXTURE__ p_TexR/p_TexG/p_TexB；含邻域采样）'
    : '逐像素（float p_R/p_G/p_B；无邻域采样）'}`);
  push(usesTexture
    ? '// 正确加载途径：Color 页 → OpenFX/特效库 → ResolveFX Color → DCTL，再在检查器里选本文件。'
      + '用「节点右键 → LUT → DCTL」加载会报 wrong argument int p_Width（纹理签名 + 参数面板不走 LUT 路径）。'
    : '// 正确加载途径：可用「节点右键 → LUT → DCTL」（逐像素签名，但没有参数面板）；'
      + '需要检查器面板就用 Color 页 → OpenFX/特效库 → ResolveFX Color → DCTL 加载。');
  push('// 商标：本文件由 FilmMatch 菲林工坊 生成与维护，不含任何第三方品牌标识。');
  push('// 采样：光晕=紧晕 3×3 + 宽晕双环（3×3@r + 外环 8@2r）、柔光=中心+4@r+4@2r，每 tap 读 R/G/B 并过完整 look；');
  push(`//       亮通阈值作用于 look 后的邻域值（与网页端同作用域）。每像素共 ${3 + 27 + 51 + 27} 次纹理读取（R20 前为 36 次）。`);
  push('//       与网页端的残余差异见 docs/research/观感对齐清单-R9.md（v2）。');
  push('// 注意：半径/颗粒/色散/片门滑杆均为像素语义（本文件生成基准），运行时按时间线高度自动缩放；');
  push('//       在不同分辨率时间线（如 2160p）无需手动换算参数。');
  push('// =====================================================================');
  push('');
  push('// ---- 参数面板（达芬奇 OFX 滑杆/开关；tooltip 紧跟在各自声明之后） ----');
  for (const p of params) push(...defineLine(p, declOpts));
  push('');
  push('// ---- 内置工具（纯函数，DCTL 语法） ----');
  push('float fm_clamp01(float x) { return x < 0.0f ? 0.0f : (x > 1.0f ? 1.0f : x); }');
  push('float fm_mix(float a, float b, float t) { return a + (b - a) * t; }');
  /* 官方函数清单里没有 _fract（spike② 实测报错），用 x - _floorf(x) 等价实现 */
  push('__DEVICE__ float fm_fract(float x) { return x - _floorf(x); }');
  push('float3 fm_mix3(float3 a, float3 b, float t) {');
  push('    return make_float3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);');
  push('}');
  /* DCTL 不保证 float3 与标量的运算符重载（spike② 实测 `float3 * float` 会编译失败），
   * 因此生成的代码里所有向量运算一律走这三个助手，不写 `vec * k` / `a + b`。 */
  push('float3 fm_scale3(float3 v, float k) { return make_float3(v.x * k, v.y * k, v.z * k); }');
  push('float3 fm_add3(float3 a, float3 b) { return make_float3(a.x + b.x, a.y + b.y, a.z + b.z); }');
  push('float3 fm_mul3(float3 a, float3 b) { return make_float3(a.x * b.x, a.y * b.y, a.z * b.z); }');
  push('float fm_smoothstep(float a, float b, float x) {');
  push('    float t = fm_clamp01((x - a) / (b - a));');
  push('    return t * t * (3.0f - 2.0f * t);');
  push('}');
  push('float fm_luma(float3 c) { return 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z; }');
  push('float fm_max3(float3 c) { return _fmaxf(c.x, _fmaxf(c.y, c.z)); }');
  /* Schema v1.2 分离色调：色相 → 零亮度 RGB 方向（6 段线性色相轮；与 engine/look.splitHueRGB 同式） */
  push('float3 fm_split_dir(float h) {');
  push('    float hh = fm_clamp01(h);');
  push('    float h6 = fm_fract(hh) * 6.0f;');
  push('    float i = _floorf(h6);');
  push('    float f = h6 - i;');
  push('    float q = 1.0f - f;');
  push('    float rr = 1.0f;');
  push('    float gg = 0.0f;');
  push('    float bb = 0.0f;');
  push('    if (i < 1.0f) { rr = 1.0f; gg = f; bb = 0.0f; }');
  push('    else if (i < 2.0f) { rr = q; gg = 1.0f; bb = 0.0f; }');
  push('    else if (i < 3.0f) { rr = 0.0f; gg = 1.0f; bb = f; }');
  push('    else if (i < 4.0f) { rr = 0.0f; gg = q; bb = 1.0f; }');
  push('    else if (i < 5.0f) { rr = f; gg = 0.0f; bb = 1.0f; }');
  push('    else { rr = 1.0f; gg = 0.0f; bb = q; }');
  push('    float ll = 0.2126f * rr + 0.7152f * gg + 0.0722f * bb;');
  push('    return make_float3(rr - ll, gg - ll, bb - ll);');
  push('}');
  push('int fm_clampi(int x, int n) { return x < 0 ? 0 : (x > n - 1 ? n - 1 : x); }');
  push('int fm_iround(float x) { return x < 0.0f ? (int)(x - 0.5f) : (int)(x + 0.5f); }');
  push('float fm_hash12(float px, float py, float k) {');
  push('    float x = fm_fract(px * 0.1031f);');
  push('    float y = fm_fract(py * 0.1031f);');
  push('    float z = fm_fract(k * 0.1031f);');
  push('    float d = x * (y + 33.33f) + y * (z + 33.33f) + z * (x + 33.33f);');
  push('    x = x + d; y = y + d; z = z + d;');
  push('    return fm_fract((x + y) * z);');
  push('}');
  push('float fm_vnoise(float px, float py, float k) {');
  push('    float ix = _floorf(px);');
  push('    float iy = _floorf(py);');
  push('    float fx = px - ix;');
  push('    float fy = py - iy;');
  push('    float ux = fx * fx * (3.0f - 2.0f * fx);');
  push('    float uy = fy * fy * (3.0f - 2.0f * fy);');
  push('    float a = fm_hash12(ix, iy, k);');
  push('    float bb = fm_hash12(ix + 1.0f, iy, k);');
  push('    float cc = fm_hash12(ix, iy + 1.0f, k);');
  push('    float dd = fm_hash12(ix + 1.0f, iy + 1.0f, k);');
  push('    return (a + (bb - a) * ux) * (1.0f - uy) + (cc + (dd - cc) * ux) * uy;');
  push('}');
  push('');

  /* ---- R7 匹配段 helper：内联 CDL（逐式镜像 batch/cdl.applyCdl，JS 侧镜像见 inlinecdl.ts） ---- */
  if (matchOn) {
    push('// ---- 匹配段：内联 CDL（逐式镜像 batch/cdl.applyCdl；系数与 R3 导出一致） ----');
    push('typedef struct { float sr, sg, sb, ofr, ofg, ofb, pr, pg, pb, sat; } FmMatchParams;');
    push('float fm_cdl_ch(float x, float s, float o, float p) {');
    push('    float base = x * s + o;');
    push('    if (base <= 0.0f) return 0.0f;   // 底数非正按 0 处理（与 cdl.ts 同规则：单调、无 NaN）');
    push('    return _powf(base, p);');
    push('}');
    push('float3 fm_apply_cdl(float3 c, FmMatchParams m) {');
    push('    float r = fm_cdl_ch(c.x, m.sr, m.ofr, m.pr);');
    push('    float g = fm_cdl_ch(c.y, m.sg, m.ofg, m.pg);');
    push('    float b = fm_cdl_ch(c.z, m.sb, m.ofb, m.pb);');
    push('    float l = 0.2126f * r + 0.7152f * g + 0.0722f * b;   // Rec.709 亮度（与 cdl.ts 同权重）');
    push('    return make_float3(fm_clamp01(l + m.sat * (r - l)),');
    push('                       fm_clamp01(l + m.sat * (g - l)),');
    push('                       fm_clamp01(l + m.sat * (b - l)));');
    push('}');
    push('');
  }

  /* ---- TF（按管线生成；aces 退化 rcm） ---- */
  push('// ---- 管线 TF：显示编码 ↔ 归一化对数域 x∈[0,1] ----');
  if (input.pipeline === 'yrgb') {
    const lo = fnum(YRGB_LOG_LO, 6), hi = fnum(YRGB_LOG_HI, 6), inv = fnum(1 / (YRGB_LOG_HI - YRGB_LOG_LO), 8);
    push('float fm_tf_encode(float v) {');
    push(`    float L = _powf(fm_clamp01(v), 2.4f);                       // BT.1886 EOTF（简化幂律 2.4）`);
    push(`    float tt = _logf(L + ${fnum(YRGB_EPS, 6)}) * 1.44269504f;  // log2（加黑位偏移保有限）`);
    push(`    return fm_clamp01((tt - (${lo})) * ${inv});                 // 归一化：0→0 / 0.18→0.5 / 1→1`);
    push('}');
    push('float fm_tf_decode(float x) {');
    push(`    float tt = (${lo}) + fm_clamp01(x) / ${inv};`);
    push(`    float L = _fmaxf(_expf(tt * 0.69314718f) - ${fnum(YRGB_EPS, 6)}, 0.0f);`);
    push('    return fm_clamp01(_powf(L, 0.41666667f));                  // 1/2.4');
    push('}');
  } else {
    push('// DaVinci Intermediate 已是归一化对数编码（0=黑/1=白/中灰≈0.333），直接重归一化 = 恒等');
    push('float fm_tf_encode(float v) { return fm_clamp01(v); }');
    push('float fm_tf_decode(float x) { return fm_clamp01(x); }');
  }
  push('');

  /* ---- 对数域 look（逐式镜像 logmath.applyLogLook） ---- */
  push('// ---- 归一化对数域 look（与网页端 logmath.applyLogLook 同式） ----');
  push('float fm_soft_s(float x, float pivot, float s) {');
  push('    float p = fm_clamp01(pivot);');
  push('    float lo = p < 0.000001f ? 0.000001f : p;');
  push('    float hi = (1.0f - p) < 0.000001f ? 0.000001f : (1.0f - p);');
  push('    if (x <= p) {');
  push('        float u = fm_clamp01(x / lo);');
  push('        float su = u * u * (3.0f - 2.0f * u);');
  push('        return p * fm_mix(u, su, s);');
  push('    }');
  push('    float u = fm_clamp01((x - p) / hi);');
  push('    float su = u * u * (3.0f - 2.0f * u);');
  push('    return p + hi * fm_mix(u, su, s);');
  push('}');
  push('float fm_gamma_s(float x, float s) {');
  push('    float su = x * x * (3.0f - 2.0f * x);');
  push('    return fm_mix(x, su, s);');
  push('}');
  push('float fm_toe_shoulder(float x, float pivot, float toe, float shoulder) {');
  push('    float p = fm_clamp01(pivot);');
  push('    float y = x;');
  push('    if (toe > 0.000001f && y < p && p > 0.000001f) {');
  push('        float u = fm_clamp01(y / p);');
  push('        y = p * _powf(u, 1.0f / (1.0f + toe));');
  push('    }');
  push('    if (shoulder > 0.000001f && y > p && p < 0.999999f) {');
  push('        float u = fm_clamp01((y - p) / (1.0f - p));');
  push('        y = p + (1.0f - p) * (1.0f - _powf(1.0f - u, 1.0f + shoulder));');
  push('    }');
  push('    return y;');
  push('}');
  /* 【实机闪退根因 · 2026-09-22 第六轮】UI 参数只能在 transform() 里直接读。
   * Resolve 不是把 DEFINE_UI_PARAMS 当全局变量，而是把它们注入成 transform 的**局部变量**
   * （公开编译日志里能看到注入形式：`__DEVICE__ float3 transform(..., __GLOBAL__ DCTLUIParams* p_UIParams)`
   * 之后在函数体内 `float SIZE = p_UIParams->sliderFloatParams[0];`）；官方文档也只承诺
   * 「This variable can be used inside the transform function.」
   * 因此 helper 里写 FM_XXX 属于未定义作用域——本项目的 fm_look_channel / fm_log_look 正是如此，
   * 导致 30/43/三个样例一用就闪退（而 20–24、40–42 这些 helper 里不碰参数的诊断文件全部正常）。
   * 修法：参数打包成结构体、从 transform 显式传入（与公开项目 utility-dctls 的 log_params_t 同写法）。 */
  push('typedef struct { float pivot, contrast, film_s, gamma_contrast, toe, shoulder; } FmChannelParams;');
  /* R18：FmLookParams.black_extra 仅在锚点重标定给出非零对数域黑位时出现——默认产物与 R17 前逐字节一致 */
  const blkExtra = Math.max(0, input.look.black_lift ?? 0);
  push(blkExtra > 0
    ? 'typedef struct { float crosstalk, black_extra, shadow_bias, highlight_bias, fade, saturation, warmth, split_sh_hue, split_sh_sat, split_hi_hue, split_hi_sat, split_balance; } FmLookParams;'
    : 'typedef struct { float crosstalk, shadow_bias, highlight_bias, fade, saturation, warmth, split_sh_hue, split_sh_sat, split_hi_hue, split_hi_sat, split_balance; } FmLookParams;');
  push('float fm_look_channel(float x, FmChannelParams p) {');
  push('    float pivot = fm_clamp01(p.pivot);');
  push('    float y = pivot + (x - pivot) * p.contrast;');
  push('    y = fm_soft_s(y, pivot, p.film_s);');
  push('    y = fm_gamma_s(y, p.gamma_contrast);');
  push('    y = fm_toe_shoulder(y, pivot, p.toe, p.shoulder);');
  push('    return y;');
  push('}');
  push('float3 fm_log_look(float3 c, FmLookParams lp, FmChannelParams cp) {');
  push('    float3 y = make_float3(fm_look_channel(c.x, cp), fm_look_channel(c.y, cp), fm_look_channel(c.z, cp));');
  /* R18 染料串扰六系数：默认（= 历史固定矩阵）按原字面量输出（产物逐字节一致）；
   * 配方自定义时按常量烘焙进源码（不新增 UI 参数，参数预算不变）。 */
  const coup = normalizeCoupling(input.look.coupling);
  const crosstalkIsDefault = couplingIsDefault(input.look.coupling);
  const cf = (v: number, dflt: number): string => (crosstalkIsDefault ? fnum(dflt, 2) : fnum(v, 4));
  const rgT = cf(coup.rg, DEFAULT_COUPLING.rg), rbT = cf(coup.rb, DEFAULT_COUPLING.rb);
  const grT = cf(coup.gr, DEFAULT_COUPLING.gr), gbT = cf(coup.gb, DEFAULT_COUPLING.gb);
  const brT = cf(coup.br, DEFAULT_COUPLING.br), bgT = cf(coup.bg, DEFAULT_COUPLING.bg);
  push('    // 染料串扰（通道交叉混合；k=0 恒等；R18 六系数为烘焙常量）');
  push('    float k = lp.crosstalk;');
  push('    float3 d;');
  push(`    d.x = y.x * (1.0f - k) + y.y * (k * ${rgT}) + y.z * (k * ${rbT});`);
  push(`    d.y = y.x * (k * ${grT}) + y.y * (1.0f - k * 0.8f) + y.z * (k * ${gbT});`);
  push(`    d.z = y.x * (k * ${brT}) + y.y * (k * ${bgT}) + y.z * (1.0f - k * 1.6f);`);
  push('    // 分通道反向偏置（暗部青蓝 / 高光暖黄，相对量）');
  push('    float l = fm_luma(d);');
  push('    float sh = _powf(fm_clamp01(1.0f - l), 2.2f);');
  push('    float hi = _powf(fm_clamp01(l), 2.2f);');
  push('    d.x = d.x + lp.shadow_bias * (-0.10f * sh) + lp.highlight_bias * (0.10f * hi);');
  push('    d.y = d.y + lp.shadow_bias * (0.02f * sh) + lp.highlight_bias * (0.08f * hi);');
  push('    d.z = d.z + lp.shadow_bias * (0.16f * sh) + lp.highlight_bias * (-0.18f * hi);');
  push('    // 分离色调（Schema v1.2）：暗部/高光色相方向 × 饱和度 × 亮度权重（sat=0 贡献为 0）');
  push('    float spB = _fminf(1.0f, _fmaxf(-1.0f, lp.split_balance));');
  push('    float spWS = sh * (1.0f - 0.5f * spB);');
  push('    float spWH = hi * (1.0f + 0.5f * spB);');
  push('    float3 sds = fm_split_dir(lp.split_sh_hue);');
  push('    float3 sdh = fm_split_dir(lp.split_hi_hue);');
  push('    float sss = 0.2f * lp.split_sh_sat * spWS;');
  push('    float shs = 0.2f * lp.split_hi_sat * spWH;');
  /* spWS/spWH 已含亮度权重 sh/hi（与 GRADE_FS `(ds*(u_spShSat*spWS)+dh*(u_spHiSat*spWH))*0.2`
   * 及 engine/look `splitSS*sh` 同式）；此处**不再**乘 sh/hi，否则 DCTL 会比网页端多一个亮度权重
   * 因子（R13 数值一致性链发现的历史偏差，见 TEST-REPORT-R13 §发现的问题）。 */
  push('    d.x = d.x + sds.x * sss + sdh.x * shs;');
  push('    d.y = d.y + sds.y * sss + sdh.y * shs;');
  push('    d.z = d.z + sds.z * sss + sdh.z * shs;');
  push('    // 褪色：黑位提升 + 白位收拢（R18：锚点重标定的对数域黑位以常量 black_extra 烘焙，默认 0 不出现）');
  push(blkExtra > 0 ? '    float blk = lp.fade * 0.10f + lp.black_extra;' : '    float blk = lp.fade * 0.10f;');
  push('    float wht = lp.fade * 0.08f;');
  push('    d = make_float3(blk + fm_clamp01(d.x) * (1.0f - blk - wht),');
  push('                    blk + fm_clamp01(d.y) * (1.0f - blk - wht),');
  push('                    blk + fm_clamp01(d.z) * (1.0f - blk - wht));');
  push('    // 饱和度 + 冷暖');
  push('    float l2 = fm_luma(d);');
  push('    d = make_float3(l2 + (d.x - l2) * lp.saturation,');
  push('                    l2 + (d.y - l2) * lp.saturation,');
  push('                    l2 + (d.z - l2) * lp.saturation);');
  push('    d = make_float3(d.x * (1.0f + lp.warmth * 0.05f),');
  push('                    d.y * (1.0f + lp.warmth * 0.01f),');
  push('                    d.z * (1.0f - lp.warmth * 0.05f));');
  push('    return make_float3(fm_clamp01(d.x), fm_clamp01(d.y), fm_clamp01(d.z));');
  push('}');
  push('');

  /* ---- R21 逐 tap look helper：邻域点过与中心像素完全相同的链路 ----
   * （匹配（若有）→ tf encode → fm_log_look → tf decode）。亮通阈值因此作用在「look 后的图」上，
   * 与网页端 brightPass(graded, ...) 同作用域；柔光的累积色也改为 look 后源色（与网页端一致）。
   * 参数经结构体显式传入，helper 内不直接读 UI 参数（达芬奇只把参数注入 transform 作用域）。 */
  if (st.halation || st.bloom) {
    push('// ---- 邻域 tap 的逐点 look（R21）：与中心像素同链路，阈值作用于 look 后的图 ----');
    if (matchOn) {
      push('__DEVICE__ float3 fm_tap_look(float3 s, FmMatchParams mp, float tm, FmLookParams lp, FmChannelParams cp) {');
      push(branchless
        ? '    s = fm_mix3(s, fm_apply_cdl(s, mp), tm);   // 无分支模式：匹配按开关混合'
        : '    if (tm > 0.5f) { s = fm_apply_cdl(s, mp); }   // 匹配段与中心像素同式（开关关闭则跳过）');
    } else {
      push('__DEVICE__ float3 fm_tap_look(float3 s, FmLookParams lp, FmChannelParams cp) {');
    }
    push('    float3 e = make_float3(fm_tf_encode(s.x), fm_tf_encode(s.y), fm_tf_encode(s.z));');
    push('    e = fm_log_look(e, lp, cp);');
    push('    return make_float3(fm_tf_decode(e.x), fm_tf_decode(e.y), fm_tf_decode(e.z));');
    push('}');
    push('');
  }

  /* ---- 入口 ---- */
  /* 签名必须物理上写在同一行：达芬奇的 DCTL 校验器按行扫描 transform 声明，
   * 折行会被判成 "wrong argument int p_Width / main DCTL function has wrong arguments"（spike② 实测）。
   * 签名形态随 usesTexture 切换（逐像素 / 纹理），见上方 R14 注释。 */
  push(sigLine);
  push('{');
  /* R21 半径运行时缩放：空间量滑杆语义 = 「生成基准分辨率下的 px」，transform 里按
   * p_Height / 基准高度 缩放。生成基准默认 1080p → hs = p_Height/1080（2160p 时间线 ×2）；
   * 基准分辨率时间线上 hs ≡ 1.0f，所有空间量与 R20 前的固化常量逐位一致（恒等护栏）。 */
  push(`    float hs = (float)p_Height / ${fnum(res.h, 1)};   // 空间量运行时缩放基准（滑杆为 ${res.h}p 基准 px）`);
  /* R9 片门抖动：逐帧位移必须作用到**所有**纹理取样（src + 邻域 tap），最简做法是先把取样中心
   * 从 p_X/p_Y 挪到 cx/cy，后续 tap 一律基于 cx/cy 偏移。
   * 位移公式（冻结契约）：dx = amount*H*sin(2π*speed*t)、
   *   dy = amount*H*0.6*sin(2π*speed*1.37*t + 1.7)，其中 amount*H 固化为 FM_GATE_WEAVE_PX、
   *   t = TIMELINE_FRAME_INDEX/24。FX_PX=0 时位移为 0 → 逐位恒等。
   * 帧索引与 UI 参数一样只在 transform 内可见：整段只写在 transform 函数体里，绝不进 helper。 */
  push('    float wx = 0.0f;');
  push('    float wy = 0.0f;');
  push('    // >>>STAGE:gate_weave');
  if (dynamicGrain) {
    push('    float wSec = (float)TIMELINE_FRAME_INDEX / 24.0f;   // 秒（24fps 基准）');
    push('    float wPh = 6.28318531f * FM_GATE_WEAVE_SPEED * wSec;');
    push('    float wPx = (float)FM_GATE_WEAVE_PX * hs;   // 位移 px（1080p 基准，按高度缩放）');
    push('    wx = wPx * _sinf(wPh);');
    push('    wy = wPx * 0.6f * _sinf(wPh * 1.37f + 1.7f);   // 垂直分量 0.6 / 频率比 1.37 / 相位 1.7');
  } else {
    push('    // dynamicGrain:false → 无帧索引可用，片门抖动退化为 0（见 warnings）');
  }
  push('    // <<<STAGE:gate_weave');
  push('    int cx = fm_clampi(p_X + fm_iround(wx), p_Width);');
  push('    int cy = fm_clampi(p_Y + fm_iround(wy), p_Height);');
  /* 边缘色散属于暗角层（chroma_shift 是暗角参数），故整块挂在 vignette 开关下；
   * 暗角关闭时用 novignette 分支的退化取样，保证 src 始终有定义。
   * R14：完全无纹理采样时改用逐像素签名，输入直接取 p_R/p_G/p_B（不再 _tex2D）——数学与观感一致。 */
  if (usesTexture) {
    push('    // >>>STAGE:vignette');
    push('    float wf = (float)p_Width;');
    push('    float hf = (float)p_Height;');
    push('    float cuvx = (float)p_X / wf - 0.5f;');
    push('    float cuvy = (float)p_Y / hf - 0.5f;');
    push('    float len = _sqrtf(cuvx * cuvx + cuvy * cuvy);');
    push('    float rr = len * 1.41421356f;   // 0 中心 → 1 角落');
    push('    // 边缘色散：R 外移 / B 内移（与网页管线同序，先于 look）；px 按高度运行时缩放');
    push('    float caPx = FM_VIGNETTE_CHROMA_PX * hs * rr * rr;');
    push('    float cax = len > 0.0001f ? cuvx / len * caPx : 0.0f;');
    push('    float cay = len > 0.0001f ? cuvy / len * caPx : 0.0f;');
    push('    int rx = fm_clampi(cx - fm_iround(cax), p_Width);');
    push('    int ry = fm_clampi(cy - fm_iround(cay), p_Height);');
    push('    int bx = fm_clampi(cx + fm_iround(cax), p_Width);');
    push('    int by = fm_clampi(cy + fm_iround(cay), p_Height);');
    push('    float3 src = make_float3(_tex2D(p_TexR, rx, ry), _tex2D(p_TexG, cx, cy), _tex2D(p_TexB, bx, by));');
    push('    // <<<STAGE:vignette');
    push('    // >>>STAGE:novignette');
    push('    float3 src = make_float3(_tex2D(p_TexR, cx, cy), _tex2D(p_TexG, cx, cy), _tex2D(p_TexB, cx, cy));');
    push('    // <<<STAGE:novignette');
  } else {
    /* 色彩层-only：逐像素签名，直接取输入像素（无 _tex2D、无 __TEXTURE__） */
    push('    float3 src = make_float3(p_R, p_G, p_B);');
  }
  push('');
  /* ---- R7 匹配段：采样之后、tf_encode 之前（显示域 CDL，与网页端/导出 CDL 同一作用域） ---- */
  if (matchOn) {
    push('    // >>>STAGE:match');
    push('    // ---- 匹配段：内联 CDL（与 R3 导出系数一致，可在面板微调） ----');
    /* R21：mp/tm 提升到层开关作用域之外——邻域 tap 的逐 tap look 复用同一份 CDL 系数。
     * FM_MATCH_ON 关闭时 src 不经 CDL，tap 侧由 tm=0 走同一分支（中心与邻域始终同域）。 */
    push('    FmMatchParams mp;');
    push('    mp.sr = FM_MATCH_SLOPE_R; mp.sg = FM_MATCH_SLOPE_G; mp.sb = FM_MATCH_SLOPE_B;');
    push('    mp.ofr = FM_MATCH_OFFSET_R; mp.ofg = FM_MATCH_OFFSET_G; mp.ofb = FM_MATCH_OFFSET_B;');
    push('    mp.pr = FM_MATCH_POWER_R; mp.pg = FM_MATCH_POWER_G; mp.pb = FM_MATCH_POWER_B;');
    push('    mp.sat = FM_MATCH_SAT;');
    push(`    float tm = ${switchExpr('FM_MATCH_ON', compat)};   // 匹配开关的 0/1 值（tap 侧逐点复用）`);
    openStage('FM_MATCH_ON', 'matchOn');
    push(branchless
      ? '        src = fm_mix3(src, fm_apply_cdl(src, mp), matchOn);   // 无分支模式：按开关在源/匹配之间混合'
      : '        src = fm_apply_cdl(src, mp);');
    closeStage();
    push('    // <<<STAGE:match');
    push('');
  }
  push('    // ---- 归一化对数域 look ----');
  push('    float3 c = make_float3(fm_tf_encode(src.x), fm_tf_encode(src.y), fm_tf_encode(src.z));');
  /* UI 参数在这里（transform 函数体内）读出并打包，再传给 helper——helper 里直接读参数会闪退 */
  push('    FmChannelParams cp;');
  push('    cp.pivot = FM_PIVOT; cp.contrast = FM_CONTRAST; cp.film_s = FM_FILM_S;');
  push('    cp.gamma_contrast = FM_GAMMA_CONTRAST; cp.toe = FM_TOE; cp.shoulder = FM_SHOULDER;');
  push('    FmLookParams lp;');
  push('    lp.crosstalk = FM_CROSSTALK; lp.shadow_bias = FM_SHADOW_BIAS; lp.highlight_bias = FM_HIGHLIGHT_BIAS;');
  if (blkExtra > 0) push(`    lp.black_extra = ${fnum(blkExtra, 6)}f;   // R18 锚点重标定（对数域黑位，常量烘焙）`);
  push('    lp.fade = FM_FADE; lp.saturation = FM_SATURATION; lp.warmth = FM_WARMTH;');
  push('    lp.split_sh_hue = FM_SPLIT_SHADOW_HUE; lp.split_sh_sat = FM_SPLIT_SHADOW_SAT;');
  push('    lp.split_hi_hue = FM_SPLIT_HIGHLIGHT_HUE; lp.split_hi_sat = FM_SPLIT_HIGHLIGHT_SAT;');
  push('    lp.split_balance = FM_SPLIT_BALANCE;');
  push('    c = fm_log_look(c, lp, cp);');
  push('    c = make_float3(fm_tf_decode(c.x), fm_tf_decode(c.y), fm_tf_decode(c.z));');
  push('    float bgL = fm_luma(c);   // 背景亮度（未叠加效果前）：增益类参数按它算');
  push('');
  push('    // >>>STAGE:halation');
  push('    // ---- 光晕：紧晕 3×3 + 宽晕双环（R21）；亮通逐 tap 过完整 look（与网页端同作用域） ----');
  push('    float3 hal = make_float3(0.0f, 0.0f, 0.0f);');
  openStage('FM_HALATION_ON', 'halOn');
  /* R21：半径滑杆为生成基准 px，按 hs 运行时缩放；每 tap 读 RGB 并过 fm_tap_look（完整链路），
   * 累积仍为标量亮通权重（晕色由 tint 决定，产品语义——观感对齐清单 v2 项 2）。 */
  push('        // 半径运行时缩放：1080p 基准时间线上与旧固化常量逐位一致（fm_iround(x·1.0f) = x）');
  push('        int rt = fm_iround((float)FM_HALATION_TIGHT_PX * hs);');
  push('        int rw = fm_iround((float)FM_HALATION_RADIUS_PX * hs);');
  push('        float lumT = 0.0f;   // 紧晕亮通权重累积（标量；晕色由 tint 决定）');
  push('        float lumW = 0.0f;   // 宽晕亮通权重累积');
  push('        float wT = 0.0f;');
  push('        float wW = 0.0f;');
  push(`        // 紧晕 3×3@rt（${tightPx}px @${res.h}p 基准，pow=1 保高光形状）`);
  push(...emitHalTaps(gridOffsets('rt', true), 1, 'FM_HALATION_THRESHOLD', 'lumT', 'wT', lookArgs));
  push(`        // 宽晕双环：内环 3×3@rw + 外环 8@2rw（${widePx}px @${res.h}p 基准，pow=2 → 越亮晕越铺开；外环不重复采中心）`);
  push(...emitHalTaps(gridOffsets('rw', true), 2, 'FM_HALATION_THRESHOLD', 'lumW', 'wW', lookArgs));
  push(...emitHalTaps(gridOffsets('2 * rw', false), 2, 'FM_HALATION_THRESHOLD', 'lumW', 'wW', lookArgs));
  push('        lumT = lumT / _fmaxf(wT, 0.0001f);');
  push('        lumW = lumW / _fmaxf(wW, 0.0001f);');
  push('        // 紧/宽权重分配（与 effectmath.halationWeights 同式，含 R21 master；amplify 只改配比不改不透明度）');
  push('        float halA = fm_clamp01(FM_HALATION_AMPLIFY / 2.0f);');
  push('        float halS = fm_clamp01(FM_HALATION_SMOOTH);');
  push(`        float halBase = ${fnum(TIGHT_WEIGHT + WIDE_WEIGHT, 4)} * FM_HALATION_AMOUNT * FM_MASTER * FM_HALATION_IMPACT;`);
  push(`        float halWf = _fminf(0.85f, _fmaxf(0.10f, ${fnum(WIDE_WEIGHT / (TIGHT_WEIGHT + WIDE_WEIGHT), 5)} + 0.20f * (halA - 0.5f) + 0.10f * (halS - 0.5f)));`);
  push('        float halV = lumT * halBase * (1.0f - halWf) + lumW * halBase * halWf;   // 标量晕强度（亮通权重均值 × tint 上色）');
  push('        // 晕染色：hue 调绿层灵敏度、amplify 抬绿增益（与 effectmath 同式）；颜色由 tint 决定');
  push('        float tintG = 0.6f + 0.8f * FM_HALATION_HUE;');
  push('        float tintB = 1.0f - 0.8f * _fabs(FM_HALATION_HUE - 0.5f);');
  push('        float tintA = 0.85f + 0.3f * fm_clamp01(FM_HALATION_AMPLIFY / 2.0f);');
  push('        float3 tint = make_float3(FM_HALATION_TINT_R, fm_clamp01(FM_HALATION_TINT_G * tintG) * tintA, fm_clamp01(FM_HALATION_TINT_B * tintB));');
  push('        hal = make_float3(fm_clamp01(halV * tint.x), fm_clamp01(halV * tint.y), fm_clamp01(halV * tint.z));');
  push('        // 暗部保护：远场软衰减 + 亮背景压制 + 冷背景补偿');
  push('        float halProt = fm_smoothstep(0.004f, 0.035f, fm_max3(hal));');
  push(`        float halBg = 1.0f - (1.0f - fm_clamp01(FM_HALATION_BG_GAIN)) * fm_smoothstep(${fnum(HAL_BG_LO, 2)}, ${fnum(HAL_BG_HI, 2)}, bgL);`);
  push('        float halBlue = 1.0f + fm_clamp01(FM_HALATION_BLUE_COMP) * 0.8f * fm_clamp01((c.z - c.x) / 0.35f);');
  push('        hal = fm_scale3(hal, halProt * halBg * halBlue);');
  /* 无分支模式：光晕为 0 时 screen 混合是恒等（1-(1-c)(1-0)=c），故乘开关即可等价关闭 */
  if (branchless) push('        hal = fm_scale3(hal, halOn);');
  push('        c = make_float3(1.0f - (1.0f - c.x) * (1.0f - hal.x),');
  push('                        1.0f - (1.0f - c.y) * (1.0f - hal.y),');
  push('                        1.0f - (1.0f - c.z) * (1.0f - hal.z));');
  closeStage();
  push('    // <<<STAGE:halation');
  push('');
  push('    // >>>STAGE:bloom');
  push('    // ---- 柔光 bloom（R21 双环：中心 + 4@r + 4@2r；亮通逐 tap 过完整 look，按亮度阈值） ----');
  openStage('FM_BLOOM_ON', 'bloomOn');
  /* R12 恢复彩色累积、R21 升级双环 + 逐 tap look + 亮度阈值（网页端 bloom brightPass useMax=0）：
   * 累积色 = look 后源色 × 亮通权重（与网页端彩色 tap 同语义），采样预算 9 tap × 3 通道 = 27 次。 */
  push('        int rb = fm_iround((float)FM_BLOOM_RADIUS_PX * hs);   // 半径运行时缩放（1080p 基准时间线 = 原值）');
  push('        float3 lumB = make_float3(0.0f, 0.0f, 0.0f);   // 柔光彩色累积（look 后源色）');
  push('        float wB = 0.0f;');
  push(`        // 柔光双环：中心 + 内环 4@rb + 外环 4@2rb（${bloomPx}px @${res.h}p 基准，details 分配大小光源）`);
  push(...emitBloomTaps([['0', '0', fnum(1, 6)], ...crossOffsets('rb')], 'FM_BLOOM_THRESHOLD', 'lumB', 'wB', lookArgs));
  push(...emitBloomTaps(crossOffsets('2 * rb'), 'FM_BLOOM_THRESHOLD', 'lumB', 'wB', lookArgs));
  /* DCTL 不定义 float3*float（spike② 实测：会报 main DCTL function's return value must be float3），
   * 所有向量-标量运算一律逐分量展开或走 fm_scale3。R21：强度乘 FM_MASTER（与网页端 u_blmAmt = amount·master 同式）。 */
  push('        float blmK = (1.0f / _fmaxf(wB, 0.0001f)) * FM_BLOOM_AMOUNT * FM_MASTER;');
  push('        float3 blm = fm_scale3(lumB, blmK);   // 彩色柔光（带源色）');
  push('        float blmL = fm_luma(blm);');
  push('        blm = make_float3(blmL + (blm.x - blmL) * FM_BLOOM_SATURATION,');
  push('                          blmL + (blm.y - blmL) * FM_BLOOM_SATURATION,');
  push('                          blmL + (blm.z - blmL) * FM_BLOOM_SATURATION);');
  const saveLights = `1.0f - fm_clamp01(FM_BLOOM_SAVE_LIGHTS) * fm_smoothstep(${fnum(BLOOM_SAVE_LO, 2)}, 1.0f, bgL)`;
  push(`        blm = fm_scale3(blm, ${branchless ? `(${saveLights}) * bloomOn` : saveLights});`);
  push('        c = make_float3(1.0f - (1.0f - c.x) * (1.0f - fm_clamp01(blm.x)),');
  push('                        1.0f - (1.0f - c.y) * (1.0f - fm_clamp01(blm.y)),');
  push('                        1.0f - (1.0f - c.z) * (1.0f - fm_clamp01(blm.z)));');
  closeStage();
  push('    // <<<STAGE:bloom');
  push('');
  push('    // >>>STAGE:vignette');
  push('    // ---- 暗角（中心不动，向角落平滑加深；强度乘 master 并按 1 封顶——与网页端 u_vigAmt 同式） ----');
  openStage('FM_VIGNETTE_ON', 'vigOn');
  push(`        float vig = ${branchless ? '1.0f - vigOn * ' : '1.0f - '}_fminf(1.0f, FM_VIGNETTE_AMOUNT * FM_MASTER) * fm_smoothstep(FM_VIGNETTE_RADIUS * 0.707f - 0.35f, 1.0f, rr);`);
  push('        c = fm_scale3(c, vig);');
  closeStage();
  push('    // <<<STAGE:vignette');
  push('');
  push('    // >>>STAGE:grain');
  push(dynamicGrain
    ? '    // ---- 颗粒（R9 动态：相位由 TIMELINE_FRAME_INDEX 逐帧步进，同一乳剂平移 + 微扰动） ----'
    : '    // ---- 颗粒（静态回退：p_X/p_Y + 常量相位；产物不含帧索引） ----');
  openStage('FM_GRAIN_ON', 'grainOn');
  push('        float grainPx = _fmaxf(FM_GRAIN_SIZE_PX * hs, 1.0f);   // 间距 px（1080p 基准，按高度缩放）');
  /* 颗粒/团簇用基准像素坐标 p_X/p_Y（不含片门位移）：与网页端冻结公式的「基准颗粒坐标」逐式一致；
   * 片门抖动只作用于纹理取样（src + 邻域 tap），不改程序化噪声坐标。 */
  push('        float gx = (float)p_X / grainPx;');
  push('        float gy = (float)p_Y / grainPx;');
  if (dynamicGrain) {
    push('        // 逐帧相位：黄金比步进 + 两个微扰动（逐帧不同，但非每帧完全无关——同一乳剂在动）');
    push('        float ph = (float)TIMELINE_FRAME_INDEX * 0.61803399f;');
    push('        float jx = ph * 0.137f + 0.02f * fm_fract(ph * 0.719f);');
    push('        float jy = ph * 0.211f + 0.02f * fm_fract(ph * 0.913f);');
  }
  const nqx = dynamicGrain ? '(gx + jx)' : 'gx';
  const nqy = dynamicGrain ? '(gy + jy)' : 'gy';
  if (g.mode === 'noise') {
    push(`        float mono = (fm_hash12(${nqx}, ${nqy}, 0.0f) - 0.5f) * 2.0f;`);
  } else {
    push(`        // 金字塔尺度权重（由有效尺寸/乳剂分辨率推导）：粗 ${fnum(gw.coarse, 4)} 中 ${fnum(gw.mid, 4)} 细 ${fnum(gw.fine, 4)}`);
    push(`        float mono = (fm_vnoise(${nqx} * 0.5f, ${nqy} * 0.5f, 0.0f) * ${fnum(gw.coarse, 4)}`);
    push(`                    + fm_vnoise(${nqx}, ${nqy}, 17.13f) * ${fnum(gw.mid, 4)}`);
    push(`                    + fm_vnoise(${nqx} * 1.9f, ${nqy} * 1.9f, 31.71f) * ${fnum(gw.fine, 4)} - 0.5f) * 2.1f;`);
  }
  push(`        float cr = fm_hash12(${nqx} * 1.7f, ${nqy} * 1.7f, 51.7f) - 0.5f;`);
  push(`        float cg = fm_hash12(${nqx} * 1.7f, ${nqy} * 1.7f, 67.3f) - 0.5f;`);
  push(`        float cb = fm_hash12(${nqx} * 1.7f, ${nqy} * 1.7f, 83.9f) - 0.5f;`);
  push('        float3 gnoise = fm_mix3(make_float3(cr * 0.7f, cg * 0.7f, cb * 0.7f), make_float3(mono, mono, mono), FM_GRAIN_CORRELATION);');
  /* R9 扫描颗粒团簇（冻结契约）：低频噪声（基准颗粒坐标 ×0.18、种子 91.7）调制颗粒轻重。
   * gain = 1 + cluster*(low-0.5)*2*0.6，cluster=0 → gain≡1（恒等）。低频噪声用既有 fm_vnoise。 */
  push('        // 扫描颗粒团簇：低频噪声决定团块处颗粒更重');
  push('        float clLow = fm_vnoise(gx * 0.18f, gy * 0.18f, 91.7f);');
  push('        float clGain = 1.0f + FM_GRAIN_CLUSTER * (clLow - 0.5f) * 2.0f * 0.6f;   // cluster=0 → 恒等 1');
  push('        // 亮度三段包络（三段和恒为 1）');
  push('        float gl = fm_luma(c);');
  push(`        float bSh = 1.0f - fm_smoothstep(0.0f, ${fnum(GRAIN_BAND_LO, 2)}, gl);`);
  push(`        float bHi = fm_smoothstep(${fnum(GRAIN_BAND_LO, 2)}, ${fnum(GRAIN_BAND_HI, 2)}, gl);`);
  push('        float bMid = 1.0f - bSh - bHi;');
  push('        float gW = bSh * FM_GRAIN_SHADOW + bMid * FM_GRAIN_MIDTONE + bHi * FM_GRAIN_HIGHLIGHT;');
  push(`        c = fm_add3(c, fm_scale3(gnoise, FM_GRAIN_AMP * FM_MASTER * gW * clGain${branchless ? ' * grainOn' : ''}));   // 幅度乘 master（与网页端 u_grainAmp 同式）`);
  closeStage();
  push('    // <<<STAGE:grain');
  push('    return make_float3(fm_clamp01(c.x), fm_clamp01(c.y), fm_clamp01(c.z));');
  push('}');

  /* 【spike② 实测】达芬奇的 DCTL 是 JIT 编译：**所有函数都必须有执行空间注解**，
   * 未加 __DEVICE__ 的顶层函数会被当成 host 函数并报
   * "A function without execution space annotations is considered a host function,
   *  and host functions are not allowed in JIT mode"。
   * 这里对组装好的源码统一补齐（助手函数很多，逐个手写注解容易漏）。 */
  /* 层裁剪：标记块严格非重叠配对（开标记紧接着闭标记，同名），故单个 skip 槽即可安全工作。
   * 这里的任何错配都会静默吃掉 transform 尾部（含 return），而达芬奇只会含糊地报
   * 「main DCTL function does not have return value」——所以下面有一道自检兜底。 */
  const kept: string[] = [];
  let skip: string | null = null;
  for (const line of L) {
    const open = /\/\/ >>>STAGE:(\w+)/.exec(line);
    const close = /\/\/ <<<STAGE:(\w+)/.exec(line);
    /* 标记行本身是内部实现，永远不输出 */
    if (open) { skip = st[open[1]] ? null : open[1]; continue; }
    if (close) { if (skip === close[1]) skip = null; continue; }
    if (skip) continue;
    kept.push(line);
  }
  if (skip) throw new Error(`DCTL 生成器内部错误：层标记 <<<STAGE:${skip} 缺失（会截断 transform 尾部）`);
  const src = kept.join('\n').replace(
    /^(float3|float2|float|int|void)\s+(fm_\w+)\s*\(/gm,
    '__DEVICE__ $1 $2(',
  ) + '\n';
  assertDctlTail(src);
  return { source: src, params, warnings };
}
