/* FilmMatch 效果层 · 质感渲染管线（在 spike④ 四层管线基础上升级）
 *
 * 升级点（相对 spike④ 基线）：
 * - Halation 双半径结构：紧晕（≈0.3%H，保高光形状）+ 宽晕（参数半径 1.5-3%H，氛围），
 *   宽晕输入按 亮通权重² 预乘 → 晕密度/宽度随局部亮度非线性（越亮晕越宽）；
 *   远场软衰减做暗部保护（黑区增益 <1%）；最大通道提取让饱和色高光也触发。
 * - Grain：3 尺度 value-noise 金字塔（粗/中/细权重由 size 推导）+ 细色度白噪声，
 *   亮度分带 0.85/0.43 先验 + shadow_weight 暗部加权，ISO √ 响应（400=1.0×），
 *   correlation：1=单色 / 0=每通道独立；24fps 相位步进防闪烁。
 * - Bloom/Vignette/CA：沿用 spike④ 语义（宽域亮通 screen / r² 色散）。
 * - 曲线家族：A 电影负片软S（黑位锚定≈+2~7级、中段斜率0.76、肩部hermite保白点）、
 *   B 正片反S（黑位压实、饱和抬升）、C 染料耦合+反向偏置+黑位提升。
 *
 * 后端协商：WebGL2 → WebGL1 → Canvas2D CPU 软渲染。
 * GLSL 用 ES 1.00 写法（无 #version，attribute/varying/texture2D/gl_FragColor），WebGL2/1 通用。
 * uv 约定：贴图上传 UNPACK_FLIP_Y_WEBGL=true，顶点不翻转，采样与 FBO 链路方向一致。
 *
 * 【MVP 整合增量改动（Phase2 工作台）】grade 阶段支持可选 3D LUT 纹理：
 *   RenderOpts.lut = { size, table } | null —— 传入时 grade 直接采样预烘焙的
 *   「匹配∘look」LUT（预览与 .cube 导出所见即所得），传 null 回退程序化 look。
 *   其余管线（亮通/模糊/合成/颗粒/CPU 路径）未改动语义。
 *
 * 单位：半径=%H（画面高度），颗粒尺寸=‰H，chroma_shift=画面高度比例
 *（0.004 ≈ 1080p 角落 4px：dispPx = shift·H·r²，r 为到中心距离/半对角，随 r² 衰减）。
 */
import { cloneParams, defaultParams, type FilmParams, type ViewMode } from './params';
import { applyLUT } from '../engine';
/* Schema v1.2 分离色调：色相→RGB 方向与平衡增益的单一真源在 engine/look（GLSL 侧逐式镜像 splitDir）*/
/* Schema v1.1 质感参数的纯数学单一真源：CPU 后端直接调用，GLSL 侧逐式镜像。
 * 从 effectmath 复用 clamp01/smoothstep/LUMA_*，避免两份定义漂移。 */
/* R10：look 数学单一真源（engine/look.lookTransform）。CPU 后端**直接调用**它，
 * GLSL（GRADE_FS look 段）逐式镜像；故 CPU 预览/导出复合 LUT 与 shader 路径同源。
 * R18：串扰六系数（DEFAULT_COUPLING 缺省 = 历史固定矩阵）与 HSL 带表也取自 engine/look。 */
import {
  DEFAULT_COUPLING, HSL_HUES, couplingIsDefault, hslIsIdentity,
  lookTransform, type LookParams as EngineLookParams,
} from '../engine/look';
import type { MatchBakeData } from '../engine/match';
import type { DataRange } from '../engine/lut';
import {
  clamp01, smoothstep as smoothstepF, LUMA_R, LUMA_G, LUMA_B,
  TIGHT_RADIUS_H, GRAIN_BASE,
  grainSizeEff, grainResolutionAmp, grainScaleWeights, grainTypeGains, grainWeightAt,
  halationBackgroundAtten, halationWeights, halationRadiusEff,
  halationAmplifyTintGain, halationHueTint, halationBlueCompGain,
  bloomSaveLightsFactor, bloomRadiusEff, bloomSaturationMix,
  GRAIN_CLUSTER_DEPTH, GRAIN_CLUSTER_FREQ, GRAIN_CLUSTER_SEED, grainClusterGain,
  GATE_WEAVE_VERT_RATIO, GATE_WEAVE_FREQ_RATIO, GATE_WEAVE_PHASE, gateWeaveOffsetPx,
} from './effectmath';
import {
  DEFAULT_RT_SCALE, normalizeRtScale, qualityLabel, selectQuality,
  type QualityInfo, type RtScale,
} from './quality';

export type Backend = 'webgl2' | 'webgl1' | 'cpu';

/** 烘焙好的 3D LUT。R10 起 **只承载匹配变换**（bakeMatchLUT）；look 由 GRADE_FS 用 uniform 叠加。
 *  结构兼容 engine 的 LUT3D / 旧「匹配∘look」复合 LUT（传入即按匹配 LUT 语义使用）。 */
export interface LutData { size: number; table: Float32Array }

export interface RenderOpts {
  mode?: ViewMode;
  splitX?: number;        // 0-1 分屏位置（原图在右）
  master?: number;        // 覆盖 params.master
  halationTight?: number; // 验证钩子：紧晕权重倍率（H2 开/关对比用）
  halationWide?: number;  // 验证钩子：宽晕权重倍率
  lut?: LutData | null;   // R10：匹配 LUT（null=无匹配，仅 shader look）
}

export interface RenderInitOpts {
  internalScale?: number; // CPU 后端内部渲染精度（默认 0.5）
  rtScale?: RtScale;      // R10-B：光晕离屏 RT 比例（默认 0.25 = 1/4；探测失败自动退回 1）
}

/* R17：GPU tile-atlas LUT 烘焙请求（实现在 src/film/gpubake.ts，动态 import）。
 * 只改变「烘焙发生在哪里」——look 滑杆拖动零重烘语义不受影响（烘焙仍只在匹配参数变化时发生）。 */
export interface LutBakeRequest {
  size: number;                       // 33 / 65
  kind: 'match' | 'recipe';           // 预览匹配 / 导出复合
  match: MatchBakeData | null;        // 匹配常数（null = 无统计恒等）
  look: EngineLookParams | null;      // look 参数（kind='recipe' 消费）
  range: DataRange;                   // 'full'（默认）/ 'legal'
}

const DITHER_SEED = 7.13;    // 防 banding dither 的固定 hash 种子（noise 模式启用）

/** R18：look.hsl → GRADE_FS 的 u_hsl[8] uniform（24 floats；缺省通道填 0 = 不调整） */
function hslUniforms(hsl?: EngineLookParams['hsl']): Float32Array {
  const a = new Float32Array(24);
  if (hsl) {
    for (let i = 0; i < 8; i++) {
      const ch = hsl[HSL_HUES[i]];
      if (!ch) continue;
      a[i * 3] = ch.hue ?? 0;
      a[i * 3 + 1] = ch.sat ?? 0;
      a[i * 3 + 2] = ch.lum ?? 0;
    }
  }
  return a;
}

/* ---------------- GLSL（ES 1.00，WebGL2/1 通用） ---------------- */

const VERT = `attribute vec2 a_pos;
varying vec2 v_uv;
void main(){ v_uv = a_pos*0.5 + 0.5; gl_Position = vec4(a_pos,0.,1.); }`;

/* 色彩层：匹配（可选 3D LUT）+ look（片元着色器，uniform）→ 明暗/饱和/冷暖。
 * R10：LUT **只承载匹配变换**（bakeMatchLUT）；look 数学搬进本 shader（uniform 传参），
 *   故拖动 look 滑杆只需更新 uniform（零烘焙），只有匹配参数变化才重烘 LUT。
 *   信号链：源 →（匹配 LUT？）→ look → 光晕 → 柔光 → 颗粒 → 暗角（与既有管线顺序一致）。
 *   LUT 以 2D atlas 上传：x = b*n + r，y = g，双 tap 三线性。
 * look 段的 GLSL 与 src/engine/look.ts 的 lookTransform 逐式对应（单一真源；
 *   fade/black_lift/dye_coupling/shadow_bias/highlight_bias/film_s/contrast/saturation/warmth
 *   + R8 分离色调 5 参数 + R18 串扰六系数/HSL 8 色相）。数值一致性证明见 src/film/lookshader.test.ts。 */
