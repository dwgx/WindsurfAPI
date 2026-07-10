/**
 * Minimal SOCKS5 tunnel — zero npm dependencies.
 *
 * Implements RFC 1928 (SOCKS5) + RFC 1929 (username/password auth).
 * Returns a connected TCP socket ready for TLS wrapping or direct use.
 */

import net from 'node:net';
import { config } from './config.js';
import { resolveProxyConnectHost } from './net-safety.js';

const SOCKS_VERSION = 0x05;
const AUTH_NONE = 0x00;
const AUTH_USERPASS = 0x02;
const AUTH_FAIL = 0xFF;
const CMD_CONNECT = 0x01;
const ATYP_DOMAIN = 0x03;
const REP_SUCCESS = 0x00;

export function isSocks(proxy) {
  const t = (proxy?.type || '').toLowerCase();
  return t === 'socks5' || t === 'socks' || t === 'socks5h';
}

export async function createSocksTunnel(proxy, targetHost, targetPort, timeoutMs = 15000) {
  const rawHost = proxy.host.replace(/:\d+$/, '');
  const port = proxy.port || 1080;
  // #11: resolve the proxy host ONCE to a vetted IP literal and dial that, so
  // net.connect performs no second (rebindable) DNS lookup. Honors the
  // ALLOW_PRIVATE_PROXY_HOSTS policy. targetHost is left as a name on purpose —
  // it is resolved by the proxy server, not by us.
  const host = await resolveProxyConnectHost(rawHost, { allowPrivate: config.allowPrivateProxyHosts });
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const sock = net.connect(port, host, () => {
      // Step 1: greeting — offer auth methods
      const methods = proxy.username ? [AUTH_NONE, AUTH_USERPASS] : [AUTH_NONE];
      sock.write(Buffer.from([SOCKS_VERSION, methods.length, ...methods]));
    });

    let phase = 'greeting';
    let buf = Buffer.alloc(0);

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (phase === 'greeting') {
        if (buf.length < 2) return;
        const ver = buf[0], method = buf[1];
        buf = buf.subarray(2);
        if (ver !== SOCKS_VERSION) {
          sock.destroy();
          return done(reject, new Error(`SOCKS5: server version ${ver} unsupported`));
        }
        if (method === AUTH_FAIL) {
          sock.destroy();
          return done(reject, new Error('SOCKS5: no acceptable auth method'));
        }
        if (method === AUTH_USERPASS && proxy.username) {
          phase = 'auth';
          const user = Buffer.from(proxy.username);
          const pass = Buffer.from(proxy.password || '');
          sock.write(Buffer.from([0x01, user.length, ...user, pass.length, ...pass]));
        } else {
          phase = 'connect';
          sendConnect();
        }
      } else if (phase === 'auth') {
        if (buf.length < 2) return;
        const status = buf[1];
        buf = buf.subarray(2);
        if (status !== 0x00) {
          sock.destroy();
          return done(reject, new Error('SOCKS5: authentication failed'));
        }
        phase = 'connect';
        sendConnect();
      } else if (phase === 'connect') {
        // Minimum response: ver(1) + rep(1) + rsv(1) + atyp(1) + addr + port(2)
        if (buf.length < 4) return;
        const rep = buf[1];
        const atyp = buf[3];
        let addrLen;
        if (atyp === 0x01) addrLen = 4;       // IPv4
        else if (atyp === 0x04) addrLen = 16;  // IPv6
        else if (atyp === 0x03) addrLen = 1 + (buf.length > 4 ? buf[4] : 255); // domain
        else addrLen = 0;
        const totalLen = 4 + addrLen + 2;
        if (buf.length < totalLen) return;

        buf = buf.subarray(totalLen);
        if (rep !== REP_SUCCESS) {
          sock.destroy();
          const reasons = {
            0x01: 'general SOCKS failure', 0x02: 'connection not allowed',
            0x03: 'network unreachable', 0x04: 'host unreachable',
            0x05: 'connection refused', 0x06: 'TTL expired',
            0x07: 'command not supported', 0x08: 'address type not supported',
          };
          return done(reject, new Error(`SOCKS5: ${reasons[rep] || `error ${rep}`}`));
        }
        phase = 'done';
        done(resolve, sock);
      }
    });

    function sendConnect() {
      const domainBuf = Buffer.from(targetHost);
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(targetPort);
      sock.write(Buffer.from([
        SOCKS_VERSION, CMD_CONNECT, 0x00, ATYP_DOMAIN,
        domainBuf.length, ...domainBuf, ...portBuf,
      ]));
    }

    sock.on('error', (err) => done(reject, new Error(`SOCKS5: ${err.message}`)));
    sock.setTimeout(timeoutMs, () => { sock.destroy(); done(reject, new Error('SOCKS5: connection timeout')); });
  });
}
