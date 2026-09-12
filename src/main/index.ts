/**
 * Electron 主进程。
 *
 * 职责:
 *  - 托盘常驻(关闭窗口不退出,后台继续扫描)
 *  - 单实例锁(第二次启动只唤起已有窗口)
 *  - 扫描放进 worker 之外的同步流程,但分批 yield,避免长时间卡住主线程
 *  - 把 AssetDb 的所有能力通过 IPC 暴露给渲染进程
 *  - 缩略图:用 Electron 内置 nativeImage 懒生成并缓存,不引入 sharp
 *
 * 注意:本文件依赖 electron,而 electron 需要用户执行 npm install。
 * 在沙箱内无法构建,但代码本身可静态审查。
 */

import { app, BrowserWindow, Tray, Menu, ipcMain, shell, clipboard, nativeImage, protocol, net, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AssetDb } from './db.ts';
import { scanLibrary, THUMB_DIR_NAME, type ScanProgress } from './indexer.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

// ---------------------------------------------------------------- 路径

const DATA_DIR = path.join(app.getPath('userData'), 'data');
const DB_FILE = path.join(DATA_DIR, 'index.db');

// ---------------------------------------------------------------- 设置

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

/**
 * 从旧名字(ComfyUI 资产管理器)迁移索引与设置:
 * 改名后 userData 会变成 %APPDATA%\A3 manager,不迁移就得重新扫描全库。
 */
function migrateLegacyUserData(): void {
  try {
    const legacyDir = path.join(app.getPath('appData'), 'ComfyUI 资产管理器');
    if (!fs.existsSync(legacyDir)) return;
    const dataDir = path.join(app.getPath('userData'), 'data');
    const legacyDb = path.join(legacyDir, 'data', 'index.db');
    if (fs.existsSync(legacyDb) && !fs.existsSync(path.join(dataDir, 'index.db'))) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.copyFileSync(legacyDb, path.join(dataDir, 'index.db'));
      console.log('[migrate] 已从旧目录迁入索引库');
    }
    const legacySettings = path.join(legacyDir, 'settings.json');
    if (fs.existsSync(legacySettings) && !fs.existsSync(SETTINGS_FILE)) {
      fs.copyFileSync(legacySettings, SETTINGS_FILE);
      console.log('[migrate] 已从旧目录迁入设置');
    }
  } catch (e) {
    console.error('[migrate] 迁移旧数据失败(忽略):', e);
  }
}
migrateLegacyUserData();

/** 应用设置(见 shared/types.ts 的 AppSettings)。closeToTray 决定关闭按钮的行为 */
/** 设置结构版本:用来把"新默认值"只推一次给老用户(见下面的迁移) */
const CONFIG_VERSION = 2;

let settings: {
  closeToTray: boolean;
  theme: 'dark' | 'light';
  reduceEffects: boolean;
  backgroundImage: string | null;
  backgroundFit: 'cover' | 'stretch' | 'contain' | 'tile';
  configVersion: number;
} = {
  closeToTray: true,
  // 默认亮色 + 磨砂(reduceEffects=false);用户可在设置里改
  theme: 'light',
  reduceEffects: false,
  backgroundImage: null,
  backgroundFit: 'cover',
  configVersion: CONFIG_VERSION,
};
try {
  settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
} catch {
  /* 首次运行没有文件,用默认值 */
}

// —— 配置迁移 ——
// v1 及更早的默认主题是暗色,老配置里存的就是那个旧默认值;这里把它改成新的默认(亮色),
// 只做一次:之后用户自己再切回暗色,会被 configVersion=2 记住,不会再被覆盖。
if ((settings.configVersion ?? 0) < 2) {
  settings.theme = 'light';
  settings.configVersion = CONFIG_VERSION;
  saveSettings();
}

function saveSettings(): void {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}


/**
 * 把旧应用名目录(%APPDATA%\\ComfyUI 资产管理器)里登记的图库"补登记"到当前库。
 *
 * 为什么需要:应用改名后数据目录跟着变,如果用户一会儿开旧版一会儿开新版,
 * 就会觉得"新加的图库重启后不见了"。这里只做补登记(不搬索引),
 * 缺的图片会在随后的扫描里补回来;已经存在的图库按路径去重。
 */
