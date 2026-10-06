/**
 * 递归目录口径的**离线**验证(不碰真实索引库,不需要写盘):
 * 用内存里的 SQLite 造一棵 A/B/C 的目录树,核对
 *   1) relDir 精确匹配只拿直属图片;
 *   2) relDirRecursive 拿"自己 + 所有子目录";
 *   3) 名字前缀相近的兄弟目录(A vs AB)不会被 LIKE 通配误伤;
 *   4) relDir 传 null/'' 不会被当成筛选条件(不会拼出 LIKE 'null%')。
 *
 *   node --experimental-strip-types tools/verify-recursive-dir.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AssetDb } from '../src/main/db.ts';

let failures = 0;
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};
const good = (m: string) => console.log(`  ok   ${m}`);

const tmp = mkdtempSync(path.join(tmpdir(), 'a3-rec-'));
const dbFile = path.join(tmp, 'rec.db');

const db = new AssetDb(dbFile);
const rootId = db.addRoot('C:\\lib', 'lib');

// ---- 造一棵目录树:
//   A/            (1 张)
//   A/B/          (2 张)
//   A/B/C/        (3 张)
//   A/B2/         (5 张)   ← 只和 B 差一个字符,用来验证前缀误伤
//   AB/           (7 张)   ← 和 A 前缀相同但不是子目录
//   A2/           (11 张)
const dirs: Array<[string, number]> = [
  ['A', 1],
  [path.join('A', 'B'), 2],
  [path.join('A', 'B', 'C'), 3],
  [path.join('A', 'B2'), 5],
  ['AB', 7],
  ['A2', 11],
];

/** 往索引里塞一张"最小可用"的图片记录(query 只用到路径/尺寸/来源) */
let id = 0;
const put = (relDir: string, fileName: string) => {
  id++;
  const relPath = path.join(relDir, fileName);
  db.upsertImage({
    rootId,
    absPath: path.join('C:\\lib', relPath),
    relPath,
    relDir,
    fileName,
    fileSize: 1000,
    fileMtime: 1_700_000_000_000 + id,
    width: 1024,
    height: 1024,
    source: 'comfyui',
    modelName: null,
    samplerName: null,
    scheduler: null,
    steps: null,
    cfg: null,
    seed: null,
    posPrompt: null,
    negPrompt: null,
    promptLen: 0,
    loraCount: 0,
    nodeCount: 0,
    metaJson: '{}',
    rawJson: null,
    loras: [],
    searchText: fileName,
  });
};

db.transaction(() => {
  for (const [relDir, n] of dirs) {
    for (let i = 0; i < n; i++) put(relDir, `img${i}.png`);
  }
});

console.log('=== 递归目录口径(离线合成数据) ===');
const total = (q: Record<string, unknown>) => db.queryImages({ ...q, limit: 1 } as never).total;

const cases: Array<[string, Record<string, unknown>, number]> = [
  ['A 精确', { relDir: 'A' }, 1],
  ['A 递归(1 + 2 + 3 + 5)', { relDir: 'A', relDirRecursive: true }, 11],
  [`A\\B 精确`, { relDir: 'A\\B' }, 2],
  [`A\\B 递归(2 + 3)`, { relDir: 'A\\B', relDirRecursive: true }, 5],
  [`A\\B\\C 精确`, { relDir: 'A\\B\\C' }, 3],
  [`A\\B\\C 递归(只有自己)`, { relDir: 'A\\B\\C', relDirRecursive: true }, 3],
  ['AB 精确', { relDir: 'AB' }, 7],
  ['AB 递归不包含 A/**', { relDir: 'AB', relDirRecursive: true }, 7],
  ['A2 精确', { relDir: 'A2' }, 11],
  ['A2 递归不包含 A/**', { relDir: 'A2', relDirRecursive: true }, 11],
  ['A 递归不吃掉 AB / A2', { relDir: 'A', relDirRecursive: true }, 11],
  ['relDir = null 视为不过滤', { relDir: null }, 29],
  ['relDir = "" 视为不过滤', { relDir: '' }, 29],
];

for (const [label, q, expect] of cases) {
  const got = total(q);
  if (got === expect) good(`${label} -> ${got} 张`);
  else bad(`${label}:期望 ${expect} 张,实际 ${got} 张`);
}

// 目录名里带 LIKE 元字符(% 和 _)也要安全
{
  put('100%_raw', 'x.png');
  const exact = total({ relDir: '100%_raw' });
  const rec = total({ relDir: '100%_raw', relDirRecursive: true });
  if (exact === 1 && rec === 1) good('目录名里的 % 和 _ 不会被当成通配符');
  else bad(`LIKE 转义没生效:精确 ${exact} / 递归 ${rec}(都应为 1)`);
  const wildcard = total({ relDir: '100', relDirRecursive: true });
  if (wildcard === 0) good('relDir = "100" 不会匹配到 "100%_raw"');
  else bad(`relDir = "100" 误匹配了 ${wildcard} 张`);
}

db.close();
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 临时目录删不掉无所谓 */
}

console.log('\n' + (failures === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${failures} 项)`));
process.exit(failures === 0 ? 0 : 1);
