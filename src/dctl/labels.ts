/* FilmMatch 菲林工坊 · DCTL 参数标签文案表（R6）
 *
 * 达芬奇的 DCTL 参数面板是**平铺列表**：没有分组控件，44 个滑杆只能靠标签自身聚拢。
 * 本表给每个参数提供四样东西：
 *   - cn    中文短名（分组前缀之后的部分）
 *   - en    英文名（ASCII，拼进标签，如 `对比度 Contrast`）
 *   - tip   中文一句话说明（标准模式的 DEFINE_UI_TOOLTIP）
 *   - tipEn ASCII 一句话说明（兼容模式的 tooltip：未验证字符一律不进兼容产物）
 *   - group 参数分组（look 无前缀；其余组用中文前缀把面板里的同层参数聚到一起）
 *
 * 文案规范（硬约束）：
 *   - 标签里**不许出现** `(` `)` `[` `]` `,`——社区实测会让达芬奇报
 *     `unknown type of DCTLUIParams definition`；空格与中文已验证可用。
 *   - 说明里也不写 ASCII 括号/逗号/引号（用中文标点），把风险面压到最小。
 *   - 不含任何第三方品牌词（项目红线，`BRAND_WORDS` 测试守着）。
 *   - 每条说明要说清「调什么 / 中性值在哪 / 往哪边走」，不要只写名词。
 */
/** 参数分组：look 为色彩层，match 为 R7 内联匹配段，master 为 R21 质感总强度，
 *  其余为质感层（与 DCTL 里的层裁剪 stages 同名） */
export type ParamGroup = 'match' | 'look' | 'master' | 'halation' | 'bloom' | 'grain' | 'vignette' | 'gate_weave';

/** 分组前缀（look 组不加前缀；其余组让面板里的同层参数自然聚拢） */
export const GROUP_PREFIX: Record<ParamGroup, string> = {
  match: '匹配-',
  look: '',
  master: '质感-',
  halation: '光晕-',
  bloom: '柔光-',
  grain: '颗粒-',
  vignette: '暗角-',
  gate_weave: '片门-',
};

export interface ParamText {
  cn: string;
  en: string;
  group: ParamGroup;
  tip: string;
  tipEn: string;
}

/** 53 个参数的标签/说明表（键 = 参数宏名；与 textureParamDecls 的清单一一对应）
 *  + R7 的 11 个匹配段参数（键与 matchParamDecls 一一对应）
 *  （R21 起 52 → 53：新增 FM_MASTER 质感总强度，只在含质感层的导出形态出现） */
