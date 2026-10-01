/**
 * F11 分享码测试：完整码 roundtrip（含字段边界值）、损坏输入拒绝、校验和拦截、
 * 短码校验位与冲突自增。全部纯函数（node 环境直接跑）。
 */
import { describe, expect, it } from 'vitest';
import {
  bumpShortCode, decodeFull, encodeFull, fnv1a32, shortCodeWithCheck,
  SHORT_ALPHABET, verifyShortCode, type ShareableRecipe,
} from './code';

/** 手工组装的完整配方（结构与 ui/recipe.buildRecipe 输出一致） */
function sampleRecipe(over: Record<string, unknown> = {}): ShareableRecipe & Record<string, unknown> {
  return {
    schema_version: 1,
    id: 'fm_3xk9q',
    share_code: 'FM-TEST',
    name: '青屿 · 霓虹夜色',
    meta: {
      created_at: '2026-09-20T21:30:00+08:00',
      author: 'local',
      source: { type: 'stock', ref_image_id: null, stock_id: 'fl05' },
      stats: { ref: null, source: { version: 1, samples: 921600 } },
    },
    color: {
      engine: 'colormatch-v1',
      params: {
        match_strength: 0.75, skin_hue: 0, skin_sat: 1, skin_isolation: 0,
        split_tone: 0.85, tone_contrast: 1.2, shadow_lift: 0.3, global_sat: 1, highlight_rolloff: 0.7,
      },
      look: { fade: { value: 0.4, origin: 'user' }, saturation: { value: 0.8, origin: 'annotated' } },
      lut_size: 65,
    },
    texture: {
      halation: { enabled: true, amount: { value: 0.42, origin: 'estimated' }, tint_rgb: { value: [1.0, 0.31, 0.19], origin: 'estimated' } },
      grain: { enabled: true, iso: { value: 400, origin: 'annotated' } },
      bloom: { enabled: true, amount: { value: 0.25, origin: 'user' } },
      vignette: { enabled: false, chroma_shift: { value: 0.004, origin: 'estimated' } },
    },
    master: { value: 1, origin: 'user' },
    output: { working_space: 'rec709', export_targets: ['cube', 'drx', 'recipe_code'] },
    ...over,
  };
}

describe('完整码 encodeFull/decodeFull', () => {
  it('roundtrip：深相等（含中文/嵌套/统计快照）', () => {
    const r = sampleRecipe();
    const code = encodeFull(r);
    expect(code.startsWith('FM1.')).toBe(true);
    expect(decodeFull(code)).toEqual(r);
  });

  it('字段边界值 roundtrip：master 0/2、tint 全 0/全 1、饱和 1.4、冷暖 -1、ISO 3200、空名、null 统计', () => {
    const edge = sampleRecipe({
      name: '',
      master: { value: 0, origin: 'user' },
      color: {
        engine: 'colormatch-v1',
        params: {
          match_strength: 1, skin_hue: -1, skin_sat: 2, skin_isolation: 1,
          split_tone: 1, tone_contrast: 2, shadow_lift: 1, global_sat: 2, highlight_rolloff: 1,
        },
        look: {
          fade: { value: 1, origin: 'user' }, black_lift: { value: 0.2, origin: 'user' },
          dye_coupling: { value: 0.4, origin: 'user' }, shadow_bias: { value: 1, origin: 'user' },
          highlight_bias: { value: 1, origin: 'user' }, film_s: { value: 1, origin: 'user' },
          contrast: { value: 1, origin: 'user' }, saturation: { value: 1.4, origin: 'user' },
          warmth: { value: -1, origin: 'user' },
        },
        lut_size: 33,
      },
      texture: {
        halation: { enabled: true, amount: { value: 0, origin: 'user' }, radius: { value: 5, origin: 'user' }, tint_rgb: { value: [0, 0, 0], origin: 'user' }, threshold: { value: 0.3, origin: 'user' } },
        grain: { enabled: true, iso: { value: 3200, origin: 'user' }, size: { value: 5, origin: 'user' }, correlation: { value: 1, origin: 'user' }, shadow_weight: { value: 0, origin: 'user' } },
        bloom: { enabled: true, amount: { value: 1, origin: 'user' }, radius: { value: 8, origin: 'user' }, threshold: { value: 1, origin: 'user' } },
        vignette: { enabled: true, amount: { value: 1, origin: 'user' }, radius: { value: 2, origin: 'user' }, chroma_shift: { value: 0.02, origin: 'user' } },
      },
      meta: { created_at: '2026-01-01T00:00:00Z', author: 'local', source: { type: 'upload', ref_image_id: null, stock_id: null } },
    });
    const back = decodeFull(encodeFull(edge));
    expect(back).toEqual(edge);
    // 全 1 tint 的对照样（另一个极端）
    const t1 = sampleRecipe();
    (t1 as unknown as { texture: { halation: { tint_rgb: { value: number[] } } } }).texture.halation.tint_rgb.value = [1, 1, 1];
    expect(decodeFull(encodeFull(t1))).toEqual(t1);
  });

  it('空白容忍：粘贴时夹带的换行/空格不影响解析', () => {
    const code = encodeFull(sampleRecipe());
    const wrapped = code.slice(0, 40) + '\n' + code.slice(40, 80) + ' ' + code.slice(80) + '\n';
    expect(decodeFull(wrapped)).toEqual(sampleRecipe());
  });

  it('损坏输入拒绝：空串/乱码/缺段/坏字符/错误版本/缺 color', () => {
    const code = encodeFull(sampleRecipe());
    expect(decodeFull('')).toBeNull();
    expect(decodeFull('随便什么乱码')).toBeNull();
    expect(decodeFull('FM1.AA')).toBeNull();               // 缺 payload
    expect(decodeFull('FM2.' + code.slice(4))).toBeNull(); // 前缀错
    expect(decodeFull(code.slice(0, -3) + '***')).toBeNull(); // 非法字符
    expect(decodeFull(encodeFull(sampleRecipe({ schema_version: 2 })))).toBeNull();
    expect(decodeFull(encodeFull(sampleRecipe({ color: undefined })))).toBeNull();
    expect(decodeFull(encodeFull(sampleRecipe({ id: '' })))).toBeNull();
  });

  it('校验和拦截：payload 中部一个字符被改/校验段被改 → 拒绝（防粘贴缺字导入错配方）', () => {
    const code = encodeFull(sampleRecipe());
    const [head, cc, payload] = [code.slice(0, 4), code.slice(4, 6), code.slice(6)];
    // payload 中部替换一字符（必然改变解码字节 → 内容 hash 变化）
    const mid = Math.floor(payload.length / 2);
    const swapped = payload[mid] === 'A' ? 'B' : 'A';
    const tampered = head + cc + payload.slice(0, mid) + swapped + payload.slice(mid + 1);
    expect(tampered).not.toBe(code);
    expect(decodeFull(tampered)).toBeNull();
    // 校验段本身被改
    const badCc = (cc === 'AA' ? 'AB' : 'AA');
    expect(decodeFull(head + badCc + payload)).toBeNull();
    // payload 尾部被截断（复制不完整）→ 校验和/结构至少一处不匹配
    expect(decodeFull(head + cc + payload.slice(0, payload.length - 8))).toBeNull();
  });

  it('确定性：同配方两编码一致；不同配方码不同；典型配方码长可控（<8KB）', () => {
    const r = sampleRecipe();
    expect(encodeFull(r)).toBe(encodeFull(sampleRecipe()));
    expect(encodeFull(sampleRecipe({ name: '另一杯' }))).not.toBe(encodeFull(r));
    expect(encodeFull(r).length).toBeLessThan(8192);
  });
});

