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
  DEVIN_CONNECT_TOOL_CALL_TAGS: 'outer=12,id=4,name=1,arguments_json=3',
  RESPONSE_CACHE_ENABLED: '0', DASHBOARD_ALLOW_NO_AUTH: '1',
};
const frame = bytes => wrapEnvelope(bytes, { compress: false });

export async function startTimingFixture() {
  const previousEnv = Object.keys(env).map(name => [name, process.env[name]]);
  Object.assign(process.env, env);
  const original = { host: config.host, port: config.port, apiKey: config.apiKey, dashboardPassword: config.dashboardPassword };
  const apiKey = 'loopback-timing-fixture-only';
  Object.assign(config, { host: '127.0.0.1', port: 0, apiKey, dashboardPassword: '' });

  let requests = 0;
  const upstream = http.createServer((req, res) => {
    const normal = requests++ === 0;
    req.resume();
    req.on('end', async () => {
      res.writeHead(200, { 'content-type': 'application/connect+proto' });
      res.write(frame(Buffer.alloc(0)));
      await delay(normal ? 220 : 100);
      if (!normal) {
        const trailer = frame(Buffer.from(JSON.stringify({ error: { code: 'invalid_argument', message: 'Fixture rejection' } })));
        trailer[0] = 0x02;
        res.end(trailer);
        return;
      }
      res.write(frame(writeStringField(3, 'Fixture body text')));
      await delay(130);
      const tool = writeMessageField(12, Buffer.concat([
        writeStringField(1, 'read_fixture'),
        writeStringField(3, '{}'),
        writeStringField(4, 'call_timing_fixture'),
      ]));
      res.write(frame(tool));
      await delay(65);
      res.write(frame(writeVarintField(5, 2)));
      res.end(endOfStreamEnvelope());
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
  const headers = { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' };

  async function send() {
    const res = await fetch(origin + '/v1/chat/completions', {
      method: 'POST', headers, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        model: 'gpt-5.5', reasoning_effort: 'xhigh', stream: true,
        messages: [{ role: 'user', content: 'Controlled timing request' }],
        tools: [{ type: 'function', function: {
          name: 'read_fixture', parameters: { type: 'object', properties: {} },
        } }],
      }),
    });
    const text = await res.text();
    const id = res.headers.get('x-request-id');
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      const row = getRequestLog({ requestId: id }).items[0];
      if (row?.requestHttpStatus != null) {
        return {
          id, row, status: res.status, sawText: text.includes('Fixture body text'),
          sawTool: text.includes('call_timing_fixture'), sawDone: text.includes('[DONE]'),
        };
      }
      await delay(20);
    }
    assert.fail('No retained request row');
  }

  return {
    origin, send, count: () => requests,
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
