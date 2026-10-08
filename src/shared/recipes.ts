/**
 * LoRA 配方 —— 纯 TS 共享模块(不依赖 React / Electron / Node)。
 *
 * 存储格式与外部工具互通:每条配方是 <userData>/recipes/<id>.recipe.json 一个文件,
 * 字段对齐外部工具(id / file_path / title / modified / created_date / base_model /
 * loras / gen_params / fingerprint / favorite),未知字段必须 round-trip 保留。
 *
 * 本模块只放纯逻辑:
 *   - normalizeLoraName  LoRA 名规范化(匹配与指纹共用同一口径)
 *   - fingerprintOf      配方指纹:排序后的 name:strength 串
 *   - matchRecipes       把一张图的 LoRA 列表按配方分组(子集匹配 + 贪心分配)
 *
 * verify 脚本会直接 import 本模块做行为测试,所以不要 import 任何 node/electron 模块。
 */

/** 配方里的一条 LoRA。外部工具的附加字段(modelName/hash/isDeleted 等)经索引签名保留。 */
export interface RecipeLora {
  /** LoRA 文件名(不含 <lora: 包裹),可能带子目录,如 画风类/xxx */
  file_name: string;
  /** 权重(对应入库后的 strengthModel) */
  strength: number;
  modelName?: string;
  modelVersionName?: string;
  hash?: string;
  isDeleted?: boolean;
  hashInvalid?: boolean;
  /** true 表示该条只是记录、不参与匹配与指纹 */
  exclude?: boolean;
  [key: string]: unknown;
}

/** 一条配方记录(与磁盘上的 .recipe.json 一一对应)。 */
export interface RecipeRecord {
  id: string;
  /** 封面图绝对路径;保存时主进程会把外部图片拷进 recipes 目录 */
  file_path: string | null;
  title: string;
  /** 秒级 Unix 时间戳(浮点,对齐外部工具) */
  modified: number;
  created_date: number;
  base_model: string | null;
  loras: RecipeLora[];
  /** 见 fingerprintOf;外部工具的 sha256 口径在这里换成规范化文件名口径 */
  fingerprint: string;
  favorite: boolean;
  gen_params?: unknown;
  [key: string]: unknown;
}

/**
 * LoRA 名规范化:取最后一个 / 或 \ 之后的部分,剥掉模型文件扩展名(.safetensors 等),trim,转小写。
 * 图里的 LoRA 可能写成 画风类/velnari_xxx:0.57,配方里可能只写文件名 —— 两边都压到同一口径再比。
 */
/**
 * 模型文件扩展名 —— 只剥这些后缀。
 * 不能"剥最后一个点后缀":像 `(Krea 2) Vision Vanguard 24 V2026.1` 里的 `.1` 是名字的一部分,
 * 按任意点后缀剥会把它变成 `...v2026`,和写全名的图对不上。
 */
const MODEL_EXT = /\.(safetensors|sft|ckpt|pth|pt|bin|gguf)$/i;

export function normalizeLoraName(name: string): string {
  let base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  while (MODEL_EXT.test(base)) base = base.replace(MODEL_EXT, '');
  return base.trim().toLowerCase();
}

/**
 * 配方指纹:排除 exclude===true 的条目,
 * `规范化文件名:Number(strength.toFixed(2))` 按 name 排序后用 | 连接。
 * (外部工具用 sha256 hash 作 key;本应用索引库里只有名字+权重,故用规范化文件名代替。)
 */
export function fingerprintOf(loras: Array<Pick<RecipeLora, 'file_name' | 'strength' | 'exclude'>>): string {
  return loras
    .filter((l) => l && l.exclude !== true)
    .map((l) => ({ name: normalizeLoraName(l.file_name), strength: Number(l.strength) }))
    .filter((l) => l.name !== '')
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((l) => `${l.name}:${Number(l.strength.toFixed(2))}`)
    .join('|');
}

export interface RecipeLoraPair {
  /** 配方里的这条 LoRA */
  recipeLora: RecipeLora;
  /** 图里对应的那条(下标指向传入的 imageLoras) */
  imageIndex: number;
  /** 图里实际用的权重(null = 图里没记) */
  imageStrength: number | null;
  /** 与配方记录的权重之差(两边都有权重时才有值) */
  strengthDiff: number | null;
}

