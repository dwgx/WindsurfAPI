// Render guards for the DevIn panel page.
//
// These execute the SHIPPED template methods (brace-sliced out of index.html),
// not a mirror implementation — same technique as dashboard-devin-cards-render.
// The I18n stub returns `i18n:<key>` so an assertion can name the key that
// drove a cell; hostile upstream text must never reach the markup unescaped.

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
  t: (key, vars) => (vars && Object.keys(vars).length
    ? `i18n:${key}|${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')}`
    : `i18n:${key}`),
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const self = {
  esc,
  _devinModelFilters: { query: '', provider: '', reach: '', price: '' },
  _devinModelPage: 1,
  _devinModelSize: 25,
  dmAgo: (ts) => (ts ? '5m' : '—'),
  fmtAcu: (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '—'),
  fmtUsageDate: (v) => (v ? 'date' : '—'),
  fmtUsageDateTime: (v) => (v ? 'datetime' : '—'),
  devinReason(kind) {
    const key = 'devin.reason.' + String(kind || 'unknown');
    const text = I18n.t(key);
    return text === key ? I18n.t('devin.reason.unknown') : text;
  },
  devinUnavailable(P) {
    const detail = P && P.ok === false ? this.devinReason(P.error) : I18n.t('devin.unavailable');
    return `<div class="dm-empty">${this.esc(detail)}</div>`;
  },
};

function renderer(name) {
  const { params, body } = methodParts(name);
  // eslint-disable-next-line no-new-func -- executing the shipped source is the point
  return new Function('I18n', 'self', '...args', `return (function ${name}${params} ${body}).apply(self, args);`);
}

function asyncRenderer(name) {
  const { params, body } = methodParts(name);
  // eslint-disable-next-line no-new-func -- executing the shipped source is the point
  return new Function('I18n', '...args', `return (async function ${name}${params} ${body}).apply(this, args);`);
}

let renderDevinKpis;
let renderDevinRuntime;
let renderDevinSessions;
let renderDevinCatalog;
let renderDevinQuota;
let renderDevinSettings;
let loadDevin;
before(() => {
  for (const name of ['usageRemainingPercentage', 'fmtUsageRemaining', 'devinPanelPath',
    'renderDevinPager', 'renderDevinCatalogRows', 'renderDevinCatalogPrice']) {
    const fn = renderer(name);
    self[name] = function (...args) { return fn(I18n, this, ...args); };
  }
  renderDevinKpis = renderer('renderDevinKpis');
  renderDevinRuntime = renderer('renderDevinRuntime');
  renderDevinSessions = renderer('renderDevinSessions');
  renderDevinCatalog = renderer('renderDevinCatalog');
  renderDevinQuota = renderer('renderDevinQuota');
  renderDevinSettings = renderer('renderDevinSettings');
  const load = asyncRenderer('loadDevin');
  loadDevin = function (...args) {
    Object.assign(this, { _devinPanelRequest: 0, _devinTurnPage: 1, _devinTurnSize: 100,
      devinPanelPath: self.devinPanelPath });
    return load.apply(this, args);
  };
});

