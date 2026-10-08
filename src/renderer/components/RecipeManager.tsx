/**
 * LoRA 配方管理弹层(v0.8 第3条改进)。
 *
 * 从工具条「配方」按钮打开;详情面板的「存为配方」也会打开它(initialLoras 预填)。
 * 存储:主进程把每条配方写成 <userData>/recipes/<id>.recipe.json(与外部工具互通),
 * 这里只管界面 —— 列表(收藏优先,再按修改时间倒序)+ 新建/编辑表单 + 删除。
 *
 * 浮层退场由 App.tsx 传入的 closing 驱动(useDelayedClose 模式)。
 */

import { useEffect, useMemo, useState } from 'react';
import type { RecipeRecord } from '@shared/types';
import { errMsg, recipeCoverUrl } from '../api';

/** 「存为配方」预填用的最小 LoRA 形状 */
export interface RecipeDraftLora {
  file_name: string;
  strength: number;
}

interface Props {
  recipes: RecipeRecord[];
  closing: boolean;
  /** 受控初始值:带 initialLoras 打开时直接进新建表单(详情面板「存为配方」) */
  initialLoras?: RecipeDraftLora[];
  onClose: () => void;
  /** 保存/删除/收藏变化后回调,父组件负责重拉 listRecipes */
  onChanged: () => void;
  notify: (msg: string, bad?: boolean) => void;
}

interface DraftRow {
  file_name: string;
  /** 输入中用字符串,保存时再转数字(不然输入 "0." 会被吃掉) */
  strength: string;
}

interface Draft {
  /** 编辑中的原记录:保存时展开它再覆盖字段,外部工具的未知字段得以保留 */
  original: RecipeRecord | null;
  title: string;
  baseModel: string;
  loras: DraftRow[];
  /** 新选的配图绝对路径;null = 不改动(编辑时沿用原封面) */
  coverPath: string | null;
  /** 新选配图的预览 dataURL(inspectFile 给的);原封面直接用 cam-recipe 协议显示 */
  coverPreview: string | null;
  /** 用户点了「清除配图」 */
  clearCover: boolean;
}

function emptyDraft(initialLoras?: RecipeDraftLora[]): Draft {
  return {
    original: null,
    title: '',
    baseModel: '',
    loras: (initialLoras ?? []).map((l) => ({ file_name: l.file_name, strength: String(l.strength) })),
    coverPath: null,
    coverPreview: null,
    clearCover: false,
  };
}

/** 配方封面小图:加载失败(没封面)时显示占位符 */
export function RecipeCover({ id, size }: { id: string; size: number }) {
  const [err, setErr] = useState(false);
  if (err) {
    return (
      <span className="cam-recipe-cover" style={{ width: size, height: size }} aria-hidden="true">
        —
      </span>
    );
  }
  return (
    <img
      key={id}
      className="cam-recipe-cover"
      style={{ width: size, height: size }}
      src={recipeCoverUrl(id)}
      alt=""
      draggable={false}
      onError={() => setErr(true)}
    />
  );
}

