#!/usr/bin/env node
/**
 * 索引 CLI —— 在不上 Electron 的情况下验证索引层。
 *
 * 用法:
 *   node --experimental-strip-types src/main/cli-index.ts add "<你的图库目录>"
 *   node --experimental-strip-types src/main/cli-index.ts scan [--force]
 *   node --experimental-strip-types src/main/cli-index.ts stats
 *   node --experimental-strip-types src/main/cli-index.ts tree
 *   node --experimental-strip-types src/main/cli-index.ts query "女孩" [--limit 10]
 *   node --experimental-strip-types src/main/cli-index.ts get <id>
 *   node --experimental-strip-types src/main/cli-index.ts filter
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AssetDb } from './db.ts';
import { scanLibrary } from './indexer.ts';

const DATA_DIR = process.env.CAM_DATA_DIR ?? path.join(os.homedir(), '.comfy-asset-manager');
const DB_FILE = process.env.CAM_DB ?? path.join(DATA_DIR, 'index.db');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string) => args.includes('--' + name);
const optVal = (name: string): string | undefined => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};

/**
 * 取出"位置参数"。
 *
 * 早期实现是 `args.slice(1).filter(a => !a.startsWith('--'))`,它只丢掉 flag 本身,
 * 却把 flag 的**值**留在了位置参数里 —— 于是 `query --category 2` 会变成
 * 搜索词 "2"。这里显式跳过"以 -- 开头"的 token 及其后紧跟的值。
 */
