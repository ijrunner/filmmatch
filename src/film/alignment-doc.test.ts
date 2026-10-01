/**
 * R13 · R9 验收③「观感差异清单逐项标注」的机器可检部分。
 *
 * 该验收的交付物是文档 `docs/research/观感对齐清单-R9.md`，内容本身只能人工判读；
 * 但「结构性差异逐项存在且状态合法（已对齐 / 已接受 / 待办）」可以自动断言，
 * 防止文档被误删/漏项而不自知（把「只有报告叙述」升级为「有结构断言」）。
 *
 * R19 起文档含 v2 重标节：v1 表仍是 1..8；v2「重标总表」为 1..14
 * （1..8 重标 + 9..14 R15–R18 新增项），两表逐项状态都必须合法。
 * R21 追加第 15 项（master 全局强度承载）——守卫随文档变严（14 → 15 项）。
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error 测试在 node 下运行；本项目未安装 @types/node
import { existsSync, readFileSync } from 'node:fs';
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url';

/**
 * 文档有两个合法落点：开发工作区（app/ 与 docs/ 平级 → ../../../docs）
 * 与蒸馏后的开源仓（docs/ 在仓内 → ../../docs）。两处探测，先命中先用。
 */
const REL_CANDIDATES = ['../../../docs/research/观感对齐清单-R9.md', '../../docs/research/观感对齐清单-R9.md'];
function locateDoc(): string {
  for (const rel of REL_CANDIDATES) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  throw new Error(`找不到观感对齐清单：试过 ${REL_CANDIDATES.join(' 与 ')}`);
}
const DOC = locateDoc();
const V2_MARK = '# 观感对齐清单 v2';
const DOC_V1 = DOC.slice(0, DOC.indexOf(V2_MARK) > 0 ? DOC.indexOf(V2_MARK) : DOC.length);
const DOC_V2 = DOC.indexOf(V2_MARK) > 0 ? DOC.slice(DOC.indexOf(V2_MARK)) : '';

describe('R13 R9 观感对齐清单：结构断言（R19 起 v1 + v2 双节）', () => {
  it('v1「结构性差异」表存在，且恰好 8 项（编号 1..8）', () => {
    const rows = [...DOC_V1.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1]));
    const structural = rows.filter((n) => n >= 1 && n <= 8);
    expect(structural).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('v1 每一项都标注了状态（已对齐 / 已接受 / 待办），无「待定/未知」', () => {
    // 结构性差异表行：| # | 环节 | 网页 | 达芬奇 | 状态 |
    const tableRows = DOC_V1.split('\n').filter((l: string) => /^\|\s*[1-8]\s*\|/.test(l));
    expect(tableRows.length).toBe(8);
    for (const row of tableRows) {
      const cells = row.split('|').map((c: string) => c.trim());
      const status = cells[cells.length - 2]; // 末尾空串前的状态列
      expect(/已对齐|已接受|待办/.test(status), `状态列非法：${row}`).toBe(true);
    }
  });

  it('v2 重标总表存在，且恰好 15 项（编号 1..15；1..8 重标 + 9..14 R15–R18 新增 + 15 R21 master 承载）', () => {
    expect(DOC_V2, '缺少 v2 节（R19 交付物）').not.toBe('');
    const rows = [...DOC_V2.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1]));
    expect(rows).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('v2 重标总表每项的重标列都标注了状态（已对齐 / 已接受 / 待办）', () => {
    // v2 表行：| # | 环节 | R9 原状态 | v2 重标 | 依据 |——状态看第 4 列（重标列）
    const tableRows = DOC_V2.split('\n').filter((l: string) => /^\|\s*\d+\s*\|/.test(l));
    expect(tableRows.length).toBe(15);
    for (const row of tableRows) {
      const cells = row.split('|').map((c: string) => c.trim());
      const restated = cells[4]; // 0 空串 · 1 编号 · 2 环节 · 3 R9 原状态 · 4 v2 重标
      expect(/已对齐|已接受|待办/.test(restated), `v2 重标列非法：${row}`).toBe(true);
    }
  });

  it('含实测数字或明确的「无数字」说明，并声明测量台与诚实边界（v1/v2 都要有）', () => {
    expect(DOC).toContain('alignment-report.mjs');
    expect(DOC).toContain('诚实边界');
    expect(/mean|ΔE|级/.test(DOC)).toBe(true);
    expect(DOC_V2).toContain('诚实边界');
  });
});
