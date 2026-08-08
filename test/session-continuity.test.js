import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSessionId,
  commitAfterResponse,
  isSessionReuseEnabled,
  isModelConfigStableEnabled,
  getSessionModelConfig,
  isReasoningInjectEnabled,
  getSessionReasoningMaxChars,
  getSessionReasoningCount,
  digestReasoningTail,
  buildContinuityBlock,
  getSessionReasoningTrail,
  buildPairHashes,
  canonicalize,
  normalizeToolLinkage,
  analyzeHistory,
  _resetForTests,
  _getStoreSize,
} from '../src/session-continuity.js';

const ENV = { DEVIN_CONNECT_SESSION_REUSE: '1' };

describe('session-continuity: gate', () => {
  it('isSessionReuseEnabled respects env values', () => {
    assert.equal(isSessionReuseEnabled({ DEVIN_CONNECT_SESSION_REUSE: '1' }), true);
    assert.equal(isSessionReuseEnabled({ DEVIN_CONNECT_SESSION_REUSE: 'true' }), true);
    assert.equal(isSessionReuseEnabled({ DEVIN_CONNECT_SESSION_REUSE: 'YES' }), true);
    assert.equal(isSessionReuseEnabled({ DEVIN_CONNECT_SESSION_REUSE: 'on' }), true);
    assert.equal(isSessionReuseEnabled({ DEVIN_CONNECT_SESSION_REUSE: '0' }), false);
    assert.equal(isSessionReuseEnabled({}), false);
  });

  it('resolveSessionId returns null when disabled', () => {
    assert.equal(resolveSessionId('caller', [{ role: 'user', content: 'hi' }], {}), null);
  });
});

describe('session-continuity: canonicalization', () => {
  beforeEach(() => _resetForTests());
  afterEach(() => _resetForTests());

  it('excludes system and developer messages', () => {
    const events = canonicalize([
      { role: 'system', content: 'sys' },
      { role: 'developer', content: 'dev' },
      { role: 'user', content: 'hi' },
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0].role, 'user');
  });

  it('decomposes tool_calls into individual events', () => {
    const events = canonicalize([
      { role: 'assistant', tool_calls: [
        { id: 'c1', function: { name: 'read', arguments: '{"f":"a.js"}' } },
        { id: 'c2', function: { name: 'write', arguments: '{}' } },
      ]},
    ]);
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, 'tool_call');
    assert.equal(events[0].payload.name, 'read');
    assert.equal(events[1].payload.name, 'write');
  });

  it('anchors empty assistant turn as empty_output', () => {
    const events = canonicalize([{ role: 'assistant', content: '' }]);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'empty_output');
  });

  it('tool results carry rawLink from tool_call_id', () => {
    const events = canonicalize([{ role: 'tool', tool_call_id: 'call-7', content: 'ok' }]);
    assert.equal(events[0].payload.rawLink, 'call-7');
  });
});

describe('session-continuity: tool linkage normalization', () => {
  beforeEach(() => _resetForTests());
  afterEach(() => _resetForTests());

  it('replaces rawLink with semantic slot descriptors', () => {
    const events = [
      { role: 'assistant', kind: 'tool_call', payload: { name: 'search', arguments: '{}', rawLink: 'raw-A' } },
      { role: 'tool', kind: 'tool_result', payload: { rawLink: 'raw-A', content: 'found' } },
    ];
    const normalized = normalizeToolLinkage(events);
    assert.equal(normalized[0].payload.slot, 'slot:0');
    assert.ok(!('rawLink' in normalized[0].payload));
    assert.equal(normalized[1].payload.slot, 'slot:0');
    assert.equal(normalized[1].payload.name, 'search');
    assert.equal(normalized[1].payload.content, 'found');
  });

  it('marks orphan tool_result as unlinked', () => {
    const events = [
      { role: 'tool', kind: 'tool_result', payload: { rawLink: 'unknown', content: 'x' } },
    ];
    const normalized = normalizeToolLinkage(events);
    assert.deepEqual(normalized[0].payload, { unlinked: true, content: 'x' });
  });

  it('duplicate result with same rawLink becomes unlinked', () => {
    const events = [
      { role: 'assistant', kind: 'tool_call', payload: { name: 'a', arguments: '{}', rawLink: 'dup' } },
      { role: 'tool', kind: 'tool_result', payload: { rawLink: 'dup', content: 'first' } },
      { role: 'tool', kind: 'tool_result', payload: { rawLink: 'dup', content: 'second' } },
    ];
    const normalized = normalizeToolLinkage(events);
    assert.equal(normalized[1].payload.slot, 'slot:0');
    assert.deepEqual(normalized[2].payload, { unlinked: true, content: 'second' });
  });

  it('different tool_call_ids with same semantics produce identical normalized pairs', () => {
    const make = (id) => canonicalize([
      { role: 'user', content: 'do it' },
      { role: 'assistant', tool_calls: [{ id, function: { name: 'search', arguments: '{"q":"x"}' } }] },
      { role: 'tool', tool_call_id: id, content: 'result' },
      { role: 'assistant', content: 'done' },
    ]);
    const a = normalizeToolLinkage(make('call-AAA'));
    const b = normalizeToolLinkage(make('call-ZZZ'));
    assert.deepEqual(a, b);
  });
});

