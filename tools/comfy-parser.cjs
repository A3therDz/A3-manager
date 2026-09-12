/**
 * ComfyUI / A1111 图片元数据抽取器。
 *
 * 支持实测发现的 5 种存储形态:
 *   F1 原生 API 图 : tEXt["prompt"] = 平铺节点图 { "1": {class_type, inputs}, ... }
 *   F2 嵌套图      : tEXt["prompt"] = { "prompt": {节点图}, "workflow": {...} }
 *   F3 A1111 文本  : tEXt["parameters"] = "正提示\nNegative prompt: ...\nSteps: 30, Sampler: ..."
 *   F4 无文本块    : 元数据被上游工具剥离
 *   F5 UI 工作流   : tEXt["workflow"] = UI 格式,参数在 nodes[].widgets_values 数组位置
 *
 * 核心难点在 F1/F2:参数不是字面量,而是 [节点id, 输出槽] 形式的链接,
 * 必须沿图回溯求值。
 */

const MAX_DEPTH = 24;

const SAMPLER_TYPES = /^(KSampler|KSamplerAdvanced|SamplerCustom|SamplerCustomAdvanced)$/;
const CHECKPOINT_TYPES = /^(CheckpointLoader(Simple)?|UNETLoader|DiffusionModelLoader|GGUFLoader|ImageOnlyCheckpointLoader|CheckpointLoaderNF4)$/;
const LORA_TYPES = /LoraLoader/i;
const CONTROLNET_TYPES = /(ControlNetApply|ControlNetLoader)/i;
const TEXT_TYPES = /^(CLIPTextEncode|BNK_CLIPTextEncodeAdvanced|CLIPTextEncodeSDXL|CLIPTextEncodeFlux|TextEncodeQwenImageEdit|T5TextEncode|PromptExpansion)$/;
const LATENT_TYPES = /(EmptyLatentImage|EmptySD3LatentImage|EmptyLatentImagePresets)/i;

const KNOWN_SAMPLERS = [
  'euler', 'euler_ancestral', 'euler_cfg_pp', 'heun', 'heunpp2', 'exp_heun_2_x0',
  'lms', 'dpm_2', 'dpm_2_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_2m_sde_gpu',
  'dpmpp_2s_ancestral', 'dpmpp_3m_sde', 'dpmpp_3m_sde_gpu', 'dpmpp_sde', 'dpmpp_sde_gpu',
  'ddim', 'uni_pc', 'uni_pc_bh2', 'ipndm', 'ipndm_v', 'lcm', 'ddpm', 'er_sde',
  'seeds_2', 'seeds_3', 'res_multistep', 'res_multistep_cfg_pp', 'gradient_estimation',
];
const KNOWN_SCHEDULERS = [
  'simple', 'normal', 'karras', 'exponential', 'sgm_uniform', 'ddim_uniform',
  'beta', 'linear', 'beta57', 'kl_optimal', 'bong_tangent', 'gpu_uniform_adaptive',
];
const SAMPLER_LOOKUP = new Set(KNOWN_SAMPLERS);
const SCHEDULER_LOOKUP = new Set(KNOWN_SCHEDULERS);
const SCHEDULER_WORDS = ['simple', 'normal', 'karras', 'exponential', 'uniform', 'beta', 'linear', 'beta57', 'sgm'];
const SAMPLER_WORDS = ['euler', 'dpmpp', 'dpm', 'heun', 'lms', 'ddim', 'uni_pc', 'lcm', 'ddpm', 'er_sde', 'seeds', 'res_multistep', 'gradient'];

const NEGATIVE_HINTS = [
  'worst quality', 'low quality', 'bad anatomy', 'bad hands', 'lowres', 'blurry',
  'jpeg artifacts', 'watermark', 'signature', 'extra digits', 'fewer digits',
  'missing finger', 'missing limb', 'deformed', 'disfigured', 'ugly', 'poorly drawn',
  'oversaturated', 'harsh contrast', 'artist name', 'logo',
];

const CORE_PREFIXES = [
  'KSampler', 'CLIPTextEncode', 'CheckpointLoader', 'LoraLoader', 'EmptyLatent',
  'VAEDecode', 'VAEEncode', 'VAELoader', 'SaveImage', 'PreviewImage', 'LoadImage',
  'Conditioning', 'ImageScale', 'LatentUpscale', 'UNETLoader', 'DualCLIPLoader',
  'ControlNetApply', 'ControlNetLoader', 'CLIPSetLastLayer', 'ModelSamplingDiscrete',
  'FreeU', 'UpscaleModelLoader', 'ImageUpscaleWithModel', 'MaskedComposite', 'ImageBlend',
];

// ================================================================ 工具

/**
 * 容错 JSON 解析。
 *
 * 实测坑:某些 ComfyUI 自定义节点会把 JavaScript 的 NaN / Infinity 直接写进
 * 元数据(如 "is_changed": NaN),这不是合法 JSON,原生 JSON.parse 会直接抛错。
 * 全库有 2463 张受影响,所以必须先做字面量消毒。
 */
