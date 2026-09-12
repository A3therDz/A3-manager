# 把这个项目上传到 GitHub 的完整步骤

> 你已经拿到的干净副本就在 `E:\workspace\A3-manager`,下面所有命令都在这个目录里执行。
> 它已经去掉了:node_modules、打包产物、本地索引库(data/)、带私人路径的设计稿截屏。
> 上传前我会在第 0 步再帮你确认一遍没有敏感信息。

---

## 0. 上传前自查(重要)

在项目目录打开终端,确认这三件事:

1. 没有本地绝对路径泄漏:
   ```powershell
   Select-String -Path .\**\* -Pattern "E:\\SD|E:\\NAI|C:\\Users" -ErrorAction SilentlyContinue
   ```
   没有任何输出就对了(干净副本已经处理过)。

2. 没有大文件被误加入(>100MB GitHub 会拒绝):
   ```powershell
   Get-ChildItem -Recurse -File | Where-Object { $_.Length -gt 50MB } | Select-Object FullName, Length
   ```

3. `.gitignore` 已存在且包含 `node_modules/`、`app/`、`data/`、`*.db`。

---

## 0.5 最快路径(本机已装 GitHub CLI,推荐)

这台机器已经装了 `gh`(GitHub CLI 2.97),本地仓库也已经初始化并提交好了,
所以只需要两步:

```powershell
# ① 登录(只需一次;当前默认账号 DengZhan05 的 token 已失效)
gh auth login          # 选 GitHub.com → HTTPS → Login with a web browser

# ② 一条命令:建仓库 + 关联 + 推送
cd E:\workspace\A3-manager
gh repo create A3-manager --private --source=. --push
```

- 想建公开仓库就把 `--private` 换成 `--public`
- 想换个账号:`gh auth logout -u DengZhan05` 之后再 `gh auth login`
- 之后更新代码只要 `git add -A && git commit -m "..." && git push`

下面的第 1~5 节是**不依赖 gh 的手动流程**,两条路选一条即可。

---

## 1. 安装并配置 Git

```powershell
git --version          # 没装就去 https://git-scm.com/download/win 装一个
git config --global user.name  "A3ther"
git config --global user.email "你的邮箱@example.com"
```

---

## 2. 本地建仓库并提交

```powershell
cd E:\workspace\A3-manager
git init
git add .
git status             # 确认列表里没有 node_modules / app / data
git commit -m "feat: A3 manager 初版"
```

---

## 3. 在 GitHub 上建空仓库

1. 打开 <https://github.com/new>
2. **Repository name** 填 `A3-manager`
3. 可见性选 **Private**(想公开再改 Public)
4. **不要**勾选 “Add a README file / .gitignore / license”(本地已经有了,勾了会冲突)
5. 点 **Create repository**

> 你之前给我的 <https://github.com/dashboard> 是 GitHub 的登录后首页,不是仓库地址。
> 仓库建好后地址形如 `https://github.com/<你的用户名>/A3-manager`。

---

## 4. 关联并推送

创建完仓库后,GitHub 会显示一串命令,用下面这两条即可:

```powershell
git remote add origin https://github.com/<你的用户名>/A3-manager.git
git branch -M main
git push -u origin main
```

第一次推送会弹出登录窗口(浏览器登录或填 Personal Access Token,见第 7 节)。

---

## 5. 以后怎么更新

```powershell
git add -A
git commit -m "fix: 修复 xxx"
git push
```

---

## 6. 想同时发布可执行文件(可选)

源码仓库不建议塞进 249MB 的绿色版程序,推荐用 **Release 附件**:

1. 先把绿色版压成 zip(例如 `A3 manager-便携版.zip`)
2. 在仓库页右侧点 **Releases → Draft a new release**
3. Tag 填 `v0.1.0`,标题写 `A3 manager v0.1.0`
4. 把 zip 拖到 “Attach binaries” 区域
5. 写两句更新说明,点 **Publish release**

---

## 7. 常见问题

| 现象 | 处理 |
|---|---|
| 推送要求账号密码 | GitHub 已不支持密码,改用 **Personal Access Token**(Settings → Developer settings → Tokens),或装 GitHub Desktop 登录 |
| 推送报 `file is 105.8 MB; this exceeds GitHub's file size limit` | 说明 zip/exe 被 add 进去了:`git rm --cached <文件>`,并确认 .gitignore 里含 `*.zip`、`app/` |
| 中文文件名显示乱码 | 设置 `git config --global core.quotepath false` |
| 每次提交都提示换行符 | `git config --global core.autocrlf true` |
| 想把仓库改成公开 | 仓库 Settings → 最下方 Danger Zone → Change visibility |
| 没有 LICENSE | 已附带 MIT 版式,把里面的年份/署名改成你要的即可 |

---

## 8. 授权与第三方说明

- 本仓库采用 **MIT** 许可,可自由修改与再发布,但请保留版权声明。
- 依赖项(Electron / React / Vite 等)各有自己的许可,发布二进制时建议保留 `LICENSE.electron.txt`、`LICENSES.chromium.html`(打包产物里已经带)。
- 应用图标属于作者自有素材;若你要替换,请同时更新 `build/icon.ico`、`build/icon.png`、`build/tray.png` 与 `public/logo.png`。
