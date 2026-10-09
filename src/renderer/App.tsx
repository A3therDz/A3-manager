/**
 * 主界面。
 *
 * 布局:顶部工具条(搜索 + 筛选 + 设置)/ 左侧栏(分类 + 文件夹)/ 中间网格 / 右侧详情。
 * 交互对齐已交付并视觉验证过的 web/index.html,另加:
 *   - 卡片右键菜单:打开 / 定位 / 复制正向提示词 / 复制路径 / 移动 / 删除
 *   - 设置面板:关闭行为(缩小到托盘 / 直接关闭)、主题(暗 / 亮),滑块带动画
 *
 * 颜色一律走 CSS 变量(见 main.tsx),支持暗 / 亮两套主题。
 * 契约真源是 src/shared/types.ts —— 不要改字段名或发明新 API。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CategoryNode, CompareRow, DetailTarget, DroppedInspection, FolderNode, ImageQuery, ImageRecord, LibraryRoot, RecipeRecord, RecipeStat, SortKey } from '@shared/types';
import { errMsg, useCategories, useFolders, useImageDetail, useImages, useScanProgress, useStats } from './api';
import { CategoryTree, FolderTree, FolderVisibilityTree, RecipeTree } from './components/Trees';
import { ImageGrid } from './components/ImageGrid';
import { DetailPanel } from './components/DetailPanel';
import { CategoryPicker } from './components/CategoryPicker';
import { Lightbox } from './components/Lightbox';
import { ComparePanel } from './components/ComparePanel';
import { CompareStage } from './components/CompareStage';
import { RecipeManager, type RecipeDraftLora } from './components/RecipeManager';
import { endImageDrag, hasImageDragData, isInternalImageDrag } from './dnd';
import { prefersReducedMotion, useDelayedClose } from './useDelayedClose';

/** 设置面板里的滑动开关:左选项 / 右选项,滑块平滑移动 */
function SlideSwitch({
  leftLabel,
  rightLabel,
  /** false = 选中左侧 */
  value,
  onChange,
}: {
  leftLabel: string;
  rightLabel: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`cam-switch${value ? ' right' : ''}`}
      onClick={() => onChange(!value)}
    >
      <span className="cam-switch-thumb" />
      <span className={`cam-switch-opt${value ? '' : ' on'}`}>{leftLabel}</span>
      <span className={`cam-switch-opt${value ? ' on' : ''}`}>{rightLabel}</span>
    </button>
  );
}

/** 刷新:环形箭头 */
function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** 更多:三个点 */
function MoreIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="12" cy="19" r="1.7" />
    </svg>
  );
}

/** 重置:反向回退箭头 */
function ResetIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 3v6h6" />
    </svg>
  );
}

/** 收藏:星形(filled = 实心,用于"正在筛选收藏"的状态) */
function StarIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3.6l2.6 5.3 5.9.85-4.25 4.14 1 5.86L12 17l-5.25 2.75 1-5.86L3.5 9.75l5.9-.85z" />
    </svg>
  );
}

/** 配方:书本图标(LoRA 配方管理入口) */
function RecipeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

/** 眼睛:隐藏预览区(隐私模式)开关 */
function EyeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

/** 按模型筛选:取景标签 */
function ModelIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7.5V5a2 2 0 0 1 2-2h2.5" />
      <path d="M16.5 3H19a2 2 0 0 1 2 2v2.5" />
      <path d="M21 16.5V19a2 2 0 0 1-2 2h-2.5" />
      <path d="M7.5 21H5a2 2 0 0 1-2-2v-2.5" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
}

/** 排序:双向箭头 */
function SortIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 4v16" />
      <path d="M4 7l3-3 3 3" />
      <path d="M17 20V4" />
      <path d="M14 17l3 3 3-3" />
    </svg>
  );
}

/**
 * 浮层的"有始有终"卸载(useDelayedClose)已抽到 ./useDelayedClose,
 * 本文件与 DetailPanel 里的弹层共用同一套。
 */

/** 浮层锚点:右键的点击坐标,或「更多」按钮的右下角 */
interface MenuAnchor {
  x: number;
  y: number;
}

/** 测量后的落点:flip = 下方放不下、菜单翻到锚点上方(动画原点也要跟着换) */
interface AnchoredPos {
  left: number;
  top: number;
  flip: boolean;
}

/**
 * 浮层的"渲染后测量"定位:右键菜单与「更多」浮层共用。
 *
 * 打开时先按锚点坐标渲染(visibility:hidden,由调用方在 pos 为 null 时加上),
 * useLayoutEffect 在**绘制前**读真实 offsetWidth/offsetHeight,再算最终位置:
 *   - 右方不足 → 贴右边缘内收 8px(align:'right' 时先按锚点右对齐);
 *   - 下方不足 → 向上翻转(top = 锚点 y - 菜单高);上方也放不下就贴底边;
 *   - 极端小窗口由 .cam-menu 的 max-height 兜底(量到的高度已是钳过的)。
 * 菜单项增删不用再改任何写死的钳位值。
 * 隐藏帧永远不会被绘制(layoutEffect + setState 在同一帧内同步完成),用户看不到闪烁。
 */
function useAnchoredMenuPos(
  anchor: MenuAnchor | null,
  ref: React.RefObject<HTMLDivElement | null>,
  align: 'left' | 'right' = 'left'
): AnchoredPos | null {
  const [pos, setPos] = useState<AnchoredPos | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!anchor || !el) {
      setPos(null);
      return;
    }
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left =
      align === 'right'
        ? Math.max(8, Math.min(anchor.x - w, window.innerWidth - w - 8))
        : Math.max(8, Math.min(anchor.x, window.innerWidth - w - 8));
    // 下方放不下才考虑翻转;翻转后仍然贴不下(上方更窄)就退回贴底边
    const overflow = anchor.y + h > window.innerHeight - 8;
    const flip = overflow && anchor.y - h >= 8;
    const top = flip ? anchor.y - h : Math.min(anchor.y, Math.max(8, window.innerHeight - h - 8));
    setPos((cur) => (cur && cur.left === left && cur.top === top && cur.flip === flip ? cur : { left, top, flip }));
  }, [anchor, ref, align]);
  return pos;
}

/** 探测是否在用软件渲染(SwiftShader / Basic Render 之类)——这种环境下不要开实时模糊 */
function detectSoftwareRenderer(): boolean {
  try {
    const t0 = performance.now();
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') as WebGLRenderingContext | null;
    const cost = performance.now() - t0;
    // 连创建上下文都很慢 → 这台机器基本可以当弱显卡处理
    if (cost > 250) return true;
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    return /swiftshader|software|llvmpipe|basic render|microsoft basic/i.test(renderer);
  } catch {
    return false;
  }
}

/** 空选择集:常量复用,避免每次渲染都 new 一个(也方便比较) */
const EMPTY_SELECTION: ReadonlySet<number> = new Set<number>();

/** 详情面板宽度(与 DetailPanel 根节点一致),槽位动画围绕它做 */
const DETAIL_W = 520;

/**
 * 详情面板的"布局槽"。
 *
 * 面板本身固定 520px 宽,槽位负责 0 ↔ 520 的**宽度过渡**:
 * 打开时槽位从 0 撑开(面板从右缘滑入),关闭时收回去 ——
 * 左侧瀑布流网格随槽位宽度逐帧重排,不再"瞬间让位"。
 * 进场要用两拍 rAF:先以 0 宽挂载一帧,再展开,CSS transition 才有机会播。
 */
function DetailSlot({ closing, children }: { closing: boolean; children: React.ReactNode }) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);
  const width = !entered || closing ? 0 : DETAIL_W;
  return (
    <div className={`cam-detail-slot${closing ? ' closing' : ''}`} style={{ width }}>
      {children}
    </div>
  );
}

/** 作者与仓库:想换成自己的仓库地址,只改这两行 */
const AUTHOR_NAME = 'A3ther';
const REPO_URL = 'https://github.com/A3therDz/A3-manager';

/** 背景铺法:裁切 / 拉伸 / 适应 / 平铺 */
const BG_FIT = {
  cover: { label: '裁切', size: 'cover', repeat: 'no-repeat', position: 'center' },
  stretch: { label: '拉伸', size: '100% 100%', repeat: 'no-repeat', position: 'center' },
  contain: { label: '适应', size: 'contain', repeat: 'no-repeat', position: 'center' },
  tile: { label: '平铺', size: 'auto', repeat: 'repeat', position: 'left top' },
} as const;
type BgFit = keyof typeof BG_FIT;

// ---------------------------------------------------------------- 标签页
//
// 浏览器式标签页:每个标签是一套独立的浏览视图(文件夹/分类/搜索/模型/收藏/排序),
// 切换时各自恢复查询、已加载范围、滚动位置与打开的详情。
// 只持久化"查询 + 激活的是哪个"(localStorage),滚动位置与详情只留在会话里。

interface BrowseTab {
  id: number;
  query: ImageQuery;
  /** 会话内恢复用:上次滚动到的位置与已加载条数(整段拉回,不用一页页追) */
  scrollTop: number;
  loadedCount: number;
  /** 该标签打开的详情(切走时记住,切回来直接恢复) */
  selectedId: number | null;
}

const TABS_STORAGE_KEY = 'cam-tabs-v1';

/**
 * 标签宽度(浏览器式):
 * 单个标签最多这么宽,标签多了(挤不下)再按可用宽度平分一起变窄。
 * 下限 46px —— 到那时标题已经只剩一两个字符,再窄就看不出是什么了。
 */
const TAB_W_MAX = 248;
const TAB_W_MIN = 46;
/**
 * 标签栏里除标签之外的固定开销:左右内边距 + 标签间距 + 「+」按钮。
 *
 * 末尾的 +20 是安全余量。浏览器对 flex 子项的布局宽度会做亚像素取整,
 * 10 个标签累积下来能有十几像素的误差;不留余量就会出现
 * 「算出来的宽度刚好差一点 → 标签栏一直有一条横向滚动条」(实测踩到过)。
 * 宁可少给一点像素,也不要出现滚动条。
 */
const TABBAR_CHROME = 24 + 4 + 30 + 20;

interface SavedTabs {
  tabs: BrowseTab[];
  activeId: number;
  maxId: number;
}

/** 从 localStorage 读上次会话的标签页;数据坏了就当没有 */
function loadSavedTabs(): SavedTabs | null {
  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { activeId?: number; tabs?: Array<{ query?: ImageQuery }> };
    if (!Array.isArray(parsed.tabs) || parsed.tabs.length === 0) return null;
    const tabs: BrowseTab[] = parsed.tabs.map((t, i) => ({
      id: i + 1,
      query: t.query && typeof t.query === 'object' ? { ...t.query } : { sort: 'mtime_desc' },
      scrollTop: 0,
      loadedCount: 0,
      selectedId: null,
    }));
    const activeId = typeof parsed.activeId === 'number' && tabs.some((t) => t.id === parsed.activeId)
      ? (parsed.activeId as number)
      : tabs[0].id;
    return { tabs, activeId, maxId: tabs.length };
  } catch {
    return null;
  }
}

/** 分类 id → 名字(标签标题用) */
function catNameById(list: CategoryNode[], id: number): string | null {
  for (const n of list) {
    if (n.id === id) return n.name;
    const hit = catNameById(n.children || [], id);
    if (hit) return hit;
  }
  return null;
}

/** 标签标题:当前视图的一句话概括(配方/文件夹/分类 + 搜索词 + 模型 + 收藏) */
function tabTitle(q: ImageQuery, cats: CategoryNode[], recipes: RecipeRecord[]): string {
  const parts: string[] = [];
  if (q.recipeId) parts.push(recipes.find((r) => r.id === q.recipeId)?.title ?? '配方');
  if (q.categoryId !== undefined) parts.push(catNameById(cats, q.categoryId) ?? '分类');
  else if (q.relDir) parts.push(q.relDir.split(/[\\/]/).filter(Boolean).pop() ?? q.relDir);
  if (q.q && q.q.trim()) parts.push(`“${q.q.trim()}”`);
  if (q.modelName) parts.push(q.modelName);
  if (q.starredOnly) parts.push('收藏');
  return parts.length ? parts.join(' · ') : '全部';
}

