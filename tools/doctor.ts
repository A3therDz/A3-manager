/**
 * 环境自检 —— 装完依赖后先跑这个,能省掉大部分"首次启动报错"的排查。
 *
 *   node --experimental-strip-types tools\doctor.ts
 *
 * 检查项:
 *   1. Node 版本与 node:sqlite 可用性(本项目整个数据层依赖它)
 *   2. 依赖是否装上(electron / react / vite / typescript)
 *   3. 构建配置完整性(入口文件、产物路径、package.json 约定)
 *   4. 索引库与图库根状态,以及缩略图缓存覆盖率
 *   5. 关键能力自检:PNG 解析器、缩略图生成器能在真实文件上跑通
 *
 * 退出码 0 = 可以启动;非 0 = 有必须先解决的问题。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeRequire = createRequire(import.meta.url);

let problems = 0;
let warnings = 0;
const step = (n: number, title: string) => console.log(`\n[${n}] ${title}`);
const pass = (m: string) => console.log(`  ✅ ${m}`);
const warn = (m: string) => {
  warnings++;
  console.log(`  ⚠️  ${m}`);
};
const fail = (m: string) => {
  problems++;
  console.log(`  ❌ ${m}`);
};

console.log('ComfyUI 资产管理器 —— 环境自检');
console.log('='.repeat(62));
console.log(`项目目录  ${PROJECT}`);
console.log(`Node      ${process.version}  (${process.platform}/${process.arch})`);

// ---------------------------------------------------------------- 1) 运行时

step(1, 'Node 运行时与 node:sqlite');
const major = Number(process.versions.node.split('.')[0]);
if (major >= 22) pass(`Node ${process.versions.node} >= 22`);
else fail(`Node ${process.versions.node} 太旧:node:sqlite 需要 Node 22+`);

let SQLITE_OK = false;
try {
  const { DatabaseSync } = nodeRequire('node:sqlite') as {
    DatabaseSync: new (f: string) => { exec(s: string): void; close(): void };
  };
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE VIRTUAL TABLE t USING fts5(a)');
  d.close();
  SQLITE_OK = true;
  pass('node:sqlite 可用,且 FTS5 已启用');
} catch (e) {
  fail(`node:sqlite 不可用: ${(e as Error).message}`);
}

// ---------------------------------------------------------------- 2) 依赖

step(2, '依赖是否已安装');
const DEPS: Array<{ name: string; required: boolean; why: string }> = [
  { name: 'electron', required: true, why: '桌面外壳' },
  { name: 'react', required: true, why: '渲染层' },
  { name: 'react-dom', required: true, why: '渲染层' },
  { name: 'vite', required: true, why: '构建' },
  { name: 'typescript', required: true, why: '类型检查' },
  { name: 'electron-builder', required: false, why: '打包安装包' },
];
const nodeModules = path.join(PROJECT, 'node_modules');
if (!fs.existsSync(nodeModules)) {
  fail('node_modules 不存在 —— 先执行 npm install');
} else {
  for (const d of DEPS) {
    const pkgFile = path.join(nodeModules, d.name, 'package.json');
    if (fs.existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as { version?: string };
        pass(`${d.name}@${pkg.version ?? '?'}  (${d.why})`);
      } catch {
        warn(`${d.name} 的 package.json 读不出内容`);
      }
    } else if (d.required) {
      fail(`缺少 ${d.name}(${d.why})`);
    } else {
      warn(`缺少可选依赖 ${d.name}(${d.why})`);
    }
  }
}

// ---------------------------------------------------------------- 3) 构建配置

step(3, '构建配置');
const mustExist: Array<[string, string]> = [
  ['index.html', 'Vite 入口'],
  ['vite.config.ts', '渲染层构建配置'],
  ['vite.main.config.ts', '主进程构建配置'],
  ['src/main/index.ts', 'Electron 主进程'],
  ['src/main/db.ts', '数据层'],
  ['src/main/indexer.ts', '扫描器'],
  ['src/preload/index.cjs', 'IPC 桥'],
  ['src/renderer/main.tsx', '渲染层入口'],
  ['src/shared/types.ts', '类型契约'],
];
for (const [rel, why] of mustExist) {
  if (fs.existsSync(path.join(PROJECT, rel))) pass(`${rel}  (${why})`);
  else fail(`缺少 ${rel}  (${why})`);
}

{
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf8')) as {
    main?: string;
    type?: string;
    scripts?: Record<string, string>;
  };
  if (pkg.type === 'module') pass('package.json type=module');
  else fail('package.json 缺少 type=module');

  const expected = path.join('dist', 'main', 'index.mjs').replace(/\\/g, '/');
  if ((pkg.main ?? '').replace(/\\/g, '/') === expected) pass(`main = ${pkg.main}`);
  else fail(`main = ${pkg.main},应为 ${expected}(与 vite.main.config.ts 不一致)`);

  for (const s of ['build', 'start', 'package', 'typecheck']) {
    if (pkg.scripts && pkg.scripts[s]) pass(`npm run ${s}`);
    else if (s === 'typecheck') warn('未定义 npm run typecheck');
    else fail(`缺少 npm script ${s}`);
  }
}

// ---------------------------------------------------------------- 4) 索引库与图库

step(4, '索引库与图库根');
const DB_FILE = process.env.CAM_DB ?? path.join(PROJECT, 'data', 'index.db');
console.log(`  索引库    ${DB_FILE}`);
if (!fs.existsSync(DB_FILE)) {
  warn('索引库不存在 —— 需要先扫描:node --experimental-strip-types src/main/cli-index.ts add <目录> && ... scan');
} else {
  const sizeMb = fs.statSync(DB_FILE).size / 1048576;
  pass(`索引库存在 (${sizeMb.toFixed(1)} MB)`);
  if (!SQLITE_OK) {
    warn('跳过索引库内容检查(node:sqlite 不可用)');
  } else {
    const { AssetDb } = await import('../src/main/db.ts');
    const db = new AssetDb(DB_FILE);
    const stats = db.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM images) AS imgs,
                (SELECT COUNT(*) FROM categories) AS cats,
                (SELECT COUNT(*) FROM roots) AS roots`
      )
      .get() as { imgs: number; cats: number; roots: number };
    console.log(`  图片 ${stats.imgs} 张 | 分类 ${stats.cats} 个 | 图库根 ${stats.roots} 个`);

    const roots = db.listRoots() as Array<{ id: number; path: string; label: string; enabled: number }>;
    if (roots.length === 0) warn('还没有添加任何图库根目录');
    let thumbTotal = 0;
    let thumbHave = 0;
    for (const r of roots) {
      if (!fs.existsSync(r.path)) {
        fail(`图库根不存在(可能已移动/断盘):${r.path}`);
        continue;
      }
      pass(`图库根可访问:${r.path}`);
      const thumbDirName = '.comfy-thumbs';
      const rows = db.db
        .prepare('SELECT rel_path FROM images WHERE root_id = ?')
        .all(r.id) as Array<{ rel_path: string }>;
      for (const row of rows) {
        const dir = path.dirname(row.rel_path);
        const base = path.basename(row.rel_path, path.extname(row.rel_path));
        const tp = path.join(r.path, thumbDirName, dir === '.' ? '' : dir, `${base}.thumb.png`);
        thumbTotal++;
        try {
          if (fs.statSync(tp).size > 0) thumbHave++;
        } catch {
          /* 缺一张不算错 */
        }
      }
    }
    if (thumbTotal > 0) {
      const pct = ((thumbHave / thumbTotal) * 100).toFixed(0);
      if (thumbHave === thumbTotal) pass(`缩略图缓存完整 (${thumbHave}/${thumbTotal})`);
      else warn(`缩略图缓存 ${thumbHave}/${thumbTotal} (${pct}%) —— 跑 node --experimental-strip-types tools\\thumb-sync.ts 补齐`);
    }
    db.close();
  }
}

