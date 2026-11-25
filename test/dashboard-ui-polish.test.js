// UI polish (UISpec P0-4, P1-5..P1-9).
//
// Executes the SHIPPED App methods (brace-sliced out of index.html) with a tiny
// DOM stub, the same technique the reauth/selection suites use, so these tests
// pin the real template strings rather than a mirror implementation.
//
//   P0-4  one action, one verb: the entry button names the tab it opens, the
//         modal title follows the tab, probe/refresh/term vocabulary is singular
//   P1-5  the status filter is three human groups + ten explained details
//   P1-6  the drawer shows four answers first, six technical cards collapsed
//   P1-7  each row shows its last check; fleet results list every account
//   P1-8  usage answers "what is left" first; unmapped reasons stay human
//   P1-9  the login tab is a method chooser, advanced options collapsed
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lintDashboardCopy, TERMS, RETIRED } from '../scripts/check-dashboard-copy.mjs';

const HTML = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');
const ZH = JSON.parse(readFileSync(new URL('../src/dashboard/i18n/zh-CN.json', import.meta.url), 'utf8'));
const EN = JSON.parse(readFileSync(new URL('../src/dashboard/i18n/en.json', import.meta.url), 'utf8'));

function flatten(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, full, out);
    else out[full] = value;
  }
  return out;
}
const zh = flatten(ZH);
const en = flatten(EN);

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
  locale: 'zh-CN',
  t(key, vars = {}) {
    const suffix = Object.keys(vars).length
      ? '|' + Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')
      : '';
    return `i18n:${key}${suffix}`;
  },
};

function method(name) {
  const { params, body, isAsync } = methodParts(name);
  // eslint-disable-next-line no-new-func -- executing the shipped source is the point
  const fn = new Function('I18n', '...args', `return (${isAsync ? 'async ' : ''}function ${name}${params} ${body}).apply(this, args);`);
  return function (...args) { return fn.call(this, I18n, ...args); };
}

