/**
 * F13 图文搭建指南 · 工作台抽屉版。
 * 内容与 docs/guides/达芬奇质感搭建指南.md 同源（精简版）；文本内嵌打包，
 * 避免运行时 fetch md（file:// 与离线场景都能用）。改文档时同步此处。
 */
import { setMeta } from './e2emeta';
import { drxMarkdownForGuide } from './drxexport';
import * as storage from './storage';

export interface GuideSection {
  t: string;
  html: string;
}

/** 精简版（完整展开版见 docs/guides/达芬奇质感搭建指南.md） */
export const GUIDE_SECTIONS: GuideSection[] = [
  { t: '① 挂 LUT（色彩层，1 分钟）', html:
    '1. 工作台⑤导出 .cube → 拷入 LUT 目录（菜单 Color → Open LUT Folder 可直达；' +
    'Windows：<code>C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\LUT</code>，' +
    'macOS：<code>/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT</code>）。' +
    '<br>2. 重启达芬奇 → Color 页选中节点 → 右键 → <b>LUT</b> → 选 <code>FM-XXXX.cube</code>。' +
    '<br>3. 时间线色彩空间保持 Rec.709 / Gamma 2.4，否则发灰。' },
  { t: '② 节点树总览', html:
    '<code>源 → B1 挂LUT → B2 光晕 → B3 柔光 → B4 暗角 → B5 颗粒(Fusion) → 输出</code><br>' +
    '色彩全在 LUT 里；B2–B5 用免费版可用的 亮通+高斯模糊+Screen、Power Window、FastNoise 实现。' },
  { t: '③ 光晕（B2）', html:
    '1. 曲线页勾选 <b>Soft Clip</b>：高光裁剪点 = 阈值×100（0.55→55），暗端压死（只留亮部）。' +
    '<br>2. Blur 页 <b>Gaussian Blur</b>：半径按表换算（1 %H = 画面高度×1%）。' +
    '<br>3. Key 页 <b>Composite mode = Screen</b>；<b>Key Output Gain ≈ 0.75×强度</b>（0.42→31%）。' +
    '<br>4. 染色：Gain 通道 R +20% / B −15%（等效橙红 tint）。' },
  { t: '④ 柔光（B3）', html:
    '与光晕同结构：阈值 85、半径更大（默认 2 %H）、Gain 更低（≈0.25×强度）。高光「化开」即可，别调成第二层光晕。' },
  { t: '⑤ 暗角（B4）', html:
    'Window 面板选<b>圆形窗口 → 勾 Inverse（外部）</b>，Softness 60–75，外部 Gamma ≈ −(暗角强度)。' +
    '目标：四角比中心暗约 强度×100%，中心不动。边缘色散免费版无等效（量级很小，可忽略）。' },
  { t: '⑥ 颗粒（B5 / Fusion）', html:
    '免费版无 Film Grain 类 ResolveFX，用 Fusion：<code>FastNoise → Merge(Soft Light)</code>。' +
    'Detail 降低成絮块、<b>Seethe Rate 0.4–0.8</b> 让颗粒「活着」；' +
    '<b>Blend ≈ 14% × √(ISO/400)</b>（ISO1600→28%）。颗粒间距 1:1 目检对齐（1 ‰H ≈ 1080p 1.1px）。' },
  { t: '⑦ 参数对照表', html:
    '<table class="gtab">' +
    '<tr><th>工作台参数</th><th>达芬奇位置</th><th>1080p</th><th>2160p</th></tr>' +
    '<tr><td>光晕半径 %H</td><td>B2 Gaussian Blur</td><td>13–30px</td><td>26–60px</td></tr>' +
    '<tr><td>光晕强度 0.42</td><td>Key Output Gain</td><td colspan="2">≈31%（与分辨率无关）</td></tr>' +
    '<tr><td>阈值 0.55–0.85</td><td>Soft Clip 裁剪点</td><td colspan="2">55–85</td></tr>' +
    '<tr><td>暗角 0.18–0.30</td><td>窗口外部 Gamma</td><td colspan="2">−0.18 ~ −0.30</td></tr>' +
    '<tr><td>颗粒 ISO</td><td>Merge Blend</td><td colspan="2">14%×√(ISO/400)</td></tr>' +
    '<tr><td>颗粒尺寸 ‰H</td><td>FastNoise Detail</td><td>1.1–1.7px</td><td>2.2–3.5px</td></tr>' +
    '</table>' +
    '<div class="note">Blur Radius 滑杆是内部归一值：按像素换算定数量级，再 1:1 目检微调。</div>' },
  { t: '⑧ 一键生成你的配方的搭建清单', html:
    '把当前工作台配方（look + 质感）翻译成<b>可复制照做</b>的达芬奇节点搭建清单：点下面按钮生成 Markdown，' +
    '全选复制后在达芬奇 Color 页按顺序建节点、填参数，再 Grab Still 存为 PowerGrade。<br>' +
    '清单含每个节点的参数值与 <b>1080p / 2160p 像素换算</b>；.drx 为实验性模板（未在达芬奇实测），请以清单为准。<br>' +
    '<div class="row" style="margin:6px 0">' +
    '<button id="guide-drx-gen" class="primary" type="button">生成当前配方的搭建清单</button>' +
    '<button id="guide-drx-dl" class="mini" type="button">下载 .md</button>' +
    '</div>' +
    '<textarea id="guide-drx-md" readonly spellcheck="false" ' +
    'style="width:100%;height:150px;background:var(--code-bg);color:var(--code-fg);border:1px solid var(--line);' +
    'border-radius:4px;font:var(--fs-sm)/1.5 var(--font-mono);padding:6px 8px;resize:vertical;white-space:pre"></textarea>' +
    '<div class="note" id="guide-drx-note">点按钮生成当前配方的搭建清单。</div>' },
  { t: '⑨ 常见问题', html:
    '<b>LUT 找不到</b>：目录不对/没重启（注意 ProgramData 隐藏目录）。' +
    '<br><b>发灰/偏色</b>：时间线不是 Rec.709 / Gamma 2.4。' +
    '<br><b>光晕抬灰</b>：Soft Clip 暗端没压死或阈值过低。' +
    '<br><b>颗粒像雪花</b>：Detail/Seethe 太高，Blend 别超 30%。' +
    '<br><b>4K 观感不同</b>：半径没按画面高度换算（用 2160p 列）。' +
    '<br><b>.drx 导入</b>：暂不支持（达芬奇私有格式，需 spike① 实测），质感层请按本指南手工搭建。' },
];

