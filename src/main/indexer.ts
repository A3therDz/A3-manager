/**
 * Asset scanning and indexing.
 *
 * Walks directories -> incremental check via (mtime, size) -> extract metadata -> write SQLite.
 *
 * Measured on 8061 files / 32.7GB: full first scan ~10s, incremental rescan ~0.5s.
 * Key points:
 *  - Raw metadata JSON is not retained (see keepRaw in comfy-parser); keeping it would
 *    push the index to several GB.
 *  - Rows are committed in batches inside one SQLite transaction; committing per row
 *    is dozens of times slower.
 *  - Fingerprints are loaded into memory once instead of querying per file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { AssetDb, buildSearchText } from './db.ts';

// comfy-parser is a verified CommonJS implementation, loaded from ESM via createRequire
const nodeRequire = createRequire(import.meta.url);

/**
 * 解析器在打包后的相对位置会变(开发时是 src/main → ../../tools,
 * 打包成 asar 后是 app 根 → tools/comfy-parser.cjs),所以按候选路径依次找。
 */
function resolveComfyParser(fromDir: string): string {
  const candidates = [
    path.join(process.cwd(), 'tools', 'comfy-parser.cjs'),
    path.join(fromDir, '..', '..', 'tools', 'comfy-parser.cjs'),
    path.join(fromDir, '..', 'tools', 'comfy-parser.cjs'),
    path.join(fromDir, 'tools', 'comfy-parser.cjs'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* 继续试下一个 */
    }
  }
  return candidates[1];
}

const { extractFromPng } = nodeRequire(
  resolveComfyParser(path.dirname(fileURLToPath(import.meta.url)))
) as {
  extractFromPng: (
    p: string,
    opts?: { keepRaw?: boolean }
  ) => {
    dimensions: { width: number; height: number } | null;
    meta: {
      source: string;
      modelName: string | null;
      loras: Array<{ name: string; strengthModel: number | null }>;
      sampler: {
        seed: number | null;
        steps: number | null;
        cfg: number | null;
        samplerName: string | null;
        scheduler: string | null;
      } | null;
      prompts: Array<{ role: string; text: string }>;
      nodeCount: number;
    };
  };
};

/**
 * 元数据解析版本。
 *
 * 只改解析器(comfy-parser)而不重新扫描时,老库里存的是旧口径的结果。
 * 把它持久化在库里,版本不一致就自动强制重扫一次,用户不用手动点「重新扫描」。
 *
 * 变更历史:
 *   1 — 初版(ComfyUI / A1111 / NovelAI)
 *   2 — LoRA:补上提示词文本里的 <lora:...>(正负提示词都扫)并从提示词里摘掉;
 *       NovelAI:新增 v4 角色提示词(char_captions / characterPrompts)
 *   3 — 自定义提示词节点(WeiLinPromptUI / PromptSelector / TextBox1 等)与
 *       Lora Loader (LoraManager) 的 text 输入;以前这类工作流"提示词 0 条、LoRA 0 条"
 */
export const META_VERSION = 3;

export type ScanPhase = 'idle' | 'walking' | 'parsing' | 'done' | 'error' | 'cancelled';

export interface ScanProgress {
  phase: ScanPhase;
  processed: number;
  total: number;
  currentFile: string | null;
  skipped: number;
  errors: number;
  startedAt: number;
  finishedAt: number | null;
  message: string | null;
  /** 本轮新解析入库的文件数(phase=done 时有效) */
  indexed?: number;
  /** 本轮从索引里清理掉的失效文件数(phase=done 时有效) */
  removed?: number;
}

export interface ScanOptions {
  rootIds?: number[];
  /** Ignore fingerprints and re-parse everything. */
  force?: boolean;
  /**
   * 不走"目录树签名没变就跳过"的快速通道,老老实实遍历一遍。
   * 用于:用户手动重新扫描、以及文件监听没挂上(需要全量对账)的兜底。
   */
  forceRescan?: boolean;
  onProgress?: (p: ScanProgress) => void;
  signal?: AbortSignal;
  /** Rows per transaction batch. */
  batchSize?: number;
}

