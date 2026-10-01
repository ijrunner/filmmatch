/**
 * R15 · XMP 导入 UI 纯逻辑单测（node 环境；写法同 ui/storage.test.ts）：
 * 卡存储 round-trip / 数量上限 / upsert / 名称清洗接入（cleanCardName 动态 import 链路）/
 * 恒等护栏（全中性 XMP → 卡参数与 defaultParams 逐字相等）/ origins 全量 estimated /
 * thumb 缓存键 / 导入整批不中断（坏文件只记失败）。R19 增：三分组筛选纯逻辑（显示计划/守卫/装配结构）。
 * DOM 部分（网格/缩略图像素/chips 交互）交给 E2E。
 */
import { beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error 测试在 node 下运行；本项目未安装 @types/node
import { readFileSync } from 'node:fs';
// @ts-expect-error 同上
import { resolve, dirname } from 'node:path';
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url';
import {
  DEMO_XMP, STYLE_FILTERS, XMP_CARD_LIMIT, addXmpCards, buildXmpCard, clearXmpCards, deepEq,
  getStyleFilter, importXmpEntries, initXmpImport, listXmpCards, parseAndMap, recipeMatchesCard,
  setStyleFilter, styleFilterFacts, styleFilterPlan, thumbCacheKey, xmpEntry, type XmpCard,
} from './xmpimport';
import { LOOK_KEYS, defaultParams, lookToSchema, textureToSchema } from '../film/params';
import { mapXmpToFilm } from '../estimate/xmpmap';
import { parseXmp } from '../estimate/xmp';

/** 内存版 localStorage（同 storage.test.ts） */
function mockLS(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = mockLS();
  clearXmpCards();
});

/** 最小合法卡（上限/upsert 测试用，不走解析器） */
function miniCard(id: string): XmpCard {
  const d = defaultParams();
  return {
    id, name: '卡 ' + id, source: 'xmp:卡 ' + id, createdAt: '',
    look: d.look, texture: d.texture, origins: { 'master': 'estimated' },
    note: '', unmappedCount: 0, unmappedTop: [], thumb: '',
  };
}

describe('卡存储（fm.xmpcards）', () => {
  it('add/list round-trip：JSON 序列化无损、normalize 后字段一致', async () => {
    const mapping = mapXmpToFilm(parseXmp(DEMO_XMP.neutral));
    const card = await buildXmpCard('Test Card One.xmp', mapping, 'data:image/jpeg;base64,AAA');
    const res = addXmpCards([card]);
    expect(res.saved).toBe(true);
    expect(res.total).toBe(1);
    const list = listXmpCards();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(card);          // 写入→读回逐字段一致（含 thumb dataURL 与 origins 全表）
    expect(list[0].source).toBe('xmp:Test Card One');
  });

  it(`数量上限 ${XMP_CARD_LIMIT}：超出丢最旧并报告 dropped`, () => {
    const n = XMP_CARD_LIMIT + 5;
    const res = addXmpCards(Array.from({ length: n }, (_, i) => miniCard('xmp_t' + i)));
    expect(res.dropped).toBe(5);
    const list = listXmpCards();
    expect(list).toHaveLength(XMP_CARD_LIMIT);
    expect(list[0].id).toBe('xmp_t' + (n - 1));   // 新的在前
    expect(list.some((c) => c.id === 'xmp_t0')).toBe(false);
    expect(list[list.length - 1].id).toBe('xmp_t5'); // 最旧的 5 张被丢
  });

  it('同 id upsert：重复导入不产生重复卡', () => {
    addXmpCards([miniCard('xmp_a'), miniCard('xmp_b')]);
    const again = { ...miniCard('xmp_a'), name: '改过的' };
    addXmpCards([again]);
    const list = listXmpCards();
    expect(list).toHaveLength(2);
    expect(list.find((c) => c.id === 'xmp_a')?.name).toBe('改过的');
  });
});

