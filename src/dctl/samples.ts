/* FilmMatch 菲林工坊 · DCTL 样例产物（R4）
 *
 * 3 个「管线 × 配方」样例：生成结果由测试写到 app/tools/dctl-samples/（golden 文件），
 * 供人工导入达芬奇实测（spike②）与回归防漂移。
 * 之所以用纯函数 + 静态文件名：单测可在 node 里直接生成并写盘，无 DOM 依赖。
 *
 * R6 追加：LABEL_SPIKE_SAMPLES（3 个 3 参数文件，A/B/C 单一变量对照），同样由测试写盘，
 * 用于在达芬奇里确认「中英混排标签 / 分组前缀 / tooltip」三种写法能否正常解析。
 *
 * R7 追加：MATCH_SAMPLES（1 个带内联 CDL 匹配段的文件），用于单节点导出的实机确认。
 * 为什么单开一张表而不是塞进 DCTL_SAMPLES：`DCTL_SAMPLES.length` 被
 * `tools/e2e-verify.mjs` 的 R4-4 断言钉在 3（生成页 meta 里的 dctl.samples），
 * 往那张表里加第 4 个会让 E2E 假失败；匹配样例是 R7 的新产物，单列一张表更干净。
 */
import { fitCdl, type Cdl } from '../batch/cdl';
import { quantileStats } from '../batch/quantiles';
import { synthSeries } from '../batch/synth';
import { getPreset } from '../film/params';
import { defineLine, generateDctl, type DctlGenResult, type DctlParamDecl } from './codegen';
import { composeLabel, type ParamGroup } from './labels';
import { lookToLogLook, type PipelineTF } from './logmath';

export interface DctlSample {
  id: string;
  pipeline: PipelineTF;
  presetId: string;
  fileName: string;
  /** 兼容模式：ASCII 参数标签 + 开关用 0/1 浮点滑杆（达芬奇实测前的稳妥默认） */
  compat: boolean;
}

/** 恰好 3 个样例：YRGB×晨负（家族A）、RCM×光匣（强光晕）、RCM×褪色（家族C） */
export const DCTL_SAMPLES: DctlSample[] = [
  { id: 'yrgb-fl06', pipeline: 'yrgb', presetId: 'fl06', fileName: 'FM_yrgb_fl06.dctl', compat: true },
  { id: 'rcm-fl05', pipeline: 'rcm', presetId: 'fl05', fileName: 'FM_rcm_fl05.dctl', compat: true },
  { id: 'rcm-fl08', pipeline: 'rcm', presetId: 'fl08', fileName: 'FM_rcm_fl08.dctl', compat: true },
];

/** 由样例定义生成 DCTL（配方名/参数取自预设卡，pivot 随管线取值） */
export function buildSample(s: DctlSample): DctlGenResult {
  const card = getPreset(s.presetId);
  const look = lookToLogLook(card.params.look, s.pipeline);
  return generateDctl({
    recipeName: card.name,
    shareCode: `FM-${s.pipeline.toUpperCase()}-${s.presetId.toUpperCase()}`,
    pipeline: s.pipeline,
    look,
    texture: card.params.texture,
    resolution: { w: 1920, h: 1080 },
    /* R14：标签/tooltip 已实机验证通过（2026-09-23 三个 spike 全部生效），样例改为**产品默认形态**
     * （中英混排 + tooltip）；开关形态仍用已验证的 0/1 滑杆（compat 的 boolSlider 语义）。 */
    compat: s.compat,
    labelMode: 'bilingual',
    tooltips: true,
    /* 不用 branchless：层开关保持 `if (SW) { 抽头 }`——实机可用的 41/42 正是这个结构，
     * 而无分支写法（43）与根因修复撞在一起、尚未单独验证过。 */
    branchless: false,
  });
}

