# A3 manager v0.7 改进实施计划

> 日期:2026-10-06
> 需求来源:`E:\workspace\A3 M\改进.md`(6 条新需求)
> 版本:v0.6 → **v0.7**(`package.json` 0.6.0 → 0.7.0)
> 基线提交:`7013fc4`(v0.6 已发布状态)
> 诊断结论:需求 1/2/4/5/6 均为真实缺陷或缺口;需求 3 的采样器**已解析入库**,只差展示层。

## Global Constraints(所有任务必须遵守)

1. **契约冻结**:`src/shared/types.ts` 是唯一真源(文件头 types.ts:3-8 有声明)。任何 API/字段变更顺序:`types.ts` → `src/main/index.ts`(IPC)→ `src/preload/index.cjs` → `src/renderer/api.ts`(浏览器调试兜底一律 desktopOnly 抛错,照抄现有写法)。
2. **META_VERSION 保持 3**(`src/main/indexer.ts:83`),任何任务不得升它、不得触发全库重扫。
3. **不改 db schema**(不加列、不改表)。
4. **动效规范**:进场/退场必须成对;退场统一走 `useDelayedClose`(`src/renderer/App.tsx:148-197`,`CLOSE_MS=160`,弹层内容可用 220ms);时长只用 `--dur-1`(.14s)/`--dur-2`(.22s)/`--dur-3`(.34s),缓动 `--ease: cubic-bezier(.32,.72,0,1)`。
5. **性能红线**:网格区与弹层不开实时 `backdrop-filter`(网格用 color-mix 半透明,弹层用近不透明 `--modal-bg`);**不恢复卡片进场动画**(v0.6 为治卡顿主动删除,恢复即回退)。
6. **图片防拖**:卡片/详情里的 `<img>` 必须 `draggable={false}`;内部拖拽状态只能在 `dragend` 清、不能在 `drop` 清(`App.tsx:1141-1143` 有记录)。
7. UI 文案为中文;注释用中文、风格跟随现有代码;不新增 npm 依赖。
8. 样式集中在 `src/renderer/main.tsx` 的内联 `<style>`;组件只挂 className,新增样式不写 inline style(改造既有 inline style 除外)。
9. 每个任务完成须 `npx tsc --noEmit` 零错误;任务涉及的 verify 脚本必须 PASS。
10. 提交信息用中文 + conventional 前缀(feat:/fix:/refactor:/docs:),与 git log 风格一致。

---

## Task 1: 详情面板展示采样器(+反转验证护栏)

**背景**:采样器已全链路存在——解析器四种来源都提取 `samplerName`(`tools/comfy-parser.cjs:408/830/931/1147`);db 有 `sampler_name` 列+索引(`src/main/db.ts:139`);契约 `src/shared/types.ts:72` `SamplerParams.samplerName`;IPC 整体透传 meta。**唯一缺口是展示层被刻意隐藏**(上一需求决定),有 4 个验证脚本把"不含采样器"做成了反向断言。

**改动**:

1. `src/renderer/components/DetailPanel.tsx`:
   - "采样参数"小节(约 :375-392,`const s = m?.sampler` 在 :209)加一行「采样器」,位置在「模型」和「调度器」之间,复用现有 KV 行组件;空值显示与调度器一致的占位(看现有 KV 对 null 的渲染,照抄)。
   - 删除/改写文件头"采样器字段按用户要求不展示"的注释(约 :10-14),改为说明采样器自 v0.7 起展示。
2. `tools/serve-webui.ts:413-421`(无依赖 web 版详情):同样加「采样器」行。
3. `tools/export-gallery.ts`:把 `sampler` 加回导出 items(约 :198 现在只出 scheduler)并在详情渲染(约 :747)加「采样器」。
4. **反转 4 个护栏脚本**(读脚本理解断言语义后反转,不是删):
   - `tools/verify-contract.ts:230-253`:"DetailPanel 出现『采样器』即 FAIL" 反转为"必须出现";把「采样器」加进必展示字段清单。
   - `tools/verify-gallery.ts:122-124`:"导出 items 必须不含 sampler" 反转为"必须含"。
   - `tools/verify-manage.ts:246-249` 与 `tools/verify-webpage.ts:138-141`:"页面正文不得出现『采样器』" 反转为"必须出现"。
