import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getConnectToken,
  buildGetChatMessageRequest,
  decodeFrame,
  mapFinishReason,
  classifyUpstreamError,
  isRetryable,
  streamChat,
  __testing,
} from '../src/devin-connect.js';
import {
  writeStringField, writeVarintField, writeMessageField,
  parseFields, getField, getAllFields,
} from '../src/proto.js';

const ENV_KEYS = ['DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY'];
const originalEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

const TOKEN = 'devin-session-token$test.jwt.sig';

describe('getConnectToken', () => {
  it('prefers DEVIN_CONNECT_TOKEN over WINDSURF_API_KEY', () => {
    assert.equal(
      getConnectToken({ DEVIN_CONNECT_TOKEN: 'a', WINDSURF_API_KEY: 'b' }),
      'a',
    );
  });
  it('falls back to WINDSURF_API_KEY', () => {
    assert.equal(getConnectToken({ WINDSURF_API_KEY: 'b' }), 'b');
  });
  it('returns empty string when neither is set', () => {
    assert.equal(getConnectToken({}), '');
  });
});

describe('generateFingerprint', () => {
  it('produces 732 hex chars (the server-required length)', () => {
    const fp = __testing.generateFingerprint();
    assert.equal(fp.length, 732);
    assert.match(fp, /^[0-9a-f]{732}$/);
  });
  it('is random per call', () => {
    assert.notEqual(__testing.generateFingerprint(), __testing.generateFingerprint());
  });
});

describe('messageText', () => {
  it('passes strings through', () => {
    assert.equal(__testing.messageText('hi'), 'hi');
  });
  it('joins text parts of array content', () => {
    assert.equal(
      __testing.messageText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]),
      'a\nb',
    );
  });
  it('handles null', () => {
    assert.equal(__testing.messageText(null), '');
  });
});

describe('buildGetChatMessageRequest', () => {
  it('throws without a token', () => {
    assert.throws(() => buildGetChatMessageRequest({ model: 'm', messages: [] }), /session token/);
  });
  it('throws without a model', () => {
    assert.throws(() => buildGetChatMessageRequest({ token: TOKEN, messages: [] }), /model selector/);
  });

  it('encodes the calibrated top-level field shape', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN,
      model: 'swe-1-6-slow',
      messages: [
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'hello' },
      ],
    });
    const fields = parseFields(proto);

    // #1 ClientMetadata (message), #2 system_prompt (string), #3 ChatMessage,
    // #7 mode varint, #8 CompletionConfig, #15 ModelConfig, #16 session id,
    // #20 varint, #21 model selector.
    assert.ok(getField(fields, 1, 2), 'has ClientMetadata #1');
    assert.equal(getField(fields, 2, 2).value.toString('utf8'), 'be nice');
    assert.equal(getField(fields, 7, 0).value, 5);
    assert.ok(getField(fields, 8, 2), 'has CompletionConfig #8');
    assert.ok(getField(fields, 15, 2), 'has ModelConfig #15');
    assert.ok(getField(fields, 16, 2), 'has session id #16');
    assert.equal(getField(fields, 20, 0).value, 1);
    assert.equal(getField(fields, 21, 2).value.toString('utf8'), 'swe-1-6-slow');
    // #22 is intentionally absent (matches the live capture).
    assert.equal(getField(fields, 22, 2), null);
  });

  it('embeds the SINGLE token in ClientMetadata #3 (header doubling is separate)', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm', messages: [{ role: 'user', content: 'x' }],
    });
    const meta = parseFields(getField(parseFields(proto), 1, 2).value);
    assert.equal(getField(meta, 3, 2).value.toString('utf8'), TOKEN);
  });

  it('uses a 732-hex fingerprint in ClientMetadata #31', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm', messages: [{ role: 'user', content: 'x' }],
    });
    const meta = parseFields(getField(parseFields(proto), 1, 2).value);
    const fp = getField(meta, 31, 2).value.toString('utf8');
    assert.equal(fp.length, 732);
  });

  it('emits one ChatMessage per non-system turn with the right source enum', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN,
      model: 'm',
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ],
    });
    const chats = getAllFields(parseFields(proto), 3).filter(f => f.wireType === 2);
    assert.equal(chats.length, 3);
    const sources = chats.map(c => getField(parseFields(c.value), 2, 0).value);
    assert.deepEqual(sources, [__testing.SOURCE.USER, __testing.SOURCE.ASSISTANT, __testing.SOURCE.USER]);
  });

  it('folds tool turns into user-visible text', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm',
      messages: [{ role: 'tool', tool_call_id: 'call_7', content: '42' }],
    });
    const chat = getAllFields(parseFields(proto), 3).find(f => f.wireType === 2);
    const text = getField(parseFields(chat.value), 3, 2).value.toString('utf8');
    assert.match(text, /tool result for call_7/);
    assert.match(text, /42/);
  });

  it('concatenates multiple system turns', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm',
      messages: [
        { role: 'system', content: 'a' },
        { role: 'system', content: 'b' },
        { role: 'user', content: 'x' },
      ],
    });
    assert.equal(getField(parseFields(proto), 2, 2).value.toString('utf8'), 'a\nb');
  });

  it('honours CompletionConfig overrides', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      completion: { maxTokens: 256 },
    });
    const comp = parseFields(getField(parseFields(proto), 8, 2).value);
    assert.equal(getField(comp, 3, 0).value, 256);
  });
});

