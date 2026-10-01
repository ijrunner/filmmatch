/**
 * XMP 预设解析器（R15）：Lightroom / ACR 预设（crs:* 方言）→ 中间表示 IR。
 *
 * 纯函数、无 DOM 依赖（vitest node 直接跑）。只依赖字符串处理，不上完整 XML 解析器。
 *
 * 支持两种方言（同一文件内可混用，元素式优先于属性式）：
 *  a) 属性式：<rdf:Description crs:Exposure2012="+0.5" crs:Contrast2012="+15" ...>
 *     （容忍属性值内换行、+/− 前缀、空字符串值、单/双引号）
 *  b) 元素式：<crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li>...</rdf:Seq></crs:ToneCurvePV2012>
 *     （曲线点列与同名多值 rdf:Alt / rdf:Seq / rdf:Bag 都是这种）
 *
 * 合规：本文件只含键名与解析逻辑，不含任何真实样本内容；单测一律用合成 fixture。
 * 风险对策（迭代计划 R15）：解析器宽松 + 显式 unrecognizedKeys 计数，方言差异可人工复核。
 */

/* ---------------- IR 定义 ---------------- */

/** 色调曲线点（0..255 域，与 XMP 原始数值一致） */
export interface XmpCurvePoint {
  x: number;
  y: number;
}

/** 单个色相的 HSL 调整（−100..100，缺省 = undefined = 预设未写该键） */
export interface XmpHslChannel {
  hue?: number;
  saturation?: number;
  luminance?: number;
}

/** HSL 8 色相（R18 计划接管的维度，先如实保留） */
export interface XmpHsl {
  red: XmpHslChannel;
  orange: XmpHslChannel;
  yellow: XmpHslChannel;
  green: XmpHslChannel;
  aqua: XmpHslChannel;
  blue: XmpHslChannel;
  purple: XmpHslChannel;
  magenta: XmpHslChannel;
}

/** 相机校准（Calibration 面板；R18 计划接管的维度） */
export interface XmpCalibration {
  shadowTint?: number;
  redHue?: number;
  redSaturation?: number;
  greenHue?: number;
  greenSaturation?: number;
  blueHue?: number;
  blueSaturation?: number;
}

/** XMP 预设中间表示：全部数值化（原始字符串同时保留在 raw 里） */
export interface XmpIR {
  /** crs:Name 的 x-default 文本（如有） */
  name?: string;
  processVersion?: string;
  cameraProfile?: string;

  /* —— 基础影调 —— */
  exposure2012?: number;      // ±5
  contrast2012?: number;      // −100..100
  highlights2012?: number;    // −100..100
  shadows2012?: number;       // −100..100
  whites2012?: number;        // −100..100
  blacks2012?: number;        // −100..100

  /* —— 参数曲线（Parametric）—— */
  parametricShadows?: number;       // −100..100
  parametricDarks?: number;
  parametricLights?: number;
  parametricHighlights?: number;
  parametricShadowSplit?: number;   // 0..100（LR 默认 25）
  parametricMidtoneSplit?: number;  // 0..100（默认 50）
  parametricHighlightSplit?: number;// 0..100（默认 75）

  /* —— 点曲线（0..255 域点列；空数组 = 预设未写/恒等） —— */
  toneCurvePV2012: XmpCurvePoint[];
  toneCurvePV2012Red: XmpCurvePoint[];
  toneCurvePV2012Green: XmpCurvePoint[];
  toneCurvePV2012Blue: XmpCurvePoint[];

  /* —— 分离色调（与 FilmMatch Schema v1.2 split_* 几乎一一对应）—— */
  splitToningShadowHue?: number;          // 0..360
  splitToningShadowSaturation?: number;   // 0..100
  splitToningHighlightHue?: number;       // 0..360
  splitToningHighlightSaturation?: number;// 0..100
  splitToningBalance?: number;            // −100..100

  /* —— 颗粒 —— */
  grainAmount?: number;      // 0..100
  grainSize?: number;        // 0..100（LR 默认 25）
  grainFrequency?: number;   // 0..100（默认 50；越高颗粒越细）
  grainSeed?: number;

