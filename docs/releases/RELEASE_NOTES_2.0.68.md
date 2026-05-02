## v2.0.68 — issue triage 三连：#117 alias / #118 usage 计算 / #119 sticky-IP LS 隔离

一波 issue 实修，三件事都从生产 log 看到具体证据后动手。

### #117 — `claude-haiku-4-5-20251001` 等 Anthropic dated 名 alias 缺失

xiaoxin-zk 在 dashboard 测试 `claude-haiku-4-5-20251001` 报 400 `Unsupported model` —— Anthropic 官方的 dated id 没在 alias 表里。catalog 已经有 `claude-4.5-haiku`（短名），只缺 dated → 短名映射。同步补：

- `claude-haiku-4-5-20251001` / `claude-haiku-4-5` / `claude-haiku-4-5-latest` → `claude-4.5-haiku`
- `claude-sonnet-4-5-latest` / `claude-opus-4-5-latest` → 各自短名
- `claude-3-5-haiku-20241022` / `claude-3-5-haiku-latest` / `claude-haiku-3-5` 等 legacy haiku 名 → `claude-4.5-haiku`（catalog 没 3.5-haiku 实体，往 live 4.5 走比 400 强）

`claude-sonnet-4-5-20250929` 之前已有 alias，那条不动。

### #118 — `prompt_tokens` 把 `cache_write` 也算进去导致下游中转计费爆

wnfilm 报 10 个 trial 账号几小时就接近限流，dashboard 数字里 `cache_read` + `cache_write` 比 `fresh_input` 大一两个数量级。看 chat.js:1012 老实现：

```js
const promptTotal = inputTokens + cacheRead + cacheWrite;  // 错
prompt_tokens: promptTotal
```

OpenAI 标准里 `prompt_tokens` 是模型这一轮看到的全部 input，`prompt_tokens_details.cached_tokens` 是其中已缓存的 subset；**不应该**把 cache_write（generation 副产物）算到 input 里。下游中转（one-api / new-api / sub2api 等）按 `prompt_tokens` 统计，cache_write 被错当成普通 input token 计费 → trial 额度看上去秒爆。

修法：

```js
prompt_tokens = freshInput + cacheRead              // OpenAI 标准
prompt_tokens_details.cached_tokens = cacheRead     // 命中 cache 的 subset
cache_creation_input_tokens = cacheWrite            // Anthropic 扩展独立字段
total_tokens = freshInput + cacheRead + cacheWrite + outputTokens  // 仍然 grand total，per-account billing tally 不变
```

**Anthropic 那边**（`/v1/messages`）`input_tokens` 语义跟 OpenAI **相反** —— Anthropic 的 input_tokens 仅指 fresh input（不含 cache），cache_read / cache_creation 单列。`messages.js` 的 `buildAnthropicUsage` 跟着调：从 OpenAI prompt_tokens 减去 cached_tokens 得 freshInput，再写入 Anthropic `input_tokens`。

新增 `cascade_breakdown` 字段（dashboard / billing 关心原始 4 个 bucket 的可以直接读）：

```json
{
  "cascade_breakdown": {
    "fresh_input_tokens": 415,
    "cache_read_tokens": 11217,
    "cache_write_tokens": 683,
    "output_tokens": 251
  }
}
```

### #119 — sticky-IP 动态代理：5+ 账号触发上游 30 分钟限流即使 IP 不同

CharwinYAO 用动态粘性 IP 服务（`http://username_sid_xxx:password@us.ipwo.net:port`），每个账号 sticky session id 不同所以**egress IP 不同**，但 `proxyKey` 函数只用 `host:port` 做 LS instance 索引 → 所有 sticky session 共享同一 LS 进程 / 同一 sessionId / 同一 Windsurf 客户端 fingerprint。上游识别这一层共享，5+ 并发就 trip 30 分钟限流。

修法：env 开关 `WINDSURFAPI_LS_PER_PROXY_USER=1` —— 启用后 `proxyKey` 把 username 的可打印部分（cap 32 字符）拼进 key，每个 sticky session 独立 LS 进程 + 独立 sessionId。代价是内存占用线性涨（每 sticky user 一个 LS = ~80MB），所以默认 OFF；动态代理用户开它能换上游限流空间。

```bash
# .env
WINDSURFAPI_LS_PER_PROXY_USER=1
```

### 数字

- 测试：719 → **734**（+15 新 case：#117 alias 6 个 / #118 usage 7 个 / #119 sticky-IP env knob 2 个）
- 全测 0 fail
- 改动：`src/models.js` alias / `src/handlers/chat.js` buildUsageBody / `src/handlers/messages.js` buildAnthropicUsage / `src/langserver.js` proxyKey + 新测试文件

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```

启用 sticky-IP 模式（仅动态代理用户需要）：在 `.env` 或 docker-compose 里加 `WINDSURFAPI_LS_PER_PROXY_USER=1`。

### 没修的

- **#116** zhangzhang-bit 循环分析问题：log 看 `reuse=false`，cascade reuse 没命中导致每轮全量 replay 19 turns × 26KB system prompt + 113 个 tool。还需要 zhangzhang-bit 提供：客户端类型 / 是否每轮都 reuse=false / 完整一个 turn cycle 的 log。这版没修。
- **#114** CharwinYAO 邮箱密码登录：v2.0.61 修过，最新 log 看 `PostAuth OK (new)` 路径走通了。这版只是发个确认询问。