function mergeLegacyRoots(): void {
  try {
    const legacyDb = path.join(app.getPath('appData'), 'ComfyUI 资产管理器', 'data', 'index.db');
    if (!fs.existsSync(legacyDb) || legacyDb === DB_FILE) return;
    // 用只读连接读旧库,避免影响它
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const old = new DatabaseSync(legacyDb, { readOnly: true });
    const rows = old.prepare('SELECT path, label FROM roots').all() as Array<{ path: string; label: string }>;
    old.close();
    const mine = new Set((db.listRoots() as Array<{ path: string }>).map((r) => r.path.toLowerCase()));
    let added = 0;
    for (const r of rows) {
      if (!r.path || mine.has(r.path.toLowerCase())) continue;
      if (!fs.existsSync(r.path)) continue; // 盘子没了就别登记
      db.addRoot(r.path, r.label);
      added++;
    }
    if (added > 0) {
      console.log('[migrate] 从旧数据目录补登记了', added, '个图库');
      void runScan({});
    }
  } catch (e) {
    console.error('[migrate] 补登记旧图库失败(忽略):', e);
  }
}

function ensureDirs(): void {
  // 缩略图不再写到管理器目录:它们放在每个图库根目录内部(见 THUMB_DIRNAME),
  // 所以这里只需要保证自己的数据目录存在。
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ---------------------------------------------------------------- 全局状态

let db: AssetDb;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let scanAbort: AbortController | null = null;
let lastProgress: ScanProgress | null = null;
/** 关闭按钮是"收进托盘"还是"退出" */
let quitting = false;

const THUMB_W = 400;
const THUMB_H = 400;

// ---------------------------------------------------------------- 窗口

/** 标题栏按钮区的配色(跟随主题) */
const THEME_UI = {
  dark: { bar: '#0f1115', symbol: '#e6e8eb' },
  light: { bar: '#f3f5f7', symbol: '#0f1115' },
} as const;

function currentTheme(): 'dark' | 'light' {
  return settings.theme === 'light' ? 'light' : 'dark';
}

/** 主题变化时同步窗口底色与标题栏按钮配色 */
function applyWindowChrome(): void {
  if (!mainWindow) return;
  const c = THEME_UI[currentTheme()];
  mainWindow.setBackgroundColor(c.bar);
}

// ---------------------------------------------------------------- 自动入库
//
// 图库目录里新增/删除/改名 PNG 后自动增量扫描,不用用户手动点扫描。
// 两个关键点:
//   1. 忽略自己的缩略图缓存目录(.comfy-thumbs),否则一边看图一边触发扫描;
//   2. 去抖 1.5s —— 复制一批图进来只扫一次。
let rootWatchers: fs.FSWatcher[] = [];
const pendingRootIds = new Set<number>();
let watchTimer: NodeJS.Timeout | null = null;

function scheduleAutoScan(rootId: number): void {
  pendingRootIds.add(rootId);
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    watchTimer = null;
    const ids = [...pendingRootIds];
    pendingRootIds.clear();
    if (ids.length) void runScan({ rootIds: ids });
  }, 1500);
}

