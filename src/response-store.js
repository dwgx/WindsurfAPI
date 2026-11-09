/**
 * Responses API server-side conversation state.
 *
 * WHY: `/v1/responses` advertises OpenAI Responses compatibility, whose defining
 * feature is that the SERVER holds the conversation. A client sends only the new
 * turn plus `previous_response_id` and the server prepends everything before it.
 *
 * Before this module `previous_response_id` was never read (grep: zero hits in
 * handlers/responses.js). A chained client therefore reached the upstream with a
 * SINGLE message every turn — the model answered each turn blind, with no error
 * and no warning, producing fluent but context-free replies the caller had no way
 * to diagnose. That silent-wrong-answer mode is the thing this fixes.
 *
 * Design:
 *   - Each stored entry holds the FULL accumulated message list for that turn
 *     (input + the assistant output), not a parent pointer. Resolution is then a
 *     single O(1) lookup instead of walking a chain, and a mid-chain eviction
 *     cannot silently truncate history — the lookup either has everything or
 *     fails loudly.
 *   - Entries are scoped by callerKey. A response id minted for one caller MUST
 *     NOT resolve for another, or tenant A could read tenant B's conversation by
 *     replaying an id. Lookup mismatch fails closed (treated as not found).
 *   - Bounded like every other in-memory table here: TTL, a hard cap, LRU
 *     eviction with a per-tenant fair share so one caller cannot flush everyone
 *     else's conversations (same lesson as account/sticky-session.js).
 *   - `store: false` on the request skips persistence, per the OpenAI contract —
 *     such a response cannot later be used as a `previous_response_id`. The value
 *     is NORMALIZED here rather than trusted as a boolean; see wantsPersistence.
 *
 * Configure via env:
 *   RESPONSE_STORE_ENABLED=0        — disable (default: on)
 *   RESPONSE_STORE_TTL_MS=3600000   — IDLE timeout in ms (default: 1 hour)
 *   RESPONSE_STORE_MAX_AGE_MS=86400000 — absolute retention bound (default: 24 hours)
 *   RESPONSE_STORE_MAX=2000         — max stored responses (default: 2000)
 *   RESPONSE_STORE_MAX_MESSAGES=400 — per-conversation message cap (default: 400)
 *   RESPONSE_STORE_MAX_BYTES=128m   — total byte budget (default: 128MB; b/k/kb/m/mb/g/gb)
 */

import { log } from './config.js';

const ENABLED = process.env.RESPONSE_STORE_ENABLED !== '0';

