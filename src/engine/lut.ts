/**
 * 3D LUT 烘焙与 .cube 导出/解析。
 * 表布局遵循 .cube 惯例：红的量化下标最快，即
 *   index = ((bIdx * size + gIdx) * size + rIdx) * 3 + channel
 * 逻辑域固定 [0,1]^3（DOMAIN_MIN/MAX 0/1）。
 */
import { RGB } from './types';
import { clamp01 } from './util';

export interface LUT3D {
  /** 每维格点数 n（table 长度 = n^3 * 3） */
  size: number;
  /** 扁平化 RGB 表 */
  table: Float32Array;
}

const MIN_SIZE = 2;
const MAX_SIZE = 257;

/**
 * 把逐像素变换 fn 烘焙为 size^3 的 3D LUT（默认 65）。
 * 格点取等距采样 ri/(n-1)，fn 在格点上的取值即表项。
 */
export function bakeLUT(fn: (rgb: RGB) => RGB, size = 65): LUT3D {
  const n = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(size)));
  const table = new Float32Array(n * n * n * 3);
  const m = n - 1;
  const rgb: RGB = [0, 0, 0];
  let idx = 0;
  for (let bi = 0; bi < n; bi++) {
    rgb[2] = bi / m;
    for (let gi = 0; gi < n; gi++) {
      rgb[1] = gi / m;
      for (let ri = 0; ri < n; ri++) {
        rgb[0] = ri / m;
        const out = fn(rgb);
        table[idx++] = out[0];
        table[idx++] = out[1];
        table[idx++] = out[2];
      }
    }
  }
  return { size: n, table };
}

/**
 * 四面体插值采样（业界标准，精度优于三线性：对主色 cusp 与灰轴更友好，
 * 灰轴上退化为两端点的精确线性 = 严格保持明度映射单调性）。输入先钳制到 [0,1]。
 */
export function applyLUT(lut: LUT3D, rgb: RGB): RGB {
  const n = lut.size;
  const m = n - 1;
  const t = lut.table;
  const x = clamp01(rgb[0]) * m;
  const y = clamp01(rgb[1]) * m;
  const z = clamp01(rgb[2]) * m;
  const x0 = Math.min(x | 0, m - 1);
  const y0 = Math.min(y | 0, m - 1);
  const z0 = Math.min(z | 0, m - 1);
  const fr = x - x0;
  const fg = y - y0;
  const fb = z - z0;
  const i000 = ((z0 * n + y0) * n + x0) * 3;
  const s1 = 3;
  const s2 = n * 3;
  const s3 = s2 + s1;
  const c000 = i000;
  const c100 = i000 + s1;
  const c010 = i000 + s2;
  const c110 = c010 + s1;
  const c001 = i000 + s2 * n;
  const c101 = c001 + s1;
  const c011 = c001 + s2;
  const c111 = c011 + s1;
  const out: RGB = [0, 0, 0];
  // 6 四面体分解：按 (fr, fg, fb) 排序选角点，权重为排序间隙
  for (let c = 0; c < 3; c++) {
    let v: number;
    if (fr >= fg) {
      if (fg >= fb) {
        // r >= g >= b
        v =
          t[c000 + c] * (1 - fr) +
          t[c100 + c] * (fr - fg) +
          t[c110 + c] * (fg - fb) +
          t[c111 + c] * fb;
      } else if (fr >= fb) {
        // r >= b >= g
        v =
          t[c000 + c] * (1 - fr) +
          t[c100 + c] * (fr - fb) +
          t[c101 + c] * (fb - fg) +
          t[c111 + c] * fg;
      } else {
        // b >= r >= g
        v =
          t[c000 + c] * (1 - fb) +
          t[c001 + c] * (fb - fr) +
          t[c101 + c] * (fr - fg) +
          t[c111 + c] * fg;
      }
    } else {
      if (fg >= fb) {
        if (fr >= fb) {
          // g >= r >= b
          v =
            t[c000 + c] * (1 - fg) +
            t[c010 + c] * (fg - fr) +
            t[c110 + c] * (fr - fb) +
            t[c111 + c] * fb;
        } else {
          // g >= b >= r
          v =
            t[c000 + c] * (1 - fg) +
            t[c010 + c] * (fg - fb) +
            t[c011 + c] * (fb - fr) +
            t[c111 + c] * fr;
        }
      } else {
        // b >= g >= r
        v =
          t[c000 + c] * (1 - fb) +
          t[c001 + c] * (fb - fg) +
          t[c011 + c] * (fg - fr) +
          t[c111 + c] * fr;
      }
    }
    out[c] = v;
  }
  return out;
}

function fmt(v: number): string {
  const s = v.toFixed(6);
  return s === '-0.000000' ? '0.000000' : s;
}

/* ---------------- R17：数据范围（Data Range） ----------------
 * 网页预览工作在 Full/Data（0..1）；达芬奇时间线常见 Video/Legal（10bit 码值 64..940，
 * 等价 8bit 16..235，归一化 lo=16/255≈0.0627、hi=235/255≈0.9216）。
 * 语义：**预览画面不变**，仅声明 .cube 导出目标。'legal' 时导出表做双向包裹——
 *   输入端 Legal→Full 展开 D(x) = clamp01((x - lo) / (hi - lo))
 *   输出端 Full→Legal 回编 E(y) = clamp01(y) * (hi - lo) + lo
 * 即 T = E ∘ f ∘ D：LUT 成为 legal-in/legal-out 黑盒，插进 legal 时间线不产生整体偏色，
 * 下游节点范围语义不变。'full'（默认）时 rangeWrap 返回原函数（同一引用），烘焙逐位不变。 */
