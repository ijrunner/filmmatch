/**
 * 存储封装（决策 0003 · F7 本地降级契约）测试。
 * node 环境注入内存版 localStorage 模拟；文件导出/导入走纯函数（serialize/parse）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  codeBook, findByCode, listRecipes, listUserRefs, loadRecipe, parseRecipe,
  registerCode, removeRecipe, removeUserRef, saveRecipe, saveUserRef,
  serializeRecipe, type RecipeLike,
} from './storage';

/** 内存版 localStorage */
function mockLS(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

function sampleRecipe(id: string): RecipeLike {
  const r = {
    schema_version: 1,
    id,
    share_code: 'FM-TEST',
    name: '测试配方 ' + id,
    meta: { created_at: '2026-09-20T00:00:00Z', author: 'local',
      source: { type: 'library', ref_image_id: 'lib_neon_fl05', stock_id: null } },
    color: { engine: 'colormatch-v1', params: { match_strength: 0.75 }, look: {}, lut_size: 65 },
    texture: { halation: {}, grain: {}, bloom: {}, vignette: {} },
    output: { working_space: 'rec709', export_targets: ['cube'] },
  };
  return r as RecipeLike;
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = mockLS();
});

describe('配方存储（save/load/list/remove）', () => {
  it('保存/载入/列表/删除 upsert 语义', () => {
    expect(listRecipes()).toEqual([]);
    saveRecipe(sampleRecipe('a'));
    saveRecipe(sampleRecipe('b'));
    expect(listRecipes().map((r) => r.id)).toEqual(['b', 'a']); // 新的在前
    const a = loadRecipe('a');
    expect(a?.id).toBe('a');
    expect(((a as unknown as { color?: { params: unknown } }).color?.params)).toEqual({ match_strength: 0.75 });
    // 同 id 覆盖
    const a2 = sampleRecipe('a');
    (a2 as unknown as { name: string }).name = '改过的';
    saveRecipe(a2);
    expect(listRecipes()).toHaveLength(2);
    expect((loadRecipe('a') as unknown as { name: string })?.name).toBe('改过的');
    removeRecipe('a');
    expect(listRecipes().map((r) => r.id)).toEqual(['b']);
    expect(loadRecipe('a')).toBeNull();
  });

  it('非法输入与载入不存在 id', () => {
    expect(saveRecipe(null as unknown as RecipeLike)).toBe(false);
    expect(saveRecipe({} as RecipeLike)).toBe(false);
    expect(loadRecipe('nope')).toBeNull();
  });

  it('码本：注册/按码查找（大小写不敏感）/删配方清码', () => {
    saveRecipe(sampleRecipe('a'));
    saveRecipe(sampleRecipe('b'));
    registerCode('FM-ABCD', 'a');
    registerCode('fm-xy12', 'b');
    expect(codeBook()['a']).toBe('FM-ABCD');
    expect(findByCode('fm-abcd')?.id).toBe('a');
    expect(findByCode(' FM-XY12 ')?.id).toBe('b');
    expect(findByCode('FM-ZZZZ')).toBeNull();
    removeRecipe('a');
    expect(findByCode('FM-ABCD')).toBeNull();
  });
});

describe('配方文件（serialize/parse）', () => {
  it('JSON 往返无损', () => {
    const r = sampleRecipe('round');
    const text = serializeRecipe(r);
    expect(parseRecipe(text)).toEqual(r);
  });

  it('解析即校验：坏 JSON / 错版本 / 缺段 抛错', () => {
    expect(() => parseRecipe('not json{')).toThrow();
    expect(() => parseRecipe('{"schema_version": 2}')).toThrow(/版本/);
    expect(() => parseRecipe('{"schema_version": 1, "id": "x"}')).toThrow(/color\/texture/);
    expect(() => parseRecipe('')).toThrow();
  });
});

describe('用户参考图入库', () => {
  it('保存/列表/删除，容量裁剪', () => {
    for (let i = 0; i < 15; i++) {
      saveUserRef({ id: 'r' + i, name: 'n' + i, thumb: 'data:', stats: {}, texture: {}, created_at: '' });
    }
    const list = listUserRefs();
    expect(list).toHaveLength(12); // MAX_USERREFS=12
    expect(list[0].id).toBe('r14');
    removeUserRef('r14');
    expect(listUserRefs().some((r) => r.id === 'r14')).toBe(false);
  });
});

describe('localStorage 不可用时内存兜底', () => {
  it('无 localStorage 仍可保存/读取（不抛错）', () => {
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
    saveRecipe(sampleRecipe('mem'));
    expect(loadRecipe('mem')?.id).toBe('mem');
  });
});

/* ================= R8 · 预设导入/导出健壮性 =================
 * 导出→导入回环逐位一致；坏 JSON / 越界值 / 不支持版本 → 明确报错而不是崩。 */
