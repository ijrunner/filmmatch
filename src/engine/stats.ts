/**
 * 图像统计：把图像缩到 <=256 边后按亮度三分区（软边界）统计 CIELAB 均值/方差。
 * ImageStats 必须保持 JSON 可序列化（图库标注会持久化它）。
 */
import { rgbToLab } from './color';
import { smoothstep } from './util';

/** 单个亮度分区的加权 Lab 统计 */
export interface ZoneStats {
  /** 软边界权重和（像素级权重累加，全图三区权重和 == 样本数） */
  weight: number;
  /** CIELAB 明度/色度（L、a、b）加权均值 */
  mean: [number, number, number];
  /** CIELAB 明度/色度（L、a、b）加权方差 */
  variance: [number, number, number];
}

/**
 * 单图统计结果。
 * JSON 字段说明（图库标注持久化用）：
 *  - version: 统计结构版本，当前恒为 1
 *  - width / height: 原图尺寸（像素）
 *  - sample_size: 统计所用采样网格的边长（<=256）
 *  - samples: 参与统计的样本（块平均）数
 *  - zones.shadow / zones.mid / zones.high: 阴影(<0.3)/中间调/高光(>0.7) 三区
 *    软边界加权统计，权重边界见 zoneWeights
 *  - global: 全图等权统计，全局色偏对齐的基准
 *  - chroma_mean: 全图平均色度 C* = mean(sqrt(a*^2 + b*^2))，诊断/展示用
 *  - source: 可选，被调色图（匹配源）统计。图库单图标注不携带；
 *    构建匹配变换时由 withSource 挂载，buildTransform 读取它做双图对齐。
 */
export interface ImageStats {
  version: 1;
  width: number;
  height: number;
  sample_size: number;
  samples: number;
  zones: {
    shadow: ZoneStats;
    mid: ZoneStats;
    high: ZoneStats;
  };
  global: ZoneStats;
  chroma_mean: number;
  source?: ImageStats;
}

/** 把参考图统计与被调色图统计组装成匹配输入（保持 JSON 可序列化） */
export function withSource(ref: ImageStats, source: ImageStats): ImageStats {
  return { ...ref, source };
}

/** 亮度分区软边界：0.3/0.7 为分界中心，±0.05 过渡。写入 out[o..o+2] = [wS, wM, wH] */
export function zoneWeights(l01: number, out: Float64Array | number[], o = 0): void {
  const wS = 1 - smoothstep(0.25, 0.35, l01);
  const wH = smoothstep(0.65, 0.75, l01);
  out[o] = wS;
  out[o + 1] = Math.max(0, 1 - wS - wH);
  out[o + 2] = wH;
}

interface ZoneAcc {
  w: number;
  s: [number, number, number];
  s2: [number, number, number];
}

function newAcc(): ZoneAcc {
  return { w: 0, s: [0, 0, 0], s2: [0, 0, 0] };
}

function accAdd(acc: ZoneAcc, w: number, l: number, a: number, b: number): void {
  acc.w += w;
  acc.s[0] += w * l;
  acc.s[1] += w * a;
  acc.s[2] += w * b;
  acc.s2[0] += w * l * l;
  acc.s2[1] += w * a * a;
  acc.s2[2] += w * b * b;
}

function accFinish(acc: ZoneAcc): ZoneStats {
  const w = acc.w;
  if (w <= 1e-9) {
    return { weight: 0, mean: [0, 0, 0], variance: [0, 0, 0] };
  }
  const mean: [number, number, number] = [acc.s[0] / w, acc.s[1] / w, acc.s[2] / w];
  const variance: [number, number, number] = [
    Math.max(0, acc.s2[0] / w - mean[0] * mean[0]),
    Math.max(0, acc.s2[1] / w - mean[1] * mean[1]),
    Math.max(0, acc.s2[2] / w - mean[2] * mean[2]),
  ];
  return { weight: w, mean, variance };
}

/**
 * 分析图像：RGBA(4 通道) 或 RGB(3 通道) 字节缓冲。
 * 按盒式降采样到 <=256 边（块平均顺带抑制噪声），逐样本转 Lab 后做
 * 亮度三分区（软边界）与全图的加权均值/方差统计。
 */
export function analyzeImage(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): ImageStats {
  if (!(width > 0) || !(height > 0)) {
    throw new Error('analyzeImage: 尺寸必须为正');
  }
  const n = width * height;
  const cpp = data.length === n * 4 ? 4 : data.length === n * 3 ? 3 : 0;
  if (cpp === 0) {
    throw new Error('analyzeImage: 数据长度与尺寸不符（期望 RGBA 或 RGB）');
  }

  // 盒式降采样步长：让网格长边 <= 256
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 256));
  const gw = Math.ceil(width / step);
  const gh = Math.ceil(height / step);

  const shadow = newAcc();
  const mid = newAcc();
  const high = newAcc();
  const glob = newAcc();
  const zw = [0, 0, 0];
  let chromaSum = 0;

  for (let by = 0; by < gh; by++) {
    for (let bx = 0; bx < gw; bx++) {
      // 块平均（sRGB gamma 空间，作为缩略图均值足够稳定）
      let r = 0;
      let g = 0;
      let b = 0;
      let cnt = 0;
      const y1 = Math.min(height, (by + 1) * step);
      const x1 = Math.min(width, (bx + 1) * step);
      for (let y = by * step; y < y1; y++) {
        let idx = (y * width + bx * step) * cpp;
        for (let x = bx * step; x < x1; x++) {
          r += data[idx];
          g += data[idx + 1];
          b += data[idx + 2];
          idx += cpp;
          cnt++;
        }
      }
      const lab = rgbToLab(r / (cnt * 255), g / (cnt * 255), b / (cnt * 255));
      const L = lab[0];
      const a = lab[1];
      const bb = lab[2];
      chromaSum += Math.sqrt(a * a + bb * bb);

      zoneWeights(L / 100, zw, 0);
      if (zw[0] > 0) accAdd(shadow, zw[0], L, a, bb);
      if (zw[1] > 0) accAdd(mid, zw[1], L, a, bb);
      if (zw[2] > 0) accAdd(high, zw[2], L, a, bb);
      accAdd(glob, 1, L, a, bb);
    }
  }

  const samples = gw * gh;
  return {
    version: 1,
    width,
    height,
    sample_size: Math.max(gw, gh),
    samples,
    zones: {
      shadow: accFinish(shadow),
      mid: accFinish(mid),
      high: accFinish(high),
    },
    global: accFinish(glob),
    chroma_mean: samples > 0 ? chromaSum / samples : 0,
  };
}

/**
 * 中性源统计：当 buildTransform 只拿到参考图统计（未挂 source）时使用，
 * 语义为「把一张标准中性画面调向参考观感」。
 */
export function neutralSourceStats(): ImageStats {
  const zone = (meanL: number, varL: number): ZoneStats => ({
    weight: 1 / 3,
    mean: [meanL, 0, 0],
    variance: [varL, 64, 64],
  });
  return {
    version: 1,
    width: 0,
    height: 0,
    sample_size: 0,
    samples: 3,
    zones: {
      shadow: zone(25, 144),
      mid: zone(50, 144),
      high: zone(75, 100),
    },
    global: { weight: 1, mean: [50, 0, 0], variance: [216, 64, 64] },
    chroma_mean: 0,
  };
}
