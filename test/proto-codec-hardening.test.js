// Protobuf codec hardening — src/proto.js.
//
// proto.js is the floor everything else stands on: every byte the upstream
// (or, on the Cascade path, the local language server) sends is parsed here
// before any handler sees it. Ten test files import it, but all of them use it
// to ENCODE or to decode well-formed frames — its behaviour on hostile input had
// no coverage at all.
//
// The invariants below are load-bearing and cheap to break by accident:
//   - a truncated or over-long varint throws instead of returning garbage
//     (a silently wrong varint becomes a wrong field number → wrong routing)
//   - a length prefix that overruns the buffer throws instead of returning a
//     short read (this is the classic parser bug that turns into a heap overread
//     in a language without bounds checks, and into silent data loss here)
//   - the parser never loops forever: `pos` strictly advances on every branch
//   - unknown/deprecated wire types (3,4,6,7) are rejected, not skipped
//   - parseFields is FLAT — it hands nested messages back as Buffers instead of
//     recursing, so a deeply nested frame cannot exhaust the stack
//
// Verified live before being written down: 18 malformed inputs (truncated
// varints, 10×0xFF overflow, absurd length prefixes, every bad wire type, a
// 400-deep nesting bomb, 16KB of random bytes) all produced controlled throws
// or clean parses, none slow, RSS bounded.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFields, decodeVarint, encodeVarint, getField, getAllFields,
  writeVarintField, writeStringField, writeFixed32Field, writeFixed64Field,
} from '../src/proto.js';

// Deterministic PRNG (mulberry32). The property cases below used Math.random(),
// which made a red run unreproducible: the corpus changed on every execution.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('decodeVarint: hostile input', () => {
  it('throws on a lone continuation byte', () => {
    assert.throws(() => decodeVarint(Buffer.from([0x80])), /Truncated varint/);
  });

  it('throws on a varint that never terminates', () => {
    assert.throws(() => decodeVarint(Buffer.from([0xFF, 0xFF, 0xFF])), /Truncated varint/);
  });

  it('throws on a varint wider than 64 bits instead of wrapping', () => {
    // 10 continuation bytes exceeds the uint64 ceiling. Wrapping here would
    // silently produce a plausible-but-wrong number.
    assert.throws(() => decodeVarint(Buffer.from(Array(10).fill(0xFF))), /Varint (overflow|exceeds uint64)/);
  });

  it('decodes a genuine 64-bit value without truncating to 32 bits', () => {
    // `>>>` in the fast path truncates to uint32; the BigInt fallback is what
    // keeps request ids / timestamps / credit counters accurate.
    const big = 0x1FFFFFFFFFFFFFn; // > 2^32, still a safe integer as Number
    const { value } = decodeVarint(encodeVarint(big));
    assert.equal(BigInt(value), big);
  });

  it('round-trips values across the 28-bit fast-path boundary', () => {
    for (const v of [0, 1, 127, 128, 0x0FFFFFFF, 0x10000000, 0xFFFFFFFF, 2 ** 40]) {
      const { value } = decodeVarint(encodeVarint(v));
      assert.equal(Number(value), v, `round-trip failed for ${v}`);
    }
  });

  it('reports the byte length it consumed so callers can advance correctly', () => {
    const buf = Buffer.concat([encodeVarint(300), Buffer.from([0xAA])]);
    const { value, length } = decodeVarint(buf);
    assert.equal(value, 300);
    assert.equal(length, 2, 'a 300 varint is 2 bytes — a wrong length desyncs the whole parse');
  });
});

