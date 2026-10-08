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

import { app, BrowserWindow, Tray, Menu, ipcMain, shell, clipboard, nativeImage, protocol, net, dialog, screen } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AssetDb } from './db.ts';
import { scanLibrary, THUMB_DIR_NAME, META_VERSION, type ScanProgress } from './indexer.ts';
import { fingerprintOf, normalizeLoraName, type RecipeRecord } from '../shared/recipes.ts';
import type { RecipeStat } from '../shared/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolsRequire = createRequire(import.meta.url);
/**
 * 解析器在打包后的相对位置会变(开发时在 dist/main 旁边,打包后在 app.asar 根目录),
 * 所以按"相对 app 根 + 相对本文件"两个位置依次找,找到哪个用哪个。
 * 必须和扫描器共用同一份实现,否则"拖入解析"和"入库解析"会不一致。
 */
function loadComfyParser(): string {
  const candidates = [
    path.join(app.getAppPath(), 'tools', 'comfy-parser.cjs'),
    path.join(__dirname, '..', 'tools', 'comfy-parser.cjs'),
    path.join(__dirname, '..', '..', 'tools', 'comfy-parser.cjs'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* 继续试下一个 */
    }
  }
  return candidates[0];
}

// 与扫描器共用同一个解析器(必须是同一份实现,否则拖入解析和入库解析会不一致)
const { extractFromPng } = toolsRequire(loadComfyParser()) as {
  extractFromPng: (filePath: string, opts?: { keepRaw?: boolean }) => {
    dimensions: { width: number; height: number } | null;
    meta: import('../shared/types.ts').GenerationMeta;
  };
};
const isDev = !app.isPackaged;

// ---------------------------------------------------------------- 路径

/**
 * 数据目录(设置 + 索引库)默认在 userData 里。
 * `CAM_DATA_DIR` 可以覆盖它 —— 与 `tools/cli-index.ts` 是同一个环境变量:
 *   - 把索引库放到别的盘(库很大时有用);
 *   - 隔离测试(不想碰用户的真实索引库)。
 */
const DATA_DIR = process.env.CAM_DATA_DIR
  ? path.resolve(process.env.CAM_DATA_DIR)
  : path.join(app.getPath('userData'), 'data');
const DB_FILE = path.join(DATA_DIR, 'index.db');

/**
 * LoRA 配方目录(v0.8):不建表,每条配方一个 <id>.recipe.json,
 * 格式与外部工具互通;封面图统一拷贝成 <id><原扩展名> 放在同一目录里。
 */
const RECIPES_DIR = path.join(app.getPath('userData'), 'recipes');

/** 配方 id 只允许安全字符 —— 它会直接拼进文件名,防路径穿越 */
function recipeFile(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('非法的配方 id');
  return path.join(RECIPES_DIR, `${id}.recipe.json`);
}

/** 该路径是否落在 recipes 目录内部(封面只允许服务/清理目录内的文件) */
function isInRecipesDir(p: string): boolean {
  const rel = path.relative(RECIPES_DIR, path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 读一条配方;不存在或解析失败返回 null(不抛) */
function readRecipeFile(id: string): RecipeRecord | null {
  try {
    const rec = JSON.parse(fs.readFileSync(recipeFile(id), 'utf8')) as RecipeRecord;
    return rec && typeof rec === 'object' ? rec : null;
  } catch {
    return null;
  }
}

/** 全部配方;解析失败的文件被跳过(与 listRecipes handler 共用同一份实现) */
function readAllRecipes(): RecipeRecord[] {
  const out: RecipeRecord[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(RECIPES_DIR).filter((n) => n.endsWith('.recipe.json'));
  } catch {
    return out; // 目录还没有 = 还没有配方
  }
  for (const n of names) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(RECIPES_DIR, n), 'utf8')) as RecipeRecord;
      if (rec && typeof rec.id === 'string' && typeof rec.title === 'string') out.push(rec);
    } catch (e) {
      console.warn('[recipes] 跳过无法解析的配方文件:', n, e instanceof Error ? e.message : e);
    }
  }
  return out;
}

/**
 * 配方里参与匹配的 LoRA(非 exclude、名字规范化后非空),展开成 db 层 recipeLoras 的形状。
 * 权重不是有限数时传 null —— 与 matchRecipes 一致:只按名字比。
 */
function recipeMatchLoras(rec: RecipeRecord): Array<{ name: string; strength: number | null }> {
  if (!Array.isArray(rec.loras)) return [];
  const out: Array<{ name: string; strength: number | null }> = [];
  for (const l of rec.loras) {
    if (!l || l.exclude === true) continue;
    const name = typeof l.file_name === 'string' ? l.file_name : '';
    if (normalizeLoraName(name) === '') continue;
    const s = Number(l.strength);
    out.push({ name, strength: Number.isFinite(s) ? s : null });
  }
  return out;
}

// ---------------------------------------------------------------- 设置

const SETTINGS_FILE = process.env.CAM_DATA_DIR
  ? path.join(path.dirname(DATA_DIR), 'settings.json')
  : path.join(app.getPath('userData'), 'settings.json');

