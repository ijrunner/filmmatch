/**
 * R13 · validateDctl 静态校验规则矩阵。
 *
 * 目的：把 validateDctl 的**每一条规则**都钉成正例（合法产物不误伤）+ 反例（违规必被拦）。
 * 既有 codegen.test.ts 对部分规则只有反例或只有正例（见 R13 报告 §2 覆盖判定），本文件补齐。
 *
 * 覆盖规则（与 codegen.ts validateDctl 一一对应）：
 *   ① 括号配平（{ } / ( ) / [ ]）      ⑧ 引用未声明的参数宏
 *   ② 裸向量运算（项目策略）            ⑨ 参数标签非法字符（括号/方括号/逗号）
 *   ③ 官方函数黑名单                    ⑩ UI 参数 > 64
 *   ④ 顶层函数缺 __DEVICE__             ⑪ tooltip 逐条配对
 *   ⑤ transform 入口存在 + 签名单行     ⑫ tooltip 引用未声明宏
 *   ⑥ DEFINE_UI_PARAMS 存在             ⑬ helper 里直接读 UI 参数（闪退根因）
 *   ⑦ 残留 GLSL 符号
 */
import { describe, expect, it } from 'vitest';
import { getPreset } from '../film/params';
import { lookToLogLook } from './logmath';
import { generateDctl, validateDctl, type DctlGenInput } from './codegen';

function baseInput(): DctlGenInput {
  const card = getPreset('fl06');
  return {
    recipeName: card.name,
    shareCode: 'FM-R13-0001',
    pipeline: 'yrgb',
    look: lookToLogLook(card.params.look, 'yrgb'),
    texture: card.params.texture,
    resolution: { w: 1920, h: 1080 },
  };
}
const baseSource = (): string => generateDctl(baseInput()).source;
const errors = (src: string): string[] => validateDctl(src).errors;
const hasErr = (src: string, re: RegExp): boolean => errors(src).some((e) => re.test(e));

/** 在 transform 的最终 return 之前插入一行（不会破坏尾部结构） */
const RETURN = '    return make_float3(fm_clamp01(c.x), fm_clamp01(c.y), fm_clamp01(c.z));';
function insertBeforeReturn(src: string, line: string): string {
  expect(src).toContain(RETURN);
  return src.replace(RETURN, `${line}\n${RETURN}`);
}

describe('R13 validateDctl：基线正例（合法产物零误伤）', () => {
  it('默认产物 ok===true 且 errors 为空；参数区行数与声明数一致', () => {
    const src = baseSource();
    const v = validateDctl(src);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    const nDecl = (src.match(/^[ \t]*DEFINE_UI_PARAMS\s*\(/gm) || []).length;
    expect(nDecl).toBe(53);   // R21：52 + FM_MASTER
  });
});

describe('R13 validateDctl 规则① 括号配平', () => {
  it('反例：删一个 } → 报花括号不配平；删一个 ) → 报圆括号不配平', () => {
    const src = baseSource();
    const noBrace = src.replace(/}\n$/, '');
    expect(hasErr(noBrace, /括号不配平：'\{'/)).toBe(true);
    const noParen = src.replace(/fm_clamp01\(c\.z\)\);\n/, 'fm_clamp01(c.z);\n');
    expect(hasErr(noParen, /括号不配平：'\('/)).toBe(true);
  });
  it('正例：基线无「括号不配平」错误', () => {
    expect(hasErr(baseSource(), /括号不配平/)).toBe(false);
  });
});

describe('R13 validateDctl 规则② 裸向量运算（项目策略）', () => {
  it('反例：float3 变量直接做向量-向量/标量运算（未走 fm_ 助手）→ 报错', () => {
    // 规则针对「VEC 名紧跟运算符」的写法：如 blm = hal - tint（未走 fm_add3）
    const src = insertBeforeReturn(baseSource(), '    float3 blm = hal - tint;');
    expect(hasErr(src, /裸向量运算/)).toBe(true);
  });
  it('正例：基线所有向量运算都走 fm_scale3/fm_add3/fm_mul3，不报该错', () => {
    expect(hasErr(baseSource(), /裸向量运算/)).toBe(false);
  });
});

describe('R13 validateDctl 规则③ 官方函数黑名单', () => {
  const BAD = ['_fract', '_fabsf', '_floor(', '_ceil(', '_clamp(', '_saturate('];
  for (const bad of BAD) {
    it(`反例：使用 ${bad} → 报「官方清单中不存在的函数名」`, () => {
      const line = `    float q = ${bad}${bad.endsWith('(') ? 'x, 0.0f' : '(x)'};`;
      expect(hasErr(insertBeforeReturn(baseSource(), line), /官方清单中不存在的函数名/)).toBe(true);
    });
  }
  it('正例：自写助手 fm_fract/fm_clamp01/fm_smoothstep 不被误判', () => {
    const src = baseSource();
    expect(src).toContain('fm_fract');
    expect(src).toContain('fm_clamp01');
    expect(hasErr(src, /官方清单中不存在的函数名/)).toBe(false);
  });
});