describe('parseFields: bounds checking', () => {
  it('throws when a length prefix overruns the buffer', () => {
    // field 1, wire 2, advertises 100 bytes, supplies 3.
    const buf = Buffer.concat([Buffer.from([0x0A]), encodeVarint(100), Buffer.from([1, 2, 3])]);
    assert.throws(() => parseFields(buf), /truncated len-delim/);
  });

  it('throws on an absurd length prefix rather than attempting the read', () => {
    const buf = Buffer.concat([Buffer.from([0x0A]), encodeVarint(0xFFFFFFF)]);
    assert.throws(() => parseFields(buf), /truncated len-delim/);
  });

  it('throws on a truncated fixed64', () => {
    assert.throws(() => parseFields(Buffer.from([0x09, 0x01, 0x02])), /truncated fixed64/);
  });

  it('throws on a truncated fixed32', () => {
    assert.throws(() => parseFields(Buffer.from([0x0D, 0x01])), /truncated fixed32/);
  });

  it('rejects every unknown / deprecated wire type instead of skipping it', () => {
    // 3 and 4 are the deprecated group-start/end; 6 and 7 were never assigned.
    // Skipping an unknown type would desync the parse and mis-assign every
    // following field.
    for (const wt of [3, 4, 6, 7]) {
      const tag = (1 << 3) | wt;
      assert.throws(() => parseFields(Buffer.from([tag, 0x01])),
        new RegExp(`Unknown wire type ${wt}`), `wire type ${wt} must be rejected`);
    }
  });

  it('accepts a well-formed frame and preserves field order', () => {
    const buf = Buffer.concat([
      Buffer.from([0x08]), encodeVarint(7),          // field 1 varint = 7
      Buffer.from([0x12]), encodeVarint(2), Buffer.from('hi'), // field 2 = "hi"
      Buffer.from([0x08]), encodeVarint(9),          // field 1 again (repeated)
    ]);
    const f = parseFields(buf);
    assert.deepEqual(f.map(x => x.field), [1, 2, 1]);
    assert.equal(getField(f, 1).value, 7, 'getField returns the FIRST match');
    assert.equal(getAllFields(f, 1).length, 2, 'repeated fields are all retained');
    assert.equal(getField(f, 2).value.toString('utf8'), 'hi');
  });

  it('parses an empty buffer as zero fields rather than throwing', () => {
    assert.deepEqual(parseFields(Buffer.alloc(0)), []);
  });
});

describe('parseFields: cannot hang or exhaust the stack', () => {
  it('is flat — a deeply nested frame yields one Buffer, not recursion', () => {
    // 400 levels of length-delimited nesting. A recursive parser would either
    // blow the stack or spend O(n^2) copying; parseFields hands the caller a
    // subarray and lets it decide whether to descend.
    let buf = Buffer.from([0x08, 0x01]);
    for (let i = 0; i < 400; i++) {
      buf = Buffer.concat([Buffer.from([0x0A]), encodeVarint(buf.length), buf]);
    }
    const started = Date.now();
    const fields = parseFields(buf);
    assert.equal(fields.length, 1, 'only the outermost field is parsed');
    assert.equal(fields[0].wireType, 2);
    assert.ok(Date.now() - started < 1000, 'must not be quadratic');
  });

  it('terminates on 8KB of zero bytes (every field is a valid empty varint)', () => {
    const started = Date.now();
    const fields = parseFields(Buffer.alloc(8192));
    // tag 0x00 = field 0, wire 0, then a 0x00 varint → 2 bytes per field.
    assert.equal(fields.length, 4096);
    assert.ok(Date.now() - started < 1000, 'must not hang');
  });

  it('never returns without consuming input (no zero-progress loop)', () => {
    // Property check: parseFields either throws or returns a COMPLETE parse — it
    // must never stop early, and must never spin.
    //
    // 2026-11-01 (TI-FINDINGS.tsv tautology row, proto-codec-hardening, P3): this
    // case was a tautology twice over. Every assertion sat inside the `catch`, so
    // a corpus that never threw ran zero assertions — the case passed by doing
    // nothing, and would have kept passing if parseFields returned [] for every
    // input. The corpus also came from Math.random(), so a red run could not be
    // reproduced. Both are fixed: seeded PRNG, unconditional assertions, and the
    // "consumed the input" half is now proved against frames whose fields are
    // known in advance.
    const rand = mulberry32(0x5eed);
    const int = (n) => Math.floor(rand() * n);

    // (a) Hostile bytes: every input must resolve to either a parse or a
    // controlled throw. No input may be skipped silently.
    let parsed = 0, threw = 0;
    for (let i = 0; i < 200; i++) {
      const len = 1 + int(64);
      const buf = Buffer.from(Array.from({ length: len }, () => int(256)));
      let fields;
      try {
        fields = parseFields(buf);
      } catch (err) {
        assert.ok(err instanceof Error, `input #${i}: failures must be Error instances`);
        threw++;
        continue;
      }
      parsed++;
      for (const f of fields) {
        assert.ok(Number.isInteger(f.field) && f.field >= 0,
          `input #${i}: bad field number ${f.field}`);
        assert.ok([0, 1, 2, 5].includes(f.wireType),
          `input #${i}: invented wire type ${f.wireType}`);
        if (f.wireType === 1) assert.equal(f.value.length, 8, `input #${i}: fixed64 payload size`);
        if (f.wireType === 5) assert.equal(f.value.length, 4, `input #${i}: fixed32 payload size`);
      }
    }
    assert.equal(parsed + threw, 200,
      `every input must be accounted for, got ${parsed} parsed + ${threw} thrown`);

    // (b) Known frames: the parse must return EVERY field that was written (a
    // parser that returned early would report fewer), with the values that were
    // written; and cutting one byte off the end must throw. The truncation half
    // is what catches a missing length bound check: with the `pos + sz >
    // buf.length` guard gone, a length-delimited tail is handed back as a short
    // read instead of throwing.
    let truncations = 0;
    for (let i = 0; i < 200; i++) {
      const n = 1 + int(6);
      const parts = [], expected = [];
      for (let k = 0; k < n; k++) {
        const field = 1 + int(15);
        const kind = int(4);
        if (kind === 0) {
          const v = int(0x7FFFFFFF);
          parts.push(writeVarintField(field, v));
          expected.push({ field, wireType: 0, value: v });
        } else if (kind === 1) {
          const b = Buffer.from(Array.from({ length: 8 }, () => int(256)));
          parts.push(writeFixed64Field(field, b));
          expected.push({ field, wireType: 1, value: b });
        } else if (kind === 2) {
          const s = `k${int(1e6)}-${'x'.repeat(int(20))}`;
          parts.push(writeStringField(field, s));
          expected.push({ field, wireType: 2, value: Buffer.from(s, 'utf-8') });
        } else {
          const b = Buffer.from(Array.from({ length: 4 }, () => int(256)));
          parts.push(writeFixed32Field(field, b));
          expected.push({ field, wireType: 5, value: b });
        }
      }
      const frame = Buffer.concat(parts);
      const got = parseFields(frame);
      assert.equal(got.length, expected.length,
        `frame #${i}: parser consumed only part of a ${frame.length}-byte frame`);
      for (let k = 0; k < expected.length; k++) {
        const g = got[k], e = expected[k];
        assert.equal(g.field, e.field, `frame #${i} field #${k}: field number`);
        assert.equal(g.wireType, e.wireType, `frame #${i} field #${k}: wire type`);
        const same = e.wireType === 0
          ? Number(g.value) === e.value
          : Buffer.isBuffer(g.value) && Buffer.compare(g.value, e.value) === 0;
        assert.ok(same, `frame #${i} field #${k}: value did not round-trip`);
      }
      assert.throws(() => parseFields(frame.subarray(0, frame.length - 1)),
        /Truncated varint|truncated fixed|truncated len-delim/,
        `frame #${i}: a one-byte-short frame must throw, not return a short read`);
      truncations++;
    }
    assert.equal(truncations, 200);
  });
});

