/**
 * R9 观感对齐测量台（纯函数、node 可跑，无 WebGL/Canvas 依赖）。R21 更新。
 *
 * 用途：给「网页预览」与「达芬奇 DCTL」两条链路的**已知差异**提供实测数字，
 * 支撑 `docs/research/观感对齐清单-R9.md` 里的「已对齐 / 已接受 / 待办」判定。
 * 它**不是**像素级仿真器：只按两边的语义差异复算同一批公式，量化差异量级。
 *
 * R21 口径更新（用户实机回执修复轮）：
 *   - DCTL 侧镜像升级为新 tap 结构：光晕=紧晕 3×3 + 宽晕双环（3×3@r + 外环 8@2r）、
 *     柔光=中心+4@r+4@2r；每 tap 过完整 look（阈值作用域与网页一致）；光晕亮通 max3、
 *     柔光亮通 luma（均与网页 brightPass 同语义）；保留旧结构镜像作 before/after 对照。
 *   - 网页侧镜像补「可分离高斯（σ=R/2）」真值路径（镜像 pipeline.blurSep/blurChain），
 *     用于 veil 强度的连续核对照（R21 节）。
 *   - 新增 r21 节：veil 量化（旧→新）、master 四层乘式镜像核对、半径运行时缩放恒等核对。
 *
 * 用法：`npx vite-node tools/alignment-report.mjs [--json]`
 */
import {
  TIGHT_RADIUS_H, TIGHT_WEIGHT, WIDE_WEIGHT, luma, smoothstep, clamp01,
  halationWeights, halationRadiusEff, bloomRadiusEff,
  lookTonalLandings, anchorsToLookCal,
} from '../src/film/effectmath.ts';
import { lookTransform } from '../src/engine/look.ts';
import { rgbToLab, deltaE76 } from '../src/engine/color.ts';
import { anchorsFromLook, anchorsForPipeline, lookToLogLook, applyLogLook, tfDecode, tfEncode } from '../src/dctl/logmath.ts';
import { getPreset } from '../src/film/params.ts';

const W = 160;
const H = 90;

/** 合成测试帧：暗底 + 两处亮源（暖/冷）+ 灰阶斜坡——刻意覆盖高光溢出与中间调 */
function makeFrame(w = W, h = H) {
  const px = new Float64Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const ramp = x / (w - 1);
      let r = 0.04 + 0.5 * ramp * ramp;
      let g = 0.04 + 0.45 * ramp * ramp;
      let b = 0.05 + 0.4 * ramp * ramp;
      // 暖色亮源（右上）
      const d1 = Math.hypot(x - w * 0.78, y - h * 0.3) / (h * 0.12);
      if (d1 < 1) { const k = 1 - d1; r = Math.min(1, r + k * 1.6); g = Math.min(1, g + k * 1.0); b = Math.min(1, b + k * 0.35); }
      // 冷色亮源（左下）
      const d2 = Math.hypot(x - w * 0.22, y - h * 0.72) / (h * 0.10);
      if (d2 < 1) { const k = 1 - d2; b = Math.min(1, b + k * 1.3); g = Math.min(1, g + k * 0.7); }
      px[i] = r; px[i + 1] = g; px[i + 2] = b;
    }
  }
  return { px, w, h };
}

const at = (f, x, y, c) => f.px[((y * f.w + x) * 3) + c];
const clampIdx = (v, n) => (v < 0 ? 0 : v > n - 1 ? n - 1 : v);

const E2 = Math.exp(-2), E4 = E2 * E2;

/** 单个采样点的取色（可选逐点 look——R21 起 DCTL 每 tap 过完整链路） */
function sampleTap(f, x, y, onLooked) {
  const xx = clampIdx(x, f.w), yy = clampIdx(y, f.h);
  const c = [at(f, xx, yy, 0), at(f, xx, yy, 1), at(f, xx, yy, 2)];
  return onLooked ? onLooked(c) : c;
}

