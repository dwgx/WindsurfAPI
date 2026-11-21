# WindsurfAPI roadmap

Updated 2026-11-21 after the v3.2.11 release. The annotated tag resolves to
`3f8d88a0475c`. This release passed its hosted build and verification workflow.
The public history page is live. [Release notes](releases/RELEASE_NOTES_3.2.11.md) · [Release workflow](https://github.com/dwgx/WindsurfAPI/actions/runs/44899513802) · [Project history](https://dwgx.github.io/WindsurfAPI/HISTORY-LEDGER-VIZ.html#history)

## What has been verified

- **Clients.** OpenCode 1.19.6 completed an ACP prompt through the gateway. Codex CLI 0.169.0 and its app server used the Responses endpoint for text, a namespaced client-owned MCP tool round trip, continuation and cancellation. Both checks used real client executables and a simulated model upstream. The signed Devin CLI also completed ACP initialization. [OpenCode setup](README.md#use-opencode-as-an-acp-agent)
- **Release identity and operations.** The Windows package exposes its build commit in `/health`. An operator can check the active account count, cache hits and eligible lookups separately from the provider billing health. No per-turn cost follows from the local cache counter. [Release signing](RELEASE-SIGNING.md) · [Connect admission tests](../test/connect-drought-free-selection.test.js)
- **Account import.** v3.2.11 repairs email/session-token pairs and reports skipped rows in both dashboard skins. Existing add and login routes can perform work. A side-effect-free preview needs an explicit preview path. [Import tests](../test/dashboard-import-text-token-pair.test.js)

## Next increments

The private ACP v1 client ends initialization if the agent selects an
unsupported, missing or invalid protocol version. An inert agent selecting v1
proceeds through authentication, session creation and the prompt.
[ACP v1 negotiation](https://agentclientprotocol.com/protocol/v1/initialization#version-negotiation)

Both private import dashboards preserve a generic success label for earlier
servers' successful rows with a missing or unrecognized account outcome.
When the server omits the input position, the dashboards display a dash.
[Legacy import coverage](../test/dashboard-import-outcomes.test.js)

The follow-up branch has a one-shot signed source selector and dedicated
side-effect-free account preview routes. Its import fixtures cover mixed
JSON, repeated imports and unsupported entries with user-visible positions.
Its updater fixtures cover verification, local edits and rollback before
and after service stop. These features await a future release. [Source upgrade
verification](RELEASE-SIGNING.md) · [Import preview tests](../test/dashboard-import-text-token-pair.test.js)

| Work | Acceptance |
| --- | --- |
| Explicit signed source upgrades | Stage the operator's elected tag, check its annotated ref, exact signing workflow, commit, tree and ancestry, and preserve operator changes through rollback. Old installations use the [signed staged migration](releases/RELEASE_NOTES_3.2.11.md#signed-upgrade). |
| Import feedback | Preview mixed text and JSON without login or storage writes. Show added, already present, login-only and unsupported entries accurately, with positions and no credential material. Verify both dashboard skins. |
| Protocol and client coverage | Keep the observed Codex namespaced call and matching result ID in a repeatable Responses fixture. The three inspected production emitters send complete tool names. Fragmented shared-prefix names stay in the compatibility queue pending an observable production path. Check the Homeworking Toolkit wrapper separately if it changes the client interaction. |
| Operator view | Show cache numerator and denominator, distinguish an empty sample from measured zero hits, and show account availability, quota period and billing-source freshness independently. Evaluate the prototype with operator feedback before enabling a new dashboard view. |
| Enterprise Cascade | [#245](https://github.com/dwgx/WindsurfAPI/issues/245) remains open. For one failing turn, record gateway and Claude Code versions, route/model, reuse outcome, tool counts, whether output began, and the final error category. Where available include the raw tier enum and mapped tier. Compare fresh sessions with default system hashing and same-caller fallback disabled. Omit account identifiers, session IDs, credentials and request text. |
| Billing and remaining reports | Per-turn ACU attribution in [#239](https://github.com/dwgx/WindsurfAPI/issues/239) needs provider evidence for the same turn. For [#236](https://github.com/dwgx/WindsurfAPI/issues/236), compare the same harmless tool round trip directly and through the reported client chain. [#250](https://github.com/dwgx/WindsurfAPI/issues/250) and [#273](https://github.com/dwgx/WindsurfAPI/issues/273) need evidence of the reported channel or ordering boundary before changing default protocol behavior. |

Use the [contributing guide](../CONTRIBUTING.md) for verification. Record the
observed revision and keep measured client effects distinct from provider billing.
