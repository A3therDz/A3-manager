/**
 * 端到端验证:缩略图生成 -> 图库导出 -> HTML 只引用缩略图。
 *
 * 全部进程内调用(不 spawn 子进程 —— 沙箱禁止 pipe stdio,spawnSync 会 EPERM)。
 *
 * 沙箱不允许写 E:\SD\(ComfyUI 输出目录),所以这里复制少量原图到工作区内的
 * 临时图库,完整跑一遍"图库内 .comfy-thumbs + 相对路径镜像"的布局。
 *
 *   node --experimental-strip-types tools\verify-thumb-e2e.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { AssetDb } from '../src/main/db.ts';
import { scanLibrary } from '../src/main/indexer.ts';

const nodeRequire = createRequire(import.meta.url);
const { makeThumb } = nodeRequire('./thumbnail.cjs') as {
  makeThumb: (
    src: string,
    out: string,
    opt?: { max?: number; force?: boolean }
  ) => { out: string; cached: boolean; outBytes: number; ms: number } | null;
};

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(PROJECT, 'data', 'e2e-lib');
const DB = path.join(PROJECT, 'data', 'e2e.db');
const SRC = process.env.CAM_IMAGES ?? '<你的图库目录>';
const N = Number(process.env.E2E_N ?? 12);
const THUMB_DIRNAME = '.comfy-thumbs';

/** 与 thumb-sync.ts / export-gallery.ts 必须完全一致的路径换算 */
function thumbPathFor(rootPath: string, relPath: string): string {
  const dir = path.dirname(relPath);
  const base = path.basename(relPath, path.extname(relPath));
  const sub = dir === '.' ? '' : dir;
  return path.join(rootPath, THUMB_DIRNAME, sub, `${base}.thumb.png`);
}

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (cond) console.log('  PASS  ' + msg);
  else {
    failures++;
    console.log('  FAIL  ' + msg);
  }
};

// ---------------------------------------------------------------- 造临时图库

fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(DB, { force: true });
fs.rmSync(path.join(PROJECT, 'data', 'e2e-gallery'), { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.png$/i.test(e.name)) out.push(p);
    if (out.length >= N * 4) return out;
  }
  return out;
}

const pool = walk(SRC).filter((p) => {
  try { return fs.statSync(p).size < 6 * 1048576; } catch { return false; }
});
const picked = pool.slice(0, N);

console.log('端到端验证(进程内)');
console.log(`  源目录      ${SRC}`);
console.log(`  临时图库    ${ROOT}`);
console.log(`  复制原图    ${picked.length} 张`);
console.log('');

// 分两层目录,验证相对路径镜像
for (let i = 0; i < picked.length; i++) {
  const sub = i % 2 === 0 ? 'a' : path.join('b', 'deep');
  const dir = path.join(ROOT, sub);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(picked[i], path.join(dir, path.basename(picked[i])));
}

// ---------------------------------------------------------------- 建索引

{
  const db = new AssetDb(DB);
  db.addRoot(ROOT);
  const r = scanLibrary(db, { force: true });
  console.log(`索引: 发现 ${r.scanned}, 入库 ${r.indexed}, 错误 ${r.errors}`);
  check(r.indexed === picked.length, `索引入库数 = 复制数 (${r.indexed}/${picked.length})`);
  check(!fs.existsSync(path.join(ROOT, THUMB_DIRNAME)), '生成缩略图前 .comfy-thumbs 不存在');
  db.close();
}

// ---------------------------------------------------------------- 生成缩略图(复刻 thumb-sync 逻辑)

const db2 = new AssetDb(DB);
const roots = db2.listRoots() as Array<{ id: number; path: string }>;
const rootById = new Map(roots.map((x) => [x.id, x.path]));
const rows = db2.db
  .prepare('SELECT id, root_id, rel_path, abs_path FROM images ORDER BY id')
  .all() as Array<{ id: number; root_id: number; rel_path: string; abs_path: string }>;

