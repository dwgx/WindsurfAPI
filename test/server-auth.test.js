import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import {
  bodyTooLargePayload,
  credentialSurfaceFor,
  extractToken,
  readBody,
  startServer,
  unsupportedContentEncoding,
  unsupportedContentEncodingPayload,
} from '../src/server.js';
import { config } from '../src/config.js';
import { configureBindHost } from '../src/auth.js';
import { setRuntimeApiKey } from '../src/runtime-config.js';
import { EventEmitter } from 'node:events';

describe('server auth token extraction', () => {
  it('parses Bearer authorization case-insensitively and trims the token', () => {
    assert.equal(extractToken({ headers: { authorization: 'bearer  abc123  ' } }), 'abc123');
    assert.equal(extractToken({ headers: { authorization: 'BEARER xyz' } }), 'xyz');
  });

  it('rejects a non-Bearer raw Authorization header instead of treating it as a token', () => {
    assert.equal(extractToken({ headers: { authorization: 'raw-secret' } }), '');
  });

  // TOK-3 (audit P3): a comma in the Bearer credential must NOT blanket-clear
  // auth. Take the first comma-delimited segment (so a duplicate/injected
  // `Bearer a, Bearer b` can't smuggle a second credential) and still fall
  // back to x-api-key when the Bearer segment is empty.
  it('takes the first Bearer segment when the credential contains a comma', () => {
    assert.equal(extractToken({ headers: { authorization: 'Bearer one, Bearer two' } }), 'one');
    assert.equal(extractToken({ headers: { authorization: 'Bearer my,key' } }), 'my');
  });

  it('falls back to x-api-key when the Bearer credential is comma-led (empty first segment)', () => {
    assert.equal(extractToken({ headers: { authorization: 'Bearer ,junk', 'x-api-key': 'fallback' } }), 'fallback');
  });

  it('honours a correct x-api-key even when Authorization is a bare non-Bearer value', () => {
    assert.equal(extractToken({ headers: { authorization: 'raw-secret', 'x-api-key': 'fallback' } }), 'fallback');
  });

  it('falls through to x-api-key when Authorization is absent', () => {
    assert.equal(extractToken({ headers: { 'x-api-key': 'fallback-key' } }), 'fallback-key');
  });
});

describe('server body parsing', () => {
  it('preserves request-body-too-large as a 413-class error', async () => {
    const req = new EventEmitter();
    req.resume = () => {};

    const promise = readBody(req);
    req.emit('data', Buffer.alloc(10 * 1024 * 1024 + 1));
    req.emit('end');

    await assert.rejects(promise, (err) => {
      assert.equal(err.statusCode, 413);
      assert.equal(err.code, 'ERR_REQUEST_BODY_TOO_LARGE');
      return true;
    });
  });

  it('keeps oversized body payloads protocol-shaped instead of Invalid JSON', () => {
    // O10: OpenAI-family error.type uses the official invalid_request_error.
    assert.deepEqual(bodyTooLargePayload('openai'), {
      error: { message: 'Request body too large', type: 'invalid_request_error' },
    });
    // D1: 413 uses the dedicated request_too_large type (not invalid_request_error).
    assert.deepEqual(bodyTooLargePayload('anthropic'), {
      type: 'error',
      error: { type: 'request_too_large', message: 'Request body too large' },
    });
    assert.deepEqual(bodyTooLargePayload('dashboard'), {
      ok: false,
      error: 'ERR_REQUEST_BODY_TOO_LARGE',
      message: 'Request body too large',
    });
  });
});

