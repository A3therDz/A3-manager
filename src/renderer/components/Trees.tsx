/**
 * 侧边栏:文件夹树 + 用户自定义分类树。
 *
 * 这里刻意把"两套机制"并列展示,因为它们的语义不同(见 shared/types.ts 的 Category 注释):
 *   文件夹 = 图片在磁盘上的位置(扫描得出,不可编辑)
 *   分类   = 用户定义的集合(手动维护,可跨文件夹)
 *
 * 视觉与交互对齐已交付的静态图库(data/gallery-full/gallery.html),K3 可对照精修。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CategoryNode, FolderNode } from '@shared/types';
import { errMsg } from '../api';

/** 文件夹树只需要文件夹相关字段 */
interface FolderTreeProps {
  folders: FolderNode[];
  activeDir: string | null;
  onPickDir: (relDir: string | null) => void;
  /** 右键文件夹(重命名备注 / 隐藏) */
  onContextMenu?: (node: FolderNode, x: number, y: number) => void;
}

/** 分类树只需要分类相关字段 */
interface CategoryTreeProps {
  categories: CategoryNode[];
  activeCat: number | null;
  onPickCat: (id: number | null) => void;
  /** 分类数据发生增删改后回调,父组件负责刷新树与图片归属 */
  onChanged: () => void;
  /** 轻提示 */
  notify: (msg: string, bad?: boolean) => void;
}

/** 收集分类节点及其所有后代 id(用于递归筛选与计数) */
export function withDescendants(node: CategoryNode): number[] {
  const out = [node.id];
  for (const c of node.children || []) out.push(...withDescendants(c));
  return out;
}

function Row({
  label,
  count,
  depth,
  active,
  hint,
  title,
  onContextMenu,
  onClick,
}: {
  label: string;
  count: number;
  depth: number;
  active: boolean;
  hint?: string;
  title?: string;
  onContextMenu?: (x: number, y: number) => void;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault();
              onContextMenu(e.clientX, e.clientY);
            }
          : undefined
      }
      title={title ?? label}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: `4px 12px 4px ${12 + depth * 12}px`,
        background: active ? 'var(--accent-soft)' : 'transparent',
        border: 0,
        borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
        color: active ? 'var(--accent)' : 'var(--fg)',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      <span style={{ float: 'right', color: 'var(--muted)', fontSize: 11 }}>{count}</span>
      {label}
      {hint ? <span style={{ marginLeft: 6, color: 'var(--muted)', fontSize: 10 }}>{hint}</span> : null}
    </button>
  );
}

export function FolderTree({ folders, activeDir, onPickDir, onContextMenu }: FolderTreeProps) {
  // 展开状态:默认展开第一层
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const total = useMemo(() => folders.reduce((s, f) => s + f.totalCount, 0), [folders]);

  const walk = (nodes: FolderNode[], depth: number) => {
    const out: JSX.Element[] = [];
    for (const n of nodes) {
      const key = `${n.rootId}|${n.relDir}`;
      const hasKids = n.children.length > 0;
      const isOpen = open[key] ?? depth === 0;
      // 设置里取消勾选的文件夹不在左侧出现(根节点永远显示)
      if (n.hidden && depth > 0) continue;
      const diskName = n.relDir === '' ? `[${n.rootLabel}]` : n.relDir.split(/[\\/]/).pop() || n.relDir;
      const label = n.alias ? n.alias : diskName;
      out.push(
        <div key={key}>
          <Row
            label={`${hasKids ? (isOpen ? '▾ ' : '▸ ') : '  '}${label}`}
            count={n.totalCount}
            depth={depth}
            active={activeDir === n.relDir && n.relDir !== ''}
            hint={n.alias ? '备注' : undefined}
            title={n.alias ? `${n.alias}(${diskName})` : diskName}
            onContextMenu={
              onContextMenu ? (x, y) => onContextMenu(n, x, y) : undefined
            }
            onClick={() => {
              if (hasKids) setOpen((o) => ({ ...o, [key]: !isOpen }));
              onPickDir(n.relDir === '' ? null : n.relDir);
            }}
          />
          {hasKids && isOpen ? (
            <div>{walk(n.children, depth + 1)}</div>
          ) : null}
        </div>
      );
    }
    return out;
  };

  return (
    <div>
      <div style={headerStyle}>文件夹</div>
      <Row
        label="全部"
        count={total}
        depth={0}
        active={activeDir === null}
        onClick={() => onPickDir(null)}
      />
      {walk(folders, 0)}
    </div>
  );
}

