// UISpec P2 — palette, scale, sort and the last maintenance gap.
//
// Two machine gates (scale + contrast) plus the shipped App methods executed
// from index.html with a DOM stub, the same technique dashboard-ui-polish uses.
//
//   P2-10  server-side ordering: header click flips, toolbar select picks,
//          the view persists and a sort change drops the selection
//   P2-11  rename uses the existing PATCH {label}; the dead reveal/copy helper
//          is gone (no uncalled function left behind)
//   P2-12  provider swatches come from --prov-* tokens (both themes ≥3:1)
//   scale  account/usage spacing + type come from --space-*/--fs-* tokens and
//          the 44px row budget token cannot leave the accounts table
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lintDashboardScale, SCOPE as SCALE_SCOPE } from '../scripts/check-dashboard-scale.mjs';
import { lintDashboardContrast, PROVIDERS } from '../scripts/check-dashboard-contrast.mjs';

const HTML = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');
const ZH = JSON.parse(readFileSync(new URL('../src/dashboard/i18n/zh-CN.json', import.meta.url), 'utf8'));
const EN = JSON.parse(readFileSync(new URL('../src/dashboard/i18n/en.json', import.meta.url), 'utf8'));

// ── shipped-method extraction (brace-sliced out of index.html) ─────────────
function methodParts(name) {
  let at = HTML.indexOf(`\n  ${name}(`);
  if (at === -1) at = HTML.indexOf(`\n  async ${name}(`);
  assert.notEqual(at, -1, `${name} must exist as a method in the dashboard App object`);
  const nameAt = HTML.indexOf(name, at);
  const parenOpen = HTML.indexOf('(', nameAt);
  let parenDepth = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < HTML.length; i++) {
    if (HTML[i] === '(') parenDepth++;
    else if (HTML[i] === ')' && --parenDepth === 0) { parenClose = i; break; }
  }
  assert.notEqual(parenClose, -1, `could not delimit the parameter list of ${name}`);
  const params = HTML.slice(parenOpen, parenClose + 1);
  const isAsync = /^async\s/.test(HTML.slice(at + 3, parenOpen));
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

const I18n = { locale: 'zh-CN', t: (key) => `i18n:${key}` };

function method(name) {
  const { params, body, isAsync } = methodParts(name);
  // eslint-disable-next-line no-new-func -- executing the shipped source is the point
  const fn = new Function('I18n', '...args', `return (${isAsync ? 'async ' : ''}function ${name}${params} ${body}).apply(this, args);`);
  return function (...args) { return fn.call(this, I18n, ...args); };
}

