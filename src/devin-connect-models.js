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
 * Free-tier accounts only resolve `swe-1-6-slow`; every other selector returns
 * "/upgrade to access this model". That's an account-tier wall, not a protocol
 * gap — the mapping is complete and ready for a paid entitlement.
 */

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
  'swe-1-6-fast': 'swe-1-6-fast',
  'swe-1.6-fast': 'swe-1-6-fast',
  'swe-1-5': 'MODEL_SWE_1_5_SLOW',
  'swe-1.5': 'MODEL_SWE_1_5_SLOW',
  'swe-1-5-fast': 'MODEL_SWE_1_5',
  'swe-1.5-fast': 'MODEL_SWE_1_5',
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
  'claude-opus-4-5': 'MODEL_CLAUDE_4_5_OPUS',
  'claude-opus-4.5': 'MODEL_CLAUDE_4_5_OPUS',
  'claude-opus-4-5-thinking': 'MODEL_CLAUDE_4_5_OPUS_THINKING',
  'claude-sonnet-4-5': 'MODEL_PRIVATE_2',
  'claude-sonnet-4.5': 'MODEL_PRIVATE_2',
  'claude-sonnet-4-5-thinking': 'MODEL_PRIVATE_3',
  'claude-haiku-4-5': 'MODEL_PRIVATE_11',
  'claude-haiku-4.5': 'MODEL_PRIVATE_11',

  // ── OpenAI (paid) ──
  // The catalog advertises bare `gpt-5.5` as the alias for gpt-5-5-low, so the
  // bare form must resolve too — otherwise a client sending the catalog's own
  // alias normalizes to `gpt-5-5`, misses the map, and silently degrades to the
  // free selector (mapped:false). Keep the bare + suffixed forms in lockstep.
  'gpt-5-5': 'gpt-5-5-low',
  'gpt-5.5': 'gpt-5-5-low',
  'gpt-5-5-low': 'gpt-5-5-low',
  'gpt-5.5-low': 'gpt-5-5-low',
  'gpt-5-2': 'MODEL_GPT_5_2_NONE',
  'gpt-5.2': 'MODEL_GPT_5_2_NONE',
  'gpt-5-2-low': 'MODEL_GPT_5_2_LOW',
  'gpt-5-2-medium': 'MODEL_GPT_5_2_MEDIUM',
  'gpt-5-2-high': 'MODEL_GPT_5_2_HIGH',
  'gpt-5-2-xhigh': 'MODEL_GPT_5_2_XHIGH',

  // ── Google (paid) ──
  // Catalog advertises the family alias as `gemini-3.0-flash` (with the .0),
  // which normalizes to `gemini-3-0-flash`. Keep both that and the shorter
  // `gemini-3-flash` form pointing at the MEDIUM default so the catalog's own
  // alias resolves instead of degrading to free.
  'gemini-3-0-flash': 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM',
  'gemini-3.0-flash': 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM',
  'gemini-3-flash': 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM',
  'gemini-3-flash-minimal': 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL',
  'gemini-3-flash-low': 'MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW',
  'gemini-3-flash-medium': 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM',
  'gemini-3-flash-high': 'MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH',

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
  'gpt-5-3-codex': 'gpt-5-3-codex-medium',
  'gpt-5.3-codex': 'gpt-5-3-codex-medium',
  'gemini-3-5-flash': 'gemini-3-5-flash-medium',
  'gemini-3.5-flash': 'gemini-3-5-flash-medium',
  'gemini-3-1-pro': 'gemini-3-1-pro-low',
  'gemini-3.1-pro': 'gemini-3-1-pro-low',
  'glm-5.1': 'glm-5-2',
  'kimi-k2.6': 'kimi-k2-6',
  'kimi-k2.7': 'kimi-k2-7',
  // New families in the live 105 catalog (2026-07): SWE-1.7 + DeepSeek V4 Pro.
  'swe-1-7': 'swe-1-7',
  'swe-1.7': 'swe-1-7',
  'swe-1-7-lightning': 'swe-1-7-lightning',
  'swe-1.7-lightning': 'swe-1-7-lightning',
  'deepseek-v4': 'deepseek-v4',

  // GPT-5.6 family (live catalog 2026-07-09, docs.devin.ai price table). Luna is
  // the fastest/cheapest sibling. Bare, dash and compact forms (issue #244 verbatim
  // `gpt5.6-luna`) all default to -medium. Targets in the snapshot below.
  'gpt-5.6-luna': 'gpt-5-6-luna-medium',
  'gpt-5-6-luna': 'gpt-5-6-luna-medium',
  'gpt5.6-luna': 'gpt-5-6-luna-medium',

  // Claude 5: fable/sonnet-5 already mapped above. Opus 5 (2026-07-23) added with
  // the family convention; bare `claude5` (issue #244) defaults to sonnet-5-medium.
  'claude-opus-5': 'claude-opus-5-medium',
  'claude5': 'claude-sonnet-5-medium',
}));

// The set of selectors the live catalog actually exposes (committed snapshot,
// frame-verified 2026-06-30). A value written to GetChatMessageRequest #21 that
// is NOT in this set makes the upstream return UPSTREAM_INTERNAL (frame-proven
// 2026-07-04: bare "claude-opus-4-8" failed, "claude-opus-4-8-medium" 200'd).
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

