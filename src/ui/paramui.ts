/**
 * 参数面板共享规格（④ 调配方滑杆组 + 图库标注编辑器复用同一份参数定义）。
 * 从 main.ts 抽出：SpecParam/SpecGroup 描述「组-参数-滑杆区间/单位」，
 * 渲染端各自实现（工作台绑 store，标注编辑器绑条目工作副本），数值格式化共用。
 */

export interface SpecParam {
  k: string; label: string; min: number; max: number; step: number; unit?: string;
  fmt?: (v: number) => string;
  /** color=取色器；select=枚举下拉（Schema v1.1 的 grain.type / grain.mode） */
  type?: 'color' | 'select';
  /** type=select 时的选项（value 写入参数对象，label 展示） */
  options?: { value: string; label: string }[];
}
export interface SpecGroup {
  id: string; name: string; en: string;
  kind: 'color' | 'texture' | 'look' | 'master';
  open?: boolean; params: SpecParam[];
}

export const COLOR_GROUP: SpecGroup = {
  id: 'color', name: '色彩匹配', en: 'match · 9 参数', kind: 'color', open: true, params: [
    { k: 'match_strength', label: '匹配强度', min: 0, max: 1, step: 0.01 },
    { k: 'skin_hue', label: '肤色色相', min: -1, max: 1, step: 0.01 },
    { k: 'skin_sat', label: '肤色饱和', min: 0, max: 2, step: 0.01 },
    { k: 'skin_isolation', label: '肤色保护', min: 0, max: 1, step: 0.01 },
    { k: 'split_tone', label: '分离色调', min: 0, max: 1, step: 0.01 },
    { k: 'tone_contrast', label: '中间调对比', min: 0, max: 2, step: 0.01 },
    { k: 'shadow_lift', label: '黑位提升', min: 0, max: 1, step: 0.01 },
    { k: 'global_sat', label: '全局饱和', min: 0, max: 2, step: 0.01 },
    { k: 'highlight_rolloff', label: '高光滚降', min: 0, max: 1, step: 0.01 },
  ],
};

/** 质感四组（halation/grain/bloom/vignette），工作台与标注编辑器共用 */
export const TEXTURE_GROUPS: SpecGroup[] = [
  { id: 'halation', name: '光晕', en: 'halation', kind: 'texture', params: [
    { k: 'amount', label: '强度', min: 0, max: 1, step: 0.01 },
    { k: 'radius', label: '半径', min: 0.2, max: 5, step: 0.05, unit: ' %H' },
    { k: 'threshold', label: '阈值', min: 0.3, max: 1, step: 0.01 },
    { k: 'tint_rgb', label: '染色', min: 0, max: 1, step: 0.01, type: 'color' },
    /* —— Schema v1.1（默认=恒等，见 docs/prd/配方Schema-v1.1.md）—— */
    { k: 'background_gain', label: '背景增益', min: 0, max: 1, step: 0.01 },
    { k: 'amplify', label: '散射敏感度', min: 0, max: 2, step: 0.05 },
    { k: 'impact', label: '叠加不透明度', min: 0, max: 1, step: 0.01 },
    { k: 'hue', label: '绿层灵敏度', min: 0, max: 1, step: 0.01 },
    { k: 'blue_comp', label: '冷背景补偿', min: 0, max: 1, step: 0.01 },
    { k: 'smoothness', label: '大小光源分配', min: 0, max: 1, step: 0.01 },
  ]},
  { id: 'grain', name: '颗粒', en: 'grain', kind: 'texture', params: [
    { k: 'iso', label: '感光度', min: 25, max: 3200, step: 1, fmt: (v) => 'ISO ' + Math.round(v) + '（' + Math.sqrt(v / 400).toFixed(2) + '×）' },
    { k: 'size', label: '尺寸', min: 0.4, max: 5, step: 0.05, unit: ' ‰H' },
    { k: 'correlation', label: '通道相关', min: 0, max: 1, step: 0.01 },
    { k: 'shadow_weight', label: '暗部加权', min: 0, max: 1, step: 0.01 },
    /* —— Schema v1.1 —— */
    { k: 'shadow', label: '阴影段', min: 0, max: 3, step: 0.05 },
    { k: 'midtone', label: '中间调段', min: 0, max: 3, step: 0.05 },
    { k: 'highlight', label: '高光段', min: 0, max: 3, step: 0.05 },
    { k: 'film_resolution', label: '乳剂分辨率', min: 0, max: 1, step: 0.01 },
    { k: 'type', label: '颗粒算法', min: 0, max: 1, step: 1, type: 'select', options: [
      { value: 'negative', label: '负片' }, { value: 'positive', label: '正片' },
    ]},
    { k: 'mode', label: '颗粒模式', min: 0, max: 1, step: 1, type: 'select', options: [
      { value: 'analogue', label: '絮状' }, { value: 'noise', label: '白噪声' },
    ]},
    /* —— R9 质感深度 —— */
    { k: 'cluster', label: '颗粒团簇', min: 0, max: 1, step: 0.01 },
  ]},
  { id: 'bloom', name: '柔光', en: 'bloom', kind: 'texture', params: [
    { k: 'amount', label: '强度', min: 0, max: 1, step: 0.01 },
    { k: 'radius', label: '半径', min: 0.5, max: 8, step: 0.05, unit: ' %H' },
    { k: 'threshold', label: '阈值', min: 0.5, max: 1, step: 0.01 },
    /* —— Schema v1.1 —— */
    { k: 'save_lights', label: '高光保护', min: 0, max: 1, step: 0.01 },
    { k: 'details', label: '大小光源分配', min: 0, max: 1, step: 0.01 },
    { k: 'saturation', label: '效果饱和', min: 0, max: 1, step: 0.01 },
  ]},
  { id: 'vignette', name: '暗角色散', en: 'vignette · CA', kind: 'texture', params: [
    { k: 'amount', label: '暗角强度', min: 0, max: 1, step: 0.01 },
    { k: 'radius', label: '起始半径', min: 0.5, max: 2, step: 0.01 },
    { k: 'chroma_shift', label: '边缘色散', min: 0, max: 0.02, step: 0.001 },
  ]},
  /* —— R9 质感深度：片门抖动（amount=0 默认恒等/关闭）—— */
  { id: 'gate_weave', name: '片门抖动', en: 'gate weave', kind: 'texture', params: [
    { k: 'amount', label: '抖动幅度', min: 0, max: 0.02, step: 0.0005, unit: ' 画面高度比' },
    { k: 'speed', label: '抖动速度', min: 0, max: 4, step: 0.05 },
  ]},
];

