/**
 * 导出打包测试：CRC32 已知向量、自写 ZIP 回读（结构/名称/内容/CRC）、
 * 文件清单与 .cube 行数、挂载脚本结构（无品牌词）、说明文档含逐段数值。
 * ZIP 回读优先用系统 unzip -l（若可用），并始终用自写解析器断言内容与 CRC。
 */
import { describe, expect, it } from 'vitest';
import { bakeLUT } from '../engine/lut';
import { NEUTRAL_CDL, type CdlEntry } from './cdl';
import {
  buildBatchPack,
  crc32,
  freeVersionGuideMd,
  mountScriptPy,
  zipStore,
  type BatchPackInput,
  type BatchSegDctl,
  type DctlParamSummary,
  type PackFile,
} from './export';
import { synthSeries } from './synth';

/* ---------------- 测试工具 ---------------- */

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * 动态载入 node 内置模块（specifier 用变量，tsc 便无需 @types/node 也不报 TS2307）。
 * 仅用于「若系统有 unzip 则额外校验」这一可选步骤，缺失时返回空串跳过。
 */
async function nodeMod(spec: string): Promise<any> {
  return import(/* @vite-ignore */ spec);
}

async function tryUnzipListing(zip: Uint8Array): Promise<string> {
  try {
    const cp = await nodeMod('node:child_process');
    const fs = await nodeMod('node:fs');
    const os = await nodeMod('node:os');
    const path = await nodeMod('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmzip-'));
    const p = path.join(dir, 't.zip');
    fs.writeFileSync(p, zip);
    const out = cp.execFileSync('unzip', ['-l', p], { encoding: 'utf8' });
    fs.rmSync(dir, { recursive: true, force: true });
    return out;
  } catch {
    return '';
  }
}

interface ParsedEntry {
  name: string;
  data: Uint8Array;
  crc: number;
  computedCrc: number;
  method: number;
  flags: number;
}

/** 自写最小 ZIP 解析器：读 EOCD → 中央目录 → 本地头 → 取数据并回算 CRC */
function readZip(bytes: Uint8Array): { count: number; entries: ParsedEntry[]; eocdAt: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const min = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('readZip: 未找到 EOCD');
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOff = dv.getUint32(eocd + 16, true);
  if (cdOff + cdSize !== eocd) throw new Error('readZip: 中央目录偏移/长度不自洽');
  const entries: ParsedEntry[] = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('readZip: 中央目录签名错');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    if (dv.getUint32(lho, true) !== 0x04034b50) throw new Error('readZip: 本地头签名错');
    const lnlen = dv.getUint16(lho + 26, true);
    const lelen = dv.getUint16(lho + 28, true);
    const dataStart = lho + 30 + lnlen + lelen;
    const data = bytes.subarray(dataStart, dataStart + usize);
    entries.push({ name, data, crc, computedCrc: crc32(data), method, flags });
    p += 46 + nlen + elen + clen;
  }
  return { count, entries, eocdAt: eocd };
}

const entries: CdlEntry[] = [
  {
    name: 'seg01',
    cdl: { slope: [1.1, 0.98, 1.03], offset: [0.01, -0.02, 0], power: [0.95, 1.05, 1], sat: 1.02 },
    before: 0.05, after: 0.001, iterations: 4,
  },
  {
    name: 'seg02',
    cdl: NEUTRAL_CDL,
    before: 0.03, after: 0.002, iterations: 3,
  },
];

const packInput = {
  recipeName: '批量匹配 · 统一风格层',
  shareCode: 'FM-TEST',
  lutSize: 33 as const,
  lut: bakeLUT((rgb) => rgb, 33),
  entries,
  strategy: 'A' as const,
  createdAt: '2026-09-21T00:00:00.000Z',
};

/* R6：并入包内的 .dctl（内容逐字节比对的 fixture）与参数摘要（4 个不同 group + 1 个无 group） */
const dctlSource = [
  '// =====================================================================',
  '// FilmMatch 菲林工坊 · 达芬奇 DCTL 配方',
  '// 配方：批量匹配 · 统一风格层',
  '// 模式：兼容模式（ASCII 参数标签）',
  '// =====================================================================',
  'DEFINE_UI_PARAMS(FM_CONTRAST, Contrast, DCTLUI_SLIDER_FLOAT, 0.3500f, 0.0000f, 2.0000f, 0.01f)',
  'DEFINE_UI_TOOLTIP(Contrast, "Overall contrast around the pivot")',
  '',
  '__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB) {',
  '    return make_float3(0.0f, 0.0f, 0.0f);',
  '}',
].join('\n');

