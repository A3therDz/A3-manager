/**
 * SQLite 索引层。
 *
 * 用 Node 22 内置的 `node:sqlite`(DatabaseSync),**不需要原生编译**,
 * 因此省掉了 native 模块在 Node / Electron 之间反复 rebuild 的麻烦。
 *
 * 设计要点:
 *  - `images` 用 (root_id, rel_path) 唯一键,增量扫描靠 mtime+size 判断是否需要重解析。
 *  - `meta_json` 存整份 GenerationMeta,字段演进不用改表结构。
 *  - `raw_json` 单独一列且延迟读取(单块可达 1.6MB),列表查询绝不碰它。
 *  - 全文检索用 FTS5 + 自定义归一化:CJK 拆单字、字母数字边界拆开,
 *    否则 "girl" 搜不到 "1girl"、"女孩" 搜不到中文提示词。
 *  - `lora_refs` 是关系表,支撑"按 LoRA 筛选 / LoRA 使用排行"。
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { normalizeLoraName } from '../shared/recipes.ts';
import type { CompareBasic } from '../shared/compare.ts';

// ---------------------------------------------------------------- 类型

export interface StoredImage {  id: number;
  rootId: number;
  absPath: string;
  relPath: string;
  relDir: string;
  fileName: string;
  fileSize: number;
  fileMtime: number;
  width: number | null;
  height: number | null;
  metaJson: string;
  starred: number;
  indexedAt: number;
}

/** node:sqlite 能绑定的标量类型 */
type SQLValue = string | number | bigint | null | Uint8Array;

/** 分类行(与 src/shared/types.ts 的 Category 对齐) */export interface CategoryRow {
  id: number;
  name: string;
  description: string | null;
  parentId: number | null;
  sortOrder: number;
  relDir: string | null;
  rootId: number | null;
  createdAt: number;
  updatedAt: number;
  directCount: number;
  totalCount: number;
  children: CategoryRow[];
}

/** 分类树构建时的中间结构(children 是节点,不是最终 API 形状) */
type CategoryNodeRow = Omit<CategoryRow, 'children'> & { children: CategoryNodeRow[] };


// ---------------------------------------------------------------- 检索归一化

/**
 * 检索文本归一化。必须与 `normalizeQuery` 使用同一套规则,否则搜不到。
 *  - 字母/数字边界拆开:  "1girl" -> "1 girl"
 *  - CJK/假名/谚文逐字拆开: "女孩" -> "女 孩"
 *  - 其余非字母数字下划线视为分隔符,统一小写
 */
export function normalizeForSearch(s: string): string {
  if (!s) return '';
  return s
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .replace(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g, (c) => ` ${c} `)
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .toLowerCase()
    .trim();
}

/**
 * 把一条记录里所有可检索字段拼成一段归一化文本,写进 images_fts.value。
 *
 * 扫描时由 indexer 调用;FTS 表迁移重建时也走同一个函数,保证两处口径一致。
 */
export function buildSearchText(fields: {
  fileName: string;
  relDir: string;
  modelName: string | null;
  samplerName: string | null;
  scheduler: string | null;
  loras: string[];
  prompts: string[];
}): string {
  const parts = [
    fields.fileName,
    fields.relDir,
    fields.modelName === null ? '' : fields.modelName,
    fields.samplerName === null ? '' : fields.samplerName,
    fields.scheduler === null ? '' : fields.scheduler,
    ...fields.loras,
    ...fields.prompts,
  ];
  return normalizeForSearch(parts.join(' \n '));
}

/** 把用户输入变成 FTS5 MATCH 表达式(每个词都要求前缀匹配,提升召回) */
export function toMatchExpr(query: string): string {
  const tokens = normalizeForSearch(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND ');
}

// ---------------------------------------------------------------- 建库

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS roots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  added_at    INTEGER NOT NULL,
  last_scan_at INTEGER
);

CREATE TABLE IF NOT EXISTS images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id     INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  abs_path    TEXT NOT NULL,
  rel_path    TEXT NOT NULL,
  rel_dir     TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  file_size   INTEGER NOT NULL,
  file_mtime  INTEGER NOT NULL,
  width       INTEGER,
  height      INTEGER,
  source      TEXT NOT NULL,
  model_name  TEXT,
  sampler_name TEXT,
  scheduler   TEXT,
  steps       INTEGER,
  cfg         REAL,
  seed        INTEGER,
  pos_prompt  TEXT,
  neg_prompt  TEXT,
  prompt_len  INTEGER NOT NULL DEFAULT 0,
  lora_count  INTEGER NOT NULL DEFAULT 0,
  node_count  INTEGER NOT NULL DEFAULT 0,
  meta_json   TEXT NOT NULL,
  raw_json    TEXT,
  starred     INTEGER NOT NULL DEFAULT 0,
  indexed_at  INTEGER NOT NULL,
  UNIQUE (root_id, rel_path)
);

CREATE INDEX IF NOT EXISTS idx_images_root_dir     ON images(root_id, rel_dir);
CREATE INDEX IF NOT EXISTS idx_images_mtime        ON images(file_mtime DESC);
CREATE INDEX IF NOT EXISTS idx_images_source       ON images(source);
CREATE INDEX IF NOT EXISTS idx_images_model        ON images(model_name);
CREATE INDEX IF NOT EXISTS idx_images_sampler      ON images(sampler_name);
CREATE INDEX IF NOT EXISTS idx_images_dims         ON images(width, height);
CREATE INDEX IF NOT EXISTS idx_images_starred      ON images(starred) WHERE starred = 1;
CREATE INDEX IF NOT EXISTS idx_images_path         ON images(abs_path);
-- 默认视图(某个图库根 + 最新优先)的排序索引:v0.8 性能轮补上。
-- 没有它时这条查询会先按 root_id 取行再 USE TEMP B-TREE 排序,真实库(1.8 万张)
-- 实测 100ms/次(冷盘 1.1s);有了它走覆盖索引,0ms。侧栏/标签/无限滚动每次翻页都要走这条。
CREATE INDEX IF NOT EXISTS idx_images_root_mtime   ON images(root_id, file_mtime DESC, id DESC);

-- 库级键值对(目前只存 meta_version:解析器口径版本)
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lora_refs (
  image_id    INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- 规范化名字(normalizeLoraName 的结果):配方筛选/统计直接按它走索引,
  -- 不必对每行调 SQL 函数。老库由 #migrateLoraBaseName 补列 + 回填 + 建索引。
  base_name   TEXT,
  strength    REAL,
  PRIMARY KEY (image_id, name)
);
CREATE INDEX IF NOT EXISTS idx_lora_refs_name ON lora_refs(name);

-- 全文检索:value 是归一化后的检索文本
--
-- 不能用 content='' 的内容型表:内容型 FTS5 不认 DELETE FROM images_fts
-- (报 "cannot DELETE from contentless fts5 table"),删除图片与清理失效索引都会失败。
-- 普通 FTS5 表会多存一份检索文本,换来正常的删除语义。
CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(
  value,
  tokenize='unicode61'
);

-- 文件夹显示偏好:别名与"是否在左侧栏显示"。只影响管理器显示,不动磁盘。
CREATE TABLE IF NOT EXISTS folder_prefs (
  root_id INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  rel_dir TEXT NOT NULL,
  hidden  INTEGER NOT NULL DEFAULT 0,
  alias   TEXT,
  PRIMARY KEY (root_id, rel_dir)
);

