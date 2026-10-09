import type { RecipeRecord } from './recipes';
import type { CompareRow } from './compare';

// LoRA 配方的记录类型定义在 ./recipes(与匹配逻辑同处,纯 TS 可被 verify 脚本直接 import)
export type { RecipeRecord, RecipeLora } from './recipes';
// 配方比对的行/分组类型定义在 ./compare(同上:纯 TS,verify 直接测)
export type { CompareRow, CompareGroup, CompareDiff, CompareLora } from './compare';

/**
 * 前后端共享类型契约 —— 冻结文件。
 *
 * 规则:
 *  - 本文件是唯一真源。前端(Kimi K3)只读,不得手改。
 *  - 任何字段变更必须先改本文件,再改后端,最后前端适配。
 *  - 所有 IPC 通道的入参/返回类型都从这里导出。
 */

// ---------------------------------------------------------------- 基础

/** 元数据来源。决定详情面板显示哪些字段。 */
export type MetaSource =
  | 'comfyui' // PNG 内含 ComfyUI 的 prompt/workflow 文本块
  | 'comfyui-partial' // 有 prompt 块但解析失败或字段严重缺失
  | 'novelai' // PNG 内含 NAI 的 Comment/Description/Software 块
  | 'a1111' // 内含 A1111 的 parameters 块
  | 'unknown'; // 有文本块但认不出来

/** 扫描目标目录的一条记录。 */
export interface LibraryRoot {
  id: number;
  /** 绝对路径 */
  path: string;
  /** 用户在 UI 里起的别名 */
  label: string;
  /** 是否参与扫描 */
  enabled: boolean;
  addedAt: number;
  lastScanAt: number | null;
}

// ---------------------------------------------------------------- 图片

export interface ImageDimensions {
  width: number;
  height: number;
}

/** 一条图片资产记录。这是列表页每张缩略图要用的完整投影。 */
export interface ImageRecord {
  id: number;
  rootId: number;
  /** 绝对路径 */
  absPath: string;
  /** 相对所属 root 的路径,含文件名。UI 用它展示"文件夹"层级 */
  relPath: string;
  /** 相对路径的目录部分,'' 表示 root 根目录 */
  relDir: string;
  fileName: string;
  fileSize: number;
  /** 文件 mtime(毫秒) */
  fileMtime: number;
  /** PNG IHDR 里读出的真实像素尺寸 */
  dimensions: ImageDimensions | null;
  source: MetaSource;
  /** 缩略图缓存文件的绝对路径;还没生成时为 null */
  thumbPath: string | null;
  /** 是否已收藏 */
  starred: boolean;
  meta: GenerationMeta | null;
  indexedAt: number;
}

// ---------------------------------------------------------------- 生成参数

/** 采样器参数。K3 的详情面板直接渲染这些字段。 */
export interface SamplerParams {
  seed: number | null;
  steps: number | null;
  cfg: number | null;
  samplerName: string | null;
  scheduler: string | null;
  denoise: number | null;
  /** KSamplerAdvanced 专用 */
  startAtStep: number | null;
  endAtStep: number | null;
  /** 产生这些参数的节点 id,便于"原始数据"里定位 */
  nodeId: string | null;
  nodeType: string | null;
}

export interface LoraEntry {
  name: string;
  strengthModel: number | null;
  strengthClip: number | null;
  /** 发生加载的节点 id */
  nodeId: string;
}

export interface PromptBlock {
  /**
   * positive / negative 是常规正负提示词;
   * character 是 NovelAI v4+ 的角色提示词(char_captions / characterPrompts),
   * 一个角色一块,与基础提示词分开渲染。
   */
  role: 'positive' | 'negative' | 'character';
  text: string;
  encoders: string[];
  /** 仅 role='character' 时有值:像「角色 1」这样的显示标签 */
  label?: string;
}

export interface ControlNetEntry {
  name: string;
  strength: number | null;
  nodeId: string;
}

