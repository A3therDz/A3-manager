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
    openExternal: (id) => {
      window.open(`/api/file/${id}`, '_blank');
      return Promise.resolve();
    },
    copyPath: async (id) => {
      const d = await http<ImageDetail>('GET', `/api/image/${id}`);
      await navigator.clipboard.writeText(d.absPath);
    },
    deleteImage: () => desktopOnly('删除图片'),
    moveImage: () => desktopOnly('移动图片'),
    renameImage: () => desktopOnly('重命名图片'),
    copyImageToClipboard: () => desktopOnly('复制图片到剪贴板'),
    copyImageToFolder: () => desktopOnly('复制图片到文件夹'),
    deleteImages: () => desktopOnly('批量删除'),
    moveImages: () => desktopOnly('批量移动'),

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
export function useImages(pageSize = 120) {
  const [query, setQuery] = useState<ImageQuery>({ sort: 'mtime_desc' });
  const [page, setPage] = useState(0);
  const [ids, setIds] = useState<number[]>([]);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<ImageRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tookMs, setTookMs] = useState(0);

  // query 变化时重置到第一页
  useEffect(() => {
    setPage(0);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res: ImageQueryResult = await window.api.queryImages({
          ...query,
          offset: page * pageSize,
          limit: pageSize,
        });
        if (cancelled) return;
        setTotal(res.total);
        setTookMs(res.tookMs);
        setIds((prev) => (page === 0 ? res.ids : [...prev, ...res.ids]));
        // 只为新出现的那一段取详情,避免整表重取
        const batch = await window.api.getImagesByIds(res.ids);
        if (cancelled) return;
        const clean = batch.filter(Boolean) as ImageRecord[];
        setRows((prev) => (page === 0 ? clean : [...prev, ...clean]));
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

  const hasMore = useMemo(() => rows.length < total, [rows.length, total]);
  const loadMore = useCallback(() => {
    if (!loading && rows.length < total) setPage((p) => p + 1);
  }, [loading, rows.length, total]);

  /** 局部更新某一行(如收藏状态),不触发整批重取 */
  const patchRow = useCallback((id: number, patch: Partial<ImageRecord>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  /** 从列表移除某一行(删除/移出图库后),总数同步减一 */
  const removeRow = useCallback((id: number) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
    setIds((prev) => prev.filter((x) => x !== id));
    setTotal((t) => Math.max(0, t - 1));
  }, []);

  return { query, setQuery, ids, rows, total, loading, error, tookMs, hasMore, loadMore, patchRow, removeRow };
}

/** 扫描进度订阅 */
export function useScanProgress(): ScanProgress | null {
  const [p, setP] = useState<ScanProgress | null>(null);
  useEffect(() => {
    const off = window.api.onScanProgress(setP);
    // 先取一次当前状态,避免订阅前的进度丢失
    window.api.getScanProgress().then(setP).catch(() => undefined);
    return off;
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
