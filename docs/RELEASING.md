# 版本管理与发布规范（RELEASING）

> 面向后续维护者与新会话的“单一事实来源”。任何发布动作都必须走本文件描述的流程；
> 发布前的强制安全扫描见 [`scripts/prepare-publish.mjs`](../scripts/prepare-publish.mjs)。

---

## 1. 总原则

1. **workspace 是唯一开发源**：日常开发、修复、测试都在工作区完成。
2. **发布仓库不直接开发**：GitHub 仓库内容来自 `release/publish`，由脚本从 `release/web/source` 同步，
   禁止在发布工作树里手工改代码（下次同步会被覆盖）。
3. **发布产物与源码分离**：
   * Git 仓库只放纯净源码（约 2 MB），不放 `node.exe`、`exe`、`node_modules`、`user_data` 等；
   * 预编译产物（`风语.exe`、Web 部署包）通过 GitHub Releases 附件分发。
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
| `release/desktop/deploy/风语.exe` | Windows 桌面单文件 | 否（作为 Release 附件） |
| `release/publish/` | **GitHub 发布仓库工作树**，内容 = `release/web/source` 的纯净副本 | 是（发布仓库，独立 `.git`） |
| `release/*.zip`、`release/fengyu-desktop-*.exe` | Release 附件 | 否 |

> `release/publish` 不参与 `npm run build:release` 的清理（打包只删除 `release/web` 与 `release/desktop`），
> 因此可以安全地作为发布仓库长期存在。

当前 GitHub 发布仓库：

* `https://github.com/nianfeng233/fengyu-chat`（public，Apache-2.0）

---

## 3. 版本号规范

采用 [语义化版本](https://semver.org/lang/zh-CN/)：`MAJOR.MINOR.PATCH`，统一前缀 `v` 作为 Git tag。

> 注意：README、文档措辞、注释等**不改变功能的改动不单独发 Release**，随下一次功能版本一起发布；
> 只有在许可证、安全性或发布内容存在必须立即更正的问题时，才发 PATCH 并在说明中注明原因。

| 版本 | 场景 | 示例 |
|---|---|---|
| `MAJOR` | 破坏性变更（数据结构、插件协议、配置不兼容） | `v1.0.0` |
| `MINOR` | 向后兼容的新功能 | `v0.41.0` |
| `PATCH` | 向后兼容的 Bug / 安全修复 | `v0.40.1` |
| `-alpha.N` | 内部验证，随时可能大改 | `v0.41.0-alpha.1` |
| `-beta.N` | 功能接近冻结，欢迎测试 | `v0.41.0-beta.2` |
| `-rc.N` | 候选发布，只修阻塞问题 | `v0.41.0-rc.1` |

规则：

* 版本号同时写入 `package.json` 与 `scripts/desktop-wrapper/Cargo.toml`，发布前由脚本校验一致。
* 预发布版本在 GitHub Release 上必须勾选 **Set as a pre-release**。
* 不允许覆盖或移动已经发布的 tag；发现问题发新的 PATCH 版本。
* 当前正式版本以 Git tag 与 GitHub Releases 为准。

---

## 4. 分支模型

| 分支 | 用途 | 规则 |
|---|---|---|
| `main` | 稳定发布分支 | 只接受通过测试的变更；每个发布从 main 打 tag |
| `dev` | 日常开发集成分支 | 可选；多人协作时功能先合入 dev |
| `feature/<name>` | 新功能 | 从 dev/main 拉出，完成后合回 |
| `fix/<name>` | 普通修复 | 同上 |
| `hotfix/<version>` | 线上紧急修复 | 从最新 tag 拉出，修复后直接发 PATCH |
| `release/<version>` | 发布准备（仅大型版本） | 只修 release blocker，冻结功能 |

单人维护时可以简化：直接在 `main` 开发，但**任何发布都必须打 tag**，且发布工作树独立。

---

## 5. 提交信息

推荐 Conventional Commits 风格（不强制工具链）：

```
feat: 外部插件目录与热扫描
fix: exe 系统通知头像缺失
docs: 重写 README 与发布规范
chore: 升级 cordis
release: 风语 v0.41.0
```

---

## 6. 标准发布流程

```powershell
# 0. 版本号
#    修改 package.json 与 scripts/desktop-wrapper/Cargo.toml 为同一版本，例如 0.41.0

# 1. 全量测试（模块检查 / 后端 / 前端端到端 / 对话 / 工具 / 厂商协议）
npm test

# 2. 生成两个发布版（Web 源码 + Web 部署 + 桌面源码 + 风语.exe）
npm run build:release

# 3. 同步到发布工作树并强制安全扫描
node scripts/prepare-publish.mjs
#    输出文件数与内容 SHA-256；如发现敏感内容会列出并退出

# 4. 一键提交 / 打 tag / 推送 / 创建 Release（含附件）
node scripts/publish-release.mjs --tag v0.41.0 --notes docs/releases/v0.41.0.md --assets "release/fengyu-desktop-v0.41.0.exe,release/fengyu-web-deploy-v0.41.0.zip,release/fengyu-web-source-v0.41.0.zip"
```

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
  与工作区路径映射为 `/cargo`、`/rustup`、`/workspace`；发布前仍会对 `风语.exe` 做二次字符串检查。
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
