/**
 * R10-B 质感降分辨率：离屏 RT 质量档选择（纯函数，可测、无 DOM/GL 依赖）。
 *
 * 背景：光晕/柔光是宽域低频模糊，真实调色软件通行做法是把它们放到**降分辨率的离屏 RT**
 * 上计算，再上采样合成——宽域模糊本身是低频，降采样损失很小，但纹理带宽/像素量按 scale² 下降。
 * 网页端管线把 halation 链放 1/4 RT、bloom 链放 1/8 RT（默认 rtScale=0.25，bloom=rtScale/2）。
 *
 * 本模块只做**决策**（后端 + 能力探测 → 有效档位 + 降级原因），实际 RT 分配在 pipeline.ts。
 * 降级（degraded=true）语义：无法在降分辨率尺寸上建立完整 FBO（或后端为 CPU）时，
 * 退回**全分辨率**路径（rtScale=1），保证任何 WebGL1/异常驱动上都能正常出图。
 */

/** 光晕离屏 RT 相对渲染目标的比例档位 */
export type RtScale = 1 | 0.5 | 0.25;

/** 默认档位：1/4 RT（与 R10-B 落地前 halation 链既有档位一致 → 默认观感恒等） */
export const DEFAULT_RT_SCALE: RtScale = 0.25;

/** 允许的档位（外部传入做合法性收敛） */
export const RT_SCALES: readonly RtScale[] = [1, 0.5, 0.25];

/** 把任意输入收敛到合法档位（非法值 → 默认档） */
export function normalizeRtScale(v: unknown): RtScale {
  return v === 1 || v === 0.5 || v === 0.25 ? v : DEFAULT_RT_SCALE;
}

export interface QualityCaps {
  /** 渲染后端 */
  backend: 'webgl2' | 'webgl1' | 'cpu';
  /** 请求档位（默认 0.25） */
  requested: RtScale;
  /** 能力探测：能否在降分辨率尺寸上建立完整 FBO（pipeline.probeReducedRt） */
  reducedFboComplete: boolean;
  /** 是否具备浮点/半浮点颜色缓冲（16F 减少暗部条带；仅影响原因标注，不影响降级） */
  floatRenderTarget: boolean;
}

export interface QualityInfo {
  /** 光晕链有效 RT 比例 */
  rtScale: RtScale;
  /** 柔光链有效 RT 比例（= rtScale / 2；默认 0.125） */
  bloomScale: number;
  /** 请求档位（便于对照是否发生降级） */
  requested: RtScale;
  /** 是否发生降级（有效档位 < 请求档位） */
  degraded: boolean;
  /** 降级/选择原因（机器可读短串，写进 meta） */
  reason: string;
}

/**
 * 质量档选择（单一真源）。规则：
 *  - CPU 后端：不走 GL 降分辨率 RT 路径（rtScale=1，reason=cpu-backend）；
 *  - 降分辨率 FBO 探测失败：退回全分辨率（rtScale=1，reason=reduced-rt-unavailable）；
 *  - 否则采用请求档位；reason 区分浮点/8 位颜色缓冲（仅标注）。
 */
export function selectQuality(caps: QualityCaps): QualityInfo {
  const requested = normalizeRtScale(caps.requested);
  if (caps.backend === 'cpu') {
    return { rtScale: 1, bloomScale: 1, requested, degraded: true, reason: 'cpu-backend' };
  }
  if (!caps.reducedFboComplete) {
    return { rtScale: 1, bloomScale: 1, requested, degraded: true, reason: 'reduced-rt-unavailable' };
  }
  return {
    rtScale: requested,
    bloomScale: requested / 2,
    requested,
    degraded: false,
    reason: caps.floatRenderTarget ? 'reduced-rt-float' : 'reduced-rt-rgba8',
  };
}

/** 人类可读标签（backendLabel / 面板展示用） */
export function qualityLabel(q: Pick<QualityInfo, 'rtScale' | 'degraded'>): string {
  if (q.degraded && q.rtScale === 1) return '质感全分辨率（降级）';
  if (q.rtScale === 1) return '质感全分辨率';
  return `质感 1/${Math.round(1 / q.rtScale)} RT`;
}
