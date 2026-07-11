# v3.2.0 — Statistics dashboard overhaul

2026-07-11 (UTC+9)

A feature release focused on the statistics dashboard: it closes a real
data-collection gap, adds a per-model dimension to the time series, enriches the
rankings, and fixes two chart-rendering bugs found by an adversarial pre-commit
review. Every change was verified against a real headless-Chrome render via CDP,
and the whole batch passed a multi-reviewer adversarial pass before commit. Full
suite green (2531), i18n green.

## Added — statistics

- **Token usage breakdown now populates on DEVIN_CONNECT deployments.** The
  dashboard's fresh-input / cache-read / cache-write / output breakdown had been
  fed only from the Cascade paths, so a connect-only deployment (e.g. homecloud)
  showed all-zero token totals despite hundreds of requests. `recordTokenUsage`
  is now fed from the DEVIN_CONNECT request path too — the non-stream choke point
  plus all three streaming sites (primary, transient-replay, re-login-replay).
  Safe no-op when a turn carries no usage.
- **Request time series shows which models were requested.** Hovering an hour in
  the request-volume chart now lists the top models used in that hour (aggregated
  client-side from the recent-requests ring buffer — no backend change).
- **Rankings gained dimensions.** The overview leaderboard rows now carry a
  second line: a success-rate dot (green / amber / red), lifetime credits, and
  p95 latency — so it answers "which model, how reliable, how expensive, how
  fast", not just raw request count.
- **Credits are readable.** The credits total compacts large numbers with a `k`
  suffix (e.g. `41.2k`) and keeps the exact value in a hover tooltip. No USD
  conversion — Windsurf retired the credit system (2026-03 → quota tiers), so
  there is no authoritative credit→$ rate; credits stay an internal accounting
  unit.
- **Cache-efficiency indicator.** The token card shows what share of input was
  served from cache (a real credit-saving signal), filling what was previously
  dead whitespace.

## Fixed — chart rendering

- **High-error bars no longer render gray.** The bar color mixed brand-blue →
  amber → red linearly by error ratio, which passed through a dead gray (~#a09f9a)
  around an 18% error rate — a high-error hour looked *disabled*, not *errored*.
  Bars now use discrete semantic buckets (healthy blue / warning amber / high-error
  red), matching the rankings dots and the model table's red/green.
- **Trend error line no longer dives off-canvas (regression fix).** The new
  converged Y-axis (which lifts the floor for steady high-volume data so small
  variation stays visible) mapped the low-magnitude error overlay below the plot,
  silently hiding real errors. Anchor points are now clamped to the plot band, so
  a sub-floor error series sits truthfully on the baseline instead of vanishing.
  Spiky/low data keeps its zero baseline unchanged.

## Fixed — tooling

- **check-i18n gate #8 no longer false-positives on JS expression fragments.** A
  nested-`${}` template (inline IIFE) could leak arithmetic/member-access
  fragments into the hardcoded-English scan. The scanner now skips
  operator/paren arithmetic, optional chaining, method calls, and code-shaped
  member access — while tightening the member-access guard so it does **not**
  skip real English copy that contains a dot (`v2.0 released`, `95.5% done` still
  flag correctly).

## Housekeeping

- Repo reorg: all AI / handoff / dev notes moved under a git-ignored
  `docs-internal/` (root keeps only `README*.md`, `LICENSE`, `CONTRIBUTING.md`,
  `SECURITY.md`, `CLAUDE.md`); source/script comment path references synced.

## Verification

- `npm test` → **2531/0** (+B1 token-wiring tests over v3.1.5).
- `node src/dashboard/check-i18n.js` green (new copy double-written en/zh).
- CDP against real headless Chrome: token breakdown populates, credits compact +
  tooltip, rankings sublines with colored dots, per-model hover, converged-Y trend
  with error line on-plot, high-error bars red (chroma-asserted, no gray).
- Adversarial multi-reviewer pre-commit pass: 1 real regression (error line) + 3
  edge findings caught and fixed before commit.
