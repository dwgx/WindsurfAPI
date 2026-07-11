// S2 (audit) — sticky-session.js had ZERO test coverage (HIGH-severity gap).
// It binds (callerKey, modelKey) → account so multi-turn conversations stay on
// the same upstream account (cascade_id is only valid on its originating
// account). This suite pins bind / hit / miss / expire / fallback / eviction /
// clear / disabled-noop behavior.
//
// ⚠️ Module-load consts: sticky-session.js reads STICKY_SESSION_ENABLED / _TTL_MS
// / _MAX at import time into `const`s, so each env permutation needs a FRESH
// import on a busted module cache — same pattern as caller-key-xff-spoof.test.js.
//
// This module is pure in-memory (a Map + counters); it does NOT import auth.js
// and has NO cooldown logic. The "don't fight the 3-dimension cooldown / last-
// account exemption" red line is about the chat.js/auth.js CALL SITES, not this
// module — so these unit tests are safe and touch no pool behavior.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Fresh import so module-load consts (ENABLED/TTL/MAX) pick up the env we set.
async function loadFresh({ enabled = '1', ttl, max } = {}) {
  if (enabled === undefined) delete process.env.STICKY_SESSION_ENABLED;
  else process.env.STICKY_SESSION_ENABLED = enabled;
  if (ttl === undefined) delete process.env.STICKY_SESSION_TTL_MS;
  else process.env.STICKY_SESSION_TTL_MS = String(ttl);
  if (max === undefined) delete process.env.STICKY_SESSION_MAX;
  else process.env.STICKY_SESSION_MAX = String(max);
  const stamp = Date.now() + ':' + Math.random();
  return import(`../src/account/sticky-session.js?fresh=${stamp}`);
}

describe('sticky-session — disabled (default opt-out) is a total no-op', () => {
  it('every mutator/lookup is inert when STICKY_SESSION_ENABLED!=1', async () => {
    const m = await loadFresh({ enabled: '0' });
    assert.equal(m.isStickyEnabled(), false);
    m.setStickyBinding('caller-a', 'opus', 'acct-1', 'sk-1');
    assert.equal(m.getStickyBinding('caller-a', 'opus'), null, 'no binding when disabled');
    // clears are inert too (must not throw)
    m.clearStickyBinding('caller-a', 'opus');
    m.clearCallerBindings('caller-a');
    const stats = m.getStickyStats();
    assert.equal(stats.creates, 0);
    assert.equal(stats.size, 0);
  });

  it('any value other than exactly "1" is disabled', async () => {
    // The module gate is `=== '1'`, so unset, '0', 'true', 'yes' are all OFF.
    // (We assert the explicit non-'1' values rather than the unset case: env is
    // process-global and node:test interleaves awaits, so a concurrently-running
    // test's loadFresh could re-set the var between our delete and the fresh
    // import's module-load read. '0' is semantically identical to unset here.)
    for (const v of ['0', 'true', 'yes']) {
      const m = await loadFresh({ enabled: v });
      assert.equal(m.isStickyEnabled(), false, `enabled=${v} must be OFF`);
    }
  });
});