/**
 * 从旧名字(ComfyUI 资产管理器)迁移索引与设置:
 * 改名后 userData 会变成 %APPDATA%\A3 manager,不迁移就得重新扫描全库。
 */
function migrateLegacyUserData(): void {
  try {
    const legacyDir = path.join(app.getPath('appData'), 'ComfyUI 资产管理器');
    if (!fs.existsSync(legacyDir)) return;
    const dataDir = path.join(app.getPath('userData'), 'data');
    // 自定义数据目录(CAM_DATA_DIR)时不要迁移:那是"我已经指定好库在哪",
    // 把旧目录的索引拷进去会覆盖/污染用户明确指定的位置。
    if (DATA_DIR !== dataDir) return;
    const legacyDb = path.join(legacyDir, 'data', 'index.db');
    if (fs.existsSync(legacyDb) && !fs.existsSync(path.join(dataDir, 'index.db'))) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.copyFileSync(legacyDb, path.join(dataDir, 'index.db'));
      console.log('[migrate] 已从旧目录迁入索引库');
    }
    const legacySettings = path.join(legacyDir, 'settings.json');
    if (fs.existsSync(legacySettings) && !fs.existsSync(SETTINGS_FILE)) {
      fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
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
  petEnabled: boolean;
  petPosition: { x: number; y: number } | null;
  petIconSize: number;
  petPanelSize: { width: number; height: number };
  petImageFirst: boolean;
  /** 小窗点击穿透:开启后窗口不拦鼠标,悬停图标/面板时渲染层临时恢复交互 */
  petClickThrough: boolean;
  lastBrowseRelDir: string | null;
  configVersion: number;
} = {
  closeToTray: true,
  // 默认亮色 + 磨砂(reduceEffects=false);用户可在设置里改
  theme: 'light',
  reduceEffects: false,
  backgroundImage: null,
  backgroundFit: 'cover',
  petEnabled: false,
  petPosition: null,
  petIconSize: 64,
  petPanelSize: { width: 430, height: 620 },
  // 默认"图片优先":小窗里先看见图,参数想看再点开
  petImageFirst: true,
  petClickThrough: false,
  lastBrowseRelDir: null,
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
  // 自定义数据目录时 settings.json 的父目录可能还不存在(默认情况下 userData 已经被 Electron 建好了)
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
    // 自定义数据目录(CAM_DATA_DIR)时不补登记:那是"我自己指定的库",
    // 不该把用户旧库里的图库顺手搬进来(隔离测试尤其需要这条)。
    if (DATA_DIR !== path.join(app.getPath('userData'), 'data')) return;
    // 用只读连接读旧库,避免影响它。
    // 注意:这里是 ESM,不能用 require();主进程已经 import 了 DatabaseSync,直接复用。
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
  if (!fs.existsSync(RECIPES_DIR)) fs.mkdirSync(RECIPES_DIR, { recursive: true });
}

// ---------------------------------------------------------------- 全局状态

let db: AssetDb;
let mainWindow: BrowserWindow | null = null;
/** 工作小窗(桌宠)。始终置顶、透明、不进任务栏 */
let petWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let scanAbort: AbortController | null = null;
let lastProgress: ScanProgress | null = null;
/** 关闭按钮是"收进托盘"还是"退出" */
let quitting = false;

/**
 * 配方命中统计(getRecipeStats)的缓存。
 * 失效条件:
 *  1. 配方目录签名变化(文件名 + mtime —— 应用内保存/删除与外部工具改文件都能捕获);
 *  2. 图库索引代际变化(扫描结束且本轮有新入库/清理 → indexGeneration 递增)。
 */
let recipeStatsCache: { sig: string; gen: number; stats: RecipeStat[] } | null = null;
let indexGeneration = 0;

/** 配方目录签名:文件名 + mtime。外部工具直接改 .recipe.json 也会让它变。 */
function recipesDirSignature(): string {
  try {
    return fs
      .readdirSync(RECIPES_DIR)
      .filter((n) => n.endsWith('.recipe.json'))
      .map((n) => {
        try {
          return `${n}:${fs.statSync(path.join(RECIPES_DIR, n)).mtimeMs}`;
        } catch {
          return n;
        }
      })
      .sort()
      .join('|');
  } catch {
    return '';
  }
}

/** 拖入图片预览的最长边(只影响界面预览,原图不动) */
const PREVIEW_MAX = 900;

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
/**
 * 每个图库根的递归文件监听是否健康。
 *
 * 监听健康 = 应用运行期间的新增/删除都会被实时捕获,于是**不必**在启动时
 * 再遍历一遍目录树(那才是启动卡顿的来源:一万个文件 stat 一遍)。
 * 监听缺失或报错 → 退回全量对账,保证不会漏掉变化。
 */
const watchHealthy = new Map<number, boolean>();
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
  watchHealthy.clear();
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
      watcher.on('error', () => {
        // 监听断了(盘被拔掉、句柄失效)—— 之后靠全量对账兜底
        watchHealthy.set(root.id, false);
        console.log('[watch] 监听失效,转为全量对账:', root.path);
      });
      rootWatchers.push(watcher);
      watchHealthy.set(root.id, true);
      console.log('[watch] 监听', root.path);
    } catch {
      // 目录不存在,或平台不支持递归监听 —— 标记为不健康,交给全量对账
      watchHealthy.set(root.id, false);
    }
  }
  console.log('[watch] 监听图库目录:', rootWatchers.length, '健康:', [...watchHealthy.values()].filter(Boolean).length);
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

