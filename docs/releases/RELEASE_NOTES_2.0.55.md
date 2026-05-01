## v2.0.55 — 安全审计收尾（5 条整改一波过）

接手审计完 v2.0.54 后跑了一轮 codex 高 reasoning + 端到端 PoC，挖出 3 HIGH + 1 MED + 1 LOW 共 5 条，一起修。这一版**部署有破坏性变化**，operator 升级前请把下面"部署前要做的事"读完再 `docker compose up -d --force-recreate`。

### HIGH（攻击链：chat-API caller → service operator → 内网 SSRF）

#### H1 — Dashboard 不再用 `API_KEY` 当回退密码（公网 bind）

**`src/dashboard/api.js` `checkAuth()`**

旧逻辑：`DASHBOARD_PASSWORD` 没设时退化用 `config.apiKey` 当 dashboard 密码。这意味着任何拿到 chat API key 的客户端能用同一个 key 调 `/dashboard/api/*`：list accounts、reveal-key 拿到上游 raw apiKey、改 proxy、触发 docker self-update、触发 LS binary update。是 **chat caller → service operator 的提权**。

新逻辑：

| bind / 配置 | 旧行为 | 新行为 |
| --- | --- | --- |
| 公网 + `DASHBOARD_PASSWORD` 已设 | 验密码 | 验密码 ✓ |
| 公网 + 仅 `API_KEY` 设 | API_KEY 当密码 ⚠️ 提权 | **fail closed 401** |
| 公网 + 都没设 | 凭 `isLocalBindHost()` 判断（false）→ 401 | 401 |
| localhost + 仅 `API_KEY` 设 | API_KEY 当密码 | API_KEY 当密码 ✓ |
| localhost + 都没设 | 开放 | 开放 ✓ |

启动期 `emitNoAuthWarnings` 现在也独立警告 `DASHBOARD_PASSWORD` 未配（之前 OR `API_KEY` 算"有"）。

#### H2 — `X-Forwarded-For` 默认不再用于 callerKey 指纹

**`src/caller-key.js` `ipUaFingerprint()` + `callerKeyFromRequest()` apiKey-less 分支**

旧逻辑：`req.headers['x-forwarded-for'].split(',')[0]` 拿"客户端 IP"参与 callerKey 计算。但 XFF 是攻击者可控 header — 多用户共享 apiKey 场景下，攻击者发 `X-Forwarded-For: <victim's IP>` + 同 UA 即可落进受害者的 cascade pool 桶。

新逻辑：

- 默认 `socket.remoteAddress` 当 IP，不再读 XFF
- 加 `TRUST_PROXY_X_FORWARDED_FOR=1` env 开关，operator 显式开启时才取 XFF 首位（用于 nginx LB 后面部署）
- 注意：开启 trust 后还是有 spoof 风险（attacker 发 spoofed XFF，nginx append 自己看到的 IP 到末尾）。**真正想杜绝的话 nginx 那边加 `set_real_ip_from <docker subnet>; real_ip_header X-Forwarded-For;` 让 nginx 自己 strip 外部 XFF**。

#### H3 — Dashboard 设 proxy 的两条路由现在也走 `assertPublicUrlHost` 私网拦截

**`src/dashboard/api.js` `PUT /proxy/global` + `PUT /proxy/accounts/:id`**

旧逻辑：add-account 路径走了 `assertPublicUrlHost()` 拦 `127.0.0.1` / `169.254.169.254` / RFC1918，但**直接 PUT 设 proxy** 的两条路由没走这一道。链 H1 之后，攻击者拿 chat key → dashboard admin → 把 global 或 per-account proxy 配成 `169.254.169.254:80` → LS 出口流量打 cloud metadata。

