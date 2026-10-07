/**
 * 工作小窗(桌宠)入口。
 *
 * 设计要点:
 *  - 窗口是**透明置顶**的,布局只有两种:图标态(正方形小窗)与展开态(图标 + 面板)。
 *  - 展开先把窗口 setBounds 到位、再渲染对应布局(flushSync),反过来做会让图标/面板
 *    短暂画出窗口外;收起则相反 —— 先让面板原地播退场动画,播完才缩窗,
 *    否则动画在提交前就被窗口边界裁掉了。
 *  - 面板默认是**全部图片的卡片流**;文件夹用树形结构,只显示名字,点名字进对应文件夹。
 *  - 拖动一律在图标态进行:展开态下按住图标会先收起再拖,
 *    否则拖动时窗口缩成图标大小而面板还按展开画,两个一起"消失"。
 */

import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { FolderNode, ImageQueryResult, ImageRecord } from '@shared/types';
import './pet.css';

// 小窗图标资源:与 pet.html 同目录(dev 是项目根,打包后在 dist/renderer)
import iconUrl from './pet-icon.png';

const iconSrc = iconUrl;



const api = window.api as unknown as {
  getPetState(): Promise<{
    enabled: boolean;
    theme: 'dark' | 'light';
    iconSize: number;
    panelSize: { width: number; height: number };
    position: { x: number; y: number } | null;
    reduceEffects: boolean;
    imageFirst: boolean;
    clickThrough: boolean;
  }>;
  setPetPosition(p: { x: number; y: number }): Promise<void>;
  setPetLayout(p: { iconSize?: number; panelSize?: { width: number; height: number } }): Promise<void>;
  focusMainWindow(): Promise<void>;
  onPetStateChanged(cb: () => void): () => void;
  movePetWindow(b: { x: number; y: number; width: number; height: number }): Promise<void>;
  closePetWindow(): Promise<void>;
  setPetIgnoreMouse(ignore: boolean): Promise<void>;
  getFolderTree(rootId?: number): Promise<FolderNode[]>;
  queryImages(q: Record<string, unknown>): Promise<ImageQueryResult>;
  getImagesByIds(ids: number[]): Promise<ImageRecord[]>;
  getImage(id: number): Promise<ImageRecord & { meta: Record<string, unknown> | null; siblings?: number[] }>;
  setSettings(patch: Record<string, unknown>): Promise<unknown>;
};

/**
 * 一次性算出窗口矩形 + 面板/图标在窗口内的位置。
 *
 * 为什么要"单一真源":之前面板位置与窗口位置各算一遍,展开时窗口矩形没跟着变,
 * 结果窗口只覆盖了图标那一小块、面板被挤到图标下方,看起来就是"点开后图标消失/错位"。
 *
 * 布局规则:面板在上、图标在下,中间留 GAP;整体夹进屏幕可视区域。
 */
const GAP = 10;
/** 收起退场动画时长:与 pet.css 的 pet-panel-out 保持一致 */
const CLOSE_MS = 170;
/** 图标右键菜单的估计尺寸(撑大窗口与夹紧时用) */
const MENU_W = 168;
const MENU_H = 118;

/**
 * 窗口当前所在屏的可用区域(DIP)。
 * availLeft/availTop 在 TS 的 DOM 类型里还没有(Chrome/Edge 早就支持),手动补类型。
 * 多屏注意:副屏在左侧/上方时原点是负数,不能写死 (0,0)。
 */
function currentWorkArea() {
  const s = window.screen as Screen & { availLeft?: number; availTop?: number };
  return {
    x: s.availLeft ?? 0,
    y: s.availTop ?? 0,
    width: s.availWidth,
    height: s.availHeight,
  };
}

function layout(open: boolean, iconScreen: { x: number; y: number }, iconSize: number, panel: { width: number; height: number }) {
  const wa = currentWorkArea();
  const icon = { x: iconScreen.x, y: iconScreen.y, width: iconSize, height: iconSize };

  if (!open) {
    return { win: icon, panelLocal: null as null | { x: number; y: number }, iconLocal: { x: 0, y: 0 } };
  }

  const w = Math.min(panel.width, wa.width - 16);
  const h = Math.min(panel.height, wa.height - 16 - iconSize - GAP - 8);
  const totalH = h + GAP + iconSize;

  // 水平:面板尽量以图标为中心,并夹进可视区域
  const panelX = Math.max(wa.x, Math.min(icon.x + iconSize / 2 - w / 2, wa.x + wa.width - w));
  // 窗口左右边界要**同时**容下面板与图标 —— 否则图标靠屏幕右边时面板会被窗口裁掉
  const left = Math.min(icon.x, panelX);
  const right = Math.max(icon.x + iconSize, panelX + w);
  // 垂直:图标停在原处,窗口上边界由"面板 + 间距 + 图标"反推;贴底时上移一点保证装得下
  const originY = Math.max(wa.y, Math.min(icon.y, wa.y + wa.height - totalH));

  return {
    win: { x: left, y: originY, width: right - left, height: totalH },
    panelLocal: { x: panelX - left, y: 0 },
    iconLocal: { x: icon.x - left, y: h + GAP },
  };
}

