# A3 manager

本地图片资产管理器 —— 面向 **ComfyUI / A1111(WebUI) / NovelAI** 出图的整理工具。
把出图目录加进来,就能按文件夹浏览、看缩略图网格、点开看完整生成参数,并且图片**从头到尾留在原地**。

> 独立桌面客户端(Electron + React + node:sqlite),不是浏览器页面,也不需要额外的服务端。

---

## 功能

**浏览与检索**
- 缩略图网格 + 无限滚动;缩略图缓存在图库内的 `.comfy-thumbs\`(只读原图,绝不搬动)
- 按文件夹树浏览,支持多图库目录、任意盘
- 全文检索:文件名 / 提示词 / 模型 / LoRA / 文件夹
- 按模型、排序(最新/最早/名称/体积/随机)、只看收藏筛选

**详情**
- 完整生成参数:像素尺寸、模型、调度器、步数、CFG、seed、LoRA 及权重、正/负提示词
- 缺失字段显示「未记录」(数据缺失是常态,不是 bug)
- ← → 翻页、Esc 关闭、`/` 聚焦搜索

**整理**
- 卡片右键:重命名(真改文件名并同步索引)、复制图片(到剪贴板)、复制到文件夹、移动到文件夹、在资源管理器中定位、删除(进回收站)
- 多选(Ctrl / Shift / 勾选框)+ 底部批量操作条:批量移动 / 批量删除
- 用户自定义分类:跨文件夹把图片归到同一集合,支持层级与重名保护
- 图库目录里新出的图**自动入库**(文件监听 + 去抖,几秒内出现)

**外观**
- 磨砂玻璃(亚克力)材质:面板、工具条控件、悬浮卡片
- 暗 / 亮主题;「渲染效果」可切 磨砂 / 平面(弱显卡或远程桌面用平面,不掉帧)
- 自定义背景图,支持 **裁切 / 拉伸 / 适应 / 平铺** 四种铺法
- 无边框窗口 + 自绘最小化/最大化/关闭

**元数据格式支持**

| 格式 | 识别字段 |
|---|---|
| ComfyUI 节点图(prompt) | 模型 / LoRA / 采样器 / 步数 / CFG / seed / 正负提示词 |
| ComfyUI UI 工作流(workflow) | 同上(从 `widgets_values` 取值) |
| A1111 WebUI(parameters) | Steps / Sampler / Schedule type / CFG scale / Seed / Model / Lora hashes… |
| NovelAI(Comment + Description) | prompt / uc / steps / sampler / scale / seed / noise_schedule / 模型(Source) |

---

## 快速开始(开发)

需要 **Node 22+**(用到内置 `node:sqlite`)。

```bash
npm install          # 首次
npm run typecheck    # 类型检查,应 0 错误
npm run verify       # 契约 / 分类 / 缩略图 / 页面 等验证套件
npm start            # 构建并启动桌面客户端(Electron)
npm run package      # 打绿色版 + NSIS 安装包
```

纯浏览器调试(需要另开一个零依赖 API 服务;桌面版不需要):

```bash
node --experimental-strip-types src/server/index.ts --port 5174 --root "<你的图库目录>"
npm run dev
```

---

## 目录结构

```
src/
  main/        Electron 主进程 + 索引库(node:sqlite) + 扫描器
  preload/     contextBridge 桥(把主进程能力暴露成 window.api)
  renderer/    React 界面:App / 网格 / 详情 / 目录树 / api hooks
  server/      零依赖 HTTP 服务(浏览器调试与无依赖版共用)
  shared/      types.ts —— 前后端唯一契约真源
tools/         解析器与验证脚本(comfy-parser / png-reader / verify-*)
web/           无依赖版页面(纯 JS,可单独打开)
build/         应用与托盘图标
design/        设计说明与实测报告
docs/          开发任务书
```

---

## 已知限制

- **不显示「采样器」**:复杂工作流的采样器无法可靠还原,详情面板刻意不展示;索引层仍保留该字段。
- 约 40% 的图没有调度器、约 20% 没有负向提示词,界面统一显示「未记录」。
- 修改图库里的文件后,索引会在文件监听到变化后自动同步;也可以点工具条「刷新」或按 F5 手动刷新。

---

## 作者

**A3ther** · 仓库:<https://github.com/dashboard>

> 想换成你自己的仓库地址:改 `src/renderer/App.tsx` 顶部的 `AUTHOR_NAME` 与 `REPO_URL` 两行即可。

## 许可

MIT(见 `LICENSE`)。图标素材为作者自有资产,如需替换请改 `build/icon.ico`、`build/icon.png`、`build/tray.png`、`public/logo.png`。
