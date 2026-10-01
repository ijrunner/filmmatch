/**
 * R17 数据范围（Data Range）测试：
 *  - 语义：预览不变，仅声明 .cube 导出目标；'legal' = 输入 Legal→Full 展开 + 输出 Full→Legal 回编；
 *  - 护栏（默认恒等）：range='full'（默认/缺省）时导出与既有路径**逐字节一致**；
 *  - schema：可选字段 output.range，缺省/缺字段/非法值读为 'full'（旧配方读入观感与导出逐位不变）；
 *  - 配方码稳定：range 不参与 shareCodeOf hash（切换范围不改变配方码）。
 */
import { describe, expect, it } from 'vitest';
import { analyzeImage } from '../engine';
import { LEGAL_HIGH, LEGAL_LOW, normalizeDataRange, parseCube, rangeWrap, toCube } from '../engine/lut';
import type { RGB } from '../engine/types';
import { getPreset } from '../film/params';
import { bakeLutOp } from '../workers/ops-lut';
import {
  bakeRecipeLUT, buildRecipe, recipeToState, shareCodeOf,
  type Recipe, type RecipeState,
} from './recipe';
import { parseRecipe, serializeRecipe } from './storage';

function synthStats(): { ref: ReturnType<typeof analyzeImage>; user: ReturnType<typeof analyzeImage> } {
  const S = 96;
  const ref = new Uint8ClampedArray(S * S * 4);
  const user = new Uint8ClampedArray(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const t = (x + y) / (2 * S);
      ref[i] = 30 + 120 * t; ref[i + 1] = 40 + 110 * t; ref[i + 2] = 60 + 90 * t; ref[i + 3] = 255;
      user[i] = 60 + 90 * t; user[i + 1] = 60 + 90 * t; user[i + 2] = 60 + 90 * t; user[i + 3] = 255;
    }
  }
  return { ref: analyzeImage(ref, S, S), user: analyzeImage(user, S, S) };
}

function stateFixture(): RecipeState {
  const card = getPreset('fl05');
  const stats = synthStats();
  return {
    colorParams: { match_strength: 0.75, skin_hue: 0, skin_sat: 1, skin_isolation: 0, split_tone: 0, tone_contrast: 1, shadow_lift: 0, global_sat: 1, highlight_rolloff: 0 },
    look: card.params.look,
    texture: card.params.texture,
    master: 1,
    origins: { ...card.origins },
    refStats: stats.ref,
    userStats: stats.user,
  };
}

/* ---------------- 常量与包裹数学 ---------------- */

describe('R17 数据范围：常量与 rangeWrap', () => {
  it('LEGAL 锚点 = 8bit 16/235 归一化（≈0.0627 / ≈0.9216）', () => {
    expect(LEGAL_LOW).toBeCloseTo(16 / 255, 12);
    expect(LEGAL_HIGH).toBeCloseTo(235 / 255, 12);
    expect(LEGAL_LOW).toBeGreaterThan(0.062);
    expect(LEGAL_LOW).toBeLessThan(0.063);
  });

  it("range='full' 恒等返回原函数（同一引用 → 烘焙逐位不变的关键）", () => {
    const fn = (rgb: RGB): RGB => [rgb[0], rgb[1], rgb[2]];
    expect(rangeWrap(fn, 'full')).toBe(fn);
  });

  it("'legal' 包裹：E(f(D(x)))——端点正确、域内恒等往返、域外钳制", () => {
    const f = (rgb: RGB): RGB => [rgb[0] * 0.5, rgb[1] * 0.5, rgb[2] * 0.5];
    const g = rangeWrap(f, 'legal');
    const span = LEGAL_HIGH - LEGAL_LOW;
    // x=0（Full 黑位）→ D→0 → f→0 → E→LEGAL_LOW
    const black = g([0, 0, 0]);
    expect(black[0]).toBeCloseTo(LEGAL_LOW, 12);
    // x=1 → D→1 → f→0.5 → E→0.5*span+lo
    const white = g([1, 1, 1]);
    expect(white[0]).toBeCloseTo(0.5 * span + LEGAL_LOW, 12);
    // 域内值 D 精确往返：g(x) = f(x)*span + lo（x∈[lo,hi]）
    const mid = g([LEGAL_LOW + 0.4 * span, LEGAL_LOW + 0.4 * span, LEGAL_LOW + 0.4 * span]);
    expect(mid[0]).toBeCloseTo(0.5 * 0.4 * span + LEGAL_LOW, 12);
    // 超出 legal 域的输入（如负值）→ D 钳到 0 → E → LEGAL_LOW
    const under = g([-1, -1, -1]);
    expect(under[0]).toBeCloseTo(LEGAL_LOW, 12);
    // 输出天然落在 [LEGAL_LOW, LEGAL_HIGH]（f 输出 ∈ [0,1]）
    expect(g([1, 1, 1])[1]).toBeLessThanOrEqual(LEGAL_HIGH + 1e-12);
  });
});

