/**
 * 前端 API 客户端。
 *
 * 这一层的目的:把 preload 暴露的 window.api 收口到一处,并提供
 *   - 统一的错误处理(主进程返回的错误已经拆成 throw,这里只做兜底)
 *   - React 友好的 hook(getFolders / getCategories / useImages)
 *   - 缩略图 URL 的唯一生成入口
 *
 * 契约真源是 src/shared/types.ts。这里**不发明任何新字段**,
 * 只做搬运与缓存;要加能力先改 types.ts 再改主进程。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CategoryNode, FolderNode, ImageQuery, ImageQueryResult,
  ImageRecord, ImageDetail, LibraryStats, ScanProgress, ApiSurface, AppSettings,
} from '@shared/types';
import type { RecipeRecord } from '@shared/recipes';

// ---------------------------------------------------------------- 浏览器调试兜底
//
// 桌面版里 window.api 由 preload 注入;纯浏览器调试(npm run dev + 5174 的
// HTTP 服务)时没有 preload,这里用 /api 拼一个同签名的实现。
// 返回值的拆包规则与 preload 完全一致:{ ok:true, data } / { ok:false, error }。

async function http<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };
  if (j.ok !== true) throw new Error(j.error || `HTTP ${res.status}`);
  return j.data as T;
}

function desktopOnly(name: string): never {
  throw new Error(`「${name}」仅在桌面版可用,浏览器调试模式下不支持`);
}

function createHttpApi(): ApiSurface {
  return {
    // 库管理
    listRoots: () => http('GET', '/api/roots'),
    addRoot: (p, label) => http('POST', '/api/roots', { path: p, label }),
    removeRoot: (id) => http<void>('DELETE', `/api/roots/${id}`),
    setRootEnabled: (id, enabled) => http<void>('POST', `/api/roots/${id}/enabled`, { enabled }),

    // 扫描
    startScan: (rootIds, force) => http('POST', '/api/scan', { rootIds, force }),
    cancelScan: () => http<void>('POST', '/api/scan/cancel'),
    getScanProgress: () => http('GET', '/api/scan/progress'),
    onScanProgress: (cb) => {
      // 服务端用 SSE 推送(data: <ScanProgress JSON>),默认事件类型
      const es = new EventSource('/api/scan/events');
      es.onmessage = (ev) => {
        try {
          cb(JSON.parse(ev.data as string) as ScanProgress);
        } catch {
          /* 忽略坏帧 */
        }
      };
      return () => es.close();
    },

    // 浏览
    queryImages: (query) => http('POST', '/api/query', query),
    getImage: (id) => http('GET', `/api/image/${id}`),
    getImagesByIds: (ids) =>
      ids.length ? http('GET', `/api/images/${ids.join(',')}`) : Promise.resolve([]),
    getFolderTree: (rootId) => http('GET', rootId ? `/api/tree?rootId=${rootId}` : '/api/tree'),
    getFolderPrefs: () => Promise.resolve([]),
    setFolderPref: () => desktopOnly('文件夹显示设置'),
    pickDirectory: () => desktopOnly('选择目录'),
    pickImageFile: () => desktopOnly('选择背景图片'),
    openUrl: (url) => { window.open(url, '_blank'); return Promise.resolve(); },
    windowMinimize: () => desktopOnly('最小化窗口'),
    windowToggleMaximize: () => desktopOnly('最大化窗口'),
    windowClose: () => desktopOnly('关闭窗口'),
    isWindowMaximized: () => Promise.resolve(false),
    getBackgroundUrl: () => Promise.resolve(null),
    getStats: (rootId) => http('GET', rootId ? `/api/stats?rootId=${rootId}` : '/api/stats'),
    getFilterOptions: () => http('GET', '/api/filters'),

    // 用户自定义分类
    getCategoryTree: () => http('GET', '/api/categories'),
    createCategory: (input) => http('POST', '/api/categories', input),
    updateCategory: (id, patch) => http('PATCH', `/api/categories/${id}`, patch),
    deleteCategory: (id, deleteChildren) =>
      http<void>('DELETE', `/api/categories/${id}?children=${deleteChildren === true}`),
    setCategoryMembers: (categoryId, imageIds, member) =>
      http<void>('POST', `/api/categories/${categoryId}/members`, { imageIds, member }),
    getImageCategories: (imageId) => http('GET', `/api/image/${imageId}/categories`),

    // 操作
    setStarred: (id, starred) => http<void>('POST', `/api/star/${id}`, { starred }),
    revealInExplorer: () => desktopOnly('在资源管理器中定位'),
    openFolder: () => desktopOnly('打开文件夹所在位置'),
    inspectFile: () => desktopOnly('解析拖入图片的元数据'),
    getPathForFile: () => '',
    copyImageWithoutMetadata: () => desktopOnly('复制无元数据图片'),
    // 工作小窗只在桌面版有意义;浏览器调试下返回一份静态状态,方便预览界面
    getPetState: () =>
      Promise.resolve({
        enabled: false,
        theme: 'dark' as const,
        iconSize: 64,
        panelSize: { width: 430, height: 620 },
        position: null,
        reduceEffects: false,
        imageFirst: true,
        clickThrough: false,
        lastRelDir: null,
      }),
    setPetPosition: () => Promise.resolve(),
    setPetLayout: () => Promise.resolve(),
    focusMainWindow: () => Promise.resolve(),
    onPetStateChanged: () => () => {},
    movePetWindow: () => Promise.resolve(),
    closePetWindow: () => Promise.resolve(),
    setPetIgnoreMouse: () => Promise.resolve(),
    openExternal: (id) => {
      window.open(`/api/file/${id}`, '_blank');
      return Promise.resolve();
    },
    copyPath: async (id) => {
      const d = await http<ImageDetail>('GET', `/api/image/${id}`);
      await navigator.clipboard.writeText(d.absPath);
    },
    copyText: async (text) => {
      await navigator.clipboard.writeText(text);
    },
    // 拖出原文件走 Electron 原生 startDrag,浏览器调试下没有这个东西;静默忽略即可
    dragOutImages: () => {},
    deleteImage: () => desktopOnly('删除图片'),
    moveImage: () => desktopOnly('移动图片'),
    renameImage: () => desktopOnly('重命名图片'),
    copyImageToClipboard: () => desktopOnly('复制图片到剪贴板'),
    copyImageToFolder: () => desktopOnly('复制图片到文件夹'),
    deleteImages: () => desktopOnly('批量删除'),
    moveImages: () => desktopOnly('批量移动'),
    copyImagesToFolder: () => desktopOnly('批量复制'),

    // 设置:浏览器版用 localStorage 兜底(只影响界面,不影响托盘行为)
    getSettings: () => {
      try {
        const raw = localStorage.getItem('cam-settings');
        return Promise.resolve({ closeToTray: true, theme: 'dark', reduceEffects: false, backgroundImage: null, backgroundFit: 'cover', ...(raw ? JSON.parse(raw) : {}) } as AppSettings);
      } catch {
        return Promise.resolve({ closeToTray: true, theme: 'dark', reduceEffects: false, backgroundImage: null, backgroundFit: 'cover' } as AppSettings);
      }
    },
    setSettings: (patch) => {
      const cur = { closeToTray: true, theme: 'dark', reduceEffects: false, backgroundImage: null, backgroundFit: 'cover', ...JSON.parse(localStorage.getItem('cam-settings') ?? '{}') };
      const next = { ...cur, ...patch };
      localStorage.setItem('cam-settings', JSON.stringify(next));
      return Promise.resolve(next as AppSettings);
    },

    // 缩略图:浏览器版直接用原图字节流,由浏览器缩放
    getThumbUrl: (id) => `/api/file/${id}`,
    // 原图:浏览器调试本来就走 /api/file
    getFileUrl: (id) => `/api/file/${id}`,

    // LoRA 配方:浏览器调试后端没有对应端点,保持契约形状的空实现
    listRecipes: () => Promise.resolve([] as RecipeRecord[]),
    saveRecipe: (r) => Promise.resolve(r),
    deleteRecipe: () => Promise.resolve(),
    recipeCoverUrl: () => '',

    // 应用
    getAppInfo: () => desktopOnly('getAppInfo'),
    setAutoLaunch: () => desktopOnly('setAutoLaunch'),
    quitApp: () => http<void>('POST', '/api/shutdown'),
  };
}

