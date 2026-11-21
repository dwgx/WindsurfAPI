/**
 * Model name → DEVIN_CONNECT selector resolver.
 *
 * GetChatMessageRequest.model_selector (proto field #21) takes a STRING selector,
 * not the Cascade modelUid/enum. The full catalog was frame-captured from a live
 * GetCliModelConfigs response (see docs-internal/workflow-results/devin-protobuf/
 * model-catalog-CAPTURED.md and memory: devin-getchatmessage-wire-calibrated-
 * 2026-06-30). This maps the OpenAI-style model names a client sends onto the
 * verified upstream selectors.
 *
 * Free-tier (unpaid) accounts are entitled only to `swe-1-6-slow`; every other
 * selector returns "/upgrade to access this model". That's an account-tier wall,
 * not a protocol gap. Which selectors are FREE to CALL is a different question
 * and is derived from the live catalog — a paid plan's promo can make e.g.
 * swe-2-medium/high/max free without moving them into the unpaid entitlement set
 * (see auth.js getConnectSelectorPricing and models.js cost-tier decoding).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { log } from './config.js';

// Canonical OpenAI-ish name / alias → upstream selector (#21). Both the
// dash-form and enum-form selectors are accepted by the API; we prefer the
// dash-form where the catalog exposed one.
const SELECTOR_MAP = new Map(Object.entries({
  // ── SWE / Cognition (free-tier reachable) ──
  'swe-1-6-slow': 'swe-1-6-slow',
  'swe-1.6-slow': 'swe-1-6-slow',
  'swe-1-6': 'swe-1-6',
  'swe-1.6': 'swe-1-6',
  'subagent-default': 'subagent-default',

  // ── Anthropic (paid) ──
  // opus-4-8 → -medium is frame-verified (see resolver header). The bare
  // Cursor/OpenAI-style forms (no `claude-` prefix) exist in models.js's alias
  // table, and chat.js passes the RAW request model name to resolveConnectSelector
  // (not the models.js-resolved key), so without these entries a client asking
  // for bare `opus-4-8` on the DEVIN_CONNECT path silently degrades to the free
  // selector (issue #203). All point at the same frame-verified catalog selector.
  'claude-opus-4-8': 'claude-opus-4-8-medium',
  'claude-opus-4.8': 'claude-opus-4-8-medium',
  'claude-opus-4-8-medium': 'claude-opus-4-8-medium',
  'opus-4-8': 'claude-opus-4-8-medium',
  'opus-4.8': 'claude-opus-4-8-medium',
  // NB: bare dashed `claude-sonnet-4-6` is itself a real catalog selector now
  // (the base, non-thinking model — reachable 2026-07-05), so it must resolve to
  // ITSELF via the catalog fallthrough, not be remapped. Only the dotted family
  // alias `claude-sonnet-4.6` carries the curated -thinking default.
  'claude-sonnet-4.6': 'claude-sonnet-4-6-thinking',
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4-6-thinking',

  // ── OpenAI (paid) ──
  // The catalog advertises bare `gpt-5.5` as the alias for gpt-5-5-low, so the
  // bare form must resolve too — otherwise a client sending the catalog's own
  // alias normalizes to `gpt-5-5`, misses the map, and silently degrades to the
  // free selector (mapped:false). Keep the bare + suffixed forms in lockstep.
  'gpt-5-5': 'gpt-5-5-low',
  'gpt-5.5': 'gpt-5-5-low',
  'gpt-5-5-low': 'gpt-5-5-low',
  'gpt-5.5-low': 'gpt-5-5-low',

  // ── Google (paid) ──

  // ── Others (paid) ──
  'glm-5-2': 'glm-5-2',
  'glm-5.2': 'glm-5-2',
  'kimi-k2-7': 'kimi-k2-7',

  // ── Paid roster confirmed reachable 2026-07-05 (teams token, direct-selector
  // probe, docs-internal/workflow-results/paid-live-2026-07-05/) ── each maps a catalog family
  // alias to its -medium (or base/low) default; all targets are in the refreshed
  // 105-model catalog snapshot. See RESULTS.md §2 for the reachability matrix.
  'claude-5-fable': 'claude-5-fable-medium',
  'claude-sonnet-5': 'claude-sonnet-5-medium',
  'claude-opus-4-7': 'claude-opus-4-7-medium',
  'claude-opus-4.7': 'claude-opus-4-7-medium',
  'claude-opus-4.6': 'claude-opus-4-6',
  'gpt-5-4': 'gpt-5-4-medium',
  'gpt-5.4': 'gpt-5-4-medium',
  'gpt-5-4-mini': 'gpt-5-4-mini-medium',
  'gpt-5.4-mini': 'gpt-5-4-mini-medium',
  'gemini-3-5-flash': 'gemini-3-5-flash-medium',
  'gemini-3.5-flash': 'gemini-3-5-flash-medium',
  // GLM-5.1 is the previous discovery id for the same upstream model (selector
  // glm-5-2). Clients send it both dotted and dashed; without the dashed row the
  // dashed spelling missed every map lookup, was absent from the live catalog,
  // and resolved to {selector:null, mapped:false} → 400 model_not_found, while
  // the dotted form worked. Keep both spellings on the same target.
  'glm-5.1': 'glm-5-2',
  'glm-5-1': 'glm-5-2',
  'kimi-k2.6': 'kimi-k2-6',
  'kimi-k2.7': 'kimi-k2-7',
  // New families in the live 105 catalog (2026-07): SWE-1.7 + DeepSeek V4 Pro.
  'swe-1-7': 'swe-1-7',
  'swe-1.7': 'swe-1-7',
  'swe-2': 'swe-2-medium',
  'swe-2.0': 'swe-2-medium',
  'swe-2-0': 'swe-2-medium',
  'swe2': 'swe-2-medium',
  'swe-2-medium': 'swe-2-medium',
  'swe-2-high': 'swe-2-high',
  'swe-2-max': 'swe-2-max',
  'swe-2.0-medium': 'swe-2-medium',
  'swe-2.0-high': 'swe-2-high',
  'swe-2.0-max': 'swe-2-max',
  // Dashed spelling of the same aliases. The unsuffixed `swe-2-0` row above was
  // the only dashed form present, so `swe-2-0-medium` / `-high` / `-max` missed
  // every map lookup: mapped:false on a live catalog (400 model_not_found) and
  // the swe-1-6-slow degrade on the frozen snapshot — same model, four spellings,
  // one of them silently free-tier. Targets are snapshot selectors.
  'swe-2-0-medium': 'swe-2-medium',
  'swe-2-0-high': 'swe-2-high',
  'swe-2-0-max': 'swe-2-max',
  // 'deepseek-v4' 已下线：不再改指 deepseek-v4-pro-high（不偷换），直接 400。

  // GPT-5.6 family (live catalog 2026-07-09, docs.devin.ai price table). Luna is
  // the fastest/cheapest sibling. Bare, dash and compact forms (issue #244 verbatim
  // `gpt5.6-luna`) all default to -medium. Targets in the snapshot below.
  // `gpt5-6-luna` is the fourth spelling of the same name: compact prefix AND a
  // dashed minor. It was the one form missing, so it degraded to free while its
  // three siblings resolved.
  'gpt-5.6-luna': 'gpt-5-6-luna-medium',
  'gpt-5-6-luna': 'gpt-5-6-luna-medium',
  'gpt5.6-luna': 'gpt-5-6-luna-medium',
  'gpt5-6-luna': 'gpt-5-6-luna-medium',

  // Claude 5: fable/sonnet-5 already mapped above. Opus 5 (2026-07-23) added with
  // the family convention; bare `claude5` (issue #244) defaults to sonnet-5-medium.
  'claude-opus-5': 'claude-opus-5-medium',
  'claude5': 'claude-sonnet-5-medium',
  // Haiku 5.5 (live catalog 2026-10-18): the catalog advertises the family alias
  // `claude-haiku-5.5` across five effort tiers; bare forms default to -medium.
  'claude-haiku-5-5': 'claude-haiku-5-5-medium',
  'claude-haiku-5.5': 'claude-haiku-5-5-medium',
  // Live catalog 2026-10-18: new families observed in GetCliModelConfigs.
  // Bare family aliases default to -medium (or the highest tier when the
  // family has no -medium), matching the existing hand-curated convention.
  'claude-fable-5-1': 'claude-fable-5-1-medium',
  'claude-opus-5-5': 'claude-opus-5-5-medium',
  'claude-sonnet-5-5': 'claude-sonnet-5-5-medium',
  'deepseek-v4-1-flash': 'deepseek-v4-1-flash-1017-high',
  'deepseek-v4-flash': 'deepseek-v4-flash-high',
  'deepseek-v4-pro': 'deepseek-v4-pro-high',
  'gemini-3-7-flash': 'gemini-3-7-flash-medium',
  'gemini-3.7-flash': 'gemini-3-7-flash-medium',
  'gemini-3-8-flash': 'gemini-3-8-flash-medium',
  'gemini-3.8-flash': 'gemini-3-8-flash-medium',
  'gemini-3-6-flash': 'gemini-3-6-flash-medium',
  'gemini-3.6-flash': 'gemini-3-6-flash-medium',
  'gemini-4-argon': 'gemini-4-argon-medium',
  'glm-5-3': 'glm-5-3-high',
  'glm-5-3-flash': 'glm-5-3-flash-high',
  'gpt-5-6-sol': 'gpt-5-6-sol-medium',
  'gpt-5.6-sol': 'gpt-5-6-sol-medium',
  'gpt-5-6-terra': 'gpt-5-6-terra-medium',
  'gpt-5.6-terra': 'gpt-5-6-terra-medium',
  'gpt-6-1-sol': 'gpt-6-1-sol-medium',
  'gpt-6.1-sol': 'gpt-6-1-sol-medium',
  'gpt-6-astra': 'gpt-6-astra-medium',
  'gpt-6-luna': 'gpt-6-luna-medium',
  'gpt-6-sol': 'gpt-6-sol-medium',
  // Bare family names. The catalog exposes only effort tiers for these two, so a
  // client sending the family name (the shape grok-4-6 / grok-4-7 already accept)
  // got a 400 while the siblings worked. Same convention as the rest of this map:
  // a bare family alias defaults to -medium. Targets are snapshot selectors.
  'grok-4-6': 'grok-4-6-medium',
  'grok-4.6': 'grok-4-6-medium',
  'grok-4-7': 'grok-4-7-medium',
  'grok-4.7': 'grok-4-7-medium',
  'kimi-k3': 'kimi-k3-high',
  'nemotron-3-ultra': 'nemotron-3-ultra-medium',

  // ── Family-level aliases advertised by the live catalog (2026-11 sync) ──
  // The upstream catalog lists these bare family names as aliases; without a
  // map row they degraded to the free selector. Point each at its medium tier
  // (the family's callable default; -high/-none where the catalog has no
  // -medium spelling).
  'claude-fable-5-2': 'claude-fable-5-2-medium',
  'claude-fable-5.2': 'claude-fable-5-2-medium',
  'deepseek-v4-1-flash-1017': 'deepseek-v4-1-flash-1017-high',
  'gemini-4-carbon': 'gemini-4-carbon-medium',
  'gemini-4-hydrogen': 'gemini-4-hydrogen-medium',
  'gemini-4-neon': 'gemini-4-neon-medium',
  'gpt-6-1-terra': 'gpt-6-1-terra-medium',
  'gpt-6-2-astra': 'gpt-6-2-astra-medium',
  'gpt-6-2-sol': 'gpt-6-2-sol-medium',
  'kimi-k3-1-pro': 'kimi-k3-1-pro-medium',
  'muse-wonder-1-0': 'muse-wonder-1-0-medium',
  'nemotron-3-5-lightning': 'nemotron-3-5-lightning-none',
  'nemotron-3-5-super': 'nemotron-3-5-super-none',
  'swe-2-flash': 'swe-2-flash-medium',
}));

// The set of selectors the live catalog actually exposes (committed snapshot,
// frame-verified 2026-06-30). A value written to GetChatMessageRequest #21 that
// is NOT in this set is refused by the upstream request validator as
// `invalid_argument` — surfaced as 400 REQUEST_REJECTED since the 2026-10-25
// mapping fix (before that it read as 503 UPSTREAM_INTERNAL and charged the
// internal-error breaker). Frame-proven 2026-07-04: bare "claude-opus-4-8"
// failed, "claude-opus-4-8-medium" 200'd.
// Used as a last-line existence guard on enum/dash-form passthrough. Ships under
// src/ (NOT test/) so it is present in the Docker image — the Dockerfile only
// COPYs src/, so a runtime read from test/ crashes the container on boot. Loaded
// with JSON.parse + readFileSync so this stays a zero-dep ESM module with no
// import assertion. The catalog-drift test reads this same file (single source).
const CATALOG_SELECTORS = new Set(
  JSON.parse(
    readFileSync(new URL('./data/devin-catalog-snapshot.json', import.meta.url), 'utf8'),
  ).models.map((m) => m.selector),
);

// The static last-resort fallback for an unmapped model name. It is the
// COLD-START answer — the one used while no live catalog has arrived — and it is
// never chosen once a synced catalog is authoritative. Live GetCliModelConfigs
// may omit it (#258: reporter's catalog had no swe-1-6-slow).
// Do NOT retarget this to swe-1-7 / glm-5-2 — those are drought-safe on Pro, not
// unpaid entitlement. STRICT_MODEL=1 already 400s unmapped names instead of
// silent-degrading here.
//
// Live evidence 2026-10-22 (Pro account): `swe-1-6-slow` is absent from the
// 240-selector Connect catalog AND from the account's 374 availableModels, and
// the upstream answers it with "Your daily usage quota has been exhausted".
// It is therefore only a DEGRADE TARGET, never a claim that it is callable.
//
// #258 residual: because it is dead on a live-catalog deployment, using it
// unconditionally turned every unmapped name into a fake quota 502. Resolution
// now takes a live free selector from the caller and falls back to this constant
// ONLY while no live catalog exists — see pickDegradeTarget. It is still exported
// because discovery/dashboard synthesize the row from it.
export const FREE_TIER_SELECTOR = 'swe-1-6-slow';
// Canonical selectors an UNPAID account is entitled to. This is ENTITLEMENT, not
// pricing: it is what the connect-namespace filter uses so a paid selector (e.g.
// a fable) is not routed to a free account, which the upstream rejects as
// permission_denied.
//
// Pricing moved out of this set (2026-10-22). "Free now" is derived from the
// account's live `modelCostTier`/`promoStatus` (models.js), then a zero rate in
// its paired credit table, and only falls back to this set when NEITHER live
// source has data anywhere — see auth.js getConnectSelectorPricing. Treating this
// set as the free list is what made the dashboard call `swe-1-6-slow` FREE while
// it 502'd, and mark the three actually-free swe-2 selectors as QUOTA.
export const FREE_REACHABLE_SELECTORS = new Set(['swe-1-6-slow']);

// Paid-plan selectors that do not consume the weekly quota bucket (#258,
// Pro probe 2026-08-23: weeklyPercent=0 still 200). Used ONLY by the drought
// gate. Do NOT add these to FREE_REACHABLE_SELECTORS — that set is unpaid-tier
// entitlement, and putting swe-1-7 / glm-5-2 there routes paid models onto
// free accounts. Canonical resolved selectors only; glm-5.1 is an alias of
// glm-5-2 and is omitted. swe-1-6-slow stays in FREE_REACHABLE, not here.
export const DROUGHT_SAFE_SELECTORS = new Set([
  'swe-1-7',
  'swe-1-7-medium',
  'glm-5-2',
]);

// ── Live catalog (audit 2026-07-12: snapshot staleness fix) ──────────────
// The committed CATALOG_SELECTORS snapshot is a point-in-time capture (105
// models, frame-verified 2026-06-30). Unlike the Cascade catalog — which
// self-heals via auth.js:fetchAndMergeModelCatalog → mergeCloudModels into
// MODELS — the DEVIN_CONNECT selector snapshot NEVER live-synced, so selectors
// the upstream added later (qwen-3 / glm-5 / kimi-k2.5 / deepseek-v3 /
// minimax-* — all present in a live account's availableModels, proven
// 2026-07-12) were absent from the snapshot and got 400'd by the strict gate
// (chat.js) as "not a valid model", despite being genuinely runnable.
//
// Fix: a runtime-populated live selector set, refreshed from GetCliModelConfigs
// (devin-connect-catalog.js:fetchCatalog) by auth.js on catalog sync. A NON-EMPTY
// live response is authoritative: keeping `snapshot ∪ live` after a successful
// sync advertises selectors omitted by upstream account-level restrictions. The
// snapshot is therefore only a cold-start / failed-sync fallback. Empty responses
// never replace a prior good live set, so making live authoritative does not turn
// a transient fetch failure into an empty catalog.
const _liveSelectors = new Set();
// True while at least one active account (or an explicit env-token path) still
// lacks a last-known-good catalog. In that mixed state the frozen snapshot stays
// available for that fallback contributor, while accounts with live rows remain
// constrained by auth.js's per-account gate.
let _snapshotFallbackEnabled = true;
// Full decoded catalog rows ({ selector, label, provider, alias, ... }) from the
// last good sync. Kept alongside _liveSelectors so /v1/models can synthesize
// entries for live-only selectors that aren't in the hardcoded MODELS table
// (audit 2026-07-12: the 37 upstream-added selectors — gpt-5-6-*/grok-4-5-*/
// nemotron — run fine at /v1/chat/completions but were missing from /v1/models,
// so Codex/clients couldn't discover them). Empty until the first sync.
let _liveCatalog = [];

