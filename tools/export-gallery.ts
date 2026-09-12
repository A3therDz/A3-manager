/**
 * 静态图库导出器 —— 零依赖,不需要 Electron / npm 安装。
 *
 * 为什么做这个:
 *  用户要的核心是"外面看到图片,点开看到全部参数"。在桌面外壳还装不上依赖之前,
 *  先用一个自包含的 HTML 把这件事完整交付:
 *  文件夹分类 + 全文搜索 + 参数筛选 + 缩略图网格 + 点击看完整参数。
 *
 * 关键设计:
 *  - 元数据全部内联,不依赖任何服务。
 *  - 每张图预计算 `t`(归一化检索文本),归一化规则与后端 db.ts 完全一致
 *    (字母/数字边界拆开、CJK 逐字拆开、小写),保证"在 CLI 里搜得到的东西,
 *    在图库里也搜得到"。
 *  - 图片用 file:// 绝对路径,所以本文件必须放在**源图片同一盘符**下。
 *    (file:// 页面无法读取其它盘符的本地文件,这是浏览器安全策略。)
 *
 * 用法:
 *   node --experimental-strip-types tools/export-gallery.ts [--out 目录] [--limit N] [--light]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AssetDb, normalizeForSearch } from '../src/main/db.ts';

const nodeRequire = createRequire(import.meta.url);
const { makeThumb } = nodeRequire('./thumbnail.cjs') as {
  makeThumb: (
    src: string,
    out: string,
    opt?: { max?: number; force?: boolean }
  ) => { out: string; cached: boolean; w?: number; h?: number; srcBytes?: number; outBytes: number; ms: number } | null;
};

function argVal(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const DB_FILE = process.env.CAM_DB ?? path.join(process.cwd(), 'data', 'index.db');
const OUT_DIR = argVal('out') ?? path.join(process.cwd(), 'data', 'gallery');
const LIMIT = Number(argVal('limit', '200'));
const SORT = argVal('sort', 'mtime_desc') as string;
/** 精简模式:丢掉 ControlNet / 节点数 / 提示,只保留核心参数 */
const LIGHT = process.argv.includes('--light');
/**
 * 使用真缩略图。默认开启。
 *
 * 为什么必须:ComfyUI 出图常 3~5MB,直接用原图当缩略图会让一屏上百张图吃掉数 GB 内存。
 * 缩略图由 tools/thumbnail.cjs 生成(纯 JS PNG 解码 + 中位切分量化),平均压缩约 140 倍。
 *
 * **位置约定**(与参考项目 Aaalice NAI Launcher 的 `.thumbs` 思路一致):
 * 缩略图存在**每个图库根目录内部**,而不是管理器目录里 —— 这样缓存跟着图库走,
 * 迁移/重装都不会失联。
 *   <图库根>\.comfy-thumbs\<相对路径>\<原名>.thumb.png
 *
 * 注意:导出**只消费缓存,不生成**。批量生成请先跑:
 *   node tools/thumb-sync.ts
 * 缺少缩略图的图自动回退原图(界面不空)。
 */
const THUMBS = !process.argv.includes('--no-thumbs');
const THUMB_DIRNAME = process.env.CAM_THUMB_DIRNAME ?? '.comfy-thumbs';

/** 与 thumb-sync.ts 必须保持一致的路径换算规则 */
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

// ---------------------------------------------------------------- 取数据

const { ids } = db.queryImages({ limit: LIMIT, sort: SORT });
const rootRows = db.listRoots() as Array<{ id: number; path: string }>;
const rootPathById = new Map(rootRows.map((r) => [r.id, r.path]));
const rows = (db.getImagesByIds(ids) as Array<Record<string, unknown>>).map((r) => ({
  ...(r as unknown as ImageRecordLite),
  rootPath: rootPathById.get((r as unknown as ImageRecordLite).rootId) ?? '',
}));

interface ImageRecordLite {
  id: number;
  rootId: number;
  relPath: string;
  absPath: string;
  relDir: string;
  fileName: string;
  fileSize: number;
  fileMtime: number;
  dimensions: { width: number; height: number } | null;
  source: string;
  starred: boolean;
  meta: {
    modelName: string | null;
    modelNodeType: string | null;
    loras: Array<{ name: string; strengthModel: number | null; strengthClip: number | null }>;
    controlNets: Array<{ name: string; strength: number | null }>;
    sampler: {
      seed: number | null;
      steps: number | null;
      cfg: number | null;
      samplerName: string | null;
      scheduler: string | null;
      denoise: number | null;
    } | null;
    allSamplers: unknown[];
    prompts: Array<{ role: string; text: string }>;
    nodeCount: number;
    customNodeHints: string[];
  } | null;
}

