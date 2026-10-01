/**
 * R13 补：UI 文案里的 HTML 标签不能走 textContent 路径。
 *
 * 背景（实测缺陷）：`h('div', 'note', '…<b>纯英文安全形态</b>…')` 里的标签会被当作**字面文本**显示，
 * 用户在页面上直接看到 `<b>`（R13 后打开真实页面时发现）。视觉回归基线抓不到——它只比对像素签名，
 * 而基线是在缺陷之后记录的。所以这里用源码扫描把这一类写法钉死。
 */
import { describe, expect, it } from 'vitest';

/** 动态载入 node 内置模块（specifier 用变量，tsc 无需 @types/node 也不报 TS2307；沿用 codegen.test.ts 的写法） */
async function nodeMod(spec: string): Promise<any> {
  return import(/* @vite-ignore */ spec);
}
/* 工作区路径含空格：URL.pathname 会 percent-encode，必须解码后再给 fs 用 */
const UI_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);

/** 收集「文本参数里含 HTML 标签」的可疑调用：h('x', 'note', '…<tag>…') 或 addEventListener 之外的字符串拼接 */
function scan(src: string): string[] {
  const hits: string[] = [];
  /* 形如 h('div', 'note', '...' + '...') —— 第三参数是字符串字面量拼接（走 textContent） */
  const re = /h\(\s*'([a-z0-9]+)'\s*,\s*(?:'[^']*'|undefined)\s*,\s*((?:'(?:[^'\\]|\\.)*'\s*\+?\s*)+)\)/g;
  for (const m of src.matchAll(re)) {
    if (/<[a-z/][a-z0-9]*[^>]*>/i.test(m[2])) hits.push(m[0].slice(0, 90));
  }
  return hits;
}

describe('UI 文案：HTML 标签不得走 textContent 路径', () => {
  it('1. src/ui/*.ts 与 main.ts 里没有「textContent 路径 + HTML 标签」的写法', async () => {
    const fs = await nodeMod('node:fs');
    const path = await nodeMod('node:path');
    const files: string[] = fs.readdirSync(UI_DIR).filter((f: string) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const targets = [...files.map((f) => path.join(UI_DIR, f)), path.join(UI_DIR, '..', 'main.ts')];
    const bad: Array<{ file: string; hit: string }> = [];
    for (const f of targets) {
      for (const hit of scan(fs.readFileSync(f, 'utf8'))) bad.push({ file: f.split('/').pop()!, hit });
    }
    expect(bad, `应改用 innerHTML：\n${bad.map((b) => `${b.file}: ${b.hit}`).join('\n')}`).toEqual([]);
  });

  it('2. 扫描器本身有效（反例能被抓到、正例不误报）', () => {
    expect(scan(`h('div', 'note', '看这里 <b>加粗</b> 结束')`).length).toBe(1);
    expect(scan(`h('div', 'note', '纯文本没有标签')`).length).toBe(0);
    const el = `h('div', 'note');\nel.innerHTML = '看这里 <b>加粗</b>';`;
    expect(scan(el).length).toBe(0);   // innerHTML 路径允许
  });
});