/** True when at least one live catalog sync has populated the live set. */
export function hasLiveCatalog() { return _liveSelectors.size > 0; }

/** The full decoded live catalog rows from the last good sync (may be []). */
export function getLiveCatalog() { return _liveCatalog; }

/**
 * The live catalog's EXPLICIT image capability for a resolved selector.
 *
 * Three-state on purpose, matching `disabled` (#4): `true`/`false` only when the
 * upstream actually sent field #5 for this selector; `null` when the catalog is
 * empty (cold start / failed sync), the selector is absent, or the row stayed
 * silent. A caller must never read `null` as "no" — the same rule that keeps
 * isModelDisabledUpstream from refusing statically-catalogued models.
 *
 * This is the request-path twin of the `supports_images` bit that
 * handlers/models.js advertises from these same rows.
 */
export function getConnectSelectorImageCapability(selector) {
  const key = String(selector || '').trim();
  if (!key) return null;
  for (const row of _liveCatalog) {
    if (row?.selector !== key) continue;
    return typeof row.supportsImages === 'boolean' ? row.supportsImages : null;
  }
  return null;
}

/** Frozen cold-start selectors (the committed snapshot), for dashboard diffing. */
export function getSnapshotSelectors() { return [...CATALOG_SELECTORS]; }

/**
 * Replace the live DEVIN_CONNECT selector set from a fresh GetCliModelConfigs
 * fetch. Called by auth.js after fetchCatalog(). Accepts the decoded catalog
 * (array of { selector, alias? }) or a plain array/Set of selector strings.
 * Only canonical selectors enter the authoritative set; family aliases remain
 * governed by SELECTOR_MAP so an upstream-advertised shorthand is never sent raw
 * when field #21 requires a full selector. No-op on empty/garbage input (keeps
 * the prior live set).
 */
