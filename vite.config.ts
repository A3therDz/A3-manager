import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

/** 后端 API 端口。可用 CAM_PORT 覆盖,与 src/server/index.ts 的默认值保持一致 */
const API_PORT = process.env.CAM_PORT ?? '5174';

export default defineConfig({
  root: dir,
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.join(dir, 'src/shared'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    /**
     * 开发代理。
     *
     * 为什么需要:桌面版里 window.api 由 preload 注入,不走网络;
     * 但纯浏览器调试时前端跑在 5173、API 在另一个端口,属于跨源。
     * 服务端已开 CORS,但用代理更省事 —— 同源之后连预检都不需要。
     *
     * 启动顺序:先起 API 服务,再起 vite
     *   node --experimental-strip-types src\server\index.ts --port 5174
     *   npm run dev
     */
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: path.join(dir, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome120',
  },
});
