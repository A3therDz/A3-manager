/**
 * v0.8 回归验证 —— 对应 `改进.md` 的 4 条需求。
 *
 *   node --experimental-strip-types tools/verify-v08.ts
 *
 * 分两半:
 *   A. 静态契约:版本号 0.8.0、双击原图查看器(Lightbox)、拖出带元数据(startDrag)、
 *      配方功能(存储/协议/匹配/管理 UI/详情分组)各自的关键代码点必须在文件里;
 *   B. 行为验证:src/shared/recipes.ts 的纯匹配逻辑(规范化 / 指纹 / 子集匹配 / 贪心分配)。
 *      不需要数据库与图库。
 *   C. 行为验证(内存库):按配方筛选 —— recipeLoras 子集匹配、权重容差、
 *      子目录规范化、null 权重、recipeNoMatch、与 starredOnly 组合。
 *   D. 配方比对(v0.8 追加):提示词归一化 / 相似度阈值 / 分列与 LoRA 差异分组,
 *      以及数据层 peerIdsByPrompt / candidateIdsByTokens 的召回口径(内存库)。
 *   E. 新图入库的性能路径(行为):老库 lora_refs 补 base_name 列 + 回填 + 建索引、
 *      recipeCounts 与旧逐条 COUNT 口径等价、scanPaths 定点入库(重复跑不重解析、
 *      删除定点清理)、定点入库后目录树签名仍有效(全量对账能走快速通道)。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { normalizeLoraName, fingerprintOf, matchRecipes, type RecipeRecord } from '../src/shared/recipes.ts';
import { normalizePrompt, promptTokens, promptSimilarity, SIMILAR_THRESHOLD } from '../src/shared/prompts.ts';
import { buildCompareRows, groupCompareRows, UNMATCHED_TITLE, type CompareBasic } from '../src/shared/compare.ts';
import { AssetDb } from '../src/main/db.ts';
import { scanLibrary, scanPaths, classifyWatchPaths } from '../src/main/indexer.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');

let failures = 0;
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};
const good = (m: string) => console.log(`  ok   ${m}`);

const read = (rel: string): string => {
  try {
    return fs.readFileSync(path.join(PROJECT, rel), 'utf8');
  } catch {
    bad(`读不到文件 ${rel}`);
    return '';
  }
};

/** 断言:文件里必须出现某段文本 */
function mustHave(rel: string, needle: string, label: string) {
  const src = read(rel);
  if (src.includes(needle)) good(`${label}`);
  else bad(`${label} —— ${rel} 里找不到 ${JSON.stringify(needle)}`);
}

/** 断言:文件里**不能**再出现某段文本 */
function mustNotHave(rel: string, needle: string, label: string) {
  const src = read(rel);
  if (!src.includes(needle)) good(label);
  else bad(`${label} —— ${rel} 里仍残留 ${JSON.stringify(needle)}`);
}

// ---------------------------------------------------------------- A. 静态契约

console.log('=== A0) 版本号 0.8.0 ===');
mustHave('package.json', '"version": "0.8.0"', 'package.json 版本号为 0.8.0');

console.log('\n=== A1) 需求 1:双击图片在应用内打开原图查看器 ===');
mustHave('src/renderer/components/Lightbox.tsx', 'cam-file://file/', '查看器用 cam-file 协议加载原图(最高清晰度,不走缩略图)');
mustHave('src/renderer/components/Lightbox.tsx', 'onWheel', '滚轮缩放');
mustHave('src/renderer/components/Lightbox.tsx', 'setPointerCapture', '放大后指针捕获拖平移');
mustHave('src/renderer/components/Lightbox.tsx', '适应窗口', '有"适应窗口"按钮');
mustHave('src/renderer/components/Lightbox.tsx', '‹', '有翻页按钮');
mustHave('src/renderer/components/ImageGrid.tsx', 'onDoubleClick={() => onOpenViewer?.(r.id)}', '双击卡片打开查看器');
mustHave('src/renderer/components/DetailPanel.tsx', 'onDoubleClick', '双击详情预览图打开查看器');
mustHave('src/renderer/App.tsx', 'openLightbox', 'App 持有查看器开关状态');
mustHave('src/renderer/main.tsx', '.cam-lightbox {', '查看器有全屏样式');
mustNotHave('src/renderer/components/ImageGrid.tsx', "shell.openPath", '查看器不走系统外部打开');

console.log('\n=== A2) 需求 2:拖出的图片带元数据(原文件 startDrag) ===');
mustHave('src/shared/types.ts', 'dragOutImages(ids: number[]): void', '契约声明 dragOutImages(fire-and-forget)');
mustHave('src/preload/index.cjs', "ipcRenderer.send('drag-out-images', ids)", 'preload 用 send 而非 invoke');
mustHave('src/main/index.ts', "ipcMain.on('drag-out-images'", '主进程收到拖出请求');
mustHave('src/main/index.ts', 'e.sender.startDrag({ file, icon })', '主进程 startDrag 拖磁盘原文件(元数据天然保留)');
mustHave('src/renderer/dnd.ts', 'window.api.dragOutImages(ids)', 'dragstart 同步阶段发起拖出');
mustHave('src/renderer/dnd.ts', 'getImageDragIds', '模块级 store 供内部分类落点读取');
mustHave('src/renderer/components/Trees.tsx', 'getImageDragIds()', '分类落点优先读 store(startDrag 会吃掉私有 MIME)');
mustHave('src/renderer/App.tsx', 'isInternalImageDrag()', '窗口级 drop 仍把内部拖拽与外部文件导入区分开');

console.log('\n=== A3) 需求 3:LoRA 配方功能 ===');
mustHave('src/shared/recipes.ts', 'export function normalizeLoraName', 'LoRA 名规范化(去子目录/扩展名)');
mustHave('src/shared/recipes.ts', 'export function fingerprintOf', '配方指纹计算');
mustHave('src/shared/recipes.ts', 'export function matchRecipes', '子集匹配 + 贪心分配');
mustHave('src/shared/types.ts', 'listRecipes(): Promise<RecipeRecord[]>', '契约:listRecipes');
mustHave('src/shared/types.ts', 'saveRecipe(', '契约:saveRecipe');
mustHave('src/shared/types.ts', 'deleteRecipe(', '契约:deleteRecipe');
mustHave('src/preload/index.cjs', "call('listRecipes')", 'preload 暴露 listRecipes');
mustHave('src/main/index.ts', 'RECIPES_DIR', '主进程有配方目录(userData/recipes)');
mustHave('src/main/index.ts', "handle('saveRecipe'", '主进程 saveRecipe handler');
mustHave('src/main/index.ts', "handle('deleteRecipe'", '主进程 deleteRecipe handler');
mustHave('src/main/index.ts', "protocol.handle('cam-recipe'", '配方封面协议(只服务 recipes 目录内封面)');
mustHave('src/main/index.ts', "scheme: 'cam-recipe'", 'cam-recipe 协议已声明 privileged');
mustHave('src/renderer/components/RecipeManager.tsx', '新建配方', '配方管理面板可新建');
mustHave('src/renderer/components/RecipeManager.tsx', 'pickImageFile', '管理面板可选配图');
mustHave('src/renderer/App.tsx', 'RecipeManager', 'App 渲染配方管理弹层');
mustHave('src/renderer/App.tsx', 'listRecipes()', 'App 启动时加载配方');
mustHave('src/renderer/components/DetailPanel.tsx', 'matchRecipes(', '详情面板按配方分组 LoRA');
mustHave('src/renderer/components/DetailPanel.tsx', 'cam-recipe-bar', '配方条样式挂载点');
mustHave('src/renderer/components/DetailPanel.tsx', '存为配方', 'LoRA 区有「存为配方」入口');
mustHave('src/renderer/main.tsx', '.cam-recipe-bar {', '配方条样式');
mustHave('src/renderer/api.ts', 'listRecipes', 'HTTP 调试版契约完整(空实现)');

console.log('\n=== A4) 需求 4:verify-v08 挂进质量门 ===');
mustHave('package.json', 'verify-v08.ts', 'verify 链包含 verify-v08');