export interface GenerationMeta {
  source: MetaSource;
  /** 主模型文件名,如 chenkinNoobXLCKXL_v05.safetensors */
  modelName: string | null;
  /** 模型加载节点类型,如 CheckpointLoaderSimple */
  modelNodeType: string | null;
  loras: LoraEntry[];
  controlNets: ControlNetEntry[];
  /** 采样参数。多采样器工作流时取最终那一段 */
  sampler: SamplerParams | null;
  /** 该工作流里所有采样器(做对比/混合的工作流会有多个) */
  allSamplers: SamplerParams[];
  prompts: PromptBlock[];
  /** 工作流里出现过的全部节点类型,详情面板可折叠展示 */
  nodeTypes: string[];
  /** 节点总数 */
  nodeCount: number;
  /** 这个工作流用过哪些自定义节点包(粗推断) */
  customNodeHints: string[];
  /**
   * 原始 prompt 块 JSON(字符串,前端按需 JSON.parse)。
   * 可能上兆,列表接口里一律为 null,只有详情接口才返回。
   */
  rawPromptJson: string | null;
}

/** 详情接口返回的完整对象。 */
export interface ImageDetail extends ImageRecord {
  /** 同目录下的兄弟图片 id 列表,供详情页左右翻页 */
  siblings: number[];
  /** 在结果集中的位置(从 1 开始)/总数 */
  position: number;
  total: number;
}

/**
 * 拖进窗口的图片的**临时**解析结果(inspectFile 的返回)。
 * 明确区别于 ImageRecord:没有 id、不进索引库、也不保证在任何一个图库根目录里,
 * 所以不能做收藏 / 分类 / 重命名等需要 id 的操作。
 */
export interface DroppedInspection {
  /** 绝对路径 */
  path: string;
  fileName: string;
  fileSize: number;
  /** 文件 mtime(毫秒) */
  fileMtime: number;
  /** PNG IHDR / nativeImage 读到的真实像素尺寸 */
  dimensions: ImageDimensions | null;
  /** 供详情面板直接 <img src> 的预缩小预览(原始尺寸过大时等比缩小) */
  previewDataUrl: string | null;
  /** 解析结果;真的是没有元数据的 PNG 时为 null */
  meta: GenerationMeta | null;
}

/** 右侧详情面板的目标:索引里的图,或刚拖进来只做解析的图。 */
export type DetailTarget =
  | { kind: 'indexed'; detail: ImageDetail | null }
  | { kind: 'dropped'; info: DroppedInspection };

// ---------------------------------------------------------------- 查询

export type SortKey = 'mtime_desc' | 'mtime_asc' | 'name_asc' | 'size_desc' | 'random';

export interface ImageQuery {
  /** 全文搜索词:匹配文件名、提示词、模型名、LoRA 名 */
  q?: string;
  rootId?: number;
  /** 精确匹配相对目录 */
  relDir?: string;
  /** 含子目录 */
  relDirRecursive?: boolean;
  /** 来源筛选,空数组=全部 */
  sources?: MetaSource[];
  /** 只看收藏 */
  starredOnly?: boolean;
  /** 尺寸区间 */
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  /** 采样参数筛选 */
  samplerName?: string;
  modelName?: string;
  loraName?: string;
  /**
   * 限定在某个用户自定义分类内。
   * 与 relDir 不同:这是索引层的集合归属,不要求图片在同一个文件夹。
   */
  categoryId?: number;
  /** 是否把子分类的图片也算进来(默认 true) */
  categoryRecursive?: boolean;
  /**
   * 按 LoRA 配方筛选(v0.8):配方 id(对应 <userData>/recipes/<id>.recipe.json)。
   * 子集语义:配方的所有非 exclude LoRA 都在图里(名字规范化 + 权重 ±0.005)才算命中;
   * 可与文件夹/分类/收藏等其它筛选叠加。配方不存在或无有效 LoRA 时结果为空(不是"不过滤")。
   */
  recipeId?: string;
  /** 时间区间(毫秒) */
  mtimeFrom?: number;
  mtimeTo?: number;
  sort?: SortKey;
  /** 从 0 开始 */
  offset?: number;
  limit?: number;
}