export const PARAM_TEXT: Record<string, ParamText> = {
  /* ---- R7 匹配段：内联 CDL（11） ----
   * 文案要点：这 10 个系数是「该镜头的解算结果」（默认值来自 R3 求解器），不是通用常量；
   * 面板上微调后与 R3 导出的系数不再逐位一致——说明里必须讲清「调什么/中性值在哪」。 */
  FM_MATCH_ON: {
    cn: '开关', en: 'Match On', group: 'match',
    tip: '匹配段总开关，默认开启，关闭后本节点只做 look 与质感',
    tipEn: 'Match segment master switch; on by default',
  },
  FM_MATCH_SLOPE_R: {
    cn: '斜率红', en: 'Match Slope R', group: 'match',
    tip: '红通道斜率，1.0 为不变，是该镜头解算出的增益',
    tipEn: 'Red channel slope; 1.0 = unchanged; solved for this clip',
  },
  FM_MATCH_SLOPE_G: {
    cn: '斜率绿', en: 'Match Slope G', group: 'match',
    tip: '绿通道斜率，1.0 为不变，是该镜头解算出的增益',
    tipEn: 'Green channel slope; 1.0 = unchanged; solved for this clip',
  },
  FM_MATCH_SLOPE_B: {
    cn: '斜率蓝', en: 'Match Slope B', group: 'match',
    tip: '蓝通道斜率，1.0 为不变，是该镜头解算出的增益',
    tipEn: 'Blue channel slope; 1.0 = unchanged; solved for this clip',
  },
  FM_MATCH_OFFSET_R: {
    cn: '偏移红', en: 'Match Offset R', group: 'match',
    tip: '红通道偏移，0 为不变，用于抬升或压低黑位',
    tipEn: 'Red channel offset; 0 = unchanged; lifts or lowers the black level',
  },
  FM_MATCH_OFFSET_G: {
    cn: '偏移绿', en: 'Match Offset G', group: 'match',
    tip: '绿通道偏移，0 为不变，用于抬升或压低黑位',
    tipEn: 'Green channel offset; 0 = unchanged; lifts or lowers the black level',
  },
  FM_MATCH_OFFSET_B: {
    cn: '偏移蓝', en: 'Match Offset B', group: 'match',
    tip: '蓝通道偏移，0 为不变，用于抬升或压低黑位',
    tipEn: 'Blue channel offset; 0 = unchanged; lifts or lowers the black level',
  },
  FM_MATCH_POWER_R: {
    cn: '幂次红', en: 'Match Power R', group: 'match',
    tip: '红通道幂次，1.0 为不变，大于 1 压暗中间调',
    tipEn: 'Red channel power; 1.0 = unchanged; above 1 darkens midtones',
  },
  FM_MATCH_POWER_G: {
    cn: '幂次绿', en: 'Match Power G', group: 'match',
    tip: '绿通道幂次，1.0 为不变，大于 1 压暗中间调',
    tipEn: 'Green channel power; 1.0 = unchanged; above 1 darkens midtones',
  },
  FM_MATCH_POWER_B: {
    cn: '幂次蓝', en: 'Match Power B', group: 'match',
    tip: '蓝通道幂次，1.0 为不变，大于 1 压暗中间调',
    tipEn: 'Blue channel power; 1.0 = unchanged; above 1 darkens midtones',
  },
  FM_MATCH_SAT: {
    cn: '饱和度', en: 'Match Saturation', group: 'match',
    tip: '匹配段饱和度，1.0 为不变，绕亮度轴调整色彩浓度',
    tipEn: 'Match saturation; 1.0 = unchanged; scales colour around luma',
  },

  /* ---- 对数域 look（12） ---- */
  FM_CONTRAST: {
    cn: '对比度', en: 'Contrast', group: 'look',
    tip: '对数域对比度，1.0 为不变，越大反差越强',
    tipEn: 'Log-domain contrast; 1.0 = unchanged; higher = stronger contrast',
  },
  FM_TOE: {
    cn: '阴影压缩', en: 'Toe', group: 'look',
    tip: '暗部压缩强度，0 为不压缩，越大暗部越沉',
    tipEn: 'Shadow compression; 0 = off; higher = deeper shadows',
  },
  FM_SHOULDER: {
    cn: '高光滚降', en: 'Shoulder', group: 'look',
    tip: '高光滚降强度，0 为不滚降，越大高光越柔和不易死白',
    tipEn: 'Highlight rolloff; 0 = off; higher = softer highlights',
  },
  FM_PIVOT: {
    cn: '对数枢轴', en: 'Pivot', group: 'look',
    tip: '对比与压缩的支点，0.5 附近让中灰不动，偏移会整体压暗或提亮',
    tipEn: 'Pivot of contrast and rolloff; near 0.5 keeps mid-grey fixed',
  },
  FM_CROSSTALK: {
    cn: '染料串扰', en: 'Crosstalk', group: 'look',
    tip: '染料串扰，0 为无串扰，越大越有胶片染料混色',
    tipEn: 'Dye crosstalk; 0 = none; higher = more dye mixing',
  },
  FM_SATURATION: {
    cn: '饱和度', en: 'Saturation', group: 'look',
    tip: '整体饱和度，1.0 为不变，0 为完全去色',
    tipEn: 'Overall saturation; 1.0 = unchanged; 0 = greyscale',
  },
  FM_WARMTH: {
    cn: '冷暖', en: 'Warmth', group: 'look',
    tip: '冷暖偏移，0 为中性，正数偏暖负数偏冷',
    tipEn: 'Warmth shift; 0 = neutral; positive = warmer; negative = cooler',
  },
  FM_FADE: {
    cn: '褪色', en: 'Fade', group: 'look',
    tip: '褪色，0 为不褪，越大黑位抬升且白位收拢',
    tipEn: 'Fade; 0 = off; higher = lifted blacks and pulled whites',
  },
  FM_SHADOW_BIAS: {
    cn: '暗部青蓝', en: 'Shadow Bias', group: 'look',
    tip: '暗部青蓝偏置，0 为无偏色，越大暗部越偏青蓝',
    tipEn: 'Teal bias in shadows; 0 = none; higher = stronger',
  },
  FM_HIGHLIGHT_BIAS: {
    cn: '高光暖黄', en: 'Highlight Bias', group: 'look',
    tip: '高光暖黄偏置，0 为无偏色，越大高光越偏暖黄',
    tipEn: 'Warm bias in highlights; 0 = none; higher = stronger',
  },
  FM_FILM_S: {
    cn: '软S', en: 'Soft S', group: 'look',
    tip: '负片软S曲线强度，0 为关闭，越大中段过渡越柔',
    tipEn: 'Soft S-curve; 0 = off; higher = softer midtone roll',
  },
  FM_GAMMA_CONTRAST: {
    cn: '正片反S', en: 'Gamma Contrast', group: 'look',
    tip: '正片反S对比强度，0 为关闭，越大反差越硬',
    tipEn: 'Inverse S-curve contrast; 0 = off; higher = harder contrast',
  },
  /* ---- 对数域 look · Schema v1.2 分离色调（5） ---- */
  FM_SPLIT_SHADOW_HUE: {
    cn: '暗部色相', en: 'Split Shadow Hue', group: 'look',
    tip: '暗部染色色相，0 为红 0.33 为绿 0.66 为蓝，需配合暗部饱和使用',
    tipEn: 'Shadow tint hue; 0 red 0.33 green 0.66 blue; pair with shadow saturation',
  },
  FM_SPLIT_SHADOW_SAT: {
    cn: '暗部饱和', en: 'Split Shadow Sat', group: 'look',
    tip: '暗部染色强度，0 为不变，越大暗部越偏所选色相',
    tipEn: 'Shadow tint strength; 0 = unchanged; higher = stronger shadow colour',
  },
  FM_SPLIT_HIGHLIGHT_HUE: {
    cn: '高光色相', en: 'Split Highlight Hue', group: 'look',
    tip: '高光染色色相，0 为红 0.33 为绿 0.66 为蓝，需配合高光饱和使用',
    tipEn: 'Highlight tint hue; 0 red 0.33 green 0.66 blue; pair with highlight saturation',
  },
  FM_SPLIT_HIGHLIGHT_SAT: {
    cn: '高光饱和', en: 'Split Highlight Sat', group: 'look',
    tip: '高光染色强度，0 为不变，越大高光越偏所选色相',
    tipEn: 'Highlight tint strength; 0 = unchanged; higher = stronger highlight colour',
  },
  FM_SPLIT_BALANCE: {
    cn: '分离平衡', en: 'Split Balance', group: 'look',
    tip: '暗部与高光染色的权重平衡，0 为中性，正数偏高光负数偏暗部',
    tipEn: 'Balance between shadow and highlight tint; 0 = neutral; positive = highlights',
  },

  /* ---- R21 质感总强度（1；仅在含质感层的导出形态出现） ----
   * 语义与网页端 params.master 同源：四层质感（光晕/柔光/颗粒/暗角）的强度统一乘它。
   * 默认值 = 配方 master（生成时烘焙；用户配方常见 1.39 这类非 1 值——R20 前该维度被生成器忽略，
   * 导致达芬奇侧整体比网页弱 28% 量级）。 */
  FM_MASTER: {
    cn: '总强度', en: 'Texture Master', group: 'master',
    tip: '质感总强度，同时缩放光晕柔光颗粒暗角四层，1.0 为基准',
    tipEn: 'Texture master gain; scales halation bloom grain and vignette; 1.0 = baseline',
  },

  /* ---- 光晕（14） ---- */
  FM_HALATION_ON: {
    cn: '开关', en: 'Halation On', group: 'halation',
    tip: '光晕总开关，默认关闭，勾选后其余光晕参数才生效',
    tipEn: 'Halation master switch; off by default',
  },
  FM_HALATION_AMOUNT: {
    cn: '强度', en: 'Halation Amount', group: 'halation',
    tip: '光晕叠加强度，0 为无光晕，越大亮部溢光越明显',
    tipEn: 'Halation strength; 0 = none; higher = stronger glow',
  },
  FM_HALATION_RADIUS_PX: {
    cn: '半径px', en: 'Halation Radius Px', group: 'halation',
    tip: '宽晕半径，单位像素，越大溢光铺得越开',
    tipEn: 'Wide halo radius in pixels; higher = wider spread',
  },
  FM_HALATION_TIGHT_PX: {
    cn: '紧晕半径px', en: 'Halation Tight Radius Px', group: 'halation',
    tip: '紧晕半径，单位像素，是贴近高光边缘的第一圈溢光',
    tipEn: 'Tight halo radius in pixels; the ring nearest the highlight',
  },
  FM_HALATION_THRESHOLD: {
    cn: '阈值', en: 'Halation Threshold', group: 'halation',
    tip: '亮通阈值，越高只有更亮的区域才起晕',
    tipEn: 'Bright-pass threshold; higher = only brighter areas glow',
  },
  FM_HALATION_TINT_R: {
    cn: '晕色红', en: 'Halation Tint R', group: 'halation',
    tip: '晕色的红分量，0 为无红，1 为全红',
    tipEn: 'Red component of the halo tint; 0 = none; 1 = full',
  },
  FM_HALATION_TINT_G: {
    cn: '晕色绿', en: 'Halation Tint G', group: 'halation',
    tip: '晕色的绿分量，0 为无绿，1 为全绿',
    tipEn: 'Green component of the halo tint; 0 = none; 1 = full',
  },
  FM_HALATION_TINT_B: {
    cn: '晕色蓝', en: 'Halation Tint B', group: 'halation',
    tip: '晕色的蓝分量，0 为无蓝，1 为全蓝',
    tipEn: 'Blue component of the halo tint; 0 = none; 1 = full',
  },
  FM_HALATION_BG_GAIN: {
    cn: '亮背景压制', en: 'Halation Background Gain', group: 'halation',
    tip: '亮背景压制，1 为不压制，越小亮背景上的光晕越弱',
    tipEn: 'Suppress halation over bright backgrounds; 1 = no suppression',
  },
  FM_HALATION_BLUE_COMP: {
    cn: '冷背景补偿', en: 'Halation Blue Comp', group: 'halation',
    tip: '冷背景补偿，0 为关闭，越大偏冷区域的晕色越强',
    tipEn: 'Blue compensation for cool backgrounds; 0 = off',
  },
  FM_HALATION_HUE: {
    cn: '色相', en: 'Halation Hue', group: 'halation',
    tip: '晕色色相，0.5 为中性，向两侧偏移会改晕色的冷暖',
    tipEn: 'Halo hue; 0.5 = neutral; shifts the glow colour',
  },
  FM_HALATION_IMPACT: {
    cn: '叠加不透明度', en: 'Halation Impact', group: 'halation',
    tip: '光晕叠加的不透明度，1 为全额叠加，越小越轻',
    tipEn: 'Opacity of the halation overlay; 1 = full',
  },
  FM_HALATION_AMPLIFY: {
    cn: '散射敏感度', en: 'Halation Amplify', group: 'halation',
    tip: '散射敏感度，1.0 为基准，越大越偏宽晕',
    tipEn: 'Scatter sensitivity; 1.0 = baseline; higher favours the wide halo',
  },
  FM_HALATION_SMOOTH: {
    cn: '柔光尺度', en: 'Halation Smoothness', group: 'halation',
    tip: '紧晕与宽晕的配比微调，0.5 为中性，越大越平滑',
    tipEn: 'Fine-tunes the tight/wide halo balance; 0.5 = neutral',
  },

  /* ---- 颗粒（7） ---- */
  FM_GRAIN_ON: {
    cn: '开关', en: 'Grain On', group: 'grain',
    tip: '颗粒总开关，默认开启，关闭后画面完全干净',
    tipEn: 'Grain master switch; on by default',
  },
  FM_GRAIN_AMP: {
    cn: '幅度', en: 'Grain Amount', group: 'grain',
    tip: '颗粒幅度，0 为无颗粒，越大颗粒越明显',
    tipEn: 'Grain amplitude; 0 = none; higher = more visible grain',
  },
  FM_GRAIN_SIZE_PX: {
    cn: '间距px', en: 'Grain Size Px', group: 'grain',
    tip: '颗粒间距，单位像素，越大颗粒越粗',
    tipEn: 'Grain spacing in pixels; higher = coarser grain',
  },
  FM_GRAIN_CORRELATION: {
    cn: '相关性', en: 'Grain Correlation', group: 'grain',
    tip: '颗粒通道相关性，1 为三通道同步成单色颗粒，0 为独立彩噪',
    tipEn: 'Channel correlation; 1 = monochrome grain; 0 = independent colour noise',
  },
  FM_GRAIN_SHADOW: {
    cn: '暗部颗粒', en: 'Grain Shadow', group: 'grain',
    tip: '暗部颗粒量，1.0 为基准，越大暗部越粗',
    tipEn: 'Grain in shadows; 1.0 = baseline; higher = coarser shadows',
  },
  FM_GRAIN_MIDTONE: {
    cn: '中间调颗粒', en: 'Grain Midtone', group: 'grain',
    tip: '中间调颗粒量，1.0 为基准，越大中段越粗',
    tipEn: 'Grain in midtones; 1.0 = baseline; higher = coarser midtones',
  },
  FM_GRAIN_HIGHLIGHT: {
    cn: '高光颗粒', en: 'Grain Highlight', group: 'grain',
    tip: '高光颗粒量，1.0 为基准，负片观感通常压得很低',
    tipEn: 'Grain in highlights; 1.0 = baseline; usually kept low',
  },
  /* ---- R9 扫描颗粒团簇（1） ---- */
  FM_GRAIN_CLUSTER: {
    cn: '团簇', en: 'Grain Cluster', group: 'grain',
    tip: '扫描颗粒团簇感，0 为纯随机颗粒，越大颗粒越成团块更像真实扫描',
    tipEn: 'Scan grain clustering; 0 = pure random grain; higher = clumpier',
  },

  /* ---- 柔光（7） ---- */
  FM_BLOOM_ON: {
    cn: '开关', en: 'Bloom On', group: 'bloom',
    tip: '柔光总开关，默认开启',
    tipEn: 'Bloom master switch; on by default',
  },
  FM_BLOOM_AMOUNT: {
    cn: '强度', en: 'Bloom Amount', group: 'bloom',
    tip: '柔光强度，0 为无柔光，越大高光扩散越强',
    tipEn: 'Bloom strength; 0 = none; higher = stronger diffusion',
  },
  FM_BLOOM_RADIUS_PX: {
    cn: '半径px', en: 'Bloom Radius Px', group: 'bloom',
    tip: '柔光半径，单位像素，越大光晕越弥散',
    tipEn: 'Bloom radius in pixels; higher = more diffuse',
  },
  FM_BLOOM_THRESHOLD: {
    cn: '阈值', en: 'Bloom Threshold', group: 'bloom',
    tip: '亮通阈值，越高只有高光参与扩散',
    tipEn: 'Bright-pass threshold; higher = only highlights diffuse',
  },
  FM_BLOOM_SAVE_LIGHTS: {
    cn: '高光保护', en: 'Bloom Save Lights', group: 'bloom',
    tip: '高光保护，0 为不保护，越大越压住接近纯白的区域',
    tipEn: 'Highlight protection; 0 = off; higher = holds back near-white areas',
  },
  FM_BLOOM_DETAILS: {
    cn: '光源分配', en: 'Bloom Details', group: 'bloom',
    tip: '大小光源的分配，0.5 为中性，偏小光源更细腻，偏大光源更铺开',
    tipEn: 'Balance between small and large light sources; 0.5 = neutral',
  },
  FM_BLOOM_SATURATION: {
    cn: '饱和', en: 'Bloom Saturation', group: 'bloom',
    tip: '柔光饱和度，1.0 为保持原饱和度，0 为柔光完全去色',
    tipEn: 'Saturation of the bloom; 1.0 = unchanged; 0 = desaturated',
  },

  /* ---- 暗角（4） ---- */
  FM_VIGNETTE_ON: {
    cn: '开关', en: 'Vignette On', group: 'vignette',
    tip: '暗角总开关，默认关闭',
    tipEn: 'Vignette master switch; off by default',
  },
  FM_VIGNETTE_AMOUNT: {
    cn: '强度', en: 'Vignette Amount', group: 'vignette',
    tip: '暗角强度，0 为无暗角，越大四角越暗',
    tipEn: 'Vignette strength; 0 = none; higher = darker corners',
  },
  FM_VIGNETTE_RADIUS: {
    cn: '半径', en: 'Vignette Radius', group: 'vignette',
    tip: '暗角范围，1.0 为基准，越小暗角越向中心收',
    tipEn: 'Vignette extent; 1.0 = baseline; smaller = tighter to the centre',
  },
  FM_VIGNETTE_CHROMA_PX: {
    cn: '边缘色散px', en: 'Vignette Chroma Px', group: 'vignette',
    tip: '边缘色散，单位像素，0 为无色散，越大四角彩边越明显',
    tipEn: 'Lateral chromatic shift in pixels; 0 = none; higher = stronger',
  },

  /* ---- R9 片门抖动（2） ---- */
  FM_GATE_WEAVE_PX: {
    cn: '位移px', en: 'Gate Weave Px', group: 'gate_weave',
    tip: '片门抖动幅度，单位像素，0 为不抖动，越大逐帧位移越明显',
    tipEn: 'Gate weave amplitude in pixels; 0 = static; higher = more shake',
  },
  FM_GATE_WEAVE_SPEED: {
    cn: '速度', en: 'Gate Weave Speed', group: 'gate_weave',
    tip: '片门抖动速度，单位相位每秒，默认 1.0，越大抖动越快',
    tipEn: 'Gate weave speed in cycles per second; 1.0 = default; higher = faster',
  },
};

