/**
 * 网格卡片 → 左侧分类 的拖放协议(v0.6)。
 *
 * 为什么需要它:卡片的原生拖拽和「把文件拖进窗口解析元数据」走的是**同一套
 * DragEvent**,不区分的话,拖动卡片就会弹出「松手即解析元数据」的提示层
 * (用户就是这样撞上的:拖预览图时跳出解析界面)。
 *
 * 区分办法:自己发起拖拽时往 dataTransfer 里塞一个**私有 MIME**
 * (`application/x-a3-image-ids`),它是"软件内部拖拽"的标记;
 * 从资源管理器拖进来的文件只有 `Files`,不会带这个类型。
 * 卡片拖动时额外放一份 `text/plain` 兜底(chrome 在 drop 阶段可能清空
 * dataTransfer 的类型列表,纯文本仍然读得到)。
 */

/** 内部拖拽的私有类型标记 */
export const IMAGE_DND_MIME = 'application/x-a3-image-ids';

/** 内部拖拽时同时写入的纯文本兜底前缀(值形如 `a3-image-ids:1,2,3`) */
const TEXT_PREFIX = 'a3-image-ids:';

/** 本次拖拽携带的图片 id 列表(拖拽期间内存里的副本) */
export interface ImageDragPayload {
  ids: number[];
}

// 进程内的"当前正在拖什么":dragstart 写入,dragend/drop 清空。
// 模块级变量是安全的 —— 一个渲染进程同一时刻只可能有一条拖拽会话。
let current: ImageDragPayload | null = null;

/** 卡片 onDragStart 调用:打标记 + 记下 payload */
export function startImageDrag(ids: number[], dt: DataTransfer | null): void {
  current = { ids };
  if (!dt) return;
  try {
    dt.setData(IMAGE_DND_MIME, ids.join(','));
    // 兜底的纯文本:drop 阶段私有类型可能读不出来,这一份还能用
    dt.setData('text/plain', `${TEXT_PREFIX}${ids.join(',')}`);
    dt.effectAllowed = 'copyMove';
  } catch {
    /* dataTransfer 被锁定时忽略(不影响模块内的 current) */
  }
}

export function endImageDrag(): void {
  current = null;
}

/**
 * 这个 DataTransfer 是不是"窗口内部在拖卡片"?
 * 判断只看类型标记 + 纯文本兜底,不看 current ——
 * dragover / dragenter 阶段发生在自己的窗口里,两者都有。
 */
export function isImageDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  try {
    const types = Array.from(dt.types || []);
    if (types.includes(IMAGE_DND_MIME)) return true;
    // drop 阶段类型列表可能已被清空,退回看纯文本内容
    const txt = dt.getData('text/plain');
    return typeof txt === 'string' && txt.startsWith(TEXT_PREFIX);
  } catch {
    return false;
  }
}

/**
 * 「正在拖自己窗口里的卡片」——只看同步可见的信号,不看 getData()。
 *
 * 必须分成两个判断,因为浏览器在 **dragover 阶段屏蔽 getData()**:
 * 那时 private MIME 读不到,只有 `dt.types` 和内存里的会话标记可用。
 * 窗口级的 dragenter/dragover 监听(要拦住"拖卡片时冒出解析元数据提示层")
 * 就走这一条。
 */
export function hasImageDragData(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  try {
    return Array.from(dt.types || []).includes(IMAGE_DND_MIME);
  } catch {
    return false;
  }
}

/** 本进程有没有一条正在进行中的内部图片拖拽会话(同上,同步、不依赖 DataTransfer) */
export function isInternalImageDrag(): boolean {
  return current !== null;
}

/**
 * 取出这次拖拽要操作的图片 id:
 * 先读 private 类型,读不到再读纯文本,最后退回内存里的 current
 * (drop 阶段 dataTransfer 的保护模式会挡掉 getData,current 是可靠兜底)。
 */
export function readImageDragIds(dt: DataTransfer | null): number[] {
  const parse = (raw: string): number[] =>
    raw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);

  if (dt) {
    try {
      const priv = dt.getData(IMAGE_DND_MIME);
      if (priv) {
        const ids = parse(priv);
        if (ids.length) return ids;
      }
      const txt = dt.getData('text/plain');
      if (txt && txt.startsWith(TEXT_PREFIX)) {
        const ids = parse(txt.slice(TEXT_PREFIX.length));
        if (ids.length) return ids;
      }
    } catch {
      /* 忽略:退回 current */
    }
  }
  return current ? current.ids : [];
}
