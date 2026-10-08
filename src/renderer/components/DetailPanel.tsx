/**
 * 参数详情面板。
 *
 * 两种数据来源共用同一套渲染:
 *   1. 索引里的图(kind='indexed')—— 点开卡片,可以翻页 / 收藏 / 加分类 / 重命名;
 *   2. 拖进窗口的图(kind='dropped')—— **只解析元数据**,没有 id,
 *      所以收藏 / 分类 / 路径复制这些需要 id 的操作一律不出现。
 *
 * 字段严格对齐需求:
 *   尺寸 / 模型 / 采样器 / 调度器 / 步数 / CFG / seed / LoRA 及权重 / 正负提示词 / 角色提示词 / 生成日期
 *
 * 重要约定(实测结论,见 design/METADATA-FORMATS.md):
 *   - 采样器自 v0.7 起恢复展示(数据层一直有,此前仅按当时需求隐藏);
 *     约 39% 的图(rgthree 面板类工作流)没有采样器记录,会显示"未记录"——正常。
 *   - 调度器只有约 61% 的图有记录(如果没有记录就显示"未记录")。
 *   - 尺寸一律用 dimensions(IHDR 实测值),不要用 A1111 的 Size(那是请求尺寸)。
 *   - NovelAI v4+ 的角色提示词是独立的一块(role='character'),
 *     不能混进正向提示词里,单独成节展示。
 *
 * 颜色一律走 CSS 变量,支持暗 / 亮主题。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CategoryNode, DetailTarget, ImageDetail, LoraEntry, PromptBlock, RecipeRecord } from '@shared/types';
import { matchRecipes, STRENGTH_TOLERANCE, type RecipeLoraPair } from '@shared/recipes';
import { errMsg, fileUrl, thumbUrl } from '../api';
import { useDelayedClose } from '../useDelayedClose';
import { CategoryPicker } from './CategoryPicker';
import { RecipeCover } from './RecipeManager';

interface Props {
  target: DetailTarget;
  categories: CategoryNode[];
  /** 该图所属分类 id(仅索引图有效) */
  catIds: number[];
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  /** 翻页按钮的可用边界(基于当前已加载的视图) */
  canPrev: boolean;
  canNext: boolean;
  onToggleStar: (id: number, starred: boolean) => void;
  onReveal: (id: number) => void;
  /** 打开这个文件所在的磁盘目录(两种来源都支持,路径由父组件决定) */
  onOpenFolder: () => void;
  onCopyPath: (id: number) => void;
  /** 双击预览图:全屏查看原图(v0.8 Lightbox,仅索引图有 id 可开) */
  onOpenViewer?: (id: number) => void;
  /** LoRA 配方库(App 顶层加载;匹配是纯渲染层计算,不动索引库) */
  recipes: RecipeRecord[];
  /** 「存为配方」:把当前图的全部 LoRA 预填进新建配方表单 */
  onSaveRecipe: (loras: { file_name: string; strength: number }[]) => void;
  /** 「配方比对」:按提示词找同类图并分列(仅索引图有 id 可查) */
  onCompare?: (id: number) => void;
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

function Section({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, margin: '0 0 6px' }}>
        <h3
          style={{
            fontSize: 10,
            color: 'var(--muted)',
            textTransform: 'uppercase',
            letterSpacing: 0.6,
            margin: 0,
            fontWeight: 600,
          }}
        >
          {title}
        </h3>
        {extra}
      </div>
      {children}
    </div>
  );
}