console.log('\n=== A5) 配方比对(v0.8 追加)的静态契约 ===');
mustHave('src/shared/prompts.ts', 'export function normalizePrompt', '提示词归一化(纯函数)');
mustHave('src/shared/prompts.ts', 'export function promptSimilarity', '提示词相似度(纯函数)');
mustHave('src/shared/prompts.ts', 'export const SIMILAR_THRESHOLD', '相似阈值常量');
mustHave('src/shared/compare.ts', 'export function groupCompareRows', '按命中配方分列 + LoRA 差异');
mustHave('src/shared/compare.ts', 'export function buildCompareRows', '比对行组装(配方命中 + 相似度)');
mustHave('src/shared/types.ts', 'findPromptPeers(imageId: number, similar: boolean, limit?: number)', '契约:findPromptPeers');
mustHave('src/shared/types.ts', 'getCompareRows(ids: number[]): Promise<CompareRow[]>', '契约:getCompareRows');
mustHave('src/preload/index.cjs', "call('findPromptPeers'", 'preload 暴露 findPromptPeers');
mustHave('src/preload/index.cjs', "call('getCompareRows'", 'preload 暴露 getCompareRows');
mustHave('src/main/index.ts', "handle('findPromptPeers'", '主进程 findPromptPeers handler');
mustHave('src/main/index.ts', "handle('getCompareRows'", '主进程 getCompareRows handler');
mustHave('src/main/db.ts', 'peerIdsByPrompt(', '数据层:同提示词精确查询');
mustHave('src/main/db.ts', 'candidateIdsByTokens(', '数据层:相似模式 LIKE 预筛');
mustHave('src/renderer/components/ComparePanel.tsx', 'groupCompareRows(', '比对面板按配方分列');
mustHave('src/renderer/components/ComparePanel.tsx', 'thumbUrl(', '分列缩略图走 cam-thumb(不用原图)');
mustHave('src/renderer/components/CompareStage.tsx', 'onWheel', '并排比对台滚轮缩放');
mustHave('src/renderer/components/CompareStage.tsx', 'setPointerCapture', '并排比对台拖动平移');
mustHave('src/renderer/components/DetailPanel.tsx', '配方比对', '详情 LoRA 区有「配方比对」入口');
mustHave('src/renderer/App.tsx', 'openCompareFromSelection', '批量条有「比对」入口(≥2 张)');
mustHave('src/renderer/App.tsx', 'if (compareStageRows) closeCompareStage();', 'Esc 链:并排台优先于比对面板');
mustHave('src/renderer/main.tsx', '.cam-cmp {', '比对面板样式(97% 不透明、z-index 380)');
mustHave('src/renderer/main.tsx', '.cam-cmp2 {', '并排比对台样式(z-index 390)');
mustHave('src/renderer/api.ts', 'findPromptPeers', 'HTTP 调试版契约完整(空实现)');

// ---------------------------------------------------------------- B. 行为验证

console.log('\n=== B) 配方匹配逻辑(行为) ===');

const L = (name: string, strength: number | null) => ({ name, strength });
const R = (id: string, title: string, loras: { file_name: string; strength: number; exclude?: boolean }[]): RecipeRecord =>
  ({ id, title, file_path: '', base_model: '', favorite: false, loras } as RecipeRecord);

// B1) 名字规范化(只剥模型扩展名,不剥名字里的点名/版本号)
const normCases: [string, string][] = [
  ['画风类/velnari_fantasy_impressions_krea2', 'velnari_fantasy_impressions_krea2'],
  ['画风类\\sub\\Krea_2_in_real_v2.safetensors', 'krea_2_in_real_v2'],
  ['  m87_lora_v1  ', 'm87_lora_v1'],
  ['(Krea 2) Vision Vanguard 24 V2026.1', '(krea 2) vision vanguard 24 v2026.1'],
  ['krea2/style/(Krea 2) Vision Vanguard 24 V2026.1.safetensors', '(krea 2) vision vanguard 24 v2026.1'],
];
for (const [input, expected] of normCases) {
  if (normalizeLoraName(input) === expected) good(`normalize(${JSON.stringify(input)})`);
  else bad(`normalize(${JSON.stringify(input)}) 期望 ${expected},得到 ${normalizeLoraName(input)}`);
}

// B2) 指纹:排序 + 强度两位小数 + 排除 exclude
const fp = fingerprintOf([
  { file_name: 'B/b_lora', strength: 1 },
  { file_name: 'a_lora.safetensors', strength: 0.567 },
  { file_name: 'skip_me', strength: 0.9, exclude: true },
]);
if (fp === 'a_lora:0.57|b_lora:1') good(`fingerprintOf 排序/四舍五入/排除 exclude → ${fp}`);
else bad(`fingerprintOf 期望 'a_lora:0.57|b_lora:1',得到 '${fp}'`);

// B3) 子集匹配:一张图由两个配方构成
const recipes = [
  R('r1', '画风A', [
    { file_name: '画风类/style_a', strength: 0.6 },
    { file_name: '画风类/style_b', strength: 0.4 },
  ]),
  R('r2', '滤镜B', [{ file_name: '功能类/filter_b', strength: 1 }]),
  R('r3', '不命中', [{ file_name: 'nope_lora', strength: 1 }]),
];
const img = [L('画风类/style_a', 0.6), L('画风类/style_b', 0.4), L('功能类/filter_b', 1), L('extra_lora', 0.5)];
const m = matchRecipes(img, recipes);
if (m.matches.length === 2 && m.matches.every((x) => x.recipe.id === 'r1' || x.recipe.id === 'r2'))
  good('一张图同时命中两个配方(提示词由多个配方构成)');
else bad(`期望命中 r1+r2,得到 ${m.matches.map((x) => x.recipe.id).join(',') || '(空)'}`);
const matchedIdx = new Set(m.matches.flatMap((x) => x.loraIndexes));
if (m.unmatched.length === 1 && m.unmatched[0] === 3 && !matchedIdx.has(3))
  good('未被配方吸收的 LoRA 留在 unmatched');
else bad(`unmatched 期望 [3],得到 ${JSON.stringify(m.unmatched)}`);
if (!matchedIdx.has(0) || !matchedIdx.has(1) || !matchedIdx.has(2)) bad('配方应吸收各自对应的 LoRA');
else good('每个配方吸收的 LoRA 索引正确');

// B4) 权重不参与命中,只作为提示(调过权重不该让整组配方失效)
const diffW = matchRecipes([L('a_lora', 0.2)], [R('w', '权重被调过', [{ file_name: 'a_lora', strength: 0.8 }])]);
if (diffW.matches.length === 1) good('权重和配方记录不同(0.2 vs 0.8)仍按名字命中');
else bad('权重不同不应导致漏掉配方');
const wd = diffW.matches[0]?.weightDrift ?? 0;
if (Math.abs(wd - 0.6) < 1e-9) good(`命中的权重偏差被记下来(weightDrift=${wd.toFixed(2)})`);
else bad(`weightDrift 期望 0.6,得到 ${wd}`);
const pairW = diffW.matches[0]?.pairs?.[0];
if (pairW && pairW.imageStrength === 0.2 && pairW.recipeLora.strength === 0.8)
  good('配对里同时带配方权重与图里实际权重(供界面显示「实际 x」)');
else bad('配对缺少图里实际权重');

// B5) 长短配方同时可能命中:长配方优先(权重差异不该让短配方顶上来)
const longer = matchRecipes(
  [L('base_a', 0.7), L('base_b', 0.8), L('extra_d', 0.2)],
  [
    R('short', '短配方', [
      { file_name: 'base_a', strength: 0.7 },
      { file_name: 'base_b', strength: 0.8 },
    ]),
    R('long', '长配方', [
      { file_name: 'base_a', strength: 0.7 },
      { file_name: 'base_b', strength: 0.8 },
      { file_name: 'extra_d', strength: 0.8 },
    ]),
  ]
);
const longerIds = longer.matches.map((x) => x.recipe.id);
if (longerIds.length === 1 && longerIds[0] === 'long')
  good('长配方整组命中后,它的子集(短配方)不再重复命中,也没有散落的 LoRA');
