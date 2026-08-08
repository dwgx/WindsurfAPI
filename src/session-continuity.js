/**
 * Session continuity for DEVIN_CONNECT.
 *
 * Derives a stable protobuf session_id (#16) from the conversation's own completed
 * request/response pair fingerprints, so one multi-turn dialog reuses ONE session_id
 * instead of minting a fresh uuid per turn (which the upstream velocity limiter reads
 * as N brand-new sessions). Identity is the client-visible input/output only — never
 * requestId / session / IP / timestamp / provider signature.
 *
 * Architecture:
 *   1. Canonicalize OpenAI messages → events (role:kind:payload)
 *   2. Normalize tool linkage (semantic slot matching, not transport IDs)
 *   3. Split into completed pairs: [input] → [output]
 *   4. HMAC-hash each pair by scopeId
 *   5. Resolve by overlap scoring against stored pair windows
 *   6. Commit after response with idempotency guard
 *
 * Edge cases handled:
 *   - Tool call ID regeneration (retry/combo switch)
 *   - Orphan tool_result (barrier → blocks resolve)
 *   - System prompt changes (excluded from identity)
 *   - Parallel dialogs on same API key (different pair chains)
 *   - Output drift (client truncates response text)
 *   - Idempotent commits (same state → same stateId)
 */
import crypto from 'crypto';

// ─── Configuration ─────────────────────────────────────────────────────────

const SECRET = crypto.randomBytes(32);
const DEFAULT_TTL = 30 * 60 * 1000;
const DEFAULT_MAX_STATES = 500;
const PAIR_WINDOW_SIZE = 10;
const CLEANUP_INTERVAL = 5 * 60 * 1000;