/* ================= R7 单节点导出样例（内联 CDL 匹配段） =================
 * 与 DCTL_SAMPLES 同源同形，唯一差别是带 `match`：11 个匹配参数（默认值 = CDL 解算结果）
 * + 采样之后/tf_encode 之前的匹配段。用途：达芬奇里确认「一个节点完成匹配 + look + 质感」。
 * CDL 不硬编码魔数：用 R3 的求解器在合成素材上现场解算（确定性、可复现），
 * 语义与批量匹配页导出的 cdl.json 完全一致。 */

/** 由合成素材现场解算一组 CDL（取曝光差 1 EV 的两帧：模拟「把 seg01 匹配到 seg02」）。
 *  为什么不取 2 EV 的首尾帧：那样会顶到 CDL_RANGES 边界（slope 2 / power 0.7），
 *  样例看起来像极端参数，不利于实机确认。 */
export function solvedSampleCdl(): Cdl {
  const frames = synthSeries(96, 64, 3);
  const f0 = frames[0];
  const f1 = frames[1];
  return fitCdl(quantileStats(f0.data, f0.w, f0.h), quantileStats(f1.data, f1.w, f1.h)).cdl;
}

/** 恰好 1 个：YRGB×晨负 + 内联匹配段（compat 形态——与已实测可加载的 3 个样例同形） */
export const MATCH_SAMPLES: DctlSample[] = [
  { id: 'match-yrgb-fl06', pipeline: 'yrgb', presetId: 'fl06', fileName: 'FM_match_yrgb_fl06.dctl', compat: true },
];

/** 由样例定义生成带匹配段的 DCTL */
export function buildMatchSample(s: DctlSample): DctlGenResult {
  const card = getPreset(s.presetId);
  const look = lookToLogLook(card.params.look, s.pipeline);
  return generateDctl({
    recipeName: card.name,
    shareCode: `FM-${s.pipeline.toUpperCase()}-${s.presetId.toUpperCase()}-MATCH`,
    pipeline: s.pipeline,
    look,
    texture: card.params.texture,
    resolution: { w: 1920, h: 1080 },
    compat: s.compat,
    /* R14：与 DCTL_SAMPLES 保持一致——标签/tooltip 已实机验证，样例用产品默认形态 */
    labelMode: 'bilingual',
    tooltips: true,
    match: { cdl: solvedSampleCdl(), enabled: true },
  });
}

/* ================= R6 标签 spike（3 个参数 × 3 种写法） =================
 * 背景：达芬奇里的 DCTL 参数面板是平铺列表，44 个滑杆只能靠标签自身聚拢；R6 打算把标签
 * 改成「分组前缀 + 中文短名 + 英文名」（如 `光晕-强度 Halation Amount`）并加 DEFINE_UI_TOOLTIP。
 * 但中英混排标签与 tooltip **都还没在达芬奇里验证过**（前科：标签里带括号会报
 * `unknown type of DCTLUIParams definition`），所以先出 3 份各 3 个参数的最小文件，
 * 让用户 2 分钟确认「能不能正常解析」——确认前不把新写法当成既成事实。
 *
 * 对照设计（单一变量）：三份文件共用同一份 3 参数数学（乘法增益 → 0..1 混合 → 开关），
 * 唯一变量是标签写法：
 *   A `spike_label_a_mixed`  混排标签（无分组前缀 / 无 tooltip）——look 组 12 个滑杆的形态
 *   B `spike_label_b_group`  加分组前缀（无 tooltip）——光晕/柔光/颗粒/暗角 32 个滑杆的形态
 *   C `spike_label_c_tooltip` 分组前缀 + tooltip——标准模式的完整形态
 * 开关刻意用 0/1 浮点滑杆而非 DCTLUI_CHECK_BOX：本 spike 只验证标签解析，
 * 不把「勾选框未验证」这个额外变量混进来（否则一旦失败无法定位是哪一项）。 */

export interface LabelSpikeParam {
  macro: string;
  cn: string;
  en: string;
  group: ParamGroup;
  tip: string;
  tipEn: string;
  def: number;
  min: number;
  max: number;
}

