// Outbound proxy connector: an HTTPS proxy selection must be a
// certificate-verified TLS first hop before CONNECT / Proxy-Authorization is
// sent. HTTP and SOCKS selections keep their documented transports.
//
// The proxy servers here are loopback fixtures with synthetic certificates.
// Trust is injected by adding the fixture CA to tls.connect for the duration of
// a test; verification itself is never disabled. Every consumer assertion is
// behavioural: the proxy only ever sees a decrypted CONNECT if the client
// actually completed the TLS handshake first.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { createProxyTunnel, proxyScheme } from '../src/proxy-connector.js';
import { config } from '../src/config.js';
import { testProxy } from '../src/dashboard/api.js';
import { probeLoginMethod } from '../src/dashboard/windsurf-login.js';
import { sendEmailVerification } from '../src/dashboard/email-otp-login.js';
import { getUserStatus } from '../src/windsurf-api.js';
import { proxyUrl } from '../src/langserver.js';
import { CERT_A, KEY_A, CERT_B, KEY_B } from './helpers/tls-proxy-certs.mjs';

let savedAllowPrivate;
before(() => {
  savedAllowPrivate = config.allowPrivateProxyHosts;
  config.allowPrivateProxyHosts = true; // loopback fixtures only
});
after(() => { config.allowPrivateProxyHosts = savedAllowPrivate; });

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

async function closeServer(server, state) {
  for (const socket of state?.sockets || []) {
    try { socket.destroy(); } catch {}
  }
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

// TLS proxy fixture. `onConnect(socket, head, rest)` runs after a full CONNECT
// header was decrypted; without it the proxy answers 407 and closes.
function startTlsProxy(cert, key, onConnect) {
  const state = { requests: [], sockets: new Set(), tlsErrors: [] };
  const server = tls.createServer({ cert, key }, (socket) => {
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = buf.subarray(0, idx + 4).toString('latin1');
      const rest = buf.subarray(idx + 4);
      state.requests.push(head);
      socket.removeListener('data', onData);
      if (onConnect) onConnect(socket, head, rest);
      else socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
    };
    socket.on('data', onData);
  });
  server.on('tlsClientError', (err) => state.tlsErrors.push(err));
  return { server, state };
}

// TCP forwarder that records every client→proxy byte, so a test can prove the
// CONNECT request and its credentials never appear on the plaintext wire.
function startForwarder(targetPort) {
  const state = { clientChunks: [], sockets: new Set() };
  const server = net.createServer((client) => {
    state.sockets.add(client);
    const upstream = net.connect(targetPort, '127.0.0.1');
    state.sockets.add(upstream);
    client.on('data', (chunk) => {
      state.clientChunks.push(Buffer.from(chunk));
      upstream.write(chunk);
    });
    upstream.on('data', (chunk) => client.write(chunk));
    const teardown = () => { client.destroy(); upstream.destroy(); };
    client.on('close', teardown);
    upstream.on('close', teardown);
    client.on('error', teardown);
    upstream.on('error', teardown);
  });
  return { server, state };
}

function wireText(forwarder) {
  return Buffer.concat(forwarder.state.clientChunks).toString('latin1');
}

function startPlainConnectProxy(handler) {
  const state = { requests: [], sockets: new Set() };
  const server = net.createServer((socket) => {
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = buf.subarray(0, idx + 4).toString('latin1');
      const rest = buf.subarray(idx + 4);
      state.requests.push(head);
      socket.removeListener('data', onData);
      handler(socket, head, rest);
    };
    socket.on('data', onData);
  });
  return { server, state };
}

