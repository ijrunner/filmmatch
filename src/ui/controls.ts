/**
 * R11 交互规格（纯逻辑、可单测）：简单/高级模式可见性、键盘快捷键、无障碍文案。
 * DOM 装配在 main.ts；本模块只放「可断言的规则」，便于在 node 环境做结构断言。
 */
import type { SpecGroup, SpecParam } from './paramui';
import type { RecipeState } from './recipe';

export type UiMode = 'simple' | 'advanced';

/** 简单模式保留的关键参数（色彩匹配关键项 + 主质感强度）；其余收进「高级」。
 *  **仅在色彩匹配可用时使用**（有参考统计）；匹配不可用时改用 SIMPLE_KEYS_LOOK。 */
export const SIMPLE_KEYS: readonly string[] = [
  'color.match_strength', 'color.skin_hue', 'color.tone_contrast', 'color.split_tone',
  'color.global_sat', 'color.highlight_rolloff', 'master',
];

/**
 * R14-B：色彩匹配不可用（型号卡直出，无参考统计）时，简单模式露出 **look 关键项**
 * ——匹配九参数此时在数学上不可能生效（matchTransform 为 null），露出来就是「死滑杆」。
 * 列出的是观感最直观、且始终生效的 look 参数 + 全局强度（7 项，与 SIMPLE_KEYS 数量相当）。
 */
export const SIMPLE_KEYS_LOOK: readonly string[] = [
  'look.contrast',   // 正片反S
  'look.saturation', // 饱和度
  'look.warmth',     // 冷暖偏移
  'look.fade',       // 褪色总量
  'look.black_lift', // 黑位提升
  'look.film_s',     // 软S曲线
  'master',          // 全局强度（质感 + look 的总量）
];

/** 简单模式的可见参数键集合（按匹配可用性动态选择） */
export function simpleKeys(matchOk: boolean): readonly string[] {
  return matchOk ? SIMPLE_KEYS : SIMPLE_KEYS_LOOK;
}

/**
 * 色彩匹配可用性判定（唯一真值来源）。
 * 匹配变换以「参考统计 + 被调色图统计」为输入；任一缺失（典型：型号卡直出 refStats=null）
 * 则 ui/recipe.matchTransform 返回 null，九参数在数学上不可能生效。
 * 本判定与 matchTransform 的可用性条件严格等价（param-availability.test.ts 逐状态断言，
 * 防止两处判定漂移）。
 */
export function matchAvailable(state: Pick<RecipeState, 'refStats' | 'userStats'> | null): boolean {
  return !!state && !!state.refStats && !!state.userStats;
}

/** 匹配不可用时，「色彩匹配」组标题旁的明确状态文案 */
export const MATCH_UNAVAILABLE_TITLE = '不适用 · 型号卡直出（无参考统计）';

/** 匹配不可用时，组内的一行说明（告诉用户为什么没反应、怎么才能用匹配） */
export const MATCH_UNAVAILABLE_NOTE =
  '型号卡是直出预设，没有参考统计 → 匹配参数在数学上不会生效。' +
  '想用匹配：② 选参考里挑一张图库/上传的参考图（有统计），或在图库里导入一张参考。';

/** 参数稳定键（与 main.ts/store 的 origins 键一致） */
export function paramKey(g: SpecGroup, p: SpecParam): string {
  if (g.kind === 'color') return 'color.' + p.k;
  if (g.kind === 'look') return 'look.' + p.k;
  if (g.kind === 'master') return 'master';
  return g.id + '.' + p.k;
}

/** 可见性判定。keys 缺省为 SIMPLE_KEYS（匹配可用口径）；匹配不可用时传 simpleKeys(false)。 */
export function isVisible(
  g: SpecGroup, p: SpecParam, mode: UiMode, keys: readonly string[] = SIMPLE_KEYS,
): boolean {
  return mode === 'advanced' || keys.includes(paramKey(g, p));
}

/** 组是否在给定模式下有可见参数（简单模式下质感/look 组整体隐藏） */
export function groupVisible(
  g: SpecGroup, mode: UiMode, keys: readonly string[] = SIMPLE_KEYS,
): boolean {
  return mode === 'advanced' || g.params.some((p) => isVisible(g, p, mode, keys));
}

/** 滑杆的无障碍标签 */
export function ariaLabel(g: SpecGroup, p: SpecParam): string {
  return g.name + ' ' + p.label;
}

export type ShortcutId = 'view' | 'ab' | 'mode' | 'search';
export interface Shortcut { key: string; id: ShortcutId; label: string; }

/** 快捷键表：仅裸键（不含 Ctrl/Alt/Meta），避免与浏览器组合键冲突（Ctrl+W/T/N 等）。 */
export const SHORTCUTS: readonly Shortcut[] = [
  { key: 'v', id: 'view', label: 'v 切换查看方式（调色 / 分屏 / 原图）' },
  { key: 'a', id: 'ab', label: 'a 切换 A/B 分屏对比' },
  { key: 'm', id: 'mode', label: 'm 切换简单 / 高级参数模式' },
  { key: '/', id: 'search', label: '/ 聚焦参数搜索' },
];

/** 事件 → 动作 id；带修饰键一律不触发（不占用浏览器快捷键） */
export function matchShortcut(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): ShortcutId | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const s = SHORTCUTS.find((x) => x.key === e.key);
  return s ? s.id : null;
}

/** 输入控件内的按键不应触发全局快捷键 */
export function isTypingTarget(t: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!t) return false;
  const tag = (t.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t.isContentEditable;
}
