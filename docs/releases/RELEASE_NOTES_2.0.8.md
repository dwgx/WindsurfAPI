## v2.0.8 — 紧急登录修复 (Emergency login fix)

Windsurf 在 2026-04-26 当天调整了登录链路（半迁移状态），导致 dashboard 添加账号偶发 / 持续失败。本版只针对登录链路加固，无其他改动。

Windsurf reshuffled their login flow on 2026-04-26 (mid-migration), causing the dashboard "add account" flow to fail intermittently or persistently. This release is a focused login-path hardening; no other changes.

### 修复 (Bug fixes)

- 升 `CheckUserLoginMethod` 为主邮箱探测（Connect-RPC，响应形态 `{userExists, hasPassword}`，跑在 Windsurf `_backend` 后端，响应快、稳定）。
- 旧 `/_devin-auth/connections` 路径降级为 fallback，并新增对其新 schema (`{connections:[{type,enabled,...}]}`) 的兼容；老 schema (`{auth_method:{method,has_password}}`) 仍兼容。
- `_devin-auth/*` 系列端点跑在 Vercel functions 上时不时 504 / 503 (`FUNCTION_INVOCATION_TIMEOUT`)：增加 5xx 退避重试 (3 次, 0/2s/5s)，4xx 仍直通不重试。
- `password/login` 的错误 `detail` 字段从 string 变成 Pydantic v2 的 array 时不再触发 `.toLowerCase` 数组炸栈，统一拼成可读字符串。

Bug fixes:

- Promoted `CheckUserLoginMethod` (Connect-RPC) to the primary email probe. The new endpoint returns a clean `{userExists, hasPassword}` and runs on Windsurf's `_backend` cluster; responses are fast and stable.
- Demoted `/_devin-auth/connections` to fallback and added compatibility for its new schema (`{connections:[{type,enabled,...}]}`); the old `{auth_method:{method,has_password}}` shape is still accepted.
- Added 5xx exponential-backoff retries (3 attempts at 0 / 2s / 5s) for `_devin-auth/*` endpoints, which intermittently timeout on Vercel functions; 4xx responses still skip retries.
- `password/login` now safely normalizes the `detail` field whether it comes back as a string (legacy) or an array of Pydantic v2 validation errors.

### 致谢

- Repro / 反馈：[@Wenlong-Guo](https://github.com/Wenlong-Guo) ([#66](https://github.com/dwgx/WindsurfAPI/issues/66#issuecomment-4321596505))
- 路径迁移定位：codex worker (Playwright 抓 Windsurf 网页登录流量)

Acknowledgements:

- Repro / report: [@Wenlong-Guo](https://github.com/Wenlong-Guo) ([#66](https://github.com/dwgx/WindsurfAPI/issues/66#issuecomment-4321596505))
- Migration localization: codex worker (Playwright capture of Windsurf web login traffic)
