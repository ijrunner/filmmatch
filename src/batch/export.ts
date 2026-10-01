/**
 * 批量导出打包：逐段 CDL（json/csv）+ 统一风格层 .cube + DCTL（可选，单个或逐段）
 * + 挂载脚本 + 三份说明文档，再打成一个可被标准工具解压的最小 ZIP（store 无压缩 + CRC32）。
 *
 * 两种导出模式（mode，默认 'cdl'）：
 *   'cdl'    —— R6 形态：单个统一 .dctl（look + 质感），匹配仍走逐段 CDL 节点。
 *               包内 7 个文件；另给 dctl 时 8 个：
 *               cdl.json / cdl.csv / <code>.cube / [<code>.dctl] / <code>_mount.py /
 *               免费版手录说明.md / 参数对照表.md / 首次上手清单.md
 *   'single' —— R7 形态：**逐段单节点 DCTL**（匹配内联进 DCTL，一个节点完成匹配 + look + 质感），
 *               dctls[] 里每段一个 .dctl（替代 dctl 条目，两者不并存）。包内 7 + N 个文件
 *               （N = 逐段 DCTL 个数，通常 = 段数）：
 *               cdl.json / cdl.csv / <code>.cube / <N 个 .dctl> / <code>_mount.py /
 *               免费版手录说明.md / 参数对照表.md / 首次上手清单.md
 *   .cube 与 _mount.py 在 single 模式下保留为**兜底路线**（连 DCTL 都用不了时）的物料；
 *   文档措辞随模式切换，避免出现自相矛盾的节点链。
 *
 * 为什么自己写 ZIP：工程无第三方依赖，导出包只需「存储」模式即可，
 * 手写本地头/中央目录/EOCD 足以被系统解压器识别，且完全可控、可单测回读。
 *
 * 为什么本模块不 import src/dctl/*：批量包只需把 .dctl 当**文本**装进 zip，不需要 DCTL 数学；
 * 参数摘要（DctlParamSummary）由调用方传入（UI 侧调 generateDctl 后原样给），
 * 这样 batch 包与 DCTL 生成器解耦，DCTL 侧接口变动不会波及导出链。
 *
 * 品牌约定：脚本与文档只出现「达芬奇」，不出现任何第三方品牌/胶片商标。
 */
import { LUT3D, toCube } from '../engine/lut';
import { Cdl, CdlEntry, cdlToCsv, cdlToJson } from './cdl';

/**
 * 单个 DCTL 面板参数的摘要（**调用方传入**，本模块不依赖 src/dctl/*）。
 * 与 DCTL 生成器的 DctlParamDecl 结构兼容（子集），可直接把 res.params 传进来；
 * 所有可选字段缺失时文档仍能生成（group 缺失按「其他」归组、tip 缺失写「—」）。
 */
export interface DctlParamSummary {
  macro: string;
  label: string;
  type: 'float' | 'int' | 'bool';
  def: number | boolean;
  min?: number;
  max?: number;
  /** 'look' | 'halation' | 'bloom' | 'grain' | 'vignette'；缺失或未知按「其他」归组 */
  group?: string;
  /** 一句话说明（可选） */
  tip?: string;
}

export interface BatchPackInput {
  recipeName: string;
  shareCode: string;
  lutSize: 33 | 65;
  /** 统一风格层烘焙结果（engine/lut 的 LUT3D） */
  lut: LUT3D;
  entries: CdlEntry[];
  strategy: 'A' | 'B';
  createdAt: string;
  /** 可选：该配方的 .dctl（look + 质感全层）与参数摘要，用于并入包与生成滑杆对照表 */
  dctl?: {
    fileName: string;
    source: string;
    params?: DctlParamSummary[];
    pipeline?: string;
    compat?: boolean;
  };
  /** 导出模式（默认 'cdl'，与 R6 完全一致）。
   *  'single' = 逐段单节点 DCTL：每段一个 .dctl（匹配 + look + 质感），文档与节点链随之切换。 */
  mode?: BatchPackMode;
  /** 逐段单节点 DCTL（single 模式）：**替代** `dctl` 条目，两者不会同时进包。
   *  顺序必须与 `entries` 一致（第 i 个 dctl 对应第 i 段），文档的逐段对照表按此配对。
   *  只给 dctls 不给 mode 时按 'single' 处理（逐段 DCTL 存在本身即代表该模式）。 */
  dctls?: BatchSegDctl[];
}

/** 批量包导出模式：'cdl' = 单个统一 DCTL + 逐段 CDL（R6）；'single' = 逐段单节点 DCTL（R7） */
export type BatchPackMode = 'cdl' | 'single';

/**
 * 逐段单节点 DCTL 条目（single 模式）。
 * source 原样入包（本模块不解析/不改写 DCTL 源码）；
 * label 为该段 CDL 的可读摘要，由调用方传入（保持本模块不依赖 CDL 数学）。
 *
 * R12：`params`（可选）为该段 `.dctl` 的面板参数摘要（调用方传 generateDctl(...).params）。
 * 各段的 look/质感滑杆完全相同、匹配段仅默认值不同，故《首次上手清单》用**首个带 params 的段**
 * 生成完整滑杆对照表（look + 质感 + 匹配）。**不传 params 时行为与 R11 完全一致**（只印固定匹配表）。
 */
export interface BatchSegDctl {
  fileName: string;
  source: string;
  label?: string;
  /** R12（可选）：该段 .dctl 的参数摘要（generateDctl 的 res.params），用于补全滑杆对照表 */
  params?: DctlParamSummary[];
  /** R12（可选）：该段 .dctl 的管线（'rcm' | 'yrgb'），写进对照表的中性值列 */
  pipeline?: string;
  /** R12（可选）：该段 .dctl 是否为兼容模式（ASCII 标签 + 0/1 滑杆） */
  compat?: boolean;
}

/** 打包/文档共用的逐段行：片段名 + 安全化文件名 + 源码 + CDL 摘要（+ R12 可选参数摘要） */
interface SegDctlRow {
  clip: string;
  fileName: string;
  source: string;
  label: string;
  params?: DctlParamSummary[];
  pipeline?: string;
  compat?: boolean;
}

export interface PackFile {
  name: string;
  text: string;
}

/** ZIP 中条目名允许 UTF-8；仅替换路径分隔与控制字符，防目录穿越/坏头 */
function safeZipName(name: string): string {
  return name.replace(/[\\/\u0000-\u001f]/g, '_');
}

