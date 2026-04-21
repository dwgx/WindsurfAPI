/**
 * Model access control — allow/block specific models.
 * Persisted to model-access.json.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { log } from '../config.js';

const ACCESS_FILE = join(process.cwd(), 'model-access.json');

// mode: 'allowlist' (only listed models allowed) | 'blocklist' (listed models blocked) | 'all' (no restrictions)
const _config = {
  mode: 'all',
  list: [],          // model IDs in the list
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
    writeFileSync(ACCESS_FILE, JSON.stringify(_config, null, 2));
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
 * Check if a model is allowed.
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function isModelAllowed(modelId) {
  if (_config.mode === 'all') return { allowed: true };

  if (_config.mode === 'allowlist') {
    const allowed = _config.list.includes(modelId);
    return allowed
      ? { allowed: true }
      : { allowed: false, reason: `模型 ${modelId} 不在允許清單中` };
  }

  if (_config.mode === 'blocklist') {
    const blocked = _config.list.includes(modelId);
    return blocked
      ? { allowed: false, reason: `模型 ${modelId} 已被封鎖` }
      : { allowed: true };
  }

  return { allowed: true };
}