CREATE TABLE IF NOT EXISTS meta_info (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 用户自定义分类。与"扫描得出的文件夹树"是两套并存机制:
--   rel_dir 非空 -> 该分类同时是那个源文件夹的入口
--   rel_dir 为空 -> 纯虚拟分组,成员完全手动维护
-- 关键:原图永远不动,分类只存在于索引层。
CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  parent_id   INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  rel_dir     TEXT,
  root_id     INTEGER REFERENCES roots(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id, sort_order);

-- 分类 <-> 图片 多对多。一张图可以同时属于多个分类。
CREATE TABLE IF NOT EXISTS category_images (
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  image_id    INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (category_id, image_id)
);
CREATE INDEX IF NOT EXISTS idx_cat_images_image ON category_images(image_id);
`;

export const SEARCH_COLUMNS = [
  'file_name',
  'rel_dir',
  'model_name',
  'sampler_name',
  'scheduler',
  'pos_prompt',
  'neg_prompt',
] as const;

// ---------------------------------------------------------------- 类

/** 模型/LoRA 文件扩展名。UI 展示时统一剥掉,避免同一个模型出现两种写法。 */
const MODEL_EXT_RE = /\.(safetensors|ckpt|sft|gguf|pt|pth|bin|onnx)$/i;

/** 归一化模型/LoRA 名称用于展示与筛选去重 */
export function normalizeAssetName(name: string): string {
  return name.replace(MODEL_EXT_RE, '').trim();
}

export class AssetDb {
  readonly db: DatabaseSync;
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.db = new DatabaseSync(file);
    /**
     * 自定义 SQL 函数:LoRA 名规范化(去子目录/扩展名、小写)。
     * 实现就是 shared/recipes.ts 的 normalizeLoraName —— 匹配口径只有那一份真源,
     * "按配方筛选"与详情面板的 matchRecipes 才永远一致。
     * deterministic 让 SQLite 知道同一输入必得同一输出(可以放心做查询优化)。
     */
    this.db.function('cam_lora_base', { deterministic: true }, (name: unknown) =>
      normalizeLoraName(String(name ?? ''))
    );
    this.db.exec(SCHEMA);
    this.#migrateContentlessFts();
    this.#migrateLoraBaseName();
  }

  /**
   * 老库的 lora_refs 没有 base_name 列(规范化名字)。
   *
   * 为什么要这一列:配方筛选/统计以前写 `EXISTS(... cam_lora_base(lr.name) = ?)`,
   * **每行都要算一次 JS 函数**,索引也用不上。17 个配方的命中数统计在
   * 1.8 万张图的真实库上要 2.8~3.1 秒纯同步 SQL(主进程硬冻结)。
   *
   * 迁移只从库里已有的 name 回填(不重读 PNG),所以不动 META_VERSION。
   * 新库的 DDL 已含该列,这里只是补建索引。
   *
   * **索引必须是 (base_name, image_id) 复合索引,不能只建 (base_name)**:
   * 只建 (base_name) 时 SQLite 会用"按名字找行、再回表比对 image_id"的计划,
   * 一个常见 LoRA 有上万张图,EXISTS 每次都要沿索引扫上千条才能碰到目标行 ——
   * 实测一次配方筛选从 102ms 退化到 4920ms。带上 image_id 后两列都是等值条件,
   * 直接定位到唯一一行,同一次筛选 10ms。
   */
  #migrateLoraBaseName(): void {
    const cols = this.db.prepare('PRAGMA table_info(lora_refs)').all() as Array<{ name: string }>;
    const t0 = Date.now();
    const hadColumn = cols.some((c) => c.name === 'base_name');
    if (!hadColumn) this.db.exec('ALTER TABLE lora_refs ADD COLUMN base_name TEXT');

    /**
     * 有 NULL 就补回填。
     * 不只看"列在不在":上次迁移中途被打断(补了列没回填)的库,列是有的但值全是 NULL,
     * 那样配方筛选会一张都命中不了。这条探测走 base_name 索引(`IS NULL` 也能用),
     * 回填完成后是 0ms 的索引查找,不是全表扫描。
     */
    const pending = this.db.prepare('SELECT 1 AS x FROM lora_refs WHERE base_name IS NULL LIMIT 1').get();
    if (pending !== undefined) {
      this.db.exec('UPDATE lora_refs SET base_name = cam_lora_base(name) WHERE base_name IS NULL');
      console.log(`[db] lora_refs 迁移:${hadColumn ? '补' : '补列 + '}回填 base_name,${Date.now() - t0}ms`);
    }

    // 形状不对的旧索引(只有 base_name 一列)先删掉重建,否则 IF NOT EXISTS 会把慢计划留下
    const idxSql = (this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_lora_refs_base'`)
      .get() as { sql: string } | undefined)?.sql;
    if (idxSql && !/image_id/.test(idxSql)) this.db.exec('DROP INDEX idx_lora_refs_base');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_lora_refs_base ON lora_refs(base_name, image_id)');
  }

  /**
   * 老库里的 images_fts 是 content='' 的内容型表,删除语义不可用。
   * 检测到就换成普通 FTS5 表,并从 images/lora_refs 重建索引(不重读 PNG)。
   */
  #migrateContentlessFts(): void {
    const row = this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'images_fts'`)
      .get() as { sql: string } | undefined;
    if (!row || !/content\s*=\s*''/.test(row.sql)) return;

    this.db.exec('DROP TABLE images_fts');
    this.db.exec(`CREATE VIRTUAL TABLE images_fts USING fts5(value, tokenize='unicode61')`);
    this.#rebuildFts();
  }

  /** 用库里已有的结构化字段重建全文索引(等价于扫描时写入的检索文本) */
  #rebuildFts(): void {
    const images = this.db
      .prepare(
        `SELECT id, file_name, rel_dir, model_name, sampler_name, scheduler, pos_prompt, neg_prompt
         FROM images`
      )
      .all() as Array<{
        id: number; file_name: string; rel_dir: string;
        model_name: string | null; sampler_name: string | null; scheduler: string | null;
        pos_prompt: string | null; neg_prompt: string | null;
      }>;
    const loraRows = this.db
      .prepare('SELECT image_id, name FROM lora_refs ORDER BY image_id')
      .all() as Array<{ image_id: number; name: string }>;
    const lorasByImage = new Map<number, string[]>();
    for (const r of loraRows) {
      const list = lorasByImage.get(r.image_id);
      if (list) list.push(r.name);
      else lorasByImage.set(r.image_id, [r.name]);
    }

    const ins = this.db.prepare('INSERT INTO images_fts (rowid, value) VALUES (?, ?)');
    this.transaction(() => {
      for (const r of images) {
        ins.run(
          r.id,
          buildSearchText({
            fileName: r.file_name,
            relDir: r.rel_dir,
            modelName: r.model_name,
            samplerName: r.sampler_name,
            scheduler: r.scheduler,
            loras: lorasByImage.get(r.id) ?? [],
            prompts: [r.pos_prompt, r.neg_prompt].filter((x): x is string => typeof x === 'string' && x !== ''),
          })
        );
      }
    });
  }

  close(): void {
    try { this.db.close(); } catch { /* 已关闭 */ }
  }

  // ------------------------------------------------------------ 根目录

  listRoots() {
    return this.db
      .prepare(
        `SELECT id, path, label, enabled, added_at AS addedAt, last_scan_at AS lastScanAt
         FROM roots ORDER BY id`
      )
      .all() as Array<{
        id: number; path: string; label: string; enabled: number;
        addedAt: number; lastScanAt: number | null;
      }>;
  }

  findRootByPath(p: string) {
    return this.db.prepare('SELECT id FROM roots WHERE path = ?').get(p) as { id: number } | undefined;
  }

  addRoot(p: string, label?: string) {
    const now = Date.now();
    const name = label?.trim() || path.basename(p) || p;
    const existing = this.findRootByPath(p);
    if (existing) {
      this.db.prepare('UPDATE roots SET label = ?, enabled = 1 WHERE id = ?').run(name, existing.id);
      return existing.id;
    }
    const r = this.db.prepare(
      'INSERT INTO roots (path, label, enabled, added_at) VALUES (?, ?, 1, ?)'
    ).run(p, name, now);
    return Number(r.lastInsertRowid);
  }

  removeRoot(id: number): void {
    this.db.prepare('DELETE FROM roots WHERE id = ?').run(id);
  }

  setRootEnabled(id: number, enabled: boolean): void {
    this.db.prepare('UPDATE roots SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  markRootScanned(id: number): void {
    this.db.prepare('UPDATE roots SET last_scan_at = ? WHERE id = ?').run(Date.now(), id);
  }

  /**
   * 把某个图库根重指向新路径。
   *
   * 为什么需要:索引里存的是绝对路径,交付包换机器或图库挪位置后 roots.path 会失效,
   * 导致图片与缩略图全部读不出来。但 images.rel_path 保留了相对结构,
   * 所以**只需改 root 的 path,不需要重新扫描全库**。
   *
   * @returns 该 root 下受影响(即保持可用)的图片数
   */
  setRootPath(id: number, newPath: string, label?: string): number {
    const exists = this.db.prepare('SELECT id FROM roots WHERE id = ?').get(id) as { id: number } | undefined;
    if (!exists) throw new Error(`图库根 #${id} 不存在`);
    // 注意:?? 与 || 不能不加括号混用,否则会被 TS 解析器判为语法错误
    // (Node 的 --experimental-strip-types 直接就报 ERR_INVALID_TYPESCRIPT_SYNTAX)。
    const fallback = path.basename(newPath) || newPath;
    this.db
      .prepare('UPDATE roots SET path = ?, label = ? WHERE id = ?')
      .run(newPath, label ?? fallback, id);
    return (this.db.prepare('SELECT COUNT(*) AS c FROM images WHERE root_id = ?').get(id) as { c: number }).c;
  }

  /** 该 root 下已索引的 (rel_path -> mtime|size) 映射,用于增量跳过 */
  loadFingerprints(rootId: number): Map<string, { id: number; mtime: number; size: number }> {
    const rows = this.db
      .prepare('SELECT id, rel_path, file_mtime, file_size FROM images WHERE root_id = ?')
      .all(rootId) as Array<{ id: number; rel_path: string; file_mtime: number; file_size: number }>;
    const m = new Map<string, { id: number; mtime: number; size: number }>();
    for (const r of rows) m.set(r.rel_path, { id: r.id, mtime: r.file_mtime, size: r.file_size });
    return m;
  }

  /**
   * 单条 rel_path 的指纹(id + mtime + size)。定点入库(scanPaths)用:
   * 只处理几个文件时不该把整库 1.8 万条指纹全加载进内存。
   * (root_id, rel_path) 上有唯一索引,单条查询是索引命中。
   */
  getImageByRelPath(rootId: number, relPath: string): { id: number; mtime: number; size: number } | null {
    const r = this.db
      .prepare('SELECT id, file_mtime, file_size FROM images WHERE root_id = ? AND rel_path = ?')
      .get(rootId, relPath) as { id: number; file_mtime: number; file_size: number } | undefined;
    return r ? { id: r.id, mtime: r.file_mtime, size: r.file_size } : null;
  }

  /**
   * 某个目录(含子目录)下的图片相对路径,最多 limit 条。
   * 定点清理"目录被删"时用它抽样确认:这些路径在盘上还在不在。
   */
  indexedRelPathsUnder(rootId: number, relDir: string, limit = 3): string[] {
    const base = String(relDir ?? '').replace(/[\\/]+$/, '');
    if (!base) return [];
    return (
      this.db
        .prepare(
          `SELECT rel_path FROM images
           WHERE root_id = ? AND (rel_dir = ? OR rel_dir LIKE ? ESCAPE '!' OR rel_dir LIKE ? ESCAPE '!')
           LIMIT ?`
        )
        .all(rootId, base, descPattern(base, '\\'), descPattern(base, '/'), limit) as Array<{ rel_path: string }>
    ).map((r) => r.rel_path);
  }

  /** 删掉某个目录(含子目录)下的所有索引行,返回删掉的行数 */
  deleteImagesUnderRelDir(rootId: number, relDir: string): number {
    const base = String(relDir ?? '').replace(/[\\/]+$/, '');
    if (!base) return 0;
    const rows = this.db
      .prepare(
        `SELECT id FROM images
         WHERE root_id = ? AND (rel_dir = ? OR rel_dir LIKE ? ESCAPE '!' OR rel_dir LIKE ? ESCAPE '!')`
      )
      .all(rootId, base, descPattern(base, '\\'), descPattern(base, '/')) as Array<{ id: number }>;
    if (rows.length === 0) return 0;
    const del = this.db.prepare('DELETE FROM images WHERE id = ?');
    const delFts = this.db.prepare('DELETE FROM images_fts WHERE rowid = ?');
    this.transaction(() => {
      for (const r of rows) {
        delFts.run(r.id);
        del.run(r.id);
      }
    });
    return rows.length;
  }

  // ------------------------------------------------------------ 写入

  /** 插入或更新一张图。返回 { id, created } */
  upsertImage(input: {
    rootId: number;
    absPath: string;
    relPath: string;
    relDir: string;
    fileName: string;
    fileSize: number;
    fileMtime: number;
    width: number | null;
    height: number | null;
    source: string;
    modelName: string | null;
    samplerName: string | null;
    scheduler: string | null;
    steps: number | null;
    cfg: number | null;
    seed: number | null;
    posPrompt: string | null;
    negPrompt: string | null;
    promptLen: number;
    loraCount: number;
    nodeCount: number;
    metaJson: string;
    rawJson: string | null;
    loras: Array<{ name: string; strength: number | null }>;
    searchText: string;
  }): { id: number; created: boolean } {
    const now = Date.now();
    const existing = this.db
      .prepare('SELECT id FROM images WHERE root_id = ? AND rel_path = ?')
      .get(input.rootId, input.relPath) as { id: number } | undefined;

    let id: number;
    let created: boolean;

    if (existing) {
      id = existing.id;
      created = false;
      this.db.prepare(
        `UPDATE images SET
           abs_path=?, rel_dir=?, file_name=?, file_size=?, file_mtime=?,
           width=?, height=?, source=?, model_name=?, sampler_name=?, scheduler=?,
           steps=?, cfg=?, seed=?, pos_prompt=?, neg_prompt=?, prompt_len=?,
           lora_count=?, node_count=?, meta_json=?, raw_json=?, indexed_at=?
         WHERE id=?`
      ).run(
        input.absPath, input.relDir, input.fileName, input.fileSize, input.fileMtime,
        input.width, input.height, input.source, input.modelName, input.samplerName, input.scheduler,
        input.steps, input.cfg, input.seed, input.posPrompt, input.negPrompt, input.promptLen,
        input.loraCount, input.nodeCount, input.metaJson, input.rawJson, now, id
      );
      this.db.prepare('DELETE FROM lora_refs WHERE image_id = ?').run(id);
      this.db.prepare('DELETE FROM images_fts WHERE rowid = ?').run(id);
    } else {
      const r = this.db.prepare(
        `INSERT INTO images (
           root_id, abs_path, rel_path, rel_dir, file_name, file_size, file_mtime,
           width, height, source, model_name, sampler_name, scheduler, steps, cfg, seed,
           pos_prompt, neg_prompt, prompt_len, lora_count, node_count, meta_json, raw_json,
           starred, indexed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`
      ).run(
        input.rootId, input.absPath, input.relPath, input.relDir, input.fileName, input.fileSize, input.fileMtime,
        input.width, input.height, input.source, input.modelName, input.samplerName, input.scheduler,
        input.steps, input.cfg, input.seed, input.posPrompt, input.negPrompt, input.promptLen,
        input.loraCount, input.nodeCount, input.metaJson, input.rawJson, now
      );
      id = Number(r.lastInsertRowid);
      created = true;
    }

    if (input.loras.length) {
      // base_name 在 JS 侧一次算好再写 —— 不在 SQL 里调 cam_lora_base,
      // 免得每行都过一遍自定义函数(建库/回填之外不该再用它)。
      const insLora = this.db.prepare(
        'INSERT OR REPLACE INTO lora_refs (image_id, name, base_name, strength) VALUES (?,?,?,?)'
      );
      for (const l of input.loras) insLora.run(id, l.name, normalizeLoraName(l.name), l.strength);
    }
    this.db.prepare('INSERT INTO images_fts (rowid, value) VALUES (?, ?)').run(id, input.searchText);

    return { id, created };
  }

  /** 读库级键值(不存在返回 null) */
  getKv(key: string): string | null {
    try {
      const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row ? row.value : null;
    } catch {
      return null;
    }
  }

  /** 写库级键值 */
  setKv(key: string, value: string): void {
    try {
      this.db
        .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value);
    } catch {
      /* 老库没能建出 kv 表时忽略:下次启动会重建 */
    }
  }

  /**
   * 某个图库根的"目录树签名"(见 indexer.ts 的 TreeSignature)。
   *
   * 存在 kv 表里,不新增表结构:老库不需要迁移,读不到就当"没有签名",
   * 顶多多走一次完整遍历 —— 行为退回到以前,不会出错。
   */
  getTreeSignature(rootId: number): { count: number; rootMtime: number } | null {
    const raw = this.getKv('tree_sig_' + rootId);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as { count?: unknown; rootMtime?: unknown };
      if (typeof v.count !== 'number' || typeof v.rootMtime !== 'number') return null;
      return { count: v.count, rootMtime: v.rootMtime };
    } catch {
      return null;
    }
  }

  setTreeSignature(rootId: number, sig: { count: number; rootMtime: number }): void {
    this.setKv('tree_sig_' + rootId, JSON.stringify(sig));
  }

  /**
   * 作废目录树签名 → 下一次启动扫描会老实走一遍全量对账。
   * 用在"整目录被删/搬走"这种拿不准净变化的场景:定点清理只保证"不再指向不存在的路径",
   * 若那其实是**目录改名**、文件还在新路径上,只有一次全量对账才能把它们重新收进来。
   */
  clearTreeSignature(rootId: number): void {
    try {
      this.db.prepare('DELETE FROM kv WHERE key = ?').run('tree_sig_' + rootId);
    } catch {
      /* 清不掉就留着,下次签名不一致自然会全量扫 */
    }
  }

  /** 某个图库根当前索引到的行数(用来判断"要不要做第一次扫描") */
  countImages(rootId: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM images WHERE root_id = ?').get(rootId) as
      | { c: number }
      | undefined;
    return row ? row.c : 0;
  }

  deleteImagesNotIn(rootId: number, keepRelPaths: Set<string>): number {
    const rows = this.db.prepare('SELECT id, rel_path FROM images WHERE root_id = ?').all(rootId) as Array<{
      id: number; rel_path: string;
    }>;
    const del = this.db.prepare('DELETE FROM images WHERE id = ?');
    const delFts = this.db.prepare('DELETE FROM images_fts WHERE rowid = ?');
    let n = 0;
    for (const r of rows) {
      if (keepRelPaths.has(r.rel_path)) continue;
      delFts.run(r.id);
      del.run(r.id);
      n++;
    }
    return n;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const v = fn();
      this.db.exec('COMMIT');
      return v;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }

  // ------------------------------------------------------------ 查询

  /** 组装 WHERE 子句。返回 [sql, params] */
  #buildWhere(q: Record<string, unknown>): { where: string; params: SQLValue[] } {
    const parts: string[] = [];
    const params: SQLValue[] = [];
    /**
     * 把外部传入的值收窄成 node:sqlite 能绑定的标量。
     * 之前这里直接用 unknown[],导致每次 ...params 都触发 TS2345。
     * 显式转换还有个好处:传进来无法绑定的类型会立刻抛错,而不是到 SQL 层才失败。
     */
    const toSql = (v: unknown): SQLValue => {
      if (v === null || v === undefined) return null;
      const t = typeof v;
      if (t === 'string' || t === 'number' || t === 'bigint' || t === 'boolean') {
        return t === 'boolean' ? (v ? 1 : 0) : (v as SQLValue);
      }
      if (v instanceof Uint8Array) return v;
      throw new Error(`不支持的 SQL 绑定参数类型: ${t}`);
    };
    const push = (sql: string, ...vals: unknown[]) => {
      parts.push(sql);
      for (const v of vals) params.push(toSql(v));
    };

    if (q.rootId !== undefined) push('i.root_id = ?', q.rootId);

    // 空串 / null 一律当作"没有目录筛选"(否则 null 会被拼成 LIKE 'null%')
    const relDir = q.relDir;
    if (relDir !== undefined && relDir !== null && relDir !== '') {
      if (q.relDirRecursive) {
        /**
         * 「这个文件夹**及其所有子目录**里的图」—— 点左侧文件夹树就是看这个(v0.6)。
         *
         * 三个必须一起满足的细节:
         *  1. 末尾的 `%` 必须保持通配符,只转义 base 里的元字符
         *     (写成 escapeLike(base) + '!%' 会让 ! 把 % 转义成字面百分号,永远匹配不到);
         *  2. 分隔符**必须跟着模式走**:`A\B` 的子孙是 `A\B\C`,而 `A` 的子孙是 `A\B`;
         *     统一用 `\` 的话 `A/%` 就一个都匹配不到;
         *  3. 通配符必须紧跟分隔符:`A%` 会把**兄弟目录** `AB`、`A2` 一起算进来
         *     (索引里 rel_dir = 'AB' 并不是 'A' 的子目录)。所以是 `A` 或 `A\%`。
         */
        const base = String(relDir).replace(/[\\/]+$/, '');
        if (base === '') {
          // 根目录:'' 的子孙就是所有非空 rel_dir,不用再加目录条件
          parts.push(`i.rel_dir <> ''`);
        } else {
          // 两种分隔符各一条:库里写的是反斜杠,但 / 也认(跨平台导入过的库)
          push(
            `(i.rel_dir = ? OR i.rel_dir LIKE ? ESCAPE '!' OR i.rel_dir LIKE ? ESCAPE '!')`,
            base,
            descPattern(base, '\\'),
            descPattern(base, '/')
          );
        }
      } else {
        push('i.rel_dir = ?', relDir);
      }
    }

    const sources = q.sources as string[] | undefined;
    if (sources && sources.length) {
      push(`i.source IN (${sources.map(() => '?').join(',')})`, ...sources);
    }

    if (q.starredOnly) parts.push('i.starred = 1');
    if (q.minWidth !== undefined) push('i.width >= ?', q.minWidth);
    if (q.maxWidth !== undefined) push('i.width <= ?', q.maxWidth);
    if (q.minHeight !== undefined) push('i.height >= ?', q.minHeight);
    if (q.maxHeight !== undefined) push('i.height <= ?', q.maxHeight);
    if (q.samplerName) push('i.sampler_name = ?', q.samplerName);
    if (q.modelName) push('i.model_name = ?', q.modelName);
    if (q.mtimeFrom !== undefined) push('i.file_mtime >= ?', q.mtimeFrom);
    if (q.mtimeTo !== undefined) push('i.file_mtime <= ?', q.mtimeTo);

    const loraName = q.loraName as string | undefined;
    if (loraName) {
      parts.push('EXISTS (SELECT 1 FROM lora_refs lr WHERE lr.image_id = i.id AND lr.name = ?)');
      params.push(loraName);
    }

    const ids = q.ids as number[] | undefined;
    if (ids && ids.length) push(`i.id IN (${ids.map(() => '?').join(',')})`, ...ids);

    // 用户自定义分类:按索引层的集合归属筛选,与 relDir 语义完全不同。
    // categoryRecursive 默认 true —— 点了父分类通常希望看到子分类的图。
    const categoryId = q.categoryId as number | undefined;
    if (categoryId !== undefined && categoryId !== null) {
      const recursive = q.categoryRecursive === undefined ? true : q.categoryRecursive !== false;
      const catIds = recursive ? this.#categoryWithDescendants(categoryId) : [categoryId];
      if (catIds.length === 0) {
        // 分类不存在 -> 空结果,而不是当成"不过滤"
        parts.push('1 = 0');
      } else {
        parts.push(
          `EXISTS (SELECT 1 FROM category_images ci
                   WHERE ci.image_id = i.id AND ci.category_id IN (${catIds.map(() => '?').join(',')}))`
        );
        params.push(...catIds);
      }
    }

    /**
     * 按 LoRA 配方筛选(v0.8,内部字段,由主进程把 recipeId 展开后传入,渲染层不直接传)。
     * 子集语义(与 shared/recipes.ts 的 matchRecipes 同口径):
     * 每条非 exclude 的 LoRA 一个 EXISTS,全部满足才算命中。
     * **只看名字,不看权重** —— 出图时调过权重不该让整组配方失效(见 matchRecipes 的说明)。
     *
     * 规范化:配方侧的裸名先过 normalizeLoraName(与 cam_lora_base 同一份真源),
     * 图侧比的是写入时就存好的 lora_refs.base_name 列 —— 相等即可走索引,
     * 不用对每一行再调一次 SQL 函数(那是 17 个配方要 3 秒的原因)。
     */
    if (q.recipeNoMatch === true) {
      // 配方不存在 / 无有效 LoRA -> 空结果,而不是当成"不过滤"(与"分类不存在"的先例一致)
      parts.push('1 = 0');
    }
    const recipeLoraNames = q.recipeLoraNames as string[] | undefined;
    if (Array.isArray(recipeLoraNames)) {
      for (const raw of recipeLoraNames) {
        if (typeof raw !== 'string') continue;
        const base = normalizeLoraName(raw);
        if (!base) continue;
        push(
          `EXISTS (SELECT 1 FROM lora_refs lr WHERE lr.image_id = i.id AND lr.base_name = ?)`,
          base
        );
      }
    }

    const where = parts.length ? 'WHERE ' + parts.join(' AND ') : '';
    return { where, params };
  }

  #orderBy(sort: string | undefined): string {
    switch (sort) {
      case 'mtime_asc': return 'ORDER BY i.file_mtime ASC, i.id ASC';
      case 'name_asc': return 'ORDER BY i.file_name COLLATE NOCASE ASC, i.id ASC';
      case 'size_desc': return 'ORDER BY i.file_size DESC, i.id DESC';
      case 'random': return 'ORDER BY RANDOM()';
      case 'mtime_desc':
      default: return 'ORDER BY i.file_mtime DESC, i.id DESC';
    }
  }

  queryImages(q: Record<string, unknown>): { ids: number[]; total: number } {
    const { where, params } = this.#buildWhere(q);
    const order = this.#orderBy(q.sort as string | undefined);
    const limit = typeof q.limit === 'number' && q.limit > 0 ? q.limit : 200;
    const offset = typeof q.offset === 'number' && q.offset > 0 ? q.offset : 0;

    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM images i ${where}`).get(...params) as { c: number }).c;
    const rows = this.db
      .prepare(`SELECT i.id FROM images i ${where} ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<{ id: number }>;
    return { ids: rows.map((r) => r.id), total };
  }

  /** 全文检索。返回按相关度排序的 id 列表。 */
  searchIds(query: string, limit = 2000): number[] {
    const expr = toMatchExpr(query);
    if (!expr) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT rowid AS id FROM images_fts WHERE images_fts MATCH ?
           ORDER BY bm25(images_fts) LIMIT ?`
        )
        .all(expr, limit) as Array<{ id: number }>;
      return rows.map((r) => r.id);
    } catch {
      return [];
    }
  }

  /** 批量取图片元数据(不含 raw_json) */
  getImagesByIds(ids: number[]): unknown[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM images WHERE id IN (${placeholders})`)
      .all(...ids) as Array<Record<string, unknown>>;
    const byId = new Map<number, Record<string, unknown>>();
    for (const r of rows) byId.set(r.id as number, r);
    return ids.map((id) => {
      const r = byId.get(id);
      return r ? this.#rowToApi(r) : null;
    }).filter(Boolean);
  }

  getImageRow(id: number): Record<string, unknown> | null {
    const r = this.db.prepare('SELECT * FROM images WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ?? null;
  }

  /** 单张详情,含 raw_json */
  getImageDetail(id: number): Record<string, unknown> | null {
    const r = this.getImageRow(id);
    if (!r) return null;
    const out = this.#rowToApi(r) as Record<string, unknown>;
    const meta = out.meta as Record<string, unknown> | null;
    if (meta && typeof r.raw_json === 'string') meta.rawPromptJson = r.raw_json;
    return out;
  }

  // ------------------------------------------------------------ 配方比对(v0.8)

  /**
   * 一批配方的命中数(左侧「配方」小节的数量胶囊),一次查询算完。
   *
   * 为什么不用"每配方一条 queryImages().total":那要为 17 个配方各跑一次全表 COUNT,
   * 且每条 LoRA 一个 `cam_lora_base(lr.name) = ?` 的 EXISTS —— 每行都要算 JS 函数,
   * 1.8 万张图的真实库实测 **2.8~3.1 秒纯同步 SQL**(主进程整段冻结)。
   *
   * 这里的做法:
   *   1. 需求集写进临时表 need(recipe_id, base):`lora_refs(base_name, image_id)` 索引可用
   *      (DISTINCT image_id + base_name 正好是覆盖索引);
   *   2. 一条查询按「每张图对每个配方命中了几条 / 该配方总共要几条」自连接,
   *      hit = need_n 即"子集齐了"(与按配方筛选的 EXISTS 口径**逐条一致**);
   *   3. 返回的 Map 里没有的配方 = 0 命中(含"配方没有任何有效 LoRA"的情况)。
   *
   * 临时表随连接存在,复用同一份 DDL;node:sqlite 是同步 API,
   * 同一连接上不会真的并发,方法内部自洽(每次先清空再写)。
   */
  recipeCounts(need: Array<{ recipeId: string; names: string[] }>): Map<string, number> {
    const out = new Map<string, number>();
    if (!Array.isArray(need) || need.length === 0) return out;

    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS need(recipe_id TEXT, base TEXT, PRIMARY KEY(recipe_id, base))');
    this.db.exec('DELETE FROM need');
    const ins = this.db.prepare('INSERT OR IGNORE INTO need(recipe_id, base) VALUES(?,?)');
    let rows = 0;
    for (const n of need) {
      const recipeId = String(n.recipeId ?? '');
      if (!recipeId) continue;
      for (const raw of Array.isArray(n.names) ? n.names : []) {
        const base = normalizeLoraName(typeof raw === 'string' ? raw : '');
        if (!base) continue;
        ins.run(recipeId, base);
        rows++;
      }
    }
    // 一条有效 LoRA 都没有的配方:旧口径直接记 0,不进查询(否则 need_n=0 会让它命中全库)
    if (rows === 0) return out;

    const found = this.db
      .prepare(
        `SELECT t.recipe_id AS recipe_id, COUNT(*) AS c FROM (
           SELECT n.recipe_id AS recipe_id, m.image_id AS image_id, COUNT(*) AS hit,
                  (SELECT COUNT(*) FROM need n2 WHERE n2.recipe_id = n.recipe_id) AS need_n
           FROM need n JOIN (SELECT DISTINCT image_id, base_name AS base FROM lora_refs WHERE base_name IS NOT NULL) m
             ON m.base = n.base
           GROUP BY n.recipe_id, m.image_id
         ) t WHERE t.hit = t.need_n GROUP BY t.recipe_id`
      )
      .all() as Array<{ recipe_id: string; c: number }>;
    for (const r of found) out.set(String(r.recipe_id), Number(r.c));
    return out;
  }

  /**
   * 提示词**完全相同**的图 id(精确模式)。
   *
   * 口径:`lower(trim(pos_prompt)) = ?` —— 与 shared/prompts.ts 的 normalizePrompt 的
   * "小写 + 收空白"一致,但**不剥强调权重语法**(`(word:1.3)` 这类差异交给"相似"模式兜住),
   * 因为 SQL 侧没法复现那套括号规则。pos_prompt 没有索引,这里是全表扫描
   * (1.8 万行实测百毫秒级,可接受)。参数一律绑定,不拼用户内容进 SQL。
   */
  peerIdsByPrompt(normalizedPrompt: string, limit: number): number[] {
    const key = String(normalizedPrompt ?? '').trim().toLowerCase();
    if (!key) return [];
    const lim = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
    return (
      this.db
        .prepare(
          `SELECT id FROM images
           WHERE pos_prompt IS NOT NULL AND lower(trim(pos_prompt)) = ?
           ORDER BY file_mtime DESC, id DESC LIMIT ?`
        )
        .all(key, lim) as Array<{ id: number }>
    ).map((r) => r.id);
  }

  /**
   * 相似模式的**召回**预筛:`pos_prompt LIKE '%token%'` 的 OR 连接(最多 8 个 token)。
   *
   * 这里只负责"别漏",真正的相似度判定由调用方用 shared/prompts.ts 的
   * promptSimilarity 逐条算(阈值 0.85)。按 mtime 倒序 + LIMIT 保证截断时留下的是新图;
   * LIKE 元字符走 escapeLike + ESCAPE '!',token 只做子串匹配(命中偏多,由相似度收口)。
   */
  candidateIdsByTokens(tokens: string[], limit: number): number[] {
    const toks = (Array.isArray(tokens) ? tokens : [])
      .map((t) => String(t ?? '').trim().toLowerCase())
      .filter((t) => t.length >= 2)
      .slice(0, 8);
    if (toks.length === 0) return [];
    const lim = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 3000;
    const where = toks.map(() => `pos_prompt LIKE ? ESCAPE '!'`).join(' OR ');
    const params = toks.map((t) => `%${escapeLike(t)}%`);
    return (
      this.db
        .prepare(
          `SELECT id FROM images
           WHERE pos_prompt IS NOT NULL AND (${where})
           ORDER BY file_mtime DESC, id DESC LIMIT ?`
        )
        .all(...params, lim) as Array<{ id: number }>
    ).map((r) => r.id);
  }

  /** 只要提示词(相似度预筛用):候选可能上千条,单独取一列比整行便宜得多 */
  getPromptsByIds(ids: number[]): Array<{ id: number; prompt: string | null }> {
    const uniq = uniqueIds(ids);
    const out: Array<{ id: number; prompt: string | null }> = [];
    // 分片绑定:上千个占位符会撞上 SQLite 的变量数上限
    for (const chunk of chunkIds(uniq)) {
      const ph = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT id, pos_prompt FROM images WHERE id IN (${ph})`)
        .all(...chunk) as Array<{ id: number; pos_prompt: string | null }>;
      for (const r of rows) out.push({ id: r.id, prompt: r.pos_prompt });
    }
    return out;
  }

  /**
   * 配方比对的数据行(文件名/目录/宽高/seed/提示词/LoRA),顺序与传入 ids 一致。
   * 只取需要的列 —— 比对一次可能上百行,不需要 meta_json / raw_json(单块能上兆)。
   */
  getCompareBasics(ids: number[]): CompareBasic[] {
    const uniq = uniqueIds(ids);
    if (uniq.length === 0) return [];
    const rowsById = new Map<number, Omit<CompareBasic, 'loras'>>();
    const lorasById = new Map<number, Array<{ name: string; strength: number | null }>>();
    for (const chunk of chunkIds(uniq)) {
      const ph = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT id, file_name, rel_dir, width, height, seed, pos_prompt
           FROM images WHERE id IN (${ph})`
        )
        .all(...chunk) as Array<{
        id: number;
        file_name: string;
        rel_dir: string;
        width: number | null;
        height: number | null;
        seed: number | null;
        pos_prompt: string | null;
      }>;
      for (const r of rows) {
        rowsById.set(r.id, {
          id: r.id,
          fileName: r.file_name,
          relDir: r.rel_dir,
          width: r.width,
          height: r.height,
          seed: r.seed,
          prompt: r.pos_prompt,
        });
      }
      const loras = this.db
        .prepare(`SELECT image_id, name, strength FROM lora_refs WHERE image_id IN (${ph})`)
        .all(...chunk) as Array<{ image_id: number; name: string; strength: number | null }>;
      for (const l of loras) {
        const list = lorasById.get(l.image_id);
        if (list) list.push({ name: l.name, strength: l.strength });
        else lorasById.set(l.image_id, [{ name: l.name, strength: l.strength }]);
      }
    }
    return uniq
      .map((id) => {
        const base = rowsById.get(id);
        return base ? { ...base, loras: lorasById.get(id) ?? [] } : null;
      })
      .filter((x): x is CompareBasic => x !== null);
  }

  /**
   * 结果集内的邻居(用于详情页左右翻页)。
   *
   * 实现说明:先把该筛选条件下的 id 顺序取出来(上限 window),再定位目标
   * 在其中或窗口两端的位置。相比在 SQL 里拼排序键表达式,这样更简单也更不容易出错
   * ——排序键在多列/文本排序下没法可靠地用 SQL 比较。
   */
  getSiblings(
    id: number,
    q: Record<string, unknown>,
    window = 400
  ): { ids: number[]; position: number; total: number } {
    // 先用"不含分页"的条件算出总数与目标位置。
    // 关键:必须显式清掉 limit/offset,否则 #buildWhere 会把它们当 id 白名单,
    // 导致窗口退化成同一批图(早期版本就踩了这个坑)。
    const base: Record<string, unknown> = { ...q, limit: undefined, offset: undefined };
    const { where, params } = this.#buildWhere(base);
    const order = this.#orderBy(q.sort as string | undefined);

    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM images i ${where}`).get(...params) as { c: number }).c;

    // 位置只对"按时间倒序"有意义,这也是唯一的默认浏览序。
    // 其它排序下不猜位置,直接从头开窗,避免给出错误的页码。
    const sort = q.sort as string | undefined;
    if (sort !== undefined && sort !== 'mtime_desc') {
      const rows0 = this.db
        .prepare(`SELECT i.id FROM images i ${where} ${order} LIMIT ?`)
        .all(...params, window) as Array<{ id: number }>;
      return { ids: rows0.map((r) => r.id), position: 0, total };
    }

    // 目标在排序结果里的位置。注意 #buildWhere 可能返回空 where,
    // 所以先垫一个恒真条件保证 sql 始终合法(否则会拼出 "... FROM images i AND (...)")
    const guard = where === '' ? 'WHERE 1=1' : where;
    const posRow = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM images i ${guard}
         AND (
           i.file_mtime > (SELECT file_mtime FROM images WHERE id = ?)
           OR (
             i.file_mtime = (SELECT file_mtime FROM images WHERE id = ?)
             AND i.id > ?
           )
         )`
      )
      .get(...params, id, id, id) as { c: number } | undefined;
    const position = (posRow === undefined ? 0 : posRow.c) + 1;

    // 以目标为中心取一个窗口
    const half = Math.floor(window / 2);
    let offset = Math.max(0, position - 1 - half);
    if (offset + window > total) offset = Math.max(0, total - window);

    const rows = this.db
      .prepare(`SELECT i.id FROM images i ${where} ${order} LIMIT ? OFFSET ?`)
      .all(...params, window, offset) as Array<{ id: number }>;

    return { ids: rows.map((r) => r.id), position, total };
  }

  /** 目录树(含子目录计数) */
  /** 全部文件夹显示偏好 */
  listFolderPrefs(): Array<{ rootId: number; relDir: string; hidden: boolean; alias: string | null }> {
    const rows = this.db
      .prepare('SELECT root_id, rel_dir, hidden, alias FROM folder_prefs')
      .all() as Array<{ root_id: number; rel_dir: string; hidden: number; alias: string | null }>;
    return rows.map((r) => ({
      rootId: r.root_id,
      relDir: r.rel_dir,
      hidden: r.hidden === 1,
      alias: r.alias,
    }));
  }

  /** 写一条偏好(只传要改的字段);两个字段都清空时删行 */
  setFolderPref(
    rootId: number,
    relDir: string,
    patch: { hidden?: boolean; alias?: string | null }
  ): { rootId: number; relDir: string; hidden: boolean; alias: string | null } {
    const cur = this.db
      .prepare('SELECT hidden, alias FROM folder_prefs WHERE root_id = ? AND rel_dir = ?')
      .get(rootId, relDir) as { hidden: number; alias: string | null } | undefined;
    const hidden = patch.hidden === undefined ? (cur?.hidden === 1) : patch.hidden;
    const alias =
      patch.alias === undefined
        ? (cur?.alias ?? null)
        : (patch.alias && patch.alias.trim()) || null;

    if (!hidden && !alias) {
      this.db.prepare('DELETE FROM folder_prefs WHERE root_id = ? AND rel_dir = ?').run(rootId, relDir);
    } else {
      this.db
        .prepare(
          `INSERT INTO folder_prefs (root_id, rel_dir, hidden, alias) VALUES (?,?,?,?)
           ON CONFLICT(root_id, rel_dir) DO UPDATE SET hidden = excluded.hidden, alias = excluded.alias`
        )
        .run(rootId, relDir, hidden ? 1 : 0, alias);
    }
    return { rootId, relDir, hidden, alias };
  }

  getFolderTree(rootId?: number): unknown[] {
    const roots = (rootId === undefined
      ? this.db.prepare('SELECT id, label, path FROM roots ORDER BY id').all()
      : this.db.prepare('SELECT id, label, path FROM roots WHERE id = ?').all(rootId)) as Array<{
        id: number; label: string; path: string;
      }>;

    const out: unknown[] = [];
    for (const root of roots) {
      const rows = this.db
        .prepare('SELECT rel_dir, COUNT(*) AS c FROM images WHERE root_id = ? GROUP BY rel_dir')
        .all(root.id) as Array<{ rel_dir: string; c: number }>;

      // 先算每个目录的"直属"计数
      const direct = new Map<string, number>();
      for (const r of rows) direct.set(r.rel_dir, r.c);

      // 每个目录里最新一张图的生成时间(用于"日期新的排前面")
      const latestRows = this.db
        .prepare('SELECT rel_dir, MAX(file_mtime) AS m FROM images WHERE root_id = ? GROUP BY rel_dir')
        .all(root.id) as Array<{ rel_dir: string; m: number | null }>;
      const latestDirect = new Map<string, number>();
      for (const r of latestRows) if (r.m) latestDirect.set(r.rel_dir, r.m);

      // 显示偏好(别名 / 是否隐藏)
      const prefRows = this.db
        .prepare('SELECT rel_dir, hidden, alias FROM folder_prefs WHERE root_id = ?')
        .all(root.id) as Array<{ rel_dir: string; hidden: number; alias: string | null }>;
      const prefs = new Map<string, { hidden: boolean; alias: string | null }>();
      for (const p of prefRows) prefs.set(p.rel_dir, { hidden: p.hidden === 1, alias: p.alias });

      // 再自底向上累积出 totalCount
      const allDirs = new Set<string>(['']);
      for (const r of rows) {
        if (!r.rel_dir) continue;
        const segs = r.rel_dir.split(/[\\/]/);
        let acc = '';
        for (const s of segs) {
          acc = acc ? `${acc}\\${s}` : s;
          allDirs.add(acc);
        }
      }
      const total = new Map<string, number>();
      for (const d of allDirs) total.set(d, 0);
      for (const [dir, c] of direct) {
        let acc = dir;
        while (true) {
          total.set(acc, (total.get(acc) ?? 0) + c);
          if (!acc) break;
          const i = Math.max(acc.lastIndexOf('\\'), acc.lastIndexOf('/'));
          acc = i < 0 ? '' : acc.slice(0, i);
        }
      }

      // 把"最新时间"也自底向上累积:父目录取子目录里最新的那个
      const latest = new Map<string, number>();
      for (const d of allDirs) latest.set(d, 0);
      for (const [dir, m] of latestDirect) {
        let acc = dir;
        while (true) {
          latest.set(acc, Math.max(latest.get(acc) ?? 0, m));
          if (!acc) break;
          const i = Math.max(acc.lastIndexOf('\\'), acc.lastIndexOf('/'));
          acc = i < 0 ? '' : acc.slice(0, i);
        }
      }

      type Node = {
        rootId: number; rootLabel: string; relDir: string;
        directCount: number; totalCount: number; children: Node[];
        alias: string | null; hidden: boolean; latestMtime: number | null;
      };
      const nodes = new Map<string, Node>();
      const mk = (relDir: string): Node => ({
        rootId: root.id, rootLabel: root.label, relDir,
        directCount: direct.get(relDir) ?? 0, totalCount: total.get(relDir) ?? 0, children: [],
        alias: prefs.get(relDir)?.alias ?? null,
        hidden: prefs.get(relDir)?.hidden ?? false,
        latestMtime: latest.get(relDir) || null,
      });
      for (const d of allDirs) nodes.set(d, mk(d));
      for (const d of allDirs) {
        if (!d) continue;
        const i = Math.max(d.lastIndexOf('\\'), d.lastIndexOf('/'));
        const parent = i < 0 ? '' : d.slice(0, i);
        nodes.get(parent)?.children.push(nodes.get(d)!);
      }
      // 排序:日期新的排前面(取目录内最新一张图的时间);没有图片的目录落到最后按名字排
      const sortRec = (n: Node) => {
        n.children.sort(
          (a, b) =>
            (b.latestMtime ?? 0) - (a.latestMtime ?? 0) ||
            b.relDir.localeCompare(a.relDir)
        );
        n.children.forEach(sortRec);
      };
      const rootNode = nodes.get('')!;
      sortRec(rootNode);
      out.push(rootNode);
    }
    return out;
  }

  /**
   * 库统计。
   *
   * `opts.tops` 默认 **true**(CLI `-stats` 要用 topSamplers/topLoras);
   * 桌面 UI 每次扫描/刷新都会拉一次这个接口,而它只用 totalImages/totalBytes/topModels,
   * 于是 IPC 侧显式传 `{ tops: false }` —— 跳过最贵的那条
   * `GROUP BY lora_refs.name`(13 万行,实测 **1.2 秒**,占 getStats 总耗时的绝大部分)。
   */
  getStats(rootId?: number, opts?: { tops?: boolean }): Record<string, unknown> {
    const withTops = opts?.tops !== false;
    const w = rootId === undefined ? '' : 'WHERE root_id = ?';
    const p = rootId === undefined ? [] : [rootId];

    const total = this.db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(file_size),0) AS b FROM images ${w}`).get(...p) as { c: number; b: number };

    const bySourceRows = this.db
      .prepare(`SELECT source, COUNT(*) AS c FROM images ${w} GROUP BY source`).all(...p) as Array<{ source: string; c: number }>;
    const bySource: Record<string, number> = {};
    for (const r of bySourceRows) bySource[r.source] = r.c;

    const top = (col: string, limit = 20) =>
      this.db
        .prepare(
          `SELECT ${col} AS name, COUNT(*) AS count FROM images
           ${w ? w + ' AND ' : 'WHERE '} ${col} IS NOT NULL AND ${col} != ''
           GROUP BY ${col} ORDER BY count DESC LIMIT ?`
        )
        .all(...p, limit) as Array<{ name: string; count: number }>;

    const topLoras = withTops
      ? (this.db
          .prepare(
            `SELECT lr.name AS name, COUNT(*) AS count
             FROM lora_refs lr JOIN images i ON i.id = lr.image_id
             ${rootId === undefined ? '' : 'WHERE i.root_id = ?'}
             GROUP BY lr.name ORDER BY count DESC LIMIT 20`
          )
          .all(...p) as Array<{ name: string; count: number }>)
      : [];

    const span = this.db
      .prepare(`SELECT MIN(file_mtime) AS a, MAX(file_mtime) AS b FROM images ${w}`).get(...p) as { a: number | null; b: number | null };

    return {
      totalImages: total.c,
      totalBytes: total.b,
      bySource,
      topModels: top('model_name'),
      topSamplers: withTops ? top('sampler_name') : [],
      topLoras,
      earliest: span.a,
      latest: span.b,
    };
  }

  getFilterOptions(): Record<string, unknown> {
    const distinct = (col: string) =>
      (this.db
        .prepare(
          `SELECT DISTINCT ${col} AS v FROM images WHERE ${col} IS NOT NULL AND ${col} != '' ORDER BY v COLLATE NOCASE`
        )
        .all() as Array<{ v: string }>).map((r) => r.v);

    const dirs = this.db
      .prepare('SELECT DISTINCT root_id AS rootId, rel_dir AS relDir FROM images ORDER BY root_id, rel_dir')
      .all() as Array<{ rootId: number; relDir: string }>;

    const loras = (this.db
      .prepare('SELECT DISTINCT name AS v FROM lora_refs ORDER BY v COLLATE NOCASE LIMIT 5000')
      .all() as Array<{ v: string }>).map((r) => r.v);

    // 模型名有"带扩展名"和"不带"两种来源(A1111 存显示名,节点图存文件名),
    // 这里剥掉扩展名再按不区分大小写去重,免得上万张图的筛选项里出现重复项。
    const modelSet = new Map<string, string>();
    for (const raw of distinct('model_name')) {
      const clean = normalizeAssetName(raw);
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (!modelSet.has(key)) modelSet.set(key, clean);
    }
    const models = [...modelSet.values()].sort((a, b) => a.localeCompare(b));

    const samplerSet = new Map<string, string>();
    for (const raw of distinct('sampler_name')) {
      const key = raw.toLowerCase();
      if (!samplerSet.has(key)) samplerSet.set(key, raw);
    }

    return {
      samplers: [...samplerSet.values()].sort((a, b) => a.localeCompare(b)),
      models,
      schedulers: distinct('scheduler'),
      dirs,
      loras,
    };
  }

  setStarred(id: number, starred: boolean): void {
    this.db.prepare('UPDATE images SET starred = ? WHERE id = ?').run(starred ? 1 : 0, id);
  }

  /** 从索引库删除一张图(分类归属等靠外键 ON DELETE CASCADE 清理) */
  deleteImage(id: number): boolean {
    const r = this.db.prepare('DELETE FROM images WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM images_fts WHERE rowid = ?').run(id);
    return Number(r.changes) > 0;
  }

  /** 移动/重命名后更新索引路径(root 不变;可选同时改文件名) */
  updateImagePath(id: number, f: { absPath: string; relPath: string; relDir: string; fileName?: string }): void {
    if (f.fileName === undefined) {
      this.db
        .prepare('UPDATE images SET abs_path = ?, rel_path = ?, rel_dir = ? WHERE id = ?')
        .run(f.absPath, f.relPath, f.relDir, id);
      return;
    }
    this.db
      .prepare('UPDATE images SET abs_path = ?, rel_path = ?, rel_dir = ?, file_name = ? WHERE id = ?')
      .run(f.absPath, f.relPath, f.relDir, f.fileName, id);
  }

  // ------------------------------------------------------------ 用户自定义分类

  /**
   * 分类树(含直接成员数与含子分类的累计成员数)。
   *
   * 计数说明:directCount 是"手动归入该分类的图片数",不是文件夹里的图片数。
   * 若某分类绑定了 rel_dir,UI 可以选择按目录语义展示它的图片数 —— 两者含义不同,
   * 所以这里只给成员计数,避免混淆。
   */
  getCategoryTree(): CategoryRow[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.name, c.description, c.parent_id AS parentId, c.sort_order AS sortOrder,
                c.rel_dir AS relDir, c.root_id AS rootId, c.created_at AS createdAt, c.updated_at AS updatedAt,
                (SELECT COUNT(*) FROM category_images ci WHERE ci.category_id = c.id) AS directCount
         FROM categories c
         ORDER BY c.sort_order, c.name COLLATE NOCASE`
      )
      .all() as Array<Omit<CategoryRow, 'totalCount' | 'children'>>;

    const byId = new Map<number, CategoryNodeRow>();
    for (const r of rows) byId.set(r.id, { ...r, totalCount: r.directCount, children: [] });

    const roots: CategoryNodeRow[] = [];
    for (const n of byId.values()) {
      if (n.parentId !== null && byId.has(n.parentId)) byId.get(n.parentId)!.children.push(n);
      else roots.push(n);
    }

    // 自底向上累计 totalCount
    const accumulate = (n: CategoryNodeRow): number => {
      let sum = n.directCount;
      for (const c of n.children) sum += accumulate(c);
      n.totalCount = sum;
      return sum;
    };
    for (const r of roots) accumulate(r);

    const sortRec = (list: CategoryNodeRow[]) => {
      list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
      for (const n of list) sortRec(n.children);
    };
    sortRec(roots);
    return roots as unknown as CategoryRow[];
  }

  /** 取某分类及其所有后代 id(用于 categoryRecursive 查询) */
  #categoryWithDescendants(categoryId: number): number[] {
    const all = this.db.prepare('SELECT id, parent_id AS parentId FROM categories').all() as Array<{
      id: number; parentId: number | null;
    }>;
    const childrenOf = new Map<number, number[]>();
    for (const r of all) {
      if (r.parentId === null) continue;
      if (!childrenOf.has(r.parentId)) childrenOf.set(r.parentId, []);
      childrenOf.get(r.parentId)!.push(r.id);
    }
    const out: number[] = [];
    const stack = [categoryId];
    const seen = new Set<number>();
    while (stack.length) {
      const id = stack.pop() as number;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      for (const c of childrenOf.get(id) ?? []) stack.push(c);
    }
    return out;
  }

  getCategory(id: number): CategoryRow | null {
    const r = this.db
      .prepare(
        `SELECT id, name, description, parent_id AS parentId, sort_order AS sortOrder,
                rel_dir AS relDir, root_id AS rootId, created_at AS createdAt, updated_at AS updatedAt
         FROM categories WHERE id = ?`
      )
      .get(id) as Omit<CategoryRow, 'directCount' | 'totalCount' | 'children'> | undefined;
    if (!r) return null;
    const c = this.db
      .prepare('SELECT COUNT(*) AS c FROM category_images WHERE category_id = ?')
      .get(id) as { c: number };
    return { ...r, directCount: c.c, totalCount: c.c, children: [] };
  }

  /** 同级重名检查;返回冲突的分类名或 null */
  #findSiblingByName(name: string, parentId: number | null, excludeId?: number): number | null {
    const row = this.db
      .prepare(
        `SELECT id FROM categories
         WHERE name = ? AND ${parentId === null ? 'parent_id IS NULL' : 'parent_id = ?'}
           ${excludeId === undefined ? '' : 'AND id != ?'}
         LIMIT 1`
      )
      .get(...(parentId === null
        ? excludeId === undefined ? [name] : [name, excludeId]
        : excludeId === undefined ? [name, parentId] : [name, parentId, excludeId])) as
      | { id: number }
      | undefined;
    return row ? row.id : null;
  }

  createCategory(input: {
    name: string;
    parentId?: number | null;
    relDir?: string | null;
    rootId?: number | null;
    description?: string | null;
  }): CategoryRow {
    const name = input.name.trim();
    if (!name) throw new Error('分类名不能为空');
    const parentId = input.parentId ?? null;
    if (parentId !== null && !this.getCategory(parentId)) {
      throw new Error('父分类不存在');
    }
    const dup = this.#findSiblingByName(name, parentId);
    if (dup !== null) throw new Error(`同级已存在同名分类「${name}」`);

    const now = Date.now();
    // 新分类排在同级末尾
    const maxRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories
         WHERE ${parentId === null ? 'parent_id IS NULL' : 'parent_id = ?'}`
      )
      .get(...(parentId === null ? [] : [parentId])) as { m: number };

    const r = this.db
      .prepare(
        `INSERT INTO categories (name, description, parent_id, sort_order, rel_dir, root_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        name,
        input.description ?? null,
        parentId,
        maxRow.m + 1,
        input.relDir ?? null,
        input.rootId ?? null,
        now,
        now
      );
    return this.getCategory(Number(r.lastInsertRowid))!;
  }

  updateCategory(
    id: number,
    patch: {
      name?: string;
      description?: string | null;
      parentId?: number | null;
      sortOrder?: number;
      relDir?: string | null;
      rootId?: number | null;
    }
  ): CategoryRow {
    const cur = this.getCategory(id);
    if (!cur) throw new Error('分类不存在');

    const name = patch.name === undefined ? cur.name : patch.name.trim();
    if (!name) throw new Error('分类名不能为空');

    const parentId = patch.parentId === undefined ? cur.parentId : patch.parentId;
    if (parentId === id) throw new Error('分类不能作为自己的父分类');
    if (parentId !== null) {
      if (!this.getCategory(parentId)) throw new Error('父分类不存在');
      // 防止把分类挂到自己的后代下面(会形成环)
      if (this.#categoryWithDescendants(id).includes(parentId)) {
        throw new Error('不能把分类移动到它自己的子分类下');
      }
    }
    const dup = this.#findSiblingByName(name, parentId, id);
    if (dup !== null) throw new Error(`同级已存在同名分类「${name}」`);

    this.db
      .prepare(
        `UPDATE categories SET name=?, description=?, parent_id=?, sort_order=?, rel_dir=?, root_id=?, updated_at=?
         WHERE id=?`
      )
      .run(
        name,
        patch.description === undefined ? cur.description : patch.description,
        parentId,
        patch.sortOrder === undefined ? cur.sortOrder : patch.sortOrder,
        patch.relDir === undefined ? cur.relDir : patch.relDir,
        patch.rootId === undefined ? cur.rootId : patch.rootId,
        Date.now(),
        id
      );
    return this.getCategory(id)!;
  }

  /**
   * 删除分类。
   * @param deleteChildren true = 连同子分类一起删;false = 子分类上提到被删者的父级
   */
  deleteCategory(id: number, deleteChildren = false): void {
    const cur = this.getCategory(id);
    if (!cur) return;
    this.transaction(() => {
      if (!deleteChildren) {
        this.db
          .prepare('UPDATE categories SET parent_id = ?, updated_at = ? WHERE parent_id = ?')
          .run(cur.parentId, Date.now(), id);
      }
      // 子分类若被一并删除,foreign key ON DELETE CASCADE 会处理;
      // category_images 也有 CASCADE,成员关系自动清理。
      this.db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    });
  }

  /** 把图片加入 / 移出分类。返回实际变化的行数 */
  setCategoryMembers(categoryId: number, imageIds: number[], member: boolean): number {
    if (!this.getCategory(categoryId)) throw new Error('分类不存在');
    if (imageIds.length === 0) return 0;
    const now = Date.now();
    let changed = 0;
    this.transaction(() => {
      if (member) {
        const ins = this.db.prepare(
          'INSERT OR IGNORE INTO category_images (category_id, image_id, added_at) VALUES (?,?,?)'
        );
        for (const iid of imageIds) changed += Number(ins.run(categoryId, iid, now).changes);
      } else {
        const del = this.db.prepare(
          'DELETE FROM category_images WHERE category_id = ? AND image_id = ?'
        );
        for (const iid of imageIds) changed += Number(del.run(categoryId, iid).changes);
      }
    });
    if (changed > 0) {
      this.db.prepare('UPDATE categories SET updated_at = ? WHERE id = ?').run(now, categoryId);
    }
    return changed;
  }

  /** 某张图所属的全部分类 */
  getImageCategories(imageId: number): number[] {
    return (this.db
      .prepare('SELECT category_id AS id FROM category_images WHERE image_id = ? ORDER BY category_id')
      .all(imageId) as Array<{ id: number }>).map((r) => r.id);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM images').get() as { c: number }).c;
  }

  #rowToApi(r: Record<string, unknown>): Record<string, unknown> {
    let meta: unknown = null;
    try { meta = r.meta_json ? JSON.parse(r.meta_json as string) : null; } catch { meta = null; }
    if (meta && typeof meta === 'object') {
      // 列表投影不携带原始大 JSON
      (meta as Record<string, unknown>).rawPromptJson = null;
    }
    return {
      id: r.id,
      rootId: r.root_id,
      absPath: r.abs_path,
      relPath: r.rel_path,
      relDir: r.rel_dir,
      fileName: r.file_name,
      fileSize: r.file_size,
      fileMtime: r.file_mtime,
      dimensions: r.width != null && r.height != null ? { width: r.width, height: r.height } : null,
      source: r.source,
      starred: r.starred === 1,
      indexedAt: r.indexed_at,
      thumbPath: null,
      meta,
    };
  }
}


