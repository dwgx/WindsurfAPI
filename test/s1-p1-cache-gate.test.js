import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const readSource = path => readFileSync(new URL(path, ROOT), 'utf8').replace(/\r\n/g, '\n');

function functionText(source, name, optional = false) {
  const start = new RegExp('^(?:export )?(?:async )?function ' + name + '\\(', 'm').exec(source);
  if (!start) {
    if (optional) return '';
    throw new Error('Missing function: ' + name);
  }
  const tail = source.slice(start.index);
  const end = /^\}/m.exec(tail);
  if (!end) throw new Error('Missing function end: ' + name);
  return tail.slice(0, end.index + 1).replace(/^export /, '') + '\n';
}

function withoutModuleSyntax(source) {
  return source
    .replace(/^import\s[\s\S]*?;\n/gm, '')
    .replace(/^export\s*\{[\s\S]*?;\n/gm, '')
    .replace(/^export (?=(?:async )?function|class|const|let)/gm, '');
}

function evaluate(source, names, globals = {}) {
  return runInNewContext(
    withoutModuleSyntax(source) + '\n;({ ' + names.join(', ') + ' });',
    { Buffer, console, process: { env: {} }, log: quietLog, ...globals },
    { timeout: 10000 },
  );
}
const plain = value => JSON.parse(JSON.stringify(value));

const CACHE_014204F = "/**\n * Local response cache for chat completions.\n *\n * Cascade/Windsurf upstream does not expose Anthropic-style prompt caching,\n * so we add an in-memory, exact-match cache keyed on the normalized request\n * body. This only helps with duplicate requests (Claude Code retries, parallel\n * identical calls), not prefix-caching.\n */\n\nimport { createHash } from 'crypto';\nimport { log } from './config.js';\n\nconst TTL_MS = 5 * 60 * 1000;\nconst MAX_ENTRIES = 500;\nconst DEFAULT_MAX_BYTES = 16 * 1024 * 1024;\n\nfunction isCacheEnabled() {\n  const raw = String(process.env.RESPONSE_CACHE_ENABLED ?? process.env.WINDSURFAPI_RESPONSE_CACHE ?? '1')\n    .trim()\n    .toLowerCase();\n  return !['0', 'false', 'off', 'no'].includes(raw);\n}\n\n// Map preserves insertion order → we evict the oldest when over capacity.\nconst _store = new Map();\nconst _stats = { hits: 0, misses: 0, stores: 0, evictions: 0, skips: 0 };\nlet _bytes = 0;\n\nfunction bytesEnv(names, fallback) {\n  for (const name of names) {\n    const raw = String(process.env[name] || '').trim();\n    if (!raw) continue;\n    const m = raw.match(/^(\\d+(?:\\.\\d+)?)\\s*(b|kb|kib|k|mb|mib|m|gb|gib|g)?$/i);\n    if (!m) continue;\n    const n = Number(m[1]);\n    if (!Number.isFinite(n) || n <= 0) continue;\n    const unit = (m[2] || 'b').toLowerCase();\n    const mul = unit === 'gb' || unit === 'gib' || unit === 'g' ? 1024 ** 3\n      : unit === 'mb' || unit === 'mib' || unit === 'm' ? 1024 ** 2\n        : unit === 'kb' || unit === 'kib' || unit === 'k' ? 1024\n          : 1;\n    return Math.floor(n * mul);\n  }\n  return fallback;\n}\n\nfunction maxBytes() {\n  return bytesEnv(\n    ['RESPONSE_CACHE_MAX_BYTES', 'WINDSURFAPI_RESPONSE_CACHE_MAX_BYTES'],\n    DEFAULT_MAX_BYTES\n  );\n}\n\nfunction valueBytes(value) {\n  try {\n    return Buffer.byteLength(JSON.stringify(value), 'utf8');\n  } catch {\n    return Number.POSITIVE_INFINITY;\n  }\n}\n\nfunction deleteEntry(key) {\n  const entry = _store.get(key);\n  if (!entry) return false;\n  _store.delete(key);\n  _bytes = Math.max(0, _bytes - (Number(entry.bytes) || 0));\n  return true;\n}\n\nfunction digestBase64Data(data = '', mime = '') {\n  const compact = String(data).replace(/\\s/g, '');\n  const bytes = Math.floor(compact.length * 3 / 4) - (compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0);\n  const hash = createHash('sha256').update(compact).digest('hex').slice(0, 32);\n  return `[base64:${String(mime || 'application/octet-stream').toLowerCase()}:sha256=${hash}:bytes=${Math.max(0, bytes)}]`;\n}\n\nfunction normalizeDataUrl(url) {\n  const clean = String(url || '').replace(/\\s/g, '');\n  const m = clean.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/i);\n  if (!m) return url;\n  return `data:${m[1].toLowerCase()};base64,${digestBase64Data(m[2], m[1])}`;\n}\n\nfunction normalizeBinary(messages) {\n  if (!Array.isArray(messages)) return messages;\n  return messages.map(m => {\n    if (!Array.isArray(m.content)) return m;\n    return { ...m, content: m.content.map(p => {\n      if (p.type === 'image_url' && typeof p.image_url?.url === 'string' && p.image_url.url.startsWith('data:'))\n        return { ...p, image_url: { ...p.image_url, url: normalizeDataUrl(p.image_url.url) } };\n      if (p.type === 'image' && p.source?.type === 'base64')\n        return { ...p, source: { ...p.source, data: digestBase64Data(p.source.data, p.source.media_type) } };\n      if ((p.type === 'file' || p.type === 'input_file') && typeof p.file?.file_data === 'string' && p.file.file_data.startsWith('data:'))\n        return { ...p, file: { ...p.file, file_data: normalizeDataUrl(p.file.file_data) } };\n      return p;\n    })};\n  });\n}\n\n// Deep, key-sorted clone so structurally-equal objects serialize to the same\n// string regardless of key insertion order. JSON.stringify preserves insertion\n// order, so `{\"50256\":-100,\"100\":1}` and `{\"100\":1,\"50256\":-100}` — the SAME\n// logit_bias map — hashed to different cache keys and split the slot, silently\n// halving the hit rate (never wrong data, just a miss). Arrays keep their order\n// (order is semantic there); only object keys are sorted. (audit #10)\nfunction stableClone(value) {\n  if (Array.isArray(value)) return value.map(stableClone);\n  if (value && typeof value === 'object') {\n    const out = {};\n    for (const k of Object.keys(value).sort()) out[k] = stableClone(value[k]);\n    return out;\n  }\n  return value;\n}\n\nfunction normalize(body) {\n  return {\n    model: body.model || '',\n    messages: normalizeBinary(body.messages || []),\n    // tools / tool_choice / response_format / thinking / stream_options are\n    // nested objects whose inner JSON-Schema key order is not canonical across\n    // clients. Sort keys (same fix as logit_bias below, audit #10) so two\n    // semantically-identical requests differing only in key order share a cache\n    // slot instead of splitting it (a miss, never wrong data). Arrays keep order.\n    tools: body.tools ? stableClone(body.tools) : null,\n    tool_choice: body.tool_choice ? stableClone(body.tool_choice) : null,\n    response_format: body.response_format ? stableClone(body.response_format) : null,\n    // cache-01: resolve the reasoning effort the SAME way the router does\n    // (chat.js mergeReasoningEffortIntoModel: reasoning_effort || reasoning.effort).\n    // The nested `reasoning:{effort}` form (codex CLI, OpenAI Responses) merges\n    // into the model id before routing but never mutates body.model, so keying\n    // only the flat field collapsed two different reasoning tiers into one slot →\n    // the second request got the first's wrong-tier answer.\n    reasoning_effort: (body.reasoning_effort ?? body.reasoning?.effort) ?? null,\n    thinking: body.thinking ? stableClone(body.thinking) : null,\n    stream_options: body.stream_options ? stableClone(body.stream_options) : null,\n    temperature: body.temperature ?? null,\n    top_p: body.top_p ?? null,\n    // top_k is a live sampling knob on the DEVIN_CONNECT completion config\n    // (chat.js reads body.top_k → completionOverrides.topK; messages.js threads\n    // the Anthropic-side top_k through). Omitting it from the key meant two\n    // requests differing ONLY in top_k shared a cache slot → the second got a\n    // reply sampled under the first's top_k. (audit #9)\n    top_k: body.top_k ?? null,\n    // O3: resolve max_completion_tokens (modern OpenAI spelling) with the same\n    // precedence handleChatCompletions uses, so the two field names collapse to\n    // one cache dimension — a request sending max_completion_tokens:N and one\n    // sending max_tokens:N are the same generation and share a cache slot, while\n    // differing caps still key apart.\n    max_tokens: (Number.isFinite(body.max_completion_tokens) ? body.max_completion_tokens : body.max_tokens) ?? null,\n    // Output-affecting params — omitting these served a response generated\n    // under a different stop/seed/penalty config for an otherwise-identical\n    // body. `stop` is set from Anthropic stop_sequences in messages.js.\n    stop: body.stop ?? null,\n    seed: body.seed ?? null,\n    frequency_penalty: body.frequency_penalty ?? null,\n    presence_penalty: body.presence_penalty ?? null,\n    // logit_bias is a token-id→bias map with no canonical key order; sort keys\n    // so two key-order-permuted-but-equal maps land in the same cache slot (#10).\n    logit_bias: body.logit_bias ? stableClone(body.logit_bias) : null,\n    n: body.n ?? null,\n  };\n}\n\n/**\n * Build a cache key for a chat request.\n *\n * `callerKey` is required to scope the cache to the specific upstream\n * tenant — earlier versions hashed only the request body, which let one\n * caller's \"hi\" return another caller's cached response from the same\n * model. Pass an empty string only for tests; production callers must\n * thread the request's authenticated callerKey through.\n *\n * Implementation note: prefix the JSON with the caller scope and a\n * separator so two distinct callers can't collide by crafting bodies\n * that serialize to identical strings.\n */\nexport function cacheKey(body, callerKey = '') {\n  const scope = String(callerKey || '');\n  const json = JSON.stringify(normalize(body));\n  return createHash('sha256').update(scope).update('\\0').update(json).digest('hex');\n}\n\nexport function cacheGet(key) {\n  if (!isCacheEnabled()) return null;\n  const entry = _store.get(key);\n  if (!entry) { _stats.misses++; return null; }\n  if (entry.expiresAt < Date.now()) {\n    deleteEntry(key);\n    _stats.misses++;\n    return null;\n  }\n  // Refresh LRU position\n  _store.delete(key);\n  _store.set(key, entry);\n  _stats.hits++;\n  return entry.value;\n}\n\nexport function cacheSet(key, value) {\n  if (!isCacheEnabled()) return;\n  // Don't cache empty or partial results\n  if (!value || (!value.text && !(value.chunks && value.chunks.length))) return;\n  const bytes = valueBytes(value);\n  const limit = maxBytes();\n  deleteEntry(key);\n  if (!Number.isFinite(bytes) || bytes > limit) {\n    _stats.skips++;\n    return;\n  }\n  _store.set(key, { value, expiresAt: Date.now() + TTL_MS, bytes });\n  _bytes += bytes;\n  _stats.stores++;\n  while (_store.size > MAX_ENTRIES || _bytes > limit) {\n    const oldest = _store.keys().next().value;\n    if (oldest === undefined) break;\n    deleteEntry(oldest);\n    _stats.evictions++;\n  }\n}\n\nexport function cacheStats() {\n  const total = _stats.hits + _stats.misses;\n  return {\n    enabled: isCacheEnabled(),\n    size: _store.size,\n    maxSize: MAX_ENTRIES,\n    bytes: _bytes,\n    maxBytes: maxBytes(),\n    ttlMs: TTL_MS,\n    hits: _stats.hits,\n    misses: _stats.misses,\n    stores: _stats.stores,\n    evictions: _stats.evictions,\n    skips: _stats.skips,\n    hitRate: total > 0 ? ((_stats.hits / total) * 100).toFixed(1) : '0.0',\n  };\n}\n\nexport function cacheClear() {\n  _store.clear();\n  _bytes = 0;\n  _stats.hits = 0; _stats.misses = 0; _stats.stores = 0; _stats.evictions = 0; _stats.skips = 0;\n  log.info('Response cache cleared');\n}\n";

function cacheModule(source, env) {
  return evaluate(source, ['cacheKey', 'cacheGet', 'cacheSet', 'cacheClear', 'cacheStats', 'isCacheEnabled'],
    { createHash, process: { env } });
}

function keyHarness({ baseline = false, singleTenant = false, enabled = '1', alias = '1' } = {}) {
  const env = { WINDSURFAPI_SINGLE_TENANT_CACHE: singleTenant ? '1' : '0',
    WINDSURFAPI_RESPONSE_CACHE: alias };
  if (enabled !== undefined) env.RESPONSE_CACHE_ENABLED = enabled;
  const cache = cacheModule(baseline ? CACHE_014204F : readSource('src/cache.js'), env);
  const chat = readSource('src/handlers/chat.js');
  let calls = 0;
  const compute = (body, caller) => { calls++; return cache.cacheKey(body, caller); };
  const gated = baseline ? '' : functionText(chat, 'cacheKey', true);
  const scope = functionText(chat, 'hasPerUserScope');
  const singleTenantDeclaration = chat.match(/^const SINGLE_TENANT_CACHE = .*;$/m)?.[0];
  assert(singleTenantDeclaration, 'The module-level single-tenant setting must remain available');
  const inner = chat.match(/  const reuseOriginalCkey = [\s\S]*?  const ckey = [^\n]+;/)?.[0];
  assert(inner, 'The real inner key-selection statements must be loaded');
  const globals = { process: { env }, computeCacheKey: compute, cacheKey: compute,
    isCacheEnabled: cache.isCacheEnabled,
    // The real inner statement (and the real outer wrapper, below) derive the
    // effective routed identity via chat.js cascadeCacheIdentity. This harness
    // pins the GATE mechanics (hash-count, scope skip, H-3 capture) and the
    // identity-less key format against the pinned 014204f cache — both are
    // identity-neutral, so the routing identity itself is stubbed out here.
    // Its derivation is behaviorally covered by cache-routing-identity.test.js.
    cascadeCacheIdentity: () => undefined,
    // The B1 additions to the real statement: `routingModelKey` is the routed
    // generation the fresh key describes, `accessFallbackModel` says the
    // access policy retargeted the request (so the original outer key no
    // longer describes it). The sandbox pins gate mechanics, not routing, so
    // both stay inert here.
    routingModelKey: undefined, accessFallbackModel: false };
  const api = evaluate(singleTenantDeclaration + '\n' + scope + gated +
    '\nfunction innerKey(body, callerKey, context) {\n' + inner + '\nreturn ckey;\n}\n',
    ['cacheKey', 'hasPerUserScope', 'innerKey'], globals);
  return { ...api, cache, env, calls: () => calls, reset: () => { calls = 0; } };
}

const body = { model: 'glm-5.1', messages: [{ role: 'user', content: 'Hello 中 \ud800 😀' }] };

test('both chat key sites skip all hashing without trusted scope or with cache disabled', () => {
  const cases = [
    ['', false, '1', false], ['api:synthetic', false, '1', false],
    ['api:synthetic:client:test', false, '1', false],
    ['api:synthetic:user:alice', false, '1', true],
    ['session:synthetic', false, '1', true],
    ['client:test', true, '1', true], ['api:synthetic', true, '1', false],
    ['session:synthetic', false, '0', false],
    ['session:synthetic', false, ' FALSE ', false],
    ['session:synthetic', false, 'off', false],
    ['session:synthetic', false, 'no', false],
  ];
  for (const [caller, singleTenant, enabled, active] of cases) {
    const h = keyHarness({ singleTenant, enabled });
    const key = h.cacheKey(body, caller);
    assert.equal(h.calls(), Number(active), JSON.stringify({ caller, enabled }));
    const inner = h.innerKey(body, caller, { __originalCkey: key });
    assert.equal(h.calls(), Number(active), 'inner must not undo the outer skip');
    assert.equal(inner, key);
    const fallback = { ...body, model: 'glm-5.2' };
    h.innerKey(fallback, caller, { __originalCkey: key, __fallbackAttempt: true });
    assert.equal(h.calls(), active ? 2 : 0, 'fallback hashes only when eligible');
  }
  const h = keyHarness({ enabled: '1', alias: '0' });
  assert.equal(h.cache.isCacheEnabled(), true, 'primary env takes precedence');
  delete h.env.RESPONSE_CACHE_ENABLED;
  assert.equal(h.cacheKey(body, 'session:test'), null, 'alias off is honored');
  h.env.WINDSURFAPI_RESPONSE_CACHE = '1';
  assert.equal(h.cacheKey(body, 'session:test'), h.cache.cacheKey(body, 'session:test'));
});

test('eligible keys are identical to pinned 014204f for original and fallback bodies', () => {
  const old = keyHarness({ baseline: true });
  const next = keyHarness();
  const fixtures = [
    body,
    { ...body, tools: [{ type: 'function', function: { name: 't',
      parameters: { required: ['z'], properties: { z: { type: 'string' }, a: { type: 'integer' } } } } }],
      logit_bias: { 50256: -1, 100: 1 }, max_completion_tokens: 17, max_tokens: 100 },
    { ...body, messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJjZA==' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YW Jj\nZA==' } },
    ] }], reasoning: { effort: 'high' }, stop: ['END'], stream_options: { include_usage: true } },
  ];
  for (const fixture of fixtures) {
    const before = JSON.stringify(fixture);
    const caller = 'api:synthetic:user:alice';
    const oldKey = old.cacheKey(fixture, caller);
    const newKey = next.cacheKey(fixture, caller);
    assert.equal(newKey, oldKey);
    const fallback = { ...fixture, model: 'glm-5.2' };
    assert.equal(next.innerKey(fallback, caller, { __originalCkey: newKey, __fallbackAttempt: true }),
      old.innerKey(fallback, caller, { __originalCkey: oldKey, __fallbackAttempt: true }));
    assert.notEqual(next.cacheKey(fallback, caller), newKey);
    assert.equal(JSON.stringify(fixture), before, 'key derivation must not mutate the body');
  }
});

