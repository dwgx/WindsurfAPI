## v2.0.25 — Cascade conversation reuse 全面加固（codex 深度审计后续）

v2.0.24 收尾时让 codex 开 sub-agents 把 conversation pool 从 fingerprint 算法到 expired-cascade 失败模式深度审了一遍（报告：`tmp/codex-cascade-reuse-audit-2026-04-29.md`，21KB，2 HIGH + 3 MED + 2 LOW）。这一版把全部 7 条整改实施完，加 15 个新测试覆盖审计指出的回归窗口。

This release implements every fix from the v2.0.24 codex deep audit of cascade conversation reuse. Two HIGH-severity correctness fixes (semantic state key + expired-cascade fresh fallback), one HIGH isolation fix (per-user scope for chat/responses), three MEDs (tool schema digest, TTL policy, atomic checkout), and two LOWs (LS-restart sync, history coverage). 15 new tests added. **311/311 passing**, no behavior regressions.

---

### 🔴 HIGH-1: reuse key 升级成 server-state semantic key

**问题**: 旧 fingerprint 只 hash `(callerKey, modelKey, user-text)`，silent 忽略 system / assistant text / assistant tool_calls / 多模态 / tool schema。两个客户端发同样 user 文本但不同 system / assistant / tool 配置，会撞同一 cascade entry，命中后 `SendUserCascadeMessage` 直接送旧 cascade，上游带着 stale state 续聊 —— 输出是错的，但用户看不出来（cross-context bleed）。

**改了什么** (`src/conversation-pool.js` 大幅重写):
- 新 `canonicalContentBlock`: image_url / base64 / file_id 单独算稳定 hash（无法 hash 的媒体直接 disable reuse）
- 新 `projectMessage`: assistant 投影成 `{role, text(whitespace-normalized), tool_calls[{name,args}]}`，tool result 保留 `tool_call_id`
- 新 `stableStringify`: 递归排序 object key，消除客户端序列化顺序差异
- 新 `systemDigest`: 默认包含 system（`CASCADE_REUSE_HASH_SYSTEM=0` opt-out，反向旧默认）
- 新 `toolContextDigest`: emulateTools 时把 tools (name+description+parameters) + tool_choice + preambleTier + toolPreamble hash 进 key
- key 结构新增 `version: 2` 字段防 silent 跨版本碰撞
- `fingerprintAfter` 现在接收完整 message 列表（含我们生成的 assistant turn），`chat.js` 用新的 `appendAssistantTurn(messages, allText, toolCalls)` 拼接

**影响**: 命中率会下降（因为 system / assistant 变化现在 miss），但每次命中都"语义对得上"。这是 **correctness over hit-rate** 的取舍 —— 旧默认是错的。

### 🔴 HIGH-2: expired/nonexistent cascade 必须 fresh fallback + 不能 restore 坏 entry

**问题**: 复用 entry 命中后 `SendUserCascadeMessage(oldCascadeId)` 如果上游返 `not_found.*(cascade|trajectory)` / `cascade.*not found` / `expired.*cascade`，旧代码直接 throw，handler catch 当成 `upstream_error` 502 返回 —— 用户看到错误，但 entry 还在 pool 里。下一轮请求又命中同一坏 entry，又失败，循环。

**改了什么** (`src/client.js` + `src/handlers/chat.js`):
- 新 `isExpiredCascade(e)` 正则匹配上游 expired/not_found 文案，跟 `isPanelMissing` 联合作为 SendUserCascadeMessage 的可恢复条件
- 恢复路径：`rebuildFullHistoryText()` → `warmupCascade(true)` → fresh `StartCascade` → `reuseEntry=null, stepOffset=0, generatorOffset=0` → retry send（沿用现有 panel-missing 重试机制）
- 恢复成功：`chunks.reuseEntryInvalidated = true`，handler 用 fresh cascadeId 入池 fpAfter（旧坏 entry 自动覆盖）
- 恢复失败 N 次后 throw 时 `err.reuseEntryInvalid = true`；handler 检测到这个标志后**全部 restore 路径跳过**（rate_limit / preflight / all-internal-error / temp_unavail / all-rate-limited / final cleanup —— 6 处）
- stream + non-stream 路径同等覆盖