/** 分享码 → ASCII 安全文件名片段（非 ASCII 会退化为下划线） */
function safeCode(shareCode: string): string {
  const t = (shareCode || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return t || 'filmmatch';
}

/** 有效导出模式：显式 mode 优先；只给非空 dctls 时按 'single'（逐段 DCTL 存在即代表该模式） */
function packModeOf(input: { mode?: BatchPackMode; dctls?: BatchSegDctl[] }): BatchPackMode {
  if (input.mode) return input.mode;
  return input.dctls && input.dctls.length > 0 ? 'single' : 'cdl';
}

/**
 * 逐段行（打包与文档共用）：按**顺序**与 entries 配对（第 i 个 dctl ↔ 第 i 段）。
 * 文件名过 safeZipName（与 zip 内实际条目名一致）；label 缺失写「—」。
 */
function segRowsOf(entries: CdlEntry[], dctls: BatchSegDctl[]): SegDctlRow[] {
  return dctls.map((d, i) => ({
    clip: entries[i]?.name ?? `段 ${String(i + 1).padStart(2, '0')}`,
    fileName: safeZipName(d.fileName),
    source: d.source,
    label: (d.label ?? '').trim() || '—',
    params: d.params,
    pipeline: d.pipeline,
    compat: d.compat,
  }));
}

const f4 = (v: number): string => (Number.isFinite(v) ? v.toFixed(4) : '0.0000');
const vec4 = (v: number[]): string => v.map(f4).join(' ');

/** 达芬奇 CDL 映射字符串：Slope/Offset/Power 为空格分隔三元组，Saturation 单值 */
function pyCdlMap(cdl: Cdl): string {
  return (
    '{' +
    '"NodeIndex": "1", ' +
    `"Slope": "${vec4(cdl.slope)}", ` +
    `"Offset": "${vec4(cdl.offset)}", ` +
    `"Power": "${vec4(cdl.power)}", ` +
    `"Saturation": "${f4(cdl.sat)}"` +
    '}'
  );
}

/**
 * 生成达芬奇 Python 挂载脚本：
 * 逐段一行 SetCDL(...) + 一行 SetLUT(...)，含时间线/片段名占位、幂等与异常提示。
 * 脚本头部注明节点链建议：③ DCTL 节点（look + 质感）与 ④ 统一 LUT 二选一。
 * 注意：注释与说明里不写带括号的 API 名，保证「每段恰好一行调用」可被稳定解析。
 */
export function mountScriptPy(input: {
  entries: CdlEntry[];
  lutName: string;
  lutSize: number;
}): string {
  const { entries, lutName, lutSize } = input;
  const lines: string[] = [];
  lines.push('# -*- coding: utf-8 -*-');
  lines.push('# FilmMatch 批量挂载脚本 —— 需 Studio 版');
  lines.push('#');
  lines.push('# 用途：把逐段 CDL 与统一风格层 LUT 一次性挂到时间线各片段上。');
  lines.push('# 免费版没有 Python 控制台/脚本接口，请改用同目录《免费版手录说明.md》。');
  lines.push('# 节点建议：③ DCTL 节点（look + 质感全层）与 ④ 统一风格层 LUT 二选一——');
  lines.push('#           两者都承载色彩 look，同时开会重复叠加；本脚本只挂统一 LUT 与 CDL。');
  lines.push('# 运行：达芬奇「工作区 > 脚本」运行本文件，或在控制台 exec(open(路径).read())。');
  lines.push('# 幂等：脚本只覆盖节点的 CDL 参数与 LUT 路径，重复运行结果一致。');
  lines.push('# 异常：片段名占位不匹配时 _find_item 会抛出并带上片段名；');
  lines.push('#       如需跳过单段，可自行在调用处包 try/except。');
  lines.push('#');
  lines.push(`# 统一风格层 LUT：${lutName}（${lutSize}^3，与本脚本同目录）`);
  lines.push('');
  lines.push('import os');
  lines.push('');
  lines.push(`_LUT_NAME = ${JSON.stringify(lutName)}`);
  lines.push('_LUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), _LUT_NAME)');
  lines.push('');
  lines.push('');
  lines.push('def _find_item(name):');
  lines.push('    """按片段名在当前时间线查找时间线项；时间线名占位为「当前时间线」。"""');
  lines.push('    proj = globals().get("resolve")  # 达芬奇脚本宿主注入的项目对象');
  lines.push('    if proj is None:');
  lines.push('        raise RuntimeError("未取到项目对象：请在达芬奇脚本/控制台中运行本文件")');
  lines.push('    tl = proj.GetCurrentTimeline()  # 占位：如需指定时间线，改为按名查找');
  lines.push('    if tl is None:');
  lines.push('        raise RuntimeError("当前没有时间线：请先打开目标时间线")');
  lines.push('    for track in range(1, 8):');
  lines.push('        for item in (tl.GetItemListInTrack("video", track) or []):');
  lines.push('            if item.GetName() == name:');
  lines.push('                return item');
  lines.push('    raise RuntimeError("未找到片段：%s（请检查片段名占位）" % name)');
  lines.push('');
  lines.push('');
  lines.push('# ==== 逐段挂载 ====');
  lines.push('');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    lines.push(`# --- 段 ${String(i + 1).padStart(2, '0')}：${e.name} ---`);
    lines.push(`_item = _find_item(${JSON.stringify(e.name)})  # 占位：时间线/片段名请按实际替换`);
    lines.push(`_item.SetCDL(${pyCdlMap(e.cdl)})  # 逐段 CDL（需 Studio 版）`);
    lines.push('_item.SetLUT(_LUT_PATH)  # 统一风格层 LUT（.cube）');
    lines.push('');
  }
  lines.push('# 全部完成。若某段未生效，请确认：片段名占位、节点索引、LUT 文件路径。');
  return lines.join('\n') + '\n';
}

/** 逐段数值表（Markdown），被两份说明文档复用 */
function cdlTableMd(entries: CdlEntry[]): string {
  const head =
    '| 片段 | slope R/G/B | offset R/G/B | power R/G/B | sat | 拟合前距离 | 拟合后距离 | 迭代 |\n' +
    '| --- | --- | --- | --- | --- | --- | --- | --- |';
  const rows = entries.map(
    (e) =>
      `| ${e.name} | ${e.cdl.slope.map(f4).join(' / ')} | ${e.cdl.offset
        .map(f4)
        .join(' / ')} | ${e.cdl.power.map(f4).join(' / ')} | ${f4(e.cdl.sat)} | ${f4(
        e.before,
      )} | ${f4(e.after)} | ${e.iterations} |`,
  );
  return [head, ...rows].join('\n');
}