function parseJsonLenient(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const cleaned = raw.replace(/([:,\[]\s*)(NaN|-?Infinity)(\s*[,}\]])/g, '$1null$3');
    try {
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }
}

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function str(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function scalarOf(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  if (Array.isArray(v)) {
    for (const x of v) {
      if (typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean') return x;
    }
  }
  if (typeof v === 'object') {
    if ('value' in v) return scalarOf(v.value);
    if ('text' in v) return scalarOf(v.text);
  }
  return null;
}

function isCoreNode(type) {
  if (type.includes('|') || type.includes('(')) return false;
  for (const p of CORE_PREFIXES) if (type.startsWith(p)) return true;
  return false;
}

// ================================================================ 名称校验

/**
 * 采样器/调度器名的合理性校验。
 *
 * 必要原因:rgthree 的 ParameterBreak / KSampler Config 这类参数转发节点,
 * 有时会把上游的错误槽位透传下来,导致采样器名解析成 "30" 这种数字。
 * 实测全库 2100+ 张受影响,不加闸门会污染筛选器候选列表。
 */
function saneName(v) {
  const s = str(v);
  if (s === null) return null;
  const t = s.trim();
  if (!t || t.length > 64) return null;
  if (/^[\d.\-+\s]+$/.test(t)) return null;
  if (!/[A-Za-z_]/.test(t)) return null;
  return t;
}

function plausibleSampler(v) {
  const s = saneName(v);
  if (s === null) return null;
  const low = s.toLowerCase();
  if (SAMPLER_WORDS.some((w) => low.includes(w))) return s;
  if (SCHEDULER_WORDS.some((w) => low.includes(w))) return s;
  if (/^[a-z0-9_]{2,32}$/.test(low)) return s;
  return null;
}

function plausibleScheduler(v) {
  const s = saneName(v);
  if (s === null) return null;
  const low = s.toLowerCase();
  if (SCHEDULER_WORDS.some((w) => low.includes(w))) return s;
  if (/^[a-z0-9_]{2,32}$/.test(low)) return s;
  return null;
}

function looksLikeSamplerString(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return false;
  if (/^[\d.\-+]+$/.test(s)) return false;
  if (SAMPLER_LOOKUP.has(s)) return true;
  const parts = s.split(' ');
  if (
    parts.length === 2 &&
    SAMPLER_WORDS.some((w) => parts[0].startsWith(w)) &&
    SCHEDULER_WORDS.some((w) => parts[1].startsWith(w))
  ) {
    return true;
  }
  if (SAMPLER_WORDS.some((w) => s.startsWith(w))) return true;
  return false;
}

function looksLikeSchedulerString(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  if (SCHEDULER_LOOKUP.has(s)) return true;
  return SCHEDULER_WORDS.some((w) => s.startsWith(w));
}

// ================================================================ 节点图

function indexGraph(promptObj) {
  const nodes = new Map();
  for (const [id, node] of Object.entries(promptObj)) {
    if (!node || typeof node !== 'object') continue;
    const type = typeof node.class_type === 'string' ? node.class_type : '';
    const inputs = node.inputs && typeof node.inputs === 'object' ? node.inputs : {};
    const title =
      node._meta && typeof node._meta.title === 'string' && node._meta.title.trim()
        ? node._meta.title.trim()
        : null;
    nodes.set(String(id), { id: String(id), type, inputs, title });
  }
  return nodes;
}

function linkTarget(value, nodes) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const id = String(value[0]);
  return nodes.has(id) ? id : null;
}

const VALUE_KEYS = [
  'value', 'int', 'float', 'string', 'text', 'steps', 'steps_total', 'cfg',
  'sampler_name', 'scheduler', 'seed', 'noise_seed', 'width', 'height',
  'ckpt_name', 'lora_name', 'unet_name', 'model_name', 'denoise',
  'start_at_step', 'end_at_step',
];

function resolveValue(nodes, nodeId, inputName, depth, seen) {
  const d = depth || 0;
  const s = seen || new Set();
  if (d > MAX_DEPTH) return null;
  const node = nodes.get(nodeId);
  if (!node || !(inputName in node.inputs)) return null;
  const raw = node.inputs[inputName];

  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'string') return raw;

  if (Array.isArray(raw)) {
    const target = linkTarget(raw, nodes);
    if (!target) return scalarOf(raw);
    const key = target + '#' + d;
    if (s.has(key)) return null;
    s.add(key);
    return resolveNodeOutput(nodes, target, d + 1, s);
  }
  return scalarOf(raw);
}

function resolveNodeOutput(nodes, nodeId, depth, seen) {
  const d = depth || 0;
  const s = seen || new Set();
  if (d > MAX_DEPTH) return null;
  const node = nodes.get(nodeId);
  if (!node) return null;
  for (const k of VALUE_KEYS) {
    if (!(k in node.inputs)) continue;
    const v = resolveValue(nodes, nodeId, k, d, s);
    if (v !== null && v !== undefined && !(typeof v === 'string' && !v.trim())) return v;
  }
  for (const k of Object.keys(node.inputs)) {
    const v = resolveValue(nodes, nodeId, k, d, s);
    if (v !== null && v !== undefined && !(typeof v === 'string' && !v.trim())) return v;
  }
  return null;
}