// 没有 preload 注入(纯浏览器)时安装 HTTP 版实现
if (typeof window !== 'undefined' && !window.api) {
  window.api = createHttpApi();
}

/** 缩略图 URL。桌面版走自定义协议(并发加载,不走 IPC) */
export function thumbUrl(id: number): string {
  return window.api.getThumbUrl(id);
}

/** 原图 URL。详情预览用,清晰度优先(缩略图只有几百像素) */
export function fileUrl(id: number): string {
  return window.api.getFileUrl(id);
}

/** 配方封面 URL(cam-recipe 协议;无封面时加载失败,调用方用 onError 隐藏) */
export function recipeCoverUrl(id: string): string {
  return window.api.recipeCoverUrl(id);
}

/** 统一的错误消息提取 */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// ---------------------------------------------------------------- 数据 hook

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** 通用只读数据 hook:挂载时拉一次,可手动 reload */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // 组件卸载后不再 setState,避免 React 警告
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fn()
      .then((v) => {
        if (!cancelled && alive.current) setData(v);
      })
      .catch((e) => {
        if (!cancelled && alive.current) setError(errMsg(e));
      })
      .finally(() => {
        if (!cancelled && alive.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // fn 由调用方用 deps 控制,这里显式忽略其身份变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, reload };
}

export function useFolders(): AsyncState<FolderNode[]> {
  return useAsync(() => window.api.getFolderTree(), []);
}

export function useCategories(): AsyncState<CategoryNode[]> {
  return useAsync(() => window.api.getCategoryTree(), []);
}

export function useStats(): AsyncState<LibraryStats> {
  return useAsync(() => window.api.getStats(), []);
}

/** 分页浏览:维护 query / 页大小 / 已加载页,支持下拉无限滚动 */
export function useImages(pageSize = 120, initialQuery?: ImageQuery) {
  const [query, setQuery] = useState<ImageQuery>(initialQuery ?? { sort: 'mtime_desc' });
  const [page, setPage] = useState(0);
  const [ids, setIds] = useState<number[]>([]);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<ImageRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tookMs, setTookMs] = useState(0);

  // 已加载 id/行的实时副本:追加去重与原地刷新都要读到"此刻"的值
  const idsRef = useRef<number[]>([]);
  const rowsRef = useRef<ImageRecord[]>([]);
  const queryRef = useRef(query);
  queryRef.current = query;
  /** 标签页切换时一次性恢复"上次已加载的范围"(>pageSize 时首页直接拉整段) */
  const restoreCountRef = useRef(0);

  // query 变化时重置到第一页
  useEffect(() => {
    setPage(0);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // 恢复标签页:首页直接把"上次已加载的范围"整段拉回来,避免一页页重追
    const limit = page === 0 && restoreCountRef.current > 0 ? restoreCountRef.current : pageSize;
    (async () => {
      try {
        const res: ImageQueryResult = await window.api.queryImages({
          ...query,
          offset: page * pageSize,
          limit,
        });
        if (cancelled) return;
        setTotal(res.total);
        setTookMs(res.tookMs);
        // offset 分页的固有漂移:排序头部插入新图后,后面每一页都会重复一段 ——
        // 追加时按 id 去重,不然同一行渲染两遍,网格会"跳一下"
        const prevIds = page === 0 ? [] : idsRef.current;
        const seen = new Set(prevIds);
        const freshIds = res.ids.filter((x) => !seen.has(x));
        // 只为新出现的那一段取详情,避免整表重取
        const batch = await window.api.getImagesByIds(freshIds);
        if (cancelled) return;
        const clean = batch.filter(Boolean) as ImageRecord[];
        const nextIds = page === 0 ? freshIds : [...prevIds, ...freshIds];
        const nextRows = page === 0 ? clean : [...rowsRef.current, ...clean];
        idsRef.current = nextIds;
        rowsRef.current = nextRows;
        setIds(nextIds);
        setRows(nextRows);
        if (page === 0 && restoreCountRef.current > 0) {
          // 整段恢复完毕:页码对齐到段尾,loadMore 从正确位置继续
          restoreCountRef.current = 0;
          setPage(Math.max(0, Math.ceil(nextIds.length / pageSize) - 1));
        }
      } catch (e) {
        if (!cancelled) setError(errMsg(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, page, pageSize]);

  /**
   * 原地刷新:重新拉取"当前已加载范围"的数据并整体替换,
   * **不重置页码、不动滚动位置** —— 新入库的图立刻出现,但列表不会跳回顶部。
   * (以前的写法是 setQuery(q=>({...q})),等于推倒重来:页码归零、滚动跳顶,
   *  扫描 watcher 一触发用户就被甩回第一张。)
   *
   * 只为主键列表里没有的 id 取行数据:已加载几千行时,整批重取会
   * 产生一次大 IPC + 全量 React 行对象重建,新图入库那一下就会卡。
   * 没变过的行保留原对象引用,卡片组件(memo)直接跳过重渲染。
   */
  const refresh = useCallback(async () => {
    const count = Math.max(pageSize, idsRef.current.length);
    try {
      const res: ImageQueryResult = await window.api.queryImages({
        ...queryRef.current,
        offset: 0,
        limit: count,
      });
      const known = new Map(rowsRef.current.map((r) => [r.id, r]));
      const missing = res.ids.filter((id) => !known.has(id));
      const fetched = missing.length ? await window.api.getImagesByIds(missing) : [];
      const fresh = new Map(fetched.filter(Boolean).map((r) => [(r as ImageRecord).id, r as ImageRecord]));
      // 以查询返回的 id 顺序为准:已知的复用旧行,新来的用新行,消失的丢弃
      const clean = res.ids
        .map((id) => fresh.get(id) ?? known.get(id))
        .filter(Boolean) as ImageRecord[];
      idsRef.current = res.ids;
      rowsRef.current = clean;
      setIds(res.ids);
      setRows(clean);
      setTotal(res.total);
      setTookMs(res.tookMs);
      // 页码与新长度对齐,下一次 loadMore 从正确的位置继续
      setPage((p) => {
        const aligned = Math.max(0, Math.ceil(res.ids.length / pageSize) - 1);
        return aligned === p ? p : aligned;
      });
    } catch (e) {
      setError(errMsg(e));
    }
  }, [pageSize]);

  const hasMore = useMemo(() => rows.length < total, [rows.length, total]);
  const loadMore = useCallback(() => {
    if (!loading && rows.length < total) setPage((p) => p + 1);
  }, [loading, rows.length, total]);

  /** 局部更新某一行(如收藏状态),不触发整批重取 */
  const patchRow = useCallback((id: number, patch: Partial<ImageRecord>) => {
    rowsRef.current = rowsRef.current.map((r) => (r.id === id ? { ...r, ...patch } : r));
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  /** 从列表移除某一行(删除/移出图库后),总数同步减一 */
  const removeRow = useCallback((id: number) => {
    rowsRef.current = rowsRef.current.filter((r) => r.id !== id);
    idsRef.current = idsRef.current.filter((x) => x !== id);
    setRows((prev) => prev.filter((r) => r.id !== id));
    setIds((prev) => prev.filter((x) => x !== id));
    setTotal((t) => Math.max(0, t - 1));
  }, []);

  /**
   * 标签页切换:换成目标标签的查询,并把它上次已加载的范围一次性拉回来
   * (首页 limit = loadedCount,而不是从第一页 120 张重新追)。
   */
  const restore = useCallback((q: ImageQuery, loadedCount: number) => {
    restoreCountRef.current = Math.max(pageSize, loadedCount);
    setQuery(q);
  }, [pageSize]);

  return { query, setQuery, ids, rows, total, loading, error, tookMs, hasMore, loadMore, refresh, restore, patchRow, removeRow };
}

/** 扫描进度订阅 */
export function useScanProgress(): ScanProgress | null {
  const [p, setP] = useState<ScanProgress | null>(null);
  useEffect(() => {
    /**
     * 进行中(walking/parsing)的进度事件很密,每次都 setState 会让整个 App
     * (含整张网格)跟着重渲染。这里把进行中的更新节流到 ~4Hz;
     * 阶段切换与 done/error/cancelled 永远立刻透传,不丢终态。
     */
    let last = 0;
    let pending: ScanProgress | null = null;
    let timer = 0;
    const flush = () => {
      timer = 0;
      if (pending) {
        setP(pending);
        pending = null;
      }
    };
    const push = (next: ScanProgress) => {
      const terminal = next.phase !== 'walking' && next.phase !== 'parsing';
      if (terminal) {
        window.clearTimeout(timer);
        timer = 0;
        pending = null;
        last = Date.now();
        setP(next);
        return;
      }
      const now = Date.now();
      if (now - last >= 250) {
        last = now;
        window.clearTimeout(timer);
        timer = 0;
        pending = null;
        setP(next);
      } else {
        pending = next;
        if (!timer) timer = window.setTimeout(flush, 250 - (now - last));
      }
    };
    const off = window.api.onScanProgress(push);
    // 先取一次当前状态,避免订阅前的进度丢失
    window.api.getScanProgress().then(push).catch(() => undefined);
    return () => {
      window.clearTimeout(timer);
      off();
    };
  }, []);
  return p;
}

/** 详情面板需要的数据:图片详情 + 所属分类 */
export function useImageDetail(id: number | null) {
  const detail = useAsync<ImageDetail | null>(
    () => (id === null ? Promise.resolve(null) : window.api.getImage(id)),
    [id]
  );
  const cats = useAsync<number[]>(
    () => (id === null ? Promise.resolve([]) : window.api.getImageCategories(id)),
    [id]
  );
  return { detail, cats };
}