/** 取参数的文案表条目（缺失即抛：宁可生成失败，也不要静默出无标签滑杆） */
export function paramText(macro: string): ParamText {
  const t = PARAM_TEXT[macro];
  if (!t) throw new Error(`DCTL 标签表缺少参数 ${macro} 的文案（labels.ts / textureParamDecls 不同步）`);
  return t;
}

/** 拼标准模式标签：`分组前缀 + 中文短名 + 空格 + 英文名`（look 组无前缀） */
export function composeLabel(t: ParamText, groupPrefix = true): string {
  const prefix = groupPrefix ? GROUP_PREFIX[t.group] : '';
  return `${prefix}${t.cn} ${t.en}`;
}

/** 按 groupPrefix 开关调整既有标签：缺前缀就补、多前缀就剥（幂等，手写声明也安全） */
export function applyGroupPrefix(label: string, group: ParamGroup, on: boolean): string {
  const prefix = GROUP_PREFIX[group];
  if (!prefix) return label;
  if (on) return label.startsWith(prefix) ? label : prefix + label;
  return label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

/** 兼容模式（ASCII）的 tooltip：没有 tipEn 时退化为英文名，保证不出现未验证字符 */
export function asciiTip(p: { macro: string; en: string; tipEn?: string }): string {
  return p.tipEn ?? p.en ?? p.macro;
}