/** 沿 inputPath 反向走链路,返回途经节点(近 -> 远) */
function walkBack(nodes, startNodeId, inputPath, depth, out, seen) {
  const d = depth || 0;
  const o = out || [];
  const s = seen || new Set();
  if (d > MAX_DEPTH) return o;
  const node = nodes.get(startNodeId);
  if (!node || !(inputPath in node.inputs)) return o;
  const target = linkTarget(node.inputs[inputPath], nodes);
  if (!target) return o;
  const key = startNodeId + '>' + inputPath + '>' + target;
  if (s.has(key)) return o;
  s.add(key);
  const t = nodes.get(target);
  if (!t) return o;
  o.push(t);
  for (const next of [inputPath, 'model', 'MODEL', 'model1', 'model2', 'clip', 'text', 'string']) {
    if (next in t.inputs && linkTarget(t.inputs[next], nodes)) {
      walkBack(nodes, target, next, d + 1, o, s);
    }
  }
  return o;
}

/** 只读节点自身的字面量输入,不跟随链接 */
function literalInput(node, name) {
  if (!node || !(name in node.inputs)) return null;
  const raw = node.inputs[name];
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  if (Array.isArray(raw)) {
    for (const x of raw) if (typeof x === 'string' && x.trim()) return x;
  }
  return null;
}

/**
 * 沿某输入的链接上游收集所有字符串候选。
 *
 * 为什么需要:rgthree 的转发链有几十层,普通"取第一个能解析出的值"会被带偏
 * (实测解析成步数 "30")。改成收集候选池再筛,能让真正的采样器名活下来。
 */
function collectUpstreamCandidates(nodes, startId, inputName, depth, out, seen) {
  const d = depth || 0;
  const o = out || [];
  const s = seen || new Set();
  if (d > MAX_DEPTH) return o;
  const node = nodes.get(startId);
  if (!node || !(inputName in node.inputs)) return o;
  const raw = node.inputs[inputName];

  if (typeof raw === 'string' && raw.trim()) o.push(raw);
  else if (typeof raw === 'number') o.push(raw);

  const target = linkTarget(raw, nodes);
  if (target && !s.has(target)) {
    s.add(target);
    const t = nodes.get(target);
    if (t) {
      for (const k of Object.keys(t.inputs)) {
        collectUpstreamCandidates(nodes, target, k, d + 1, o, s);
      }
    }
  }
  return o;
}

// ================================================================ 字段抽取

function extractSampler(nodes, node) {
  const pick = (name) => {
    const names = name === 'seed' ? ['seed', 'noise_seed'] : [name];
    for (const n of names) {
      if (n in node.inputs) {
        const v = resolveValue(nodes, node.id, n, 0, new Set());
        if (v !== null && v !== undefined) return v;
      }
    }
    return null;
  };

  const fromCandidates = (inputName, validator) => {
    for (const c of collectUpstreamCandidates(nodes, node.id, inputName, 0, [], new Set())) {
      const v = validator(c);
      if (v) return v;
    }
    return null;
  };

  const samplerName =
    plausibleSampler(pick('sampler_name')) ||
    plausibleSampler(literalInput(node, 'sampler_name')) ||
    fromCandidates('sampler_name', plausibleSampler);
  const scheduler =
    plausibleScheduler(pick('scheduler')) ||
    plausibleScheduler(literalInput(node, 'scheduler')) ||
    fromCandidates('scheduler', plausibleScheduler);

  const s = {
    seed: num(pick('seed')),
    steps: num(pick('steps')),
    cfg: num(pick('cfg')),
    samplerName,
    scheduler,
    denoise: num(pick('denoise')),
    startAtStep: num(pick('start_at_step')),
    endAtStep: num(pick('end_at_step')),
    nodeId: node.id,
    nodeType: node.type,
  };

  // 步数与 CFG 也要做合理性校验,防止转发错位
  if (s.steps !== null && (s.steps <= 0 || s.steps > 500 || !Number.isInteger(s.steps))) s.steps = null;
  if (s.cfg !== null && (s.cfg < 0 || s.cfg > 100)) s.cfg = null;
  if (s.seed !== null && (!Number.isInteger(s.seed) || s.seed < 0)) s.seed = null;

  const meaningful = [
    s.seed !== null, s.steps !== null, s.cfg !== null,
    s.samplerName !== null, s.scheduler !== null,
  ].filter(Boolean).length;
  return meaningful >= 2 ? s : null;
}

