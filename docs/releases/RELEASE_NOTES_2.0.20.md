## v2.0.20 — RPC 序列对齐：补 `Heartbeat` + `UpdatePanelStateWithUserStatus`

接 v2.0.19 fingerprint refresh 的 hardening 后续。codex 上一轮审计发现我们只覆盖 LanguageServerService 171 个 method 中的 10 个（5.8%），而真实 Windsurf editor 在 cascade 前后会调更多 panel/state/heartbeat 类 RPC。这一版补两个高信号的：

1. `Heartbeat` —— 真实 client 启动后会发的探活/同步 RPC，作为 cascade workspace warmup 的最后一步
2. `UpdatePanelStateWithUserStatus` —— 真实 client 拿到 user status 后回写 panel 状态的 reactive sync RPC

This release fills two high-signal RPC gaps in the cascade flow. Real Windsurf clients call `Heartbeat` during startup and call `UpdatePanelStateWithUserStatus` to sync the cascade panel after fetching user status; we never did either. Both are added defensively — failures are logged and ignored, never breaking the cascade flow.

### 改了什么 / What changed

**🟢 `Heartbeat` 加进 cascade workspace warmup**

`src/windsurf.js`：新 builder `buildHeartbeatRequest(apiKey, sessionId)`，proto shape 从 LS 2.12.5 binary descriptor 提取（field 1: metadata，field 2: previous_error_traces 不发，field 3: experiment_config deprecated 不发）。

`src/client.js`：在 `lsEntry.workspaceInit` 异步链最后追加 Heartbeat 调用，顺序变成：
```
InitializeCascadePanelState → AddTrackedWorkspace → UpdateWorkspaceTrust → Heartbeat
```
跟前三个一样用 `handleWarmupError('Heartbeat', e)` 包起来 —— Heartbeat 失败只 warn 不抛，不影响 cascade warmup 完成。

`Heartbeat` is now the last step of the cascade workspace warmup chain. It runs once per LS spawn after `UpdateWorkspaceTrust` completes. Failures are logged and swallowed via the existing `handleWarmupError` pattern.

**🟢 `UpdatePanelStateWithUserStatus` fire-and-forget 跟在 `GetUserStatus` 后**

`src/windsurf.js`：
- 新 builder `buildUpdatePanelStateWithUserStatusRequest(apiKey, sessionId, userStatusBytes)`：field 1 metadata，field 2 user_status（如果 bytes 非空）。protobuf optional 语义允许 user_status 缺省。
- 新 helper `extractUserStatusBytes(getUserStatusResponseBuf)`：从 `GetUserStatusResponse` 顶层 field 1 直接 pass-through user_status 子消息的 raw bytes —— 不解码再编码，保持 wire 层 byte-for-byte 一致。

`src/client.js`：`getUserStatus()` 拿到 LS 响应后立刻 fire-and-forget 调 `UpdatePanelStateWithUserStatus`：
- **不 await** —— 失败只 `log.debug`
- **不影响** `getUserStatus()` 的返回值或错误语义
- session_id 取 lsEntry 当前 sessionId（缺则现场生成 UUID 写回 lsEntry）

After `getUserStatus()` returns, the proxy now fires a non-blocking `UpdatePanelStateWithUserStatus` with the raw `user_status` bytes pass-through. This matches the real Windsurf client's reactive panel sync pattern. The fire-and-forget design ensures the call's success or failure can never affect the upstream `getUserStatus()` return value.

### 验证 / Verification

- `node --test test/*.test.js`: **283/283 passing**（v2.0.19 的 280 + 本版新增 3）
- 新增测试：
  - `heartbeat-builder.test.js`: 1 条 — `buildHeartbeatRequest` 只发 metadata，metadata 内嵌 ide_name=windsurf / extension_version=2.0.67
  - `update-panel-state-builder.test.js`: 1 条 — null user_status → 只 metadata；非空 bytes → field 2 raw pass-through
  - `update-panel-state-extract.test.js`: 1 条 — 构造 fake `GetUserStatusResponse` → extract 出 user_status 子消息字节与原始 sub-message bytes 完全相等
- v2.0.18/v2.0.19 全部回归测试保持绿（panel-retry、META_TAG 隔离、tool-emulation cap、thinking 路由、fingerprint 默认）

### Proto 来源 / Proto provenance

字段号从 LS 2.12.5 binary 提取的 FileDescriptorProto：
- `scripts/ls-protos/text/exa_language_server_pb_language_server.proto.txt:1291` — HeartbeatRequest
- `scripts/ls-protos/text/exa_language_server_pb_language_server.proto.txt:4818` — UpdatePanelStateWithUserStatusRequest

确认来源 = 真实 LS 二进制描述符，不是猜的。

### Compatibility

- 升级路径：`docker compose pull && docker compose up -d`。
- **行为变化**：每次 cascade workspace warmup 现在会多发一个 Heartbeat 调用（5s timeout）；每次 `getUserStatus()` 后会多发一个 fire-and-forget `UpdatePanelStateWithUserStatus`。两个新 call 失败都被 swallow 掉，**不会让任何已 work 的功能断**。
- 行为变化：`getUserStatus()` 返回值前会同步触发 `extractUserStatusBytes()` 解析顶层 field —— 这是纯解析操作，不会改变返回值；万一 response 格式变了导致 extract 拿到 null，UpdatePanelStateWithUserStatus 仍以空 user_status 发出，仍能完成 fingerprint 序列。
- 283/283 tests pass。Zero npm dependencies, unchanged.
- LanguageServerService method 覆盖：10 → 12（5.8% → 7.0%）。还远没"覆盖完"，但补的是 client startup + reactive sync 这两个序列价值最高的位置。

### 下一步 / What's next

如果 sonnet 4.6 `internal_error` 在 v2.0.19 + v2.0.20 之后仍然没缓解，那基本可以确定不是我们的问题（fingerprint + 序列都对齐了）—— 是 Windsurf 后端这几个 model provider 当前不稳。下一步应该是观察 + 等上游恢复，而不是继续在 proxy 侧 hardening。

If `claude-sonnet-4.6` `internal_error` persists past both v2.0.19 (fingerprint refresh) and v2.0.20 (RPC sequence alignment), that strongly suggests the issue is server-side at Windsurf for specific model providers, not anything in our proxy. The right move would be to wait it out or escalate via account ticket rather than continue proxy hardening.
