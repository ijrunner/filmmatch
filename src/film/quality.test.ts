/**
 * R10-B 质感降分辨率：质量档选择逻辑 + 观感差异量化（node 纯计算）。
 *
 * - 选择逻辑：selectQuality 覆盖 webgl2/webgl1/cpu × 探测成功/失败 × 请求档位；
 * - 观感差异：用可分离高斯（与 pipeline CPU 后端同式）对比「全分辨率模糊」与
 *   「降采样 → 模糊 → 上采样」在低频宽域模糊上的逐像素差，给出可复现的量化数字。
 *   （宽域模糊本身是低频 → 降采样损失很小，这正是降分辨率可行的前提。）
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RT_SCALE, normalizeRtScale, qualityLabel, selectQuality, type RtScale,
} from './quality';

describe('R10-B 质量档选择（selectQuality）', () => {
  it('WebGL2 + 降分辨率 FBO 可用 + 浮点色缓 → 采用请求档位（默认 1/4）', () => {
    const q = selectQuality({ backend: 'webgl2', requested: 0.25, reducedFboComplete: true, floatRenderTarget: true });
    expect(q.rtScale).toBe(0.25);
    expect(q.bloomScale).toBe(0.125);
    expect(q.degraded).toBe(false);
    expect(q.reason).toBe('reduced-rt-float');
  });

  it('WebGL1 + 仅 RGBA8 色缓 → 仍走降分辨率（原因标注 rgba8，不降级）', () => {
    const q = selectQuality({ backend: 'webgl1', requested: 0.5, reducedFboComplete: true, floatRenderTarget: false });
    expect(q.rtScale).toBe(0.5);
    expect(q.bloomScale).toBe(0.25);
    expect(q.degraded).toBe(false);
    expect(q.reason).toBe('reduced-rt-rgba8');
  });

  it('降分辨率 FBO 探测失败 → 退回全分辨率并给出原因', () => {
    const q = selectQuality({ backend: 'webgl1', requested: 0.25, reducedFboComplete: false, floatRenderTarget: false });
    expect(q.rtScale).toBe(1);
    expect(q.bloomScale).toBe(1);
    expect(q.degraded).toBe(true);
    expect(q.reason).toBe('reduced-rt-unavailable');
  });

  it('CPU 后端 → 不走 GL 降分辨率 RT 路径（rtScale=1）', () => {
    const q = selectQuality({ backend: 'cpu', requested: 0.25, reducedFboComplete: true, floatRenderTarget: true });
    expect(q.rtScale).toBe(1);
    expect(q.degraded).toBe(true);
    expect(q.reason).toBe('cpu-backend');
  });

  it('档位收敛：非法请求值回落默认 0.25；1 / 0.5 / 0.25 均合法', () => {
    expect(DEFAULT_RT_SCALE).toBe(0.25);
    expect(normalizeRtScale(0.3)).toBe(0.25);
    expect(normalizeRtScale(undefined)).toBe(0.25);
    for (const s of [1, 0.5, 0.25] as RtScale[]) expect(normalizeRtScale(s)).toBe(s);
    expect(selectQuality({ backend: 'webgl2', requested: normalizeRtScale(0.33), reducedFboComplete: true, floatRenderTarget: false }).rtScale).toBe(0.25);
  });

  it('标签：全分辨率降级 / 1-2 / 1-4 三态可辨', () => {
    expect(qualityLabel({ rtScale: 1, degraded: true })).toContain('降级');
    expect(qualityLabel({ rtScale: 1, degraded: false })).toContain('全分辨率');
    expect(qualityLabel({ rtScale: 0.5, degraded: false })).toContain('1/2');
    expect(qualityLabel({ rtScale: 0.25, degraded: false })).toContain('1/4');
  });
});

/* ---------------- 观感差异量化：全分辨率 vs 降分辨率宽域模糊 ---------------- */