function extractModel(nodes, samplerNodeId) {
  const found = [];
  const collect = (n) => {
    const v =
      str(resolveValue(nodes, n.id, 'ckpt_name', 0, new Set())) ||
      str(resolveValue(nodes, n.id, 'unet_name', 0, new Set())) ||
      str(resolveValue(nodes, n.id, 'model_name', 0, new Set())) ||
      str(resolveValue(nodes, n.id, 'model_path', 0, new Set()));
    if (v && !/\.(pth|pt)$/i.test(v)) found.push({ v, t: n.type });
  };

  if (samplerNodeId) {
    for (const n of walkBack(nodes, samplerNodeId, 'model', 0, [], new Set())) {
      if (CHECKPOINT_TYPES.test(n.type)) collect(n);
    }
  }
  if (found.length === 0) {
    for (const n of nodes.values()) if (CHECKPOINT_TYPES.test(n.type)) collect(n);
  }
  if (found.length === 0) return { modelName: null, modelNodeType: null };
  const chosen = found[found.length - 1];
  return { modelName: chosen.v, modelNodeType: chosen.t };
}

function extractLoras(nodes) {
  const out = [];
  for (const n of nodes.values()) {
    if (!LORA_TYPES.test(n.type)) continue;
    const name = str(resolveValue(nodes, n.id, 'lora_name', 0, new Set()));
    if (!name) continue;
    const sm = num(resolveValue(nodes, n.id, 'strength_model', 0, new Set()));
    const sc = num(resolveValue(nodes, n.id, 'strength_clip', 0, new Set()));
    if (out.some((x) => x.name === name && x.strengthModel === sm && x.strengthClip === sc)) continue;
    out.push({ name, strengthModel: sm, strengthClip: sc, nodeId: n.id });
  }
  return out;
}

function extractControlNets(nodes) {
  const out = [];
  for (const n of nodes.values()) {
    if (!CONTROLNET_TYPES.test(n.type)) continue;
    const name =
      str(resolveValue(nodes, n.id, 'control_net_name', 0, new Set())) ||
      str(resolveValue(nodes, n.id, 'control_net', 0, new Set()));
    if (!name) continue;
    const strength = num(resolveValue(nodes, n.id, 'strength', 0, new Set()));
    if (out.some((x) => x.name === name)) continue;
    out.push({ name, strength, nodeId: n.id });
  }
  return out;
}

function extractPromptsFromGraph(nodes) {
  const texts = [];
  for (const n of nodes.values()) {
    if (!TEXT_TYPES.test(n.type)) continue;
    const v = str(resolveValue(nodes, n.id, 'text', 0, new Set()));
    if (!v || !v.trim()) continue;
    if (texts.some((t) => t.text === v)) continue;
    texts.push({ text: v, encoders: [n.type], nodeId: n.id });
  }

  // 优先用采样器的 positive/negative 输入回溯定位,比关键词猜测可靠
  const posIds = new Set();
  const negIds = new Set();
  for (const n of nodes.values()) {
    if (!SAMPLER_TYPES.test(n.type)) continue;
    for (const pair of [['pos', 'positive'], ['neg', 'negative']]) {
      for (const t of walkBack(nodes, n.id, pair[1], 0, [], new Set())) {
        if (TEXT_TYPES.test(t.type)) (pair[0] === 'pos' ? posIds : negIds).add(t.id);
      }
    }
  }

  const out = [];
  for (const t of texts) {
    let role;
    if (posIds.has(t.nodeId) && !negIds.has(t.nodeId)) role = 'positive';
    else if (negIds.has(t.nodeId) && !posIds.has(t.nodeId)) role = 'negative';
    else {
      const low = t.text.toLowerCase();
      role = NEGATIVE_HINTS.some((h) => low.includes(h)) && t.text.length < 2000 ? 'negative' : 'positive';
    }
    out.push({ role, text: t.text, encoders: t.encoders });
  }
  return out.sort((a, b) => (a.role === b.role ? 0 : a.role === 'positive' ? -1 : 1));
}

function extractLatentSize(nodes) {
  for (const n of nodes.values()) {
    if (!LATENT_TYPES.test(n.type)) continue;
    const w = num(resolveValue(nodes, n.id, 'width', 0, new Set()));
    const h = num(resolveValue(nodes, n.id, 'height', 0, new Set()));
    if (w && h && w > 0 && h > 0) return { width: w, height: h };
  }
  return null;
}

// ================================================================ F1 / F2

function parseGraph(graph, dimensions, rawJson) {
  const nodes = indexGraph(graph);
  const allSamplers = [];
  for (const n of nodes.values()) {
    if (!SAMPLER_TYPES.test(n.type)) continue;
    const s = extractSampler(nodes, n);
    if (s) allSamplers.push(s);
  }

  const score = (s) =>
    [s.steps, s.cfg, s.samplerName, s.scheduler, s.seed].filter((x) => x !== null).length;

  let sampler = null;
  if (allSamplers.length) {
    // 多段采样(hires/分步)时优先取 end_at_step 有效的那段,否则取参数最全的
    const staged = allSamplers.filter((s) => s.endAtStep !== null && s.endAtStep < 10000);
    sampler = (staged.length ? staged : allSamplers).reduce((best, cur) => {
      if (!best) return cur;
      const bs = score(best);
      const cs = score(cur);
      if (cs !== bs) return cs > bs ? cur : best;
      return (cur.endAtStep || 0) > (best.endAtStep || 0) ? cur : best;
    }, null);
  }

  const model = extractModel(nodes, sampler ? sampler.nodeId : null);
  const loras = extractLoras(nodes);
  const controlNets = extractControlNets(nodes);
  const prompts = extractPromptsFromGraph(nodes);
  const nodeTypes = [...new Set([...nodes.values()].map((n) => n.type).filter(Boolean))];

  let source = 'comfyui';
  if (!sampler && !model.modelName && prompts.length === 0) source = 'comfyui-partial';

  return {
    source,
    modelName: model.modelName,
    modelNodeType: model.modelNodeType,
    loras,
    controlNets,
    sampler,
    allSamplers,
    prompts,
    nodeTypes,
    nodeCount: nodes.size,
    customNodeHints: nodeTypes.filter((t) => !isCoreNode(t)),
    rawPromptJson: rawJson,
  };
}