// ---------------------------------------------------------------- 5) 能力自检

step(5, '关键能力自检(拿真实图片跑一遍)');
const { extractFromPng } = nodeRequire('./comfy-parser.cjs') as {
  extractFromPng: (p: string) => { dimensions: { width: number; height: number } | null; meta: { source: string; modelName: string | null } };
};
const { makeThumb } = nodeRequire('./thumbnail.cjs') as {
  makeThumb: (s: string, o: string, opt?: { max?: number; force?: boolean }) => { outBytes: number; w?: number; h?: number; ms: number } | null;
};

// 找一个可用样本:优先索引库里的图,否则在 C:\Windows 里找一张 png
let sample: string | null = null;
if (SQLITE_OK && fs.existsSync(DB_FILE)) {
  try {
    const { AssetDb } = await import('../src/main/db.ts');
    const db = new AssetDb(DB_FILE);
    const row = db.db.prepare('SELECT abs_path FROM images LIMIT 1').get() as { abs_path: string } | undefined;
    if (row && fs.existsSync(row.abs_path)) sample = row.abs_path;
    db.close();
  } catch {
    /* 忽略 */
  }
}
if (!sample && fs.existsSync('C:\\Windows')) {
  for (const f of fs.readdirSync('C:\\Windows')) {
    if (/\.png$/i.test(f)) {
      const p = path.join('C:\\Windows', f);
      try {
        if (fs.statSync(p).size > 0) { sample = p; break; }
      } catch { /* skip */ }
    }
  }
}

