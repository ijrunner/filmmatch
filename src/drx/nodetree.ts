/* FilmMatch R5 · 达芬奇 PowerGrade「节点树搭建清单」生成器（验收路径，纯函数）
 *
 * 定位：把质感层（光晕 / 柔光 / 颗粒 / 暗角）语义翻译成一份**可复制照做**的节点搭建清单，
 * 用户在达芬奇里按顺序建节点、填参数，再 Grab Still 存为 PowerGrade，即可拆开逐节点微调。
 * 参数不是拍脑袋写的，而是从 film/effectmath.ts 的质感语义推导：
 *   - halation：紧晕固定 ≈0.3%H（TIGHT_RADIUS_H）+ 宽晕 radius 经 amplify/smoothness 修正
 *     （halationRadiusEff）；紧/宽权重配比由 halationWeights 给出；染橙红经 hue/amplify 修正。
 *   - bloom：radius 经 details 修正（bloomRadiusEff），并给出降饱和 / 高光防溢出。
 *   - grain：颗粒基准间距由「有效尺寸」grainSizeEff 推导（px = H·size·0.001，见 pipeline 注释），
 *     幅度 = 0.14·√(ISO/400)·乳剂分辨率微调（与 pipeline 同式）。
 *   - vignette：chroma_shift 为「画面高度比例」，角落位移 dispPx = shift·H·r²。
 *
 * 单位约定（与 params.ts / pipeline.ts 一致）：
 *   半径 = %H（画面高度百分比）；颗粒尺寸 = ‰H（画面高度千分比）；色散 = 画面高度比例。
 *   三者都随画面高度 h 线性换算 → 1080p 与 2160p 恰好 2×。
 *
 * 商标红线：本模块只出现「达芬奇」，不出现任何第三方品牌 / 胶片商标。
 * 实验性：本清单为**搭建指引**，不是达芬奇原生节点包；.drx 生成器见 drxfile.ts（实验性）。
 */

import {
  TIGHT_RADIUS_H, GRAIN_BASE,
  halationRadiusEff, halationWeights, halationHueTint, halationAmplifyTintGain,
  bloomRadiusEff, grainSizeEff, grainResolutionAmp,
} from '../film/effectmath';
import type { LookParams, TextureParams } from '../film/params';

export interface Resolution { w: number; h: number }
export type NodeKind = 'grade' | 'lut' | 'halation' | 'grain' | 'bloom' | 'vignette' | 'composite';
export interface NodeSpec {
  index: number;              // 1 起
  name: string;               // 达芬奇节点名（如 '光晕 Halation'）
  kind: NodeKind;
  /** 该节点要填的参数（值已按 resolution 换算为像素或百分比，键名为可读中文/英文短语） */
  params: Record<string, string | number | boolean>;
  note: string;               // 操作提示（例如「混合模式 Screen」「不透明度 0.75」）
}
export interface BuildListInput {
  recipeName: string;
  shareCode: string;
  texture: TextureParams;
  look: LookParams;
  resolution: Resolution;     // 生成时以该分辨率换算；同时提供 1080p/2160p 两套换算
  lutFileName: string | null; // 统一风格层 .cube 文件名（null = 无 LUT，仅节点树）
}
export interface PixelConversion { label: string; unit: string; value1080: number; value2160: number; note: string }
export interface BuildList {
  nodes: NodeSpec[];
  colorSpace: { timeline: string; node: string; note: string };
  conversions: PixelConversion[];
  markdown: string;
}

/* ---------------- 数值工具 ---------------- */

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const r1 = (x: number): number => Math.round(x * 10) / 10;
const r2 = (x: number): number => Math.round(x * 100) / 100;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** 空间量 → 像素（未取整，供换算表保持 1080p/2160p 的 2× 关系） */
function pxRaw(value: number, unit: '%H' | '‰H' | 'ratio', res: Resolution): number {
  const h = res && isFinite(res.h) ? res.h : 0;
  if (!isFinite(value) || h <= 0) return 0;
  switch (unit) {
    case '%H': return (value * h) / 100;
    case '‰H': return (value * h) / 1000;
    case 'ratio': return value * h;      // 画面高度比例（色散）：ratio=1 即整幅高度
  }
}
const pxRaw3 = (value: number, unit: '%H' | '‰H' | 'ratio', res: Resolution): number => r3(pxRaw(value, unit, res));