else bad(`期望只命中 long,得到 ${longerIds.join(',') || '(空)'};unmatched=${JSON.stringify(longer.unmatched)}`);

// B6) 条数相同才用权重接近度定胜负(长配方优先之后的第一顺位)
const tie = matchRecipes(
  [L('x_lora', 0.3)],
  [
    R('far', '差得远', [{ file_name: 'x_lora', strength: 0.9 }]),
    R('near', '更接近', [{ file_name: 'x_lora', strength: 0.3 }]),
  ]
);
if (tie.matches.length === 1 && tie.matches[0].recipe.id === 'near') good('条数相同时权重更接近的配方优先');
else bad(`条数相同时期望命中 near,得到 ${tie.matches.map((x) => x.recipe.id).join(',') || '(空)'}`);

// B7) 图中 LoRA 带子目录 / 权重为 null
const subdir = matchRecipes(
  [L('画风类/only_here', null)],
  [R('s', '子目录', [{ file_name: 'only_here.safetensors', strength: 1 }])]
);
if (subdir.matches.length === 1) good('图侧带子目录、配方侧带扩展名,规范化后仍命中(权重 null 只按名字)');
else bad('子目录/扩展名/权重缺失的组合应命中');

// ---------------------------------------------------------------- C. 按配方筛选(行为)

console.log('\n=== C) 按配方筛选(行为) ===');
{
  const rdb = new AssetDb(':memory:');
  const rootId = rdb.addRoot('C:/recipes-test', 'recipes-test');
  let seq = 0;
  /** 造一张图;loras 直接进 lora_refs 表 */
  const addImg = (loras: Array<{ name: string; strength: number | null }>): number => {
    seq++;
    return rdb.upsertImage({
      rootId,
      absPath: `C:/recipes-test/img${seq}.png`,
      relPath: `img${seq}.png`,
      relDir: '',
      fileName: `img${seq}.png`,
      fileSize: 1000 + seq,
      fileMtime: 1700000000000 + seq,
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
      loraCount: loras.length,
      nodeCount: 0,
      metaJson: '{}',
      rawJson: null,
      loras,
      searchText: `img${seq}`,
    }).id;
  };

  // img1:两条 lora 都在(图侧带子目录);img2:只有 style_a;img3:style_a 权重差 0.02;
  // img4:style_a 权重差恰为 0.005;img5:图侧 style_a 带另一层子目录;img6:两条权重都是 null
  const img1 = addImg([{ name: '画风类/style_a', strength: 0.6 }, { name: 'style_b', strength: 0.4 }]);
  addImg([{ name: 'style_a', strength: 0.6 }]);
  addImg([{ name: 'style_a', strength: 0.62 }]);
  addImg([{ name: 'style_a', strength: 0.605 }, { name: 'style_b', strength: 0.4 }]);
  addImg([{ name: 'sub/dir/style_a', strength: 0.6 }, { name: 'style_b', strength: 0.4 }]);
  addImg([{ name: 'style_a', strength: null }, { name: 'style_b', strength: null }]);

  const RECIPE2 = ['style_a', 'style_b'];

  // C1) 子集语义:两条都齐才命中(只看名字:img1/4/5/6 命中,img2/3 只有一条,不算)
  const c1 = rdb.queryImages({ recipeLoraNames: RECIPE2, limit: 50 });
  if (c1.total === 4 && c1.ids.includes(img1)) good('子集匹配:配方两条 LoRA 都齐的图才命中');
  else bad(`子集匹配期望 total=4,得到 ${c1.total} (ids=${c1.ids.join(',')})`);
  const c1b = rdb.queryImages({ recipeLoraNames: RECIPE2, limit: 50 });
  if (!c1b.ids.includes(2) && !c1b.ids.includes(3)) good('只有其中一条的图不命中');
  else bad(`缺一条的图不应命中,ids=${c1b.ids.join(',')}`);

  // C2) 权重不参与命中:调过权重(0.62 / 0.605)的图照样命中
  const c2 = rdb.queryImages({ recipeLoraNames: ['style_a'], limit: 50 });
  if (c2.total === 6) good('权重与配方记录不同(0.62 / 0.605)仍然命中 —— 匹配只看名字');
  else bad(`权重不该参与命中,期望 total=6,得到 ${c2.total}`);

  // C3) 名字规范化:图带子目录 ↔ 配方写裸名/带扩展名,两个方向都命中
  if (c1.ids.includes(1) && c1.ids.includes(5)) good('图侧 LoRA 带子目录(不同子目录)也能命中裸名配方');
  else bad(`图侧子目录规范化失败,ids=${c1.ids.join(',')}`);
  const c3 = rdb.queryImages({ recipeLoraNames: ['画风类/style_a.safetensors'], limit: 50 });
  if (c3.total === 6) good('配方侧带子目录+扩展名、图侧是裸名也能命中');
  else bad(`配方侧规范化失败,期望 total=6,得到 ${c3.total}`);

  // C4) 图侧权重为 null → 照常按名字命中
  if (c1.ids.includes(6)) good('图中 LoRA 权重为 null 时按名字命中');
  else bad('图侧 null 权重应按名字命中');

  // C5) recipeNoMatch(主进程在"配方不存在/无有效 LoRA"时传)→ 空结果
  const c5 = rdb.queryImages({ recipeNoMatch: true, limit: 50 });
  if (c5.total === 0 && c5.ids.length === 0) good('recipeNoMatch → total 为 0(不是"不过滤")');
  else bad(`recipeNoMatch 期望 total=0,得到 ${c5.total}`);

  // C6) 与其它筛选组合:recipeLoraNames + starredOnly 同时生效
  rdb.setStarred(img1, true);
  const c6 = rdb.queryImages({ recipeLoraNames: RECIPE2, starredOnly: true, limit: 50 });
  if (c6.total === 1 && c6.ids[0] === img1) good('配方筛选与 starredOnly 叠加生效(只剩已收藏那张)');
  else bad(`组合筛选期望只有 img1,得到 total=${c6.total} ids=${c6.ids.join(',')}`);

  rdb.close();
}

// ---------------------------------------------------------------- D. 配方比对(行为)

console.log('\n=== D1) 提示词归一化 ===');
{
  // 大小写 / 连续空白 / 强调权重语法 / 两层括号 / 结尾逗号 —— 全部压成同一个串
  const raw = '  A  CAT, (Best Quality:1.3),  ((masterpiece)) ,  ';
  const expected = 'a cat, best quality, masterpiece';
  const got = normalizePrompt(raw);
  if (got === expected) good(`normalizePrompt 归一化大小写/空白/权重/嵌套括号/结尾逗号 → ${JSON.stringify(got)}`);
  else bad(`normalizePrompt 期望 ${JSON.stringify(expected)},得到 ${JSON.stringify(got)}`);

  const variants = [
    'a cat, best quality, masterpiece',
    'A Cat, Best   Quality, Masterpiece.',
    'a cat, best quality, masterpiece,,',
  ];
  const norms = variants.map(normalizePrompt);
  if (norms.every((v) => v === expected)) good('四种写法(含结尾多逗号/句点)归一后完全相同');
  else bad(`归一化后仍不一致: ${JSON.stringify(norms)}`);

  // 归一化只动形态,不该把语义吃掉:冒号后的数字不在括号里时保留
  const keep = normalizePrompt('1girl, solo, (rating: general)');
  if (keep === '1girl, solo, rating: general') good('非"括号整体是权重"的冒号内容保留原样(不误删)');
  else bad(`不该动的内容被改了: ${JSON.stringify(keep)}`);
}

