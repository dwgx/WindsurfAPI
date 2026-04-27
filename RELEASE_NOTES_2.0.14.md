## v2.0.14 — 修复 issue #77：30 秒空错误，让账号池超时显示真实原因

zhangzhang-bit 在 #77 报告升 v2.0.13 后 Cherry Studio "直接不通一直转圈"，日志显示 `Stream error after retries:` 后面**消息体是空的**，且 30 秒间隔。根因不是 v2.0.13 引入，而是一直存在的诊断盲区：当 `waitForAccount()` 30 秒内拿不到任何可用账号、返回 null 时，stream 和 non-stream 两条主路径都直接 `break` 而**没给 `lastErr` 赋值**。最终 log 行 `lastErr?.message` 求值成 undefined，operator 看到的就是一条空错误，客户端看到的就是 30 秒静默失败 —— 完全没法自诊断到底是 rate limit、模型无权限、还是上游卡住。

Issue #77 reporter zhangzhang-bit hit a "30s silent stall, then empty error" surface from Cherry Studio after upgrading to v2.0.13. The root cause has been latent since long before v2.0.13: when `waitForAccount()` returns null after the 30s `QUEUE_MAX_WAIT_MS` (every eligible account rate-limited / lacking model entitlement / temporarily unavailable), both the stream and non-stream retry loops `break` without ever assigning `lastErr`. The retries-failed log then prints `lastErr?.message` as undefined, surfacing as an empty error to operators and a silent failure to clients — making it impossible for users to self-diagnose whether they're rate-limited, missing entitlements, or hitting upstream stalls.

### 改了什么 / What changed

- **`src/handlers/chat.js` stream queue-timeout 分支**（line ~1710）：`waitForAccountFn` 返回 null 时给 `lastErr` 赋一个真实 Error，message 体根据 `isAllTemporarilyUnavailable(modelKey)` 和 `isAllRateLimited(modelKey)` 分类，告诉用户具体原因（"所有可用账号暂时不可用 / 速率限制 / 30 秒内没账号变可用 — 可能被速率限制或对当前模型无权限"）。
- **`src/handlers/chat.js` non-stream queue-timeout 分支**（line ~1126）：同样的诊断式 lastErr 注入，但用 `{ status, body }` shape 而不是 Error 对象，因为 non-stream 路径里 lastErr 是 result object。
- **`src/handlers/chat.js` 最终 log fallback**：`log.error('Stream error after retries:', lastErr?.message || String(lastErr || 'account queue timed out without an error object'))` —— 即使未来又有人加新分支漏赋 lastErr，operator log 也不会再退化成空字符串。
- **`test/stream-pool-exhausted-error.test.js`** — 三条静态结构断言守住未来回归：
  1. stream 路径 queue-timeout 分支必须给 lastErr 赋值且调用 `isAllTemporarilyUnavailable / isAllRateLimited` 分类；
  2. non-stream 路径同样要求；
  3. 最终 log 行必须有 `||` fallback。

### Audit 用了什么

`/codex-subagent` 高 reasoning effort 拿全 zhangzhang-bit 的日志做独立诊断，准确锁定 (d) 是高概率根因（waitForAccount 返回 null + break 时 lastErr 未赋值 + 最终 log 求值 undefined），并给出最小 diff。同时它把 stream retry loop 又审计了一遍 v2.0.13 后是否还有其他 ReferenceError / missing await / 不可达分支 — 全部 clean。

```
Phase 1 — Root Cause Hypothesis
Top hypothesis: account queue timeout leaves lastErr === null. ...
exactly matches 30s silence, zero Cascade logs, and empty body.

Phase 4 — Sanity Audit
Clean: no undeclared variable or missing function call found in the
stream retry loop. No obvious missing await in the inspected stream
path. Only obvious v2.0.13-adjacent bug here is the null-lastErr
queue-timeout path, not cachePolicy.
```

### 注意：这只修了"诊断盲区"

zhangzhang-bit 的具体 deployment 之所以"30s 拿不到账号"，根本原因还是他的账号池里没有对 `claude-opus-4-6` 有 entitlement 的账号（free 账号都不能用 opus 4-6，pro 账号才能），或者所有账号都被 rate limited。这是部署配置问题，不是代码问题。**v2.0.14 的作用是让用户看到这个原因，不再卡 30 秒空错误**。

升级后如果还是 30 秒超时但消息变成"所有可用账号均已达速率限制 / 对当前模型无权限"，那就去 Dashboard 看具体是哪个原因 —— 加 pro 账号、等限流过期，或者改用上游有权限的模型。

### Compatibility

- 升级路径无操作。`docker compose pull && docker compose up -d`。
- 行为变化：原本 30 秒空错误现在变成 30 秒后**带原因**的明确错误。客户端如果是因为这个空错误自动 retry，可能会因为新的 4xx 状态码（429 rate_limit_exceeded / 503 pool_exhausted）改变 retry 策略 —— 这是预期的（不再无限循环 retry 一个永远拿不到账号的请求）。
- 243/243 tests pass（v2.0.13 的 240 + 3 条新回归测试）。
- Zero npm dependencies, unchanged.

- No upgrade actions. `docker compose pull && docker compose up -d` is sufficient.
- Behaviour change: the previous 30s empty error now surfaces a 30s error with a real reason. Clients that auto-retried the empty error may change retry behaviour because the new response is properly classified as 429 rate_limit_exceeded or 503 pool_exhausted — this is the desired outcome (no infinite retry against an empty pool).
- 243/243 tests pass (v2.0.13's 240 + 3 new regression tests).
- Zero npm dependencies, unchanged.
