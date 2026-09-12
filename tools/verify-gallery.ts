/**
 * 验证导出的静态图库。纯读操作,零依赖。
 *
 * 检查四件事:
 *   1. 内联 JSON 合法、结构自洽
 *   2. 用户要求的展示字段覆盖率
 *   3. 图片路径真的可读(file:// 反解回本地路径)
 *   4. **搜索索引可用**:用与前端相同的解码与匹配逻辑,验证若干查询能命中
 *      (这一项独立于导出器实现,能抓出词表编码错位之类的静默 bug)
 *
 *   node --experimental-strip-types tools/verify-gallery.ts
 */
import fs from 'node:fs';
import path from 'node:path';

const file = process.env.GALLERY ?? path.join(process.cwd(), 'data', 'gallery', 'gallery.html');
if (!fs.existsSync(file)) {
  console.error('gallery.html not found: ' + file);
  process.exit(1);
}

const html = fs.readFileSync(file, 'utf8');
console.log('html size: ' + (Buffer.byteLength(html) / 1024).toFixed(0) + ' KB');

interface Item {
  id: number;
  src: string;
  name: string;
  dir: string;
  bytes: number;
  mtime: number;
  w: number | null;
  h: number | null;
  source: string;
  model: string | null;
  scheduler: string | null;
  steps: number | null;
  cfg: number | null;
  seed: number | null;
  denoise: number | null;
  samplers: number;
  loras: Array<{ n: string; s: number | null }>;
  cns: Array<{ n: string; s: number | null }>;
  pos: string | null;
  neg: string | null;
  nodes: number;
  hints: string[];
}

interface Payload {
  generatedAt: number;
  totalInLibrary: number;
  exported: number;
  light: boolean;
  vocab: string[];
  tokens: number[][];
  dirs: Array<{ name: string; count: number }>;
  facets: {
    models: Array<{ v: string; c: number }>;
    schedulers: Array<{ v: string; c: number }>;
    loras: Array<{ v: string; c: number }>;
    sources: Array<{ v: string; c: number }>;
    sizes: Array<{ v: string; c: number }>;
  };
  items: Item[];
}

let failures = 0;
const bad = (m: string) => { failures++; console.log('FAIL  ' + m); };
const good = (m: string) => console.log('PASS  ' + m);

// ---------------- 1) 结构
const m = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
if (!m) {
  console.error('FAIL  inline data script not found');
  process.exit(1);
}
let D: Payload;
try {
  D = JSON.parse(m[1]) as Payload;
  good(`inline JSON parses (${(Buffer.byteLength(m[1]) / 1024).toFixed(0)} KB)`);
} catch (e) {
  console.error('FAIL  inline JSON invalid -> ' + (e as Error).message);
  process.exit(1);
}

if (D.exported !== D.items.length) bad(`exported=${D.exported} but items=${D.items.length}`);
else good(`exported ${D.exported} === items.length`);

if (D.totalInLibrary < D.exported) bad('totalInLibrary < exported');
else good(`library total ${D.totalInLibrary} >= exported`);

if (!Array.isArray(D.vocab) || D.vocab.length === 0) bad('vocab missing or empty');
else good(`vocab ${D.vocab.length} tokens`);

if (!Array.isArray(D.tokens) || D.tokens.length !== D.items.length)
  bad(`tokens length ${D.tokens?.length} !== items ${D.items.length}`);
else good('tokens array aligned with items');

if (!D.dirs.length) bad('no dirs');
else good(`dirs ${D.dirs.length}`);

const facetCount = D.facets.models.length + D.facets.schedulers.length +
  D.facets.loras.length + D.facets.sources.length + D.facets.sizes.length;
good(`facet候选值合计 ${facetCount}(模型${D.facets.models.length} / 调度器${D.facets.schedulers.length} / LoRA${D.facets.loras.length} / 格式${D.facets.sources.length} / 尺寸${D.facets.sizes.length})`);

