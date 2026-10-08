/**
 * 缩略图网格(瀑布流)。
 *
 * v0.3 起改为**按原始比例的瀑布型布局**(参考用户给的 Pinterest 式效果):
 *  - 每张卡片的高度由图片真实宽高比决定,不再统一裁成 176px;
 *  - 卡片上**不放任何文字** —— 图片是主体,文件名等信息进详情面板看;
 *  - 悬浮时顶部浮现一条磨砂玻璃动作条(多选框 + 收藏星),平时完全隐藏;
 *  - 已收藏的卡片:金星常显 + 金色描边,一眼能认出来。
 *
 * 瀑布流实现:Chromium 还不支持 grid-template-rows: masonry,
 * 用「grid-auto-rows 小行高 + 按宽高比计算 grid-row span」的经典做法;
 * 列宽随容器宽度与缩放级别(gridZoom,Ctrl+滚轮)实时重算。
 *
 * 其他关键设计:
 *  - 只渲染已加载的行;滚动到底部由父组件触发 loadMore(不引虚拟滚动库)。
 *  - 图片用 cam-thumb:// 协议(桌面版)/ file:// (浏览器调试),加载失败显示占位而不是破图。
 *  - v0.6:卡片可以**拖到左侧分类**上(HTML5 DnD + dnd.ts 的私有 MIME 标记,
 *    和"从资源管理器拖文件进来"区分开);当前打开的那张卡高亮发光(.open)。
 */

import { memo, useEffect, useRef, useState } from 'react';
import type { ImageRecord } from '@shared/types';
import { thumbUrl } from '../api';
import { endImageDrag, startImageDrag } from '../dnd';

interface Props {
  rows: ImageRecord[];
  onOpen: (id: number) => void;
  /** 卡片右上角 ☆/★ 切换收藏 */
  onToggleStar: (id: number, starred: boolean) => void;
  /** 卡片右键菜单 */
  onContextMenu: (id: number, x: number, y: number) => void;
  /** 多选:已选中的图片 id 集合 */
  selectedIds: Set<number>;
  /** 多选:toggle = 点左上角勾选框 / Ctrl+点击;range = Shift+点击(选一段) */
  onSelect: (id: number, mode: 'toggle' | 'range') => void;
  /** 网格缩放级别(Ctrl+滚轮),1 = 默认列宽 */
  zoom: number;
  /** 当前在详情面板里打开的那张图:卡片高亮发光,一眼看出在看哪张 */
  openId?: number | null;
  /** 双击卡片:全屏查看原图(v0.8 Lightbox) */
  onOpenViewer?: (id: number) => void;
  /** 一次拖拽结束(不管有没有放下):父组件用它把"内部拖拽"状态清掉 */
  onDragEnd?: () => void;
}

/** 瀑布流参数:行高 4px + 间距 10px,卡片高度 = span * 14 - 10 */
const ROW_UNIT = 4;
const GAP = 10;
/** 默认列宽(缩放 1.0 时) */
const BASE_COL = 208;
const PAD = 12;

