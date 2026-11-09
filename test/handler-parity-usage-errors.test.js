// Cross-handler parity: the streaming usage frame and the streaming error frame.
//
// messages / responses / gemini all delegate to handleChatCompletions, so a
// behavioural change made at the chat layer has to be mirrored on every route.
// Two drifts this pins:
//
// 1. O1 made the trailing usage-only frame opt-in via stream_options.include_usage.
//    messages.js and responses.js were updated; gemini.js was not — and its
//    translator reads chunk.usage to build the terminal frame's usageMetadata, so
//    every Gemini streaming response shipped with NO usage at all.
//
// 2. messages.js / gemini.js resolve a mid-stream error through
//    connectErrorToHttp(err.code) to recover the authoritative {status,type};
//    responses.js read only err.type, collapsing CAPACITY / RATE_LIMITED /
//    MODEL_BLOCKED into a flat api_error and losing the retryable distinction.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleGemini } from '../src/handlers/gemini.js';
import { connectErrorToHttp } from '../src/handlers/chat.js';
import { handleResponses } from '../src/handlers/responses.js';

describe('gemini streaming asks the chat layer for the usage frame', () => {
  it('threads stream_options.include_usage into the delegated chat request', async () => {
    let seenBody = null;
    const fakeChat = async (body) => {
      seenBody = body;
      return { status: 200, stream: true, handler: () => {} };
    };

    await handleGemini(
      'gemini-2.5-flash',
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      { handleChatCompletions: fakeChat, callerKey: '' },
      { stream: true, alt: 'sse' },
    );

    assert.ok(seenBody, 'the chat handler must have been called');
    assert.equal(seenBody.stream, true);
    assert.equal(seenBody.stream_options?.include_usage, true,
      'without include_usage the chat layer omits the usage frame → usageMetadata always absent');
  });

  it('leaves the non-streaming path alone (no usage frame involved)', async () => {
    let seenBody = null;
    const fakeChat = async (body) => {
      seenBody = body;
      return { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } };
    };

    await handleGemini(
      'gemini-2.5-flash',
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      { handleChatCompletions: fakeChat, callerKey: '' },
      { stream: false },
    );

    assert.equal(seenBody.stream, false);
    assert.equal(seenBody.stream_options?.include_usage, undefined,
      'non-stream responses carry usage inline; no opt-in needed');
  });
});

describe('responses streaming error frame resolves the DEVIN_CONNECT code', () => {
  it('the classifier keeps CAPACITY / RATE_LIMITED / MODEL_BLOCKED distinguishable', () => {
    // This is the signal the flat `api_error` collapse was throwing away.
    assert.equal(connectErrorToHttp('CAPACITY').status, 503, 'CAPACITY is transient');
    assert.equal(connectErrorToHttp('RATE_LIMITED').status, 429);
    assert.equal(connectErrorToHttp('MODEL_BLOCKED').status, 402, 'entitlement wall is terminal');
    assert.notEqual(connectErrorToHttp('CAPACITY').type, connectErrorToHttp('MODEL_BLOCKED').type,
      'a retryable and a terminal failure must not share one type');
  });

  it('responses.js resolves the stream error through connectErrorToHttp, like messages/gemini', () => {
    // Structural parity check (same pattern as the shared-trustedClientIp guard):
    // the three routes must agree on how a mid-stream error is classified.
    const src = readFileSync(new URL('../src/handlers/responses.js', import.meta.url), 'utf8');
    assert.ok(/import \{[^}]*connectErrorToHttp[^}]*\} from '\.\/chat\.js'/.test(src),
      'responses.js must import the shared classifier');
    // The classifier moved into the shared failure sender so the mid-stream error
    // path and the G3 `error`/`unterminated` terminal emit ONE failure frame. The
    // slice starts there and ends at the delegating error(err) method.
    const start = src.indexOf('  sendFailed(err) {');
    const end = src.indexOf('  error(err) {');
    assert.ok(start >= 0 && end > start, 'the shared failure sender must sit before error(err)');
    const failedFn = src.slice(start, end);
    assert.ok(failedFn.includes('connectErrorToHttp(err.code)'),
      'the stream error frame must resolve err.code, not read err.type alone');
  });

  it('emits the classified failure frame for an in-band RATE_LIMITED error', async () => {
    // Behavioural twin of the structural check: if the frame read err.type alone,
    // the missing type would default to api_error; resolving the code yields the
    // 429 type and keeps the raw code on the wire.
    const result = await handleResponses(
      { model: 'gpt-5.2', input: 'hi', stream: true },
      {
        async handleChatCompletions() {
          return {
            status: 200,
            stream: true,
            async handler(res) {
              res.write(`data: ${JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'upstream throttled' } })}\n\n`);
              res.end();
            },
          };
        },
        context: { callerKey: 'api:parity:user:t' },
      },
    );
    assert.equal(result.status, 200);
    const res = {
      body: '', writableEnded: false,
      write(chunk) { this.body += String(chunk); return true; },
      end(chunk) { if (chunk) this.write(chunk); this.writableEnded = true; },
      on() { return this; }, once() { return this; },
      setHeader() {}, writeHead() { return this; }, flushHeaders() {},
    };
    await result.handler(res);
    const frame = res.body.split('\n\n').find(part => part.startsWith('event: response.failed'));
    assert.ok(frame, 'the in-band error must close the stream with response.failed');
    const data = JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6));
    assert.equal(data.response.status, 'failed');
    assert.equal(data.response.error.code, 'RATE_LIMITED', 'the raw code survives for a relay');
    assert.equal(data.response.error.type, 'rate_limit_error', 'the classifier chose the 429 type');
  });
});