/** CDL 手录映射表（兜底路线共用：CDL 参数 ↔ 主校色器控件） */
function cdlMapTableMd(): string {
  return [
    '| CDL 参数 | 校色器对应控件 | 说明 |',
    '| --- | --- | --- |',
    '| slope（R/G/B） | 增益 Gain（R/G/B） | >1 提亮该通道，<1 压暗 |',
    '| offset（R/G/B） | 偏移 Offset（无则用 Lift 近似） | 抬/压黑位，范围很小 |',
    '| power（R/G/B） | 伽马 Gamma（R/G/B） | >1 压暗中间调，<1 提亮 |',
    '| sat | 饱和度 Saturation | 绕亮度整体加/减色 |',
  ].join('\n');
}

/**
 * 免费版手录说明：免费版无 Python 控制台与独立 CDL 面板，故「逐段匹配」只能手动录入。
 * 注意：**质感层不再需要手录**——光晕/颗粒/柔光/暗角由同包 .dctl 在达芬奇里承载
 * （免费版同样能加载 DCTL）；手录只用于连 DCTL 都用不了的场合。
 *
 * 两种模式的「主流程」不同（不能串味）：
 *   'cdl'    —— 逐段 CDL 手录是主流程，统一风格层 LUT 与其叠加；
 *   'single' —— 每段挂自己的 .dctl（匹配已内联）是主流程、不需要手录任何数值；
 *               「统一 LUT + 手录 CDL」整体降级为**兜底**（连 DCTL 都用不了时）。
 */
export function freeVersionGuideMd(input: {
  entries: CdlEntry[];
  lutName: string;
  mode?: BatchPackMode;
  /** single 模式：逐段 DCTL（与 entries 同序），用于「片段 ↔ 文件名」对照表 */
  dctls?: BatchSegDctl[];
}): string {
  const { entries, lutName } = input;
  const rows = segRowsOf(entries, input.dctls ?? []);
  if (packModeOf(input) === 'single') return freeVersionGuideSingleMd(entries, lutName, rows);
  const lines: string[] = [];
  lines.push('# 免费版手录说明');
  lines.push('');
  lines.push('免费版没有 Python 控制台，也没有独立的 CDL 面板，因此**逐段匹配数值只能手动录入**。');
  lines.push('质感层不需要手录：光晕 / 颗粒 / 柔光 / 暗角由同包 `.dctl` 在达芬奇里承载（免费版同样能加载 DCTL），');
  lines.push('把 `.dctl` 放到达芬奇 DCTL 目录、在节点上加载即可，详见同包《首次上手清单.md》。');
  lines.push('');
  lines.push('分工：**统一风格层 LUT（`.cube`）只负责色彩 look；质感层由 `.dctl` 负责。**');
  lines.push('两者都承载色彩 look，**同时开会重复叠加**——能用 DCTL 就只用 `.dctl`（look + 质感一次到位）；');
  lines.push('只有在连 DCTL 都用不了的环境，才退回「`.cube` 统一风格层 + 手录 CDL」。');
  lines.push('');
  lines.push('## 第一步：挂统一风格层 LUT（所有片段共用，可选）');
  lines.push('');
  lines.push(`1. 把 \`${lutName}\` 放到本机任意目录（建议与导出包同目录）。`);
  lines.push('2. 进入「片段」页面，全选需要统一的片段。');
  lines.push(`3. 右键 → 「应用 3D LUT」，选择 \`${lutName}\`（或到「项目设置 > 色彩管理 > 3D LUT」添加后统一指派）。`);
  lines.push('4. 该 LUT 只负责**色彩 look**（不含质感层），与逐段 CDL 是叠加关系；');
  lines.push('   若已加载同包 `.dctl`（look + 质感），**不要再挂本 LUT**，否则色彩会叠加两次。');
  lines.push('');
  lines.push('## 第二步：逐段手录 CDL（把每段推向统一参考）');
  lines.push('');
  lines.push('进入「校色」页面，选中一段，按下面映射把该段数值填进主校色器：');
  lines.push('');
  lines.push(cdlMapTableMd());
  lines.push('');
  lines.push('逐段数值见下表（与 `cdl.csv` 完全一致，可直接照抄）：');
  lines.push('');
  lines.push(cdlTableMd(entries));
  lines.push('');
  lines.push('## 第三步：校验');
  lines.push('');
  lines.push('1. 逐段切换，确认灰阶带无偏色、肤色自然、高光不过曝。');
  lines.push('2. 与 `参数对照表.md` / `cdl.csv` 复核数值是否录错。');
  lines.push('3. 免费版无批量脚本，片段多时建议先录一段作为模板，再逐段微调。');
  lines.push('4. 质感层（光晕 / 颗粒 / 柔光 / 暗角）**不在手录范围内**：改用同包 `.dctl`（免费版同样能加载）。');
  lines.push('');
  return lines.join('\n');
}

