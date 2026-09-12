/**
 * 校验"服务托管版页面"的 HTML 结构与其内嵌 JS 的语法。
 *
 * 为什么需要:这份页面是从 TS 模板字符串里生成的 HTML,里面嵌了一大段 JS。
 * 之前只验证了"生成成功 + 含某些字符串",**内嵌 JS 的语法一次都没检查过**。
 * 一个引号写错就会让整页白屏,而我在沙箱里无法开浏览器确认。
 *
 * 做法:把 <script> 里的内容抽出来,交给 Node 的解析器做语法检查
 * (页面里的 JS 不用 TS 语法,所以直接 new Function 就能验证,
 *  但 new Function 会执行——所以改用 vm.Script 只编译不运行)。
 *
 *   node tools/verify-webpage.ts [页面路径]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.argv[2] ? path.resolve(process.argv[2]) : path.join(PROJECT, 'web', 'index.html');

let failures = 0;
const good = (m: string) => console.log('  ok    ' + m);
const bad = (m: string) => {
  failures++;
  console.log('  FAIL  ' + m);
};

if (!fs.existsSync(FILE)) {
  console.error('页面不存在: ' + FILE);
  process.exit(1);
}

const html = fs.readFileSync(FILE, 'utf8');
console.log('页面结构校验');
console.log(`  文件  ${FILE}`);
console.log(`  体积  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB\n`);

// ---------------------------------------------------------------- 1) 基本结构

console.log('--- 1) HTML 基本结构 ---');
const checks: Array<[RegExp | string, string, boolean]> = [
  [/^<!DOCTYPE html>/i, 'DOCTYPE 声明', true],
  [/<html[^>]*lang="zh-CN"/, 'html lang=zh-CN', true],
  [/<meta charset="utf-8">/i, 'UTF-8 声明', true],
  [/<div id="root">|<div id="grid">/, '主容器存在', true],
  [/<\/html>\s*$/, '以 </html> 结尾', true],
];
for (const [re, why, must] of checks) {
  const hit = typeof re === 'string' ? html.includes(re) : re.test(html);
  if (hit === must) good(why);
  else bad(`缺少: ${why}`);
}

// script 标签配对
const openScripts = (html.match(/<script\b[^>]*>/gi) ?? []).length;
const closeScripts = (html.match(/<\/script>/gi) ?? []).length;
if (openScripts === closeScripts && openScripts > 0) good(`script 标签配对 (${openScripts} 开 / ${closeScripts} 闭)`);
else bad(`script 标签不配对 (${openScripts} 开 / ${closeScripts} 闭)`);

// ---------------------------------------------------------------- 2) 内嵌 JS 语法

console.log('\n--- 2) 内嵌 JS 语法(只编译不执行)---');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
if (!scripts.length) {
  bad('没有找到任何 <script> 块');
} else {
  scripts.forEach((m, i) => {
    const code = m[1];
    if (!code.trim()) {
      good(`script[${i}] 为空(可能是外链),跳过`);
      return;
    }
    try {
      // vm.Script 只做编译,不会执行 —— 这点很关键,页面里的启动逻辑会发 fetch
      new vm.Script(code, { filename: `webpage-script-${i}.js` });
      good(`script[${i}] 语法合法 (${(code.length / 1024).toFixed(1)} KB)`);
    } catch (e) {
      bad(`script[${i}] 语法错误: ${(e as Error).message.split('\n')[0]}`);
    }
  });
}

// ---------------------------------------------------------------- 3) 契约一致性

console.log('\n--- 3) 页面用到的 /api 端点是否存在 ---');
const used = new Set<string>();
for (const m of html.matchAll(/['"`](\/api\/[A-Za-z0-9_/:.\-${}]*)/g)) {
  // 去掉模板变量部分,保留端点前缀
  let u = m[1].replace(/\$\{[^}]*\}/g, ':id');
  u = u.replace(/\/:[^/]*/g, '/:id');
  used.add(u);
}
const serverSrc = fs.readFileSync(path.join(PROJECT, 'src/server/index.ts'), 'utf8');
const declared = new Set<string>();
for (const m of serverSrc.matchAll(/route\('([A-Z]+)', '([^']+)'/g)) {
  declared.add(m[2]);
}
// 允许一些动态拼接(页面里 '/api/file/' + id 这种),按"字面前缀 + 段数"匹配
const declaredList = [...declared];
function matchesDeclared(u: string): boolean {
  // u 形如 /api/categories/:id ;页面里模板拼接会留下 /api/file/ 这种半截
  const uSeg = u.replace(/\/$/, '').split('/').filter(Boolean);
  for (const d of declaredList) {
    const dSeg = d.split('/').filter(Boolean);
    // 页面的段数 <= 声明的段数,且每段要么相同、要么页面那段是变量、要么页面少一段(前缀拼接)
    let ok = true;
    for (let i = 0; i < uSeg.length; i++) {
      const a = uSeg[i];
      const b = dSeg[i];
      if (b === undefined) { ok = false; break; }
      if (a === b) continue;
      if (b.startsWith(':')) continue;
      if (a.startsWith(':')) continue;
      ok = false;
      break;
    }
    if (ok) return true;
  }
  return false;
}
const missing: string[] = [];
for (const u of [...used].sort()) {
  if (matchesDeclared(u)) good(`页面用到的 ${u} 在服务端已注册`);
  else missing.push(u);
}
if (missing.length) bad(`页面用到但服务端没有的端点: ${missing.join(', ')}`);

// ---------------------------------------------------------------- 4) 需求字段

console.log('\n--- 4) 详情字段是否符合需求 ---');
const REQUIRED = ['像素尺寸', '模型', '调度器', '步数', 'CFG', 'seed', 'LoRA', '正向提示词', '负向提示词', '生成日期'];
const missFields = REQUIRED.filter((f) => !html.includes(f));
if (missFields.length === 0) good(`需求字段齐全 (${REQUIRED.length} 项)`);
else bad(`缺少字段: ${missFields.join('、')}`);

// 采样器必须已移除(只看正文,不看注释)
const noComments = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
if (noComments.includes('采样器')) bad('页面出现「采样器」—— 用户已要求移除');
else good('未展示采样器(符合用户要求)');

// 数据缺失兜底
if (html.includes('未记录')) good('有「未记录」兜底');
else bad('缺少「未记录」兜底');

console.log('\n' + (failures === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${failures} 项)`));
process.exit(failures === 0 ? 0 : 1);