**测试**: `test/client-panel-retry.test.js` 新增 fake LS 测试，模拟 `not_found: cascade trajectory has been expired by ttl`，断言：
- `sendCount=2`（recovery 后重发一次）
- `startCount=1`（fresh StartCascade 起了一次）
- `chunks.cascadeId = 'fresh-1'`（不是原 long-dead-cascade）
- `chunks.reuseEntryInvalidated = true`

### 🔴 HIGH-3: caller isolation 扩展到 /v1/chat/completions 和 /v1/responses

**问题**: 共享一个 API key 的两个用户（自建公益代理 / 团队 shared key 等），如果都不带 `body.user` / session header，callerKey 都是 `api:<sameHash>`，cascade pool 共享 —— 用户 A 的对话 state 可能命中给用户 B。

**改了什么** (`src/caller-key.js` + `src/server.js` + `src/handlers/chat.js`):
- 新 `extractBodyCallerSubKey(body)`: 提取 `body.user` / `body.conversation` / `body.previous_response_id` / `body.metadata.{conversation_id,session_id}` 算 16 字符 digest（`metadata.user_id` 仍归 `messages.js` 的专用解析处理，避免双 stamp）
- `callerKeyFromRequest(req, apiKey, body)`: 新增 body 参数，自动追加 `:user:<digest>`
- `server.js` 三个 entry（`/v1/chat/completions` / `/v1/responses` / `/v1/messages`）都已传 body
- 新 `hasPerUserScope(callerKey)`: 判断 callerKey 是否有 `:user:` 后缀或非 `api:` 前缀
- 新环境变量 `CASCADE_REUSE_ALLOW_SHARED_API_KEY=1`: 想保留旧宽松行为（单用户私部 / 内网）就开。**默认关** —— 没有 user 维度的共享 API key 自动 disable reuse，不再 silent share。

### 🟡 MED-1: tool schema digest 进 reuse key

已经在 HIGH-1 实现。emulateTools=true 时 `toolContextDigest = sha256(stableCanonical({tools, tool_choice, preambleTier, toolPreambleHash}))` 进 key。tool schema 改变（新增/删除/重命名 tool / 改 parameter 形状）→ hard miss，不会复用错误 cascade context。

### 🟡 MED-2: cache_control TTL policy 不无条件继承

**问题**: 旧 `checkin(fp, entry, callerKey, ttlHintMs=undefined)` 在 `ttlHintMs` 缺省时**保留** entry 上的旧 hint。一个请求带 1h cache marker → entry hint=3600000，下一个请求**没**带 → 旧 1h 继承，5m 用户拿到 1h pool entry。

**改了什么** (`src/conversation-pool.js`):
- `checkin(fp, entry, callerKey, ttlHintMs)`: `undefined` = 保留旧 hint（旧默认）；`0` 或 `null` = **明确清空** inherited hint，回归默认 30 分钟
- `chat.js` 在 fpAfter checkin 时统一传 `ttlHint === undefined ? 0 : ttlHint` —— 没 cache marker 就显式清，不再 silent inherit

### 🟡 MED-3: pool checkout 接收 expected owner 做原子校验

**问题**: 注释声称 checkout 验证 `(apiKey, lsPort)`，实现只验 callerKey/TTL —— 实际 owner 校验下沉到 handler 层（chat.js:1205-1209 等）。API 边界容易误用。

**改了什么** (`src/conversation-pool.js`):
- `checkout(fingerprint, callerKey, expected={apiKey, lsPort, lsGeneration})`: 第三参数可选 `expected`，匹配失败统一 `stats.misses++` 返 null
- handler 端口 mismatch 分支保留作为 defense-in-depth；新 API 给将来 strict 模式用

### 🟢 LOW-1: dashboard restart LS 同步清 conversation pool + LS generation

**问题**: `stopLanguageServer()` 只 kill 进程 + 清 LS pool，conversation pool 依赖 LS exit handler 异步 invalidate。dashboard restart 流程在 stop → 异步 invalidate → start 期间，pool 里仍可能有旧 entry。如果新 LS 复用同 port，handler 端口校验**分不清**新 LS 和旧 LS 是不是同一个。