describe('R8 配方文件：回环与坏文件', () => {
  /** 含 Schema v1.2 全字段的配方（覆盖 look 5 个分离色调 + texture v1.1 字段） */
  function fullRecipe(): RecipeLike {
    return {
      schema_version: 1.2,
      id: 'fm_round8',
      share_code: 'FM-R8RT',
      name: '回环 · 青橙商业',
      meta: { created_at: '2026-09-23T00:00:00Z', author: 'local',
        source: { type: 'stock', ref_image_id: null, stock_id: 'st03' } },
      color: {
        engine: 'colormatch-v1',
        params: { match_strength: 0.75 },
        look: {
          fade: { value: 0.1, origin: 'annotated' }, black_lift: { value: 0.02, origin: 'user' },
          dye_coupling: { value: 0.05, origin: 'annotated' }, shadow_bias: { value: 0, origin: 'annotated' },
          highlight_bias: { value: 0, origin: 'annotated' }, film_s: { value: 0.2, origin: 'annotated' },
          contrast: { value: 0.45, origin: 'annotated' }, saturation: { value: 1.15, origin: 'annotated' },
          warmth: { value: 0.12, origin: 'annotated' },
          split_shadow_hue: { value: 0.52, origin: 'annotated' }, split_shadow_sat: { value: 0.42, origin: 'annotated' },
          split_highlight_hue: { value: 0.08, origin: 'annotated' }, split_highlight_sat: { value: 0.38, origin: 'annotated' },
          split_balance: { value: 0.1, origin: 'annotated' },
        },
        lut_size: 65,
      },
      texture: {
        halation: { enabled: true, amount: { value: 0.3, origin: 'annotated' }, tint_rgb: { value: [1, 0.4, 0.25], origin: 'annotated' } },
        grain: { enabled: true, iso: { value: 200, origin: 'annotated' }, type: 'positive', mode: 'analogue' },
        bloom: { enabled: true, amount: { value: 0.18, origin: 'annotated' } },
        vignette: { enabled: true, amount: { value: 0.16, origin: 'annotated' } },
      },
      master: { value: 1, origin: 'annotated' },
      output: { working_space: 'rec709', export_targets: ['cube', 'drx', 'recipe_code'] },
    } as unknown as RecipeLike;
  }

  it('导出→导入回环逐位一致（含 v1.2 分离色调字段）', () => {
    const r = fullRecipe();
    const text = serializeRecipe(r);
    const back = parseRecipe(text);
    expect(back).toEqual(r);
    expect((back as unknown as { schema_version: number }).schema_version).toBe(1.2);
  });

  it('坏 JSON / 不支持版本 / 缺段 → 明确报错', () => {
    expect(() => parseRecipe('not json{')).toThrow(/合法 JSON/);
    expect(() => parseRecipe(JSON.stringify({ ...fullRecipe(), schema_version: 3 }))).toThrow(/不支持的配方版本/);
    expect(() => parseRecipe(JSON.stringify({ ...fullRecipe(), id: '' }))).toThrow(/缺少 id/);
    const noColor = JSON.parse(serializeRecipe(fullRecipe()));
    delete noColor.color;
    expect(() => parseRecipe(JSON.stringify(noColor))).toThrow(/color\/texture/);
  });

  it('越界值 → 报错并指出字段路径（look 与 texture 都覆盖）', () => {
    const r = JSON.parse(serializeRecipe(fullRecipe()));
    r.color.look.split_shadow_sat.value = 5; // 区间 0..1
    expect(() => parseRecipe(JSON.stringify(r))).toThrow(/color\.look\.split_shadow_sat=5/);
    const r2 = JSON.parse(serializeRecipe(fullRecipe()));
    r2.color.look.split_balance.value = -9; // 区间 -1..1
    expect(() => parseRecipe(JSON.stringify(r2))).toThrow(/split_balance=-9/);
    const r3 = JSON.parse(serializeRecipe(fullRecipe()));
    r3.texture.halation.tint_rgb.value = [1, 1.5, 0.2]; // tint 分量 0..1
    expect(() => parseRecipe(JSON.stringify(r3))).toThrow(/texture\.halation\.tint_rgb/);
    const r4 = JSON.parse(serializeRecipe(fullRecipe()));
    r4.texture.grain.iso.value = -5;
    expect(() => parseRecipe(JSON.stringify(r4))).toThrow(/texture\.grain\.iso=-5/);
  });

  it('v1.1 旧配方（无分离色调字段）可被接受；v1 旧配方同样接受', () => {
    const r = JSON.parse(serializeRecipe(fullRecipe()));
    r.schema_version = 1.1;
    for (const k of Object.keys(r.color.look)) if (k.startsWith('split_')) delete r.color.look[k];
    expect(() => parseRecipe(JSON.stringify(r))).not.toThrow();
    const r1 = JSON.parse(serializeRecipe(fullRecipe()));
    r1.schema_version = 1;
    expect(() => parseRecipe(JSON.stringify(r1))).not.toThrow();
  });
});
