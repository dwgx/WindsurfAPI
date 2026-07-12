# v3.2.4 — /v1/models discovery fix (v3.2.3 follow-up)

2026-07-12 (UTC+9)

A focused fix for a discovery regression surfaced while reviewing v3.2.3 for
Codex compatibility. Full suite green (2546), i18n green.

## Fixed

- **`/v1/models` now lists live-synced selectors.** v3.2.3 taught
  `resolveConnectSelector` to recognize selectors synced live from the upstream
  catalog (so `snapshot ∪ live` runs fine at `/v1/chat/completions`), but the
  `/v1/models` handler still filtered against the frozen `CATALOG_SELECTORS`
  snapshot only — and the 37 upstream-added selectors (`gpt-5-6-sol/terra/luna-*`,
  `grok-4-5-low/medium/high`, `nemotron-3-ultra-nvfp4`) aren't in the hardcoded
  `MODELS` table either. Net effect: those models **ran at chat (200) but were
  absent from `/v1/models`**, so discovery-based clients — Codex in particular,
  which enumerates `/v1/models` — couldn't find them (a manually-specified model
  name still worked). Fix:
  - `handleModels` existence check is now `snapshot ∪ live` (same source of truth
    as `resolveConnectSelector`).
  - `devin-connect-models` retains the full decoded live catalog rows
    (`_liveCatalog` + `getLiveCatalog()`), not just selector strings.
  - `handleModels` synthesizes `/v1/models` entries for live-only selectors that
    the `MODELS` table doesn't cover (deduped, tagged `_source: 'live_catalog'`,
    standard `{id, object, created, owned_by}` shape).

## Notes

- This is purely a discovery/listing fix; chat behaviour is unchanged (those
  models already ran). Non-DEVIN_CONNECT deployments are unaffected (full MODELS
  list, no synthesis).
- Surfaced during an external code audit that used WindsurfAPI as a control group
  and, comparing against a competing `dao-core` model registry, prompted a review
  of the `/v1/models` path — where this v3.2.3 follow-through gap was found.
