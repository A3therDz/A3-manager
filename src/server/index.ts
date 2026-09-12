/**
 * 零依赖 HTTP 服务 —— 把同一套 API 契约暴露成 REST + JSON。
 *
 * 为什么需要它:
 *  1. Electron 依赖在沙箱里装不上,但前端不应该为此停摆。
 *     有了 HTTP 服务,前端只要一个 fetch 地址就能开发与联调。
 *  2. 将来 Electron 只是"多套一层外壳":主进程继续用 db.ts,
 *     渲染层继续打这套接口,两边的契约完全相同(src/shared/types.ts)。
 *  3. 缩略图不需要图片库 —— 直接返回原图字节流,由浏览器缩放显示。
 *
 * 只用 node:http / node:fs / node:url,没有任何第三方依赖。
 *
 * 启动:
 *   node --experimental-strip-types src/server/index.ts --port 5174 --root "<你的图库目录>"
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AssetDb } from '../main/db.ts';
import type { ScanProgress } from '../main/indexer.ts';
import { scanLibrary } from '../main/indexer.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------- 参数

function argVal(name: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const PORT = Number(argVal('port') ?? process.env.CAM_PORT ?? 5174);
const CLI_ROOT = argVal('root');
const DB_FILE = argVal('db') ?? process.env.CAM_DB ?? path.join(PROJECT_ROOT, 'data', 'index.db');
const RENDERER_DIR = path.join(PROJECT_ROOT, 'dist', 'renderer');
/**
 * 无依赖版的页面目录。
 *
 * 背景:最终形态是 Electron + React(需要 npm 构建),但后端零第三方依赖。
 * 为了让"装不上依赖的机器"也能立刻得到一个可运行程序,tools/serve-webui.ts
 * 生成一个纯 JS 版页面放在 web/,由本服务托管 —— 数据同样走 /api,契约与
 * React 版完全一致(src/shared/types.ts)。
 *
 * 优先级:web/index.html 存在就用它(无依赖路径);否则用 React 构建产物。
 */
const WEB_DIR = path.join(PROJECT_ROOT, 'web');

const dbDir = path.dirname(DB_FILE);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new AssetDb(DB_FILE);

// ---------------------------------------------------------------- 扫描状态

let scanAbort: AbortController | null = null;
let lastProgress: ScanProgress | null = null;
const progressClients = new Set<http.ServerResponse>();

function broadcast(p: ScanProgress): void {
  lastProgress = p;
  const payload = `data: ${JSON.stringify(p)}\n\n`;
  for (const res of progressClients) {
    try {
      res.write(payload);
    } catch {
      progressClients.delete(res);
    }
  }
}

async function runScan(opts: { rootIds?: number[]; force?: boolean }): Promise<void> {
  if (scanAbort) return;
  scanAbort = new AbortController();
  try {
    await scanLibrary(db, {
      rootIds: opts.rootIds,
      force: opts.force,
      signal: scanAbort.signal,
      onProgress: broadcast,
    });
  } catch (e) {
    broadcast({
      phase: 'error',
      processed: 0,
      total: 0,
      currentFile: null,
      skipped: 0,
      errors: 0,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      message: e instanceof Error ? e.message : String(e),
    });
  } finally {
    scanAbort = null;
  }
}

// ---------------------------------------------------------------- HTTP 工具

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function ok(res: http.ServerResponse, data: unknown): void {
  sendJson(res, 200, { ok: true, data });
}

function fail(res: http.ServerResponse, e: unknown, status = 500): void {
  const msg = e instanceof Error ? e.message : String(e);
  sendJson(res, status, { ok: false, error: msg });
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 流式返回文件,支持 Range(图片拖动/大图预览需要) */
async function sendFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  extraHeaders: Record<string, string> = {}
): Promise<void> {
  let st: fs.Stats;
  try {
    st = await fsp.stat(filePath);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] ?? 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : st.size - 1;
      if (start <= end && start < st.size) {
        res.writeHead(206, {
          'content-type': type,
          'content-range': `bytes ${start}-${end}/${st.size}`,
          'accept-ranges': 'bytes',
          'content-length': end - start + 1,
          ...extraHeaders,
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': st.size,
    'accept-ranges': 'bytes',
    ...extraHeaders,
  });
  fs.createReadStream(filePath).pipe(res);
}

// ---------------------------------------------------------------- 路由

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  params: Record<string, string>
) => void | Promise<void>;