// ---------------------------------------------------------------- 工作小窗(桌宠)

/**
 * 小图标首次出现的位置:屏幕右下角留一点边距。
 * 之后位置由用户在桌面上拖动决定,存在 settings.petPosition 里。
 */
function defaultPetPosition(iconSize: number): { x: number; y: number } {
  try {
    const display = screen.getPrimaryDisplay();
    const wa = display.workArea;
    return {
      x: Math.round(wa.x + wa.width - iconSize - 32),
      y: Math.round(wa.y + wa.height - iconSize - 96),
    };
  } catch {
    return { x: 1200, y: 600 };
  }
}

/**
 * 持久化的图标位置是否还在某块屏的可用区域内。
 *
 * 多屏/分辨率变化后,上次的坐标可能落在已经拔掉的副屏上 —— 不校验的话
 * 小窗会开在一个永远看不见的地方,只能去托盘里关了重开(还回不去)。
 * Display.workArea 是 DIP,与渲染层的 CSS 像素同一坐标系,可以直接比较。
 */
function petPositionVisible(pos: { x: number; y: number }): boolean {
  try {
    return screen.getAllDisplays().some((d) => {
      const wa = d.workArea;
      return pos.x >= wa.x - 8 && pos.x < wa.x + wa.width && pos.y >= wa.y - 8 && pos.y < wa.y + wa.height;
    });
  } catch {
    return true; // 拿不到屏幕信息时不否决用户的位置
  }
}

/**
 * 应用"点击穿透"设置。
 *
 * 开启 = setIgnoreMouseEvents(true, { forward: true }):鼠标事件穿透到下面的窗口,
 * 但 mousemove 会以 forward 形式转发给渲染层 —— 渲染层靠它判断光标是否悬停在
 * 图标/面板上,悬停时调 setPetIgnoreMouse(false) 临时把交互要回来。
 */
function applyPetClickThrough(): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (settings.petClickThrough === true) {
    petWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    petWindow.setIgnoreMouseEvents(false);
  }
}

/**
 * 创建小窗。
 *
 * 关键取舍:窗口本身是**透明的、置顶的、不进任务栏**,里面同时装"小图标"和"展开后的工作窗"。
 * 展开/收起时由渲染层调用 movePetWindow 把窗口挪成对应的尺寸 ——
 * 这样透明区域不会挡住桌面点击(窗口矩形有多大,可点区域就有多大)。
 */
function createPetWindow(): void {
  if (petWindow && !petWindow.isDestroyed()) return;
  const iconSize = Math.max(40, Math.min(160, settings.petIconSize || 64));
  let pos = settings.petPosition || defaultPetPosition(iconSize);
  // 坐标落在屏幕外(副屏拔了/分辨率变了)就回落到主屏右下角,避免"开了但看不见"
  if (!petPositionVisible(pos)) {
    pos = defaultPetPosition(iconSize);
    settings.petPosition = pos;
    saveSettings();
  }

  petWindow = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width: iconSize,
    height: iconSize,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // 必须可 resize:收起态 64×64、展开态要变成"面板 + 图标"的包围盒。
    // 之前写死 resizable:false(再叠加 thickFrame:false)会让 setBounds 改不了尺寸,
    // 于是面板被画在窗口外面 —— 表现就是"只看到一条白条、图标位置也不对"。
    resizable: true,
    // 去掉 Windows 的可调边框框架:frame:false 时 thickFrame 默认仍为 true,
    // 会在透明窗口顶部画出一条浅色框架条(用户看到的"白条")。程序改尺寸走 setBounds,
    // 不依赖这条边框。
    thickFrame: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: '',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // 悬浮在所有普通窗口之上(但不抢焦点)
  petWindow.setAlwaysOnTop(true, 'floating');
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  // 点击穿透在创建时就生效:否则开了穿透重启后,第一次加载完成前窗口仍能点
  applyPetClickThrough();

  const file = path.join(__dirname, '../renderer/pet.html');
  if (fs.existsSync(file)) {
    void petWindow.loadFile(file);
  } else {
    console.error('[pet] 找不到 pet.html,小窗无法加载:', file);
  }

  petWindow.once('ready-to-show', () => {
    // 标题留空:无边框窗口的标题会在悬停时被当成提示条画出来
    petWindow?.setTitle('');
    if (settings.petEnabled) petWindow?.showInactive();
  });
  petWindow.on('closed', () => {
    petWindow = null;
  });
}

function destroyPetWindow(): void {
  if (!petWindow || petWindow.isDestroyed()) {
    petWindow = null;
    return;
  }
  petWindow.destroy();
  petWindow = null;
}

function broadcastPetState(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    w.webContents.send('pet:stateChanged');
  }
}