let created = 0;
let skipped = 0;
let failed = 0;
const t0 = Date.now();
for (const r of rows) {
  const rootPath = rootById.get(r.root_id);
  if (!rootPath) { failed++; continue; }
  const out = thumbPathFor(rootPath, r.rel_path);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) { skipped++; continue; }
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const res = makeThumb(r.abs_path, out, { max: 320, force: true });
    if (res) created++; else failed++;
  } catch { failed++; }
}
const dt = (Date.now() - t0) / 1000;
console.log(`\n缩略图: 新建 ${created} 跳过 ${skipped} 失败 ${failed}  耗时 ${dt.toFixed(1)}s`);
check(created === rows.length, `全部生成成功 (${created}/${rows.length})`);
check(failed === 0, '无失败');

// ---------------------------------------------------------------- 布局检查

const thumbs: string[] = [];
(function walkT(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkT(p);
    else thumbs.push(p);
  }
})(path.join(ROOT, THUMB_DIRNAME));

console.log('\n缩略图布局:');
for (const t of thumbs.slice(0, 4)) console.log('    ' + t.replace(ROOT + path.sep, ''));
check(thumbs.length === rows.length, `缩略图数量 = 索引数量 (${thumbs.length}/${rows.length})`);
check(thumbs.every((t) => t.endsWith('.thumb.png')), '命名全部为 <原名>.thumb.png');
check(thumbs.every((t) => t.startsWith(ROOT)), '全部位于图库内部(不是管理器目录)');
check(!fs.existsSync(path.join(PROJECT, 'data', 'thumbs')), '管理器目录下没有残留缩略图缓存');
check(
  fs.existsSync(path.join(ROOT, THUMB_DIRNAME, 'a')) &&
    fs.existsSync(path.join(ROOT, THUMB_DIRNAME, 'b', 'deep')),
  '子目录结构被镜像(a\\ 与 b\\deep\\)'
);

// ---------------------------------------------------------------- 导出并检查引用

// 直接复刻 export-gallery 的 src 解析(不 spawn 子进程)
console.log('\nHTML 引用检查(复刻 export-gallery 的路径解析):');
let usingThumb = 0;
let usingOrig = 0;
const sample: string[] = [];
for (const r of rows) {
  const rootPath = rootById.get(r.root_id)!;
  const t = thumbPathFor(rootPath, r.rel_path);
  if (fs.existsSync(t)) {
    usingThumb++;
    if (sample.length < 1) sample.push(t);
  } else {
    usingOrig++;
  }
}
check(usingThumb === rows.length, `全部可解析到缩略图 (${usingThumb}/${rows.length})`);
check(usingOrig === 0, '零回退原图');
console.log('    样例: ' + (sample[0] ?? '-').replace(PROJECT + path.sep, ''));

// ---------------------------------------------------------------- 缓存命中

let cached = 0;
for (const r of rows) {
  const rootPath = rootById.get(r.root_id)!;
  const out = thumbPathFor(rootPath, r.rel_path);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) cached++;
}
check(cached === rows.length, `二次运行全部命中缓存 (${cached}/${rows.length})`);

// ---------------------------------------------------------------- 体积对比

let srcBytes = 0;
let thumbBytes = 0;
for (const r of rows) {
  try { srcBytes += fs.statSync(r.abs_path).size; } catch { /* skip */ }
  const rootPath = rootById.get(r.root_id)!;
  const out = thumbPathFor(rootPath, r.rel_path);
  try { thumbBytes += fs.statSync(out).size; } catch { /* skip */ }
}
console.log(`\n体积: 原图 ${(srcBytes / 1048576).toFixed(1)} MB -> 缩略图 ${(thumbBytes / 1024).toFixed(0)} KB` +
  `  (压缩 ${(srcBytes / Math.max(1, thumbBytes)).toFixed(0)}x)`);

db2.close();

// ---------------------------------------------------------------- 清理

fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(DB, { force: true });
fs.rmSync(DB + '-wal', { force: true });
fs.rmSync(DB + '-shm', { force: true });

console.log('\n' + (failures === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${failures} 项)`));
process.exit(failures === 0 ? 0 : 1);
