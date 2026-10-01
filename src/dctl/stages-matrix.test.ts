/**
 * R13 · 层裁剪组合矩阵（穷举）。
 *
 * generateDctl 支持 6 个可裁剪层：match / halation / bloom / grain / vignette / gate_weave。
 * 既有测试只覆盖 16（4 层）、16×match、32（5 层）等子集；本文件**穷举 2^6 = 64 种组合**
 * （再 × dynamicGrain true/false = 128 份产物），逐份断言：
 *   ① 参数面板与代码块同进同退（关掉的层：参数与代码里都不再出现该层宏）；
 *   ② 尾部完整（transform 顶层 return 在、无残留层标记、无未声明宏）；
 *   ③ validateDctl 静态校验通过；
 *   ④ 参数清单与 DEFINE_UI_PARAMS 行数一一对应。
 *
 * 这样把「层裁剪吃掉 transform 尾部 → 达芬奇只报含糊的 return value 错误」这类
 * 静默缺陷挡在生成阶段（不变量来自 R4/R7/R9）。
 */
import { describe, expect, it } from 'vitest';
import { getPreset } from '../film/params';
import { lookToLogLook } from './logmath';
import { generateDctl, validateDctl, type DctlGenInput } from './codegen';
import { solvedSampleCdl } from './samples';

const STAGES = ['match', 'halation', 'bloom', 'grain', 'vignette', 'gate_weave'] as const;
type Stage = (typeof STAGES)[number];

function baseInput(): DctlGenInput {
  const card = getPreset('fl06');
  return {
    recipeName: card.name,
    shareCode: 'FM-R13-STG',
    pipeline: 'yrgb',
    look: lookToLogLook(card.params.look, 'yrgb'),
    texture: card.params.texture,
    resolution: { w: 1920, h: 1080 },
    match: { cdl: solvedSampleCdl() },
  };
}

/** 6 位掩码 → stages 表（bit=1 表示该层开启） */
function stagesOf(mask: number): Partial<Record<Stage, boolean>> {
  const st: Partial<Record<Stage, boolean>> = {};
  STAGES.forEach((s, i) => { st[s] = ((mask >> i) & 1) === 1; });
  return st;
}
const label = (mask: number): string => STAGES.map((s, i) => (((mask >> i) & 1) ? s : '')).filter(Boolean).join('+') || '（全关）';

describe('R13 层裁剪组合矩阵：2^6 = 64 组合 × dynamicGrain', () => {
  for (const dynamicGrain of [true, false]) {
    for (let mask = 0; mask < 64; mask++) {
      const on = label(mask);
      it(`[${dynamicGrain ? 'dyn' : 'static'}] mask=${mask} (${on})：同进同退 + 尾部完整 + 校验通过`, () => {
        const input: DctlGenInput = { ...baseInput(), stages: stagesOf(mask), dynamicGrain };
        const res = generateDctl(input);
        const src = res.source;

        // ③ 静态校验通过
        const v = validateDctl(src);
        expect(v.errors).toEqual([]);
        expect(v.ok).toBe(true);

        // ② 尾部完整
        expect(src).not.toMatch(/>>>STAGE|<<<STAGE/);
        expect(src).toContain('return make_float3(fm_clamp01(c.x), fm_clamp01(c.y), fm_clamp01(c.z));');
        expect(src.trimEnd().endsWith('}')).toBe(true);

        // ④ 参数清单与声明行一一对应
        const nDecl = (src.match(/^[ \t]*DEFINE_UI_PARAMS\s*\(/gm) || []).length;
        expect(nDecl).toBe(res.params.length);

        // ⑤ R21：FM_MASTER（质感总强度）只在含质感层（光晕/柔光/颗粒/暗角任一）的形态出现；
        // 片门抖动不受 master 缩放（与网页端一致），仅片门开启时不构成保留理由。
        const texLayerOn = (['halation', 'bloom', 'grain', 'vignette'] as const)
          .some((s) => ((mask >> STAGES.indexOf(s)) & 1) === 1);
        expect(res.params.some((p) => p.macro === 'FM_MASTER')).toBe(texLayerOn);
        expect(src.includes('FM_MASTER')).toBe(texLayerOn);

        for (const s of STAGES) {
          const prefix = `FM_${s.toUpperCase()}_`;
          const enabled = ((mask >> STAGES.indexOf(s)) & 1) === 1;
          const inParams = res.params.some((p) => p.macro.startsWith(prefix));
          const inCode = src.includes(prefix);
          if (enabled) {
            expect(inParams, `${s} 开启 → 参数应在`).toBe(true);
            /* 例外：dynamicGrain:false 时片门抖动参数保留但代码退化为 0（不引用帧索引，见 warnings）。
             * 这是 R9 的既定契约，如实断言而不是放宽。 */
            if (!(s === 'gate_weave' && !dynamicGrain)) {
              expect(inCode, `${s} 开启 → 代码应引用`).toBe(true);
            }
          } else {
            expect(inParams, `${s} 关闭 → 参数应消失`).toBe(false);
            expect(inCode, `${s} 关闭 → 代码应消失`).toBe(false);
          }
        }

        // 暗角层：开启走色散取样（FM_VIGNETTE_CHROMA_PX），关闭走退化取样（cx/cy 同点）。
        // R14：若 halation/bloom/vignette/gate_weave 全关（无任何邻域采样）→ 改用逐像素签名，
        // src 直接取 p_R/p_G/p_B（不再 _tex2D）。
        const texStageOn = (['halation', 'bloom', 'vignette', 'gate_weave'] as const)
          .some((s) => ((mask >> STAGES.indexOf(s)) & 1) === 1);
        const degenerate = 'float3 src = make_float3(_tex2D(p_TexR, cx, cy), _tex2D(p_TexG, cx, cy), _tex2D(p_TexB, cx, cy));';
        if (!texStageOn) {
          expect(src).toContain('float3 src = make_float3(p_R, p_G, p_B);');
          expect(src).not.toContain('_tex2D(');
        } else if (((mask >> STAGES.indexOf('vignette')) & 1) === 1) {
          expect(src).toContain('FM_VIGNETTE_CHROMA_PX');
          expect(src).not.toContain(degenerate);
        } else {
          expect(src).toContain(degenerate);
        }

        // 帧索引只在「开启动态颗粒」且「有层消费它（grain 或 gate_weave）」时出现
        const grainOn = ((mask >> STAGES.indexOf('grain')) & 1) === 1;
        const gateOn = ((mask >> STAGES.indexOf('gate_weave')) & 1) === 1;
        expect(src.includes('TIMELINE_FRAME_INDEX')).toBe(dynamicGrain && (grainOn || gateOn));
      });
    }
  }
});
