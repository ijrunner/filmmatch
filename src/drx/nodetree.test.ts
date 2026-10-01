/**
 * R5 节点树搭建清单生成器（drx/nodetree.ts）单元测试：
 * 纯函数，无 DOM / 无渲染后端依赖。
 * 覆盖：像素换算、节点顺序与索引、关闭层标注、色彩空间、换算表 2× 关系、
 *       Markdown 可照做性与商标红线、参数改动产生差异。
 */
import { describe, expect, it } from 'vitest';
import {
  buildConversions, buildListMarkdown, buildNodeTree, pixelsFor,
  type BuildListInput, type NodeKind,
} from './nodetree';
import { cloneParams, defaultLook, defaultTexture, getPreset } from '../film/params';

const RES = { w: 1920, h: 1080 };
const NODE_ORDER: NodeKind[] = ['grade', 'halation', 'bloom', 'grain', 'vignette', 'composite'];

/** 以 FL-05 预设为底构造生成输入（该卡光晕/柔光/颗粒/暗角语义齐全） */
function baseInput(overrides: Partial<BuildListInput> = {}): BuildListInput {
  const card = getPreset('fl05');
  const p = cloneParams(card.params);
  return {
    recipeName: card.name,
    shareCode: 'FM-TEST-0001',
    texture: p.texture,
    look: p.look,
    resolution: RES,
    lutFileName: 'FL-05.cube',
    ...overrides,
  };
}

describe('pixelsFor 空间量 → 像素换算', () => {
  it('1. %H 半径换算（0.1px 精度）', () => {
    // 1.2%H：1080p → 12.96 → 13.0；2160p → 25.92 → 25.9
    expect(pixelsFor(1.2, '%H', { w: 1920, h: 1080 })).toBe(13.0);
    expect(pixelsFor(1.2, '%H', { w: 3840, h: 2160 })).toBe(25.9);
  });

  it('1b. 单位关系：1%H = 10‰H；ratio=1 为整幅高度（= 1000‰H）', () => {
    const r = { w: 1000, h: 1000 }; // h=1000 便于取整观察
    // %H 与 ‰H 的分母为 100 / 1000，同一数值下 %H 结果是 ‰H 的 10 倍（1%H = 10‰H）
    expect(pixelsFor(1, '%H', r)).toBeCloseTo(10, 10);
    expect(pixelsFor(1, '‰H', r)).toBeCloseTo(1, 10);
    expect(pixelsFor(1, '%H', r) / pixelsFor(1, '‰H', r)).toBeCloseTo(10, 6);
    // ratio（画面高度比例）才是 ‰H 的 1000 倍：ratio=1 即整幅高度
    expect(pixelsFor(1, 'ratio', r) / pixelsFor(1, '‰H', r)).toBeCloseTo(1000, 6);
  });

  it('1c. ratio 用画面高度 h（与宽度无关），0.004 ≈ 1080p 角落 4px', () => {
    expect(pixelsFor(0.004, 'ratio', { w: 1920, h: 1080 })).toBe(4.3); // 4.32 → 4.3
    expect(pixelsFor(0.004, 'ratio', { w: 3840, h: 2160 })).toBe(8.6); // 8.64 → 8.6
    // 宽高互换：只取 h
    expect(pixelsFor(0.004, 'ratio', { w: 1080, h: 1920 })).toBe(7.7); // 7.68 → 7.7
  });

  it('1d. 非法输入（h<=0 / 非有限值）安全归零，不抛异常', () => {
    expect(pixelsFor(1.2, '%H', { w: 0, h: 0 })).toBe(0);
    expect(pixelsFor(NaN, '%H', { w: 1920, h: 1080 })).toBe(0);
    expect(pixelsFor(Infinity, 'ratio', { w: 1920, h: 1080 })).toBe(0);
  });
});