const dctlParams: DctlParamSummary[] = [
  { macro: 'FM_CONTRAST', label: '对比度 Contrast', type: 'float', def: 0.35, min: 0, max: 2, group: 'look', tip: '绕枢轴的整体反差' },
  { macro: 'FM_HALATION_ON', label: '光晕-开关 Halation On', type: 'bool', def: false, group: 'halation', tip: '光晕层总开关' },
  { macro: 'FM_HALATION_AMOUNT', label: '光晕-强度 Halation Amount', type: 'float', def: 0.6, min: 0, max: 1, group: 'halation', tip: '光晕强度' },
  { macro: 'FM_GRAIN_SIZE_PX', label: '颗粒-尺寸 Grain Size px', type: 'float', def: 1.2, min: 0.5, max: 20, group: 'grain' },
  { macro: 'FM_VIGNETTE_AMOUNT', label: '暗角-强度 Vignette Amount', type: 'float', def: 0.25, min: 0, max: 1, group: 'vignette', tip: '暗角强度' },
  { macro: 'FM_BLOOM_ON', label: '柔光-开关 Bloom On', type: 'bool', def: true, group: 'bloom' },
  { macro: 'FM_UNKNOWN_X', label: '其他参数 Unknown X', type: 'float', def: 1, min: 0, max: 1 },
];

const packInputWithDctl: BatchPackInput = {
  ...packInput,
  dctl: {
    fileName: 'FM-TEST.dctl',
    source: dctlSource,
    params: dctlParams,
    pipeline: 'rcm',
    compat: true,
  },
};

/** 取包内某文件的文本（缺失即抛错，避免断言静默跳过） */
function packDoc(input: BatchPackInput, name: string): string {
  const f = buildBatchPack(input).find((x) => x.name === name);
  if (!f) throw new Error(`包内缺文件：${name}`);
  return f.text;
}

/* R7：逐段单节点 DCTL fixture（single 模式）——每段一个 .dctl，label = 该段 CDL 摘要（调用方传入） */
const segSources = [
  [
    '// FilmMatch 菲林工坊 · 达芬奇 DCTL 配方（逐段单节点：匹配 + look + 质感）',
    '// 段：seg01',
    'DEFINE_UI_PARAMS(FM_MATCH_ON, Match On, DCTLUI_SLIDER_FLOAT, 1, 0, 1, 1)',
    'DEFINE_UI_PARAMS(FM_MATCH_SLOPE_R, Match Slope R, DCTLUI_SLIDER_FLOAT, 1.100000f, 0.500000f, 2.000000f, 0.001f)',
    '',
    '__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB) {',
    '    return make_float3(0.0f, 0.0f, 0.0f);',
    '}',
  ].join('\n'),
  [
    '// FilmMatch 菲林工坊 · 达芬奇 DCTL 配方（逐段单节点：匹配 + look + 质感）',
    '// 段：seg02',
    'DEFINE_UI_PARAMS(FM_MATCH_ON, Match On, DCTLUI_SLIDER_FLOAT, 1, 0, 1, 1)',
    'DEFINE_UI_PARAMS(FM_MATCH_SAT, Match Sat, DCTLUI_SLIDER_FLOAT, 1.000000f, 0.500000f, 2.000000f, 0.001f)',
    '',
    '__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB) {',
    '    return make_float3(0.0f, 0.0f, 0.0f);',
    '}',
  ].join('\n'),
];

const segLabels = [
  'slope 1.100000/0.980000/1.030000 · offset 0.010000/-0.020000/0.000000 · power 0.950000/1.050000/1.000000 · sat 1.020000',
  'slope 1.000000/1.000000/1.000000 · offset 0.000000/0.000000/0.000000 · power 1.000000/1.000000/1.000000 · sat 1.000000',
];

const segDctls: BatchSegDctl[] = [
  { fileName: 'FM-TEST_seg01_seg01.dctl', source: segSources[0], label: segLabels[0] },
  { fileName: 'FM-TEST_seg02_seg02.dctl', source: segSources[1], label: segLabels[1] },
];

/** single 模式入参：逐段 DCTL 与 entries 同序（第 i 个 ↔ 第 i 段） */
const packInputSingle: BatchPackInput = {
  ...packInput,
  mode: 'single',
  dctls: segDctls,
};

/* ---------------- 用例 ---------------- */

