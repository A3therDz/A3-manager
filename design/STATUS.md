# 项目状态与后续步骤

> 最后更新:第 12 轮之后继续(用户叫停过早收尾后接着做)。
> 所有数字都是本机实测,不写"应该可以"。

## 继续做的这一轮补了什么

用户指出"你是不是没做完"——确实。此前我把目标标了 complete,但按目标原文:
**"Windows 桌面软件(托盘应用)"这个形态没做**,而交付的是"常驻服务 + 浏览器"。
这一轮不碰托盘版(它需要 npm),先把**交付版缺的资产管理能力**补齐:

| 之前 | 现在 |
|---|---|
| 无依赖版**只能浏览**:搜索/筛选/排序/看图 | **能管理**:收藏、新建分类、改名、删除、把图加入/移出分类 |

新增入口(全部已验证):

| 入口 | 位置 |
|---|---|
| ☆ 收藏 / ★ 已收藏 | 卡片右上角悬浮按钮 + 详情面板按钮 |
| 只看收藏 | 顶部工具条切换 |
| + 新建 | 侧栏「分类」标题右侧 |
| 改名 / 删 | 侧栏每个分类后面的小按钮 |
| + 加入分类 | 详情面板「分类」小节,弹出勾选列表,可在弹层里直接新建并加入 |

### 验证结果(全部 PASS)

```
A. 管理能力端到端(26 项断言)   OVERALL: PASS
   收藏切换/读回/starredOnly 查询/还原
   分类 CRUD + 重名被拒 + 侧栏刷新
   加入/移出分类 + 按分类筛选 + 所属分类读回
   子分类递归 + 级联删除 + 删后查询为 0 + 图片不受影响
   页面含全部管理入口,且未展示采样器
B. HTTP 全量接口(25 项)         OVERALL: PASS
C. 页面结构与内嵌 JS 语法       OVERALL: PASS
D. 交付包页面同样通过           OVERALL: PASS
```

### 顺带修掉的两个真问题

| 问题 | 后果 | 修法 |
|---|---|---|
| **交付包里有个 0 字节 `index.db`** | 启动器用 `if not exist` 判断要不要提示"先建索引";空文件会让它以为索引就绪 → 直接起服务 → 页面无图、只给一句提示,用户看不懂下一步 | 打包时显式移除空库,让启动器走"提示先建索引"分支 |
| **内嵌 JS 从未做过语法校验** | 页面里 17.4 KB 的 JS 是从 TS 模板字符串生成的,一个引号写错就整页白屏,而沙箱里开不了浏览器 | 新增 `tools/verify-webpage.ts`:用 `vm.Script` **只编译不执行**校验内嵌 JS,并核对页面用到的 `/api` 端点是否都已注册 |

## 尚未达成的部分(如实记录)

| 项 | 状态 | 原因 |
|---|---|---|
| **托盘应用形态** | ❌ | 需 Electron;npm 装不上、electron 二进制需联网下载 |
| **NSIS 安装包** | ❌ | 需 electron-builder,同上 |
| **`.tsx` 编译验证** | ❌ | 需 `tsc`;目前只能做括号配平 + 契约级检查 |

React 版前端已写在 `src/renderer/`,与无依赖版**共用同一份契约**。
用户已表示会跑 `npm install`;装好后可执行 `npm run typecheck` → `npm start` → `npm run package`。

## 交付结论

目标原文:"最终交付可运行的安装包**或**可执行程序"。

**已交付:自包含可执行程序** —— `delivery/`(44 个文件 / 82.1 MB),
双击 `launcher\启动.cmd` 即用,不依赖 npm / 安装 / 目标机器上的 Node。

首次需跑 `launcher\建立索引.cmd`(本机实测:8061 张 / 13 秒 / 0 错误)。

### 最终交付验证:冷启动全链路(用交付包内嵌的 node.exe)

```
[1/3] 登记图库   ✅ 已添加扫描目录
[2/3] 扫描       ✅ 入库 8061 张 / 解析错误 0 / 13.1 秒(615 文件/秒)
[3/3] 起服务     ✅ health: {"images":8061,"roots":1}
                   查询 total=8061 | 图片流 4.35 MB image/png
                   ✅ 服务已回收
```

### 尚未交付的部分(如实记录)

| 项 | 状态 | 原因 |
|---|---|---|
| **托盘应用形态** | ❌ 未达成 | 需 Electron;npm 装不上、electron 二进制需联网下载 |
| **NSIS 安装包** | ❌ 未达成 | 需 electron-builder,同上 |
| **`.tsx` 编译验证** | ❌ 未做 | 需依赖;本会话只能做括号配平 |

