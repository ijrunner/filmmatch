/**
 * R14-B（用户实机反馈修复）：「色彩匹配滑杆怎么滑都没用」的可见化与防死滑杆测试。
 *
 * 根因：型号卡是直出预设，refStats=null → ui/recipe.matchTransform 返回 null →
 * 匹配变换根本不存在，九个色彩匹配参数在数学上不可能有任何效果。
 * 本文件钉死三件事：
 *  1) 匹配可用性判定与 matchTransform 的 null 语义**严格等价**（单一真值来源）；
 *  2) 简单模式可见集合按可用性动态切换：匹配不可用时**不含任何**色彩匹配 key；
 *  3) main.ts 的禁用态装配确实存在（node 环境无 DOM，用结构断言）。
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error 测试在 node 下运行；本项目未安装 @types/node
import { readFileSync } from 'node:fs';
// @ts-expect-error 同上
import { resolve, dirname } from 'node:path';
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url';
import { analyzeImage, type ImageStats } from '../engine';
import { defaultLook, defaultTexture } from '../film/params';
import { defaultColorParams, matchTransform, type RecipeState } from './recipe';
import { GROUPS, type SpecGroup, type SpecParam } from './paramui';
import {
  isVisible, matchAvailable, paramKey, simpleKeys,
  MATCH_UNAVAILABLE_NOTE, MATCH_UNAVAILABLE_TITLE,
  SIMPLE_KEYS, SIMPLE_KEYS_LOOK,
} from './controls';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => readFileSync(resolve(APP, rel), 'utf8');

/** 构造一张有真实统计的小图（8×8 RGB 渐变） */
function stats(): ImageStats {
  const w = 8;
  const h = 8;
  const data = new Uint8ClampedArray(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      data[i] = x * 32;
      data[i + 1] = y * 32;
      data[i + 2] = (x + y) * 16;
    }
  }
  return analyzeImage(data, w, h);
}

function makeState(over: Partial<RecipeState>): RecipeState {
  return {
    colorParams: defaultColorParams(false),
    look: defaultLook(),
    texture: defaultTexture(),
    master: 1,
    origins: {},
    refStats: null,
    userStats: null,
    ...over,
  };
}

const both = stats();
const keyOf = (g: SpecGroup, p: SpecParam): string => paramKey(g, p);
const visibleKeys = (keys: readonly string[]): string[] =>
  GROUPS.flatMap((g) => g.params.filter((p) => isVisible(g, p, 'simple', keys)).map((p) => keyOf(g, p))).sort();
const allKeys = new Set(GROUPS.flatMap((g) => g.params.map((p) => keyOf(g, p))));

describe('R14-B 匹配可用性判定（与 matchTransform 严格等价）', () => {
  it('state 为 null → 不可用；refStats=null（型号卡直出）→ 不可用', () => {
    expect(matchAvailable(null)).toBe(false);
    expect(matchAvailable(makeState({ refStats: null, userStats: both }))).toBe(false);
    expect(matchAvailable(makeState({ refStats: both, userStats: null }))).toBe(false);
  });

  it('两者齐全 → 可用', () => {
    expect(matchAvailable(makeState({ refStats: both, userStats: both }))).toBe(true);
  });

  it('判定与 matchTransform(st) !== null 逐状态一致（单一真值来源，防漂移）', () => {
    const cases: Array<RecipeState | null> = [
      null,
      makeState({ refStats: null, userStats: null }),
      makeState({ refStats: null, userStats: both }),
      makeState({ refStats: both, userStats: null }),
      makeState({ refStats: both, userStats: both }),
    ];
    for (const st of cases) {
      const expected = st === null ? false : matchTransform(st) !== null;
      expect(matchAvailable(st), JSON.stringify(st?.refStats ?? null)).toBe(expected);
    }
  });
});

