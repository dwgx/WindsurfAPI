# WindsurfAPI roadmap

Updated 2026-11-21. WindsurfAPI connects existing clients to Windsurf and Devin
through OpenAI-compatible, Anthropic-compatible and Gemini-compatible HTTP
interfaces. The next work should make those connections easier to verify and
operate. This page tracks current evidence and the checks needed to finish each
item.

### Evidence from the v3.2.11 release cycle

- Codex CLI 0.169.0 completed a streamed Responses request, invoked one local MCP echo tool, reused conversation history on a second turn, and cancelled a streaming turn. Six loopback HTTP requests reached six simulated upstream calls. The client used fallback model metadata for the selected fixture. The next integration question is whether the Homeworking Toolkit adds a different request or cancellation path.
- Source inspection found complete tool names at all three current production emitters. The compatibility queue retains the shared-prefix, split-name case until a production emitter or a sanitized real observation demonstrates that shape. The maintained Responses fixture covers the observed namespaced tool name and its matching result ID.
- The public history page serves all four data files from the published source. The operating view should report the cache hit numerator and denominator and display “no samples” when there have been zero eligible lookups. Billing-state freshness and account availability need independent indicators. A charge attributed to one turn still requires provider-side evidence for that turn.
- The Enterprise Cascade report remains open. One failing current-version turn with its reuse outcome, tier mapping, tool counts and terminal event would distinguish the outstanding hypotheses. The existing test for a zero raw teams tier mapped to `free` establishes how the diagnostic behaves. [Issue #245](https://github.com/dwgx/WindsurfAPI/issues/245)

| Work | Evidence today | Acceptance |
|---|---|---|
| Signed upgrades | The legacy Git-source updater sorts reachable stable tags by numeric SemVer. `v3.141.592661` takes precedence over `v3.2.11`. The 3.2 line uses explicit selection of a signed tag under the existing trust policy. | Verify the selected tag and running build on the staged install, preserve operator state, and exercise rollback. Any future automatic selection rule needs its own upgrade tests. [Upgrade instructions](releases/RELEASE_NOTES_3.2.11.md) |
| Real client coverage | OpenCode 1.19.6 exercised ACP initialization, session creation and a streamed prompt through WindsurfAPI with a simulated upstream. The next candidate is a Codex workflow in the Homeworking Toolkit. | Record client and gateway revisions and exercise a streamed response, a client-owned tool round trip, continuation and cancellation through the pinned client. Record simulated and authorized live upstream results separately. [OpenCode setup](README.md#use-opencode-as-an-acp-agent) |
| Account health and cost | Account and model health, response-cache behavior and provider billing each have different evidence. The Connect tests cover per-account zero-rate evidence and free-only retry admission. | Show why the executing account was eligible, record fallback and cache outcomes, and reconcile any charge claim with provider-side billing evidence from an authorized run. [Connect admission tests](../test/connect-drought-free-selection.test.js) · [Catalog tests](../test/connect-catalog-zero-free.test.js) |
| Account import | Regression fixtures cover email and session-token pairs and skipped-row counts in both dashboard skins. | Exercise mixed valid and invalid rows, duplicates, partial failure and retry using synthetic credentials. Show accurate per-row outcomes and confirm that visible diagnostics omit credential material. [Import tests](../test/dashboard-import-text-token-pair.test.js) |
| Enterprise Cascade | In issue #245 the reporter described context loss, missing tool calls and interrupted streams in Claude Code on Enterprise. A later comment proposes session reuse as an explanation. The report is open and the deployment-specific cause remains unverified. | Compare a fresh Claude Code session on the current gateway with and without opt-in same-caller fallback, using default system hashing. Capture sanitized reuse, tier, parsed-tool and terminal-stream evidence from the same failing turn. Confirm the outcome on an authorized Enterprise account. [Issue #245](https://github.com/dwgx/WindsurfAPI/issues/245) |
| Public project history | The Pages history view indexes a dated snapshot of public issue, pull request, release and Git metadata. Its coverage fields distinguish available snapshots from partial activity. | Keep the existing Pages entry point, show dates and coverage, and use public source links for published facts. Include only metadata verified against public sources. [Project history](HISTORY-LEDGER-VIZ.html#history) |

Update this page when a baseline changes or an acceptance check gains new
evidence. Keep release verification tied to the exact source and artifact.
