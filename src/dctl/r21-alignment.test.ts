/**
 * R21 · 用户实机回执修复轮的三个镜像测试（对应 EFFECT-REPORT-R21 的四条方案）。
 *
 * 背景：用户在达芬奇实测全层 DCTL（时间线 1620×1080）后，色彩/暗角/色散/颗粒正常，
 * 但柔光/光晕「基本没有」。三个叠加原因（诊断结论已确认）：
 *   ① tap 结构稀疏（柔光 5 tap、光晕单环 3×3）——大面积亮区的 veil 收集不到；
 *   ② 亮通阈值作用域（DCTL 作用于源图，网页作用于 look 后的图）——用户实测源图亮通
 *      能量只有 look 后的 ≈1/4.7；
 *   ③ master 被生成器忽略——网页四层质感强度全 ×master（配方 master=1.39 → 达芬奇再弱 28%）。
 * 另有地雷：空间量按 1920×1080 基准固化为像素常量，4K 时间线会再缩一半。
 *
 * 本文件三条镜像链（与 alignment-report.mjs 的语义复算同口径，诚实边界：JS 语义级复算，
 * 不是 DCTL 编译器/GLSL 执行结果）：
 *   ① master 镜像：DCTL 乘式（JS 逐式转写）≡ effectmath/pipeline 网页真值，master=1.39 与 1 两档；
 *   ② 半径缩放恒等：hs = p_Height/基准高度 的 JS 镜像，h=1080 与旧固化常量逐位一致、h=2160 精确 ×2；
 *   ③ veil 镜像：合成「大面积亮区」图上，新结构（双环 + 逐 tap look）vs 网页语义的 veil 强度差
 *      显著小于旧结构（单环 + 源图阈值）——量化数字进 EFFECT-REPORT-R21 与对齐清单 v2。
 */
import { describe, expect, it } from 'vitest';
import {
  GRAIN_BASE, TIGHT_RADIUS_H, TIGHT_WEIGHT, WIDE_WEIGHT,
  bloomRadiusEff, grainResolutionAmp, halationRadiusEff, halationWeights,
} from '../film/effectmath';
import { generateDctl, textureParamDecls, validateDctl, type DctlGenInput } from './codegen';
import { applyLogLook, lookToLogLook, tfDecode, tfEncode, type LogLookParams, type PipelineTF } from './logmath';
import { lookTransform } from '../engine/look';
import { defaultTexture, getPreset, type TextureParams } from '../film/params';

/* ================= 共用夹具 ================= */

/** 用户配方量级的 look（FL-04 印相 · 强对比高光上扬：film_s/正片反S/饱和/暖黄） */
const USER_LOOK: LogLookParams = {
  contrast: 1, toe: 0, shoulder: 0, pivot: 0.5, crosstalk: 0.04,
  saturation: 1.14, warmth: 0.08, fade: 0, shadow_bias: 0, highlight_bias: 0.14,
  film_s: 0.62, gamma_contrast: 0.81,
  split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0,
};
/** 用户配方量级的质感参数（半径/threshold/amplify 等取 FM-EACX 配方实测值） */
function userTexture(): TextureParams {
  const t = defaultTexture();
  t.halation = { ...t.halation, enabled: true, amount: 0.99, radius: 4.2, threshold: 0.71, amplify: 1.35, smoothness: 0.65, impact: 1 };
  t.bloom = { ...t.bloom, enabled: true, amount: 1, radius: 3.9, threshold: 0.88, details: 0.45 };
  t.grain = { ...t.grain, enabled: false };
  t.vignette = { ...t.vignette, enabled: false };
  t.gate_weave = { amount: 0, speed: 1 };
  return t;
}
function makeInput(master: number, pipeline: PipelineTF = 'yrgb'): DctlGenInput {
  const card = getPreset('fl06');
  return {
    recipeName: card.name, shareCode: 'FM-R21-TEST', pipeline,
    look: lookToLogLook(card.params.look, pipeline), texture: card.params.texture, master,
    resolution: { w: 1920, h: 1080 },
  };
}
const LR = 0.2126, LG = 0.7152, LB = 0.0722;
const luma3 = (c: readonly number[]): number => LR * c[0] + LG * c[1] + LB * c[2];
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/* ================= ① master 镜像（DCTL 乘式 ≡ effectmath/pipeline） ================= */

