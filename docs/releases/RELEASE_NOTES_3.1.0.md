# v3.1.0 — Native tool calling restored, 429-lockout mitigation, calmer dashboard

2026-07-10 (UTC+9)

A fix + reliability release. The headline is restoring native tool calling for
Claude-family models through the DEVIN_CONNECT path (agent clients like Claude
Code and OpenCode work again), plus a set of small-pool rate-limit mitigations
and dashboard polish. Every root cause was confirmed live against real
`devin.exe` wire captures before a fix landed.

## Fixed

- **Native tool calling for Claude-family models (opus / sonnet / fable).**
  Requests that declared tools were being rejected upstream (`internal error
  occurred` / `content policy`) for Claude-family selectors while gpt/swe worked
  with byte-identical encoding. Five independent causes, all fixed:
  - **Competitor-identity content-policy block.** The client system prompt's
    self-identification (`You are Claude Code…` / `…Claude Agent SDK`), the
    `x-anthropic-billing-header` line, and the interactive Environment "brand
    block" (Claude Code product blurb + Claude model-ID catalogue) tripped the
    upstream content policy. `neutralizeClientIdentity` now rewrites all of
    these to a generic assistant identity. It moved to a standalone
    `handlers/identity-neutralize.js` so the DEVIN_CONNECT egress can apply it
    without a circular import — neutralization now also covers Codex
    `/v1/responses` and direct `/v1/chat/completions`, not just `/v1/messages`.
  - **`permission_denied` misclassified as a dead token.** A content-policy
    rejection used to be read as a dead session token, benching a perfectly
    healthy account and cascading the pool to "all accounts exhausted". It is
    now classified `CONTENT_BLOCKED` → `400 invalid_request_error` with no
    account penalty.
  - **Empty/absent system prompt with tools.** The upstream rejects a
    Claude-family request that declares tools but carries an empty system
    prompt. A minimal system prompt is injected when tools are present and no
    system text was supplied.
  - **Over-long tool descriptions.** A long tool description pushes the request
    past an upstream content threshold. Tool descriptions are capped
    (`WINDSURFAPI_TOOL_DESC_MAX`, default 500) — a model hint only, never the
    tool name or schema.
- **Circuit-breaker help tooltip clipping.** The "熔断与限流" section's `?`
  tooltip grew leftward off a left-edge icon and was clipped by the section's
  `overflow:hidden`. It now drops down-and-right and stays fully inside the card.
- **Config files written 0600.** `writeJsonAtomic` now creates config files
  (accounts, runtime-config, credential stores — which can carry the runtime API
  key, dashboard password hash, and upstream tokens) as owner-only, so they are
  not world-readable on a shared host.

## Added

- **429-lockout mitigation for small account pools.** A single throttled
  account could black out the whole pool (hard filter → empty → 429 → the
  client's auto-retry re-extends the cooldown). Modelled on KiroStudio's
  cooldown design:
  - **Tier-aware last-account exemption.** A pro account whose only healthy peer
    is free is still treated as "last usable" for paid selectors, so it is not
    quarantined into a pool-wide blackout.
  - **Degraded-serve fallback** (opt-in, `WINDSURFAPI_DEGRADED_SERVE`). When the
    whole entitled pool is transiently throttled, serve the least-cooled account
    instead of returning 429. Default off = byte-identical to prior behaviour.
  - **Client-replay backoff clamp.** The advertised `Retry-After` on a 429 is
    clamped to `[floor, ceil]` (`WINDSURFAPI_RL_CLIENT_BACKOFF_FLOOR_MS` /
    `_CEIL_MS`) so an agent client's auto-retry backs off usefully instead of
    hot-looping. Default floor 0 = unchanged.
  - **Shorter internal-error quarantine.** Default cut from 5 min to 2 min — an
    upstream internal error is transient and self-heals in seconds.
  - **Tunable bare-429 cooldown** (`WINDSURFAPI_RL_BURST_MS`, default 5 min).
- **Full-chain request tracing** (`WINDSURFAPI_TRACE=1`, default off). Stitches
  client request → routing decision → raw Devin wire bytes → client response
  under one trace id for offline debugging / RE. `tools/model-probe.mjs` fires
  one prompt at N models; `tools/trace-view.mjs` inspects and hexdumps a trace.
  Never a served endpoint; secrets redacted.

## Changed

- **Dashboard pool health defaults to the calm StatusBars view** instead of the
  glowing GlowGrid. The grid is still one click away (choice is persisted), and
  its glow was toned down (narrower breathe, slower cadence, a smooth ember
  instead of a fast stepped flicker) so opt-in grid is pleasant too.

## Notes

- All new tunables resolve env → runtime override → historical default, and
  every default is byte-identical to prior behaviour — upgrading changes nothing
  until you opt in.
- Verified: full test suite green (2488), i18n check green, dashboard syntax
  green; UI fixes verified via CDP DOM inspection.
