import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';

const HOST = '127.0.0.1';
const FIRST_EVENT = 'data: {"part":1}\n\n';
const FINAL_EVENT = 'data: [DONE]\n\n';

// Generate a throwaway certificate with Node alone. The fixture's DER values
// are at most 255 bytes, so one additional length byte suffices.
function der(tag, ...parts) {
  const bytes = Buffer.concat(parts);
  const length = bytes.length < 128 ? [bytes.length] : [0x81, bytes.length];
  return Buffer.concat([Buffer.from([tag, ...length]), bytes]);
}

function makeTlsFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const ed25519 = Buffer.from('300506032b6570', 'hex');
  const name = der(0x30, der(0x31, der(0x30,
    Buffer.from('0603550403', 'hex'), der(0x0c, Buffer.from('localhost')),
  )));
  const validity = der(0x30,
    der(0x17, Buffer.from('200101000000Z')), der(0x17, Buffer.from('491231235959Z')),
  );
  const body = der(0x30, Buffer.from('020101', 'hex'), ed25519, name, validity, name,
    publicKey.export({ type: 'spki', format: 'der' }));
  const signature = der(0x03, Buffer.of(0), sign(null, body, privateKey));
  const cert = der(0x30, body, ed25519, signature);
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${cert.toString('base64')}\n-----END CERTIFICATE-----\n`,
  };
}

const routes = new Map();
const origin = http.createServer((req, res) => {
  const route = routes.get(req.url);
  routes.delete(req.url);
  if (route) route(req, res);
  else res.writeHead(404).end();
});
let relay;
const sockets = new Set();

function trackSockets(server) {
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
}

before(async () => {
  trackSockets(origin);
  origin.listen(0, HOST);
  await once(origin, 'listening');

  // Run the real CLI module and both native TLS protocol stacks. Supply only
  // ephemeral TLS material and force the fixture listener onto loopback.
  const { key, cert } = makeTlsFixture();
  const restore = {
    readFileSync: fs.readFileSync,
    createSecureServer: http2.createSecureServer,
    targetPort: process.env.TARGET_PORT,
  };
  fs.readFileSync = (path, ...options) => {
    if (path === './localhost+3-key.pem') return key;
    if (path === './localhost+3.pem') return cert;
    return restore.readFileSync(path, ...options);
  };
  http2.createSecureServer = (...args) => {
    relay = restore.createSecureServer(...args);
    trackSockets(relay);
    const listen = relay.listen.bind(relay);
    relay.listen = (_port, _host, callback) => listen(0, HOST, callback);
    return relay;
  };
  process.env.TARGET_PORT = String(origin.address().port);
  syncBuiltinESMExports();
  try {
    await import('../https-proxy.js');
    if (!relay.listening) await once(relay, 'listening');
    assert.equal(relay.address().address, HOST);
  } finally {
    fs.readFileSync = restore.readFileSync;
    http2.createSecureServer = restore.createSecureServer;
    if (restore.targetPort === undefined) delete process.env.TARGET_PORT;
    else process.env.TARGET_PORT = restore.targetPort;
    syncBuiltinESMExports();
  }
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all([origin, relay].filter(Boolean).map((server) =>
    new Promise((resolve) => server.close(resolve))));
});

function waitForUpload(path, startStream = true) {
  const upload = Promise.withResolvers();
  routes.set(path, (req, res) => {
    const chunks = [];
    const closed = once(res, 'close');
    req.setEncoding('utf8');
    req.on('data', (chunk) => chunks.push(chunk));
    req.once('end', () => {
      if (startStream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(FIRST_EVENT);
      }
      upload.resolve({ res, closed, body: chunks.join('') });
    });
  });
  return upload.promise;
}

function observeResponse(stream, status) {
  const firstEvent = Promise.withResolvers();
  const closed = Promise.withResolvers();
  let body = '';
  let error;
  let ended = false;
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    body += chunk;
    if (body.startsWith(FIRST_EVENT)) firstEvent.resolve();
  });
  stream.on('error', (err) => { error = err; });
  stream.once('end', () => { ended = true; });
  stream.once('close', () => closed.resolve({ body, error, ended }));
  return { status, firstEvent: firstEvent.promise, closed: closed.promise };
}

function request(t, protocol, path, body = '') {
  const method = body ? 'POST' : 'GET';
  const { port } = relay.address();
  const reply = Promise.withResolvers();
  let cancel;
  if (protocol === 'HTTP/1.1') {
    const req = https.request({
      hostname: HOST, port, path, method, rejectUnauthorized: false, agent: false,
      headers: body ? { 'content-length': Buffer.byteLength(body) } : undefined,
    }, (res) => reply.resolve(observeResponse(res, res.statusCode)));
    cancel = () => req.destroy();
    t.after(cancel);
    req.on('error', reply.reject);
    req.once('close', () => reply.resolve(undefined));
    req.end(body);
  } else {
    const session = http2.connect(`https://${HOST}:${port}`, {
      createConnection: () => tls.connect({
        host: HOST, port, ALPNProtocols: ['h2'], rejectUnauthorized: false,
      }),
    });
    session.on('error', reply.reject);
    t.after(() => { session.destroy(); });
    const req = session.request({ ':method': method, ':path': path }, { endStream: !body });
    req.once('response', (headers) => reply.resolve(observeResponse(req, headers[':status'])));
    cancel = () => req.close(http2.constants.NGHTTP2_CANCEL);
    req.on('error', reply.reject);
    req.once('close', () => reply.resolve(undefined));
    if (body) req.end(body);
  }
  return { reply: reply.promise, cancel };
}

