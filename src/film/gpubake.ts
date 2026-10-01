/**
 * R17 GPU tile-atlas LUT 烘焙（独立 chunk，动态 import，不进首屏包）。
 *
 * 语义（沿袭 R10 架构）：
 *   - 预览 LUT 只承载**匹配**（kind='match'）；look 数学在 GRADE_FS（拖动零重烘不受影响）；
 *   - 导出复合 LUT（kind='recipe'）= 匹配∘look 完整观感，与 bakeRecipeLUT 同公式同顺序；
 *   - 本模块只是把「烘焙发生在哪里」从 worker/CPU 换成 GPU（渲染 2D atlas → readPixels），
 *     失败/不可用一律返回 null，调用方回退 worker/CPU 路径（行为与今天完全一致）。
 *
 * atlas 布局（宽 n² × 高 n；33³→1089×33，65³→4225×65）：
 *   像素 (x, y)：r = x mod n（红维，列内最快，与 .cube 惯例一致）、
 *   b = x div n（蓝维，列号）、g = y（绿维，行号）；输入 = (r/m, g/m, b/m)，m = n-1。
 *   读回后按引擎表布局 index = ((b*n + g)*n + r)*3 重排（atlasToEngine），
 *   与既有 uploadLut 的「atlas 像素 (g*n² + b*n + r)」一一对应。
 *
 * 数学镜像（GLSL 与 TS 逐式对应，勿单改任一处）：
 *   - 匹配逐像素公式 = engine/match.ts buildTransform 闭包（常数经 matchBakeData 下发，
 *     与 CPU 闭包**同一预计算**，单一真源）；
 *   - sRGB↔Lab = engine/color.ts；look 段 = GRADE_FS / engine/look.lookTransform；
 *   - legal 包裹 = engine/lut.rangeWrap（u_legalLo/Hi；full=0/1 → IEEE 精确恒等）。
 * 一致性证明：gpubake.test.ts（GLSL→JS 逐式镜像对拍 <1e-3、≥500 点）+
 * E2E demo=range（SwiftShader 真实 GPU vs CPU 烘焙逐点对比 <1e-3，e2e-verify R17-1）。
 */
import { LEGAL_HIGH, LEGAL_LOW, type DataRange } from '../engine/lut';
import type { MatchBakeData } from '../engine/match';
import type { LookParams as EngineLook } from '../engine/look';

export interface GpuBakeRequest {
  /** 每维格点数（2..65；预览/导出用 33 / 65） */
  size: number;
  /** 'match' = 仅匹配（预览）；'recipe' = 匹配∘look（导出） */
  kind: 'match' | 'recipe';
  /** 匹配常数；null = 无统计恒等（clamp01） */
  match: MatchBakeData | null;
  /** look 参数（kind='recipe' 消费；null = 全中性恒等） */
  look: EngineLook | null;
  /** 数据范围（R17）：true = legal in/out 包裹（仅导出语义） */
  legal?: DataRange | 'full' | 'legal';
}

export interface GpuBakeResult {
  size: number;
  /** 引擎表布局（index=((b*n+g)*n+r)*3），可直接作为 LutData / LUT3D 使用 */
  table: Float32Array;
  /** 渲染目标格式（RGBA32F / RGBA16F）——meta 可观察 */
  format: string;
  /** 本次烘焙墙钟耗时（ms，含纹理上传与 readPixels） */
  ms: number;
}

export interface GpuBaker {
  bake(req: GpuBakeRequest): GpuBakeResult | null;
  readonly format: string;
  dispose(): void;
}

/* ---------------- GLSL ES 3.00（WebGL2 + EXT_color_buffer_float 专用路径） ---------------- */

export const VERT300 = `#version 300 es
layout(location=0) in vec2 a_pos;
void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }`;

