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
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function isCacheEnabled() {
  const raw = String(process.env.RESPONSE_CACHE_ENABLED ?? process.env.WINDSURFAPI_RESPONSE_CACHE ?? '1')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

// Map preserves insertion order → we evict the oldest when over capacity.
const _store = new Map();
const _stats = { hits: 0, misses: 0, stores: 0, evictions: 0, skips: 0 };
let _bytes = 0;

function bytesEnv(names, fallback) {
  for (const name of names) {
    const raw = String(process.env[name] || '').trim();
    if (!raw) continue;
    const m = raw.match(/^(\d+(?:\.\d+)?)\s*(b|kb|kib|k|mb|mib|m|gb|gib|g)?$/i);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const unit = (m[2] || 'b').toLowerCase();
    const mul = unit === 'gb' || unit === 'gib' || unit === 'g' ? 1024 ** 3
      : unit === 'mb' || unit === 'mib' || unit === 'm' ? 1024 ** 2
        : unit === 'kb' || unit === 'kib' || unit === 'k' ? 1024
          : 1;
    return Math.floor(n * mul);
  }
  return fallback;
}

function maxBytes() {
  return bytesEnv(
    ['RESPONSE_CACHE_MAX_BYTES', 'WINDSURFAPI_RESPONSE_CACHE_MAX_BYTES'],
    DEFAULT_MAX_BYTES
  );
}

function valueBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function deleteEntry(key) {
  const entry = _store.get(key);
  if (!entry) return false;
  _store.delete(key);
  _bytes = Math.max(0, _bytes - (Number(entry.bytes) || 0));
  return true;
}

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

// Deep, key-sorted clone so structurally-equal objects serialize to the same
// string regardless of key insertion order. JSON.stringify preserves insertion
// order, so `{"50256":-100,"100":1}` and `{"100":1,"50256":-100}` — the SAME
// logit_bias map — hashed to different cache keys and split the slot, silently
// halving the hit rate (never wrong data, just a miss). Arrays keep their order
// (order is semantic there); only object keys are sorted. (audit #10)
function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = stableClone(value[k]);
    return out;
  }
  return value;
}

function normalize(body) {
  return {
    model: body.model || '',
    messages: normalizeBinary(body.messages || []),
    // tools / tool_choice / response_format / thinking / stream_options are
    // nested objects whose inner JSON-Schema key order is not canonical across
    // clients. Sort keys (same fix as logit_bias below, audit #10) so two
    // semantically-identical requests differing only in key order share a cache
    // slot instead of splitting it (a miss, never wrong data). Arrays keep order.
    tools: body.tools ? stableClone(body.tools) : null,
    tool_choice: body.tool_choice ? stableClone(body.tool_choice) : null,
    response_format: body.response_format ? stableClone(body.response_format) : null,
    // cache-01: resolve the reasoning effort the SAME way the router does
    // (chat.js mergeReasoningEffortIntoModel: reasoning_effort || reasoning.effort).
    // The nested `reasoning:{effort}` form (codex CLI, OpenAI Responses) merges
    // into the model id before routing but never mutates body.model, so keying
    // only the flat field collapsed two different reasoning tiers into one slot →
    // the second request got the first's wrong-tier answer.
    reasoning_effort: (body.reasoning_effort ?? body.reasoning?.effort) ?? null,
    thinking: body.thinking ? stableClone(body.thinking) : null,
    stream_options: body.stream_options ? stableClone(body.stream_options) : null,
    temperature: body.temperature ?? null,
    top_p: body.top_p ?? null,
    // top_k is a live sampling knob on the DEVIN_CONNECT completion config
    // (chat.js reads body.top_k → completionOverrides.topK; messages.js threads
    // the Anthropic-side top_k through). Omitting it from the key meant two
    // requests differing ONLY in top_k shared a cache slot → the second got a
    // reply sampled under the first's top_k. (audit #9)
    top_k: body.top_k ?? null,
    // O3: resolve max_completion_tokens (modern OpenAI spelling) with the same
    // precedence handleChatCompletions uses, so the two field names collapse to
    // one cache dimension — a request sending max_completion_tokens:N and one
    // sending max_tokens:N are the same generation and share a cache slot, while
    // differing caps still key apart.
    max_tokens: (Number.isFinite(body.max_completion_tokens) ? body.max_completion_tokens : body.max_tokens) ?? null,
    // Output-affecting params — omitting these served a response generated
    // under a different stop/seed/penalty config for an otherwise-identical
    // body. `stop` is set from Anthropic stop_sequences in messages.js.
    stop: body.stop ?? null,
    seed: body.seed ?? null,
    frequency_penalty: body.frequency_penalty ?? null,
    presence_penalty: body.presence_penalty ?? null,
    // logit_bias is a token-id→bias map with no canonical key order; sort keys
    // so two key-order-permuted-but-equal maps land in the same cache slot (#10).
    logit_bias: body.logit_bias ? stableClone(body.logit_bias) : null,
    n: body.n ?? null,
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
    deleteEntry(key);
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
  const bytes = valueBytes(value);
  const limit = maxBytes();
  deleteEntry(key);
  if (!Number.isFinite(bytes) || bytes > limit) {
    _stats.skips++;
    return;
  }
  _store.set(key, { value, expiresAt: Date.now() + TTL_MS, bytes });
  _bytes += bytes;
  _stats.stores++;
  while (_store.size > MAX_ENTRIES || _bytes > limit) {
    const oldest = _store.keys().next().value;
    if (oldest === undefined) break;
    deleteEntry(oldest);
    _stats.evictions++;
  }
}

export function cacheStats() {
  const total = _stats.hits + _stats.misses;
  return {
    enabled: isCacheEnabled(),
    size: _store.size,
    maxSize: MAX_ENTRIES,
    bytes: _bytes,
    maxBytes: maxBytes(),
    ttlMs: TTL_MS,
    hits: _stats.hits,
    misses: _stats.misses,
    stores: _stats.stores,
    evictions: _stats.evictions,
    skips: _stats.skips,
    hitRate: total > 0 ? ((_stats.hits / total) * 100).toFixed(1) : '0.0',
  };
}

export function cacheClear() {
  _store.clear();
  _bytes = 0;
  _stats.hits = 0; _stats.misses = 0; _stats.stores = 0; _stats.evictions = 0; _stats.skips = 0;
  log.info('Response cache cleared');
}
