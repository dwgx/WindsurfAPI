// D9 source-OTA attestation at the two mutation points:
//   - dashboard POST /self-update (src/dashboard/api.js)
//   - update.sh before reset/merge/restart
//
// The property under test is "a mismatched attestation cannot reach
// merge --ff-only / reset --hard". The warn arm proves the default rollout
// does not brick an install that has no attestation yet.

import { after, afterEach, describe, it, it as nodeIt } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { config, log } from '../src/config.js';
import { configureBindHost } from '../src/auth.js';
import { setRuntimeApiKey, setRuntimeDashboardPassword } from '../src/runtime-config.js';
import {
  handleDashboardApi,
  setDockerSelfUpdateForTest,
  setGitExecFileForTest,
  setReleaseAttestationVerifierForTest,
  setSelfUpdateRestartSchedulerForTest,
  setSelfUpdateSupervisorDetectorForTest,
} from '../src/dashboard/api.js';
import { ReleaseAttestationError, verifyReleaseAttestation } from '../src/release-attestation.js';
import {
  isolatedGitEnv, REAL_GIT, SAFE_TMP_ROOT, SKIP_REASON, trustedFixturePath,
} from './git-fixture-env.js';

const SOURCE_ROOT = resolve(process.cwd());
const API_TEST_ROOT = mkdtempSync(join(SAFE_TMP_ROOT, 'wa-self-update-attestation-state-'));
mkdirSync(join(API_TEST_ROOT, '.git'), { recursive: true });
process.chdir(API_TEST_ROOT);
const BEFORE_JSON = join(API_TEST_ROOT, 'data', 'self-update-before.json');
const PENDING_JSON = join(API_TEST_ROOT, 'data', 'self-update-before.pending.json');
const JOURNAL_JSON = join(API_TEST_ROOT, 'data', 'self-update-journal.json');
const UPDATE_LOCK_DIR = join(API_TEST_ROOT, '.git', 'windsurfapi-update.lock');
const prevNoAuth = process.env.DASHBOARD_ALLOW_NO_AUTH;
const prevAttestationMode = process.env.WINDSURFAPI_UPDATE_ATTESTATION;
const prevAttestationDir = process.env.WINDSURFAPI_ATTESTATION_DIR;
const origPwd = config.dashboardPassword;
const origKey = config.apiKey;

const HEAD = 'a'.repeat(40);
const REMOTE = 'b'.repeat(40);
const TAG = 'c'.repeat(40);
const TAG_OBJECT = 'f'.repeat(40);
const OTHER_COMMIT = '9'.repeat(40);

after(() => {
  process.chdir(SOURCE_ROOT);
  rmSync(API_TEST_ROOT, { recursive: true, force: true });
});

function openAuth() {
  config.dashboardPassword = '';
  config.apiKey = '';
  setRuntimeApiKey('');
  setRuntimeDashboardPassword('');
  process.env.DASHBOARD_ALLOW_NO_AUTH = '1';
  configureBindHost('127.0.0.1');
  setSelfUpdateSupervisorDetectorForTest(() => ({ supervised: true, kind: 'test' }));
  setSelfUpdateRestartSchedulerForTest((_callback, release) => {
    release();
    return false;
  });
  setDockerSelfUpdateForTest({
    detect: async () => ({ available: false, reason: 'test-disabled' }),
    run: async () => ({ ok: false, reason: 'test-disabled' }),
  });
}