export interface ImageQueryResult {
  ids: number[];
  total: number;
  /** 本次查询耗时(毫秒),调试与性能验收用 */
  tookMs: number;
}

/** 左侧「配方」小节的一行统计:该配方当前命中多少张图(子集匹配口径,与详情面板 matchRecipes 一致) */
export interface RecipeStat {
  id: string;
  title: string;
  count: number;
}

/** 侧边栏"文件夹树"的一个节点。 */
export interface FolderNode {
  rootId: number;
  rootLabel: string;
  /** 相对 root 的路径,'' 为根 */
  relDir: string;
  /** 该目录(不含子目录)下的图片数 */
  directCount: number;
  /** 该目录及所有子目录下的图片数 */
  totalCount: number;
  children: FolderNode[];
  /** 管理器里的别名(只影响显示,不动磁盘目录名) */
  alias?: string | null;
  /** 该目录(含子目录)里最新一张图的生成时间,用于"日期新的排前面" */
  latestMtime?: number | null;
  /** 设置里被取消勾选 = true,左侧栏不显示(磁盘与索引都不动) */
  hidden?: boolean;
}

/** 文件夹在管理器里的显示偏好(不改磁盘) */
export interface FolderPref {
  rootId: number;
  relDir: string;
  hidden: boolean;
  alias: string | null;
}

// ---------------------------------------------------------------- 用户自定义分类

/**
 * 用户自定义分类 —— 与"源文件夹树"是**两套并存**的机制。
 *
 * 参考项目 Aaalice NAI Launcher 用 `.gallery_categories.json` 存这类记录,
 * 字段为 {id, name, folderPath, parentId, sortOrder, imageCount}。
 * 本项目把它落进 SQLite,并额外支持下述两级语义:
 *
 *  - **虚拟分组**:不移动文件,可跨源文件夹自由组织(如把 anima/ 与 krea2/
 *    的图放进同一个"猫娘"集合)。
 *  - **映射到文件夹**:`folderPath` 非空时,该分类同时也是那个文件夹的入口,
 *    侧边栏点它等价于按该目录筛选。
 *
 * 关键点:**原图永远不动**。分类只是索引层的一条记录。
 */
export interface Category {
  id: number;
  name: string;
  /** 可选说明 */
  description: string | null;
  /** 父分类;null 为顶层。支持任意层嵌套 */
  parentId: number | null;
  /** 同级排序,升序 */
  sortOrder: number;
  /** 关联的源文件夹(相对所属 root);为空则是纯虚拟分组 */
  relDir: string | null;
  /** 该 relDir 属于哪个 root;为 null 时忽略 */
  rootId: number | null;
  /** 手动归入该分类的图片数(不含子分类) */
  directCount: number;
  /** 含所有子分类的图片数 */
  totalCount: number;
  createdAt: number;
  updatedAt: number;
}

/** 侧边栏用的分类树节点。 */
export interface CategoryNode extends Category {
  children: CategoryNode[];
}

/** 侧边栏统计汇总。 */
export interface LibraryStats {
  totalImages: number;
  totalBytes: number;
  bySource: Record<MetaSource, number>;
  /** 去重后的模型使用次数排行 */
  topModels: Array<{ name: string; count: number }>;
  topSamplers: Array<{ name: string; count: number }>;
  topLoras: Array<{ name: string; count: number }>;
  /** 时间跨度 */
  earliest: number | null;
  latest: number | null;
}

// ---------------------------------------------------------------- 索引进度

export type ScanPhase = 'idle' | 'walking' | 'hashing' | 'parsing' | 'thumbnails' | 'done' | 'error';