/**
 * 空间量 → 像素：unit '%H' 用 h，'‰H' 用 h，'ratio' 用 h（色散）；返回四舍五入到 0.1px。
 * 单位关系：1%H = 10‰H；ratio=1 即整幅高度 = 1000‰H。
 */
export function pixelsFor(value: number, unit: '%H' | '‰H' | 'ratio', res: Resolution): number {
  return r1(pxRaw(value, unit, res));
}

/* ---------------- 参数换算表 ---------------- */

/**
 * 1080p/2160p 两套换算表（含 halation 紧晕/宽晕半径、bloom 半径、颗粒间距、色散角位移）。
 * 五项均随 h 线性 → 2160p 值恰为 1080p 的 2×（换算表保留 3 位小数以维持该关系）。
 */
export function buildConversions(t: TextureParams): PixelConversion[] {
  const r1080: Resolution = { w: 1920, h: 1080 };
  const r2160: Resolution = { w: 3840, h: 2160 };
  const mk = (label: string, unit: '%H' | '‰H' | 'ratio', value: number, note: string): PixelConversion => ({
    label, unit,
    value1080: pxRaw3(value, unit, r1080),
    value2160: pxRaw3(value, unit, r2160),
    note,
  });
  return [
    mk('halation 紧晕半径', '%H', TIGHT_RADIUS_H, '固定 ≈0.3%H，保高光形状（不随参数变）'),
    mk('halation 宽晕半径', '%H',
      halationRadiusEff(t.halation.radius, t.halation.amplify, t.halation.smoothness),
      '已含 amplify / smoothness 修正'),
    mk('bloom 柔光半径', '%H', bloomRadiusEff(t.bloom.radius, t.bloom.details), '已含 details 修正'),
    mk('颗粒间距', '‰H', grainSizeEff(t.grain.size, t.grain.film_resolution), 'px = H·有效尺寸·0.001'),
    mk('边缘色散角位移（画面角落）', 'ratio', t.vignette.chroma_shift, 'dispPx = 比例·H·r²，角落 r=1 最大'),
  ];
}

/* ---------------- 色彩空间建议 ---------------- */

function buildColorSpace(): BuildList['colorSpace'] {
  return {
    timeline: 'Rec.709',
    node: 'Rec.709 gamma 2.4',
    note: '时间线与节点均建议保持 Rec.709（节点内部按 Rec.709 gamma 2.4 计算）；导入后请核对达芬奇的时间线色彩管理设置。',
  };
}

/* ---------------- 节点树 ---------------- */

/** 风格层（grade / LUT）节点参数 */
function gradeNode(input: BuildListInput): NodeSpec {
  const L = input.look;
  const base = { index: 1, name: '风格层 Grade', kind: 'grade' as const };
  if (input.lutFileName) {
    return {
      ...base,
      params: {
        'LUT 文件': input.lutFileName,
        'LUT 插值': '四面体（Tetrahedral）',
        'LUT 域': '0–1（与 .cube DOMAIN 一致）',
      },
      note: '在该节点挂载上述 .cube（已含「匹配∘风格」预烘焙结果）；节点内不再叠加程序化 look。',
    };
  }
  return {
    ...base,
    params: {
      '褪色 fade': r3(L.fade),
      '黑位提升 black_lift': r3(L.black_lift),
      '染料耦合 dye_coupling': r3(L.dye_coupling),
      '暗部青蓝 shadow_bias': r3(L.shadow_bias),
      '高光暖黄 highlight_bias': r3(L.highlight_bias),
      '软S film_s': r3(L.film_s),
      '反S contrast': r3(L.contrast),
      '饱和度 saturation': r3(L.saturation),
      '冷暖 warmth': r3(L.warmth),
    },
    note: '无 LUT：用「色阶/曲线」节点按下表近似；或在工房导出 .cube 后改挂 LUT 节点（推荐，所见即所得）。',
  };
}

