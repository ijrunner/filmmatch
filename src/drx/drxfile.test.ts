/**
 * R5 实验性 .drx 模板生成器（drx/drxfile.ts）单元测试：
 * 结构一致性（生成 → 回读）、参数改动差异、非法输入安全返回 null。
 * 注意：这些测试只验证「自洽文本容器」的内部一致性，**不表示 .drx 已被达芬奇验证可用**。
 */
import { describe, expect, it } from 'vitest';
import { DRX_WARNINGS, drxDiff, generateDrx, parseDrx, type DrxInput } from './drxfile';
import { buildNodeTree } from './nodetree';
import { cloneParams, getPreset } from '../film/params';

function baseInput(overrides: Partial<DrxInput> = {}): DrxInput {
  const card = getPreset('fl05');
  const p = cloneParams(card.params);
  return {
    recipeName: card.name,
    shareCode: 'FM-TEST-0001',
    texture: p.texture,
    look: p.look,
    resolution: { w: 1920, h: 1080 },
    lutFileName: 'FL-05.cube',
    ...overrides,
  };
}

describe('generateDrx 实验性模板生成', () => {
  it('9. 输出非空、format=template-text、experimental=true、warnings 含「实验性」', () => {
    const res = generateDrx(baseInput());
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.format).toBe('template-text');
    expect(res.experimental).toBe(true);
    expect(res.warnings.join(' ')).toContain('实验性');
    // 关键风险提示（spike① 回执后校准）
    expect(res.warnings.join(' ')).toContain('spike①');
    expect(DRX_WARNINGS.join(' ')).toContain('.drx 为达芬奇私有格式');
  });

  it('9b. 文件头含实验性标记、配方名/配方码、分辨率、生成时间占位', () => {
    const { text } = generateDrx(baseInput());
    expect(text.split('\n')[0]).toContain('FilmMatch PowerGrade');
    expect(text).toContain('实验性模板，未在达芬奇实测');
    expect(text).toContain('# 配方名: FL-05 光匣');
    expect(text).toContain('# 配方码: FM-TEST-0001');
    expect(text).toContain('# 分辨率: 1920x1080');
    expect(text).toContain('# 生成时间: (占位)');
    // 不含第三方品牌词
    for (const w of ['Kodak', '柯达', 'Fuji', 'Portra', 'Vision3']) expect(text.includes(w)).toBe(false);
  });

  it('9c. 生成是确定性的（无实时时间戳）', () => {
    expect(generateDrx(baseInput()).text).toBe(generateDrx(baseInput()).text);
  });
});

describe('parseDrx 回读（结构一致性）', () => {
  it('10. 回读节点数与 kind/name 与节点树一致', () => {
    const input = baseInput();
    const parsed = parseDrx(generateDrx(input).text);
    expect(parsed).not.toBeNull();
    const list = buildNodeTree(input);
    expect(parsed!.nodes.length).toBe(list.nodes.length);
    parsed!.nodes.forEach((n, i) => {
      expect(n.kind).toBe(list.nodes[i].kind);
      expect(n.name).toBe(list.nodes[i].name);
    });
    // 元信息可回读
    expect(parsed!.meta['配方名']).toBe('FL-05 光匣');
    expect(parsed!.meta['配方码']).toBe('FM-TEST-0001');
    expect(parsed!.meta['分辨率']).toBe('1920x1080');
    expect(parsed!.meta['LUT']).toBe('FL-05.cube');
  });

  it('10b. 参数无损回读：回读键值与原节点参数逐一相等', () => {
    const input = baseInput();
    const parsed = parseDrx(generateDrx(input).text)!;
    const list = buildNodeTree(input);
    list.nodes.forEach((node, i) => {
      const pn = parsed.nodes[i];
      expect(Object.keys(pn.params).length).toBe(Object.keys(node.params).length);
      for (const [k, v] of Object.entries(node.params)) {
        expect(pn.params[k]).toBe(String(v));
      }
    });
  });
});

describe('drxDiff 结构差异度量', () => {
  it('11. 同一文本 diff=0；改一个参数后 diff>0', () => {
    const input = baseInput();
    const t = generateDrx(input).text;
    expect(drxDiff(t, t)).toBe(0);
    expect(drxDiff(t, generateDrx(input).text)).toBe(0);
    // 改 halation.amount
    const p = cloneParams(getPreset('fl05').params);
    const t2 = generateDrx(baseInput({
      texture: { ...p.texture, halation: { ...p.texture.halation, amount: p.texture.halation.amount - 0.5 } },
    })).text;
    expect(t2).not.toBe(t);
    expect(drxDiff(t, t2)).toBeGreaterThan(0);
    expect(drxDiff(t, t2)).toBeLessThanOrEqual(1);
  });

  it('11b. 非法一侧参与比较时返回 1（视为完全不同）', () => {
    const t = generateDrx(baseInput()).text;
    expect(drxDiff(t, '乱码')).toBe(1);
    expect(drxDiff('乱码', t)).toBe(1);
  });
});

describe('parseDrx 非法输入', () => {
  it('12. parseDrx("乱码") 返回 null 且不抛异常', () => {
    expect(() => parseDrx('乱码')).not.toThrow();
    expect(parseDrx('乱码')).toBeNull();
    expect(parseDrx('')).toBeNull();
    expect(parseDrx('NODE 1|X|grade\nPARAM 1|k|v')).toBeNull(); // 缺头部标记
    expect(parseDrx('# FilmMatch PowerGrade (x)\nPARAM 1|k|v')).toBeNull(); // 无 NODE
  });
});
