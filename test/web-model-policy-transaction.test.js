// Model access policy is one transaction, not three setters.
//
// Before this contract, PUT /model-access called setModelAccessMode(),
// setModelAccessList() and setDefaultModel() — three independent writes whose
// failures were swallowed — and still answered 200. A partial mode/list/default
// update could therefore be reported as success. save() also swallowed
// writeJsonAtomic errors entirely.
//
// These tests drive the REAL atomic writer through the dashboard route and
// inject only the two failure boundaries the writer actually distinguishes:
//   - before the rename: nothing is published, memory keeps the old policy;
//   - after the rename: the parent-directory fsync fails, the new file IS
//     visible, so memory must follow the published snapshot and the response
//     must say durability is unconfirmed (never "nothing happened").
//
// Fresh temp storage comes from test/setup-env.mjs; no real config is touched.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { config } from '../src/config.js';
import { configureBindHost } from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { writeJsonAtomic } from '../src/fs-atomic.js';
import {
  __setModelAccessFsHooksForTests,
  __setModelAccessPersistFailureForTests,
  getDefaultModel,
  getModelAccessConfig,
  isModelAllowed,
  setModelAccessMode,
  updateModelAccess,
} from '../src/dashboard/model-access.js';

const ACCESS_FILE = join(config.dataDir, 'model-access.json');
const ORIGINAL_DASHBOARD_PASSWORD = config.dashboardPassword;
const ORIGINAL_API_KEY = config.apiKey;
const ORIGINAL_ALLOW_NO_AUTH = process.env.DASHBOARD_ALLOW_NO_AUTH;
const ORIGINAL_ALLOW_API_KEY = process.env.DASHBOARD_ALLOW_API_KEY_AS_PASSWORD;

const BASELINE = { mode: 'all', list: [], defaultModel: '' };

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

function localReq(path) {
  return {
    url: `/dashboard/api${path}`,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  };
}

async function call(method, path, body) {
  const res = fakeRes();
  await handleDashboardApi(method, path, body, localReq(path), res);
  return res;
}

function readStore() {
  return JSON.parse(readFileSync(ACCESS_FILE, 'utf-8'));
}

function countWrites() {
  const counter = { writes: 0 };
  __setModelAccessFsHooksForTests({
    writeJsonAtomic: (file, value) => {
      counter.writes += 1;
      assert.equal(file, ACCESS_FILE);
      return writeJsonAtomic(file, value);
    },
  });
  return counter;
}

function failParentSyncAfterVisibleRename() {
  const counter = { renames: 0 };
  __setModelAccessFsHooksForTests({
    writeJsonAtomic: (file, value) => writeJsonAtomic(file, value, {
      rename: (from, to) => { counter.renames += 1; renameSync(from, to); },
      fsyncParent: () => { throw Object.assign(new Error('simulated directory fsync EIO'), { code: 'EIO' }); },
    }),
  });
  return counter;
}

// Write a known snapshot through the real transaction. The bootstrap mode is
// always different from the target so the baseline file definitely exists.
function seed(snapshot = BASELINE) {
  __setModelAccessFsHooksForTests(null);
  __setModelAccessPersistFailureForTests(null);
  setModelAccessMode(snapshot.mode === 'allowlist' ? 'blocklist' : 'allowlist');
  const result = updateModelAccess(snapshot);
  assert.equal(result.applied, true, 'baseline seed must be applied');
  assert.equal(result.changed, true);
}

beforeEach(() => {
  config.dashboardPassword = '';
  config.apiKey = '';
  process.env.DASHBOARD_ALLOW_NO_AUTH = '1';
  delete process.env.DASHBOARD_ALLOW_API_KEY_AS_PASSWORD;
  configureBindHost('127.0.0.1');
  seed();
});

afterEach(() => {
  __setModelAccessFsHooksForTests(null);
  __setModelAccessPersistFailureForTests(null);
  config.dashboardPassword = ORIGINAL_DASHBOARD_PASSWORD;
  config.apiKey = ORIGINAL_API_KEY;
  if (ORIGINAL_ALLOW_NO_AUTH === undefined) delete process.env.DASHBOARD_ALLOW_NO_AUTH;
  else process.env.DASHBOARD_ALLOW_NO_AUTH = ORIGINAL_ALLOW_NO_AUTH;
  if (ORIGINAL_ALLOW_API_KEY === undefined) delete process.env.DASHBOARD_ALLOW_API_KEY_AS_PASSWORD;
  else process.env.DASHBOARD_ALLOW_API_KEY_AS_PASSWORD = ORIGINAL_ALLOW_API_KEY;
  configureBindHost('0.0.0.0');
});

