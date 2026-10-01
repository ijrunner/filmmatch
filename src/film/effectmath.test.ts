/**
 * 质感层纯数学（film/effectmath.ts）单元测试：
 * 直接断言纯函数，不依赖 canvas/WebGL 后端。
 * 覆盖 Schema v1.1 新参数的「默认=恒等」约定与关键单调/守恒性质。
 */
import { describe, expect, it } from 'vitest';
import {
  bloomRadiusEff, bloomSaturationMix, bloomSaveLightsFactor,
  grainBandWeights, grainBands, grainResolutionAmp, grainSizeEff, grainWeightAt,
  halationAmplifyTintGain, halationBackgroundAtten, halationBlueCompGain,
  halationHueTint, halationRadiusEff, halationWeights,
  GRAIN_CLUSTER_DEPTH, GRAIN_CLUSTER_FREQ, GRAIN_CLUSTER_SEED, grainClusterGain,
  GATE_WEAVE_VERT_RATIO, GATE_WEAVE_FREQ_RATIO, GATE_WEAVE_PHASE, gateWeaveOffsetPx,
  type GrainBandParams,
} from './effectmath';

/** 默认颗粒段参数（与 params.defaultTexture().grain 的 v1.1 字段一致） */
const GRAIN_DEFAULTS: GrainBandParams = {
  shadow: 1, midtone: 1, highlight: 0.2, shadow_weight: 0.8, type: 'negative',
};

const SAMPLES = [0, 0.1, 0.2, 0.3, 0.43, 0.5, 0.6, 0.75, 0.85, 0.9, 1];

describe('grain 三段分区', () => {
  it('1. 三段分区函数之和恒为 1（多亮度采样）', () => {
    for (const l of SAMPLES) {
      const b = grainBands(l);
      expect(b.shadow).toBeGreaterThanOrEqual(0);
      expect(b.midtone).toBeGreaterThanOrEqual(0);
      expect(b.highlight).toBeGreaterThanOrEqual(0);
      expect(b.shadow + b.midtone + b.highlight).toBeCloseTo(1, 12);
    }
  });

  it('2a. 阴影段权重置 0 → 阴影段包络 ≈0', () => {
    const g: GrainBandParams = { ...GRAIN_DEFAULTS, shadow: 0 };
    expect(grainBandWeights(0, g).shadow).toBeCloseTo(0, 12);
    expect(grainWeightAt(0, g)).toBeCloseTo(0, 12); // l=0 仅阴影段有分量
  });

  it('2b. 中间调段权重置 0 → 中间调段包络 ≈0', () => {
    const g: GrainBandParams = { ...GRAIN_DEFAULTS, midtone: 0 };
    // l=0.43 恰为分带下沿：中间调分量 = 1，暗/高光分量 = 0
    expect(grainBands(0.43).midtone).toBeCloseTo(1, 12);
    expect(grainBandWeights(0.43, g).midtone).toBeCloseTo(0, 12);
    expect(grainWeightAt(0.43, g)).toBeCloseTo(0, 12);
  });

  it('2c. 高光段权重置 0 → 高光段包络 ≈0', () => {
    const g: GrainBandParams = { ...GRAIN_DEFAULTS, highlight: 0 };
    expect(grainBandWeights(1, g).highlight).toBeCloseTo(0, 12);
    expect(grainWeightAt(1, g)).toBeCloseTo(0, 12); // l=1 仅高光段有分量
  });

  it('3. 默认参数下与旧公式一致：l=0 时 shadow = 1×(1+0.8×1.2)×1.0', () => {
    const w = grainBandWeights(0, GRAIN_DEFAULTS);
    const expected = 1 * (1 + 0.8 * 1.2) * 1.0; // 1.96
    expect(expected).toBeCloseTo(1.96, 12);
    expect(w.shadow).toBeCloseTo(expected, 12);
    expect(w.midtone).toBeCloseTo(0, 12);
    expect(w.highlight).toBeCloseTo(0, 12);
  });

  it('4. 类型对比：negative 高光段权重 > positive（同亮度）', () => {
    const neg = grainBandWeights(1, { ...GRAIN_DEFAULTS, type: 'negative' });
    const pos = grainBandWeights(1, { ...GRAIN_DEFAULTS, type: 'positive' });
    expect(neg.highlight).toBeGreaterThan(pos.highlight);
    // 正片暗部相对更明显（对称性检查）
    expect(grainBandWeights(0, { ...GRAIN_DEFAULTS, type: 'positive' }).shadow)
      .toBeGreaterThan(grainBandWeights(0, { ...GRAIN_DEFAULTS, type: 'negative' }).shadow);
  });

  it('5. film_resolution=0.5 恒等：尺寸不变、幅度倍率=1', () => {
    expect(grainSizeEff(1.2, 0.5)).toBeCloseTo(1.2, 12);
    expect(grainSizeEff(3.7, 0.5)).toBeCloseTo(3.7, 12);
    expect(grainResolutionAmp(0.5)).toBeCloseTo(1, 12);
  });
});