describe('encodeVarint: no silent corruption on large or negative values', () => {
  it('encodes a negative number as a two-complement uint64, not a truncated int32', () => {
    // `>>>` would turn -1 into 0xFFFFFFFF (5 bytes); the wire format requires
    // the full 10-byte uint64 form.
    const bytes = encodeVarint(-1);
    assert.equal(bytes.length, 10, `-1 must encode as 10 bytes, got ${bytes.length}`);
    // Round-trips as the unsigned form (what the wire actually carries), and
    // reinterpreting it as a signed 64-bit int must give the original value back.
    const { value } = decodeVarint(bytes);
    assert.equal(String(value), '18446744073709551615', 'must be the full uint64 form');
    assert.equal(BigInt.asIntN(64, BigInt(value)), -1n, 'must reinterpret back to -1');
  });

  it('round-trips other negative values through the same two-complement path', () => {
    for (const v of [-42, -1000, -(2 ** 31)]) {
      const { value } = decodeVarint(encodeVarint(v));
      assert.equal(BigInt.asIntN(64, BigInt(value)), BigInt(v), `failed for ${v}`);
    }
  });

  it('encodes values above 2^31 without truncation', () => {
    for (const v of [0x80000000, 0xFFFFFFFF, 2 ** 40]) {
      assert.equal(Number(decodeVarint(encodeVarint(v)).value), v);
    }
  });

  it('accepts BigInt input', () => {
    const v = 12345678901234567n;
    assert.equal(BigInt(decodeVarint(encodeVarint(v)).value), v);
  });
});

describe('S4-D1: non-canonical varints above uint64 are rejected', () => {
  it('a terminating 10th byte that overflows uint64 throws instead of decoding ~2**70', () => {
    // 9 continuation bytes (0x80) then 0x7F: bits 63..69 set, no continuation —
    // the old code returned the oversized BigInt silently.
    assert.throws(() => decodeVarint(Buffer.from([0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x7F])),
      /uint64|overflow/i);
    // Boundary controls: max legal uint64 (10th byte = 0x01) still decodes.
    const max = decodeVarint(Buffer.from([0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0x01]));
    assert.equal(max.value, BigInt('0xFFFFFFFFFFFFFFFF'));
  });
});