/* ---------------- .cube 导出：默认逐字节一致 + legal 头部声明 ---------------- */

describe('R17 数据范围：.cube 导出', () => {
  const st = stateFixture();
  const title = '测试配方 FM-ABCD';

  it('护栏：full（默认）导出与既有实现逐字节一致（不含 COMMENT，opts 缺省/空数组同文）', () => {
    // 既有实现 = toCube(bakeRecipeLUT(st), title)（R10 起 .cube 一直走 bakeRecipeLUT）
    const legacy = toCube(bakeRecipeLUT(st, 65, 'full'), title);
    // 经 ops 路径（worker 同款）+ 显式 range='full' + 空 comments —— 必须同文
    const viaOps = bakeLutOp({ state: st, size: 65, kind: 'recipe', range: 'full' });
    const viaOpsDefault = bakeLutOp({ state: st, size: 65, kind: 'recipe' });
    expect(viaOps.table.length).toBe(viaOpsDefault.table.length);
    for (let i = 0; i < viaOps.table.length; i++) expect(viaOps.table[i]).toBe(viaOpsDefault.table[i]);
    const text = toCube({ size: viaOps.size, table: viaOps.table }, title, { comments: [] });
    expect(text).toBe(legacy);
    expect(text.startsWith(`TITLE "${title}"\nLUT_3D_SIZE 65`)).toBe(true);
    expect(text.includes('COMMENT')).toBe(false);
  });

  it("'legal' 导出：COMMENT 声明范围与公式；数据行 = full 表 E∘f∘D 重映射；parseCube 兼容", () => {
    const full = bakeRecipeLUT(st, 33, 'full');
    const legal = bakeRecipeLUT(st, 33, 'legal');
    const textFull = toCube(full, title);
    const textLegal = toCube(legal, title, {
      comments: ['data-range: video-legal (Full/Data preview unchanged)'],
    });
    // 头部：TITLE → COMMENT → LUT_3D_SIZE → DOMAIN
    const lines = textLegal.split('\n');
    expect(lines[0]).toBe(`TITLE "${title}"`);
    expect(lines[1]).toBe('COMMENT data-range: video-legal (Full/Data preview unchanged)');
    expect(lines[2]).toBe('LUT_3D_SIZE 33');
    expect(lines[3]).toBe('DOMAIN_MIN 0.0 0.0 0.0');
    // full 无 COMMENT 且两文本不同
    expect(textFull.includes('COMMENT')).toBe(false);
    expect(textLegal).not.toBe(textFull);
    // 首数据行（跳过 TITLE/COMMENT/LUT_3D_SIZE/DOMAIN 头部）= f(D(0,0,0)) 回编：D(0)=0 → f(0,0,0) → E
    const firstDataRow = (t: string): number[] => {
      for (const line of t.split('\n')) {
        if (/^\s*-?[0-9]/.test(line)) return line.trim().split(/\s+/).map(Number);
      }
      return [NaN, NaN, NaN];
    };
    const row0 = firstDataRow(textLegal);
    const f0 = full.table;
    const span = LEGAL_HIGH - LEGAL_LOW;
    expect(row0[0]).toBeCloseTo(f0[0] * span + LEGAL_LOW, 5);
    expect(row0[1]).toBeCloseTo(f0[1] * span + LEGAL_LOW, 5);
    expect(row0[2]).toBeCloseTo(f0[2] * span + LEGAL_LOW, 5);
    // 解析即校验：COMMENT 行不破坏 parseCube，数值还原（6 位小数文本 + float32 存储，往返误差 ≤1e-6）
    const back = parseCube(textLegal);
    expect(back.size).toBe(33);
    expect(back.table.length).toBe(legal.table.length);
    for (let i = 0; i < legal.table.length; i++) {
      expect(Math.abs(back.table[i] - legal.table[i])).toBeLessThanOrEqual(1.000001e-6);
    }
  });

  it("'legal' 导出的表落在 legal 域内（输出天然被 E 压进 [LEGAL_LOW, LEGAL_HIGH]）", () => {
    const legal = bakeRecipeLUT(stateFixture(), 33, 'legal');
    let min = 1, max = 0;
    for (let i = 0; i < legal.table.length; i++) {
      if (legal.table[i] < min) min = legal.table[i];
      if (legal.table[i] > max) max = legal.table[i];
    }
    expect(min).toBeGreaterThanOrEqual(LEGAL_LOW - 1e-6);
    expect(max).toBeLessThanOrEqual(LEGAL_HIGH + 1e-6);
  });
});

