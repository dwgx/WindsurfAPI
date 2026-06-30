import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import {
  bumpConnect, getConnectMetrics, resetConnectMetrics,
} from '../src/devin-connect-metrics.js';
import {
  storeCredential, getCredential, getCredHealth, resetCredHealth,
} from '../src/devin-connect-credentials.js';

const credFile = join(tmpdir(), `cred-metrics-${Math.random().toString(36).slice(2)}.json`);
const ENV = { DEVIN_CONNECT_CRED_KEY: 'master-key-for-test', DEVIN_CONNECT_CRED_FILE: credFile };

afterEach(() => {
  resetConnectMetrics();
  resetCredHealth();
  if (existsSync(credFile)) rmSync(credFile, { force: true });
});

describe('connect-metrics counters (#36)', () => {
  it('starts at zero and increments known counters', () => {
    resetConnectMetrics();
    const m0 = getConnectMetrics();
    assert.equal(m0.relogin_ok, 0);
    assert.equal(m0.failover_hops, 0);
    assert.ok(m0.uptimeMs >= 0);

    bumpConnect('relogin_ok');
    bumpConnect('relogin_ok');
    bumpConnect('failover_hops', 3);
    const m1 = getConnectMetrics();
    assert.equal(m1.relogin_ok, 2);
    assert.equal(m1.failover_hops, 3);
  });

  it('ignores unknown counter names (no crash, no key leak)', () => {
    resetConnectMetrics();
    bumpConnect('totally_made_up');
    const m = getConnectMetrics();
    assert.equal(m.totally_made_up, undefined);
  });

  it('folds credential decrypt health into the snapshot', () => {
    resetConnectMetrics();
    resetCredHealth();
    const m = getConnectMetrics();
    assert.equal(m.credDecryptFailures, 0);
    assert.equal(m.credLastDecryptError, null);
  });

  it('reset clears counters and restarts uptime', async () => {
    bumpConnect('dead_tokens', 5);
    assert.equal(getConnectMetrics().dead_tokens, 5);
    resetConnectMetrics();
    assert.equal(getConnectMetrics().dead_tokens, 0);
  });
});

describe('credential decrypt health (#37 — rotated key surfaces, not silent)', () => {
  it('a wrong/rotated master key throws AND bumps decryptFailures (fleet-wide self-heal alarm)', () => {
    resetCredHealth();
    storeCredential('ops@example.com', 'sup3r-secret', ENV);
    // Right key still works and keeps health clean.
    assert.equal(getCredential('ops@example.com', ENV), 'sup3r-secret');
    assert.equal(getCredHealth().decryptFailures, 0);

    // Rotated/typo'd key: GCM auth-tag mismatch. Must THROW (not return null,
    // which would read as "credential absent" and silently skip relogin) and
    // must register the failure so ops can alarm on it.
    const badEnv = { ...ENV, DEVIN_CONNECT_CRED_KEY: 'a-DIFFERENT-master-key' };
    assert.throws(() => getCredential('ops@example.com', badEnv));
    const h = getCredHealth();
    assert.equal(h.decryptFailures, 1);
    assert.ok(h.lastDecryptError, 'captured the decrypt error message');
  });

  it('a later successful decrypt clears a stale alarm', () => {
    resetCredHealth();
    storeCredential('ops@example.com', 'pw', ENV);
    const badEnv = { ...ENV, DEVIN_CONNECT_CRED_KEY: 'wrong' };
    assert.throws(() => getCredential('ops@example.com', badEnv));
    assert.equal(getCredHealth().decryptFailures, 1);
    // Correct key again → alarm self-clears.
    assert.equal(getCredential('ops@example.com', ENV), 'pw');
    assert.equal(getCredHealth().decryptFailures, 0);
    assert.equal(getCredHealth().lastDecryptError, null);
  });

  it('absent credential returns null WITHOUT bumping failures (distinct from wrong key)', () => {
    resetCredHealth();
    assert.equal(getCredential('nobody@example.com', ENV), null);
    assert.equal(getCredHealth().decryptFailures, 0);
  });
});