describe('decodeFrame', () => {
  it('reads the final answer from field #3 (content)', () => {
    const payload = Buffer.concat([
      writeStringField(1, 'bot-123'),
      writeStringField(3, 'the answer'),
      writeStringField(9, 'thinking...'),
      writeStringField(17, 'uuid'),
    ]);
    const d = decodeFrame(payload);
    assert.equal(d.content, 'the answer');
    assert.equal(d.reasoning, 'thinking...');
  });

  it('does not confuse the nested #7.#9 model name with top-level #9 reasoning', () => {
    // #7 metadata carries its own #9 (model name); only top-level #9 is reasoning.
    const meta = Buffer.concat([writeVarintField(6, 6), writeStringField(9, 'swe-1-6-slow')]);
    const payload = Buffer.concat([
      writeStringField(1, 'bot-123'),
      writeMessageField(7, meta),
    ]);
    const d = decodeFrame(payload);
    assert.equal(d.reasoning, '');
    assert.equal(d.content, '');
  });

  it('reads token usage from the terminal #7 metadata frame', () => {
    const meta = Buffer.concat([
      writeVarintField(2, 386), // prompt_tokens
      writeVarintField(3, 48),  // completion_tokens
      writeVarintField(6, 6),
    ]);
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), writeMessageField(7, meta)]);
    const d = decodeFrame(payload);
    assert.deepEqual(d.usage, { prompt: 386, completion: 48 });
  });

  it('omits usage when completion_tokens is absent (non-terminal frame)', () => {
    const meta = Buffer.concat([writeVarintField(2, 386), writeVarintField(6, 6)]);
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), writeMessageField(7, meta)]);
    assert.equal(decodeFrame(payload).usage, null);
  });

  it('reads the finish signal from field #5', () => {
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), writeVarintField(5, 2)]);
    assert.equal(decodeFrame(payload).finish, 2);
  });

  it('returns empties for a metadata-only frame', () => {
    const payload = Buffer.concat([
      writeStringField(1, 'bot-123'),
      writeMessageField(7, writeVarintField(6, 6)),
    ]);
    const d = decodeFrame(payload);
    assert.equal(d.content, '');
    assert.equal(d.reasoning, '');
    assert.equal(d.finish, null);
    assert.equal(d.usage, null);
  });
});

describe('mapFinishReason', () => {
  it('maps the stop enum (2) to "stop"', () => {
    assert.equal(mapFinishReason(2), 'stop');
  });
  it('returns null when no finish signal was seen', () => {
    assert.equal(mapFinishReason(null), null);
  });
});