type View =
  | { kind: 'tree' }
  | { kind: 'cards'; relDir: string; rootId?: number; title: string }
  | { kind: 'image'; id: number }
  | { kind: 'settings' }
  | { kind: 'setting'; which: SettingKey };

type SettingKey = 'icon' | 'panel' | 'image' | 'theme' | 'effects' | 'main';

/** 默认视图:全部图片(跨所有图库,按时间倒序) */
const ALL_CARDS: Extract<View, { kind: 'cards' }> = { kind: 'cards', relDir: '', title: '全部图片' };

function PetApp() {
  const [state, setState] = React.useState<Awaited<ReturnType<typeof api.getPetState>> | null>(null);
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState<View>(ALL_CARDS);
  // 记住最近的卡片视图:从树/详情/设置返回时落回这里
  const lastCardsRef = React.useRef<View>(ALL_CARDS);

  // 图标的屏幕坐标:拖动与主进程回调都会更新它
  const [iconPos, setIconPos] = React.useState<{ x: number; y: number } | null>(null);
  const [folders, setFolders] = React.useState<FolderNode[]>([]);
  /** 树节点的展开状态,key = rootId|relDir;没记过时根节点默认展开 */
  const [treeOpen, setTreeOpen] = React.useState<Record<string, boolean>>({});
  const [cards, setCards] = React.useState<ImageRecord[]>([]);
  const [detail, setDetail] = React.useState<(ImageRecord & { meta: Record<string, unknown> | null }) | null>(null);
  const [busy, setBusy] = React.useState(false);
  // 「图片优先」时默认不占画面显示参数,想看再点开
  const [showInfo, setShowInfo] = React.useState(false);
  // 同目录兄弟图:详情页左右切换
  const [neighbors, setNeighbors] = React.useState<number[]>([]);
  const [detailIdx, setDetailIdx] = React.useState(-1);

  const iconRef = React.useRef<HTMLButtonElement | null>(null);

  /** 收起动画播放中:面板原地播退场动画,窗口还保持展开尺寸,播完才缩窗 */
  const [closing, setClosing] = React.useState(false);
  const closeTimerRef = React.useRef(0);
  /** 图标右键菜单(自绘,窗口内坐标) */
  const [menu, setMenu] = React.useState<{ x: number; y: number } | null>(null);
  /** 收起态开菜单时把窗口撑大过:记下撑大前的图标矩形,关菜单时缩回去 */
  const menuGrowRef = React.useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  // ---- 初始状态
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      const s = await api.getPetState();
      if (!alive) return;
      setState(s);
      setIconPos(s.position);
      document.documentElement.style.setProperty('--pet-accent', '#4f9cf9');
    })();
    const off = api.onPetStateChanged(() => {
      void (async () => {
        const s = await api.getPetState();
        setState(s);
      })();
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  // 主题/平面模式挂到 <html> 上:pet.css 的变量按 html[data-theme]/[data-lite] 取值
  React.useEffect(() => {
    if (!state) return;
    const root = document.documentElement;
    root.dataset.theme = state.theme;
    root.style.colorScheme = state.theme;
    if (state.reduceEffects) root.dataset.lite = '1';
    else delete root.dataset.lite;
  }, [state]);

  // 卸载时清掉收起动画的定时器
  React.useEffect(() => () => window.clearTimeout(closeTimerRef.current), []);

  const iconSize = Math.max(40, Math.min(160, state?.iconSize || 64));
  const panelSize = state?.panelSize || { width: 430, height: 620 };
  const iconScreen = iconPos || { x: window.screenX, y: window.screenY };

  /** 把窗口矩形切到指定形态,只在"设置里调尺寸"这类场景直接用 */
  const applyBounds = React.useCallback(
    async (panelOpen: boolean) => {
      const L = layout(panelOpen, iconScreen, iconSize, panelSize);
      await api.movePetWindow(L.win);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [iconSize, panelSize.width, panelSize.height, iconScreen.x, iconScreen.y]
  );

  // 设置里改图标/面板尺寸时,保持当前展开状态重算窗口矩形。
  // open 的变化由 toggleOpen 自己排好序了,这里只跟尺寸/位置走。
  React.useEffect(() => {
    void applyBounds(open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyBounds]);

  const reduceMotion =
    (state?.reduceEffects === true) ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /**
   * 收起面板。
   *
   * 为什么不是"先 setBounds 缩窗再 setOpen(false)":那样面板在 React 提交前就被
   * 窗口边界裁掉了,退场动画永远画不出来。现在的顺序是:
   *   1. 面板原地播 ~170ms 退场动画(closing 类),窗口**保持展开尺寸**;
   *   2. 动画播完才 movePetWindow 缩回图标大小、再提交关闭状态。
   * 平面模式 / 系统减弱动效时跳过动画直接缩窗。
   *
   * 锚点用"当前渲染出来的图标位置"而不是 iconPos:图标贴着屏幕底边时,
   * 展开布局会被夹紧,图标的真实位置与 iconPos 相差几十像素;
   * 不校正的话,收起时图标会跳一下、拖动锚点也会偏。
   */
  const requestClose = React.useCallback(() => {
    if (!open || closing) return;
    const finish = () => {
      closeTimerRef.current = 0;
      const cur = layout(true, iconScreen, iconSize, panelSize);
      const curIcon = { x: cur.win.x + cur.iconLocal.x, y: cur.win.y + cur.iconLocal.y };
      void api.movePetWindow({ x: curIcon.x, y: curIcon.y, width: iconSize, height: iconSize });
      flushSync(() => {
        setIconPos(curIcon);
        setClosing(false);
        setOpen(false);
      });
      // 夹紧修正后的图标位置也落盘,下次启动/拖动锚点都以它为准
      void api.setPetPosition(curIcon);
    };
    if (reduceMotion) {
      finish();
      return;
    }
    flushSync(() => setClosing(true));
    closeTimerRef.current = window.setTimeout(finish, CLOSE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, closing, reduceMotion, iconScreen.x, iconScreen.y, iconSize, panelSize.width, panelSize.height]);

  /**
   * 展开 / 收起。
   *
   * 展开的顺序很关键:**先**把窗口 setBounds 到目标形态,**再**同步渲染(flushSync)。
   * 反过来(先渲染再挪窗口)时,图标/面板的新位置还在旧窗口矩形外面,
   * IPC 往返期间屏幕上什么都看不到 —— 就是"点一下图标消失一段时间"的来源。
   * 收起走 requestClose(先播退场动画再缩窗,原因见上)。
   */
  const toggleOpen = React.useCallback(async () => {
    // 收起动画播到一半再点图标 = 反悔:取消定时器,面板留在展开态
    if (closing) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = 0;
      flushSync(() => setClosing(false));
      return;
    }
    if (open) {
      requestClose();
      return;
    }
    const cur = layout(false, iconScreen, iconSize, panelSize);
    const curIcon = { x: cur.win.x + cur.iconLocal.x, y: cur.win.y + cur.iconLocal.y };
    const L = layout(true, curIcon, iconSize, panelSize);
    const nextIcon = { x: L.win.x + L.iconLocal.x, y: L.win.y + L.iconLocal.y };
    await api.movePetWindow(L.win);
    flushSync(() => {
      setIconPos(nextIcon);
      setOpen(true);
    });
    // 夹紧修正后的图标位置也落盘,下次启动/拖动锚点都以它为准
    void api.setPetPosition(nextIcon);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, closing, requestClose, iconScreen.x, iconScreen.y, iconSize, panelSize.width, panelSize.height]);

  /**
   * 拖动图标换位置。
   *
   * 为什么不用 -webkit-app-region: drag:那会让系统把**点击**一起吃掉,
   * 真实鼠标点下去没有任何反应(实测;CDP 合成事件测不出来,所以之前漏了)。
   *
   * 为什么用 pointer capture:普通 mousemove/mouseup 只在"光标位于窗口内"时送达。
   * 64×64 的小窗一旦跟不上快速移动的鼠标,光标逃出窗口,事件就断了 ——
   * 表现是"甩快了窗口要几秒才追上";在窗口外松手则更糟:mouseup 永远不来,
   * 拖动状态卡死,之后光标每次路过图标都会继续拖着它跑(位置还不落盘)。
   * setPointerCapture 之后,整条拖动链的事件都会重定向到图标,直到松手。
   *
   * 规则:
   *   - 拖动只发生在图标态。展开态按住图标会先收起再拖 —— 否则拖动请求按图标尺寸
   *     缩窗,面板布局还按展开画,两个一起被画到窗口外("悬窗和小窗口一起消失")。
   *   - 锚点是**图标的屏幕坐标**,不是 window.screenX(展开时窗口左上角是面板,不是图标)。
   *   - mousemove 只记目标,单飞泵:同一时刻只允许一个 movePetWindow 在飞,
   *     回来的路上目标变了就立刻再发,避免 IPC 排队导致"窗口慢几秒才追上鼠标"。
   */
  const dragRef = React.useRef<{
    startX: number;
    startY: number;
    iconX: number;
    iconY: number;
    moved: boolean;
    /** 最后一次位移:松手时按它精确落位,避免"最后一帧被节流丢掉" */
    dx: number;
    dy: number;
  } | null>(null);
  const dragTargetRef = React.useRef<{ x: number; y: number } | null>(null);
  const dragInFlightRef = React.useRef(false);
  /** 刚刚拖动过:用来忽略随之而来的 click,避免"一拖就展开" */
  const justDraggedRef = React.useRef(false);

  const pumpDragMove = React.useCallback(() => {
    if (dragInFlightRef.current) return;
    const target = dragTargetRef.current;
    if (!target) return;
    dragTargetRef.current = null;
    dragInFlightRef.current = true;
    void api
      .movePetWindow({ x: target.x, y: target.y, width: iconSize, height: iconSize })
      .catch(() => undefined)
      .finally(() => {
        dragInFlightRef.current = false;
        if (dragTargetRef.current) pumpDragMove();
      });
  }, [iconSize]);

  const startDrag = React.useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      // 收起动画播到一半就按住图标 = 想拖走:取消收起,直接按图标态处理
      if (closeTimerRef.current) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = 0;
      }
      if (closing) setClosing(false);
      const el = e.currentTarget;
      // 关键:把这条拖动链的指针事件全部捕获到图标上,
      // 光标飞出窗口也能持续收到移动/抬起
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // 极少数情况下(指针已释放)会抛错,退化为窗口内拖动
      }
      // 锚点用"当前渲染出来的图标位置"(展开 + 屏幕边缘夹紧时与 iconPos 有偏差)
      const cur = layout(open, iconScreen, iconSize, panelSize);
      const anchor = { x: cur.win.x + cur.iconLocal.x, y: cur.win.y + cur.iconLocal.y };
      dragRef.current = {
        startX: e.screenX,
        startY: e.screenY,
        iconX: anchor.x,
        iconY: anchor.y,
        moved: false,
        dx: 0,
        dy: 0,
      };

      const onMove = (ev: Event) => {
        const pev = ev as PointerEvent;
        const d = dragRef.current;
        if (!d) return;
        const dx = pev.screenX - d.startX;
        const dy = pev.screenY - d.startY;
        if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
        if (!d.moved && open) {
          // 展开态拖图标 = 想挪位置:越过拖动阈值的这一刻才收起
          // (不能在 pointerdown 就收 —— 否则"点开着的面板"会先收再放,面板永远关不掉)
          void api.movePetWindow({ x: d.iconX, y: d.iconY, width: iconSize, height: iconSize });
          flushSync(() => setOpen(false));
        }
        d.moved = true;
        d.dx = dx;
        d.dy = dy;
        dragTargetRef.current = { x: d.iconX + dx, y: d.iconY + dy };
        pumpDragMove();
      };

      const onUp = (ev: Event) => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        try {
          el.releasePointerCapture((ev as PointerEvent).pointerId);
        } catch {
          /* 已释放 */
        }
        const d = dragRef.current;
        dragRef.current = null;
        dragTargetRef.current = null;
        if (!d || !d.moved) return;
        // 拖完:按"起点 + 最后一次位移"精确落位(单飞泵的最后一次可能还没发出去)
        const pos = { x: d.iconX + d.dx, y: d.iconY + d.dy };
        void api.movePetWindow({ x: pos.x, y: pos.y, width: iconSize, height: iconSize });
        setIconPos(pos);
        void api.setPetPosition(pos);
        justDraggedRef.current = true;
        window.setTimeout(() => {
          justDraggedRef.current = false;
        }, 300);
      };

      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, closing, pumpDragMove, iconSize, iconScreen.x, iconScreen.y]
  );

  // ---- 图标右键菜单(自绘;系统的 contextmenu 在透明无边框小窗上太突兀)

  /** 关菜单;收起态开菜单时窗口被撑大过,顺手缩回图标大小 */
  const closeMenu = React.useCallback(() => {
    const grow = menuGrowRef.current;
    menuGrowRef.current = null;
    flushSync(() => setMenu(null));
    if (grow) void api.movePetWindow(grow);
  }, []);

  /**
   * 图标右键。
   * 收起态窗口只有图标大,装不下菜单:先把窗口撑到能容纳菜单
   * (优先图标上方,不够翻下方),开完菜单、关掉时再缩回去 ——
   * 与展开/收起同一个顺序:先 setBounds 再 flushSync 渲染,避免菜单画出窗口外。
   */
  const onIconContextMenu = React.useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      if (menu) {
        closeMenu();
        return;
      }
      if (open || closing) {
        // 展开态窗口足够大:就地开,夹进窗口内
        setMenu({
          x: Math.max(6, Math.min(e.clientX, window.innerWidth - MENU_W - 6)),
          y: Math.max(6, Math.min(e.clientY, window.innerHeight - MENU_H - 6)),
        });
        return;
      }
      const wa = currentWorkArea();
      const icon = { x: iconScreen.x, y: iconScreen.y, w: iconSize, h: iconSize };
      const mx = Math.min(Math.max(e.screenX - MENU_W / 2, wa.x + 4), wa.x + wa.width - MENU_W - 4);
      let my = icon.y - MENU_H - 6;
      if (my < wa.y + 4) my = icon.y + icon.h + 6; // 上方放不下就翻到下方
      my = Math.min(my, wa.y + wa.height - MENU_H - 4);
      const winX = Math.min(icon.x, mx);
      const winY = Math.min(icon.y, my);
      const bounds = {
        x: winX,
        y: winY,
        width: Math.max(icon.x + icon.w, mx + MENU_W) - winX,
        height: Math.max(icon.y + icon.h, my + MENU_H) - winY,
      };
      menuGrowRef.current = { x: icon.x, y: icon.y, width: icon.w, height: icon.h };
      await api.movePetWindow(bounds);
      flushSync(() => setMenu({ x: mx - winX, y: my - winY }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [menu, open, closing, closeMenu, iconScreen.x, iconScreen.y, iconSize]
  );

  // ---- Esc 与误触收起 / 关菜单(document 级,capture 阶段先处理)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (menu) {
        closeMenu();
        return;
      }
      if (open) requestClose();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      // 菜单开着:点菜单外任何位置 = 关菜单
      if (menu) {
        if (!t?.closest('.pet-menu')) closeMenu();
        return;
      }
      // 面板开着:点窗口内、面板与图标之外的透明区 = 收起(图标按下要拖动,不收)
      if (open && !closing && t && !t.closest('.pet-panel') && !t.closest('.pet-icon')) requestClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, closing, menu, requestClose, closeMenu]);

  // ---- 点击桌面(窗口失焦)时关菜单
  //
  // 关菜单不能只靠窗口内的 pointerdown:点到桌面上时事件根本到不了渲染层。
  // 不收的话,收起态为画菜单撑大的窗口会一直停在"图标 ∪ 菜单"的尺寸,
  // 这块透明矩形在非穿透模式下持续拦截桌面点击,穿透模式下菜单永远挂着。
  React.useEffect(() => {
    const onBlur = () => {
      // 拖动中不关:拖动链由 pointer capture 保证,失焦不应打断;菜单此时也不会开着
      if (menu && !dragRef.current) closeMenu();
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [menu, closeMenu]);

  // ---- 点击穿透:悬停图标/面板时临时恢复交互
  //
  // 原理:穿透开启后主进程 setIgnoreMouseEvents(true, { forward: true }),
  // 鼠标事件穿透到下面的窗口,但 mousemove 会以 forward 形式转发给本窗口。
  // 渲染层据此判断光标是否进入图标/面板区域:进入 → setPetIgnoreMouse(false)
  // 把交互要回来;离开(区域外扩 6px 滞回,或光标离开窗口)→ setPetIgnoreMouse(true)。
  React.useEffect(() => {
    if (!state?.clickThrough) return;
    /** 当前是否处于"忽略鼠标"(穿透)状态:窗口的真实状态由主进程持有,这里跟一份 */
    let ignoring = true;
    const PAD = 6; // 滞回:恢复交互后判定区外扩,防边缘来回抖

    const hit = (clientX: number, clientY: number, pad: number) => {
      const rects: DOMRect[] = [];
      if (iconRef.current) rects.push(iconRef.current.getBoundingClientRect());
      for (const el of document.querySelectorAll('.pet-panel, .pet-menu')) {
        rects.push(el.getBoundingClientRect());
      }
      return rects.some(
        (r) => clientX >= r.left - pad && clientX <= r.right + pad && clientY >= r.top - pad && clientY <= r.bottom + pad
      );
    };
    const onMove = (e: MouseEvent) => {
      if (dragRef.current) return; // 拖动链由 pointer capture 保证,别中途切穿透
      if (ignoring) {
        if (hit(e.clientX, e.clientY, 0)) {
          ignoring = false;
          void api.setPetIgnoreMouse(false);
        }
      } else if (!hit(e.clientX, e.clientY, PAD)) {
        ignoring = true;
        void api.setPetIgnoreMouse(true);
      }
    };
    const onLeave = () => {
      if (dragRef.current || ignoring) return;
      ignoring = true;
      void api.setPetIgnoreMouse(true);
    };
    window.addEventListener('mousemove', onMove);
    document.addEventListener('mouseleave', onLeave);
    return () => {
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', onLeave);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.clickThrough]);



  // ---- 数据加载
  // 文件夹树:面板打开时拉一次
  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    void (async () => {
      const tree = await api.getFolderTree();
      if (alive) setFolders(tree);
    })();
    return () => {
      alive = false;
    };
  }, [open]);

  // 卡片流:全部图片(relDir 空)或某个文件夹(含子目录)
  React.useEffect(() => {
    if (!open || view.kind !== 'cards') return;
    let alive = true;
    void (async () => {
      setBusy(true);
      try {
        const q: Record<string, unknown> = { sort: 'mtime_desc', limit: 80 };
        // 注意:relDir 传空字符串会被后端当作"精确匹配根目录",反而查不到东西,
        // 所以"全部图片"就是不传 relDir;进文件夹时再加 relDirRecursive ——
        // 图库一般按日期建子目录,只取直属文件经常一张都没有。
        if (view.relDir) {
          q.relDir = view.relDir;
          q.relDirRecursive = true;
        }
        if (view.rootId !== undefined) q.rootId = view.rootId;
        const res = await api.queryImages(q);
        const rows = await api.getImagesByIds(res.ids ?? []);
        if (!alive) return;
        setCards(
          (rows.filter(Boolean) as ImageRecord[]).filter((r) =>
            view.relDir ? r.relDir === view.relDir || r.relDir.startsWith(view.relDir + '\\') || r.relDir.startsWith(view.relDir + '/') : true
          )
        );
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, view]);

  // 大图详情 + 同目录兄弟
  React.useEffect(() => {
    if (view.kind !== 'image') return;
    let alive = true;
    void (async () => {
      setBusy(true);
      try {
        const d = (await api.getImage(view.id)) as typeof detail & { siblings?: number[] };
        if (!alive) return;
        setDetail(d);
        const sib = d.siblings || [];
        setNeighbors(sib);
        setDetailIdx(sib.indexOf(view.id));
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  /** 详情里左右切换:按同目录兄弟图顺序走 */
  const stepImage = (delta: number) => {
    if (!neighbors.length || view.kind !== 'image') return;
    const next = detailIdx + delta;
    if (next < 0 || next >= neighbors.length) return;
    setView({ kind: 'image', id: neighbors[next] });
  };

  const goCards = (v: Extract<View, { kind: 'cards' }>) => {
    lastCardsRef.current = v;
    setView(v);
  };
  const openFolder = (n: FolderNode) => {
    const name = n.alias || (n.relDir ? n.relDir.split(/[\\/]/).pop() : `[${n.rootLabel}]`);
    goCards({ kind: 'cards', relDir: n.relDir, rootId: n.rootId, title: name || '全部图片' });
    // 与主界面同步:小窗选过的文件夹也写回设置
    void api.setSettings({ lastBrowseRelDir: n.relDir ? n.relDir : null });
  };
  /** 返回:树/详情/设置 → 最近的卡片流;文件夹卡片流 → 全部图片 */
  const back = () => {
    if (view.kind === 'cards' && view.relDir) {
      lastCardsRef.current = ALL_CARDS;
      setView(ALL_CARDS);
    } else {
      setView(lastCardsRef.current);
    }
  };
  const canBack = view.kind !== 'cards' || view.relDir !== '';

  if (!state) return null;

  // 几何单一真源:渲染与 movePetWindow 用同一个 layout()
  const geo = layout(open, iconScreen, iconSize, panelSize);
  const iconLocal = geo.iconLocal;
  const panelLocal = geo.panelLocal;

  const setTheme = async (theme: 'dark' | 'light') => {
    await api.setSettings({ theme });
    setState(await api.getPetState());
  };
  const setEffects = async (reduce: boolean) => {
    await api.setSettings({ reduceEffects: reduce });
    setState(await api.getPetState());
  };
  const setImageFirst = async (v: boolean) => {
    await api.setSettings({ petImageFirst: v });
    setState(await api.getPetState());
  };
  const setIconSize = async (size: number) => {
    await api.setPetLayout({ iconSize: size });
    setState(await api.getPetState());
  };
  const setPanelSize = async (patch: Partial<{ width: number; height: number }>) => {
    const cur = state.panelSize;
    await api.setPetLayout({ panelSize: { width: patch.width ?? cur.width, height: patch.height ?? cur.height } });
    setState(await api.getPetState());
  };

  const imageFirst = state.imageFirst !== false;
  const infoOpen = showInfo || !imageFirst;

  const viewTitle =
    view.kind === 'tree'
      ? '文件夹'
      : view.kind === 'cards'
        ? view.title
        : view.kind === 'image'
          ? detail && imageFirst
            ? detail.fileName
            : '图片详情'
          : view.kind === 'settings'
            ? '设置'
            : SETTING_LABEL[view.which];

  /** 树:只显示文件夹名字(主界面同款结构),箭头展开/收起,点名字进文件夹 */
  const renderTree = (nodes: FolderNode[], depth: number): React.ReactNode =>
    nodes.map((n) => {
      if (n.hidden && depth > 0) return null;
      const key = `${n.rootId}|${n.relDir}`;
      const kids = (n.children || []).filter((c) => !c.hidden);
      const opened = treeOpen[key] ?? depth === 0;
      const name = n.alias || (n.relDir ? n.relDir.split(/[\\/]/).pop() : `[${n.rootLabel}]`);
      return (
        <React.Fragment key={key}>
          <div className="pet-tree-row" style={{ paddingLeft: 4 + depth * 14 }}>
            <button
              type="button"
              className="pet-tree-arrow"
              style={{ visibility: kids.length ? 'visible' : 'hidden' }}
              title={opened ? '收起' : '展开'}
              onClick={() => setTreeOpen((o) => ({ ...o, [key]: !opened }))}
            >
              {opened ? '▾' : '▸'}
            </button>
            <button type="button" className="pet-tree-name" title={name} onClick={() => openFolder(n)}>
              {name}
            </button>
          </div>
          {kids.length && opened ? renderTree(kids, depth + 1) : null}
        </React.Fragment>
      );
    });

  return (
    <div className="pet-stage">
      <button
        ref={iconRef}
        aria-label="工作小窗:点击展开或收起,拖动可以换位置"
        type="button"
        className="pet-icon"
        style={{ left: iconLocal.x, top: iconLocal.y, width: iconSize, height: iconSize }}
        onPointerDown={startDrag}
        onContextMenu={(e) => void onIconContextMenu(e)}
        onClick={() => {
          if (justDraggedRef.current) return;
          void toggleOpen();
        }}
      >
        <img src={iconSrc} alt="" draggable={false} />
      </button>

      {open && panelLocal ? (
        <div
          className={'pet-panel' + (closing ? ' closing' : '')}
          style={{ left: panelLocal.x, top: panelLocal.y, width: panelSize.width, height: panelSize.height }}
        >
          <div className="pet-head">
            {canBack ? (
              <button type="button" className="pet-btn" onClick={back} title="返回">
                ←
              </button>
            ) : null}
            <span className="pet-title">{viewTitle}</span>
            <button
              type="button"
              className={'pet-btn' + (view.kind === 'tree' ? ' primary' : '')}
              title="文件夹"
              onClick={() => (view.kind === 'tree' ? back() : setView({ kind: 'tree' }))}
            >
              🗂
            </button>
            {view.kind === 'image' ? (
              <button
                type="button"
                className="pet-btn"
                title={showInfo ? '只看图片' : '显示参数文字'}
                onClick={() => setShowInfo((v) => !v)}
              >
                {showInfo ? '🖼' : 'ℹ'}
              </button>
            ) : null}
            <button
              type="button"
              className="pet-btn"
              title="设置"
              onClick={() => (view.kind === 'settings' ? back() : setView({ kind: 'settings' }))}
            >
              ⚙
            </button>
            <button type="button" className="pet-btn" title="收起小窗" onClick={() => void toggleOpen()}>
              ×
            </button>
          </div>

          <div className="pet-body">
            {busy ? <div className="pet-loading">读取中…</div> : null}

            {view.kind === 'tree' ? (
              <div className="pet-tree">
                <div className="pet-tree-row" style={{ paddingLeft: 4 }}>
                  <span className="pet-tree-arrow" style={{ visibility: 'hidden' }} />
                  <button type="button" className="pet-tree-name" onClick={() => goCards({ ...ALL_CARDS })}>
                    全部图片
                  </button>
                </div>
                {renderTree(folders, 0)}
              </div>
            ) : null}

            {view.kind === 'cards'
              ? cards.map((r, idx) => (
                  <button
                    key={r.id}
                    type="button"
                    className={`pet-card${imageFirst ? ' img-first' : ''}${idx % 2 ? ' alt' : ''}`}
                    title={r.fileName}
                    onClick={() => setView({ kind: 'image', id: r.id })}
                  >
                    <img className="pet-thumb" src={`cam-thumb://thumb/${r.id}`} alt="" loading="lazy" />
                    {imageFirst ? null : (
                      <span className="pet-meta">
                        <span className="pet-name">{r.fileName}</span>
                        <span className="pet-sub">
                          {r.dimensions ? `${r.dimensions.width}×${r.dimensions.height}` : ''}
                          {r.meta?.loras?.length ? ` · LoRA ${r.meta.loras.length}` : ''}
                        </span>
                      </span>
                    )}
                  </button>
                ))
              : null}

            {view.kind === 'image' && detail ? (
              <div className={`pet-viewer${infoOpen ? ' with-info' : ''}`}>
                <div className="pet-stage-img">
                  <img
                    src={`cam-thumb://thumb/${detail.id}`}
                    alt=""
                    onClick={() => setShowInfo((v) => !v)}
                  />
                  {neighbors.length > 1 ? (
                    <>
                      <button
                        type="button"
                        className="pet-nav prev"
                        disabled={detailIdx <= 0}
                        title="上一张"
                        onClick={() => stepImage(-1)}
                      >
                        ‹
                      </button>
                      <button
                        type="button"
                        className="pet-nav next"
                        disabled={detailIdx < 0 || detailIdx >= neighbors.length - 1}
                        title="下一张"
                        onClick={() => stepImage(1)}
                      >
                        ›
                      </button>
                    </>
                  ) : null}
                  <span className="pet-count">{detailIdx >= 0 ? (detailIdx + 1) + '/' + neighbors.length : ''}</span>
                </div>
                {infoOpen ? (
                  <div className="pet-kv">
                    <div className="row">
                      <span className="k">尺寸</span>
                      <span className="v">{detail.dimensions ? detail.dimensions.width + ' × ' + detail.dimensions.height : '未记录'}</span>
                    </div>
                    <div className="row">
                      <span className="k">模型</span>
                      <span className="v">{detail.meta?.modelName || '未记录'}</span>
                    </div>
                    <div className="row">
                      <span className="k">LoRA</span>
                      <span className="v">{detail.meta?.loras?.length ? detail.meta.loras.map((x) => x.name).join('、') : '未记录'}</span>
                    </div>
                    <div className="row">
                      <span className="k">提示词</span>
                      <span className="v prompt">
                        {(detail.meta?.prompts || []).filter((x) => x.role === 'positive').map((x) => x.text).join('\n') || '未记录'}
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {view.kind === 'settings' ? (
              <div className="pet-settings">
                <h4>点一项去调</h4>
                {(Object.keys(SETTING_LABEL) as SettingKey[]).map((k) => (
                  <button key={k} type="button" className="pet-card" onClick={() => setView({ kind: 'setting', which: k })}>
                    <span className="pet-meta">
                      <span className="pet-name">{SETTING_LABEL[k]}</span>
                      <span className="pet-sub">{SETTING_SUB[k]}</span>
                    </span>
                    <span className="pet-sub">›</span>
                  </button>
                ))}
              </div>
            ) : null}

            {view.kind === 'setting' ? (
              <div className="pet-settings">
                {view.which === 'icon' ? (
                  <div className="pet-row">
                    <span className="label">图标大小</span>
                    <input
                      type="range"
                      min={40}
                      max={140}
                      step={4}
                      value={iconSize}
                      onChange={(e) => void setIconSize(Number(e.target.value))}
                    />
                    <span className="num">{iconSize}</span>
                  </div>
                ) : null}

                {view.which === 'panel' ? (
                  <>
                    <div className="pet-row">
                      <span className="label">小窗宽度</span>
                      <input
                        type="range"
                        min={300}
                        max={720}
                        step={10}
                        value={panelSize.width}
                        onChange={(e) => void setPanelSize({ width: Number(e.target.value) })}
                      />
                      <span className="num">{panelSize.width}</span>
                    </div>
                    <div className="pet-row">
                      <span className="label">小窗高度</span>
                      <input
                        type="range"
                        min={360}
                        max={1000}
                        step={10}
                        value={panelSize.height}
                        onChange={(e) => void setPanelSize({ height: Number(e.target.value) })}
                      />
                      <span className="num">{panelSize.height}</span>
                    </div>
                  </>
                ) : null}

                {view.which === 'image' ? (
                  <div className="pet-row">
                    <span className="label">画面内容</span>
                    <button
                      type="button"
                      className={'pet-btn' + (imageFirst ? ' primary' : '')}
                      onClick={() => void setImageFirst(true)}
                    >
                      图片为主
                    </button>
                    <button
                      type="button"
                      className={'pet-btn' + (imageFirst ? '' : ' primary')}
                      onClick={() => void setImageFirst(false)}
                    >
                      显示文字
                    </button>
                  </div>
                ) : null}

                {view.which === 'theme' ? (
                  <div className="pet-row">
                    <span className="label">界面主题</span>
                    <button type="button" className={'pet-btn' + (state.theme === 'light' ? ' primary' : '')} onClick={() => void setTheme('light')}>
                      亮色
                    </button>
                    <button type="button" className={'pet-btn' + (state.theme === 'dark' ? ' primary' : '')} onClick={() => void setTheme('dark')}>
                      暗色
                    </button>
                  </div>
                ) : null}

                {view.which === 'effects' ? (
                  <div className="pet-row">
                    <span className="label">渲染效果</span>
                    <button
                      type="button"
                      className={'pet-btn' + (state.reduceEffects ? '' : ' primary')}
                      onClick={() => void setEffects(false)}
                    >
                      磨砂
                    </button>
                    <button
                      type="button"
                      className={'pet-btn' + (state.reduceEffects ? ' primary' : '')}
                      onClick={() => void setEffects(true)}
                    >
                      平面
                    </button>
                  </div>
                ) : null}

                {view.which === 'main' ? (
                  <div className="pet-settings">
                    <button
                      type="button"
                      className="pet-btn primary"
                      style={{ width: '100%', height: 32 }}
                      onClick={() => void api.focusMainWindow()}
                    >
                      打开主界面
                    </button>
                    <button
                      type="button"
                      className="pet-btn"
                      style={{ width: '100%', height: 32, marginTop: 8 }}
                      onClick={() => void api.closePetWindow()}
                    >
                      关闭小窗模式
                    </button>
                    <div className="pet-hint">
                      小窗模式也可以在「主界面 → 设置 → 工作小窗」里开关。
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {!busy && view.kind === 'cards' && cards.length === 0 ? (
              <div className="pet-empty">这里还没有内容</div>
            ) : null}
          </div>
        </div>
      ) : null}

      {menu ? (
        <div className="pet-menu" style={{ left: menu.x, top: menu.y }}>
          <button
            type="button"
            className="pet-menu-item"
            onClick={() => {
              closeMenu();
              void api.focusMainWindow();
            }}
          >
            打开主界面
          </button>
          <button
            type="button"
            className="pet-menu-item"
            onClick={() => {
              // 收起态开菜单时把窗口撑大过:展开交给 toggleOpen 一次排好,
              // 不走 closeMenu 的"缩回图标大小",少一次窗口跳动
              menuGrowRef.current = null;
              flushSync(() => setMenu(null));
              void toggleOpen();
            }}
          >
            {open ? '收起面板' : '展开面板'}
          </button>
          <button type="button" className="pet-menu-item" onClick={() => void api.closePetWindow()}>
            隐藏浮窗(托盘可再开)
          </button>
        </div>
      ) : null}
    </div>
  );
}

const SETTING_LABEL: Record<SettingKey, string> = {
  icon: '图标大小',
  panel: '小窗尺寸',
  image: '画面内容',
  theme: '界面主题',
  effects: '渲染效果',
  main: '主界面 / 关闭小窗',
};

const SETTING_SUB: Record<SettingKey, string> = {
  icon: '桌面上那个小图标多大',
  panel: '小窗展开后多大',
  image: '图片为主 / 显示文字',
  theme: '亮色 / 暗色',
  effects: '磨砂 / 平面',
  main: '回主界面,或者关掉小窗模式',
};

const root = createRoot(document.getElementById('pet-root') as HTMLElement);
root.render(<PetApp />);