5. `tools/regress-parser.cjs:54-60`:字段覆盖统计补一行 `samplerName` 计数(照抄 scheduler 的写法)。
6. 文档同步(把"刻意不显示采样器"的表述改为"v0.7 起显示"):
   - `design/STATUS.md:223-234` 与 :382 附近;`docs/FRONTEND-TASK-FOR-K3.md:27、142、197、247` 附近;`CONTRIBUTING.md:55` 附近;`E:\workspace\A3 M\项目.md:71` 附近(在仓库外,注意路径)。

**不做**:不动解析器、不升 META_VERSION、不加 db 列。

**数据事实(写进报告,不改代码)**:约 39% 的 ComfyUI 图(rgthree 面板类工作流)元数据里没有采样器,会显示占位——正常。

**验证**:`npx tsc --noEmit` 零错误;`node --experimental-strip-types tools/verify-contract.ts`、`tools/verify-gallery.ts`、`tools/verify-manage.ts`、`tools/verify-webpage.ts` 全部 PASS(若某脚本需要图库/服务器等环境才能跑,在报告里说明哪步能跑、哪步不能)。

---

## Task 2: 右键菜单定位修复(永不超出窗口)

**根因**:`src/renderer/App.tsx:819-822` `openMenu` 用写死的钳位 `Math.min(y, innerHeight-240)`(240 是旧版 6 项菜单的值);现在菜单 13 项+2 分隔线 ≈430px 高(`.cam-menu` 在 `src/renderer/main.tsx:173-184`,无 max-height),底部右键时溢出被裁。「更多」浮层 `toggleMoreMenu`(`App.tsx:683-695`)同样是写死的 216/348。

**改动**:

1. **渲染后测量、空间不足翻转**:右键菜单与「更多」浮层统一改为——打开时先在点击坐标渲染(`visibility:hidden`),`useLayoutEffect` 里用 ref 读 `offsetWidth/offsetHeight`,再算最终位置:右方不足则贴右边缘内收,下方不足则向上翻转(`y - height` 或 `innerHeight - height - 8`),最后去掉隐藏。菜单项增删永远不用再改钳位值。
2. **翻转时动画方向跟着换**:`cam-pop` 的 `transform-origin: top left`(`main.tsx:597-598`)在向上翻转时要变 `bottom left`(给菜单加 `.flip` 修饰类,CSS 里写两条)。
3. **打开期间自动关闭**:菜单打开时监听网格滚动与窗口 `resize` 即关闭(参照 moreMenu 已有的 scroll 关闭,`App.tsx:673` 附近)。
4. **兜底**:`.cam-menu` 加 `max-height: calc(100vh - 16px); overflow-y: auto`(极端小窗口)。
5. 不得破坏 `useDelayedClose` 的 `menuClosing` 退场拼接(`App.tsx:1787` 附近的 className 逻辑)。

**验证**:`npx tsc --noEmit` 零错误。

---

## Task 3: 移出分类(UI 入口)

**背景**:db 层 `setCategoryMembers(categoryId, imageIds, member)`(`src/main/db.ts:1264-1284`)member=false 即移出,IPC `src/main/index.ts:932-934` 原样透传,**API 不缺**。缺的是 UI:指派模式(传 `initialChecked`,apply 时按差集算 adds/removes)只在详情面板「+ 加入分类」(`DetailPanel.tsx:502-511`)使用;网格右键菜单与批量条的 CategoryPicker 都是只加不移的追加模式(`App.tsx:2363-2375` 渲染处)。

**改动**(纯 UI,零 db/API 改动):