describe('model access policy transaction', () => {
  it('one PUT commits mode, list and default with exactly one atomic write', async () => {
    const writes = countWrites();

    const res = await call('PUT', '/model-access', {
      mode: 'allowlist',
      list: ['gpt-4o', 'claude-opus-4.6'],
      defaultModel: '  gpt-4o  ',
    });

    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.applied, true);
    assert.equal(body.changed, true);
    assert.equal(body.durability, 'durable');
    assert.equal(body.warnings, undefined, 'a durable write carries no warning');
    const expected = { mode: 'allowlist', list: ['gpt-4o', 'claude-opus-4.6'], defaultModel: 'gpt-4o' };
    assert.deepEqual(body.config, expected);
    assert.deepEqual(getModelAccessConfig(), expected);
    assert.deepEqual(readStore(), expected);
    assert.equal(writes.writes, 1, 'all fields must ride one atomic replace');
    assert.deepEqual(
      readdirSync(config.dataDir).filter(n => n.startsWith('model-access.json.') && n.endsWith('.tmp')),
      [],
      'the temp name must not be left behind',
    );
  });

  it('a pre-rename failure applies nothing and returns an honest 500', async () => {
    const before = getModelAccessConfig();
    const fileBefore = readFileSync(ACCESS_FILE, 'utf-8');
    let writes = 0;
    __setModelAccessFsHooksForTests({
      writeJsonAtomic: () => {
        writes += 1;
        throw Object.assign(new Error('simulated ENOSPC'), { code: 'ENOSPC' });
      },
    });

    const res = await call('PUT', '/model-access', {
      mode: 'allowlist',
      list: ['gpt-4o'],
      defaultModel: 'gpt-4o',
    });

    assert.equal(res.statusCode, 500, res.body);
    const body = res.json();
    assert.equal(body.success, false);
    assert.equal(body.applied, false);
    assert.equal(body.changed, true);
    assert.equal(body.durability, 'not-applied');
    assert.equal(body.error, 'ERR_MODEL_ACCESS_PERSIST_FAILED');
    assert.deepEqual(body.config, before, 'the response reports the still-active policy');
    assert.equal(writes, 1, 'exactly one persistence attempt per API operation');

    assert.deepEqual(getModelAccessConfig(), before);
    assert.equal(readFileSync(ACCESS_FILE, 'utf-8'), fileBefore, 'the old file must survive');
    assert.equal(isModelAllowed('gpt-4o').allowed, true, 'old policy still governs requests');
    assert.equal(getDefaultModel(), '');
  });

  it('the pre-write fault seam never reaches the writer or disk', async () => {
    const before = getModelAccessConfig();
    const fileBefore = readFileSync(ACCESS_FILE, 'utf-8');
    const writes = countWrites();
    __setModelAccessPersistFailureForTests(new Error('simulated pre-write failure'));

    const res = await call('POST', '/model-access/add', { model: 'gpt-4o' });

    assert.equal(res.statusCode, 500, res.body);
    assert.equal(res.json().durability, 'not-applied');
    assert.equal(writes.writes, 0);
    assert.deepEqual(getModelAccessConfig(), before);
    assert.equal(readFileSync(ACCESS_FILE, 'utf-8'), fileBefore);
  });

  it('a post-rename directory-sync failure keeps memory equal to the published file', async () => {
    const before = getModelAccessConfig();
    const renames = failParentSyncAfterVisibleRename();

    const res = await call('PUT', '/model-access', {
      mode: 'blocklist',
      list: ['gpt-4o'],
      defaultModel: '',
    });

    // 200 is honest: the new policy IS live and visible. It is not an ordinary
    // success, so the body must carry the unconfirmed-durability warning.
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.applied, true);
    assert.equal(body.changed, true);
    assert.equal(body.durability, 'unconfirmed');
    assert.deepEqual(body.warnings, ['ERR_MODEL_ACCESS_DURABILITY_UNCONFIRMED']);

    const expected = { mode: 'blocklist', list: ['gpt-4o'], defaultModel: '' };
    assert.notDeepEqual(getModelAccessConfig(), before);
    assert.deepEqual(getModelAccessConfig(), expected, 'memory must not roll back a published rename');
    assert.deepEqual(readStore(), expected, 'memory and disk must agree');
    assert.equal(renames.renames, 1, 'a published rename must never be replayed');
    assert.equal(isModelAllowed('gpt-4o').allowed, false, 'the published policy is enforced');
  });

  it('POST add and remove each ride one atomic write and return the server snapshot', async () => {
    const writes = countWrites();

    const added = await call('POST', '/model-access/add', { model: 'gpt-4o' });
    assert.equal(added.statusCode, 200, added.body);
    assert.equal(added.json().success, true);
    assert.equal(added.json().changed, true);
    assert.deepEqual(added.json().config.list, ['gpt-4o']);
    assert.equal(writes.writes, 1);

    const removed = await call('POST', '/model-access/remove', { model: 'gpt-4o' });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(removed.json().changed, true);
    assert.deepEqual(removed.json().config.list, []);
    assert.equal(writes.writes, 2);
    assert.deepEqual(readStore().list, []);

    const missing = await call('POST', '/model-access/add', {});
    assert.equal(missing.statusCode, 400, missing.body);
    assert.equal(missing.json().success, false);
    assert.equal(writes.writes, 2, 'a rejected request must not reach the writer');
  });

  it('repeating an accepted update is an idempotent no-op with no write', async () => {
    await call('POST', '/model-access/add', { model: 'gpt-4o' });
    const writes = countWrites();

    const repeatAdd = await call('POST', '/model-access/add', { model: 'gpt-4o' });
    assert.equal(repeatAdd.statusCode, 200, repeatAdd.body);
    assert.equal(repeatAdd.json().applied, true);
    assert.equal(repeatAdd.json().changed, false);
    assert.equal(repeatAdd.json().durability, 'unchanged');
    assert.deepEqual(repeatAdd.json().config.list, ['gpt-4o']);

    const repeatPut = await call('PUT', '/model-access', {
      mode: 'all',
      list: ['gpt-4o'],
      defaultModel: '',
    });
    assert.equal(repeatPut.statusCode, 200, repeatPut.body);
    assert.equal(repeatPut.json().changed, false);
    assert.equal(repeatPut.json().durability, 'unchanged');

    const removeAbsent = await call('POST', '/model-access/remove', { model: 'absent-model' });
    assert.equal(removeAbsent.statusCode, 200, removeAbsent.body);
    assert.equal(removeAbsent.json().changed, false);
    assert.deepEqual(removeAbsent.json().config.list, ['gpt-4o']);

    assert.equal(writes.writes, 0, 'no-op requests must not rewrite the file');
  });

  it('preserves the historical validation rules for mode, list and default', async () => {
    await call('POST', '/model-access/add', { model: 'gpt-4o' });
    const writes = countWrites();

    // An unknown mode was always ignored, not rejected.
    const badMode = await call('PUT', '/model-access', { mode: 'bogus' });
    assert.equal(badMode.statusCode, 200, badMode.body);
    assert.equal(badMode.json().changed, false);
    assert.equal(badMode.json().config.mode, 'all');
    assert.equal(writes.writes, 0);

    // A truthy non-array list still clears the list (setModelAccessList coercion).
    const badList = await call('PUT', '/model-access', { list: 'not-an-array' });
    assert.equal(badList.statusCode, 200, badList.body);
    assert.equal(badList.json().changed, true);
    assert.deepEqual(badList.json().config.list, []);
    assert.deepEqual(readStore().list, []);
    assert.equal(writes.writes, 1);

    // A non-string default still becomes the empty "reject" value.
    const badDefault = await call('PUT', '/model-access', { defaultModel: 42 });
    assert.equal(badDefault.statusCode, 200, badDefault.body);
    assert.equal(badDefault.json().changed, false);
    assert.equal(badDefault.json().config.defaultModel, '');
  });

  it('getters hand out copies that cannot mutate the accepted snapshot', () => {
    seed({ mode: 'allowlist', list: ['gpt-4o'], defaultModel: 'gpt-4o' });

    const snapshot = getModelAccessConfig();
    snapshot.mode = 'all';
    snapshot.list.push('evil-model');
    snapshot.defaultModel = '';

    assert.deepEqual(getModelAccessConfig(), {
      mode: 'allowlist',
      list: ['gpt-4o'],
      defaultModel: 'gpt-4o',
    });
    assert.equal(isModelAllowed('evil-model').allowed, false);
    assert.equal(getDefaultModel(), 'gpt-4o');
    assert.notEqual(getModelAccessConfig().list, getModelAccessConfig().list,
      'each read must return its own list');
  });
});