export interface LabelSpikeSample {
  id: string;
  fileName: string;
  /** 文件头里写明的用途（验证哪一种写法） */
  purpose: string;
  groupPrefix: boolean;
  tooltips: boolean;
  params: LabelSpikeParam[];
}

/** A 用的标签：look 组形态（无分组前缀） */
const SPIKE_LOOK_PARAMS: LabelSpikeParam[] = [
  {
    macro: 'FM_SPIKE_GAIN', cn: '对比度', en: 'Contrast', group: 'look', def: 1, min: 0, max: 2,
    tip: '增益倍数，1.0 为不变，越大画面越亮', tipEn: 'Gain; 1.0 = unchanged, higher = brighter',
  },
  {
    macro: 'FM_SPIKE_MIX', cn: '混合', en: 'Mix', group: 'look', def: 0.5, min: 0, max: 1,
    tip: '混合量，0 为原图，1 为完全应用增益', tipEn: 'Blend; 0 = source, 1 = fully applied gain',
  },
  {
    macro: 'FM_SPIKE_ON', cn: '开关', en: 'Enable', group: 'look', def: 1, min: 0, max: 1,
    tip: '效果开关，0 为关闭，1 为开启', tipEn: 'Effect switch; 0 = off, 1 = on',
  },
];

/** B/C 用的标签：质感层形态（带中文分组前缀） */
const SPIKE_HALATION_PARAMS: LabelSpikeParam[] = [
  {
    macro: 'FM_SPIKE_GAIN', cn: '强度', en: 'Halation Amount', group: 'halation', def: 1, min: 0, max: 2,
    tip: '增益倍数，1.0 为不变，越大画面越亮', tipEn: 'Gain; 1.0 = unchanged, higher = brighter',
  },
  {
    macro: 'FM_SPIKE_MIX', cn: '混合', en: 'Halation Mix', group: 'halation', def: 0.5, min: 0, max: 1,
    tip: '混合量，0 为原图，1 为完全应用增益', tipEn: 'Blend; 0 = source, 1 = fully applied gain',
  },
  {
    macro: 'FM_SPIKE_ON', cn: '开关', en: 'Halation On', group: 'halation', def: 1, min: 0, max: 1,
    tip: '效果开关，0 为关闭，1 为开启', tipEn: 'Effect switch; 0 = off, 1 = on',
  },
];

/** 恰好 3 个 spike 文件（A/B/C 见上方对照设计） */
export const LABEL_SPIKE_SAMPLES: LabelSpikeSample[] = [
  {
    id: 'spike-label-a-mixed', fileName: 'spike_label_a_mixed.dctl',
    purpose: '验证「中英混排标签 对比度 Contrast」在达芬奇里能否正常解析（无分组前缀、无 tooltip）',
    groupPrefix: false, tooltips: false, params: SPIKE_LOOK_PARAMS,
  },
  {
    id: 'spike-label-b-group', fileName: 'spike_label_b_group.dctl',
    purpose: '验证「分组前缀 + 混排标签 光晕-强度 Halation Amount」在达芬奇里能否正常解析（无 tooltip）',
    groupPrefix: true, tooltips: false, params: SPIKE_HALATION_PARAMS,
  },
  {
    id: 'spike-label-c-tooltip', fileName: 'spike_label_c_tooltip.dctl',
    purpose: '验证「分组前缀 + 混排标签 + DEFINE_UI_TOOLTIP」在达芬奇里能否正常解析（标准模式完整形态）',
    groupPrefix: true, tooltips: true, params: SPIKE_HALATION_PARAMS,
  },
];