export function setLiveCatalogSelectors(catalog, { includeSnapshotFallback = false } = {}) {
  const items = Array.isArray(catalog) ? catalog
    : (catalog instanceof Set ? [...catalog] : []);
  if (!items.length) return;
  const next = new Set();
  const rowsBySelector = new Map();
  for (const it of items) {
    if (typeof it === 'string') {
      const selector = it.trim();
      if (!selector) continue;
      next.add(selector);
      if (!rowsBySelector.has(selector)) rowsBySelector.set(selector, { selector });
      continue;
    }
    if (it && typeof it === 'object') {
      // ONLY the canonical `selector` (the full, upstream-accepted form) goes into
      // the live existence set. The catalog's `alias` is a FAMILY shortcut
      // (e.g. selector "gpt-5-6-sol-medium" → alias "gpt-5.6-sol"; and multiple
      // effort tiers of one family SHARE one alias — claude-opus-4-7-{low,medium,
      // high,max} all alias to "claude-opus-4.7"). The upstream does NOT accept an
      // alias as a model name — writing a bare family alias to GetChatMessageRequest
      // #21 trips the request validator (`invalid_argument` → 400 REQUEST_REJECTED;
      // before the 2026-10-25 mapping fix it read as UPSTREAM_INTERNAL and burned
      // the account). Frame-proven: only the full "-medium" form 200s. Folding
      // aliases in here made resolveConnectSelector
      // return mapped:true for a family alias not covered by SELECTOR_MAP (e.g.
      // "gpt-5.6-sol") and pass that bad form straight through. Aliases are handled
      // by the hand-maintained SELECTOR_MAP (which resolves them to a real selector);
      // an alias the map doesn't know must fail closed, not pass through raw.
      // (ultracode review 2026-07-12; real-account confirmed gpt-5.6-sol regression)
      const selector = typeof it.selector === 'string' ? it.selector.trim() : '';
      if (!selector) continue;
      next.add(selector);
      if (!rowsBySelector.has(selector)) rowsBySelector.set(selector, { ...it, selector });
    }
  }
  if (!next.size) return; // never blank out a good set on a bad fetch
  _liveSelectors.clear();
  for (const s of next) _liveSelectors.add(s);
  _snapshotFallbackEnabled = includeSnapshotFallback === true;
  // Retain normalized rows so every consumer sees the same canonical selector
  // strings as the existence set. String-only test seams become minimal rows
  // instead of leaving stale metadata from an earlier object catalog behind.
  _liveCatalog = [...rowsBySelector.values()];
}