// Every numeric setting goes through this: parseInt alone accepts values that
// round past Number.MAX_SAFE_INTEGER (and a 400-digit string becomes Infinity), so
// a malformed setting could silently disable the bound it was meant to configure.
// A malformed value falls back to the documented default instead of becoming an
// unbounded limit.
function positiveIntSetting(raw, fallback) {
  const n = parseInt(raw || '', 10);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

// IDLE timeout: measured from lastAccess, which every successful read refreshes.
// That refresh is deliberate — a chained agent loop touching the same id every few
// seconds must not have its context expire underneath it — but it means TTL_MS on
// its own bounds nothing: a client polling GET /v1/responses/{id} keeps an entry
// alive forever (measured at RESPONSE_STORE_TTL_MS=120: polled every 40ms for
// 1020ms, i.e. 8.5x the TTL, 25 successful reads, entry still alive). No floor
// either — `n > 0` accepts 1ms, which is fine for tuning and useless as a bound.
// MAX_AGE_MS below is the bound that does not depend on read traffic.
const TTL_MS = (() => {
  const n = parseInt(process.env.RESPONSE_STORE_TTL_MS || '', 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 60 * 60 * 1000; // 1 hour
})();

// ABSOLUTE retention bound, measured from createdAt and NOT refreshed by reads. It
// is what makes "retained for a limited time" true; the idle timeout above only
// says "collected when abandoned".
//
// 24 hours, chosen against the workload this store exists to serve rather than
// against the smallest defensible number. An agent loop can legitimately run for
// hours, and dropping its context mid-run is a worse failure than over-retention:
// the caller gets a 404 on a conversation it is actively using, with nothing to
// recover from. Note the bound is per response id and createdAt survives a
// same-id refresh, so a real chain is unaffected either way — every turn mints a
// NEW id and starts its own 24 hours. What the bound actually kills is the entry
// that is read but never superseded, which is exactly the shape that had no upper
// limit at all.
const MAX_AGE_MS = (() => {
  const n = parseInt(process.env.RESPONSE_STORE_MAX_AGE_MS || '', 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 24 * 60 * 60 * 1000; // 24 hours
})();

const MAX_ENTRIES = positiveIntSetting(process.env.RESPONSE_STORE_MAX, 2000);

// A runaway agent loop would otherwise grow one conversation without bound. The
// cap keeps the OLDEST turns (the system prompt and early context matter most for
// coherence) — see truncateMessages.
const MAX_MESSAGES = positiveIntSetting(process.env.RESPONSE_STORE_MAX_MESSAGES, 400);

// Neither MAX_ENTRIES nor MAX_MESSAGES bounds actual MEMORY — they bound counts.
// Measured on realistic agent-loop conversations (8KB system prompt + 200
// tool_call/tool_result pairs with 4KB outputs, truncated to MAX_MESSAGES): ~167KB
// of heap per stored entry, so the default 2000 entries is ~327MB, and a
// text-heavy shape measured ~518MB. On the small VPSes this project explicitly
// targets (the README tells 2GB hosts to lower LS_MAX_INSTANCES) that is enough to
// matter on its own. So the store also carries a BYTE budget and evicts on
// whichever limit binds first.
/**
 * Parse a byte-size setting like `128m` / `512kb` / `1g` / a bare byte count.
 * Exported so the suffix contract is tested against THIS implementation instead of
 * a copy — a test that re-derives the regex passes even when production breaks.
 * Returns null for anything unusable so the caller applies its default.
 *
 * The result must be a SAFE integer and must sit under an explicit operational
 * bound. `Number('9'.repeat(400))` is Infinity and a 17-digit value rounds to a
 * different integer; either one used to become MAX_BYTES and silently disabled
 * byte eviction (measured: `RESPONSE_STORE_MAX_BYTES=9…9` produced Infinity).
 */
const MAX_CONFIGURED_BYTES = 1024 ** 4; // 1 TiB — far above any real deployment

export function parseByteSize(raw) {
  const m = String(raw ?? '').trim().match(/^(\d+)\s*(b|k|kb|m|mb|g|gb)?$/i);
  if (!m) return null;
  const mult = { b: 1, k: 1024, kb: 1024, m: 1048576, mb: 1048576, g: 1073741824, gb: 1073741824 };
  const n = Number(m[1]) * (mult[(m[2] || 'b').toLowerCase()] || 1);
  if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_CONFIGURED_BYTES) return null;
  return n;
}

const MAX_BYTES = parseByteSize(process.env.RESPONSE_STORE_MAX_BYTES)
  ?? 128 * 1024 * 1024; // 128MB — roughly 800 realistic conversations

// A copy that allocates only where it must. `structuredClone` re-copies every
// string it walks — a 4 MB base64 image in a stored turn cost ~2.9 ms per put and
// ~2.6 ms per read — and it turns a Buffer into a Uint8Array, losing the type the
// rest of the pipeline expects. Strings, numbers and booleans are immutable, so
// they can be shared; only containers are re-created. Anything that is not plain
// JSON-shaped (Date, Map, class instances, functions) keeps the old semantics by
// falling back to structuredClone, including its throw on functions.
//
// `seen` makes the plain-object walk cycle-safe. Without it a self-referencing
// message would recurse until the stack overflowed; with it the stored graph
// mirrors the caller's shape and `retainedBytes` can meter the cycle too.
// A stored body nested deeper than the stack can clone used to escape as a
// per-request RangeError; bound the recursion like retainedBytes (S4-D14).
const MAX_STORED_CLONE_DEPTH = 64;

function copyStoredValue(value, seen = new WeakMap(), depth = 0) {
  // structuredClone refuses to clone functions and symbols; keep that loud
  // rejection instead of quietly storing a live reference.
  if (typeof value === 'function' || typeof value === 'symbol') return structuredClone(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_STORED_CLONE_DEPTH) throw new Error('copyStoredValue: value exceeds maximum nesting depth');
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    seen.set(value, out);
    for (let i = 0; i < value.length; i++) {
      if (i in value) out[i] = copyStoredValue(value[i], seen, depth + 1);
    }
    return out;
  }
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    // DataView's constructor takes a buffer, not another view.
    if (value instanceof DataView) {
      return new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
    return new value.constructor(value);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    const out = {};
    seen.set(value, out);
    for (const key of Object.keys(value)) {
      // defineProperty, not assignment: an own `__proto__` key must survive as a
      // field instead of rewriting the copy's prototype.
      Object.defineProperty(out, key, {
        value: copyStoredValue(value[key], seen, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  }
  return structuredClone(value);
}

// Approximate retained size of a stored value. The estimate must describe the
// ACTUAL retained graph, not a hand-picked subset: `copyStoredValue` keeps every
// own enumerable message field (and object key), so a walker that only looked at
// `content`/`tool_calls`/`tool_call_id` charged an entry holding a 100k-char extra
// field 68 bytes and let the byte budget never fire.
//
// The estimate is deliberately conservative rather than an exact V8 heap
// measurement:
//   - 2 bytes per character. V8 stores any non-Latin1 string as 2 bytes/char, so
//     `.length` undercounts CJK by exactly 2x; charging 2 everywhere overcounts
//     pure ASCII by 2x, which is the safe direction for a memory bound.
//   - container and per-value overhead is explicit (32/8 bytes).
//   - Buffer / typed array / ArrayBuffer payloads are charged their actual
//     `byteLength`; walking each byte as a JS number would inflate a 20KB Buffer
//     to ~160KB and evict conversations that comfortably fit.
//   - Map/Set/Date/RegExp/Error internal slots are charged too, because
//     `copyStoredValue` falls back to structuredClone for them and therefore
//     retains those fields.
//   - no depth is silently flattened to a stub. A pathologically deep value is
//     charged MAX_SAFE_INTEGER so admission rejects it instead of undercounting.
const CONTAINER_BYTES = 32;
const VALUE_SLOT_BYTES = 8;
const MAX_RETAINED_DEPTH = 64;

function retainedBytes(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return 0;
  const type = typeof value;
  if (type === 'string') return value.length * 2;
  if (type === 'number' || type === 'boolean') return VALUE_SLOT_BYTES;
  if (type === 'bigint') return 16;
  if (type !== 'object') return 0; // function/symbol cannot be retained (copy throws)
  if (depth > MAX_RETAINED_DEPTH) return Number.MAX_SAFE_INTEGER;
  if (seen.has(value)) return CONTAINER_BYTES;
  seen.add(value);
  try {
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
      return CONTAINER_BYTES + value.byteLength;
    }
    if (value instanceof ArrayBuffer) return CONTAINER_BYTES + value.byteLength;
    if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
      return CONTAINER_BYTES + value.byteLength;
    }
    if (Array.isArray(value)) {
      let n = CONTAINER_BYTES;
      for (let i = 0; i < value.length; i++) {
        n += VALUE_SLOT_BYTES + retainedBytes(value[i], depth + 1, seen);
      }
      return n;
    }
    if (value instanceof Map) {
      let n = CONTAINER_BYTES;
      for (const [k, v] of value) {
        n += 16 + retainedBytes(k, depth + 1, seen) + retainedBytes(v, depth + 1, seen);
      }
      return n;
    }
    if (value instanceof Set) {
      let n = CONTAINER_BYTES;
      for (const v of value) n += VALUE_SLOT_BYTES + retainedBytes(v, depth + 1, seen);
      return n;
    }
    if (value instanceof Date) return CONTAINER_BYTES;
    if (value instanceof RegExp) {
      return CONTAINER_BYTES + value.source.length * 2 + value.flags.length * 2;
    }
    if (typeof URL !== 'undefined' && value instanceof URL) {
      return CONTAINER_BYTES + String(value).length * 2;
    }
    if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) {
      return CONTAINER_BYTES + value.toString().length * 2;
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      return CONTAINER_BYTES + value.size;
    }
    if (value instanceof Error) {
      let n = CONTAINER_BYTES;
      n += String(value.message || '').length * 2;
      n += String(value.stack || '').length * 2;
      if (value.cause !== undefined) n += retainedBytes(value.cause, depth + 1, seen);
      return n;
    }
    let n = CONTAINER_BYTES;
    for (const key of Object.keys(value)) {
      n += key.length * 2 + VALUE_SLOT_BYTES;
      n += retainedBytes(value[key], depth + 1, seen);
    }
    return n;
  } finally {
    seen.delete(value);
  }
}

/** Accounted retained size of a conversation's message array. */
function approxBytes(messages) {
  return retainedBytes(messages);
}

// ── the `metadata` slot ─────────────────────────────────────────────────────
// `metadata` is a top-level Responses parameter whose purpose is the ECHO: a
// client tags a request (trace id, tenant) and reads the tag back off the
// response object, including from a later GET. It is caller-controlled and stored
// per response, so it must be bounded HERE even though handlers/responses.js
// rejects a violating request with a 400 first: this module is a library with
// other callers, and a slot whose size is whatever the request body said is a
// memory amplifier the byte budget would never see if the field were excluded
// from `bytes`.
//
// The caps are the OpenAI contract (16 pairs, keys <= 64 chars, values <= 512
// chars). They are what bounds the slot: 16 * (64 + 512) chars is 18KB of
// accounted memory at retainedBytes' 2 bytes per char, and there is no shape a caller
// can send that exceeds it. Entries over a cap are DROPPED, never truncated — a
// truncated trace id is a wrong trace id, and the HTTP boundary refuses such a
// request before it reaches this function.
const MAX_METADATA_KEYS = 16;
const MAX_METADATA_KEY_CHARS = 64;
const MAX_METADATA_VALUE_CHARS = 512;

/**
 * Copy `metadata` into the store's bounded slot, or return null.
 *
 * Only own enumerable STRING pairs are kept: a nested object or a number cannot
 * be echoed as the flat map the Responses contract defines, and coercing it would
 * change the caller's data. `__proto__` is skipped because the generic
 * copy-on-read walk (copyStoredValue) assigns into a plain object, where that key
 * would rewrite the prototype instead of surviving as a tag.
 */
function boundMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const out = {};
  let kept = 0;
  for (const key of Object.keys(metadata)) {
    if (kept >= MAX_METADATA_KEYS) break;
    if (key === '__proto__') continue;
    const value = metadata[key];
    if (typeof value !== 'string') continue;
    if (!key || key.length > MAX_METADATA_KEY_CHARS || value.length > MAX_METADATA_VALUE_CHARS) continue;
    Object.defineProperty(out, key, { value, enumerable: true, configurable: true, writable: true });
    kept++;
  }
  return kept ? out : null;
}

// A stored entry is more than its messages: callerKey, responseId (the Map key),
// model, status, incompleteReason and metadata are all retained alongside them.
// Charging only `messages` let a 40KB model or a huge id ride for free, and let
// metadata push an otherwise-trimmed entry back over the per-entry ceiling.
const ENTRY_OVERHEAD_BYTES = 32;

function entryFixedBytes({ responseId, callerKey, model, status, incompleteReason, metadata }) {
  return ENTRY_OVERHEAD_BYTES
    + retainedBytes(responseId)
    + retainedBytes(callerKey)
    + retainedBytes(model)
    + retainedBytes(status)
    + retainedBytes(incompleteReason)
    + retainedBytes(metadata);
}

// Map<responseId, { messages, callerKey, model, status, incompleteReason, metadata,
//                   createdAt, lastAccess, bytes }>
// Map iteration order is maintained as least-recently-used order: every read and
// refresh re-inserts, so the first key is always the LRU victim (O(1) eviction).
const _entries = new Map();
const _tenantCounts = new Map();
// Per-tenant BYTE totals. The byte-eviction loop needs a byte-denominated fair
// share; comparing an entry COUNT against MAX_ENTRIES/tenants let a byte-bound
// writer look under-share forever and evict strangers (see the loop below).
const _tenantBytes = new Map();

const _stats = { stored: 0, hits: 0, misses: 0, expires: 0, evictions: 0, rejected: 0 };
let _bytes = 0;   // running total of approxBytes across all entries

export function isResponseStoreEnabled() {
  return ENABLED;
}

/**
 * Tenant identity for quota purposes: the API-key prefix of the callerKey, not
 * the whole callerKey. One API key can mint unlimited distinct callerKeys (a
 * fresh body.user per request), so quota'ing the full callerKey would not bound
 * anything.
 */
function tenantOf(callerKey) {
  const key = String(callerKey || '');
  const i = key.indexOf(':');
  if (i < 0) return key;
  const j = key.indexOf(':', i + 1);
  return j < 0 ? key : key.slice(0, j);
}

function trackInsert(callerKey, bytes = 0) {
  const t = tenantOf(callerKey);
  _tenantCounts.set(t, (_tenantCounts.get(t) || 0) + 1);
  _tenantBytes.set(t, (_tenantBytes.get(t) || 0) + bytes);
}

function dropEntry(id) {
  const entry = _entries.get(id);
  if (!entry) return false;
  _entries.delete(id);
  _bytes -= entry.bytes || 0;
  if (_bytes < 0) _bytes = 0;
  const t = tenantOf(entry.callerKey);
  const n = (_tenantCounts.get(t) || 1) - 1;
  const b = (_tenantBytes.get(t) || 0) - (entry.bytes || 0);
  if (n > 0) { _tenantCounts.set(t, n); _tenantBytes.set(t, b > 0 ? b : 0); }
  else { _tenantCounts.delete(t); _tenantBytes.delete(t); }
  return true;
}

function oldestId(tenant = null, exclude = null) {
  for (const [id, entry] of _entries) {
    if (id === exclude) continue;
    if (!tenant || tenantOf(entry.callerKey) === tenant) return id;
  }
  return null;
}

/**
 * Evict until the total byte budget holds. Returns false only when even evicting
 * every unprotected entry cannot bring `_bytes` under MAX_BYTES; the caller then
 * rolls the just-committed entry back and reports a rejected write.
 *
 * `protectedId` (the entry just written) is never a victim: returning true while
 * the caller's own id 404s is the bug this guard has always prevented.
 *
 * P-02's second half: the old loop `break`ed when an over-share tenant had no
 * other entry of its own, accepting an over-budget total. That exit is gone — if
 * the writer has nothing else to give, the global LRU scan evicts another victim.
 * The per-entry ceiling (MAX_ENTRY_BYTES <= MAX_BYTES) bounds what one writer can
 * force others to absorb.
 */
function enforceByteBudget(protectedId) {
  let guard = _entries.size + 1;
  while (_bytes > MAX_BYTES && _entries.size > 1 && guard-- > 0) {
    const own = _entries.get(protectedId);
    const tenant = own ? tenantOf(own.callerKey) : null;
    const byteShare = Math.max(MIN_TENANT_BYTES, MAX_BYTES / Math.max(1, _tenantBytes.size));
    const overShare = tenant !== null && (_tenantBytes.get(tenant) || 0) > byteShare;
    const victim = (overShare ? oldestId(tenant, protectedId) : null)
      || oldestId(null, protectedId);
    if (!victim) break;
    dropEntry(victim);
    _stats.evictions++;
  }
  return _bytes <= MAX_BYTES;
}

// The two expiry predicates, named so the lookup path and the sweep cannot drift
// apart. `lastAccess` is refreshed by every read (idle timeout); `createdAt` is
// not (absolute bound).
function isPastIdle(entry, now) {
  return now - entry.lastAccess > TTL_MS;
}
function isPastMaxAge(entry, now) {
  return now - entry.createdAt > MAX_AGE_MS;
}

// Periodic sweep so an idle process does not hold expired conversations. The
// per-lookup TTL check is the primary enforcement; this is the safety net.
let _sweepTimer = null;
function ensureSweepTimer() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of [..._entries]) {
      // Both bounds, for the same reason getResponse checks both: an entry kept
      // warm by reads never trips the idle timeout, and one nobody ever reads
      // again would sit until the absolute bound if only that were checked here.
      if (isPastIdle(entry, now) || isPastMaxAge(entry, now)) {
        dropEntry(id);
        _stats.expires++;
      }
    }
  }, 5 * 60 * 1000).unref();
}

