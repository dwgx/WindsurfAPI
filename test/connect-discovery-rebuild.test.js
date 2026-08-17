// #234 / #231-in-the-connect-namespace — /v1/models must agree with what chat
// can actually run.
//
// Two defects, one symptom:
//
//   1. Existence was the ONLY test, so a free-only pool advertised every paid
//      selector the upstream publishes. The client picked one and got a 403 at
//      chat. #232 fixed this for the Cascade namespace, but its filters
//      early-return unfiltered when devinConnect is on (a correct namespace
//      boundary), so the check had to be redone here.
//
//   2. The connect live catalog latched after the FIRST account synced and never
//      refreshed, so adding a paid account to a free pool never widened discovery.
//
// The critical trap, and why this is a REBUILD rather than a filter: entitlement
// filtering alone takes a free-only pool to zero rows, and zero rows is worse than
// over-advertising — Codex and Cline refuse to start against an empty model list.
// The free-reachable selector is in NEITHER row source (absent from the frozen
// snapshot, absent from all live catalog rows, no MODELS entry) yet chat routes it,
// so discovery has to synthesize it.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount, getAccountInternal, getAccountCount,
} from '../src/auth.js';
import { handleModels } from '../src/handlers/models.js';
import {
  setLiveCatalogSelectors, clearLiveCatalogSelectors, __testing,
} from '../src/devin-connect-models.js';

const FREE_SELECTOR = 'swe-1-6-slow';
const created = [];
// Set when a test populates the live catalog, so afterEach can restore the
// process-wide resolver state instead of leaking it into later files.
let liveCatalogDirty = false;
const SAVED = {};
const ENV_KEYS = ['DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY'];
for (const k of ENV_KEYS) SAVED[k] = process.env[k];

function mk(tier) {
  const a = addAccountByKey('sk-disc-' + Math.random().toString(36).slice(2, 12), 'disc');
  const acct = getAccountInternal(a.id);
  acct.status = 'active';
  acct.tier = tier;
  created.push(a.id);
  return acct;
}

function ids(env = process.env) {
  return handleModels(env).data.map((m) => m.id);
}

function connectEnv() {
  process.env.DEVIN_CONNECT = '1';
  delete process.env.DEVIN_CONNECT_TOKEN;
  delete process.env.WINDSURF_API_KEY;
}

