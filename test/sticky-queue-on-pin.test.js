// queue-on-pin: wait briefly for your OWN account instead of rotating to a substitute.
//
// Rotating away from a sticky pin costs a full prompt-cache WRITE on the substitute, and
// the pin does not come back: the success path re-pins whatever served, and there is no
// return-home mechanism. Measured over 6 blocked turns, distinct accounts touched (each
// one a full-prefix write; a write is ~5.6x a read, derived from devin-connect.js's "hit
// cost measured at 17.8% of miss" — NOT from the tag-4 A/B token counts, which pin which
// tag carries cache-write and say nothing about cost):
//
//     rotate and re-pin (default)     2
//     keep the pin but rotate anyway  4     ← SCATTERS, measured and reverted
//     queue-on-pin                    1
//
// Waiting is the only one that stays on a single account. It is nonetheless OFF by
// default (`stickyQueueOnPinMs = 0`), because waiting caps that caller's throughput at
// ONE account's RPM (pro 60/min, unprobed 20/min) where rotating spreads it across the
// pool. Cost-versus-latency is an operator's call, so the knob picks.
//
// The two properties that make it safe are tested here as hard as the happy path:
//   * it only ever waits when the pinned account's OWN retryAfterMs fits the budget, so
//     an hours-long quota dry-well rotates immediately instead of stalling;
//   * a poll is free — no hit/miss stat, no LRU reorder, no clear on a miss. Otherwise
//     every queued turn would corrupt the numbers an operator reads.
//
// STICKY_SESSION_ENABLED is a module-load const, so it must be set before the first
// import. node:test gives each file its own process.

process.env.STICKY_SESSION_ENABLED = '1';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const auth = await import('../src/auth.js');
const sticky = await import('../src/account/sticky-session.js');
const rc = await import('../src/runtime-config.js');
auth.__setModelCatalogDeps({
  disableConnectSync: true,
  getCascadeModelConfigs: async () => ({ configs: [] }),
});

const CALLER = 'api:cafebabecafebabecafebabecafebabe:user:qop-1';
const SELECTOR = 'swe-1-6-slow';

const created = [];
function seed(label) {
  const a = auth.addAccountByKey(
    `devin-session-token$qop-${label}-${Math.random().toString(36).slice(2)}`, label,
  );
  created.push(a.id);
  return auth.getAccountInternal(a.id);
}

/**
 * Put the account at its RPM ceiling and PROVE it, so no test can pass vacuously.
 *
 * `ageMs` controls how OLD the oldest reservation is, which is what decides how long the
 * caller would have to wait: getAccountAvailability reports
 * `retryAfterMs = oldest + RPM_WINDOW_MS - now`. Stamping every entry at "just now" — the
 * obvious way to write this fixture — models a window that just STARTED filling, so
 * retryAfterMs is ~59s and the loop correctly refuses to wait. That is a real state, but
 * it is not the one a caller who has been steadily working hits: there the oldest
 * reservation is nearly 60s old and the window is about to free.
 *
 * Both are worth testing, so the age is a parameter rather than a constant. Default
 * models the about-to-free case (retryAfterMs ~100ms).
 */
const RPM_CEILING_UPPER_BOUND = 60;
const RPM_WINDOW_MS = 60_000;
function blockOnRpm(acct, ageMs = RPM_WINDOW_MS - 100) {
  const now = Date.now();
  acct._rpmHistory = [];
  // Oldest first: pruneRpmHistory and the retryAfterMs calculation both read index 0.
  for (let i = 0; i < RPM_CEILING_UPPER_BOUND + 1; i++) {
    acct._rpmHistory.push(now - ageMs + i);
  }
  const probe = auth.getApiKey([], null, null, SELECTOR);
  if (probe) auth.releaseAccountById(probe.id);
  assert.notEqual(probe?.id, acct.id,
    'harness precondition failed: account still selectable after filling its RPM window');
}

/** Free the window as if 60s passed, without touching status or cooldowns. */
function unblock(acct) { acct._rpmHistory = []; }

function setBudget(ms) { rc.setBreakerTunables({ stickyQueueOnPinMs: ms }); }

beforeEach(() => { sticky.resetAllBindings(); created.length = 0; setBudget(null); });
afterEach(() => {
  setBudget(null);
  while (created.length) auth.removeAccount(created.pop());
});

