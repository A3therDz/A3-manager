/**
 * 浮层的"有始有终"卸载。
 *
 * 问题:React 里把 state 置空,元素当帧就没了 —— 进场动画有,退场永远是"啪"地消失。
 * 做法:关闭时先只标记 closing(让退场关键帧跑完),等 CLOSE_MS 之后再真正卸载。
 * 中间态由返回值里的 closing 暴露给 CSS 用。
 *
 * App.tsx 与 DetailPanel.tsx 共用(详情面板里的 CategoryPicker 也是弹层)。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** 退场动画时长:与 main.tsx 里 .closing 关键帧的 var(--dur-1) 对齐并留余量 */
const CLOSE_MS = 160;

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function useDelayedClose<T>() {
  const [value, setValue] = useState<T | null>(null);
  const [closing, setClosing] = useState(false);
  const timer = useRef(0);

  const close = useCallback(() => {
    setClosing((already) => {
      if (already) return true;
      // 用户要求减少动画时直接卸载,不给无意义的等待
      if (prefersReducedMotion()) {
        setValue(null);
        return false;
      }
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        setValue(null);
        setClosing(false);
      }, CLOSE_MS);
      return true;
    });
  }, []);

  const open = useCallback((v: T) => {
    window.clearTimeout(timer.current);
    setClosing(false);
    setValue(v);
  }, []);

  const toggle = useCallback(
    (next: T | null) => {
      if (next === null) close();
      else open(next);
    },
    [close, open]
  );

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { value, closing, open, close, toggle };
}