export const ImageGrid = memo(function ImageGrid({
  rows,
  onOpen,
  onToggleStar,
  onContextMenu,
  selectedIds,
  onSelect,
  zoom,
  openId,
  onOpenViewer,
  onDragEnd,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [colWidth, setColWidth] = useState(0);
  /** 正在被拖的那张卡(只用来做视觉反馈:半透明 + 抓取光标) */
  const [draggingId, setDraggingId] = useState<number | null>(null);

  // 列宽 = (容器宽 - 内边距 - 列间距) / 列数;列数由"基准列宽 × 缩放"决定
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const compute = () => {
      const w = el.clientWidth - PAD * 2;
      const target = Math.max(90, BASE_COL * zoom);
      const cols = Math.max(1, Math.round((w + GAP) / (target + GAP)));
      setColWidth((w - GAP * (cols - 1)) / cols);
    };
    compute();
    // 详情面板开/关时槽位宽度过渡(400ms)会让容器逐帧变窄/变宽。
    // 逐帧重算会出现「列宽渐缩 → 列数减一 → 列宽跳大」的锯齿循环,
    // 看起来就是图片疯狂缩小再放大;而且每帧全网格重排也很贵。
    // 去抖:尺寸稳定 140ms 后才重算一次,过渡期间保持旧布局(超出部分被 #cam-scroll 裁掉)。
    let timer = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(compute, 140);
    });
    ro.observe(el);
    return () => {
      window.clearTimeout(timer);
      ro.disconnect();
    };
  }, [zoom]);

  return (
    <div
      ref={wrapRef}
      className="cam-masonry"
      style={{
        display: 'grid',
        gridTemplateColumns: colWidth > 0 ? `repeat(auto-fill, ${colWidth}px)` : `repeat(auto-fill, minmax(160px, 1fr))`,
        justifyContent: 'center',
        gridAutoRows: ROW_UNIT,
        gap: GAP,
        padding: PAD,
      }}
    >
      {rows.map((r) => {
        const dims = r.dimensions;
        // 没有尺寸记录的图按 4:3 兜底(正常的图都有 IHDR 实测值)
        const ratio = dims && dims.width > 0 ? dims.height / dims.width : 1.33;
        // 卡片高 = 列宽 × 宽高比;span 向上取整,grid 行高 4px
        const heightPx = colWidth > 0 ? colWidth * ratio : 220;
        const span = Math.max(8, Math.ceil((heightPx + GAP) / (ROW_UNIT + GAP)));
        const picked = selectedIds.has(r.id);
        // 当前在详情面板里打开的那张:金色/强调色发光框,随时知道"我在看哪张"
        const isOpen = openId === r.id;
        return (
          <div
            key={r.id}
            className={`cam-card cam-mcard${picked ? ' picked' : ''}${r.starred ? ' starred' : ''}${
              isOpen ? ' open' : ''
            }${draggingId === r.id ? ' dragging' : ''}`}
            data-id={r.id}
            data-dragging={draggingId === r.id ? '1' : undefined}
            onClick={(e) => {
              if (e.ctrlKey || e.metaKey) onSelect(r.id, 'toggle');
              else if (e.shiftKey) onSelect(r.id, 'range');
              else onOpen(r.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu(r.id, e.clientX, e.clientY);
            }}
            // 双击 = 全屏查看原图。单击开详情的逻辑不动:双击会先触发两次单击
            // (同一个 id,幂等),再打开查看器盖在详情之上。
            onDoubleClick={() => onOpenViewer?.(r.id)}
            /**
             * 拖到左侧分类 = 加入分类(v0.6 需求)。
             * 拖的是"卡"而不是"图":img 上必须写死 draggable={false},
             * 否则 Chromium 会先起一次原生图片拖拽 —— 那一路没有私有 MIME 标记,
             * 会被外层当成"从资源管理器拖进来的文件",于是弹出解析元数据的提示层。
             */
            draggable
            onDragStart={(e) => {
              // 只有左键才发起拖拽(右键/中键留给菜单与"中键关闭标签")
              if (e.button !== 0) return;
              const ids = picked && selectedIds.size > 1 ? [...selectedIds] : [r.id];
              startImageDrag(ids, e.dataTransfer);
              // 不加 setDragImage:让 Chromium 直接截当前卡片(圆角/缩略图都在),
              // 自己造拖拽影像在 dragstart 当帧还没渲染,反而会拖出一张空白图
              setDraggingId(r.id);
            }}
            onDragEnd={() => {
              endImageDrag();
              setDraggingId(null);
              onDragEnd?.();
            }}
            title={`${r.fileName}\n双击查看原图 · 拖动可放到左侧分类里`}
            style={{
              gridRowEnd: `span ${span}`,
              position: 'relative',
              borderRadius: 12,
              overflow: 'hidden',
              cursor: draggingId === r.id ? 'grabbing' : 'grab',
            }}
          >
            <img
              src={thumbUrl(r.id)}
              alt={r.fileName}
              // 见 onDragStart 的注释:图片自己绝不允许起原生拖拽
              draggable={false}
              loading="lazy"
              ref={(el) => {
                // 命中缓存的图 onLoad 可能不触发:挂载时已完成就直接标记
                if (el && el.complete && el.naturalWidth > 0) el.classList.add('loaded');
              }}
              onLoad={(e) => e.currentTarget.classList.add('loaded')}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                display: 'block',
                background: 'var(--inset)',
              }}
              onError={(e) => {
                // 缩略图缺失时不要把浏览器默认破图图标留给用户
                const el = e.currentTarget;
                el.classList.add('loaded');
                el.style.opacity = '0.25';
                el.title = '缩略图尚未生成(可运行 thumb-sync 补齐)';
              }}
            />
            {/* 悬浮动作条:磨砂玻璃,平时隐藏。星星必须压过悬浮时的图片变换层(z-index 坑) */}
            <div className="cam-card-bar">
              <button
                type="button"
                className={`cam-pick${picked ? ' on' : ''}`}
                title={picked ? '取消选择' : '选中(可多选)'}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(r.id, 'toggle');
                }}
              >
                {picked ? '✓' : ''}
              </button>
              <button
                type="button"
                className={`cam-star${r.starred ? ' on' : ''}`}
                title={r.starred ? '取消收藏' : '收藏'}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleStar(r.id, !r.starred);
                }}
              >
                {r.starred ? '★' : '☆'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
});
