// Detach P1 — registry contract (R1–R9).
//
// The registry is the only shared state a detached turn adds. These tests pin
// the four properties the design calls P0/P1:
//   - the key includes the trusted scope and every output-affecting decision
//     (a cross-tenant hit is a data leak);
//   - claim is a CAS (one resumer; a second identical request stays foreground);
//   - TTL/caps evict only non-claimed entries (a claimed entry belongs to a
//     live request);
//   - counters are one funnel (value/waste metrics cannot diverge).
import './setup-env.mjs';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DetachedRegistry,
  detachedKey,
  cascadeDetachEnabled,
  detachedRegistry,
} from '../src/detached-registry.js';
import * as auth from '../src/auth.js';
import { getConnectMetrics, resetConnectMetrics } from '../src/devin-connect-metrics.js';

const BODY = {
  model: 'gemini-2.5-flash',
  messages: [{ role: 'user', content: 'resume me' }],
  stream: true,
};

function keyOpts(overrides = {}) {
  return {
    scopeTrusted: true,
    route: 'chat',
    modelKey: 'gemini-2.5-flash',
    toolPreambleTier: null,
    emulateTools: false,
    native: null,
    stop: [],
    displayModel: 'gemini-2.5-flash',
    ...overrides,
  };
}

function snapshot(chunkText = 'hello') {
  return {
    version: 2,
    cascadeId: 'cascade-1',
    stepOffset: 1,
    pollFloor: 0,
    windowStart: 0,
    lastWindowStart: 0,
    overlap: 8,
    yieldedByStep: [[0, chunkText.length]],
    thinkingByStep: [],
    totalYielded: chunkText.length,
    totalThinking: 0,
    sawText: true,
    generatorOffset: 0,
    sawActive: true,
    usageByStep: [],
    consumedThrough: 1,
    chunks: [{ text: chunkText, thinking: '', isError: false }],
  };
}

function pin(now, overrides = {}) {
  return {
    cascadeId: 'cascade-1',
    sessionId: 'session-1',
    lsPort: 42100,
    lsGeneration: 1,
    accountId: 'acct-1',
    modelKey: 'gemini-2.5-flash',
    generatorOffset: 0,
    deadline: now + 60_000,
    startedAt: now,
    ...overrides,
  };
}

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms) { now += ms; },
  };
}

function makeRegistry(opts = {}) {
  const c = clock();
  const registry = new DetachedRegistry({ timers: false, now: c.now, ...opts });
  return { registry, clock: c };
}

function admit(registry, clock, { key = 'k1', callerKey = 'session:a', snap = snapshot() } = {}) {
  return registry.admit({ key, callerKey, snapshot: snap, pin: pin(clock.now()) });
}

