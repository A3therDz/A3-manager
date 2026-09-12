/**
 * 纯 JS PNG 缩略图生成器 —— 零依赖,不用 sharp / nativeImage / 浏览器。
 *
 * 为什么需要:
 *  图库/前端网格里一屏要显示上百张图。如果直接用原图(ComfyUI 出图常 4MB、9MP),
 *  浏览器要为每张保留解码后的位图,内存与首屏时间都会爆炸。
 *  这里生成真缩略图:PNG 解码 -> 盒式降采样 -> 重新编码为 PNG(调色板量化以压体积)。
 *
 * 支持范围(覆盖实拍全部样本):
 *   位深 8、颜色类型 2(RGB)/ 6(RGBA)/ 0(灰度)/ 4(灰度+Alpha)
 *   过滤器 0..4 全支持;交错(Adam7)不支持(ComfyUI 不产出)
 *
 * 编码:8 位调色板 PNG(把降采样后的像素量化到 ≤256 色),缩略图肉眼无差异,
 *      体积比真彩小得多。量化用"中位切分"简化版:按 3-3-2 位压缩做桶聚合。
 */

const fs = require('node:fs');
const zlib = require('node:zlib');

// ---------------------------------------------------------------- CRC / 分块

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  CRC_TABLE = t;
  return t;
}
function crc32(buf) {
  const t = crcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crcBuf]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------- 读取 IDAT