const elements = new Map();
function element(id) {
  if (elements.has(id)) return elements.get(id);
  const classes = new Set();
  const el = {
    id, textContent: '', innerHTML: '', value: '', hidden: false, disabled: false,
    dataset: {}, title: '', open: false,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        if (on === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); }
        else if (on) classes.add(c); else classes.delete(c);
      },
    },
    setAttribute(k, v) { this[k] = v; },
    removeAttribute(k) { delete this[k]; },
    focus() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [],
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
globalThis.sessionStorage = {
  _v: new Map(),
  getItem(k) { return this._v.has(k) ? this._v.get(k) : null; },
  setItem(k, v) { this._v.set(k, String(v)); },
};

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escJsAttr = (v) => String(v ?? '').replace(/[\\'"<>&\r\n]/g, (c) => ({ '\\': '\\\\', "'": "\\'", '"': '\\"', '<': '\\x3c', '>': '\\x3e', '&': '\\x26', '\r': '\\r', '\n': '\\n' }[c]));

function baseSelf(overrides = {}) {
  return {
    esc, escJsAttr,
    fmtAgoShort: () => '3m',
    skipReasonText: (code) => ZH.accounts.skip[code] || '',
    translateError: (code) => `i18n:error.genericAction|code=${code}`,
    poolBalanceText: () => '$0.00',
    clearAccountSelection() {},
    loadAccounts() {},
    ...overrides,
  };
}

function methodWithI18n(name, i18n) {
  const { params, body, isAsync } = methodParts(name);
  // eslint-disable-next-line no-new-func -- executing the shipped source is the point
  const fn = new Function('I18n', '...args', `return (${isAsync ? 'async ' : ''}function ${name}${params} ${body}).apply(this, args);`);
  return function (...args) { return fn.call(this, i18n, ...args); };
}

// ─── P0-4: one action, one verb ───────────────────────────────────────────
describe('entry verbs name the tab they open (AC-VERB-1)', () => {
  it('the header buttons and the tab labels are the same words', () => {
    const buttons = [
      ['accounts-login-btn', 'login', 'accounts.add.login'],
      ['accounts-import-btn', 'import', 'accounts.add.import'],
      ['accounts-add-btn', 'paste', 'accounts.add.paste'],
    ];
    for (const [id, tab, key] of buttons) {
      const tag = (HTML.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`)) || [])[0];
      assert.ok(tag, `${id} exists`);
      assert.match(tag, new RegExp(`openAddAccountModal\\('${tab}'\\)`), `${id} opens the ${tab} tab`);
      assert.match(tag, new RegExp(`data-i18n="${key.replace(/\./g, '\\.')}"`));
    }
    // The old label said 添加 while the tab said 粘贴凭证.
    assert.equal(zh['accounts.add.paste'], zh['accounts.add.tab.paste']);
    assert.equal(en['accounts.add.paste'], en['accounts.add.tab.paste']);
    assert.notEqual(zh['accounts.add.paste'], '添加');
  });

  it('every tab has a title of its own and reauth names the account', () => {
    for (const tab of ['login', 'paste', 'import', 'local']) {
      assert.ok(zh[`accounts.add.modalTitle.${tab}`], `zh title for ${tab}`);
      assert.ok(en[`accounts.add.modalTitle.${tab}`], `en title for ${tab}`);
    }
    assert.match(zh['accounts.add.modalTitle.reauth'], /\{\{email\}\}/);
    assert.match(en['accounts.add.modalTitle.reauth'], /\{\{email\}\}/);
    assert.match(methodParts('switchAddTab').body, /this\.setAddModalTitle\(\)/);
  });

  it('setAddModalTitle follows the active tab and the reauth binding', () => {
    const title = element('add-modal-title');
    const self = baseSelf({ _addTab: 'paste', _reauthAccountId: null });
    const setTitle = method('setAddModalTitle');
    setTitle.call(self);
    assert.equal(title.textContent, 'i18n:accounts.add.modalTitle.paste');
    self._addTab = 'import';
    setTitle.call(self);
    assert.equal(title.textContent, 'i18n:accounts.add.modalTitle.import');
    self._reauthAccountId = 'acct-1';
    self._accountsById = new Map([['acct-1', { email: 'dead@example.test' }]]);
    setTitle.call(self);
    assert.match(title.textContent, /accounts\.add\.modalTitle\.reauth\|email=dead@example\.test/);
  });

  it('probe and balance actions use one verb each', () => {
    const pairs = [
      ['batchOps.probe', 'batchOps.refresh'],
      ['accounts.toolbar.probeAll', 'accounts.toolbar.refreshAll'],
      ['accounts.row.probe', 'accounts.row.refreshBalance'],
      ['action.probe', null],
    ];
    for (const [probeKey, refreshKey] of pairs) {
      assert.ok(zh[probeKey], `zh has ${probeKey}`);
      assert.ok(!/探测/.test(zh[probeKey]), `${probeKey} must not say 探测`);
      if (refreshKey) {
        assert.ok(zh[refreshKey].includes('余额'), `${refreshKey} must say 余额`);
        assert.ok(!/额度/.test(zh[refreshKey]), `${refreshKey} must not say 额度`);
      }
    }
    for (const term of TERMS) {
      const table = term.locale === 'zh-CN' ? zh : en;
      assert.match(table[term.key], term.must, `${term.locale} ${term.key}: ${term.why}`);
    }
    for (const retired of RETIRED) {
      const table = retired.locale === 'zh-CN' ? zh : en;
      for (const [key, value] of Object.entries(table)) {
        if (typeof value !== 'string' || !/^(accounts|batchOps|usage|account\.detail|table\.header)\./.test(key)) continue;
        if (/tech|tooltip\.help/i.test(key)) continue;
        assert.ok(!retired.re.test(value), `${retired.locale} ${key} still uses ${retired.label}`);
      }
    }
    const { ok, problems } = lintDashboardCopy();
    assert.deepEqual(problems, []);
    assert.equal(ok, true);
  });
});

// ─── P1-5: status vocabulary ───────────────────────────────────────────────
describe('status filter is human groups plus explained details (AC-STATUS-1..3)', () => {
  const selectBlock = HTML.slice(
    HTML.indexOf('<select id="accounts-status-filter"'),
    HTML.indexOf('</select>', HTML.indexOf('<select id="accounts-status-filter"')) + '</select>'.length,
  );
  const templateBlock = HTML.slice(
    HTML.indexOf('<template id="accounts-status-details">'),
    HTML.indexOf('</template>', HTML.indexOf('<template id="accounts-status-details">')),
  );

  it('offers exactly four choices by default', () => {
    const values = [...selectBlock.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(values, ['', 'active', 'disabled', 'attention']);
    assert.ok(!HTML.includes('id="accounts-flagged-toggle"'), 'the duplicate 仅异常 chip is gone');
  });

  it('keeps the ten raw states behind 更多状态, each with an explanation', () => {
    const options = [...templateBlock.matchAll(/<option value="([^"]+)"[^>]*>/g)];
    assert.equal(options.length, 10, 'all ten states are reachable');
    for (const [tag, state] of options) {
      assert.match(tag, /data-status-detail/, `${state} is tagged for injection/removal`);
      assert.match(tag, new RegExp(`data-i18n-title="accounts\\.statusTip\\.${state}"`), `${state} has a tip key`);
      const title = (tag.match(/\btitle="([^"]+)"/) || [])[1];
      assert.ok(title && title.trim().length > 0, `${state} has a non-empty title`);
    }
    for (const state of ['active', 'disabled', 'banned', 'reauth', 'error', 'quota_cooled', 'rate_limited', 'capacity', 'near_limit', 'watch']) {
      assert.ok(zh[`accounts.statusTip.${state}`], `zh explains ${state}`);
      assert.ok(en[`accounts.statusTip.${state}`], `en explains ${state}`);
    }
  });

  it('需处理 is the KPI predicate, not a server state', () => {
    const calls = [];
    const self = baseSelf({ accountsStatus: 'banned', accountsFlagged: false, accountsPage: 2, loadAccounts: () => calls.push('load') });
    const setStatus = method('setAccountsStatus');
    setStatus.call(self, 'attention');
    assert.equal(self.accountsFlagged, true);
    assert.equal(self.accountsStatus, '');
    assert.equal(self.accountsPage, 1);
    assert.equal(calls.length, 1);
    setStatus.call(self, 'banned');
    assert.equal(self.accountsFlagged, false);
    assert.equal(self.accountsStatus, 'banned');
  });

  it('the select shows 需处理 when the flagged predicate is active', () => {
    const sel = element('accounts-status-filter');
    sel.value = '';
    const self = baseSelf({
      accountsFlagged: true, accountsStatus: '', accountsTier: '', accountsQuery: '',
      accountsPage: 1, accountsPageSize: 50,
    });
    method('renderAccountsFilterState').call(self, { accounts: [], stats: {}, total: 0 });
    assert.equal(sel.value, 'attention');
  });
});

// ─── P1-6: drawer hierarchy ────────────────────────────────────────────────
describe('drawer answers four questions before the technical cards (AC-DRAWER-1..2)', () => {
  const body = methodParts('renderAccountDetail').body;

  it('puts plan → quota → models → requests first', () => {
    const order = [
      body.indexOf('this.renderPlanCard('),
      body.indexOf("T('quota.title')"),
      body.indexOf("T('models.title')"),
      body.indexOf('this.renderRequestHistoryCard('),
    ];
    assert.ok(order.every((i) => i >= 0), 'all four primary cards are rendered');
    for (let i = 1; i < order.length; i++) {
      assert.ok(order[i] > order[i - 1], `primary card ${i} must come after ${i - 1}`);
    }
  });

  it('collapses the six technical cards into 高级信息, closed by default', () => {
    const detailsAt = body.indexOf('<details class="detail-advanced"');
    assert.ok(detailsAt > body.indexOf('this.renderRequestHistoryCard('), 'the disclosure follows the primary cards');
    assert.match(body.slice(detailsAt, detailsAt + 220), /id="acct-advanced"\$\{this\._advancedOpen \? ' open' : ''\}/);
    const advanced = body.slice(detailsAt);
    const order = ['renderSpendPolicyCard', 'renderLedgerCard', 'renderModelStatusCard', 'runtime.title', 'renderKeyCard', 'renderPreflightCard'];
    let last = -1;
    for (const marker of order) {
      const at = advanced.indexOf(marker);
      assert.ok(at > last, `${marker} must be inside the advanced block, in order`);
      last = at;
    }
  });

  it('remembers the open state for the tab session', () => {
    const self = baseSelf({});
    const toggle = method('onDrawerAdvancedToggle');
    toggle.call(self, true);
    assert.equal(self._advancedOpen, true);
    assert.equal(globalThis.sessionStorage.getItem('acct_advanced_open'), '1');
    toggle.call(self, false);
    assert.equal(self._advancedOpen, false);
    assert.equal(globalThis.sessionStorage.getItem('acct_advanced_open'), '0');
  });
});

// ─── P1-7: probe results readable ──────────────────────────────────────────
describe('last check is visible per row (AC-PROBE-1..2)', () => {
  it('renders the server timestamp, not an in-memory one', () => {
    const self = baseSelf({});
    const html = method('renderLastCheck').call(self, { id: 'acct-1', lastProbed: Date.now() - 180_000 }, null);
    assert.match(html, /accounts\.row\.lastCheck\|ago=3m/);
    assert.match(html, /class="acct-last-check"/);
  });

  it('shows a skipped check as a human sentence plus a retry action', () => {
    const self = baseSelf({});
    const html = method('renderLastCheck').call(self, { id: 'acct-1' }, { skipped: true, error: 'ls_not_idle_resident' });
    assert.ok(html.includes(ZH.accounts.skip.ls_not_idle_resident));
    assert.doesNotMatch(html, /ls_not_idle_resident/);
    assert.match(html, /App\.probeAccount\('acct-1'\)/);
    assert.match(html, /accounts\.row\.retryCheck/);
  });

  it('the row template uses that line and does not add a table row', () => {
    const row = methodParts('renderAccountRow').body;
    assert.match(row, /\$\{this\.renderLastCheck\(a, batch\)\}/);
    assert.equal((row.match(/<tr /g) || []).length, 1, 'still exactly one row element');
  });

  it('the fleet panel lists every attempt with result, reason and time', () => {
    const panel = element('accounts-fleet-panel');
    const summary = element('accounts-fleet-summary');
    const list = element('accounts-fleet-list');
    const exList = element('accounts-fleet-excluded-list');
    const exBtn = element('accounts-fleet-excluded');
    const reopen = element('accounts-fleet-reopen');
    panel.hidden = true;
    const self = baseSelf({
      _fleetRun: {
        op: 'probe', state: 'done', total: 3, done: 3, ok: 1, fail: 1, skipped: 1,
        excluded: 1, excludedAccounts: [{ id: 'off', email: 'off@example.test' }],
        items: [
          { id: 'a', email: 'ok@example.test', ok: true, at: 1_700_000_000_000 },
          { id: 'b', email: 'bad@example.test', ok: false, error: 'ERR_PROBE_FAILED', at: 1_700_000_001_000 },
          { id: 'c', email: 'skip@example.test', ok: false, skipped: true, reason: 'ls_not_idle_resident', at: 1_700_000_002_000 },
        ],
      },
    });
    self._setFleetReopenVisible = method('_setFleetReopenVisible');
    self.noticeText = method('noticeText');
    self.renderFleetPanel = method('renderFleetPanel');
    self.reopenFleetPanel = method('reopenFleetPanel');
    self.dismissFleetPanel = method('dismissFleetPanel');
    self.renderFleetPanel();
    assert.equal(panel.hidden, false);
    assert.match(summary.textContent, /accounts\.fleet\.summary/);
    assert.match(list.innerHTML, /ok@example\.test/);
    assert.match(list.innerHTML, /bad@example\.test/);
    assert.match(list.innerHTML, /skip@example\.test/);
    assert.match(list.innerHTML, /accounts\.fleet\.resultOk/);
    assert.match(list.innerHTML, /accounts\.fleet\.resultFail/);
    assert.match(list.innerHTML, /accounts\.fleet\.resultSkipped/);
    assert.ok(list.innerHTML.includes(ZH.accounts.skip.ls_not_idle_resident));
    const visible = list.innerHTML.replace(/<[^>]+>/g, '');
    assert.doesNotMatch(visible, /ls_not_idle_resident/, 'the enum stays out of visible text');
    assert.match(list.innerHTML, /techDetail\|code=ls_not_idle_resident/, 'the raw code is still in the title');
    assert.match(list.innerHTML, /3m/, 'each item carries its time');
    assert.equal(exBtn.hidden, false);
    assert.match(exBtn.textContent, /excludedToggle\|count=1/);
    assert.match(exList.innerHTML, /off@example\.test/);
    // Dismiss hides the panel but keeps the run reachable from the toolbar.
    self.dismissFleetPanel();
    assert.equal(panel.hidden, true);
    assert.equal(reopen.hidden, false);
    self.reopenFleetPanel();
    assert.equal(panel.hidden, false);
    assert.equal(reopen.hidden, true);
  });
});

// ─── P1-8: usage page ──────────────────────────────────────────────────────
describe('usage answers "what is left" first (AC-USAGE-1..2)', () => {
  it('orders the cards remaining → used → limit → today', () => {
    const body = methodParts('renderAcuOrg').body;
    const order = ['cards.remaining', 'cards.used', 'cards.limit', 'cards.today'].map((k) => body.indexOf(`T('${k}')`));
    assert.ok(order.every((i) => i >= 0));
    for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], 'remaining must be first');
  });

  it('defines ACU and names workspaces, not orgs', () => {
    for (const [key, value] of [['page.usage', zh['page.usage']], ['nav.usage', zh['nav.usage']]]) {
      assert.equal(value, '用量', `${key} is plain 用量`);
    }
    assert.match(zh['pageSubtitle.usage'], /ACU 是 Devin 的用量单位/);
    assert.match(en['pageSubtitle.usage'], /ACU is Devin's usage unit/);
    assert.equal(zh['usage.org'], '工作区');
    assert.match(zh['usage.orgOption'], /工作区/);
    assert.doesNotMatch(zh['usage.orgOption'], /组织/);
  });

  it('falls back to a human sentence for an unmapped reason', () => {
    const self = baseSelf({});
    // I18n returns the key itself for a missing key — mirror that so the
    // fallback branch is the one under test.
    const i18n = {
      locale: 'zh-CN',
      t: (key, vars = {}) => (key === 'usage.reason.unknown'
        ? '暂时读不到用量，请稍后重试。'
        : (key === 'usage.rawTip'
          ? `技术详情：${vars.code}`
          : key)),
    };
    const reason = methodWithI18n('usageReason', i18n).call(self, 'not_a_known_reason');
    assert.equal(reason, '暂时读不到用量，请稍后重试。');
    const tip = methodWithI18n('usageReasonTip', i18n).call(self, 'not_a_known_reason');
    assert.match(tip, /技术详情：not_a_known_reason/);
  });
});

// ─── P1-9: login modal structure ───────────────────────────────────────────
describe('login tab is a method chooser (AC-LOGIN-1..3)', () => {
  const loginPanel = HTML.slice(
    HTML.indexOf('<div class="add-panel active" id="add-panel-login"'),
    HTML.indexOf('<div class="add-panel" id="add-panel-paste"'),
  );

  it('shows Devin portal access alongside the email and paste routes', () => {
    const step = loginPanel.slice(
      loginPanel.indexOf('id="wl-method-step"'),
      loginPanel.indexOf('id="wl-panel-email"'),
    );
    assert.match(step, /id="devin-sign-in" href="https:\/\/app\.devin\.ai\/" target="_blank" rel="noopener noreferrer"/);
    assert.match(step, /id="wl-method-email-btn"[\s\S]*App\.selectLoginMethod\('email'\)/);
    assert.match(step, /id="wl-method-token-btn"[\s\S]*App\.openCredentialPaste\(\)/);
    assert.ok(!/oauth-google-btn/.test(step), 'provider buttons stay behind the OAuth choice');
    assert.ok(!/id="wl-email"/.test(step), 'email fields stay behind the email choice');
  });

  it('keeps the proxy, saved password and login history behind 高级选项', () => {
    const advancedAt = loginPanel.indexOf('<details class="login-advanced"');
    assert.ok(advancedAt > 0);
    const advancedTag = loginPanel.slice(advancedAt, loginPanel.indexOf('>', advancedAt) + 1);
    assert.doesNotMatch(advancedTag, /\bopen\b/, 'closed by default');
    const advanced = loginPanel.slice(advancedAt);
    for (const id of ['wl-proxy-section', 'wl-store-cred', 'wl-history-table']) {
      assert.ok(advanced.includes(id), `${id} is inside the advanced disclosure`);
    }
  });

  it('switches to the existing masked paste field', () => {
    const calls = [];
    method('openCredentialPaste').call({
      switchAddTab: tab => calls.push(tab),
      focusCredentialPaste: id => calls.push(id),
    });
    assert.deepEqual(calls, ['paste', 'acc-key']);
    assert.match(HTML, /id="acc-key" type="password"/);
  });

  it('leaving email sign-in invalidates its active attempt and keeps the address', () => {
    const step = element('wl-method-step');
    const email = element('wl-panel-email');
    const emailInput = element('wl-email');
    emailInput.value = 'kept@example.test';
    let cancelled = 0;
    const self = baseSelf({ _wlFlow: 'fixture-flow', resetEmailCodeForm: () => { cancelled++; } });
    const select = method('selectLoginMethod');
    select.call(self, 'email');
    assert.equal(step.classList.contains('hidden'), true);
    assert.equal(email.classList.contains('hidden'), false);
    select.call(self, null);
    assert.equal(step.classList.contains('hidden'), false);
    assert.equal(email.classList.contains('hidden'), true);
    assert.equal(emailInput.value, 'kept@example.test');
    assert.equal(cancelled, 1);
  });

  it('a fresh open starts at the chooser; a bound email starts on the email form', () => {
    const source = methodParts('openAddAccountModal').body;
    assert.match(source, /if \(this\._addTab === 'login'\) this\.selectLoginMethod\(email \|\| accountId \? 'email' : null\)/);
  });
});

// ─── No KPI regression ─────────────────────────────────────────────────────
describe('KPI strip stays a five-cell partition', () => {
  it('renders total / healthy / switched off / attention / balance', () => {
    const el = element('accounts-kpis');
    const self = baseSelf({});
    method('renderAccountsKpis').call(self, {
      total: 8, stateCounts: { active: 4, disabled: 1, banned: 1, reauth: 1, error: 1 },
      attention: 3, balanceAccounts: 2, balanceSharedAccounts: 0,
    }, 8);
    assert.equal((el.innerHTML.match(/class="acct-kpi"/g) || []).length, 5);
    for (const key of ['total', 'active', 'disabled', 'attention', 'balance']) {
      assert.match(el.innerHTML, new RegExp(`data-kpi="${key}"`));
    }
    assert.match(el.innerHTML, /data-kpi="attention" data-value="3"/);
    assert.match(el.innerHTML, /data-kpi="disabled" data-value="1"/);
  });
});