  /* —— 暗角（裁剪后）—— */
  postCropVignetteAmount?: number;    // −100..100（负=压暗角落，正=提亮）
  postCropVignetteMidpoint?: number;  // 0..100（默认 50）
  postCropVignetteFeather?: number;   // 0..100（默认 50）

  /* —— 全局色彩 —— */
  saturation?: number;             // −100..100
  vibrance?: number;               // −100..100
  incrementalTemperature?: number; // −100..100（+ = 暖）
  incrementalTint?: number;        // −100..100（绿-品红轴）

  /* —— R18 维度（先如实解析、映射侧标 unmapped）—— */
  hsl: XmpHsl;
  calibration: XmpCalibration;
  /** 黑白转换开关（ConvertToGrayscale='True'） */
  convertToGrayscale?: boolean;
  /** 黑白混色通道（GrayMixer*，映射侧标 unmapped） */
  grayMixer: Record<string, number>;

  /* —— 解析诊断 —— */
  /** 解析到的 crs:* 键总数（含元数据键） */
  keyCount: number;
  /** crs:* 里既非已知设置键也非已知元数据键的键名（方言差异显式暴露，供人工复核） */
  unrecognizedKeys: string[];
  /** 全部 crs:* 原始字符串（保真，供调试与后续轮次增量接管） */
  raw: Record<string, string>;
}

function emptyHsl(): XmpHsl {
  return {
    red: {}, orange: {}, yellow: {}, green: {},
    aqua: {}, blue: {}, purple: {}, magenta: {},
  };
}

/* ---------------- 键清单 ---------------- */

/** 数值设置键 → IR 字段名 */
const NUMERIC_KEYS: Record<string, string> = {
  Exposure2012: 'exposure2012',
  Contrast2012: 'contrast2012',
  Highlights2012: 'highlights2012',
  Shadows2012: 'shadows2012',
  Whites2012: 'whites2012',
  Blacks2012: 'blacks2012',
  ParametricShadows: 'parametricShadows',
  ParametricDarks: 'parametricDarks',
  ParametricLights: 'parametricLights',
  ParametricHighlights: 'parametricHighlights',
  ParametricShadowSplit: 'parametricShadowSplit',
  ParametricMidtoneSplit: 'parametricMidtoneSplit',
  ParametricHighlightSplit: 'parametricHighlightSplit',
  SplitToningShadowHue: 'splitToningShadowHue',
  SplitToningShadowSaturation: 'splitToningShadowSaturation',
  SplitToningHighlightHue: 'splitToningHighlightHue',
  SplitToningHighlightSaturation: 'splitToningHighlightSaturation',
  SplitToningBalance: 'splitToningBalance',
  GrainAmount: 'grainAmount',
  GrainSize: 'grainSize',
  GrainFrequency: 'grainFrequency',
  GrainSeed: 'grainSeed',
  PostCropVignetteAmount: 'postCropVignetteAmount',
  PostCropVignetteMidpoint: 'postCropVignetteMidpoint',
  PostCropVignetteFeather: 'postCropVignetteFeather',
  Saturation: 'saturation',
  Vibrance: 'vibrance',
  IncrementalTemperature: 'incrementalTemperature',
  IncrementalTint: 'incrementalTint',
  ShadowTint: 'calibration.shadowTint',
  RedHue: 'calibration.redHue',
  RedSaturation: 'calibration.redSaturation',
  GreenHue: 'calibration.greenHue',
  GreenSaturation: 'calibration.greenSaturation',
  BlueHue: 'calibration.blueHue',
  BlueSaturation: 'calibration.blueSaturation',
};

/** HSL 8 色相 × 3 通道 */
const HSL_COLORS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'] as const;
const HSL_PREFIXES = ['HueAdjustment', 'SaturationAdjustment', 'LuminanceAdjustment'] as const;

/** 点曲线键 */
const CURVE_KEYS = new Set([
  'ToneCurvePV2012', 'ToneCurvePV2012Red', 'ToneCurvePV2012Green', 'ToneCurvePV2012Blue',
]);

