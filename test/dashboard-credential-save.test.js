import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createContext, runInContext } from 'node:vm';

const dashboardRoot = new URL('../src/dashboard/', import.meta.url);
const credentialsUrl = '/dashboard/api/settings/credentials';
const previousPassword = 'previous fixture password';
const inputValue = 'new fixture value';
const inputIds = {
  apiKey: 'credentials-apikey-input',
  dashboardPassword: 'credentials-dashboardpw-input',
};
const locales = Object.fromEntries(['en', 'zh-CN'].map(locale => [
  locale,
  JSON.parse(readFileSync(new URL(`i18n/${locale}.json`, dashboardRoot), 'utf8')),
]));

function element() {
  const buttons = { '[data-act=ok]': { focus() {} }, '[data-act=cancel]': {} };
  return {
    children: [],
    style: {},
    dataset: {},
    get classList() { return { contains: value => (this.className || '').split(/\s+/).includes(value) }; },
    addEventListener() {},
    appendChild(child) { this.children.push(child); },
    querySelector(selector) { return buttons[selector] ?? null; },
    remove() {},
  };
}

async function dashboard(html, locale, saveResult) {
  const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map(([, source]) => source)
    .find(source => source.includes('const I18n =') && source.includes('const App ='));
  assert.ok(script, 'the shipped dashboard script must be present');
  const storage = new Map([['dp', previousPassword]]);
  const nodes = Object.fromEntries([
    ...Object.values(inputIds),
    'credentials-apikey-source', 'credentials-apikey-masked',
    'credentials-dashboardpw-source', 'credentials-dashboardpw-status',
    'modal-container', 'toast-stack',
  ].map(id => [id, element()]));
  const requests = [];
  const timers = [];
  const clearedIntervals = [];
  let reloads = 0;
  const browser = {
    addEventListener() {},
    confirm: () => true,
    document: {
      addEventListener() {},
      removeEventListener() {},
      createElement: element,
      getElementById: id => nodes[id] ?? null,
      querySelectorAll: () => [],
      documentElement: {},
    },
    localStorage: {
      getItem: name => storage.get(name) ?? null,
      setItem: (name, value) => storage.set(name, value),
      removeItem: name => storage.delete(name),
    },
    location: { reload() { reloads++; } },
    setTimeout(callback, delay) { timers.push({ callback, delay }); },
    clearInterval(id) { clearedIntervals.push(id); },
    async fetch(url, opts) {
      if (url === `/dashboard/i18n/${locale}.json`) return Response.json(locales[locale]);
      assert.equal(url, credentialsUrl);
      requests.push({
        method: opts.method,
        password: opts.headers['X-Dashboard-Password'],
        body: opts.body && JSON.parse(opts.body),
      });
      if (opts.method === 'PUT') return saveResult();
      assert.equal(opts.method, 'GET');
      return Response.json({ apiKeySource: 'runtime', apiKey_masked: 'masked fixture value' });
    },
  };
  browser.window = browser;
  const context = createContext(browser);
  const { App, I18n } = runInContext(`${script}\n({ App, I18n })`, context);
  await I18n.setLocale(locale);
  App.pollers.settings = 1;

  return {
    App, nodes, storage, requests, timers, clearedIntervals,
    reloads: () => reloads,
    async save(field) {
      const handler = `App.saveCredential('${field}')`;
      assert.ok(html.includes(`onclick="${handler}"`), 'the save button must call the handler');
      nodes[inputIds[field]].value = inputValue;
      const saving = runInContext(handler, context);
      nodes['modal-container'].children.at(-1)?.querySelector('[data-act=ok]').onclick();
      await saving;
      await setImmediate(); // Allow the post-save credential status refresh to render.
      const toast = nodes['toast-stack'].children.at(-1);
      assert.ok(toast, 'the save must show feedback');
      return {
        node: toast,
        text: toast.textContent ?? /<span>([^<]*)<\/span>$/.exec(toast.innerHTML)?.[1],
      };
    },
  };
}

