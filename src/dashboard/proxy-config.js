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

function boundedSocksUsername(username) {
  // RFC 1929 carries the username length in one byte. Do not pass arbitrary
  // JSON array-like objects to Buffer.from: a { length: ... } value would
  // otherwise allocate that many bytes during a mere configuration edit.
  const maxBytes = 255;
  let input = username;
  if (typeof input === 'string') {
    if (input.length > maxBytes || Buffer.byteLength(input, 'utf8') > maxBytes) return null;
  } else {
    if (!Buffer.isBuffer(input) && !Array.isArray(input)) {
      if (input?.type !== 'Buffer' || !Array.isArray(input.data)) return null;
      input = input.data;
    }
    if (input.length > maxBytes) return null;
  }
  return Buffer.from(input).toString('hex');
}

function proxyIdentity(cfg, { legacy = false } = {}) {
  if (!cfg || !cfg.host) return null;
  const type = normalizeProxyType(cfg.type);
  if (legacy && cfg.port && (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535)) {
    // Current setters save numbers. For old raw JSON, parseInt('0x1f91', 10)
    // gives 0 while the HTTP connector's Number(...) dials 8081; SOCKS also
    // accepts a different net.connect overload for string values. Require an
    // explicit password instead of guessing which endpoint owned the secret.
    return null;
  }
  if (legacy && !cfg.port && type === 'socks5') {
    // A portless legacy SOCKS entry means 1080 to the direct SOCKS client but
    // 8080 in the LS proxy URL. No new numeric port preserves both consumers.
    return null;
  }
  const parsedPort = parseInt(cfg.port, 10);
  // The setters persist this numeric default for every type. A portless old
  // HTTP/HTTPS entry also means 8080 in both the connector and LS proxy URL.
  const port = parsedPort || 8080;
  const host = String(cfg.host).trim();
  const username = cfg.username || '';
  let usernameText;
  let socksUsername = null;
  try {
    // HTTP Basic and the LS proxy URL stringify the value, while the direct
    // SOCKS transport encodes Buffer.from(value). JSON arrays and Buffer-shaped
    // objects can have the same text but different SOCKS authentication bytes.
    if (type === 'socks5' && username) {
      socksUsername = boundedSocksUsername(username);
      if (socksUsername === null) return null;
    }
    usernameText = String(username);
  } catch {
    // An unencodable identity cannot safely inherit a previously saved secret.
    return null;
  }
  return {
    type,
    // A scoped IPv6 literal contains an interface/zone identifier, not only a
    // case-insensitive DNS name. Preserve that spelling when binding a secret.
    host: host.includes('%') ? host : host.toLowerCase(),
    port,
    username: usernameText,
    // Empty arrays are truthy and enable authentication even though their
    // text is empty; an empty string sends no authentication at all.
    authenticates: !!username,
    socksUsername,
  };
}

function sameProxyIdentity(a, b) {
  return !!a && !!b
    && a.type === b.type
    && a.host === b.host
    && a.port === b.port
    && a.username === b.username
    && a.authenticates === b.authenticates
    && a.socksUsername === b.socksUsername;
}

function mergePassword(newCfg, oldCfg) {
  if (newCfg && Object.prototype.hasOwnProperty.call(newCfg, 'password')) {
    return newCfg.password || '';
  }
  const oldPassword = oldCfg?.password || '';
  if (!oldPassword) return '';
  if (!sameProxyIdentity(proxyIdentity(newCfg), proxyIdentity(oldCfg, { legacy: true }))) {
    const err = new Error(
      `${PROXY_PASSWORD_IDENTITY_CHANGED}: proxy type, host, port or username changed or could not be verified; `
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