/** 转义 LIKE 模式里的元字符。与 SQL 里的 ESCAPE '!' 配对使用。 */
function escapeLike(s: string): string {
  return s.replace(/[!%_]/g, (c) => '!' + c);
}

/** 去重 + 只留正整数 id(IPC 入参不可信) */
function uniqueIds(ids: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const raw of Array.isArray(ids) ? ids : []) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** 按 500 一批切分(SQLite 的绑定变量数有上限,IN (...) 不能无限铺开) */
const ID_CHUNK = 500;
function chunkIds(ids: number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) out.push(ids.slice(i, i + ID_CHUNK));
  return out;
}

/**
 * 「base 目录下所有子孙」的 LIKE 模式(配合 ESCAPE '!')。
 *
 * 关键:通配符前必须紧跟一个**字面分隔符**,即 base + sep + '%'。
 * 若只写 base + '%',`A%` 会把兄弟目录 `AB`、`A2` 一起匹配进来 ——
 * 它们路径前缀相同,但不是 A 的子目录(这是 v0.6 修掉的一个真实 bug)。
 *
 * 分隔符是字面字符(反斜杠 / 正斜杠),不是 LIKE 元字符,所以不用转义;
 * 只有 base 自己需要走 escapeLike。
 */
function descPattern(base: string, sep: '\\' | '/'): string {
  return `${escapeLike(base)}${sep}%`;
}
