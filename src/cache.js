/**
 * Local response cache for chat completions.
 *
 * Cascade/Windsurf upstream does not expose Anthropic-style prompt caching,
 * so we add an in-memory, exact-match cache keyed on the normalized request
 * body. This only helps with duplicate requests (Claude Code retries, parallel
 * identical calls), not prefix-caching.
 */

import { createHash } from 'crypto';
import { log } from './config.js';

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 500;

function isCacheEnabled() {
  const raw = String(process.env.RESPONSE_CACHE_ENABLED ?? process.env.WINDSURFAPI_RESPONSE_CACHE ?? '1')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

// Map preserves insertion order → we evict the oldest when over capacity.
const _store = new Map();
const _stats = { hits: 0, misses: 0, stores: 0, evictions: 0 };

function digestBase64Data(data = '', mime = '') {
  const compact = String(data).replace(/\s/g, '');
  const bytes = Math.floor(compact.length * 3 / 4) - (compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0);
  const hash = createHash('sha256').update(compact).digest('hex').slice(0, 32);
  return `[base64:${String(mime || 'application/octet-stream').toLowerCase()}:sha256=${hash}:bytes=${Math.max(0, bytes)}]`;
}

function normalizeDataUrl(url) {
  const clean = String(url || '').replace(/\s/g, '');
  const m = clean.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/i);
  if (!m) return url;
  return `data:${m[1].toLowerCase()};base64,${digestBase64Data(m[2], m[1])}`;
}

function normalizeBinary(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(m => {
    if (!Array.isArray(m.content)) return m;
    return { ...m, content: m.content.map(p => {
      if (p.type === 'image_url' && typeof p.image_url?.url === 'string' && p.image_url.url.startsWith('data:'))
        return { ...p, image_url: { ...p.image_url, url: normalizeDataUrl(p.image_url.url) } };
      if (p.type === 'image' && p.source?.type === 'base64')
        return { ...p, source: { ...p.source, data: digestBase64Data(p.source.data, p.source.media_type) } };
      if ((p.type === 'file' || p.type === 'input_file') && typeof p.file?.file_data === 'string' && p.file.file_data.startsWith('data:'))
        return { ...p, file: { ...p.file, file_data: normalizeDataUrl(p.file.file_data) } };
      return p;
    })};
  });
}

function normalize(body) {
  return {
    model: body.model || '',
    messages: normalizeBinary(body.messages || []),
    tools: body.tools || null,
    tool_choice: body.tool_choice || null,
    response_format: body.response_format || null,
    reasoning_effort: body.reasoning_effort ?? null,
    thinking: body.thinking || null,
    stream_options: body.stream_options || null,
    temperature: body.temperature ?? null,
    top_p: body.top_p ?? null,
    max_tokens: body.max_tokens ?? null,
  };
}

/**
 * Build a cache key for a chat request.
 *
 * `callerKey` is required to scope the cache to the specific upstream
 * tenant — earlier versions hashed only the request body, which let one
 * caller's "hi" return another caller's cached response from the same
 * model. Pass an empty string only for tests; production callers must
 * thread the request's authenticated callerKey through.
 *
 * Implementation note: prefix the JSON with the caller scope and a
 * separator so two distinct callers can't collide by crafting bodies
 * that serialize to identical strings.
 */
export function cacheKey(body, callerKey = '') {
  const scope = String(callerKey || '');
  const json = JSON.stringify(normalize(body));
  return createHash('sha256').update(scope).update('\0').update(json).digest('hex');
}

export function cacheGet(key) {
  if (!isCacheEnabled()) return null;
  const entry = _store.get(key);
  if (!entry) { _stats.misses++; return null; }
  if (entry.expiresAt < Date.now()) {
    _store.delete(key);
    _stats.misses++;
    return null;
  }
  // Refresh LRU position
  _store.delete(key);
  _store.set(key, entry);
  _stats.hits++;
  return entry.value;
}

export function cacheSet(key, value) {
  if (!isCacheEnabled()) return;
  // Don't cache empty or partial results
  if (!value || (!value.text && !(value.chunks && value.chunks.length))) return;
  _store.set(key, { value, expiresAt: Date.now() + TTL_MS });
  _stats.stores++;
  while (_store.size > MAX_ENTRIES) {
    const oldest = _store.keys().next().value;
    _store.delete(oldest);
    _stats.evictions++;
  }
}

export function cacheStats() {
  const total = _stats.hits + _stats.misses;
  return {
    enabled: isCacheEnabled(),
    size: _store.size,
    maxSize: MAX_ENTRIES,
    ttlMs: TTL_MS,
    hits: _stats.hits,
    misses: _stats.misses,
    stores: _stats.stores,
    evictions: _stats.evictions,
    hitRate: total > 0 ? ((_stats.hits / total) * 100).toFixed(1) : '0.0',
  };
}

export function cacheClear() {
  _store.clear();
  _stats.hits = 0; _stats.misses = 0; _stats.stores = 0; _stats.evictions = 0;
  log.info('Response cache cleared');
}