/** 只取 IHDR 与拼合后的 IDAT(不读其它块,省时间) */
function readPngRaw(file) {
  const fd = fs.openSync(file, 'r');
  const idat = [];
  let ihdr = null;
  try {
    const sig = Buffer.alloc(8);
    if (fs.readSync(fd, sig, 0, 8, 0) < 8 || !sig.equals(PNG_SIG)) return null;
    let pos = 8;
    while (true) {
      const hdr = Buffer.alloc(8);
      if (fs.readSync(fd, hdr, 0, 8, pos) < 8) break;
      const len = hdr.readUInt32BE(0);
      const type = hdr.subarray(4, 8).toString('latin1');
      const ds = pos + 8;
      if (type === 'IHDR') {
        const d = Buffer.alloc(len);
        fs.readSync(fd, d, 0, len, ds);
        ihdr = {
          width: d.readUInt32BE(0),
          height: d.readUInt32BE(4),
          depth: d[8],
          colorType: d[9],
          compression: d[10],
          filter: d[11],
          interlace: d[12],
        };
      } else if (type === 'IDAT') {
        const d = Buffer.alloc(len);
        fs.readSync(fd, d, 0, len, ds);
        idat.push(d);
      } else if (type === 'IEND') {
        break;
      }
      pos = ds + len + 4;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (!ihdr || idat.length === 0) return null;
  return { ihdr, data: zlib.inflateSync(Buffer.concat(idat)) };
}

// ---------------------------------------------------------------- 解码 + 降采样

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * 解码并按步长盒式降采样到目标尺寸。
 *
 * 优化:只在"需要输出的行"上做反过滤——但 PNG 的过滤器依赖上一行,
 * 所以仍要逐行反过滤。不过我们只把需要的行写入累积缓冲,省掉大部分内存写。
 */
function decodeAndDownscale(file, maxW, maxH) {
  const raw = readPngRaw(file);
  if (!raw) return null;
  const { ihdr, data } = raw;
  const { width: W, height: H, depth, colorType, interlace } = ihdr;
  if (interlace !== 0) return null;
  if (depth !== 8) return null;
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0;
  if (channels === 0) return null;

  const scale = Math.min(maxW / W, maxH / H, 1);
  const outW = Math.max(1, Math.round(W * scale));
  const outH = Math.max(1, Math.round(H * scale));
  if (scale >= 1) {
    // 原图比缩略图还小,不放大
    return null;
  }

  const bpp = channels;
  const stride = W * bpp;
  let prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);

  // 每个输出像素对应的源像素区间(盒式平均)
  const x0 = new Int32Array(outW + 1);
  const y0 = new Int32Array(outH + 1);
  for (let i = 0; i <= outW; i++) x0[i] = Math.floor((i * W) / outW);
  for (let i = 0; i <= outH; i++) y0[i] = Math.floor((i * H) / outH);

  // 按行累积:每个输出行累积其覆盖的源行
  const acc = new Float32Array(outW * 3);
  const counts = new Int32Array(outW);
  const out = Buffer.alloc(outW * outH * 3);

  let src = 0;
  let outRow = 0;
  for (let y = 0; y < H; y++) {
    const filter = data[src++];
    const line = data.subarray(src, src + stride);
    src += stride;

    // 反过滤
    switch (filter) {
      case 0:
        line.copy(cur);
        break;
      case 1:
        for (let i = 0; i < stride; i++) cur[i] = (line[i] + (i >= bpp ? cur[i - bpp] : 0)) & 0xff;
        break;
      case 2:
        for (let i = 0; i < stride; i++) cur[i] = (line[i] + prev[i]) & 0xff;
        break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0;
          cur[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0;
          const c = i >= bpp ? prev[i - bpp] : 0;
          cur[i] = (line[i] + paeth(a, prev[i], c)) & 0xff;
        }
        break;
      default:
        return null;
    }

    // 该行是否属于当前输出行
    while (outRow < outH && y >= y0[outRow + 1]) {
      // 收尾当前输出行
      const base = outRow * outW * 3;
      for (let x = 0; x < outW; x++) {
        const c = counts[x] || 1;
        out[base + x * 3] = clamp255(acc[x * 3] / c);
        out[base + x * 3 + 1] = clamp255(acc[x * 3 + 1] / c);
        out[base + x * 3 + 2] = clamp255(acc[x * 3 + 2] / c);
      }
      acc.fill(0);
      counts.fill(0);
      outRow++;
    }
    if (outRow >= outH) break;

    // 累积这一行
    if (y >= y0[outRow] && y < y0[outRow + 1]) {
      for (let x = 0; x < outW; x++) {
        const sx0 = x0[x];
        const sx1 = Math.max(sx0 + 1, x0[x + 1]);
        let r = 0, g = 0, b = 0, n = 0;
        for (let sx = sx0; sx < sx1; sx++) {
          const o = sx * bpp;
          if (channels === 1) { r += cur[o]; g += cur[o]; b += cur[o]; }
          else if (channels === 2) { r += cur[o]; g += cur[o]; b += cur[o]; }
          else { r += cur[o]; g += cur[o + 1]; b += cur[o + 2]; }
          n++;
        }
        if (n > 0) {
          acc[x * 3] += r / n;
          acc[x * 3 + 1] += g / n;
          acc[x * 3 + 2] += b / n;
          counts[x]++;
        }
      }
    }

    const tmp = prev;
    prev = cur;
    cur = tmp;
  }

  // 收尾最后一行
  if (outRow < outH) {
    const base = outRow * outW * 3;
    for (let x = 0; x < outW; x++) {
      const c = counts[x] || 1;
      out[base + x * 3] = clamp255(acc[x * 3] / c);
      out[base + x * 3 + 1] = clamp255(acc[x * 3 + 1] / c);
      out[base + x * 3 + 2] = clamp255(acc[x * 3 + 2] / c);
    }
  }

  return { width: outW, height: outH, rgb: out };
}

function clamp255(v) {
  const n = Math.round(v);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

// ---------------------------------------------------------------- 编码

/**
 * 把 RGB 像素编码成 8 位调色板 PNG。
 *
 * 量化用**中位切分(median cut)**:按颜色盒最长轴递归切分,直到 ≤256 个盒子,
 * 每个盒子取平均色。相比简单的位置截断(3-3-2 位),肉眼几乎看不出色带。
 *
 * 为什么不用真彩 PNG:真彩体积约为调色板的 2~3 倍,而缩略图网格要加载上百张,
 * 体积比色彩精度更重要 —— 但前提是量化要够好,否则"发脏"比"稍大"更难受。
 */
function encodePalettePng(width, height, rgb) {
  const n = width * height;

  // 1) 统计颜色直方图(12 位精度聚合,避免过多唯一色导致切分很慢)
  const hist = new Map();
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = hist.get(key);
    if (e) {
      e[0] += r; e[1] += g; e[2] += b; e[3]++;
    } else {
      hist.set(key, [r, g, b, 1]);
    }
  }
  const entries = [...hist.values()].map(([sr, sg, sb, c]) => ({
    r: sr / c, g: sg / c, b: sb / c, n: c,
  }));

  // 2) 中位切分
  const boxes = [entries];
  while (boxes.length < 256) {
    // 选一个"体积权重最大"的盒子来切
    let bi = -1, best = -1;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.length < 2) continue;
      let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
      for (const e of box) {
        if (e.r < rmin) rmin = e.r; if (e.r > rmax) rmax = e.r;
        if (e.g < gmin) gmin = e.g; if (e.g > gmax) gmax = e.g;
        if (e.b < bmin) bmin = e.b; if (e.b > bmax) bmax = e.b;
      }
      const span = Math.max(rmax - rmin, gmax - gmin, bmax - bmin);
      const score = span * box.length;
      if (score > best) { best = score; bi = i; }
    }
    if (bi < 0) break;
    const box = boxes[bi];
    let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
    for (const e of box) {
      if (e.r < rmin) rmin = e.r; if (e.r > rmax) rmax = e.r;
      if (e.g < gmin) gmin = e.g; if (e.g > gmax) gmax = e.g;
      if (e.b < bmin) bmin = e.b; if (e.b > bmax) bmax = e.b;
    }
    const dr = rmax - rmin, dg = gmax - gmin, db = bmax - bmin;
    const axis = dr >= dg && dr >= db ? 'r' : dg >= db ? 'g' : 'b';
    box.sort((x, y) => x[axis] - y[axis]);
    // 按像素数中位切
    let total = 0;
    for (const e of box) total += e.n;
    let acc = 0, cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += box[i].n;
      if (acc >= total / 2) { cut = i + 1; break; }
    }
    boxes.splice(bi, 1, box.slice(0, cut), box.slice(cut));
  }

  // 3) 每个盒子取加权平均色
  const palette = [];
  for (const box of boxes) {
    let r = 0, g = 0, b = 0, c = 0;
    for (const e of box) { r += e.r * e.n; g += e.g * e.n; b += e.b * e.n; c += e.n; }
    if (c === 0) continue;
    palette.push([Math.round(r / c), Math.round(g / c), Math.round(b / c)]);
  }
  while (palette.length < 1) palette.push([0, 0, 0]);
  while (palette.length < 256) palette.push(palette[palette.length - 1]);

  // 4) 用最近邻把每个像素映射到调色板(带缓存,避免重复算距离)
  const cache = new Map();
  const idx = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const key = (r << 16) | (g << 8) | b;
    let pi = cache.get(key);
    if (pi === undefined) {
      let bestD = Infinity;
      pi = 0;
      for (let p = 0; p < palette.length; p++) {
        const pr = palette[p][0] - r, pg = palette[p][1] - g, pb = palette[p][2] - b;
        const d = pr * pr + pg * pg + pb * pb;
        if (d < bestD) { bestD = d; pi = p; if (d === 0) break; }
      }
      cache.set(key, pi);
    }
    idx[i] = pi & 0xff;
  }

  // 5) 每行前加过滤字节 0
  const scan = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    scan[y * (width + 1)] = 0;
    idx.copy(scan, y * (width + 1) + 1, y * width, (y + 1) * width);
  }
  const idat = zlib.deflateSync(scan, { level: 9 });

  const plte = Buffer.alloc(palette.length * 3);
  for (let i = 0; i < palette.length; i++) {
    plte[i * 3] = palette[i][0];
    plte[i * 3 + 1] = palette[i][1];
    plte[i * 3 + 2] = palette[i][2];
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 3;   // color type = palette
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 对外接口

/**
 * 生成缩略图文件。返回 { out, srcBytes, outBytes, w, h, ms } 或 null。
 * @param {string} srcPath
 * @param {string} outPath
 * @param {{max?: number, force?: boolean}} [opt]
 */
function makeThumb(srcPath, outPath, opt = {}) {
  const max = opt.max ?? 320;
  const t0 = Date.now();
  if (!opt.force && fs.existsSync(outPath)) {
    const st = fs.statSync(outPath);
    if (st.size > 0) return { out: outPath, cached: true, outBytes: st.size, ms: Date.now() - t0 };
  }
  const dec = decodeAndDownscale(srcPath, max, max);
  if (!dec) return null;
  const png = encodePalettePng(dec.width, dec.height, dec.rgb);
  fs.mkdirSync(require('node:path').dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, png);
  return {
    out: outPath,
    cached: false,
    w: dec.width,
    h: dec.height,
    srcBytes: fs.statSync(srcPath).size,
    outBytes: png.length,
    ms: Date.now() - t0,
  };
}

module.exports = { makeThumb, decodeAndDownscale, encodePalettePng };

// 直接运行时当作 CLI:node thumbnail.cjs <原图> <输出>
if (require.main === module) {
  const [, , src, out] = process.argv;
  if (!src || !out) {
    console.error('用法: node tools/thumbnail.cjs <原图> <输出.png> [--max=320]');
    process.exit(1);
  }
  const maxArg = process.argv.find((a) => a.startsWith('--max='));
  const max = maxArg ? Number(maxArg.split('=')[1]) : 320;
  const r = makeThumb(src, out, { max, force: true });
  if (!r) {
    console.error('生成失败(可能是不支持的 PNG 变体:非 8 位 / 交错 / 非 RGB 系)');
    process.exit(1);
  }
  console.log(JSON.stringify(r, null, 2));
}
