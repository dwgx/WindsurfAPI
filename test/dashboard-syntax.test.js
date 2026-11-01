import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const DASHBOARD = readFileSync(join(root, 'src/dashboard/index.html'), 'utf8');
const SKETCH = readFileSync(join(root, 'src/dashboard/index-sketch.html'), 'utf8');
const DOCS = readFileSync(join(root, 'docs/index.html'), 'utf8');

/**
 * Pull one or more methods out of a dashboard `App` object literal and hand back
 * a live object, so the shipped code can be CALLED instead of pattern-matched.
 *
 * The precedent is this file's own `new Function(source)` script-parse check:
 * parse the real source, then use it. Reimplementing a helper here would keep
 * passing while production degraded, which is the failure mode these assertions
 * exist to prevent.
 *
 * Only self-contained methods qualify: pure string/URL builders that touch no
 * DOM node and no instance state (beyond `this.*` defaults, which the returned
 * object supplies).
 */
function extractAppMethods(html, names, scope = {}) {
  const members = names.map((name) => {
    const at = html.indexOf(`\n  ${name}(`);
    assert.notEqual(at, -1, `${name}() must exist as an App method`);
    // Walk the parameter list to its closing paren first: a destructured default
    // (`{ page = this.accountsPage } = {}`) puts braces in front of the body.
    let paren = 0;
    let bodyStart = -1;
    for (let i = html.indexOf('(', at); i < html.length; i++) {
      if (html[i] === '(') paren++;
      else if (html[i] === ')' && --paren === 0) { bodyStart = html.indexOf('{', i); break; }
    }
    assert.notEqual(bodyStart, -1, `could not delimit the parameter list of ${name}`);
    let depth = 0;
    let end = -1;
    for (let i = bodyStart; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    assert.notEqual(end, -1, `could not delimit the body of ${name}`);
    return html.slice(at + 1, end);
  });
  const scopeNames = Object.keys(scope);
  // eslint-disable-next-line no-new-func -- executing the shipped source is the point
  const build = new Function(...scopeNames, `return ({ ${members.join(',\n')} });`);
  return build(...scopeNames.map((k) => scope[k]));
}

const I18nStub = { t: (key) => `i18n:${key}` };
const app = extractAppMethods(
  DASHBOARD,
  ['accountsListUrl', 'systemPromptDomId', 'getWindsurfProxyLabel', 'buildWindsurfSigninUrl'],
  { I18n: I18nStub },
);
const sketchApp = extractAppMethods(SKETCH, ['isFirebaseOAuthOriginBlocked']);

for (const skin of ['src/dashboard/index.html', 'src/dashboard/index-sketch.html']) {
  test(`${skin} inline scripts are syntactically valid`, () => {
    const html = readFileSync(join(root, skin), 'utf8');
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
      .map((match, index) => ({ index, attrs: match[1] || '', source: match[2] || '' }))
      .filter(({ attrs }) => !/\bsrc\s*=/.test(attrs))
      .filter(({ attrs }) => !/\btype\s*=\s*["']module["']/i.test(attrs));

    assert.ok(scripts.length > 0, `expected at least one non-module inline script in ${skin}`);
    for (const { index, source } of scripts) {
      assert.doesNotThrow(() => new Function(source), `inline script #${index} in ${skin} should parse`);
    }
  });
}

test('docs/index.html inline scripts are syntactically valid', () => {
  const scripts = [...DOCS.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
    .map((match, index) => ({ index, attrs: match[1] || '', source: match[2] || '' }))
    .filter(({ attrs }) => !/\bsrc\s*=/.test(attrs))
    .filter(({ attrs }) => !/\btype\s*=\s*["']module["']/i.test(attrs));

  assert.ok(scripts.length > 0, 'expected at least one non-module inline script in docs/index.html');
  for (const { index, source } of scripts) {
    assert.doesNotThrow(() => new Function(source), `inline script #${index} in docs/index.html should parse`);
  }
});

// ─── Executed helpers ───────────────────────────────────────────────────────
// These replace the former source greps for `this.systemPromptDomId(key)`,
// `encodeURIComponent(key)`, `pageSize`, the windsurf sign-in URL and the
// Firebase origin-block classifier. A grep was satisfied by the string still
// being present; these assertions are only satisfied if the code still behaves.
describe('dashboard helpers run', () => {
  it('accountsListUrl always asks for the summary view and clamps the page size', () => {
    const clamped = new URL(app.accountsListUrl({ page: 3, pageSize: 1000 }), 'http://x');
    assert.equal(clamped.pathname, '/accounts');
    assert.equal(clamped.searchParams.get('view'), 'summary');
    assert.equal(clamped.searchParams.get('page'), '3');
    // 200 is the server's clamp; asking for more is the 1000-row page load the
    // old `doesNotMatch(/pageSize=1000/)` guard could never see.
    assert.equal(clamped.searchParams.get('pageSize'), '200');

    const tiny = new URL(app.accountsListUrl({ page: 0, pageSize: 0 }), 'http://x');
    assert.equal(tiny.searchParams.get('page'), '1');
    assert.equal(tiny.searchParams.get('pageSize'), '50');

    const garbage = new URL(app.accountsListUrl({ page: 'abc', pageSize: 'abc' }), 'http://x');
    assert.equal(garbage.searchParams.get('page'), '1');
    assert.equal(garbage.searchParams.get('pageSize'), '50');
  });

  it('accountsListUrl forwards filters and omits empty ones', () => {
    const filtered = new URL(app.accountsListUrl({ page: 2, pageSize: 25, filter: 'flagged', status: 'active', q: 'a b' }), 'http://x');
    assert.equal(filtered.searchParams.get('filter'), 'flagged');
    assert.equal(filtered.searchParams.get('status'), 'active');
    assert.equal(filtered.searchParams.get('q'), 'a b');
    assert.equal(filtered.searchParams.get('tier'), null);

    const bare = new URL(app.accountsListUrl({}), 'http://x');
    assert.deepEqual(
      [...bare.searchParams.keys()].sort(),
      ['page', 'pageSize', 'view'],
      'an unfiltered list must not carry empty filter keys',
    );
  });

  it('systemPromptDomId maps every prompt key to a distinct, injection-safe id', () => {
    const keys = ['toolReinforcement', 'communicationWithTools', 'communicationNoTools', 'a b', 'a"b', 'a<b>c', 'a%b'];
    const ids = keys.map((key) => app.systemPromptDomId(key));
    assert.equal(new Set(ids).size, keys.length, 'distinct prompt keys must not collide on one textarea');

    for (const [i, id] of ids.entries()) {
      assert.match(id, /^sp-/, `id for ${keys[i]} must keep the sp- prefix`);
      for (const ch of ['"', '<', '>', ' ', '%', '\n']) {
        assert.ok(!id.includes(ch), `id for ${JSON.stringify(keys[i])} must not contain ${JSON.stringify(ch)}: ${id}`);
      }
    }
    assert.equal(app.systemPromptDomId('a b'), 'sp-a_20b');
    assert.equal(app.systemPromptDomId(null), 'sp-');
    assert.equal(app.systemPromptDomId(undefined), 'sp-');
  });

  it('getWindsurfProxyLabel renders every proxy shape without undefined', () => {
    assert.equal(app.getWindsurfProxyLabel(null), 'i18n:proxy.global');
    assert.equal(app.getWindsurfProxyLabel(undefined), 'i18n:proxy.global');
    assert.equal(app.getWindsurfProxyLabel('http://proxy.example:8080'), 'http://proxy.example:8080');
    assert.equal(app.getWindsurfProxyLabel({ type: 'http', host: 'p.example', port: 8080 }), 'http://p.example:8080');
    // The batch-login bug was a history row rendering `undefined`; no input may.
    for (const input of [null, undefined, 'direct', { type: 'socks5', host: 'h', port: 1 }]) {
      assert.ok(!String(app.getWindsurfProxyLabel(input)).includes('undefined'));
    }
  });

  it('buildWindsurfSigninUrl emits the token flow with a fresh state per call', () => {
    const first = new URL(app.buildWindsurfSigninUrl());
    assert.equal(first.origin + first.pathname, 'https://windsurf.com/windsurf/signin');
    assert.equal(first.searchParams.get('response_type'), 'token');
    assert.equal(first.searchParams.get('redirect_uri'), 'show-auth-token');
    assert.equal(first.searchParams.get('prompt'), 'login');
    assert.ok((first.searchParams.get('state') || '').length > 0, 'a CSRF state is mandatory');

    const second = new URL(app.buildWindsurfSigninUrl());
    assert.notEqual(first.searchParams.get('state'), second.searchParams.get('state'));
  });

  it('isFirebaseOAuthOriginBlocked separates origin blocks from real failures', () => {
    const blocked = [
      { message: 'Firebase: Error (auth/unauthorized-domain).' },
      { message: 'auth/requests-from-referer-https://x.are-blocked' },
      'unauthorized-domain',
    ];
    for (const err of blocked) {
      assert.equal(sketchApp.isFirebaseOAuthOriginBlocked(err), true, `${JSON.stringify(err)} is an origin block`);
    }
    const notBlocked = [
      { message: 'Firebase: Error (auth/wrong-password).' },
      { message: 'auth/network-request-failed' },
      null,
      undefined,
      '',
    ];
    for (const err of notBlocked) {
      assert.equal(sketchApp.isFirebaseOAuthOriginBlocked(err), false, `${JSON.stringify(err)} must not be steered to the token fallback`);
    }
  });
});

// ─── Markup / data guards ───────────────────────────────────────────────────
// Everything below asserts the SHAPE of shipped markup or shipped JSON: DOM ids,
// column counts, removed pages, locale keys, contributor records. `new Function`
// cannot reach any of it — a `<th>` count or a `doesNotMatch(/id="p-bans"/)` is
// not a behaviour, it is the contract with the stylesheet and the router.
describe('dashboard markup contract', () => {
  test('system prompt editor routes keys through both escapers', () => {
    // The escaping itself is executed in dashboard-escape-behaviour.test.js; this
    // file only owns "the call sites still go through the helpers", which is what
    // a grep is good at.
    assert.match(DASHBOARD, /const safeKey = this\.esc\(key\)/);
    assert.match(DASHBOARD, /const keyArg = this\.escJsAttr\(key\)/);
    // …and that neither raw interpolation form comes back.
    assert.doesNotMatch(DASHBOARD, /\$\{key\}<\/code>/);
    assert.doesNotMatch(DASHBOARD, /resetSystemPrompt\('\$\{key\}'\)/);
  });

  test('dashboard batch login history uses each result proxy instead of an undefined local', () => {
    // getWindsurfProxyLabel's behaviour is executed above; this pins the CALL
    // SITE, which is where the original bug lived (`item.proxy` vs a stray `proxy`).
    assert.match(DASHBOARD, /proxy:\s*this\.getWindsurfProxyLabel\(item\.proxy\)/);
    assert.doesNotMatch(DASHBOARD, /proxy:\s*this\.getWindsurfProxyLabel\(proxy\),\s*\r?\n\s*status:\s*item\.success/);
  });

  test('dashboard drought banners expose restriction fail-open state', () => {
    const en = JSON.parse(readFileSync(join(root, 'src/dashboard/i18n/en.json'), 'utf8'));
    const zh = JSON.parse(readFileSync(join(root, 'src/dashboard/i18n/zh-CN.json'), 'utf8'));

    assert.match(DASHBOARD, /d\.restrictionFailOpen/);
    assert.match(DASHBOARD, /I18n\.t\('drought\.restrictionFailOpen'\)/);
    assert.match(SKETCH, /d\.restrictionFailOpen/);
    assert.match(SKETCH, /id="drought-fail-open-message"/);
    assert.equal(typeof en.drought.restrictionFailOpen, 'string');
    assert.equal(typeof zh.drought.restrictionFailOpen, 'string');
  });

  test('dashboard proxy table pages summaries; accounts page is the single merged list', () => {
    assert.match(DASHBOARD, /id="proxy-accounts-pagination"/);
    assert.match(DASHBOARD, /setProxyPage\(page\)/);
    // The list path must page through the bound properties; the clamping and the
    // summary view they produce are executed above.
    assert.match(DASHBOARD, /this\.accountsListUrl\(\{\s*page:\s*this\.proxyPage,\s*pageSize:\s*this\.proxyPageSize/s);
    assert.match(DASHBOARD, /filter:\s*this\.accountsFlagged\s*\?\s*'flagged'\s*:\s*''/);
    // The 异常监测 page and the 登录取号 page are gone: one account-management
    // destination, one table, one add/login entry point.
    assert.doesNotMatch(DASHBOARD, /id="p-bans"/);
    assert.doesNotMatch(DASHBOARD, /id="ban-pagination"/);
    assert.doesNotMatch(DASHBOARD, /id="p-windsurf-login"/);
    assert.doesNotMatch(DASHBOARD, /setBansPage\(/);
    assert.match(DASHBOARD, /id="accounts-kpis"/);
    assert.match(DASHBOARD, /id="accounts-batch-bar"/);
    assert.match(DASHBOARD, /id="acct-drawer"/);
    assert.match(DASHBOARD, /id="add-account-overlay"/);
    assert.doesNotMatch(DASHBOARD, /account-detail-row/);
    // 9-column table: checkbox, account, tier, status, quota, models, RPM, last
    // used, actions. The Key/ID/Error columns are folded into cells/drawer.
    const thead = DASHBOARD.match(/<table id="accounts-table">[\s\S]*?<\/thead>/)?.[0] || '';
    assert.equal((thead.match(/<th\b/g) || []).length, 9, 'accounts table must have exactly 9 columns');
    assert.match(DASHBOARD, /accounts\.filter\.searchPlaceholder/);
    assert.match(DASHBOARD, /accounts\.status\.quotaCooled/);
    // These two used to read `doesNotMatch(html, /pageSize=1000/)` — TAUTOLOGIES.
    // index.html never writes the page size in the query-string form `pageSize=N`; it
    // builds it as an object property (`pageSize: this.proxyPageSize`), so no page-size
    // regression could ever make those regexes match. Worse, the thing they existed to
    // prevent — a 1000-row page load — IS present as `pageSize: '1000'`, and they sat
    // green over it. The intent was right; the form could not detect anything.
    //
    // Bite the real shape instead: the LIST paths must page through the bound
    // properties, and the one legitimate bulk read (the CSV export at ~6301, which
    // deliberately exceeds the 200 clamp) must stay the ONLY hardcoded large size.
    // The clamp itself is executed above (accountsListUrl caps at 200).
    const bigPageSites = [...DASHBOARD.matchAll(/pageSize:\s*'?(\d+)'?/g)]
      .map(m => Number(m[1]))
      .filter(n => n > 200);
    assert.equal(bigPageSites.length, 1,
      `only the CSV export may hardcode a page size above 200; found ${bigPageSites.length} `
      + `site(s): ${bigPageSites.join(', ')}. A list view must page via this.*PageSize.`);
    assert.match(DASHBOARD, /view: 'summary', page: '1', pageSize: '1000'/,
      'and that one site is the export — if it moved, re-point this guard rather than widening it');
  });

  test('dashboard sketch proxy and abnormal-account tables use lightweight summaries', () => {
    assert.match(SKETCH, /\/accounts\?view=summary&pageSize=200/);
    assert.match(SKETCH, /\/accounts\?view=summary&filter=flagged&pageSize=200/);
    // index-sketch.html DOES use the query-string form, so here the literal check is
    // live rather than tautological (mutating `pageSize=200` to `pageSize=1000` fails
    // the two assertions above). Keep an explicit upper bound on every occurrence so a
    // new call site cannot reintroduce a heavy default.
    const sizes = [...SKETCH.matchAll(/pageSize=(\d+)/g)].map(m => Number(m[1]));
    assert.ok(sizes.length > 0, 'the sketch UI builds page size into the query string');
    assert.deepEqual(sizes.filter(n => n > 200), [],
      `sketch list views must stay at or below 200 rows per request; found ${sizes.join(', ')}`);
  });

  test('dashboard Quick Login uses the Windsurf sign-in + token flow (no dead Firebase popup)', () => {
    // The sign-in URL is built and executed above; the sketch's Firebase flow has
    // no importable seam, so its classifier is executed in the helper suite and
    // the two literals it must recognise stay here as a cheap regression pin.
    assert.match(SKETCH, /requests-from-referer-\.\*are-blocked/);
    assert.match(SKETCH, /unauthorized-domain/);

    // Both variants surface the windsurf.com token path.
    for (const source of [DASHBOARD, SKETCH]) {
      assert.match(source, /windsurf\.com\/show-auth-token/);
    }

    // index.html's Quick Login no longer relies on Firebase signInWithPopup — it is
    // permanently origin-blocked on a self-hosted public origin. It now drives the
    // Windsurf official sign-in + paste-token flow unconditionally (App.oauthLogin →
    // buildWindsurfSigninUrl → App.submitOAuthToken).
    assert.match(DASHBOARD, /submitOAuthToken/);
    // The Firebase Auth SDK (which provided signInWithPopup) must no longer be imported.
    assert.doesNotMatch(DASHBOARD, /firebasejs\/[\d.]+\/firebase-auth/);
  });

  test('recent merged PR contributors are represented in dashboard and README credits', () => {
    const contributorData = JSON.parse(readFileSync(join(root, 'src/dashboard/data/contributors.json'), 'utf8'));
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const readmeEn = readFileSync(join(root, 'README.en.md'), 'utf8');
    const required = [
      { login: 'MatrixNeoKozak', pr: 195 },
      { login: 'brandonedley', pr: 201 },
    ];

    for (const { login, pr } of required) {
      assert.ok(
        contributorData.contributors.some(entry => entry.login === login && entry.pr === pr),
        `contributors.json should include @${login} PR #${pr}`,
      );
      assert.match(readme, new RegExp(`@${login}[\\s\\S]*PR #${pr}`));
      assert.match(readmeEn, new RegExp(`@${login}[\\s\\S]*PR #${pr}`));
    }
  });

  test('docs homepage renders contributors from the published dashboard JSON', () => {
    const contributorsSection = DOCS.slice(
      DOCS.indexOf('<section class="contributors-section"'),
      DOCS.indexOf('<!-- ── Footer ── -->'),
    );

    assert.match(DOCS, /id="contributors-grid" data-source="dashboard\/data\/contributors\.json"/);
    assert.match(DOCS, /fetch\(source,\{cache:'no-cache'\}\)/);
    assert.match(DOCS, /function renderContributors\(entries\)/);
    assert.match(DOCS, /id="contributors-footer"/);
    assert.doesNotMatch(contributorsSection, /href="https:\/\/github\.com\/aict666"/);
    assert.doesNotMatch(contributorsSection, /PR #192/);
  });

  test('docs contributor JSON mirrors the canonical dashboard contributor data', () => {
    const source = readFileSync(join(root, 'src/dashboard/data/contributors.json'), 'utf8');
    const published = readFileSync(join(root, 'docs/dashboard/data/contributors.json'), 'utf8');
    const parsed = JSON.parse(published);

    assert.deepEqual(JSON.parse(source), parsed);
    assert.equal(published, source);
  });
});