/** single 模式的免费版说明：主流程 = 逐段挂 .dctl（匹配内联，无需手录）；手录整体降级为兜底 */
function freeVersionGuideSingleMd(entries: CdlEntry[], lutName: string, rows: SegDctlRow[]): string {
  const lines: string[] = [];
  lines.push('# 免费版手录说明');
  lines.push('');
  lines.push('免费版没有 Python 控制台，也没有独立的 CDL 面板，但**同样能加载 DCTL**。');
  lines.push('本包是**逐段单节点 DCTL** 交付：每段一个 `.dctl`，匹配、色彩 look 与质感层都内联在里面——');
  lines.push('照「第一步」逐段挂上即可，**不需要手录任何数值**。只有在连 DCTL 都用不了时，才需要看「第二步（兜底）」。');
  lines.push('');
  lines.push('## 第一步：逐段挂自己的 .dctl（主流程，无需手录）');
  lines.push('');
  lines.push('1. 把本包所有 `.dctl` 放到本机任意目录（建议与导出包同目录），再到「项目设置 > 色彩管理」把该目录加进 DCTL 搜索路径。');
  lines.push('2. 进入「片段」页面 / 时间线，逐段选中，在节点上加载**该段对应的** `.dctl`（片段名 ↔ 文件名见下表）。');
  lines.push('3. 一个 DCTL 节点即完成匹配 + look + 质感；匹配段可用 `FM_MATCH_ON` 关闭、10 个系数可微调。');
  lines.push('4. **不要再叠加统一风格层 LUT**（`.cube`）：look 已含在 `.dctl` 里，同时开会重复叠加。');
  lines.push('');
  if (rows.length) {
    lines.push('| 片段名 | .dctl 文件名 |');
    lines.push('| --- | --- |');
    for (const r of rows) lines.push(`| ${mdCell(r.clip)} | \`${mdCell(r.fileName)}\` |`);
    lines.push('');
  }
  lines.push('## 第二步（兜底）：连 DCTL 都用不了时，才退回「统一 LUT + 手录 CDL」');
  lines.push('');
  lines.push('只有在版本过旧 / 后端不支持 DCTL 的场合，才需要走下面这条兜底路线：');
  lines.push('`' + lutName + '` 负责色彩 look，逐段匹配数值手动录入（质感层不在手录范围内）。');
  lines.push('');
  lines.push('### 兜底 A：挂统一风格层 LUT（所有片段共用）');
  lines.push('');
  lines.push(`1. 把 \`${lutName}\` 放到本机任意目录（建议与导出包同目录）。`);
  lines.push('2. 进入「片段」页面，全选需要统一的片段。');
  lines.push(`3. 右键 → 「应用 3D LUT」，选择 \`${lutName}\`（或到「项目设置 > 色彩管理 > 3D LUT」添加后统一指派）。`);
  lines.push('4. 该 LUT 只负责**色彩 look**（不含质感层），与逐段 CDL 是叠加关系。');
  lines.push('');
  lines.push('### 兜底 B：逐段手录 CDL（把每段推向统一参考）');
  lines.push('');
  lines.push('进入「校色」页面，选中一段，按下面映射把该段数值填进主校色器：');
  lines.push('');
  lines.push(cdlMapTableMd());
  lines.push('');
  lines.push('逐段数值见下表（与 `cdl.csv` 完全一致，可直接照抄）：');
  lines.push('');
  lines.push(cdlTableMd(entries));
  lines.push('');
  lines.push('## 校验');
  lines.push('');
  lines.push('1. 逐段切换，确认灰阶带无偏色、肤色自然、高光不过曝。');
  lines.push('2. 与 `参数对照表.md` / `cdl.csv` 复核数值是否录错。');
  lines.push('3. 免费版无批量脚本，片段多时建议先录一段作为模板，再逐段微调。');
  lines.push('4. 质感层（光晕 / 颗粒 / 柔光 / 暗角）**不在手录范围内**：用同包 `.dctl`（免费版同样能加载）。');
  lines.push('');
  return lines.join('\n');
}

/** 参数对照表：逐段数值 + slope/offset/power/sat 含义与合法区间 */
function paramTableMd(entries: CdlEntry[]): string {
  const lines: string[] = [];
  lines.push('# 参数对照表');
  lines.push('');
  lines.push('本表为逐段 CDL 数值与参数含义对照，供手录/复核使用。');
  lines.push('');
  lines.push('## 参数含义与合法区间');
  lines.push('');
  lines.push('| 参数 | 含义 | 合法区间 | 中性值 |');
  lines.push('| --- | --- | --- | --- |');
  lines.push('| slope | 逐通道增益（线性缩放） | 0.5 – 2.0 | 1.0 |');
  lines.push('| offset | 逐通道偏移（黑位抬/压） | -0.1 – 0.1 | 0.0 |');
  lines.push('| power | 逐通道幂次（伽马） | 0.7 – 1.4 | 1.0 |');
  lines.push('| sat | 绕亮度饱和度 | 0.5 – 2.0 | 1.0 |');
  lines.push('');
  lines.push('正向公式：out = (in × slope + offset) ^ power，再按 sat 绕 Rec.709 亮度做饱和调整。');
  lines.push('');
  lines.push('## 逐段数值');
  lines.push('');
  lines.push(cdlTableMd(entries));
  lines.push('');
  return lines.join('\n');
}

/* ------------------- 首次上手清单（R6：zip 内的自解释文档） ------------------- */

/** 参数分组 → 文档小节名（顺序固定；未列出/缺失的 group 归入「其他」） */
const GROUP_TITLE: Record<string, string> = {
  match: '匹配（内联 CDL）',
  look: '色彩 look',
  halation: '光晕',
  bloom: '柔光',
  grain: '颗粒',
  vignette: '暗角',
  other: '其他',
};
const GROUP_ORDER: readonly string[] = ['match', 'look', 'halation', 'bloom', 'grain', 'vignette', 'other'];

/**
 * 参数中性值表（本地副本，**故意不 import src/dctl/***）：
 * 取值＝该参数「无效果 / 恒等」时的数值，与 effectmath 的恒等约定一致。
 * 表里没有的宏：开关（bool 或 `_ON` 结尾）按「关」处理，其余显示 `—`（结构量，无单一中性值）。
 * 维护提示：DCTL 生成器新增参数时同步补这张表（未列出的参数会退化为 `—`，不会出错但信息更少）。
 */
const NEUTRAL_BY_MACRO: Record<string, number> = {
  // ---- 色彩 look（恒等：对比度/饱和度 1，其余 0；pivot 随管线，见 pivotNeutral） ----
  FM_CONTRAST: 1,
  FM_TOE: 0,
  FM_SHOULDER: 0,
  FM_CROSSTALK: 0,
  FM_SATURATION: 1,
  FM_WARMTH: 0,
  FM_FADE: 0,
  FM_SHADOW_BIAS: 0,
  FM_HIGHLIGHT_BIAS: 0,
  FM_FILM_S: 0,
  FM_GAMMA_CONTRAST: 0,
  // ---- 光晕 ----
  FM_HALATION_ON: 0,
  FM_HALATION_AMOUNT: 0,
  FM_HALATION_BG_GAIN: 1,
  FM_HALATION_BLUE_COMP: 0,
  FM_HALATION_IMPACT: 0,
  FM_HALATION_AMPLIFY: 1,
  FM_HALATION_SMOOTH: 0.5,
  // ---- 颗粒 ----
  FM_GRAIN_ON: 0,
  FM_GRAIN_AMP: 0,
  FM_GRAIN_SHADOW: 0,
  FM_GRAIN_MIDTONE: 0,
  FM_GRAIN_HIGHLIGHT: 0,
  // ---- 柔光 ----
  FM_BLOOM_ON: 0,
  FM_BLOOM_AMOUNT: 0,
  FM_BLOOM_SAVE_LIGHTS: 0,
  FM_BLOOM_DETAILS: 0.5,
  FM_BLOOM_SATURATION: 1,
  // ---- 暗角 ----
  FM_VIGNETTE_ON: 0,
  FM_VIGNETTE_AMOUNT: 0,
  FM_VIGNETTE_CHROMA_PX: 0,
};