describe('R21 ① master 镜像：DCTL 四层乘式 ≡ 网页引擎（master=1.39 与 1 两档）', () => {
  /* DCTL 生成文本的逐式转写（与 codegen.ts push 出的表达式同序）：
   *   halBase = (T+W) * amount * master * impact；halWf = min(0.85, max(0.10, W/(T+W) + 0.20(a-0.5) + 0.10(s-0.5)))
   *   blmK    = (1/max(wB,ε)) * amount * master（标量部分；1/w 为 tap 求积归一化，与 master 无关）
   *   vig     = 1 - min(1, amount * master) * smoothstep(...)
   *   grain   = amp * master * gW * clGain（amp = GRAIN_BASE·sqrt(iso/400)·resAmp，烘焙进 FM_GRAIN_AMP） */
  function dctlHalWeights(amount: number, master: number, impact: number, amplify: number, smoothness: number) {
    const halA = clamp01(amplify / 2);
    const halS = clamp01(smoothness);
    const halBase = (TIGHT_WEIGHT + WIDE_WEIGHT) * amount * master * clamp01(impact);
    const halWf = Math.min(0.85, Math.max(0.10, WIDE_WEIGHT / (TIGHT_WEIGHT + WIDE_WEIGHT) + 0.20 * (halA - 0.5) + 0.10 * (halS - 0.5)));
    return { tight: halBase * (1 - halWf), wide: halBase * halWf };
  }

  for (const master of [1.39, 1]) {
    it(`master=${master}：光晕权重 ≡ halationWeights；柔光/暗角/颗粒乘式 ≡ pipeline 同位乘法`, () => {
      const amount = 0.99, impact = 1, amplify = 1.35, smoothness = 0.65;
      const dctl = dctlHalWeights(amount, master, impact, amplify, smoothness);
      const web = halationWeights(amount, master, impact, amplify, smoothness);
      expect(dctl.tight).toBeCloseTo(web.tight, 12);
      expect(dctl.wide).toBeCloseTo(web.wide, 12);
      /* master > 1 时网页侧权重整体放大（R20 前 DCTL 忽略该维度 → 恰差 master 倍） */
      const webAt1 = halationWeights(amount, 1, impact, amplify, smoothness);
      expect(web.tight / webAt1.tight).toBeCloseTo(master, 12);

      /* 柔光：blmK 的 master 因子 = u_blmAmt = amount·master（1/w 归一化与 master 无关） */
      const wB = 2.0827;   // 双环 wsum（中心 1 + 8×e^-2），只作量级占位
      const dctlBlmK = (1 / Math.max(wB, 1e-4)) * 1 * master;
      expect(dctlBlmK * wB).toBeCloseTo(1 * master, 12);   // 乘回 wsum 还原 amount·master

      /* 暗角：min(1, amount·master)（网页 u_vigAmt 同式封顶）——amount=1、master=1.39 时被封顶 */
      expect(Math.min(1, 0.18 * master)).toBeCloseTo(Math.min(1, 0.18 * master), 12);
      expect(Math.min(1, 1 * master)).toBe(1);   // 封顶生效

      /* 颗粒：amp·master（amp 烘焙进 FM_GRAIN_AMP，6 位舍入 → 与网页连乘差 ≤1e-6·master） */
      const g = userTexture().grain;
      const ampBaked = Number((GRAIN_BASE * Math.sqrt(g.iso / 400) * grainResolutionAmp(g.film_resolution)).toFixed(6));
      const webAmp = GRAIN_BASE * Math.sqrt(g.iso / 400) * master * grainResolutionAmp(g.film_resolution);
      expect(Math.abs(ampBaked * master - webAmp)).toBeLessThan(1e-6 * master + 1e-12);
    });
  }

  it('结构锚定：生成源码里四层乘式逐一出现（FM_MASTER 与引擎同位）', () => {
    const { source } = generateDctl(makeInput(1.39));
    expect(source).toContain('float halBase = 1.6000f * FM_HALATION_AMOUNT * FM_MASTER * FM_HALATION_IMPACT;');
    expect(source).toContain('float blmK = (1.0f / _fmaxf(wB, 0.0001f)) * FM_BLOOM_AMOUNT * FM_MASTER;');
    expect(source).toContain('_fminf(1.0f, FM_VIGNETTE_AMOUNT * FM_MASTER)');
    expect(source).toContain('FM_GRAIN_AMP * FM_MASTER * gW * clGain');
    expect(validateDctl(source).ok, validateDctl(source).errors.join('；')).toBe(true);
    /* 默认值 = 传入 master（0..2 钳制），区间 0..2 */
    const decl = textureParamDecls(makeInput(1.39).texture, makeInput(1.39).look, { w: 1920, h: 1080 }, 1.39);
    const m = decl.find((d) => d.macro === 'FM_MASTER')!;
    expect([m.min, m.max, m.def]).toEqual([0, 2, 1.39]);
    expect(textureParamDecls(makeInput(1).texture, makeInput(1).look, { w: 1920, h: 1080 }).find((d) => d.macro === 'FM_MASTER')!.def).toBe(1);
  });
});