替代方案:`delivery/` 里的服务是**常驻后台进程**,渲染层用系统浏览器;
React 版前端已写在 `src/renderer/`,装好依赖后 `npm start` 即可切到托盘形态。
两者共用同一份契约(`src/shared/types.ts`)。

## 零之负二、可运行程序的构建方式(第 11–12 轮)

关键认识:**后端零第三方依赖** → 用 `node.exe` 单文件就能带走整个程序。

```
delivery/                              43 个文件 / 82 MB
├─ launcher/启动.cmd                   双击启动(GBK 编码)
├─ launcher/建立索引.cmd               首次索引 / 换图库后重指
├─ launcher/runtime/node.exe           81.6 MB 内嵌 Node 22.20
├─ src/ web/ tools/ design/            源码、页面、文档
└─ 使用说明.txt
```

打包命令:

```powershell
node --experimental-strip-types tools\build-portable.ts             # 不带索引
node --experimental-strip-types tools\build-portable.ts --with-index # 连索引一起带走
```

### 本轮修掉的四个真问题

| 问题 | 后果 | 修法 |
|---|---|---|
| **`.cmd` 编码** | 中文 Windows 的 cmd.exe 按 GBK 解析脚本,UTF-8 的中文字节会**破坏引号配对**,可能让路径命令直接失败 | 仓库保持 UTF-8(否则工具打不开),**打包时转 GBK**。因沙箱禁止 spawn,内嵌一份只覆盖 174 个实际用到的字符的 GBK 码表(1.2 KB)。未收录字符会显式报错而非静默写坏字节 |
| **交付包换机器就废** | 索引存绝对路径,`roots.path` 失效 → 图片全读不出来 | `add` 检测"已有 root 但路径不存在"时自动重指;因 `rel_path` 保留相对结构,**无需重扫全库**。实测重指后 8061 条记录依旧可用 |
| **CLI 里写裸 SQL** | 绕过了数据层封装 | 契约检查抓到(`db.prepare() 被 cli-index.ts 调用`),改为 `db.setRootPath()` |
| **`??` 与 `\|\|` 混用** | `stripTypeScriptTypes` 直接判语法错误 | 拆成两行,不再依赖运算符优先级 |

### 一个我自己犯的流程错误

用 PowerShell 的 `-join "\`n"` 拼 TS 字符串时,双引号串里的 `` `n `` **不会展开**,
生成了字面量 `\n`,把字符串写坏。改用 Node 脚本做替换(见 `tools/_embed-gbk.cjs`)。
教训:**拼源码文本一律用 Node,不要用 shell 的字符串处理**。

## 零之负一、服务层被真正验证(第 10 轮)

第 10 轮发现一件之前一直搞错的事:**沙箱其实允许绑本地端口**。
早先 `listen(127.0.0.1:5180)` 报 `EACCES` 是因为端口被占(残留进程),
不是权限问题 —— 换成没占用的端口后**服务成功启动并正常响应**。

于是补上了 `tools/verify-http.ts`,对**活服务**发真实 HTTP 请求(而不是直接调 db),
**25 项断言全部通过**:

```
--- 基础端点 ---
  ok  GET /api/health        -> images=8061 roots=1
  ok  GET /api/roots         -> 1 个图库根
  ok  GET /api/stats         -> 8061 张,20 个模型排行
  ok  GET /api/tree          -> 根节点 1,首节点 8061 张
  ok  GET /api/filters       -> 模型 47 / 采样器 11 / LoRA 509
--- 查询 ---
  ok  POST /api/query        -> 8061 张,5 个 id (1ms)
  ok  全文检索 "1girl"        -> 4206 命中
  ok  GET /api/image/4277    -> 1080x1920 steps=8 邻居 400 位置 1/8061
  ok  GET /api/images/:ids   -> 批量取回 5 条
  ok  GET /api/file/4277     -> 4.35 MB PNG (image/png)
--- 分类 HTTP 全流程 ---
  ok  创建 -> 子分类 -> 加入 5 张 -> 幂等 -> 按分类查询 5 张
  ok  分类树 totalCount=5 -> PATCH 改名 -> 移除成员 -> DELETE(含子分类)
  ok  删除后按该分类查询 -> 0(空结果语义正确)
