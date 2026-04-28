import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'http2';
import { isCascadeTransportError } from '../src/client.js';
import { chatStreamError, isUpstreamTransientError, redactRequestLogText } from '../src/handlers/chat.js';
import { handleMessages } from '../src/handlers/messages.js';

function parseEvents(raw) {
  return raw.trim().split('\n\n').filter(Boolean).map(frame => {
    const lines = frame.split('\n');
    return {
      event: lines.find(line => line.startsWith('event: '))?.slice(7),
      data: JSON.parse(lines.find(line => line.startsWith('data: '))?.slice(6) || '{}'),
    };
  });
}

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      for (const cb of listeners.get('close') || []) cb();
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
  };
}

describe('stream error protocol', () => {
  it('creates OpenAI-style structured stream errors', () => {
    assert.deepEqual(chatStreamError('boom', 'upstream_error', 'x'), {
      error: { message: 'boom', type: 'upstream_error', code: 'x' },
    });
  });

  it('classifies Cascade HTTP/2 cancellation as upstream transient', () => {
    const err = new Error('The pending stream has been canceled (caused by: )');
    assert.equal(isCascadeTransportError(err), true);
    assert.equal(isUpstreamTransientError(err), true);
    assert.equal(isUpstreamTransientError(new Error('permission_denied: model unavailable')), false);
  });

  it('redacts common secret patterns before debug request-body logging', () => {
    const redacted = redactRequestLogText('sk-1234567890abcdefghijklmnop test@example.com Cookie: session=abc eyJabc.def.ghi AKIAABCDEFGHIJKLMNOP');
    assert.doesNotMatch(redacted, /sk-1234567890/);
    assert.doesNotMatch(redacted, /test@example\.com/);
    assert.doesNotMatch(redacted, /session=abc/);
    assert.doesNotMatch(redacted, /eyJabc\.def\.ghi/);
    assert.doesNotMatch(redacted, /AKIAABCDEFGHIJKLMNOP/);
  });

  it('translates structured chat stream errors to Anthropic error events', async () => {
    const result = await handleMessages({ model: 'claude-sonnet-4.6', stream: true, messages: [{ role: 'user', content: 'hi' }] }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.end(`data: ${JSON.stringify(chatStreamError('boom', 'upstream_error'))}\n\n`);
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assert.equal(events[0].event, 'error');
    assert.equal(events[0].data.error.message, 'boom');
  });

  it('preserves upstream_transient_error in Anthropic stream errors', async () => {
    const result = await handleMessages({ model: 'claude-sonnet-4.6', stream: true, messages: [{ role: 'user', content: 'hi' }] }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.end(`data: ${JSON.stringify(chatStreamError('cascade transport canceled', 'upstream_transient_error'))}\n\n`);
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assert.equal(events[0].event, 'error');
    assert.equal(events[0].data.error.type, 'upstream_transient_error');
  });

  it('routes oversized Connect frame parser errors to onError without throwing from data handlers', async () => {
    const previousProtocol = process.env.GRPC_PROTOCOL;
    process.env.GRPC_PROTOCOL = 'connect';
    const grpc = await import(`../src/grpc.js?connect-error-test=${Date.now()}`);

    const server = http2.createServer();
    server.on('stream', (stream) => {
      stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
      const frame = Buffer.alloc(5);
      frame[0] = 0;
      frame.writeUInt32BE(16 * 1024 * 1024 + 1, 1);
      stream.end(frame);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const err = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for parser error')), 1000);
        grpc.grpcStream(port, 'csrf', '/exa.language_server_pb.LanguageServerService/RawGetChatMessage', Buffer.from('{}'), {
          timeout: 1000,
          onData() {
            reject(new Error('unexpected data callback'));
          },
          onEnd() {
            reject(new Error('unexpected end callback'));
          },
          onError(error) {
            clearTimeout(timer);
            resolve(error);
          },
        });
      });

      assert.match(err.message, /exceeds 16777216/);
    } finally {
      grpc.closeSessionForPort(port);
      await new Promise(resolve => server.close(resolve));
      if (previousProtocol == null) delete process.env.GRPC_PROTOCOL;
      else process.env.GRPC_PROTOCOL = previousProtocol;
    }
  });
});