/**
 * The one sentence a conversation carries when the store dropped turns from it.
 *
 * Dropping turns must never be SILENT: the next turn replays this list as context,
 * and a model handed a history that begins mid-stream cannot tell that earlier
 * turns existed — it answers fluently about a conversation it never saw. The
 * wording is load-bearing: handlers/responses.js strips exactly this shape
 * (`^\[\.\.\. \d+ earlier message\(s\) dropped by the response store[^\]]*\]\n\n`)
 * before serving an answer, so the notice stays in the CHAINED context without
 * being presented to the client as model output.
 *
 * `setting` names the limit that bound, so an operator reading the conversation
 * knows which knob to raise.
 */
function droppedTurnsNotice(count, setting) {
  return `[... ${count} earlier message(s) dropped by the response store to stay `
    + `within ${setting} ...]\n\n`;
}

/**
 * Copy-on-write prepend of `note` to `messages[index]`. Returns a new array and a
 * new message object; a parts-array content gets a leading text block instead of
 * being flattened, so the turn keeps the structure the next replay expects.
 *
 * Prepending to an existing message rather than inserting one is deliberate: a new
 * message would change the conversation's role sequence, which the connect wire
 * layer is sensitive to.
 */
function prependNotice(messages, index, note) {
  const out = messages.slice();
  const target = { ...out[index] };
  if (typeof target.content === 'string') target.content = note + target.content;
  else if (Array.isArray(target.content)) target.content = [{ type: 'text', text: note }, ...target.content];
  else target.content = note;
  out[index] = target;
  return out;
}