/** 字符串设置键 */
const STRING_KEYS = new Set(['ProcessVersion', 'CameraProfile']);

/** 名称键（x-default 文本） */
const NAME_KEY = 'Name';

/** 已知元数据/技术键：刻意不映射、也不算「未识别」（避免噪声淹没真方言差异） */
const KNOWN_IGNORED = new Set([
  'PresetType', 'Cluster', 'UUID', 'Version', 'ShortName', 'SortName', 'Group', 'AnonymousLookUUID',
  'Look', 'Parameters', 'LookTableUUID', 'HasSettings',
  'SupportsAmount', 'SupportsColor', 'SupportsMonochrome', 'SupportsHighDynamicRange',
  'SupportsNormalDynamicRange', 'SupportsSceneReferred', 'SupportsOutputReferred',
  'CameraModelRestriction', 'CameraProfileDigest', 'Copyright', 'ContactInfo', 'AuthorTitle',
  'WhiteBalance', 'Temperature', 'Tint',
  'ToneCurveName', 'ToneCurveName2012', 'ParametricCurveName',
  'Sharpness', 'SharpenRadius', 'SharpenDetail', 'SharpenEdgeMasking',
  'LuminanceSmoothing', 'ColorNoiseReduction', 'ColorNoiseReductionDetail', 'ColorNoiseReductionSmoothness',
  'LuminanceNoiseReductionDetail', 'LuminanceNoiseReductionContrast', 'LuminanceNoiseReductionShadow',
  'VignetteAmount', 'VignetteMidpoint', 'VignetteFeather', 'VignetteRoundness',
  'VignetteStyle', 'VignetteHighlightContrast', 'VignetteHighlightContrastRange',
  'PostCropVignetteRoundness', 'PostCropVignetteStyle', 'PostCropVignetteStyleStrength',
  'PostCropVignetteHighlightContrast', 'PostCropVignetteHighlightContrastRange',
  /* 镜头/几何/去边等非观感校正 */
  'AutoLateralCA', 'OverrideLookVignette', 'CropConstrainToWarp',
  'LensProfileEnable', 'LensProfileSetup', 'LensProfileDistortionScale', 'LensProfileChromaticAberrationScale',
  'LensProfileVignettingScale', 'LensManualDistortionAmount', 'LensManualScale',
  'PerspectiveVertical', 'PerspectiveHorizontal', 'PerspectiveRotate', 'PerspectiveScale',
  'PerspectiveAspect', 'PerspectiveUpright', 'PerspectiveX', 'PerspectiveY',
  'DefringePurpleAmount', 'DefringePurpleHueLo', 'DefringePurpleHueHi',
  'DefringeGreenAmount', 'DefringeGreenHueLo', 'DefringeGreenHueHi',
  'GradientBasedCorrections', 'CorrectionAmount', 'CorrectionActive',
  'What', 'Type', 'MaskValue', 'ZeroX', 'ZeroY', 'FullX', 'FullY',
]);

/* ---------------- 基础工具 ---------------- */

/** "+0.5" → 0.5；"" / 非数 → undefined（键存在但无有效数值时保持 absent 语义） */
function parseNum(v: string): number | undefined {
  const t = v.trim();
  if (!t) return undefined;
  const n = Number(t.replace(/^\+/, ''));
  return Number.isFinite(n) ? n : undefined;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** 松散标签配对检查：剥掉注释与属性值后做开/闭栈匹配（宽松判断，只拦明显损坏） */
function assertTagBalance(text: string): void {
  const stripped = text.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
  const tagRe = /<(\/?)([A-Za-z][\w.:-]*)((?:\s[^<>]*)?)(\/?)>/g;
  const stack: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(stripped)) !== null) {
    const [, close, name] = m;
    /* 自闭合判定看完整匹配文本结尾（贪婪的属性组会吃掉「/」，不能依赖捕获组） */
    if (m[0].endsWith('/>')) continue;
    if (close) {
      const top = stack.pop();
      if (top !== name) {
        throw new Error(
          `XMP 疑似损坏：标签不配对（期望 </${top ?? '无'}>，遇到 </${name}>）。文件可能被截断或手工编辑过。`,
        );
      }
    } else {
      stack.push(name);
    }
  }
  if (stack.length > 0) {
    throw new Error(`XMP 疑似损坏：存在 ${stack.length} 个未闭合标签（${stack.slice(0, 4).join(', ')}…）。文件可能被截断。`);
  }
}

