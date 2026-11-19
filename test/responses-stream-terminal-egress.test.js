// A streamed Responses turn is committed to the response store only after the
// TERMINAL event's egress has settled. The terminal `response.completed` /
// `response.incomplete` frame is written by `translator.finish()` inside
// `captureRes.end()`, which the Chat handler calls immediately before it returns.
// If that write reports backpressure, the socket has NOT taken the frame yet:
// committing at that moment stores a turn the caller may never receive, and a
// close / error / drain timeout during the wait used to leave both the stored
// record and a late `[DONE]` attempt on a dead socket.
//
// The contract exercised here drives the REAL handler (`handleResponses` ->
// Chat handler seam -> captureRes -> ResponsesStreamTranslator -> writer) against
// a response sink the test owns. Only the upstream Chat producer is scripted.
//
// Distinction that must survive the fix: a genuinely DELIVERED `length` /
// `content_filter` turn is still chainable (the model stopped for a reason the
// client saw). Only a delivery that was aborted — close, error, drain timeout —
// is withheld.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handleResponses } from '../src/handlers/responses.js';
import * as store from '../src/response-store.js';

const CALLER = 'api:terminal-egress:user:u1';
const MODEL = 'claude-sonnet-4.6';

const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;

/**
 * A response sink the test fully controls. `falseAt` (1-based) is the write whose
 * verdict is `false`; `closeOnWriteAt` / `errorOnWriteAt` fire the real-response
 * event synchronously while that write is in flight, modelling a client that
 * vanishes at exactly the terminal frame. `autoDrain` models a slow-but-alive
 * reader that takes the bytes on the next turn of the loop.
 *
 * `writesAfterClose` counts application writes that START after the closure was
 * latched — the "zero writes after closure" contract.
 */
function controlledRes({ falseAt = 0, autoDrain = false, closeOnWriteAt = 0, errorOnWriteAt = 0 } = {}) {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headersSent = false;
  res.writableEnded = false;
  res.destroyed = false;
  res.writes = [];
  res.falseSignals = 0;
  res.writesAfterClose = 0;
  res.endCalls = 0;
  let closed = false;
  const latchClosed = () => { closed = true; res.destroyed = true; };

  res.setHeader = () => res;
  res.writeHead = () => res;
  res.flushHeaders = () => {};
  res.write = (raw) => {
    if (closed || res.destroyed) {
      res.writesAfterClose += 1;
      return false;
    }
    res.writes.push(String(raw));
    if (res.writes.length === closeOnWriteAt) {
      latchClosed();
      res.emit('close');
    }
    if (res.writes.length === errorOnWriteAt) {
      latchClosed();
      res.emit('error', Object.assign(new Error('socket write failed'), { code: 'ECONNRESET' }));
    }
    const verdict = res.writes.length !== falseAt;
    if (!verdict) {
      res.falseSignals += 1;
      if (autoDrain) setImmediate(() => res.emit('drain'));
    }
    return verdict;
  };
  res.end = (raw) => {
    if (raw) res.write(raw);
    res.writableEnded = true;
    res.endCalls += 1;
    return res;
  };
  res.closeNow = () => { latchClosed(); res.emit('close'); };
  res.errorNow = () => {
    latchClosed();
    res.emit('error', Object.assign(new Error('socket error'), { code: 'ECONNRESET' }));
  };
  return res;
}

const pump = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