describe('短码校验位（FM-XXXX = 3 数据位 + 1 校验位）', () => {
  it('生成/校验：合法码通过；抄错校验位必不通过；数据位错纠错概率符合 30/31；小写与空白容忍', () => {
    const code = shortCodeWithCheck('3X9')!;
    expect(code).toMatch(/^FM-[A-Z2-9]{4}$/);
    expect(verifyShortCode(code)).toBe(true);
    expect(verifyShortCode('  ' + code.toLowerCase() + ' ')).toBe(true);
    const alts = SHORT_ALPHABET.split('').filter((c) => c !== code[6]);
    // 校验位抄错：确定性拒绝（校验位由数据位唯一决定）
    for (const c of alts) expect(verifyShortCode(code.slice(0, 6) + c)).toBe(false);
    // 数据位抄错：31 进制单字符校验，误吸率 1/30 级 —— 90 个错码里 ≥85 个被拦
    let blocked = 0, tried = 0;
    for (let i = 3; i < 6; i++) {
      for (const c of SHORT_ALPHABET) {
        if (c === code[i]) continue;
        tried++;
        if (!verifyShortCode(code.slice(0, i) + c + code.slice(i + 1))) blocked++;
      }
    }
    expect(blocked).toBeGreaterThanOrEqual(tried - tried / 31 * 3 - 1);
    // 任意输入不抛错，只返回布尔
    expect(typeof verifyShortCode('FM-ABCD')).toBe('boolean');
  });

  it('非法数据字符拒绝（含 I/L/O/0/1）', () => {
    expect(shortCodeWithCheck('ILO')).toBeNull();
    expect(shortCodeWithCheck('AB')).toBeNull();
    expect(verifyShortCode('FM-110A')).toBe(false);
  });

  it('bumpShortCode：自增后仍为合法短码；连续自增不重复；回绕不崩', () => {
    let c = shortCodeWithCheck('AAA')!;
    const seen = new Set<string>();
    for (let i = 0; i < 70; i++) {
      c = bumpShortCode(c);
      expect(verifyShortCode(c)).toBe(true);
      expect(seen.has(c)).toBe(false);
      seen.add(c);
    }
    // 手工回绕：ZZZ 的自增不抛错且合法
    const z = shortCodeWithCheck('ZZZ')!;
    expect(verifyShortCode(bumpShortCode(z))).toBe(true);
    expect(SHORT_ALPHABET).not.toMatch(/[ILO01]/);
    expect(fnv1a32('a')).not.toBe(fnv1a32('b'));
  });
});