export interface ScanProgress {
  phase: ScanPhase;
  /** 已处理文件数 */
  processed: number;
  /** 本次扫描发现的总文件数(phase=walking 时可能还在增长) */
  total: number;
  /** 当前正在处理的文件路径 */
  currentFile: string | null;
  /** 已跳过的未变更文件数(增量扫描) */
  skipped: number;
  errors: number;
  startedAt: number;
  /** phase=done 时才有 */
  finishedAt: number | null;
  message: string | null;
  /** 本轮新解析入库的文件数(phase=done 时有效;空扫时前端可跳过列表刷新) */
  indexed?: number;
  /** 本轮清理掉的失效索引数(phase=done 时有效) */
  removed?: number;
}

// ---------------------------------------------------------------- IPC 通道

// ---------------------------------------------------------------- 应用设置

/** 持久化的应用设置。桌面端保存在 userData/settings.json。 */
export interface AppSettings {
  /** true:点窗口关闭按钮 = 缩小到托盘;false:直接退出应用 */
  closeToTray: boolean;
  /** 界面主题。主进程据此给无边框窗口的标题栏按钮区上色 */
  theme: 'dark' | 'light';
  /** 平面/兼容模式:关掉所有实时模糊与进场动画(显卡差或远程桌面时用) */
  reduceEffects: boolean;
  /** 自定义背景图(绝对路径);null = 用内置色雾 */
  backgroundImage: string | null;
  /** 背景铺法:裁切 cover / 拉伸 100%100% / 适应 contain / 平铺 repeat */
  backgroundFit: 'cover' | 'stretch' | 'contain' | 'tile';
  /**
   * 点开图片时,右侧详情面板怎么出现。
   *   squeeze —— 向内挤压:面板占住布局槽(0 ↔ 520px 宽度过渡),网格跟着让位、逐帧重排;
   *   overlay —— 向外延伸:面板从内容区右缘滑出(只动 transform)、浮在网格上,网格宽度不变、不重排。
   * 老配置里没有这个字段 → 走默认(overlay,即向外延伸)。
   */
  detailPanelMode: 'squeeze' | 'overlay';
  /**
   * 工作小窗(桌宠):开启后桌面上会有一个可拖动的小图标,
   * 点一下在图标上方弹出一个小工作窗,只上下翻动。
   */
  petEnabled: boolean;
  /** 小图标左上角在屏幕上的位置;null = 首次运行时自动放到右下角 */
  petPosition: { x: number; y: number } | null;
  /** 小图标边长(px) */
  petIconSize: number;
  /** 小窗的尺寸(px) */
  petPanelSize: { width: number; height: number };
  /**
   * 小窗是否"图片优先":列表里的图片左右交替、详情页整屏看图、不显示参数文字。
   * 想在小窗里看提示词/LoRA 时把它关掉,就会恢复带文字副标题的紧凑列表。
   */
  petImageFirst: boolean;
  /**
   * 小窗点击穿透:开启后小窗不拦截鼠标(桌面操作直接落到下面的窗口),
   * 悬停到小图标/面板区域时渲染层会临时恢复交互(借 forward 转发的 mousemove 判断)。
   */
  petClickThrough: boolean;
  /**
   * 上次在图库里浏览的文件夹(相对某个图库根)。
   * 主界面切换文件夹/分类时写入,小窗打开时直接进这一层,两边保持一致。
   */
  lastBrowseRelDir: string | null;
}

/**
 * 前端通过 window.api 调用这些方法。全部为 request/response 语义。
 * 通道名即方法名,返回值一律 { ok: true, data } 或 { ok: false, error }。
 */
export interface ApiSurface {
  // 库管理
  listRoots(): Promise<LibraryRoot[]>;
  addRoot(path: string, label?: string): Promise<LibraryRoot>;
  removeRoot(id: number): Promise<void>;
  setRootEnabled(id: number, enabled: boolean): Promise<void>;

  // 扫描
  startScan(rootIds?: number[], force?: boolean): Promise<{ started: boolean }>;
  cancelScan(): Promise<void>;
  getScanProgress(): Promise<ScanProgress>;
  /** 订阅扫描进度推送。返回取消订阅函数 */
  onScanProgress(cb: (p: ScanProgress) => void): () => void;