function getTtl(env = process.env) {
  const v = Number(env.DEVIN_CONNECT_SESSION_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL;
}

function getMaxStates(env = process.env) {
  const v = Number(env.DEVIN_CONNECT_SESSION_MAX_STATES);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_STATES;
}

// ─── State Store ───────────────────────────────────────────────────────────

const statesById = new Map();
const pairIndex = new Map();       // `${scopeId}:${pairHash}` → Set<stateId>
const commitIndex = new Map();     // commitKey → stateId

export function isSessionReuseEnabled(env = process.env) {
  const v = String(env.DEVIN_CONNECT_SESSION_REUSE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// ─── Canonicalizer ─────────────────────────────────────────────────────────

function deriveScopeId(callerKey) {
  return crypto.createHmac('sha256', SECRET).update(callerKey || '').digest('hex');
}

function messageText(msg) {
  if (typeof msg?.content === 'string') return msg.content;
  if (Array.isArray(msg?.content)) return msg.content.map((p) => p?.text || '').join('');
  return '';
}

function canonicalizeArgs(args) {
  if (typeof args === 'string') {
    try { return JSON.stringify(JSON.parse(args)); } catch { return args; }
  }
  if (args && typeof args === 'object') return JSON.stringify(args);
  return '';
}

/**
 * Canonicalize OpenAI messages into a normalized event stream.
 * System/developer messages are EXCLUDED (they don't participate in pair identity).
 */
export function canonicalize(messages) {
  const events = [];
  for (const msg of (messages || [])) {
    if (!msg) continue;
    const role = msg.role || '';
    if (role === 'system' || role === 'developer') continue;

    if (role === 'tool') {
      events.push({
        role: 'tool',
        kind: 'tool_result',
        payload: { rawLink: msg.tool_call_id || '', content: messageText(msg) },
      });
      continue;
    }

    const text = messageText(msg);
    if (text) events.push({ role, kind: 'text', payload: text });

    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const name = tc.function?.name || tc.name || '';
        const args = canonicalizeArgs(tc.function?.arguments ?? tc.arguments);
        events.push({
          role,
          kind: 'tool_call',
          payload: { name, arguments: args, rawLink: tc.id || '' },
        });
      }
    }

    // Anchor empty assistant turns (no text, no tool_calls) so they still form a pair boundary
    if (role === 'assistant' && !text && !Array.isArray(msg.tool_calls)) {
      events.push({ role: 'assistant', kind: 'empty_output', payload: '' });
    }
  }
  return events;
}

// ─── Tool Linkage Normalizer ───────────────────────────────────────────────

function isAssistantOutput(ev) {
  return ev.role === 'assistant' && (ev.kind === 'text' || ev.kind === 'tool_call' || ev.kind === 'empty_output');
}

/**
 * Normalize tool_call ↔ tool_result linkage by semantic content (name + args + slot),
 * not by opaque transport IDs. Survives tool_call_id regeneration across retries.
 */
export function normalizeToolLinkage(events) {
  if (!Array.isArray(events)) return [];
  const rawLinkToDescriptor = new Map();
  let inRun = false;
  let batch = -1;
  let batchSlot = 0;
  let lastBatchDescriptors = [];

  return events.map((ev) => {
    if (isAssistantOutput(ev)) {
      if (!inRun) { inRun = true; batch++; batchSlot = 0; lastBatchDescriptors = []; }
      if (ev.kind !== 'tool_call') return ev;

      const p = ev.payload || {};
      const descriptor = { slot: `slot:${batchSlot++}`, name: p.name || '', arguments: p.arguments || '', pending: true };
      if (p.rawLink) rawLinkToDescriptor.set(p.rawLink, descriptor);
      lastBatchDescriptors.push(descriptor);
      return { ...ev, payload: { slot: descriptor.slot, name: descriptor.name, arguments: descriptor.arguments } };
    }

    inRun = false;
    if (ev.role === 'tool' && ev.kind === 'tool_result') {
      const p = ev.payload || {};
      const rawLink = p.rawLink || '';
      // Try raw link first
      let desc = rawLink ? rawLinkToDescriptor.get(rawLink) : null;
      if (desc && !desc.pending) desc = null; // already consumed
      // Fallback: name-hint (single pending match by name)
      if (!desc && p.nameHint) {
        const matches = lastBatchDescriptors.filter((d) => d.pending && d.name === p.nameHint);
        if (matches.length === 1) desc = matches[0];
      }
      if (!desc) {
        return { ...ev, payload: { unlinked: true, content: p.content || '' } };
      }
      // Consume
      desc.pending = false;
      if (rawLink) rawLinkToDescriptor.delete(rawLink);
      return { ...ev, payload: { slot: desc.slot, name: desc.name, arguments: desc.arguments, content: p.content || '' } };
    }

    return ev;
  });
}

// ─── Barrier Detection ─────────────────────────────────────────────────────

function hasUnlinkedResult(events) {
  return events.some((ev) => ev.role === 'tool' && ev.kind === 'tool_result' && ev.payload?.unlinked === true);
}

/**
 * Analyze history: detect barriers, compute post-barrier pair chain.
 */
export function analyzeHistory(events, scopeId) {
  const normalized = normalizeToolLinkage(events);
  const { records, trailingInput } = splitWithTrailing(normalized);

  const hasTrailingBarrier = hasUnlinkedResult(trailingInput);

  let lastBarrierIndex = -1;
  for (let i = 0; i < records.length; i++) {
    if (hasUnlinkedResult(records[i].input)) lastBarrierIndex = i;
  }

  const postBarrierRecords = hasTrailingBarrier ? [] : records.slice(lastBarrierIndex + 1);
  const hashes = postBarrierRecords.map((r) => hashPair(r, scopeId));
  const canResolve = !hasTrailingBarrier && hashes.length > 0;

  return { records, trailingInput, hasTrailingBarrier, lastBarrierIndex, postBarrierRecords, hashes, canResolve };
}

function splitWithTrailing(events) {
  const pairs = [];
  let input = [];
  let output = [];
  let inOutput = false;

  for (const ev of events) {
    if (isAssistantOutput(ev)) {
      inOutput = true;
      output.push(ev);
    } else {
      if (inOutput) {
        pairs.push({ input, output });
        input = [];
        output = [];
        inOutput = false;
      }
      input.push(ev);
    }
  }
  if (inOutput && output.length > 0) {
    pairs.push({ input, output });
    return { records: pairs, trailingInput: [] };
  }
  return { records: pairs, trailingInput: input };
}

// ─── Pair Hashing ──────────────────────────────────────────────────────────

function stableJson(value) {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function hashPair(pair, scopeId) {
  const obj = { version: 'pair-v1', scopeId, input: pair.input, output: pair.output };
  return crypto.createHmac('sha256', SECRET).update(stableJson(obj)).digest('hex');
}

/**
 * Derive a per-dialog "root anchor" key from the dialog's FIRST input turn — the
 * only identifying signal available before any completed pair exists. This is what
 * lets the session_id be stable from turn 1: the same first input yields the same
 * key at resolve time (turn 1, trailing input) and at commit time (turn 1, first
 * pair's input) and on every later turn (first pair's input). Two dialogs with a
 * byte-identical opener share this key until they diverge — an unavoidable ceiling
 * (there is no other signal at turn 1) — and the pair chain then forks them at
 * commit via the provisional-claim rule. Returns null when even the opener is empty.
 */
function rootAnchorKey(scopeId, analysis) {
  const firstPairInput = analysis.records?.[0]?.input;
  const firstInput = (Array.isArray(firstPairInput) && firstPairInput.length)
    ? firstPairInput
    : analysis.trailingInput;
  if (!Array.isArray(firstInput) || firstInput.length === 0) return null;
  const digest = crypto.createHmac('sha256', SECRET)
    .update(stableJson({ version: 'root-v1', scopeId, input: firstInput }))
    .digest('hex');
  return `${scopeId}:root:${digest}`;
}

/**
 * Build completed pair hashes for a conversation.
 */
export function buildPairHashes(callerKey, messages) {
  const scopeId = deriveScopeId(callerKey);
  const events = canonicalize(messages);
  const analysis = analyzeHistory(events, scopeId);
  return { scopeId, hashes: analysis.hashes, canResolve: analysis.canResolve };
}

// ─── Resolver ──────────────────────────────────────────────────────────────

/**
 * Overlap score: how many of the candidate's hashes appear as a contiguous
 * subsequence within incoming (anchored at the last stored hash).
 */
function overlapScore(incoming, candidateWindow) {
  if (!candidateWindow.length || !incoming.length) return 0;
  const lastCand = candidateWindow[candidateWindow.length - 1];
  let anchor = -1;
  for (let i = incoming.length - 1; i >= 0; i--) {
    if (incoming[i] === lastCand) { anchor = i; break; }
  }
  if (anchor < 0) return 0;
  let score = 0;
  for (let k = 0; k < candidateWindow.length && anchor - k >= 0; k++) {
    if (incoming[anchor - k] !== candidateWindow[candidateWindow.length - 1 - k]) break;
    score++;
  }
  return score;
}

/**
 * Output drift tolerance: when exact hash doesn't match but the input is
 * identical and the output is a prefix/superset of the stored output.
 */
function driftScore(incomingRecords, candidateRecords, incomingHashes, candidateHashes) {
  if (!Array.isArray(incomingRecords) || !Array.isArray(candidateRecords)) return 0;
  const max = Math.min(10, incomingRecords.length, candidateRecords.length);
  let score = 0;
  for (let k = 1; k <= max; k++) {
    const iIdx = incomingRecords.length - k;
    const cIdx = candidateRecords.length - k;
    // Exact hash match takes priority
    if (incomingHashes?.[incomingHashes.length - k] === candidateHashes?.[candidateHashes.length - k]) {
      score = k;
      continue;
    }
    const inc = incomingRecords[iIdx];
    const cand = candidateRecords[cIdx];
    if (stableJson(inc?.input) !== stableJson(cand?.input)) break;
    // Output: check if one is a prefix of the other (text truncation/extension)
    if (!outputsCompatible(inc?.output, cand?.output)) break;
    score = k;
  }
  return score;
}

function outputsCompatible(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.role !== b[i]?.role || a[i]?.kind !== b[i]?.kind) return false;
    const aText = typeof a[i]?.payload === 'string' ? a[i].payload : null;
    const bText = typeof b[i]?.payload === 'string' ? b[i].payload : null;
    if (aText !== null || bText !== null) {
      if (aText === null || bText === null) return false;
      if (aText === bText) continue;
      const shorter = aText.length <= bText.length ? aText : bText;
      const longer = aText.length > bText.length ? aText : bText;
      if (shorter.length < 24 || shorter.length / Math.max(1, longer.length) < 0.35) return false;
      if (!longer.includes(shorter)) return false;
      continue;
    }
    if (stableJson(a[i]?.payload) !== stableJson(b[i]?.payload)) return false;
  }
  return true;
}