if (!sample) {
  warn('找不到用于自检的 PNG 样本,跳过能力检查');
} else {
  console.log(`  样本      ${sample}`);
  try {
    const r = extractFromPng(sample);
    pass(`PNG 元数据解析可用 (source=${r.meta.source}, ${r.dimensions ? r.dimensions.width + 'x' + r.dimensions.height : '无尺寸'})`);
  } catch (e) {
    fail(`PNG 解析失败: ${(e as Error).message}`);
  }

  const tmpOut = path.join(PROJECT, 'data', '_doctor_thumb.png');
  try {
    fs.mkdirSync(path.dirname(tmpOut), { recursive: true });
    const t = makeThumb(sample, tmpOut, { max: 160, force: true });
    if (t) {
      pass(`缩略图生成可用 (${t.w}x${t.h}, ${(t.outBytes / 1024).toFixed(1)} KB, ${t.ms}ms)`);
    } else {
      warn('缩略图生成返回 null(该 PNG 可能是非 8 位或交错格式,属已知范围外)');
    }
  } catch (e) {
    fail(`缩略图生成失败: ${(e as Error).message}`);
  } finally {
    fs.rmSync(tmpOut, { force: true });
  }
}

// Electron 自带 Node 与系统 Node 是两套运行时,这里给出明确提醒
{
  const electronPkg = path.join(nodeModules, 'electron', 'package.json');
  if (fs.existsSync(electronPkg)) {
    try {
      const v = (JSON.parse(fs.readFileSync(electronPkg, 'utf8')) as { version?: string }).version ?? '';
      const majorE = Number(v.split('.')[0]);
      // Electron 33 内置 Node 20,没有 node:sqlite;35 起才基于 Node 22。
      if (majorE >= 35) {
        pass(`electron@${v} 内置 Node 22+,支持 node:sqlite`);
      } else {
        fail(`electron@${v} 内置的 Node < 22,启动时会报 "Cannot find module node:sqlite" —— 升到 ^35`);
      }
    } catch {
      warn('electron 版本读不出来');
    }
  } else {
    console.log('');
    console.log('  提醒:Electron 使用自带的 Node 运行时,与系统 Node 是两套环境。');
    console.log('        db.ts 依赖 node:sqlite,需要 Electron 35+(基于 Node 22)才可用。');
  }
}

// ---------------------------------------------------------------- 汇总

console.log('\n' + '='.repeat(62));
if (problems === 0 && warnings === 0) {
  console.log('全部通过 —— 可以执行 npm run build 然后 npm start');
} else if (problems === 0) {
  console.log(`可以启动,但有 ${warnings} 条提醒(不阻塞)`);
} else {
  console.log(`有 ${problems} 个问题必须先解决${warnings ? `,另有 ${warnings} 条提醒` : ''}`);
}
process.exit(problems === 0 ? 0 : 1);
