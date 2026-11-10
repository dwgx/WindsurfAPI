import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSubprocessEnv, buildMinimalSubprocessEnv } from '../src/log-safety.js';
import {
  runDevinAcpProcess,
  __setDevinAcpSpawnForTest,
  probeDevinCliAvailable,
  __resetDevinAcpProbeCache,
} from '../src/devin-acp.js';
import { runDevinPrint } from '../src/special-agent.js';

// L3b env-leak fix: spawned subprocesses must not inherit credential-shaped
// env vars. The audit measured 15/15 sentinel keys reaching children. These
// tests pin the builder contract AND prove the three spawn call sites wire it
// in — by capturing the actual env each child receives.
//
//   - probe (`devin --version`, PATH-resolved): strict allowlist env.
//   - `devin acp`: denylist env; credential rides the authenticate RPC, not env.
//   - `devin -p`: denylist env + ONE deliberate credential channel
//     (WINDSURF_API_KEY or DEVIN_CLI_API_KEY_ENV's rename), injected only when
//     a pool key exists.

const SENTINELS = {
  DEVIN_CONNECT_CRED_KEY: 'sentinel-kek',
  API_KEY: 'sentinel-apikey',
  DASHBOARD_PASSWORD: 'sentinel-dash',
  MY_GITHUB_TOKEN: 'sentinel-gh',
  AWS_SECRET_ACCESS_KEY: 'sentinel-aws',
  npm_config__authToken: 'sentinel-npm',
  WINDSURF_API_KEY: 'sentinel-upstream',
  SSH_AUTH_SOCK: '/tmp/sentinel-agent.sock',
};
const KEEPERS = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/sentinel',
  TMPDIR: '/tmp',
  HTTP_PROXY: 'http://proxy:8080',
  DEVIN_ACP_VISION: '1',
  DEVIN_PERMISSION_MODE: 'auto',
  WINDSURFAPI_LS_CURL: '/opt/fake/curl',
};

const MANAGED_KEYS = [
  ...Object.keys(SENTINELS),
  ...Object.keys(KEEPERS),
  'DEVIN_CLI_PATH', 'DEVIN_CLI_ARGS_JSON', 'DEVIN_CLI_API_KEY_ENV',
  'DEVIN_CLI_USE_ACCOUNT_POOL', 'DEVIN_ACP_PROBE_ARGS_JSON',
  'DEVIN_ACP_PROBE_TTL_MS', 'DEVIN_MAX_PROCS', 'DEVIN_CLI_MODE',
];
const originalEnv = Object.fromEntries(MANAGED_KEYS.map(k => [k, process.env[k]]));
const tmpDirs = [];