console.log('\n=== D2) 提示词相似度 ===');
{
  const base = 'fujichoko style, 1girl, solo, summer, beach, holding hands, masterpiece, best quality';
  if (promptSimilarity(base, base) === 1) good('完全相同 → 1');
  else bad(`相同提示词相似度应为 1,得到 ${promptSimilarity(base, base)}`);

  // 改了 2 个词的同一提示词仍算"同一批图"。
  // 注意 Jaccard 的特性:能容忍几个词取决于提示词有多长 —— 这里用真实的"长提示词"(26 个 token)。
  const tags = [
    'fujichoko', 'style', '1girl', 'solo', 'long', 'hair', 'blue', 'eyes', 'summer', 'beach',
    'ocean', 'sky', 'clouds', 'smile', 'masterpiece', 'quality', 'detailed', 'cinematic',
    'lighting', 'depth', 'field', 'illustration', 'shading', 'tones', 'composure', 'fabric',
  ];
  const longA = tags.join(', ');
  const longB = [...tags];
  longB[10] = 'mountain'; // 把 ocean 换成 mountain
  longB[17] = 'dramatic'; // 把 cinematic 换成 dramatic
  const s1 = promptSimilarity(longA, longB.join(', '));
  if (s1 >= SIMILAR_THRESHOLD) good(`长提示词改 2 个词相似度 ${s1.toFixed(3)} ≥ ${SIMILAR_THRESHOLD}(仍归为一类)`);
  else bad(`长提示词改 2 个词不该掉到阈值以下,得到 ${s1.toFixed(3)}`);

  // 短提示词同样改 2 个词就会掉到阈值以下 —— 这是 Jaccard 的固有口径(已知限制,报告里有说明)
  const shortA = 'a cat, masterpiece, best quality';
  const shortB = 'a dog, masterpiece, best quality';
  if (promptSimilarity(shortA, shortB) < SIMILAR_THRESHOLD)
    good(`短提示词改 1 个词相似度 ${promptSimilarity(shortA, shortB).toFixed(3)} < 阈值(短提示词更敏感,已知限制)`);
  else bad('短提示词改 1 个词不该 ≥ 阈值(口径变了要顺手更新报告)');

  const unrelated = 'cyberpunk city at night, rain, neon signs, cinematic, 8k';
  const s2 = promptSimilarity(base, unrelated);
  if (s2 < 0.5) good(`无关的提示词相似度 ${s2.toFixed(3)} < 0.5(不会被误召回)`);
  else bad(`无关提示词相似度应 < 0.5,得到 ${s2.toFixed(3)}`);

  if (promptSimilarity(base, '') === 0 && promptSimilarity('', base) === 0) good('一边为空 → 0');
  else bad('任一边为空时相似度必须为 0');
  if (promptSimilarity('', '') === 0) good('两边都空 → 0(不是"一模一样")');
  else bad('两边都空应为 0');

  if (promptTokens('a 2d, 1girl, x').join(',') === '2d,1girl') good('promptTokens 丢掉单字符、保留含数字的 2d 并去重');
  else bad(`promptTokens 期望 '2d,1girl',得到 '${promptTokens('a 2d, 1girl, x').join(',')}'`);
}

console.log('\n=== D3) 分组分列与 LoRA 集合差异(纯函数) ===');
{
  // 长配方 = 短配方的超集;未匹配的图带一条谁都不认识的 LoRA
  const R3: RecipeRecord[] = [
    R('long', '长配方', [
      { file_name: '画风类/base_a', strength: 0.6 },
      { file_name: 'base_b.safetensors', strength: 0.4 },
      { file_name: '功能类/extra_d', strength: 0.8 },
    ]),
    R('short', '短配方', [{ file_name: 'base_b', strength: 0.4 }]),
  ];
  const mk = (
    id: number,
    loras: Array<{ name: string; strength: number | null }>,
    prompt: string
  ): CompareBasic => ({
    id,
    fileName: `img${id}.png`,
    relDir: '',
    width: 1024,
    height: 1024,
    seed: id,
    prompt,
    loras,
  });
  const p0 = 'a cat, masterpiece';
  const basics: CompareBasic[] = [
    // 长配方组:三条都在(名字写法故意和图里不一样,验证规范化后仍归组/比对)
    mk(1, [
      { name: '画风类/base_a', strength: 0.6 },
      { name: 'base_b', strength: 0.4 },
      { name: '功能类/extra_d', strength: 0.8 },
    ], p0),
    mk(2, [{ name: '画风类/base_a', strength: 0.7 }, { name: 'base_b', strength: 0.4 }, { name: '功能类/extra_d', strength: 0.8 }], p0),
    // 短配方组:只有 base_b
    mk(3, [{ name: 'base_b', strength: 0.4 }], p0),
    // 未匹配:一条不属于任何配方的 LoRA
    mk(4, [{ name: 'loose_y', strength: 1 }], p0),
  ];
  const rows3 = buildCompareRows(basics, R3, p0);
  const titles = rows3.map((r) => r.recipeTitles[0] ?? '(none)').join(',');
  if (titles === '长配方,长配方,短配方,(none)')
    good(`按命中的最长配方归组(长配方优先,短配方不再重复命中)→ ${titles}`);
  else bad(`行分组标题期望 '长配方,长配方,短配方,(none)',得到 '${titles}'`);

  if (rows3.every((r) => r.similarity === 1)) good('同一提示词的行相似度都是 1');
  else bad(`相似度期望全 1,得到 ${rows3.map((r) => r.similarity).join(',')}`);

  const groups = groupCompareRows(rows3);
  const gk = groups.map((g) => g.key).join('|');
  // 组序:LoRA 条数降序(长配方 3 条 → 短配方 1 条)→ 组名;未匹配永远最后
  if (gk === '长配方|短配方|') good(`三组分组与组序正确(未匹配组最后)→ ${gk}`);
  else bad(`组序期望 '长配方|短配方|',得到 '${gk}'`);
  if (groups[2] && groups[2].title === UNMATCHED_TITLE) good(`未匹配组标题是「${UNMATCHED_TITLE}」`);
  else bad(`未匹配组标题应为「${UNMATCHED_TITLE}」,得到 ${groups[2]?.title}`);
  if (groups.map((g) => g.rows.length).join(',') === '2,1,1') good('各组张数 2 / 1 / 1');
  else bad(`各组张数期望 2,1,1,得到 ${groups.map((g) => g.rows.length).join(',')}`);

  if (groups[0].diff.added.length === 0 && groups[0].diff.removed.length === 0)
    good('第一组的 diff 为空(界面显示「与第一组一致」)');
  else bad(`第一组 diff 应为空,得到 ${JSON.stringify(groups[0].diff)}`);

  const dShort = groups[1].diff;
  if (dShort.added.length === 0 && dShort.removed.join('|') === '画风类/base_a|功能类/extra_d')
    good(`短配方组:没有新增,缺少第一组的两条(保留原始显示名)→ ${JSON.stringify(dShort)}`);
  else bad(`短配方组 diff 期望 removed=['画风类/base_a','功能类/extra_d'],得到 ${JSON.stringify(dShort)}`);

  const dUn = groups[2].diff;
  if (dUn.added.join('|') === 'loose_y' && dUn.removed.join('|') === '画风类/base_a|base_b|功能类/extra_d')
    good(`未匹配组:新增 loose_y、缺少第一组三条 → ${JSON.stringify(dUn)}`);
  else bad(`未匹配组 diff 期望 added=['loose_y'] + removed=三条,得到 ${JSON.stringify(dUn)}`);
}

