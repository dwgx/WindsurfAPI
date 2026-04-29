## v2.0.24 — Dashboard UX 三件套：登录代理移底 / 模型饼图悬浮 / 手绘草稿风同步

纯前端 release，三件 dashboard 用户反馈来的 UX bug 一锅端。后端零改动，283/283 tests pass。

Pure-frontend release fixing three dashboard UX issues. Zero backend changes. 283/283 tests pass.

### 改了什么 / What changed

**🟢 1. 默认 UI：登录代理（可选）下沉到面板最底**

`src/dashboard/index.html`：原来 "登录代理（可选）" 夹在邮箱密码登录的 section 里（嵌在 batch import 上面），用户视觉上被它打断、还以为是必填项。现在移到整个 windsurf-login panel 的最底部（登录历史 section 之后），新增独立 `id="wl-proxy-section"`。Section 2 (邮箱密码登录) 现在只有：邮箱、密码、批量导入、登录按钮。

`section.emailLogin.desc` 文案同步更新为「仅限邮箱+密码注册的账号 第三方登录请用上面的按钮；支持单个登录或按"邮箱 密码"格式批量导入」，明确告诉 OAuth 用户上面的按钮才是入口。

The proxy section was previously embedded inside the email/password section, visually interrupting the login flow and looking like a required field. Moved to its own standalone section at the absolute bottom of the windsurf-login panel (after login history). Section 2 now contains only the actual email/password login UI. Section 2 description rewritten to direct OAuth users to the buttons above.

**🟢 2. 默认 UI：模型饼图鼠标悬浮 tooltip 修复**

统计页 model 分布饼图鼠标移上去没数据。Playwright 实测确认 `model-pie-canvas._hoverBound: false`（旁边的 `stats-canvas._hoverBound: true`）。

`src/dashboard/index.html`：
- `.chart-pie-body` 加 `position:relative`，新增内嵌 `<div class="chart-tooltip" id="model-pie-tooltip">` 元素
- `renderModelPie()` 渲染完后填充 `this._pieHitMap = { cx, cy, rOuter, rInner, total, segments, W, H }`，调一次 `this._bindPieHover()`
- 新增 `_bindPieHover()`：listener 监听 canvas mousemove，计算半径距离 + 极角，找到对应 segment，渲染 tooltip 显示模型名/请求数/占比/成功/错误/成功率
- mouseleave 隐藏 tooltip

Stats page model-pie chart had broken hover. Verified via Playwright: `model-pie-canvas._hoverBound: false` while neighboring `stats-canvas._hoverBound: true`. Added `_bindPieHover()` mirror of the existing stats-canvas binder, dedicated `model-pie-tooltip` element, and segment hit-tracking populated by `renderModelPie()`. Tooltip now shows model name, request count, percentage, success, errors, success rate on hover.

**🟢 3. 手绘草稿风：同步 v2.0.22-v2.0.24 的全部 windsurf-login 改动**

`src/dashboard/index-sketch.html` 之前的 windsurf-login 面板停留在 v2.0.21 阶段：
- Section 2 嵌入了 `<details>Proxy (optional)</details>` —— 同默认 UI 老样
- 没有 inline-token paste UX
- 登录失败只显示干文字，没有 OAuth/token 替代方案按钮
- 标题/描述还是「邮箱 + 密码」

这一版手绘草稿风全部对齐：
- Section 2 拿掉 `<details>` proxy 块；标题改 "邮箱密码登录"，描述改新文案
- panel 底部新增独立 `id="wl-proxy-section"` — 5 字段表单 + Test proxy 按钮
- App 对象新增三个方法（mirror 默认 UI 的实现，但用 sketch 的 i18n 风格）：
  - `getWindsurfLoginFailActions(r, email)` — 当 `r.isAuthFail` 为 true 时渲染 OAuth 按钮 + inline token paste 框
  - `openWindsurfTokenUrl(inputId)` — 用 v2.0.23 提取的真实 Windsurf editor 2.0.67 backup-login URL（含 `client_id=3GUryQ7ldAeKEuD2obYnppsnmj58eP5u` + 随机 state）打开 windsurf.com 拿 token，自动 focus 到右边粘贴框
  - `addAccountFromInlineToken(inputId, label)` — POST `/dashboard/api/accounts {token, label}` 直接入池
- `windsurfLogin()` 失败分支 innerHTML 末尾追加 `${this.getWindsurfLoginFailActions(r, email)}`

Sketch UI was lagging behind v2.0.22-v2.0.23. Now fully synced with default UI: extracted proxy into standalone bottom section, removed the embedded `<details>`, added the inline-token paste UX with the canonical Windsurf editor backup-login URL, and OAuth fallback buttons in the failed-login result panel. Sketch-style i18n preserved (uses `I18n.locale` instead of `I18n.t()`).

### Verification

- `node --test test/*.test.js`: **283/283 passing**（无后端改动）
- `src/dashboard/index.html`: ~217KB（v2.0.23 + ~30 lines for `_bindPieHover` + tooltip element）
- `src/dashboard/index-sketch.html`: ~5KB delta（Section 2 缩减 + 底部 proxy section + 三个 App 方法）
- 默认 UI 手测：登录失败仍展示 inline-token UI；统计页饼图鼠标悬停显示 tooltip
- 手绘草稿风手测：登录失败现在也显示 inline-token UI；底部 proxy 表单可见

### Compatibility

- 升级路径：`docker compose pull && docker compose up -d`
- 纯前端 — 后端 API 不变
- 旧 i18n 不缺 key（沿用 v2.0.22 的 `oauth.*` 5 个 key）
- Zero npm dependencies

### 下一步：v2.0.25 计划

后端 codex 审过 Cascade conversation reuse，发现 1 HIGH + 2 HIGH + 3 MED + 2 LOW 真问题。报告：`tmp/codex-cascade-reuse-audit-2026-04-29.md`。完整 fix sketch 都给出，准备 v2.0.25 系统改：

- HIGH-1：reuse key 升级成 server-state semantic key（包含 system/assistant/tool calls/media digest/canonical content blocks/stable object key sort）
- HIGH-2：expired/nonexistent cascade 命中后必须 fresh fallback + 不能 restore 坏 entry（识别 `not_found.*(cascade|trajectory)` 错误，invalidate + 重建）
- HIGH-3：caller isolation 扩展到 `/v1/chat/completions` 和 `/v1/responses`，shared API key 没 user/session 维度时默认禁 reuse
- MED：tool emulation reuse key 纳入 tool schema/tool_choice/preamble hash；cache_control TTL policy fix；pool checkout 加 expected owner atomic check
- LOW：dashboard restart LS 同步清 pool；记录 history coverage / truncation