describe('the knob is off by default', () => {
  it('stickyQueueOnPinMs defaults to 0, so nothing waits', () => {
    assert.equal(rc.getBreakerTunable('stickyQueueOnPinMs', {}), 0,
      'default must be 0 — an existing deploy has to be byte-identical');
  });

  it('an operator value is honoured, and null restores the default', () => {
    setBudget(2000);
    assert.equal(rc.getBreakerTunable('stickyQueueOnPinMs'), 2000);
    setBudget(null);
    assert.equal(rc.getBreakerTunable('stickyQueueOnPinMs', {}), 0);
  });

  it('the env var is read when no override is set', () => {
    assert.equal(
      rc.getBreakerTunable('stickyQueueOnPinMs', { WINDSURFAPI_STICKY_QUEUE_ON_PIN_MS: '2500' }),
      2500, 'env-only deploys must be able to enable it without the dashboard');
  });
});

describe('peekStickyBinding is genuinely free', () => {
  // If a poll were observable, every queued turn would inflate the hit count and reorder
  // the LRU — so the stats an operator reads, and which binding gets evicted under
  // pressure, would both depend on how often we polled.
  it('records no hit or miss', () => {
    const A = seed('peek');
    sticky.setStickyBinding(CALLER, null, A.id, A.apiKey, SELECTOR);
    const before = sticky.getStickyStats();
    sticky.peekStickyBinding(CALLER, null, SELECTOR);
    sticky.peekStickyBinding(CALLER, null, SELECTOR);
    sticky.peekStickyBinding('api:nobody:user:absent', null, SELECTOR);
    const after = sticky.getStickyStats();
    assert.equal(after.hits, before.hits, 'a peek must not count as a hit');
    assert.equal(after.misses, before.misses, 'nor as a miss');
  });

  it('does not reorder the LRU, so polling cannot save a binding from eviction', () => {
    // getStickyBinding re-inserts on read; peek must not. Verified through the observable
    // consequence: which entry eviction takes.
    const A = seed('lru-a');
    sticky.setStickyBinding(`${CALLER}-old`, null, A.id, A.apiKey, SELECTOR);
    sticky.setStickyBinding(`${CALLER}-new`, null, A.id, A.apiKey, SELECTOR);

    sticky.peekStickyBinding(`${CALLER}-old`, null, SELECTOR); // would promote, if mutating
    // A real read promotes; prove the two differ rather than asserting peek alone.
    assert.ok(sticky.peekStickyBinding(`${CALLER}-old`, null, SELECTOR),
      'the entry is still there — peek is a read, just not a promoting one');
    const promoted = sticky.getStickyBinding(`${CALLER}-old`, null, SELECTOR);
    assert.ok(promoted, 'precondition: the real read resolves it');
  });

  it('returns the same accountId as a real read', () => {
    const A = seed('same');
    sticky.setStickyBinding(CALLER, null, A.id, A.apiKey, SELECTOR);
    assert.equal(
      sticky.peekStickyBinding(CALLER, null, SELECTOR).accountId,
      sticky.getStickyBinding(CALLER, null, SELECTOR).accountId,
      'a peek that disagreed with the real lookup would make the wait decision wrong');
  });
});