describe('session-continuity: barrier detection', () => {
  beforeEach(() => _resetForTests());
  afterEach(() => _resetForTests());

  it('trailing unlinked tool_result blocks resolve', () => {
    const events = canonicalize([
      { role: 'user', content: 'search' },
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c99', content: 'orphan' }, // wrong id → unlinked
    ]);
    const { canResolve, hasTrailingBarrier } = analyzeHistory(events, 'scope');
    assert.equal(hasTrailingBarrier, true);
    assert.equal(canResolve, false);
  });

  it('barrier resets the pair chain suffix', () => {
    const events = canonicalize([
      { role: 'user', content: 'A' },
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c99', content: 'orphan' }, // barrier
      { role: 'assistant', content: 'recovered' },
      { role: 'user', content: 'B' },
      { role: 'assistant', content: 'answer B' },
    ]);
    const { hashes, lastBarrierIndex } = analyzeHistory(events, 'scope');
    assert.ok(lastBarrierIndex >= 0);
    // Only post-barrier pairs are in hashes
    assert.ok(hashes.length > 0);
    assert.ok(hashes.length < 3); // not all pairs
  });
});

describe('session-continuity: resolve + commit lifecycle', () => {
  beforeEach(() => _resetForTests());
  afterEach(() => _resetForTests());

  it('20 tool iterations remain stable session_id', () => {
    let messages = [
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'user', content: 'Refactor the auth module for better security' },
      { role: 'assistant', content: 'Starting analysis.' },
    ];

    const firstId = resolveSessionId('caller1', messages, ENV);
    assert.ok(firstId);
    // Commit after first response
    commitAfterResponse('caller1', messages, ENV);

    for (let i = 0; i < 20; i++) {
      messages = [
        ...messages,
        { role: 'user', content: `Continue step ${i}` },
        { role: 'assistant', tool_calls: [{ id: `tc-${i}`, function: { name: `tool_${i}`, arguments: `{"i":${i}}` } }] },
        { role: 'tool', tool_call_id: `tc-${i}`, content: `result_${i}` },
        { role: 'assistant', content: `Done step ${i}.` },
      ];
      const id = resolveSessionId('caller1', messages, ENV);
      assert.equal(id, firstId, `iteration ${i}: session_id must remain stable`);
      commitAfterResponse('caller1', messages, ENV);
    }
  });

  it('different conversations get different session_ids', () => {
    const a = [{ role: 'user', content: 'task A' }, { role: 'assistant', content: 'A' }];
    const b = [{ role: 'user', content: 'task B' }, { role: 'assistant', content: 'B' }];
    const idA = resolveSessionId('caller1', a, ENV);
    const idB = resolveSessionId('caller1', b, ENV);
    assert.notEqual(idA, idB);
  });

  it('different callerKeys get different session_ids', () => {
    const msgs = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
    const id1 = resolveSessionId('caller1', msgs, ENV);
    const id2 = resolveSessionId('caller2', msgs, ENV);
    assert.notEqual(id1, id2);
  });

  it('system prompt changes do not break session identity', () => {
    const msgs1 = [{ role: 'system', content: 'v1' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hey' }];
    const msgs2 = [{ role: 'system', content: 'v2 totally different' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hey' }];
    const id1 = resolveSessionId('caller1', msgs1, ENV);
    const id2 = resolveSessionId('caller1', msgs2, ENV);
    assert.equal(id1, id2);
  });

  it('tool_call_id regeneration does not break session identity', () => {
    const base = [
      { role: 'user', content: 'do it' },
      { role: 'assistant', tool_calls: [{ id: 'orig-id', function: { name: 'search', arguments: '{"q":"x"}' } }] },
      { role: 'tool', tool_call_id: 'orig-id', content: 'found' },
      { role: 'assistant', content: 'done' },
    ];
    const id1 = resolveSessionId('caller1', base, ENV);
    commitAfterResponse('caller1', base, ENV);

    const replayed = [
      { role: 'user', content: 'do it' },
      { role: 'assistant', tool_calls: [{ id: 'new-id-after-retry', function: { name: 'search', arguments: '{"q":"x"}' } }] },
      { role: 'tool', tool_call_id: 'new-id-after-retry', content: 'found' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'next' },
    ];
    const id2 = resolveSessionId('caller1', replayed, ENV);
    assert.equal(id2, id1, 'regenerated tool_call_id must not break session identity');
  });

  it('idempotent commit returns same sessionId', () => {
    const msgs = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hey' }];
    const id1 = commitAfterResponse('caller1', msgs, ENV);
    const id2 = commitAfterResponse('caller1', msgs, ENV);
    assert.equal(id1, id2);
  });

  it('LRU eviction keeps store bounded', () => {
    const env = { ...ENV, DEVIN_CONNECT_SESSION_MAX_STATES: '5' };
    for (let i = 0; i < 10; i++) {
      const msgs = [{ role: 'user', content: `q${i}` }, { role: 'assistant', content: `a${i}` }];
      resolveSessionId(`caller-${i}`, msgs, env);
    }
    assert.ok(_getStoreSize() <= 6); // 5 + possible no-pair state
  });
});

describe('session-continuity: overlap, drift, TTL, pair hashing', () => {
  beforeEach(() => _resetForTests());
  afterEach(() => _resetForTests());

  it('buildPairHashes is stable per conversation and scoped per callerKey', () => {
    const msgs = [
      { role: 'user', content: 'A1' },
      { role: 'assistant', content: 'O1' },
      { role: 'user', content: 'A2' },
    ];
    const a = buildPairHashes('caller1', msgs);
    const b = buildPairHashes('caller1', msgs);
    assert.deepEqual(a.hashes, b.hashes, 'same caller + history → identical hashes');
    assert.ok(a.hashes.length === 1 && a.canResolve, 'one completed pair, resolvable');
    const other = buildPairHashes('caller2', msgs);
    assert.notDeepEqual(a.hashes, other.hashes, 'different callerKey → different scoped hashes');
  });

  it('tolerates assistant output drift (client truncates response text) across a 2-pair chain', () => {
    const full = 'the quick brown fox jumps over the lazy dog and keeps going';
    // Turn 1 + Turn 2 committed with the FULL second answer.
    const t1 = [{ role: 'user', content: 'A1' }, { role: 'assistant', content: 'O1' }];
    resolveSessionId('caller1', t1, ENV);
    const id = commitAfterResponse('caller1', t1, ENV);
    const t2 = [...t1, { role: 'user', content: 'A2' }, { role: 'assistant', content: full }];
    commitAfterResponse('caller1', t2, ENV);

    // Turn 3: the client replays A2's answer TRUNCATED to a prefix, then asks A3.
    const truncated = 'the quick brown fox jumps over the lazy dog';
    const t3 = [
      { role: 'user', content: 'A1' }, { role: 'assistant', content: 'O1' },
      { role: 'user', content: 'A2' }, { role: 'assistant', content: truncated },
      { role: 'user', content: 'A3' },
    ];
    const resolved = resolveSessionId('caller1', t3, ENV);
    assert.equal(resolved, id, 'drifted (prefix-truncated) output still resolves the same session');
  });

  it('a semantically different answer does NOT resolve to the drifted session', () => {
    const t1 = [{ role: 'user', content: 'A1' }, { role: 'assistant', content: 'O1' }];
    resolveSessionId('caller1', t1, ENV);
    commitAfterResponse('caller1', t1, ENV);
    const t2 = [...t1, { role: 'user', content: 'A2' }, { role: 'assistant', content: 'the original committed answer text' }];
    commitAfterResponse('caller1', t2, ENV);

    const different = [
      { role: 'user', content: 'A1' }, { role: 'assistant', content: 'O1' },
      { role: 'user', content: 'A2' }, { role: 'assistant', content: 'a completely unrelated different answer' },
      { role: 'user', content: 'A3' },
    ];
    const before = _getStoreSize();
    resolveSessionId('caller1', different, ENV);
    assert.ok(_getStoreSize() > before, 'a genuinely different answer forks a new session, not a drift match');
  });

  it('an expired state (TTL) is evicted and yields a fresh session_id', () => {
    const env = { ...ENV, DEVIN_CONNECT_SESSION_TTL_MS: '1' };
    const t1 = [{ role: 'user', content: 'A1' }, { role: 'assistant', content: 'O1' }];
    const id1 = resolveSessionId('caller1', t1, env);
    commitAfterResponse('caller1', t1, env);
    const t2 = [...t1, { role: 'user', content: 'A2' }];
    // Busy-wait past the 1ms TTL so the stored state is stale on the next resolve.
    const spinUntil = Date.now() + 5;
    while (Date.now() < spinUntil) { /* let the TTL lapse */ }
    const id2 = resolveSessionId('caller1', t2, env);
    assert.notEqual(id2, id1, 'a resolve after the TTL lapses must not reuse the expired session');
  });

  it('resumes matching only after the last barrier (post-barrier pair resolves)', () => {
    // History with an orphan tool_result barrier, then a clean post-barrier pair.
    const history = [
      { role: 'user', content: 'A' },
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c99', content: 'orphan' }, // barrier
      { role: 'assistant', content: 'recovered' },
      { role: 'user', content: 'B' },
      { role: 'assistant', content: 'answer B' },
    ];
    const id = resolveSessionId('caller1', history, ENV);
    commitAfterResponse('caller1', history, ENV);
    // Next turn keeps the same post-barrier chain and adds a follow-up.
    const next = [...history, { role: 'user', content: 'C' }];
    const resolved = resolveSessionId('caller1', next, ENV);
    assert.equal(resolved, id, 'post-barrier pair chain keeps resolving the same session');
  });
});

describe('session-continuity: turn-1 stability (root anchor)', () => {
  beforeEach(() => _resetForTests());
  afterEach(() => _resetForTests());

  // Drive resolve → commit → resolve exactly as the handler does, chaining the
  // real assistant reply into the next turn's history.
  function turn(caller, historyRef, userText, assistantText) {
    historyRef.push({ role: 'user', content: userText });
    const id = resolveSessionId(caller, historyRef, ENV);
    historyRef.push({ role: 'assistant', content: assistantText });
    commitAfterResponse(caller, historyRef, ENV);
    return id;
  }

  it('session_id is stable FROM TURN 1 (turn1 == turn2 == turn3)', () => {
    const h = [{ role: 'system', content: 'sys' }];
    const id1 = turn('c1', h, 'remember X', 'ok');
    const id2 = turn('c1', h, 'what did I say?', 'X');
    const id3 = turn('c1', h, 'again?', 'X');
    assert.equal(id1, id2, 'turn 2 keeps the turn-1 session_id');
    assert.equal(id2, id3, 'turn 3 stays stable');
  });

  it('different openers get different session_ids already on turn 1', () => {
    const idA = resolveSessionId('c1', [{ role: 'user', content: 'opener AAA' }], ENV);
    const idB = resolveSessionId('c1', [{ role: 'user', content: 'opener BBB' }], ENV);
    assert.notEqual(idA, idB, 'distinct first messages → distinct ids at turn 1');
  });

  it('system prompt drift does not change the turn-1 id (system excluded from the anchor)', () => {
    const id1 = resolveSessionId('c1', [{ role: 'system', content: 'v1' }, { role: 'user', content: 'hi' }], ENV);
    const id2 = resolveSessionId('c1', [{ role: 'system', content: 'v2 different' }, { role: 'user', content: 'hi' }], ENV);
    assert.equal(id1, id2, 'same opener under a drifting system prompt keeps one turn-1 id');
  });

  it('identical-opener dialogs collide on turn 1 then fork at turn 2 (graceful, no independence regression)', () => {
    // Dialog 1 claims the root anchor.
    const h1 = [];
    const d1t1 = turn('c1', h1, 'same opener', 'reply one');
    const d1t2 = turn('c1', h1, 'continue 1', 'more one');
    assert.equal(d1t1, d1t2, 'dialog 1 is stable from turn 1');

    // Dialog 2 on the SAME caller with a byte-identical opener: shares the id on
    // turn 1 (unavoidable — no other signal), but a DIFFERENT turn-1 answer forks
    // it onto its own id at turn 2 (the root anchor is already claimed by dialog 1).
    const h2 = [];
    const d2t1 = turn('c1', h2, 'same opener', 'reply two');
    assert.equal(d2t1, d1t1, 'turn-1 collision on an identical opener is expected');
    const d2t2 = turn('c1', h2, 'continue 2', 'more two');
    assert.notEqual(d2t2, d1t2, 'once diverged, the two dialogs hold independent ids');
  });
});

describe('getSessionModelConfig — stable #15.1 / monotonic #15.2 (devin.exe parity)', () => {
  beforeEach(() => _resetForTests());
  afterEach(() => _resetForTests());
  const ENV_BOTH = { DEVIN_CONNECT_SESSION_REUSE: '1', DEVIN_CONNECT_MODEL_CONFIG_STABLE: '1' };

  it('gate matrix: needs BOTH the stable gate and session reuse', () => {
    assert.equal(isModelConfigStableEnabled({ DEVIN_CONNECT_MODEL_CONFIG_STABLE: '1' }), true);
    assert.equal(isModelConfigStableEnabled({ DEVIN_CONNECT_MODEL_CONFIG_STABLE: 'ON' }), true);
    assert.equal(isModelConfigStableEnabled({}), false);
    const h = [{ role: 'user', content: 'hi' }];
    resolveSessionId('gm1', h, ENV_BOTH);
    assert.equal(getSessionModelConfig('gm1', h, { DEVIN_CONNECT_SESSION_REUSE: '1' }), null, 'stable gate off → null');
    assert.equal(getSessionModelConfig('gm1', h, { DEVIN_CONNECT_MODEL_CONFIG_STABLE: '1' }), null, 'reuse gate off → null');
    const cfg = getSessionModelConfig('gm1', h, ENV_BOTH);
    assert.ok(cfg && cfg.configId && cfg.turn === 1, 'both gates on → config for turn 1');
  });

  it('configId stable across turns; turn = committed responses + 1', () => {
    const h = [{ role: 'user', content: 't1 question' }];
    resolveSessionId('gm2', h, ENV_BOTH);
    const c1 = getSessionModelConfig('gm2', h, ENV_BOTH);
    assert.equal(c1.turn, 1, 'first turn = 1 before any commit');

    h.push({ role: 'assistant', content: 'a1' });
    commitAfterResponse('gm2', h, ENV_BOTH);
    h.push({ role: 'user', content: 't2 question' });
    resolveSessionId('gm2', h, ENV_BOTH);
    const c2 = getSessionModelConfig('gm2', h, ENV_BOTH);
    assert.equal(c2.configId, c1.configId, '#15.1 must be stable within the session');
    assert.equal(c2.turn, 2, 'turn 2 after one committed response');

    h.push({ role: 'assistant', content: 'a2' });
    commitAfterResponse('gm2', h, ENV_BOTH);
    h.push({ role: 'user', content: 't3 question' });
    resolveSessionId('gm2', h, ENV_BOTH);
    const c3 = getSessionModelConfig('gm2', h, ENV_BOTH);
    assert.equal(c3.configId, c1.configId, '#15.1 still stable at turn 3');
    assert.equal(c3.turn, 3, 'turn 3 after two committed responses');
  });

  it('idempotent re-commit does not inflate the turn counter', () => {
    const h = [{ role: 'user', content: 'idem q' }];
    resolveSessionId('gm3', h, ENV_BOTH);
    h.push({ role: 'assistant', content: 'idem a' });
    commitAfterResponse('gm3', h, ENV_BOTH);
    commitAfterResponse('gm3', h, ENV_BOTH); // retry double-commit
    h.push({ role: 'user', content: 'next' });
    resolveSessionId('gm3', h, ENV_BOTH);
    assert.equal(getSessionModelConfig('gm3', h, ENV_BOTH).turn, 2, 'no double bump on re-commit');
  });

  it('is read-only: never creates session state', () => {
    const before = _getStoreSize();
    assert.equal(getSessionModelConfig('gm4-nobody', [{ role: 'user', content: 'orphan' }], ENV_BOTH), null);
    assert.equal(_getStoreSize(), before, 'lookup must not create a session');
  });
});


describe('T1 reasoning continuity — digest, store queue, injection (Thinking-core)', () => {
  beforeEach(() => _resetForTests());
  afterEach(() => _resetForTests());
  const ENV_T1 = { DEVIN_CONNECT_SESSION_REUSE: '1', DEVIN_CONNECT_SESSION_REASONING_INJECT: '1' };

  it('env knobs: defaults and parsing', () => {
    assert.equal(getSessionReasoningMaxChars({}), 4000);
    assert.equal(getSessionReasoningMaxChars({ DEVIN_CONNECT_SESSION_REASONING_MAX_CHARS: '0' }), 0);
    assert.equal(getSessionReasoningMaxChars({ DEVIN_CONNECT_SESSION_REASONING_MAX_CHARS: 'junk' }), 4000);
    assert.equal(getSessionReasoningMaxChars({ DEVIN_CONNECT_SESSION_REASONING_MAX_CHARS: '1e9' }), 32000, 'ceiling clamp — 1e9 must not pass through uncapped');
    // same-input parity with count: '' (Number('') === 0) and 0 < n < 1
    // (Math.floor(0.5) === 0) must not silently read as the chars=0 opt-out
    assert.equal(getSessionReasoningMaxChars({ DEVIN_CONNECT_SESSION_REASONING_MAX_CHARS: '' }), 4000, 'empty assignment is not an opt-out — falls back to the default');
    assert.equal(getSessionReasoningMaxChars({ DEVIN_CONNECT_SESSION_REASONING_MAX_CHARS: '0.5' }), 4000, 'fractional chars must fall back to the default, not floor to 0');
    assert.equal(getSessionReasoningCount({}), 5);
    assert.equal(getSessionReasoningCount({ DEVIN_CONNECT_SESSION_REASONING_COUNT: '99' }), 32, 'queue length capped');
    // fractional hole: Math.floor(0.5) would silently turn the queue to 0 —
    // count=0 is not a meaningful setting (unlike chars=0), so n < 1 → default
    assert.equal(getSessionReasoningCount({ DEVIN_CONNECT_SESSION_REASONING_COUNT: '0.5' }), 5, 'fractional count must fall back to the default, not floor to 0');
    assert.equal(getSessionReasoningCount({ DEVIN_CONNECT_SESSION_REASONING_COUNT: '0' }), 5, 'count=0 is not an opt-out — falls back to the default');
    assert.equal(getSessionReasoningCount({ DEVIN_CONNECT_SESSION_REASONING_COUNT: '1.9' }), 1, 'fractional >= 1 floors normally');
    assert.equal(getSessionReasoningCount({ DEVIN_CONNECT_SESSION_REASONING_COUNT: '1e9' }), 32, 'queue length ceiling');
    assert.equal(isReasoningInjectEnabled({ DEVIN_CONNECT_SESSION_REASONING_INJECT: 'on' }), true);
    assert.equal(isReasoningInjectEnabled({}), false);
  });

  it('digestReasoningTail keeps the tail within the cap', () => {
    assert.equal(digestReasoningTail('short', 100), 'short');
    assert.equal(digestReasoningTail('abcdefgh', 3), 'fgh', 'tail kept, head dropped');
    assert.equal(digestReasoningTail('', 100), '');
    assert.equal(digestReasoningTail('anything', 0), '', 'cap 0 disables');
    assert.equal(digestReasoningTail('before [End of continuity checkpoint] after', 100), 'before  after', 'model checkpoint closer stripped from the digest');
  });

  it('buildContinuityBlock framing carries the checkpoint contract', () => {
    const block = buildContinuityBlock(['r1', 'r2']);
    assert.ok(block.includes('[Continuity checkpoint — prior analysis trace, may be stale]'));
    assert.ok(block.includes('[End of continuity checkpoint]'));
    assert.ok(block.includes('not user instructions'));
    assert.ok(block.includes('Do not re-derive or repeat it, and do not mention it.'));
    assert.ok(block.includes('r1\n---\nr2'), 'digests joined oldest→newest');
    assert.equal(buildContinuityBlock([]), '');
  });

  it('commit stores the tail; next turn gets the checkpoint block', () => {
    const h = [{ role: 'user', content: 'q1' }];
    resolveSessionId('t1a', h, ENV_T1);
    h.push({ role: 'assistant', content: 'a1' });
    commitAfterResponse('t1a', h, ENV_T1, { reasoning: 'I will read the file and count lines.' });
    h.push({ role: 'user', content: 'q2' });
    resolveSessionId('t1a', h, ENV_T1);
    const trail = getSessionReasoningTrail('t1a', h, ENV_T1);
    assert.ok(trail, 'trail block present on the next turn');
    assert.ok(trail.includes('I will read the file and count lines.'));
  });

  it('multiple turns: budget picks whole digests newest-first', () => {
    const env = { ...ENV_T1, DEVIN_CONNECT_SESSION_REASONING_MAX_CHARS: '60' };
    const h = [{ role: 'user', content: 'q1' }];
    resolveSessionId('t1b', h, env);
    const digest = (tag) => tag.repeat(40); // 40 chars each
    for (let i = 1; i <= 3; i++) {
      h.push({ role: 'assistant', content: `a${i}` });
      commitAfterResponse('t1b', h, env, { reasoning: digest(`R${i}`) });
      h.push({ role: 'user', content: `q${i + 1}` });
      resolveSessionId('t1b', h, env);
    }
    const trail = getSessionReasoningTrail('t1b', h, env);
    assert.ok(trail.includes('R3'), 'newest digest always fits alone');
    assert.ok(!trail.includes('R2'), 'budget 60 < 40+40 — older digest must not be sliced in');
  });

  it('queue capped at COUNT turns', () => {
    const env = { ...ENV_T1, DEVIN_CONNECT_SESSION_REASONING_COUNT: '2' };
    const h = [{ role: 'user', content: 'q1' }];
    resolveSessionId('t1c', h, env);
    for (let i = 1; i <= 3; i++) {
      h.push({ role: 'assistant', content: `a${i}` });
      commitAfterResponse('t1c', h, env, { reasoning: `reasoning-turn-${i}` });
      h.push({ role: 'user', content: `q${i + 1}` });
      resolveSessionId('t1c', h, env);
    }
    const trail = getSessionReasoningTrail('t1c', h, env);
    assert.ok(trail.includes('reasoning-turn-2') && trail.includes('reasoning-turn-3'));
    assert.ok(!trail.includes('reasoning-turn-1'), 'oldest evicted by the queue cap');
  });

  it('gate matrix: INJECT off → null; MAX_CHARS 0 → no capture; REUSE off → null', () => {
    const h = [{ role: 'user', content: 'q1' }];
    resolveSessionId('t1d', h, ENV_T1);
    h.push({ role: 'assistant', content: 'a1' });
    commitAfterResponse('t1d', h, ENV_T1, { reasoning: 'kept' });
    h.push({ role: 'user', content: 'q2' });
    resolveSessionId('t1d', h, ENV_T1);
    assert.equal(getSessionReasoningTrail('t1d', h, { DEVIN_CONNECT_SESSION_REUSE: '1' }), null, 'inject gate off');
    assert.equal(getSessionReasoningTrail('t1d', h, { DEVIN_CONNECT_SESSION_REASONING_INJECT: '1' }), null, 'reuse gate off');

    const env0 = { ...ENV_T1, DEVIN_CONNECT_SESSION_REASONING_MAX_CHARS: '0' };
    const h2 = [{ role: 'user', content: 'x1' }];
    resolveSessionId('t1e', h2, env0);
    h2.push({ role: 'assistant', content: 'y1' });
    commitAfterResponse('t1e', h2, env0, { reasoning: 'must not store' });
    h2.push({ role: 'user', content: 'x2' });
    resolveSessionId('t1e', h2, env0);
    assert.equal(getSessionReasoningTrail('t1e', h2, env0), null, 'cap 0 disables capture entirely');
  });

  it('idempotent re-commit does not double-store the tail', () => {
    const h = [{ role: 'user', content: 'q1' }];
    resolveSessionId('t1f', h, ENV_T1);
    h.push({ role: 'assistant', content: 'a1' });
    commitAfterResponse('t1f', h, ENV_T1, { reasoning: 'only-once' });
    commitAfterResponse('t1f', h, ENV_T1, { reasoning: 'only-once' });
    h.push({ role: 'user', content: 'q2' });
    resolveSessionId('t1f', h, ENV_T1);
    const trail = getSessionReasoningTrail('t1f', h, ENV_T1);
    assert.equal(trail.split('only-once').length - 1, 1, 'tail stored exactly once');
  });

  it('trail lookup is read-only: no state created', () => {
    const before = _getStoreSize();
    assert.equal(getSessionReasoningTrail('t1g-nobody', [{ role: 'user', content: 'orphan' }], ENV_T1), null);
    assert.equal(_getStoreSize(), before);
  });
});
