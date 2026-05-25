/**
 * proxy-user-inject.js
 * ====================
 * A lightweight HTTP proxy that injects a `user` field into every chat
 * completion request body before forwarding it to the upstream WindsurfAPI
 * instance.  When paired with sticky sessions, this ensures that multiple
 * end users sharing a single WindsurfAPI deployment each get bound to a
 * different upstream Windsurf account — no cross-user quota mixing.
 *
 * ── Problem ────────────────────────────────────────────────────────────
 * Two developers share one WindsurfAPI on a VPS. Both access the same
 * API_KEY via ccswitch / Cline / Claude Code, so from WindsurfAPI's
 * perspective they look identical.  Without a per-user signal:
 *   • STICKY_SESSION_ENABLED can't tell them apart
 *   • CASCADE_REUSE_BY_CALLER produces the same callerKey for both
 *   • They randomly compete for accounts in the pool
 *
 * ── Solution ───────────────────────────────────────────────────────────
 * Each user points their client at a different proxy port (e.g. :3004
 * for Alice, :3005 for Bob).  The proxy injects `user: 'alice'` (or
 * `user: 'bob'`) into the request body before forwarding to WindsurfAPI
 * on 127.0.0.1:3003.
 *
 * WindsurfAPI's caller-key.js then builds the callerKey as:
 *   api:<apiKeyHash>:user:<body.user hash>
 *
 * This produces two distinct, stable callerKeys → sticky sessions stay
 * pinned to separate accounts → cascade reuse works independently.
 *
 * ── Prerequisites ──────────────────────────────────────────────────────
 * • WindsurfAPI running on 127.0.0.1:3003 with .env containing:
 *     STICKY_SESSION_ENABLED=1
 *     CASCADE_REUSE_BY_CALLER=1
 * • (Recommended) Independent LS instances per user via tinyproxy:
 *   - tinyproxy on :8080 → LS on :42101 (Alice)
 *   - tinyproxy on :9090 → LS on :42102 (Bob)
 *   On the Dashboard, assign 127.0.0.1:8080 / 127.0.0.1:9090 as account
 *   proxy configs to separate LS pools.
 *
 * ── Usage ──────────────────────────────────────────────────────────────
 * 1. Copy this file for each user and change the port + user value:
 *    $ cp proxy-user-inject.js proxy-alice.js     → port 3004, user 'alice'
 *    $ cp proxy-user-inject.js proxy-bob.js       → port 3005, user 'bob'
 *
 * 2. Start each proxy (directly via Node.js or as a systemd service):
 *    $ node proxy-alice.js &
 *    $ node proxy-bob.js &
 *
 * 3. Point each user's client to their dedicated port:
 *    Alice → http://<SERVER_IP>:3004/v1
 *    Bob   → http://<SERVER_IP>:3005/v1
 *
 * ── systemd Service Example ────────────────────────────────────────────
 * Create /etc/systemd/system/windsurf-proxy-alice.service:
 *
 *   [Unit]
 *   Description=WindsurfAPI user-inject proxy (Alice)
 *   After=network.target
 *
 *   [Service]
 *   Type=simple
 *   ExecStart=/usr/bin/node /opt/windsurf/proxy-alice.js
 *   Restart=always
 *   RestartSec=5
 *   User=nobody
 *   WorkingDirectory=/opt/windsurf
 *
 *   [Install]
 *   WantedBy=multi-user.target
 *
 * Then:
 *   $ sudo systemctl daemon-reload
 *   $ sudo systemctl enable --now windsurf-proxy-alice
 *
 * ── Verification ───────────────────────────────────────────────────────
 * After setup, send two consecutive requests from the same proxy port:
 *
 *   $ curl -s -X POST http://<SERVER>:3004/v1/chat/completions \
 *       -H "Content-Type: application/json" \
 *       -H "Authorization: Bearer YOUR_API_KEY" \
 *       -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}],"max_tokens":50}'
 *
 * Check server logs: both requests should hit the same upstream account
 * with reuse=1 on the second request:
 *
 *   account=same@email.com ls=42101 turns=N reuse=1
 *   account=same@email.com ls=42101 turns=N+1 reuse=1
 *
 * And the other proxy port should land on a different account, confirming
 * isolation.
 *
 * ── Security Note ──────────────────────────────────────────────────────
 * These proxies listen on 0.0.0.0 by default so remote clients can reach
 * them.  If all clients are on the same machine as the server, change the
 * listen address to 127.0.0.1.  If exposed to the internet, consider
 * putting them behind nginx with TLS or using a firewall to restrict
 * source IPs.
 */

'use strict';

const http = require('http');

// ═══════════════ CONFIGURE THESE ═══════════════
const LISTEN_PORT  = 3004;            // External port clients connect to
const LISTEN_ADDR  = '0.0.0.0';       // '127.0.0.1' for local-only
const USER_ID      = 'alice';         // Injected as body.user (per-user unique)
const UPSTREAM_HOST = '127.0.0.1';    // WindsurfAPI host
const UPSTREAM_PORT = 3003;           // WindsurfAPI port
// ════════════════════════════════════════════════

http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const json = JSON.parse(body || '{}');
      json.user = USER_ID;

      const postData = JSON.stringify(json);
      const opts = {
        hostname: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: req.url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'Authorization': req.headers['authorization'] || '',
          'Host': `${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
        },
      };

      const upstream = http.request(opts, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.on('data', chunk => res.write(chunk));
        proxyRes.on('end', () => res.end());
      });

      upstream.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Upstream error: ' + err.message } }));
      });

      upstream.write(postData);
      upstream.end();
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Parse error: ' + err.message } }));
    }
  });
}).listen(LISTEN_PORT, LISTEN_ADDR, () => {
  console.log(`[proxy-user-inject] user="${USER_ID}" listening on ${LISTEN_ADDR}:${LISTEN_PORT} → ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