  // 浏览
  queryImages(query: ImageQuery): Promise<ImageQueryResult>;
  getImage(id: number): Promise<ImageDetail>;
  getImagesByIds(ids: number[]): Promise<ImageRecord[]>;
  getFolderTree(rootId?: number): Promise<FolderNode[]>;
  /** 文件夹显示偏好:别名 + 是否在左侧栏隐藏 */
  getFolderPrefs(): Promise<FolderPref[]>;
  setFolderPref(
    rootId: number,
    relDir: string,
    patch: { hidden?: boolean; alias?: string | null }
  ): Promise<FolderPref | null>;
  /** 弹系统目录选择框,返回绝对路径;取消返回 null */
  pickDirectory(): Promise<string | null>;
  /** 弹系统图片选择框,返回绝对路径;取消返回 null */
  pickImageFile(): Promise<string | null>;
  /**
   * **只解析**一个图片文件的元数据(拖进窗口时用),不入库、不复制、不改动原图。
   * 任何本地路径都能传,不需要属于任何图库根目录。
   */
  inspectFile(path: string): Promise<DroppedInspection>;
  /**
   * 取拖放进来的 File 对象的真实磁盘路径。
   * 新版 Electron 里 File.path 已经没了,必须走 webUtils.getPathForFile。
   * 非桌面环境返回 ''。
   */
  getPathForFile(file: File): string;
  /** 用系统浏览器打开外部链接(只允许 http/https) */
  openUrl(url: string): Promise<void>;
  /** 自绘标题栏按钮(窗口本身是无边框的) */
  windowMinimize(): Promise<void>;
  windowToggleMaximize(): Promise<void>;
  windowClose(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  /** 背景图的可直接加载 URL(带版本号,换图后自动失效缓存);没设背景返回 null */
  getBackgroundUrl(): Promise<string | null>;
  getStats(rootId?: number): Promise<LibraryStats>;
  /** 筛选面板用的候选值 */
  getFilterOptions(): Promise<{
    samplers: string[];
    models: string[];
    loras: string[];
    schedulers: string[];
    dirs: Array<{ rootId: number; relDir: string }>;
  }>;

  // 用户自定义分类(不移动文件,只是索引层的集合归属)
  getCategoryTree(): Promise<CategoryNode[]>;
  createCategory(input: {
    name: string;
    parentId?: number | null;
    /** 关联到某个源文件夹;省略则为纯虚拟分组 */
    relDir?: string | null;
    rootId?: number | null;
    description?: string | null;
  }): Promise<Category>;
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
  ): Promise<Category>;
  /** 删除分类。子分类按 deleteChildren 决定是一并删除还是上提 */
  deleteCategory(id: number, deleteChildren?: boolean): Promise<void>;
  /** 把图片加入/移出分类 */
  setCategoryMembers(categoryId: number, imageIds: number[], member: boolean): Promise<void>;
  /** 某张图所属的全部分类 id(详情面板显示"属于哪些分类") */
  getImageCategories(imageId: number): Promise<number[]>;