/**
 * Keep the conversation within MAX_MESSAGES, preserving the leading system
 * message(s) — dropping those loses the agent's instructions and changes
 * behaviour far more than dropping middle turns.
 *
 * A count-trimmed conversation is NOT the same conversation any more, so the
 * result carries a drop notice (see droppedTurnsNotice). Each limiter reports the
 * turns IT dropped: when the byte ceiling later drops further, the surviving
 * conversation carries that stage's notice instead. The count is a floor for the
 * total in that combined case, never a claim that nothing was lost.
 */
function truncateMessages(messages) {
  if (messages.length <= MAX_MESSAGES) return messages;

  let lead = 0;
  while (lead < messages.length && messages[lead]?.role === 'system') lead++;

  // The leading system block gets at most HALF the budget. Without a cap on the
  // head, `MAX_MESSAGES - lead` goes negative once the system block alone reaches
  // the budget, and `slice(-negative)` silently becomes `slice(positive)` — it
  // returns most of the array instead of the last few entries, so the result grew
  // INSTEAD of shrinking (measured: 501 messages in, 901 stored). Codex-style
  // clients that send AGENTS.md / environment context as many separate developer
  // items reach that shape with no adversarial intent.
  // Cap the head only where it MUST be capped. The negative-slice bug fired at
  // lead >= MAX_MESSAGES; a head budget of MAX/2 also changed the outcome for lead
  // in (MAX/2, MAX), a range where the old code was already correct and preserved
  // every leading system message. Clamping to MAX_MESSAGES - 1 fixes the bug while
  // leaving that range byte-identical, and still guarantees room for one real turn.
  const head = messages.slice(0, Math.min(lead, MAX_MESSAGES - 1));
  const tailBudget = MAX_MESSAGES - head.length;
  const tail = tailBudget > 0 ? messages.slice(-tailBudget) : [];
  const out = [...head, ...tail];
  const dropped = messages.length - out.length;
  // Unreachable while MAX_MESSAGES >= 1 (the head is clamped to MAX-1, so a tail
  // survives), but the guard keeps a future bound from turning this into a notice
  // that claims a drop it did not make.
  if (dropped <= 0) return out;
  // Where the notice goes: the message immediately AFTER the gap, i.e. the first
  // surviving turn. When that is also the LAST message (a huge system block leaves
  // exactly one turn of tail budget), prepending would rewrite the very turn the
  // store exists to preserve byte-identically, so the notice goes on the other side
  // of the seam — the last surviving head message, equally adjacent to the gap.
  const seam = head.length < out.length - 1 ? head.length : Math.max(0, head.length - 1);
  log.warn(`[response-store] dropped ${dropped} message(s) to fit RESPONSE_STORE_MAX_MESSAGES`);
  return prependNotice(out, seam, droppedTurnsNotice(dropped, 'RESPONSE_STORE_MAX_MESSAGES'));
}

// No single conversation may claim more than this share of the whole budget.
// Without a per-entry ceiling the eviction loop cannot converge fairly: a tenant
// whose one entry alone exceeds the budget has nothing of its OWN left to evict,
// so it falls through to the global scan and flushes strangers — which is exactly
// the cross-tenant DoS the byte-denominated fair share is meant to prevent.
// The floor must never exceed a smaller configured total: at MAX_BYTES=1 the
// old `max(64KiB, MAX_BYTES/4)` produced a 64KiB per-entry ceiling, so one entry
// could be 64KiB against a 1-byte total budget. Clamp it to MAX_BYTES.
const MAX_ENTRY_BYTES = Math.max(1, Math.min(MAX_BYTES, Math.max(64 * 1024, Math.floor(MAX_BYTES / 4))));

// Floor under the per-tenant byte share used by the eviction loop. `MAX_BYTES /
// tenants` is the fair-share rule, but taken literally it self-destructs at scale:
// past a few hundred tenants the share falls below one ordinary conversation, so
// EVERY tenant reads as over-share, each one only ever evicts its own oldest, and
// a tenant holding a single entry has nothing to evict at all — the loop breaks
// with the budget still exceeded. 1/64th of the budget (min 256KB) is the point
// below which a tenant is too small for self-eviction to bound anything, and the
// global LRU scan takes over. Above the floor the fair-share behaviour that
// prevents the cross-tenant DoS is unchanged. The floor is clamped to MAX_BYTES
// so it can never exceed the whole configured budget.
const MIN_TENANT_BYTES = Math.min(MAX_BYTES, Math.max(256 * 1024, Math.floor(MAX_BYTES / 64)));

