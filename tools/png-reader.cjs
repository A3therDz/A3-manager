/**
 * PNG 文本块读取器 —— 零依赖。
 *
 * 性能要点:ComfyUI 的 prompt 块通常出现在文件前部(~几 KB 处),
 * 而 workflow 块可能有 1.6MB。所以这里支持"找到想要的键就立刻停",
 * 不会把整张 4MB 的图读进内存。
 */
const fs = require('fs');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 只读 IHDR 拿真实像素尺寸。IHDR 永远是第一个块。 */
function readDimensions(fd) {
  const buf = Buffer.alloc(24);
  const n = fs.readSync(fd, buf, 0, 24, 0);
  if (n < 24) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return null;
  // 8..11 长度, 12..15 类型("IHDR"), 16..19 width, 20..23 height
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * 流式读文本块。
 * @param {string} filePath
 * @param {Set<string>|null} want 只收集这些键;null = 全部。找到全部后提前退出。
 * @returns {{dimensions: {width:number,height:number}|null, text: Record<string,string>}}
 */
function readPng(filePath, want = null) {
  const fd = fs.openSync(filePath, 'r');
  let dimensions = null;
  const text = {};
  // 性能关键:workflow 块可达 1.6MB 且通常排在 prompt / parameters 之后。
  // 策略:按优先级收集主负载块 —— 拿到 prompt 或 parameters 就立刻停;
  // 只拿到 Comment 时继续等一个更权威的块,但也不能无限读下去。
  const PRIORITY_PAYLOAD = ['prompt', 'parameters'];
  const SECONDARY_PAYLOAD = ['Comment', 'Description'];
  // workflow 块可能有 1.5MB。它既排在参数块之前、也可能之后,所以不能读完就丢,
  // 但也不能为了它把每张图都整个读进内存。策略:记住它,只有整份扫描结束
  // 仍未拿到更高优先级的块时,才回头采用它。
  let workflowChunk = null;
  let sawPriority = false;
  let wantedRemaining = want ? want.size : Infinity;

  try {
    const head = Buffer.alloc(24);
    if (fs.readSync(fd, head, 0, 24, 0) < 24) return { dimensions: null, text };
    if (!head.subarray(0, 8).equals(PNG_SIG)) return { dimensions: null, text };

    let pos = 8;
    // IHDR
    {
      const len = head.readUInt32BE(8);
      if (head.subarray(12, 16).toString('latin1') === 'IHDR') {
        dimensions = { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
      }
      pos = 8 + 12 + len;
    }

    while (wantedRemaining > 0) {
      const hdr = Buffer.alloc(8);
      const got = fs.readSync(fd, hdr, 0, 8, pos);
      if (got < 8) break;
      const len = hdr.readUInt32BE(0);
      const type = hdr.subarray(4, 8).toString('latin1');
      const dataStart = pos + 8;

      if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
        const data = Buffer.alloc(len);
        fs.readSync(fd, data, 0, len, dataStart);
        try {
          const nul = data.indexOf(0);
          if (nul > 0) {
            const key = data.subarray(0, nul).toString('latin1');
            if (!want || want.has(key)) {
              let val;
              if (type === 'tEXt') {
                val = data.subarray(nul + 1).toString('latin1');
              } else if (type === 'zTXt') {
                val = readZtxt(data, nul);
              } else {
                // iTXt: keyword\0 compressionFlag compressionMethod language\0 translated\0 text
                const compFlag = data[nul + 1];
                const rest = data.subarray(nul + 3);
                const l1 = rest.indexOf(0);
                const l2 = rest.indexOf(0, l1 + 1);
                const body = rest.subarray(l2 + 1);
                val = compFlag === 1 ? inflate(body) : body.toString('utf8');
              }
              if (val !== null && val !== undefined) {
                if (key === 'workflow') {
                  // 体积大,先拿引用,不立刻计入结果
                  if (!workflowChunk) workflowChunk = val;
                  continue;
                }
                text[key] = val;
                if (want && want.has(key)) wantedRemaining--;
                if (PRIORITY_PAYLOAD.includes(key)) {
                  sawPriority = true;
                  break; // 拿到权威块,收工
                }
              }
            }
          }
        } catch {
          /* 单个文本块坏了不影响其它块 */
        }
      } else if (type === 'IEND') {
        break;
      }

      pos = dataStart + len + 4; // +4 = CRC
    }
  } finally {
    fs.closeSync(fd);
  }

  // 没拿到更高优先级的块,才退而用 workflow
  if (!sawPriority && workflowChunk && (!want || want.has('workflow'))) {
    text['workflow'] = workflowChunk;
  }

  return { dimensions, text };
}

function readZtxt(data, nul) {
  const zlib = require('zlib');
  try {
    const compMethod = data[nul + 1];
    if (compMethod !== 0) return null;
    return zlib.inflateSync(data.subarray(nul + 2)).toString('latin1');
  } catch {
    return null;
  }
}

function inflate(buf) {
  const zlib = require('zlib');
  try {
    return zlib.inflateSync(buf).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { readPng, readDimensions };
