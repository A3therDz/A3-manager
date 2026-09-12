/**
 * 用户自定义分类功能验证。
 *
 * 全部进程内调用,不 spawn 子进程(沙箱禁止 pipe stdio)。
 * 在临时库上跑,不污染真实索引库。
 *
 *   node --experimental-strip-types tools\verify-category.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetDb } from '../src/main/db.ts';
import { scanLibrary } from '../src/main/indexer.ts';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_DB = process.env.CAM_DB ?? path.join(PROJECT, 'data', 'index.db');
const SRC = process.env.CAM_IMAGES ?? '<你的图库目录>';
const TMP_ROOT = path.join(PROJECT, 'data', 'cat-lib');
const TMP_DB = path.join(PROJECT, 'data', 'cat.db');

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (cond) console.log('  PASS  ' + msg);
  else {
    failures++;
    console.log('  FAIL  ' + msg);
  }
};

// ---------------------------------------------------------------- 准备临时库

fs.rmSync(TMP_ROOT, { recursive: true, force: true });
for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) fs.rmSync(f, { force: true });
fs.mkdirSync(TMP_ROOT, { recursive: true });

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.png$/i.test(e.name)) out.push(p);
    if (out.length >= 40) return out;
  }
  return out;
}

const pool = walk(SRC).filter((p) => {
  try { return fs.statSync(p).size < 6 * 1048576; } catch { return false; }
});
const picked = pool.slice(0, 8);
for (let i = 0; i < picked.length; i++) {
  const sub = i < 5 ? 'alpha' : path.join('beta', 'inner');
  const dir = path.join(TMP_ROOT, sub);
  fs.mkdirSync(dir, { recursive: true });
  // 故意让不同文件夹里的文件名可能重名(分类要能跨文件夹收图)
  fs.copyFileSync(picked[i], path.join(dir, path.basename(picked[i])));
}

console.log('分类功能验证');
console.log(`  临时图库  ${TMP_ROOT}  (${picked.length} 张,分布在 alpha\\ 与 beta\\inner\\)`);
console.log('');

{
  const db = new AssetDb(TMP_DB);
  db.addRoot(TMP_ROOT);
  scanLibrary(db, { force: true });
  console.log(`索引: ${db.count()} 张\n`);
  db.close();
}

const db = new AssetDb(TMP_DB);
const allIds = (db.getImagesByIds(
  (db.db.prepare('SELECT id FROM images ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id)
) as Array<{ id: number; relDir: string }>);

const alphaIds = allIds.filter((r) => r.relDir === 'alpha').map((r) => r.id);
const betaIds = allIds.filter((r) => r.relDir.startsWith('beta')).map((r) => r.id);
console.log(`alpha ${alphaIds.length} 张 / beta\\inner ${betaIds.length} 张\n`);

// ---------------------------------------------------------------- 1) 创建分类

console.log('--- 1) 创建分类 ---');
const catA = db.createCategory({ name: '精选', description: '手动挑出来的' });
check(catA.id > 0, `创建顶层分类 ok (id=${catA.id})`);
check(catA.parentId === null, '顶层分类 parentId = null');
check(catA.sortOrder === 0, `首个分类 sortOrder = 0 (实际 ${catA.sortOrder})`);

const catB = db.createCategory({ name: '场景' });
check(catB.sortOrder === 1, `同级追加 sortOrder 递增 (实际 ${catB.sortOrder})`);

const catChild = db.createCategory({ name: '风景', parentId: catB.id });
check(catChild.parentId === catB.id, '子分类 parentId 正确');

const catGrand = db.createCategory({ name: '夜景', parentId: catChild.id });
check(catGrand.parentId === catChild.id, '三级嵌套 ok');

// 绑定到文件夹的分类
const catFolder = db.createCategory({ name: 'alpha 文件夹', relDir: 'alpha', rootId: 1 });
check(catFolder.relDir === 'alpha', '可绑定到源文件夹 (relDir=alpha)');

// 重名应被拒绝
let dupErr = '';
try { db.createCategory({ name: '精选' }); } catch (e) { dupErr = (e as Error).message; }
check(dupErr.includes('同名'), `同级重名被拒绝 (${dupErr})`);

// ---------------------------------------------------------------- 2) 组成员

console.log('\n--- 2) 分类成员 ---');
const n1 = db.setCategoryMembers(catA.id, alphaIds, true);
check(n1 === alphaIds.length, `加入 ${n1} 张到「精选」`);

// 同一张图可以进多个分类
const n2 = db.setCategoryMembers(catChild.id, betaIds, true);
check(n2 === betaIds.length, `加入 ${n2} 张到「风景」`);

// 跨文件夹:把 beta 的图也加进「精选」
const cross = db.setCategoryMembers(catA.id, betaIds.slice(0, 2), true);
check(cross === 2, `跨文件夹收图 ok (新增 ${cross})`);

// 重复加入应是幂等的
const again = db.setCategoryMembers(catA.id, alphaIds, true);
check(again === 0, `重复加入是幂等的 (变化 ${again})`);

// 移出
const removed = db.setCategoryMembers(catA.id, alphaIds.slice(0, 1), false);
check(removed === 1, `移出 1 张 ok`);

// ---------------------------------------------------------------- 3) 分类树与计数

console.log('\n--- 3) 分类树与计数 ---');
const tree = db.getCategoryTree();
const names = tree.map((c) => c.name);
check(names.includes('精选') && names.includes('场景'), `顶层分类: ${names.join(', ')}`);

const scene = tree.find((c) => c.name === '场景')!;
check(scene.children.length === 1 && scene.children[0].name === '风景', '「场景」下有「风景」');
const scenery = scene.children[0];
check(scenery.children.length === 1 && scenery.children[0].name === '夜景', '「风景」下有「夜景」');

// totalCount 应自底向上累计
check(
  scene.totalCount === scenery.totalCount,
  `父分类 totalCount 含子分类 (场景 ${scene.totalCount} == 风景 ${scenery.totalCount})`
);
check(scenery.totalCount === betaIds.length, `「风景」成员数 = beta 张数 (${scenery.totalCount}/${betaIds.length})`);

// ---------------------------------------------------------------- 4) 按分类查询

console.log('\n--- 4) 按分类筛选图片 ---');
const qSel = db.queryImages({ categoryId: catA.id, limit: 100 });
const expectSel = alphaIds.length - 1 + 2; // 移出 1 张,加入 2 张
check(qSel.total === expectSel, `「精选」查询到 ${qSel.total} 张 (期望 ${expectSel})`);

// 递归:查父分类应包含子分类成员
const qScene = db.queryImages({ categoryId: catB.id, limit: 100 });
check(qScene.total === betaIds.length, `查父分类「场景」递归含子分类成员 (${qScene.total}/${betaIds.length})`);

// 非递归:父分类自身没有直接成员
const qSceneDirect = db.queryImages({ categoryId: catB.id, categoryRecursive: false, limit: 100 });
check(qSceneDirect.total === 0, `非递归查「场景」自身成员为 0 (实际 ${qSceneDirect.total})`);

// 分类 + 其它条件组合
const qCombo = db.queryImages({ categoryId: catB.id, relDir: 'beta\\inner', limit: 100 });
check(qCombo.total === betaIds.length, `分类与 relDir 可组合 (${qCombo.total})`);

// 不存在的分类必须是空结果,而不是"不过滤"
const qNone = db.queryImages({ categoryId: 999999, limit: 100 });
check(qNone.total === 0, `不存在的分类返回空结果 (实际 ${qNone.total})`);

// ---------------------------------------------------------------- 5) 图片所属分类

console.log('\n--- 5) 反向查询:某张图属于哪些分类 ---');
const probeId = betaIds[0];
const cats = db.getImageCategories(probeId);
check(cats.includes(catChild.id) && cats.includes(catA.id), `图片 #${probeId} 属于 ${cats.length} 个分类`);

// ---------------------------------------------------------------- 6) 更新与移动

console.log('\n--- 6) 更新分类 / 移动层级 ---');
const renamed = db.updateCategory(catA.id, { name: '精选合集', description: '改过描述' });
check(renamed.name === '精选合集' && renamed.description === '改过描述', '重命名与改描述 ok');

// 移动到 catB 下
const moved = db.updateCategory(catA.id, { parentId: catB.id });
check(moved.parentId === catB.id, '移动层级 ok');

// 不能移到自己后代下(防环)
let cycleErr = '';
try { db.updateCategory(catB.id, { parentId: catGrand.id }); } catch (e) { cycleErr = (e as Error).message; }
check(cycleErr.includes('子分类'), `防止成环 (${cycleErr})`);

// 不能以自己为父
let selfErr = '';
try { db.updateCategory(catB.id, { parentId: catB.id }); } catch (e) { selfErr = (e as Error).message; }
check(selfErr.includes('自己'), `防止自引用 (${selfErr})`);

// ---------------------------------------------------------------- 7) 排序

console.log('\n--- 7) 排序 ---');
db.updateCategory(catB.id, { sortOrder: 99 });
const tree2 = db.getCategoryTree();
const lastTop = tree2[tree2.length - 1];
check(lastTop.name === '场景', `sortOrder 生效,「场景」排到最后 (实际 ${lastTop.name})`);

// ---------------------------------------------------------------- 8) 删除

console.log('\n--- 8) 删除分类 ---');
// 8a) 子分类上提
const beforeCount = (db.db.prepare('SELECT COUNT(*) AS c FROM categories').get() as { c: number }).c;
db.deleteCategory(catChild.id, false);
const afterCount = (db.db.prepare('SELECT COUNT(*) AS c FROM categories').get() as { c: number }).c;
check(afterCount === beforeCount - 1, `只删自身,子分类上提 (${beforeCount} -> ${afterCount})`);
const nightAfter = db.getCategory(catGrand.id);
check(nightAfter !== null && nightAfter.parentId === catB.id, '「夜景」被上提到「场景」下');

// 8b) 连带删除子分类
db.createCategory({ name: '临时父' });
const tmpParent = db.getCategoryTree().find((c) => c.name === '临时父')!;
db.createCategory({ name: '临时子', parentId: tmpParent.id });
const beforeC2 = (db.db.prepare('SELECT COUNT(*) AS c FROM categories').get() as { c: number }).c;
db.deleteCategory(tmpParent.id, true);
const afterC2 = (db.db.prepare('SELECT COUNT(*) AS c FROM categories').get() as { c: number }).c;
check(afterC2 === beforeC2 - 2, `连带删除子分类 (${beforeC2} -> ${afterC2})`);

// 8c) 删除分类后成员关系应被清理,且图片本身不受影响
const imgCountBefore = db.count();
db.deleteCategory(catB.id, true);
const imgCountAfter = db.count();
check(imgCountAfter === imgCountBefore, `删除分类不影响图片 (${imgCountBefore} -> ${imgCountAfter})`);
const orphan = db.db
  .prepare('SELECT COUNT(*) AS c FROM category_images WHERE category_id = ?')
  .get(catB.id) as { c: number };
check(orphan.c === 0, '成员关系被级联清理');

// ---------------------------------------------------------------- 9) 持久化

console.log('\n--- 9) 持久化:重开库后分类还在 ---');
const remaining = db.getCategoryTree().length;
db.close();
{
  const db2 = new AssetDb(TMP_DB);
  const again2 = db2.getCategoryTree().length;
  check(again2 === remaining, `重开后分类数一致 (${remaining} -> ${again2})`);
  db2.close();
}

// ---------------------------------------------------------------- 清理并汇总

fs.rmSync(TMP_ROOT, { recursive: true, force: true });
for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) fs.rmSync(f, { force: true });

console.log('\n' + (failures === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${failures} 项)`));
console.log(`  真实索引库未受影响: ${fs.existsSync(REAL_DB) ? '仍在' : '不存在?'}`);
process.exit(failures === 0 ? 0 : 1);