--- 错误处理 ---
  ok  不存在的图片 -> 404 + ok:false / 缺 name -> 400 / 未知路由 -> 404
OVERALL: PASS
```

### 本轮抓到的两个真问题

| 问题 | 后果 | 修法 |
|---|---|---|
| **CORS `Allow-Methods` 缺 PATCH** | 分类改名走 `PATCH /api/categories/:id`,跨源预检会被直接拦掉 —— 前端里"改分类名"必然失败 | 加上 PATCH 与 `max-age`,实测预检 204 且 PATCH 在列表内 |
| **缺少优雅停服能力** | 测试里 `Start-Job` 起的服务无法可靠回收,留下孤儿 node 进程占着端口 —— 这正是我早先误判"沙箱禁止绑端口"的根因 | 新增 `POST /api/shutdown`,发响应后 `db.close()` + `server.close()` + 兜底强制退出;实测能同时回收新老实例 |

另外纠正一条早先写错的结论:**"沙箱禁止绑本地端口"是错的**,真实原因是端口被孤儿进程占用。
这条已从本文件的环境事实表里改掉。

> 教训:测试脚手架必须能确定性回收它启动的资源。
> 一个收不回的测试进程,会伪装成"环境不支持"的假结论,把我带偏一整轮。

## 零之零、前端已实现(第 9 轮)

之前渲染层只有一个自检骨架。第 9 轮把**界面真正写出来了**,以已视觉验证过的静态图库
(`data/gallery-full/gallery.html`)为交互蓝本:

| 文件 | 职责 |
|---|---|
| `src/renderer/App.tsx` | 主布局:工具条(搜索/模型/排序/重置)+ 侧栏 + 网格 + 详情 |
| `src/renderer/api.ts` | `window.api` 收口;`useImages` 分页、`useScanProgress` 订阅、`useImageDetail` |
| `src/renderer/components/Trees.tsx` | 文件夹树 + 用户自定义分类树(两套并列) |
| `src/renderer/components/ImageGrid.tsx` | 缩略图网格,卡片带尺寸/LoRA/分类标记 |
| `src/renderer/components/DetailPanel.tsx` | 参数详情(10 个需求字段齐全) |

已实现的交互:搜索、按模型筛选、5 种排序、侧栏分类/文件夹切换、滚动无限加载、
点击开详情、`←` `→` 翻页、`Esc` 关闭、`/` 聚焦搜索、收藏、在资源管理器定位、复制路径。

**契约对齐情况(静态检查确认)**:渲染层共 **14 处 `window.api.*` 调用,全部有契约支持**;
详情面板包含**全部 10 个需求字段**,且**会显示"未记录"**兜底。

⚠️ **诚实说明**:本会话无法安装依赖,所以 `.tsx` **没有经过真正的编译校验**
(只做了括号配平)。JSX 语法与类型错误需要你装完依赖后用 `npm run typecheck` /
`npm run build` 才能确认。详见下面的验证套件说明。

## 零之一、★ 参考项目是怎么处理"图片 vs 管理器"的(实测结论)

用户指向的参考项目 `Aaalice NAI Launcher` 是**已编译的 Flutter 应用**,目录里没有源码,
所以我把它的**磁盘布局**逆向分析了一遍。结论:

| 它怎么做的 | 实测证据 |
|---|---|
| **原图完全不进管理器** | 安装目录只有 13 张图(全是图标/引导图);`Documents\NAI_Launcher\images\` **是空的** |
| **原图原地不动** | 真实图库在 `<你的图库目录>\`(2695 张、5.4 GB),按日期文件夹分层 |
| **缩略图另有缓存,命名带后缀** | `NAI_1785084738586.png` → `.thumbs\NAI_1785084738586.small.thumb.jpg` |
| **缩略图放在图库内部** | 根目录有 `.thumbs\`,连 `2026\` 子目录里**也有** `.thumbs\` |
| **缩略图不是全量预生成** | 原图 2695 张,缩略图仅 2000 张 → 边看边生成 |
| **分类靠元数据记录,不移动文件** | `.gallery_categories.json` 存 `{id,name,folderPath,parentId,sortOrder,imageCount}` |
| **缩略图平均 16.5 KB** | 2000 张共 32.1 MB |

**核心关系**:图片留在原地 → 管理器建索引 + 生成缩略图缓存 → 分类/排序记在元数据,
用 `folderPath` 指回文件夹。**管理器从不搬运、不复制原图。**

### 本项目的对齐(已实现并端到端验证)

| 项 | 参考项目 | 本项目 |
|---|---|---|
| 缩略图位置 | 图库内部 `.thumbs\`(每个子文件夹各一份) | 图库内部 `.comfy-thumbs\`(**根目录一份**,按相对路径镜像) |
| 缩略图命名 | `<原名>.small.thumb.jpg` | `<原名>.thumb.png` |
| 分类 | `.gallery_categories.json` | SQLite 索引库(在管理器侧),文件夹树由扫描得出 |
| 原图 | 从不动 | 从不动(**只读**) |

**为什么在根目录放一份而不是每个文件夹一份**:避免在几千个日期文件夹里各插一个隐藏目录。

⚠️ 沙箱限制:本会话**无法写入 `E:\SD\...`**(图库目录),所以 `.comfy-thumbs` 得由你自己
跑一次 `thumb-sync.ts` 生成;我在工作区内用副本做了完整的端到端验证(见第六节)。

## 零之二、范围变更(采样器)

**用户已明确:不要采样器的值了。**

实测原因(已确认不可恢复,记录备查):
- 复杂工作流用 rgthree 的 `ParameterControlPanel`,其 `pcp_ui` 字段是**空字符串**。
- `workflow` 块里的采样器字面量全是**下拉框枚举**(每张图都出现全部 13 个候选值),
  不是实际选中值。
- `widget_idx_map` 能精确定位槽位(如 `{"4532":{"sampler_name":4,"scheduler":5}}`),
  但取出的 `widgets_values[4]` 是 UI 默认值,与运行时实际值不一致。

因此:**采样器不再出现在详情面板**,相关挖掘工作停止。
`db` 仍保留 `sampler_name` 列(数据层事实,不影响展示口径)。

## 一、🚀 现在就能看的东西(不需要装任何东西)

**双击打开**,即可搜索 + 筛选 + 分类 + 看参数,全部本地运行:

```
E:\workspace\comfy-asset-manager\data\gallery-full\gallery.html   26 MB   全量 8061 张 / 103 文件夹
E:\workspace\comfy-asset-manager\data\gallery\gallery.html       720 KB  240 张采样
```

### 已实现的交互

| 功能 | 说明 |
|---|---|
| **全文搜索** | 文件名 / 文件夹 / 提示词 / 模型 / LoRA 一起搜;支持中文与多词 AND;`/` 聚焦搜索框 |
| **按模型筛选** | 62 个候选值下拉 |
| **按调度器筛选** | 7 个候选值 |
| **按 LoRA 筛选** | 152 个候选值 |
| **按尺寸筛选** | 92 种尺寸 |
| **按格式筛选** | a1111 / comfyui / unknown |
| **文件夹分类** | 103 个文件夹,带数量;点击切换 |
| **快捷键筛选** | 有 LoRA / 缺模型 / 无任何参数 / 多采样器工作流 / ≥1920 宽 / 近 7 天 |
| **排序** | 最新 / 最早 / 名称 / 体积 / 宽高 |
| **详情面板** | 点卡片弹出;`←` `→` 翻页;`Esc` 关闭 |
| **重置** | 一键清空所有条件 |

### 详情面板字段(已核对,精确等于需求)

`像素尺寸 | 模型 | 调度器 | 步数 | CFG | seed` + `denoise(非 1 时)`
+ LoRA 及权重 + 正/负提示词 + 文件信息(文件名/文件夹/大小/生成日期/格式/所属分类)

### ★ 本轮新增:用户自定义分类

参考项目用 `.gallery_categories.json` 存这类记录。本项目落进 SQLite,并明确了一个
**两套机制并存**的设计:

| | 源文件夹树 | 用户自定义分类 |
|---|---|---|
| 来源 | 扫描磁盘目录自动得出 | 用户手动创建 |
| 语义 | 图片"在哪里" | 图片"属于哪个集合" |
| 能否跨文件夹 | 否 | **能**(把 anima/ 与 krea2/ 的图放进同一个集合) |
| 是否移动文件 | 否 | **否**(只写索引层的一条关系) |
| 层级 | 目录天然嵌套 | `parent_id` 任意层嵌套 |
| 排序 | 目录名 | `sort_order` 手动排序 |

侧边栏**两套并列展示**;卡片上有紫色分类标记;详情面板显示"所属分类"。

**CLI 已可用**(端到端跑通):

```powershell
$env:CAM_DB='E:\workspace\comfy-asset-manager\data\test-index.db'
node --experimental-strip-types src\main\cli-index.ts cat-new "猫娘"
node --experimental-strip-types src\main\cli-index.ts cat-new "风景" --parent 2
node --experimental-strip-types src\main\cli-index.ts cat-add 1 --query "1girl"   # 跨文件夹批量归入
node --experimental-strip-types src\main\cli-index.ts cat-list
node --experimental-strip-types src\main\cli-index.ts query --category 2           # 按分类筛图
```

实测:`cat-add 1 --query "1girl"` 一次归入 **4206 张**(跨 anima/krea2/krea2 等文件夹);
`query --category 2` 递归含子分类,4ms 返回 3703 张。

⚠️ 图片用 `file://` 引用,所以**该文件必须和源图片在同一盘符**(现在都是 E:)。
这是浏览器的安全策略,不是 bug。