export interface ScanResult {
  scanned: number;
  indexed: number;
  skipped: number;
  removed: number;
  errors: number;
  elapsedMs: number;
  /**
   * 因为"目录树签名没变"而整轮跳过的图库根数量。
   * 有递归文件监听时这就是常态:启动和定时对账都只花几百毫秒。
   */
  skippedRoots: number;
}

/** 受支持的图片扩展名。定点入库判定"这个事件能不能直接处理"时也要用同一份名单。 */
export const IMAGE_EXT = new Set(['.png']);

/** 入库行的形状 —— scanLibrary 与 scanPaths 共用(直接取自 upsertImage 的入参) */
type ImageRow = Parameters<AssetDb['upsertImage']>[0];

/**
 * 解析一张 PNG 并组装成入库行。
 *
 * 扫描(全量对账)与定点入库(scanPaths)共用这一份实现:
 * 提示词/LoRA/检索文本的口径只有一处,免得两条路径慢慢跑偏。
 */
function buildImageRow(root: { id: number; path: string }, abs: string, relPath: string, st: fs.Stats, mtime: number): ImageRow {
  const res = extractFromPng(abs, { keepRaw: false });
  const meta = res.meta;
  const sampler = meta.sampler;
  const pos = meta.prompts.find((p) => p.role === 'positive');
  const neg = meta.prompts.find((p) => p.role === 'negative');
  const loras = meta.loras.map((l) => ({
    name: l.name,
    strength: l.strengthModel === null ? null : l.strengthModel,
  }));
  const dir = path.dirname(relPath);
  const relDir = dir === '.' ? '' : dir;
  const fileName = path.basename(abs);

  return {
    rootId: root.id,
    absPath: abs,
    relPath,
    relDir,
    fileName,
    fileSize: st.size,
    fileMtime: mtime,
    width: res.dimensions === null ? null : res.dimensions.width,
    height: res.dimensions === null ? null : res.dimensions.height,
    source: meta.source,
    modelName: meta.modelName,
    samplerName: sampler === null ? null : sampler.samplerName,
    scheduler: sampler === null ? null : sampler.scheduler,
    steps: sampler === null ? null : sampler.steps,
    cfg: sampler === null ? null : sampler.cfg,
    seed: sampler === null ? null : sampler.seed,
    posPrompt: pos === undefined ? null : pos.text,
    negPrompt: neg === undefined ? null : neg.text,
    promptLen: (pos === undefined ? 0 : pos.text.length) + (neg === undefined ? 0 : neg.text.length),
    loraCount: loras.length,
    nodeCount: meta.nodeCount,
    metaJson: JSON.stringify(meta),
    rawJson: null,
    loras,
    searchText: buildSearchText({
      fileName,
      relDir,
      modelName: meta.modelName,
      samplerName: sampler === null ? null : sampler.samplerName,
      scheduler: sampler === null ? null : sampler.scheduler,
      loras: loras.map((l) => l.name),
      prompts: meta.prompts.map((p) => p.text),
    }),
  };
}

/**
 * 缩略图缓存目录名。与 src/main/index.ts、tools/thumb-sync.ts、tools/export-gallery.ts
 * 必须保持一致。
 *
 * 缓存目录就放在图库根内部,扫描时必须跳过:否则生成的缩略图会被当成原图收进
 * 索引,接着又对缩略图生成缩略图,堆出 .comfy-thumbs/.comfy-thumbs/... 的套娃。
 */
export const THUMB_DIR_NAME = '.comfy-thumbs';

/**
 * 目录树的"廉价签名"。
 *
 * 只依赖 readdir 就返回的目录项(名字 + mtime),**不对每个文件 stat**。
 * 图库没动过时,一次 1 万张的遍历只要几百毫秒;用它就能判断
 * "这一轮有没有必要去 stat + 解析",从而把启动与定时对账的成本压到几乎为零。
 */
export interface TreeSignature {
  /**
   * 遍历时看到的文件/目录条目总数。
   * 新增 / 删除 / 改名一定会改变它,所以它是"目录树动过没有"的可靠信号。
   */
  count: number;
  /** 图库根目录自身的 mtime:顶层增删会变(留 0 表示读不到) */
  rootMtime: number;
}

