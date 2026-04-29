## v2.0.18 — dual-audit 第二轮：跨会话 cascade 串话 + 单请求 OOM + thinking 路由绕审 + panel retry stale offset

接 v2.0.17 的安全审计节奏，这一版又跑了一轮 codex + claude dual-audit（codex 第二轮加深到 13 个 focus area + 起 8+ 个真 PoC：fake HTTP/2 LS、heap OOM probe、CSP header probe）。挑出来的 2 个 HIGH + 2 个 MED 一次修完，全部带回归测试。

This release closes the second round of dual-audit follow-ups against v2.0.17. Two HIGH (cross-session cascade pool collision, single-request OOM in tool emulation), two MED (panel-retry stale trajectory offsets, thinking sibling bypassing model-access policy). All four ship with regression tests.

### 改了什么 / What changed

**🔴 HIGH 1 — `META_TAG_NAMES` auto-learn → 跨会话 cascade pool 串话**

`src/conversation-pool.js` 之前会把客户端发来的 XML tag 自动塞进 `META_TAG_NAMES` 全局 Set，作为 fingerprint stripping 规则。问题是这是**全局可写**的：攻击者先发 `<evil>X</evil>` 训练规则，受害者再发 `<evil>Y</evil>` 内容被剥离 → fingerprint 与攻击者历史相同 → cascade pool checkout 拿到攻击者的 cascadeId → **受害者复用攻击者的上游 server-side 上下文**。

codex 跑了端到端 PoC：`before_dynamic_tag_equal=false` / `after_dynamic_tag_equal=true` / `checkout_cascade=attacker-cascade`。修法是去掉 auto-add，只在 debug 路径 log 未识别 tag。回归测试断言 attacker fp ≠ victim fp。

`META_TAG_NAMES` no longer learns user-supplied XML tags. The previous behavior let an attacker register a tag, then have the victim's same-named tag stripped from their fingerprint — collapsing them onto the same conversation-pool slot and leaking the attacker's cascadeId. Auto-add removed; observation-only logging retained.

**🔴 HIGH 2 — `<tool_call>` / `<tool_result>` 无 buffer 上限 → 单请求 OOM 杀 worker**

`src/handlers/tool-emulation.js` 的 `ToolCallStreamParser` 在 `inToolCall` / `inToolResult` 两个 mode 等待闭合标签时**没有 buffer 上限**。`_consumeJsonBlock` 有 65KB cap 但这两条路径漏了。模型/上游吐出永不闭合的 `<tool_call>...` → buffer 无限增长 → 整个 worker OOM 退出。

codex 在 `--max-old-space-size=64` 下实测：未修前 exit 134 + `JavaScript heap out of memory`；修后 buffer 到 65KB 即丢弃并返回 text 状态。两处都加了和 `_consumeJsonBlock` 一致的 65KB cap。回归测试断言 64KB+ 单 chunk `<tool_call>` 后 `inToolCall=false` / `bufferLen=0`。

`ToolCallStreamParser` now caps the in-progress `<tool_call>` and `<tool_result>` body buffers at 65KB (matching the existing `_consumeJsonBlock` cap). Hitting the cap drops the malformed block and resumes text mode. Previously these two code paths were the only XML buffers in the parser without a cap, allowing a single oversized chunk to OOM the worker.

**🟡 MED 1 — `client.js` panel retry 后 stale `stepOffset` / `generatorOffset`**

`src/client.js` 的 cascade panel-state retry 分支：当 `SendUserCascadeMessage` 拿到 "panel state not found" 错误，proxy 会 re-warm 并发新的 `StartCascade` 拿到 fresh cascadeId。但 `stepOffset` / `generatorOffset` **还停留在 resumeEntry 的旧值**（比如 5）→ 后续 trajectory polling 始终从 offset 5 开始 → fresh cascade 的所有 step 被跳过 → **客户端拿到空响应**。

codex 起了 fake HTTP/2 LS 实测：`observedStepOffsets=[5,5,5,5,5]`，text 为空。修法是在 retry 分支拿到新 cascadeId 之后，重置 `reuseEntry=null; stepOffset=0; generatorOffset=0`。回归测试用真 HTTP/2 server + 完整 protobuf 编码，断言 retry 后第一次 polling offset 为 0 且文本为 'fresh-output'。

After a successful panel-retry re-warm, the new cascade's trajectory is now polled from offset 0 instead of inheriting the expired session's `stepOffset` / `generatorOffset`. Previously, fresh trajectory steps were skipped because the offset was never reset — clients would receive empty responses.

**🟡 MED 2 — thinking sibling 路由绕过 model-access 策略**

`src/handlers/chat.js`：客户端发 `model=claude-sonnet-4.6` + `reasoning_effort=high` → 内部升级到 `claude-sonnet-4.6-thinking`，但 `isModelAllowed(modelKey)` / 账号 entitlement / pool fingerprint / rate-limit / capability 全用**原 base modelKey** 检查。结果 dashboard 只 allow base 的时候，**直接发 thinking 被 model_blocked 拦，但 base+reasoning 通过策略检查继续执行** —— 反过来 dashboard 只 allow thinking 的时候，base+reasoning 又拿不到 thinking 账号。

