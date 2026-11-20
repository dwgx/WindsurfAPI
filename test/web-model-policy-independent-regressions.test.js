// Regressions pinned to independent-review counterexamples on the model-access
// transaction. Each case below failed on b240a29b:
//   - a throwing diagnostic turned a published rename into a rolled-back memory
//     state, and turned a pre-publication failure into a thrown route;
//   - nested objects inside the historical list aliased live state through both
//     the getter result and the original request body;
//   - both skins rendered an empty 200 body as success and left the radio moved
//     by a real click, and installed a self-contradictory receipt.
//
// Fresh temp storage comes from test/setup-env.mjs; no real config is touched.

import assert from 'node:assert/strict';
import { readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

import { config, log } from '../src/config.js';
import { configureBindHost } from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { writeJsonAtomic } from '../src/fs-atomic.js';
import * as policy from '../src/dashboard/model-access.js';

const ACCESS_FILE = join(config.dataDir, 'model-access.json');
const old = { mode: 'all', list: ['old-id'], defaultModel: '' };
const next = { mode: 'blocklist', list: ['new-id'], defaultModel: 'fallback-id' };

const ORIGINAL_DASHBOARD_PASSWORD = config.dashboardPassword;
const ORIGINAL_API_KEY = config.apiKey;
const ORIGINAL_ALLOW_NO_AUTH = process.env.DASHBOARD_ALLOW_NO_AUTH;

function fakeRes() {
  return {
    status: 0,
    text: '',
    writeHead(status) { this.status = status; },
    end(chunk) { this.text += chunk ? String(chunk) : ''; },
    json() { return this.text ? JSON.parse(this.text) : {}; },
  };
}

async function put(body) {
  const res = fakeRes();
  await handleDashboardApi('PUT', '/model-access', body, {
    url: '/dashboard/api/model-access',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  }, res);
  return res;
}

const onDisk = () => JSON.parse(readFileSync(ACCESS_FILE, 'utf8'));

describe('model access diagnostics and ownership', () => {
  beforeEach(() => {
    config.dashboardPassword = '';
    config.apiKey = '';
    process.env.DASHBOARD_ALLOW_NO_AUTH = '1';
    configureBindHost('127.0.0.1');
    policy.__setModelAccessFsHooksForTests(null);
    policy.__setModelAccessPersistFailureForTests(null);
    policy.updateModelAccess(old);
  });

  afterEach(() => {
    policy.__setModelAccessFsHooksForTests(null);
    policy.__setModelAccessPersistFailureForTests(null);
    config.dashboardPassword = ORIGINAL_DASHBOARD_PASSWORD;
    config.apiKey = ORIGINAL_API_KEY;
    if (ORIGINAL_ALLOW_NO_AUTH === undefined) delete process.env.DASHBOARD_ALLOW_NO_AUTH;
    else process.env.DASHBOARD_ALLOW_NO_AUTH = ORIGINAL_ALLOW_NO_AUTH;
    configureBindHost('0.0.0.0');
  });

  it('a throwing log.error cannot roll back a rename that was published', async () => {
    let writes = 0;
    policy.__setModelAccessFsHooksForTests({
      writeJsonAtomic(file, value) {
        writes += 1;
        return writeJsonAtomic(file, value, {
          rename: renameSync,
          fsyncParent() { throw new Error('fixture fsync'); },
        });
      },
    });
    const originalError = log.error;
    log.error = () => { throw new Error('fixture logger error'); };
    let res;
    try {
      res = await put(next);
    } finally {
      log.error = originalError;
    }

    assert.equal(writes, 1);
    assert.equal(res.status, 200, res.text);
    const body = res.json();
    assert.equal(body.applied, true);
    assert.equal(body.durability, 'unconfirmed');
    assert.deepEqual(body.config, next);
    assert.deepEqual(policy.getModelAccessConfig(), next, 'memory must follow the published file');
    assert.deepEqual(onDisk(), next);
  });

  it('throwing log.error and log.warn cannot suppress the pre-publication failure envelope', async () => {
    let writes = 0;
    policy.__setModelAccessFsHooksForTests({
      writeJsonAtomic() {
        writes += 1;
        throw new Error('fixture rename');
      },
    });
    const originalError = log.error;
    const originalWarn = log.warn;
    log.error = () => { throw new Error('fixture logger error'); };
    log.warn = () => { throw new Error('fixture logger warn'); };
    let res;
    try {
      res = await put(next);
    } finally {
      log.error = originalError;
      log.warn = originalWarn;
    }

    assert.equal(writes, 1, 'one persistence attempt per operation');
    assert.equal(res.status, 500, res.text);
    const body = res.json();
    assert.equal(body.success, false);
    assert.equal(body.applied, false);
    assert.equal(body.durability, 'not-applied');
    assert.equal(body.error, 'ERR_MODEL_ACCESS_PERSIST_FAILED');
    assert.deepEqual(body.config, old, 'the response reports the still-active policy');
    assert.deepEqual(policy.getModelAccessConfig(), old);
    assert.deepEqual(onDisk(), old);
  });

  it('nested list objects stay owned by the accepted snapshot', async () => {
    const incoming = { nested: { tag: 'seed' } };
    const res = await put({ list: [incoming] });
    assert.equal(res.status, 200, res.text);

    const snapshot = policy.getModelAccessConfig();
    snapshot.list[0].nested.tag = 'via-getter';
    incoming.nested.tag = 'via-input';

    assert.equal(policy.getModelAccessConfig().list[0].nested.tag, 'seed');
    assert.notEqual(policy.getModelAccessConfig().list[0], incoming);
    assert.equal(onDisk().list[0].nested.tag, 'seed');
  });
});

// ── Dashboard skins ─────────────────────────────────────────
// Execute the shipped dashboard script in a VM (same technique as the probe):
// real handlers, stubbed DOM/fetch, and a radio that behaves like a real click
// (the control changes BEFORE onchange runs).

const dashboardRoot = new URL('../src/dashboard/', import.meta.url);
const locales = Object.fromEntries(['en', 'zh-CN'].map(locale => [
  locale,
  JSON.parse(readFileSync(new URL(`i18n/${locale}.json`, dashboardRoot), 'utf8')),
]));

function element(id = '') {
  return {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    className: '',
    title: '',
    placeholder: '',
    checked: false,
    dataset: {},
    style: {},
    children: [],
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(child) { this.children.push(child); return child; },
    remove() {},
    addEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return null; },
  };
}