const GRADE_FS = `precision highp float;
uniform sampler2D u_tex;
uniform sampler2D u_lut;
uniform float u_useLut, u_lutN;
uniform float u_fade,u_black,u_coupling,u_shBias,u_hiBias,u_sat,u_filmS,u_contrast,u_warm;
uniform float u_spShHue,u_spShSat,u_spHiHue,u_spHiSat,u_spBal;   /* Schema v1.2 分离色调 */
uniform float u_cRg,u_cRb,u_cGr,u_cGb,u_cBr,u_cBg;               /* R18 串扰六系数 */
uniform vec3 u_hsl[8];                                            /* R18 HSL 8 色相 */
uniform vec2 u_gres;                       /* grade 目标分辨率（dither 用） */
uniform float u_dither, u_ditherSeed;      /* 防 banding dither（仅 grain.mode==noise 时非零） */
varying vec2 v_uv;
float luma(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }
float hash12(vec2 p, float k){
  vec3 p3 = fract(vec3(p.x, p.y, k)*0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x+p3.y)*p3.z);
}
vec3 dyeCross(vec3 c){
  float k = u_coupling;
  return vec3(
    c.r*(1.0-k)      + c.g*(k*u_cRg)    + c.b*(k*u_cRb),
    c.r*(k*u_cGr)    + c.g*(1.0-k*0.8)  + c.b*(k*u_cGb),
    c.r*(k*u_cBr)    + c.g*(k*u_cBg)    + c.b*(1.0-k*1.6));
}
/* R18 HSL：rgb2hsv/hsv2rgb（与 engine/look 逐式一致） */
vec3 rgb2hsv(vec3 c){
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float d = mx - mn;
  float h = 0.0;
  if (d > 0.0) {
    float rr = (mx - c.r) / d;
    float gg = (mx - c.g) / d;
    float bb = (mx - c.b) / d;
    float hh = (mx == c.r) ? (bb - gg) : ((mx == c.g) ? (2.0 + rr - bb) : (4.0 + gg - rr));
    h = hh / 6.0;
    if (h < 0.0) h += 1.0;
  }
  return vec3(h, mx <= 0.0 ? 0.0 : d / mx, mx);
}
vec3 hsv2rgb(vec3 c){
  float h6 = fract(c.x) * 6.0;
  float i = floor(h6);
  float f = h6 - i;
  float p = c.z * (1.0 - c.y);
  float q = c.z * (1.0 - f * c.y);
  float t = c.z * (1.0 - (1.0 - f) * c.y);
  if (i < 1.0) return vec3(c.z, t, p);
  if (i < 2.0) return vec3(q, c.z, p);
  if (i < 3.0) return vec3(p, c.z, t);
  if (i < 4.0) return vec3(p, q, c.z);
  if (i < 5.0) return vec3(t, p, c.z);
  return vec3(c.z, p, q);
}
/* Schema v1.2 分离色调：色相 → 零亮度 RGB 方向（6 段线性色相轮；与 engine/look.splitHueRGB 同式） */
vec3 splitDir(float h){
  float hh = clamp(h, 0.0, 1.0);
  float h6 = fract(hh) * 6.0;
  float i = floor(h6);
  float f = h6 - i;
  float q = 1.0 - f;
  vec3 raw;
  if (i < 1.0) raw = vec3(1.0, f, 0.0);
  else if (i < 2.0) raw = vec3(q, 1.0, 0.0);
  else if (i < 3.0) raw = vec3(0.0, 1.0, f);
  else if (i < 4.0) raw = vec3(0.0, q, 1.0);
  else if (i < 5.0) raw = vec3(f, 0.0, 1.0);
  else raw = vec3(1.0, 0.0, q);
  return raw - vec3(dot(raw, vec3(0.2126, 0.7152, 0.0722)));
}
/* 家族A 参考曲线（s=1 全量）：黑位锚定 0.030、中段斜率 0.76@0.42枢轴、肩部收拢保白点 */
float refS(float x){
  float lin = 0.42 + (x-0.42)*0.76;
  float toe = 0.030 + (lin-0.030)*pow(clamp(x/0.42,0.0,1.0), 0.75);
  float y = mix(toe, lin, smoothstep(0.02, 0.24, x));
  if (x > 0.55){                                  /* 肩部 hermite：f(1)=1 保白点，端部斜率趋平 */
    float u = (x-0.55)/0.45;
    y = 0.5188 + u*(0.342 + u*(0.7596 - u*0.6204));
  }
  return y;
}
float shapeNeg(float x){                          /* 家族A 软S（负片观感） */
  float s = u_filmS;
  if (s <= 0.001) return x;
  return mix(x, refS(x), s);
}
float shapePos(float x){                          /* 家族B 正片反S：端点斜率0、中点斜率1.5、黑位压实 */
  float s = u_contrast;
  if (s <= 0.001) return x;
  return mix(x, x*x*(3.0-2.0*x), s);
}
vec3 lutSample(vec3 c){                           /* 3D LUT（atlas 布局）双 tap 三线性 */
  float n = u_lutN;
  float m = n - 1.0;
  float r = clamp(c.r,0.0,1.0)*m, g = clamp(c.g,0.0,1.0)*m, b = clamp(c.b,0.0,1.0)*m;
  float b0 = min(floor(b), m - 0.001);
  float fb = b - b0;
  float b1 = min(b0 + 1.0, m);
  float x0 = (b0*n + r + 0.5)/(n*n);
  float x1 = (b1*n + r + 0.5)/(n*n);
  float y = (g + 0.5)/n;
  vec3 s0 = texture2D(u_lut, vec2(x0, y)).rgb;
  vec3 s1 = texture2D(u_lut, vec2(x1, y)).rgb;
  return mix(s0, s1, fb);
}
void main(){
  vec3 c = texture2D(u_tex, v_uv).rgb;
  /* 匹配：仅当挂了匹配 LUT（uniform/纹理零烘焙，滑杆拖动只改 look uniform） */
  if (u_useLut > 0.5) c = lutSample(c);
  /* look 段（始终应用；与 engine/look.lookTransform 逐式一致） */
  c = vec3(shapePos(c.r), shapePos(c.g), shapePos(c.b));
  c = vec3(shapeNeg(c.r), shapeNeg(c.g), shapeNeg(c.b));
  c = dyeCross(c);
  float l = luma(c);
  float sh = pow(clamp(1.0-l,0.,1.), 2.2);
  float hi = pow(clamp(l,0.,1.), 2.2);
  c.r += u_shBias*(-0.10*sh) + u_hiBias*( 0.10*hi);   /* 分通道反向偏置：暗部青、高光黄 */
  c.g += u_shBias*( 0.02*sh) + u_hiBias*( 0.08*hi);
  c.b += u_shBias*( 0.16*sh) + u_hiBias*(-0.18*hi);
  /* Schema v1.2 分离色调：暗部/高光各自色相方向 × 饱和度 × 亮度权重（sat=0 时贡献为 0） */
  float spB = clamp(u_spBal, -1.0, 1.0);
  float spWS = sh * (1.0 - 0.5*spB);
  float spWH = hi * (1.0 + 0.5*spB);
  vec3 ds = splitDir(u_spShHue);
  vec3 dh = splitDir(u_spHiHue);
  c += (ds * (u_spShSat * spWS) + dh * (u_spHiSat * spWH)) * 0.2;
  /* R18 HSL 8 色相（全 0 跳过=逐位恒等；与 engine/look.hslAdjustRgb 同式） */
  float hslAny = 0.0;
  for (int hi = 0; hi < 8; hi++) hslAny += abs(u_hsl[hi].x) + abs(u_hsl[hi].y) + abs(u_hsl[hi].z);
  if (hslAny > 0.0) {
    vec3 hsv = rgb2hsv(clamp(c, 0.0, 1.0));
    float hc[8];
    hc[0] = 0.0;        hc[1] = 0.08333333; hc[2] = 0.16666667; hc[3] = 0.33333333;
    hc[4] = 0.5;        hc[5] = 0.66666667; hc[6] = 0.77777778; hc[7] = 0.88888889;
    float wS = 0.0, dH = 0.0, dS = 0.0, dL = 0.0;
    for (int hi = 0; hi < 8; hi++) {
      vec3 ch = u_hsl[hi];
      if (abs(ch.x) + abs(ch.y) + abs(ch.z) > 0.0) {
        float dd = abs(hsv.x - hc[hi]);
        dd = min(dd, 1.0 - dd);
        float w = 1.0 - smoothstep(0.04166667, 0.125, dd);
        if (w > 0.0) {
          wS += w;
          dH += w * ch.x;
          dS += w * ch.y;
          dL += w * ch.z;
        }
      }
    }
    if (wS > 0.0) {
      float wn = 1.0 / wS;
      float h1 = hsv.x + dH * wn * 0.08333333;
      float s1 = clamp(hsv.y * (1.0 + dS * wn * 0.75), 0.0, 1.0);
      float v1 = clamp(hsv.z * (1.0 + dL * wn * 0.30), 0.0, 1.0);
      c = hsv2rgb(vec3(h1, s1, v1));
    }
  }
  float blk = u_black + u_fade*0.10;                  /* 褪色：黑位提升 */
  float wht = u_fade*0.08;                            /*        白位收拢 */
  c = clamp(c,0.,1.);
  c = blk + c*(1.0-blk-wht);
  l = luma(c);
  c = mix(vec3(l), c, u_sat);
  c *= vec3(1.0+u_warm*0.05, 1.0+u_warm*0.01, 1.0-u_warm*0.05);
  /* 防 banding dither：noise 颗粒模式下叠加 ±0.5/255 白噪声（默认 u_dither=0 → 恒等） */
  c += vec3(hash12(v_uv*u_gres, u_ditherSeed)-0.5)*u_dither;
  gl_FragColor = vec4(clamp(c,0.,1.),1.0);
}`;

/* 亮通：软膝阈值（threshold→1 渐入，无硬边）。
 * u_pow=1 用于紧晕；u_pow=2 用于宽晕（权重平方→密度/宽度随亮度非线性，H3）。
 * u_maxch=1 最大通道提取（饱和霓虹也触发），0 按亮度（bloom 用）。 */
const BRIGHT_FS = `precision highp float;
uniform sampler2D u_tex;
uniform float u_thresh, u_pow;
uniform int u_maxch;
varying vec2 v_uv;
float luma(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }
void main(){
  vec3 c = texture2D(u_tex, v_uv).rgb;
  float v = u_maxch==1 ? max(c.r, max(c.g, c.b)) : luma(c);
  float w = pow(smoothstep(u_thresh, 1.0, v), u_pow);
  gl_FragColor = vec4(c*w, 1.0);
}`;

