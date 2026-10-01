/**
 * P1 迭代流程测试（F11 短码冲突自增 + F4 标注编辑持久化）。
 * node 环境注入内存版 localStorage；不依赖 DOM。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultLook, defaultTexture } from '../film/params';
import { verifyShortCode } from '../share/code';
import {
  cloneAsUserAnnotation, saveAnnotation, userLibrary,
  type AnnotationPatch,
} from './library';
import * as storage from './storage';

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
});

function patchOf(over: Partial<AnnotationPatch> = {}): AnnotationPatch {
  return {
    name: '我的标注 A',
    look: { ...defaultLook(), fade: 0.5, warmth: -0.2 },
    texture: JSON.parse(JSON.stringify(defaultTexture())) as never,
    origins: { 'look.fade': 'user', 'look.warmth': 'user', 'master': 'user' },
    annotation: { origin: 'user', note: '手动压褪色' },
    ...over,
  };
}

describe('F11 短码冲突自增（registerUniqueCode）', () => {
  it('两个配方撞码：后者自动自增且校验位合法，先注册者不变', () => {
    const c1 = storage.registerUniqueCode('id_a', 'FM-ABCD');
    const c2 = storage.registerUniqueCode('id_b', 'FM-ABCD');
    expect(c1).toBe('FM-ABCD');
    expect(c2).not.toBe(c1);
    expect(verifyShortCode(c2)).toBe(true);
    expect(storage.codeBook()['id_a']).toBe('FM-ABCD');
    expect(storage.codeBook()['id_b']).toBe(c2);
    // 同 id 重注册不发生自增（覆盖语义）
    expect(storage.registerUniqueCode('id_a', 'FM-ABCD')).toBe('FM-ABCD');
  });
});

describe('F4 标注编辑器持久化', () => {
  it('用户条目「保存到条目」：look/texture/origin/说明 写回并可还原', () => {
    storage.saveUserRef({
      id: 'r1', name: '我的参考', thumb: 'data:image/jpeg;base64,x',
      stats: { version: 1, samples: 100 },
      // 旧估算包装形状（兼容路径；完整 TextureEstimate 结构）
      texture: {
        grain: { iso: { value: 800, origin: 'estimated' }, size: { value: 1.4, origin: 'estimated' } },
        halation: {
          amount: { value: 0.3, origin: 'estimated' }, radius: { value: 1.6, origin: 'estimated' },
          tint_rgb: { value: [1.0, 0.31, 0.19], origin: 'estimated' },
        },
        vignette: { chroma_shift: { value: 0.004, origin: 'estimated' } },
      },
      created_at: '2026-09-20T00:00:00Z',
    });
    let list = userLibrary();
    expect(list).toHaveLength(1);
    expect(list[0].texture.grain.iso).toBe(800); // 估算包装被转换
    expect(list[0].look.fade).toBe(0);

    expect(saveAnnotation('r1', patchOf())).toBe(true);
    list = userLibrary();
    expect(list[0].look.fade).toBe(0.5);
    expect(list[0].look.warmth).toBe(-0.2);
    expect(list[0].origins['look.fade']).toBe('user');
    expect(list[0].annotation).toEqual({ origin: 'user', note: '手动压褪色' });
    expect(list[0].texture.bloom.radius).toBeCloseTo(2.0);
    // 列表顺序保持（原位更新，不前插）
    storage.saveUserRef({ id: 'r2', name: 'n2', thumb: 'data:', stats: { version: 1, samples: 1 }, texture: {}, created_at: '' });
    expect(userLibrary().map((e) => e.id)).toEqual(['r2', 'r1']);
  });

  it('内置条目「另存为我的标注」：生成新用户条目（复制缩略图与统计），原条目不动', () => {
    // 内置条目在 node 下不可构建（需 canvas），用同结构的源快照（clone 只消费 name/thumb/stats）
    const src = { name: '霓虹夜色 × 光匣 · FL-05', thumb: 'data:image/jpeg;base64,x', stats: { version: 1, samples: 36864 } };
    const created = cloneAsUserAnnotation(src as unknown as Parameters<typeof cloneAsUserAnnotation>[0], patchOf());
    expect(created).not.toBeNull();
    const list = userLibrary();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created!.id);
    expect(list[0].name).toBe('我的标注 A');
    expect(list[0].kind).toBe('upload');
    expect(list[0].look.fade).toBe(0.5);
    expect(list[0].annotation.origin).toBe('user');
    expect(list[0].thumb).toBe(src.thumb);
    // 容量裁剪仍然生效（MAX_USERREFS=12）
    for (let i = 0; i < 15; i++) {
      storage.saveUserRef({ id: 'x' + i, name: 'n', thumb: 'data:', stats: { version: 1, samples: 1 }, texture: {}, created_at: '' });
    }
    expect(userLibrary().length).toBe(12);
  });

  it('型号卡（无缩略图/统计）不可另存', () => {
    expect(cloneAsUserAnnotation({ name: 'FL-05', thumb: '', stats: null }, patchOf())).toBeNull();
  });
});