/** 命中配方的 LoRA 收成一条配方卡:封面 + 配方名,点击展开配方内容 */
function RecipeLoraBar({
  recipe,
  pairs,
  open,
  onToggle,
}: {
  recipe: RecipeRecord;
  /** 配方每条 LoRA 与图里对应项的配对(含图里实际权重) */
  pairs: RecipeLoraPair[];
  open: boolean;
  onToggle: () => void;
}) {
  const items = pairs.length
    ? pairs
    : (Array.isArray(recipe.loras) ? recipe.loras : [])
        .filter((l) => l && l.exclude !== true)
        .map((l) => ({ recipeLora: l, imageIndex: -1, imageStrength: null, strengthDiff: null }));
  /** 图里实际权重和配方记录不一致的条数(>0 时在配方条上打个标记) */
  const driftCount = items.filter(
    (p) => p.strengthDiff !== null && p.strengthDiff > STRENGTH_TOLERANCE
  ).length;
  return (
    <div className="cam-recipe-bar">
      <button
        type="button"
        className="cam-recipe-head"
        onClick={onToggle}
        title={open ? '收起配方内容' : '展开配方内容'}
        aria-expanded={open}
      >
        <RecipeCover id={recipe.id} size={26} />
        <span className="cam-recipe-name">{recipe.title}</span>
        <span className="cam-recipe-count">{items.length} 个 LoRA</span>
        {driftCount > 0 ? (
          <span
            className="cam-recipe-drift"
            title={`有 ${driftCount} 条的权重与配方记录不同(展开可看实际权重)`}
          >
            权重≠
          </span>
        ) : null}
        <span className="cam-recipe-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div className="cam-recipe-body">
          {items.map((p, i) => (
            <div
              key={`${p.recipeLora.file_name}-${i}`}
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
              <span style={{ wordBreak: 'break-all' }}>{p.recipeLora.file_name}</span>
              <span style={{ color: 'var(--accent)', flexShrink: 0 }}>
                {p.recipeLora.strength}
                {p.strengthDiff !== null && p.strengthDiff > STRENGTH_TOLERANCE ? (
                  <span style={{ color: 'var(--warn)', marginLeft: 6 }}>
                    (实际 {p.imageStrength})
                  </span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 一块提示词。角色提示词会有自己的标题与颜色,和正负提示词区分开。
    正向提示词右上角带一个 markdown 风格的小复制按钮。 */
function PromptSection({ block, notify }: { block: PromptBlock; notify: (msg: string, bad?: boolean) => void }) {
  const isChar = block.role === 'character';
  const title = isChar ? block.label || '角色' : block.role === 'positive' ? '正向提示词' : '负向提示词';
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  const box =
    block.role === 'negative'
      ? { ...promptBox, color: 'var(--neg-fg)' }
      : isChar
        ? { ...promptBox, borderColor: 'var(--accent)', background: 'var(--accent-soft)' }
        : promptBox;

  const copy = async () => {
    try {
      await window.api.copyText(block.text);
      setCopied(true);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  return (
    <Section title={title}>
      <div style={{ position: 'relative' }}>
        <div style={box}>{block.text}</div>
        {block.role === 'positive' ? (
          <button
            type="button"
            className={`cam-copy-btn${copied ? ' ok' : ''}`}
            title={copied ? '已复制' : '复制正向提示词'}
            onClick={() => void copy()}
          >
            {copied ? '✓' : '复制'}
          </button>
        ) : null}
      </div>
    </Section>
  );
}

/** 把提示词按「基础正向 / 角色 / 负向」分组,同时兼容一个工作流里有多块正向的情况 */
function orderPrompts(prompts: PromptBlock[]): PromptBlock[] {
  const pos = prompts.filter((p) => p.role === 'positive');
  const chars = prompts.filter((p) => p.role === 'character');
  const neg = prompts.filter((p) => p.role === 'negative');
  return [...pos, ...chars, ...neg];
}

export function DetailPanel({
  target,
  categories,
  catIds,
  onClose,
  onPrev,
  onNext,
  canPrev,
  canNext,
  onToggleStar,
  onReveal,
  onOpenFolder,
  onCopyPath,
  onOpenViewer,
  recipes,
  onSaveRecipe,
  onCompare,
  onChanged,
  notify,
}: Props) {
  const indexed: ImageDetail | null = target.kind === 'indexed' ? target.detail : null;
  const dropped = target.kind === 'dropped' ? target.info : null;

  // 「分类…」弹层:勾选只是暂存,点「确定」才落库(见 CategoryPicker);关闭先播退场再卸载
  const { value: catModalOpen, closing: catModalClosing, open: openCatModal, close: closeCatModal } = useDelayedClose<true>();

  // 预览图原图加载失败时退回缩略图(换图时重置)
  const [previewFallback, setPreviewFallback] = useState(false);

  // LoRA 配方分组(纯渲染层计算,不改 db、不触发重扫)。
  // hook 必须在下面的 early return 之前;匹配输入与配方库任一变化都重算。
  const metaForLoras = indexed ? indexed.meta : dropped ? dropped.meta : null;
  const imageLoras = metaForLoras?.loras ?? [];
  const recipeMatch = useMemo(
    () => matchRecipes(imageLoras.map((l) => ({ name: l.name, strength: l.strengthModel })), recipes),
    [imageLoras, recipes]
  );
  /** 展开态按配方 id 记,跨翻页保留 */
  const [expandedRecipes, setExpandedRecipes] = useState<ReadonlySet<string>>(new Set());
  const toggleRecipeExpanded = (id: string) =>
    setExpandedRecipes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 换图 / 关闭后收起弹层,免得残留上一张的勾选状态
  useEffect(() => {
    closeCatModal();
  }, [target.kind === 'indexed' ? target.detail?.id : target.info.path, closeCatModal]);

  // 换图后重置预览回退状态(新图先尝试原图)
  useEffect(() => {
    setPreviewFallback(false);
  }, [target.kind === 'indexed' ? target.detail?.id : target.info.path]);

  if (!indexed && !dropped) return null;

  const m = indexed ? indexed.meta : dropped ? dropped.meta : null;
  const s = m?.sampler ?? null;
  const allPrompts = orderPrompts(m?.prompts ?? []);
  const names = catNameMap(categories);
  const loras = m?.loras ?? [];

  const fileName = indexed ? indexed.fileName : dropped ? dropped.fileName : '';
  const fileSize = indexed ? indexed.fileSize : dropped ? dropped.fileSize : 0;
  const fileMtime = indexed ? indexed.fileMtime : dropped ? dropped.fileMtime : 0;
  const dimensions = indexed ? indexed.dimensions : dropped ? dropped.dimensions : null;
  const folderLabel = indexed
    ? indexed.relDir || '(根目录)'
    : dropped
      ? dropped.path.replace(/[\\/][^\\/]+$/, '')
      : '';
  // 预览用原图(cam-file):缩略图只有几百像素,在 520px 面板上是糊的。
  // 加载失败(文件被搬走等)再退回缩略图兜底。
  const previewSrc = indexed
    ? previewFallback
      ? thumbUrl(indexed.id)
      : fileUrl(indexed.id)
    : dropped && dropped.previewDataUrl
      ? dropped.previewDataUrl
      : '';

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
      {/* sticky 顶栏:磨砂材质在 .cam-detail-head(main.tsx),与 cam-header 同族 */}
      <div className="cam-detail-head">
        <span
          title={fileName}
          className="cam-detail-title"
          style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {dropped ? <span style={{ color: 'var(--accent)' }}>拖入 · </span> : null}
          {fileName}
        </span>
        <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {indexed ? (
            <>
              <button type="button" style={btn} onClick={onPrev} disabled={!canPrev}>
                ←
              </button>
              <span style={{ color: 'var(--muted)', fontSize: 11, alignSelf: 'center' }}>
                {indexed.position > 0 ? `${indexed.position}/${indexed.total}` : `${indexed.total}`}
              </span>
              <button type="button" style={btn} onClick={onNext} disabled={!canNext}>
                →
              </button>
              <button
                type="button"
                style={btn}
                onClick={() => onToggleStar(indexed.id, !indexed.starred)}
              >
                {indexed.starred ? '★ 已收藏' : '☆ 收藏'}
              </button>
            </>
          ) : null}
          <button type="button" style={btn} onClick={onClose}>
            关闭
          </button>
        </span>
      </div>

      <div style={{ padding: '12px 13px' }}>
        {dropped ? (
          <div
            style={{
              background: 'var(--accent-soft)',
              border: '1px solid var(--accent)',
              borderRadius: 6,
              padding: '7px 10px',
              fontSize: 11.5,
              color: 'var(--accent)',
              marginBottom: 12,
              lineHeight: 1.5,
            }}
          >
            这是拖进来的图片,**只解析参数** —— 没有入库,原图一个字节都没动。
            <br />
            想长期管理它,把它复制到图库文件夹里,索引会自动把它收进来。
          </div>
        ) : null}

        {previewSrc ? (
          // 按原始比例完整放进面板:宽铺满、高自适应,不再两侧留白/上下裁切
          <div className="cam-preview" style={{ position: 'relative', marginBottom: 12 }}>
            <img
              src={previewSrc}
              alt={fileName}
              // 预览图**不能可拖拽**:原生图片拖拽会发 DragEvent,被外层当成
              // "从资源管理器拖文件进来",于是弹出一层解析元数据的提示(v0.6 修复)
              draggable={false}
              onError={() => setPreviewFallback(true)}
              // 双击 = 全屏查看原图(v0.8);拖入的临时图没有 id,开不了
              title={indexed ? '双击查看原图' : undefined}
              onDoubleClick={
                indexed && onOpenViewer
                  ? (e) => {
                      e.stopPropagation();
                      onOpenViewer(indexed.id);
                    }
                  : undefined
              }
              style={{
                width: '100%',
                height: 'auto',
                display: 'block',
                borderRadius: 6,
                background: 'var(--inset)',
                cursor: indexed && onOpenViewer ? 'zoom-in' : undefined,
              }}
            />
            {indexed ? (
              <button
                type="button"
                className={`cam-star cam-preview-star${indexed.starred ? ' on' : ''}`}
                title={indexed.starred ? '取消收藏' : '收藏'}
                onClick={() => onToggleStar(indexed.id, !indexed.starred)}
              >
                {indexed.starred ? '★' : '☆'}
              </button>
            ) : null}
          </div>
        ) : (
          <div
            style={{
              marginBottom: 12,
              padding: 24,
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: 12,
              background: 'var(--inset)',
              borderRadius: 6,
            }}
          >
            这个格式没法在界面里预览,参数照常解析。
          </div>
        )}

        {indexed ? (
          <Section title="分类">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" style={primaryBtn} onClick={() => openCatModal(true)}>
                分类…
              </button>
              {catIds.length === 0 ? (
                <span style={{ color: 'var(--muted)', fontSize: 11 }}>不属于任何分类</span>
              ) : (
                // 每个分类一个小胶囊,✕ 即点即移出(不开弹层)
                catIds.map((id) => (
                  <span key={id} className="cam-chip">
                    {names.get(id) ?? `#${id}`}
                    <button
                      type="button"
                      className="cam-chip-x"
                      title={`从「${names.get(id) ?? `#${id}`}」移出`}
                      onClick={() => {
                        void window.api
                          .setCategoryMembers(id, [indexed.id], false)
                          .then(() => {
                            notify(`已移出「${names.get(id) ?? `#${id}`}」`);
                            onChanged();
                          })
                          .catch((e) => notify(errMsg(e), true));
                      }}
                    >
                      ✕
                    </button>
                  </span>
                ))
              )}
            </div>
          </Section>
        ) : null}

        <Section title="采样参数">
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <tbody>
              <KV
                k="像素尺寸"
                v={dimensions ? `${dimensions.width} × ${dimensions.height}` : null}
              />
              <KV k="模型" v={m?.modelName ?? null} />
              <KV k="采样器" v={s?.samplerName ?? null} />
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

        <Section
          title={`LoRA (${loras.length})`}
          extra={
            loras.length > 0 || (indexed && onCompare) ? (
              <>
                {loras.length > 0 ? (
                  <button
                    type="button"
                    style={miniBtn}
                    title="把这张图的全部 LoRA 存成一个配方(权重与图一致)"
                    onClick={() =>
                      onSaveRecipe(loras.map((l) => ({ file_name: l.name, strength: l.strengthModel ?? 1 })))
                    }
                  >
                    存为配方
                  </button>
                ) : null}
                {indexed && onCompare ? (
                  <button
                    type="button"
                    style={miniBtn}
                    title="按提示词找同一 / 相似提示词的其它图,并按命中的配方分列比对"
                    onClick={() => onCompare(indexed.id)}
                  >
                    配方比对
                  </button>
                ) : null}
              </>
            ) : null
          }
        >
          {loras.length === 0 ? (
            <div style={{ color: 'var(--warn)', fontSize: 12 }}>没有使用 LoRA</div>
          ) : (
            <>
              {/* 命中配方的 LoRA 收成配方卡(可展开);没被任何配方吸收的照常逐个列出 */}
              {recipeMatch.matches.map(({ recipe, pairs }) => (
                <RecipeLoraBar
                  key={recipe.id}
                  recipe={recipe}
                  pairs={pairs}
                  open={expandedRecipes.has(recipe.id)}
                  onToggle={() => toggleRecipeExpanded(recipe.id)}
                />
              ))}
              {recipeMatch.unmatched.map((i) => renderLoraRow(loras[i]))}
            </>
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
              <KV k="文件名" v={fileName} mono={false} />
              {indexed ? (
                <KV k="文件夹" v={indexed.relDir || '(根目录)'} mono={false} />
              ) : null}
              {dropped ? (
                <KV k="所在目录" v={folderLabel} mono={false} />
              ) : null}
              <KV k="大小" v={fmtBytes(fileSize)} />
              <KV k="生成日期" v={fmtDate(fileMtime)} />
              {indexed ? <KV k="格式" v={indexed.source} /> : null}
              {indexed && m?.nodeCount ? <KV k="工作流节点" v={`${m.nodeCount} 个`} /> : null}
              {indexed ? (
                <KV
                  k="所属分类"
                  v={catIds.length ? catIds.map((id) => names.get(id) ?? `#${id}`).join('、') : null}
                  mono={false}
                />
              ) : null}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              style={btn}
              onClick={onOpenFolder}
            >
              打开所在位置
            </button>
            {indexed ? (
              <>
                <button type="button" style={btn} onClick={() => onReveal(indexed.id)}>
                  在资源管理器中定位
                </button>
                <button type="button" style={btn} onClick={() => onCopyPath(indexed.id)}>
                  复制路径
                </button>
              </>
            ) : null}
          </div>
        </Section>

        {allPrompts.length === 0 ? (
          <Section title="提示词">
            <div style={{ color: 'var(--warn)', fontSize: 12 }}>
              没有解析到提示词(图里没有文本块,或上游工具把元数据剥掉了)
            </div>
          </Section>
        ) : (
          allPrompts.map((p, i) => <PromptSection key={`${p.role}-${i}`} block={p} notify={notify} />)
        )}

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

      {catModalOpen && indexed ? (
        <CategoryPicker
          categories={categories}
          imageIds={[indexed.id]}
          initialChecked={catIds}
          closing={catModalClosing}
          onClose={() => closeCatModal()}
          onApplied={onChanged}
          notify={notify}
        />
      ) : null}
    </div>
  );
}

/** 未命中任何配方的 LoRA:保持原来的逐行渲染 */
function renderLoraRow(l: LoraEntry) {
  return (
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

/** 小节标题右侧的小按钮(如 LoRA 区的「存为配方」) */
const miniBtn: React.CSSProperties = {
  ...btn,
  padding: '1px 8px',
  fontSize: 10.5,
  color: 'var(--accent)',
  borderColor: 'var(--accent)',
  background: 'var(--accent-soft)',
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