/* 烘焙片元着色器：atlas 每像素评估一次烘焙目标函数（匹配 / 匹配∘look）。 */
export const BAKE_FS = `#version 300 es
precision highp float;
precision highp int;

/* ====== R17 GPU tile-atlas LUT 烘焙（数学与 CPU 路径逐式镜像，见文件头） ====== */

uniform float u_n;                    /* 每维格点数 n */
uniform float u_m;                    /* n-1 */
uniform float u_kind;                 /* 0=仅匹配（预览） 1=匹配∘look（导出） */
uniform float u_legalLo, u_legalHi;   /* legal 包裹锚点（full: 0/1 → 精确恒等） */

/* ---- 匹配常数（engine/match.ts precomputeMatch 下发） ---- */
uniform float u_hasMatch;
uniform float u_dA, u_dB, u_rawDA, u_rawDB;
uniform float u_stA, u_stB, u_htA, u_htB;
uniform float u_iso, u_hueOff, u_satK, u_gs, u_ms;
uniform float u_skinTweak, u_splitOn;
uniform sampler2D u_curve;            /* 129×1 R32F：L* 单调曲线锚点（LUT_ANCHORS=128） */
uniform sampler2D u_env;              /* envW×envH R32F：平滑色域包络色度 */
uniform float u_envW, u_envH, u_envLStep, u_envHStep;

/* ---- look 常数（GRADE_FS look 段同款） ---- */
uniform float u_fade, u_black, u_coupling, u_shBias, u_hiBias, u_sat, u_filmS, u_contrast, u_warm;
uniform float u_spShHue, u_spShSat, u_spHiHue, u_spHiSat, u_spBal;

out vec4 fragColor;

const float LR = 0.2126;
const float LG = 0.7152;
const float LB = 0.0722;
const float LAB_EPS = 216.0 / 24389.0;    /* (6/29)^3 */
const float LAB_KAPPA = 24389.0 / 27.0;

float c01(float v){ return v < 0.0 ? 0.0 : (v > 1.0 ? 1.0 : v); }
/* engine/util.smoothstep 同式（含 b<=a 退化；常数窗下与 GLSL 内置 smoothstep 等价） */
float sstep(float a, float b, float x){
  if (b <= a) return x >= b ? 1.0 : 0.0;
  float t = c01((x - a) / (b - a));
  return t * t * (3.0 - 2.0 * t);
}

/* ---- sRGB(gamma) ↔ Lab（engine/color.ts 逐式镜像，D65 白点） ---- */
float srgbToLinear(float c){ return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
float linearToSrgb(float c){ return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055; }
float labF(float t){ return t > LAB_EPS ? pow(t, 1.0 / 3.0) : (LAB_KAPPA * t + 16.0) / 116.0; }

vec3 rgbToLab(vec3 c){
  float lr = srgbToLinear(c.r);
  float lg = srgbToLinear(c.g);
  float lb = srgbToLinear(c.b);
  float x = 0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb;
  float y = 0.2126729 * lr + 0.7151522 * lg + 0.072175  * lb;
  float z = 0.0193339 * lr + 0.119192  * lg + 0.9503041 * lb;
  float fx = labF(x / 0.95047);
  float fy = labF(y / 1.0);
  float fz = labF(z / 1.08883);
  return vec3(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz));
}

vec3 linAtScaled(float L, float a, float b, float s){
  float fy = (L + 16.0) / 116.0;
  float yr = L > 8.0 ? fy * fy * fy : L / LAB_KAPPA;  /* 8 = KAPPA*EPS（fp64 为 8.000…002，LUT 网格不落此边界） */
  float y = yr * 1.0;
  float fx = fy + (s * a) / 500.0;
  float fz = fy - (s * b) / 200.0;
  float xr = fx * fx * fx > LAB_EPS ? fx * fx * fx : (116.0 * fx - 16.0) / LAB_KAPPA;
  float zr = fz * fz * fz > LAB_EPS ? fz * fz * fz : (116.0 * fz - 16.0) / LAB_KAPPA;
  float x = xr * 0.95047;
  float z = zr * 1.08883;
  return vec3(3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
             -0.969266  * x + 1.8760108 * y + 0.041556  * z,
              0.0556434 * x - 0.2040259 * y + 1.0572252 * z);
}

bool linInGamut(vec3 lin){
  return lin.r >= -1e-9 && lin.r <= 1.0 + 1e-9 &&
         lin.g >= -1e-9 && lin.g <= 1.0 + 1e-9 &&
         lin.b >= -1e-9 && lin.b <= 1.0 + 1e-9;
}

/* Lab → sRGB gamma：色域残余越界沿 a*b* 二分收缩 10 轮（color.labToRgbInto 同式） */
vec3 labToRgb(float L, float a, float b){
  vec3 lin = linAtScaled(L, a, b, 1.0);
  if (!linInGamut(lin)) {
    float lo = 0.0;
    float hi = 1.0;
    for (int i = 0; i < 10; i++) {
      float mid = (lo + hi) * 0.5;
      if (linInGamut(linAtScaled(L, a, b, mid))) lo = mid; else hi = mid;
    }
    lin = linAtScaled(L, a, b, lo);
  }
  return vec3(c01(linearToSrgb(c01(lin.r))),
              c01(linearToSrgb(c01(lin.g))),
              c01(linearToSrgb(c01(lin.b))));
}

/* 明度曲线：129 锚点线性插值（buildLumaCurve 表；i0 上限 127 同 TS x>=128 ? 127 : x|0） */
float curveAt(float L0){
  float x = clamp(L0, 0.0, 100.0) * (128.0 / 100.0);
  int i0 = x >= 128.0 ? 127 : int(floor(x));
  float ft = x - float(i0);
  float a = texelFetch(u_curve, ivec2(i0, 0), 0).r;
  float b = texelFetch(u_curve, ivec2(i0 + 1, 0), 0).r;
  return a + (b - a) * ft;
}

/* 平滑色域包络双线性查询（match.envLookup 同式：色相循环、L 端点钳制） */
float envLookup(float L, float hueRad){
  float h = mod(degrees(hueRad), 360.0);
  float fh = h / u_envHStep;
  float fl = clamp(L, 0.0, 100.0) / u_envLStep;
  int ih0 = min(int(u_envW) - 1, int(floor(fh)));
  int il0 = min(int(u_envH) - 1, int(floor(fl)));
  float th = fh - float(ih0);
  float tl = fl - float(il0);
  int ih1 = (ih0 + 1) % int(u_envW);   /* 色相循环 */
  int il1 = min(int(u_envH) - 1, il0 + 1);
  float v00 = texelFetch(u_env, ivec2(ih0, il0), 0).r;
  float v01 = texelFetch(u_env, ivec2(ih1, il0), 0).r;
  float v10 = texelFetch(u_env, ivec2(ih0, il1), 0).r;
  float v11 = texelFetch(u_env, ivec2(ih1, il1), 0).r;
  float a0 = v00 + (v01 - v00) * th;
  float a1 = v10 + (v11 - v10) * th;
  return a0 + (a1 - a0) * tl;
}

/* ---- 匹配逐像素公式（engine/match.ts buildTransform 闭包逐式镜像，顺序一致） ----
   曲线 → 肤色掩码 → 色偏对齐 → 肤色微调 → 分离色调 → 全局饱和 → 包络软膝 → Lab→sRGB */
vec3 matchXf(vec3 rgb){
  if (u_hasMatch < 0.5) return vec3(c01(rgb.r), c01(rgb.g), c01(rgb.b));
  float r = c01(rgb.r);
  float g = c01(rgb.g);
  float b = c01(rgb.b);
  vec3 lab = rgbToLab(vec3(r, g, b));
  float L0 = lab.r;
  float a0 = lab.g;
  float b0 = lab.b;

  /* 明度：查单调表（线性插值） */
  float L1 = curveAt(L0);

  /* 肤色掩码：扣除整体色偏后判定（SKIN_A/B/SA/SB = 14/18/9/10，亮度窗 28/46/76/94） */
  float da = (a0 + u_rawDA - 14.0) / 9.0;
  float db = (b0 + u_rawDB - 18.0) / 10.0;
  float m = exp(-0.5 * (da * da + db * db))
          * sstep(28.0, 46.0, L0)
          * (1.0 - sstep(76.0, 94.0, L0));

  /* 全局色偏对齐，isolation 在掩码内按比例抑制 */
  float a1 = a0 + u_dA * (1.0 - u_iso * m);
  float b1 = b0 + u_dB * (1.0 - u_iso * m);

  /* 肤色微调：色相旋转 + 色度缩放（掩码外无操作） */
  if (u_skinTweak > 0.5 && m > 1e-4) {
    float c = sqrt(a1 * a1 + b1 * b1);
    if (c > 1e-6) {
      float h = atan(b1, a1) + u_hueOff * m;
      float c2 = c * (1.0 + (u_satK - 1.0) * m);
      a1 = c2 * cos(h);
      b1 = c2 * sin(h);
    }
  }

  /* 分离色调（参考图派生）：按输出明度两端叠加（SPLIT_LOW/HIGH = 0.2/0.8） */
  if (u_splitOn > 0.5) {
    float l01 = L1 / 100.0;
    float wH = sstep(0.2, 0.8, l01);
    float prot = 1.0 - u_iso * m;
    a1 += prot * ((1.0 - wH) * u_stA + wH * u_htA);
    b1 += prot * ((1.0 - wH) * u_stB + wH * u_htB);
  }

  /* 全局饱和（最后施加） */
  a1 *= u_gs;
  b1 *= u_gs;

  /* 平滑色域包络软膝（KNEE_K=0.35 → KNEE_LO=0.65 / KNEE_HI=1.3；压缩量随 ms 缩放） */
  float C = sqrt(a1 * a1 + b1 * b1);
  if (C > 1e-9) {
    float x = C / max(1e-6, envLookup(L1, atan(b1, a1)));
    if (x > 0.65) {
      float gk = 1.0 - 0.35 * exp(-(x - 1.0 + 0.35) / 0.35);
      float w = u_ms * sstep(0.65, 1.3, x) * (1.0 - u_iso * m);
      float mult = (x + w * (gk - x)) / x;
      a1 *= mult;
      b1 *= mult;
    }
  }

  return labToRgb(L1, a1, b1);
}

/* ---- look 段（GRADE_FS look 段逐式镜像；先家族B 后家族A，与 engine/look 一致） ---- */
float refS(float x){
  float lin = 0.42 + (x - 0.42) * 0.76;
  float toe = 0.030 + (lin - 0.030) * pow(clamp(x / 0.42, 0.0, 1.0), 0.75);
  float y = mix(toe, lin, smoothstep(0.02, 0.24, x));
  if (x > 0.55) {
    float u = (x - 0.55) / 0.45;
    y = 0.5188 + u * (0.342 + u * (0.7596 - u * 0.6204));
  }
  return y;
}
float shapeNeg(float x, float s){ return s <= 0.001 ? x : mix(x, refS(x), s); }
float shapePos(float x, float s){ return s <= 0.001 ? x : mix(x, x * x * (3.0 - 2.0 * x), s); }
vec3 dyeCross(vec3 c, float k){
  return vec3(
    c.r * (1.0 - k)      + c.g * (k * 0.55)  + c.b * (k * 0.30),
    c.r * (k * 0.35)     + c.g * (1.0 - k * 0.8) + c.b * (k * 0.45),
    c.r * (k * 0.25)     + c.g * (k * 0.35)  + c.b * (1.0 - k * 1.6));
}
/* Schema v1.2 分离色调：6 段线性色相轮 → 零亮度方向（engine/look.splitHueRGB 同式） */
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
  return raw - vec3(dot(raw, vec3(LR, LG, LB)));
}

vec3 lookXf(vec3 cIn){
  vec3 c = vec3(shapePos(cIn.r, u_contrast), shapePos(cIn.g, u_contrast), shapePos(cIn.b, u_contrast));
  c = vec3(shapeNeg(c.r, u_filmS), shapeNeg(c.g, u_filmS), shapeNeg(c.b, u_filmS));
  c = dyeCross(c, u_coupling);
  float l = dot(c, vec3(LR, LG, LB));
  float sh = pow(clamp(1.0 - l, 0.0, 1.0), 2.2);
  float hi = pow(clamp(l, 0.0, 1.0), 2.2);
  c.r += u_shBias * (-0.10 * sh) + u_hiBias * (0.10 * hi);
  c.g += u_shBias * (0.02 * sh) + u_hiBias * (0.08 * hi);
  c.b += u_shBias * (0.16 * sh) + u_hiBias * (-0.18 * hi);
  /* Schema v1.2 分离色调（SPLIT_SCALE=0.2，平衡因子 0.5） */
  float spB = clamp(u_spBal, -1.0, 1.0);
  float spWS = sh * (1.0 - 0.5 * spB);
  float spWH = hi * (1.0 + 0.5 * spB);
  vec3 ds = splitDir(u_spShHue);
  vec3 dh = splitDir(u_spHiHue);
  c += (ds * (u_spShSat * spWS) + dh * (u_spHiSat * spWH)) * 0.2;
  float blk = u_black + u_fade * 0.10;
  float wht = u_fade * 0.08;
  c = clamp(c, 0.0, 1.0);
  c = blk + c * (1.0 - blk - wht);
  l = dot(c, vec3(LR, LG, LB));
  c = mix(vec3(l), c, u_sat);
  c *= vec3(1.0 + u_warm * 0.05, 1.0 + u_warm * 0.01, 1.0 - u_warm * 0.05);
  return clamp(c, 0.0, 1.0);
}

void main(){
  ivec2 px = ivec2(gl_FragCoord.xy);
  int n = int(u_n);
  int r = px.x % n;          /* 红维：列内最快（与 .cube 惯例一致） */
  int bIdx = px.x / n;       /* 蓝维：列号 */
  int gIdx = px.y;           /* 绿维：行号 */
  vec3 inp = vec3(float(r) / u_m, float(gIdx) / u_m, float(bIdx) / u_m);
  /* 数据范围（R17）：legal 导出 = 输入 Legal→Full 展开 + 输出 Full→Legal 回编；
   * full（lo=0/hi=1）时两式精确恒等（x/1.0、x*1.0+0.0 均为 IEEE 精确）。 */
  vec3 x = clamp((inp - u_legalLo) / (u_legalHi - u_legalLo), 0.0, 1.0);
  vec3 c = matchXf(x);
  if (u_kind > 0.5) c = lookXf(c);
  float span = u_legalHi - u_legalLo;
  vec3 outc = clamp(c, 0.0, 1.0) * span + u_legalLo;
  fragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`;