/**
 * Drop the live catalog entirely, leaving only the frozen snapshot.
 *
 * Distinct from setLiveCatalogSelectors([]), which deliberately IGNORES empty
 * input so a failed or truncated fetch can't blank out a good set. This is the
 * explicit "there is genuinely nothing left" path — used when the last account
 * contributing to the pool union goes away, where keeping the departed account's
 * selectors would advertise models nothing in the pool can reach.
 */
export function clearLiveCatalogSelectors() {
  _liveSelectors.clear();
  _liveCatalog = [];
  _snapshotFallbackEnabled = true;
}

// Synthetic selectors do not appear in GetCliModelConfigs but remain valid
// routing targets. Keep this list deliberately tiny: everything else must come
// from the authoritative live catalog once one has been fetched.
const CATALOG_INDEPENDENT_SELECTORS = new Set([
  ...FREE_REACHABLE_SELECTORS,
  'subagent-default',
]);

/**
 * Does the currently authoritative Connect catalog contain this selector?
 *
 * Before the first successful live sync, fall back to the frozen snapshot so a
 * cold-start or transient catalog failure stays usable. Once live data exists,
 * use it exclusively so removed snapshot selectors are not advertised or routed.
 */
export function isKnownConnectSelector(name, { allowSnapshotFallback = false } = {}) {
  if (CATALOG_INDEPENDENT_SELECTORS.has(name)) return true;
  if (_liveSelectors.has(name)) return true;
  const envTokenFallback = !!(
    process.env.DEVIN_CONNECT_TOKEN || process.env.WINDSURF_API_KEY
  );
  return (
    _liveSelectors.size === 0
    || _snapshotFallbackEnabled
    || allowSnapshotFallback
    || envTokenFallback
  ) && CATALOG_SELECTORS.has(name);
}