// renameAccount touches the drawer title after the PATCH; the DOM stub is the
// minimum that method reads.
globalThis.document = { getElementById: () => null };

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// ── P2-12 palette ──────────────────────────────────────────────────────────
describe('provider swatches (P2-12 / AC-COLOR-1)', () => {
  it('clears 3:1 on --surface in both themes for all 11 providers', () => {
    const { ok, problems } = lintDashboardContrast();
    assert.deepEqual(problems, []);
    assert.equal(ok, true);
    assert.equal(PROVIDERS.length, 11);
  });

  it('measures text tokens on the raised surfaces, not only --surface', () => {
    // Mutation check: the old light --text-dim (#71717a) cleared --surface
    // (4.83) but sat at 4.10 on --surface-2, where the DevIn panel paints its
    // 10px .dm-stat-label / .dm-req-num. A gate that only reads --surface must
    // report that mutation, or it certifies a pair it never measured.
    const mutated = HTML.replace(/--text-dim:\s*#[0-9a-f]{6};/, '--text-dim: #71717a;');
    assert.notEqual(mutated, HTML, 'the mutation must land on the light token');
    const { ok, problems } = lintDashboardContrast(mutated);
    assert.equal(ok, false);
    assert.ok(
      problems.some((p) => /^light: --text-dim is .* on --surface-2/.test(p)),
      `expected a --surface-2 failure, got:\n${problems.join('\n')}`,
    );
  });

  it('renders swatches from tokens, not an inline hex map', () => {
    assert.ok(!/providerColors/.test(HTML), 'the hardcoded colour map is gone');
    assert.ok(!/provider-swatch" style="background:/.test(HTML), 'no inline background on the swatch');
    assert.match(HTML, /<span class="provider-swatch" data-provider="\$\{this\.esc\(p\)\}"><\/span>/);
    for (const provider of PROVIDERS) {
      assert.match(HTML, new RegExp(`\\.provider-swatch\\[data-provider="${provider}"\\] \\{ background: var\\(--prov-${provider}\\); \\}`));
    }
  });

  it('keeps the brand blocks out of the markup and above AA', () => {
    assert.ok(!/style="[^"]*background:\s*#4285F4/i.test(HTML), 'no inline Google blue');
    assert.ok(!/style="[^"]*background:\s*#24292e/i.test(HTML), 'no inline GitHub black');
    assert.match(HTML, /class="btn oauth-brand-btn oauth-brand-google"/);
  });
});

// ── scale ──────────────────────────────────────────────────────────────────
describe('spacing + type scale (P2)', () => {
  it('keeps every account/usage declaration on the tokens', () => {
    const { ok, problems } = lintDashboardScale();
    assert.deepEqual(problems, []);
    assert.equal(ok, true);
  });

  it('scopes the account page, the add/login modal and the usage panel', () => {
    for (const selector of ['.acct-kpi', '#accounts-table th', '.add-modal', '.login-method', '.usage-metrics', '.provider-swatch']) {
      assert.ok(SCALE_SCOPE.test(selector), `${selector} is scale-managed`);
    }
    assert.ok(!SCALE_SCOPE.test('.chart-main'), 'unrelated panels stay out of scope');
  });

  it('pins the 44px row budget to the accounts table', () => {
    assert.match(HTML, /--acct-row-pad-y: 5px/);
    const uses = [...HTML.matchAll(/([^{}]+)\{[^{}]*var\(--acct-row-pad-y\)[^{}]*\}/g)].map((m) => m[1]);
    assert.ok(uses.length > 0, 'the token is used');
    for (const selector of uses) assert.match(selector, /#accounts-table/, `only the table may use it: ${selector.trim()}`);
  });
});

// ── P2-10 ordering ─────────────────────────────────────────────────────────
describe('server-side ordering (P2-10 / AC-SORT-1..3)', () => {
  const listUrl = method('accountsListUrl');

  it('puts sort and order on the query string only when set', () => {
    const withSort = listUrl.call({ accountsPage: 2, accountsPageSize: 50 }, { sort: 'balance', order: 'asc' });
    assert.match(withSort, /sort=balance/);
    assert.match(withSort, /order=asc/);
    const plain = listUrl.call({ accountsPage: 1, accountsPageSize: 50 }, {});
    assert.ok(!/[?&]sort=/.test(plain), 'no sort param means the server default');
    assert.ok(!/[?&]order=/.test(plain));
  });

  it('loadAccounts sends the current ordering', () => {
    assert.match(HTML, /sort: this\.accountsSort,\s*\n\s*order: this\.accountsOrder,/);
  });

  it('a header click sorts desc, the same header again flips to asc', () => {
    const setSort = method('setAccountsSort');
    const self = {
      accountsSort: '', accountsOrder: 'desc', accountsPage: 3,
      cleared: 0, loaded: 0,
      clearAccountSelection() { this.cleared++; },
      loadAccounts() { this.loaded++; },
    };
    setSort.call(self, 'quota_weekly');
    assert.equal(self.accountsSort, 'quota_weekly');
    assert.equal(self.accountsOrder, 'desc');
    assert.equal(self.accountsPage, 1, 'a new order starts at page 1');
    assert.equal(self.cleared, 1, 'rows move, so the selection is dropped');
    assert.equal(self.loaded, 1);
    assert.equal(store.get('accountsSort'), 'quota_weekly');
    assert.equal(store.get('accountsOrder'), 'desc');

    setSort.call(self, 'quota_weekly');
    assert.equal(self.accountsOrder, 'asc', 'clicking the active column flips the direction');
    assert.equal(store.get('accountsOrder'), 'asc');
  });

  it('honours an explicit order and clears back to the server default', () => {
    const setSort = method('setAccountsSort');
    const self = {
      accountsSort: 'quota_weekly', accountsOrder: 'desc', accountsPage: 1,
      clearAccountSelection() {}, loadAccounts() {},
    };
    setSort.call(self, 'balance', 'asc');
    assert.deepEqual([self.accountsSort, self.accountsOrder], ['balance', 'asc']);
    setSort.call(self, '');
    assert.deepEqual([self.accountsSort, self.accountsOrder], ['', '']);
    assert.equal(store.get('accountsSort'), '');
  });

  it('rejects unknown columns instead of sending them', () => {
    const setSort = method('setAccountsSort');
    const self = {
      accountsSort: 'errors', accountsOrder: 'desc', accountsPage: 1,
      clearAccountSelection() {}, loadAccounts() {},
    };
    setSort.call(self, 'DROP TABLE');
    assert.deepEqual([self.accountsSort, self.accountsOrder], ['', '']);
  });

  it('exposes the order on both sortable headers and the toolbar select', () => {
    assert.match(HTML, /class="acct-quota-col th-help"[^>]*aria-sort="none"><button type="button" class="th-sort" onclick="App\.setAccountsSort\('quota_weekly'\)"/);
    assert.match(HTML, /class="acct-last-col" aria-sort="none"><button type="button" class="th-sort" onclick="App\.setAccountsSort\('last_used'\)"/);
    for (const value of ['quota_weekly', 'balance', 'last_used', 'errors']) {
      assert.match(HTML, new RegExp(`<option value="${value}" data-i18n="table\\.header\\.`), `${value} is selectable`);
    }
  });
});

// ── P2-11 maintenance ──────────────────────────────────────────────────────
describe('rename + dead code (P2-11)', () => {
  it('offers rename in the row menu and the drawer footer', () => {
    assert.match(HTML, /\{ key: 'accounts\.row\.rename', act: \(\) => this\.renameAccount\(id\) \}/);
    assert.match(HTML, /onclick="App\.renameAccount\('\$\{this\.escJsAttr\(a\.id\)\}'\)">\$\{I18n\.t\('accounts\.row\.rename'\)\}/);
    assert.ok(ZH.accounts.row.rename && EN.accounts.row.rename);
    assert.ok(ZH.accounts.rename.prompt && EN.accounts.rename.prompt);
  });

  it('PATCHes the existing label field with the trimmed name', async () => {
    const rename = method('renameAccount');
    const calls = [];
    const self = {
      _accountsById: new Map([['acc-1', { id: 'acc-1', email: 'old@example.test' }]]),
      _drawerAccountId: null,
      api: async (m, p, b) => { calls.push({ m, p, b }); return { success: true }; },
      toast() {},
      translateError: (code, fallback) => fallback,
      loadAccounts: async () => {},
      refreshOpenDrawer() {},
    };
    const previousWindow = globalThis.window;
    globalThis.window = { prompt: () => '  night shift  ' };
    try {
      await rename.call(self, 'acc-1');
    } finally {
      globalThis.window = previousWindow;
    }
    assert.deepEqual(calls, [{ m: 'PATCH', p: '/accounts/acc-1', b: { label: 'night shift' } }]);
  });

  it('leaves no uncalled reveal/copy helper behind', () => {
    assert.ok(!/revealAndCopyKey\s*\(/.test(HTML), 'no reveal helper');
    assert.ok(!/\bcopyKey\s*\(/.test(HTML), 'no copy helper');
    assert.ok(!('reveal' in ZH) && !('reveal' in EN), 'the dead prompt copy is gone too');
  });
});
