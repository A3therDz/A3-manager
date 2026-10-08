/**
 * 配方比对面板(v0.8,全屏模态)。
 *
 * 场景:同一个(或相似的)提示词、换不同的 LoRA 配方出图,想看"配方 A vs 配方 B …"
 * 在同一提示词下分别长什么样,以及各配方之间 LoRA 集合差在哪。
 *
 * 布局:横向分列,一列 = 一个配方组(组头是配方封面 + 名字 + 张数 + 与第一组的 LoRA 差异);
 * 列内每张是缩略图 + 尺寸 + seed(相似模式另加相似度)。点图 → 全屏查看器(在该列内翻页);
 * 勾选 2–4 张 → 底部「并排比对」开 CompareStage(层级高于本面板)。
 *
 * 性能约束:压在整屏滚动网格上,整面板用 97% 不透明底色(var(--modal-bg)),
 * 不开 backdrop-filter;进出场复用现有 cam-fade / cam-fade-out,不新增 keyframes。
 */

import { useEffect, useMemo, useState } from 'react';
import type { CompareRow } from '@shared/types';
import type { RecipeRecord } from '@shared/recipes';
import { groupCompareRows, UNMATCHED_TITLE, type CompareGroup } from '@shared/compare';
import { thumbUrl } from '../api';
import { RecipeCover } from './RecipeManager';

/** 并排比对最多选几张(一屏 4 张已经是最密的了) */
export const MAX_STAGE_PICK = 4;

interface Props {
  /** 基准图 id(结果里它 similarity = 1) */
  baseId: number;
  baseName: string;
  /** 基准图的原始正向提示词;空 = 这张图没记录提示词 */
  basePrompt: string;
  rows: CompareRow[];
  loading: boolean;
  error: string | null;
  /** 非 null 时显示「同提示词 / 相似」切换(只有从详情进入才有) */
  mode: 'exact' | 'similar' | null;
  onModeChange: (m: 'exact' | 'similar') => void;
  /** 批量条进入时勾选的张数(用于标题区提示;详情进入传 0) */
  selectedCount: number;
  /** 配方库:只为取组头的封面(CompareRow 里只有标题,没有 id) */
  recipes: RecipeRecord[];
  closing: boolean;
  onClose: () => void;
  /** 打开查看器(rows = 该列的全部行,可在列内翻页) */
  onOpenViewer: (columnIds: number[], id: number) => void;
  /** 底部「并排比对 (n)」 */
  onComparePicked: (rows: CompareRow[]) => void;
}