/** 数值文本：去掉多余的尾随零（0.5000 → 0.5） */
function numText(v: number): string {
  return Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '—';
}

/** 对数域 pivot 的中性值随管线（YRGB 0.5 / RCM 0.333） */
function pivotNeutral(pipeline?: string): string {
  if (pipeline === 'yrgb') return '0.5（本管线）';
  if (pipeline === 'rcm' || pipeline === 'aces') return '0.333（本管线）';
  return '0.5（YRGB）/ 0.333（RCM）';
}

/** 参数中性值单元格 */
function neutralCell(p: DctlParamSummary, pipeline?: string): string {
  if (p.macro === 'FM_PIVOT') return pivotNeutral(pipeline);
  if (p.type === 'bool') return '0（关）';
  const v = NEUTRAL_BY_MACRO[p.macro];
  if (typeof v === 'number') return numText(v);
  if (/_ON$/.test(p.macro)) return '0（关）';
  return '—';
}

/** 参数范围单元格（bool 在兼容模式是 0/1 滑杆，标准模式是勾选框） */
function rangeCell(p: DctlParamSummary, compat?: boolean): string {
  if (p.type === 'bool') return compat ? '0 – 1（0/1 滑杆）' : '开 / 关';
  if (typeof p.min === 'number' && typeof p.max === 'number') return `${numText(p.min)} – ${numText(p.max)}`;
  return '—';
}

/** Markdown 单元格转义：换行折成空格、竖线转义，避免表格被参数文案里的字符撑破 */
function mdCell(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim() || '—';
}

/** 滑杆对照表：按 group 分小节（色彩 look / 光晕 / 柔光 / 颗粒 / 暗角 / 其他），组内保持传入顺序 */
function dctlParamTableMd(params: DctlParamSummary[] | undefined, pipeline?: string, compat?: boolean): string {
  if (!params || params.length === 0) {
    return '本次未附参数摘要，请在 DCTL 生成页查看。\n';
  }
  const buckets = new Map<string, DctlParamSummary[]>();
  for (const p of params) {
    const g = p.group && GROUP_TITLE[p.group] ? p.group : 'other';
    const list = buckets.get(g);
    if (list) list.push(p);
    else buckets.set(g, [p]);
  }
  const out: string[] = [];
  for (const g of GROUP_ORDER) {
    const list = buckets.get(g);
    if (!list || list.length === 0) continue;
    const title = GROUP_TITLE[g] ?? '其他';
    out.push(`### ${title}`);
    out.push('');
    out.push('| 分组 | 参数 | 中性值 | 范围 | 说明 |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const p of list) {
      out.push(
        `| ${title} | ${mdCell(p.label)} | ${neutralCell(p, pipeline)} | ${rangeCell(p, compat)} | ${mdCell(p.tip ?? '')} |`,
      );
    }
    out.push('');
  }
  return out.join('\n');
}

/**
 * 首次上手清单：zip 内的自解释文档（R6/R7）。
 * 五节：文件放哪 / 节点怎么连 / 滑杆对照 / 已知差异（诚实边界）/ 免费版怎么办；
 * 节点链与措辞随 mode 切换（'cdl' 与 'single' 不串味）。
 * 文末附包内文件清单（由调用方按**实际** files 传入，避免文档与包内容不一致）。
 */
