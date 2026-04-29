## v2.0.23 — OAuth token URL 改用从 Windsurf 2.0.67 editor binary 提取的真实 backup-login URL

v2.0.22 用了 `https://windsurf.com/show-auth-token` 直接跳转。codex 后续从真实 Windsurf editor 2.0.67 binary 里提取出**editor desktop 自己**用的 backup-login URL：

```
https://windsurf.com/windsurf/signin?response_type=token&client_id=3GUryQ7ldAeKEuD2obYnppsnmj58eP5u&redirect_uri=show-auth-token&state=<random>&prompt=login&redirect_parameters_type=query&workflow=
```

这是 Windsurf editor 的 `provideAuthToken()` 命令（VS Code Command Palette: "Windsurf: Provide Authentication Token (Backup Login)"）实际打开的 URL，比裸 `/show-auth-token` 更准确：
- 显式 `response_type=token` —— 告诉 windsurf 返 token，不是 session cookie
- 携带 client_id —— Windsurf editor 的 canonical identifier `3GUryQ7ldAeKEuD2obYnppsnmj58eP5u`（公开值，从 editor binary 提取）
- 包含随机 state —— CSRF 防护
- `redirect_uri=show-auth-token` —— 登录完成后跳到 token 显示页

证据：
- `tmp/windsurf-2.0.67/Windsurf/resources/app/extensions/windsurf/dist/extension.js` 中 `getLoginUrl({forceShowAuthToken:true})` + `provideAuthToken()` + `copyAuthTokenUrl()` 三处均使用同一 URL 模板
- `extension.js` 默认 website `https://windsurf.com`
- 完整提取报告：`tmp/codex-oauth-investigation-2026-04-29.md`

This release uses the same backup-login URL that real Windsurf editor opens when its "Provide Authentication Token" command is invoked. Extracted from editor 2.0.67 binary by codex investigation. Same UX as v2.0.22, just with a more correct URL that bypasses the auth-protected `/show-auth-token` bounce.

### 改了什么 / What changed

`src/dashboard/index.html`:
- 新方法 `App.openWindsurfTokenUrl(inputId)`：构造完整 backup-login URL（含 random state、client_id、response_type=token），`window.open` 新 tab，自动 focus 后边的 token paste 输入框
- `getWindsurfLoginFailActions(r)` 内嵌按钮 onclick 从硬编码 `window.open('show-auth-token')` 改成调 `openWindsurfTokenUrl()`
- 没有其他改动；i18n / addAccountFromInlineToken / 整体面板布局保持 v2.0.22 一致

### Verification

- `node --test test/*.test.js`: **283/283 passing**（无后端改动）
- `src/dashboard/index.html`: 217KB（v2.0.22 同水平 + ~10 行）

### Compatibility

- 升级路径：`docker compose pull && docker compose up -d`。
- 纯前端改动 — 后端不变
- 老用户首次访问拿到新 JS，token 流程立刻生效
- 283/283 tests pass。Zero npm dependencies, unchanged.

### Device Flow 调查结论

附 codex 调查的另一个发现：**Windsurf 上游没有 OAuth Device Authorization Grant** —— 类似 GitHub CLI 那种 "终端显示 8 位 code，浏览器输入" 的流程不存在。所以 backup-login URL 是当前唯一 universally-working 的 OAuth-only 账号入池途径。
