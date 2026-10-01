/**
 * R13 · Schema 迁移矩阵（v1 / v1.1 / v1.2 / v1.3 × 场景；R18 补 1.3 行）。
 *
 * 既有测试覆盖了「坏 JSON / 错版本 / 缺段」「越界」「v1.1 可读」「v1.2 回环」的零散组合；
 * 本文件把它补成**矩阵**：3 个版本 × {字段齐全 / 缺新字段 / 越界值 / 未知字段 / 错误版本号}，
 * 外加「导出→导入回环」与「旧版读入后重新导出即升到当前版本（R18 起 1.3）」。
 *
 * 行为契约（来自 storage.parseRecipe + film/params.normalizeParams）：
 *   - 缺新字段 → 按恒等默认补齐（split_*=0 / grain.cluster=0 / gate_weave.amount=0,speed=1）；
 *   - 越界 / 非有限 → 抛可读错误（含字段路径与允许范围）；
 *   - 未知字段 → 透传不报错；但 texture 段的未知数值仍受防御性区间约束（负数被拒）；
 *   - 错误版本号 → 抛「不支持的配方版本」。
 */
import { describe, expect, it } from 'vitest';
import { getPreset } from '../film/params';
import {
  buildRecipe, isSupportedSchemaVersion, recipeToState, SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS,
  type Recipe, type RecipeState,
} from './recipe';
import { parseRecipe, serializeRecipe, type RecipeLike } from './storage';

function fullState(): RecipeState {
  const card = getPreset('fl05');
  return {
    colorParams: { match_strength: 0.75, skin_hue: 0, skin_sat: 1, skin_isolation: 0, split_tone: 0, tone_contrast: 1, shadow_lift: 0, global_sat: 1, highlight_rolloff: 0 },
    look: card.params.look,
    texture: card.params.texture,
    master: 1,
    origins: { ...card.origins },
    refStats: null,
    userStats: null,
  };
}
const fullV12 = (): Recipe => buildRecipe({ name: '迁移矩阵', sourceType: 'library', refImageId: null, stockId: null, state: fullState() });

const LOOK_V11_KEYS = ['fade', 'black_lift', 'dye_coupling', 'shadow_bias', 'highlight_bias', 'film_s', 'contrast', 'saturation', 'warmth'];
const SPLIT_KEYS = ['split_shadow_hue', 'split_shadow_sat', 'split_highlight_hue', 'split_highlight_sat', 'split_balance'];
const TEX_V11_FIELDS: Record<string, string[]> = {
  halation: ['background_gain', 'amplify', 'impact', 'hue', 'blue_comp', 'smoothness'],
  grain: ['shadow', 'midtone', 'highlight', 'type', 'film_resolution', 'mode'],
  bloom: ['save_lights', 'details', 'saturation'],
};

/** 把 v1.2 全结构降级成历史版本夹具 */
function asVersion(v: 1 | 1.1 | 1.2 | 1.3): Record<string, any> {
  const r = JSON.parse(serializeRecipe(fullV12())) as Record<string, any>;
  r.schema_version = v;
  /* R18 v1.3 新字段（coupling/hsl/anchors）从 v1.3 夹具中剥离以模拟旧版本写出 */
  delete r.color.look.coupling;
  delete r.color.look.hsl;
  delete r.anchors;
  if (v === 1 || v === 1.1) {
    for (const k of SPLIT_KEYS) delete r.color.look[k];
  }
  if (v === 1) {
    for (const [g, fields] of Object.entries(TEX_V11_FIELDS)) for (const f of fields) delete r.texture[g][f];
    delete r.texture.gate_weave;
    delete r.texture.profile;
  }
  return r;
}