function positionals(): string[] {
  const out: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      // 跳过该 flag 的值(如果有,且不是另一个 flag)
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const dbDir = path.dirname(DB_FILE);
if (!fs.existsSync(dbDir)) {
  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch (e) {
    console.error(`无法创建索引库目录: ${dbDir}\n  ${(e as Error).message}\n  可用环境变量 CAM_DB 指定其它位置。`);
    process.exit(1);
  }
}
const db = new AssetDb(DB_FILE);

function close(code = 0): never {
  db.close();
  process.exit(code);
}

switch (cmd) {
  // ------------------------------------------------------------ add
  case 'add': {
    const target = args[1];
    if (!target) { console.error('用法: add <目录路径>'); close(1); }
    const abs = path.resolve(target);
    if (!fs.existsSync(abs)) { console.error(`路径不存在: ${abs}`); close(1); }

    const roots = db.listRoots() as any[];
    const existing = roots.find((r) => r.path === abs);

    /**
     * 换机器 / 挪动图库时的关键逻辑。
     *
     * 索引库里存的是**绝对路径**,所以把交付目录拷到另一台机器、或图库换了位置时,
     * 原来的 root.path 会失效(缩略图与图片字节流全挂)。
     * 这里检测"已有 root 但路径不存在"的情况,把它重新指向新路径 ——
     * 因为 rel_path 保留着相对结构,重指之后**不需要重新扫描全库**。
     */
    const stale = roots.find((r) => r.path !== abs && !fs.existsSync(r.path));
    if (stale && roots.length === 1 && !existing) {
      console.log(`${C.yellow}检测到已有图库根路径失效${C.reset}: ${stale.path}`);
      console.log(`${C.yellow}重新指向新目录${C.reset}: ${abs}`);
      const n = db.setRootPath(stale.id, abs);
      console.log(`${C.green}✅ 已重指向${C.reset}  root #${stale.id}  (原有 ${n} 条索引记录保持可用)`);
      console.log(`${C.dim}建议再跑一次 scan 以确认文件都在:scan${C.reset}`);
      close();
      break;
    }

    const id = db.addRoot(abs);
    console.log(`${C.green}✅ 已添加扫描目录${C.reset}  id=${id}  ${abs}`);
    console.log(`${C.dim}现在运行: scan${C.reset}`);
    close();
    break;
  }

  // ------------------------------------------------------------ scan
  case 'scan': {
    const force = flag('force');
    const rootIdArg = optVal('root');
    const roots = db.listRoots();
    if (roots.length === 0) {
      console.error('还没有扫描目录,先运行: add <目录>');
      close(1);
    }
    console.log(`${C.bold}开始扫描${C.reset}${force ? ' ' + C.yellow + '(强制全量)' + C.reset : ''}`);
    let last = 0;
    const r = await scanLibrary(db, {
      force,
      rootIds: rootIdArg ? [Number(rootIdArg)] : undefined,
      onProgress: (p) => {
        const now = Date.now();
        if (now - last < 200 && p.phase !== 'done') return;
        last = now;
        const pct = p.total ? Math.round((p.processed / p.total) * 100) : 0;
        process.stdout.write(
          `\r  ${p.phase.padEnd(8)} ${String(p.processed).padStart(6)}/${String(p.total).padEnd(6)} ${String(pct).padStart(3)}%  ` +
          `新增 ${p.processed - p.skipped}  跳过 ${p.skipped}  错误 ${p.errors}   ${C.dim}${(p.currentFile ?? '').split('\\').pop()?.slice(0, 40) ?? ''}${C.reset}          `
        );
      },
    });
    process.stdout.write('\r' + ' '.repeat(140) + '\r');
    console.log(`${C.green}✅ 扫描完成${C.reset}`);
    console.log(`  发现文件    ${r.scanned}`);
    console.log(`  本次入库    ${C.bold}${r.indexed}${C.reset}`);
    console.log(`  增量跳过    ${r.skipped}`);
    console.log(`  清理失效    ${r.removed}`);
    console.log(`  解析错误    ${r.errors}`);
    console.log(`  耗时        ${(r.elapsedMs / 1000).toFixed(1)}s   (${(r.scanned / (r.elapsedMs / 1000)).toFixed(0)} 文件/秒)`);
    console.log(`  库内总数    ${db.count()}`);
    let size = 0;
    try { size = fs.statSync(DB_FILE).size; } catch { /* ignore */ }
    console.log(`  索引库大小  ${fmtBytes(size)}   ${C.dim}${DB_FILE}${C.reset}`);
    close();
    break;
  }

  // ------------------------------------------------------------ stats
  case 'stats': {
    const s = db.getStats() as any;
    console.log(`${C.bold}=== 库统计 ===${C.reset}`);
    console.log(`  图片总数    ${s.totalImages}`);
    console.log(`  总体积      ${fmtBytes(s.totalBytes)}`);
    if (s.earliest) {
      console.log(`  时间跨度    ${new Date(s.earliest).toLocaleDateString()} ~ ${new Date(s.latest).toLocaleDateString()}`);
    }
    console.log(`\n${C.dim}格式分布${C.reset}`);
    for (const [k, v] of Object.entries(s.bySource).sort((a: any, b: any) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(18)} ${String(v).padStart(6)}  ${((v as number) / s.totalImages * 100).toFixed(1)}%`);
    }
    console.log(`\n${C.dim}模型 TOP10${C.reset}`);
    for (const m of s.topModels.slice(0, 10)) console.log(`  ${String((m as any).count).padStart(5)}  ${(m as any).name}`);
    console.log(`\n${C.dim}采样器 TOP10${C.reset}`);
    for (const m of s.topSamplers.slice(0, 10)) console.log(`  ${String((m as any).count).padStart(5)}  ${(m as any).name}`);
    console.log(`\n${C.dim}LoRA TOP10${C.reset}`);
    for (const m of s.topLoras.slice(0, 10)) console.log(`  ${String((m as any).count).padStart(5)}  ${(m as any).name}`);
    close();
    break;
  }

  // ------------------------------------------------------------ tree
  case 'tree': {
    const tree = db.getFolderTree() as any[];
    const print = (n: any, depth: number) => {
      const name = n.relDir === '' ? `[${n.rootLabel}]` : n.relDir.split(/[\\/]/).pop();
      const pad = '  '.repeat(depth);
      console.log(`${pad}${name}  ${C.dim}${n.directCount} 张 / 含子目录 ${n.totalCount} 张${C.reset}`);
      for (const c of n.children) print(c, depth + 1);
    };
    for (const r of tree) print(r, 0);
    close();
    break;
  }

  // ------------------------------------------------------------ query
  case 'query': {
    const q = positionals().join(' ');
    const limit = Number(optVal('limit') ?? 10);
    const catRaw = optVal('category');
    const t0 = Date.now();
    // 用 --category 时,搜索词与分类是"与"关系
    const ids = q ? db.searchIds(q, 5000) : undefined;
    const query: Record<string, unknown> = { limit, sort: 'mtime_desc' };
    if (ids) query.ids = ids;
    if (catRaw !== undefined) query.categoryId = Number(catRaw);
    const res = db.queryImages(query);
    const ms = Date.now() - t0;
    const label = [
      q ? `搜索 ${JSON.stringify(q)}` : '',
      catRaw !== undefined ? `分类 #${catRaw}` : '',
    ].filter(Boolean).join(' + ') || '(全部)';
    console.log(`${C.bold}${label}${C.reset}  命中 ${res.total} 张  ${C.dim}(${ms}ms)${C.reset}\n`);
    const rows = db.getImagesByIds(res.ids) as any[];
    for (const r of rows) {
      const m = r.meta ?? {};
      const s = m.sampler ?? {};
      console.log(`  ${C.cyan}#${r.id}${C.reset} ${r.fileName}`);
      console.log(`      ${r.dimensions?.width}×${r.dimensions?.height}  ${m.modelName ?? '-'} 步骤 ${s.steps ?? '-'} CFG ${s.cfg ?? '-'}`);
      const p = (m.prompts ?? []).find((x: any) => x.role === 'positive');
      if (p) console.log(`      ${C.dim}${p.text.slice(0, 100)}${p.text.length > 100 ? '…' : ''}${C.reset}`);
    }
    close();
    break;
  }

  // ------------------------------------------------------------ get
  case 'get': {
    const id = Number(args[1]);
    const d = db.getImageDetail(id) as any;
    if (!d) { console.error('没有这张图'); close(1); }
    console.log(JSON.stringify(d, null, 2));
    close();
    break;
  }

  // ------------------------------------------------------------ filter
  case 'filter': {
    const f = db.getFilterOptions() as any;
    console.log(`${C.bold}筛选候选值${C.reset}`);
    console.log(`  模型 (${f.models.length}):`);
    console.log('    ' + f.models.slice(0, 20).join('\n    '));
    console.log(`  采样器 (${f.samplers.length}): ${f.samplers.slice(0, 20).join(', ')}`);
    console.log(`  调度器 (${f.schedulers.length}): ${f.schedulers.slice(0, 20).join(', ')}`);
    console.log(`  LoRA (${f.loras.length}): ${f.loras.slice(0, 8).join(', ')}`);
    console.log(`  目录 (${f.dirs.length}): ${f.dirs.slice(0, 8).map((d: any) => d.relDir || '<root>').join(' | ')}`);
    close();
    break;
  }

  // ------------------------------------------------------------ cat-* 分类
  case 'cat-list': {
    const tree = db.getCategoryTree() as any[];
    if (!tree.length) {
      console.log('(还没有分类。用 cat-new "<名称>" 创建)');
      close();
      break;
    }
    const print = (n: any, depth: number) => {
      const pad = '  '.repeat(depth);
      const folder = n.relDir ? `  ${C.dim}-> ${n.relDir}${C.reset}` : '';
      const cnt = n.directCount === n.totalCount
        ? `${n.directCount} 张`
        : `${n.directCount} 张 / 含子 ${n.totalCount} 张`;
      console.log(`${pad}${C.cyan}#${n.id}${C.reset} ${n.name}  ${C.dim}${cnt}${C.reset}${folder}`);
      for (const c of n.children) print(c, depth + 1);
    };
    for (const n of tree) print(n, 0);
    close();
    break;
  }

  case 'cat-new': {
    const name = args[1];
    if (!name) { console.error('用法: cat-new "<名称>" [--parent <id>] [--dir <相对目录>] [--root <id>]'); close(1); }
    const parentRaw = optVal('parent');
    const dir = optVal('dir');
    const rootRaw = optVal('root');
    try {
      const c = db.createCategory({
        name,
        parentId: parentRaw ? Number(parentRaw) : null,
        relDir: dir ?? null,
        rootId: rootRaw ? Number(rootRaw) : dir ? (db.listRoots() as any[])[0]?.id ?? null : null,
      }) as any;
      console.log(`${C.green}✅ 已创建分类${C.reset}  #${c.id} ${c.name}`);
    } catch (e) {
      console.error(`${C.red}✗ ${(e as Error).message}${C.reset}`);
      close(1);
    }
    close();
    break;
  }

  case 'cat-rename': {
    const id = Number(args[1]);
    const name = args[2];
    if (!id || !name) { console.error('用法: cat-rename <id> "<新名称>"'); close(1); }
    try {
      db.updateCategory(id, { name });
      console.log(`${C.green}✅ 已重命名${C.reset}  #${id} -> ${name}`);
    } catch (e) {
      console.error(`${C.red}✗ ${(e as Error).message}${C.reset}`);
      close(1);
    }
    close();
    break;
  }

  case 'cat-move': {
    const id = Number(args[1]);
    const parentRaw = optVal('parent');
    if (!id) { console.error('用法: cat-move <id> --parent <父id|none> [--sort N]'); close(1); }
    try {
      const patch: Record<string, unknown> = {};
      if (parentRaw !== undefined) patch.parentId = parentRaw === 'none' ? null : Number(parentRaw);
      const sortRaw = optVal('sort');
      if (sortRaw !== undefined) patch.sortOrder = Number(sortRaw);
      db.updateCategory(id, patch as never);
      console.log(`${C.green}✅ 已更新${C.reset}  #${id}`);
    } catch (e) {
      console.error(`${C.red}✗ ${(e as Error).message}${C.reset}`);
      close(1);
    }
    close();
    break;
  }

  case 'cat-add': {
    const id = Number(args[1]);
    if (!id) { console.error('用法: cat-add <分类id> --query "<搜索词>"  或  --ids 1,2,3'); close(1); }
    let ids: number[] = [];
    const idsRaw = optVal('ids');
    const qRaw = optVal('query');
    if (idsRaw) ids = idsRaw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    else if (qRaw) ids = db.searchIds(qRaw, 20000);
    else { console.error('需要 --ids 或 --query'); close(1); }
    try {
      const n = db.setCategoryMembers(id, ids, true);
      console.log(`${C.green}✅ 加入 ${n} 张${C.reset}  (命中 ${ids.length} 张,已在分类内的跳过)`);
    } catch (e) {
      console.error(`${C.red}✗ ${(e as Error).message}${C.reset}`);
      close(1);
    }
    close();
    break;
  }

  case 'cat-rm': {
    const id = Number(args[1]);
    if (!id) { console.error('用法: cat-rm <分类id> --ids 1,2,3'); close(1); }
    const idsRaw = optVal('ids') ?? '';
    const ids = idsRaw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    try {
      const n = db.setCategoryMembers(id, ids, false);
      console.log(`${C.green}✅ 移出 ${n} 张${C.reset}`);
    } catch (e) {
      console.error(`${C.red}✗ ${(e as Error).message}${C.reset}`);
      close(1);
    }
    close();
    break;
  }

  case 'cat-del': {
    const id = Number(args[1]);
    if (!id) { console.error('用法: cat-del <分类id> [--with-children]'); close(1); }
    const withChildren = flag('with-children');
    db.deleteCategory(id, withChildren);
    console.log(`${C.green}✅ 已删除分类 #${id}${C.reset}${withChildren ? '(含子分类)' : '(子分类已上提)'}`);
    close();
    break;
  }

  // ------------------------------------------------------------ roots
  case 'roots': {
    const rs = db.listRoots() as any[];
    if (!rs.length) console.log('(空)');
    for (const r of rs) {
      console.log(`  #${r.id}  ${r.label}  ${C.dim}${r.path}${C.reset}  ${r.enabled ? C.green + '启用' : C.red + '停用'}${C.reset}  上次扫描 ${r.lastScanAt ? new Date(r.lastScanAt).toLocaleString() : '从未'}`);
    }
    close();
    break;
  }

  default:
    console.log(`ComfyUI 资产管理器 —— 索引 CLI

  add <目录>            添加扫描目录
  scan [--force]        扫描并索引(默认增量)
  roots                 列出扫描目录
  stats                 库统计
  tree                  文件夹树
  query <关键词>        全文检索 --limit N
  filter                筛选候选值
  get <id>              单张完整详情(含原始元数据)

  cat-list              列出分类树
  cat-new "<名称>"      新建分类 [--parent <id>] [--dir <相对目录>] [--root <id>]
  cat-rename <id> "<名>"  重命名
  cat-move <id>         --parent <父id|none> --sort <N>
  cat-add <id>          加图入分类 --query "<搜索词>" | --ids 1,2,3
  cat-rm <id>           移出分类 --ids 1,2,3
  cat-del <id>          删除分类 [--with-children]

  环境变量 CAM_DB 可覆盖索引库路径。当前: ${DB_FILE}`);
    close();
}