test('cache hits, misses, stores and payload bytes stay identical under the existing scope guards', () => {
  for (const enabled of ['0', '1']) {
    for (const caller of ['api:synthetic', 'session:synthetic']) {
      const pair = [keyHarness({ baseline: true, enabled }), keyHarness({ enabled })];
      const results = pair.map((h, index) => {
        const key = h.cacheKey(body, caller);
        const shareable = h.hasPerUserScope(caller);
        const first = shareable ? h.cache.cacheGet(key) : null;
        if (shareable) h.cache.cacheSet(key, { text: 'answer 中 😀', chunks: ['a', 'b'] });
        const second = shareable ? h.cache.cacheGet(key) : null;
        const otherKey = h.cacheKey(body, 'session:other');
        const other = h.cache.cacheGet(otherKey);
        const stats = h.cache.cacheStats();
        if (index === 1) {
          const { eligibleLookups, hitRatePercent, ...legacyStats } = stats;
          assert.equal(eligibleLookups, stats.hits + stats.misses);
          assert.equal(hitRatePercent, eligibleLookups ? 100 * stats.hits / eligibleLookups : null);
          return JSON.stringify({ first, second, other, stats: legacyStats });
        }
        return JSON.stringify({ first, second, other, stats });
      });
      assert.equal(results[1], results[0]);
    }
  }
});

test('the actual outer wrapper captures the original key before the inner mutates the body', async () => {
  const h = keyHarness();
  const original = structuredClone(body);
  const expected = h.cache.cacheKey(original, 'session:synthetic');
  let captured;
  const api = evaluate(functionText(readSource('src/handlers/chat.js'), 'handleChatCompletions'),
    ['handleChatCompletions'], {
      cacheKey: h.cacheKey, newTraceId: () => 'trace', traceEnabled: () => false,
      shouldAutoFallback: () => false,
      cascadeCacheIdentity: () => undefined,
      _handleChatCompletionsInner: async (b, context) => {
        captured = context.__originalCkey;
        b.model = 'mutated-after-key';
        return { status: 200, body: { value: 'unchanged' } };
      },
    });
  assert.deepEqual(plain(await api.handleChatCompletions(original, { callerKey: 'session:synthetic' })),
    { status: 200, body: { value: 'unchanged' } });
  assert.equal(captured, expected);
  assert.match(readSource('src/handlers/chat.js'),
    /import \{ cacheKey as computeCacheKey, cacheGet, cacheSet, isCacheEnabled \} from '\.\.\/cache\.js';/);
});
