# WindsurfAPI Maintainer Status

Last updated: 2026-06-07.

This is the first file to read before maintenance work. It summarizes the
current state, what is still open, what not to claim, and where the supporting
docs live. Do not paste secrets, account credentials, API keys, or raw session
tokens into this file.

## Current State

- Repository: `D:\Project\WindsurfAPI`
- Local/remote branch state at last status update: `master` is clean and aligned with
  `origin/master`.
- Last verified repository baseline before this status update: `562f98c`
  (`docs: update handoff for v2.0.144`). After pulling, use
  `git log -1 --oneline` for the newest commit.
- Latest release tag: `v2.0.144` at `3945c51`
  (`fix: surface completed native WebFetch documents (#183)`).
- GitHub open PRs: none.
- GitHub CI/Pages for `562f98c`: success.
- GitHub Release workflow for `v2.0.144` / `3945c51`: success.
- VPS runtime: WindsurfAPI is healthy on release `v2.0.142`, commit
  `72e1b9cf079e`, through the compose entry on `:3003`. v2.0.144 is
  tagged, pushed, and verified in a memory-safe lab, but not yet deployed to
  the production VPS.
- VPS public port 80 is not a WindsurfAPI health signal in the current setup; it
  may be served by another Apache/PHP stack and can show an HTML 404 page.

## Important Entrypoints

- Main docs index: [docs/README.md](README.md)
- Persistent working rules: [docs/MAINTAINER_NOTES.md](MAINTAINER_NOTES.md)
- Current issue audit: [docs/audits/AUDIT_2026-06-07.md](audits/AUDIT_2026-06-07.md)
- Native bridge protocol notes:
  [docs/native-bridge-protocol-notes.md](native-bridge-protocol-notes.md)
- Release notes: [docs/releases/](releases/)

## Current Open Issues

| Issue | Status | Next action |
| --- | --- | --- |
| #177 | Broad degraded-model / tool-failure bucket. Keep open. | Require client, route, model, tool names/count, `ToolRoute[...]`, and `Probe[...]` logs before making new claims. |
| #178 | "No tools get called" bucket. Keep open. | Use `ToolRoute[...]` and `Probe[...]` to distinguish stripped tools, native gate misses, compacted preambles, and model narration. |
| #183 | WebSearch/WebFetch user-input loss/repetition. Keep open for retest. | v2.0.144 fixes completed native WebFetch document handling in lab-gated mode; next step is controlled deployment/retest and issue response. |
| #185 | Cursor truncation / stray JSON. Keep open for reporter retest. | v2.0.142 fixed post-content error JSON tails, but upstream provider deadlines can still truncate long streams. |
| #186 | Gemini / DeepSeek wishlist plus SWE mention. Keep open. | Treat Gemini/DeepSeek as upstream catalog watch. SWE is tracked in #190. |
| #190 | SWE-1.6 / SWE-1.6-fast. Keep open. | Build special-agent / Devin / ACP POC; do not treat this as ordinary Cascade catalog support. |
| #169 | Dashboard card/view mode enhancement. Keep open, lower priority. | Needs concrete UX definition before implementation. |

Closed recently and not currently the main thread: #191, #189, #176, #180,
#187, #170, #168, and #164. Do not reopen them without a new concrete repro.

## Priority Order

1. Stabilize evidence collection for #177/#178/#185. Current code already has
   better diagnostics; the next step is real reporter logs or reproducible
   local smokes, not broad default changes.
2. Advance SWE-1.6 through the special-agent path:
   - default off,
   - text-only first,
   - no silent client-local tool execution,
   - bounded process/output limits,
   - negative smoke for tools/media.
3. Continue WebSearch/WebFetch trace work:
   - direct WebSearch API is confirmed,
   - direct WebFetch/read-url endpoint is not confirmed,
   - official WebFetch appears to require LS requested interaction plus
     `HandleCascadeUserInteraction`,
   - v2.0.144 verified that completed `read_url_content.web_document` payloads
     can arrive together with a requested-interaction echo,
   - success requires surfacing Cascade's final answer or the completed
     document payload, not returning the completed step as a dead tool-call
     proposal.
4. Keep Read/Grep/Glob/WebSearch/WebFetch out of the default native bridge
   allowlist until runtime traces prove arguments, results, and execution
   boundary.
5. Dashboard #169 after protocol/tool stability, unless the user explicitly
   reprioritizes UI work.

## Do Not Claim

- Do not claim SWE-1.6 works as a normal Cascade chat model.
- Do not claim WebFetch has a direct API endpoint.
- Do not claim WebSearch/WebFetch/Read/Grep/Glob are production native-bridge
  ready.
- Do not present `WINDSURFAPI_NATIVE_TOOL_BRIDGE=all_mapped` as a generic fix
  for "tools not called".
- Do not treat a protobuf encode/decode round trip as protocol support.
- Do not judge VPS health from public port 80.
- Do not print or persist account credentials, API keys, passwords, session
  tokens, or raw customer emails.

## Native Bridge Boundary

Production-mature native bridge scope is still only:

- `Bash`
- `shell_command`
- `run_command`

Everything else is protocol lab unless proven otherwise by trace and smoke.
Native bridge executes in the remote Windsurf workspace; it is not local
IDE/MCP/client tool execution.

## Release And Verification Routine

For code changes:

1. Update `package.json` version and release notes.
2. Run focused tests.
3. Run `npm run test:release`.
4. Run `npm run secret-scan`.
5. Run full shards for non-trivial blast radius.
6. Commit, tag, push, verify GitHub CI/Release/Docker, deploy VPS, and smoke
   `/health?verbose=1`, `/v1/models`, and one basic chat completion.

For docs-only changes:

1. Run `git diff --check`.
2. Run `npm run secret-scan`.
3. If new docs are untracked, scan them explicitly or stage before the default
   scan.
4. Push and verify CI/Pages.

## Useful Current Facts

- v2.0.141 added `ToolRoute[...]` diagnostics.
- v2.0.142 changed streamed partial-failure behavior: after real content has
  reached the client, the proxy closes with normal finish and `[DONE]` instead
  of appending an error JSON SSE frame.
- v2.0.142 does not eliminate upstream provider deadlines.
- v2.0.143 added `BridgeResult[...]` per-request diagnostics (stream +
  non-stream), WebFetch canary hard verdict in smoke, SWE-1.6 negative
  smoke (tools/media boundary), and /health bounded limits exposure.
- v2.0.143 wrapped HandleCascadeUserInteraction in try/catch with hash-based
  safe logging; approval failures no longer terminate polling.
- v2.0.144 fixes native WebFetch completed-document handling for lab-gated
  `read_url_content`: completed `web_document` steps are no longer surfaced as
  dead OpenAI tool-call proposals, and the proxy preserves Cascade's final
  assistant text or falls back to document text when needed.
- v2.0.144 also fixes proto-trace classification so steps containing both a
  completed `web_document` and requested-interaction echo are classified as
  `completed_web_document`.
- Lab verification for #183 proved the original memory guard was an environment
  blocker, not protocol evidence; on a memory-safe host, LS could fetch
  `example.com`, and the proxy-side completed-document surfacing bug was fixed.
- WebFetch VPS canary after v2.0.141 did not reach protocol execution because
  LS preflight refused with `ls_capacity:memory_guard`; that is not protocol
  evidence.
- The current docs intentionally keep issue audit, maintainer rules, release
  notes, and protocol notes separate so maintainers can update the right layer
  without rewriting everything.