export function quickStartMd(input: {
  lutName: string;
  pyName: string;
  dctlName?: string;
  params?: DctlParamSummary[];
  pipeline?: string;
  compat?: boolean;
  /** 导出模式（默认 'cdl'） */
  mode?: BatchPackMode;
  /** single 模式：逐段 DCTL 行（与 entries 同序，由 buildBatchPack 生成） */
  segDctls?: Array<{ clip: string; fileName: string; label: string }>;
  files: string[];
}): string {
  const { lutName, pyName, dctlName, params, pipeline, compat, files } = input;
  const single = (input.mode ?? 'cdl') === 'single';
  const rows = input.segDctls ?? [];
  const dctlText = dctlName ? `\`${dctlName}\`` : '（本包未附 .dctl，请到生成页导出后自行放入）';
  const pipeText = pipeline ? pipeline.toUpperCase() : '未标注';
  const lines: string[] = [];
  lines.push('# 首次上手清单');
  lines.push('');
  if (single) {
    lines.push('本包是**逐段单节点 DCTL** 交付：每段一个 `.dctl`，一个节点同时完成「匹配 + 色彩 look + 质感」。');
    lines.push('按下面五节照做即可，不需要读别的文档；逐段数值细节见同包《参数对照表.md》。');
  } else {
    lines.push('本包把「匹配（逐段 CDL）→ 色彩 look + 质感层（DCTL）」这一条链所需文件一次给齐。');
    lines.push('按下面五节照做即可，不需要读别的文档；数值细节见同包《参数对照表.md》。');
  }
  lines.push('');

  /* ---- 一、文件放哪 ---- */
  lines.push('## 一、文件放哪');
  lines.push('');
  lines.push('| 文件 | 放哪 / 怎么用 |');
  lines.push('| --- | --- |');
  if (single) {
    lines.push('| ' + (rows.length
      ? `${rows.length} 个逐段 \`.dctl\`（如 \`${rows[0].fileName}\`，每段一个）`
      : '（本包未附 .dctl，请到生成页导出后自行放入）') + ' | 达芬奇 DCTL 目录（同样可在「项目设置 > 色彩管理」里添加自定义路径）；**每段只加载自己那一个** |');
    lines.push('| `' + lutName + '` | 兜底路线才用：连 DCTL 都用不了时退回统一风格层 LUT（见第五节）；正常情况下**不要挂** |');
  } else {
    lines.push('| `' + lutName + '` | 达芬奇 LUT 目录（或放任意目录，再到「项目设置 > 色彩管理 > 3D LUT」把该目录加进搜索路径） |');
    lines.push('| ' + dctlText + ' | 达芬奇 DCTL 目录（同样可在「项目设置 > 色彩管理」里添加自定义路径） |');
  }
  lines.push('| `' + pyName + '` | ' + (single
    ? '兜底路线（需 Studio 版）：批量挂逐段 CDL + 统一 LUT；单节点模式不是主流程'
    : '需 Studio 版：在「工作区 > 脚本」里运行，或控制台执行') + ' |');
  lines.push('| `cdl.json` / `cdl.csv` | 数值留档：逐段 CDL 系数（'
    + (single ? '与各段 `.dctl` 内联的匹配系数一致' : '导入/复核/备份用') + '，不直接给达芬奇加载） |');
  lines.push('| `免费版手录说明.md` / `参数对照表.md` / `首次上手清单.md` | 说明文档，随包留存 |');
  lines.push('');
  lines.push('### 怎么加载 .dctl（重要，先看这条）');
  lines.push('');
  lines.push('带质感层（邻域采样）或参数面板的 `.dctl` **必须**用 '
    + '**Color 页 → OpenFX / 特效库 → ResolveFX Color → DCTL** 加载，加载后再在**检查器**里点选本文件；'
    + '文件仍需放在达芬奇能扫描到的目录（DCTL 目录，或在「项目设置 > 色彩管理」里添加自定义路径）。');
  lines.push('**不要**用「节点右键 → LUT → DCTL」的路径加载带质感层的 DCTL：LUT 路径只吃**逐像素签名**'
    + '（即只含色彩层、无质感层的 DCTL，且没有检查器面板），拿它加载本包的全层 DCTL 会报 '
    + '`wrong argument int p_Width` / `main DCTL function has wrong arguments`。');
  lines.push('**换文件后必须重启达芬奇**：`Update Lists` 不会重载已应用的 DCTL（会继续用旧编译产物）。');
  lines.push('');

  /* ---- 二、节点怎么连 ---- */
  lines.push('## 二、节点怎么连');
  lines.push('');
  if (single) {
    lines.push('推荐链（一个 DCTL 节点完成「匹配 + look + 质感」）：');
    lines.push('');
    lines.push('`① 校正 → ② DCTL 节点（该段专用：匹配 + look + 质感，一个节点搞定）`');
    lines.push('');
    lines.push('| 节点 | 干什么 |');
    lines.push('| --- | --- |');
    lines.push('| ① 校正 | 白平衡 / 曝光 / 镜头校正等常规处理（本包不生成，按素材自行处理） |');
    lines.push('| ② DCTL 节点 | 用 **ResolveFX DCTL 插件**加载**该段自己的** ' + (rows.length ? '`.dctl`（文件名对应片段名，见下表）' : '`.dctl`')
      + '：一个节点同时承载匹配（内联 CDL）、色彩 look 与质感层（光晕 / 柔光 / 颗粒 / 暗角）。加载途径见第一节 |');
    lines.push('');
    lines.push('**每个片段挂自己那一个 `.dctl`（文件名对应片段名），不要再叠加统一风格层 LUT**'
      + '——look 已含在 `.dctl` 里，同时开会重复叠加。');
    lines.push('匹配段可在面板里用 `FM_MATCH_ON` 关闭、10 个系数（slope / offset / power / sat）可微调；默认值＝该段解算结果。');
    lines.push('');
    if (rows.length) {
      lines.push('### 逐段 DCTL 对照表');
      lines.push('');
      lines.push('| 片段名 | .dctl 文件名 | 该段 CDL 摘要 |');
      lines.push('| --- | --- | --- |');
      for (const r of rows) lines.push(`| ${mdCell(r.clip)} | \`${mdCell(r.fileName)}\` | ${mdCell(r.label)} |`);
      lines.push('');
    }
  } else {
    lines.push('推荐链（一条链走完「匹配 → look + 质感」）：');
    lines.push('');
    lines.push('`① 校正 → ② CDL 节点（匹配，逐段数值见 cdl.csv，可用 _mount.py 批量挂）'
      + ' → ③ DCTL 节点（look + 质感全层，用本包的 .dctl）'
      + ' → ④ 统一风格层 LUT（可选，与 ③ 二选一：两者都承载 look，同时开会重复叠加）`');
    lines.push('');
    lines.push('| 节点 | 干什么 |');
    lines.push('| --- | --- |');
    lines.push('| ① 校正 | 白平衡 / 曝光 / 镜头校正等常规处理（本包不生成，按素材自行处理） |');
    lines.push('| ② CDL 节点 | 套用逐段数值（`cdl.csv`），把每段推向同一条参考；Studio 版可用 `' + pyName + '` 一次挂完 |');
    lines.push('| ③ DCTL 节点 | 用 **ResolveFX DCTL 插件**加载 ' + dctlText + '：一个节点同时承载色彩 look 与质感层（光晕 / 柔光 / 颗粒 / 暗角）。加载途径见第一节 |');
    lines.push('| ④ 统一风格层 LUT | 加载 `' + lutName + '`：**只承载色彩 look**，不含质感层 |');
    lines.push('');
    lines.push('**③ 与 ④ 的取舍**：两者都承载色彩 look —— 同时开会**重复叠加**（画面比预期更浓）。只留一个：');
    lines.push('要质感层就用 ③（推荐，look + 质感一次到位）；只有在无法加载 DCTL 的环境（版本过旧 / 后端不支持）才退回 ④。');
    lines.push('');
  }

  /* ---- 三、滑杆对照 ---- */
  lines.push('## 三、滑杆对照');
  lines.push('');
  if (single) {
    lines.push('每段 `.dctl` 的参数面板滑杆（' + (pipeline ? '管线：' + pipeText + '；' : '')
      + '各文件头注明了管线与生成基准）。各段的 look / 质感滑杆完全相同；'
      + '匹配段另有 11 个参数，其**默认值＝该段解算结果**（不是中性值）。');
    lines.push('');
    lines.push('| 匹配参数（宏名） | 标签（兼容模式） | 含义 | 中性值 |');
    lines.push('| --- | --- | --- | --- |');
    lines.push('| `FM_MATCH_ON` | Match On | 匹配段总开关；关掉后本节点只做 look 与质感 | 0（关） |');
    lines.push('| `FM_MATCH_SLOPE_R` / `_G` / `_B` | Match Slope R / G / B | 逐通道斜率（增益），1.0 为不变 | 1 |');
    lines.push('| `FM_MATCH_OFFSET_R` / `_G` / `_B` | Match Offset R / G / B | 逐通道偏移（抬 / 压黑位），0 为不变 | 0 |');
    lines.push('| `FM_MATCH_POWER_R` / `_G` / `_B` | Match Power R / G / B | 逐通道幂次（伽马），1.0 为不变 | 1 |');
    lines.push('| `FM_MATCH_SAT` | Match Sat | 绕亮度饱和度，1.0 为不变 | 1 |');
    lines.push('');
    /* R12：调用方传入 dctls[].params（generateDctl 的 res.params）时，印完整滑杆对照表；
     * 未传时保持 R11 行为（只给上面的固定匹配表 + 指向生成页的说明）。 */
    if (params && params.length > 0) {
      lines.push('### 完整参数对照表（look + 质感 + 匹配；各段一致，按首段列出）');
      lines.push('');
      lines.push(dctlParamTableMd(params, pipeline, compat));
      lines.push('匹配段滑杆的**默认值＝该段解算结果**（各段不同，故未逐段列出）；表中「中性值」列给出的是该参数无效果时的取值。');
    } else {
      lines.push('完整 look / 质感滑杆清单（含中性值与范围）见 DCTL 生成页；各段一致，本包不逐段重复。');
      lines.push('达芬奇里滑杆的**默认值＝该配方当前取值**（不是中性值）：想恢复原样请对照生成页或先记下当前数值。');
    }
  } else {
    lines.push('本包 `.dctl` 的参数面板滑杆（管线：' + pipeText + '）。中性值＝该参数「无效果 / 恒等」时的取值，'
      + '`—` 表示结构量或颜色量、没有单一中性值（关掉所在层的开关即整体失效）。');
    lines.push('达芬奇里滑杆的**默认值＝本配方当前取值**（不是中性值）：想恢复原样请对照下表，或先记下当前数值。');
    if (compat) {
      lines.push('');
      lines.push('本包 `.dctl` 为**兼容模式**：面板标签为纯 ASCII（如 `Halation Amount`），开关是 0/1 滑杆；下表「参数」列即标签全文。');
    }
    lines.push('');
    lines.push(dctlParamTableMd(params, pipeline, compat));
  }
  lines.push('');

  /* ---- 四、已知差异 ---- */
  lines.push('## 四、已知差异（诚实边界）');
  lines.push('');
  lines.push('1. **颗粒是静态的**：本包 `.dctl` 的入口签名没有帧索引，颗粒逐帧不变；网页端预览是逐帧动态颗粒（观感不同，属已知差异）。');
  lines.push('2. **亮通阈值的作用位置不同**：DCTL 的光晕 / 柔光阈值作用于**源图**，网页端作用于**已 look 的图**；'
    + '常规参数下接近，极端参数（高对比 look + 高阈值）下晕色会略有差异。');
  lines.push('3. **像素量按 1080p 换算**：`.dctl` 里的半径 / 颗粒间距 / 色散是像素常量。'
    + '2160p（4K）素材请把半径、颗粒、色散参数**按比例 ×2**（其余参数不动）。');
  lines.push('4. **改完 `.dctl` 必须重启达芬奇**：`Update Lists` 不会重载已应用的 DCTL，会继续用旧的编译产物。');
  lines.push('5. **实机验证环境**：Windows + CUDA(NVRTC) 后端（OpenCL 后端实测不可用，画面全黑）；其他平台 / 后端尚未验证。');
  lines.push('6. **中英混排标签与 tooltip 尚未实机验证**：本包默认走兼容模式（纯 ASCII 标签）避开该风险；'
    + '若在生成页改用混排标签，请自行确认面板显示正常。');
  if (single) {
    lines.push('7. **内联匹配是 CDL 近似**：匹配段把 R3 解算的 CDL 内联进 DCTL，与网页端 engine 匹配存在数值差'
      + '（生成页有误差报告）；要严格逐位一致可改用同包 `cdl.csv` 的逐段 CDL 路线（见第五节兜底）。');
  }
  lines.push('');

  /* ---- 五、免费版怎么办 ---- */
  lines.push('## 五、免费版怎么办');
  lines.push('');
  if (single) {
    lines.push('免费版没有 Python 控制台，也没有独立的 CDL 面板，但**同样能加载 DCTL**：'
      + '把每段对应的 `.dctl` 放进 DCTL 目录、逐段在节点上加载即可，**匹配已经内联在里面，不需要手录任何数值**。');
    lines.push('只有在**连 DCTL 都用不了**的场合（版本过旧 / 后端不支持），才退回「`.cube` 统一风格层 + 手录 CDL」；'
      + '那条兜底路线见同包《免费版手录说明.md》第二步。');
  } else {
    lines.push('免费版没有 Python 控制台，也没有独立的 CDL 面板，所以**逐段匹配**只能手动录入（见同包《免费版手录说明.md》）。');
    lines.push('但**质感层现在由 `.dctl` 承载，不再需要手录**——免费版同样能加载 DCTL，把 '
      + dctlText + ' 放进 DCTL 目录、在节点上加载即可。');
    lines.push('手录只用于**连 DCTL 都用不了**的场合（版本过旧 / 后端不支持）；那种情况下才退回「`.cube` 统一风格层 + 手录 CDL」。');
  }
  lines.push('');

  /* ---- 包内文件清单（由实际 files 生成） ---- */
  lines.push(`包内文件（${files.length} 个）：${files.map((n) => `\`${n}\``).join('、')}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * 组装批量导出包：
 *   'cdl'    模式（默认，与 R6 一致）：7 个文本文件 / 另给 dctl 时 8 个 ——
 *            cdl.json / cdl.csv / <code>.cube / [<code>.dctl] / <code>_mount.py /
 *            免费版手录说明.md / 参数对照表.md / 首次上手清单.md
 *   'single' 模式（R7）：7 + N 个（N = dctls.length，通常 = 段数）——
 *            cdl.json / cdl.csv / <code>.cube / N 个逐段 .dctl / <code>_mount.py /
 *            免费版手录说明.md / 参数对照表.md / 首次上手清单.md
 *            （single 模式下 dctl 条目整体忽略，由 dctls 逐段替代，两者不并存）
 */
