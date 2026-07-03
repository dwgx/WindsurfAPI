// app.devin.ai second-host login fallback (DEVIN_CONNECT_LOGIN_HOST_FALLBACK).
//
// Study .workflow-results/oauth-relogin-study/FEASIBILITY-BLUEPRINT.md §6:
// point a SECOND host at the SAME Auth1 password/login mechanism so
// windsurf.com (Vercel) 504/503 spikes / endpoint migrations don't take the
// whole re-login chain down. Adds app.devin.ai/api/auth1/{connections,
// password/login} as a COMPLETE, independent fallback, gated behind an opt-in
// env flag, reusing the existing postAuthDualPath exchanger.
//
// TODO(unverified): the app.devin.ai -> OUR-PostAuth token-exchange hop is NOT
// confirmed against a live account (study §1.2/§5.3). These tests prove the
// WIRING (flag gating, host targeting, no-fake-success, endpoint construction)
// with a fully mocked transport. They do NOT prove the cross-host exchange
// works upstream.
//
// Zero network: httpsRequest is routed through __setLoginTransportForTests.
// No real account / no real auth request. Email/password are throwaway literals.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  windsurfLogin,
  __setLoginTransportForTests,
  _resetEmailLockoutForTests,
} from '../src/dashboard/windsurf-login.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGIN_SRC = readFileSync(join(__dirname, '..', 'src', 'dashboard', 'windsurf-login.js'), 'utf8');

const EMAIL = 'fallback-test@example.com';
const PASSWORD = 'throwaway-not-real';

function setFlag(on) {
  if (on) process.env.DEVIN_CONNECT_LOGIN_HOST_FALLBACK = '1';
  else delete process.env.DEVIN_CONNECT_LOGIN_HOST_FALLBACK;
}

// First-substring-match route table. raw requests (PostAuth) get a Buffer.
// Avoid 5xx replies so httpsRequestRetrying backoff never fires (fast suite).
function makeTransport(routes) {
  const seen = [];
  const fn = async (url, opts) => {
    seen.push(url);
    for (const [matcher, reply] of routes) {
      if (url.includes(matcher)) {
        if (reply instanceof Error) throw reply;
        if (opts.raw) {
          const buf = Buffer.isBuffer(reply.data) ? reply.data
            : Buffer.from(typeof reply.data === 'string' ? reply.data : JSON.stringify(reply.data));
          return { status: reply.status, data: buf };
        }
        return { status: reply.status, data: reply.data };
      }
    }
    throw new Error(`unexpected request to ${url}`);
  };
  fn.seen = seen;
  return fn;
}

const PROBE = ['SeatManagementService/CheckUserLoginMethod', { status: 200, data: { userExists: true, hasPassword: true } }];
const PRIMARY_FAIL = ['windsurf.com/_devin-auth/password/login', { status: 400, data: { detail: 'Invalid email or password' } }];
const PRIMARY_OK = ['windsurf.com/_devin-auth/password/login', { status: 200, data: { token: 'auth1-primary' } }];
const POSTAUTH_OK = ['WindsurfPostAuth', { status: 200, data: { sessionToken: 'devin-session-token$NEW', accountId: 'account-abc' } }];
const DEVIN_CONN_OK = ['app.devin.ai/api/auth1/connections', { status: 200, data: { connections: [] } }];
const DEVIN_LOGIN_OK = ['app.devin.ai/api/auth1/password/login', { status: 200, data: { token: 'auth1-devin' } }];

beforeEach(() => { _resetEmailLockoutForTests(); setFlag(false); });
afterEach(() => { __setLoginTransportForTests(null); _resetEmailLockoutForTests(); setFlag(false); });

describe('host fallback — flag OFF (default, behavior unchanged)', () => {
  it('successful primary login only hits windsurf.com', async () => {
    setFlag(false);
    const t = makeTransport([PROBE, PRIMARY_OK, POSTAUTH_OK]);
    __setLoginTransportForTests(t);
    const result = await windsurfLogin(EMAIL, PASSWORD, null);
    assert.equal(result.apiKey, 'devin-session-token$NEW');
    assert.ok(!t.seen.some(u => u.includes('app.devin.ai')), 'no app.devin.ai when flag off');
  });

  it('primary failure surfaces directly — no second host', async () => {
    setFlag(false);
    const t = makeTransport([PROBE, PRIMARY_FAIL]);
    __setLoginTransportForTests(t);
    await assert.rejects(() => windsurfLogin(EMAIL, PASSWORD, null));
    assert.ok(!t.seen.some(u => u.includes('app.devin.ai')), 'flag off → no fallback');
  });
});