describe('export: CRC32 与 ZIP', () => {
  it('14. crc32 已知向量 "123456789" -> 0xCBF43926', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('15. zipStore 回读：条目名/内容/CRC32 一致（含 UTF-8 名与空文件）', () => {
    const inputs = [
      { name: 'a.txt', data: 'hello world' },
      { name: '中文名.txt', data: '统一风格层' },
      { name: 'empty.bin', data: new Uint8Array(0) },
    ];
    const z = zipStore(inputs);
    const parsed = readZip(z);
    expect(parsed.count).toBe(3);
    expect(parsed.entries.map((e) => e.name)).toEqual(inputs.map((i) => i.name));
    inputs.forEach((inp, i) => {
      const e = parsed.entries[i];
      const raw = typeof inp.data === 'string' ? enc.encode(inp.data) : inp.data;
      expect(e.method).toBe(0);
      expect(e.flags & 0x0800).toBe(0x0800); // bit 11: UTF-8
      expect(e.computedCrc).toBe(e.crc);
      expect(e.crc).toBe(crc32(raw));
      expect(Array.from(e.data)).toEqual(Array.from(raw));
    });
  });

  it('16. zipStore 空列表与多文件都不崩，且可被系统 unzip -l 列出（若可用）', async () => {
    const empty = zipStore([]);
    expect(readZip(empty).count).toBe(0);

    const many = Array.from({ length: 12 }, (_, i) => ({
      name: `f${i}.txt`,
      data: `payload-${i}`,
    }));
    const z = zipStore(many);
    expect(readZip(z).count).toBe(12);

    // 环境有 unzip 时额外用系统工具回读；无则跳过（自写解析器已覆盖结构与 CRC）
    const listing = await tryUnzipListing(z);
    if (listing) {
      for (const f of many) expect(listing).toContain(f.name);
    }
  });
});

describe('export: 打包产物', () => {
  it('17. buildBatchPack 无 dctl 时文件清单恰为 7 个（旧行为 + 首次上手清单），且 .cube 行数 = size^3', () => {
    const files = buildBatchPack(packInput);
    expect(files.map((f) => f.name)).toEqual([
      'cdl.json',
      'cdl.csv',
      'FM-TEST.cube',
      'FM-TEST_mount.py',
      '免费版手录说明.md',
      '参数对照表.md',
      '首次上手清单.md',
    ]);
    const cube = files.find((f) => f.name.endsWith('.cube'))!;
    const lines = cube.text.split('\n');
    expect(lines[0]).toContain('TITLE');
    expect(lines[1]).toBe('LUT_3D_SIZE 33');
    const dataLines = lines.filter((l) => /^-?\d+\.\d+ -?\d+\.\d+ -?\d+\.\d+$/.test(l)).length;
    expect(dataLines).toBe(33 * 33 * 33);
    // 7 个文件均可打包回读
    const parsed = readZip(zipStore(files));
    expect(parsed.entries.map((e) => e.name)).toEqual(files.map((f) => f.name));
    parsed.entries.forEach((e, i) => {
      expect(e.computedCrc).toBe(e.crc);
      expect(dec.decode(e.data)).toBe(files[i].text);
    });
  });

  it('18. mountScriptPy：每段一行 SetCDL( 与 SetLUT(，段数一致，无第三方品牌词', () => {
    const py = mountScriptPy({ entries, lutName: 'FM-TEST.cube', lutSize: 33 });
    expect(py.split('SetCDL(').length - 1).toBe(entries.length);
    expect(py.split('SetLUT(').length - 1).toBe(entries.length);
    expect(py).toContain('需 Studio 版');
    expect(py).toContain('FM-TEST.cube');
    // 只允许「达芬奇」，不得出现第三方品牌/胶片商标
    expect(py).not.toMatch(/kodak|davinci|portra|ektar|fuji|ilford|vision3|cinestill|lomo|agfa|tri-x/i);
    expect(py).toContain('达芬奇');
  });

  it('19. 免费版手录说明/参数对照表含每段数值与区间说明', () => {
    const guide = freeVersionGuideMd({ entries, lutName: 'FM-TEST.cube' });
    const table = buildBatchPack(packInput).find((f) => f.name === '参数对照表.md') as PackFile;
    for (const e of entries) {
      expect(guide).toContain(e.name);
      expect(table.text).toContain(e.name);
    }
    expect(guide).toContain('FM-TEST.cube');
    expect(guide).toContain('免费版');
    expect(table.text).toContain('slope');
    expect(table.text).toContain('0.5 – 2.0');
    expect(table.text).toContain('offset');
    expect(table.text).toContain('power');
    expect(table.text).toContain('sat');
  });
});

describe('export: 合成序列确定性', () => {
  it('20. synthSeries 同参数两次调用逐像素一致，帧名/尺寸正确', () => {
    const a = synthSeries(64, 48, 7);
    const b = synthSeries(64, 48, 7);
    expect(a.length).toBe(7);
    expect(a.map((f) => f.name)).toEqual(['seg01', 'seg02', 'seg03', 'seg04', 'seg05', 'seg06', 'seg07']);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].w).toBe(64);
      expect(a[i].h).toBe(48);
      expect(Array.from(a[i].data)).toEqual(Array.from(b[i].data));
    }
  });
});