async function withDeadline(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The upstream Chat producer: text deltas, a real terminal chunk, `[DONE]`, end. */
const streamThat = (chunks = ['The answer is 4'], finishReason = 'stop') => async () => ({
  status: 200,
  stream: true,
  handler: async (res) => {
    for (const text of chunks) {
      res.write(chunk({ choices: [{ delta: { content: text } }] }));
    }
    res.write(chunk({ choices: [{ delta: {}, finish_reason: finishReason }] }));
    res.write('data: [DONE]\n\n');
    res.end();
  },
});

/**
 * The same wire content, but delivered as ONE buffered chunk. The translator's
 * framer must still emit the terminal frame last and honour its verdict.
 */
const bufferedStreamThat = (chunks = ['The answer is 4'], finishReason = 'stop') => async () => ({
  status: 200,
  stream: true,
  handler: async (res) => {
    const frames = chunks.map((text) => chunk({ choices: [{ delta: { content: text } }] }));
    frames.push(chunk({ choices: [{ delta: {}, finish_reason: finishReason }] }));
    frames.push('data: [DONE]\n\n');
    res.write(frames.join(''));
    res.end();
  },
});

async function start(body, upstream) {
  const result = await handleResponses(body, {
    handleChatCompletions: upstream,
    context: { callerKey: CALLER },
  });
  assert.equal(result.status, 200, 'precondition: the Responses route accepted the request');
  assert.equal(result.stream, true);
  return result;
}

const bodyFor = (extra = {}) => ({
  model: MODEL,
  stream: true,
  store: true,
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'what is 2+2' }] }],
  ...extra,
});

const responseIdFrom = (res) => res.writes.join('').match(/"id":"(resp_[^"]+)"/)?.[1] || null;

/** 1-based index of the terminal event's write in a fully drained probe. */
function terminalWriteIndex(probe) {
  const idx = probe.writes.findIndex((w) => /^event: response\.(completed|incomplete|failed)$/m.test(w));
  assert.ok(idx >= 0, 'precondition: the probe stream emitted a terminal event');
  return idx + 1;
}

const hasDone = (res) => res.writes.some((w) => w.includes('data: [DONE]'));

beforeEach(() => store.resetResponseStore());
afterEach(() => {
  store.resetResponseStore();
  delete process.env.WINDSURFAPI_MAX_DRAIN_MS;
});

