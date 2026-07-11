# v3.2.2 — Audit batch 4/5, account-pool reliability, Windows deploy

2026-07-12 (UTC+9)

The follow-on to the v3.2.1 audit-fix pass: the remaining green-lit audit items
(cache-key integrity, cross-file consistency, hot-path perf), the two red-line
account-pool fixes from batch 2 (landed test-first, wire behaviour still to be
confirmed by a homecloud trace), the sticky-session HIGH test-coverage gap, and
a zero-dependency Windows background-run script suite. Full suite green (2536),
i18n green.

## Fixed — correctness

- **#10 `logit_bias` cache-key normalization.** `logit_bias` is a token-id→bias
  map with no canonical key order; `JSON.stringify` preserves insertion order, so
  two structurally-identical maps with different key order hashed to different
  cache keys and missed each other (never wrong data — just a wasted slot and a
  halved hit rate). A key-sorted deep clone (`stableClone`) now normalizes it
  into the key.
- **Batch 2 #2/#3 — in-flight slot leak on pre-attempt abort.** In the
  DEVIN_CONNECT streaming failover loop, a client disconnect detected at the top
  of the loop broke out *after* an account was acquired but *before*
  `attemptStream` (→ `finalizeConnectAccount` → `releaseAccountById`) ran for it,
  leaking that account's in-flight slot until the acquire reservation aged out
  (≤15 min) and shrinking the usable pool under disconnect churn. The break now
  releases by id (no penalty, no `recordRequest` — an aborted, never-attempted
  request is neither a fault nor a completed request). *Wire behaviour still to be
  confirmed by a homecloud trace.*
- **Batch 2 #8 — `reportError` transient guard.** Both Cascade error handlers
  gated the account error-budget penalty as `if (isAuthFail) reportError(...)`,
  but the upstream sometimes wraps a transient stall / internal error / rate-limit
  in a 401/403 auth shell whose text also matches `isAuthFail`. The guard is now
  `isAuthFail && !isRateLimit && !isInternal && !isTransient`, byte-identical to
  the sibling ban-signal guard — so a transient blip can no longer demote a
  healthy account toward eviction. *Transients never reach `reportError`.*

## Changed — refactor / perf

- **S4 — single source of truth for the trusted client IP.** `caller-key.js` and
  `dashboard/api.js` each carried a byte-identical private copy of the
  X-Forwarded-For hop-counting logic, kept in sync only by a "MUST stay identical"
  comment. Extracted `trustedClientIp` / `trustedProxyHops` into `net-safety.js`
  (read live from env) and deleted both copies (−76 lines). This also fixes a
  latent drift: `caller-key.js` captured `TRUST_PROXY_X_FORWARDED_FOR` into a
  module-load `const` (a runtime flip had no effect there) while the dashboard
  read it live — both are live now.
- **S5 — `PathSanitizeStream` O(n²) → O(N).** `feed()` re-scanned the entire
  held-back buffer on every chunk, so a long sensitive path or a large
  `<workspace_*>` block streamed over many chunks cost O(N²). Resume cursors now
  walk only the fresh tail for the two unbounded-growth holds (20K chars streamed
  char-by-char: 12 ms). Output equivalence with one-shot `sanitizeText()` is
  pinned by an exhaustive oracle (every cut position + char-by-char worst case +
  fuzz + N=8000 scaling).

## Tests

- **sticky-session** (previously ZERO coverage, a HIGH-severity gap): bind / hit /
  miss, per-model isolation, empty-key rejection, sliding TTL expiry, single/all/
  prefix-safe clearing, LRU eviction, and the `stickyBindByUserOnly` experimental.
- **selectBackend double-call consistency** (chat.js:2151 vs :2779): pins the
  env-only `devin_connect` invariant so a `modelInfo` reassignment can't fork the
  two call sites.
- **XFF cross-file consistency** and **reportError transient guard** regressions
  for the two changes above; the in-flight entry-abort test was revert-verified to
  actually catch the leak.

## Removed

- **`devin-backend.js` fake-green tests.** The module has zero production imports,
  `selectBackend` never returns `DEVIN_REST`, and its write path throws — the two
  test files (423 lines) were inflating coverage on unreachable code. Tests
  removed; the module is kept as the DEVIN_REST roadmap stub with a status
  tombstone (re-add tests against the live route if/when it's wired in).

## Added

- **`deploy/windows/` — zero-dependency Windows background-run suite.**
  `schtasks /onlogon` + `wscript` hidden detached process for boot-time autostart
  with crash-loop backoff and self-update restart. 15 scripts (start / run / stop /
  status / restart / update / install-task / uninstall-task + README). Exit-code
  routing is 75 = restart (self-update) / 0 = graceful / 1 = crash-backoff (stop
  after 5), the opposite of KiroStudio's. First-run bootstrap idempotently writes a
  no-BOM `.env` with strong random keys, `HOST=127.0.0.1`, and `DEVIN_CONNECT=1`.
  `.ps1` files carry a UTF-8 BOM (PS 5.1 otherwise reads them as the local
  codepage); `.env` / `.bat` stay BOM-free. All `.ps1` parse-checked; the `.env`
  bootstrap was smoke-tested in a temp dir.

## Notes

- The two batch-2 fixes touch account-pool red lines and landed with unit tests
  over mocked wire responses; **no real account was fired.** Confirming the live
  wire behaviour (an aborted queued stream releases its slot; a wrapped-transient
  401 does not raise a healthy account's `errorCount`) is left to a homecloud
  trace.
- K4 (KiroStudio 429 suite) was investigated and found to be a matter of two
  already-existing conservative tunable defaults (`degradedServe`, `rlBurstMs`),
  not missing code — deliberately left unchanged this release for deployment
  stability. Set the env vars to opt into more aggressive self-healing.
