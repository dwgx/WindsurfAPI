## v2.0.9 — Cloud-deployment hardening (#67 / #68 / cloud tool-calling regression)

This release fixes three independent issues that compounded in cloud deployments:

1. `accounts.json` was getting orphaned on docker-compose upgrades.
2. Bare `claude-4.6` requests silently fell through to a default model.
3. Large tool catalogs (Claude Code, Cline, opencode, Codex CLI) blew past the upstream LS panel-state ceiling and tools were never called.

This release fixes all three. No upstream protocol changes.

### 修复 (Bug fixes)

- **#67 / docker-compose 升级账号丢失**：`accounts.json` 现在固定写在 cluster-shared 的 `<DATA_DIR>/accounts.json`，不再随 `REPLICA_ISOLATE` / 容器 `HOSTNAME` 变化。新增启动迁移：如果 shared 路径上没有 accounts.json 但发现一个或多个 `replica-*/accounts.json`（旧版本残留），自动按 apiKey 取并集写入 shared 路径。重复出现的 apiKey 取首次出现的记录。
- **docker-compose.yml 默认值改为单副本**：`REPLICA_ISOLATE=0` + `replicas: 1`。`runtime-config.json` / `model-access.json` / 响应缓存 / Cascade reuse pool 都还是按进程隔离，多副本是 opt-in，需要使用方自己提供外部协调。
- **#68 / `claude-4.6` 自报 4.5**：根因是 catalog miss 的 silent fallback，不是身份重写缺失。`resolveModel('claude-4.6')` miss 后返回原字符串、`getModelInfo` 返回 null、chat.js 把请求路由进 legacy `rawGetChatMessage` 而 model name 都没传给上游，模型回到训练数据里"Claude 4.5"的自我认知。补 alias `claude-4.6` / `-thinking` / `-1m` / `-thinking-1m` → 对应 `claude-sonnet-4.6*`，并让 chat.js 对未知模型直接返 400 `model_not_found`，不再 silent 降级。
- **Cloud 部署 tool calling 不工作**：`buildCascadeConfig()` 之前把同一份完整 tool schema blob 同时塞进 field 12（`additional_instructions_section`）和 field 10（`tool_calling_section`）。文件内已有的注释早已确认 NO_TOOL planner mode 抑制 field 10 — 它只是在膨胀 payload，给 30+ tools 的 Claude Code / Codex 请求把 panel state 推过 ~30KB 上限，触发 `Panel state missing on Send` 重试链直到放弃。**field 10 现已不再注入**。
- **Tool preamble 容量护栏**：proto-level preamble 超过 `TOOL_PREAMBLE_SOFT_BYTES`（默认 24KB）时自动降级为 names-only compact 形态（保留协议 + 工具名 + 环境块，丢弃参数 schema），超过 `TOOL_PREAMBLE_HARD_BYTES`（默认 48KB）直接返 400 `tool_preamble_too_large`，调用方明确知道要 trim。

Bug fixes:

- **#67 / docker-compose upgrades dropped accounts**: `accounts.json` now lives at the cluster-shared `<DATA_DIR>/accounts.json` regardless of `REPLICA_ISOLATE` or container `HOSTNAME`. On startup, if the shared file is missing but one or more legacy `replica-*/accounts.json` files exist under the data dir (carry-over from prior versions or upgrade cycles with rotating hostnames), they are union-merged by `apiKey` (first-seen wins) and written to the shared path. Duplicate `apiKey` entries are dropped.
- **docker-compose defaults are now single-replica**: `REPLICA_ISOLATE=0` and `replicas: 1`. `runtime-config.json`, `model-access.json`, the response cache, and the Cascade reuse pool are still per-process; multi-replica is opt-in and requires external coordination for those state files.
- **#68 / `claude-4.6` reported itself as 4.5**: this turned out to be a routing fallthrough, not an identity-rewriting gap. `claude-4.6` was missing from the alias table, `resolveModel()` returned the raw string on miss, `getModelInfo()` returned null, and `chat.js` routed the request through the legacy `rawGetChatMessage` path with no model name attached, so the upstream picked a default model whose self-knowledge predates 4.6. Added explicit aliases (`claude-4.6` / `-thinking` / `-1m` / `-thinking-1m` → corresponding `claude-sonnet-4.6*`) and made unknown models return `400 model_not_found` instead of silently degrading.
- **Cloud-deployment tool-calling regression**: `buildCascadeConfig()` was injecting the same full tool schema blob into both `additional_instructions_section` (field 12) and `tool_calling_section` (field 10). The in-file comments already established that NO_TOOL planner mode suppresses field 10 — it was bloating payload without contributing. With 30+ tool catalogs (Claude Code, Cline, opencode, Codex CLI) the doubled blob pushed total LS panel state past the documented ~30KB ceiling and tools silently failed via the panel-state retry path. **Field 10 is no longer written**.
- **Tool preamble byte budget**: when the proto-level preamble exceeds `TOOL_PREAMBLE_SOFT_BYTES` (default 24KB) it is replaced with a names-only compact form (protocol + tool names + environment block, no parameter schemas). When it exceeds `TOOL_PREAMBLE_HARD_BYTES` (default 48KB) the request returns `400 tool_preamble_too_large` so the caller knows to reduce tool count or shrink schemas.