console.log('\n=== D4) 按提示词找同类图(内存库行为) ===');
{
  const pdb = new AssetDb(':memory:');
  const rootId = pdb.addRoot('C:/compare-test', 'compare-test');
  let seq = 0;
  const add = (posPrompt: string, loras: Array<{ name: string; strength: number | null }> = []): number => {
    seq++;
    return pdb.upsertImage({
      rootId,
      absPath: `C:/compare-test/c${seq}.png`,
      relPath: `c${seq}.png`,
      relDir: '',
      fileName: `c${seq}.png`,
      fileSize: 1000 + seq,
      fileMtime: 1700000000000 + seq,
      width: 1024,
      height: 1024,
      source: 'comfyui',
      modelName: null,
      samplerName: null,
      scheduler: null,
      steps: null,
      cfg: null,
      seed: seq,
      posPrompt,
      negPrompt: null,
      promptLen: posPrompt.length,
      loraCount: loras.length,
      nodeCount: 0,
      metaJson: '{}',
      rawJson: null,
      loras,
      searchText: `c${seq}`,
    }).id;
  };

  // 同一个提示词 4 张 + 另一条不相关的 1 张
  const P = 'a cat, (best quality:1.3), masterpiece';
  const same = [add(P), add(P), add(P), add(P)];
  const other = add('a dog running on the beach, sunlight');

  // D4-1) 精确口径:lower(trim(pos_prompt)) 全等 → 只返回同提示词的那 4 张
  const plainKey = P.trim().toLowerCase();
  const peers = pdb.peerIdsByPrompt(plainKey, 50);
  const peersSet = new Set(peers);
  if (peers.length === 4 && same.every((id) => peersSet.has(id)) && !peersSet.has(other))
    good(`peerIdsByPrompt 只返回同一提示词的 4 张(不含不同提示词的那张)→ ${peers.join(',')}`);
  else bad(`peerIdsByPrompt 期望 4 张同提示词,得到 ${peers.join(',')}`);

  // 归一化键会剥掉 `(best quality:1.3)` 的权重语法,SQL 侧做不到 —— 所以主进程两个键都试。
  // 这里把这条口径钉住,免得以后有人只用归一化键、把带权重的提示词全漏掉。
  if (normalizePrompt(P) !== plainKey) good('带强调权重的提示词:归一化键与原文键不同(主进程需要两个键都试)');
  else bad('归一化应当剥掉 (word:1.3),两个键却相同');
  if (pdb.peerIdsByPrompt(normalizePrompt(P), 50).length === 0)
    good('只传归一化键时找不到原文(带权重提示词),证明主进程的双键回退是必要的');
  else bad('归一化键不该命中原文(说明 SQL 侧口径与测试假设不一致)');

  // D4-2) 相似口径:token LIKE 预筛能召回同提示词的 4 张,不召回无关的那张
  const toks = promptTokens(P).sort((a, b) => b.length - a.length);
  const cand = pdb.candidateIdsByTokens(toks, 500);
  const candSet = new Set(cand);
  if (same.every((id) => candSet.has(id)) && !candSet.has(other))
    good(`candidateIdsByTokens(${toks.slice(0, 3).join('/')}…) 召回同提示词的 4 张,不召回无关图`);
  else bad(`candidateIdsByTokens 召回不对:${cand.join(',')} (期望含 ${same.join(',')},不含 ${other})`);
  if (pdb.candidateIdsByTokens([], 500).length === 0) good('没有可用 token 时预筛返回空(不会退化成全表)');
  else bad('空 token 应当返回空数组');
  if (pdb.peerIdsByPrompt('   ', 50).length === 0) good('空提示词返回空(不返回整库)');
  else bad('空提示词不该返回结果');

  // D4-3) 行组装:基准图自己永远在结果里且 similarity = 1(这一批图没有 LoRA,配方库传空)
  const rows = buildCompareRows(pdb.getCompareBasics([same[0], same[1], other]), [], P);
  const baseRow = rows.find((r) => r.id === same[0]);
  if (baseRow && baseRow.similarity === 1) good('基准图自己在结果里,similarity = 1');
  else bad(`基准图 similarity 应为 1,得到 ${baseRow?.similarity}`);
  const otherRow = rows.find((r) => r.id === other);
  if (otherRow && otherRow.similarity < 0.5) good(`不同提示词的那张相似度 ${otherRow.similarity.toFixed(3)} < 0.5`);
  else bad(`不同提示词的行相似度应 < 0.5,得到 ${otherRow?.similarity}`);
  const loraRow = rows.find((r) => r.id === same[0]);
  if (loraRow && Array.isArray(loraRow.loras) && loraRow.loras.length === 0) good('没有 LoRA 的图 loras 为空数组(界面显示未匹配配方)');
  else bad('getCompareBasics 的 loras 应为空数组');

  pdb.close();
}

console.log('\n=== E) 新图入库的性能路径(行为) ===');

/** 最小合法 PNG 生成:IHDR(2×2 真彩) + 可选 tEXt 块 + IDAT + IEND */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function makePng(text?: Record<string, string>): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type = truecolor
  const parts = [PNG_SIG, pngChunk('IHDR', ihdr)];
  for (const [k, v] of Object.entries(text ?? {})) {
    parts.push(
      pngChunk('tEXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0]), Buffer.from(v, 'latin1')]))
    );
  }
  parts.push(pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(2 * (1 + 2 * 3)))), pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
/** ComfyUI 节点图文本:一条 LoraLoader(名字故意带子目录 + 扩展名) */
const graphWithLora = (loraName: string) =>
  JSON.stringify({
    '1': { class_type: 'LoraLoader', inputs: { lora_name: loraName, strength_model: 0.6, strength_clip: 0.6 } },
  });

// ---- E1) 老库迁移:lora_refs 没有 base_name 列 → 打开时补列 + 按 normalizeLoraName 回填 + 建索引

/**
 * 造一个"老库":
 *  - 先用 AssetDb 建出完整表结构(images / roots / kv…),再把 lora_refs 换成老形态
 *    (v0.7 及以前:没有 base_name 列,也不带外键);
 *  - `withColumn: true` 用来模拟"迁移被打断"的库(列加上了但值全是 NULL)。
 */
function seedLegacyDb(
  file: string,
  loras: Array<{ name: string; strength: number }>,
  opts: { withColumn: boolean }
): void {
  new AssetDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec('DROP TABLE lora_refs');
  raw.exec(
    opts.withColumn
      ? `CREATE TABLE lora_refs (
           image_id INTEGER NOT NULL, name TEXT NOT NULL, base_name TEXT, strength REAL,
           PRIMARY KEY (image_id, name))`
      : `CREATE TABLE lora_refs (
           image_id INTEGER NOT NULL, name TEXT NOT NULL, strength REAL,
           PRIMARY KEY (image_id, name))`
  );
  raw.exec(`INSERT INTO roots (id, path, label, enabled, added_at) VALUES (1, 'C:/old-lib', 'old', 1, 0)`);
  raw.exec(
    `INSERT INTO images (id, root_id, abs_path, rel_path, rel_dir, file_name, file_size, file_mtime,
                         source, meta_json, indexed_at)
     VALUES (1, 1, 'C:/old-lib/1.png', '1.png', '', '1.png', 1, 1, 'comfyui', '{}', 0)`
  );
  const ins = opts.withColumn
    ? raw.prepare('INSERT INTO lora_refs (image_id, name, base_name, strength) VALUES (?,?,?,?)')
    : raw.prepare('INSERT INTO lora_refs (image_id, name, strength) VALUES (?,?,?)');
  for (const l of loras) {
    if (opts.withColumn) ins.run(1, l.name, null, l.strength);
    else ins.run(1, l.name, l.strength);
  }
  raw.close();
}

