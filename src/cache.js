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

export function isCacheEnabled() {
  const raw = String(process.env.RESPONSE_CACHE_ENABLED ?? process.env.WINDSURFAPI_RESPONSE_CACHE ?? '1')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

// Map preserves insertion order → we evict the oldest when over capacity.
const _store = new Map();
const _stats = { hits: 0, misses: 0, stores: 0, evictions: 0, skips: 0 };
let _bytes = 0;
let _generation = Symbol('response cache generation');

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

// Cache-key normalisation must be TOTAL: it runs on the RAW request body
// before any validation (the wrapper computes the original key first, by
// design — chat.js:2840), so every JSON value a client can actually send must
// produce a key rather than a throw. Non-object entries — a null part
// (`content:[null]`), a null message, a bare string/number — pass through
// unchanged; the shared tail guard rejects or the wire builder coerces them
// later. Before this guard, `content:[null]` from any caller with a
// trustworthy per-user scope threw
// `TypeError: Cannot read properties of null (reading 'type')` here and the
// route answered 500 before the guard could return its 400.
function normalizeBinary(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(m => {
    if (!m || typeof m !== 'object') return m;
    if (!Array.isArray(m.content)) return m;
    return { ...m, content: m.content.map(p => {
      if (!p || typeof p !== 'object') return p;
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
// JSON.parse accepts deeper nesting than an unguarded recursive clone can
// survive: a body nested ~10k deep parsed fine, then the clone overflowed the
// stack into a per-request RangeError. Same depth idiom as retainedBytes /
// SUB_DUMP_MAX_DEPTH (S4-D14). Literal stays inline: test harnesses evaluate
// function text without module scope.
function stableClone(value, depth = 0) {
  if (depth > 64) throw new Error('stableClone: value exceeds maximum nesting depth (64)');
  if (Array.isArray(value)) return value.map((v) => stableClone(v, depth + 1));
  if (value && typeof value === 'object') {
    // Null prototype: a JSON field literally named "__proto__" (valid in a
    // tools/response_format JSON Schema, e.g. a parameter of that name) is an
    // own property here. Plain `{}` would route the assignment through the
    // inherited __proto__ accessor, silently dropping the field so the key
    // collided with a schema that never had it. Sorting/ordering and the
    // serialized bytes for ordinary names are unchanged.
    const out = Object.create(null);
    for (const k of Object.keys(value).sort()) out[k] = stableClone(value[k], depth + 1);
    return out;
  }
  return value;
}

// The request cache and Chat's model/thinking selection must interpret the
// two effort spellings identically. Keep the router's existing truthy flat-
// then-nested precedence, followed by case/whitespace normalization.
export function resolveReasoningEffort(body) {
  try {
    return String(body?.reasoning_effort || body?.reasoning?.effort || '').toLowerCase().trim();
  } catch {
    // Keys are built before request validation. A malformed JSON object with
    // non-callable coercion properties must not make normalization throw.
    return '';
  }
}

function normalize(body, identity = null) {
  // The handler resolves the output-affecting routing decisions (model alias +
  // effort merge + thinking-sibling route; the connect sequential preference)
  // and threads them here. The key must describe the GENERATION the request
  // selects, not the raw client spelling: two accepted spellings can route to
  // different Cascade models while normalizing to one raw key, and a warm cache
  // would replay the first variant's answer for the second (BLUE-CACHE P2).
  // Only the dimensions the caller actually resolved are overridden — an
  // identity without `model` keeps the raw spelling, so non-routing callers
  // (tests, other handlers) hash exactly what they always did.
  const ident = identity && typeof identity === 'object' ? identity : null;
  return {
    model: ident && ident.model !== undefined ? ident.model : (body.model || ''),
    messages: normalizeBinary(body.messages || []),
    // tools / tool_choice / response_format / thinking / stream_options are
    // nested objects whose inner JSON-Schema key order is not canonical across
    // clients. Sort keys (same fix as logit_bias below, audit #10) so two
    // semantically-identical requests differing only in key order share a cache
    // slot instead of splitting it (a miss, never wrong data). Arrays keep order.
    tools: body.tools ? stableClone(body.tools) : null,
    tool_choice: body.tool_choice ? stableClone(body.tool_choice) : null,
    // Only the opt-in sequential preference changes the Connect encoder's
    // output. Off, true and omitted all retain the default policy and the
    // existing key bytes. The provider meaning of this field remains opt-in.
    ...(String(process.env.DEVIN_CONNECT_TOOL_CHOICE ?? '').trim() === '1' && body.parallel_tool_calls === false
      ? { parallel_tool_calls: false }
      : {}),
    response_format: body.response_format ? stableClone(body.response_format) : null,
    // With a routing identity the handler passes the ROUTER-CANONICAL effort
    // (normalizeReasoningEffortValue — the same canonical spelling the
    // router's mergeReasoningEffortIntoModel uses) so spellings that route
    // identically share the slot; the raw normalized spelling stays for
    // identity-less callers.
    reasoning_effort: ident && ident.effort !== undefined ? ident.effort : (resolveReasoningEffort(body) || null),
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
    // Routing-identity dimensions (identity callers only, so identity-less
    // keys stay byte-identical):
    //   - reasoning_mode: the thinking-sibling route already folds into the
    //     model override, but when NO sibling exists (or the opus-4.7 auto-route
    //     is disabled) wantThinking still changes output handling — it gates the
    //     thinking→text promotion (chat.js shouldFallbackThinkingToText). Two
    //     requests on the same base model with opposite reasoning modes can
    //     diverge there, so they must not share a slot.
    //   - parallel_tool_calls: the DEVIN_CONNECT encoder emits the sequential
    //     flag (#11) only when the passthrough is enabled AND the caller asked
    //     for `parallel_tool_calls:false`. The handler passes
    //     connectSequential:true exactly then; any other state (switch off,
    //     field absent/true) is default-equivalent on the wire and must keep
    //     sharing the slot — a miss, never a wrong replay.
    ...(ident && ident.thinking !== undefined ? { reasoning_mode: ident.thinking ? 'thinking' : 'plain' } : {}),
    ...(ident && ident.connectSequential === true ? { parallel_tool_calls: false } : {}),
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
 * `identity` (optional) carries the effective routed generation the handler
 * resolved for this body: `{ model, effort, thinking, connectSequential }`.
 * Lookup and store MUST pass the same identity — chat.js derives it from the
 * body alone, so both sides agree by construction. Omit it to hash the raw
 * request spelling (tests, non-routing callers).
 *
 * Implementation note: prefix the JSON with the caller scope and a
 * separator so two distinct callers can't collide by crafting bodies
 * that serialize to identical strings.
 */
export function cacheKey(body, callerKey = '', identity = null) {
  const scope = String(callerKey || '');
  const json = JSON.stringify(normalize(body, identity));
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

// Capture this before an asynchronous miss is dispatched.
export function cacheGeneration() {
  return _generation;
}

export function cacheSet(key, value, generation = _generation) {
  if (!isCacheEnabled()) return;
  // Don't cache empty or partial results
  if (!value || (!value.text && !(value.chunks && value.chunks.length))) return;
  const bytes = valueBytes(value);
  const limit = maxBytes();
  // A clear invalidates earlier misses, even when their response is delivered
  // successfully. Check here before deleting or accounting for any entry.
  if (generation !== _generation) return;
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
    eligibleLookups: total,
    hitRatePercent: total ? 100 * _stats.hits / total : null,
    hitRate: total > 0 ? ((_stats.hits / total) * 100).toFixed(1) : '0.0',
  };
}

export function cacheClear() {
  _generation = Symbol('response cache generation');
  _store.clear();
  _bytes = 0;
  _stats.hits = 0; _stats.misses = 0; _stats.stores = 0; _stats.evictions = 0; _stats.skips = 0;
  log.info('Response cache cleared');
}