afterEach(() => {
  while (created.length) removeAccount(created.pop());
  if (liveCatalogDirty) {
    clearLiveCatalogSelectors();
    liveCatalogDirty = false;
  }
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe('connect discovery — entitlement filter (#234)', () => {
  it('does not advertise paid selectors to a free-only pool', () => {
    connectEnv();
    mk('free');

    const rows = ids();
    assert.ok(!rows.includes('claude-opus-4-8-medium'),
      'a free-only pool must not advertise a paid selector it will 403 on');
    assert.ok(!rows.includes('claude-4-sonnet'));
  });

  it('never returns an empty list to a free-only pool', () => {
    // The regression that makes filtering-without-rebuilding worse than the bug:
    // an empty /v1/models makes Codex and Cline refuse to start.
    connectEnv();
    mk('free');

    const rows = ids();
    assert.ok(rows.length > 0, 'zero models breaks client startup entirely');
    assert.ok(rows.includes(FREE_SELECTOR),
      'the one selector any account can run must be discoverable');
  });

  it('widens discovery when a paid account joins the pool', () => {
    connectEnv();
    mk('free');
    const freeOnly = ids();

    mk('pro');
    const withPaid = ids();

    assert.ok(withPaid.length > freeOnly.length,
      `adding a paid account must widen discovery (was ${freeOnly.length}, now ${withPaid.length})`);
    assert.ok(withPaid.includes(FREE_SELECTOR), 'the free selector stays listed');
  });

  it('treats a non-empty live catalog as authoritative over the frozen snapshot', () => {
    connectEnv();
    mk('pro');
    setLiveCatalogSelectors([
      { selector: 'claude-opus-4-8-medium', provider: 'anthropic' },
    ]);
    liveCatalogDirty = true;

    const rows = ids();
    assert.ok(rows.includes('claude-opus-4-8-medium'),
      'the selector confirmed by the live catalog must be advertised');
    assert.ok(!rows.includes('gpt-5.5'),
      'a snapshot-only model must not be advertised after a successful live sync');
    assert.ok(rows.includes(FREE_SELECTOR), 'the universal free floor stays advertised');
  });

  it('does not log paid-request downgrade warnings while building discovery', () => {
    connectEnv();
    mk('pro');
    setLiveCatalogSelectors([
      { selector: 'claude-opus-4-8-medium', provider: 'anthropic' },
    ]);
    liveCatalogDirty = true;
    __testing.degradeWarned.clear();

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
      ids();
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(
      warnings.filter((line) => line.includes('paid request downgraded to free tier')),
      [],
      'GET /v1/models is a read-only catalog probe, not a paid request',
    );
  });

  it('fails open on an empty pool instead of returning nothing', () => {
    // hasConnectEntitledAccount is Array.some over the pool, so it returns false
    // for EVERY selector when the pool is empty. Filtering without this arm would
    // strip all rows from a deployment that has not added accounts yet.
    connectEnv();
    assert.equal(getAccountCount().total, 0, 'precondition: empty pool');

    const rows = ids();
    assert.ok(rows.length > 1,
      'an empty pool has nothing to filter against, so discovery must fail open');
    assert.ok(rows.includes('claude-opus-4-8-medium'),
      'fail-open means the full connect view, not just the free floor');
  });

  it('exempts an env-token deployment regardless of pool contents', () => {
    // Mirrors the chat path exemption, which checks only that the env token is
    // SET and does not look at pool size. A token + free-account mixed deployment
    // would otherwise advertise a narrow list while chat serves paid selectors.
    connectEnv();
    mk('free');
    const withoutToken = ids();

    process.env.DEVIN_CONNECT_TOKEN = 'env-token-for-test';
    const withToken = ids();

    assert.ok(withToken.length > withoutToken.length,
      'an env token must exempt discovery from pool-based entitlement filtering');
    assert.ok(withToken.includes('claude-opus-4-8-medium'));
  });

  it('applies the filter to the live_catalog producer, not just listModels', () => {
    // handleModels has TWO row producers: the listModels filter and a live_catalog
    // synthesis loop that builds its own rows. Filtering only the first left a
    // free-only pool still advertising every live-only paid selector.
    //
    // The live catalog MUST be populated for this to test anything — it is empty in
    // a fresh process, so without this setup the loop emits nothing and the
    // assertion passes no matter what. (Verified: removing the producer-2 filter
    // did not fail an earlier version of this test for exactly that reason.)
    connectEnv();
    mk('free');

    const LIVE_ONLY_PAID = 'gpt-5-6-sol-max';
    const LIVE_ONLY_FREE = 'swe-1-6-slow';
    setLiveCatalogSelectors([
      { selector: LIVE_ONLY_PAID, provider: 'openai' },
      { selector: LIVE_ONLY_FREE, provider: 'windsurf' },
    ]);
    liveCatalogDirty = true;

    const rows = handleModels(process.env).data;
    const emitted = rows.map((m) => m.id);

    assert.ok(emitted.includes(LIVE_ONLY_FREE),
      'precondition: the live catalog is populated and its free selector is emitted');
    assert.ok(!emitted.includes(LIVE_ONLY_PAID),
      'the live_catalog producer must apply the entitlement filter too — a free-only ' +
      'pool must not advertise a live-only paid selector');
  });

  it('leaves the non-connect backend view untouched', () => {
    // The connect entitlement filter must not leak into the Cascade transport,
    // whose own catalog policy governs there.
    process.env.DEVIN_CONNECT = '0';
    mk('free');

    const rows = ids({ ...process.env, DEVIN_CONNECT: '0' });
    assert.ok(!rows.includes(FREE_SELECTOR),
      'the connect free floor must not appear on the Cascade transport');
  });
});
