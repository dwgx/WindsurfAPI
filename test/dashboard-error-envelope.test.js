// #257 close-out: a failed dashboard request must be distinguishable from a
// payload that merely lacks a field — on the wire AND in the panel.
//
// Before this file, `success === false` was an unreachable branch for every
// HTTP error: 53 non-2xx `json()` envelopes in src/dashboard/api.js carried no
// `success` key, and src/dashboard/index.html's `_apiRaw` handed the raw error
// body to the loaders. The loaders that did check `success === false` never
// fired on a 404/500, so they painted an empty panel over the last good state.
//
// Four layers are pinned here, each of which fails if the corresponding fix is
// reverted:
//   1. `json()` stamps `success:false` on non-2xx envelopes only — 2xx bodies
//      keep their exact shape.
//   2. The same property end-to-end through `handleDashboardApi` on real routes.
//   3. Both skins' fetch wrappers force `success:false` on a non-2xx response,
//      including a non-JSON error body.
//   4. The shipped loaders, run for real against a failing `api()`, must leave
//      the DOM/state they own untouched — and must still render a successful
//      payload, so a loader that "passes" by doing nothing cannot hide here.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { config } from '../src/config.js';
import { configureBindHost, _resetLockoutForTests } from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const API_SRC = read('src/dashboard/api.js');
const MAIN_HTML = read('src/dashboard/index.html');
const SKETCH_HTML = read('src/dashboard/index-sketch.html');

const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;
const originalAllowNoAuth = process.env.DASHBOARD_ALLOW_NO_AUTH;

afterEach(() => {
  _resetRuntimeConfigForTests();
  _resetLockoutForTests();
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
  if (originalAllowNoAuth === undefined) delete process.env.DASHBOARD_ALLOW_NO_AUTH;
  else process.env.DASHBOARD_ALLOW_NO_AUTH = originalAllowNoAuth;
  configureBindHost('0.0.0.0');
});

const FAILED = { success: false, error: 'Dashboard API: GET /x not found' };

// ── source extraction ───────────────────────────────────────────────────────
// Pull a method body out of a dashboard source file so the SHIPPED code runs.
// Brace/quote aware: template literals and comments inside these bodies contain
// braces of their own, and a naive counter stops in the wrong place.
function extractMethod(src, signature) {
  const at = src.indexOf(`\n  ${signature}`);
  assert.notEqual(at, -1, `missing \`${signature}\` in the dashboard source`);
  const open = src.indexOf('{', at + signature.length - 1);
  assert.notEqual(open, -1, `no body for ${signature}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i); if (i < 0) break; i += 1; continue; }
    if (c === "'" || c === '"') {
      i += 1;
      while (i < src.length && src[i] !== c) { if (src[i] === '\\') i += 1; i += 1; }
      continue;
    }
    if (c === '`') {
      i += 1;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          // Balanced `${ … }` inside a template is a nested expression.
          let d = 0;
          i += 1;
          while (i < src.length) {
            if (src[i] === '{') d += 1;
            else if (src[i] === '}') { d -= 1; if (d === 0) { i += 1; break; } }
            i += 1;
          }
          continue;
        }
        i += 1;
      }
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`could not delimit the body of ${signature}`);
}

function extractTopLevelFunction(src, signature) {
  const at = src.indexOf(`function ${signature}(`);
  assert.notEqual(at, -1, `missing \`function ${signature}(\` in api.js`);
  const open = src.indexOf('{', at + signature.length);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`could not delimit function ${signature}`);
}

const I18nStub = { t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) };
const localStorageStub = { getItem: () => null, setItem() {}, removeItem() {} };

function instantiate(src, signature, doc) {
  const body = extractMethod(src, signature);
  const stripped = signature.replace(/^async\s+/, '');
  const name = stripped.slice(0, stripped.indexOf('('));
  const asyncKw = /^async\s/.test(signature) ? 'async ' : '';
  // eslint-disable-next-line no-new-func -- executing the shipped source is the point
  return new Function('document', 'I18n', 'localStorage', `return ${asyncKw}function ${name}() ${body};`)(
    doc, I18nStub, localStorageStub,
  );
}

