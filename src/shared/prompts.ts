/**
 * 提示词归一化与相似度 —— 纯 TS 共享模块(不依赖 React / Electron / Node)。
 *
 * 用途(v0.8 配方比对):「用同一个提示词、换不同的 LoRA 配方出图,然后比对效果」。
 * 前一半就是"按提示词把同类图聚起来",需要两个口径:
 *   - 归一化:大小写 / 多余空白 / 强调权重语法 `(word:1.3)` / 结尾逗号 都不该算成"不同提示词";
 *   - 相似度:出图时改了半句话仍然是"同一批图",用 token 集合的 Jaccard 系数衡量。
 *
 * verify 脚本会直接 import 本模块做行为测试,所以不要 import 任何 node/electron 模块。
 */

/**
 * 相似提示词的判定阈值(Jaccard token 相似度)。
 * 0.85:大约"长提示词里改了 2–3 个词"的水平;再低就会把同题材但不同画面的图混进来。
 */
export const SIMILAR_THRESHOLD = 0.85;

/** `(word:1.3)` / `(word: 1.3)` / `(word:-0.5)` —— 强调权重语法(只认括号内"整体 + 冒号 + 数字") */
const WEIGHT_PARENS = /\(\s*([^()]*?)\s*:\s*(-?\d+(?:\.\d+)?)\s*\)/g;
/** 纯强调括号 `(word)` —— 剥掉括号本身 */
const PLAIN_PARENS = /\(([^()]*)\)/g;
/** 结尾多余的逗号 / 句点 / 空白 */
const TRAILING_PUNCT = /[\s,.]+$/;

/**
 * 提示词归一化:小写 → 折叠连续空白 → 去掉强调权重语法与多余括号 → 去掉结尾逗号/句点。
 *
 * 注意**只动展示与比较的形态,不改语义**:
 *   `"  A  Cat, (Best Quality:1.3), ((masterpiece)) , "` → `"a cat, best quality, masterpiece"`
 */
export function normalizePrompt(text: string): string {
  let out = String(text ?? '');
  /**
   * 强调语法可以嵌套:`((word))` 的两层括号要剥两次;`(word:1.3)` 要先去权重再去括号。
   * 每轮两件都做一遍,直到不再变化(层数由正则自然收敛)。
   */
  for (let i = 0; i < 8; i++) {
    const before = out;
    out = out.replace(WEIGHT_PARENS, '$1').replace(PLAIN_PARENS, '$1');
    if (out === before) break;
  }
  return out.toLowerCase().replace(/\s+/g, ' ').trim().replace(TRAILING_PUNCT, '');
}

/**
 * 提示词 token:归一化后按非字母数字切分,保留**长度 ≥ 2** 的 token(含数字,如 `2d`),去重。
 *
 * 单字符 token 全是噪声(逗号、强调括号留下的碎片),删掉能显著抬高相似度的区分度。
 */
export function promptTokens(text: string): string[] {
  const norm = normalizePrompt(text);
  if (!norm) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of norm.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/**
 * 提示词 token 集合。批量比较时**先算一次基准图的集合**,再用
 * similarityToTokenSet 逐条比 —— 长提示词(几千字符、几百个 token)上
 * 每次重算基准图是主要开销(实测真实库 3000 条候选:1090ms → 213ms)。
 */
export function promptTokenSet(text: string): Set<string> {
  return new Set(promptTokens(text));
}

/**
 * 用**已经算好**的基准 token 集合与一条文本比相似度(口径与 promptSimilarity 完全一致)。
 * 批量筛选走这个,避免 N 次重复分词。
 */
export function similarityToTokenSet(base: ReadonlySet<string>, text: string): number {
  const tb = promptTokenSet(text);
  return similarityOfSets(base, tb);
}

/** 两个 token 集合的 Jaccard 系数(内部实现;空集合一律 0) */
function similarityOfSets(ta: ReadonlySet<string>, tb: ReadonlySet<string>): number {
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  const union = ta.size + tb.size - hit;
  return union === 0 ? 0 : hit / union;
}

/**
 * 两个提示词的相似度:token 集合的 Jaccard 系数(交集 / 并集),0–1。
 *
 * 口径:
 *   - 完全相同(非空)→ 1;
 *   - 任一边没有可用 token(空串、或只有标点)→ 0 —— "都没提示词"不算"一模一样";
 *   - 否则按 token 集合算,与词序无关(提示词的顺序对画面本来就几乎没有影响)。
 */
export function promptSimilarity(a: string, b: string): number {
  return similarityOfSets(promptTokenSet(a), promptTokenSet(b));
}
