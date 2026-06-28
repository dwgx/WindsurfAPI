/**
 * Model access control — allow/block specific models.
 * Persisted to model-access.json.
 */

import { readFileSync, existsSync } from 'fs';
import { writeJsonAtomic } from '../fs-atomic.js';
import { join } from 'path';
import { config, log } from '../config.js';

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

function save() {
  try {
    writeJsonAtomic(ACCESS_FILE, _config);
  } catch (e) {
    log.error('Failed to save model-access.json:', e.message);
  }
}

export function getModelAccessConfig() {
  return { ..._config };
}

export function setModelAccessMode(mode) {
  if (!['all', 'allowlist', 'blocklist'].includes(mode)) return;
  _config.mode = mode;
  save();
}

export function setModelAccessList(list) {
  _config.list = Array.isArray(list) ? list : [];
  save();
}

export function addModelToList(modelId) {
  if (!_config.list.includes(modelId)) {
    _config.list.push(modelId);
    save();
  }
}

export function removeModelFromList(modelId) {
  _config.list = _config.list.filter(m => m !== modelId);
  save();
}

/**
 * Fallback model for requests whose model is not on the allowlist (or is on
 * the blocklist). When set, isModelAllowed() surfaces it so the chat handler
 * can retarget the request instead of returning a hard rejection. Empty
 * string means "reject", which is the safe default.
 */
export function setDefaultModel(modelId) {
  _config.defaultModel = typeof modelId === 'string' ? modelId.trim() : '';
  save();
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
    for (const sib of siblingsForAllowlist(modelId)) {
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
    for (const sib of siblingsForAllowlist(modelId)) {
      if (_config.list.includes(sib)) {
        return { allowed: false, reason: `模型 ${modelId} 已被封鎖`, defaultModel: getDefaultModel() };
      }
    }
    return { allowed: true };
  }

  return { allowed: true };
}