新逻辑：两条 PUT 路由现在都先 `assertPublicUrlHost(body.host)` 校验，失败返 `400 ERR_PROXY_PRIVATE_HOST`。`ALLOW_PRIVATE_PROXY_HOSTS=1` 是 operator 的 escape hatch（v2.0.18 引入，保留）。空 body / 无 host 是"清空 proxy"语义，不验。

### MED

#### M2 — Tool-call salvage 不再让 prompt-injection 注入未声明的工具名

**`src/handlers/chat.js`** 新增 `filterToolCallsByAllowlist()` + 改两处 emit 路径

salvage parser 接受任意 `{"name":"X","arguments":{...}}` JSON 当 tool_call。如果 user content 里有 prompt injection 让模型 emit `<tool_call>{"name":"Bash","arguments":{"command":"id"}}</tool_call>`（即使 client 只声明了 `get_weather`），salvage 之前会原样推上去。客户端如 Claude Code 看到 `Bash` 工具会真去执行。

修法：在 stream + non-stream 两条 emit 路径都过一道 allowlist — 只放行名字在 `body.tools[].function.name` 里的 tool_call。`tools[]` 为空 → 全屏蔽（caller 没声明就别想任何 tool_call 出来）。被屏蔽的会在 server log 留 `ToolGuard:` 警告便于排查 prompt injection 尝试。

### LOW

#### L1 — `safeEqualString` 不再因长度差异提前 return（length oracle 修复）

**`src/auth.js`**

旧实现：`if (left.length !== right.length) return false; return timingSafeEqual(left, right)`。50k 次本地比较实测 same-length 8.0ms / different-length 4.9ms — 是个 timing oracle 能让攻击者推断 secret 长度。

新实现：先 sha256 双方到 32 字节再 timingSafeEqual + 单独长度比较。SHA-256 永远 32 字节所以 timingSafeEqual 始终走相同路径。

### 测试

- 558 → **558**（5 个新 test file 25 个 case 全过）
- 新增：`auth-safe-equal-hash`、`caller-key-xff-spoof`、`dashboard-auth-fail-closed`、`dashboard-proxy-validate`、`tool-emulation-allowlist`

### 部署前要做的事（**重要**）

VPS 升 v2.0.55 前必须先在 `.env` 加两条 env 然后 `docker compose up -d --force-recreate`（`docker restart` 不会重读 env_file，env 是容器创建时注入）：

```bash
# 必须：dashboard 现在不再用 API_KEY 回退当密码，公网 bind 不设这个 dashboard 直接 401
DASHBOARD_PASSWORD=<选个跟 API_KEY 不同的强密码>

# 看部署形态决定：
#   有 nginx LB 在前面（默认 docker-compose 部署是这种）→ 设为 1
#   裸跑 windsurf-api 容器没 nginx 在前 → 不设 / 设为 0
TRUST_PROXY_X_FORWARDED_FOR=1
```

升级命令：

```bash
docker compose pull && docker compose up -d --force-recreate
```

升完之后做一遍 PoC 复跳验证三条 HIGH 都闭：

```bash
# H1: 用 API_KEY 调 dashboard config 应该 401
curl -i -H "X-Dashboard-Password: $API_KEY" $HOST:3888/dashboard/api/config | head -1
# 期望: HTTP/1.1 401

# H2: spoof XFF 应该不再撞同 callerKey（看 health verbose 的 conversationPool stats 不串就行）
# 由 server-side 验证，客户端复跳不直观

# H3: 用 dashboard password 把 proxy 设到 127.0.0.1 应该 400
curl -i -X PUT -H "X-Dashboard-Password: $DASHBOARD_PASSWORD" -H "Content-Type: application/json" \
  -d '{"type":"http","host":"127.0.0.1","port":8080}' \
  $HOST:3888/dashboard/api/proxy/global | head -3
# 期望: HTTP/1.1 400 + body 含 PROXY_PRIVATE
```

### 致谢

本版在审计阶段使用 codex 高 reasoning 模式跑全项目读 + 起 PoC 实测，感谢这个工作流。
