import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, mkdtempSync,
  lstatSync, realpathSync, symlinkSync, unlinkSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import { configureBindHost } from '../src/auth.js';
import { setRuntimeApiKey, setRuntimeDashboardPassword } from '../src/runtime-config.js';
import {
  handleDashboardApi,
  reconcileSelfUpdateJournal,
  setGitExecFileForTest,
  setRollbackPointWriterForTest,
  setDockerSelfUpdateForTest,
  setSelfUpdateRestartSchedulerForTest,
  setSelfUpdateRunningCommitForTest,
  setSelfUpdateSupervisorDetectorForTest,
} from '../src/dashboard/api.js';
import { isolatedGitEnv, REAL_GIT, SAFE_TMP_ROOT, SKIP_REASON } from './git-fixture-env.js';

// ---------------------------------------------------------------------------
// Version gate (tag) + rollback endpoint for OTA self-update.
//
// Gate semantics:
//   - normal OTA targets the latest release tag, never an untagged branch HEAD;
//   - commits after that tag may exist on origin/<branch> (release notes,
//     generated assets, or work for the next release) without blocking an
//     older deployment from installing the published release;
//   - forceUpdate is the explicit escape hatch that follows origin/<branch>.
//   - rollback POST resets to the persisted before-commit (requires a prior
//     /self-update that wrote data/self-update-before.json).
// ---------------------------------------------------------------------------

const SOURCE_ROOT = resolve(process.cwd());
const SELF_UPDATE_TEST_ROOT = mkdtempSync(join(SAFE_TMP_ROOT, 'wa-self-update-gate-state-'));
mkdirSync(join(SELF_UPDATE_TEST_ROOT, '.git'), { recursive: true });
process.chdir(SELF_UPDATE_TEST_ROOT);
const BEFORE_JSON = join(SELF_UPDATE_TEST_ROOT, 'data', 'self-update-before.json');
const PENDING_JSON = join(SELF_UPDATE_TEST_ROOT, 'data', 'self-update-before.pending.json');
const JOURNAL_JSON = join(SELF_UPDATE_TEST_ROOT, 'data', 'self-update-journal.json');
const UPDATE_LOCK_DIR = join(SELF_UPDATE_TEST_ROOT, '.git', 'windsurfapi-update.lock');
const prevNoAuth = process.env.DASHBOARD_ALLOW_NO_AUTH;
const origPwd = config.dashboardPassword;
const origKey = config.apiKey;

after(() => {
  process.chdir(SOURCE_ROOT);
  rmSync(SELF_UPDATE_TEST_ROOT, { recursive: true, force: true });
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
  setRollbackPointWriterForTest(null);
  setDockerSelfUpdateForTest(null);
  setSelfUpdateRestartSchedulerForTest(null);
  setSelfUpdateRunningCommitForTest(null);
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
  delete process.env.WINDSURFAPI_RESTART_SUPERVISED;
  if (prevNoAuth === undefined) delete process.env.DASHBOARD_ALLOW_NO_AUTH;
  else process.env.DASHBOARD_ALLOW_NO_AUTH = prevNoAuth;
});

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(s) { this.statusCode = s; },
    end(c) { this.body += c ? String(c) : ''; },
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
      const v = typeof map[matchedKey] === 'function' ? map[matchedKey](key) : map[matchedKey];
      if (v && typeof v === 'object' && v.error instanceof Error) {
        if (v.head) currentHead = v.head;
        cb(v.error, v.stdout || '', v.stderr || v.error.message);
        return;
      }
      if (v instanceof Error) {
        cb(v, '', v.message);
        return;
      }
      const mutation = key.match(/^(?:merge --ff-only|reset --hard) ([0-9a-f]{40}|[0-9a-f]{64})$/i);
      if (mutation && map.__skipHeadMutation !== true) currentHead = mutation[1];
      const nulMode = key.includes(' -z ') || key.endsWith(' -z');
      cb(null, String(v) + (nulMode ? '' : '\n'), '');
    } else {
      const err = new Error('unexpected git: ' + key);
      err.code = 'STUB_MISS';
      cb(err, '', '');
    }
  });
}

const HEAD = 'a'.repeat(40);
const REMOTE = 'b'.repeat(40);
const TAG = 'c'.repeat(40);
const PREEXISTING_STASH = 'd'.repeat(40);
const OWNED_STASH = 'e'.repeat(40);
const TAG_OBJECT = 'f'.repeat(40);
const OTHER_TAG_OBJECT = '1'.repeat(40);
const PSEUDO_TAG_OBJECT = '5'.repeat(40);
const PSEUDO_TAG_COMMIT = '6'.repeat(40);

function updateScript(extra) {
  const m = {
    'rev-parse HEAD': HEAD,
    'rev-parse --abbrev-ref HEAD': 'master',
    'fetch --quiet --no-tags origin master': '',
    'rev-parse origin/master': REMOTE,
    'remote get-url origin': '/tmp/windsurfapi-gate-fixture-origin.git',
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
  return Object.assign(m, extra || {});
}

function realGit(cwd, args) {
  if (!cwd) throw new Error('dashboard Git fixture cwd is required');
  return execFileSync(REAL_GIT, args, { cwd, env: isolatedGitEnv(), encoding: 'utf8' }).trim();
}

function assertSafeDashboardFixture(fixture) {
  assert.ok(fixture && typeof fixture === 'object', 'dashboard tag fixture is required');
  for (const field of ['root', 'origin', 'seed', 'deployment']) {
    assert.equal(typeof fixture[field], 'string', `fixture.${field} is required`);
    assert.ok(fixture[field], `fixture.${field} must not be empty`);
    assert.ok(existsSync(fixture[field]), `fixture.${field} must exist`);
  }

  const rootPath = resolve(fixture.root);
  const rootStat = lstatSync(rootPath);
  assert.ok(!rootStat.isSymbolicLink(), 'fixture.root must not be a symlink');
  assert.ok(rootStat.isDirectory(), 'fixture.root must be a directory');
  const root = realpathSync(rootPath);
  for (const field of ['origin', 'seed', 'deployment']) {
    const childPath = resolve(fixture[field]);
    const childStat = lstatSync(childPath);
    assert.ok(!childStat.isSymbolicLink(), `fixture.${field} must not be a symlink`);
    assert.ok(childStat.isDirectory(), `fixture.${field} must be a directory`);
    const child = realpathSync(childPath);
    const rel = relative(root, child);
    assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
      `fixture.${field} must be contained by fixture.root (real path)`);
  }

  const deploymentOrigin = realGit(fixture.deployment, ['remote', 'get-url', 'origin']);
  assert.equal(
    realpathSync(resolve(fixture.deployment, deploymentOrigin)),
    realpathSync(resolve(fixture.origin)),
    'fixture deployment origin must be the explicit temporary bare repository');
}