// Minimal SOCKS5 server: no-auth or username/password, one CONNECT, then echo.
function startSocksProxy() {
  const state = { greeting: null, auth: null, connect: null, sockets: new Set() };
  const server = net.createServer((socket) => {
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    socket.on('error', () => {});
    let phase = 'greeting';
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      if (phase === 'tunnel') {
        socket.write(Buffer.concat([Buffer.from('socks:'), chunk]));
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      if (phase === 'greeting') {
        if (buf.length < 2) return;
        const count = buf[1];
        if (buf.length < 2 + count) return;
        state.greeting = Buffer.from(buf.subarray(0, 2 + count));
        buf = buf.subarray(2 + count);
        const offersUserPass = [...state.greeting.subarray(2)].includes(0x02);
        if (offersUserPass) {
          socket.write(Buffer.from([0x05, 0x02]));
          phase = 'auth';
        } else {
          socket.write(Buffer.from([0x05, 0x00]));
          phase = 'connect';
        }
        return;
      }
      if (phase === 'auth') {
        if (buf.length < 2) return;
        const userLen = buf[1];
        if (buf.length < 2 + userLen + 1) return;
        const passLen = buf[2 + userLen];
        if (buf.length < 2 + userLen + 1 + passLen) return;
        state.auth = Buffer.from(buf.subarray(0, 3 + userLen + passLen));
        buf = buf.subarray(3 + userLen + passLen);
        socket.write(Buffer.from([0x01, 0x00]));
        phase = 'connect';
        return;
      }
      if (phase === 'connect') {
        if (buf.length < 5) return;
        const atyp = buf[3];
        const need = atyp === 0x01 ? 10 : atyp === 0x03 ? 7 + buf[4] : 22;
        if (buf.length < need) return;
        state.connect = Buffer.from(buf.subarray(0, need));
        buf = buf.subarray(need);
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
        phase = 'tunnel';
      }
    });
  });
  return { server, state };
}

// Trust-injection for loopback fixtures: add the synthetic CA to tls.connect
// calls aimed at this exact proxy port. rejectUnauthorized stays true.
function trustProxyCert(port) {
  const real = tls.connect;
  tls.connect = (options, callback) => real(
    options.host === '127.0.0.1' && options.port === port
      ? { ...options, ca: CERT_A }
      : options,
    callback,
  );
  return () => { tls.connect = real; };
}

