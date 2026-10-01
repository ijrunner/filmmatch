/**
 * 质感估算（estimate.ts）验收测试。
 * 全部使用代码合成图（已知噪声水平 / 已知色偏 / 已知错位），恢复值在 ±50% 内为通过。
 */
import { describe, expect, it } from 'vitest';
import { estimateTexture, SIGMA_REF, SPILL_FULL } from './estimate';

/** 可复现伪随机（mulberry32） */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller 高斯噪声 */
function gaussian(r: () => number): number {
  let u = Math.max(1e-9, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface Img {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  cpp: number;
}

function blank(w: number, h: number, cpp: number, rgb: [number, number, number]): Img {
  const data = new Uint8ClampedArray(w * h * cpp);
  for (let i = 0; i < w * h; i++) {
    data[i * cpp] = rgb[0];
    data[i * cpp + 1] = rgb[1];
    data[i * cpp + 2] = rgb[2];
  }
  return { data, width: w, height: h, cpp };
}

function fillRect(img: Img, x0: number, y0: number, w: number, h: number, rgb: [number, number, number], ch?: number): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * img.width + x) * img.cpp;
      if (ch === undefined) {
        for (let c = 0; c < 3; c++) data_or(img, i + c, rgb[c]);
      } else {
        data_or(img, i + ch, rgb[ch]);
      }
    }
  }
}
function data_or(img: Img, idx: number, v: number): void {
  img.data[idx] = v;
}

function addGaussianNoise(img: Img, sigma: number, seed: number): void {
  const r = rng(seed);
  for (let i = 0; i < img.width * img.height; i++) {
    const g = gaussian(r) * sigma;
    const idx = i * img.cpp;
    img.data[idx] = img.data[idx] + g;
    img.data[idx + 1] = img.data[idx + 1] + g;
    img.data[idx + 2] = img.data[idx + 2] + g;
  }
}

/** 3×3 盒式模糊（单通道循环移位实现，用于构造相关噪声） */
function boxBlurChannel(img: Img, ch: number): void {
  const { data, width: w, height: h, cpp } = img;
  const src = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) src[i] = data[i * cpp + ch];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          acc += src[yy * w + xx];
        }
      }
      data[(y * w + x) * cpp + ch] = acc / 9;
    }
  }
}