// ================================================================ F3 A1111

const A1111_KEYS = [
  'Steps', 'Sampler', 'Schedule type', 'Scheduler', 'CFG scale', 'Seed', 'Size',
  'Model hash', 'Model', 'VAE', 'VAE hash', 'Clip skip', 'Hashes',
  'Denoising strength', 'Version', 'Civitai resources', 'Civitai metadata',
  'Lora hashes', 'TI hashes', 'Face restoration', 'Variation seed',
  'Variation seed strength', 'Hires upscale', 'Hires steps', 'Hires upscaler',
  'Distilled CFG Scale', 'Eta', 'Fisher strength',
];
// 长的排前面,避免 "Model" 抢先匹配到 "Model hash"
const A1111_KEY_RE = new RegExp(
  '(?:^|, )(' + [...A1111_KEYS].sort((a, b) => b.length - a.length).join('|') + '): ',
  'g'
);

function parseA1111MetaLine(line) {
  const hits = [];
  A1111_KEY_RE.lastIndex = 0;
  let m;
  while ((m = A1111_KEY_RE.exec(line)) !== null) {
    hits.push({ key: m[1], start: m.index, valueStart: m.index + m[0].length });
  }
  const out = {};
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].start : line.length;
    out[hits[i].key] = line.slice(hits[i].valueStart, end).replace(/, $/, '').trim();
  }
  return out;
}

/**
 * 解析 A1111 风格参数块。
 *
 * 实测结构 —— 注意负提示词在参数行之后:
 *   正提示词
 *   Negative prompt: 负提示词
 *   Steps: 30, Sampler: ..., CFG scale: 4.0, ..., Civitai resources: [...]
 * 任何"按行切分"的朴素解析都会把负提示词当参数吞掉。
 */
