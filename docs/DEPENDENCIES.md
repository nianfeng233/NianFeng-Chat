<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# 依赖与许可证清单

> 由 `scripts/audit-dependencies.mjs` 自动生成，生成时间：2026-09-11T18:32:07.521Z
> 这份清单用于发布前的依赖审查；如升级依赖，请重新运行 `npm run audit:deps`。

## 结论摘要

- Node 直接 / 运行时依赖：3 个
- Rust 依赖（当前平台可解析）：82 个
- copyleft / 非商业限制类许可证：未发现
- 未标注许可证：未发现

> 注意：许可证是否可用于商业场景，最终以各项目 LICENSE 原文为准；本文件不是法律意见。

## Node / Web 依赖

| 包 | 版本 | 许可证 |
|---|---|---|
| `@standard-schema/spec` | 1.1.0 | MIT |
| `cordis` | 4.0.0-rc.10 | MIT |
| `cosmokit` | 1.8.1 | MIT |

## Rust / 桌面依赖

无法检测 Rust 工具链（spawnSync cargo EPERM）；已使用 docs/rust-dependencies.json 快照

| 包 | 版本 | 许可证 |
|---|---|---|
| `bitflags` | 2.13.1 | MIT OR Apache-2.0 |
| `bytes` | 1.12.1 | MIT |
| `cfg-if` | 1.0.4 | MIT OR Apache-2.0 |
| `cookie` | 0.18.2 | MIT OR Apache-2.0 |
| `crossbeam-channel` | 0.5.16 | MIT OR Apache-2.0 |
| `crossbeam-utils` | 0.8.22 | MIT OR Apache-2.0 |
| `deranged` | 0.5.8 | MIT OR Apache-2.0 |
| `displaydoc` | 0.2.7 | MIT OR Apache-2.0 |
| `dpi` | 0.1.2 | Apache-2.0 AND MIT |
| `dunce` | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 |
| `nianfeng-desktop` | 1.0.0 | MIT |
| `form_urlencoded` | 1.2.2 | MIT OR Apache-2.0 |
| `http` | 1.5.0 | MIT OR Apache-2.0 |
| `icu_collections` | 2.3.0 | Unicode-3.0 |
| `icu_locale_core` | 2.3.0 | Unicode-3.0 |
| `icu_normalizer_data` | 2.3.0 | Unicode-3.0 |
| `icu_normalizer` | 2.3.0 | Unicode-3.0 |
| `icu_properties_data` | 2.3.0 | Unicode-3.0 |
| `icu_properties` | 2.3.0 | Unicode-3.0 |
| `icu_provider` | 2.3.0 | Unicode-3.0 |
| `idna_adapter` | 1.2.2 | Apache-2.0 OR MIT |
| `idna` | 1.1.0 | MIT OR Apache-2.0 |
| `itoa` | 1.0.18 | MIT OR Apache-2.0 |
| `libc` | 0.2.189 | MIT OR Apache-2.0 |
| `litemap` | 0.8.3 | Unicode-3.0 |
| `lock_api` | 0.4.14 | MIT OR Apache-2.0 |
| `log` | 0.4.33 | MIT OR Apache-2.0 |
| `num-conv` | 0.2.2 | MIT OR Apache-2.0 |
| `once_cell` | 1.21.4 | MIT OR Apache-2.0 |
| `parking_lot_core` | 0.9.12 | MIT OR Apache-2.0 |
| `parking_lot` | 0.12.5 | MIT OR Apache-2.0 |
| `percent-encoding` | 2.3.2 | MIT OR Apache-2.0 |
| `potential_utf` | 0.1.6 | Unicode-3.0 |
| `powerfmt` | 0.2.0 | MIT OR Apache-2.0 |
| `proc-macro2` | 1.0.107 | MIT OR Apache-2.0 |
| `quote` | 1.0.47 | MIT OR Apache-2.0 |
| `raw-window-handle` | 0.6.2 | MIT OR Apache-2.0 OR Zlib |
| `scopeguard` | 1.2.0 | MIT OR Apache-2.0 |
| `serde_core` | 1.0.229 | MIT OR Apache-2.0 |
| `serde` | 1.0.229 | MIT OR Apache-2.0 |
| `smallvec` | 1.15.2 | MIT OR Apache-2.0 |
| `stable_deref_trait` | 1.2.1 | MIT OR Apache-2.0 |
| `syn` | 2.0.119 | MIT OR Apache-2.0 |
| `syn` | 3.0.3 | MIT OR Apache-2.0 |
| `synstructure` | 0.13.2 | MIT |
| `tao` | 0.34.8 | Apache-2.0 |
| `thiserror-impl` | 2.0.20 | MIT OR Apache-2.0 |
| `thiserror` | 2.0.20 | MIT OR Apache-2.0 |
| `time-core` | 0.1.9 | MIT OR Apache-2.0 |
| `time-macros` | 0.2.32 | MIT OR Apache-2.0 |
| `time` | 0.3.55 | MIT OR Apache-2.0 |
| `tinystr` | 0.8.4 | Unicode-3.0 |
| `unicode-ident` | 1.0.24 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| `unicode-segmentation` | 1.13.3 | MIT OR Apache-2.0 |
| `url` | 2.5.8 | MIT OR Apache-2.0 |
| `utf8_iter` | 1.0.4 | Apache-2.0 OR MIT |
| `version_check` | 0.9.5 | MIT/Apache-2.0 |
| `webview2-com-macros` | 0.8.1 | MIT |
| `webview2-com-sys` | 0.38.2 | MIT |
| `webview2-com` | 0.38.2 | MIT |
| `windows-collections` | 0.2.0 | MIT OR Apache-2.0 |
| `windows-core` | 0.61.2 | MIT OR Apache-2.0 |
| `windows-future` | 0.2.1 | MIT OR Apache-2.0 |
| `windows-implement` | 0.60.2 | MIT OR Apache-2.0 |
| `windows-interface` | 0.59.3 | MIT OR Apache-2.0 |
| `windows-link` | 0.1.3 | MIT OR Apache-2.0 |
| `windows-link` | 0.2.1 | MIT OR Apache-2.0 |
| `windows-numerics` | 0.2.0 | MIT OR Apache-2.0 |
| `windows-result` | 0.3.4 | MIT OR Apache-2.0 |
| `windows-strings` | 0.4.2 | MIT OR Apache-2.0 |
| `windows-threading` | 0.1.0 | MIT OR Apache-2.0 |
| `windows-version` | 0.1.7 | MIT OR Apache-2.0 |
| `windows` | 0.61.3 | MIT OR Apache-2.0 |
| `writeable` | 0.6.4 | Unicode-3.0 |
| `wry` | 0.53.5 | Apache-2.0 OR MIT |
| `yoke-derive` | 0.8.2 | Unicode-3.0 |
| `yoke` | 0.8.3 | Unicode-3.0 |
| `zerofrom-derive` | 0.1.7 | Unicode-3.0 |
| `zerofrom` | 0.1.8 | Unicode-3.0 |
| `zerotrie` | 0.2.5 | Unicode-3.0 |
| `zerovec-derive` | 0.11.4 | Unicode-3.0 |
| `zerovec` | 0.11.7 | Unicode-3.0 |

