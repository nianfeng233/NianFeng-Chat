<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# 安全加固记录（2026-09 审查反馈）

> 背景：社区同学用 GLM 对仓库做了一轮快速审查，本文逐条记录结论、修复位置与回归测试。
> 结论以当前代码为准；不是“项目已通过安全审计”的声明。

## 一、逐条结论

| # | 审查意见 | 结论 | 处理 |
|---|---|---|---|
| 1 | `Access-Control-Allow-Origin: *`，无 Origin / Host 校验，可被任意网页读取本机会话与配置，存在 DNS rebinding 风险 | **属实**。旧代码在 JSON / SSE / OPTIONS / 静态资源处全部返回 `*`，且未校验 Host | `server/plugins/http.mjs` 改为 Host + Origin 双重校验；CORS 只精确回显白名单 Origin，不再输出 `*`；`start.mjs` 代理层同步加固；新增 `NIANFENG_ALLOWED_ORIGINS` / `NIANFENG_ALLOWED_HOSTS` 供非默认部署显式放行 |
| 2 | 静态目录用 `startsWith(staticDir)`，兄弟目录可绕过 | **属实**。例：`staticDir=...\public`，请求 `/%2e%2e/public-secret/secret.txt` 会解析到 `...\public-secret\secret.txt` 且通过前缀判断 | 新增 `server/security-utils.mjs#isInsideDir()`，用 `path.relative` 做目录边界判断；`http.mjs`、`start.mjs`、`plugin-registry.mjs` 统一复用；回归测试覆盖 URL 编码 `..` 与反斜杠变体 |
| 3 | `/api/health`、`/api/version` 免鉴权并泄露 `dataDir`、`configFile`、提供商状态等 | **部分属实**。health 在配置令牌后仍完整外泄；version 原本只有版本号，不敏感 | health 分层：未认证只返回存活探针所需字段（`ok / version / capabilities / runtime / authRequired`）；目录、配置文件、提供商、默认模型、会话统计需要令牌（Cookie 或 `X-NianFeng-Token` / `Authorization`）才返回；未配置令牌时保持原行为，便于本地 UI 自检 |
| 4 | `/api/rss` 通用代理，无内网 IP 黑名单，可当 SSRF 跳板 | **属实** | 新增 `server/net-guard.mjs`：拒绝 localhost / 环回 / 私有 / CGNAT / 链路本地 / 云元数据 / 组播 / 保留地址与非 http(s) 协议；手动跟随重定向，每一跳重新校验 DNS 与协议；请求使用已校验地址固定 DNS lookup，降低 DNS rebinding 窗口 |
| 5 | 令牌比较是 `===` 非常数时间；令牌仍可放在 `?token=` URL 里 | **属实** | 比较改为 SHA-256 + `timingSafeEqual`（`timingSafeStringEqual`）；`?token=` 只允许用于首次 HTML 导航换取 HttpOnly Cookie，兑换后 302 到清理过 token 的地址；API 只接受 Cookie 或请求头；`start.mjs` 与后端行为一致 |
| 6 | SSE 关停依赖 1.5s 兜底，没有 `closeAllConnections()` | **属实** | `http.mjs` 跟踪所有 socket，`dispose` 先 `close()`、`closeIdleConnections()`，250ms 宽限后 `closeAllConnections()` 并逐个 `destroy()` 兜底；`start.mjs` 的 WebUI 代理服务器同样处理；回归测试验证存在 SSE 时 `close()` 快速返回 |
| 7 | 仓库历史浅、两天 8 个 commit、无社区、README 由 AI 整理，v1.0.0 不代表成熟度 | **属实，但不是代码漏洞**，也无法通过重写历史“修复” | README 增加项目状态声明：版本号只代表功能里程碑，不代表生产级成熟度或安全审计；本次新增本文档与回归测试，补强过程可追溯性 |
| 8 | 在 cordis 上搭影子框架，`effect` / `provide` / `inject` 语义被改写，服务改名（`logger` → `logs` 等），升级会痛 | **属实，属于有意的兼容层技术债** | `docs/ARCHITECTURE.md` 增加“cordis 兼容层与升级边界”：列出语义差异、升级清单与分批迁移策略；`package.json` 将 cordis 固定为 `4.0.0-rc.10`；新插件要求采用 cordis 原生两层 `effect` 写法 |
| 9 | 微信渠道用非官方 iLink / Clawbot 协议，扫码真微信号，无风险提示；同一二维码库复制三份 | **微信非官方协议为用户明确指出的误判**：项目定位就是接入个人微信的 Clawbot 渠道，代码与 README 中已说明；二维码库在源仓库中只有两个内置渠道各自 `vendor/` 各一份，用于插件独立分发，release / `.tmp` 目录是构建产物，不属于重复维护；未做改动 | 无 |

