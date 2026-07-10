# v3.1.2 — Self-update fix, trend-chart clipping fix, WebGL pool fire

2026-07-10 (UTC+9)

A small fix + polish release: the dashboard Update button works again, the
request-trend chart no longer clips its peak, and saturated accounts now burn a
real WebGL flame in the pool-health view.

## Fixed

- **Dashboard "Check Update" printed `✗ Invalid JSON`.** An empty-body dashboard
  POST (`App.api('POST', path)` with no payload → `Content-Length: 0`) hit
  `JSON.parse('')`, which throws, and the route surfaced it as `Invalid JSON`.
  The Update button (`POST /self-update`) sends no body, so it always failed.
  Empty bodies are now treated as `{}`. This fixes every no-payload dashboard
  POST (self-update, probe-all, langserver restart, …). Route-level regression
  test added.
  **Post-release correction:** a follow-up fix uses a non-zero restart-requested
  exit status so both systemd `Restart=on-failure` and PM2 `autorestart` relaunch
  after a source update; ordinary SIGINT/SIGTERM shutdown remains successful.
- **Request-trend chart clipped its peak (`最高点的线超出图外`).** The smoothed
  (Catmull-Rom) request line overshoots above a peak when both neighbours are
  lower; the peak data point sat on the very top row (12px padding), so the
  overshoot drew above the canvas. The left-axis max is now rounded up to a
  "nice" number (`niceMax`, e.g. 74 → 100) and the top padding is larger, giving
  the overshoot headroom. Axis labels also come out cleaner (80/4=20 not 74/4).

## Added

- **WebGL fire on saturated pool rows (ported from KiroStudio FireCanvas).** In
  the StatusBars pool-health view, an account that is RPM-saturated now burns a
  real flame across its row: a WebGL2 three-pass pipeline (flame sim → gaussian
  blur → glow composite) with 7-stop intensity coloring — the harder the account
  is working (RPM / inflight), the hotter the color (cyan → green → gold →
  orange → violet → ice-white → ruby-red at full tilt).
  - **Scales to hundreds of accounts:** the flame is mounted *only* on saturated
    (`.hot`) rows — usually 1-2 at a time — so there are never more than a couple
    of live WebGL contexts. Unmounting (or switching to the grid view) force-loses
    the context, so contexts never leak. Verified via `tools/verify-fire.mjs`
    (CDP): fires dispose to 0 on view switch, contexts stay alive while mounted.
  - **Graceful fallback:** no WebGL2 (or `prefers-reduced-motion`) → the row keeps
    its existing emoji / CSS-glow highlight.

## Notes

- Verified: full test suite green (2494), i18n check green, dashboard syntax
  green; fire + trend verified via CDP DOM inspection + screenshot.