/** 图库根变化(增删/启停)后重建监听 */
function syncRootWatchers(): void {
  for (const w of rootWatchers) {
    try { w.close(); } catch { /* 已关闭 */ }
  }
  rootWatchers = [];
  if (!db) return;
  for (const root of db.listRoots()) {
    if (root.enabled !== 1) continue;
    try {
      const watcher = fs.watch(root.path, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = String(filename);
        // 只忽略自己的缩略图缓存;其余事件(含删除目录、改名)都要触发扫描 ——
        // 删目录时 Windows 只报目录名,按 .png 过滤会漏掉"图片被删"这件事。
        if (rel.split(/[\\/]/).includes(THUMB_DIRNAME)) return;
        scheduleAutoScan(root.id);
      });
      watcher.on('error', () => { /* 目录被拔掉/断开时忽略 */ });
      rootWatchers.push(watcher);
      console.log('[watch] 监听', root.path);
    } catch { /* 目录不存在或平台不支持递归监听 */ }
  }
  console.log('[watch] 监听图库目录:', rootWatchers.length);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: THEME_UI[currentTheme()].bar,
    title: 'A3 manager',
    autoHideMenuBar: true,
    // 完全无边框:最小化/最大化/关闭由渲染层自绘(系统那三个按钮只能画纯色块,
    // 和磨砂玻璃对不上)
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // 关闭行为由设置决定:缩小到托盘(默认)或直接退出
  mainWindow.on('close', (e) => {
    if (quitting) return;
    if (settings.closeToTray) {
      e.preventDefault();
      mainWindow?.hide();
    } else {
      quitting = true;
      app.quit();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    void mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------- 托盘

function buildTray(): void {
  // 用内置图标兜底:没有图标文件时 Electron 仍需要一个非空 Image
  const iconPath = path.join(__dirname, '../../build/tray.png');
  let image = nativeImage.createEmpty();
  if (fs.existsSync(iconPath)) {
    image = nativeImage.createFromPath(iconPath);
  }

  tray = new Tray(image);
  tray.setToolTip('A3 manager');

  const refreshMenu = () => {
    const p = lastProgress;
    const status = p
      ? p.phase === 'parsing'
        ? `扫描中 ${p.processed}/${p.total}`
        : p.phase === 'done'
          ? `上次扫描完成 ${p.processed} 文件`
          : p.phase
      : '空闲';
    const count = db ? db.count() : 0;

    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: `图片总数:${count}`, enabled: false },
        { label: `状态:${status}`, enabled: false },
        { type: 'separator' },
        { label: '打开主界面', click: showWindow },
        {
          label: '立即扫描',
          click: () => {
            void runScan({});
          },
        },
        {
          label: '停止扫描',
          enabled: p?.phase === 'parsing',
          click: () => {
            scanAbort?.abort();
          },
        },
        { type: 'separator' },
        { label: '打开数据目录', click: () => void shell.openPath(DATA_DIR) },
        {
          label: '退出',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ])
    );
  };

  refreshMenu();
  tray.on('double-click', showWindow);
  tray.on('click', () => tray?.popUpContextMenu());

  // 进度变化时刷新托盘提示
  progressListeners.push((p) => {
    lastProgress = p;
    tray?.setToolTip(
      p.phase === 'parsing' ? `扫描中 ${p.processed}/${p.total}` : 'A3 manager'
    );
    refreshMenu();
  });
}

// ---------------------------------------------------------------- 扫描

const progressListeners: Array<(p: ScanProgress) => void> = [];

function broadcastProgress(p: ScanProgress): void {
  lastProgress = p;
  for (const fn of progressListeners) fn(p);
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('scan:progress', p);
  }
}

/**
 * 扫描是同步 CPU/IO 密集操作,这里分片执行:
 * 每片只处理一小批,然后让出事件循环,避免 UI 完全冻结。
 */
async function runScan(opts: { rootIds?: number[]; force?: boolean }): Promise<void> {
  if (scanAbort) return; // 已在扫描
  scanAbort = new AbortController();
  try {
    await scanLibrary(db, {
      rootIds: opts.rootIds,
      force: opts.force,
      signal: scanAbort.signal,
      onProgress: broadcastProgress,
    });
  } catch (e) {
    broadcastProgress({
      phase: 'error',
      processed: 0,
      total: 0,
      currentFile: null,
      skipped: 0,
      errors: 0,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      message: e instanceof Error ? e.message : String(e),
    });
  } finally {
    scanAbort = null;
  }
}

// ---------------------------------------------------------------- 缩略图

/**
 * 缩略图缓存目录名。放在**每个图库根目录内部**,与参考项目(Aaalice NAI Launcher)
 * 的 `.thumbs` 约定一致 —— 缓存跟着图库走,而不是跟着管理器走。
 *
 * 布局:<图库根>/<THUMB_DIRNAME>/<相对路径>/<原名>.thumb.png
 * 与 tools/thumb-sync.ts、tools/export-gallery.ts 必须保持一致。
 */
