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
import { endImageDrag, getImageDragIds, isImageDrag, readImageDragIds } from '../dnd';

/** 文件夹树只需要文件夹相关字段 */
interface FolderTreeProps {
  folders: FolderNode[];
  activeDir: string | null;
  onPickDir: (relDir: string | null) => void;
  /** 双击文件夹 = 用资源管理器打开它在磁盘上的位置(不改变左侧筛选) */
  onOpenFolder?: (node: FolderNode) => void;
  /** 右键文件夹(打开位置 / 重命名备注 / 隐藏) */
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
  /** 把网格里拖过来的图片加入这个分类(v0.6);不传 = 无拖放能力 */
  onDropImage?: (categoryId: number, imageIds: number[]) => void;
}

/** 收集分类节点及其所有后代 id(用于递归筛选与计数) */
export function withDescendants(node: CategoryNode): number[] {
  const out = [node.id];
  for (const c of node.children || []) out.push(...withDescendants(c));
  return out;
}

/**
 * 文件夹图标(v0.6 需求 6)。
 *
 * 为什么做成图标:以前文件夹行只是"一行文字 + 右边一个数字",和图片卡片一样
 * 灰扑扑的,一眼看不出这是**文件夹**。加一个实心的文件夹图标之后,
 * 左侧拦一眼就能分出"文件夹"和"图片",也更容易点。
 */
export function FolderIcon({ size = 13, open = false }: { size?: number; open?: boolean }) {
  return (
    <svg
      className="cam-folder-ico"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      {/* 打开时把"盖子"微微掀起来,和树里的 ▾ 是一个意思 */}
      <path d={open ? 'M1.6 6.2h12.8L13 13.1H3z' : 'M1.6 6.2h12.8v6.9H1.6z'} />
      <path d="M1.6 3.1h4.2l1.5 2.1h6v1h-11.7z" opacity=".75" />
    </svg>
  );
}

