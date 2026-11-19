/**
 * Shared outbound proxy connector.
 *
 * One place decides the first hop for an outbound HTTPS request:
 *   - `socks` / `socks5` / `socks5h` → SOCKS5 tunnel (src/socks.js)
 *   - `https` → certificate-verified TLS to the proxy, CONNECT sent inside it
 *   - `http` / absent → plaintext HTTP CONNECT (documented behavior)
 *
 * Why this module exists: the password-login, email-OTP, upstream-API and
 * dashboard proxy-test paths each carried a copy of the HTTP CONNECT code, so
 * every copy silently downgraded an `https` proxy selection to a plaintext
 * first hop. Proxy authentication is sent in that first hop, which means an
 * authenticated HTTPS proxy was receiving its credential in clear text and a
 * TLS-only proxy could not be used at all. The TLS handshake to the ultimate
 * destination happens later and covers a different connection stage.
 *
 * Invariants:
 *   - The proxy host is resolved once to a vetted IP literal and that literal
 *     is dialed; no second, rebindable DNS lookup (see net-safety.js).
 *   - For `https`, the CONNECT request (and therefore Proxy-Authorization) is
 *     only written after the TLS handshake to the proxy has completed with
 *     certificate verification against the configured proxy hostname. A
 *     certificate or hostname failure therefore sends zero CONNECT/auth bytes.
 *   - `rejectUnauthorized` is forced on and cannot be disabled by callers.
 *   - Timeouts destroy the socket, so a failed attempt releases its handle.
 */

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { config } from './config.js';
import { createSocksTunnel } from './socks.js';
import { resolveProxyConnectHost } from './net-safety.js';

const SUPPORTED_TYPES = new Set(['', 'http', 'https', 'socks', 'socks5', 'socks5h']);

/** Normalized proxy type; absent means the documented HTTP default. */
export function proxyType(proxy) {
  return String(proxy?.type || '').trim().toLowerCase();
}

/** True when the operator selected an HTTPS first hop. */
export function isHttpsProxy(proxy) {
  return proxyType(proxy) === 'https';
}

/**
 * First-hop transport for a proxy selection: 'socks5' | 'https' | 'http'.
 * Unknown types are rejected by createProxyTunnel rather than silently treated
 * as plaintext HTTP.
 */
export function proxyScheme(proxy) {
  const type = proxyType(proxy);
  if (type === 'https') return 'https';
  if (type === 'socks' || type === 'socks5' || type === 'socks5h') return 'socks5';
  return 'http';
}

function proxyError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

function authHeader(proxy) {
  if (!proxy?.username) return null;
  const token = Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
  return `Basic ${token}`;
}

/**
 * TLS to the proxy itself. `dialHost` is the vetted IP literal; `servername`
 * is the operator-configured proxy hostname, which is what the certificate is
 * verified against (SNI is omitted for an IP literal, and Node then verifies
 * the IP SAN).
 */
function connectTlsToProxy({ dialHost, proxyPort, servername, timeoutMs, tlsOptions }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const options = {
      host: dialHost,
      port: proxyPort,
      ...(servername && !net.isIP(servername) ? { servername } : {}),
      // Test-only trust injection: a synthetic CA, nothing else. Host,
      // servername, verification and identity checks cannot be overridden.
      ...(tlsOptions?.ca ? { ca: tlsOptions.ca } : {}),
      // Forced: certificate verification is a property of the feature, not an
      // option a caller can weaken.
      rejectUnauthorized: true,
      // Node 24.19's DNS normalization rejects valid IPv6 IP SANs (nodejs/node
      // #64144). Keep normal chain verification, and for a canonical IPv6
      // literal require an exact IP SAN through X509Certificate.checkIP.
      // DNS names keep Node's hardened default identity verifier and SNI.
      ...(net.isIP(servername) === 6 ? {
        checkServerIdentity: (_host, cert) => {
          try {
            if (new X509Certificate(cert.raw).checkIP(servername)) return undefined;
          } catch {}
          const err = new Error('Proxy certificate does not match the configured IPv6 IP SAN');
          err.code = 'ERR_TLS_CERT_ALTNAME_INVALID';
          return err;
        },
      } : {}),
    };
    const socket = tls.connect(options, () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.setTimeout(timeoutMs, () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(proxyError('ERR_PROXY_TLS_TIMEOUT', 'Proxy TLS handshake timeout'));
    });
    socket.on('error', (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(proxyError('ERR_PROXY_TLS', `Proxy TLS handshake failed: ${err.message}`, err));
    });
  });
}

