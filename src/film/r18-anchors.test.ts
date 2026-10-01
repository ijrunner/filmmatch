/**
 * R18 · 按管线锚点标定（C3）验收测试。
 *
 * 锚点语义（effectmath 冻结）：anchors = 卡的关键点位在该管线归一化工作域中的落点
 * （black / white / pivot）。重标定：fade = (1−white)/0.08、black_lift = black − 0.1×fade、
 * pivot = anchors.pivot。护栏：
 *   ① 无锚点卡/配方 → lookToLogLook 输出与 R18 之前逐位一致；
 *   ② 有锚点 → 重标定后的对数域 look 在该管线的关键点位落点 = 锚点（自洽闭环）；
 *   ③ 同一张卡在 yrgb / rcm 两条管线的关键点位显示域落点一致（切管线语义不漂移）；
 *   ④ fl05/fl06 的锚点示例值 = 由卡参数推导（anchorsFromLook 公式）。
 */
import { describe, expect, it } from 'vitest';
import {
  anchorsToLookCal, lookCalToAnchors, lookTonalLandings, clamp01, type PipelineAnchors,
} from './effectmath';
import { anchorsFromLook, anchorsForPipeline, applyLogLook, lookToLogLook, tfDecode, tfEncode } from '../dctl/logmath';
import { defaultParams, getPreset, type CardAnchorsT } from './params';

const TOL = 1e-9;

describe('R18 锚点：重标定数学（effectmath 单一真源）', () => {
  it('anchorsToLookCal：白位优先反解 fade，黑位取差值，全部钳制', () => {
    const cal = anchorsToLookCal({ black: 0.12, white: 0.94, pivot: 0.333 });
    expect(cal.fade).toBeCloseTo((1 - 0.94) / 0.08, 12);
    expect(cal.black_lift).toBeCloseTo(0.12 - 0.1 * cal.fade, 12);
    expect(cal.pivot).toBe(0.333);
    /* 越界钳制 */
    const clamped = anchorsToLookCal({ black: -1, white: 3, pivot: 2 });
    expect(clamped.fade).toBe(0);
    expect(clamped.black_lift).toBe(0);
    expect(clamped.pivot).toBe(1);
  });

  it('lookCalToAnchors ∘ anchorsToLookCal = 恒等（无钳制损失时闭环）', () => {
    const a: PipelineAnchors = { black: 0.12, white: 0.95, pivot: 0.5 };   /* fade = 0.625 ≤ 1，无钳制 */
    const cal = anchorsToLookCal(a);
    const back = lookCalToAnchors(cal.fade, cal.black_lift, cal.pivot);
    expect(back.black).toBeCloseTo(a.black, 12);
    expect(back.white).toBeCloseTo(a.white, 12);
    expect(back.pivot).toBe(a.pivot);
  });

  it('black < 0.1×fade 时 black_lift 钳 0（残差如实反映，不可逆）', () => {
    const a: PipelineAnchors = { black: 0.001, white: 0.5, pivot: 0.5 };
    const cal = anchorsToLookCal(a);   // fade = 6.25 → 钳 1；black_lift = 0.001 − 0.1 < 0 → 0
    expect(cal.fade).toBe(1);
    expect(cal.black_lift).toBe(0);
    const back = lookCalToAnchors(cal.fade, cal.black_lift, cal.pivot);
    expect(back.black).toBe(0.1);
    expect(back.black).toBeGreaterThan(a.black);   // 不可逆：黑位锚点被钳掉
  });

  it('lookTonalLandings 与 engine/look 褪色公式同式（blk = black_lift + 0.1 fade / wht = 1 − 0.08 fade）', () => {
    expect(lookTonalLandings(0.5, 0.02)).toEqual({ black: clamp01(0.02 + 0.05), white: clamp01(1 - 0.04) });
  });
});

