import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'windsurfapi-codex-'));

const sticky = await import('../src/sticky-sessions.js');
const runtime = await import('../src/runtime-config.js');
const ws = await import('../src/ws-responses.js');
const auth = await import('../src/auth.js');
const configModule = await import('../src/config.js');

const originalApiKey = configModule.config.apiKey;
const originalLogInfo = configModule.log.info;
const createdAccountIds = [];

afterEach(() => {
  configModule.config.apiKey = originalApiKey;
  configModule.log.info = originalLogInfo;
  ws._test.resetHandleResponsesForTest();
  ws._test.clearResponseOwnersForTest();
  auth.configureBindHost('0.0.0.0');
  while (createdAccountIds.length) auth.removeAccount(createdAccountIds.pop());
});

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.ended = false;
    this.destroyed = false;
    this.timeoutMs = null;
    this.timeoutCb = null;
  }

  write(chunk) {
    this.writes.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)));
    return true;
  }

  end() {
    this.ended = true;
    this.emit('close');
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }

  setTimeout(ms, cb) {
    this.timeoutMs = ms;
    this.timeoutCb = cb;
    return this;
  }
}

function enableWebSocketAuth() {
  configModule.config.apiKey = 'ws-test-secret';
  auth.configureBindHost('0.0.0.0');
  const account = auth.addAccountByKey(`ws-account-${Date.now()}-${Math.random()}`, 'ws-test');
  createdAccountIds.push(account.id);
}

function upgradeReq(headers = {}) {
  return {
    method: 'GET',
    url: '/backend-api/codex/responses',
    headers: {
      authorization: 'Bearer ws-test-secret',
      connection: 'keep-alive, Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      ...headers,
    },
    socket: { remoteAddress: '127.0.0.1' },
    connection: { remoteAddress: '127.0.0.1' },
  };
}

