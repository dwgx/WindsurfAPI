# Maintainer Notes

These notes capture project operating rules that should survive context
resets. They are not release notes.

## Evidence Rules

- Do not claim support from names, guesses, or encode/decode round trips. For
  protocol work, require descriptor evidence, LS binary field evidence, or a
  real redacted trace.
- Do not widen production defaults from a single lab success. First add gated
  smoke, logs, docs, and a rollback path.
- Keep unsupported boundaries explicit. If a tool, model, media input, or
  backend cannot be bridged safely, return a clear error instead of pretending
  it is OpenAI-compatible.
- When an issue is broad, keep it as a reproduction bucket and require logs.
  Do not close it because a related bug was fixed elsewhere.

## Issue Reply Style

- Lead with status: fixed in a specific commit/version, waiting for reporter
  reproduction, upstream-limited, duplicate, or tracked elsewhere.
- Name the affected path precisely: client, route, model, native bridge mode,
  WebSearch/WebFetch path, LS binary source, dashboard API, or release script.
- For tool and degraded-model reports, ask for this fixed evidence set:
  version/commit, client name/version, route, exact model, tool names/schema
  count, redacted `Probe[...]`, `ToolRoute[...]`, `BridgeResult[...]`, and the
  nearby stream/error lines.
- For LS install/update reports, ask for OS/arch, `install-ls.sh` output, asset
  URL selected, `WINDSURFAPI_LS_RELEASE` if set, file size/hash when available,
  and whether the target binary was live/in use.
- If the reporter writes in Chinese, Vietnamese, or another language already
  used in the issue, reply in that language when practical. Keep technical
  identifiers unchanged.
- Avoid declaring a broad issue fixed from a narrow patch. Say which subpath was
  fixed and leave the bucket open until the original client flow is retested.

## Label Rules

- Type labels describe the work surface: `bug`, `enhancement`,
  `documentation`, `maintenance`, `release`, `security`, `privacy`.
- State labels describe workflow outcome: `needs-triage`, `question`, `fixed`,
  `duplicate`, `invalid`, `wontfix`, `not a bug`.
- Source labels describe ownership: `upstream` for Windsurf, Devin, provider,
  LS binary source, or third-party release behavior outside this repo.
- Community labels (`help wanted`, `good first issue`) require concrete scope
  and acceptance criteria first.
- Use `question` when the next action is reporter data or maintainer smoke in a
  specific environment. Do not leave broad evidence-free bugs as plain `bug`.
- Use `fixed` only when a patch/release exists. For partial fixes, state the
  fixed subcase in the issue comment and keep other labels such as `question`
  if reporter confirmation is still needed.
- Avoid using undefined catch-all labels. If a label has no repeatable triage
  meaning, document it or retire it.

## Native Bridge Rules

- Production default native bridge scope is the Bash family only:
  `Bash`, `shell_command`, and `run_command`.
- `Read`, `Grep`, `Glob`, `WebSearch`, and `WebFetch` are protocol-lab tools
  until real traces confirm argument shape, result shape, and execution
  boundary.
- `WINDSURFAPI_NATIVE_TOOL_BRIDGE=all_mapped` is not a generic fix for "tools
  not called". Use it only with explicit API key, account, model, and tool
  gates.
- Native bridge executes in the remote Windsurf workspace. Do not describe it
  as local IDE/MCP/client tool execution.
- Keep raw proto traces redacted by default. Raw string trace switches are for
  gated lab runs only.

## SWE / Special-Agent Rules

- SWE-1.6 and SWE-1.6-fast are special-agent work unless a real official trace
  proves direct Cascade chat support.
- Do not mix SWE-1.6 with ordinary cloud catalog fixes.
- Devin/ACP backends must be default-off, bounded, and text-only first.
- Client-local tools and media must be rejected or explicitly bridged; never
  silently execute them in a different workspace.

## WebSearch / WebFetch Rules

- Direct `GetWebSearchResults` is confirmed for WebSearch investigation.
- No direct WebFetch/read-url API is confirmed. Do not implement one from a
  guessed method name.
- The observed WebFetch path is LS requested interaction plus
  `HandleCascadeUserInteraction`, then a later trajectory step.
- Do not bypass production VPS memory guards just to force a WebFetch canary.
  Use an isolated memory-safe lab environment.

## Release Rules

- For code releases, update `package.json`, add release notes, run the focused
  tests, run `npm run test:release`, run `npm run secret-scan`, and run full
  shards when the blast radius is not trivial.
- After tag push, verify GitHub CI, Release, Docker build, and deployed VPS
  smoke before calling the release done.
- VPS smoke should include `/health?verbose=1`, Docker image labels, `/v1/models`,
  and one basic chat completion.
- Verify the actual WindsurfAPI entrypoint before judging VPS health. In the
  current VPS deployment the compose nginx entry is on `:3003`; public port 80
  may be served by another stack and is not a WindsurfAPI health signal.
- `/health` build metadata matters. If commit is missing, fix build metadata
  injection instead of relying only on image labels.

## Security And Privacy Rules

- Never write raw API keys, passwords, account credentials, session tokens, or
  customer email lists into docs, release notes, issue comments, or logs.
- Use hashes, counts, IDs, and redacted previews for diagnostics.
- Run secret scan before release and before pushing documentation that touched
  examples or operational notes.

## Code And UI Rules

- Prefer existing local helpers and patterns. Avoid new dependencies unless the
  maintenance tradeoff is clearly worth it.
- Keep patches scoped. Do not mix protocol reverse engineering, dashboard UI,
  release workflow, and unrelated cleanup in one release unless there is a real
  dependency.
- Dashboard UI should stay operational and dense: pagination, summaries,
  compact tables, predictable controls, and no marketing-style layout.
- Dashboard interactions should use existing app confirmation/prompt patterns,
  not native browser alerts.
- Do not revert unrelated user or generated changes in the worktree.
- After merging an external PR, update contributor surfaces in the same
  maintenance pass: `src/dashboard/data/contributors.json`, `README.md`, and
  `README.en.md`. The static `docs/index.html` contributor section is a separate
  curated homepage surface; update it only when intentionally refreshing that
  page layout.
