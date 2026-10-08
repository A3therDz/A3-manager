/**
 * 并排比对台(v0.8,全屏模态,层级高于 ComparePanel)。
 *
 * 2–4 张图并排、**等宽**、contain 显示,**共用同一缩放与平移** —— 这样才能看出
 * "同一个提示词、换一组 LoRA 之后,细节差在哪"(分别缩放就没法比了)。
 *
 * 交互与 Lightbox 同一套:滚轮以光标为锚点缩放(0.1x–8x)、按住拖动平移、双击复位;
 * 缩放/平移只动 transform(合成层,不重排)。Esc / × 只关这一层(不顺手关下面的比对面板)。
 * 图片用 cam-file 原始清晰度 —— 这一层的全部意义就是看细节。
 */

import { useEffect, useRef, useState } from 'react';
import type { CompareRow } from '@shared/types';
import { UNMATCHED_TITLE } from '@shared/compare';
import { fileUrl } from '../api';

interface Props {
  rows: CompareRow[];
  closing: boolean;
  onClose: () => void;
}

/** 缩放范围:相对"适应窗口"的倍率(与 Lightbox 一致) */
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;

export function CompareStage({ rows, closing, onClose }: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  /** 视图:z = 相对适应窗口的倍率,x/y = 平移像素 */
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  // 换一批图 → 复位(上一批的缩放对不上这一批的构图)
  useEffect(() => {
    setView({ z: 1, x: 0, y: 0 });
    panRef.current = null;
    setPanning(false);
  }, [rows]);

  // 滚轮缩放:必须 passive:false + preventDefault,否则 Chromium 会缩放整页。
  // 锚点是光标位置:光标下的那个像素点缩放前后停在原地(变换以元素中心为原点,
  // 所以这里换算成"相对舞台中心"的偏移)。
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

  const label = (r: CompareRow) =>
    `${r.recipeTitles.length > 0 ? r.recipeTitles[0] : UNMATCHED_TITLE} · ${r.fileName} · seed ${r.seed ?? '未记录'}`;

  return (
    <div className={`cam-cmp2${closing ? ' closing' : ''}`} role="dialog" aria-label="并排比对">
      <div className="cam-cmp-top">
        <span className="cam-cmp-title">并排比对</span>
        <span className="cam-cmp-hint">滚轮缩放 · 拖动平移 · 双击复位</span>
        <span className="cam-cmp-count">{Math.round(view.z * 100)}%</span>
        <button
          type="button"
          className="cam-lb-btn"
          title="复位(双击图片同效)"
          onClick={() => setView({ z: 1, x: 0, y: 0 })}
        >
          适应窗口
        </button>
        <button type="button" className="cam-lb-btn" title="关闭 (Esc)" onClick={onClose}>
          ×
        </button>
      </div>

      <div
        ref={stageRef}
        className="cam-cmp2-stage"
        style={{ cursor: panning ? 'grabbing' : 'grab' }}
        onDoubleClick={() => setView({ z: 1, x: 0, y: 0 })}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
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
      >
        <div
          className="cam-cmp2-track"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}
        >
          {rows.map((r) => (
            <div className="cam-cmp2-cell" key={r.id}>
              <img src={fileUrl(r.id)} alt={r.fileName} draggable={false} />
            </div>
          ))}
        </div>
      </div>

      {/* 标签行不做变换(跟着缩放会变成大字);与上面的等宽单元格一一对齐 */}
      <div className="cam-cmp2-labels">
        {rows.map((r) => (
          <div className="cam-cmp2-label" key={r.id} title={label(r)}>
            {label(r)}
          </div>
        ))}
      </div>
    </div>
  );
}