describe('panel snapshot acceptance', () => {
  const okPanel = { ok: true, runtime: {}, sessions: {}, quota: {} };

  it('rejects the dashboard 500 envelope instead of painting it as an empty snapshot', async () => {
    // _apiRaw forces success:false onto a non-2xx body; the 500 envelope itself
    // carries {error:{message}} and no `ok`. It must become the failure card.
    const ctx = {
      api: async () => ({ error: { message: 'Internal error', type: 'server_error' }, success: false }),
      renderDevin() { this.rendered = true; },
    };
    await loadDevin.call(ctx);
    assert.equal(ctx._devinPanel.ok, false);
    assert.equal(ctx._devinPanel.error, 'Internal error', 'the reason must survive, not [object Object]');
    assert.equal(ctx.rendered, true, 'the page still repaints, into the failure card');
  });

  it('rejects an error-shaped body that has no ok/success flag', async () => {
    const ctx = {
      api: async () => ({ error: { message: 'boom' } }),
      renderDevin() {},
    };
    await loadDevin.call(ctx);
    assert.equal(ctx._devinPanel.ok, false);
    assert.equal(ctx._devinPanel.error, 'boom');
  });

  it('turns a transport failure into the generic reason', async () => {
    const ctx = {
      api: async () => { throw new Error('network down'); },
      renderDevin() {},
    };
    await loadDevin.call(ctx);
    assert.equal(ctx._devinPanel.ok, false);
    assert.equal(ctx._devinPanel.error, 'failed');
  });

  it('accepts the real snapshot and keeps the on-demand reads null', async () => {
    const ctx = {
      api: async (method, path) => (path === '/devin/panel?turnPage=1&turnPageSize=100'
        ? okPanel
        : path === '/models' ? { models: [{ id: 'swe-2' }] } : { synced: true }),
      renderDevin() {},
    };
    await loadDevin.call(ctx);
    assert.equal(ctx._devinPanel, okPanel);
    assert.deepEqual(ctx._devinModels, [{ id: 'swe-2' }]);
    assert.deepEqual(ctx._devinCatalog, { synced: true });
  });
});

function runtimePayload(over = {}) {
  return {
    ok: true,
    runtime: {
      uptimeSec: 3600,
      switches: [
        { key: 'devinConnect', value: true, source: 'config', overridden: true },
        { key: 'devinCliMode', value: 'acp', source: 'env', overridden: false },
      ],
      credentials: { credStoreEnabled: true, remoteCredStore: false, writable: false },
      langServer: {
        running: true, pid: 123, port: 42100, instances: 2, ready: 1,
        activeRequests: 3, totalRssBytes: 2048, admission: null,
      },
      detach: { enabled: true, entries: 2, bytes: 4096, draining: false, counters: { admit: 4, serve: 2, re_detach: 1 } },
      ...over,
    },
  };
}

describe('KPI row', () => {
  it('renders a failure card instead of zeros when the snapshot failed', () => {
    const html = renderDevinKpis(I18n, self, { ok: false, error: 'upstream' }, null, null);
    assert.match(html, /i18n:devin\.kpi\.failed/);
    assert.match(html, /i18n:devin\.reason\.upstream/);
    assert.doesNotMatch(html, /class="card (success|accent)"/);
  });

  it('summarises transport, turns, catalog and drought from real fields', () => {
    const panel = {
      ok: true,
      runtime: { switches: [{ key: 'devinConnect', value: true }, { key: 'devinCliMode', value: 'print' }] },
      sessions: { turns: { window: { turns: 7 }, accountsWithTurns: 2, retained: 40, scanned: 5 } },
      quota: { drought: { active: true, lowestWeeklyPercent: 12.5, lowestDailyPercent: 0 } },
    };
    const models = [
      { id: 'a', freeNow: true, reachable: true },
      { id: 'b', freeNow: false, reachable: false },
    ];
    const html = renderDevinKpis(I18n, self, panel, models, { synced: true, added: ['x'], missing: ['y'], liveCount: 9, snapshotCount: 8 });
    assert.match(html, /i18n:devin\.kpi\.on/);
    assert.match(html, /i18n:devin\.kpi\.modeSub\|cli=print/);
    assert.match(html, /i18n:devin\.kpi\.windowTurns[\s\S]*?>7</);
    assert.match(html, /1 \/ 2/, 'one of two models is free');
    assert.match(html, /i18n:devin\.kpi\.catalogDrift[\s\S]*?>2</);
    assert.match(html, /i18n:devin\.kpi\.droughtActive/);
  });

  it('shows a dash for the catalog KPIs when /models did not load', () => {
    const panel = { ok: true, runtime: {}, sessions: {}, quota: {} };
    const html = renderDevinKpis(I18n, self, panel, null, null);
    assert.match(html, /i18n:devin\.kpi\.noCatalog/);
    assert.match(html, /—/);
  });

  it('does not call an unsynced live catalog a zero drift', () => {
    const panel = { ok: true, runtime: {}, sessions: {}, quota: { drought: { coverageMet: true } } };
    const html = renderDevinKpis(I18n, self, panel, [], { synced: false, added: [], missing: [], liveCount: 0, snapshotCount: 12 });
    assert.match(html, /i18n:devin\.kpi\.catalogNotSynced/);
    assert.match(html, /i18n:devin\.kpi\.catalogDrift<\/div><\/div>\s*<div class="card-value"[^>]*>—</);
  });

  it('says the drought was not assessed when coverage is below the threshold', () => {
    const panel = {
      ok: true,
      runtime: {},
      sessions: {},
      quota: { drought: { active: false, coverageMet: false, lowestWeeklyPercent: null, lowestDailyPercent: null } },
    };
    const html = renderDevinKpis(I18n, self, panel, null, null);
    assert.match(html, /i18n:devin\.kpi\.droughtUnknown/);
    assert.doesNotMatch(html, /i18n:devin\.kpi\.droughtOk/);
  });
});

