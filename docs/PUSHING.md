# GitHub 推送与凭据规范（PUSHING）

> 本文件是念风 Chat 各仓库「推送 / 凭据 / 推送后校验」的单一事实来源，供新会话在执行任何 `git push`
> （本体仓库、发布工作树、插件市场仓库）之前先读一遍。
> 版本号与分支模型见 [`VERSIONING.md`](./VERSIONING.md)；构建、安全扫描与发布脚本见 [`RELEASING.md`](./RELEASING.md)。

---

## 1. 涉及哪些仓库

| 仓库 | 本地位置 | remote | 推送内容 |
|---|---|---|---|
| 本体开发仓库 | 仓库根目录 | `https://github.com/nianfeng233/NianFeng-Chat.git` | 日常开发提交与 `preview` / `main` / `release/*` 分支 |
| 发布工作树 | `release/publish/`（独立 `.git`） | 同上 | 由脚本同步的纯净源码、tag、GitHub Release |
| 插件市场仓库 | `.local/NianFeng-Chat-Plugins/` | `https://github.com/nianfeng233/NianFeng-Chat-Plugins.git` | `plugins/<id>/`、`market.json`、`index.json` |

补充：

- `extensions/` 是插件源码工作目录，被本体 `.gitignore` 忽略，**不随本体仓库推送**；插件改动只进插件市场仓库。
- `release/`、`user_data/`、`data/`、`.tmp/`、`.local/` 同样不进本体仓库。

---

## 2. 凭据从哪里来

- 三个仓库的**本地** `.git/config` 都配置了同一条 `credential.helper = store --file=<本机绝对路径>/.local/git-credentials`
  （路径写在本机配置里，不写进文档、也不进仓库）。
- 该文件是 git-credential-store 的明文格式，单行：`https://<用户名>:<令牌>@github.com`，令牌为 40 位 OAuth / PAT。
- 文件位于 `.local/`（已被 `.gitignore` 忽略）：**不要提交、不要复制进文档、不要打印到日志**。
- 令牌需要公开仓库的写权限（`repo`）；失效时表现为 `remote: Permission ... denied` 或 HTTP 403。

---

## 3. 自动化 / 受限会话的已知限制（重点）

**现象**：在受限环境（自动化会话、沙箱、部分 CI）里，git 的凭证助手起不来：

```text
sh.exe: *** fatal error - couldn't create signal pipe, Win32 error 5
fatal: could not read Username for 'https://github.com': terminal prompts disabled
```

**原因**：`git-credential-store` 是 shell 脚本，需要 MSYS 的 `sh.exe`；`sh.exe` / `bash.exe` 无法创建管道时，
凭证助手直接失效，git 退回到交互式索要用户名密码；若设置了 `GIT_TERMINAL_PROMPT=0` 就报上面的 fatal，
没设置则会**卡在等待输入**（表现为命令一直不返回）。

**范围**：本体仓库、`release/publish`、插件市场仓库全部复现（三处配置相同）；换成全新的 `cmd.exe` 子进程
依旧复现 —— 这是环境级限制，不是某个仓库的配置问题。

**规避方式（按优先级）**：

1. 从 `.local/git-credentials` 读出用户名 / 令牌，**内联到本次推送 URL**，不写配置、不落盘：

   ```powershell
   $raw = [System.IO.File]::ReadAllText('<仓库根>\.local\git-credentials').Trim()
   if ($raw -notmatch '^https://([^:@/]+):([^@]+)@github\.com/?$') { throw '凭据格式不符' }
   $user = $matches[1]; $token = $matches[2]
   $env:GIT_TERMINAL_PROMPT = '0'
   $out = & git push "https://${user}:${token}@github.com/<owner>/<repo>.git" <branch> 2>&1 | Out-String
   $out -replace [regex]::Escape($token), '***'   # 输出必须脱敏后再打印
   ```

   注意：只用于这一次命令；不要 `git remote set-url` 带令牌；不要把 `$token` 回显到日志。
2. 需要创建 / 更新 GitHub Release 时：本机**没有安装 `gh`**。要么安装 `gh` 并 `gh auth login`，
   要么用令牌调 REST API（`POST /repos/<owner>/<repo>/releases`，附件上传走 `uploads.github.com`）。
3. 在普通 PowerShell / Git Bash 窗口（非受限环境）里操作时，`store` 助手工作正常，按第 4、5 节常规命令即可。

---

## 4. 通用推送流程（任何仓库）

1. `git fetch origin && git status -sb`：确认本地没有 `behind`（落后先 `git pull --rebase`，否则会被
   `! [rejected] ... (fetch first)` 拒绝）；
2. 跑该仓库的检查：本体 `npm run check:kernels` / `npm test`；插件 `node plugins/<id>/test.mjs`；
3. `git add -A && git commit -m "<type>(<scope>): 说明"`（提交信息风格见 [`RELEASING.md`](./RELEASING.md) 第 5 节）；
4. 推送：常规环境直接 `git push origin <branch>`；受限环境用第 3 节的内联凭据；
5. 复核：`git fetch origin && git status -sb` 应显示与 `origin/<branch>` 一致，
   `git log --oneline -1 origin/<branch>` 指向刚推的提交。