function sameSignature(a: TreeSignature | null | undefined, b: TreeSignature | null | undefined): boolean {
  if (!a || !b) return false;
  return a.count === b.count && a.rootMtime === b.rootMtime;
}

/**
 * 递归列出所有受支持的图片文件,同时算一份目录树签名。
 *
 * 注意:这里**不做 statSync**,只信 readdir 给出的目录项 —— 一次遍历就能同时拿到
 * 文件列表与"有没有变化"的判断依据,这是把启动扫描降到毫秒级的关键。
 *
 * 分片异步:目录遍历是同步 readdir,大图库(上万个条目)一口气走完会堵住主进程
 * 几百毫秒 —— 新图进库触发的自动扫描每次都走这里,表现就是"图片一到就卡一下"。
 * 每处理 48 个目录(或超过 10ms)就让出一次事件循环,遍历期间界面保持可动。
 */
async function walkImages(rootDir: string, signal?: AbortSignal): Promise<{ files: string[]; sig: TreeSignature }> {
  const out: string[] = [];
  let count = 0;
  let rootMtime = 0;
  try {
    rootMtime = Math.floor(fs.statSync(rootDir).mtimeMs);
  } catch {
    rootMtime = 0;
  }
  const stack: string[] = [rootDir];
  let sinceYield = 0;
  let sliceStart = Date.now();
  while (stack.length) {
    if (signal && signal.aborted) break;
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      count++;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        // 跳过缩略图缓存(含历史遗留的多层嵌套),它们是派生文件不是图库内容。
        if (e.name === THUMB_DIR_NAME) continue;
        stack.push(p);
      } else if (e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase())) {
        out.push(p);
      }
    }
    sinceYield++;
    if (sinceYield >= 48 || Date.now() - sliceStart > 10) {
      await yieldToEventLoop();
      sinceYield = 0;
      sliceStart = Date.now();
    }
  }
  return { files: out, sig: { count, rootMtime } };
}


/**
 * Run one scan. The caller owns the open AssetDb.
 *
 * Synchronous by design (sync IO + node:sqlite sync API) so the Electron main
 * process can host it inside a worker without touching the UI thread.
 */
