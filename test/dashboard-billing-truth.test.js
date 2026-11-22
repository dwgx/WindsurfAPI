// Q3 billing-truth guards: an absent upstream value is "unknown", never 0.
//
// Three user-visible lies lived in the dashboard:
//   1. `/usage` overview card printed `${availableCredits ?? 0} credits`, so a
//      null (field absent / read failed) rendered "0 credits" — an assertion that
//      the account has no credits, which is the opposite of "not reported".
//   2. The drawer rendered `a.periodStart/periodEnd` under "Period start/end".
//      Those fields are the protobuf decoder's deprecated aliases for the DAILY
//      and WEEKLY QUOTA RESET timestamps (src/devin-connect-catalog.js), not a
//      billing period; the zh label even said 账期 (billing cycle).
//   3. `tooltip.help.weeklyQuota` described the percentage as "consumed" while
//      every consumer renders it as REMAINING (low = dry).
//
// These execute the SHIPPED template methods (brace-sliced out of index.html),
// not a mirror implementation — same technique as dashboard-spend-acu.test.js.
// The stub I18n returns `i18n:<key>` so an assertion can name which key drove
// which cell; the point is that a future edit cannot silently re-introduce the
// fabricated zero while the test still passes.

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');
const EN = JSON.parse(readFileSync(new URL('../src/dashboard/i18n/en.json', import.meta.url), 'utf8'));
const ZH = JSON.parse(readFileSync(new URL('../src/dashboard/i18n/zh-CN.json', import.meta.url), 'utf8'));

function methodParts(name) {
  let at = HTML.indexOf(`\n  ${name}(`);
  if (at === -1) at = HTML.indexOf(`\n  async ${name}(`);
  assert.notEqual(at, -1, `${name} must exist as a method in the dashboard App object`);
  // Match the parameter list first: a default like `cr = {}` contains a brace
  // that must not be mistaken for the body opener.
  const parenOpen = HTML.indexOf('(', at);
  let depthParen = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < HTML.length; i++) {
    if (HTML[i] === '(') depthParen++;
    else if (HTML[i] === ')' && --depthParen === 0) { parenClose = i; break; }
  }
  assert.notEqual(parenClose, -1, `could not delimit the parameters of ${name}`);
  const params = HTML.slice(parenOpen, parenClose + 1);
  const open = HTML.indexOf('{', parenClose);
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
  t: (key, vars) => (vars ? `i18n:${key}|${JSON.stringify(vars)}` : `i18n:${key}`),
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const self = { esc };
self.poolBalanceText = (stats) => poolBalanceText(I18n, self, stats);
// The drawer reads the signed overage balance through the same formatter the
// ACU panel uses, so the stub delegates to the shipped method.
self.fmtCreditBalance = (value) => renderer('fmtCreditBalance')(I18n, self, value);

function renderer(name) {
  const { params, body } = methodParts(name);
  // eslint-disable-next-line no-new-func -- executing the shipped source is the point
  return new Function('I18n', 'self', '...args', `return (function ${name}${params} ${body}).apply(self, args);`);
}

let renderUsageCard;
let renderPlanCard;
let creditText;
let poolBalanceText;
before(() => {
  for (const name of ['usageRemainingPercentage', 'fmtUsageRemaining']) {
    const fn = renderer(name);
    self[name] = (...args) => fn(I18n, self, ...args);
  }
  renderUsageCard = renderer('renderUsageCard');
  renderPlanCard = renderer('renderPlanCard');
  creditText = renderer('creditText');
  poolBalanceText = renderer('poolBalanceText');
});

describe('overview usage card — available credits', () => {
  const card = (credits) => renderUsageCard(I18n, self, {
    ok: true,
    plan: 'free',
    quota: { dailyPercentage: 3, weeklyPercentage: 1 },
    availableCredits: credits,
  });

  it('renders an absent value as an em dash, never as 0', () => {
    for (const unknown of [null, undefined]) {
      const html = card(unknown);
      assert.match(html, /— credits/, 'unknown credits must render as — credits');
      assert.doesNotMatch(html, /\b0 credits/, 'unknown credits must never render as 0 credits');
    }
  });

  it('keeps a real upstream zero (free plan, no purchased credits)', () => {
    assert.match(card(0), /\b0 credits/);
  });

  it('renders a reported amount verbatim', () => {
    assert.match(card(1234), /\b1234 credits/);
  });

  it('renders no card at all when the usage read failed', () => {
    assert.equal(renderUsageCard(I18n, self, { ok: false }), '');
    assert.equal(renderUsageCard(I18n, self, null), '');
  });

  it('is wired into loadOverview (the fabrication cannot come back)', () => {
    assert.match(HTML, /const usageCard = this\.renderUsageCard\(usage\)/);
    assert.doesNotMatch(HTML, /availableCredits \?\? 0/);
  });
});

