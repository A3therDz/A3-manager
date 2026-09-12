/**
 * 一次性工具:把 GBK 码表嵌入 tools/build-portable.ts。
 *
 * 为什么单独写一个:用 PowerShell 做替换时,`"`n"` 在双引号串里不会被展开,
 * 结果生成了字面量的 \n,把 TS 字符串写坏。Node 里字符串处理不会踩这个坑。
 *
 *   node tools/_embed-gbk.cjs <base64 文件>
 */
const fs = require('node:fs');
const path = require('node:path');

const src = process.argv[2];
if (!src) {
  console.error('用法: node tools/_embed-gbk.cjs <含 base64 码表的文件>');
  process.exit(1);
}

// 基于脚本自身位置解析路径,而不是依赖调用者的 cwd
const PROJECT = path.resolve(__dirname, '..');
const TARGET = path.join(PROJECT, 'tools', 'build-portable.ts');
const b64File = path.resolve(src);
const b64 = fs.readFileSync(b64File, 'utf8').replace(/\s+/g, '');

// 按 100 字符折行,用真正的换行符(不是字面量 \n)
const chunks = [];
for (let i = 0; i < b64.length; i += 100) chunks.push(b64.slice(i, i + 100));
const literal = chunks.map((c, i) => (i === 0 ? `'${c}'` : `  + '${c}'`)).join('\n');

let text = fs.readFileSync(TARGET, 'utf8');

// 把整个 const GBK_TABLE_B64 = ...; 换成新值
const re = /const GBK_TABLE_B64 =[\s\S]*?;/;
if (!re.test(text)) {
  console.error('在 ' + TARGET + ' 里找不到 const GBK_TABLE_B64 = ...;');
  process.exit(1);
}
text = text.replace(re, `const GBK_TABLE_B64 =\n  ${literal};`);
fs.writeFileSync(TARGET, text, 'utf8');

console.log(`已嵌入码表:${b64.length} 字符,折成 ${chunks.length} 行`);
console.log(`目标文件:${TARGET}`);
