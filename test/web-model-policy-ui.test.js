// Both dashboard skins must treat the model-access response as the source of
// truth. Before this contract each handler mutated local state before/without
// looking at the response, so a rejected PUT/POST still moved the radio, the
// chip list and showed a success toast. And a published-but-not-proven-
// durable update (rename succeeded, directory fsync failed) was rendered as an
// ordinary success.
//
// We execute the shipped dashboard script in a VM (same technique as
// test/dashboard-credential-save.test.js): real handlers, stubbed DOM/fetch.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const dashboardRoot = new URL('../src/dashboard/', import.meta.url);
const locales = Object.fromEntries(['en', 'zh-CN'].map(locale => [
  locale,
  JSON.parse(readFileSync(new URL(`i18n/${locale}.json`, dashboardRoot), 'utf8')),
]));

function element(id = '') {
  const node = {
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
  return node;
}

// Values produced by the VM realm have that realm's prototypes, so strict
// deepEqual would reject structurally identical objects.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function lastToast(stack) {
  const toast = stack.children.at(-1);
  assert.ok(toast, 'a model-access operation must show feedback');
  const text = toast.textContent || toast.innerHTML.replace(/<[^>]*>/g, '');
  return { node: toast, text };
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
  const requests = [];
  let nextResponse = () => { throw new Error('no response fixture'); };
  const radio = element('model-mode');

  const browser = {
    addEventListener() {},
    document: {
      documentElement: element('html'),
      addEventListener() {},
      removeEventListener() {},
      createElement: () => element(),
      getElementById: node,
      querySelector: () => radio,
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
    async fetch(url, opts) {
      if (String(url).startsWith('/dashboard/i18n/')) {
        const code = String(url).split('/').pop().replace('.json', '');
        return Response.json(locales[code]);
      }
      requests.push({
        url: String(url),
        method: opts.method,
        body: opts.body ? JSON.parse(opts.body) : undefined,
      });
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
    I18n,
    nodes,
    node,
    requests,
    radio,
    toastStack: node('toast-stack'),
    setResponse(response) { nextResponse = response; },
  };
}

const FAILURE = {
  success: false,
  applied: false,
  changed: true,
  durability: 'not-applied',
  error: 'ERR_MODEL_ACCESS_PERSIST_FAILED',
  config: { mode: 'all', list: ['gpt-4o'], defaultModel: '' },
};
const DURABLE = {
  success: true,
  applied: true,
  changed: true,
  durability: 'durable',
  config: { mode: 'blocklist', list: ['gpt-4o'], defaultModel: '' },
};
const UNCONFIRMED = {
  success: true,
  applied: true,
  changed: true,
  durability: 'unconfirmed',
  warnings: ['ERR_MODEL_ACCESS_DURABILITY_UNCONFIRMED'],
  config: { mode: 'blocklist', list: ['gpt-4o'], defaultModel: '' },
};

for (const [skin, file] of [['Modern', 'index.html'], ['Sketch', 'index-sketch.html']]) {
  test(`${skin}: a durable update applies the server snapshot and only then claims success`, async () => {
    const page = await dashboard(file, 'en', () => 0);
    page.App.modelAccessConfig = { mode: 'all', list: ['stale-model'], defaultModel: '' };
    page.setResponse(() => Response.json(DURABLE));

    await page.App.setModelMode('blocklist');

    assert.deepEqual(plain(page.App.modelAccessConfig), DURABLE.config,
      'the accepted policy must come from the server response');
    assert.equal(page.radio.checked, true);
    assert.deepEqual(page.requests, [{
      url: '/dashboard/api/model-access',
      method: 'PUT',
      body: { mode: 'blocklist' },
    }]);
    const toast = lastToast(page.toastStack);
    assert.equal(toast.node.className, 'toast success');
    assert.match(toast.text, /mode updated/i);
  });

  test(`${skin}: a rejected PUT keeps the old policy and never shows success`, async () => {
    const page = await dashboard(file, 'en', () => 0);
    page.App.modelAccessConfig = { mode: 'all', list: ['gpt-4o'], defaultModel: '' };
    page.setResponse(() => Response.json(FAILURE, { status: 500 }));

    await page.App.setModelMode('blocklist');

    assert.deepEqual(plain(page.App.modelAccessConfig), FAILURE.config,
      'the still-active server policy replaces the optimistic request');
    assert.equal(page.App.modelAccessConfig.mode, 'all');
    const toast = lastToast(page.toastStack);
    assert.equal(toast.node.className, 'toast error');
    assert.match(toast.text, /ERR_MODEL_ACCESS_PERSIST_FAILED/);
    assert.doesNotMatch(toast.text, /mode updated/i);
  });

  for (const locale of ['en', 'zh-CN']) {
    test(`${skin} ${locale}: an unconfirmed publication is not rendered as plain success`, async () => {
      const page = await dashboard(file, locale, () => 0);
      page.App.modelAccessConfig = { mode: 'all', list: [], defaultModel: '' };
      page.setResponse(() => Response.json(UNCONFIRMED));

      await page.App.setModelMode('blocklist');

      assert.deepEqual(plain(page.App.modelAccessConfig), UNCONFIRMED.config);
      const toast = lastToast(page.toastStack);
      assert.equal(toast.node.className, 'toast error');
      assert.match(toast.text, locale === 'en' ? /could not be confirmed/i : /尚未确认已安全写入磁盘/);
      assert.doesNotMatch(toast.text, /mode updated/i);
    });
  }

  test(`${skin}: the requested remove/add path follows the accepted local list`, async () => {
    const page = await dashboard(file, 'en', () => 0);
    page.App.modelAccessConfig = { mode: 'allowlist', list: ['gpt-4o'], defaultModel: '' };
    const without = { success: true, applied: true, changed: true, durability: 'durable', config: { mode: 'allowlist', list: [], defaultModel: '' } };
    page.setResponse(() => Response.json(without));

    await page.App.toggleModelInList('gpt-4o');
    assert.deepEqual(page.requests.at(-1), {
      url: '/dashboard/api/model-access/remove',
      method: 'POST',
      body: { model: 'gpt-4o' },
    });
    assert.deepEqual(plain(page.App.modelAccessConfig.list), []);

    const withModel = { success: true, applied: true, changed: true, durability: 'durable', config: { mode: 'allowlist', list: ['gpt-4o'], defaultModel: '' } };
    page.setResponse(() => Response.json(withModel));

    await page.App.toggleModelInList('gpt-4o');
    assert.deepEqual(page.requests.at(-1), {
      url: '/dashboard/api/model-access/add',
      method: 'POST',
      body: { model: 'gpt-4o' },
    });
    assert.deepEqual(plain(page.App.modelAccessConfig.list), ['gpt-4o']);
  });

  test(`${skin}: a transport failure leaves state untouched and reports the failure`, async () => {
    const page = await dashboard(file, 'en', () => 0);
    page.requests.length = 0;
    page.App.modelAccessConfig = { mode: 'allowlist', list: ['gpt-4o'], defaultModel: '' };
    page.setResponse(() => { throw new Error('fixture network down'); });

    await page.App.removeModelFromList('gpt-4o');

    assert.deepEqual(plain(page.App.modelAccessConfig), { mode: 'allowlist', list: ['gpt-4o'], defaultModel: '' });
    const toast = lastToast(page.toastStack);
    assert.equal(toast.node.className, 'toast error');
  });
}