{
  const tmp = fs.mkdtempSync(path.join(tmpdir(), 'a3-v08-mig-'));
  const dbFile = path.join(tmp, 'old.db');
  seedLegacyDb(dbFile, [
    { name: '画风类/style_a.safetensors', strength: 0.6 },
    { name: 'sub/dir/style_b', strength: 0.4 },
    { name: '  MiXeD_Case_LoRA.SAFETENSORS  ', strength: 1 },
  ], { withColumn: false });

  const odb = new AssetDb(dbFile);
  const cols = (odb.db.prepare('PRAGMA table_info(lora_refs)').all() as Array<{ name: string }>).map((c) => c.name);
  if (cols.includes('base_name')) good('老库打开后 lora_refs 补上了 base_name 列');
  else bad(`老库迁移没补上 base_name 列,现有列:${cols.join(',')}`);

  const rows = odb.db
    .prepare('SELECT name, base_name FROM lora_refs ORDER BY name')
    .all() as Array<{ name: string; base_name: string | null }>;
  const badRows = rows.filter((r) => r.base_name === null || r.base_name !== normalizeLoraName(r.name));
  if (rows.length === 3 && badRows.length === 0)
    good(`老数据按 normalizeLoraName 回填(含子目录 / 扩展名 / 大小写):${rows.map((r) => r.base_name).join(', ')}`);
  else bad(`回填不对:${JSON.stringify(rows)}`);

  const idx = odb.db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_lora_refs_base'`)
    .get() as { name: string; sql: string } | undefined;
  if (idx) good('迁移顺带建了 idx_lora_refs_base 索引');
  else bad('迁移没有建 idx_lora_refs_base 索引');
  // 必须是 (base_name, image_id) 复合索引:只建 (base_name) 时 SQLite 会走
  // "按名字找行再回表比对 image_id"的计划,真实库上一次配方筛选从 148ms 退化到 4920ms
  if (idx && /image_id/.test(idx.sql))
    good(`索引形状正确(复合索引,EXISTS 能一次定位):${idx.sql.replace(/\s+/g, ' ')}`);
  else bad(`索引形状不对(缺 image_id),配方筛选会退化:${idx?.sql}`);

  // 回填后按配方筛选走索引也能命中(不再是 cam_lora_base(name) = ? 的逐行函数调用)
  const hit = odb.queryImages({ recipeLoraNames: ['画风类/style_a'], limit: 10 });
  if (hit.ids.join(',') === '1') good('迁移后配方筛选能命中老数据(base_name 列可用)');
  else bad(`迁移后配方筛选期望命中 image_id=1,得到 ${JSON.stringify(hit.ids)}`);

  // 库里若留着"只有 base_name 一列"的旧索引(形状不对会让筛选退化),打开时要被换掉
  odb.db.exec('DROP INDEX idx_lora_refs_base');
  odb.db.exec('CREATE INDEX idx_lora_refs_base ON lora_refs(base_name)');
  odb.close();
  const odb2 = new AssetDb(dbFile);
  const idx2 = odb2.db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_lora_refs_base'`)
    .get() as { sql: string } | undefined;
  if (idx2 && /image_id/.test(idx2.sql)) good('形状不对的旧索引(只有 base_name)在打开时被换成复合索引');
  else bad(`形状不对的旧索引没被修正:${idx2?.sql}`);
  odb2.close();

  // 迁移被打断过的库(列加上了、值是 NULL):打开时必须补回填,否则配方筛选一张都命中不了
  const halfFile = path.join(tmp, 'half.db');
  seedLegacyDb(halfFile, [{ name: 'sub/style_c.safetensors', strength: 0.5 }], { withColumn: true });
  const hdb = new AssetDb(halfFile);
  const hrow = hdb.db.prepare('SELECT name, base_name FROM lora_refs').get() as {
    name: string; base_name: string | null;
  };
  if (hrow.base_name === 'style_c') good('迁移被打断的库(列在但值是 NULL)在打开时被补回填');
  else bad(`被打断的迁移没有被补上:${JSON.stringify(hrow)}`);
  hdb.close();

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- E2) 统计等价:recipeCounts(一次查询)与旧口径(逐配方 queryImages().total)逐条相等
{
  const rdb = new AssetDb(':memory:');
  const rootId = rdb.addRoot('C:/recipe-counts', 'recipe-counts');
  let seq = 0;
  const addImg = (loras: Array<{ name: string; strength: number | null }>): number => {
    seq++;
    return rdb.upsertImage({
      rootId,
      absPath: `C:/recipe-counts/r${seq}.png`,
      relPath: `r${seq}.png`,
      relDir: '',
      fileName: `r${seq}.png`,
      fileSize: 1000 + seq,
      fileMtime: 1700000000000 + seq,
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
      loraCount: loras.length,
      nodeCount: 0,
      metaJson: '{}',
      rawJson: null,
      loras,
      searchText: `r${seq}`,
    }).id;
  };
  addImg([{ name: 'style_a', strength: 0.6 }, { name: 'style_b', strength: 0.4 }]);
  addImg([{ name: 'style_a', strength: 0.6 }]);
  addImg([{ name: 'sub/dir/style_a', strength: 0.62 }, { name: 'style_b', strength: 0.4 }]);
  addImg([{ name: 'style_a', strength: null }, { name: 'style_b', strength: null }]);
  addImg([{ name: '画风类/style_a.safetensors', strength: 1 }]);
  addImg([{ name: 'nope_lora', strength: 1 }]);

  const DEFS = [
    { id: 'both', names: ['style_a', 'style_b'], expect: 3 },
    { id: 'one', names: ['style_a'], expect: 5 },
    // 与 both 同一集合,但配方侧写成"子目录 + 扩展名":规范化后必须相等
    { id: 'mixed-form', names: ['画风类/style_a.safetensors', 'sub/dir/style_b'], expect: 3 },
    { id: 'missing', names: ['never_used_lora'], expect: 0 },
    { id: 'dup', names: ['style_a', 'style_a'], expect: 5 },
    { id: 'empty', names: [], expect: 0 },
  ];
  const counts = rdb.recipeCounts(DEFS.map((d) => ({ recipeId: d.id, names: d.names })));

  // 与旧口径逐条比:旧口径 = 主进程 getRecipeStats 的写法
  for (const d of DEFS) {
    const oldCount = d.names.length === 0 ? 0 : rdb.queryImages({ recipeLoraNames: d.names, limit: 1 }).total;
    const newCount = counts.get(d.id) ?? 0;
    if (oldCount === newCount) good(`配方 ${d.id}:新 recipeCounts 与旧逐条 COUNT 口径一致(${newCount})`);
    else bad(`配方 ${d.id} 新旧口径不一致:旧 ${oldCount} / 新 ${newCount}`);
  }
  const wrong = DEFS.filter((d) => (counts.get(d.id) ?? 0) !== d.expect);
  if (wrong.length === 0) good(`命中数与预期逐条相符(含"没有有效 LoRA"的配方记 0):${DEFS.map((d) => d.id + '=' + (counts.get(d.id) ?? 0)).join(', ')}`);
  else bad(`命中数与预期不符:${wrong.map((d) => `${d.id} 期望 ${d.expect} 得到 ${counts.get(d.id) ?? 0}`).join('; ')}`);
  if (!counts.has('missing') && !counts.has('empty'))
    good('没有命中的配方不进 Map(调用方取 ?? 0),不会误记成"全库张数"');
  else bad(`不该出现的配方进了 Map:${[...counts.keys()].join(',')}`);
  if (rdb.recipeCounts([]).size === 0) good('空需求集返回空 Map(不会去查库)');
  else bad('空需求集应当返回空 Map');
  rdb.close();
}

