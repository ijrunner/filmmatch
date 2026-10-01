/**
 * 质感估算（PRD F5）：从参考图像素估算 grain / halation / vignette.chroma_shift 起点。
 *
 * 纯函数、无 DOM 依赖（vitest 直接跑）。输入 RGBA 或 RGB 字节缓冲。
 * 原则（PRD §7）：估算只给起点、滑杆永远可改、错估可一键重置。
 *
 * 算法：
 * - grain.iso  ：平坦块（结构梯度低，4× 降采样检测）高通方差 → 噪声 σ（8-bit 级）→
 *                ISO = 400·(σ/σ_ref)²（渲染端 ISO √ 响应，ISO400 = 1.0×）。
 * - grain.size ：平坦块去均值一阶自相关 ρ1 → AR(1) 相关长度 s（px）→
 *                size = s/H·1000 ‰（画面高度千分比，与渲染端间距定义一致）。
 * - halation   ：亮区（luma>0.8）膨胀环带内 R−max(G,B) 溢出 → amount；
 *                环带色偏（相对远背景）→ tint_rgb；亮度余量按亮区距离的半衰宽度 → radius %H。
 * - chroma_shift：四角 patch 的 R/B 通道梯度质心径向错位（px）/ 画面高度。
 *
 * 所有返回值带 origin:'estimated'，结构对齐配方 Schema v1 的 texture 包装。
 */

export interface EstVal {
  value: number;
  origin: 'estimated';
}
export interface EstTint {
  value: [number, number, number];
  origin: 'estimated';
}

export interface TextureEstimate {
  grain: { iso: EstVal; size: EstVal };
  halation: { amount: EstVal; radius: EstVal; tint_rgb: EstTint };
  vignette: { chroma_shift: EstVal };
}

/** 估算诊断信息（不进配方，供测试与调试面板） */
export interface EstimateDebug {
  noiseSigma: number;   // 估算噪声 σ（8-bit 级）
  rho1: number;         // 平坦块一阶自相关
  flatBlocks: number;   // 参与统计的平坦块数
  spill: number;        // 亮区环带平均 R−max(G,B)
  haloPixels: number;   // 亮区环带像素数
  caShift: number;      // 四角平均 R/B 质心径向错位（画面高度比例）
}

/* ---------------- 校准常数（与渲染端单位对齐，见 film/params.ts） ---------------- */

/** ISO400 基准噪声 σ（8-bit 级）：渲染端幅度 √(iso/400) ↔ 参考扫描噪声水平的约定映射 */
export const SIGMA_REF = 5.5;
/** 亮区环带平均溢出 0.12 ↔ halation amount 1.0（强光晕标定） */
export const SPILL_FULL = 0.12;
/** 半衰宽度 → 渲染半径的标定系数（分析像素 → %H） */
const RADIUS_GAIN = 2.0;
/** 结构梯度平坦阈值（4× 降采样亮度，级） */
const FLAT_GRAD = 4.0;

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/* ---------------- grain：平坦块噪声 σ + 自相关 ---------------- */

interface GrainResult {
  sigma: number;
  rho1: number;
  flatBlocks: number;
}

