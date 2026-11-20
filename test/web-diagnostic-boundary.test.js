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
import { startServer, redactInvalidProxyInput } from '../src/server.js';
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

/**
 * Run an LS snippet in a fresh process. The spawn/restart paths arm the
 * auto-restart timer from module-load env, so `LS_AUTO_RESTART=0` here keeps
 * the retry ladder out of this suite. The child returns patched-log captures
 * as its only stdout.
 */
function runLangserverChild(body, extraEnv = {}) {
  const script = [
    "const { log } = await import('./src/config.js');",
    'const captured = [];',
    "for (const level of ['debug', 'info', 'warn', 'error']) {",
    '  log[level] = (...args) => { captured.push({ level, text: args.map(String).join(\' \') }); };',
    '}',
    "const m = await import('./src/langserver.js');",
    body,
    // A losing waitPortReady() keeps a 25 s timer alive after the race settles;
    // exit explicitly once the capture is flushed so the suite stays fast.
    'process.stdout.write(JSON.stringify({ captured }), () => process.exit(0));',
  ].join('\n');
  const env = { ...process.env, LS_AUTO_RESTART: '0', ...extraEnv };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { cwd: repoRoot, env, encoding: 'utf8', timeout: 60_000 },
  );
  return JSON.parse(out);
}

describe('redactInvalidProxyInput', () => {
  it('masks scheme userinfo that parseProxyUrl rejected', () => {
    assert.equal(
      redactInvalidProxyInput(`http://webdiag-user:${MARK}@203.0.113.9`),
      'http://***@203.0.113.9',
    );
  });

  it('masks bare userinfo (no scheme) and keeps only the last @ boundary', () => {
    assert.equal(
      redactInvalidProxyInput(`webdiag-user:${MARK}@203.0.113.9`),
      '***@203.0.113.9',
    );
    assert.equal(redactInvalidProxyInput('http://first@second:secret@host.example'), 'http://***@host.example');
  });

  it('cannot forge a second log line and leaves credential-free input intact', () => {
    assert.equal(redactInvalidProxyInput('not-a-valid-proxy-url'), 'not-a-valid-proxy-url');
    assert.equal(redactInvalidProxyInput('bad\r\ninjected'), 'bad injected');
  });
});

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
    assert.doesNotMatch(warns[0], new RegExp(MARK), 'the credential marker must never reach the warn line');
    assert.doesNotMatch(warns[0], /webdiag-user/, 'the username must not reach the warn line');
    assert.match(warns[0], /http:\/\/\*\*\*@203\.0\.113\.9/, 'host stays diagnosable');
  });
});