  // 操作
  setStarred(id: number, starred: boolean): Promise<void>;
  /** 在系统资源管理器里定位该文件 */
  revealInExplorer(id: number): Promise<void>;
  /**
   * 用资源管理器打开某个图库里的文件夹。
   * @param relDir 相对某个图库根的路径;'' 表示图库根目录本身。
   *   传绝对路径也可以(直接打开),左侧文件夹树用相对路径。
   */
  openFolder(relDir: string): Promise<void>;
  /** 用系统默认看图工具打开 */
  openExternal(id: number): Promise<void>;
  /** 复制一个绝对路径到剪贴板 */
  copyPath(id: number): Promise<void>;
  /** 删除图片:文件移入系统回收站,并从索引库移除 */
  deleteImage(id: number): Promise<void>;
  /**
   * 移动图片:弹出系统目录选择框,移动文件并更新索引。
   * 返回 null 表示用户取消;removedFromLibrary=true 表示目标在图库根之外,
   * 该图随之从索引库移除(下次扫描本来也找不到它了)。
   */
  moveImage(id: number): Promise<{ target: string; removedFromLibrary: boolean } | null>;
  /** 就地重命名文件(目录不变),返回更新后的索引行 */
  renameImage(id: number, newName: string): Promise<ImageRecord | null>;
  /** 把图片位图写进系统剪贴板,可直接粘贴到别处 */
  copyImageToClipboard(id: number): Promise<void>;
  /**
   * 把**去掉元数据**的位图写进剪贴板:图片像素完全一致,但所有
   * tEXt / iTXt / zTXt 块都被 Electron 重编码时丢掉。
   * 只进剪贴板,不产生新文件,也不改动原图。
   */
  copyImageWithoutMetadata(id: number): Promise<void>;
  /** 复制一份到指定文件夹(原图保留);用户取消返回 null */
  copyImageToFolder(id: number): Promise<{ copiedTo: string } | null>;
  /**
   * 批量复制到文件夹:只弹一次目录选择框,原图保留、索引不变。
   * targetDir 传了就跳过对话框(供批量操作与自动化验证用);
   * 同名文件跳过计入 skipped,用户取消时 target 为 null。
   */
  copyImagesToFolder(
    ids: number[],
    targetDir?: string
  ): Promise<{ copied: number; skipped: number; target: string | null; errors: string[] }>;
  /** 批量删除:全部移入回收站并清索引 */
  deleteImages(ids: number[]): Promise<{ deleted: number; errors: string[] }>;
  /**
   * 批量移动:只弹一次目录选择框。
   * targetDir 传了就跳过对话框(供批量操作与自动化验证用)。
   */
  moveImages(
    ids: number[],
    targetDir?: string
  ): Promise<{ moved: number; removedFromLibrary: number; target: string | null; errors: string[] }>;

  // 设置
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;

  // 缩略图
  /** 返回可直接塞进 <img src> 的 URL(file:// 或自定义协议) */
  getThumbUrl(id: number): string;
  /** 原图 URL:详情预览用(cam-file://file/<id>,只服务库内已索引的图) */
  getFileUrl(id: number): string;
  /** 复制任意文本到剪贴板(提示词复制按钮用) */
  copyText(text: string): Promise<void>;

  // ---- LoRA 配方(v0.8)
  // 不建表:每条配方存成 <userData>/recipes/<id>.recipe.json,与外部工具互通,
  // 未知字段 round-trip 保留(见 src/shared/recipes.ts)。
  /** 全部配方;解析失败的文件被跳过(主进程 console.warn) */
  listRecipes(): Promise<RecipeRecord[]>;
  /**
   * 新建/更新配方。无 id(或空串)时主进程生成 uuid 并补 created_date;
   * 每次保存都重算 fingerprint 与 modified。title 必填、loras 必须是数组。
   * file_path 指向 recipes 目录之外的图片时,会先拷贝成 recipes/<id><原扩展名> 再指向副本。
   */
  saveRecipe(recipe: RecipeRecord): Promise<RecipeRecord>;
  /** 删除配方;封面文件在 recipes 目录内时一并删除 */
  deleteRecipe(id: string): Promise<void>;
  /** 配方封面图 URL(cam-recipe://cover/<id>,纯前端拼接不走 IPC);无封面时协议返回 404 */
  recipeCoverUrl(id: string): string;
  /** 每个配方当前命中的图片数(子集匹配口径;主进程内有缓存,配方或索引变化后自动失效) */
  getRecipeStats(): Promise<RecipeStat[]>;