describe('proxy connector — HTTPS first hop', () => {
  it('verifies TLS to the proxy before CONNECT/auth, then tunnels', async () => {
    const proxy = startTlsProxy(CERT_A, KEY_A, (socket) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.on('data', (data) => socket.write(Buffer.concat([Buffer.from('echo:'), data])));
    });
    const proxyPort = await listen(proxy.server);
    const forwarder = startForwarder(proxyPort);
    const forwarderPort = await listen(forwarder.server);
    try {
      const socket = await createProxyTunnel(
        { type: 'https', host: '127.0.0.1', port: forwarderPort, username: 'alice', password: 's3cret' },
        'example.com', 443,
        { tlsOptions: { ca: CERT_A }, timeoutMs: 3000 },
      );
      const wire = wireText(forwarder);
      assert.ok(!wire.includes('CONNECT '), 'CONNECT must not be written before the TLS handshake');
      assert.ok(!wire.includes('Proxy-Authorization'), 'proxy auth must not appear on the plaintext wire');
      assert.equal(proxy.state.requests.length, 1);
      assert.match(proxy.state.requests[0], /^CONNECT example\.com:443 HTTP\/1\.1\r\n/);
      assert.match(proxy.state.requests[0], /Proxy-Authorization: Basic /);

      socket.write('ping');
      const [data] = await once(socket, 'data');
      assert.equal(data.toString(), 'echo:ping');
      socket.destroy();
    } finally {
      await closeServer(forwarder.server, forwarder.state);
      await closeServer(proxy.server, proxy.state);
    }
  });

  it('preserves bare and bracketed IPv6 proxy addresses through verified TLS and CONNECT', async (t) => {
    const proxy = startTlsProxy(CERT_A, KEY_A, (socket) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.on('data', data => socket.write(Buffer.concat([Buffer.from('ipv6:'), data])));
    });
    let port;
    try {
      port = await listen(proxy.server, '::1');
    } catch (err) {
      if (['EAFNOSUPPORT', 'EPROTONOSUPPORT', 'EADDRNOTAVAIL'].includes(err.code)) {
        t.skip(`IPv6 loopback unavailable on this platform: ${err.code}`);
        return;
      }
      throw err;
    }
    try {
      for (const host of ['::1', '[::1]']) {
        const socket = await createProxyTunnel(
          { type: 'https', host, port, username: 'alice', password: 'fixture-ipv6' },
          'example.com', 443,
          { tlsOptions: { ca: CERT_A }, timeoutMs: 3000 },
        );
        assert.equal(socket.authorized, true, `${host}: verify the IPv6 IP SAN`);
        const received = once(socket, 'data');
        socket.write('ping');
        const [data] = await received;
        assert.equal(data.toString(), 'ipv6:ping', `${host}: tunnel carries bytes`);
        socket.destroy();
        assert.ok(await waitUntil(() => proxy.state.sockets.size === 0), `${host}: release the tunnel`);
      }
      assert.equal(proxy.state.requests.length, 2, 'both accepted address spellings reach CONNECT');
      for (const request of proxy.state.requests) {
        assert.match(request, /^CONNECT example\.com:443 HTTP\/1\.1\r\n/);
        assert.match(request, /Proxy-Authorization: Basic /);
      }
    } finally {
      await closeServer(proxy.server, proxy.state);
    }
  });

  it('rejects a trusted DNS-only certificate for an IPv6 proxy before CONNECT or auth', async (t) => {
    const proxy = startTlsProxy(CERT_B, KEY_B);
    let port;
    try {
      port = await listen(proxy.server, '::1');
    } catch (err) {
      if (['EAFNOSUPPORT', 'EPROTONOSUPPORT', 'EADDRNOTAVAIL'].includes(err.code)) {
        t.skip(`IPv6 loopback unavailable on this platform: ${err.code}`);
        return;
      }
      throw err;
    }
    try {
      for (const host of ['::1', '[::1]']) {
        await assert.rejects(
          createProxyTunnel(
            { type: 'https', host, port, username: 'alice', password: 'fixture-ipv6-rejected' },
            'example.com', 443,
            { tlsOptions: { ca: CERT_B }, timeoutMs: 3000 },
          ),
          err => err.code === 'ERR_PROXY_TLS' && err.cause?.code === 'ERR_TLS_CERT_ALTNAME_INVALID',
        );
        assert.ok(await waitUntil(() => proxy.state.sockets.size === 0), `${host}: release rejected TLS socket`);
      }
      assert.equal(proxy.state.requests.length, 0, 'a trusted wrong-SAN certificate receives no CONNECT or auth');
    } finally {
      await closeServer(proxy.server, proxy.state);
    }
  });

  it('sends no CONNECT or auth when the proxy certificate hostname does not match', async () => {
    // CERT_B is trusted but only names localhost; dialing 127.0.0.1 must fail.
    const proxy = startTlsProxy(CERT_B, KEY_B);
    const proxyPort = await listen(proxy.server);
    const forwarder = startForwarder(proxyPort);
    const forwarderPort = await listen(forwarder.server);
    try {
      await assert.rejects(
        createProxyTunnel(
          { type: 'https', host: '127.0.0.1', port: forwarderPort, username: 'alice', password: 's3cret' },
          'example.com', 443,
          { tlsOptions: { ca: CERT_B }, timeoutMs: 3000 },
        ),
        (err) => err.code === 'ERR_PROXY_TLS' && /altname|does not match/i.test(err.message),
      );
      assert.equal(proxy.state.requests.length, 0, 'no CONNECT may reach the proxy');
      const wire = wireText(forwarder);
      assert.ok(!wire.includes('CONNECT '), 'CONNECT must not appear on the wire');
      assert.ok(!wire.includes('Proxy-Authorization'), 'auth must not appear on the wire');
    } finally {
      await closeServer(forwarder.server, forwarder.state);
      await closeServer(proxy.server, proxy.state);
    }
  });

  it('sends no CONNECT or auth when the proxy certificate is not trusted', async () => {
    const proxy = startTlsProxy(CERT_A, KEY_A);
    const proxyPort = await listen(proxy.server);
    const forwarder = startForwarder(proxyPort);
    const forwarderPort = await listen(forwarder.server);
    try {
      await assert.rejects(
        createProxyTunnel(
          { type: 'https', host: '127.0.0.1', port: forwarderPort, username: 'alice', password: 's3cret' },
          'example.com', 443,
          { timeoutMs: 3000 }, // no CA: verification must reject
        ),
        (err) => err.code === 'ERR_PROXY_TLS' && /self.signed|unable to verify|certificate/i.test(err.message),
      );
      assert.equal(proxy.state.requests.length, 0);
      assert.ok(!wireText(forwarder).includes('CONNECT '));
    } finally {
      await closeServer(forwarder.server, forwarder.state);
      await closeServer(proxy.server, proxy.state);
    }
  });

  it('times out a silent CONNECT inside TLS and releases the socket', async () => {
    const proxy = startTlsProxy(CERT_A, KEY_A, () => { /* read CONNECT, never answer */ });
    const proxyPort = await listen(proxy.server);
    try {
      const started = Date.now();
      await assert.rejects(
        createProxyTunnel(
          { type: 'https', host: '127.0.0.1', port: proxyPort },
          'example.com', 443,
          { tlsOptions: { ca: CERT_A }, timeoutMs: 200 },
        ),
        (err) => err.code === 'ERR_PROXY_CONNECT_TIMEOUT',
      );
      assert.ok(Date.now() - started < 3000, 'timeout must not hang');
      assert.ok(await waitUntil(() => proxy.state.sockets.size === 0), 'proxy socket must close');
    } finally {
      await closeServer(proxy.server, proxy.state);
    }
  });

  it('times out a stalled TLS handshake and releases the socket', async () => {
    const state = { sockets: new Set() };
    const server = net.createServer((socket) => {
      state.sockets.add(socket);
      socket.on('close', () => state.sockets.delete(socket));
      socket.on('data', () => { /* swallow ClientHello, never answer */ });
    });
    const port = await listen(server);
    try {
      await assert.rejects(
        createProxyTunnel(
          { type: 'https', host: '127.0.0.1', port },
          'example.com', 443,
          { timeoutMs: 150 },
        ),
        (err) => err.code === 'ERR_PROXY_TLS_TIMEOUT',
      );
      assert.ok(await waitUntil(() => state.sockets.size === 0), 'proxy socket must close');
    } finally {
      await closeServer(server, state);
    }
  });
});