export const LOOK_GROUP: SpecGroup = {
  id: 'look', name: '复古褪色', en: 'look', kind: 'look', open: false, params: [
    { k: 'fade', label: '褪色总量', min: 0, max: 1, step: 0.01 },
    { k: 'black_lift', label: '黑位提升', min: 0, max: 0.2, step: 0.005 },
    { k: 'dye_coupling', label: '染料耦合', min: 0, max: 0.4, step: 0.01 },
    /* —— R18 染料串扰六系数（k = 输出通道 × 输入通道；仅进阶模式，简单模式不露）——
     * 数据行走既有渲染路径；k 为 'coupling.rg' 点路径（main.ts 的 get/set 支持一层嵌套）。 */
    { k: 'coupling.rg', label: '串扰 R←G', min: 0, max: 1.5, step: 0.01 },
    { k: 'coupling.rb', label: '串扰 R←B', min: 0, max: 1.5, step: 0.01 },
    { k: 'coupling.gr', label: '串扰 G←R', min: 0, max: 1.5, step: 0.01 },
    { k: 'coupling.gb', label: '串扰 G←B', min: 0, max: 1.5, step: 0.01 },
    { k: 'coupling.br', label: '串扰 B←R', min: 0, max: 1.5, step: 0.01 },
    { k: 'coupling.bg', label: '串扰 B←G', min: 0, max: 1.5, step: 0.01 },
    { k: 'shadow_bias', label: '暗部青蓝', min: 0, max: 1, step: 0.01 },
    { k: 'highlight_bias', label: '高光暖黄', min: 0, max: 1, step: 0.01 },
    { k: 'film_s', label: '软S曲线', min: 0, max: 1, step: 0.01 },
    { k: 'contrast', label: '正片反S', min: 0, max: 1, step: 0.01 },
    { k: 'saturation', label: '饱和度', min: 0, max: 1.4, step: 0.01 },
    { k: 'warmth', label: '冷暖偏移', min: -1, max: 1, step: 0.02 },
  ],
};

export const MASTER_GROUP: SpecGroup = {
  id: 'master', name: '全局强度', en: 'master', kind: 'master', params: [
    { k: 'master', label: '全部质感层', min: 0, max: 2, step: 0.01, unit: '×' },
  ],
};

/** 工作台面板顺序（与 v0 布局一致） */
export const GROUPS: SpecGroup[] = [COLOR_GROUP, ...TEXTURE_GROUPS, LOOK_GROUP, MASTER_GROUP];

export function fmtVal(p: SpecParam, v: number): string {
  if (p.fmt) return p.fmt(v);
  const dec = (p.step.toString().split('.')[1] || '').length;
  return (+v).toFixed(dec) + (p.unit || '');
}

export function rgbToHex(a: number[]): string {
  return '#' + a.map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}
export function hexToRgb(hx: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hx.slice(i, i + 2), 16) / 255) as [number, number, number];
}
