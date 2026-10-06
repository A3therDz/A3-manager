/**
 * v0.6 回归验证 —— 对应 `改进.md` 的第 1~5 条。
 *
 *   CAM_DB=<索引库路径>  node --experimental-strip-types tools/verify-v06.ts
 *
 * 分两半:
 *   A. 静态契约(不需要数据库):五个改动各自的关键代码点必须在文件里;
 *   B. 行为验证(需要 CAM_DB):点文件夹看子目录的查询口径 ——
 *      父目录结果 ⊇ 子目录结果,且不会把"名字前缀相同的兄弟目录"算进来。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

console.log('=== A1) 需求 1:不再有卡片/详情进场动画(卡顿根因) ===');
mustNotHave('src/renderer/main.tsx', '.cam-card {\n    animation', '卡片不再有进场动画');
mustNotHave('src/renderer/main.tsx', '@keyframes cam-in', '抽掉了 cam-in 关键帧');
mustNotHave('src/renderer/main.tsx', 'animation-delay: calc(var(--i', '抽掉了错峰延迟');
mustNotHave('src/renderer/main.tsx', '.cam-detail { margin: 0; animation', '详情面板不再有进场位移动画');
mustHave('src/renderer/main.tsx', 'cam-detail.closing { animation: cam-slide-out', '详情面板退场动画保留(有始有终)');

console.log('\n=== A2) 需求 2:拖卡片 = 加入分类;拖预览图不再弹解析层 ===');
for (const f of ['src/renderer/dnd.ts']) {
  const src = read(f);
  if (!src) continue;
  if (src.includes('application/x-a3-image-ids')) good(`${f} 定义了自己的拖拽 MIME`);
  else bad(`${f} 缺少内部拖拽 MIME`);
}
mustHave('src/renderer/components/ImageGrid.tsx', 'startImageDrag(ids, e.dataTransfer)', '卡片会发起内部拖拽');
mustHave('src/renderer/components/ImageGrid.tsx', 'draggable={false}', '卡片里的 img 不自己起拖拽');
mustHave('src/renderer/components/DetailPanel.tsx', 'draggable={false}', '预览大图不自己起拖拽');
mustHave('src/renderer/main.tsx', 'img { -webkit-user-drag: none; }', '全局关掉图片原生拖拽');
mustHave('src/renderer/components/Trees.tsx', 'onDropImage', '分类行接受拖放');
mustHave('src/renderer/components/Trees.tsx', 'readImageDragIds(e.dataTransfer)', '分类行从拖拽里读出图片 id');
mustHave('src/renderer/App.tsx', 'isInternalImageDrag() || hasImageDragData(e.dataTransfer)', '文件拖放流程会跳过内部拖拽');
mustNotHave('src/renderer/App.tsx', "window.addEventListener('drop', onDragEnd, true)", '不在 drop 捕获阶段清空拖拽状态(drop 之后才轮到分类行)');

console.log('\n=== A3) 需求 3:点文件夹 = 看它和所有子目录 ===');
mustHave('src/renderer/App.tsx', 'relDirRecursive: relDir ? true : undefined', '点文件夹时带上递归标记');
mustHave('src/main/db.ts', 'i.rel_dir LIKE ? ESCAPE', '索引层支持递归匹配');
mustHave('src/main/db.ts', 'relDir !== null', 'relDir 为 null 时不当成筛选条件');

console.log('\n=== A4) 需求 4:标签页等宽,挤了才一起收缩 ===');
mustHave('src/renderer/App.tsx', 'TAB_W_MAX', '有"单标签最大宽度"常量');
mustHave('src/renderer/App.tsx', '--tab-w', '标签宽度走 CSS 变量(量宽循环要"写完立刻量")');
mustHave('src/renderer/App.tsx', "bar.scrollWidth - bar.clientWidth", '以"有没有横向溢出"为最终判据');
mustHave('src/renderer/main.tsx', 'width: var(--tab-w', '每个标签用同一个宽度变量');
mustNotHave('src/renderer/main.tsx', '.cam-tab {\n    display: flex; align-items: center; gap: 6px; max-width: 190px', '不再用"宽度跟着文字走"的旧规则');

console.log('\n=== A5) 需求 5:打开的卡片有发光框 ===');
mustHave('src/renderer/main.tsx', '.cam-card.open {', '有 .cam-card.open 样式');
mustHave('src/renderer/main.tsx', '0 0 18px 2px var(--accent-soft)', '发光框有外扩散光晕');
mustHave('src/renderer/components/ImageGrid.tsx', 'isOpen ? \' open\' : \'\'', '打开的那张卡带上 open 类');
mustHave('src/renderer/App.tsx', 'openId={selectedId}', '把当前打开的 id 传给网格');

console.log('\n=== A6) 需求 6:左侧文件夹列表要和图片明显区分 ===');
mustHave('src/renderer/components/Trees.tsx', 'export function FolderIcon', '有独立的文件夹图标组件');
mustHave('src/renderer/components/Trees.tsx', 'icon={<FolderIcon', '文件夹树的行会画图标');
mustHave('src/renderer/components/Trees.tsx', "icon ? ' folder' : ''", '只有文件夹行套用 .folder 样式(分类树不受影响)');
mustHave('src/renderer/components/Trees.tsx', 'cam-tree-label', '文件夹名有独立容器(可缩略)');
mustHave('src/renderer/components/Trees.tsx', 'cam-tree-count', '数量有独立样式');
mustHave('src/renderer/components/Trees.tsx', 'cam-tree-guide', '层级有引导线');
mustHave('src/renderer/main.tsx', '.cam-treerow.folder {', '文件夹行有专属样式(字重/字号)');
mustHave('src/renderer/main.tsx', '.cam-folder-ico {', '文件夹图标有样式');
mustHave('src/renderer/main.tsx', '.cam-treerow.folder .cam-folder-ico { color: var(--accent); }', '图标用强调色,和灰扑扑的图片区分开');

// ---------------------------------------------------------------- B. 行为验证

console.log('\n=== B) 递归目录口径(行为) ===');
const dbFile = process.env.CAM_DB;
if (!dbFile) {
  console.log('  (跳过:未设置 CAM_DB)');
} else {
  const db = new AssetDb(dbFile);
  const dirs = new Set<string>();
  const page = db.queryImages({ limit: 20000 });
  for (const row of db.getImagesByIds(page.ids)) dirs.add(row.relDir);
  const all = [...dirs];

  // 找最深的"父目录 + 直接子目录"组合(父子关系直接用路径算,不靠字符串猜)
  const parentOf = (d: string) => d.replace(/[\\/][^\\/]*$/, '');
  const childrenOf = (d: string) => all.filter((x) => x !== d && parentOf(x) === d);

  let parent: string | null = null;
  for (const d of all) {
    if (childrenOf(d).length) { parent = d; break; }
  }

  const isDescendant = (x: string, d: string) =>
    x !== d && (x.startsWith(d + '\\') || x.startsWith(d + '/'));

  if (!parent) {
    console.log(`  (跳过:这个小库里没有嵌套目录,共 ${all.length} 个目录)`);
  } else {
    const exact = db.queryImages({ relDir: parent, limit: 1 }).total;
    const rec = db.queryImages({ relDir: parent, relDirRecursive: true, limit: 1 }).total;
    const direct = childrenOf(parent);
    const subtreeDirs = [parent, ...all.filter((x) => isDescendant(x, parent))];
    const subtreeTotal = subtreeDirs.reduce((s, d) => s + db.queryImages({ relDir: d, limit: 1 }).total, 0);

    console.log(`  父目录「${parent}」:精确 ${exact} 张 / 递归 ${rec} 张 / 子树逐目录求和 ${subtreeTotal} 张`);
    if (rec === subtreeTotal) good('递归结果 == 子树里每个目录各自求和(口径就是"这个文件夹下所有图")');
    else bad(`递归结果(${rec})与子树求和(${subtreeTotal})不一致`);
    if (rec >= exact) good('递归结果不少于精确结果');
    else bad(`递归结果(${rec})少于精确结果(${exact})`);
    console.log(`  直接子目录 ${direct.length} 个:${direct.slice(0, 4).join(', ')}${direct.length > 4 ? ' …' : ''}`);

    // 前缀相近的"兄弟目录"不能被误伤:比 parent 多一个字符、但不是它的子目录
    const near = all.filter(
      (x) => !isDescendant(x, parent) && parentOf(x) !== parent && (x.startsWith(parent + '1') || x.startsWith(parent + '_') || x.startsWith(parent + '-'))
    );
    if (near.length) {
      const nearTotal = near.reduce((s, x) => s + db.queryImages({ relDir: x, limit: 1 }).total, 0);
      console.log(`  前缀相近目录:${near.join(', ')}(共 ${nearTotal} 张)`);
      if (rec < subtreeTotal + nearTotal) good('LIKE 通配没有把"名字前缀相近"的兄弟目录算进来');
      else bad('递归匹配把前缀相近的兄弟目录也算进来了');
    } else {
      good('(库里没有前缀相近的目录,跳过这条)');
    }
  }
  db.close();
}

console.log('\n' + (failures === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${failures} 项)`));
process.exit(failures === 0 ? 0 : 1);