describe('detachedKey', () => {
  it('R1 same body + same trusted scope → same key; a different scope → different key', () => {
    const a = detachedKey(BODY, 'session:a', keyOpts());
    const a2 = detachedKey(BODY, 'session:a', keyOpts());
    const b = detachedKey(BODY, 'session:b', keyOpts());
    assert.equal(typeof a, 'string');
    assert.equal(a, a2);
    assert.notEqual(a, b, 'a cross-tenant hit would serve one caller another caller\'s answer');
  });

  it('R2 different route / resolved model / native options / stop → different key', () => {
    const base = detachedKey(BODY, 'session:a', keyOpts());
    const variants = [
      keyOpts({ route: 'messages' }),
      keyOpts({ modelKey: 'claude-sonnet-4-6' }),
      keyOpts({ displayModel: 'claude-sonnet-4-6' }),
      keyOpts({ emulateTools: true }),
      keyOpts({ toolPreambleTier: 'schema' }),
      keyOpts({ native: { enabled: true, allowlist: ['view_file'] } }),
      keyOpts({ stop: ['STOP'] }),
    ];
    for (const opts of variants) {
      assert.notEqual(detachedKey(BODY, 'session:a', opts), base, JSON.stringify(opts));
    }
  });

  it('R3 untrusted scope → null key and admit refuses no_scope', () => {
    assert.equal(detachedKey(BODY, 'api:deadbeef', keyOpts({ scopeTrusted: false })), null);
    const { registry, clock } = makeRegistry();
    const refused = registry.admit({
      key: detachedKey(BODY, 'api:deadbeef', keyOpts({ scopeTrusted: false })),
      callerKey: 'api:deadbeef',
      snapshot: snapshot(),
      pin: pin(clock.now()),
    });
    assert.equal(refused.refused, 'no_scope');
    assert.equal(registry.stats().admit, 0);
    // Positive control: the same body under a trusted scope is admitted.
    assert.ok(admit(registry, clock).token);
  });

  it('is gated by WINDSURFAPI_CASCADE_DETACH and requires the producer flag', () => {
    assert.equal(cascadeDetachEnabled({}), false);
    assert.equal(cascadeDetachEnabled({ WINDSURFAPI_CASCADE_DETACH: '1' }), false);
    assert.equal(cascadeDetachEnabled({ WINDSURFAPI_CASCADE_TURN: '1' }), false);
    assert.equal(cascadeDetachEnabled({
      WINDSURFAPI_CASCADE_TURN: '1', WINDSURFAPI_CASCADE_DETACH: '1',
    }), true);
  });
});

