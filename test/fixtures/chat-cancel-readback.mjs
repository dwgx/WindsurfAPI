import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../../src/config.js';
import { wrapEnvelope, endOfStreamEnvelope } from '../../src/connect.js';
import { __setRequestImpl } from '../../src/devin-connect.js';
import { writeMessageField, writeStringField, writeVarintField } from '../../src/proto.js';
import { getRequestLog } from '../../src/dashboard/stats.js';
import { startServer } from '../../src/server.js';

const env = {
  DEVIN_CONNECT: '1', DEVIN_CONNECT_TOKEN: 'fixture-token',
  DEVIN_CONNECT_FAILOVER_MAX: '0', DEVIN_CONNECT_SESSION_REUSE: '0',
  DEVIN_CONNECT_BILLING_TAGS: 'credit_cost=^14', RESPONSE_CACHE_ENABLED: '0',
  DASHBOARD_ALLOW_NO_AUTH: '1',
};

export async function startCancelFixture() {
  const previousEnv = Object.keys(env).map(name => [name, process.env[name]]);
  Object.assign(process.env, env);
  const original = { host: config.host, port: config.port, apiKey: config.apiKey, dashboardPassword: config.dashboardPassword };
  const apiKey = 'loopback-cancel-fixture-only';
  Object.assign(config, { host: '127.0.0.1', port: 0, apiKey, dashboardPassword: '' });

  let requests = 0;
  let upstreamSocketCloses = 0;
  let notifySocketClosed;
  const socketClosed = new Promise(resolve => { notifySocketClosed = resolve; });
  const upstream = http.createServer((req, res) => {
    const hasFirstTurn = requests++ === 0;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/connect+proto' });
      res.once('close', () => {
        if (!res.writableEnded) {
          upstreamSocketCloses++;
          notifySocketClosed(true);
        }
      });
      if (hasFirstTurn) {
        res.write(wrapEnvelope(writeStringField(3, 'Fixture first payload'), { compress: false }));
      } else {
        const payload = Buffer.concat([
          writeStringField(3, 'Fixture completed'),
          writeVarintField(5, 2),
          writeMessageField(7, Buffer.concat([writeVarintField(2, 8), writeVarintField(3, 3)])),
          writeVarintField(14, 0),
        ]);
        res.write(wrapEnvelope(payload, { compress: false }));
        res.end(endOfStreamEnvelope());
      }
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  __setRequestImpl((options, receive) => http.request({
    ...options, hostname: '127.0.0.1', port: upstream.address().port,
  }, receive));
  const server = startServer();
  if (!server.listening) await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;

  const body = JSON.stringify({
    model: 'gpt-5.5', reasoning_effort: 'xhigh', stream: true, stream_options: { include_usage: true },
    messages: [{ role: 'user', content: 'Controlled streaming request' }],
  });
  const headers = { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' };
  async function disconnect() {
    return new Promise((resolve, reject) => {
      const req = http.request(origin + '/v1/chat/completions', { method: 'POST', headers, signal: AbortSignal.timeout(5000) }, (res) => {
        const id = res.headers['x-request-id'];
        let received = '';
        res.on('error', reject);
        res.on('data', chunk => {
          received += chunk;
          if (!received.includes('Fixture first payload')) return;
          resolve({ id, status: res.statusCode, finished: received.includes('[DONE]') });
          req.destroy();
        });
        res.once('end', () => reject(Error('Premature end before the client could disconnect')));
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  async function complete() {
    const res = await fetch(origin + '/v1/chat/completions', { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
    const text = await res.text();
    return { id: res.headers.get('x-request-id'), status: res.status, finished: text.includes('[DONE]') };
  }
  async function lookup(id) {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      const row = getRequestLog({ requestId: id }).items[0];
      if (row?.requestHttpStatus != null) return row;
      await delay(20);
    }
    assert.fail('Request did not finish its history row');
  }
  return {
    origin, disconnect, complete, lookup,
    async waitForUpstreamClose() {
      assert.equal(await Promise.race([socketClosed, delay(3000, false, { ref: false })]), true);
    },
    counts: () => ({ requests, upstreamSocketCloses }),
    openDashboard() { config.apiKey = ''; },
    async close() {
      __setRequestImpl(null);
      for (const endpoint of [server, upstream]) {
        endpoint.closeAllConnections();
        await new Promise(resolve => endpoint.close(resolve));
      }
      Object.assign(config, original);
      for (const [name, value] of previousEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}
