import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { configureBindHost } from '../src/auth.js';
import { setRuntimeApiKey, setRuntimeDashboardPassword } from '../src/runtime-config.js';
import { handleDashboardApi, setGitExecFileForTest } from '../src/dashboard/api.js';

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

const BEFORE_JSON = join(process.cwd(), 'data', 'self-update-before.json');
const prevNoAuth = process.env.DASHBOARD_ALLOW_NO_AUTH;
const origPwd = config.dashboardPassword;
const origKey = config.apiKey;

function openAuth() {
  config.dashboardPassword = '';
  config.apiKey = '';
  setRuntimeApiKey('');
  setRuntimeDashboardPassword('');
  process.env.DASHBOARD_ALLOW_NO_AUTH = '1';
  configureBindHost('127.0.0.1');
}

afterEach(() => {
  gitCalls.length = 0;
  setGitExecFileForTest(null);
  try { rmSync(BEFORE_JSON, { force: true }); } catch {}
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
  setGitExecFileForTest((bin, args, opts, cb) => {
    const key = args.join(' ');
    gitCalls.push(key);
    const matchedKey = Object.prototype.hasOwnProperty.call(map, key)
      ? key
      : Object.keys(map).find(candidate => candidate.endsWith('*') && key.startsWith(candidate.slice(0, -1)));
    if (matchedKey) {
      const v = typeof map[matchedKey] === 'function' ? map[matchedKey]() : map[matchedKey];
      cb(null, String(v) + '\n', '');
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

function updateScript(extra) {
  const m = {
    'rev-parse HEAD': HEAD,
    'rev-parse --abbrev-ref HEAD': 'master',
    'fetch --quiet origin': '',
    'fetch --quiet origin master --tags': '',
    'rev-parse origin/master': REMOTE,
    'log -1 --pretty=format:%s': 'local msg',
    'status --porcelain -uno': '',
    'tag --list --sort=-v:refname --merged origin/master': 'v3.9.21',
    'rev-parse v3.9.21': TAG,
    ['rev-list --count v3.9.21..' + REMOTE]: '0',
    ['rev-list --count ' + HEAD + '..' + TAG]: '1',
    ['rev-list --count ' + TAG + '..' + HEAD]: '0',
    ['log -1 --pretty=format:%s ' + TAG]: 'released msg',
  };
  return Object.assign(m, extra || {});
}

function postUpdate(req) {
  const res = fakeRes();
  return handleDashboardApi('POST', '/self-update', req, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res)
    .then(() => res.json());
}

describe('self-update version gate (tag)', () => {
  it('installs the latest tag even when remote has post-tag unreleased commits', async () => {
    openAuth();
    let releaseMergeRan = false;
    gitStub(updateScript({
      ['rev-list --count v3.9.21..' + REMOTE]: '3',
      ['merge --ff-only ' + TAG]: () => { releaseMergeRan = true; return 'Fast-forward'; },
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(releaseMergeRan, true, 'OTA must fast-forward to the released tag');
    assert.equal(gitCalls.includes('pull origin master --ff-only'), false,
      'normal OTA must not pull the untagged branch HEAD');
  });

  it('allows pull when remote IS the latest tag (published)', async () => {
    openAuth();
    gitStub(updateScript({
      'rev-parse origin/master': TAG,
      ['rev-list --count v3.9.21..' + TAG]: '0',
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
      ['rev-list --count v3.9.21..' + REMOTE]: '2',
      ['rev-list --count ' + HEAD + '..' + REMOTE]: '3',
      ['rev-list --count ' + REMOTE + '..' + HEAD]: '0',
      ['merge --ff-only ' + REMOTE]: () => { remoteMergeRan = true; return 'Fast-forward'; },
    }));
    const r = await postUpdate({ forceUpdate: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(remoteMergeRan, true);
  });

  it('falls back to the remote branch head when the repository has no release tags', async () => {
    openAuth();
    let remoteMergeRan = false;
    gitStub(updateScript({
      'tag --list --sort=-v:refname --merged origin/master': '',
      ['rev-list --count ' + HEAD + '..' + REMOTE]: '1',
      ['rev-list --count ' + REMOTE + '..' + HEAD]: '0',
      ['merge --ff-only ' + REMOTE]: () => { remoteMergeRan = true; return 'Fast-forward'; },
    }));
    const r = await postUpdate({});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(remoteMergeRan, true);
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
    assert.equal(gitCalls.includes('fetch --quiet origin master --tags'), true);
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
      'stash push --include-untracked -m self-update-forceReset *': '',
      ['reset --hard ' + HEAD]: () => { resetTarget = HEAD; return ''; },
    }));
    const r = await postUpdate({ forceReset: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(resetTarget, HEAD);
    assert.equal(gitCalls.includes('reset --hard ' + TAG), false);
  });
});

describe('gitStatus published field', () => {
  it('offers the released tag while reporting newer untagged remote commits', async () => {
    openAuth();
    gitStub(updateScript({
      ['rev-list --count v3.9.21..' + REMOTE]: '5',
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
});

describe('self-update rollback', () => {
  it('rolls back to the persisted before-commit', async () => {
    openAuth();
    const prevSup = process.env.WINDSURFAPI_RESTART_SUPERVISED;
    process.env.WINDSURFAPI_RESTART_SUPERVISED = '1';
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(BEFORE_JSON, JSON.stringify({ commit: 'f'.repeat(40), ts: Date.now() }));
    let resetTarget = '';
    gitStub({
      'status --porcelain -uno': '',
      [`reset --hard ${'f'.repeat(40)}`]: () => { resetTarget = 'f'.repeat(40); return ''; },
    });
    const res = fakeRes();
    await handleDashboardApi('POST', '/self-update/rollback', {}, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    const body = res.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.rolledBackTo, 'f'.repeat(7));
    assert.equal(resetTarget, 'f'.repeat(40), 'reset must target the recorded commit');
    assert.equal(existsSync(BEFORE_JSON), false, 'rollback point must be cleared after rollback');
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

  it('refuses rollback on a dirty tree without forceReset (AUTH-1 parity)', async () => {
    openAuth();
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(BEFORE_JSON, JSON.stringify({ commit: 'f'.repeat(40), ts: Date.now() }));
    gitStub({ 'status --porcelain -uno': ' M src/index.js' });
    const res = fakeRes();
    await handleDashboardApi('POST', '/self-update/rollback', {}, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'ERR_UNCOMMITTED_CHANGES');
  });
});