// The only selector a free-tier account can actually run. Used as the safe
// default when DEVIN_CONNECT is enabled but the requested model isn't mapped.
export const FREE_TIER_SELECTOR = 'swe-1-6-slow';
// Canonical selectors a free-tier account can actually run. Per this module's
// docstring, free resolves ONLY swe-1-6-slow; every other selector returns
// "/upgrade" upstream. Keep in sync with free-tier live probes. Used by the
// connect-namespace entitlement filter so a paid selector (e.g. a fable) is not
// routed to a free account, which the upstream would reject as permission_denied.
export const FREE_REACHABLE_SELECTORS = new Set(['swe-1-6-slow']);

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
 * Replace the live DEVIN_CONNECT selector set from a fresh GetCliModelConfigs
 * fetch. Called by auth.js after fetchCatalog(). Accepts the decoded catalog
 * (array of { selector, alias? }) or a plain array/Set of selector strings.
 * Also folds each entry's `alias` in so a client sending the upstream's own
 * alias (e.g. "glm-5.2") is recognized even when only the dashed selector is
 * canonical. No-op on empty/garbage input (keeps the prior live set).
 */
export function setLiveCatalogSelectors(catalog) {
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
      // #21 trips UPSTREAM_INTERNAL and burns the account (frame-proven: only the
      // full "-medium" form 200s). Folding aliases in here made resolveConnectSelector
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
}

// Synthetic selectors do not appear in GetCliModelConfigs but remain valid routing
// targets. Keep this list deliberately tiny: everything else must come from the
// authoritative live catalog once one has been fetched.
const ALWAYS_KNOWN_SELECTORS = new Set([
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
export function isKnownConnectSelector(name) {
  if (ALWAYS_KNOWN_SELECTORS.has(name)) return true;
  return _liveSelectors.size > 0
    ? _liveSelectors.has(name)
    : CATALOG_SELECTORS.has(name);
}

/**
 * Resolve a client-supplied model name to an upstream DEVIN_CONNECT selector.
 * Normalizes case and dot/dash variations. Returns the free-tier default for
 * unknown names so an enabled DEVIN_CONNECT deploy never hard-fails on an
 * unmapped alias — it degrades to the one selector that always works.
 *
 * @param {string} model
 * @param {object} [opts]
 * @param {boolean} [opts.warnOnFallback=true] set false for read-only catalog
 *   probes; a later real request will still emit the one-time downgrade warning
 * @returns {{ selector: string, mapped: boolean }}
 */
export function resolveConnectSelector(model, { warnOnFallback = true } = {}) {
  const raw = String(model || '').trim();
  if (!raw) return { selector: FREE_TIER_SELECTOR, mapped: false };

  // A hand-maintained alias is valid only while its TARGET exists in the
  // authoritative catalog. Otherwise a stale map entry can keep a removed model
  // routable forever even after the live sync proved it is gone.
  const directTarget = SELECTOR_MAP.get(raw);
  if (directTarget && isKnownConnectSelector(directTarget)) {
    return { selector: directTarget, mapped: true };
  }

  // Normalize: lowercase, collapse dots to dashes, strip a leading provider
  // prefix some clients prepend (e.g. "anthropic/claude-...").
  const norm = raw.toLowerCase().replace(/^[a-z]+\//, '').replace(/\./g, '-');
  const normalizedTarget = SELECTOR_MAP.get(norm);
  if (normalizedTarget && isKnownConnectSelector(normalizedTarget)) {
    return { selector: normalizedTarget, mapped: true };
  }
  // A normalized dash-form that IS a real catalog selector (e.g. client sent the
  // dotted "gpt-5.5-medium" → norm "gpt-5-5-medium" which the catalog exposes but
  // the alias map doesn't list). Without this, a valid selector written with dots
  // silently degraded to the free tier. Checked after the map so an alias still
  // wins, before the free-tier fallback.
  if (isKnownConnectSelector(norm)) return { selector: norm, mapped: true };

  // Enum-form passthrough — ONLY when the catalog actually exposes it. A blind
  // MODEL_* passthrough is what re-introduces UPSTREAM_INTERNAL on drift: any
  // bogus MODEL_DOES_NOT_EXIST would otherwise be written raw to #21.
  if (/^MODEL_[A-Z0-9_]+$/.test(raw) && isKnownConnectSelector(raw)) {
    return { selector: raw, mapped: true };
  }

  // A verbatim dash-form selector that IS in the authoritative catalog but is
  // missing from the alias map (e.g. a selector the upstream added after the
  // frozen snapshot — qwen-3/glm-5/etc.) should still go through rather than
  // silently degrade a paid request to free.
  if (isKnownConnectSelector(raw)) return { selector: raw, mapped: true };

  // Unmapped: degrade to the always-available free selector, but make it
  // OBSERVABLE (one-time per distinct model) so a caller ignoring mapped:false
  // still gets an operator signal that a paid model was downgraded to free.
  if (warnOnFallback && !degradeWarned.has(raw)) {
    degradeWarned.add(raw);
    log.warn(
      `[devin-connect] unmapped model "${raw}" not in catalog — degrading to `
      + `${FREE_TIER_SELECTOR} (paid request downgraded to free tier)`,
    );
  }
  return { selector: FREE_TIER_SELECTOR, mapped: false };
}

// Tracks model names we've already warned about so the degrade signal fires
// once per distinct name rather than on every request (avoids log flooding).
const degradeWarned = new Set();

export const __testing = { SELECTOR_MAP, CATALOG_SELECTORS, degradeWarned, _liveSelectors };