describe('host fallback — flag ON', () => {
  it('falls back to app.devin.ai after the primary windsurf.com path fails', async () => {
    setFlag(true);
    const t = makeTransport([PROBE, PRIMARY_FAIL, DEVIN_CONN_OK, DEVIN_LOGIN_OK, POSTAUTH_OK]);
    __setLoginTransportForTests(t);
    const result = await windsurfLogin(EMAIL, PASSWORD, null);
    assert.equal(result.apiKey, 'devin-session-token$NEW');
    assert.equal(result.viaHost, 'app.devin.ai');
    assert.ok(t.seen.includes('https://app.devin.ai/api/auth1/password/login'), 'hits devin login endpoint');
    assert.ok(t.seen.includes('https://app.devin.ai/api/auth1/connections'), 'probes devin connections endpoint');
  });

  it('tolerates a failing app.devin.ai connections probe and still logs in', async () => {
    setFlag(true);
    const t = makeTransport([
      PROBE, PRIMARY_FAIL,
      ['app.devin.ai/api/auth1/connections', { status: 404, data: { detail: 'not found' } }],
      DEVIN_LOGIN_OK, POSTAUTH_OK,
    ]);
    __setLoginTransportForTests(t);
    const result = await windsurfLogin(EMAIL, PASSWORD, null);
    assert.equal(result.viaHost, 'app.devin.ai', 'connections probe is best-effort');
  });

  it('both hosts fail → rejects with the ORIGINAL primary error (no fake success)', async () => {
    setFlag(true);
    const t = makeTransport([
      PROBE, PRIMARY_FAIL,
      DEVIN_CONN_OK,
      ['app.devin.ai/api/auth1/password/login', { status: 400, data: { detail: 'Invalid email or password' } }],
    ]);
    __setLoginTransportForTests(t);
    await assert.rejects(() => windsurfLogin(EMAIL, PASSWORD, null), (err) => {
      // primary error code is surfaced, not the fallback's
      assert.ok(/ERR_INVALID_CREDENTIALS|ERR_LOGIN_FAILED|Invalid/i.test(err.code || err.message), 'primary error surfaced');
      return true;
    });
    assert.ok(t.seen.some(u => u.includes('app.devin.ai')), 'fallback was attempted before giving up');
  });

  it('app.devin.ai login OK but its PostAuth has no sessionToken → fail, no fake success', async () => {
    setFlag(true);
    const t = makeTransport([
      PROBE, PRIMARY_FAIL, DEVIN_CONN_OK, DEVIN_LOGIN_OK,
      ['WindsurfPostAuth', { status: 200, data: { somethingElse: true } }],
    ]);
    __setLoginTransportForTests(t);
    await assert.rejects(() => windsurfLogin(EMAIL, PASSWORD, null), 'missing sessionToken must not be treated as success');
  });

  it('flag ON but primary SUCCEEDS → app.devin.ai never contacted', async () => {
    setFlag(true);
    const t = makeTransport([PROBE, PRIMARY_OK, POSTAUTH_OK]);
    __setLoginTransportForTests(t);
    const result = await windsurfLogin(EMAIL, PASSWORD, null);
    assert.equal(result.apiKey, 'devin-session-token$NEW');
    assert.notEqual(result.viaHost, 'app.devin.ai');
    assert.ok(!t.seen.some(u => u.includes('app.devin.ai')), 'fallback only on primary failure');
  });
});

describe('source invariants (host/endpoint construction + unverified honesty)', () => {
  it('targets the correct app.devin.ai Auth1 endpoints', () => {
    assert.match(LOGIN_SRC, /https:\/\/app\.devin\.ai/, 'second host constant present');
    assert.match(LOGIN_SRC, /api\/auth1\/connections/, 'connections endpoint present');
    assert.match(LOGIN_SRC, /api\/auth1\/password\/login/, 'password/login endpoint present');
  });

  it('gates the whole fallback behind DEVIN_CONNECT_LOGIN_HOST_FALLBACK', () => {
    assert.match(LOGIN_SRC, /DEVIN_CONNECT_LOGIN_HOST_FALLBACK/, 'env flag referenced');
  });

  it('keeps the unverified cross-host PostAuth hop explicitly flagged', () => {
    assert.match(LOGIN_SRC, /TODO\(unverified[\s\S]*?PostAuth/i,
      'cross-host PostAuth exchange must stay marked unverified');
  });

  it('does NOT touch classifyUpstreamError or reLoginAccount', () => {
    assert.ok(!/classifyUpstreamError/.test(LOGIN_SRC), 'error classifier untouched by this module');
    assert.ok(!/function reLoginAccount/.test(LOGIN_SRC), 'reLoginAccount lives in auth.js, untouched');
  });

  it('reuses postAuthDualPath rather than reimplementing the exchanger', () => {
    const idx = LOGIN_SRC.indexOf('async function windsurfLoginViaDevinHost(');
    assert.ok(idx >= 0, 'fallback chain function exists');
    const open = LOGIN_SRC.indexOf('{', idx);
    let depth = 0, body = '';
    for (let i = open; i < LOGIN_SRC.length; i++) {
      if (LOGIN_SRC[i] === '{') depth++;
      else if (LOGIN_SRC[i] === '}') { depth--; if (depth === 0) { body = LOGIN_SRC.slice(idx, i + 1); break; } }
    }
    assert.match(body, /postAuthDualPath\s*\(/, 'must reuse postAuthDualPath');
  });
});