describe('LS pool key presentation boundary', () => {
  const RAW = `px_sticky_example_9000_uuser_${USER_MARK}`;
  const PUBLIC = 'px_sticky_example_9000_u_redacted';
  const proxy = { host: 'sticky.example', port: 9000, username: `user-${USER_MARK}`, password: 'synthetic-pw' };
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
    assert.deepEqual(status.instances.map((i) => i.key), ['default', PUBLIC]);
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
    assert.equal(admission.key, PUBLIC);

    assert.deepEqual(_poolKeys(), [RAW], 'the pool keeps the raw key');
    assert.equal(getProxyByKey(RAW)?.username, `user-${USER_MARK}`, 'proxy lookup keeps exact identity');
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
      assert.match(admission.evictionCandidateKey, /_u_redacted$/);
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
    assert.match(line, new RegExp(`LS idle reaper stopped ${PUBLIC}`));
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
    assert.ok(stops.some((t) => t === `LS instance ${PUBLIC} stopped`), JSON.stringify(stops));
    assert.doesNotMatch(stops.join('\n'), new RegExp(USER_MARK));

  });

  it('projects restart/stop and spawn-error lines in a child process', () => {
    const missingBinary = join(repoRoot, 'test', 'webdiag-missing-language-server');
    const body = [
      `const RAW = ${JSON.stringify(RAW)};`,
      `const proxy = ${JSON.stringify(proxy)};`,
      'm.__resetLsPoolForTests([{ key: RAW, proxy, startedAt: 1, lastUsedAt: 1, ready: true, process: { pid: 33, exitCode: 0, kill() {}, once() {}, off() {} } }]);',
      `m.configureLanguageServer({ binaryPath: ${JSON.stringify(missingBinary)} });`,
      'try { await m.restartLsForProxy(proxy); } catch { /* expected: the binary is absent */ }',
    ].join('\n');
    const { captured: lines } = runLangserverChild(body);
    const restartLine = lines.find((e) => e.text.includes('stopped for restart'))?.text;
    assert.equal(restartLine, `LS instance ${PUBLIC} stopped for restart (already_exited)`);
    const spawnErrors = lines.filter((e) => e.level === 'error' && e.text.includes('spawn error')).map((e) => e.text);
    assert.ok(spawnErrors.length >= 1, JSON.stringify(lines));
    assert.ok(spawnErrors.some((t) => t.startsWith(`LS instance ${PUBLIC} spawn error:`)), JSON.stringify(spawnErrors));
    assert.doesNotMatch(lines.map((e) => e.text).join('\n'), new RegExp(USER_MARK));
  });

  it('projects the child stdout/stderr prefix and the key echoed inside child output', () => {
    // `node` rejects the LS flags as unknown options and echoes argv (including
    // --codeium_dir=<root>/px_…_u<user>) to stderr. That exercises the real
    // proc.stderr handler and the key-in-payload scrub, with no LS binary.
    const body = [
      'm.configureLanguageServer({ binaryPath: process.execPath });',
      `try { await m.ensureLs({ host: 'stderr.example', port: 9500, username: ${JSON.stringify(`user-${USER_MARK}`)} }); } catch { /* expected: node rejects the LS argv */ }`,
    ].join('\n');
    const { captured: lines } = runLangserverChild(body);
    const stderrLines = lines.filter((e) => e.text.includes(':stderr]')).map((e) => e.text);
    assert.ok(stderrLines.length >= 1, JSON.stringify(lines));
    for (const line of stderrLines) {
      assert.match(line, /^\[LS:px_stderr_example_9500_u_redacted:stderr\] /, line);
      assert.doesNotMatch(line, new RegExp(USER_MARK), line);
    }
  });
});

// The memory-guard error text is built inside a module-private waiter whose
// only public surface is the thrown error (auth.js forwards `err.message` into
// API payloads). Exercise it in a fresh process: the guard is frozen from env
// at import time, so it cannot be armed in this module's already-loaded copy.
describe('LS memory-guard error text', () => {
  it('names the public projection in the thrown error', () => {
    const script = [
      "const { log } = await import('./src/config.js');",
      "for (const level of ['debug', 'info', 'warn', 'error']) log[level] = () => {};",
      "const m = await import('./src/langserver.js');",
      'let result;',
      'try {',
      "  await m.ensureLs({ host: 'guard.example', port: 9600, username: 'user-WEBDIAGUSER', password: 'pw' });",
      '  result = { ok: true };',
      '} catch (e) {',
      '  result = { ok: false, code: e?.code || null, type: e?.type || null, message: String(e?.message || e) };',
      '}',
      'process.stdout.write(JSON.stringify(result), () => process.exit(0));',
    ].join('\n');
    const env = {
      ...process.env,
      LS_AUTO_RESTART: '0',
      LS_SPAWN_MIN_AVAILABLE_BYTES: '999999999gb',
      LS_POOL_WAIT_MS: '1',
      LS_MAX_INSTANCES: '3',
    };
    delete env.NODE_OPTIONS;
    delete env.NODE_TEST_CONTEXT;
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: repoRoot, env, encoding: 'utf8', timeout: 30_000 },
    );
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, false, out);
    assert.equal(parsed.code, 'LS_MEMORY_GUARD');
    assert.equal(parsed.type, 'ls_memory_guard');
    assert.match(parsed.message, /^LS memory guard blocked new instance px_guard_example_9600_u_redacted:/);
    assert.doesNotMatch(parsed.message, new RegExp(USER_MARK));
  });
});
