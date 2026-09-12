/**
 * 缩略图吞吐与边界测试。
 *   node tools/regress-thumb.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { makeThumb } = require('./thumbnail.cjs');

const ROOT = process.env.CAM_IMAGES || '<你的图库目录>';
const OUT = process.env.CAM_THUMB_OUT || path.join(__dirname, '..', 'data', 'thumb-bench');

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

const all = walk(ROOT);
console.log(`库内 PNG ${all.length} 张`);

// 按体积分档抽样,覆盖典型与极端情况
all.sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
const pick = (frac) => all[Math.min(all.length - 1, Math.floor(all.length * frac))];
const samples = [
  { label: '最小', f: all[0] },
  { label: '25%', f: pick(0.25) },
  { label: '中位', f: pick(0.5) },
  { label: '75%', f: pick(0.75) },
  { label: '最大', f: all[all.length - 1] },
];

fs.mkdirSync(OUT, { recursive: true });

console.log('\n=== 单张分档测试 (max=320) ===');
console.log('档位'.padEnd(8) + '源体积'.padStart(11) + '  输出'.padStart(9) + '  尺寸'.padStart(11) + '  耗时'.padStart(8) + '  压缩比');
let totalMs = 0, totalSrc = 0, totalOut = 0, ok = 0, fail = 0;
for (const s of samples) {
  const out = path.join(OUT, `${s.label}.png`);
  const r = makeThumb(s.f, out, { max: 320, force: true });
  if (!r) { console.log(`${s.label.padEnd(8)}  失败(不支持的变体)`); fail++; continue; }
  ok++;
  totalMs += r.ms; totalSrc += r.srcBytes; totalOut += r.outBytes;
  const ratio = (r.srcBytes / r.outBytes).toFixed(0);
  console.log(
    `${s.label.padEnd(8)}${(r.srcBytes / 1048576).toFixed(2).padStart(8)} MB` +
    `${(r.outBytes / 1024).toFixed(1).padStart(7)} KB` +
    `${(r.w + 'x' + r.h).padStart(11)}` +
    `${(r.ms + 'ms').padStart(8)}` +
    `${(ratio + 'x').padStart(9)}`
  );
}
console.log(`\n可处理 ${ok} / 失败 ${fail}`);
console.log(`平均耗时 ${(totalMs / Math.max(1, ok)).toFixed(0)} ms/张`);
console.log(`平均压缩 ${(totalSrc / Math.max(1, totalOut)).toFixed(0)}x`);

// 全库时间与体积估算
const avgMs = totalMs / Math.max(1, ok);
console.log(`\n=== 全库 ${all.length} 张推算 ===`);
console.log(`  预计耗时  ${(avgMs * all.length / 1000 / 60).toFixed(1)} 分钟`);
const avgOut = totalOut / Math.max(1, ok);
console.log(`  预计体积  ${(avgOut * all.length / 1073741824).toFixed(2)} GB`);

// 批处理吞吐(连续 30 张,看平均)
const BATCH = Math.min(30, all.length);
const t0 = Date.now();
let bOk = 0;
for (let i = 0; i < BATCH; i++) {
  const f = all[Math.floor((i * all.length) / BATCH)];
  const out = path.join(OUT, `b-${i}.png`);
  if (makeThumb(f, out, { max: 320, force: true })) bOk++;
}
const dt = Date.now() - t0;
console.log(`\n=== 连续 ${BATCH} 张实测 ===`);
console.log(`  成功 ${bOk}/${BATCH},耗时 ${(dt / 1000).toFixed(1)}s,吞吐 ${(bOk / (dt / 1000) * 60).toFixed(0)} 张/分钟`);

// 缓存命中路径
const first = all[Math.floor(all.length / 2)];
const cacheOut = path.join(OUT, 'cache-test.png');
const r1 = makeThumb(first, cacheOut, { max: 320, force: true });
const r2 = makeThumb(first, cacheOut, { max: 320 });
if (r2 && r2.cached && r2.ms < r1.ms) {
  console.log(`\n缓存命中生效: 首次 ${r1.ms}ms -> 二次 ${r2.ms}ms (cached=${r2.cached})`);
} else {
  console.log(`\n⚠️ 缓存命中异常: r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`);
}

// 清理
setTimeout(() => {
  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch {}
}, 100);