/**
 * Send CONNECT either on a fresh TCP socket (`dialHost` given) or inside an
 * established stream (`socket` given, i.e. the TLS-to-proxy socket).
 */
function sendConnect({ socket, dialHost, proxyPort, targetHost, targetPort, auth, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const options = {
      // host/port are always present so test-side network guards can classify
      // the destination; the custom agent below ignores them for TLS (the
      // socket is already connected to the vetted proxy address).
      host: dialHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: {
        Host: `${targetHost}:${targetPort}`,
        ...(auth ? { 'Proxy-Authorization': auth } : {}),
      },
    };
    let req;
    if (socket) {
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => socket;
      options.agent = agent;
    }
    req = http.request(options);
    req.on('connect', (res, tunnel, head) => {
      if (res.statusCode !== 200) {
        tunnel.destroy();
        const err = proxyError('ERR_PROXY_CONNECT', `Proxy CONNECT failed: ${res.statusCode}`);
        err.statusCode = res.statusCode;
        settle(reject, err);
        return;
      }
      // Bytes that arrived together with the CONNECT response belong to the
      // tunnel; hand them back before the caller wraps the socket.
      if (head && head.length) tunnel.unshift(head);
      settle(resolve, tunnel);
    });
    req.on('error', (err) => {
      if (settled) return;
      settle(reject, proxyError('ERR_PROXY_CONNECTION', `Proxy connection error: ${err.message}`, err));
    });
    req.setTimeout(timeoutMs, () => {
      if (settled) return;
      settle(reject, proxyError('ERR_PROXY_CONNECT_TIMEOUT', 'Proxy connection timeout'));
      req.destroy();
    });
    req.end();
  });
}

/**
 * Open a tunnel to `targetHost:targetPort` through `proxy`.
 *
 * @param {object} proxy { type, host, port, username, password }
 * @param {string} targetHost destination hostname (resolved by the proxy)
 * @param {number} targetPort destination port
 * @param {object} [options]
 * @param {number} [options.timeoutMs] per-stage timeout (default 15s)
 * @param {boolean} [options.allowPrivate] override config.allowPrivateProxyHosts
 * @param {string} [options.dialHost] pre-vetted IP literal for the proxy
 * @param {object} [options.tlsOptions] test-only trust injection: `{ ca }`
 *        for loopback fixtures. rejectUnauthorized and identity checks stay on
 * @returns {Promise<import('node:net').Socket>}
 */
export async function createProxyTunnel(proxy, targetHost, targetPort, options = {}) {
  if (!proxy?.host) throw proxyError('ERR_PROXY_HOST_REQUIRED', 'Proxy host is required');
  const type = proxyType(proxy);
  if (!SUPPORTED_TYPES.has(type)) {
    throw proxyError('ERR_PROXY_SCHEME_UNSUPPORTED', `Unsupported proxy type: ${type}`);
  }
  const timeoutMs = options.timeoutMs || 15000;
  const allowPrivate = options.allowPrivate ?? config.allowPrivateProxyHosts;
  // Bare IPv6 literals end in colon+digits too; preserve them before
  // handling the legacy hostname:port spelling. Bracketed IPv6 remains
  // accepted by resolveProxyConnectHost and is unwrapped for TLS identity.
  const configuredHost = String(proxy.host).trim();
  const rawHost = net.isIP(configuredHost) ? configuredHost : configuredHost.replace(/:\d+$/, '');
  const servername = rawHost.replace(/^\[|\]$/g, '');
  const proxyPort = Number(proxy.port) || 8080;
  const auth = authHeader(proxy);

  const scheme = proxyScheme(proxy);
  if (scheme === 'socks5') {
    return createSocksTunnel(proxy, targetHost, targetPort, timeoutMs);
  }

  const dialHost = options.dialHost
    || await resolveProxyConnectHost(rawHost, { allowPrivate });

  if (scheme === 'https') {
    const socket = await connectTlsToProxy({
      dialHost,
      proxyPort,
      servername,
      timeoutMs,
      tlsOptions: options.tlsOptions,
    });
    try {
      return await sendConnect({ socket, dialHost, proxyPort, targetHost, targetPort, auth, timeoutMs });
    } catch (err) {
      socket.destroy();
      throw err;
    }
  }

  return sendConnect({ dialHost, proxyPort, targetHost, targetPort, auth, timeoutMs });
}