function makeDashboardTagFixture() {
  const root = mkdtempSync(join(SAFE_TMP_ROOT, 'wa-dashboard-release-tags-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const deployment = join(root, 'deployment');
  mkdirSync(seed, { recursive: true });
  realGit(root, ['init', '--bare', origin]);
  realGit(origin, ['symbolic-ref', 'HEAD', 'refs/heads/master']);
  realGit(seed, ['init', '--initial-branch=master']);
  realGit(seed, ['config', 'user.name', 'WindsurfAPI Test']);
  realGit(seed, ['config', 'user.email', 'test@example.invalid']);
  realGit(seed, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(seed, 'release.txt'), 'v3.9.21\n', 'utf8');
  realGit(seed, ['add', 'release.txt']);
  realGit(seed, ['commit', '-m', 'release v3.9.21']);
  const initialCommit = realGit(seed, ['rev-parse', 'HEAD']);
  realGit(seed, ['tag', 'v3.9.21']);
  writeFileSync(join(seed, 'release.txt'), 'v3.9.22\n', 'utf8');
  realGit(seed, ['commit', '-am', 'release v3.9.22']);
  const releaseCommit = realGit(seed, ['rev-parse', 'HEAD']);
  realGit(seed, ['tag', '-a', '-m', 'v3.9.22', 'v3.9.22']);
  writeFileSync(join(seed, 'notes.txt'), 'post-tag\n', 'utf8');
  realGit(seed, ['add', 'notes.txt']);
  realGit(seed, ['commit', '-m', 'post-tag notes']);
  realGit(seed, ['push', origin, 'master']);
  realGit(seed, ['push', origin, '--tags']);
  realGit(root, ['clone', origin, deployment]);
  realGit(deployment, ['reset', '--hard', initialCommit]);
  return { root, origin, seed, deployment, initialCommit, releaseCommit };
}


function runDashboardUpdateCheck(fixture) {
  assertSafeDashboardFixture(fixture);
  const { deployment } = fixture;
  const moduleUrl = (relative) => pathToFileURL(join(SOURCE_ROOT, relative)).href;
  const source = `
    import { handleDashboardApi, setDockerSelfUpdateForTest } from ${JSON.stringify(moduleUrl('src/dashboard/api.js'))};
    import { configureBindHost } from ${JSON.stringify(moduleUrl('src/auth.js'))};
    import { config } from ${JSON.stringify(moduleUrl('src/config.js'))};
    import { setRuntimeApiKey, setRuntimeDashboardPassword } from ${JSON.stringify(moduleUrl('src/runtime-config.js'))};
    process.env.DASHBOARD_ALLOW_NO_AUTH = '1';
    config.dashboardPassword = '';
    config.apiKey = '';
    setRuntimeApiKey('');
    setRuntimeDashboardPassword('');
    configureBindHost('127.0.0.1');
    setDockerSelfUpdateForTest({ detect: async () => ({ available: false, reason: 'test-disabled' }) });
    const res = { statusCode: 0, body: '', writeHead(s) { this.statusCode = s; }, end(c) { this.body += c ? String(c) : ''; } };
    await handleDashboardApi('GET', '/self-update/check', null, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    process.stdout.write('__RESULT__' + res.body + '\\n');
  `;
  const result = spawnSync(process.execPath, [
    '--import', join(SOURCE_ROOT, 'test', 'setup-env.mjs'),
    '--input-type=module', '--eval', source,
  ], {
    cwd: deployment,
    encoding: 'utf8',
    timeout: 20_000,
    env: isolatedGitEnv({ DASHBOARD_ALLOW_NO_AUTH: '1' }),
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith('__RESULT__'));
  assert.ok(line, `missing dashboard result: ${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice('__RESULT__'.length));
}

function postUpdate(req) {
  const res = fakeRes();
  return handleDashboardApi('POST', '/self-update', req, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res)
    .then(() => res.json());
}

function postRollback(req = {}) {
  const res = fakeRes();
  return handleDashboardApi('POST', '/self-update/rollback', req, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res)
    .then(() => res.json());
}

describe('self-update version gate (tag)', () => {
  it('installs the latest tag even when remote has post-tag unreleased commits', async () => {
    openAuth();
    let releaseMergeRan = false;
    gitStub(updateScript({
      ['rev-list --count ' + TAG + '..' + REMOTE]: '3',
      ['merge --ff-only ' + TAG]: () => { releaseMergeRan = true; return 'Fast-forward'; },
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(releaseMergeRan, true, 'OTA must fast-forward to the released tag');
    assert.equal(gitCalls.includes('pull origin master --ff-only'), false,
      'normal OTA must not pull the untagged branch HEAD');
    const rollbackPoint = JSON.parse(readFileSync(BEFORE_JSON, 'utf8'));
    assert.equal(rollbackPoint.commit, HEAD);
    assert.equal(rollbackPoint.after, TAG, 'rollback metadata must record the peeled target commit');
  });

  it('allows pull when remote IS the latest tag (published)', async () => {
    openAuth();
    gitStub(updateScript({
      'rev-parse origin/master': TAG,
      ['rev-list --count ' + TAG + '..' + TAG]: '0',
      ['merge --ff-only ' + TAG]: 'Fast-forward',
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  it('does not downgrade a checkout that already contains the latest release', async () => {
    openAuth();
    let mergeRan = false;
    gitStub(updateScript({
      ['rev-list --count ' + HEAD + '..' + TAG]: '0',
      ['rev-list --count ' + TAG + '..' + HEAD]: '2',
      ['merge --ff-only ' + TAG]: () => { mergeRan = true; return ''; },
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.changed, false);
    assert.equal(mergeRan, false, 'an ahead checkout must not be reset/merged back to the tag');
  });

  it('forceUpdate explicitly follows the untagged remote head', async () => {
    openAuth();
    let remoteMergeRan = false;
    gitStub(updateScript({
      ['rev-list --count ' + TAG + '..' + REMOTE]: '2',
      ['rev-list --count ' + HEAD + '..' + REMOTE]: '3',
      ['rev-list --count ' + REMOTE + '..' + HEAD]: '0',
      ['merge --ff-only ' + REMOTE]: () => { remoteMergeRan = true; return 'Fast-forward'; },
    }));
    const r = await postUpdate({ forceUpdate: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(remoteMergeRan, true);
  });

  it('fails closed when the repository has no stable release tag', async () => {
    openAuth();
    let remoteMergeRan = false;
    gitStub(updateScript({
      'ls-remote --tags origin refs/tags/v[0-9]*': '',
      ['rev-list --count ' + HEAD + '..']: '0',
      ['rev-list --count ..' + HEAD]: '0',
      ['merge --ff-only ' + REMOTE]: () => { remoteMergeRan = true; return 'Fast-forward'; },
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'ERR_NO_RELEASE_TAG');
    assert.equal(remoteMergeRan, false, 'ordinary OTA must never fall back to branch HEAD');
  });

  it('allows an explicit forceUpdate to follow branch HEAD when no release tag exists', async () => {
    openAuth();
    let remoteMergeRan = false;
    gitStub(updateScript({
      'ls-remote --tags origin refs/tags/v[0-9]*': '',
      ['rev-list --count ' + HEAD + '..' + REMOTE]: '1',
      ['rev-list --count ' + REMOTE + '..' + HEAD]: '0',
      ['merge --ff-only ' + REMOTE]: () => { remoteMergeRan = true; return 'Fast-forward'; },
    }));
    const r = await postUpdate({ forceUpdate: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(remoteMergeRan, true);
  });

  it('fails closed when release-tag discovery itself fails', async () => {
    openAuth();
    let mergeRan = false;
    gitStub(updateScript({
      'ls-remote --tags origin refs/tags/v[0-9]*': new Error('tag ref corruption'),
      ['merge --ff-only ' + REMOTE]: () => { mergeRan = true; return ''; },
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'ERR_RELEASE_TAG_LOOKUP');
    assert.equal(mergeRan, false);
  });

  it('ignores prerelease and arbitrary tags, then peels the stable annotated tag', async () => {
    openAuth();
    const script = updateScript({
      'ls-remote --tags origin refs/tags/v[0-9]*': [
        `${PSEUDO_TAG_OBJECT}\trefs/tags/v04.00.1`,
        `${PSEUDO_TAG_COMMIT}\trefs/tags/v04.00.1^{}`,
        `${'2'.repeat(40)}\trefs/tags/v3.09.24`,
        `${'3'.repeat(40)}\trefs/tags/v3.9.21-rc6`,
        `${'4'.repeat(40)}\trefs/tags/v999-backup`,
        `${TAG_OBJECT}\trefs/tags/v3.9.21`,
        `${TAG}\trefs/tags/v3.9.21^{}`,
      ].join('\n'),
      ['cat-file -t ' + PSEUDO_TAG_OBJECT]: 'tag',
      ['merge-base --is-ancestor ' + PSEUDO_TAG_COMMIT + ' origin/master']: '',
      ['rev-list --count ' + PSEUDO_TAG_COMMIT + '..' + REMOTE]: '0',
      ['rev-list --count ' + HEAD + '..' + PSEUDO_TAG_COMMIT]: '1',
      ['rev-list --count ' + PSEUDO_TAG_COMMIT + '..' + HEAD]: '0',
      ['log -1 --pretty=format:%s ' + PSEUDO_TAG_COMMIT]: 'pseudo release fixture',
      ['merge --ff-only ' + PSEUDO_TAG_COMMIT]: 'Fast-forward',
      ['merge --ff-only ' + TAG]: 'Fast-forward',
    });
    script['fetch --quiet --no-tags origin refs/tags/v04.00.1'] = () => {
      script['rev-parse FETCH_HEAD'] = PSEUDO_TAG_OBJECT;
      script['rev-parse FETCH_HEAD^{commit}'] = PSEUDO_TAG_COMMIT;
      return '';
    };
    gitStub(script);
    const r = await postUpdate({});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.after, TAG.slice(0, 7), 'leading-zero pseudo versions must never become the update target');
    assert.equal(gitCalls.includes('fetch --quiet --no-tags origin refs/tags/v3.9.21'), true);
    assert.equal(gitCalls.includes('rev-parse FETCH_HEAD^{commit}'), true,
      'annotated release tags must be peeled from the exact fetched remote object');
    assert.equal(gitCalls.some(call => call.startsWith('tag --list ')), false,
      'local tags are not publication authority');
  });

  it('accepts a lightweight remote tag only when its advertised object is the commit', async () => {
    openAuth();
    gitStub(updateScript({
      'ls-remote --tags origin refs/tags/v[0-9]*': `${TAG}\trefs/tags/v3.9.21`,
      'rev-parse FETCH_HEAD': TAG,
      'rev-parse FETCH_HEAD^{commit}': TAG,
      ['cat-file -t ' + TAG]: 'commit',
      ['merge --ff-only ' + TAG]: 'Fast-forward',
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  it('fails closed on partial remote-tag output followed by a nonzero exit', async () => {
    openAuth();
    const failure = new Error('transport closed after one ref');
    failure.code = 42;
    gitStub(updateScript({
      'ls-remote --tags origin refs/tags/v[0-9]*': {
        error: failure,
        stdout: `${TAG_OBJECT}\trefs/tags/v3.9.21\n`,
      },
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'ERR_RELEASE_TAG_LOOKUP');
    assert.equal(gitCalls.some(call => call.startsWith('merge --ff-only ')), false);
  });

  it('fails closed when remote-tag output violates the ls-remote record protocol', async () => {
    openAuth();
    gitStub(updateScript({
      'ls-remote --tags origin refs/tags/v[0-9]*': `not-an-oid refs/tags/v3.9.21`,
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'ERR_RELEASE_TAG_LOOKUP');
  });

  it('fails closed when a remote-tag record contains more than one literal tab', async () => {
    openAuth();
    gitStub(updateScript({
      'ls-remote --tags origin refs/tags/v[0-9]*': [
        `${TAG_OBJECT}\t\trefs/tags/v3.9.21`,
        `${TAG}\trefs/tags/v3.9.21^{}`,
      ].join('\n'),
      ['merge --ff-only ' + TAG]: 'Fast-forward',
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'ERR_RELEASE_TAG_LOOKUP');
    assert.equal(gitCalls.some(call => call.startsWith('merge --ff-only ')), false);
  });

  it('fails closed when FETCH_HEAD does not match the advertised remote tag object', async () => {
    openAuth();
    gitStub(updateScript({
      'rev-parse FETCH_HEAD': OTHER_TAG_OBJECT,
      'rev-parse FETCH_HEAD^{commit}': TAG,
      ['cat-file -t ' + OTHER_TAG_OBJECT]: 'tag',
      ['merge --ff-only ' + TAG]: 'Fast-forward',
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'ERR_RELEASE_TAG_LOOKUP');
    assert.equal(gitCalls.some(call => call.startsWith('merge --ff-only ')), false);
  });

  it('fails closed when an annotated tag peels to a commit other than the advertised peeled OID', async () => {
    openAuth();
    gitStub(updateScript({
      'rev-parse FETCH_HEAD^{commit}': HEAD,
      ['merge-base --is-ancestor ' + HEAD + ' origin/master']: '',
      ['rev-list --count ' + HEAD + '..' + REMOTE]: '0',
      ['rev-list --count ' + HEAD + '..' + HEAD]: '0',
      ['log -1 --pretty=format:%s ' + HEAD]: 'mismatch fixture',
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'ERR_RELEASE_TAG_LOOKUP');
    assert.equal(gitCalls.some(call => call.startsWith('merge --ff-only ')), false);
  });

  it('never selects a stable remote tag that is not reachable from the update branch', async () => {
    openAuth();
    const notAncestor = new Error('not an ancestor');
    notAncestor.code = 1;
    gitStub(updateScript({
      ['merge-base --is-ancestor ' + TAG + ' origin/master']: notAncestor,
      ['merge --ff-only ' + TAG]: 'Fast-forward',
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'ERR_NO_RELEASE_TAG');
    assert.equal(gitCalls.some(call => call.startsWith('merge --ff-only ')), false);
  });

  it('uses remote refs as authority after a tag is revoked without deleting the local tag', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const fixture = makeDashboardTagFixture();
    try {
      const beforeRevocation = runDashboardUpdateCheck(fixture);
      assert.equal(beforeRevocation.ok, true, JSON.stringify(beforeRevocation));
      assert.equal(beforeRevocation.latestTag, 'v3.9.22');
      assert.equal(beforeRevocation.remoteCommit, fixture.releaseCommit.slice(0, 7));

      const localTagObject = realGit(fixture.deployment, ['rev-parse', 'refs/tags/v3.9.22']);
      realGit(fixture.seed, ['push', fixture.origin, ':refs/tags/v3.9.22']);
      const afterRevocation = runDashboardUpdateCheck(fixture);

      assert.equal(afterRevocation.ok, true, JSON.stringify(afterRevocation));
      assert.equal(afterRevocation.latestTag, 'v3.9.21');
      assert.equal(afterRevocation.remoteCommit, fixture.initialCommit.slice(0, 7));
      assert.equal(realGit(fixture.deployment, ['rev-parse', 'refs/tags/v3.9.22']), localTagObject,
        'remote authority must not prune or overwrite the operator\'s local tag namespace');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects incomplete or out-of-root real Git fixtures before spawning the dashboard check', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const fixture = makeDashboardTagFixture();
    try {
      assert.throws(() => runDashboardUpdateCheck({ ...fixture, deployment: undefined }),
        /fixture\.deployment is required/);
      assert.throws(() => runDashboardUpdateCheck({ ...fixture, origin: SOURCE_ROOT }),
        /fixture\.origin must be contained/);
      assert.throws(() => runDashboardUpdateCheck({ ...fixture, origin: fixture.seed }),
        /explicit temporary bare repository/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects dashboard fixture children that are symlinks escaping the temporary root', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const fixture = makeDashboardTagFixture();
    try {
      for (const field of ['origin', 'seed', 'deployment']) {
        const externalRoot = mkdtempSync(join(SAFE_TMP_ROOT, `wa-dashboard-escape-${field}-`));
        const externalPath = join(externalRoot, field);
        mkdirSync(externalPath);
        const link = join(fixture.root, `escape-${field}`);
        symlinkSync(externalPath, link, 'dir');
        try {
          assert.throws(
            () => runDashboardUpdateCheck({ ...fixture, [field]: link }),
            /symlink|contained|resolve/i,
            `fixture.${field} symlink escape must be rejected`,
          );
        } finally {
          // unlinkSync, not rmSync: `link` is a symlink to a directory, and
          // rmSync on it throws ERR_FS_EISDIR on Node 24.11.1.
          try { unlinkSync(link); } catch { rmSync(link, { force: true }); }
          rmSync(externalRoot, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('uses master as the update branch for a detached tag checkout', async () => {
    openAuth();
    gitStub(updateScript({
      'rev-parse --abbrev-ref HEAD': 'HEAD',
      ['merge --ff-only ' + TAG]: 'Fast-forward',
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(gitCalls.some(call => call.includes('origin/HEAD')), false);
    assert.equal(gitCalls.includes('fetch --quiet --no-tags origin master'), true);
  });

  it('refuses a non-fast-forward update when current and release target diverged', async () => {
    openAuth();
    let mergeRan = false;
    gitStub(updateScript({
      ['rev-list --count ' + HEAD + '..' + TAG]: '1',
      ['rev-list --count ' + TAG + '..' + HEAD]: '1',
      ['merge --ff-only ' + TAG]: () => { mergeRan = true; return ''; },
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'ERR_DIVERGED');
    assert.equal(mergeRan, false);
  });

  it('forceReset cleans a dirty checkout past the release without downgrading it', async () => {
    openAuth();
    let resetTarget = '';
    gitStub(updateScript({
      'status --porcelain -uno': ' M src/index.js',
      ['rev-list --count ' + HEAD + '..' + TAG]: '0',
      ['rev-list --count ' + TAG + '..' + HEAD]: '2',
      'fetch origin master': '',
      'rev-list --count origin/master..HEAD': '0',
      'stash push --include-untracked -m windsurfapi-self-update-forceReset-*': '',
      ['reset --hard ' + HEAD]: () => { resetTarget = HEAD; return ''; },
    }));
    const r = await postUpdate({ forceReset: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(resetTarget, HEAD);
    assert.equal(gitCalls.includes('reset --hard ' + TAG), false);
  });

  it('fails closed when forceReset receives an empty or malformed ahead count', async () => {
    openAuth();
    gitStub(updateScript({
      'status --porcelain -uno': ' M src/index.js',
      'rev-list --count origin/master..HEAD': '',
      'stash push --include-untracked -m windsurfapi-self-update-forceReset-*': () => {
        throw new Error('stash must not run after an unknown count');
      },
      ['reset --hard ' + HEAD]: () => {
        throw new Error('reset must not run after an unknown count');
      },
    }));
    const r = await postUpdate({ forceReset: true });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'ERR_LOCAL_COMMIT_CHECK_FAILED');
    assert.match(r.message, /invalid count|verify whether local commits/i);
  });

  it('fails closed when forceReset receives an unsafe numeric ahead count', async () => {
    openAuth();
    gitStub(updateScript({
      'status --porcelain -uno': ' M src/index.js',
      'rev-list --count origin/master..HEAD': '9007199254740992',
      'stash push --include-untracked -m windsurfapi-self-update-forceReset-*': () => {
        throw new Error('stash must not run after an unsafe count');
      },
      ['reset --hard ' + HEAD]: () => {
        throw new Error('reset must not run after an unsafe count');
      },
    }));
    const r = await postUpdate({ forceReset: true });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'ERR_LOCAL_COMMIT_CHECK_FAILED');
    assert.match(r.message, /unsafe count/i);
    assert.doesNotMatch(r.message, /integer expected/i);
  });

  it('rejects an update that would overwrite ignored runtime data', async () => {
    openAuth();
    let mergeRan = false;
    gitStub(updateScript({
      ['ls-tree -r -z --name-only ' + TAG]: 'victim.txt\0',
      'ls-files --others --ignored --exclude-standard --directory -z': 'victim.txt\0',
      'ls-files --others --ignored --exclude-standard -z -- :(top,literal)victim.txt': 'victim.txt\0',
      ['merge --ff-only ' + TAG]: () => { mergeRan = true; return 'Fast-forward'; },
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'ERR_IGNORED_PATH_CONFLICT');
    assert.deepEqual(r.conflictPaths, ['victim.txt']);
    assert.equal(mergeRan, false, 'ignored-path refusal must happen before merge');
    assert.equal(gitCalls.some(call => call.startsWith('reset --hard ')), false);
  });

  it('checks supervisor availability before preparing or changing an update checkout', async () => {
    openAuth();
    setSelfUpdateSupervisorDetectorForTest(() => ({ supervised: false, kind: null }));
    let rollbackPointRan = false;
    let mergeRan = false;
    setRollbackPointWriterForTest(() => { rollbackPointRan = true; });
    gitStub(updateScript({
      ['merge --ff-only ' + TAG]: () => { mergeRan = true; return 'Fast-forward'; },
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'ERR_NO_SUPERVISOR');
    assert.equal(rollbackPointRan, false, 'supervisor refusal must precede rollback journal preparation');
    assert.equal(mergeRan, false, 'supervisor refusal must happen before merge');
    assert.equal(gitCalls.some(call => call.startsWith('ls-tree -r -z --name-only ')), false,
      'supervisor refusal must precede ignored-path inventory and all mutation preparation');
  });

  it('fails closed when the protective stash fails and never reaches reset', async () => {
    openAuth();
    let resetRan = false;
    gitStub(updateScript({
      'status --porcelain -uno': ' M src/index.js',
      'rev-list --count origin/master..HEAD': '0',
      'stash push --include-untracked -m windsurfapi-self-update-forceReset-*': new Error('index.lock denied'),
      ['reset --hard ' + TAG]: () => { resetRan = true; return ''; },
    }));
    const r = await postUpdate({ forceReset: true });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'ERR_STASH_FAILED');
    assert.equal(resetRan, false, 'stash failure must stop before reset --hard');
  });

  it('persists rollback metadata before the first HEAD-changing command', async () => {
    openAuth();
    const order = [];
    let recorded = null;
    setRollbackPointWriterForTest((target, value) => {
      order.push('rollback-point');
      recorded = { target, value };
      writeFileSync(target, JSON.stringify(value));
    });
    gitStub(updateScript({
      ['merge --ff-only ' + TAG]: () => { order.push('merge'); return 'Fast-forward'; },
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(order, ['rollback-point', 'merge']);
    assert.equal(recorded.value.commit, HEAD);
    assert.equal(recorded.value.after, TAG, 'rollback after SHA must be the peeled release commit');
  });

  it('aborts before merge when durable rollback metadata cannot be written, then releases the mutex', async () => {
    openAuth();
    let mergeRan = false;
    const previousPoint = { commit: 'd'.repeat(40), after: HEAD, ts: 1 };
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(BEFORE_JSON, JSON.stringify(previousPoint));
    setRollbackPointWriterForTest(() => { throw new Error('disk full'); });
    gitStub(updateScript({
      ['merge --ff-only ' + TAG]: () => { mergeRan = true; return 'Fast-forward'; },
    }));
    const first = await postUpdate({});
    assert.equal(first.ok, false, JSON.stringify(first));
    assert.equal(first.error, 'ERR_ROLLBACK_POINT_WRITE');
    assert.equal(mergeRan, false);
    assert.deepEqual(JSON.parse(readFileSync(BEFORE_JSON, 'utf8')), previousPoint,
      'a failed new update must preserve the previous valid rollback point');

    setRollbackPointWriterForTest(null);
    const second = await postUpdate({});
    assert.notEqual(second.error, 'ERR_UPDATE_IN_PROGRESS', JSON.stringify(second));
    assert.equal(mergeRan, true, 'a failed request must release the shared mutation lock');
  });

  it('rejects a successful Git command whose HEAD does not match the selected target', async () => {
    openAuth();
    const previousPoint = { commit: 'd'.repeat(40), after: HEAD, ts: 1 };
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(BEFORE_JSON, JSON.stringify(previousPoint));
    gitStub(updateScript({
      __skipHeadMutation: true,
      ['merge --ff-only ' + TAG]: 'Fast-forward',
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'ERR_UPDATE_TARGET_MISMATCH');
    assert.equal(r.expected, TAG);
    assert.equal(r.actual, HEAD);
    assert.equal(existsSync(PENDING_JSON), false, 'abandoned pending point must be removed');
    assert.deepEqual(JSON.parse(readFileSync(BEFORE_JSON, 'utf8')), previousPoint,
      'target mismatch must not overwrite the last successful rollback point');
  });

  it('restores the just-created stash when reset fails before changing HEAD', async () => {
    openAuth();
    let stashMarker = '';
    let exactStashApplyRan = false;
    let stashPopRan = false;
    gitStub(updateScript({
      'status --porcelain -uno': ' M src/index.js',
      'rev-list --count origin/master..HEAD': '0',
      'for-each-ref --format=%(objectname) refs/stash': PREEXISTING_STASH,
      'stash push --include-untracked -m windsurfapi-self-update-forceReset-*': (key) => {
        stashMarker = key.slice(key.indexOf('-m ') + 3);
        return 'Saved working directory';
      },
      'stash list --format=%H%x09%gs': () => `${OWNED_STASH}\tOn master: ${stashMarker}`,
      ['reset --hard ' + TAG]: new Error('cannot lock ref'),
      ['stash apply ' + OWNED_STASH]: () => { exactStashApplyRan = true; return 'restored'; },
      'stash pop': () => { stashPopRan = true; return 'wrong stack top'; },
    }));
    const r = await postUpdate({ forceReset: true });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'ERR_GIT_UPDATE_FAILED');
    assert.equal(r.stashed, true, 'the exact owned stash remains as a recoverable backup');
    assert.equal(r.stashRestored, true);
    assert.equal(exactStashApplyRan, true);
    assert.equal(stashPopRan, false, 'the updater must never pop an assumed stack top');
    assert.equal(gitCalls.includes('stash pop'), false, 'the updater must never pop an assumed stack top');
    assert.equal(existsSync(PENDING_JSON), false);
  });

  it('never applies a pre-existing stash when the dirty-to-stash race creates no new object', async () => {
    openAuth();
    let oldStashApplyRan = false;
    gitStub(updateScript({
      'status --porcelain -uno': ' M src/index.js',
      'rev-list --count origin/master..HEAD': '0',
      'for-each-ref --format=%(objectname) refs/stash': PREEXISTING_STASH,
      'stash push --include-untracked -m windsurfapi-self-update-forceReset-*': 'No local changes to save',
      'stash list --format=%H%x09%gs': `${PREEXISTING_STASH}\tOn master: user backup`,
      ['reset --hard ' + TAG]: new Error('cannot lock ref'),
      ['stash apply ' + PREEXISTING_STASH]: () => { oldStashApplyRan = true; return 'wrong stash'; },
    }));
    const r = await postUpdate({ forceReset: true });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'ERR_GIT_UPDATE_FAILED');
    assert.equal(r.stashed, false, 'no newly owned stash means no hidden updater stash');
    assert.equal(oldStashApplyRan, false, 'the updater must never apply a user-owned pre-existing stash');
    assert.equal(gitCalls.some(call => call.startsWith('stash apply ')), false);
    assert.equal(gitCalls.includes('stash pop'), false);
  });

  it('accepts a nonzero Git exit only after HEAD and tracked state prove the update completed', async () => {
    openAuth();
    let restartCalls = 0;
    setSelfUpdateRestartSchedulerForTest((_callback, release) => {
      restartCalls++;
      release();
      return false;
    });
    gitStub(updateScript({
      ['merge --ff-only ' + TAG]: { error: new Error('transport closed after ref update'), head: TAG },
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.after, TAG.slice(0, 7));
    assert.equal(r.restarting, true);
    assert.equal(restartCalls, 1);
  });

  it('reports ERR_UPDATE_PARTIAL and does not restart when target HEAD is tracked-dirty', async () => {
    openAuth();
    let restartCalls = 0;
    setSelfUpdateRestartSchedulerForTest(() => { restartCalls++; return false; });
    gitStub(updateScript({
      ['merge --ff-only ' + TAG]: 'Fast-forward',
      'status --porcelain --untracked-files=no --ignore-submodules=none': ' M src/index.js',
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'ERR_UPDATE_PARTIAL');
    assert.equal(r.actual, TAG);
    assert.equal(restartCalls, 0);
    assert.equal(existsSync(BEFORE_JSON), true, 'changed HEAD must retain an honest rollback point');
  });

  it('reports ERR_UPDATE_STATE_UNKNOWN and preserves pending metadata when post-state probing fails', async () => {
    openAuth();
    let restartCalls = 0;
    setSelfUpdateRestartSchedulerForTest(() => { restartCalls++; return false; });
    gitStub(updateScript({
      ['merge --ff-only ' + TAG]: 'Fast-forward',
      'status --porcelain --untracked-files=no --ignore-submodules=none': new Error('index unreadable'),
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'ERR_UPDATE_STATE_UNKNOWN');
    assert.equal(restartCalls, 0);
    assert.equal(existsSync(PENDING_JSON), true);
  });

  it('serializes update and rollback requests through one shared mutex', async () => {
    openAuth();
    const script = updateScript({ ['merge --ff-only ' + TAG]: 'Fast-forward' });
    let heldHeadCallback = null;
    let currentHead = HEAD;
    setGitExecFileForTest((bin, args, opts, cb) => {
      const key = args.join(' ');
      gitCalls.push(key);
      if (key === 'rev-parse HEAD' && !heldHeadCallback) {
        heldHeadCallback = cb;
        return;
      }
      if (key === 'rev-parse HEAD') {
        cb(null, currentHead + '\n', '');
        return;
      }
      if (key.startsWith('ls-tree -r -z --name-only ')
          || key === 'ls-files --others --ignored --exclude-standard --directory -z'
          || key.startsWith('ls-files --others --ignored --exclude-standard -z -- ')
          || key === 'status --porcelain --untracked-files=no --ignore-submodules=none') {
        cb(null, '', '');
        return;
      }
      const v = script[key];
      if (v === undefined) return cb(new Error('unexpected git: ' + key), '', '');
      if (key === 'merge --ff-only ' + TAG) currentHead = TAG;
      cb(null, String(v) + '\n', '');
    });

    const firstPromise = postUpdate({});
    while (!heldHeadCallback) await new Promise(resolve => setImmediate(resolve));
    assert.equal(existsSync(UPDATE_LOCK_DIR), true,
      'dashboard mutation must hold the same repository lock used by update.sh');

    const rollbackRes = fakeRes();
    await handleDashboardApi('POST', '/self-update/rollback', {}, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, rollbackRes);
    const second = rollbackRes.json();
    assert.equal(second.ok, false, JSON.stringify(second));
    assert.equal(second.error, 'ERR_UPDATE_IN_PROGRESS');

    heldHeadCallback(null, HEAD + '\n', '');
    const first = await firstPromise;
    assert.equal(first.ok, true, JSON.stringify(first));
  });

  it('holds the repository lock from an update response through restart handoff release', async () => {
    openAuth();
    let releaseHandoff = null;
    setSelfUpdateRestartSchedulerForTest((_callback, release) => {
      releaseHandoff = release;
      return true;
    });
    gitStub(updateScript({ ['merge --ff-only ' + TAG]: 'Fast-forward' }));
    const first = await postUpdate({});
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(existsSync(UPDATE_LOCK_DIR), true, 'lock must outlive the successful HTTP response');

    const blocked = await postRollback({});
    assert.equal(blocked.error, 'ERR_UPDATE_IN_PROGRESS');
    assert.equal(typeof releaseHandoff, 'function');
    releaseHandoff();
    assert.equal(existsSync(UPDATE_LOCK_DIR), false);

    rmSync(BEFORE_JSON, { force: true });
    const afterRelease = await postRollback({});
    assert.equal(afterRelease.error, 'ERR_NO_ROLLBACK_POINT');
  });

  it('does not let an old release callback delete a replacement owner token', async () => {
    openAuth();
    let releaseHandoff = null;
    setSelfUpdateRestartSchedulerForTest((_callback, release) => {
      releaseHandoff = release;
      return true;
    });
    gitStub(updateScript({ ['merge --ff-only ' + TAG]: 'Fast-forward' }));
    const first = await postUpdate({});
    assert.equal(first.ok, true, JSON.stringify(first));
    writeFileSync(join(UPDATE_LOCK_DIR, 'owner'), `${process.pid} replacement-token\n`);
    releaseHandoff();
    assert.equal(existsSync(UPDATE_LOCK_DIR), true,
      'release authority tied to the retired token must leave the replacement lock intact');
    assert.match(readFileSync(join(UPDATE_LOCK_DIR, 'owner'), 'utf8'), /replacement-token/);
  });

  it('refuses a dashboard update while update.sh owns the shared repository lock', async () => {
    openAuth();
    mkdirSync(UPDATE_LOCK_DIR);
    writeFileSync(join(UPDATE_LOCK_DIR, 'pid'), `${process.pid}\n`);
    try {
      const r = await postUpdate({});
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.error, 'ERR_UPDATE_IN_PROGRESS');
      assert.equal(gitCalls.length, 0, 'external lock must stop before the first Git read');
    } finally {
      rmSync(UPDATE_LOCK_DIR, { recursive: true, force: true });
    }
  });

  it('keeps Docker OTA single-flight while the delayed deployer is still outstanding', async () => {
    openAuth();
    const gitMissing = new Error('git unavailable');
    gitMissing.code = 'ENOENT';
    setGitExecFileForTest((_bin, _args, _opts, cb) => cb(gitMissing, '', gitMissing.message));
    let releaseDockerHandoff = null;
    setDockerSelfUpdateForTest({
      detect: async () => ({ available: true, image: 'ghcr.io/example/windsurf:latest' }),
      run: async () => ({ ok: true, image: 'ghcr.io/example/windsurf:latest', delaySeconds: 8 }),
      scheduleRelease: (release) => {
        releaseDockerHandoff = release;
        return true;
      },
    });

    const first = await postUpdate({});
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.mode, 'docker');
    assert.equal(existsSync(UPDATE_LOCK_DIR), true);

    const blocked = await postUpdate({});
    assert.equal(blocked.error, 'ERR_UPDATE_IN_PROGRESS');
    assert.equal(typeof releaseDockerHandoff, 'function');
    releaseDockerHandoff();

    setDockerSelfUpdateForTest({
      detect: async () => ({ available: true }),
      run: async () => ({ ok: false, reason: 'deployer-create-failed' }),
    });
    const afterRelease = await postUpdate({});
    assert.notEqual(afterRelease.error, 'ERR_UPDATE_IN_PROGRESS');
    assert.equal(afterRelease.mode, 'docker');
  });

  it('keeps Docker OTA single-flight when the working directory has no Git metadata', async () => {
    openAuth();
    const originalCwd = process.cwd();
    const dockerCwd = mkdtempSync(join(SAFE_TMP_ROOT, 'wa-dashboard-docker-no-git-'));
    const releases = [];
    let runCalls = 0;
    process.chdir(dockerCwd);
    try {
      setDockerSelfUpdateForTest({
        detect: async () => ({ available: true, image: 'ghcr.io/example/windsurf:latest' }),
        run: async () => {
          runCalls++;
          return { ok: true, image: 'ghcr.io/example/windsurf:latest', delaySeconds: 8 };
        },
        scheduleRelease: (release) => {
          releases.push(release);
          return true;
        },
      });

      const first = await postUpdate({});
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(first.mode, 'docker');
      assert.equal(runCalls, 1);

      const blocked = await postUpdate({});
      assert.equal(blocked.error, 'ERR_UPDATE_IN_PROGRESS', JSON.stringify(blocked));
      assert.equal(runCalls, 1, 'the in-process mutex must block a second docker deployer without a repository lock');
    } finally {
      for (const release of releases) release();
      process.chdir(originalCwd);
      rmSync(dockerCwd, { recursive: true, force: true });
    }
  });

  it('recovers a shared repository lock whose owner PID is gone', async () => {
    openAuth();
    mkdirSync(UPDATE_LOCK_DIR);
    writeFileSync(join(UPDATE_LOCK_DIR, 'pid'), '99999999\n');
    gitStub(updateScript({ ['merge --ff-only ' + TAG]: 'Fast-forward' }));
    const r = await postUpdate({});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(existsSync(UPDATE_LOCK_DIR), false, 'recovered lock must be released after the request');
  });

  it('fails closed when a stale lock already has a competing recovery claim', async () => {
    openAuth();
    mkdirSync(UPDATE_LOCK_DIR);
    writeFileSync(join(UPDATE_LOCK_DIR, 'owner'), '99999999 stale-token\n');
    writeFileSync(join(UPDATE_LOCK_DIR, 'pid'), '99999999\n');
    writeFileSync(join(UPDATE_LOCK_DIR, 'recovery'), '88888888 competing-claim\n');
    gitStub(updateScript({ ['merge --ff-only ' + TAG]: 'Fast-forward' }));
    const r = await postUpdate({});
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'ERR_UPDATE_IN_PROGRESS');
    assert.equal(gitCalls.length, 0);
    assert.equal(existsSync(UPDATE_LOCK_DIR), true);
  });
});

describe('gitStatus published field', () => {
  it('fails closed on malformed successful rev-list counts', async () => {
    openAuth();
    const probes = [
      ['rev-list --count ' + TAG + '..' + REMOTE, ''],
      ['rev-list --count ' + HEAD + '..' + TAG, 'not-a-count'],
      ['rev-list --count ' + TAG + '..' + HEAD, '01'],
    ];
    for (const [key, output] of probes) {
      gitStub(updateScript({ [key]: output }));
      const res = fakeRes();
      await handleDashboardApi('GET', '/self-update/check', {}, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
      const body = res.json();
      assert.equal(body.ok, false, JSON.stringify(body));
      assert.equal(body.error, 'ERR_INVALID_GIT_COUNT', JSON.stringify(body));
      assert.equal(body.behind, false, JSON.stringify(body));
    }
  });

  it('offers the released tag while reporting newer untagged remote commits', async () => {
    openAuth();
    gitStub(updateScript({
      ['rev-list --count ' + TAG + '..' + REMOTE]: '5',
    }));
    const res = fakeRes();
    await handleDashboardApi('GET', '/self-update/check', {}, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.published, true);
    assert.equal(body.behind, true);
    assert.equal(body.remoteCommit, TAG.slice(0, 7));
    assert.equal(body.remoteHeadCommit, REMOTE.slice(0, 7));
    assert.equal(body.unreleasedCount, 5);
    assert.equal(body.latestTag, 'v3.9.21');
  });

  it('reports a diverged release target instead of claiming up to date', async () => {
    openAuth();
    gitStub(updateScript({
      ['rev-list --count ' + HEAD + '..' + TAG]: '1',
      ['rev-list --count ' + TAG + '..' + HEAD]: '1',
    }));
    const res = fakeRes();
    await handleDashboardApi('GET', '/self-update/check', {}, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.behind, false);
    assert.equal(body.diverged, true);
  });

  it('surfaces missing release tags as a failed check instead of "up to date"', async () => {
    openAuth();
    gitStub(updateScript({
      'ls-remote --tags origin refs/tags/v[0-9]*': '',
    }));
    const res = fakeRes();
    await handleDashboardApi('GET', '/self-update/check', {}, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    const body = res.json();
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.equal(body.published, false);
    assert.equal(body.error, 'ERR_NO_RELEASE_TAG');
    assert.equal(body.behind, false);
  });
});

describe('self-update rollback', () => {
  it('rolls back to the persisted before-commit and reports a pending restart', async () => {
    openAuth();
    setSelfUpdateRestartSchedulerForTest((_callback, release) => {
      release();
      return true;
    });
    const prevSup = process.env.WINDSURFAPI_RESTART_SUPERVISED;
    process.env.WINDSURFAPI_RESTART_SUPERVISED = '1';
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(BEFORE_JSON, JSON.stringify({ commit: 'f'.repeat(40), after: HEAD, ts: Date.now() }));
    let resetTarget = '';
    gitStub({
      'status --porcelain --untracked-files=all': '',
      [`reset --hard ${'f'.repeat(40)}`]: () => { resetTarget = 'f'.repeat(40); return ''; },
    });
    const res = fakeRes();
    await handleDashboardApi('POST', '/self-update/rollback', {}, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    const body = res.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.state, 'pending-restart');
    assert.equal(body.verified, false, 'a scheduled restart is not a verified rollback');
    assert.equal(body.restartScheduled, true);
    assert.equal(body.rollbackPointRetained, true);
    assert.equal(body.rolledBackTo, 'f'.repeat(7));
    assert.equal(resetTarget, 'f'.repeat(40), 'reset must target the recorded commit');
    assert.equal(existsSync(BEFORE_JSON), true,
      'rollback point is retry evidence until /health confirms the restarted commit');
    const journal = JSON.parse(readFileSync(JOURNAL_JSON, 'utf8'));
    assert.equal(journal.operation, 'rollback');
    assert.equal(journal.state, 'pending-restart');
    assert.equal(journal.phase, 'restart-scheduled');
    assert.equal(journal.expectedCommit, 'f'.repeat(40));
  });

  it('recovers a durable pending point left by a crash after HEAD changed', async () => {
    openAuth();
    setSelfUpdateRestartSchedulerForTest((_callback, release) => {
      release();
      return true;
    });
    setSelfUpdateSupervisorDetectorForTest(() => ({ supervised: true, kind: 'test' }));
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(PENDING_JSON, JSON.stringify({ commit: 'f'.repeat(40), after: HEAD, ts: Date.now() }));
    let resetTarget = '';
    gitStub({
      'rev-parse HEAD': HEAD,
      'status --porcelain --untracked-files=all': '',
      [`reset --hard ${'f'.repeat(40)}`]: () => { resetTarget = 'f'.repeat(40); return ''; },
    });
    const res = fakeRes();
    await handleDashboardApi('POST', '/self-update/rollback', {}, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    const body = res.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.state, 'pending-restart');
    assert.equal(resetTarget, 'f'.repeat(40));
    assert.equal(existsSync(PENDING_JSON), false, 'the recovered point is promoted to final');
    assert.equal(existsSync(BEFORE_JSON), true, 'the promoted point is retained until confirmation');
  });

  it('returns ERR_NO_ROLLBACK_POINT when no prior update recorded', async () => {
    openAuth();
    try { rmSync(BEFORE_JSON, { force: true }); } catch {}
    gitStub({});
    const res = fakeRes();
    await handleDashboardApi('POST', '/self-update/rollback', {}, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'ERR_NO_ROLLBACK_POINT');
  });

  it('rejects a legacy commit-only rollback point without reset or restart', async () => {
    openAuth();
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    const legacy = { commit: 'f'.repeat(40), ts: Date.now() };
    writeFileSync(BEFORE_JSON, JSON.stringify(legacy));
    let restartCalls = 0;
    setSelfUpdateRestartSchedulerForTest(() => { restartCalls++; return false; });
    gitStub({});
    const body = await postRollback({});
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.equal(body.error, 'ERR_INVALID_ROLLBACK_POINT');
    assert.equal(gitCalls.some(call => call.startsWith('reset --hard ')), false);
    assert.equal(restartCalls, 0);
    assert.deepEqual(JSON.parse(readFileSync(BEFORE_JSON, 'utf8')), legacy);
  });

  it('refuses rollback on a dirty tree without forceReset (AUTH-1 parity)', async () => {
    openAuth();
    setSelfUpdateSupervisorDetectorForTest(() => ({ supervised: true, kind: 'test' }));
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(BEFORE_JSON, JSON.stringify({ commit: 'f'.repeat(40), after: HEAD, ts: Date.now() }));
    gitStub({ 'status --porcelain --untracked-files=all': ' M src/index.js' });
    const res = fakeRes();
    await handleDashboardApi('POST', '/self-update/rollback', {}, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'ERR_UNCOMMITTED_CHANGES');
  });

  it('checks supervisor availability before touching a dirty working tree', async () => {
    openAuth();
    setSelfUpdateSupervisorDetectorForTest(() => ({ supervised: false, kind: null }));
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(BEFORE_JSON, JSON.stringify({ commit: 'f'.repeat(40), after: HEAD, ts: Date.now() }));
    let stashRan = false;
    let resetRan = false;
    gitStub({
      'status --porcelain --untracked-files=all': ' M src/index.js',
      'stash push --include-untracked -m windsurfapi-rollback-forceReset-*': () => { stashRan = true; return ''; },
      [`reset --hard ${'f'.repeat(40)}`]: () => { resetRan = true; return ''; },
    });
    const res = fakeRes();
    await handleDashboardApi('POST', '/self-update/rollback', { forceReset: true }, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    const body = res.json();
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.equal(body.error, 'ERR_NO_SUPERVISOR');
    assert.equal(stashRan, false, 'supervisor refusal must happen before stash');
    assert.equal(resetRan, false);
    assert.deepEqual(gitCalls, ['rev-parse HEAD'],
      'metadata correspondence may read HEAD, but supervisor refusal must precede status/stash/reset');
  });

  it('fails closed when rollback cannot stash local changes', async () => {
    openAuth();
    setSelfUpdateSupervisorDetectorForTest(() => ({ supervised: true, kind: 'test' }));
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(BEFORE_JSON, JSON.stringify({ commit: 'f'.repeat(40), after: HEAD, ts: Date.now() }));
    let resetRan = false;
    gitStub({
      'status --porcelain --untracked-files=all': ' M src/index.js',
      'stash push --include-untracked -m windsurfapi-rollback-forceReset-*': new Error('cannot write index'),
      [`reset --hard ${'f'.repeat(40)}`]: () => { resetRan = true; return ''; },
    });
    const res = fakeRes();
    await handleDashboardApi('POST', '/self-update/rollback', { forceReset: true }, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    const body = res.json();
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.equal(body.error, 'ERR_STASH_FAILED');
    assert.equal(resetRan, false, 'stash failure must stop rollback before reset --hard');
  });

  it('restores the just-created stash when rollback reset fails before changing HEAD', async () => {
    openAuth();
    setSelfUpdateSupervisorDetectorForTest(() => ({ supervised: true, kind: 'test' }));
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(BEFORE_JSON, JSON.stringify({ commit: 'f'.repeat(40), after: HEAD, ts: Date.now() }));
    let stashMarker = '';
    let exactStashApplyRan = false;
    let stashPopRan = false;
    gitStub({
      'rev-parse HEAD': HEAD,
      'status --porcelain --untracked-files=all': ' M src/index.js',
      'for-each-ref --format=%(objectname) refs/stash': PREEXISTING_STASH,
      'stash push --include-untracked -m windsurfapi-rollback-forceReset-*': (key) => {
        stashMarker = key.slice(key.indexOf('-m ') + 3);
        return 'Saved working directory';
      },
      'stash list --format=%H%x09%gs': () => `${OWNED_STASH}\tOn master: ${stashMarker}`,
      [`reset --hard ${'f'.repeat(40)}`]: new Error('cannot lock ref'),
      ['stash apply ' + OWNED_STASH]: () => { exactStashApplyRan = true; return 'restored'; },
      'stash pop': () => { stashPopRan = true; return 'wrong stack top'; },
    });
    const res = fakeRes();
    await handleDashboardApi('POST', '/self-update/rollback', { forceReset: true }, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    const body = res.json();
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.equal(body.error, 'ERR_GIT_ROLLBACK_FAILED');
    assert.equal(body.stashed, true);
    assert.equal(body.stashRestored, true);
    assert.equal(exactStashApplyRan, true);
    assert.equal(stashPopRan, false);
    assert.equal(gitCalls.includes('stash pop'), false);
    assert.equal(existsSync(BEFORE_JSON), true, 'failed rollback must preserve its retry point');
  });

  it('does not apply an older user stash when rollback stash creation races to a no-op', async () => {
    openAuth();
    let oldStashApplyRan = false;
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(BEFORE_JSON, JSON.stringify({ commit: 'f'.repeat(40), after: HEAD, ts: Date.now() }));
    gitStub({
      'status --porcelain --untracked-files=all': ' M src/index.js',
      'for-each-ref --format=%(objectname) refs/stash': PREEXISTING_STASH,
      'stash push --include-untracked -m windsurfapi-rollback-forceReset-*': 'No local changes to save',
      'stash list --format=%H%x09%gs': `${PREEXISTING_STASH}\tOn master: user backup`,
      [`reset --hard ${'f'.repeat(40)}`]: new Error('cannot lock ref'),
      ['stash apply ' + PREEXISTING_STASH]: () => { oldStashApplyRan = true; return 'wrong stash'; },
    });
    const body = await postRollback({ forceReset: true });
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.equal(body.error, 'ERR_GIT_ROLLBACK_FAILED');
    assert.equal(body.stashed, false);
    assert.equal(oldStashApplyRan, false);
    assert.equal(gitCalls.some(call => call.startsWith('stash apply ')), false);
    assert.equal(gitCalls.includes('stash pop'), false);
  });

  it('accepts rollback reset failure only when the verified target is clean', async () => {
    openAuth();
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    const target = 'f'.repeat(40);
    writeFileSync(BEFORE_JSON, JSON.stringify({ commit: target, after: HEAD, ts: Date.now() }));
    let restartCalls = 0;
    setSelfUpdateRestartSchedulerForTest((_callback, release) => {
      restartCalls++;
      release();
      return true;
    });
    gitStub({
      'status --porcelain --untracked-files=all': '',
      [`reset --hard ${target}`]: { error: new Error('connection lost after reset'), head: target },
    });
    const body = await postRollback({});
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.state, 'pending-restart');
    assert.equal(body.rolledBackTo, target.slice(0, 7));
    assert.equal(restartCalls, 1);
    assert.equal(existsSync(BEFORE_JSON), true, 'the point survives until the restart is confirmed');
  });

  it('reports ERR_ROLLBACK_PARTIAL when target HEAD remains tracked-dirty', async () => {
    openAuth();
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    const target = 'f'.repeat(40);
    writeFileSync(BEFORE_JSON, JSON.stringify({ commit: target, after: HEAD, ts: Date.now() }));
    let restartCalls = 0;
    setSelfUpdateRestartSchedulerForTest(() => { restartCalls++; return false; });
    gitStub({
      'status --porcelain --untracked-files=all': '',
      [`reset --hard ${target}`]: '',
      'status --porcelain --untracked-files=no --ignore-submodules=none': ' M src/index.js',
    });
    const body = await postRollback({});
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.equal(body.error, 'ERR_ROLLBACK_PARTIAL');
    assert.equal(body.actual, target);
    assert.equal(restartCalls, 0);
    assert.equal(existsSync(BEFORE_JSON), true);
  });

  it('reports ERR_ROLLBACK_PARTIAL for old HEAD plus tracked dirt and never restores a stash there', async () => {
    openAuth();
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    const target = 'f'.repeat(40);
    writeFileSync(BEFORE_JSON, JSON.stringify({ commit: target, after: HEAD, ts: Date.now() }));
    gitStub({
      'status --porcelain --untracked-files=all': '',
      [`reset --hard ${target}`]: new Error('reset rejected'),
      'status --porcelain --untracked-files=no --ignore-submodules=none': ' M src/index.js',
    });
    const body = await postRollback({});
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.equal(body.error, 'ERR_ROLLBACK_PARTIAL');
    assert.equal(body.actual, HEAD);
    assert.equal(gitCalls.some(call => call.startsWith('stash apply ')), false);
    assert.equal(existsSync(BEFORE_JSON), true);
  });

  it('reports ERR_ROLLBACK_STATE_UNKNOWN and preserves the point when post-state probing fails', async () => {
    openAuth();
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    const target = 'f'.repeat(40);
    writeFileSync(BEFORE_JSON, JSON.stringify({ commit: target, after: HEAD, ts: Date.now() }));
    let restartCalls = 0;
    setSelfUpdateRestartSchedulerForTest(() => { restartCalls++; return false; });
    gitStub({
      'status --porcelain --untracked-files=all': '',
      [`reset --hard ${target}`]: '',
      'status --porcelain --untracked-files=no --ignore-submodules=none': new Error('index unreadable'),
    });
    const body = await postRollback({});
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.equal(body.error, 'ERR_ROLLBACK_STATE_UNKNOWN');
    assert.equal(restartCalls, 0);
    assert.equal(existsSync(BEFORE_JSON), true);
  });

  it('holds the repository lock from rollback response through restart handoff release', async () => {
    openAuth();
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    const target = 'f'.repeat(40);
    writeFileSync(BEFORE_JSON, JSON.stringify({ commit: target, after: HEAD, ts: Date.now() }));
    let releaseHandoff = null;
    setSelfUpdateRestartSchedulerForTest((_callback, release) => {
      releaseHandoff = release;
      return true;
    });
    gitStub({
      'status --porcelain --untracked-files=all': '',
      [`reset --hard ${target}`]: '',
    });
    const first = await postRollback({});
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(existsSync(UPDATE_LOCK_DIR), true);

    const blocked = await postUpdate({});
    assert.equal(blocked.error, 'ERR_UPDATE_IN_PROGRESS');
    releaseHandoff();
    assert.equal(existsSync(UPDATE_LOCK_DIR), false);

    // The rollback retains its point as retry evidence until a restart is
    // confirmed; this test measures the lock, so clear the point explicitly.
    rmSync(BEFORE_JSON, { force: true });
    rmSync(JOURNAL_JSON, { force: true });
    const afterRelease = await postRollback({});
    assert.equal(afterRelease.error, 'ERR_NO_ROLLBACK_POINT');
  });
});

// D6 (audit2/Update.md P2-6): `{ok:true}` used to be emitted 800 ms before the
// restart ran, after deleting the rollback point — so a scheduler failure was
// indistinguishable from a verified healthy rollback and the retry evidence
// was already gone. The journal makes the lifecycle explicit: pending until the
// running process reports the expected commit on /health.
describe('self-update rollback: truthful pending state and durable retry evidence', () => {
  const target = 'f'.repeat(40);

  function seedPendingJournal(overrides = {}) {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(JOURNAL_JSON, JSON.stringify({
      version: 1,
      operation: 'rollback',
      state: 'pending-restart',
      phase: 'reset-verified',
      expectedCommit: target,
      afterCommit: HEAD,
      rollbackPointRetained: true,
      requestedAt: Date.now(),
      ...overrides,
    }));
  }

  it('does not claim success or delete the retry point when the scheduler declines', async () => {
    openAuth();
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(BEFORE_JSON, JSON.stringify({ commit: target, after: HEAD, ts: Date.now() }));
    gitStub({
      'status --porcelain --untracked-files=all': '',
      [`reset --hard ${target}`]: '',
    });
    const body = await postRollback({});
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.equal(body.error, 'ERR_RESTART_NOT_SCHEDULED');
    assert.equal(body.state, 'restart-not-scheduled');
    assert.equal(body.restartScheduled, false);
    assert.equal(body.verified, false);
    assert.equal(body.rollbackPointRetained, true);
    assert.equal(body.rolledBackTo, target.slice(0, 7));
    assert.equal(existsSync(BEFORE_JSON), true, 'a declined restart must keep the retry point');
    const journal = JSON.parse(readFileSync(JOURNAL_JSON, 'utf8'));
    assert.equal(journal.state, 'restart-not-scheduled');
    assert.equal(journal.expectedCommit, target);
    assert.equal(journal.operation, 'rollback');
  });

  it('keeps pre-reset journal evidence and the point when the reset fails', async () => {
    openAuth();
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(BEFORE_JSON, JSON.stringify({ commit: target, after: HEAD, ts: Date.now() }));
    gitStub({
      'status --porcelain --untracked-files=all': '',
      [`reset --hard ${target}`]: new Error('cannot lock ref'),
    });
    const body = await postRollback({});
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.equal(body.error, 'ERR_GIT_ROLLBACK_FAILED');
    assert.equal(existsSync(BEFORE_JSON), true);
    const journal = JSON.parse(readFileSync(JOURNAL_JSON, 'utf8'));
    assert.equal(journal.state, 'failed', 'a reset that never applied must not read as a pending restart');
    assert.equal(journal.reason, 'reset-not-verified');
    assert.equal(journal.phase, 'pre-reset', 'evidence must exist before the destructive step');
  });

  it('confirms a pending rollback only when the running commit matches, then clears the point', () => {
    seedPendingJournal();
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(BEFORE_JSON, JSON.stringify({ commit: target, after: HEAD, ts: Date.now() }));
    setSelfUpdateRunningCommitForTest(() => target);
    const journal = reconcileSelfUpdateJournal();
    assert.equal(journal.state, 'confirmed', JSON.stringify(journal));
    assert.equal(journal.confirmedCommit, target);
    assert.equal(existsSync(BEFORE_JSON), false, 'a confirmed rollback no longer needs its retry point');
    assert.equal(JSON.parse(readFileSync(JOURNAL_JSON, 'utf8')).state, 'confirmed');
  });

  it('keeps the point and pending state when the running commit has not changed', () => {
    seedPendingJournal();
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(BEFORE_JSON, JSON.stringify({ commit: target, after: HEAD, ts: Date.now() }));
    setSelfUpdateRunningCommitForTest(() => HEAD);
    const journal = reconcileSelfUpdateJournal();
    assert.equal(journal.state, 'pending-restart');
    assert.equal(existsSync(BEFORE_JSON), true, 'an unconfirmed rollback must stay retryable');
  });

  it('re-confirms a journal left in restart-failed once a later restart serves the commit', () => {
    seedPendingJournal({ state: 'restart-failed', error: 'boom', phase: 'restart-scheduled' });
    setSelfUpdateRunningCommitForTest(() => target);
    const journal = reconcileSelfUpdateJournal();
    assert.equal(journal.state, 'confirmed');
  });

  it('surfaces the journal through /self-update/check', async () => {
    openAuth();
    seedPendingJournal();
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(BEFORE_JSON, JSON.stringify({ commit: target, after: HEAD, ts: Date.now() }));
    setSelfUpdateRunningCommitForTest(() => target);
    const res = fakeRes();
    await handleDashboardApi('GET', '/self-update/check', {}, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    const body = res.json();
    assert.equal(body.selfUpdate?.state, 'confirmed', JSON.stringify(body));
    assert.equal(existsSync(BEFORE_JSON), false);
  });
});
