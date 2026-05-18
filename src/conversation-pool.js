/**
 * Cascade conversation reuse pool (experimental).
 *
 * Goal: when a multi-turn chat continues a previous exchange, reuse the same
 * Windsurf `cascade_id` instead of starting a fresh one. This lets the
 * Windsurf backend keep its own per-cascade context cached — we avoid
 * resending the full history on each turn and the server responds faster.
 *
 * The key is a "state digest" of the caller-visible trajectory up to (but
 * not including) the newest user/tool result turn. v2.0.25 upgraded the key
 * from a relaxed "user text only" projection to a server-state semantic key
 * that includes assistant text + tool_calls digest, normalized system,
 * stable media digests, and (when tool-emulating) the tool schema digest.
 * This trades some hit rate for correctness: when the client's prior
 * assistant / system / tool context drifts, we miss instead of silently
 * resuming a stale upstream cascade.
 *
 * Safety rails:
 *   - Entries are pinned to a specific (apiKey, lsPort) pair. We must reuse
 *     the same LS and the same account or the cascade_id is meaningless.
 *   - A checked-out entry is removed from the pool. Concurrent second request
 *     with the same fingerprint falls back to a fresh cascade.
 *   - TTL defaults to 30 min (override with CASCADE_POOL_TTL_MS); LRU eviction
 *     at 500 entries.
 */

import { createHash } from 'crypto';

