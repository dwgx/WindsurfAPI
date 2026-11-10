import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDeferredSseResponse } from '../src/sse-commit.js';
import { toAnthropicError } from '../src/handlers/messages.js';

function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writableEnded: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    write(chunk) { this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); return true; },
    end(chunk) { if (chunk) this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); this.writableEnded = true; },
    setHeader() {},
    getHeader() {},
    removeHeader() {},
    on() {},
    once() {},
    removeListener() {},
    destroy() { this.writableEnded = true; },
    socket: null,
  };
}

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

describe('createDeferredSseResponse', () => {
  it('commits a normal content frame as SSE 200 with byte-identical body', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const body = frame({ choices: [{ delta: { content: 'hi' } }] });
    res.write(body);
    res.end();
    assert.equal(real.statusCode, 200);
    assert.equal(real.headers['content-type'], 'text/event-stream');
    assert.equal(real.body, body);
  });

  it('holds a role-only prime until a real payload arrives', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200 });
    const role = frame({ choices: [{ delta: { role: 'assistant' } }] });
    const content = frame({ choices: [{ delta: { content: 'hi' } }] });
    res.write(role);
    assert.equal(real.statusCode, null, 'role-only frame must not commit');
    res.write(content);
    assert.equal(real.statusCode, 200);
    assert.equal(real.body, role + content);
  });

  it('turns a pre-content error frame into a JSON 429 with Retry-After', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_1' },
      requestId: 'req_1',
    });
    res.write(frame({
      error: {
        message: 'rate limited',
        type: 'rate_limit_error',
        code: 'RATE_LIMITED',
        retry_after_ms: 2500,
      },
    }));
    res.end();
    assert.equal(real.statusCode, 429);
    assert.equal(real.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(real.headers['retry-after'], '30');
    const body = JSON.parse(real.body);
    assert.equal(body.error.code, 'RATE_LIMITED');
    assert.equal(body.request_id, 'req_1');
  });

  it('maps a multi-line CRLF error frame without cutting it at the first line', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200 });
    res.write('data: {"error":\r\ndata: {"message":"busy","code":"RATE_LIMITED","retry_after_ms":2500}}\r\n\r\n');
    res.end();
    assert.equal(real.statusCode, 429);
    assert.equal(real.headers['retry-after'], '30');
  });

  it('maps classified error codes to the documented statuses', () => {
    for (const [code, status] of [['MODEL_BLOCKED', 402], ['QUOTA_EXHAUSTED', 402], ['UPSTREAM_INTERNAL', 503], ['NO_TOKEN', 401], ['RATE_LIMITED', 429], ['windsurf_provider_deadline', 504]]) {
      const real = fakeRes();
      const res = createDeferredSseResponse(real, { status: 200 });
      res.write(`data: ${JSON.stringify({ error: { message: code, code } })}\n\n`);
      res.end();
      assert.equal(real.statusCode, status, code);
    }
  });

  it('maps an unclassified Anthropic error type to its official status', () => {
    for (const [type, status] of [['invalid_request_error', 400], ['not_found_error', 404], ['request_too_large', 413], ['api_error', 500]]) {
      const real = fakeRes();
      const res = createDeferredSseResponse(real, {
        status: 200,
        protocol: 'messages',
        parseError: (obj) => (obj?.type === 'error' ? obj.error : null),
        errorBody: (error, httpStatus) => toAnthropicError(httpStatus, error?.type, error?.message).body,
      });
      res.write(frame({ type: 'error', error: { type, message: 'x' } }));
      res.end();
      assert.equal(real.statusCode, status, type);
      assert.equal(JSON.parse(real.body).error.type, type);
    }
  });

  it('preserves Gemini numeric error codes when status is a gRPC enum', () => {
    for (const [code, status] of [[400, 'INVALID_ARGUMENT'], [404, 'NOT_FOUND'], [413, 'INVALID_ARGUMENT']]) {
      const real = fakeRes();
      const res = createDeferredSseResponse(real, {
        status: 200,
        protocol: 'gemini',
        parseError: (obj) => (obj?.error && typeof obj.error === 'object' ? obj.error : null),
        errorBody: (error, httpStatus) => ({ error: { code: httpStatus, message: error?.message, status: error?.status } }),
      });
      res.write(frame({ error: { code, status, message: 'bad request' } }));
      res.end();
      assert.equal(real.statusCode, code, status);
    }
  });

  it('derives the official body type from the classified code', () => {
    for (const [code, type] of [['MODEL_BLOCKED', 'permission_error'], ['QUOTA_EXHAUSTED', 'insufficient_quota'], ['UNAUTHORIZED', 'authentication_error'], ['CONTENT_BLOCKED', 'invalid_request_error']]) {
      const real = fakeRes();
      const res = createDeferredSseResponse(real, { status: 200 });
      res.write(`data: ${JSON.stringify({ error: { message: code, code } })}\n\n`);
      res.end();
      assert.equal(JSON.parse(real.body).error.type, type, code);
    }
  });

  it('recognizes an error frame without a space after data:', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200 });
    res.write('data:{"error":{"message":"busy","code":"RATE_LIMITED"}}\n\n');
    res.end();
    assert.equal(real.statusCode, 429);
  });

  it('commits a function_call-first frame instead of holding it', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200 });
    res.write(frame({ choices: [{ delta: { function_call: { name: 'f', arguments: '{}' } } }] }));
    assert.equal(real.statusCode, 200);
  });

  it('commits a reasoning-first frame as SSE instead of treating it as a bootstrap', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200 });
    res.write(frame({ choices: [{ delta: { reasoning_content: 'think' } }] }));
    assert.equal(real.statusCode, 200);
    res.write(frame({ error: { message: 'late', code: 'RATE_LIMITED' } }));
    res.end();
    assert.equal(real.statusCode, 200, 'a post-content error must not rewrite the status');
    assert.match(real.body, /think/);
  });

  it('flushes headers on an empty commit', () => {
    let flushed = 0;
    const real = fakeRes();
    real.flushHeaders = () => { flushed += 1; };
    const res = createDeferredSseResponse(real, { status: 200 });
    res.flushHeaders();
    assert.equal(real.statusCode, 200);
    assert.equal(flushed, 1);
  });

  it('dispose cancels a pending bootstrap timer without committing', async () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200, bootstrapTimeoutMs: 10 });
    res.dispose();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(real.statusCode, null);
    assert.equal(res.write('data: x\n\n'), false);
  });

  it('does not rewrite an error that arrives after content committed', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200 });
    const content = frame({ choices: [{ delta: { content: 'partial' } }] });
    const error = frame({ error: { message: 'died', code: 'UPSTREAM_ERROR' } });
    res.write(content);
    res.write(error);
    res.end();
    assert.equal(real.statusCode, 200);
    assert.equal(real.body, content + error);
  });

  it('holds heartbeats until a real frame arrives', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200 });
    res.write(': ping\n\n');
    assert.equal(real.statusCode, null);
    res.write(frame({ choices: [{ delta: { content: 'hi' } }] }));
    assert.equal(real.statusCode, 200);
    assert.equal(real.body.startsWith(': ping\n\n'), true);
  });

  it('commits after the bootstrap frame cap instead of buffering forever', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200, maxFrames: 3 });
    res.write(': ping\n\n');
    res.write(': ping\n\n');
    res.write(': ping\n\n');
    assert.equal(real.statusCode, null, 'three bootstrap frames are still held');
    res.write(': ping\n\n');
    assert.equal(real.statusCode, 200, 'fourth bootstrap frame commits');
  });
});

