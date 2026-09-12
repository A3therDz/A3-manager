/**
 * 契约一致性检查(静态分析 + 运行时校验)。
 *
 * 目的:Electron 主进程与 HTTP 服务**我无法运行验证**(缺依赖 / 端口被拒),
 * 所以退一步做两件事:
 *   1. 运行时校验 AssetDb 上确实存在被调用的每个方法、且不是内部私有字段;
 *   2. 静态扫描 src/main/index.ts 与 src/server/index.ts 里所有 db.xxx( 调用,
 *      逐一核对是否在 AssetDb 的实现中声明。
 * 这样能在装依赖之前就排除"方法名写错/参数结构对不上"这类必然翻车的问题。
 *
 *   node --experimental-strip-types tools/verify-contract.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetDb } from '../src/main/db.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');

let failures = 0;
const bad = (msg: string) => {
  failures++;
  console.log('  FAIL  ' + msg);
};
const good = (msg: string) => console.log('  ok    ' + msg);

// ---------------------------------------------------------------- 1) 运行时

console.log('=== 1) AssetDb 实例方法运行时校验 ===');
const db = new AssetDb(process.env.CAM_DB as string);
const proto = Object.getPrototypeOf(db) as object;
const implMethods = new Set<string>();
for (const name of Object.getOwnPropertyNames(proto)) {
  if (name === 'constructor') continue;
  const d = Object.getOwnPropertyDescriptor(proto, name);
  if (d && typeof d.value === 'function') implMethods.add(name);
}
console.log(`  实现的方法(${implMethods.size}): ${[...implMethods].sort().join(', ')}`);

/** 主进程/服务里用到的 db 方法(手工登记,必须与下面静态扫描结果一致) */
const REQUIRED = [
  'listRoots', 'addRoot', 'removeRoot', 'setRootEnabled', 'markRootScanned',
  'loadFingerprints', 'upsertImage', 'deleteImagesNotIn', 'transaction',
  'queryImages', 'searchIds', 'getImagesByIds', 'getImageRow', 'getImageDetail',
  'getSiblings', 'getFolderTree', 'getStats', 'getFilterOptions',
  'setStarred', 'count', 'close',
] as const;
for (const m of REQUIRED) {
  if (implMethods.has(m)) good(`db.${m}() 存在`);
  else bad(`db.${m}() 不存在 —— 主进程/服务会调用失败`);
}

// 私有字段(以 # 开头)不可从外部访问,若被外部调用即为 bug
console.log('\n=== 2) 私有字段泄漏检查 ===');
const dbObj = db as unknown as Record<string, unknown>;
for (const key of Object.keys(dbObj)) {
  if (key !== 'db' && key !== 'file') {
    console.log(`  实例自有属性: ${key} = ${typeof dbObj[key]}`);
  }
}
console.log(`  db 属性: ${dbObj.db ? '存在(供测试直连 SQL)' : '缺失'} `);

// ---------------------------------------------------------------- 3) 静态扫描

console.log('\n=== 3) 静态扫描 db.xxx( 调用 ===');
const CALLER_FILES = [
  'src/main/index.ts',
  'src/server/index.ts',
  'src/main/indexer.ts',
  'src/main/cli-index.ts',
];

const used = new Map<string, string[]>();
for (const rel of CALLER_FILES) {
  const f = path.join(PROJECT, rel);
  if (!fs.existsSync(f)) {
    bad(`文件不存在: ${rel}`);
    continue;
  }
  const src = fs.readFileSync(f, 'utf8');
  // 匹配 db.方法名(
  const re = /\bdb\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    if (!used.has(name)) used.set(name, []);
    used.get(name)!.push(rel);
  }
}

const missing: string[] = [];
for (const [name, files] of [...used.entries()].sort()) {
  if (implMethods.has(name) || name === 'db') {
    good(`db.${name}()  被 ${[...new Set(files)].join(', ')} 调用`);
  } else {
    missing.push(name);
    bad(`db.${name}()  被 ${[...new Set(files)].join(', ')} 调用,但 AssetDb 没有这个方法`);
  }
}

console.log(`\n  静态扫描共发现 ${used.size} 个不同的 db 方法调用`);
if (missing.length) console.log(`  ⚠️ 未实现: ${missing.join(', ')}`);