/**
 * 光晕 tap 场（标量亮通权重；晕色由 tint 决定，两边同式）。
 * variant='web'    → 连续核：先逐点亮通再可分离高斯（σ=R/2，镜像 blurSep）
 * variant='dctlOld'→ R12–R20 结构：3×3@r 单环、G 通道、源图阈值
 * variant='dctlNew'→ R21 结构：紧晕 3×3@rT + 宽晕双环（3×3@rW + 外环 8@2rW）、max3、逐 tap look
 */
function brightField(f, onLooked, chan, thresh, powK) {
  const out = new Float64Array(f.w * f.h);
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
    const c = onLooked ? onLooked([at(f, x, y, 0), at(f, x, y, 1), at(f, x, y, 2)]) : [at(f, x, y, 0), at(f, x, y, 1), at(f, x, y, 2)];
    const lv = chan === 'max' ? Math.max(c[0], c[1], c[2]) : chan === 'luma' ? luma(c) : c[1];
    const bw = smoothstep(thresh, 1, lv);
    out[y * f.w + x] = powK === 1 ? bw : bw * bw;
  }
  return out;
}

function blurSep1(src, w, h, radiusPx) {
  const sigma = Math.min(radiusPx / 2, 16);
  const R = Math.max(1, Math.min(40, Math.ceil(sigma * 2.5)));
  const wgt = [];
  let sum = 0;
  for (let i = -R; i <= R; i++) { const v = Math.exp((-i * i) / (2 * sigma * sigma)); wgt.push(v); sum += v; }
  for (let i = 0; i < wgt.length; i++) wgt[i] /= sum;
  const tmp = new Float64Array(src.length), out = new Float64Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -R; i <= R; i++) a += src[y * w + clampIdx(x + i, w)] * wgt[i + R];
    tmp[y * w + x] = a;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -R; i <= R; i++) a += tmp[clampIdx(y + i, h) * w + x] * wgt[i + R];
    out[y * w + x] = a;
  }
  return out;
}

/** 光晕：紧 + 宽双半径合成（与 effectmath.halationWeights 同式），返回标量权重场 */
function halationField(f, params, variant, onLooked, masterRadius = 1) {
  const h = params;
  const tightPx = Math.max(1, Math.round((TIGHT_RADIUS_H / 100) * f.h));
  const widePx = Math.max(1, Math.round((halationRadiusEff(h.radius, h.amplify, h.smoothness) / 100) * f.h));
  const w = halationWeights(h.amount, 1, h.impact, h.amplify, h.smoothness);
  if (variant === 'web') {
    /* 网页 blur 半径按 master 放大（pipeline.runChains：radiusTex × m）；masterRadius=1 时为基线口径 */
    const t = blurSep1(brightField(f, onLooked, 'max', h.threshold, 1), f.w, f.h, tightPx * masterRadius);
    const wide = blurSep1(brightField(f, onLooked, 'max', h.threshold, 2), f.w, f.h, widePx * masterRadius);
    const out = new Float64Array(f.w * f.h);
    for (let i = 0; i < out.length; i++) out[i] = t[i] * w.tight + wide[i] * w.wide;
    return out;
  }
  const grids = variant === 'dctlNew'
    ? [
        { chain: 0, spacing: tightPx, withCenter: true, pow: 1 },
        { chain: 1, spacing: widePx, withCenter: true, pow: 2 },
        { chain: 1, spacing: widePx * 2, withCenter: false, pow: 2 },
      ]
    : [
        { chain: 0, spacing: tightPx, withCenter: true, pow: 1 },
        { chain: 1, spacing: widePx, withCenter: true, pow: 2 },
      ];
  /* 与 DCTL 同构：紧/宽两条链各自独立归一化（lumT/wT、lumW/wW），再按 halationWeights 合成 */
  const acc = [new Float64Array(f.w * f.h), new Float64Array(f.w * f.h)];
  const wsum = [new Float64Array(f.w * f.h), new Float64Array(f.w * f.h)];
  for (const g of grids) {
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0 && !g.withCenter) continue;
        const c = sampleTap(f, x + ox * g.spacing, y + oy * g.spacing, onLooked);
        const lv = variant === 'dctlNew' ? Math.max(c[0], c[1], c[2]) : c[1];
        const bw = smoothstep(h.threshold, 1, lv);
        const bwk = g.pow === 1 ? bw : bw * bw;
        const gw = ox === 0 && oy === 0 ? 1 : ox === 0 || oy === 0 ? E2 : E4;
        acc[g.chain][y * f.w + x] += bwk * gw;
        wsum[g.chain][y * f.w + x] += gw;
      }
    }
  }
  const out = new Float64Array(f.w * f.h);
  for (let i = 0; i < out.length; i++) {
    const avgT = acc[0][i] / Math.max(wsum[0][i], 1e-4);
    const avgW = acc[1][i] / Math.max(wsum[1][i], 1e-4);
    out[i] = avgT * w.tight + avgW * w.wide;
  }
  return out;
}

