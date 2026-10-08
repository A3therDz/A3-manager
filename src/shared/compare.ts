/**
 * 配方比对 —— 纯 TS 共享模块(不依赖 React / Electron / Node)。
 *
 * 解决的问题:同一个(或几乎同一个)提示词、换不同的 LoRA 配方出图之后,
 * 「配方 A vs 配方 B 在同一提示词下分别长什么样」得能一眼看出来。
 *
 * 分工:
 *   - 数据行 CompareRow:一张图 + 它命中的配方 + 与基准图的提示词相似度(主进程组装);
 *   - 分列 groupCompareRows:按"每行命中的最长配方"分组,并算出各配方之间 LoRA 集合的差异。
 *
 * verify 脚本会直接 import 本模块做行为测试,所以不要 import 任何 node/electron 模块。
 */

import { matchRecipes, normalizeLoraName, type RecipeRecord } from './recipes.ts';
import { promptSimilarity } from './prompts.ts';

/** 图里的一条 LoRA(name 是图里写的原始名字,可能带子目录/扩展名) */
export interface CompareLora {
  name: string;
  strength: number | null;
}

/** 比对面板里的一行 = 一张图。列表投影,不含 meta_json/raw_json。 */
export interface CompareRow {
  id: number;
  fileName: string;
  /** 相对所属图库根的目录,'' = 根目录 */
  relDir: string;
  width: number | null;
  height: number | null;
  seed: number | null;
  /** 这张图记录的**原始**正向提示词(null = 没记录) */
  prompt: string | null;
  /** 与基准图的提示词相似度(基准图自己恒为 1) */
  similarity: number;
  loras: CompareLora[];
  /**
   * 命中的配方标题,**按 matchRecipes 的顺序**(LoRA 条数多的配方在前)。
   * `[0]` 就是这张图的"主配方",分列时按它归组。
   */
  recipeTitles: string[];
  /** 是否至少命中一个配方(等价于 recipeTitles.length > 0) */
  matched: boolean;
}

/** 数据层交出的原始行(还没算匹配与相似度) */
export interface CompareBasic {
  id: number;
  fileName: string;
  relDir: string;
  width: number | null;
  height: number | null;
  seed: number | null;
  prompt: string | null;
  loras: CompareLora[];
}

/** 与第一组相比的 LoRA 集合差异(名字保持图里的原始显示形态) */
export interface CompareDiff {
  /** 本组有、第一组没有 */
  added: string[];
  /** 第一组有、本组没有 */
  removed: string[];
}

export interface CompareGroup {
  /** 分组键 = 主配方标题;未匹配配方是 ''(空串) */
  key: string;
  /** 显示名;未匹配组是「未匹配配方」 */
  title: string;
  rows: CompareRow[];
  diff: CompareDiff;
}

/** 没有命中任何配方的图归到这一组,永远排在最后 */
export const UNMATCHED_TITLE = '未匹配配方';

/**
 * 把数据行组装成界面要的形状:补上配方命中(recipeTitles)与提示词相似度。
 *
 * @param basics     数据层给出的原始行(顺序即显示顺序)
 * @param recipes    当前全部配方(App 顶层 / 主进程读同一个 recipes 目录)
 * @param basePrompt 基准图的提示词(相似度的参照物)
 */
export function buildCompareRows(
  basics: CompareBasic[],
  recipes: RecipeRecord[],
  basePrompt: string
): CompareRow[] {
  return basics.map((b) => {
    const m = matchRecipes(
      b.loras.map((l) => ({ name: l.name, strength: l.strength })),
      recipes
    );
    const recipeTitles = m.matches.map((x) => String(x.recipe.title));
    return {
      id: b.id,
      fileName: b.fileName,
      relDir: b.relDir,
      width: b.width,
      height: b.height,
      seed: b.seed,
      prompt: b.prompt,
      similarity: promptSimilarity(basePrompt, b.prompt ?? ''),
      loras: b.loras,
      recipeTitles,
      matched: recipeTitles.length > 0,
    };
  });
}

/**
 * 一组的 LoRA 名集合:`规范化名字 → 原始显示名`(首次出现的写法胜出,顺序即首见顺序)。
 * 比名字一律用 normalizeLoraName(与配方匹配同一口径:去子目录/扩展名、小写)。
 */
function groupLoraNames(rows: CompareRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows) {
    for (const l of r.loras) {
      const base = normalizeLoraName(l.name);
      if (base === '' || map.has(base)) continue;
      map.set(base, l.name);
    }
  }
  return map;
}

/**
 * 分列:按"每行命中的最长配方"(`recipeTitles[0]`)分组。
 *
 * - 组顺序:**有配方的组在前**,组内 LoRA 条数(去重后的集合大小)降序,再按组名字典序;
 *   没有命中任何配方的图归成最后一组「未匹配配方」。
 * - `diff` 一律与**第一组**比:第一组有而本组没有 = removed;本组有而第一组没有 = added。
 *   组内 LoRA 集合取"该组所有图用到的 LoRA 并集"(对配方组来说就是"这组配方实际出图时用的 LoRA"),
 *   名字按 normalizeLoraName 比较,输出保持图里的原始显示名。
 */
export function groupCompareRows(rows: CompareRow[]): CompareGroup[] {
  const buckets = new Map<string, CompareRow[]>();
  for (const r of rows) {
    const title = r.recipeTitles.length > 0 ? String(r.recipeTitles[0]) : '';
    const list = buckets.get(title);
    if (list) list.push(r);
    else buckets.set(title, [r]);
  }

  const groups: CompareGroup[] = [];
  let unmatched: CompareGroup | null = null;
  for (const [key, list] of buckets) {
    const g: CompareGroup = {
      key,
      title: key === '' ? UNMATCHED_TITLE : key,
      rows: list,
      diff: { added: [], removed: [] },
    };
    if (key === '') unmatched = g;
    else groups.push(g);
  }
  groups.sort(
    (a, b) =>
      groupLoraNames(b.rows).size - groupLoraNames(a.rows).size ||
      (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)
  );
  if (unmatched) groups.push(unmatched);

  const first = groups[0];
  if (!first) return groups;
  const firstNames = groupLoraNames(first.rows);
  for (const g of groups) {
    if (g === first) continue; // 与第一组比,自己当然一致 → 两个数组都是空
    const mine = groupLoraNames(g.rows);
    g.diff.added = [...mine.entries()].filter(([base]) => !firstNames.has(base)).map(([, shown]) => shown);
    g.diff.removed = [...firstNames.entries()].filter(([base]) => !mine.has(base)).map(([, shown]) => shown);
  }
  return groups;
}