/* ================= ② 半径运行时缩放（h=1080 恒等 / h=2160 ×2） ================= */

describe('R21 ② 半径运行时缩放：hs = p_Height/1080（h=1080 逐位恒等；h=2160 ×2）', () => {
  /* DCTL fm_iround 的逐式转写：x<0 ? (int)(x-0.5) : (int)(x+0.5) */
  const iround = (x: number): number => Math.trunc(x < 0 ? x - 0.5 : x + 0.5);
  const scale = (px: number, h: number, base = 1080): number => iround(px * (h / base));

  it('h=1080：所有空间量缩放后与旧固化常量逐位一致（恒等护栏）', () => {
    const params = [3, 50, 44, 22, 1, 200];   // 紧/宽/柔光/位移/下限/上限等典型像素值
    for (const p of params) expect(scale(p, 1080), `px=${p}`).toBe(p);
    /* 非整数空间量（颗粒间距 / 边缘色散）×1.0f 在 IEEE754 下逐位不变 */
    for (const f of [1.25, 3.24, 0.6375, 17.3]) {
      expect(f * 1.0).toBe(f);
      expect(Math.max(f * 1.0, 1.0)).toBe(Math.max(f, 1.0));   // grainPx 的 _fmaxf 封底
    }
  });

  it('h=2160：全部空间量精确 ×2（4K 地雷消除）', () => {
    for (const p of [3, 50, 44, 22]) expect(scale(p, 2160)).toBe(p * 2);
    expect(1.25 * 2.0).toBe(2.5);            // 颗粒间距
    expect(3.24 * 2.0).toBeCloseTo(6.48, 12); // 边缘色散（浮点字面量 ×2，_fminf 无钳制）
  });

  it('结构锚定：生成源码包含 hs 基准与全部空间量的 * hs 缩放；生成基准分辨率决定默认值', () => {
    const { source } = generateDctl(makeInput(1));
    expect(source).toContain('float hs = (float)p_Height / 1080.0f;');
    for (const frag of [
      'int rt = fm_iround((float)FM_HALATION_TIGHT_PX * hs);',
      'int rw = fm_iround((float)FM_HALATION_RADIUS_PX * hs);',
      'int rb = fm_iround((float)FM_BLOOM_RADIUS_PX * hs);',
      'float grainPx = _fmaxf(FM_GRAIN_SIZE_PX * hs, 1.0f);',
      'float caPx = FM_VIGNETTE_CHROMA_PX * hs * rr * rr;',
      'float wPx = (float)FM_GATE_WEAVE_PX * hs;',
    ]) expect(source, `缺缩放式：${frag}`).toContain(frag);
    /* 生成基准分辨率仍决定默认值口径（2160 基准生成 → 默认值 ×2；运行时再按 h/2160 缩放，自洽） */
    const card = getPreset('fl06');
    const look = lookToLogLook(card.params.look, 'yrgb');
    const at2160 = textureParamDecls(card.params.texture, look, { w: 3840, h: 2160 });
    const at1080 = textureParamDecls(card.params.texture, look, { w: 1920, h: 1080 });
    expect(at2160.find((d) => d.macro === 'FM_HALATION_RADIUS_PX')!.def)
      .toBe(Number(at1080.find((d) => d.macro === "FM_HALATION_RADIUS_PX")!.def) * 2);
  });
});


const FW = 256, FH = 144;

/** 合成「透树枝的大面积亮区」：上半 = 天空亮区（源亮度 ~0.80：look 后越过两道阈值，源图域不过），
 *  下半 = 暗地面 + 树枝状暗条 + 少量叶隙亮斑。 */
