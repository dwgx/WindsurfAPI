/**
 * Durable Codex-style sticky routing.
 *
 * This complements the in-memory Cascade conversation pool: sticky sessions
 * decide which account should serve a downstream Codex/OpenAI session, while
 * the Cascade pool decides whether a specific upstream cascade_id can be
 * resumed once that account/LS pair is selected.
 */

import { createHash, randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { writeJsonAtomic } from './fs-atomic.js';
import { config, log } from './config.js';
import { getCodexSettings } from './runtime-config.js';

const FILE = join(config.sharedDataDir || config.dataDir, 'sticky-sessions.json');
const VALID_KINDS = new Set(['codex_session', 'prompt_cache', 'sticky_thread']);
const MAX_ENTRIES = 5000;

const _state = {
  version: 1,
  entries: {},
  stats: { hits: 0, misses: 0, stores: 0, evictions: 0, expired: 0 },
};

function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function short(value, n = 12) {
  return sha256(value).slice(0, n);
}

function load() {
  if (!existsSync(FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf-8'));
    if (raw && typeof raw === 'object') {
      if (raw.entries && typeof raw.entries === 'object') _state.entries = raw.entries;
      if (raw.stats && typeof raw.stats === 'object') _state.stats = { ..._state.stats, ...raw.stats };
    }
  } catch (e) {
    log.warn(`sticky-sessions: failed to load ${FILE}: ${e.message}`);
  }
}

function persist() {
  try {
    writeJsonAtomic(FILE, _state);
  } catch (e) {
    log.warn(`sticky-sessions: failed to persist: ${e.message}`);
  }
}

load();

function normalizeHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const value = Array.isArray(v) ? v[0] : v;
    if (value != null) out[String(k).toLowerCase()] = String(value);
  }
  return out;
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function promptCacheKeyFromBody(body = {}) {
  return cleanString(body.prompt_cache_key)
    || cleanString(body.promptCacheKey)
    || cleanString(body?.metadata?.prompt_cache_key)
    || cleanString(body?.metadata?.promptCacheKey);
}

function firstUserText(body = {}) {
  const input = body.input ?? body.messages;
  if (typeof input === 'string') return input.slice(0, 512);
  if (!Array.isArray(input)) return '';
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.role && item.role !== 'user') continue;
    const content = item.content ?? item.text ?? item.input;
    if (typeof content === 'string') return content.slice(0, 512);
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'string') return part.slice(0, 512);
        if (typeof part?.text === 'string') return part.text.slice(0, 512);
      }
    }
  }
  return '';
}