let built = false;
const drawer = (): HTMLElement => document.getElementById('guide-drawer')!;

/** 把当前配方（无则 fl06 示例）的搭建清单注入抽屉 textarea；无配方时给提示 */
function fillGuideDrx(): void {
  const ta = document.getElementById('guide-drx-md') as HTMLTextAreaElement | null;
  const note = document.getElementById('guide-drx-note');
  const info = drxMarkdownForGuide();
  if (ta) {
    ta.value = info.markdown;
    ta.textContent = info.markdown; // dump-dom 序列化默认值（子文本）
  }
  if (note) {
    note.textContent = info.hasRecipe
      ? `已生成当前配方「${info.name}」的搭建清单：${info.nodes} 个节点 · ${info.conversions} 项 1080p/2160p 换算。复制后在达芬奇按顺序建节点即可。`
      : `工作台尚未选定配方，当前为默认示例「${info.name}」；选定型号/参考后再点本按钮生成你自己的清单。`;
  }
}

function build(): void {
  if (built) return;
  built = true;
  const d = drawer();
  d.innerHTML =
    '<div class="drawer-head"><span class="logo">达芬奇质感搭建指南</span>' +
    '<span class="sub">免费版可用 · 精简版（完整版见 docs/guides/）</span>' +
    '<button id="btn-guide-close" class="mini" title="关闭">✕</button></div>' +
    GUIDE_SECTIONS.map((s, i) =>
      '<details class="group"' + (i < 2 ? ' open' : '') + '><summary><span class="arrow">▶</span>' +
      s.t + '</summary><div class="body gbody">' + s.html + '</div></details>').join('');
  d.querySelector('#btn-guide-close')!.addEventListener('click', closeGuide);
  d.querySelector('#guide-drx-gen')?.addEventListener('click', fillGuideDrx);
  d.querySelector('#guide-drx-dl')?.addEventListener('click', () => {
    const info = drxMarkdownForGuide();
    storage.exportFile('FilmMatch-搭建清单.md', info.markdown, 'text/markdown');
  });
  fillGuideDrx();
}

export function openGuide(): void {
  build();
  drawer().classList.add('open');
  setMeta({ guideOpen: true });
}
export function closeGuide(): void {
  drawer().classList.remove('open');
  setMeta({ guideOpen: false });
}
export function toggleGuide(): void {
  if (drawer().classList.contains('open')) closeGuide();
  else openGuide();
}
export function isGuideOpen(): boolean {
  return drawer().classList.contains('open');
}