function halationNode(t: TextureParams, res: Resolution): NodeSpec {
  const h = t.halation;
  const tightPx = pixelsFor(TIGHT_RADIUS_H, '%H', res);
  const widePx = pixelsFor(halationRadiusEff(h.radius, h.amplify, h.smoothness), '%H', res);
  const hw = halationWeights(h.amount, 1, h.impact, h.amplify, h.smoothness);
  const total = hw.tight + hw.wide;
  const tightFrac = total > 0 ? hw.tight / total : 0;
  const wideFrac = total > 0 ? hw.wide / total : 0;
  const tint = halationHueTint(h.tint_rgb, h.hue);
  const tintG = tint[1] * halationAmplifyTintGain(h.amplify);
  const opacity = clamp01(h.amount * h.impact);
  return {
    index: 2, name: '光晕 Halation', kind: 'halation',
    params: {
      '亮通阈值 threshold': r3(h.threshold),
      '紧晕半径(px)': tightPx,
      '宽晕半径(px)': widePx,
      '紧晕权重占比': r3(tightFrac),
      '宽晕权重占比': r3(wideFrac),
      '叠加不透明度': r3(opacity),
      '晕染色 tint RGB': `${r2(tint[0])}, ${r2(tintG)}, ${r2(tint[2])}`,
      '背景增益 background_gain': r3(h.background_gain),
      '冷背景补偿 blue_comp': r3(h.blue_comp),
      '散射敏感度 amplify': r3(h.amplify),
      '大小光源分配 smoothness': r3(h.smoothness),
    },
    note: h.enabled
      ? `混合模式 Screen；不透明度 ${r3(opacity)}；亮通取最大通道（饱和霓虹也触发），暗部远场软保护。`
      : '已关闭（可跳过）：若不需要光晕，跳过本节点。',
  };
}

function bloomNode(t: TextureParams, res: Resolution): NodeSpec {
  const b = t.bloom;
  return {
    index: 3, name: '柔光 Bloom', kind: 'bloom',
    params: {
      '亮通阈值 threshold': r3(b.threshold),
      '半径(px)': pixelsFor(bloomRadiusEff(b.radius, b.details), '%H', res),
      '不透明度': r3(b.amount),
      '效果降饱和 saturation': r3(b.saturation),
      '高光防溢出 save_lights': r3(b.save_lights),
      '大小光源分配 details': r3(b.details),
    },
    note: b.enabled
      ? `混合模式 Screen；不透明度 ${r3(b.amount)}；先降饱和再按背景亮度防高光溢出。`
      : '已关闭（可跳过）。',
  };
}

function grainNode(t: TextureParams, res: Resolution): NodeSpec {
  const g = t.grain;
  const sizeEff = grainSizeEff(g.size, g.film_resolution);
  const amp = GRAIN_BASE * Math.sqrt(g.iso / 400) * grainResolutionAmp(g.film_resolution);
  return {
    index: 4, name: '颗粒 Grain', kind: 'grain',
    params: {
      '颗粒间距(px)': pixelsFor(sizeEff, '‰H', res),
      '颗粒幅度(基准 0.14·√ISO/400)': r3(amp),
      '阴影段权重 shadow': r3(g.shadow),
      '中间调段权重 midtone': r3(g.midtone),
      '高光段权重 highlight': r3(g.highlight),
      '暗部旧字段加权 shadow_weight': r3(g.shadow_weight),
      '单色相关 correlation': r3(g.correlation),
      '颗粒类型': g.type === 'negative' ? 'negative（负片，高光颗粒更明显）' : 'positive（正片，更柔）',
      '颗粒模式': g.mode === 'analogue' ? 'analogue（絮状）' : 'noise（白噪声，兼防 banding）',
    },
    note: g.enabled
      ? `混合模式 叠加(Add) / 柔光；幅度 ${r3(amp)}；亮度三段分带 0.43 / 0.85；24fps 相位步进防闪烁。`
      : '已关闭（可跳过）。',
  };
}