describe('R13 validateDctl 规则④ 顶层函数必须带 __DEVICE__', () => {
  it('反例：追加一个无注解顶层函数 → 报「缺少 __DEVICE__ 注解」', () => {
    const src = baseSource() + '\nfloat fm_hostfn(float x) { return x; }\n';
    expect(hasErr(src, /缺少 __DEVICE__ 注解/)).toBe(true);
  });
  it('正例：基线所有顶层函数都带注解', () => {
    expect(hasErr(baseSource(), /缺少 __DEVICE__ 注解/)).toBe(false);
  });
});

describe('R13 validateDctl 规则⑤ transform 入口', () => {
  it('反例：入口缺 __DEVICE__ → 报「缺少 __DEVICE__ float3 transform(...) 入口」', () => {
    const src = baseSource().replace('__DEVICE__ float3 transform', 'float3 transform');
    expect(hasErr(src, /缺少 __DEVICE__ float3 transform\(\.\.\.\) 入口/)).toBe(true);
  });
  it('反例：签名折行 → 报「transform 签名必须写在同一行」', () => {
    const one = '__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB)';
    const two = '__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y,\n    __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB)';
    const src = baseSource().replace(one, two);
    expect(src).not.toBe(baseSource());
    expect(hasErr(src, /transform 签名必须写在同一行/)).toBe(true);
  });
  it('正例：基线入口存在且单行', () => {
    const src = baseSource();
    expect(hasErr(src, /缺少 __DEVICE__ float3 transform/)).toBe(false);
    expect(hasErr(src, /签名必须写在同一行/)).toBe(false);
  });
});