describe('runtime section', () => {
  it('renders LS, admission and detach facts', () => {
    const html = renderDevinRuntime(I18n, self, runtimePayload());
    assert.match(html, /i18n:devin\.runtime\.running/);
    assert.match(html, /1 \/ 2/, 'ready / instances');
    assert.match(html, /2 KB/, 'RSS formatted from bytes');
    assert.match(html, /i18n:devin\.runtime\.admit[\s\S]*?>4</);
    assert.match(html, /i18n:devin\.runtime\.serve[\s\S]*?>2</);
    assert.match(html, /i18n:devin\.runtime\.credStore/);
  });

  it('renders dashes (never zeros) when admission counters are absent', () => {
    const html = renderDevinRuntime(I18n, self, runtimePayload());
    const admissionBlock = html.slice(html.indexOf('i18n:devin.runtime.admission'));
    assert.match(admissionBlock, /—/);
  });

  it('renders a stopped server without inventing a pid', () => {
    const html = renderDevinRuntime(I18n, self, runtimePayload({
      langServer: { running: false, pid: null, port: null, instances: 0, ready: 0, activeRequests: 0, totalRssBytes: null, admission: null },
      detach: { enabled: false, entries: null, bytes: null, draining: null, counters: null },
    }));
    assert.match(html, /i18n:devin\.runtime\.stopped/);
    assert.match(html, /i18n:devin\.runtime\.pid[\s\S]*?>—</);
  });

  it('renders the unavailable note when the panel failed', () => {
    const html = renderDevinRuntime(I18n, self, { ok: false, error: 'failed' });
    assert.match(html, /i18n:devin\.reason\.failed/);
  });
});