/** 把控制权还给事件循环 —— 扫描期间窗口必须还能响应,否则 Windows 会显示"未响应" */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function scanLibrary(db: AssetDb, opts: ScanOptions = {}): Promise<ScanResult> {
  const startedAt = Date.now();
  const batchSize = opts.batchSize === undefined ? 200 : opts.batchSize;
  const progress: ScanProgress = {
    phase: 'walking',
    processed: 0,
    total: 0,
    currentFile: null,
    skipped: 0,
    errors: 0,
    startedAt,
    finishedAt: null,
    message: null,
  };
  const emit = () => {
    if (opts.onProgress) opts.onProgress({ ...progress });
  };

  const allRoots = db.listRoots() as Array<{ id: number; path: string; label: string; enabled: number }>;
  const roots = opts.rootIds && opts.rootIds.length
    ? allRoots.filter((r) => (opts.rootIds as number[]).includes(r.id))
    : allRoots.filter((r) => r.enabled === 1);

  if (roots.length === 0) {
    progress.phase = 'done';
    progress.finishedAt = Date.now();
    progress.message = 'no enabled scan roots';
    emit();
    return { scanned: 0, indexed: 0, skipped: 0, removed: 0, errors: 0, elapsedMs: Date.now() - startedAt, skippedRoots: 0 };
  }

  let indexed = 0;
  let skipped = 0;
  let removed = 0;
  let errors = 0;
  let skippedRoots = 0;

  for (const root of roots) {
    if (opts.signal && opts.signal.aborted) {
      progress.phase = 'cancelled';
      break;
    }

    const walked = await walkImages(root.path, opts.signal);
    const files = walked.files;

    /**
     * 快速通道:目录树签名与上一轮完全一致 → 这张图库这轮没有变化。
     *
     * 为什么可以整个跳过:图库目录上挂着递归 fs.watch,应用运行期间的新增/删除
     * 都会实时触发一次增量扫描;启动时算一次签名,就能知道"应用没运行的时候
     * 有没有东西动过"。签名一致 = 索引已经是最新的,不必再 stat 一万个文件。
     *
     * force=true(用户点重新扫描 / 解析口径变了)和 prune=true(用户删图库后对账)
     * 时仍然走完整流程。
     */
    const forceThis = opts.force === true;
    const prevSig = db.getTreeSignature(root.id);
    if (!forceThis && opts.forceRescan !== true && sameSignature(walked.sig, prevSig)) {
      skippedRoots++;
      progress.skipped += files.length;
      db.markRootScanned(root.id);
      continue;
    }

    progress.total += files.length;
    progress.phase = 'parsing';
    emit();
    // 目录遍历本身是同步的,大图库也要在这里让一次
    await yieldToEventLoop();

    const fingerprints = forceThis ? new Map() : db.loadFingerprints(root.id);
    const seen = new Set<string>();
    let pending: Array<() => void> = [];
    let inBatch = 0;
    // 按时间预算让出事件循环:单张 PNG 解析可能花几十~几百毫秒,
    // "每 50 个文件才让一次"在新图集中到达时会连续堵主进程几秒。
    // 改成累计干活超过 12ms 就让一次,界面始终能响应。
    let sliceStart = Date.now();

    const flush = () => {
      if (inBatch === 0) return;
      db.transaction(() => {
        for (const fn of pending) fn();
      });
      pending = [];
      inBatch = 0;
      emit();
    };

    for (const abs of files) {
      if (opts.signal && opts.signal.aborted) break;
      progress.currentFile = abs;

      const relPath = path.relative(root.path, abs);
      seen.add(relPath);

      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        errors++;
        progress.errors = errors;
        progress.processed++;
        continue;
      }
      const mtime = Math.floor(st.mtimeMs);

      const fp = fingerprints.get(relPath);
      // Incremental: unchanged files are skipped so user state (starred) survives.
      if (fp && fp.mtime === mtime && fp.size === st.size && !opts.force) {
        skipped++;
        progress.skipped = skipped;
        progress.processed++;
        continue;
      }

      try {
        const row = buildImageRow(root, abs, relPath, st, mtime);

        pending.push(() => {
          db.upsertImage(row);
          indexed++;
        });
        inBatch++;
        if (inBatch >= batchSize) flush();
      } catch {
        errors++;
        progress.errors = errors;
      }

      progress.processed++;
      if (progress.processed % 200 === 0) emit();
      // 时间预算让出:干活超过 12ms 就还一次事件循环(不再按固定 50 个文件),
      // 新图入库触发的增量扫描不再把界面卡出"未响应"
      if (Date.now() - sliceStart > 12) {
        await yieldToEventLoop();
        sliceStart = Date.now();
      }
    }

    flush();
    await yieldToEventLoop();
    removed += db.deleteImagesNotIn(root.id, seen);
    db.setTreeSignature(root.id, walked.sig);
    db.markRootScanned(root.id);
  }

  progress.phase = progress.phase === 'cancelled' ? 'cancelled' : 'done';
  progress.finishedAt = Date.now();
  progress.currentFile = null;
  // 带上本轮的实际变化量:渲染层据此决定要不要刷新列表
  // (监听触发的空扫不再引发整表重拉与网格重排)
  progress.indexed = indexed;
  progress.removed = removed;
  emit();

  return {
    scanned: progress.total,
    indexed,
    skipped,
    removed,
    errors,
    elapsedMs: Date.now() - startedAt,
    skippedRoots,
  };
}

// ---------------------------------------------------------------- 定点入库

export interface WatchPlan {
  /** 要定点解析(或定点清理)的绝对路径(.png) */
  paths: string[];
  /** 索引里要定点清理的目录相对路径:整个目录(含子目录)真的从盘上没了 */
  removedDirs: string[];
}