> 加固过程中额外发现并修复：单端口 / 开发模式的静态托管原本会把项目根目录下的 `user_data/config.json`、
> `.git` 等文件直接当静态资源发出。现在两个静态入口统一通过 `isSensitiveStaticPath()` 返回 404，
> 独立 WebUI 服务器也补上了与后端一致的 Host 校验。

## 二、本次修改文件

- `server/security-utils.mjs`（新增）：常量时间比较、目录边界判断、静态敏感路径判断
- `server/net-guard.mjs`（新增）：SSRF 地址分类、固定 DNS 请求、重定向逐跳校验
- `server/plugins/http.mjs`：CORS / Host / Origin、health 分层、RSS 防护、静态边界、敏感文件屏蔽、SSE 关闭
- `server/plugins/plugin-registry.mjs`：外部插件文件读取复用统一目录边界判断
- `plugins/domain/image-service/bridge.mjs`：移除图片接口多余的通配 CORS 头，统一由 http 主入口按 Origin 白名单下发
- `start.mjs`：WebUI 代理层 Host / Origin / 令牌 / 静态边界 / 关闭流程同步加固；导出 WebUI 与 Origin 工具供安全测试复用
- `plugins/foundation/backend-client/index.mjs`：绝对后端地址场景携带 Cookie（`credentials: include`）
- `scripts/test-security.mjs`：安全回归测试（含访问令牌摘要化与生产监听门禁；数量以实际输出为准）
- `README.md` / `README.en.md` / `docs/ARCHITECTURE.md` / `docs/PLUGINS.md` / `package.json` / `package-lock.json`

## 三、仍存在的边界与建议

1. **历史安装可能仍无令牌**：全新首次运行会自动生成随机访问令牌并只打印一次；但老版本升级上来的实例如果历史上从未设置令牌，仍保持“无令牌”状态，需要用户到「设置 → 网络」主动设置。Host / Origin 校验只挡住浏览器网页跨站读取，本机安全仍依赖操作系统账户边界。
2. **开放监听要配令牌**：`webuiHost = 0.0.0.0` 或反向代理到公网时，务必设置强随机访问令牌；如使用自定义域名 / 端口，通过 `NIANFENG_ALLOWED_ORIGINS`、`NIANFENG_ALLOWED_HOSTS` 放行。`NODE_ENV=production` 且监听 `0.0.0.0` / `::` 时若无令牌会直接拒绝启动。
3. **HTTP 明文**：本地默认是 HTTP，Cookie 不带 `Secure`；不要把这个本地端口直接暴露到不可信网络。
4. **浏览器兼容性**：Origin 防护依赖现代浏览器发送 `Origin` 头；极老浏览器或特殊客户端可能没有该头，此时本机进程级防护仍然有效，跨站读取风险也较低。
5. **外部插件权限**：`bridge.mjs` 是 Node 代码，权限等同主进程；只加载可信插件。
6. **dns pinning 局限**：net-guard 已用固定 lookup 降低 DNS rebinding 窗口，但若本机上存在恶意 DNS / hosts 配置，无法完全消除；SSRF 高风险部署建议再叠加出网代理与防火墙策略。

## 四、验证方式

```bash
npm run test:security   # 防护回归（精准数量以实际输出为准）
npm run test:failover   # 备用模型列表降级顺序回归
npm run test:backend    # 后端 API 全量回归
npm run check:style     # .mjs 风格一致性检查
npm test                # 完整测试链
```