describe('proxy connector — preserved HTTP and SOCKS transports', () => {
  it('keeps plaintext HTTP CONNECT and its auth header for type=http', async () => {
    const proxy = startPlainConnectProxy((socket) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.on('data', (data) => socket.write(Buffer.concat([Buffer.from('http:'), data])));
    });
    const port = await listen(proxy.server);
    try {
      const socket = await createProxyTunnel(
        { type: 'http', host: '127.0.0.1', port, username: 'bob', password: 'pw' },
        'example.com', 443,
        { timeoutMs: 3000 },
      );
      assert.equal(proxy.state.requests.length, 1);
      assert.match(proxy.state.requests[0], /^CONNECT example\.com:443 HTTP\/1\.1\r\n/);
      assert.match(proxy.state.requests[0], /Proxy-Authorization: Basic /);
      socket.write('ping');
      const [data] = await once(socket, 'data');
      assert.equal(data.toString(), 'http:ping');
      socket.destroy();
    } finally {
      await closeServer(proxy.server, proxy.state);
    }
  });

  for (const proxyType of ['socks5', ' SOCKS5 ']) {
  it(`keeps the SOCKS5 transport for normalized type=${JSON.stringify(proxyType)}`, async () => {
    const proxy = startSocksProxy();
    const port = await listen(proxy.server);
    try {
      const socket = await createProxyTunnel(
        { type: proxyType, host: '127.0.0.1', port, username: 'carol', password: 'pw' },
        'example.com', 443,
        { timeoutMs: 3000 },
      );
      assert.ok(proxy.state.greeting, 'greeting must be sent');
      assert.ok(proxy.state.auth, 'username/password auth must be sent');
      assert.ok(proxy.state.connect, 'CONNECT command must be sent');
      socket.write('ping');
      const [data] = await once(socket, 'data');
      assert.equal(data.toString(), 'socks:ping');
      socket.destroy();
    } finally {
      await closeServer(proxy.server, proxy.state);
    }
  });

  }

  it('rejects an unsupported type before any connection opens', async () => {
    const state = { connections: 0 };
    const server = net.createServer((socket) => { state.connections++; socket.destroy(); });
    const port = await listen(server);
    try {
      await assert.rejects(
        createProxyTunnel({ type: 'socks4', host: '127.0.0.1', port }, 'example.com', 443),
        (err) => err.code === 'ERR_PROXY_SCHEME_UNSUPPORTED',
      );
      assert.equal(state.connections, 0);
    } finally {
      await closeServer(server, state);
    }
  });

  it('maps proxy types to one shared transport choice', () => {
    assert.equal(proxyScheme({ type: 'https' }), 'https');
    assert.equal(proxyScheme({ type: 'HTTPS' }), 'https');
    assert.equal(proxyScheme({ type: 'http' }), 'http');
    assert.equal(proxyScheme({}), 'http');
    assert.equal(proxyScheme({ type: 'socks5' }), 'socks5');
    assert.equal(proxyScheme({ type: 'socks5h' }), 'socks5');
    assert.equal(proxyScheme({ type: 'socks' }), 'socks5');
  });
});