function estimateGrain(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  cpp: number,
): GrainResult {
  const B = Math.max(12, Math.min(32, Math.round(Math.min(width, height) / 24)));
  const bw = Math.max(1, Math.floor(width / B));
  const bh = Math.max(1, Math.floor(height / B));

  // 4× 盒式降采样亮度（结构检测用：噪声被平均掉、结构保留）
  const ds = 4;
  const dw = Math.max(1, Math.floor(width / ds));
  const dh = Math.max(1, Math.floor(height / ds));
  const down = new Float32Array(dw * dh);
  const cnt = new Float32Array(dw * dh);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const drow = ((y / ds) | 0) * dw;
    for (let x = 0; x < width; x++) {
      const i = (row + x) * cpp;
      down[drow + Math.min(dw - 1, (x / ds) | 0)] +=
        LUMA_R * data[i] + LUMA_G * data[i + 1] + LUMA_B * data[i + 2];
      cnt[drow + Math.min(dw - 1, (x / ds) | 0)]++;
    }
  }
  for (let i = 0; i < down.length; i++) down[i] /= Math.max(1, cnt[i]);

  let sigmaW = 0; // Σ σ²·像素数
  let wSum = 0;
  let rhoNum = 0;
  let rhoDen = 0;
  let flat = 0;
  const vals = new Float64Array(B * B);

  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const x0 = bx * B;
      const y0 = by * B;
      // 结构梯度（降采样图上）：排除有结构的块，噪声自身梯度在降采样后被抹平
      let grad = 0;
      let gn = 0;
      for (let y = (y0 / ds) | 0; y < Math.min(dh - 1, ((y0 + B) / ds) | 0); y++) {
        for (let x = (x0 / ds) | 0; x < Math.min(dw - 1, ((x0 + B) / ds) | 0); x++) {
          const d = y * dw + x;
          grad += Math.abs(down[d + 1] - down[d]) + Math.abs(down[d + dw] - down[d]);
          gn++;
        }
      }
      if (gn === 0 || grad / gn > FLAT_GRAD) continue;

      // 全分辨率统计：亮度值收进 vals，一次遍历算均值，二次遍历算高通方差与自相关
      let vn = 0;
      let mean = 0;
      const x1 = Math.min(width - 1, x0 + B - 1);
      const y1 = Math.min(height - 1, y0 + B - 1);
      for (let y = y0 + 1; y < y1; y++) {
        for (let x = x0 + 1; x < x1; x++) {
          const i = (y * width + x) * cpp;
          const v = LUMA_R * data[i] + LUMA_G * data[i + 1] + LUMA_B * data[i + 2];
          vals[vn++] = v;
          mean += v;
        }
      }
      if (vn < 40) continue;
      mean /= vn;
      let sv = 0;
      for (let k = 0; k < vn; k++) {
        const hp = vals[k] - mean; // 3×3 均值在平坦块 ≈ 均值本身，高通 = 去均值
        sv += hp * hp;
      }
      flat++;
      // 白噪声时去均值方差 = σ²（块内均值已扣除直流）
      sigmaW += (sv / vn) * vn;
      wSum += vn;

      // 去均值水平一阶自相关（ρ1 → 相关长度）
      let c01 = 0;
      let n0 = 0;
      let n1 = 0;
      for (let y = y0; y < Math.min(height, y0 + B); y++) {
        const row = y * width;
        const lim = Math.min(width - 1, x0 + B - 1);
        for (let x = x0; x < lim; x++) {
          const i = (row + x) * cpp;
          const j = i + cpp;
          const a = LUMA_R * data[i] + LUMA_G * data[i + 1] + LUMA_B * data[i + 2] - mean;
          const b = LUMA_R * data[j] + LUMA_G * data[j + 1] + LUMA_B * data[j + 2] - mean;
          c01 += a * b;
          n0 += a * a;
          n1 += b * b;
        }
      }
      if (n0 > 1e-6 && n1 > 1e-6) {
        rhoNum += c01;
        rhoDen += Math.sqrt(n0 * n1);
      }
    }
  }

  const sigma = wSum > 0 ? Math.sqrt(sigmaW / wSum) : 0;
  const rho1 = rhoDen > 1e-6 ? rhoNum / rhoDen : 0;
  return { sigma, rho1, flatBlocks: flat };
}

/* ---------------- halation：亮区膨胀环带溢出 + 距离半衰宽度 ---------------- */

interface HaloResult {
  spill: number;
  tint: [number, number, number];
  radius: number;
  haloPixels: number;
}

/** 亮区掩码的切比雪夫距离变换（两遍 chamfer，8 邻域 +1 = 精确切比雪夫） */
function chebyshevDT(bright: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const dist = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) dist[p] = bright[p] ? 0 : INF;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let d = dist[p];
      if (d === 0) continue;
      if (y > 0) {
        if (x > 0) d = Math.min(d, dist[p - w - 1] + 1);
        d = Math.min(d, dist[p - w] + 1);
        if (x < w - 1) d = Math.min(d, dist[p - w + 1] + 1);
      }
      if (x > 0) d = Math.min(d, dist[p - 1] + 1);
      dist[p] = d;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const p = y * w + x;
      let d = dist[p];
      if (d === 0) continue;
      if (y < h - 1) {
        if (x < w - 1) d = Math.min(d, dist[p + w + 1] + 1);
        d = Math.min(d, dist[p + w] + 1);
        if (x > 0) d = Math.min(d, dist[p + w - 1] + 1);
      }
      if (x < w - 1) d = Math.min(d, dist[p + 1] + 1);
      dist[p] = d;
    }
  }
  return dist;
}