describe('overview usage card — plan label', () => {
  // `plan` is upstream billing text (`plan_slug`), not operator input: a hostile or
  // compromised upstream response must not be able to inject markup into the
  // dashboard. The ACU org panel escapes its copy of the same field
  // (renderAcuOrg → this.esc(plan)); this card is the other sink.
  const hostile = '<img src=x onerror="alert(1)">';

  it('escapes the upstream plan instead of interpolating it raw', () => {
    const html = renderUsageCard(I18n, self, {
      ok: true,
      plan: hostile,
      quota: { dailyPercentage: 3, weeklyPercentage: 1 },
      availableCredits: 5,
    });
    assert.doesNotMatch(html, /<img/i, 'hostile plan text must never reach the markup as a tag');
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/,
      'the plan must render escaped, exactly like the ACU panel copy');
  });

  it('keeps the em-dash fallback for an absent plan', () => {
    const html = renderUsageCard(I18n, self, { ok: true, quota: {}, availableCredits: 0 });
    assert.match(html, /<div class="card-value"[^>]*>—<\/div>/);
    assert.match(html, /<div class="card-sub">— · .* —<\/div>/);
    assert.doesNotMatch(html, /—%/);
  });
});

describe('account drawer — plan card labels', () => {
  const PERIOD_START = Date.UTC(2026, 9, 21, 8, 0, 0);
  const PERIOD_END = Date.UTC(2026, 9, 25, 8, 0, 0);
  const CR = {
    planName: 'Pro',
    planStart: '2026-10-16T20:11:50Z',
    planEnd: '2026-11-16T20:11:50Z',
  };

  it('labels the deprecated period aliases as quota resets, not a billing period', () => {
    const html = renderPlanCard(
      I18n, self,
      { tier: 'pro', periodStart: PERIOD_START, periodEnd: PERIOD_END },
      CR,
      {},
    );
    assert.match(html, /i18n:account\.detail\.plan\.dailyReset/);
    assert.match(html, /i18n:account\.detail\.plan\.weeklyReset/);
    assert.doesNotMatch(html, /plan\.periodStart|plan\.periodEnd/);
    assert.ok(html.includes(new Date(PERIOD_START).toLocaleString()),
      'the daily reset timestamp must be rendered');
    assert.ok(html.includes(new Date(PERIOD_END).toLocaleString()),
      'the weekly reset timestamp must be rendered');
  });

  it('still renders the real plan cycle from GetUserStatus', () => {
    const html = renderPlanCard(
      I18n, self,
      { tier: 'pro', periodStart: PERIOD_START, periodEnd: PERIOD_END },
      CR,
      {},
    );
    assert.match(html, /i18n:account\.detail\.plan\.start/);
    assert.match(html, /i18n:account\.detail\.plan\.end/);
    assert.ok(html.includes(new Date(CR.planStart).toLocaleDateString()),
      'the real plan start must survive the relabel');
    assert.ok(html.includes(new Date(CR.planEnd).toLocaleDateString()),
      'the real plan end must survive the relabel');
  });

  it('omits reset rows when the decoder produced no reset timestamps', () => {
    const html = renderPlanCard(I18n, self, { tier: 'free' }, { planName: 'Free' }, {});
    assert.doesNotMatch(html, /dailyReset|weeklyReset/);
    assert.match(html, /i18n:account\.detail\.plan\.start/);
  });

  it('i18n: both locales name the rows after the daily/weekly quota reset', () => {
    assert.equal(EN.account.detail.plan.dailyReset, 'Daily quota reset');
    assert.equal(EN.account.detail.plan.weeklyReset, 'Weekly quota reset');
    assert.equal(ZH.account.detail.plan.dailyReset, '每日配额重置');
    assert.equal(ZH.account.detail.plan.weeklyReset, '每周配额重置');
    assert.equal(EN.account.detail.plan.periodStart, undefined);
    assert.equal(ZH.account.detail.plan.periodStart, undefined);
  });
});