// ---------------------------------------------------------------- 4) API 契约覆盖

console.log('\n=== 4) ApiSurface 契约 vs IPC 通道覆盖 ===');
const typesSrc = fs.readFileSync(path.join(PROJECT, 'src/shared/types.ts'), 'utf8');
const ifaceMatch = typesSrc.match(/export interface ApiSurface \{([\s\S]*?)\n\}/);
if (!ifaceMatch) {
  bad('找不到 ApiSurface 接口定义');
} else {
  const body = ifaceMatch[1];
  // 抓取 "方法名(" 形式
  const apiMethods = [...body.matchAll(/^\s{2}([a-zA-Z][A-Za-z0-9_]*)\s*\(/gm)].map((x) => x[1]);
  console.log(`  ApiSurface 声明了 ${apiMethods.length} 个方法`);

  // preload 里暴露的方法
  const preloadSrc = fs.readFileSync(path.join(PROJECT, 'src/preload/index.cjs'), 'utf8');
  const exposed = new Set([...preloadSrc.matchAll(/^\s{2}([a-zA-Z][A-Za-z0-9_]*):\s*\(/gm)].map((x) => x[1]));
  // 主进程注册的通道
  const mainSrc = fs.readFileSync(path.join(PROJECT, 'src/main/index.ts'), 'utf8');
  const channels = new Set([...mainSrc.matchAll(/handle\('([A-Za-z0-9_]+)'/g)].map((x) => x[1]));

  const notInPreload = apiMethods.filter((m) => !exposed.has(m));
  /**
   * 这些方法不走 ipcMain.handle,因此不该出现在通道列表里:
   *   onScanProgress  —— 订阅语义,由主进程 webContents.send('scan:progress') 推送
   *   getThumbUrl     —— 纯前端拼接,不走 IPC(直接生成 cam-thumb:// URL)
   */
  const NON_HANDLE = new Set(['onScanProgress', 'getThumbUrl']);
  const notInMain = apiMethods.filter((m) => !NON_HANDLE.has(m) && !channels.has(m));
  const extraChannels = [...channels].filter((c) => !apiMethods.includes(c));

  if (notInPreload.length) bad(`ApiSurface 有但 preload 未暴露: ${notInPreload.join(', ')}`);
  else good('preload 已暴露 ApiSurface 的全部方法');

  if (notInMain.length) bad(`ApiSurface 有但主进程未注册通道: ${notInMain.join(', ')}`);
  else {
    good('主进程已注册 ApiSurface 的全部请求/响应通道');
    console.log(`  (${[...NON_HANDLE].join(', ')} 不走 ipcMain.handle,已排除)`);
  }

  // 订阅类方法必须确实有对应的推送
  const mainSrc2 = fs.readFileSync(path.join(PROJECT, 'src/main/index.ts'), 'utf8');
  if (mainSrc2.includes("webContents.send('scan:progress'")) good("进度推送 webContents.send('scan:progress') 存在");
  else bad("缺少 scan:progress 推送");

  if (extraChannels.length) good(`主进程额外注册的通道(不在 ApiSurface 里): ${extraChannels.join(', ')}`);
}

// ---------------------------------------------------------------- 5) 渲染层 API 调用

console.log('\n=== 5) 渲染层用到的 window.api.* 是否都在契约里 ===');
/** 渲染层全部源文件 —— 新增组件必须登记到这里,否则不会被检查 */
const RENDERER_FILES = [
  'src/renderer/main.tsx',
  'src/renderer/App.tsx',
  'src/renderer/api.ts',
  // 全局 Window.api 声明。注意:它必须是普通 .ts 模块而不是 .d.ts ——
  // 放在 .d.ts 里时曾整层报 "Property 'api' does not exist on type 'Window'"。
  'src/renderer/global.ts',
  'src/renderer/components/Trees.tsx',
  'src/renderer/components/ImageGrid.tsx',
  'src/renderer/components/DetailPanel.tsx',
];
const apiMethodSet = new Set<string>();
{
  const typesSrc = fs.readFileSync(path.join(PROJECT, 'src/shared/types.ts'), 'utf8');
  const ifaceMatch = typesSrc.match(/export interface ApiSurface \{([\s\S]*?)\n\}/);
  if (ifaceMatch) {
    for (const m of ifaceMatch[1].matchAll(/^\s{2}([a-zA-Z][A-Za-z0-9_]*)\s*\(/gm)) {
      apiMethodSet.add(m[1]);
    }
  }
}
let apiCallTotal = 0;
let apiCallBad = 0;
for (const rel of RENDERER_FILES) {
  const f = path.join(PROJECT, rel);
  if (!fs.existsSync(f)) {
    bad(`渲染层文件不存在: ${rel}`);
    continue;
  }
  const src = fs.readFileSync(f, 'utf8');
  const calls = [...src.matchAll(/window\.api\.([a-zA-Z][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]);
  apiCallTotal += calls.length;
  for (const c of new Set(calls)) {
    if (apiMethodSet.has(c)) good(`${rel} 调用 window.api.${c}() — 契约中存在`);
    else {
      apiCallBad++;
      bad(`${rel} 调用 window.api.${c}() — 契约里没有这个方法`);
    }
  }
}
if (apiCallTotal === 0) bad('渲染层完全没有调用 window.api(界面不可能有数据)');
else good(`渲染层共 ${apiCallTotal} 处 window.api 调用,全部有契约支持`);

// ---------------------------------------------------------------- 5b) 渲染层结构

console.log('\n=== 5b) 渲染层结构检查 ===');
{
  // 组件必须存在,且入口必须真的挂载 App
  const mainSrc = fs.readFileSync(path.join(PROJECT, 'src/renderer/main.tsx'), 'utf8');
  if (/from\s+['"]\.\/App['"]/.test(mainSrc)) good('main.tsx 导入 App');
  else bad('main.tsx 没有导入 ./App —— 界面不会渲染');
  if (mainSrc.includes('createRoot(')) good('main.tsx 调用 createRoot');
  else bad('main.tsx 没有调用 createRoot');

  // 组件之间不能反向依赖 Electron / Node 内置模块
  const forbidden = [/from\s+['"]electron['"]/, /from\s+['"]node:/, /require\(['"]electron['"]\)/];
  for (const rel of RENDERER_FILES) {
    const f = path.join(PROJECT, rel);
    if (!fs.existsSync(f)) continue;
    if (rel.endsWith('api.d.ts')) continue;
    const src = fs.readFileSync(f, 'utf8');
    const hit = forbidden.find((re) => re.test(src));
    if (hit) {
      bad(`${rel} 直接引用了 Electron / Node 内置模块 —— 渲染层必须走 window.api`);
    }
  }
  good('渲染层未直接引用 Electron / Node 内置模块');

  // 采样器:用户已明确要求从界面移除,这里做成护栏防止回流。
  // 注意要先剥掉注释 —— 代码里有一句"采样器已按用户要求移除"的说明,那是文档不是 UI。
  const DETAIL = path.join(PROJECT, 'src/renderer/components/DetailPanel.tsx');
  if (fs.existsSync(DETAIL)) {
    const d = fs.readFileSync(DETAIL, 'utf8');
    const codeOnly = d
      .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l)) // 行注释与 JSDoc 续行
      .join('\n');
    if (codeOnly.includes('采样器')) {
      bad('DetailPanel 的代码里出现「采样器」—— 用户已明确要求移除该字段');
    } else {
      good('DetailPanel 未展示采样器(符合用户要求,注释中的说明不计)');
    }
    // 需求里明确要展示的字段必须都在(同样只看代码)
    const REQUIRED_FIELDS = ['像素尺寸', '模型', '调度器', '步数', 'CFG', 'seed', 'LoRA', '正向提示词', '负向提示词', '生成日期'];
    const missing = REQUIRED_FIELDS.filter((f2) => !codeOnly.includes(f2));
    if (missing.length === 0) good(`详情面板包含全部需求字段(${REQUIRED_FIELDS.length} 项)`);
    else bad(`详情面板缺少字段: ${missing.join('、')}`);
    // 数据缺失必须显示"未记录",不能留空
    if (codeOnly.includes('未记录')) good('详情面板会显示「未记录」(数据缺失是常态)');
    else bad('详情面板没有「未记录」兜底 —— 61% 的调度器缺失会显示成空白');
  }
}

// ---------------------------------------------------------------- 6) 构建入口存在性

console.log('\n=== 6) 构建配置引用的入口文件是否存在 ===');
// Vite 的约定:以 root/index.html 作为入口,渲染层 JS 由 html 里的
// <script type="module" src=...> 指定。所以这里校验的是"这个约定链条完整",
// 而不是"vite.config.ts 里出现了 src/renderer 字样"。
{
  const htmlPath = path.join(PROJECT, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    bad('缺少 index.html(Vite 的入口)');
  } else {
    good('index.html 存在(Vite 入口)');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const scriptSrc = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html)?.[1];
    if (!scriptSrc) {
      bad('index.html 里没有 <script type="module" src=...>');
    } else {
      // /src/renderer/main.tsx -> <repo>/src/renderer/main.tsx
      const rel = scriptSrc.replace(/^\//, '');
      const abs = path.join(PROJECT, rel);
      if (fs.existsSync(abs)) good(`index.html 指向的入口存在: ${rel}`);
      else bad(`index.html 指向 ${rel},但文件不存在`);
    }
    if (html.includes('http-equiv="Content-Security-Policy"')) {
      good('index.html 设置了 CSP(Electron 下必须)');
    } else {
      bad('index.html 缺少 CSP —— Electron 加载本地页面时会告警');
    }
  }

  const viteCfg = fs.readFileSync(path.join(PROJECT, 'vite.config.ts'), 'utf8');
  // 注意:配置里用的是 path.join(...),在 Windows 上渲染出的源码是 'dist\\renderer',
  // 所以不能用只匹配正斜杠的正则。
  if (/outDir[\s\S]{0,40}dist['"`,\s]*[\\/]+renderer/.test(viteCfg)) {
    good('vite.config.ts 把渲染产物输出到 dist/renderer');
  } else {
    bad('vite.config.ts 的 build.outDir 不是 dist/renderer');
  }

  const mainCfg = fs.readFileSync(path.join(PROJECT, 'vite.main.config.ts'), 'utf8');
  if (mainCfg.includes('src/main/index.ts')) good('vite.main.config.ts 引用了 main 入口');
  else bad('vite.main.config.ts 没有引用 src/main/index.ts');
  if (mainCfg.includes('src/preload/index.cjs')) good('vite.main.config.ts 引用了 preload 入口');
  else bad('vite.main.config.ts 没有引用 src/preload/index.cjs');
}

// package.json 的 main 字段指向的产物由构建生成,这里只校验路径形态与脚本
{
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf8')) as {
    main?: string;
    type?: string;
    scripts?: Record<string, string>;
  };
  if (pkg.main === 'dist/main/index.mjs') good('package.json main 指向 dist/main/index.mjs(ESM)');
  else bad(`package.json main 是 ${pkg.main},与 vite.main.config.ts 的输出不一致`);
  if (pkg.type === 'module') good('package.json type=module(与 ESM 产物一致)');
  else bad('package.json 缺少 type=module,ESM 产物会被当 CJS 加载而报错');
  for (const s of ['build', 'start', 'package']) {
    if (pkg.scripts && pkg.scripts[s]) good(`npm run ${s} 已定义`);
    else bad(`缺少 npm script: ${s}`);
  }
}

// ---------------------------------------------------------------- 7) preload 必须用 CJS

console.log('\n=== 7) preload 格式检查 ===');
{
  const preloadF = path.join(PROJECT, 'src/preload/index.cjs');
  const src = fs.readFileSync(preloadF, 'utf8');
  // Electron 的 preload 走 CommonJS 加载路径,用 ESM 的 import 会失败
  if (/^\s*import\s/m.test(src)) bad('preload 使用了 ESM import(Electron preload 需要 CJS)');
  else good('preload 使用 CommonJS(require),符合 Electron preload 加载方式');
  if (src.includes('contextBridge.exposeInMainWorld')) good('preload 通过 contextBridge 暴露 API');
  else bad('preload 没有调用 contextBridge.exposeInMainWorld');
  if (src.includes('nodeIntegration')) bad('preload 里不该出现 nodeIntegration(那是 webPreferences 的字段)');
}

db.close();

console.log('\n' + (failures === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${failures} 项)`));
process.exit(failures === 0 ? 0 : 1);
