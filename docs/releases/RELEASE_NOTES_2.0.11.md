## v2.0.11 — 实验性 sketch dashboard 皮肤 (cookie 切换)

新增：仪表盘可切换皮肤。默认仍是现代风（不动），加了一个手绘草稿风的实验性 UI 作为 opt-in 替代。

### 切换方式 (How to switch)

- 设置入口：仪表盘"实验性功能"面板新增"界面风格 / Console skin"下拉选择。
- 后端：cookie `dashboard_skin=sketch` 命中即返回 sketch HTML，否则返回默认 HTML。`Vary: Cookie` 防止中间层串味。
- Sketch 皮肤里也有一个回切按钮（侧栏脚部）和一个面板里的下拉。

The dashboard now has a switchable skin. Default modern UI is unchanged; a hand-drawn sketch UI is added as an opt-in alternative.

- Toggle: experimental panel → "界面风格 / Console skin" dropdown.
- Backend: cookie `dashboard_skin=sketch` selects the sketch HTML; otherwise default. `Vary: Cookie` prevents intermediary cache poisoning.
- Sketch skin also exposes a back-to-default button in its sidebar footer and a dropdown inside its experimental panel.

### Sketch 皮肤逻辑修复 (audit 出来的 critical drift)

第三方贡献的 sketch UI 跟生产后端有几处 API contract drift，独立审计 (codex) 拉出来后这次都补齐了：

- **logs SSE**：从 `EventSource ?token=` 改成 `fetch + X-Dashboard-Password` 头，payload 字段名 `{ts, msg}` 对齐生产；之前的写法对正式后端是 401 / 字段全空。
- **experimental routes**：`PATCH` → `PUT`，`POST /clear-pool` → `DELETE /conversation-pool`；读 `flags.cascadeConversationReuse` 而不是顶层。之前所有切换静默失败。
- **system-prompts editor**：整段从默认 UI 移植过来 (`loadSystemPrompts` / `saveSystemPrompt` / `resetSystemPrompt`)，sketch 现在能跟默认 UI 一样改重置 prompt 模板。
- **/stats 字段名 drift**：`r.hourly / r.models / r.accounts` → `r.hourlyBuckets / r.modelCounts / r.accountCounts`（后端 shape 早就是这样）。之前 sketch 的 stats 永远是空。
- **/bans 端点不存在**：sketch 改成跟默认 UI 一样从 `/accounts` 派生 ban 列表。原来的 `/bans` 调用是 404。
- **/credits**：后端无此端点，sketch 现在 graceful fallback 到 GitHub PR 链接。
- 原本 sketch 缺的 nice-to-have 全补齐：proxy 测试按钮 + 状态、batch-import 多行 proxy 语法说明、stats 范围切换 (24h/7d/30d)、清空统计按钮、stats + bans 的 30s 自动刷新。

Sketch skin contract drift fixes (called out by independent codex audit):

- **logs SSE**: switched from `EventSource ?token=` to `fetch + X-Dashboard-Password` header; payload field names corrected to `{ts, msg}`. The previous wiring 401'd against the real backend and rendered no log content.
- **experimental routes**: `PATCH` → `PUT`, `POST /clear-pool` → `DELETE /conversation-pool`; reads `flags.cascadeConversationReuse` instead of a top-level field. Earlier toggles silently reverted on next load.
- **system-prompts editor**: ported over from the default UI (`loadSystemPrompts` / `saveSystemPrompt` / `resetSystemPrompt`); the sketch panel can now read/write/reset prompt templates the same way.
- **/stats response-shape drift**: sketch was reading `r.hourly / r.models / r.accounts`; backend ships `r.hourlyBuckets / r.modelCounts / r.accountCounts`. Stats panel was empty until this release.
- **/bans nonexistent**: sketch now derives the ban list from `/accounts` (same pattern as the default UI). The previous `/bans` call 404'd.
- **/credits**: backend has no such route; sketch now gracefully falls back to a link to the GitHub PR list.
- Nice-to-have catch-up: proxy test button + status line, batch-import help text covering the optional per-line proxy syntax, stats range presets (24h/7d/30d), reset-stats action, 30s auto-refresh on stats + bans.

### Emoji → inline SVG

Sketch 里所有可见的 unicode 图标 (`✓ ✗ → ↻ ▸ ☾ ☀ ✎ ↳ 📋 🔍 ♡ ⟳ ✱`，共 30 处) 全部替换成 Lucide 风格的 inline SVG，零 npm 依赖，跨平台渲染一致。CSS `content:` 伪元素 (4 处) 留作字体装饰，不会渲染成 emoji。

All 14 unicode pictographs in the sketch UI (30 total occurrences) replaced with inline Lucide-style SVG. Zero npm deps. CSS pseudo-element `content:` rules are intentionally left as font glyphs.

### 兼容性 (Compatibility)

- 默认 UI 行为完全没变。已有用户切换前不会感到任何区别。
- 只新增了 cookie `dashboard_skin`，路径 `/`，max-age 一年，samesite=lax。
- 同一台浏览器在不同 dashboard 端点之间共享 cookie；多 origin 部署需要分别切换。
- Default UI behavior is unchanged. Existing users see no difference until they opt in.
- New cookie `dashboard_skin` only; path=/, max-age=1y, samesite=lax.
- Cookie is per-origin; multi-origin deployments switch independently.

### 致谢 (Acknowledgements)

- Sketch UI 设计：Claude design 提供初稿，本版按 codex 5.4 审计 + claude 收尾把 API drift 全部补齐。
- Sketch UI: original draft from Claude design; this release reconciles it against the production backend per a codex 5.4 audit + claude review pass.
