/**
 * 渲染层入口。只负责挂载 <App />。
 *
 * 界面实现在:
 *   App.tsx                     主布局(工具条 / 侧栏 / 网格 / 详情)
 *   components/Trees.tsx        文件夹树 + 用户自定义分类树
 *   components/ImageGrid.tsx    缩略图网格
 *   components/DetailPanel.tsx  参数详情面板
 *   api.ts                      window.api 收口与数据 hook
 *
 * 契约真源:src/shared/types.ts。改字段先改它。
 */

import { createRoot } from 'react-dom/client';
import { App } from './App';

const el = document.getElementById('root');
if (!el) {
  throw new Error('#root 不存在,index.html 被改坏了');
}

// 全局样式:让 index.html 里不需要额外 CSS 文件
const style = document.createElement('style');
style.textContent = `
  /* 主题变量:默认暗色;html[data-theme=light] 覆盖为亮色 */
  :root {
    --bg: #0f1115; --panel: #161b22; --panel2: #1c2128; --border: #21262d;
    --fg: #e6e8eb; --muted: #7d8590; --muted2: #8b949e;
    --accent: #58a6ff; --warn: #d29922; --ok: #3fb950; --bad: #f85149; --cat: #a371f7;
    --inset: #0b0e13; --accent-soft: rgba(88,166,255,.15);
    --scroll: #2d333b; --scroll-hover: #3d444d;
    --bad-bg: #3d1418; --bad-fg: #ffb4b4;
    --ok-fg: #7ee787; --ok-bg: rgba(63,185,80,.13);
    --accent-fg: #79c0ff; --accent-bg: rgba(88,166,255,.13);
    --cat-fg: #d2a8ff; --cat-bg: rgba(163,113,247,.13);
    --warn-bg: rgba(210,153,34,.15);
    --neg-fg: #ffa8a8;
    --overlay: rgba(6,10,18,.42);
    color-scheme: dark;
  }
  html[data-theme='light'] {
    --bg: #f3f5f7; --panel: #ffffff; --panel2: #eaeef2; --border: #d0d7de;
    --fg: #1f2328; --muted: #59636e; --muted2: #6b7280;
    --accent: #0969da; --warn: #9a6700; --ok: #1a7f37; --bad: #cf222e; --cat: #8250df;
    --inset: #e8ecf0; --accent-soft: rgba(9,105,218,.12);
    --scroll: #c3ccd4; --scroll-hover: #a8b3bd;
    --bad-bg: #ffebe9; --bad-fg: #a40e26;
    --ok-fg: #1a7f37; --ok-bg: rgba(26,127,55,.12);
    --accent-fg: #0969da; --accent-bg: rgba(9,105,218,.10);
    --cat-fg: #8250df; --cat-bg: rgba(130,80,223,.12);
    --warn-bg: rgba(154,103,0,.12);
    --neg-fg: #b93d47;
    --overlay: rgba(15,23,42,.22);
    color-scheme: light;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); }
  #root { height: 100%; }
  /* 主题切换时的过渡动画(只过渡颜色,不影响布局) */
  body, header, aside, main, input, select, button, .cam-card, #cam-scroll, .cam-detail {
    transition: background-color .25s ease, border-color .25s ease, color .25s ease;
  }
  input[type=search]::-webkit-search-cancel-button { filter: invert(0.6); }
  html[data-theme='light'] input[type=search]::-webkit-search-cancel-button { filter: none; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--scroll); border-radius: 5px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--scroll-hover); }
  button:disabled { opacity: 0.35; cursor: default; }
  /* 图片一律不做原生拖拽(v0.6):以前在预览大图上按住一拖就会跳出
     「松手即解析元数据」的提示层。卡片自己要拖(拖到分类)靠父元素的 draggable,
     -webkit-user-drag:none 只掐掉"图片"这个拖拽源,不影响它。 */
  img { -webkit-user-drag: none; }

  /* 卡片:悬浮描边 + 右上角收藏按钮(悬浮显示,已收藏常显) */
  .cam-card { transition: border-color .12s; }
  .cam-card:hover { border-color: var(--accent) !important; }
  /* 收藏星:z-index 必须 > 0 —— 悬浮时图片有 transform(自层叠上下文),
     星星没有层级就会被图片盖住("鼠标一放上去星就不见了"的根因)。
     平时隐藏且不接收点击;悬浮卡片 / 已收藏时显示。 */
  .cam-star { position: absolute; top: 6px; right: 6px; z-index: 3; background: rgba(0,0,0,.55);
    border: 0; color: #e3b341; border-radius: 6px; padding: 3px 8px; font-size: 15px;
    line-height: 1.4; cursor: pointer; opacity: 0; pointer-events: none;
    transition: opacity .12s, background .12s, transform .15s var(--ease); }
  .cam-card:hover .cam-star, .cam-star.on { opacity: 1; pointer-events: auto; }
  .cam-star.on { color: #ffd166; text-shadow: 0 0 8px rgba(255,180,0,.6); }
  .cam-star:hover { background: rgba(0,0,0,.8); }
  /* 点击收藏时一个小弹跳,动作有"确认感" */
  .cam-star:active { transform: scale(1.3); }
  /* 已收藏的卡片:亮金描边 + 外圈金光 + 金星常显,一眼能认出来 */
  .cam-card.starred { border-color: rgba(255,190,60,.95) !important;
    box-shadow: inset 0 0 0 1.5px rgba(255,190,60,.5), 0 0 14px rgba(255,180,0,.3), 0 8px 22px rgba(0,0,0,.22); }
  /* 当前在详情面板里打开的那张卡:一圈发光框(v0.6 需求 5)。
     混色用 currentColor 的 accent + 两层 box-shadow(内描边 + 外扩散),
     纯静态不需要动画,零滚动代价。 */
  .cam-card.open {
    border-color: var(--accent) !important;
    box-shadow:
      inset 0 0 0 2px var(--accent),
      0 0 0 1px var(--accent),
      0 0 18px 2px var(--accent-soft),
      0 10px 26px rgba(0,0,0,.28);
    z-index: 4;
  }
  /* 打开 + 收藏:两个状态都要看得出来 —— 金光在外,强调色在内 */
  .cam-card.open.starred {
    box-shadow:
      inset 0 0 0 2px var(--accent),
      0 0 0 1px rgba(255,190,60,.95),
      0 0 18px 2px rgba(255,180,0,.34),
      0 10px 26px rgba(0,0,0,.28);
  }
  /* 正在拖动的那张卡:半透明"拿起来了" */
  .cam-card.dragging { opacity: .45; transform: none !important; }
  html[data-lite='1'] .cam-card.open { box-shadow: inset 0 0 0 2px var(--accent), 0 0 0 1px var(--accent); }
  /* 瀑布流卡片顶部的磨砂动作条:悬浮才出现,只起背景作用(按钮各自定位) */
  .cam-card-bar { position: absolute; top: 0; left: 0; right: 0; height: 36px; z-index: 2;
    pointer-events: none; opacity: 0; transition: opacity .14s ease;
    background: linear-gradient(rgba(8,10,16,.42), rgba(8,10,16,0)); }
  .cam-card:hover .cam-card-bar { opacity: 1;
    backdrop-filter: blur(12px) saturate(1.5); -webkit-backdrop-filter: blur(12px) saturate(1.5); }
  /* 已收藏的卡片:磨砂条常显(只画渐变、不开模糊),否则父级 opacity:0 会把金星一起藏掉 */
  .cam-card.starred .cam-card-bar { opacity: 1; }
  html[data-lite='1'] .cam-card:hover .cam-card-bar { backdrop-filter: none; -webkit-backdrop-filter: none; }
  /* 详情面板预览图上的收藏星:同样悬浮显示、已收藏常显 */
  .cam-preview-star { top: 8px; right: 8px; }
  .cam-preview:hover .cam-preview-star, .cam-preview-star.on { opacity: 1; pointer-events: auto; }
  /* 正向提示词的复制按钮(markdown 代码块风格):小、安静、悬浮变亮 */
  .cam-copy-btn { position: absolute; top: 6px; right: 6px; z-index: 2; font: inherit;
    font-size: 10.5px; padding: 2px 8px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--border); background: var(--panel2); color: var(--muted);
    opacity: .6; transition: opacity .12s ease, color .12s ease, border-color .12s ease; }
  .cam-copy-btn:hover { opacity: 1; color: var(--accent); border-color: var(--accent); }
  .cam-copy-btn.ok { opacity: 1; color: var(--ok); border-color: var(--ok); }
  /* 详情面板的分类小胶囊:磨砂小胶囊,✕ 平时安静、悬浮整条时显色 */
  .cam-chip { display: inline-flex; align-items: center; gap: 3px; padding: 2px 5px 2px 9px;
    border-radius: 999px; font-size: 11px; color: var(--fg);
    background: color-mix(in srgb, var(--panel2) 82%, transparent);
    border: 1px solid var(--border); }
  .cam-chip-x { background: none; border: 0; padding: 0 2px; font: inherit; font-size: 10px;
    line-height: 1; color: var(--muted); cursor: pointer;
    transition: color var(--dur-1) var(--ease); }
  .cam-chip:hover .cam-chip-x { color: var(--bad); }
  /* 分类行管理小按钮:悬浮该行才显示 */
  .cam-mini { background: none; border: 0; color: var(--muted); padding: 2px 4px;
    font-size: 11px; cursor: pointer; opacity: 0; flex-shrink: 0; font-family: inherit; }
  .cam-cat-row:hover .cam-mini { opacity: 1; }
  .cam-mini:hover { color: var(--accent); }
  .cam-mini.del:hover { color: var(--bad); }
  .cam-mini.confirm { color: var(--bad); opacity: 1; border: 1px solid var(--bad); border-radius: 4px; }
  /* 弹层与轻提示 */
  .cam-modal { position: fixed; inset: 0; background: var(--overlay);
    display: flex; align-items: center; justify-content: center; z-index: 100; }
  .cam-toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
    background: var(--panel2); border: 1px solid var(--border); color: var(--fg); padding: 8px 16px;
    border-radius: 8px; font-size: 12px; z-index: 200; }
  .cam-toast.bad { border-color: var(--bad); color: var(--bad-fg); }
  /* 无边框窗口:顶栏可拖拽,里面的控件必须显式 no-drag 才能点 */
  .cam-drag { -webkit-app-region: drag; }
  .cam-nodrag { -webkit-app-region: no-drag; }
  .cam-drag input, .cam-drag select, .cam-drag button, .cam-drag textarea { -webkit-app-region: no-drag; }
  /* 多选操作条:贴在窗口底部中间 */
  .cam-selectbar { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
    display: flex; align-items: center; gap: 8px; padding: 8px 12px; z-index: 140;
    background: var(--panel2); border: 1px solid var(--border); border-radius: 12px;
    box-shadow: 0 12px 32px rgba(0,0,0,.45); }
  /* 多选勾选框:平时半透明,悬浮或已选中时实心。
     注意必须显式 pointer-events:auto —— 父级磨砂条 .cam-card-bar 是 pointer-events:none,
     不声明的话勾选框根本点不到(点击穿透到卡片变成打开详情)。 */
  .cam-pick { position: absolute; left: 6px; top: 6px; width: 20px; height: 20px; z-index: 2;
    border-radius: 6px; border: 1px solid var(--border); background: rgba(0,0,0,.45);
    color: #fff; font-size: 12px; line-height: 1; cursor: pointer; opacity: .35;
    pointer-events: auto;
    display: flex; align-items: center; justify-content: center;
    transition: opacity .15s ease, background .15s ease, transform .12s ease; }
  .cam-pick:active { transform: scale(1.15); }
  .cam-card:hover .cam-pick { opacity: 1; }
  .cam-pick.on { opacity: 1; background: var(--accent); border-color: var(--accent); color: #04121f; font-weight: 700; }
  .cam-card.picked { box-shadow: inset 0 0 0 2px var(--accent-soft); }
  /* 右键菜单 */
  .cam-menu-mask { position: fixed; inset: 0; z-index: 150; }
  .cam-menu { position: fixed; z-index: 151; min-width: 176px; background: var(--panel);
    border: 1px solid var(--border); border-radius: 8px; padding: 4px;
    box-shadow: 0 8px 24px rgba(0,0,0,.35);
    /* 兜底:极端小窗口里菜单再高也不能顶出窗口,超出部分内部滚动 */
    max-height: calc(100vh - 16px); overflow-y: auto; }
  .cam-menu-item { display: flex; width: 100%; text-align: left; background: none; border: 0;
    color: var(--fg); padding: 6px 10px; font: inherit; font-size: 12px; cursor: pointer;
    border-radius: 5px; align-items: center; gap: 8px;
    transition: background-color .12s ease, color .12s ease, transform .12s ease; }
  .cam-menu-item:hover { background: var(--accent-soft); color: var(--accent); }
  .cam-menu-item:active { transform: scale(.97); }
  .cam-menu-item.danger { color: var(--bad); }
  .cam-menu-item.danger:hover { background: var(--bad-bg); color: var(--bad); }
  .cam-menu-sep { height: 1px; background: var(--border); margin: 4px 6px; }
  /* 设置滑块开关:左右两个选项,滑块平滑移动 */
  .cam-switch { position: relative; display: flex; width: 232px; height: 30px;
    border-radius: 15px; background: var(--panel2); border: 1px solid var(--border);
    cursor: pointer; padding: 0; overflow: hidden; font: inherit; }
  .cam-switch-thumb { position: absolute; top: 2px; bottom: 2px; left: 2px; width: calc(50% - 3px);
    border-radius: 13px; background: var(--accent-soft); border: 1px solid var(--accent);
    transition: transform .22s cubic-bezier(.4,0,.2,1); transform: translateX(0); }
  .cam-switch.right .cam-switch-thumb { transform: translateX(calc(100% + 2px)); }
  .cam-switch-opt { flex: 1; z-index: 1; display: flex; align-items: center; justify-content: center;
    font-size: 12px; color: var(--muted); transition: color .22s ease; user-select: none; }
  .cam-switch .cam-switch-opt.on { color: var(--accent); font-weight: 600; }
  /* ================= D1 视觉:苹果风磨砂玻璃(材料 / 层次 / 动效) =================
     参考 macOS / iOS 的玻璃材质:极低对比的浅色半透明 + 强背景模糊 + 大圆角 +
     内高光边 + 柔和环境投影。**配色不照抄参考图**,只取材质语言:
       · 面板本身几乎不着色,颜色来自背景网格的透出(所以背景必须有色可透)
       · 边缘只留 1px 高光,靠模糊和投影分层,而不是靠描边
       · 圆角走大档(面板 20px / 卡片 14px) */
  :root {
    /* 深色:偏冷灰的玻璃,仍能透出背景的颜色 */
    --glass: rgba(38,44,58,.52);
    --glass-2: rgba(42,48,62,.62);
    --glass-border: rgba(255,255,255,.14);
    --edge: inset 0 1px 0 rgba(255,255,255,.16);
    --card: rgba(255,255,255,.055);
    --card-hover: rgba(255,255,255,.03);
    --card-border: rgba(255,255,255,.12);
    --shadow-1: 0 2px 10px rgba(0,0,0,.28);
    --shadow-2: 0 18px 44px rgba(0,0,0,.46);
    --shadow-3: 0 30px 70px rgba(0,0,0,.58);
    --hover-shadow: 0 26px 52px rgba(0,0,0,.55), 0 4px 12px rgba(0,0,0,.35);
    --modal-bg: rgba(26,30,38,.97);
    /* 工具条控件:贴在背景上的薄玻璃 */
    --ctl-bg: rgba(255,255,255,.07);
    --ctl-bg-hover: rgba(255,255,255,.13);
    --ctl-border: rgba(255,255,255,.14);
    --ctl-fg: #e6e8eb;
    --wp-scrim: rgba(10,13,20,.42);
    --blur: 16px;
    --sat: 1.7;
    --radius-lg: 20px;
    --radius-md: 14px;
    --dur-1: .14s; --dur-2: .22s; --dur-3: .34s;
    --ease: cubic-bezier(.32,.72,0,1);
  }
  html[data-theme='light'] {
    --glass: rgba(255,255,255,.55);
    --glass-2: rgba(255,255,255,.66);
    --glass-border: rgba(255,255,255,.72);
    --edge: inset 0 1px 0 rgba(255,255,255,.95);
    --card: rgba(255,255,255,.55);
    --card-hover: rgba(255,255,255,.42);
    --card-border: rgba(255,255,255,.80);
    --shadow-1: 0 2px 10px rgba(15,23,42,.08);
    --shadow-2: 0 18px 44px rgba(15,23,42,.14);
    --shadow-3: 0 30px 70px rgba(15,23,42,.20);
    --hover-shadow: 0 26px 48px rgba(15,23,42,.22), 0 4px 12px rgba(15,23,42,.10);
    --modal-bg: rgba(255,255,255,.97);
    --ctl-bg: rgba(255,255,255,.52);
    --ctl-bg-hover: rgba(255,255,255,.72);
    --ctl-border: rgba(255,255,255,.78);
    --ctl-fg: #1f2328;
    --wp-scrim: rgba(255,255,255,.38);
  }
  /* 背景:一片柔和的色雾 —— 玻璃要有东西可透,否则看起来就是一块板 */
  .cam-app { position: relative; z-index: 0; }
  .cam-app::before {
    content: ''; position: absolute; inset: -20%; pointer-events: none; z-index: -1;
    background:
      radial-gradient(46% 42% at 16% 10%, rgba(59,130,246,.55), transparent 62%),
      radial-gradient(42% 38% at 84% 6%,  rgba(139,92,246,.50), transparent 64%),
      radial-gradient(52% 46% at 80% 88%, rgba(14,165,233,.45), transparent 66%),
      radial-gradient(44% 40% at 18% 90%, rgba(236,72,153,.32), transparent 66%);
    /* 背景不再额外做一次大半径高斯模糊 —— 那是启动卡死的元凶;径向渐变本身就够柔 */
  }
  html[data-theme='light'] .cam-app::before {
    background:
      radial-gradient(46% 42% at 16% 8%,  rgba(96,165,250,.55), transparent 62%),
      radial-gradient(42% 38% at 86% 6%,  rgba(167,139,250,.42), transparent 64%),
      radial-gradient(52% 46% at 80% 90%, rgba(56,189,248,.40), transparent 66%),
      radial-gradient(44% 40% at 16% 92%, rgba(244,114,182,.28), transparent 66%);
  }
  /* 自绘标题栏按钮:和顶栏同一层玻璃,悬浮提亮,关闭键悬浮变红 */
  .cam-wincontrols {
    position: absolute; top: 0; right: 0; height: 46px; display: flex; align-items: stretch;
    -webkit-app-region: no-drag; z-index: 6;
  }
  .cam-wincontrols button {
    width: 46px; border: 0; background: transparent !important; color: var(--fg);
    display: flex; align-items: center; justify-content: center; cursor: pointer; border-radius: 0;
    transition: background-color var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
  }
  .cam-wincontrols button:hover { background: var(--ctl-bg-hover) !important; }
  .cam-wincontrols button.close:hover { background: #e81123 !important; color: #fff; }
  .cam-wincontrols svg { width: 11px; height: 11px; fill: none; stroke: currentColor; stroke-width: 1.1; }
  /* 工具条:所有控件都做成贴在背景上的磨砂玻璃,不再是一块块实心深色 */
  .cam-toolbar input,
  .cam-toolbar select,
  .cam-toolbar button {
    background: var(--ctl-bg) !important;
    border: 1px solid var(--ctl-border) !important;
    border-radius: 11px !important;
    color: var(--ctl-fg) !important;
    backdrop-filter: blur(14px) saturate(1.5);
    -webkit-backdrop-filter: blur(14px) saturate(1.5);
    box-shadow: var(--edge), 0 2px 10px rgba(0,0,0,.10);
    transition: background-color var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease),
      box-shadow var(--dur-1) var(--ease), transform var(--dur-1) var(--ease);
  }
  /* 按下去有一点"陷进去"的反馈,点击不再是零响应 */
  .cam-toolbar button:active { transform: scale(.95); }
  .cam-toolbar input:hover,
  .cam-toolbar select:hover,
  .cam-toolbar button:hover {
    background: var(--ctl-bg-hover) !important;
    box-shadow: var(--edge), 0 4px 14px rgba(0,0,0,.16);
  }
  .cam-toolbar input:focus,
  .cam-toolbar select:focus {
    outline: none;
    border-color: var(--accent) !important;
    box-shadow: var(--edge), 0 0 0 3px var(--accent-soft);
  }
  .cam-toolbar select option { background: var(--panel); color: var(--fg); }
  /* 自定义背景图:压一层同色薄纱 + 保留一点点色雾,保证玻璃与文字依然清楚 */
  .cam-app.has-wallpaper::before {
    background:
      linear-gradient(var(--wp-scrim), var(--wp-scrim)),
      radial-gradient(46% 42% at 16% 10%, rgba(59,130,246,.18), transparent 62%),
      radial-gradient(42% 38% at 84% 6%, rgba(139,92,246,.16), transparent 64%),
      radial-gradient(52% 46% at 80% 88%, rgba(14,165,233,.14), transparent 66%);
  }
  html[data-theme='light'] .cam-app.has-wallpaper::before {
    background:
      linear-gradient(var(--wp-scrim), var(--wp-scrim)),
      radial-gradient(46% 42% at 16% 8%, rgba(96,165,250,.22), transparent 62%),
      radial-gradient(42% 38% at 86% 6%, rgba(167,139,250,.18), transparent 64%);
  }
  /* 「收藏」筛选按钮:激活时实心强调,一眼能看出"正在筛选收藏" */
  .cam-toolbar button.cam-star-btn { display: inline-flex; align-items: center; gap: 5px; }
  .cam-toolbar button.cam-star-btn.on {
    background: var(--accent) !important;
    border-color: var(--accent) !important;
    color: #fff !important;
    box-shadow: var(--edge), 0 3px 14px var(--accent-soft);
  }
  .cam-toolbar button.cam-star-btn.on:hover { filter: brightness(1.06); }
  /* 「眼睛」按钮:激活(隐藏预览区)时实心蓝,未激活为普通工具条按钮 */
  .cam-toolbar button.cam-tb-eye.on {
    background: var(--accent) !important;
    border-color: var(--accent) !important;
    color: #fff !important;
    box-shadow: var(--edge), 0 3px 14px var(--accent-soft);
  }
  .cam-toolbar button.cam-tb-eye.on:hover { filter: brightness(1.06); }
  /* Ctrl+滚轮缩放后的「还原」按钮:吸附在网格区右上角,不随滚动跑丢 */
  .cam-zoom-reset-wrap {
    position: sticky;
    top: 8px;
    z-index: 5;
    height: 0;
    overflow: visible;
    display: flex;
    justify-content: flex-end;
    padding-right: 12px;
  }
  .cam-zoom-reset {
    font: inherit;
    font-size: 12px;
    padding: 4px 12px;
    border-radius: 999px;
    border: 1px solid var(--glass-border);
    background: color-mix(in srgb, var(--panel) 82%, transparent);
    color: var(--fg);
    cursor: pointer;
    box-shadow: var(--edge), var(--shadow-2);
    animation: cam-fade var(--dur-2) var(--ease);
    transition: color var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease);
  }
  .cam-zoom-reset:hover { color: var(--accent); border-color: var(--accent); }
  /* 弹层里的输入框:聚焦时的强调色描边 + 柔光,和其它输入框一致 */
  .cam-modal input:focus {
    border-color: var(--accent) !important;
    box-shadow: 0 0 0 3px var(--accent-soft);
    outline: none;
  }
  /* 分类选择弹层的行:悬浮有底色反馈 */
  .cam-catpick-row { transition: background-color .12s ease; }
  .cam-catpick-row:hover { background: var(--accent-soft); }
  .cam-menu-item.active { color: var(--accent); background: var(--accent-soft); }

  /* ---- 统一的"有始有终"动画 ----
     所有浮层/弹层都成对提供进场与退场关键帧,退场由渲染层延迟卸载保证播完。 */
  @keyframes cam-menu-in {
    from { opacity: 0; transform: translateY(-6px) scale(.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes cam-menu-out {
    from { opacity: 1; transform: translateY(0) scale(1); }
    to   { opacity: 0; transform: translateY(-6px) scale(.98); }
  }
  @keyframes cam-fade-out { from { opacity: 1; } to { opacity: 0; } }
  @keyframes cam-pop-out {
    from { opacity: 1; transform: translateY(0) scale(1); }
    to   { opacity: 0; transform: translateY(8px) scale(.98); }
  }
  @keyframes cam-toast-out {
    from { opacity: 1; transform: translate(-50%, 0); }
    to   { opacity: 0; transform: translate(-50%, 10px); }
  }
  .cam-menu.closing { animation: cam-menu-out var(--dur-1) var(--ease) forwards; }
  .cam-menu-mask.closing { animation: cam-fade-out var(--dur-1) var(--ease) forwards; }
  .cam-modal.closing { animation: cam-fade-out var(--dur-1) var(--ease) forwards; }
  .cam-modal.closing > div { animation: cam-pop-out var(--dur-1) var(--ease) forwards; }
  .cam-toast.closing { animation: cam-toast-out var(--dur-1) var(--ease) forwards; }
  .cam-selectbar.closing { animation: cam-pop-out var(--dur-1) var(--ease) forwards; }
  /* 详情面板:关闭时向右滑出(与槽位宽度回收同节奏),而不是"啪"地消失 */
  .cam-detail.closing { animation: cam-slide-out var(--dur-3) var(--ease) forwards; }
  @keyframes cam-slide-out {
    from { opacity: 1; transform: translateX(0); }
    to   { opacity: 0; transform: translateX(22px); }
  }
  .cam-petw { animation: cam-pop var(--dur-2) var(--ease); }
  .cam-petw.closing { animation: cam-pop-out var(--dur-1) var(--ease) forwards; }
  .cam-petpanel { animation: cam-slide var(--dur-2) var(--ease); }
  .cam-petpanel.closing { animation: cam-pop-out var(--dur-1) var(--ease) forwards; }
  html[data-lite='1'] .cam-menu.closing,
  html[data-lite='1'] .cam-menu-mask.closing,
  html[data-lite='1'] .cam-modal.closing,
  html[data-lite='1'] .cam-modal.closing > div,
  html[data-lite='1'] .cam-toast.closing { animation-duration: 1ms !important; }

  /* 文件拖进窗口时的提示层:固定盖住整屏,既不拦截事件也不引起重排 */
  .cam-dropzone {
    position: fixed; inset: 0; z-index: 300; pointer-events: none;
    display: flex; align-items: center; justify-content: center;
    background: var(--overlay);
    backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
  }
  .cam-dropzone::after {
    content: ''; position: absolute; inset: 12px; border-radius: 14px;
    border: 2px dashed var(--accent);
  }
  .cam-dropcard {
    position: relative; display: flex; flex-direction: column; align-items: center; gap: 6px;
    padding: 20px 30px; border-radius: 12px;
    background: var(--panel); border: 1px solid var(--accent);
    box-shadow: var(--edge), 0 18px 46px rgba(0,0,0,.28);
    text-align: center; animation: cam-fade var(--dur-2) var(--ease);
  }
  .cam-menu-label {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 12px 4px; color: var(--muted); font-size: 10.5px;
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  /* 工具条永不换行:窄窗口时把「只看收藏 / 模型 / 排序」收进「更多」 */
  @media (max-width: 1180px) {
    .cam-tb-opt { display: none !important; }
    .cam-tb-more { display: inline-flex !important; }
  }
  @media (max-width: 1080px) {
    .cam-toolbar-title { display: none; }
  }
  /* 详情面板顶栏在窄窗口下让文件名自己先让位 */
  @media (max-width: 900px) {
    .cam-detail-title { max-width: 160px; }
  }

  /* 玻璃面板 */
  .cam-header {
    background: var(--glass-2) !important;
    backdrop-filter: blur(var(--blur)) saturate(var(--sat));
    -webkit-backdrop-filter: blur(var(--blur)) saturate(var(--sat));
    border-bottom: 1px solid var(--glass-border) !important;
    box-shadow: var(--edge);
  }
  /* 顶栏下沿的强调色发丝线:一点点平面设计的点缀,不抢戏 */
  .cam-header::after {
    content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 1px;
    background: linear-gradient(90deg, transparent 4%, var(--accent) 32%, var(--cat) 68%, transparent 96%);
    opacity: .35; pointer-events: none;
  }
  /* 标签栏:浏览器式标签页。激活的标签用面板色,与下方内容区连成一体 */
  .cam-tabbar {
    display: flex; align-items: flex-end; gap: 4px;
    padding: 6px 12px 0; flex-shrink: 0; overflow-x: auto; overflow-y: hidden;
    scrollbar-width: none;
  }
  .cam-tabbar::-webkit-scrollbar { display: none; }
  /* 宽度由标签栏上的 --tab-w 统一给出(渲染层的量宽循环负责算出"刚好放得下"的值);
     标签一律等宽:不管标题两个字还是三十个字,都显示同样的大小(v0.6 需求 4)。 */
  .cam-tab {
    display: flex; align-items: center; gap: 6px; flex: 0 0 auto; min-width: 0;
    width: var(--tab-w, 248px); max-width: var(--tab-w, 248px);
    padding: 5px 7px 5px 12px; border-radius: 10px 10px 0 0;
    border: 1px solid var(--glass-border); border-bottom: none;
    background: var(--ctl-bg); color: var(--muted); font-size: 12px; line-height: 1.5;
    cursor: pointer; user-select: none;
    /* 新建/关闭标签时宽度平滑到新值,不是"啪"地跳 */
    transition: width var(--dur-2) var(--ease), background-color var(--dur-1) var(--ease),
      color var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease);
  }
  .cam-tab:hover { background: var(--ctl-bg-hover); color: var(--fg); }
  .cam-tab.on { background: var(--glass); color: var(--fg); box-shadow: var(--edge); }
  .cam-tab-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cam-tab-x {
    border: 0; background: none; color: var(--muted); cursor: pointer; border-radius: 4px;
    width: 16px; height: 16px; padding: 0; display: flex; align-items: center; justify-content: center;
    font-size: 13px; line-height: 1; font-family: inherit; flex-shrink: 0;
    transition: background-color .12s ease, color .12s ease, opacity .12s ease;
  }
  .cam-tab-x:hover { background: var(--bad-bg); color: var(--bad); }
  /* 平时低调、悬停或激活时更明显(不做"只有悬停才出现"—— 那会让标签窄的时候找不到关闭键) */
  .cam-tab-x:hover { background: var(--bad-bg); color: var(--bad); opacity: 1; }
  .cam-tab:hover .cam-tab-x, .cam-tab.on .cam-tab-x { opacity: .85; }
  .cam-tab-add {
    flex-shrink: 0; border: 1px solid var(--glass-border); background: var(--ctl-bg);
    color: var(--muted); border-radius: 8px; width: 26px; height: 26px; margin-bottom: 2px;
    cursor: pointer; font: inherit; font-size: 14px; line-height: 1;
    transition: background-color var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
  }
  .cam-tab-add:hover { background: var(--ctl-bg-hover); color: var(--accent); }
  .cam-side, .cam-gridwrap, .cam-detail {
    background: var(--glass) !important;
    backdrop-filter: blur(var(--blur)) saturate(var(--sat));
    -webkit-backdrop-filter: blur(var(--blur)) saturate(var(--sat));
    border: 1px solid var(--glass-border) !important;
    border-radius: var(--radius-lg);
    box-shadow: var(--edge), var(--shadow-2);
  }
  /* 网格区面积最大:完全不做实时模糊(否则滚动/启动都会卡),靠半透明 + 投影保持玻璃感 */
  .cam-gridwrap {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    background: color-mix(in srgb, var(--glass) 88%, var(--bg)) !important;
  }
  /* 「眼睛」隐藏预览区后:网格变成一整块磨砂玻璃,透出桌面壁纸(此时没有卡片,实时模糊很便宜) */
  .cam-gridwrap.zen {
    backdrop-filter: blur(var(--blur)) saturate(var(--sat));
    -webkit-backdrop-filter: blur(var(--blur)) saturate(var(--sat));
    background: color-mix(in srgb, var(--glass) 55%, transparent) !important;
  }
  html[data-lite='1'] .cam-gridwrap.zen {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    background: var(--panel) !important;
  }
  .cam-side { margin: 12px 10px 12px 12px; }
  .cam-gridwrap { margin: 12px 0 12px 0; }
  /* 详情面板的布局槽:宽度 0 ↔ 520 过渡,开/关时网格逐帧重排而不是瞬间让位。
     面板本体固定 520px,槽位 overflow hidden 形成"从右缘抹入/抹出"的效果。 */
  .cam-detail-slot {
    flex-shrink: 0; overflow: hidden; margin: 12px 12px 12px 0;
    transition: width var(--dur-3) var(--ease);
  }
  /* 详情面板的本体**不做进场动画**(v0.6:槽位宽度已经从 0 抹开,再叠一层
     cam-slide 的位移会让面板在 400px 宽度里逐帧重排,预览大图尤其贵 ——
     用户看到的就是"打开卡片时动画抽搐"。见 v0.6-改进说明 第 1 条。 */
  .cam-detail { margin: 0; }
  /* 卡片:数量多,不做 backdrop-filter(几千张滚动会卡),用半透明 + 柔和投影撑起层次 */
  .cam-card {
    background: var(--card) !important;
    border: 1px solid var(--card-border) !important;
    border-radius: var(--radius-md) !important;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.16), 0 8px 22px rgba(0,0,0,.22);
    overflow: hidden;
    /* 卡片**故意不做进场动画**(v0.6:
       以前每张卡都跑 cam-in(位移 + 缩放 + 14ms×12 错峰延迟),网格一屏几十张同时
       合成动画,窗口小 / 弱显卡时就是"抽搐、卡顿"的主因;图片本身的淡入已经够用,
       而且只动 opacity 不触发布局。见 v0.6-改进说明 第 1 条。 */
  }
  /* 悬浮"浮起来":抬起 + 投影加深 + 压过相邻卡片 */
  .cam-card {
    transition: transform var(--dur-2) var(--ease), box-shadow var(--dur-2) var(--ease),
      border-color var(--dur-1) linear;
    /* 只对卡片内部做绘制隔离:悬浮动画/图片缩放不会把整个网格的层重新合成 */
    contain: layout paint style;
  }
  .cam-card:hover {
    /* 只抬起、不缩放:整卡缩放会让图片和文字被非整数倍重采样,看起来发虚 */
    transform: translateY(-8px);
    box-shadow: var(--edge), var(--hover-shadow);
    border-color: var(--accent) !important;
    z-index: 6;
    /* 只有鼠标下这一张开实时模糊:整屏几百张时绝不开,单张代价可以忽略 */
    backdrop-filter: blur(14px) saturate(1.7);
    -webkit-backdrop-filter: blur(14px) saturate(1.7);
    background: var(--card-hover) !important;
  }
  /* 卡片图片:解码完成前透明,onLoad 加 .loaded 后淡入(命中缓存的由 ref 回调直接标记) */
  .cam-card img { opacity: 0; transition: opacity .3s ease, transform .35s var(--ease); backface-visibility: hidden; }
  .cam-card img.loaded { opacity: 1; }
  html[data-lite='1'] .cam-card img { opacity: 1; transition: none; }
  /* 图片只做极轻微推近;文字完全不缩放,保持锐利 */
  .cam-card:hover img.loaded { transform: scale(1.015); }
  @keyframes cam-slide { from { opacity: 0; transform: translateX(16px); } }
  /* 弹层 / 菜单 / 提示:同样用玻璃,淡入 + 轻微上浮 */
  .cam-modal { animation: cam-fade var(--dur-2) var(--ease); }
  .cam-modal > div {
    /* 刻意不用 backdrop-filter:弹层正好压在滚动网格上,模糊会让合成器整屏重算 */
    background: var(--modal-bg) !important;
    border: 1px solid var(--glass-border) !important;
    border-radius: var(--radius-lg) !important;
    box-shadow: var(--edge), var(--shadow-3) !important;
    animation: cam-pop var(--dur-2) var(--ease);
  }
  @keyframes cam-fade { from { opacity: 0; } }
  @keyframes cam-pop { from { opacity: 0; transform: translateY(10px) scale(.97); } }
  .cam-menu {
    background: var(--modal-bg) !important;
    border: 1px solid var(--glass-border) !important;
    border-radius: var(--radius-md) !important;
    box-shadow: var(--edge), var(--shadow-2);
    animation: cam-pop var(--dur-1) var(--ease);
    transform-origin: top left;
  }
  /* 向上翻转的菜单(.flip):缩放动画从底部往上涨,方向跟着翻 */
  .cam-menu.flip { transform-origin: bottom left; }
  .cam-toast, .cam-selectbar {
    background: var(--modal-bg) !important;
    border: 1px solid var(--glass-border) !important;
    border-radius: var(--radius-md) !important;
    box-shadow: var(--edge), var(--shadow-2);
  }
  .cam-toast { animation: cam-toast-in var(--dur-2) var(--ease); }
  .cam-selectbar { animation: cam-toast-in var(--dur-2) var(--ease); }
  @keyframes cam-toast-in { from { opacity: 0; transform: translate(-50%, 12px); } }
  /* 侧栏行 / 输入框:轻反馈,不做位移以免抖动 */
  .cam-side button { transition: background-color var(--dur-1) var(--ease), color var(--dur-1) var(--ease); }
  .cam-side button:hover { background-color: color-mix(in srgb, var(--accent) 12%, transparent); }
  /* 树行(文件夹/分类):选中态的描边与底色变化也走过渡,不再"跳" */
  .cam-treerow { transition: background-color var(--dur-1) var(--ease), color var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease); }
  /* ================= 左侧「文件夹」列表(需求 6)=================
     用户反馈:文件夹和图片不容易区分。这里把文件夹做成**明显的目录项**:
       · 实心文件夹图标(打开时掀盖)+ 加粗的字
       · 右侧数量做成圆角小胶囊
       · 层级用左边一条竖引导线连起来,不再只靠缩进
     只有文件夹树用 .folder,分类树仍是原来那种轻量文字行。 */
  .cam-treerow.folder { font-size: 12.5px; }
  .cam-treerow.folder:hover { background-color: color-mix(in srgb, var(--accent) 14%, transparent); }
  /* 字重必须作用在 label 上:行按钮的 font 是内联 style,会盖掉同元素上的 class 规则 */
  .cam-treerow.folder .cam-tree-label { font-weight: 600; }
  .cam-folder-ico { flex-shrink: 0; fill: currentColor; opacity: .95; }
  .cam-treerow.folder .cam-folder-ico { color: var(--accent); }
  .cam-treerow.on.folder .cam-folder-ico { opacity: 1; }
  /* 展开箭头:独立小方块,悬浮才明显;没有子目录时留等宽空位 */
  .cam-tree-caret {
    flex-shrink: 0; width: 14px; text-align: center; color: var(--muted);
    font-size: 9px; line-height: 1; border-radius: 4px; padding: 2px 0;
    transition: background-color var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
  }
  .cam-tree-caret:not(.cam-tree-caret-empty):hover { background: var(--ctl-bg-hover); color: var(--accent); }
  .cam-tree-caret-empty { cursor: default; opacity: 0; }
  /* 引导线:一层一条细竖线 */
  .cam-tree-guide { flex-shrink: 0; width: 1px; height: 12px; background: var(--border); }
  .cam-tree-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cam-tree-hint { flex-shrink: 0; color: var(--muted); font-size: 10px; font-weight: 400; }
  .cam-tree-count {
    flex-shrink: 0; min-width: 26px; text-align: right;
    color: var(--fg); opacity: .55;
    font-size: 10.5px; font-weight: 500; font-variant-numeric: tabular-nums;
    background: var(--ctl-bg); border-radius: 999px; padding: 0 6px; line-height: 15px;
  }
  .cam-treerow.on .cam-tree-count { opacity: .9; color: var(--accent); background: var(--accent-bg); }
  /* 平面/兼容模式:所有实时模糊与进场动画都关掉(设置里可切) */
  html[data-lite='1'] .cam-header,
  html[data-lite='1'] .cam-side,
  html[data-lite='1'] .cam-gridwrap,
  html[data-lite='1'] .cam-detail,
  html[data-lite='1'] .cam-menu,
  html[data-lite='1'] .cam-toast,
  html[data-lite='1'] .cam-selectbar,
  html[data-lite='1'] .cam-modal > div {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
  html[data-lite='1'] .cam-side,
  html[data-lite='1'] .cam-gridwrap,
  html[data-lite='1'] .cam-detail { background: var(--panel) !important; }
  /* 平面模式:槽位宽度不做过渡,直接到位 */
  html[data-lite='1'] .cam-detail-slot { transition: none; }
  html[data-lite='1'] .cam-card { animation: none !important; }
  html[data-lite='1'] .cam-card:hover {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    background: var(--card) !important;
  }
  @media (prefers-reduced-motion: reduce) {
    .cam-card, .cam-detail, .cam-modal, .cam-modal > div, .cam-menu, .cam-toast, .cam-selectbar, .cam-tab { animation: none !important; }
    .cam-detail-slot { transition: none; }
    .cam-card img { opacity: 1 !important; transition: none; }
    .cam-card:hover { transform: none; }
    .cam-card:hover img, .cam-card:hover img.loaded { transform: none !important; }
  }
`;
document.head.appendChild(style);

// 主题:挂载前就从 localStorage 恢复,避免闪烁
// 默认亮色:只有用户显式选过暗色才用暗色
const savedTheme = localStorage.getItem('cam-theme');
document.documentElement.dataset.theme = savedTheme === 'dark' ? 'dark' : 'light';

createRoot(el).render(<App />);