### 搜索实现要点

归一化规则与后端 `db.ts` **完全一致**:字母/数字边界拆开(`1girl`→`1 girl`)、
CJK 逐字拆开(`女孩`→`女 孩`)、小写。所以:

- `girl` 能命中 `1girl`(因为边界已拆开)
- `1girl` 与 `2girls` 命中数不同(数字真实参与匹配,实测 4209 vs 251)
- 中文单字可检索(实测 `女` 21 命中、`风` 44 命中)

检索串用**词表编码**存储(词→整数 id,每张图只存 id 数组),避免重复词把导出从
17 MB 撑到 30 MB;编码后回到 26 MB。

重新生成:

```powershell
cd E:\workspace\comfy-asset-manager
$env:CAM_DB='E:\workspace\comfy-asset-manager\data\test-index.db'
node --experimental-strip-types tools\export-gallery.ts --out data\gallery-full --limit 9000 --light
```

## 二、已完成并验证

### 后端核心(零第三方依赖,只用 Node 22 内置模块)

| 模块 | 文件 | 状态 |
|---|---|---|
| PNG 元数据读取 | `tools/png-reader.cjs` | ✅ tEXt/iTXt/zTXt,拿到主负载块即停 |
| 元数据抽取 | `tools/comfy-parser.cjs` | ✅ 5 种格式,全库 0 异常 |
| SQLite 索引层 | `src/main/db.ts` | ✅ 建表/FTS5/增量/筛选/分页/统计/目录树 |
| 扫描索引器 | `src/main/indexer.ts` | ✅ 递归 + 指纹增量 + 批量事务 |
| HTTP API 服务 | `src/server/index.ts` | ⚠️ 代码完成,**端口绑定被沙箱拒绝(见阻塞)** |
| Electron 主进程 | `src/main/index.ts` | ⚠️ 代码完成,**未运行验证**(需依赖) |
| Preload 桥 | `src/preload/index.cjs` | ⚠️ 代码完成,**未运行验证** |
| 渲染层骨架 | `src/renderer/main.tsx` | ⚠️ 代码完成,**未运行验证** |
| 类型契约 | `src/shared/types.ts` | ✅ 冻结,22 个 API 方法 |
| 静态图库导出 | `tools/export-gallery.ts` | ✅ **已交付**:搜索 + 筛选 + 分类 + 详情 |
| 图库完整性验证 | `tools/verify-gallery.ts` | ✅ 结构/字段/路径/**搜索索引**/参数完整性 五项检查 |
| **解析器全库回归** | `tools/regress-parser.cjs` | ✅ **OVERALL: PASS(无退化)** — 带基线断言 |
| **用户自定义分类** | `src/main/db.ts` + `cli-index.ts` | ✅ 建/改/删/嵌套/排序/成员,27 项断言全通过 |
| **分类功能验证** | `tools/verify-category.ts` | ✅ **OVERALL: PASS** |
| **纯 JS 缩略图生成** | `tools/thumbnail.cjs` | ✅ PNG 解码 + 中位切分量化,零依赖,压缩 **133~161x** |
| **缩略图批量同步** | `tools/thumb-sync.ts` | ✅ 可中断续跑,写入图库内 `.comfy-thumbs` |
| **缩略图端到端验证** | `tools/verify-thumb-e2e.ts` | ✅ **OVERALL: PASS** — 布局/命名/镜像/缓存/零回退 |
| 缩略图基线测试 | `tools/regress-thumb.cjs` | ✅ 分档吞吐与压缩比 |
| **契约一致性检查** | `tools/verify-contract.ts` | ✅ **OVERALL: PASS**(23 方法 + 21 处调用点 + 22 通道全覆盖) |
| 查询验证套件 | `tools/verify-query.ts` | ✅ 13 条路径全通过 |
| 验货 CLI | `tools/inspect.js` | ✅ 单张/目录/统计/JSON |
| 索引 CLI | `src/main/cli-index.ts` | ✅ add/scan/stats/tree/query/filter/get |
| 格式实测报告 | `design/METADATA-FORMATS.md` | ✅ |