/** True for valid synthetic selectors that an account catalog never enumerates. */
export function isConnectSelectorCatalogIndependent(name) {
  return CATALOG_INDEPENDENT_SELECTORS.has(name);
}

/**
 * Pick the selector an unmapped name degrades to, or null when there is none.
 *
 * The rule is EVIDENCE, not a fixed name:
 *
 *   - A synced catalog (with no snapshot fallback in play) is authoritative:
 *     only a selector it lists can be called, so only a live free selector from
 *     `freeFallback` is eligible. `swe-1-6-slow` is the proof this matters — it
 *     stayed the degrade target after the live catalog dropped it, and every
 *     unmapped name then surfaced as a fake "daily usage quota has been
 *     exhausted" 502 (#258 residual). Nothing eligible → null, and the caller
 *     answers `model_not_found` instead of routing.
 *   - With no live evidence (cold start, or a pool where some contributor still
 *     lacks a catalog) the documented static floor applies, because nothing has
 *     contradicted it yet. A caller-supplied free selector still outranks it —
 *     the caller already restricted its list to what the pool can reach.
 *
 * Note this deliberately does NOT consult `isKnownConnectSelector`: that
 * predicate answers true for every CATALOG_INDEPENDENT selector (which includes
 * FREE_REACHABLE_SELECTORS) because a CALLER may legitimately name one. That is
 * the right answer for "did the client name a real model" and the wrong one for
 * "should we CHOOSE this as a degrade target".
 */