describe('account drawer — signed overage balance', () => {
  const card = (overage) => renderPlanCard(
    I18n, self,
    { tier: 'pro' },
    { planName: 'Pro', overageBalance: overage },
    {},
  );

  it('renders an overdrawn balance with its sign and the overdrawn label', () => {
    const html = card(-0.1);
    assert.match(html, /i18n:account\.detail\.plan\.overage/);
    assert.match(html, /<span class="v">-\$0\.10 \(i18n:usage\.overdrawn\)<\/span>/,
      'a negative balance must keep its sign and say it is overdrawn');
    assert.doesNotMatch(html, /\$-0\.1000/, 'the sign must not sit before the currency symbol');
  });

  it('never flattens a sub-cent debt to -$0.00', () => {
    const html = card(-0.0000001);
    assert.match(html, /-\$0\.0000001/, 'the magnitude must survive below one cent');
    assert.doesNotMatch(html, /-\$0\.00\b/, 'a real debt must never render as -$0.00');
    assert.match(html, /i18n:usage\.overdrawn/);
  });

  it('keeps a real zero and a positive balance unsigned', () => {
    assert.match(card(0), /<span class="v">\$0\.00<\/span>/);
    assert.match(card(2.5), /<span class="v">\$2\.50<\/span>/);
    assert.doesNotMatch(card(2.5), /overdrawn/);
  });

  it('omits the row entirely when upstream reported no balance', () => {
    for (const unknown of [null, undefined]) {
      assert.doesNotMatch(card(unknown), /plan\.overage/, 'an absent balance must not render a row');
    }
  });

  it('no longer formats the drawer row with toFixed', () => {
    assert.doesNotMatch(HTML, /overageBalance\.toFixed/);
    assert.match(HTML, /this\.fmtCreditBalance\(cr\.overageBalance\)/);
  });
});

describe('account drawer — prompt/flex credit amounts', () => {
  it('an absent remaining/used value is an em dash, not 0', () => {
    assert.equal(creditText(I18n, self, null), '—');
    assert.equal(creditText(I18n, self, undefined), '—');
  });

  it('keeps real zeros and amounts', () => {
    assert.equal(creditText(I18n, self, 0), 0);
    assert.equal(creditText(I18n, self, 25), 25);
  });

  it('is wired into the quota card (no `?? 0` on credit amounts)', () => {
    assert.match(HTML, /this\.creditText\(cr\.prompt\.remaining\)/);
    assert.match(HTML, /this\.creditText\(cr\.prompt\.used\)/);
    assert.match(HTML, /this\.creditText\(cr\.flex\.remaining\)/);
    assert.match(HTML, /this\.creditText\(cr\.flex\.used\)/);
    assert.doesNotMatch(HTML, /(?:remaining|used) \?\? 0/);
  });
});

describe('accounts page — pool balance', () => {
  it('reports unknown when no account reported a balance', () => {
    assert.equal(poolBalanceText(I18n, self, {}), '—');
    assert.equal(poolBalanceText(I18n, self, { balanceTotal: 0, balanceAccounts: 0 }), '—');
  });

  it('keeps a real reported zero and a real sum', () => {
    assert.equal(poolBalanceText(I18n, self, { balanceTotal: 0, balanceAccounts: 1 }), '$0.00');
    assert.equal(poolBalanceText(I18n, self, { balanceTotal: 12.5, balanceAccounts: 2 }), '$12.50');
  });

  it('renders the KPI cell from the same helper', () => {
    const el = { innerHTML: '' };
    const document = { getElementById: (id) => (id === 'accounts-kpis' ? el : null) };
    const run = (stats) => {
      const { params, body } = methodParts('renderAccountsKpis');
      // eslint-disable-next-line no-new-func -- executing the shipped source is the point
      const fn = new Function('I18n', 'self', 'document', `return (function renderAccountsKpis${params} ${body}).apply(self, arguments.length > 3 ? [arguments[3], arguments[4]] : []);`);
      el.innerHTML = '';
      fn(I18n, self, document, stats);
      return el.innerHTML;
    };

    const unknown = run({ total: 3, active: 2, balanceTotal: 0, balanceAccounts: 0 });
    assert.match(unknown, />—<\/div>/, 'the balance KPI must show an em dash');
    assert.doesNotMatch(unknown, /\$0\.00/, 'no account reported a balance — $0.00 is fabricated');

    const known = run({ total: 3, active: 2, balanceTotal: 12.5, balanceAccounts: 1 });
    assert.match(known, />\$12\.50<\/div>/);
  });

  it('no balanceTotal coercion can print a fabricated $0.00', () => {
    assert.doesNotMatch(HTML, /balanceTotal \|\| 0\)\.toFixed/);
    assert.match(HTML, /this\.poolBalanceText\(stats\)/);
  });
});

describe('weekly quota tooltip', () => {
  it('describes a remaining percentage, not consumed', () => {
    assert.match(EN.tooltip.help.weeklyQuota, /still remaining/);
    assert.doesNotMatch(EN.tooltip.help.weeklyQuota, /consumed/);
    assert.match(ZH.tooltip.help.weeklyQuota, /剩余/);
    assert.doesNotMatch(ZH.tooltip.help.weeklyQuota, /已用/);
  });
});