describe('sessions section', () => {
  const base = {
    ok: true,
    sessions: {
      sources: [
        { id: 'proxyTurns', available: true, notes: ['billed_successes_only', 'process_local'] },
        { id: 'cascadeTrajectories', available: false, reason: 'ls_only' },
        { id: 'acpSessions', available: false, reason: 'not_tracked' },
      ],
      turns: {
        available: true,
        scanned: 3,
        accountsWithTurns: 1,
        retained: 2,
        summary: { totalTokens: 30, credit: 2, acu: 0.5 },
        window: { turns: 1 },
        items: [
          { ts: 1_700_000_000_000, accountRef: 'acct-aaaa1111', model: 'swe-2', promptTokens: 10, completionTokens: 5, totalTokens: 15, credit: 1, acu: 0.25 },
          { ts: 1_699_999_000_000, accountRef: 'acct-bbbb2222', model: 'swe-2-max', promptTokens: 10, completionTokens: 5, totalTokens: 15, credit: 1, acu: 0.25 },
        ],
      },
    },
  };

  it('names every source and marks the two unreadable ones with their reason', () => {
    const html = renderDevinSessions(I18n, self, base);
    assert.match(html, /data-devin-source="proxyTurns"/);
    assert.match(html, /data-devin-source="cascadeTrajectories"/);
    assert.match(html, /data-devin-source="acpSessions"/);
    assert.match(html, /i18n:devin\.sessions\.unavailable/);
    assert.match(html, /i18n:devin\.reason\.ls_only/);
    assert.match(html, /i18n:devin\.reason\.not_tracked/);
    assert.match(html, /i18n:devin\.reason\.billed_successes_only/);
  });

  it('renders the merged turns and the retained/window totals', () => {
    const html = renderDevinSessions(I18n, self, base);
    assert.match(html, /acct-aaaa1111/);
    assert.match(html, /swe-2-max/);
    assert.match(html, /i18n:devin\.sessions\.shown\|shown=2,retained=2/);
    assert.match(html, /i18n:devin\.sessions\.lastHour[\s\S]*?>1</);
  });

  it('shows the pool total and names the scanned count in the scan cap', () => {
    const payload = JSON.parse(JSON.stringify(base));
    payload.sessions.turns.scanned = 2;
    payload.sessions.turns.totalAccounts = 600;
    payload.sessions.turns.capped = true;
    const html = renderDevinSessions(I18n, self, payload);
    assert.match(html, /i18n:devin\.sessions\.scanned[\s\S]*?>2 \/ 600</);
    // The note must say how many were SCANNED (2), not repeat the pool size (600).
    assert.match(html, /i18n:devin\.sessions\.scanCapped\|scanned=2,total=600/);
  });

  it('keeps the source disclosure closed and offers all supported turn sizes', () => {
    const panel = structuredClone(base);
    panel.sessions.turns.page = { number: 2, size: 100, pages: 2, offset: 100, total: 102, sizes: [100, 200, 500, 1000] };
    panel.sessions.turns.perAccountLimit = 100;
    const html = renderDevinSessions(I18n, self, panel);
    assert.match(html, /<details class="dm-disclosure" id="devin-sessions-sources">/);
    assert.match(html, /i18n:devin\.sessions\.retentionHint\|limit=100/);
    assert.match(html, /i18n:devin\.pagination\.range\|from=101,to=102,total=102,page=2,pages=2/);
    for (const size of [100, 200, 500, 1000]) {
      assert.ok(html.includes('<option value="' + size + '"'));
    }
  });

  it('escapes hostile model text', () => {
    const payload = {
      ok: true,
      sessions: {
        sources: [],
        turns: {
          items: [{
            ts: 1, accountRef: 'acct-1', model: '<img src=x onerror=alert(1)>',
            promptTokens: 0, completionTokens: 0, totalTokens: 0, credit: 0, acu: 0,
          }],
          summary: {}, window: {},
        },
      },
    };
    const html = renderDevinSessions(I18n, self, payload);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  it('says the window is empty instead of rendering an empty table', () => {
    const payload = { ok: true, sessions: { sources: [], turns: { items: [], summary: {}, window: {} } } };
    const html = renderDevinSessions(I18n, self, payload);
    assert.match(html, /i18n:devin\.sessions\.empty/);
    assert.doesNotMatch(html, /i18n:devin\.sessions\.shown\|shown=[1-9]/, 'no turn table is rendered when there are no rows');
  });
});

describe('catalog section', () => {
  const models = [
    { id: 'swe-2', provider: 'windsurf', reachable: true, freeNow: true, freeReason: 'cost_tier_free', quotaState: 'free', costTier: 'MODEL_COST_TIER_FREE', pricingStale: false },
    { id: 'claude-4', provider: 'anthropic', reachable: true, freeNow: false, quotaState: 'unknown', costTier: 'MODEL_COST_TIER_HIGH', pricingStale: true },
    { id: 'gpt-5', provider: 'openai', reachable: false, freeNow: null, quotaState: 'blocked_daily', costTier: null, pricingStale: false },
    { id: 'ghost', provider: 'windsurf', reachable: false, freeNow: null, quotaState: 'not_in_catalog', costTier: null, pricingStale: false },
  ];

  it('counts the price tri-state and the quota states', () => {
    const html = renderDevinCatalog(I18n, self, models, null, null);
    assert.match(html, /i18n:devin\.catalog\.chip\.total 4/);
    assert.match(html, /i18n:devin\.catalog\.chip\.free 1/);
    assert.match(html, /i18n:devin\.catalog\.chip\.daily 1/);
    assert.match(html, /i18n:devin\.catalog\.chip\.notInCatalog 1/);
    assert.match(html, /i18n:devin\.catalog\.chip\.unknownPrice 2/);
    assert.match(html, /i18n:devin\.catalog\.chip\.stale 1/);
  });

  it('uses the shipped price badges rather than inventing a fourth state', () => {
    const html = renderDevinCatalog(I18n, self, models, null, null);
    assert.match(html, /i18n:model\.freeBadge/);
    assert.match(html, /i18n:model\.paidBadge/);
    assert.match(html, /i18n:model\.dailyExhaustedBadge/);
    assert.match(html, /i18n:model\.notInCatalogBadge/);
  });

  it('can navigate to catalog row 451 and filter on the actual selector', () => {
    const rows = Array.from({ length: 451 }, (_, index) => ({
      id: 'model-' + String(index + 1).padStart(3, '0'), name: 'Model ' + (index + 1),
      connectSelector: 'upstream-' + (index + 1), provider: 'provider-x', reachable: true, freeNow: null,
    }));
    const tail = renderDevinCatalog(I18n, { ...self, _devinModelPage: 19 }, rows, null, null);
    assert.match(tail, /<code>model-451<\/code>/);
    assert.doesNotMatch(tail, /<code>model-450<\/code>/);
    assert.match(tail, /i18n:devin\.pagination\.range\|from=451,to=451,total=451,page=19,pages=19/);
    const filters = { query: 'UPSTREAM-451', provider: 'provider-x', reach: 'reachable', price: 'unknown' };
    const result = renderDevinCatalog(I18n, { ...self, _devinModelFilters: filters }, rows, null, null);
    assert.match(result, /<code>model-451<\/code>/);
    assert.match(result, /i18n:devin\.pagination\.range\|from=1,to=1,total=1,page=1,pages=1/);
    const empty = renderDevinCatalog(I18n, { ...self, _devinModelFilters: { ...filters, price: 'paid' } }, rows, null, null);
    assert.match(empty, /i18n:devin\.catalog\.noMatch/);
    assert.doesNotMatch(empty, /<table id="devin-model-table"/);
  });

  it('keeps a cached rate visible when quota blocks the row and leaves unknown rates blank', () => {
    const quoted = { id: 'quoted', provider: 'test', reachable: false, freeNow: false, quotaState: 'blocked_daily',
      creditRate: 2.125, creditRateFetchedAt: 12, creditRateStale: true };
    const unknown = { id: 'unreported', provider: 'test', reachable: true, freeNow: false, credit: 99, creditRate: null };
    const html = renderDevinCatalog(I18n, { ...self }, [quoted, unknown], null, null);
    assert.match(html, /i18n:devin\.catalog\.pricing\.rate\|rate=2[.,]125/);
    assert.match(html, /i18n:devin\.catalog\.pricing\.cachedAt\|date=datetime/);
    assert.match(html, /i18n:devin\.catalog\.pricing\.stale/);
    assert.match(html, /i18n:model\.dailyExhaustedBadge/);
    assert.match(html, /i18n:devin\.catalog\.pricing\.unreported/);
    assert.doesNotMatch(html, /rate=99/);
  });

  it('renders the catalog diff and the reconcile idle note', () => {
    const html = renderDevinCatalog(I18n, self, models, {
      synced: true, liveCount: 9, snapshotCount: 8, added: ['new-1'], missing: ['old-1'], unmappedCount: 1,
    }, null);
    assert.match(html, /i18n:devin\.catalog\.diff\.added/);
    assert.match(html, /new-1/);
    assert.match(html, /old-1/);
    assert.match(html, /i18n:devin\.catalog\.reconcile\.idle/);
  });

  it('renders a partial reconcile with the degraded source names', () => {
    const html = renderDevinCatalog(I18n, self, models, null, {
      ok: true, accountRef: 'acct-1', localCount: 10, liveCount: 9, snapshotCount: 8,
      partial: true, stale: false, degraded: [{ source: 'fed-models', kind: 'upstream' }],
    });
    assert.match(html, /i18n:devin\.catalog\.reconcile\.partial/);
    assert.match(html, /i18n:devin\.catalog\.reconcile\.degraded\|sources=fed-models/);
  });

  it('renders a load failure instead of an empty table', () => {
    const html = renderDevinCatalog(I18n, self, null, null, null);
    assert.match(html, /i18n:error\.loadFailed/);
  });
});

describe('quota section', () => {
  const panel = {
    ok: true,
    quota: {
      drought: {
        active: true, threshold: 20, lowestWeeklyPercent: 12.5, lowestDailyPercent: 0,
        droughtAccounts: 1, quotaKnownAccounts: 3, coverageMet: true,
        restrictEnabled: true, restrictionFailOpen: false, freeTierModels: ['swe-2'],
      },
      knobs: [],
    },
  };

  it('renders the drought verdict from the payload', () => {
    const html = renderDevinQuota(I18n, self, panel, null);
    assert.match(html, /i18n:devin\.quota\.active/);
    assert.match(html, /13%/, '12.5 rounds to 13%');
    assert.match(html, /swe-2/);
    assert.match(html, /i18n:devin\.quota\.acu\.idle/);
  });

  it('says the drought was not assessed when coverage is below the threshold', () => {
    // isDroughtMode() forces active=false when coverage is insufficient
    // (auth.js:234-240); rendering that as "Clear" contradicts the KPI.
    const low = {
      ok: true,
      quota: {
        drought: { active: false, coverageMet: false, lowestWeeklyPercent: null, lowestDailyPercent: null },
        knobs: [],
      },
    };
    const html = renderDevinQuota(I18n, self, low, null);
    assert.match(html, /i18n:devin\.quota\.unknown/);
    assert.doesNotMatch(html, /i18n:devin\.quota\.ok/);
  });

  it('says clear only when coverage is sufficient', () => {
    const clear = {
      ok: true,
      quota: { drought: { active: false, coverageMet: true }, knobs: [] },
    };
    const html = renderDevinQuota(I18n, self, clear, null);
    assert.match(html, /i18n:devin\.quota\.ok/);
    assert.doesNotMatch(html, /i18n:devin\.quota\.unknown/);
  });

  it('renders the workspace ACU cards when the operator loaded them', () => {
    const acu = {
      ok: true,
      generatedAt: 1_700_000_000_000,
      orgs: [{
        ok: true,
        plan: 'pro',
        accounts: [{ id: 'a', ref: 'acct-1' }],
        derived: {
          acuLimit: { value: 100, known: true, unlimited: false },
          used: { value: 40, known: true },
          remaining: { value: 60, known: true, derived: true },
        },
        cycle: { end: '2026-11-01' },
        quota: { dailyPercentage: 30, weeklyPercentage: 55, dailyResetAt: '2026-10-24T00:00:00Z', weeklyResetAt: null },
      }],
    };
    const html = renderDevinQuota(I18n, self, panel, acu);
    assert.match(html, /i18n:devin\.quota\.acu\.title/);
    assert.match(html, /i18n:usage\.orgOption/);
    assert.match(html, />60</, 'remaining = 100 - 40');
    assert.match(html, />40</);
    assert.match(html, />100</);
  });

  it('renders the reason when the ACU read failed', () => {
    const html = renderDevinQuota(I18n, self, panel, { ok: false, error: 'no_account', orgs: [] });
    assert.match(html, /i18n:devin\.reason\.no_account/);
  });

  it('renders the fail-open warning only when it is true', () => {
    const open = renderDevinQuota(I18n, self, { ok: true, quota: { drought: { active: true, restrictionFailOpen: true }, knobs: [] } }, null);
    assert.match(open, /i18n:drought\.restrictionFailOpen/);
    const closed = renderDevinQuota(I18n, self, panel, null);
    assert.doesNotMatch(closed, /i18n:drought\.restrictionFailOpen/);
  });
});

describe('settings section', () => {
  const panel = {
    ok: true,
    runtime: {
      switches: [
        { key: 'devinConnect', value: true, source: 'config', overridden: true },
        { key: 'devinCliMode', value: 'acp', source: 'env', overridden: false },
      ],
    },
    quota: {
      knobs: [
        { key: 'cooldownEnabled', value: true, override: null, source: 'env', overridden: false },
        { key: 'cooldownMs', value: 1800000, override: 900000, source: 'config', overridden: true },
        { key: 'dryThreshold', value: 0, override: null, source: 'env', overridden: false },
        { key: 'spendOnDemand', value: true, override: false, source: 'config', overridden: true },
        { key: 'onDemandReserveUsd', value: 0, override: null, source: 'env', overridden: false },
      ],
    },
  };

  it('renders each switch with its effective value and source', () => {
    const html = renderDevinSettings(I18n, self, panel);
    assert.match(html, /data-devin-switch="devinConnect"/);
    assert.match(html, /i18n:devin\.switch\.devinConnect/);
    assert.match(html, /i18n:devin\.settings\.source\.config/);
    assert.match(html, /i18n:devin\.settings\.overridden/);
  });

  it('leaves an unset knob empty so saving cannot freeze an env value', () => {
    const html = renderDevinSettings(I18n, self, panel);
    assert.match(html, /id="dev-knob-cooldownMs"[^>]*value="900000"/);
    assert.match(html, /id="dev-knob-dryThreshold"[^>]*value=""/);
    assert.match(html, /id="dev-knob-dryThreshold"[^>]*placeholder="0"/);
    assert.match(html, /id="dev-knob-cooldownEnabled"/);
  });

  it('selects the env-following option for a boolean without an override', () => {
    const html = renderDevinSettings(I18n, self, panel);
    const select = html.slice(html.indexOf('id="dev-knob-cooldownEnabled"'), html.indexOf('</select>', html.indexOf('id="dev-knob-cooldownEnabled"')));
    assert.match(select, /<option value="" selected>/);
  });
});

describe('the panel is wired into navigation, not merely defined', () => {
  it('has a sidebar entry and a panel section', () => {
    assert.match(HTML, /<a href="#devin" data-panel="devin">/);
    assert.match(HTML, /<section class="panel" id="p-devin">/);
    assert.match(HTML, /<div class="metrics-grid" id="devin-kpis"><\/div>/);
    for (const id of ['devin-runtime', 'devin-sessions', 'devin-catalog', 'devin-quota', 'devin-settings']) {
      assert.match(HTML, new RegExp(`id="${id}"`), `${id} container must exist`);
    }
  });

  it('loads through the panel router', () => {
    assert.match(HTML, /devin: 'loadDevin'/);
    assert.match(HTML, /async loadDevin\(force = false\)/);
  });

  it('keeps the two upstream reads behind buttons, not on mount', () => {
    assert.match(HTML, /id="devin-acu-btn" onclick="App\.loadDevinAcu\(\)"/);
    assert.match(HTML, /id="devin-reconcile-btn" onclick="App\.loadDevinReconcile\(\)"/);
    const loader = HTML.slice(HTML.indexOf('async loadDevin(force = false)'), HTML.indexOf('renderDevin() {'));
    assert.doesNotMatch(loader, /usage\/orgs/);
    assert.doesNotMatch(loader, /models\/reconcile/);
  });
});