describe('卡片组装（buildXmpCard）', () => {
  it('名称清洗接入：品牌词文件名 → 清洗后显示名/source；全清洗为空回退「导入预设」', async () => {
    const mapping = mapXmpToFilm(parseXmp(DEMO_XMP.neutral));
    const a = await buildXmpCard('02 - Kodak Film Sx2.xmp', mapping);
    expect(a.name).toBe('02 Film Sx2');
    expect(a.source).toBe('xmp:02 Film Sx2');
    const b = await buildXmpCard(DEMO_XMP.brandFilename, mapping);
    expect(b.name).toBe('Warm Matte');
    expect(b.source).toBe('xmp:Warm Matte');
    const c = await buildXmpCard('CineStill 800T.xmp', mapping);
    expect(c.name).toBe('导入预设');
    expect(c.source).toBe('xmp:导入预设');
  });

  it('恒等护栏：全中性 XMP 的卡参数与 defaultParams() 逐字相等，且 origins 全量 estimated', async () => {
    const card = await buildXmpCard('Neutral Check.xmp', mapXmpToFilm(parseXmp(DEMO_XMP.neutral)));
    const d = defaultParams();
    expect(JSON.stringify({ texture: card.texture, look: card.look }))
      .toBe(JSON.stringify({ texture: d.texture, look: d.look }));
    for (const [g, obj] of Object.entries(d.texture)) {
      for (const k of Object.keys(obj as Record<string, unknown>)) {
        expect(card.origins[`${g}.${k}`]).toBe('estimated');
      }
    }
    for (const k of LOOK_KEYS) expect(card.origins['look.' + k]).toBe('estimated');
    expect(card.origins['master']).toBe('estimated');
  });

  it('note/徽标语义：估算起点说明 + unmapped 前 3 项 + 「需人工调校」', async () => {
    const card = await buildXmpCard(DEMO_XMP.brandFilename, mapXmpToFilm(parseXmp(DEMO_XMP.brand)));
    expect(card.note).toContain('估算起点 · XMP 导入');
    expect(card.note).toContain('需人工调校');
    expect(card.unmappedCount).toBeGreaterThan(0);
    expect(card.unmappedTop).toHaveLength(Math.min(3, card.unmappedCount));
    expect(card.note).toContain(card.unmappedTop[0]);
  });

  it('xmpEntry：kind stock（走风格卡直出路径）、stats 空、origins 透传', async () => {
    const card = await buildXmpCard('Neutral Check.xmp', mapXmpToFilm(parseXmp(DEMO_XMP.neutral)));
    const e = xmpEntry(card);
    expect(e.kind).toBe('stock');
    expect(e.id).toBe(card.id);
    expect(e.name).toBe(card.name);
    expect(e.stats).toBeNull();
    expect(e.origins).toEqual(card.origins);
    expect(e.annotation.origin).toBe('estimated');
  });
});

describe('thumb 缓存键', () => {
  it('同帧同参同键；帧或参数变化则键变化', () => {
    const d = defaultParams();
    const k = thumbCacheKey('frame:a.png', d.look, d.texture);
    expect(thumbCacheKey('frame:a.png', d.look, d.texture)).toBe(k);
    expect(thumbCacheKey('frame:b.png', d.look, d.texture)).not.toBe(k);
    expect(thumbCacheKey('scene:neon', d.look, d.texture)).not.toBe(k);
    const look2 = { ...d.look, fade: 0.2 };
    expect(thumbCacheKey('frame:a.png', look2, d.texture)).not.toBe(k);
  });
});

describe('解析/映射接入与整批导入', () => {
  it('parseAndMap：二级动态 import 链路可用；坏输入抛可读错误', async () => {
    const mapping = await parseAndMap(DEMO_XMP.neutral);
    expect(JSON.stringify(mapping.params)).toBe(JSON.stringify(defaultParams()));
    await expect(parseAndMap(DEMO_XMP.broken)).rejects.toThrow(/XMP/);
  });

  it('importXmpEntries：坏文件只记失败、绝不中断整批；toast/切 tab/入库一致', async () => {
    const toasts: string[] = [];
    const tabs: string[] = [];
    initXmpImport({
      toast: (m) => toasts.push(m),
      applyEntry: () => { throw new Error('node 测试不应触发应用'); },
      switchTab: (t) => tabs.push(t),
      frameCanvas: () => null,
      frameKey: () => 'scene:neon',
      getState: () => null,
      getRecipe: () => null,
    });
    const summary = await importXmpEntries([
      { name: 'good1.xmp', text: DEMO_XMP.neutral },
      { name: DEMO_XMP.brokenFilename, text: DEMO_XMP.broken },
      { name: DEMO_XMP.brandFilename, text: DEMO_XMP.brand },
    ]);
    expect(summary.requested).toBe(3);
    expect(summary.imported).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].file).toBe(DEMO_XMP.brokenFilename);
    expect(summary.cards.map((c) => c.name).sort()).toEqual(['Warm Matte', 'good1'].sort());
    expect(summary.saved).toBe(true);
    expect(listXmpCards()).toHaveLength(2);
    expect(tabs).toEqual(['style']);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain('已导入 2 张（失败 1）');
    expect(toasts[0]).toContain(DEMO_XMP.brokenFilename);
  });
});

