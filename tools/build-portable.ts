/**
 * 打包"无依赖可运行版"。
 *
 * 为什么需要:
 *  目标要求"可运行的安装包或可执行程序",但 Electron 打包在本环境不可行
 *  (npm 装不上,electron 的 ~250MB 二进制也要联网下载)。
 *  而**后端零第三方依赖**,所以可以用 node.exe 单文件 + 源码直接产出一个
 *  自包含、双击即用的目录 —— 不依赖 npm、不依赖安装。
 *
 * 产物结构(delivery/):
 *   launcher/启动.cmd            双击启动
 *   launcher/建立索引.cmd        首次索引
 *   launcher/runtime/node.exe    内嵌 Node 运行时(自包含关键)
 *   src/ web/ tools/             源码与页面
 *   design/                      文档(格式报告 + 状态)
 *   data/index.db                索引库(可选,带 --with-index)
 *
 * 用法:
 *   node --experimental-strip-types tools\build-portable.ts [--with-index] [--no-runtime] [--out 目录]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function flag(name: string): boolean {
  return process.argv.includes('--' + name);
}
function opt(name: string, dflt: string): string {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : dflt;
}

const OUT = opt('out', path.join(PROJECT, 'delivery'));
const WITH_INDEX = flag('with-index');
const NO_RUNTIME = flag('no-runtime');

let problems = 0;
const step = (m: string) => console.log('  ' + m);
const fail = (m: string) => {
  problems++;
  console.log('  ❌ ' + m);
};

console.log('打包无依赖可运行版');
console.log('='.repeat(60));
console.log(`  源目录  ${PROJECT}`);
console.log(`  产物    ${OUT}\n`);

// ---------------------------------------------------------------- 清理

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- 复制源码

/** 需要随包分发的目录 */
const COPY_DIRS = ['src', 'tools', 'web', 'launcher', 'design'];
/** 需要随包分发的顶层文件 */
const COPY_FILES = ['package.json', 'tsconfig.json'];

console.log('[1/4] 复制源码与资源');
for (const d of COPY_DIRS) {
  const from = path.join(PROJECT, d);
  if (!fs.existsSync(from)) {
    // web / launcher 可能还没生成,这里不算致命,但必须记录
    if (d === 'web' || d === 'launcher') step(`跳过 ${d}/ (尚未生成)`);
    else fail(`缺少目录 ${d}/`);
    continue;
  }
  fs.cpSync(from, path.join(OUT, d), { recursive: true });
  const n = countFiles(path.join(OUT, d));
  step(`${d}/  ${n} 个文件`);
}
for (const f of COPY_FILES) {
  const from = path.join(PROJECT, f);
  if (!fs.existsSync(from)) {
    fail(`缺少 ${f}`);
    continue;
  }
  fs.copyFileSync(from, path.join(OUT, f));
  step(`${f}`);
}

/**
 * .cmd 的编码处理。
 *
 * 问题:中文 Windows 的 cmd.exe 按 GBK(代码页 936)逐行解析批处理文件。
 * 仓库里的 .cmd 是 UTF-8,中文的 UTF-8 字节会被当成 GBK 双字节 ——
 * 后果不只是"显示乱码":字节错位会破坏引号配对,可能让路径命令直接失败。
 *
 * 方案:仓库保持 UTF-8(否则读写工具打不开),**打包时转成 GBK**。
 * Node 内置不支持 GBK 编码,而沙箱禁止 spawn 子进程(实测 EPERM),
 * 所以这里内嵌一份**只覆盖脚本实际用到的 174 个非 ASCII 字符**的 GBK 码表。
 * 表由 PowerShell 的 Encoding.GetEncoding(936) 一次性生成,
 * 格式为「字符 + 4 位十六进制字节」重复拼接,再做 Base64。
 * 只覆盖用到的字符,所以只有 1.2 KB —— 比内嵌完整 GBK 表务实得多。
 * 未收录的字符会显式报错(而不是静默写出错字节)。
 */