export function RecipeManager({ recipes, closing, initialLoras, onClose, onChanged, notify }: Props) {
  const [draft, setDraft] = useState<Draft | null>(() =>
    initialLoras && initialLoras.length ? emptyDraft(initialLoras) : null
  );
  /** 删除是破坏性的:第一次点「删除」进入确认态,再点一次才真正删 */
  const [confirmDelId, setConfirmDelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 收藏优先,再按修改时间倒序
  const sorted = useMemo(
    () =>
      [...recipes].sort((a, b) =>
        (b.favorite === true ? 1 : 0) - (a.favorite === true ? 1 : 0) ||
        (Number(b.modified) || 0) - (Number(a.modified) || 0)
      ),
    [recipes]
  );

  const startEdit = (r: RecipeRecord) => {
    setConfirmDelId(null);
    setDraft({
      original: r,
      title: r.title,
      baseModel: r.base_model ?? '',
      loras: (Array.isArray(r.loras) ? r.loras : []).map((l) => ({
        file_name: String(l.file_name ?? ''),
        strength: String(l.strength ?? ''),
      })),
      coverPath: null,
      coverPreview: null,
      clearCover: false,
    });
  };

  const toggleFavorite = (r: RecipeRecord) => {
    void window.api
      .saveRecipe({ ...r, favorite: !r.favorite })
      .then(() => onChanged())
      .catch((e) => notify(errMsg(e), true));
  };

  const doDelete = (r: RecipeRecord) => {
    void window.api
      .deleteRecipe(r.id)
      .then(() => {
        notify(`已删除配方「${r.title}」`);
        setConfirmDelId(null);
        onChanged();
      })
      .catch((e) => notify(errMsg(e), true));
  };

  const pickCover = () => {
    void window.api
      .pickImageFile()
      .then(async (p) => {
        if (!p) return;
        // 新选的图走 inspectFile 拿等比缩小的 dataURL 预览(cam-recipe 只服务已保存的封面)
        let preview: string | null = null;
        try {
          const d = await window.api.inspectFile(p);
          preview = d.previewDataUrl;
        } catch {
          /* 预览拿不到就只显示路径 */
        }
        setDraft((cur) => (cur ? { ...cur, coverPath: p, coverPreview: preview, clearCover: false } : cur));
      })
      .catch((e) => notify(errMsg(e), true));
  };

  const save = () => {
    if (!draft) return;
    if (!draft.title.trim()) {
      notify('配方名字不能为空', true);
      return;
    }
    const loras = draft.loras
      .map((l) => ({ file_name: l.file_name.trim(), strength: Number(l.strength) }))
      .filter((l) => l.file_name !== '' && Number.isFinite(l.strength));
    if (loras.length === 0) {
      notify('至少保留一条 LoRA(文件名 + 权重)', true);
      return;
    }
    const original = draft.original;
    // created_date / modified / fingerprint 由主进程补;这里给占位值只为满足类型
    const payload = {
      ...(original ?? {}),
      id: original?.id ?? '',
      title: draft.title.trim(),
      base_model: draft.baseModel.trim() ? draft.baseModel.trim() : null,
      loras,
      file_path: draft.clearCover ? null : (draft.coverPath ?? original?.file_path ?? null),
      favorite: original?.favorite === true,
      created_date: original?.created_date ?? 0,
      modified: original?.modified ?? 0,
      fingerprint: '',
    } as RecipeRecord;
    setBusy(true);
    void window.api
      .saveRecipe(payload)
      .then(() => {
        notify(original ? `配方「${payload.title}」已更新` : `配方「${payload.title}」已保存`);
        setDraft(null);
        onChanged();
      })
      .catch((e) => notify(errMsg(e), true))
      .finally(() => setBusy(false));
  };

  // 打开弹层时清掉确认态,避免残留
  useEffect(() => {
    setConfirmDelId(null);
  }, [sorted.length]);

  const coverPreviewSrc = draft
    ? draft.clearCover
      ? null
      : draft.coverPreview ?? (draft.coverPath ? null : draft.original ? recipeCoverUrl(draft.original.id) : null)
    : null;

  return (
    <div
      className={`cam-modal${closing ? ' closing' : ''}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={{ width: 620, maxHeight: '84vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <h2
          style={{
            fontSize: 13,
            margin: 0,
            padding: '12px 16px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {draft ? (draft.original ? '编辑配方' : '新建配方') : 'LoRA 配方'}
          <span style={{ flex: 1 }} />
          {draft ? (
            <button type="button" style={btn} onClick={() => setDraft(null)}>
              ← 返回列表
            </button>
          ) : (
            <button type="button" style={primaryBtn} onClick={() => setDraft(emptyDraft())}>
              + 新建配方
            </button>
          )}
          <button type="button" style={btn} onClick={onClose}>
            关闭
          </button>
        </h2>

        <div style={{ padding: '12px 16px', overflowY: 'auto' }}>
          {draft ? (
            <>
              <label style={labelStyle}>
                名字(必填)
                <input
                  autoFocus
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  placeholder="如:油画幻想"
                  style={{ ...input, width: '100%', marginTop: 4 }}
                />
              </label>
              <label style={labelStyle}>
                底模(选填)
                <input
                  value={draft.baseModel}
                  onChange={(e) => setDraft({ ...draft, baseModel: e.target.value })}
                  placeholder="如:Krea 2"
                  style={{ ...input, width: '100%', marginTop: 4 }}
                />
              </label>

              <div style={labelStyle}>
                配图(选填)
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                  {coverPreviewSrc ? (
                    <img
                      src={coverPreviewSrc}
                      alt=""
                      draggable={false}
                      style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, background: 'var(--inset)' }}
                      onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
                    />
                  ) : (
                    <span
                      className="cam-recipe-cover"
                      style={{ width: 56, height: 56, fontSize: 18 }}
                      aria-hidden="true"
                    >
                      —
                    </span>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="button" style={btn} onClick={pickCover}>
                        选择图片…
                      </button>
                      {coverPreviewSrc || draft.coverPath ? (
                        <button
                          type="button"
                          style={btn}
                          onClick={() => setDraft({ ...draft, coverPath: null, coverPreview: null, clearCover: true })}
                        >
                          清除配图
                        </button>
                      ) : null}
                    </div>
                    {draft.coverPath ? (
                      <span style={{ fontSize: 10.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {draft.coverPath}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>

              <div style={labelStyle}>
                LoRA 列表(file_name 填 LoRA 文件名,不带 &lt;lora: &gt; 包裹;权重对不上 ±0.005 就匹配不到)
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                  {draft.loras.map((l, i) => (
                    <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input
                        value={l.file_name}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            loras: draft.loras.map((x, j) => (j === i ? { ...x, file_name: e.target.value } : x)),
                          })
                        }
                        placeholder="如:velnari_fantasy_impressions_krea2"
                        style={{ ...input, flex: 1, minWidth: 0 }}
                      />
                      <input
                        value={l.strength}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            loras: draft.loras.map((x, j) => (j === i ? { ...x, strength: e.target.value } : x)),
                          })
                        }
                        placeholder="0.57"
                        inputMode="decimal"
                        style={{ ...input, width: 76, textAlign: 'right' }}
                      />
                      <button
                        type="button"
                        style={{ ...btn, color: 'var(--muted)', padding: '4px 8px' }}
                        title="移除这条 LoRA"
                        onClick={() => setDraft({ ...draft, loras: draft.loras.filter((_, j) => j !== i) })}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    style={{ ...btn, alignSelf: 'flex-start' }}
                    onClick={() => setDraft({ ...draft, loras: [...draft.loras, { file_name: '', strength: '1' }] })}
                  >
                    + 添加 LoRA
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                <button type="button" style={btn} onClick={() => setDraft(null)}>
                  取消
                </button>
                <button type="button" style={primaryBtn} disabled={busy} onClick={save}>
                  保存
                </button>
              </div>
            </>
          ) : sorted.length === 0 ? (
            <div style={{ padding: '30px 0', textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
              还没有配方。点右上角「+ 新建配方」,或在详情面板的 LoRA 区点「存为配方」。
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {sorted.map((r) => (
                <div key={r.id} className="cam-recipe-row">
                  <RecipeCover id={r.id} size={44} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <button
                        type="button"
                        className={`cam-recipe-fav${r.favorite === true ? ' on' : ''}`}
                        title={r.favorite === true ? '取消收藏' : '收藏(排到最前)'}
                        onClick={() => toggleFavorite(r)}
                      >
                        {r.favorite === true ? '★' : '☆'}
                      </button>
                      <span
                        style={{
                          fontSize: 12.5,
                          fontWeight: 600,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {r.title}
                      </span>
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>
                      {r.base_model ? `${r.base_model} · ` : ''}
                      {Array.isArray(r.loras) ? r.loras.filter((l) => l && l.exclude !== true).length : 0} 个 LoRA
                    </div>
                  </div>
                  <button type="button" style={btn} onClick={() => startEdit(r)}>
                    编辑
                  </button>
                  {confirmDelId === r.id ? (
                    <button type="button" style={dangerBtn} onClick={() => doDelete(r)}>
                      确认删除
                    </button>
                  ) : (
                    <button
                      type="button"
                      style={{ ...btn, color: 'var(--muted)' }}
                      onClick={() => setConfirmDelId(r.id)}
                    >
                      删除
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  background: 'var(--ctl-bg)',
  border: '1px solid var(--ctl-border)',
  color: 'var(--fg)',
  borderRadius: 'var(--radius-md)',
  padding: '5px 10px',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
};

const primaryBtn: React.CSSProperties = {
  ...btn,
  borderColor: 'var(--accent)',
  color: 'var(--accent)',
  background: 'var(--accent-soft)',
};

const dangerBtn: React.CSSProperties = {
  ...btn,
  borderColor: 'var(--bad)',
  color: 'var(--bad)',
  background: 'var(--bad-bg)',
};

const input: React.CSSProperties = {
  background: 'var(--ctl-bg)',
  border: '1px solid var(--ctl-border)',
  color: 'var(--fg)',
  borderRadius: 'var(--radius-md)',
  padding: '5px 9px',
  font: 'inherit',
  fontSize: 12,
  outline: 'none',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11.5,
  color: 'var(--muted)',
  marginBottom: 12,
};