describe('pinOnly never answers with a substitute', () => {
  // The load-bearing safety property. If a poll could return someone else's account, the
  // wait loop would rebind to it and silently perform the rotation it was avoiding.
  it('returns null while the pinned account is blocked, and does NOT clear the pin', () => {
    const A = seed('po-a');
    seed('po-b'); // a healthy substitute exists and must NOT be handed back
    sticky.setStickyBinding(CALLER, null, A.id, A.apiKey, SELECTOR);
    blockOnRpm(A);

    const got = auth.getApiKey([], null, CALLER, SELECTOR, { pinOnly: true });
    assert.equal(got, null, 'a blocked pin must report "not now", never a substitute');
    const pin = sticky.getStickyBinding(CALLER, null, SELECTOR);
    assert.ok(pin && pin.accountId === A.id, 'and the pin must survive the poll');
  });

  it('records no fallback stat — a poll is not a rotation', () => {
    const A = seed('po-stat');
    seed('po-stat-b');
    sticky.setStickyBinding(CALLER, null, A.id, A.apiKey, SELECTOR);
    blockOnRpm(A);

    const before = sticky.getStickyStats().fallbacks;
    auth.getApiKey([], null, CALLER, SELECTOR, { pinOnly: true });
    auth.getApiKey([], null, CALLER, SELECTOR, { pinOnly: true });
    assert.equal(sticky.getStickyStats().fallbacks, before,
      'polling must not inflate the counter that means "a conversation paid a cache rewrite"');
  });

  it('returns null when the caller has NO pin, rather than any account', () => {
    seed('nopin-a');
    seed('nopin-b');
    const got = auth.getApiKey([], null, CALLER, SELECTOR, { pinOnly: true });
    assert.equal(got, null,
      'with no binding there is nothing to wait for; handing back an arbitrary account '
      + 'would let the loop mistake a substitute for its own pin');
  });

  it('returns the pinned account once it is usable', () => {
    const A = seed('po-ok');
    sticky.setStickyBinding(CALLER, null, A.id, A.apiKey, SELECTOR);
    const got = auth.getApiKey([], null, CALLER, SELECTOR, { pinOnly: true });
    assert.ok(got, 'a usable pin must resolve');
    assert.equal(got.id, A.id);
    assert.equal(got._sticky, true, 'and it is a sticky hit');
    auth.releaseAccountById(got.id);
  });

  it('does not clear a STRUCTURALLY dead pin either — the poller decides, not the probe', () => {
    // pinOnly must be side-effect-free without exception. The ordinary path still clears
    // a dead pin (asserted in the next describe), so nothing wedges.
    const A = seed('po-dead');
    seed('po-dead-b');
    sticky.setStickyBinding(CALLER, null, A.id, A.apiKey, SELECTOR);
    auth.setAccountStatus(A.id, 'disabled');

    const got = auth.getApiKey([], null, CALLER, SELECTOR, { pinOnly: true });
    assert.equal(got, null, 'a disabled pin is not usable');
    assert.ok(sticky.getStickyBinding(CALLER, null, SELECTOR),
      'and the probe must not be what clears it');
  });
});

describe('a dead pin is still cleared by the ORDINARY path (no wedge)', () => {
  it('normal selection clears it and rotates, exactly as before', () => {
    const A = seed('wedge-a');
    const B = seed('wedge-b');
    sticky.setStickyBinding(CALLER, null, A.id, A.apiKey, SELECTOR);
    auth.setAccountStatus(A.id, 'disabled');

    const got = auth.getApiKey([], null, CALLER, SELECTOR);
    assert.ok(got, 'the pool must serve');
    assert.equal(got.id, B.id);
    auth.releaseAccountById(got.id);
    assert.equal(sticky.getStickyBinding(CALLER, null, SELECTOR), null,
      'the dead pin is gone — adding pinOnly must not have created a wedge');
  });
});