**改了什么** (`src/langserver.js`):
- 每个 LS entry 新增 `generation: randomUUID()` 字段
- `stopLanguageServer()`: 同步收集 `[{port, generation}]`，kill 后立即 `closeSessionForPort` + `invalidateFor({lsPort, lsGeneration})`
- `restartLsForProxy()`: 同步 invalidate 旧 generation 后才 spawn 新 LS
- LS exit handler 也带上 generation 一起 invalidate
- `invalidateFor({lsPort, lsGeneration})`: 同时给 generation 时只删除**同 generation** 的 entry —— 让新 LS 在同 port 上的 entry 不被旧 LS 的 invalidate 误杀
- `chunks.lsGeneration` 一路从 client.js 透到 chat.js fpAfter checkin

### 🟢 LOW-2: 记录 history coverage / truncation

**问题**: fresh cascade 历史按 budget 截断（默认 200KB / 1m 模型 900KB），但 pool entry checkin 时只记 `messages` 完整轨迹的 fpAfter，**声称代表完整 state，实际只代表预算内 suffix**。

**改了什么** (`src/client.js` + `src/handlers/chat.js`):
- `cascadeChat()` 在 history 构建循环里追踪 `firstIncludedTurnIndex`，结束时返回 `chunks.historyCoverage = {droppedTurnCount, firstIncludedTurnIndex, totalTurns}`
- `chat.js` poolCheckin 时把 `historyCoverage` 写进 entry —— 给将来"caller history 前缀变了但不在 upstream coverage 内→fresh"的判断用

---

### 测试覆盖

`node --test test/*.test.js` → **311/311 passing**（v2.0.24 是 295/295 → 净增 16 个新测试）

新增/扩展：
- `test/conversation-pool.test.js`: +12 tests — assistant text 变化 / tool_calls 变化 / system 变化 / image_url 变化 / unhashable media disable / tool schema 变化 / object key order 稳定 / fpAfter↔fpBefore 跨轮 round-trip / expected owner 校验 / generation-aware invalidate / TTL hint 显式清
- `test/client-panel-retry.test.js`: +1 test — HIGH-2 fake LS 模拟 expired cascade，断言 fresh fallback + reuseEntryInvalidated flag
- `test/caller-key.test.js`: 新文件 +14 tests — body subkey 提取 / 多用户隔离 / metadata.user_id 不被 caller-key.js 抢解析 / hasCallerScope 判断

### 兼容性

- 升级路径：`docker compose pull && docker compose up -d`
- **HIT RATE 下降警告**: 之前依赖 reuse 命中的 Claude Code / opencode 用户首次升级会感觉到 cascade 命中率掉一档（现在 system / assistant / tool 变化都会 miss）。这是设计内 trade-off — 命中率换正确性。可以通过 `CASCADE_REUSE_HASH_SYSTEM=0` 部分回退（仅放过 system 变化），但 assistant / tool 不可回退（那是错误源头）。
- **共享 API key 用户警告**: 默认禁了 reuse（HIGH-3）。如果你是单用户私部 / 内网 deploy，加 env: `CASCADE_REUSE_ALLOW_SHARED_API_KEY=1` 恢复。如果你是公共代理 / 多用户 shared key，**请保持默认**，让客户端带 `body.user` 或 `body.metadata.session_id`。
- 后端 API 不变，OpenAI/Anthropic protocol 全兼容
- Zero npm dependencies

### Files changed

```
src/conversation-pool.js   | rewrite (semantic key + atomic checkout + generation-aware invalidate + TTL policy)
src/caller-key.js          | extend (body subkey + hasCallerScope helper)
src/client.js              | extend (isExpiredCascade + recovery + lsGeneration + historyCoverage)
src/langserver.js          | extend (generation UUID + sync invalidate on stop/restart)
src/server.js              | call sites (pass body to callerKeyFromRequest)
src/handlers/chat.js       | call sites (fpOpts, appendAssistantTurn, reuseEntryDead gate, hasPerUserScope gate)
src/handlers/messages.js   | mark __route='messages'
src/handlers/responses.js  | mark __route='responses'
test/conversation-pool.test.js | +12 tests
test/client-panel-retry.test.js | +1 test (HIGH-2 fake LS)
test/caller-key.test.js    | new file +14 tests
package.json               | 2.0.24 → 2.0.25
```
