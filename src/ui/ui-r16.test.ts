/**
 * R16 · 界面打磨 II 结构断言：对比浮层（左上角常驻）/ 预览 HUD / 组级重置 / 参数搜索匹配组名 /
 * Grab Still 替代路径文案。行为级断言走 E2E（tools/e2e-verify.mjs 的 R16-*）；
 * 这里钉「装配代码与标记的结构不变量」，防止后续改动悄悄拆掉同步路径（写法同 ui-r11.test.ts）。
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error 测试在 node 下运行；本项目未安装 @types/node
import { readFileSync } from 'node:fs';
// @ts-expect-error 同上
import { resolve, dirname } from 'node:path';
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url';
import { GROUPS } from './paramui';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => readFileSync(resolve(APP, rel), 'utf8');
const html = read('index.html');
const main = read('src/main.ts');

describe('R16 对比浮层（预览左上角常驻）', () => {
  it('#filmstrip 内有 #viewhud 浮层：4 个 seg-btn，data-mode 集合与 ④#seg-view 一致（0/3/2/1）', () => {
    const strip = html.slice(html.indexOf('id="filmstrip"'), html.indexOf('</main>'));
    expect(strip).toContain('id="viewhud"');
    const modes = (el: string) => [...el.matchAll(/data-mode="(\d)"/g)].map((m) => m[1]).join(',');
    const vi = strip.indexOf('id="viewhud"');
    expect(modes(strip.slice(vi, strip.indexOf('</div>', vi)))).toBe('0,3,2,1');
    expect(modes(html.slice(html.indexOf('id="seg-view"')))).toBe('0,3,2,1');
  });
  it('浮层绝对定位（不占布局流）、pointer-events 只在按钮上、未载入画面时隐藏', () => {
    const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    expect(css.match(/#viewhud\{[^}]*position:absolute/) ?? []).toBeTruthy();
    expect(css.match(/#viewhud\{[^}]*pointer-events:none/) ?? []).toBeTruthy();
    expect(css.match(/#viewhud \.seg-btn\{[^}]*pointer-events:auto/) ?? []).toBeTruthy();
    expect(css).toContain('#viewhud[hidden]{display:none}');
  });
  it('setViewMode 同时刷新两处分段控件（#seg-view 与 #viewhud），点击监听覆盖两处', () => {
    expect(main.match(/'#seg-view \.seg-btn, #viewhud \.seg-btn'/g)?.length).toBe(2);
  });
  it('refreshSteps 把浮层/HUD 的显隐绑到「是否已载入画面」', () => {
    expect(main).toContain("($('viewhud') as HTMLElement).hidden = !store.frame;");
    expect(main).toContain("($('hud') as HTMLElement).hidden = !store.frame;");
  });
});

describe('R16 预览 HUD（右下角）', () => {
  it('#hud 含 配方码/参考名/数据范围占位 与开关按钮', () => {
    for (const frag of ['id="hud"', 'id="hud-code"', 'id="hud-ref"', 'id="hud-range"', 'id="hud-toggle"']) {
      expect(html).toContain(frag);
    }
  });
  it('开关状态存 localStorage（fm.hud），默认开（仅显式 off 才关）；refreshHud 挂进 refreshAll', () => {
    expect(main).toContain("const HUD_KEY = 'fm.hud';");
    expect(main).toContain("localStorage.getItem(HUD_KEY) !== 'off'");
    expect(main).toContain('refreshHud();');
  });
  it('无配方时配方码显示占位「--」；数据范围字段为 R17 预留', () => {
    expect(main).toContain("$('hud-code').textContent = store.state ? shareCodeOf(store.state) : '--';");
    expect(html).toContain('id="hud-range"');
  });
});

describe('R16 组级操作', () => {
  it('每组 summary 装配「重置本组」按钮（greset），resetGroup 恢复 initial 且 origins 同步', () => {
    expect(main).toContain("gr.className = 'greset';");
    for (const frag of [
      'function resetGroup(',
      'function refreshGroupResets(',
      'if (key in ini.origins) st.origins[key] = ini.origins[key];',
      'else delete st.origins[key];',
      "toast('已重置本组：' + g.name);",
    ]) expect(main).toContain(frag);
  });
  it('GROUPS 每一组都会拿到一个重置按钮（dataset.g = 组 id，装配循环内创建）', () => {
    const ids = GROUPS.map((g) => g.id);
    expect(ids).toContain('color');
    expect(main).toContain('gr.dataset.g = g.id;');
  });
  it('参数搜索匹配组名：details 带 data-grp（中英组名），命中组保持展开可见', () => {
    expect(main).toContain("d.dataset.grp = (g.name + ' ' + g.en).toLowerCase();");
    expect(main).toContain("(det.dataset.grp ?? '').includes(q)");
    expect(main).toContain('if (grpHit && !det.hidden) det.open = true;');
  });
});

describe('R16 节点包导出区 Grab Still 文案（C6）', () => {
  it('drxexport.ts 含 Grab Still → PowerGrade 替代路径说明', () => {
    const src = read('src/ui/drxexport.ts');
    expect(src).toContain('Grab Still');
    expect(src).toContain('PowerGrade');
    expect(src).toContain('不下载 .drx');
  });
  it('品牌词口径与既有文案一致：只用「达芬奇」，不新增英文名/其他品牌词', () => {
    const src = read('src/ui/drxexport.ts');
    expect(src).not.toContain('DaVinci');
    expect(src).not.toContain('Resolve');
    expect(src).not.toContain('Blackmagic');
  });
});