/* ================= R6：包并入 .dctl + 首次上手清单 + 过时说法回归 ================= */

describe('export: R6 交付包升级', () => {
  it('21. 有 dctl 时包内含 .dctl（8 条目、内容逐字节一致）；无 dctl 时不含（旧行为不变）', () => {
    const files = buildBatchPack(packInputWithDctl);
    expect(files.map((f) => f.name)).toEqual([
      'cdl.json',
      'cdl.csv',
      'FM-TEST.cube',
      'FM-TEST.dctl',
      'FM-TEST_mount.py',
      '免费版手录说明.md',
      '参数对照表.md',
      '首次上手清单.md',
    ]);
    // 逐字节一致：PackFile 文本 → zip 数据 → 与传入 source 的 UTF-8 字节序列全等
    const parsed = readZip(zipStore(files));
    expect(parsed.count).toBe(8);
    expect(parsed.entries.map((e) => e.name)).toEqual(files.map((f) => f.name));
    const dctl = parsed.entries.find((e) => e.name === 'FM-TEST.dctl')!;
    expect(Array.from(dctl.data)).toEqual(Array.from(enc.encode(dctlSource)));
    expect(dctl.computedCrc).toBe(dctl.crc);
    expect(dec.decode(dctl.data)).toBe(dctlSource);

    // 无 dctl 输入：不含 .dctl 条目（条目数与名称都不变）
    const plain = buildBatchPack(packInput);
    expect(plain.some((f) => f.name.endsWith('.dctl'))).toBe(false);
    expect(readZip(zipStore(plain)).entries.some((e) => e.name.endsWith('.dctl'))).toBe(false);

    // 可选字段（params/pipeline/compat）全缺时仍能生成文档；文件名过 safeZipName
    const minimal = buildBatchPack({
      ...packInput,
      dctl: { fileName: 'sub/dir\\FM X.dctl', source: dctlSource },
    });
    expect(minimal.map((f) => f.name)).toContain('sub_dir_FM X.dctl');
    expect(minimal.length).toBe(8);
    expect(packDoc({ ...packInput, dctl: { fileName: 'FM-TEST.dctl', source: dctlSource } }, '首次上手清单.md'))
      .toContain('本次未附参数摘要，请在 DCTL 生成页查看');
  });

  it('22. 首次上手清单.md：五节标题齐备 + 节点链关键串 + 文末包内文件清单', () => {
    const doc = packDoc(packInputWithDctl, '首次上手清单.md');
    for (const h of ['## 一、文件放哪', '## 二、节点怎么连', '## 三、滑杆对照', '## 四、已知差异（诚实边界）', '## 五、免费版怎么办']) {
      expect(doc).toContain(h);
    }
    // 节点链：① 校正 → ② CDL 节点 → ③ DCTL 节点 → ④ 统一风格层 LUT
    expect(doc).toContain('CDL 节点');
    expect(doc).toContain('DCTL 节点');
    expect(doc).toContain('统一风格层 LUT');
    expect(doc).toContain('cdl.csv');
    expect(doc).toContain('FM-TEST_mount.py');
    expect(doc).toContain('二选一');
    expect(doc).toContain('重复叠加');
    // 文件放哪一节：四类文件的去处
    expect(doc).toContain('LUT 目录');
    expect(doc).toContain('DCTL 目录');
    expect(doc).toContain('Studio 版');
    expect(doc).toContain('数值留档');
    // 文末清单由实际 files 生成
    const files = buildBatchPack(packInputWithDctl);
    expect(doc).toContain(`包内文件（${files.length} 个）`);
    for (const f of files) expect(doc).toContain(`\`${f.name}\``);
  });

  it('23. 首次上手清单.md：滑杆对照按 group 分小节（look/光晕/柔光/颗粒/暗角/其他）+ 表头与行内容', () => {
    const doc = packDoc(packInputWithDctl, '首次上手清单.md');
    for (const g of ['### 色彩 look', '### 光晕', '### 柔光', '### 颗粒', '### 暗角', '### 其他']) {
      expect(doc).toContain(g);
    }
    expect(doc).toContain('| 分组 | 参数 | 中性值 | 范围 | 说明 |');
    // 中性值：look 恒等 1 / 层强度 0 / 结构量 —
    expect(doc).toContain('| 色彩 look | 对比度 Contrast | 1 | 0 – 2 | 绕枢轴的整体反差 |');
    expect(doc).toContain('| 光晕 | 光晕-强度 Halation Amount | 0 | 0 – 1 | 光晕强度 |');
    expect(doc).toContain('| 颗粒 | 颗粒-尺寸 Grain Size px | — | 0.5 – 20 | — |'); // tip 缺失 → —
    expect(doc).toContain('| 暗角 | 暗角-强度 Vignette Amount | 0 | 0 – 1 | 暗角强度 |');
    expect(doc).toContain('| 其他 | 其他参数 Unknown X | — | 0 – 1 | — |'); // group 缺失 → 其他
    // bool：兼容模式是 0/1 滑杆，中性值＝关
    expect(doc).toContain('| 光晕 | 光晕-开关 Halation On | 0（关） | 0 – 1（0/1 滑杆） | 光晕层总开关 |');
    expect(doc).toContain('| 柔光 | 柔光-开关 Bloom On | 0（关） | 0 – 1（0/1 滑杆） | — |');
    // 组内保持传入顺序（光晕组：开关行在强度行之前）
    const onRow = doc.indexOf('| 光晕 | 光晕-开关 Halation On |');
    const amountRow = doc.indexOf('| 光晕 | 光晕-强度 Halation Amount |');
    expect(onRow).toBeGreaterThan(-1);
    expect(amountRow).toBeGreaterThan(-1);
    expect(onRow).toBeLessThan(amountRow);
    // 组间顺序固定：色彩 look 在光晕之前
    expect(doc.indexOf('### 色彩 look')).toBeLessThan(doc.indexOf('### 光晕'));
    // 兼容模式说明 + 无 params 时的退化行
    expect(doc).toContain('兼容模式');
    expect(doc).toContain('Halation Amount');
    expect(packDoc(packInput, '首次上手清单.md')).toContain('本次未附参数摘要，请在 DCTL 生成页查看');
  });

  it('24. 首次上手清单.md：含「重启达芬奇」「2160p」与其余诚实边界条目', () => {
    const doc = packDoc(packInputWithDctl, '首次上手清单.md');
    expect(doc).toContain('重启达芬奇');
    expect(doc).toContain('Update Lists');
    expect(doc).toContain('2160p');
    expect(doc).toContain('×2');
    expect(doc).toContain('静态');       // 静态颗粒 vs 网页端动态颗粒
    expect(doc).toContain('动态颗粒');
    expect(doc).toContain('源图');       // 亮通阈值作用位置
    expect(doc).toContain('CUDA');       // 实机验证环境
    expect(doc).toContain('OpenCL');
    expect(doc).toContain('中英混排');   // 标签/tooltip 未实机验证
    // 免费版一节：引到同包《免费版手录说明.md》+ 质感层不再需要手录
    expect(doc).toContain('免费版手录说明.md');
    expect(doc).toContain('不再需要手录');
  });

  it('25. 过时说法回归：包内任何文件都不含「质感层只能」「不进 .cube：由」「只能靠手录」', () => {
    const stale = ['质感层只能', '不进 .cube：由', '只能靠手录'];
    for (const input of [packInput, packInputWithDctl]) {
      for (const f of buildBatchPack(input)) {
        for (const s of stale) {
          expect(f.text, `${f.name} 含过时说法「${s}」`).not.toContain(s);
        }
      }
    }
    // 旧文案的另外两个特征串也不该再出现
    const py = mountScriptPy({ entries, lutName: 'FM-TEST.cube', lutSize: 33 });
    expect(py).not.toContain('_mount.py` 节点树');
    expect(packDoc(packInputWithDctl, '免费版手录说明.md')).not.toContain('该 LUT 负责统一风格（影调/质感）');
    // 品牌红线：包内任何文件（含新文档）都不含第三方品牌 / 胶片商标
    const brand = ['Kodak', 'Vision3', 'CineStill', 'Dehancer', 'Exposure', 'portra', 'ektar', 'fuji', 'ilford', 'lomo', 'agfa', 'tri-x'];
    for (const f of buildBatchPack(packInputWithDctl)) {
      for (const w of brand) {
        expect(f.text.toLowerCase(), `${f.name} 含品牌词 ${w}`).not.toContain(w.toLowerCase());
      }
    }
  });

  it('26. 免费版手录说明：质感层改由同包 .dctl 承载，逐段 CDL 手录表保留', () => {
    const guide = freeVersionGuideMd({ entries, lutName: 'FM-TEST.cube' });
    expect(guide).toContain('由同包 `.dctl` 在达芬奇里承载');
    expect(guide).toContain('免费版同样能加载 DCTL');
    expect(guide).toContain('只负责**色彩 look**');
    expect(guide).toContain('重复叠加');
    // CDL 手录部分照旧（免费版确实没有 CDL 面板）
    expect(guide).toContain('校色器');
    expect(guide).toContain('slope（R/G/B）');
    expect(guide).toContain('offset（R/G/B）');
    expect(guide).toContain('power（R/G/B）');
    for (const e of entries) expect(guide).toContain(e.name);
    expect(guide).toContain('FM-TEST.cube');
  });

  it('27. 挂载脚本注释补「③ DCTL 节点与 ④ 统一 LUT 二选一」，且不影响逐段调用计数', () => {
    const py = mountScriptPy({ entries, lutName: 'FM-TEST.cube', lutSize: 33 });
    expect(py).toContain('③ DCTL 节点');
    expect(py).toContain('④ 统一风格层 LUT');
    expect(py).toContain('二选一');
    expect(py.split('SetCDL(').length - 1).toBe(entries.length);
    expect(py.split('SetLUT(').length - 1).toBe(entries.length);
  });
});

