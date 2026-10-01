/**
 * 合成多帧测试集（同场景、不同曝光/白平衡）。
 *
 * 为什么程序化生成：批量匹配验收需要「同一场景的多段素材」，但工程内不宜引入外部图片，
 * 也不能依赖 canvas/DOM（测试在 node 环境跑）。这里用纯数学铺一个覆盖
 * 灰阶带 + 肤色 + 饱和色 + 高光 + 中间调的场景，再在**线性光**上做曝光/白平衡扰动
 * 并重新编码 sRGB——与真实相机差异（曝光/色温）的物理链路一致，便于验证 CDL 拟合。
 *
 * 全程确定性：不含随机数，仅用坐标哈希做固定抖动；同参数两次调用逐像素一致。
 */
import { linearToSrgb, srgbToLinear } from '../engine/color';

export interface SynthFrame {
  name: string;
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

/** 饱和色块：红/绿/蓝/黄/青/品，避开 0/1 端点以留出拟合余量 */
const BLOCKS: Array<[number, number, number]> = [
  [0.82, 0.16, 0.14],
  [0.16, 0.68, 0.26],
  [0.14, 0.26, 0.80],
  [0.86, 0.80, 0.18],
  [0.16, 0.76, 0.78],
  [0.76, 0.22, 0.70],
];

/** 坐标哈希（确定性抖动源），返回 0..1 */
function hash01(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h >>> 8) & 0xffff) / 0xffff;
}

/**
 * 基准场景（程序化、无网络）：
 *  - 背景：中性略暖的竖向渐变（中间调）
 *  - 灰阶带：横向 0.05..0.90 全色调渐变（给分位数提供完整且稠密的分布）
 *  - 肤色块 + 六色饱和块（提供通道间差异，使 WB 扰动可被 CDL 捕捉）
 *  - 高光点：圆形接近白但保留余量
 * 抖动幅度 ±0.003，抑制直方图尖峰。
 */
export function synthScene(w: number, h: number): Uint8ClampedArray {
  if (!(w > 0) || !(h > 0)) throw new Error('synthScene: 尺寸必须为正');
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ny = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const nx = (x + 0.5) / w;
      let r: number;
      let g: number;
      let b: number;

      if (ny >= 0.7 && ny <= 0.92) {
        // 灰阶带：全色调，保证 p1/p50/p99 有充分支撑
        const v = 0.05 + 0.85 * nx;
        r = v;
        g = v;
        b = v;
      } else if (nx >= 0.05 && nx <= 0.28 && ny >= 0.06 && ny <= 0.34) {
        // 肤色块：略带竖向明暗
        const s = 1 - 0.12 * ny;
        r = 0.86 * s;
        g = 0.68 * s;
        b = 0.56 * s;
      } else if (nx >= 0.32 && nx <= 0.99 && ny >= 0.06 && ny <= 0.32) {
        // 六色饱和块
        const idx = Math.min(BLOCKS.length - 1, Math.floor(((nx - 0.32) / 0.67) * BLOCKS.length));
        const c = BLOCKS[idx];
        r = c[0];
        g = c[1];
        b = c[2];
      } else if (nx >= 0.32 && nx <= 0.99 && ny >= 0.38 && ny <= 0.60) {
        // 中间调块
        r = 0.45;
        g = 0.45;
        b = 0.45;
      } else {
        // 背景：中性偏暖渐变
        const bg = 0.3 + 0.12 * ny;
        r = bg * 1.02;
        g = bg;
        b = bg * 0.97;
      }

      // 高光点（最后覆盖）
      const dx = nx - 0.5;
      const dy = ny - 0.52;
      if (dx * dx + dy * dy < 0.008) {
        r = 0.94;
        g = 0.94;
        b = 0.94;
      }

      const d = (hash01(x, y) - 0.5) * 0.006;
      const o = (y * w + x) * 4;
      // 赋给 Uint8ClampedArray 会自动取整并钳制到 0..255
      out[o] = (r + d) * 255;
      out[o + 1] = (g + d) * 255;
      out[o + 2] = (b + d) * 255;
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * 在**线性光**上施加曝光与白平衡后重新编码 sRGB：
 *   linear' = srgbToLinear(c) * gain
 * 曝光按 2^EV；白平衡为 R/B 反向增益（典型色温偏移），G 保持。
 */
function exposeWb(
  base: Uint8ClampedArray,
  w: number,
  h: number,
  ev: number,
  wb: number,
): Uint8ClampedArray {
  const gain = Math.pow(2, ev);
  const gr = gain * (1 + wb);
  const gg = gain;
  const gb = gain * (1 - wb);
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const lr = srgbToLinear(base[o] / 255) * gr;
    const lg = srgbToLinear(base[o + 1] / 255) * gg;
    const lb = srgbToLinear(base[o + 2] / 255) * gb;
    out[o] = linearToSrgb(lr) * 255;
    out[o + 1] = linearToSrgb(lg) * 255;
    out[o + 2] = linearToSrgb(lb) * 255;
    out[o + 3] = 255;
  }
  return out;
}

/**
 * 基准场景 × n 档曝光/白平衡扰动。
 * 第 i 帧取 t = i/(n-1) ∈ [0,1]，曝光 −1.0..+1.0 EV、白平衡 −0.15..+0.15 同步递进；
 * n=1 时取中点（EV 0 / WB 0）。帧名 seg01..segNN，便于与导出包片段名对应。
 */
export function synthSeries(w: number, h: number, n = 7): SynthFrame[] {
  const base = synthScene(w, h);
  const count = Math.max(1, Math.floor(n));
  const frames: SynthFrame[] = [];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0.5;
    const ev = -1 + 2 * t;
    const wb = -0.15 + 0.3 * t;
    frames.push({
      name: `seg${String(i + 1).padStart(2, '0')}`,
      w,
      h,
      data: exposeWb(base, w, h, ev, wb),
    });
  }
  return frames;
}