/** 由 spike 定义生成最小 DCTL：参数行走生成器同一条 defineLine（spike 验证的就是真实产物的写法） */
export function buildLabelSpike(s: LabelSpikeSample): DctlGenResult {
  const decls: DctlParamDecl[] = s.params.map((p) => ({
    macro: p.macro,
    label: composeLabel(p, s.groupPrefix),
    en: p.en,
    tip: p.tip,
    tipEn: p.tipEn,
    group: p.group,
    type: 'float',
    def: p.def,
    min: p.min,
    max: p.max,
  }));
  const L: string[] = [];
  L.push('// =====================================================================');
  L.push(`// FilmMatch 菲林工坊 · 达芬奇 DCTL 标签 spike（${s.fileName}）`);
  L.push(`// 本文件用途：${s.purpose}；3 个参数是同一变量。`);
  L.push('// 对照设计：三份 spike 共用同一份 3 参数数学（增益 × 混合 + 开关），唯一变量是标签写法——');
  L.push('//   A 混排标签（无前缀 / 无 tooltip）→ B 加分组前缀 → C 再加 DEFINE_UI_TOOLTIP。');
  L.push('// 开关用 0/1 滑杆而不是勾选框：本文件只验证标签解析，不把「勾选框未验证」混进来。');
  if (s.tooltips) {
    L.push('// tooltip 第一个参数按官方文档示例写成「标签文本」（与滑杆名逐字一致，见 DEFINE_UI_TOOLTIP(Target Color, ...)）；');
    L.push('// 请把鼠标悬停在滑杆上确认说明能弹出——若标签正常但没有说明，请回执，备选写法是改成宏名。');
  }
  L.push('// 请确认：① 三个滑杆名按上面的写法显示；② 拖动时画面有响应；③ 达芬奇不报错也不闪退。');
  L.push('// 用法：节点右键 → LUT → DCTL 子菜单选中本文件；换文件后必须重启达芬奇（Update Lists 不会重载已应用的 DCTL）。');
  L.push('// 商标：本文件由 FilmMatch 菲林工坊 生成与维护，不含任何第三方品牌标识。');
  L.push('// =====================================================================');
  L.push('');
  L.push(`// ---- 参数面板（3 个${s.tooltips ? '，每条附 tooltip' : '，刻意不带 tooltip'}） ----`);
  for (const d of decls) L.push(...defineLine(d, { labelMode: 'bilingual', groupPrefix: s.groupPrefix, tooltips: s.tooltips }));
  L.push('');
  L.push('// ---- 数学（极简：一次乘法增益 + 一次 0..1 混合，开关只控制是否应用） ----');
  L.push('__DEVICE__ float fm_clamp01(float x) { return x < 0.0f ? 0.0f : (x > 1.0f ? 1.0f : x); }');
  L.push('__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB)');
  L.push('{');
  L.push('    float3 c = make_float3(_tex2D(p_TexR, p_X, p_Y), _tex2D(p_TexG, p_X, p_Y), _tex2D(p_TexB, p_X, p_Y));');
  L.push('    if (FM_SPIKE_ON > 0.5f) {');
  L.push('        float g = FM_SPIKE_GAIN;                                  // 参数①：乘法强度');
  L.push('        float m = FM_SPIKE_MIX;                                   // 参数②：0..1 混合');
  L.push('        float3 amp = make_float3(c.x * g, c.y * g, c.z * g);');
  L.push('        c = make_float3(c.x + (amp.x - c.x) * m,');
  L.push('                        c.y + (amp.y - c.y) * m,');
  L.push('                        c.z + (amp.z - c.z) * m);');
  L.push('    }');
  L.push('    return make_float3(fm_clamp01(c.x), fm_clamp01(c.y), fm_clamp01(c.z));');
  L.push('}');
  return {
    source: L.join('\n') + '\n',
    params: decls,
    warnings: [
      '本文件是标签 spike（仅 3 个参数），用于验证达芬奇能否解析该标签写法，不是配方产物；确认后请删除。',
      '开关为 0/1 浮点滑杆（不是勾选框）：spike 只隔离标签写法这一个变量。',
    ],
  };
}