/* ---------------- schema：可选字段 output.range（不 bump 版本号） ---------------- */

describe('R17 数据范围：配方 schema 与运行时', () => {
  it('buildRecipe 写出 output.range（默认 full；state.range=legal 时 legal）；版本号随 R18 升为 1.3', () => {
    const st = stateFixture();
    const rFull = buildRecipe({ name: 'x', sourceType: 'library', refImageId: null, stockId: null, state: st });
    expect(rFull.schema_version).toBe(1.3);
    expect(rFull.output.range).toBe('full');
    const rLegal = buildRecipe({ name: 'x', sourceType: 'library', refImageId: null, stockId: null, state: { ...st, range: 'legal' } });
    expect(rLegal.output.range).toBe('legal');
    expect(rLegal.output.working_space).toBe('rec709');
  });

  it('recipeToState：缺字段/非法值 → full；legal → legal（旧配方读入观感与导出不变）', () => {
    const st = stateFixture();
    const r = buildRecipe({ name: 'x', sourceType: 'library', refImageId: null, stockId: null, state: st });
    // 模拟旧配方：删除 output.range
    const legacy = JSON.parse(JSON.stringify(r)) as typeof r;
    delete (legacy.output as { range?: unknown }).range;
    expect(recipeToState(legacy).range).toBe('full');
    // 非法值
    const bad = { ...r, output: { ...r.output, range: 'video' } };
    expect(recipeToState(bad as unknown as typeof r).range).toBe('full');
    // legal
    const legal = { ...r, output: { ...r.output, range: 'legal' } };
    expect(recipeToState(legal as typeof r).range).toBe('legal');
  });

  it('serialize→parse 往返保留 range（storage 层透传 + 校验不拒）', () => {
    const st = { ...stateFixture(), range: 'legal' as const };
    const r = buildRecipe({ name: 'x', sourceType: 'library', refImageId: null, stockId: null, state: st });
    const back = parseRecipe(serializeRecipe(r)) as unknown as Recipe;
    expect(back.output?.range).toBe('legal');
  });

  it('配方码稳定：切换 range 不改变 shareCodeOf（range 不进 hash）', () => {
    const st = stateFixture();
    const cFull = shareCodeOf(st);
    const stLegal: RecipeState = { ...st, range: 'legal' };
    const cLegal = shareCodeOf(stLegal);
    expect(cLegal).toBe(cFull);
  });

  it('normalizeDataRange：缺省/未知 → full', () => {
    expect(normalizeDataRange(undefined)).toBe('full');
    expect(normalizeDataRange(null)).toBe('full');
    expect(normalizeDataRange('legal')).toBe('legal');
    expect(normalizeDataRange('Legal')).toBe('full');   // 严格小写字面量
    expect(normalizeDataRange(42)).toBe('full');
  });
});
