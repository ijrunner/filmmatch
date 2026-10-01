/* 单文件工作台构建配置 —— 供 tools/make-local-kit.mjs 打出「双击即用」的本地验收包。
 *
 * 为什么需要：主配置是 index + effects 双入口且批量页/DCTL 页是动态 import，
 * 产物是多 chunk；file:// 下模块脚本会被 CORS 拦截。
 * 单入口 + inlineDynamicImports 把所有视图打进一个 chunk，内联后 file:// 可直接双击打开。
 * publicDir:false —— 绝不把 public/（含第三方测试剧照）打进发布物。
 */
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  publicDir: false,
  build: {
    target: 'es2022',
    outDir: 'dist-standalone',
    emptyOutDir: true,
    rollupOptions: {
      input: { index: 'index.html' },
      output: { inlineDynamicImports: true },
    },
  },
});
