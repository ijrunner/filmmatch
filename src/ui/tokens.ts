/**
 * R11 设计令牌（**单一来源**）：颜色 / 字号 / 间距 / 圆角 / 阴影 / 动效。
 *
 * 规则：`index.html` 与 `ui/*.ts` 里的样式**只引用 `var(--…)`**，不再出现 `#100e0b`、
 * `rgba(232,163,61,.12)`、`11px` 这类魔数；`:root` 变量由本模块在运行时注入（唯一定义处）。
 * `tokens.test.ts` 扫描上述文件，发现硬编码色值/字号即失败。
 */
export const TOKENS = {
  color: {
    bg: '#141210', panel: '#1d1a15', panel2: '#242019', line: '#373023',
    text: '#d8d0c2', dim: '#8a7f6d', amber: '#e8a33d', amber2: '#f5c069',
    ok: '#67c26a', est: '#5b9dd9', ann: '#e8a33d', err: '#e06c5a',
    onAmber: '#141210', white: '#ffffff', canvas: '#000000', hole: '#2a251d',
    codeBg: '#100e0b', codeFg: '#b9ae99',
    overlay: 'rgba(20,18,16,.75)', overlay2: 'rgba(20,18,16,.92)', overlaySoft: 'rgba(20,18,16,.85)',
    amberA06: 'rgba(232,163,61,.06)', amberA08: 'rgba(232,163,61,.08)', amberA12: 'rgba(232,163,61,.12)',
    okA06: 'rgba(103,194,106,.06)',
  },
  font: {
    fsXs: '10px', fsSm: '11px', fsMd: '12px', fsBase: '13px', fsLg: '14px', fsXl: '15px',
    fsXxl: '16px', fs2xl: '18px',
    fontSans: '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif',
    fontMono: 'ui-monospace,Menlo,Consolas,monospace',
  },
  space: { sp1: '2px', sp2: '4px', sp3: '6px', sp4: '8px', sp5: '10px', sp6: '12px', sp7: '14px' },
  radius: { rSm: '3px', rMd: '4px', rLg: '5px', rXl: '6px', rPill: '12px' },
  shadow: { shStrip: '0 4px 24px rgba(0,0,0,.5)', shDrawer: '-10px 0 26px rgba(0,0,0,.55)' },
  motion: { durFast: '0.15s', durNorm: '0.16s', ease: 'ease' },
} as const;

type Dict = Record<string, string>;
/** camelCase → `--kebab-case:值` 声明串（从 TOKENS 派生，保证单一来源） */
function decls(o: Dict): string {
  return Object.entries(o).map(([k, v]) => `--${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${v}`).join(';');
}

/** `:root{…}` 全部 CSS 变量的唯一定义（由 installTokens 注入 <head>） */
export const TOKENS_CSS: string = ':root{' + [
  decls({ ...TOKENS.color }), decls({ ...TOKENS.font }), decls({ ...TOKENS.space }),
  decls({ ...TOKENS.radius }), decls({ ...TOKENS.shadow }), decls({ ...TOKENS.motion }),
].join(';') + '}';

/** 注入令牌样式（幂等）。main.ts 启动即调用，早于任何 DOM 装配。 */
export function installTokens(doc: Document = document): void {
  if (doc.getElementById('fm-tokens')) return;
  const s = doc.createElement('style');
  s.id = 'fm-tokens';
  s.textContent = TOKENS_CSS;
  doc.head.appendChild(s);
}