function parseA1111(raw, dimensions) {
  const meta = {
    source: 'a1111',
    modelName: null,
    modelNodeType: null,
    loras: [],
    controlNets: [],
    sampler: null,
    allSamplers: [],
    prompts: [],
    nodeTypes: [],
    nodeCount: 0,
    customNodeHints: [],
    rawPromptJson: raw,
  };

  // 1) 找参数尾行起点:以 "Steps: " 开头且处于段落边界,取最后一个
  let metaStart = -1;
  const stepRe = /(?:^|\n)Steps: /g;
  let sm;
  while ((sm = stepRe.exec(raw)) !== null) {
    metaStart = sm.index + (sm[0].startsWith('\n') ? 1 : 0);
  }
  if (metaStart < 0) {
    const anyRe = /(?:^|\n)([A-Z][A-Za-z ]*): /g;
    while ((sm = anyRe.exec(raw)) !== null) metaStart = sm.index + 1;
  }
  const promptPart = metaStart >= 0 ? raw.slice(0, metaStart) : raw;
  const metaLine = metaStart >= 0 ? raw.slice(metaStart) : '';
  const params = parseA1111MetaLine(metaLine);

  // 2) 正 / 负提示词
  const negIdx = promptPart.indexOf('Negative prompt:');
  let posText = promptPart;
  let negText = '';
  if (negIdx >= 0) {
    posText = promptPart.slice(0, negIdx);
    negText = promptPart.slice(negIdx + 'Negative prompt:'.length);
  }
  posText = posText.replace(/[\n,]+$/, '').trim();
  negText = negText.replace(/[\n,]+$/, '').trim();

  // 3) 从提示词抽 <lora:名字:权重>
  const loraRe = /<lora:([^:>]+):([-\d.]+)(?::([-\d.]+))?>/gi;
  for (const m of posText.matchAll(loraRe)) {
    meta.loras.push({
      name: m[1],
      strengthModel: Number(m[2]),
      strengthClip: m[3] !== undefined ? Number(m[3]) : null,
      nodeId: 'a1111',
    });
  }
  const cleanPos = posText
    .replace(loraRe, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/,\s*,/g, ',')
    .replace(/[\n,]+$/, '')
    .trim();
  if (cleanPos) meta.prompts.push({ role: 'positive', text: cleanPos, encoders: ['A1111'] });
  if (negText) meta.prompts.push({ role: 'negative', text: negText, encoders: ['A1111'] });

  // 4) 采样参数
  const steps = num(params['Steps']);
  const cfg = num(params['CFG scale']);
  const seed = num(params['Seed']);
  let reqW = null;
  let reqH = null;
  const sizeRaw = params['Size'];
  if (sizeRaw) {
    const mm = sizeRaw.match(/(\d+)\s*x\s*(\d+)/);
    if (mm) {
      reqW = Number(mm[1]);
      reqH = Number(mm[2]);
    }
  }

  // "linear/euler simple" = 调度器/采样器 + 空格后缀版调度器
  let samplerName = params['Sampler'] || null;
  let scheduler = params['Schedule type'] || params['Scheduler'] || null;
  if (samplerName) {
    if (samplerName.includes('/')) {
      const parts = samplerName.split('/');
      if (!scheduler) scheduler = parts[0].trim();
      samplerName = parts[1].trim();
    }
    const parts = samplerName.split(' ');
    if (parts.length >= 2) {
      const last = parts[parts.length - 1].toLowerCase();
      if (SCHEDULER_LOOKUP.has(last) || SCHEDULER_WORDS.some((w) => last.startsWith(w))) {
        if (!scheduler) scheduler = last;
        samplerName = parts.slice(0, -1).join(' ').trim();
        const p2 = samplerName.split(' ');
        if (p2.length >= 2 && SCHEDULER_WORDS.some((w) => p2[p2.length - 1].toLowerCase().startsWith(w))) {
          samplerName = p2.slice(0, -1).join(' ').trim();
        }
      }
    }
  }

  meta.sampler = {
    seed,
    steps,
    cfg,
    samplerName: samplerName || null,
    scheduler: scheduler || null,
    denoise: num(params['Denoising strength']),
    startAtStep: null,
    endAtStep: null,
    nodeId: 'a1111',
    nodeType: 'A1111-parameters',
  };
  if ([seed, steps, cfg, samplerName].every((x) => x === null)) meta.sampler = null;
  meta.allSamplers = meta.sampler ? [meta.sampler] : [];

  // 5) 模型。Model: 是显示名,Model hash 只是哈希
  if (params['Model']) {
    meta.modelName = params['Model'];
    meta.modelNodeType = 'A1111-Model';
  }
  const civ = params['Civitai resources'];
  if (civ) {
    try {
      const arr = JSON.parse(civ);
      if (Array.isArray(arr)) {
        const ckpt = arr.find((r) => r && typeof r.air === 'string' && r.air.includes(':checkpoint:'));
        if (ckpt && ckpt.versionName && !meta.modelName) meta.modelName = ckpt.versionName;
      }
    } catch {
      /* 忽略 */
    }
  }

  // 6) 请求尺寸 vs 实际输出尺寸
  if (dimensions && reqW && reqH && (dimensions.width !== reqW || dimensions.height !== reqH)) {
    meta.customNodeHints = [
      '请求尺寸 ' + reqW + 'x' + reqH + ',实际输出 ' + dimensions.width + 'x' + dimensions.height + '(经过放大处理)',
    ];
  }

  return meta;
}

// ================================================================ F5 UI 工作流

function samplerFromWidgets(widgets) {
  if (!Array.isArray(widgets) || widgets.length < 4) return null;
  for (let i = 0; i < widgets.length; i++) {
    if (!looksLikeSamplerString(widgets[i])) continue;
    const schedIdx = i + 1;
    if (schedIdx >= widgets.length || !looksLikeSchedulerString(widgets[schedIdx])) continue;

    // 往前找紧邻的数字:排列是 [..., steps, cfg, sampler, scheduler, ...]
    const nums = [];
    for (let k = i - 1; k >= 0 && nums.length < 3; k--) {
      if (typeof widgets[k] === 'number' && Number.isFinite(widgets[k])) nums.push(widgets[k]);
      else break;
    }
    let steps = null;
    let cfg = null;
    let seed = null;
    if (nums.length >= 2) {
      const a = nums[0];
      const b = nums[1];
      if (a >= 0 && a <= 100 && b >= 1 && b <= 500 && Number.isInteger(b)) {
        cfg = a;
        steps = b;
      } else if (b >= 0 && b <= 100 && a >= 1 && a <= 500 && Number.isInteger(a)) {
        cfg = b;
        steps = a;
      }
    }
    if (nums.length >= 3 && Number.isInteger(nums[2]) && nums[2] >= 0) seed = nums[2];
    if (steps === null && cfg === null) continue;

    return {
      seed: seed !== null && Number.isInteger(seed) && seed >= 0 ? seed : null,
      steps: steps !== null && Number.isInteger(steps) && steps > 0 && steps <= 500 ? steps : null,
      cfg: cfg !== null && cfg >= 0 && cfg <= 100 ? cfg : null,
      samplerName: plausibleSampler(widgets[i]),
      scheduler: plausibleScheduler(widgets[schedIdx]),
      denoise: null,
      startAtStep: null,
      endAtStep: null,
      nodeId: 'ui-workflow',
      nodeType: 'UI-workflow-widgets',
    };
  }
  return null;
}

