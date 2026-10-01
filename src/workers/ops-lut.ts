/**
 * R10-B Worker 纯算子 —— LUT 烘焙（轻量：只依赖 ui/recipe，**不进首屏大依赖**）。
 *
 * worker 入口（lut.worker.ts）与主线程回退（main.ts 的 lutClient.sync）调用同一函数，
 * 故「同一输入 → 同一输出」是结构保证。
 */
import { bakeMatchLUT, bakeRecipeLUT, type RecipeState } from '../ui/recipe';

export interface BakeLutReq {
  state: RecipeState;
  size: 33 | 65;
  /** 'match' = 仅匹配（预览）；'recipe' = 匹配∘look 复合（导出） */
  kind: 'match' | 'recipe';
  /** R17：导出数据范围（仅 kind='recipe' 消费；缺省 'full' → 与既有路径逐位一致） */
  range?: 'full' | 'legal';
}

export interface BakeLutRes {
  size: number;
  table: Float32Array;
}

/** LUT 烘焙（与主线程同步路径同一实现） */
export function bakeLutOp(req: BakeLutReq): BakeLutRes {
  const lut = req.kind === 'recipe'
    ? bakeRecipeLUT(req.state, req.size, req.range ?? 'full')
    : bakeMatchLUT(req.state, req.size);
  return { size: lut.size, table: lut.table };
}
