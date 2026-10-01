/**
 * 配方模型（ui/recipe.ts）测试：
 * 组装 Schema v1 全结构 / 往返解析 / 配方码确定性 / 复合变换与 .cube 烘焙合法性。
 */
import { describe, expect, it } from 'vitest';
import { analyzeImage } from '../engine';
import { parseCube, toCube } from '../engine/lut';
import { getPreset } from '../film/params';
import { lookTransform } from '../engine/look';
import {
  bakeRecipeLUT, buildRecipe, compositeTransform, isSupportedSchemaVersion, makeId, recipeToState,
  SCHEMA_VERSION, shareCodeOf, SUPPORTED_SCHEMA_VERSIONS,
  type RecipeState,
} from './recipe';
import { parseRecipe, serializeRecipe } from './storage';

/** 合成统计：256×256 渐变 + 若干色块（与 engine 测试同思路，独立小图） */
function synthStats(): { ref: ReturnType<typeof analyzeImage>; user: ReturnType<typeof analyzeImage> } {
  const S = 256;
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

function stateOf(presetId: string, stats: { ref: ReturnType<typeof analyzeImage>; user: ReturnType<typeof analyzeImage> } | null): RecipeState {
  const card = getPreset(presetId);
  return {
    colorParams: presetId === 'neutral'
      ? { match_strength: 0, skin_hue: 0, skin_sat: 1, skin_isolation: 0, split_tone: 0, tone_contrast: 1, shadow_lift: 0, global_sat: 1, highlight_rolloff: 0 }
      : { match_strength: 0.75, skin_hue: 0, skin_sat: 1, skin_isolation: 0, split_tone: 0, tone_contrast: 1, shadow_lift: 0, global_sat: 1, highlight_rolloff: 0 },
    look: card.params.look,
    texture: card.params.texture,
    master: 1,
    origins: { ...card.origins },
    refStats: stats?.ref ?? null,
    userStats: stats?.user ?? null,
  };
}

describe('buildRecipe（Schema v1 全结构）', () => {
  const stats = synthStats();

  it('组装全结构：版本/id/码/meta/color+look/texture 带 origin/output', () => {
    const r = buildRecipe({
      name: '霓虹夜色 × 光匣 · FM-05',
      sourceType: 'library',
      refImageId: 'lib_neon_fl05',
      stockId: null,
      state: stateOf('fl05', stats),
    });
    expect(r.schema_version).toBe(1.3);
    expect(r.id).toMatch(/^fm_[a-z2-9]{5}$/);
    expect(r.share_code).toMatch(/^FM-[A-Z2-9]{4}$/);
    expect(r.meta.source).toEqual({ type: 'library', ref_image_id: 'lib_neon_fl05', stock_id: null });
    expect(r.meta.stats?.ref?.version).toBe(1);
    expect(r.meta.stats?.source?.samples).toBeGreaterThan(0);
    expect(r.color.engine).toBe('colormatch-v1');
    expect(r.color.params.match_strength).toBeCloseTo(0.75);
    expect(r.color.lut_size).toBe(65);
    expect(r.color.look['fade']).toEqual({ value: 0, origin: 'annotated' });
    expect(r.texture.grain['iso']).toEqual({ value: 400, origin: 'annotated' });
    expect(r.texture.halation['tint_rgb']).toBeDefined();
    expect(r.master).toEqual({ value: 1, origin: 'annotated' });
    // R17：output 新增可选 range（数据范围声明），默认 'full' 与既有导出逐位不变
    expect(r.output).toEqual({ working_space: 'rec709', export_targets: ['cube', 'drx', 'recipe_code'], range: 'full' });
    // JSON 可序列化
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it('shareCodeOf 确定性：内容不变码不变；内容变码变；与 buildRecipe 一致', () => {
    const s = stateOf('fl05', stats);
    const c1 = shareCodeOf(s);
    const c2 = shareCodeOf({ ...s, master: 1 });
    expect(c1).toBe(c2);
    const c3 = shareCodeOf({ ...s, master: 0.5 });
    expect(c3).not.toBe(c1);
    const r = buildRecipe({ name: 'x', sourceType: 'library', refImageId: null, stockId: null, state: s });
    expect(r.share_code).toBe(c1);
  });

  it('makeId 唯一性与格式', () => {
    const ids = new Set(Array.from({ length: 200 }, makeId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^fm_[a-z2-9]{5}$/);
  });
});

describe('recipeToState（往返）', () => {
  it('配方 JSON → 运行时状态：参数/look/texture/master/origin 保持', () => {
    const stats = synthStats();
    const before = stateOf('fl07', stats);
    const r = buildRecipe({ name: 'x', sourceType: 'library', refImageId: 'lib_neon_fl07', stockId: null, state: before });
    const after = recipeToState(r);
    expect(after.colorParams).toEqual(before.colorParams);
    expect(after.look).toEqual(before.look);
    expect(after.texture).toEqual(before.texture);
    expect(after.master).toBe(1);
    expect(after.origins['grain.iso']).toBe('annotated');
    expect(after.origins['look.fade']).toBe('annotated');
    expect(after.refStats?.samples).toBe(stats.ref.samples);
    expect(after.userStats?.samples).toBe(stats.user.samples);
  });
});

describe('复合变换与 .cube 导出', () => {
  const stats = synthStats();

  it('缺统计（选型号直出）→ 仅 look 生效；neutral look 时恒等', () => {
    const neutral: RecipeState = { ...stateOf('neutral', null), look: { fade: 0, black_lift: 0, dye_coupling: 0, shadow_bias: 0, highlight_bias: 0, film_s: 0, contrast: 0, saturation: 1, warmth: 0, split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0 } };
    const fn = compositeTransform(neutral);
    const p = [0.3, 0.5, 0.7] as [number, number, number];
    const o = fn(p);
    expect(Math.abs(o[0] - p[0])).toBeLessThan(1e-6);
    expect(Math.abs(o[1] - p[1])).toBeLessThan(1e-6);
    expect(Math.abs(o[2] - p[2])).toBeLessThan(1e-6);
  });

  it('有统计 + look → 变换生效（对中间灰产生可见色偏）', () => {
    const s: RecipeState = { ...stateOf('fl05', stats), colorParams: { ...stateOf('fl05', stats).colorParams, match_strength: 1 } };
    const fn = compositeTransform(s);
    const p = [0.5, 0.5, 0.5] as [number, number, number];
    const o = fn(p);
    const moved = Math.abs(o[0] - p[0]) + Math.abs(o[1] - p[1]) + Math.abs(o[2] - p[2]);
    console.info('[composite] 灰点位移合计 =', moved.toFixed(4));
    expect(moved).toBeGreaterThan(0.01);
  });

  it('复合 LUT 烘焙 → toCube/parseCube 回环合法（65³ 行数、数值一致）', () => {
    const s = stateOf('fl07', stats);
    const lut = bakeRecipeLUT(s, 65);
    expect(lut.size).toBe(65);
    const text = toCube(lut, '工作台复合 LUT');
    const dataLines = text.split(/\r?\n/).filter((l) => /^\d/.test(l.trim()) && l.trim().split(/\s+/).length >= 3).length;
    expect(dataLines).toBe(65 ** 3);
    const parsed = parseCube(text);
    let maxDiff = 0;
    for (let i = 0; i < lut.table.length; i++) maxDiff = Math.max(maxDiff, Math.abs(parsed.table[i] - lut.table[i]));
    expect(maxDiff).toBeLessThanOrEqual(1e-3);
    // 33³ 快速烘焙（拖动中）也可用
    expect(bakeRecipeLUT(s, 33).size).toBe(33);
  });
});

/* ================= Schema v1.2 → v1.3（分离色调 / R18 coupling+hsl+anchors） =================
 * 写出版本 1.3；读入 v1.1 旧配方（无 split/coupling/hsl 字段）时新字段取恒等默认、其余 look 字段逐位一致。 */
describe('Schema 版本与迁移（v1.3）', () => {
  const stats = synthStats();

  it('写出版本为 1.3；color.look 含 5 个分离色调字段（默认 0）', () => {
    const r = buildRecipe({ name: 'x', sourceType: 'stock', refImageId: null, stockId: 'fl05', state: stateOf('fl05', stats) });
    expect(r.schema_version).toBe(1.3);
    for (const k of ['split_shadow_hue', 'split_shadow_sat', 'split_highlight_hue', 'split_highlight_sat', 'split_balance']) {
      expect(r.color.look[k], `缺 look.${k}`).toBeDefined();
      expect(r.color.look[k].value).toBe(0);
    }
  });

  it('SCHEMA_VERSION=1.3，SUPPORTED_SCHEMA_VERSIONS=[1,1.1,1.2,1.3]，isSupportedSchemaVersion 判定正确', () => {
    expect(SCHEMA_VERSION).toBe(1.3);
    expect([...SUPPORTED_SCHEMA_VERSIONS]).toEqual([1, 1.1, 1.2, 1.3]);
    expect(isSupportedSchemaVersion(1)).toBe(true);
    expect(isSupportedSchemaVersion(1.1)).toBe(true);
    expect(isSupportedSchemaVersion(1.2)).toBe(true);
    expect(isSupportedSchemaVersion(1.3)).toBe(true);
    expect(isSupportedSchemaVersion(2)).toBe(false);
    expect(isSupportedSchemaVersion('1.2')).toBe(false);
  });

  it('v1.1 旧配方（无 split 字段）→ 5 字段为恒等默认，其余 look 字段与旧值逐位一致', () => {
    const old = buildRecipe({ name: '旧配方', sourceType: 'library', refImageId: 'lib_neon_fl05', stockId: null, state: stateOf('fl05', stats) });
    // 降级为 v1.1：删掉 split 字段（模拟旧版本写出的 JSON）
    const fixture = JSON.parse(JSON.stringify(old)) as typeof old;
    fixture.schema_version = 1.1;
    const oldLookValues: Record<string, number> = {};
    for (const [k, v] of Object.entries(fixture.color.look)) {
      if (k.startsWith('split_')) delete (fixture.color.look as Record<string, unknown>)[k];
      else oldLookValues[k] = (v as { value: number }).value;
    }
    const st = recipeToState(fixture);
    // 新字段恒等默认
    expect(st.look.split_shadow_hue).toBe(0);
    expect(st.look.split_shadow_sat).toBe(0);
    expect(st.look.split_highlight_hue).toBe(0);
    expect(st.look.split_highlight_sat).toBe(0);
    expect(st.look.split_balance).toBe(0);
    // 其余 look 字段逐位一致（旧值 = fl05 的标注值）
    const card = getPreset('fl05');
    for (const [k, v] of Object.entries(oldLookValues)) {
      expect(st.look[k as keyof typeof st.look], `look.${k}`).toBe(v);
      expect(st.look[k as keyof typeof st.look], `look.${k} vs 预设`).toBe((card.params.look as unknown as Record<string, number>)[k]);
    }
    // 旧配方读取观感不变：复合变换与直接由预设卡构造的状态一致
    const fresh = stateOf('fl05', stats);
    const p = [0.3, 0.5, 0.7] as [number, number, number];
    const a = compositeTransform(st)(p);
    const b = compositeTransform(fresh)(p);
    for (let i = 0; i < 3; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(1e-12);
  });

  it('v1.1 夹具经 recipeToState 后重新 buildRecipe → 写出版本 1.3（迁移即升版）', () => {
    const old = buildRecipe({ name: 'x', sourceType: 'stock', refImageId: null, stockId: 'fl06', state: stateOf('fl06', stats) });
    const fixture = JSON.parse(JSON.stringify(old));
    fixture.schema_version = 1.1;
    for (const k of Object.keys(fixture.color.look)) if (k.startsWith('split_')) delete fixture.color.look[k];
    const st = recipeToState(fixture);
    const rebuilt = buildRecipe({ name: 'x', sourceType: 'stock', refImageId: null, stockId: 'fl06', state: st });
    expect(rebuilt.schema_version).toBe(1.3);
    expect(rebuilt.color.look['split_shadow_sat'].value).toBe(0);
  });
});

/* ================= R12 · R9 新参数导出/导入回环 =================
 * R9 新增 grain.cluster 与 gate_weave.{amount,speed}；本节证明：
 *   ① 带非默认值 → buildRecipe → serializeRecipe（导出 JSON）→ parseRecipe（导入）→ recipeToState，
 *      三处数值逐位一致（原 state / 导出 JSON 的 value / 导入回 state）；
 *   ② 旧配方（缺这两处字段）导入后取恒等默认（cluster=0 / gate_weave.amount=0），其余字段不变。 */
/* ================= R18 · Schema v1.3（coupling / hsl / anchors）导出导入回环 ================= */
describe('R18 Schema v1.3 新维度（coupling / hsl / anchors）导出导入回环', () => {
  const stats = synthStats();

  it('非默认 coupling/hsl/anchors → 导出 JSON（Schema 包装）→ 导入 → 数值逐位一致', () => {
    const base = stateOf('fl05', stats);
    const s: RecipeState = {
      ...base,
      look: {
        ...base.look,
        dye_coupling: 0.15,
        coupling: { rg: 0.48, rb: 0.72, gr: 0.11, gb: 0.9, br: 0.33, bg: 0.06 },
        hsl: { red: { hue: 0.3, sat: -0.5, lum: 0.2 }, blue: { hue: -0.1, sat: 0.4, lum: -0.3 } },
      },
      origins: {
        ...base.origins,
        'look.coupling.rg': 'user', 'look.hsl.red.hue': 'user',
      },
      anchors: { yrgb: { black: 0.021, white: 0.98, pivot: 0.5 }, rcm: { black: 0.021, white: 0.98, pivot: 0.333 } },
    };
    const r = buildRecipe({ name: 'R18 回环', sourceType: 'library', refImageId: 'lib_neon_fl05', stockId: null, state: s });
    expect(r.schema_version).toBe(1.3);
    expect(r.anchors).toEqual(s.anchors);
    const lookJson = r.color.look as unknown as Record<string, Record<string, Record<string, { value: number; origin: string }>>>;
    expect(lookJson.coupling.rg).toEqual({ value: 0.48, origin: 'user' });
    expect(lookJson.hsl.red.hue).toEqual({ value: 0.3, origin: 'user' });
    expect(lookJson.hsl.blue.lum).toEqual({ value: -0.3, origin: 'user' });   // 无 origin 记录 → 既有 'user' 兜底
    const back = parseRecipe(serializeRecipe(r));
    const st = recipeToState(back as unknown as Parameters<typeof recipeToState>[0]);
    expect(st.look.coupling).toEqual(s.look.coupling);
    expect(st.look.hsl!.red).toEqual({ hue: 0.3, sat: -0.5, lum: 0.2 });
    expect(st.anchors).toEqual(s.anchors);
    expect(st.origins['look.coupling.rg']).toBe('user');
    expect(st.origins['look.hsl.red.hue']).toBe('user');
  });

  it('旧 v1.2 配方（无 coupling/hsl/anchors）导入 → 三组新字段全部不出现（恒等，行为不变）', () => {
    const base = stateOf('fl04', stats);
    const r = buildRecipe({ name: 'v12 旧配方', sourceType: 'library', refImageId: null, stockId: null, state: base });
    const legacy = JSON.parse(serializeRecipe(r)) as Record<string, unknown>;
    legacy.schema_version = 1.2;
    const lookJson = (legacy.color as Record<string, Record<string, unknown>>).look;
    delete lookJson.coupling;
    delete lookJson.hsl;
    delete legacy.anchors;
    const st = recipeToState(parseRecipe(serializeRecipe(legacy as never)) as never);
    expect(st.look.coupling).toBeUndefined();
    expect(st.look.hsl).toBeUndefined();
    expect(st.anchors).toBeUndefined();
    /* 恒等护栏：导入后的 look 渲染与 R18 引擎对 v1.2 配方的输出逐位一致 */
    const a = lookTransform(st.look as never);
    const b = lookTransform(base.look as never);
    for (const c of [[0.2, 0.5, 0.8], [0.9, 0.3, 0.1]] as const) {
      expect(a([...c])).toEqual(b([...c]));
    }
  });

  it('区间校验：coupling/hsl/anchors 越界抛可读错误', () => {
    const base = stateOf('fl04', stats);
    const r = buildRecipe({ name: '越界', sourceType: 'library', refImageId: null, stockId: null, state: base });
    const mk = (mut: (j: Record<string, any>) => void): string => {
      const j = JSON.parse(serializeRecipe(r)) as Record<string, any>;
      mut(j);
      return serializeRecipe(j as never);
    };
    expect(() => parseRecipe(mk((j) => { j.color.look.coupling = { rg: { value: 5 } }; }))).toThrow(/coupling\.rg/);
    expect(() => parseRecipe(mk((j) => { j.color.look.hsl = { red: { lum: { value: -3 } } }; }))).toThrow(/hsl\.red\.lum/);
    expect(() => parseRecipe(mk((j) => { j.anchors = { yrgb: { black: 1.5, white: 1, pivot: 0.5 } }; }))).toThrow(/anchors\.yrgb\.black/);
  });
});

describe('R12 R9 新参数（cluster / gate_weave）导出导入回环', () => {
  const stats = synthStats();

  it('非默认 cluster/gate_weave → 导出 JSON → 导入 → 三处数值逐位一致', () => {
    const s: RecipeState = {
      ...stateOf('fl05', stats),
      texture: {
        ...stateOf('fl05', stats).texture,
        grain: { ...stateOf('fl05', stats).texture.grain, cluster: 0.62 },
        gate_weave: { amount: 0.37, speed: 1.8 },
      },
      origins: { ...stateOf('fl05', stats).origins, 'grain.cluster': 'user', 'gate_weave.amount': 'user', 'gate_weave.speed': 'user' },
    };
    const r = buildRecipe({ name: 'R9 回环', sourceType: 'library', refImageId: 'lib_neon_fl05', stockId: null, state: s });
    // ① 导出 JSON 里确实带上了这两处字段（Schema {value,origin} 包装）
    expect(r.texture.grain['cluster']).toEqual({ value: 0.62, origin: 'user' });
    expect(r.texture.gate_weave).toEqual({ amount: { value: 0.37, origin: 'user' }, speed: { value: 1.8, origin: 'user' } });
    const json = serializeRecipe(r);
    expect(json).toContain('"cluster"');
    expect(json).toContain('"gate_weave"');
    // ② 导出文本 → 解析（导入）→ 运行时状态
    const back = parseRecipe(json);
    const st = recipeToState(back as unknown as Parameters<typeof recipeToState>[0]);
    // ③ 三处逐位一致：原 state / 导出 JSON value / 导入回 state
    expect(st.texture.grain.cluster).toBe(s.texture.grain.cluster);
    expect(st.texture.grain.cluster).toBe((r.texture.grain['cluster'] as { value: number }).value);
    expect(st.texture.gate_weave.amount).toBe(s.texture.gate_weave.amount);
    expect(st.texture.gate_weave.amount).toBe((r.texture.gate_weave!.amount as { value: number }).value);
    expect(st.texture.gate_weave.speed).toBe(s.texture.gate_weave.speed);
    expect(st.texture.gate_weave.speed).toBe((r.texture.gate_weave!.speed as { value: number }).value);
    // 其余字段不因回环改变
    expect(st.texture.grain.iso).toBe(s.texture.grain.iso);
    expect(st.texture.halation).toEqual(s.texture.halation);
    expect(st.origins['grain.cluster']).toBe('user');
    expect(st.origins['gate_weave.amount']).toBe('user');
    expect(st.origins['gate_weave.speed']).toBe('user');
  });

  it('旧配方（缺 cluster / gate_weave）导入 → 恒等默认（cluster=0 / amount=0 / speed=1），其余不变', () => {
    const fresh = stateOf('fl06', stats);
    const legacy = JSON.parse(JSON.stringify(buildRecipe({
      name: '旧配方', sourceType: 'library', refImageId: 'lib_neon_fl06', stockId: null, state: fresh,
    }))) as ReturnType<typeof buildRecipe>;
    legacy.schema_version = 1.1;
    // 模拟 R9 之前的 JSON：删掉 grain.cluster 与整个 gate_weave 段
    delete (legacy.texture.grain as Record<string, unknown>)['cluster'];
    delete (legacy.texture as Record<string, unknown>)['gate_weave'];
    const st = recipeToState(parseRecipe(JSON.stringify(legacy)) as unknown as Parameters<typeof recipeToState>[0]);
    expect(st.texture.grain.cluster).toBe(0);
    expect(st.texture.gate_weave.amount).toBe(0);
    expect(st.texture.gate_weave.speed).toBe(1);
    // 其余字段逐位保持不变（对比未删字段前的运行时状态）
    const ref = stateOf('fl06', stats);
    expect(st.texture.grain.iso).toBe(ref.texture.grain.iso);
    expect(st.texture.grain.type).toBe(ref.texture.grain.type);
    expect(st.texture.halation.amount).toBe(ref.texture.halation.amount);
    expect(st.look).toEqual(ref.look);
  });
});