describe('Responses terminal egress: delivery settles before the store commit', () => {
  it('terminal write(false) then drain stores exactly once and writes one trailing [DONE]', async () => {
    const probeResult = await start(bodyFor(), streamThat());
    const probe = controlledRes();
    await probeResult.handler(probe);
    const terminalAt = terminalWriteIndex(probe);
    store.resetResponseStore(); // the probe turn is not part of the count below

    const result = await start(bodyFor(), streamThat());
    const res = controlledRes({ falseAt: terminalAt });
    const running = result.handler(res);
    await pump();

    const responseId = responseIdFrom(res);
    assert.ok(responseId, 'precondition: response.created reached the sink');
    assert.equal(res.falseSignals, 1, 'the terminal write must report backpressure');
    assert.equal(hasDone(res), false, 'the sentinel must not overtake a pressured terminal event');
    assert.equal(store.getResponse(responseId, CALLER).ok, false,
      'the turn must not be stored while its terminal frame is still unacknowledged');

    res.emit('drain');
    await withDeadline(running, 2000, 'handler after drain');

    const body = res.writes.join('');
    assert.equal(body.split('"type":"response.completed"').length - 1, 1, 'exactly one terminal event');
    assert.equal(body.split('data: [DONE]').length - 1, 1, 'exactly one sentinel');
    assert.ok(body.endsWith('data: [DONE]\n\n'), 'the sentinel is last');
    assert.equal(store.getResponse(responseId, CALLER).ok, true,
      'a fully delivered turn stays chainable');
    assert.equal(store.getResponseStoreStats().stored, 1, 'stored exactly once');
    assert.equal(res.writesAfterClose, 0);
  });

  it('a synchronous close while the terminal is written retains nothing and writes nothing after close', async () => {
    const probeResult = await start(bodyFor(), streamThat());
    const probe = controlledRes();
    await probeResult.handler(probe);
    const terminalAt = terminalWriteIndex(probe);

    const result = await start(bodyFor(), streamThat());
    const res = controlledRes({ falseAt: terminalAt, closeOnWriteAt: terminalAt });
    await withDeadline(result.handler(res), 2000, 'handler with a synchronous terminal close');

    const responseId = responseIdFrom(res);
    assert.ok(responseId);
    assert.equal(store.getResponse(responseId, CALLER).ok, false,
      'a client that vanished on the terminal frame never received the turn');
    assert.equal(hasDone(res), false, 'no sentinel after the client closed');
    assert.equal(res.writesAfterClose, 0, 'no application write may start after closure');
  });

  it('an asynchronous close during the terminal drain retains nothing and writes nothing after close', async () => {
    const probeResult = await start(bodyFor(), streamThat());
    const probe = controlledRes();
    await probeResult.handler(probe);
    const terminalAt = terminalWriteIndex(probe);

    const result = await start(bodyFor(), streamThat());
    const res = controlledRes({ falseAt: terminalAt });
    const running = result.handler(res);
    await pump();

    const responseId = responseIdFrom(res);
    assert.equal(res.falseSignals, 1);
    assert.equal(store.getResponse(responseId, CALLER).ok, false,
      'nothing may be stored while the terminal frame is unacknowledged');

    res.closeNow();
    await withDeadline(running, 2000, 'handler after close during terminal drain');

    assert.equal(store.getResponse(responseId, CALLER).ok, false,
      'a turn whose terminal frame was never acknowledged must not become the next turn\'s context');
    assert.equal(hasDone(res), false, 'the sentinel must not be attempted on a closed sink');
    assert.equal(res.writesAfterClose, 0, 'zero writes after closure');
  });

  it('a socket error during the terminal drain retains nothing and writes nothing after the error', async () => {
    const probeResult = await start(bodyFor(), streamThat());
    const probe = controlledRes();
    await probeResult.handler(probe);
    const terminalAt = terminalWriteIndex(probe);

    const result = await start(bodyFor(), streamThat());
    const res = controlledRes({ falseAt: terminalAt });
    const running = result.handler(res);
    await pump();

    const responseId = responseIdFrom(res);
    res.errorNow();
    await withDeadline(running, 2000, 'handler after error during terminal drain');

    assert.equal(store.getResponse(responseId, CALLER).ok, false);
    assert.equal(hasDone(res), false);
    assert.equal(res.writesAfterClose, 0, 'zero writes after the socket error');
  });

  it('a drain timeout during the terminal drain retains nothing', async () => {
    process.env.WINDSURFAPI_MAX_DRAIN_MS = '25';
    const probeResult = await start(bodyFor(), streamThat());
    const probe = controlledRes();
    await probeResult.handler(probe);
    const terminalAt = terminalWriteIndex(probe);

    const result = await start(bodyFor(), streamThat());
    const res = controlledRes({ falseAt: terminalAt });
    const running = result.handler(res);

    await pump();
    const responseId = responseIdFrom(res);
    await withDeadline(running, 2000, 'handler after the drain timeout');

    assert.equal(store.getResponse(responseId, CALLER).ok, false,
      'a half-open client never received the turn, so it must not be retained');
    assert.equal(hasDone(res), false, 'the sentinel is not written after the writer timed out');
  });

  it('a close BEFORE the terminal frame retains nothing and emits no terminal or sentinel', async () => {
    let releaseUpstream;
    const gate = new Promise((resolve) => { releaseUpstream = resolve; });
    const upstream = async () => ({
      status: 200,
      stream: true,
      handler: async (res) => {
        res.write(chunk({ choices: [{ delta: { content: 'partial' } }] }));
        await gate;
        res.write(chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
        res.write('data: [DONE]\n\n');
        res.end();
      },
    });

    const result = await start(bodyFor(), upstream);
    const res = controlledRes();
    const running = result.handler(res);
    await pump();

    const responseId = responseIdFrom(res);
    assert.ok(responseId);
    res.closeNow();
    releaseUpstream();
    await withDeadline(running, 2000, 'handler after a mid-stream close');

    assert.equal(store.getResponse(responseId, CALLER).ok, false);
    assert.equal(hasDone(res), false);
    assert.equal(res.writesAfterClose, 0, 'no terminal frame or sentinel after closure');
    assert.equal(res.writes.join('').includes('response.completed'), false,
      'a client that vanished before the terminal never gets a completed envelope');
  });

  it('a buffered upstream chunk still settles the terminal before committing', async () => {
    const probeResult = await start(bodyFor(), bufferedStreamThat());
    const probe = controlledRes();
    await probeResult.handler(probe);
    const terminalAt = terminalWriteIndex(probe);

    const result = await start(bodyFor(), bufferedStreamThat());
    const res = controlledRes({ falseAt: terminalAt });
    const running = result.handler(res);
    await pump();

    const responseId = responseIdFrom(res);
    assert.equal(res.falseSignals, 1, 'the buffered terminal must still report backpressure');
    assert.equal(store.getResponse(responseId, CALLER).ok, false,
      'buffering the upstream frames must not bypass the terminal-egress gate');

    res.closeNow();
    await withDeadline(running, 2000, 'buffered handler after close');

    assert.equal(store.getResponse(responseId, CALLER).ok, false);
    assert.equal(res.writesAfterClose, 0);
    assert.equal(hasDone(res), false);
  });
});

describe('Responses terminal egress: delivered truncation stays chainable', () => {
  for (const [finishReason, expectedReason] of [
    ['length', 'max_output_tokens'],
    ['content_filter', 'content_filter'],
  ]) {
    it(`a DELIVERED finish_reason=${finishReason} turn is stored after its pressured terminal drains`, async () => {
      const probeResult = await start(bodyFor(), streamThat(['cut off'], finishReason));
      const probe = controlledRes();
      await probeResult.handler(probe);
      const terminalAt = terminalWriteIndex(probe);

      const result = await start(bodyFor(), streamThat(['cut off'], finishReason));
      const res = controlledRes({ falseAt: terminalAt });
      const running = result.handler(res);
      await pump();

      const responseId = responseIdFrom(res);
      assert.equal(res.falseSignals, 1);
      assert.equal(store.getResponse(responseId, CALLER).ok, false,
        'a delivered truncation must not be stored before its terminal egress settles');

      res.emit('drain');
      await withDeadline(running, 2000, `handler after drain (${finishReason})`);

      const stored = store.getResponse(responseId, CALLER);
      assert.equal(stored.ok, true,
        'a genuine length/content_filter turn the client received is still chainable');
      assert.equal(stored.status, 'incomplete');
      assert.equal(stored.incompleteReason, expectedReason);
      assert.equal(res.writes.join('').split('data: [DONE]').length - 1, 1,
        'the sentinel still follows the delivered terminal');
    });
  }
});

describe('Responses terminal egress: store:false stays unretained', () => {
  it('a delivered turn with store:false writes the sentinel but retains nothing', async () => {
    const probeResult = await start(bodyFor({ store: false }), streamThat());
    const probe = controlledRes();
    await probeResult.handler(probe);
    const terminalAt = terminalWriteIndex(probe);

    const result = await start(bodyFor({ store: false }), streamThat());
    const res = controlledRes({ falseAt: terminalAt });
    const running = result.handler(res);
    await pump();

    const responseId = responseIdFrom(res);
    res.emit('drain');
    await withDeadline(running, 2000, 'store:false handler after drain');

    assert.equal(store.getResponse(responseId, CALLER).ok, false, 'store:false must not retain');
    assert.equal(store.getResponseStoreStats().stored, 0);
    assert.equal(res.writes.join('').split('data: [DONE]').length - 1, 1,
      'the sentinel is independent of retention');
    assert.equal(res.writesAfterClose, 0);
  });
});
