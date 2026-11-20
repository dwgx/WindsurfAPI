// Generation-bound exactly-once LS leases — no-process counterexamples.
//
// Drives the REAL lease functions (beginLsUse/endLsUse,
// beginLsMaintenanceUse/endLsMaintenanceUse, acquireLsUseOrThrow) against
// synthetic pool entries seeded through the __resetLsPoolForTests seam. No LS
// process is spawned and no port is bound: a "replacement" is a pool swap,
// which is exactly what the production replacement paths (crash exit handler,
// LRU eviction, restartLsForProxy) do — delete the pool entry and the key's
// maintenance record together, then let a new generation take the port.
//
// What these tests pin:
//   - a stale release after a same-port/same-key replacement decrements the
//     OLD entry only; the replacement's hold survives (ordinary + maintenance);
//   - two same-generation holds are independent; a repeated, copied, forged,
//     or never-issued handle releases nothing and cannot go negative;
//   - failed acquisitions release none; null/undefined releases are safe;
//   - request/maintenance exclusion survives with the record-shaped counter;
//   - scheduler telemetry reads the CURRENT entry, not the stale holder.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireLsUseOrThrow,
} from '../src/client.js';
import {
  beginLsUse,
  endLsUse,
  beginLsMaintenanceUse,
  endLsMaintenanceUse,
  getLsAdmissionStatus,
  getLsMaintenanceRequests,
  __resetLsPoolForTests,
} from '../src/langserver.js';

function entryFor(key, port, generation) {
  return {
    key,
    port,
    generation,
    proxy: null,
    startedAt: Date.now(),
    lastUsedAt: Date.now(),
    activeRequests: 0,
    ready: true,
  };
}