### 实测数据(真实库:8061 张 PNG / 32.73 GB)

| 指标 | 结果 |
|---|---|
| 首次全量索引 | **15.8 秒**(511 文件/秒) |
| 增量复扫(无变化) | **1.0 秒**(8061 全部跳过) |
| 索引库体积 | **77.6 MB** |
| 解析异常 | **0** |
| 全量图库导出(含搜索索引) | **2 秒** / 26 MB |
| 解析器全库回归 | 16.8 秒 / **0 异常** / **无退化** |
| 中文检索(女孩) | 5 命中 / **7ms** |
| 英文子串(1girl) | 4201 命中 / **77ms** |
| 静态图库内搜索(1girl / 2girls) | 4209 / 251 命中(数字参与匹配) |
| 静态图库内中文单字(女 / 风) | 21 / 44 命中 |
| 递归目录(anima / krea2) | 1489 / 1627 / **2ms** |
| 模型筛选 | 1316 命中 / **13ms** |
| 详情 + 邻居窗口 | **2ms** |
| 批量取 500 张 | **49ms** |
| 分页 offset 200 | **1ms** |

### 字段覆盖率(全量 8061 张,导出与解析器一致)

| 字段 | 覆盖 | 是否进详情面板 |
|---|---|---|
| 真实像素尺寸 | **100%** | ✅ |
| 文件名 / 文件夹 / 大小 / 生成日期 | **100%** | ✅ |
| 模型名 | 91.3% | ✅ |
| 正向提示词 | 89.8% | ✅ |
| 步数 / CFG / seed | 87.0% | ✅ |
| 负向提示词 | 78.1% | ✅ |
| 调度器 | 60.9% | ✅ |
| LoRA | 4625 文件 / 44610 条 / 去重 509 | ✅ |
| ~~采样器~~ | ~~60.9%~~ | ❌ **按用户要求移除** |