// ── DOM / App stubs ─────────────────────────────────────────────────────────
function makeEl(id) {
  const target = {
    id,
    __writes: [],
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => true },
    appendChild() {},
    click() {},
    remove() {},
  };
  return new Proxy(target, {
    set(t, key, value) {
      if (key !== '__writes') t.__writes.push(String(key));
      t[key] = value;
      return true;
    },
  });
}

function makeDom(existingIds = null) {
  const els = new Map();
  const getElementById = (id) => {
    if (existingIds && !existingIds.includes(id)) return null;
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  return {
    els,
    el: getElementById,
    doc: {
      cookie: '',
      getElementById,
      querySelector: () => makeEl('query'),
      createElement: (tag) => makeEl(tag),
      body: { appendChild() {} },
    },
  };
}

function appStub(apiResult, extra = {}) {
  const self = {
    api: async () => apiResult,
    toasts: [],
    toast(message, type) { self.toasts.push([message, type]); },
    esc: (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => c),
    escJsAttr: (s) => String(s === null || s === undefined ? '' : s),
    escAttr: (s) => String(s === null || s === undefined ? '' : s),
    systemPromptDomId: (k) => `sp-${encodeURIComponent(String(k)).replace(/%/g, '_')}`,
    _helpTip: () => '',
    metric: () => '',
    _animateNumber: () => {},
    enhanceControls: () => {},
    accountsListUrl: () => '/accounts',
    _dropStaleSelection: () => false,
    renderTablePagination: () => {},
    downloadAccountsJson: () => {},
    poll: () => {},
    ...extra,
  };
  return self;
}

async function runLoader(src, signature, self, dom) {
  const fn = instantiate(src, signature, dom.doc);
  return fn.call(self);
}

// ── 1. json() stamps non-2xx envelopes only ─────────────────────────────────
describe('#257 the dashboard json() helper stamps every non-2xx envelope', () => {
  function runJson(status, body) {
    const jsonFn = new Function(`return (${extractTopLevelFunction(API_SRC, 'json')});`)();
    let sent = null;
    const res = { _dashboardCorsOrigin: '', writeHead() {}, end(chunk) { sent = chunk; } };
    jsonFn(res, status, body);
    return sent === null ? undefined : JSON.parse(sent);
  }

  it('adds success:false for every error status class the dashboard uses', () => {
    for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) {
      const out = runJson(status, { error: 'ERR_X' });
      assert.equal(out.success, false, `status ${status} must carry success:false`);
      assert.equal(out.error, 'ERR_X', `status ${status} must keep the original error field`);
    }
  });

  it('leaves 2xx bodies byte-identical — including bodies with no success key', () => {
    assert.deepEqual(runJson(200, { flags: { nativeToolCall: true } }), { flags: { nativeToolCall: true } });
    assert.deepEqual(runJson(200, { success: true, cleaned: 2 }), { success: true, cleaned: 2 });
    assert.equal(runJson(204, ''), '');
    // A non-2xx body that already declares success keeps its own value.
    assert.deepEqual(runJson(409, { success: true, odd: 1 }), { success: true, odd: 1 });
  });

  it('never turns a non-object body into an envelope', () => {
    assert.equal(runJson(500, 'boom'), 'boom');
    assert.deepEqual(runJson(500, [1, 2]), [1, 2]);
    assert.equal(runJson(500, null), null);
  });
});

