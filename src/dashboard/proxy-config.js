/**
 * Outbound proxy configuration manager.
 * Supports per-account and global HTTP proxy settings.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { config, log } from '../config.js';

const PROXY_FILE = join(config.dataDir, 'proxy.json');

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

// Passwords never leave the server. The masked view returns
// `hasPassword: boolean` in place of the plaintext. When the dashboard
// PUTs a config back it omits the `password` key if the user didn't
// retype it, which mergePassword() treats as "keep the stored value".
// An explicit empty string still clears the password.
function maskProxy(p) {
  if (!p) return p;
  const { password, ...rest } = p;
  return { ...rest, hasPassword: !!password };
}

function mergePassword(newCfg, oldCfg) {
  if (!newCfg || !Object.prototype.hasOwnProperty.call(newCfg, 'password')) {
    return oldCfg?.password || '';
  }
  return newCfg.password || '';
}

/** Full config including plaintext passwords — internal callers only. */
export function getProxyConfig() {
  return { ..._config };
}

/** Safe shape for dashboard / API consumers. */
export function getProxyConfigMasked() {
  return {
    global: maskProxy(_config.global),
    perAccount: Object.fromEntries(
      Object.entries(_config.perAccount).map(([k, v]) => [k, maskProxy(v)])
    ),
  };
}

export function setGlobalProxy(cfg) {
  _config.global = cfg && cfg.host ? {
    type: cfg.type || 'http',
    host: cfg.host,
    port: parseInt(cfg.port, 10) || 8080,
    username: cfg.username || '',
    password: mergePassword(cfg, _config.global),
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
      password: mergePassword(cfg, _config.perAccount[accountId]),
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
