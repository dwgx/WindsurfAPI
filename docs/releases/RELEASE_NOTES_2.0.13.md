## v2.0.13 — 紧急修复 v2.0.12 prompt caching 引入的 ReferenceError (issues #82, #83)

v2.0.12 加 Anthropic prompt caching `cache_control` 兼容时，`cachePolicy` 变量在 `handleChatCompletions()` 顶层声明但**没有传给 `streamResponse()` 和 `nonStreamResponse()`**这两个独立 helper 函数 —— 后者在内部继续引用 `cachePolicy`，闭包不到导致 `ReferenceError: cachePolicy is not defined`，stream 和 non-stream 两条主路径都会在响应中段崩溃。

Cherry Studio / 任何走 `/v1/chat/completions` 的客户端从 v2.0.12 起就会收到 `Stream error after retries: cachePolicy is not defined`，partial 响应已经送出去后再失败。**所有 v2.0.12 用户都中招**，建议立刻升 v2.0.13。

Hotfix for an undefined-variable regression introduced in v2.0.12 when the Anthropic prompt-caching `cache_control` parser landed. The `cachePolicy` value declared at the top of `handleChatCompletions()` was never threaded into the two top-level helpers (`streamResponse()` and `nonStreamResponse()`), so every reference inside those helpers raised `ReferenceError: cachePolicy is not defined` — affecting both stream and non-stream main paths. Cherry Studio and any other `/v1/chat/completions` client surfaced this as `Stream error after retries: cachePolicy is not defined` after a partial response had already been sent. **All v2.0.12 deployments hit it**; upgrading to v2.0.13 is required.

### 改了什么 / What changed

- **`src/handlers/chat.js` — `streamResponse()` 加 `deps.cachePolicy` 接入**：函数顶部新增 `const cachePolicy = deps.cachePolicy || null;`，`handleChatCompletions()` 在 stream 调用点把 `cachePolicy` 通过 `deps` 传过去。修了 stream 路径 line 1788/1818/1888 三处 ReferenceError（pool checkin TTL hint、usage attribution、retry-fallback restore）。
- **`src/handlers/chat.js` — `nonStreamResponse()` 加独立 `cachePolicy` 参数**：函数签名追加 `cachePolicy = null` 默认参数，`handleChatCompletions()` 调用时作为最后一个 positional 参数传入。这个版本不依赖 `poolCtx`，所以 non-reuse 路径下客户端发的 `cache_control: { ttl: '1h' }` 也能正确归到 `ephemeral_1h_input_tokens` 而不是被误归 5m。
- **新增 `test/stream-cache-policy.test.js`** — 三条静态结构断言守住未来回归：
  1. `streamResponse` 函数体内第一次出现 `cachePolicy` 必须是 `const cachePolicy = deps.cachePolicy` 这条声明；
  2. `handleChatCompletions` 调用 `streamResponse` 时必须把 `cachePolicy` 通过 deps 传过去；
  3. `nonStreamResponse` 必须接受 `cachePolicy` 作为显式参数，且调用方必须传它。

任何未来 PR 误删声明或调用 helper 不传 `cachePolicy` 都会被这三条断言在 `npm test` 阶段卡住。

### Audit / 审计

这次发现额外一处同类型 bug 是用 `/codex-subagent` 高 reasoning effort 独立扫的：codex 直接定位到 `nonStreamResponse()` line 1390 也有相同问题（一开始我只看了 stream 路径），并且把 `extractCachePolicy / ttlHintFromCachePolicy / buildUsageBody` 的 reachability 全部 audit 一遍，确认其他 helper 都正常 import 到位、没漏。

The second hit (`nonStreamResponse()`) was caught by an independent codex audit at high reasoning effort — I had only patched the stream path on first read. Codex also re-checked reachability of every prompt-caching helper (`extractCachePolicy`, `ttlHintFromCachePolicy`, `buildUsageBody`) across all call sites and confirmed no further landmines.

### Compatibility

- 升级路径无操作。`docker compose pull && docker compose up -d`。
- 行为完全没变（v2.0.12 本来设计的 prompt caching 兼容路径终于真正能跑）。
- 240/240 tests pass（在 v2.0.12 的 237 之上加了 3 条新回归测试）。
- Zero npm dependencies, unchanged.

- No upgrade actions. `docker compose pull && docker compose up -d` is sufficient.
- Behaviour matches what v2.0.12 was supposed to do — the prompt-caching code path now actually runs without crashing.
- 240/240 tests pass (3 new regression tests on top of v2.0.12's 237).
- Zero npm dependencies, unchanged.
