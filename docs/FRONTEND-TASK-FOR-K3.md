# 前端实现任务书 —— 写给 Kimi K3

> 这是一份**自包含**的交接文档。你(实现者)看不到之前的对话,所以本文把所有
> 必要背景、契约、约束、验收标准都写全了。
>
> 项目路径:`E:\workspace\comfy-asset-manager`
> 当前状态:**后端完整可用且已验证;前端已有可运行的基线实现(`tsc --noEmit` 0 错误);
> 本文档要求你在此基础上做视觉与交互精修,而不是从零重写。**

---

## 0. 一句话背景

一个管理 ComfyUI 出图的本地工具:分文件夹浏览、缩略图网格、点开看完整生成参数。
有 **8061 张真实图片 / 32.7 GB** 的库可用于验证。

---

## 1. 铁律(违反会导致返工)

1. **不要改 `src/shared/types.ts`。** 它是冻结的接口契约,前端只读。
   需要新字段 → 先在文档里提出,不要自己动手。
2. **不要改后端**(`src/main/`、`src/server/`、`src/main/db.ts`、`tools/*.cjs`)。
   后端已验证通过,你只做 `src/renderer/`。
3. **不要发明新的 `window.api.*` 方法。** 只有 `ApiSurface` 里声明的那 28 个可用。
   调用不存在的方法,`tools/verify-contract.ts` 会直接报 FAIL。
4. **不要展示"采样器"。** 用户明确要求移除该字段(`samplerName` 仍在契约里,
   但界面上不得出现)。`tools/verify-contract.ts` 有护栏会检查这一点。
5. **数据缺失必须显示"未记录"**,不能留空。约 39% 的图没有调度器、22% 没有负向提示词,
   这是数据本身的常态,不是 bug。
6. **不要用 `as any` / `@ts-ignore` 绕过类型。** `npm run typecheck` 必须 0 错误。

---

## 2. 技术栈与运行方式

| 项 | 值 |
|---|---|
| 语言 | TypeScript(strict) |
| 框架 | React 18 |
| 构建 | Vite 6 |
| 桌面外壳 | Electron 35(**必须 ≥35**,33 内置 Node 20,没有 `node:sqlite`) |
| 样式 | 内联 `style` 对象 + `main.tsx` 里的全局 CSS |

```powershell
cd E:\workspace\comfy-asset-manager
npm install              # 依赖已装好则跳过
npm run typecheck        # 必须 0 错误(当前已是 0)
npm run dev              # 浏览器调试(需要另开 API:见下)
npm start                # 构建 + 启动 Electron 托盘版
npm run package          # 打 NSIS 安装包
```

**浏览器调试要同时起 API**(前端跑 5173,API 在 5174,Vite 已配好代理):

```powershell
node --experimental-strip-types src\server\index.ts --port 5174
npm run dev
```

---

## 3. 目录结构(你只能改 `src/renderer/`)

```
src/
├── shared/types.ts          ★ 冻结契约,只读。所有类型的真源
├── renderer/                ← 你的工作区
│   ├── main.tsx             入口:挂载 <App /> + 全局 CSS
│   ├── App.tsx              主布局:工具条 / 侧栏 / 网格 / 详情
│   ├── api.ts               window.api 收口 + 数据 hook
│   ├── global.ts            window.api 的全局类型声明(注意:必须是 .ts 不是 .d.ts)
│   └── components/
│       ├── Trees.tsx        文件夹树 + 用户自定义分类树
│       ├── ImageGrid.tsx    缩略图网格
│       └── DetailPanel.tsx  参数详情面板
├── main/                    后端(勿动)
└── server/                  零依赖 HTTP 服务(勿动)
tools/                       验证脚本(勿动,但可运行)
web/index.html               无依赖版页面(纯 JS,另一个人维护;可参考它的交互)
```

---

## 4. 契约要点(`src/shared/types.ts`)

### 数据模型

```ts
ImageRecord   // 列表项:id / fileName / relDir / absPath / fileSize / fileMtime
              //         dimensions / starred / source / meta(部分字段)
ImageDetail   // 详情:ImageRecord + siblings / position / total + 完整 meta
GenerationMeta// modelName / sampler / loras[] / controlNets[] / prompts[]
SamplerParams // steps / cfg / seed / denoise / scheduler  ← 注意没有 samplerName 的使用
LoraEntry     // name / strengthModel / strengthClip / nodeId
PromptBlock   // role: 'positive' | 'negative' / text
Category      // 用户自定义分类:id / name / relDir / parentId / sortOrder / imageCount
CategoryNode  // 树节点:上面 + children[] / directCount / totalCount
FolderNode    // 文件夹树:rootId / rootLabel / relDir / directCount / totalCount / children[]
```

### 数据获取(`api.ts` 里已封装的 hook)

```ts
useFolders()       // 文件夹树
useCategories()    // 分类树
useStats()         // 库统计
useImages(120)     // 分页查询:返回 { query, setQuery, rows, total, loadMore, hasMore, loading }
useImageDetail(id) // 详情 + 所属分类
useScanProgress()  // 扫描进度订阅
thumbUrl(id)       // 缩略图 URL(走 cam-thumb:// 自定义协议)
```

**分页约定**:`setQuery` 传的是 `ImageQuery`,支持
`q`(全文) / `relDir`(文件夹) / `categoryId`(分类) / `modelName` / `scheduler` /
`ids` / 尺寸范围 / `starredOnly` / `sort`。

### 排序键

`mtime_desc`(默认)| `mtime_asc` | `name_asc` | `size_desc` | `random`

---

## 5. 必须实现的界面(需求逐条)

