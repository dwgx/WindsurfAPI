// Diagnostic boundary regressions (web audit, 507f4fca).
//
// Two disclosures are pinned here:
//   1. /auth/login used to interpolate the raw, parse-failing proxy string into
//      log.warn. `http://user:password@host:port` is NOT a repro — parseProxyUrl
//      accepts it. The fixtures below are genuinely parse-failing (no `:port`).
//   2. The LS pool key embeds a sanitized sticky/per-user proxy username
//      (`px_…_u<user>`); lifecycle logs and status/error payloads must publish
//      `publicLsKey()` while `_pool`, leases, `_poolKeys()`/`getProxyByKey()`
//      keep the raw key.
//
// Every value below is synthetic; no real LS binary, proxy, account or network.

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startServer } from '../src/server.js';
import { config, log } from '../src/config.js';
import { configureBindHost, getAccountList, removeAccount } from '../src/auth.js';
import { getEffectiveProxy } from '../src/dashboard/proxy-config.js';
import { setRuntimeApiKey, setRuntimeDashboardPassword } from '../src/runtime-config.js';
import {
  __resetLsPoolForTests,
  _poolKeys,
  getLsAdmissionStatus,
  getLsFor,
  getLsStatus,
  getProxyByKey,
  stopLanguageServer,
  sweepIdleLanguageServers,
} from '../src/langserver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const MARK = 'WEBDIAG-CREDENTIAL-MARKER';
const USER_MARK = 'WEBDIAGUSER';
const OPAQUE_LABEL = /^px_[a-f0-9]{32}_u_redacted$/;
const INVALID_PROXY_WARN = 'auth/login: ignoring invalid proxy format';

function captureLogs() {
  const seen = [];
  const saved = {};
  for (const level of ['debug', 'info', 'warn', 'error']) {
    saved[level] = log[level];
    log[level] = (...args) => { seen.push({ level, text: args.map(String).join(' ') }); };
  }
  return {
    seen,
    texts: (level) => seen.filter((e) => !level || e.level === level).map((e) => e.text),
    restore() { for (const level of Object.keys(saved)) log[level] = saved[level]; },
  };
}

function fakeProcess(pid = 4242) {
  return { pid, exitCode: 0, kill() {}, once() {}, off() {} };
}