describe('createDeferredSseResponse line endings', () => {
  const errorFrame = (sep) => `event: error${sep}data: {"error":{"code":"RATE_LIMITED","message":"busy","retry_after_ms":2500}}${sep}${sep}`;

  it('maps a pre-content error frame for LF, CRLF, and CR', () => {
    for (const sep of ['\n', '\r\n', '\r']) {
      const real = fakeRes();
      const res = createDeferredSseResponse(real, { status: 200 });
      res.write(errorFrame(sep));
      res.end();
      assert.equal(real.statusCode, 429, JSON.stringify(sep));
      assert.equal(real.headers['retry-after'], '30', JSON.stringify(sep));
      assert.equal(JSON.parse(real.body).error.code, 'RATE_LIMITED', JSON.stringify(sep));
    }
  });

  it('decodes a frame that mixes legal line separators', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200 });
    res.write('event: error\r\ndata: {"error":{"code":"RATE_LIMITED","message":"busy"}}\r\n\r');
    res.end();
    assert.equal(real.statusCode, 429);
  });

  it('holds a CR-only role prime and then commits the raw SSE bytes', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const prime = 'data: {"choices":[{"delta":{"role":"assistant"}}]}\r\r';
    const content = 'data: {"choices":[{"delta":{"content":"hi"}}]}\r\r';
    res.write(prime);
    assert.equal(real.statusCode, null, 'CR-only role prime must not commit');
    res.write(content);
    res.end();
    assert.equal(real.statusCode, 200);
    assert.equal(real.headers['content-type'], 'text/event-stream');
    assert.equal(real.body, prime + content);
  });

  it('maps a bootstrap-then-error stream at every byte cut for every legal separator', () => {
    for (const sep of ['\n', '\r\n', '\r']) {
      const bytes = Buffer.from(`: prime${sep}${sep}event: error${sep}data: {"error":{"code":"RATE_LIMITED","message":"busy"}}${sep}${sep}`);
      for (let cut = 0; cut <= bytes.length; cut += 1) {
        const real = fakeRes();
        const res = createDeferredSseResponse(real, { status: 200 });
        res.write(bytes.subarray(0, cut));
        res.write(bytes.subarray(cut));
        res.end();
        assert.equal(real.statusCode, 429, `sep ${JSON.stringify(sep)} cut ${cut}`);
        assert.equal(JSON.parse(real.body).error.code, 'RATE_LIMITED', `sep ${JSON.stringify(sep)} cut ${cut}`);
      }
    }
  });

  it('does not rewrite a committed payload when a CR-only error follows', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200 });
    const content = 'data: {"choices":[{"delta":{"content":"partial"}}]}\r\r';
    const error = 'data: {"error":{"message":"died","code":"UPSTREAM_ERROR"}}\r\r';
    res.write(content);
    res.write(error);
    res.end();
    assert.equal(real.statusCode, 200);
    assert.equal(real.body, content + error);
  });

  it('commits a comment-leading frame that carries real content', () => {
    for (const sep of ['\n', '\r\n', '\r']) {
      const content = `: hello${sep}data: {"choices":[{"delta":{"content":"real"}}]}${sep}${sep}`;
      const error = `data: {"error":{"message":"late","code":"RATE_LIMITED"}}${sep}${sep}`;
      const stream = Buffer.from(content + error);
      for (let cut = 0; cut <= stream.length; cut += 1) {
        const real = fakeRes();
        const res = createDeferredSseResponse(real, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        res.write(stream.subarray(0, cut));
        res.write(stream.subarray(cut));
        res.end();
        assert.equal(real.statusCode, 200, `sep ${JSON.stringify(sep)} cut ${cut}`);
        assert.equal(real.body, content + error, `sep ${JSON.stringify(sep)} cut ${cut}`);
      }
    }
  });

  it('still holds a comment-leading role-only prime', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200 });
    const prime = ': hi\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n\n';
    const content = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
    res.write(prime);
    assert.equal(real.statusCode, null, 'role-only prime must not commit');
    res.write(content);
    res.end();
    assert.equal(real.statusCode, 200);
    assert.equal(real.body, prime + content);
  });

  it('maps a comment-leading error frame', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200 });
    res.write(': note\ndata: {"error":{"code":"RATE_LIMITED","message":"busy"}}\n\n');
    res.end();
    assert.equal(real.statusCode, 429);
  });
});

