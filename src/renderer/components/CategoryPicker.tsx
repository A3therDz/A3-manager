/**
 * 「加入分类」选择弹层 —— 详情面板(单图)与底部批量条(多图)共用。
 *
 * 与旧版的关键区别(本轮需求):
 *   - 勾选只是**暂存**,点「确定」才一次性落库;「取消」丢弃全部改动。
 *     旧版每勾一下就立刻写库 + 刷新,批量整理时一路弹 toast,也无法反悔。
 *   - 没有了「新建并加入」:输入框旁的「新建」只创建分类(出现在列表里,不勾选),
 *     要不要把图放进去由勾选 + 确定决定。
 *   - 支持一次把**多张图**加入多个分类(setCategoryMembers 本身收数组)。
 *
 * 模式:
 *   - 传 initialChecked(单图详情)= 指派模式:预勾选当前归属,确定时按差集增删;
 *   - 不传(批量条)= 追加模式:勾选的都是"要加入",不做移出。
 */

import { useEffect, useMemo, useState } from 'react';
import type { CategoryNode } from '@shared/types';
import { errMsg } from '../api';

interface Props {
  categories: CategoryNode[];
  /** 目标图片 id:单图传 1 个,批量传整批 */
  imageIds: number[];
  /** 单图模式传当前归属(预勾选);批量模式省略 = 只加不移 */
  initialChecked?: number[];
  onClose: () => void;
  /** 应用成功(或新建了分类)后回调,父组件负责刷新分类树与归属 */
  onApplied: () => void;
  notify: (msg: string, bad?: boolean) => void;
}

export function CategoryPicker({ categories, imageIds, initialChecked, onClose, onApplied, notify }: Props) {
  const [checked, setChecked] = useState<Set<number>>(() => new Set(initialChecked ?? []));
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const assignMode = initialChecked !== undefined;

  // 弹层打开期间:Esc 关弹层而不是关详情/清空多选;← → 不翻页(capture 阶段拦截)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.stopPropagation();
        if (e.key === 'Escape' && !busy) onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onClose]);

  // 分类树拍平成带缩进的列表
  const flatCats = useMemo(() => {
    const out: Array<{ n: CategoryNode; depth: number }> = [];
    const walk = (ns: CategoryNode[], depth: number) => {
      for (const n of ns) {
        out.push({ n, depth });
        walk(n.children || [], depth + 1);
      }
    };
    walk(categories, 0);
    return out;
  }, [categories]);

  const toggle = (id: number, member: boolean) => {
    setChecked((cur) => {
      const next = new Set(cur);
      if (member) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  /** 只创建分类,不加入(确定键才决定归属) */
  const createOnly = async () => {
    const name = newName.trim();
    if (!name) {
      notify('请输入分类名', true);
      return;
    }
    try {
      const c = await window.api.createCategory({ name });
      setNewName('');
      notify(`已创建「${c.name}」,勾选后点确定生效`);
      onApplied();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  const apply = async () => {
    if (busy) return;
    const before = new Set(initialChecked ?? []);
    const adds = [...checked].filter((id) => !before.has(id));
    const removes = assignMode ? [...before].filter((id) => !checked.has(id)) : [];
    if (adds.length === 0 && removes.length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      for (const id of adds) await window.api.setCategoryMembers(id, imageIds, true);
      for (const id of removes) await window.api.setCategoryMembers(id, imageIds, false);
      const parts: string[] = [];
      if (adds.length) parts.push(imageIds.length > 1 ? `已把 ${imageIds.length} 张加入 ${adds.length} 个分类` : `已加入 ${adds.length} 个分类`);
      if (removes.length) parts.push(`移出 ${removes.length} 个分类`);
      notify(parts.join(','));
      onApplied();
      onClose();
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="cam-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          width: 420,
          maxHeight: '70vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <h2 style={{ fontSize: 13, margin: 0, padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
          {imageIds.length > 1 ? `把 ${imageIds.length} 张图片加入分类` : '加入分类'}
        </h2>
        <div style={{ overflowY: 'auto', padding: '6px 0', flex: 1 }}>
          {flatCats.length === 0 ? (
            <div style={{ color: 'var(--muted)', fontSize: 11, padding: '10px 14px' }}>
              还没有分类,在下面输入名字新建一个。
            </div>
          ) : (
            flatCats.map(({ n, depth }) => (
              <label
                key={n.id}
                className="cam-catpick-row"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: `5px 14px 5px ${14 + depth * 14}px`,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked.has(n.id)}
                  onChange={(e) => toggle(n.id, e.target.checked)}
                  style={{ width: 14, height: 14, accentColor: 'var(--accent)' }}
                />
                <span
                  style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {n.name}
                </span>
                <span style={{ color: 'var(--muted)', fontSize: 10 }}>
                  {n.totalCount}{n.relDir ? ' ·文件夹' : ''}
                </span>
              </label>
            ))
          )}
        </div>
        <div
          style={{
            padding: '10px 14px 0',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            gap: 8,
          }}
        >
          <input
            type="text"
            placeholder="新建分类名…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createOnly();
            }}
            style={{
              flex: 1,
              background: 'var(--panel2)',
              border: '1px solid var(--border)',
              color: 'var(--fg)',
              borderRadius: 6,
              padding: '5px 9px',
              font: 'inherit',
              fontSize: 12,
              outline: 'none',
            }}
          />
          <button type="button" style={btn} onClick={() => void createOnly()}>
            新建
          </button>
        </div>
        <div style={{ padding: '10px 14px', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" style={btn} disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            style={{ ...btn, borderColor: 'var(--accent)', color: 'var(--accent)', fontWeight: 600 }}
            disabled={busy}
            onClick={() => void apply()}
          >
            {busy ? '应用中…' : '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  background: 'var(--panel2)',
  border: '1px solid var(--border)',
  color: 'var(--fg)',
  borderRadius: 5,
  padding: '3px 12px',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 12,
};