export function buildBatchPack(input: BatchPackInput): PackFile[] {
  const code = safeCode(input.shareCode);
  const mode = packModeOf(input);
  const single = mode === 'single';
  const cubeName = `${code}.cube`;
  const pyName = `${code}_mount.py`;
  const base = (input.recipeName || 'FilmMatch').trim();
  // 配方名已含「统一风格层」时不重复追加，避免 TITLE 出现叠词
  const title = base.includes('统一风格层') ? base : `${base} · 统一风格层`;
  const segRows = single ? segRowsOf(input.entries, input.dctls ?? []) : [];
  /* R12：single 模式用「首个带 params 的段」生成完整滑杆对照表（各段 look/质感相同，仅匹配默认值不同）；
   * 未传 params 时保持 R11 行为。cdl 模式仍用 input.dctl?.params。 */
  const segWithParams = single ? segRows.find((r) => r.params && r.params.length > 0) : undefined;
  const dctlName = !single && input.dctl ? safeZipName(input.dctl.fileName) : undefined;
  const files: PackFile[] = [
    {
      name: 'cdl.json',
      text: cdlToJson(input.entries, {
        created_at: input.createdAt,
        strategy: input.strategy,
        lut_size: input.lutSize,
      }),
    },
    { name: 'cdl.csv', text: cdlToCsv(input.entries) },
    { name: cubeName, text: toCube(input.lut, title) },
  ];
  if (single) {
    // 逐段单节点 DCTL：内容原样并入，本模块不解析/不改写 DCTL 源码
    for (const r of segRows) files.push({ name: r.fileName, text: r.source });
  } else if (input.dctl && dctlName) {
    // 该配方的 .dctl（look + 质感全层）：内容原样并入
    files.push({ name: dctlName, text: input.dctl.source });
  }
  files.push({
    name: pyName,
    text: mountScriptPy({
      entries: input.entries,
      lutName: cubeName,
      lutSize: input.lut.size,
    }),
  });
  files.push({
    name: '免费版手录说明.md',
    text: freeVersionGuideMd({ entries: input.entries, lutName: cubeName, mode, dctls: input.dctls }),
  });
  files.push({ name: '参数对照表.md', text: paramTableMd(input.entries) });
  // 首次上手清单最后生成：文末的文件清单要含它自己，故先把名单算全
  const names = [...files.map((f) => f.name), '首次上手清单.md'];
  files.push({
    name: '首次上手清单.md',
    text: quickStartMd({
      lutName: cubeName,
      pyName,
      dctlName,
      params: single ? segWithParams?.params : input.dctl?.params,
      pipeline: single ? segWithParams?.pipeline : input.dctl?.pipeline,
      compat: single ? segWithParams?.compat : input.dctl?.compat,
      mode,
      segDctls: segRows.map((r) => ({ clip: r.clip, fileName: r.fileName, label: r.label })),
      files: names,
    }),
  });
  return files;
}

