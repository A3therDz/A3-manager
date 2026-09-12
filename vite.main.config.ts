import { defineConfig } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

/**
 * 主进程与 preload 的构建配置。
 *
 * 输出 ESM(.mjs) / CJS(.cjs) 而不是打包成单文件:
 *  - electron 与 node:sqlite 都是外部依赖,必须保持 external,不能内联。
 *  - node:sqlite 是 Node 22 内置模块,Electron 33 起自带的 Node 也能用。
 *
 * preload 是纯 CommonJS、只用 require('electron'),不需要打包;
 * 旧写法把它登记为 lib entry('../preload/index'),新版 Rollup 拒绝
 * 这种相对路径的 [name] 占位符,直接构建失败。改为构建后原样复制到
 * dist/preload/index.cjs —— 主进程 index.ts 里引用的就是这个位置。
 */
export default defineConfig({
  root: dir,
  plugins: [
    {
      name: 'copy-preload',
      closeBundle() {
        const src = path.join(dir, 'src/preload/index.cjs');
        const out = path.join(dir, 'dist/preload/index.cjs');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.copyFileSync(src, out);
      },
    },
  ],
  build: {
    outDir: path.join(dir, 'dist/main'),
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    lib: {
      entry: {
        index: path.join(dir, 'src/main/index.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['electron', /^node:/],
      output: {
        entryFileNames: 'index.mjs',
      },
    },
  },
});