| # | 需求 | 验收方式 |
|---|---|---|
| 1 | **分文件夹分类** | 侧栏文件夹树可点击筛选;点击后网格只剩该目录(含子目录) |
| 2 | **缩略图网格浏览** | 网格显示缩略图;滚动到底自动加载更多 |
| 3 | **点开看完整参数** | 见下方字段清单 |
| 4 | 后台常驻(托盘) | Electron 托盘图标 + 关闭窗口不退出 |

### 详情面板字段(精确等于需求,不多不少)

```
像素尺寸 | 模型 | 调度器 | 步数 | CFG | seed
LoRA 及权重(列表,显示 name + strengthModel,clip 不同时额外显示)
正向提示词 | 负向提示词(等宽字体、可滚动、保留换行)
文件信息:文件名 / 文件夹 / 体积 / 生成日期 / 来源格式 / 所属分类
```

**明确不要**:**采样器**。也不要加"画质评分""推荐"之类用户没要求的字段。

### 交互(与 `web/index.html` 保持一致)

- 点击卡片 → 打开详情;详情内 `←` `→` 翻页、`Esc` 关闭
- `/` 聚焦搜索框
- 卡片右上角 `☆` 收藏(悬浮显示,已收藏时常显)
- 侧栏分类支持:新建 / 改名 / 删除 / 点选筛选
- 详情面板「+ 加入分类」→ 弹层勾选,可在弹层内直接新建并加入

---

## 6. 视觉规范

现有配色(深色,在 `App.tsx` 的 `theme` 常量里):

```ts
bg: '#0f1115'     panel: '#161b22'   panel2: '#1c2128'   border: '#21262d'
fg: '#e6e8eb'     muted: '#7d8590'   accent: '#58a6ff'   cat: '#a371f7'
ok: '#3fb950'     warn: '#d29922'    bad: '#f85149'
```

要求:

- 字体 `system-ui, "Segoe UI", "Microsoft YaHei", sans-serif`,基础 13px
- 参数值用等宽 `ui-monospace, Consolas, monospace`
- 数据缺失用 `warn` 色(`#d29922`)显示"未记录"
- 侧栏宽 236px,详情面板宽约 520–540px
- **你可以重新设计配色与排版,但必须保持深色、并保证 8061 张缩略图滚动流畅**

---

## 7. 已有基线:先读这两个文件

**动手前必读**,它们已实现全部需求,你要做的是精修而不是重写:

1. `src/renderer/App.tsx` —— 布局、状态、快捷键、无限滚动
2. `web/index.html` —— **纯 JS 版,交互最完整**(含收藏、分类管理、弹层)。
   它的逻辑可以直接翻译成 React;用户已验收过这个交互

---

## 8. 验收标准(你必须自己跑通)

```powershell
npm run typecheck        # 必须 0 错误
npm run verify           # 语法 + 契约 + 分类 + 缩略图 + 页面,必须全 PASS
npm run dev              # 浏览器里人工确认三个界面
npm start                # Electron 托盘版能起、能关到托盘、能退
```

`npm run verify` 会检查:

- 你调用的每个 `window.api.*` 是否存在于契约
- 详情面板是否含全部 10 个需求字段
- 是否误加了"采样器"
- 是否有"未记录"兜底
- 内嵌 JS / JSX 结构

---

## 9. 已知坑(踩过,别再踩)

| 坑 | 症状 | 正确做法 |
|---|---|---|
| `declare global` 放 `.d.ts` | 整层报 `Property 'api' does not exist on type 'Window'` | 放在普通 `.ts` 模块里(见 `src/renderer/global.ts`) |
| 相对导入层级算错 | `Cannot find module '../../shared/types'` | **统一用 `@shared/types` 别名**,别算层级 |
| `??` 与 `\|\|` 混用不加括号 | `ERR_INVALID_TYPESCRIPT_SYNTAX`(Node 转译器直接拒绝) | 加括号或拆两行 |
| PowerShell 拼源码/正则 | 中文被破坏、`\n` 不展开、产生假结论 | 文件内容一律用编辑器工具写,不要用 shell 拼接 |
| `Set-Location` 跨调用不保留 | tsc 在错误目录运行,报出假的模块找不到 | 用工具的 `workdir` 参数,不要靠 `cd` |

---

## 10. 不要碰的东西

| 路径 | 原因 |
|---|---|
| `src/shared/types.ts` | 冻结契约 |
| `src/main/**`、`src/server/**` | 后端已验证 |
| `web/index.html` | 无依赖版页面,独立维护 |
| `tools/*.cjs`、`tools/comfy-parser.cjs` | 解析器,全库回归通过 |
| `delivery/**` | 已打包的可执行交付物 |

---

## 11. 交付时请说明

1. 改了哪些文件、每个文件做了什么
2. `npm run typecheck` 与 `npm run verify` 的完整输出
3. 你无法验证的部分(例如需要真实 Electron 窗口才能确认的项)

---

## 附:当前真实数据概况(用来判断显示是否正确)

```
库          8061 张 / 32.7 GB / 103 个文件夹
元数据格式  a1111 4654 / comfyui 2706 / unknown 701
覆盖率      尺寸·文件名·目录·体积·日期 100%
            模型 91.3% / 步数·CFG·seed 87.0% / 正向提示词 89.8% / 负向 78.1%
            调度器 60.9%   ← 近四成缺失,必须显示"未记录"
LoRA        4625 张含 LoRA,共 44610 条引用,509 个唯一 LoRA
搜索        "1girl" 4206 命中(全文检索含中文分词)
```

**采样器的说明**:因 rgthree 的 `ParameterControlPanel.inputs.pcp_ui` 为空字符串、
`widgets_values` 只存 UI 默认值而非运行时值,**采样器无法可靠还原**,用户已同意不显示。
契约里保留该字段只是为将来兼容,界面上不得出现。
