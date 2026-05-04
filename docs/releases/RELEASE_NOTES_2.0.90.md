## v2.0.90 — #114 OneTimeToken 端点全坏 紧急绕路 (Devin sessionToken 直接当 apiKey)

lnqdev 在 v2.0.89 又报"邮箱密码登录失败 ERR_TOKEN_FETCH_FAILED invalid token"。e2e 实测 dwgx 自己 3 个账号在 VPS v2.0.89 也全炸 — 不是 lnqdev 部署问题，是上游 GetOneTimeAuthToken 端点自己坏了。

### 实测证据

`scripts/probes/v2089-ott-host-matrix.mjs` 跑了 3 账号 × {sessionToken_new, sessionToken_legacy} × {OTT_new, OTT_legacy} = 12 次 OTT 调用 — **12/12 全 401 invalid_token**。链路前段 Auth1 200 OK / PostAuth (new+legacy) 都 200 OK 给 sessionToken — 但任何 sessionToken 在任何 OTT host 都被拒。

意味着 v2.0.61 / v2.0.75 / v2.0.79 三层 fallback (preferredHost / cross-host retry / OTT dual-path fallthrough) 救不了 — 不是路径选择问题，是 GetOneTimeAuthToken 端点本身废了。

### 反向工程其他工具

参考 v2.0.57 学习对象 windsurf-assistant (zhouyoukang/windsurf-assistant) v17.42.20 (2026-04-27 仍活跃)。它的 CHANGELOG 在 v17.40 已经标记"Cognition 全面迁移至 Devin · Firebase identitytoolkit 实测不可达"，**完全跳过 OTT 和 RegisterUser** 走 Devin-only:

```
Auth1 password/login → WindsurfPostAuth → sessionToken → 直接当 IDE auth credential
```

注释明说"Windsurf IDE 原生接受 3 种 token 前缀: sk-ws-01- / devin-session-token$ / cog_"。也就是 Cascade 后端的 metadata.apiKey 字段对 sessionToken 跟 codeium register_user 给的 sk-ws-01- 同等接受。

### 实测 sessionToken 当 apiKey 通不通

`scripts/probes/v2089-sessiontoken-as-apikey.mjs` 跑 6 种 auth shape × 2 host × 2 账号:

```
A. apiKey=sessionToken (no extra)              200 ★ planName=Trial
B. apiKey=sessionToken + Bearer header         200 ★
C. apiKey="" + Bearer header                   400 invalid_argument
D. apiKey="" + x-api-key                       400 invalid_argument
E. apiKey=auth1Token (no extra)                401 invalid api key
F. apiKey=sessionToken split by $              401 invalid api key
```

Shape A 4/4 全通 — Cascade gRPC 接受裸 sessionToken 当 apiKey。所以反代不需要做任何 token 转换，PostAuth 拿到 sessionToken 后直接当 apiKey 返给客户端就好。

### 修

`src/dashboard/windsurf-login.js` `windsurfLoginViaAuth1` 链路从

```
Auth1 → PostAuth → OTT → registerWithCodeium → apiKey (sk-ws-01-)
```

塌成

```
Auth1 → PostAuth → apiKey = sessionToken
```

OTT + cross-host retry + codeium register_user 整段删（约 60 行 → 10 行）。`oneTimeTokenDualPath` / `registerWithCodeium` 函数本身保留（Firebase 路径还在用 registerWithCodeium，但 Firebase signInWithPassword 现在被 Google App Check 挡了 server-side 走不通，所以 dispatcher 实际 fall through 到 Auth1 路径）。

### 改动

- `src/dashboard/windsurf-login.js` — `windsurfLoginViaAuth1` 主链路改 sessionToken-as-apiKey
- `test/v2090-ott-bypass.test.js` — 新（6 case 源码不变量：no oneTimeTokenDualPath call / no registerWithCodeium / no ERR_TOKEN_FETCH_FAILED / apiKey: sessionToken / postAuthDualPath 仍调 / windsurfLogin 仍 export）
- `scripts/probes/v2089-ott-host-matrix.mjs` — 新（OTT 4 host 矩阵真证据）
- `scripts/probes/v2089-sessiontoken-as-apikey.mjs` — 新（sessionToken 当 apiKey 6 shape × 2 host 全测）

### 数字

- 测试 904 → **910**（+6）
- 全测 0 fail / 0 回归
- e2e 3 账号 VPS 实测：v2.0.89 ERR_TOKEN_FETCH_FAILED 3/3 → v2.0.90 (待部署后重测)

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```

### 受影响场景

- ✅ dashboard 邮箱密码登录（修好了）
- ✅ 老的 sk-ws-01- apiKey 仍能用（Cascade 后端兼容多种前缀）
- ⚠ Firebase 登录路径（Google App Check 挡了，不在我们 scope；dispatcher 自动 fall through 到 Auth1 路径所以实际不影响用户）
- ⚠ "复制 Token" 路径（用户从 windsurf.com/show-auth-token 复制的 Token 仍正常工作）

### 后续清理（下一版可做）

- `oneTimeTokenDualPath` / `registerWithCodeium` 已经无人调（Firebase 路径死了），下版可以删掉
- v2.0.61 / v2.0.75 / v2.0.79 三层 OTT fallback 注释也无意义，下版清理
