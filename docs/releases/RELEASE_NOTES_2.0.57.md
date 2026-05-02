## v2.0.57 — 6 项研究驱动升级（迁移债 + 配额智能 + 暴破防护）

接 v2.0.56 的研究做完整改清单。学习对象：[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) / [WindsurfSwitch](https://github.com/crispvibe/WindsurfSwitch) / [windsurf-assistant](https://github.com/zhouyoukang/windsurf-assistant) / [windsurf-assistant-pub](https://github.com/yuxinle1996/windsurf-assistant-pub)。

### Fix 1 — RegisterUser 迁 `register.windsurf.com`（保留 `api.codeium.com` fallback）

**`src/windsurf-api.js` 新增 `registerWithFirebaseToken()`** + 改 `client.js / get-token.js / dashboard/windsurf-login.js` 三处共用

Windsurf 在 2026 上半年把账号注册迁到 `register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser`（Connect-RPC）。我们仍打老 `api.codeium.com/register_user/`（REST）— 现在还能用，但下次上游清理就 404。wam-bundle / WindsurfSwitch 都用新路径。

新逻辑：先打新端点，5xx / 网络失败回退老端点。同时支持 snake_case 和 camelCase 响应。fingerprint + proxy 通过 customRequest hook 注入到统一 helper，3 处行为对齐。

### Fix 2 — WindsurfPostAuth 迁 `windsurf.com/_backend`（保留旧 host fallback）

**`src/dashboard/windsurf-login.js`** 新增 `postAuthDualPath / oneTimeTokenDualPath`

PostAuth 和 GetOneTimeAuthToken 都从 `server.self-serve.windsurf.com` 迁到 `windsurf.com/_backend`。同样新前旧后双路径。4xx 直接停（auth fail），5xx / 网络故障 fallback。

### Fix 3 — GetPlanStatus daily/weekly（**已实现 — 后端 + UI 都有**）

清账盘点：我们 `windsurf-api.js getUserStatus()` 早就返了 `dailyPercent` / `weeklyPercent`（normalizeUserStatus line 177-180），dashboard 默认 + sketch UI 都已显示双进度条。这一项不需要新代码，只在 release notes 里记录确认。

### Fix 4 — Predictive pre-warming（按 quotaScore 选号）

**`src/auth.js` `getApiKey()` sort 多一道权重**

之前按 `_inflight → RPM → LRU` 排，没看 daily/weekly%。现在加一层：把 `min(daily%, weekly%)` 的 5% 桶作为 sort key 放在 inflight 之后、RPM 之前。

效果：两账号都 idle 时优先选配额高的；选定的账号配额 < 10% 时（DROUGHT_THRESHOLD * 2），异步 fire-and-forget 预热下一个候选 LS（每账号 30s 节流）。客户端切号 cold start 显著缩短。

### Fix 5 — Drought mode（暴露状态 + UI 横幅）

**`src/auth.js` 新增 `isDroughtMode / getDroughtSummary` + `/dashboard/api/drought` GET + 双皮 UI banner**

定义：所有 active 账号的 weeklyPercent 都 < 5% → drought。

不强制限制模型（避免误伤正在用付费模型的客户端），但 expose 状态：
- `GET /health?verbose=1` 返 `drought` 字段
- `GET /dashboard/api/drought` 返 `{drought, threshold, activeAccounts, knownAccounts, lowestWeeklyPercent, lowestDailyPercent}`
- Dashboard 默认皮 + sketch 皮 accounts panel 顶部都加了警告横幅，drought=true 时自动显示，给出最低剩余 % + 已知/总账号数

operator 看到横幅就知道要补账号 / 等重置，不用挖单账号详情。

### Fix 6 — Email-side brute-force lockout

**`src/dashboard/windsurf-login.js`** 新增 `_emailFailures` map + `checkEmailLocked / recordEmailFailure / recordEmailSuccess`

灵感来自 wam 的 `_bumpFailure`。同一 email 连续 3 次登录失败 → 本地锁 15 分钟，避免大量错密码请求打到 Firebase / Windsurf 触发上游账号风控。仅 auth-shaped 失败计数（网络 / 5xx 不算）。Idle 2h 自动清理。

整改前：dashboard 操作员密码错 N 次都打到 Firebase。
整改后：本地 3 次失败立即锁，错误信息友好提示"X 分钟后再试"。

### 数字

- 测试：608 → **629**（+21，4 个新 test file 覆盖 dual-path / quotaScore / drought / email-lockout）
- 全测 0 fail
- diff: 4 src 文件 + 5 dashboard 文件 + 4 测试 + i18n 双语 + release notes

### 升级

```bash
docker compose pull && docker compose up -d
```

不需要 force-recreate（这一版没新 env）。

### 下一版可做（已挖出但未做）

- **drought mode 强制限模型**：当前只 expose 状态，没主动禁 premium 模型。若 operator 反馈"drought 时仍想限速付费模型"再做。
- **windsurf-assistant-pub 商业化能力**：邀请码 / 支付链接 / 一键接受邀请 / 取消计划 — 需要 Windsurf 内部 RPC，且涉及商业付费场景，不在 scope。
- **重置机器码**：客户端工具能力，server-side proxy 不沾边。
