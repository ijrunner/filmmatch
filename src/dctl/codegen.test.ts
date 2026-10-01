/**
 * DCTL 生成器（src/dctl/codegen.ts + samples.ts）单元测试：node 环境、无 DOM。
 * 覆盖：生成源码的语法自洽（入口/参数区/无 GLSL 残留）、静态校验、参数面板声明数与
 * 配方参数一致、GLSL→DCTL 语法映射、3 个样例生成与 golden 文件写出防漂移、商标红线。
 */
import { describe, expect, it } from 'vitest';
import { CDL_RANGES, type Cdl } from '../batch/cdl';
import { defaultTexture, getPreset } from '../film/params';
import { generateDctl, glslToDctl, matchParamDecls, PIXEL_SIG, TEXTURE_SIG, textureParamDecls, validateDctl, type DctlGenInput, type DctlGenResult } from './codegen';
import { GROUP_PREFIX, PARAM_TEXT } from './labels';
import { lookToLogLook } from './logmath';
import {
  buildLabelSpike, buildMatchSample, buildSample, DCTL_SAMPLES, LABEL_SPIKE_SAMPLES, MATCH_SAMPLES, solvedSampleCdl,
} from './samples';

/**
 * 动态载入 node 内置模块（specifier 用变量，tsc 无需 @types/node 也不报 TS2307）。
 * 仅用于 golden 文件写盘；缺失时测试会失败而非静默跳过（写出是本项硬性验收）。
 */
async function nodeMod(spec: string): Promise<any> {
  return import(/* @vite-ignore */ spec);
}

/** 用 fl06 预设构造一份标准生成输入 */
function makeInput(pipeline: 'yrgb' | 'rcm' | 'aces' = 'yrgb'): DctlGenInput {
  const card = getPreset('fl06');
  return {
    recipeName: card.name,
    shareCode: 'FM-TEST-0001',
    pipeline,
    look: lookToLogLook(card.params.look, pipeline),
    texture: card.params.texture,
    resolution: { w: 1920, h: 1080 },
  };
}

