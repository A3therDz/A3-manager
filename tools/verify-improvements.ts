/**
 * 本轮「改进.md」六条的回归验证(不依赖 Electron,纯 Node)。
 *
 *   node --experimental-strip-types tools/verify-improvements.ts
 *   CAM_IMAGES=<图库目录>  node --experimental-strip-types tools/verify-improvements.ts   # 追加真实图片抽样
 *
 * 覆盖:
 *   2) NovelAI v4 角色提示词(char_captions / characterPrompts)
 *   6) <lora:名字:权重> 抽取:带冒号的名字、只有名字、负数权重、纯文本不误报
 *   2+6) 真实图片抽样:提示词里不再残留 <lora:> 标签,且每条 LoRA 都能在原始元数据里找到出处
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const parser = nodeRequire('../tools/comfy-parser.cjs') as {
  extractFromPng: (p: string, o?: { keepRaw?: boolean }) => {
    dimensions: { width: number; height: number } | null;
    meta: {
      source: string;
      loras: Array<{ name: string; strengthModel: number | null; strengthClip: number | null; nodeId: string }>;
      prompts: Array<{ role: string; text: string; label?: string }>;
    };
  };
  parseNovelAI: (text: Record<string, string>) => {
    loras: Array<{ name: string }>;
    prompts: Array<{ role: string; text: string; label?: string }>;
  };
  extractLoraTokens: (text: string, nodeId?: string) => {
    loras: Array<{ name: string; strengthModel: number | null; strengthClip: number | null }>;
    text: string;
  };
};
const readPng = (nodeRequire('../tools/png-reader.cjs') as {
  readPng: (p: string, keys?: Set<string>) => { text: Record<string, string> };
}).readPng;

let failures = 0;
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};
const good = (m: string) => console.log(`  ok   ${m}`);

// ---------------------------------------------------------------- 2) NAI 角色提示词
console.log('=== 1) NovelAI v4 角色提示词 ===');
{
  const comment = {
    prompt: 'base, 1girl, solo',
    uc: 'lowres, bad anatomy',
    steps: 28, scale: 5, seed: 12345, sampler: 'k_euler_ancestral', noise_schedule: 'karras',
    width: 832, height: 1216,
    v4_prompt: {
      caption: {
        base_caption: 'base, 1girl, solo',
        char_captions: [
          { char_caption: 'girl, red hair, twin tails', centers: [{ x: 0.4, y: 0.5 }] },
          { char_caption: 'cat, white fur', centers: [{ x: 0.7, y: 0.6 }] },
        ],
      },
      use_coords: true, use_order: true, legacy_uc: false,
    },
    v4_negative_prompt: {
      caption: { base_caption: 'lowres, bad anatomy', char_captions: [] },
      use_coords: false, use_order: false, legacy_uc: false,
    },
  };
  const meta = parser.parseNovelAI({
    Comment: JSON.stringify(comment),
    Software: 'NovelAI',
    Source: 'NovelAI Diffusion V4.5 4BDE2A90',
    Description: 'base, 1girl, solo',
  });
  const chars = meta.prompts.filter((p) => p.role === 'character');
  const pos = meta.prompts.filter((p) => p.role === 'positive');
  const neg = meta.prompts.filter((p) => p.role === 'negative');

  if (chars.length === 2) good('char_captions 解析成 2 块角色提示词');
  else bad(`角色提示词应为 2 块,实际 ${chars.length}`);
  if (chars[0]?.text === 'girl, red hair, twin tails' && chars[0]?.label === '角色 1') good('角色块文本与标签正确');
  else bad(`角色 1 不对: ${JSON.stringify(chars[0])}`);
  if (pos.length === 1 && pos[0].text === 'base, 1girl, solo') good('基础正向提示词没有被角色提示词污染');
  else bad(`正向提示词不对: ${JSON.stringify(pos)}`);
  if (neg.length === 1) good('负向提示词 1 块');
  else bad('负向提示词数量不对');
}
{
  const meta = parser.parseNovelAI({
    Comment: JSON.stringify({ prompt: 'p', uc: 'n', characterPrompts: [{ char_caption: 'hero, blue eyes' }] }),
    Software: 'NovelAI',
    Source: 'X',
  });
  const chars = meta.prompts.filter((p) => p.role === 'character');
  if (chars.length === 1 && chars[0].text === 'hero, blue eyes') good('旧结构 characterPrompts 也能解析');
  else bad(`characterPrompts 兼容失败: ${JSON.stringify(chars)}`);
}

// ---------------------------------------------------------------- 6) LoRA 抽取
console.log('\n=== 2) <lora:...> 抽取 ===');
{
  const cases: Array<[string, string, number | null, number | null]> = [
    ['<lora:anima/re-000180:0.8> rest of prompt', 'anima/re-000180', 0.8, null],
    ['a <lora:Foo_v1:1> b <lora:Bar:0.5:0.7> c', 'Foo_v1', 1, null],
    ['<lora:weird:name:0.65>', 'weird:name', 0.65, null],
    ['<lora:only-name>', 'only-name', null, null],
    ['<lora:neg:-0.5>', 'neg', -0.5, null],
  ];
  for (const [input, name, w1, w2] of cases) {
    const r = parser.extractLoraTokens(input, 't');
    const l = r.loras[0];
    if (!l) { bad(`没抽到 LoRA: ${input}`); continue; }
    if (l.name !== name || l.strengthModel !== w1 || l.strengthClip !== w2) {
      bad(`${input} -> ${JSON.stringify(l)}(期望 ${name} / ${w1} / ${w2})`);
    } else if (/<lora:/i.test(r.text)) {
      bad(`清理后仍有残留标签: ${r.text}`);
    } else {
      good(`${input} -> ${l.name} / ${l.strengthModel}`);
    }
  }
  const clean = parser.extractLoraTokens('no lora here at all', 't');
  if (clean.loras.length === 0) good('纯文本不产生 LoRA(不会误报)');
  else bad(`误报: ${JSON.stringify(clean.loras)}`);
}

// ---------------------------------------------------------------- 真实图片抽样
console.log('\n=== 3) 真实图片抽样 ===');
const roots = (process.env.CAM_IMAGES ?? '')
  .split(path.delimiter)
  .map((s) => s.trim())
  .filter(Boolean);
if (roots.length === 0) {
  console.log('  (跳过:未设置 CAM_IMAGES)');
} else {
  const LIMIT = Number(process.env.CAM_SAMPLE ?? '80');
  const walk = (dir: string, out: string[], limit: number): string[] => {
    if (out.length >= limit) return out;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (out.length >= limit) break;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out, limit);
      else if (/\.png$/i.test(e.name)) out.push(p);
    }
    return out;
  };

  let scanned = 0;
  let leaked = 0;
  let unsourced = 0;
  let totalLoras = 0;
  for (const root of roots) {
    for (const file of walk(root, [], LIMIT)) {
      scanned++;
      const res = parser.extractFromPng(file);
      const meta = res.meta;
      totalLoras += meta.loras.length;
      for (const p of meta.prompts) {
        if (/<\/?lora:/i.test(p.text)) leaked++;
      }
      const blob = Object.values(readPng(file).text).join('\n');
      for (const l of meta.loras) {
        const esc = l.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const fromText = new RegExp(`<lora:[^>]*${esc}`).test(blob);
        if (!fromText && !blob.includes(l.name)) {
          unsourced++;
          console.log(`      未找到出处: ${l.name} @ ${path.basename(file)}`);
        }
      }
    }
  }
  console.log(`  抽样 ${scanned} 张图,共 ${totalLoras} 条 LoRA`);
  if (leaked === 0) good('提示词里不再残留 <lora: 标签');
  else bad(`${leaked} 处提示词残留 <lora: 标签`);
  if (unsourced === 0) good('每条 LoRA 都能在原始元数据里找到出处(无凭空出现的 LoRA)');
  else bad(`${unsourced} 条 LoRA 找不到出处`);
}

console.log('\n' + (failures === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${failures} 项)`));
process.exit(failures === 0 ? 0 : 1);