/* 可分离高斯：权重在 shader 内由 sigma 现算（无 uniform 数组，WebGL1 兼容性更好） */
const BLUR_FS = `precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_dir;
uniform float u_sigma, u_R;
varying vec2 v_uv;
void main(){
  vec3 acc = vec3(0.0); float wsum = 0.0;
  float s2 = 2.0*u_sigma*u_sigma + 1e-6;
  for (int i=-40;i<=40;i++){
    float fi = float(i);
    if (fi < -u_R || fi > u_R) continue;
    float w = exp(-fi*fi/s2);
    acc += texture2D(u_tex, v_uv + u_dir*fi).rgb * w;
    wsum += w;
  }
  gl_FragColor = vec4(acc/wsum, 1.0);
}`;

/* 合成：色散采样 → bloom screen → halation screen（双半径+暗部保护） → 暗角 → 颗粒
 * Schema v1.1：bloom 降饱和/防溢出、halation 背景增益/色相/冷背景补偿、颗粒三段分带+
 * 类型+乳剂分辨率+noise 模式。所有新参数默认值恒等（见 effectmath 注释约定）。
 * u_mode==3 为 Mask 隔离预览：base=0，只保留 bloom/halation/颗粒/暗角效果层。 */
const FINAL_FS = `precision highp float;
uniform sampler2D u_img, u_graded, u_halT, u_halW, u_blm;
uniform int u_mode;
uniform float u_split;
uniform vec2 u_res;
uniform vec3 u_halTint;                    /* 已含 hue 与 amplify 绿增益（TS 侧算好） */
uniform float u_halTw, u_halWw, u_blmAmt;
uniform float u_halBgGain, u_halBlueComp;
uniform float u_vigAmt, u_vigRad, u_ca;
uniform float u_grainAmp, u_grainSize, u_grainCorr;
uniform float u_grainSh, u_grainMid, u_grainHi, u_grainNoise;
uniform float u_gwC, u_gwM, u_gwF;         /* 颗粒金字塔粗/中/细尺度权重 */
uniform float u_bloomSaveLights, u_bloomSat;
uniform float u_phase;                     /* 颗粒相位：floor(t*24)，24fps 步进 */
uniform float u_grainCluster;              /* R9 扫描颗粒团簇：0=恒等 */
uniform float u_gwAmount, u_gwSpeed, u_gwT;/* R9 片门抖动：amount 比例/speed 相位·秒/t 秒 */
varying vec2 v_uv;
float luma(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }
float hash12(vec2 p, float k){
  vec3 p3 = fract(vec3(p.x, p.y, k)*0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x+p3.y)*p3.z);
}
/* 双线性插值 value noise：颗粒呈絮状而非电视雪花（G1） */
float vnoise(vec2 p, float k){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i,k),             hash12(i+vec2(1.,0.),k), u.x),
             mix(hash12(i+vec2(0.,1.),k), hash12(i+vec2(1.,1.),k), u.x), u.y);
}
void main(){
  if (u_mode==1 || (u_mode==2 && v_uv.x>u_split)){
    gl_FragColor = vec4(texture2D(u_img, v_uv).rgb, 1.0); return;
  }
  /* R9 片门抖动：逐帧位移（amount=0 → 位移恒 0 → 逐位恒等）。等价 effectmath.gateWeaveOffsetPx：
     w = 2π·speed·t；dx = amount·H·sin(w)；dy = amount·H·0.6·sin(w·1.37+1.7)（像素）。
     uv 采样限制在 [0,1] 内，配合 clamp-to-edge 避免抖动把边缘采成黑边。 */
  float gwW = 6.28318531*u_gwSpeed*u_gwT;
  vec2 gwSh = vec2(u_gwAmount*u_res.y*sin(gwW), u_gwAmount*u_res.y*0.6*sin(gwW*1.37+1.7));
  vec2 wuv = clamp(v_uv + gwSh/u_res, 0.0, 1.0);
  vec2 cuv = v_uv - 0.5;
  float len = length(cuv);
  float r = len*1.41421356;                       /* 0 中心 → 1 角落 */
  /* 边缘色散：R 呈像外移 / B 内移（蓝光折向轴内）。R 采样自内侧(−d)、B 采样自外侧(+d)。
     chroma_shift 单位=画面高度比例，0.004 ≈ 1080p 角落 4px（dispPx = shift·H·r²，r² 衰减，V2/V3） */
  float dispPx = u_ca * u_res.y * r * r;
  vec2 dir = len>1e-4 ? cuv/len : vec2(0.0);
  vec2 dOff = dir * dispPx / u_res;
  vec3 base;
  if (u_mode==3) {
    base = vec3(0.0);                             /* Mask 隔离预览：不采样源图/色散，只留效果层 */
  } else {
    base.r = texture2D(u_graded, wuv - dOff).r;
    base.g = texture2D(u_graded, wuv).g;
    base.b = texture2D(u_graded, wuv + dOff).b;
  }
  vec3 bg = base;                                 /* 背景（未叠加效果前）：增益类参数一律按它算 */
  float bgL = luma(bg);
  /* 柔光 bloom：宽域亮部 screen 叠加；先降饱和再按背景亮度防溢出 */
  vec3 blm = texture2D(u_blm, wuv).rgb * u_blmAmt;
  blm = mix(vec3(luma(blm)), blm, u_bloomSat);
  blm *= 1.0 - u_bloomSaveLights*smoothstep(0.75,1.0,bgL);
  base = 1.0-(1.0-base)*(1.0-clamp(blm,0.,1.));
  /* 光晕 halation：紧晕保高光形状 + 宽晕氛围，染橙红后 screen */
  vec3 hal = texture2D(u_halT, wuv).rgb*u_halTw + texture2D(u_halW, wuv).rgb*u_halWw;
  hal = clamp(hal*u_halTint, 0.0, 1.0);
  /* 暗部保护：远场软衰减（晕强 <0.4% 平滑归零→黑区增益<1%），亮部晕不受影响 */
  hal *= smoothstep(0.004, 0.035, max(hal.r, max(hal.g, hal.b)));
  hal *= 1.0-(1.0-u_halBgGain)*smoothstep(0.30,0.85,bgL);        /* background_gain：亮背景压制 */
  hal *= 1.0+u_halBlueComp*0.8*clamp((bg.b-bg.r)/0.35,0.0,1.0);  /* blue_comp：冷背景补偿 */
  base = 1.0-(1.0-base)*(1.0-hal);
  /* 暗角：中心 1.0 不动，向角落平滑加深 */
  base *= 1.0 - u_vigAmt*smoothstep(u_vigRad*0.707-0.35, 1.0, r);
  /* 颗粒：3 尺度金字塔（权重由有效尺寸推导）+ 细色度白噪声；noise 模式改用逐像素白噪声 */
  float px = max(u_res.y*u_grainSize*0.001, 1.25);  /* 颗粒间距（px，≥1.25 防亚像素闪烁） */
  vec2 gp = gl_FragCoord.xy / px;
  float mono;
  if (u_grainNoise > 0.5) {
    mono = (hash12(gp, u_phase)-0.5)*2.0;
  } else {
    float nC = vnoise(gp*0.5, u_phase);               /* 粗 */
    float nM = vnoise(gp,     u_phase+17.13);         /* 中 */
    float nF = vnoise(gp*1.9, u_phase+31.71);         /* 细 */
    mono = (nC*u_gwC + nM*u_gwM + nF*u_gwF - 0.5)*2.1;
  }
  vec3 chr = vec3(hash12(gp*1.7, u_phase+51.7), hash12(gp*1.7, u_phase+67.3), hash12(gp*1.7, u_phase+83.9)) - 0.5;
  vec3 g = mix(chr*0.7, vec3(mono), u_grainCorr);   /* correlation 1=单色 0=每通道独立 */
  /* R9 扫描颗粒团簇：低频噪声（同一套 vnoise，坐标 = 基准颗粒坐标 × 0.18、种子 91.7，
     不受片门抖动影响）调制颗粒幅度（团簇处颗粒更重）。u_grainCluster=0 → gain≡1（逐位恒等）。 */
  float lowN = vnoise(gp*0.18, 91.7);
  float clusterGain = 1.0 + u_grainCluster*(lowN-0.5)*2.0*0.6;
  float l = luma(base);
  /* 亮度三段分区（三段和恒为 1）：0.43 下沿 / 0.85 上沿，各段独立权重 */
  float bSh = 1.0-smoothstep(0.0,0.43,l);
  float bHi = smoothstep(0.43,0.85,l);
  float bMid = 1.0-bSh-bHi;
  float w = bSh*u_grainSh + bMid*u_grainMid + bHi*u_grainHi;
  base += g * u_grainAmp * w * clusterGain;
  gl_FragColor = vec4(clamp(base,0.,1.), 1.0);
}`;

/* ---------------- 工具 ---------------- */

const fractF = (x: number): number => x - Math.floor(x);
/* clamp01/smoothstepF/LUMA_* 已从 effectmath import（单一真源，避免漂移） */
/* 与 shader 同式的 2D hash（CPU 颗粒用） */
function hash12(px: number, py: number, k: number): number {
  let x = fractF(px * 0.1031), y = fractF(py * 0.1031), z = fractF(k * 0.1031);
  const d = x * (y + 33.33) + y * (z + 33.33) + z * (x + 33.33);
  x += d; y += d; z += d;
  return fractF((x + y) * z);
}
function vnoise(px: number, py: number, k: number): number {
  const ix = Math.floor(px), iy = Math.floor(py);
  const fx = px - ix, fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash12(ix, iy, k), b = hash12(ix + 1, iy, k);
  const c = hash12(ix, iy + 1, k), d = hash12(ix + 1, iy + 1, k);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number; }