/**
 * 判断这批监听事件能不能**全部**定点处理(拿不准就必须退回全量对账)。
 *
 * 规则(与定点入库、扫描策略同一口径):
 *  - `.png` 且文件存在 → 新增 / 改动,定点解析;
 *  - `.png` 但盘上已不在、索引里有这个 rel_path → 删除 / 改名离开,定点清理;
 *  - **不在盘上的非 .png 路径**(Windows 删目录只报目录名) → 问 `probeDir`:
 *      'none'(索引里这个目录下本来就没行)→ 什么都不用做;
 *      'stale'(有行,且抽样的路径在盘上都没了)→ 定点清理整个目录;
 *      'alive'(有行,但盘上还在 → 目录被改名/搬走了)→ 退回全量对账;
 *  - 其余(存在的目录:整目录被搬进来 / 新目录;非图片文件;拿不准)→ 返回 `null`,调用方退回全量对账。
 *
 * **为什么单独处理"目录事件"**:Windows 的递归监听在目录里**任何文件**被写时,
 * 除文件名事件外还会额外报一次**目录名**的 change(实测:往
 * `output\krea2\2026-10-09\` 拷 5 张图 → 5 次文件名 + 5 次目录名)。目录事件本身
 * 不带"哪个文件变了"的信息,而真正的变化已经在同一批的文件事件里了;若把它当成
 * "来历不明的路径"一律退回全量,现实中就几乎每次都退回全量(图库按日期分子目录,
 * 每张新图都会带上它的父目录名),这次优化就白做了。
 *
 * 所以:**目录事件只有在这批里已经有它下面的路径时才算冗余**(丢掉);
 * 整目录被删(且索引里确实有它的行、盘上都没了)时定点清理,不跑全量;
 * 只剩"存在的目录"这种拿不准的情况才退回全量。
 *
 * @param rootPath 图库根绝对路径
 * @param rels 监听事件给的相对路径(可以带目录名)
 * @param isIndexed 该 rel_path 在索引里有没有行(由调用方提供,避免这里依赖 AssetDb)
 * @param probeDir 目录不在盘上时的判定回调(见上);缺省时一律按"拿不准"退回全量
 * @returns 能定点就返回处理计划;不能返回 `null`
 */
export function classifyWatchPaths(
  rootPath: string,
  rels: Iterable<string>,
  isIndexed: (rel: string) => boolean,
  probeDir?: (rel: string) => 'none' | 'stale' | 'alive'
): WatchPlan | null {
  const dirs: string[] = [];
  const others: string[] = [];
  for (const rel of rels) {
    if (typeof rel !== 'string' || !rel) continue;
    // 监听给的一定是根目录下的相对路径;真出现越界路径就交给全量对账,不猜
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (rel.split(/[\\/]/).includes(THUMB_DIR_NAME)) continue; // 自己的缩略图缓存,忽略
    let isDir = false;
    try {
      isDir = fs.statSync(path.join(rootPath, rel)).isDirectory();
    } catch {
      isDir = false; // 盘上没了:可能是被删的文件,也可能是被删的目录
    }
    if (isDir) dirs.push(rel);
    else others.push(rel);
  }

  const isChild = (child: string, dir: string): boolean => {
    const prefix = dir.replace(/[\\/]+$/, '');
    return child.startsWith(prefix + '\\') || child.startsWith(prefix + '/');
  };
  const redundantDirs = new Set(dirs.filter((d) => others.some((o) => isChild(o, d))));
  const rest = dirs.filter((d) => !redundantDirs.has(d)).concat(others);

  const out: string[] = [];
  const removedDirs: string[] = [];
  for (const rel of rest) {
    if (!IMAGE_EXT.has(path.extname(rel).toLowerCase())) {
      // 非 .png:只可能是"盘上没了的目录名"(删目录),或真的非图片文件
      if (dirs.includes(rel)) return null; // 存在的目录:整目录被搬进来之类,交给全量
      const verdict = probeDir ? probeDir(rel) : 'alive';
      if (verdict === 'stale') {
        removedDirs.push(rel);
        continue;
      }
      if (verdict === 'none') continue; // 索引里本来就没这个目录的行,什么都不用做
      return null; // 有行但盘上还在(改名/搬走)或判定不可靠 → 全量
    }
    const abs = path.join(rootPath, rel);
    try {
      if (fs.statSync(abs).isFile()) {
        out.push(abs);
        continue;
      }
    } catch {
      /* 盘上没了 → 看索引里有没有 */
    }
    if (isIndexed(rel)) {
      out.push(abs);
      continue;
    }
    return null; // 盘上没有、索引里也没有 → 拿不准
  }
  return { paths: out, removedDirs };
}