// ── 2. the property survives the real handler ───────────────────────────────
describe('#257 real dashboard error routes answer with success:false', () => {
  function fakeRes() {
    return {
      statusCode: 0,
      body: '',
      writeHead(status) { this.statusCode = status; },
      end(chunk) { this.body += chunk ? String(chunk) : ''; },
      json() { return this.body ? JSON.parse(this.body) : null; },
    };
  }
  const localReq = (path, headers = {}) => ({
    url: `/dashboard/api${path}`, headers, socket: { remoteAddress: '127.0.0.1' },
  });

  const authed = { 'x-dashboard-password': 'dash-secret' };

  it('401 gate, 400 validation, 403 loopback-only and the 404 fallback all carry it', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');

    const cases = [
      ['401', 'GET', '/cache', {}, {}],
      ['400', 'POST', '/accounts', {}, authed],
      ['403', 'GET', '/accounts/import-local', {}, authed],
      ['404', 'GET', '/definitely-not-a-dashboard-route', {}, authed],
    ];
    for (const [label, method, path, body, headers] of cases) {
      const res = fakeRes();
      await handleDashboardApi(method, path, body, localReq(path, headers), res);
      assert.equal(res.statusCode, Number(label), `${method} ${path} should answer ${label}`);
      const payload = res.json();
      assert.equal(payload.success, false, `${method} ${path} (${label}) must carry success:false`);
      assert.ok(payload.error, `${method} ${path} (${label}) must keep its error field`);
    }
  });

  it('a 200 route that never had a success key still does not gain one', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');

    const res = fakeRes();
    await handleDashboardApi('GET', '/experimental', {}, localReq('/experimental', authed), res);
    assert.equal(res.statusCode, 200);
    const payload = res.json();
    assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'success'),
      '2xx bodies must not be reshaped by the error-envelope fix');
    assert.ok(payload.flags && payload.tunables, 'and must still carry their real payload');
  });
});

// ── 3. both skins synthesize the envelope for non-2xx ───────────────────────
describe('#257 the client fetch wrappers force success:false on non-2xx', () => {
  function withFetch(status, body) {
    const r = {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    };
    return { fetch: async () => r };
  }

  async function runApiRaw(html, signature, fetchImpl, extraSelf = {}, options) {
    const body = extractMethod(html, signature);
    const stripped = signature.replace(/^async\s+/, '');
    const dom = makeDom(['login-overlay', 'login-password', 'login-btn']);
    // eslint-disable-next-line no-new-func -- executing the shipped source is the point
    const fn = new Function('document', 'I18n', 'localStorage', 'fetch',
      `return async function ${stripped} ${body};`)(dom.doc, I18nStub, localStorageStub, fetchImpl);
    // The shipped _apiRaw routes the toast text through translateError so an
    // unmapped ERR_* code never reaches the user; the stub keeps the raw text
    // so the assertions below still see the server's message.
    const self = { _authEpoch: 0, toasts: [], toast(m, t) { self.toasts.push([m, t]); }, password: null, translateError(code, fallback) { return code || fallback; }, ...extraSelf };
    return { out: await fn.call(self, 'GET', '/x', null, options), self };
  }

  const mainSignature = 'async _apiRaw(method, path, body, options)';
  it('hands an action-owned failure back to the caller without a second toast', async () => {
    const { out, self } = await runApiRaw(MAIN_HTML, mainSignature, withFetch(400, {
      error: 'ERR_EMAIL_CODE_REJECTED',
    }).fetch, {}, { notify: false });
    assert.equal(out.success, false);
    assert.equal(out.error, 'ERR_EMAIL_CODE_REJECTED');
    assert.deepEqual(self.toasts, []);
  });

  for (const [label, html, signature] of [
    ['index.html', MAIN_HTML, mainSignature],
    ['index-sketch.html', SKETCH_HTML, 'async api(method, path, body, options)'],
  ]) {
    it(`${label}: a 404 body gains success:false and keeps its error`, async () => {
      const { out } = await runApiRaw(html, signature, async () => ({
        status: 404, ok: false, json: async () => ({ error: 'Dashboard API: GET /x not found' }),
      }));
      assert.equal(out.success, false, `${label} must force success:false on a 404`);
      assert.equal(out.error, 'Dashboard API: GET /x not found', `${label} must keep the server error`);
    });

    it(`${label}: a non-JSON error body still yields an envelope`, async () => {
      const { out } = await runApiRaw(html, signature, async () => ({
        status: 500, ok: false, json: async () => { throw new Error('not json'); },
      }));
      assert.equal(out.success, false, `${label} must synthesize success:false when the body is unparseable`);
    });

    it(`${label}: a 200 body passes through untouched`, async () => {
      const { out } = await runApiRaw(html, signature, async () => ({
        status: 200, ok: true, json: async () => ({ flags: { nativeToolCall: true } }),
      }));
      assert.deepEqual(out, { flags: { nativeToolCall: true } }, `${label} must not reshape 2xx bodies`);
    });
  }
});

