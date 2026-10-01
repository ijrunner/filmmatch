/**
 * R11 交互规格测试：简单/高级模式可见参数数、快捷键绑定、滑杆组组件结构。
 * 纯结构断言（node 环境，无 DOM）：规则函数对全部参数不抛错、结果自洽。
 */
import { describe, expect, it } from 'vitest';
import { GROUPS, type SpecGroup } from './paramui';
import {
  ariaLabel, groupVisible, isTypingTarget, isVisible, matchShortcut, paramKey, SHORTCUTS, SIMPLE_KEYS,
} from './controls';

const allParams = (mode: 'simple' | 'advanced'): number =>
  GROUPS.reduce((n, g) => n + g.params.filter((p) => isVisible(g, p, mode)).length, 0);

describe('简单 / 高级模式', () => {
  it('简单模式默认只露关键参数（少于全部）', () => {
    const simple = allParams('simple');
    const all = allParams('advanced');
    expect(simple).toBe(SIMPLE_KEYS.length);
    expect(simple).toBeGreaterThanOrEqual(5);
    expect(simple).toBeLessThan(all);
  });

  it('高级模式露出全部参数（52 项规格）', () => {
    const all = allParams('advanced');
    expect(all).toBe(GROUPS.reduce((n, g) => n + g.params.length, 0));
    expect(all).toBeGreaterThanOrEqual(50);
  });

  it('SIMPLE_KEYS 每项都能在 GROUPS 中解析（无拼写漂移）', () => {
    const keys = new Set<string>();
    for (const g of GROUPS) for (const p of g.params) keys.add(paramKey(g, p));
    for (const k of SIMPLE_KEYS) expect(keys.has(k), '未知关键参数键 ' + k).toBe(true);
  });

  it('简单模式下质感/look 组整体隐藏，色彩与全局强度组保留', () => {
    const byId = (id: string): SpecGroup => GROUPS.find((g) => g.id === id)!;
    expect(groupVisible(byId('color'), 'simple')).toBe(true);
    expect(groupVisible(byId('master'), 'simple')).toBe(true);
    expect(groupVisible(byId('halation'), 'simple')).toBe(false);
    expect(groupVisible(byId('grain'), 'simple')).toBe(false);
    expect(groupVisible(byId('look'), 'simple')).toBe(false);
    expect(groupVisible(byId('halation'), 'advanced')).toBe(true);
  });
});

describe('滑杆组组件结构', () => {
  it('每个参数的 key / aria 标签都能生成且唯一可辨', () => {
    const keys = new Set<string>();
    for (const g of GROUPS) {
      for (const p of g.params) {
        const k = paramKey(g, p);
        expect(k.length).toBeGreaterThan(0);
        const a = ariaLabel(g, p);
        expect(a).toContain(g.name);
        expect(a).toContain(p.label);
        keys.add(k);
      }
    }
    expect(keys.size).toBeGreaterThanOrEqual(50);
  });
});

describe('键盘快捷键', () => {
  it('至少覆盖切视图 / A-B / 模式，且都是裸键（无 Ctrl/Alt/Meta）', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(ids).toContain('view');
    expect(ids).toContain('ab');
    expect(ids).toContain('mode');
    expect(SHORTCUTS.length).toBeGreaterThanOrEqual(3);
    for (const s of SHORTCUTS) expect(s.label.length).toBeGreaterThan(0);
  });

  it('matchShortcut 映射正确，且带修饰键一律不触发', () => {
    expect(matchShortcut({ key: 'v' })).toBe('view');
    expect(matchShortcut({ key: 'a' })).toBe('ab');
    expect(matchShortcut({ key: 'm' })).toBe('mode');
    expect(matchShortcut({ key: 'v', ctrlKey: true })).toBeNull();
    expect(matchShortcut({ key: 'm', metaKey: true })).toBeNull();
    expect(matchShortcut({ key: 'w' })).toBeNull();
  });

  it('输入控件内不触发全局快捷键', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