function maskedClientFrame(payload, { opcode = 0x1, fin = true } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const mask = Buffer.from([1, 2, 3, 4]);
  let header;
  if (body.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | body.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  }
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function maskedLengthOnlyFrame(len, { opcode = 0x1 } = {}) {
  const mask = Buffer.from([1, 2, 3, 4]);
  if (len <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    return Buffer.concat([header, mask]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(len), 2);
  return Buffer.concat([header, mask]);
}

function decodeServerTextFrame(frame) {
  let offset = 2;
  let len = frame[1] & 0x7f;
  if (len === 126) {
    len = frame.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    len = Number(frame.readBigUInt64BE(offset));
    offset += 8;
  }
  return frame.subarray(offset, offset + len).toString('utf8');
}

async function waitForWrites(socket, count) {
  for (let i = 0; i < 50; i++) {
    if (socket.writes.length >= count) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail(`expected ${count} socket writes, got ${socket.writes.length}`);
}

function decodeCloseFrame(frame) {
  assert.equal(frame[0] & 0x0f, 0x8);
  let offset = 2;
  let len = frame[1] & 0x7f;
  if (len === 126) {
    len = frame.readUInt16BE(offset);
    offset += 2;
  }
  const payload = frame.subarray(offset, offset + len);
  return {
    code: payload.length >= 2 ? payload.readUInt16BE(0) : null,
    reason: payload.subarray(2).toString('utf8'),
  };
}

test('Codex sticky context prefers turn-state headers in auto mode', () => {
  runtime.setCodexSettings({
    stickySessionsEnabled: true,
    stickySessionMode: 'auto',
    derivePromptCacheKey: true,
    promptCacheMaxAgeSeconds: 1800,
  });
  const ctx = sticky.buildStickyContext(
    { model: 'gpt-5.4', input: 'hello', prompt_cache_key: 'pc-1' },
    { 'x-codex-turn-state': 'turn-abc' },
    'api:test',
  );
  assert.equal(ctx.kind, 'codex_session');
  assert.equal(ctx.key, 'turn-abc');
});

test('Codex sticky store preserves prompt-cache mapping during fallback', () => {
  sticky.clearStickySessions();
  runtime.setCodexSettings({
    stickySessionsEnabled: true,
    stickySessionMode: 'prompt_cache',
    derivePromptCacheKey: false,
    reallocateSticky: false,
  });
  const ctx = sticky.buildStickyContext({ model: 'gpt-5.4', input: 'hello', prompt_cache_key: 'pc-2' }, {}, 'api:test');
  assert.ok(ctx);
  assert.equal(sticky.getStickyAccountId(ctx), null);
  assert.equal(sticky.bindStickyAccount(ctx, 'acct-a'), true);
  assert.equal(sticky.getStickyAccountId(ctx), 'acct-a');
  assert.equal(sticky.shouldPreserveStickyFallback(ctx, 'acct-a', 'acct-b'), true);
  assert.equal(sticky.bindStickyAccount(ctx, 'acct-b', { preserveExisting: true }), false);
  assert.equal(sticky.getStickyAccountId(ctx), 'acct-a');
});

test('Responses WebSocket accepts response.create wrapper and forces streaming', () => {
  const normalized = ws._test.normalizeResponseCreatePayload({
    type: 'response.create',
    response: {
      model: 'gpt-5.4',
      input: 'hello',
      stream: false,
    },
  });
  assert.deepEqual(normalized, {
    model: 'gpt-5.4',
    input: 'hello',
    stream: true,
  });
  assert.equal(ws._test.normalizeResponseCreatePayload({ model: 'gpt-5.4', input: 'raw' }), null);
});

test('Responses WebSocket performs a real 101 upgrade and processes initial head bytes', () => {
  enableWebSocketAuth();
  runtime.setCodexSettings({ websocketEnabled: true });
  const socket = new FakeSocket();

  const handled = ws.handleResponsesWebSocketUpgrade(
    upgradeReq({ 'x-codex-turn-state': 'turn-existing' }),
    socket,
    maskedClientFrame('{not-json'),
  );

  assert.equal(handled, true);
  const handshake = socket.writes[0].toString('utf8');
  assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.match(handshake, /Upgrade: websocket/i);
  assert.match(handshake, /Connection: Upgrade/i);
  assert.match(handshake, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
  assert.match(handshake, /x-codex-turn-state: turn-existing/);

  const errorFrame = JSON.parse(decodeServerTextFrame(socket.writes[1]));
  assert.equal(errorFrame.type, 'error');
  assert.equal(errorFrame.status, 400);
  assert.equal(errorFrame.error.type, 'invalid_request_error');
});

test('Responses WebSocket rejects raw no-type payloads with status errors', async () => {
  enableWebSocketAuth();
  runtime.setCodexSettings({ websocketEnabled: true });
  const socket = new FakeSocket();
  let called = false;
  ws._test.setHandleResponsesForTest(async () => {
    called = true;
    return { status: 200, body: {} };
  });

  ws.handleResponsesWebSocketUpgrade(
    upgradeReq(),
    socket,
    maskedClientFrame(JSON.stringify({ model: 'gpt-5.4', input: 'raw' })),
  );
  await waitForWrites(socket, 2);

  const errorFrame = JSON.parse(decodeServerTextFrame(socket.writes[1]));
  assert.equal(called, false);
  assert.equal(errorFrame.type, 'error');
  assert.equal(errorFrame.status, 400);
  assert.equal(errorFrame.error.type, 'invalid_request_error');
});

test('Responses WebSocket processes sequential response.create messages on one socket', async () => {
  enableWebSocketAuth();
  runtime.setCodexSettings({ websocketEnabled: true });
  const socket = new FakeSocket();
  const calls = [];
  const logs = [];
  configModule.log.info = (line) => logs.push(String(line));
  ws._test.setHandleResponsesForTest(async (body, { context }) => {
    calls.push(body.input);
    context.__selectedAccountId = 'acct-seq';
    const id = `resp_seq_${calls.length}`;
    return {
      status: 200,
      stream: true,
      context,
      async handler(res) {
        res.write(`data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id,
            model: body.model,
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          },
        })}\n\n`);
        res.end();
      },
    };
  });

  ws.handleResponsesWebSocketUpgrade(upgradeReq(), socket, Buffer.alloc(0));
  socket.emit('data', maskedClientFrame(JSON.stringify({ type: 'response.create', response: { model: 'gpt-5.4', input: 'one' } })));
  socket.emit('data', maskedClientFrame(JSON.stringify({ type: 'response.create', response: { model: 'gpt-5.4', input: 'two' } })));
  await waitForWrites(socket, 3);

  assert.deepEqual(calls, ['one', 'two']);
  const first = JSON.parse(decodeServerTextFrame(socket.writes[1]));
  const second = JSON.parse(decodeServerTextFrame(socket.writes[2]));
  assert.equal(first.response.id, 'resp_seq_1');
  assert.equal(second.response.id, 'resp_seq_2');
  const requestLogs = logs
    .filter(line => line.includes('ResponsesWS '))
    .map(line => JSON.parse(line.slice(line.indexOf('{'))));
  assert.equal(requestLogs.length, 2);
  assert.equal(requestLogs[0].transport, 'websocket');
  assert.equal(requestLogs[0].status, 200);
  assert.deepEqual(requestLogs[0].usage, { input_tokens: 1, output_tokens: 2, total_tokens: 3 });
});

test('Responses WebSocket pins previous_response_id follow-ups to the original account', async () => {
  enableWebSocketAuth();
  runtime.setCodexSettings({ websocketEnabled: true });
  const socket = new FakeSocket();
  const contexts = [];
  ws._test.setHandleResponsesForTest(async (body, { context }) => {
    contexts.push({ preferredAccountId: context.preferredAccountId, requirePreferredAccount: context.requirePreferredAccount });
    context.__selectedAccountId = context.preferredAccountId || 'acct-original';
    const id = body.previous_response_id ? 'resp_followup' : 'resp_original';
    return {
      status: 200,
      stream: true,
      context,
      async handler(res) {
        res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id, model: body.model } })}\n\n`);
        res.end();
      },
    };
  });

  ws.handleResponsesWebSocketUpgrade(upgradeReq(), socket, Buffer.alloc(0));
  socket.emit('data', maskedClientFrame(JSON.stringify({ type: 'response.create', response: { model: 'gpt-5.4', input: 'one' } })));
  await waitForWrites(socket, 2);
  socket.emit('data', maskedClientFrame(JSON.stringify({
    type: 'response.create',
    response: { model: 'gpt-5.4', input: 'two', previous_response_id: 'resp_original' },
  })));
  await waitForWrites(socket, 3);

  assert.deepEqual(contexts[0], { preferredAccountId: undefined, requirePreferredAccount: undefined });
  assert.deepEqual(contexts[1], { preferredAccountId: 'acct-original', requirePreferredAccount: true });
  const followup = JSON.parse(decodeServerTextFrame(socket.writes[2]));
  assert.equal(followup.response.id, 'resp_followup');
});

test('Responses WebSocket rejects unknown previous_response_id with status', async () => {
  enableWebSocketAuth();
  runtime.setCodexSettings({ websocketEnabled: true });
  const socket = new FakeSocket();
  let called = false;
  ws._test.setHandleResponsesForTest(async () => {
    called = true;
    return { status: 200, body: {} };
  });

  ws.handleResponsesWebSocketUpgrade(
    upgradeReq(),
    socket,
    maskedClientFrame(JSON.stringify({
      type: 'response.create',
      response: { model: 'gpt-5.4', input: 'two', previous_response_id: 'resp_missing' },
    })),
  );
  await waitForWrites(socket, 2);

  const errorFrame = JSON.parse(decodeServerTextFrame(socket.writes[1]));
  assert.equal(called, false);
  assert.equal(errorFrame.type, 'error');
  assert.equal(errorFrame.status, 409);
  assert.equal(errorFrame.error.code, 'previous_response_not_found');
});

test('Responses WebSocket surfaces unavailable previous response owner as status error', async () => {
  enableWebSocketAuth();
  runtime.setCodexSettings({ websocketEnabled: true });
  const socket = new FakeSocket();
  ws._test.setHandleResponsesForTest(async (body, { context }) => {
    if (body.previous_response_id) {
      return {
        status: 409,
        context,
        body: {
          error: {
            message: 'Previous response owner account is unavailable; retry later.',
            type: 'previous_response_unavailable',
          },
        },
      };
    }
    context.__selectedAccountId = 'acct-original';
    return {
      status: 200,
      stream: true,
      context,
      async handler(res) {
        res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_original', model: body.model } })}\n\n`);
        res.end();
      },
    };
  });

  ws.handleResponsesWebSocketUpgrade(upgradeReq(), socket, Buffer.alloc(0));
  socket.emit('data', maskedClientFrame(JSON.stringify({ type: 'response.create', response: { model: 'gpt-5.4', input: 'one' } })));
  await waitForWrites(socket, 2);
  socket.emit('data', maskedClientFrame(JSON.stringify({
    type: 'response.create',
    response: { model: 'gpt-5.4', input: 'two', previous_response_id: 'resp_original' },
  })));
  await waitForWrites(socket, 3);

  const errorFrame = JSON.parse(decodeServerTextFrame(socket.writes[2]));
  assert.equal(errorFrame.type, 'error');
  assert.equal(errorFrame.status, 409);
  assert.equal(errorFrame.error.type, 'previous_response_unavailable');
});