/* ================= R7：逐段单节点 DCTL（single 模式） ================= */

describe('export: R7 逐段单节点 DCTL', () => {
  it('28. single 模式：包内 N 个 .dctl（_segNN_ 命名）、不含单节点 dctl 条目、文件数 = 7 + N、内容逐字节一致', () => {
    const files = buildBatchPack(packInputSingle);
    expect(files.map((f) => f.name)).toEqual([
      'cdl.json',
      'cdl.csv',
      'FM-TEST.cube',
      'FM-TEST_seg01_seg01.dctl',
      'FM-TEST_seg02_seg02.dctl',
      'FM-TEST_mount.py',
      '免费版手录说明.md',
      '参数对照表.md',
      '首次上手清单.md',
    ]);
    expect(files.length).toBe(7 + segDctls.length);
    expect(files.some((f) => f.name === 'FM-TEST.dctl')).toBe(false);
    // 文件名含两位序号 _segNN_
    expect(files.filter((f) => f.name.endsWith('.dctl')).every((f) => /_seg\d{2}_/.test(f.name))).toBe(true);
    // 逐字节：PackFile 文本 → zip 数据 → 与传入 source 的 UTF-8 字节序列全等
    const parsed = readZip(zipStore(files));
    expect(parsed.count).toBe(7 + segDctls.length);
    for (const d of segDctls) {
      const e = parsed.entries.find((x) => x.name === d.fileName)!;
      expect(e).toBeTruthy();
      expect(Array.from(e.data)).toEqual(Array.from(enc.encode(d.source)));
      expect(e.computedCrc).toBe(e.crc);
      expect(dec.decode(e.data)).toBe(d.source);
    }
    // 即使同时传了单个 dctl，single 模式也不把它塞进包（dctls 替代 dctl，两者不并存）
    const both = buildBatchPack({ ...packInputSingle, dctl: packInputWithDctl.dctl });
    expect(both.some((f) => f.name === 'FM-TEST.dctl')).toBe(false);
    expect(both.length).toBe(7 + segDctls.length);
    // 文件名过 safeZipName（路径分隔符不进 zip 条目名）
    const sanitized = buildBatchPack({ ...packInputSingle, dctls: [{ fileName: 'sub/dir\\a.dctl', source: 'x' }] });
    expect(sanitized.map((f) => f.name)).toContain('sub_dir_a.dctl');
    // single 但没给 dctls：仍 7 个（不伪造逐段文件）
    expect(buildBatchPack({ ...packInput, mode: 'single' }).length).toBe(7);
  });

  it('29. 文档随模式切换：single 含「一个节点搞定」/不含「CDL 节点（匹配）」，cdl 反之（不串味）', () => {
    const docSingle = packDoc(packInputSingle, '首次上手清单.md');
    const docCdl = packDoc(packInputWithDctl, '首次上手清单.md');
    // single：单节点链
    expect(docSingle).toContain('一个节点搞定');
    expect(docSingle).toContain('① 校正 → ② DCTL 节点');
    expect(docSingle).not.toContain('CDL 节点（匹配');
    expect(docSingle).toContain('不要再叠加统一风格层 LUT');
    expect(docSingle).toContain('FM_MATCH_ON');
    expect(docSingle).toContain('10 个系数');
    // cdl：R6 的 ②/③/④ 链保持原样
    expect(docCdl).toContain('CDL 节点（匹配');
    expect(docCdl).toContain('④ 统一风格层 LUT');
    expect(docCdl).toContain('二选一');
    expect(docCdl).not.toContain('一个节点搞定');
    // 五节标题两模式都在；文末清单按实际文件数（single = 7 + N）
    for (const h of ['## 一、文件放哪', '## 二、节点怎么连', '## 三、滑杆对照', '## 四、已知差异（诚实边界）', '## 五、免费版怎么办']) {
      expect(docSingle).toContain(h);
      expect(docCdl).toContain(h);
    }
    expect(docSingle).toContain(`包内文件（${7 + segDctls.length} 个）`);
    // single 保留兜底措辞（连 DCTL 都用不了 → 退回统一 LUT + 手录 CDL）
    expect(docSingle).toContain('连 DCTL 都用不了');
    // 品牌红线：新文档同样不含第三方品牌 / 胶片商标
    const brand = ['kodak', 'davinci', 'portra', 'ektar', 'fuji', 'ilford', 'vision3', 'cinestill', 'lomo', 'agfa', 'tri-x'];
    for (const f of buildBatchPack(packInputSingle)) {
      for (const w of brand) expect(f.text.toLowerCase(), `${f.name} 含品牌词 ${w}`).not.toContain(w);
    }
  });

  it('30. single 模式的《免费版手录说明》：主流程＝逐段挂 .dctl，手录降级为兜底（不矛盾）', () => {
    const g = freeVersionGuideMd({ entries, lutName: 'FM-TEST.cube', mode: 'single', dctls: segDctls });
    expect(g).toContain('第一步：逐段挂自己的 .dctl');
    expect(g).not.toContain('## 第一步：挂统一风格层 LUT');
    expect(g).toContain('第二步（兜底）');
    expect(g).toContain('连 DCTL 都用不了');
    expect(g).toContain('不要再叠加统一风格层 LUT');
    expect(g).toContain('同样能加载 DCTL');
    for (const d of segDctls) expect(g).toContain(d.fileName);
    // 兜底路线的手录材料仍齐备（映射表 + 逐段数值 + LUT 名）
    expect(g).toContain('校色器');
    expect(g).toContain('slope（R/G/B）');
    expect(g).toContain('FM-TEST.cube');
    for (const e of entries) expect(g).toContain(e.name);
    // cdl 模式未被改坏：第一步仍是挂统一 LUT（与 R6 一致）
    const c = freeVersionGuideMd({ entries, lutName: 'FM-TEST.cube' });
    expect(c).toContain('## 第一步：挂统一风格层 LUT');
    expect(c).not.toContain('第一步：逐段挂自己的 .dctl');
  });

  it('31. 逐段 DCTL 对照表：片段名 / 文件名 / CDL 摘要进文档（仅 single 模式）', () => {
    const doc = packDoc(packInputSingle, '首次上手清单.md');
    expect(doc).toContain('### 逐段 DCTL 对照表');
    expect(doc).toContain('| 片段名 | .dctl 文件名 | 该段 CDL 摘要 |');
    segDctls.forEach((d, i) => {
      expect(doc).toContain(entries[i].name);
      expect(doc).toContain(`| ${entries[i].name} | \`${d.fileName}\` | ${d.label} |`);
    });
    // label 缺失写「—」而不是崩；片段名仍来自 entries 同序
    const noLabel = packDoc(
      { ...packInputSingle, dctls: [{ fileName: 'a.dctl', source: 'x' }] },
      '首次上手清单.md',
    );
    expect(noLabel).toContain(`| ${entries[0].name} | \`a.dctl\` | — |`);
    // cdl 模式没有这张表
    expect(packDoc(packInputWithDctl, '首次上手清单.md')).not.toContain('逐段 DCTL 对照表');
  });

  it('32. 回归：不传 dctls/mode 时包结构与 R6 完全一致（8 文件、含单 .dctl）；只传 dctls 时自动按 single', () => {
    const files = buildBatchPack(packInputWithDctl);
    expect(files.map((f) => f.name)).toEqual([
      'cdl.json',
      'cdl.csv',
      'FM-TEST.cube',
      'FM-TEST.dctl',
      'FM-TEST_mount.py',
      '免费版手录说明.md',
      '参数对照表.md',
      '首次上手清单.md',
    ]);
    const doc = packDoc(packInputWithDctl, '首次上手清单.md');
    expect(doc).not.toContain('一个节点搞定');
    expect(doc).not.toContain('逐段 DCTL 对照表');
    expect(doc).toContain('③ DCTL 节点');
    expect(doc).toContain('CDL 节点（匹配');
    // 挂载脚本 / 免费版说明 / 参数对照表都不因新增模式而变化
    expect(files.find((f) => f.name === 'FM-TEST_mount.py')!.text)
      .toBe(mountScriptPy({ entries, lutName: 'FM-TEST.cube', lutSize: 33 }));
    expect(files.find((f) => f.name === '免费版手录说明.md')!.text)
      .toBe(freeVersionGuideMd({ entries, lutName: 'FM-TEST.cube' }));
    // 只给 dctls 不给 mode：自动按 single 处理（逐段 DCTL 存在即代表该模式）
    const inferred = { ...packInput, dctls: segDctls };
    expect(buildBatchPack(inferred).length).toBe(7 + segDctls.length);
    expect(packDoc(inferred, '首次上手清单.md')).toContain('一个节点搞定');
    expect(packDoc(inferred, '首次上手清单.md')).not.toContain('CDL 节点（匹配');
  });
});