/** 可分离高斯（clamp-to-edge），与 pipeline CPU 后端 blurSep 同式 */
function blur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const R = Math.max(1, Math.ceil(sigma * 2.5));
  const wgt = new Float32Array(2 * R + 1);
  let sum = 0;
  for (let i = -R; i <= R; i++) { const v = Math.exp(-i * i / (2 * sigma * sigma)); wgt[i + R] = v; sum += v; }
  for (let i = 0; i < wgt.length; i++) wgt[i] /= sum;
  const tmp = new Float32Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -R; i <= R; i++) { const xx = Math.min(w - 1, Math.max(0, x + i)); a += src[y * w + xx] * wgt[i + R]; }
    tmp[y * w + x] = a;
  }
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -R; i <= R; i++) { const yy = Math.min(h - 1, Math.max(0, y + i)); a += tmp[yy * w + x] * wgt[i + R]; }
    out[y * w + x] = a;
  }
  return out;
}

/** 平均池化下采样（scale 为整数因子） */
function downsample(src: Float32Array, w: number, h: number, f: number): { buf: Float32Array; w: number; h: number } {
  const dw = Math.max(1, Math.floor(w / f)), dh = Math.max(1, Math.floor(h / f));
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    let s = 0, n = 0;
    for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) {
      const sx = Math.min(w - 1, x * f + i), sy = Math.min(h - 1, y * f + j);
      s += src[sy * w + sx]; n++;
    }
    out[y * dw + x] = s / n;
  }
  return { buf: out, w: dw, h: dh };
}

/** 双线性上采样回原尺寸（与 GL LINEAR 上采样同语义） */
function upsample(src: Float32Array, w: number, h: number, W: number, H: number): Float32Array {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const fx = (x + 0.5) * w / W - 0.5, fy = (y + 0.5) * h / H - 0.5;
    const x0 = Math.min(w - 1, Math.max(0, Math.floor(fx))), y0 = Math.min(h - 1, Math.max(0, Math.floor(fy)));
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const tx = Math.min(1, Math.max(0, fx - x0)), ty = Math.min(1, Math.max(0, fy - y0));
    const a = src[y0 * w + x0] * (1 - tx) + src[y0 * w + x1] * tx;
    const b = src[y1 * w + x0] * (1 - tx) + src[y1 * w + x1] * tx;
    out[y * W + x] = a * (1 - ty) + b * ty;
  }
  return out;
}

describe('R10-B 观感差异量化（全分辨率 vs 降分辨率宽域模糊）', () => {
  const W = 192, H = 192;
  const mk = (): Float32Array => {
    const a = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const g = Math.exp(-((x - 96) ** 2 + (y - 96) ** 2) / (2 * 8 * 8));   // 亮斑（宽域晕的来源）
      a[y * W + x] = 0.02 + 0.06 * (x / W) + 0.9 * g;                       // 暗背景 + 轻微梯度
    }
    return a;
  };

  it('1/4 RT：宽域模糊（σ=24px 全分辨率 → σ=6px@1/4）平均差 < 2/255，最大差 < 24/255', () => {
    const img = mk();
    const full = blur(img, W, H, 24);
    const { buf, w, h } = downsample(img, W, H, 4);
    const reduced = upsample(blur(buf, w, h, 6), w, h, W, H);
    let sum = 0, max = 0;
    for (let i = 0; i < full.length; i++) { const d = Math.abs(full[i] - reduced[i]); sum += d; if (d > max) max = d; }
    const mean = sum / full.length;
    console.info(`[R10-B 观感] 1/4 RT 宽域模糊：平均差=${mean.toFixed(5)}（${(mean * 255).toFixed(2)}/255）最大差=${max.toFixed(5)}（${(max * 255).toFixed(2)}/255）`);
    expect(mean).toBeLessThan(2 / 255);
    expect(max).toBeLessThan(24 / 255);
  });

  it('1/2 RT 差异更小（更保守档位）', () => {
    const img = mk();
    const full = blur(img, W, H, 24);
    const { buf, w, h } = downsample(img, W, H, 2);
    const reduced = upsample(blur(buf, w, h, 12), w, h, W, H);
    let sum = 0;
    for (let i = 0; i < full.length; i++) sum += Math.abs(full[i] - reduced[i]);
    const mean = sum / full.length;
    console.info(`[R10-B 观感] 1/2 RT 宽域模糊：平均差=${mean.toFixed(5)}（${(mean * 255).toFixed(2)}/255）`);
    expect(mean).toBeLessThan(1 / 255);
  });
});