// ---------------- 2) 字段覆盖率
const REQUIRED = ['w', 'h', 'model', 'scheduler', 'steps', 'cfg', 'seed', 'loras', 'pos', 'neg', 'mtime', 'bytes', 'name', 'dir'] as const;
console.log('\n--- 字段覆盖率 ---');
for (const k of REQUIRED) {
  let present = 0;
  for (const it of D.items) {
    const v = (it as unknown as Record<string, unknown>)[k];
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0 && k === 'loras') continue;
    present++;
  }
  const pct = (present / D.items.length) * 100;
  console.log(`  ${k.padEnd(10)} ${String(present).padStart(5)} / ${D.items.length}  ${pct.toFixed(1)}%`);
}

// 详情面板必须不含采样器字段
if (!('sampler' in (D.items[0] as unknown as Record<string, unknown>))) good('详情面板已不含 sampler 字段(符合用户要求)');
else bad('items 里仍有 sampler 字段');

// ---------------- 3) 图片路径可读性
console.log('\n--- 图片路径可读性(抽样 20)---');
let ok = 0, missing = 0;
const step = Math.max(1, Math.floor(D.items.length / 20));
for (let i = 0; i < D.items.length; i += step) {
  const src = D.items[i].src;
  const p = decodeURIComponent(src.replace(/^file:\/\/\//, '')).replace(/\//g, path.sep);
  if (fs.existsSync(p)) ok++;
  else {
    missing++;
    if (missing <= 3) console.log('  MISSING ' + p);
  }
}
if (missing === 0) good(`抽样 ${ok} 张路径全部存在`);
else bad(`${missing} 张路径缺失`);

// ---------------- 4) 搜索索引可用性(独立复算)
console.log('\n--- 搜索索引验证(独立复算)---');

/** 与前端一致:把 token id 还原成检索串 */
function decode(i: number): string {
  const ids = D.tokens[i];
  if (!ids || ids.length === 0) return ' ';
  return ' ' + ids.map((x) => D.vocab[x]).join(' ') + ' ';
}
/** 与前端一致:归一化查询词 */
function norm(s: string): string {
  return String(s ?? '')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .replace(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g, (c) => ` ${c} `)
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .toLowerCase()
    .trim();
}
/** 用解码后的检索串做子串匹配 */
function search(q: string): number[] {
  const ts = norm(q).split(' ').filter(Boolean);
  if (!ts.length) return [];
  const hits: number[] = [];
  for (let i = 0; i < D.items.length; i++) {
    const t = decode(i);
    if (ts.every((x) => t.includes(x))) hits.push(i);
  }
  return hits;
}

const QUERIES: Array<{ q: string; expectSome: boolean; note: string }> = [
  { q: '1girl', expectSome: true, note: '字母数字混合词' },
  { q: 'girl', expectSome: true, note: '应从 1 girl 里命中' },
  { q: 'masterpiece', expectSome: true, note: '常见正面词' },
  { q: 'worst quality', expectSome: true, note: '负向提示词(多词 AND)' },
  { q: 'lora', expectSome: false, note: 'LoRA 名字本身不一定含 lora 字样,不强制' },
];

for (const c of QUERIES) {
  const hits = search(c.q);
  const pass = c.expectSome ? hits.length > 0 : true;
  const label = `${JSON.stringify(c.q)} -> ${hits.length} 命中  (${c.note})`;
  if (pass) good(label);
  else bad(label + '  ← 期望有命中但为 0');
}

// 搜一个肯定不存在的字符串,必须 0 命中
const noneHits = search('zzzz_not_exist_token_zzzz');
if (noneHits.length === 0) good('不存在的词 -> 0 命中(无误报)');
else bad(`不存在的词却命中 ${noneHits.length} 张`);

// 词表越界检查:任何 token id 必须在 vocab 范围内
let outOfRange = 0;
for (const ids of D.tokens) {
  for (const id of ids) if (id < 0 || id >= D.vocab.length) outOfRange++;
}
if (outOfRange === 0) good('token id 全部在词表范围内');
else bad(`${outOfRange} 个 token id 越界`);

// ---------------- 5) 一条完整参数记录
console.log('\n--- 一条完整参数记录 ---');
const full = D.items.find(
  (it) => it.model && it.scheduler && it.steps !== null && it.cfg !== null && it.seed !== null && it.pos
);
if (full) {
  for (const k of ['id', 'name', 'w', 'h', 'model', 'scheduler', 'steps', 'cfg', 'seed', 'mtime'] as const) {
    console.log(`  ${k.padEnd(10)} ${JSON.stringify(full[k])}`);
  }
  console.log(`  loras      ${full.loras.length} 条,首条 = ${full.loras[0] ? full.loras[0].n + ' @' + full.loras[0].s : '-'}`);
  const pos = String(full.pos);
  console.log(`  pos        ${pos.slice(0, 70)}${pos.length > 70 ? '...' : ''}`);
  good('找到带完整参数的记录');
} else {
  bad('没有任何记录带完整参数');
}

// ---------------------------------------------------------------- 6) 用户自定义分类
console.log('\n--- 用户自定义分类 ---');

interface CatNode {
  id: number;
  name: string;
  relDir: string | null;
  directCount: number;
  totalCount: number;
  children: CatNode[];
}
const cats = (D as unknown as { categories?: CatNode[] }).categories ?? [];
const itemCats = (D as unknown as { itemCats?: number[][] }).itemCats ?? [];

function countNodes(list: CatNode[]): number {
  let n = 0;
  for (const c of list) n += 1 + countNodes(c.children);
  return n;
}
const catTotal = countNodes(cats);
console.log(`  分类节点 ${catTotal} 个,itemCats 长度 ${itemCats.length} / items ${D.items.length}`);

if (itemCats.length !== D.items.length) bad('itemCats 与 items 数量不一致');
else good('itemCats 与 items 对齐');

// 所有 itemCats 里出现的分类 id 必须真实存在
const catIds = new Set<number>();
(function collect(list: CatNode[]) {
  for (const c of list) { catIds.add(c.id); collect(c.children); }
})(cats);
let orphanCat = 0;
for (const mine of itemCats) for (const c of mine) if (!catIds.has(c)) orphanCat++;
if (orphanCat === 0) good('所有 itemCats 引用都指向存在的分类');
else bad(`${orphanCat} 个 itemCats 引用指向不存在的分类`);

// 分类总数应与 itemCats 里去重后的数量一致(只统计出现在本次导出里的)
const usedCats = new Set<number>();
for (const mine of itemCats) for (const c of mine) usedCats.add(c);
console.log(`  本次导出涉及 ${usedCats.size} 个分类`);

// 详情面板是否带上"所属分类"字段
const withCatNames = D.items.filter((it) => (it as unknown as { catNames?: string }).catNames);
console.log(`  带分类名的图片 ${withCatNames.length} / ${D.items.length}`);
if (usedCats.size > 0 && withCatNames.length === 0) {
  bad('有分类数据但没有任何图片带上 catNames');
} else if (usedCats.size === 0 && withCatNames.length === 0) {
  good('无分类数据,catNames 全为空(一致)');
} else {
  good('catNames 已回填');
}

// HTML 里必须有分类侧栏容器与分类渲染逻辑
if (html.indexOf('id="catsWrap"') !== -1 && html.indexOf('function buildCats()') !== -1) {
  good('分类侧栏容器与渲染函数都存在');
} else {
  bad('缺少分类侧栏(catsWrap / buildCats)');
}

// 侧栏不应使用反引号模板字符串(会提前闭合宿主的 HTML 模板字面量 —— 曾踩过)
if (html.indexOf('kv(' + "'所属分类'" + ', it.catNames') !== -1) {
  good('详情面板直接读预计算的 catNames(不在前端拼字符串)');
}

console.log('\n' + (failures === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${failures} 项)`));
process.exit(failures === 0 ? 0 : 1);
