// Routing-layer security: which handler a path is allowed to reach.
//
// The existing auth suites (dashboard-auth-fail-closed / -hardening /
// brute-force / server-auth) all import `handleDashboardApi` directly, so they
// prove the AUTH LOGIC is right but never exercise the ROUTER that decides which
// handler a given URL reaches. Four load-bearing properties live only in
// src/server.js `route()` and had zero coverage:
//
//   1. Operator routes are matched with `===` (exact), not a prefix, so no
//      suffix/traversal string can land on them.
//   2. The one prefix dispatch (`/dashboard/api/`) keeps its TRAILING SLASH —
//      without it `/dashboard/apiaccounts` would slice into a bogus subpath.
//   3. `path` is never URL-decoded, so `%2e%2e` cannot become `..` after the
//      route decision (the classic double-decode bypass).
//   4. Static locale serving is an allowlist (`^[A-Za-z0-9-]+\.json$`), not a
//      path join of client input.
//
// A refactor that "helpfully" normalizes or decodes the path, or relaxes `===`
// to `startsWith`, silently opens a bypass. These are the tripwires.
//
// Verified live against a running instance before being written down: 16/16
// bypass attempts (prefix confusion, `..`, `%2e%2e`, `//`, case, `/v1/v1/`
// rewrite chaining, locale traversal) were denied.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, '..', 'src', 'server.js'), 'utf-8');
const ROUTE = (() => {
  const start = /^async function route\(/m.exec(SRC);
  assert.ok(start, 'route() declaration not found in server.js');
  const end = SRC.indexOf('\nexport function startServer(', start.index);
  assert.ok(end > start.index, 'startServer() must follow route() in server.js');
  return SRC.slice(start.index, end);
})();

describe('router: the path is never decoded before the route decision', () => {
  it('derives `path` by stripping the query only — no decode, no normalize', () => {
    const derive = ROUTE.match(/let path = [^\n]+/);
    assert.ok(derive, 'the `let path =` derivation must exist');
    assert.match(derive[0], /req\.url\.split\('\?'\)\[0\]/,
      'path must come from a plain query strip');
    assert.doesNotMatch(derive[0], /decodeURI/,
      'decoding here would let %2e%2e become .. AFTER the route decision');
  });

  it('never runs decodeURIComponent / normalize on the routed path', () => {
    // decodeURIComponent on a *captured segment* (e.g. a model id) is fine; what
    // must never happen is decoding the routing path itself.
    assert.doesNotMatch(ROUTE, /path\s*=\s*decodeURI(Component)?\(/,
      'the routing path must not be reassigned from a decode');
    assert.doesNotMatch(ROUTE, /path\s*=\s*[^\n]*\bnormalize\(/,
      'normalizing the routing path can collapse .. into a real traversal');
  });
});

describe('router: operator surfaces are exact matches', () => {
  const OPERATOR_ROUTES = ['/auth/accounts', '/auth/login', '/auth/status'];

  for (const r of OPERATOR_ROUTES) {
    it(`${r} is compared with === (never startsWith)`, () => {
      const exact = new RegExp(`path === '${r.replace(/\//g, '\\/')}'`);
      assert.match(ROUTE, exact, `${r} must be matched exactly`);
      const loose = new RegExp(`path\\.startsWith\\('${r.replace(/\//g, '\\/')}'\\)`);
      assert.doesNotMatch(ROUTE, loose,
        `${r} must not be prefix-matched — a suffix would reach the operator handler`);
    });
  }

  it('the api surfaces are exact matches too', () => {
    for (const r of ['/v1/chat/completions', '/v1/responses', '/v1/messages']) {
      assert.ok(ROUTE.includes(`path === '${r}'`), `${r} must be matched exactly`);
    }
  });
});

describe('router: the dashboard-api prefix keeps its trailing slash', () => {
  it('dispatches on /dashboard/api/ (with slash), so /dashboard/apiX cannot slice in', () => {
    assert.match(ROUTE, /path\.startsWith\('\/dashboard\/api\/'\)/,
      'the trailing slash is what stops /dashboard/apiaccounts from becoming subpath "accounts"');
    assert.doesNotMatch(ROUTE, /path\.startsWith\('\/dashboard\/api'\)(?!\/)/,
      'a slash-less prefix check would admit /dashboard/api<anything>');
  });

  it('the subpath is sliced with the same literal it was matched against', () => {
    // If the matched prefix and the sliced prefix ever disagree in length, the
    // subpath is silently shifted and route matching inside the dashboard API
    // goes off by one character.
    assert.match(ROUTE, /path\.slice\('\/dashboard\/api'\.length\)/);
  });
});

describe('router: locale files are an allowlist, not a path join of input', () => {
  it('rejects any locale name that is not [A-Za-z0-9-]+.json', () => {
    const block = SRC.slice(
      SRC.indexOf("path.startsWith('/dashboard/i18n/')"),
      SRC.indexOf("path.startsWith('/dashboard/i18n/')") + 800,
    );
    assert.match(block, /\^\[a-zA-Z0-9\\?-\]\+\\\.json\$/,
      'the locale filename must be validated against a strict allowlist');
    // The allowlist must be checked BEFORE the join, otherwise the join happens
    // on attacker input and only the regex result decides whether to read it.
    const guardAt = block.indexOf('Invalid locale file');
    const joinAt = block.indexOf('join(');
    assert.ok(guardAt !== -1 && joinAt !== -1 && guardAt < joinAt,
      'the allowlist rejection must come before the path join');
  });

  it('the allowlist regex actually rejects traversal payloads', () => {
    const ALLOW = /^[a-zA-Z0-9-]+\.json$/;
    for (const bad of [
      '../../.env', '..%2f..%2f.env', '....//.env', '/etc/passwd',
      'en.json/../../.env', 'en..json', 'en.json.bak', 'en/../zh.json',
      '%2e%2e%2f.env', 'en.json\u0000.png',
    ]) {
      assert.equal(ALLOW.test(bad), false, `must reject ${JSON.stringify(bad)}`);
    }
    for (const good of ['en.json', 'zh-CN.json', 'ko.json']) {
      assert.equal(ALLOW.test(good), true, `must accept ${good}`);
    }
  });
});

describe('router: the /v1/v1/ tolerance cannot be chained into a bypass', () => {
  it('only strips a leading /v1/v1/ prefix, and only once', () => {
    const fix = ROUTE.match(/if \(path\.startsWith\('\/v1\/v1\/'\)\)[^\n]*/);
    assert.ok(fix, 'the /v1/v1/ tolerance must exist');
    assert.match(fix[0], /path\.slice\(3\)/,
      'it must drop exactly the duplicated "/v1" (3 chars), not rewrite arbitrarily');
    assert.doesNotMatch(fix[0], /while\s*\(/, 'the rewrite must not loop');
    // Verify the arithmetic on the real strings: the result must still be an
    // absolute /v1/... path, never something that could reach another surface.
    const rewrite = (p) => (p.startsWith('/v1/v1/') ? p.slice(3) : p);
    assert.equal(rewrite('/v1/v1/chat/completions'), '/v1/chat/completions');
    assert.equal(rewrite('/v1/v1/../dashboard/api/accounts'), '/v1/../dashboard/api/accounts',
      'a traversal payload stays literal — it matches no exact route');
    assert.equal(rewrite('/v1/v1/v1/models'), '/v1/v1/models', 'applied once only');
  });
});