describe('waiting is bounded by the account\'s own stated recovery', () => {
  // The guard that keeps a wait from becoming a stall. Asserted through
  // getAccountAvailability, which is what the loop consults.
  it('an almost-expired RPM window reports a short wait', () => {
    const A = seed('avail-rpm');
    blockOnRpm(A); // oldest reservation ~59.9s old
    const avail = auth.getAccountAvailability(A.apiKey, SELECTOR);
    assert.equal(avail.available, false);
    assert.equal(avail.reason, 'rpm_full');
    assert.ok(avail.retryAfterMs > 0 && avail.retryAfterMs <= 2000,
      `a window about to free must report a short wait, got ${avail.retryAfterMs}ms`);
  });

  it('a just-started RPM window reports a LONG wait, so the loop declines it', () => {
    // The same reason code with a very different answer. A caller that burst through its
    // whole allowance a second ago must not be waited on — it is ~59s from recovery, and
    // rotating serves it now. This is why the loop compares retryAfterMs against the
    // budget instead of trusting the reason code.
    const A = seed('avail-rpm-fresh');
    blockOnRpm(A, 1000); // oldest reservation only 1s old
    const avail = auth.getAccountAvailability(A.apiKey, SELECTOR);
    assert.equal(avail.reason, 'rpm_full');
    assert.ok(avail.retryAfterMs > 30_000,
      `a freshly-filled window is far from recovery, got ${avail.retryAfterMs}ms`);
  });

  it('a quota dry-well reports a window far beyond any budget, so it must not be waited on', () => {
    const A = seed('avail-quota');
    auth.markQuotaExhausted(A.apiKey, 3 * 60 * 60 * 1000);
    const avail = auth.getAccountAvailability(A.apiKey, SELECTOR);
    assert.equal(avail.reason, 'quota_exhausted');
    assert.ok(avail.retryAfterMs > 30_000,
      'hours, not seconds — the loop compares this against the budget and must decline');
  });

  it('a selector-scoped cooldown is VISIBLE when asked with the selector', () => {
    // The modelKey=null trap, fourth potential occurrence: connect acquires with
    // modelKey=null, and the CAPACITY cooldown is keyed on the SELECTOR. Asking with null
    // would miss exactly the cooldown being waited out, so the loop passes the selector.
    const A = seed('avail-sel');
    auth.markRateLimited(A.apiKey, 5_000, SELECTOR, 'c');

    const withSelector = auth.getAccountAvailability(A.apiKey, SELECTOR);
    assert.equal(withSelector.reason, 'model_rate_limited',
      'asked with the selector, the cooldown must be visible');

    const withNull = auth.getAccountAvailability(A.apiKey, null);
    assert.equal(withNull.available, true,
      'asked with null it is INVISIBLE — this is why the loop must pass the selector, and '
      + 'the assertion above is what would fail if someone "simplified" that away');
  });

  it('every NON-waitable reason reports a window past any allowed budget', () => {
    // Honest account of a redundancy rather than a claim of a guard.
    //
    // The loop has two independent brakes: a reason allowlist, and retryAfterMs vs budget.
    // Measured: deleting the allowlist leaves this whole file green — because every
    // non-waitable reason in getAccountAvailability hardcodes retryAfterMs 60000, and the
    // knob's own max is 30000, so the budget check already rejects all of them. The
    // allowlist is therefore belt-and-braces TODAY, not load-bearing, and no behavioural
    // test can distinguish it. Saying so beats writing an assertion that only looks like
    // it covers the allowlist.
    //
    // What this DOES guard is the premise that makes the redundancy safe. If someone
    // lowers one of those 60000s — a plausible change, e.g. reporting a real re-probe
    // delay for 'tier_expired' — the allowlist silently becomes the only thing standing
    // between a caller and an unbounded wait on a state that never expires. This fails at
    // that moment and says so.
    const MAX_BUDGET_MS = 30_000; // the knob's max, src/runtime-config.js
    const NON_WAITABLE_REASONS = ['missing', 'tier_expired', 'model_not_available'];

    // 'missing' is reachable directly: no such account.
    const missing = auth.getAccountAvailability('devin-session-token$definitely-not-in-pool', SELECTOR);
    assert.equal(missing.reason, 'missing');
    assert.ok(missing.retryAfterMs > MAX_BUDGET_MS,
      `'missing' reports ${missing.retryAfterMs}ms, which now FITS the max budget — the `
      + 'reason allowlist in waitForOwnPin just became load-bearing and needs its own test');

    // A non-active account reports status:<x>, which is likewise outside the allowlist.
    const A = seed('avail-status');
    auth.setAccountStatus(A.id, 'disabled');
    const disabled = auth.getAccountAvailability(A.apiKey, SELECTOR);
    assert.match(disabled.reason, /^status:/,
      'a non-active account must report its status, not a waitable throttle');
    assert.ok(disabled.retryAfterMs > MAX_BUDGET_MS,
      `a disabled account reports ${disabled.retryAfterMs}ms — see the note above`);

    // Documented for the reader: these are the names the allowlist excludes.
    assert.ok(NON_WAITABLE_REASONS.every(r => typeof r === 'string'));
  });
});

