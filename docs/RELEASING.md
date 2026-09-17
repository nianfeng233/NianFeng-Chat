<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# 版本管理与发布规范（RELEASING）

> 版本号语义、分支模型与 GitHub 仓库保留策略已独立到 [`VERSIONING.md`](./VERSIONING.md)；
> 本文件保留发布、构建、安全扫描与产物流程。
> 发布前的强制安全扫描见 [`scripts/prepare-publish.mjs`](../scripts/prepare-publish.mjs)。

---

## 1. 总原则

1. **workspace 是唯一开发源**：日常开发、修复、测试都在工作区完成。
2. **发布仓库不直接开发**：GitHub 仓库内容来自 `release/publish`，由脚本从 `release/web/source` 同步，
   禁止在发布工作树里手工改代码（下次同步会被覆盖）。
3. **发布产物与源码分离**：
   * Git 仓库只放纯净源码（约 2 MB），不放 `node.exe`、`exe`、`node_modules`、`user_data` 等；
   * 预编译产物（`念风Chat.exe`、Web 部署包）通过 GitHub Releases 附件分发。
4. **发布前必须过安全门禁**：`scripts/prepare-publish.mjs` 会扫描用户名、本机绝对路径、API Key、
   私钥、邮箱、手机号、身份证号、`user_data` 等；扫描不通过直接中止。
5. **可复现**：任何一个 tag 都必须能由对应源码重新执行 `npm run build:release` 生成两个发布版。

---

## 2. 目录与产物

| 路径 | 说明 | 是否进 Git |
|---|---|---|
| `workspace/` | 唯一开发源 | 是（主开发仓库） |
| `release/web/source/` | 打包脚本生成的纯净 Web 源码 | 否（构建产物） |
| `release/web/deploy/` | Web 可部署版（含便携 Node） | 否（作为 Release 附件） |
| `release/desktop/source/` | 桌面壳源码 + 运行时 app | 否（构建产物） |
| `release/desktop/deploy/念风Chat.exe` | Windows 桌面单文件 | 否（作为 Release 附件） |
| `release/publish/` | **GitHub 发布仓库工作树**，内容 = `release/web/source` 的纯净副本 | 是（发布仓库，独立 `.git`） |
| `release/*.zip`、`release/nianfeng-desktop-*.exe` | Release 附件 | 否 |

> `release/publish` 不参与 `npm run build:release` 的清理（打包只删除 `release/web` 与 `release/desktop`），
> 因此可以安全地作为发布仓库长期存在。

当前 GitHub 发布仓库：

* `https://github.com/nianfeng233/NianFeng-Chat`（public，Apache-2.0）

---

## 3. 版本号规范

版本号规则、预览/正式版本命名与发布顺序以 [`VERSIONING.md`](./VERSIONING.md) 为准。摘要：

* `MAJOR`：架构更换、开创性大型更新或破坏性变更。
* `MINOR`：新增功能并进入稳定版。
* `PATCH`：不新增功能、中途修改较小时用于 Bug 修复与优化。
* 预览版统一使用 `-preview.N` 后缀，并在 GitHub Release 上勾选 pre-release；正式版去掉后缀。
* 版本号必须同时写入 `package.json` 与 `scripts/desktop-wrapper/Cargo.toml`，发布前由脚本校验一致。
* 不允许覆盖或移动已经发布的 tag；发现问题发新的 PATCH 版本。
* 当前正式版本以 `main` 分支上的 Git tag 与 GitHub Releases 为准。

---

## 4. 分支模型

* `main`：稳定发布线，只接收已经过预览验证的提交；正式 tag 从 `main` 打出。
* `preview`：日常开发与集成；所有改动先进入这里，预览 tag 从 `preview` 打出。
* `feature/*`、`fix/*`：从 `preview` 或对应的 `release/vX.Y` 拉出，完成后合回，不直接合入 `main`。
* `release/vX.Y`：仅当 `MINOR` 变化时创建，用于该版本的预览、正式发布与后续 PATCH。
* `hotfix/*`：仍先进入 `preview` 发 `vX.Y.Z-preview.N` 验证，确认后合入对应版本线并发布 PATCH。

规则：任何改动都必须先走预览版；预览验证通过后，才把对应提交并入 `main` 并发正式版。
新版本分支只在至少 `MINOR` 变化时创建，PATCH 修复不新开版本分支。

---

## 5. 提交信息

推荐 Conventional Commits 风格（不强制工具链）：

```
feat: 外部插件目录与热扫描
fix: exe 系统通知头像缺失
docs: 重写 README 与发布规范
chore: 升级 cordis
release: 念风Chat v0.41.0
```

---

## 6. 标准发布流程

