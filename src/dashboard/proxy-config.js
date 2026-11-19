/**
 * Outbound proxy configuration manager.
 * Supports per-account and global HTTP proxy settings.
 */

import { readFileSync, existsSync } from 'fs';
import { writeJsonAtomic, restrictFileToOwnerSync } from '../fs-atomic.js';
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
    writeJsonAtomic(PROXY_FILE, _config);
    // SEC-03 follow-up: proxy.json stores upstream proxy passwords in
    // cleartext. `mode: 0o600` is POSIX-only; on Windows the renamed file
    // keeps the inherited directory ACL (Users/Authenticated Users), so run
    // the same best-effort owner-only icacls pass as accounts.json.
    restrictFileToOwnerSync(PROXY_FILE, { warn: (m) => log.warn(m) });
  } catch (e) {
    log.error('Failed to save proxy.json:', e.message);
  }
}

// Passwords never leave the server. The masked view returns
// `hasPassword: boolean` in place of the plaintext. When the dashboard
// PUTs a config back it omits the `password` key if the user didn't
// retype it; mergePassword() keeps the stored value only while the
// normalized destination + username still match, and rejects the edit
// otherwise. An explicit empty string still clears the password.
function maskProxy(p) {
  if (!p) return p;
  const { password, ...rest } = p;
  return { ...rest, hasPassword: !!password };
}

// A retained password belongs to the proxy destination and username that were
// saved with it. Compare the tuple the transports actually dial:
// src/socks.js treats socks/socks5/socks5h as one SOCKS5 transport, while HTTP
// and HTTPS select different first hops; host names are case-insensitive.
const PROXY_PASSWORD_IDENTITY_CHANGED = 'ERR_PROXY_PASSWORD_IDENTITY_CHANGED';

function normalizeProxyType(type) {
  const t = String(type || 'http').trim().toLowerCase();
  return t === 'socks' || t === 'socks5h' ? 'socks5' : t;
}

function proxyIdentity(cfg, { legacy = false } = {}) {
  if (!cfg || !cfg.host) return null;
  const type = normalizeProxyType(cfg.type);
  const parsedPort = parseInt(cfg.port, 10);
  // The setters persist `parseInt(port) || 8080` for every type. A proxy.json
  // written before that (or edited by hand) can lack a port, and the transport
  // then falls back to 1080 for SOCKS5 and 8080 for HTTP CONNECT.
  const port = parsedPort || (legacy && type === 'socks5' ? 1080 : 8080);
  return {
    type,
    host: String(cfg.host).trim().toLowerCase(),
    port,
    username: typeof cfg.username === 'string' ? cfg.username : '',
  };
}

function sameProxyIdentity(a, b) {
  return !!a && !!b
    && a.type === b.type
    && a.host === b.host
    && a.port === b.port
    && a.username === b.username;
}

function mergePassword(newCfg, oldCfg) {
  if (newCfg && Object.prototype.hasOwnProperty.call(newCfg, 'password')) {
    return newCfg.password || '';
  }
  const oldPassword = oldCfg?.password || '';
  if (!oldPassword) return '';
  if (!sameProxyIdentity(proxyIdentity(newCfg), proxyIdentity(oldCfg, { legacy: true }))) {
    const err = new Error(
      `${PROXY_PASSWORD_IDENTITY_CHANGED}: proxy type, host, port or username changed; `
      + 'send the password explicitly, or send an explicit empty password to clear it.',
    );
    err.code = PROXY_PASSWORD_IDENTITY_CHANGED;
    err.statusCode = 400;
    throw err;
  }
  return oldPassword;
}

function buildProxyEntry(cfg, oldCfg) {
  // Build the complete entry before the caller assigns it: mergePassword() can
  // reject a changed identity, and a rejected edit must not leave a partially
  // updated in-memory config behind.
  return {
    type: cfg.type || 'http',
    host: String(cfg.host).trim(),
    port: parseInt(cfg.port, 10) || 8080,
    username: cfg.username || '',
    password: mergePassword(cfg, oldCfg),
  };
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
  _config.global = cfg && cfg.host ? buildProxyEntry(cfg, _config.global) : null;
  save();
}

export function setAccountProxy(accountId, cfg) {
  if (cfg && cfg.host) {
    _config.perAccount[accountId] = buildProxyEntry(cfg, _config.perAccount[accountId]);
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