describe('DetachedRegistry ownership', () => {
  it('R4 claim is a CAS: first ok, second busy, third ok after release(running)', () => {
    const { registry, clock } = makeRegistry();
    assert.ok(admit(registry, clock).token);
    const first = registry.claim('k1', 'session:a');
    assert.ok(first.entry, 'first claim must win');
    const second = registry.claim('k1', 'session:a');
    assert.equal(second.refused, 'busy', 'a second resumer must not share cursors');
    assert.equal(registry.stats().claim.busy, 1);

    assert.equal(registry.release('k1', first.token, { state: 'running', snapshot: snapshot('grown') }), true);
    const third = registry.claim('k1', 'session:a');
    assert.ok(third.entry, 'a re-detached entry is claimable again');
    assert.equal(registry.stats().re_detach, 1);
  });

  it('R4b release requires the claimant token; a wrong token cannot steal an entry', () => {
    const { registry, clock } = makeRegistry();
    admit(registry, clock);
    const claim = registry.claim('k1', 'session:a');
    assert.equal(registry.release('k1', 'not-the-token', { state: 'served' }), false);
    assert.ok(registry.lookup('k1', 'session:a'), 'the entry is still claimed by the real token');
    assert.equal(registry.release('k1', claim.token, { state: 'served' }), true);
    assert.equal(registry.lookup('k1', 'session:a'), null);
    assert.equal(registry.stats().serve, 1);
  });

  it('R5 TTL expiry refuses the claim and counts evict{ttl}', () => {
    const { registry, clock } = makeRegistry({ ttlMs: 120_000 });
    admit(registry, clock);
    clock.advance(120_001);
    assert.equal(registry.sweepExpired(), 1);
    assert.equal(registry.claim('k1', 'session:a').refused, 'gone');
    assert.equal(registry.stats().evict.ttl, 1);
    assert.equal(registry.stats().entries, 0);

    // A real (unref'd) timer takes the same path.
    const timed = makeRegistry({ ttlMs: 5 });
    timed.registry.timers = true;
    timed.registry.admit({ key: 'k2', callerKey: 'session:a', snapshot: snapshot(), pin: pin(timed.clock.now()) });
    // The injected clock does not move for setTimeout, so drive sweep instead.
    timed.clock.advance(6);
    assert.equal(timed.registry.sweepExpired(), 1);
    assert.equal(timed.registry.stats().evict.ttl, 1);
  });

  it('R5b TTL is an admission bound: a claimed entry survives sweep and lookup, and still releases served', () => {
    // Review D1: claim at t=119999, sweep at t=120001 used to delete the
    // claimed entry; the original token's release then returned false
    // (serve=0 while the turn was still billed).
    const { registry, clock } = makeRegistry({ ttlMs: 120_000 });
    registry.admit({
      key: 'k1',
      callerKey: 'session:a',
      snapshot: snapshot(),
      pin: pin(clock.now(), { deadline: clock.now() + 600_000 }),
    });
    const claim = registry.claim('k1', 'session:a');
    assert.ok(claim.entry, 'precondition: the claim wins');

    clock.advance(120_001);
    assert.equal(registry.sweepExpired(), 0, 'TTL must not evict a claim');
    assert.equal(registry.stats().evict.ttl, 0);
    assert.equal(registry.lookup('k1', 'session:a')?.state, 'claimed',
      'lookup must not evict a claim past its admission window');

    assert.equal(registry.release('k1', claim.token, { state: 'served' }), true,
      'the original token still owns the entry past the TTL');
    assert.equal(registry.stats().serve, 1);
    assert.equal(registry.stats().entries, 0);
  });

  it('R5c a claim is bounded by the original request deadline, not by TTL', () => {
    const { registry, clock } = makeRegistry({ ttlMs: 120_000 });
    registry.admit({
      key: 'k1',
      callerKey: 'session:a',
      snapshot: snapshot(),
      pin: pin(clock.now(), { deadline: clock.now() + 1_000 }),
    });
    const claim = registry.claim('k1', 'session:a');
    assert.ok(claim.entry);
    clock.advance(1_001);
    assert.equal(registry.sweepExpired(), 1,
      'the deadline still cleans up a claim whose request never returned');
    assert.equal(registry.stats().evict.deadline, 1);
    assert.equal(registry.stats().evict.ttl, 0);
    assert.equal(registry.release('k1', claim.token, { state: 'served' }), false);
  });

  it('claim_release_after_deadline_is_independent_of_cleanup_order', () => {
    // The deadline can be observed by the timer/sweep first or by release
    // first. Both interleavings must produce the same facts: false, serve=0,
    // exactly one deadline eviction, no re-detach, no entry left. Before the
    // deadline check lived in release(), the release-first interleaving
    // counted a serve and deleted the entry without naming the deadline.
    for (const state of ['served', 'running']) {
      for (const cleanupFirst of [true, false]) {
        const { registry, clock } = makeRegistry({ ttlMs: 120_000 });
        registry.admit({
          key: 'k1',
          callerKey: 'session:a',
          snapshot: snapshot(),
          pin: pin(clock.now(), { deadline: clock.now() + 1_000 }),
        });
        const claim = registry.claim('k1', 'session:a');
        assert.ok(claim.entry, 'precondition: the claim wins');
        clock.advance(1_001);

        if (cleanupFirst) {
          assert.equal(registry.sweepExpired(), 1, 'the deadline sweep drops the claim');
          assert.equal(registry.stats().evict.deadline, 1);
        }

        assert.equal(registry.release('k1', claim.token, {
          state,
          ...(state === 'running' ? { snapshot: snapshot('grown') } : {}),
        }), false, `${state}/${cleanupFirst ? 'sweep-first' : 'release-first'}: release must refuse`);
        const stats = registry.stats();
        assert.equal(stats.serve, 0, `${state}/${cleanupFirst ? 'sweep-first' : 'release-first'}: no serve`);
        assert.equal(stats.re_detach, 0, `${state}/${cleanupFirst ? 'sweep-first' : 'release-first'}: no re-detach`);
        assert.equal(stats.evict.deadline, 1,
          `${state}/${cleanupFirst ? 'sweep-first' : 'release-first'}: exactly one deadline eviction`);
        assert.equal(stats.evict.resume_miss, 0);
        assert.equal(stats.evict.ttl, 0);
        assert.equal(stats.entries, 0);
        assert.equal(registry.lookup('k1', 'session:a'), null);
      }
    }
  });

  it('R7c a claimed entry is only evictable with its own token', () => {
    const { registry, clock } = makeRegistry();
    assert.ok(admit(registry, clock).token);
    const claim = registry.claim('k1', 'session:a');
    assert.ok(claim.entry);

    assert.equal(registry.evict('k1', 'resume_miss'), false,
      'a key-only evict must not drop a live claim');
    assert.equal(registry.evict('k1', 'resume_miss', 'not-the-token'), false);
    assert.equal(registry.lookup('k1', 'session:a')?.state, 'claimed');
    assert.equal(registry.evict('k1', 'resume_miss', claim.token), true);
    assert.equal(registry.lookup('k1', 'session:a'), null);
  });

  it('R7d evict is identity-checked: a stale key or token cannot delete a same-key successor (ABA)', () => {
    const { registry, clock } = makeRegistry();
    assert.ok(admit(registry, clock).token);
    const first = registry.claim('k1', 'session:a');
    assert.ok(first.entry);
    // The owner re-detaches (token cleared), then a new admission supersedes
    // the entry under the same key — the old handler still holds `first.token`.
    assert.equal(registry.release('k1', first.token, { state: 'running', snapshot: snapshot('grown') }), true);
    assert.ok(admit(registry, clock, { key: 'k1', snap: snapshot('next') }).token);

    assert.equal(registry.evict('k1', 'resume_miss'), false,
      'a bare key is not an identity');
    assert.equal(registry.evict('k1', 'resume_miss', first.token), false,
      'a stale claim token is not the successor');
    const current = registry.lookup('k1', 'session:a');
    assert.ok(current, 'the successor survives');
    assert.equal(registry.evict('k1', 'resume_miss', current), true,
      'the instance the caller holds is evictable');
    assert.equal(registry.lookup('k1', 'session:a'), null);
  });

  it('R6 byte cap refuses admission (no truncation state)', () => {
    const { registry, clock } = makeRegistry({ maxEntryBytes: 2048 });
    const big = snapshot('x'.repeat(4096));
    const refused = registry.admit({ key: 'big', callerKey: 'session:a', snapshot: big, pin: pin(clock.now()) });
    assert.equal(refused.refused, 'over_bytes');
    assert.equal(registry.stats().refuse.over_bytes, 1);
    assert.equal(registry.stats().entries, 0);
    // Positive control: a small snapshot is admitted.
    assert.ok(admit(registry, clock).token);
  });

  it('R6b a refused over-bytes admission never destroys valid entries', () => {
    // Review360 P2-1: the byte checks used to run AFTER the same-key supersede
    // and the capacity evictions, so a 2-entry registry lost one live entry to
    // an admission that was then refused. Reproduce the 2→1 loss.
    const { registry, clock } = makeRegistry({
      maxEntries: 2, maxPerCaller: 10, maxEntryBytes: 4096, maxTotalBytes: 1 << 20,
    });
    admit(registry, clock, { key: 'a', callerKey: 'session:a', snap: snapshot('aaaa') });
    admit(registry, clock, { key: 'c', callerKey: 'session:c', snap: snapshot('cccc') });
    assert.equal(registry.stats().entries, 2);

    const refused = registry.admit({
      key: 'huge', callerKey: 'session:b', snapshot: snapshot('x'.repeat(5000)), pin: pin(clock.now()),
    });
    assert.equal(refused.refused, 'over_bytes');
    assert.equal(registry.stats().entries, 2, 'a refused admission must not evict capacity entries');
    assert.equal(registry.stats().evict.capacity, 0);
    assert.ok(registry.lookup('a', 'session:a'), 'the first valid entry survives');
    assert.ok(registry.lookup('c', 'session:c'), 'the second valid entry survives');

    // The same-key supersede is behind the same check: a refused replacement
    // leaves the original entry (and its bytes) intact.
    const replaced = registry.admit({
      key: 'a', callerKey: 'session:a', snapshot: snapshot('y'.repeat(5000)), pin: pin(clock.now()),
    });
    assert.equal(replaced.refused, 'over_bytes');
    assert.equal(registry.stats().evict.superseded, 0);
    assert.equal(registry.lookup('a', 'session:a').snapshot.chunks[0].text, 'aaaa');

    // The total cap is checked before capacity eviction too.
    registry.maxTotalBytes = registry.totalBytes + 1;
    const overTotal = registry.admit({
      key: 'd', callerKey: 'session:d', snapshot: snapshot('dddd'), pin: pin(clock.now()),
    });
    assert.equal(overTotal.refused, 'over_bytes');
    assert.equal(registry.stats().entries, 2);
    assert.equal(registry.stats().evict.capacity, 0);

    // A same-key replacement credits the bytes it frees, so it still fits.
    const okReplace = registry.admit({
      key: 'a', callerKey: 'session:a', snapshot: snapshot('a'), pin: pin(clock.now()),
    });
    assert.ok(okReplace.token);
    assert.equal(registry.lookup('a', 'session:a').snapshot.chunks[0].text, 'a');
    assert.equal(registry.stats().entries, 2);
    assert.ok(registry.totalBytes <= registry.maxTotalBytes);
  });

  it('R7 entry cap evicts only non-claimed entries', () => {
    const { registry, clock } = makeRegistry({ maxEntries: 2, maxPerCaller: 10 });
    admit(registry, clock, { key: 'a', callerKey: 'session:a' });
    admit(registry, clock, { key: 'b', callerKey: 'session:b' });
    const claimed = registry.claim('a', 'session:a');
    assert.ok(claimed.entry);

    // The cap is reached; the oldest RUNNING entry (b) is evicted, never the
    // claimed one (a).
    assert.ok(admit(registry, clock, { key: 'c', callerKey: 'session:c' }).token);
    assert.equal(registry.stats().entries, 2);
    assert.equal(registry.lookup('b', 'session:b'), null);
    assert.ok(registry.lookup('a', 'session:a'), 'a claimed entry must not be evicted for capacity');

    // All remaining entries claimed → the next admission is refused.
    registry.claim('c', 'session:c');
    assert.equal(admit(registry, clock, { key: 'd', callerKey: 'session:d' }).refused, 'over_entries');
  });

  it('R7b per-caller cap evicts only that caller\'s oldest running entry', () => {
    const { registry, clock } = makeRegistry({ maxEntries: 8, maxPerCaller: 2 });
    admit(registry, clock, { key: 'a1', callerKey: 'session:a' });
    admit(registry, clock, { key: 'a2', callerKey: 'session:a' });
    assert.ok(admit(registry, clock, { key: 'a3', callerKey: 'session:a' }).token);
    assert.equal(registry.lookup('a1', 'session:a'), null, 'oldest of that caller is evicted');
    assert.ok(registry.lookup('a2', 'session:a'));
    assert.ok(registry.lookup('a3', 'session:a'));
  });

  it('R8 beginDrain refuses admissions; close evicts every entry', () => {
    const { registry, clock } = makeRegistry();
    admit(registry, clock, { key: 'a', callerKey: 'session:a' });
    registry.claim('a', 'session:a');
    admit(registry, clock, { key: 'b', callerKey: 'session:b' });
    registry.beginDrain();
    assert.equal(registry.stats().entries, 0, 'drain drops claimed and running entries alike');
    assert.equal(registry.stats().evict.drain, 2);
    assert.equal(admit(registry, clock, { key: 'c', callerKey: 'session:c' }).refused, 'draining');
    assert.equal(registry.stats().refuse.draining, 1);
    registry.close();
    assert.equal(registry.stats().entries, 0);
  });

  it('R9 counters are one funnel and stay internally consistent', () => {
    const { registry, clock } = makeRegistry({ maxEntries: 2, maxPerCaller: 10, maxEntryBytes: 4096 });
    admit(registry, clock, { key: 'a', callerKey: 'session:a' });          // admit
    admit(registry, clock, { key: 'b', callerKey: 'session:b' });          // admit
    registry.lookup('missing', 'session:a');                                // miss
    const claim = registry.claim('a', 'session:a');                         // ok
    registry.claim('a', 'session:a');                                       // busy
    registry.release('a', claim.token, { state: 'served' });                // serve
    registry.admit({ key: 'big', callerKey: 'session:a', snapshot: snapshot('x'.repeat(2048)), pin: pin(clock.now()) }); // over_bytes
    const stats = registry.stats();
    assert.equal(stats.admit, 2);
    assert.equal(stats.refuse.over_bytes, 1);
    assert.equal(stats.claim.ok, 1);
    assert.equal(stats.claim.busy, 1);
    assert.equal(stats.serve, 1);
    assert.equal(stats.lookup.miss, 1);
    assert.equal(stats.entries, 1);
    assert.equal(stats.bytes, registry.totalBytes);
    assert.equal(
      stats.entries,
      stats.admit - stats.serve - stats.re_detach - Object.values(stats.evict).reduce((a, b) => a + b, 0),
      'entries must equal admits minus every deletion',
    );
  });

  it('re-detach keeps the original TTL (a re-detach buys no extra time)', () => {
    const { registry, clock } = makeRegistry({ ttlMs: 120_000 });
    registry.admit({
      key: 'k1',
      callerKey: 'session:a',
      snapshot: snapshot(),
      pin: pin(clock.now(), { deadline: clock.now() + 300_000 }),
    });
    clock.advance(60_000);
    const claim = registry.claim('k1', 'session:a');
    assert.equal(registry.release('k1', claim.token, { state: 'running', snapshot: snapshot('grown') }), true);
    clock.advance(60_001);
    assert.equal(registry.sweepExpired(), 1);
    assert.equal(registry.claim('k1', 'session:a').refused, 'gone');
  });

  it('evictForAccount drops only entries pinned to that account', () => {
    const { registry, clock } = makeRegistry();
    registry.admit({ key: 'a', callerKey: 'session:a', snapshot: snapshot(), pin: pin(clock.now(), { accountId: 'acct-1' }) });
    registry.admit({ key: 'b', callerKey: 'session:b', snapshot: snapshot(), pin: pin(clock.now(), { accountId: 'acct-2' }) });
    assert.equal(registry.evictForAccount('acct-1'), 1);
    assert.equal(registry.lookup('a', 'session:a'), null);
    assert.ok(registry.lookup('b', 'session:b'));
    assert.equal(registry.stats().evict.account_removed, 1);
  });

  it('refuses a snapshot without the v2 consumed pointer', () => {
    const { registry, clock } = makeRegistry();
    const bad = snapshot();
    delete bad.consumedThrough;
    assert.equal(
      registry.admit({ key: 'bad', callerKey: 'session:a', snapshot: bad, pin: pin(clock.now()) }).refused,
      'bad_snapshot',
    );
    assert.equal(registry.stats().refuse.bad_snapshot, 1);
  });

  it('refuses a non-client-gone cause and a missing deadline', () => {
    const { registry, clock } = makeRegistry();
    assert.equal(
      registry.admit({ key: 'a', callerKey: 'session:a', snapshot: snapshot(), pin: pin(clock.now()), cause: 'shutdown' }).refused,
      'not_client_gone',
    );
    assert.equal(
      registry.admit({ key: 'a', callerKey: 'session:a', snapshot: snapshot(), pin: { ...pin(clock.now()), deadline: null } }).refused,
      'no_deadline',
    );
  });
});