// ---- E3) 定点入库:只处理变化的路径,指纹没变不重复解析,删掉的文件被定点清理
{
  const tmp = fs.mkdtempSync(path.join(tmpdir(), 'a3-v08-pin-'));
  const dbFile = path.join(tmp, 'pin.db');
  const lib = path.join(tmp, 'lib');
  fs.mkdirSync(lib, { recursive: true });
  const pa = path.join(lib, 'a.png');
  const pb = path.join(lib, 'b.png');
  const pc = path.join(lib, 'c.png');
  // a.png 带一条 LoRA(名字带子目录 + 扩展名),验证入库时把 base_name 规范化写好了
  fs.writeFileSync(pa, makePng({ prompt: graphWithLora('sub/style_a.safetensors') }));
  fs.writeFileSync(pb, makePng());
  fs.writeFileSync(pc, makePng());

  const pdb = new AssetDb(dbFile);
  const rootId = pdb.addRoot(lib, 'pin-lib');
  const all = [pa, pb, pc];

  const r1 = await scanPaths(pdb, { rootId, absPaths: all });
  if (r1.indexed === 3 && r1.removed === 0 && r1.scanned === 3 && pdb.count() === 3)
    good(`scanPaths 定点入库 3 张(scanned=${r1.scanned} indexed=${r1.indexed} removed=${r1.removed})`);
  else bad(`定点入库期望 3 张,得到 ${JSON.stringify(r1)} / 库内 ${pdb.count()}`);

  const lr = pdb.db.prepare('SELECT image_id, name, base_name FROM lora_refs').all() as Array<{
    image_id: number; name: string; base_name: string | null;
  }>;
  if (lr.length === 1 && lr[0].name === 'sub/style_a.safetensors' && lr[0].base_name === 'style_a')
    good('入库时同时写了规范化 base_name(子目录 / 扩展名都剥掉):sub/style_a.safetensors → style_a');
  else bad(`lora_refs 的 base_name 不对:${JSON.stringify(lr)}`);

  const r2 = await scanPaths(pdb, { rootId, absPaths: all });
  if (r2.indexed === 0 && r2.removed === 0 && r2.scanned === 3)
    good('同一批文件再跑一次:indexed=0(mtime/size 指纹没变就不重复解析)');
  else bad(`重复定点入库不该重新解析,得到 ${JSON.stringify(r2)}`);

  // 内容变了(mtime/size 变)→ 只有这一个文件被重新解析
  fs.writeFileSync(pb, makePng({ prompt: graphWithLora('another_lora') }));
  const r2b = await scanPaths(pdb, { rootId, absPaths: [pb] });
  if (r2b.indexed === 1 && pdb.count() === 3)
    good('文件变了(指纹不同)→ 重新解析入库,且没有多出索引行');
  else bad(`改动文件后期望 indexed=1,得到 ${JSON.stringify(r2b)} / 库内 ${pdb.count()}`);

  // 删掉一张:a.png 与它的 LoRA 行 / FTS 行都要清掉
  fs.rmSync(pa);
  const r3 = await scanPaths(pdb, { rootId, absPaths: [pa] });
  const ftsLeft = (pdb.db.prepare('SELECT COUNT(*) AS c FROM images_fts').get() as { c: number }).c;
  const loraLeft = pdb.db.prepare('SELECT name, base_name FROM lora_refs').all() as Array<{
    name: string; base_name: string | null;
  }>;
  if (r3.removed === 1 && r3.indexed === 0 && pdb.count() === 2 && !pdb.getImageByRelPath(rootId, 'a.png'))
    good('盘上删掉的文件被定点清理(removed=1,索引里只剩 2 张,查不到 a.png)');
  else bad(`删除期望 removed=1 且只剩 2 张,得到 ${JSON.stringify(r3)} / 库内 ${pdb.count()}`);
  // 剩下的一行属于 b.png(改过内容后重新解析,LoRA 变成 another_lora);
  // a.png 那条 sub/style_a 必须随删图一起级联清掉。
  if (ftsLeft === 2 && loraLeft.length === 1 && loraLeft[0].base_name === 'another_lora')
    good(`被删图的 LoRA 行与 FTS 行一起清掉(fts=${ftsLeft},lora_refs 只剩 b.png 的 ${loraLeft[0].name})`);
  else bad(`残留脏行:fts=${ftsLeft} lora_refs=${JSON.stringify(loraLeft)}(应分别为 2 / [another_lora])`);

  // 非 .png 与图库之外的路径一律忽略(能不能定点由调用方判定)
  const r4 = await scanPaths(pdb, { rootId, absPaths: [path.join(lib, 'note.txt'), 'C:/outside/x.png'] });
  if (r4.scanned === 0 && r4.indexed === 0 && r4.removed === 0 && pdb.count() === 2)
    good('非 .png / 图库之外的路径被忽略(不会误入库、不会误删)');
  else bad(`不该处理这些路径,得到 ${JSON.stringify(r4)}`);

  // ---- E4) 目录树签名被维护:下次全量对账仍能走"签名一致 → 整轮跳过"的快速通道
  const sig = pdb.getTreeSignature(rootId);
  if (sig && sig.count === pdb.countImages(rootId) && sig.count === 2)
    good(`定点入库维护了目录树签名:tree_sig 仍在、count=${sig.count} 与实际索引数一致(没被删/没归零)`);
  else bad(`目录树签名不对:${JSON.stringify(sig)} / 索引数 ${pdb.countImages(rootId)}`);
  if (sig && sig.rootMtime > 0) good('签名的 rootMtime 取自当前图库根目录(不是 0)');
  else bad('签名的 rootMtime 应为图库根目录的 mtime');

  const full = await scanLibrary(pdb, { rootIds: [rootId] });
  if (full.skippedRoots === 1 && full.indexed === 0 && full.removed === 0)
    good('定点入库之后,下一次全量对账走签名快速通道整轮跳过(不必再遍历 + 逐个 stat)');
  else bad(`期望签名一致走快速通道(skippedRoots=1),得到 skippedRoots=${full.skippedRoots} indexed=${full.indexed} removed=${full.removed}`);

  pdb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- E5) 监听事件的定点判定(classifyWatchPaths):真实目录 + 真实索引
console.log('\n--- E5) 监听事件判定(能不能定点 / 要不要退回全量) ---');
{
  const tmp = fs.mkdtempSync(path.join(tmpdir(), 'a3-v08-watch-'));
  const dbFile = path.join(tmp, 'w.db');
  const lib = path.join(tmp, 'lib');
  const day = path.join(lib, '2026-10-09');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'k1.png'), makePng());
  fs.writeFileSync(path.join(day, 'k2.png'), makePng());
  fs.writeFileSync(path.join(lib, 'top.png'), makePng());
  fs.writeFileSync(path.join(lib, 'note.txt'), 'x');

  const wdb = new AssetDb(dbFile);
  const rootId = wdb.addRoot(lib, 'watch-lib');
  // 先把两张子目录里的图 + 根目录里那张入库(等于"应用已经在运行、索引是新鲜的")
  await scanPaths(wdb, {
    rootId,
    absPaths: [path.join(day, 'k1.png'), path.join(day, 'k2.png'), path.join(lib, 'top.png')],
  });
  const indexed = (rel: string) => wdb.getImageByRelPath(rootId, rel) !== null;
  /** 模拟主进程的 probeDir:索引里这个目录下有行吗?抽样的行在盘上还在吗? */
  const probe = (rel: string): 'none' | 'stale' | 'alive' => {
    const sample = wdb.indexedRelPathsUnder(rootId, rel, 3);
    if (sample.length === 0) return 'none';
    return sample.some((rp) => fs.existsSync(path.join(lib, rp))) ? 'alive' : 'stale';
  };
  const cls = (rels: string[]) => classifyWatchPaths(lib, rels, indexed, probe);

  // 1) 目录名事件 + 它下面的文件事件同批到达 —— **Windows 实测就是这么报的**
  //    (往 output\krea2\<日期>\ 拷 5 张图会额外报 5 次目录名 change);
  //    目录事件不带"哪个文件变了",这时真正的信息在文件事件里,要能在丢掉目录事件后定点。
  const c1 = cls([
    '2026-10-09',
    path.join('2026-10-09', 'k1.png'),
    path.join('2026-10-09', 'k2.png'),
  ]);
  if (c1 && c1.paths.length === 2 && c1.removedDirs.length === 0 && c1.paths.every((p) => p.toLowerCase().endsWith('.png')))
    good('目录事件 + 它下面的文件事件同批 → 目录事件被当作冗余丢掉,剩下两个 .png 定点处理');
  else bad(`同批带目录名时应能定点,得到 ${JSON.stringify(c1)}`);

  // 2) 只有目录事件、而目录还在(整目录被搬进来 / 新目录)→ 必须退回全量
  if (cls(['2026-10-09']) === null) good('只有"还在的目录"事件 → 拿不准,退回全量对账');
  else bad('只有目录事件时不该定点');

  // 3) 非图片文件(txt):索引里没有它的行 → 无操作,不用为它跑全量
  const c3 = cls(['note.txt']);
  if (c3 && c3.paths.length === 0 && c3.removedDirs.length === 0)
    good('非图片文件(txt)→ 无操作(索引里没有它的行,不必退回全量)');
  else bad(`非图片文件不该触发全量,得到 ${JSON.stringify(c3)}`);

  // 4) 盘上已删、索引里有的图 → 定点清理
  const gone = path.join(day, 'k2.png');
  fs.rmSync(gone);
  const c4 = cls([path.join('2026-10-09', 'k2.png')]);
  if (c4 && c4.paths.length === 1 && c4.paths[0] === gone) good('盘上删掉、索引里存在的 .png → 定点清理');
  else bad(`已删的索引图应能定点,得到 ${JSON.stringify(c4)}`);

  // 5) 盘上没有、索引里也没有的 .png(拿不准:可能刚建完就被改名)→ 退回全量
  if (cls(['2026-10-09/ghost.png']) === null) good('盘上没有、索引里也没有的 .png → 退回全量对账');
  else bad('来历不明的 .png 不该定点');

  // 6) 改名:旧名(已删,索引里有)+ 新名(存在)→ 两个路径一起定点
  fs.renameSync(path.join(day, 'k1.png'), path.join(day, 'k1-renamed.png'));
  const c6 = cls([path.join('2026-10-09', 'k1.png'), path.join('2026-10-09', 'k1-renamed.png')]);
  if (c6 && c6.paths.length === 2) good('改名(旧名 + 新名两个事件)→ 一起定点处理');
  else bad(`改名应能定点,得到 ${JSON.stringify(c6)}`);

  // 7) 自己的缩略图缓存:整批忽略(返回空计划 = 无事可做,不算"拿不准")
  const c7 = cls([path.join('.comfy-thumbs', 'top.thumb.png')]);
  if (c7 && c7.paths.length === 0 && c7.removedDirs.length === 0)
    good('自己的缩略图缓存路径被忽略(返回空 = 什么都不用做)');
  else bad(`缩略图缓存路径应被忽略,得到 ${JSON.stringify(c7)}`);

  // 8) 空批次返回空计划(没有要处理的路径)
  const c8 = cls([]);
  if (c8 && c8.paths.length === 0 && c8.removedDirs.length === 0) good('空批次返回空计划');
  else bad('空批次应返回空计划');

  // 9) **整个日期目录被删**(Windows 只报目录名):索引里有它的行、盘上都没了 → 定点清理整目录
  const dayRows = wdb.queryImages({ relDir: '2026-10-09', relDirRecursive: true, limit: 10 }).total;
  fs.rmSync(day, { recursive: true, force: true });
  const c9 = cls(['2026-10-09']);
  if (c9 && c9.removedDirs.length === 1 && c9.removedDirs[0] === '2026-10-09')
    good(`整目录被删(索引里原有 ${dayRows} 行)→ 定点清理,不退回全量`);
  else bad(`整目录被删应定点清理,得到 ${JSON.stringify(c9)}`);

  // 10) 定点清理整目录:行被删掉,并且**签名被作废**(怕那是目录改名,下次启动全量对账收回来)
  const r10 = await scanPaths(wdb, { rootId, absPaths: [], removedDirs: ['2026-10-09'] });
  const leftUnder = wdb.queryImages({ relDir: '2026-10-09', relDirRecursive: true, limit: 10 }).total;
  if (r10.removed > 0 && leftUnder === 0 && wdb.getTreeSignature(rootId) === null)
    good(`定点清理整目录:removed=${r10.removed}、目录下剩 ${leftUnder} 行、签名已作废(下次启动会全量对账)`);
  else bad(`定点清理整目录不对:${JSON.stringify(r10)} left=${leftUnder} sig=${JSON.stringify(wdb.getTreeSignature(rootId))}`);

  // 11) 目录被删、但索引里本来就没有它的行 → 无操作(不必全量)
  fs.rmSync(day, { recursive: true, force: true });
  const c11 = cls(['2026-10-09']);
  if (c11 && c11.removedDirs.length === 0 && c11.paths.length === 0) good('目录被删但索引里没有它的行 → 无操作');
  else bad(`无索引行的目录删除不该有动作,得到 ${JSON.stringify(c11)}`);

  // 12) 真正把判定结果交给 scanPaths:改一张图 → 只有这一张重新解析
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(lib, 'top.png'), makePng({ prompt: graphWithLora('renamed_lora') }));
  const plan = cls(['top.png']); // 监听事件给的是相对路径
  const r5 = plan ? await scanPaths(wdb, { rootId, absPaths: plan.paths, removedDirs: plan.removedDirs }) : null;
  if (r5 && r5.indexed === 1 && r5.scanned === 1) good('判定结果接 scanPaths:改动那张图被重新解析(indexed=1)');
  else bad(`判定结果接 scanPaths 后期望 indexed=1,得到 ${JSON.stringify(r5)}`);

  wdb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------- F. 新图入库的读写路径(行为)