afterEach(() => {
  __setDevinAcpSpawnForTest(null);
  __resetDevinAcpProbeCache();
  for (const k of MANAGED_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function seedEnv() {
  for (const [k, v] of Object.entries(SENTINELS)) process.env[k] = v;
  for (const [k, v] of Object.entries(KEEPERS)) process.env[k] = v;
}

// Env keys are case-insensitive on Windows: the real PATH key may be spelled
// `Path` both in process.env and in whatever env object reaches the child.
function getCi(env, name) {
  const upper = name.toUpperCase();
  const key = Object.keys(env).find(k => k.toUpperCase() === upper);
  return key ? env[key] : undefined;
}

function mkDir() {
  const dir = mkdtempSync(join(tmpdir(), 'windsurfapi-subenv-'));
  tmpDirs.push(dir);
  return dir;
}

describe('buildSubprocessEnv — denylist filter', () => {
  it('strips explicit repo credentials and secret-shaped names', () => {
    const env = buildSubprocessEnv({ ...SENTINELS, ...KEEPERS, PGPASSWORD: 'x', MYSQL_PWD: 'y' });
    for (const k of Object.keys(SENTINELS)) {
      assert.equal(env[k], undefined, `${k} must not reach a subprocess`);
    }
    assert.equal(env.PGPASSWORD, undefined, 'fused PASSWORD name must strip');
    assert.equal(env.MYSQL_PWD, undefined, '_PWD boundary name must strip');
  });

  it('keeps general env the children legitimately need', () => {
    const env = buildSubprocessEnv({ ...SENTINELS, ...KEEPERS });
    for (const [k, v] of Object.entries(KEEPERS)) {
      assert.equal(env[k], v, `${k} should survive the filter`);
    }
  });

  it('does not false-positive on non-secret names containing marker substrings', () => {
    const env = buildSubprocessEnv({
      SSH_ASKPASS: '/usr/bin/askpass',   // program path, not a secret
      GIT_ASKPASS: '/usr/bin/git-askpass',
      MONKEY: 'banana',                  // ends in "key" mid-word
      OLDPWD: '/prev/dir',
      SSL_CERT_FILE: '/etc/ssl/cert.pem',// CA trust config the installer needs
      NODE_EXTRA_CA_CERTS: '/ca.pem',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/dbus',
    });
    assert.equal(env.SSH_ASKPASS, '/usr/bin/askpass');
    assert.equal(env.GIT_ASKPASS, '/usr/bin/git-askpass');
    assert.equal(env.MONKEY, 'banana');
    assert.equal(env.OLDPWD, '/prev/dir');
    assert.equal(env.SSL_CERT_FILE, '/etc/ssl/cert.pem');
    assert.equal(env.NODE_EXTRA_CA_CERTS, '/ca.pem');
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/dbus');
  });

  it('keep re-admits exactly the named vars (deliberate credential channel)', () => {
    const env = buildSubprocessEnv(
      { ...SENTINELS, HOME: '/h' },
      { keep: ['WINDSURF_API_KEY', 'SSH_AUTH_SOCK'] },
    );
    assert.equal(env.WINDSURF_API_KEY, 'sentinel-upstream');
    assert.equal(env.SSH_AUTH_SOCK, '/tmp/sentinel-agent.sock');
    // ...and nothing else comes back.
    assert.equal(env.DEVIN_CONNECT_CRED_KEY, undefined);
    assert.equal(env.API_KEY, undefined);
    assert.equal(env.MY_GITHUB_TOKEN, undefined);
  });
});

describe('buildMinimalSubprocessEnv — strict allowlist (probe env)', () => {
  it('passes only the core set — no secrets, no proxy vars, no config', () => {
    const env = buildMinimalSubprocessEnv({
      ...SENTINELS, ...KEEPERS,
      USER: 'sentinel-user', SHELL: '/bin/bash',
    });
    for (const k of Object.keys(SENTINELS)) {
      assert.equal(env[k], undefined, `${k} must not reach a PATH-resolved probe`);
    }
    assert.equal(env.PATH, '/usr/bin:/bin');
    assert.equal(env.HOME, '/home/sentinel');
    assert.equal(env.TMPDIR, '/tmp');
    assert.equal(env.USER, 'sentinel-user');
    assert.equal(env.HTTP_PROXY, undefined, 'a version probe never dials — no proxy vars');
    assert.equal(env.DEVIN_ACP_VISION, undefined, 'no DEVIN_* config reaches the probe');
  });

  it('win32 adds the platform set and matches keys case-insensitively', () => {
    const env = buildMinimalSubprocessEnv({
      Path: 'C:\\bin',           // real Windows spelling
      ComSpec: 'C:\\cmd.exe',
      APPDATA: 'C:\\AppData',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\s',
      ...SENTINELS,
      HTTP_PROXY: 'http://x',
    }, { platform: 'win32' });
    assert.equal(env.Path, 'C:\\bin');
    assert.equal(env.ComSpec, 'C:\\cmd.exe');
    assert.equal(env.APPDATA, 'C:\\AppData');
    assert.equal(env.SystemRoot, 'C:\\Windows');
    assert.equal(env.USERPROFILE, 'C:\\Users\\s');
    for (const k of Object.keys(SENTINELS)) assert.equal(env[k], undefined);
    assert.equal(env.HTTP_PROXY, undefined);
  });
});

describe('spawn sites wire the filter (integration)', () => {
  // A fake child good enough for makeAcpClient: EventEmitter stdio + kill.
  function fakeAcpChild(captured) {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.writable = true;
    child.stdin.write = () => {};
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    return (command, args, options) => {
      captured.command = command;
      captured.env = options.env;
      return child;
    };
  }

  it('devin acp child: secrets absent, general env present, apiKey stays on the RPC channel', async () => {
    seedEnv();
    const captured = {};
    __setDevinAcpSpawnForTest(fakeAcpChild(captured));

    const ac = new AbortController();
    const run = runDevinAcpProcess('hi', { apiKey: 'pool-key-1', signal: ac.signal });
    // The fake never answers initialize; abort to settle the pending promise.
    await new Promise(r => setImmediate(r));
    ac.abort();
    await assert.rejects(run, /aborted/i);

    assert.ok(captured.env, 'spawn must receive an explicit env');
    for (const k of Object.keys(SENTINELS)) {
      if (k === 'SSH_AUTH_SOCK') continue; // deliberately kept — asserted below
      assert.equal(captured.env[k], undefined, `${k} must not reach devin acp`);
    }
    assert.equal(getCi(captured.env, 'PATH'), '/usr/bin:/bin');
    assert.equal(captured.env.HOME, '/home/sentinel');
    assert.equal(captured.env.DEVIN_ACP_VISION, '1', 'operator DEVIN_* config survives');
    assert.equal(captured.env.DEVIN_PERMISSION_MODE, 'auto');
    // The credential rides the authenticate RPC _meta, never env: the pool key
    // must not appear under ANY env var.
    assert.ok(!Object.values(captured.env).includes('pool-key-1'),
      'pool apiKey must not be smuggled into the child env');
    // Agent-side socket vars ARE kept — the CLI runs local tools (git over ssh).
    assert.equal(captured.env.SSH_AUTH_SOCK, '/tmp/sentinel-agent.sock');
  });

  it('devin --version probe child: allowlist env — secrets AND config absent (end-to-end)', async () => {
    seedEnv();
    // A fake probe target that dumps its env to a marker file and exits 0.
    const dir = mkDir();
    const marker = join(dir, 'probe-env.json');
    const script = join(dir, 'dump-env.mjs');
    writeFileSync(script, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.env));
`, 'utf8');
    process.env.DEVIN_CLI_PATH = process.execPath;
    process.env.DEVIN_ACP_PROBE_ARGS_JSON = JSON.stringify([script]);
    process.env.DEVIN_ACP_PROBE_TTL_MS = '0';

    const r = await probeDevinCliAvailable();
    assert.equal(r.available, true);
    assert.ok(existsSync(marker), 'probe target must have run');
    const childEnv = JSON.parse(readFileSync(marker, 'utf8'));

    for (const k of Object.keys(SENTINELS)) {
      assert.equal(childEnv[k], undefined, `${k} must not reach the probe child`);
    }
    // The strictest site also withholds operator config and proxy vars.
    assert.equal(childEnv.DEVIN_ACP_VISION, undefined);
    assert.equal(childEnv.DEVIN_PERMISSION_MODE, undefined);
    assert.equal(childEnv.HTTP_PROXY, undefined);
    assert.equal(childEnv.WINDSURFAPI_LS_CURL, undefined);
    // But it can still exec and resolve its own runtime basics.
    assert.ok(getCi(childEnv, 'PATH'), 'probe needs PATH to resolve');
    assert.equal(childEnv.HOME, '/home/sentinel');
  });

  it('devin -p child: secrets absent except the ONE deliberate pool-credential channel (end-to-end)', async () => {
    seedEnv();
    const dir = mkDir();
    const marker = join(dir, 'print-env.json');
    const script = join(dir, 'dump-env.mjs');
    writeFileSync(script, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.env));
console.log('PRINT_OK');
`, 'utf8');
    process.env.DEVIN_CLI_PATH = process.execPath;
    process.env.DEVIN_CLI_ARGS_JSON = JSON.stringify([script]);
    process.env.DEVIN_CLI_MODE = 'print';
    process.env.DEVIN_MAX_PROCS = '2';

    const res = await runDevinPrint('hi', { apiKey: 'pool-key-2' });
    assert.equal(res.text, 'PRINT_OK');
    const childEnv = JSON.parse(readFileSync(marker, 'utf8'));

    for (const k of Object.keys(SENTINELS)) {
      if (k === 'WINDSURF_API_KEY') continue; // deliberate channel — checked below
      if (k === 'SSH_AUTH_SOCK') continue;   // deliberately kept — checked below
      assert.equal(childEnv[k], undefined, `${k} must not reach devin -p`);
    }
    // The pool credential arrives under exactly one var, with the pool value —
    // overwriting the ambient sentinel, not leaking it.
    assert.equal(childEnv.WINDSURF_API_KEY, 'pool-key-2');
    assert.equal(getCi(childEnv, 'PATH'), '/usr/bin:/bin');
    assert.equal(childEnv.DEVIN_PERMISSION_MODE, 'auto');
    assert.equal(childEnv.SSH_AUTH_SOCK, '/tmp/sentinel-agent.sock');
    // And no second copy of the credential under another name.
    const copies = Object.entries(childEnv).filter(([, v]) => v === 'pool-key-2');
    assert.deepEqual(copies.map(([k]) => k), ['WINDSURF_API_KEY']);
  });

  it('devin -p child honours DEVIN_CLI_API_KEY_ENV rename for the credential channel', async () => {
    seedEnv();
    const dir = mkDir();
    const marker = join(dir, 'print-env2.json');
    const script = join(dir, 'dump-env2.mjs');
    writeFileSync(script, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.env));
console.log('PRINT_OK');
`, 'utf8');
    process.env.DEVIN_CLI_PATH = process.execPath;
    process.env.DEVIN_CLI_ARGS_JSON = JSON.stringify([script]);
    process.env.DEVIN_CLI_API_KEY_ENV = 'MY_CLI_CRED_VAR';
    process.env.DEVIN_CLI_MODE = 'print';
    process.env.DEVIN_MAX_PROCS = '2';

    const res = await runDevinPrint('hi', { apiKey: 'pool-key-3' });
    assert.equal(res.text, 'PRINT_OK');
    const childEnv = JSON.parse(readFileSync(marker, 'utf8'));

    assert.equal(childEnv.MY_CLI_CRED_VAR, 'pool-key-3');
    assert.equal(childEnv.WINDSURF_API_KEY, undefined, 'ambient upstream key must not pass when the channel is renamed');
    assert.equal(childEnv.DEVIN_CONNECT_CRED_KEY, undefined);
  });
});
