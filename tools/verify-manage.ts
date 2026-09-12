/**
 * 验证"管理能力"端到端可用 —— 按无依赖版页面实际调用的顺序打一遍 API。
 *
 * 为什么单独写:浏览能力已经验过,但**管理**(收藏 / 新建分类 / 改 名 / 删除 /
 * 把图加入或移出分类)是这一轮新接的。UI 里的按钮能不能用,取决于这些调用
 * 的组合是否真的成立、返回结构是否与页面假设一致。
 *
 * 用法:先起服务,再跑
 *   node --experimental-strip-types src\server\index.ts --port 5380
 *   node --experimental-strip-types tools\verify-manage.ts
 * 可用 CAM_API 覆盖地址。
 */

const BASE = process.env.CAM_API ?? 'http://127.0.0.1:5380';

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
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };
  return { status: res.status, ok: j.ok === true, data: j.data as T, error: j.error };
}

console.log('管理能力端到端验证');
console.log(`  目标  ${BASE}\n`);

// ---------------------------------------------------------------- 取几张图备用

const q = await api<{ ids: number[]; total: number }>('POST', '/api/query', {
  limit: 3,
  sort: 'mtime_desc',
});
if (!q.ok || q.data.ids.length < 3) {
  console.error(`无法取到测试图片(需要至少 3 张),total=${q.data?.total}`);
  process.exit(1);
}
const [idA, idB, idC] = q.data.ids;
console.log(`  测试图片 #${idA} #${idB} #${idC}\n`);

// ---------------------------------------------------------------- 1) 收藏

console.log('--- 1) 收藏(卡片右上角 ☆ 与详情面板「收藏」按钮)---');
{
  // 页面点☆时发的是 { starred: !当前值 }。先读当前值。
  const d0 = await api<{ starred: boolean }>('GET', `/api/image/${idA}`);
  if (!d0.ok) bad('读取图片详情失败');
  const was = d0.data.starred;

  const r1 = await api('POST', `/api/star/${idA}`, { starred: !was });
  if (r1.ok) good(`切换收藏 -> ${!was}`);
  else bad(`切换收藏失败: ${r1.error}`);

  const d1 = await api<{ starred: boolean }>('GET', `/api/image/${idA}`);
  if (d1.ok && d1.data.starred === !was) good('详情里读到新的收藏状态');
  else bad(`收藏状态未生效(期望 ${!was},实际 ${d1.data?.starred})`);

  // 只看收藏 的查询
  const qs = await api<{ total: number; ids: number[] }>('POST', '/api/query', {
    starredOnly: true,
    limit: 50,
  });
  if (qs.ok && qs.data.ids.includes(idA)) good(`starredOnly 查询命中 ${qs.data.total} 张,含目标图`);
  else bad('starredOnly 查询未包含刚收藏的图');

  // 还原
  await api('POST', `/api/star/${idA}`, { starred: was });
  const back = await api<{ starred: boolean }>('GET', `/api/image/${idA}`);
  if (back.ok && back.data.starred === was) good('已还原原收藏状态');
  else bad('还原失败');
}

// ---------------------------------------------------------------- 2) 新建 / 改名 / 删除