function runIsolatedNode(script, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'windsurf-diag-child-'));
  try {
    const home = mkdirSync(join(root, 'home'), { recursive: true });
    const temp = mkdirSync(join(root, 'tmp'), { recursive: true });
    const data = mkdirSync(join(root, 'data'), { recursive: true });
    const env = {
      ...process.env,
      LS_AUTO_RESTART: '0',
      ...extraEnv,
      HOME: home,
      USERPROFILE: home,
      TEMP: temp,
      TMP: temp,
      WINDSURFAPI_TEST_DATA_DIR: data,
      DATA_DIR: data,
      LS_DATA_DIR: join(data, 'ls'),
      WINDSURFAPI_SKIP_DOTENV: '1',
      SKIP_DOTENV: '1',
      RELOGIN_LIVE: '0',
    };
    delete env.NODE_OPTIONS;
    delete env.NODE_TEST_CONTEXT;
    const out = execFileSync(process.execPath, [
      '--import', './test/setup-env.mjs',
      '--import', './scripts/mutation-network-deny.mjs',
      '--input-type=module', '-e', script,
    ], { cwd: repoRoot, env, encoding: 'utf8', timeout: 30_000 });
    return JSON.parse(out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runLangserverChild(body, extraEnv, spawnError = false) {
  // Exercise the real lifecycle handlers, but never start an LS or another Node.
  const script = [
    "const { default: childProcess } = await import('node:child_process');",
    "const { syncBuiltinESMExports } = await import('node:module');",
    "const { EventEmitter } = await import('node:events');",
    'childProcess.spawn = (_binaryPath, args) => {',
    '  const proc = new EventEmitter();',
    '  proc.stdout = new EventEmitter();',
    '  proc.stderr = new EventEmitter();',
    '  proc.pid = 4242;',
    '  proc.kill = () => true;',
    '  queueMicrotask(() => {',
    "    const arg = args.find(v => v.startsWith('--codeium_dir='));",
    "    proc.stderr.emit('data', Buffer.from(arg));",
    spawnError ? "    proc.emit('error', Object.assign(new Error('synthetic spawn error'), { code: 'ENOENT' }));" : '',
    '    proc.exitCode = 23;',
    "    proc.emit('exit', proc.exitCode, null);",
    '  });',
    '  return proc;',
    '};',
    'syncBuiltinESMExports();',
    "const { log } = await import('./src/config.js');",
    'const captured = [];',
    "for (const level of ['debug', 'info', 'warn', 'error']) {",
    "  log[level] = (...args) => { captured.push({ level, text: args.map(String).join(' ') }); };",
    '}',
    "const m = await import('./src/langserver.js');",
    'm.configureLanguageServer({ binaryPath: process.execPath });',
    'const result = {};',
    body,
    // Ensure the capture completes without waiting on the losing readiness timer.
    'process.stdout.write(JSON.stringify({ captured, result }), () => process.exit(0));',
  ].join('\n');
  return runIsolatedNode(script, extraEnv);
}

describe('/auth/login invalid-proxy warn', () => {
  const TEST_KEY = 'sk-fixture-web-diagnostic';
  const DASH_PASSWORD = 'webdiag-dashboard-password';
  const LABEL = 'webdiag-fixture';
  const original = {
    apiKey: config.apiKey,
    password: config.dashboardPassword,
    host: config.host,
    port: config.port,
  };
  let server = null;
  let captured = null;

  function postJson(port, path, body, headers) {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  beforeEach(async () => {
    setRuntimeApiKey(TEST_KEY);
    setRuntimeDashboardPassword(DASH_PASSWORD);
    config.host = '127.0.0.1';
    config.port = 0;
    configureBindHost('127.0.0.1');
    server = startServer();
    await new Promise((resolve) => { if (server.address()) return resolve(); server.once('listening', resolve); });
    captured = captureLogs();
  });

  afterEach(async () => {
    if (captured) { captured.restore(); captured = null; }
    if (server) { await new Promise((resolve) => server.close(resolve)); server = null; }
    setRuntimeApiKey('');
    setRuntimeDashboardPassword('');
    config.apiKey = original.apiKey;
    config.dashboardPassword = original.password;
    config.host = original.host;
    config.port = original.port;
    configureBindHost('127.0.0.1');
    for (const account of getAccountList()) {
      if (account.label === LABEL) removeAccount(account.id);
    }
  });

  it('ignores the proxy without echoing its credential marker', async () => {
    const malformed = `http://webdiag-user:${MARK}@203.0.113.9`; // no :port -> parseProxyUrl() null
    const response = await postJson(server.address().port, '/auth/login', {
      api_key: 'webdiag-fixture-key',
      label: LABEL,
      proxy: malformed,
    }, {
      Authorization: `Bearer ${TEST_KEY}`,
      'x-dashboard-password': DASH_PASSWORD,
    });

    // Rejection behaviour is unchanged: login succeeds, the proxy is ignored.
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.account.label ?? response.body.account.email, LABEL);
    assert.equal(getEffectiveProxy(response.body.account.id), null, 'the malformed proxy must not bind');

    const warns = captured.texts('warn').filter((line) => line.includes('ignoring invalid proxy format'));
    assert.equal(warns.length, 1, JSON.stringify(captured.texts('warn')));
    assert.equal(warns[0], INVALID_PROXY_WARN);
  });
});

describe('LS pool key presentation boundary', () => {
  // The username itself contains a delimiter-like `_123_u` sequence.
  const proxy = { host: 'sticky.example', port: 9000, username: `user-${USER_MARK}_123_ufirst`, password: 'synthetic-pw' };
  const RAW = `px_sticky_example_9000_uuser_${USER_MARK}_123_ufirst`;

  function publicKey() {
    const key = getLsAdmissionStatus(proxy).key;
    assert.match(key, OPAQUE_LABEL);
    return key;
  }
  const originalLsDataDir = process.env.LS_DATA_DIR;

  before(() => {
    const dir = join(process.env.DATA_DIR || repoRoot, 'webdiag-ls-data');
    process.env.LS_DATA_DIR = dir;
  });

  after(() => {
    if (originalLsDataDir === undefined) delete process.env.LS_DATA_DIR;
    else process.env.LS_DATA_DIR = originalLsDataDir;
    __resetLsPoolForTests([]);
  });

  it('projects getLsStatus().instances but keeps default/ports/PIDs', () => {
    __resetLsPoolForTests([
      { key: 'default', port: 42100, startedAt: 1, lastUsedAt: 1, ready: true, process: fakeProcess(1111) },
      { key: RAW, proxy, port: 45999, startedAt: 2, lastUsedAt: 2, ready: true, process: fakeProcess(2222) },
    ]);
    const status = getLsStatus();
    assert.deepEqual(status.instances.map((i) => i.key), ['default', publicKey()]);
    assert.deepEqual(status.instances.map((i) => i.port), [42100, 45999]);
    assert.deepEqual(status.instances.map((i) => i.pid), [1111, 2222]);
    assert.doesNotMatch(JSON.stringify(status), new RegExp(USER_MARK), 'status payload must not carry the username');
  });

  it('projects admission/eviction labels while raw identity still routes', () => {
    __resetLsPoolForTests([
      { key: RAW, proxy, port: 45999, startedAt: 1, lastUsedAt: 1, ready: true, process: fakeProcess() },
    ]);
    const admission = getLsAdmissionStatus(proxy);
    assert.equal(admission.reason, 'already_running');
    assert.match(admission.key, OPAQUE_LABEL);
    // A host can itself contain the username marker. Treat it conservatively.
    assert.match(getLsAdmissionStatus({ host: 'unrelated_user.example', port: 9800 }).key, OPAQUE_LABEL);

    assert.deepEqual(_poolKeys(), [RAW], 'the pool keeps the raw key');
    assert.equal(getProxyByKey(RAW)?.username, proxy.username, 'proxy lookup keeps exact identity');
    assert.equal(getLsFor(proxy)?.port, 45999, 'internal routing still matches by raw key');
    assert.doesNotMatch(JSON.stringify(admission), new RegExp(USER_MARK));
  });

  it('projects the eviction-candidate label returned to diagnostics', () => {
    const status = getLsStatus();
    const entries = [];
    for (let i = 0; i < status.maxInstances; i++) {
      entries.push({
        key: i === 0 ? RAW : `px_other_${9000 + i}_uuser_${USER_MARK}`,
        proxy: { ...proxy, port: 9000 + i },
        startedAt: 1,
        lastUsedAt: 1,
        readyAt: 1,
        ready: true,
        activeRequests: 0,
        process: fakeProcess(5000 + i),
      });
    }
    __resetLsPoolForTests(entries);
    const admission = getLsAdmissionStatus({ host: 'new.example', port: 9999 });
    assert.equal(admission.key, 'px_new_example_9999');
    if (admission.willEvict) {
      assert.ok(admission.evictionCandidateKey, 'a projected candidate must be named');
      assert.match(admission.evictionCandidateKey, OPAQUE_LABEL);
      assert.doesNotMatch(admission.evictionCandidateKey, new RegExp(USER_MARK));
    }
  });

  it('projects the idle-reaper log line', () => {
    const startedAt = Date.now() - 3 * 60 * 60 * 1000;
    __resetLsPoolForTests([
      { key: RAW, proxy, startedAt, lastUsedAt: startedAt, ready: true, activeRequests: 0, process: fakeProcess() },
    ]);
    const captured = captureLogs();
    try {
      sweepIdleLanguageServers();
    } finally {
      captured.restore();
    }
    const line = captured.texts('info').find((t) => t.includes('LS idle reaper stopped'));
    assert.ok(line, JSON.stringify(captured.seen));
    assert.match(line, new RegExp(`LS idle reaper stopped ${publicKey()}`));
    assert.doesNotMatch(line, new RegExp(USER_MARK));
  });

  it('projects stop/restart lifecycle logs for default and per-user keys', async () => {
    __resetLsPoolForTests([
      { key: 'default', startedAt: 1, lastUsedAt: 1, ready: true, process: fakeProcess(11) },
      { key: RAW, proxy, startedAt: 1, lastUsedAt: 1, ready: true, process: fakeProcess(22) },
    ]);
    let captured = captureLogs();
    try {
      stopLanguageServer();
    } finally {
      captured.restore();
    }
    const stops = captured.texts('info').filter((t) => t.includes('stopped'));
    assert.ok(stops.some((t) => t === 'LS instance default stopped'), JSON.stringify(stops));
    assert.ok(stops.some((t) => t === `LS instance ${publicKey()} stopped`), JSON.stringify(stops));
    assert.doesNotMatch(stops.join('\n'), new RegExp(USER_MARK));

  });

  it('projects restart/stop and spawn-error lines in a child process', () => {
    const body = [
      `const RAW = ${JSON.stringify(RAW)};`,
      `const proxy = ${JSON.stringify(proxy)};`,
      'm.__resetLsPoolForTests([{ key: RAW, proxy, startedAt: 1, lastUsedAt: 1, ready: true, process: { pid: 33, exitCode: 0, kill() {}, once() {}, off() {} } }]);',
      'result.label = m.getLsAdmissionStatus(proxy).key;',
      'try { await m.restartLsForProxy(proxy); } catch { /* expected synthetic failure */ }',
    ].join('\n');
    const { captured: lines, result } = runLangserverChild(body, {}, true);
    assert.match(result.label, OPAQUE_LABEL);
    const restartLine = lines.find((e) => e.text.includes('stopped for restart'))?.text;
    assert.equal(restartLine, `LS instance ${result.label} stopped for restart (already_exited)`);
    const spawnErrors = lines.filter((e) => e.level === 'error' && e.text.includes('spawn error')).map((e) => e.text);
    assert.ok(spawnErrors.length >= 1, JSON.stringify(lines));
    assert.ok(spawnErrors.some((t) => t.startsWith(`LS instance ${result.label} spawn error:`)), JSON.stringify(spawnErrors));
    assert.doesNotMatch(lines.map((e) => e.text).join('\n'), new RegExp(USER_MARK));
  });

  it('projects the child stderr prefix and the key echoed inside child output', () => {
    const body = [
      `const proxy = ${JSON.stringify(proxy)};`,
      'result.label = m.getLsAdmissionStatus(proxy).key;',
      'try { await m.ensureLs(proxy); } catch { /* expected synthetic exit */ }',
    ].join('\n');
    const { captured: lines, result } = runLangserverChild(body);
    assert.match(result.label, OPAQUE_LABEL);
    const stderrLines = lines.filter((e) => e.text.includes(':stderr]')).map((e) => e.text);
    assert.equal(stderrLines.length, 1);
    assert.ok(stderrLines[0].startsWith(`[LS:${result.label}:stderr] `));
    assert.ok(stderrLines[0].endsWith(result.label));
    assert.doesNotMatch(stderrLines[0], new RegExp(USER_MARK));
  });

  it('keeps one restart counter per private pool key sharing a proxy endpoint', () => {
    const secondProxy = { ...proxy, username: `user-${USER_MARK}_123_usecond` };
    const body = [
      `const first = ${JSON.stringify(proxy)};`,
      `const second = ${JSON.stringify(secondProxy)};`,
      'result.labels = [first, second].map(proxy => m.getLsAdmissionStatus(proxy).key);',
      'await Promise.allSettled([m.ensureLs(first), m.ensureLs(second)]);',
      'result.stats = m.getRestartStats();',
    ].join('\n');
    const { result } = runLangserverChild(body, { LS_AUTO_RESTART: '1' });
    assert.notEqual(result.labels[0], result.labels[1]);
    for (const label of result.labels) assert.match(label, OPAQUE_LABEL);
    assert.deepEqual(result.stats, Object.fromEntries(result.labels.map(label => [label, 1])));
  });
});

// The memory-guard error text is built inside a module-private waiter whose
// only public surface is the thrown error (auth.js forwards `err.message` into
// API payloads). Exercise it in a fresh process: the guard is frozen from env
// at import time, so it cannot be armed in this module's already-loaded copy.
describe('LS memory-guard error text', () => {
  it('names the public projection in the thrown error', () => {
    const body = [
      'try {',
      `  await m.ensureLs({ host: 'guard.example', port: 9600, username: 'user-${USER_MARK}', password: 'pw' });`,
      '  result.ok = true;',
      '} catch (e) {',
      '  Object.assign(result, { ok: false, code: e?.code, type: e?.type, message: e?.message });',
      '}',
    ].join('\n');
    const { result: parsed } = runLangserverChild(body, {
      LS_SPAWN_MIN_AVAILABLE_BYTES: '999999999gb',
      LS_POOL_WAIT_MS: '1',
      LS_MAX_INSTANCES: '3',
    });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'LS_MEMORY_GUARD');
    assert.equal(parsed.type, 'ls_memory_guard');
    assert.match(parsed.message, /^LS memory guard blocked new instance px_[a-f0-9]{32}_u_redacted:/);
    assert.doesNotMatch(parsed.message, new RegExp(USER_MARK));
  });
});
