/**
 * v0.7 回归验证 —— 对应 v0.7 改进计划的六条需求(纯静态契约,不需要数据库):
 *
 *   node --experimental-strip-types tools/verify-v07.ts
 *
 *   1. 右键菜单测量定位(不再硬编码高度)
 *   2. 「移出分类」(右键菜单 / 批量条 / 详情面板 chip)
 *   3. 详情面板恢复「采样器」行
 *   4. 多选模式 + 批量复制到文件夹(copyImagesToFolder 契约链)
 *   5. 浮窗磨砂化 + 收起退场 + 点击穿透开关(petClickThrough 契约链)
 *   6. 弹层 / toast 统一退场动画(.closing),清死代码
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

console.log('=== A1) 需求 1:右键菜单测量定位(绘制前读真实高度) ===');
mustHave('src/renderer/App.tsx', 'offsetHeight', 'App.tsx 用 offsetHeight 量出菜单真实高度');
mustNotHave('src/renderer/App.tsx', 'innerHeight - 240', '不再硬编码 innerHeight - 240 估算菜单高度');

console.log('\n=== A2) 需求 2:「移出分类」(右键菜单 / 批量条 / 详情 chip) ===');
mustHave('src/renderer/App.tsx', '移出分类…', '右键菜单 / 批量条有「移出分类…」入口');
mustHave('src/renderer/components/DetailPanel.tsx', 'cam-chip-x', '详情面板分类 chip 有 ✕ 移出按钮');
mustHave('src/renderer/components/DetailPanel.tsx', '已移出「', 'chip 移出后有 toast 反馈');

console.log('\n=== A3) 需求 3:详情面板恢复「采样器」行 ===');
mustHave('src/renderer/components/DetailPanel.tsx', '<KV k="采样器"', '详情面板展示采样器(没有记录时显示"未记录")');

console.log('\n=== A4) 需求 4:多选模式 + 批量复制到文件夹 ===');
mustHave('src/renderer/App.tsx', 'selectMode', '有多选模式开关');
mustHave('src/renderer/App.tsx', 'cam-tb-select', '工具条有「多选」开关按钮');
mustHave('src/shared/types.ts', 'copyImagesToFolder', 'types.ts 契约声明 copyImagesToFolder');
mustHave('src/main/index.ts', "handle('copyImagesToFolder'", '主进程注册 copyImagesToFolder handler');
mustHave('src/preload/index.cjs', 'copyImagesToFolder', 'preload 桥接 copyImagesToFolder');
mustHave('src/renderer/api.ts', 'copyImagesToFolder', '渲染端 api.ts 暴露 copyImagesToFolder');

console.log('\n=== A5) 需求 5:浮窗磨砂化 + 收起退场 + 点击穿透 ===');
mustNotHave('src/renderer/pet/pet.css', 'prefers-color-scheme', 'pet.css 无强制深色覆写(主题走 :root 变量 + data-theme)');
mustHave('src/renderer/pet/pet.css', 'pet-panel-out', 'pet.css 定义 pet-panel-out 收起退场关键帧');
mustHave('src/renderer/pet/main.tsx', 'pet-panel-out', 'pet/main.tsx 引用 pet-panel-out(动画时长与 CSS 对齐)');
mustHave('src/shared/types.ts', 'petClickThrough: boolean', 'types.ts 设置里有 petClickThrough');
mustHave('src/main/index.ts', 'petClickThrough', '主进程处理 petClickThrough(applyPetClickThrough)');
mustHave('src/renderer/App.tsx', 'petClickThrough', '设置面板有「点击穿透」开关');

console.log('\n=== A6) 需求 6:弹层 / toast 统一退场动画,清死代码 ===');
mustHave('src/renderer/App.tsx', "closing ? ' closing' : ''", '弹层挂载点带 .closing 退场标记');
mustHave('src/renderer/main.tsx', '.cam-modal.closing', '弹层 .closing 有退场动画样式');
mustHave('src/renderer/main.tsx', '.cam-toast.closing', 'toast .closing 有退场动画样式');
mustNotHave('src/renderer/main.tsx', 'cam-petw', '死代码 .cam-petw 已删');
mustNotHave('src/renderer/main.tsx', 'cam-menu-in', '死代码 cam-menu-in 已删');
mustNotHave('src/renderer/main.tsx', 'cam-petpanel', '死代码 .cam-petpanel 已删');

console.log(`\nOVERALL: ${failures === 0 ? 'PASS' : `FAIL(${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
