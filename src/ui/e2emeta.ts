/**
 * E2E 验收钩子：把运行时状态写入页面内 #e2e-meta（--dump-dom 可捕获），
 * 供 tools/e2e-verify.mjs 与截图像素断言配合使用。不影响正常使用（hidden）。
 */
export function setMeta(patch: Record<string, unknown>): void {
  const w = globalThis as { __fmE2E?: Record<string, unknown> };
  w.__fmE2E = { ...(w.__fmE2E ?? {}), ...patch };
  /* node 环境（纯逻辑单测）无 DOM：只写全局，不写页面元素 */
  if (typeof document === 'undefined') return;
  const el = document.getElementById('e2e-meta');
  if (el) el.textContent = JSON.stringify(w.__fmE2E);
}

export function getMeta(): Record<string, unknown> {
  return (globalThis as { __fmE2E?: Record<string, unknown> }).__fmE2E ?? {};
}