// ─── Q2 T03: credential carriers are surface-scoped ────────────────────────
describe('credential carrier scoping', () => {
  const req = (headers = {}, url = '/') => ({ headers, url });
  const KEY = 'sk-scope-key';

  it('maps every API path to the carrier set its protocol defines', () => {
    assert.equal(credentialSurfaceFor('/v1/messages'), 'messages');
    assert.equal(credentialSurfaceFor('/v1/messages/count_tokens'), 'messages');
    assert.equal(credentialSurfaceFor('/v1/models'), 'models');
    assert.equal(credentialSurfaceFor('/v1/models/claude-sonnet-4.6'), 'models');
    assert.equal(credentialSurfaceFor('/v1beta/models/gemini-2.5-pro:generateContent'), 'gemini');
    assert.equal(credentialSurfaceFor('/v1/models/gemini-2.5-pro:generateContent'), 'gemini',
      'the v1 alias is a Gemini generate surface, not a model-list surface');
    assert.equal(credentialSurfaceFor('/v1/models/gemini-2.5-pro:streamGenerateContent'), 'gemini');
    assert.equal(credentialSurfaceFor('/v1/chat/completions'), 'openai');
    assert.equal(credentialSurfaceFor('/v1/responses'), 'openai');
    assert.equal(credentialSurfaceFor('/v1/completions'), 'openai');
    assert.equal(credentialSurfaceFor('/auth/login'), 'operator');
    assert.equal(credentialSurfaceFor('/health'), 'operator');
  });

  it('a chat surface accepts only Authorization: Bearer', () => {
    assert.equal(extractToken(req({ authorization: `Bearer ${KEY}` }), 'openai'), KEY);
    assert.equal(extractToken(req({ 'x-api-key': KEY }), 'openai'), '');
    assert.equal(extractToken(req({ 'x-goog-api-key': KEY }), 'openai'), '');
    assert.equal(extractToken(req({}, `/v1/chat/completions?key=${KEY}`), 'openai'), '');
  });

  it('the Anthropic surface accepts Bearer + x-api-key, not Gemini carriers', () => {
    assert.equal(extractToken(req({ authorization: `Bearer ${KEY}` }), 'messages'), KEY);
    assert.equal(extractToken(req({ 'x-api-key': KEY }), 'messages'), KEY);
    assert.equal(extractToken(req({ 'x-goog-api-key': KEY }), 'messages'), '');
    assert.equal(extractToken(req({}, `/v1/messages?key=${KEY}`), 'messages'), '');
  });

  it('the model surface accepts every documented carrier', () => {
    assert.equal(extractToken(req({ authorization: `Bearer ${KEY}` }), 'models'), KEY);
    assert.equal(extractToken(req({ 'x-api-key': KEY }), 'models'), KEY);
    assert.equal(extractToken(req({ 'x-goog-api-key': KEY }), 'models'), KEY);
    assert.equal(extractToken(req({}, `/v1/models?key=${KEY}`), 'models'), KEY);
  });

  it('the Gemini surface accepts the Google SDK carriers, not x-api-key', () => {
    assert.equal(extractToken(req({ authorization: `Bearer ${KEY}` }), 'gemini'), KEY);
    assert.equal(extractToken(req({ 'x-goog-api-key': KEY }), 'gemini'), KEY);
    assert.equal(extractToken(req({}, `/v1beta/models/x:generateContent?key=${KEY}`), 'gemini'), KEY);
    assert.equal(extractToken(req({ 'x-api-key': KEY }), 'gemini'), '');
  });

  it('the default surface stays permissive for direct callers (route code always passes one)', () => {
    assert.equal(extractToken(req({ 'x-api-key': KEY })), KEY);
    assert.equal(extractToken(req({ 'x-goog-api-key': KEY })), KEY);
    assert.equal(extractToken(req({}, `/?key=${KEY}`)), KEY);
  });
});