// Values produced by the VM realm have that realm's prototypes, so strict
// deepEqual would reject structurally identical objects.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function lastToast(stack) {
  const toast = stack.children.at(-1);
  assert.ok(toast, 'a model-access operation must show feedback');
  return { node: toast, text: toast.textContent || toast.innerHTML.replace(/<[^>]*>/g, '') };
}

async function dashboard(file, locale) {
  const html = readFileSync(new URL(file, dashboardRoot), 'utf8');
  const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map(([, source]) => source)
    .find(source => source.includes('const I18n =') && source.includes('const App ='));
  assert.ok(script, `the shipped dashboard script must be present in ${file}`);

  const nodes = {};
  const node = id => (nodes[id] ||= element(id));
  const storage = new Map([['dp', 'fixture-password'], ['lang', locale === 'zh-CN' ? 'zh' : 'en']]);
  let nextResponse = () => { throw new Error('no response fixture'); };
  let selectedMode = 'all';
  const getRadio = selector => {
    const mode = /value="([^"]+)"/.exec(selector)?.[1];
    if (!mode) return null;
    return {
      get checked() { return selectedMode === mode; },
      set checked(value) { if (value) selectedMode = mode; },
    };
  };

  const browser = {
    addEventListener() {},
    document: {
      documentElement: element('html'),
      addEventListener() {},
      removeEventListener() {},
      createElement: () => element(),
      getElementById: node,
      querySelector: getRadio,
      querySelectorAll: () => [],
    },
    localStorage: {
      getItem: name => storage.get(name) ?? null,
      setItem: (name, value) => storage.set(name, value),
      removeItem: name => storage.delete(name),
    },
    location: { reload() {} },
    setTimeout() {},
    clearInterval() {},
    async fetch(url) {
      if (String(url).startsWith('/dashboard/i18n/')) {
        const code = String(url).split('/').pop().replace('.json', '');
        return Response.json(locales[code]);
      }
      return nextResponse();
    },
  };
  browser.window = browser;
  const context = createContext(browser);
  const { App, I18n } = runInContext(`${script}\n({ App, I18n })`, context);
  await I18n.setLocale(locale);
  App.allModels = [];

  return {
    App,
    node,
    toastStack: node('toast-stack'),
    selectedMode() { return selectedMode; },
    simulateSelection(mode) { selectedMode = mode; },
    setResponse(response) { nextResponse = response; },
  };
}