function pickDegradeTarget({ freeFallback } = {}) {
  const liveAuthoritative = _liveSelectors.size > 0 && !_snapshotFallbackEnabled;
  for (const candidate of freeFallback || []) {
    const name = typeof candidate === 'string' ? candidate.trim() : '';
    if (!name) continue;
    if (!liveAuthoritative || _liveSelectors.has(name)) return name;
  }
  return liveAuthoritative ? null : FREE_TIER_SELECTOR;
}

/**
 * Resolve a client-supplied model name to an upstream DEVIN_CONNECT selector.
 * Normalizes case and dot/dash variations. An unmapped name degrades to a free
 * selector so an enabled DEVIN_CONNECT deploy does not hard-fail on a stale
 * alias — but ONLY to one that is callable (see pickDegradeTarget); when no
 * such selector exists the result carries `selector: null` and the request must
 * be answered with `model_not_found` rather than routed to a dead name.
 *
 * @param {string} model
 * @param {object} [opts]
 * @param {boolean} [opts.warnOnFallback=true] set false for read-only catalog
 *   probes; a later real request will still emit the one-time downgrade warning
 * @param {boolean} [opts.allowSnapshotFallback=false] keep frozen selectors
 *   resolvable for an explicit env-token/empty-pool fallback contributor
 * @param {string[]} [opts.freeFallback=[]] live free selectors, most preferred
 *   first. Callers that hold live pricing data (auth.js) pass it so the degrade
 *   target tracks what the upstream actually serves; omitted, the static floor
 *   is used.
 * @returns {{ selector: string|null, mapped: boolean }} `selector` is null only
 *   when the name is unmapped AND no callable degrade target exists — the caller
 *   must then answer model_not_found instead of routing.
 */
