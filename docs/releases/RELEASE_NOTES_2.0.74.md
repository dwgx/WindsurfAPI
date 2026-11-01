## v2.0.74 — 真修两条没人解决的超时 + reuse miss

### #122 zhangzhang-bit · 25s 把 30s 才到的成功请求砍掉重试

报上来一直没人接。v2.0.70 跑 Cascade 工具拉代码 / 下载，**30 秒左右就成功了 但是 25 秒被截断重复**。根因：[client.js:176](../../src/client.js) 的 `warmStallMs=25_000` 是给纯文本短回复调的阈值，工具执行（curl / git clone / view 大文件）走的是另一种节奏 — trajectory step 卡在执行态 60-150s 不动是常态。

修法分三档 ceiling，大档赢：

| 状态 | ceiling | env override |
|---|---|---|
| 工具调用执行中（toolCallCount > 0） | **180s** | `CASCADE_WARM_STALL_TOOL_ACTIVE_MS` |
| 思考中（thinking emit 过） | 120s（不变） | `CASCADE_WARM_STALL_THINKING_MS` |
| 短文本（neither） | **45s**（原 25s） | `CASCADE_WARM_STALL_MS` |

工具档优先 — sonnet-thinking + 工具调用同时触发时走 180s，因为模型决定调工具后 LS 在执行，trajectory 静默不是 stall。

error message 不再硬编码 25s，跟着实际 ceiling 报 `no progress for 45s` / `no progress for 180s` 让 operator 知道是哪一档。

### #116 zhangzhang-bit · system prompt hash 飘 reuse 永远 miss

log 看着 system 长度都是 26892 一致，但 hash 每轮变。zhangzhang-bit 报"分析完的数据 还是会重新再分析 再总结 一直循环" — `Chat[u25weq]: reuse fp=... MISS turns=19` 反复，cascade pool 永远捞不到老对话。

根因：v2.0.61 的 `normalizeSystemPromptForHash` 覆盖了 cwd / today / UUID / sessionid / ts，但 Claude Code 长 system prompt 末尾的 **`gitStatus:` 块**（Recent commits / Status / Recent files）每次会因 commit / 文件改动而内容变 — git short hash 7 字节 hex 长度固定但内容飘，整段 hash 飘但 len 不变。

加 4 类 normalize：

```
Status: <body 各种 git 状态行>     →  Status:\n<git-status>
Recent commits: <body abc1234 ...>  →  Recent commits:\n<recent-commits>
Recent files: <body files...>       →  Recent files:\n<recent-files>
inline 7-12 hex 含数字含字母         →  <gitsha>
1700000000-2099999999 范围 epoch    →  <epoch>
```

讲究处：
- 纯数字 `1234567890` 不会被当 git hash 抠走（要求至少一位 a-f 字母）
- 纯字母 `deadbeef` 不会被当 git hash 抠走（要求至少一位数字）
- 不在 `<epoch>` 范围的 10 位数字（电话号码等）保留，不当时间戳吃
- 真 prose 改动（`You are Claude Code` → `You are Codex CLI`）仍 diff hash，不会跨 prompt 复用串味

`gitStatus` 文档说"snapshot won't update during the conversation"但实测每次新 conversation 都重 snap，只要 commit 一次或者新文件就变。

### 改动

- `src/client.js` — 三档 ceiling + 抽 `pickWarmStallCeiling` 让测试可覆盖 + error message 跟实际阈值
- `src/conversation-pool.js` — `normalizeSystemPromptForHash` 加 4 类 normalize
- `test/v2074-issue-fixes.test.js` — 新（13 case）

### 数字

- 测试：792 → **805**（+13）
- 全测 0 fail / 0 回归

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```

### env 选项

- `CASCADE_WARM_STALL_MS=45000` — 短文本 ceiling（默认 45s，原 25s）
- `CASCADE_WARM_STALL_THINKING_MS=120000` — thinking 模式 ceiling
- `CASCADE_WARM_STALL_TOOL_ACTIVE_MS=180000` — 工具调用执行 ceiling
- `CASCADE_MAX_WAIT_MS=600000` — 全局上限不变

### 关 / 不关

- **#122** 留开，等 zhangzhang-bit 升级实测
- **#116** 留开，等 zhangzhang-bit 升级看新 reuse log 是不是 HIT
- #57 顺便回一下，thinking 那条已经 v2.0.69 上 120s，没动