export type DataRange = 'full' | 'legal';
/** Video/Legal 黑位锚点（8bit 16 → 归一化；10bit 等价 64/1023≈0.0626） */
export const LEGAL_LOW = 16 / 255;
/** Video/Legal 白位锚点（8bit 235 → 归一化；10bit 等价 940/1023≈0.9189） */
export const LEGAL_HIGH = 235 / 255;

/** 缺省/非法值归一为 'full'（配方 schema 可选字段读入口径） */
export function normalizeDataRange(v: unknown): DataRange {
  return v === 'legal' ? 'legal' : 'full';
}

/** 给逐像素变换包一层范围映射；range='full' 恒等返回原函数（导出逐位不变的关键） */
export function rangeWrap(
  fn: (rgb: RGB) => RGB,
  range: DataRange,
): (rgb: RGB) => RGB {
  if (range !== 'legal') return fn;
  const lo = LEGAL_LOW;
  const span = LEGAL_HIGH - LEGAL_LOW;
  return (rgb: RGB): RGB => {
    const d: RGB = [
      clamp01((rgb[0] - lo) / span),
      clamp01((rgb[1] - lo) / span),
      clamp01((rgb[2] - lo) / span),
    ];
    const o = fn(d);
    return [o[0] * span + lo, o[1] * span + lo, o[2] * span + lo];
  };
}

/**
 * 导出合法 .cube 文本：TITLE / LUT_3D_SIZE / DOMAIN_MIN/MAX + n^3 行数据。
 * opts.comments（可选）在 TITLE 后插入 COMMENT 行——仅 'legal' 导出使用（声明数据范围）；
 * 不传时输出与既有版本逐字节一致（护栏：默认导出恒等）。
 */
export function toCube(lut: LUT3D, title?: string, opts?: { comments?: string[] }): string {
  const safeTitle =
    (title ?? 'FilmMatch LUT').replace(/["\\\r\n]/g, ' ').trim() || 'LUT';
  const n = lut.size;
  const t = lut.table;
  const count = n * n * n;
  const comments = (opts?.comments ?? []).filter((c) => typeof c === 'string');
  const head = count + 4 + comments.length;
  const lines: string[] = new Array(head);
  lines[0] = `TITLE "${safeTitle}"`;
  for (let i = 0; i < comments.length; i++) {
    lines[i + 1] = `COMMENT ${String(comments[i]).replace(/[\r\n]/g, ' ')}`;
  }
  const off = comments.length;
  lines[off + 1] = `LUT_3D_SIZE ${n}`;
  lines[off + 2] = 'DOMAIN_MIN 0.0 0.0 0.0';
  lines[off + 3] = 'DOMAIN_MAX 1.0 1.0 1.0';
  for (let i = 0; i < count; i++) {
    const j = i * 3;
    lines[i + 4 + off] = `${fmt(t[j])} ${fmt(t[j + 1])} ${fmt(t[j + 2])}`;
  }
  return lines.join('\n') + '\n';
}

/**
 * 解析 .cube 文本（解析即校验）：
 * 忽略 TITLE/COMMENT/VERSION/注释；要求存在 LUT_3D_SIZE 且数据行数恰为 size^3。
 * 本实现的 LUT 域固定 [0,1]，如声明其他 DOMAIN 将抛错。
 */
export function parseCube(text: string): LUT3D {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('parseCube: 空输入');
  }
  let size = 0;
  let domainMin: number[] | null = null;
  let domainMax: number[] | null = null;
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    const key = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
    const rest = sp === -1 ? '' : line.slice(sp + 1).trim();
    switch (key) {
      case 'TITLE':
      case 'COMMENT':
      case 'VERSION':
      case 'LUT_3D_INPUT_SIZE':
        break;
      case 'LUT_1D_SIZE':
        throw new Error('parseCube: 不支持 1D LUT');
      case 'LUT_3D_SIZE': {
        const v = Number.parseInt(rest, 10);
        if (!(v >= MIN_SIZE && v <= MAX_SIZE)) {
          throw new Error(`parseCube: LUT_3D_SIZE 非法 "${rest}"`);
        }
        size = v;
        break;
      }
      case 'DOMAIN_MIN':
      case 'DOMAIN_MAX': {
        const parts = rest.split(/\s+/).map(Number);
        if (parts.length < 3 || parts.some((v) => !Number.isFinite(v))) {
          throw new Error(`parseCube: ${key} 非法 "${rest}"`);
        }
        if (key === 'DOMAIN_MIN') domainMin = parts;
        else domainMax = parts;
        break;
      }
      default: {
        const parts = line.split(/\s+/);
        if (parts.length < 3) {
          throw new Error(`parseCube: 无法解析数据行 "${line}"`);
        }
        const r = Number(parts[0]);
        const g = Number(parts[1]);
        const b = Number(parts[2]);
        if (![r, g, b].every(Number.isFinite)) {
          throw new Error(`parseCube: 数据行含非数值 "${line}"`);
        }
        values.push(r, g, b);
      }
    }
  }
  if (size === 0) throw new Error('parseCube: 缺少 LUT_3D_SIZE');
  if (
    (domainMin && domainMin.some((v) => Math.abs(v) > 1e-6)) ||
    (domainMax && domainMax.some((v) => Math.abs(v - 1) > 1e-6))
  ) {
    throw new Error('parseCube: 暂仅支持 DOMAIN [0,1] 的 LUT');
  }
  const expected = size * size * size * 3;
  if (values.length !== expected) {
    throw new Error(
      `parseCube: 数据量不符（期望 ${expected} 个分量，实际 ${values.length}）`,
    );
  }
  return { size, table: new Float32Array(values) };
}