describe('R13 validateDctl 规则⑥ DEFINE_UI_PARAMS 存在', () => {
  it('反例：删光参数声明 → 报「缺少 DEFINE_UI_PARAMS 参数声明」', () => {
    const src = baseSource().replace(/^DEFINE_UI_(PARAMS|TOOLTIP)\(.*\n/gm, '');
    expect(hasErr(src, /缺少 DEFINE_UI_PARAMS 参数声明/)).toBe(true);
  });
  it('正例：基线含参数声明', () => {
    expect(hasErr(baseSource(), /缺少 DEFINE_UI_PARAMS/)).toBe(false);
  });
});

describe('R13 validateDctl 规则⑦ 残留 GLSL 符号', () => {
  for (const tok of ['vec4', 'vec3', 'vec2', 'mat3', 'texture2D', 'gl_FragColor', '#version']) {
    it(`反例：残留 ${tok} → 报「残留 GLSL 符号」`, () => {
      const src = insertBeforeReturn(baseSource(), `    float q = 1.0f; // ${tok}`);
      expect(hasErr(src, new RegExp(`残留 GLSL 符号：${tok.replace(/[#$]/g, '\\$&')}`))).toBe(true);
    });
  }
  it('正例：基线无任何 GLSL 残留符号', () => {
    expect(hasErr(baseSource(), /残留 GLSL 符号/)).toBe(false);
  });
});

describe('R13 validateDctl 规则⑧ 引用未声明的参数宏', () => {
  it('反例：引用 FM_NOT_DECLARED → 报「引用了未声明的参数宏」', () => {
    const src = insertBeforeReturn(baseSource(), '    float q = FM_NOT_DECLARED;');
    expect(hasErr(src, /引用了未声明的参数宏：FM_NOT_DECLARED/)).toBe(true);
  });
  it('正例：基线的 FM_* 全部已声明', () => {
    expect(hasErr(baseSource(), /引用了未声明的参数宏/)).toBe(false);
  });
});

describe('R13 validateDctl 规则⑨ 参数标签非法字符', () => {
  const CASES: Array<[string, string]> = [
    ['圆括号', 'Bad(Label)'],
    ['方括号', 'Bad[Label]'],
    ['逗号', 'Bad,Label'],
  ];
  for (const [name, label] of CASES) {
    it(`反例：标签含${name} → 报「参数标签含非法字符」`, () => {
      const src = baseSource() + `\nDEFINE_UI_PARAMS(FM_BAD_LBL, ${label}, DCTLUI_SLIDER_FLOAT, 0.0f, 0.0f, 1.0f)\n`;
      expect(hasErr(src, /参数标签含非法字符/)).toBe(true);
    });
  }
  it('正例：基线标签（中英混排 + 分组前缀）无非法字符', () => {
    expect(hasErr(baseSource(), /参数标签含非法字符/)).toBe(false);
  });
});

describe('R13 validateDctl 规则⑩ UI 参数 ≤64', () => {
  const decl = (i: number): string =>
    `DEFINE_UI_PARAMS(FM_EXTRA_${i}, Extra ${i}, DCTLUI_SLIDER_FLOAT, 0.0f, 0.0f, 1.0f)`;
  it('反例：65 个参数 → 报「UI 参数共 65 个 > 64」', () => {
    const extra = Array.from({ length: 12 }, (_, i) => decl(i)).join('\n'); // 53 + 12 = 65（R21 起 53 基线）
    const src = baseSource() + '\n' + extra + '\n';
    expect(hasErr(src, /UI 参数共 65 个 > 64/)).toBe(true);
  });
  it('正例：正好 64 个不报上限错', () => {
    const extra = Array.from({ length: 11 }, (_, i) => decl(i)).join('\n'); // 53 + 11 = 64
    const src = baseSource() + '\n' + extra + '\n';
    const nDecl = (src.match(/^[ \t]*DEFINE_UI_PARAMS\s*\(/gm) || []).length;
    expect(nDecl).toBe(64);
    expect(hasErr(src, /个 > 64/)).toBe(false);
  });
});

describe('R13 validateDctl 规则⑪ tooltip 逐条配对（标准模式）', () => {
  it('反例：删掉某条 tooltip → 报「缺少紧随其后的 DEFINE_UI_TOOLTIP」', () => {
    const src = baseSource().replace(/^DEFINE_UI_TOOLTIP\(.*\n/m, '');
    expect(hasErr(src, /缺少紧随其后的 DEFINE_UI_TOOLTIP/)).toBe(true);
  });
  it('反例：tooltip 第一个参数既非宏名也非标签 → 报错', () => {
    const src = baseSource().replace(/^DEFINE_UI_TOOLTIP\([^,]*?,/m, 'DEFINE_UI_TOOLTIP(WRONG_TARGET,');
    expect(hasErr(src, /既不是宏名也不是该参数的标签/)).toBe(true);
  });
  it('正例：基线每条参数声明后都紧跟配对 tooltip', () => {
    const src = baseSource();
    const nDecl = (src.match(/^[ \t]*DEFINE_UI_PARAMS\s*\(/gm) || []).length;
    const nTip = (src.match(/^[ \t]*DEFINE_UI_TOOLTIP\s*\(/gm) || []).length;
    expect(nTip).toBe(nDecl);
    expect(hasErr(src, /缺少紧随其后的 DEFINE_UI_TOOLTIP|既不是宏名也不是该参数的标签/)).toBe(false);
  });
  it('正例：tooltips:false 的产物 tooltip 数为 0，配对规则不介入（不误伤）', () => {
    const src = generateDctl({ ...baseInput(), tooltips: false }).source;
    expect((src.match(/DEFINE_UI_TOOLTIP\s*\(/g) || []).length).toBe(0);
    expect(validateDctl(src).ok).toBe(true);
  });
});

describe('R13 validateDctl 规则⑫ tooltip 引用未声明宏', () => {
  it('反例：DEFINE_UI_TOOLTIP(FM_NOPE, ...) → 报「引用了未声明的参数宏」', () => {
    const src = baseSource() + '\nDEFINE_UI_TOOLTIP(FM_NOPE, "x")\n';
    expect(hasErr(src, /DEFINE_UI_TOOLTIP 引用了未声明的参数宏：FM_NOPE/)).toBe(true);
  });
  it('正例：基线 tooltip（标签形式）不引用任何未声明宏', () => {
    expect(hasErr(baseSource(), /DEFINE_UI_TOOLTIP 引用了未声明的参数宏/)).toBe(false);
  });
});

describe('R13 validateDctl 规则⑬ helper 里直接读 UI 参数（闪退根因）', () => {
  it('反例：在 fm_luma 里引用 FM_CONTRAST → 报「自定义函数 fm_luma 里直接引用了 UI 参数」', () => {
    const src = baseSource().replace(
      'float fm_luma(float3 c) { return 0.2126f',
      'float fm_luma(float3 c) { return FM_CONTRAST + 0.2126f',
    );
    expect(hasErr(src, /自定义函数 fm_luma 里直接引用了 UI 参数 FM_CONTRAST/)).toBe(true);
  });
  it('正例：基线 helper 不读参数（参数只在 transform 内打包进结构体）', () => {
    expect(hasErr(baseSource(), /里直接引用了 UI 参数/)).toBe(false);
  });
});
