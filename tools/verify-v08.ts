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
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeLoraName, fingerprintOf, matchRecipes, type RecipeRecord } from '../src/shared/recipes.ts';
import { AssetDb } from '../src/main/db.ts';

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

// ---------------------------------------------------------------- B. 行为验证

console.log('\n=== B) 配方匹配逻辑(行为) ===');

const L = (name: string, strength: number | null) => ({ name, strength });
const R = (id: string, title: string, loras: { file_name: string; strength: number; exclude?: boolean }[]): RecipeRecord =>
  ({ id, title, file_path: '', base_model: '', favorite: false, loras } as RecipeRecord);

// B1) 名字规范化
const normCases: [string, string][] = [
  ['画风类/velnari_fantasy_impressions_krea2', 'velnari_fantasy_impressions_krea2'],
  ['画风类\\sub\\Krea_2_in_real_v2.safetensors', 'krea_2_in_real_v2'],
  ['  m87_lora_v1  ', 'm87_lora_v1'],
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

// B4) 强度容差 ±0.005
const tol = matchRecipes([L('a_lora', 0.575), L('b_lora', 0.6)], [R('t', '容差', [{ file_name: 'a_lora', strength: 0.57 }])]);
if (tol.matches.length === 1) good('强度差 0.005 内判为命中');
else bad('强度容差 ±0.005 未生效');
const tolOut = matchRecipes([L('a_lora', 0.62)], [R('t2', '超差', [{ file_name: 'a_lora', strength: 0.6 }])]);
if (tolOut.matches.length === 0) good('强度差超过容差不命中');
else bad('强度差 0.02 不应命中');

// B5) 重叠配方贪心:大配方优先,一个 LoRA 只归一个配方
const overlap = matchRecipes(
  [L('shared_lora', 0.5), L('only_big', 0.7)],
  [
    R('small', '小配方', [{ file_name: 'shared_lora', strength: 0.5 }]),
    R('big', '大配方', [
      { file_name: 'shared_lora', strength: 0.5 },
      { file_name: 'only_big', strength: 0.7 },
    ]),
  ]
);
const ids = overlap.matches.map((x) => x.recipe.id);
if (ids.length === 1 && ids[0] === 'big') good('重叠时大配方优先整组命中,小配方不拆散');
else bad(`贪心分配期望只命中 big,得到 ${ids.join(',') || '(空)'}`);

// B6) 图侧 null 权重只按名字比
const nullW = matchRecipes([L('a_lora', null)], [R('n', 'null权重', [{ file_name: 'a_lora', strength: 1 }])]);
if (nullW.matches.length === 1) good('图侧权重为 null 时只按名字匹配');
else bad('图侧 null 权重应按名字匹配命中');

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

  const RECIPE2 = [{ name: 'style_a', strength: 0.6 }, { name: 'style_b', strength: 0.4 }];

  // C1) 子集语义:两条都齐才命中(命中 img1/4/5/6,img2 只有一条、img3 超差,都不算)
  const c1 = rdb.queryImages({ recipeLoras: RECIPE2, limit: 50 });
  if (c1.total === 4 && c1.ids.includes(img1)) good('子集匹配:配方两条 LoRA 都齐的图才命中');
  else bad(`子集匹配期望 total=4,得到 ${c1.total} (ids=${c1.ids.join(',')})`);
  const c1b = rdb.queryImages({ recipeLoras: RECIPE2, starredOnly: false, limit: 50 });
  if (!c1b.ids.includes(2) && !c1b.ids.includes(3)) good('只有其中一条 / 权重超差的图不命中');
  else bad(`缺一条或超差的图不应命中,ids=${c1b.ids.join(',')}`);

  // C2) 权重容差:差 0.005 命中(上面的 img4 已在 c1 里),差 0.02 不命中
  const c2 = rdb.queryImages({ recipeLoras: [{ name: 'style_a', strength: 0.6 }], limit: 50 });
  if (c2.ids.includes(4) && !c2.ids.includes(3)) good('权重差 0.005 内命中、0.02 不命中');
  else bad(`权重容差断言失败,ids=${c2.ids.join(',')}`);

  // C3) 名字规范化:图带子目录 ↔ 配方写裸名,两个方向都命中
  if (c1.ids.includes(1) && c1.ids.includes(5)) good('图侧 LoRA 带子目录(不同子目录)也能命中裸名配方');
  else bad(`图侧子目录规范化失败,ids=${c1.ids.join(',')}`);
  const c3 = rdb.queryImages({ recipeLoras: [{ name: '画风类/style_a', strength: 0.6 }], limit: 50 });
  if (c3.ids.includes(2)) good('配方侧带子目录、图侧是裸名也能命中');
  else bad(`配方侧子目录规范化失败,ids=${c3.ids.join(',')}`);

  // C4) 图侧权重为 null → 只按名字命中
  if (c1.ids.includes(6)) good('图中 LoRA 权重为 null 时只按名字命中');
  else bad('图侧 null 权重应按名字命中');
  // 反过来:配方侧权重缺失(null)→ 也只按名字比,任何权重都算(含超差的 img3)
  const c4 = rdb.queryImages({ recipeLoras: [{ name: 'style_a', strength: null }], limit: 50 });
  if (c4.total === 6) good('配方侧权重为 null 时只按名字匹配(全部 6 张)');
  else bad(`配方侧 null 权重期望 total=6,得到 ${c4.total}`);

  // C5) recipeNoMatch(主进程在"配方不存在/无有效 LoRA"时传)→ 空结果
  const c5 = rdb.queryImages({ recipeNoMatch: true, limit: 50 });
  if (c5.total === 0 && c5.ids.length === 0) good('recipeNoMatch → total 为 0(不是"不过滤")');
  else bad(`recipeNoMatch 期望 total=0,得到 ${c5.total}`);

  // C6) 与其它筛选组合:recipeLoras + starredOnly 同时生效
  rdb.setStarred(img1, true);
  const c6 = rdb.queryImages({ recipeLoras: RECIPE2, starredOnly: true, limit: 50 });
  if (c6.total === 1 && c6.ids[0] === img1) good('配方筛选与 starredOnly 叠加生效(只剩已收藏那张)');
  else bad(`组合筛选期望只有 img1,得到 total=${c6.total} ids=${c6.ids.join(',')}`);

  rdb.close();
}

console.log('\n' + (failures === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${failures} 项)`));
process.exit(failures === 0 ? 0 : 1);