1. **右键菜单加「移出分类…」**(放在「加入分类…」下面,`App.tsx:1819-1830` 附近):打开 CategoryPicker 的**指派模式**;单图时 `initialChecked` = 该图所属分类;多选时(遵守既有约定:右键的卡在多选集合里→整批,`App.tsx:1822-1840`)= **所有选中图分类的交集**(逐图取 `getImageCategories` 求交)。用户取消勾选的分类 = 整批移出。
2. **正在浏览某分类时**加直达项「从当前分类移出」:直接 `setCategoryMembers(当前分类id, ids, false)`,不开弹层。注意判断"当前标签页是否是分类视图"(看 App.tsx 里标签页/筛选状态怎么存)。
3. **批量条加「移出分类…」**(`App.tsx:1935-1954` 的 `.cam-selectbar`):同第 1 条的指派模式+交集。
4. **详情面板分类区改 chip + ✕**(`DetailPanel.tsx:361-372`,现在是纯文本 `join('、')`):每个分类一个 chip,✕ 点击即 `setCategoryMembers(catId, [当前图id], false)` 移出;「+ 加入分类」按钮改名「分类…」。chip 样式加到 `main.tsx`(磨砂小胶囊,圆角 999px,hover 时 ✕ 显色;时长用 `--dur-1`)。
5. **所有入口收尾一致**:操作后调 `refreshCategories()`(树计数,`App.tsx:879-883`)与详情面板归属重载(参照 `addImagesToCategory` `App.tsx:1086-1102` 的 `detail.cats.reload()` 模式);多选批量操作完成后走 `closeSelection()`。
6. CategoryPicker 如需区分"指派模式"的标题/文案(如「编辑分类」vs「加入分类」),做小改;不改它的差集算法。

**验证**:`npx tsc --noEmit` 零错误;`node --experimental-strip-types tools/verify-category.ts` PASS。

---

## Task 4: 多选模式开关 + 批量操作补齐

**背景**:多选已存在(`selectedIds: Set<number>` `App.tsx:750-752`;悬浮勾选框 `ImageGrid.tsx:192-203`;Ctrl 点选/Shift 范围选 `ImageGrid.tsx:126-130`;批量条 `App.tsx:1935-1954` 有 全选本页/加入分类/移动/删除)。**缺**:显式「多选模式」开关;批量复制;批量收藏;批量移出分类(Task 3 已加)。`copyImageToFolder` 只有单 id 版(`index.ts:1109`)。

**改动**:

1. **「多选」开关**:放在网格上方工具条(排序/视图控件所在行,找 App.tsx 里网格工具条位置)。开启后:
   - 卡片勾选框常显(给网格容器加 `.selecting` 类,CSS 让 `.cam-check` 常显,不用悬浮;现有勾选框的 `pointer-events:auto` 覆盖保持有效,`main.tsx:158-160`);
   - **单击卡片 = 切换选中**(不再开详情);Ctrl/Shift 语义保持;
   - 批量条常驻(0 张时禁用操作按钮,只留全选/退出);
   - Esc 退出多选模式(挂进现有 Esc 优先级链 `App.tsx:964` 附近,多选>详情的优先级保持);关闭开关清空选择(走现有 `closeSelection()`)。
2. **新增批量复制接口 `copyImagesToFolder(ids, targetDir?)`**——走完整契约链(Global Constraint 1):
   - `types.ts` ApiSurface 加声明(注释照抄现有风格);
   - `src/main/index.ts` 加 handler,实现**照抄 `moveImages` 的范式**(`index.ts:1145-1192`:弹目录选择框、逐文件复制、同名跳过、errors 收集、返回 `{ok, copied, skipped, errors}` 之类与 moveImages 同形的结构);
   - `src/preload/index.cjs` 暴露;`src/renderer/api.ts` 加封装(浏览器兜底 desktopOnly,`:130-136` 风格)。
3. **批量收藏**:渲染层循环调现有 `api.setStarred(id, starred)`(不加新 IPC),批量条加「收藏」按钮(已全收藏则文案「取消收藏」,简版:按第一张的状态决定)。
4. **批量条最终按钮**:全选本页 / 复制到文件夹… / 移动… / 加入分类… / 移出分类…(Task 3 已加)/ 收藏 / 删除 / 取消选择。按钮多注意紧凑,样式沿用现有 `.cam-selectbar` 体系。
5. 批量复制/收藏完成后:toast 报告结果(照抄 batchMove 的 toast 写法)+ `closeSelection()` + 网格刷新(照抄 batchMove/batchDelete 的刷新方式)。
6. 剪贴板复制(单张)不进批量条——剪贴板天然只能放一张,批量"复制"就是「复制到文件夹…」。

**注意**:`verify-contract.ts` 会校验 ApiSurface 契约,加了 `copyImagesToFolder` 后该脚本可能要同步加断言(读脚本,照现有条目风格加)。

**验证**:`npx tsc --noEmit` 零错误;`node --experimental-strip-types tools/verify-contract.ts` PASS。

---

## Task 5: 浮窗(工作小窗)优化