/** 简易路由:支持 /api/getImage/:id 这种单段参数 */
function matchRoute(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
  for (const [key, entry] of routes) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const pp = pattern.split('/').filter(Boolean);
    const ap = pathname.split('/').filter(Boolean);
    if (pp.length !== ap.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(ap[i]);
      else if (pp[i] !== ap[i]) { matched = false; break; }
    }
    if (matched) return { handler: entry, params };
  }
  return null;
}

const routes = new Map<string, Handler>();
function route(method: string, pattern: string, handler: Handler): void {
  routes.set(`${method} ${pattern}`, handler);
}

// ---- 健康检查(前端与 K3 都用它确认服务活着)
route('GET', '/api/health', (_req, res) => {
  ok(res, {
    service: 'comfy-asset-manager',
    version: '0.1.0',
    images: db.count(),
    roots: db.listRoots().length,
  });
});

/**
 * 优雅停服。
 *
 * 为什么需要:作为后台常驻服务,必须能干净地关掉自己。
 * 早先在测试里用 Start-Job 起服务后无法可靠回收,留下一堆孤儿 node 进程占着端口,
 * 导致了"端口被占 → EACCES → 误判为沙箱禁止绑端口"的连环误判。
 * 有了这个端点,任何调用方都能确定性地收回服务。
 *
 * 只监听 127.0.0.1,所以不额外加鉴权;若要暴露到局域网,必须先加 token。
 */
route('POST', '/api/shutdown', (_req, res) => {
  ok(res, { stopping: true });
  // 先把响应发出去,再关服务,避免调用方看到连接被重置
  setTimeout(() => {
    console.log('收到 /api/shutdown,正在退出…');
    scanAbort?.abort();
    db.close();
    server.close(() => process.exit(0));
    // 兜底:若有 keep-alive 连接挂住,2 秒后强制退出
    setTimeout(() => process.exit(0), 2000);
  }, 50);
});

// ---- 根目录管理
route('GET', '/api/roots', (_req, res) => ok(res, db.listRoots()));

route('POST', '/api/roots', async (req, res) => {
  const body = (await readJsonBody(req)) as { path?: string; label?: string };
  if (!body.path) return fail(res, new Error('缺少 path'), 400);
  const abs = path.resolve(body.path);
  if (!fs.existsSync(abs)) return fail(res, new Error(`路径不存在: ${abs}`), 400);
  const id = db.addRoot(abs, body.label);
  ok(res, db.listRoots().find((r: { id: number }) => r.id === id) ?? null);
});

route('DELETE', '/api/roots/:id', (_req, res, _url, p) => {
  db.removeRoot(Number(p.id));
  ok(res, null);
});

route('POST', '/api/roots/:id/enabled', async (req, res, _url, p) => {
  const body = (await readJsonBody(req)) as { enabled?: boolean };
  db.setRootEnabled(Number(p.id), body.enabled !== false);
  ok(res, null);
});

// ---- 扫描
route('POST', '/api/scan', async (req, res) => {
  if (scanAbort) return ok(res, { started: false, reason: 'scan already running' });
  const body = (await readJsonBody(req)) as { rootIds?: number[]; force?: boolean };

  void runScan({ rootIds: body.rootIds, force: body.force });
  ok(res, { started: true });
});

route('POST', '/api/scan/cancel', (_req, res) => {
  scanAbort?.abort();
  ok(res, null);
});

route('GET', '/api/scan/progress', (_req, res) => ok(res, lastProgress));

