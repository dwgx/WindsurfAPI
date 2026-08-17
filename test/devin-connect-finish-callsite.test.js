// The finish EVENT, not the pure functions behind it.
//
// Handoff item 5: normalizeConnectUsage and the finish-reason resolution both had
// unit tests, but nothing asserted that the terminal `finish` event actually calls
// them. A bug could be reinstated at the call site — yielding the raw upstream
// usage, or the bare enum map — and the whole suite would stay green, because every
// existing test either drives the pure function directly or ignores the finish
// payload. These tests drive a real streamChat() over a mock transport and assert
// on what the event carries, which is the only thing the four protocol handlers
// ever see.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { streamChat, __setRequestImpl, normalizeConnectUsage } from '../src/devin-connect.js';
import {
  writeStringField, writeVarintField, writeMessageField, writeFixed64Field,
} from '../src/proto.js';
import { wrapEnvelope, endOfStreamEnvelope } from '../src/connect.js';

const TOKEN = 'devin-session-token$test.jwt.sig';

// Metadata sub-message (#7) tags, per the calibrated layout: #2 fresh prompt
// tokens, #3 completion tokens, #4 cache_write, #5 cache_read.
function metaFrame({ prompt, completion, cacheRead, cacheWrite }) {
  const parts = [];
  if (prompt != null) parts.push(writeVarintField(2, prompt));
  if (completion != null) parts.push(writeVarintField(3, completion));
  if (cacheWrite != null) parts.push(writeVarintField(4, cacheWrite));
  if (cacheRead != null) parts.push(writeVarintField(5, cacheRead));
  return writeMessageField(7, Buffer.concat(parts));
}

function mockTransport(framePayloads) {
  return (_opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      setImmediate(() => {
        for (const p of framePayloads) res.emit('data', wrapEnvelope(p, { compress: false }));
        res.emit('data', endOfStreamEnvelope());
        res.emit('end');
      });
      cb(res);
    };
    return req;
  };
}

async function finishEventFrom(framePayloads, { completion, env } = {}) {
  __setRequestImpl(mockTransport(framePayloads));
  let finish = null;
  for await (const ev of streamChat({
    messages: [{ role: 'user', content: 'hi' }],
    model: 'claude-sonnet-4.6',
    token: TOKEN,
    ...(completion ? { completion } : {}),
    env: { DEVIN_CONNECT_TOKEN: TOKEN, ...(env || {}) },
  })) {
    if (ev.type === 'finish') finish = ev;
  }
  return finish;
}

afterEach(() => __setRequestImpl(null));

describe('the finish event calls normalizeConnectUsage (call-site guard)', () => {
  it('yields NORMALIZED usage, never the raw upstream counters', async () => {
    // The live-reproduced bug this guards: on a cache-hit turn the upstream sends a
    // tiny fresh-input figure (3) alongside a large cache_read (1765). Passing that
    // through raw emitted cached_tokens > prompt_tokens — a subset field larger than
    // its superset — and under-reported total_tokens by ~91%. Every billing relay in
    // front of this proxy meters from exactly these numbers.
    const finish = await finishEventFrom([
      Buffer.concat([
        writeStringField(3, 'ok'),
        writeVarintField(5, 2),
        metaFrame({ prompt: 3, completion: 155, cacheRead: 1765, cacheWrite: 40 }),
      ]),
    ]);
    assert.ok(finish, 'the stream must reach its terminal finish event');

    // Compare against the production normalizer applied to the decoded upstream
    // shape — not a re-derivation of the arithmetic here, which would pass even if
    // production degraded (a mirror test is not a test).
    assert.deepEqual(finish.usage, normalizeConnectUsage({
      prompt: 3, completion: 155, cache_read_tokens: 1765, cache_write_tokens: 40,
    }));

    // And the invariant that made it a billing bug, asserted directly.
    const cached = finish.usage.prompt_tokens_details.cached_tokens;
    assert.ok(cached <= finish.usage.prompt_tokens,
      `cached_tokens (${cached}) must be a SUBSET of prompt_tokens (${finish.usage.prompt_tokens})`);
    assert.equal(finish.usage.prompt_tokens, 1768, 'prompt_tokens must include cache_read');
  });

  it('yields null usage when the upstream sent no metadata', async () => {
    const finish = await finishEventFrom([
      Buffer.concat([writeStringField(3, 'ok'), writeVarintField(5, 2)]),
    ]);
    assert.equal(finish.usage, null, 'a missing usage block passes through as null');
  });
});

describe('the finish event preserves paid ACU billing (call-site guard)', () => {
  it('carries top-level #22 fixed64 through the default billing map', async () => {
    const acu = 0.0006735000060871243;
    const raw = Buffer.alloc(8);
    raw.writeDoubleLE(acu, 0);

    const finish = await finishEventFrom([
      Buffer.concat([
        writeStringField(3, 'ok'),
        writeVarintField(5, 2),
        metaFrame({ prompt: 12, completion: 3 }),
        writeFixed64Field(22, raw),
      ]),
    ]);

    assert.ok(finish, 'the stream must reach its terminal finish event');
    assert.deepEqual(finish.billing, { committed_acu_cost: acu });
  });
});

describe('the finish event resolves truncation from usage (call-site guard)', () => {
  it('reports "length" when completion_tokens hits the cap the caller requested', async () => {
    // Nothing in the enum says "truncated" — only 2 and 4 are pinned by live
    // captures. The cap-equality check is the signal, and it has to be wired into
    // the event, not just unit-tested.
    const finish = await finishEventFrom([
      Buffer.concat([
        writeStringField(3, 'truncated here'),
        writeVarintField(5, 2),
        metaFrame({ prompt: 100, completion: 64 }),
      ]),
    ], { completion: { maxTokens: 64 } });
    assert.equal(finish.reason, 'length');
  });

  it('reports "stop" for a complete answer under the cap', async () => {
    const finish = await finishEventFrom([
      Buffer.concat([
        writeStringField(3, 'HI'),
        writeVarintField(5, 4),
        metaFrame({ prompt: 100, completion: 2 }),
      ]),
    ], { completion: { maxTokens: 300 } });
    assert.equal(finish.reason, 'stop',
      'the paid-tier shape that used to report every complete answer as truncated');
  });

  it('does NOT report "length" for the un-calibrated enum 3 on its own', async () => {
    // 3 was a name-order guess. Reaching 'length' now requires the usage signal.
    const finish = await finishEventFrom([
      Buffer.concat([
        writeStringField(3, 'complete answer'),
        writeVarintField(5, 3),
        metaFrame({ prompt: 100, completion: 20 }),
      ]),
    ], { completion: { maxTokens: 4096 } });
    assert.equal(finish.reason, 'stop');
  });

  it('honours a calibrated DEVIN_CONNECT_STOP_REASON_MAP at the call site', async () => {
    // An operator who captured the real integers must be able to restore 'length'
    // for 3 — and that override has to survive the trip through the event.
    const finish = await finishEventFrom([
      Buffer.concat([
        writeStringField(3, 'cut'),
        writeVarintField(5, 3),
        metaFrame({ prompt: 100, completion: 20 }),
      ]),
    ], { env: { DEVIN_CONNECT_STOP_REASON_MAP: '3=length' } });
    assert.equal(finish.reason, 'length');
  });
});