/* ================= R12：single 模式《首次上手清单》补全滑杆对照表 =================
 * R7 的 single 清单只印固定 11 项匹配表（dctls[] 只有 fileName/source/label）；
 * R12 把 dctls[].params（generateDctl 的 res.params）扩进契约 → 可印 look + 质感 + 匹配完整表。
 * 兼容：不传 params 时行为与 R11 完全一致。 */
describe('R12 single 模式参数摘要', () => {
  /** 匹配段（group='match'）+ look/质感（复用 dctlParams）→ 模拟 generateDctl(res.params) 的输出 */
  const segParams: DctlParamSummary[] = [
    { macro: 'FM_MATCH_ON', label: '匹配-开关 Match On', type: 'bool', def: true, group: 'match', tip: '匹配段总开关' },
    { macro: 'FM_MATCH_SLOPE_R', label: '匹配-斜率R Match Slope R', type: 'float', def: 1.1, min: 0.5, max: 2, group: 'match', tip: '逐通道斜率（增益）' },
    { macro: 'FM_MATCH_SAT', label: '匹配-饱和 Match Sat', type: 'float', def: 1, min: 0.5, max: 2, group: 'match', tip: '绕亮度饱和度' },
    ...dctlParams,
  ];
  /** 只在首段带 params（其余段不带）——验证「取首个带 params 的段」 */
  const segWithParams: BatchSegDctl[] = [
    { ...segDctls[0], params: segParams, pipeline: 'rcm', compat: true },
    segDctls[1],
  ];

  it('33. 传 dctls[].params → single 清单印完整滑杆对照表（匹配 + look + 质感），每个参数都在表内', () => {
    const doc = packDoc({ ...packInputSingle, dctls: segWithParams }, '首次上手清单.md');
    expect(doc).toContain('### 完整参数对照表（look + 质感 + 匹配；各段一致，按首段列出）');
    // 分组小节齐全（GROUP_ORDER 顺序）
    for (const t of ['### 匹配（内联 CDL）', '### 色彩 look', '### 光晕', '### 颗粒', '### 暗角']) {
      expect(doc, `缺分组 ${t}`).toContain(t);
    }
    // 每个参数（含匹配参数）都出现在表中（对照表按「标签」列印，宏名见固定匹配表）
    for (const p of segParams) expect(doc, `缺参数 ${p.label}`).toContain(p.label);
    // 11 项匹配参数的宏名在固定匹配表里仍在
    expect(doc).toContain('`FM_MATCH_ON`');
    expect(doc).toContain('`FM_MATCH_SLOPE_R` / `_G` / `_B`');
    expect(doc).toContain('`FM_MATCH_SAT`');
    // 管线写进小标题；匹配默认值随段的说明在表后
    expect(doc).toContain('管线：RCM');
    expect(doc).toContain('默认值＝该段解算结果');
    // 退化说明行不再出现（已被真实表取代）
    expect(doc).not.toContain('本包不逐段重复');
  });

  it('34. 不传 params → 行为与 R11 一致（只印固定匹配表 + 指向生成页），文件结构不变', () => {
    const doc = packDoc(packInputSingle, '首次上手清单.md');
    expect(doc).not.toContain('### 完整参数对照表');
    expect(doc).toContain('完整 look / 质感滑杆清单（含中性值与范围）见 DCTL 生成页；各段一致，本包不逐段重复。');
    // 固定匹配表仍在（FM_MATCH_ON 等）
    expect(doc).toContain('`FM_MATCH_ON`');
    expect(doc).toContain('| `FM_MATCH_SAT` | Match Sat |');
    // 文件数 = 7 + N（参数摘要不新增文件）
    expect(buildBatchPack(packInputSingle).length).toBe(7 + segDctls.length);
    expect(buildBatchPack({ ...packInputSingle, dctls: segWithParams }).length).toBe(7 + segWithParams.length);
  });

  it('35. params 为空数组 → 与不传等价（退化到 R11 文案，不产空表）', () => {
    const doc = packDoc({ ...packInputSingle, dctls: [{ ...segDctls[0], params: [] }] }, '首次上手清单.md');
    expect(doc).not.toContain('### 完整参数对照表');
    expect(doc).toContain('见 DCTL 生成页');
  });
});
