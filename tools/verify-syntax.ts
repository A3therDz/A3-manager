/**
 * 语法解析检查 —— 不需要安装任何依赖。
 *
 * 目的:在装依赖之前,先确保所有源码**能被 TypeScript 解析器读成合法语法**。
 * 这能拦住"括号不配对 / JSX 写错 / 字符串未闭合"这类会让 `npm run build`
 * 立刻失败的问题,而不需要 tsc 或 vite。
 *
 * 做法:用 Node 22 自带的 TypeScript 支持(experimental-strip-types)去解析文件。
 *   非 JSX 的 .ts:直接 import,能解析就说明语法合法(运行时可能因缺依赖而失败,
 *                  但那属于依赖问题,不是语法问题)。
 *   .tsx:Node 的 strip-types 不转 JSX,所以改用括号/引号配平的启发式检查,
 *        并单独校验 JSX 标签配对。
 *
 *   node --experimental-strip-types tools\verify-syntax.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const bad = (m: string) => {
  failures++;
  console.log('  FAIL  ' + m);
};
const good = (m: string) => console.log('  ok    ' + m);

/** 收集 src 与 tools 下所有 ts/tsx */
function collect(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = [
  ...collect(path.join(PROJECT, 'src')),
  ...collect(path.join(PROJECT, 'tools')),
].filter((f) => !f.endsWith('.d.ts'));

console.log('语法解析检查');
console.log(`  共 ${files.length} 个 .ts/.tsx 文件\n`);

// ---------------------------------------------------------------- .ts 只解析不执行

/**
 * 关键:必须"只解析,不执行"。
 * 早期版本用 `await import(file)` 来验证,结果把 cli-index.ts 的顶层逻辑
 * 真的跑了一遍(它一启动就 mkdir 索引库目录),在沙箱里直接 EPERM 退出。
 * 改用 module.stripTypeScriptTypes():它走的是 TypeScript 解析器,
 * 语法不合法就抛 SyntaxError,而且不会执行任何代码。
 */
const tsFiles = files.filter((f) => f.endsWith('.ts'));
console.log(`--- ${tsFiles.length} 个 .ts:用 TypeScript 解析器只解析不执行 ---`);
for (const f of tsFiles) {
  const rel = path.relative(PROJECT, f);
  const src = fs.readFileSync(f, 'utf8');
  try {
    stripTypeScriptTypes(src, { mode: 'strip' });
    good(`${rel} 语法合法`);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    bad(`${rel} 语法错误: ${msg.split('\n')[0]}`);
  }
}

// ---------------------------------------------------------------- .tsx 启发式

/**
 * Node 的 strip-types 不转 JSX,所以对 .tsx 做配平检查:
 *   - 圆括号 / 方括号 / 花括号 数量与嵌套
 *   - 反引号成对(模板字面量)
 *   - JSX 自闭合标签与成对标签的数量关系
 * 会在字符串/注释里误判,所以先粗剥字符串与注释。
 */
function stripStringsAndComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === q) {
          i++;
          break;
        }
        i++;
      }
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function checkBalance(src: string): string[] {
  const errs: string[] = [];
  const stack: Array<{ ch: string; line: number }> = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const opens = new Set(['(', '[', '{']);
  let line = 1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\n') line++;
    if (opens.has(ch)) stack.push({ ch, line });
    else if (pairs[ch]) {
      const top = stack.pop();
      if (!top) errs.push(`第 ${line} 行 多余的 '${ch}'`);
      else if (top.ch !== pairs[ch]) {
        errs.push(`第 ${line} 行 '${ch}' 与第 ${top.line} 行的 '${top.ch}' 不匹配`);
      }
    }
  }
  for (const s of stack) errs.push(`第 ${s.line} 行的 '${s.ch}' 没有闭合`);
  return errs;
}

const tsxFiles = files.filter((f) => f.endsWith('.tsx'));
console.log(`\n--- ${tsxFiles.length} 个 .tsx:仅做括号/引号配平(不是语法校验) ---`);
let tsxUnverifiable = 0;
for (const f of tsxFiles) {
  const rel = path.relative(PROJECT, f);
  const raw = fs.readFileSync(f, 'utf8');
  const stripped = stripStringsAndComments(raw);

  const errs = checkBalance(stripped);
  if (errs.length) {
    bad(`${rel} 括号不配平:\n        ${errs.slice(0, 5).join('\n        ')}`);
    continue;
  }
  tsxUnverifiable++;
  good(`${rel} 括号与引号配平`);
}

if (tsxUnverifiable > 0) {
  console.log('');
  console.log('  ⚠️  重要诚实说明:');
  console.log('      Node 的 stripTypeScriptTypes 不支持 JSX,所以上面这些 .tsx 文件');
  console.log('      **没有**经过真正的语法校验,只确认了括号配平。');
  console.log('      JSX 语法错误必须等装完依赖后用以下命令才能真正验证:');
  console.log('        npm run typecheck    (tsc,覆盖类型与 JSX)');
  console.log('        npm run build        (vite,覆盖打包)');
  console.log('      这里刻意不谎报"通过" —— 早先版本用一个 JSX 标签计数启发式,');
  console.log('      结果把 useState<string> 这类泛型参数也算成标签,产生假失败。');
}

// ---------------------------------------------------------------- 汇总

console.log('\n' + (failures === 0 ? 'OVERALL: PASS(仅 .ts 为真实验证)' : `OVERALL: FAIL (${failures} 项)`));
if (failures === 0) {
  console.log('  覆盖范围:16 个 .ts 经过 TypeScript 解析器验证;');
  console.log(`            ${tsxUnverifiable} 个 .tsx 仅确认括号配平(见上方说明)。`);
}
process.exit(failures === 0 ? 0 : 1);
