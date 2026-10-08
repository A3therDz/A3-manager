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
 * LoRA 名规范化:取最后一个 / 或 \ 之后的部分,去扩展名,trim,转小写。
 * 图里的 LoRA 可能写成 画风类/velnari_xxx:0.57,配方里可能只写文件名 —— 两边都压到同一口径再比。
 */
export function normalizeLoraName(name: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const noExt = base.replace(/\.[^.]+$/, '');
  return noExt.trim().toLowerCase();
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

export interface RecipeMatch {
  recipe: RecipeRecord;
  /** 该配方吸收掉的 imageLoras 下标 */
  loraIndexes: number[];
}

export interface RecipeMatchResult {
  matches: RecipeMatch[];
  /** 没有归进任何配方的 imageLoras 下标(保持原顺序) */
  unmatched: number[];
}

/** 权重比较的容差:入库时权重可能被截断/四舍五入过。
 *  1e-9 是把"恰好等于容差"的边界判成命中(如 0.575 vs 0.57,IEEE 浮点差值是 0.005000…0044)。 */
export const STRENGTH_TOLERANCE = 0.005;

/**
 * 把一张图的 LoRA 列表按配方分组。
 *
 * 一个提示词可能由几个配方叠加构成,所以是**子集匹配**:配方的所有 LoRA
 * (非 exclude,按规范化名字 + 权重容差 ±0.005)都能在该图里找到,该配方命中。
 * 图里权重缺失(null)时只按名字比;配方里权重不是有限数时也只按名字比。
 *
 * 多配方重叠时按配方 LoRA 数量降序贪心分配(数量相同按标题字典序,保证结果确定),
 * 每个图 LoRA 最多归一个配方。被吸收的 LoRA 下标进 loraIndexes,其余进 unmatched。
 */
export function matchRecipes(
  imageLoras: Array<{ name: string; strength: number | null }>,
  recipes: RecipeRecord[]
): RecipeMatchResult {
  const remaining = imageLoras.map((l, i) => ({
    i,
    name: normalizeLoraName(l.name),
    strength: l.strength,
  }));

  const candidates = recipes
    .map((recipe) => ({
      recipe,
      need: (Array.isArray(recipe.loras) ? recipe.loras : []).filter((l) => l && l.exclude !== true),
    }))
    .filter((x) => x.need.length > 0)
    .sort((a, b) =>
      b.need.length - a.need.length ||
      (String(a.recipe.title) < String(b.recipe.title) ? -1 : 1)
    );

  const matches: RecipeMatch[] = [];
  for (const { recipe, need } of candidates) {
    const used = new Set<number>();
    const picked: number[] = [];
    let ok = true;
    for (const rl of need) {
      const rn = normalizeLoraName(rl.file_name);
      const rs = Number(rl.strength);
      const hit = remaining.find(
        (x) =>
          !used.has(x.i) &&
          x.name === rn &&
          (x.strength === null ||
            x.strength === undefined ||
            !Number.isFinite(rs) ||
            Math.abs(x.strength - rs) <= STRENGTH_TOLERANCE + 1e-9)
      );
      if (!hit) {
        ok = false;
        break;
      }
      used.add(hit.i);
      picked.push(hit.i);
    }
    if (ok) {
      matches.push({ recipe, loraIndexes: picked });
      for (const idx of picked) {
        const at = remaining.findIndex((x) => x.i === idx);
        if (at >= 0) remaining.splice(at, 1);
      }
    }
  }
  return { matches, unmatched: remaining.map((x) => x.i).sort((a, b) => a - b) };
}
