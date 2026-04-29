## v2.0.7 — Audit-driven hardening + Codex/Anthropic spec compliance

### 修复 (Bug fixes)

- 修复 #59 sub-bug 3 工具边界文本被切两段：`ToolCallStreamParser.feed()` 之前返回 `{text, toolCalls}` 两个独立数组，丢失了 text 与 tool_call 在同一 chunk 内的相对顺序，导致 `C. 我不会` / Read 工具 / `修改文件，也不会扩大 scope` 这种"句子被工具切两段"的现象。新增 `items` 字段保留顺序，stream 消费方按 items 顺序 emit；`text/toolCalls` 保留向后兼容。
- 修复 #66 限流时间精度与 cooldown 累积偏差：`rateLimitCooldownMs` 现在解析 `retry after N seconds/minutes/hours` 文案；`markRateLimited` 改为 `Math.max(existing, new)`，并发 429 不再把 cooldown 不断后推；preflight 没拿到具体 retry 时间时不再本地标 cooldown，本次 skip 即可。
- 修复 #59 sub-bug 2 长输出被 180s 硬截断：`CASCADE_MAX_WAIT_MS` 默认从 180s 提到 600s，`warmStallMs=25s` 仍负责真正卡死的 cascade 退出，给慢但持续流的长输出留足空间。
- 修复 #63 streaming response.completed 被静默丢弃：`/v1/responses` 生命周期事件（created / in_progress / completed / failed）payload 改为 OpenAI 规范的 `{ response: {...} }` envelope；新增 `sequence_number` 单调递增字段；补 `response.in_progress` 事件。
- 修复 cache HIT 流式分支与 live-stream chunk shape 不一致：cache HIT 也拆成独立的 `finish_reason` chunk + 单独的 usage chunk，跟 live-stream 路径同形。
- 修复全账号 RPM 满返 503：现在返 429 + `Retry-After` 头让客户端能正常重试，503 只在真没账号时返。
- 修复 preflight skip 占住本地 RPM headroom：account 增加 `_lastReservationAt`，preflight !hasCapacity 路径自动 `refundReservation` 退回 `_rpmHistory`。

Bug fixes:

- Fixed #59 sub-bug 3 tool-boundary text split: `ToolCallStreamParser.feed()` previously returned `{text, toolCalls}` as separate arrays and lost the relative order of text and tool_call within a single chunk, producing "sentence cut by a tool call" symptoms like `C. 我不会` / Read / `修改文件…`. Added an ordered `items` field; stream consumer now emits in order; `text/toolCalls` kept for back-compat.
- Fixed #66 rate-limit cooldown precision and accumulation drift: `rateLimitCooldownMs` now parses explicit `retry after N seconds/minutes/hours`; `markRateLimited` uses `Math.max(existing, new)` so concurrent 429s don't keep extending cooldown; preflight without explicit retry time only skips this attempt instead of poisoning local cooldown.
- Fixed #59 sub-bug 2 long-output 180s truncation: raised `CASCADE_MAX_WAIT_MS` default from 180s to 600s; `warmStallMs=25s` still exits genuinely-stalled cascades.
- Fixed #63 silently-dropped `response.completed`: `/v1/responses` lifecycle events (created / in_progress / completed / failed) now use the OpenAI-spec `{ response: {...} }` envelope; added monotonic `sequence_number`; added the missing `response.in_progress`.
- Fixed cache-hit stream chunk shape mismatch with live stream: cache-hit path also splits into a `finish_reason` chunk + a separate usage chunk, matching live-stream shape.
- Fixed all-RPM exhaustion returning 503: now returns 429 + `Retry-After` so clients can retry; 503 reserved for the genuinely no-account case.
- Fixed preflight skip still consuming local RPM headroom: account adds `_lastReservationAt`; the preflight `!hasCapacity` path auto-refunds the reservation in `_rpmHistory`.

### 兼容性与规范 (Compatibility / spec)