export function ComparePanel({
  baseId,
  baseName,
  basePrompt,
  rows,
  loading,
  error,
  mode,
  onModeChange,
  selectedCount,
  recipes,
  closing,
  onClose,
  onOpenViewer,
  onComparePicked,
}: Props) {
  const groups = useMemo(() => groupCompareRows(rows), [rows]);
  /** 勾选的图(按勾选顺序,最多 4) */
  const [picked, setPicked] = useState<number[]>([]);
  const [promptOpen, setPromptOpen] = useState(false);

  // 换基准图 / 换模式 → 勾选清空(保留上一批会把不相干的图带进并排层)
  useEffect(() => {
    setPicked([]);
  }, [baseId, mode, rows]);

  /** 标题 → 配方(只为封面;同标题取第一个) */
  const recipeByTitle = useMemo(() => {
    const m = new Map<string, RecipeRecord>();
    for (const r of recipes) if (!m.has(r.title)) m.set(r.title, r);
    return m;
  }, [recipes]);

  const togglePick = (id: number) => {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_STAGE_PICK) return prev;
      return [...prev, id];
    });
  };

  const pickedRows = picked
    .map((id) => rows.find((r) => r.id === id))
    .filter((r): r is CompareRow => !!r);

  const hasPrompt = basePrompt.trim() !== '';
  const total = rows.length;

  const renderGroup = (g: CompareGroup) => {
    const recipe = g.key === '' ? undefined : recipeByTitle.get(g.key);
    return (
      <div className="cam-cmp-col" key={g.key || '__unmatched__'}>
        <div className="cam-cmp-colhead">
          {recipe ? (
            <RecipeCover id={recipe.id} size={34} />
          ) : (
            <span className="cam-recipe-cover" style={{ width: 34, height: 34 }} aria-hidden="true">
              —
            </span>
          )}
          <div className="cam-cmp-coltitle">
            <div className="cam-cmp-colname" title={g.title === UNMATCHED_TITLE ? '没有命中任何配方' : g.title}>
              {g.title}
            </div>
            <div className="cam-cmp-colsub">{g.rows.length} 张</div>
          </div>
        </div>
        <div className="cam-cmp-diff">
          {g.diff.added.length === 0 && g.diff.removed.length === 0 ? (
            <span className="cam-cmp-diff-same">与第一组一致</span>
          ) : (
            <>
              {g.diff.added.length > 0 ? (
                <div className="cam-cmp-diff-add" title={g.diff.added.join('\n')}>
                  + {g.diff.added.join('、')}
                </div>
              ) : null}
              {g.diff.removed.length > 0 ? (
                <div className="cam-cmp-diff-del" title={g.diff.removed.join('\n')}>
                  − {g.diff.removed.join('、')}
                </div>
              ) : null}
            </>
          )}
        </div>
        <div className="cam-cmp-colbody">
          {g.rows.map((r) => {
            const on = picked.includes(r.id);
            const full = !on && picked.length >= MAX_STAGE_PICK;
            return (
              <div
                key={r.id}
                className={`cam-cmp-card${on ? ' on' : ''}${r.id === baseId ? ' base' : ''}`}
                title={`${r.fileName}\n${r.relDir || '[图库根]'}`}
              >
                <button
                  type="button"
                  className="cam-cmp-thumb"
                  onClick={() => onOpenViewer(g.rows.map((x) => x.id), r.id)}
                  title="点击看原图(可在这列里翻页)"
                >
                  {/* 缩略图一律走 cam-thumb 协议:原图在比对面板里几十张一起加载会卡 */}
                  <img src={thumbUrl(r.id)} alt={r.fileName} draggable={false} loading="lazy" />
                </button>
                <label className={`cam-cmp-pick${full ? ' full' : ''}`} title={full ? `最多勾选 ${MAX_STAGE_PICK} 张` : '勾选后可并排比对'}>
                  <input type="checkbox" checked={on} disabled={full} onChange={() => togglePick(r.id)} />
                </label>
                <div className="cam-cmp-meta">
                  {r.width && r.height ? `${r.width}×${r.height}` : '尺寸未知'}
                  <span className="cam-cmp-seed">seed {r.seed ?? '—'}</span>
                </div>
                <div className="cam-cmp-name" title={r.fileName}>
                  {r.fileName}
                </div>
                {mode === 'similar' ? (
                  <div className="cam-cmp-sim">相似 {Math.round(r.similarity * 100)}%</div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className={`cam-cmp${closing ? ' closing' : ''}`} role="dialog" aria-label="配方比对">
      <div className="cam-cmp-top">
        <span className="cam-cmp-title">配方比对</span>
        <span className="cam-cmp-base" title={baseName}>
          基准:{baseName || `#${baseId}`}
        </span>
        {mode !== null ? (
          <span className="cam-cmp-modes">
            <button
              type="button"
              className={`cam-lb-btn${mode === 'exact' ? ' on' : ''}`}
              onClick={() => onModeChange('exact')}
              title="只找提示词完全相同的图(小写 + 收空白后全等)"
            >
              同提示词
            </button>
            <button
              type="button"
              className={`cam-lb-btn${mode === 'similar' ? ' on' : ''}`}
              onClick={() => onModeChange('similar')}
              title="提示词相似度 ≥ 85% 的图,按相似度降序"
            >
              相似 ≥85%
            </button>
          </span>
        ) : (
          <span className="cam-cmp-modes cam-cmp-hint">
            {selectedCount > 0 ? `已选 ${selectedCount} 张` : '多选比对'}
          </span>
        )}
        <span className="cam-cmp-count">
          {loading ? '查找中…' : `${total} 张 / ${groups.length} 列`}
        </span>
        <button type="button" className="cam-lb-btn" title="关闭 (Esc)" onClick={onClose}>
          ×
        </button>
      </div>

      {hasPrompt ? (
        <div className="cam-cmp-promptwrap">
          <button type="button" className="cam-cmp-promptbtn" onClick={() => setPromptOpen((v) => !v)}>
            {promptOpen ? '▾' : '▸'} 提示词
          </button>
          {promptOpen ? <pre className="cam-cmp-prompt">{basePrompt}</pre> : null}
        </div>
      ) : null}

      <div className="cam-cmp-body">
        {error ? (
          <div className="cam-cmp-empty">读取失败:{error}</div>
        ) : loading ? (
          <div className="cam-cmp-empty">正在按提示词查找同类图…</div>
        ) : !hasPrompt && mode !== null ? (
          <div className="cam-cmp-empty">
            这张图没有记录提示词,无法按提示词找同类;可以多选几张后从底部批量条进入比对。
          </div>
        ) : rows.length === 0 ? (
          <div className="cam-cmp-empty">没有找到可比的图(同一提示词下暂时只有这一张)。</div>
        ) : (
          <div className="cam-cmp-cols">{groups.map(renderGroup)}</div>
        )}
      </div>

      <div className="cam-cmp-bar">
        <span className="cam-cmp-hint">
          勾选 2–{MAX_STAGE_PICK} 张并排比对(共用同一缩放与平移)
        </span>
        <button
          type="button"
          className="cam-sb-btn"
          disabled={pickedRows.length < 2}
          title={pickedRows.length < 2 ? '至少勾选 2 张' : '并排显示,共用缩放与平移'}
          onClick={() => onComparePicked(pickedRows)}
        >
          并排比对 ({pickedRows.length})
        </button>
      </div>
    </div>
  );
}