export interface ScanPathsOptions {
  /** 变化发生在哪个图库根 */
  rootId: number;
  /** 要处理的**绝对路径**(文件监听事件给的路径;非 .png 一律忽略) */
  absPaths: string[];
  /** 整个目录(含子目录)从盘上没了:定点删掉索引里这些行,不做目录遍历 */
  removedDirs?: string[];
  signal?: AbortSignal;
  onProgress?: (p: ScanProgress) => void;
  /** Rows per transaction batch. */
  batchSize?: number;
}

export interface ScanPathsResult {
  /** 本次真的处理到的路径数(含"指纹没变跳过"的) */
  scanned: number;
  /** 新解析入库 / 重新解析入库的张数 */
  indexed: number;
  /** 从索引里删掉的失效张数(文件已不在) */
  removed: number;
}

/**
 * **定点入库**:只处理"刚变化的这几个路径",不做目录遍历。
 *
 * 为什么需要:递归 fs.watch 拿到的是"哪个路径变了",但以前一律走
 * `scanLibrary` 全量对账 —— 每次都要重新遍历 1.8 万个文件并逐个 stat,
 * 真实库实测 **2.1 秒**(即使 0 新增也一样)。出图目录一直在写新图,
 * 于是"每来一张新图就卡一次"。定点入库把这件事降到"解析这一张 + 一条索引查询"。
 *
 * 行为(与全量对账的口径一致,只是范围收窄):
 *  - 存在的 .png:比 (mtime,size) 指纹,没变就跳过(用户状态如 starred 不会丢);
 *    变了/新文件则解析 + upsert。
 *  - 不存在的路径:索引里有对应行就删掉(含 FTS 行,分类归属靠外键级联)。
 *  - `removedDirs`:整个目录(含子目录)从盘上没了 → 定点删掉索引里这些行,并把签名作废
 *    (怕那是"目录改名",文件还在新路径上;下次启动全量对账会把它们收回来)。
 *  - 非 .png、目录、root 之外的路径:忽略(该不该退回全量对账由调用方判断)。
 *  - 结束后维护该 root 的目录树签名:count 加上**净新增**、rootMtime 取当前根目录 mtime。
 *    这样下一次启动扫描/全量对账仍能走签名快速通道,不会因为定点入库而每次都全量遍历。
 *
 * @returns 实际变化量,调用方据此决定要不要递增索引代际(配方统计缓存失效)
 */
