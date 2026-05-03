## v2.0.84 — #118 0a00 rate-limit fallback hint

0a00 #118 vps log 抓到根因 — 31 个 trial 账号 quota 100% 但全部在 `claude-opus-4-7-max` 上撞到 26-29 分钟的 per-(account, model) 滑窗 rate limit。Windsurf 上游对 `-max` / `-xhigh` 这类高 reasoning effort 变体单独限频，跟 daily/weekly quota 是两个独立维度。proxy 现有逻辑正确返 429，但用户没看出能换什么。

这版加 effort-fallback hint 字段。

### 改

`pickRateLimitFallback(modelKey)` — 从模型名 suffix 推同 base 低一档：

```
claude-opus-4-7-max    → claude-opus-4-7-xhigh
claude-opus-4-7-xhigh  → claude-opus-4-7-high
claude-opus-4-7-high   → claude-opus-4-7-medium
claude-opus-4-7-medium → claude-opus-4-7-low
claude-sonnet-4.6-1m   → claude-sonnet-4.6
claude-sonnet-4.6-thinking → null（thinking variant 行为不同，不擅自降级）
```

ladder：`low → medium → high → xhigh → max`，1m → bare。`-thinking` 变体跳过（dropping thinking content 改了 user-visible 行为）。

429 返时加：

```json
{
  "error": {
    "message": "claude-opus-4-7-max 账号队列超时: 所有可用账号均已达速率限制",
    "type": "rate_limit_exceeded",
    "fallback_model": "claude-opus-4-7-xhigh",
    "remediation": "池里所有账号在 claude-opus-4-7-max 上都已限流。这个 effort 变体上游限频严（每账号几十分钟滑窗），建议改用 claude-opus-4-7-xhigh（同基础模型，effort 等级更低，daily quota 更宽松）。"
  }
}
```

non-stream + stream 两路都加。客户端 / 用户看到 429 直接知道改哪个 model。

### 没做（留下次）

env opt-in `WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT=1` 真自动 retry fallback model — 这版只给 hint 不擅自降级。客户端期望 max reasoning 但 silent 拿到 medium 是质量降级，留 v2.0.85+ 默认 OFF env opt-in 做。

### 改动

- `src/models.js` — 新加 `pickRateLimitFallback(modelKey)`
- `src/handlers/chat.js` — non-stream + stream 429/503 错误响应加 `fallback_model` + `remediation`
- `test/v2084-rate-limit-remediation.test.js` — 新（11 case）

### 数字

- 测试 860 → **871**（+11）
- 全测 0 fail / 0 回归

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```

### 给 0a00 的实操

升级后再撞 `claude-opus-4-7-max` 限流，client 错误响应里会有 `fallback_model: "claude-opus-4-7-xhigh"`。也可以直接把客户端 default model 改成 `claude-sonnet-4.6` / `claude-haiku-4.5` 一劳永逸 — 这两个是 daily quota 宽松的 baseline，31 号轮转完全够用。