describe('应用链路自检（recipeMatchesCard）', () => {
  it('配方 Schema 形（{value, origin} 包装）与卡参数比对：一致/不一致两向', async () => {
    const card = await buildXmpCard(DEMO_XMP.brandFilename, mapXmpToFilm(parseXmp(DEMO_XMP.brand)));
    const recipe = {
      color: { look: lookToSchema(card.look, card.origins) },
      texture: textureToSchema(card.texture, card.origins),
    };
    expect(recipeMatchesCard(recipe, card)).toBe(true);
    const drifted = JSON.parse(JSON.stringify(recipe));
    drifted.color.look.fade.value = 0.5;
    expect(recipeMatchesCard(drifted, card)).toBe(false);
    expect(recipeMatchesCard(null, card)).toBe(false);
  });

  it('deepEq：键序无关、数组有序、标量严格', () => {
    expect(deepEq({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(deepEq([1, 2], [2, 1])).toBe(false);
    expect(deepEq({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEq('x', 'x')).toBe(true);
  });
});

describe('R19 三分组筛选（全部/内置风格/我的卡）', () => {
  const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const read = (rel: string): string => readFileSync(resolve(APP, rel), 'utf8');

  it('chips 定义：三组（全部/内置风格/我的卡）；「我的卡」title 说明诚实口径（XMP 估算起点卡）', () => {
    expect(STYLE_FILTERS.map((f) => f.label)).toEqual(['全部', '内置风格', '我的卡']);
    expect(STYLE_FILTERS.map((f) => f.v)).toEqual(['all', 'builtin', 'mine']);
    expect(STYLE_FILTERS[2].title).toContain('我的卡 = 图库页「导入 XMP 预设」生成的估算起点卡');
    expect(STYLE_FILTERS[2].title).toContain('不进卡片墙');
  });

  it('styleFilterPlan：mine 隐藏内置墙与顶部说明，builtin 反之，all 全显（有卡时空态都不亮）', () => {
    expect(styleFilterPlan('all', 2))
      .toEqual({ builtinGrid: true, topNote: true, mineGrid: true, mineEmpty: false, xmpEmpty: false });
    expect(styleFilterPlan('mine', 2))
      .toEqual({ builtinGrid: false, topNote: false, mineGrid: true, mineEmpty: false, xmpEmpty: false });
    expect(styleFilterPlan('builtin', 2))
      .toEqual({ builtinGrid: true, topNote: true, mineGrid: false, mineEmpty: false, xmpEmpty: false });
  });

  it('空态计划：0 卡时「我的卡」亮专用空态；R15 的 #xmp-empty 语义只在「全部」视图生效', () => {
    expect(styleFilterPlan('mine', 0)).toMatchObject({ mineEmpty: true, xmpEmpty: false });
    expect(styleFilterPlan('all', 0)).toMatchObject({ mineEmpty: false, xmpEmpty: true });
    expect(styleFilterPlan('builtin', 0)).toMatchObject({ mineEmpty: false, xmpEmpty: false });
  });

  it('node 无 DOM 守卫：styleFilterFacts 返回 null；set/get 状态切换不抛错', () => {
    expect(styleFilterFacts()).toBeNull();
    setStyleFilter('mine');
    expect(getStyleFilter()).toBe('mine');
    setStyleFilter('builtin');
    expect(getStyleFilter()).toBe('builtin');
    setStyleFilter('all');
    expect(getStyleFilter()).toBe('all');
  });

  it('装配结构：chips 行由本模块（动态 chunk）插入 #tab-style，index.html/main.ts 零改动——首屏 gzip 零增', () => {
    const mod = read('src/ui/xmpimport.ts');
    expect(mod).toContain("document.getElementById('stylefilter')");
    expect(mod).toContain("body.insertBefore(row, body.firstChild)");
    expect(mod).toContain("'mx-btn'");          // 复用 R2 标签筛选的令牌类
    expect(read('index.html')).not.toContain('stylefilter');
    expect(read('src/main.ts')).not.toContain('stylefilter');
  });
});
