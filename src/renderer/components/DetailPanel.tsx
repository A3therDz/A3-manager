/**
 * 参数详情面板。
 *
 * 这是用户最关心的部分(点开看图之后要看的参数),字段严格对齐需求:
 *   尺寸 / 模型 / 调度器 / 步数 / CFG / seed / LoRA 及权重 / 正负提示词 / 生成日期
 * 外加:所属分类(含「+ 加入分类」弹层)、文件名与路径、体积、来源格式、工作流节点数。
 *
 * 重要约定(实测结论,见 design/METADATA-FORMATS.md):
 *   - 采样器字段按用户要求不展示。
 *   - 调度器只有约 61% 的图有记录(rgthree 面板不写值),必须显示"未记录"而不是空白。
 *   - 尺寸一律用 dimensions(IHDR 实测值),不要用 A1111 的 Size(那是请求尺寸)。
 *
 * 颜色一律走 CSS 变量,支持暗 / 亮主题。
 */

import { useEffect, useState } from 'react';
import type { CategoryNode, ImageDetail } from '@shared/types';
import { errMsg, thumbUrl } from '../api';

interface Props {
  detail: ImageDetail | null;
  categories: CategoryNode[];
  /** 该图所属分类 id */
  catIds: number[];
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  /** 翻页按钮的可用边界(基于当前已加载的视图) */
  canPrev: boolean;
  canNext: boolean;
  onToggleStar: (id: number, starred: boolean) => void;
  onReveal: (id: number) => void;
  onCopyPath: (id: number) => void;
  /** 分类归属变化后回调,父组件负责刷新分类树与网格标记 */
  onChanged: () => void;
  /** 轻提示 */
  notify: (msg: string, bad?: boolean) => void;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(2)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function catNameMap(list: CategoryNode[]): Map<number, string> {
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

/** 一行键值。value 为空时按"未记录"呈现,这是有意的——数据缺失是常态 */
function KV({ k, v, mono = true }: { k: string; v: string | number | null | undefined; mono?: boolean }) {
  const missing = v === null || v === undefined || v === '';
  return (
    <tr>
      <td style={{ color: 'var(--muted)', width: 84, whiteSpace: 'nowrap', padding: '3px 0', verticalAlign: 'top' }}>
        {k}
      </td>
      <td
        style={{
          padding: '3px 0',
          fontFamily: mono ? 'ui-monospace, Consolas, monospace' : 'inherit',
          wordBreak: 'break-all',
          color: missing ? 'var(--warn)' : undefined,
        }}
      >
        {missing ? '未记录' : v}
      </td>
    </tr>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <h3
        style={{
          fontSize: 10,
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          margin: '0 0 6px',
          fontWeight: 600,
        }}
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

export function DetailPanel({
  detail,
  categories,
  catIds,
  onClose,
  onPrev,
  onNext,
  canPrev,
  canNext,
  onToggleStar,
  onReveal,
  onCopyPath,
  onChanged,
  notify,
}: Props) {
  // 「加入分类」弹层。打开时把当前归属拷贝成一份本地集合,勾选即时生效
  const [catModalOpen, setCatModalOpen] = useState(false);
  const [myCats, setMyCats] = useState<Set<number>>(new Set());
  const [newCatName, setNewCatName] = useState('');

  // 弹层打开期间:Esc 关弹层而不是关详情;← → 不翻页(capture 阶段拦截)
  useEffect(() => {
    if (!catModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.stopPropagation();
        if (e.key === 'Escape') setCatModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [catModalOpen]);

  if (!detail) return null;

  const m = detail.meta;
  const s = m?.sampler ?? null;
  const pos = m?.prompts.find((p) => p.role === 'positive') ?? null;
  const neg = m?.prompts.find((p) => p.role === 'negative') ?? null;
  const names = catNameMap(categories);
  const loras = m?.loras ?? [];
  const currentCats = catModalOpen ? myCats : new Set(catIds);

  const openCatModal = () => {
    setMyCats(new Set(catIds));
    setNewCatName('');
    setCatModalOpen(true);
  };

  const toggleMember = async (n: CategoryNode, member: boolean) => {
    const prevSet = new Set(myCats);
    setMyCats((cur) => {
      const next = new Set(cur);
      if (member) next.add(n.id);
      else next.delete(n.id);
      return next;
    });
    try {
      await window.api.setCategoryMembers(n.id, [detail.id], member);
      notify(member ? `已加入「${n.name}」` : `已移出「${n.name}」`);
      onChanged();
    } catch (e) {
      setMyCats(prevSet);
      notify(errMsg(e), true);
    }
  };

  const createAndJoin = async () => {
    const name = newCatName.trim();
    if (!name) {
      notify('请输入分类名', true);
      return;
    }
    try {
      const c = await window.api.createCategory({ name });
      await window.api.setCategoryMembers(c.id, [detail.id], true);
      setMyCats((cur) => new Set(cur).add(c.id));
      setNewCatName('');
      notify(`已新建并加入「${c.name}」`);
      onChanged();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  // 弹层列表:分类树拍平成带缩进的列表
  const flatCats: Array<{ n: CategoryNode; depth: number }> = [];
  const flatten = (ns: CategoryNode[], depth: number) => {
    for (const n of ns) {
      flatCats.push({ n, depth });
      flatten(n.children || [], depth + 1);
    }
  };
  if (catModalOpen) flatten(categories, 0);

  return (
    <div
      className="cam-detail"
      style={{
        width: 520,
        flexShrink: 0,
        borderLeft: '1px solid var(--border)',
        overflowY: 'auto',
        height: '100%',
      }}
    >
      <div
        style={{
          position: 'sticky',
          top: 0,
          background: 'var(--panel)',
          borderBottom: '1px solid var(--border)',
          padding: '9px 13px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          zIndex: 2,
        }}
      >
        <span
          title={detail.fileName}
          style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {detail.fileName}
        </span>
        <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button type="button" style={btn} onClick={onPrev} disabled={!canPrev}>
            ←
          </button>
          <span style={{ color: 'var(--muted)', fontSize: 11, alignSelf: 'center' }}>
            {detail.position > 0 ? `${detail.position}/${detail.total}` : `${detail.total}`}
          </span>
          <button type="button" style={btn} onClick={onNext} disabled={!canNext}>
            →
          </button>
          <button
            type="button"
            style={btn}
            onClick={() => onToggleStar(detail.id, !detail.starred)}
          >
            {detail.starred ? '★ 已收藏' : '☆ 收藏'}
          </button>
          <button type="button" style={btn} onClick={onClose}>
            关闭
          </button>
        </span>
      </div>

      <div style={{ padding: '12px 13px' }}>
        <img
          src={thumbUrl(detail.id)}
          alt={detail.fileName}
          style={{ width: '100%', borderRadius: 6, background: 'var(--inset)', marginBottom: 12 }}
        />

        <Section title="分类">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" style={primaryBtn} onClick={openCatModal}>
              + 加入分类
            </button>
            <span style={{ color: 'var(--muted)', fontSize: 11 }}>
              {catIds.length
                ? catIds.map((id) => names.get(id) ?? `#${id}`).join('、')
                : '不属于任何分类'}
            </span>
          </div>
        </Section>

        <Section title="采样参数">
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <tbody>
              <KV
                k="像素尺寸"
                v={detail.dimensions ? `${detail.dimensions.width} × ${detail.dimensions.height}` : null}
              />
              <KV k="模型" v={m?.modelName ?? null} />
              <KV k="调度器" v={s?.scheduler ?? null} />
              <KV k="步数" v={s?.steps ?? null} />
              <KV k="CFG" v={s?.cfg ?? null} />
              <KV k="seed" v={s?.seed ?? null} />
              {s?.denoise !== null && s?.denoise !== undefined && s.denoise !== 1 ? (
                <KV k="denoise" v={s.denoise} />
              ) : null}
            </tbody>
          </table>
        </Section>

        <Section title={`LoRA (${loras.length})`}>
          {loras.length === 0 ? (
            <div style={{ color: 'var(--warn)', fontSize: 12 }}>没有使用 LoRA</div>
          ) : (
            loras.map((l) => (
              <div
                key={`${l.name}-${l.nodeId}`}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                  fontFamily: 'ui-monospace, Consolas, monospace',
                  fontSize: 11,
                  padding: '2px 0',
                  borderBottom: '1px solid var(--panel2)',
                }}
              >
                <span style={{ wordBreak: 'break-all' }}>{l.name}</span>
                <span style={{ color: 'var(--accent)', flexShrink: 0 }}>
                  {l.strengthModel === null ? '?' : l.strengthModel}
                  {l.strengthClip !== null && l.strengthClip !== l.strengthModel
                    ? ` / clip ${l.strengthClip}`
                    : ''}
                </span>
              </div>
            ))
          )}
        </Section>

        {(m?.controlNets?.length ?? 0) > 0 ? (
          <Section title={`ControlNet (${m?.controlNets.length})`}>
            {m?.controlNets.map((c) => (
              <div
                key={c.name}
                style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '2px 0' }}
              >
                <span style={{ wordBreak: 'break-all' }}>{c.name}</span>
                <span style={{ color: 'var(--accent)' }}>{c.strength ?? '?'}</span>
              </div>
            ))}
          </Section>
        ) : null}

        <Section title="文件信息">
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <tbody>
              <KV k="文件名" v={detail.fileName} mono={false} />
              <KV k="文件夹" v={detail.relDir || '(根目录)'} mono={false} />
              <KV k="大小" v={fmtBytes(detail.fileSize)} />
              <KV k="生成日期" v={fmtDate(detail.fileMtime)} />
              <KV k="格式" v={detail.source} />
              {m?.nodeCount ? <KV k="工作流节点" v={`${m.nodeCount} 个`} /> : null}
              <KV
                k="所属分类"
                v={catIds.length ? catIds.map((id) => names.get(id) ?? `#${id}`).join('、') : null}
                mono={false}
              />
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button type="button" style={btn} onClick={() => onReveal(detail.id)}>
              在资源管理器中定位
            </button>
            <button type="button" style={btn} onClick={() => onCopyPath(detail.id)}>
              复制路径
            </button>
          </div>
        </Section>

        <Section title="正向提示词">
          <div style={promptBox}>{pos ? pos.text : <span style={{ color: 'var(--warn)' }}>未记录</span>}</div>
        </Section>

        <Section title="负向提示词">
          <div style={{ ...promptBox, color: 'var(--neg-fg)' }}>
            {neg ? neg.text : <span style={{ color: 'var(--warn)' }}>未记录</span>}
          </div>
        </Section>

        {(m?.customNodeHints?.length ?? 0) > 0 ? (
          <Section title="提示">
            {m?.customNodeHints.map((h) => (
              <div key={h} style={{ color: 'var(--warn)', fontSize: 11, padding: '2px 0' }}>
                · {h}
              </div>
            ))}
          </Section>
        ) : null}
      </div>

      {catModalOpen ? (
        <div
          className="cam-modal"
          onClick={(e) => {
            if (e.target === e.currentTarget) setCatModalOpen(false);
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
              加入分类
            </h2>
            <div style={{ overflowY: 'auto', padding: '6px 0' }}>
              {flatCats.length === 0 ? (
                <div style={{ color: 'var(--muted)', fontSize: 11, padding: '10px 14px' }}>
                  还没有分类,在下面输入名字新建一个。
                </div>
              ) : (
                flatCats.map(({ n, depth }) => (
                  <label
                    key={n.id}
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
                      checked={currentCats.has(n.id)}
                      onChange={(e) => void toggleMember(n, e.target.checked)}
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
                    {n.relDir ? <span style={{ color: 'var(--muted)', fontSize: 10 }}>·文件夹</span> : null}
                  </label>
                ))
              )}
            </div>
            <div
              style={{
                padding: '10px 14px',
                borderTop: '1px solid var(--border)',
                display: 'flex',
                gap: 8,
              }}
            >
              <input
                type="text"
                placeholder="新建分类名…"
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createAndJoin();
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
              <button type="button" style={btn} onClick={() => void createAndJoin()}>
                新建并加入
              </button>
              <button type="button" style={{ ...btn, marginLeft: 'auto' }} onClick={() => setCatModalOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const btn: React.CSSProperties = {
  background: 'var(--panel2)',
  border: '1px solid var(--border)',
  color: 'var(--fg)',
  borderRadius: 5,
  padding: '3px 9px',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 12,
};

const primaryBtn: React.CSSProperties = {
  ...btn,
  background: 'var(--accent-soft)',
  borderColor: 'var(--accent)',
  color: 'var(--accent)',
};

const promptBox: React.CSSProperties = {
  background: 'var(--inset)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: 8,
  fontFamily: 'ui-monospace, Consolas, monospace',
  fontSize: 11,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 230,
  overflowY: 'auto',
};