const BRAND_WORDS = ['Kodak', 'Vision3', 'CineStill', 'Dehancer', 'Exposure'];
const GLSL_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
varying vec2 v_uv;
void main(){
  vec3 c = texture2D(u_tex, v_uv).rgb;
  float n = fract(c.r * 7.0);
  c.r = clamp(c.r + n, 0.0, 1.0);
  c = mix(c, vec3(n), 0.5);
  gl_FragColor = vec4(c, 1.0);
}`;

describe('generateDctl 语法自洽', () => {
  it('8. 含 __DEVICE__/DEFINE_UI_PARAMS/_tex2D，不含 vec3/vec2/texture2D/gl_FragColor/#version', () => {
    const { source } = generateDctl(makeInput('yrgb'));
    expect(source).toContain('__DEVICE__');
    expect(source).toContain('DEFINE_UI_PARAMS');
    expect(source).toContain('_tex2D');
    expect(source).toContain('__TEXTURE__');
    for (const bad of ['vec3', 'vec2', 'vec4', 'mat3', 'texture2D', 'gl_FragColor', '#version']) {
      expect(source.includes(bad)).toBe(false);
    }
  });

  it('8b. 参数区行数与 params 清单一致，且 look/质感层参数齐全', () => {
    const r = generateDctl(makeInput('yrgb'));
    const nDecl = (r.source.match(/^[ \t]*DEFINE_UI_PARAMS\s*\(/gm) || []).length;
    expect(nDecl).toBe(r.params.length);
    for (const m of ['FM_CONTRAST', 'FM_PIVOT', 'FM_HALATION_AMOUNT', 'FM_GRAIN_AMP', 'FM_BLOOM_AMOUNT', 'FM_VIGNETTE_AMOUNT']) {
      expect(r.source).toContain(m);
    }
  });
});

describe('validateDctl 静态校验', () => {
  it('9. 生成源码 ok===true；删一个 } 或改掉 __DEVICE__ 后 ok===false 且 errors 非空', () => {
    const { source } = generateDctl(makeInput('rcm'));
    const ok = validateDctl(source);
    expect(ok.ok).toBe(true);
    expect(ok.errors).toEqual([]);

    // 删掉最后一个 '}'（破坏括号配平）
    const idx = source.lastIndexOf('}');
    const broken = source.slice(0, idx) + source.slice(idx + 1);
    const r1 = validateDctl(broken);
    expect(r1.ok).toBe(false);
    expect(r1.errors.length).toBeGreaterThan(0);

    // 改掉入口修饰
    const r2 = validateDctl(source.replace('__DEVICE__', 'DEVICE'));
    expect(r2.ok).toBe(false);
    expect(r2.errors.length).toBeGreaterThan(0);
  });
});

describe('参数面板声明', () => {
  it('10. params.length === textureParamDecls(...).length；macro 唯一；数值型 min<max', () => {
    const input = makeInput('yrgb');
    const r = generateDctl(input);
    const ref = textureParamDecls(input.texture, input.look, input.resolution!);
    expect(r.params.length).toBe(ref.length);
    expect(r.params.length).toBeGreaterThan(0);

    const macros = r.params.map((p) => p.macro);
    expect(new Set(macros).size).toBe(macros.length); // 宏名唯一
    for (const p of r.params) {
      expect(/^[A-Z0-9_]+$/.test(p.macro)).toBe(true); // ASCII 宏名
      if (p.type === 'bool') continue;
      expect(p.min).toBeTypeOf('number');
      expect(p.max).toBeTypeOf('number');
      expect(p.min!).toBeLessThan(p.max!);
      expect(Number(p.def)).toBeGreaterThanOrEqual(p.min!);
      expect(Number(p.def)).toBeLessThanOrEqual(p.max!);
    }
  });

  it('10b. 空间量换算：1080p 下光晕/柔光半径与色散为像素常量', () => {
    const input = makeInput('yrgb');
    const decls = textureParamDecls(input.texture, input.look, { w: 1920, h: 1080 });
    const byMacro = Object.fromEntries(decls.map((d) => [d.macro, d]));
    // fl06：halation radius 1.5%H → 16px；bloom radius 1.8%H → 19px；chroma 0.003*1080≈3.24px
    expect(byMacro['FM_HALATION_RADIUS_PX'].def).toBe(Math.round(0.015 * 1080));
    expect(byMacro['FM_HALATION_TIGHT_PX'].def).toBe(Math.round(0.003 * 1080));
    expect(byMacro['FM_VIGNETTE_CHROMA_PX'].def).toBeCloseTo(0.003 * 1080, 3);
  });
});

describe('glslToDctl 语法映射', () => {
  it('11. vec3/texture2D/fract/clamp/mix 全部替换且无残留', () => {
    const out = glslToDctl(GLSL_FRAGMENT);
    expect(out).toContain('float3');
    expect(out).toContain('_tex2D');
    expect(out).toContain('_fract');
    expect(out).toContain('_clamp');
    expect(out).toContain('_mix');
    expect(out).toContain('__DEVICE__ float3 transform(');
    expect(out).not.toContain('#version');
    // 无未替换的残留（用负向后顾排除已带 _ 前缀的内建）
    expect(/(?<!_)\bvec[234]\b/.test(out)).toBe(false);
    expect(/\btexture2D\b/.test(out)).toBe(false);
    expect(/(?<!_)\bfract\b/.test(out)).toBe(false);
    expect(/(?<!_)\bclamp\b/.test(out)).toBe(false);
    expect(/(?<!_)\bmix\b/.test(out)).toBe(false);
    expect(out).not.toContain('gl_FragColor');
    expect(out).not.toContain('varying');
    expect(out).not.toContain('uniform');
  });
});

describe('样例产物', () => {
  it('12. 三个样例都能生成且 validateDctl ok；aces 样例 warnings 含「预留」', () => {
    expect(DCTL_SAMPLES.length).toBe(3);
    for (const s of DCTL_SAMPLES) {
      const r = buildSample(s);
      const v = validateDctl(r.source);
      expect(v.ok, `${s.id}: ${v.errors.join('; ')}`).toBe(true);
      expect(r.source).toContain('__DEVICE__');
    }
    const aces = buildSample({ id: 'aces-fl06', pipeline: 'aces', presetId: 'fl06', fileName: 'FM_aces_fl06.dctl', compat: true });
    expect(validateDctl(aces.source).ok).toBe(true);
    expect(aces.warnings.some((w) => w.includes('预留'))).toBe(true);
    // 非 aces 样例不应带「预留」告警
    expect(buildSample(DCTL_SAMPLES[0]).warnings.some((w) => w.includes('预留'))).toBe(false);
  });

  it('12b. warnings 注明 1080p 换算与按比例调整', () => {
    const r = buildSample(DCTL_SAMPLES[0]);
    expect(r.warnings.some((w) => w.includes('2160p') && w.includes('比例'))).toBe(true);
  });

  it('13. 写出 golden 文件：非空、含 __DEVICE__，且再次生成内容一致（防漂移）', async () => {
    const fs = await nodeMod('node:fs');
    const path = await nodeMod('node:path');
    const url = await nodeMod('node:url');
    const dir = url.fileURLToPath(new URL('../../tools/dctl-samples/', import.meta.url));
    fs.mkdirSync(dir, { recursive: true });
    for (const s of DCTL_SAMPLES) {
      const r = buildSample(s);
      const file = path.join(dir, s.fileName);
      fs.writeFileSync(file, r.source, 'utf8');
      const back = fs.readFileSync(file, 'utf8');
      expect(back.length).toBeGreaterThan(0);
      expect(back).toContain('__DEVICE__');
      expect(back).toBe(r.source);                    // 落盘内容 == 内存生成内容
      expect(buildSample(s).source).toBe(r.source);   // 二次生成无漂移
    }
  });

  it('14. 生成源码不含第三方品牌词', () => {
    const sources = [
      ...DCTL_SAMPLES.map((s) => buildSample(s).source),
      buildSample({ id: 'aces-fl06', pipeline: 'aces', presetId: 'fl06', fileName: 'x.dctl', compat: true }).source,
    ];
    for (const src of sources) {
      for (const w of BRAND_WORDS) expect(src.includes(w)).toBe(false);
    }
  });

  it('14b. 默认纹理参数也能生成并校验通过（空配方兜底）', () => {
    const look = lookToLogLook(getPreset('neutral').params.look, 'rcm');
    const r = generateDctl({ recipeName: '默认 · 中性', shareCode: 'FM-RCM-NEUTRAL', pipeline: 'rcm', look, texture: defaultTexture() });
    expect(validateDctl(r.source).ok).toBe(true);
    for (const w of BRAND_WORDS) expect(r.source.includes(w)).toBe(false);
  });

  it('15. 所有函数（含助手）都带 __DEVICE__ 注解（JIT 拒绝 host 函数）', () => {
    const { source } = generateDctl(makeInput('yrgb'));
    const defs = [...source.matchAll(/^([A-Za-z_][\w\s]*?)\b(\w+)\s*\([^;{]*\)\s*\{/gm)]
      .map((m) => ({ head: m[1].trim(), name: m[2] }))
      .filter((d) => ['float3', 'float2', 'float', 'int', 'void'].some((t) => d.head.endsWith(t)));
    expect(defs.length).toBeGreaterThan(5);
    for (const d of defs) expect(d.head, `函数 ${d.name} 缺 __DEVICE__`).toContain('__DEVICE__');
    expect(validateDctl(source).errors.filter((e) => e.includes('__DEVICE__'))).toEqual([]);
  });

  it('16. 不使用官方函数清单里不存在的名字（_fract/_fabsf/_floor( 等）', () => {
    const { source } = generateDctl(makeInput('rcm'));
    for (const bad of ['_fract', '_fabsf', '_floor(', '_ceil(', '_clamp(']) {
      expect(new RegExp(`(?<![A-Za-z0-9_])${bad.replace(/[(]/g, '\\(')}`).test(source), `不该出现 ${bad}`).toBe(false);
    }
    expect(source).toContain('fm_fract');
    expect(source).toContain('_floorf');
  });
});

/* ---- 回归：层裁剪（stages）----
 * 背景（2026-09-22 实机）：二分文件 30/31/32 在达芬奇里全部报
 * 「main DCTL function does not have return value」，两个根因都在层裁剪：
 *   A. 面板删掉了 FM_VIGNETTE_CHROMA_PX 的声明，可基础段代码仍在引用它（未声明宏）；
 *   B. 层标记交错嵌套（>>>bloom 写在 <<<halation 之前），单个 skip 槽遇到不配对的闭标记后
 *      再也不复位，把 transform 的 return 和收尾 } 一起吃掉。
 * 下面两条把「面板与代码同步裁剪」和「尾部完整性」钉死。 */
describe('层裁剪 stages 不变量', () => {
  const COMBOS = [false, true].flatMap((halation) =>
    [false, true].flatMap((bloom) =>
      [false, true].flatMap((grain) =>
        [false, true].map((vignette) => ({ halation, bloom, grain, vignette })))));

  it('17. 16 种层组合都能生成：无未声明宏、尾部完整、静态校验通过', () => {
    expect(COMBOS.length).toBe(16);
    for (const stages of COMBOS) {
      const tag = JSON.stringify(stages);
      const { source } = generateDctl({ ...makeInput('yrgb'), compat: true, stages });
      const v = validateDctl(source);
      expect(v.errors, `${tag}：${v.errors.join('；')}`).toEqual([]);
      /* 尾部完整性：层裁剪曾把这两行一起吃掉，达芬奇只报含糊的 return value 错误 */
      expect(source, `${tag}：缺顶层 return`).toMatch(/^[ \t]*return make_float3\(/m);
      expect(source.trimEnd().endsWith('}'), `${tag}：结尾不是 }`).toBe(true);
      expect(source, `${tag}：残留层标记`).not.toMatch(/>>>STAGE|<<<STAGE/);
    }
  });

  it('18. 关掉的层：参数面板与代码同时消失；暗角关闭时改用退化取样', () => {
    const off = { halation: false, bloom: false, grain: false, vignette: false };
    const colorOnly = generateDctl({ ...makeInput('yrgb'), compat: true, stages: off }).source;
    for (const macro of ['FM_HALATION_', 'FM_BLOOM_', 'FM_GRAIN_', 'FM_VIGNETTE_']) {
      expect(colorOnly.includes(macro), `色彩层不该出现 ${macro}`).toBe(false);
    }
    /* 无质感层也必须取到源像素：走 novignette 分支的 3 次中心取样 */
    expect((colorOnly.match(/_tex2D/g) || []).length).toBe(3);
    /* 只开暗角：边缘色散（chroma_shift）随暗角层一起出现，取样仍是 3 次 */
    const vigOnly = generateDctl({
      ...makeInput('yrgb'), compat: true,
      stages: { halation: false, bloom: false, grain: false, vignette: true },
    }).source;
    expect(vigOnly).toContain('FM_VIGNETTE_CHROMA_PX');
    expect((vigOnly.match(/_tex2D/g) || []).length).toBe(3);
    expect(validateDctl(vigOnly).ok).toBe(true);
  });
});

/* ---- R6：双语标签 / 分组前缀 / tooltip / 标签 spike ----
 * 达芬奇的 DCTL 参数面板是平铺列表：44 个滑杆只能靠标签自身聚拢（分组前缀），说明只能靠 tooltip。
 * 但中英混排标签与 tooltip 都还没在达芬奇里验证过（前科：标签里的括号会让达芬奇报
 * unknown type of DCTLUIParams definition），所以这里既有格式断言，也产出 3 参数 spike 文件。 */

/** 从源码里抽出 (宏, 标签) 对——标签抓到 DCTLUI_ 类型名为止，这样标签里若混进逗号也能完整捕获 */
function srcLabels(source: string): { macro: string; label: string }[] {
  return [...source.matchAll(/DEFINE_UI_PARAMS\s*\(\s*(FM_[A-Z0-9_]+)\s*,\s*([\s\S]*?)\s*,\s*DCTLUI_/g)]
    .map((m) => ({ macro: m[1], label: m[2] }));
}
const hasCJK = (s: string): boolean => /[^\x00-\x7F]/.test(s);
const countOf = (src: string, re: RegExp): number => (src.match(re) || []).length;

/** R18：HSL 诚实标注——配方带 HSL 时 warnings 显式声明 DCTL 不承载该维度 */
describe('R18 HSL 维度诚实标注', () => {
  it('配方含 HSL → warnings 出现「DCTL 不承载」；无 HSL → 不出现（默认警告数不变）', () => {
    const base = makeInput();
    const without = generateDctl(base);
    expect(without.warnings.some((w) => w.includes('HSL'))).toBe(false);
    const withHsl = generateDctl({
      ...base,
      look: { ...base.look, hsl: { red: { hue: 0.3, sat: 0.2, lum: 0 } } },
    });
    expect(withHsl.warnings.some((w) => w.includes('HSL 8 色相'))).toBe(true);
    expect(withHsl.warnings.some((w) => w.includes('仅由网页预览与 .cube 导出承载'))).toBe(true);
    /* HSL 不进参数面板 / 不进源码（参数数不变、无 FM_HSL 宏） */
    expect(withHsl.params.length).toBe(without.params.length);
    expect(withHsl.source).not.toContain('FM_HSL');
  });
});

describe('R6 双语标签与分组前缀', () => {
  it('19. 标准模式标签 = 中文 + 空格 + 英文名且无括号/方括号/逗号；compat 模式标签与 tooltip 全 ASCII', () => {
    const std = generateDctl(makeInput('yrgb'));
    const labels = srcLabels(std.source);
    expect(labels.length).toBe(std.params.length);
    for (const p of std.params) {
      const t = PARAM_TEXT[p.macro];
      expect(t, `${p.macro} 缺文案表条目`).toBeDefined();
      expect(p.en).toBe(t.en);
      expect(p.tip).toBe(t.tip);
      expect(p.tipEn).toBe(t.tipEn);
      expect(p.group).toBe(t.group);
      expect(hasCJK(p.label), `${p.macro} 标签缺中文：${p.label}`).toBe(true);
      expect(p.label.includes(p.en), `${p.macro} 标签缺英文名：${p.label}`).toBe(true);
      expect(/[()\[\],]/.test(p.label), `${p.macro} 标签含非法字符：${p.label}`).toBe(false);
      // 说明里也不写 ASCII 括号/逗号：tooltip 的写法同样没在达芬奇里验证过，把风险面压到最小
      expect(/[()\[\],]/.test(p.tip), `${p.macro} 中文说明含 ASCII 括号/逗号：${p.tip}`).toBe(false);
      expect(/[()\[\],]/.test(p.tipEn ?? ''), `${p.macro} 英文说明含 ASCII 括号/逗号：${p.tipEn}`).toBe(false);
    }
    // 源码里写出来的标签与 decls 一致（标准模式默认带分组前缀）
    for (const l of labels) {
      const decl = std.params.find((p) => p.macro === l.macro)!;
      expect(l.label).toBe(decl.label);
      expect(hasCJK(l.label)).toBe(true);
    }
    // compat：标签全 ASCII；tooltip 默认**不生成**（tooltip 语法未实机验证，不掺进已验证安全的 compat 形态）
    const compat = generateDctl({ ...makeInput('yrgb'), compat: true });
    for (const l of srcLabels(compat.source)) {
      expect(hasCJK(l.label), `compat 标签不是 ASCII：${l.label}`).toBe(false);
    }
    expect(countOf(compat.source, /DEFINE_UI_TOOLTIP/g)).toBe(0);
    // 显式打开时，compat 的 tooltip 文本也走 ASCII
    const compatTip = generateDctl({ ...makeInput('yrgb'), compat: true, tooltips: true });
    const compatTips = [...compatTip.source.matchAll(/DEFINE_UI_TOOLTIP\s*\([^,]+,\s*"([^"]*)"/g)].map((m) => m[1]);
    expect(compatTips.length).toBe(compatTip.params.length);
    for (const tip of compatTips) expect(hasCJK(tip), `compat tooltip 不是 ASCII：${tip}`).toBe(false);
    expect(validateDctl(compat.source).ok).toBe(true);
    expect(validateDctl(compatTip.source).ok).toBe(true);
  });

  it('19b. compat=true 等价于 labelMode ascii（标签层面）；显式 labelMode 优先，但不改开关写法', () => {
    const base = makeInput('yrgb');
    const compat = generateDctl({ ...base, compat: true });
    const ascii = generateDctl({ ...base, labelMode: 'ascii' });
    expect(srcLabels(compat.source)).toEqual(srcLabels(ascii.source));   // compat 自动按 ascii 渲染标签
    expect(compat.source).not.toContain('DCTLUI_CHECK_BOX');             // 开关是 0/1 滑杆
    // 显式 labelMode 优先：compat + bilingual = 0/1 开关 + 混排标签（标签与开关是两个独立轴）
    const forced = generateDctl({ ...base, compat: true, labelMode: 'bilingual' });
    expect(srcLabels(forced.source).some((l) => hasCJK(l.label))).toBe(true);
    expect(forced.source).not.toContain('DCTLUI_CHECK_BOX');
    expect(validateDctl(forced.source).ok, validateDctl(forced.source).errors.join('；')).toBe(true);
  });

  it('20. tooltip 逐条紧随（第一个参数 = 该参数的标签或宏名）：声明数 == tooltip 数；tooltips:false 不生成', () => {
    const std = generateDctl(makeInput('yrgb'));
    const nDecl = countOf(std.source, /^[ \t]*DEFINE_UI_PARAMS\s*\(/gm);
    const nTip = countOf(std.source, /^[ \t]*DEFINE_UI_TOOLTIP\s*\(/gm);
    expect(nDecl).toBe(std.params.length);
    expect(nTip).toBe(nDecl);
    const lines = std.source.split('\n');
    let paired = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = /^[ \t]*DEFINE_UI_PARAMS\s*\(\s*(FM_[A-Z0-9_]+)\s*,\s*([\s\S]*?)\s*,\s*DCTLUI_/.exec(lines[i]);
      if (!m) continue;
      // 第一个参数按官方文档示例是「标签文本」；宏名写法也允许（validateDctl 两种都收）
      const t = /^[ \t]*DEFINE_UI_TOOLTIP\s*\(\s*([^,]*?)\s*,/.exec(lines[i + 1]);
      expect(t, `${m[1]} 的 tooltip 没有紧跟其后`).not.toBeNull();
      expect([m[1], m[2].trim()]).toContain(t![1].trim());
      paired++;
    }
    expect(paired).toBe(nDecl);
    // 关掉 tooltip：一条都不生成，且产物仍然合法（spike A/B 与兼容模式也是这种形态）
    const noTip = generateDctl({ ...makeInput('yrgb'), tooltips: false });
    expect(countOf(noTip.source, /^[ \t]*DEFINE_UI_TOOLTIP\s*\(/gm)).toBe(0);
    expect(countOf(noTip.source, /DEFINE_UI_PARAMS/g)).toBe(noTip.params.length);
    expect(validateDctl(noTip.source).ok, validateDctl(noTip.source).errors.join('；')).toBe(true);
    // 兼容模式默认**不**带 tooltip：compat 产物正是用户实测可用的那一批，不掺未验证语法
    const compat = generateDctl({ ...makeInput('yrgb'), compat: true });
    expect(countOf(compat.source, /^[ \t]*DEFINE_UI_TOOLTIP\s*\(/gm)).toBe(0);
    // 显式打开才生成（文本走 ASCII）
    const compatTip = generateDctl({ ...makeInput('yrgb'), compat: true, tooltips: true });
    expect(countOf(compatTip.source, /^[ \t]*DEFINE_UI_TOOLTIP\s*\(/gm)).toBe(compatTip.params.length);
  });

  it('21. 分组前缀：非 look 组标签以中文组名开头；groupPrefix:false 退化为「中文 英文」', () => {
    expect(GROUP_PREFIX).toEqual({ match: '匹配-', look: '', master: '质感-', halation: '光晕-', bloom: '柔光-', grain: '颗粒-', vignette: '暗角-', gate_weave: '片门-' });
    const std = generateDctl(makeInput('yrgb'));
    for (const l of srcLabels(std.source)) {
      const p = std.params.find((x) => x.macro === l.macro)!;
      const t = PARAM_TEXT[l.macro];
      expect(l.label).toBe(`${GROUP_PREFIX[p.group]}${t.cn} ${t.en}`);
      if (p.group === 'look') {
        expect(['光晕-', '柔光-', '颗粒-', '暗角-', '片门-'].some((pre) => l.label.startsWith(pre)), `look 标签不该带前缀：${l.label}`).toBe(false);
      } else {
        expect(l.label.startsWith(GROUP_PREFIX[p.group]), `${p.group} 标签缺前缀：${l.label}`).toBe(true);
      }
    }
    // 质感组的中文前缀都真的出现在产物里（面板里才会聚拢）
    for (const pre of ['质感-', '光晕-', '柔光-', '颗粒-', '暗角-', '片门-']) expect(std.source).toContain(pre);
    // groupPrefix:false：标签退化成「中文 英文」
    const noPrefix = generateDctl({ ...makeInput('yrgb'), groupPrefix: false });
    expect(noPrefix.params.length).toBe(std.params.length);
    for (const l of srcLabels(noPrefix.source)) {
      const t = PARAM_TEXT[l.macro];
      expect(l.label).toBe(`${t.cn} ${t.en}`);
      expect(['质感-', '光晕-', '柔光-', '颗粒-', '暗角-', '片门-'].some((pre) => l.label.startsWith(pre)), `不该带分组前缀：${l.label}`).toBe(false);
    }
    expect(validateDctl(noPrefix.source).ok, validateDctl(noPrefix.source).errors.join('；')).toBe(true);
  });
});

describe('R6 validateDctl 新规则', () => {
  const base = generateDctl(makeInput('yrgb')).source;

  it('22. 标签里出现括号/方括号/逗号 → 报错（社区实测会让达芬奇解析失败）', () => {
    for (const bad of ['对比度(Contrast)', '对比度 Contrast, Look', '对比度 [Contrast]']) {
      const v = validateDctl(base.replace('对比度 Contrast', bad));
      expect(v.ok, `${bad} 应该被拦下`).toBe(false);
      expect(v.errors.join('；'), bad).toContain('非法字符');
      // 括号配平没被破坏：抓到的是标签规则，不是括号规则
      expect(v.errors.some((e) => e.includes('括号不配平'))).toBe(false);
    }
    expect(validateDctl(base).ok, validateDctl(base).errors.join('；')).toBe(true);
  });

  it('23. 标准模式缺 tooltip（或第一个参数既非宏名也非标签）→ 报错；全无 tooltip 的合法产物不误伤', () => {
    const lines = base.split('\n');
    const i = lines.findIndex((l) => l.includes('DEFINE_UI_PARAMS(FM_CONTRAST'));
    expect(i).toBeGreaterThan(0);
    expect(lines[i + 1]).toContain('DEFINE_UI_TOOLTIP(对比度 Contrast');
    const dropped = [...lines.slice(0, i + 1), ...lines.slice(i + 2)].join('\n');
    const v = validateDctl(dropped);
    expect(v.ok).toBe(false);
    expect(v.errors.join('；')).toContain('DEFINE_UI_TOOLTIP');
    // 第一个参数写错（既不是宏名也不是该参数的标签）
    const wrong = base.replace('DEFINE_UI_TOOLTIP(对比度 Contrast,', 'DEFINE_UI_TOOLTIP(别的名字,');
    const v2 = validateDctl(wrong);
    expect(v2.ok).toBe(false);
    expect(v2.errors.join('；')).toContain('既不是宏名也不是该参数的标签');
    // 宏名写法也合法（现场二分用）
    const macroForm = generateDctl({ ...makeInput('yrgb'), tooltipTarget: 'macro' }).source;
    expect(macroForm).toContain('DEFINE_UI_TOOLTIP(FM_CONTRAST,');
    expect(validateDctl(macroForm).ok, validateDctl(macroForm).errors.join('；')).toBe(true);
    /* 反例之外不误伤：tooltips:false 的合法产物、以及故意不带 tooltip 的 spike A/B，
     * tooltip 数为 0 → 配对规则不介入（否则「只验证混排标签」这一种写法就没法单独测了）。 */
    const noTip = generateDctl({ ...makeInput('yrgb'), tooltips: false }).source;
    expect(validateDctl(noTip).ok, validateDctl(noTip).errors.join('；')).toBe(true);
  });

  it('24. 参数总数 > 64 → 报错；正好 64 个通过', () => {
    const decls = Array.from({ length: 65 }, (_, i) =>
      `DEFINE_UI_PARAMS(FM_T${i}, Param ${i}, DCTLUI_SLIDER_FLOAT, 0.0000f, 0.0000f, 1.0000f, 0.01f)`);
    /* 无 _tex2D 采样，故用逐像素签名（R14：签名须与采样方式同步，否则校验会报「不同步」） */
    const body = [PIXEL_SIG, '{', '    return make_float3(0.0f, 0.0f, 0.0f);', '}'];
    const over = validateDctl([...decls, ...body].join('\n'));
    expect(over.ok).toBe(false);
    expect(over.errors.some((e) => e.includes('64')), over.errors.join('；')).toBe(true);
    const exact = validateDctl([...decls.slice(0, 64), ...body].join('\n'));
    expect(exact.ok, exact.errors.join('；')).toBe(true);
  });
});

describe('R6 标签 spike 产物（3 参数 × 3 种写法）', () => {
  it('25. 三个 spike 文件：各 3 参数 / 校验通过 / 参数真被用上 / 落盘且二次生成无漂移', async () => {
    expect(LABEL_SPIKE_SAMPLES.length).toBe(3);
    const fs = await nodeMod('node:fs');
    const path = await nodeMod('node:path');
    const url = await nodeMod('node:url');
    const dir = url.fileURLToPath(new URL('../../tools/dctl-samples/', import.meta.url));
    fs.mkdirSync(dir, { recursive: true });
    for (const s of LABEL_SPIKE_SAMPLES) {
      const r = buildLabelSpike(s);
      expect(r.params.length, `${s.fileName} 参数数`).toBe(3);
      expect(new Set(r.params.map((p) => p.macro)).size).toBe(3);
      const v = validateDctl(r.source);
      expect(v.ok, `${s.fileName}: ${v.errors.join('；')}`).toBe(true);
      // 参数必须真被用上：每个宏除了声明，还要在 transform 里出现
      for (const p of r.params) {
        expect(countOf(r.source, new RegExp(`\\b${p.macro}\\b`, 'g')), `${p.macro} 未被使用`).toBeGreaterThan(1);
      }
      for (const w of BRAND_WORDS) expect(r.source.includes(w), `${s.fileName} 含品牌词 ${w}`).toBe(false);
      const file = path.join(dir, s.fileName);
      fs.writeFileSync(file, r.source, 'utf8');
      expect(fs.readFileSync(file, 'utf8')).toBe(r.source);     // 落盘内容 == 内存生成内容
      expect(buildLabelSpike(s).source).toBe(r.source);         // 二次生成无漂移
    }
    /* 单一变量对照：A 无前缀无 tooltip → B 加分组前缀 → C 再加 tooltip（数学与参数完全相同） */
    const [a, b, c] = LABEL_SPIKE_SAMPLES.map((s) => buildLabelSpike(s).source);
    expect(srcLabels(a).map((l) => l.label)).toEqual(['对比度 Contrast', '混合 Mix', '开关 Enable']);
    expect(countOf(a, /^[ \t]*DEFINE_UI_TOOLTIP\s*\(/gm)).toBe(0);
    expect(srcLabels(b).map((l) => l.label)).toEqual(['光晕-强度 Halation Amount', '光晕-混合 Halation Mix', '光晕-开关 Halation On']);
    expect(countOf(b, /^[ \t]*DEFINE_UI_TOOLTIP\s*\(/gm)).toBe(0);
    expect(countOf(c, /^[ \t]*DEFINE_UI_TOOLTIP\s*\(/gm)).toBe(3);
    expect(srcLabels(c)).toEqual(srcLabels(b));                  // C = B + tooltip，标签写法不变
    expect(c).toContain('DEFINE_UI_TOOLTIP(光晕-强度 Halation Amount, "');
    // 三份文件的数学与参数区完全一致（只差标签/tooltip），且都是 3 参数
    const stripParamSection = (src: string): string => src.split('// ---- 数学')[1];
    expect(stripParamSection(a)).toBe(stripParamSection(b));
    expect(stripParamSection(b)).toBe(stripParamSection(c));
  });

  it('26. 参数预算：生成器参数总数 ≤ 64（DCTL 每类 UI 参数上限），且文案表无品牌词', () => {
    for (const tf of ['yrgb', 'rcm', 'aces'] as const) {
      const r = generateDctl(makeInput(tf));
      expect(r.params.length, `${tf} 参数数`).toBeLessThanOrEqual(64);
      expect(countOf(r.source, /^[ \t]*DEFINE_UI_PARAMS\s*\(/gm)).toBe(r.params.length);
    }
    const n = generateDctl(makeInput('yrgb')).params.length;
    expect(n).toBeGreaterThanOrEqual(40);   // R21 起 53（R7 带 match 时 64，恰好打满 ≤64 上限）
    for (const [macro, t] of Object.entries(PARAM_TEXT)) {
      for (const w of BRAND_WORDS) {
        expect(t.tip.includes(w), `${macro} 中文说明含品牌词 ${w}`).toBe(false);
        expect(t.tipEn.includes(w), `${macro} 英文说明含品牌词 ${w}`).toBe(false);
        expect(t.en.includes(w), `${macro} 英文名含品牌词 ${w}`).toBe(false);
      }
    }
  });
});

/* ---- R7：单节点导出（把 R3 的 CDL 匹配段内联进 DCTL）----
 * 目标：一个节点完成「匹配 + look + 质感」。信号链
 *   `采样 → 匹配（显示域 CDL）→ tf_encode → 对数域 look → 质感层 → tf_decode`。
 * 四条不变量在这里钉死：
 *   ① 系数逐位一致（验收②）：11 个 FM_MATCH_* 的默认值/范围与传入 CDL / CDL_RANGES 对齐；
 *   ② 参数面：49 → 60（= 49 + 11），validateDctl 的 64 上限规则不变；
 *   ③ 作用域红线：FM_MATCH_* 只出现在 transform 内（helper 里读参数是达芬奇闪退根因）；
 *   ④ 默认值恒等：不传 match（或 stages.match=false）时产物与 R6 逐字节一致。 */

/** 一组真实量级的 CDL（6 位小数，正好检验写出精度） */
const MATCH_CDL: Cdl = {
  slope: [1.123456, 0.945678, 1.312345],
  offset: [-0.023456, 0.005678, 0.031234],
  power: [0.954321, 1.056789, 1.183456],
  sat: 1.234567,
};

/** 带匹配段的生成输入（默认 compat，与已实测可加载的样例同形） */
function matchInput(extra: Partial<DctlGenInput> = {}): DctlGenInput {
  return { ...makeInput('yrgb'), compat: true, match: { cdl: MATCH_CDL, enabled: true }, ...extra };
}

/** 从源码里读回浮点参数的默认值/上下限（DEFINE_UI_PARAMS 的第 4/5/6 个实参） */
function srcFloatDecl(source: string, macro: string): { def: number; min: number; max: number } | null {
  const re = new RegExp(
    `DEFINE_UI_PARAMS\\(${macro}\\s*,\\s*[^,]*,\\s*DCTLUI_SLIDER_FLOAT\\s*,`
    + `\\s*(-?[\\d.]+)f\\s*,\\s*(-?[\\d.]+)f\\s*,\\s*(-?[\\d.]+)f\\s*,`,
  );
  const m = re.exec(source);
  return m ? { def: parseFloat(m[1]), min: parseFloat(m[2]), max: parseFloat(m[3]) } : null;
}

/** 11 个匹配参数（宏名 → 期望值 / 期望区间） */
const MATCH_FLOATS: Array<[string, number, [number, number]]> = [
  ['FM_MATCH_SLOPE_R', MATCH_CDL.slope[0], CDL_RANGES.slope],
  ['FM_MATCH_SLOPE_G', MATCH_CDL.slope[1], CDL_RANGES.slope],
  ['FM_MATCH_SLOPE_B', MATCH_CDL.slope[2], CDL_RANGES.slope],
  ['FM_MATCH_OFFSET_R', MATCH_CDL.offset[0], CDL_RANGES.offset],
  ['FM_MATCH_OFFSET_G', MATCH_CDL.offset[1], CDL_RANGES.offset],
  ['FM_MATCH_OFFSET_B', MATCH_CDL.offset[2], CDL_RANGES.offset],
  ['FM_MATCH_POWER_R', MATCH_CDL.power[0], CDL_RANGES.power],
  ['FM_MATCH_POWER_G', MATCH_CDL.power[1], CDL_RANGES.power],
  ['FM_MATCH_POWER_B', MATCH_CDL.power[2], CDL_RANGES.power],
  ['FM_MATCH_SAT', MATCH_CDL.sat, CDL_RANGES.sat],
];

describe('R7 匹配段：系数与参数面', () => {
  it('27. 系数逐位内联（验收②）：默认值与传入 CDL 差 < 1e-6；范围与 CDL_RANGES 逐值相等', () => {
    const r = generateDctl(matchInput());
    for (const [macro, want, [lo, hi]] of MATCH_FLOATS) {
      const got = srcFloatDecl(r.source, macro);
      expect(got, `${macro} 在源码里没找到浮点声明`).not.toBeNull();
      expect(Math.abs(got!.def - want), `${macro} 默认值 ${got!.def} vs ${want}`).toBeLessThan(1e-6);
      expect(got!.min, `${macro} 下限`).toBe(lo);
      expect(got!.max, `${macro} 上限`).toBe(hi);
      /* 声明表（面板/UI 用的那份）同样对齐，且 6 位小数写出 */
      const decl = r.params.find((p) => p.macro === macro)!;
      expect(decl.group).toBe('match');
      expect(decl.type).toBe('float');
      expect(decl.decimals).toBe(6);
      expect(decl.min).toBe(lo);
      expect(decl.max).toBe(hi);
      expect(decl.def).toBeCloseTo(want, 9);
    }
    /* 总开关：bool，默认开（enabled: true） */
    const on = r.params.find((p) => p.macro === 'FM_MATCH_ON')!;
    expect(on.type).toBe('bool');
    expect(on.def).toBe(true);
    expect(on.group).toBe('match');
    // 显式关掉默认开关：默认值随 enabled 走
    expect(generateDctl(matchInput({ match: { cdl: MATCH_CDL, enabled: false } })).params
      .find((p) => p.macro === 'FM_MATCH_ON')!.def).toBe(false);
  });

  it('27b. 越界/非有限 CDL 按导出通道同一规则收敛（clampCdl），并在 warnings 里说明', () => {
    const wild = { slope: [3, 0.1, 1] as [number, number, number], offset: [-0.5, 0, 0] as [number, number, number], power: [1, 1, 1] as [number, number, number], sat: 9 };
    const r = generateDctl(matchInput({ match: { cdl: wild, enabled: true } }));
    const slopeR = srcFloatDecl(r.source, 'FM_MATCH_SLOPE_R')!;
    expect(slopeR.def).toBe(CDL_RANGES.slope[1]);          // 3 → 2
    expect(srcFloatDecl(r.source, 'FM_MATCH_SLOPE_G')!.def).toBe(CDL_RANGES.slope[0]);   // 0.1 → 0.5
    expect(srcFloatDecl(r.source, 'FM_MATCH_OFFSET_R')!.def).toBe(CDL_RANGES.offset[0]); // -0.5 → -0.1
    expect(srcFloatDecl(r.source, 'FM_MATCH_SAT')!.def).toBe(CDL_RANGES.sat[1]);         // 9 → 2
    expect(r.warnings.some((w) => w.includes('收敛'))).toBe(true);
    expect(validateDctl(r.source).ok).toBe(true);
    // 合法输入不该出现这条告警
    expect(generateDctl(matchInput()).warnings.some((w) => w.includes('收敛'))).toBe(false);
  });

  it('28. 参数面：有 match 时 64（53 + 11）；textureParamDecls 仍 53；无 match 仍 53；恰好打满 64 上限', () => {
    const input = makeInput('yrgb');
    const ref = textureParamDecls(input.texture, input.look, input.resolution!);
    expect(ref.length).toBe(53);
    expect(textureParamDecls(input.texture, input.look, input.resolution!).length).toBe(53);   // 不因 match 变化

    const noMatch = generateDctl(input);
    expect(noMatch.params.length).toBe(53);
    expect(noMatch.params.some((p) => p.macro.startsWith('FM_MATCH_'))).toBe(false);

    const withMatch = generateDctl(matchInput());
    expect(withMatch.params.length).toBe(64);
    expect(withMatch.params.length).toBe(ref.length + matchParamDecls({ cdl: MATCH_CDL }).length);
    expect(countOf(withMatch.source, /^[ \t]*DEFINE_UI_PARAMS\s*\(/gm)).toBe(64);
    expect(withMatch.params.length).toBeLessThanOrEqual(64);
    expect(validateDctl(withMatch.source).ok, validateDctl(withMatch.source).errors.join('；')).toBe(true);
    // 宏名唯一（64 个全不同）
    expect(new Set(withMatch.params.map((p) => p.macro)).size).toBe(64);
  });

  it('28b. 匹配参数标签：中文 + 英文名 + 「匹配-」前缀，且无括号/方括号/逗号', () => {
    const r = generateDctl(matchInput({ compat: false }));
    for (const l of srcLabels(r.source).filter((x) => x.macro.startsWith('FM_MATCH_'))) {
      const p = r.params.find((x) => x.macro === l.macro)!;
      expect(l.label.startsWith(GROUP_PREFIX.match), `${l.macro} 缺匹配前缀：${l.label}`).toBe(true);
      expect(hasCJK(l.label)).toBe(true);
      expect(l.label.includes(p.en)).toBe(true);
      expect(/[()\[\],]/.test(l.label), `${l.label} 含非法字符`).toBe(false);
      const t = PARAM_TEXT[l.macro];
      expect(t).toBeDefined();
      expect(/[()\[\],]/.test(t.tip)).toBe(false);
      expect(/[()\[\],]/.test(t.tipEn)).toBe(false);
    }
    // 兼容模式：全 ASCII 标签，且仍是 11 个
    const compat = generateDctl(matchInput());
    const ascii = srcLabels(compat.source).filter((x) => x.macro.startsWith('FM_MATCH_'));
    expect(ascii.length).toBe(11);
    for (const l of ascii) expect(hasCJK(l.label)).toBe(false);
    expect(ascii.find((l) => l.macro === 'FM_MATCH_SLOPE_R')!.label).toBe('Match Slope R');
    // 两种形态（标准 + tooltip / 兼容）都必须过静态校验（64 参数 + tooltip 逐条配对）
    expect(validateDctl(r.source).ok, validateDctl(r.source).errors.join('；')).toBe(true);
    expect(validateDctl(compat.source).ok, validateDctl(compat.source).errors.join('；')).toBe(true);
    expect(countOf(r.source, /^[ \t]*DEFINE_UI_TOOLTIP\s*\(/gm)).toBe(64);
  });
});

describe('R7 匹配段：源码结构与作用域', () => {
  it('29. 结构齐备（FmMatchParams / fm_apply_cdl / fm_cdl_ch）且 FM_MATCH_* 只出现在 transform 内', () => {
    const r = generateDctl(matchInput());
    expect(r.source).toContain('typedef struct { float sr, sg, sb, ofr, ofg, ofb, pr, pg, pb, sat; } FmMatchParams;');
    expect(r.source).toContain('fm_apply_cdl');
    expect(r.source).toContain('fm_cdl_ch');
    expect(r.source).toContain('src = fm_apply_cdl(src, mp);');
    expect(r.source).toContain('_powf(base, p)');            // 官方清单函数，ACES 背书
    expect(validateDctl(r.source).ok, validateDctl(r.source).errors.join('；')).toBe(true);
    /* helper 里不许出现 FM_*（达芬奇闪退根因）——validateDctl 已有规则，这里断言它真的没报 */
    expect(validateDctl(r.source).errors.filter((e) => e.includes('UI 参数'))).toEqual([]);
    expect(validateDctl(r.source).errors.filter((e) => e.includes('未声明的参数宏'))).toEqual([]);
    /* 每个 FM_MATCH_* 除声明外必须在 transform 里被读到（否则是死参数） */
    for (const p of r.params.filter((x) => x.macro.startsWith('FM_MATCH_'))) {
      expect(countOf(r.source, new RegExp(`\\b${p.macro}\\b`, 'g')), `${p.macro} 未被使用`).toBeGreaterThan(1);
    }
    /* 每个顶层函数都有 __DEVICE__（含新 helper） */
    for (const fn of ['fm_cdl_ch', 'fm_apply_cdl']) {
      expect(new RegExp(`__DEVICE__[^\\n]*\\b${fn}\\s*\\(`).test(r.source), `${fn} 缺 __DEVICE__`).toBe(true);
    }
  });

  it('30. 匹配段位置：在 src 采样之后、tf_encode 之前（与网页端作用顺序一致）', () => {
    const { source } = generateDctl(matchInput());
    const iSrc = source.indexOf('float3 src = make_float3');
    const iApply = source.indexOf('src = fm_apply_cdl(src, mp);');
    const iEncode = source.indexOf('fm_tf_encode(src.x)');
    expect(iSrc).toBeGreaterThan(0);
    expect(iApply).toBeGreaterThan(iSrc);
    expect(iEncode).toBeGreaterThan(iApply);
  });

  it('31. 文件头注释与 warnings：内联 CDL 说明 + 「CDL 是近似」的诚实边界', () => {
    const r = generateDctl(matchInput());
    expect(r.source).toContain('// 匹配段：内联 CDL（与 R3 导出系数一致，可在面板微调）');
    expect(r.warnings.some((w) => w.includes('CDL 是对完整匹配变换的近似，与网页端 engine 匹配存在数值差'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('换镜头'))).toBe(true);
    // 不传 match：既不写这行文件头，也不出这条告警
    const plain = generateDctl(makeInput('yrgb'));
    expect(plain.source.includes('匹配段')).toBe(false);
    expect(plain.warnings.some((w) => w.includes('CDL 是对完整匹配变换的近似'))).toBe(false);
  });

  it('32. stages.match=false：参数与代码同时裁剪，且产物与「不传 match」逐字节一致', () => {
    /* 同形态对照：compat 与 matchInput 一致（只差 match 本身） */
    const plain = generateDctl({ ...makeInput('yrgb'), compat: true }).source;
    const off = generateDctl(matchInput({ stages: { match: false } }));
    expect(off.source.includes('FM_MATCH')).toBe(false);
    expect(off.source.includes('FmMatchParams')).toBe(false);
    expect(off.source.includes('fm_apply_cdl')).toBe(false);
    expect(off.params.some((p) => p.macro.startsWith('FM_MATCH_'))).toBe(false);
    expect(off.params.length).toBe(53);
    expect(off.source).toBe(plain);                 // 面板与代码同进同退 → 与 R6 形态逐字节一致
    expect(validateDctl(off.source).ok).toBe(true);
    // 只裁匹配、质感层仍在
    expect(off.source).toContain('FM_HALATION_AMOUNT');
    // 不传 match 时显式 stages.match: true/false 都不影响产物
    expect(generateDctl({ ...makeInput('yrgb'), compat: true, stages: { match: true } }).source).toBe(plain);
    expect(generateDctl({ ...makeInput('yrgb'), compat: true, stages: { match: false } }).source).toBe(plain);
  });

  it('33. 16 种质感层组合 × 匹配段：静态校验通过、尾部完整、无残留层标记', () => {
    const combos = [false, true].flatMap((halation) =>
      [false, true].flatMap((bloom) =>
        [false, true].flatMap((grain) =>
          [false, true].map((vignette) => ({ halation, bloom, grain, vignette })))));
    expect(combos.length).toBe(16);
    for (const stages of combos) {
      const tag = JSON.stringify(stages);
      const { source } = generateDctl(matchInput({ stages }));
      const v = validateDctl(source);
      expect(v.errors, `${tag}：${v.errors.join('；')}`).toEqual([]);
      expect(source, `${tag}：缺匹配段`).toContain('src = fm_apply_cdl(src, mp);');
      expect(source, `${tag}：缺顶层 return`).toMatch(/^[ \t]*return make_float3\(/m);
      expect(source.trimEnd().endsWith('}'), `${tag}：结尾不是 }`).toBe(true);
      expect(source, `${tag}：残留层标记`).not.toMatch(/>>>STAGE|<<<STAGE/);
    }
  });

  it('33b. 无分支模式（branchless）下匹配段仍合法：按开关在源/匹配之间混合', () => {
    const r = generateDctl(matchInput({ branchless: true }));
    expect(r.source).toContain('src = fm_mix3(src, fm_apply_cdl(src, mp), matchOn);');
    expect(validateDctl(r.source).ok, validateDctl(r.source).errors.join('；')).toBe(true);
    // 无分支模式下质感层的既有写法不变（回归）
    expect(r.source).toContain('grainOn');
  });
});

describe('R7 匹配段样例产物', () => {
  it('34. MATCH_SAMPLES：可生成、静态校验通过、含匹配段与 CDL 系数、落盘且二次生成无漂移', async () => {
    expect(MATCH_SAMPLES.length).toBe(1);
    const fs = await nodeMod('node:fs');
    const path = await nodeMod('node:path');
    const url = await nodeMod('node:url');
    const dir = url.fileURLToPath(new URL('../../tools/dctl-samples/', import.meta.url));
    fs.mkdirSync(dir, { recursive: true });
    for (const s of MATCH_SAMPLES) {
      const r = buildMatchSample(s);
      expect(r.params.length).toBe(64);
      const v = validateDctl(r.source);
      expect(v.ok, `${s.fileName}: ${v.errors.join('；')}`).toBe(true);
      expect(r.source).toContain('// 匹配段：内联 CDL（与 R3 导出系数一致，可在面板微调）');
      expect(r.source).toContain('src = fm_apply_cdl(src, mp);');
      for (const w of BRAND_WORDS) expect(r.source.includes(w), `${s.fileName} 含品牌词 ${w}`).toBe(false);
      /* 系数是现场解算的（不是硬编码魔数）：与 fitCdl 直算结果逐位一致，且落在各自区间内 */
      const cdl = solvedSampleCdl();
      const pairs: Array<[string, number, [number, number]]> = [
        ['FM_MATCH_SLOPE_R', cdl.slope[0], CDL_RANGES.slope],
        ['FM_MATCH_SLOPE_G', cdl.slope[1], CDL_RANGES.slope],
        ['FM_MATCH_SLOPE_B', cdl.slope[2], CDL_RANGES.slope],
        ['FM_MATCH_OFFSET_R', cdl.offset[0], CDL_RANGES.offset],
        ['FM_MATCH_OFFSET_G', cdl.offset[1], CDL_RANGES.offset],
        ['FM_MATCH_OFFSET_B', cdl.offset[2], CDL_RANGES.offset],
        ['FM_MATCH_POWER_R', cdl.power[0], CDL_RANGES.power],
        ['FM_MATCH_POWER_G', cdl.power[1], CDL_RANGES.power],
        ['FM_MATCH_POWER_B', cdl.power[2], CDL_RANGES.power],
        ['FM_MATCH_SAT', cdl.sat, CDL_RANGES.sat],
      ];
      for (const [macro, want, [lo, hi]] of pairs) {
        expect(Math.abs(srcFloatDecl(r.source, macro)!.def - want), `${macro} 默认值`).toBeLessThan(1e-6);
        expect(want, `${macro} 解算结果越界`).toBeGreaterThanOrEqual(lo);
        expect(want, `${macro} 解算结果越界`).toBeLessThanOrEqual(hi);
      }
      /* 总开关默认开（compat 下写成 0/1 浮点滑杆，故断言声明表而不是浮点写法） */
      expect(r.params.find((p) => p.macro === 'FM_MATCH_ON')!.def).toBe(true);
      /* R14：样例改用产品默认形态（中英混排 + tooltip；标签已实机验证），开关仍是已验证的 0/1 滑杆 */
      expect(r.source).toContain('DEFINE_UI_PARAMS(FM_MATCH_ON, 匹配-开关 Match On, DCTLUI_SLIDER_FLOAT, 1, 0, 1, 1)');
      const file = path.join(dir, s.fileName);
      fs.writeFileSync(file, r.source, 'utf8');
      expect(fs.readFileSync(file, 'utf8')).toBe(r.source);
      expect(buildMatchSample(s).source).toBe(r.source);
    }
  });
});

/* ================= R8 · Schema v1.2 分离色调（DCTL 镜像） =================
 * 四处镜像的最后一条：DCTL 源码必须带 5 个 FM_SPLIT_* 参数、静态校验通过、
 * helper（fm_log_look）里不许直接读参数（达芬奇闪退根因），标签文案齐备。 */
describe('R8 DCTL 分离色调', () => {
  const SPLIT_MACROS = [
    'FM_SPLIT_SHADOW_HUE', 'FM_SPLIT_SHADOW_SAT', 'FM_SPLIT_HIGHLIGHT_HUE',
    'FM_SPLIT_HIGHLIGHT_SAT', 'FM_SPLIT_BALANCE',
  ];

  it('49（无 match）/ 64（含 match）参数；5 个 FM_SPLIT_* 齐备且 group=look；validateDctl 通过', () => {
    const plain = generateDctl(makeInput('yrgb'));
    expect(plain.params.length).toBe(53);
    const withMatch = generateDctl(matchInput());
    expect(withMatch.params.length).toBe(64);
    for (const r of [plain, withMatch]) {
      expect(validateDctl(r.source).ok, validateDctl(r.source).errors.join('；')).toBe(true);
      for (const m of SPLIT_MACROS) {
        const p = r.params.find((x) => x.macro === m);
        expect(p, `${m} 缺失`).toBeDefined();
        expect(p!.group).toBe('look');
        expect(p!.type).toBe('float');
        // 默认值 = 中性（0；平衡也是 0）
        expect(p!.def).toBe(0);
        expect(countOf(r.source, new RegExp(`\\b${m}\\b`, 'g')), `${m} 未被使用`).toBeGreaterThan(1);
      }
      // 区间：色相/饱和 0..1，平衡 -1..1
      expect(plain.params.find((p) => p.macro === 'FM_SPLIT_BALANCE')!.min).toBe(-1);
      expect(plain.params.find((p) => p.macro === 'FM_SPLIT_BALANCE')!.max).toBe(1);
      expect(plain.params.find((p) => p.macro === 'FM_SPLIT_SHADOW_HUE')!.min).toBe(0);
      expect(plain.params.find((p) => p.macro === 'FM_SPLIT_SHADOW_HUE')!.max).toBe(1);
    }
  });

  it('源码结构：fm_split_dir helper + FmLookParams 的 split 字段 + 权重曲线同式（sat=0 贡献为 0）', () => {
    const { source } = generateDctl(makeInput('rcm'));
    expect(source).toContain('float3 fm_split_dir(float h)');
    expect(source).toContain('typedef struct { float crosstalk, shadow_bias, highlight_bias, fade, saturation, warmth, split_sh_hue, split_sh_sat, split_hi_hue, split_hi_sat, split_balance; } FmLookParams;');
    expect(source).toContain('float spWS = sh * (1.0f - 0.5f * spB);');
    expect(source).toContain('float spWH = hi * (1.0f + 0.5f * spB);');
    // 叠加常数 0.2（== engine SPLIT_SCALE），且按饱和度缩放（sat=0 → 贡献 0）
    expect(source).toContain('float sss = 0.2f * lp.split_sh_sat * spWS;');
    expect(source).toContain('float shs = 0.2f * lp.split_hi_sat * spWH;');
    // 色相轮零亮度方向同式
    expect(source).toContain('float ll = 0.2126f * rr + 0.7152f * gg + 0.0722f * bb;');
    expect(source).toContain('return make_float3(rr - ll, gg - ll, bb - ll);');
  });

  it('作用域红线：FM_SPLIT_* 只出现在 transform 内（helper 里读参数会闪退）', () => {
    const { source } = generateDctl(makeInput('yrgb'));
    // validateDctl 的「UI 参数进 helper」规则不得对分离色调报错
    const errs = validateDctl(source).errors;
    expect(errs.filter((e) => e.includes('UI 参数'))).toEqual([]);
    expect(errs.filter((e) => e.includes('未声明的参数宏'))).toEqual([]);
    // 直接切出 helper 函数体：fm_log_look / fm_split_dir 内不得出现 FM_SPLIT_*
    const bodyOf = (name: string): string => {
      const i = source.indexOf(name + '(');
      if (i < 0) return '';
      const start = source.indexOf('{', i);
      let depth = 0;
      for (let j = start; j < source.length; j++) {
        if (source[j] === '{') depth++;
        else if (source[j] === '}') { depth--; if (depth === 0) return source.slice(start, j + 1); }
      }
      return '';
    };
    for (const fn of ['fm_log_look', 'fm_split_dir']) {
      const body = bodyOf(fn);
      expect(body.length).toBeGreaterThan(0);
      expect(/FM_SPLIT_/.test(body), `${fn} 里出现了 FM_SPLIT_*`).toBe(false);
    }
    // 参数只在 transform 内打包进结构体
    expect(source).toContain('lp.split_sh_hue = FM_SPLIT_SHADOW_HUE;');
    expect(source).toContain('lp.split_balance = FM_SPLIT_BALANCE;');
  });

  it('标签文案齐备（中/英/tip 无括号方括号逗号），标准模式与 compat 模式都通过校验', () => {
    for (const m of SPLIT_MACROS) {
      const t = PARAM_TEXT[m];
      expect(t, `${m} 缺文案`).toBeDefined();
      expect(t.cn.length).toBeGreaterThan(0);
      expect(t.en.length).toBeGreaterThan(0);
      expect(t.tip.length).toBeGreaterThan(0);
      expect(t.tipEn.length).toBeGreaterThan(0);
      expect(t.group).toBe('look');
      expect(/[()\[\],]/.test(t.tip), `${m} 中文说明含非法字符`).toBe(false);
      expect(/[()\[\],]/.test(t.tipEn ?? ''), `${m} 英文说明含非法字符`).toBe(false);
    }
    const std = generateDctl(makeInput('yrgb'));
    for (const m of SPLIT_MACROS) {
      const p = std.params.find((x) => x.macro === m)!;
      expect(/[()\[\],]/.test(p.label), `${m} 标签含非法字符：${p.label}`).toBe(false);
      expect(hasCJK(p.label)).toBe(true);
      expect(p.label.includes(p.en)).toBe(true);
    }
    expect(validateDctl(generateDctl({ ...makeInput('yrgb'), compat: true }).source).ok).toBe(true);
    expect(validateDctl(std.source).ok).toBe(true);
  });
});

/* ================= R9 · 质感深度（DCTL 侧） =================
 * 四项：① 动态颗粒（TIMELINE_FRAME_INDEX 相位，dynamicGrain 默认 true / false 回退静态）；
 *      ② 采样预算 84 → 30（邻域 tap 改单通道亮度代理）；③ 片门抖动（gate_weave 层）；
 *      ④ 扫描颗粒团簇（FM_GRAIN_CLUSTER）。
 * 红线：TIMELINE_FRAME_INDEX 与 UI 参数一样只在 transform() 内可见；helper 里不得出现 FM_*。 */

/** 切出某个顶层函数的函数体（先剥注释/字符串，避免注释里的宏名/帧索引干扰扫描） */
function fnBody(source: string, name: string): string {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const i = code.search(new RegExp(`\\b${name}\\s*\\(`));
  if (i < 0) return '';
  const start = code.indexOf('{', i);
  let depth = 0;
  for (let j = start; j < code.length; j++) {
    if (code[j] === '{') depth++;
    else if (code[j] === '}') { depth--; if (depth === 0) return code.slice(start, j + 1); }
  }
  return '';
}

/** 源码里所有顶层 __DEVICE__ 函数名（transform 也含在内） */
function topFnNames(source: string): string[] {
  const code = source.replace(/\/\/[^\n]*/g, '');
  return [...code.matchAll(/^__DEVICE__\s+[A-Za-z0-9_]+\s+([A-Za-z_]\w*)\s*\(/gm)].map((m) => m[1]);
}

describe('R9 DCTL 质感深度', () => {
  const R9_MACROS = ['FM_GRAIN_CLUSTER', 'FM_GATE_WEAVE_PX', 'FM_GATE_WEAVE_SPEED'];
  /* R8 基线：3 次 src + 紧/宽晕各 9 tap × 3 通道 + 柔光 9 tap × 3 通道 = 84（历史口径，见 R9 报告）
   * R12–R20 为 36；R21 双环 + 逐 tap look = 108（有意变更，见测试 51 与对齐清单 v2）。 */
  const R8_TEX2D = 3 + 9 * 3 * 2 + 9 * 3;

  it('50. 参数总数：无 match 53（50 + 3）、含 match 64 打满上限；3 个新参数齐备且默认/区间正确', () => {
    const plain = generateDctl(makeInput('yrgb'));
    expect(plain.params.length).toBe(53);
    expect(plain.params.length).toBe(49 + 3 + 1);   // R8 基线 49 + 团簇/片门 3 + R21 master 1 = 53
    const withMatch = generateDctl(matchInput());
    expect(withMatch.params.length).toBe(64);
    expect(withMatch.params.length).toBeLessThanOrEqual(64);
    expect(validateDctl(withMatch.source).ok, validateDctl(withMatch.source).errors.join('；')).toBe(true);

    for (const m of R9_MACROS) {
      expect(plain.params.find((p) => p.macro === m), `${m} 缺失`).toBeDefined();
    }
    // 团簇：0..1，默认 = grain.cluster（预设 fl06 为 0）
    const cluster = plain.params.find((p) => p.macro === 'FM_GRAIN_CLUSTER')!;
    expect(cluster.group).toBe('grain');
    expect(cluster.type).toBe('float');
    expect(cluster.min).toBe(0);
    expect(cluster.max).toBe(1);
    expect(cluster.def).toBe(0);
    // 片门抖动：int px 0..40（默认 round(amount*H)，amount=0 → 0）；speed 0..4 默认 1
    const wpx = plain.params.find((p) => p.macro === 'FM_GATE_WEAVE_PX')!;
    const wspd = plain.params.find((p) => p.macro === 'FM_GATE_WEAVE_SPEED')!;
    expect([wpx.group, wspd.group]).toEqual(['gate_weave', 'gate_weave']);
    expect(wpx.type).toBe('int');
    expect([wpx.min, wpx.max, wpx.def]).toEqual([0, 40, 0]);
    expect(wspd.type).toBe('float');
    expect([wspd.min, wspd.max, wspd.def]).toEqual([0, 4, 1]);
    // amount>0 的预设：默认 = round(amount*H)
    const card = getPreset('fl06');
    const tex2 = { ...card.params.texture, gate_weave: { amount: 0.02, speed: 2 } };
    const decls = textureParamDecls(tex2, lookToLogLook(card.params.look, 'yrgb'), { w: 1920, h: 1080 });
    expect(decls.find((d) => d.macro === 'FM_GATE_WEAVE_PX')!.def).toBe(Math.round(0.02 * 1080));
    expect(decls.find((d) => d.macro === 'FM_GATE_WEAVE_SPEED')!.def).toBe(2);
  });

  it('51. 采样预算：R21 双环 + 逐 tap look = 108 次（3 src + 78 光晕 + 27 柔光；R12–R20 为 36）', () => {
    /* R21 有意变更（用户实机 veil 修复）：36 → 108。构成 = 3(src) + 27(紧晕 9tap×RGB)
     * + 51(宽晕 17tap×RGB) + 27(柔光 9tap×RGB)。真实 GPU 无压力（84 次时代实测约 140fps）。 */
    const n = countOf(generateDctl(makeInput('yrgb')).source, /_tex2D/g);
    expect(n).toBe(108);
    /* R14：真正的「只导出色彩层」（质感层 + 片门抖动全关）改用逐像素签名，不再有任何 _tex2D */
    const colorOnly = generateDctl({
      ...makeInput('yrgb'), compat: true,
      stages: { halation: false, bloom: false, grain: false, vignette: false, gate_weave: false },
    }).source;
    expect(countOf(colorOnly, /_tex2D/g)).toBe(0);
  });

  it('51b. R21 tap 结构：光晕=紧晕 3×3 + 宽晕双环（RGB 逐 tap look + max3 亮通）；柔光=双环彩色累积 + 亮度亮通', () => {
    const { source, warnings } = generateDctl(makeInput('yrgb'));
    const slice = (a: string, b: string): string => {
      const i = source.indexOf(a);
      const j = source.indexOf(b, i + 1);
      return i < 0 || j < 0 ? '' : source.slice(i, j);
    };
    const bloom = slice('// ---- 柔光 bloom', '// ---- 暗角');
    const hal = slice('// ---- 光晕：紧晕 3×3', '// ---- 柔光 bloom');
    expect(bloom.length, '柔光块切不出来').toBeGreaterThan(0);
    expect(hal.length, '光晕块切不出来').toBeGreaterThan(0);
    /* 光晕：紧晕 9 tap + 宽晕内环 9 + 外环 8 = 26 tap × RGB = 78 次；三通道各 26 */
    expect(countOf(hal, /_tex2D\(/g), '光晕 _tex2D 次数').toBe(78);
    expect(countOf(hal, /_tex2D\(p_TexR,/g)).toBe(26);
    expect(countOf(hal, /_tex2D\(p_TexG,/g)).toBe(26);
    expect(countOf(hal, /_tex2D\(p_TexB,/g)).toBe(26);
    /* 逐 tap look：每个 tap 都先过 fm_tap_look（26 处），光晕亮通按最大通道（网页 useMax=1） */
    expect(countOf(hal, /fm_tap_look\(/g)).toBe(26);
    expect(countOf(hal, /fm_max3\(lk\)/g)).toBe(26);
    /* 双环几何：运行时半径 rt/rw + 外环 2*rw，且外环不重复采中心（宽晕 17 tap） */
    expect(hal).toContain('int rt = fm_iround((float)FM_HALATION_TIGHT_PX * hs);');
    expect(hal).toContain('int rw = fm_iround((float)FM_HALATION_RADIUS_PX * hs);');
    expect(hal).toContain('cx + (1 * 2 * rw)');
    expect(countOf(hal, /= fm_iround\(/g)).toBe(2);   // 只有 rt/rw 两处运行时半径（柔光的 rb 在 bloom 块）
    /* 柔光：中心 + 4@rb + 4@2rb = 9 tap × RGB = 27 次；亮通按亮度（网页 useMax=0） */
    expect(countOf(bloom, /_tex2D\(/g), '柔光 _tex2D 次数').toBe(27);
    for (const ch of ['R', 'G', 'B']) expect(countOf(bloom, new RegExp(`_tex2D\\(p_Tex${ch},`, 'g'))).toBe(9);
    expect(countOf(bloom, /fm_tap_look\(/g)).toBe(9);
    expect(countOf(bloom, /fm_luma\(lk\)/g)).toBe(9);
    expect(bloom).toContain('int rb = fm_iround((float)FM_BLOOM_RADIUS_PX * hs);');
    expect(bloom).toContain('cx + (1 * 2 * rb)');
    expect(bloom, '彩色累积后必须仍走饱和度/亮度控制').toContain('fm_luma(blm)');
    expect(bloom).toContain('FM_BLOOM_SATURATION');
    /* 文件头注释 + warnings 如实说明两条链路的色度处理与差异清单位置 */
    expect(source).toContain('亮通阈值作用于 look 后的邻域值');
    const w = warnings.join('\n');
    expect(w).toContain('双环结构');
    expect(w).toContain('每 tap 读 RGB 并过完整 look');
    expect(w).toContain('docs/research/观感对齐清单-R9.md');
  });

  it('52. 动态颗粒：默认含 TIMELINE_FRAME_INDEX 且只在 transform 内；dynamicGrain:false 不含帧索引', () => {
    const dyn = generateDctl(makeInput('yrgb')).source;
    expect(dyn).toContain('TIMELINE_FRAME_INDEX');
    // 帧索引只在 transform 函数体内：逐 helper 函数体扫描，除 transform 外一律不得出现
    const names = topFnNames(dyn);
    expect(names).toContain('transform');
    expect(names.length).toBeGreaterThan(5);
    for (const fn of names) {
      if (fn === 'transform') continue;
      expect(fnBody(dyn, fn), `helper ${fn} 里出现了 TIMELINE_FRAME_INDEX`).not.toContain('TIMELINE_FRAME_INDEX');
    }
    expect(fnBody(dyn, 'transform')).toContain('TIMELINE_FRAME_INDEX');
    expect(validateDctl(dyn).ok, validateDctl(dyn).errors.join('；')).toBe(true);

    // 静态回退：产物不含帧索引，且与默认产物不同
    const stat = generateDctl({ ...makeInput('yrgb'), dynamicGrain: false }).source;
    expect(stat).not.toContain('TIMELINE_FRAME_INDEX');
    expect(stat).not.toBe(dyn);
    expect(validateDctl(stat).ok, validateDctl(stat).errors.join('；')).toBe(true);
    // 静态形态与 R8 的颗粒表达式一致（无 jx/jy 相位扰动）
    expect(stat).toContain('float gx = (float)p_X / grainPx;');
    expect(stat).not.toContain('float jx =');
  });

  it('53. 片门抖动：gate_weave 层裁剪时参数与代码同时消失；关闭时不出现 FM_GATE_WEAVE', () => {
    const on = generateDctl(makeInput('yrgb')).source;
    expect(on).toContain('FM_GATE_WEAVE_PX');
    expect(on).toContain('FM_GATE_WEAVE_SPEED');
    const off = generateDctl({ ...makeInput('yrgb'), stages: { gate_weave: false } });
    expect(off.source.includes('FM_GATE_WEAVE')).toBe(false);
    expect(off.params.some((p) => p.macro.startsWith('FM_GATE_WEAVE_'))).toBe(false);
    expect(off.params.length).toBe(51);          // 53 - 2
    expect(validateDctl(off.source).ok, validateDctl(off.source).errors.join('；')).toBe(true);
    // 关闭时不残留未声明的 wx/wy 引用（恒等：cx/cy 回落到 p_X/p_Y）
    expect(off.source).toContain('int cx = fm_clampi(p_X + fm_iround(wx), p_Width);');
    // dynamicGrain:false 时片门抖动退化：不含帧索引，参数保留但不生效
    const stat = generateDctl({ ...makeInput('yrgb'), dynamicGrain: false });
    expect(stat.source).not.toContain('TIMELINE_FRAME_INDEX');
    expect(stat.source).toContain('FM_GATE_WEAVE_PX');
    expect(stat.warnings.some((w) => w.includes('片门抖动') && w.includes('恒为 0'))).toBe(true);
  });

  it('54. 扫描颗粒团簇：FM_GRAIN_CLUSTER 出现在 transform 内、helper 里不出现；gain 公式同式', () => {
    const { source } = generateDctl(makeInput('yrgb'));
    expect(source).toContain('float clLow = fm_vnoise(gx * 0.18f, gy * 0.18f, 91.7f);');
    expect(source).toContain('float clGain = 1.0f + FM_GRAIN_CLUSTER * (clLow - 0.5f) * 2.0f * 0.6f;');
    // 团簇增益进入颗粒叠加项（R21：幅度乘 FM_MASTER）
    expect(source).toContain('FM_GRAIN_AMP * FM_MASTER * gW * clGain');
    // cluster 默认 0 → clGain ≡ 1（恒等）；参数只在 transform 里被读
    const names = topFnNames(source);
    for (const fn of names) {
      if (fn === 'transform') continue;
      const body = fnBody(source, fn);
      expect(/FM_GRAIN_CLUSTER|FM_GATE_WEAVE/.test(body), `helper ${fn} 引用了 R9 参数`).toBe(false);
    }
    const errs = validateDctl(source).errors;
    expect(errs.filter((e) => e.includes('UI 参数'))).toEqual([]);
    expect(errs.filter((e) => e.includes('未声明的参数宏'))).toEqual([]);
  });

  it('55. 标签文案齐备：团簇归 grain、两个片门参数归 gate_weave，前缀「片门-」，无非法字符', () => {
    for (const m of R9_MACROS) {
      const t = PARAM_TEXT[m];
      expect(t, `${m} 缺文案`).toBeDefined();
      expect(t.cn.length).toBeGreaterThan(0);
      expect(t.en.length).toBeGreaterThan(0);
      expect(/[()\[\],]/.test(t.tip), `${m} 中文说明含非法字符`).toBe(false);
      expect(/[()\[\],]/.test(t.tipEn), `${m} 英文说明含非法字符`).toBe(false);
    }
    expect(PARAM_TEXT['FM_GRAIN_CLUSTER'].group).toBe('grain');
    expect(PARAM_TEXT['FM_GATE_WEAVE_PX'].group).toBe('gate_weave');
    expect(PARAM_TEXT['FM_GATE_WEAVE_SPEED'].group).toBe('gate_weave');
    expect(GROUP_PREFIX.gate_weave).toBe('片门-');
    const std = generateDctl(makeInput('yrgb'));
    const labels = srcLabels(std.source);
    expect(labels.find((l) => l.macro === 'FM_GATE_WEAVE_PX')!.label.startsWith('片门-')).toBe(true);
    expect(validateDctl(std.source).ok, validateDctl(std.source).errors.join('；')).toBe(true);
  });

  it('56. 32 种层组合（halation×bloom×grain×vignette×gate_weave）回归全绿、尾部完整', () => {
    const combos = [false, true].flatMap((halation) =>
      [false, true].flatMap((bloom) =>
        [false, true].flatMap((grain) =>
          [false, true].flatMap((vignette) =>
            [false, true].map((gate_weave) => ({ halation, bloom, grain, vignette, gate_weave }))))));
    expect(combos.length).toBe(32);
    for (const stages of combos) {
      const tag = JSON.stringify(stages);
      const { source } = generateDctl({ ...makeInput('yrgb'), compat: true, stages });
      const v = validateDctl(source);
      expect(v.errors, `${tag}：${v.errors.join('；')}`).toEqual([]);
      expect(source, `${tag}：缺顶层 return`).toMatch(/^[ \t]*return make_float3\(/m);
      expect(source.trimEnd().endsWith('}'), `${tag}：结尾不是 }`).toBe(true);
      expect(source, `${tag}：残留层标记`).not.toMatch(/>>>STAGE|<<<STAGE/);
      if (stages.gate_weave === false) expect(source, `${tag}：残留 FM_GATE_WEAVE`).not.toContain('FM_GATE_WEAVE');
    }
  });

  it('57. warnings 更新：删除过时的「静态颗粒」描述，如实说明动态颗粒/双环采样/逐 tap look/片门抖动', () => {
    const r = generateDctl(makeInput('yrgb'));
    expect(r.warnings.some((w) => w.includes('颗粒为静态颗粒'))).toBe(false);
    expect(r.warnings.some((w) => w.includes('TIMELINE_FRAME_INDEX') && w.includes('dynamicGrain:false'))).toBe(true);
    /* R21：旧「单通道亮度代理 / 阈值作用于源图」的诚实边界已由新结构替换 */
    expect(r.warnings.some((w) => w.includes('单通道亮度代理'))).toBe(false);
    expect(r.warnings.some((w) => w.includes('阈值在 DCTL 里作用于源图'))).toBe(false);
    expect(r.warnings.some((w) => w.includes('双环结构') && w.includes('每 tap 读 RGB 并过完整 look'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('108 次'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('片门抖动'))).toBe(true);
  });
});

/* ================= R14 · 入口签名（逐像素 vs 纹理） =================
 * 用户实机（Windows + Studio 21）用「节点右键 → LUT → DCTL」加载全层 DCTL 时报
 * `wrong argument int p_Width` / `main DCTL function has wrong arguments`：根因是 LUT 路径
 * 只吃逐像素颜色签名，而全层 DCTL 用的是纹理签名 + 52 个 UI 参数（LUT 路径没有检查器面板）。
 * 修法：无任何邻域采样（只含色彩层）时改用逐像素签名，可直接走 LUT 路径；
 * 有邻域采样时保持纹理签名 + ResolveFX DCTL 插件加载。签名与采样方式必须严格同步。 */
describe('R14 入口签名（逐像素 vs 纹理）', () => {
  const ALL_OFF = { halation: false, bloom: false, grain: false, vignette: false, gate_weave: false };
  const colorOnly = (): DctlGenResult => generateDctl({ ...makeInput('yrgb'), compat: true, stages: ALL_OFF });

  it('58. 色彩层-only 用逐像素签名、无 __TEXTURE__/_tex2D、17 参数、校验通过、文件头写明加载途径', () => {
    const r = colorOnly();
    expect(r.source).toContain(PIXEL_SIG);
    expect(r.source.includes('__TEXTURE__')).toBe(false);
    expect(countOf(r.source, /_tex2D/g)).toBe(0);
    expect(r.params.length).toBe(17);
    expect(validateDctl(r.source).ok, validateDctl(r.source).errors.join('；')).toBe(true);
    /* 签名物理单行（折行会被达芬奇判成签名错误） */
    const sigLine = r.source.split('\n').find((l) => l.includes('transform('))!;
    expect(sigLine.trim().endsWith(')')).toBe(true);
    /* 文件头写明当前签名与正确加载途径 */
    expect(r.source).toContain('// 入口签名：逐像素');
    expect(r.source).toContain('ResolveFX Color → DCTL');
    expect(r.source).toContain('LUT → DCTL');
  });

  it('58b. 只有程序化颗粒（仍无邻域采样）也用逐像素签名，且校验通过', () => {
    const r = generateDctl({
      ...makeInput('yrgb'), compat: true,
      stages: { halation: false, bloom: false, grain: true, vignette: false, gate_weave: false },
    });
    expect(r.source).toContain(PIXEL_SIG);
    expect(countOf(r.source, /_tex2D/g)).toBe(0);
    expect(validateDctl(r.source).ok, validateDctl(r.source).errors.join('；')).toBe(true);
  });

  it('59. 全层产物用纹理签名、含 __TEXTURE__/_tex2D、校验通过、文件头写明加载途径', () => {
    const r = generateDctl(makeInput('yrgb'));
    expect(r.source).toContain(TEXTURE_SIG);
    expect(r.source).toContain('__TEXTURE__');
    expect(countOf(r.source, /_tex2D/g)).toBeGreaterThan(0);
    expect(validateDctl(r.source).ok, validateDctl(r.source).errors.join('；')).toBe(true);
    expect(r.source).toContain('// 入口签名：纹理');
    expect(r.source).toContain('wrong argument int p_Width');
  });

  it('60. 签名与采样方式不同步 / 签名折行 → 校验报错（反例）', () => {
    const color = colorOnly().source;
    const full = generateDctl(makeInput('yrgb')).source;
    /* 逐像素产物改成纹理签名 → 纹理签名却零采样 */
    const wrong1 = validateDctl(color.replace(PIXEL_SIG, TEXTURE_SIG));
    expect(wrong1.ok).toBe(false);
    expect(wrong1.errors.join('；')).toContain('不同步');
    /* 全层产物改成逐像素签名 → 逐像素签名却含 _tex2D */
    const wrong2 = validateDctl(full.replace(TEXTURE_SIG, PIXEL_SIG));
    expect(wrong2.ok).toBe(false);
    expect(wrong2.errors.join('；')).toContain('不同步');
    /* 纹理签名折行 → 非法（物理单行是硬要求） */
    const wrapped = full.replace(
      TEXTURE_SIG,
      '__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y,\n    __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB)',
    );
    expect(validateDctl(wrapped).ok).toBe(false);
    /* 原产物仍然通过（反例不误伤） */
    expect(validateDctl(color).ok, validateDctl(color).errors.join('；')).toBe(true);
    expect(validateDctl(full).ok, validateDctl(full).errors.join('；')).toBe(true);
  });
});
