/**
 * Outbound proxy configuration manager.
 * Supports per-account and global HTTP proxy settings.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { log } from '../config.js';

const PROXY_FILE = join(process.cwd(), 'proxy.json');

const _config = {
  global: null,       // { type, host, port, username, password }
  perAccount: {},     // { accountId: { type, host, port, username, password } }
};

// Load
try {
  if (existsSync(PROXY_FILE)) {
    Object.assign(_config, JSON.parse(readFileSync(PROXY_FILE, 'utf-8')));
  }
} catch (e) {
  log.error('Failed to load proxy.json:', e.message);
}

function save() {
  try {
    writeFileSync(PROXY_FILE, JSON.stringify(_config, null, 2));
  } catch (e) {
    log.error('Failed to save proxy.json:', e.message);
  }
}

export function getProxyConfig() {
  return { ..._config };
}

export function setGlobalProxy(cfg) {
  _config.global = cfg && cfg.host ? {
    type: cfg.type || 'http',
    host: cfg.host,
    port: parseInt(cfg.port, 10) || 8080,
    username: cfg.username || '',
    password: cfg.password || '',
  } : null;
  save();
}

export function setAccountProxy(accountId, cfg) {
  if (cfg && cfg.host) {
    _config.perAccount[accountId] = {
      type: cfg.type || 'http',
      host: cfg.host,
      port: parseInt(cfg.port, 10) || 8080,
      username: cfg.username || '',
      password: cfg.password || '',
    };
  } else {
    delete _config.perAccount[accountId];
  }
  save();
}

export function removeProxy(scope, accountId) {
  if (scope === 'global') {
    _config.global = null;
  } else if (scope === 'account' && accountId) {
    delete _config.perAccount[accountId];
  }
  save();
}

/**
 * Get effective proxy for an account (per-account takes priority over global).
 */
export function getEffectiveProxy(accountId) {
  if (accountId && _config.perAccount[accountId]) {
    return _config.perAccount[accountId];
  }
  return _config.global;
}
