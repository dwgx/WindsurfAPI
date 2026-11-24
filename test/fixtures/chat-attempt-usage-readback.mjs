import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import {
  addAccountByKey, getAccountInternal, removeAccount, __setModelCatalogDeps, __waitForModelCatalogSync,
} from '../../src/auth.js';
import { config } from '../../src/config.js';
import { wrapEnvelope, endOfStreamEnvelope } from '../../src/connect.js';
import { getRequestLog, resetStats } from '../../src/dashboard/stats.js';
import { __setRequestImpl } from '../../src/devin-connect.js';
import { accountRef } from '../../src/log-safety.js';
import { writeMessageField, writeStringField, writeVarintField } from '../../src/proto.js';
import { startServer } from '../../src/server.js';

const env = {
  DEVIN_CONNECT: '1', DEVIN_CONNECT_FAILOVER_MAX: '1', DEVIN_CONNECT_SESSION_REUSE: '0',
  DEVIN_CONNECT_BILLING_TAGS: 'credit_cost=6,committed_acu_cost=8',
  RESPONSE_CACHE_ENABLED: '0', DASHBOARD_ALLOW_NO_AUTH: '1',
};
const frame = bytes => wrapEnvelope(bytes, { compress: false });
const markers = { primary: 'attempt-usage-primary-fixture', concurrent: 'attempt-usage-concurrent-fixture' };
const metering = {
  initial: [writeVarintField(2, 11), writeVarintField(3, 0)],
  fallback: [writeVarintField(2, 23), writeVarintField(3, 5), writeVarintField(6, 47), writeVarintField(8, 2)],
  concurrent: [writeVarintField(3, 19), writeVarintField(6, 0)],
};

function endRejection() {
  const error = { code: 'resource_exhausted', message: 'Model rate limit reached' };
  const trailer = frame(Buffer.from(JSON.stringify({ error })));
  trailer[0] = 0x02;
  return trailer;
}

export async function startAttemptUsageFixture() {
  const previousEnv = Object.keys(env).map(name => [name, process.env[name]]);
  Object.assign(process.env, env);
  const original = { host: config.host, port: config.port, apiKey: config.apiKey, dashboardPassword: config.dashboardPassword };
  const apiKey = 'loopback-attempt-usage-fixture-only';
  Object.assign(config, { host: '127.0.0.1', port: 0, apiKey, dashboardPassword: '' });
  resetStats();
  __setModelCatalogDeps({ disableConnectSync: true, getCascadeModelConfigs: async () => ({ configs: [] }) });
  const accounts = ['offline-usage-fixture-one', 'offline-usage-fixture-two'].map(token => {
    const acct = addAccountByKey('devin-session-token$' + token, 'Synthetic usage fixture');
    Object.assign(getAccountInternal(acct.id), { tier: 'pro', credits: { dailyPercent: 80, weeklyPercent: 80 } });
    return { token, id: acct.id, ref: accountRef(acct.id) };
  });
  const firstArrived = Promise.withResolvers();
  const otherArrived = Promise.withResolvers();
  const releaseOther = Promise.withResolvers();
  const traffic = [];
  const upstreamErrors = [];
  let primaryCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    try {
      const body = [];
      for await (const chunk of req) body.push(chunk);
      const bytes = Buffer.concat(body);
      const acct = accounts.find(a => req.headers.authorization?.includes(a.token));
      assert.ok(acct, 'Expected an approved synthetic account');
      const isPrimary = bytes.includes(markers.primary);
      assert.notEqual(isPrimary, bytes.includes(markers.concurrent), 'Expected exactly one fixture request marker');
      const step = isPrimary ? (++primaryCalls === 1 ? 'initial' : 'fallback') : 'concurrent';
      traffic.push({ event: 'dispatch', step, account: acct.ref });
      assert.ok(traffic.filter(x => x.event === 'dispatch').length <= 3, 'Extra upstream request');
      if (step === 'initial') {
        firstArrived.resolve();
        await otherArrived.promise;
      } else if (step === 'concurrent') {
        otherArrived.resolve();
        await releaseOther.promise;
      }
      res.writeHead(200, { 'content-type': 'application/connect+proto' });
      res.write(frame(writeMessageField(7, Buffer.concat(metering[step]))));
      traffic.push({ event: 'report', step, account: acct.ref });
      if (step === 'initial') return res.end(endRejection());
      res.write(frame(Buffer.concat([writeStringField(3, step + ' fixture reply'), writeVarintField(5, 1)])));
      res.end(endOfStreamEnvelope());
    } catch (err) {
      upstreamErrors.push(err.message);
      res.destroy();
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  __setRequestImpl((options, receive) => http.request({
    ...options, hostname: '127.0.0.1', port: upstream.address().port,
  }, receive));
  const gateway = startServer();
  if (!gateway.listening) await once(gateway, 'listening');
  const origin = 'http://127.0.0.1:' + gateway.address().port;

  async function send(marker) {
    const res = await fetch(origin + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(6000),
      body: JSON.stringify({
        model: 'swe-1-7-medium', stream: true, stream_options: { include_usage: true },
        messages: [{ role: 'user', content: marker }],
      }),
    });
    const text = await res.text();
    const id = res.headers.get('x-request-id');
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const rows = getRequestLog({ requestId: id }).items;
      if (rows[0]?.requestHttpStatus != null) {
        return { id, status: res.status, rows, sawDone: text.includes('[DONE]'),
          reply: ['fallback', 'concurrent'].find(step => text.includes(step + ' fixture reply')) ?? null };
      }
      await delay(20);
    }
    assert.fail('No retained request row');
  }

  return {
    origin,
    async run() {
      const primary = send(markers.primary);
      const pending = [primary];
      try {
        await Promise.race([firstArrived.promise, primary.then(() => assert.fail('Primary ended before first dispatch'))]);
        const concurrent = send(markers.concurrent);
        pending.push(concurrent);
        // The other socket has started, but its usage is sent only after the
        // fallback response and its stats rows have been read.
        const main = await primary;
        releaseOther.resolve();
        const other = await concurrent;
        assert.deepEqual(upstreamErrors, []);
        return { main, other, traffic };
      } finally {
        otherArrived.resolve();
        releaseOther.resolve();
        await Promise.allSettled(pending);
      }
    },
    openDashboard() { config.apiKey = ''; },
    async close() {
      __setRequestImpl(null);
      for (const endpoint of [gateway, upstream]) {
        endpoint.closeAllConnections();
        await new Promise(resolve => endpoint.close(resolve));
      }
      await __waitForModelCatalogSync();
      for (const account of accounts) removeAccount(account.id);
      __setModelCatalogDeps(null);
      resetStats();
      Object.assign(config, original);
      for (const [name, value] of previousEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}
