# CLAUDE.md

Windsurf-to-OpenAI compatible proxy. Headless Node.js service that authenticates
with Codeium's backend via the Windsurf language server binary (`language_server_linux_x64`)
over gRPC, and exposes `/v1/chat/completions` to OpenAI-compatible clients.

## Run it

```bash
node src/index.js          # prod entry
node --watch src/index.js  # dev (npm run dev)
```

Requires Node >= 20. Zero npm deps — the whole project is pure `node:*` builtins.
Language server binary must exist at `config.lsBinaryPath` (default
`/opt/windsurf/language_server_linux_x64`). On Windows the LS won't start, but
the HTTP server and dashboard still come up for local dev of non-chat paths.

## Architecture

```
src/
  index.js           - entry point, boots LS + HTTP server
  server.js          - HTTP server, route dispatch, streaming
  config.js          - env + defaults (.env overrides)
  auth.js            - account pool, RPM tracking, tier/blocklist, credit refresh
  models.js          - model catalog + tier->models table (MODEL_TIER_ACCESS)
  langserver.js      - LS pool: one binary per unique egress proxy
  client.js          - WindsurfClient: StartCascade / Send / poll trajectory
  windsurf.js        - protobuf builders + parsers (exa.language_server_pb, exa.cortex_pb)
  proto.js           - minimal varint/length-prefixed reader/writer
  grpc.js            - gRPC-over-HTTP2 unary call helper
  connect.js         - Firebase + api.codeium.com sign-in (register_user)
  conversation-pool.js - experimental cascade_id reuse pool (OFF by default)
  runtime-config.js  - runtime-config.json: experimental toggles
  cache.js           - in-memory exact-body response cache
  handlers/
    chat.js          - /v1/chat/completions: model routing, retry, tool emulation
    models.js        - /v1/models
    tool-emulation.js - prompt-level <tool_call> protocol for Cascade (no native slot)
  dashboard/
    api.js           - /dashboard/api/* admin routes
    index.html       - single-page admin UI (shadcn-style dark theme)
    logger.js        - ring buffer + SSE log stream
    proxy-config.js  - global + per-account proxy config (proxy-config.json)
    model-access.js  - global model allow/blocklist (model-access.json)
    stats.js         - request counters
    windsurf-login.js - direct Windsurf email+password sign-in flow
```

**Request flow (chat):** `server.js` → `handlers/chat.js` → account pick
(`auth.getApiKey(tried, modelKey)`) → `langserver.getLsFor(proxy)` → `WindsurfClient.cascadeChat()`
or `.rawGetChatMessage()` → gRPC unary calls to `LanguageServerService/StartCascade`,
`SendUserCascadeMessage`, polling `GetCascadeTrajectorySteps`/`GetCascadeTrajectory`.

**Cascade vs legacy:** Models with `enumValue === 0` + a `modelUid` (claude-opus-4.6,
claude-sonnet-4.5, etc.) go through the Cascade flow. Older models (`enumValue > 0`)
use `RawGetChatMessage`. See `src/models.js` for the catalog.

**LS pool:** one LS process per unique outbound proxy URL. Mixing accounts with
different proxies in a single LS causes silent state pollution — `InitializeCascadePanelState`
starts failing with "The pending stream has been canceled" and all accounts look "expired".
Always route an account through `getLsFor(acct.proxy)`.

**Tool emulation:** Cascade's protobuf has no per-request slot for client-defined
tool schemas (verified against the on-disk `exa.cortex_pb.proto` — `SendUserCascadeMessageRequest`
fields 1–6 are cascade_id / items / metadata / experiment_config / cascade_config / images,
nothing for tool defs). When a caller passes OpenAI-format `tools[]`, we serialize
them into the user text as a `<tool_call>{...}</tool_call>` emission contract and
parse blocks back out of the Cascade text stream. Lives in `src/handlers/tool-emulation.js`.

**Planner mode is load-bearing.** `buildCascadeConfig()` sets
`CascadeConversationalPlannerConfig.planner_mode = 3 (NO_TOOL)` — not the
`DEFAULT = 1` that all reference repos (pqhaz3925, AlexStrNik) use. The enum
`exa.codeium_common.ConversationalPlannerMode` has seven values:
`UNSPECIFIED=0 DEFAULT=1 READ_ONLY=2 NO_TOOL=3 EXPLORE=4 PLANNING=5 AUTO=6`.
DEFAULT keeps Cascade's IDE-agent loop hot even when `CascadeToolConfig` is
unset, so the planner reflexively fires `edit_file /tmp/windsurf-workspace/...`
on every turn, producing (a) 20 % `stall_warm` false-positives from silent
tool-execution trajectory steps where `responseText` stops growing while
status stays ACTIVE, (b) `"Cascade cannot create foo because it already
exists"` errors on bursts that reuse filenames, (c) `/tmp/windsurf-workspace/`
path leaks narrated into response bodies. NO_TOOL skips the loop entirely.
Measured 2026-04-12 on US 154.40.36.22 — 15-way opus stress test went from
13/15 → 15/15 success, 99 s → 35 s wall time, 0 leaks, 0 conflicts.

