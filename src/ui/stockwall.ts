/**
 * F12 型号卡片墙缩略图：用该型号的 look+texture 实时渲染同一示例帧（程序化夜景），
 * 运行时生成 JPEG dataURL。结果按 型号|场景 缓存——同帧同参输出确定，
 * 肉眼可辨型号间差异由预设卡本身保证。
 * R2：型号卡扩到 10 张（STOCK_IDS 顺序），本模块按 id 逐张渲染、结果缓存，无数量假设。
 * R20 后记：渲染器改为模块级单例（见 renderThumbDataURL 注释）。
 */
import { EffectRenderer } from '../film/pipeline';
import { drawNeon, drawDusk, drawChart } from '../film/scenes';
import { getPreset } from '../film/params';
import type { LookParams, TextureParams } from '../film/params';
import type { SceneId } from './library';

const THUMB_W = 384;
const THUMB_H = 216;

const cache = new Map<string, string>();

/** 绘制缩略源帧（与工作台示例帧同源，无网络依赖） */
function drawScene(scene: SceneId, c: CanvasRenderingContext2D, w: number, h: number): void {
  if (scene === 'neon') drawNeon(c, w, h);
  else if (scene === 'dusk') drawDusk(c, w, h);
  else drawChart(c, w, h);
}

/**
 * 渲染型号缩略图（同步）。scene 默认夜景：灯牌高光能同时暴露光晕/对比/褪色/颗粒差异。
 * 无法渲染（无 2D 上下文等）返回空串，调用方回退占位。
 *
 * R20 后记：缩略图曾每张临时建/毁一个 GL 上下文，卡墙扩到 14 张后在 SwiftShader
 * （及低端环境）会把主画布的 GL 上下文挤掉 → 预览白屏。改为**模块级单例渲染器**
 * （全站共用 1 个 GL 上下文，setSource 逐张换源——与主管线逐帧复用同一设计）。
 */
let sharedRenderer: EffectRenderer | null = null;
let sharedOut: HTMLCanvasElement | null = null;
export function renderThumbDataURL(
  src: HTMLCanvasElement, look: LookParams, texture: TextureParams, quality = 0.85,
): string {
  if (!sharedRenderer || !sharedOut) {
    sharedOut = document.createElement('canvas');
    sharedOut.width = THUMB_W;
    sharedOut.height = THUMB_H;
    sharedRenderer = new EffectRenderer();
    sharedRenderer.init(sharedOut);
  }
  sharedRenderer.setSource(src);
  sharedRenderer.apply({ texture, look, master: 1 }, { master: 1, mode: 0 });
  sharedRenderer.render(0.5); // 固定相位：同参数输出确定
  return sharedOut.toDataURL('image/jpeg', quality);
}

export function stockThumbUrl(presetId: string, scene: SceneId = 'neon'): string {
  const key = presetId + '|' + scene;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  try {
    // 源帧画在临时 2D 画布（GL 画布不能再拿 2D 上下文）
    const src = document.createElement('canvas');
    src.width = THUMB_W;
    src.height = THUMB_H;
    drawScene(scene, src.getContext('2d')!, THUMB_W, THUMB_H);
    const card = getPreset(presetId);
    const url = renderThumbDataURL(src, card.params.look, card.params.texture);
    cache.set(key, url);
    return url;
  } catch {
    cache.set(key, '');
    return '';
  }
}