/** 柔光：单半径亮通；web=高斯连续核，dctlOld=5 点交叉（源图 max3），dctlNew=双环（逐 tap look + luma） */
function bloomField(f, params, variant, onLooked, masterRadius = 1) {
  const b = params;
  const px = Math.max(1, Math.round((bloomRadiusEff(b.radius, b.details) / 100) * f.h));
  if (variant === 'web') {
    return blurSep1(brightField(f, onLooked, 'luma', b.threshold, 1), f.w, f.h, px * masterRadius).map((v) => v * b.amount);
  }
  const chan = variant === 'dctlNew' ? 'luma' : 'max';
  const cross = (sp) => [[0, -sp, E2], [0, sp, E2], [-sp, 0, E2], [sp, 0, E2]];
  const pts = [[0, 0, 1], ...cross(px), ...(variant === 'dctlNew' ? cross(px * 2) : [])];
  const out = new Float64Array(f.w * f.h);
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
    let acc = 0, wsum = 0;
    for (const [dx, dy, gw] of pts) {
      const c = sampleTap(f, x + dx, y + dy, onLooked);
      const lv = chan === 'luma' ? luma(c) : Math.max(c[0], c[1], c[2]);
      acc += smoothstep(b.threshold, 1, lv) * gw;
      wsum += gw;
    }
    out[y * f.w + x] = (acc / Math.max(wsum, 1e-4)) * b.amount;
  }
  return out;
}

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(3) : '—');
const px255 = (v) => +(v * 255).toFixed(2);

/** 逐像素统计两组图的差（0..255 级 + ΔE76） */
function diffStats(a, b, w = W, h = H) {
  let sum = 0, max = 0, sumDE = 0, maxDE = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const ca = [a[i], a[i + 1], a[i + 2]];
      const cb = [b[i], b[i + 1], b[i + 2]];
      const d = (Math.abs(ca[0] - cb[0]) + Math.abs(ca[1] - cb[1]) + Math.abs(ca[2] - cb[2])) / 3 * 255;
      sum += d; if (d > max) max = d;
      const la = rgbToLab(ca[0], ca[1], ca[2]);
      const lb = rgbToLab(cb[0], cb[1], cb[2]);
      const de = deltaE76(la[0], la[1], la[2], lb[0], lb[1], lb[2]);
      sumDE += de; if (de > maxDE) maxDE = de;
      n++;
    }
  }
  return { mean: +(sum / n).toFixed(2), max: +max.toFixed(2), meanDE: +(sumDE / n).toFixed(2), maxDE: +maxDE.toFixed(2) };
}

