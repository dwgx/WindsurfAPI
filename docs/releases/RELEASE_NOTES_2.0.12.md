## v2.0.12 — 安全加固 + 历史 PR 补救合并 + Anthropic prompt-caching

这一版主要做两件事：（1）把之前关掉但没合的几个外部 PR 里方向干净的 hunk 单独 cherry-pick 进主线，作者署名通过 `Co-authored-by` trailer 保留；（2）顺带把 v2.0.11 之后陆续落主线的 Anthropic prompt-caching 兼容、cascade 池设备隔离、tier modal 文案修复等合一打包。

This release lands two threads: (1) cherry-picking salvageable hunks from previously-closed external PRs back into master with author attribution preserved via `Co-authored-by`; (2) bundling the post-2.0.11 fixes that have already shipped to master — Anthropic prompt-caching compatibility, per-device cascade pool isolation, tier modal copy correction.

### 安全加固（cherry-pick 自 #80 ZLin98）

- **Language server env allowlist** — `ensureLs` 以前直接把整份 `process.env` 喂给 LS 子进程，本机 AWS / GitHub / 任何 CI secret 都漏出去。新加 `buildLanguageServerEnv` 只白名单 `HOME / PATH / LANG / TMPDIR / HTTP(S)_PROXY / SSL_CERT_FILE / NODE_EXTRA_CA_CERTS` 八类，剩下全部丢弃。原来的 proxy override 与 `/root` HOME fallback 行为保留。`test/langserver-redact.test.js` 加 4 条覆盖：白名单生效、proxy override 跨 4 个变量名、HOME fallback 仅在缺失时触发、SSL trust 三件套保留。
- **跨平台 workspace 重置** — `src/index.js` 把 `execSync('mkdir -p /tmp/... && rm -rf')` 改为 Node `mkdirSync + readdirSync + rmSync`，Windows 上不再因为缺少 POSIX shell 报错。workspace base 从硬编码 `/tmp/windsurf-workspace` 改为 `os.tmpdir()` 派生，三大平台一致行为。
- **Dashboard auth 收紧** — `checkAuth` 移除 `?pwd=` query string fallback。`logs/stream` 早就从 `EventSource` 迁到 `fetch + ReadableStream`（参见 `src/dashboard/index.html` 注释），query 路径已无客户端在用，留着只会让 password 进 nginx access log 和浏览器历史。

剩下的 #80 改动（HOST 默认 127.0.0.1 + ensurePublicAuth、ENABLE_SELF_UPDATE/BATCH_LOGIN/LS_RESTART feature flag 默认全关、`getAccountList` 默认不返完整 apiKey、sessionStorage 替代 localStorage、FORWARD_CALLER_ENV opt-in、scripts/start.js launcher）都是行为变化或 UX 倒退，没并是怕一次性破坏现有 docker / dashboard 部署，但思路完全合理，未来按需逐项推进。

Hardening, cherry-picked from PR #80 by @ZLin98:

- **LS env allowlist** — `ensureLs` no longer forwards the full `process.env` to the language-server child process. New `buildLanguageServerEnv` keeps only `HOME / PATH / LANG / TMPDIR / HTTP(S)_PROXY / SSL trust` and drops everything else. Proxy override and the `/root` HOME fallback are preserved. `test/langserver-redact.test.js` covers allowlist enforcement, proxy override across the 4 variable names, HOME fallback gating, and SSL trust pass-through.
- **Cross-platform workspace reset** — `src/index.js` replaces `execSync('mkdir -p /tmp/... && rm -rf')` with Node `mkdirSync + readdirSync + rmSync`, fixing startup on Windows where there's no POSIX shell. Workspace base now derives from `os.tmpdir()` instead of a hardcoded `/tmp/`.
- **Dashboard auth tightened** — `checkAuth` drops the `?pwd=` query string fallback. `logs/stream` has used `fetch + ReadableStream` for months; the query path was no longer used by any client and only let the password leak into URL access logs and browser history.

The remaining 6 changes from #80 (HOST default to 127.0.0.1 with `ensurePublicAuth` reject, ENABLE_SELF_UPDATE / BATCH_LOGIN / LS_RESTART feature flags defaulting off, `getAccountList` redacting apiKey by default, sessionStorage instead of localStorage, FORWARD_CALLER_ENV opt-in, scripts/start.js launcher) are behaviour or UX regressions for existing docker / dashboard deployments, so they're left out of this release. The direction is correct; they'll land separately when each one is paired with a migration path.

### Anthropic 兼容增强 (post-2.0.11 已合主线)