export function resolveConnectSelector(model, {
  warnOnFallback = true,
  allowSnapshotFallback = false,
  freeFallback = [],
} = {}) {
  const raw = String(model || '').trim();
  // `warnName` is null for an omitted model: that is the documented default-model
  // path, not a caller naming a model we could not find, so it does not warn.
  const degrade = (warnName) => {
    const target = pickDegradeTarget({ freeFallback });
    if (!target) return { selector: null, mapped: false };
    if (warnOnFallback && warnName) warnDegradeOnce(warnName, target);
    return { selector: target, mapped: false };
  };
  const hit = (selector) => ({ selector, mapped: true });

  if (!raw) return degrade(null);

  // A hand-maintained alias is valid only while its TARGET exists in the
  // authoritative catalog. Otherwise a stale map entry can keep a removed model
  // routable forever even after the live sync proved it is gone.
  const directTarget = SELECTOR_MAP.get(raw);
  if (directTarget && isKnownConnectSelector(directTarget, { allowSnapshotFallback })) {
    return hit(directTarget);
  }

  // Normalize: lowercase, strip a leading provider prefix some clients prepend
  // (e.g. "anthropic/claude-..."), then collapse dots to dashes.
  //
  // The prefix segment may contain digits and hyphens: real provider ids include
  // `x-ai` and `z-ai`, and the old `/^[a-z]+\//` could not match them, so every
  // `x-ai/...` spelling missed every lookup and failed model_not_found against a
  // live catalog (313 probed rows across 48 families). Strip exactly ONE segment:
  // in `x/y/glm-5.1` the second segment is part of the name. pickToolDialect
  // applies this same rule before its family checks (verifier P2-2) — keep them
  // identical.
  const stripped = raw.toLowerCase().replace(/^[a-z0-9][a-z0-9-]*\//, '');
  // Compact version spellings (`gpt5.5`, `gpt5.4-mini`, `gemini3.5-flash`) are
  // the same model written without the separator after the family name, but the
  // catalog and the alias map only carry the separated forms, so they used to
  // resolve to nothing while their dotted siblings resolved (S4: 10 families).
  // Split at the version separator BEFORE the map lookup.
  //
  // The `.` is REQUIRED. Without it the rule also rewrites the family shorthand
  // `claude5` into the nonexistent `claude-5`, silently degrading an alias that
  // works today (probed: it is the only SELECTOR_MAP key the wide rule would
  // break). A compact spelling without a minor version is a family name, not a
  // version, so it must keep its existing alias.
  const compact = stripped.replace(/^(gpt|claude|gemini)(\d)\./, '$1-$2.');
  const norm = compact.replace(/\./g, '-');
  const normalizedTarget = SELECTOR_MAP.get(norm);
  if (normalizedTarget && isKnownConnectSelector(normalizedTarget, { allowSnapshotFallback })) {
    return hit(normalizedTarget);
  }
  // A normalized dash-form that IS a real catalog selector (e.g. client sent the
  // dotted "gpt-5.5-medium" → norm "gpt-5-5-medium" which the catalog exposes but
  // the alias map doesn't list). Without this, a valid selector written with dots
  // silently degraded to the free tier. Checked after the map so an alias still
  // wins, before the free-tier fallback.
  if (isKnownConnectSelector(norm, { allowSnapshotFallback })) {
    return hit(norm);
  }

  // Enum-form passthrough — ONLY when the catalog actually exposes it. Test the
  // SHAPE on the normalized key and look the UPPERCASE form up: a client may copy
  // the enum verbatim (MODEL_GPT_5_2_LOW), lowercase it, or prepend a provider
  // prefix, and the old raw-string test let only the first of those through
  // (S5: 96 probed rows). A blind MODEL_* passthrough is what re-introduces a
  // request-validator rejection (`invalid_argument` → 400 REQUEST_REJECTED) on
  // drift, so the existence check stays.
  const enumForm = norm.toUpperCase();
  if (/^MODEL_[A-Z0-9_]+$/.test(enumForm)
    && isKnownConnectSelector(enumForm, { allowSnapshotFallback })) {
    return hit(enumForm);
  }

  // A verbatim dash-form selector that IS in the authoritative catalog but is
  // missing from the alias map (e.g. a selector the upstream added after the
  // frozen snapshot — qwen-3/glm-5/etc.) should still go through rather than
  // silently degrade a paid request to free.
  if (isKnownConnectSelector(raw, { allowSnapshotFallback })) {
    return hit(raw);
  }

  // Unmapped: degrade to a callable free selector, and make it OBSERVABLE
  // (one-time per distinct model) so a caller ignoring mapped:false still gets
  // an operator signal that a paid model was downgraded to free. `selector: null`
  // is the distinct "there is nothing to downgrade to" answer, which the handler
  // must report as model_not_found (#258 residual).
  return degrade(raw);
}

// Tracks model names we've already warned about so the degrade signal fires
// once per distinct name rather than on every request (avoids log flooding).
//
// The name is CALLER-CONTROLLED and this record is process-lifetime, and the
// resolver runs BEFORE the strict-model 400 in handlers/chat.js — so a rejected
// request still left its raw string here until restart: one unbounded entry per
// distinct junk name (audit 2026-09-22, D-SCALE-001, reproduced — 99 rejected
// requests retained 99 raw names). Two bounds close that: the key is a SHA-256
// digest (fixed 64 chars, so retained BYTES are bounded as well as cardinality)
// and the set is a FIFO cache — a duplicate hit does NOT refresh its position, so
// once the cap is exceeded the oldest insertion is evicted and may warn again.
// The warning text is unchanged: it still names the model for the operator, that
// string is just no longer the stored key.
const DEGRADE_WARNED_MAX = 1024;
const degradeWarned = new Set();

/** Emit the one-time unmapped-model warning, keeping its record bounded (FIFO). */
function warnDegradeOnce(raw, target) {
  const key = createHash('sha256').update(raw).digest('hex');
  if (degradeWarned.has(key)) return;
  degradeWarned.add(key);
  // Set iteration order is insertion order, so the first key is the oldest.
  if (degradeWarned.size > DEGRADE_WARNED_MAX) {
    degradeWarned.delete(degradeWarned.values().next().value);
  }
  // Name the selector the request ACTUALLY runs on: it is live-derived whenever
  // the caller passed freeFallback, so hardcoding FREE_TIER_SELECTOR here would
  // point the operator at a selector this request never used (#258 residual).
  log.warn(
    `[devin-connect] unmapped model "${raw}" not in catalog — degrading to `
    + `${target} (paid request downgraded to free tier)`,
  );
}

export const __testing = { SELECTOR_MAP, CATALOG_SELECTORS, degradeWarned, _liveSelectors };