function positiveIntEnv(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const POOL_TTL_MS = positiveIntEnv('CASCADE_POOL_TTL_MS', 30 * 60 * 1000);
const POOL_MAX = positiveIntEnv('CASCADE_POOL_MAX', 500);
const KEY_VERSION = 2;

// When enabled, a secondary index maps (callerKey + modelKey) → latest
// fingerprint. If the primary fingerprint lookup misses but the caller has
// a recent cascade for the same model, we fall back to it. This makes
// reuse robust against fingerprint drift (system-prompt changes, tool-list
// reordering, etc.) within a single Claude Code / Cline session.
const REUSE_BY_CALLER = process.env.CASCADE_REUSE_BY_CALLER === '1';

const _pool = new Map();
// Secondary index: callerKey:modelKey → fingerprint (latest). Only
// populated when REUSE_BY_CALLER is on.
const _callerLatest = new Map();

const stats = { hits: 0, misses: 0, stores: 0, evictions: 0, expired: 0, callerFallbackHits: 0 };

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

function shortDigest(s, n = 16) {
  return sha256(String(s ?? '')).slice(0, n);
}

// Client-injected meta tags whose bodies change every turn (cwd snapshot,
// todo state, current time, hook output, slash-command echo). If we hash
// these, the fingerprint drifts even when the real user text is unchanged
// and Cascade reuse silently falls back to fresh for every call
// (issue #24). Strip them before hashing.
const META_TAG_NAMES = new Set([
  'system-reminder',
  'command-message',
  'command-name',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'user-prompt-submit-hook',
  'analysis',
  'summary',
  'example',
]);

function buildMetaTagRe() {
  const escaped = [...META_TAG_NAMES].map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(
    `<(${escaped.join('|')})[^>]*>[\\s\\S]*?</\\1>`,
    'g'
  );
}
let META_TAG_RE = buildMetaTagRe();

function stripMetaTags(s) {
  if (typeof s !== 'string' || !s) return s;
  const stripped = s.replace(META_TAG_RE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // Unknown tags are caller content. Never learn them into the global
  // stripping set or fingerprints stop being a pure function of the request.
  const remaining = stripped.match(/<([a-z][-a-z_]*)[^>]*>[\s\S]*?<\/\1>/g);
  if (remaining?.length) {
    const tagNames = remaining.map(m => m.match(/^<([a-z][-a-z_]*)/)?.[1]).filter(Boolean);
    const unknown = tagNames.filter(t => !META_TAG_NAMES.has(t));
    if (unknown.length) {
      console.error(`[META_TAG_AUDIT] Unknown XML tags in user message: ${[...new Set(unknown)].join(', ')}`);
    }
  }
  return stripped;
}

// v2.0.61 (#111) — normalize dynamic chunks of the system prompt that
// drift across turns (today's date, ISO timestamps, working directory,
// session UUIDs) so the same logical Claude Code session keeps the
// same cascade fingerprint instead of cache-missing every turn.
//
// Without this, Claude Code's 26KB system prompt (which embeds the
// current date / cwd / session id) hashed differently every request,
// reuse silently fell back to fresh, and the model looked like it was
// "looping" because each call started a new cascade.
//
// Patterns are conservative — only normalize tokens that are
// (a) verifiably temporal/identifier-shaped and (b) common enough in
// real Claude Code system prompts that their presence dominated the
// hash. Plain prose drift remains in the hash so genuine prompt edits
// still create a fresh cascade.
function normalizeSystemPromptForHash(s) {
  let out = String(s || '');
  // ─── temporal / identifier tokens ────────────────────────────
  out = out
    // ISO 8601 timestamps (with or without ms / tz)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    // "Today's date is YYYY-MM-DD" / "Today is YYYY-MM-DD" / etc.
    .replace(/\b(Today(?:'s)?\s+(?:date|is)(?:\s+is)?\s*[:\-]?\s*)\d{4}-\d{2}-\d{2}/gi, '$1<date>')
    // Bare YYYY-MM-DD lines (date-only) when standalone
    .replace(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d|T)/g, '<date>')
    // UUIDs (8-4-4-4-12 hex) — session/account ids, always
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    // Working directory lines (Claude Code prepends each turn).
    //
    // v2.0.78 (audit H-3): the previous form
    //   `'$&'.replace(/[^:：]+$/, ' <cwd>')`
    // was a parse-time evaluation of `'$&'.replace(...)` which
    // collapsed to the literal string `' <cwd>'` — every match was
    // replaced by the bare placeholder, dropping the label too. Two
    // sessions whose only label difference was `Working directory:`
    // vs `cwd:` would hash identically (potential cross-session
    // reuse). Now uses a real capture group so the label is
    // preserved.
    .replace(/(^[ \t]*[-•]?\s*(?:Working\s+directory|Current\s+working\s+directory|cwd|CWD)\s*[:：])[^\n]*/gim, '$1 <cwd>')
    // "Current time:" / "Time:" lines (same fix as above)
    .replace(/(^[ \t]*[-•]?\s*(?:Current\s+(?:date|time)|Time)\s*[:：])[^\n]*/gim, '$1 <time>')
    // Session ID lines (Claude Code 2.x emits these)
    .replace(/(^[ \t]*[-•]?\s*(?:Session\s*ID|sessionId|session_id)\s*[:：])[^\n]*/gim, '$1 <sessionid>')
    // Epoch timestamps in seconds (10 digits) or ms (13 digits) when
    // bare (not part of a longer number). Claude Code's status line and
    // some MCP servers emit these. 1700000000 (2023-11) to 2099999999
    // (2036) covers the realistic range without hitting other 10-digit
    // numbers like phone numbers or IDs.
    .replace(/(?<![\d.])(?:1[7-9]|20)\d{8}(?:\d{3})?(?![\d.])/g, '<epoch>');

  // ─── git status / recent commits block (Claude Code 2.x) ─────
  //
  // v2.0.74 (#116 zhangzhang-bit). Claude Code prepends a `gitStatus:`
  // block to the system prompt:
  //
  //     gitStatus: This is the git status at the start of the conversation.
  //
  //     Current branch: master
  //     Main branch (you will usually use this for PRs): master
  //     Git user: dwgx
  //     Status:
  //     M src/foo.js
  //     ?? newfile.txt
  //
  //     Recent commits:
  //     abc1234 release: 2.0.73 — ...
  //     def5678 release: 2.0.72 — ...
  //
  // The body shifts every time the user commits or touches a file but
  // the labels are invariant. zhangzhang-bit's #116 log shows
  // 26892-byte system prompts hashing differently across 30 turns —
  // commit-hash diffs in this block keep total length stable while
  // changing content, so length-based detection misses it.
  //
  // Strategy: collapse the body of `Status:`, `Recent commits:`, and
  // `Recent files:` to a stable placeholder. Headings + Branch / Main
  // branch / Git user keep their literal values (those rarely move
  // and meaningfully separate caches when they do). Lookahead anchors
  // the body extent at the next labelled heading or a blank line; if
  // the block runs to end-of-input, $(?![\s\S]) catches that too
  // since plain `$` under /m only matches end-of-line in JS.
  const NEXT_HEADING = '(?:Status|Recent commits|Recent files|gitStatus|Current branch|Main branch|Git user)\\s*:';
  const blockEnd = `(?=^[ \\t]*${NEXT_HEADING}|^\\s*$|$(?![\\s\\S]))`;
  out = out.replace(
    new RegExp(`^([ \\t]*Status\\s*:)[ \\t]*\\n[\\s\\S]*?${blockEnd}`, 'gim'),
    '$1\n<git-status>\n',
  );
  out = out.replace(
    new RegExp(`^([ \\t]*Recent commits\\s*:)[ \\t]*\\n[\\s\\S]*?${blockEnd}`, 'gim'),
    '$1\n<recent-commits>\n',
  );
  out = out.replace(
    new RegExp(`^([ \\t]*Recent files\\s*:)[ \\t]*\\n[\\s\\S]*?${blockEnd}`, 'gim'),
    '$1\n<recent-files>\n',
  );

  // ─── git short hashes ────────────────────────────────────────
  // After Recent commits is folded above we still want to catch stray
  // short hashes that callers paste inline ("see commit abc1234"). 7-12
  // hex chars with word boundaries; require at least one digit AND at
  // least one a-f letter so we skip both ordinary words like deadbeef
  // (no digits) and bare integers like 1234567890 (no hex letters).
  // Skip if wrapped in quotes (likely a literal string the user is
  // asking about — preserving it lets distinct queries hash distinctly).
  out = out.replace(/(?<![`'"\w])(?=[a-f0-9]*\d)(?=[a-f0-9]*[a-f])[a-f0-9]{7,12}(?![`'"\w])/gi, '<gitsha>');

  return out;
}

// Stable JSON: recursively sort object keys so {b:1,a:2} and {a:2,b:1}
// produce the same string. Without this, two equivalent inputs hash
// differently when client serialization order varies.
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

// Project one content block into a typed canonical record. Returns
// { type, ...payload } where payload uses stable hashes for binary media.
// `unhashable=true` flags blocks we cannot stably digest — caller's
// canonicalise() turns this into a `null` fingerprint, disabling reuse for
// the request rather than silently colliding distinct media inputs.
function canonicalContentBlock(part) {
  if (typeof part?.text === 'string') return { type: 'text', text: stripMetaTags(part.text) };
  if (typeof part === 'string') return { type: 'text', text: stripMetaTags(part) };
  const type = String(part?.type || '').toLowerCase();
  // image_url block (OpenAI / Anthropic image_url style)
  if (type === 'image_url' || type === 'image' || type === 'input_image') {
    const url = part?.image_url?.url || part?.url || '';
    if (typeof url === 'string' && url.startsWith('data:')) {
      const comma = url.indexOf(',');
      const meta = comma > 0 ? url.slice(5, comma) : '';
      const data = comma > 0 ? url.slice(comma + 1) : url;
      return { type: 'image', meta, hash: shortDigest(data, 16) };
    }
    if (typeof url === 'string' && url) return { type: 'image', url };
    if (typeof part?.source === 'object') {
      const src = part.source;
      if (src.type === 'base64' && typeof src.data === 'string') {
        return { type: 'image', meta: src.media_type || '', hash: shortDigest(src.data, 16) };
      }
      if (src.type === 'url' && typeof src.url === 'string') {
        return { type: 'image', url: src.url };
      }
      if (typeof src.file_id === 'string') return { type: 'image', file_id: src.file_id };
    }
    return { type: 'image', unhashable: true };
  }
  // file / document block
  if (type === 'document' || type === 'file' || type === 'input_file') {
    const fileId = part?.file_id || part?.source?.file_id;
    if (typeof fileId === 'string') return { type: 'file', file_id: fileId };
    if (part?.source?.type === 'base64' && typeof part.source.data === 'string') {
      return { type: 'file', meta: part.source.media_type || '', hash: shortDigest(part.source.data, 16) };
    }
    if (typeof part?.source?.url === 'string') return { type: 'file', url: part.source.url };
    return { type: 'file', unhashable: true };
  }
  // Any other typed block — stable JSON of the whole part. Catches things
  // like { type: 'tool_use', ... } when they appear in mixed content arrays.
  return { type: type || 'unknown', json: stableStringify(part ?? '') };
}

function canonicaliseContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: stripMetaTags(content) }];
  if (!Array.isArray(content)) return [{ type: 'json', json: stableStringify(content ?? '') }];
  return content.map(canonicalContentBlock);
}

function hasUnhashableMedia(blocks) {
  return Array.isArray(blocks) && blocks.some(b => b?.unhashable === true);
}

// Project assistant tool_calls into a stable digest. Both OpenAI
// `tool_calls: [{id, function:{name, arguments}}]` and Anthropic
// `content: [{type:'tool_use', name, input}]` shapes need to map to the
// same canonical form so the same logical call digests identically.
function projectAssistantToolCalls(m) {
  const calls = [];
  if (Array.isArray(m?.tool_calls)) {
    for (const tc of m.tool_calls) {
      const name = tc?.function?.name || tc?.name || '';
      const args = tc?.function?.arguments;
      let argsCanonical;
      if (typeof args === 'string') {
        try { argsCanonical = stableStringify(JSON.parse(args)); }
        catch { argsCanonical = args; }
      } else if (args !== undefined) {
        argsCanonical = stableStringify(args);
      } else if (tc?.input !== undefined) {
        argsCanonical = stableStringify(tc.input);
      } else {
        argsCanonical = '';
      }
      calls.push({ name, args: argsCanonical });
    }
  }
  if (Array.isArray(m?.content)) {
    for (const part of m.content) {
      if (part?.type === 'tool_use') {
        calls.push({ name: part.name || '', args: stableStringify(part.input ?? null) });
      }
    }
  }
  return calls;
}

function projectMessage(m) {
  const role = m?.role;
  if (role === 'system') {
    const blocks = canonicaliseContent(m.content);
    return { role: 'system', content: blocks };
  }
  if (role === 'user') {
    const blocks = canonicaliseContent(m.content);
    return { role: 'user', content: blocks };
  }
  if (role === 'tool') {
    return {
      role: 'tool_result',
      tool_call_id: typeof m?.tool_call_id === 'string' ? m.tool_call_id : '',
      content: canonicaliseContent(m.content),
    };
  }
  if (role === 'assistant') {
    // Project to a stable text + tool_calls digest. Drop reasoning / metadata
    // / id fields that drift across re-renders.
    const blocks = canonicaliseContent(m.content);
    const text = blocks
      .filter(b => b.type === 'text')
      .map(b => (b.text || '').replace(/\s+/g, ' ').trim())
      .join('\n')
      .trim();
    const toolCalls = projectAssistantToolCalls(m);
    return { role: 'assistant', text, tool_calls: toolCalls };
  }
  // Unknown role — preserve as-is so it's neither swallowed nor confused
  // with a known projection.
  return { role: String(role || 'unknown'), content: canonicaliseContent(m?.content) };
}

function systemDigest(messages) {
  // CASCADE_REUSE_HASH_SYSTEM=0 is an explicit opt-out for callers whose
  // system prompt drifts every turn (Claude Code with `cwd` snapshots etc.)
  // and who care more about hit rate than strict isolation. Default ON
  // since the audit found that "default exclude system" caused silent
  // cross-system reuse.
  if (process.env.CASCADE_REUSE_HASH_SYSTEM === '0') return '';
  const sys = messages.filter(m => m?.role === 'system');
  if (!sys.length) return '';
  // v2.0.61 (#111) — apply normalizeSystemPromptForHash to each text
  // block so dynamic chunks (today's date / cwd / session id / ISO ts /
  // UUIDs) don't drift the system fingerprint each turn.
  const normalized = sys.map(m => {
    const projected = projectMessage(m);
    if (Array.isArray(projected.content)) {
      projected.content = projected.content.map(b => {
        if (b?.type === 'text' && typeof b.text === 'string') {
          return { ...b, text: normalizeSystemPromptForHash(b.text) };
        }
        return b;
      });
    }
    return projected;
  });
  return shortDigest(stableStringify(normalized), 32);
}

function toolContextDigest(opts = {}) {
  if (!opts.emulateTools) return '';
  // v2.0.61 (#111) — sort tools by name before hashing so client-side
  // ordering changes (Claude Code 2.x occasionally reshuffles its 70+
  // tool list across turns) don't drift the tool fingerprint.
  const tools = (Array.isArray(opts.tools) ? opts.tools.map(t => {
    const fn = t?.function || t;
    return {
      name: fn?.name || '',
      description: fn?.description || '',
      parameters: fn?.parameters ?? fn?.input_schema ?? null,
    };
  }) : []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return shortDigest(stableStringify({
    tools,
    tool_choice: opts.toolChoice ?? null,
    preambleTier: opts.preambleTier ?? null,
    toolPreambleHash: opts.toolPreamble ? shortDigest(opts.toolPreamble, 16) : '',
  }), 32);
}

// Build the array of stable turns up to (but not including) the newest user
// or tool turn. This is what fpBefore digests. It includes every assistant
// turn and every system/user/tool turn except the trailing user/tool turn.
function priorTurnsForBefore(messages) {
  if (!Array.isArray(messages)) return null;
  // Find newest user/tool turn — that's the "newest" we drop.
  let newestStable = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const r = messages[i]?.role;
    if (r === 'user' || r === 'tool') { newestStable = i; break; }
  }
  if (newestStable < 0) return null;
  // Need at least one prior turn to make reuse meaningful.
  if (newestStable === 0) return null;
  return messages.slice(0, newestStable);
}

function projectTurns(turns) {
  if (!Array.isArray(turns)) return null;
  const projected = [];
  for (const m of turns) {
    if (m?.role === 'system') continue; // system handled separately
    const p = projectMessage(m);
    if (Array.isArray(p.content) && hasUnhashableMedia(p.content)) return { unhashable: true };
    projected.push(p);
  }
  return { turns: projected };
}

function buildKeyPayload({ messages, modelKey, callerKey, opts, scope }) {
  const sys = systemDigest(messages);
  const tools = toolContextDigest(opts);
  const turnSlice = scope === 'after' ? messages : priorTurnsForBefore(messages);
  if (!turnSlice) return null;
  const projection = projectTurns(turnSlice);
  if (!projection) return null;
  if (projection.unhashable) return null;
  return stableStringify({
    v: KEY_VERSION,
    caller: String(callerKey || ''),
    model: String(modelKey || ''),
    route: opts?.route || 'chat',
    sys,
    tools,
    turns: projection.turns,
  });
}

/**
 * Fingerprint for "I'm about to send this newest user turn — find me a
 * cascade I can resume." Hashes everything before the newest user/tool
 * turn (including assistant text + tool_calls digest, system, tools).
 *
 * Signatures (backward-compatible):
 *   fingerprintBefore(messages)
 *   fingerprintBefore(messages, modelKey)
 *   fingerprintBefore(messages, modelKey, callerKey)
 *   fingerprintBefore(messages, modelKey, callerKey, opts)
 * where opts = { tools, toolChoice, toolPreamble, emulateTools,
 *                preambleTier, route }
 *
 * Returns null when reuse should be disabled (single-turn, unhashable
 * media in prior history, etc.).
 */
export function fingerprintBefore(messages, modelKey = '', callerKey = '', opts = {}) {
  const payload = buildKeyPayload({ messages, modelKey, callerKey, opts, scope: 'before' });
  if (!payload) return null;
  return sha256(payload);
}

/**
 * Fingerprint for "I just finished a turn — store the cascade under the
 * key the next request will look up." Same shape as fingerprintBefore but
 * over the FULL message list (the newest user turn is included so the
 * post-turn fingerprint represents server state right after that turn).
 */
export function fingerprintAfter(messages, modelKey = '', callerKey = '', opts = {}) {
  if (!Array.isArray(messages) || !messages.length) return null;
  // For "after" we want the entire trajectory we've seen, including the
  // newest user/tool/assistant turn the caller just exchanged with us.
  const sys = systemDigest(messages);
  const tools = toolContextDigest(opts);
  const projection = projectTurns(messages.filter(m => m?.role !== 'system'));
  if (!projection || projection.unhashable) return null;
  return sha256(stableStringify({
    v: KEY_VERSION,
    caller: String(callerKey || ''),
    model: String(modelKey || ''),
    route: opts?.route || 'chat',
    sys,
    tools,
    turns: projection.turns,
  }));
}

function effectiveTtl(entry) {
  const hint = Number(entry?.ttlHintMs);
  return Number.isFinite(hint) && hint > 0 ? hint : POOL_TTL_MS;
}

function prune(now) {
  for (const [fp, e] of _pool) {
    if (now - e.lastAccess > effectiveTtl(e)) { _pool.delete(fp); stats.expired++; }
  }
  if (_pool.size <= POOL_MAX) {
    _pruneCallerIndex();
    return;
  }
  const entries = [..._pool.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  const toDrop = entries.length - POOL_MAX;
  for (let i = 0; i < toDrop; i++) {
    _pool.delete(entries[i][0]);
    stats.evictions++;
  }
  _pruneCallerIndex();
}

function _pruneCallerIndex() {
  if (!REUSE_BY_CALLER || !_callerLatest.size) return;
  for (const [ck, fp] of _callerLatest) {
    if (!_pool.has(fp)) _callerLatest.delete(ck);
  }
}

/**
 * Check out a conversation if we have a matching fingerprint AND the caller
 * is willing to use the same (apiKey, lsPort) we stored. Removes the entry
 * from the pool — caller is expected to call `checkin()` with a new
 * fingerprint on success (or just drop it on failure and a fresh cascade
 * will be created next turn).
 *
 * v2.0.25 added optional `expected` for atomic owner verification at the
 * pool boundary (MED-3). Pass `{ apiKey, lsPort, lsGeneration }` and a
 * mismatch returns null + counts a miss without leaking the entry.
 */
export function checkout(fingerprint, callerKey = '', expected = null, modelKey = '') {
  if (!fingerprint) {
    // No fingerprint — try caller-based fallback before giving up.
    if (REUSE_BY_CALLER && callerKey && modelKey) {
      const fallback = _callerFallbackCheckout(callerKey, modelKey, expected);
      if (fallback) return fallback;
    }
    stats.misses++;
    return null;
  }
  const entry = _pool.get(fingerprint);
  if (!entry) {
    // Fingerprint miss — try caller-based fallback.
    if (REUSE_BY_CALLER && callerKey && modelKey) {
      const fallback = _callerFallbackCheckout(callerKey, modelKey, expected);
      if (fallback) return fallback;
    }
    stats.misses++;
    return null;
  }

  // Validate BEFORE removing from the pool. The previous order
  // (`delete` first, then check) had a subtle leak: when a caller's
  // request fingerprinted the same as someone else's (different
  // callerKey) we deleted the rightful owner's entry on the way to
  // returning null, so the legitimate caller lost their cascade
  // resume forever. Keep the entry in place on mismatch so the
  // owner's next turn still finds it.
  if (entry.callerKey && callerKey && entry.callerKey !== callerKey) {
    stats.misses++;
    return null;
  }
  if (Date.now() - entry.lastAccess > effectiveTtl(entry)) {
    _pool.delete(fingerprint);
    stats.expired++;
    stats.misses++;
    return null;
  }
  if (expected) {
    if (expected.apiKey && entry.apiKey && expected.apiKey !== entry.apiKey) { stats.misses++; return null; }
    if (expected.lsPort && entry.lsPort && expected.lsPort !== entry.lsPort) { stats.misses++; return null; }
    if (expected.lsGeneration != null && entry.lsGeneration != null && expected.lsGeneration !== entry.lsGeneration) {
      stats.misses++;
      return null;
    }
  }

  // Validated. Now remove and hand to the caller.
  _pool.delete(fingerprint);
  // Clean up caller index if it pointed at this fingerprint.
  if (REUSE_BY_CALLER && entry.callerKey) {
    for (const [ck, fp] of _callerLatest) {
      if (fp === fingerprint) _callerLatest.delete(ck);
    }
  }
  stats.hits++;
  return entry;
}

// Caller-based fallback: look up the latest fingerprint for this
// callerKey+model pair and check out that entry. Same validation as
// the primary path.
function _callerFallbackCheckout(callerKey, modelKey, expected) {
  const ck = `${callerKey}\0${modelKey}`;
  const fp = _callerLatest.get(ck);
  if (!fp) return null;
  const entry = _pool.get(fp);
  if (!entry) { _callerLatest.delete(ck); return null; }
  if (entry.callerKey && callerKey && entry.callerKey !== callerKey) return null;
  if (Date.now() - entry.lastAccess > effectiveTtl(entry)) {
    _pool.delete(fp);
    _callerLatest.delete(ck);
    stats.expired++;
    return null;
  }
  if (expected) {
    if (expected.apiKey && entry.apiKey && expected.apiKey !== entry.apiKey) return null;
    if (expected.lsPort && entry.lsPort && expected.lsPort !== entry.lsPort) return null;
    if (expected.lsGeneration != null && entry.lsGeneration != null && expected.lsGeneration !== entry.lsGeneration) return null;
  }
  _pool.delete(fp);
  _callerLatest.delete(ck);
  stats.callerFallbackHits++;
  stats.hits++;
  return entry;
}

/**
 * Store (or restore) a conversation entry under a new fingerprint.
 *
 * `fingerprint` accepts a single string OR an array of strings. When
 * an array is given the SAME entry is indexed under each fingerprint —
 * used by v2.0.87 auto-fallback (#129 wnfilm) to keep the cascade
 * findable under both the original-model fingerprint AND the
 * fallback-model fingerprint, so the next turn from the client (under
 * the original model name) doesn't miss the pool and force the LLM to
 * re-read history from scratch.
 *
 * `ttlHintMs` (optional) extends this entry's expiry past the pool's
 * default 30 min — used to honour Anthropic prompt-caching markers that
 * request a 1h ttl. Pass `undefined` (default) to keep the existing
 * entry-level hint when restoring across turns. Pass `0` (or negative)
 * to clear any inherited hint and fall back to the default TTL — used
 * when the next request explicitly does NOT carry a 1h marker so a stale
 * 1h window doesn't outlive its source request (MED-2).
 */
export function checkin(fingerprint, entry, callerKey = '', ttlHintMs) {
  if (!entry) return;
  const fingerprints = Array.isArray(fingerprint)
    ? fingerprint.filter((fp) => typeof fp === 'string' && fp)
    : (fingerprint ? [fingerprint] : []);
  if (!fingerprints.length) return;
  const now = Date.now();
  let resolvedHint;
  if (ttlHintMs === undefined) {
    resolvedHint = entry.ttlHintMs;
  } else if (ttlHintMs === null || !Number.isFinite(ttlHintMs) || ttlHintMs <= 0) {
    resolvedHint = undefined;
  } else {
    resolvedHint = ttlHintMs;
  }
  // Build the canonical entry once, then write under each requested
  // fingerprint. Each Map slot holds a separate object instance so a
  // future invalidate/checkout under one key doesn't accidentally
  // mutate the others.
  for (const fp of fingerprints) {
    _pool.set(fp, {
      cascadeId: entry.cascadeId,
      sessionId: entry.sessionId,
      lsPort: entry.lsPort,
      lsGeneration: entry.lsGeneration,
      apiKey: entry.apiKey,
      callerKey: callerKey || entry.callerKey || '',
      modelKey: entry.modelKey || '',
      stepOffset: Number.isFinite(entry.stepOffset) ? entry.stepOffset : 0,
      generatorOffset: Number.isFinite(entry.generatorOffset) ? entry.generatorOffset : 0,
      historyCoverage: entry.historyCoverage || null,
      createdAt: entry.createdAt || now,
      lastAccess: now,
      ...(Number.isFinite(resolvedHint) && resolvedHint > 0 ? { ttlHintMs: resolvedHint } : {}),
    });
  }
  // v2.0.88 (audit M-1): count once per logical checkin (one
  // conversation), not once per fingerprint slot. Otherwise the
  // dashboard's "stores" counter doubles whenever auto-fallback fires
  // and operators read pool efficiency wrong.
  stats.stores++;
  if (fingerprints.length > 1) stats.aliasWrites = (stats.aliasWrites || 0) + (fingerprints.length - 1);
  // Update caller-based secondary index.
  if (REUSE_BY_CALLER && (callerKey || entry.callerKey)) {
    const ck = callerKey || entry.callerKey;
    const mk = entry.modelKey || '';
    if (ck && fingerprints[0]) {
      _callerLatest.set(`${ck}\0${mk}`, fingerprints[0]);
    }
  }
  prune(now);
}

/**
 * Drop any entries that belong to a (apiKey, lsPort, lsGeneration) tuple
 * that just went away (account removed, LS restarted, LS replaced on the
 * same port). Keeps the pool honest.
 */
export function invalidateFor({ apiKey, lsPort, lsGeneration } = {}) {
  let dropped = 0;
  // v2.0.88 (audit H-2) — two-pass scan. v2.0.87 dual-write checkin
  // can index the same cascadeId under multiple fingerprint slots.
  // The previous single-pass `if (lsPort) delete` would only drop the
  // first slot it scanned; if the per-port scan iterated past a sibling
  // slot under different ordering, that slot stayed in the pool
  // pointing to a now-dead cascadeId on a now-restarted LS. Next turn
  // would hit `cascade not found`, set reuseEntryDead, and force a
  // full history replay — silent one-turn failure on every LS restart.
  // Pass 1: collect every cascadeId tied to the going-away tuple.
  // Pass 2: drop every slot pointing at any of those cascadeIds.
  const targetCascadeIds = new Set();
  for (const [, e] of _pool) {
    let hit = false;
    if (apiKey && e.apiKey === apiKey) hit = true;
    if (!hit && lsPort && e.lsPort === lsPort) {
      if (lsGeneration == null || e.lsGeneration == null || e.lsGeneration === lsGeneration) hit = true;
    }
    if (hit && e.cascadeId) targetCascadeIds.add(e.cascadeId);
  }
  for (const [fp, e] of _pool) {
    let drop = false;
    if (apiKey && e.apiKey === apiKey) drop = true;
    if (!drop && lsPort && e.lsPort === lsPort) {
      if (lsGeneration == null || e.lsGeneration == null || e.lsGeneration === lsGeneration) drop = true;
    }
    // Sibling-cleanup: any slot pointing at a cascadeId we already
    // decided to drop must also go, even if its own apiKey/lsPort
    // happens not to match (e.g. an alias slot whose apiKey was set
    // from the entry instead of the going-away account).
    if (!drop && e.cascadeId && targetCascadeIds.has(e.cascadeId)) drop = true;
    if (drop) {
      _pool.delete(fp);
      dropped++;
    }
  }
  // Clean caller index for dropped cascadeIds.
  if (REUSE_BY_CALLER && dropped > 0) {
    for (const [ck, fp] of _callerLatest) {
      if (!_pool.has(fp)) _callerLatest.delete(ck);
    }
  }
  return dropped;
}

export function poolStats() {
  return {
    size: _pool.size,
    maxSize: POOL_MAX,
    ttlMs: POOL_TTL_MS,
    reuseByCaller: REUSE_BY_CALLER,
    callerLatestSize: _callerLatest.size,
    ...stats,
    hitRate: stats.hits + stats.misses > 0
      ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1)
      : '0.0',
  };
}

export function poolClear() {
  const n = _pool.size;
  _pool.clear();
  _callerLatest.clear();
  return n;
}

// Background prune — without this, expired entries accumulate when there
// are no checkin() calls for a while (e.g. a quiet weekend). .unref() so
// this timer never holds the process open past real work.
setInterval(() => prune(Date.now()), 5 * 60 * 1000).unref();