describe('R13 Schema 迁移矩阵：版本 × 场景', () => {
  for (const v of [1, 1.1, 1.2, 1.3] as const) {
    it(`v${v} 字段齐全：parseRecipe 通过且不报错`, () => {
      const r = parseRecipe(JSON.stringify(asVersion(v)));
      expect(r.schema_version).toBe(v);
      expect(isSupportedSchemaVersion(v)).toBe(true);
    });

    it(`v${v} 缺新字段：读入后按恒等默认补齐（split_*=0 / cluster=0 / gate_weave 0,1）`, () => {
      const st = recipeToState(parseRecipe(JSON.stringify(asVersion(v))) as Recipe);
      for (const k of SPLIT_KEYS) expect(st.look[k as keyof typeof st.look]).toBe(0);
      if (v === 1) {
        expect(st.texture.grain.cluster).toBe(0);
        expect(st.texture.gate_weave.amount).toBe(0);
        expect(st.texture.gate_weave.speed).toBe(1);
        // v1.1 质感字段同样回落默认
        expect(st.texture.halation.background_gain).toBe(1);
        expect(st.texture.bloom.saturation).toBe(1);
      }
    });

    it(`v${v} 越界值：look 与 texture 越界都抛可读错误（含字段路径）`, () => {
      const a = asVersion(v);
      a.color.look.fade = { value: 9, origin: 'user' }; // 区间 0..1
      expect(() => parseRecipe(JSON.stringify(a))).toThrow(/color\.look\.fade=9/);
      const b = asVersion(v);
      b.texture.grain.iso = { value: -3, origin: 'user' };
      expect(() => parseRecipe(JSON.stringify(b))).toThrow(/texture\.grain\.iso=-3/);
    });

    it(`v${v} 未知字段：look/texture 未知字段透传不报错（防御区间内）`, () => {
      const a = asVersion(v);
      a.color.look.unknown_look_field = { value: 0.5, origin: 'user' };
      a.texture.grain.unknown_positive = { value: 5, origin: 'user' };
      a.texture.bloom.extra_flag = true;          // boolean 跳过
      a.texture.vignette.extra_name = 'x';        // string 跳过
      expect(() => parseRecipe(JSON.stringify(a))).not.toThrow();
    });

    it(`v${v} 未知字段（防御）：texture 未知数值为负 → 仍被拒`, () => {
      const a = asVersion(v);
      a.texture.grain.unknown_negative = { value: -1, origin: 'user' };
      expect(() => parseRecipe(JSON.stringify(a))).toThrow(/texture\.grain\.unknown_negative=-1/);
    });
  }

  it('错误版本号（3 / 0 / 1.5 / "1" / null / 缺省）一律拒绝，报可读错误', () => {
    for (const bad of [3, 0, 1.5, '1', null, undefined]) {
      const r = asVersion(1.2);
      r.schema_version = bad as never;
      expect(() => parseRecipe(JSON.stringify(r))).toThrow(/不支持的配方版本/);
    }
  });

  it('非有限值（JSON 的 1e999 → Infinity）被拒', () => {
    const a = asVersion(1.2);
    a.color.look.fade = { value: 1e999, origin: 'user' };
    expect(() => parseRecipe(JSON.stringify(a))).toThrow(/color\.look\.fade/);
  });

  it('SUPPORTED_SCHEMA_VERSIONS / SCHEMA_VERSION 常量正确', () => {
    expect(SCHEMA_VERSION).toBe(1.3);
    expect([...SUPPORTED_SCHEMA_VERSIONS]).toEqual([1, 1.1, 1.2, 1.3]);
  });
});

describe('R13 Schema 迁移矩阵：导出→导入回环 + 旧版读入即升版', () => {
  it('v1.2 全结构：导出 → 导入逐位一致', () => {
    const r = fullV12();
    expect(parseRecipe(serializeRecipe(r))).toEqual(r);
  });

  for (const v of [1, 1.1] as const) {
    it(`v${v} 旧配方：parse → recipeToState → buildRecipe 写出 1.3（迁移即升版）`, () => {
      const state = recipeToState(parseRecipe(JSON.stringify(asVersion(v))) as Recipe);
      const up = buildRecipe({ name: '升版', sourceType: 'library', refImageId: null, stockId: null, state });
      expect(up.schema_version).toBe(1.3);
      expect(parseRecipe(serializeRecipe(up))).toEqual(up);
      // 旧版里已有的 look 值在迁移中保留
      expect(up.color.look.fade.value).toBeCloseTo((asVersion(v).color as any).look.fade.value, 4);
    });
  }

  it('v1.1 → 1.2 迁移不改动既有 look/texture 数值（除补齐默认）', () => {
    const src = asVersion(1.1);
    const st = recipeToState(parseRecipe(JSON.stringify(src)) as Recipe);
    const up = buildRecipe({ name: 'x', sourceType: 'library', refImageId: null, stockId: null, state: st });
    for (const k of LOOK_V11_KEYS) {
      expect(up.color.look[k].value).toBeCloseTo((src.color as any).look[k].value, 4);
    }
    for (const k of SPLIT_KEYS) expect(up.color.look[k].value).toBe(0);
  });

  it('v1.2 缺 gate_weave 段（R9 前旧配方）→ 恒等默认，且升版后 gate_weave 写出为 0/1', () => {
    const a = asVersion(1.1);
    delete a.texture.gate_weave;
    const st = recipeToState(parseRecipe(JSON.stringify(a)) as Recipe);
    expect(st.texture.gate_weave.amount).toBe(0);
    expect(st.texture.gate_weave.speed).toBe(1);
    const up = buildRecipe({ name: 'x', sourceType: 'library', refImageId: null, stockId: null, state: st });
    expect(up.texture.gate_weave).toBeDefined();
    expect((up.texture.gate_weave as any).amount.value).toBe(0);
    expect((up.texture.gate_weave as any).speed.value).toBe(1);
  });
});

// 让 RecipeLike 类型参与编译（parseRecipe 的返回类型断言用）
const _typecheck: (r: RecipeLike) => number = (r) => r.schema_version;
void _typecheck;
