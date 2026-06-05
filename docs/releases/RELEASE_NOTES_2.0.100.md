## v2.0.100 — LSP admission + native bridge gray rollout

This release tightens the two risky surfaces we are actively working on:
multi-LSP scheduling and prompt-emulated tool calls.

### LSP scheduling

- Added structured LS admission snapshots for accounts: pool full, memory guard,
  pending start, resident instance, and would-start are now visible through the
  dashboard account list.
- `ensureLsForAccount()` now returns `{ ok, errorType, ... }` instead of hiding
  start failures behind logs only.
- Proxy updates no longer start an LS by default. Operators must opt in with
  request `warmup/prewarm=true` or `LS_PREWARM_ON_ACCOUNT_ADD=1`.
- Scheduled probes and predictive prewarm no longer compete with production
  traffic: they only reuse an already resident or pending LS and skip when a new
  spawn or eviction would be required.

### Native bridge

- Default native tool scope is now Read/Bash/Grep/Glob semantic families only:
  aliases such as `read_file`, `view_file`, `shell_command`, `run_command`,
  `grep_search_v2`, and `find` are included.
- WebSearch/WebFetch remain on prompt emulation by default. They can be enabled
  later with `WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS`, but are not part of this
  rollout.
- Added gray gates for model, provider, route, caller key, upstream account
  id/email, and caller API key.
- Hardened native `<function_calls>` parsing. Known calls map to OpenAI
  `tool_calls`; unknown, missing-mapping, and incomplete XML blocks are
  suppressed and never emitted as assistant content.

### Devin special-agent

- Devin ACP support is now a small experimental module (`src/devin-acp.js`),
  selected with `WINDSURFAPI_SPECIAL_AGENT_BACKEND=devin-cli` and
  `DEVIN_CLI_MODE=acp`.
- ACP authentication uses upstream Windsurf account-pool apiKeys. It is not a
  generic base_url/API-key client mode for Devin CLI.
- The default special-agent mode remains conservative `devin -p` print mode.

### Import parser

- Dashboard batch account import now accepts Chinese transcript-style lines such
  as `邮箱：user@example.com 密码：secret`, plus key/value variants.

### Tests

- Added/updated coverage for native bridge gray gates, account allowlist skips,
  XML non-leak behavior, Devin ACP runner auth/chunk handling, Chinese batch
  import parsing, and LSP probe/prewarm admission policy.
