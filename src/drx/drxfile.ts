/* FilmMatch R5 · 实验性 .drx（PowerGrade）模板生成器
 *
 * 【重要 · 诚实标注】.drx 是达芬奇私有格式（调研显示可能是编译后的 Lua，非明文 XML）。
 * spike①（.drx 格式实测）**尚未回执**，因此本模块输出的是一份**自洽的文本容器**，
 * 结构对齐「节点 + 参数」语义，供 spike① 回执后按真实格式校准字段名。
 * 它**不是**经过达芬奇导入验证的可用节点包 —— 请勿对外宣称「已验证可用」。
 * 验收路径是 nodetree.ts 的「节点树搭建清单」生成器；本模块是并行的实验性交付。
 *
 * 文本格式（行式，可被 parseDrx 无损回读）：
 *   # FilmMatch PowerGrade (实验性模板，未在达芬奇实测)
 *   # 配方名: <name>
 *   # 配方码: <shareCode>
 *   # 分辨率: <w>x<h>
 *   # 生成时间: (占位) 由达芬奇导入时写入
 *   # LUT: <file | ->
 *   # 色彩空间(时间线): Rec.709
 *   # 色彩空间(节点): Rec.709 gamma 2.4
 *   VERSION 1
 *   NODE <index>|<name>|<kind>
 *   PARAM <index>|<key>|<value>
 *
 * 商标红线：只出现「达芬奇」，无第三方品牌 / 胶片商标。
 */

import { buildNodeTree, type BuildListInput } from './nodetree';

export interface DrxInput {
  recipeName: string;
  shareCode: string;
  texture: BuildListInput['texture'];
  look: BuildListInput['look'];
  resolution: BuildListInput['resolution'];
  lutFileName: string | null;
}
export interface DrxResult {
  text: string;
  experimental: true;
  warnings: string[];
  format: 'template-text';
}

/** spike① 回执前必须随包提示的风险（测试断言其含「实验性」） */
export const DRX_WARNINGS: string[] = [
  '.drx 为达芬奇私有格式，本模板为实验性：格式判定与导入需 spike① 回执后校准',
  '本文件为自洽文本容器，未在达芬奇中实测导入；验收路径请优先使用「节点树搭建清单」',
];

const MAGIC = '# FilmMatch PowerGrade';
/** 把可能破坏行式结构的字符替换掉（'|' 为字段分隔符，换行会截断记录） */
const san = (s: string): string => String(s).replace(/[|\r\n]/g, '/').trim();

/** 实验性 .drx 模板生成器：输出自洽的文本容器，供 spike① 回执后按真实格式校准 */
export function generateDrx(input: DrxInput): DrxResult {
  const list = buildNodeTree(input);
  const lines: string[] = [];
  lines.push(`${MAGIC} (实验性模板，未在达芬奇实测)`);
  lines.push(`# 配方名: ${san(input.recipeName)}`);
  lines.push(`# 配方码: ${san(input.shareCode)}`);
  lines.push(`# 分辨率: ${input.resolution.w}x${input.resolution.h}`);
  lines.push('# 生成时间: (占位) 由达芬奇导入时写入');
  lines.push(`# LUT: ${input.lutFileName ? san(input.lutFileName) : '-'}`);
  lines.push(`# 色彩空间(时间线): ${san(list.colorSpace.timeline)}`);
  lines.push(`# 色彩空间(节点): ${san(list.colorSpace.node)}`);
  lines.push('VERSION 1');
  for (const n of list.nodes) {
    lines.push(`NODE ${n.index}|${san(n.name)}|${san(n.kind)}`);
    for (const [k, v] of Object.entries(n.params)) {
      lines.push(`PARAM ${n.index}|${san(k)}|${san(String(v))}`);
    }
  }
  return {
    text: lines.join('\n') + '\n',
    experimental: true,
    warnings: [...DRX_WARNINGS],
    format: 'template-text',
  };
}

interface ParsedNode { name: string; kind: string; params: Record<string, string> }

/** 回读自己产出的 .drx（结构一致性测试用）：解析出节点列表与参数；非法输入返回 null */
export function parseDrx(text: string): { nodes: ParsedNode[]; meta: Record<string, string> } | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0 || !lines[0].startsWith(MAGIC)) return null;
  const meta: Record<string, string> = {};
  const nodes: ParsedNode[] = [];
  const byIndex = new Map<number, ParsedNode>();
  for (const line of lines) {
    if (line.startsWith('#')) {
      const body = line.slice(1).trim();
      const ci = body.indexOf(':');
      if (ci > 0) meta[body.slice(0, ci).trim()] = body.slice(ci + 1).trim();
      continue;
    }
    if (line === 'VERSION' || line.startsWith('VERSION ')) {
      meta['VERSION'] = line.slice(7).trim();
      continue;
    }
    if (line.startsWith('NODE ')) {
      const parts = line.slice(5).split('|');
      if (parts.length < 3) return null;
      const index = Number(parts[0]);
      if (!Number.isFinite(index)) return null;
      const node: ParsedNode = { name: parts[1], kind: parts[2], params: {} };
      nodes.push(node);
      byIndex.set(index, node);
      continue;
    }
    if (line.startsWith('PARAM ')) {
      const parts = line.slice(6).split('|');
      if (parts.length < 3) return null;
      const index = Number(parts[0]);
      const node = byIndex.get(index);
      if (!node) return null;                     // PARAM 指向不存在的节点 → 结构损坏
      node.params[parts[1]] = parts.slice(2).join('|');
      continue;
    }
    return null;                                   // 未知行 → 非法输入
  }
  if (nodes.length === 0) return null;
  return { nodes, meta };
}

/** 结构差异度量（0=完全一致）：按解析后的 meta/节点/参数逐字段比较，返回差异占比 [0,1] */
export function drxDiff(a: string, b: string): number {
  if (a === b) return 0;
  const pa = parseDrx(a);
  const pb = parseDrx(b);
  if (!pa || !pb) return 1;                        // 任一侧非法：视为完全不同
  let total = 0, changed = 0;

  const metaKeys = new Set([...Object.keys(pa.meta), ...Object.keys(pb.meta)]);
  for (const k of metaKeys) {
    total++;
    if (pa.meta[k] !== pb.meta[k]) changed++;
  }
  total++;
  if (pa.nodes.length !== pb.nodes.length) changed++;
  const n = Math.max(pa.nodes.length, pb.nodes.length);
  for (let i = 0; i < n; i++) {
    const na = pa.nodes[i], nb = pb.nodes[i];
    total++;
    if (!na || !nb || na.name !== nb.name || na.kind !== nb.kind) { changed++; continue; }
    const pkeys = new Set([...Object.keys(na.params), ...Object.keys(nb.params)]);
    for (const k of pkeys) {
      total++;
      if (na.params[k] !== nb.params[k]) changed++;
    }
  }
  return total === 0 ? 1 : changed / total;
}