describe('buildNodeTree 节点顺序与结构', () => {
  it('2. 节点顺序固定为 grade→halation→bloom→grain→vignette→composite，index 从 1 递增', () => {
    const { nodes } = buildNodeTree(baseInput());
    expect(nodes.length).toBe(6);
    nodes.forEach((n, i) => {
      expect(n.kind).toBe(NODE_ORDER[i]);
      expect(n.index).toBe(i + 1);
    });
    // 名称非空且互不相同
    expect(new Set(nodes.map((n) => n.name)).size).toBe(6);
    nodes.forEach((n) => expect(n.name.length).toBeGreaterThan(0));
  });

  it('3. 关闭的层仍出现且标注「已关闭」', () => {
    // defaultTexture：halation / vignette 默认关闭
    const { nodes } = buildNodeTree(baseInput({ texture: defaultTexture(), look: defaultLook(), lutFileName: null }));
    const hal = nodes.find((n) => n.kind === 'halation')!;
    const vig = nodes.find((n) => n.kind === 'vignette')!;
    expect(hal).toBeTruthy();
    expect(vig).toBeTruthy();
    expect(hal.note).toContain('已关闭');
    expect(vig.note).toContain('已关闭');
    // 开启的层不应出现「已关闭」
    expect(nodes.find((n) => n.kind === 'grain')!.note).not.toContain('已关闭');
  });

  it('4. colorSpace 三个字段非空且均含 Rec.709', () => {
    const { colorSpace } = buildNodeTree(baseInput());
    expect(colorSpace.timeline.length).toBeGreaterThan(0);
    expect(colorSpace.node.length).toBeGreaterThan(0);
    expect(colorSpace.note.length).toBeGreaterThan(0);
    expect(colorSpace.timeline).toContain('Rec.709');
    expect(colorSpace.node).toContain('Rec.709');
    expect(colorSpace.note).toContain('Rec.709');
  });

  it('4b. 无 LUT 时风格层节点给出 look 参数，有 LUT 时引用文件名', () => {
    const withLut = buildNodeTree(baseInput({ lutFileName: 'FL-05.cube' }));
    expect(String(withLut.nodes[0].params['LUT 文件'])).toBe('FL-05.cube');
    const noLut = buildNodeTree(baseInput({ lutFileName: null }));
    expect(noLut.nodes[0].params['饱和度 saturation']).toBeDefined();
    expect(noLut.nodes[0].params['LUT 文件']).toBeUndefined();
  });

  it('4c. 最后一个节点为 composite 且节点总数一致', () => {
    const { nodes } = buildNodeTree(baseInput());
    const last = nodes[nodes.length - 1];
    expect(last.kind).toBe('composite');
    expect(last.params['节点总数']).toBe(nodes.length);
  });
});

describe('buildConversions 参数换算表', () => {
  it('5. 覆盖 halation 紧晕/宽晕、bloom、颗粒、色散五项，且 2160p ≈ 2×1080p（<1%）', () => {
    const conv = buildConversions(defaultTexture());
    expect(conv.length).toBe(5);
    const all = conv.map((c) => c.label).join(' ');
    expect(all).toContain('紧晕');
    expect(all).toContain('宽晕');
    expect(all).toContain('bloom');
    expect(all).toContain('颗粒');
    expect(all).toContain('色散');
    for (const c of conv) {
      expect(c.value1080).toBeGreaterThan(0);
      expect(c.value2160).toBeGreaterThan(0);
      const relErr = Math.abs(c.value2160 / c.value1080 - 2);
      expect(relErr).toBeLessThan(0.01);
    }
  });
});

describe('buildListMarkdown 可照做清单', () => {
  it('6. 含每个节点名、参数换算表表头（1080p/2160p）与「实验性」', () => {
    const list = buildNodeTree(baseInput());
    const md = list.markdown;
    for (const n of list.nodes) expect(md).toContain(n.name);
    expect(md).toContain('1080p');
    expect(md).toContain('2160p');
    expect(md).toContain('实验性');
    // 顶部实验性交付提示
    expect(md).toContain('实验性交付：需按你的达芬奇版本核对参数名');
    // 含「达芬奇」
    expect(md).toContain('达芬奇');
  });

  it('6b. buildListMarkdown 为纯函数：同一输入重复调用结果一致', () => {
    const a = buildNodeTree(baseInput());
    const b = buildNodeTree(baseInput());
    expect(a.markdown).toBe(b.markdown);
    const { markdown, ...rest } = a;
    expect(buildListMarkdown(rest)).toBe(markdown);
  });

  it('7. 不含第三方品牌 / 胶片商标词', () => {
    const md = buildNodeTree(baseInput()).markdown;
    const banned = ['Kodak', '柯达', 'Fuji', '富士', 'Portra', 'Ektar', 'Vision3', 'Ilford', 'Agfa', 'CineStill', 'Lomography', 'Resolve'];
    for (const w of banned) expect(md.includes(w)).toBe(false);
  });

  it('8. 参数改动产生差异：改 halation.amount 后 Markdown 文本不同', () => {
    const a = buildNodeTree(baseInput());
    const tex = defaultTexture();
    const p = cloneParams(getPreset('fl05').params);
    tex.halation = { ...p.texture.halation, amount: p.texture.halation.amount - 0.5 };
    const b = buildNodeTree(baseInput({ texture: tex }));
    expect(b.markdown).not.toBe(a.markdown);
    // 且光晕节点的不透明度/权重确实变化
    const ha = a.nodes[1].params['叠加不透明度'];
    const hb = b.nodes[1].params['叠加不透明度'];
    expect(hb).not.toBe(ha);
  });
});