console.log('\n--- F) 新图入库的读写路径(默认视图索引 / 库统计的轻重分离) ---');
{
  const dbFile = path.join(tmpdir(), `a3-v08-perf-${Date.now()}.db`);
  const pdb = new AssetDb(dbFile);
  const rootId = pdb.addRoot(path.join(tmpdir(), 'a3-v08-perf-lib'), 'perf-lib');
  let seq = 0;
  const add = (mtime: number, model: string, lora: string) =>
    pdb.upsertImage({
      rootId,
      absPath: `C:/x/perf-${seq}.png`,
      relPath: `d/perf-${seq}.png`,
      relDir: 'd',
      fileName: `perf-${seq}.png`,
      fileSize: 1024,
      fileMtime: mtime,
      width: 1024,
      height: 1024,
      source: 'comfyui',
      modelName: model,
      samplerName: 'euler',
      scheduler: null,
      steps: null,
      cfg: null,
      seed: null,
      posPrompt: 'a cat',
      negPrompt: null,
      promptLen: 5,
      loraCount: 1,
      nodeCount: 0,
      metaJson: '{}',
      rawJson: null,
      loras: [{ name: lora, strength: 0.8 }],
      searchText: `perf-${seq++}`,
    });
  for (let i = 0; i < 30; i++) add(1000 + i, 'modelA', 'lora_x');
  add(2000, 'modelB', 'lora_y');

  // F1) 默认视图(某图库根 + 最新优先)必须走覆盖索引,不能 USE TEMP B-TREE 排序
  const ro = new DatabaseSync(dbFile, { readOnly: true });
  const plan = (ro
    .prepare(
      `EXPLAIN QUERY PLAN SELECT i.id FROM images i WHERE i.root_id = ? ORDER BY i.file_mtime DESC, i.id DESC LIMIT 120 OFFSET 0`
    )
    .all(rootId) as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
  if (/idx_images_root_mtime/.test(plan) && !/TEMP B-TREE/i.test(plan))
    good('默认视图查询走 idx_images_root_mtime 覆盖索引(不再 USE TEMP B-TREE 全根排序)');
  else bad(`默认视图查询没走预期索引,计划=${plan}`);

  // F2) 库统计:UI 路径(tops:false)不扫 lora_refs;CLI 路径(tops 默认)照旧有
  const light = pdb.getStats(undefined, { tops: false }) as any;
  const full = pdb.getStats(undefined) as any;
  if (Array.isArray(light.topLoras) && light.topLoras.length === 0 && light.topSamplers.length === 0
      && light.totalImages === 31 && Array.isArray(light.topModels) && light.topModels.length === 2)
    good('getStats({tops:false}):跳过 topLoras/topSamplers,仍给 totalImages 与 topModels(UI 只用这三样)');
  else bad(`getStats({tops:false}) 形状不对:${JSON.stringify({ t: light.totalImages, m: light.topModels?.length, s: light.topSamplers?.length, l: light.topLoras?.length })}`);
  if (full.topLoras.length > 0 && full.topSamplers.length > 0 && full.topLoras[0].name === 'lora_x')
    good('getStats() 默认仍算 topSamplers/topLoras(CLI 统计不受影响)');
  else bad(`getStats() 默认应当有 tops,得到 ${JSON.stringify(full.topLoras)}`);

  // F3) 迁移兼容:老库(没有 base_name 列 / 没有新索引)打开后自动补齐
  const cols = (ro.prepare('PRAGMA table_info(lora_refs)').all() as any[]).map((c) => c.name);
  if (cols.includes('base_name')) good('lora_refs.base_name 列存在(定点筛选/统计走它)');
  else bad('lora_refs 缺 base_name 列');
  const indexes = (ro
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('images','lora_refs')`)
    .all() as Array<{ name: string }>).map((r) => r.name);
  if (indexes.includes('idx_images_root_mtime') && indexes.includes('idx_lora_refs_base'))
    good('新索引都已建好(idx_images_root_mtime / idx_lora_refs_base)');
  else bad(`索引缺失:${indexes.join(', ')}`);

  ro.close();
  pdb.close();
  try {
    fs.rmSync(dbFile, { force: true });
  } catch {
    /* Windows 上偶发文件仍被占用:临时文件,删不掉不影响验证结论 */
  }
}

console.log('\n' + (failures === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${failures} 项)`));
process.exit(failures === 0 ? 0 : 1);