/** 把 "0, 0, 128, 118" 或 li 列表拼接串（项间以 \u0001 分隔）切成 (x,y) 点列；丢弃不成对的尾部数字 */
function parseCurvePoints(joined: string): XmpCurvePoint[] {
  const nums: number[] = [];
  for (const tok of joined.split(/[,\s\u0001]+/)) {
    if (!tok) continue;
    const n = Number(tok);
    if (Number.isFinite(n)) nums.push(n);
  }
  const pts: XmpCurvePoint[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
  return pts;
}

/** 元素体 → 文本值列表：rdf:Seq/Bag/Alt 取 li 列表（Alt 优先 x-default），否则整段标量文本 */
function parseElementBody(body: string): string[] {
  if (/<rdf:(Seq|Bag|Alt)\b/.test(body)) {
    const liRe = /<rdf:li\b([^>]*)>([\s\S]*?)<\/rdf:li>/g;
    const plain: string[] = [];
    const xDefault: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = liRe.exec(body)) !== null) {
      const attrs = m[1] ?? '';
      const text = m[2].trim();
      if (/x-default/.test(attrs)) xDefault.push(text);
      else plain.push(text);
    }
    return xDefault.length > 0 ? [...xDefault, ...plain] : plain;
  }
  return [body.trim()];
}

/* ---------------- 主解析 ---------------- */

/**
 * 解析 XMP 预设文本 → IR。
 * 可读错误（throw Error，中文）：
 *  - 空 / 非 XMP 文本（无 xmpmeta、无 rdf）；
 *  - XML 明显损坏（标签不配对 / 未闭合，宽松判断）；
 *  - 合法 XML 但完全没有 crs: 键（不是相机原始预设）。
 */