describe('R18 锚点：对数域接线（logmath）', () => {
  it('无锚点：lookToLogLook 输出与 R18 之前逐位一致（fade 折叠、无 black_lift 字段副作用）', () => {
    const look = getPreset('fl08').params.look;
    const log = lookToLogLook(look, 'yrgb');
    expect(log).toEqual({
      contrast: 1, toe: 0, shoulder: 0, pivot: 0.5,
      crosstalk: 0.22, saturation: 0.8, warmth: 0.05,
      fade: clamp01(0.75 + 0.1), shadow_bias: 0.55, highlight_bias: 0.45,
      film_s: 0.25, gamma_contrast: 0,
      split_shadow_hue: 0, split_shadow_sat: 0, split_highlight_hue: 0, split_highlight_sat: 0, split_balance: 0,
      coupling: { rg: 0.55, rb: 0.3, gr: 0.35, gb: 0.45, br: 0.25, bg: 0.35 },
    });
    expect(log.black_lift).toBeUndefined();
    /* 褪色层黑位 = fade×0.1（black_lift 字段不参与 → 与 R18 之前同式） */
    expect(log.fade * 0.1 + (log.black_lift ?? 0)).toBe(clamp01(0.85 * 0.1));
  });

  it('有锚点：重标定后的对数域 look「褪色层落点」= 锚点（自洽，yrgb 与 rcm 各自闭环）', () => {
    /* 锚点定义的是褪色层（blk = fade×0.1 + black_lift / wht = 1 − fade×0.08）的关键点位；
     * shadow_bias/sat/warmth 是与管线无关的 look 内容，两条管线取同一组数值。 */
    for (const tf of ['yrgb', 'rcm'] as const) {
      const look = getPreset('fl05').params.look;
      const anchors = anchorsFromLook(look, tf);
      const log = lookToLogLook(look, tf, anchors);
      expect(log.fade * 0.1 + (log.black_lift ?? 0)).toBeCloseTo(anchors.black, 12);
      expect(1 - log.fade * 0.08).toBeCloseTo(anchors.white, 12);
      expect(log.pivot).toBe(anchors.pivot);
    }
  });

  it('切管线语义不漂移：同一张卡两条管线的关键点位「显示域」落点一致（经各自 TF 解码）', () => {
    for (const id of ['fl05', 'fl06']) {
      const look = getPreset(id).params.look;
      const land = lookTonalLandings(look.fade, look.black_lift);
      for (const tf of ['yrgb', 'rcm'] as const) {
        const log = lookToLogLook(look, tf, anchorsFromLook(look, tf));
        const blkLog = log.fade * 0.1 + (log.black_lift ?? 0);
        const whtLog = 1 - log.fade * 0.08;
        expect(tfDecode(tf, blkLog), `${id}/${tf} black`).toBeCloseTo(land.black, 9);
        expect(tfDecode(tf, whtLog), `${id}/${tf} white`).toBeCloseTo(land.white, 9);
      }
      /* 对照：无锚点时 yrgb 的显示域黑位会漂移（这正是锚点要修的偏差） */
      const logNoAnchor = lookToLogLook(look, 'yrgb');
      const driftedBlack = tfDecode('yrgb', logNoAnchor.fade * 0.1);
      if (land.black > 0) expect(driftedBlack).not.toBeCloseTo(land.black, 3);
    }
  });

  it('anchorsFromLook = 推导公式（显示落点经 TF 编码，pivot = 管线枢轴）', () => {
    const look = { ...defaultParams().look, fade: 0.25, black_lift: 0.06 };
    const a = anchorsFromLook(look, 'yrgb');
    expect(a.black).toBeCloseTo(tfEncode('yrgb', 0.06 + 0.1 * 0.25), 12);
    expect(a.white).toBeCloseTo(tfEncode('yrgb', 1 - 0.08 * 0.25), 12);
    expect(a.pivot).toBe(0.5);
    const r = anchorsFromLook(look, 'rcm');
    expect(r.black).toBeCloseTo(0.06 + 0.1 * 0.25, 12);   // rcm TF = 恒等
    expect(r.pivot).toBe(0.333);
  });

  it('anchorsForPipeline：按管线取键；无锚点 → undefined（行为不变）', () => {
    const a: CardAnchorsT = { yrgb: { black: 0.1, white: 1, pivot: 0.5 } };
    expect(anchorsForPipeline(a, 'yrgb')).toEqual({ black: 0.1, white: 1, pivot: 0.5 });
    expect(anchorsForPipeline(a, 'rcm')).toBeUndefined();
    expect(anchorsForPipeline(undefined, 'yrgb')).toBeUndefined();
  });
});

describe('R18 锚点：内置卡示例值（fl05 / fl06）', () => {
  it('卡锚点 = anchorsFromLook 推导值（存储值按 1e-7 取整；其余卡不带 anchors）', () => {
    const fl05 = getPreset('fl05');
    const fl06 = getPreset('fl06');
    /* 逐值核对（推导式：D = black_lift + 0.1×fade、W = 1 − 0.08×fade） */
    for (const [card, d] of [[fl05, 0.02], [fl06, 0.004]] as const) {
      expect(card.anchors).toBeDefined();
      expect(card.anchors!.yrgb!.black).toBeCloseTo(tfEncode('yrgb', d), 6);
      expect(card.anchors!.yrgb!.white).toBe(1);
      expect(card.anchors!.yrgb!.pivot).toBe(0.5);
      expect(card.anchors!.rcm!.black).toBe(d);
      expect(card.anchors!.rcm!.white).toBe(1);
      expect(card.anchors!.rcm!.pivot).toBe(0.333);
    }
    /* 其余卡不带（行为不变护栏） */
    for (const id of ['neutral', 'fl01', 'fl02', 'fl03', 'fl04', 'fl07', 'fl08', 'fl09', 'fl10', 'st01', 'st02', 'st03', 'st04', 'st05', 'st06']) {
      expect(getPreset(id).anchors, id).toBeUndefined();
    }
  });

  it('recipe 层：锚点容错读回（合法保留 / 非法置 undefined）', async () => {
    const { parseRecipe, serializeRecipe } = await import('../ui/storage');
    const { recipeToState } = await import('../ui/recipe');
    const base = JSON.parse(serializeRecipe({
      schema_version: 1.3, id: 'fm_x', share_code: 'FM-XXXX', name: 't',
      meta: { created_at: '', author: 'local', source: { type: 'library', ref_image_id: null, stock_id: null } },
      color: { engine: 'colormatch-v1', params: {}, look: {}, lut_size: 65 },
      texture: {},
      anchors: { yrgb: { black: 0.01, white: 0.99, pivot: 0.5 }, rcm: { black: 0.01, white: 0.99, pivot: 0.333 } },
    } as never));
    const st = recipeToState(parseRecipe(serializeRecipe(base)) as never);
    expect(st.anchors?.yrgb).toEqual({ black: 0.01, white: 0.99, pivot: 0.5 });
    expect(st.anchors?.rcm?.pivot).toBe(0.333);
    const bad = { ...base, anchors: { yrgb: { black: 2, white: 0.9, pivot: 0.5 } } };
    expect(() => parseRecipe(serializeRecipe(bad as never))).toThrow(/anchors\.yrgb\.black/);
    delete base.anchors;
    const none = recipeToState(parseRecipe(serializeRecipe(base)) as never);
    expect(none.anchors).toBeUndefined();
  });
});