interface Prog { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null>; }

interface View {
  mode: ViewMode;
  splitX: number;
  halTight: number;
  halWide: number;
}

/* ---------------- EffectRenderer ---------------- */

export class EffectRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private backend: Backend = 'cpu';
  private gl: WebGLRenderingContext | null = null;
  private isGL2 = false;
  private floatFmt: { internal: number; type: number; name: string } = { internal: 0, type: 0, name: 'RGBA8' };
  private ctx2d: CanvasRenderingContext2D | null = null;
  private internalScale = 0.5;
  private rendererInfo = '';
  /* R10-B：质感降分辨率档位（请求值 / 有效值）与选择结果（meta 用） */
  private rtScaleRequested: RtScale = DEFAULT_RT_SCALE;
  private rtScale: RtScale = DEFAULT_RT_SCALE;
  private qualityInfo: QualityInfo = {
    rtScale: DEFAULT_RT_SCALE, bloomScale: DEFAULT_RT_SCALE / 2,
    requested: DEFAULT_RT_SCALE, degraded: false, reason: 'uninitialized',
  };

  private params: FilmParams = defaultParams();
  private view: View = { mode: 0, splitX: 0.5, halTight: 1, halWide: 1 };
  private gradeDirty = true;
  private chainDirty = true;
  private finalDirty = true;
  private lastPhase = -1;
  private renderTime = 0;   /* 最近一次 render(t) 的秒数（R9 片门抖动相位用；freeze 时调用方传定值） */

  /* LUT 纹理（【MVP 整合增量改动②】） */
  private lutData: LutData | null = null;      // 当前生效的 LUT 数据（按引用比较免重传）
  private lutUploaded: LutData | null = null;  // 已上传到 GPU 的那份
  private lutTex: WebGLTexture | null = null;
  private blackTex: WebGLTexture | null = null; // 无 LUT 时的占位纹理

  /* R17：GPU tile-atlas 烘焙器（动态 import 惰性创建；baker 与本渲染器共享同一 GL 上下文） */
  private gpuBaker: import('./gpubake').GpuBaker | null = null;
  private gpuBakerPromise: Promise<import('./gpubake').GpuBaker | null> | null = null;

  /* GL 资源 */
  private progs: Record<string, Prog> = {};
  private vb: WebGLBuffer | null = null;
  private imgTex: WebGLTexture | null = null;
  private tGrade: Target | null = null;
  private tHalT1: Target | null = null; private tHalT2: Target | null = null;
  private tHalW1: Target | null = null; private tHalW2: Target | null = null;
  private tBlm1: Target | null = null; private tBlm2: Target | null = null;
  private srcW = 0; private srcH = 0;

  /* CPU 资源 */
  private cpuSrc: Uint8ClampedArray | null = null;
  private cpuGraded: Uint8ClampedArray | null = null;
  private cpuHalT: Float32Array | null = null;
  private cpuHalW: Float32Array | null = null;
  private cpuBlm: Float32Array | null = null;
  private cpuDim = { w: 0, h: 0, hw4: 0, hh4: 0, hw8: 0, hh8: 0 };
  private cpuWork: HTMLCanvasElement | null = null;
  private cpuOutCv: HTMLCanvasElement | null = null;

  /** 后端标签（UI 显示用） */
  backendLabel(): string {
    if (this.backend === 'cpu') {
      return `CPU 软件渲染（无 WebGL）· 内部精度 ${Math.round(this.internalScale * 100)}%`;
    }
    return `${this.isGL2 ? 'WebGL2' : 'WebGL1'} · ${this.floatFmt.name}${this.rendererInfo ? ' | ' + this.rendererInfo : ''} · ${qualityLabel(this.qualityInfo)}`;
  }
  /** R10-B 质感降分辨率质量档（meta / 面板展示；含降级原因） */
  get quality(): QualityInfo { return this.qualityInfo; }
  get backendKind(): Backend { return this.backend; }
  get size(): { w: number; h: number } { return { w: this.srcW, h: this.srcH }; }

  /* ================= R17：GPU tile-atlas LUT 烘焙（回退链第一级） =================
   * 能力：WebGL2 + EXT_color_buffer_float + float FBO + readPixels(FLOAT)（细探测在 gpubake 内）。
   * 任一不满足 / 烘焙失败 / readPixels 异常 → 返回 null，调用方回退 worker/CPU 路径（行为不变）。
   * meta 口径：gpuBakeFormat 非空 = GPU 烘焙可用（E2E 断言用）。 */
  get gpuBakeFormat(): string | null { return this.gpuBaker ? this.gpuBaker.format : null; }
  async bakeLutAtlas(req: LutBakeRequest): Promise<LutData | null> {
    if (this.backend !== 'webgl2' || !this.canvas) return null;
    /* R18 护栏：gpubake 的 BAKE_FS look 镜像（R17 冻结）未覆盖「非默认串扰系数 / HSL」两个
     * 新维度——配方带这两个维度时回退 worker/CPU 烘焙（走 lookTransform，结果正确且可观察）；
     * 默认配方（无 coupling/hsl 或全默认）GPU 路径与 R17 逐位一致。 */
    if (req.look && (!couplingIsDefault(req.look.coupling) || !hslIsIdentity(req.look.hsl))) return null;
    try {
      if (!this.gpuBakerPromise) {
        this.gpuBakerPromise = import('./gpubake').then((m) => {
          this.gpuBaker = m.createGpuBaker(this.canvas!);
          return this.gpuBaker;
        });
      }
      const baker = await this.gpuBakerPromise;
      if (!baker) return null;
      const r = baker.bake(req);
      return r ? { size: r.size, table: r.table } : null;
    } catch {
      return null;   // 任何异常 → 回退 worker/CPU
    }
  }

  /** 协商后端并构建管线。WebGL2 → WebGL1 → CPU */
  init(canvas: HTMLCanvasElement, opts?: RenderInitOpts): void {
    this.canvas = canvas;
    this.internalScale = Math.min(1, Math.max(0.25, opts?.internalScale ?? 0.5));
    this.rtScaleRequested = normalizeRtScale(opts?.rtScale ?? DEFAULT_RT_SCALE);
    const attrs: WebGLContextAttributes = { antialias: false, preserveDrawingBuffer: true };
    let gl: WebGL2RenderingContext | WebGLRenderingContext | null =
      canvas.getContext('webgl2', attrs) as WebGL2RenderingContext | null;
    this.isGL2 = !!gl;
    if (!gl) gl = (canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs)) as WebGLRenderingContext | null;
    if (gl) {
      this.gl = gl as WebGLRenderingContext;
      this.backend = this.isGL2 ? 'webgl2' : 'webgl1';
      this.ctx2d = null;
      this.initGL();
    } else {
      this.gl = null;
      this.backend = 'cpu';
      this.ctx2d = canvas.getContext('2d');
      if (!this.ctx2d) throw new Error('EffectRenderer: WebGL 与 Canvas2D 均不可用');
      /* CPU 后端不走 GL 降分辨率 RT 路径（其内部有独立的 internalScale 下采样） */
      this.rtScale = 1;
      this.qualityInfo = selectQuality({
        backend: 'cpu', requested: this.rtScaleRequested, reducedFboComplete: false, floatRenderTarget: false,
      });
    }
  }

  dispose(): void {
    const gl = this.gl;
    if (gl) {
      for (const k of Object.keys(this.progs)) gl.deleteProgram(this.progs[k].p);
      this.progs = {};
      if (this.vb) gl.deleteBuffer(this.vb);
      if (this.imgTex) gl.deleteTexture(this.imgTex);
      for (const t of [this.tGrade, this.tHalT1, this.tHalT2, this.tHalW1, this.tHalW2, this.tBlm1, this.tBlm2]) {
        if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
      }
      if (this.lutTex) gl.deleteTexture(this.lutTex);
      if (this.blackTex) gl.deleteTexture(this.blackTex);
      this.tGrade = this.tHalT1 = this.tHalT2 = this.tHalW1 = this.tHalW2 = this.tBlm1 = this.tBlm2 = null;
      this.imgTex = null; this.vb = null;
      this.lutTex = this.blackTex = null;
      this.lutData = this.lutUploaded = null;
    }
    /* R17：GPU 烘焙器共享同一上下文，随渲染器一并释放 */
    if (this.gpuBaker) { try { this.gpuBaker.dispose(); } catch { /* ignore */ } }
    this.gpuBaker = null;
    this.gpuBakerPromise = null;
    this.cpuSrc = this.cpuGraded = this.cpuHalT = this.cpuHalW = this.cpuBlm = null;
    this.cpuWork = this.cpuOutCv = null;
    this.canvas = null; this.gl = null; this.ctx2d = null;
    this.srcW = this.srcH = 0;
  }

  /** 载入源帧（img / canvas / ImageBitmap）。长边超过 2560 会内部降采样 */
  setSource(src: HTMLImageElement | HTMLCanvasElement | ImageBitmap): void {
    if (!this.canvas) throw new Error('EffectRenderer: 未 init');
    let w = src.width, h = src.height;
    const cap = 2560;
    let draw: HTMLImageElement | HTMLCanvasElement | ImageBitmap = src;
    if (Math.max(w, h) > cap) {
      const s = cap / Math.max(w, h);
      w = Math.round(w * s); h = Math.round(h * s);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d')!.drawImage(src as CanvasImageSource, 0, 0, w, h);
      draw = cv;
    }
    this.srcW = w; this.srcH = h;
    this.canvas.width = w; this.canvas.height = h;
    if (this.gl) {
      const gl = this.gl;
      if (!this.imgTex) this.imgTex = gl.createTexture();
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, draw as TexImageSource);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      this.allocTargets(w, h);
    } else {
      this.cpuSetSource(draw, w, h);
    }
    this.gradeDirty = this.chainDirty = this.finalDirty = true;
  }

  /** 记录参数与查看选项，标记脏；render(t) 时按需重算 */
  apply(params: FilmParams, opts?: RenderOpts): void {
    this.params = cloneParams(params);
    if (opts) {
      if (opts.master !== undefined && isFinite(opts.master)) this.params.master = Math.max(0, opts.master);
      if (opts.mode !== undefined) this.view.mode = opts.mode;
      if (opts.splitX !== undefined) this.view.splitX = Math.min(1, Math.max(0, opts.splitX));
      if (opts.halationTight !== undefined) this.view.halTight = opts.halationTight;
      if (opts.halationWide !== undefined) this.view.halWide = opts.halationWide;
      if (opts.lut !== undefined) {
        const lut = opts.lut;
        const ok = !!lut && lut.size >= 2 && lut.table.length === lut.size * lut.size * lut.size * 3;
        this.lutData = ok ? { size: lut.size, table: lut.table } : null;
        if (!ok && lut) console.warn('EffectRenderer: LUT 数据尺寸不符，已忽略');
      }
    }
    this.gradeDirty = this.chainDirty = this.finalDirty = true;
  }

  /** 渲染一帧。t 为秒；颗粒相位按 24fps 步进。返回是否真正绘制（供 FPS 打点） */
  render(t: number): boolean {
    if (!this.srcW || !this.canvas) return false;
    const phase = Math.floor(t * 24);
    this.renderTime = isFinite(t) ? t : 0;
    if (this.gradeDirty) { this.runGradeDispatch(); this.gradeDirty = false; this.chainDirty = true; }
    if (this.chainDirty) { this.runChainsDispatch(); this.chainDirty = false; this.finalDirty = true; }
    if (this.finalDirty || phase !== this.lastPhase) {
      this.runFinalDispatch(phase);
      this.finalDirty = false;
      this.lastPhase = phase;
      return true;
    }
    return false;
  }

  /* ================= GL 路径 ================= */

  private compile(vs: string, fs: string): Prog {
    const gl = this.gl!;
    const p = gl.createProgram()!;
    for (const [t, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
      const s = gl.createShader(t)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error('shader: ' + gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.bindAttribLocation(p, 0, 'a_pos');   // GLSL 1.00 无 layout(location)，链接前绑定
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    const u: Record<string, WebGLUniformLocation | null> = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i)!;
      u[info.name.replace('[0]', '')] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  private initGL(): void {
    const gl = this.gl!;
    /* 浮点 FBO 能力探测（16F 减少暗部条带；不可用则 RGBA8） */
    this.floatFmt = { internal: gl.RGBA, type: gl.UNSIGNED_BYTE, name: 'RGBA8' };
    if (this.isGL2 && gl.getExtension('EXT_color_buffer_float')) {
      try {
        const t = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, (gl as WebGL2RenderingContext).RGBA16F, 4, 4, 0, gl.RGBA, (gl as WebGL2RenderingContext).HALF_FLOAT, null);
        const f = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, f);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE)
          this.floatFmt = { internal: (gl as WebGL2RenderingContext).RGBA16F, type: (gl as WebGL2RenderingContext).HALF_FLOAT, name: 'RGBA16F' };
        gl.deleteFramebuffer(f); gl.deleteTexture(t);
      } catch { /* 保持 RGBA8 */ }
    }
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    this.rendererInfo = ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)).slice(0, 40)
      : '';

    /* R10-B：探测降分辨率离屏 RT 是否可用（固定 256×144，与源尺寸无关）。
     * 探测失败 → selectQuality 退回全分辨率（rtScale=1）并记录原因，保证 WebGL1/异常驱动可出图。 */
    const reducedOk = this.probeReducedRt(256, 144);
    this.qualityInfo = selectQuality({
      backend: this.backend,
      requested: this.rtScaleRequested,
      reducedFboComplete: reducedOk,
      floatRenderTarget: this.floatFmt.name !== 'RGBA8',
    });
    this.rtScale = this.qualityInfo.rtScale;

    this.progs.grade = this.compile(VERT, GRADE_FS);
    this.progs.bright = this.compile(VERT, BRIGHT_FS);
    this.progs.blur = this.compile(VERT, BLUR_FS);
    this.progs.final = this.compile(VERT, FINAL_FS);

    /* 全屏三角形 */
    this.vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    /* 无 LUT 占位纹理（1×1 黑，保证 u_lut 绑定合法） */
    this.blackTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.blackTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** R10-B：探测能否在给定（降分辨率）尺寸上建立完整 FBO（用与正式 RT 相同的格式/类型）。
   *  只做分配 + 完整性检查，不渲染；失败/异常一律返回 false → 上层退回全分辨率。 */
  private probeReducedRt(w: number, h: number): boolean {
    const gl = this.gl;
    if (!gl) return false;
    let tex: WebGLTexture | null = null;
    let fbo: WebGLFramebuffer | null = null;
    try {
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, this.floatFmt.internal, w, h, 0, gl.RGBA, this.floatFmt.type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return ok;
    } catch {
      return false;
    } finally {
      if (fbo) gl.deleteFramebuffer(fbo);
      if (tex) gl.deleteTexture(tex);
    }
  }

  /* 上传 LUT atlas（x = b*n + r，y = g；RGBA8 量化对预览足够，导出走 CPU 表）。
   * 引擎表布局 index=((b*n+g)*n+r)*3：显式写入 atlas 像素 (g*n² + b*n + r) 与 shader 一致。 */
  private uploadLut(lut: LutData): void {
    const gl = this.gl!;
    const n = lut.size;
    const rgba = new Uint8Array(n * n * n * 4);
    const t = lut.table;
    const rowPx = n * n; // atlas 每行像素数
    for (let b = 0; b < n; b++) {
      for (let g = 0; g < n; g++) {
        let j = (b * n + g) * n * 3;
        for (let r = 0; r < n; r++) {
          const q = (g * rowPx + b * n + r) * 4;
          rgba[q] = Math.round(Math.min(255, Math.max(0, t[j] * 255)));
          rgba[q + 1] = Math.round(Math.min(255, Math.max(0, t[j + 1] * 255)));
          rgba[q + 2] = Math.round(Math.min(255, Math.max(0, t[j + 2] * 255)));
          rgba[q + 3] = 255;
          j += 3;
        }
      }
    }
    if (!this.lutTex) this.lutTex = gl.createTexture();
    // 关键：在 u_lut 的纹理单元（5）上绑定/上传，避免覆盖当前活动单元上的 u_tex
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n * n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.lutUploaded = lut;
  }

  private makeTarget(w: number, h: number): Target {
    const gl = this.gl!;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.floatFmt.internal, w, h, 0, gl.RGBA, this.floatFmt.type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h };
  }

  private allocTargets(w: number, h: number): void {
    const gl = this.gl!;
    for (const t of [this.tGrade, this.tHalT1, this.tHalT2, this.tHalW1, this.tHalW2, this.tBlm1, this.tBlm2]) {
      if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    }
    this.tGrade = this.makeTarget(w, h);
    /* R10-B：光晕链走 1/4 RT、柔光链走 1/8 RT（默认 rtScale=0.25 → 与既有档位逐像素一致）；
     * 探测失败时 rtScale=1 → 全分辨率兜底。 */
    const w4 = Math.max(1, Math.floor(w * this.rtScale)), h4 = Math.max(1, Math.floor(h * this.rtScale));
    const w8 = Math.max(1, Math.floor(w * this.rtScale / 2)), h8 = Math.max(1, Math.floor(h * this.rtScale / 2));
    this.tHalT1 = this.makeTarget(w4, h4); this.tHalT2 = this.makeTarget(w4, h4);
    this.tHalW1 = this.makeTarget(w4, h4); this.tHalW2 = this.makeTarget(w4, h4);
    this.tBlm1 = this.makeTarget(w8, h8); this.tBlm2 = this.makeTarget(w8, h8);
  }

  private setTexUnit(prog: Prog, name: string, unit: number, tex: WebGLTexture): void {
    const gl = this.gl!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(prog.u[name]!, unit);
  }

  private drawTriangle(): void { this.gl!.drawArrays(this.gl!.TRIANGLES, 0, 3); }

  /* 横+纵两趟高斯，src→dstA（dstB 为乒乓） */
  private blurChain(src: Target, dstA: Target, dstB: Target, radiusTex: number): void {
    const gl = this.gl!;
    const sigma = Math.min(radiusTex / 2, 16);
    const R = Math.max(1, Math.min(40, Math.ceil(sigma * 2.5)));
    const pr = this.progs.blur;
    gl.useProgram(pr.p);
    gl.uniform1f(pr.u['u_sigma'], sigma);
    gl.uniform1f(pr.u['u_R'], R);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstB.fbo);
    gl.viewport(0, 0, dstB.w, dstB.h);
    this.setTexUnit(pr, 'u_tex', 0, src.tex);
    gl.uniform2f(pr.u['u_dir'], 1 / src.w, 0);
    this.drawTriangle();
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstA.fbo);
    gl.viewport(0, 0, dstA.w, dstA.h);
    this.setTexUnit(pr, 'u_tex', 0, dstB.tex);
    gl.uniform2f(pr.u['u_dir'], 0, 1 / dstA.h);
    this.drawTriangle();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private clearTarget(t: Target): void {
    const gl = this.gl!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private runGrade(): void {
    const gl = this.gl!;
    const t = this.tGrade!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.w, t.h);
    const pr = this.progs.grade;
    gl.useProgram(pr.p);
    this.setTexUnit(pr, 'u_tex', 0, this.imgTex!);
    if (this.lutData) {
      if (this.lutUploaded !== this.lutData) this.uploadLut(this.lutData);
      this.setTexUnit(pr, 'u_lut', 5, this.lutTex!);
      gl.uniform1f(pr.u['u_useLut'], 1);
      gl.uniform1f(pr.u['u_lutN'], this.lutData.size);
    } else {
      this.setTexUnit(pr, 'u_lut', 5, this.blackTex!);
      gl.uniform1f(pr.u['u_useLut'], 0);
      gl.uniform1f(pr.u['u_lutN'], 2);
    }
    /* R10：LUT 只含匹配；look 始终由 shader 计算（uniform 更新即零烘焙） */
    const L = this.params.look;
    gl.uniform1f(pr.u['u_fade'], L.fade);
    gl.uniform1f(pr.u['u_black'], L.black_lift);
    gl.uniform1f(pr.u['u_coupling'], L.dye_coupling);
    gl.uniform1f(pr.u['u_shBias'], L.shadow_bias);
    gl.uniform1f(pr.u['u_hiBias'], L.highlight_bias);
    gl.uniform1f(pr.u['u_sat'], L.saturation);
    gl.uniform1f(pr.u['u_filmS'], L.film_s);
    gl.uniform1f(pr.u['u_contrast'], L.contrast);
    gl.uniform1f(pr.u['u_warm'], L.warmth);
    /* Schema v1.2 分离色调（默认 0 → GLSL 贡献为 0，逐位恒等） */
    gl.uniform1f(pr.u['u_spShHue'], L.split_shadow_hue ?? 0);
    gl.uniform1f(pr.u['u_spShSat'], L.split_shadow_sat ?? 0);
    gl.uniform1f(pr.u['u_spHiHue'], L.split_highlight_hue ?? 0);
    gl.uniform1f(pr.u['u_spHiSat'], L.split_highlight_sat ?? 0);
    gl.uniform1f(pr.u['u_spBal'], L.split_balance ?? 0);
    /* R18：串扰六系数（缺省 = 历史固定矩阵 → 与 R17 前逐位一致）+ HSL 8 色相（缺省/全 0 → 跳过） */
    const C = L.coupling;
    gl.uniform1f(pr.u['u_cRg'], C?.rg ?? DEFAULT_COUPLING.rg);
    gl.uniform1f(pr.u['u_cRb'], C?.rb ?? DEFAULT_COUPLING.rb);
    gl.uniform1f(pr.u['u_cGr'], C?.gr ?? DEFAULT_COUPLING.gr);
    gl.uniform1f(pr.u['u_cGb'], C?.gb ?? DEFAULT_COUPLING.gb);
    gl.uniform1f(pr.u['u_cBr'], C?.br ?? DEFAULT_COUPLING.br);
    gl.uniform1f(pr.u['u_cBg'], C?.bg ?? DEFAULT_COUPLING.bg);
    gl.uniform3fv(pr.u['u_hsl'], hslUniforms(L.hsl));
    /* 防 banding dither：仅 noise 颗粒模式启用（默认 0 → 恒等） */
    gl.uniform2f(pr.u['u_gres'], t.w, t.h);
    gl.uniform1f(pr.u['u_dither'], this.params.texture.grain.mode === 'noise' ? 1 / 255 : 0);
    gl.uniform1f(pr.u['u_ditherSeed'], DITHER_SEED);
    this.drawTriangle();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private runChains(): void {
    const gl = this.gl!;
    const m = this.params.master;
    const graded = this.tGrade!;
    /* halation：紧晕（w¹）与宽晕（w² 预乘→密度随亮度非线性）两条 ¼ 分辨率链 */
    const h = this.params.texture.halation;
    const halOn = h.enabled && h.amount > 0.001;
    if (halOn) {
      this.brightPass(graded, this.tHalT1!, h.threshold, 1, 1);
      this.brightPass(graded, this.tHalW1!, h.threshold, 2, 1);
      const scale = this.srcH / 100;
      /* 半径按 RT 比例折算：全分辨率像素半径 × rtScale = 降分辨率 RT 上的纹素半径
       * （默认 rtScale=0.25 → ÷4，与既有 1/4 RT 档位逐位一致） */
      const rs = this.rtScale;
      this.blurChain(this.tHalT1!, this.tHalT1!, this.tHalT2!, Math.max(0.5, TIGHT_RADIUS_H * scale * rs * m));
      /* 宽晕半径：amplify 抬高散射尺度、smoothness 做大区域柔光（默认 1/0.5 恒等） */
      this.blurChain(this.tHalW1!, this.tHalW1!, this.tHalW2!, Math.max(0.5, halationRadiusEff(h.radius, h.amplify, h.smoothness) * scale * rs * m));
    } else {
      this.clearTarget(this.tHalT1!); this.clearTarget(this.tHalW1!);
    }
    /* bloom：⅛ 分辨率，按亮度触发 */
    const b = this.params.texture.bloom;
    const blmOn = b.enabled && b.amount > 0.001;
    if (blmOn) {
      this.brightPass(graded, this.tBlm1!, b.threshold, 1, 0);
      /* 半径：details 高=细节（收窄），低=大范围柔光（默认 0.5 恒等） */
      this.blurChain(this.tBlm1!, this.tBlm1!, this.tBlm2!, Math.max(0.5, bloomRadiusEff(b.radius, b.details) * this.srcH / 100 * (this.rtScale / 2) * m));
    } else {
      this.clearTarget(this.tBlm1!);
    }
  }

  private brightPass(src: Target, dst: Target, thresh: number, pow: number, maxch: number): void {
    const gl = this.gl!;
    const pr = this.progs.bright;
    gl.useProgram(pr.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.w, dst.h);
    this.setTexUnit(pr, 'u_tex', 0, src.tex);
    gl.uniform1f(pr.u['u_thresh'], thresh);
    gl.uniform1f(pr.u['u_pow'], pow);
    gl.uniform1i(pr.u['u_maxch'], maxch);
    this.drawTriangle();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private runFinal(phase: number): void {
    const gl = this.gl!;
    const canvas = this.canvas!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    const pr = this.progs.final;
    gl.useProgram(pr.p);
    this.setTexUnit(pr, 'u_img', 0, this.imgTex!);
    this.setTexUnit(pr, 'u_graded', 1, this.tGrade!.tex);
    this.setTexUnit(pr, 'u_halT', 2, this.tHalT1!.tex);
    this.setTexUnit(pr, 'u_halW', 3, this.tHalW1!.tex);
    this.setTexUnit(pr, 'u_blm', 4, this.tBlm1!.tex);
    const m = this.params.master;
    const h = this.params.texture.halation;
    const b = this.params.texture.bloom;
    const v = this.params.texture.vignette;
    const g = this.params.texture.grain;
    gl.uniform1i(pr.u['u_mode'], this.view.mode);
    gl.uniform1f(pr.u['u_split'], this.view.splitX);
    gl.uniform2f(pr.u['u_res'], this.srcW, this.srcH);
    /* tint：hue 调绿层灵敏度、amplify 再抬绿增益，均在 TS 侧算好（默认 0.5/1 恒等） */
    const tint = halationHueTint(h.tint_rgb, h.hue);
    tint[1] *= halationAmplifyTintGain(h.amplify);
    gl.uniform3f(pr.u['u_halTint'], tint[0], tint[1], tint[2]);
    const halOn = h.enabled && h.amount > 0.001;
    /* 紧/宽权重由 halationWeights 统一分配：amplify 只改配比不改不透明度，impact 控制整体 */
    const hw = halationWeights(h.amount, m, h.impact, h.amplify, h.smoothness);
    gl.uniform1f(pr.u['u_halTw'], halOn ? hw.tight * this.view.halTight : 0);
    gl.uniform1f(pr.u['u_halWw'], halOn ? hw.wide * this.view.halWide : 0);
    gl.uniform1f(pr.u['u_halBgGain'], h.background_gain);
    gl.uniform1f(pr.u['u_halBlueComp'], h.blue_comp);
    gl.uniform1f(pr.u['u_blmAmt'], b.enabled ? b.amount * m : 0);
    gl.uniform1f(pr.u['u_bloomSaveLights'], b.save_lights);
    gl.uniform1f(pr.u['u_bloomSat'], b.saturation);
    gl.uniform1f(pr.u['u_vigAmt'], v.enabled ? Math.min(1, v.amount * m) : 0);
    gl.uniform1f(pr.u['u_vigRad'], v.radius);
    gl.uniform1f(pr.u['u_ca'], v.enabled ? v.chroma_shift : 0);
    /* 颗粒：幅度含乳剂分辨率微调；间距/金字塔权重由有效尺寸推导（film_resolution=0.5 恒等） */
    const tg = grainTypeGains(g.type);
    gl.uniform1f(pr.u['u_grainAmp'], g.enabled ? GRAIN_BASE * Math.sqrt(g.iso / 400) * m * grainResolutionAmp(g.film_resolution) : 0);
    const sizeEff = grainSizeEff(g.size, g.film_resolution);
    gl.uniform1f(pr.u['u_grainSize'], sizeEff);
    gl.uniform1f(pr.u['u_grainCorr'], g.correlation);
    gl.uniform1f(pr.u['u_grainSh'], g.shadow * (1 + g.shadow_weight * 1.2) * tg.shadow);
    gl.uniform1f(pr.u['u_grainMid'], g.midtone);
    gl.uniform1f(pr.u['u_grainHi'], g.highlight * tg.highlight);
    gl.uniform1f(pr.u['u_grainNoise'], g.mode === 'noise' ? 1 : 0);
    const gw = grainScaleWeights(sizeEff, g.film_resolution);
    gl.uniform1f(pr.u['u_gwC'], gw.coarse);
    gl.uniform1f(pr.u['u_gwM'], gw.mid);
    gl.uniform1f(pr.u['u_gwF'], gw.fine);
    gl.uniform1f(pr.u['u_phase'], phase);
    /* R9：扫描颗粒团簇（0=恒等）+ 片门抖动（amount=0 → 位移恒 0，逐位恒等；t 复用冻结时间） */
    gl.uniform1f(pr.u['u_grainCluster'], g.cluster ?? 0);
    const gwave = this.params.texture.gate_weave;
    gl.uniform1f(pr.u['u_gwAmount'], gwave.amount);
    gl.uniform1f(pr.u['u_gwSpeed'], gwave.speed);
    gl.uniform1f(pr.u['u_gwT'], this.renderTime);
    this.drawTriangle();
  }

  /* ================= CPU 路径（无 WebGL 时逐像素镜像 shader 数学） ================= */

  private cpuAlloc(w: number, h: number): void {
    const W = Math.max(2, Math.round(w * this.internalScale));
    const H = Math.max(2, Math.round(h * this.internalScale));
    this.cpuDim = { w: W, h: H, hw4: Math.max(1, W >> 2), hh4: Math.max(1, H >> 2), hw8: Math.max(1, W >> 3), hh8: Math.max(1, H >> 3) };
    const d = this.cpuDim;
    this.cpuGraded = new Uint8ClampedArray(d.w * d.h * 4);
    this.cpuHalT = new Float32Array(d.hw4 * d.hh4 * 3);
    this.cpuHalW = new Float32Array(d.hw4 * d.hh4 * 3);
    this.cpuBlm = new Float32Array(d.hw8 * d.hh8 * 3);
    if (!this.cpuWork) {
      this.cpuWork = document.createElement('canvas');
      this.cpuWork.getContext('2d', { willReadFrequently: true });
    }
    if (!this.cpuOutCv) this.cpuOutCv = document.createElement('canvas');
    this.cpuWork.width = W; this.cpuWork.height = H;
    this.cpuOutCv.width = W; this.cpuOutCv.height = H;
  }

  private cpuSetSource(src: HTMLImageElement | HTMLCanvasElement | ImageBitmap, w: number, h: number): void {
    this.cpuAlloc(w, h);
    const d = this.cpuDim;
    const ctx = this.cpuWork!.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(src as CanvasImageSource, 0, 0, d.w, d.h);
    this.cpuSrc = ctx.getImageData(0, 0, d.w, d.h).data;
  }

  /* R10：look 的 TS 实现不再内联在此 —— CPU 后端直接调用 engine/look.lookTransform，
     与 GLSL（GRADE_FS look 段）同源，杜绝两份数学漂移。 */

  private runGradeCPU(): void {
    const d = this.cpuDim;
    const src = this.cpuSrc!, g = this.cpuGraded!;
    /* 防 banding dither（仅 noise 颗粒模式；与 GRADE_FS 同式，默认恒等） */
    const dither = this.params.texture.grain.mode === 'noise' ? 1 / 255 : 0;
    /* R10：look 数学与 shader 同源 —— 直接调用 engine/look.lookTransform（单一真源）。
     * LUT 只含匹配：先采样匹配 LUT（若有），再叠加 look，与 GRADE_FS 顺序一致。 */
    const lookFn = lookTransform(this.params.look as unknown as EngineLookParams);
    const lut = this.lutData ? { size: this.lutData.size, table: this.lutData.table } : null;
    const rgb: [number, number, number] = [0, 0, 0];
    for (let i = 0, p = 0; i < d.w * d.h; i++, p += 4) {
      let r = src[p] / 255, gg = src[p + 1] / 255, b = src[p + 2] / 255;
      if (lut) {
        rgb[0] = r; rgb[1] = gg; rgb[2] = b;
        const o = applyLUT(lut, rgb);
        r = o[0]; gg = o[1]; b = o[2];
      }
      rgb[0] = r; rgb[1] = gg; rgb[2] = b;
      const lo = lookFn(rgb);
      r = lo[0]; gg = lo[1]; b = lo[2];
      if (dither) {
        /* v_uv*u_gres 在内部渲染分辨率下即像素坐标（x,y） */
        const n = (hash12(i % d.w, Math.floor(i / d.w), DITHER_SEED) - 0.5) * dither;
        r += n; gg += n; b += n;
      }
      g[p] = r * 255; g[p + 1] = gg * 255; g[p + 2] = b * 255; g[p + 3] = 255;
    }
  }

  /* CPU 分离高斯（3 通道，Float32 Interleaved），sigma/R 与 GL 一致 */
  private static blurSep(buf: Float32Array, w: number, h: number, radiusTex: number): void {
    const sigma = Math.min(radiusTex / 2, 16);
    const R = Math.max(1, Math.min(40, Math.ceil(sigma * 2.5)));
    const wgt = new Float32Array(2 * R + 1);
    let sum = 0;
    for (let i = -R; i <= R; i++) { const v = Math.exp(-i * i / (2 * sigma * sigma)); wgt[i + R] = v; sum += v; }
    for (let i = 0; i < wgt.length; i++) wgt[i] /= sum;
    const tmp = new Float32Array(buf.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let a0 = 0, a1 = 0, a2 = 0;
      for (let i = -R; i <= R; i++) {
        const xx = x + i < 0 ? 0 : x + i > w - 1 ? w - 1 : x + i;
        const p = (y * w + xx) * 3;
        const v = wgt[i + R]; a0 += buf[p] * v; a1 += buf[p + 1] * v; a2 += buf[p + 2] * v;
      }
      const q = (y * w + x) * 3; tmp[q] = a0; tmp[q + 1] = a1; tmp[q + 2] = a2;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let a0 = 0, a1 = 0, a2 = 0;
      for (let i = -R; i <= R; i++) {
        const yy = y + i < 0 ? 0 : y + i > h - 1 ? h - 1 : y + i;
        const p = (yy * w + x) * 3;
        const v = wgt[i + R]; a0 += tmp[p] * v; a1 += tmp[p + 1] * v; a2 += tmp[p + 2] * v;
      }
      const q = (y * w + x) * 3; buf[q] = a0; buf[q + 1] = a1; buf[q + 2] = a2;
    }
  }

  /* CPU 亮通（降采样到 ¼/⅛），powK：1=紧晕 2=宽晕；useMax：最大通道提取 */
  private static bright(src: Uint8ClampedArray, w: number, h: number, dst: Float32Array, dw: number, dh: number, thresh: number, powK: number, useMax: boolean): void {
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(h - 1, Math.round(y * h / dh));
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(w - 1, Math.round(x * w / dw));
        const p = (sy * w + sx) * 4, q = (y * dw + x) * 3;
        const r = src[p] / 255, g = src[p + 1] / 255, b = src[p + 2] / 255;
        const v = useMax ? Math.max(r, g, b) : LUMA_R * r + LUMA_G * g + LUMA_B * b;
        const wt = Math.pow(smoothstepF(thresh, 1, v), powK);
        dst[q] = r * wt; dst[q + 1] = g * wt; dst[q + 2] = b * wt;
      }
    }
  }

  private runChainsCPU(): void {
    const d = this.cpuDim;
    const m = this.params.master;
    const h = this.params.texture.halation;
    const halOn = h.enabled && h.amount > 0.001;
    if (halOn) {
      EffectRenderer.bright(this.cpuGraded!, d.w, d.h, this.cpuHalT!, d.hw4, d.hh4, h.threshold, 1, true);
      EffectRenderer.bright(this.cpuGraded!, d.w, d.h, this.cpuHalW!, d.hw4, d.hh4, h.threshold, 2, true);
      const scale = this.srcH / 100;
      EffectRenderer.blurSep(this.cpuHalT!, d.hw4, d.hh4, Math.max(0.5, TIGHT_RADIUS_H * scale / 4 * m));
      EffectRenderer.blurSep(this.cpuHalW!, d.hw4, d.hh4, Math.max(0.5, halationRadiusEff(h.radius, h.amplify, h.smoothness) * scale / 4 * m));
    } else { this.cpuHalT!.fill(0); this.cpuHalW!.fill(0); }
    const b = this.params.texture.bloom;
    if (b.enabled && b.amount > 0.001) {
      EffectRenderer.bright(this.cpuGraded!, d.w, d.h, this.cpuBlm!, d.hw8, d.hh8, b.threshold, 1, false);
      EffectRenderer.blurSep(this.cpuBlm!, d.hw8, d.hh8, Math.max(0.5, bloomRadiusEff(b.radius, b.details) * this.srcH / 100 / 8 * m));
    } else this.cpuBlm!.fill(0);
  }

  /* 双线性采样（RGBA 缓存 stride=4 / Float ×3 缓存 stride=3） */
  private static sample3(buf: Float32Array | Uint8ClampedArray, w: number, h: number, stride: number, x: number, y: number, out: number[]): void {
    x = Math.min(w - 1, Math.max(0, x)); y = Math.min(h - 1, Math.max(0, y));
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    for (let c = 0; c < 3; c++) {
      const p00 = (y0 * w + x0) * stride + c, p10 = (y0 * w + x1) * stride + c;
      const p01 = (y1 * w + x0) * stride + c, p11 = (y1 * w + x1) * stride + c;
      out[c] = buf[p00] * (1 - fx) * (1 - fy) + buf[p10] * fx * (1 - fy) + buf[p01] * (1 - fx) * fy + buf[p11] * fx * fy;
    }
  }

  private runFinalCPU(phase: number): void {
    const d = this.cpuDim;
    const W = d.w, H = d.h;
    const out = this.cpuOutCv!.getContext('2d')!;
    const img = out.createImageData(W, H);
    const od = img.data;
    const srcData = this.cpuSrc!;
    const m = this.params.master;
    const h = this.params.texture.halation, b = this.params.texture.bloom;
    const v = this.params.texture.vignette, gr = this.params.texture.grain;
    const halOn = h.enabled && h.amount > 0.001;
    /* 紧/宽权重与 tint 交给 effectmath 统一（与 GL runFinal 同式；默认恒等） */
    const hw = halationWeights(h.amount, m, h.impact, h.amplify, h.smoothness);
    const halTw = halOn ? hw.tight * this.view.halTight : 0;
    const halWw = halOn ? hw.wide * this.view.halWide : 0;
    const tint = halationHueTint(h.tint_rgb, h.hue);
    tint[1] *= halationAmplifyTintGain(h.amplify);
    const blmAmt = b.enabled ? b.amount * m : 0;
    const vigAmt = v.enabled ? Math.min(1, v.amount * m) : 0;
    const ca = v.enabled ? v.chroma_shift : 0;
    const gAmp = gr.enabled ? GRAIN_BASE * Math.sqrt(gr.iso / 400) * m * grainResolutionAmp(gr.film_resolution) : 0;
    /* 颗粒间距按「有效尺寸」的全分辨率 H 计算再折算到内部渲染分辨率（观感与 GL 一致） */
    const sizeEff = grainSizeEff(gr.size, gr.film_resolution);
    const gw = grainScaleWeights(sizeEff, gr.film_resolution);
    const gBand = { shadow: gr.shadow, midtone: gr.midtone, highlight: gr.highlight, shadow_weight: gr.shadow_weight, type: gr.type };
    const grainNoise = gr.mode === 'noise';
    const pxFull = Math.max(this.srcH * sizeEff * 0.001, 1.25);
    const px = Math.max(pxFull * this.internalScale, 0.75);
    const mask = this.view.mode === 3;   /* Mask 隔离预览：base=0，只留效果层 */
    /* R9 片门抖动：每帧全局位移（内部像素）；amount=0 → 位移恒 0（逐位恒等）。与 GL 同式 */
    const gwave = this.params.texture.gate_weave;
    const gwOff = gateWeaveOffsetPx(gwave.amount, gwave.speed, this.renderTime, this.srcH);
    const wdx = gwOff.dx * this.internalScale, wdy = gwOff.dy * this.internalScale;
    const smp = [0, 0, 0], smp2 = [0, 0, 0];
    for (let y = 0; y < H; y++) {
      const cy = y / H - 0.5;
      for (let x = 0; x < W; x++) {
        const cx = x / W - 0.5;
        const p4 = (y * W + x) * 4;
        if (this.view.mode === 1 || (this.view.mode === 2 && x / W > this.view.splitX)) {
          od[p4] = srcData[p4]; od[p4 + 1] = srcData[p4 + 1]; od[p4 + 2] = srcData[p4 + 2]; od[p4 + 3] = 255;
          continue;
        }
        const len = Math.sqrt(cx * cx + cy * cy);
        const rr = len * 1.41421356;
        const dispPx = ca * this.srcH * rr * rr * this.internalScale; /* 全分辨率位移折算到内部像素 */
        const dx = len > 1e-4 ? (cx / len) * dispPx : 0, dy = len > 1e-4 ? (cy / len) * dispPx : 0;
        /* 边缘色散：R 内采(−d)→呈像外移，B 外采(+d)→内移（与 GL 一致）；Mask 模式不采样 graded */
        let br = 0, bg = 0, bb = 0;
        if (!mask) {
          EffectRenderer.sample3(this.cpuGraded!, W, H, 4, x - dx + wdx, y - dy + wdy, smp);
          br = smp[0] / 255;
          EffectRenderer.sample3(this.cpuGraded!, W, H, 4, x + wdx, y + wdy, smp);
          bg = smp[1] / 255;
          EffectRenderer.sample3(this.cpuGraded!, W, H, 4, x + dx + wdx, y + dy + wdy, smp);
          bb = smp[2] / 255;
        }
        /* 背景（未叠加效果前）：background_gain / blue_comp / save_lights 一律按它算 */
        const bgr = br, bgg = bg, bbb = bb;
        const bgL = LUMA_R * bgr + LUMA_G * bgg + LUMA_B * bbb;
        /* 柔光 bloom：先降饱和、再按背景亮度防溢出，然后 screen */
        EffectRenderer.sample3(this.cpuBlm!, d.hw8, d.hh8, 3, (x + wdx) / W * d.hw8, (y + wdy) / H * d.hh8, smp);
        const sat = bloomSaturationMix([smp[0] * blmAmt, smp[1] * blmAmt, smp[2] * blmAmt], b.saturation);
        const slF = bloomSaveLightsFactor(bgL, b.save_lights);
        br = 1 - (1 - br) * (1 - clamp01(sat[0] * slF));
        bg = 1 - (1 - bg) * (1 - clamp01(sat[1] * slF));
        bb = 1 - (1 - bb) * (1 - clamp01(sat[2] * slF));
        EffectRenderer.sample3(this.cpuHalT!, d.hw4, d.hh4, 3, (x + wdx) / W * d.hw4, (y + wdy) / H * d.hh4, smp);
        EffectRenderer.sample3(this.cpuHalW!, d.hw4, d.hh4, 3, (x + wdx) / W * d.hw4, (y + wdy) / H * d.hh4, smp2);
        let hr = smp[0] * halTw + smp2[0] * halWw;
        let hg = smp[1] * halTw + smp2[1] * halWw;
        let hb = smp[2] * halTw + smp2[2] * halWw;
        hr *= tint[0]; hg *= tint[1]; hb *= tint[2];
        hr = clamp01(hr); hg = clamp01(hg); hb = clamp01(hb);
        /* 暗部保护：远场软衰减 */
        const prot = smoothstepF(0.004, 0.035, Math.max(hr, Math.max(hg, hb)));
        const halScale = prot * halationBackgroundAtten(bgL, h.background_gain)
          * halationBlueCompGain(bgr, bbb, h.blue_comp);
        hr *= halScale; hg *= halScale; hb *= halScale;
        br = 1 - (1 - br) * (1 - hr);
        bg = 1 - (1 - bg) * (1 - hg);
        bb = 1 - (1 - bb) * (1 - hb);
        const vig = 1 - vigAmt * smoothstepF(v.radius * 0.707 - 0.35, 1, rr);
        br *= vig; bg *= vig; bb *= vig;
        /* 颗粒：3 尺度金字塔（有效尺寸权重）+ 色度白噪声；noise 模式改逐像素白噪声 */
        const gx = x / px, gy = y / px;
        /* R9 扫描颗粒团簇：低频噪声用基准颗粒坐标（不受片门抖动影响），×0.18 种子 91.7；
           cluster=0 → clusterGain≡1（逐位恒等）。与 GL 同式 */
        const clusterGain = grainClusterGain(vnoise(gx * 0.18, gy * 0.18, 91.7), gr.cluster ?? 0);
        let mono: number;
        if (grainNoise) {
          mono = (hash12(gx, gy, phase) - 0.5) * 2.0;
        } else {
          const nC = vnoise(gx * 0.5, gy * 0.5, phase);
          const nM = vnoise(gx, gy, phase + 17.13);
          const nF = vnoise(gx * 1.9, gy * 1.9, phase + 31.71);
          mono = (nC * gw.coarse + nM * gw.mid + nF * gw.fine - 0.5) * 2.1;
        }
        const cr = hash12(gx * 1.7, gy * 1.7, phase + 51.7) - 0.5;
        const cg = hash12(gx * 1.7, gy * 1.7, phase + 67.3) - 0.5;
        const cb = hash12(gx * 1.7, gy * 1.7, phase + 83.9) - 0.5;
        const corr = gr.correlation;
        const l = LUMA_R * br + LUMA_G * bg + LUMA_B * bb;
        /* 亮度三段包络（grainBandWeights 系数和）：默认与旧单段连续，仅高光段按 highlight 保留少量 */
        const wgt = grainWeightAt(l, gBand) * clusterGain;
        od[p4] = (br + (cr * 0.7 * (1 - corr) + mono * corr) * gAmp * wgt) * 255;
        od[p4 + 1] = (bg + (cg * 0.7 * (1 - corr) + mono * corr) * gAmp * wgt) * 255;
        od[p4 + 2] = (bb + (cb * 0.7 * (1 - corr) + mono * corr) * gAmp * wgt) * 255;
        od[p4 + 3] = 255;
      }
    }
    out.putImageData(img, 0, 0);
    const c2 = this.ctx2d!;
    c2.imageSmoothingEnabled = true;
    c2.drawImage(this.cpuOutCv!, 0, 0, this.canvas!.width, this.canvas!.height);
  }

  /* 统一分发（保持与 GL 相同的脏标记语义） */
  private runGradeDispatch(): void { if (this.gl) this.runGrade(); else this.runGradeCPU(); }
  private runChainsDispatch(): void { if (this.gl) this.runChains(); else this.runChainsCPU(); }
  private runFinalDispatch(phase: number): void { if (this.gl) this.runFinal(phase); else this.runFinalCPU(phase); }
}