export function App() {
  // 标签页:先从 localStorage 恢复上次的布局(决定 useImages 的初始查询)
  const savedTabs = useMemo(() => loadSavedTabs(), []);
  const folders = useFolders();
  const categories = useCategories();
  const stats = useStats();
  const progress = useScanProgress();
  const { query, setQuery, rows, total, loading, error, tookMs, hasMore, loadMore, refresh, restore, patchRow, removeRow } = useImages(
    120,
    savedTabs ? savedTabs.tabs.find((t) => t.id === savedTabs.activeId)?.query : undefined
  );

  const [tabs, setTabs] = useState<BrowseTab[]>(
    () => savedTabs?.tabs ?? [{ id: 1, query: { sort: 'mtime_desc' }, scrollTop: 0, loadedCount: 0, selectedId: null }]
  );
  const [activeTabId, setActiveTabId] = useState<number>(savedTabs?.activeId ?? 1);
  /**
   * 标签宽度(px)。浏览器式行为(v0.6 需求 4):
   * 每个标签**一律这个宽度**(不管标题多长多短),直到标签多到把标签栏撑满,
   * 才开始一起变窄 —— 以前是 max-width:190px,"全部"这种两个字标签就只有 60px。
   */
  const tabbarRef = useRef<HTMLElement | null>(null);
  const [tabW, setTabW] = useState(TAB_W_MAX);
  /** 标签 id 发号器(从恢复出来的最大值继续,不重用) */
  const tabSeqRef = useRef(savedTabs?.maxId ?? 1);
  /** tabs 的实时副本:事件回调里要读"此刻"的标签列表 */
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  /** 切标签后要恢复的滚动位置(null = 不用恢复) */
  const pendingScrollRef = useRef<number | null>(null);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const detail = useImageDetail(selectedId);

  // 全屏原图查看器(v0.8):双击网格卡片 / 详情预览图打开。
  // 开/关状态放这里,翻页直接复用当前标签页已加载的 rows;
  // Esc 链里它优先级最高(先关查看器,不关详情)。
  const { value: lightboxId, closing: lightboxClosing, open: openLightbox, close: closeLightbox } = useDelayedClose<number>();

  // 轻提示(收藏/分类/文件操作的结果反馈):展示 2200ms 后先播退场动画,再卸载
  const { value: toast, closing: toastClosing, open: openToast, close: closeToast } = useDelayedClose<{ msg: string; bad: boolean }>();
  const toastTimer = useRef(0);
  const notify = useCallback((msg: string, bad = false) => {
    openToast({ msg, bad });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(closeToast, 2200);
  }, [openToast, closeToast]);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  /**
   * 查看器的行来源:默认是"当前标签页已加载列表"(翻页范围)。
   * 从配方比对的某一列打开时,换成那一列的图 —— 这样在列内也能左右翻页,
   * 而不是翻到整个标签页里去(两边混着翻会看不出比对的是哪几列)。
   */
  const [lightboxRows, setLightboxRows] = useState<ImageRecord[] | null>(null);
  const openLightboxInList = useCallback(
    (id: number) => {
      setLightboxRows(null);
      openLightbox(id);
    },
    [openLightbox]
  );
  /** 从比对面板的一列打开查看器:先取那一列的完整行(查看器要用 fileName/relPath 等) */
  const openLightboxInColumn = useCallback(
    (ids: number[], id: number) => {
      window.api
        .getImagesByIds(ids)
        .then((recs) => {
          const clean = recs.filter(Boolean) as ImageRecord[];
          if (clean.length === 0) return;
          setLightboxRows(clean);
          openLightbox(id);
        })
        .catch((e) => notify(errMsg(e), true));
    },
    [openLightbox, notify]
  );
  const lbRows = lightboxRows && lightboxRows.some((r) => r.id === lightboxId) ? lightboxRows : rows;

  // ---- 设置:主题(暗/亮) + 关闭行为(缩小到托盘/直接关闭)
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('cam-theme', theme);
    // 同步给主进程:无边框窗口的标题栏按钮配色要跟着主题走
    window.api.setSettings({ theme }).catch(() => undefined);
  }, [theme]);


  // ---- B1:图库目录 + 文件夹显示偏好
  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const { value: folderMenu, closing: folderMenuClosing, open: openFolderMenu, close: closeFolderMenu } = useDelayedClose<{ x: number; y: number; node: FolderNode }>();
  /** 窄窗口时收进「更多」菜单的次要操作 */
  const { value: moreMenu, closing: moreMenuClosing, close: closeMoreMenu, toggle: toggleMoreMenuValue } = useDelayedClose<{ x: number; y: number }>();
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  // 渲染后测量定位:与卡片右键菜单共用同一套逻辑(右对齐按钮 + 下方不足向上翻转)
  const moreMenuPos = useAnchoredMenuPos(moreMenu, moreMenuRef, 'right');
  // 备注弹层:关闭时先播退场动画,再卸载
  const { value: aliasTarget, closing: aliasClosing, open: openAlias, close: closeAlias } = useDelayedClose<FolderNode>();
  // 移除图库是破坏性操作(索引会级联删除),必须二次确认
  const { value: removeRootTarget, closing: removeRootClosing, open: openRemoveRoot, close: closeRemoveRoot } = useDelayedClose<LibraryRoot>();
  const [aliasValue, setAliasValue] = useState('');

  const { value: settingsOpen, closing: settingsClosing, open: openSettings, close: closeSettings } = useDelayedClose<true>();

  // ---- LoRA 配方(v0.8):顶层加载一次,详情面板的分组显示与配方管理弹层共用
  const [recipes, setRecipes] = useState<RecipeRecord[]>([]);
  /** 每个配方命中的图片数(左侧「配方」小节的数量胶囊) */
  const [recipeStats, setRecipeStats] = useState<RecipeStat[]>([]);
  const reloadRecipeStats = useCallback(() => {
    window.api.getRecipeStats().then(setRecipeStats).catch(() => undefined);
  }, []);
  const reloadRecipes = useCallback(() => {
    window.api.listRecipes().then(setRecipes).catch(() => undefined);
    reloadRecipeStats();
  }, [reloadRecipeStats]);
  useEffect(() => {
    reloadRecipes();
  }, [reloadRecipes]);
  // 配方管理弹层;initialLoras 非空时直接进新建表单(详情面板「存为配方」)
  const { value: recipeModal, closing: recipeClosing, open: openRecipeModal, close: closeRecipeModal } =
    useDelayedClose<{ initialLoras?: RecipeDraftLora[] }>();

  // ---- 配方比对(v0.8):两个入口,共用同一个面板
  //   ① 详情面板 LoRA 区「配方比对」→ findPromptPeers(按提示词找同类图,可切精确/相似)
  //   ② 多选批量条「比对」→ getCompareRows(把选中的几张当一组,没有模式切换)
  const { value: compareReq, closing: compareClosing, open: openCompareModal, close: closeCompareModal } =
    useDelayedClose<{ baseId: number; baseName: string; basePrompt: string; canSwitch: boolean; count: number }>();
  const { value: compareStageRows, closing: compareStageClosing, open: openCompareStage, close: closeCompareStage } =
    useDelayedClose<CompareRow[]>();
  const [compareRows, setCompareRows] = useState<CompareRow[]>([]);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  /** 相似模式开关(只在 fromDetail 时可见) */
  const [compareMode, setCompareMode] = useState<'exact' | 'similar'>('exact');
  /** 请求序号:切模式/换基准图时丢弃过期响应(慢的那次不能盖掉新的) */
  const compareSeqRef = useRef(0);

  /** 按提示词找同类图(精确 / 相似) */
  const loadComparePeers = useCallback((baseId: number, mode: 'exact' | 'similar') => {
    const seq = ++compareSeqRef.current;
    setCompareLoading(true);
    setCompareError(null);
    window.api
      .findPromptPeers(baseId, mode === 'similar')
      .then((rs) => {
        if (seq === compareSeqRef.current) setCompareRows(rs);
      })
      .catch((e) => {
        if (seq === compareSeqRef.current) {
          setCompareRows([]);
          setCompareError(errMsg(e));
        }
      })
      .finally(() => {
        if (seq === compareSeqRef.current) setCompareLoading(false);
      });
  }, []);

  /** ① 详情面板进入:基准图的提示词从已加载的详情里取(空提示词要给出专门文案) */
  const openCompareFromDetail = useCallback(
    (imageId: number) => {
      const info = detail.detail.data && detail.detail.data.id === imageId ? detail.detail.data : null;
      const prompt = info?.meta?.prompts?.find((p) => p.role === 'positive')?.text ?? '';
      const name = info?.fileName ?? rows.find((r) => r.id === imageId)?.fileName ?? '';
      setCompareMode('exact');
      setCompareRows([]);
      openCompareModal({ baseId: imageId, baseName: name, basePrompt: prompt, canSwitch: true, count: 0 });
      if (prompt.trim() === '') {
        compareSeqRef.current++; // 没有提示词:不发请求,只给空态文案
        setCompareLoading(false);
        setCompareError(null);
        return;
      }
      loadComparePeers(imageId, 'exact');
    },
    [detail.detail.data, rows, openCompareModal, loadComparePeers]
  );

  const switchCompareMode = useCallback(
    (m: 'exact' | 'similar') => {
      if (!compareReq || m === compareMode) return;
      setCompareMode(m);
      loadComparePeers(compareReq.baseId, m);
    },
    [compareReq, compareMode, loadComparePeers]
  );

  const closeCompareAll = useCallback(() => {
    closeCompareStage();
    closeCompareModal();
  }, [closeCompareStage, closeCompareModal]);

  const [closeToTray, setCloseToTray] = useState(true);
  // 平面模式:关掉实时模糊与进场动画(显卡弱 / 远程桌面时用)
  const [reduceEffects, setReduceEffects] = useState(false);
  /** 工作小窗(桌宠):桌面上放一个小图标,点开是个只有一条竖列的小工作窗 */
  const [petEnabled, setPetEnabledState] = useState(false);
  /** 小窗是否图片优先(列表左右交替、详情整屏看图、不显示参数文字) */
  const [petImageFirst, setPetImageFirst] = useState(true);
  /** 小窗点击穿透:不拦鼠标,悬停小图标/面板时临时恢复交互 */
  const [petClickThrough, setPetClickThrough] = useState(false);
  /** 设置是否已经从主进程读回来(决定"恢复上次浏览位置"能不能执行) */
  const [settingsReady, setSettingsReady] = useState(false);
  /** 上次浏览的文件夹:主窗口启动时恢复,之后由切换动作维护 */
  const lastRelDirRef = useRef<string | null>(null);
  // 自定义背景图:URL 由主进程给(cam-bg:// 协议),铺法存设置
  const [bgUrl, setBgUrl] = useState<string | null>(null);
  const [bgFit, setBgFit] = useState<BgFit>('cover');
  // 眼睛开关:隐藏预览区,网格区变成磨砂玻璃(透出背景图)。会话级,不落盘。
  const [zen, setZen] = useState(false);
  // 网格缩放(Ctrl+滚轮):调整瀑布流列宽基准,1 = 默认
  const [gridZoom, setGridZoom] = useState(() => {
    const v = Number(localStorage.getItem('cam-grid-zoom'));
    return v >= 0.5 && v <= 3 ? v : 1;
  });
  const [bgName, setBgName] = useState<string>('');
  const [winMaximized, setWinMaximized] = useState(false);
  // 探测放到首屏之后再做:创建 WebGL 上下文本身在坏显卡上会卡,不能挡首屏
  const [autoLite, setAutoLite] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setAutoLite(detectSoftwareRenderer()), 1200);
    return () => window.clearTimeout(id);
  }, []);
  useEffect(() => {
    // 手动开关或"检测到软件渲染"任一成立就进平面模式
    document.documentElement.dataset.lite = reduceEffects || autoLite ? '1' : '0';
    if (autoLite && !reduceEffects) console.log('[ui] 检测到软件渲染,已自动使用平面模式');
  }, [reduceEffects, autoLite]);

  // 自绘标题栏:窗口尺寸变化时同步"最大化/还原"图标
  useEffect(() => {
    const sync = () => window.api.isWindowMaximized().then(setWinMaximized).catch(() => undefined);
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  /** 刷新:原地重读当前已加载范围(新入库的图立刻出现,**列表不跳回顶部**),同时刷新统计与文件夹树 */
  const refreshList = useCallback(() => {
    void refresh();
    stats.reload();
    folders.reload();
    categories.reload();
    notify('已刷新');
  }, [categories, folders, notify, refresh, stats]);

  const applyBgFit = useCallback((fit: BgFit) => {
    setBgFit(fit);
    window.api.setSettings({ backgroundFit: fit }).catch(() => undefined);
  }, []);

  const chooseBackground = useCallback(async () => {
    try {
      const file = await window.api.pickImageFile();
      if (!file) return;
      await window.api.setSettings({ backgroundImage: file });
      setBgName(file.split(/[\\/]/).pop() ?? '');
      setBgUrl(await window.api.getBackgroundUrl());
      notify('背景已更新');
    } catch (e) {
      notify(errMsg(e), true);
    }
  }, [notify]);

  const clearBackground = useCallback(async () => {
    try {
      await window.api.setSettings({ backgroundImage: null });
      setBgUrl(null);
      setBgName('');
      notify('已恢复内置背景');
    } catch (e) {
      notify(errMsg(e), true);
    }
  }, [notify]);

  const applyReduceEffects = useCallback(
    (v: boolean) => {
      const wasAuto = autoLite;
      setReduceEffects(v);
      // 手动选择之后就以用户为准:否则软件渲染的自动判定会一直把开关压回"平面",
      // 表现就是"点了磨砂、提示也弹了,但画面没变"。
      setAutoLite(false);
      window.api
        .setSettings({ reduceEffects: v })
        .then(() =>
          notify(
            v
              ? '已切到平面模式(关闭实时模糊)'
              : wasAuto
                ? '已切到磨砂效果 —— 若明显卡顿,再切回平面即可'
                : '已恢复磨砂效果'
          )
        )
        .catch(() => undefined);
    },
    [autoLite, notify]
  );

  useEffect(() => {
    window.api
      .getSettings()
      .then((s) => {
        setCloseToTray(s.closeToTray);
        setPetEnabledState(s.petEnabled === true);
        setPetImageFirst(s.petImageFirst !== false);
        setPetClickThrough(s.petClickThrough === true);
        lastRelDirRef.current = s.lastBrowseRelDir ?? null;
        setReduceEffects(s.reduceEffects === true);
        if (s.theme === 'light' || s.theme === 'dark') setTheme(s.theme);
        if (s.backgroundFit) setBgFit(s.backgroundFit as BgFit);
        if (s.backgroundImage) setBgName(s.backgroundImage.split(/[\\/]/).pop() ?? '');
        window.api.getBackgroundUrl().then(setBgUrl).catch(() => undefined);
        setSettingsReady(true);
      })
      .catch(() => undefined);
  }, []);
  const reloadRoots = useCallback(() => {
    window.api.listRoots().then(setRoots).catch(() => undefined);
  }, []);
  useEffect(() => {
    reloadRoots();
  }, [reloadRoots]);

  /** 添加图库目录:系统目录选择框 -> 入库 -> 立刻扫一次 */
  const addLibraryRoot = useCallback(async () => {
    try {
      const dir = await window.api.pickDirectory();
      if (!dir) return;
      const created = await window.api.addRoot(dir);
      notify('已添加图库:' + created.label);
      reloadRoots();
      folders.reload();
      if (created && created.id) void window.api.startScan([created.id]);
    } catch (e) {
      notify(errMsg(e), true);
    }
  }, [folders, notify, reloadRoots]);

  const removeLibraryRoot = useCallback(
    async (id: number, label: string) => {
      try {
        await window.api.removeRoot(id);
        notify('已移除图库:' + label);
        reloadRoots();
        folders.reload();
        stats.reload();
        setQuery((q) => ({ ...q }));
      } catch (e) {
        notify(errMsg(e), true);
      }
    },
    [folders, notify, reloadRoots, setQuery, stats]
  );

  const rescanRoot = useCallback(
    async (id: number, label: string) => {
      try {
        await window.api.startScan([id]);
        notify('已开始重新扫描:' + label);
      } catch (e) {
        notify(errMsg(e), true);
      }
    },
    [notify]
  );

  const toggleRootEnabled = useCallback(
    async (id: number, enabled: boolean) => {
      try {
        await window.api.setRootEnabled(id, enabled);
        reloadRoots();
        folders.reload();
        setQuery((q) => ({ ...q }));
      } catch (e) {
        notify(errMsg(e), true);
      }
    },
    [folders, notify, reloadRoots, setQuery]
  );

  /** 左侧文件夹:勾选状态(hidden)与备注(alias),只改管理器显示 */
  const toggleFolderHidden = useCallback(
    async (rootId: number, relDir: string, hidden: boolean) => {
      try {
        await window.api.setFolderPref(rootId, relDir, { hidden });
        folders.reload();
        notify(hidden ? '已从左侧栏隐藏' : '已恢复到左侧栏');
      } catch (e) {
        notify(errMsg(e), true);
      }
    },
    [folders, notify]
  );

  const applyFolderAlias = useCallback(
    async (rootId: number, relDir: string, alias: string) => {
      try {
        await window.api.setFolderPref(rootId, relDir, { alias });
        folders.reload();
        notify(alias.trim() ? '备注已保存(磁盘目录名不变)' : '已清除备注');
      } catch (e) {
        notify(errMsg(e), true);
      }
    },
    [folders, notify]
  );

  const applyPetEnabled = useCallback(
    (v: boolean) => {
      setPetEnabledState(v);
      window.api
        .setSettings({ petEnabled: v })
        .then(() => notify(v ? '工作小窗已开启,桌面上会出现小图标' : '工作小窗已关闭'))
        .catch((e) => notify(errMsg(e), true));
    },
    [notify]
  );

  const applyPetImageFirst = useCallback(
    (v: boolean) => {
      setPetImageFirst(v);
      window.api
        .setSettings({ petImageFirst: v })
        .then(() => notify(v ? '小窗以图片为主' : '小窗显示文字'))
        .catch((e) => notify(errMsg(e), true));
    },
    [notify]
  );

  const applyPetClickThrough = useCallback(
    (v: boolean) => {
      setPetClickThrough(v);
      window.api
        .setSettings({ petClickThrough: v })
        .then(() => notify(v ? '点击穿透已开启(悬停小图标可临时恢复交互)' : '点击穿透已关闭'))
        .catch((e) => notify(errMsg(e), true));
    },
    [notify]
  );

  const applyCloseToTray = useCallback(
    (v: boolean) => {
      setCloseToTray(v);
      window.api
        .setSettings({ closeToTray: v })
        .then(() => notify(v ? '关闭窗口时将缩小到托盘' : '关闭窗口时将直接退出'))
        .catch((e) => notify(errMsg(e), true));
    },
    [notify]
  );

  // ---- 窄窗口「更多」浮层:Esc / 点空白 / 改窗口大小 / 滚动都会关掉
  useEffect(() => {
    if (!moreMenu) return;
    const close = () => closeMoreMenu();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMoreMenu();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    document.getElementById('cam-scroll')?.addEventListener('scroll', close, { passive: true });
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      document.getElementById('cam-scroll')?.removeEventListener('scroll', close);
    };
  }, [moreMenu]);

  /** 打开/关闭「更多」浮层:锚点定在按钮右下角,最终位置由 useAnchoredMenuPos 测量后算出 */
  const toggleMoreMenu = useCallback(() => {
    if (moreMenu) {
      closeMoreMenu();
      return;
    }
    const r = moreBtnRef.current?.getBoundingClientRect();
    if (!r) return;
    toggleMoreMenuValue({ x: r.right, y: r.bottom + 6 });
  }, [moreMenu, closeMoreMenu, toggleMoreMenuValue]);

  /**
   * 「收藏」筛选的开关。
   *
   * 关键点(用户反馈):切换时必须**保留**当前正在看的位置 ——
   * 文件夹 / 分类 / 搜索词 / 模型 / 排序都原样留着,只把 starredOnly 拨一下。
   * 之前的实现虽然也保留了这些字段,但切换后不重置滚动位置,
   * 用户会停在列表中间,看起来像"被丢到了别的页面"。
   */
  /**
   * 记住"上次浏览的文件夹",写进设置。
   *
   * 为什么要持久化:工作小窗(桌宠)打开时要直接进这一层,
   * 两个窗口的"当前位置"保持一致 —— 用户在小窗里看到的应该是主界面正在看的东西。
   */
  /**
   * 上次浏览的位置(文件夹)在两个窗口之间共享:
   *   - 启动时:**读**出来恢复,主窗口与小窗都从这一层开始;
   *   - 之后用户切换文件夹时:**写**回去。
   * 顺序很重要 —— 先恢复再写,否则启动时会把上次的位置覆盖成"根目录"。
   */
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    if (!settingsReady) return;
    restoredRef.current = true;
    // 恢复出了上次的标签页布局时,位置已经由各标签自己的 query 表达,
    // 不再用旧的全局"上次浏览文件夹"覆盖
    if (savedTabs) return;
    const last = lastRelDirRef.current;
    if (last) setQuery((q) => (q.relDir === undefined ? { ...q, relDir: last } : q));
  }, [settingsReady, savedTabs]);

  useEffect(() => {
    // 恢复完成前不写,避免"还没读就先覆盖"
    if (!restoredRef.current) return;
    // 正在浏览分类时不动这条记忆
    if (query.categoryId) return;
    // 用 null 表示图库根目录(空字符串在 JSON 里会丢语义)
    const rel = query.relDir ? query.relDir : null;
    window.api.setSettings({ lastBrowseRelDir: rel }).catch(() => undefined);
  }, [query.relDir, query.categoryId]);

  const toggleStarredOnly = useCallback(() => {
    setQuery((q) => (q.starredOnly ? { ...q, starredOnly: undefined } : { ...q, starredOnly: true }));
    // 结果集换了内容,回到列表顶部才符合"进入某个视图"的直觉
    requestAnimationFrame(() => {
      const el = document.getElementById('cam-scroll');
      if (el) el.scrollTop = 0;
    });
  }, []);

  // ---- C2 多选:勾选框 / Ctrl+点击 / Shift+点击(选一段)
  // 批量操作条:清空选择时先播退场动画再隐藏
  const { value: selectedIdsState, closing: selectBarClosing, open: openSelection, close: closeSelection } = useDelayedClose<Set<number>>();
  // 延迟卸载期间 selectedIdsState 仍持有"上一次的那一批";对外统一成非空集合
  const selectedIds = selectedIdsState ?? EMPTY_SELECTION;
  /**
   * 多选模式:工具条「多选」开关打开后,单击卡片 = 切换选中(不再开详情),
   * 勾选框常显,批量条常驻。Esc 或关闭开关退出,退出时清空选择。
   */
  const [selectMode, setSelectMode] = useState(false);
  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    closeSelection();
  }, [closeSelection]);
  const { value: confirmBatchDelete, closing: confirmBatchDeleteClosing, open: openConfirmBatchDelete, close: closeConfirmBatchDelete } = useDelayedClose<true>();
  /** 「加入/移出分类」弹层:目标图片(单图或整批多选)+ 指派模式的预勾选(取所有图所属分类的交集) */
  const { value: catPicker, closing: catPickerClosing, open: openCatPicker, close: closeCatPicker } = useDelayedClose<{ ids: number[]; initialChecked?: number[] }>();
  const anchorRef = useRef<number | null>(null);
  const handleSelect = useCallback(
    (id: number, mode: 'toggle' | 'range') => {
      const next = new Set(selectedIds);
      if (mode === 'toggle') {
        if (next.has(id)) next.delete(id);
        else next.add(id);
        anchorRef.current = id;
      } else {
        const order = rows.map((r) => r.id);
        const to = order.indexOf(id);
        const fromIdx = anchorRef.current === null ? to : order.indexOf(anchorRef.current);
        if (to >= 0 && fromIdx >= 0) {
          const [a, b] = fromIdx <= to ? [fromIdx, to] : [to, fromIdx];
          for (let i = a; i <= b; i++) next.add(order[i]);
        } else {
          next.add(id);
        }
      }
      openSelection(next);
    },
    [rows, selectedIds, openSelection]
  );

  /**
   * ② 配方比对的第二个入口(多选批量条):选中的几张直接当一组列出来,
   * 顺序 = 勾选顺序,similarity 以第一张的提示词为基准;没有"同提示词/相似"切换
   * (这一档是"我手动挑了这几张来比",不是按提示词找的)。
   */
  const openCompareFromSelection = useCallback(() => {
    const ids = [...selectedIds];
    if (ids.length < 2) return;
    const seq = ++compareSeqRef.current;
    setCompareMode('exact');
    setCompareRows([]);
    setCompareLoading(true);
    setCompareError(null);
    openCompareModal({
      baseId: ids[0],
      baseName: rows.find((r) => r.id === ids[0])?.fileName ?? `#${ids[0]}`,
      basePrompt: '',
      canSwitch: false,
      count: ids.length,
    });
    window.api
      .getCompareRows(ids)
      .then((rs) => {
        if (seq === compareSeqRef.current) setCompareRows(rs);
      })
      .catch((e) => {
        if (seq === compareSeqRef.current) {
          setCompareRows([]);
          setCompareError(errMsg(e));
        }
      })
      .finally(() => {
        if (seq === compareSeqRef.current) setCompareLoading(false);
      });
  }, [selectedIds, rows, openCompareModal]);

  /** 多选模式下单击卡片 = 切换选中;平时单击 = 开详情(Ctrl/Shift 语义在 ImageGrid 里保持不变) */
  const handleOpen = useCallback(
    (id: number) => {
      if (selectMode) handleSelect(id, 'toggle');
      else setSelectedId(id);
    },
    [selectMode, handleSelect]
  );

  const batchMove = useCallback(async () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    try {
      const r = await window.api.moveImages(ids);
      if (!r.target) return; // 用户取消
      notify(
        `已移动 ${r.moved} 张` +
          (r.removedFromLibrary ? `,其中 ${r.removedFromLibrary} 张移出图库` : '') +
          (r.errors.length ? `,失败 ${r.errors.length} 张` : '')
      );
      closeSelection();
      setQuery((q) => ({ ...q }));
    } catch (e) {
      notify(errMsg(e), true);
    }
  }, [notify, selectedIds, setQuery]);

  const batchDelete = useCallback(async () => {
    const ids = [...selectedIds];
    closeConfirmBatchDelete();
    try {
      const r = await window.api.deleteImages(ids);
      for (const id of ids) removeRow(id);
      notify(`已删除 ${r.deleted} 张` + (r.errors.length ? `,失败 ${r.errors.length} 张` : ''));
      closeSelection();
      stats.reload();
    } catch (e) {
      notify(errMsg(e), true);
    }
  }, [notify, removeRow, selectedIds, stats]);

  /** 批量复制:整批复制到同一文件夹,同名跳过;原图与索引都不动 */
  const batchCopy = useCallback(async () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    try {
      const r = await window.api.copyImagesToFolder(ids);
      if (!r.target) return; // 用户取消
      notify(
        `已复制 ${r.copied} 张` +
          (r.skipped ? `,跳过同名 ${r.skipped} 张` : '') +
          (r.errors.length ? `,失败 ${r.errors.length} 张` : '')
      );
      closeSelection();
      setQuery((q) => ({ ...q }));
    } catch (e) {
      notify(errMsg(e), true);
    }
  }, [notify, selectedIds, setQuery]);

  /** 批量收藏:渲染层循环调 setStarred(不新增 IPC);方向按第一张的状态决定 */
  const batchStar = useCallback(async () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    // 第一张未收藏 → 整批收藏;已收藏 → 整批取消
    const target = !(rows.find((r) => r.id === ids[0])?.starred ?? false);
    let done = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await window.api.setStarred(id, target);
        patchRow(id, { starred: target });
        done++;
      } catch {
        failed++;
      }
    }
    if (done) {
      if (selectedId !== null && selectedIds.has(selectedId)) detail.detail.reload();
      if (query.starredOnly) void refresh();
    }
    notify(`已${target ? '收藏' : '取消收藏'} ${done} 张` + (failed ? `,失败 ${failed} 张` : ''));
    closeSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notify, selectedIds, rows, patchRow, selectedId, query.starredOnly, refresh]);

  // ---- 卡片右键菜单
  // 卡片右键菜单:关闭时先播退场动画,再卸载
  const { value: menu, closing: menuClosing, open: showMenuAt, close: closeMenu } = useDelayedClose<{ x: number; y: number; id: number }>();
  const menuRef = useRef<HTMLDivElement | null>(null);
  // 渲染后测量定位:先隐形渲染在点击处,量出真实宽高再钳位/翻转(菜单项增删不用再改钳位值)
  const menuPos = useAnchoredMenuPos(menu, menuRef);
  const { value: confirmDeleteId, closing: confirmDeleteClosing, open: openConfirmDelete, close: closeConfirmDelete } = useDelayedClose<number>();
  // 重命名弹层:目标 id + 输入框内容
  const { value: renameTarget, closing: renameClosing, open: openRename, close: closeRename } = useDelayedClose<{ id: number; name: string }>();
  const [renameValue, setRenameValue] = useState('');
  const openMenu = useCallback((id: number, x: number, y: number) => {
    // 坐标原样存作锚点;防超出窗口由 useAnchoredMenuPos 按真实尺寸处理
    showMenuAt({ id, x, y });
  }, [showMenuAt]);

  // 菜单打开期间:网格滚动 / 窗口改尺寸即关闭(与「更多」浮层一致)
  useEffect(() => {
    if (!menu) return;
    const close = () => closeMenu();
    window.addEventListener('resize', close);
    document.getElementById('cam-scroll')?.addEventListener('scroll', close, { passive: true });
    return () => {
      window.removeEventListener('resize', close);
      document.getElementById('cam-scroll')?.removeEventListener('scroll', close);
    };
  }, [menu, closeMenu]);

  const menuRow = menu ? rows.find((r) => r.id === menu.id) : undefined;

  const copyPositivePrompt = useCallback(
    async (id: number) => {
      try {
        const d = await window.api.getImage(id);
        const pos = d.meta?.prompts.find((p) => p.role === 'positive');
        if (!pos || !pos.text.trim()) {
          notify('这张图片没有正向提示词记录', true);
          return;
        }
        await navigator.clipboard.writeText(pos.text);
        notify('正向提示词已复制');
      } catch (e) {
        notify(errMsg(e), true);
      }
    },
    [notify]
  );

  const moveImage = useCallback(
    async (id: number) => {
      try {
        const r = await window.api.moveImage(id);
        if (!r) return; // 用户取消
        if (r.removedFromLibrary) {
          removeRow(id);
          if (selectedId === id) setSelectedId(null);
          notify('已移动到图库之外,该图已从库中移除');
        } else {
          notify(`已移动到 ${r.target}`);
        }
      } catch (e) {
        notify(errMsg(e), true);
      }
    },
    [notify, removeRow, selectedId]
  );

  const deleteImage = useCallback(
    async (id: number) => {
      try {
        await window.api.deleteImage(id);
        removeRow(id);
        if (selectedId === id) setSelectedId(null);
        closeConfirmDelete();
        notify('已移入回收站');
      } catch (e) {
        notify(errMsg(e), true);
      }
    },
    [notify, removeRow, selectedId, closeConfirmDelete]
  );

  // 分类增删改 / 图片归属变化后的统一刷新:树与详情面板归属
  const refreshCategories = useCallback(() => {
    categories.reload();
    detail.cats.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories.reload]);

  // 收藏切换:网格卡片与详情面板共用。本地 patch 行数据,避免整批重取;
  // 收藏筛选下取消收藏要原地刷新(行会消失,但列表不跳回顶部)
  const toggleStar = useCallback(
    async (id: number, starred: boolean) => {
      try {
        await window.api.setStarred(id, starred);
        patchRow(id, { starred });
        if (detail.detail.data?.id === id) detail.detail.reload();
        if (query.starredOnly) void refresh();
        notify(starred ? '已收藏' : '已取消收藏');
      } catch (e) {
        notify(errMsg(e), true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patchRow, query.starredOnly, refresh, notify]
  );

  const catList = categories.data ?? [];
  const folderList = folders.data ?? [];
  /** catList / selectedId 的实时副本:拖放等事件回调里要读"此刻"的值 */
  const catListRef = useRef<CategoryNode[]>([]);
  catListRef.current = catList;
  const selectedIdRef = useRef<number | null>(null);
  selectedIdRef.current = selectedId;

  // 当前视图里选中图的位置,用于详情面板的 ← → 翻页
  const viewIdx = useMemo(
    () => (selectedId === null ? -1 : rows.findIndex((r) => r.id === selectedId)),
    [rows, selectedId]
  );

  /** 批量收藏按钮的文案与方向:按第一张被选中图的当前状态决定(第一张已收藏 → 整批取消) */
  const firstSelectedStarred = useMemo(() => {
    const first = selectedIds.values().next().value;
    if (first === undefined) return false;
    return rows.find((r) => r.id === first)?.starred ?? false;
  }, [selectedIds, rows]);

  const prev = useCallback(() => {
    if (viewIdx > 0) setSelectedId(rows[viewIdx - 1].id);
  }, [rows, viewIdx]);
  const next = useCallback(() => {
    if (viewIdx >= 0 && viewIdx < rows.length - 1) setSelectedId(rows[viewIdx + 1].id);
  }, [rows, viewIdx]);

  /** 查看器翻页:当前标签页已加载列表(或"从比对列打开"时的那一列) */
  const lightboxStep = useCallback(
    (dir: 1 | -1) => {
      if (lightboxId === null) return;
      const i = lbRows.findIndex((r) => r.id === lightboxId);
      const j = i + dir;
      if (i >= 0 && j >= 0 && j < lbRows.length) openLightbox(lbRows[j].id);
    },
    [lightboxId, lbRows, openLightbox]
  );

  // 键盘:Esc 关详情/菜单/设置,← → 翻页,/ 聚焦搜索,Ctrl+T/W/Tab 管标签页
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 标签页快捷键(对齐浏览器):Ctrl+T 新建 / Ctrl+W 关闭 / Ctrl(+Shift)+Tab 循环切换
      if (e.ctrlKey && !e.shiftKey && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        tabKeysRef.current?.openNewTab();
        return;
      }
      if (e.ctrlKey && !e.shiftKey && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault();
        tabKeysRef.current?.closeActive();
        return;
      }
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        tabKeysRef.current?.cycle(e.shiftKey ? -1 : 1);
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && /INPUT|SELECT|TEXTAREA/.test(t.tagName)) {
        if (e.key === 'Escape') {
          t.blur();
          setQuery((q) => ({ ...q, q: undefined, offset: undefined }));
        }
        return;
      }
      if (e.key === 'F5') {
        e.preventDefault();
        refreshList();
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        document.getElementById('cam-search')?.focus();
        return;
      }
      if (e.key === 'Escape') {
        /**
         * Esc 链:查看器 → 并排比对台 → 比对面板 → … 逐层往下(按 z-index 从高到低)
         * 关上面那层**绝不顺手关下面**:比如并排台开着时按 Esc 只收并排台,
         * 底下的比对面板(以及它里面的勾选)原样留着。
         * 查看器排在比对面板前面:它会盖在面板上(从某个配方列里点开的那张图),
         * 所以要先收它;只从网格打开的查看器下面没有面板,同样先收它。
         */
        if (lightboxId !== null) closeLightbox();
        else if (compareStageRows) closeCompareStage();
        else if (compareReq) closeCompareModal();
        else if (folderMenu) closeFolderMenu();
        else if (moreMenu) closeMoreMenu();
        else if (selectedIds.size) closeSelection();
        // 多选模式:先清空选择(上面那条),再退出模式;优先级高于详情面板
        else if (selectMode) exitSelectMode();
        else if (menu) closeMenu();
        else if (confirmBatchDelete) closeConfirmBatchDelete();
        else if (removeRootTarget) closeRemoveRoot();
        else if (confirmDeleteId !== null) closeConfirmDelete();
        else if (recipeModal) closeRecipeModal();
        else if (settingsOpen) closeSettings();
        else if (selectedId !== null) closeDetail();
        return;
      }
      // 查看器开着时:← → 归查看器翻页(不再翻详情),其余键不往下走
      if (lightboxId !== null) {
        if (e.key === 'ArrowLeft') lightboxStep(-1);
        else if (e.key === 'ArrowRight') lightboxStep(1);
        return;
      }
      // 并排比对台开着时:方向键不再翻详情
      if (compareStageRows || compareReq) return;
      if (
        selectedId === null ||
        menu ||
        folderMenu ||
        moreMenu ||
        settingsOpen ||
        recipeModal ||
        confirmDeleteId !== null ||
        renameTarget !== null
      ) {
        return;
      }
      if (e.key === 'ArrowLeft') prev();
      if (e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    selectedId, prev, next, setQuery, menu, folderMenu, moreMenu,
    settingsOpen, confirmDeleteId, renameTarget, selectedIds, refreshList,
    selectMode, exitSelectMode, closeFolderMenu, closeMoreMenu, closeSelection,
    closeMenu, closeConfirmBatchDelete, closeRemoveRoot, closeConfirmDelete,
    closeSettings, lightboxId, lightboxStep, closeLightbox, recipeModal, closeRecipeModal,
    // 配方比对的两个层级:Esc 链最上面两层(见上面的注释)
    compareStageRows, closeCompareStage, compareReq, closeCompareModal,
    // closeDetail 在后面才声明,进 deps 会触发 TDZ;它是稳定的 useCallback,缺失无影响
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ]);

  // 滚到底自动加载下一页
  useEffect(() => {
    const onScroll = () => {
      const el = document.getElementById('cam-scroll');
      if (!el) return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) loadMore();
    };
    const el = document.getElementById('cam-scroll');
    el?.addEventListener('scroll', onScroll);
    return () => el?.removeEventListener('scroll', onScroll);
  }, [loadMore]);

  // Ctrl+滚轮缩放网格图片(指针悬在网格上时)。
  // 必须 passive:false + preventDefault:否则 Chromium 会缩放整个页面而不是图片。
  useEffect(() => {
    const el = document.getElementById('cam-scroll');
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setGridZoom((z) => {
        const next = Math.min(2.6, Math.max(0.55, e.deltaY < 0 ? z * 1.15 : z / 1.15));
        // 接近 1 时吸附回 1,避免永远差一点点导致「还原」按钮消不掉
        return Math.abs(next - 1) < 0.045 ? 1 : next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // 缩放级别记住:下次打开还是这个大小
  useEffect(() => {
    localStorage.setItem('cam-grid-zoom', String(gridZoom));
  }, [gridZoom]);

  const filt = stats.data;
  const scanning = progress && (progress.phase === 'parsing' || progress.phase === 'walking');

  // 扫描完成(手动扫描或 B2 自动入库)后原地刷新列表与统计:新图立刻出现,但不跳回顶部
  const reloadersRef = useRef({ stats: stats.reload, folders: folders.reload, categories: categories.reload, recipeStats: reloadRecipeStats });
  reloadersRef.current = { stats: stats.reload, folders: folders.reload, categories: categories.reload, recipeStats: reloadRecipeStats };
  const lastScanDoneRef = useRef<number | null>(null);
  /** 扫描后的"侧栏/统计"重拉定时器:连着一批一批入库时合并成一次(见下面的说明) */
  const scanReloadTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!progress || progress.phase !== 'done') return;
    const key = progress.finishedAt ?? 0;
    if (lastScanDoneRef.current === key) return;
    lastScanDoneRef.current = key;
    // 空扫(索引数/清理数都是 0)不动界面:监听触发的对账大多数没有实际变化,
    // 以前每次都整表重拉 + 网格重排,这就是"新图附近操作会卡一下"的来源之一。
    // 字段缺失(旧版主进程 / HTTP 调试)时按"有变化"处理,保证功能正确。
    if (typeof progress.indexed === 'number' && typeof progress.removed === 'number'
        && progress.indexed === 0 && progress.removed === 0) {
      return;
    }
    // 当前视图立刻原地刷新:新图马上出现在网格里(不动页码/滚动)。
    void refresh();
    /**
     * 侧栏与统计**延后合并**再拉。
     *
     * 出图是一批一批落盘的(ComfyUI 一次写十几张、隔几秒又一批),主进程那侧每批都会
     * 报一次"扫描完成";而 folders/stats/配方统计这几条查询要扫全库(实测:视图查询
     * 加索引前 100ms、库统计 1.9s、配方统计 0.2s),每批都拉一次会让主进程连接被占满,
     * 用户在这期间做任何事(哪怕只是删几张图)都要排队等 —— 表现出来就是"一直在卡"。
     * 这里统一延后 700ms 并重置计时器:连着的多批只拉一次。
     */
    if (scanReloadTimerRef.current !== null) window.clearTimeout(scanReloadTimerRef.current);
    scanReloadTimerRef.current = window.setTimeout(() => {
      scanReloadTimerRef.current = null;
      const r = reloadersRef.current;
      r.stats();
      r.folders();
      r.categories();
      r.recipeStats();
    }, 700);
  }, [progress, refresh]);
  useEffect(() => () => {
    if (scanReloadTimerRef.current !== null) window.clearTimeout(scanReloadTimerRef.current);
  }, []);

  /** 根容器:文件拖放的监听目标 */
  const rootRef = useRef<HTMLDivElement | null>(null);
  // ---- 把图片拖进窗口:只解析元数据,不入库、不复制 ----
  const dragDepth = useRef(0);
  const dropBusy = useRef(false);
  const [dropHover, setDropHover] = useState(false);
  const [tempDetail, setTempDetail] = useState<DroppedInspection | null>(null);

  const handleImageDrop = useCallback(async (file: File) => {
    if (!/\.(png|jpe?g|webp|bmp|gif|avif)$/i.test(file.name)) {
      notify('只支持 PNG / JPG / WebP / BMP / GIF / AVIF 图片', true);
      return;
    }
    const abs = window.api.getPathForFile ? window.api.getPathForFile(file) : '';
    if (!abs) {
      notify('读不到文件路径,请从资源管理器里直接拖入文件', true);
      return;
    }
    try {
      const info = await window.api.inspectFile(abs);
      setSelectedId(null);
      setTempDetail(info);
      notify('已解析拖入图片的元数据(没有入库)');
    } catch (e) {
      notify(errMsg(e), true);
    }
  }, [notify]);

  /**
   * 把图片加入某个分类(左侧分类树的拖放落点)。
   * 与右键「加入分类…」走同一个主进程接口,只是不弹选择框。
   */
  const addImagesToCategory = useCallback(
    async (categoryId: number, ids: number[]) => {
      if (!ids.length) return;
      const name = catNameById(catListRef.current, categoryId) ?? '分类';
      try {
        await window.api.setCategoryMembers(categoryId, ids, true);
        notify(ids.length > 1 ? `已把 ${ids.length} 张图片加入「${name}」` : `已加入「${name}」`);
        categories.reload();
        // 详情面板正开着这几张里的某一张 → 归属信息要跟着刷新
        if (selectedIdRef.current !== null && ids.includes(selectedIdRef.current)) detail.cats.reload();
      } catch (e) {
        notify(errMsg(e), true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notify]
  );

  /**
   * 「移出分类…」:打开 CategoryPicker 的指派模式。
   * 预勾选 = 所有目标图片所属分类的**交集**(每张图都在的分类才预勾),
   * 用户取消勾选即整批移出;交集为空时不开弹层,直接提示。
   */
  const openRemoveCatPicker = useCallback(
    async (ids: number[]) => {
      if (!ids.length) return;
      try {
        const perImage = await Promise.all(ids.map((id) => window.api.getImageCategories(id)));
        const common = perImage.reduce((acc, list) => acc.filter((c) => list.includes(c)));
        if (common.length === 0) {
          notify(ids.length > 1 ? '这些图片没有共同所属的分类' : '这张图片不属于任何分类', true);
          return;
        }
        openCatPicker({ ids, initialChecked: common });
      } catch (e) {
        notify(errMsg(e), true);
      }
    },
    [notify]
  );

  /**
   * 正在浏览某个分类时的直达移出:不弹选择框,直接整批移出当前分类。
   * 移出后这些图不再属于当前视图,网格原地刷新让它们消失。
   */
  const removeFromCurrentCategory = useCallback(
    async (categoryId: number, ids: number[]) => {
      if (!ids.length) return;
      const name = catNameById(catListRef.current, categoryId) ?? '当前分类';
      try {
        await window.api.setCategoryMembers(categoryId, ids, false);
        notify(ids.length > 1 ? `已把 ${ids.length} 张移出「${name}」` : `已移出「${name}」`);
        categories.reload();
        // 详情面板正开着这几张里的某一张 → 归属信息要跟着刷新
        if (selectedIdRef.current !== null && ids.includes(selectedIdRef.current)) detail.cats.reload();
        void refresh();
        if (ids.length > 1) closeSelection();
      } catch (e) {
        notify(errMsg(e), true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notify]
  );

  /**
   * 窗口级的拖拽监听(捕获阶段,先于根节点上的文件拖放处理):
   *
   * 用户报的问题 —— "拖预览界面的图片会跳出解析元数据的界面" —— 根因是
   * 原生图片拖拽也会发 DragEvent,而外层的 `Files` 拖放处理器照单全收。
   * 这里在**捕获阶段**认出来"这是自己窗口内部在拖卡片/图片",就
   *   - 标个标记,让 handleImageDrop 的文件拖放流程整条不启动;
   *   - 对预览图那种没打标记的原生图片拖拽,顺手 preventDefault 掐掉,
   *     免得 Chromium 把图片"拖出"窗口(拖到桌面会变成复制文件)。
   * 从资源管理器拖真文件进来时这两个判断都不成立,解析流程完全不受影响。
   */
  useEffect(() => {
    const isInternal = (dt: DataTransfer | null) => isInternalImageDrag() || hasImageDragData(dt);
    let phantomImageDrag = false;
    const onDragStart = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      const t = e.target as HTMLElement | null;
      // 自己发起的卡片拖拽:允许,交给 ImageGrid 的 onDragStart 打完标记
      if (isInternalImageDrag()) return;
      // 页面上任何一张 <img> 被单手拖起 = 误触,一律掐掉
      if (t && t.tagName === 'IMG' && !Array.from(dt.types || []).includes('Files')) {
        phantomImageDrag = true;
        e.preventDefault();
      }
    };
    const stopPhantom = (e: DragEvent) => {
      if (isInternal(e.dataTransfer)) return;
      if (phantomImageDrag) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onDragEnd = () => {
      phantomImageDrag = false;
      endImageDrag();
    };
    // 注意:清空"内部拖拽"状态只在 **dragend** 做 —— dragend 在 drop 之后才派发。
    // 若把 endImageDrag 挂在 drop 的捕获阶段,会先于左侧分类行的 onDrop 跑完,
    // readImageDragIds 就两手空空了(踩过的坑)。
    window.addEventListener('dragstart', onDragStart, true);
    window.addEventListener('dragenter', stopPhantom, true);
    window.addEventListener('dragover', stopPhantom, true);
    window.addEventListener('dragend', onDragEnd, true);
    return () => {
      window.removeEventListener('dragstart', onDragStart, true);
      window.removeEventListener('dragenter', stopPhantom, true);
      window.removeEventListener('dragover', stopPhantom, true);
      window.removeEventListener('dragend', onDragEnd, true);
    };
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const hasFiles = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    /** 拖的是自己窗口里的卡片(去往左侧分类)→ 不是"拖文件进来解析",不要弹提示层 */
    const draggingCard = (e: DragEvent) => isInternalImageDrag() || hasImageDragData(e.dataTransfer);
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e) || draggingCard(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDropHover(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e) || draggingCard(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e) || draggingCard(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDropHover(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e) || draggingCard(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDropHover(false);
      const file = e.dataTransfer?.files?.[0];
      if (!file || dropBusy.current) return;
      dropBusy.current = true;
      void handleImageDrop(file).finally(() => { dropBusy.current = false; });
    };
    el.addEventListener('dragenter', onEnter);
    el.addEventListener('dragover', onOver);
    el.addEventListener('dragleave', onLeave);
    el.addEventListener('drop', onDrop);
    return () => {
      el.removeEventListener('dragenter', onEnter);
      el.removeEventListener('dragover', onOver);
      el.removeEventListener('dragleave', onLeave);
      el.removeEventListener('drop', onDrop);
    };
  }, [handleImageDrop]);

  // ---- 右侧面板的统一目标:索引里的图(带 id)/ 拖进来的临时图(无 id) ----
  const panelTarget: DetailTarget | null =
    selectedId !== null
      ? { kind: 'indexed', detail: detail.detail.data }
      : tempDetail
        ? { kind: 'dropped', info: tempDetail }
        : null;

  /**
   * 详情面板的退场:关闭时先把目标"冻"住(内容不变)并标记 closing,
   * 槽位宽度随即过渡到 0(面板向右滑出、网格平滑铺开),
   * 等动画播完再把冻结值清掉。否则点关闭的瞬间面板会直接消失。
   * 400ms ≈ 槽位宽度过渡(var(--dur-3)=340ms)+ 余量。
   */
  const [detailClosing, setDetailClosing] = useState(false);
  const frozenTargetRef = useRef<DetailTarget | null>(null);
  const detailCloseTimer = useRef(0);
  const closeDetail = useCallback(() => {
    setDetailClosing((already) => {
      if (already) return true;
      if (prefersReducedMotion()) {
        frozenTargetRef.current = null;
        setSelectedId(null);
        setTempDetail(null);
        return false;
      }
      window.clearTimeout(detailCloseTimer.current);
      detailCloseTimer.current = window.setTimeout(() => {
        frozenTargetRef.current = null;
        setSelectedId(null);
        setTempDetail(null);
        setDetailClosing(false);
      }, 400);
      return true;
    });
  }, []);
  useEffect(() => () => window.clearTimeout(detailCloseTimer.current), []);
  // 面板打开着的时候,始终记住最后一份有效内容,供退场动画期间继续渲染
  if (panelTarget && !detailClosing) frozenTargetRef.current = panelTarget;
  const renderTarget = detailClosing ? frozenTargetRef.current : panelTarget;

  // ---- 标签页操作:切换 / 新建 / 关闭 / 循环 ----

  /** 把"此刻"的活动标签状态(查询/滚动/已加载范围/打开的详情)写回标签列表 */
  const snapshotActiveTab = (ts: BrowseTab[]): BrowseTab[] => {
    const el = document.getElementById('cam-scroll');
    return ts.map((t) =>
      t.id === activeTabId
        ? { ...t, query, scrollTop: el ? el.scrollTop : t.scrollTop, loadedCount: rows.length, selectedId }
        : t
    );
  };

  /** 切到某个标签:先给当前标签拍快照,再恢复目标标签的视图 */
  const activateTab = useCallback(
    (target: BrowseTab) => {
      if (target.id === activeTabId) return;
      setTabs((ts) => snapshotActiveTab(ts));
      setActiveTabId(target.id);
      pendingScrollRef.current = target.scrollTop;
      closeSelection();
      closeLightbox();
      if (target.selectedId !== null) {
        setTempDetail(null);
        setSelectedId(target.selectedId);
      } else if (selectedId !== null || tempDetail) {
        closeDetail();
      }
      restore(target.query, target.loadedCount);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTabId, query, rows.length, selectedId, tempDetail, restore, closeSelection, closeDetail]
  );

  /** 新建标签:默认回到"全部"视图(和浏览器的新标签页一样是一张白纸) */
  const openNewTab = useCallback(() => {
    const t: BrowseTab = { id: ++tabSeqRef.current, query: { sort: 'mtime_desc' }, scrollTop: 0, loadedCount: 0, selectedId: null };
    setTabs((ts) => [...snapshotActiveTab(ts), t]);
    setActiveTabId(t.id);
    pendingScrollRef.current = 0;
    closeSelection();
    closeLightbox();
    if (selectedId !== null || tempDetail) closeDetail();
    restore(t.query, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, query, rows.length, selectedId, tempDetail, restore, closeSelection, closeDetail]);

  /** 关闭标签:至少保留一个;关掉的是当前标签就激活相邻的 */
  const closeTab = useCallback(
    (id: number) => {
      const ts = tabsRef.current;
      if (ts.length <= 1) return;
      const idx = ts.findIndex((t) => t.id === id);
      if (idx < 0) return;
      const next = ts.filter((t) => t.id !== id);
      tabsRef.current = next;
      setTabs(next);
      if (id === activeTabId) activateTab(next[Math.min(idx, next.length - 1)]);
    },
    [activeTabId, activateTab]
  );

  /** Ctrl+Tab / Ctrl+Shift+Tab:循环切换 */
  const cycleTab = useCallback(
    (dir: 1 | -1) => {
      const ts = tabsRef.current;
      if (ts.length < 2) return;
      const idx = ts.findIndex((t) => t.id === activeTabId);
      activateTab(ts[(idx + dir + ts.length) % ts.length]);
    },
    [activeTabId, activateTab]
  );

  /**
   * 标签宽度:够宽就都用 TAB_W_MAX,挤不下才按可用宽度平分(浏览器就是这么做的)。
   *
   * ⚠️ 这段逻辑的坑:浏览器对 flex 子项的宽度做**亚像素取整**,十几个标签累积下来
   * 能有十几像素误差。按 `(可用宽度 - 固定开销) / 标签数` 算出来的宽度刚好差一点,
   * 于是标签栏永远挂着一条横向滚动条(实测:10 个标签、sw 1510 / cw 1500)。
   *
   * 所以最终判据是**"标签栏有没有横向溢出"**,而不是那个估算公式:
   * 先把宽度写成标签栏上的 CSS 变量 --tab-w(每个标签 width: var(--tab-w)),
   * 写完**立刻同步读 scrollWidth** 量一次;溢出就收 1px 再量,直到放得下。
   * 变量直接改 DOM,不走 React state —— 否则 setState 要等下一轮提交,
   * 循环里量到的还是旧布局,根本收敛不了。
   */
  useEffect(() => {
    const bar = tabbarRef.current;
    if (!bar) return;

    const settle = () => {
      const n = Math.max(1, tabsRef.current.length);
      const est = Math.floor((bar.clientWidth - TABBAR_CHROME) / n);
      let w = Math.max(TAB_W_MIN, Math.min(TAB_W_MAX, est));
      for (let i = 0; i < 10; i++) {
        bar.style.setProperty('--tab-w', `${w}px`);
        const over = bar.scrollWidth - bar.clientWidth;
        if (over <= 1 || w <= TAB_W_MIN) break;
        w = Math.max(TAB_W_MIN, w - Math.max(1, Math.ceil(over / n)) - 1);
      }
      setTabW((cur) => (cur === w ? cur : w));
    };

    settle();
    // 首帧后布局才算真正稳定(横向滚动条出现本身会再吃掉十几像素),再校一次
    const raf = requestAnimationFrame(settle);
    const ro = new ResizeObserver(() => settle());
    ro.observe(bar);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // tabs.length 变化后要重量一次;tabs 的其他字段变化不影响宽度
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.length]);

  // 供全局键盘钩子调用(钩子的依赖数组不能引用后面才定义的回调,走 ref)
  const tabKeysRef = useRef<{ openNewTab: () => void; closeActive: () => void; cycle: (d: 1 | -1) => void } | null>(null);
  tabKeysRef.current = { openNewTab, closeActive: () => closeTab(activeTabId), cycle: cycleTab };

  // 持久化:查询布局 + 激活标签(滚动/详情是会话级的,不落盘)
  useEffect(() => {
    try {
      localStorage.setItem(
        TABS_STORAGE_KEY,
        JSON.stringify({
          activeId: activeTabId,
          tabs: tabs.map((t) => ({ query: t.id === activeTabId ? query : t.query })),
        })
      );
    } catch {
      /* 写不进就算了 */
    }
  }, [tabs, activeTabId, query]);

  // 切标签后恢复滚动位置:等目标标签的整段数据回来再跳(瀑布流高度由索引里的
  // 宽高决定,不用等图片解码,数据到位版面就稳定)
  useEffect(() => {
    if (pendingScrollRef.current === null) return;
    if (rows.length === 0) return;
    const el = document.getElementById('cam-scroll');
    if (el) el.scrollTop = pendingScrollRef.current;
    pendingScrollRef.current = null;
  }, [rows]);

  return (
    <div
      ref={rootRef}
      className={`cam-app${bgUrl ? ' has-wallpaper' : ''}`}
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg)',
        backgroundColor: bgUrl ? 'transparent' : undefined,
        backgroundImage: bgUrl ? `url("${bgUrl}")` : undefined,
        backgroundSize: BG_FIT[bgFit].size,
        backgroundRepeat: BG_FIT[bgFit].repeat,
        backgroundPosition: BG_FIT[bgFit].position,
        color: 'var(--fg)',
        font: '13px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif',
        overflow: 'hidden',
      }}
    >

      <header className="cam-drag cam-header" style={{ position: 'relative', padding: '8px 14px', flexShrink: 0 }}>
        <div
          className="cam-toolbar cam-drag"
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            flexWrap: 'nowrap',
            minWidth: 0,
            paddingRight: 142,
          }}
        >
          <div className="cam-drag cam-toolbar-brand" style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <img
              src="logo.png"
              alt=""
              width={30}
              height={30}
              style={{ borderRadius: 9, display: 'block', boxShadow: '0 2px 8px rgba(0,0,0,.35)' }}
            />
            <strong className="cam-toolbar-title" style={{ fontSize: 14, whiteSpace: 'nowrap' }}>A3 manager</strong>
          </div>
          <input
            id="cam-search"
            type="search"
            placeholder="搜索:文件名 / 提示词 / 模型 / LoRA / 文件夹…  (按 / 聚焦)"
            value={query.q ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              // 不要 trim:每次按键都 trim 会把刚敲的空格吃掉,
              // 导致"只能在写完后回头插入空格"。首尾空格交给后端查询时处理。
              setQuery((q) => ({ ...q, q: v || undefined }));
            }}
            style={{ ...input, flex: '1 1 auto', minWidth: 80, maxWidth: 420 }}
          />
          {/* 窄窗口时这三个按钮收进「更多」,保证工具条永远只有一行 */}
          <button
            type="button"
            className={`cam-tb-opt cam-star-btn${query.starredOnly ? ' on' : ''}`}
            title={query.starredOnly ? '正在筛选收藏,点击查看全部' : '收藏(在当前文件夹 / 分类 / 搜索范围内筛选)'}
            aria-pressed={query.starredOnly === true}
            onClick={toggleStarredOnly}
          >
            <StarIcon filled={query.starredOnly === true} />
            收藏
          </button>
          <select
            className="cam-tb-opt"
            style={input}
            value={query.modelName ?? ''}
            onChange={(e) => setQuery((q) => ({ ...q, modelName: e.target.value || undefined }))}
          >
            <option value="">全部模型</option>
            {(filt?.topModels ?? []).map((x) => (
              <option key={x.name} value={x.name}>
                {x.name} ({x.count})
              </option>
            ))}
          </select>
          <select
            className="cam-tb-opt"
            style={input}
            value={query.sort ?? 'mtime_desc'}
            onChange={(e) => setQuery((q) => ({ ...q, sort: e.target.value as SortKey }))}
          >
            <option value="mtime_desc">最新优先</option>
            <option value="mtime_asc">最早优先</option>
            <option value="name_asc">名称 A→Z</option>
            <option value="size_desc">体积从大到小</option>
            <option value="random">随机</option>
          </select>
          <button
            type="button"
            title="刷新列表(重新读取索引,新入库的图会立刻出现)"
            style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 5 }}
            onClick={refreshList}
          >
            <RefreshIcon />
            刷新
          </button>
          <button
            type="button"
            title="清空搜索/文件夹/分类/模型/收藏/排序,回到默认视图"
            style={btn}
            onClick={() => {
              setQuery({ sort: 'mtime_desc' });
              setSelectedId(null);
            }}
          >
            重置
          </button>
          <button
            type="button"
            className={`cam-tb-select${selectMode ? ' on' : ''}`}
            title={selectMode ? '退出多选模式(Esc),并清空当前选择' : '多选模式:单击卡片即选中/取消,批量条常驻'}
            aria-pressed={selectMode}
            style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 5 }}
            onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
          >
            多选
          </button>
          <button
            type="button"
            className={`cam-tb-eye${zen ? ' on' : ''}`}
            title={zen ? '恢复正常显示' : '隐藏预览区:网格变成磨砂玻璃,透出背景图'}
            aria-pressed={zen}
            style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 5 }}
            onClick={() => setZen((v) => !v)}
          >
            <EyeIcon />
          </button>
          <button
            type="button"
            title="LoRA 配方管理:给一组 LoRA 起名、配封面,详情面板里按配方分组显示"
            style={{ ...btn, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}
            onClick={() => openRecipeModal({})}
          >
            <RecipeIcon />
            配方
          </button>
          <button
            type="button"
            title="设置"
            style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 5 }}
            onClick={() => openSettings(true)}
          >
            <GearIcon />
            设置
          </button>
          <button
            ref={moreBtnRef}
            type="button"
            title="更多操作"
            className="cam-tb-more"
            style={{ ...btn, display: 'none', alignItems: 'center', gap: 5 }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={toggleMoreMenu}
          >
            <MoreIcon />
            更多
          </button>
        </div>
        <div className="cam-wincontrols">
          <button type="button" title="最小化" onClick={() => void window.api.windowMinimize()}>
            <svg viewBox="0 0 12 12" aria-hidden="true"><line x1="1" y1="6" x2="11" y2="6" /></svg>
          </button>
          <button
            type="button"
            title={winMaximized ? '向下还原' : '最大化'}
            onClick={() => {
              void window.api
                .windowToggleMaximize()
                .then(() => window.api.isWindowMaximized())
                .then(setWinMaximized)
                .catch(() => undefined);
            }}
          >
            {winMaximized ? (
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <rect x="1.5" y="3.5" width="7" height="7" rx="1" />
                <path d="M4 3.5V2.6A1.1 1.1 0 0 1 5.1 1.5h4.3A1.1 1.1 0 0 1 10.5 2.6v4.3A1.1 1.1 0 0 1 9.4 8H8.5" />
              </svg>
            ) : (
              <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="1.2" /></svg>
            )}
          </button>
          <button type="button" className="close" title="关闭" onClick={() => void window.api.windowClose()}>
            <svg viewBox="0 0 12 12" aria-hidden="true"><line x1="1.5" y1="1.5" x2="10.5" y2="10.5" /><line x1="10.5" y1="1.5" x2="1.5" y2="10.5" /></svg>
          </button>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>
          <span>
            显示 {rows.length} / {total} 张
            {tookMs ? ` · 查询 ${tookMs}ms` : ''}
          </span>
          {stats.data ? (
            <span>
              库内 {stats.data.totalImages} 张 · {(stats.data.totalBytes / 1073741824).toFixed(1)} GB
            </span>
          ) : null}
          {scanning && progress ? (
            <span style={{ color: 'var(--warn)' }}>
              扫描中 {progress.processed}/{progress.total}
            </span>
          ) : null}
          <span style={{ marginLeft: 'auto' }}>
            {loading ? '加载中…' : hasMore ? '滚动加载更多' : '已到底'}
          </span>
        </div>
      </header>

      {error ? (
        <div style={{ padding: '8px 14px', background: 'var(--bad-bg)', color: 'var(--bad-fg)', fontSize: 12 }}>
          查询失败:{error}
        </div>
      ) : null}

      {/* 标签栏:浏览器式多浏览视图,每个标签记住自己的文件夹/分类/搜索/滚动位置。
          所有标签等宽(由 tabW 统一给),多了才一起收缩 —— 见 v0.6 需求 4 */}
      <nav
        className="cam-tabbar"
        aria-label="浏览标签页"
        ref={tabbarRef}
        // 标签宽度走 CSS 变量:量宽循环要"写进去立刻量",用 React state 会等下一轮提交
        style={{ ['--tab-w' as string]: `${tabW}px` }}
      >
        {tabs.map((t) => {
          const isActive = t.id === activeTabId;
          const title = tabTitle(isActive ? query : t.query, catList, recipes);
          return (
            <div
              key={t.id}
              className={`cam-tab${isActive ? ' on' : ''}`}
              data-selected={isActive ? 'true' : undefined}
              title={title}
              onClick={() => activateTab(t)}
              onMouseDown={(e) => {
                // 中键直接关(浏览器习惯)
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(t.id);
                }
              }}
            >
              <span className="cam-tab-title">{title}</span>
              {tabs.length > 1 ? (
                <button
                  type="button"
                  className="cam-tab-x"
                  title="关闭标签页 (Ctrl+W)"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
          );
        })}
        <button
          type="button"
          className="cam-tab-add"
          title="新标签页 (Ctrl+T)"
          onClick={() => openNewTab()}
        >
          +
        </button>
      </nav>

      <main style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <aside
          className="cam-side"
          style={{
            width: 236,
            flexShrink: 0,
            borderRight: '1px solid var(--border)',
            overflowY: 'auto',
            padding: '6px 0',
          }}
        >
          {categories.error ? <div style={warn}>{errMsg(categories.error)}</div> : null}
          <CategoryTree
            categories={catList}
            activeCat={query.categoryId ?? null}
            onPickCat={(id) => setQuery((q) => ({ ...q, categoryId: id ?? undefined, relDir: undefined }))}
            onChanged={refreshCategories}
            notify={notify}
            onDropImage={(categoryId, ids) => void addImagesToCategory(categoryId, ids)}
          />
          {/* 配方(v0.8):按"一组 LoRA 组合"筛选,与文件夹/分类筛选可叠加 */}
          <RecipeTree
            recipes={recipes}
            stats={recipeStats}
            activeId={query.recipeId ?? null}
            onPick={(id) => {
              setQuery((q) => ({ ...q, recipeId: id ?? undefined }));
              // 结果集换了内容,回到列表顶部(与「收藏」开关的做法一致)
              requestAnimationFrame(() => {
                const el = document.getElementById('cam-scroll');
                if (el) el.scrollTop = 0;
              });
            }}
          />
          {folders.error ? <div style={warn}>{errMsg(folders.error)}</div> : null}
          <FolderTree
            folders={folderList}
            activeDir={query.relDir ?? null}
            onPickDir={(relDir) =>
              // v0.6:点文件夹 = 看这个文件夹**及其所有子目录**里的图
              // (以前是精确匹配 rel_dir,目录本身没有直接图就一片空白)
              setQuery((q) => ({
                ...q,
                relDir: relDir ?? undefined,
                relDirRecursive: relDir ? true : undefined,
                categoryId: undefined,
              }))
            }
            onOpenFolder={(node) =>
              void window.api
                .openFolder(node.relDir)
                .catch((e) => notify(errMsg(e), true))
            }
            onContextMenu={(node, x, y) =>
              openFolderMenu({
                node,
                x: Math.min(x, window.innerWidth - 210),
                y: Math.min(y, window.innerHeight - 260),
              })
            }
          />
        </aside>

        <div id="cam-scroll" className={`cam-gridwrap${zen ? ' zen' : ''}${selectMode ? ' selecting' : ''}`} style={{ flex: 1, overflowY: zen ? 'hidden' : 'auto', overflowX: 'hidden', minHeight: 0 }}>
          {zen ? null : rows.length === 0 && !loading ? (
            <div style={{ padding: 48, textAlign: 'center', color: 'var(--muted)' }}>
              没有匹配的图片 —— 试着点「刷新」重读索引,或点「重置」清空筛选
              {stats.data?.totalImages === 0 ? (
                <div style={{ marginTop: 8, fontSize: 12 }}>
                  索引库是空的:先在「设置」里添加扫描目录并执行一次扫描。
                </div>
              ) : null}
            </div>
          ) : (
            <>
              {Math.abs(gridZoom - 1) > 0.001 ? (
                <div className="cam-zoom-reset-wrap">
                  <button
                    type="button"
                    className="cam-zoom-reset"
                    title="恢复原比例(Ctrl+滚轮缩放)"
                    onClick={() => setGridZoom(1)}
                  >
                    还原
                  </button>
                </div>
              ) : null}
              <ImageGrid
                rows={rows}
                onOpen={handleOpen}
                onToggleStar={toggleStar}
                onContextMenu={openMenu}
                selectedIds={selectedIds as Set<number>}
                onSelect={handleSelect}
                zoom={gridZoom}
                openId={selectedId}
                // 多选模式下双击不抢"单击=切换选中"的语义
                onOpenViewer={(id) => { if (!selectMode) openLightboxInList(id); }}
                onDragEnd={() => endImageDrag()}
              />
            </>
          )}
        </div>

        {renderTarget ? (
          <DetailSlot closing={detailClosing}>
            <DetailPanel
              target={renderTarget}
              categories={catList}
              catIds={detail.cats.data ?? []}
              onClose={closeDetail}
              onPrev={prev}
              onNext={next}
              canPrev={selectedId !== null && viewIdx > 0}
              canNext={selectedId !== null && viewIdx >= 0 && viewIdx < rows.length - 1}
              onToggleStar={(id, starred) => void toggleStar(id, starred)}
              onReveal={(id) =>
                void window.api.revealInExplorer(id).catch((e) => notify(errMsg(e), true))
              }
              onOpenFolder={() => {
                // 索引图:直接打开它所在的目录;拖入图:打开它所在目录
                const dir =
                  selectedId !== null
                    ? detail.detail.data?.absPath.replace(/[\\/][^\\/]*$/, '') ?? ''
                    : tempDetail
                      ? tempDetail.path.replace(/[\\/][^\\/]*$/, '')
                      : '';
                if (!dir) return;
                void window.api.openFolder(dir).catch((e) => notify(errMsg(e), true));
              }}
              onCopyPath={(id) =>
                void window.api
                  .copyPath(id)
                  .then(() => notify('路径已复制'))
                  .catch((e) => notify(errMsg(e), true))
              }
              onOpenViewer={(id) => openLightboxInList(id)}
              recipes={recipes}
              onSaveRecipe={(ls) => openRecipeModal({ initialLoras: ls })}
              onCompare={openCompareFromDetail}
              onChanged={refreshCategories}
              notify={notify}
            />
          </DetailSlot>
        ) : null}
      </main>

      {dropHover ? (
        <div className="cam-dropzone" aria-hidden="true">
          <div className="cam-dropcard">
            <div style={{ fontSize: 26, lineHeight: 1 }}>⤓</div>
            <strong style={{ fontSize: 14 }}>松手即解析元数据</strong>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              只读参数,不会入库、不会复制、不会改动原图
            </span>
          </div>
        </div>
      ) : null}

      {menu ? (
        <>
          <div
            className={`cam-menu-mask${menuClosing ? ' closing' : ''}`}
            onClick={() => closeMenu()}
            onContextMenu={(e) => {
              e.preventDefault();
              closeMenu();
            }}
          />
          <div
            ref={menuRef}
            className={`cam-menu${menuPos?.flip ? ' flip' : ''}${menuClosing ? ' closing' : ''}`}
            style={{
              left: menuPos?.left ?? menu.x,
              top: menuPos?.top ?? menu.y,
              // 首帧先隐形:useLayoutEffect 量完尺寸、算出落点后同帧显示,不会闪烁
              visibility: menuPos ? undefined : 'hidden',
            }}
          >
            <button type="button" className="cam-menu-item" onClick={() => { closeMenu(); setSelectedId(menu.id); }}>
              查看参数
            </button>
            <button type="button" className="cam-menu-item" onClick={() => { closeMenu(); void window.api.openExternal(menu.id).catch((e) => notify(errMsg(e), true)); }}>
              打开图片
            </button>
            <button type="button" className="cam-menu-item" onClick={() => { closeMenu(); void window.api.revealInExplorer(menu.id).catch((e) => notify(errMsg(e), true)); }}>
              打开所在位置
            </button>
            <div className="cam-menu-sep" />
            <button type="button" className="cam-menu-item" onClick={() => { closeMenu(); void copyPositivePrompt(menu.id); }}>
              复制正向提示词
            </button>
            <button type="button" className="cam-menu-item" onClick={() => { closeMenu(); void window.api.copyPath(menu.id).then(() => notify('路径已复制')).catch((e) => notify(errMsg(e), true)); }}>
              复制文件路径
            </button>
            <button
              type="button"
              className="cam-menu-item"
              onClick={() => {
                const row = menuRow;
                closeMenu();
                setRenameValue((row?.fileName ?? '').replace(/\.png$/i, ''));
                openRename({ id: menu.id, name: row?.fileName ?? '' });
              }}
            >
              重命名…
            </button>
            <button type="button" className="cam-menu-item" onClick={() => { closeMenu(); void toggleStar(menu.id, !(menuRow?.starred ?? false)); }}>
              {menuRow?.starred ? '取消收藏' : '收藏'}
            </button>
            <button
              type="button"
              className="cam-menu-item"
              onClick={() => {
                // 右键的卡在多选集合里 → 整批加入;否则只操作这一张
                const ids = selectedIds.has(menu.id) && selectedIds.size > 1 ? [...selectedIds] : [menu.id];
                closeMenu();
                openCatPicker({ ids });
              }}
            >
              加入分类…
            </button>
            <button
              type="button"
              className="cam-menu-item"
              onClick={() => {
                // 与「加入分类…」同一批目标;指派模式弹层,预勾选取整批分类的交集
                const ids = selectedIds.has(menu.id) && selectedIds.size > 1 ? [...selectedIds] : [menu.id];
                closeMenu();
                void openRemoveCatPicker(ids);
              }}
            >
              移出分类…
            </button>
            {query.categoryId !== undefined ? (
              <button
                type="button"
                className="cam-menu-item"
                onClick={() => {
                  // 正在浏览某个分类:直达移出,不开弹层
                  const ids = selectedIds.has(menu.id) && selectedIds.size > 1 ? [...selectedIds] : [menu.id];
                  const categoryId = query.categoryId;
                  closeMenu();
                  if (categoryId !== undefined) void removeFromCurrentCategory(categoryId, ids);
                }}
              >
                从当前分类移出
              </button>
            ) : null}
            <div className="cam-menu-sep" />
            <button type="button" className="cam-menu-item" onClick={() => { closeMenu(); void window.api.copyImageToClipboard(menu.id).then(() => notify('图片已复制到剪贴板')).catch((e) => notify(errMsg(e), true)); }}>
              复制图片(剪贴板)
            </button>
            <button
              type="button"
              className="cam-menu-item"
              title="重新编码后写入剪贴板,丢掉全部 tEXt/iTXt/zTXt 元数据;不产生新文件,也不改动原图"
              onClick={() => { closeMenu(); void window.api.copyImageWithoutMetadata(menu.id).then(() => notify('已复制无元数据版本(原图未改动)')).catch((e) => notify(errMsg(e), true)); }}
            >
              复制图片(无元数据)
            </button>
            <button type="button" className="cam-menu-item" onClick={() => { closeMenu(); void window.api.copyImageToFolder(menu.id).then((r) => { if (r) notify('已复制到 ' + r.copiedTo); }).catch((e) => notify(errMsg(e), true)); }}>
              复制到文件夹…
            </button>
            <button type="button" className="cam-menu-item" onClick={() => { closeMenu(); void moveImage(menu.id); }}>
              移动到文件夹…
            </button>
            <button type="button" className="cam-menu-item danger" onClick={() => { openConfirmDelete(menu.id); closeMenu(); }}>
              删除(移入回收站)
            </button>
          </div>
        </>
      ) : null}

      {renameTarget !== null ? (
        <div
          className={`cam-modal${renameClosing ? ' closing' : ''}`}
          onClick={(e) => { if (e.target === e.currentTarget) closeRename(); }}
        >
          {/* 背景/描边/圆角/投影统一由 .cam-modal > div 的玻璃规则提供,这里只留尺寸 */}
          <div style={{ width: 420, padding: '16px 18px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>重命名图片</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
              会直接改磁盘上的文件名(扩展名保持不变),缩略图与索引一起更新。
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 6 }}>原文件名:{renameTarget.name}</div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const id = renameTarget.id;
                const next = renameValue.trim();
                if (!next) {
                  notify('名字不能为空', true);
                  return;
                }
                void window.api
                  .renameImage(id, next)
                  .then((row) => {
                    if (row) patchRow(id, { fileName: row.fileName });
                    if (selectedId === id) detail.detail.reload();
                    notify('已重命名为 ' + (row?.fileName ?? next));
                    closeRename();
                  })
                  .catch((e) => notify(errMsg(e), true));
              }}
            >
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') closeRename();
                }}
                style={{ ...input, width: '100%', marginBottom: 14 }}
              />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" style={btn} onClick={() => closeRename()}>
                  取消
                </button>
                <button
                  type="submit"
                  style={{ ...btn, borderColor: 'var(--accent)', color: 'var(--accent)' }}
                >
                  确定
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {confirmDeleteId !== null ? (
        <div className={`cam-modal${confirmDeleteClosing ? ' closing' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) closeConfirmDelete(); }}>
          <div style={{ width: 380, padding: '16px 18px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>删除这张图片?</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
              文件会移入系统回收站,可以从回收站恢复;索引记录会立即移除。
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" style={btn} onClick={() => closeConfirmDelete()}>
                取消
              </button>
              <button
                type="button"
                style={{ ...btn, borderColor: 'var(--bad)', color: 'var(--bad)' }}
                onClick={() => void deleteImage(confirmDeleteId)}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 批量操作条:有选中时出现;多选模式下常驻(0 张时只留全选/退出) */}
      {selectedIds.size > 0 || selectMode ? (
        <div className={`cam-selectbar${selectBarClosing ? ' closing' : ''}`}>
          <span style={{ fontSize: 12 }}>已选 {selectedIds.size} 张</span>
          <button type="button" className="cam-sb-btn" onClick={() => openSelection(new Set(rows.map((r) => r.id)))}>
            全选本页
          </button>
          <button type="button" className="cam-sb-btn" disabled={!selectedIds.size} onClick={() => void batchCopy()}>
            复制到文件夹…
          </button>
          <button type="button" className="cam-sb-btn" disabled={!selectedIds.size} onClick={() => void batchMove()}>
            移动…
          </button>
          <button type="button" className="cam-sb-btn" disabled={!selectedIds.size} onClick={() => openCatPicker({ ids: [...selectedIds] })}>
            加入分类…
          </button>
          <button type="button" className="cam-sb-btn" disabled={!selectedIds.size} onClick={() => void openRemoveCatPicker([...selectedIds])}>
            移出分类…
          </button>
          <button
            type="button"
            className="cam-sb-btn"
            disabled={selectedIds.size < 2}
            title={selectedIds.size < 2 ? '至少选 2 张才能比对' : '把这几张按配方分列并排比对'}
            onClick={openCompareFromSelection}
          >
            比对
          </button>
          <button type="button" className="cam-sb-btn" disabled={!selectedIds.size} onClick={() => void batchStar()}>
            {firstSelectedStarred ? '取消收藏' : '收藏'}
          </button>
          <button type="button" className="cam-sb-btn danger" disabled={!selectedIds.size} onClick={() => openConfirmBatchDelete(true)}>
            删除
          </button>
          <button type="button" className="cam-sb-btn" onClick={() => (selectMode ? exitSelectMode() : closeSelection())}>
            {selectMode ? '退出多选' : '取消选择'}
          </button>
        </div>
      ) : null}

      {confirmBatchDelete ? (
        <div className={`cam-modal${confirmBatchDeleteClosing ? ' closing' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) closeConfirmBatchDelete(); }}>
          <div style={{ width: 400, padding: '16px 18px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>删除选中的 {selectedIds.size} 张图片?</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
              文件会全部移入系统回收站(可恢复),索引记录立即移除。
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" style={btn} onClick={() => closeConfirmBatchDelete()}>取消</button>
              <button type="button" style={{ ...btn, borderColor: 'var(--bad)', color: 'var(--bad)' }} onClick={() => void batchDelete()}>
                删除 {selectedIds.size} 张
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {removeRootTarget ? (
        <div className={`cam-modal${removeRootClosing ? ' closing' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) closeRemoveRoot(); }}>
          <div style={{ width: 440, padding: '16px 18px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              移除图库「{removeRootTarget.label}」?
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
              磁盘上的图片不会被删,但这个图库的索引记录会被清空(收藏、分类归属也会一起没)。
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 14, wordBreak: 'break-all' }}>
              {removeRootTarget.path}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" style={btn} onClick={() => closeRemoveRoot()}>取消</button>
              <button
                type="button"
                style={{ ...btn, borderColor: 'var(--bad)', color: 'var(--bad)' }}
                onClick={() => {
                  const target = removeRootTarget;
                  closeRemoveRoot();
                  void removeLibraryRoot(target.id, target.label);
                }}
              >
                移除图库
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {folderMenu ? (
        <>
          <div className={`cam-menu-mask${folderMenuClosing ? ' closing' : ''}`} onClick={() => closeFolderMenu()} onContextMenu={(e) => { e.preventDefault(); closeFolderMenu(); }} />
          <div className={`cam-menu${folderMenuClosing ? ' closing' : ''}`} style={{ left: folderMenu.x, top: folderMenu.y }}>
            <button
              type="button"
              className="cam-menu-item"
              onClick={() => {
                const n = folderMenu.node;
                closeFolderMenu();
                void window.api
                  .openFolder(n.relDir)
                  .catch((e) => notify(errMsg(e), true));
              }}
            >
              打开文件夹所在位置
            </button>
            <div className="cam-menu-sep" />
            <button
              type="button"
              className="cam-menu-item"
              onClick={() => {
                const n = folderMenu.node;
                closeFolderMenu();
                setAliasValue(n.alias ?? '');
                openAlias(n);
              }}
            >
              重命名(备注)…
            </button>
            <button
              type="button"
              className="cam-menu-item"
              onClick={() => {
                const n = folderMenu.node;
                closeFolderMenu();
                void toggleFolderHidden(n.rootId, n.relDir, !(n.hidden ?? false));
              }}
            >
              {folderMenu.node.hidden ? '恢复到左侧栏' : '在左侧栏隐藏'}
            </button>
          </div>
        </>
      ) : null}

      {moreMenu ? (
        <>
          <div
            className={`cam-menu-mask${moreMenuClosing ? ' closing' : ''}`}
            onClick={() => closeMoreMenu()}
            onContextMenu={(e) => {
              e.preventDefault();
              closeMoreMenu();
            }}
          />
          <div
            ref={moreMenuRef}
            className={`cam-menu${moreMenuPos?.flip ? ' flip' : ''}${moreMenuClosing ? ' closing' : ''}`}
            style={{
              left: moreMenuPos?.left ?? moreMenu.x,
              top: moreMenuPos?.top ?? moreMenu.y,
              minWidth: 216,
              visibility: moreMenuPos ? undefined : 'hidden',
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className={`cam-menu-item${query.starredOnly ? ' active' : ''}`}
              onClick={() => {
                closeMoreMenu();
                toggleStarredOnly();
              }}
            >
              <StarIcon filled={query.starredOnly === true} />
              {query.starredOnly ? '取消「收藏」筛选' : '收藏'}
            </button>
            <div className="cam-menu-sep" />
            <div className="cam-menu-label">
              <ModelIcon />
              按模型筛选
            </div>
            <select
              style={menuSelect}
              value={query.modelName ?? ''}
              onChange={(e) => setQuery((q) => ({ ...q, modelName: e.target.value || undefined }))}
            >
              <option value="">全部模型</option>
              {(filt?.topModels ?? []).map((x) => (
                <option key={x.name} value={x.name}>
                  {x.name} ({x.count})
                </option>
              ))}
            </select>
            <div className="cam-menu-label">
              <SortIcon />
              排序
            </div>
            <select
              style={menuSelect}
              value={query.sort ?? 'mtime_desc'}
              onChange={(e) => setQuery((q) => ({ ...q, sort: e.target.value as SortKey }))}
            >
              <option value="mtime_desc">最新优先</option>
              <option value="mtime_asc">最早优先</option>
              <option value="name_asc">名称 A→Z</option>
              <option value="size_desc">体积从大到小</option>
              <option value="random">随机</option>
            </select>
            <div className="cam-menu-sep" />
            <button
              type="button"
              className="cam-menu-item"
              onClick={() => {
                closeMoreMenu();
                refreshList();
              }}
            >
              <RefreshIcon />
              刷新列表
            </button>
            <button
              type="button"
              className="cam-menu-item"
              onClick={() => {
                closeMoreMenu();
                setQuery({ sort: 'mtime_desc' });
                setSelectedId(null);
                setTempDetail(null);
              }}
            >
              <ResetIcon />
              重置全部筛选
            </button>
          </div>
        </>
      ) : null}

      {aliasTarget ? (

        <div className={`cam-modal${aliasClosing ? ' closing' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) closeAlias(); }}>
          <div style={{ width: 420, padding: '16px 18px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>给文件夹起个备注</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
              只改管理器里显示的名字,磁盘上的目录名不动。留空则恢复原名。
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 6 }}>
              磁盘目录:{aliasTarget.relDir || '[' + aliasTarget.rootLabel + ']'}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void applyFolderAlias(aliasTarget.rootId, aliasTarget.relDir, aliasValue);
                closeAlias();
              }}
            >
              <input
                autoFocus
                value={aliasValue}
                onChange={(e) => setAliasValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') closeAlias(); }}
                style={{ ...input, width: '100%', marginBottom: 14 }}
              />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" style={btn} onClick={() => closeAlias()}>取消</button>
                <button type="submit" style={{ ...btn, borderColor: 'var(--accent)', color: 'var(--accent)' }}>确定</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {recipeModal ? (
        <RecipeManager
          recipes={recipes}
          closing={recipeClosing}
          initialLoras={recipeModal.initialLoras}
          onClose={() => closeRecipeModal()}
          onChanged={reloadRecipes}
          notify={notify}
        />
      ) : null}

      {settingsOpen ? (
        <div className={`cam-modal${settingsClosing ? ' closing' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) closeSettings(); }}>
          <div style={{ width: 520, maxHeight: '82vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <h2 style={{ fontSize: 13, margin: 0, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              设置
            </h2>
            <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 12 }}>点关闭按钮时</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>缩小到托盘常驻,或直接退出应用</div>
                </div>
                <SlideSwitch
                  leftLabel="缩小到托盘"
                  rightLabel="直接关闭"
                  value={!closeToTray}
                  onChange={(right) => applyCloseToTray(!right)}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 12 }}>界面主题</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>暗色或亮色,立即生效</div>
                </div>
                <SlideSwitch
                  leftLabel="暗色"
                  rightLabel="亮色"
                  value={theme === 'light'}
                  onChange={(light) => setTheme(light ? 'light' : 'dark')}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 12 }}>渲染效果</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {autoLite
                      ? '检测到当前是软件渲染,已自动用平面模式(更跟手)'
                      : '磨砂玻璃更精致,平面模式更跟手(显卡弱或远程桌面时选它)'}
                  </div>
                </div>
                <SlideSwitch
                  leftLabel="磨砂"
                  rightLabel="平面"
                  value={reduceEffects || autoLite}
                  onChange={applyReduceEffects}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 12 }}>工作小窗(桌宠)</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    桌面上放一个可拖动的小图标;点一下弹出小窗,只上下翻动,
                    { }
                    小窗里也能进设置
                  </div>
                </div>
                <SlideSwitch
                  leftLabel="关闭"
                  rightLabel="开启"
                  value={petEnabled}
                  onChange={applyPetEnabled}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 12 }}>小窗画面内容</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    图片为主:列表里图片左右交替、详情整屏看图;显示文字:带文件名与参数副标题
                  </div>
                </div>
                <SlideSwitch
                  leftLabel="显示文字"
                  rightLabel="图片为主"
                  value={petImageFirst}
                  onChange={applyPetImageFirst}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 12 }}>小窗点击穿透</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    开启后小窗不拦截鼠标,桌面操作直接落到下面的窗口;悬停到小图标/面板上会临时恢复交互。
                    右键小图标有菜单:打开主界面 / 展开收起 / 隐藏浮窗
                    (穿透开启后,先悬停小图标恢复交互,再右键开菜单)
                  </div>
                </div>
                <SlideSwitch
                  leftLabel="关闭"
                  rightLabel="开启"
                  value={petClickThrough}
                  onChange={applyPetClickThrough}
                />
              </div>

              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                <div style={{ fontSize: 12 }}>背景图片</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
                  选一张图当背景;面板、工具条和卡片仍然是磨砂玻璃,只是玻璃后面透出这张图。
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button type="button" style={btn} onClick={() => void chooseBackground()}>
                    选择图片…
                  </button>
                  {bgUrl ? (
                    <button type="button" style={{ ...btn, color: 'var(--muted)' }} onClick={() => void clearBackground()}>
                      清除背景
                    </button>
                  ) : null}
                  {bgUrl ? (
                    <span style={{ fontSize: 11, color: 'var(--muted)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {bgName}
                    </span>
                  ) : null}
                </div>
                {bgUrl ? (
                  <div style={{ display: 'flex', gap: 6, marginTop: 9 }}>
                    {(Object.keys(BG_FIT) as BgFit[]).map((k) => (
                      <button
                        key={k}
                        type="button"
                        style={
                          bgFit === k
                            ? { ...btn, borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' }
                            : btn
                        }
                        onClick={() => applyBgFit(k)}
                      >
                        {BG_FIT[k].label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                <div style={{ fontSize: 12, marginBottom: 8 }}>图库文件夹(可以加多个,放在不同盘也行)</div>
                {roots.length === 0 ? (
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>还没有图库文件夹,点下面的按钮添加。</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {roots.map((r) => (
                      <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={r.enabled}
                          title="取消勾选 = 不参与扫描"
                          onChange={(e) => void toggleRootEnabled(r.id, e.target.checked)}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.label}</div>
                          <div style={{ fontSize: 10.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.path}</div>
                        </div>
                        <button
                          type="button"
                          style={{ ...btn, padding: '3px 8px', fontSize: 11 }}
                          onClick={() => void rescanRoot(r.id, r.label)}
                        >
                          重新扫描
                        </button>
                        <button
                          type="button"
                          style={{ ...btn, padding: '3px 8px', fontSize: 11, color: 'var(--muted)' }}
                          onClick={() => openRemoveRoot(r)}
                        >
                          移除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <button type="button" style={{ ...btn, marginTop: 9 }} onClick={() => void addLibraryRoot()}>
                  + 添加图库文件夹
                </button>
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>
                  移除只删索引记录,磁盘上的图片不会被删;重新添加同一目录会重新扫描回来。
                </div>
              </div>

              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                <div style={{ fontSize: 12 }}>文件夹显示</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
                  勾上的文件夹才会出现在左侧栏;想改显示名就在左侧右键文件夹。
                </div>
                <FolderVisibilityTree
                  folders={folderList}
                  onToggle={(rootId, relDir, hidden) => void toggleFolderHidden(rootId, relDir, hidden)}
                />
              </div>

              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, fontSize: 11, color: 'var(--muted)' }}>
                作者:{AUTHOR_NAME} ·{' '}
                <a
                  href={REPO_URL}
                  onClick={(e) => {
                    e.preventDefault();
                    void window.api.openUrl(REPO_URL).catch(() => undefined);
                  }}
                  style={{ color: 'var(--accent)', textDecoration: 'none' }}
                >
                  {REPO_URL}
                </a>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {catPicker ? (
        <CategoryPicker
          categories={catList}
          imageIds={catPicker.ids}
          initialChecked={catPicker.initialChecked}
          closing={catPickerClosing}
          onClose={() => closeCatPicker()}
          onApplied={() => {
            refreshCategories();
            // 正在浏览某个分类:移出会让图离开当前视图,网格原地刷新
            if (query.categoryId !== undefined) void refresh();
            // 批量条场景:加入完成后收起选择,给用户一个明确的"做完了"收尾
            if (catPicker.ids.length > 1) closeSelection();
          }}
          notify={notify}
        />
      ) : null}

      {toast ? <div className={`cam-toast${toast.bad ? ' bad' : ''}${toastClosing ? ' closing' : ''}`}>{toast.msg}</div> : null}

      {/* 配方比对面板(z-index 380)与并排比对台(390):都压在详情/网格之上,
          但查看器(400)更高 —— 从比对列点图看原图时才不会被面板挡住 */}
      {compareReq ? (
        <ComparePanel
          baseId={compareReq.baseId}
          baseName={compareReq.baseName}
          basePrompt={compareReq.basePrompt}
          rows={compareRows}
          loading={compareLoading}
          error={compareError}
          mode={compareReq.canSwitch ? compareMode : null}
          onModeChange={switchCompareMode}
          selectedCount={compareReq.count}
          recipes={recipes}
          closing={compareClosing}
          onClose={() => closeCompareAll()}
          onOpenViewer={openLightboxInColumn}
          onComparePicked={(picked) => openCompareStage(picked)}
        />
      ) : null}

      {compareStageRows ? (
        <CompareStage rows={compareStageRows} closing={compareStageClosing} onClose={closeCompareStage} />
      ) : null}

      {/* 全屏原图查看器:压在所有弹层之上(z-index 400),Esc 先关它(见键盘钩子) */}
      {lightboxId !== null ? (
        <Lightbox
          rows={lbRows}
          id={lightboxId}
          closing={lightboxClosing}
          onClose={closeLightbox}
          onNavigate={openLightbox}
        />
      ) : null}
    </div>
  );
}

/* 控件材质统一走玻璃体系(--ctl-* / --radius-md):工具条里有 .cam-toolbar 的 !important 覆写,
   这里的值实际作用于弹层、设置面板等场景 */
const input: React.CSSProperties = {
  background: 'var(--ctl-bg)',
  border: '1px solid var(--ctl-border)',
  color: 'var(--fg)',
  borderRadius: 'var(--radius-md)',
  padding: '5px 9px',
  font: 'inherit',
  fontSize: 12,
  outline: 'none',
};

const btn: React.CSSProperties = {
  background: 'var(--ctl-bg)',
  border: '1px solid var(--ctl-border)',
  color: 'var(--fg)',
  borderRadius: 'var(--radius-md)',
  padding: '5px 10px',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
};

const menuSelect: React.CSSProperties = {
  display: 'block',
  width: 'calc(100% - 16px)',
  margin: '0 8px 6px',
  background: 'var(--ctl-bg)',
  border: '1px solid var(--ctl-border)',
  color: 'var(--fg)',
  borderRadius: 'var(--radius-md)',
  padding: '5px 8px',
  font: 'inherit',
  fontSize: 12,
  outline: 'none',
};

const warn: React.CSSProperties = {
  color: 'var(--warn)',
  fontSize: 11,
  padding: '4px 12px',
};