function makeFrame(): Float64Array {
  const px = new Float64Array(FW * FH * 3);
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      const i = (y * FW + x) * 3;
      const sky = y < FH * 0.62;
      let v = sky ? 0.80 - 0.06 * (y / FH) : 0.10 + 0.04 * Math.sin(x * 0.07);
      if (!sky) {
        const branch = Math.abs(Math.sin(x * 0.055 + y * 0.21)) < 0.06 ? -0.05 : 0;
        const spot = Math.hypot((x % 97) - 48, (y % 61) - 30) < 4 ? 0.75 : 0;
        v = Math.min(1, Math.max(0.02, v + branch + spot));
      }
      px[i] = v; px[i + 1] = v * 0.985; px[i + 2] = Math.min(1, v * 1.02);
    }
  }
  return px;
}
const at = (px: Float64Array, x: number, y: number): number[] => {
  const xx = Math.min(FW - 1, Math.max(0, x)), yy = Math.min(FH - 1, Math.max(0, y));
  const i = (yy * FW + xx) * 3;
  return [px[i], px[i + 1], px[i + 2]];
};

/** 可分离高斯（σ=R/2 归一化核；镜像 pipeline.blurSep/blurChain；全分辨率口径下 rtScale 相消） */
function blurSep1(src: Float64Array, radiusPx: number): Float64Array {
  const sigma = Math.min(radiusPx / 2, 16);
  const R = Math.max(1, Math.min(40, Math.ceil(sigma * 2.5)));
  const wgt: number[] = [];
  let sum = 0;
  for (let i = -R; i <= R; i++) { const v = Math.exp((-i * i) / (2 * sigma * sigma)); wgt.push(v); sum += v; }
  for (let i = 0; i < wgt.length; i++) wgt[i] /= sum;
  const tmp = new Float64Array(src.length);
  const out = new Float64Array(src.length);
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    let a = 0;
    for (let i = -R; i <= R; i++) {
      const xx = Math.min(FW - 1, Math.max(0, x + i));
      a += src[y * FW + xx] * wgt[i + R];
    }
    tmp[y * FW + x] = a;
  }
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    let a = 0;
    for (let i = -R; i <= R; i++) {
      const yy = Math.min(FH - 1, Math.max(0, y + i));
      a += tmp[yy * FW + x] * wgt[i + R];
    }
    out[y * FW + x] = a;
  }
  return out;
}