// ─── Q2 T04: compressed request bodies are refused, never inflated ─────────
describe('Content-Encoding refusal', () => {
  const req = (value) => ({ headers: value == null ? {} : { 'content-encoding': value } });

  it('treats absent and identity encodings as usable', () => {
    assert.equal(unsupportedContentEncoding(req()), '');
    assert.equal(unsupportedContentEncoding(req('')), '');
    assert.equal(unsupportedContentEncoding(req('identity')), '');
    assert.equal(unsupportedContentEncoding(req('IDENTITY')), '');
  });

  it('flags every encoding this proxy cannot read', () => {
    for (const enc of ['gzip', 'x-gzip', 'br', 'deflate', 'compress', 'zstd', 'gzip, br']) {
      assert.equal(unsupportedContentEncoding(req(enc)), enc, enc);
    }
  });

  it('keeps each protocol’s error envelope and types the code', () => {
    const openai = unsupportedContentEncodingPayload('gzip', 'openai');
    assert.equal(openai.error.type, 'unsupported_content_encoding');
    assert.match(openai.error.message, /gzip/);

    const anthropic = unsupportedContentEncodingPayload('br', 'anthropic');
    assert.equal(anthropic.type, 'error');
    assert.equal(anthropic.error.type, 'unsupported_content_encoding');

    const gemini = unsupportedContentEncodingPayload('deflate', 'gemini');
    assert.equal(gemini.error.code, 415);
    assert.equal(gemini.error.status, 'INVALID_ARGUMENT');
    assert.equal(gemini.error.type, 'unsupported_content_encoding');

    assert.equal(unsupportedContentEncodingPayload('gzip', 'dashboard').error, 'unsupported_content_encoding');
    assert.equal(unsupportedContentEncodingPayload('gzip', 'legacy').code, 'unsupported_content_encoding');
  });
});

// ─── Q2 T02/T03/T04 over the real router ───────────────────────────────────
const TEST_KEY = 'sk-fixture-server-auth-key';
const origApiKey = config.apiKey;
const origHost = config.host;
const origPort = config.port;
let server = null;

function waitListening(s) {
  return new Promise((resolve) => { if (s.address()) return resolve(); s.once('listening', resolve); });
}