console.log('\n--- 2) 分类 CRUD(侧栏 + 新建「+ 新建」/ 改名 / 删)---');
let catId = 0;
{
  const c = await api<{ id: number; name: string; sortOrder: number }>('POST', '/api/categories', {
    name: '__manage_test__',
  });
  if (c.ok && c.data.id > 0) {
    catId = c.data.id;
    good(`新建分类 -> #${c.data.id}`);
  } else bad(`新建分类失败: ${c.error}`);

  if (catId) {
    // 页面新建后立刻 GET /api/categories 刷新侧栏
    const tree = await api<Array<{ id: number; name: string; totalCount: number; children: unknown[] }>>(
      'GET',
      '/api/categories'
    );
    const found = (tree.data ?? []).find((n) => n.id === catId);
    if (found) good(`侧栏能刷出该分类 (totalCount=${found.totalCount})`);
    else bad('侧栏刷不出新建的分类');

    // 改名
    const up = await api<{ name: string }>('PATCH', `/api/categories/${catId}`, {
      name: '__manage_test_renamed__',
    });
    if (up.ok && up.data.name === '__manage_test_renamed__') good('改名成功');
    else bad(`改名失败: ${up.error}`);

    // 重名要被拒绝(页面会把错误 toast 出来)
    const dup = await api('POST', '/api/categories', { name: '__manage_test_renamed__' });
    if (!dup.ok) good(`重名被拒绝: ${dup.error}`);
    else bad('重名竟然成功了,应拒绝');
    if (dup.ok) {
      // 清理掉误建的那个
      const t2 = await api<Array<{ id: number; name: string }>>('GET', '/api/categories');
      for (const n of t2.data ?? []) {
        if (n.name === '__manage_test_renamed__' && n.id !== catId) {
          await api('DELETE', `/api/categories/${n.id}?children=true`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------- 3) 成员管理

console.log('\n--- 3) 把图加入/移出分类(详情面板「+ 加入分类」勾选框)---');
{
  if (!catId) {
    bad('没有可用分类,跳过成员测试');
  } else {
    // 页面勾选时发的是 { imageIds:[id], member:true }
    for (const id of [idA, idB]) {
      const add = await api<{ changed: number }>('POST', `/api/categories/${catId}/members`, {
        imageIds: [id],
        member: true,
      });
      if (add.ok && add.data.changed === 1) good(`#${id} 加入分类`);
      else bad(`#${id} 加入失败(changed=${add.data?.changed})`);
    }

    // 详情面板会读这张图属于哪些分类
    const mine = await api<number[]>('GET', `/api/image/${idA}/categories`);
    if (mine.ok && mine.data.includes(catId)) good(`#${idA} 的所属分类里含该分类`);
    else bad(`#${idA} 的所属分类不含该分类:[${mine.data}]`);

    // 按分类查(点侧栏分类)
    const byCat = await api<{ total: number; ids: number[] }>('POST', '/api/query', {
      categoryId: catId,
      limit: 50,
    });
    if (byCat.ok && byCat.data.total === 2 && byCat.data.ids.includes(idA) && byCat.data.ids.includes(idB)) {
      good(`点侧栏分类能筛出这 2 张`);
    } else bad(`按分类查询结果不符(期望 2,实际 ${byCat.data?.total})`);

    // 取消勾选 -> 移出
    const rm = await api<{ changed: number }>('POST', `/api/categories/${catId}/members`, {
      imageIds: [idB],
      member: false,
    });
    if (rm.ok && rm.data.changed === 1) good('#idB 移出分类');
    else bad(`移出失败(changed=${rm.data?.changed})`);

    const after = await api<{ total: number }>('POST', '/api/query', { categoryId: catId, limit: 10 });
    if (after.ok && after.data.total === 1) good('移出后剩余 1 张');
    else bad(`移出后应为 1 张,实际 ${after.data?.total}`);
  }
}

// ---------------------------------------------------------------- 4) 子分类与删除

console.log('\n--- 4) 子分类 + 删除(含级联)---');
{
  if (!catId) {
    bad('没有可用分类,跳过');
  } else {
    const child = await api<{ id: number; parentId: number | null }>('POST', '/api/categories', {
      name: '__manage_test_child__',
      parentId: catId,
    });
    if (child.ok && child.data.parentId === catId) good(`子分类创建成功 -> #${child.data.id}`);
    else bad('子分类创建失败');

    if (child.ok && child.data.id) {
      // 子分类分到另一张图,并验证"点父分类能递归看到子分类的图"
      await api('POST', `/api/categories/${child.data.id}/members`, {
        imageIds: [idC],
        member: true,
      });
      const rec = await api<{ total: number; ids: number[] }>('POST', '/api/query', {
        categoryId: catId,
        limit: 50,
      });
      if (rec.ok && rec.data.ids.includes(idC)) good('点父分类递归包含子分类的图');
      else bad(`父分类未递归到子分类的图(total=${rec.data?.total})`);
    }

    // 删除父(带 children=true),页面删按钮就是这个参数
    const del = await api('DELETE', `/api/categories/${catId}?children=true`);
    if (del.ok) good('删除分类(含子分类)成功');
    else bad(`删除失败: ${del.error}`);

    // 删完后侧栏不该再有它;按它查询应为 0(而不是"不过滤")
    const tree3 = await api<Array<{ id: number }>>('GET', '/api/categories');
    if (!(tree3.data ?? []).some((n) => n.id === catId)) good('侧栏已不含被删分类');
    else bad('侧栏仍能看到被删分类');

    const empty = await api<{ total: number }>('POST', '/api/query', { categoryId: catId, limit: 5 });
    if (empty.ok && empty.data.total === 0) good('按已删分类查询 -> 0(空结果语义正确)');
    else bad(`应为 0,实际 ${empty.data?.total}`);

    // 图片本身不受影响
    const img = await api<{ id: number }>('GET', `/api/image/${idA}`);
    if (img.ok && img.data.id === idA) good('图片本身未受影响');
    else bad('图片读取异常');
  }
}

// ---------------------------------------------------------------- 5) 页面元素检查

console.log('\n--- 5) 无依赖版页面是否真的带这些入口 ---');
{
  const res = await fetch(`${BASE}/`);
  const html = await res.text();
  const NEED: Array<[string, string]> = [
    ['id="btnNewCat"', '侧栏「+ 新建」按钮'],
    ['id="modal"', '加入分类弹层'],
    ['id="btnAddCat"', '详情面板「+ 加入分类」'],
    ['/api/categories', '分类接口调用'],
    ['/api/star/', '收藏接口调用'],
    ['id="btnStar"', '只看收藏按钮'],
    ['class="star', '卡片上的收藏星标'],
    ['改名', '分类改名入口'],
    ['已加入', '加入分类的成功提示'],
  ];
  for (const [needle, why] of NEED) {
    if (html.includes(needle)) good(`页面含 ${why}`);
    else bad(`页面缺少 ${why} (${needle})`);
  }
  // 不能出现"采样器"这个字段的展示(用户已要求移除)
  const bodyOnly = html.replace(/<!--[\s\S]*?-->/g, '');
  if (bodyOnly.includes('采样器')) bad('页面里出现了「采样器」字样 —— 用户已要求移除');
  else good('页面未展示采样器(符合用户要求)');
}

console.log('\n' + (failures === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${failures} 项)`));
process.exit(failures === 0 ? 0 : 1);
