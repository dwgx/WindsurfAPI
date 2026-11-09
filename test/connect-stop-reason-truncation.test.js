// G3 (Q1 audit §7/§8.2) — "text deltas, then a clean EOF with no stopReason" is
// TRUNCATION, not a normal end.
//
// S01 measured this as the silent-corruption class of the corpus: their decoder
// raises a stream error rather than synthesizing `end_turn`, because a coding
// agent that receives a half answer labelled complete marks the task done
// (docs/upstream-protocol.md:106 — "缺 stopReason 的干净 EOF = 截断不是正常结束",
// the real incident being Codex reporting task_complete on a truncated turn).
//
// WindsurfAPI already raises STREAM_TRUNCATED when the Connect end-of-stream
// frame is MISSING (see test/responses-stream-truncation.test.js). It did not
// cover the other half: the trailer arrives, the answer is delivered, and no
// frame ever carried #5. `lastFinish` stayed null, `mapFinishReason(null)` is
// null ("no reason yet"), and every consumer defaults a null reason to 'stop' —
// so the truncated turn was reported as a completed one on all four surfaces.
//
// The rule pinned here: a turn that DELIVERED a payload but never named a stop
// reason reports finish_reason 'error' (never 'stop', never null). A turn that
// delivered NOTHING keeps its null reason — that is the empty-turn shape the
// adapter's empty/rescue retry owns, and it must not be reclassified.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { streamChat, chat, __setRequestImpl } from '../src/devin-connect.js';
import { toChatCompletion, streamChatCompletion } from '../src/devin-connect-openai.js';
import { writeStringField, writeVarintField, writeMessageField } from '../src/proto.js';
import { wrapEnvelope, endOfStreamEnvelope } from '../src/connect.js';

const TOKEN = 'devin-session-token$truncation.test.jwt.sig';
const MODEL = 'claude-sonnet-4.6';
// Calibrated native tool-call decode tags — a #6 ChatToolCall is the payload shape
// whose finish_reason the adapter used to force to 'tool_calls'.
const CALL_TAGS = 'outer=6,id=1,name=2,arguments_json=3';

// Connect-RPC always terminates a stream with an end-of-stream frame, so the
// transport below ALWAYS sends one: the only variable is whether any data frame
// carried the terminal stopReason (#5).
function mockTransport(payloads) {
  return (_opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      setImmediate(() => {
        for (const p of payloads) res.emit('data', wrapEnvelope(p, { compress: false }));
        res.emit('data', endOfStreamEnvelope());
        res.emit('end');
      });
      cb(res);
    };
    return req;
  };
}

const params = (extraEnv = {}) => ({
  messages: [{ role: 'user', content: 'what is 2+2' }],
  model: MODEL,
  token: TOKEN,
  tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object' } } }],
  env: { DEVIN_CONNECT_TOKEN: TOKEN, ...extraEnv },
});

async function drain(payloads) {
  __setRequestImpl(mockTransport(payloads));
  const events = [];
  try {
    for await (const ev of streamChat(params())) events.push(ev);
  } finally {
    __setRequestImpl(null);
  }
  return events;
}

afterEach(() => __setRequestImpl(null));

describe('G3: a delivered turn with no stopReason is not a normal completion', () => {
  it('reports finish_reason "error" when text arrived but #5 never did', async () => {
    const events = await drain([writeStringField(3, 'The answer is 4')]);
    const finish = events.find((e) => e.type === 'finish');
    assert.ok(finish, 'the stream must still terminate with a finish event');
    assert.notEqual(finish.reason, 'stop', 'a truncated turn must never look like a clean stop');
    assert.notEqual(finish.reason, null, 'null is what every consumer turns into "stop"');
    assert.equal(finish.reason, 'error');
    assert.equal(finish.unterminated, true, 'the shape is named, not inferred from a missing enum');
  });

  it('still delivers every byte the upstream sent before the gap', async () => {
    // Reporting the gap must not withhold the partial answer: the client asked for
    // a stream and is entitled to what actually arrived.
    const events = await drain([writeStringField(3, 'The answer '), writeStringField(3, 'is 4')]);
    assert.equal(events.filter((e) => e.type === 'content').map((e) => e.text).join(''), 'The answer is 4');
  });

  it('the non-stream collector inherits the same verdict', async () => {
    __setRequestImpl(mockTransport([writeStringField(3, 'half an answer')]));
    try {
      const out = await chat(params());
      assert.equal(out.content, 'half an answer');
      assert.equal(out.finish_reason, 'error');
    } finally {
      __setRequestImpl(null);
    }
  });

  it('the OpenAI completion body reports finish_reason "error", not "stop"', async () => {
    // The client-visible claim: devin-connect-openai keeps 'stop' as its default
    // and only overwrites it from a truthy event reason, so the reason has to come
    // from the stream layer — this asserts the two are actually wired.
    __setRequestImpl(mockTransport([writeStringField(3, 'The capital of France is Par')]));
    try {
      const out = await toChatCompletion(params(), { displayModel: MODEL });
      assert.equal(out.status, 200);
      assert.equal(out.body?.choices?.[0]?.finish_reason, 'error');
    } finally {
      __setRequestImpl(null);
    }
  });
});