**背景**:浮窗 = `pet.html` + `src/renderer/pet/main.tsx`(821 行)+ `pet.css`(479 行),主进程 `src/main/index.ts` `createPetWindow()`(:389-445)创建。诊断出的问题:面板强制深色(主题设置形同虚设,`pet.css:95-123`);收起动画 `pet-panel-out` 是死代码;无右键菜单/Esc/点外收起/点击穿透;`layout()` 原点写死 `(0,0)`(`pet/main.tsx:61-65`)副屏错位;位置记忆不校验;DPI 未换算;`reduceEffects` 读了不用。

**改动**:

1. **外观磨砂化 + 主题生效**:
   - 删掉 `pet.css:95-123` 的强制深色,面板改磨砂玻璃:`backdrop-filter: blur() saturate()` + 半透明底 + 圆角(向主界面 `--glass`/`--radius-lg` 体系看齐;pet.css 是独立样式表,在内部定义同名变量即可);亮/暗主题(`data-theme`)真正生效两套都调好看,暗色毛玻璃 + 亮色雾面;
   - `reduceEffects`/平面模式:关模糊、退实色(主界面 `data-lite` 同款思路),让 `state.reduceEffects` 真正消费;
   - 面板在任意壁纸上可读(必要时加一层薄 scrim)。
2. **展开/收起动画成双**:`toggleOpen`(`pet/main.tsx:180-194`)收起时挂 `.closing` 播 `pet-panel-out`(`pet.css:111-117` 已有死代码)再卸载/缩窗,延迟 160~220ms;展开保持 `pet-panel-in`。透明窗口缩放与动画的先后序按现有 `layout()` + `setBounds` 的模式处理,别闪。
3. **交互补全**:
   - 图标**右键菜单**:打开主界面 / 展开·收起 / 隐藏浮窗(=关闭浮窗,托盘可再开)。浮窗内自绘小菜单(pet.css 里写,磨砂风);
   - **Esc** 收起面板;**点面板外**(窗口内、面板外的透明区)收起面板——用 document 级 pointerdown 判断落点;
   - **点击穿透开关**:设置面板加「点击穿透」项(新设置键 `petClickThrough`,走 types.ts→主进程→preload→api 契约链);开启后 `setIgnoreMouseEvents(true,{forward:true})`,图标区 hover(借 forward 的 mousemove 命中)时临时 `setIgnoreMouseEvents(false)` 恢复交互,移出再开回去;托盘菜单项保持可恢复;
   - 全局快捷键不做(YAGNI)。
4. **多屏/DPI/位置稳定**:
   - `layout()` 夹紧改用"窗口当前所在屏"的 `workArea`(渲染层可用 `window.screen`+主进程协助;推荐主进程 `movePetWindow`/布局 IPC 里用 `screen.getDisplayMatching(bounds).workArea` 算好返回),不写死 (0,0);
   - 启动校验 `settings.petPosition` 是否落在任一连网屏的 workArea 内,不在则回默认位(主进程创建时做);
   - 拖动换算:渲染层 `e.screenX`(CSS px)与主进程 `setBounds`(物理 px)之间按所在屏 `scaleFactor` 换算(主进程 `movePetWindow` :1357-1371 里做)。
5. pet.css / pet.html 若有 lone `\r` 混行顺手修掉(诊断提到 `pet.css:339`、`pet.html:16`)。

**验证**:`npx tsc --noEmit` 零错误。浮窗无法跑自动化,在报告里写清每个改动的自查点(代码级)。

---

## Task 6: UI/动画「有始有终」补完 + 材质统一

**背景**(诊断):弹层(设置/重命名/删除确认/移除图库/备注/CategoryPicker)与 toast 全是 `setX(null)` 直接卸载,`.cam-modal.closing`/`.cam-toast.closing` 是死 CSS(`main.tsx:396-398`);死代码 `.cam-petw`/`.cam-petpanel`(:406-409)、`cam-menu-in`(:377-380)、`cam-slide`(:579);弹层/input/按钮 inline 写死 `borderRadius:6`(`App.tsx:1861,1914,1958,1975,2139,2172` 及 :2382-2402 常量);详情面板 sticky 顶栏实色(`DetailPanel.tsx:250`);hover 大量写死 `.12s/.14s`(`main.tsx:76,84,118,132,166,179,371,493`);主题切换只过渡颜色(`main.tsx:60-62`),阴影/高光跳变;`.cam-detail.closing` 的 `cam-slide-out` 与槽位宽度过渡两套退场叠加(`main.tsx:401` + `App.tsx:245`)。

