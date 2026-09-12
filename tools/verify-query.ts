/**
 * Query path verification. Run with:
 *   node --experimental-strip-types tools/verify-query.ts
 */
import { AssetDb } from '../src/main/db.ts';

const file = process.env.CAM_DB;
if (!file) {
  console.error('set CAM_DB to the index database path');
  process.exit(1);
}

const db = new AssetDb(file);
const t = (label: string, fn: () => void) => {
  const t0 = Date.now();
  fn();
  console.log(`  ${label.padEnd(30)} ${Date.now() - t0}ms`);
};

console.log('indexed total: ' + db.count());

t('model filter', () => {
  const r = db.queryImages({ modelName: 'krea2_turbo_int8_convrot', limit: 1 });
  console.log(`      krea2_turbo_int8_convrot -> ${r.total}`);
});

t('exact dimension 1920x2560', () => {
  const r = db.queryImages({ minWidth: 1920, maxWidth: 1920, minHeight: 2560, maxHeight: 2560, limit: 1 });
  console.log(`      1920x2560 -> ${r.total}`);
});

t('source a1111', () => {
  const r = db.queryImages({ sources: ['a1111'], limit: 1 });
  console.log(`      a1111 -> ${r.total}`);
});

t('lora filter', () => {
  const f = db.getFilterOptions() as { loras: string[] };
  const r = db.queryImages({ loraName: f.loras[0], limit: 1 });
  console.log(`      ${f.loras[0]} -> ${r.total}`);
});

t('recursive dir anima', () => {
  const r = db.queryImages({ relDir: 'anima', relDirRecursive: true, limit: 1 });
  console.log(`      anima/** -> ${r.total}`);
});

t('full text latin', () => {
  const ids = db.searchIds('krea2', 9000);
  console.log(`      hits ${ids.length}`);
});

t('full text chinese', () => {
  const ids = db.searchIds('haitun', 9000);
  console.log(`      hits ${ids.length}`);
});

t('detail + siblings', () => {
  const s = db.getSiblings(4851, { sort: 'mtime_desc' });
  console.log(`      position ${s.position}/${s.total}, window ${s.ids.length}`);
});

t('stats', () => {
  const s = db.getStats() as { totalImages: number; topModels: unknown[] };
  console.log(`      ${s.totalImages} images, ${s.topModels.length} top models`);
});

t('folder tree', () => {
  const tree = db.getFolderTree() as Array<{ children: unknown[] }>;
  console.log(`      roots ${tree.length}`);
});

t('batch fetch 500', () => {
  const ids = db.searchIds('1girl', 500);
  const rows = db.getImagesByIds(Array.isArray(ids) ? ids : []);
  console.log(`      fetched ${rows.length}`);
});

t('paging offset 200', () => {
  const r = db.queryImages({ sort: 'mtime_desc', limit: 100, offset: 200 });
  console.log(`      page ids ${r.ids.length}/${r.total}`);
});

db.close();