describe('sticky-session — bind / hit / miss', () => {
  let m;
  beforeEach(async () => { m = await loadFresh({ enabled: '1' }); m.resetAllBindings(); });

  it('a set binding is returned on lookup (hit)', () => {
    m.setStickyBinding('caller-a', 'opus', 'acct-1', 'sk-secret');
    assert.deepEqual(m.getStickyBinding('caller-a', 'opus'), { accountId: 'acct-1', apiKey: 'sk-secret' });
    assert.equal(m.getStickyStats().hits, 1);
    assert.equal(m.getStickyStats().creates, 1);
  });

  it('lookup for an unbound caller is a miss (null)', () => {
    assert.equal(m.getStickyBinding('nobody', 'opus'), null);
    assert.equal(m.getStickyStats().misses, 1);
  });

  it('the model dimension isolates bindings (no cross-model collision)', () => {
    m.setStickyBinding('caller-a', 'opus', 'acct-opus', 'sk-o');
    m.setStickyBinding('caller-a', 'sonnet', 'acct-sonnet', 'sk-s');
    assert.equal(m.getStickyBinding('caller-a', 'opus').accountId, 'acct-opus');
    assert.equal(m.getStickyBinding('caller-a', 'sonnet').accountId, 'acct-sonnet');
  });

  it('missing modelKey collapses to the "*" bucket consistently', () => {
    m.setStickyBinding('caller-a', '', 'acct-star', 'sk');
    assert.equal(m.getStickyBinding('caller-a', '').accountId, 'acct-star');
    assert.equal(m.getStickyBinding('caller-a').accountId, 'acct-star', 'omitted modelKey === empty');
  });

  it('re-setting the same key updates account but keeps createdAt (no double create)', () => {
    m.setStickyBinding('caller-a', 'opus', 'acct-1', 'sk-1');
    m.setStickyBinding('caller-a', 'opus', 'acct-2', 'sk-2');
    assert.equal(m.getStickyBinding('caller-a', 'opus').accountId, 'acct-2', 'rebind to new account');
    assert.equal(m.getStickyStats().creates, 1, 'refresh is not a new create');
  });

  it('empty callerKey / accountId are rejected (no binding minted)', () => {
    m.setStickyBinding('', 'opus', 'acct-1', 'sk');
    m.setStickyBinding('caller-a', 'opus', '', 'sk');
    assert.equal(m.getStickyStats().creates, 0);
    assert.equal(m.getStickyBinding('caller-a', 'opus'), null);
  });
});

describe('sticky-session — TTL expiry (sliding on lastAccess)', () => {
  it('a binding older than TTL since last access is expired on lookup', async () => {
    const m = await loadFresh({ enabled: '1', ttl: 50 });
    m.resetAllBindings();
    m.setStickyBinding('caller-a', 'opus', 'acct-1', 'sk');
    await new Promise(r => setTimeout(r, 80));
    assert.equal(m.getStickyBinding('caller-a', 'opus'), null, 'expired past TTL');
    assert.equal(m.getStickyStats().expires, 1);
  });

  it('access within TTL slides the window forward (stays alive)', async () => {
    const m = await loadFresh({ enabled: '1', ttl: 120 });
    m.resetAllBindings();
    m.setStickyBinding('caller-a', 'opus', 'acct-1', 'sk');
    await new Promise(r => setTimeout(r, 70));
    assert.ok(m.getStickyBinding('caller-a', 'opus'), 'alive at 70ms (<120 TTL)');   // slides lastAccess
    await new Promise(r => setTimeout(r, 70));
    assert.ok(m.getStickyBinding('caller-a', 'opus'), 'still alive: total 140ms but slid at 70ms');
  });
});