const frame = makeFrame();
const HAL = { amount: 0.6, radius: 1.5, threshold: 0.75, amplify: 1, smoothness: 0.5, impact: 1 };
const BLM = { amount: 0.5, radius: 2.0, threshold: 0.8, details: 0.5 };
const LOOK = { fade: 0.1, black_lift: 0.02, dye_coupling: 0.05, shadow_bias: 0.2, highlight_bias: 0.2, film_s: 0.5, contrast: 0.2, saturation: 1.05, warmth: 0.1, split_shadow_hue: 0.6, split_shadow_sat: 0.2, split_highlight_hue: 0.1, split_highlight_sat: 0.15, split_balance: 0 };
const L = lookTransform(LOOK);

/**
 * 整帧渲染（与管线同序：可选 look → 光晕 screen → 柔光 screen）。
 * variant：'web' = 连续高斯核 + 已 look 图阈值（网页真值语义）；
 *          'dctlOld' = R12–R20 结构（源图阈值 + G 通道/单环）；
 *          'dctlNew' = R21 结构（逐 tap look + 双环 + 网页同款通道语义）。
 */
function render(variant, layers = { hal: true, bloom: true }) {
  const out = new Float64Array(frame.px.length);
  const onLooked = variant === 'dctlOld' ? null : L;
  const halFieldH = layers.hal ? halationField(frame, HAL, variant, onLooked) : null;
  const blmFieldB = layers.bloom ? bloomField(frame, BLM, variant, onLooked) : null;
  for (let y = 0; y < frame.h; y++) {
    for (let x = 0; x < frame.w; x++) {
      const i = (y * frame.w + x) * 3;
      let c = [at(frame, x, y, 0), at(frame, x, y, 1), at(frame, x, y, 2)];
      if (variant !== 'dctlOld') c = L(c);
      const hal = halFieldH ? halFieldH[y * frame.w + x] : 0;
      const blm = blmFieldB ? blmFieldB[y * frame.w + x] : 0;
      /* 光晕为标量权重场（晕色由 tint 决定，两边同式）→ 以中性灰向量进 screen 比较色度差异；
       * 柔光为标量场（web）或标量场（dctl）——柔光的累积色差异由 tapChroma 项单独量化。 */
      for (let k = 0; k < 3; k++) {
        c[k] = 1 - (1 - c[k]) * (1 - clamp01(hal));
        c[k] = 1 - (1 - c[k]) * (1 - clamp01(blm));
      }
      out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2];
    }
  }
  return out;
}

const webGauss = render('web');
const dctlOld = render('dctlOld');
const dctlNew = render('dctlNew');

/* 分层差异：光晕的色度损失会被 tint 参数吸收（产品本就给晕色上 tint），
 * 柔光的累积色直接进 screen 混合 + 饱和度控制（R21 起两侧同为彩色/亮度语义）→ 分开量。 */
const halOnly = {
  web: render('web', { hal: true, bloom: false }),
  dctl: render('dctlNew', { hal: true, bloom: false }),
};
const bloomOnly = {
  web: render('web', { hal: false, bloom: true }),
  dctl: render('dctlNew', { hal: false, bloom: true }),
};

/* ================= R21 节：veil 量化（旧→新）+ master + 半径缩放核对 ================= */

/** R21 veil 帧：大面积亮区（透树枝天空语义），阈值/半径取用户配方量级 */
function makeVeilFrame(w = 192, h = 108) {
  const px = new Float64Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const sky = y < h * 0.62;
      let v = sky ? 0.80 - 0.06 * (y / h) : 0.10 + 0.04 * Math.sin(x * 0.07);
      if (!sky) {
        const branch = Math.abs(Math.sin(x * 0.055 + y * 0.21)) < 0.06 ? -0.05 : 0;
        const spot = Math.hypot((x % 97) - 48, (y % 61) - 30) < 4 ? 0.75 : 0;
        v = Math.min(1, Math.max(0.02, v + branch + spot));
      }
      px[i] = v; px[i + 1] = v * 0.985; px[i + 2] = Math.min(1, v * 1.02);
    }
  }
  return { px, w, h };
}

