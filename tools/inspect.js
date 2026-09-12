#!/usr/bin/env node
/**
 * 鍏冩暟鎹煡鐪嬪櫒 鈥斺€?鍛戒护琛岄獙璐у伐鍏枫€? *
 * 鐢ㄦ硶:
 *   node tools/inspect.js <鍥剧墖璺緞>             # 鐪嬪崟寮? *   node tools/inspect.js <鐩綍> --limit 5       # 鎶芥牱鐪嬬洰褰? *   node tools/inspect.js <鐩綍> --json          # 杈撳嚭鏈哄櫒鍙 JSON
 *   node tools/inspect.js <鐩綍> --stat          # 鍙嚭瑕嗙洊鐜囩粺璁? */

const fs = require('fs');
const path = require('path');
const { extractFromPng } = require('./comfy-parser.cjs');

function walk(dir, out = [], limit = Infinity) {
  if (out.length >= limit) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= limit) break;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, limit);
    else if (/\.png$/i.test(e.name)) out.push(p);
  }
  return out;
}

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(2)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

function val(v, unit = '') {
  return v === null || v === undefined ? `${C.dim}鏈褰?{C.reset}` : `${C.bold}${v}${unit}${C.reset}`;
}

function printOne(file, result) {
  const { dimensions, meta } = result;
  const stat = fs.statSync(file);
  const tags = {
    a1111: `${C.magenta}A1111 鏂囨湰${C.reset}`,
    comfyui: `${C.green}ComfyUI 鑺傜偣鍥?{C.reset}`,
    'comfyui-partial': `${C.yellow}ComfyUI 娈嬬己${C.reset}`,
    novelai: `${C.cyan}NovelAI${C.reset}`,
    unknown: `${C.red}鏃犲厓鏁版嵁${C.reset}`,
  };

  console.log(`\n${C.bold}${path.basename(file)}${C.reset}`);
  console.log(`  ${C.dim}${path.dirname(file)}${C.reset}`);
  console.log(`  鏍煎紡        ${tags[meta.source] || meta.source}`);
  console.log(`  鏂囦欢澶у皬    ${fmtBytes(stat.size)}`);
  console.log(`  淇敼鏃堕棿    ${new Date(stat.mtime).toLocaleString()}`);
  console.log(`  鍍忕礌灏哄    ${dimensions ? `${C.bold}${dimensions.width} 脳 ${dimensions.height}${C.reset}` : '璇诲彇澶辫触'}`);

  if (meta.sampler) {
    const s = meta.sampler;
    console.log(`  ${C.dim}鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ 閲囨牱鍙傛暟 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€${C.reset}`);
    console.log(`  妯″瀷        ${val(meta.modelName)}`);
    console.log(`  閲囨牱鍣?     ${val(s.samplerName)}`);
    console.log(`  璋冨害鍣?     ${val(s.scheduler)}`);
    console.log(`  姝ユ暟        ${val(s.steps)}`);
    console.log(`  CFG         ${val(s.cfg)}`);
    console.log(`  seed        ${val(s.seed)}`);
    if (s.denoise !== null && s.denoise !== undefined && s.denoise !== 1) console.log(`  denoise     ${val(s.denoise)}`);
    if (s.startAtStep !== null && s.startAtStep !== undefined) console.log(`  璧峰姝?     ${val(s.startAtStep)}`);
    if (s.endAtStep !== null && s.endAtStep !== undefined && s.endAtStep < 10000) console.log(`  缁撴潫姝?     ${val(s.endAtStep)}`);
    if (meta.allSamplers.length > 1) {
      console.log(`  ${C.dim}(璇ュ伐浣滄祦鍏?${meta.allSamplers.length} 涓噰鏍峰櫒,浠ヤ笂涓烘渶缁堜竴娈?${C.reset}`);
    }
  } else if (meta.source === 'novelai' || meta.source === 'unknown') {
    console.log(`  ${C.dim}鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ 鍙傛暟 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€${C.reset}`);
    console.log(`  ${C.yellow}璇ュ浘鏈祵鍏ョ敓鎴愬弬鏁?{C.reset}(鍏冩暟鎹涓婃父宸ュ叿鍓ョ)`);
  }

  if (meta.loras.length) {
    console.log(`  ${C.dim}鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ LoRA (${meta.loras.length}) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€${C.reset}`);
    for (const l of meta.loras.slice(0, 15)) {
      const sm = l.strengthModel !== null ? l.strengthModel : '?';
      const sc = l.strengthClip !== null && l.strengthClip !== l.strengthModel ? ` / clip ${l.strengthClip}` : '';
      console.log(`  路 ${l.name}  ${C.cyan}${sm}${sc}${C.reset}`);
    }
    if (meta.loras.length > 15) console.log(`  ${C.dim}... 鍙︽湁 ${meta.loras.length - 15} 涓?{C.reset}`);
  }

  if (meta.controlNets.length) {
    console.log(`  ${C.dim}鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ ControlNet (${meta.controlNets.length}) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€${C.reset}`);
    for (const c of meta.controlNets) console.log(`  路 ${c.name}  ${c.strength ?? '?'}`);
  }

  for (const p of meta.prompts) {
    const label = p.role === 'positive' ? `${C.green}姝ｅ悜鎻愮ず璇?{C.reset}` : `${C.red}璐熷悜鎻愮ず璇?{C.reset}`;
    console.log(`  ${C.dim}鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ ${label} ${C.dim}(${p.text.length} 瀛楃, ${p.encoders.join('/')})${C.reset}`);
    const text = p.text.length > 600 ? p.text.slice(0, 600) + `\n  ${C.dim}...[鎴柇,瀹屾暣 ${p.text.length} 瀛楃]${C.reset}` : p.text;
    console.log('  ' + text.split('\n').join('\n  '));
  }

  if (meta.customNodeHints?.length && meta.source !== 'a1111') {
    console.log(`  ${C.dim}鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ 鎻愮ず 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€${C.reset}`);
    for (const h of meta.customNodeHints.slice(0, 8)) console.log(`  ${C.yellow}路${C.reset} ${h}`);
  }

  if (meta.nodeCount) {
    console.log(`  ${C.dim}鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ 宸ヤ綔娴?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€${C.reset}`);
    console.log(`  鑺傜偣鏁?     ${meta.nodeCount}`);
    console.log(`  鑺傜偣绫诲瀷    ${meta.nodeTypes.length} 绉峘);
  }
}

function printStat(files) {
  const s = {
    total: 0, err: 0, dims: 0, model: 0, steps: 0, cfg: 0, seed: 0,
    sampler: 0, scheduler: 0, pos: 0, neg: 0, loraFiles: 0, loraCount: 0,
    multi: 0, bySource: {}, bytes: 0,
  };
  const t0 = Date.now();
  for (const f of files) {
    s.total++;
    try { s.bytes += fs.statSync(f).size; } catch {}
    let r;
    try { r = extractFromPng(f); } catch { s.err++; continue; }
    const m = r.meta;
    s.bySource[m.source] = (s.bySource[m.source] || 0) + 1;
    if (r.dimensions) s.dims++;
    if (m.modelName) s.model++;
    if (m.sampler) {
      const x = m.sampler;
      if (x.steps !== null) s.steps++;
      if (x.cfg !== null) s.cfg++;
      if (x.seed !== null) s.seed++;
      if (x.samplerName) s.sampler++;
      if (x.scheduler) s.scheduler++;
    }
    if (m.prompts.some((p) => p.role === 'positive')) s.pos++;
    if (m.prompts.some((p) => p.role === 'negative')) s.neg++;
    if (m.loras.length) { s.loraFiles++; s.loraCount += m.loras.length; }
    if (m.allSamplers.length > 1) s.multi++;
  }
  const dt = (Date.now() - t0) / 1000;
  const pct = (n) => `${String(n).padStart(6)}  ${(n / s.total * 100).toFixed(1)}%`;

  console.log(`\n${C.bold}=== 瑕嗙洊鐜囩粺璁?===${C.reset}`);
  console.log(`鏂囦欢鎬绘暟        ${s.total}   (${fmtBytes(s.bytes)})`);
  console.log(`瑙ｆ瀽寮傚父        ${s.err}`);
  console.log(`\n${C.dim}鏍煎紡鍒嗗竷${C.reset}`);
  for (const [k, v] of Object.entries(s.bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(18)} ${pct(v)}`);
  }
  console.log(`\n${C.dim}瀛楁瑕嗙洊${C.reset}`);
  console.log(`  鍍忕礌灏哄        ${pct(s.dims)}`);
  console.log(`  妯″瀷鍚?         ${pct(s.model)}`);
  console.log(`  姝ユ暟            ${pct(s.steps)}`);
  console.log(`  CFG             ${pct(s.cfg)}`);
  console.log(`  seed            ${pct(s.seed)}`);
  console.log(`  閲囨牱鍣ㄥ悕        ${pct(s.sampler)}`);
  console.log(`  璋冨害鍣?         ${pct(s.scheduler)}`);
  console.log(`  姝ｅ悜鎻愮ず璇?     ${pct(s.pos)}`);
  console.log(`  璐熷悜鎻愮ず璇?     ${pct(s.neg)}`);
  console.log(`  鍚獿oRA          ${pct(s.loraFiles)}  (鍏?${s.loraCount} 鏉?`);
  console.log(`  澶氶噰鏍峰櫒宸ヤ綔娴? ${pct(s.multi)}`);
  console.log(`\n鑰楁椂 ${dt.toFixed(1)}s  ->  ${(s.total / dt).toFixed(0)} 鏂囦欢/绉抈);
}

// ---------------------------------------------------------------- 鍏ュ彛
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const asJson = args.includes('--json');
const statOnly = args.includes('--stat');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 5 : (statOnly ? Infinity : 3);

if (!target) {
  console.error(`鐢ㄦ硶:
  node tools/inspect.js <鍥剧墖鎴栫洰褰? [--limit N] [--json] [--stat]

  node tools/inspect.js "<你的图库目录>\\old\\xxx.png"
  node tools/inspect.js "<你的图库目录>\\anima" --limit 5
  node tools/inspect.js "<你的图库目录>" --stat`);
  process.exit(1);
}
if (!fs.existsSync(target)) {
  console.error(`璺緞涓嶅瓨鍦? ${target}`);
  process.exit(1);
}

const st = fs.statSync(target);
const files = st.isDirectory() ? walk(target, [], limit) : [target];

if (asJson) {
  const out = files.map((f) => {
    try { return { file: f, ok: true, ...extractFromPng(f) }; }
    catch (e) { return { file: f, ok: false, error: e.message }; }
  });
  console.log(JSON.stringify(out.length === 1 ? out[0] : out, null, 2));
} else if (statOnly) {
  printStat(files);
} else {
  console.log(`${C.dim}瑙ｆ瀽 ${files.length} 涓枃浠?..${C.reset}`);
  for (const f of files) {
    try { printOne(f, extractFromPng(f)); }
    catch (e) { console.log(`\n${C.red}${path.basename(f)} 瑙ｆ瀽澶辫触: ${e.message}${C.reset}`); }
  }
  if (files.length > 1) printStat(files);
}

