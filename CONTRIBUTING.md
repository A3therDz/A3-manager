# 贡献指南

欢迎提 Issue 和 PR。为了少走弯路,请先看这几条。

---

## 一、报 Bug / 提建议 → 用 Issues

点仓库上方的 **Issues → New issue**,选对应模板填写即可:

- **报告 Bug**:请带上 版本号(设置里能看到)、渲染效果(磨砂/平面)、系统环境、复现步骤、报错原文或截图。
- **功能建议**:说清"现在哪一步别扭"和"期望怎么做"。

没有 GitHub 账号的话,把问题发到仓库作者的联系方式(见 README 底部)也可以。

---

## 二、提交代码 → 用 Pull Request

1. **Fork** 本仓库(右上角 Fork 按钮)
2. 克隆你自己的 fork:
   ```bash
   git clone https://github.com/<你的用户名>/A3-manager.git
   cd A3-manager
   npm install
   ```
3. 建一个分支再改(不要直接改 main):
   ```bash
   git checkout -b fix/thumbnail-crash
   ```
4. 改完先本地自测:
   ```bash
   npm run typecheck   # 必须 0 错误
   npm run verify      # 契约 / 分类 / 缩略图 / 页面
   npm start           # 真机跑一遍
   ```
5. 提交并推到你自己的 fork:
   ```bash
   git commit -m "fix: 修复 xxx"
   git push origin fix/thumbnail-crash
   ```
6. 回到本仓库 → **Pull requests → New pull request** → 选 **compare across forks** → 选你的分支 → 填模板 → 提交

我会 review 后合并;如果改动较大,建议先开个 Issue 讨论方案。

---

## 三、代码约定(尽量遵守)

| 事项 | 要求 |
|---|---|
| 类型 | 不用 `as any` / `@ts-ignore`,`npm run typecheck` 必须 0 错误 |
| 契约 | 前后端接口以 `src/shared/types.ts` 为唯一真源,先改契约再改实现 |
| 原图 | **只读**:任何功能都不能移动/删除用户原图(删除=进回收站,移动/重命名会同步索引) |
| 界面 | 缺失数据显示「未记录」;不展示「采样器」(见 README 已知限制) |
| 元数据解析 | 改 `tools/comfy-parser.cjs` 时,请用真实图片验证,并说明覆盖的格式 |
| 性能 | 网格里可能有几千张卡片:不要给每张卡加实时模糊/大阴影这类高开销效果 |

---

## 四、只想给我改好的版本?

不方便用 git 的话,可以把改动打包发给我,但请注意:

1. 说明改了什么、基于哪个版本改的;
2. 别把整份 249MB 的绿色版塞进来,只发源码改动;
3. 我会用 `git diff` 对比后再合并,并跑一遍验证套件。