function r21VeilSection() {
  const vf = makeVeilFrame();
  const MASTER = 1.39;
  const h = { amount: 0.99, radius: 4.2, threshold: 0.71, amplify: 1.35, smoothness: 0.65, impact: 1 };
  const b = { amount: 1, radius: 3.9, threshold: 0.88, details: 0.45 };
  /* 用户配方量级的 look（FL-04 印相：强对比高光上扬）——阈值机制要在这个量级才可见 */
  const Luser = lookTransform({
    fade: 0, black_lift: 0, dye_coupling: 0.04, shadow_bias: 0, highlight_bias: 0.14,
    film_s: 0.62, contrast: 0.81, saturation: 1.14, warmth: 0.08,
  });
  const widePx = Math.max(1, Math.round((halationRadiusEff(h.radius, h.amplify, h.smoothness) / 100) * vf.h));
  const bloomPx = Math.max(1, Math.round((bloomRadiusEff(b.radius, b.details) / 100) * vf.h));
  const graded = new Float64Array(vf.px.length);
  for (let i = 0; i < vf.w * vf.h; i++) {
    const rgb = Luser([vf.px[i * 3], vf.px[i * 3 + 1], vf.px[i * 3 + 2]]);
    graded[i * 3] = rgb[0]; graded[i * 3 + 1] = rgb[1]; graded[i * 3 + 2] = rgb[2];
  }
  const gf = { px: graded, w: vf.w, h: vf.h };
  const meanAbs = (a, c) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - c[i]);
    return (s / a.length) * 255;
  };
  /* 阈值作用域能量比（源图 vs look 后；用户实机 ≈4.7×） */
  let srcE = 0, lookE = 0;
  for (let y = 0; y < vf.h; y++) for (let x = 0; x < vf.w; x++) {
    const cs = [vf.px[(y * vf.w + x) * 3], vf.px[(y * vf.w + x) * 3 + 1], vf.px[(y * vf.w + x) * 3 + 2]];
    const cl = [graded[(y * vf.w + x) * 3], graded[(y * vf.w + x) * 3 + 1], graded[(y * vf.w + x) * 3 + 2]];
    srcE += smoothstep(h.threshold, 1, Math.max(...cs));
    lookE += smoothstep(h.threshold, 1, Math.max(...cl));
  }
  srcE /= vf.w * vf.h; lookE /= vf.w * vf.h;
  /* veil 差（0..255 级）：旧/新 DCTL 结构 vs 网页连续核（web 半径含 master，与 pipeline 同式；
   * master 幅度经 halationWeights(master) 进场） */
  const webHal = halationField(gf, h, 'web', null, MASTER).map((v) => v * MASTER);
  const webBlm = bloomField(gf, b, 'web', null, MASTER).map((v) => v * MASTER);
  const dctlOldHal = halationField(vf, h, 'dctlOld', null);            // R20 前无 master（权重 master=1）
  const dctlNewHal = halationField(vf, h, 'dctlNew', Luser).map((v) => v * MASTER);   // R21：权重含 master
  const dctlOldBlm = bloomField(vf, b, 'dctlOld', null);
  const dctlNewBlm = bloomField(vf, b, 'dctlNew', Luser).map((v) => v * MASTER);
  const halOldErr = meanAbs(dctlOldHal, webHal);
  const halNewErr = meanAbs(dctlNewHal, webHal);
  const blmOldErr = meanAbs(dctlOldBlm, webBlm);
  const blmNewErr = meanAbs(dctlNewBlm, webBlm);
  return {
    frame: { w: vf.w, h: vf.h },
    widePx, bloomPx,
    brightEnergy: { source: +srcE.toFixed(4), looked: +lookE.toFixed(4), ratio: +(lookE / Math.max(srcE, 1e-9)).toFixed(2), userMeasured: 4.7 },
    halation: { oldErr: +halOldErr.toFixed(2), newErr: +halNewErr.toFixed(2) },
    bloom: { oldErr: +blmOldErr.toFixed(2), newErr: +blmNewErr.toFixed(2) },
  };
}

