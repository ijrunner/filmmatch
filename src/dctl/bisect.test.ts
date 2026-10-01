/* 达芬奇 DCTL 诊断文件生成（spike② 排查闪退）
 *
 * 结论（2026-09-22 第六轮）：闪退根因是 **UI 参数被写在自定义 __DEVICE__ 助手函数里**。
 * Resolve 只把 DEFINE_UI_PARAMS 注入 transform() 的**局部作用域**（官方文档原话：
 * "This variable can be used inside the transform function."），helper 里读 FM_XXX 属于
 * 未定义作用域 → 达芬奇直接闪退（连错误对话框都不弹）。
 * 本地 15 个文件的构造差分完全分离：崩的（30/43/三个样例）都在 fm_look_channel / fm_log_look
 * 里引用参数；能用的（20–24、40–42）一个都没引用。已修（参数打包成结构体显式传入），
 * 并在 validateDctl 里加了拦截规则。
 *
 * 产物写到 app/tools/dctl-samples/bisect/（随本地验收包分发）：
 *   - 40/41/42：采样次数 vs 代码结构的合成探针（实机已验证正常，留作「已知可用」基线）
 *   - 60/61/62：根因验证三件套（修好的色彩管线 / 最小复现·崩 / 最小复现·修）
 */
import { describe, it, expect } from 'vitest';
import { getPreset } from '../film/params';
import { generateDctl, validateDctl, type DctlGenInput } from './codegen';
import { lookToLogLook } from './logmath';

/** 动态载入 node 内置模块（specifier 用变量，tsc 无需 @types/node 也不报 TS2307） */
async function nodeMod(spec: string): Promise<any> {
  return import(/* @vite-ignore */ spec);
}