**改动**(布局不动,只补完体系):

1. **全部弹层 + toast 接入退场**:用现有 `useDelayedClose`(`App.tsx:148-197`)包住每个弹层状态(设置/重命名/删除确认/移除图库/备注/CategoryPicker),关闭时挂 `.closing`(遮罩 `cam-fade-out` + 内容 `cam-pop-out`)延迟卸载;toast 同样(`.cam-toast.closing`,2200ms 后先播退场再卸载)。激活死 CSS,不新建动画体系。
2. **清死代码**:删 `.cam-petw`/`.cam-petpanel`、`cam-menu-in`、`cam-slide` keyframe 及其引用;`.cam-detail.closing` 去掉 `cam-slide-out` 位移,退场只留槽位宽度过渡(消除两套叠加)。
3. **材质/圆角统一**:弹层内容、input、按钮的 inline `borderRadius:6` → `var(--radius-md)`,实色 `var(--panel)` 背景 → 玻璃/`--modal-bg` 体系变量(能挪到 CSS class 的挪到 `main.tsx`,遵循 Global Constraint 8);详情面板 sticky 顶栏改磨砂(半透明 + blur,与 `cam-header` 同族)。
4. **hover 时长收敛**:写死的 `.12s/.14s ease` → `var(--dur-1) var(--ease)`。
5. **主题切换过渡**:补 `box-shadow`、`border-color`(`main.tsx:60-62` 的规则),消除"颜色渐变、光影跳变"。
6. **不做**:不恢复卡片进场动画;不改网格/弹层的性能取舍(不开实时模糊)。

**验证**:`npx tsc --noEmit` 零错误;grep 确认死类/死 keyframe 已无引用。

---

## Task 7: 版本号 0.7.0 + verify-v07 静态契约 + 全量验证

1. `package.json` version → `0.7.0`;全仓库 grep `0.6.0` 看是否还有界面/文档展示处需要同步(设置页关于之类)。
2. 新建 `tools/verify-v07.ts` 静态契约(照 `tools/verify-v06.ts` 的风格),断言六条需求的关键代码点:
   - 菜单定位:App.tsx 出现 `offsetHeight`/测量逻辑,不再出现 `innerHeight - 240` 硬编码;
   - 移出分类:右键菜单/批量条出现「移出分类」,详情面板 chip 有移出 handler;
   - 采样器:DetailPanel 出现「采样器」行;
   - 多选:有多选模式开关;`types.ts`/`index.ts`/`preload`/`api.ts` 有 `copyImagesToFolder`;
   - 浮窗:pet.css 无强制深色覆写、`pet-panel-out` 被引用、`petClickThrough` 在契约链;
   - UI:弹层 `.closing` 挂载点存在、死代码 `cam-petw`/`cam-menu-in` 已删。
3. 把 `verify-v07` 挂进 `package.json` 的 `verify` 脚本链。
4. 跑全量:`npx tsc --noEmit` + `npm run verify`,全绿才算完。

---

## Task 8: 打包 v0.7 + 文档

1. **打包**:`npm run build`;绿色版优先用 `npm run portable`(`tools/build-portable.ts`,读它确认产物路径与用法);产物放 `E:\workspace\A3 M\A3 manager v0.7\` + `A3 manager v0.7.zip`。若 portable 脚本不适用,参照 v0.6 手工流程:复制 `A3 manager v0.6` 目录 → 换 `resources\app.asar`(asar 只含 `dist`/`build`/`tools`/`package.json`)。
2. **写 `E:\workspace\A3 M\v0.7-改进说明.md`**:格式严格照 `v0.6-改进说明.md`(总览表 / 详细说明含根因+改法+落点 / 验证记录 / 产物)。
3. **写合并版 `E:\workspace\A3 M\改进说明-汇总.md`**:把 v0.2~v0.7 七份改进说明综合成一份(读 `E:\workspace\A3 M\v0.2-改进说明.md` … `v0.7-改进说明.md`),按版本分章 + 开头一个总表;保留每版根因与落点的关键信息,去重,不逐字堆砌。

**验证**:打包产物存在且 `resources\app.asar` 体积合理(~MB 级);文档齐。