**DO NOT** confuse `planner_mode` with `CascadeToolConfig.run_command`. They
are different fields — `planner_mode` lives on `CascadeConversationalPlannerConfig`
(field 4), `run_command` lives on `CascadeToolConfig` (field 8 of the tool
config). NO_TOOL is the flag to set; `tool_config` must stay unset — turning
`run_command` on puts the agent into auto-execute mode and breaks things worse.

## Dashboard

Single page at `/dashboard`. Auth: bearer token = `config.API_KEY` or configured
dashboard password. 8 panels: 總覽 / 登入取號 / 帳號管理 / 模型控制 / Proxy / 日誌 / 統計 / 封禁偵測.

Persisted state lives in JSON files next to `src/`:
- `accounts.json` — account pool (tier, capabilities, blockedModels, credits, proxy)
- `proxy-config.json` — global + per-account proxy URLs
- `model-access.json` — global model allow/blocklist
- `runtime-config.json` — experimental toggles (cascadeConversationReuse, etc.)

## Conventions

- **Language:** Dashboard UI (`src/dashboard/index.html`) uses **简体中文**.
  README and `docs/` GitHub Pages use **繁體中文**. Code identifiers and comments
  stay in English.
- **Dashboard UI:** shadcn-style dark theme via CSS variables (`--surface`, `--accent`, `--radius`).
  NEVER use browser `alert()` / `confirm()` / `prompt()`. Use `App.confirm(title, desc, opts)`
  and `App.prompt(title, desc, fields)` — they render styled modal overlays. `App.confirm`
  supports `opts.html`, `opts.wide`, `opts.titleHtml`, `opts.danger`, `opts.okText`.
- **No npm deps.** Stick to `node:*` builtins. If you need protobuf, hand-roll it in `proto.js`.
- **Errors that must not burn account error counters:** rate limits, `permission_denied`,
  `failed_precondition`, and upstream "internal error occurred (error ID: ...)".
  See `reportInternalError` / `markRateLimited` in `auth.js`.
- **Logs:** use `log.info/warn/error/debug` from `config.js` — these feed the dashboard
  log panel via `dashboard/logger.js`.
- **Git line endings:** the repo has `text=auto`; Windows checkouts will complain
  about LF→CRLF on save. Ignore the warnings.

## Deploy

- **Main (43.153.139.136:3003):** SCP → `pm2 stop && pm2 delete windsurf-api && fuser -k 3003/tcp && sleep 2 && pm2 start`.
- **US (154.40.36.22:8996):** `python deploy-us.py` — paramiko-based, does the full
  stop/kill/start cycle and tails health. Don't use raw `pm2 restart` — it leaves
  zombie Node processes holding the port.

Windows has no `sshpass`; if you need to SSH, use Python + paramiko inline.

## Known gotchas

1. **Free tier** only serves `gpt-4o-mini` and `gemini-2.5-flash` — all Claude and
   premium models return `permission_denied`. Hardcoded in `MODEL_TIER_ACCESS.free`.
2. **Workspace wipe on startup** — `src/index.js` runs `rm -rf /tmp/windsurf-workspace/*`
   before the LS starts. If you skip this, files created by Cascade's baked-in
   file-editing tools persist across restarts and the model starts narrating
   "edits" to files the caller never mentioned.
3. **`responseText` vs `modifiedText`:** while streaming, prefer `responseText`
   (append-only). Only top up with `modifiedText` at idle if it's a strict prefix
   extension of `responseText`. See the big comment block in `client.js` around
   the cascade polling loop.
4. **Firebase API key** for Windsurf auth is `AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY`
   (extracted from `https://windsurf.com/_next/static/chunks/46097-*.js`). Three
   other keys have been tried and confirmed to NOT work — do not rotate to them.
5. **Reference repo** at `windsurf-api/` (untracked) is a TypeScript sibling project
   with decompiled `.proto` files under `windsurf-api/protos/` — handy when you
   need to confirm a protobuf field number without dumping the binary yourself.
