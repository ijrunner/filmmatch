/**
 * pipeline 着色器结构断言（R9）：不依赖 WebGL 后端，直接读源码文本，
 * 保证 GLSL 侧的团簇调制 / 片门抖动关键式与 effectmath 的冻结常数一致、
 * 且对应 uniform 被声明与赋值。数值恒等回归在 effectmath.test.ts 覆盖（纯函数）。
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error 测试在 node 下运行；本项目未安装 @types/node（其余源码不需要 node 类型）
import { readFileSync } from 'node:fs';
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('./pipeline.ts', import.meta.url)), 'utf8');

describe('R9 pipeline GLSL 结构断言', () => {
  it('20. 片门抖动：uniform 已声明且赋值，关键常数与 effectmath 一致', () => {
    expect(SRC).toContain('uniform float u_gwAmount, u_gwSpeed, u_gwT;');
    for (const u of ['u_gwAmount', 'u_gwSpeed', 'u_gwT']) {
      expect(SRC).toContain(`pr.u['${u}']`);
    }
    // 水平 sin(w)、垂直 0.6・sin(w・1.37+1.7)（与 GATE_WEAVE_* 逐式一致）
    expect(SRC).toContain('u_gwAmount*u_res.y*sin(gwW)');
    expect(SRC).toContain('u_gwAmount*u_res.y*0.6*sin(gwW*1.37+1.7)');
    // 采样 uv 限制在 [0,1]，避免抖动采出黑边
    expect(SRC).toContain('clamp(v_uv + gwSh/u_res, 0.0, 1.0)');
  });

  it('21. 颗粒团簇：uniform 声明/赋值，低频噪声用基准颗粒坐标 ×0.18 种子 91.7，深度 0.6', () => {
    expect(SRC).toContain('uniform float u_grainCluster;');
    expect(SRC).toContain("pr.u['u_grainCluster']");
    expect(SRC).toContain('vnoise(gp*0.18, 91.7)');
    expect(SRC).toContain('1.0 + u_grainCluster*(lowN-0.5)*2.0*0.6');
    // 团簇调制作用于颗粒幅度
    expect(SRC).toContain('* u_grainAmp * w * clusterGain');
  });

  it('22. 默认恒等：u_grainCluster 取 grain.cluster ?? 0，u_gwAmount 取 gate_weave.amount', () => {
    // 参数默认 cluster=0 / amount=0 → 着色器 gain≡1、位移≡0（乘 0/1 逐位恒等）
    expect(SRC).toContain("pr.u['u_grainCluster'], g.cluster ?? 0");
    expect(SRC).toContain('this.params.texture.gate_weave');
    expect(SRC).toContain("pr.u['u_gwAmount'], gwave.amount");
  });
});