describe('halation', () => {
  it('6. 背景增益：background_gain=0 且亮背景 ≈0；=1 恒等', () => {
    // 背景亮度 ≥0.85：smoothstep=1 → 下降 100%
    expect(halationBackgroundAtten(0.85, 0)).toBeCloseTo(0, 12);
    expect(halationBackgroundAtten(0.95, 0)).toBeCloseTo(0, 12);
    // 恒等：任意背景亮度下系数恒为 1
    for (const bg of SAMPLES) expect(halationBackgroundAtten(bg, 1)).toBeCloseTo(1, 12);
    // 中间背景：介于 0 与 1 之间
    const mid = halationBackgroundAtten(0.6, 0);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('7. 双半径权重：amplify 0→2 权重和不变且宽晕占比上升；impact=0 全为 0', () => {
    const amount = 0.8, master = 1, smoothness = 0.5;
    const w0 = halationWeights(amount, master, 1, 0, smoothness);
    const w2 = halationWeights(amount, master, 1, 2, smoothness);
    // 权重和恒定 → 叠加不透明度不受 amplify 影响
    expect(w0.tight + w0.wide).toBeCloseTo(w2.tight + w2.wide, 12);
    // 宽晕占比随 amplify 上升
    const frac0 = w0.wide / (w0.tight + w0.wide);
    const frac2 = w2.wide / (w2.tight + w2.wide);
    expect(frac2).toBeGreaterThan(frac0);
    // impact=0 → 效果不可见
    const off = halationWeights(amount, master, 0, 1, smoothness);
    expect(off.tight).toBeCloseTo(0, 12);
    expect(off.wide).toBeCloseTo(0, 12);
  });

  it('8. 半径/散射色相增益/绿层灵敏度在默认值上恒等', () => {
    expect(halationRadiusEff(1.8, 1, 0.5)).toBeCloseTo(1.8, 12);
    expect(halationRadiusEff(2.8, 1, 0.5)).toBeCloseTo(2.8, 12);
    expect(halationAmplifyTintGain(1)).toBeCloseTo(1, 12);
    const tint: [number, number, number] = [1.0, 0.35, 0.2];
    const out = halationHueTint(tint, 0.5);
    expect(out[0]).toBeCloseTo(tint[0], 12);
    expect(out[1]).toBeCloseTo(tint[1], 12);
    expect(out[2]).toBeCloseTo(tint[2], 12);
    // 两端：hue=0 更红（绿增益低）、hue=1 更黄（绿增益高）
    expect(halationHueTint(tint, 1)[1]).toBeGreaterThan(halationHueTint(tint, 0)[1]);
  });

  it('9. 冷背景补偿：blue_comp=0 恒等；冷背景（b>r）时 >1', () => {
    expect(halationBlueCompGain(0.2, 0.5, 0)).toBeCloseTo(1, 12);
    expect(halationBlueCompGain(0.6, 0.1, 1)).toBeCloseTo(1, 12); // 暖背景（r>b）不补偿
    const cold = halationBlueCompGain(0.2, 0.5, 1);
    expect(cold).toBeGreaterThan(1);
    // blue_comp 越大补偿越强
    expect(halationBlueCompGain(0.2, 0.5, 1)).toBeGreaterThan(halationBlueCompGain(0.2, 0.5, 0.3));
  });
});

describe('bloom', () => {
  it('10. 高光保护/半径/饱和在默认值上恒等；save_lights=1 且 luma≥1 时 ≈0', () => {
    for (const l of SAMPLES) expect(bloomSaveLightsFactor(l, 0)).toBeCloseTo(1, 12);
    expect(bloomRadiusEff(2.0, 0.5)).toBeCloseTo(2.0, 12);
    const c: [number, number, number] = [0.9, 0.4, 0.2];
    const same = bloomSaturationMix(c, 1);
    expect(same[0]).toBeCloseTo(c[0], 12);
    expect(same[1]).toBeCloseTo(c[1], 12);
    expect(same[2]).toBeCloseTo(c[2], 12);
    // 高光保护：最亮处效果贡献被压到 0
    expect(bloomSaveLightsFactor(1, 1)).toBeCloseTo(0, 12);
    expect(bloomSaveLightsFactor(0.9, 1)).toBeLessThan(1);
  });

  it('11. 大小光源分配：details 越大半径越小', () => {
    const r = 3.0;
    expect(bloomRadiusEff(r, 1)).toBeLessThan(bloomRadiusEff(r, 0.5));
    expect(bloomRadiusEff(r, 0.5)).toBeLessThan(bloomRadiusEff(r, 0));
    expect(bloomRadiusEff(r, 0)).toBeCloseTo(r * 1.4, 12);
    expect(bloomRadiusEff(r, 1)).toBeCloseTo(r * 0.6, 12);
  });

  it('12. 效果降饱和：saturation=0 时效果层变灰（各通道等于亮度）', () => {
    const c: [number, number, number] = [0.9, 0.4, 0.2];
    const gray = bloomSaturationMix(c, 0);
    expect(gray[0]).toBeCloseTo(gray[1], 12);
    expect(gray[1]).toBeCloseTo(gray[2], 12);
  });
});

describe('R9 扫描颗粒团簇 grainClusterGain', () => {
  it('13. cluster=0 → 恒等 1（任意 low）', () => {
    for (const low of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(grainClusterGain(low, 0)).toBe(1);
    }
  });

  it('14. cluster=1, low=0.5 → 1（中值无偏移）；low=1 → 1+DEPTH；low=0 → 1−DEPTH', () => {
    expect(grainClusterGain(0.5, 1)).toBeCloseTo(1, 12);
    expect(grainClusterGain(1, 1)).toBeCloseTo(1 + GRAIN_CLUSTER_DEPTH, 12);
    expect(grainClusterGain(0, 1)).toBeCloseTo(1 - GRAIN_CLUSTER_DEPTH, 12);
    // 常数锁定（与 DCTL 侧逐式一致）
    expect(GRAIN_CLUSTER_DEPTH).toBe(0.6);
    expect(GRAIN_CLUSTER_FREQ).toBe(0.18);
    expect(GRAIN_CLUSTER_SEED).toBe(91.7);
  });

  it('15. 单调整：low 越大 gain 越大；cluster 越大偏离 1 越远', () => {
    expect(grainClusterGain(0.9, 1)).toBeGreaterThan(grainClusterGain(0.6, 1));
    expect(grainClusterGain(1, 1)).toBeGreaterThan(grainClusterGain(1, 0.5));
  });
});

describe('R9 片门抖动 gateWeaveOffsetPx', () => {
  it('16. amount=0 → 恒等 {0,0}；常数锁定', () => {
    for (const t of [0, 0.1, 0.5, 1.7, 3.3]) {
      const o = gateWeaveOffsetPx(0, 1, t, 1080);
      // 注意：sin 可为负 → 0×负 得 -0；用 === 判定（Object.is 会把 -0 与 0 视为不同）
      expect(o.dx === 0).toBe(true);
      expect(o.dy === 0).toBe(true);
    }
    expect(GATE_WEAVE_VERT_RATIO).toBe(0.6);
    expect(GATE_WEAVE_FREQ_RATIO).toBe(1.37);
    expect(GATE_WEAVE_PHASE).toBe(1.7);
  });

  it('17. speed=1, t=0 → dx=0；t=0.25 → dx=amount·H（sin(π/2)=1）', () => {
    const H = 1000, amount = 0.01;
    expect(gateWeaveOffsetPx(amount, 1, 0, H).dx).toBeCloseTo(0, 12);
    expect(gateWeaveOffsetPx(amount, 1, 0.25, H).dx).toBeCloseTo(amount * H, 10);
  });

  it('18. dy 相位/频率比符合公式（手算对照）', () => {
    const H = 1000, amount = 0.01, speed = 1, t = 0.4;
    const w = 2 * Math.PI * speed * t;
    const expectedDy = amount * H * GATE_WEAVE_VERT_RATIO * Math.sin(w * GATE_WEAVE_FREQ_RATIO + GATE_WEAVE_PHASE);
    expect(gateWeaveOffsetPx(amount, speed, t, H).dy).toBeCloseTo(expectedDy, 10);
  });

  it('19. 有界性：|dx| ≤ amount·H，|dy| ≤ amount·H·VERT_RATIO', () => {
    const H = 1080, amount = 0.02, speed = 1.3;
    const bx = amount * H, by = amount * H * GATE_WEAVE_VERT_RATIO;
    for (let t = 0; t < 5; t += 0.037) {
      const o = gateWeaveOffsetPx(amount, speed, t, H);
      expect(Math.abs(o.dx)).toBeLessThanOrEqual(bx + 1e-9);
      expect(Math.abs(o.dy)).toBeLessThanOrEqual(by + 1e-9);
    }
  });
});