## 许可证分布

- `(MIT OR Apache-2.0) AND Unicode-3.0`：Node 0 个，Rust 1 个
- `Apache-2.0`：Node 0 个，Rust 1 个
- `Apache-2.0 AND MIT`：Node 0 个，Rust 1 个
- `Apache-2.0 OR MIT`：Node 0 个，Rust 3 个
- `CC0-1.0 OR MIT-0 OR Apache-2.0`：Node 0 个，Rust 1 个
- `MIT`：Node 3 个，Rust 6 个
- `MIT OR Apache-2.0`：Node 0 个，Rust 49 个
- `MIT OR Apache-2.0 OR Zlib`：Node 0 个，Rust 1 个
- `MIT/Apache-2.0`：Node 0 个，Rust 1 个
- `Unicode-3.0`：Node 0 个，Rust 18 个

## 发布前检查

- [ ] 项目自身的 `LICENSE` / 版权归属已由发布方确认（当前为专有声明，可按需替换为 MIT / Apache-2.0 等）
- [ ] 已随 Web 部署版携带 `THIRD-PARTY-NOTICES.md`
- [ ] 桌面 exe 发布目录已携带 `THIRD-PARTY-NOTICES.md`
- [ ] 若使用第三方模型 API（DeepSeek / OpenAI / Anthropic / Gemini 等），已阅读并遵守对应服务条款
- [ ] 产品名称、Logo、图标涉及第三方商标时已完成授权确认
- [ ] Node.js 与 WebView2 Runtime 的分发 / 依赖方式符合各自许可要求