/* ------------------------- 最小 ZIP（store + CRC32） ------------------------- */

let CRC_TABLE: Uint32Array | null = null;

/** 标准 CRC32（IEEE 802.3，反射多项式 0xEDB88320），返回无符号 32 位 */
export function crc32(bytes: Uint8Array): number {
  if (!CRC_TABLE) {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    CRC_TABLE = t;
  }
  const t = CRC_TABLE;
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: Uint8Array;
  data: Uint8Array;
  crc: number;
  offset: number;
}

/** zipStore 入参：规范形态 {name,data}，同时兼容 buildBatchPack 的 PackFile({name,text}) */
type ZipInput = { name: string; data: string | Uint8Array } | PackFile;

/**
 * 生成最小 ZIP（全部 store 无压缩）。
 * 结构：每条目「本地文件头(0x04034b50)+数据」，随后中央目录(0x02014b50)，末尾 EOCD(0x06054b50)。
 * 文件名按 UTF-8 编码并置 bit 11（UTF-8 标志），中文名可被标准工具正确识别。
 */
export function zipStore(files: ZipInput[]): Uint8Array {
  const enc = new TextEncoder();
  const entries: ZipEntry[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (u: Uint8Array): void => {
    chunks.push(u);
    offset += u.length;
  };

  for (const f of files) {
    const name = enc.encode(safeZipName(f.name));
    const raw = 'data' in f ? f.data : f.text;
    const data = typeof raw === 'string' ? enc.encode(raw) : raw;
    const crc = crc32(data);
    const lh = new Uint8Array(30 + name.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true); // version needed
    dv.setUint16(6, 0x0800, true); // bit 11: UTF-8 名称
    dv.setUint16(8, 0, true); // method: store
    dv.setUint16(10, 0, true); // mod time
    dv.setUint16(12, 0x21, true); // mod date = 1980-01-01
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, name.length, true);
    dv.setUint16(28, 0, true); // extra len
    lh.set(name, 30);
    entries.push({ name, data, crc, offset });
    push(lh);
    push(data);
  }

  const cdStart = offset;
  for (const e of entries) {
    const ch = new Uint8Array(46 + e.name.length);
    const dv = new DataView(ch.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true); // version made by
    dv.setUint16(6, 20, true); // version needed
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(10, 0, true); // method
    dv.setUint16(12, 0, true); // time
    dv.setUint16(14, 0x21, true); // date
    dv.setUint32(16, e.crc, true);
    dv.setUint32(20, e.data.length, true);
    dv.setUint32(24, e.data.length, true);
    dv.setUint16(28, e.name.length, true);
    dv.setUint16(30, 0, true); // extra
    dv.setUint16(32, 0, true); // comment
    dv.setUint16(34, 0, true); // disk start
    dv.setUint16(36, 0, true); // internal attrs
    dv.setUint32(38, 0, true); // external attrs
    dv.setUint32(42, e.offset, true);
    ch.set(e.name, 46);
    push(ch);
  }

  const cdSize = offset - cdStart;
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(4, 0, true); // disk
  dv.setUint16(6, 0, true); // cd disk
  dv.setUint16(8, entries.length, true);
  dv.setUint16(10, entries.length, true);
  dv.setUint32(12, cdSize, true);
  dv.setUint32(16, cdStart, true);
  dv.setUint16(20, 0, true); // comment len
  push(eocd);

  const out = new Uint8Array(offset);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