function parseUiWorkflow(wf, rawJson) {
  const nodes = Array.isArray(wf.nodes) ? wf.nodes : [];
  const meta = {
    source: 'comfyui',
    modelName: null,
    modelNodeType: null,
    loras: [],
    controlNets: [],
    sampler: null,
    allSamplers: [],
    prompts: [],
    nodeTypes: [],
    nodeCount: nodes.length,
    customNodeHints: [],
    rawPromptJson: rawJson,
  };

  const SKIP_TYPES = new Set([
    'GetNode', 'SetNode', 'Reroute', 'Note', 'MarkdownNote',
    'GroupIsEnabled', 'PrimitiveNode',
  ]);
  const typeCount = new Map();
  for (const n of nodes) {
    const t = String(n.type || '');
    if (!t || SKIP_TYPES.has(t)) continue;
    typeCount.set(t, (typeCount.get(t) || 0) + 1);
  }
  meta.nodeTypes = [...typeCount.keys()];

  const samplers = [];
  for (const n of nodes) {
    const s = samplerFromWidgets(n.widgets_values);
    if (!s) continue;
    s.nodeType = String(n.type || 'UI-workflow');
    s.nodeId = String(n.id === undefined ? '' : n.id);
    samplers.push(s);
  }
  meta.allSamplers = samplers;
  if (samplers.length) {
    meta.sampler = samplers.reduce((best, cur) => {
      if (!best) return cur;
      const bs = best.steps === null ? -1 : best.steps;
      const cs = cur.steps === null ? -1 : cur.steps;
      if (cs !== bs) return cs > bs ? cur : best;
      return best;
    }, null);
  }

  const modelCands = [];
  for (const n of nodes) {
    const t = String(n.type || '');
    if (!CHECKPOINT_TYPES.test(t)) continue;
    const w = n.widgets_values;
    if (!Array.isArray(w)) continue;
    const v = w.find((x) => typeof x === 'string' && /\.(safetensors|ckpt|sft|gguf)$/i.test(x));
    if (v) modelCands.push({ v, t });
  }
  if (modelCands.length) {
    const c = modelCands[modelCands.length - 1];
    meta.modelName = c.v;
    meta.modelNodeType = c.t;
  }

  for (const n of nodes) {
    if (!LORA_TYPES.test(String(n.type || ''))) continue;
    const w = n.widgets_values;
    if (!Array.isArray(w)) continue;
    const name = w.find((x) => typeof x === 'string' && /\.(safetensors|ckpt|sft)$/i.test(x));
    if (!name) continue;
    if (meta.loras.some((l) => l.name === name)) continue;
    const idx = w.indexOf(name);
    meta.loras.push({
      name,
      strengthModel: typeof w[idx + 1] === 'number' ? w[idx + 1] : null,
      strengthClip: typeof w[idx + 2] === 'number' ? w[idx + 2] : null,
      nodeId: String(n.id === undefined ? '' : n.id),
    });
  }

  for (const n of nodes) {
    if (!TEXT_TYPES.test(String(n.type || ''))) continue;
    const w = n.widgets_values;
    if (!Array.isArray(w)) continue;
    const v = w.find((x) => typeof x === 'string' && x.trim().length > 0);
    if (!v) continue;
    if (meta.prompts.some((p) => p.text === v)) continue;
    const low = v.toLowerCase();
    const isNeg = NEGATIVE_HINTS.some((h) => low.includes(h)) && v.length < 2000;
    meta.prompts.push({ role: isNeg ? 'negative' : 'positive', text: v, encoders: [String(n.type || '')] });
  }
  meta.prompts.sort((a, b) => (a.role === b.role ? 0 : a.role === 'positive' ? -1 : 1));

  meta.customNodeHints = meta.nodeTypes.filter((t) => !isCoreNode(t));
  if (!meta.sampler && !meta.modelName && meta.prompts.length === 0) meta.source = 'comfyui-partial';
  return meta;
}

// ================================================================ 主入口

// ================================================================ F6 NovelAI
//
// 实测(2695 张 NovelAI 图)元数据布局:
//   Description  正提示词(纯文本,逗号分隔)
//   Software     "NovelAI"
//   Source       模型名,如 "NovelAI Diffusion V4.5 4BDE2A90"(末尾是权重哈希)
//   Comment      生成参数 JSON:prompt / uc / steps / sampler / scale / seed /
//                noise_schedule / width / height / v4_prompt ...
// 注意:NAI 没有 ComfyUI 那种节点图,也没有独立的"调度器"字段,
//      噪声调度在 noise_schedule 里(常见 karras),缺了就按未记录显示。
function parseNovelAI(text) {
  const meta = emptyMeta();
  meta.source = 'novelai';
  const raw = text['Comment'] || '';
  const parsed = raw ? parseJsonLenient(raw) : null;
  const json = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};

  // "NovelAI Diffusion V4.5 4BDE2A90" → "NovelAI Diffusion V4.5"
  const src = typeof text['Source'] === 'string' ? text['Source'] : '';
  const modelName = src.replace(/\s+[0-9a-f]{6,}$/i, '').trim();
  meta.modelName = modelName || null;

  const positive =
    typeof json.prompt === 'string' && json.prompt.trim()
      ? json.prompt
      : typeof text['Description'] === 'string'
        ? text['Description']
        : '';
  const negative = typeof json.uc === 'string' ? json.uc : '';
  if (positive.trim()) meta.prompts.push({ role: 'positive', text: positive.trim() });
  if (negative.trim()) meta.prompts.push({ role: 'negative', text: negative.trim() });

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const sampler = {
    seed: num(json.seed),
    steps: num(json.steps),
    cfg: num(json.scale),
    samplerName: typeof json.sampler === 'string' ? json.sampler : null,
    scheduler: typeof json.noise_schedule === 'string' ? json.noise_schedule : null,
  };
  meta.sampler = sampler;
  meta.allSamplers = [sampler];
  meta.nodeCount = 0;
  meta.rawPromptJson = raw || null;
  return meta;
}