/** 设置里开关"工作小窗"时调用 */
function setPetEnabled(enabled: boolean): void {
  settings.petEnabled = enabled;
  saveSettings();
  if (enabled) {
    if (!petWindow || petWindow.isDestroyed()) createPetWindow();
    else petWindow.showInactive();
  } else {
    destroyPetWindow();
  }
  broadcastPetState();
  rebuildTrayMenu();
}

// ---------------------------------------------------------------- 托盘

let refreshTrayMenu: (() => void) | null = null;

/** 设置变化后让托盘菜单重新生成(比如"小窗模式"的勾选状态) */
function rebuildTrayMenu(): void {
  refreshTrayMenu?.();
}

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
          label: '工作小窗(桌宠)',
          type: 'checkbox',
          checked: settings.petEnabled === true,
          click: (item) => setPetEnabled(item.checked),
        },
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

  refreshTrayMenu = refreshMenu;
  refreshMenu();
  tray.on('double-click', showWindow);
  tray.on('click', () => tray?.popUpContextMenu());

  // 进度变化时刷新托盘提示。
  // 注意节流:扫描期间进度事件很密,每次都 Menu.buildFromTemplate 重建托盘菜单
  // 是白花的开销(还会抢占主进程)。提示文字每次都更新,菜单只在阶段变化或
  // 距上次重建超过 1 秒时才重建。
  let lastTrayPhase: string | null = null;
  let lastTrayRebuild = 0;
  progressListeners.push((p) => {
    lastProgress = p;
    tray?.setToolTip(
      p.phase === 'parsing' ? `扫描中 ${p.processed}/${p.total}` : 'A3 manager'
    );
    const now = Date.now();
    if (p.phase !== lastTrayPhase || now - lastTrayRebuild > 1000) {
      lastTrayPhase = p.phase;
      lastTrayRebuild = now;
      refreshMenu();
    }
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
async function runScan(opts: { rootIds?: number[]; force?: boolean; forceRescan?: boolean }): Promise<void> {
  if (scanAbort) return; // 已在扫描
  scanAbort = new AbortController();
  // 解析器口径变过(升级后第一次启动)→ 强制重扫一遍元数据,用户不必手动点重新扫描
  const storedMetaVersion = db.getKv('meta_version');
  const metaChanged = storedMetaVersion !== String(META_VERSION);
  if (metaChanged) {
    console.log('[scan] 解析版本', storedMetaVersion ?? '(无)', '→', META_VERSION, ',本次强制重扫元数据');
  }
  try {
    await scanLibrary(db, {
      rootIds: opts.rootIds,
      force: opts.force === true || metaChanged,
      forceRescan: opts.forceRescan === true || metaChanged,
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
    if (lastProgress && lastProgress.phase === 'done' && lastProgress.message) {
      console.log('[scan]', lastProgress.message);
    }
    // 只有整轮跑完(没被取消/中途出错)才记下版本,否则下次还会再扫一遍
    if (!lastProgress || lastProgress.phase === 'done') {
      try {
        db.setKv('meta_version', String(META_VERSION));
      } catch {
        /* 记不下就下次再扫 */
      }
    }
    // 本轮有新入库/清理 → 配方命中统计的缓存作废(代际 +1,getRecipeStats 会重算)
    if (lastProgress && lastProgress.phase === 'done'
        && ((lastProgress.indexed ?? 0) !== 0 || (lastProgress.removed ?? 0) !== 0)) {
      indexGeneration++;
    }
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

/**
 * 把前端传来的目录参数解析成绝对路径。
 * 左侧文件夹树传的是相对某个图库根的相对路径('' 表示图库根本身),
 * 绝对路径也接受(拖入图片的所在目录就走这条)。
 */
function resolveLibraryDir(input: string): string | null {
  const raw = String(input ?? '').trim();
  if (raw && path.isAbsolute(raw)) return fs.existsSync(raw) ? raw : null;
  if (raw === '') return null; // 交给下面按图库根兜底
  for (const r of db.listRoots() as Array<{ path: string }>) {
    const abs = path.resolve(r.path, raw);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

/** 某个图库根目录里的**直接子目录**(只扫一层,够用来定位) */
function firstChildDirFiles(dir: string): string | null {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        const p = path.join(dir, e.name);
        try {
          if (fs.readdirSync(p).length > 0) return p;
        } catch {
          /* 读不动就换下一个 */
        }
      }
    }
  } catch {
    /* 目录不存在 */
  }
  return null;
}

/** 拖入图片的预览:等比缩到 900px 里,数据量够小可以直接塞进 IPC 返回值 */
function makePreviewDataUrl(absPath: string): { dataUrl: string | null; size: { width: number; height: number } | null } {
  const img = nativeImage.createFromPath(absPath);
  if (img.isEmpty()) return { dataUrl: null, size: null };
  const size = img.getSize();
  const scale = Math.min(PREVIEW_MAX / Math.max(size.width, size.height, 1), 1);
  const w = Math.max(1, Math.round(size.width * scale));
  const h = Math.max(1, Math.round(size.height * scale));
  const out = scale < 1 ? img.resize({ width: w, height: h, quality: 'good' }) : img;
  return { dataUrl: out.toDataURL(), size };
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
    // 解码前先让出一帧:nativeImage.createFromPath 是同步大图解码(几百毫秒级),
    // 拿到槽位立刻解码会把排队期间的界面消息再压后一轮
    await new Promise((r) => setImmediate(r));
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
  // 原图协议:详情面板预览用(缩略图只有几百像素,放大看是糊的)
  { scheme: 'cam-file', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
  // 自定义背景图:cam-bg://bg/current —— 具体读哪个文件由主进程的 settings 决定,
  // URL 里不带路径,渲染层拿不到也无从越权读取别的文件。
  { scheme: 'cam-bg', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
  // 配方封面:cam-recipe://cover/<id> —— 只服务 recipes 目录内的封面文件(见 registerRecipeProtocol)
  { scheme: 'cam-recipe', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
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

/** 原图协议:cam-file://file/<id>,只服务索引库里的图(按 id 查库拿路径,无法越权) */
function registerFileProtocol(): void {
  protocol.handle('cam-file', async (request) => {
    try {
      const url = new URL(request.url);
      const id = Number(url.pathname.replace(/^\/+/, ''));
      if (!Number.isFinite(id) || id <= 0) return new Response('bad id', { status: 400 });
      const row = db.getImageRow(id);
      if (!row) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileUrl(row.abs_path as string));
    } catch {
      return new Response('error', { status: 500 });
    }
  });
}

/**
 * 配方封面协议:cam-recipe://cover/<id>。
 * 按 id 读 <id>.recipe.json 里的 file_path,**只服务 recipes 目录内的文件**:
 * 保存时外部图会被拷进来,所以外部路径的封面(外部工具直接写的 json)直接 404,
 * 不给渲染层"指定任意路径读文件"的能力。
 */
function registerRecipeProtocol(): void {
  protocol.handle('cam-recipe', async (request) => {
    try {
      const url = new URL(request.url);
      const id = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      if (!/^[A-Za-z0-9_-]+$/.test(id)) return new Response('bad id', { status: 400 });
      const rec = readRecipeFile(id);
      const cover = rec?.file_path;
      if (typeof cover !== 'string' || !cover || !isInRecipesDir(cover) || !fs.existsSync(cover)) {
        return new Response('no cover', { status: 404 });
      }
      return net.fetch(pathToFileUrl(cover));
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
    // 按 LoRA 配方筛选:在主进程把配方文件展开成 recipeLoras(db 层不碰文件系统);
    // 配方不存在 / 没有有效 LoRA → recipeNoMatch(空结果,不是"不过滤")
    const recipeId = typeof query.recipeId === 'string' ? query.recipeId.trim() : '';
    delete query.recipeId;
    if (recipeId) {
      const rec = readRecipeFile(recipeId);
      const loras = rec ? recipeMatchLoras(rec) : [];
      if (loras.length === 0) query.recipeNoMatch = true;
      else query.recipeLoras = loras;
    }
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
  /** 复制任意文本(提示词复制按钮用) */
  handle('copyText', (text: string) => {
    if (typeof text === 'string' && text) clipboard.writeText(text);
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

  /**
   * 复制「无元数据版」图片到剪贴板。
   * nativeImage 解码 → 再编码成 PNG,像素完全一致,但所有
   * tEXt / iTXt / zTXt 块在重编码时被丢掉。只写剪贴板,不落新文件。
   */
  handle('copyImageWithoutMetadata', async (id: number) => {
    const row = db.getImageRow(id);
    if (!row) throw new Error('图片不存在');
    const img = nativeImage.createFromPath(row.abs_path as string);
    if (img.isEmpty()) throw new Error('图片读取失败');
    const buf = img.toPNG();
    if (!buf || buf.length === 0) throw new Error('重新编码失败');
    clipboard.writeImage(nativeImage.createFromBuffer(buf));
  });

  /**
   * 只解析一个图片文件的元数据(把图片拖进窗口时用):
   * 不入库、不复制、不动原图。非 PNG 没有内嵌元数据,只回尺寸与预览。
   */
  handle('inspectFile', async (filePath: string) => {
    const abs = path.resolve(String(filePath ?? ''));
    let st: fs.Stats;
    try {
      st = await fsp.stat(abs);
    } catch {
      throw new Error('读不到这个文件:' + abs);
    }
    if (!st.isFile()) throw new Error('这不是一个文件:' + abs);

    const preview = makePreviewDataUrl(abs);
    const ext = path.extname(abs).toLowerCase();

    let dimensions: { width: number; height: number } | null = preview.size;
    let meta: ReturnType<typeof extractFromPng>['meta'] | null = null;

    if (ext === '.png') {
      try {
        const parsed = extractFromPng(abs, { keepRaw: false });
        dimensions = parsed.dimensions ?? dimensions;
        const m = parsed.meta;
        if (m && (m.prompts.length > 0 || m.modelName || m.sampler || m.loras.length > 0)) {
          meta = m;
        }
      } catch {
        // PNG 解析失败(图坏了 / 读不动)—— 只给尺寸与预览,不报错
      }
    }

    return {
      path: abs,
      fileName: path.basename(abs),
      fileSize: st.size,
      fileMtime: st.mtimeMs,
      dimensions,
      previewDataUrl: preview.dataUrl,
      meta,
    };
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

  /** 批量复制:选一次目录,逐文件复制;同名跳过,原图与索引都不动 */
  handle('copyImagesToFolder', async (ids: number[], targetDir?: string) => {
    let dir = targetDir;
    if (!dir) {
      const picked = await dialog.showOpenDialog(mainWindow ?? BrowserWindow.getAllWindows()[0], {
        title: '把选中的图片复制到…',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (picked.canceled || !picked.filePaths[0]) {
        return { copied: 0, skipped: 0, target: null, errors: [] };
      }
      dir = picked.filePaths[0];
    }

    let copied = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const id of ids) {
      try {
        const row = db.getImageRow(id);
        if (!row) { errors.push(`#${id} 不在索引里`); continue; }
        const src = row.abs_path as string;
        const target = path.join(dir, row.file_name as string);
        if (path.resolve(target) === path.resolve(src)) { skipped++; continue; }
        if (fs.existsSync(target)) { skipped++; continue; }
        await fsp.copyFile(src, target);
        copied++;
      } catch (e) {
        errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { copied, skipped, target: dir, errors };
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
  /**
   * 用资源管理器打开某个图库文件夹。
   * relDir 为空时打开图库根目录;目录里还有子目录就直接定位到最新的那个,
   * 免得用户点「打开所在位置」还得自己再点一层。
   */
  handle('openFolder', async (relDir: string) => {
    const roots = db.listRoots() as Array<{ path: string }>;
    if (roots.length === 0) throw new Error('还没有添加图库文件夹');

    let raw = String(relDir ?? '').trim();
    // 前端可能传绝对路径(拖入图片的所在目录)
    if (raw && path.isAbsolute(raw)) {
      const err = await shell.openPath(fs.existsSync(raw) ? raw : path.dirname(raw));
      if (err) throw new Error(err);
      return;
    }

    let dir: string | null = null;
    if (raw === '') {
      dir = roots[0].path;
    } else {
      dir = resolveLibraryDir(raw);
    }
    if (!dir) throw new Error('找不到这个文件夹:' + relDir);
    if (raw !== '' && fs.existsSync(dir)) {
      const child = firstChildDirFiles(dir);
      if (child) dir = child;
    }
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
  });

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
    const wantPet = patch.petEnabled;
    settings = { ...settings, ...patch };
    saveSettings();
    applyWindowChrome();
    if (petWindow && !petWindow.isDestroyed()) petWindow.setBackgroundColor('#00000000');
    broadcastPetState();
    // 点击穿透是即时行为:不用等重启,直接对现有小窗生效
    if (typeof patch.petClickThrough === 'boolean') applyPetClickThrough();
    // 开关"工作小窗"要真的把窗口创建/销毁,而不是只记一个布尔值
    if (typeof wantPet === 'boolean' && wantPet !== (petWindow !== null)) {
      setPetEnabled(wantPet);
    }
    return settings;
  });

  // ---- 缩略图:自定义协议,前端直接用 <img src="cam-thumb://thumb/<id>">
  // 主机名必须是字母:standard scheme 下纯数字主机名会被规范化成 IPv4
  handle('getThumbUrl', (id: number) => `cam-thumb://thumb/${id}`);

  // ---- LoRA 配方(v0.8):<userData>/recipes/<id>.recipe.json,一配方一文件
  handle('listRecipes', () => readAllRecipes());

  /**
   * 每个配方当前命中的图片数(左侧「配方」小节的数量胶囊)。
   * 每个配方跑一次 COUNT 查询(子集匹配口径,与按配方筛选走同一WHERE);
   * 结果带缓存:配方目录签名(文件名+mtime)或索引代际(扫描有实际变化)变了才重算。
   */
  handle('getRecipeStats', () => {
    const sig = recipesDirSignature();
    if (recipeStatsCache && recipeStatsCache.sig === sig && recipeStatsCache.gen === indexGeneration) {
      return recipeStatsCache.stats;
    }
    const t0 = Date.now();
    const stats: RecipeStat[] = readAllRecipes().map((rec) => {
      const loras = recipeMatchLoras(rec);
      const count = loras.length === 0 ? 0 : db.queryImages({ recipeLoras: loras, limit: 1 }).total;
      return { id: rec.id, title: rec.title, count };
    });
    console.log(`[recipes] 配方命中统计:${stats.length} 个配方,${Date.now() - t0}ms`);
    recipeStatsCache = { sig, gen: indexGeneration, stats };
    return stats;
  });

  handle('saveRecipe', (input: RecipeRecord) => {
    const rec = (input ?? {}) as RecipeRecord;
    if (typeof rec.title !== 'string' || !rec.title.trim()) throw new Error('配方名字不能为空');
    if (!Array.isArray(rec.loras)) throw new Error('配方的 LoRA 列表必须是数组');
    fs.mkdirSync(RECIPES_DIR, { recursive: true });

    const now = Date.now() / 1000; // 秒级浮点,对齐外部工具的 modified/created_date
    const hasId = typeof rec.id === 'string' && rec.id !== '';
    const existing = hasId ? readRecipeFile(rec.id) : null;
    const id = existing && typeof existing.id === 'string' ? existing.id : hasId ? rec.id : randomUUID();
    // 合并顺序:磁盘上的旧记录(保留未知字段,round-trip)← 前端传来的整份 ← 我们负责的字段
    const merged: RecipeRecord = {
      ...(existing ?? {}),
      ...rec,
      id,
      title: rec.title.trim(),
      base_model: typeof rec.base_model === 'string' && rec.base_model.trim() ? rec.base_model.trim() : null,
      favorite: rec.favorite === true,
      created_date: typeof existing?.created_date === 'number' ? existing.created_date : now,
      modified: now,
      fingerprint: fingerprintOf(rec.loras),
    };

    // 封面:用户新选的外部图 → 拷进 recipes 目录命名为 <id><原扩展名>,file_path 指向副本;
    // 已在 recipes 目录内的不动。换图/清除封面时把旧封面文件清掉(仅限目录内,防误删)。
    const oldCover = typeof existing?.file_path === 'string' ? existing.file_path : null;
    if (typeof merged.file_path === 'string' && merged.file_path && fs.existsSync(merged.file_path) && !isInRecipesDir(merged.file_path)) {
      const ext = path.extname(merged.file_path) || '.png';
      const target = path.join(RECIPES_DIR, `${id}${ext}`);
      fs.copyFileSync(merged.file_path, target);
      merged.file_path = target;
    }
    if (oldCover && isInRecipesDir(oldCover)) {
      const stillUsed =
        typeof merged.file_path === 'string' &&
        !!merged.file_path &&
        path.resolve(merged.file_path) === path.resolve(oldCover);
      if (!stillUsed) {
        try { fs.rmSync(oldCover, { force: true }); } catch { /* 封面删不掉不影响保存 */ }
      }
    }

    fs.writeFileSync(recipeFile(id), JSON.stringify(merged, null, 2));
    recipeStatsCache = null; // 配方内容变了,命中统计立刻失效
    return merged;
  });

  handle('deleteRecipe', (id: string) => {
    const rid = String(id ?? '');
    if (!rid) return;
    const existing = readRecipeFile(rid); // 顺带做 id 合法性校验(非法 id 返回 null)
    if (existing && typeof existing.file_path === 'string' && existing.file_path && isInRecipesDir(existing.file_path)) {
      try { fs.rmSync(existing.file_path, { force: true }); } catch { /* 忽略 */ }
    }
    try { fs.rmSync(recipeFile(rid), { force: true }); } catch { /* 配方不存在就当删过了 */ }
    recipeStatsCache = null;
  });

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

  // ---- 工作小窗(桌宠)

  handle('getPetState', () => ({
    enabled: settings.petEnabled === true,
    theme: currentTheme(),
    iconSize: settings.petIconSize,
    panelSize: settings.petPanelSize,
    position: settings.petPosition,
    reduceEffects: settings.reduceEffects === true,
    imageFirst: settings.petImageFirst !== false,
    clickThrough: settings.petClickThrough === true,
    lastRelDir: settings.lastBrowseRelDir ?? null,
  }));

  handle('setPetPosition', (position: { x: number; y: number }) => {
    if (!position || typeof position.x !== 'number' || typeof position.y !== 'number') return;
    settings.petPosition = { x: Math.round(position.x), y: Math.round(position.y) };
    saveSettings();
  });

  handle('setPetLayout', (patch: { iconSize?: number; panelSize?: { width: number; height: number } }) => {
    if (patch && typeof patch.iconSize === 'number') {
      settings.petIconSize = Math.max(40, Math.min(160, Math.round(patch.iconSize)));
    }
    if (patch && patch.panelSize && typeof patch.panelSize.width === 'number' && typeof patch.panelSize.height === 'number') {
      settings.petPanelSize = {
        width: Math.max(300, Math.min(900, Math.round(patch.panelSize.width))),
        height: Math.max(360, Math.min(1200, Math.round(patch.panelSize.height))),
      };
    }
    saveSettings();
    broadcastPetState();
  });

  handle('focusMainWindow', () => {
    showWindow();
  });

  /** 小窗自己改窗口位置/尺寸:图标态是正方形小窗,展开态是"图标 + 面板"的大窗 */
  handle('movePetWindow', (bounds: { x: number; y: number; width: number; height: number }) => {
    if (!petWindow || petWindow.isDestroyed()) return;
    const b = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(24, Math.round(bounds.width)),
      height: Math.max(24, Math.round(bounds.height)),
    };
    // 单次 setBounds 同时改位置与尺寸。
    // 之前先 setSize 再 setBounds(两次原生调用)还在每次移动时同步写配置文件,
    // 拖动一帧一次磁盘 I/O,窗口就会"慢几秒才追上鼠标"。
    petWindow.setBounds(b);
    // 位置持久化不在这里做:展开时 b.x/b.y 是窗口左上角而不是图标位置,
    // 写进去会污染 settings.petPosition。落盘由渲染层拖动结束时的 setPetPosition 负责。
  });

  handle('closePetWindow', () => {
    setPetEnabled(false);
  });

  /**
   * 点击穿透下的"悬停恢复交互"开关(渲染层借 forward 的 mousemove 判断后调用)。
   * 只在穿透开启时有意义;穿透关闭时忽略,免得把正常交互关掉。
   */
  handle('setPetIgnoreMouse', (ignore: boolean) => {
    if (!petWindow || petWindow.isDestroyed()) return;
    if (settings.petClickThrough !== true) return;
    petWindow.setIgnoreMouseEvents(ignore === true, { forward: true });
  });

  /**
   * 拖出图片到别的应用(ComfyUI / NovelAI):磁盘原 PNG 自带元数据,
   * 直接拖原文件即可,不需要重新编码。
   *
   * 这是 send(fire-and-forget)而不是 handle:webContents.startDrag 必须在
   * 渲染层 dragstart 的同步阶段发起,invoke 的往返会让原生拖拽起不来。
   * startDrag 只支持单文件 —— 多选拖出时只拖第一张。
   *
   * 注意:startDrag 接管后,这次拖拽就变成操作系统级的文件拖拽,
   * 渲染层 dataTransfer 里的私有 MIME 可能随之丢失 —— 窗口内的落点
   * (左侧分类)一律改从 dnd 模块级 store 读 ids,不依赖 dataTransfer。
   */
  ipcMain.on('drag-out-images', (e, ids: unknown) => {
    try {
      const list = Array.isArray(ids)
        ? ids.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
        : [];
      const id = list[0];
      if (!id) return;
      const row = db.getImageRow(id);
      if (!row) return;
      const file = row.abs_path as string;
      if (!fs.existsSync(file)) return;
      // 拖拽图标:优先用已缓存的缩略图;没有就从原图现场缩一张 32px
      let icon = nativeImage.createEmpty();
      const root = (db.listRoots() as Array<{ id: number; path: string }>).find(
        (x) => x.id === (row.root_id as number)
      );
      if (root) {
        const thumb = thumbPathFor(root.path, row.rel_path as string);
        if (fs.existsSync(thumb)) icon = nativeImage.createFromPath(thumb);
      }
      if (icon.isEmpty()) {
        const full = nativeImage.createFromPath(file);
        if (!full.isEmpty()) icon = full.resize({ width: 32, height: 32 });
      }
      e.sender.startDrag({ file, icon });
    } catch {
      /* 拖出失败不影响窗口内部的"拖到分类"流程 */
    }
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
    registerFileProtocol();
    registerRecipeProtocol();
    registerIpc();
    buildTray();
    if (settings.petEnabled) createPetWindow();
    createWindow();

    /**
     * 启动时要不要遍历目录树?
     *
     * 不遍历的条件(常态):文件监听健康 + 解析口径没变 + 每个启用的图库都已有索引。
     * 因为监听是实时的,应用没运行期间有没有变化,靠扫描器里的"目录树签名"比对就能
     * 一眼看出 —— 签名一致时它自己会整轮跳过,连 stat 都不做。
     * 这一改把启动从"一万个文件走一遍目录树"降到"读完索引就出界面"。
     */
    setTimeout(() => {
      const roots = db.listRoots().filter((r) => r.enabled === 1);
      if (!roots.length) return;

      const versionChanged = db.getKv('meta_version') !== String(META_VERSION);
      const unwatched = roots.filter((r) => watchHealthy.get(r.id) !== true);
      const empty = roots.filter((r) => db.countImages(r.id) === 0);
      if (!versionChanged && unwatched.length === 0 && empty.length === 0) {
        console.log('[scan] 跳过启动扫描:文件监听正常、解析版本一致、索引已就绪');
        return;
      }
      console.log(
        '[scan] 启动扫描:',
        versionChanged ? '解析版本变了 ' : '',
        unwatched.length ? `监听不可用(${unwatched.length} 个图库) ` : '',
        empty.length ? `空索引(${empty.length} 个图库)` : ''
      );
      // 监听不可用 / 空索引时要老实遍历(不能走签名快速通道)
      void runScan({ forceRescan: versionChanged || unwatched.length > 0 });
    }, 2500);

    /**
     * 兜底对账:每 10 分钟一次,但**只在监听不健康时才真的遍历**。
     *
     * 以前这里是无条件 runScan,等于每 10 分钟把上万张图 stat 一遍(磁盘一直响)。
     * 现在监听正常时这一轮什么都不做:新图由 fs.watch 实时入库,
     * 删除由监听触发的增量扫描清理。监听不可用时才退化成全量对账。
     */
    setInterval(() => {
      if (scanAbort) return;
      const roots = db.listRoots().filter((r) => r.enabled === 1);
      if (!roots.length) return;
      const needReconcile = roots.some((r) => watchHealthy.get(r.id) !== true);
      if (!needReconcile) return;
      console.log('[scan] 定时对账:存在监听不可用的图库,做一次全量遍历');
      void runScan({ forceRescan: true });
    }, 10 * 60 * 1000);
  });

  // 托盘应用:所有窗口关掉也不退出
  app.on('window-all-closed', () => {
    // 不调用 app.quit()
  });

  app.on('before-quit', () => {
    quitting = true;
    destroyPetWindow();
    scanAbort?.abort();
    db?.close();
  });
}
