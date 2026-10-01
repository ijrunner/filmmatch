import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        index: 'index.html',     // MVP 工作台（相对 config root 解析）
        effects: 'effects.html', // 效果层开发预览（保留可用）
      },
    },
  },
});