修法是引入 `routingModelKey = effectiveModelKey`，13 处 access/pool/rate-limit/capability 调用统一用它（`isModelAllowed`、`getApiKey`、`acquireAccountByKey`、`getAccountAvailability`、`isAllRateLimited`、`isAllTemporarilyUnavailable`、`markRateLimited`、`fingerprintBefore`、`shouldUseCascadeReuse` 三种、`isToolSensitiveOpusModel`、`streamResponse`、`nonStreamResponse`、`getAccountList().some(...)`）。`displayModel`（response.model 字段）保持原 `reqModel` 不变。回归测试覆盖两个方向。

`/v1/chat/completions` and `/v1/messages` now route the request based on the effective model after thinking-sibling expansion. Previously the model-access allowlist, account-pool fingerprint, rate-limit checks, and capability gating all ran against the original base model key, allowing `model=base + reasoning_effort=high` to bypass an allowlist that contained only the base name.

### 验证 / Verification

- `node --test test/*.test.js`: **275/275 passing**（v2.0.17 的 269 + 本版新增 6）
- 新增测试覆盖：
  - `conversation-pool.test.js`: 1 条 — attacker XML tag 不污染 victim fingerprint
  - `tool-emulation.test.js`: 2 条 — `<tool_call>` / `<tool_result>` 65KB cap 后 buffer 重置 + 状态退出
  - `client-panel-retry.test.js`（新文件）: 1 条 — fake HTTP/2 LS + protobuf encoding，retry 后 stepOffset 重置为 0
  - `thinking-routing.test.js`（新文件）: 2 条 — base allowlisted 时 base+reasoning 拒入；thinking-sibling allowlisted 时通过 model-access 检查
- 每个 fix 都额外用本地 PoC 端到端跑过验证：
  - HIGH-1: `{"stored":"e2b57f81804cea89","victim":"f610f32f965a0ce1","equal":false}` + `{"checkout_cascade":"null"}`
  - HIGH-2: `{"inToolCall":false,"bufferLen":0,"bufferSafe":true,"heapDeltaMB":"0.05"}` + `{"inToolResult":false,"bufferLen":0,"bufferSafe":true}`

- 流程：
  1. codex 高 reasoning 跑 v2.0.17 全项目 8 大领域审计 → 找出 META_TAG / SSE backpressure / .env.example
  2. codex 第二轮深挖 13 个新 focus area → 找出 tool-emulation OOM cross-check / client.js stale stepOffset / thinking 路由绕审 / dashboard CSP / stats 无 cardinality 上限
  3. claude 同步审 → 找出 tool-emulation OOM（与 codex cross-check 重叠）+ META_TAG 增长（codex 升 HIGH 给的 attack chain）
  4. 比较两份报告：codex 总体显著更深（端到端 PoC 验证 vs claude 看代码推断）；更新 `feedback_audit_workflow.md` 留下复盘
  5. codex full-auto 应用 4 项 P0 修复 + 6 个回归测试 → 275/275 pass
  6. claude 自己再起 PoC 端到端验证 HIGH-1 / HIGH-2 修复生效（**新规则：claude 审 P0 必起 probe，不光看代码**）

### 已知未修 / Deferred

- **MED 3 — SSE 转发忽略 `res.write()` 背压**：`src/handlers/chat.js` / `messages.js` / `responses.js` 三处 stream relay 都没等 drain，慢客户端 / half-close 时 outgoing buffer 会累积。改造需要把 `send()` 改成 async 并等 drain，影响面较大，单独 PR 进 v2.0.19。
- **LOW 1 — Dashboard CSP**：UI 大量 inline handler（codex 实测 inlineHandlers=77），上 strict CSP 前需要先重构 UI，避免 CSP 一上整个 dashboard 不能用。
- **LOW 2 — `stats.js` model bucket / `logger.js` SSE subscribers 无 cardinality 上限**：已认证后才能触发，长跑硬化项进 backlog。
- **LOW 3 — `.env.example` 文档跟上 v2.0.17 fail-closed 语义**：纯文档，下次小修跟。

### Compatibility

- 升级路径：`docker compose pull && docker compose up -d`。
- **行为变化**：`META_TAG_NAMES` 不再 auto-learn 客户端 XML tag。如果你之前依赖某个非 hardcoded tag 被自动剥（比如自定义 `<my_tag>`），现在该 tag 会保留在 history 里参与 fingerprint —— 这正是 HIGH-1 修的本质，**保留行为是不安全的**。需要持久剥某个 tag 的话，请显式加进 `META_TAG_NAMES` hardcoded 列表（PR 欢迎）。
- 行为变化：`<tool_call>` / `<tool_result>` 单 chunk > 65KB 现在直接丢弃而非无限累积。正常工具调用都远小于这个值；触到这个 cap 基本意味着上游/模型出错。
- 行为变化：cascade panel retry 后 trajectory 从 offset 0 拉取，原本"复用部分 trajectory" 的旧行为是 bug（导致客户端拿空响应）；这是 fix，不是 break。
- 行为变化：`reasoning_effort=high` + base model 现在检查的是 thinking sibling 的 model-access / 账号 entitlement，而不是 base 的。如果你的 dashboard allowlist 里只有 base 没有 thinking sibling，base+reasoning 现在会被正确拒掉（之前是漏过）。
- 275/275 tests pass。Zero npm dependencies, unchanged.