test('Responses WebSocket emits response.failed when stream ends without completion', async () => {
  enableWebSocketAuth();
  runtime.setCodexSettings({ websocketEnabled: true });
  const socket = new FakeSocket();
  const logs = [];
  configModule.log.info = (line) => logs.push(String(line));
  ws._test.setHandleResponsesForTest(async (body, { context }) => {
    context.__selectedAccountId = 'acct-incomplete';
    return {
      status: 200,
      stream: true,
      context,
      async handler(res) {
        res.write(`data: ${JSON.stringify({
          type: 'response.created',
          response: {
            id: 'resp_incomplete',
            model: body.model,
            created_at: 123,
          },
        })}\n\n`);
        res.end();
      },
    };
  });

  ws.handleResponsesWebSocketUpgrade(
    upgradeReq(),
    socket,
    maskedClientFrame(JSON.stringify({ type: 'response.create', response: { model: 'gpt-5.4', input: 'one' } })),
  );
  await waitForWrites(socket, 3);

  const failed = JSON.parse(decodeServerTextFrame(socket.writes[2]));
  assert.equal(failed.type, 'response.failed');
  assert.equal(failed.response.id, 'resp_incomplete');
  assert.equal(failed.response.error.code, 'stream_incomplete');
  assert.match(failed.response.error.message, /before response\.completed/);
  const requestLog = logs
    .filter(line => line.includes('ResponsesWS '))
    .map(line => JSON.parse(line.slice(line.indexOf('{'))))[0];
  assert.equal(requestLog.status, 502);
  assert.equal(requestLog.error, 'Response stream ended before response.completed');
});