- `/v1/responses` 拒绝非 `function` tools（如 `web_search_preview`）改为 400 错误，避免静默 drop 后客户端语义已变；function-call-only 响应不再带空 `message` item 在 `output`。
- `/v1/messages` 透传 Anthropic `thinking` 字段；`tool_choice` 映射到 OpenAI 形状（`auto` → `auto`、`any` → `required`、`tool/name` → `{type:'function',function:{name}}`、`none` → `none`）。
- `/v1/responses` 流式新增 Codex CLI v0.125 期望的最小 envelope：`{"type":"response.completed","response":{"id":"resp_…",…},"sequence_number":N}`；非生命周期事件（output_item.* / content_part.* / output_text.* / reasoning_*.* / function_call_arguments.*）shape 不变。

Compatibility / spec:

- `/v1/responses` rejects non-`function` tools (`web_search_preview`, etc.) with 400 instead of silently dropping; function-call-only responses no longer include an empty `message` item in `output`.
- `/v1/messages` now passes through Anthropic `thinking`; `tool_choice` is mapped to OpenAI shape (`auto` → `auto`, `any` → `required`, `tool/name` → `{type:'function',function:{name}}`, `none` → `none`).
- `/v1/responses` streaming now emits the minimal envelope Codex CLI v0.125 expects: `{"type":"response.completed","response":{"id":"resp_…",…},"sequence_number":N}`. Non-lifecycle events (output_item.*, content_part.*, output_text.*, reasoning_*.*, function_call_arguments.*) shape unchanged.

### CI / 发布流程 (CI / release)

- 新增 `.github/workflows/release.yml`：推 `v*` tag 时自动构建 `linux/amd64` Docker 镜像推 GHCR + 创建 GitHub Release（`RELEASE_NOTES_x.y.z.md` 自动作为 body，含 `-` 自动 prerelease）。
- `docker-compose.yml` 同时保留 `image:` 与 `build:`：默认拉预构建镜像，`docker compose up --build` 仍可本地源码迭代。
- 修正镜像命名 `windsurfapi` → `windsurf-api`（与 `package.json` 项目名对齐）。

CI / release:

- Added `.github/workflows/release.yml`: pushing a `v*` tag now auto-builds the `linux/amd64` Docker image to GHCR and creates a GitHub Release (with `RELEASE_NOTES_x.y.z.md` as the body; tags containing `-` become pre-releases).
- `docker-compose.yml` keeps both `image:` and `build:`: pulls the prebuilt image by default, `docker compose up --build` still iterates locally.
- Image name corrected to `windsurf-api` (aligned with `package.json` project name).

### 测试覆盖 (Test coverage)

- 全套 158 个测试通过（v2.0.6 = 144），新增 12 个：parser ordered-items 、cooldown 解析、preflight refund、429 not 503、`/v1/messages` thinking + tool_choice 透传、`/v1/responses` 非 function tools 与空 message item、cache-hit chunk shape 与 live-stream 同形等。
- Mac arm64 (node v24.13.0) 同样 158/158 通过，跨平台无回归。

Test coverage:

- All 158 tests pass (was 144 in v2.0.6); 12 new: parser ordered items, cooldown parsing, preflight refund, 429 not 503, `/v1/messages` thinking + tool_choice passthrough, `/v1/responses` non-function tools and empty message items, cache-hit chunk shape parity with live stream.
- Mac arm64 (node v24.13.0) also passes 158/158, cross-platform clean.

### 致谢

- 本版基于 gpt-5.5 high-reasoning 全项目代码审计（296 行 P0/P1/P2 报告，归档在 `tmp/audit-report-2026-04-26.md`，未发版）。
- CI / release workflow by [@abwuge](https://github.com/abwuge) (PR #65)。
- Codex CLI v0.125 SSE 解析路径反查与 envelope 规范定位由 codex worker 完成。
- 关联 issue: #59, #63, #66。

Acknowledgements:

- Driven by a gpt-5.5 high-reasoning project-wide audit (296-line P0/P1/P2 report, archived at `tmp/audit-report-2026-04-26.md`).
- CI / release workflow by [@abwuge](https://github.com/abwuge) (PR #65).
- Codex CLI v0.125 SSE parser RE and envelope spec localization by the codex worker.
- Related issues: #59, #63, #66.