describe('G3 control: turns that DID terminate are unchanged', () => {
  it('an explicit stopReason still reports its mapped reason', async () => {
    const events = await drain([Buffer.concat([writeStringField(3, 'done'), writeVarintField(5, 2)])]);
    const finish = events.find((e) => e.type === 'finish');
    assert.equal(finish.reason, 'stop');
    assert.equal(finish.unterminated, undefined, 'a terminated turn carries no gap marker');
  });

  it('MAX_TOKENS (3) still reports length', async () => {
    const events = await drain([Buffer.concat([writeStringField(3, 'cut'), writeVarintField(5, 3)])]);
    assert.equal(events.find((e) => e.type === 'finish').reason, 'length');
  });

  it('a stream that delivered NOTHING and named no reason keeps its null reason', async () => {
    // The empty-turn shape: the adapter's empty/rescue retry keys off a null/stop
    // reason, and reclassifying it as an error would disable that machinery for a
    // shape this fix was never about.
    const events = await drain([]);
    const finish = events.find((e) => e.type === 'finish');
    assert.equal(finish.reason, null);
    assert.equal(finish.unterminated, undefined);
  });
});

// ─── P2 (review): a TOOL-CALL payload must not launder an unterminated turn ───
//
// The adapter used to force `finish_reason:'tool_calls'` whenever a call was
// decoded (non-stream: three arms; stream: `toolParser.flush`, native #6, promoted
// reasoning). With no #5 that reported arguments the upstream may have been cut
// mid-write as a clean, executable finish — and OpenAI clients execute whatever
// `tool_calls` they receive. The producer's 'error'/'unterminated' verdict now
// survives; the calls are still delivered (the bytes are real), only the verdict
// is honest.

function toolCallFrame({ id = 'call_abc', name = 'Read', args = '{"path":"a.txt"}' } = {}) {
  return writeMessageField(6, Buffer.concat([
    writeStringField(1, id),
    writeStringField(2, name),
    writeStringField(3, args),
  ]));
}

describe('P2: a tool-call turn with no stopReason is not a clean tool_calls finish', () => {
  it('non-stream: finish_reason is "error", and the call is still delivered', async () => {
    __setRequestImpl(mockTransport([toolCallFrame()]));
    try {
      const out = await toChatCompletion(params({ DEVIN_CONNECT_TOOL_CALL_TAGS: CALL_TAGS }), { displayModel: MODEL });
      assert.equal(out.status, 200);
      assert.equal(out.body?.choices?.[0]?.finish_reason, 'error',
        'unvalidated tool arguments must not be labelled a clean tool_calls finish');
      const call = out.body?.choices?.[0]?.message?.tool_calls?.[0];
      assert.equal(call?.function?.name, 'Read', 'the call itself is still delivered');
      assert.equal(call?.function?.arguments, '{"path":"a.txt"}');
    } finally {
      __setRequestImpl(null);
    }
  });

  it('non-stream control: an explicit FUNCTION_CALL (10) still reports tool_calls', async () => {
    __setRequestImpl(mockTransport([toolCallFrame(), writeVarintField(5, 10)]));
    try {
      const out = await toChatCompletion(params({ DEVIN_CONNECT_TOOL_CALL_TAGS: CALL_TAGS }), { displayModel: MODEL });
      assert.equal(out.body?.choices?.[0]?.finish_reason, 'tool_calls');
    } finally {
      __setRequestImpl(null);
    }
  });

  it('stream: the terminal frame reports "error" after the call deltas', async () => {
    const frames = [];
    __setRequestImpl(mockTransport([toolCallFrame()]));
    try {
      await streamChatCompletion(
        params({ DEVIN_CONNECT_TOOL_CALL_TAGS: CALL_TAGS }),
        (f) => { frames.push(f); },
        { displayModel: MODEL },
      );
    } finally {
      __setRequestImpl(null);
    }
    const deltas = frames.flatMap((f) => f?.choices || []);
    const call = deltas.find((c) => c?.delta?.tool_calls?.length);
    assert.equal(call?.delta?.tool_calls?.[0]?.function?.name, 'Read', 'the call still streams');
    const terminal = deltas.filter((c) => c?.finish_reason).at(-1);
    assert.equal(terminal?.finish_reason, 'error',
      'the terminal frame is the only place a stream can say "these arguments are unvalidated"');
  });

  it('stream control: FUNCTION_CALL (10) still terminates as tool_calls', async () => {
    const frames = [];
    __setRequestImpl(mockTransport([toolCallFrame(), writeVarintField(5, 10)]));
    try {
      await streamChatCompletion(
        params({ DEVIN_CONNECT_TOOL_CALL_TAGS: CALL_TAGS }),
        (f) => { frames.push(f); },
        { displayModel: MODEL },
      );
    } finally {
      __setRequestImpl(null);
    }
    const terminal = frames.flatMap((f) => f?.choices || []).filter((c) => c?.finish_reason).at(-1);
    assert.equal(terminal?.finish_reason, 'tool_calls');
  });
});