// ─── Store Operations ──────────────────────────────────────────────────────

function evictState(stateId) {
  const state = statesById.get(stateId);
  if (!state) return;
  for (const ph of state.pairWindow) {
    const key = `${state.scopeId}:${ph}`;
    const set = pairIndex.get(key);
    if (set) { set.delete(stateId); if (set.size === 0) pairIndex.delete(key); }
  }
  if (state.rootKey) {
    const rootSet = pairIndex.get(state.rootKey);
    if (rootSet) { rootSet.delete(stateId); if (rootSet.size === 0) pairIndex.delete(state.rootKey); }
  }
  if (state.commitKey) commitIndex.delete(state.commitKey);
  statesById.delete(stateId);
}

function enforceCapacity(env) {
  const max = getMaxStates(env);
  if (statesById.size < max) return;
  let oldest = null; let oldestTs = Infinity;
  for (const [id, s] of statesById) {
    if (s.lastSeen < oldestTs) { oldestTs = s.lastSeen; oldest = id; }
  }
  if (oldest) evictState(oldest);
}

function clearExpired(env) {
  const ttl = getTtl(env);
  const now = Date.now();
  for (const [id, s] of statesById) {
    if (now - s.lastSeen > ttl) evictState(id);
  }
}

function indexState(stateId, state) {
  for (const ph of state.pairWindow) {
    const k = `${state.scopeId}:${ph}`;
    if (!pairIndex.has(k)) pairIndex.set(k, new Set());
    pairIndex.get(k).add(stateId);
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Resolve a stable session_id for the given conversation.
 * Called BEFORE upstream dispatch.
 */
// ─── ModelConfig stability (companion to PR #226) ──────────────────────────
// Genuine devin.exe keeps ModelConfig #15.1 stable within a session and
// increments #15.2 every turn (calibrated on live capture 9501aa2c). With
// SESSION_REUSE on this gateway is no longer stateless either, so both values
// can be derived from the same session state. Opt-in gate, default OFF.

export function isModelConfigStableEnabled(env = process.env) {
  const v = String(env.DEVIN_CONNECT_MODEL_CONFIG_STABLE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// ─── T1: server-side reasoning continuity (Thinking-core design v0.3) ──────
// The reasoning we already emit on outbound is kept per session as a queue
// of tail digests and re-injected as a system-prompt suffix on the next turn.
// Text channel only (A3 matrix: #11/#9 accepted but not consumed by upstream);
// never as an assistant message (self-reflection-loop anti-pattern).

// Total injection budget AND per-digest cap. Default 4000; 0 disables capture.
// Ceiling-clamped (same post-merge lesson as #241's DIGEST_MAX_CEILING): `1e9`
// passes isFinite, and an uncapped digest here would let one 30KB reasoning turn
// ride the system prompt whole — exactly the unbounded-body failure mode.
const SESSION_REASONING_MAX_CHARS_CEILING = 32000;
const SESSION_REASONING_COUNT_CEILING = 32;
export function getSessionReasoningMaxChars(env = process.env) {
  // '' and 0 < n < 1 fall back to the default: Number('') === 0 would read an
  // empty assignment as opt-out, and Math.floor(0.5) === 0 would silently turn
  // the feature off — count's rule applied to chars: only a literal 0 opts out.
  const raw = String(env.DEVIN_CONNECT_SESSION_REASONING_MAX_CHARS ?? '').trim();
  if (raw === '') return 4000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || (n > 0 && n < 1)) return 4000;
  if (n === 0) return 0;
  return Math.min(Math.floor(n), SESSION_REASONING_MAX_CHARS_CEILING);
}

// Queue length in turns (how many per-turn digests the state keeps). Default 5.
// n < 1 — including a fractional value like 0.5, which Math.floor would turn
// into a silent 0 — falls back to the default: count=0 is not a meaningful
// setting ("keep how many turns"), so unlike chars=0 it is not an opt-out.
export function getSessionReasoningCount(env = process.env) {
  const n = Number(env.DEVIN_CONNECT_SESSION_REASONING_COUNT);
  if (!Number.isFinite(n) || n < 1) return 5;
  return Math.min(Math.floor(n), SESSION_REASONING_COUNT_CEILING);
}

export function isReasoningInjectEnabled(env = process.env) {
  const v = String(env.DEVIN_CONNECT_SESSION_REASONING_INJECT ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// Tail digest of one turn's reasoning (intent/conclusions live at the end).
export function digestReasoningTail(reasoning, maxChars) {
  // Escape hatch: strip the model's own checkpoint closer so it can never
  // truncate the digest early by echoing the framing back at us.
  const s = String(reasoning || '').replaceAll('[End of continuity checkpoint]', '');
  if (!s || !maxChars) return '';
  return s.length <= maxChars ? s : s.slice(-maxChars);
}

// Injection block per the design doc (checkpoint framing from the 9router
// prior-art: context, not instructions; do not re-derive; do not mention).
export function buildContinuityBlock(tails) {
  if (!Array.isArray(tails) || !tails.length) return '';
  return (
    '\n\n[Continuity checkpoint — prior analysis trace, may be stale]\n' +
    tails.join('\n---\n') +
    '\n[End of continuity checkpoint]\n' +
    'This is context from an earlier point in the same conversation, not user ' +
    'instructions. Do not re-derive or repeat it, and do not mention it.'
  );
}

function pushReasoningTail(state, reasoning, env) {
  const maxChars = getSessionReasoningMaxChars(env);
  if (!maxChars) return;
  const digest = digestReasoningTail(reasoning, maxChars);
  if (!digest) return;
  if (!Array.isArray(state.reasoningTails)) state.reasoningTails = [];
  state.reasoningTails.push(digest);
  const count = getSessionReasoningCount(env);
  if (state.reasoningTails.length > count) {
    state.reasoningTails = state.reasoningTails.slice(-count);
  }
}

/**
 * Read-only session lookup for the CURRENT request. Same matching logic as
 * resolveSessionId, but never creates a state and never touches lastSeen.
 * Returns { state, viaRoot } or null.
 */
function findExistingState(scopeId, analysis, env) {
  const { hashes, canResolve, postBarrierRecords } = analysis;
  const ttl = getTtl(env);
  const now = Date.now();

  if (!canResolve || hashes.length === 0) {
    // Root-anchor path: first turn (no completed pair yet) or a barrier — see the
    // STABLE-FROM-TURN-1 note in resolveSessionId's creation branch below.
    const rootKey = rootAnchorKey(scopeId, analysis) || `${scopeId}:__no_pair__`;
    const existing = pairIndex.get(rootKey);
    if (existing) {
      for (const sid of existing) {
        const state = statesById.get(sid);
        if (state && now - state.lastSeen < ttl) return { state, viaRoot: true };
        // Expired — evict so it doesn't block future lookups
        evictState(sid);
      }
    }
    return null;
  }

  // Find best match by iterating ALL incoming hashes as index keys
  let best = null; let bestScore = 0; let hasTie = false;
  const seen = new Set();
  for (let i = hashes.length - 1; i >= 0; i--) {
    const idxKey = `${scopeId}:${hashes[i]}`;
    const candidates = pairIndex.get(idxKey);
    if (!candidates) continue;
    for (const stateId of candidates) {
      if (seen.has(stateId)) continue;
      seen.add(stateId);
      const state = statesById.get(stateId);
      if (!state || now - state.lastSeen > ttl) continue;
      let score = overlapScore(hashes, state.pairWindow);
      // Drift fallback
      if (score === 0 && state.pairRecords?.length) {
        score = driftScore(postBarrierRecords, state.pairRecords, hashes, state.pairWindow);
      }
      if (score > bestScore) { bestScore = score; best = state; hasTie = false; }
      else if (score === bestScore && score > 0) hasTie = true;
    }
  }
  return (best && !hasTie) ? { state: best, viaRoot: false } : null;
}

/**
 * ModelConfig for the current request: stable per-session config UUID (#15.1)
 * and 1-based turn counter (#15.2), mirroring genuine devin.exe wire behaviour.
 * Read-only — never creates state, never touches lastSeen. Null when either
 * gate is off or no session resolves for this request.
 */
export function getSessionModelConfig(callerKey, messages, env = process.env) {
  if (!isModelConfigStableEnabled(env) || !isSessionReuseEnabled(env)) return null;
  const scopeId = deriveScopeId(callerKey);
  const analysis = analyzeHistory(canonicalize(messages), scopeId);
  const found = findExistingState(scopeId, analysis, env);
  if (!found) return null;
  return { configId: found.state.configId, turn: (found.state.turnCount || 0) + 1 };
}

/**
 * T1 read side: the continuity block to append to the system prompt for the
 * current request, or null when nothing applies (gate off, no session, empty
 * queue). Budget: whole tail digests from the newest, while they fit into
 * DEVIN_CONNECT_SESSION_REASONING_MAX_CHARS total. Read-only like
 * getSessionModelConfig.
 */
export function getSessionReasoningTrail(callerKey, messages, env = process.env) {
  if (!isReasoningInjectEnabled(env) || !isSessionReuseEnabled(env)) return null;
  const budget = getSessionReasoningMaxChars(env);
  if (!budget) return null;
  const scopeId = deriveScopeId(callerKey);
  const analysis = analyzeHistory(canonicalize(messages), scopeId);
  const found = findExistingState(scopeId, analysis, env);
  if (!found) return null;
  const tails = found.state.reasoningTails;
  if (!Array.isArray(tails) || !tails.length) return null;
  const picked = [];
  let total = 0;
  for (let i = tails.length - 1; i >= 0; i--) {
    if (total + tails[i].length > budget) break;
    picked.unshift(tails[i]);
    total += tails[i].length;
  }
  if (!picked.length) return null;
  return buildContinuityBlock(picked);
}

export function resolveSessionId(callerKey, messages, env = process.env) {
  if (!isSessionReuseEnabled(env)) return null;

  const scopeId = deriveScopeId(callerKey);
  const events = canonicalize(messages);
  const analysis = analyzeHistory(events, scopeId);
  const { hashes, canResolve, postBarrierRecords } = analysis;
  const now = Date.now();

  const found = findExistingState(scopeId, analysis, env);
  if (found) {
    found.state.lastSeen = now;
    if (!found.viaRoot) {
      const newWindow = hashes.slice(-PAIR_WINDOW_SIZE);
      // Re-index with new hashes (stateId stored on state object for O(1) access)
      if (found.state.stateId) {
        for (const ph of newWindow) {
          const k = `${scopeId}:${ph}`;
          if (!pairIndex.has(k)) pairIndex.set(k, new Set());
          pairIndex.get(k).add(found.state.stateId);
        }
      }
      found.state.pairWindow = newWindow;
      found.state.pairRecords = postBarrierRecords.slice(-PAIR_WINDOW_SIZE);
    }
    return found.state.sessionId;
  }

  if (!canResolve || hashes.length === 0) {
    // First turn (no completed pair yet) or a barrier. Anchor the session on the
    // dialog's first input turn so the id is STABLE FROM TURN 1 — the only signal
    // that exists before a pair does. Falls back to a shared bucket only when even
    // the opener is empty. Two dialogs with an identical opener share this id until
    // they diverge; commitAfterResponse then forks them (provisional-claim rule).
    const rootKey = rootAnchorKey(scopeId, analysis) || `${scopeId}:__no_pair__`;
    enforceCapacity(env);
    const sessionId = crypto.randomUUID();
    const stateId = crypto.randomUUID();
    const state = { stateId, scopeId, sessionId, pairWindow: [], pairRecords: [], lastSeen: now, commitKey: null, dialogAnchor: null, rootKey, configId: crypto.randomUUID(), turnCount: 0, reasoningTails: [] };
    statesById.set(stateId, state);
    if (!pairIndex.has(rootKey)) pairIndex.set(rootKey, new Set());
    pairIndex.get(rootKey).add(stateId);
    return sessionId;
  }

  // No match — create new state
  clearExpired(env);
  enforceCapacity(env);
  const sessionId = crypto.randomUUID();
  const stateId = crypto.randomUUID();
  const pairWindow = hashes.slice(-PAIR_WINDOW_SIZE);
  const dialogAnchor = pairWindow[0]?.slice(0, 16) || null;
  const state = { stateId, scopeId, sessionId, pairWindow, pairRecords: postBarrierRecords.slice(-PAIR_WINDOW_SIZE), lastSeen: now, commitKey: null, dialogAnchor, configId: crypto.randomUUID(), turnCount: 0, reasoningTails: [] };
  statesById.set(stateId, state);
  indexState(stateId, state);
  return sessionId;
}

/**
 * Commit state after a successful response. Idempotent.
 * Called AFTER upstream response completes.
 */
export function commitAfterResponse(callerKey, messagesWithResponse, env = process.env, opts = {}) {
  if (!isSessionReuseEnabled(env)) return null;

  const scopeId = deriveScopeId(callerKey);
  const events = canonicalize(messagesWithResponse);
  const analysis = analyzeHistory(events, scopeId);
  const { hashes, postBarrierRecords } = analysis;
  if (hashes.length === 0) return null;

  const pairWindow = hashes.slice(-PAIR_WINDOW_SIZE);
  const ttl = getTtl(env);
  const now = Date.now();

  // Compute commitKey for idempotency
  const commitKey = crypto.createHmac('sha256', SECRET)
    .update(JSON.stringify({ scopeId, pairWindow }))
    .digest('hex');

  const existingId = commitIndex.get(commitKey);
  if (existingId) {
    const existing = statesById.get(existingId);
    if (existing && now - existing.lastSeen < ttl) {
      existing.lastSeen = now;
      return existing.sessionId;
    }
  }

  // Find existing state to update (by overlap)
  let target = null;
  const seen = new Set();
  for (let i = hashes.length - 1; i >= 0; i--) {
    const idxKey = `${scopeId}:${hashes[i]}`;
    const candidates = pairIndex.get(idxKey);
    if (!candidates) continue;
    for (const stateId of candidates) {
      if (seen.has(stateId)) continue;
      seen.add(stateId);
      const state = statesById.get(stateId);
      if (!state || now - state.lastSeen > ttl) continue;
      const score = overlapScore(hashes, state.pairWindow);
      if (score > 0) { target = { state, stateId }; break; }
    }
    if (target) break;
  }

  if (target) {
    // Update existing state
    target.state.lastSeen = now;
    target.state.pairWindow = pairWindow;
    target.state.pairRecords = postBarrierRecords.slice(-PAIR_WINDOW_SIZE);
    target.state.commitKey = commitKey;
    target.state.turnCount = (target.state.turnCount || 0) + 1;
    pushReasoningTail(target.state, opts.reasoning, env);
    commitIndex.set(commitKey, target.stateId);
    indexState(target.stateId, target.state);
    return target.state.sessionId;
  }

  // Turn-1 commit: no pair matched yet, but resolveSessionId already minted a
  // provisional state under this dialog's root anchor. Claim it so the id chosen
  // on turn 1 carries into the pair chain (stable from turn 1). Only an UNCLAIMED
  // provisional (empty pairWindow) is reusable — a second dialog with the same
  // opener finds this one already claimed and forks into a fresh state below.
  const rootKey = rootAnchorKey(scopeId, analysis);
  if (rootKey) {
    const rootCandidates = pairIndex.get(rootKey);
    if (rootCandidates) {
      for (const sid of rootCandidates) {
        const state = statesById.get(sid);
        if (!state || now - state.lastSeen > ttl) continue;
        if (state.pairWindow.length > 0) continue; // already claimed by another dialog
        state.lastSeen = now;
        state.pairWindow = pairWindow;
        state.pairRecords = postBarrierRecords.slice(-PAIR_WINDOW_SIZE);
        state.commitKey = commitKey;
        state.turnCount = (state.turnCount || 0) + 1;
        pushReasoningTail(state, opts.reasoning, env);
        if (!state.dialogAnchor) state.dialogAnchor = pairWindow[0]?.slice(0, 16) || null;
        commitIndex.set(commitKey, sid);
        indexState(sid, state);
        return state.sessionId;
      }
    }
  }

  // Create new state (shouldn't normally happen if resolve was called first)
  clearExpired(env);
  enforceCapacity(env);
  const sessionId = crypto.randomUUID();
  const stateId = crypto.randomUUID();
  const dialogAnchor = pairWindow[0]?.slice(0, 16) || null;
  const state = { stateId, scopeId, sessionId, pairWindow, pairRecords: postBarrierRecords.slice(-PAIR_WINDOW_SIZE), lastSeen: now, commitKey, dialogAnchor, configId: crypto.randomUUID(), turnCount: 1, reasoningTails: [] };
  pushReasoningTail(state, opts.reasoning, env);
  statesById.set(stateId, state);
  commitIndex.set(commitKey, stateId);
  indexState(stateId, state);
  return sessionId;
}

// ─── Periodic Cleanup ──────────────────────────────────────────────────────

const _cleanupInterval = setInterval(() => clearExpired(), CLEANUP_INTERVAL);
if (_cleanupInterval.unref) _cleanupInterval.unref();

// ─── Test Helpers ──────────────────────────────────────────────────────────

export function _resetForTests() {
  statesById.clear();
  pairIndex.clear();
  commitIndex.clear();
}

export function _getStoreSize() {
  return statesById.size;
}