test('Responses WebSocket emits response.failed when a started stream throws', async () => {
  enableWebSocketAuth();
  runtime.setCodexSettings({ websocketEnabled: true });
  const socket = new FakeSocket();
  ws._test.setHandleResponsesForTest(async (body, { context }) => {
    context.__selectedAccountId = 'acct-throw';
    return {
      status: 200,
      stream: true,
      context,
      async handler(res) {
        res.write(`data: ${JSON.stringify({
          type: 'response.created',
          response: { id: 'resp_throw', model: body.model },
        })}\n\n`);
        throw new Error('upstream dropped');
      },
    };
  });

  ws.handleResponsesWebSocketUpgrade(
    upgradeReq(),
    socket,
    maskedClientFrame(JSON.stringify({ type: 'response.create', response: { model: 'gpt-5.4', input: 'one' } })),
  );
  await waitForWrites(socket, 3);

  const failed = JSON.parse(decodeServerTextFrame(socket.writes[2]));
  assert.equal(failed.type, 'response.failed');
  assert.equal(failed.response.id, 'resp_throw');
  assert.equal(failed.response.error.code, 'stream_error');
  assert.equal(failed.response.error.message, 'upstream dropped');
});

test('Responses WebSocket sanitizes reflected turn-state handshake headers', () => {
  enableWebSocketAuth();
  runtime.setCodexSettings({ websocketEnabled: true });
  const socket = new FakeSocket();

  ws.handleResponsesWebSocketUpgrade(
    upgradeReq({ 'x-codex-turn-state': 'turn-good\r\nx-injected: yes' }),
    socket,
    Buffer.alloc(0),
  );

  const handshake = socket.writes[0].toString('utf8');
  assert.doesNotMatch(handshake, /x-injected/i);
  assert.doesNotMatch(handshake, /turn-good\r\n/);
  assert.match(handshake, /x-codex-turn-state: turn_[a-f0-9]{32}/);
});

test('Responses WebSocket closes oversized frames with 1009', () => {
  enableWebSocketAuth();
  runtime.setCodexSettings({ websocketEnabled: true });
  const socket = new FakeSocket();

  ws.handleResponsesWebSocketUpgrade(
    upgradeReq(),
    socket,
    maskedLengthOnlyFrame(16 * 1024 * 1024 + 1),
  );

  const close = decodeCloseFrame(socket.writes[1]);
  assert.equal(close.code, 1009);
});

