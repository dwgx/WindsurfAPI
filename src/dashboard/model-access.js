/**
 * Model access control — allow/block specific models.
 * Persisted to model-access.json.
 */

import { readFileSync, existsSync } from 'fs';
import { writeJsonAtomic } from '../fs-atomic.js';
import { join } from 'path';
import { config, log } from '../config.js';
import { cacheClear } from '../cache.js';
import { getBackendSwitch } from '../runtime-config.js';

const ACCESS_FILE = join(config.dataDir, 'model-access.json');

// mode: 'allowlist' (only listed models allowed) | 'blocklist' (listed models blocked) | 'all' (no restrictions)
const _config = {
  mode: 'all',
  list: [],          // model IDs in the list
  defaultModel: '',  // when set, a blocked/unlisted model falls back to this
                     // instead of being rejected. Empty = reject (default).
};

// Load
try {
  if (existsSync(ACCESS_FILE)) {
    Object.assign(_config, JSON.parse(readFileSync(ACCESS_FILE, 'utf-8')));
  }
} catch (e) {
  log.error('Failed to load model-access.json:', e.message);
}

// One snapshot, one atomic write. writeJsonAtomic publishes the new bytes via
// rename(2); a failure AFTER the rename (parent-directory fsync) leaves the new
// file visible while marking the error `renamePublished`. Memory must follow
// that published file — rolling back would make the live process disagree with
// disk and let the next save resurrect the old policy. Same contract as the
// accepted runtime-config credential transaction (src/runtime-config.js).
const PERSIST_DURABLE = 'durable';
const PERSIST_UNCONFIRMED = 'unconfirmed';
const PERSIST_NOT_APPLIED = 'not-applied';
const PERSIST_UNCHANGED = 'unchanged';

let _persistFailureForTests = null;
let _fsHooksForTests = null;

/** Simulate a fault BEFORE any byte is written (the historical ENOSPC seam). */
export function __setModelAccessPersistFailureForTests(err) {
  _persistFailureForTests = err || null;
}

/** Replace the filesystem seams (writeJsonAtomic / rename / fsyncParent). */
export function __setModelAccessFsHooksForTests(hooks) {
  _fsHooksForTests = hooks || null;
}

// Diagnostics are not part of the transaction. A logger that throws (an
// exhausted stderr, a hostile test seam) must never turn a published write into
// a rolled-back memory state or suppress the honest failure envelope.
function safeLog(level, ...args) {
  try {
    log[level]?.(...args);
  } catch {}
}

// The policy file is JSON by contract. Snapshot ownership uses a JSON round-trip
// so neither a caller's request body nor a getter consumer can mutate live state
// through an object nested inside the list. Anything non-JSON was never
// persistable through writeJsonAtomic either; keep a shallow fallback for it.
function cloneList(list) {
  if (!Array.isArray(list)) return [];
  try {
    return JSON.parse(JSON.stringify(list));
  } catch {
    return [...list];
  }
}