describe('proxy consumers — HTTPS selection uses the verified first hop', () => {
  it('dashboard proxy test reports a TLS-proxy CONNECT rejection, never a plaintext CONNECT', async () => {
    const proxy = startTlsProxy(CERT_A, KEY_A);
    const port = await listen(proxy.server);
    const restore = trustProxyCert(port);
    try {
      await assert.rejects(
        testProxy({ host: '127.0.0.1', port, username: 'u', password: 'p', type: 'https' }),
        /ERR_PROXY_HTTP_ERROR:407/,
      );
      assert.equal(proxy.state.requests.length, 1);
      assert.match(proxy.state.requests[0], /^CONNECT api\.ipify\.org:443 /);
      assert.match(proxy.state.requests[0], /Proxy-Authorization: Basic /);
    } finally {
      restore();
      await closeServer(proxy.server, proxy.state);
    }
  });

  it('password-login probe reaches an HTTPS proxy inside TLS', async () => {
    const proxy = startTlsProxy(CERT_A, KEY_A);
    const port = await listen(proxy.server);
    const restore = trustProxyCert(port);
    try {
      const probe = await probeLoginMethod(
        'synthetic-proxy-test@example.test',
        { type: 'https', host: '127.0.0.1', port, username: 'u', password: 'p' },
      );
      assert.equal(probe?.hasPassword ?? null, null, 'a failed probe stays unknown');
      assert.ok(proxy.state.requests.length >= 1, 'the proxy must have been dialed');
      for (const request of proxy.state.requests) {
        assert.match(request, /^CONNECT /);
        assert.match(request, /Proxy-Authorization: Basic /);
      }
    } finally {
      restore();
      await closeServer(proxy.server, proxy.state);
    }
  });

  it('email-OTP send surfaces the HTTPS proxy rejection', async () => {
    const proxy = startTlsProxy(CERT_A, KEY_A);
    const port = await listen(proxy.server);
    const restore = trustProxyCert(port);
    try {
      await assert.rejects(
        sendEmailVerification(
          'synthetic-proxy-test@example.test',
          'Synthetic',
          'synthetic-turnstile',
          { type: 'https', host: '127.0.0.1', port, username: 'u', password: 'p' },
        ),
        /Proxy CONNECT failed: 407/,
      );
      assert.equal(proxy.state.requests.length, 1);
      assert.match(proxy.state.requests[0], /^CONNECT windsurf\.com:443 /);
    } finally {
      restore();
      await closeServer(proxy.server, proxy.state);
    }
  });

  it('upstream metadata client reaches an HTTPS proxy inside TLS', async () => {
    const proxy = startTlsProxy(CERT_A, KEY_A);
    const port = await listen(proxy.server);
    const restore = trustProxyCert(port);
    try {
      await assert.rejects(
        getUserStatus(
          'synthetic-api-key',
          { type: 'https', host: '127.0.0.1', port, username: 'u', password: 'p' },
        ),
      );
      assert.ok(proxy.state.requests.length >= 1, 'the proxy must have been dialed');
      assert.match(proxy.state.requests[0], /^CONNECT server\.codeium\.com:443 /);
      assert.match(proxy.state.requests[0], /Proxy-Authorization: Basic /);
    } finally {
      restore();
      await closeServer(proxy.server, proxy.state);
    }
  });

  it('language-server proxy env preserves an HTTPS selection', () => {
    assert.equal(
      proxyUrl({ type: 'https', host: 'proxy.example.com', port: 8443, username: 'u', password: 'p' }),
      'https://u:p@proxy.example.com:8443',
    );
    assert.equal(
      proxyUrl({ type: 'http', host: 'proxy.example.com', port: 8080 }),
      'http://proxy.example.com:8080',
    );
    // SOCKS selections keep the pre-existing http:// child-environment form.
    assert.equal(
      proxyUrl({ type: 'socks5', host: 'proxy.example.com', port: 1080 }),
      'http://proxy.example.com:1080',
    );
    assert.equal(proxyUrl(null), null);
  });
});
