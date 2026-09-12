/**
 * 缩略图批量同步 —— 独立于导出,可中断续跑。
 *
 * 为什么独立出来:
 *  首次生成 8061 张约需 17 分钟,把它塞进"导出图库"会让导出变成一个长任务。
 *  拆开后:
 *    - 导出可以随时跑,已生成的缩略图直接用,没有的自动回退原图;
 *    - 本工具可以反复运行,已存在的直接跳过,中断后接着跑;
 *    - 桌面版将来也用同一个缓存目录。
 *
 * 用法:
 *   node tools/thumb-sync.mjs [--max 320] [--limit N] [--only-missing]
 *
 * 缓存位置:data/thumbs/<imageId>.png(与图库导出、将来的 Electron 版共用)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { AssetDb } from '../src/main/db.ts';

const nodeRequire = createRequire(import.meta.url);
const { makeThumb } = nodeRequire('./thumbnail.cjs') as {
  makeThumb: (
    src: string,
    out: string,
    opt?: { max?: number; force?: boolean }
  ) => { out: string; cached: boolean; outBytes: number; ms: number } | null;
};

function argVal(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = process.env.CAM_DB ?? path.join(PROJECT, 'data', 'index.db');
const MAX = Number(argVal('max', '320'));
const LIMIT = argVal('limit') ? Number(argVal('limit')) : Infinity;
const FORCE = process.argv.includes('--force');

/**
 * 缩略图缓存目录名。放在**每个图库根目录内部**,与参考项目(Aaalice NAI Launcher)
 * 的 `.thumbs` 约定一致:缓存跟着图库走,而不是跟着管理器走。
 * 这样换机器、迁移图库、重装管理器都不会让缩略图失联。
 *
 * 差异点:参考项目在**每个子文件夹**里各放一个 `.thumbs`,
 * 这里改为在根目录放**一个**隐藏目录并按相对路径镜像,好处是不会在几千个
 * 日期文件夹里各插一个目录。
 */
const THUMB_DIRNAME = process.env.CAM_THUMB_DIRNAME ?? '.comfy-thumbs';

/**
 * 换算某张图的缩略图路径。
 *
 * 命名沿用参考项目思路(原名 + 后缀),但用 `.thumb.png` 而非 `.small.thumb.jpg`,
 * 因为本项目输出的是调色板 PNG 且不经 JPEG。
 * 例:<root>\anima\2026-08-13\a.png  ->  <root>\.comfy-thumbs\anima\2026-08-13\a.thumb.png
 */
function thumbPathFor(rootPath: string, relPath: string): string {
  const dir = path.dirname(relPath);
  const base = path.basename(relPath, path.extname(relPath));
  const sub = dir === '.' ? '' : dir;
  return path.join(rootPath, THUMB_DIRNAME, sub, `${base}.thumb.png`);
}

if (!fs.existsSync(DB_FILE)) {
  console.error(`索引库不存在: ${DB_FILE}`);
  process.exit(1);
}

const db = new AssetDb(DB_FILE);
const total = db.count();
if (total === 0) {
  console.error('索引库是空的,先运行 cli-index.ts scan');
  process.exit(1);
}

// 取 id + 所属图库根 + 相对路径(按 id 升序,顺序稳定)
const rootRows = db.listRoots() as Array<{ id: number; path: string; label: string }>;
const rootById = new Map(rootRows.map((r) => [r.id, r.path]));
const rawRows = db.db
  .prepare('SELECT id, root_id, rel_path, abs_path FROM images ORDER BY id')
  .all() as Array<Record<string, unknown>>;
db.close();

if (rawRows.length > 0 && process.env.CAM_DEBUG) {
  console.log('  [debug] 首行字段: ' + Object.keys(rawRows[0]).join(', '));
  console.log('  [debug] 首行值: ' + JSON.stringify(rawRows[0]).slice(0, 200));
  console.log('  [debug] roots: ' + JSON.stringify([...rootById.entries()]));
}