// ---- 进度推送(SSE)
route('GET', '/api/scan/events', (req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify(lastProgress ?? { phase: 'idle' })}\n\n`);
  progressClients.add(res);
  req.on('close', () => progressClients.delete(res));
});

// ---- 浏览与检索
route('POST', '/api/query', async (req, res) => {
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const t0 = Date.now();
  const q = { ...body };
  const text = typeof q.q === 'string' ? q.q.trim() : '';
  if (text) {
    const ids = db.searchIds(text, 20000);
    if (ids.length === 0) return ok(res, { ids: [], total: 0, tookMs: Date.now() - t0 });
    q.ids = ids;
  }
  delete q.q;
  const r = db.queryImages(q);
  ok(res, { ...r, tookMs: Date.now() - t0 });
});

route('GET', '/api/images/:ids', (_req, res, _url, p) => {
  const ids = p.ids.split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);
  ok(res, db.getImagesByIds(ids));
});

route('GET', '/api/image/:id', (_req, res, _url, p) => {
  const d = db.getImageDetail(Number(p.id));
  if (!d) return fail(res, new Error('图片不存在'), 404);
  const sib = db.getSiblings(Number(p.id), { sort: 'mtime_desc' });
  ok(res, { ...d, siblings: sib.ids, position: sib.position, total: sib.total });
});

route('GET', '/api/tree', (_req, res, url) => {
  const rootId = url.searchParams.get('rootId');
  ok(res, db.getFolderTree(rootId ? Number(rootId) : undefined));
});

route('GET', '/api/stats', (_req, res, url) => {
  const rootId = url.searchParams.get('rootId');
  ok(res, db.getStats(rootId ? Number(rootId) : undefined));
});

route('GET', '/api/filters', (_req, res) => ok(res, db.getFilterOptions()));

// ---- 用户自定义分类(不移动文件,只是索引层的集合归属)
route('GET', '/api/categories', (_req, res) => ok(res, db.getCategoryTree()));

route('POST', '/api/categories', async (req, res) => {
  const body = (await readJsonBody(req)) as {
    name?: string;
    parentId?: number | null;
    relDir?: string | null;
    rootId?: number | null;
    description?: string | null;
  };
  if (!body.name) return fail(res, new Error('缺少 name'), 400);
  ok(res, db.createCategory(body as { name: string }));
});

route('PATCH', '/api/categories/:id', async (req, res, _url, p) => {
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  ok(res, db.updateCategory(Number(p.id), body as Parameters<AssetDb['updateCategory']>[1]));
});

route('DELETE', '/api/categories/:id', (_req, res, url, p) => {
  db.deleteCategory(Number(p.id), url.searchParams.get('children') === 'true');
  ok(res, null);
});

route('POST', '/api/categories/:id/members', async (req, res, _url, p) => {
  const body = (await readJsonBody(req)) as { imageIds?: number[]; member?: boolean };
  const ids = Array.isArray(body.imageIds) ? body.imageIds : [];
  ok(res, { changed: db.setCategoryMembers(Number(p.id), ids, body.member !== false) });
});

route('GET', '/api/image/:id/categories', (_req, res, _url, p) =>
  ok(res, db.getImageCategories(Number(p.id)))
);

// ---- 操作
route('POST', '/api/star/:id', async (req, res, _url, p) => {
  const body = (await readJsonBody(req)) as { starred?: boolean };
  db.setStarred(Number(p.id), body.starred === true);
  ok(res, null);
});

// ---- 原图字节流(缩略图直接复用这个,由浏览器缩放)
route('GET', '/api/file/:id', async (req, res, _url, p) => {
  const row = db.getImageRow(Number(p.id));
  if (!row) return fail(res, new Error('图片不存在'), 404);
  // 图片不可变(改动会改 mtime),可以放心长缓存
  await sendFile(req, res, row.abs_path as string, {
    'cache-control': 'public, max-age=31536000, immutable',
  });
});

// ---- 前端页面 / 静态资源
// 注意:本路由不使用查询参数,签名保留 url 以符合 Handler 类型
route('GET', '/', async (req, res) => {
  // 1) 无依赖版(纯 JS,fetch /api):存在就优先,保证没装 npm 也能用
  const webIndex = path.join(WEB_DIR, 'index.html');
  if (fs.existsSync(webIndex)) {
    await sendFile(req, res, webIndex);
    return;
  }
  // 2) React 构建产物(Electron / 正式打包路径)
  const indexHtml = path.join(RENDERER_DIR, 'index.html');
  if (fs.existsSync(indexHtml)) {
    await sendFile(req, res, indexHtml);
    return;
  }
  // 3) 都没有:给一个最小自检页,方便确认 API 全通
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>API 自检</title>
<style>
body{margin:0;padding:24px;background:#0f1115;color:#e6e8eb;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif}
h1{font-size:18px;margin:0 0 4px}p.sub{color:#7d8590;margin:0 0 20px}
table{border-collapse:collapse;width:100%;max-width:900px}td,th{border-bottom:1px solid #21262d;padding:6px 8px;text-align:left;vertical-align:top}
th{color:#7d8590;font-weight:500}.ok{color:#3fb950}.bad{color:#f85149}
code{font-family:ui-monospace,monospace;color:#79c0ff}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-top:16px}
.grid img{width:100%;height:150px;object-fit:cover;border-radius:6px;background:#161b22}
</style></head><body>
<h1>后端 API 自检</h1>
<p class="sub">这个页面由零依赖 HTTP 服务提供。前端构建产物存在时会自动切换成真实界面。</p>
<table id="t"><tbody></tbody></table>
<h2 style="font-size:14px;color:#7d8590;margin-top:24px">前 12 张缩略图(直接由 /api/file/:id 提供)</h2>
<div class="grid" id="g"></div>
<script>
const rows=[];
async function hit(label,url){try{const r=await fetch(url);const j=await r.json();rows.push([label,url,j.ok?'ok':'bad',j.ok?JSON.stringify(j.data).slice(0,110):j.error]);}catch(e){rows.push([label,url,'bad',e.message]);}}
(async()=>{
  await hit('health','/api/health');
  await hit('roots','/api/roots');
  await hit('stats','/api/stats');
  await hit('filters','/api/filters');
  await hit('tree','/api/tree');
  await hit('progress','/api/scan/progress');
  const tb=document.getElementById('t').innerHTML='<tr><th>接口</th><th>路径</th><th>状态</th><th>返回摘要</th></tr>';
  document.getElementById('t').innerHTML+='<tr><th>接口</th><th>路径</th><th>状态</th><th>返回摘要</th></tr>'
    +rows.map(r=>\`<tr><td>\${r[0]}</td><td><code>\${r[1]}</code></td><td class="\${r[2]}">\${r[2]}</td><td><code>\${r[3].replace(/</g,'&lt;')}</code></td></tr>\`).join('');
  const q=await (await fetch('/api/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({limit:12,sort:'mtime_desc'})})).json();
  if(q.ok){document.getElementById('g').innerHTML=q.data.ids.map(id=>\`<img src="/api/file/\${id}" loading="lazy" title="#\${id}">\`).join('');}
})();
</script></body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});

// 静态资源(前端构建产物的 js/css)
route('GET', '/assets/:file', async (req, res, _url, p) => {
  const f = path.join(RENDERER_DIR, 'assets', p.file);
  if (!f.startsWith(RENDERER_DIR)) return fail(res, new Error('非法路径'), 400);
  await sendFile(req, res, f);
});

// ---------------------------------------------------------------- 启动

if (CLI_ROOT) {
  const abs = path.resolve(CLI_ROOT);
  if (fs.existsSync(abs)) {
    const id = db.addRoot(abs);
    console.log(`已挂载扫描目录 #${id}  ${abs}`);
  } else {
    console.error(`目录不存在: ${abs}`);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = req.method ?? 'GET';

  // 同源策略:开发时前端跑在 5173,这里放行。
  // 注意必须列出 PATCH —— 分类改名走的是 PATCH /api/categories/:id,
  // 漏掉它会让跨源预检直接把请求拦掉(实测踩过)。
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-max-age', '86400');
  if (method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  // /api/file/:id 走单独分支(路径里带扩展名的情况也兼容)
  const m = matchRoute(method, url.pathname);
  if (m) {
    void Promise.resolve(m.handler(req, res, url, m.params)).catch((e) => fail(res, e));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    fail(res, new Error(`未知接口: ${method} ${url.pathname}`), 404);
    return;
  }

  // 非 /api 路径交给自检页或静态资源。
  // 'GET /' 的实现在上面注册为 (req, res),但路由表的类型是完整 Handler,
  // 所以这里补一个空 params 以满足签名。
  void Promise.resolve(routes.get('GET /')!(req, res, url, {})).catch((e) => fail(res, e));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ComfyUI 资产管理器 —— 后端 API 服务');
  console.log('  ' + '-'.repeat(52));
  console.log(`  地址        http://127.0.0.1:${PORT}`);
  console.log(`  自检页      http://127.0.0.1:${PORT}/`);
  console.log(`  索引库      ${DB_FILE}`);
  console.log(`  已索引      ${db.count()} 张`);
  console.log(`  扫描目录    ${db.listRoots().map((r: { path: string }) => r.path).join(', ') || '(无)'}`);
  console.log('');
  console.log('  前端用 fetch 直接打这些地址,无需代理。');
  console.log('  Ctrl+C 退出。');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n正在退出…');
  scanAbort?.abort();
  db.close();
  server.close(() => process.exit(0));
});