  // ---- 配方比对(v0.8)
  // 场景:同一个提示词换不同 LoRA 配方出图,然后横向比对效果。
  /**
   * 按提示词找"同类图",并按命中的配方分列展示用。
   *
   * @param imageId 基准图(取它的 pos_prompt 作参照)
   * @param similar false = 提示词完全相同(小写 + 收空白后全等);
   *                true  = 相似(≥ SIMILAR_THRESHOLD,见 src/shared/prompts.ts),按相似度降序
   * @param limit   最多返回多少张(默认 200)
   * 结果**永远包含基准图自己**(similarity = 1);基准图没有提示词时返回空数组。
   */
  findPromptPeers(imageId: number, similar: boolean, limit?: number): Promise<CompareRow[]>;
  /**
   * 取指定几张图作为一组比对行(多选批量条进入比对用)。
   * similarity 以 ids[0] 的提示词为基准;空数组返回空,最多取前 12 张。
   */
  getCompareRows(ids: number[]): Promise<CompareRow[]>;

  /**
   * 把图片**原文件**拖出到别的应用(ComfyUI / NovelAI 会直接读到 PNG 里的元数据)。
   * fire-and-forget(ipcRenderer.send):必须在 dragstart 的同步阶段发起,
   * 晚一个事件循环 Chromium 就不允许再启动原生拖拽了。
   * 主进程用 webContents.startDrag 拖磁盘原图;只支持单文件,多选时拖第一张。
   */
  dragOutImages(ids: number[]): void;

  // 应用
  getAppInfo(): Promise<{
    version: string;
    dbPath: string;
    /**
     * 缩略图缓存的目录名(放在每个图库根目录内部,不是绝对路径)。
     * 实际位置为 `<图库根>/<thumbDirName>/<相对路径>/<原名>.thumb.png`。
     */
    thumbDirName: string;
    /** 已索引的图库根目录及其缩略图缓存绝对路径 */
    roots: Array<{ id: number; path: string; thumbDir: string }>;
    /** 是否已设置开机自启 */
    autoLaunch: boolean;
  }>;
  setAutoLaunch(enabled: boolean): Promise<void>;
  quitApp(): Promise<void>;

  // ---- 工作小窗(桌宠)
  /** 小窗进程要的那一份设置(主题/是否开启/位置/尺寸) */
  getPetState(): Promise<{
    enabled: boolean;
    theme: 'dark' | 'light';
    iconSize: number;
    panelSize: { width: number; height: number };
    position: { x: number; y: number } | null;
    reduceEffects: boolean;
    /** 图片优先(左右交替大字图 / 整屏看图,不显示参数文字) */
    imageFirst: boolean;
    /** 点击穿透是否开启(渲染层据此决定要不要做悬停恢复交互) */
    clickThrough: boolean;
    /** 上次浏览的文件夹(与主界面一致);null = 还没选过 */
    lastRelDir: string | null;
  }>;
  /** 拖动后回写图标位置(主窗口下次打开小窗时沿用) */
  setPetPosition(position: { x: number; y: number }): Promise<void>;
  /** 小窗里改设置(图标大小 / 小窗尺寸) */
  setPetLayout(patch: { iconSize?: number; panelSize?: { width: number; height: number } }): Promise<void>;
  /** 小窗里点「打开主界面」:唤起主窗口 */
  focusMainWindow(): Promise<void>;
  /** 主窗口开关小窗后,通知所有窗口刷新状态 */
  onPetStateChanged(cb: () => void): () => void;
  /** 小窗自己调整窗口大小/位置(图标态 ↔ 展开态) */
  movePetWindow(bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
  /** 小窗请求关闭自己(退出小窗模式) */
  closePetWindow(): Promise<void>;
  /**
   * 点击穿透开启时,渲染层借 forward 转发的 mousemove 判断光标是否悬停在
   * 小图标/面板上:悬停时调 setPetIgnoreMouse(false) 临时恢复交互,移开再调
   * setPetIgnoreMouse(true) 恢复穿透。只在 petClickThrough 开启时有意义。
   */
  setPetIgnoreMouse(ignore: boolean): Promise<void>;
}
