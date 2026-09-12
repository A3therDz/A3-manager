/**
 * HTTP API 端到端验证 —— 打真正的 server(不是直接调 db)。
 *
 * 为什么需要:之前所有验证都是直接调 AssetDb,服务层(src/server/index.ts)
 * 从未被真正执行过。这个脚本对活服务发真实 HTTP 请求,覆盖前端会用的全部端点,
 * 包括完整的分类 CRUD 流程。
 *
 * 用法:先起服务,再跑本脚本
 *   node --experimental-strip-types src\server\index.ts --port 5280
 *   node --experimental-strip-types tools\verify-http.ts
 * 可用 CAM_API 指定地址:
 *   $env:CAM_API='http://127.0.0.1:5280'
 */

const BASE = process.env.CAM_API ?? 'http://127.0.0.1:5280';

let failures = 0;
const good = (m: string) => console.log('  ok    ' + m);
const bad = (m: string) => {
  failures++;
  console.log('  FAIL  ' + m);
};

async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; ok: boolean; data: T; error?: string }> {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };
  return { status: res.status, ok: json.ok === true, data: json.data as T, error: json.error };
}

console.log('HTTP API 端到端验证');
console.log(`  目标  ${BASE}\n`);

// ---------------------------------------------------------------- 健康与只读端点

console.log('--- 基础端点 ---');
const health = await api<{ service: string; images: number; roots: number }>('GET', '/api/health');
if (health.ok && health.data.images >= 0) {
  good(`GET /api/health -> images=${health.data.images} roots=${health.data.roots}`);
} else {
  bad(`GET /api/health 失败: ${health.error ?? health.status}`);
}

const roots = await api<Array<{ id: number; path: string }>>('GET', '/api/roots');
if (roots.ok && Array.isArray(roots.data)) good(`GET /api/roots -> ${roots.data.length} 个图库根`);
else bad('GET /api/roots 失败');

const stats = await api<{ totalImages: number; topModels: unknown[] }>('GET', '/api/stats');
if (stats.ok && typeof stats.data.totalImages === 'number') {
  good(`GET /api/stats -> ${stats.data.totalImages} 张,${stats.data.topModels.length} 个模型排行`);
} else bad('GET /api/stats 失败');

const tree = await api<Array<{ totalCount: number; children: unknown[] }>>('GET', '/api/tree');
if (tree.ok && Array.isArray(tree.data) && tree.data.length > 0) {
  good(`GET /api/tree -> 根节点 ${tree.data.length},首节点 ${tree.data[0].totalCount} 张`);
} else bad('GET /api/tree 失败或为空');

const filters = await api<{ models: string[]; samplers: string[]; loras: string[] }>(
  'GET',
  '/api/filters'
);
if (filters.ok) {
  good(
    `GET /api/filters -> 模型 ${filters.data.models.length} / 采样器 ${filters.data.samplers.length} / LoRA ${filters.data.loras.length}`
  );
} else bad('GET /api/filters 失败');

// ---------------------------------------------------------------- 查询

console.log('\n--- 查询 ---');
const q1 = await api<{ ids: number[]; total: number; tookMs: number }>('POST', '/api/query', {
  limit: 5,
  sort: 'mtime_desc',
});
if (q1.ok && q1.data.ids.length === 5) {
  good(`POST /api/query 无筛选 -> ${q1.data.total} 张,返回 5 个 id (${q1.data.tookMs}ms)`);
} else bad(`POST /api/query 失败: ${q1.error ?? ''}`);

const q2 = await api<{ total: number }>('POST', '/api/query', { q: '1girl', limit: 1 });
if (q2.ok && q2.data.total > 0) good(`POST /api/query 全文检索 "1girl" -> ${q2.data.total} 命中`);
else bad(`全文检索失败(期望 >0,实际 ${q2.data?.total})`);

const q3 = await api<{ total: number }>('POST', '/api/query', { limit: 1, sort: 'mtime_desc' });
const firstId = q1.data.ids[0];
if (q3.ok) good('POST /api/query 分页参数可用');

// 单个图片详情与所属分类
if (firstId) {
  const detail = await api<{
    id: number;
    fileName: string;
    dimensions: { width: number; height: number } | null;
    meta: { sampler: { steps: number | null } | null; prompts: unknown[] } | null;
    siblings: number[];
    position: number;
    total: number;
  }>('GET', `/api/image/${firstId}`);
  if (detail.ok && detail.data.id === firstId) {
    const d = detail.data;
    good(
      `GET /api/image/${firstId} -> ${d.fileName.slice(0, 28)} ` +
        `${d.dimensions ? d.dimensions.width + 'x' + d.dimensions.height : '无尺寸'} ` +
        `steps=${d.meta?.sampler?.steps ?? '-'} 邻居 ${d.siblings.length} 位置 ${d.position}/${d.total}`
    );
    // 详情必须带 rawPromptJson 字段(列表投影里为 null,详情里应有值)
    if ('siblings' in d && 'position' in d) good('详情包含 siblings / position / total');
    else bad('详情缺少翻页所需字段');
  } else bad(`GET /api/image/${firstId} 失败`);

  const cats = await api<number[]>('GET', `/api/image/${firstId}/categories`);
  if (cats.ok && Array.isArray(cats.data)) good(`GET /api/image/${firstId}/categories -> [${cats.data}]`);
  else bad('GET /api/image/:id/categories 失败');

  const batch = await api<unknown[]>('GET', `/api/images/${q1.data.ids.join(',')}`);
  if (batch.ok && batch.data.length === q1.data.ids.length) {
    good(`GET /api/images/:ids -> 批量取回 ${batch.data.length} 条`);
  } else bad(`批量取回失败(${batch.data?.length})`);
}

