## v2.0.22 — OAuth-only 账号一键 token 入池：登录失败时直接显示 token paste 框

很多 Windsurf 账号是 Google/GitHub OAuth 注册的，从来没设过 password。这类账号在我们的 dashboard 里跑 email+password 登录会拿到 `ERR_NO_PASSWORD_SET` 错误。原来错误展示里只有 "Sign in with Google" / "Sign in with GitHub" 按钮 + 一个 "Copy Auth Token" 链接 —— OAuth 按钮在远程 IP 部署上 Firebase 会拒（unauthorized-domain），用户得自己跑去 windsurf.com 拿 token、再跳到"账号管理"面板粘贴，体验割裂。

这一版把 token paste 流程直接 inline 进登录失败的反馈面板。**不动后端，纯 dashboard UX 改动**。

This release improves the UX for adding OAuth-only Windsurf accounts (Google/GitHub registered, no password set). Previously, when an `ERR_NO_PASSWORD_SET` came back the dashboard suggested OAuth buttons (which fail with `auth/unauthorized-domain` on remote IP deployments) plus a "Copy Auth Token" link that required users to manually navigate to a different panel. Now there's an inline token paste field directly in the error response — one click opens windsurf.com, paste back, submit, done.

### 改了什么 / What changed

**🟢 dashboard 登录失败面板：内嵌 token paste UI**

`src/dashboard/index.html`：`getWindsurfLoginFailActions(r)` 现在渲染两段：
1. 顶部：保留 "Try Another Way" — Google/GitHub OAuth 按钮（适用于本地 dev / authorized domain 部署）
2. 底部：新增 inline token 流程
   - "打开 windsurf.com 拿 Token" 按钮 → `window.open('https://windsurf.com/show-auth-token', '_blank')` + 自动 focus 右边输入框
   - 一行文本输入框，placeholder 提示 "粘贴 Auth Token..."
   - "用 Token 添加" 按钮 → 调 `App.addAccountFromInlineToken(inputId, label)` → POST `/dashboard/api/accounts {token, label}` → 入池

`addAccountFromInlineToken()` 用失败登录尝试时的 email 当 label，复用现有 `/dashboard/api/accounts {token}` 端点（背后是 `addAccountByToken()` → `registerWithCodeium()`）。失败时只 toast，不破坏面板状态。

`getWindsurfLoginFailActions(r)` now renders an inline auth-token paste flow underneath the existing OAuth buttons. One click opens `windsurf.com/show-auth-token` in a new tab; the input on the right auto-focuses; pasting + clicking "Add via Token" submits to `/dashboard/api/accounts {token}` reusing the existing `addAccountByToken()` backend path. The failed-login email is passed through as the account label.

**🟢 i18n 新增 5 条**

- `oauth.inlineTokenTitle` / `oauth.inlineTokenDesc` / `oauth.openWindsurfToken` / `oauth.tokenPlaceholder` / `oauth.addWithToken`
- 中英文双语（`src/dashboard/i18n/zh-CN.json` + `en.json`）

### 为什么不一发就修 OAuth popup

Firebase Web SDK 的 `signInWithPopup` 走 `https://exa2-fb170.firebaseapp.com/__/auth/handler` 回调，**回调的 origin 必须在 Firebase project 的 Authorized domains 列表里**。该列表只有 Codeium 后端有权限改。我们能做的：
- 本地 dev (`localhost`) — Firebase 默认 allow
- 自己有 HTTPS 域名 + 自己跑独立 Firebase project — 自己加

我们的生产 VPS（裸 IP `154.40.36.22:3888`）+ 大多数 self-hosted 部署都不满足，OAuth popup 会立刻报 `auth/unauthorized-domain`。绕不过去。所以 inline token paste 才是 universally-working 的方案。

### Verification

- `node --test test/*.test.js`: **283/283 passing**（无后端改动）
- `src/dashboard/i18n/{zh-CN,en}.json`: JSON parse OK
- `src/dashboard/index.html`: 217KB（v2.0.21 同水平 + ~30 行）
- 手动验证：登录一个 OAuth-only 账号 → `ERR_NO_PASSWORD_SET` → fail 面板下方应显示新的 inline token 块

### Compatibility

- 升级路径：`docker compose pull && docker compose up -d`。
- 纯前端改动 — 后端 API 不变（`/dashboard/api/accounts {token}` 一直支持）
- 旧 dashboard cookie / cached i18n 用户首次访问会拿到新 i18n key 没翻译的占位（少见，刷一次就好）
- 283/283 tests pass。Zero npm dependencies, unchanged.

### 用户操作步骤（OAuth-only 账号入池）

1. Dashboard → "Windsurf Login" 面板
2. 输入邮箱 + 任意密码 → 点 Login
3. 出现 `ERR_NO_PASSWORD_SET` → fail 面板展开
4. 点底部 "打开 windsurf.com 拿 Token" → 新 tab 自动开
5. 在 windsurf.com 用 Google/GitHub 登该账号 → 页面显示 token
6. 复制 token → 回到 dashboard → 粘到 inline 输入框
7. 点 "用 Token 添加" → 入池

每个 OAuth 账号 5 步，全部在一个面板内完成。
