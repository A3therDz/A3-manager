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
  /* 卡片:悬浮描边 + 右上角收藏按钮(悬浮显示,已收藏常显) */
  .cam-card { transition: border-color .12s; }
  .cam-card:hover { border-color: var(--accent) !important; }
  .cam-star { position: absolute; top: 6px; right: 6px; background: rgba(0,0,0,.55);
    border: 0; color: #e3b341; border-radius: 4px; padding: 2px 7px; font-size: 13px;
    line-height: 1.4; cursor: pointer; opacity: 0; transition: opacity .12s; }
  .cam-card:hover .cam-star, .cam-star.on { opacity: 1; }
  .cam-star:hover { background: rgba(0,0,0,.8); }
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
  /* 多选勾选框:平时半透明,悬浮或已选中时实心 */
  .cam-pick { position: absolute; left: 6px; top: 6px; width: 20px; height: 20px; z-index: 2;
    border-radius: 6px; border: 1px solid var(--border); background: rgba(0,0,0,.45);
    color: #fff; font-size: 12px; line-height: 1; cursor: pointer; opacity: .35;
    display: flex; align-items: center; justify-content: center; transition: opacity .15s ease, background .15s ease; }
  .cam-card:hover .cam-pick { opacity: 1; }
  .cam-pick.on { opacity: 1; background: var(--accent); border-color: var(--accent); color: #04121f; font-weight: 700; }
  .cam-card.picked { box-shadow: inset 0 0 0 2px var(--accent-soft); }
  /* 右键菜单 */
  .cam-menu-mask { position: fixed; inset: 0; z-index: 150; }
  .cam-menu { position: fixed; z-index: 151; min-width: 176px; background: var(--panel);
    border: 1px solid var(--border); border-radius: 8px; padding: 4px;
    box-shadow: 0 8px 24px rgba(0,0,0,.35); }
  .cam-menu-item { display: flex; width: 100%; text-align: left; background: none; border: 0;
    color: var(--fg); padding: 6px 10px; font: inherit; font-size: 12px; cursor: pointer;
    border-radius: 5px; align-items: center; gap: 8px; }
  .cam-menu-item:hover { background: var(--accent-soft); color: var(--accent); }
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
      box-shadow var(--dur-1) var(--ease);
  }
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
  /* 玻璃面板 */
  .cam-header {
    background: var(--glass-2) !important;
    backdrop-filter: blur(var(--blur)) saturate(var(--sat));
    -webkit-backdrop-filter: blur(var(--blur)) saturate(var(--sat));
    border-bottom: 1px solid var(--glass-border) !important;
    box-shadow: var(--edge);
  }
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
  .cam-side { margin: 12px 10px 12px 12px; }
  .cam-gridwrap { margin: 12px 0 12px 0; }
  .cam-detail { margin: 12px 12px 12px 0; animation: cam-slide var(--dur-3) var(--ease); }
  /* 卡片:数量多,不做 backdrop-filter(几千张滚动会卡),用半透明 + 柔和投影撑起层次 */
  .cam-card {
    background: var(--card) !important;
    border: 1px solid var(--card-border) !important;
    border-radius: var(--radius-md) !important;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.16), 0 8px 22px rgba(0,0,0,.22);
    overflow: hidden;
    animation: cam-in var(--dur-3) var(--ease) backwards;
    animation-delay: calc(var(--i, 0) * 14ms);
  }
  /* 悬浮"浮起来":抬起 + 轻微放大 + 投影加深 + 压过相邻卡片 */
  .cam-card {
    transition: transform var(--dur-2) var(--ease), box-shadow var(--dur-2) var(--ease),
      border-color var(--dur-1) linear;
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
  .cam-card img { transition: transform .35s var(--ease); backface-visibility: hidden; }
  /* 图片只做极轻微推近;文字完全不缩放,保持锐利 */
  .cam-card:hover img { transform: scale(1.015); }
  @keyframes cam-in { from { opacity: 0; transform: translateY(12px) scale(.985); } }
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
  html[data-lite='1'] .cam-card { animation: none !important; }
  html[data-lite='1'] .cam-card:hover {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    background: var(--card) !important;
  }
  @media (prefers-reduced-motion: reduce) {
    .cam-card, .cam-detail, .cam-modal, .cam-modal > div, .cam-menu, .cam-toast, .cam-selectbar { animation: none !important; }
    .cam-card:hover { transform: none; }
    .cam-card:hover img { transform: none; }
  }
`;
document.head.appendChild(style);

// 主题:挂载前就从 localStorage 恢复,避免闪烁
document.documentElement.dataset.theme = localStorage.getItem('cam-theme') === 'light' ? 'light' : 'dark';

createRoot(el).render(<App />);