/**
 * Trim a conversation until it fits MAX_ENTRY_BYTES, dropping from the MIDDLE.
 * The leading system block and the most recent turns are what a next turn needs;
 * the middle is the cheapest thing to lose, and losing it is strictly better than
 * either refusing the write or evicting other tenants to make room.
 */
function capEntryBytes(messages, limit = MAX_ENTRY_BYTES) {
  if (approxBytes(messages) <= limit) return messages;
  let lead = 0;
  while (lead < messages.length && messages[lead]?.role === 'system') lead++;
  const head = messages.slice(0, Math.min(lead, 8));
  let tailStart = messages.length;
  const out = [];
  // Walk backwards adding recent turns while they fit.
  let used = approxBytes(head);
  while (tailStart > lead) {
    const candidate = messages[tailStart - 1];
    const cost = VALUE_SLOT_BYTES + retainedBytes(candidate);
    if (used + cost > limit && out.length) break;
    used += cost;
    out.unshift(candidate);
    tailStart--;
    if (used > limit) break;
  }
  const trimmed = [...head, ...out];
  // Dropping messages must never be SILENT. The backward walk stops as soon as one
  // message has been kept and the next does not fit, so an over-cap message with
  // any smaller message after it is excluded entirely — and because `trimmed` then
  // fits, the content-level fallback below never runs and no marker is written.
  // Reproduced at RESPONSE_STORE_MAX_BYTES=8m: a 2MB user turn followed by a short
  // assistant reply stored as `["assistant"]` — the user's question, including a
  // pasted file, vanished with no marker and no log line. The next chained turn
  // then asked the model about content it was never shown, and answered 200 with a
  // confident context-free reply: exactly the silent-wrong-answer mode this module
  // exists to remove. Small-VPS operators are explicitly told to lower this budget,
  // so the shape is ordinary rather than adversarial.
  const dropped = messages.length - trimmed.length;
  // Prepended to the first SURVIVING message rather than added as a new one:
  // inserting a message would change the conversation's role sequence, which the
  // connect wire layer is sensitive to (see prependNotice).
  const marked = dropped > 0 && trimmed.length
    ? prependNotice(trimmed, 0, droppedTurnsNotice(dropped, 'RESPONSE_STORE_MAX_BYTES'))
    : trimmed;
  if (marked !== trimmed) {
    log.warn(`[response-store] dropped ${dropped} message(s) to fit RESPONSE_STORE_MAX_BYTES`);
  }
  // Last resort: a conversation whose SINGLE message already exceeds the ceiling
  // cannot be shrunk by dropping messages. Cut the text itself, otherwise the
  // store's one promise — total bytes stay within the budget — is false whenever
  // an operator configures a small budget (a 10MB request body, the server cap,
  // lands as ~20MB accounted). The marker keeps the truncation visible to whoever
  // reads the chained context instead of silently changing what the model saw.
  if (approxBytes(marked) > limit) return trimContentToFit(marked, limit);
  return marked;
}

const TRUNCATION_MARKER = '\n\n[... truncated by the response store to stay within RESPONSE_STORE_MAX_BYTES ...]';

// Keys whose STRING value must never be cut, because it is an identifier or a
// discriminator rather than payload. `tool_call_id` and `id` pair an assistant
// tool_call with its tool result — cutting either breaks the pairing and the
// upstream rejects the whole conversation. `type` is the block discriminator the
// wire layer dispatches on; `role` and `name` are likewise structural.
const UNSHRINKABLE_KEYS = new Set(['type', 'role', 'id', 'tool_call_id', 'name']);

// Tool-call arguments are JSON TEXT, not prose: `tool_calls[i].function.arguments`
// in the Chat shape and `function_call.arguments` in the Responses shape are both
// documents the next turn replays verbatim. Appending TRUNCATION_MARKER to one
// produced `{"path":"/tmp/a","content":"xxxx[... truncated ...]"` — a string that
// no longer parses, so the upstream rejects the conversation (or the model reasons
// about garbage) with nothing in the stored history saying why.
//
// The whole value is replaced instead, by a marker that is ITSELF valid JSON. The
// call keeps its id and function name, so the tool result still pairs; only the
// payload is gone, and the loss is explicit in a field a client can parse.
const ARGUMENTS_TRUNCATION_JSON = JSON.stringify({
  __truncated__: '[... tool call arguments truncated by the response store to stay '
    + 'within RESPONSE_STORE_MAX_BYTES ...]',
});

// Cheap structural test, deliberately not JSON.parse: an arguments string can be
// megabytes and every trim pass would re-pay the parse. Tool-call arguments are a
// JSON object (the OpenAI contract), so the first non-space byte is the whole
// question; anything else was never parseable JSON and keeps the prefix cut.
function looksLikeJsonDocument(value) {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    // space, tab, LF, VT, FF, CR, BOM — whitespace JSON.stringify never emits but
    // a hand-written client might.
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0b || c === 0x0c || c === 0x0d || c === 0xfeff) continue;
    return c === 0x7b /* { */ || c === 0x5b /* [ */;
  }
  return false;
}

/**
 * Every string in a message that MAY be shortened, as a path from the message
 * object (e.g. `['content', 2, 'text']`, `['tool_calls', 0, 'function',
 * 'arguments']`, or `['content']` for the plain-string shape).
 *
 * WHY a walk rather than reading `.content`: the previous version read
 * `typeof m.content === 'string' ? m.content.length : 0`, so for the ARRAY content
 * shape — which is the DEFAULT for the Responses API, since responsesToChat
 * normalizes every input item into typed blocks — no candidate was ever found,
 * `biggest` stayed -1 and the loop broke on its first iteration. MAX_ENTRY_BYTES
 * was therefore a no-op for the common case, while approxBytes/retainedBytes counted
 * those arrays correctly: the metering was fixed and the enforcement was not,
 * which is why the byte-budget tests passed with the cap doing nothing.
 * MEASURED at RESPONSE_STORE_MAX_BYTES=400k (MAX_ENTRY_BYTES 102400):
 *   content as string, 200000 chars -> stored  50124 chars, marker present
 *   content as array,  200000 chars -> stored 200000 chars, NO marker, 400104 bytes
 * i.e. ~3.9x the per-entry ceiling, which is enough for one tenant to LRU-evict
 * the whole store.
 *
 * The walk depth matches retainedBytes' depth: anything the metering charges for
 * is reachable here. Without that, a deeply nested string was counted by the
 * meter but invisible to the trimmer, so the entry could never be brought under
 * the ceiling. `seen` keeps a cyclic graph from looping forever.
 */