describe('R14-B 简单模式可见集合按可用性动态选择', () => {
  it('匹配不可用：不含任何色彩匹配 key（color.*），且含 look 关键项与全局强度', () => {
    const keys = visibleKeys(simpleKeys(false));
    expect(keys.some((k) => k.startsWith('color.'))).toBe(false);
    for (const k of ['look.contrast', 'look.saturation', 'look.warmth', 'master']) {
      expect(keys, '缺少 look 关键项 ' + k).toContain(k);
    }
    // 数量与原来的 7 项相当
    expect(keys.length).toBeGreaterThanOrEqual(6);
    expect(keys.length).toBeLessThanOrEqual(8);
    expect(keys).toEqual([...SIMPLE_KEYS_LOOK].sort());
  });

  it('匹配可用：仍然露原来的 7 项匹配关键项（行为不变）', () => {
    const keys = visibleKeys(simpleKeys(true));
    expect(keys).toEqual([...SIMPLE_KEYS].sort());
    expect(keys).toContain('color.match_strength');
    expect(keys).not.toContain('look.saturation');
  });

  it('两套 key 均能在 GROUPS 中解析（无拼写漂移），look 集不含任何色彩匹配 key', () => {
    for (const k of [...SIMPLE_KEYS, ...SIMPLE_KEYS_LOOK]) expect(allKeys.has(k), '未知 key ' + k).toBe(true);
    // master（全局强度）两套共有是预期；look 集不得出现 color.* 匹配 key
    expect(SIMPLE_KEYS_LOOK.filter((k) => !SIMPLE_KEYS.includes(k)).some((k) => k.startsWith('color.'))).toBe(false);
    expect(SIMPLE_KEYS_LOOK).not.toContain('color.match_strength');
  });
});

describe('R14-B 不适用文案存在且语义明确', () => {
  it('标题写明「不适用 / 型号卡直出 / 无参考统计」', () => {
    expect(MATCH_UNAVAILABLE_TITLE).toContain('不适用');
    expect(MATCH_UNAVAILABLE_TITLE).toContain('型号卡直出');
    expect(MATCH_UNAVAILABLE_TITLE).toContain('无参考统计');
  });
  it('说明行解释「数学上不会生效」并给出可用做法（选图库/上传参考或导入）', () => {
    expect(MATCH_UNAVAILABLE_NOTE).toContain('没有参考统计');
    expect(MATCH_UNAVAILABLE_NOTE).toContain('不会生效');
    expect(MATCH_UNAVAILABLE_NOTE).toContain('参考图');
  });
});

describe('R14-B main.ts 禁用态装配（结构断言；node 无 DOM）', () => {
  const src = read('src/main.ts');

  it('色彩组标题状态 + 组内说明行已装配（#color-status / #color-note）', () => {
    expect(src).toContain("status.id = 'color-status';");
    expect(src).toContain("note.id = 'color-note';");
    expect(src).toContain('MATCH_UNAVAILABLE_TITLE');
    expect(src).toContain('MATCH_UNAVAILABLE_NOTE');
  });

  it('禁用逻辑以 matchAvailable 为唯一真值来源，逐控件设置 disabled + aria-disabled', () => {
    expect(src).toContain('const ok = matchAvailable(store.state);');
    expect(src).toContain('el.disabled = dis;');
    expect(src).toContain("el.setAttribute('aria-disabled', dis ? 'true' : 'false');");
    // 组内所有滑杆（range）都在禁用循环内：循环条件限定色彩组
    expect(src).toContain("if (!s.g || s.g.kind !== 'color') continue;");
  });

  it('拖到禁用滑杆不改变状态（input / scrub / 复位均提前返回）', () => {
    expect(src).toContain('if (rg.disabled) return;');
    expect(src).toContain('if (e.button !== 0 || !store.state || rg.disabled) return;');
    expect(src).toContain("if (g.kind === 'color' && !matchOk) return;");
  });

  it('可用性变化时重算可见集合并刷新（refreshAll 挂载 + 立即重算可见集合/禁用态）', () => {
    expect(src).toContain('function refreshMatchAvailability(): void {');
    expect(src).toContain('refreshMatchAvailability();');
    expect(src).toContain('simpleKeySet = simpleKeys(ok);');
  });

  it('#e2e-meta.ui 新增 matchAvailable / simpleKeys，且保留 visibleParams', () => {
    expect(src).toContain('matchAvailable: matchOk,');
    expect(src).toContain('simpleKeys: [...simpleKeySet],');
    expect(src).toContain('visibleParams: countRanges(true),');
  });
});