async function openEventStream(t, protocol, path, body) {
  const upload = waitForUpload(path);
  const client = request(t, protocol, path, body);
  const downstream = await client.reply;
  assert.equal(downstream.status, 200);
  const upstream = await upload;
  await Promise.race([
    downstream.firstEvent,
    downstream.closed.then(() => assert.fail('relay closed before forwarding the first event')),
  ]);
  return { upstream, downstream, cancel: client.cancel };
}

for (const protocol of ['HTTP/1.1', 'HTTP/2']) {
  for (const [method, body] of [['GET', ''], ['POST', '{"stream":true}']]) {
    test(`${protocol} relays ${method} events after request input ends`, { timeout: 5000 }, async (t) => {
      const { upstream, downstream } = await openEventStream(t, protocol, `/${method}`, body);
      assert.equal(upstream.body, body);
      upstream.res.end(FINAL_EVENT);
      assert.deepEqual(await downstream.closed, {
        body: FIRST_EVENT + FINAL_EVENT, error: undefined, ended: true,
      });
    });
  }

  test(`${protocol} client cancellation closes the active origin response`, { timeout: 5000 }, async (t) => {
    const { upstream, cancel } = await openEventStream(t, protocol, '/cancel', '{"stream":true}');
    cancel();
    await upstream.closed;
    assert.equal(upstream.res.writableFinished, false);
  });

  test(`${protocol} client cancellation closes the origin while waiting for headers`, { timeout: 5000 }, async (t) => {
    const upload = waitForUpload('/cancel-before-headers', false);
    const client = request(t, protocol, '/cancel-before-headers');
    const reply = client.reply.catch((error) => {
      assert.equal(error.code, 'ECONNRESET');
    });
    const upstream = await upload;
    client.cancel();
    await upstream.closed;
    assert.equal(upstream.res.writableFinished, false);
    assert.equal(await reply, undefined);
  });

  test(`${protocol} relays a JSON 502 when the origin disconnects before headers`, { timeout: 5000 }, async (t) => {
    const upload = waitForUpload('/origin-before-headers', false);
    const client = request(t, protocol, '/origin-before-headers');
    const upstream = await upload;
    upstream.res.destroy();
    const downstream = await client.reply;
    assert.equal(downstream.status, 502);
    const terminal = await downstream.closed;
    assert.equal(terminal.ended, true);
    assert.equal(terminal.error, undefined);
    assert.deepEqual(JSON.parse(terminal.body), { error: { message: 'Bad Gateway', type: 'proxy_error' } });
  });

  test(`${protocol} signals failure when the origin truncates a response`, { timeout: 5000 }, async (t) => {
    const { upstream, downstream } = await openEventStream(t, protocol, '/truncated');
    upstream.res.destroy();
    const result = await downstream.closed;
    assert.equal(result.body, FIRST_EVENT);
    assert.equal(result.error?.code, protocol === 'HTTP/1.1' ? 'ECONNRESET' : 'ERR_HTTP2_STREAM_ERROR');
  });
}