function estimateHalation(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  cpp: number,
): HaloResult {
  // 分析尺度 ≤256 长边（盒式降采样，RGB 平均）
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 256));
  const w = Math.ceil(width / step);
  const h = Math.ceil(height / step);
  const R = new Float32Array(w * h);
  const G = new Float32Array(w * h);
  const Bc = new Float32Array(w * h);
  const L = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      const y1 = Math.min(height, (y + 1) * step);
      const x1 = Math.min(width, (x + 1) * step);
      for (let yy = y * step; yy < y1; yy++) {
        let i = (yy * width + x * step) * cpp;
        for (let xx = x * step; xx < x1; xx++) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          i += cpp;
          n++;
        }
      }
      const p = y * w + x;
      R[p] = r / n / 255;
      G[p] = g / n / 255;
      Bc[p] = b / n / 255;
      L[p] = LUMA_R * R[p] + LUMA_G * G[p] + LUMA_B * Bc[p];
    }
  }

  // 亮区掩码（luma > 0.8）+ 距离变换
  const bright = new Uint8Array(w * h);
  let nBright = 0;
  for (let p = 0; p < w * h; p++) {
    if (L[p] > 0.8) {
      bright[p] = 1;
      nBright++;
    }
  }
  if (nBright < 4) {
    return { spill: 0, tint: [1, 0.35, 0.2], radius: 1.2, haloPixels: 0 };
  }
  const dist = chebyshevDT(bright, w, h);

  // 远背景（距亮区 > 8px）
  let bgR = 0;
  let bgG = 0;
  let bgB = 0;
  let bgL = 0;
  let bgN = 0;
  for (let p = 0; p < w * h; p++) {
    if (dist[p] > 8) {
      bgR += R[p];
      bgG += G[p];
      bgB += Bc[p];
      bgL += L[p];
      bgN++;
    }
  }
  if (bgN < 16) {
    bgR = 0.05;
    bgG = 0.05;
    bgB = 0.05;
    bgL = 0.05;
    bgN = 1;
  } else {
    bgR /= bgN;
    bgG /= bgN;
    bgB /= bgN;
    bgL /= bgN;
  }

  // 环带（1 ≤ dist ≤ 2）：平均溢出 + 色偏（相对远背景）
  let spillSum = 0;
  let haloN = 0;
  let tR = 0;
  let tG = 0;
  let tB = 0;
  for (let p = 0; p < w * h; p++) {
    const d = dist[p];
    if (d >= 1 && d <= 2) {
      spillSum += Math.max(0, R[p] - Math.max(G[p], Bc[p]));
      tR += R[p];
      tG += G[p];
      tB += Bc[p];
      haloN++;
    }
  }
  if (haloN < 4) {
    return { spill: 0, tint: [1, 0.35, 0.2], radius: 1.2, haloPixels: 0 };
  }
  const spill = spillSum / haloN;
  const exR = Math.max(0, tR / haloN - bgR);
  const exG = Math.max(0, tG / haloN - bgG);
  const exB = Math.max(0, tB / haloN - bgB);
  const exMax = Math.max(exR, exG, exB, 1e-4);
  const floorC = 0.12;
  const tint: [number, number, number] = [
    Math.max(floorC, exR / exMax),
    Math.max(floorC, exG / exMax),
    Math.max(floorC, exB / exMax),
  ];
  const tMax = Math.max(tint[0], tint[1], tint[2]);
  tint[0] /= tMax;
  tint[1] /= tMax;
  tint[2] /= tMax;

  // 径向半衰宽度：按亮区距离分桶的亮度余量，找首次跌破 d=1 余量 50% 的距离
  const bucketSum = new Float64Array(16);
  const bucketN = new Float64Array(16);
  for (let p = 0; p < w * h; p++) {
    const d = dist[p];
    if (d >= 1 && d <= 12 && d % 1 === 0) {
      bucketSum[d] += Math.max(0, L[p] - bgL);
      bucketN[d]++;
    }
  }
  let radius = 1.2;
  const e1 = bucketN[1] > 0 ? bucketSum[1] / bucketN[1] : 0;
  if (e1 > 0.01) {
    let d50 = 12;
    for (let d = 2; d <= 12; d++) {
      const e = bucketN[d] > 0 ? bucketSum[d] / bucketN[d] : -1;
      if (e < e1 * 0.5) {
        d50 = d;
        break;
      }
    }
    // 分析图高 h ↔ 原图高 height；半径单位 %H
    radius = Math.min(4.5, Math.max(0.6, (d50 / h) * 100 * RADIUS_GAIN));
  }

  return { spill, tint, radius, haloPixels: haloN };
}

/* ---------------- chroma_shift：四角 R/B 梯度质心径向错位 ---------------- */