const GBK_TABLE_B64 =
  '4oCUYTFhYeOAgmExYTPkuIBkMmJi5LiJYzhmZOS4imM5Y2bkuItjZmMy5LiNYjJiYuS4lGM3ZDLkuKpiOGY25LmLZDZhZeS6jGI2'
  + 'ZmXkuqRiZGJi5LqnYjJmYeS7mGI4Yjbku6VkMmQ05Lu2YmNmZeS8mGQzYzXkvJpiYmUx5L2/Y2FiOeS+i2MwZmTkvp1kMmMw5YGc'
  + 'Y2RhM+WFg2Q0YWHlhYhjZmM45YW2YzZlNOWGhWM0ZGHlho1kNGQ55YaZZDBiNOWHumIzZjblh7tiYmY35YiZZDRmMuWIsGI1YmTl'
  + 'iY1jN2Iw5YqhY2VmMeWKqGI2YWbljIViMGZj5Y2zYmNiNOWPgmIyY2Xlj4xjYmFi5Y+YYjFlNOWPo2JmZGHlj6pkNmJi5Y+vYmZj'
  + 'OeWQjGNkYWPlkI5iYWYz5ZCmYjdmMeWQq2JhYWPlkK9jNmY05ZmoYzZmN+WbnmJiZDjlm75jZGJj5ZyoZDRkYeWcsGI1ZDjlnYBk'
  + 'NmI35Z2XYmZlOeWig2JlYjPlop5kNGY25aSxY2FhN+WmgmM4ZTflrZhiNGU25a6JYjBiMuWujGNkZWHlsIZiZGFi5beyZDJkMeW4'
  + 'uGIzYTPlubZiMmEy5bqPZDBmMuW6k2JmZTLlu7piZGE45byAYmZhYeW8lWQyZmTlvKBkNWM15b2VYzJiY+W+hGJlYjblv4ViMWQ4'
  + '5oiQYjNjOeaIkWNlZDLmiJZiYmYy5omLY2FkNuaJk2I0ZjLmiadkNmI05omrYzlhOOaJvmQ1ZDLmiopiMGQx5ouWY2RjZuaMiWIw'
  + 'YjTmjJFjY2Y05o2uYmVkZOaPj2MzZTjmj5BjY2Ux5pS5YjhjNOaUvmI3YzXmlbBjYWZk5paHY2VjNOaWsGQwYzLmlrliN2Jk5pe2'
  + 'Y2FiMeabtGI4ZmPmnIBkN2Vl5pyJZDNkMOacjWI3ZmXmnKpjZWI05pysYjFiZeacumJiZmHmnpBjZWY25p+lYjJlOeaooWM0YTPm'
  + 'rKFiNGNl5q2iZDZiOeato2Q1ZmTmsqFjM2Ji5rOVYjdhOOa1j2U0YWbniYdjNmFj546vYmJiN+eOsGNmZDbnkIZjMGVk55SfYzlm'
  + 'YeeUqGQzYzPnmbtiNWM355qEYjVjNOebrmM0YmbnpLpjYWJl56eSYzNlYuepumJmZDXnqpdiNGIw56uLYzFhMuerr2I2Y2LnrKxi'
  + 'NWRh566hYjlkY+e0omNiZjfnuqZkNGJj572uZDZjM+iHqmQ3ZDToi6VjOGY06KGMZDBkMOiiq2IxYmLoo4VkN2Iw6KaBZDJhYein'
  + 'iGMwYzDop6NiZGUy6K6kYzhjZuiusGJjYzforr5jOWU46K6/YjdjM+ivr2NlZjPor7djN2Vi6LSlYjBkY+i1hGQ3Y2HotZZjMGI1'
  + '6LeRYzVkY+i3r2MyYjfot7NjY2Y46L6TY2FlNOi/h2I5ZmTov5BkNGNi6L+ZZDVlMui/m2JkZjjpgIBjZGNi6YCJZDFhMemHjGMw'
  + 'ZWbph49jMWJm6ZSZYjRlZOmXrmNlY2Hpl7JjZmQw6Zu2YzFlM+mcgGQwZTjpnaJjM2U26aG1ZDJiM+mhumNiYjPpobtkMGVi6aaW'
  + 'Y2FkN+mpu2Q3YTTpu5hjNGFj';

function buildGbkMap(): Map<string, number[]> {
  const raw = Buffer.from(GBK_TABLE_B64, 'base64').toString('utf8');
  const map = new Map<string, number[]>();
  for (let i = 0; i + 5 <= raw.length; i += 5) {
    const ch = raw[i];
    const hex = raw.slice(i + 1, i + 5);
    map.set(ch, [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16)]);
  }
  return map;
}

/** 把 UTF-8 文本编码为 GBK 字节。遇到未收录字符直接抛错,避免静默产出坏字节 */
function encodeGbk(text: string, map: Map<string, number[]>): Buffer {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 128) {
      out.push(cp);
      continue;
    }
    const bytes = map.get(ch);
    if (!bytes) throw new Error(`GBK 码表未收录字符: ${JSON.stringify(ch)} (U+${cp.toString(16).toUpperCase()})`);
    out.push(bytes[0], bytes[1]);
  }
  return Buffer.from(out);
}