/** 归一化:node:sqlite 返回的列名可能是 snake_case,也可能已映射为 camelCase */
function pickNum(o: Record<string, unknown>, ...keys: string[]): number {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number') return v;
  }
  return NaN;
}
function pickStr(o: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string') return v;
  }
  return '';
}

const rows = rawRows.map((o) => ({
  id: pickNum(o, 'id'),
  rootId: pickNum(o, 'root_id', 'rootId'),
  relPath: pickStr(o, 'rel_path', 'relPath'),
  absPath: pickStr(o, 'abs_path', 'absPath'),
}));

/** 需要时才创建目录,避免给几千个文件夹都建空目录 */
const madeDirs = new Set<string>();

let done = 0;
let skipped = 0;
let created = 0;
let failed = 0;
let bytesIn = 0;
let bytesOut = 0;

const t0 = Date.now();
let lastPrint = 0;

console.log(`缩略图同步`);
console.log(`  索引库    ${DB_FILE}`);
console.log(`  缓存位置  每个图库根目录下的 ${THUMB_DIRNAME}\\<相对路径>\\<原名>.thumb.png`);
for (const r of rootRows) console.log(`            ${r.label}  ${r.path}`);
console.log(`  上限尺寸  ${MAX}px   强制重生成 ${FORCE ? '是' : '否'}`);
console.log(`  库内总数  ${rows.length}`);
console.log('');

for (const r of rows) {
  if (done >= LIMIT) break;
  done++;

  const rootPath = rootById.get(r.rootId);
  if (!rootPath) {
    failed++;
    if (process.env.CAM_DEBUG && failed <= 3) {
      console.log(`  [debug] 取不到 rootPath: id=${r.id} rootId=${r.rootId}(${typeof r.rootId}) relPath=${r.relPath}`);
    }
    continue;
  }
  const out = thumbPathFor(rootPath, r.relPath);

  if (!FORCE) {
    try {
      const st = fs.statSync(out);
      if (st.size > 0) {
        skipped++;
        bytesOut += st.size;
        continue;
      }
    } catch {
      /* 不存在,继续生成 */
    }
  }

  try {
    const dir = path.dirname(out);
    if (!madeDirs.has(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      madeDirs.add(dir);
    }
    const res = makeThumb(r.absPath, out, { max: MAX, force: true });
    if (res) {
      created++;
      bytesOut += res.outBytes;
      try {
        bytesIn += fs.statSync(r.absPath).size;
      } catch {
        /* 读不到源大小不影响结果 */
      }
    } else {
      failed++;
    }
  } catch {
    failed++;
  }

  const now = Date.now();
  if (now - lastPrint > 1000) {
    lastPrint = now;
    const dt = (now - t0) / 1000;
    const rate = (created + skipped) / dt;
    const remain = rows.length - done;
    const eta = rate > 0 ? remain / rate : 0;
    process.stdout.write(
      `\r  进度 ${done}/${rows.length}  新建 ${created}  跳过 ${skipped}  失败 ${failed}  ` +
        `${rate.toFixed(1)}/s  剩余约 ${(eta / 60).toFixed(1)} 分钟   `
    );
  }
}

process.stdout.write('\r' + ' '.repeat(110) + '\r');
const dt = (Date.now() - t0) / 1000;

console.log('  完成');
console.log('  ' + '='.repeat(56));
console.log(`  处理        ${done}`);
console.log(`  新生成      ${created}`);
console.log(`  跳过已有    ${skipped}`);
console.log(`  失败        ${failed}`);
console.log(`  耗时        ${dt.toFixed(1)}s  (${((created + skipped) / dt).toFixed(1)}/s)`);
if (bytesIn > 0) {
  console.log(`  源图体积    ${(bytesIn / 1048576).toFixed(0)} MB`);
  console.log(`  缩略图体积  ${(bytesOut / 1048576).toFixed(0)} MB   (压缩 ${(bytesIn / Math.max(1, bytesOut)).toFixed(0)}x)`);
}
console.log('');
console.log('  再次运行本命令会自动跳过已生成的,可安全中断续跑。');
console.log('');
