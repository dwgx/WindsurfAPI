// SessionReauth Phase 3 — dashboard rendering of the reauth state.
//
// Executes the SHIPPED App methods (brace-sliced out of index.html), the same
// technique test/dashboard-account-selection.test.js uses, so the badge, the
// row menu, the drawer footer and the bound-login banner are the real code and
// not a mirror. The module mirror (pool-events.accountState) is imported too:
// the two must agree on the coarse state, and check-inline-sync asserts it at
// the token level.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accountState } from '../src/dashboard/pool-events.js';

const HTML = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

function methodParts(name) {
  let at = HTML.indexOf(`\n  ${name}(`);
  if (at === -1) at = HTML.indexOf(`\n  async ${name}(`);
  assert.notEqual(at, -1, `${name} must exist as a method in the dashboard App object`);
  const nameAt = HTML.indexOf(name, at);
  // The parameter list may itself contain braces (a destructured default), so
  // walk its parens to find where it ends — the body starts at the next `{`.
  const parenOpen = HTML.indexOf('(', nameAt);
  let parenDepth = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < HTML.length; i++) {
    if (HTML[i] === '(') parenDepth++;
    else if (HTML[i] === ')' && --parenDepth === 0) { parenClose = i; break; }
  }
  assert.notEqual(parenClose, -1, `could not delimit the parameter list of ${name}`);
  const params = HTML.slice(parenOpen, parenClose + 1);
  const decl = HTML.slice(at + 3, parenOpen);
  const isAsync = /^async\s/.test(decl);
  const open = HTML.indexOf('{', parenClose);
  let depth = 0;
  let end = -1;
  for (let i = open; i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.notEqual(end, -1, `could not delimit the body of ${name}`);
  return { params, body: HTML.slice(open, end), isAsync };
}

const I18n = {
  t: (key, vars) => (vars ? `i18n:${key}|${JSON.stringify(vars)}` : `i18n:${key}`),
};

function method(name) {
  const { params, body, isAsync } = methodParts(name);
  // eslint-disable-next-line no-new-func -- executing the shipped source is the point
  const fn = new Function('I18n', '...args',
    `return (${isAsync ? 'async ' : ''}function ${name}${params} ${body}).apply(this, args);`);
  // A normal function so the CALL SITE decides `this` (the App object stub).
  return function (...args) { return fn.call(this, I18n, ...args); };
}

// Minimal DOM: every id resolves to a fresh element with the bits the methods
// touch. Nothing here renders — the assertions read the same strings the browser
// would receive through innerHTML / textContent.
const elements = new Map();
function element(id) {
  if (elements.has(id)) return elements.get(id);
  const classes = new Set();
  const el = {
    id, textContent: '', innerHTML: '', value: '', hidden: false, disabled: false, dataset: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        if (on === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); }
        else if (on) classes.add(c); else classes.delete(c);
      },
    },
    setAttribute() {}, removeAttribute() {}, focus() {}, appendChild() {},
    querySelector: () => null, querySelectorAll: () => [],
  };
  elements.set(id, el);
  return el;
}