describe('LS lease generation binding', () => {
  it('ordinary: stale A release after same-port replacement must not decrement B', () => {
    const A = entryFor('default', 42100, 'gen-A');
    __resetLsPoolForTests([A]);
    const leaseA = beginLsUse(42100);
    assert.ok(leaseA, 'acquire on a live entry returns a handle');
    assert.equal(leaseA.generation, 'gen-A');
    assert.equal(A.activeRequests, 1);

    // Crash exit deletes entry+record; the respawned LS lands on the same port.
    const B = entryFor('default', 42100, 'gen-B');
    __resetLsPoolForTests([B]);
    const leaseB = beginLsUse(42100);
    assert.ok(leaseB, 'replacement acquires its own hold');
    assert.equal(leaseB.generation, 'gen-B');
    assert.equal(B.activeRequests, 1);

    endLsUse(leaseA); // stale release
    assert.equal(A.activeRequests, 0, 'the old entry counter is released');
    assert.equal(B.activeRequests, 1, 'the replacement hold must survive A');

    endLsUse(leaseB);
    assert.equal(B.activeRequests, 0, 'normal controls: B releases its own hold');
  });

  it('maintenance: stale A token released after same-key replacement must not spend B', () => {
    const A = entryFor('default', 42101, 'gen-A');
    __resetLsPoolForTests([A]);
    const tokenA = beginLsMaintenanceUse(42101);
    assert.ok(tokenA, 'maintenance acquire on an idle entry');
    assert.equal(tokenA.generation, 'gen-A');
    assert.equal(getLsMaintenanceRequests(null), 1);

    // Replacement deletes the record with the entry (crash exit / eviction /
    // restart semantics); B takes a fresh maintenance hold on the new generation.
    const B = entryFor('default', 42101, 'gen-B');
    __resetLsPoolForTests([B]);
    const tokenB = beginLsMaintenanceUse(42101);
    assert.ok(tokenB, 'the replacement can acquire maintenance');
    assert.equal(tokenB.generation, 'gen-B');

    endLsMaintenanceUse(tokenA); // stale release
    assert.equal(getLsMaintenanceRequests(null), 1, "B's hold must survive A's stale token");
    assert.equal(beginLsUse(42101), null, 'maintenance exclusion must still hold for B');

    endLsMaintenanceUse(tokenB);
    assert.equal(getLsMaintenanceRequests(null), 0);
    assert.ok(beginLsUse(42101), 'requests are admitted again after the real release');
  });

  it('maintenance: stale token released before the replacement acquires must not go negative', () => {
    const A = entryFor('default', 42102, 'gen-A');
    __resetLsPoolForTests([A]);
    const tokenA = beginLsMaintenanceUse(42102);
    assert.ok(tokenA);

    __resetLsPoolForTests([entryFor('default', 42102, 'gen-B')]);
    endLsMaintenanceUse(tokenA);
    assert.equal(getLsMaintenanceRequests(null), 0, 'stale release must not create a negative residue');
    assert.ok(beginLsMaintenanceUse(42102), 'the replacement is not locked out by a stale release');
  });

  it('request holds: same-generation independence, repeats, copies, forgeries', () => {
    const E = entryFor('default', 42103, 'gen-E');
    __resetLsPoolForTests([E]);
    const h1 = beginLsUse(42103);
    const h2 = beginLsUse(42103);
    assert.ok(h1 && h2, 'two same-generation holds are independent');
    assert.equal(E.activeRequests, 2);

    endLsUse(h1);
    assert.equal(E.activeRequests, 1);
    endLsUse(h1); // repeated release
    assert.equal(E.activeRequests, 1, 'a handle releases at most once');

    endLsUse(h2);
    assert.equal(E.activeRequests, 0);
    endLsUse(h2); // repeated release must not go negative
    assert.equal(E.activeRequests, 0);

    // Forged handle: right shape, never issued.
    endLsUse({ kind: 'request', entry: E, key: 'default', port: 42103, generation: 'gen-E' });
    assert.equal(E.activeRequests, 0, 'a forged handle must not spend the live hold');

    // Shallow copy of an issued handle: unissued clone, original still owns the hold.
    const h3 = beginLsUse(42103);
    assert.equal(E.activeRequests, 1);
    endLsUse({ ...h3 });
    assert.equal(E.activeRequests, 1, 'a copied handle must not release the issued hold');
    endLsUse(h3);
    assert.equal(E.activeRequests, 0, 'the issued handle still releases exactly its own hold');
  });

  it('maintenance tokens: repeats, copies, forgeries, foreign keys', () => {
    const M = entryFor('default', 42104, 'gen-M');
    __resetLsPoolForTests([M]);
    const token = beginLsMaintenanceUse(42104);
    assert.ok(token);
    assert.equal(getLsMaintenanceRequests(null), 1);

    endLsMaintenanceUse({ ...token }); // copied token
    assert.equal(getLsMaintenanceRequests(null), 1, 'a copy must not spend the issued hold');

    endLsMaintenanceUse({ kind: 'maintenance', key: 'default', port: 42104, generation: 'gen-M' });
    assert.equal(getLsMaintenanceRequests(null), 1, 'a forged token must not spend the issued hold');

    endLsMaintenanceUse({ kind: 'maintenance', key: 'elsewhere', port: 1, generation: 'x' });
    assert.equal(getLsMaintenanceRequests(null), 1, 'a foreign-key token must not touch this key');

    endLsMaintenanceUse(token);
    assert.equal(getLsMaintenanceRequests(null), 0);
    endLsMaintenanceUse(token); // repeated release must not go negative
    assert.equal(getLsMaintenanceRequests(null), 0);
  });

  it('a request release leaves a genuine maintenance token usable', () => {
    const entry = entryFor('default', 42110, 'gen-M');
    __resetLsPoolForTests([entry]);
    const token = beginLsMaintenanceUse(entry.port);

    endLsUse(token);
    assert.equal(getLsMaintenanceRequests(null), 1);
    endLsMaintenanceUse(token);
    assert.equal(getLsMaintenanceRequests(null), 0);
  });

  it('a maintenance release leaves a genuine request handle usable', () => {
    const entry = entryFor('default', 42111, 'gen-R');
    __resetLsPoolForTests([entry]);
    const lease = beginLsUse(entry.port);

    endLsMaintenanceUse(lease);
    assert.equal(entry.activeRequests, 1);
    endLsUse(lease);
    assert.equal(entry.activeRequests, 0);
  });

  it('request release uses its issued entry after public metadata is changed', () => {
    const first = entryFor('default', 42112, 'gen-A');
    const second = entryFor('elsewhere', 42113, 'gen-B');
    __resetLsPoolForTests([first, second]);
    const firstLease = beginLsUse(first.port);
    const secondLease = beginLsUse(second.port);

    Reflect.set(firstLease, 'entry', second);
    Reflect.set(firstLease, 'key', second.key);
    endLsUse(firstLease);
    assert.equal(first.activeRequests, 0);
    assert.equal(second.activeRequests, 1);
    endLsUse(secondLease);
  });

  it('maintenance release keeps its issued target after public metadata is changed', () => {
    const first = entryFor('default', 42114, 'gen-A');
    const second = entryFor('elsewhere', 42115, 'gen-B');
    __resetLsPoolForTests([first, second]);
    const firstToken = beginLsMaintenanceUse(first.port);
    const secondToken = beginLsMaintenanceUse(second.port);

    Reflect.set(firstToken, 'entry', second);
    Reflect.set(firstToken, 'key', second.key);
    Reflect.set(firstToken, 'generation', second.generation);
    endLsMaintenanceUse(firstToken);
    assert.equal(getLsMaintenanceRequests(null), 0);
    assert.equal(beginLsUse(second.port), null, 'the second hold still excludes requests');
    endLsMaintenanceUse(secondToken);
  });

  it('a stale maintenance token cannot release a different hold with the same generation', () => {
    const first = entryFor('default', 42116, 'gen-A');
    __resetLsPoolForTests([first]);
    const firstToken = beginLsMaintenanceUse(first.port);

    const replacement = entryFor(first.key, first.port, first.generation);
    __resetLsPoolForTests([replacement]);
    const replacementToken = beginLsMaintenanceUse(replacement.port);
    endLsMaintenanceUse(firstToken);
    assert.equal(getLsMaintenanceRequests(null), 1);
    endLsMaintenanceUse(replacementToken);
    assert.equal(getLsMaintenanceRequests(null), 0);
  });

  it('failed acquires release none; releases are null-safe; port-keyed release is gone', () => {
    const busy = entryFor('default', 42105, 'gen-busy');
    __resetLsPoolForTests([busy]);
    busy.activeRequests = 2; // in-flight requests
    assert.equal(beginLsMaintenanceUse(42105), null, 'maintenance is refused while requests hold the entry');
    endLsMaintenanceUse(null);
    endLsMaintenanceUse(undefined);

    __resetLsPoolForTests([entryFor('default', 42106, 'gen-m')]);
    const token = beginLsMaintenanceUse(42106);
    assert.equal(beginLsUse(42106), null, 'requests are refused while maintenance holds the key');
    endLsMaintenanceUse(token);

    __resetLsPoolForTests([]);
    endLsUse(null);
    assert.equal(acquireLsUseOrThrow(42106), null, 'no entry: acquire returns null and holds nothing');

    const E = entryFor('default', 42107, 'gen-p');
    __resetLsPoolForTests([E]);
    const lease = beginLsUse(42107);
    assert.ok(lease);
    assert.equal(E.activeRequests, 1);
    endLsUse(42107); // legacy port-keyed release attempt
    assert.equal(E.activeRequests, 1, 'a port number must not release the issued hold');
    endLsUse(lease);
    assert.equal(E.activeRequests, 0);
  });

  it('acquireLsUseOrThrow: handle on success, typed 503 under maintenance', () => {
    const E = entryFor('default', 42109, 'gen-c');
    __resetLsPoolForTests([E]);
    const lease = acquireLsUseOrThrow(42109);
    assert.ok(lease, 'consumer acquire returns the issued handle');
    assert.equal(lease.entry, E);
    assert.equal(E.activeRequests, 1);
    endLsUse(lease);
    assert.equal(E.activeRequests, 0);

    const token = beginLsMaintenanceUse(42109);
    assert.throws(() => acquireLsUseOrThrow(42109), /maintenance/, 'maintenance busy must refuse acquisition');
    endLsMaintenanceUse(token);
    assert.equal(E.activeRequests, 0, 'the refused acquire released nothing');
  });

  it('scheduler telemetry reflects the current entry, not the stale holder', () => {
    const A = entryFor('default', 42108, 'gen-A');
    __resetLsPoolForTests([A]);
    const leaseA = beginLsUse(42108);
    const B = entryFor('default', 42108, 'gen-B');
    __resetLsPoolForTests([B]);
    const leaseB = beginLsUse(42108);
    endLsUse(leaseA);

    const adm = getLsAdmissionStatus(null);
    assert.equal(adm.activeRequests, 1, 'only the replacement hold is scheduled on');
    assert.equal(typeof adm.maintenanceRequests, 'number');
    endLsUse(leaseB);
    assert.equal(getLsAdmissionStatus(null).activeRequests, 0);
  });
});
