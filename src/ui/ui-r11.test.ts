/**
 * R13 · UI（R11）补测：令牌单一来源扫描扩面 / 简单·高级可见参数数 /
 * 快捷键映射与输入控件内不触发 / #e2e-meta.ui 字段齐备。
 *
 * tokens.test.ts 只扫了 index.html 与 4 个懒加载页；controls.test.ts 覆盖了模式与快捷键逻辑。
 * 本文件把 main.ts（首屏骨架，唯一持有 :root 注入与参数渲染的地方）纳入扫描，
 * 并把「#e2e-meta.ui 到底写了哪些字段」钉成结构断言（E2E 目前没有对应 check，见报告 §E2E 缺口）。
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error 测试在 node 下运行；本项目未安装 @types/node
import { readFileSync } from 'node:fs';
// @ts-expect-error 同上
import { resolve, dirname } from 'node:path';
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url';
import { GROUPS } from './paramui';
import { isVisible, groupVisible, paramKey, SHORTCUTS, matchShortcut, isTypingTarget, SIMPLE_KEYS } from './controls';
import { getMeta, setMeta } from './e2emeta';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => readFileSync(resolve(APP, rel), 'utf8');
const HEX = /#[0-9a-fA-F]{3,8}(?![-0-9a-zA-Z])/;
const RGBA = /rgba?\(\s*\d/;
const FONT = /font(?:-size)?\s*:[^;"'\n]*\d+px/;

describe('R13 R11 令牌单一来源：main.ts（首屏骨架）也无散落魔数', () => {
  it('main.ts 无硬编码 hex/rgba/px 字号（#demo= / #e2e-meta 注释不算色值）', () => {
    const src = read('src/main.ts');
    expect(src.match(HEX)?.[0] ?? null, '残留 hex 色值').toBeNull();
    expect(src.match(RGBA)?.[0] ?? null, '残留 rgba() 色值').toBeNull();
    expect(src.match(FONT)?.[0] ?? null, '残留 px 字号').toBeNull();
  });
  it('main.ts 通过 installTokens() 注入 :root（令牌唯一来源），自身不写死 CSS 变量', () => {
    const src = read('src/main.ts');
    expect(src).toContain("import { installTokens } from './ui/tokens';");
    expect(src).toContain('installTokens();');
    // main.ts 的样式走 class / index.html 的 var(--x)，自身不直接消费令牌变量
    const used = [...src.matchAll(/var\((--[a-z0-9-]+)\)/gi)].map((m) => m[1]);
    expect(used).toEqual([]);
  });
});

describe('R13 R11 简单 / 高级模式：可见参数数', () => {
  const total = GROUPS.reduce((n, g) => n + g.params.length, 0);
  it('高级模式露出全部参数；简单模式只露 SIMPLE_KEYS（7 项）且严格更少', () => {
    const advanced = GROUPS.reduce((n, g) => n + g.params.filter((p) => isVisible(g, p, 'advanced')).length, 0);
    const simple = GROUPS.reduce((n, g) => n + g.params.filter((p) => isVisible(g, p, 'simple')).length, 0);
    expect(advanced).toBe(total);
    expect(simple).toBe(SIMPLE_KEYS.length);
    expect(simple).toBeLessThan(advanced);
    // SIMPLE_KEYS 每项都真实存在于 GROUPS（防拼写漂移）
    const keys = new Set(GROUPS.flatMap((g) => g.params.map((p) => paramKey(g, p))));
    for (const k of SIMPLE_KEYS) expect(keys.has(k), `SIMPLE_KEY 不存在：${k}`).toBe(true);
  });
  it('简单模式下质感/look 组整体隐藏，色彩与全局强度组保留', () => {
    const visibleGroups = GROUPS.filter((g) => groupVisible(g, 'simple')).map((g) => g.kind);
    expect(visibleGroups).toContain('color');
    expect(visibleGroups).toContain('master');
    expect(visibleGroups).not.toContain('look');
    expect(GROUPS.filter((g) => groupVisible(g, 'advanced')).length).toBe(GROUPS.length);
  });
});

describe('R13 R11 快捷键：映射与输入控件内不触发', () => {
  it('4 个动作（view/ab/mode/search）齐备，键为裸键且标签含键名', () => {
    const ids = SHORTCUTS.map((s) => s.id).sort();
    expect(ids).toEqual(['ab', 'mode', 'search', 'view']);
    for (const s of SHORTCUTS) {
      expect(s.key.length).toBeGreaterThan(0);
      expect(s.label).toContain(s.key);
    }
  });
  it('每个键映射到自身 id；带 Ctrl/Alt/Meta 一律不触发', () => {
    for (const s of SHORTCUTS) {
      expect(matchShortcut({ key: s.key })).toBe(s.id);
      expect(matchShortcut({ key: s.key, ctrlKey: true })).toBeNull();
      expect(matchShortcut({ key: s.key, metaKey: true })).toBeNull();
      expect(matchShortcut({ key: s.key, altKey: true })).toBeNull();
    }
    expect(matchShortcut({ key: 'z' })).toBeNull();
  });
  it('输入控件内不触发全局快捷键（isTypingTarget）', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'input', 'textarea']) {
      expect(isTypingTarget({ tagName: tag })).toBe(true);
    }
    expect(isTypingTarget({ isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('R13 R11 #e2e-meta.ui 字段齐备（结构断言 + 合并语义）', () => {
  it('main.ts 的 publishUiMeta 写入 mode / visibleParams / totalParams / a11y.{focusVisible,keyboard}', () => {
    const src = read('src/main.ts');
    for (const frag of [
      'mode: uiMode,',
      'visibleParams: countRanges(true),',
      'totalParams: countRanges(false),',
      'a11y: { focusVisible, keyboard: SHORTCUTS.map((s) => s.label) },',
    ]) expect(src).toContain(frag);
  });
  it('setMeta 合并语义：多次调用累积；有 #e2e-meta 元素时写入 JSON 文本', () => {
    const g = globalThis as { document?: unknown; __fmE2E?: Record<string, unknown> };
    const prevDoc = g.document;
    const prevMeta = g.__fmE2E;
    const el = { textContent: '' };
    g.document = { getElementById: () => el };
    delete g.__fmE2E;
    try {
      setMeta({ ui: { mode: 'simple', visibleParams: 7, totalParams: 48, a11y: { focusVisible: true, keyboard: [] } } });
      setMeta({ view: 'grade' });
      const meta = getMeta();
      expect(meta.view).toBe('grade');
      expect((meta.ui as { mode: string }).mode).toBe('simple');
      expect((meta.ui as { visibleParams: number }).visibleParams).toBe(7);
      const written = JSON.parse(el.textContent) as Record<string, unknown>;
      expect(written.view).toBe('grade');
      expect((written.ui as { totalParams: number }).totalParams).toBe(48);
    } finally {
      if (prevDoc === undefined) delete g.document; else g.document = prevDoc;
      if (prevMeta === undefined) delete g.__fmE2E; else g.__fmE2E = prevMeta;
    }
  });
});