// 图片字节流单独验(不是 JSON)
{
  const res = await fetch(`${BASE}/api/file/${firstId}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const ct = res.headers.get('content-type') ?? '';
  if (res.ok && isPng) good(`GET /api/file/${firstId} -> ${(buf.length / 1048576).toFixed(2)} MB PNG (${ct})`);
  else bad(`图片字节流异常: status=${res.status} png=${isPng} ct=${ct}`);
}

// ---------------------------------------------------------------- 分类全流程

console.log('\n--- 用户自定义分类(HTTP 全流程)---');
const created = await api<{ id: number; name: string; sortOrder: number }>('POST', '/api/categories', {
  name: '__http_test__',
  description: '由 verify-http 创建',
});
if (created.ok && created.data.id > 0) good(`POST /api/categories -> #${created.data.id} ${created.data.name}`);
else bad(`创建分类失败: ${created.error ?? ''}`);

const catId = created.data?.id;
if (catId) {
  // 子分类
  const child = await api<{ id: number; parentId: number | null }>('POST', '/api/categories', {
    name: '__http_test_child__',
    parentId: catId,
  });
  if (child.ok && child.data.parentId === catId) good(`创建子分类 -> #${child.data.id}`);
  else bad('创建子分类失败');

  // 加成员
  const ids = q1.data.ids;
  const add = await api<{ changed: number }>('POST', `/api/categories/${catId}/members`, {
    imageIds: ids,
    member: true,
  });
  if (add.ok && add.data.changed === ids.length) good(`加入成员 ${add.data.changed} 张`);
  else bad(`加入成员失败(期望 ${ids.length},实际 ${add.data?.changed})`);

  // 幂等
  const again = await api<{ changed: number }>('POST', `/api/categories/${catId}/members`, {
    imageIds: ids,
    member: true,
  });
  if (again.ok && again.data.changed === 0) good('重复加入是幂等的(changed=0)');
  else bad(`重复加入不幂等: changed=${again.data?.changed}`);

  // 按分类查询
  const byCat = await api<{ total: number; ids: number[] }>('POST', '/api/query', {
    categoryId: catId,
    limit: 50,
  });
  if (byCat.ok && byCat.data.total === ids.length) {
    good(`按分类查询 -> ${byCat.data.total} 张(与加入数一致)`);
  } else bad(`按分类查询结果不符(期望 ${ids.length},实际 ${byCat.data?.total})`);

  // 分类树应包含它
  const tree2 = await api<Array<{ id: number; totalCount: number; children: Array<{ id: number }> }>>(
    'GET',
    '/api/categories'
  );
  const found = tree2.data?.find((c) => c.id === catId);
  if (found && found.totalCount === ids.length) {
    good(`分类树含新建分类,totalCount=${found.totalCount}`);
  } else bad(`分类树里找不到或计数不符(totalCount=${found?.totalCount})`);

  // PATCH 改名
  const renamed = await api<{ name: string }>('PATCH', `/api/categories/${catId}`, {
    name: '__http_test_renamed__',
  });
  if (renamed.ok && renamed.data.name === '__http_test_renamed__') good('PATCH 改名成功');
  else bad(`PATCH 改名失败: ${renamed.error ?? ''}`);

  // 删成员
  const rm = await api<{ changed: number }>('POST', `/api/categories/${catId}/members`, {
    imageIds: [ids[0]],
    member: false,
  });
  if (rm.ok && rm.data.changed === 1) good('移除成员成功');
  else bad(`移除成员失败: changed=${rm.data?.changed}`);

  // DELETE 带子分类
  const del = await api('DELETE', `/api/categories/${catId}?children=true`);
  if (del.ok) good('DELETE 分类(含子分类)成功');
  else bad(`删除分类失败: ${del.error ?? ''}`);

  // 删除后按该分类查询必须是空结果(而不是"不过滤")
  const after = await api<{ total: number }>('POST', '/api/query', { categoryId: catId, limit: 5 });
  if (after.ok && after.data.total === 0) good('删除后按该分类查询 -> 0(空结果语义正确)');
  else bad(`删除后仍查出 ${after.data?.total} 张`);
}

// ---------------------------------------------------------------- 错误处理

console.log('\n--- 错误处理 ---');
const notFound = await api('GET', '/api/image/99999999');
if (!notFound.ok && notFound.status === 404) good('不存在的图片 -> 404 + ok:false');
else bad(`不存在的图片应返回 404,实际 status=${notFound.status} ok=${notFound.ok}`);

const badCat = await api('POST', '/api/categories', {});
if (!badCat.ok && badCat.status === 400) good('缺 name 创建分类 -> 400');
else bad(`缺 name 应返回 400,实际 ${badCat.status}`);

const unknown = await api('GET', '/api/definitely_not_a_route');
if (!unknown.ok && unknown.status === 404) good('未知路由 -> 404');
else bad(`未知路由应返回 404,实际 ${unknown.status}`);

// ---------------------------------------------------------------- 汇总

console.log('\n' + (failures === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${failures} 项)`));
process.exit(failures === 0 ? 0 : 1);