- **Prompt caching `cache_control` 兼容** — `/v1/messages` 现在识别并消化 Anthropic 标准的 `cache_control: { type: 'ephemeral', ttl: '5m' | '1h' }` 标记。`extractCachePolicy` 在 tools / system / messages 三层扫描所有 `cache_control` 后从 body 删除避免上游回挡，同时统计 breakpoint 数量并嗅出 `1h` 请求。命中 `1h` 时 cascade pool 的 entry TTL 自动延长到 90 分钟。usage 输出沿用 Anthropic 当前 GA 的双 shape：扁平的 `cache_creation_input_tokens` + 嵌套的 `cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }`，`message_start` 与 `message_delta` 都已切到这个新 shape。`test/cache-control.test.js` 8 条覆盖。
- **Cascade pool 按 Claude Code 设备隔离** — `metadata.user_id`（Claude Code 设备唯一 id）参与 cascade pool fingerprint，多人共用同一 API key 不会再串 cascade context。
- **Adaptive thinking 路由** — Anthropic `output_config` / `thinking` 字段统一翻译，自适应模型选择走有效 modelKey 路径并打日志。
- **Server-side tools 净化** — Anthropic server-side tool blocks（`web_search_20250305`、`bash_20250124` 之类）在转发上游前丢弃，避免 Cascade 因不识别工具直接 reject。

### tier 修复

- **Per-account allowlist 路由** — `isModelAllowedForAccount` 现在尊重 `account.capabilities[modelKey].reason === 'user_status' | 'not_entitled'`，free 账号上游本就允许 GLM/SWE/Kimi 时反代不再卡住。
- **Manual tier override 不被 capability 短路** — `tierManual=true` 时跳过 capability 提前裁决，避免 `a28d63f` 引入的 manual tier 失效回归。modal 文案同步更新成"按上游 allowlist 路由"。

Anthropic compatibility (already on master post-2.0.11):

- **Prompt caching `cache_control` markers** — `/v1/messages` recognises Anthropic's standard `cache_control: { type: 'ephemeral', ttl: '5m' | '1h' }`. `extractCachePolicy` strips these before forwarding upstream, counts breakpoints, and detects `1h` hints which extend cascade pool entry TTL to 90 minutes. Usage output emits both the flat `cache_creation_input_tokens` and the nested `cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }` shape that Anthropic ships in GA today. 8 test cases under `test/cache-control.test.js`.
- **Per-device cascade pool isolation** — `metadata.user_id` (Claude Code device id) is part of the cascade pool fingerprint, so multiple devices sharing one API key no longer cross-contaminate cascade context.
- **Adaptive thinking routing** — Anthropic `output_config` / `thinking` fields are normalised; thinking-routed requests log the effective modelKey.
- **Server-side tools dropped** — Anthropic-style server-side tool blocks (`web_search_20250305`, `bash_20250124`, etc.) are stripped before forwarding to Cascade so the upstream doesn't reject the whole request on an unknown tool type.

### Tier fixes

- **Per-account allowlist honoured** — `isModelAllowedForAccount` now respects `account.capabilities[modelKey].reason === 'user_status' | 'not_entitled'`, so free-tier accounts that the upstream actually entitles to GLM / SWE / Kimi route through correctly.
- **Manual tier override survives capability gate** — `tierManual=true` skips the capability shortcut, fixing the `a28d63f` regression where capability could quietly override an operator's explicit tier.

### Credits 面板补全

`src/dashboard/data/contributors.json` 单一数据源补加三位贡献者，默认 + sketch 两套 dashboard 同时显示：

- **@ZLin98 #80** — A 级，安全加固先行者（LS env allowlist + 跨平台 workspace + dashboard auth 收紧）
- **@Yuuqq #73** — B+ 级，Windows 兼容性首位实测人（sanitize URL、OPTIONS 204、pool regex escape 三处摘进 `44ad502`）
- **@abwuge #65** — A 级，GHCR + GitHub Release 自动发布流水线（v2.0.6+ 的发版链路就是他这条 workflow）

Credits panel:

`src/dashboard/data/contributors.json` (single source for both default and sketch dashboards) gains three more contributors:

- **@ZLin98 #80** — A tier, security hardening pioneer (LS env allowlist + cross-platform workspace + dashboard auth tightening)
- **@Yuuqq #73** — B+ tier, first Windows-on-WindsurfAPI tester (sanitize URL handling, OPTIONS 204, pool regex escape — three hunks landed in `44ad502`)
- **@abwuge #65** — A tier, GHCR + GitHub Release CI pipeline (every release since v2.0.6 has shipped on this workflow)

### Compatibility / 兼容性

- 升级路径无操作。docker compose pull + up 即可。
- 现有 .env 不需要改。LS env allowlist 对正常部署透明（已部署的 VPS HOME / PATH / proxy 都在白名单里）。
- Dashboard `?pwd=` query 移除是 hard break，但本仓库内已无客户端在用；如有 fork 自定义客户端走 query password 路径请改用 `X-Dashboard-Password` header。
- 运行时无新增 npm 依赖；仍是零 deps。

- No upgrade actions required. `docker compose pull && docker compose up -d` is sufficient.
- Existing `.env` files unchanged. The LS env allowlist is transparent for typical deployments (HOME / PATH / proxy variables are all on the allowlist).
- Dashboard `?pwd=` query removal is a hard break, but no in-tree client used it. Forks running a custom client that authenticated by query string should switch to the `X-Dashboard-Password` header.
- Zero npm dependencies, unchanged.