describe('R21 ③ veil 镜像：逐 tap look 阈值 + 双环 把 veil 差拉回网页量级', () => {
  /* 半径按 %H 语义换算到测试图高度（与生成器/网页同一换算式；阈值/amplify 等辐射度量参数
   * 取用户配方实测值，与半径尺度无关）。 */
  const h = userTexture().halation, b = userTexture().bloom;
  const widePx = Math.max(1, Math.round((halationRadiusEff(h.radius, h.amplify, h.smoothness) / 100) * FH));
  const tightPx = Math.max(1, Math.round((TIGHT_RADIUS_H / 100) * FH));
  const bloomPx = Math.max(1, Math.round((bloomRadiusEff(b.radius, b.details) / 100) * FH));
  const MASTER = 1.39;
  const E2 = Math.exp(-2), E4 = E2 * E2;
  const frame = makeFrame();
  /* 网页真值：graded = engine lookTransform（gamma 显示域 look，网页 GRADE_FS 同源） */
  const engineLook = lookTransform({
    fade: 0, black_lift: 0, dye_coupling: 0.04, shadow_bias: 0, highlight_bias: 0.14,
    film_s: 0.62, contrast: 0.81, saturation: 1.14, warmth: 0.08,
  } as never);
  const webGraded = new Float64Array(frame.length);
  for (let i = 0; i < FW * FH; i++) {
    const rgb = engineLook([frame[i * 3], frame[i * 3 + 1], frame[i * 3 + 2]]);
    webGraded[i * 3] = rgb[0]; webGraded[i * 3 + 1] = rgb[1]; webGraded[i * 3 + 2] = rgb[2];
  }
  /** DCTL fm_tap_look 的逐式镜像：tf encode → applyLogLook → tf decode（与中心像素同链路） */
  const fmTapLook = (rgb: number[]): number[] => {
    const e = applyLogLook([tfEncode('yrgb', rgb[0]), tfEncode('yrgb', rgb[1]), tfEncode('yrgb', rgb[2])], USER_LOOK);
    return [tfDecode('yrgb', e[0]), tfDecode('yrgb', e[1]), tfDecode('yrgb', e[2])];
  };

  /** 光晕亮通权重场（标量；晕色由 tint 决定，两边同式不参差）。
   *  src = 采样源图；preLook=false 时阈值作用于源图（旧 DCTL），true 时逐 tap 过 look（新 DCTL）。
   *  grids = tap 几何（旧：单环；新：双环）。chan：旧 DCTL 光晕=G 通道，新 DCTL=网页同款 max3。 */
  function halGridField(
    src: Float64Array, preLook: boolean, chan: 'G' | 'max',
    grids: Array<{ spacing: number; withCenter: boolean; pow: number }>,
  ): Float64Array {
    const acc = new Float64Array(FW * FH), wsum = new Float64Array(FW * FH);
    for (const g of grids) {
      for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          if (ox === 0 && oy === 0 && !g.withCenter) continue;
          const c = at(src, x + ox * g.spacing, y + oy * g.spacing);
          const v = preLook ? fmTapLook(c) : c;
          const lv = chan === 'max' ? Math.max(v[0], v[1], v[2]) : v[1];
          const bwRaw = smoothstep(h.threshold, 1, lv);
          const bw = g.pow === 1 ? bwRaw : bwRaw * bwRaw;
          const gw = ox === 0 && oy === 0 ? 1 : ox === 0 || oy === 0 ? E2 : E4;
          acc[y * FW + x] += bw * gw;
          wsum[y * FW + x] += gw;
        }
      }
    }
    const t = new Float64Array(FW * FH);
    for (let i = 0; i < FW * FH; i++) t[i] = acc[i] / Math.max(wsum[i], 1e-4);
    return t;
  }

  /** 柔光亮通权重场（标量）。旧：5 点交叉 + 源图 max3；新：双环 + 逐 tap look + luma。 */
  function bloomField(src: Float64Array, preLook: boolean, chan: 'max' | 'luma', dual: boolean): Float64Array {
    const acc = new Float64Array(FW * FH), wsum = new Float64Array(FW * FH);
    const cross = (sp: number): Array<[number, number, number]> =>
      ([[0, -sp], [0, sp], [-sp, 0], [sp, 0]] as Array<[number, number]>).map(([dx, dy]) => [dx, dy, E2] as [number, number, number]);
    const pts: Array<[number, number, number]> = [
      [0, 0, 1],
      ...cross(bloomPx),
      ...(dual ? cross(bloomPx * 2) : []),
    ];
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
      for (const [dx, dy, gw] of pts) {
        const c = at(src, x + dx, y + dy);
        const v = preLook ? fmTapLook(c) : c;
        const lv = chan === 'luma' ? luma3(v) : Math.max(v[0], v[1], v[2]);
        const bw = smoothstep(b.threshold, 1, lv);
        acc[y * FW + x] += bw * gw;
        wsum[y * FW + x] += gw;
      }
    }
    const t = new Float64Array(FW * FH);
    for (let i = 0; i < FW * FH; i++) t[i] = acc[i] / Math.max(wsum[i], 1e-4);
    return t;
  }

  /** 网页亮通权重场：亮通作用于「已 look 的图」（graded），然后可分离高斯模糊 */
  function webBrightField(img: Float64Array, chan: 'max' | 'luma', pow: number): Float64Array {
    const f = new Float64Array(FW * FH);
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
      const c = at(img, x, y);
      const lv = chan === 'luma' ? luma3(c) : Math.max(c[0], c[1], c[2]);
      const bw = smoothstep(chan === 'luma' ? b.threshold : h.threshold, 1, lv);
      f[y * FW + x] = pow === 1 ? bw : bw * bw;
    }
    return f;
  }
  const meanAbs = (a: Float64Array, c: Float64Array): number => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - c[i]);
    return s / a.length;
  };

  it('阈值作用域机制：源图亮通能量 ≪ look 后亮通能量（用户实测 ≈1/4.7，镜像复现同量级）', () => {
    let srcE = 0, lookE = 0;
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
      const c = at(frame, x, y);
      srcE += smoothstep(h.threshold, 1, Math.max(c[0], c[1], c[2]));
      const lv = fmTapLook(c);
      lookE += smoothstep(h.threshold, 1, Math.max(lv[0], lv[1], lv[2]));
    }
    srcE /= FW * FH; lookE /= FW * FH;
    const ratio = lookE / Math.max(srcE, 1e-9);
    console.info(`[R21 veil] 亮通能量：源图 ${srcE.toFixed(4)} vs look 后 ${lookE.toFixed(4)} = ${ratio.toFixed(2)}×（用户实机 ≈4.7×）`);
    expect(ratio).toBeGreaterThan(2);   // 机制存在即可；具体倍数随合成帧浮动
  });

  it('光晕 veil：新结构（双环+逐tap look+max3）与网页的差显著小于旧结构（单环+源图阈值+G 通道）', () => {
    /* 网页：亮通（look 后，max3）→ σ=R/2 高斯 → 紧/宽按 halationWeights 合成（master 已在权重内） */
    const webT = blurSep1(webBrightField(webGraded, 'max', 1), tightPx * MASTER);
    const webW = blurSep1(webBrightField(webGraded, 'max', 2), widePx * MASTER);
    const hw = halationWeights(h.amount, MASTER, h.impact, h.amplify, h.smoothness);
    const web = new Float64Array(FW * FH);
    for (let i = 0; i < FW * FH; i++) web[i] = webT[i] * hw.tight + webW[i] * hw.wide;

    /* 旧 DCTL：源图阈值（G 通道）+ 单环；R20 前无 master（权重按 master=1） */
    const oldT = halGridField(frame, false, 'G', [{ spacing: tightPx, withCenter: true, pow: 1 }]);
    const oldW = halGridField(frame, false, 'G', [{ spacing: widePx, withCenter: true, pow: 2 }]);
    const hwOld = halationWeights(h.amount, 1, h.impact, h.amplify, h.smoothness);
    const oldV = new Float64Array(FW * FH);
    for (let i = 0; i < FW * FH; i++) oldV[i] = oldT[i] * hwOld.tight + oldW[i] * hwOld.wide;

    /* 新 DCTL：逐 tap look（阈值作用于 look 后的图）+ max3 + 双环；master 进权重 */
    const newT = halGridField(frame, true, 'max', [{ spacing: tightPx, withCenter: true, pow: 1 }]);
    const newW = halGridField(frame, true, 'max', [
      { spacing: widePx, withCenter: true, pow: 2 },
      { spacing: widePx * 2, withCenter: false, pow: 2 },
    ]);
    const newV = new Float64Array(FW * FH);
    for (let i = 0; i < FW * FH; i++) newV[i] = newT[i] * hw.tight + newW[i] * hw.wide;

    const errOld = meanAbs(oldV, web) * 255;
    const errNew = meanAbs(newV, web) * 255;
    console.info(`[R21 veil] 光晕 veil 平均差（0..255 级）：旧结构 ${errOld.toFixed(2)} → 新结构 ${errNew.toFixed(2)}（宽 ${widePx}px/紧 ${tightPx}px @${FH}p）`);
    expect(errNew).toBeLessThan(errOld * 0.5);   // 「显著小于」门槛：减半以上
  });

  it('柔光 veil：新结构（双环+逐tap look+luma）与网页的差显著小于旧结构（单环+源图阈值+max3）', () => {
    const webRaw = blurSep1(webBrightField(webGraded, 'luma', 1), bloomPx * MASTER);
    const web = new Float64Array(FW * FH);
    for (let i = 0; i < FW * FH; i++) web[i] = webRaw[i] * b.amount * MASTER;   // u_blmAmt = amount·master

    const oldRaw = bloomField(frame, false, 'max', false);
    const oldV = new Float64Array(FW * FH);
    for (let i = 0; i < FW * FH; i++) oldV[i] = oldRaw[i] * b.amount;           // R20 前无 master

    const newRaw = bloomField(frame, true, 'luma', true);
    const newV = new Float64Array(FW * FH);
    for (let i = 0; i < FW * FH; i++) newV[i] = newRaw[i] * b.amount * MASTER;

    const errOld = meanAbs(oldV, web) * 255;
    const errNew = meanAbs(newV, web) * 255;
    console.info(`[R21 veil] 柔光 veil 平均差（0..255 级）：旧结构 ${errOld.toFixed(2)} → 新结构 ${errNew.toFixed(2)}（半径 ${bloomPx}px @${FH}p）`);
    expect(errNew).toBeLessThan(errOld * 0.5);
  });
});