function derivePromptCacheKey(body = {}, callerKey = '') {
  const parts = [];
  const model = cleanString(body.model);
  if (model) parts.push(model.includes('codex') ? 'codex' : model.includes('mini') ? 'mini' : 'std');
  if (callerKey) parts.push(short(callerKey));
  if (body.instructions) parts.push(short(String(body.instructions).slice(0, 512)));
  const first = firstUserText(body);
  if (first) parts.push(short(first));
  return parts.length ? parts.join('-') : `anon-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function sessionKeyFromHeaders(headers = {}) {
  const h = normalizeHeaders(headers);
  return cleanString(h['x-codex-turn-state'])
    || cleanString(h.session_id)
    || cleanString(h['x-codex-session-id'])
    || cleanString(h['x-codex-conversation-id'])
    || cleanString(h['x-session-id']);
}

function entryId(sticky) {
  return sha256(`${sticky.scope || ''}\0${sticky.kind}\0${sticky.key}`);
}

function pruneExpired(now = Date.now()) {
  let removed = 0;
  for (const [id, entry] of Object.entries(_state.entries)) {
    if (!entry || !entry.maxAgeSeconds) continue;
    if ((entry.updatedAt || 0) + entry.maxAgeSeconds * 1000 < now) {
      delete _state.entries[id];
      removed++;
    }
  }
  if (removed) {
    _state.stats.expired += removed;
    persist();
  }
  return removed;
}

function evictIfNeeded() {
  const entries = Object.entries(_state.entries);
  if (entries.length <= MAX_ENTRIES) return 0;
  entries.sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
  const removeCount = entries.length - MAX_ENTRIES;
  for (let i = 0; i < removeCount; i++) delete _state.entries[entries[i][0]];
  _state.stats.evictions += removeCount;
  return removeCount;
}

export function buildStickyContext(body = {}, headers = {}, callerKey = '') {
  const settings = getCodexSettings();
  if (!settings.stickySessionsEnabled) return null;
  const mode = settings.stickySessionMode || 'auto';
  if (mode === 'off') return null;

  const headerKey = sessionKeyFromHeaders(headers);
  const explicitPromptKey = promptCacheKeyFromBody(body);
  const promptKey = explicitPromptKey
    || (settings.derivePromptCacheKey ? derivePromptCacheKey(body, callerKey) : '');

  let kind = null;
  let key = '';
  if (mode === 'auto') {
    if (headerKey) {
      kind = 'codex_session';
      key = headerKey;
    } else if (promptKey) {
      kind = 'prompt_cache';
      key = promptKey;
    }
  } else {
    kind = mode;
    key = kind === 'codex_session' ? (headerKey || promptKey) : (promptKey || headerKey);
  }
  if (!key || !VALID_KINDS.has(kind)) return null;

  const maxAgeSeconds = kind === 'prompt_cache'
    ? Math.max(1, parseInt(settings.promptCacheMaxAgeSeconds || 1800, 10))
    : 0;
  return {
    key,
    kind,
    scope: callerKey || '',
    keyHash: short(key, 16),
    maxAgeSeconds,
    reallocate: !!settings.reallocateSticky || kind === 'sticky_thread',
  };
}

export function getStickyAccountId(sticky) {
  if (!sticky?.key || !sticky?.kind) return null;
  pruneExpired();
  const id = entryId(sticky);
  const entry = _state.entries[id];
  if (!entry) {
    _state.stats.misses++;
    return null;
  }
  if (entry.maxAgeSeconds && (entry.updatedAt || 0) + entry.maxAgeSeconds * 1000 < Date.now()) {
    delete _state.entries[id];
    _state.stats.expired++;
    _state.stats.misses++;
    persist();
    return null;
  }
  _state.stats.hits++;
  return entry.accountId || null;
}

export function bindStickyAccount(sticky, accountId, options = {}) {
  if (!sticky?.key || !sticky?.kind || !accountId) return false;
  const id = entryId(sticky);
  const existing = _state.entries[id];
  if (options.preserveExisting && existing && existing.accountId && existing.accountId !== accountId) {
    return false;
  }
  const now = Date.now();
  _state.entries[id] = {
    id,
    kind: sticky.kind,
    keyHash: sticky.keyHash || short(sticky.key, 16),
    scopeHash: sticky.scope ? short(sticky.scope, 16) : '',
    accountId,
    maxAgeSeconds: sticky.maxAgeSeconds || 0,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  _state.stats.stores++;
  evictIfNeeded();
  persist();
  return true;
}

export function shouldPreserveStickyFallback(sticky, existingAccountId, chosenAccountId) {
  if (!sticky || !existingAccountId || !chosenAccountId) return false;
  if (existingAccountId === chosenAccountId) return false;
  if (sticky.reallocate) return false;
  return sticky.kind === 'prompt_cache';
}

export function stickyStats() {
  pruneExpired();
  const total = _state.stats.hits + _state.stats.misses;
  return {
    enabled: getCodexSettings().stickySessionsEnabled,
    size: Object.keys(_state.entries).length,
    maxSize: MAX_ENTRIES,
    ..._state.stats,
    hitRate: total ? ((_state.stats.hits / total) * 100).toFixed(1) : '0.0',
  };
}

export function clearStickySessions() {
  const n = Object.keys(_state.entries).length;
  _state.entries = {};
  persist();
  return n;
}