/* ---------------- TS 侧：atlas → 引擎表布局 ---------------- */

/** atlas（宽 n²、高 n，像素 (g*n²+b*n+r)）→ 引擎表布局 index=((b*n+g)*n+r)*3 */
export function atlasToEngine(n: number, atlas: Float32Array): Float32Array {
  const table = new Float32Array(n * n * n * 3);
  const rowPx = n * n;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      let j = (b * n + g) * n * 3;
      for (let r = 0; r < n; r++) {
        const p = (g * rowPx + b * n + r) * 4;
        table[j] = c01f(atlas[p]);
        table[j + 1] = c01f(atlas[p + 1]);
        table[j + 2] = c01f(atlas[p + 2]);
        j += 3;
      }
    }
  }
  return table;
}

const c01f = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ---------------- 工厂 ---------------- */

interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }

/** 创建 GPU 烘焙器；能力不足（无 WebGL2 / 无 EXT_color_buffer_float / float FBO 或 readPixels 不可用）返回 null。 */
export function createGpuBaker(canvas: HTMLCanvasElement): GpuBaker | null {
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
  if (!gl) return null;
  if (!gl.getExtension('EXT_color_buffer_float')) return null;

  const compile = (vs: string, fs: string): WebGLProgram | null => {
    const p = gl.createProgram();
    if (!p) return null;
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null;
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
    return p;
  };

  const prog = compile(VERT300, BAKE_FS);
  if (!prog) return null;
  const u: Record<string, WebGLUniformLocation | null> = {};
  const nUniforms = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < nUniforms; i++) {
    const info = gl.getActiveUniform(prog, i)!;
    u[info.name.replace('[0]', '')] = gl.getUniformLocation(prog, info.name);
  }

  /* 全屏三角形（自带 VBO，不与 EffectRenderer 共享状态） */
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const attrib0 = gl.getAttribLocation(prog, 'a_pos');

  /* float 渲染目标探测：RGBA32F 优先（精度最高），失败退 RGBA16F（half float 量化
   * ≤2.4e-4 @1.0，仍满足 <1e-3 口径）；再失败 → 返回 null（调用方回退 CPU）。 */
  let fmt: { internal: number; name: string } | null = null;
  for (const [internal, name] of [[gl.RGBA32F, 'RGBA32F'], [gl.RGBA16F, 'RGBA16F']] as const) {
    let tex: WebGLTexture | null = null;
    let fbo: WebGLFramebuffer | null = null;
    try {
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) continue;
      /* readPixels(RGBA, FLOAT) 探测：float 附件下的保证组合；失败即弃 */
      gl.clearColor(0.5, 0.5, 0.5, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const probe = new Float32Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, probe);
      if (gl.getError() !== gl.NO_ERROR) continue;
      if (!(probe[0] > 0.49 && probe[0] < 0.51)) continue;
      fmt = { internal, name };
      break;
    } catch {
      continue;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (fbo) gl.deleteFramebuffer(fbo);
      if (tex) gl.deleteTexture(tex);
    }
  }
  if (!fmt) {
    gl.deleteProgram(prog);
    gl.deleteBuffer(vb);
    return null;
  }

  const makeDataTex = (): WebGLTexture => {
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const curveTex = makeDataTex();   // 129×1 R32F
  const envTex = makeDataTex();     // envW×envH R32F
  const f32 = (a: ArrayLike<number>): Float32Array => (a instanceof Float32Array ? a : Float32Array.from(a));
  const targets = new Map<number, Target>();

  const bake = (req: GpuBakeRequest): GpuBakeResult | null => {
    const t0 = performance.now();
    const n = Math.max(2, Math.min(65, Math.round(req.size)));
    const w = n * n;
    const h = n;
    const md = req.match;
    const look = req.look;
    const legal = req.legal === 'legal';

    gl.activeTexture(gl.TEXTURE0);

    /* atlas 渲染目标（按尺寸缓存；创建期绑定的是当前单元，采样绑定在下方统一做） */
    let target = targets.get(w * 4096 + h);
    if (!target) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteTexture(tex);
        gl.deleteFramebuffer(fbo);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return null;
      }
      target = { tex: tex!, fbo: fbo!, w, h };
      targets.set(w * 4096 + h, target);
    }

    /* 数据纹理上传（在 bake 计时内——如实计入 GPU 路径成本）；绑定采样单元 0/1 */
    gl.bindTexture(gl.TEXTURE_2D, curveTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 129, 1, 0, gl.RED, gl.FLOAT, f32(md ? md.curve : new Float32Array(129)));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, envTex);
    if (md) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, md.envW, md.envH, 0, gl.RED, gl.FLOAT, md.env);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array([1]));
    }
    gl.activeTexture(gl.TEXTURE0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.enableVertexAttribArray(attrib0);
    gl.vertexAttribPointer(attrib0, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(u['u_n'], n);
    gl.uniform1f(u['u_m'], n - 1);
    gl.uniform1f(u['u_kind'], req.kind === 'recipe' ? 1 : 0);
    gl.uniform1f(u['u_legalLo'], legal ? LEGAL_LOW : 0);
    gl.uniform1f(u['u_legalHi'], legal ? LEGAL_HIGH : 1);
    gl.uniform1f(u['u_hasMatch'], md && md.hasMatch ? 1 : 0);
    gl.uniform1f(u['u_dA'], md?.dA ?? 0);
    gl.uniform1f(u['u_dB'], md?.dB ?? 0);
    gl.uniform1f(u['u_rawDA'], md?.rawDA ?? 0);
    gl.uniform1f(u['u_rawDB'], md?.rawDB ?? 0);
    gl.uniform1f(u['u_stA'], md?.stA ?? 0);
    gl.uniform1f(u['u_stB'], md?.stB ?? 0);
    gl.uniform1f(u['u_htA'], md?.htA ?? 0);
    gl.uniform1f(u['u_htB'], md?.htB ?? 0);
    gl.uniform1f(u['u_iso'], md?.iso ?? 0);
    gl.uniform1f(u['u_hueOff'], md?.hueOff ?? 0);
    gl.uniform1f(u['u_satK'], md?.satK ?? 1);
    gl.uniform1f(u['u_gs'], md?.gs ?? 1);
    gl.uniform1f(u['u_ms'], md?.ms ?? 0);
    gl.uniform1f(u['u_skinTweak'], md?.skinTweak ? 1 : 0);
    gl.uniform1f(u['u_splitOn'], md?.splitOn ? 1 : 0);
    gl.uniform1f(u['u_envW'], md?.envW ?? 1);
    gl.uniform1f(u['u_envH'], md?.envH ?? 1);
    gl.uniform1f(u['u_envLStep'], md?.envLStep ?? 100);
    gl.uniform1f(u['u_envHStep'], md?.envHStep ?? 360);
    gl.uniform1i(u['u_curve'], 0);
    gl.uniform1i(u['u_env'], 1);
    const L = look;
    gl.uniform1f(u['u_fade'], L?.fade ?? 0);
    gl.uniform1f(u['u_black'], L?.black_lift ?? 0);
    gl.uniform1f(u['u_coupling'], L?.dye_coupling ?? 0);
    gl.uniform1f(u['u_shBias'], L?.shadow_bias ?? 0);
    gl.uniform1f(u['u_hiBias'], L?.highlight_bias ?? 0);
    gl.uniform1f(u['u_sat'], L?.saturation ?? 1);
    gl.uniform1f(u['u_filmS'], L?.film_s ?? 0);
    gl.uniform1f(u['u_contrast'], L?.contrast ?? 0);
    gl.uniform1f(u['u_warm'], L?.warmth ?? 0);
    gl.uniform1f(u['u_spShHue'], L?.split_shadow_hue ?? 0);
    gl.uniform1f(u['u_spShSat'], L?.split_shadow_sat ?? 0);
    gl.uniform1f(u['u_spHiHue'], L?.split_highlight_hue ?? 0);
    gl.uniform1f(u['u_spHiSat'], L?.split_highlight_sat ?? 0);
    gl.uniform1f(u['u_spBal'], L?.split_balance ?? 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const atlas = new Float32Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, atlas);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const ok = gl.getError() === gl.NO_ERROR &&
      Number.isFinite(atlas[0]) && Number.isFinite(atlas[63]) &&
      Number.isFinite(atlas[atlas.length - 1]);
    if (!ok) return null;

    const table = atlasToEngine(n, atlas);
    return { size: n, table, format: fmt.name, ms: performance.now() - t0 };
  };

  return {
    bake,
    get format(): string { return fmt.name; },
    dispose(): void {
      for (const t of targets.values()) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
      targets.clear();
      gl.deleteTexture(curveTex);
      gl.deleteTexture(envTex);
      gl.deleteBuffer(vb);
      gl.deleteProgram(prog);
    },
  };
}
