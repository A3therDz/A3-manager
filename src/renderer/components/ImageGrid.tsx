/**
 * 缩略图网格。
 *
 * 关键设计:
 *  - 只渲染已加载的行;滚动到底部由父组件触发 loadMore(不引虚拟滚动库)。
 *  - 图片用 cam-thumb:// 协议(桌面版)/ file:// (浏览器调试),加载失败显示占位而不是破图。
 *  - 卡片上显示分类标记,让"集合归属"一眼可见(与静态图库对齐)。
 */

import type { CategoryNode, ImageRecord } from '@shared/types';
import { thumbUrl } from '../api';

interface Props {
  rows: ImageRecord[];
  categories: CategoryNode[];
  /** 已加载的图片所属分类:与 rows 同序 */
  catsOf: number[][];
  selectedId: number | null;
  onOpen: (id: number) => void;
  /** 卡片右上角 ☆/★ 切换收藏 */
  onToggleStar: (id: number, starred: boolean) => void;
  /** 卡片右键菜单 */
  onContextMenu: (id: number, x: number, y: number) => void;
  /** 多选:已选中的图片 id 集合 */
  selectedIds: Set<number>;
  /** 多选:toggle = 点左上角勾选框 / Ctrl+点击;range = Shift+点击(选一段) */
  onSelect: (id: number, mode: 'toggle' | 'range') => void;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/** 平铺分类 id -> 名称,供卡片标记用 */
export function flattenCategories(list: CategoryNode[]): Map<number, string> {
  const m = new Map<number, string>();
  const walk = (ns: CategoryNode[]) => {
    for (const n of ns) {
      m.set(n.id, n.name);
      walk(n.children || []);
    }
  };
  walk(list);
  return m;
}

export function ImageGrid({
  rows,
  categories,
  catsOf,
  selectedId,
  onOpen,
  onToggleStar,
  onContextMenu,
  selectedIds,
  onSelect,
}: Props) {
  // 分类 id -> 名称。卡片上显示名称而不是 id(早期版本误显示成 ★ 3 这种)
  const catNames = flattenCategories(categories);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(158px, 1fr))',
        gap: 10,
        padding: 12,
      }}
    >
      {rows.map((r, i) => {
        const dims = r.dimensions;
        const mine = catsOf[i] || [];
        const selected = selectedId === r.id;
        const picked = selectedIds.has(r.id);
        const loCount = r.meta?.loras.length ?? 0;
        return (
          <div
            key={r.id}
            className={`cam-card${picked ? ' picked' : ''}`}
            data-id={r.id}
            onClick={(e) => {
              if (e.ctrlKey || e.metaKey) onSelect(r.id, 'toggle');
              else if (e.shiftKey) onSelect(r.id, 'range');
              else onOpen(r.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu(r.id, e.clientX, e.clientY);
            }}
            title={r.fileName}
            style={{
              ['--i' as string]: String(i % 12),
              position: 'relative',
              background: 'var(--panel)',
              border: `1px solid ${picked || selected ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 8,
              overflow: 'hidden',
              cursor: 'pointer',
              boxShadow: picked ? 'inset 0 0 0 2px var(--accent-soft)' : undefined,
            }}
          >
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
            <img
              src={thumbUrl(r.id)}
              alt={r.fileName}
              loading="lazy"
              style={{ width: '100%', height: 176, objectFit: 'cover', display: 'block', background: 'var(--inset)' }}
              onError={(e) => {
                // 缩略图缺失时不要把浏览器默认破图图标留给用户
                const el = e.currentTarget;
                el.style.opacity = '0.25';
                el.title = '缩略图尚未生成(可运行 thumb-sync 补齐)';
              }}
            />
            <div style={{ padding: '6px 8px' }}>
              <div style={ellipsis('var(--muted)', 11)}>{r.fileName}</div>
              <div style={ellipsis(r.meta?.modelName ? 'var(--muted2)' : 'var(--warn)', 11)}>
                {r.meta?.modelName ?? '无模型记录'}
              </div>
              <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                {dims ? <Badge fg="var(--ok-fg)" bg="var(--ok-bg)">{dims.width}×{dims.height}</Badge> : null}
                {loCount > 0 ? <Badge fg="var(--accent-fg)" bg="var(--accent-bg)">{loCount} LoRA</Badge> : null}
                {mine.slice(0, 2).map((cid) => (
                  <Badge key={cid} fg="var(--cat-fg)" bg="var(--cat-bg)">
                    {catNames.get(cid) ?? `#${cid}`}
                  </Badge>
                ))}
                {mine.length > 2 ? <Badge fg="var(--cat-fg)" bg="var(--cat-bg)">+{mine.length - 2}</Badge> : null}
                {r.starred ? <Badge fg="var(--warn)" bg="var(--warn-bg)">已收藏</Badge> : null}
              </div>
              <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 10 }}>{fmtBytes(r.fileSize)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Badge({ fg, bg, children }: { fg: string; bg: string; children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 10,
        padding: '1px 5px',
        borderRadius: 3,
        background: bg,
        color: fg,
      }}
    >
      {children}
    </span>
  );
}

function ellipsis(color: string, size: number): React.CSSProperties {
  return {
    color,
    fontSize: size,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
}
