// Render guards for the ACU & usage panel (Q3).
//
// Executes the SHIPPED template methods (brace-sliced out of index.html), not a
// mirror implementation — same technique as dashboard-devin-cards-render.test.js.
// The I18n stub returns `i18n:<key>` so an assertion names the key that drove a
// cell; hostile upstream text must never reach the markup unescaped.

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

function methodParts(name) {
  let at = HTML.indexOf(`\n  ${name}(`);
  if (at === -1) at = HTML.indexOf(`\n  async ${name}(`);
  assert.notEqual(at, -1, `${name} must exist as a method in the dashboard App object`);
  const open = HTML.indexOf('{', at);
  const params = HTML.slice(HTML.indexOf(name, at) + name.length, open).trim();
  let depth = 0;
  let end = -1;
  for (let i = open; i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.notEqual(end, -1, `could not delimit the body of ${name}`);
  return { params, body: HTML.slice(open, end) };
}

const I18n = {
  locale: 'en',
  t(key, vars) {
    if (vars && Object.keys(vars).length) {
      return `i18n:${key}|${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')}`;
    }
    return `i18n:${key}`;
  },
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fn(name) {
  const { params, body } = methodParts(name);
  // eslint-disable-next-line no-new-func -- executing the shipped source is the point
  const raw = new Function('I18n', 'self', '...args', `return (function ${name}${params} ${body}).apply(self, args);`);
  return (...args) => raw(I18n, self, ...args);
}

const self = {
  esc,
  dmAgo: (ts) => (ts ? '5m' : '—'),
};

before(() => {
  for (const name of ['fmtAcu', 'fmtCreditBalance', 'fmtUsageDate', 'fmtUsageDateTime', 'usageRemainingPercentage', 'usageReason', 'usageReasonTip', 'renderAcuOrgError']) {
    self[name] = fn(name);
  }
  self.renderAcuOrg = fn('renderAcuOrg');
  self.renderUsageEmpty = fn('renderUsageEmpty');
  self.renderUsageOrgBar = fn('renderUsageOrgBar');
});

function baseOrg(overrides = {}) {
  return {
    ok: true,
    orgRef: 'orgref-0123456789ab',
    accounts: [{ id: 'a1', ref: 'acct-11111111' }, { id: 'a2', ref: 'acct-22222222' }],
    plan: 'pro',
    billingValid: true,
    billingMethod: 'stripe',
    availableCredits: 0,
    overageCredits: 0,
    cached: false,
    stale: false,
    partial: false,
    cycle: {
      start: '2026-10-16T20:11:50+00:00',
      end: '2026-11-16T20:11:50+00:00',
      total: 12.5,
    },
    limits: { maxAcuLimit: 20, maxTotalSessionAcuLimit: null },
    quota: {
      dailyPercentage: 70,
      weeklyPercentage: 80,
      dailyResetAt: '2026-10-23T00:00:00-08:00',
      weeklyResetAt: '2026-10-26T00:00:00-08:00',
    },
    days: [
      { date: '2026-10-20', amount: 10, cumulative: 10 },
      { date: '2026-10-21', amount: 2.5, cumulative: 12.5 },
    ],
    products: [
      { view: 'sessions', total: 10, days: [{ date: '2026-10-21', amount: 2.5, cumulative: 10 }] },
      { view: 'code-scans', total: 2.5, days: [] },
    ],
    derived: {
      acuLimit: { value: 20, known: true, unlimited: false, reason: 'reported' },
      used: { value: 12.5, known: true, reason: 'reported' },
      remaining: { value: 7.5, known: true, unlimited: false, derived: true, reason: 'derived' },
      latestDay: { date: '2026-10-21', amount: 2.5, cumulative: 12.5 },
    },
    sources: {
      quota: { ok: true },
      status: { ok: true },
      limits: { ok: true },
      daily: { ok: true },
    },
    ...overrides,
  };
}

const payload = { ok: true, generatedAt: Date.now(), accountsScanned: 2, orgs: [] };

describe('renderAcuOrg — ACU limit / used / remaining', () => {
  it('shows remaining prompt quota while preserving missing data', () => {
    const html = self.renderAcuOrg(baseOrg({
      quota: { dailyPercentage: 68, weeklyPercentage: 34 },
    }), payload);
    assert.match(html, /class="bar-pct"[^>]*>32%/);
    assert.match(html, /class="bar-pct"[^>]*>66%/);
    const missing = self.renderAcuOrg(baseOrg({
      quota: { dailyPercentage: 100, weeklyPercentage: null },
    }), payload);
    assert.match(missing, /class="bar-pct"[^>]*>0%/);
    assert.match(missing, /class="bar-pct"[^>]*>—/);
  });

  it('renders the three derived cells and the latest day', () => {
    const html = self.renderAcuOrg(baseOrg(), payload);
    assert.match(html, /i18n:usage\.cards\.limit/);
    assert.match(html, /i18n:usage\.cards\.used/);
    assert.match(html, /i18n:usage\.cards\.remaining/);
    assert.match(html, /i18n:usage\.cards\.today/);
    assert.match(html, />20</, 'reported ACU limit must be on screen');
    assert.match(html, />12\.5</, 'cycle total must be on screen');
    assert.match(html, />7\.5</, 'derived remaining must be on screen');
    assert.match(html, />2\.5</, 'latest day amount must be on screen');
    assert.match(html, /i18n:usage\.derivedTip/, 'remaining must disclose that it is derived');
    // P1-8: the page answers "what is left" before "what is the cap".
    const order = ['remaining', 'used', 'limit', 'today'].map((k) => html.indexOf(`i18n:usage.cards.${k}`));
    assert.ok(order.every((i) => i >= 0));
    for (let i = 1; i < order.length; i++) {
      assert.ok(order[i] > order[i - 1], `usage.cards.${['remaining', 'used', 'limit', 'today'][i]} must follow the previous card`);
    }
  });

  it('renders a null limit as unlimited and an absent total as an em dash, never 0', () => {
    const org = baseOrg({
      limits: { maxAcuLimit: null, maxTotalSessionAcuLimit: null },
      cycle: { start: '2026-10-16T20:11:50+00:00', end: '2026-11-16T20:11:50+00:00', total: null },
      availableCredits: null,
      overageCredits: null,
      days: [],
      products: [],
      derived: {
        acuLimit: { value: null, known: false, unlimited: true, reason: 'unlimited' },
        used: { value: null, known: false, reason: 'absent_on_wire' },
        remaining: { value: null, known: false, unlimited: true, derived: false, reason: 'unlimited' },
        latestDay: null,
      },
    });
    const html = self.renderAcuOrg(org, payload);
    assert.match(html, /i18n:usage\.unlimited/, 'null limit renders as unlimited');
    assert.doesNotMatch(html, />0</, 'unknown values must never render as a fabricated zero');
    assert.match(html, /—/, 'unknown cells use an em dash');
  });

  it('renders cycle dates and quota bars', () => {
    const html = self.renderAcuOrg(baseOrg(), payload);
    assert.match(html, /Oct 1[67], 2026/, 'cycle start is formatted');
    assert.match(html, /Nov 1[67], 2026/, 'cycle end is formatted');
    assert.match(html, /i18n:usage\.dailyQuota/);
    assert.match(html, /i18n:usage\.weeklyQuota/);
    assert.match(html, /class="bar-pct"[^>]*>30%<\/span>/, 'daily: 100% minus 70% consumed');
    assert.match(html, /class="bar-pct"[^>]*>20%<\/span>/, 'weekly: 100% minus 80% consumed');
  });

  it('renders per-product rows with localized labels and share', () => {
    const html = self.renderAcuOrg(baseOrg(), payload);
    assert.match(html, /i18n:usage\.product\.sessions/);
    assert.match(html, /i18n:usage\.product\.code-scans/);
    assert.match(html, /80\.0%/, 'sessions share = 10 / 12.5');
    assert.match(html, /20\.0%/, 'code-scans share = 2.5 / 12.5');
  });

  it('renders the empty states for no days and no products', () => {
    const org = baseOrg({ days: [], products: [], derived: { ...baseOrg().derived, latestDay: null } });
    const html = self.renderAcuOrg(org, payload);
    assert.match(html, /i18n:usage\.daysEmpty/);
    assert.match(html, /i18n:usage\.productsEmpty/);
  });

  it('escapes hostile upstream product views and dates', () => {
    const org = baseOrg({
      products: [{ view: '<img src=x onerror=alert(1)>', total: 1, days: [] }],
      days: [{ date: '<script>alert(1)</script>', amount: 1, cumulative: 1 }],
    });
    const html = self.renderAcuOrg(org, payload);
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;img/);
  });

  it('renders a per-org error with its reason and a retry action', () => {
    const org = { ok: false, error: 'forbidden', httpStatus: 403, accounts: [{ id: 'a1' }], sources: {} };
    const html = self.renderAcuOrg(org, payload);
    assert.match(html, /i18n:usage\.errorTitle/);
    assert.match(html, /i18n:usage\.reason\.forbidden/);
    assert.match(html, /App\.loadUsage\(true\)/);
  });

  it('shows partial-source failures without hiding the data', () => {
    const org = baseOrg({
      partial: true,
      sources: { ...baseOrg().sources, daily: { ok: false, error: 'timeout' } },
    });
    const html = self.renderAcuOrg(org, payload);
    assert.match(html, /i18n:usage\.partial/);
    assert.match(html, /i18n:usage\.reason\.timeout/);
    assert.match(html, />20</, 'the limit still renders when one source failed');
  });
});

describe('renderAcuOrg — overage balance is signed, never clamped', () => {
  // Regression: the panel showed the raw upstream `overage_credits` as
  // "-0.1 credits" under a label that implied an available count. The value is
  // a signed USD balance: a negative one is an overdraft and must stay visible
  // (clamping to 0 would assert a zero balance the upstream never reported).
  const row = (overageCredits) => self.renderAcuOrg(baseOrg({ overageCredits }), payload);

  it('renders a negative balance with its sign and an overdrawn marker', () => {
    const html = row(-0.1);
    assert.match(html, /i18n:usage\.overageBalance/, 'the row is named as a balance, not a credit count');
    assert.match(html, /-\$0\.10/, 'the negative balance is shown as -$0.10');
    assert.match(html, /i18n:usage\.overdrawn/, 'a negative balance is labelled overdrawn');
    assert.doesNotMatch(html, /overageBalance<\/span><span class="v">\$0\.00/, 'the overdraft is not clamped to zero');
  });

  it('keeps positive and zero balances unsigned and unmarked', () => {
    const positive = row(12.34);
    assert.match(positive, /\$12\.34/);
    assert.doesNotMatch(positive, /i18n:usage\.overdrawn/);

    const zero = row(0);
    assert.match(zero, /\$0\.00/);
    assert.doesNotMatch(zero, /i18n:usage\.overdrawn/);
  });

  it('keeps a sub-cent balance visible instead of flattening it to $0.00', () => {
    const html = row(-0.0006735);
    assert.match(html, /-\$0\.000674/, 'micro-dollar precision survives formatting');
    assert.doesNotMatch(html, /-\$0\.00</, 'a real balance must not render as negative zero');

    const tiny = row(-1e-9);
    assert.match(tiny, /-\$0\.000000001/, 'even a sub-micro value keeps its magnitude');
    assert.doesNotMatch(tiny, /-\$0\.00</, 'rounding must never manufacture negative zero');
  });

  it('renders an absent balance as an em dash, never as $0.00', () => {
    const html = row(null);
    assert.match(html, /overageBalance<\/span><span class="v">—/);
    assert.doesNotMatch(html, /overageBalance<\/span><span class="v">\$0\.00/);
  });
});

describe('renderUsageOrgBar — dedupe by org', () => {
  it('renders one badge when only one org exists', () => {
    const html = self.renderUsageOrgBar([baseOrg()]);
    assert.match(html, /i18n:usage\.org/);
    assert.match(html, /i18n:usage\.singleOrg\|plan=pro,count=2/);
    assert.doesNotMatch(html, /seg-btn/);
  });

  it('renders one radio button per distinct org', () => {
    const html = self.renderUsageOrgBar([baseOrg(), baseOrg({ plan: 'free', accounts: [{ id: 'b1' }] })]);
    assert.equal((html.match(/role="radio"/g) || []).length, 2);
    assert.match(html, /role="radiogroup"/);
    assert.match(html, /i18n:usage\.orgOption\|index=1,plan=pro,count=2/);
    assert.match(html, /i18n:usage\.orgOption\|index=2,plan=free,count=1/);
  });
});

describe('renderUsageEmpty', () => {
  it('distinguishes no-account from a real upstream error', () => {
    const noAccount = self.renderUsageEmpty({ ok: false, error: 'no_account', accountsScanned: 0, orgs: [] });
    assert.match(noAccount, /i18n:usage\.noAccountsTitle/);
    assert.match(noAccount, /i18n:usage\.noAccountsDesc/);

    const forbidden = self.renderUsageEmpty({ ok: false, error: 'forbidden', orgs: [] });
    assert.match(forbidden, /i18n:usage\.errorTitle/);
    assert.match(forbidden, /i18n:usage\.reason\.forbidden/);
    assert.match(forbidden, /App\.loadUsage\(true\)/);

    const empty = self.renderUsageEmpty({ ok: true, orgs: [] });
    assert.match(empty, /i18n:usage\.emptyTitle/);
    assert.match(empty, /i18n:usage\.emptyDesc/);

    const authFailure = self.renderUsageEmpty({ success: false, error: 'Unauthorized' });
    assert.match(authFailure, /i18n:usage\.errorTitle/);
    assert.match(authFailure, /Unauthorized/);
  });
});

describe('the panel is wired into navigation and the API', () => {
  it('declares the nav entry, the panel and the loader map', () => {
    assert.match(HTML, /data-panel="usage"/);
    assert.match(HTML, /id="p-usage"/);
    assert.match(HTML, /id="usage-content"/);
    assert.match(HTML, /usage: 'loadUsage'/);
    assert.match(HTML, /this\.api\('GET', '\/usage\/orgs'/);
  });
});
