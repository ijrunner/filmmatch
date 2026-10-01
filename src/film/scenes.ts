/* FilmMatch 效果层 · 内置程序化测试帧（无网络依赖，从 spike④ 移植绘制代码）
 * neon 霓虹夜景：白字高亮（halation/bloom 触发）、彩色灯管（最大通道触发）、路灯人物（肤色可读性）
 * dusk 黄昏逆光：白核太阳（柔光展示）、云/海面/剪影
 * chart 校色卡：24 色块 + 17 级灰阶 + 肤色条 + 饱和条 + 四角白块（色散检查）
 *   并为效果验收增加：孤立亮块测试条（255/200/128 灰，供 H3/H4 晕宽度与染色测量）
 *   与大块纯黑隔离区（供 H5/B1 暗部增益直方图测量）。坐标常量见 CHART_LAYOUT。
 */

export function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rrect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

export function drawNeon(c: CanvasRenderingContext2D, W: number, H: number): void {
  let g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#04060c'); g.addColorStop(0.55, '#0a0d17'); g.addColorStop(1, '#0d0f16');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  const rnd = mulberry32(7);
  for (let i = 0; i < 14; i++) {
    const bw = 90 + rnd() * 170, bh = H * (0.28 + rnd() * 0.38), bx = i * (W / 14) - 24 + rnd() * 36, by = H * 0.62 - bh;
    c.fillStyle = `rgb(${13 + (rnd() * 10 | 0)},${15 + (rnd() * 10 | 0)},${21 + (rnd() * 12 | 0)})`;
    c.fillRect(bx, by, bw, bh + 60);
    for (let wy = by + 18; wy < H * 0.6 - 24; wy += 27) for (let wx = bx + 10; wx < bx + bw - 16; wx += 23)
      if (rnd() < 0.26) {
        c.fillStyle = rnd() < 0.85 ? `rgba(255,214,150,${0.22 + rnd() * 0.5})` : 'rgba(160,200,255,0.35)';
        c.fillRect(wx, wy, 8, 12);
      }
  }
  g = c.createLinearGradient(0, H * 0.62, 0, H);
  g.addColorStop(0, '#0f1118'); g.addColorStop(1, '#1b1e28');
  c.fillStyle = g; c.fillRect(0, H * 0.62, W, H * 0.38);
  // 霓虹招牌（白字高亮 → halation 触发；彩色灯管由最大通道触发）
  const signs: [number, number, number, number, string, string][] = [
    [W * 0.16, H * 0.30, 170, 58, '#ff2d6b', 'NIGHT'], [W * 0.40, H * 0.20, 200, 62, '#18d7db', 'GLOW'],
    [W * 0.63, H * 0.33, 120, 52, '#ffb020', 'BAR'], [W * 0.82, H * 0.25, 150, 50, '#9d6bff', 'OPEN'],
  ];
  for (const [x, y, w, h, col, txt] of signs) {
    // 湿路反射：短、窄、快衰减
    const rw = w * 0.72, rx = x + w * 0.14;
    const rg = c.createLinearGradient(0, H * 0.63, 0, H * 0.63 + H * 0.20);
    rg.addColorStop(0, col + '4d'); rg.addColorStop(0.45, col + '17'); rg.addColorStop(1, col + '00');
    c.fillStyle = rg; c.fillRect(rx, H * 0.63, rw, H * 0.20);
    c.save();
    c.shadowColor = col; c.shadowBlur = 44; c.fillStyle = col;
    rrect(c, x, y, w, h, 10); c.fill();
    c.shadowBlur = 14; c.shadowColor = '#ffffff'; c.fillStyle = 'rgba(255,252,245,0.97)';
    c.font = `700 ${h * 0.46 | 0}px sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(txt, x + w / 2, y + h / 2 + 2);
    c.restore();
  }
  // 路灯 + 灯下人物（暖肤色块，供 G6 肤色可读性检查）
  c.save();
  const lx = W * 0.53;
  c.fillStyle = '#05070a'; c.fillRect(lx - 4, H * 0.5, 8, H * 0.13);
  const lg = c.createRadialGradient(lx, H * 0.5, 2, lx, H * 0.5, 90);
  lg.addColorStop(0, 'rgba(255,240,210,1)'); lg.addColorStop(0.25, 'rgba(255,220,160,0.5)'); lg.addColorStop(1, 'rgba(255,200,120,0)');
  c.fillStyle = lg; c.beginPath(); c.arc(lx, H * 0.5, 90, 0, 7); c.fill();
  c.fillStyle = '#ffefcc'; c.beginPath(); c.arc(lx, H * 0.5, 7, 0, 7); c.fill();
  c.fillStyle = '#0c0b0a';
  c.beginPath(); c.arc(lx, H * 0.585, 17, 0, 7); c.fill();
  c.fillRect(lx - 19, H * 0.60, 38, H * 0.09);
  const fg = c.createRadialGradient(lx - 10, H * 0.575, 2, lx - 10, H * 0.575, 26);
  fg.addColorStop(0, 'rgba(232,176,138,0.55)'); fg.addColorStop(1, 'rgba(232,176,138,0)');
  c.fillStyle = fg; c.beginPath(); c.arc(lx - 10, H * 0.578, 26, 0, 7); c.fill();
  c.restore();
  // 远处车灯
  for (const [tx, ty] of [[W * 0.3, H * 0.66], [W * 0.72, H * 0.68]]) {
    const tg = c.createRadialGradient(tx, ty, 1, tx, ty, 26);
    tg.addColorStop(0, 'rgba(255,255,255,0.95)'); tg.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = tg; c.beginPath(); c.arc(tx, ty, 26, 0, 7); c.fill();
  }
}

export function drawDusk(c: CanvasRenderingContext2D, W: number, H: number): void {
  let g = c.createLinearGradient(0, 0, 0, H * 0.72);
  g.addColorStop(0, '#1e2a4d'); g.addColorStop(0.4, '#5d4358'); g.addColorStop(0.68, '#b85f2a');
  g.addColorStop(0.9, '#f2a35e'); g.addColorStop(1, '#ffd9a0');
  c.fillStyle = g; c.fillRect(0, 0, W, H * 0.72);
  // 太阳（白核 → bloom/halation 触发）
  const sx = W * 0.60, sy = H * 0.64;
  let sg = c.createRadialGradient(sx, sy, 4, sx, sy, 300);
  sg.addColorStop(0, 'rgba(255,244,214,0.9)'); sg.addColorStop(0.18, 'rgba(255,190,110,0.45)'); sg.addColorStop(1, 'rgba(255,150,80,0)');
  c.fillStyle = sg; c.beginPath(); c.arc(sx, sy, 300, 0, 7); c.fill();
  sg = c.createRadialGradient(sx, sy, 2, sx, sy, 42);
  sg.addColorStop(0, '#fffdf2'); sg.addColorStop(0.8, '#ffe9b0'); sg.addColorStop(1, 'rgba(255,220,150,0.4)');
  c.fillStyle = sg; c.beginPath(); c.arc(sx, sy, 42, 0, 7); c.fill();
  // 云（软边）
  const rnd = mulberry32(3);
  for (let i = 0; i < 7; i++) {
    const cx = rnd() * W, cy = H * (0.08 + rnd() * 0.45), cw = W * (0.10 + rnd() * 0.22), ch = 8 + rnd() * 14;
    const a = 0.28 + rnd() * 0.28;
    c.save(); c.translate(cx, cy); c.scale(cw / 64, ch / 64);
    const cg = c.createRadialGradient(0, 0, 0, 0, 0, 64);
    cg.addColorStop(0, `rgba(44,36,56,${a})`); cg.addColorStop(0.6, `rgba(44,36,56,${a * 0.55})`); cg.addColorStop(1, 'rgba(44,36,56,0)');
    c.fillStyle = cg; c.fillRect(-64, -64, 128, 128);
    c.restore();
  }
  // 海面 + 日光带
  g = c.createLinearGradient(0, H * 0.72, 0, H);
  g.addColorStop(0, '#4a3238'); g.addColorStop(0.3, '#2a2028'); g.addColorStop(1, '#141118');
  c.fillStyle = g; c.fillRect(0, H * 0.72, W, H * 0.28);
  for (let i = 0; i < 260; i++) {
    const yy = H * 0.72 + rnd() * H * 0.28, sp = (rnd() * 2 - 1) * (yy - H * 0.72) * 0.9;
    c.fillStyle = `rgba(255,${170 + (rnd() * 60 | 0)},110,${0.05 + rnd() * 0.3})`;
    c.fillRect(sx + sp - rnd() * 26, yy, 8 + rnd() * 40, 1.4);
  }
  // 码头与人物剪影
  c.fillStyle = '#0a0908';
  c.fillRect(0, H * 0.80, W * 0.42, 10);
  for (let i = 0; i < 9; i++) c.fillRect(W * 0.04 + i * W * 0.045, H * 0.80, 8, H * 0.2);
  c.beginPath(); c.arc(W * 0.2, H * 0.755, 13, 0, 7); c.fill();
  c.fillRect(W * 0.2 - 15, H * 0.772, 30, H * 0.075);
  // 飞鸟
  c.strokeStyle = 'rgba(15,12,14,0.85)'; c.lineWidth = 2.4;
  for (const [bx, by, s] of [[W * 0.42, H * 0.3, 1], [W * 0.47, H * 0.26, 0.7], [W * 0.38, H * 0.24, 0.55]]) {
    c.beginPath(); c.moveTo(bx - 10 * s, by);
    c.quadraticCurveTo(bx - 4 * s, by - 7 * s, bx, by);
    c.quadraticCurveTo(bx + 4 * s, by - 7 * s, bx + 10 * s, by);
    c.stroke();
  }
}

const CC_COLORS = ['#735244', '#c29682', '#627a9d', '#576c43', '#8580b1', '#67bdaa',
  '#d67e2c', '#505ba6', '#c15a63', '#5e3c6c', '#9dbc40', '#e0a32e',
  '#383d96', '#469449', '#af363c', '#e7c71f', '#bb5695', '#0885a1',
  '#f3f3f2', '#c8c8c8', '#a0a0a0', '#7a7a7a', '#555555', '#343434'];

/* 校色卡关键区域坐标（1920×1080，截图分析用）。
 * 注意：不画贯穿式中心细线——白线会污染灰阶方差/黑位测量（bloom+halation 沿线发光）。 */
export const CHART_LAYOUT = {
  ramp: { x: 40, y: 526, n: 17, pw: 57, ph: 54 },            // 17 级灰阶（0→255）
  strip: { bg: { x: 60, y: 760, w: 820, h: 280 },            // 黑底测试条（H3/H4），块间隙 160px 防相邻晕铺底
    blocks: [{ x: 100, y: 800, s: 140, v: 255 }, { x: 400, y: 800, s: 140, v: 200 }, { x: 700, y: 800, s: 140, v: 128 }] },
  black: { x: 940, y: 760, w: 520, h: 280 },                 // 纯黑隔离区（H5/B1），距一切亮块/发光源 ≥60px
  cornerTL: { x: 26, y: 26, s: 24 },                         // 四角白块（V1/V2）
  cornerTR: { x: 1894, y: 26, s: 24 },
  center: { x: 960, y: 540 },                                // 中心（V1 不受暗角影响对照）
};

/* 过曝测试帧（R1 新增，供 v1.1 参数验收的数值测量）：
 * - 上半亮背景（#b4b4b4，luma≈0.71）+ 白块 → background_gain（亮背景上的光晕压制）测量；
 * - 中部黑背景 + 白块 → impact（叠加不透明度）测量；
 * - 下部中灰背景（#6e6e6e，luma≈0.43）+ 白块 → amplify（晕形再分配）测量：
 *   中灰既不会被亮通触发（阈值 0.5），又让块缘外的晕高于「暗部保护」门限（3.5%），
 *   因此晕形/铺展可在近中场被真实测量（纯黑背景上远场晕会被暗部保护压掉）；
 * - 右侧「纯白条 + 紧邻近白条（246）」→ save_lights（高光防溢出）测量：
 *   白条的 bloom 会溢入近白条并把它推过 254，开启高光保护后溢出像素应大幅减少。 */
export const BLOWN_LAYOUT = {
  brightBg: { y0: 0, y1: 520, v: 180 },                      // 亮背景（180/255 → luma≈0.706）
  darkBg: { y0: 520, y1: 880, v: 10 },                       // 黑背景
  midGrayBg: { y0: 880, y1: 1080, v: 110 },                  // 中灰背景（luma≈0.43，晕形探测）
  haloOnBright: { x: 300, y: 170, s: 150 },                  // 亮背景上的白块（255）
  haloOnBrightProbe: { x0: 458, y0: 190, x1: 578, y1: 300 }, // 块右缘外 8..128px：光晕能量探测区
  haloOnDark: { x: 300, y: 700, s: 150 },                    // 黑背景上的白块（不透明度探测）
  haloOnMid: { x: 300, y: 920, s: 150 },                     // 中灰背景上的白块（晕形探测）
  haloOnMidProbe: { x0: 452, y0: 930, x1: 858, y1: 1050 },   // 块右缘外 2..408px
  white: { x: 860, y: 560, w: 1000, h: 120, v: 255 },        // 过曝源（纯白条）
  near: { x: 860, y: 680, w: 1000, h: 120, v: 246 },         // 近白条（溢出测量区）
};

export function drawBlown(c: CanvasRenderingContext2D, W: number, H: number): void {
  const L = BLOWN_LAYOUT;
  c.fillStyle = `rgb(${L.brightBg.v},${L.brightBg.v},${L.brightBg.v})`;
  c.fillRect(0, L.brightBg.y0, W, L.brightBg.y1 - L.brightBg.y0);
  c.fillStyle = `rgb(${L.darkBg.v},${L.darkBg.v},${L.darkBg.v})`;
  c.fillRect(0, L.darkBg.y0, W, L.darkBg.y1 - L.darkBg.y0);
  c.fillStyle = `rgb(${L.midGrayBg.v},${L.midGrayBg.v},${L.midGrayBg.v})`;
  c.fillRect(0, L.midGrayBg.y0, W, H - L.midGrayBg.y0);
  c.fillStyle = '#fff';
  c.fillRect(L.haloOnBright.x, L.haloOnBright.y, L.haloOnBright.s, L.haloOnBright.s);
  c.fillRect(L.haloOnDark.x, L.haloOnDark.y, L.haloOnDark.s, L.haloOnDark.s);
  c.fillRect(L.haloOnMid.x, L.haloOnMid.y, L.haloOnMid.s, L.haloOnMid.s);
  c.fillRect(L.white.x, L.white.y, L.white.w, L.white.h);
  c.fillStyle = `rgb(${L.near.v},${L.near.v},${L.near.v})`;
  c.fillRect(L.near.x, L.near.y, L.near.w, L.near.h);
}


export function drawChart(c: CanvasRenderingContext2D, W: number, H: number): void {
  c.fillStyle = '#6a6a6a'; c.fillRect(0, 0, W, H);
  const pw = 150, ph = 100, gx = 40, gy = 50;
  CC_COLORS.forEach((col, i) => {
    c.fillStyle = col;
    c.fillRect(gx + (i % 6) * (pw + 14), gy + ((i / 6) | 0) * (ph + 14), pw, ph);
  });
  // 灰阶 17 级
  const rw = (pw * 6 + 70) / 17;
  for (let i = 0; i < 17; i++) {
    const v = Math.round(255 * i / 16);
    c.fillStyle = `rgb(${v},${v},${v})`;
    c.fillRect(gx + i * rw, CHART_LAYOUT.ramp.y, rw - 2, 54);
  }
  // 肤色参考
  ['#f0c8a0', '#c8956c', '#8d5a3c'].forEach((col, i) => {
    c.fillStyle = col; c.fillRect(gx + pw * 6 + 70 + 30 + i * 120, gy + 20, 110, 180);
  });
  // 饱和色条
  const sat = ['#ff0000', '#00ff00', '#0000ff', '#ff00ff', '#ffff00', '#00ffff'];
  sat.forEach((col, i) => {
    c.fillStyle = col; c.fillRect(gx + i * (pw + 14), gy + 4 * (ph + 14) + 110, pw, 60);
    c.globalAlpha = 0.5; c.fillRect(gx + i * (pw + 14), gy + 4 * (ph + 14) + 178, pw, 60); c.globalAlpha = 1;
  });
  // 黑底亮块测试条（H3 晕宽度 / H4 染色：255 白 与 200/128 灰互相隔离 ≥80px）
  const S = CHART_LAYOUT.strip;
  c.fillStyle = '#000'; c.fillRect(S.bg.x, S.bg.y, S.bg.w, S.bg.h);
  for (const b of S.blocks) {
    const v = b.v;
    c.fillStyle = `rgb(${v},${v},${v})`;
    c.fillRect(b.x, b.y, b.s, b.s);
  }
  // 纯黑隔离区（H5/B1：暗部增益测量，距一切亮块 ≥160px）
  c.fillStyle = '#000'; c.fillRect(CHART_LAYOUT.black.x, CHART_LAYOUT.black.y, CHART_LAYOUT.black.w, CHART_LAYOUT.black.h);
  // 四角白块（色散/暗角检查位）
  c.fillStyle = '#fff';
  for (const [cx, cy] of [[26, 26], [W - 26, 26], [26, H - 26], [W - 26, H - 26]]) c.fillRect(cx - 12, cy - 12, 24, 24);
  // 锐度圆
  c.strokeStyle = '#fff'; c.lineWidth = 2;
  c.beginPath(); c.arc(W * 0.855, H * 0.78, 80, 0, 7); c.stroke();
  c.fillStyle = '#111'; c.font = '16px sans-serif';
  c.fillText('FilmMatch test chart · Rec.709 · gamma space', gx, gy - 16);
}