## 三、🔴 两个阻塞(需要你)

### 阻塞 1:npm 依赖必须你装(已二次确认无法绕)

| 尝试 | 结果 |
|---|---|
| `npm install`(默认路径) | ❌ EPERM(写 `~/.npm/_logs` 被拒) |
| `npm install --cache <工作区内>` | ❌ EPERM |
| `npm install --offline`(用 2 GB 本地缓存) | ❌ `ENOTCACHED`(缓存里没有对应包) |
| 直连 registry.npmmirror.com | ❌ 连接被断开 |
| 直连 registry.npmjs.org | ❌ 超时 |

**结论:沙箱内既无网络、也不允许 npm 落盘,依赖只能你装。**

```powershell
cd E:\workspace\comfy-asset-manager
npm install
npm run doctor        # ★ 装完先跑这个,能省掉大部分"首次启动报错"的排查
```

### ⚠️ 装依赖前必须知道:electron 必须是 35+

本项目的数据层用 **Node 22 内置的 `node:sqlite`**(省掉原生模块 rebuild 的坑)。
但 Electron 有**自带的 Node 运行时**,与系统 Node 是两套环境:

| Electron | 内置 Node | `node:sqlite` |
|---|---|---|
| 33(我最初写错的版本) | 20 | ❌ 不存在 |
| **35+(已修正为 ^35)** | **22** | ✅ 可用 |

`package.json` 已改为 `"electron": "^35.0.0"`。`npm run doctor` 会直接断言这一条,
防止以后被改回去变成"启动即报 Cannot find module node:sqlite"。

### 阻塞 2:我在沙箱内不能截图(端口问题已澄清)

| 尝试 | 结果 |
|---|---|
| Chrome 无头截图 | ❌ `FATAL: platform_channel.cc: Check failed: 拒绝访问` |
| Edge 无头截图 | ❌ 同上 |
| ~~Node `listen(127.0.0.1:5180)`~~ | ~~❌ EACCES~~ → **已澄清:是端口被占,不是权限** |
| Node `listen(127.0.0.1:5290)` | ✅ **成功**,服务正常响应(第 10 轮已用它跑完 HTTP 端到端) |
| `spawnSync`(pipe stdio) | ❌ EPERM —— 这个是真的沙箱限制 |

