## v2.0.56 — 安全收尾 + 后台改密码 + 封号检测 + brute-force 锁定

接手仓库后做了一波研究 + 系统升级。研究材料：[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（登录验证逻辑） / [WindsurfSwitch](https://github.com/crispvibe/WindsurfSwitch) / [windsurf-assistant](https://github.com/zhouyoukang/windsurf-assistant) / [windsurf-assistant-pub](https://github.com/yuxinle1996/windsurf-assistant-pub)。

这一版整合 v2.0.55 的 5 条审计 fix + 5 条新功能。**部署有破坏性变更**，operator 升级前请把"部署前要做的事"读完。

### v2.0.55 安全审计（5 条 fix）

| # | 严重度 | 摘要 |
| --- | --- | --- |
| H1 | HIGH | Dashboard 不再用 `API_KEY` 当回退密码（公网 bind） |
| H2 | HIGH | `X-Forwarded-For` 默认不再用于 callerKey 指纹 |
| H3 | HIGH | Dashboard 设 proxy 的两条路由现在也走 `assertPublicUrlHost` 私网拦截 |
| M2 | MED | Tool-call salvage 加 `body.tools[]` 名字白名单 |
| L1 | LOW | `safeEqualString` 改成 sha256 + timingSafeEqual，不再因长度差早 return 泄露 length oracle |

详见上一版打算 ship 的 v2.0.55 部分。

### v2.0.56 新功能

#### 1. 后台改密码（runtime-rotatable credentials）

**`src/runtime-config.js`** + **`src/dashboard/api.js` 新路由 `/settings/credentials`** + 双皮 UI 表单

参考 CLIProxyAPI 的 management API 思路：把 `API_KEY` 和 `DASHBOARD_PASSWORD` 做成可在 dashboard 里直接改的字段，写到 `runtime-config.json`，**不需要重启容器**也不需要改 `.env`。

- `GET /dashboard/api/settings/credentials` — 返回 `{apiKey_masked, apiKeySource, dashboardPasswordSet, dashboardPasswordSource}`
- `PUT /dashboard/api/settings/credentials` — body `{apiKey?, dashboardPassword?}`，要求 ≥ 8 字符；空字符串清除运行时覆盖让 `.env` 值再生效
- Dashboard UI 默认皮 + sketch 皮的"实验性功能"面板下方都加了"凭证管理"卡片，含 show/hide + 二次确认 + 改完自动登出
- **Dashboard 密码用 scrypt** 派生哈希存盘（`scrypt$N$r$p$salt$hash` 格式，零依赖，node:crypto 自带），`API_KEY` 仍存明文（chat 客户端发原值，需要 timing-safe 比对）
- `validateApiKey()` 通过 hook 拿运行时值，env 兜底；`checkAuth()` 同理

#### 2. Brute-force 登录锁定（CLIProxyAPI 风格）

**`src/auth.js` 新增 `checkLockout` / `failedAuthAttempt` / `successfulAuthAttempt`**

- 同一 IP 连续 5 次 dashboard 登录失败 → ban 30 分钟，第 6 次返 `429` + `Retry-After`
- 计数 keyed by `socket.remoteAddress`（或 `TRUST_PROXY_X_FORWARDED_FOR=1` 时的 XFF 首位，跟 caller-key.js 行为一致）
- 后台 idle 2h 自动清理，每 1h 扫一次（`.unref()` 不阻进程）
- 成功登录立即清零

#### 3. 封号检测（windsurf-assistant-pub 启发）

**`src/auth.js` 新增 `looksLikeBanSignal` / `reportBanSignal` / `clearBanSignals`**

windsurf 上游偶尔会返回"Account suspended" / "API key revoked" / "subscription cancelled" / 中文版"账号已停用"等。之前我们只把这种识别成普通 model error 在 errorCount 累计，3 次才禁，期间继续扔流量到死 key。

新逻辑：14 个 patterns 识别 ban-shaped 错误（中英都覆盖），同一账号 30 分钟窗口内 2 次 → 直接 `status='banned'` + 失效 cascade pool entries + 持久化。任何一次成功 chat 清零 streak，避免 windsurf 偶发抖动误伤。

stream + non-stream 两条错误路径都接入。

#### 4. v2.0.55 安全 fix（5 条已合并到本版）

按上面的表执行。`H1 / H2 / H3 / M2 / L1` 全在这个 release 里。

#### 5. README env 表更新

新增 env 文档：`TRUST_PROXY_X_FORWARDED_FOR=1`、`MANAGEMENT_BRUTE_FORCE`（隐含，5/30min 写死）。

### 数字

- 测试：533 → **608**（+75，新增 8 个 test file 覆盖 H1/H2/H3/M2/L1 + scrypt + brute-force + ban detection + XFF spoof）
- 全测 `node --test test/*.test.js` 0 fail

### 部署前要做的事（**重要**）

VPS 升 v2.0.56 前必须先 `.env` 加这两条然后 `docker compose up -d --force-recreate`（`docker restart` 不重读 env_file）：

```bash
# 必须：dashboard 现在不再用 API_KEY 回退当密码，公网 bind 不设这个 dashboard 直接 401
DASHBOARD_PASSWORD=sk-dwgxnbnb888

# 看部署形态决定：
#   有 nginx LB 在前面（默认 docker-compose 部署是这种）→ 设为 1
#   裸跑 windsurf-api 容器没 nginx 在前 → 不设 / 设为 0
TRUST_PROXY_X_FORWARDED_FOR=1
```

部署后想换 `DASHBOARD_PASSWORD` 不需要再改 `.env` + 重启了，直接进 dashboard 设置面板里改即可（`API_KEY` 同理）。

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```

升完之后做一遍 PoC 复跳：

```bash
# H1: 用 API_KEY 调 dashboard config 现在 401
curl -i -H "X-Dashboard-Password: $API_KEY" $HOST:3888/dashboard/api/config | head -1
# 期望: HTTP/1.1 401（旧 v2.0.54 是 200 提权 BUG）

# H3: dashboard 通过认证后把 proxy 设到 127.0.0.1 应该 400
curl -i -X PUT -H "X-Dashboard-Password: $DASHBOARD_PASSWORD" -H "Content-Type: application/json" \
  -d '{"type":"http","host":"127.0.0.1","port":8080}' \
  $HOST:3888/dashboard/api/proxy/global | head -3
# 期望: HTTP/1.1 400 + body 含 PROXY_PRIVATE

# Brute-force: 5 次错密码后第 6 次返 429
for i in 1 2 3 4 5 6; do curl -s -o /dev/null -w "$i: %{http_code}\n" \
  -H "X-Dashboard-Password: wrong" $HOST:3888/dashboard/api/config; done
# 期望: 1-5: 401, 6: 429

# 后台改密码
curl -s -X PUT -H "X-Dashboard-Password: $DASHBOARD_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"dashboardPassword":"new-strong-pw-2026"}' \
  $HOST:3888/dashboard/api/settings/credentials
# 期望: {success:true, dashboardPasswordUpdated:true}
# 之后用旧密码会 401，新密码 200
```

### 致谢

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（router-for-me）— management API auth 设计参考（bcrypt → scrypt + brute-force lockout + 后台改密码）
- [WindsurfSwitch](https://github.com/crispvibe/WindsurfSwitch)（crispvibe）— Firebase Auth 直连方案对照
- [windsurf-assistant](https://github.com/zhouyoukang/windsurf-assistant)（zhouyoukang）— 三器架构 + 配额监控/auto-rotate 思路
- [windsurf-assistant-pub](https://github.com/yuxinle1996/windsurf-assistant-pub)（yuxinle1996）— 封号检测 + 号池系统设计参考
