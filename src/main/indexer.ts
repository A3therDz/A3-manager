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

const IMAGE_EXT = new Set(['.png']);

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

        const row = {
          rootId: root.id,
          absPath: abs,
          relPath,
          relDir,
          fileName: path.basename(abs),
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
            fileName: path.basename(abs),
            relDir,
            modelName: meta.modelName,
            samplerName: sampler === null ? null : sampler.samplerName,
            scheduler: sampler === null ? null : sampler.scheduler,
            loras: loras.map((l) => l.name),
            prompts: meta.prompts.map((p) => p.text),
          }),
        };

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