// G14 — the account-gone cleanups auth.js fires (conversation-pool
// invalidateFor, detached-registry evictForAccount, user-JWT epoch bump) are
// fire-and-forget promises. A rejection used to die in `.catch(()=>{})`:
// a failed invalidateFor left stale pool entries resuming onto a dead
// account and a failed evictForAccount left a resumable detached pin, with
// zero signal anywhere. A failed cleanup must now be observable — counted
// (account_cleanup_failed) and logged — while the caller still never waits.
describe('G14 — auth cleanup rejections are observable (metric/log)', () => {
  const createdIds = [];
  function mkAccount() {
    const a = auth.addAccountByKey(`sk-g14-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'g14');
    createdIds.push(a.id);
    return a;
  }
  function captureWarns() {
    const warnings = [];
    const orig = console.warn;
    console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
    return { warnings, restore: () => { console.warn = orig; } };
  }
  const settle = () => new Promise((r) => setImmediate(r));

  afterEach(() => {
    auth.__setAccountCleanupDeps?.(null);
    while (createdIds.length) auth.removeAccount(createdIds.pop());
    resetConnectMetrics();
  });

  it('a rejected evictForAccount inside removeAccount is logged and counted', async () => {
    // Inject through the real path: the module-level evictForAccount
    // delegates to this instance method, so the dynamic import, the .then
    // call and the rejection all run for real.
    const original = detachedRegistry.evictForAccount;
    detachedRegistry.evictForAccount = () => { throw new Error('detached evict broke'); };
    const cap = captureWarns();
    try {
      const a = mkAccount();
      resetConnectMetrics();
      assert.equal(auth.removeAccount(a.id), true, 'removal still succeeds — the caller never waits');
      createdIds.pop();
      await settle();
      assert.match(cap.warnings.join('\n'), /evictForAccount.*detached evict broke/,
        'the rejected cleanup must be logged, not swallowed');
      assert.equal(getConnectMetrics().account_cleanup_failed, 1,
        'the rejected cleanup must be counted, not silent');
    } finally {
      detachedRegistry.evictForAccount = original;
      cap.restore();
    }
  });

  it('rejected invalidateFor / user-JWT epoch inside removeAccount are logged and counted', async () => {
    const cap = captureWarns();
    try {
      auth.__setAccountCleanupDeps?.({
        invalidateFor: () => Promise.reject(new Error('pool invalidate broke')),
        bumpUserJwtCacheEpoch: () => Promise.reject(new Error('jwt epoch broke')),
      });
      const a = mkAccount();
      resetConnectMetrics();
      auth.removeAccount(a.id);
      createdIds.pop();
      await settle();
      const logged = cap.warnings.join('\n');
      assert.match(logged, /invalidateFor.*pool invalidate broke/);
      assert.match(logged, /bumpUserJwtCacheEpoch.*jwt epoch broke/);
      assert.equal(getConnectMetrics().account_cleanup_failed, 2);
    } finally {
      cap.restore();
    }
  });

  it('a rejected invalidateFor inside reportBanSignal is logged and counted; the ban still lands', async () => {
    const cap = captureWarns();
    try {
      const a = mkAccount();
      auth.__setAccountCleanupDeps?.({
        invalidateFor: () => Promise.reject(new Error('pool invalidate broke')),
      });
      resetConnectMetrics();
      auth.reportBanSignal(a.apiKey, 'Account suspended');
      auth.reportBanSignal(a.apiKey, 'Invalid API key');
      await settle();
      assert.equal(auth.getAccountInternal(a.id).status, 'banned',
        'a cleanup failure must not roll back the ban decision');
      assert.match(cap.warnings.join('\n'), /invalidateFor.*pool invalidate broke/);
      assert.equal(getConnectMetrics().account_cleanup_failed, 1);
    } finally {
      cap.restore();
    }
  });

  it('a successful cleanup emits no failure signal', async () => {
    const cap = captureWarns();
    try {
      const a = mkAccount();
      resetConnectMetrics();
      auth.removeAccount(a.id);
      createdIds.pop();
      await settle();
      assert.doesNotMatch(cap.warnings.join('\n'), /account cleanup .* failed/);
      assert.equal(getConnectMetrics().account_cleanup_failed, 0);
    } finally {
      cap.restore();
    }
  });
});
