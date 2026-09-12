/**
 * 解析器全库回归 —— 确认最终版本没有退化。
 *   node tools/regress-parser.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const P = require('./comfy-parser.cjs');

const ROOT = process.env.CAM_IMAGES || '<你的图库目录>';

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.png$/i.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
console.log('扫描目录 ' + ROOT);
console.log('PNG 文件数 ' + files.length);
if (files.length === 0) {
  console.error('没有找到文件,检查 CAM_IMAGES');
  process.exit(1);
}

const s = {
  n: 0, err: 0, dims: 0, model: 0, steps: 0, cfg: 0, seed: 0,
  sched: 0, pos: 0, neg: 0, loraFiles: 0, loraCount: 0, multi: 0,
};
const src = {};

const t0 = Date.now();
for (const f of files) {
  s.n++;
  let r;
  try {
    r = P.extractFromPng(f);
  } catch {
    s.err++;
    continue;
  }
  const m = r.meta;
  src[m.source] = (src[m.source] || 0) + 1;
  if (r.dimensions) s.dims++;
  if (m.modelName) s.model++;
  const x = m.sampler;
  if (x) {
    if (x.steps !== null) s.steps++;
    if (x.cfg !== null) s.cfg++;
    if (x.seed !== null) s.seed++;
    if (x.scheduler) s.sched++;
  }
  if (m.prompts.some((p) => p.role === 'positive')) s.pos++;
  if (m.prompts.some((p) => p.role === 'negative')) s.neg++;
  if (m.loras.length) {
    s.loraFiles++;
    s.loraCount += m.loras.length;
  }
  if (m.allSamplers.length > 1) s.multi++;
}
const dt = (Date.now() - t0) / 1000;
const pct = (n) => `${String(n).padStart(5)}  ${((n / s.n) * 100).toFixed(1)}%`;

console.log(`\n耗时 ${dt.toFixed(1)}s  (${(s.n / dt).toFixed(0)} 文件/秒)`);
console.log('异常 ' + s.err);
console.log('\n格式分布:');
for (const [k, v] of Object.entries(src).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(18)} ${pct(v)}`);
}
console.log('\n字段覆盖:');
console.log(`  像素尺寸    ${pct(s.dims)}`);
console.log(`  模型名      ${pct(s.model)}`);
console.log(`  步数        ${pct(s.steps)}`);
console.log(`  CFG         ${pct(s.cfg)}`);
console.log(`  seed        ${pct(s.seed)}`);
console.log(`  调度器      ${pct(s.sched)}`);
console.log(`  正向提示词  ${pct(s.pos)}`);
console.log(`  负向提示词  ${pct(s.neg)}`);
console.log(`  含 LoRA     ${pct(s.loraFiles)}  (共 ${s.loraCount} 条)`);
console.log(`  多采样器    ${pct(s.multi)}`);

// 期望基线(第 4 轮实测值),低于基线即视为退化
const BASE = {
  dims: 8061, model: 7357, steps: 7010, cfg: 7010, seed: 7010,
  sched: 4906, pos: 7239, neg: 6292, loraFiles: 4625,
};
let regressed = 0;
for (const [k, base] of Object.entries(BASE)) {
  const cur = s[k];
  if (cur < base) {
    console.log(`  ⚠️ 退化: ${k} ${cur} < 基线 ${base}`);
    regressed++;
  }
}
console.log('\n' + (regressed === 0 ? 'OVERALL: PASS(无退化)' : `OVERALL: FAIL(${regressed} 项低于基线)`));
