import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordRequest, updateRequest, listRequests, requestRingStats, __resetRequestRingForTest,
} from '../src/dashboard/request-ring.js';

beforeEach(() => __resetRequestRingForTest());

describe('dashboard request ring', () => {
  it('returns newest first with a bounded page', () => {
    recordRequest({ id: 'r1', ts: 100, model: 'a', status: 200, durationMs: 1, caller: 'secret-1' });
    recordRequest({ id: 'r2', ts: 200, model: 'b', status: 500, durationMs: 2, caller: 'secret-2' });
    recordRequest({ id: 'r3', ts: 300, model: 'a', status: 200, durationMs: 3, caller: 'secret-3' });

    const page = listRequests({ limit: 2 });
    assert.deepEqual(page.items.map((r) => r.id), ['r3', 'r2']);
    assert.equal(page.total, 3);
    assert.ok(page.nextCursor);
  });

  it('filters by model, status and class without leaking the caller', () => {
    recordRequest({ id: 'r1', ts: 100, model: 'a', status: 200, class: 'ok', caller: 'raw-key-1' });
    recordRequest({ id: 'r2', ts: 200, model: 'b', status: 429, class: 'rate_limit', caller: 'raw-key-2' });

    const a = listRequests({ filter: { model: 'a' } });
    assert.deepEqual(a.items.map((r) => r.id), ['r1']);
    const rl = listRequests({ filter: { status: '429' } });
    assert.deepEqual(rl.items.map((r) => r.id), ['r2']);
    assert.equal(rl.items[0].caller.length, 8);
    assert.notEqual(rl.items[0].caller, 'raw-key-2');
  });

  it('paginates with an opaque cursor and reports ring stats', () => {
    recordRequest({ id: 'r1', ts: 100, model: 'a', status: 200 });
    recordRequest({ id: 'r2', ts: 200, model: 'a', status: 200 });
    recordRequest({ id: 'r3', ts: 300, model: 'a', status: 200 });

    const first = listRequests({ limit: 2 });
    const second = listRequests({ limit: 2, cursor: first.nextCursor });
    assert.deepEqual(first.items.map((r) => r.id), ['r3', 'r2']);
    assert.deepEqual(second.items.map((r) => r.id), ['r1']);
    assert.equal(second.nextCursor, null);
    assert.deepEqual(requestRingStats(), { total: 3, capacity: 2000 });
  });

  it('patches a streaming row in place without adding a second row', () => {
    const row = recordRequest({ id: 'r1', ts: 100, model: 'a', status: 200, durationMs: 45, stream: true });
    const updated = updateRequest(row.id, { durationMs: 1956, class: 'ok' });
    assert.equal(updated.durationMs, 1956);
    assert.equal(updated.class, 'ok');
    assert.equal(listRequests({}).total, 1);
    assert.equal(updateRequest('missing', { durationMs: 1 }), null);
  });

  it('drops unknown fields and coerces invalid values', () => {
    const row = recordRequest({ id: 'r1', ts: 'nope', model: 42, status: '200', durationMs: -5, body: 'secret' });
    assert.equal(row.model, null);
    assert.equal(row.status, null);
    assert.equal(row.durationMs, 0);
    assert.equal('body' in row, false);
  });

  it('resumes in recording order when completion timestamps are out of order', () => {
    // Concurrent completions can finish out of timestamp order. Recording order
    // is the only stable newest-first order the ring promises.
    recordRequest({ id: 'req_late', ts: 900 });
    recordRequest({ id: 'req_early', ts: 100 });
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = listRequests({ cursor, limit: 1 });
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
      if (++pages > 20) assert.fail('pagination did not terminate');
    } while (cursor);
    assert.deepEqual(seen, ['req_early', 'req_late']);
  });

  it('pages same-millisecond rows with unordered server ids exactly once', () => {
    const ts = 1_700_000_000_000;
    // Server ids are `req_<uuid>`: random, so lexicographic order is arbitrary.
    for (const id of ['req_z9', 'req_a1', 'req_m5']) recordRequest({ id, ts, model: 'm', status: 200 });
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = listRequests({ cursor, limit: 1 });
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
      if (++pages > 20) assert.fail('pagination did not terminate');
    } while (cursor);
    assert.deepEqual(seen, ['req_m5', 'req_a1', 'req_z9']);
  });

  it('keeps a stable page boundary when a row arrives between pages', () => {
    const ts = 1_700_000_000_500;
    recordRequest({ id: 'req_c', ts });
    recordRequest({ id: 'req_a', ts });
    const first = listRequests({ limit: 1 });
    assert.deepEqual(first.items.map((r) => r.id), ['req_a']);
    recordRequest({ id: 'req_b', ts });
    const second = listRequests({ limit: 1, cursor: first.nextCursor });
    assert.deepEqual(second.items.map((r) => r.id), ['req_c']);
    const third = listRequests({ limit: 1, cursor: second.nextCursor });
    assert.deepEqual(third.items, []);
  });

  it('pages a wrapped ring without duplicates or new rows reappearing', () => {
    const ts = 1_700_000_001_000;
    for (let i = 0; i < 2000; i++) recordRequest({ id: `req_old_${i}`, ts, model: 'm', status: 200 });
    const first = listRequests({ limit: 500 });
    const seen = first.items.map((r) => r.id);
    for (let i = 0; i < 10; i++) recordRequest({ id: `req_new_${i}`, ts, model: 'm', status: 200 });
    let cursor = first.nextCursor;
    let pages = 0;
    while (cursor) {
      if (++pages > 20) assert.fail('pagination did not terminate');
      const page = listRequests({ limit: 500, cursor });
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
    }
    const expected = [];
    for (let i = 1999; i >= 10; i--) expected.push(`req_old_${i}`);
    assert.deepEqual(seen, expected);
    assert.equal(seen.some((id) => id.startsWith('req_new_')), false);
    assert.equal(new Set(seen).size, seen.length);
  });

  it('accepts legacy ts:id cursors for rows still in the ring', () => {
    recordRequest({ id: 'r1', ts: 100 });
    recordRequest({ id: 'r2', ts: 200 });
    recordRequest({ id: 'r3', ts: 300 });
    const legacy = Buffer.from('200:r2', 'utf8').toString('base64url');
    const page = listRequests({ cursor: legacy, limit: 5 });
    assert.deepEqual(page.items.map((r) => r.id), ['r1']);
  });

  it('keeps filtered pagination in recording order', () => {
    const ts = 1_700_000_002_000;
    recordRequest({ id: 'req_1', ts, model: 'x' });
    recordRequest({ id: 'req_2', ts, model: 'y' });
    recordRequest({ id: 'req_3', ts, model: 'x' });
    recordRequest({ id: 'req_4', ts, model: 'x' });
    const first = listRequests({ limit: 1, filter: { model: 'x' } });
    const second = listRequests({ limit: 1, cursor: first.nextCursor, filter: { model: 'x' } });
    const third = listRequests({ limit: 1, cursor: second.nextCursor, filter: { model: 'x' } });
    assert.deepEqual([...first.items, ...second.items, ...third.items].map((r) => r.id), ['req_4', 'req_3', 'req_1']);
  });

  it('keeps the public row shape unchanged', () => {
    recordRequest({ id: 'r1', ts: 100, model: 'a', status: 200 });
    assert.deepEqual(Object.keys(listRequests({}).items[0]).sort(), [
      'caller', 'class', 'durationMs', 'id', 'model', 'protocol', 'selector', 'status', 'stream', 'ts',
    ]);
  });

  it('treats a cursor from another ring instance as expired, not as a first page', () => {
    recordRequest({ id: 'req_old_1', ts: 100 });
    recordRequest({ id: 'req_old_2', ts: 100 });
    const cursor = listRequests({ limit: 1 }).nextCursor;
    assert.ok(cursor);

    __resetRequestRingForTest(); // models a restart or a second process
    recordRequest({ id: 'req_new_1', ts: 200 });
    recordRequest({ id: 'req_new_2', ts: 200 });

    const page = listRequests({ cursor, limit: 3 });
    assert.deepEqual(page.items, []);
    assert.equal(page.nextCursor, null);
    assert.equal(page.total, 2);
  });

  it('does not replay a pre-identity s: cursor against unrelated rows', () => {
    recordRequest({ id: 'req_1', ts: 100 });
    recordRequest({ id: 'req_2', ts: 200 });
    const bare = Buffer.from('s:1', 'utf8').toString('base64url');
    assert.deepEqual(listRequests({ cursor: bare }).items, []);
  });

  it('returns empty for a legacy cursor whose anchor was evicted', () => {
    const ts = 1_700_000_003_000;
    recordRequest({ id: 'req_zulu', ts });
    const legacy = Buffer.from(`${ts}:req_zulu`, 'utf8').toString('base64url');
    for (let i = 0; i < 2000; i++) recordRequest({ id: `req_aa${i}`, ts });

    const page = listRequests({ cursor: legacy, limit: 2 });
    assert.deepEqual(page.items, []);
    assert.equal(page.nextCursor, null);
    assert.equal(page.total, 2000);
  });

  it('falls back to the first page for a malformed cursor', () => {
    recordRequest({ id: 'r1', ts: 100 });
    assert.deepEqual(listRequests({ cursor: 'not-a-cursor' }).items.map((r) => r.id), ['r1']);
    assert.deepEqual(listRequests({ cursor: '' }).items.map((r) => r.id), ['r1']);
  });

  it('keeps cursors stable for duplicate unordered ids', () => {
    const ts = 1_700_000_004_000;
    const a = recordRequest({ id: 'dup', ts });
    const b = recordRequest({ id: 'dup', ts });
    const c = recordRequest({ id: 'dup', ts });

    const first = listRequests({ limit: 2 });
    const second = listRequests({ limit: 2, cursor: first.nextCursor });
    assert.deepEqual(first.items, [c, b]);
    assert.deepEqual(second.items, [a]);
    assert.equal(second.nextCursor, null);
  });
});