function jsonSame(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function persistSnapshot(snapshot) {
  if (_persistFailureForTests) {
    safeLog('error', 'Failed to save model-access.json:', _persistFailureForTests.message);
    return { applied: false, durability: PERSIST_NOT_APPLIED, error: _persistFailureForTests };
  }
  try {
    (_fsHooksForTests?.writeJsonAtomic || writeJsonAtomic)(ACCESS_FILE, snapshot);
    return { applied: true, durability: PERSIST_DURABLE };
  } catch (e) {
    if (!e?.renamePublished) {
      safeLog('error', 'Failed to save model-access.json:', e.message);
      return { applied: false, durability: PERSIST_NOT_APPLIED, error: e };
    }
    safeLog('error', 'Published model-access.json but directory sync failed:', e.message);
    return { applied: true, durability: PERSIST_UNCONFIRMED };
  }
}

function sameSnapshot(a, b) {
  if (a.mode !== b.mode || a.defaultModel !== b.defaultModel) return false;
  if (a.list.length !== b.list.length) return false;
  for (let i = 0; i < a.list.length; i++) {
    if (!jsonSame(a.list[i], b.list[i])) return false;
  }
  return true;
}

/**
 * Read a copy of the accepted snapshot. The list is copied too: callers use
 * the result for rendering/filtering and an accidental in-place edit must never
 * change the policy the request path enforces.
 */
export function getModelAccessConfig() {
  return { mode: _config.mode, list: cloneList(_config.list), defaultModel: _config.defaultModel };
}

/**
 * Apply one policy patch as a single transaction.
 *
 * Presence/coercion rules intentionally match the historical route and
 * setters so existing callers keep their validation:
 *   - a truthy `mode` is applied only when it is one of the three known modes;
 *     anything else (including a bogus string) leaves the mode untouched;
 *   - a truthy `list` must be an array, otherwise it clears the list (the old
 *     setModelAccessList coercion);
 *   - `defaultModel` is trimmed; non-strings become the empty "reject" value.
 *
 * Returns `{ config, applied, changed, durability, error? }`:
 *   - applied:false / durability:'not-applied' — the snapshot never reached
 *     disk, and memory still holds the previous policy.
 *   - applied:true / durability:'durable' — the new policy is live and durable.
 *   - applied:true / durability:'unconfirmed' — the rename published the new
 *     policy (live + visible on disk) but the parent-directory sync failed.
 *   - applied:true / changed:false / durability:'unchanged' — the request
 *     matched the accepted snapshot, so no write was attempted.
 */
export function updateModelAccess(patch = {}) {
  const source = (patch && typeof patch === 'object') ? patch : {};
  const candidate = {
    mode: _config.mode,
    list: cloneList(_config.list),
    defaultModel: _config.defaultModel,
  };
  if (source.mode) {
    if (['all', 'allowlist', 'blocklist'].includes(source.mode)) candidate.mode = source.mode;
  }
  if (source.list) {
    candidate.list = Array.isArray(source.list) ? cloneList(source.list) : [];
  }
  if (source.defaultModel !== undefined) {
    candidate.defaultModel = typeof source.defaultModel === 'string' ? source.defaultModel.trim() : '';
  }

  if (sameSnapshot(candidate, _config)) {
    return { config: getModelAccessConfig(), applied: true, changed: false, durability: PERSIST_UNCHANGED };
  }

  const outcome = persistSnapshot(candidate);
  if (!outcome.applied) {
    // Nothing reached the file: keep the accepted snapshot (and the old file).
    return {
      config: getModelAccessConfig(),
      applied: false,
      changed: true,
      durability: outcome.durability,
      error: outcome.error,
    };
  }
  // Either durable or published-but-unconfirmed: both mean the file holds
  // `candidate`, so memory must agree with it.
  _config.mode = candidate.mode;
  _config.list = candidate.list;
  _config.defaultModel = candidate.defaultModel;
  // B1: the response cache keys the routed generation; a policy change re-roots
  // or unblocks models, so entries captured against the old policy must neither
  // be served nor be backfilled by in-flight writes. Bumping the generation
  // (cacheClear) also drops the stale entries.
  cacheClear();
  return {
    config: getModelAccessConfig(),
    applied: true,
    changed: true,
    durability: outcome.durability,
  };
}

export function setModelAccessMode(mode) {
  if (!['all', 'allowlist', 'blocklist'].includes(mode)) return;
  updateModelAccess({ mode });
}

export function setModelAccessList(list) {
  updateModelAccess({ list: Array.isArray(list) ? list : [] });
}

export function addModelToList(modelId) {
  if (_config.list.includes(modelId)) return;
  updateModelAccess({ list: [..._config.list, modelId] });
}

export function removeModelFromList(modelId) {
  updateModelAccess({ list: _config.list.filter(m => m !== modelId) });
}

/**
 * Fallback model for requests whose model is not on the allowlist (or is on
 * the blocklist). When set, isModelAllowed() surfaces it so the chat handler
 * can retarget the request instead of returning a hard rejection. Empty
 * string means "reject", which is the safe default.
 */
export function setDefaultModel(modelId) {
  updateModelAccess({ defaultModel: typeof modelId === 'string' ? modelId.trim() : '' });
}

export function getDefaultModel() {
  return _config.defaultModel || '';
}

/**
 * Some models in the catalog are simply the reasoning-mode variant of a
 * base model (claude-opus-4.6 vs claude-opus-4.6-thinking). For
 * allowlist/blocklist purposes we treat the `-thinking` suffix as
 * inheriting from its base — otherwise a user who carefully added
 * `claude-opus-4.6` to their allowlist still gets a 403 the moment
 * they ask for `-thinking`, with no obvious connection to anything
 * they've configured (#103).
 *
 * Other variant suffixes (-fast, -1m, -low/medium/high/xhigh, -mini,
 * -nano, -codex, -max-*) are intentionally NOT inherited — those are
 * distinct entitlements (different context window, latency tier,
 * pricing, or model architecture) where treating them interchangeably
 * would surprise users who actually want fine-grained gating.
 */
function siblingsForAllowlist(modelId) {
  const sibs = [];
  if (modelId.endsWith('-thinking')) {
    sibs.push(modelId.slice(0, -'-thinking'.length));
  } else {
    sibs.push(modelId + '-thinking');
  }
  return sibs;
}

// v3.9.30 discovery overlay advertises glm-5.2 for selector glm-5-2. Operators
// whose allow/block list still carries glm-5.1 (the v3.9.29 public id) would
// miss auto-discovered glm-5.2 requests. Connect folds that pair; Cascade
// keeps distinct uids (glm-5-1 vs glm-5-2). Exact overlay only — do not route
// the access list through resolveConnectSelector.
function connectDiscoverySiblings(modelId) {
  if (!getBackendSwitch('devinConnect')) return [];
  if (modelId === 'glm-5.2') return ['glm-5.1'];
  if (modelId === 'glm-5.1') return ['glm-5.2'];
  return [];
}

function accessListSiblings(modelId) {
  return [...siblingsForAllowlist(modelId), ...connectDiscoverySiblings(modelId)];
}

/**
 * Check if a model is allowed.
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function isModelAllowed(modelId) {
  if (_config.mode === 'all') return { allowed: true };

  if (_config.mode === 'allowlist') {
    if (_config.list.includes(modelId)) return { allowed: true };
    // Auto-inherit between base model and its -thinking variant so
    // users don't have to enumerate both halves of every reasoning
    // pair. Only base→thinking inheritance happens in practice (the
    // user typed `claude-opus-4.6` in the dashboard, the request asks
    // for `claude-opus-4.6-thinking`); the symmetric direction is
    // included for completeness.
    for (const sib of accessListSiblings(modelId)) {
      if (_config.list.includes(sib)) return { allowed: true };
    }
    return { allowed: false, reason: `模型 ${modelId} 不在允許清單中`, defaultModel: getDefaultModel() };
  }

  if (_config.mode === 'blocklist') {
    if (_config.list.includes(modelId)) {
      return { allowed: false, reason: `模型 ${modelId} 已被封鎖`, defaultModel: getDefaultModel() };
    }
    // Same inheritance for blocklist: blocking the base also blocks
    // the -thinking variant, so an operator who put `claude-opus-4.6`
    // on the blocklist isn't surprised by `-thinking` slipping past.
    for (const sib of accessListSiblings(modelId)) {
      if (_config.list.includes(sib)) {
        return { allowed: false, reason: `模型 ${modelId} 已被封鎖`, defaultModel: getDefaultModel() };
      }
    }
    return { allowed: true };
  }

  return { allowed: true };
}