const THUMB_DIRNAME = THUMB_DIR_NAME;

/** 换算某张图的缩略图绝对路径 */
function thumbPathFor(rootPath: string, relPath: string): string {
  const dir = path.dirname(relPath);
  const base = path.basename(relPath, path.extname(relPath));
  const sub = dir === '.' ? '' : dir;
  return path.join(rootPath, THUMB_DIRNAME, sub, `${base}.thumb.png`);
}

/** 取某个图库根目录的缩略图缓存目录 */
function thumbDirOf(rootPath: string): string {
  return path.join(rootPath, THUMB_DIRNAME);
}

/**
 * 懒生成缩略图 —— 只作为**回退路径**。
 *
 * 首选是 tools/thumb-sync.ts 预生成好的缓存(纯 JS PNG 解码 + 中位切分量化,
 * 压缩约 140 倍)。这里用 Electron 自带的 nativeImage 兜底,覆盖两类情况:
 *   1. 用户还没跑过 thumb-sync;
 *   2. 索引后又新出现了图。
 *
 * 两者写入**同一个缓存位置**,所以谁先生成都算数,不会互相覆盖出两份。
 * 代价:大 PNG 解码一次约几百毫秒,所以只在首次请求时做,不要批量预生成。
 */
/**
 * 缩略图生成限流:网格一屏可能有 120 张,若同时解码大图会把主进程占满。
 * 这里最多同时生成 2 张,且每张之后让出一帧,保证界面不卡。
 */
const THUMB_CONCURRENCY = 2;
let thumbActive = 0;
const thumbWaiters: Array<() => void> = [];

async function acquireThumbSlot(): Promise<void> {
  if (thumbActive < THUMB_CONCURRENCY) {
    thumbActive++;
    return;
  }
  await new Promise<void>((resolve) => {
    thumbWaiters.push(() => {
      thumbActive++;
      resolve();
    });
  });
}

function releaseThumbSlot(): void {
  thumbActive = Math.max(0, thumbActive - 1);
  const next = thumbWaiters.shift();
  if (next) next();
}

async function ensureThumb(id: number): Promise<string | null> {
  const row = db.getImageRow(id);
  if (!row) return null;
  const absPath = row.abs_path as string;
  const rootId = row.root_id as number;
  const relPath = row.rel_path as string;

  const root = (db.listRoots() as Array<{ id: number; path: string }>).find((r) => r.id === rootId);
  if (!root) return null;
  const out = thumbPathFor(root.path, relPath);

  try {
    const st = fs.statSync(out);
    if (st.size > 0) return out;
  } catch {
    /* 还没生成,继续 */
  }

  await acquireThumbSlot();
  try {
    const img = nativeImage.createFromPath(absPath);
    if (img.isEmpty()) return null;
    const size = img.getSize();
    const scale = Math.min(THUMB_W / size.width, THUMB_H / size.height, 1);
    const w = Math.max(1, Math.round(size.width * scale));
    const h = Math.max(1, Math.round(size.height * scale));
    const resized = img.resize({ width: w, height: h, quality: 'good' });
    const buf = resized.toPNG();
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.writeFile(out, buf);
    return out;
  } catch {
    // 生成失败(比如图库目录只读)—— 返回 null,由调用方回退原图
    return null;
  } finally {
    releaseThumbSlot();
    // 让出一帧,避免连续解码把主线程占死
    await new Promise((r) => setImmediate(r));
  }
}

/**
 * 给渲染进程用的缩略图协议:cam-thumb://<imageId>
 *
 * 为什么不用 IPC:网格里一屏就有 50~200 张图,每张走一次 ipcRenderer.invoke
 * 会排成一条长队列。注册自定义协议后,<img src="cam-thumb://123"> 由 Chromium
 * 直接请求,可以并发加载,也不需要前端做异步编排。
 *
 * 协议必须在 app ready 之前声明为 privileged(否则不允许流式响应)。
 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'cam-thumb', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
  // 自定义背景图:cam-bg://bg/current —— 具体读哪个文件由主进程的 settings 决定,
  // URL 里不带路径,渲染层拿不到也无从越权读取别的文件。
  { scheme: 'cam-bg', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
]);

/** 自定义背景图协议:只服务当前设置的这一张图 */
function registerBackgroundProtocol(): void {
  protocol.handle('cam-bg', async () => {
    const file = settings.backgroundImage;
    if (!file || !fs.existsSync(file)) return new Response('no background', { status: 404 });
    return net.fetch(pathToFileUrl(file));
  });
}