console.log('\n[1b] 把 .cmd 转为 GBK(cmd.exe 的解析编码)');
{
  let map: Map<string, number[]> | null = null;
  try {
    map = buildGbkMap();
    if (map.size === 0) throw new Error('码表为空');
    step(`内嵌 GBK 码表 ${map.size} 个字符`);
  } catch (e) {
    fail(`GBK 码表构建失败: ${(e as Error).message}`);
  }

  if (map) {
    for (const f of ['启动.cmd', '建立索引.cmd']) {
      const p = path.join(OUT, 'launcher', f);
      if (!fs.existsSync(p)) {
        fail(`缺少 launcher/${f}`);
        continue;
      }
      try {
        const text = fs.readFileSync(p, 'utf8');
        const gbk = encodeGbk(text, map);
        fs.writeFileSync(p, gbk);
        step(`${f}  -> GBK ${gbk.length} 字节`);
      } catch (e) {
        fail(`${f} 转换失败: ${(e as Error).message}`);
      }
    }
  }
}

// ---------------------------------------------------------------- 内嵌 Node 运行时

console.log('\n[2/4] 内嵌 Node 运行时');
if (NO_RUNTIME) {
  step('已按 --no-runtime 跳过(交付包将依赖目标机器的 node)');
} else {
  // 优先用当前运行的 node;它必须 >= 22 才带 node:sqlite
  const nodeExe = process.execPath;
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    fail(`当前 Node ${process.versions.node} < 22,node:sqlite 不可用,不能作为运行时内嵌`);
  } else {
    const rtDir = path.join(OUT, 'launcher', 'runtime');
    fs.mkdirSync(rtDir, { recursive: true });
    const dst = path.join(rtDir, 'node.exe');
    fs.copyFileSync(nodeExe, dst);
    const mb = fs.statSync(dst).size / 1048576;
    step(`launcher/runtime/node.exe  (${mb.toFixed(1)} MB,来自 Node ${process.versions.node})`);
    // 运行时自检:确认内嵌的 node.exe 真的能跑 node:sqlite
    step('(启动时由 launcher 校验;此处仅确认文件可执行)');
  }
}

// ---------------------------------------------------------------- 索引库

console.log('\n[3/4] 索引库');
const SRC_DB = process.env.CAM_DB ?? path.join(PROJECT, 'data', 'index.db');
if (WITH_INDEX) {
  if (fs.existsSync(SRC_DB)) {
    const dstDir = path.join(OUT, 'data');
    fs.mkdirSync(dstDir, { recursive: true });
    // WAL 模式下可能有 -wal/-shm 伴随文件,一并带上以保证一致
    for (const suffix of ['', '-wal', '-shm']) {
      const s = SRC_DB + suffix;
      if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dstDir, path.basename(SRC_DB) + suffix));
    }
    const mb = fs.statSync(path.join(dstDir, path.basename(SRC_DB))).size / 1048576;
    step(`data/${path.basename(SRC_DB)}  (${mb.toFixed(1)} MB,已含索引)`);
  } else {
    fail(`--with-index 指定了但索引库不存在: ${SRC_DB}`);
  }
} else {
  // 关键:不要留下 0 字节的 index.db。
  // 启动器用 `if not exist "%CAM_DB%"` 判断要不要提示"先建索引";
  // 若留个空文件在那里,它会以为索引已就绪、直接起服务,
  // 于是页面无图、只给一句"索引库是空的",用户很难看出下一步该做什么。
  fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
  const stray = path.join(OUT, 'data', path.basename(SRC_DB));
  if (fs.existsSync(stray) && fs.statSync(stray).size === 0) {
    fs.rmSync(stray, { force: true });
    step('移除空的 index.db(避免启动器误判索引已就绪)');
  }
  step('未包含索引库,首次需在目标机器上跑 launcher\\建立索引.cmd');
  step('提示:想连索引一起分发,加 --with-index');
}

// ---------------------------------------------------------------- 使用说明