---

## 5. 本体仓库的推送

开发分支：

- `preview` 是日常集成分支，`main` 只接收通过预览验证的提交（见 [`VERSIONING.md`](./VERSIONING.md) 第 2 节）。
- 推送前先 `git fetch`：发布产生的 `release:` 提交是在 `release/publish` 工作树里推的，工作区克隆容易落后。

发布（tag + Release）统一由脚本在 `release/publish` 里完成：

```powershell
npm run build:release
node scripts/prepare-publish.mjs
node scripts/publish-release.mjs --tag vX.Y.Z --notes docs/releases/vX.Y.Z.md
```

- 脚本内部顺序：`git add -A` → `git commit -m "release: 念风Chat vX.Y.Z"` → `git tag -a` →
  `git push origin HEAD` + `git push origin <tag>` → `gh release create`（识别 `-preview.N` 自动加 `--prerelease`）。
- 演练：`--dry-run` 只打印将执行的命令；`--skip-push` 跳过推送但保留 tag。
- 受限环境下第 3 步（`git push`）与第 4 步（`gh`）都需要按第 3 节处理：推送用内联凭据，Release 改用 REST API。
- 安全门禁：`prepare-publish.mjs` 会把 `docs/` 一起扫描（本机用户名、绝对路径、邮箱、令牌形态均会拦截），
  写文档与注释时不要出现真实绝对路径、邮箱或令牌。

---

## 6. 插件市场仓库的推送

目录：`.local/NianFeng-Chat-Plugins/`（独立克隆，`main` 分支）；插件源码仍在 `extensions/<id>/`。

标准流程：

1. 同步 `extensions/<id>` → `plugins/<id>`；**不要**搬 `install.ps1`、`*.zip`（仓库 `.gitignore` 忽略 `*.zip`，
   且市场按目录内容算哈希）；
2. 跑插件自测：`node plugins/<id>/test.mjs`；
3. 提交插件本体，记下提交号 `COMMIT`；
4. 生成清单：`MARKET_COMMIT=<COMMIT> node scripts/build-market.mjs`；该提交号会被写进 `market.json`，
   应用端据此下载 `https://codeload.github.com/<owner>/<repo>/zip/<COMMIT>`，避免国内镜像缓存 `main` 旧包；
5. 提交 `market.json` / `index.json` 并推送。

推送后校验（必须做）：

- 下载上述 `codeload` 压缩包 → 解出 `plugins/<id>` → 用 `build-market.mjs` 相同算法复算内容哈希
  （按相对路径排序，依次 `file:<rel>\n`、`size:<字节数>\n`、文件内容、`\n`），结果必须等于 `market.json` 里的 `sha256`；
- 顺带确认包内 `manifest.json` 的 `version` 与清单一致、新增文件确实在包里。

其他注意：

- `MARKET_COMMIT` 会把**所有**插件的 `commit` 字段统一固定到该提交（脚本行为）；只要其他插件在该提交的
  内容与各自最新提交一致，哈希校验依旧成立。以后改动别的插件时记得重新执行第 4 步。
- 国内网络：`raw.githubusercontent.com` 可能直连失败，可用 jsdelivr / ghproxy（市场已内置镜像源），
  拉取仓库本身用 `git` 即可。

---

## 7. 常见故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `couldn't create signal pipe` + `could not read Username` | 受限环境 `sh` 不可用，凭证助手失效 | 用第 3 节内联凭据；或换真实终端操作 |
| 推送命令一直不返回 | 凭证助手失败后 git 在等输入 | 中断后设 `GIT_TERMINAL_PROMPT=0`，改用内联凭据 |
| `! [rejected] ... (fetch first)` | 远端有新提交 | `git fetch` → `git pull --rebase` → 重推 |
| `remote: Permission ... denied` / 403 | 令牌过期或权限不足 | 更新 `.local/git-credentials`，确认写权限 |
| `gh: command not found` | 未安装 gh | 安装 gh 并登录，或改用 REST API 建 Release |
| tag / Release 已存在 | 版本号未升 | 不得覆盖已发布 tag，改发新 PATCH（见 [`VERSIONING.md`](./VERSIONING.md) 第 4 节） |
| 市场里还是旧版本 | 客户端市场缓存 / CDN 缓存 | 设置 → 插件市场 → 刷新；等 CDN TTL 过期 |
| `raw.githubusercontent.com` 超时 | 网络 | 用 jsdelivr / ghproxy 镜像源 |

---

## 8. 新会话推送 Checklist

- [ ] 确认目标仓库与分支（本体仓库 / `release/publish` / 插件市场仓库）
- [ ] `git fetch origin && git status -sb`，本地不落后
- [ ] 跑完对应测试（本体 `npm test`；插件 `node plugins/<id>/test.mjs`）
- [ ] 受限环境使用内联凭据推送，输出用 `***` 脱敏
- [ ] `git fetch` 复核 `origin/<branch>` 指向新提交
- [ ] 发布类任务：`codeload` 产物复算内容哈希通过；插件市场 `market.json` 与包内 `manifest.json` 版本一致
- [ ] 提交信息符合 Conventional Commits；不提交 `release/`、`user_data/`、`.local/`、`*.zip`