### 兼容性 (Compatibility)

- 未知模型不再 silent fallback — 之前依赖拼写错误回退的调用方现在会拿到 400。这是行为变更，但是正确方向。
- docker-compose 多副本变成 opt-in。如果你之前依赖默认的 3 副本部署，请显式 `docker compose up -d --scale windsurf-api=3` 并接受 `runtime-config.json` / `model-access.json` / 缓存 / cascade pool 仍按进程隔离；后续版本会把这些外部化。
- `claude-4.6`（无 sonnet/opus 后缀）现在路由到 sonnet 变体；如果你之前明确想要 opus 请改用 `claude-opus-4.6`。

Compatibility:

- Unknown model names no longer silently degrade — callers that relied on typo fallback now get an explicit 400. Behavior change, but the correct direction.
- Multi-replica docker-compose is now opt-in. If you previously relied on the 3-replica default, scale explicitly with `docker compose up -d --scale windsurf-api=3` and accept that `runtime-config.json` / `model-access.json` / cache / cascade pool stay per-process for now; externalizing them is on the roadmap.
- Bare `claude-4.6` (no sonnet/opus suffix) routes to the sonnet variant. Use `claude-opus-4.6` explicitly if you wanted opus.

### 新环境变量 (New environment variables)

- `TOOL_PREAMBLE_SOFT_BYTES` (default `24000`) — switch to names-only proto preamble above this size.
- `TOOL_PREAMBLE_HARD_BYTES` (default `48000`) — return 400 `tool_preamble_too_large` above this size.

### 测试覆盖 (Test coverage)

- 全套 174 个测试通过（v2.0.8 = 156）。新增：
  - `test/auth-migration.test.js` — 7 cases 覆盖 replica-* 子目录单/多源迁移、apiKey 去重、损坏 JSON 容错、空目录跳过、shared 已存在短路、sharedDir 不存在。
  - `test/tool-emulation.test.js` — 7 cases 覆盖 compact preamble 与 full schemas 的尺寸比、所有工具名保留、参数 schema 完全删除、环境块保留、`tool_choice=required` 正确、空 tools 边界、无 jailbreak 措辞。
  - `test/models.test.js` — 2 cases 覆盖 bare `claude-4.6` 系列 alias resolve + getModelInfo 落到真实 catalog 条目。
  - `test/tool-preamble-forbidden-words.test.js` — 扩展覆盖 compact preamble。

Test coverage:

- All 174 tests pass (v2.0.8 had 156). New:
  - `test/auth-migration.test.js` — 7 cases covering single/multi-source migration from `replica-*` subdirs, apiKey dedup (first-seen wins), corrupt-JSON tolerance, empty subdir skip, short-circuit when shared accounts.json already exists, missing sharedDir.
  - `test/tool-emulation.test.js` — 7 cases for the compact preamble: size ratio vs full schemas, every tool name preserved, schemas fully omitted, environment block preserved, `tool_choice=required` handled, empty-tools edges, no jailbreak phrasing.
  - `test/models.test.js` — 2 cases for bare `claude-4.6*` resolve + getModelInfo lands on a real catalog entry.
  - `test/tool-preamble-forbidden-words.test.js` — extended to cover compact preamble paths too.

### 致谢

- 报告 #67 / #68 / #69：[@lihengcn](https://github.com/lihengcn)
- 项目级审计：codex 5.4 high-reasoning（archive 在 `tmp/audit-report-2026-04-26-claude-takeover.md`）

Acknowledgements:

- Reports for #67 / #68 / #69 by [@lihengcn](https://github.com/lihengcn).
- Project-wide audit driven by `codex` (gpt-5.4 high-reasoning); archived as `tmp/audit-report-2026-04-26-claude-takeover.md`.