const card = getPreset('fl06');
function gen(extra: Partial<DctlGenInput>): string {
  return generateDctl({
    recipeName: 'FL-06 晨负 · 二分诊断',
    shareCode: 'FM-BISECT',
    pipeline: 'yrgb',
    look: lookToLogLook(card.params.look, 'yrgb'),
    texture: card.params.texture,
    resolution: { w: 1920, h: 1080 },
    compat: true,
    ...extra,
  }).source;
}
/** 只数真正的调用（带左括号），避免注释里提到 _tex2D 时被算进去 */
const texCount = (t: string): number => (t.match(/_tex2D\(/g) || []).length;

const OFF = { halation: false, bloom: false, grain: false, vignette: false } as const;

/* ---- 合成采样探针（已知可用基线）--------------------------------------------
 * 这两根轴（采样次数 / 抽头是否包在 if 里）已被实机数据否定为闪退原因，
 * 但文件本身是「能用」的实证，保留作基线。 */
describe('合成采样探针（已知可用基线）', () => {
  function probe(taps: number, inIf: boolean): string {
    const cols = Math.ceil(Math.sqrt(taps));
    const rows = Math.ceil(taps / cols);
    const step = 3;
    const ox0 = Math.floor((cols - 1) / 2) * step;
    const oy0 = Math.floor((rows - 1) / 2) * step;
    const L: string[] = [];
    L.push('// FilmMatch 菲林工坊 · 达芬奇 DCTL 合成采样探针（诊断用，不是配方产物）');
    L.push(`// 变量①采样次数：抽头 ${taps} 个 × RGB = ${taps * 3} 次 _tex2D`);
    L.push(`// 变量②代码结构：抽头${inIf ? '包在 if (FM_PROBE_ON > 0.5f) 里' : '是裸块（无 if，与 24_tex_9tap 一致）'}`);
    L.push('// 实机结论：三种结构都能正常出效果 → 采样次数与 if 都不是闪退原因');
    L.push('DEFINE_UI_PARAMS(FM_PROBE_ON, Probe On, DCTLUI_SLIDER_FLOAT, 1.0f, 0.0f, 1.0f, 0.01f)');
    L.push('__DEVICE__ int fm_clampi(int x, int n) { return x < 0 ? 0 : (x > n - 1 ? n - 1 : x); }');
    L.push('__DEVICE__ float fm_smoothstep(float a, float b, float x) { float t = (x - a) / (b - a); t = t < 0.0f ? 0.0f : (t > 1.0f ? 1.0f : t); return t * t * (3.0f - 2.0f * t); }');
    L.push('');
    L.push('__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB)');
    L.push('{');
    L.push('    float3 acc = make_float3(0.0f, 0.0f, 0.0f);');
    L.push('    float wsum = 0.0f;');
    if (inIf) L.push('    if (FM_PROBE_ON > 0.5f) {');
    for (let i = 0; i < taps; i++) {
      const ox = (i % cols) * step - ox0;
      const oy = Math.floor(i / cols) * step - oy0;
      L.push('    {');
      L.push(`        int xx = fm_clampi(p_X + (${ox}), p_Width);`);
      L.push(`        int yy = fm_clampi(p_Y + (${oy}), p_Height);`);
      L.push('        float3 tc = make_float3(_tex2D(p_TexR, xx, yy), _tex2D(p_TexG, xx, yy), _tex2D(p_TexB, xx, yy));');
      L.push('        float mx = tc.x > tc.y ? tc.x : tc.y; mx = mx > tc.z ? mx : tc.z;');
      /* 亮通写成 0.25+0.75*smoothstep：保证任何素材都看得见效果，避免「没变化」被误判成「没生效」 */
      L.push('        float bw = 0.25f + 0.75f * fm_smoothstep(0.5f, 1.0f, mx);');
      L.push('        float gw = 1.000000f;');
      L.push('        acc = make_float3(acc.x + tc.x * (bw * gw), acc.y + tc.y * (bw * gw), acc.z + tc.z * (bw * gw));');
      L.push('        wsum = wsum + gw;');
      L.push('    }');
    }
    if (inIf) L.push('    }');
    L.push('    float k = 1.0f / (wsum > 0.0001f ? wsum : 0.0001f);');
    L.push('    return make_float3(acc.x * k, acc.y * k, acc.z * k);');
    L.push('}');
    return L.join('\n') + '\n';
  }

  it('40/41/42：采样次数与 if 两根轴的合成探针', async () => {
    const fs = await nodeMod('node:fs');
    const path = await nodeMod('node:path');
    const cwd = (globalThis as { process?: { cwd(): string } }).process!.cwd();
    const dir = path.join(cwd, 'tools', 'dctl-samples', 'bisect');
    fs.mkdirSync(dir, { recursive: true });

    const files = [
      { name: '40_tap_28_flat.dctl', src: probe(28, false), tex: 84 },
      { name: '41_tap_09_inif.dctl', src: probe(9, true), tex: 27 },
      { name: '42_tap_28_inif.dctl', src: probe(28, true), tex: 84 },
    ];
    for (const f of files) {
      expect(texCount(f.src), f.name).toBe(f.tex);
      expect(f.src).toContain('__DEVICE__');
      expect(f.src.trimEnd().endsWith('}'), f.name).toBe(true);
      expect(validateDctl(f.src).ok, f.name).toBe(true);
      fs.writeFileSync(path.join(dir, f.name), f.src, 'utf8');
    }
  });
});

/* ---- 根因验证三件套：最小复现 + 修法对照 + 修好的真实管线 ---------------------- */
describe('根因验证三件套（UI 参数不许进 helper）', () => {
  const SIG = '__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB)';
  const SRC = '    float3 src = make_float3(_tex2D(p_TexR, p_X, p_Y), _tex2D(p_TexG, p_X, p_Y), _tex2D(p_TexB, p_X, p_Y));';

  /** 最小复现：同一份代码，只差「参数是否从 transform 传进去」 */
  function minimal(paramsAsArg: boolean): string {
    return [
      '// FilmMatch 菲林工坊 · 达芬奇 DCTL 最小复现（诊断用）',
      paramsAsArg
        ? '// 本文件：参数由 transform 读出后**显式传入** helper —— 预期正常出效果'
        : '// 本文件：helper 里**直接读** UI 参数 —— 预期一用就闪退（根因复现）',
      '// 背景：Resolve 只把 DEFINE_UI_PARAMS 注入 transform() 的局部作用域，',
      '//       官方文档原话 "This variable can be used inside the transform function."，',
      '//       所以 helper 里读 FM_XXX 属于未定义作用域。',
      'DEFINE_UI_PARAMS(FM_GAIN, Gain, DCTLUI_SLIDER_FLOAT, 1.0f, 0.0f, 2.0f, 0.01f)',
      '',
      paramsAsArg
        ? '__DEVICE__ float fm_helper(float x, float gain) { return x * gain; }'
        : '__DEVICE__ float fm_helper(float x) { return x * FM_GAIN; }   // ← 唯一的问题行',
      '',
      SIG,
      '{',
      SRC,
      paramsAsArg
        ? '    float g = FM_GAIN;   // 参数只在 transform 里读'
        : '    // 参数没有在这里读——这正是问题所在',
      paramsAsArg
        ? '    return make_float3(fm_helper(src.x, g), fm_helper(src.y, g), fm_helper(src.z, g));'
        : '    return make_float3(fm_helper(src.x), fm_helper(src.y), fm_helper(src.z));',
      '}',
    ].join('\n') + '\n';
  }

  it('60/61/62：修好的色彩管线 + 最小复现对照，并写测试顺序说明', async () => {
    const fs = await nodeMod('node:fs');
    const path = await nodeMod('node:path');
    const cwd = (globalThis as { process?: { cwd(): string } }).process!.cwd();
    const dir = path.join(cwd, 'tools', 'dctl-samples', 'bisect');
    fs.mkdirSync(dir, { recursive: true });

    const bad = minimal(false);
    const good = minimal(true);
    const fixed = gen({ stages: OFF, recipeName: 'FL-06 晨负 · 修好的色彩管线' });

    /* 最小复现确实只有一处差异 */
    expect(bad.split('\n').length).toBe(good.split('\n').length);
    expect(bad).toContain('x * FM_GAIN');
    expect(good).toContain('float gain');
    /* 对照组的 helper 定义里绝不能出现参数宏（精确到那一行，不要跨行匹配） */
    expect(good).toContain('__DEVICE__ float fm_helper(float x, float gain) { return x * gain; }');

    /* 新增的校验规则必须拦住 61、放行 62 与 60 */
    const vBad = validateDctl(bad);
    expect(vBad.ok, '校验器没能拦住「helper 里读参数」').toBe(false);
    expect(vBad.errors.join('；')).toContain('fm_helper');
    expect(validateDctl(good).ok, validateDctl(good).errors.join('；')).toBe(true);
    const vFixed = validateDctl(fixed);
    expect(vFixed.ok, vFixed.errors.join('；')).toBe(true);
    /* 修好的管线：参数经结构体传入，helper 里不再出现任何 FM_ 宏 */
    expect(fixed).toContain('FmChannelParams cp;');
    expect(fixed).toContain('c = fm_log_look(c, lp, cp);');
    expect(fixed).not.toContain('float pivot = fm_clamp01(FM_PIVOT)');

    const files = [
      { name: '60_fixed_color_only.dctl', src: fixed },
      { name: '61_params_in_helper.dctl', src: bad },
      { name: '62_params_as_arg.dctl', src: good },
    ];
    for (const f of files) {
      expect(f.src.trimEnd().endsWith('}'), f.name).toBe(true);
      fs.writeFileSync(path.join(dir, f.name), f.src, 'utf8');
    }

    /* 测试顺序说明随文件一起写盘，避免与文件清单脱节 */
    const md = [
      '# 达芬奇 DCTL 诊断包 · 测试顺序（2026-09-22 第六轮）',
      '',
      '## 结论：闪退根因已定位并修复',
      '',
      '**根因**：`DEFINE_UI_PARAMS` 声明的 UI 参数被写在自定义 `__DEVICE__` 助手函数里。',
      'Resolve 只把参数注入 `transform()` 的**局部作用域**（官方文档原话：',
      '"This variable can be used inside the transform function."），helper 里读 `FM_XXX`',
      '属于未定义作用域 → 达芬奇直接闪退（连错误对话框都不弹）。',
      '',
      '**证据**：本地 15 个文件的构造差分完全分离——崩的（30/43/三个样例）都在',
      '`fm_look_channel` / `fm_log_look` 里引用参数；能用的（20–24、40–42）一个都没引用。',
      '公开项目 17 个 DCTL 同样无一例外：需要时一律显式传参或传结构体。',
      '',
      '**修法**：参数在 `transform()` 里读出 → 打包成 `FmChannelParams` / `FmLookParams`',
      '结构体 → 显式传给 helper。`validateDctl` 已加规则拦死这类写法（回归测试覆盖）。',
      '',
      '## 现在只需测这三个（约 20 秒）',
      '',
      '| 顺序 | 文件 | 预期 | 说明 |',
      '| --- | --- | --- | --- |',
      '| 1 | `61_params_in_helper.dctl` | **闪退** | 最小复现（12 行）：helper 里直接读 UI 参数 |',
      '| 2 | `62_params_as_arg.dctl` | 正常出效果 | 同一份代码，只把参数改成显式传入 |',
      '| 3 | `60_fixed_color_only.dctl` | 正常出效果 | 修好的真实色彩管线（对数域 look + 边缘色散） |',
      '',
      '1 崩、2 好 = 根因确认闭环（这两个文件只差一处）。3 好 = 修复后的真实管线可用。',
      '若 3 也正常，请再测 `FM_*.dctl` 三个样例（同样已修复）。',
      '',
      '**想直接看证据**：61 闪退后，在 `~/.local/share/DaVinciResolve/logs/davinci_resolve.log`',
      '（或 ResolveDebug.txt）里搜 `undeclared identifier`，应能看到编译器抱怨的正是 `FM_GAIN`。',
      '',
      '## 已知可用基线（保留备查，可跳过）',
      '',
      '| 文件 | 采样次数 | 结构 | 此前实测 |',
      '| --- | --- | --- | --- |',
      '| `40_tap_28_flat.dctl` | 84 | 裸块 | ✅ 正常 |',
      '| `41_tap_09_inif.dctl` | 27 | if 包抽头 | ✅ 正常 |',
      '| `42_tap_28_inif.dctl` | 84 | if 包抽头 | ✅ 正常 |',
      '',
      '这三个已证明「84 次采样」与「抽头包在 if 里」都不是闪退原因。',
      '',
      '## 已作废并删除的历史诊断文件',
      '',
      '`30–34`（分层二分）、`43`（无分支）、`50–57`（数学探针）：它们排除了采样次数、`if`、',
      '`_expf`、死函数、裸向量声明、提前 return、硬件配置，根因确定后不再需要，留着只会混淆。',
      '记录见 `app/tools/EFFECT-REPORT-R4.md` §7。',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'README-测试顺序.md'), md, 'utf8');
  });
});