const accepted = { mode: 'all', list: ['accepted-id'], defaultModel: 'accepted-default' };

function start(page) {
  page.App.modelAccessConfig = { ...accepted, list: [...accepted.list] };
  page.App.allModels = [];
  page.simulateSelection('blocklist');
  page.node('model-default').value = 'edited-default';
}

for (const [skin, file] of [['Modern', 'index.html'], ['Sketch', 'index-sketch.html']]) {
  for (const [reason, malformedConfig] of [
    ['missing default model', { mode: 'blocklist', list: [] }],
    ['unknown mode', { mode: 'unexpected', list: [], defaultModel: '' }],
    ['non-string default model', { mode: 'blocklist', list: [], defaultModel: null }],
  ]) {
    test(`${skin}: an acknowledged mutation rejects a snapshot with ${reason}`, async () => {
      const page = await dashboard(file, 'en');
      start(page);
      page.setResponse(() => Response.json({
        success: true, applied: true, durability: 'durable', config: malformedConfig,
      }));
      await page.App.setModelMode('blocklist');
      assert.deepEqual(plain(page.App.modelAccessConfig), accepted);
      assert.equal(page.selectedMode(), 'all');
      if (skin === 'Modern') assert.equal(page.node('model-default').value, accepted.defaultModel);
      assert.notEqual(lastToast(page.toastStack).node.className, 'toast success');
    });
  }

  test(`${skin}: an empty 200 body is not success and does not move the controls`, async () => {
    const page = await dashboard(file, 'en');
    start(page);
    page.setResponse(() => new Response(''));

    await page.App.setModelMode('blocklist');

    assert.deepEqual(plain(page.App.modelAccessConfig), accepted);
    assert.equal(page.selectedMode(), 'all', 'the click must be undone');
    assert.notEqual(lastToast(page.toastStack).node.className, 'toast success');
  });

  test(`${skin}: a transport failure restores the radio from the last accepted policy`, async () => {
    const page = await dashboard(file, 'en');
    start(page);
    page.setResponse(() => { throw new Error('offline fixture'); });

    await page.App.setModelMode('blocklist');

    assert.equal(page.selectedMode(), 'all');
    assert.equal(page.App.modelAccessConfig.mode, 'all');
    assert.notEqual(lastToast(page.toastStack).node.className, 'toast success');
  });

  test(`${skin}: a contradictory receipt cannot install its config`, async () => {
    const page = await dashboard(file, 'en');
    start(page);
    page.setResponse(() => Response.json({ success: true, applied: false, durability: 'durable', config: next }));

    await page.App.setModelMode('blocklist');

    assert.equal(page.App.modelAccessConfig.mode, 'all');
    assert.equal(page.selectedMode(), 'all');
    assert.notEqual(lastToast(page.toastStack).node.className, 'toast success');
  });

  test(`${skin}: a coherent rejection applies the server's unchanged snapshot`, async () => {
    const page = await dashboard(file, 'en');
    start(page);
    const rejection = {
      success: false,
      applied: false,
      changed: true,
      durability: 'not-applied',
      error: 'ERR_MODEL_ACCESS_PERSIST_FAILED',
      config: { mode: 'allowlist', list: ['server-id'], defaultModel: '' },
    };
    page.setResponse(() => Response.json(rejection, { status: 500 }));

    await page.App.setModelMode('blocklist');

    assert.deepEqual(plain(page.App.modelAccessConfig), rejection.config);
    assert.equal(page.selectedMode(), 'allowlist', 'controls follow the authoritative snapshot');
    assert.match(lastToast(page.toastStack).text, /ERR_MODEL_ACCESS_PERSIST_FAILED/);
  });
}

test('Modern: a failed default-model edit restores the accepted input value', async () => {
  const page = await dashboard('index.html', 'en');
  start(page);
  page.setResponse(() => { throw new Error('offline fixture'); });

  await page.App.setDefaultModel('edited-default');

  assert.equal(page.node('model-default').value, 'accepted-default');
  assert.equal(page.App.modelAccessConfig.defaultModel, 'accepted-default');
  assert.notEqual(lastToast(page.toastStack).node.className, 'toast success');
});