export interface RecipeMatch {
  recipe: RecipeRecord;
  /** 每条非 exclude 的配方 LoRA 对应到图里的哪一条 */
  pairs: RecipeLoraPair[];
  /** 吸收掉的 imageLoras 下标(detail: 由 pairs 派生) */
  loraIndexes: number[];
  /** 权重偏差合计(只统计两边都有权重的项);0 = 与配方记录完全一致 */
  weightDrift: number;
}

export interface RecipeMatchResult {
  matches: RecipeMatch[];
  /** 没有归进任何配方的 imageLoras 下标(保持原顺序) */
  unmatched: number[];
}

/**
 * 权重提示阈值:超过它就是"这张图的实际权重和配方记录不一样"(只用于提示,不作为命中门槛)。
 * 1e-9 把"恰好等于阈值"的边界算作一致(如 0.575 vs 0.57,IEEE 浮点差值是 0.005000…0044)。
 */
export const STRENGTH_TOLERANCE = 0.005;

/**
 * 把一张图的 LoRA 列表按配方分组。
 *
 * **匹配只看名字,不看权重**:配方是"这组 LoRA"的记号,权重只是创建配方时记下的参考值,
 * 出图时调过权重(0.8 → 0.2)不该让整组配方失效 —— 否则一个提示词用了长配方里的几条,
 * 就会退化显示成"短配方(它的子集)+ 几条散落的 LoRA"。
 *
 * 规则:
 *  1. 子集匹配:配方所有非 exclude 的 LoRA 都能在图中找到(规范化名字相等)才算命中;
 *  2. 贪心分配:**LoRA 条数多的配方优先**(长配方/更具体的配方先认领),
 *     条数相同时"权重更接近配方记录"的优先(drift 小的先),再退化成标题字典序(结果确定);
 *  3. 每个图 LoRA 最多归一个配方;被吸收的进 pairs/loraIndexes,其余进 unmatched。
 */
export function matchRecipes(
  imageLoras: Array<{ name: string; strength: number | null }>,
  recipes: RecipeRecord[]
): RecipeMatchResult {
  const remaining = imageLoras.map((l, i) => ({
    i,
    name: normalizeLoraName(l.name),
    strength: typeof l.strength === 'number' && Number.isFinite(l.strength) ? l.strength : null,
  }));

  /** 在不消耗 remaining 的前提下试匹配一组 need;返回配对与权重偏差 */
  const tryMatch = (need: RecipeLora[]): { pairs: RecipeLoraPair[]; drift: number } | null => {
    const used = new Set<number>();
    const pairs: RecipeLoraPair[] = [];
    let drift = 0;
    for (const rl of need) {
      const rn = normalizeLoraName(rl.file_name);
      const rs = Number(rl.strength);
      const hit = remaining.find((x) => !used.has(x.i) && x.name === rn);
      if (!hit) return null;
      used.add(hit.i);
      const diff = hit.strength !== null && Number.isFinite(rs) ? Math.abs(hit.strength - rs) : null;
      if (diff !== null) drift += diff;
      pairs.push({ recipeLora: rl, imageIndex: hit.i, imageStrength: hit.strength, strengthDiff: diff });
    }
    return { pairs, drift };
  };

  const candidates = recipes
    .map((recipe) => ({
      recipe,
      need: (Array.isArray(recipe.loras) ? recipe.loras : []).filter((l) => l && l.exclude !== true),
    }))
    .filter((x) => x.need.length > 0)
    .map((x) => ({ ...x, probe: tryMatch(x.need) }))
    .sort(
      (a, b) =>
        b.need.length - a.need.length ||
        (a.probe ? a.probe.drift : Number.POSITIVE_INFINITY) -
          (b.probe ? b.probe.drift : Number.POSITIVE_INFINITY) ||
        (String(a.recipe.title) < String(b.recipe.title) ? -1 : 1)
    );

  const matches: RecipeMatch[] = [];
  for (const { recipe, need } of candidates) {
    const hit = tryMatch(need);
    if (!hit) continue;
    matches.push({
      recipe,
      pairs: hit.pairs,
      loraIndexes: hit.pairs.map((p) => p.imageIndex),
      weightDrift: hit.drift,
    });
    for (const p of hit.pairs) {
      const at = remaining.findIndex((x) => x.i === p.imageIndex);
      if (at >= 0) remaining.splice(at, 1);
    }
  }
  return { matches, unmatched: remaining.map((x) => x.i).sort((a, b) => a - b) };
}