/**
 * 设置面板里的"文件夹显示"勾选树:勾上 = 左侧显示。
 * 与左侧栏用的是同一棵树,只是这里把 hidden 的也画出来。
 */
export function FolderVisibilityTree({
  folders,
  onToggle,
}: {
  folders: FolderNode[];
  onToggle: (rootId: number, relDir: string, hidden: boolean) => void;
}) {
  // 折叠状态:默认只展开根,子文件夹收起来 —— 图库里日期文件夹有几十个,
  // 全铺开的话要一路滚下去才能找到目标。
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const allKeys: string[] = [];
  const collect = (nodes: FolderNode[]) => {
    for (const n of nodes) {
      if (n.children.length) allKeys.push(`${n.rootId}|${n.relDir}`);
      collect(n.children);
    }
  };
  collect(folders);

  const isOpen = (key: string, depth: number) => open[key] ?? depth === 0;
  const toggleOpen = (key: string, depth: number) =>
    setOpen((o) => ({ ...o, [key]: !isOpen(key, depth) }));
  const setAll = (v: boolean) =>
    setOpen(Object.fromEntries(allKeys.map((k) => [k, v])));

  const rows: JSX.Element[] = [];
  const walk = (nodes: FolderNode[], depth: number) => {
    for (const n of nodes) {
      const key = `${n.rootId}|${n.relDir}`;
      const hasKids = n.children.length > 0;
      const opened = isOpen(key, depth);
      const diskName = n.relDir === '' ? `[${n.rootLabel}]` : n.relDir.split(/[\\/]/).pop() || n.relDir;
      rows.push(
        <div
          key={key}
          style={{ display: 'flex', alignItems: 'center', gap: 4, paddingLeft: 4 + depth * 14 }}
        >
          <button
            type="button"
            title={hasKids ? (opened ? '折叠' : '展开') : ''}
            disabled={!hasKids}
            onClick={() => toggleOpen(key, depth)}
            style={{
              width: 16,
              flexShrink: 0,
              background: 'none',
              border: 0,
              color: 'var(--muted)',
              font: 'inherit',
              fontSize: 10,
              cursor: hasKids ? 'pointer' : 'default',
              opacity: hasKids ? 1 : 0,
              padding: 0,
            }}
          >
            {opened ? '▾' : '▸'}
          </button>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              flex: 1,
              minWidth: 0,
              padding: '3px 6px 3px 0',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={!(n.hidden ?? false)}
              disabled={n.relDir === ''}
              onChange={(e) => onToggle(n.rootId, n.relDir, !e.target.checked)}
            />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {n.alias ? n.alias : diskName}
              {n.alias ? <span style={{ color: 'var(--muted)', fontSize: 10 }}> ({diskName})</span> : null}
            </span>
            <span style={{ color: 'var(--muted)', fontSize: 10 }}>{n.totalCount}</span>
          </label>
        </div>
      );
      if (hasKids && opened) walk(n.children, depth + 1);
    }
  };
  walk(folders, 0);

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
        <button
          type="button"
          onClick={() => setAll(true)}
          style={{ background: 'none', border: 0, color: 'var(--muted)', font: 'inherit', fontSize: 11, cursor: 'pointer', padding: 0 }}
        >
          全部展开
        </button>
        <span style={{ color: 'var(--border)' }}>|</span>
        <button
          type="button"
          onClick={() => setAll(false)}
          style={{ background: 'none', border: 0, color: 'var(--muted)', font: 'inherit', fontSize: 11, cursor: 'pointer', padding: 0 }}
        >
          全部折叠
        </button>
      </div>
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>{rows}</div>
    </div>
  );
}