// ---------------------------------------------------------------- 组装前端数据

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
  /** 该工作流里的采样器数量(仅用于"多采样器工作流"快捷筛选) */
  samplers: number;
  loras: Array<{ n: string; s: number | null }>;
  cns: Array<{ n: string; s: number | null }>;
  pos: string | null;
  neg: string | null;
  nodes: number;
  hints: string[];
  /** 所属分类名(顿号连接);空串表示不属于任何分类。由宿主侧预计算,前端不拼装 */
  catNames: string;
  /** 归一化检索文本。仅用于导出时生成 token 词表,不写进 HTML(改由 payload.tokens 存) */
  t: string;
}

const t0 = Date.now();
let thumbCached = 0;
let thumbMissing = 0;

const items: Item[] = rows.map((r) => {
  const m = r.meta;
  const s = m?.sampler ?? null;
  const pos = m?.prompts.find((p) => p.role === 'positive')?.text ?? null;
  const neg = m?.prompts.find((p) => p.role === 'negative')?.text ?? null;
  const loras = (m?.loras ?? []).map((l) => ({ n: l.name, s: l.strengthModel }));

  let src = '';
  if (THUMBS && r.rootPath) {
    const outPath = thumbPathFor(r.rootPath, r.relPath);
    try {
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        thumbCached++;
        src = 'file:///' + outPath.replace(/\\/g, '/').replace(/#/g, '%23');
      } else {
        thumbMissing++;
      }
    } catch {
      thumbMissing++;
    }
  }
  if (!src) {
    src = 'file:///' + r.absPath.replace(/\\/g, '/').replace(/#/g, '%23').replace(/\?/g, '%3F');
  }

  return {
    id: r.id,
    src,
    name: r.fileName,
    dir: r.relDir || '(根目录)',
    bytes: r.fileSize,
    mtime: r.fileMtime,
    w: r.dimensions ? r.dimensions.width : null,
    h: r.dimensions ? r.dimensions.height : null,
    source: r.source,
    model: m?.modelName ?? null,
    scheduler: s?.scheduler ?? null,
    steps: s?.steps ?? null,
    cfg: s?.cfg ?? null,
    seed: s?.seed ?? null,
    denoise: s?.denoise ?? null,
    samplers: m?.allSamplers.length ?? 0,
    loras,
    cns: LIGHT ? [] : (m?.controlNets ?? []).map((c) => ({ n: c.name, s: c.strength })),
    pos,
    neg,
    nodes: LIGHT ? 0 : (m?.nodeCount ?? 0),
    hints: LIGHT ? [] : (m?.customNodeHints ?? []),
    // 分类名在下面拿到 category_images 之后回填(见"用户自定义分类"一节)
    catNames: '',
    // 检索文本:文件名 + 文件夹 + 模型 + 调度器 + LoRA + 正负提示词
    t: normalizeForSearch(
      [
        r.fileName,
        r.relDir,
        m?.modelName ?? '',
        s?.scheduler ?? '',
        ...loras.map((l) => l.n),
        pos ?? '',
        neg ?? '',
      ].join(' \n ')
    ),
  };
});

const thumbMs = Date.now() - t0;
void thumbMs;
// ---------------------------------------------------------------- 筛选候选与统计

const tally = (pick: (it: Item) => string | null | undefined): Array<{ v: string; c: number }> => {
  const m = new Map<string, number>();
  for (const it of items) {
    const v = pick(it);
    if (!v) continue;
    m.set(v, (m.get(v) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([v, c]) => ({ v, c }))
    .sort((a, b) => b.c - a.c || a.v.localeCompare(b.v));
};

const dirCount = new Map<string, number>();
for (const it of items) dirCount.set(it.dir, (dirCount.get(it.dir) ?? 0) + 1);

// ---------------------------------------------------------------- 用户自定义分类
//
// 分类是索引层的集合归属,与"源文件夹"是两套并存机制(见 db.ts 的表注释)。
// 导出时带上分类树 + 每张图所属的分类 id,前端就能:
//   - 侧边栏按分类筛选(与按文件夹并列)
//   - 卡片上显示分类标记
//   - 详情面板显示"属于哪些分类"

interface CategoryNodeOut {
  id: number;
  name: string;
  relDir: string | null;
  directCount: number;
  totalCount: number;
  children: CategoryNodeOut[];
}

const rawTree = db.getCategoryTree() as unknown as Array<Record<string, unknown>>;
function toCatOut(n: Record<string, unknown>): CategoryNodeOut {
  return {
    id: n.id as number,
    name: n.name as string,
    relDir: (n.relDir as string | null) ?? null,
    directCount: (n.directCount as number) ?? 0,
    totalCount: (n.totalCount as number) ?? 0,
    children: ((n.children as Array<Record<string, unknown>>) ?? []).map(toCatOut),
  };
}
const categoryTree = rawTree.map(toCatOut);

/** imageId -> 所属分类 id 列表(只含本次导出的图) */
const catsByImageId = new Map<number, number[]>();
{
  const ids = items.map((i) => i.id);
  const CHUNK = 900; // 避免 SQL 变量数超限
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const rows = db.db
      .prepare(
        `SELECT image_id AS img, category_id AS cat FROM category_images
         WHERE image_id IN (${slice.map(() => '?').join(',')})
         ORDER BY category_id`
      )
      .all(...slice) as Array<{ img: number; cat: number }>;
    for (const r of rows) {
      if (!catsByImageId.has(r.img)) catsByImageId.set(r.img, []);
      catsByImageId.get(r.img)!.push(r.cat);
    }
  }
}
const flatCats = new Map<number, string>();
(function flatten(list: CategoryNodeOut[]) {
  for (const c of list) {
    flatCats.set(c.id, c.name);
    flatten(c.children);
  }
})(categoryTree);

// 回填每张图的分类名(详情面板直接读,前端不拼字符串)
for (let i = 0; i < items.length; i++) {
  const mine = catsByImageId.get(items[i].id);
  if (mine && mine.length) {
    items[i].catNames = mine.map((c) => flatCats.get(c) ?? '#' + c).join('、');
  }
}

/**
 * 检索文本用**词表编码**存储。
 *
 * 直接内联每张图的归一化检索串会让导出从 17MB 涨到 30MB,因为 "1girl"、
 * "masterpiece" 这类词在几千张图里重复出现。
 * 做法:全局建词表(词 -> 整数 id),每张图只存 id 数组,前端解码后拼回字符串。
 * 重复词只存一次,体积回到接近未加搜索时的水平。
 */
const vocabMap = new Map<string, number>();
const vocab: string[] = [];
const encodedTokens: number[][] = [];
for (const it of items) {
  const toks = it.t.split(' ').filter(Boolean);
  const arr: number[] = [];
  for (const tk of toks) {
    let id = vocabMap.get(tk);
    if (id === undefined) {
      id = vocab.length;
      vocab.push(tk);
      vocabMap.set(tk, id);
    }
    arr.push(id);
  }
  encodedTokens.push(arr);
}

const payload = {
  generatedAt: Date.now(),
  totalInLibrary: total,
  exported: items.length,
  light: LIGHT,
  dbFile: DB_FILE,
  /** 检索词表:前端用它把每张图的 token id 还原成词 */
  vocab,
  dirs: [...dirCount.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  facets: {
    models: tally((it) => it.model),
    schedulers: tally((it) => it.scheduler),
    loras: tally((it) => it.loras[0]?.n ?? null).slice(0, 200),
    sources: tally((it) => it.source),
    sizes: tally((it) => (it.w && it.h ? `${it.w}x${it.h}` : null)),
  },
  /** 与 items 同序的检索 token id 数组(替代内联检索串,省一半体积) */
  tokens: encodedTokens,
  /** 用户自定义分类树 */
  categories: categoryTree,
  /** 与 items 同序:每张图所属的分类 id 列表(空数组=不属于任何分类) */
  itemCats: items.map((it) => catsByImageId.get(it.id) ?? []),
  items: items.map((it) => {
    // t 已编码进 payload.tokens,这里去掉以省体积
    const { t, ...rest } = it;
    void t;
    return rest;
  }),
};

// ---------------------------------------------------------------- 生成 HTML

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>ComfyUI 资产图库(导出快照)</title>
<style>
  :root{
    --bg:#0f1115; --panel:#161b22; --panel2:#1c2128; --border:#21262d; --fg:#e6e8eb;
    --muted:#7d8590; --accent:#58a6ff; --ok:#3fb950; --warn:#d29922; --bad:#f85149;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:13px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;height:100vh;display:flex;flex-direction:column;overflow:hidden}
  header{padding:8px 14px;border-bottom:1px solid var(--border);flex-shrink:0}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  h1{font-size:14px;margin:0;font-weight:600;white-space:nowrap}
  .m{color:var(--muted);font-size:12px}
  input[type=search],select{
    background:var(--panel);border:1px solid var(--border);color:var(--fg);border-radius:6px;
    padding:5px 9px;font:inherit;font-size:12px;outline:none}
  input[type=search]{flex:1;min-width:220px;max-width:420px}
  input[type=search]:focus,select:focus{border-color:var(--accent)}
  select{cursor:pointer;max-width:190px}
  button.btn{background:var(--panel);border:1px solid var(--border);color:var(--fg);
    border-radius:6px;padding:5px 10px;font:inherit;font-size:12px;cursor:pointer}
  button.btn:hover{border-color:var(--accent);color:var(--accent)}
  .chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  .chip{background:var(--panel);border:1px solid var(--border);border-radius:999px;
    padding:3px 10px;font-size:11px;cursor:pointer;color:var(--muted);white-space:nowrap}
  .chip:hover{border-color:var(--accent);color:var(--accent)}
  .chip.on{background:#1f6feb26;border-color:var(--accent);color:var(--accent)}
  main{flex:1;display:flex;min-height:0}
  aside{width:236px;flex-shrink:0;border-right:1px solid var(--border);overflow:auto;padding:6px 0}
  aside .h{color:var(--muted);font-size:10px;text-transform:uppercase;padding:8px 14px 4px;letter-spacing:.6px}
  aside button{display:block;width:100%;text-align:left;background:none;border:0;color:var(--fg);
    padding:4px 14px;cursor:pointer;font:inherit;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  aside button:hover{background:#1f242c}
  aside button.on{background:#1f6feb26;color:var(--accent);box-shadow:inset 2px 0 0 var(--accent)}
  aside button .c{color:var(--muted);float:right;font-size:11px}
  #grid-wrap{flex:1;overflow:auto;padding:12px}
  #grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:10px}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:8px;overflow:hidden;
    cursor:pointer;transition:border-color .12s,transform .12s}
  .card:hover{border-color:var(--accent);transform:translateY(-1px)}
  .card img{width:100%;height:176px;object-fit:cover;display:block;background:#0b0e13}
  .card .meta{padding:6px 8px}
  .card .nm{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted)}
  .card .pr{font-size:11px;color:#8b949e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
  .card .badges{display:flex;gap:4px;margin-top:4px;flex-wrap:wrap}
  .b{font-size:10px;padding:1px 5px;border-radius:3px;background:#21262d;color:var(--muted)}
  .b.lora{background:#1f6feb22;color:#79c0ff}
  .b.dim{background:#3fb95022;color:#7ee787}
  .b.cat{background:#8957e522;color:#d2a8ff}
  #empty{color:var(--muted);padding:48px;text-align:center}
  #detail{width:520px;flex-shrink:0;border-left:1px solid var(--border);overflow:auto;display:none}
  #detail.on{display:block}
  #detail .head{position:sticky;top:0;background:var(--panel);border-bottom:1px solid var(--border);
    padding:9px 13px;display:flex;justify-content:space-between;align-items:center;gap:8px;z-index:2}
  #detail .head .t{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #detail .head button{background:var(--panel2);border:1px solid var(--border);color:var(--fg);
    border-radius:5px;padding:3px 9px;cursor:pointer;font:inherit;font-size:12px}
  #detail .head button:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
  #detail .head button:disabled{opacity:.35;cursor:default}
  #detail .body{padding:12px 13px}
  #detail img.big{width:100%;border-radius:6px;background:#0b0e13;margin-bottom:12px}
  .sec{margin-bottom:14px}
  .sec h3{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin:0 0 6px;font-weight:600}
  table.kv{border-collapse:collapse;width:100%}
  table.kv td{padding:3px 0;vertical-align:top;border-bottom:1px solid #1c2128}
  table.kv td.k{color:var(--muted);width:84px;white-space:nowrap}
  table.kv td.v{font-family:ui-monospace,Consolas,monospace;word-break:break-all}
  .miss{color:var(--warn)}
  .p{background:#0b0e13;border:1px solid var(--border);border-radius:6px;padding:8px;
    font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.55;
    white-space:pre-wrap;word-break:break-word;max-height:230px;overflow:auto}
  .p.neg{color:#ffa8a8}
  .loraline{display:flex;justify-content:space-between;gap:8px;
    font-family:ui-monospace,Consolas,monospace;font-size:11px;padding:2px 0;border-bottom:1px solid #1c2128}
  .loraline .st{color:var(--accent);flex-shrink:0}
  .hint{color:var(--warn);font-size:11px;padding:2px 0}
  mark{background:#d2992240;color:inherit;border-radius:2px}
</style>
</head>
<body>
<header>
  <div class="row" style="margin-bottom:8px">
    <h1>ComfyUI 资产图库</h1>
    <input type="search" id="q" placeholder="搜索:文件名 / 提示词 / 模型 / LoRA / 文件夹…">
    <select id="fModel"><option value="">全部模型</option></select>
    <select id="fSched"><option value="">全部调度器</option></select>
    <select id="fLora"><option value="">全部 LoRA</option></select>
    <select id="fSize"><option value="">全部尺寸</option></select>
    <select id="fSource"><option value="">全部格式</option></select>
    <select id="sort">
      <option value="mtime_desc">最新优先</option>
      <option value="mtime_asc">最早优先</option>
      <option value="name_asc">名称 A→Z</option>
      <option value="size_desc">体积从大到小</option>
      <option value="w_desc">宽高从大到小</option>
    </select>
    <button class="btn" id="reset">重置</button>
  </div>
  <div class="chips">
    <span class="chip" data-quick="hasLora">有 LoRA</span>
    <span class="chip" data-quick="noModel">缺模型</span>
    <span class="chip" data-quick="noParam">无任何参数</span>
    <span class="chip" data-quick="multiSampler">多采样器工作流</span>
    <span class="chip" data-quick="big">≥1920 宽</span>
    <span class="chip" data-quick="today">近 7 天</span>
    <span class="m" id="stat" style="margin-left:auto"></span>
  </div>
</header>
<main>
  <aside>
    <div id="catsWrap" style="display:none">
      <div class="h">分类</div>
      <div id="cats"></div>
    </div>
    <div class="h">文件夹</div>
    <div id="dirs"></div>
  </aside>
  <div id="grid-wrap">
    <div id="grid"></div>
    <div id="empty" style="display:none">没有匹配的图片 —— 试着清空搜索或点「重置」</div>
  </div>
  <div id="detail"></div>
</main>
<script id="data" type="application/json">${JSON.stringify(payload).replace(
  /[<>&\u2028\u2029]/g,
  (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
)}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const $ = (s) => document.querySelector(s);

// 把词表编码的 token 还原成检索串,挂到每张图上。
// 用空格而不是空串连接:保证 "1girl" 不会和相邻词黏成 "x1girl" 影响子串匹配。
{
  const v = D.vocab || [];
  for (let i = 0; i < D.items.length; i++) {
    const ids = D.tokens && D.tokens[i];
    D.items[i].t = ids && ids.length
      ? ' ' + ids.map((x) => v[x]).join(' ') + ' '
      : ' ';
  }
}

// ---- 与后端一致的检索归一化(字母/数字边界拆开 + CJK 逐字拆开 + 小写)
function norm(s){
  return String(s == null ? '' : s)
    .replace(/([a-zA-Z])(\\d)/g, '$1 $2')
    .replace(/(\\d)([a-zA-Z])/g, '$1 $2')
    .replace(/[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af]/g, function(c){ return ' ' + c + ' '; })
    .replace(/[^\\p{L}\\p{N}_]+/gu, ' ')
    .toLowerCase()
    .trim();
}
function tokens(s){ return norm(s).split(' ').filter(Boolean); }

// 分类 id -> 名称(卡片标记与详情面板用)
const catNameById = new Map();
(function flat(node){
  catNameById.set(node.id, node.name);
  for (const c of node.children || []) flat(c);
})({ id: 0, children: D.categories || [] });

// 图片 id -> 在 D.items 里的下标。
// D.itemCats 是按下标索引的,而详情面板拿到的是 it.id,需要转换。
// 用 Map 而不是 indexOf:8061 张时 indexOf 是 O(n),每次开详情都要扫一遍。
const indexById = new Map();
for (let i = 0; i < D.items.length; i++) indexById.set(D.items[i].id, i);

// ---- 状态
const state = {
  q: '', dir: null, model: '', sched: '', lora: '', size: '', source: '',
  /** 当前选中的用户自定义分类 id;null = 不按分类过滤 */
  cat: null,
  sort: 'mtime_desc', quick: new Set(),
};

// ---- 格式化
const fmtBytes = (n) => n < 1024 ? n + ' B'
  : n < 1048576 ? (n/1024).toFixed(1) + ' KB'
  : n < 1073741824 ? (n/1048576).toFixed(2) + ' MB'
  : (n/1073741824).toFixed(2) + ' GB';
const fmtDate = (ms) => {
  const d = new Date(ms), p = (x) => String(x).padStart(2,'0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// ---- 初始化下拉
function fillSelect(sel, list, label){
  const el = $(sel);
  for (const x of list) {
    const o = document.createElement('option');
    o.value = x.v;
    o.textContent = x.v + '  (' + x.c + ')';
    el.appendChild(o);
  }
}
fillSelect('#fModel', D.facets.models);
fillSelect('#fSched', D.facets.schedulers);
fillSelect('#fLora', D.facets.loras);
fillSelect('#fSize', D.facets.sizes);
fillSelect('#fSource', D.facets.sources);

// ---- 侧栏:分类(索引层集合)+ 文件夹(磁盘结构)两套并列
const catsEl = $('#cats');
const dirsEl = $('#dirs');

/** 收集某分类节点的所有后代 id(用于递归筛选) */
function catWithDescendants(node){
  const out = [node.id];
  for (const c of node.children || []) out.push(...catWithDescendants(c));
  return out;
}
// 预计算每个分类的"含后代"id 列表,避免每次筛选都递归
const catDescendById = new Map();
(function pre2(node){
  catDescendById.set(node.id, catWithDescendants(node));
  for (const c of node.children || []) pre2(c);
})({ id: 0, children: D.categories || [] });

function buildCats(){
  const wrap = $('#catsWrap');
  if (!D.categories || !D.categories.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  catsEl.innerHTML = '';

  // 统计:每个分类在整个导出集中实际有多少张(而不是数据库里的成员总数)
  const inExport = new Map();
  D.itemCats.forEach((ids) => { for (const id of ids) inExport.set(id, (inExport.get(id) || 0) + 1); });
  // 递归累计:父分类数字包含子分类
  const rollup = new Map();
  const accum = (node) => {
    let n = inExport.get(node.id) || 0;
    for (const c of node.children || []) n += accum(c);
    rollup.set(node.id, n);
    return n;
  };
  for (const c of D.categories) accum(c);

  const mk = (node, depth) => {
    const b = document.createElement('button');
    b.innerHTML = '<span class="c">' + (rollup.get(node.id) || 0) + '</span>' +
      esc(node.name) + (node.relDir ? '<span class="c" style="float:none;margin-left:6px">·文件夹</span>' : '');
    b.dataset.cat = String(node.id);
    b.style.paddingLeft = (14 + depth * 12) + 'px';
    b.onclick = () => { state.cat = state.cat === node.id ? null : node.id; paint(); };
    return b;
  };
  const walk = (list, depth) => {
    for (const n of list) {
      catsEl.appendChild(mk(n, depth));
      if (n.children && n.children.length) walk(n.children, depth + 1);
    }
  };
  const all = document.createElement('button');
  all.innerHTML = '<span class="c">' + D.items.length + '</span>全部分类';
  all.dataset.cat = 'all';
  all.onclick = () => { state.cat = null; paint(); };
  catsEl.appendChild(all);
  walk(D.categories, 1);
}

function buildDirs(){
  dirsEl.innerHTML = '';
  const mk = (label, count, dir) => {
    const b = document.createElement('button');
    b.innerHTML = '<span class="c">' + count + '</span>' + esc(label);
    b.dataset.dir = String(dir);
    b.onclick = () => { state.dir = dir; paint(); };
    return b;
  };
  dirsEl.appendChild(mk('全部', D.items.length, null));
  for (const d of D.dirs) dirsEl.appendChild(mk(d.name, d.count, d.name));
}

// ---- 过滤 + 排序
function computeView(){
  const ts = tokens(state.q);
  const quick = state.quick;
  // 当前分类及其后代 id(递归包含子分类)
  const catIds = state.cat === null ? null : (catDescendById.get(state.cat) || [state.cat]);
  let arr = D.items.filter((it, idx) => {
    if (catIds) {
      const mine = D.itemCats[idx] || [];
      if (!mine.some((c) => catIds.indexOf(c) !== -1)) return false;
    }
    if (state.dir !== null && it.dir !== state.dir) return false;
    if (state.model && it.model !== state.model) return false;
    if (state.sched && it.scheduler !== state.sched) return false;
    if (state.size && !(it.w && it.h && (it.w + 'x' + it.h) === state.size)) return false;
    if (state.source && it.source !== state.source) return false;
    if (state.lora && !it.loras.some((l) => l.n === state.lora)) return false;
    // 子串匹配即可:归一化已把 CJK 拆成单字,所以 "女孩" 能命中,
    // 而 "girl" 也能命中 "1 girl"(字母数字边界已拆开)。
    if (ts.length && !ts.every((t) => it.t.indexOf(t) !== -1)) return false;
    if (quick.has('hasLora') && it.loras.length === 0) return false;
    if (quick.has('noModel') && it.model) return false;
    if (quick.has('noParam') && (it.model || it.steps !== null || it.cfg !== null)) return false;
    if (quick.has('multiSampler') && !(it.samplers > 1)) return false;
    if (quick.has('big') && !(it.w && it.w >= 1920)) return false;
    if (quick.has('today') && Date.now() - it.mtime > 7*86400000) return false;
    return true;
  });
  const by = state.sort;
  arr.sort((a, b) => {
    if (by === 'mtime_asc') return a.mtime - b.mtime;
    if (by === 'name_asc') return a.name.localeCompare(b.name, 'zh');
    if (by === 'size_desc') return b.bytes - a.bytes;
    if (by === 'w_desc') return ((b.w||0) * (b.h||0)) - ((a.w||0) * (a.h||0));
    return b.mtime - a.mtime;
  });
  return arr;
}

// ---- 渲染
let view = [];
let curIdx = -1;
function paint(){
  for (const b of dirsEl.querySelectorAll('button')) b.classList.toggle('on', b.dataset.dir === String(state.dir));
  for (const b of catsEl.querySelectorAll('button')) b.classList.toggle('on', b.dataset.cat === String(state.cat === null ? 'all' : state.cat));
  for (const c of document.querySelectorAll('.chip')) c.classList.toggle('on', state.quick.has(c.dataset.quick));

  view = computeView();
  const g = $('#grid');
  g.innerHTML = '';
  $('#empty').style.display = view.length ? 'none' : 'block';

  const frag = document.createDocumentFragment();
  view.forEach((it, idx) => {
    const c = document.createElement('div');
    c.className = 'card';
    const badges = [];
    if (it.w && it.h) badges.push('<span class="b dim">' + it.w + '×' + it.h + '</span>');
    if (it.loras.length) badges.push('<span class="b lora">' + it.loras.length + ' LoRA</span>');
    // 分类标记:让"集合归属"在网格里一眼可见
    const myCats = D.itemCats[idx] || [];
    for (const cid of myCats.slice(0, 2)) {
      const nm = catNameById.get(cid);
      if (nm) badges.push('<span class="b cat">' + esc(nm) + '</span>');
    }
    if (myCats.length > 2) badges.push('<span class="b cat">+' + (myCats.length - 2) + '</span>');
    c.innerHTML =
      '<img loading="lazy" src="' + it.src + '" title="' + esc(it.name) + '">' +
      '<div class="meta">' +
        '<div class="nm">' + esc(it.name) + '</div>' +
        '<div class="pr">' + (it.model ? esc(it.model) : '<span class="miss">无模型记录</span>') + '</div>' +
        (badges.length ? '<div class="badges">' + badges.join('') + '</div>' : '') +
      '</div>';
    c.onclick = () => open(idx);
    frag.appendChild(c);
  });
  g.appendChild(frag);

  $('#stat').textContent = '显示 ' + view.length + ' / 导出 ' + D.exported + ' 张 · 库内共 ' + D.totalInLibrary + ' 张' +
    (D.light ? ' · 精简模式' : '');
}

// ---- 详情面板
const det = $('#detail');
function kv(k, v, missing){
  return '<tr><td class="k">' + k + '</td><td class="v' + (missing ? ' miss' : '') + '">' + (missing ? '未记录' : esc(v)) + '</td></tr>';
}
function open(idx){
  if (idx < 0 || idx >= view.length) return;
  curIdx = idx;
  const it = view[idx];
  det.classList.add('on');

  const params = [
    kv('像素尺寸', it.w && it.h ? it.w + ' × ' + it.h : '', !(it.w && it.h)),
    kv('模型', it.model || '', !it.model),
    kv('调度器', it.scheduler || '', !it.scheduler),
    kv('步数', it.steps === null ? '' : String(it.steps), it.steps === null),
    kv('CFG', it.cfg === null ? '' : String(it.cfg), it.cfg === null),
    kv('seed', it.seed === null ? '' : String(it.seed), it.seed === null),
    it.denoise !== null && it.denoise !== undefined && it.denoise !== 1 ? kv('denoise', String(it.denoise), false) : '',
  ].join('');

  const file = [
    kv('文件名', it.name),
    kv('文件夹', it.dir),
    kv('大小', fmtBytes(it.bytes)),
    kv('生成日期', fmtDate(it.mtime)),
    kv('格式', it.source),
    kv('所属分类', it.catNames, it.catNames === ''),
    it.nodes ? kv('工作流节点', it.nodes + ' 个', false) : '',
  ].join('');

  const loras = it.loras.length
    ? it.loras.map((l) => '<div class="loraline"><span>' + esc(l.n) + '</span><span class="st">' +
        (l.s === null ? '?' : l.s) + '</span></div>').join('')
    : '<div class="miss">没有使用 LoRA</div>';

  const cns = it.cns.length
    ? '<div class="sec"><h3>ControlNet</h3>' + it.cns.map((c) =>
        '<div class="loraline"><span>' + esc(c.n) + '</span><span class="st">' + (c.s === null ? '?' : c.s) + '</span></div>').join('') + '</div>'
    : '';

  const hints = it.hints.length
    ? '<div class="sec"><h3>提示</h3>' + it.hints.map((h) => '<div class="hint">· ' + esc(h) + '</div>').join('') + '</div>'
    : '';

  det.innerHTML =
    '<div class="head">' +
      '<span class="t" title="' + esc(it.name) + '">' + esc(it.name) + '</span>' +
      '<span style="display:flex;gap:6px">' +
        '<button id="prev"' + (curIdx <= 0 ? ' disabled' : '') + '>←</button>' +
        '<button id="next"' + (curIdx >= view.length - 1 ? ' disabled' : '') + '>→</button>' +
        '<button id="close">关闭</button>' +
      '</span>' +
    '</div>' +
    '<div class="body">' +
      '<img class="big" src="' + it.src + '" alt="">' +
      '<div class="sec"><h3>采样参数</h3><table class="kv">' + params + '</table></div>' +
      '<div class="sec"><h3>文件信息</h3><table class="kv">' + file + '</table></div>' +
      '<div class="sec"><h3>LoRA (' + it.loras.length + ')</h3>' + loras + '</div>' +
      cns +
      '<div class="sec"><h3>正向提示词</h3><div class="p">' + (it.pos ? esc(it.pos) : '<span class="miss">未记录</span>') + '</div></div>' +
      '<div class="sec"><h3>负向提示词</h3><div class="p neg">' + (it.neg ? esc(it.neg) : '<span class="miss">未记录</span>') + '</div></div>' +
      hints +
    '</div>';

  $('#close').onclick = () => { det.classList.remove('on'); curIdx = -1; };
  const p = $('#prev'), n = $('#next');
  if (p) p.onclick = () => open(curIdx - 1);
  if (n) n.onclick = () => open(curIdx + 1);
  det.scrollTop = 0;
}

// ---- 事件绑定
let qTimer = 0;
$('#q').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  const v = e.target.value;
  qTimer = setTimeout(() => { state.q = v; paint(); }, 120);
});
for (const [sel, key] of [['#fModel','model'],['#fSched','sched'],['#fLora','lora'],['#fSize','size'],['#fSource','source'],['#sort','sort']]) {
  $(sel).addEventListener('change', (e) => { state[key] = e.target.value; paint(); });
}
for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    const k = chip.dataset.quick;
    if (state.quick.has(k)) state.quick.delete(k); else state.quick.add(k);
    paint();
  });
}
$('#reset').addEventListener('click', () => {
  state.q = ''; state.dir = null; state.model = ''; state.sched = ''; state.lora = '';
  state.size = ''; state.source = ''; state.sort = 'mtime_desc'; state.quick.clear();
  state.cat = null;
  $('#q').value = ''; $('#fModel').value = ''; $('#fSched').value = ''; $('#fLora').value = '';
  $('#fSize').value = ''; $('#fSource').value = ''; $('#sort').value = 'mtime_desc';
  det.classList.remove('on'); curIdx = -1;
  paint();
});

document.addEventListener('keydown', (e) => {
  if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) {
    if (e.key === 'Escape') { e.target.blur(); $('#q').value = state.q = ''; paint(); }
    return;
  }
  if (e.key === '/') { e.preventDefault(); $('#q').focus(); return; }
  if (curIdx < 0) return;
  if (e.key === 'Escape') { det.classList.remove('on'); curIdx = -1; }
  if (e.key === 'ArrowLeft' && curIdx > 0) open(curIdx - 1);
  if (e.key === 'ArrowRight' && curIdx < view.length - 1) open(curIdx + 1);
});

buildCats();
buildDirs();
paint();
</script>
</body>
</html>`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, 'gallery.html');
fs.writeFileSync(outFile, html, 'utf8');

db.close();

const dirTotal = new Set(items.map((i) => i.dir)).size;

console.log('');
console.log('  静态图库已生成');
console.log('  ' + '='.repeat(56));
console.log(`  文件        ${outFile}`);
console.log(`  体积        ${(fs.statSync(outFile).size / 1024).toFixed(0)} KB`);
console.log(`  导出张数    ${items.length}  (库内共 ${total})`);
console.log(`  文件夹      ${dirTotal} 个`);
console.log(`  模型候选    ${payload.facets.models.length} 个`);
console.log(`  LoRA 候选   ${payload.facets.loras.length} 个`);
if (THUMBS) {
  console.log(`  缩略图      命中 ${thumbCached} / 缺失回退原图 ${thumbMissing}`);
  if (thumbMissing > 0) {
    console.log('              建议先跑:node tools/thumb-sync.ts  (缺少的图会加载原图,较慢)');
  }
  console.log(`              位置 <图库根>\\${THUMB_DIRNAME}\\<相对路径>\\<原名>.thumb.png`);
}
console.log('');
console.log('  直接用 Chrome 打开即可:搜索 + 筛选 + 分类 + 看参数,全在本地跑。');
console.log('  ⚠️ 图片用 file:// 引用,本文件必须和源图片在同一盘符。');
console.log(`     源图片在 ${path.parse(rows[0]?.absPath ?? 'E:\\').root} 盘,本文件在 ${path.parse(outFile).root} 盘。`);
console.log('');