// ── 4. loaders keep the last good panel when the read fails ─────────────────
describe('#257 panel loaders keep the last good state on a failed read', () => {
  it('loadAccounts no longer repaints over a valid table on a failed read', async () => {
    let painted = 0;
    const stub = (result) => appStub(result, {
      loadDrought: () => {},
      renderAccountsSkeleton: () => {},
      setAccountsLoadStatus: () => {},
      renderAccountsPagination: () => {},
      renderAccountsKpis: () => {},
      renderAccountsFilterState: () => {},
      renderAccountsTable: () => { painted += 1; },
      applyAccountsSortState: () => {},
      applyAccountsDensity: () => {},
      startAccountsClock: () => {},
    });

    await runLoader(MAIN_HTML, 'async loadAccounts()', stub(FAILED), makeDom());
    assert.equal(painted, 0, 'a failed read must not paint an empty table over a valid pool');

    await runLoader(MAIN_HTML, 'async loadAccounts()', stub({ accounts: [], stats: {}, total: 0 }), makeDom());
    assert.equal(painted, 1, 'control: a successful read must still paint, or this test proves nothing');
  });

  it('loadModels keeps the previous catalog and mode on failure', async () => {
    const self = appStub(FAILED);
    self.allModels = ['LAST-MODEL'];
    self.modelAccessConfig = { mode: 'allowlist', list: ['m'], defaultModel: 'm' };

    const dom = makeDom([]);
    await runLoader(MAIN_HTML, 'async loadModels()', self, dom);
    assert.deepEqual(self.allModels, ['LAST-MODEL'], 'a failed read must not empty the model catalog');
    assert.equal(self.modelAccessConfig.mode, 'allowlist', 'and must not reset the access mode to "all"');
  });

  const cases = [
    {
      name: 'loadExperimental',
      signature: 'async loadExperimental()',
      existing: ['exp-cascade-reuse', 'exp-pool-cards', 'skin-select', 'exp-drought-threshold'],
      seed: (dom, self) => { dom.el('exp-pool-cards').innerHTML = 'LAST-GOOD'; dom.el('exp-cascade-reuse').checked = true; },
      read: (dom) => [dom.el('exp-pool-cards').innerHTML, dom.el('exp-cascade-reuse').checked],
      expect: ['LAST-GOOD', true],
      ok: { flags: { cascadeConversationReuse: true }, conversationPool: { hits: 3 }, tunables: {} },
      readOk: (dom) => dom.el('exp-pool-cards').innerHTML,
      extraSelf: { loadClineCompat: () => {}, loadCcCompat: () => {} },
    },
    {
      name: 'loadSystemPrompts',
      signature: 'async loadSystemPrompts()',
      existing: ['system-prompts-editor'],
      seed: (dom, self) => { dom.el('system-prompts-editor').innerHTML = 'LAST-GOOD'; self._systemPromptOriginals = { keep: 'me' }; },
      read: (dom, self) => [dom.el('system-prompts-editor').innerHTML, JSON.stringify(self._systemPromptOriginals)],
      expect: ['LAST-GOOD', '{"keep":"me"}'],
      ok: { prompts: { toolReinforcement: 'body text' } },
      readOk: (dom) => dom.el('system-prompts-editor').innerHTML,
    },
    {
      name: 'renderRuntimeEnvStatus',
      signature: 'async renderRuntimeEnvStatus()',
      existing: ['set-runtime-env-body'],
      seed: (dom) => { dom.el('set-runtime-env-body').innerHTML = 'LAST-GOOD'; },
      read: (dom) => [dom.el('set-runtime-env-body').innerHTML],
      expect: ['LAST-GOOD'],
      ok: { switches: { devinConnect: { value: true, source: 'config' } } },
      readOk: (dom) => dom.el('set-runtime-env-body').innerHTML,
    },
    {
      name: 'renderSecuritySettings',
      signature: 'async renderSecuritySettings()',
      existing: ['set-security-body'],
      seed: (dom) => { dom.el('set-security-body').innerHTML = 'LAST-GOOD'; },
      read: (dom) => [dom.el('set-security-body').innerHTML],
      expect: ['LAST-GOOD'],
      ok: { tunables: { emailLockThreshold: 4 } },
      readOk: (dom) => dom.el('set-security-body').innerHTML,
    },
    {
      name: 'renderBreakerSettings',
      signature: 'async renderBreakerSettings()',
      existing: ['set-breaker-body'],
      seed: (dom) => { dom.el('set-breaker-body').innerHTML = 'LAST-GOOD'; },
      read: (dom) => [dom.el('set-breaker-body').innerHTML],
      expect: ['LAST-GOOD'],
      ok: { knobs: { errorStreakThreshold: { value: 4 } } },
      readOk: (dom) => dom.el('set-breaker-body').innerHTML,
    },
    {
      name: 'loadCredentials',
      signature: 'async loadCredentials()',
      existing: ['credentials-apikey-source', 'credentials-apikey-masked', 'credentials-dashboardpw-source', 'credentials-dashboardpw-status'],
      seed: (dom) => {
        for (const id of ['credentials-apikey-source', 'credentials-apikey-masked', 'credentials-dashboardpw-source', 'credentials-dashboardpw-status']) {
          dom.el(id).textContent = 'LAST-GOOD';
        }
      },
      read: (dom) => ['credentials-apikey-source', 'credentials-apikey-masked', 'credentials-dashboardpw-source', 'credentials-dashboardpw-status']
        .map((id) => dom.el(id).textContent),
      expect: ['LAST-GOOD', 'LAST-GOOD', 'LAST-GOOD', 'LAST-GOOD'],
      ok: { apiKeySource: 'env', apiKey_masked: 'sk-****', dashboardPasswordSource: 'env', dashboardPasswordSet: true },
      readOk: (dom) => dom.el('credentials-apikey-source').textContent,
    },
    {
      name: 'loadClineCompat',
      signature: 'async loadClineCompat()',
      existing: ['cline-compat-badge', 'cline-compat-repairs'],
      seed: (dom) => { dom.el('cline-compat-badge').style.display = 'inline'; },
      read: (dom) => [dom.el('cline-compat-badge').style.display],
      expect: ['inline'],
      ok: { enabled: true, stats: { argRepairs: 3 } },
      readOk: (dom) => dom.el('cline-compat-badge').style.display,
    },
    {
      name: 'loadCcCompat',
      signature: 'async loadCcCompat()',
      existing: ['cc-compat-badge', 'cc-compat-schema'],
      seed: (dom) => { dom.el('cc-compat-badge').style.display = 'inline'; },
      read: (dom) => [dom.el('cc-compat-badge').style.display],
      expect: ['inline'],
      ok: { enabled: true, stats: { schemaNormalized: 3 } },
      readOk: (dom) => dom.el('cc-compat-badge').style.display,
    },
  ];

  for (const spec of cases) {
    it(`${spec.name} leaves its panel alone when the read fails`, async () => {
      const dom = makeDom(spec.existing);
      const self = appStub(FAILED, spec.extraSelf || {});
      spec.seed(dom, self);

      await runLoader(MAIN_HTML, spec.signature, self, dom);
      assert.deepEqual(spec.read(dom, self), spec.expect, `${spec.name} repainted on a failed read`);

      // Control: the same loader must still write when the read succeeds.
      const okDom = makeDom(spec.existing);
      const okSelf = appStub(spec.ok, spec.extraSelf || {});
      if (spec.seed) spec.seed(okDom, okSelf);
      await runLoader(MAIN_HTML, spec.signature, okSelf, okDom);
      assert.notDeepEqual(spec.readOk(okDom, okSelf), spec.expect[0],
        `${spec.name} no longer renders a successful payload — this guard would be vacuous`);
    });
  }

  it('loadSettings keeps the last prefs on failure but still drives its sub-panels', async () => {
    const dom = makeDom(['set-oauth-skip-chooser']);
    dom.el('set-oauth-skip-chooser').checked = true;
    const called = [];
    const self = appStub(FAILED, {
      renderSecuritySettings: () => called.push('security'),
      renderRuntimeEnvStatus: () => called.push('runtimeEnv'),
      loadCredentials: () => called.push('credentials'),
      loadSystemPrompts: () => called.push('prompts'),
      renderBreakerSettings: () => called.push('breaker'),
    });
    self._prefs = { keep: true };

    await runLoader(MAIN_HTML, 'async loadSettings()', self, dom);
    assert.deepEqual(self._prefs, { keep: true }, 'a failed prefs read must not reset the toggles');
    assert.equal(dom.el('set-oauth-skip-chooser').checked, true, 'nor repaint the checkbox');
    assert.deepEqual(called.sort(), ['breaker', 'credentials', 'prompts', 'runtimeEnv', 'security'],
      'the sub-panels own their own failure handling and must still be driven');
  });

  it('exportAccounts does not download an empty pool on a failed read', async () => {
    const dom = makeDom([]);
    const self = appStub(FAILED);
    await runLoader(MAIN_HTML, 'async exportAccounts()', self, dom);
    assert.deepEqual(self.toasts, [], 'a failed export must not toast "exported 0 accounts" as success');

    const okDom = makeDom([]);
    const okSelf = appStub({ accounts: [] });
    await runLoader(MAIN_HTML, 'async exportAccounts()', okSelf, okDom);
    assert.ok(okSelf.toasts.some(([, type]) => type === 'success'),
      'control: a successful export still reports success');
  });
});

