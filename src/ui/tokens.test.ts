/**
 * R11 设计令牌「单一来源」守护：
 *  - index.html / dctlpage.ts / batch.ts / drxexport.ts / guide.ts 里不得再有硬编码色值或字号；
 *  - index.html 引用的每个 var(--x) 都必须在 TOKENS_CSS 里有定义（防拼写漂移）。
 */
import { describe, expect, it } from 'vitest';
// 测试在 node 下运行；本项目未安装 @types/node（其余源码不需要 node 类型）
// @ts-expect-error 无 node 类型声明
import { readFileSync } from 'node:fs';
// @ts-expect-error 同上
import { resolve, dirname } from 'node:path';
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url';
import { TOKENS_CSS } from './tokens';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = [
  'index.html',
  'src/ui/dctlpage.ts',
  'src/ui/batch.ts',
  'src/ui/drxexport.ts',
  'src/ui/guide.ts',
];
const HEX = /#[0-9a-fA-F]{3,8}(?![-0-9a-zA-Z])/;
const RGBA = /rgba?\(\s*\d/;
const FONT = /font(?:-size)?\s*:[^;"'\n]*\d+px/;

function read(rel: string): string {
  return readFileSync(resolve(APP, rel), 'utf8');
}

describe('设计令牌单一来源', () => {
  for (const f of FILES) {
    it(`${f} 无硬编码色值/字号`, () => {
      const src = read(f);
      expect(src.match(HEX)?.[0] ?? null, '残留 hex 色值').toBeNull();
      expect(src.match(RGBA)?.[0] ?? null, '残留 rgba() 色值').toBeNull();
      expect(src.match(FONT)?.[0] ?? null, '残留 px 字号').toBeNull();
    });
  }

  it('index.html 引用的 var(--x) 全部在 TOKENS_CSS 中定义', () => {
    const html = read('index.html');
    const used = new Set([...html.matchAll(/var\((--[a-z0-9-]+)\)/gi)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(20);
    const missing = [...used].filter((v) => !TOKENS_CSS.includes(v + ':'));
    expect(missing, '未定义的令牌变量：' + missing.join(',')).toEqual([]);
  });

  it('TOKENS_CSS 覆盖颜色/字号/间距/圆角/阴影/动效六类', () => {
    for (const v of ['--bg', '--amber', '--err', '--fs-base', '--sp4', '--r-md', '--sh-strip', '--dur-fast']) {
      expect(TOKENS_CSS).toContain(v + ':');
    }
  });
});
