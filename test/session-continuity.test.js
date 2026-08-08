import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSessionId,
  commitAfterResponse,
  isSessionReuseEnabled,
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

describe('session-continuity: compaction survival (root fallback)', () => {
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

  it('a compacted history with rewritten pairs still resolves the committed session via the root anchor', () => {
    const h = [{ role: 'system', content: 'sys' }];
    const id1 = turn('c1', h, 'build a parser', 'ok');
    const id2 = turn('c1', h, 'add error handling', 'done');
    const id3 = turn('c1', h, 'add tests', 'done');
    assert.equal(id1, id2);
    assert.equal(id2, id3);

    // Client compaction: the retained tail is rewritten so 0 of the committed
    // pairs survive byte-for-byte, BUT the dialog's FIRST input turn survives
    // verbatim (the root anchor). Pair evidence is gone → root fallback fires.
    const compacted = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'build a parser' },
      { role: 'assistant', content: 'ok (compressed summary)' },
      { role: 'user', content: 'add tests' },
    ];
    const before = _getStoreSize();
    const resolved = resolveSessionId('c1', compacted, ENV);
    assert.equal(resolved, id3, 'compacted history must re-associate through the root anchor');
    assert.equal(_getStoreSize(), before, 'a clean root re-association must not grow the store');
  });

  it('two live states sharing the root anchor with no pair evidence are ambiguous → a NEW id forms (no hijack)', () => {
    const h1 = [];
    const d1t1 = turn('c1', h1, 'same opener', 'reply one');
    const d1t2 = turn('c1', h1, 'continue 1', 'more one');
    const h2 = [];
    const d2t1 = turn('c1', h2, 'same opener', 'reply two');
    const d2t2 = turn('c1', h2, 'continue 2', 'more two');
    assert.equal(d1t1, d2t1, 'identical openers collide on turn 1 (same root anchor)');
    assert.notEqual(d1t2, d2t2, 'the two dialogs must have forked at turn 2');

    // A compacted resolve whose rewritten pairs match no stored index and whose
    // root anchor is shared by BOTH live states → ambiguous → assign to none.
    const compacted = [
      { role: 'user', content: 'same opener' },
      { role: 'assistant', content: 'reply one (compressed summary)' },
      { role: 'user', content: 'continue 1' },
    ];
    const resolved = resolveSessionId('c1', compacted, ENV);
    assert.notEqual(resolved, d1t2, 'ambiguous root must not be assigned to dialog 1');
    assert.notEqual(resolved, d2t2, 'ambiguous root must not be assigned to dialog 2');
  });

  it('an EXPIRED state is evicted by the root fallback — a stale dialog does not resurrect through compaction', () => {
    const h = [];
    const id1 = turn('c1', h, 'stale opener', 'old reply');
    const id2 = turn('c1', h, 'stale followup', 'old more');
    assert.equal(id1, id2);

    // Busy-wait past a 1ms TTL so the stored state is stale on the next resolve.
    const env = { ...ENV, DEVIN_CONNECT_SESSION_TTL_MS: '1' };
    const spinUntil = Date.now() + 5;
    while (Date.now() < spinUntil) { /* let the TTL lapse */ }

    // Pair evidence wiped by compaction; the root anchor survives — but the only
    // candidate is expired, so the fallback must evict it and form a NEW id.
    const compacted = [
      { role: 'user', content: 'stale opener' },
      { role: 'assistant', content: 'old reply (compressed summary)' },
      { role: 'user', content: 'next turn after the lapse' },
    ];
    const resolved = resolveSessionId('c1', compacted, env);
    assert.notEqual(resolved, id2, 'a TTL-expired session must not resurrect through the root fallback');
  });
});

describe('session-continuity: tail-anchored overlap', () => {
  beforeEach(() => _resetForTests());
  afterEach(() => _resetForTests());

  function turn(caller, historyRef, userText, assistantText) {
    historyRef.push({ role: 'user', content: userText });
    const id = resolveSessionId(caller, historyRef, ENV);
    historyRef.push({ role: 'assistant', content: assistantText });
    commitAfterResponse(caller, historyRef, ENV);
    return id;
  }

  it('a divergent dialog sharing only an early pair does NOT resolve to the committed session (prefix-only run scores 0)', () => {
    const h = [];
    turn('c1', h, 'A1', 'O1');
    turn('c1', h, 'A2', 'O2');
    const committedId = turn('c1', h, 'A3', 'O3');

    // Shares the opener + first pair (a PREFIX-only run), then answers A2
    // differently. Tail-anchored overlap must score 0 → no claim on the session.
    const divergent = [
      { role: 'user', content: 'A1' }, { role: 'assistant', content: 'O1' },
      { role: 'user', content: 'A2' }, { role: 'assistant', content: 'an unrelated answer' },
      { role: 'user', content: 'A3' },
    ];
    const before = _getStoreSize();
    const divId = resolveSessionId('c1', divergent, ENV);
    assert.notEqual(divId, committedId, 'a prefix-only run must never hijack the committed session');
    assert.ok(_getStoreSize() > before, 'the divergent dialog must fork its own state');
  });

  it('the true continuation (suffix/tail match) resolves back to its own session — and the fork stays stable on its own id', () => {
    const h = [];
    turn('c1', h, 'A1', 'O1');
    turn('c1', h, 'A2', 'O2');
    const committedId = turn('c1', h, 'A3', 'O3');

    // True continuation: the full history replayed + a fresh user turn — the
    // committed tail (suffix) matches the incoming tail → resolves to ITS session.
    const contId = resolveSessionId('c1', [...h, { role: 'user', content: 'A4' }], ENV);
    assert.equal(contId, committedId, 'the suffix/tail match must resolve to the committed session');

    // The divergent fork is a session of its own: it keeps ITS id on the next turn.
    const divergent = [
      { role: 'user', content: 'A1' }, { role: 'assistant', content: 'O1' },
      { role: 'user', content: 'A2' }, { role: 'assistant', content: 'an unrelated answer' },
      { role: 'user', content: 'A3' },
    ];
    const divId = resolveSessionId('c1', divergent, ENV);
    const divNext = resolveSessionId('c1', [...divergent, { role: 'user', content: 'A4' }], ENV);
    assert.equal(divNext, divId, 'the divergent fork must stay stable on its own id');
  });
});