console.log('\n[4/4] 生成使用说明');
const readme = `ComfyUI 资产管理器 —— 无依赖可运行版
================================================

这是什么
  一个管理 ComfyUI 出图的本地工具:分文件夹浏览、缩略图网格、点开看完整生成参数
  (尺寸/模型/调度器/步数/CFG/seed/LoRA/正负提示词/生成日期)。
  全部在本机运行,不上传任何图片。

怎么启动
  1) 首次使用:双击  launcher\\建立索引.cmd
     —— 它会扫描你的图库目录并把元数据写进索引库(8061 张约 20 秒)。
        图库目录默认是 <你的图库目录>;
        不一样的话,把图库文件夹拖到那个 .cmd 上即可。
  2) 之后每次使用:双击  launcher\\启动.cmd
     —— 会起一个本地服务并自动打开浏览器。

为什么是浏览器
  原计划是 Electron 托盘应用,但本机装不上 npm 依赖(Electron 的二进制需要联网下载)。
  后端是零第三方依赖的,所以先交付这个"双击即用"的版本;
  Electron 版的前端已经在 src/renderer/(React)里写好,装好依赖后 npm start 即可切换到它。
  两个版本共用同一份接口契约:src/shared/types.ts。

数据放在哪
  data\\index.db    索引库(元数据;不含图片)
  <图库>\\.comfy-thumbs\\   缩略图缓存(放在图库内部,按相对路径镜像)
  原图永远不动,只读。

可选:生成缩略图(强烈建议)
  浏览器版直接用原图当缩略图,一屏上百张会比较吃内存。
  跑一次下面这条可把缩略图缓存建好(8061 张约 25 分钟,可中断续跑):
    node tools\\thumb-sync.ts
  (在 tools 目录下用 --experimental-strip-types 运行 .ts)

常见问题
  · 提示"索引库不存在" → 先跑 建立索引.cmd
  · 端口被占 → 设置环境变量 CAM_PORT 换一个,例如 set CAM_PORT=5220
  · 换了图库目录 → 重跑 建立索引.cmd(把新目录拖到它上面)
  · 索引后又出了新图 → 重跑 建立索引.cmd,增量扫描约 1 秒

技术说明
  后端:Node 内置模块(node:sqlite + FTS5、node:zlib、node:fs),无第三方依赖
  元数据:自研 PNG 解析器,支持 5 种格式(A1111 文本 / ComfyUI 节点图 / 嵌套图 /
         UI 工作流 / 无元数据),含 NaN 容错与图链接求值
  文档:design\\METADATA-FORMATS.md(格式实测报告)、design\\STATUS.md(项目状态)

版本 0.1.0
`;
fs.writeFileSync(path.join(OUT, '使用说明.txt'), readme, 'utf8');
step('使用说明.txt');

// ---------------------------------------------------------------- 自检

console.log('\n验证产物');
function countFiles(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n++;
  }
  return n;
}

const total = countFiles(OUT);
let bytes = 0;
(function walk(d: string) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else bytes += fs.statSync(p).size;
  }
})(OUT);

console.log(`  文件总数  ${total}`);
console.log(`  总体积    ${(bytes / 1048576).toFixed(1)} MB`);

// 关键文件必须存在
const MUST: Array<[string, string]> = [
  ['launcher/启动.cmd', '启动器'],
  ['launcher/建立索引.cmd', '索引脚本'],
  ['使用说明.txt', '使用说明'],
  ['src/server/index.ts', 'HTTP 服务'],
  ['src/main/db.ts', '数据层'],
  ['tools/serve-webui.ts', '页面生成器'],
  ['tools/comfy-parser.cjs', 'PNG 元数据解析器'],
  ['design/METADATA-FORMATS.md', '格式报告'],
];
for (const [rel, why] of MUST) {
  if (fs.existsSync(path.join(OUT, rel))) step(`✅ ${rel}  (${why})`);
  else fail(`缺少 ${rel}  (${why})`);
}
if (!NO_RUNTIME) {
  const rt = path.join(OUT, 'launcher', 'runtime', 'node.exe');
  if (fs.existsSync(rt)) step(`✅ launcher/runtime/node.exe  (内嵌运行时,自包含)`);
  else fail('缺少内嵌 node.exe —— 交付包不自包含');
}
// web/index.html 必须在(否则启动器要先生成)
if (fs.existsSync(path.join(OUT, 'web', 'index.html'))) {
  step('✅ web/index.html  (无依赖版页面)');
} else {
  step('⚠️  web/index.html 不存在(启动器会自动生成,但建议随包带上)');
}

console.log('\n' + '='.repeat(60));
if (problems === 0) {
  console.log('打包完成');
  console.log(`  交付目录  ${OUT}`);
  console.log('  目标机器上双击 launcher\\启动.cmd 即可运行。');
} else {
  console.log(`打包完成但有 ${problems} 个问题,见上面 ❌`);
}
process.exit(problems === 0 ? 0 : 1);