const applied = { applied: true, success: true, durability: 'durable', protection: 'applied' };
const bothWarnings = { ...applied, durability: 'unconfirmed', protection: 'failed' };
const protectionWarning = { ...applied, warnings: ['ERR_CREDENTIAL_PROTECTION_FAILED'] };
const failure = { applied: false, error: 'fixture save rejected' };

const cases = [
  { name: 'password with both warnings', field: 'dashboardPassword', result: bothWarnings,
    messages: ['credentialsAppliedDurabilityWarning', 'credentialsAppliedProtectionWarning'], reloadDelay: 8000 },
  { name: 'key with a protection warning', field: 'apiKey', result: protectionWarning,
    messages: ['credentialsAppliedProtectionWarning'] },
  { name: 'key with an unrecognized warning', field: 'apiKey', result: { ...applied, warnings: ['fixture warning'] },
    messages: ['credentialsAppliedWarning'] },
  { name: 'ordinary password save', field: 'dashboardPassword', result: applied,
    messages: ['saved'], reloadDelay: 800 },
  { name: 'ordinary key save from a legacy server', field: 'apiKey', result: { success: true, apiKeyUpdated: true },
    messages: ['saved'] },
  { name: 'rejected password save', field: 'dashboardPassword', result: failure,
    messages: ['saveFailed'], status: 500, error: failure.error },
  { name: 'network error on a password save', field: 'dashboardPassword',
    messages: ['saveFailed'], error: 'fixture network error' },
];

for (const [skin, file] of [['Modern', 'index.html'], ['Sketch', 'index-sketch.html']]) {
  const html = readFileSync(new URL(file, dashboardRoot), 'utf8');
  for (const [locale, bundle] of Object.entries(locales)) {
    for (const { name, field, result, messages, reloadDelay, status = 200, error } of cases) {
      test(`${skin} ${locale}: ${name}`, async () => {
        const page = await dashboard(html, locale, () => {
          if (!result) throw new Error(error);
          return Response.json(result, { status });
        });
        const toast = await page.save(field);
        if (skin === 'Modern') assert.equal(page.nodes['toast-stack'].children.length, 1);
        const presented = skin === 'Modern' && messages.length === 2
          ? ['credentialsAppliedBothWarnings'] : messages;
        const expectedText = presented.map(key => bundle.toast[key].replace('{{error}}', error ?? '')).join(' ');
        assert.equal(toast.text, expectedText);
        assert.equal(toast.node.className, messages[0] === 'saved' ? 'toast success' : 'toast error');
        assert.equal(page.nodes[inputIds[field]].value, error ? inputValue : '');
        const expectedRequests = [{ method: 'PUT', password: previousPassword, body: { [field]: inputValue } }];
        if (!error && field === 'apiKey') {
          expectedRequests.push({ method: 'GET', password: previousPassword, body: undefined });
          assert.equal(page.nodes['credentials-apikey-masked'].textContent, 'masked fixture value');
        }
        assert.deepEqual(page.requests, expectedRequests);
        assert.equal(page.App.password, reloadDelay ? null : previousPassword);
        assert.equal(page.storage.get('dp'), reloadDelay ? undefined : previousPassword);
        assert.deepEqual(page.clearedIntervals, reloadDelay ? [1] : []);
        assert.equal(page.reloads(), 0);
        const timers = page.timers.slice();
        for (const { callback, delay } of timers) {
          if (!reloadDelay || delay < reloadDelay) callback();
        }
        assert.equal(page.reloads(), 0, 'the page must not reload early');
        if (reloadDelay === 8000) {
          assert.equal(toast.node.style.opacity, undefined, 'the warning must remain visible before re-login');
        }
        for (const { callback, delay } of timers) {
          if (delay === reloadDelay) callback();
        }
        assert.equal(page.reloads(), reloadDelay ? 1 : 0);
      });
    }
  }
}