```powershell
# 0. 版本号：例如预览 v1.2.0-preview.1，确认后正式 v1.2.0
#    修改 package.json 与 scripts/desktop-wrapper/Cargo.toml 为同一版本

# 1. 全量测试（模块检查 / 后端 / 前端端到端 / 对话 / 工具 / 厂商协议）
npm test

# 2. 生成两个发布版（Web 源码 + Web 部署 + 桌面源码 + 念风Chat.exe）
npm run build:release

# 3. 同步到发布工作树并强制安全扫描
node scripts/prepare-publish.mjs
#    输出文件数与内容 SHA-256；如发现敏感内容会列出并退出

# 4. 先发预览：从 preview 分支打 -preview.N tag，发布 pre-release；验证通过后
#    再把对应提交并入 main，在 main 上打正式 tag 并发布正式 Release
node scripts/publish-release.mjs --tag v1.2.0 --notes docs/releases/v1.2.0.md --assets "release/nianfeng-desktop-v1.2.0.exe,release/nianfeng-web-deploy-v1.2.0.zip,release/nianfeng-web-source-v1.2.0.zip"
```

预览与正式的完整顺序、分支与 tag 清理策略见 [`VERSIONING.md`](./VERSIONING.md)。
如果 `gh` 未登录：`gh auth login`（推荐）或确保 SSH / PAT 凭据已配置。

---

## 7. 敏感信息门禁

`scripts/prepare-publish.mjs` 会对发布内容执行以下检查，命中任意一条即中止：

* 本机用户名、`C:\Users\<用户名>` 与开发机项目绝对路径；
* API Key 形态：`sk-*`、`ghp_/gho_/github_pat_*`、AWS `AKIA*`、Google `AIza*`、Slack `xox*`；
* PEM 私钥、`token/secret/password = ...` 形态的长字符串；
* 邮箱、中国大陆手机号、身份证号；
* `config.json`、`sessions.json`、`.secret-key`、`instance.json`、`.env` 等用户数据文件；
* `node_modules`、`user_data`、`data`、`.tmp` 等禁止进入发布的内容。

额外注意：

* 桌面壳编译使用 `--remap-path-prefix` 把 `%USERPROFILE%\.cargo`、`%USERPROFILE%\.rustup`
  与工作区路径映射为 `/cargo`、`/rustup`、`/workspace`；发布前仍会对 `念风Chat.exe` 做二次字符串检查。
* `.gitignore` 忽略 `release/`、`user_data/`、`data/`、`.tmp/`、`node_modules/`、`target/`。
* 代码中不要写死任何真实姓名、邮箱、QQ/微信/手机号、机器路径或密钥；示例一律用占位符。

---

## 8. 热修复（Hotfix）

1. 从最新发布 tag 创建 `hotfix/<version>` 分支；
2. 只修问题，补测试；
3. 走第 6 节流程，版本号递增 PATCH；
4. 发布后把修复合回 `main`（避免丢失）；
5. 在 GitHub Release 说明中写明修复内容与影响范围。

## 9. 回滚

* **代码回滚**：`git revert <commit>` 后发新版；不要重写已发布 tag。
* 例外：如果某个版本被误发布、没有外部使用者，且许可证或发布内容存在严重问题，可以撤回对应的 Release 与 tag，并在下一个版本的发布说明中记录；常规情况不得删除或移动已发布的 tag。
* **发布回滚**：保留旧 Release 资产，在 Release 说明中标注“已由 vX.Y.Z 取代”；
  严重问题可将对应 Release 标记为 pre-release 或删除附件，但必须补发新版本。
* **数据兼容**：数据结构变更必须在发布说明中给出迁移说明；破坏性变更必须升 MAJOR。

---

## 10. 新会话快速接手清单

1. 读 [README](../README.md) → 了解产品与架构优势；
2. 读本文件 → 了解发布纪律与当前仓库地址；
3. 读 [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) → 模块边界与数据流；
4. 读 [`docs/PLUGIN-GUIDE.md`](PLUGIN-GUIDE.md) → 插件协议与扩展点；
5. 读 [`docs/PLUGIN-LIST.md`](PLUGIN-LIST.md) → 现有插件清单；
6. 运行 `npm install && npm test` → 确认基线全绿；
7. 任何对外发布前，重复第 6 节流程，不要跳过 `prepare-publish.mjs`。

---

## 11. 发布 Checklist

- [ ] 版本号已在 `package.json` 与 `Cargo.toml` 同步
- [ ] `npm test` 全部通过
- [ ] `npm run build:release` 成功，exe 可启动
- [ ] `node scripts/prepare-publish.mjs` 安全扫描通过
- [ ] `release/publish` 只包含纯净源码（无大文件 / 用户数据）
- [ ] tag 与 Release 说明已写，并勾选正确的 pre-release 状态
- [ ] Release 资产包含桌面 exe、Web 部署包、Web 源码包
- [ ] README / STATUS / Release notes 中的版本号一致
