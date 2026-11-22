// B3 (backend review 2026-11-22): writeFileSyncDurable ignored writeSync's
// returned byte count, so a legal short write published a truncated accounts
// snapshot through the atomic rename. The loop must drain the whole buffer,
// treat zero progress as failure, and leave the previous snapshot untouched
// when a write dies halfway.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSyncDurable, writeJsonAtomic } from '../src/fs-atomic.js';

describe('writeFileSyncDurable short writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wapi-shortwrite-'));

  it('drains the full buffer across consecutive short writes', () => {
    const target = join(dir, 'a.txt');
    const payload = Buffer.from('多字节 content ' + 'x'.repeat(300));
    const calls = [];
    const chunked = (fd, buf, offset, len) => {
      calls.push({ offset, len });
      return writeSync(fd, buf, offset, Math.min(len, 4));
    };
    writeFileSyncDurable(target, payload, { write: chunked });
    assert.deepEqual(readFileSync(target), payload);
    assert.ok(calls.length > 1, 'must loop over short writes');
    assert.equal(calls[0].offset, 0);
    assert.equal(calls.at(-1).offset + calls.at(-1).len, payload.length);
  });

  it('treats zero progress as an error instead of publishing a truncated file', () => {
    const target = join(dir, 'b.txt');
    const stuck = () => 0;
    assert.throws(
      () => writeFileSyncDurable(target, 'payload', { write: stuck }),
      /no progress/,
    );
  });

  it('fails writeJsonAtomic mid-write and leaves the old snapshot parseable', () => {
    const target = join(dir, 'c.json');
    writeJsonAtomic(target, { keep: true });
    const original = readFileSync(target, 'utf8');
    let calls = 0;
    const dieHalfway = (fd, buf, offset, len) => {
      calls++;
      if (calls === 1) return writeSync(fd, buf, offset, Math.min(len, 5));
      throw new Error('injected mid-write failure');
    };
    assert.throws(
      () => writeJsonAtomic(target, { keep: false, extra: 'y'.repeat(64) }, { write: dieHalfway }),
      /injected mid-write failure/,
    );
    assert.equal(readFileSync(target, 'utf8'), original, 'rename must never publish the partial tmp');
    assert.deepEqual(JSON.parse(original), { keep: true });
  });

  it('multi-byte text survives chunk boundaries', () => {
    const target = join(dir, 'd.txt');
    const payload = '中文与 emoji 🌊 mixed ' + 'z'.repeat(64);
    const chunked = (fd, buf, offset, len) => writeSync(fd, buf, offset, Math.min(len, 3));
    writeFileSyncDurable(target, payload, { write: chunked });
    assert.equal(readFileSync(target, 'utf8'), payload);
  });

  it('cleans up on zero-progress during writeJsonAtomic', () => {
    const target = join(dir, 'e.json');
    writeJsonAtomic(target, { keep: true });
    const stuck = () => 0;
    assert.throws(
      () => writeJsonAtomic(target, { keep: false }, { write: stuck }),
      /no progress/,
    );
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { keep: true });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));
});