function shrinkableSlots(node, path = [], depth = 0, out = [], seen = new WeakSet()) {
  if (node == null || typeof node !== 'object') return out;
  if (depth > MAX_RETAINED_DEPTH || seen.has(node)) return out;
  if (Buffer.isBuffer(node) || ArrayBuffer.isView(node) || node instanceof ArrayBuffer) return out;
  seen.add(node);
  try {
    const entries = Array.isArray(node)
      ? node.map((v, i) => [i, v])
      : Object.entries(node);
    for (const [key, value] of entries) {
      if (typeof value === 'string') {
        if (typeof key === 'string' && UNSHRINKABLE_KEYS.has(key)) continue;
        // `arguments` is a DOCUMENT, not prose: it gets the whole-value JSON
        // replacement instead of the prefix cut. The floor differs because the two
        // replacements differ, and a replacement that is not shorter would make the
        // trim loop grow the value it is trying to shrink.
        const json = key === 'arguments' && looksLikeJsonDocument(value);
        const floor = (json ? ARGUMENTS_TRUNCATION_JSON.length : TRUNCATION_MARKER.length) + 1;
        if (value.length <= floor) continue;
        out.push({ path: [...path, key], len: value.length, json });
      } else if (value && typeof value === 'object') {
        shrinkableSlots(value, [...path, key], depth + 1, out, seen);
      }
    }
  } finally {
    seen.delete(node);
  }
  return out;
}

/**
 * Copy-on-write assignment along `path`. Copies every node it descends through so
 * the CALLER's message objects are never mutated — `messages.map(m => ({...m}))`
 * is a shallow copy, so a content array and its blocks are still shared with the
 * live request body, and writing through them would rewrite what the upstream is
 * about to be sent.
 */