function registerThumbProtocol(): void {
  protocol.handle('cam-thumb', async (request) => {
    try {
      const url = new URL(request.url);
      // URL 形式:cam-thumb://thumb/<id>。主机名必须是字母——standard scheme 下
      // 纯数字主机名会被 Chromium 规范化成 IPv4 地址,id 就丢了,所以 id 走路径段。
      const id = Number(url.pathname.replace(/^\/+/, ''));
      if (!Number.isFinite(id) || id <= 0) return new Response('bad id', { status: 400 });

      const thumb = await ensureThumb(id);
      if (thumb) return net.fetch(pathToFileUrl(thumb));

      // 缩略图生成失败,退回原图保证界面不空
      const row = db.getImageRow(id);
      if (!row) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileUrl(row.abs_path as string));
    } catch {
      return new Response('error', { status: 500 });
    }
  });
}

// ---------------------------------------------------------------- IPC

/** 统一包装:把异常转成 { ok:false, error },前端不用写 try/catch */
function handle(channel: string, fn: (...args: any[]) => any): void {
  ipcMain.handle(channel, async (_evt, ...args) => {
    try {
      const data = await fn(...args);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

function registerIpc(): void {
  // ---- 库管理
  handle('listRoots', () => db.listRoots());
  handle('addRoot', (p: string, label?: string) => {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) throw new Error(`路径不存在: ${abs}`);
    const id = db.addRoot(abs, label);
    syncRootWatchers();
    return db.listRoots().find((r: any) => r.id === id) ?? null;
  });
  handle('removeRoot', (id: number) => {
    db.removeRoot(id);
    syncRootWatchers();
  });
  handle('setRootEnabled', (id: number, enabled: boolean) => {
    db.setRootEnabled(id, enabled);
    syncRootWatchers();
  });

  // ---- 扫描
  handle('startScan', (rootIds?: number[], force?: boolean) => {
    if (scanAbort) return { started: false };
    void runScan({ rootIds, force });
    return { started: true };
  });
  handle('cancelScan', () => {
    scanAbort?.abort();
  });
  handle('getScanProgress', () => lastProgress);

  // ---- 浏览
  handle('queryImages', (q: Record<string, unknown>) => {
    const t0 = Date.now();
    // 全文检索先拿到 id 白名单,再交给结构化筛选
    const query = { ...q };
    const text = typeof query.q === 'string' ? query.q.trim() : '';
    if (text) {
      const ids = db.searchIds(text, 20000);
      if (ids.length === 0) return { ids: [], total: 0, tookMs: Date.now() - t0 };
      query.ids = ids;
    }
    delete query.q;
    const res = db.queryImages(query);
    return { ...res, tookMs: Date.now() - t0 };
  });
  handle('getImage', (id: number) => {
    const d = db.getImageDetail(id);
    if (!d) throw new Error('图片不存在');
    const sib = db.getSiblings(id, { sort: 'mtime_desc' });
    return { ...d, siblings: sib.ids, position: sib.position, total: sib.total };
  });
  handle('getImagesByIds', (ids: number[]) => db.getImagesByIds(ids));
  handle('getFolderTree', (rootId?: number) => db.getFolderTree(rootId));
  handle('getStats', (rootId?: number) => db.getStats(rootId));
  handle('getFilterOptions', () => db.getFilterOptions());

  // ---- 用户自定义分类(不移动文件,只是索引层的集合归属)
  handle('getCategoryTree', () => db.getCategoryTree());
  handle('createCategory', (input: { name: string; parentId?: number | null; relDir?: string | null; rootId?: number | null; description?: string | null }) =>
    db.createCategory(input)
  );
  handle('updateCategory', (id: number, patch: Record<string, unknown>) =>
    db.updateCategory(id, patch as Parameters<AssetDb['updateCategory']>[1])
  );
  handle('deleteCategory', (id: number, deleteChildren?: boolean) =>
    db.deleteCategory(id, deleteChildren === true)
  );
  handle('setCategoryMembers', (categoryId: number, imageIds: number[], member: boolean) =>
    db.setCategoryMembers(categoryId, imageIds, member)
  );
  handle('getImageCategories', (imageId: number) => db.getImageCategories(imageId));

  // ---- 操作
  handle('setStarred', (id: number, starred: boolean) => db.setStarred(id, starred));
  handle('revealInExplorer', (id: number) => {
    const row = db.getImageRow(id);
    if (!row) throw new Error('图片不存在');
    shell.showItemInFolder(row.abs_path as string);
  });
  handle('openExternal', (id: number) => {
    const row = db.getImageRow(id);
    if (!row) throw new Error('图片不存在');
    return shell.openPath(row.abs_path as string);
  });
  handle('copyPath', (id: number) => {
    const row = db.getImageRow(id);
    if (!row) throw new Error('图片不存在');
    clipboard.writeText(row.abs_path as string);
  });

  // 删除:文件进系统回收站(可反悔),索引记录随之移除
  handle('deleteImage', async (id: number) => {
    const row = db.getImageRow(id);
    if (!row) throw new Error('图片不存在');
    await shell.trashItem(row.abs_path as string);
    db.deleteImage(id);
  });

  // 移动:系统目录选择框选目标,文件移动后更新索引;
  // 目标在图库根之外时,该图从索引库移除(下次扫描也找不到它了)
  handle('moveImage', async (id: number) => {
    const row = db.getImageRow(id);
    if (!row) throw new Error('图片不存在');
    const r = await dialog.showOpenDialog(mainWindow ?? BrowserWindow.getAllWindows()[0], {
      title: '移动图片到…',
      defaultPath: path.dirname(row.abs_path as string),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;

    const src = row.abs_path as string;
    const target = path.join(r.filePaths[0], row.file_name as string);
    if (path.resolve(target) === path.resolve(src)) return null;
    if (fs.existsSync(target)) throw new Error('目标文件夹里已存在同名文件');
    await fsp.rename(src, target);

    const root = (db.listRoots() as Array<{ id: number; path: string }>).find(
      (x) => x.id === (row.root_id as number)
    );
    const rel = root ? path.relative(root.path, target) : '..';
    if (root && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      const relDir = path.dirname(rel);
      db.updateImagePath(id, {
        absPath: target,
        relPath: rel,
        relDir: relDir === '.' ? '' : relDir,
      });
      return { target, removedFromLibrary: false };
    }
    db.deleteImage(id);
    return { target, removedFromLibrary: true };
  });

  /** 重命名:直接改磁盘文件名(目录不变),索引与缩略图缓存一起跟上 */
  handle('renameImage', async (id: number, newName: string) => {
    const row = db.getImageRow(id);
    if (!row) throw new Error('图片不存在');
    const src = row.abs_path as string;
    const raw = String(newName ?? '').trim();
    if (!raw) throw new Error('名字不能为空');
    if (/[\\/:*?"<>|]/.test(raw)) throw new Error('名字里不能包含 \\ / : * ? " < > |');

    const ext = path.extname(src);
    const base = raw.toLowerCase().endsWith(ext.toLowerCase()) ? raw.slice(0, -ext.length) : raw;
    if (!base.trim()) throw new Error('名字不能为空');
    const fileName = base.trim() + ext;
    if (fileName === (row.file_name as string)) return db.getImagesByIds([id])[0] ?? null;

    const dir = path.dirname(src);
    const target = path.join(dir, fileName);
    if (fs.existsSync(target)) throw new Error('同一目录里已经有同名文件');
    await fsp.rename(src, target);

    const relDir = (row.rel_dir as string) ?? '';
    db.updateImagePath(id, {
      absPath: target,
      relPath: relDir ? path.join(relDir, fileName) : fileName,
      relDir,
      fileName,
    });

    // 旧缩略图缓存按旧相对路径存的,删掉让它按新名字重新生成
    const root = (db.listRoots() as Array<{ id: number; path: string }>).find(
      (x) => x.id === (row.root_id as number)
    );
    if (root) {
      try { await fsp.rm(thumbPathFor(root.path, row.rel_path as string), { force: true }); } catch { /* 缓存删不掉不影响功能 */ }
    }
    return db.getImagesByIds([id])[0] ?? null;
  });

  /** 复制图片位图到剪贴板(可以直接粘到聊天窗口) */
  handle('copyImageToClipboard', async (id: number) => {
    const row = db.getImageRow(id);
    if (!row) throw new Error('图片不存在');
    const img = nativeImage.createFromPath(row.abs_path as string);
    if (img.isEmpty()) throw new Error('图片读取失败');
    clipboard.writeImage(img);
  });

  /** 复制一份到别的文件夹:原图保留,索引不变 */
  handle('copyImageToFolder', async (id: number) => {
    const row = db.getImageRow(id);
    if (!row) throw new Error('图片不存在');
    const r = await dialog.showOpenDialog(mainWindow ?? BrowserWindow.getAllWindows()[0], {
      title: '复制图片到…',
      defaultPath: path.dirname(row.abs_path as string),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const src = row.abs_path as string;
    const target = path.join(r.filePaths[0], row.file_name as string);
    if (path.resolve(target) === path.resolve(src)) return null;
    if (fs.existsSync(target)) throw new Error('目标文件夹里已存在同名文件');
    await fsp.copyFile(src, target);
    return { copiedTo: target };
  });

  /** 批量删除:逐张移入回收站并清索引,失败的单独记下来不让整批中断 */
  handle('deleteImages', async (ids: number[]) => {
    const errors: string[] = [];
    let deleted = 0;
    for (const id of ids) {
      try {
        const row = db.getImageRow(id);
        if (!row) { errors.push(`#${id} 不在索引里`); continue; }
        await shell.trashItem(row.abs_path as string);
        db.deleteImage(id);
        deleted++;
      } catch (e) {
        errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { deleted, errors };
  });

  /** 批量移动:选一次目录,逐个改名/移动并更新索引 */
  handle('moveImages', async (ids: number[], targetDir?: string) => {
    let dir = targetDir;
    if (!dir) {
      const picked = await dialog.showOpenDialog(mainWindow ?? BrowserWindow.getAllWindows()[0], {
        title: '把选中的图片移动到…',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (picked.canceled || !picked.filePaths[0]) {
        return { moved: 0, removedFromLibrary: 0, target: null, errors: [] };
      }
      dir = picked.filePaths[0];
    }

    let moved = 0;
    let removedFromLibrary = 0;
    const errors: string[] = [];
    for (const id of ids) {
      try {
        const row = db.getImageRow(id);
        if (!row) { errors.push(`#${id} 不在索引里`); continue; }
        const src = row.abs_path as string;
        const target = path.join(dir, row.file_name as string);
        if (path.resolve(target) === path.resolve(src)) continue;
        if (fs.existsSync(target)) { errors.push(`${row.file_name} 目标里已存在`); continue; }
        await fsp.rename(src, target);

        const root = (db.listRoots() as Array<{ id: number; path: string }>).find(
          (x) => x.id === (row.root_id as number)
        );
        const rel = root ? path.relative(root.path, target) : '..';
        if (root && !rel.startsWith('..') && !path.isAbsolute(rel)) {
          const relDir = path.dirname(rel);
          db.updateImagePath(id, {
            absPath: target,
            relPath: rel,
            relDir: relDir === '.' ? '' : relDir,
          });
        } else {
          db.deleteImage(id);
          removedFromLibrary++;
        }
        moved++;
      } catch (e) {
        errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { moved, removedFromLibrary, target: dir, errors };
  });

  // ---- 文件夹显示偏好(别名 / 左侧栏隐藏)
  handle('getFolderPrefs', () => db.listFolderPrefs());
  handle('setFolderPref', (rootId: number, relDir: string, patch: { hidden?: boolean; alias?: string | null }) =>
    db.setFolderPref(rootId, relDir, patch)
  );
  /** 用系统浏览器打开外部链接(设置里的作者/仓库链接) */
  handle('openUrl', async (url: string) => {
    if (!/^https?:\/\//i.test(String(url))) throw new Error('只允许 http/https 链接');
    await shell.openExternal(String(url));
  });

  // ---- 自绘标题栏按钮
  handle('windowMinimize', () => {
    mainWindow?.minimize();
  });
  handle('windowToggleMaximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  handle('windowClose', () => {
    mainWindow?.close();
  });
  handle('isWindowMaximized', () => mainWindow?.isMaximized() ?? false);

  handle('pickImageFile', async () => {
    const r = await dialog.showOpenDialog(mainWindow ?? BrowserWindow.getAllWindows()[0], {
      title: '选择背景图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

  /** 背景图 URL:带 mtime 版本号,换图后自动绕过缓存 */
  handle('getBackgroundUrl', () => {
    const file = settings.backgroundImage;
    if (!file || !fs.existsSync(file)) return null;
    let v = 0;
    try { v = Math.floor(fs.statSync(file).mtimeMs); } catch { v = Date.now(); }
    return `cam-bg://bg/current?v=${v}`;
  });

  handle('pickDirectory', async () => {
    const r = await dialog.showOpenDialog(mainWindow ?? BrowserWindow.getAllWindows()[0], {
      title: '选择文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

  // ---- 设置
  handle('getSettings', () => settings);
  handle('setSettings', (patch: Partial<typeof settings>) => {
    settings = { ...settings, ...patch };
    saveSettings();
    applyWindowChrome();
    return settings;
  });

  // ---- 缩略图:自定义协议,前端直接用 <img src="cam-thumb://thumb/<id>">
  // 主机名必须是字母:standard scheme 下纯数字主机名会被规范化成 IPv4
  handle('getThumbUrl', (id: number) => `cam-thumb://thumb/${id}`);

  // ---- 应用
  handle('getAppInfo', () => ({
    version: app.getVersion(),
    dbPath: DB_FILE,
    thumbDirName: THUMB_DIRNAME,
    roots: (db.listRoots() as Array<{ id: number; path: string }>).map((r) => ({
      id: r.id,
      path: r.path,
      thumbDir: thumbDirOf(r.path),
    })),
    autoLaunch: app.getLoginItemSettings().openAtLogin,
  }));
  handle('setAutoLaunch', (enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
  });
  handle('quitApp', () => {
    quitting = true;
    app.quit();
  });
}

function pathToFileUrl(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  return 'file:///' + encodeURI(normalized).replace(/#/g, '%23');
}

// ---------------------------------------------------------------- 启动

// 单实例:第二次启动只唤起窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    ensureDirs();
    db = new AssetDb(DB_FILE);
    mergeLegacyRoots();
    syncRootWatchers();
    registerThumbProtocol();
    registerBackgroundProtocol();
    registerIpc();
    buildTray();
    createWindow();

    // 启动后的增量扫描:近 5 分钟扫过就跳过(避免每次启动都占用主线程导致"未响应")
    setTimeout(() => {
      const roots = db.listRoots().filter((r) => r.enabled === 1);
      if (!roots.length) return;
      const last = Math.max(...roots.map((r) => r.lastScanAt ?? 0));
      if (Date.now() - last < 60 * 1000) {
        console.log('[scan] 跳过启动扫描(最近已扫过)');
        return;
      }
      void runScan({});
    }, 2500);

    // 兜底:文件监听的删除事件不总是可靠(比如整目录被删),每 10 分钟对账一次
    setInterval(() => {
      if (!scanAbort && db.listRoots().some((r) => r.enabled === 1)) void runScan({});
    }, 10 * 60 * 1000);
  });

  // 托盘应用:所有窗口关掉也不退出
  app.on('window-all-closed', () => {
    // 不调用 app.quit()
  });

  app.on('before-quit', () => {
    quitting = true;
    scanAbort?.abort();
    db?.close();
  });
}