test('Responses WebSocket closes invalid UTF-8 text frames with 1007', () => {
  enableWebSocketAuth();
  runtime.setCodexSettings({ websocketEnabled: true });
  const socket = new FakeSocket();

  ws.handleResponsesWebSocketUpgrade(
    upgradeReq(),
    socket,
    maskedClientFrame(Buffer.from([0xff]), { opcode: 0x1 }),
  );

  const close = decodeCloseFrame(socket.writes[1]);
  assert.equal(close.code, 1007);
  assert.equal(close.reason, 'Invalid payload data');
});

test('Responses WebSocket rejects reserved control opcodes', () => {
  enableWebSocketAuth();
  runtime.setCodexSettings({ websocketEnabled: true });
  const socket = new FakeSocket();

  ws.handleResponsesWebSocketUpgrade(
    upgradeReq(),
    socket,
    maskedClientFrame(Buffer.alloc(0), { opcode: 0xB }),
  );

  const close = decodeCloseFrame(socket.writes[1]);
  assert.equal(close.code, 1002);
});

test('Responses WebSocket closes messages with too many fragments', () => {
  enableWebSocketAuth();
  runtime.setCodexSettings({ websocketEnabled: true });
  const socket = new FakeSocket();

  ws.handleResponsesWebSocketUpgrade(
    upgradeReq(),
    socket,
    maskedClientFrame('{', { opcode: 0x1, fin: false }),
  );
  for (let i = 0; i < 4096 && !socket.ended; i++) {
    socket.emit('data', maskedClientFrame('', { opcode: 0x0, fin: false }));
  }

  const close = decodeCloseFrame(socket.writes[1]);
  assert.equal(close.code, 1002);
});

test('Responses WebSocket rejects non-canonical Sec-WebSocket-Key', () => {
  enableWebSocketAuth();
  const socket = new FakeSocket();

  ws.handleResponsesWebSocketUpgrade(
    upgradeReq({ 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==\n' }),
    socket,
    Buffer.alloc(0),
  );

  assert.match(socket.writes[0].toString('utf8'), /^HTTP\/1\.1 400 Invalid Sec-WebSocket-Key/);
});

test('Responses WebSocket installs and honors an idle timeout', () => {
  enableWebSocketAuth();
  runtime.setCodexSettings({ websocketEnabled: true });
  const socket = new FakeSocket();

  ws.handleResponsesWebSocketUpgrade(upgradeReq(), socket, Buffer.alloc(0));

  assert.equal(socket.timeoutMs, 5 * 60 * 1000);
  socket.timeoutCb();
  const close = decodeCloseFrame(socket.writes[1]);
  assert.equal(close.code, 1000);
  assert.equal(close.reason, 'Idle timeout');
});

test('Responses WebSocket version rejection advertises supported version', () => {
  enableWebSocketAuth();
  const socket = new FakeSocket();

  ws.handleResponsesWebSocketUpgrade(
    upgradeReq({ 'sec-websocket-version': '12' }),
    socket,
    Buffer.alloc(0),
  );

  const response = socket.writes[0].toString('utf8');
  assert.match(response, /^HTTP\/1\.1 426 Unsupported WebSocket Version/);
  assert.match(response, /Sec-WebSocket-Version: 13/i);
});

test('Responses WebSocket rejects non-WebSocket HTTP before pretending to stream', () => {
  enableWebSocketAuth();
  const socket = new FakeSocket();
  const req = upgradeReq({ connection: 'keep-alive', upgrade: '' });

  const handled = ws.handleResponsesWebSocketUpgrade(req, socket, Buffer.alloc(0));

  assert.equal(handled, true);
  assert.match(socket.writes[0].toString('utf8'), /^HTTP\/1\.1 400 Invalid WebSocket upgrade/);
  assert.equal(socket.destroyed, true);
});

test('nginx forwards WebSocket upgrade headers to the Node server', () => {
  const conf = readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8');
  assert.match(conf, /map\s+\$http_upgrade\s+\$connection_upgrade/);
  assert.match(conf, /proxy_set_header\s+Upgrade\s+\$http_upgrade;/);
  assert.match(conf, /proxy_set_header\s+Connection\s+\$connection_upgrade;/);
  assert.match(conf, /location\s+~\s+\^\/\(v1\/\(ws\/\)\?responses\|backend-api\/codex\/responses\)\$/);
  assert.match(conf, /location\s+~[\s\S]+proxy_read_timeout\s+3600s;/);
});