function withStringAt(node, path, value) {
  const [key, ...rest] = path;
  const copy = Array.isArray(node) ? [...node] : { ...node };
  Object.defineProperty(copy, key, {
    value: rest.length ? withStringAt(node[key], rest, value) : value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return copy;
}

/**
 * Cut the largest shrinkable strings until the entry fits `limit`.
 *
 * P-02: this used to stop after a fixed 64 halving passes. That is enough for a
 * handful of blocks but not for the ordinary 20-block shape: measured at
 * RESPONSE_STORE_MAX_BYTES=256k (limit 65,536), 20 x 60,000-char blocks were
 * stored at 276,744 bytes — 4.2x the ceiling — because each pass halves only ONE
 * string and 20 blocks need well over 64 passes to reach the target. The loop now
 * runs to CONVERGENCE: every pass strictly shortens the largest candidate, so it
 * terminates when the entry fits or when no string can shrink any further. If it
 * cannot fit, the caller rejects the write instead of storing an over-cap entry.
 *
 * The `keep` bound matters too: `floor(len/2) + marker` is LARGER than `len` when
 * a string is only slightly longer than the marker, so the old formula could grow
 * the value it was trying to shrink. `len - marker - 1` guarantees strict
 * progress every pass.
 */
function trimContentToFit(messages, limit = MAX_ENTRY_BYTES) {
  let out = messages.map(m => ({ ...m }));
  let compactedArguments = 0;
  // Shrink from the LARGEST string field down until the entry fits. The field may
  // live inside a content-block array or inside a tool_call, not only at
  // `m.content` — see shrinkableSlots.
  while (approxBytes(out) > limit) {
    let biggest = null;
    for (let i = 0; i < out.length; i++) {
      for (const slot of shrinkableSlots(out[i], [i])) {
        if (!biggest || slot.len > biggest.len) biggest = slot;
      }
    }
    // No candidate left: the remaining bytes are structural (ids, keys,
    // discriminators, typed arrays). The caller must reject, never store over-cap.
    if (!biggest) return null;
    const [msgIndex, ...rest] = biggest.path;
    const current = rest.reduce((n, k) => n[k], out[msgIndex]);
    let cut;
    if (biggest.json) {
      // Valid JSON in, valid JSON out. The old prefix cut with the plain-text
      // marker appended is not JSON any more, and the next turn replays it
      // verbatim as the tool call's arguments.
      cut = ARGUMENTS_TRUNCATION_JSON;
      compactedArguments++;
    } else {
      const keep = Math.max(1, Math.min(
        Math.floor(biggest.len / 2),
        biggest.len - TRUNCATION_MARKER.length - 1,
      ));
      if (keep >= biggest.len) return null;
      cut = current.slice(0, keep) + TRUNCATION_MARKER;
    }
    // Progress is what makes the loop terminate. shrinkableSlots' floor already
    // guarantees a shorter replacement; this is the belt to that suspenders, and it
    // turns any future candidate that cannot shrink into a rejected write instead of
    // a hang.
    if (typeof current !== 'string' || cut.length >= current.length) return null;
    // The block STRUCTURE is preserved: only the string at this path changes, so a
    // `{type:'text', text}` block stays a text block and the next turn can still be
    // replayed from the array. `rest` is never empty — shrinkableSlots always
    // appends at least one key to the message index.
    out[msgIndex] = withStringAt(out[msgIndex], rest, cut);
  }
  if (compactedArguments) {
    log.warn(`[response-store] replaced oversized tool call arguments in ${compactedArguments} slot(s)`);
  }
  return out;
}

// Tokens a JSON client uses to mean "no" in a field the schema types as boolean.
const FALSY_STORE_TOKENS = new Set(['false', '0', 'no', 'off', '']);

/**
 * Does this `store` value ask for persistence?
 *
 * The check used to be `opts.store === false` — strict, on a value that arrives
 * RAW off the request body (handlers/responses.js passes `store: body.store` with
 * no normalization). So only a real JSON `false` opted out. MEASURED against HEAD:
 *   store=false  -> not stored (correct)
 *   store="false" / 0 / "no" / "off" / null / ""  -> ALL stored and retrievable
 * A client that spells the flag as a string — form-encoded relays, shell wrappers
 * and hand-rolled clients all do — got retention it explicitly opted out of, and
 * had no way to tell.
 *
 * WHERE this belongs: here, not only at the HTTP boundary. The retention decision
 * is the store's own contract ("`store:false` means this response is not
 * retained"), and the store is what would have to be audited if the promise were
 * broken. A boundary-only fix leaves the strict comparison in place for every
 * other caller, present and future, and this call site was added by exactly that
 * kind of later wiring. The boundary is still where a MALFORMED request should be
 * rejected outright; normalizing here means the store never over-retains even when
 * it is not.
 *
 * `undefined` means the field was absent, and the OpenAI default is store=true —
 * so absent must NOT read as opted out. An explicit `null` does: it is a value the
 * client chose to send, and for a retention decision the safe reading of an
 * ambiguous explicit value is "do not retain" (the cost is a 404 on a later chain
 * attempt, which is diagnosable; the cost of the other reading is silent retention
 * of data the caller may believe was never kept). An unrecognized token
 * ("maybe", {}) is not an opt-out signal and keeps the documented default.
 */
export function wantsPersistence(store) {
  if (store === undefined) return true;
  if (store === null) return false;
  if (typeof store === 'boolean') return store;
  if (typeof store === 'number') return store !== 0;
  if (typeof store === 'string') return !FALSY_STORE_TOKENS.has(store.trim().toLowerCase());
  return true;
}

/**
 * Store the accumulated conversation under a response id.
 *
 * @param {string} responseId  the id handed back to the client
 * @param {Array}  messages    FULL conversation for this turn (input + output)
 * @param {string} callerKey   tenant/identity scope
 * @param {object} [opts]      { model?: string, store?: boolean|string|number|null,
 *                               metadata?: object, status?: string, incompleteReason?: string|null }
 * @returns {boolean} true when persisted
 */
export function putResponse(responseId, messages, callerKey, opts = {}) {
  if (!ENABLED || !responseId || !Array.isArray(messages) || !messages.length) return false;
  // The OpenAI contract: `store: false` means this response is not retained, so
  // it can never serve as a later previous_response_id. Normalized rather than
  // compared strictly — see wantsPersistence for what the strict check let through.
  if (!wantsPersistence(opts.store)) return false;
  // No caller scope means no way to isolate this conversation from another
  // tenant's — refuse rather than create a shared-readable entry.
  if (!callerKey) { _stats.rejected++; return false; }
  ensureSweepTimer();

  // Ownership is enforced on the WRITE path too. Lookup and delete were scoped
  // from the start, but replacement was keyed on responseId alone: a second
  // caller putting an existing id inherited the owner's metadata/model/status/
  // createdAt, then dropEntry() removed the owner's entry and stored the writer's.
  // A's next read became 'forbidden' for A's own id, and B read A's metadata.
  // Reject before eviction, inheritance, replacement or any accounting change;
  // the only counter that moves is `rejected`.
  const existing = _entries.get(responseId);
  if (existing && existing.callerKey !== callerKey) {
    _stats.rejected++;
    log.warn(`[response-store] rejected cross-caller overwrite of ${String(responseId).slice(0, 24)}`);
    return false;
  }

  // ── 1. validate + prepare — NO state mutation ────────────────────────────
  //
  // A19: the count victim used to be dropped BEFORE `copyStoredValue`, which is
  // fallible (structuredClone refuses functions/symbols, and a getter can throw).
  // A failed new put therefore deleted an unrelated conversation even though it
  // stored nothing. Everything fallible now happens here: truncation, copy,
  // metadata binding and final size admission. `_entries`, the tenant maps and
  // every counter stay untouched until the commit below.
  //
  // Select — but do NOT drop — the entry-count victim. Selection is a pure read;
  // dropping it is part of the synchronous commit.
  let countVictim = null;
  if (_entries.size >= MAX_ENTRIES && !existing) {
    // Fair share: a tenant already at or above its slice evicts its OWN oldest
    // conversation instead of a stranger's.
    const tenant = tenantOf(callerKey);
    const fairShare = Math.max(1, Math.floor(MAX_ENTRIES / Math.max(1, _tenantCounts.size)));
    const overShare = (_tenantCounts.get(tenant) || 0) >= fairShare;
    countVictim = (overShare && oldestId(tenant)) || oldestId();
  }

  const now = Date.now();

  // The slot follows the same refresh rule as the other optional fields: an
  // explicit value wins, an absent one keeps what the entry already had.
  const metadata = opts.metadata === undefined
    ? (existing?.metadata ?? null)
    : boundMetadata(opts.metadata);
  const createdAt = existing?.createdAt || now;
  const model = opts.model || existing?.model || null;
  // The turn's terminal status, so a later retrieval reports what the CREATING
  // request reported. Without it GET had to hardcode 'completed' and contradicted
  // POST for the same id whenever the turn ended as `incomplete`.
  const status = opts.status || existing?.status || 'completed';
  const incompleteReason = opts.incompleteReason ?? existing?.incompleteReason ?? null;

  // A20: meter every retained field, not just `messages`. The fixed part includes
  // responseId (the Map key), callerKey, model, status, incompleteReason and
  // metadata, so messages get only what remains of the per-entry ceiling.
  const fixedBytes = entryFixedBytes({ responseId, callerKey, model, status, incompleteReason, metadata });
  const messageBudget = MAX_ENTRY_BYTES - fixedBytes;
  if (messageBudget <= 0) {
    _stats.rejected++;
    return false;
  }

  // Existing limiters are copy-on-write. Clone only the retained graph, so
  // discarded history is not copied and no stored object aliases the caller.
  const capped = capEntryBytes(truncateMessages(messages), messageBudget);
  if (!capped) {
    // Trimming hit structural data it must not cut (ids, discriminators, keys).
    // Reject rather than store an entry over the ceiling.
    _stats.rejected++;
    return false;
  }
  const kept = copyStoredValue(capped);
  const bytes = fixedBytes + retainedBytes(kept);

  // Final admission. Both limits are hard: an entry that cannot satisfy the
  // per-entry ceiling — and therefore can never satisfy the total budget — is
  // rejected without changing the old entry or any accounting.
  if (!Number.isFinite(bytes) || bytes > MAX_ENTRY_BYTES || bytes > MAX_BYTES) {
    _stats.rejected++;
    return false;
  }

  // ── 2. synchronous commit — no fallible operations below this line ────────
  const countVictimEntry = countVictim ? _entries.get(countVictim) : null;
  if (countVictim) { dropEntry(countVictim); _stats.evictions++; }
  if (existing) dropEntry(responseId);
  trackInsert(callerKey, bytes);
  _entries.set(responseId, {
    messages: kept, callerKey, model, status, incompleteReason, metadata,
    createdAt, lastAccess: now, bytes,
  });
  _bytes += bytes;

  // ── 3. post-commit cleanup — byte budget ──────────────────────────────────
  //
  // Entry/message counts bound cardinality, NOT memory, so evict until the byte
  // total fits as well.
  //
  // The fairness test must be BYTE-denominated. The first cut reused the count
  // test (`tenantCount >= MAX_ENTRIES / tenants`), which under any byte-bound
  // workload leaves the writer far below its entry share — so `overShare` was
  // always false, the loop fell through to the untenanted scan, and one caller
  // storing a large conversation flushed every other tenant's sessions.
  // Reproduced: 5 tenants x 5 conversations all readable, then a single 5MB write
  // evicted 25/25 of them. That is a cross-tenant DoS the count-only store never
  // had, so fairness here compares the tenant's BYTES against MAX_BYTES/tenants.
  //
  // `exclude: responseId` is load-bearing and NOT redundant with `size > 1`: the
  // Map-tail argument only holds for the untenanted scan. oldestId(tenant) can
  // return the entry just written when it is that tenant's oldest survivor, and
  // then putResponse returned true while the id 404'd immediately after
  // (reproduced with MAX=2, MAX_BYTES=200k). An earlier version dropped this
  // guard as dead code because the mutation test only exercised the untenanted
  // path.
  //
  // The share has a FLOOR. `MAX_BYTES / tenants` alone collapses as tenants grow:
  // at 600 tenants against the 2MB test budget the share is ~3.5KB, so every
  // tenant is over share, every iteration evicts the writer's own oldest, and once
  // the writer has nothing left of its own the old loop broke — with the budget
  // still blown. Reproduced: 600 tenants x one 20KB conversation → 5.88x the
  // budget and ZERO evictions. The floor keeps eviction working past that point,
  // and enforceByteBudget falls back to the global LRU instead of exiting over
  // budget (P-02).
  if (!enforceByteBudget(responseId)) {
    // Unreachable while MAX_ENTRY_BYTES <= MAX_BYTES and every entry was admitted
    // through the check above. Kept as a rollback so a future change cannot turn a
    // failed write into a deleted old entry.
    dropEntry(responseId);
    if (existing) {
      _entries.set(responseId, existing);
      _bytes += existing.bytes || 0;
      trackInsert(existing.callerKey, existing.bytes || 0);
    }
    if (countVictimEntry && !_entries.has(countVictim)) {
      _entries.set(countVictim, countVictimEntry);
      _bytes += countVictimEntry.bytes || 0;
      trackInsert(countVictimEntry.callerKey, countVictimEntry.bytes || 0);
    }
    _stats.rejected++;
    return false;
  }
  _stats.stored++;
  return true;
}

/**
 * Resolve a previous_response_id to its accumulated conversation.
 *
 * Returns a discriminated result so the caller can fail LOUDLY on a miss. Silently
 * proceeding with just the new turn is the bug this module exists to remove: the
 * model would answer with no context and the client could not tell.
 *
 * `createdAt` is returned so the retrieval endpoint can report the response's real
 * creation time instead of the time it happened to be read, and `metadata` so the
 * tag the creating request attached survives to a later GET.
 *
 * @returns {{ ok: true, messages: Array, model: string|null, createdAt: number,
 *             metadata: object|null }
 *          | { ok: false, reason: 'disabled'|'not_found'|'expired'|'forbidden' }}
 */
export function getResponse(responseId, callerKey) {
  if (!ENABLED) return { ok: false, reason: 'disabled' };
  if (!responseId) return { ok: false, reason: 'not_found' };
  ensureSweepTimer();

  const entry = _entries.get(responseId);
  if (!entry) { _stats.misses++; return { ok: false, reason: 'not_found' }; }

  const now = Date.now();

  // Ownership is settled BEFORE anything is dropped. This used to be the other way
  // round: the expiry branch called dropEntry() and returned nine lines above this
  // guard, so a foreign caller who guessed a valid id DELETED the owner's expired
  // entry. Probing was indeed closed (the guard's own promise), but the branch above
  // it had already acted. MEASURED at RESPONSE_STORE_TTL_MS=60, entry owned by A:
  //   after expiry, B reads -> ok=false reason='expired'
  //   then A reads          -> ok=false reason='not_found'   <- B's read reaped it
  // Reordering keeps both properties, and the reason each case returns is:
  //   foreign caller, entry fresh OR expired -> 'forbidden', and NOTHING is dropped.
  //     The outward result is identical to a miss (handlers/responses.js maps
  //     'forbidden', 'expired' and 'not_found' to the same 404 body, so the reason
  //     was never the leak — the DELETION was), and the foreign caller now also
  //     cannot distinguish an expired id from a fresh one by its side effect.
  //   owner, entry expired -> 'expired', and the entry IS reaped, so the owner's
  //     own dead conversation is still collected on the lookup path rather than
  //     waiting for the 5-minute sweep.
  if (entry.callerKey !== callerKey) {
    _stats.rejected++;
    log.warn(`[response-store] rejected cross-caller lookup of ${String(responseId).slice(0, 24)}`);
    return { ok: false, reason: 'forbidden' };
  }

  // Two independent bounds, both reported as 'expired' because the client-visible
  // meaning is the same ("this conversation is gone, send full context"):
  // the IDLE timeout, which a read refreshes, and the ABSOLUTE age, which it does
  // not. Without the second one a periodic GET kept an entry alive without limit.
  if (isPastIdle(entry, now) || isPastMaxAge(entry, now)) {
    dropEntry(responseId);
    _stats.expires++;
    return { ok: false, reason: 'expired' };
  }

  entry.lastAccess = now;
  // Re-insert to keep Map order == LRU order.
  _entries.delete(responseId);
  _entries.set(responseId, entry);
  _stats.hits++;
  return {
    ok: true,
    // Each reader owns its result, including nested content/tool-call objects.
    messages: copyStoredValue(entry.messages),
    model: entry.model,
    createdAt: entry.createdAt,
    status: entry.status,
    incompleteReason: entry.incompleteReason,
    // The tag the CREATING request attached, so a later GET reports the same
    // metadata the response object carried. Copied like every other field a
    // reader can reach: the entry must not be mutable through the result.
    metadata: entry.metadata ? copyStoredValue(entry.metadata) : null,
  };
}

/** Explicit deletion (DELETE /v1/responses/{id}). Scoped like the lookup. */
export function deleteResponse(responseId, callerKey) {
  if (!ENABLED || !responseId) return false;
  const entry = _entries.get(responseId);
  if (!entry) return false;
  if (entry.callerKey !== callerKey) { _stats.rejected++; return false; }
  return dropEntry(responseId);
}

export function getResponseStoreStats() {
  return {
    ..._stats,
    size: _entries.size,
    bytes: _bytes,
    maxBytes: MAX_BYTES,
    // Both time bounds, reported for the same reason maxBytes is: an operator
    // asking "how long is a conversation kept?" has two different answers, and the
    // idle one on its own does not bound retention at all.
    ttlMs: TTL_MS,
    maxAgeMs: MAX_AGE_MS,
    enabled: ENABLED,
    tenants: _tenantCounts.size,
  };
}

/** Test/reset helper. */
export function resetResponseStore() {
  _entries.clear();
  _tenantCounts.clear();
  _tenantBytes.clear();
  _bytes = 0;
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}