function Row({
  label,
  count,
  depth,
  active,
  hint,
  title,
  /** 左侧图标:文件夹树传 <FolderIcon />,分类树不传(靠缩进与文字区分) */
  icon,
  /** 展开/折叠的箭头(和文字分开,避免"▸名字"挤在一起) */
  caret,
  /** 点箭头:只负责展开/折叠,不切换筛选 */
  onToggle,
  /** 这一层只有自己一个文件夹时,不画引导线(少一层视觉噪音) */
  onlyChild,
  onContextMenu,
  onDoubleClick,
  onClick,
}: {
  label: string;
  count: number;
  depth: number;
  active: boolean;
  hint?: string;
  title?: string;
  icon?: React.ReactNode;
  caret?: '▾' | '▸';
  onToggle?: () => void;
  onlyChild?: boolean;
  onContextMenu?: (x: number, y: number) => void;
  onDoubleClick?: () => void;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`cam-treerow${active ? ' on' : ''}${icon ? ' folder' : ''}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
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
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        textAlign: 'left',
        padding: `4px 12px 4px ${10 + depth * 12}px`,
        background: active ? 'var(--accent-soft)' : 'transparent',
        border: 0,
        borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
        color: active ? 'var(--accent)' : 'var(--fg)',
        font: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      {/* 引导线:让层级一眼可见 */}
      {depth > 0 ? (
        <span
          className="cam-tree-guide"
          aria-hidden="true"
          style={{ opacity: onlyChild ? 0.35 : 1, marginLeft: -6 }}
        />
      ) : null}

      {onToggle ? (
        <span
          className="cam-tree-caret"
          role="button"
          aria-label={caret === '▾' ? '折叠' : '展开'}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          {caret ?? '▸'}
        </span>
      ) : (
        // 没有子目录时留出等宽空位,同级文字才不会左右错开
        <span className="cam-tree-caret cam-tree-caret-empty" aria-hidden="true" />
      )}

      {icon}

      <span className="cam-tree-label">{label}</span>
      {hint ? <span className="cam-tree-hint">{hint}</span> : null}
      <span className="cam-tree-count">{count}</span>
    </button>
  );
}

export function FolderTree({ folders, activeDir, onPickDir, onOpenFolder, onContextMenu }: FolderTreeProps) {
  // 展开状态:默认展开第一层
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const total = useMemo(() => folders.reduce((s, f) => s + f.totalCount, 0), [folders]);
  /**
   * 每个目录是不是"父目录唯一的孩子"。
   * 用来少画一层引导线:图库根下只有一个日期目录时,那一竖线纯属噪音。
   */
  const onlyChildMap = useMemo(() => {
    const m = new Map<string, boolean>();
    const walk = (nodes: FolderNode[], parentHasOne: boolean) => {
      for (const n of nodes) {
        m.set(`${n.rootId}|${n.relDir}`, parentHasOne);
        walk(n.children || [], nodes.length === 1);
      }
    };
    walk(folders, false);
    return m;
  }, [folders]);

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
      const toggle = hasKids ? () => setOpen((o) => ({ ...o, [key]: !isOpen })) : undefined;
      out.push(
        <div key={key}>
          <Row
            label={label}
            count={n.totalCount}
            depth={depth}
            active={activeDir === n.relDir && n.relDir !== ''}
            hint={n.alias ? '备注' : undefined}
            icon={<FolderIcon open={hasKids && isOpen} />}
            caret={hasKids ? (isOpen ? '▾' : '▸') : undefined}
            onToggle={toggle}
            onlyChild={depth > 0 && onlyChildMap.get(key) === true}
            title={
              (n.alias ? `${n.alias}(${diskName})` : diskName) +
              '\n单击筛选(含所有子目录) · 双击打开所在位置 · 右键更多'
            }
            onDoubleClick={onOpenFolder ? () => onOpenFolder(n) : undefined}
            onContextMenu={
              onContextMenu ? (x, y) => onContextMenu(n, x, y) : undefined
            }
            onClick={() => {
              // 点点在行上:该收就收、该开就开,然后照样切到这个目录。
              // (以前只能靠点箭头,行本身点了不展开,和文件夹树的习惯不一样)
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
        icon={<FolderIcon open />}
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

export function CategoryTree({ categories, activeCat, onPickCat, onChanged, notify, onDropImage }: CategoryTreeProps) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  // 新建:点「+ 新建」展开一个内联输入框(Electron 不支持 window.prompt)
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  // 改名:正在编辑的分类 id;删除:等待二次确认的分类 id
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const confirmTimer = useRef(0);
  // 拖放:当前悬停在哪一行(高亮用)+ 进出深度(判断"真的离开了这一行")
  const [dragOverCat, setDragOverCat] = useState<number | null>(null);
  const dragLeaveDepth = useRef(0);

  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);

  /** 拖放高亮:进入某一行时点亮,离开时熄灭 */
  const markDragOver = (id: number) => {
    dragLeaveDepth.current = 0;
    setDragOverCat((cur) => (cur === id ? cur : id));
  };
  const clearDragOver = () => {
    setDragOverCat(null);
    dragLeaveDepth.current = 0;
  };

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
            <div
              className="cam-cat-row"
              style={{
                display: 'flex',
                alignItems: 'center',
                borderRadius: 6,
                // 拖到这一行上方:整行发光,松手就加入这个分类
                boxShadow: dragOverCat === n.id ? 'inset 0 0 0 2px var(--accent)' : undefined,
                background: dragOverCat === n.id ? 'var(--accent-soft)' : undefined,
              }}
              onDragOver={
                onDropImage
                  ? (e) => {
                      // 只接受"从网格里拖过来的卡片",文件拖入窗口的解析流程不受影响;
                      // MIME 被 startDrag 吃掉时退回看模块级 store
                      if (!isImageDrag(e.dataTransfer) && getImageDragIds().length === 0) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'copy';
                      markDragOver(n.id);
                    }
                  : undefined
              }
              onDragEnter={
                onDropImage
                  ? (e) => {
                      if (!isImageDrag(e.dataTransfer) && getImageDragIds().length === 0) return;
                      dragLeaveDepth.current += 1;
                      markDragOver(n.id);
                    }
                  : undefined
              }
              onDragLeave={
                onDropImage
                  ? () => {
                      dragLeaveDepth.current -= 1;
                      if (dragLeaveDepth.current <= 0) clearDragOver();
                    }
                  : undefined
              }
              onDrop={
                onDropImage
                  ? (e) => {
                      if (!isImageDrag(e.dataTransfer) && getImageDragIds().length === 0) return;
                      e.preventDefault();
                      e.stopPropagation();
                      // 优先读模块级 store:startDrag(拖出)接管后
                      // dataTransfer 的私有 MIME 可能已被原生拖拽吃掉
                      const ids = getImageDragIds().length
                        ? getImageDragIds()
                        : readImageDragIds(e.dataTransfer);
                      endImageDrag();
                      clearDragOver();
                      if (ids.length) onDropImage(n.id, ids);
                    }
                  : undefined
              }
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <Row
                  label={`${hasKids ? (isOpen ? '▾ ' : '▸ ') : '  '}${n.name}`}
                  count={n.totalCount}
                  depth={depth}
                  active={activeCat === n.id}
                  // 绑定了源文件夹的分类会标出来,与"纯虚拟分组"区分
                  hint={n.relDir ? '·文件夹' : undefined}
                  title={
                    onDropImage
                      ? `${n.name}\n单击筛选 · 可以把网格里的图片拖到这一行加入分类`
                      : n.name
                  }
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