afterEach(() => {
  gitCalls.length = 0;
  setGitExecFileForTest(null);
  setDockerSelfUpdateForTest(null);
  setReleaseAttestationVerifierForTest(null);
  setSelfUpdateRestartSchedulerForTest(null);
  setSelfUpdateSupervisorDetectorForTest(null);
  try { rmSync(BEFORE_JSON, { force: true }); } catch {}
  try { rmSync(PENDING_JSON, { force: true }); } catch {}
  try { rmSync(JOURNAL_JSON, { force: true }); } catch {}
  try { rmSync(UPDATE_LOCK_DIR, { recursive: true, force: true }); } catch {}
  config.dashboardPassword = origPwd;
  config.apiKey = origKey;
  setRuntimeApiKey('');
  setRuntimeDashboardPassword('');
  configureBindHost('0.0.0.0');
  if (prevNoAuth === undefined) delete process.env.DASHBOARD_ALLOW_NO_AUTH;
  else process.env.DASHBOARD_ALLOW_NO_AUTH = prevNoAuth;
  if (prevAttestationMode === undefined) delete process.env.WINDSURFAPI_UPDATE_ATTESTATION;
  else process.env.WINDSURFAPI_UPDATE_ATTESTATION = prevAttestationMode;
  if (prevAttestationDir === undefined) delete process.env.WINDSURFAPI_ATTESTATION_DIR;
  else process.env.WINDSURFAPI_ATTESTATION_DIR = prevAttestationDir;
});

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; },
    end(chunk) { this.body += chunk ? String(chunk) : ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

const gitCalls = [];
function gitStub(map) {
  let currentHead = typeof map['rev-parse HEAD'] === 'string' ? map['rev-parse HEAD'] : HEAD;
  setGitExecFileForTest((bin, args, opts, cb) => {
    const key = args.join(' ');
    gitCalls.push(key);
    if (key === 'rev-parse HEAD') {
      cb(null, currentHead + '\n', '');
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(map, key)) {
      if (key.startsWith('ls-tree -r -z --name-only ')
          || key === 'ls-files --others --ignored --exclude-standard --directory -z'
          || key.startsWith('ls-files --others --ignored --exclude-standard -z -- ')) {
        cb(null, '', '');
        return;
      }
      if (key === 'for-each-ref --format=%(objectname) refs/stash'
          || key === 'stash list --format=%H%x09%gs') {
        cb(null, '', '');
        return;
      }
      if (key === 'status --porcelain --untracked-files=no --ignore-submodules=none') {
        cb(null, '', '');
        return;
      }
    }
    const matchedKey = Object.prototype.hasOwnProperty.call(map, key)
      ? key
      : Object.keys(map).find(candidate => candidate.endsWith('*') && key.startsWith(candidate.slice(0, -1)));
    if (matchedKey) {
      const value = typeof map[matchedKey] === 'function' ? map[matchedKey](key) : map[matchedKey];
      if (value && typeof value === 'object' && value.error instanceof Error) {
        if (value.head) currentHead = value.head;
        cb(value.error, value.stdout || '', value.stderr || value.error.message);
        return;
      }
      if (value instanceof Error) {
        cb(value, '', value.message);
        return;
      }
      const mutation = key.match(/^(?:merge --ff-only|reset --hard) ([0-9a-f]{40}|[0-9a-f]{64})$/i);
      if (mutation && map.__skipHeadMutation !== true) currentHead = mutation[1];
      const nulMode = key.includes(' -z ') || key.endsWith(' -z');
      cb(null, String(value) + (nulMode ? '' : '\n'), '');
    } else {
      const err = new Error('unexpected git: ' + key);
      err.code = 'STUB_MISS';
      cb(err, '', '');
    }
  });
}

function updateScript(extra) {
  const map = {
    'rev-parse HEAD': HEAD,
    'rev-parse --abbrev-ref HEAD': 'master',
    'fetch --quiet --no-tags origin master': '',
    'rev-parse origin/master': REMOTE,
    'remote get-url origin': '/tmp/windsurfapi-test-origin.git',
    'log -1 --pretty=format:%s': 'local msg',
    'status --porcelain -uno': '',
    'ls-remote --tags origin refs/tags/v[0-9]*': [
      `${TAG_OBJECT}\trefs/tags/v3.9.21`,
      `${TAG}\trefs/tags/v3.9.21^{}`,
    ].join('\n'),
    'fetch --quiet --no-tags origin refs/tags/v3.9.21': '',
    'rev-parse FETCH_HEAD': TAG_OBJECT,
    'rev-parse FETCH_HEAD^{commit}': TAG,
    ['cat-file -t ' + TAG_OBJECT]: 'tag',
    ['merge-base --is-ancestor ' + TAG + ' origin/master']: '',
    ['rev-list --count ' + TAG + '..' + REMOTE]: '0',
    ['rev-list --count ' + HEAD + '..' + TAG]: '1',
    ['rev-list --count ' + TAG + '..' + HEAD]: '0',
    ['log -1 --pretty=format:%s ' + TAG]: 'released msg',
  };
  return Object.assign(map, extra || {});
}

function postUpdate(req) {
  const res = fakeRes();
  return handleDashboardApi('POST', '/self-update', req, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res)
    .then(() => res.json());
}

describe('dashboard self-update attestation gate', () => {
  it('proceeds when the selected tag has a matching attested commit', async () => {
    openAuth();
    let mergeRan = false;
    const seen = [];
    setReleaseAttestationVerifierForTest(async (options) => {
      seen.push(options);
      return { status: 'verified', mode: options.mode, tag: options.tag, commit: options.commit };
    });
    gitStub(updateScript({
      ['merge --ff-only ' + TAG]: () => { mergeRan = true; return 'Fast-forward'; },
    }));

    const body = await postUpdate({});
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(mergeRan, true);
    assert.ok(seen.length >= 1, 'the selected tag must be verified before the mutation');
    assert.equal(seen[0].tag, 'v3.9.21');
    assert.equal(seen[0].commit, TAG);
    assert.equal(seen[0].mode, 'warn');
    assert.equal(JSON.parse(readFileSync(BEFORE_JSON, 'utf8')).after, TAG);
  });

  it('refuses a mismatched attested commit before reset/merge', async () => {
    openAuth();
    let mergeRan = false;
    let resetRan = false;
    let restarts = 0;
    setSelfUpdateRestartSchedulerForTest((_callback, release) => { restarts++; release(); return false; });
    setReleaseAttestationVerifierForTest(async () => {
      throw new ReleaseAttestationError('ERR_RELEASE_ATTESTATION_MISMATCH', 'attested commit does not match');
    });
    gitStub(updateScript({
      ['merge --ff-only ' + TAG]: () => { mergeRan = true; return 'Fast-forward'; },
      ['reset --hard ' + TAG]: () => { resetRan = true; return ''; },
    }));

    const body = await postUpdate({});
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.equal(body.error, 'ERR_RELEASE_ATTESTATION_MISMATCH');
    assert.equal(mergeRan, false, 'mismatched attestation must never reach merge');
    assert.equal(resetRan, false, 'mismatched attestation must never reach reset');
    assert.equal(gitCalls.some(call => call.startsWith('merge --ff-only ')), false);
    assert.equal(gitCalls.some(call => call.startsWith('reset --hard ')), false);
    assert.equal(existsSync(BEFORE_JSON), false, 'no rollback point may be written before refusal');
    assert.equal(restarts, 0);
  });

  it('refuses a missing attestation in required mode', async () => {
    openAuth();
    process.env.WINDSURFAPI_UPDATE_ATTESTATION = 'required';
    let mergeRan = false;
    setReleaseAttestationVerifierForTest(async () => {
      throw new ReleaseAttestationError('ERR_RELEASE_ATTESTATION_MISSING', 'no release attestation');
    });
    gitStub(updateScript({
      ['merge --ff-only ' + TAG]: () => { mergeRan = true; return 'Fast-forward'; },
    }));

    const body = await postUpdate({});
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.equal(body.error, 'ERR_RELEASE_ATTESTATION_MISSING');
    assert.equal(mergeRan, false);
    assert.equal(existsSync(BEFORE_JSON), false);
  });

  it('warns and proceeds when the attestation is missing in warn mode', async () => {
    openAuth();
    const warnings = [];
    const originalWarn = log.warn;
    log.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
      let mergeRan = false;
      setReleaseAttestationVerifierForTest(async (options) => ({
        status: 'missing',
        mode: options.mode,
        warning: `no release attestation for ${options.tag}`,
      }));
      gitStub(updateScript({
        ['merge --ff-only ' + TAG]: () => { mergeRan = true; return 'Fast-forward'; },
      }));

      const body = await postUpdate({});
      assert.equal(body.ok, true, JSON.stringify(body));
      assert.equal(mergeRan, true, 'warn mode must keep existing installs updating');
      assert.ok(warnings.some(line => /attestation/i.test(line)), warnings.join('\n'));
    } finally {
      log.warn = originalWarn;
    }
  });

  it('uses the real verifier: a matching attestation directory reaches merge', async () => {
    openAuth();
    const dir = mkdtempSync(join(SAFE_TMP_ROOT, 'wa-attestation-api-'));
    try {
      writeFileSync(join(dir, 'release-attestation.json'), JSON.stringify({
        schema: 1,
        repository: 'dwgx/WindsurfAPI',
        tag: 'v3.9.21',
        commit: TAG,
        tree: 'e'.repeat(40),
        assets: { SHA256SUMS: 'd'.repeat(64) },
      }, null, 2) + '\n');
      writeFileSync(join(dir, 'release-attestation.json.sigstore.json'), '{}\n');
      process.env.WINDSURFAPI_ATTESTATION_DIR = dir;

      const cosignCalls = [];
      setReleaseAttestationVerifierForTest((options) => verifyReleaseAttestation({
        ...options,
        runCosign: (call) => { cosignCalls.push(call); },
      }));

      let mergeRan = false;
      gitStub(updateScript({
        'remote get-url origin': 'https://github.com/dwgx/WindsurfAPI.git',
        ['merge --ff-only ' + TAG]: () => { mergeRan = true; return 'Fast-forward'; },
      }));

      const body = await postUpdate({});
      assert.equal(body.ok, true, JSON.stringify(body));
      assert.equal(mergeRan, true);
      assert.ok(cosignCalls.length >= 1);
      assert.equal(cosignCalls[0].blobPath, resolve(dir, 'release-attestation.json'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the real verifier: a bad signature refuses before merge', async () => {
    openAuth();
    const dir = mkdtempSync(join(SAFE_TMP_ROOT, 'wa-attestation-api-bad-'));
    try {
      writeFileSync(join(dir, 'release-attestation.json'), JSON.stringify({
        schema: 1,
        repository: 'dwgx/WindsurfAPI',
        tag: 'v3.9.21',
        commit: TAG,
        tree: 'e'.repeat(40),
        assets: { SHA256SUMS: 'd'.repeat(64) },
      }, null, 2) + '\n');
      writeFileSync(join(dir, 'release-attestation.json.sigstore.json'), '{}\n');
      process.env.WINDSURFAPI_ATTESTATION_DIR = dir;
      setReleaseAttestationVerifierForTest((options) => verifyReleaseAttestation({
        ...options,
        runCosign: () => {
          throw new ReleaseAttestationError('ERR_RELEASE_ATTESTATION_INVALID', 'cosign verification failed');
        },
      }));

      let mergeRan = false;
      gitStub(updateScript({
        'remote get-url origin': 'https://github.com/dwgx/WindsurfAPI.git',
        ['merge --ff-only ' + TAG]: () => { mergeRan = true; return 'Fast-forward'; },
      }));

      const body = await postUpdate({});
      assert.equal(body.ok, false, JSON.stringify(body));
      assert.equal(body.error, 'ERR_RELEASE_ATTESTATION_INVALID');
      assert.equal(mergeRan, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── update.sh shell arm ────────────────────────────────────────────────
// Real Git fixture (POSIX only), fake pm2/curl/cosign on PATH, no network.

const shellIt = REAL_GIT
  ? (name, fn) => nodeIt(name, fn)
  : (name, fn) => nodeIt(name, { skip: SKIP_REASON }, fn);

function realGit(cwd, args) {
  return execFileSync(REAL_GIT, args, { cwd, env: isolatedGitEnv(), encoding: 'utf8' }).trim();
}

function writeExecutable(path, source) {
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o755);
}

const shellFixtures = [];
function makeUpdateFixture({ initialTag = 'v3.9.21', releaseTag = 'v3.9.22', annotated = true } = {}) {
  const root = mkdtempSync(join(SAFE_TMP_ROOT, 'wa-attestation-update-'));
  shellFixtures.push(root);
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const deployment = join(root, 'deployment');
  const stubBin = join(root, 'bin');

  mkdirSync(join(seed, 'src'), { recursive: true });
  mkdirSync(join(seed, 'scripts'), { recursive: true });
  mkdirSync(stubBin, { recursive: true });
  realGit(root, ['init', '--bare', origin]);
  realGit(origin, ['symbolic-ref', 'HEAD', 'refs/heads/master']);
  realGit(seed, ['init', '--initial-branch=master']);
  realGit(seed, ['config', 'user.name', 'WindsurfAPI Test']);
  realGit(seed, ['config', 'user.email', 'test@example.invalid']);
  realGit(seed, ['config', 'commit.gpgsign', 'false']);

  copyFileSync(join(SOURCE_ROOT, 'update.sh'), join(seed, 'update.sh'));
  chmodSync(join(seed, 'update.sh'), 0o755);
  copyFileSync(join(SOURCE_ROOT, 'scripts', 'verify-release-attestation.mjs'),
    join(seed, 'scripts', 'verify-release-attestation.mjs'));
  copyFileSync(join(SOURCE_ROOT, 'src', 'release-attestation.js'),
    join(seed, 'src', 'release-attestation.js'));
  writeExecutable(join(seed, 'install-ls.sh'), '#!/usr/bin/env bash\nexit "${FIXTURE_INSTALL_STATUS:-0}"\n');
  writeFileSync(join(seed, 'src', 'index.js'), '// service fixture\n', 'utf8');
  writeFileSync(join(seed, 'release-marker.txt'), 'v3.9.21\n', 'utf8');
  realGit(seed, ['add', '.']);
  realGit(seed, ['commit', '-m', 'release v3.9.21']);
  const initialCommit = realGit(seed, ['rev-parse', 'HEAD']);
  realGit(seed, ['tag', initialTag]);

  writeFileSync(join(seed, 'release-marker.txt'), 'v3.9.22\n', 'utf8');
  realGit(seed, ['add', 'release-marker.txt']);
  realGit(seed, ['commit', '-m', 'release v3.9.22']);
  const releaseCommit = realGit(seed, ['rev-parse', 'HEAD']);
  const releaseTree = realGit(seed, ['rev-parse', 'HEAD^{tree}']);
  const annotation = annotated ? ['-a', '-m', releaseTag] : [];
  realGit(seed, ['tag', ...annotation, releaseTag]);

  writeFileSync(join(seed, 'release-notes.md'), 'post-tag documentation\n', 'utf8');
  realGit(seed, ['add', 'release-notes.md']);
  realGit(seed, ['commit', '-m', 'docs: release notes']);

  realGit(seed, ['push', origin, 'master']);
  realGit(seed, ['push', origin, '--tags']);
  realGit(root, ['clone', origin, deployment]);
  realGit(deployment, ['reset', '--hard', initialCommit]);

  for (const command of ['pm2', 'pgrep', 'fuser', 'ss', 'sleep']) {
    writeExecutable(join(stubBin, command), '#!/usr/bin/env bash\nexit 0\n');
  }
  writeExecutable(join(stubBin, 'pm2'), '#!/usr/bin/env bash\npid_file=.git/windsurfapi-fixture-pm2-pid\nif [ "$1" = "start" ]; then printf \'%s\\n\' "$PPID" > "$pid_file"; fi\nif [ "$1" = "stop" ] || [ "$1" = "delete" ]; then rm -f "$pid_file"; fi\nif [ "$1" = "pid" ]; then [ -r "$pid_file" ] && cat "$pid_file"; fi\nexit 0\n');
  writeExecutable(join(stubBin, 'curl'), '#!/usr/bin/env bash\ncommit="$(git rev-parse --short=12 HEAD)" || exit 22\npid="$(cat .git/windsurfapi-fixture-pm2-pid)" || exit 22\nprintf \'{"status":"ok","commit":"%s","pid":%s}\\n\' "$commit" "$pid"\n');
  writeExecutable(join(stubBin, 'cosign'), '#!/usr/bin/env bash\nexit 0\n');

  return { root, origin, seed, deployment, stubBin, initialCommit, releaseCommit, releaseTree, releaseTag };
}

after(() => {
  for (const root of shellFixtures) rmSync(root, { recursive: true, force: true });
});

function runUpdate(fixture, extraEnv = {}, args = []) {
  return spawnSync('bash', ['update.sh', ...args], {
    cwd: fixture.deployment,
    encoding: 'utf8',
    timeout: 20_000,
    env: isolatedGitEnv({
      ...extraEnv,
      PATH: trustedFixturePath(fixture.stubBin),
      LS_BINARY_PATH: join(fixture.root, 'language-server-fixture'),
    }),
  });
}

function stageAttestation(fixture, {
  tag = fixture.releaseTag,
  commit = fixture.releaseCommit,
  tree = fixture.releaseTree,
  repository = 'dwgx/WindsurfAPI',
} = {}) {
  const dir = mkdtempSync(join(fixture.root, 'attestation-'));
  writeFileSync(join(dir, 'release-attestation.json'), JSON.stringify({
    schema: 1,
    repository: repository || undefined,
    tag,
    commit,
    tree,
    assets: { SHA256SUMS: 'd'.repeat(64) },
  }, null, 2) + '\n');
  writeFileSync(join(dir, 'release-attestation.json.sigstore.json'), '{}\n');
  return dir;
}

describe('update.sh source attestation gate', () => {
  shellIt('proceeds when the selected tag has a matching signed attestation', () => {
    const fixture = makeUpdateFixture();
    const dir = stageAttestation(fixture);
    const result = runUpdate(fixture, {
      WINDSURFAPI_UPDATE_ATTESTATION: 'required',
      WINDSURFAPI_ATTESTATION_DIR: dir,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(realGit(fixture.deployment, ['rev-parse', 'HEAD']), fixture.releaseCommit);
    assert.match(result.stdout, /=== \[2\/5\]/);
  });

  shellIt('refuses a mismatched attested commit before reset/merge', () => {
    const fixture = makeUpdateFixture();
    const dir = stageAttestation(fixture, { commit: OTHER_COMMIT });
    const result = runUpdate(fixture, {
      WINDSURFAPI_UPDATE_ATTESTATION: 'required',
      WINDSURFAPI_ATTESTATION_DIR: dir,
    });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /release attestation verification failed/i);
    assert.doesNotMatch(result.stdout, /=== \[2\/5\]/);
    assert.equal(realGit(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
  });

  shellIt('refuses a missing attestation in required mode', () => {
    const fixture = makeUpdateFixture();
    const result = runUpdate(fixture, { WINDSURFAPI_UPDATE_ATTESTATION: 'required' });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /release attestation verification failed/i);
    assert.doesNotMatch(result.stdout, /=== \[2\/5\]/);
    assert.equal(realGit(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
  });

  shellIt('warns and proceeds with a missing attestation in warn mode', () => {
    const fixture = makeUpdateFixture();
    const result = runUpdate(fixture, { WINDSURFAPI_UPDATE_ATTESTATION: 'warn' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /attestation/i);
    assert.match(result.stdout, /=== \[2\/5\]/);
    assert.equal(realGit(fixture.deployment, ['rev-parse', 'HEAD']), fixture.releaseCommit);
  });

  shellIt('refuses a bad signature before reset/merge in required mode', () => {
    const fixture = makeUpdateFixture();
    const dir = stageAttestation(fixture);
    writeExecutable(join(fixture.stubBin, 'cosign'), '#!/usr/bin/env bash\necho "certificate identity mismatch" >&2\nexit 1\n');
    const result = runUpdate(fixture, {
      WINDSURFAPI_UPDATE_ATTESTATION: 'required',
      WINDSURFAPI_ATTESTATION_DIR: dir,
    });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /release attestation verification failed/i);
    assert.doesNotMatch(result.stdout, /=== \[2\/5\]/);
    assert.equal(realGit(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
  });
});

describe('update.sh explicit signed release selection', () => {
  const legacyTag = 'v3.141.592661';
  const targetTag = 'v3.2.11';

  function migrationFixture(options = {}) {
    return makeUpdateFixture({ initialTag: legacyTag, releaseTag: targetTag, ...options });
  }

  function select(fixture, dir, extraEnv = {}, tag = targetTag) {
    return runUpdate(fixture, { WINDSURFAPI_ATTESTATION_DIR: dir, ...extraEnv }, ['--tag', tag]);
  }

  function refused(fixture, result, reason, expectedHead = fixture.initialCommit) {
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, reason);
    assert.doesNotMatch(output, /=== \[2\/5\]/);
    assert.equal(realGit(fixture.deployment, ['rev-parse', 'HEAD']), expectedHead);
  }

  shellIt('keeps the higher numeric legacy version with no operator selection', () => {
    const fixture = migrationFixture();
    const dir = mkdtempSync(join(fixture.root, 'missing-attestation-'));
    const result = runUpdate(fixture, { WINDSURFAPI_ATTESTATION_DIR: dir });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /v3\.141\.592661/);
    assert.equal(realGit(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
  });

  shellIt('fast-forwards a legacy detached checkout only to the elected signed tag', () => {
    const fixture = migrationFixture();
    const dir = stageAttestation(fixture);
    const signatureLog = join(fixture.root, 'cosign-arguments');
    writeExecutable(join(fixture.stubBin, 'cosign'),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$SIGNATURE_LOG"\n');
    realGit(fixture.deployment, ['switch', '--detach', fixture.initialCommit]);
    const result = select(fixture, dir, {
      SIGNATURE_LOG: signatureLog,
      WINDSURFAPI_UPDATE_ATTESTATION: 'warn',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(realGit(fixture.deployment, ['rev-parse', 'HEAD']), fixture.releaseCommit);
    assert.equal(realGit(fixture.deployment, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');
    const cosign = readFileSync(signatureLog, 'utf8').trim().split('\n');
    const identity = cosign[cosign.indexOf('--certificate-identity-regexp') + 1];
    assert.ok(new RegExp(identity).test(
      'https://github.com/dwgx/WindsurfAPI/.github/workflows/release.yml@refs/tags/v3.2.11'));
    assert.ok(!new RegExp(identity).test(
      'https://github.com/dwgx/WindsurfAPI/.github/workflows/release.yml@refs/tags/v3.141.592661'));
    assert.ok(!new RegExp(identity).test(
      'https://github.com/dwgx/WindsurfAPI/.github/workflows/release.yml@refs/tags/v3x2x11'));
    assert.equal(cosign[cosign.indexOf('--certificate-oidc-issuer') + 1],
      'https://token.actions.githubusercontent.com');
    assert.notEqual(cosign.at(-1), join(dir, 'release-attestation.json'),
      'Cosign must verify a private snapshot of the attestation bytes that were parsed');
  });

  for (const [label, alteration, reason] of [
    ['wrong tag', { tag: legacyTag }, /attestation tag .* does not match/i],
    ['wrong commit', { commit: OTHER_COMMIT }, /attestation commit .* does not match/i],
    ['wrong tree', { tree: OTHER_COMMIT }, /attestation tree .* does not match/i],
    ['wrong repository', { repository: 'another/publisher' }, /attestation repository .* does not match/i],
    ['missing repository', { repository: '' }, /attestation repository .* does not match/i],
  ]) {
    shellIt(`refuses a signed attestation with ${label}`, () => {
      const fixture = migrationFixture();
      refused(fixture, select(fixture, stageAttestation(fixture, alteration)), reason);
    });
  }

  shellIt('refuses a missing signature even when the operator set warn mode', () => {
    const fixture = migrationFixture();
    const dir = stageAttestation(fixture);
    rmSync(join(dir, 'release-attestation.json.sigstore.json'));
    const result = select(fixture, dir, { WINDSURFAPI_UPDATE_ATTESTATION: 'warn' });
    refused(fixture, result, /no \.sigstore\.json bundle/i);
  });

  shellIt('refuses an invalid signature before changing Git or the service', () => {
    const fixture = migrationFixture();
    writeExecutable(join(fixture.stubBin, 'cosign'), '#!/usr/bin/env bash\necho "certificate identity mismatch" >&2\nexit 1\n');
    refused(fixture, select(fixture, stageAttestation(fixture)), /certificate identity mismatch/i);
  });

  shellIt('refuses an unadvertised tag without falling back to the legacy tag', () => {
    const fixture = migrationFixture();
    realGit(fixture.deployment, ['tag', 'v3.2.12']);
    refused(fixture, select(fixture, stageAttestation(fixture), {}, 'v3.2.12'), /v3\.2\.12.*not advertised/i);
  });

  shellIt('refuses an elected lightweight ref even with a matching attestation', () => {
    const fixture = migrationFixture({ annotated: false });
    refused(fixture, select(fixture, stageAttestation(fixture)), /requires an annotated release tag/i);
  });

  shellIt('refuses an elected tag outside the fetched release branch', () => {
    const fixture = migrationFixture();
    realGit(fixture.seed, ['push', '--force', fixture.origin, `${fixture.initialCommit}:refs/heads/master`]);
    refused(fixture, select(fixture, stageAttestation(fixture)), /not reachable from origin\/master/i);
  });

  shellIt('refuses a divergent local commit and a rewind', () => {
    const fixture = migrationFixture();
    realGit(fixture.deployment, ['reset', '--hard', 'origin/master']);
    const newerHead = realGit(fixture.deployment, ['rev-parse', 'HEAD']);
    refused(fixture, select(fixture, stageAttestation(fixture)), /requires a fast-forward/i, newerHead);

    realGit(fixture.deployment, ['reset', '--hard', fixture.initialCommit]);
    realGit(fixture.deployment, ['-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid',
      'commit', '--allow-empty', '-m', 'local work']);
    const localHead = realGit(fixture.deployment, ['rev-parse', 'HEAD']);
    refused(fixture, select(fixture, stageAttestation(fixture)), /requires a fast-forward/i, localHead);
  });

  shellIt('rejects both force overrides when selecting an exact tag', () => {
    const fixture = migrationFixture();
    const dir = stageAttestation(fixture);
    for (const flag of ['WINDSURFAPI_UPDATE_FORCE', 'WINDSURFAPI_UPDATE_FORCE_RESET']) {
      refused(fixture, select(fixture, dir, { [flag]: '1' }), /cannot be combined with .*FORCE/i);
    }
  });

  shellIt('reports a failed signed update when health verification restores the prior commit', () => {
    const fixture = migrationFixture();
    const curlPath = join(fixture.stubBin, 'curl');
    const curl = readFileSync(curlPath, 'utf8').replace(
      'pid="$(cat',
      '[ "$commit" = "$FAIL_HEALTH_COMMIT" ] && exit 22\npid="$(cat',
    );
    writeExecutable(curlPath, curl);
    const result = select(fixture, stageAttestation(fixture), {
      FAIL_HEALTH_COMMIT: fixture.releaseCommit.slice(0, 12),
    });
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /Rolled back to .*service healthy/i);
    assert.equal(realGit(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
  });

  shellIt('refuses a dirty checkout before running the local verifier', () => {
    const fixture = migrationFixture();
    const dir = stageAttestation(fixture);
    const marker = join(fixture.root, 'cosign-arguments');
    writeFileSync(join(fixture.deployment, 'operator-notes.txt'), 'unsaved local notes\n');
    writeExecutable(join(fixture.stubBin, 'cosign'),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$SIGNATURE_LOG"\n');
    const result = select(fixture, dir, { SIGNATURE_LOG: marker });
    assert.equal(existsSync(marker), false, 'dirty input must be rejected before signature verification');
    refused(fixture, result, /clean checkout.*attestation/i);
  });

  shellIt('preserves files changed by the target service when health verification fails', () => {
    const fixture = migrationFixture();
    const curlPath = join(fixture.stubBin, 'curl');
    const curl = readFileSync(curlPath, 'utf8').replace(
      'pid="$(cat',
      'printf "new operator data\\n" > release-marker.txt\nexit 22\npid="$(cat',
    );
    writeExecutable(curlPath, curl);
    const result = select(fixture, stageAttestation(fixture));
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /rollback refused.*local changes/i);
    assert.equal(realGit(fixture.deployment, ['rev-parse', 'HEAD']), fixture.releaseCommit);
    assert.equal(readFileSync(join(fixture.deployment, 'release-marker.txt'), 'utf8'), 'new operator data\n');
  });

  shellIt('restores the previous checkout when the elected installer fails before service stop', () => {
    const fixture = migrationFixture();
    const result = select(fixture, stageAttestation(fixture), { FIXTURE_INSTALL_STATUS: '19' });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 19, output);
    assert.doesNotMatch(output, /\[3\/5\]/);
    assert.equal(realGit(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
  });

  shellIt('preserves ignored operator state when a signed target would overwrite it', () => {
    const fixture = migrationFixture();
    const localFile = join(fixture.deployment, 'operator-state.json');
    writeFileSync(join(fixture.deployment, '.git', 'info', 'exclude'), '/operator-state.json\n');
    writeFileSync(localFile, '{"operator":"keep"}\n');
    realGit(fixture.seed, ['reset', '--hard', fixture.releaseCommit]);
    writeFileSync(join(fixture.seed, 'operator-state.json'), '{"published":"replace"}\n');
    realGit(fixture.seed, ['add', 'operator-state.json']);
    realGit(fixture.seed, ['commit', '-m', 'signed target collides with ignored state']);
    const commit = realGit(fixture.seed, ['rev-parse', 'HEAD']);
    const tree = realGit(fixture.seed, ['rev-parse', 'HEAD^{tree}']);
    realGit(fixture.seed, ['tag', '-fa', '-m', targetTag, targetTag]);
    realGit(fixture.seed, ['push', '--force', fixture.origin, 'master', `refs/tags/${targetTag}`]);
    const dir = stageAttestation(fixture, { commit, tree });
    refused(fixture, select(fixture, dir), /would overwrite ignored runtime data/i);
    assert.equal(readFileSync(localFile, 'utf8'), '{"operator":"keep"}\n');
  });
});