function emptyMeta() {
  return {
    source: 'unknown',
    modelName: null,
    modelNodeType: null,
    loras: [],
    controlNets: [],
    sampler: null,
    allSamplers: [],
    prompts: [],
    nodeTypes: [],
    nodeCount: 0,
    customNodeHints: [],
    rawPromptJson: null,
  };
}

/**
 * @param {string} filePath
 * @param {{keepRaw?: boolean, reader?: object}} [opts]
 */
function extractFromPng(filePath, opts) {
  const options = opts || {};
  const readPng = (options.reader || require('./png-reader.cjs')).readPng;
  // keepRaw=true 时保留原始元数据块。默认关闭:单张图的 prompt 块可达 87KB、
  // workflow 块可达 1.6MB,8061 张全存会把索引库撑到几个 GB。
  // 详情页按需重读源文件即可,源图本来就在本地。
  const keepRaw = options.keepRaw === true;

  const read = readPng(
    filePath,
    new Set(['prompt', 'parameters', 'Comment', 'Description', 'Software', 'Source', 'workflow'])
  );
  const dimensions = read.dimensions;
  const text = read.text;

  // ---- F1 / F2: prompt 块是节点图 ----
  const promptRaw = text['prompt'];
  if (promptRaw) {
    const parsed = parseJsonLenient(promptRaw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      let graph = parsed;
      if (parsed.prompt && typeof parsed.prompt === 'object' && !Array.isArray(parsed.prompt)) {
        graph = parsed.prompt;
      }
      const looksLikeGraph = Object.values(graph).some(
        (v) => v && typeof v === 'object' && typeof v.class_type === 'string'
      );
      if (looksLikeGraph) {
        return { dimensions, meta: parseGraph(graph, dimensions, keepRaw ? promptRaw : null) };
      }
    }
    // prompt 块里其实是 A1111 文本
    if (/Steps: |Sampler: /.test(promptRaw)) {
      return { dimensions, meta: parseA1111(promptRaw, dimensions) };
    }
    return {
      dimensions,
      meta: Object.assign(emptyMeta(), {
        source: 'comfyui-partial',
        rawPromptJson: keepRaw ? promptRaw : null,
      }),
    };
  }

  // ---- F3: parameters 文本块 ----
  const a1111 = text['parameters'];
  if (a1111) return { dimensions, meta: parseA1111(a1111, dimensions) };

  // ---- F5: 只有 workflow 块(UI 格式) ----
  const wfRaw = text['workflow'];
  if (wfRaw) {
    const wf = parseJsonLenient(wfRaw);
    const inner =
      wf && typeof wf === 'object' && wf.workflow && Array.isArray(wf.workflow.nodes)
        ? wf.workflow
        : wf;
    if (inner && Array.isArray(inner.nodes) && inner.nodes.length > 0) {
      return { dimensions, meta: parseUiWorkflow(inner, keepRaw ? wfRaw : null) };
    }
    return {
      dimensions,
      meta: Object.assign(emptyMeta(), {
        source: 'comfyui-partial',
        rawPromptJson: keepRaw ? wfRaw : null,
      }),
    };
  }

  // ---- NovelAI / 其它 ----
  const markers = [text['Comment'], text['Description'], text['Software']].filter(Boolean).join(' ');
  if (markers) {
    const isNai = /novelai/i.test(markers) || text['Software'] === 'NovelAI';
    if (isNai) {
      const meta = parseNovelAI(text);
      if (!keepRaw) meta.rawPromptJson = null;
      return { dimensions, meta };
    }
    return {
      dimensions,
      meta: Object.assign(emptyMeta(), {
        source: 'unknown',
        rawPromptJson: keepRaw ? text['Comment'] || null : null,
      }),
    };
  }

  // ---- F4: 无文本块 ----
  return { dimensions, meta: emptyMeta() };
}

module.exports = {
  extractFromPng,
  parseNovelAI,
  parseA1111,
  parseGraph,
  parseUiWorkflow,
  parseJsonLenient,
  indexGraph,
  resolveValue,
  walkBack,
  extractSampler,
  extractModel,
  extractLoras,
  extractPromptsFromGraph,
};
