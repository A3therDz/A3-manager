/**
 * 全屏原图查看器(Lightbox, v0.8)。
 *
 * 双击网格卡片 / 详情面板预览图打开,用 cam-file://file/<id> 加载原图(最高清晰度)。
 *   - Esc / × / 点图外空白关闭(退场动画由 App 的 useDelayedClose 保证播完);
 *   - ‹ › 按钮与 ← → 方向键(方向键在 App 的键盘钩子里接)在
 *     「当前标签页已加载列表」里翻页,与详情面板翻页同一份 rows;
 *   - 滚轮缩放(相对"适应窗口" 0.1x–8x,以光标为锚点);放大后按住拖动平移;
 *   - 顶栏显示 序号/总数 与文件名;「适应窗口 / 实际大小」按钮;双击图片复位为适应窗口。
 *
 * 性能约束:平移/缩放只动 transform(合成层,不重排);整层面板用 97% 不透明
 * 底色(var(--modal-bg)),不开 backdrop-filter —— 它正好压在整屏滚动网格上。
 */

import { useEffect, useRef, useState } from 'react';
import type { ImageRecord } from '@shared/types';
import { fileUrl } from '../api';

interface Props {
  /** 当前标签页已加载的图片列表:翻页范围 + 文件名来源 */
  rows: ImageRecord[];
  /** 当前查看的图片 id */
  id: number;
  /** 退场动画标记(App 的 useDelayedClose 延迟卸载) */
  closing: boolean;
  onClose: () => void;
  onNavigate: (id: number) => void;
}

/** 缩放范围:相对"适应窗口"的倍率 */
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;

export function Lightbox({ rows, id, closing, onClose, onNavigate }: Props) {
  const idx = rows.findIndex((r) => r.id === id);
  const fileName = idx >= 0 ? rows[idx].fileName : '';

  const stageRef = useRef<HTMLDivElement | null>(null);
  /** 原图天然尺寸(onLoad 后才知道) */
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  /** 舞台尺寸(跟着窗口走) */
  const [stage, setStage] = useState<{ w: number; h: number } | null>(null);
  /** 视图:z = 相对"适应窗口"的倍率(1 = 适应),x/y = 平移像素 */
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  // 换图:复位缩放/平移,天然尺寸等新图 onLoad
  useEffect(() => {
    setView({ z: 1, x: 0, y: 0 });
    setNatural(null);
    panRef.current = null;
    setPanning(false);
  }, [id]);

  // 舞台尺寸:ResizeObserver 跟窗口
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = natural && stage ? Math.min(stage.w / natural.w, stage.h / natural.h) : 1;
  const scale = fit * view.z;
  const dispW = natural ? Math.max(1, Math.round(natural.w * scale)) : 0;
  const dispH = natural ? Math.max(1, Math.round(natural.h * scale)) : 0;
  /** 图比舞台大才可以拖动平移 */
  const canPan = stage !== null && (dispW > stage.w + 1 || dispH > stage.h + 1);

  // 滚轮缩放:必须 passive:false + preventDefault,否则 Chromium 会缩放/滚动整个页面。
  // 锚点是光标位置:光标下的那个图点,缩放前后停在原地。
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      setView((v) => {
        const z2 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        if (z2 === v.z) return v;
        const k = z2 / v.z;
        return { z: z2, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const resetView = () => setView({ z: 1, x: 0, y: 0 });
  /** 实际大小:有效倍率 = fit × z = 1 */
  const actualSize = () => setView({ z: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, 1 / fit)), x: 0, y: 0 });

  const goPrev = () => {
    if (idx > 0) onNavigate(rows[idx - 1].id);
  };
  const goNext = () => {
    if (idx >= 0 && idx < rows.length - 1) onNavigate(rows[idx + 1].id);
  };

  return (
    <div className={`cam-lightbox${closing ? ' closing' : ''}`} role="dialog" aria-label="原图查看器">
      <div
        ref={stageRef}
        className="cam-lb-stage"
        // 点图外的空白 = 关闭;拖动图片不会误关(drag 起点在 img 上)
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {/* 天然尺寸未知时先用 max-width/max-height 适应窗口,onLoad 后换精确像素宽 */}
        <img
          src={fileUrl(id)}
          alt={fileName}
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth > 0) setNatural({ w: img.naturalWidth, h: img.naturalHeight });
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            resetView();
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 || !canPan) return;
            panRef.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
            e.currentTarget.setPointerCapture(e.pointerId);
            setPanning(true);
          }}
          onPointerMove={(e) => {
            const d = panRef.current;
            if (!d) return;
            setView((v) => ({ ...v, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py }));
          }}
          onPointerUp={() => {
            panRef.current = null;
            setPanning(false);
          }}
          onPointerCancel={() => {
            panRef.current = null;
            setPanning(false);
          }}
          style={
            natural
              ? {
                  width: dispW,
                  height: dispH,
                  transform: `translate(${view.x}px, ${view.y}px)`,
                  cursor: canPan ? (panning ? 'grabbing' : 'grab') : 'default',
                }
              : { maxWidth: '100%', maxHeight: '100%' }
          }
        />
      </div>

      <div className="cam-lb-top">
        <span style={{ color: 'var(--muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
          {idx >= 0 ? `${idx + 1} / ${rows.length}` : ''}
        </span>
        <span className="cam-lb-name" title={fileName}>
          {fileName}
        </span>
        <span style={{ color: 'var(--muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
          {Math.round(scale * 100)}%
        </span>
        <button type="button" className="cam-lb-btn" title="适应窗口(双击图片同效)" onClick={resetView}>
          适应窗口
        </button>
        <button type="button" className="cam-lb-btn" title="按原始像素 1:1 显示" onClick={actualSize}>
          实际大小
        </button>
        <button type="button" className="cam-lb-btn" title="关闭 (Esc)" onClick={onClose}>
          ×
        </button>
      </div>

      <button
        type="button"
        className="cam-lb-btn cam-lb-nav prev"
        title="上一张 (←)"
        disabled={idx <= 0}
        onClick={goPrev}
      >
        ‹
      </button>
      <button
        type="button"
        className="cam-lb-btn cam-lb-nav next"
        title="下一张 (→)"
        disabled={idx < 0 || idx >= rows.length - 1}
        onClick={goNext}
      >
        ›
      </button>
    </div>
  );
}
