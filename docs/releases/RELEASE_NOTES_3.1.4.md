# v3.1.4 — Self-update restart, in-flight leak, fire lifecycle, safer update.sh

2026-07-10 (UTC+9)

A hardening release from a full adversarial review of the v3.1.0→v3.1.3 work.
Every fix landed test-first (a failing regression test first, then the change),
and the whole set was independently re-reviewed for release-blocking regressions
before shipping. Full suite green (2504), i18n green.

## Fixed

- **Self-update would stop the service on systemd.** After a successful dashboard
  self-update the process did `process.exit(0)`, whose comment assumed PM2
  autorestart. On a `systemd Restart=on-failure` host (e.g. homecloud) exit 0 is
  a *success* and systemd does **not** relaunch — so "Update" bricked the service
  until a manual restart. The self-update path now exits with a non-zero
  restart-requested code (75 / EX_TEMPFAIL) so systemd `Restart=on-failure` **and**
  PM2 autorestart both relaunch. Normal SIGINT/SIGTERM shutdown keeps its separate
  `exit(0)` path in `index.js` (unchanged). Only fires when the update actually
  changed the commit, so no restart loop.
- **In-flight slot leak on mid-request re-login.** `chat.js` released the account
  by its mutable `apiKey` (`releaseAccount(acct.apiKey)`) in two attempt paths. A
  background re-login rekeys `apiKey` in place, so releasing by the stale key
  leaked the in-flight slot forever (the same class as REF-1/#165). Both paths now
  release by the immutable `releaseAccountById(acct.id)`, matching the already-correct
  finalize path. Regression tests drive the real non-stream and stream handlers
  through an in-place rekey and assert the slot returns to 0.
- **WebGL pool fire didn't recover after leaving the overview, and a late poll
  could remount hidden fires.** Returning to the overview hit the `_poolSig`
  short-circuit and never re-mounted the fire; an in-flight overview request that
  resolved after navigating away could mount WebGL contexts on a hidden panel.
  `_teardownFires()` now invalidates `_poolSig`, removes the canvases, and restores
  the emoji fallback; `navigate()`/`loadOverview()` carry an overview-load
  generation + active-panel guard so a stale async load can't remount. Verified via
  CDP: 5 saturated rows → 3 contexts; leave → 0; return → 3; late render while on
  another panel → 0.
- **Trend chart could still clip a pure-nice double peak.** niceMax + padding
  didn't fully cover data like `[0,100,100,0]` (peak on the top row, Catmull-Rom
  overshoot above it) or a 100% success-rate plateau. The trend spline now clamps
  its bezier control points to the plot bounds (`_smoothPath`/`_trendSample` take an
  optional `yBounds`, passed only by the overview trend); the main stats chart is
  unchanged (default `null`).

## Changed

- **Docker image defaults `DEVIN_CONNECT=1`.** v3.1.1 set it in docker-compose, but
  a bare `docker run` / K8s pod running the image directly still fell back to
  Cascade+emulation (#210). The Dockerfile now also sets `ENV DEVIN_CONNECT=1`.
  Overridable: `docker run -e DEVIN_CONNECT=0`, compose env, and K8s env all win
  over the image default.
- **`update.sh` no longer hard-resets on any pull failure.** It used to
  `git reset --hard` whenever `pull --ff-only` failed, discarding local changes/
  commits. Now a dirty tree or local-ahead commits **fail closed** (asks you to
  review first); a destructive reset requires `WINDSURFAPI_UPDATE_FORCE_RESET=1`,
  which stashes (`--include-untracked`) before resetting. Clean deploys still
  fast-forward normally (runtime files are gitignored, so they don't trip it).

## Ops notes

- If your systemd monitoring alerts on "main process exited non-zero", a dashboard
  self-update now exits 75 once per successful update — add `SuccessExitStatus=75`
  to the unit to silence it. (The repo ships no systemd unit; this is deployment-side.)
- `update.sh` is stricter than the dashboard updater (bare `git status --porcelain`
  vs `-uno`): an untracked, non-ignored stray file makes it fail closed by design —
  review it or set `WINDSURFAPI_UPDATE_FORCE_RESET=1`.

## Notes

- Verified: full suite green (2504/0, +10 new regression tests), i18n green,
  `bash -n update.sh` clean, fire lifecycle + trend clamp verified via CDP.