describe('sticky-session — clearing', () => {
  let m;
  beforeEach(async () => { m = await loadFresh({ enabled: '1' }); m.resetAllBindings(); });

  it('clearStickyBinding removes one caller+model, leaves siblings', () => {
    m.setStickyBinding('caller-a', 'opus', 'acct-1', 'sk');
    m.setStickyBinding('caller-a', 'sonnet', 'acct-2', 'sk');
    m.clearStickyBinding('caller-a', 'opus');
    assert.equal(m.getStickyBinding('caller-a', 'opus'), null, 'opus cleared');
    assert.ok(m.getStickyBinding('caller-a', 'sonnet'), 'sonnet survives');
  });

  it('clearCallerBindings removes ALL models for a caller, leaves other callers', () => {
    m.setStickyBinding('caller-a', 'opus', 'acct-1', 'sk');
    m.setStickyBinding('caller-a', 'sonnet', 'acct-2', 'sk');
    m.setStickyBinding('caller-b', 'opus', 'acct-3', 'sk');
    m.clearCallerBindings('caller-a');
    assert.equal(m.getStickyBinding('caller-a', 'opus'), null);
    assert.equal(m.getStickyBinding('caller-a', 'sonnet'), null);
    assert.equal(m.getStickyBinding('caller-b', 'opus').accountId, 'acct-3', 'other caller untouched');
  });

  it('clearCallerBindings prefix match does not clobber a longer caller name', () => {
    // "caller-a" must NOT clear "caller-ab" — the \0 delimiter guards the prefix.
    m.setStickyBinding('caller-a', 'opus', 'acct-1', 'sk');
    m.setStickyBinding('caller-ab', 'opus', 'acct-2', 'sk');
    m.clearCallerBindings('caller-a');
    assert.equal(m.getStickyBinding('caller-a', 'opus'), null);
    assert.equal(m.getStickyBinding('caller-ab', 'opus').accountId, 'acct-2', 'caller-ab must survive');
  });

  it('resetAllBindings wipes everything', () => {
    m.setStickyBinding('caller-a', 'opus', 'acct-1', 'sk');
    m.setStickyBinding('caller-b', 'opus', 'acct-2', 'sk');
    m.resetAllBindings();
    assert.equal(m.getStickyStats().size, 0);
    assert.equal(m.getStickyBinding('caller-a', 'opus'), null);
  });
});

describe('sticky-session — capacity eviction (LRU by lastAccess)', () => {
  it('evicts the oldest binding when at MAX and a NEW key is added', async () => {
    const m = await loadFresh({ enabled: '1', max: 2 });
    m.resetAllBindings();
    m.setStickyBinding('c1', 'opus', 'a1', 'sk');
    await new Promise(r => setTimeout(r, 5));
    m.setStickyBinding('c2', 'opus', 'a2', 'sk');
    await new Promise(r => setTimeout(r, 5));
    // touch c1 so c2 becomes the oldest by lastAccess
    m.getStickyBinding('c1', 'opus');
    m.setStickyBinding('c3', 'opus', 'a3', 'sk'); // at capacity → evicts oldest (c2)
    assert.equal(m.getStickyStats().evictions, 1);
    assert.equal(m.getStickyBinding('c2', 'opus'), null, 'least-recently-accessed evicted');
    assert.ok(m.getStickyBinding('c1', 'opus'), 'recently touched survives');
    assert.ok(m.getStickyBinding('c3', 'opus'), 'newest survives');
  });

  it('re-setting an EXISTING key at capacity does not trigger eviction', async () => {
    const m = await loadFresh({ enabled: '1', max: 2 });
    m.resetAllBindings();
    m.setStickyBinding('c1', 'opus', 'a1', 'sk');
    m.setStickyBinding('c2', 'opus', 'a2', 'sk');
    m.setStickyBinding('c1', 'opus', 'a1b', 'sk'); // existing key → no eviction
    assert.equal(m.getStickyStats().evictions, 0);
    assert.equal(m.getStickyBinding('c1', 'opus').accountId, 'a1b');
    assert.ok(m.getStickyBinding('c2', 'opus'));
  });
});

describe('sticky-session — stickyBindByUserOnly experimental collapses model dimension', () => {
  it('binds by caller only, ignoring model, when the flag is on', async () => {
    // bindingKey() reads isExperimentalEnabled('stickyBindByUserOnly') LIVE from
    // runtime-config _state (not an env var), so set it via the real setter.
    const rc = await import('../src/runtime-config.js');
    rc.setExperimental({ stickyBindByUserOnly: true });
    try {
      const m = await loadFresh({ enabled: '1' });
      m.resetAllBindings();
      m.setStickyBinding('caller-a', 'opus', 'acct-1', 'sk');
      // A different model must resolve to the SAME binding (model collapsed to "*").
      assert.equal(m.getStickyBinding('caller-a', 'sonnet').accountId, 'acct-1');
    } finally {
      rc.setExperimental({ stickyBindByUserOnly: false });
    }
  });
});