export async function scanPaths(db: AssetDb, opts: ScanPathsOptions): Promise<ScanPathsResult> {
  const root = (db.listRoots() as Array<{ id: number; path: string }>).find((r) => r.id === opts.rootId);
  if (!root) return { scanned: 0, indexed: 0, removed: 0 };

  // 去重 + 只留 root 内的 .png。Windows 路径大小写不敏感,按小写 rel 去重。
  const targets: string[] = [];
  const seenRel = new Set<string>();
  for (const abs of Array.isArray(opts.absPaths) ? opts.absPaths : []) {
    if (typeof abs !== 'string' || !abs) continue;
    if (!IMAGE_EXT.has(path.extname(abs).toLowerCase())) continue;
    const rel = path.relative(root.path, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (rel.split(/[\\/]/).includes(THUMB_DIR_NAME)) continue;
    const key = rel.toLowerCase();
    if (seenRel.has(key)) continue;
    seenRel.add(key);
    targets.push(abs);
  }

  const progress: ScanProgress = {
    phase: 'parsing',
    processed: 0,
    total: targets.length,
    currentFile: null,
    skipped: 0,
    errors: 0,
    startedAt: Date.now(),
    finishedAt: null,
    message: null,
  };
  const emit = () => {
    if (opts.onProgress) opts.onProgress({ ...progress });
  };
  emit();

  const batchSize = opts.batchSize === undefined ? 32 : opts.batchSize;
  let indexed = 0;
  /** 真正新增的目录项数(覆盖已有行不算)—— 目录树签名的 count 增量只看它 */
  let created = 0;
  let removed = 0;
  let scanned = 0;
  let pending: Array<() => void> = [];
  let sliceStart = Date.now();

  /** 整个目录被删:定点清掉索引行(目录项本身也要从签名 count 里扣掉) */
  let dirRowsRemoved = 0;
  for (const dirRel of opts.removedDirs ?? []) {
    if (typeof dirRel !== 'string' || !dirRel) continue;
    if (dirRel.startsWith('..') || path.isAbsolute(dirRel)) continue;
    const n = db.deleteImagesUnderRelDir(root.id, dirRel);
    dirRowsRemoved += n;
    removed += n;
    removed += 1; // 目录条目本身
    await yieldToEventLoop();
  }

  const flush = () => {
    if (pending.length === 0) return;
    const fns = pending;
    pending = [];
    db.transaction(() => {
      for (const fn of fns) fn();
    });
  };

  for (const abs of targets) {
    if (opts.signal && opts.signal.aborted) break;
    progress.currentFile = abs;
    const relPath = path.relative(root.path, abs);

    let st: fs.Stats | null = null;
    try {
      const s = fs.statSync(abs);
      if (s.isFile()) st = s;
    } catch {
      st = null;
    }

    if (st !== null) {
      const mtime = Math.floor(st.mtimeMs);
      const fp = db.getImageByRelPath(root.id, relPath);
      if (fp && fp.mtime === mtime && fp.size === st.size) {
        progress.skipped++;
      } else {
        try {
          const row = buildImageRow(root, abs, relPath, st, mtime);
          pending.push(() => {
            const r = db.upsertImage(row);
            indexed++;
            // 只有"新建的行"才是真的多了一个目录项;覆盖已有行(改了内容/元数据)不算
            if (r.created) created++;
          });
        } catch {
          // 解析失败(半写状态 / 不是合法 PNG):不计入 indexed,留给下一次事件或全量对账
          progress.errors++;
        }
      }
    } else {
      // 盘上没了:索引里有就清掉(改名离开也算这一类,新名字会有自己的事件)
      const fp = db.getImageByRelPath(root.id, relPath);
      if (fp) {
        const id = fp.id;
        pending.push(() => {
          db.deleteImage(id);
          removed++;
        });
      }
    }

    scanned++;
    progress.processed = scanned;
    if (pending.length >= batchSize) {
      flush();
      await yieldToEventLoop();
      sliceStart = Date.now();
    } else if (Date.now() - sliceStart > 12) {
      await yieldToEventLoop();
      sliceStart = Date.now();
    }
  }
  flush();

  /**
   * 维护目录树签名。
   *
   * 这里只知道"净新增了几个目录项",不知道整棵树的条目总数,所以按
   * `上次的 count + 净新增` 推:定点入库只会处理"目录里已存在的文件条目",
   * 净新增(新建行数 - 清理行数)正好等于条目数增量 ——
   * 覆盖已有行(同一路径内容变了)不算新增,否则 count 会越推越大。
   *
   * 没有旧签名(比如刚添加的图库还没全量扫过)时从 0 起算:这个 count 只可能偏小
   * (漏掉子目录、非图片条目),而偏小只会让下一次全量对账"签名不一致"从而老实走一遍
   * (正确性不受影响),不会导致漏扫。
   */
  const prev = db.getTreeSignature(root.id);
  let rootMtime = 0;
  try {
    rootMtime = Math.floor(fs.statSync(root.path).mtimeMs);
  } catch {
    rootMtime = 0;
  }
  if (dirRowsRemoved > 0) {
    /**
     * 有"整目录消失"且真的清掉了行 —— 这可能是目录**被改名/搬走**(文件还在新路径上),
     * 定点清理只能保证索引不再指向不存在的路径。此时把签名作废:下一次启动扫描会
     * 老实全量对账一遍,把搬走的图重新收进来。代价是"删过整个文件夹"之后的那次启动
     * 会多花一遍遍历,换来的是不会静默漏图。
     */
    db.clearTreeSignature(root.id);
  } else {
    db.setTreeSignature(root.id, { count: (prev ? prev.count : 0) + created - removed, rootMtime });
  }
  if (indexed !== 0 || removed !== 0) db.markRootScanned(root.id);

  progress.phase = 'done';
  progress.finishedAt = Date.now();
  progress.currentFile = null;
  progress.indexed = indexed;
  progress.removed = removed;
  emit();

  return { scanned, indexed, removed };
}