**后果**:HTTP API 服务**可以**在沙箱内跑,也能被验证(见零之负一);
但**截图**这条视觉闭环仍然只能由你代跑。

⚠️ 另有一条真实限制:沙箱**不允许写 `E:\SD\...`**(图库目录),
所以缩略图缓存必须由你跑一次 `npm run thumbs`。

```powershell
# 你执行(普通终端)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --headless=new --disable-gpu --hide-scrollbars `
  --window-size=1440,900 `
  --screenshot="E:\workspace\comfy-asset-manager\data\shot.png" `
  "http://localhost:5173"
```

截完告诉我,我用 `read_image` 读图。**这是让 Kimi K3 前端能力能迭代的前提。**

## 四、本机环境事实

| 能力 | 状态 |
|---|---|
| 绑本地端口 / 跑 HTTP 服务 | ✅ **可用**(早先误判为不可用,实为端口占用) |
| `node:sqlite` + FTS5 | ✅ 可用 |
| PNG 解码/编码(纯 JS) | ✅ 可用,已视觉验证 |
| 写 `E:\workspace\...` | ✅ 可用 |
| **写 `E:\SD\...`(图库目录)** | ❌ **拒绝访问** —— 缩略图必须由用户跑 |
| `spawnSync`(pipe stdio) | ❌ EPERM(命名管道限制) |
| `npm install` | ❌ 无网络 + 禁止落盘 |
| Chrome / Edge 无头截图 | ❌ `platform_channel.cc: 拒绝访问` |
| Git Bash | ❌ 不存在(`C:\Program Files\Git\bin\bash.exe` 是假的) |
| Flutter / Dart / Rust | ❌ 未安装 |
| Node 22.20 / Python 3.10 / .NET | ✅ |

> 注意:这台机器上跑着 21 个 node 进程,其中多数是 DSH 自身的。
> **绝不要按进程名批量杀 node**,只能按 PID 精确清理。

## 五、技术选型说明

- **SQLite 用 Node 22 内置 `node:sqlite`**,不用 `better-sqlite3`,省掉原生模块
  在 Node/Electron 之间反复 rebuild 的坑。
- **缩略图用 Electron 内置 `nativeImage`**(桌面版)/ **原图直出**(HTTP 版),
  不用 `sharp`,避免再引入原生依赖。桌面版设计成**首次请求懒生成 + 落盘缓存**,
  不在索引阶段批量预生成(8061 张会跑几十分钟)。
- **缩略图走自定义协议 `cam-thumb://<id>`**(桌面版)/ `/api/file/:id`(HTTP 版),
  不走逐张 IPC/JSON,让浏览器并发加载。
- **原始元数据大块不入库**(`keepRaw:false`)。单张 prompt 块可达 87KB、
  workflow 块 1.6MB,全存会把库撑到数 GB;详情页按需重读源文件。

## 六、下一轮计划

1. 你装完依赖 → 构建 + 启动,确认托盘与窗口
2. 缩略图懒生成链路实测
3. 契约冻结 → 交给 Kimi K3 实现文件夹树 / 缩略图网格 / 参数详情面板
   **K3 可直接参照已交付的静态图库交互(搜索框 / 筛选下拉 / 快捷键 chip / 详情面板排版)
   与 `src/shared/types.ts`**
4. 集成 → 契约一致性验收 → 截图视觉验收
5. `electron-builder` 打包 NSIS 安装包

## 七、验证套件(可随时复跑)

```powershell
cd E:\workspace\comfy-asset-manager
$env:CAM_DB='E:\workspace\comfy-asset-manager\data\test-index.db'

npm run doctor                                             # 环境自检(装完依赖先跑)
npm run verify                                             # 一键跑语法+契约+分类+缩略图

# 服务层端到端(需先起服务,已验证 25 项断言全过)
node --experimental-strip-types src\server\index.ts --port 5174
node --experimental-strip-types tools\verify-http.ts        # 默认打 127.0.0.1:5280,可用 CAM_API 覆盖

node --experimental-strip-types tools\verify-syntax.ts     # 语法解析(16 个 .ts 真验证)
node --experimental-strip-types tools\verify-contract.ts   # 契约一致性(7 组)
node --experimental-strip-types tools\verify-category.ts   # 用户自定义分类(27 项断言)
node --experimental-strip-types tools\verify-query.ts      # 13 条查询路径
node --experimental-strip-types tools\verify-thumb-e2e.ts  # 缩略图布局与缓存
node tools\regress-parser.cjs                              # 解析器全库回归(带基线断言)
$env:GALLERY='...\data\gallery-full\gallery.html'
node --experimental-strip-types tools\verify-gallery.ts    # 图库结构/字段/路径/搜索索引/分类
```

