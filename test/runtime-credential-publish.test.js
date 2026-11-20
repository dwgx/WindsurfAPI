// Task B: the runtime credential pair after a published rename.
//
// src/fs-atomic.js:renameSyncWithRetry() marks the error `renamePublished`
// when rename(2) succeeded but the parent-directory fsync failed. The old
// credential writer rolled BOTH fields back on every error, so the file held
// the new pair while the live process kept the old one — and the next
// unrelated save wrote that stale pair back over the published file.
//
// These tests drive the REAL temp-file rename and inject only the
// parent-directory sync failure (plus the ACL pass). Disk, live getters and a
// fresh-process reload must agree on the new pair. The pre-rename fault keeps
// the old pair everywhere and is reported as not applied.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../src/config.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { writeJsonAtomic } from '../src/fs-atomic.js';
import {
  __setRuntimeConfigFsHooksForTests,
  __setRuntimeConfigPersistFailureForTests,
  _resetRuntimeConfigForTests,
  getCredentials,
  getEffectiveApiKey,
  getEffectiveDashboardPasswordStored,
  setExperimental,
  setRuntimeApiKey,
  setRuntimeDashboardPassword,
  verifyPassword,
} from '../src/runtime-config.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;

const OLD_KEY = 'sk-old-runtime-key';
const OLD_PASSWORD = 'old-dashboard-password';
const NEW_KEY = 'sk-durable-new-key';
const NEW_PASSWORD = 'durable-new-password';

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
    end(chunk) { this.body += chunk ? String(chunk) : ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

function authedReq(password) {
  return {
    url: '/dashboard/api/settings/credentials',
    headers: { 'x-dashboard-password': password },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function readStore() {
  return JSON.parse(readFileSync(join(config.dataDir, 'runtime-config.json'), 'utf-8'));
}

function seedOldPair() {
  _resetRuntimeConfigForTests();
  setRuntimeApiKey(OLD_KEY);
  setRuntimeDashboardPassword(OLD_PASSWORD);
  return readStore();
}

// A new process is the only honest way to prove what load() would restore;
// importing runtime-config here would reuse this process's _state.
function reloadInChild() {
  const report = join(config.dataDir, 'credential-reload.json');
  execFileSync(process.execPath, [
    '--import', './test/setup-env.mjs',
    '--import', './scripts/mutation-network-deny.mjs',
    'test/_runtime-config-reload-child.mjs',
    report,
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      WINDSURFAPI_TEST_DATA_DIR: config.dataDir,
      WINDSURFAPI_SKIP_DOTENV: '1',
      API_KEY: 'env-fallback-key',
      DASHBOARD_PASSWORD: 'env-fallback-password',
    },
    stdio: 'pipe',
  });
  return JSON.parse(readFileSync(report, 'utf8'));
}

async function putCredentials(body, password) {
  const res = fakeRes();
  await handleDashboardApi('PUT', '/settings/credentials', body, authedReq(password), res);
  return res;
}

// A real rename followed by a failing parent-directory fsync. The wrapper
// counts renames so the test can prove a published rename is never replayed.
function failParentSyncAfterVisibleRename({ onRename = () => {}, onProtection = null } = {}) {
  const hooks = {
    writeJsonAtomic: (file, value) => writeJsonAtomic(file, value, {
      rename: (from, to) => { onRename(); renameSync(from, to); },
      fsyncParent: () => { throw Object.assign(new Error('simulated directory fsync EIO'), { code: 'EIO' }); },
    }),
  };
  if (onProtection) hooks.restrictFileToOwnerSync = onProtection;
  __setRuntimeConfigFsHooksForTests(hooks);
}

afterEach(() => {
  __setRuntimeConfigFsHooksForTests(null);
  __setRuntimeConfigPersistFailureForTests(null);
  _resetRuntimeConfigForTests();
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
});

describe('runtime credential rotation after a published rename', () => {
  it('durable rotation publishes both fields to disk, live getters and a fresh reload', async () => {
    const before = seedOldPair();

    const res = await putCredentials({
      apiKey: NEW_KEY,
      dashboardPassword: NEW_PASSWORD,
    }, OLD_PASSWORD);

    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.applied, true);
    assert.equal(body.durability, 'durable');
    assert.ok(['applied', 'not-applicable'].includes(body.protection), body.protection);
    assert.equal(body.warnings, undefined, 'a clean durable rotation has no warning');
    assert.equal(body.apiKeyUpdated, true);
    assert.equal(body.dashboardPasswordUpdated, true);
    assert.ok(!res.body.includes(NEW_KEY), 'the plaintext api key must not be echoed');
    assert.ok(!res.body.includes(NEW_PASSWORD), 'the plaintext password must not be echoed');

    const live = getCredentials();
    assert.equal(live.apiKey, NEW_KEY);
    assert.equal(verifyPassword(NEW_PASSWORD, live.dashboardPasswordHash), true);
    assert.equal(verifyPassword(OLD_PASSWORD, live.dashboardPasswordHash), false, 'the old password must stop working');

    const disk = readStore();
    assert.equal(disk.credentials.apiKey, NEW_KEY);
    assert.equal(disk.credentials.dashboardPasswordHash, live.dashboardPasswordHash);
    assert.notDeepEqual(disk.credentials, before.credentials);

    const reloaded = reloadInChild();
    assert.deepEqual(reloaded.credentials, live);
    assert.equal(reloaded.effectiveApiKey, NEW_KEY);
    assert.equal(verifyPassword(NEW_PASSWORD, reloaded.effectivePassword), true);
  });

  it('a pre-rename fault applies nothing: disk, live and reload keep the old pair', async () => {
    const before = seedOldPair();
    __setRuntimeConfigPersistFailureForTests(new Error('simulated ENOSPC'));

    const res = await putCredentials({
      apiKey: NEW_KEY,
      dashboardPassword: NEW_PASSWORD,
    }, OLD_PASSWORD);

    assert.equal(res.statusCode, 500, res.body);
    const body = res.json();
    assert.equal(body.success, false);
    assert.equal(body.applied, false);
    assert.equal(body.durability, 'not-applied');
    assert.equal(body.protection, 'not-applicable');
    assert.equal(body.error, 'ERR_CREDENTIAL_PERSIST_FAILED');
    assert.equal(body.apiKeyUpdated, undefined, 'an unapplied rotation must not claim an update');
    assert.equal(body.warnings, undefined, 'nothing was applied, so there is no applied warning');

    assert.deepEqual(getCredentials(), before.credentials);
    assert.deepEqual(readStore().credentials, before.credentials);
    assert.deepEqual(reloadInChild().credentials, before.credentials);
  });

  it('a post-rename directory-sync failure keeps the new pair live and reports unconfirmed durability', async () => {
    const before = seedOldPair();
    let renames = 0;
    let protectionCalls = 0;
    failParentSyncAfterVisibleRename({
      onRename: () => { renames++; },
      onProtection: () => { protectionCalls++; return { applied: true, user: 'test' }; },
    });

    const res = await putCredentials({
      apiKey: NEW_KEY,
      dashboardPassword: NEW_PASSWORD,
    }, OLD_PASSWORD);

    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.applied, true);
    assert.equal(body.durability, 'unconfirmed');
    assert.equal(body.protection, 'applied');
    assert.deepEqual(body.warnings, ['ERR_CREDENTIAL_DURABILITY_UNCONFIRMED']);
    assert.ok(!res.body.includes(NEW_KEY));
    assert.ok(!res.body.includes(NEW_PASSWORD));

    assert.equal(renames, 1, 'a published rename must never be replayed');
    assert.equal(protectionCalls, 1, 'owner-only protection must still run after publication');

    const live = getCredentials();
    assert.equal(live.apiKey, NEW_KEY);
    assert.equal(verifyPassword(NEW_PASSWORD, live.dashboardPasswordHash), true);
    assert.equal(verifyPassword(OLD_PASSWORD, live.dashboardPasswordHash), false);

    const disk = readStore();
    assert.equal(disk.credentials.apiKey, NEW_KEY);
    assert.equal(disk.credentials.dashboardPasswordHash, live.dashboardPasswordHash);
    assert.notDeepEqual(disk.credentials, before.credentials);
    assert.deepEqual(
      readdirSync(config.dataDir).filter(name => name.startsWith('runtime-config.json.') && name.endsWith('.tmp')),
      [],
      'the published tmp name must not be left behind',
    );

    const reloaded = reloadInChild();
    assert.deepEqual(reloaded.credentials, live);
    assert.equal(reloaded.effectiveApiKey, NEW_KEY);
    assert.equal(verifyPassword(NEW_PASSWORD, reloaded.effectivePassword), true);
  });

  it('a protection failure after publication is reported, never ordinary success', async () => {
    seedOldPair();
    __setRuntimeConfigFsHooksForTests({
      restrictFileToOwnerSync: () => ({ applied: false, reason: 'icacls-failed', error: 'access denied' }),
    });

    const res = await putCredentials({
      apiKey: NEW_KEY,
      dashboardPassword: NEW_PASSWORD,
    }, OLD_PASSWORD);

    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.applied, true);
    assert.equal(body.durability, 'durable');
    assert.equal(body.protection, 'failed');
    assert.ok(body.warnings.includes('ERR_CREDENTIAL_PROTECTION_FAILED'), res.body);

    assert.equal(getCredentials().apiKey, NEW_KEY);
    assert.equal(readStore().credentials.apiKey, NEW_KEY);
  });

  it('a later unrelated save cannot resurrect the pre-rotation pair', async () => {
    seedOldPair();
    failParentSyncAfterVisibleRename({ onProtection: () => ({ applied: true }) });

    const res = await putCredentials({
      apiKey: NEW_KEY,
      dashboardPassword: NEW_PASSWORD,
    }, OLD_PASSWORD);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().durability, 'unconfirmed');

    // Drop the fault and let an unrelated setter persist the same live state.
    __setRuntimeConfigFsHooksForTests(null);
    setExperimental({ clineCompat: true });

    const disk = readStore();
    assert.equal(disk.experimental.clineCompat, true, 'the unrelated save must have happened');
    assert.equal(disk.credentials.apiKey, NEW_KEY, 'the published key must survive the later save');
    assert.equal(verifyPassword(NEW_PASSWORD, disk.credentials.dashboardPasswordHash), true);
    assert.equal(verifyPassword(OLD_PASSWORD, disk.credentials.dashboardPasswordHash), false);
    assert.equal(getCredentials().apiKey, NEW_KEY);
  });

  it('explicit clear still removes both runtime overrides and exposes the env fallback', async () => {
    seedOldPair();
    config.apiKey = 'env-fallback-key';
    config.dashboardPassword = 'env-fallback-password';

    const res = await putCredentials({ apiKey: '', dashboardPassword: '' }, OLD_PASSWORD);

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().durability, 'durable');
    assert.deepEqual(getCredentials(), { apiKey: '', dashboardPasswordHash: '' });
    assert.equal(getEffectiveApiKey(), 'env-fallback-key');
    assert.equal(getEffectiveDashboardPasswordStored(), 'env-fallback-password');
    assert.deepEqual(readStore().credentials, { apiKey: '', dashboardPasswordHash: '' });

    const reloaded = reloadInChild();
    assert.deepEqual(reloaded.credentials, { apiKey: '', dashboardPasswordHash: '' });
    assert.equal(reloaded.effectiveApiKey, 'env-fallback-key');
    assert.equal(reloaded.effectivePassword, 'env-fallback-password');
  });

  it('one invalid field rejects the whole request with zero writes', async () => {
    const before = seedOldPair();
    let writes = 0;
    __setRuntimeConfigFsHooksForTests({
      writeJsonAtomic: (file, value) => { writes++; return writeJsonAtomic(file, value); },
    });

    const badPassword = await putCredentials({
      apiKey: NEW_KEY,
      dashboardPassword: 'short',
    }, OLD_PASSWORD);
    assert.equal(badPassword.statusCode, 400, badPassword.body);
    assert.equal(writes, 0, 'a rejected password must not reach the writer');
    assert.deepEqual(getCredentials(), before.credentials);
    assert.deepEqual(readStore().credentials, before.credentials);

    const badKey = await putCredentials({
      apiKey: 'has whitespace',
      dashboardPassword: 'valid-long-password',
    }, OLD_PASSWORD);
    assert.equal(badKey.statusCode, 400, badKey.body);
    assert.equal(writes, 0, 'a rejected apiKey must not reach the writer');
    assert.deepEqual(getCredentials(), before.credentials);
    assert.deepEqual(readStore().credentials, before.credentials);
  });

  it('both fields are committed by exactly one atomic write', async () => {
    seedOldPair();
    let writes = 0;
    __setRuntimeConfigFsHooksForTests({
      writeJsonAtomic: (file, value) => { writes++; return writeJsonAtomic(file, value); },
    });

    const res = await putCredentials({
      apiKey: NEW_KEY,
      dashboardPassword: NEW_PASSWORD,
    }, OLD_PASSWORD);

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(writes, 1, 'both credentials must ride one atomic replace');
    const disk = readStore();
    assert.equal(disk.credentials.apiKey, NEW_KEY);
    assert.equal(verifyPassword(NEW_PASSWORD, disk.credentials.dashboardPasswordHash), true);
  });
});