function estimateChromaShift(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  cpp: number,
): number {
  const P = Math.max(12, Math.min(48, Math.round(Math.min(width, height) * 0.09)));
  const inset = 2;
  const corners: Array<[number, number]> = [
    [inset, inset],
    [width - inset - P, inset],
    [inset, height - inset - P],
    [width - inset - P, height - inset - P],
  ];
  const cx = width / 2;
  const cy = height / 2;

  let sum = 0;
  let n = 0;
  for (const [x0, y0] of corners) {
    // 每通道梯度幅度的质心（权重 = max(0, 梯度 - 阈值)，抑制平坦区数值噪声）
    const centroid = (ch: number): [number, number] | null => {
      let sx = 0;
      let sy = 0;
      let total = 0;
      for (let y = y0 + 1; y < y0 + P - 1; y++) {
        for (let x = x0 + 1; x < x0 + P - 1; x++) {
          const i = (y * width + x) * cpp;
          const gx = (data[i + cpp + ch] - data[i - cpp + ch]) / 255;
          const gy = (data[i + width * cpp + ch] - data[i - width * cpp + ch]) / 255;
          const g = Math.sqrt(gx * gx + gy * gy);
          const wgt = Math.max(0, g - 0.06);
          sx += wgt * x;
          sy += wgt * y;
          total += wgt;
        }
      }
      if (total < 2) return null;
      return [sx / total, sy / total];
    };
    const cR = centroid(0);
    const cB = centroid(2);
    if (!cR || !cB) continue;
    const dx = cR[0] - cB[0];
    const dy = cR[1] - cB[1];
    // 径向单位向量（图像中心 → patch 中心），取径向投影幅值
    const rx = x0 + P / 2 - cx;
    const ry = y0 + P / 2 - cy;
    const rl = Math.sqrt(rx * rx + ry * ry);
    if (rl < 1) continue;
    const proj = Math.abs((dx * rx + dy * ry) / rl);
    sum += proj / height; // 画面高度比例
    n++;
  }
  return n > 0 ? sum / n : 0;
}

/* ---------------- 主入口 ---------------- */

/**
 * 估算质感起点。数据不足（无平坦块/无亮区/角部无边缘）时回退到先验值，
 * 仍然返回 estimated 起点与合法区间内的值。
 */
export function estimateTexture(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { estimate: TextureEstimate; debug: EstimateDebug } {
  if (!(width > 1) || !(height > 1)) {
    throw new Error('estimateTexture: 尺寸必须为正');
  }
  const n = width * height;
  const cpp = data.length === n * 4 ? 4 : data.length === n * 3 ? 3 : 0;
  if (cpp === 0) {
    throw new Error('estimateTexture: 数据长度与尺寸不符（期望 RGBA 或 RGB）');
  }

  const grain = estimateGrain(data, width, height, cpp);
  const halo = estimateHalation(data, width, height, cpp);
  const caShift = estimateChromaShift(data, width, height, cpp);

  // iso：渲染端 √(iso/400) 响应 ↔ 噪声 σ 线性 → iso = 400·(σ/σ_ref)²
  const iso = grain.flatBlocks >= 3
    ? Math.min(3200, Math.max(25, 400 * Math.pow(grain.sigma / SIGMA_REF, 2)))
    : 400;
  // size：AR(1) 相关长度 s = 1/√(-2·ln ρ1) px → ‰H
  const rho = Math.min(0.995, Math.max(0.02, grain.rho1));
  const corrPx = grain.rho1 <= 0.02 ? 0.5 : 1 / Math.sqrt(-2 * Math.log(rho));
  const size = Math.min(5, Math.max(0.5, (corrPx / height) * 1000));

  const estimate: TextureEstimate = {
    grain: {
      iso: { value: Math.round(iso), origin: 'estimated' },
      size: { value: +size.toFixed(2), origin: 'estimated' },
    },
    halation: {
      amount: { value: +Math.min(1, Math.max(0, halo.spill / SPILL_FULL)).toFixed(3), origin: 'estimated' },
      radius: { value: +halo.radius.toFixed(2), origin: 'estimated' },
      tint_rgb: { value: halo.tint, origin: 'estimated' },
    },
    vignette: {
      chroma_shift: { value: +Math.min(0.01, Math.max(0, caShift)).toFixed(4), origin: 'estimated' },
    },
  };
  const debug: EstimateDebug = {
    noiseSigma: +grain.sigma.toFixed(3),
    rho1: +grain.rho1.toFixed(4),
    flatBlocks: grain.flatBlocks,
    spill: +halo.spill.toFixed(4),
    haloPixels: halo.haloPixels,
    caShift: +caShift.toFixed(5),
  };
  return { estimate, debug };
}
