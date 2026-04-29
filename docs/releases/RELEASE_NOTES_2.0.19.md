## v2.0.19 — fingerprint refresh：客户端 metadata 跟上 Windsurf 2.0.67 + Connect 真的成 transport 默认

接 v2.0.18 的指纹审计。codex 拉了真实 Windsurf 2.0.67 客户端 + LS 2.12.5 二进制对比，发现两件事：

1. 我们发给 LS 的 `extension_version` / `ide_version` 一直伪装成 `1.9600.41`（一个根本不存在的版本），而真实 Windsurf editor 当前 stable 是 `2.0.67`。
2. `src/grpc.js` 的注释说 "Connect by default"，但代码 `process.env.GRPC_PROTOCOL === 'connect'` 实际是 "Connect only when explicit env"。生产没设 env，走 legacy gRPC + UA `grpc-node/1.108.2`（注释 vs 代码不一致已经是 bug）。

This release closes the fingerprint audit follow-up. Codex pulled the real Windsurf 2.0.67 client + LS 2.12.5 binary and found that our spoofed `extension_version` / `ide_version` (`1.9600.41`) is a non-existent version while real Windsurf is on `2.0.67`. `src/grpc.js` also had a comment-vs-code mismatch where Connect was supposed to be the default but only kicked in when `GRPC_PROTOCOL=connect` was set explicitly.

### 改了什么 / What changed

**🟢 Fix 1 — `extension_version` / `ide_version` 默认值 `1.9600.41` → `2.0.67`**

`src/windsurf.js`：`buildMetadata()` 默认版本从硬编码 `1.9600.41` 改成 `DEFAULT_CLIENT_VERSION = process.env.WINDSURF_CLIENT_VERSION || '2.0.67'`。所有 6 个 request builder（`buildRawGetChatMessageRequest` / `buildInitializePanelStateRequest` / `buildUpdateWorkspaceTrustRequest` / `buildStartCascadeRequest` / `buildSendCascadeMessageRequest` / `buildGetUserStatusRequest`）调用点签名不变，自动用新默认。`extension_name=windsurf`、`ide_name=windsurf`、`os` / `hardware` 等其他 metadata 字段不变。

新增 env override `WINDSURF_CLIENT_VERSION`：operator 想跟上更新版本不需要改代码、不需要重新发版，直接 `WINDSURF_CLIENT_VERSION=2.0.99` 起 container 即可。

`buildMetadata()` defaults `extension_version` and `ide_version` to `2.0.67` (matches Windsurf editor 2026-04-21 stable). New `WINDSURF_CLIENT_VERSION` env lets operators override without a code change.

**🟡 Fix 2 — `GRPC_PROTOCOL` 默认走 Connect**

`src/grpc.js:12`：`USE_CONNECT = process.env.GRPC_PROTOCOL === 'connect'` → `USE_CONNECT = process.env.GRPC_PROTOCOL !== 'grpc'`。Connect 现在是真正的 transport 默认（与文件顶部注释一致），生产再不需要显式设 env；要回退 legacy 调试时 `GRPC_PROTOCOL=grpc`。

注：这是 proxy ↔ 本地 LS 的 h2c transport，**不影响** LS → Windsurf 云端的 outbound 指纹（那是 LS 二进制内部决定）。修这一项主要是行为与注释一致 + Connect headers（`connect-protocol-version: 1` / `connect-accept-encoding: gzip`）更接近真实 client。

`GRPC_PROTOCOL` now defaults to `connect` instead of requiring explicit opt-in. Set `GRPC_PROTOCOL=grpc` to fall back to legacy gRPC framing for debugging.

### 验证 / Verification

- `node --test test/*.test.js`: **280/280 passing**（v2.0.18 的 275 + 本版新增 5）
- 新增测试：
  - `client-fingerprint.test.js`: 3 条 — 默认 `2.0.67` / `WINDSURF_CLIENT_VERSION` env override / 显式参数覆盖默认
  - `grpc-transport-default.test.js`: 2 条 — env unset 走 Connect / `GRPC_PROTOCOL=grpc` 走 legacy
- 测试使用 ESM dynamic import + cache-bust query (`'../src/grpc.js?transport-default'`) 隔离 module-level const 缓存
- 不影响 v2.0.18 任何修复：META_TAG 隔离、tool-emulation 65KB cap、panel retry stepOffset、thinking 路由 routingModelKey 全部保持

### 修复诊断流程 / Audit method

- 生产观察：claude-sonnet-4.6 / claude-4.5-haiku / claude-opus-4.6 / gemini-3.0-flash / gpt-5.1 / grok-code-fast-1 大量 `internal_error`，但 gemini-2.5-flash / kimi-k2 / swe-1.6 / minimax-m2.5 完全正常 → 排除"全局账号被封" / "全局指纹被识别"，指向上游 model provider transient
- codex 高 reasoning 起独立审计：
  - web search 找到 Windsurf editor 2.0.67 (Apr 21 2026) + LS 2.12.5 (Jan 26 2026 release，与生产装的同版本)
  - 拉 Windsurf-linux-x64-2.0.67.tar.gz + 解压 + 校验 product.json + extension package.json
  - 同版本 LS binary 拉 `language_server_linux_x64.gz` + strings dump 找 RPC 全集 (171 个 LanguageServerService method，我们用 10 个)
  - 比对 `src/windsurf.js` `buildMetadata()` 实际发的 fingerprint vs 真实 Windsurf
- 结论：`internal_error` 最可能是上游 transient（gemini 工作是反证），但 fingerprint `1.9600.41` 是个完全不存在的版本号，趁这次审计一并修
- 报告：`tmp/codex-fingerprint-audit-2026-04-29.md`

### Compatibility

- 升级路径：`docker compose pull && docker compose up -d`。
- 行为变化：发给 LS 的 `extension_version` / `ide_version` 从 `1.9600.41` 变成 `2.0.67`。这是 metadata 字段，对**绝对多数**部署完全无感（LS 不挑客户端版本）。如果你的 LS 二进制 / 上游账号有奇怪的版本绑定，可以 `WINDSURF_CLIENT_VERSION=1.9600.41` 回到旧值。
- 行为变化：`GRPC_PROTOCOL` 默认值从隐式 legacy 变成显式 Connect。生产从 v2.0.7 开始的 GHCR 镜像未曾设过这个 env，所以**实际行为切换**：从 legacy gRPC framing 切到 Connect framing。两个 transport 都被 LS 端支持（v2.0.17 起加固 over），但 Connect 更接近真实 client 行为。如果某个奇怪的部署需要 legacy 回退：`GRPC_PROTOCOL=grpc`。
- 280/280 tests pass。Zero npm dependencies, unchanged.

### 下一步预告 / What's next

v2.0.20 计划补 `UpdatePanelStateWithUserStatus` + `Heartbeat` 两个 RPC，让 cascade 调用序列更接近真实 editor（目前 10/171 method 覆盖）—— 不是为了治当前症状，是 hardening。Codex 第二轮活。

If `claude-sonnet-4.6` upstream `internal_error` persists past this release, that confirms it's a Windsurf Cascade backend issue with specific model providers, not a fingerprint problem on our side — the natural next step would be to wait it out or escalate via a Windsurf account ticket, not more proxy hardening.
