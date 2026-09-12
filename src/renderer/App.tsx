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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FolderNode, LibraryRoot, SortKey } from '@shared/types';
import { errMsg, useCategories, useFolders, useImageDetail, useImages, useScanProgress, useStats } from './api';
import { CategoryTree, FolderTree, FolderVisibilityTree } from './components/Trees';
import { ImageGrid } from './components/ImageGrid';
import { DetailPanel } from './components/DetailPanel';

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

/** 作者与仓库:想换成自己的仓库地址,只改这两行 */
const AUTHOR_NAME = 'A3ther';
const REPO_URL = 'https://github.com/dashboard';

/** 背景铺法:裁切 / 拉伸 / 适应 / 平铺 */
const BG_FIT = {
  cover: { label: '裁切', size: 'cover', repeat: 'no-repeat', position: 'center' },
  stretch: { label: '拉伸', size: '100% 100%', repeat: 'no-repeat', position: 'center' },
  contain: { label: '适应', size: 'contain', repeat: 'no-repeat', position: 'center' },
  tile: { label: '平铺', size: 'auto', repeat: 'repeat', position: 'left top' },
} as const;
type BgFit = keyof typeof BG_FIT;

export function App() {
  const folders = useFolders();
  const categories = useCategories();
  const stats = useStats();
  const progress = useScanProgress();
  const { query, setQuery, rows, total, loading, error, tookMs, hasMore, loadMore, patchRow, removeRow } = useImages(120);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const detail = useImageDetail(selectedId);

  // 轻提示(收藏/分类/文件操作的结果反馈)
  const [toast, setToast] = useState<{ msg: string; bad: boolean } | null>(null);
  const toastTimer = useRef(0);
  const notify = useCallback((msg: string, bad = false) => {
    setToast({ msg, bad });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

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
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; node: FolderNode } | null>(null);
  const [aliasTarget, setAliasTarget] = useState<FolderNode | null>(null);
  // 移除图库是破坏性操作(索引会级联删除),必须二次确认
  const [removeRootTarget, setRemoveRootTarget] = useState<LibraryRoot | null>(null);
  const [aliasValue, setAliasValue] = useState('');

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [closeToTray, setCloseToTray] = useState(true);
  // 平面模式:关掉实时模糊与进场动画(显卡弱 / 远程桌面时用)
  const [reduceEffects, setReduceEffects] = useState(false);
  // 自定义背景图:URL 由主进程给(cam-bg:// 协议),铺法存设置
  const [bgUrl, setBgUrl] = useState<string | null>(null);
  const [bgFit, setBgFit] = useState<BgFit>('cover');
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

  /** 刷新:重新读当前筛选下的列表(新入库的图会立刻出现),同时刷新统计与文件夹树 */
  const refreshList = useCallback(() => {
    setQuery((q) => ({ ...q }));
    stats.reload();
    folders.reload();
    categories.reload();
    notify('已刷新');
  }, [categories, folders, notify, setQuery, stats]);

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
        setReduceEffects(s.reduceEffects === true);
        if (s.theme === 'light' || s.theme === 'dark') setTheme(s.theme);
        if (s.backgroundFit) setBgFit(s.backgroundFit as BgFit);
        if (s.backgroundImage) setBgName(s.backgroundImage.split(/[\\/]/).pop() ?? '');
        window.api.getBackgroundUrl().then(setBgUrl).catch(() => undefined);
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

  // ---- C2 多选:勾选框 / Ctrl+点击 / Shift+点击(选一段)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const anchorRef = useRef<number | null>(null);
  const handleSelect = useCallback(
    (id: number, mode: 'toggle' | 'range') => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
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
        return next;
      });
    },
    [rows]
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
      setSelectedIds(new Set());
      setQuery((q) => ({ ...q }));
    } catch (e) {
      notify(errMsg(e), true);
    }
  }, [notify, selectedIds, setQuery]);

  const batchDelete = useCallback(async () => {
    const ids = [...selectedIds];
    setConfirmBatchDelete(false);
    try {
      const r = await window.api.deleteImages(ids);
      for (const id of ids) removeRow(id);
      notify(`已删除 ${r.deleted} 张` + (r.errors.length ? `,失败 ${r.errors.length} 张` : ''));
      setSelectedIds(new Set());
      stats.reload();
    } catch (e) {
      notify(errMsg(e), true);
    }
  }, [notify, removeRow, selectedIds, stats]);

  // ---- 卡片右键菜单
  const [menu, setMenu] = useState<{ x: number; y: number; id: number } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  // 重命名弹层:目标 id + 输入框内容
  const [renameTarget, setRenameTarget] = useState<{ id: number; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const openMenu = useCallback((id: number, x: number, y: number) => {
    // 防止菜单超出窗口右/下边缘
    setMenu({ id, x: Math.min(x, window.innerWidth - 190), y: Math.min(y, window.innerHeight - 240) });
  }, []);

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
        setConfirmDeleteId(null);
        notify('已移入回收站');
      } catch (e) {
        notify(errMsg(e), true);
      }
    },
    [notify, removeRow, selectedId]
  );

  // 已加载行所属分类(与 rows 同序)。要按当前这批 id 查,不能用"全部图"的关系表。
  const [catsOf, setCatsOf] = useState<number[][]>([]);
  // 分类归属变化时 bump 一下,触发 catsOf 重取
  const [catsTick, setCatsTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    if (rows.length === 0) {
      setCatsOf([]);
      return;
    }
    (async () => {
      const pairs = await Promise.all(
        rows.map((r) => window.api.getImageCategories(r.id).catch(() => []))
      );
      if (!cancelled) setCatsOf(pairs);
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, catsTick]);

  // 分类增删改 / 图片归属变化后的统一刷新:树、网格标记、详情面板归属
  const refreshCategories = useCallback(() => {
    categories.reload();
    setCatsTick((t) => t + 1);
    detail.cats.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories.reload]);

  // 收藏切换:网格卡片与详情面板共用。本地 patch 行数据,避免整批重取;
  // 「只看收藏」视图下取消收藏要像 web 版一样立即刷新列表
  const toggleStar = useCallback(
    async (id: number, starred: boolean) => {
      try {
        await window.api.setStarred(id, starred);
        patchRow(id, { starred });
        if (detail.detail.data?.id === id) detail.detail.reload();
        if (query.starredOnly) setQuery((q) => ({ ...q }));
        notify(starred ? '已收藏' : '已取消收藏');
      } catch (e) {
        notify(errMsg(e), true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patchRow, query.starredOnly, setQuery, notify]
  );

  const catList = categories.data ?? [];
  const folderList = folders.data ?? [];

  // 当前视图里选中图的位置,用于详情面板的 ← → 翻页
  const viewIdx = useMemo(
    () => (selectedId === null ? -1 : rows.findIndex((r) => r.id === selectedId)),
    [rows, selectedId]
  );

  const prev = useCallback(() => {
    if (viewIdx > 0) setSelectedId(rows[viewIdx - 1].id);
  }, [rows, viewIdx]);
  const next = useCallback(() => {
    if (viewIdx >= 0 && viewIdx < rows.length - 1) setSelectedId(rows[viewIdx + 1].id);
  }, [rows, viewIdx]);

  // 键盘:Esc 关详情/菜单/设置,← → 翻页,/ 聚焦搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
        if (selectedIds.size) setSelectedIds(new Set());
        else if (menu) setMenu(null);
        else if (confirmBatchDelete) setConfirmBatchDelete(false);
        else if (removeRootTarget) setRemoveRootTarget(null);
        else if (confirmDeleteId !== null) setConfirmDeleteId(null);
        else if (settingsOpen) setSettingsOpen(false);
        else if (selectedId !== null) setSelectedId(null);
        return;
      }
      if (selectedId === null || menu || settingsOpen || confirmDeleteId !== null || renameTarget !== null) return;
      if (e.key === 'ArrowLeft') prev();
      if (e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, prev, next, setQuery, menu, settingsOpen, confirmDeleteId, renameTarget, selectedIds, refreshList]);

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

  const filt = stats.data;
  const scanning = progress && (progress.phase === 'parsing' || progress.phase === 'walking');

  // 扫描完成(手动扫描或 B2 自动入库)后刷新列表与统计,新图立刻出现
  const reloadersRef = useRef({ stats: stats.reload, folders: folders.reload, categories: categories.reload });
  reloadersRef.current = { stats: stats.reload, folders: folders.reload, categories: categories.reload };
  const lastScanDoneRef = useRef<number | null>(null);
  useEffect(() => {
    if (!progress || progress.phase !== 'done') return;
    const key = progress.finishedAt ?? 0;
    if (lastScanDoneRef.current === key) return;
    lastScanDoneRef.current = key;
    setQuery((q) => ({ ...q }));
    reloadersRef.current.stats();
    reloadersRef.current.folders();
    reloadersRef.current.categories();
  }, [progress, setQuery]);

  return (
    <div
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
        <div className="cam-toolbar cam-drag" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', paddingRight: 142 }}>
          <div className="cam-drag" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <img
              src="logo.png"
              alt=""
              width={30}
              height={30}
              style={{ borderRadius: 9, display: 'block', boxShadow: '0 2px 8px rgba(0,0,0,.35)' }}
            />
            <strong style={{ fontSize: 14, whiteSpace: 'nowrap' }}>A3 manager</strong>
          </div>
          <input
            id="cam-search"
            type="search"
            placeholder="搜索:文件名 / 提示词 / 模型 / LoRA / 文件夹…  (按 / 聚焦)"
            value={query.q ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              setQuery((q) => ({ ...q, q: v.trim() || undefined }));
            }}
            style={{ ...input, flex: 1, minWidth: 220, maxWidth: 420 }}
          />
          <select
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
            style={query.starredOnly ? { ...btn, background: 'var(--accent-soft)', borderColor: 'var(--accent)', color: 'var(--accent)' } : btn}
            onClick={() => setQuery((q) => ({ ...q, starredOnly: q.starredOnly ? undefined : true }))}
          >
            只看收藏
          </button>
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
            title="设置"
            style={{ ...btn, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}
            onClick={() => setSettingsOpen(true)}
          >
            <GearIcon />
            设置
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
          />
          {folders.error ? <div style={warn}>{errMsg(folders.error)}</div> : null}
          <FolderTree
            folders={folderList}
            activeDir={query.relDir ?? null}
            onPickDir={(relDir) =>
              setQuery((q) => ({ ...q, relDir: relDir ?? undefined, categoryId: undefined }))
            }
            onContextMenu={(node, x, y) =>
              setFolderMenu({
                node,
                x: Math.min(x, window.innerWidth - 210),
                y: Math.min(y, window.innerHeight - 110),
              })
            }
          />
        </aside>

        <div id="cam-scroll" className="cam-gridwrap" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {rows.length === 0 && !loading ? (
            <div style={{ padding: 48, textAlign: 'center', color: 'var(--muted)' }}>
              没有匹配的图片 —— 试着点「刷新」重读索引,或点「重置」清空筛选
              {stats.data?.totalImages === 0 ? (
                <div style={{ marginTop: 8, fontSize: 12 }}>
                  索引库是空的:先在「设置」里添加扫描目录并执行一次扫描。
                </div>
              ) : null}
            </div>
          ) : (
            <ImageGrid
              rows={rows}
              categories={catList}
              catsOf={catsOf}
              selectedId={selectedId}
              onOpen={setSelectedId}
              onToggleStar={(id, starred) => void toggleStar(id, starred)}
              onContextMenu={openMenu}
              selectedIds={selectedIds}
              onSelect={handleSelect}
            />
          )}
        </div>

        {selectedId !== null ? (
          <DetailPanel
            detail={detail.detail.data}
            categories={catList}
            catIds={detail.cats.data ?? []}
            onClose={() => setSelectedId(null)}
            onPrev={prev}
            onNext={next}
            canPrev={viewIdx > 0}
            canNext={viewIdx >= 0 && viewIdx < rows.length - 1}
            onToggleStar={(id, starred) => void toggleStar(id, starred)}
            onReveal={(id) =>
              void window.api.revealInExplorer(id).catch((e) => notify(errMsg(e), true))
            }
            onCopyPath={(id) =>
              void window.api
                .copyPath(id)
                .then(() => notify('路径已复制'))
                .catch((e) => notify(errMsg(e), true))
            }
            onChanged={refreshCategories}
            notify={notify}
          />
        ) : null}
      </main>

      {menu ? (
        <>
          <div
            className="cam-menu-mask"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div className="cam-menu" style={{ left: menu.x, top: menu.y }}>
            <button type="button" className="cam-menu-item" onClick={() => { setMenu(null); setSelectedId(menu.id); }}>
              查看参数
            </button>
            <button type="button" className="cam-menu-item" onClick={() => { setMenu(null); void window.api.openExternal(menu.id).catch((e) => notify(errMsg(e), true)); }}>
              打开图片
            </button>
            <button type="button" className="cam-menu-item" onClick={() => { setMenu(null); void window.api.revealInExplorer(menu.id).catch((e) => notify(errMsg(e), true)); }}>
              打开所在位置
            </button>
            <div className="cam-menu-sep" />
            <button type="button" className="cam-menu-item" onClick={() => { setMenu(null); void copyPositivePrompt(menu.id); }}>
              复制正向提示词
            </button>
            <button type="button" className="cam-menu-item" onClick={() => { setMenu(null); void window.api.copyPath(menu.id).then(() => notify('路径已复制')).catch((e) => notify(errMsg(e), true)); }}>
              复制文件路径
            </button>
            <button
              type="button"
              className="cam-menu-item"
              onClick={() => {
                const row = menuRow;
                setMenu(null);
                setRenameValue((row?.fileName ?? '').replace(/\.png$/i, ''));
                setRenameTarget({ id: menu.id, name: row?.fileName ?? '' });
              }}
            >
              重命名…
            </button>
            <button type="button" className="cam-menu-item" onClick={() => { setMenu(null); void toggleStar(menu.id, !(menuRow?.starred ?? false)); }}>
              {menuRow?.starred ? '取消收藏' : '收藏'}
            </button>
            <div className="cam-menu-sep" />
            <button type="button" className="cam-menu-item" onClick={() => { setMenu(null); void window.api.copyImageToClipboard(menu.id).then(() => notify('图片已复制到剪贴板')).catch((e) => notify(errMsg(e), true)); }}>
              复制图片(剪贴板)
            </button>
            <button type="button" className="cam-menu-item" onClick={() => { setMenu(null); void window.api.copyImageToFolder(menu.id).then((r) => { if (r) notify('已复制到 ' + r.copiedTo); }).catch((e) => notify(errMsg(e), true)); }}>
              复制到文件夹…
            </button>
            <button type="button" className="cam-menu-item" onClick={() => { setMenu(null); void moveImage(menu.id); }}>
              移动到文件夹…
            </button>
            <button type="button" className="cam-menu-item danger" onClick={() => { setConfirmDeleteId(menu.id); setMenu(null); }}>
              删除(移入回收站)
            </button>
          </div>
        </>
      ) : null}

      {renameTarget !== null ? (
        <div
          className="cam-modal"
          onClick={(e) => { if (e.target === e.currentTarget) setRenameTarget(null); }}
        >
          <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, width: 420, padding: '16px 18px' }}>
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
                    setRenameTarget(null);
                  })
                  .catch((e) => notify(errMsg(e), true));
              }}
            >
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setRenameTarget(null);
                }}
                style={{ ...input, width: '100%', marginBottom: 14 }}
              />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" style={btn} onClick={() => setRenameTarget(null)}>
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
        <div className="cam-modal" onClick={(e) => { if (e.target === e.currentTarget) setConfirmDeleteId(null); }}>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, width: 380, padding: '16px 18px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>删除这张图片?</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
              文件会移入系统回收站,可以从回收站恢复;索引记录会立即移除。
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" style={btn} onClick={() => setConfirmDeleteId(null)}>
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

      {selectedIds.size > 0 ? (
        <div className="cam-selectbar">
          <span style={{ fontSize: 12 }}>已选 {selectedIds.size} 张</span>
          <button type="button" style={btn} onClick={() => setSelectedIds(new Set(rows.map((r) => r.id)))}>
            全选本页
          </button>
          <button type="button" style={btn} onClick={() => void batchMove()}>
            移动…
          </button>
          <button type="button" style={{ ...btn, borderColor: 'var(--bad)', color: 'var(--bad)' }} onClick={() => setConfirmBatchDelete(true)}>
            删除
          </button>
          <button type="button" style={btn} onClick={() => setSelectedIds(new Set())}>
            取消选择
          </button>
        </div>
      ) : null}

      {confirmBatchDelete ? (
        <div className="cam-modal" onClick={(e) => { if (e.target === e.currentTarget) setConfirmBatchDelete(false); }}>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, width: 400, padding: '16px 18px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>删除选中的 {selectedIds.size} 张图片?</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
              文件会全部移入系统回收站(可恢复),索引记录立即移除。
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" style={btn} onClick={() => setConfirmBatchDelete(false)}>取消</button>
              <button type="button" style={{ ...btn, borderColor: 'var(--bad)', color: 'var(--bad)' }} onClick={() => void batchDelete()}>
                删除 {selectedIds.size} 张
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {removeRootTarget ? (
        <div className="cam-modal" onClick={(e) => { if (e.target === e.currentTarget) setRemoveRootTarget(null); }}>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, width: 440, padding: '16px 18px' }}>
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
              <button type="button" style={btn} onClick={() => setRemoveRootTarget(null)}>取消</button>
              <button
                type="button"
                style={{ ...btn, borderColor: 'var(--bad)', color: 'var(--bad)' }}
                onClick={() => {
                  const target = removeRootTarget;
                  setRemoveRootTarget(null);
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
          <div className="cam-menu-mask" onClick={() => setFolderMenu(null)} onContextMenu={(e) => { e.preventDefault(); setFolderMenu(null); }} />
          <div className="cam-menu" style={{ left: folderMenu.x, top: folderMenu.y }}>
            <button
              type="button"
              className="cam-menu-item"
              onClick={() => {
                const n = folderMenu.node;
                setFolderMenu(null);
                setAliasValue(n.alias ?? '');
                setAliasTarget(n);
              }}
            >
              重命名(备注)…
            </button>
            <button
              type="button"
              className="cam-menu-item"
              onClick={() => {
                const n = folderMenu.node;
                setFolderMenu(null);
                void toggleFolderHidden(n.rootId, n.relDir, !(n.hidden ?? false));
              }}
            >
              {folderMenu.node.hidden ? '恢复到左侧栏' : '在左侧栏隐藏'}
            </button>
          </div>
        </>
      ) : null}

      {aliasTarget ? (
        <div className="cam-modal" onClick={(e) => { if (e.target === e.currentTarget) setAliasTarget(null); }}>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, width: 420, padding: '16px 18px' }}>
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
                setAliasTarget(null);
              }}
            >
              <input
                autoFocus
                value={aliasValue}
                onChange={(e) => setAliasValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setAliasTarget(null); }}
                style={{ ...input, width: '100%', marginBottom: 14 }}
              />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" style={btn} onClick={() => setAliasTarget(null)}>取消</button>
                <button type="submit" style={{ ...btn, borderColor: 'var(--accent)', color: 'var(--accent)' }}>确定</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {settingsOpen ? (
        <div className="cam-modal" onClick={(e) => { if (e.target === e.currentTarget) setSettingsOpen(false); }}>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, width: 520, maxHeight: '82vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
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
                          onClick={() => setRemoveRootTarget(r)}
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

      {toast ? <div className={`cam-toast${toast.bad ? ' bad' : ''}`}>{toast.msg}</div> : null}
    </div>
  );
}

const input: React.CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  color: 'var(--fg)',
  borderRadius: 6,
  padding: '5px 9px',
  font: 'inherit',
  fontSize: 12,
  outline: 'none',
};

const btn: React.CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  color: 'var(--fg)',
  borderRadius: 6,
  padding: '5px 10px',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
};

const warn: React.CSSProperties = {
  color: 'var(--warn)',
  fontSize: 11,
  padding: '4px 12px',
};