globalThis.document = {
  getElementById: (id) => element(id),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => element(`<${tag}>`),
  addEventListener() {}, removeEventListener() {},
  body: { appendChild() {} },
};

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const escJsAttr = (value) => String(value ?? '').replace(/[\\'"<>&\r\n]/g, (c) => ({ '\\': '\\\\', "'": "\\'", '"': '\\"', '<': '\\x3c', '>': '\\x3e', '&': '\\x26', '\r': '\\r', '\n': '\\n' }[c]));

function appBase(overrides = {}) {
  const self = {
    esc, escJsAttr,
    accountStateOf: method('accountStateOf'),
    accountStateMeta: method('accountStateMeta'),
    accountStateLabel: method('accountStateLabel'),
    renderReauthBanner: method('renderReauthBanner'),
    reloginAccount: method('reloginAccount'),
    closeAddAccountModal: method('closeAddAccountModal'),
    openAddAccountModal: method('openAddAccountModal'),
    resetEmailCodeForm: method('resetEmailCodeForm'),
    updateEmailCodeControls: method('updateEmailCodeControls'),
    closeRowMenu() { this._closed = (this._closed || 0) + 1; },
    closeAccountDrawer() { this._closedDrawer = (this._closedDrawer || 0) + 1; },
    renderAccountDetail: () => '<detail/>',
    ...overrides,
  };
  return self;
}

const reauthRow = {
  id: 'acct-reauth',
  email: 'dead@example.test',
  loginEmail: 'dead@example.test',
  status: 'reauth',
  reauth: { at: 1_700_000_000_000, source: 'request', code: 'UNAUTHORIZED' },
  errorCount: 0,
};

describe('row badge', () => {
  it('accountStateOf returns reauth ahead of every self-healing cooldown', () => {
    const self = appBase();
    const stateOf = self.accountStateOf;
    assert.equal(stateOf({ status: 'reauth' }), 'reauth');
    assert.equal(stateOf({ status: 'reauth', quotaCooled: true, rateLimited: true, capacityThrottled: true, errorCount: 4 }), 'reauth');
    assert.equal(stateOf({ status: 'banned' }), 'banned', 'banned still outranks a token verdict');
    assert.equal(stateOf({ status: 'disabled' }), 'disabled');
    // The module mirror must agree on the coarse state.
    assert.equal(accountState({ status: 'reauth', quotaCooled: true }), 'reauth');
  });

  it('renders a terminal error chip, not a warning', () => {
    const meta = appBase().accountStateMeta('reauth');
    assert.equal(meta.labelKey, 'accounts.status.reauth');
    assert.equal(meta.cls, 'banned', 'reauth borrows the terminal chip, not warn');
    assert.equal(meta.band, 'var(--error)');
  });

  it('the status filter accepts reauth', () => {
    const calls = [];
    const self = appBase({
      loadAccounts: () => calls.push('load'),
      clearAccountSelection: () => {},
    });
    const setAccountsStatus = method('setAccountsStatus', self);
    setAccountsStatus.call(self, 'reauth');
    assert.equal(self.accountsStatus, 'reauth');
    assert.equal(calls.length, 1);
  });

  it('the <option> and the state ladder are wired in the shipped HTML', () => {
    assert.match(HTML, /<option value="reauth"[^>]*data-i18n="accounts\.status\.reauth"/);
    assert.match(HTML, /if \(a\.status === 'reauth'\) return 'reauth';/);
  });
});

describe('row menu', () => {
  it('relabels the login action and hides "reset errors" for a reauth row', () => {
    const source = methodParts('openRowMenu').body;
    assert.match(source, /state === 'reauth' \? 'accounts\.row\.reauth' : 'accounts\.row\.relogin'/);
    assert.match(source, /state === 'reauth' \? \[\] : \[\{ key: 'action\.reset'/,
      'reset errors would put the retired token back in rotation');
    assert.match(source, /state === 'reauth'\s*\n?\s*\? \{ key: 'action\.disable'/,
      'the menu offers disable instead of a re-enable that must 409');
  });

  it('reloginAccount binds the modal to the account id', () => {
    const opened = [];
    const self = appBase({
      _accountsById: new Map([['acct-reauth', reauthRow]]),
      openAddAccountModal: (tab, opts) => opened.push({ tab, opts }),
    });
    self.reloginAccount('acct-reauth');
    assert.equal(self._closed, 1, 'the kebab must close');
    assert.equal(self._closedDrawer, 1, 'the drawer must close');
    assert.deepEqual(opened, [{ tab: 'login', opts: { email: 'dead@example.test', accountId: 'acct-reauth' } }]);
  });

  it('prefills the verified login address instead of a renamed display label', () => {
    const opened = [];
    const self = appBase({
      _accountsById: new Map([['acct-reauth', {
        ...reauthRow,
        email: 'renamed-label@example.test',
        loginEmail: 'real-identity@example.test',
      }]]),
      openAddAccountModal: (tab, opts) => opened.push({ tab, opts }),
    });
    self.reloginAccount('acct-reauth');
    assert.deepEqual(opened, [{
      tab: 'login',
      opts: { email: 'real-identity@example.test', accountId: 'acct-reauth' },
    }], 'a renamed label must not be submitted as the login identity');
  });

  it('clears the email input when the next bound row has no verified address', () => {
    const input = element('wl-email');
    const self = appBase({
      _accountsById: new Map([['acct-reauth', { ...reauthRow, loginEmail: '' }]]),
      switchAddTab(tab) { this._addTab = tab; },
      selectLoginMethod() {}, loadWindsurfLogin() {}, checkLocalImportAvailability() {},
      loadDevinBrowserLogin() { this._browserAvailabilityChecked = true; },
    });
    input.value = 'previous@example.test';

    self.reloginAccount('acct-reauth');

    assert.equal(input.value, '');
    assert.equal(self._reauthAccountId, 'acct-reauth');
    assert.equal(self._browserAvailabilityChecked, true);
  });

  it('opens the replacement guide for a bound Connect credential', () => {
    const guide = element('connect-recovery-guide');
    const tabs = element('add-account-tabs');
    const self = appBase({
      _accountsById: new Map([['acct-reauth', { ...reauthRow, credentialKind: 'connect_session' }]]),
      switchAddTab(tab) { this._addTab = tab; },
      selectLoginMethod() { assert.fail('Connect recovery should open the paste panel'); },
      loadWindsurfLogin() {}, checkLocalImportAvailability() {},
    });
    self.reloginAccount('acct-reauth');
    assert.equal(self._addTab, 'paste');
    assert.equal(self._reauthAccountId, 'acct-reauth');
    assert.equal(guide.classList.contains('hidden'), false);
    assert.equal(tabs.classList.contains('hidden'), true);
    self.closeAddAccountModal();
    assert.equal(guide.classList.contains('hidden'), true);
    assert.equal(tabs.classList.contains('hidden'), false);
  });
});

describe('bound login banner', () => {
  it('shows the bound email and hides when unbound', () => {
    const banner = element('add-reauth-banner');
    const text = element('add-reauth-banner-text');
    const self = appBase({ _accountsById: new Map([['acct-reauth', reauthRow]]) });

    self._reauthAccountId = 'acct-reauth';
    self.renderReauthBanner();
    assert.equal(banner.classList.contains('hidden'), false);
    assert.match(text.textContent, /accounts\.reauth\.banner/);
    assert.match(text.textContent, /dead@example\.test/);

    self._reauthAccountId = null;
    self.renderReauthBanner();
    assert.equal(banner.classList.contains('hidden'), true);
  });

  it('opening the add modal without an id clears any stale binding', () => {
    const self = appBase({
      switchAddTab() {}, loadWindsurfLogin() {}, checkLocalImportAvailability() {},
    });
    const open = self.openAddAccountModal;
    self._reauthAccountId = 'acct-reauth';
    open.call(self, 'paste');
    assert.equal(self._reauthAccountId, null, 'a plain "Add" must not inherit the last re-auth binding');
    open.call(self, 'login', { email: 'x@example.test', accountId: 'acct-reauth' });
    assert.equal(self._reauthAccountId, 'acct-reauth');
  });

  it('closing the modal drops the binding', () => {
    const self = appBase();
    const close = self.closeAddAccountModal;
    self._reauthAccountId = 'acct-reauth';
    close.call(self);
    assert.equal(self._reauthAccountId, null);
    assert.equal(element('add-reauth-banner').classList.contains('hidden'), true);
  });
});

describe('drawer', () => {
  function renderDrawer(row) {
    const self = appBase({
      _accountsById: new Map([[row.id, row]]),
      _accountDetails: new Map(),
      _cardsByAccount: new Map(),
    });
    const render = method('renderAccountDrawer', self);
    render.call(self, row.id);
    return {
      body: element('acct-drawer-body').innerHTML,
      foot: element('acct-drawer-foot').innerHTML,
    };
  }

  it('promotes re-authenticate + check token for a reauth row', () => {
    const { foot } = renderDrawer(reauthRow);
    assert.match(foot, /accounts\.reauth\.checkToken/);
    assert.match(foot, /accounts\.row\.reauth/);
    assert.match(foot, /App\.checkAccountToken\('acct-reauth'\)/);
    assert.match(foot, /btn-primary/, 're-auth is the primary action');
  });

  it('keeps the ordinary actions for a healthy row', () => {
    const { foot } = renderDrawer({ id: 'acct-ok', email: 'ok@example.test', status: 'active', errorCount: 0 });
    assert.doesNotMatch(foot, /accounts\.reauth\.checkToken/);
    assert.match(foot, /accounts\.row\.relogin/);
  });

  it('renders the evidence line (when + which verdict)', () => {
    // The notice lives inside renderAccountDetail's template, which renders the
    // whole drawer (plan card, model grid, …); asserting on its shipped source
    // keeps this test about the reauth copy instead of re-stubbing that page.
    const source = methodParts('renderAccountDetail').body;
    assert.match(source, /const reauthNotice = state === 'reauth'/);
    assert.match(source, /accounts\.reauth\.detail/);
    assert.match(source, /a\.reauth\?\.code \|\| 'UNAUTHORIZED'/);
    assert.match(source, /\$\{reauthNotice\}/, 'the notice must actually be rendered');
  });
});