describe('createDeferredSseResponse framing edges', () => {
  it('strips a leading UTF-8 BOM so a pre-content error keeps its real status', () => {
    const body = Buffer.from('\uFEFF' + frame({ error: { message: 'busy', code: 'RATE_LIMITED', retry_after_ms: 2500 } }));
    for (let cut = 0; cut <= body.length; cut += 1) {
      const real = fakeRes();
      const res = createDeferredSseResponse(real, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      res.write(body.subarray(0, cut));
      res.write(body.subarray(cut));
      res.end();
      assert.equal(real.statusCode, 429, `cut ${cut} status`);
      assert.equal(real.headers['content-type'], 'application/json; charset=utf-8', `cut ${cut} type`);
      assert.equal(real.headers['retry-after'], '30', `cut ${cut} retry-after`);
      assert.equal(JSON.parse(real.body).error.code, 'RATE_LIMITED', `cut ${cut} body`);
    }
  });

  it('keeps frame offsets aligned when a BOM precedes a held bootstrap frame', () => {
    const stream = Buffer.from('\uFEFF' + ': prime\n\n' + frame({ error: { message: 'busy', code: 'RATE_LIMITED' } }));
    for (let cut = 0; cut <= stream.length; cut += 1) {
      const real = fakeRes();
      const res = createDeferredSseResponse(real, { status: 200 });
      res.write(stream.subarray(0, cut));
      if (cut < stream.length) assert.equal(real.statusCode, null, `cut ${cut} must hold the bootstrap`);
      res.write(stream.subarray(cut));
      res.end();
      assert.equal(real.statusCode, 429, `cut ${cut} status`);
    }
  });

  it('keeps the leading BOM on the wire when the stream commits as SSE', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const prime = '\uFEFF' + frame({ choices: [{ delta: { role: 'assistant' } }] });
    const content = frame({ choices: [{ delta: { content: 'hi' } }] });
    res.write(prime);
    assert.equal(real.statusCode, null, 'the BOM must not hide the role prime');
    res.write(content);
    res.end();
    assert.equal(real.statusCode, 200);
    assert.equal(real.body, prime + content, 'committed bytes stay byte-identical');
  });

  it('records the failure when content and error share one post-commit write', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const content = frame({ choices: [{ delta: { content: 'partial' } }] });
    const more = frame({ choices: [{ delta: { content: 'more' } }] });
    const error = frame({ error: { message: 'died', code: 'UPSTREAM_ERROR' } });
    res.write(content);
    assert.equal(real.statusCode, 200);
    res.write(more + error);
    res.end();
    assert.equal(real.statusCode, 200, 'a post-commit error must not rewrite the status');
    assert.equal(res.failure?.code, 'UPSTREAM_ERROR', 'the error frame in a multi-frame write is seen');
    assert.equal(real.body, content + more + error);
  });

  it('records a post-commit error frame split across writes at every cut', () => {
    const error = frame({ error: { message: 'died', code: 'UPSTREAM_ERROR' } });
    for (let cut = 0; cut <= error.length; cut += 1) {
      const real = fakeRes();
      const res = createDeferredSseResponse(real, { status: 200 });
      res.write(frame({ choices: [{ delta: { content: 'partial' } }] }));
      res.write(error.slice(0, cut));
      if (cut < error.length) assert.equal(res.failure, null, `cut ${cut} must not invent a failure`);
      res.write(error.slice(cut));
      res.end();
      assert.equal(res.failure?.code, 'UPSTREAM_ERROR', `cut ${cut}`);
      assert.equal(real.statusCode, 200, `cut ${cut} status`);
    }
  });

  it('holds a typed ping frame as bootstrap instead of committing', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const ping = 'event: ping\ndata: {"type":"ping"}\n\n';
    const content = frame({ choices: [{ delta: { content: 'hi' } }] });
    res.write(ping);
    assert.equal(real.statusCode, null, 'a ping frame must not commit the gate');
    res.write(content);
    res.end();
    assert.equal(real.statusCode, 200);
    assert.equal(real.body, ping + content);
  });

  it('holds bare ping and keepalive events as bootstrap', () => {
    for (const keepalive of ['event: ping\n\n', 'event: keepalive\ndata: {}\n\n', 'event: keep-alive\r\n\r\n']) {
      const real = fakeRes();
      const res = createDeferredSseResponse(real, { status: 200 });
      res.write(keepalive);
      assert.equal(real.statusCode, null, JSON.stringify(keepalive));
      res.write(frame({ error: { message: 'busy', code: 'RATE_LIMITED' } }));
      res.end();
      assert.equal(real.statusCode, 429, `${JSON.stringify(keepalive)} must not swallow the error status`);
    }
  });

  it('still maps an error carried by a ping event to its status', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, { status: 200 });
    res.write('event: ping\ndata: {"error":{"message":"busy","code":"RATE_LIMITED"}}\n\n');
    res.end();
    assert.equal(real.statusCode, 429);
    assert.equal(JSON.parse(real.body).error.code, 'RATE_LIMITED');
  });

  it('per-write inspection stays near-linear across many pending bootstrap frames (S3)', () => {
    // inspectPending used to Buffer.concat ALL pending buffers on every write:
    // N writes × O(pending bytes) → quadratic until the gate commits. A stream
    // of comment/keepalive frames (which never commit) makes the cost real.
    const real = fakeRes();
    const res = createDeferredSseResponse(real, {
      status: 200,
      maxFrames: 1e6,
      maxBytes: 8 * 1024 * 1024,
      bootstrapTimeoutMs: 0,
    });
    const comment = ':' + 'x'.repeat(4096) + '\n\n';
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) res.write(comment);
    const ms = performance.now() - t0;
    res.end();
    assert.ok(ms < 300,
      `500 pending writes took ${ms.toFixed(0)}ms — per-write full concat rescan (S3-F6)`);
  });

  it('a multibyte char split across writes does not corrupt frame scanning', () => {
    // Incremental decode must carry partial UTF-8 across writes (StringDecoder);
    // a naive per-buffer decode would emit U+FFFD and could misclassify the frame.
    const real = fakeRes();
    const wire = [];
    real.write = (c) => { wire.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8')); return true; };
    const res = createDeferredSseResponse(real, { status: 200 });
    const payload = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '中'.repeat(40) } }] }) + '\n\n';
    const buf = Buffer.from(payload, 'utf8');
    const cut = buf.indexOf(0xE4); // first byte of 中 (E4 B8 AD)
    res.write(buf.subarray(0, cut + 1));
    assert.equal(real.statusCode, null, 'incomplete frame must not commit');
    res.write(buf.subarray(cut + 1));
    res.end();
    assert.equal(real.statusCode, 200);
    assert.deepEqual(Buffer.concat(wire), buf, 'committed flush must carry the exact pending bytes');
  });
});