function vignetteNode(t: TextureParams, res: Resolution): NodeSpec {
  const v = t.vignette;
  return {
    index: 5, name: '暗角 Vignette', kind: 'vignette',
    params: {
      '起始半径(1=画面半对角)': r3(v.radius),
      '不透明度': r3(v.amount),
      '边缘色散(px 画面角落)': pixelsFor(v.chroma_shift, 'ratio', res),
      '色散衰减': 'r²（中心 0 → 角落最大）',
    },
    note: v.enabled
      ? `混合模式 相乘(Multiply)；不透明度 ${r3(v.amount)}；色散 R 外移 / B 内移，随 r² 衰减。`
      : '已关闭（可跳过）。',
  };
}

function compositeNode(colorSpace: BuildList['colorSpace'], count: number): NodeSpec {
  return {
    index: 6, name: '合成 Composite', kind: 'composite',
    params: {
      '节点总数': count,
      '混合模式': '效果节点 Screen / 相乘，按顺序串接',
      '输出色彩空间': colorSpace.node,
    },
    note: '按 1→6 顺序串接；最终合成节点用 Screen（光晕/柔光）与 Multiply（暗角）把效果叠回画面。',
  };
}

/** 生成节点树 + 参数换算 + Markdown 搭建清单（纯函数） */
export function buildNodeTree(input: BuildListInput): BuildList {
  const t = input.texture;
  const res = input.resolution;
  const colorSpace = buildColorSpace();
  const nodes: NodeSpec[] = [
    gradeNode(input),
    halationNode(t, res),
    bloomNode(t, res),
    grainNode(t, res),
    vignetteNode(t, res),
    compositeNode(colorSpace, 6),
  ];
  const conversions = buildConversions(t);
  const partial: Omit<BuildList, 'markdown'> = { nodes, colorSpace, conversions };
  return { ...partial, markdown: buildListMarkdown(partial) };
}

/* ---------------- Markdown 搭建清单 ---------------- */

const fmtNum = (v: string | number | boolean): string => (typeof v === 'number' ? String(v) : String(v));

/** 节点树 + 换算表 → 可复制照做的 Markdown 搭建清单 */
export function buildListMarkdown(list: Omit<BuildList, 'markdown'>): string {
  const { nodes, colorSpace, conversions } = list;
  const lines: string[] = [];
  lines.push('# FilmMatch 节点包搭建清单');
  lines.push('');
  lines.push('> 实验性交付：需按你的达芬奇版本核对参数名。');
  lines.push('');
  lines.push('按本清单在达芬奇 Color 页依次建节点并填参数，完成后 Grab Still 存为 PowerGrade，即可拆开逐节点微调。');
  lines.push('');
  lines.push('## 色彩空间');
  lines.push('');
  lines.push(`- 时间线：${colorSpace.timeline}`);
  lines.push(`- 节点：${colorSpace.node}`);
  lines.push(`- 说明：${colorSpace.note}`);
  lines.push('');
  lines.push('## 节点树（按顺序创建）');
  lines.push('');
  for (const n of nodes) {
    lines.push(`### ${n.index}. ${n.name}`);
    lines.push('');
    lines.push(`操作提示：${n.note}`);
    lines.push('');
    lines.push('| 参数 | 值 |');
    lines.push('| --- | --- |');
    for (const [k, v] of Object.entries(n.params)) lines.push(`| ${k} | ${fmtNum(v)} |`);
    lines.push('');
  }
  lines.push('## 参数换算表（1080p / 2160p）');
  lines.push('');
  lines.push('| 参数 | 单位 | 1080p 像素 | 2160p 像素 | 说明 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const c of conversions) {
    lines.push(`| ${c.label} | ${c.unit} | ${c.value1080} | ${c.value2160} | ${c.note} |`);
  }
  lines.push('');
  return lines.join('\n');
}