/** Send a request; `payload` may be a string, object or Buffer. */
function request(port, method, path, headers = {}, payload = null, { chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const isBuffer = Buffer.isBuffer(payload);
    const body = payload == null ? null : (isBuffer ? payload : JSON.stringify(payload));
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(body != null ? { 'Content-Type': 'application/json' } : {}),
        ...(body != null && !chunked ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

describe('server auth routing', () => {
  beforeEach(async () => {
    setRuntimeApiKey(TEST_KEY);
    config.host = '127.0.0.1';
    config.port = 0;
    configureBindHost('127.0.0.1');
    server = startServer();
    await waitListening(server);
  });
  afterEach(async () => {
    if (server) { await new Promise((r) => server.close(r)); server = null; }
    setRuntimeApiKey('');
    config.apiKey = origApiKey;
    config.host = origHost;
    config.port = origPort;
    configureBindHost(origHost);
  });

  const port = () => server.address().port;
  const messagesBody = { model: 'claude-sonnet-4.6', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] };
  const chatBody = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
  const geminiBody = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };

  it('T02: a refused /v1/messages gets the Anthropic envelope and a request-id header', async () => {
    const res = await request(port(), 'POST', '/v1/messages', {}, messagesBody);
    assert.equal(res.status, 401);
    assert.equal(res.body.type, 'error', 'Anthropic SDKs parse only this envelope');
    assert.equal(res.body.error.type, 'authentication_error');
    assert.ok(res.headers['request-id'], 'Anthropic clients read the id from request-id');
    assert.doesNotMatch(JSON.stringify(res.body), /auth_error/, 'the OpenAI-only auth_error type must not leak');
  });

  it('T02: count_tokens uses the same Anthropic envelope', async () => {
    const res = await request(port(), 'POST', '/v1/messages/count_tokens', {}, messagesBody);
    assert.equal(res.status, 401);
    assert.equal(res.body.type, 'error');
    assert.equal(res.body.error.type, 'authentication_error');
    assert.ok(res.headers['request-id']);
  });

  it('T02/M10: the OpenAI gate keeps auth_error; Gemini gets its own envelope', async () => {
    const chat = await request(port(), 'POST', '/v1/chat/completions', {}, chatBody);
    assert.equal(chat.status, 401);
    assert.equal(chat.body.error.type, 'auth_error');
    // M10: Google GenAI SDKs parse only the Gemini error envelope — the shared
    // OpenAI auth_error body was as unparseable to them as it was to Anthropic
    // SDKs before Q2 T02.
    for (const path of [
      '/v1beta/models/gemini-2.5-pro:generateContent',
      '/v1/models/gemini-2.5-pro:generateContent',
    ]) {
      const gemini = await request(port(), 'POST', path, {}, geminiBody);
      assert.equal(gemini.status, 401, `${path} must still be a 401`);
      assert.equal(gemini.body.error.status, 'UNAUTHENTICATED', `${path}: Google SDKs parse only the Gemini envelope`);
      assert.equal(gemini.body.error.code, 401);
      assert.match(String(gemini.body.error.message || ''), /API key/i);
      assert.doesNotMatch(JSON.stringify(gemini.body), /auth_error/, 'the OpenAI-only auth_error type must not leak');
    }
  });

  it('T03: a chat POST is refused for ?key=, x-goog-api-key and x-api-key', async () => {
    const shapes = [
      ['?key=', `/v1/chat/completions?key=${TEST_KEY}`, {}],
      ['x-goog-api-key', '/v1/chat/completions', { 'x-goog-api-key': TEST_KEY }],
      ['x-api-key', '/v1/chat/completions', { 'x-api-key': TEST_KEY }],
    ];
    for (const [name, path, headers] of shapes) {
      const res = await request(port(), 'POST', path, headers, chatBody);
      assert.equal(res.status, 401, `${name} must not authenticate a chat POST`);
      assert.doesNotMatch(String(res.body?.error?.message || ''), /x-api-key/,
        `${name}: the 401 must not recommend a carrier this surface now rejects`);
    }
  });

  it('T03: Bearer still authenticates a chat POST (control: not 401)', async () => {
    const res = await request(port(), 'POST', '/v1/chat/completions', { authorization: `Bearer ${TEST_KEY}` }, chatBody);
    assert.equal(res.status, 503, 'the gate passed; the empty pool answers its 503 sentinel');
  });

  it('T03: /v1/models accepts Bearer, x-api-key, x-goog-api-key and ?key=', async () => {
    const shapes = [
      ['bearer', '/v1/models', { authorization: `Bearer ${TEST_KEY}` }],
      ['x-api-key', '/v1/models', { 'x-api-key': TEST_KEY }],
      ['x-goog-api-key', '/v1/models', { 'x-goog-api-key': TEST_KEY }],
      ['?key=', `/v1/models?key=${TEST_KEY}`, {}],
    ];
    for (const [name, path, headers] of shapes) {
      const res = await request(port(), 'GET', path, headers);
      assert.equal(res.status, 200, `${name} must authenticate the model surface`);
      assert.ok(Array.isArray(res.body?.data), `${name} must return the model list`);
    }
  });

  it('T03: /v1/messages accepts x-api-key, not the Gemini carriers', async () => {
    const ok = await request(port(), 'POST', '/v1/messages', { 'x-api-key': TEST_KEY }, messagesBody);
    assert.equal(ok.status, 529, 'x-api-key is an Anthropic carrier; the gate passed');

    for (const [name, path, headers] of [
      ['?key=', `/v1/messages?key=${TEST_KEY}`, {}],
      ['x-goog-api-key', '/v1/messages', { 'x-goog-api-key': TEST_KEY }],
    ]) {
      const res = await request(port(), 'POST', path, headers, messagesBody);
      assert.equal(res.status, 401, `${name} must not authenticate /v1/messages`);
    }
  });

  it('T03: Gemini generate accepts ?key=/x-goog-api-key, not x-api-key', async () => {
    for (const [name, path, headers] of [
      ['?key=', `/v1beta/models/gemini-2.5-pro:generateContent?key=${TEST_KEY}`, {}],
      ['x-goog-api-key', '/v1beta/models/gemini-2.5-pro:generateContent', { 'x-goog-api-key': TEST_KEY }],
      ['?key= (v1 alias)', `/v1/models/gemini-2.5-pro:generateContent?key=${TEST_KEY}`, {}],
      ['x-goog-api-key (v1 alias)', '/v1/models/gemini-2.5-pro:generateContent', { 'x-goog-api-key': TEST_KEY }],
    ]) {
      const res = await request(port(), 'POST', path, headers, geminiBody);
      assert.equal(res.status, 503, `${name} must pass the gate (empty pool → 503)`);
    }
    for (const [name, path] of [
      ['/v1beta', '/v1beta/models/gemini-2.5-pro:generateContent'],
      ['v1 alias', '/v1/models/gemini-2.5-pro:generateContent'],
    ]) {
      const rejected = await request(port(), 'POST', path, { 'x-api-key': TEST_KEY }, geminiBody);
      assert.equal(rejected.status, 401, `x-api-key must not authenticate a Gemini generate call (${name})`);
    }
  });

  it('T04: a gzip bomb is refused with 415 and never decompressed', async () => {
    const bomb = gzipSync(Buffer.alloc(16 * 1024 * 1024));
    assert.ok(bomb.length < 1024 * 1024, 'precondition: the wire body is tiny, the inflated body is not');
    const res = await request(port(), 'POST', '/v1/chat/completions',
      { authorization: `Bearer ${TEST_KEY}`, 'content-encoding': 'gzip' }, bomb);
    assert.equal(res.status, 415);
    assert.equal(res.body.error.type, 'unsupported_content_encoding');
    assert.match(res.body.error.message, /gzip/);
  });

  it('T04: the refusal does not depend on Content-Length (chunked gzip body)', async () => {
    const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024));
    const res = await request(port(), 'POST', '/v1/chat/completions',
      { authorization: `Bearer ${TEST_KEY}`, 'content-encoding': 'gzip' }, bomb, { chunked: true });
    assert.equal(res.status, 415);
    assert.equal(res.body.error.type, 'unsupported_content_encoding');
  });

  it('T04: br and deflate are refused with each protocol’s envelope', async () => {
    const br = await request(port(), 'POST', '/v1/messages',
      { authorization: `Bearer ${TEST_KEY}`, 'content-encoding': 'br' }, brotliCompressSync(Buffer.from('{}')));
    assert.equal(br.status, 415);
    assert.equal(br.body.type, 'error');
    assert.equal(br.body.error.type, 'unsupported_content_encoding');

    const deflate = await request(port(), 'POST', '/v1beta/models/gemini-2.5-pro:generateContent',
      { authorization: `Bearer ${TEST_KEY}`, 'content-encoding': 'deflate' }, deflateSync(Buffer.from('{}')));
    assert.equal(deflate.status, 415);
    assert.equal(deflate.body.error.code, 415);
    assert.equal(deflate.body.error.type, 'unsupported_content_encoding');

    const legacy = await request(port(), 'POST', '/auth/login',
      { authorization: `Bearer ${TEST_KEY}`, 'content-encoding': 'gzip' }, gzipSync(Buffer.from('{}')));
    assert.equal(legacy.status, 415);
    assert.equal(legacy.body.code, 'unsupported_content_encoding');
  });

  it('T04: Content-Encoding: identity still reaches the JSON parser', async () => {
    // A plain (uncompressed) body with an explicit identity marker is legal; the
    // guard must not turn it into a 415. The empty pool answers its sentinel.
    const res = await request(port(), 'POST', '/v1/chat/completions',
      { authorization: `Bearer ${TEST_KEY}`, 'content-encoding': 'identity' }, chatBody);
    assert.equal(res.status, 503);
  });

  it('T04: an unauthenticated compressed request still gets the 401 it earned', async () => {
    const res = await request(port(), 'POST', '/v1/chat/completions', { 'content-encoding': 'gzip' }, gzipSync(Buffer.from('{}')));
    assert.equal(res.status, 401);
    assert.equal(res.body.error.type, 'auth_error');
  });
});
