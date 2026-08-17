import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

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
  const html = readFileSync(join(root, 'docs/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
    .map((match, index) => ({ index, attrs: match[1] || '', source: match[2] || '' }))
    .filter(({ attrs }) => !/\bsrc\s*=/.test(attrs))
    .filter(({ attrs }) => !/\btype\s*=\s*["']module["']/i.test(attrs));

  assert.ok(scripts.length > 0, 'expected at least one non-module inline script in docs/index.html');
  for (const { index, source } of scripts) {
    assert.doesNotThrow(() => new Function(source), `inline script #${index} in docs/index.html should parse`);
  }
});

test('dashboard system prompt editor escapes prompt keys before rendering or routing', () => {
  const html = readFileSync(join(root, 'src/dashboard/index.html'), 'utf8');
  assert.match(html, /const safeKey = this\.esc\(key\)/);
  assert.match(html, /const keyArg = this\.escJsAttr\(key\)/);
  assert.match(html, /this\.systemPromptDomId\(key\)/);
  assert.match(html, /encodeURIComponent\(key\)/);
  assert.doesNotMatch(html, /\$\{key\}<\/code>/);
  assert.doesNotMatch(html, /resetSystemPrompt\('\$\{key\}'\)/);
});

test('dashboard batch login history uses each result proxy instead of an undefined local', () => {
  const html = readFileSync(join(root, 'src/dashboard/index.html'), 'utf8');
  assert.match(html, /proxy:\s*this\.getWindsurfProxyLabel\(item\.proxy\)/);
  assert.doesNotMatch(html, /proxy:\s*this\.getWindsurfProxyLabel\(proxy\),\s*\r?\n\s*status:\s*item\.success/);
});

test('dashboard drought banners expose restriction fail-open state', () => {
  const html = readFileSync(join(root, 'src/dashboard/index.html'), 'utf8');
  const sketch = readFileSync(join(root, 'src/dashboard/index-sketch.html'), 'utf8');
  const en = JSON.parse(readFileSync(join(root, 'src/dashboard/i18n/en.json'), 'utf8'));
  const zh = JSON.parse(readFileSync(join(root, 'src/dashboard/i18n/zh-CN.json'), 'utf8'));

  assert.match(html, /d\.restrictionFailOpen/);
  assert.match(html, /I18n\.t\('drought\.restrictionFailOpen'\)/);
  assert.match(sketch, /d\.restrictionFailOpen/);
  assert.match(sketch, /id="drought-fail-open-message"/);
  assert.equal(typeof en.drought.restrictionFailOpen, 'string');
  assert.equal(typeof zh.drought.restrictionFailOpen, 'string');
});

test('dashboard account detail renders fractional ACU separately from credits', () => {
  const html = readFileSync(join(root, 'src/dashboard/index.html'), 'utf8');
  const auth = readFileSync(join(root, 'src/auth.js'), 'utf8');
  const api = readFileSync(join(root, 'src/dashboard/api.js'), 'utf8');
  const en = JSON.parse(readFileSync(join(root, 'src/dashboard/i18n/en.json'), 'utf8'));
  const zh = JSON.parse(readFileSync(join(root, 'src/dashboard/i18n/zh-CN.json'), 'utf8'));

  assert.match(html, /const acus = Number\(sp\.acuCost\) \|\| 0/);
  assert.match(html, /const showAcuQuota = !!acu && !hasPersonalQuota/);
  assert.match(html, /acu\.source === 'get_user_status'/);
  assert.doesNotMatch(html, /Cognition Platform \(Enterprise\).*showAcuQuota/);
  assert.match(html, /runtime\.spendAcus/);
  assert.equal(en.account.detail.runtime.spendAcus, 'ACU cost');
  assert.equal(zh.account.detail.runtime.spendAcus, 'ACU 消耗');
  assert.equal(en.account.detail.quota.acuUsed, 'ACU consumed');
  assert.equal(zh.account.detail.quota.acuUsed, 'ACU 已用');
  assert.match(auth, /delete persist\.raw/);
  assert.match(api, /delete safe\.raw/);
});

test('dashboard proxy and abnormal-account tables use paged account summaries', () => {
  const html = readFileSync(join(root, 'src/dashboard/index.html'), 'utf8');
  assert.match(html, /id="proxy-accounts-pagination"/);
  assert.match(html, /id="ban-pagination"/);
  assert.match(html, /setProxyPage\(page\)/);
  assert.match(html, /setBansPage\(page\)/);
  assert.match(html, /this\.accountsListUrl\(\{\s*page:\s*this\.proxyPage,\s*pageSize:\s*this\.proxyPageSize/s);
  assert.match(html, /filter:\s*'flagged'/);
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
  const bigPageSites = [...html.matchAll(/pageSize:\s*'?(\d+)'?/g)]
    .map(m => Number(m[1]))
    .filter(n => n > 200);
  assert.equal(bigPageSites.length, 1,
    `only the CSV export may hardcode a page size above 200; found ${bigPageSites.length} `
    + `site(s): ${bigPageSites.join(', ')}. A list view must page via this.*PageSize.`);
  assert.match(html, /view: 'summary', page: '1', pageSize: '1000'/,
    'and that one site is the export — if it moved, re-point this guard rather than widening it');
});

test('dashboard sketch proxy and abnormal-account tables use lightweight summaries', () => {
  const html = readFileSync(join(root, 'src/dashboard/index-sketch.html'), 'utf8');
  assert.match(html, /\/accounts\?view=summary&pageSize=200/);
  assert.match(html, /\/accounts\?view=summary&filter=flagged&pageSize=200/);
  // index-sketch.html DOES use the query-string form, so here the literal check is
  // live rather than tautological (mutating `pageSize=200` to `pageSize=1000` fails
  // the two assertions above). Keep an explicit upper bound on every occurrence so a
  // new call site cannot reintroduce a heavy default.
  const sizes = [...html.matchAll(/pageSize=(\d+)/g)].map(m => Number(m[1]));
  assert.ok(sizes.length > 0, 'the sketch UI builds page size into the query string');
  assert.deepEqual(sizes.filter(n => n > 200), [],
    `sketch list views must stay at or below 200 rows per request; found ${sizes.join(', ')}`);
});

test('dashboard Quick Login uses the Windsurf sign-in + token flow (no dead Firebase popup)', () => {
  const html = readFileSync(join(root, 'src/dashboard/index.html'), 'utf8');
  const sketch = readFileSync(join(root, 'src/dashboard/index-sketch.html'), 'utf8');

  // index-sketch still uses the Firebase signInWithPopup flow, so it must detect the
  // origin-block (unauthorized-domain / referer-blocked) and steer users to the token
  // fallback rather than leaving them stuck.
  assert.match(sketch, /isFirebaseOAuthOriginBlocked/);
  assert.match(sketch, /requests-from-referer-\.\*are-blocked/);
  assert.match(sketch, /unauthorized-domain/);

  // Both variants surface the windsurf.com token path.
  for (const source of [html, sketch]) {
    assert.match(source, /windsurf\.com\/show-auth-token/);
  }

  // index.html's Quick Login no longer relies on Firebase signInWithPopup — it is
  // permanently origin-blocked on a self-hosted public origin. It now drives the
  // Windsurf official sign-in + paste-token flow unconditionally (App.oauthLogin →
  // buildWindsurfSigninUrl → App.submitOAuthToken).
  assert.match(html, /windsurf\.com\/windsurf\/signin/);
  assert.match(html, /submitOAuthToken/);
  // The Firebase Auth SDK (which provided signInWithPopup) must no longer be imported.
  assert.doesNotMatch(html, /firebasejs\/[\d.]+\/firebase-auth/);
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
  const html = readFileSync(join(root, 'docs/index.html'), 'utf8');
  const contributorsSection = html.slice(
    html.indexOf('<section class="contributors-section"'),
    html.indexOf('<!-- ── Footer ── -->'),
  );

  assert.match(html, /id="contributors-grid" data-source="dashboard\/data\/contributors\.json"/);
  assert.match(html, /fetch\(source,\{cache:'no-cache'\}\)/);
  assert.match(html, /function renderContributors\(entries\)/);
  assert.match(html, /id="contributors-footer"/);
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