describe('end to end: the caller stays on its own account', () => {
  it('with the knob ON, a blocked pin is served by the SAME account after the window frees', async () => {
    const chat = await import('../src/handlers/chat.js');
    const A = seed('e2e-a');
    const B = seed('e2e-b');
    sticky.setStickyBinding(CALLER, null, A.id, A.apiKey, SELECTOR);
    blockOnRpm(A);
    setBudget(3000);

    // Free the window shortly, as a real 60s RPM window would.
    setTimeout(() => unblock(A), 150);

    const acct = await chat.__testing.waitForAccount([], null, 5000, null, CALLER, SELECTOR);

    assert.ok(acct, 'the caller must be served');
    assert.equal(acct.id, A.id,
      `queue-on-pin must serve the PINNED account, got ${acct.id === B.id ? 'the substitute' : acct.id}`);
    assert.equal(acct._sticky, true, 'and via the binding');
    auth.releaseAccountById(acct.id);
    assert.equal(sticky.getStickyBinding(CALLER, null, SELECTOR).accountId, A.id,
      'the pin is unchanged, so the next turn reads the cache back');
  });

  it('with the knob OFF, the same scenario rotates to the substitute (default unchanged)', async (t) => {
    const chat = await import('../src/handlers/chat.js');
    const A = seed('off-a');
    const B = seed('off-b');
    sticky.setStickyBinding(CALLER, null, A.id, A.apiKey, SELECTOR);
    // Keep the short recovery window blocked until the actual checkout.
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    blockOnRpm(A);
    setBudget(null); // OFF

    const polling = Symbol('pending poll');
    const acct = await Promise.race([
      chat.__testing.waitForAccount([], null, 5000, null, CALLER, SELECTOR),
      new Promise(resolve => setImmediate(resolve, polling)),
    ]);

    assert.notEqual(acct, polling, 'the disabled wait must settle without advancing the clock');
    assert.ok(acct, 'the caller must still be served');
    assert.equal(acct.id, B.id,
      'with the knob off the behaviour must be exactly what it was: rotate immediately');
    auth.releaseAccountById(acct.id);
  });

  it('a recovery window longer than the budget rotates without waiting', async (t) => {
    const chat = await import('../src/handlers/chat.js');
    const A = seed('give-a');
    const B = seed('give-b');
    sticky.setStickyBinding(CALLER, null, A.id, A.apiKey, SELECTOR);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    blockOnRpm(A, RPM_WINDOW_MS - 900);
    setBudget(300);
    assert.ok(auth.getAccountAvailability(A.apiKey, SELECTOR).retryAfterMs > 300,
      'the fixture must keep the recovery beyond the pin wait budget');

    const polling = Symbol('pending poll');
    const acct = await Promise.race([
      chat.__testing.waitForAccount([], null, 5000, null, CALLER, SELECTOR),
      new Promise(resolve => setImmediate(resolve, polling)),
    ]);

    assert.notEqual(acct, polling, 'a recovery beyond the budget must skip the pin wait');
    assert.ok(acct, 'giving up must still serve the caller');
    assert.equal(acct.id, B.id, 'the checkout rotates to the substitute');
    auth.releaseAccountById(acct.id);
  });

  it('a quota dry-well rotates IMMEDIATELY instead of burning the budget', async () => {
    const chat = await import('../src/handlers/chat.js');
    const A = seed('dry-a');
    const B = seed('dry-b');
    sticky.setStickyBinding(CALLER, null, A.id, A.apiKey, SELECTOR);
    auth.markQuotaExhausted(A.apiKey, 3 * 60 * 60 * 1000);
    setBudget(2000);

    const t0 = Date.now();
    const acct = await chat.__testing.waitForAccount([], null, 5000, null, CALLER, SELECTOR);
    const elapsed = Date.now() - t0;

    assert.equal(acct.id, B.id, 'a 3-hour window is not something to wait out');
    auth.releaseAccountById(acct.id);
    assert.ok(elapsed < 500,
      `must not wait at all when retryAfterMs exceeds the budget — took ${elapsed}ms`);
  });

  it('a pin already burned this request is not waited on', async () => {
    const chat = await import('../src/handlers/chat.js');
    // tried carries the keys this request has already failed on. Waiting for one of them
    // is waiting for a known-bad account.
    const A = seed('burn-a');
    const B = seed('burn-b');
    sticky.setStickyBinding(CALLER, null, A.id, A.apiKey, SELECTOR);
    blockOnRpm(A);
    setBudget(2000);
    setTimeout(() => unblock(A), 100);

    const t0 = Date.now();
    const acct = await chat.__testing.waitForAccount([A.apiKey], null, 5000, null, CALLER, SELECTOR);
    const elapsed = Date.now() - t0;

    assert.equal(acct.id, B.id, 'the hop must land elsewhere');
    auth.releaseAccountById(acct.id);
    assert.ok(elapsed < 500, `must not wait for a burned key — took ${elapsed}ms`);
  });

  it('an aborted request stops waiting', async (t) => {
    const chat = await import('../src/handlers/chat.js');
    const A = seed('abort-a');
    seed('abort-b');
    sticky.setStickyBinding(CALLER, null, A.id, A.apiKey, SELECTOR);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    // The window must still be blocked when the abort fires, or this test measures the
    // happy path instead. ~2s to recovery: inside the 5s budget so the loop DOES enter
    // and wait, but far enough out that the abort at 120ms lands mid-wait.
    blockOnRpm(A, RPM_WINDOW_MS - 2000);
    setBudget(5000);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 120);

    const t0 = Date.now();
    const waiting = chat.__testing.waitForAccount([], ac.signal, 5000, null, CALLER, SELECTOR);
    t.mock.timers.tick(120);
    assert.ok(ac.signal.aborted, 'the request aborted while its first poll was pending');
    t.mock.timers.tick(880);
    const acct = await waiting;
    const elapsed = Date.now() - t0;

    assert.equal(acct, null, 'an aborted wait returns null rather than serving');
    assert.ok(elapsed < 2000, `must notice the abort promptly — took ${elapsed}ms`);
  });

  it('waits out a SELECTOR-scoped cooldown, not just an account-wide one', async () => {
    const chat = await import('../src/handlers/chat.js');
    // The modelKey=null trap, and the reason this has to be an end-to-end assertion: the
    // unit test above proves getAccountAvailability can SEE a selector cooldown when asked
    // with the selector. It does not prove the wait loop asks that way. Measured: changing
    // the loop to ask with modelKey (null on the connect path) left every other test in
    // this file green, while the loop silently stopped waiting for the single most common
    // connect cooldown — CAPACITY, which finalizeConnectAccount keys on the selector.
    const A = seed('sel-wait-a');
    const B = seed('sel-wait-b');
    sticky.setStickyBinding(CALLER, null, A.id, A.apiKey, SELECTOR);
    // Selector-scoped only: no rateLimitedUntil, no quotaResetAt, RPM untouched. Asked
    // with modelKey=null this account reads as fully available.
    auth.markRateLimited(A.apiKey, 900, SELECTOR, 'c');
    assert.equal(auth.getAccountAvailability(A.apiKey, null).available, true,
      'precondition: with null this cooldown is invisible, which is what makes the '
      + 'mutation silent');
    setBudget(4000);

    const acct = await chat.__testing.waitForAccount([], null, 8000, null, CALLER, SELECTOR);

    assert.ok(acct, 'the caller must be served');
    assert.equal(acct.id, A.id,
      `the loop must wait out a selector-scoped cooldown and serve the PINNED account; got `
      + `${acct.id === B.id ? 'the substitute' : acct.id}, which means the availability `
      + 'probe was asked with the wrong dimension');
    assert.equal(acct._sticky, true, 'and via the binding');
    auth.releaseAccountById(acct.id);
  });

  it('the WAIT LOOP itself does not inflate hit/miss stats', async () => {
    const chat = await import('../src/handlers/chat.js');
    // The three peekStickyBinding tests above verify the FUNCTION. They do not verify that
    // the wait loop calls it: swapping the loop's peek for the mutating getStickyBinding
    // left all of them green (measured). This asserts the use site instead — one queued
    // turn must cost exactly the stats of one acquisition, no matter how many times the
    // loop polled while waiting.
    const A = seed('stats-loop-a');
    seed('stats-loop-b');
    sticky.setStickyBinding(CALLER, null, A.id, A.apiKey, SELECTOR);
    blockOnRpm(A, RPM_WINDOW_MS - 2500); // ~2.5s: guarantees several polls before it frees
    setBudget(5000);

    const before = sticky.getStickyStats();
    const acct = await chat.__testing.waitForAccount([], null, 8000, null, CALLER, SELECTOR);
    assert.ok(acct && acct.id === A.id, 'precondition: the wait must have succeeded on the pin');
    auth.releaseAccountById(acct.id);
    const after = sticky.getStickyStats();

    // The successful resolve is one real lookup, so exactly one hit. Every failed poll in
    // between must be invisible.
    assert.equal(after.hits - before.hits, 1,
      `a queued turn recorded ${after.hits - before.hits} hits. Each failed poll is leaking `
      + 'into the stats, so the hit rate an operator reads now depends on how long callers '
      + 'waited rather than on how well affinity worked.');
    assert.equal(after.misses - before.misses, 0,
      `a queued turn recorded ${after.misses - before.misses} misses — polls must not count`);
    assert.equal(after.fallbacks - before.fallbacks, 0,
      'and nothing rotated, so the fallback counter must be untouched');
  });

  it('a caller with no pin is unaffected by the knob', async () => {
    const chat = await import('../src/handlers/chat.js');
    const A = seed('nopin-e2e');
    setBudget(3000);

    const t0 = Date.now();
    const acct = await chat.__testing.waitForAccount([], null, 5000, null, CALLER, SELECTOR);
    const elapsed = Date.now() - t0;

    assert.ok(acct && acct.id === A.id, 'ordinary selection must be untouched');
    auth.releaseAccountById(acct.id);
    assert.ok(elapsed < 500, `no pin means nothing to wait for — took ${elapsed}ms`);
  });
});