describe('classifyUpstreamError', () => {
  it('maps a free-tier /upgrade rejection to MODEL_BLOCKED', () => {
    const r = classifyUpstreamError('Please /upgrade to access claude-opus-4-8');
    assert.equal(r.code, 'MODEL_BLOCKED');
  });
  it('maps "upgrade to access" prose to MODEL_BLOCKED', () => {
    assert.equal(classifyUpstreamError('You must upgrade to access this model').code, 'MODEL_BLOCKED');
  });
  it('maps insufficient credit/quota to MODEL_BLOCKED', () => {
    assert.equal(classifyUpstreamError('insufficient credits remaining').code, 'MODEL_BLOCKED');
  });
  it('maps HTTP 401 to UNAUTHORIZED', () => {
    assert.equal(classifyUpstreamError('', null, 401).code, 'UNAUTHORIZED');
  });
  it('maps permission_denied code to UNAUTHORIZED', () => {
    assert.equal(classifyUpstreamError('nope', 'permission_denied').code, 'UNAUTHORIZED');
  });
  it('maps HTTP 429 to RATE_LIMITED', () => {
    assert.equal(classifyUpstreamError('', null, 429).code, 'RATE_LIMITED');
  });
  it('maps resource_exhausted text to RATE_LIMITED', () => {
    assert.equal(classifyUpstreamError('resource_exhausted: too many requests').code, 'RATE_LIMITED');
  });
  it('falls back to the upstream code, else UPSTREAM_ERROR', () => {
    assert.equal(classifyUpstreamError('boom', 'weird_code').code, 'weird_code');
    assert.equal(classifyUpstreamError('boom').code, 'UPSTREAM_ERROR');
  });
  it('prefers MODEL_BLOCKED even on a non-200 status', () => {
    // an /upgrade message returned with a 403 is still an entitlement issue
    assert.equal(classifyUpstreamError('/upgrade required', null, 403).code, 'MODEL_BLOCKED');
  });
});

describe('streamChat abort / preconditions', () => {
  it('throws AbortError when the signal is already aborted (no network leak)', async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      (async () => {
        for await (const _ of streamChat({
          messages: [{ role: 'user', content: 'hi' }],
          model: 'swe-1-6-slow',
          token: 'devin-session-token$fake.jwt.sig',
          signal: ac.signal,
        })) { /* drain */ }
      })(),
      (err) => err.name === 'AbortError' || err.code === 'ABORT_ERR',
    );
  });

  it('throws NO_TOKEN before any network attempt when token is missing', async () => {
    await assert.rejects(
      (async () => {
        for await (const _ of streamChat({ messages: [], model: 'm', env: {} })) { /* drain */ }
      })(),
      (err) => err.code === 'NO_TOKEN',
    );
  });
});

describe('isRetryable', () => {
  it('retries transient network codes', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'TIMEOUT', 'EPIPE']) {
      assert.equal(isRetryable({ code }), true, code);
    }
  });
  it('retries RATE_LIMITED and upstream internal/unavailable', () => {
    assert.equal(isRetryable({ code: 'RATE_LIMITED' }), true);
    assert.equal(isRetryable({ code: 'internal' }), true);
    assert.equal(isRetryable({ code: 'unavailable' }), true);
  });
  it('retries HTTP 5xx (except 501) and not 4xx', () => {
    assert.equal(isRetryable({ status: 500 }), true);
    assert.equal(isRetryable({ status: 503 }), true);
    assert.equal(isRetryable({ status: 501 }), false);
    assert.equal(isRetryable({ status: 429 }), false); // status-only 429: code path handles it
    assert.equal(isRetryable({ status: 400 }), false);
  });
  it('does not retry terminal codes', () => {
    assert.equal(isRetryable({ code: 'MODEL_BLOCKED' }), false);
    assert.equal(isRetryable({ code: 'UNAUTHORIZED' }), false);
    assert.equal(isRetryable(null), false);
  });
});