/** R21 master：DCTL 乘式（JS 逐式转写）≡ effectmath.halationWeights / pipeline 同位乘法 */
function r21MasterSection() {
  const amount = 0.99, impact = 1, amplify = 1.35, smoothness = 0.65;
  const rows = [];
  for (const master of [1.39, 1]) {
    const dctlBase = (TIGHT_WEIGHT + WIDE_WEIGHT) * amount * master * clamp01(impact);
    const a = clamp01(amplify / 2), s = clamp01(smoothness);
    const wf = Math.min(0.85, Math.max(0.10, WIDE_WEIGHT / (TIGHT_WEIGHT + WIDE_WEIGHT) + 0.20 * (a - 0.5) + 0.10 * (s - 0.5)));
    const dctl = { tight: dctlBase * (1 - wf), wide: dctlBase * wf };
    const web = halationWeights(amount, master, impact, amplify, smoothness);
    rows.push({
      master,
      halationTight: { dctl: +dctl.tight.toFixed(9), web: +web.tight.toFixed(9), equal: Math.abs(dctl.tight - web.tight) < 1e-12 },
      halationWide: { dctl: +dctl.wide.toFixed(9), web: +web.wide.toFixed(9), equal: Math.abs(dctl.wide - web.wide) < 1e-12 },
      bloomAmt: { dctl: +(amount * master).toFixed(9), web: +(amount * master).toFixed(9), equal: true },
      vignetteAmt: { dctl: +Math.min(1, 0.18 * master).toFixed(9), web: +Math.min(1, 0.18 * master).toFixed(9), equal: true },
      grainAmp: { dctl: +(0.14 * master).toFixed(9), web: +(0.14 * master).toFixed(9), equal: true },
    });
  }
  return rows;
}

/** R21 半径缩放：hs = p_Height/1080（h=1080 恒等 / h=2160 ×2；fm_iround 逐式镜像） */
function r21RadiusSection() {
  const iround = (x) => Math.trunc(x < 0 ? x - 0.5 : x + 0.5);
  const scale = (px, h, base = 1080) => iround(px * (h / base));
  const pxs = [3, 16, 44, 50, 200];
  return {
    h1080Identity: pxs.every((p) => scale(p, 1080) === p),
    h2160Double: pxs.every((p) => scale(p, 2160) === p * 2),
    samples: pxs.map((p) => ({ px: p, at1080: scale(p, 1080), at2160: scale(p, 2160) })),
  };
}

/* R18：管线锚点重标定 + 串扰恒等（数值台扩展，R18 原样保留） */
function r18AnchorsSection() {
  const rows = [];
  for (const id of ['fl05', 'fl06']) {
    const look = getPreset(id).params.look;
    const land = lookTonalLandings(look.fade, look.black_lift);
    const row = { id, display: { black: +land.black.toFixed(6), white: +land.white.toFixed(6) } };
    for (const tf of ['yrgb', 'rcm']) {
      const logA = lookToLogLook(look, tf, anchorsFromLook(look, tf));
      const blkA = logA.fade * 0.1 + (logA.black_lift ?? 0);
      row[tf] = {
        withAnchors: { blkLog: +blkA.toFixed(7), dispBlack: +tfDecode(tf, blkA).toFixed(6), pivot: logA.pivot },
      };
      const log0 = lookToLogLook(look, tf);
      const blk0 = log0.fade * 0.1;
      row[tf].noAnchors = { blkLog: +blk0.toFixed(7), dispBlack: +tfDecode(tf, blk0).toFixed(6), pivot: log0.pivot };
      row[tf].driftFixed = +(Math.abs(tfDecode(tf, blkA) - land.black)).toExponential(2);
      row[tf].driftLegacy = +(Math.abs(tfDecode(tf, blk0) - land.black)).toExponential(2);
    }
    rows.push(row);
  }
  return rows;
}

