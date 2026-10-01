/**
 * R10-B Worker 纯算子 —— 批量导出打包（bakeRecipeLUT + generateDctl + buildBatchPack + zipStore）。
 *
 * worker 入口（pack.worker.ts）与主线程回退（ui/batch.ts 的 packClient.sync）调用同一函数。
 * 依赖 dctl/codegen 与 batch/export（体积较大），故与 LUT/匹配算子分开，避免进首屏包。
 */
import { bakeRecipeLUT, shareCodeOf, type RecipeState } from '../ui/recipe';
import { buildBatchPack, zipStore, type BatchPackMode, type BatchSegDctl, type PackFile } from '../batch/export';
import { generateDctl } from '../dctl/codegen';
import { lookToLogLook, type PipelineTF } from '../dctl/logmath';
import type { Cdl, CdlEntry } from '../batch/cdl';

export interface PackReq {
  /** 统一风格层运行时状态（由主线程从 store 取出后传入；worker 不读 store） */
  state: RecipeState;
  recipeName: string;
  lutSize: 33 | 65;
  entries: CdlEntry[];
  strategy: 'A' | 'B';
  packMode: BatchPackMode;
  pipeline: PipelineTF;
  /** 打包时间戳由主线程给定 → worker/同步两条路径产出逐位一致的 zip */
  createdAt: string;
}

export interface PackFileOut {
  name: string;
  text: string;
}

export interface PackRes {
  files: PackFileOut[];
  zip: Uint8Array;
  shareCode: string;
  hasDctl: boolean;
  dctlCount: number;
}

/** 片段名 → ASCII 安全文件名短片段（与 ui/batch.ts 原实现一致） */
export function safeSegName(name: string): string {
  const t = (name || '')
    .replace(/\.[A-Za-z0-9]{1,6}$/, '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return (t || 'clip').slice(0, 24);
}

/** CDL 可读摘要（single 模式写进《首次上手清单》的逐段对照表） */
function cdlDigest(cdl: Cdl): string {
  const num = (v: unknown): number[] => (typeof v === 'number' ? [v] : Array.isArray(v) ? (v as number[]) : []);
  const tri = (v: unknown): string => num(v).map((x) => x.toFixed(6)).join('/');
  const sat = (num(cdl.sat)[0] ?? 1).toFixed(6);
  return `slope ${tri(cdl.slope)} · offset ${tri(cdl.offset)} · power ${tri(cdl.power)} · sat ${sat}`;
}

function buildSegDctls(
  code: string,
  entries: CdlEntry[],
  genOpts: Parameters<typeof generateDctl>[0],
): BatchSegDctl[] {
  return entries.map((e, i) => {
    const res = generateDctl({ ...genOpts, match: { cdl: e.cdl } });
    return {
      fileName: `${code}_seg${String(i + 1).padStart(2, '0')}_${safeSegName(e.name)}.dctl`,
      source: res.source,
      label: cdlDigest(e.cdl),
      /* R12：把该段 .dctl 的参数摘要一并传进包契约 → single 模式《首次上手清单》可印完整滑杆对照表 */
      params: res.params,
      pipeline: genOpts.pipeline,
      compat: genOpts.compat,
    };
  });
}

/** 打包（不下载）：产出文件清单 + zip 字节（与主线程同步路径同一实现） */
export function buildPackOp(req: PackReq): PackRes {
  const state = req.state;
  const size = req.lutSize;
  const lut = bakeRecipeLUT(state, size);
  const code = shareCodeOf(state);
  const recipeName = req.recipeName || '批量匹配 · 统一风格层';
  const common = {
    recipeName,
    shareCode: code,
    lutSize: size,
    lut: { size: lut.size, table: lut.table },
    entries: req.entries,
    strategy: req.strategy,
    createdAt: req.createdAt,
  };
  const genOpts = {
    recipeName,
    shareCode: code,
    pipeline: req.pipeline,
    look: lookToLogLook(state.look, req.pipeline),
    texture: state.texture,
    resolution: { w: 1920, h: 1080 },
    compat: true,
  };
  let files: PackFile[];
  if (req.packMode === 'single') {
    files = buildBatchPack({ ...common, mode: 'single', dctls: buildSegDctls(code, req.entries, genOpts) });
  } else {
    const dctl = generateDctl(genOpts);
    files = buildBatchPack({
      ...common,
      dctl: {
        fileName: `${code}.dctl`,
        source: dctl.source,
        params: dctl.params,
        pipeline: req.pipeline,
        compat: true,
      },
    });
  }
  const zip = zipStore(files.map((f) => ({ name: f.name, data: f.text })));
  const dctlCount = files.filter((f) => f.name.toLowerCase().endsWith('.dctl')).length;
  return {
    files: files.map((f) => ({ name: f.name, text: f.text })),
    zip,
    shareCode: code,
    hasDctl: dctlCount > 0,
    dctlCount,
  };
}