describe('质感估算 estimateTexture', () => {
  it('grain.iso：已知噪声 σ=8（ISO 基准 σ_ref=' + SIGMA_REF + '）→ iso 恢复 ±50%', () => {
    const img = blank(960, 540, 4, [128, 128, 128]);
    addGaussianNoise(img, 8, 42);
    const { estimate, debug } = estimateTexture(img.data, img.width, img.height);
    const expected = 400 * Math.pow(8 / SIGMA_REF, 2);
    console.info('[grain.iso] σ_est =', debug.noiseSigma, 'ρ1 =', debug.rho1,
      'flat =', debug.flatBlocks, 'iso =', estimate.grain.iso.value, '期望≈', expected.toFixed(0));
    expect(debug.flatBlocks).toBeGreaterThanOrEqual(3);
    // σ 恢复 ±25%（中间量）
    expect(debug.noiseSigma).toBeGreaterThan(6);
    expect(debug.noiseSigma).toBeLessThan(10);
    // iso 恢复 ±50%
    expect(estimate.grain.iso.value).toBeGreaterThan(expected * 0.5);
    expect(estimate.grain.iso.value).toBeLessThan(expected * 1.5);
    expect(estimate.grain.iso.origin).toBe('estimated');
  });

  it('grain.size：白噪声 → 小尺寸；相关噪声（3×3 模糊）→ 尺寸显著增大', () => {
    const white = blank(960, 540, 4, [128, 128, 128]);
    addGaussianNoise(white, 8, 7);
    const estW = estimateTexture(white.data, white.width, white.height);
    expect(estW.estimate.grain.size.value).toBeGreaterThanOrEqual(0.5);
    expect(estW.estimate.grain.size.value).toBeLessThanOrEqual(2.0);

    const corr = blank(960, 540, 4, [128, 128, 128]);
    addGaussianNoise(corr, 12, 7);
    for (const c of [0, 1, 2]) boxBlurChannel(corr, c); // 3×3 盒式模糊 → 水平一阶自相关 ≈ 2/3
    const estC = estimateTexture(corr.data, corr.width, corr.height);
    console.info('[grain.size] 白噪声 size =', estW.estimate.grain.size.value,
      'ρ1 =', estW.debug.rho1, '；相关噪声 size =', estC.estimate.grain.size.value, 'ρ1 =', estC.debug.rho1);
    expect(estC.debug.rho1).toBeGreaterThan(estW.debug.rho1 + 0.15);
    expect(estC.estimate.grain.size.value).toBeGreaterThan(estW.estimate.grain.size.value);
    expect(estC.estimate.grain.size.value).toBeLessThanOrEqual(5);
  });

  it('halation.amount：已知红色溢出（spill=' + 'R−max(G,B)）→ amount 恢复 ±50%；无溢出 → 近零', () => {
    // 有光晕：暗背景 + 白核 + 环形弱红晕（spill = (40−22)/255 ≈ 0.0706）
    const halo = blank(1280, 720, 4, [10, 12, 14]);
    fillRect(halo, 600, 320, 80, 80, [255, 255, 255]);          // 白核（亮区）
    fillRect(halo, 580, 300, 120, 20, [40, 22, 20]);            // 环上
    fillRect(halo, 580, 420, 120, 20, [40, 22, 20]);            // 环下
    fillRect(halo, 580, 320, 20, 100, [40, 22, 20]);            // 环左
    fillRect(halo, 680, 320, 20, 100, [40, 22, 20]);            // 环右
    const { estimate: estH, debug: dbgH } = estimateTexture(halo.data, halo.width, halo.height);
    const spillTrue = (40 - 22) / 255;
    const amountTrue = spillTrue / SPILL_FULL;
    console.info('[halation] spill =', dbgH.spill, 'amount =', estH.halation.amount.value,
      '期望≈', amountTrue.toFixed(3), 'tint =', estH.halation.tint_rgb.value.join(','),
      'radius =', estH.halation.radius.value);
    expect(dbgH.haloPixels).toBeGreaterThan(4);
    expect(estH.halation.amount.value).toBeGreaterThan(amountTrue * 0.5);
    expect(estH.halation.amount.value).toBeLessThan(Math.min(1, amountTrue * 1.5));
    // tint：红主导
    const tint = estH.halation.tint_rgb.value;
    expect(tint[0]).toBeGreaterThanOrEqual(tint[1]);
    expect(tint[0]).toBeGreaterThan(tint[2]);
    // 半径在合法区间
    expect(estH.halation.radius.value).toBeGreaterThanOrEqual(0.6);
    expect(estH.halation.radius.value).toBeLessThanOrEqual(4.5);

    // 无光晕：同样的白核、纯背景 → amount 近零
    const none = blank(1280, 720, 4, [10, 12, 14]);
    fillRect(none, 600, 320, 80, 80, [255, 255, 255]);
    const { estimate: estN, debug: dbgN } = estimateTexture(none.data, none.width, none.height);
    console.info('[halation 无晕] spill =', dbgN.spill, 'amount =', estN.halation.amount.value);
    expect(estN.halation.amount.value).toBeLessThan(0.1);
  });

  it('vignette.chroma_shift：已知 R/B 错位 3px → 恢复 ±50%', () => {
    const w = 960;
    const h = 540;
    const img = blank(w, h, 4, [128, 128, 128]);
    const P = 48; // 与实现一致：min(48, min(w,h)*0.09)
    const inset = 2;
    const S = 32;
    const off = 10;
    const shift = 3;
    const corners: Array<[number, number, number, number]> = [
      [inset, inset, -shift, -shift],
      [w - inset - P, inset, shift, -shift],
      [inset, h - inset - P, -shift, shift],
      [w - inset - P, h - inset - P, shift, shift],
    ];
    // 背景提到 120：白方块用 R/G=200（避免被当作纯加性亮区干扰 halation 无关，这里只测 CA）
    let expected = 0;
    for (const [x0, y0, sx, sy] of corners) {
      fillRect(img, x0 + off, y0 + off, S, S, [200, 200, 128], 0); // R
      fillRect(img, x0 + off, y0 + off, S, S, [128, 200, 128], 1); // G
      fillRect(img, x0 + off + sx, y0 + off + sy, S, S, [128, 128, 200], 2); // B 错位
      const rx = x0 + P / 2 - w / 2;
      const ry = y0 + P / 2 - h / 2;
      const rl = Math.sqrt(rx * rx + ry * ry);
      expected += Math.abs((sx * rx + sy * ry) / rl) / h;
    }
    expected /= corners.length;
    const { estimate, debug } = estimateTexture(img.data, w, h);
    console.info('[chroma_shift] est =', estimate.vignette.chroma_shift.value,
      '期望≈', expected.toFixed(5), '(debug', debug.caShift + ')');
    expect(estimate.vignette.chroma_shift.value).toBeGreaterThan(expected * 0.5);
    expect(estimate.vignette.chroma_shift.value).toBeLessThan(expected * 1.5);
    expect(estimate.vignette.chroma_shift.origin).toBe('estimated');
  });

  it('RGB(3通道) 输入兼容 + 先验回退：无平坦块 → ISO400 先验；洁净平坦 → 低 ISO', () => {
    // 全图强结构（棋盘）：无平坦块 → 回退先验 iso=400
    const cb = blank(640, 360, 4, [60, 60, 60]);
    for (let y = 0; y < cb.height; y++) {
      for (let x = 0; x < cb.width; x++) {
        const v = ((x >> 3) + (y >> 3)) % 2 === 0 ? 40 : 180;
        const i = (y * cb.width + x) * 4;
        cb.data[i] = v; cb.data[i + 1] = v; cb.data[i + 2] = v;
      }
    }
    const r1 = estimateTexture(cb.data, cb.width, cb.height);
    console.info('[先验] flat =', r1.debug.flatBlocks, 'iso =', r1.estimate.grain.iso.value);
    expect(r1.debug.flatBlocks).toBeLessThan(3);
    expect(r1.estimate.grain.iso.value).toBe(400);
    expect(r1.estimate.grain.size.value).toBeGreaterThan(0);

    // 洁净平坦图（无噪声）：测量结果 = 低 ISO（而非先验）
    const img = blank(640, 360, 3, [100, 100, 100]);
    const { estimate, debug } = estimateTexture(img.data, img.width, img.height);
    console.info('[RGB/平坦] iso =', estimate.grain.iso.value, 'σ =', debug.noiseSigma,
      'flat =', debug.flatBlocks, 'caShift =', debug.caShift);
    expect(estimate.grain.iso.value).toBeLessThanOrEqual(100);
    // 非法尺寸 / 长度不符 → 抛错
    expect(() => estimateTexture(new Uint8ClampedArray(10), 0, 10)).toThrow();
    expect(() => estimateTexture(new Uint8ClampedArray(10), 5, 5)).toThrow();
  });
});