export function parseXmp(text: string): XmpIR {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('无法解析：输入为空，不是有效的 XMP 文本。');
  }
  if (!/xmpmeta/i.test(text) && !/rdf/i.test(text)) {
    throw new Error('无法解析：输入不是 XMP 文本（未找到 xmpmeta 或 rdf 节点）。请确认文件为 Lightroom / ACR 导出的预设 XMP。');
  }

  const noComments = text.replace(/<!--[\s\S]*?-->/g, '');
  assertTagBalance(noComments);

  /* 1) 属性式：crs:Key="value" / crs:Key='value'（值可含换行） */
  const values = new Map<string, string>();
  const attrRe = /\bcrs:([A-Za-z][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(noComments)) !== null) {
    values.set(m[1], m[2] !== undefined ? m[2] : (m[3] ?? ''));
  }

  /* 2) 元素式：<crs:Key> ... </crs:Key>（曲线点列 / Alt 名称）；有实质内容时覆盖属性式 */
  const elemRe = /<crs:([A-Za-z][A-Za-z0-9_]*)((?:\s[^<>]*?)?)(\/)?>([\s\S]*?)<\/crs:\1>/g;
  while ((m = elemRe.exec(noComments)) !== null) {
    if (m[3]) continue; // 自闭合无内容
    const key = m[1];
    const items = parseElementBody(m[4] ?? '');
    const meaningful = items.filter((s) => s.length > 0);
    if (meaningful.length > 0) values.set(key, meaningful.join('\u0001'));
  }

  if (values.size === 0) {
    throw new Error('无法解析：XMP 结构合法，但未找到任何 crs: 设置键——这不是相机原始/Lightroom 预设（可能是照片元数据 XMP）。');
  }

  const ir: XmpIR = {
    toneCurvePV2012: [],
    toneCurvePV2012Red: [],
    toneCurvePV2012Green: [],
    toneCurvePV2012Blue: [],
    hsl: emptyHsl(),
    calibration: {},
    grayMixer: {},
    keyCount: values.size,
    unrecognizedKeys: [],
    raw: {},
  };

  for (const [key, rawValue] of values) {
    ir.raw[key] = rawValue;

    if (key === NAME_KEY) {
      const name = rawValue.split('\u0001').map((s) => s.trim()).filter((s) => s.length > 0)[0];
      if (name) ir.name = name;
      continue;
    }
    if (key === 'ConvertToGrayscale') {
      const t = rawValue.trim().toLowerCase();
      if (t === 'true' || t === '1') ir.convertToGrayscale = true;
      continue;
    }
    if (key.startsWith('GrayMixer')) {
      const n = parseNum(rawValue);
      if (n !== undefined) ir.grayMixer[key] = n;
      continue;
    }
    if (CURVE_KEYS.has(key)) {
      const pts = parseCurvePoints(rawValue);
      if (key === 'ToneCurvePV2012') ir.toneCurvePV2012 = pts;
      else if (key === 'ToneCurvePV2012Red') ir.toneCurvePV2012Red = pts;
      else if (key === 'ToneCurvePV2012Green') ir.toneCurvePV2012Green = pts;
      else ir.toneCurvePV2012Blue = pts;
      continue;
    }
    if (STRING_KEYS.has(key)) {
      const s = rawValue.trim();
      if (s) {
        if (key === 'ProcessVersion') ir.processVersion = s;
        else ir.cameraProfile = s;
      }
      continue;
    }

    const numKey = NUMERIC_KEYS[key];
    if (numKey) {
      const n = parseNum(rawValue);
      if (n !== undefined) {
        if (numKey.startsWith('calibration.')) {
          (ir.calibration as Record<string, number>)[numKey.slice('calibration.'.length)] = n;
        } else {
          (ir as unknown as Record<string, number>)[numKey] = n;
        }
      }
      continue;
    }

    /* HSL 8 色相 × 3 通道 */
    let matched = false;
    for (const prefix of HSL_PREFIXES) {
      if (!key.startsWith(prefix)) continue;
      const color = key.slice(prefix.length);
      if (!(HSL_COLORS as readonly string[]).includes(color)) continue;
      const channel = ir.hsl[color.toLowerCase() as keyof XmpHsl];
      const n = parseNum(rawValue);
      if (n !== undefined) {
        if (prefix === 'HueAdjustment') channel.hue = n;
        else if (prefix === 'SaturationAdjustment') channel.saturation = n;
        else channel.luminance = n;
      }
      matched = true;
      break;
    }
    if (matched) continue;

    if (KNOWN_IGNORED.has(key)) continue;
    ir.unrecognizedKeys.push(key);
  }

  return ir;
}

/* ---------------- 曲线求值（供映射侧与测试共用的最小工具） ---------------- */

/**
 * 点曲线 → 求值函数：输入 x ∈ 0..1（×255 折算到点列域），线性插值，
 * 首末点之外按端点值钳制；输出 0..1。点列少于 2 个或 x 全等时返回 null（不可用）。
 */
export function curveToFn(points: XmpCurvePoint[]): ((x: number) => number) | null {
  if (points.length < 2) return null;
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const minX = sorted[0].x;
  const maxX = sorted[sorted.length - 1].x;
  if (!(maxX > minX)) return null;
  return (x01: number): number => {
    const x = clamp01(x01) * 255;
    if (x <= minX) return clamp01(sorted[0].y / 255);
    if (x >= maxX) return clamp01(sorted[sorted.length - 1].y / 255);
    for (let i = 1; i < sorted.length; i++) {
      if (x <= sorted[i].x) {
        const a = sorted[i - 1], b = sorted[i];
        const t = (x - a.x) / Math.max(1e-9, b.x - a.x);
        return clamp01((a.y + (b.y - a.y) * t) / 255);
      }
    }
    return clamp01(sorted[sorted.length - 1].y / 255);
  };
}
