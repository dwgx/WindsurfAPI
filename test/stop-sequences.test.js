import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStop, applyStop, StopSequenceGate } from '../src/stop-sequences.js';

describe('normalizeStop', () => {
  it('wraps a bare string', () => {
    assert.deepEqual(normalizeStop('END'), ['END']);
  });
  it('empty string → []', () => {
    assert.deepEqual(normalizeStop(''), []);
  });
  it('filters non-strings and empties from an array, caps at 4', () => {
    assert.deepEqual(normalizeStop(['a', '', null, 'b', 3, 'c', 'd', 'e']), ['a', 'b', 'c', 'd']);
  });
  it('null / undefined / object → []', () => {
    assert.deepEqual(normalizeStop(null), []);
    assert.deepEqual(normalizeStop(undefined), []);
    assert.deepEqual(normalizeStop({}), []);
  });
});

describe('applyStop (non-streaming truncation)', () => {
  it('truncates at the stop sequence and drops it', () => {
    assert.deepEqual(applyStop('hello END world', 'END'), { text: 'hello ', hit: true, stop: 'END' });
  });
  it('no match → text unchanged, hit false', () => {
    assert.deepEqual(applyStop('hello world', 'END'), { text: 'hello world', hit: false, stop: null });
  });
  it('earliest of several sequences wins', () => {
    assert.deepEqual(applyStop('aXbYc', ['Y', 'X']), { text: 'a', hit: true, stop: 'X' });
  });
  it('a tie is won by the earlier entry in the caller list', () => {
    // 'XY' and 'X' both start at index 2; the first declared sequence wins.
    assert.deepEqual(applyStop('abXYc', ['XY', 'X']), { text: 'ab', hit: true, stop: 'XY' });
  });
  it('no stop configured → passthrough', () => {
    assert.deepEqual(applyStop('anything', null), { text: 'anything', hit: false, stop: null });
    assert.deepEqual(applyStop('anything', []), { text: 'anything', hit: false, stop: null });
  });
  it('empty text is safe', () => {
    assert.deepEqual(applyStop('', 'END'), { text: '', hit: false, stop: null });
  });
  it('stop at the very start → empty output, hit', () => {
    assert.deepEqual(applyStop('ENDrest', 'END'), { text: '', hit: true, stop: 'END' });
  });
});

describe('StopSequenceGate (streaming)', () => {
  it('inactive gate passes everything through', () => {
    const g = new StopSequenceGate(null);
    assert.equal(g.active, false);
    assert.deepEqual(g.push('abc'), { emit: 'abc', hit: false });
    assert.equal(g.flush(), '');
  });

  it('holds a tail that could start a stop sequence, then releases on flush', () => {
    const g = new StopSequenceGate('END');   // maxLen 3 → hold up to 2 chars
    // "hello" → safe to emit all but the last 2 chars.
    assert.deepEqual(g.push('hello'), { emit: 'hel', hit: false });
    // No stop; end of stream releases the held "lo".
    assert.equal(g.flush(), 'lo');
  });

  it('catches a stop sequence split across two chunks', () => {
    const g = new StopSequenceGate('STOP');   // maxLen 4 → hold 3
    // "abcST" → holds "cST" (could be start of STOP); emits "ab".
    let r = g.push('abcST');
    assert.equal(r.hit, false);
    assert.equal(r.emit, 'ab');
    assert.equal(g.matched, null, 'no cause before a hit');
    // next chunk "OPxyz" completes "STOP" → emit the prefix "c", hit=true.
    r = g.push('OPxyz');
    assert.equal(r.hit, true);
    assert.equal(r.emit, 'c');
    assert.equal(g.matched, 'STOP', 'the winning sequence is retained for the caller');
    // after a hit, nothing more escapes.
    assert.deepEqual(g.push('more'), { emit: '', hit: false });
    assert.equal(g.flush(), '');
  });

  it('retains the earliest-position winner when two sequences are present', () => {
    const g = new StopSequenceGate(['SECOND', 'FIRST']);
    const r = g.push('aFIRSTbSECOND');
    assert.equal(r.hit, true);
    assert.equal(r.emit, 'a');
    assert.equal(g.matched, 'FIRST');
  });

  it('emits the prefix before an in-chunk stop and suppresses the rest', () => {
    const g = new StopSequenceGate('\n\n');
    const r = g.push('answer here\n\nleaked tail');
    assert.equal(r.hit, true);
    assert.equal(r.emit, 'answer here');
  });

  it('reassembles a long safe stream without dropping chars (streaming == non-streaming)', () => {
    const g = new StopSequenceGate('QQ');
    let out = '';
    for (const ch of 'the quick brown fox') {
      const { emit } = g.push(ch);
      out += emit;
    }
    out += g.flush();
    assert.equal(out, 'the quick brown fox');
  });
});

// Per-sequence length cap — pinned numerically here (1024); the same bound is
// declared as MAX_STOP_SEQUENCE_CHARS in src/stop-sequences.js. A longer entry
// is DROPPED (never truncated): a truncated sequence could match where the
// caller's full sequence never would, which is a wrong truncation; a dropped
// one can only fail open, i.e. behave as if it were absent.
const STOP_CAP = 1024;

describe('per-sequence length cap', () => {
  it('drops an over-long bare-string sequence instead of truncating it', () => {
    const huge = 'x'.repeat(STOP_CAP + 1);
    assert.deepEqual(normalizeStop(huge), []);
  });

  it('keeps a sequence exactly at the cap', () => {
    const edge = 'y'.repeat(STOP_CAP);
    assert.deepEqual(normalizeStop(edge), [edge]);
  });

  it('drops only the over-long entries in an array', () => {
    const huge = 'x'.repeat(STOP_CAP + 1);
    assert.deepEqual(normalizeStop(['END', huge, 'STOP']), ['END', 'STOP']);
  });

  it('an over-long stop leaves the gate inactive — passthrough, no invented match', () => {
    const g = new StopSequenceGate('x'.repeat(STOP_CAP + 1));
    assert.equal(g.active, false);
    assert.deepEqual(g.push('x'.repeat(2000)), { emit: 'x'.repeat(2000), hit: false });
    assert.equal(g.flush(), '');
  });

  it('a dropped sequence is never enforced by applyStop either', () => {
    const huge = 'END' + 'x'.repeat(STOP_CAP); // 1027 chars > cap
    const text = `text ${huge} tail`;
    const r = applyStop(text, huge);
    assert.equal(r.hit, false);
    assert.equal(r.text, text);
  });

  it('a capped gate can still enforce the remaining under-cap sequences', () => {
    const g = new StopSequenceGate(['x'.repeat(STOP_CAP + 1), 'STOP']);
    const r = g.push('abcSTOPtail');
    assert.equal(r.hit, true);
    assert.equal(r.emit, 'abc');
    assert.equal(g.matched, 'STOP');
  });
});
