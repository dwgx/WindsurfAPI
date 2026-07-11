# v3.2.3 — Model-catalog live-sync + external-audit fixes

2026-07-12 (UTC+9)

Two independent tracks land here: a cross-project model-resolution study (with
the KiroStudio AI) that fixed a real "valid model wrongly rejected" bug, and two
fixes from an external code audit that confirmed the project has no severe bugs
and found only two PLAUSIBLE-severity flaws. Full suite green (2543), i18n green.

## Fixed — model resolution

- **DEVIN_CONNECT selector catalog now live-syncs from upstream.** Root cause:
  `fetchAndMergeModelCatalog` only merged the live upstream catalog into `MODELS`
  (the Cascade namespace); it never touched `CATALOG_SELECTORS` (the frozen
  DEVIN_CONNECT snapshot). So the Cascade path self-healed while the DEVIN_CONNECT
  path used a point-in-time 105-model snapshot — and selectors the upstream added
  later (`qwen-3`, `glm-5`, `kimi-k2.5`, `deepseek-v3`, `minimax-*` — all present
  in a live account's `availableModels`, verified 2026-07-12) were absent, so a
  strict-mode request for one got **400'd as "not a valid model" despite being
  genuinely runnable**. Fix: a runtime live selector set (`_liveSelectors`),
  refreshed from `GetCliModelConfigs` (`fetchCatalog`) on catalog sync;
  `resolveConnectSelector`'s existence check is now `snapshot ∪ live`. The snapshot
  degrades to a cold-start fallback + drift-test baseline — the single-source-of-
  truth principle converged on cross-project. The resolver stays pure (the live
  set is injected via `setLiveCatalogSelectors`, not read from account state); a
  connect-catalog sync failure is isolated and never fails the Cascade merge.

## Fixed — external audit

- **Idle-timeout and absolute-deadline no longer share a retry code.** Both the
  120s idle timeout and the 600s absolute wall-clock deadline threw
  `code: 'TIMEOUT'`, and `TIMEOUT` is in `RETRYABLE_CODES` — so an absolute
  deadline (upstream hung the full window) was replayed once on the same token,
  running another full idle+deadline cycle against the same stuck upstream
  (≈2× wall-clock, ~1200s to finally error), almost always failing again. The
  deadline now throws a distinct `DEADLINE_EXCEEDED` code that is **not** in
  `RETRYABLE_CODES`, so it surfaces immediately (504, same client surface as
  `TIMEOUT`). Idle timeout still replays (a genuine transient stall). Account
  penalty behaviour is unchanged (parity with the prior `TIMEOUT` handling).
- **`createCaptureRes.write()` skips work after client disconnect.** The Anthropic
  translator's fake response kept running `translator.feed(chunk)` on chunks that
  trickled in between a client disconnect and the upstream abort landing — wasted
  CPU on a translator about to be discarded. `_clientDisconnected()` deliberately
  does not set `writableEnded` (so chat.js takes the abort path), so a new
  independent `_disconnected` flag now short-circuits `write()` without touching
  that semantic. Non-critical; efficiency/cleanliness.

## Notes

- The external audit (KiroStudio's AI, using WindsurfAPI as a control group)
  verified 7 high-risk areas and confirmed 5 were already correctly defended —
  disconnect propagation, pool release, SSE registry, upstream cancellation,
  reservation accounting. Its verdict: "high-quality project, no severe bugs."
- Neither fix here addresses upstream flakiness: `claude-opus-4-7-medium` has
  been observed returning probabilistic `internal error` (a `permission_denied`
  shell), which on a single-account pool exhausts failover and surfaces to Claude
  Code as "529 Overloaded". The gateway classifies it correctly (account
  `errorCount` stays 0, transient guard holds) but cannot self-heal it — the
  remedy is a larger account pool or a steadier model (`claude-opus-4-8-*`).
