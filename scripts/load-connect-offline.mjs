import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import './mutation-network-deny.mjs';

const [scenario = 'ok', count = '8', workers = '2'] = process.argv.slice(2);
const total = Number(count);
const concurrency = Number(workers);
if (!['ok', 'precommit', 'postcommit'].includes(scenario) || !Number.isInteger(total) || total < 1 || total > 64 ||
    !Number.isInteger(concurrency) || concurrency < 1 || concurrency > Math.min(total, 8) ||
    (scenario !== 'ok' && (total !== 1 || concurrency !== 1)) || process.argv.length > 5) {
  throw new Error('Usage: node scripts/load-connect-offline.mjs ok [requests: 1-64] [concurrency: 1-8]; precommit/postcommit require 1 1');
}

const data = mkdtempSync(join(tmpdir(), 'windsurfapi-offline-connect-'));
const previousCwd = process.cwd();
let server;
let stub;
try {
  const systemKeys = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ']);
  for (const key of Object.keys(process.env)) if (!systemKeys.has(key.toUpperCase())) delete process.env[key];
  const profile = join(data, 'profile');
  mkdirSync(profile);
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'TMP', 'TEMP']) {
    process.env[key] = profile;
  }
  process.chdir(data);
  const { MATRIX, SMOKE, startOfflineConnectStub } = await import('../test/helpers/smoke-matrix-upstream.mjs');
  Object.assign(process.env, { WINDSURFAPI_SKIP_DOTENV: '1', DATA_DIR: data, SHARED_DATA_DIR: data, HOST: '127.0.0.1', PORT: '0',
    API_KEY: SMOKE.apiKey, DASHBOARD_PASSWORD: SMOKE.dashboardPassword, LOG_LEVEL: 'error', NO_COLOR: '1', DEVIN_CONNECT: '1',
    DEVIN_CONNECT_TOKEN: '', DEVIN_CONNECT_AUTO_RELOGIN: '0', RELOGIN_LIVE: '0', WINDSURFAPI_NO_OPEN: '1',
    DEVIN_ONLY: '0', DEVIN_CONNECT_FAILOVER_MAX: '1', DEVIN_CONNECT_RETRY_ON_EMPTY: '0', DEVIN_CONNECT_RESCUE_MAX: '0',
    RESPONSE_CACHE_ENABLED: '0', STICKY_SESSION_ENABLED: '0' });
  const tokens = ['a','b'].map(slot => 'devin-session-token$offline-load-' + slot);
  const { config } = await import('../src/config.js');
  config.port = 0;
  const { __setModelCatalogDeps, __waitForModelCatalogSync, addAccountByKey, getAccountInternal } = await import('../src/auth.js');
  const { __setRequestImpl } = await import('../src/devin-connect.js');
  const { startServer } = await import('../src/server.js');
  const model = 'swe-1-6-slow';
  __setModelCatalogDeps({ fetchConfig: async () => ({ configs: [] }), fetchConnectCatalog: async () => [{ selector: model }], scheduleCatalogRetry: () => () => {} });
  for (const [index, token] of tokens.entries()) {
    const account = getAccountInternal(addAccountByKey(token, 'offline-slot-' + index).id);
    account.tier = 'pro';
    account.credits = { dailyPercent: 90, weeklyPercent: 90 };
  }
  await __waitForModelCatalogSync();
  stub = await startOfflineConnectStub({ tokens, scenario, model, parallelProbe: concurrency > 1, latencyMs: 5 });
  __setRequestImpl(stub.request);
  server = startServer();
  if (!server.listening) await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions';
  let cursor = 0;
  const turns = [];
  const started = performance.now();
  async function worker() {
    while (cursor < total) {
      const index = cursor++;
      const t0 = performance.now();
      const stream = scenario !== 'ok' || index % 2 === 1;
      const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { authorization: 'Bearer ' + SMOKE.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'offline sample ' + index }] }) });
      const text = await res.text();
      const events = stream ? text.split(/\r?\n/).filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6))) : [JSON.parse(text)];
      const answer = events.map(e => e.choices?.[0]?.delta?.content || e.choices?.[0]?.message?.content || '').join('');
      const error = events.find(e => e.error)?.error?.code ?? null;
      const finish = events.map(e => e.choices?.[0]?.finish_reason).filter(Boolean);
      const terminal = events.at(-1)?.error ? 'error' : finish.at(-1) ?? null;
      const done = stream && text.split(/\r?\n/).filter(line => line === 'data: [DONE]').length === 1;
      turns.push({ index, status: res.status, stream, answer, error, terminal, done, ms: Math.round(performance.now() - t0) });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  turns.sort((a,b) => a.index-b.index);
  const times = turns.map(t => t.ms).sort((a,b) => a-b);
  const correctTurns = turns.every(t => t.status === 200 && (scenario === 'postcommit'
    ? t.answer === 'partial fixture' && t.error === 'RATE_LIMITED' && t.terminal === 'error'
    : t.answer === MATRIX.text + ' #' + t.index && !t.error && t.terminal === 'stop' && (!t.stream || t.done)));
  const expectedAttempts = scenario === 'precommit' ? 2 : total;
  const ok = correctTurns && stub.attempts.length === expectedAttempts && new Set(stub.samples).size === total &&
    stub.samples.every(index => Number.isSafeInteger(index) && index >= 0 && index < total) &&
    (concurrency === 1 || stub.peak >= 2) &&
    (scenario !== 'precommit' || new Set(stub.attempts).size === 2);
  const report = { scenario, total, concurrency, turns, attempts: stub.attempts, samples: stub.samples, peak: stub.peak,
    elapsedMs: Math.round(performance.now() - started), p50Ms: times[Math.ceil(total * 0.50) - 1],
    p95Ms: times[Math.ceil(total * 0.95) - 1], ok };
  console.log('OFFLINE_CONNECT_LOAD ' + JSON.stringify(report));
  if (!ok) process.exitCode = 1;
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (stub) await stub.close();
  process.chdir(previousCwd);
  rmSync(data, { recursive: true, force: true });
}