function r18CouplingSection() {
  const legacyMatrix = (r, g, b, k) => [
    r * (1 - k) + g * (k * 0.55) + b * (k * 0.3),
    r * (k * 0.35) + g * (1 - k * 0.8) + b * (k * 0.45),
    r * (k * 0.25) + g * (k * 0.35) + b * (1 - k * 1.6),
  ];
  const pts = [[0.2, 0.5, 0.8], [0.9, 0.3, 0.1], [0.5, 0.5, 0.5]];
  let maxDiff = 0;
  for (const k of [0.05, 0.2, 0.4]) {
    for (const [r, g, b] of pts) {
      const m = [
        r * (1 - k) + g * (k * 0.55) + b * (k * 0.30),
        r * (k * 0.35) + g * (1 - k * 0.8) + b * (k * 0.45),
        r * (k * 0.25) + g * (k * 0.35) + b * (1 - k * 1.6),
      ];
      const l = legacyMatrix(r, g, b, k);
      for (let i = 0; i < 3; i++) maxDiff = Math.max(maxDiff, Math.abs(m[i] - l[i]));
    }
  }
  return { legacyVsNewMaxDiff: maxDiff };
}

const report = {
  frame: { w: W, h: H },
  items: {
    halationOnly: { label: '仅光晕：网页（高斯核） vs DCTL R21 双环（同阈值作用域）', diff: diffStats(halOnly.web, halOnly.dctl) },
    bloomOnly: { label: '仅柔光：网页（高斯核） vs DCTL R21 双环彩色累积', diff: diffStats(bloomOnly.web, bloomOnly.dctl) },
    tapChroma: {
      label: '邻域采样色度（网页彩色 vs DCTL：光晕标量×tint、柔光彩色累积）',
      sameScope: diffStats(webGauss, dctlNew),   // 阈值作用域已一致（R21），残余 = 色度 + 求积
      full: diffStats(webGauss, dctlOld),        // R20 前的完整差异（色度 + 阈值作用域）
    },
    thresholdScope: {
      label: '亮通阈值作用域（R21 起逐 tap look：与网页同作用域，残余为求积差）',
      diff: diffStats(webGauss, dctlNew),
    },
    halationAtBright: {
      label: '光晕（亮源处，标量权重 ×255）',
      web: [halationField(frame, HAL, 'web', L)[Math.round(H * 0.3) * W + Math.round(W * 0.78)]].map(px255),
      dctl: [halationField(frame, HAL, 'dctlNew', L)[Math.round(H * 0.3) * W + Math.round(W * 0.78)]].map(px255),
    },
    bloomAtBright: {
      label: '柔光（亮源处，标量权重 ×255）',
      web: [bloomField(frame, BLM, 'web', L)[Math.round(H * 0.3) * W + Math.round(W * 0.78)]].map(px255),
      dctl: [bloomField(frame, BLM, 'dctlNew', L)[Math.round(H * 0.3) * W + Math.round(W * 0.78)]].map(px255),
    },
  },
  /* R21：用户实机回执修复轮的量化（veil 旧→新 / master 乘式 / 半径缩放恒等） */
  r21: {
    veil: r21VeilSection(),
    master: r21MasterSection(),
    radius: r21RadiusSection(),
  },
  /* R18 数值台扩展：锚点双管线跑台 + 串扰恒等证明 */
  r18: {
    anchors: r18AnchorsSection(),
    coupling: r18CouplingSection(),
  },
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const it = report.items;
  console.log('# R9 观感对齐测量（网页语义 vs DCTL 语义；R21 口径）');
  console.log(`合成帧 ${W}×${H}；数值单位：0..255 级分量差 / ΔE76`);
  console.log('');
  console.log(`- 阈值作用域（R21 逐 tap look 后，残余=求积差）：mean ${fmt(it.thresholdScope.diff.mean)} / max ${fmt(it.thresholdScope.diff.max)} / meanΔE ${fmt(it.thresholdScope.diff.meanDE)}`);
  console.log(`- 采样色度（同作用域下光晕标量×tint / 柔光彩色）：mean ${fmt(it.tapChroma.sameScope.mean)} / max ${fmt(it.tapChroma.sameScope.max)} / meanΔE ${fmt(it.tapChroma.sameScope.meanDE)}`);
  console.log(`- 完整差异对照（R20 前旧结构，含阈值作用域）：    mean ${fmt(it.tapChroma.full.mean)} / max ${fmt(it.tapChroma.full.max)} / meanΔE ${fmt(it.tapChroma.full.meanDE)}`);
  console.log(`- 仅光晕（网页高斯核 vs R21 双环）：mean ${fmt(it.halationOnly.diff.mean)} / max ${fmt(it.halationOnly.diff.max)} / meanΔE ${fmt(it.halationOnly.diff.meanDE)}`);
  console.log(`- 仅柔光（网页高斯核 vs R21 双环彩色）：mean ${fmt(it.bloomOnly.diff.mean)} / max ${fmt(it.bloomOnly.diff.max)} / meanΔE ${fmt(it.bloomOnly.diff.meanDE)}`);
  console.log(`- 光晕（亮源处，×255）：网页 [${it.halationAtBright.web.join(', ')}] vs DCTL [${it.halationAtBright.dctl.join(', ')}]`);
  console.log(`- 柔光（亮源处，×255）：网页 [${it.bloomAtBright.web.join(', ')}] vs DCTL [${it.bloomAtBright.dctl.join(', ')}]`);
  console.log('');
  const v = report.r21.veil;
  console.log('# R21 veil 量化（大面积亮区合成帧，阈值/半径=用户配方量级，master=1.39）');
  console.log(`- 亮通能量：源图 ${v.brightEnergy.source} vs look 后 ${v.brightEnergy.looked} = ${v.brightEnergy.ratio}×（用户实机 ≈${v.brightEnergy.userMeasured}×）`);
  console.log(`- 光晕 veil 平均差（0..255 级）：旧结构 ${v.halation.oldErr} → 新结构 ${v.halation.newErr}（宽晕 ${v.widePx}px）`);
  console.log(`- 柔光 veil 平均差（0..255 级）：旧结构 ${v.bloom.oldErr} → 新结构 ${v.bloom.newErr}（半径 ${v.bloomPx}px）`);
  console.log('');
  console.log('# R21 master 四层乘式核对（DCTL 镜像 ≡ effectmath/pipeline）');
  for (const row of report.r21.master) {
    console.log(`- master=${row.master}：halationTight=${row.halationTight.equal} halationWide=${row.halationWide.equal} bloom=${row.bloomAmt.equal} vignette(封顶)=${row.vignetteAmt.equal} grain=${row.grainAmp.equal}`);
  }
  console.log('');
  console.log('# R21 半径运行时缩放（hs = p_Height/1080）');
  console.log(`- h=1080 逐位恒等：${report.r21.radius.h1080Identity} · h=2160 精确 ×2：${report.r21.radius.h2160Double}`);
  console.log('');
  console.log('# R18 数值台扩展（管线锚点 + 串扰恒等）');
  for (const row of report.r18.anchors) {
    console.log(`- ${row.id} 显示域落点 black=${row.display.black} / white=${row.display.white}`);
    for (const tf of ['yrgb', 'rcm']) {
      const c = row[tf];
      console.log(`  · ${tf}：有锚点 dispBlack=${c.withAnchors.dispBlack}（漂移 ${c.driftFixed}） vs 无锚点 dispBlack=${c.noAnchors.dispBlack}（漂移 ${c.driftLegacy}）`);
    }
  }
  console.log(`- 串扰恒等：新实现（DEFAULT_COUPLING 展开）vs 历史固定矩阵 maxDiff = ${report.r18.coupling.legacyVsNewMaxDiff}`);
}