export function CategoryTree({ categories, activeCat, onPickCat, onChanged, notify }: CategoryTreeProps) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  // 新建:点「+ 新建」展开一个内联输入框(Electron 不支持 window.prompt)
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  // 改名:正在编辑的分类 id;删除:等待二次确认的分类 id
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const confirmTimer = useRef(0);

  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);

  const totalAll = useMemo(
    () => categories.reduce((s, c) => s + c.totalCount, 0),
    [categories]
  );

  const submitCreate = async () => {
    const name = newName.trim();
    if (!name) {
      setCreating(false);
      return;
    }
    try {
      await window.api.createCategory({ name });
      notify(`已创建「${name}」`);
      setNewName('');
      setCreating(false);
      onChanged();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  const submitRename = async (id: number, oldName: string) => {
    const name = editName.trim();
    setEditingId(null);
    if (!name || name === oldName) return;
    try {
      await window.api.updateCategory(id, { name });
      notify('已改名');
      onChanged();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  const handleDelete = async (n: CategoryNode) => {
    // 第一次点击只进入确认态,2.5s 内再点一次才真正删除(替代 confirm 对话框)
    if (confirmId !== n.id) {
      setConfirmId(n.id);
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirmId(null), 2500);
      return;
    }
    window.clearTimeout(confirmTimer.current);
    setConfirmId(null);
    try {
      await window.api.deleteCategory(n.id, true);
      notify(`已删除「${n.name}」`);
      if (activeCat === n.id) onPickCat(null);
      onChanged();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  const walk = (nodes: CategoryNode[], depth: number) => {
    const out: JSX.Element[] = [];
    for (const n of nodes) {
      const hasKids = n.children.length > 0;
      const isOpen = open[n.id] ?? true;
      out.push(
        <div key={n.id}>
          {editingId === n.id ? (
            <input
              autoFocus
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={() => void submitRename(n.id, n.name)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitRename(n.id, n.name);
                if (e.key === 'Escape') setEditingId(null);
              }}
              style={{ ...inlineInput, marginLeft: 12 + depth * 12 }}
            />
          ) : (
            <div className="cam-cat-row" style={{ display: 'flex', alignItems: 'center' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Row
                  label={`${hasKids ? (isOpen ? '▾ ' : '▸ ') : '  '}${n.name}`}
                  count={n.totalCount}
                  depth={depth}
                  active={activeCat === n.id}
                  // 绑定了源文件夹的分类会标出来,与"纯虚拟分组"区分
                  hint={n.relDir ? '·文件夹' : undefined}
                  onClick={() => {
                    if (hasKids) setOpen((o) => ({ ...o, [n.id]: !isOpen }));
                    onPickCat(activeCat === n.id ? null : n.id);
                  }}
                />
              </div>
              <button
                type="button"
                className="cam-mini"
                title="重命名分类"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditName(n.name);
                  setEditingId(n.id);
                }}
              >
                改名
              </button>
              <button
                type="button"
                className={`cam-mini del${confirmId === n.id ? ' confirm' : ''}`}
                title="删除分类(子分类一并删除,图片文件不受影响)"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleDelete(n);
                }}
              >
                {confirmId === n.id ? '确认?' : '删'}
              </button>
            </div>
          )}
          {hasKids && isOpen ? <div>{walk(n.children, depth + 1)}</div> : null}
        </div>
      );
    }
    return out;
  };

  return (
    <div>
      <div style={{ ...headerStyle, display: 'flex', alignItems: 'center' }}>
        分类
        <button
          type="button"
          style={newBtn}
          title="新建分类"
          onClick={() => {
            setCreating((v) => !v);
            setNewName('');
          }}
        >
          + 新建
        </button>
      </div>
      {creating ? (
        <div style={{ display: 'flex', gap: 4, padding: '2px 12px 4px' }}>
          <input
            autoFocus
            placeholder="新分类名…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitCreate();
              if (e.key === 'Escape') setCreating(false);
            }}
            style={{ ...inlineInput, flex: 1, marginLeft: 0 }}
          />
          <button type="button" style={newBtn} onClick={() => void submitCreate()}>
            创建
          </button>
        </div>
      ) : null}
      <Row
        label="全部分类"
        count={totalAll}
        depth={0}
        active={activeCat === null}
        onClick={() => onPickCat(null)}
      />
      {walk(categories, 1)}
      {categories.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 11, padding: '2px 12px 6px' }}>
          还没有分类,点右上「+ 新建」
        </div>
      ) : null}
    </div>
  );
}

const headerStyle: React.CSSProperties = {
  padding: '8px 12px 4px',
  color: 'var(--muted)',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
};

const newBtn: React.CSSProperties = {
  marginLeft: 'auto',
  background: 'none',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--muted)',
  padding: '1px 6px',
  fontSize: 11,
  cursor: 'pointer',
  fontFamily: 'inherit',
  textTransform: 'none',
  letterSpacing: 0,
};

const inlineInput: React.CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--accent)',
  color: 'var(--fg)',
  borderRadius: 4,
  padding: '2px 6px',
  font: 'inherit',
  fontSize: 12,
  outline: 'none',
  width: 'calc(100% - 24px)',
  margin: '2px 0',
};