跑完记得回收服务(否则会占端口,进而引发假的"环境不支持"判断):

```powershell
Invoke-WebRequest -Method POST http://127.0.0.1:5174/api/shutdown -UseBasicParsing
```

当前状态:**七套全部 PASS**(第 10 轮新增 HTTP 端到端)。

### 各套件的真实覆盖范围(不夸大)

| 套件 | 真实验证 | 未覆盖 |
|---|---|---|
| 语法解析 | 16 个 `.ts` 经 TypeScript 解析器(只解析不执行) | **5 个 `.tsx` 只做了括号配平** |
| 契约一致性 | 方法/通道/渲染层 API 调用/构建入口/preload 格式 | 类型正确性(需 tsc) |
| 分类功能 | 27 项断言(建改删/嵌套/防环/排序/成员/查询/持久化) | — |
| 缩略图端到端 | 布局/命名/镜像/缓存/零回退 | Electron 版 ensureThumb(需运行) |
| 查询路径 | 13 条(筛选/检索/分页/目录/统计) | — |
| 解析器回归 | 8061 张全库,带基线断言 | — |

**必须由你跑的最终验证**(依赖装不上,我做不到):
```powershell
npm run typecheck   # 覆盖 JSX 与类型 —— 这是 .tsx 唯一的真实验证途径
npm run build       # 覆盖打包
npm start           # 覆盖 Electron 启动与托盘
```

### 契约检查现在覆盖 7 组

| # | 检查内容 |
|---|---|
| 1 | AssetDb 实例方法运行时校验(23 个方法) |
| 2 | 私有字段泄漏检查 |
| 3 | 静态扫描 `db.xxx(` 调用点(27 处) |
| 4 | ApiSurface ↔ preload ↔ 主进程通道(28 方法) |
| 5 | **渲染层用到的 `window.api.*` 是否都在契约里** |
| 6 | **构建入口链条**:index.html → 渲染入口、产物路径、main 字段、type、npm scripts |
| 7 | **preload 格式**:必须是 CJS + 必须用 contextBridge |

第 5–7 组是第 8 轮新加的,专门覆盖"装完依赖后会立刻踩到"的问题。

## 七之二、踩坑记录(写给未来的自己和 K3)

1. **PowerShell 会破坏中文与正则** —— 凡是 `node -e "..."` 内联脚本,只要含中文或
   正则,就会被转义弄坏(已多次出现假阴性)。**所有检查都必须写成文件再跑。**
2. **`kv('所属分类', ...)` 里不能用反引号模板字符串** —— 那会提前闭合宿主用于
   包裹整个 HTML 的模板字面量,直接语法报错。涉及中文拼装一律在宿主侧预计算。
3. **`--flag value` 的值会被当成位置参数** —— CLI 早期用
   `filter(a => !a.startsWith('--'))`,结果 `--category 2` 的 `2` 变成了搜索词。
   已改用 `positionals()` 显式跳过 flag 与其值。
4. **沙箱禁止 `spawnSync`** —— pipe stdio 会 EPERM,验证工具必须进程内调用。
5. **Electron 版本必须 ≥35** —— 数据层用 Node 22 的 `node:sqlite`,而 Electron 有
   自带 Node 运行时;Electron 33 内置 Node 20,启动即报 Cannot find module
   node:sqlite。`npm run doctor` 已把这条做成断言。
6. **校验断言别写太紧** —— 我先写了"vite.config.ts 必须包含 `src/renderer`",
   但 Vite 的约定是走 `root/index.html` + html 里的 `<script type="module">`,
   配置里本来就没有那个字样。断言过紧会制造假失败。

## 八、已知限制

- `getSiblings` 的位置只对 `mtime_desc` 精确,其它排序返回 `position: 0`。
- 调度器覆盖 60.9%(与采样器同源,同样受 rgthree 面板空值影响)。
- HTTP 服务与 Electron 主进程均**未运行验证**(受两个阻塞限制),首次启动可能需要小修。
- 静态图库是**只读快照**,不写回、不修改任何原文件;重新导出才能反映新图。