describe('#257 the sketch skin keeps its panels too', () => {
  const cases = [
    {
      name: 'loadExperimental',
      signature: 'async loadExperimental()',
      existing: ['exp-cascade-reuse', 'exp-pool-cards', 'skin-select'],
      seed: (dom) => { dom.el('exp-pool-cards').innerHTML = 'LAST-GOOD'; dom.el('exp-cascade-reuse').checked = true; },
      read: (dom) => [dom.el('exp-pool-cards').innerHTML, dom.el('exp-cascade-reuse').checked],
      expect: ['LAST-GOOD', true],
      ok: { flags: { cascadeConversationReuse: true }, conversationPool: { hits: 1 } },
      readOk: (dom) => dom.el('exp-pool-cards').innerHTML,
      extraSelf: { loadCredentials: () => {}, loadSystemPrompts: () => {} },
    },
    {
      name: 'loadSystemPrompts',
      signature: 'async loadSystemPrompts()',
      existing: ['system-prompts-editor'],
      seed: (dom) => { dom.el('system-prompts-editor').innerHTML = 'LAST-GOOD'; },
      read: (dom) => [dom.el('system-prompts-editor').innerHTML],
      expect: ['LAST-GOOD'],
      ok: { prompts: { toolReinforcement: 'body text' } },
      readOk: (dom) => dom.el('system-prompts-editor').innerHTML,
    },
    {
      name: 'loadCredentials',
      signature: 'async loadCredentials()',
      existing: ['credentials-apikey-source', 'credentials-apikey-masked', 'credentials-dashboardpw-source', 'credentials-dashboardpw-status'],
      seed: (dom) => { dom.el('credentials-apikey-source').textContent = 'LAST-GOOD'; },
      read: (dom) => [dom.el('credentials-apikey-source').textContent],
      expect: ['LAST-GOOD'],
      ok: { apiKeySource: 'env' },
      readOk: (dom) => dom.el('credentials-apikey-source').textContent,
    },
  ];

  for (const spec of cases) {
    it(`sketch ${spec.name} leaves its panel alone when the read fails`, async () => {
      const dom = makeDom(spec.existing);
      const self = appStub(FAILED, spec.extraSelf || {});
      spec.seed(dom, self);
      await runLoader(SKETCH_HTML, spec.signature, self, dom);
      assert.deepEqual(spec.read(dom, self), spec.expect, `sketch ${spec.name} repainted on a failed read`);

      const okDom = makeDom(spec.existing);
      const okSelf = appStub(spec.ok, spec.extraSelf || {});
      spec.seed(okDom, okSelf);
      await runLoader(SKETCH_HTML, spec.signature, okSelf, okDom);
      assert.notDeepEqual(spec.readOk(okDom, okSelf), spec.expect[0],
        `sketch ${spec.name} no longer renders a successful payload`);
    });
  }
});
