#!/usr/bin/env node
/**
 * devin-connect-login.mjs — account-pool onboarding in one command.
 *
 * WHY: account-password login was just proven fully automatic
 * (windsurfLogin(email,password) → sessionToken, no interactive OAuth — see the
 * `devin-connect-auto-login-WORKS-2026` finding). This is the official entry to
 * GROW the pool and to ARM hands-off recovery (#23/#24/#27): it logs in, encrypts
 * the password into the AES-256-GCM credential store, and adds the fresh
 * sessionToken to accounts.json. Once the password is stored, reLoginAccount can
 * revive a dead token on its own.
 *
 * BILLABLE? No — login + a zero-cost GetUserStatus liveness check only.
 *
 * Usage:
 *   DEVIN_CONNECT_CRED_KEY=<master-key> LOGIN_REAL=1 \
 *     LOGIN_EMAIL=foo@bar.com LOGIN_PASSWORD=secret \
 *     node scripts/devin-connect-login.mjs
 *
 *   # or pass on argv:  node scripts/devin-connect-login.mjs foo@bar.com secret
 *
 * Env:
 *   LOGIN_REAL=1            actually hit the network (default: offline self-test)
 *   LOGIN_EMAIL / LOGIN_PASSWORD   credentials (argv overrides)
 *   DEVIN_CONNECT_CRED_KEY  master key for the cred store. Without it the token
 *                           is still added to the pool, but the password is NOT
 *                           stored, so auto-relogin can't revive it later — we
 *                           warn loudly in that case.
 *   LOGIN_NO_STORE=1        skip storing the password even if a key is set
 *
 * The login + persistence logic lives in run() and is dependency-injectable, so
 * the offline self-test proves the whole flow with no token, network, or billing.
 */
import { fetchUserStatus } from '../src/devin-connect-catalog.js';

const REAL = process.env.LOGIN_REAL === '1';

/**
 * Log in, optionally store the credential, add the token to the pool, and verify
 * liveness. `deps` is injectable for the self-test.
 *
 * @returns {Promise<{ ok, email, tier, stored, addedId, apiKeyPreview, note }>}
 */
export async function run({
  email,
  password,
  env = process.env,
  storePassword = env.LOGIN_NO_STORE !== '1',
  deps = {},
} = {}) {
  if (!email || !password) throw new Error('run: email and password required');

  const {
    windsurfLogin = (await import('../src/dashboard/windsurf-login.js')).windsurfLogin,
    isCredStoreEnabled = (await import('../src/devin-connect-credentials.js')).isCredStoreEnabled,
    storeCredential = (await import('../src/devin-connect-credentials.js')).storeCredential,
    addAccountByKey = (await import('../src/auth.js')).addAccountByKey,
    parseProxyUrl = (await import('../src/dashboard/api.js')).parseProxyUrl,
    userStatus = (token) => fetchUserStatus({ token, env }),
  } = deps;

  // Resolve an optional egress proxy from env so a paid account that has never
  // been seen from this host logs in through a stable, trusted exit instead of
  // bare-connecting (which risks tripping anti-fraud). LOGIN_PROXY takes the
  // canonical "socks5://user:pass@host:port" form; falls back to standard
  // HTTPS_PROXY/ALL_PROXY. null → direct connect (prior behavior).
  const proxyStr = env.LOGIN_PROXY || env.DEVIN_CONNECT_LOGIN_PROXY || env.ALL_PROXY || env.HTTPS_PROXY || '';
  const proxy = proxyStr ? parseProxyUrl(proxyStr) : null;
  if (proxyStr && !proxy) throw new Error('LOGIN_PROXY set but could not be parsed');

  // 1) Log in (account+password → sessionToken), routed through the proxy.
  const loginRes = await windsurfLogin(email, password, proxy);
  const apiKey = loginRes?.apiKey;
  if (!apiKey) throw new Error('login returned no apiKey');

  // 2) Store the password so reLoginAccount can revive a dead token later. The
  // store is a no-op (returns false) when no master key is configured.
  let stored = false;
  let note = '';
  const credEnabled = isCredStoreEnabled(env);
  if (storePassword && credEnabled) {
    stored = storeCredential(email, password, env) !== false;
  } else if (storePassword && !credEnabled) {
    note = 'no DEVIN_CONNECT_CRED_KEY — password NOT stored, auto-relogin disarmed for this account';
  } else if (!storePassword) {
    note = 'LOGIN_NO_STORE — password not stored by request';
  }

  // 3) Add the fresh token to the pool (idempotent on apiKey).
  const account = addAccountByKey(apiKey, email, loginRes.apiServerUrl || '');

  // 4) Zero-billable liveness / tier check.
  let tier = null;
  try {
    const st = await userStatus(apiKey);
    tier = st?.plan || (st?.isPaid ? 'paid' : 'free');
  } catch (e) {
    note = note ? `${note}; liveness check failed: ${e.message}` : `liveness check failed: ${e.message}`;
  }

  return {
    ok: true,
    email,
    tier,
    stored,
    addedId: account?.id || null,
    apiKeyPreview: `${apiKey.slice(0, 24)}...`,
    note,
  };
}

// ─── Offline self-test: proves the login → store → add → verify flow with fully
// mocked deps, so the wiring is verified correct with no token/network/billing.
async function selfTest() {
  const assert = (cond, msg) => { if (!cond) { console.error(`[SELFTEST FAIL] ${msg}`); process.exitCode = 1; } };
  const calls = { stored: null, added: null };
  const baseDeps = {
    windsurfLogin: async (e) => ({ apiKey: `devin-session-token$fake-${e}`, apiServerUrl: 'https://x' }),
    isCredStoreEnabled: () => true,
    storeCredential: (e, p) => { calls.stored = { e, p }; return true; },
    addAccountByKey: (k, label) => { calls.added = { k, label }; return { id: 'acct1234' }; },
    userStatus: async () => ({ plan: 'free', isPaid: false }),
  };

  // 1) happy path: login → store → add → tier
  const r = await run({ email: 'user@example.com', password: 'pw', env: {}, deps: baseDeps });
  assert(r.ok && r.tier === 'free', 'happy path ok + tier free');
  assert(r.stored === true, 'password stored when key enabled');
  assert(calls.stored?.p === 'pw', 'storeCredential got the password');
  assert(calls.added?.k === 'devin-session-token$fake-user@example.com', 'token added to pool');
  assert(r.addedId === 'acct1234', 'returns the added account id');

  // 2) no cred key → token still added, but warns + does not store
  calls.stored = null;
  const r2 = await run({ email: 'user@example.com', password: 'pw', env: {}, deps: { ...baseDeps, isCredStoreEnabled: () => false } });
  assert(r2.stored === false && /NOT stored/.test(r2.note), 'no key → not stored + warned');
  assert(calls.stored === null, 'storeCredential not called without a key');

  // 3) LOGIN_NO_STORE honored even with a key
  calls.stored = null;
  const r3 = await run({ email: 'user@example.com', password: 'pw', env: {}, storePassword: false, deps: baseDeps });
  assert(r3.stored === false && calls.stored === null, 'LOGIN_NO_STORE skips storage');

  // 4) login failure surfaces
  let threw = false;
  try {
    await run({ email: 'user@example.com', password: 'pw', env: {}, deps: { ...baseDeps, windsurfLogin: async () => ({}) } });
  } catch { threw = true; }
  assert(threw, 'login returning no apiKey throws');

  // 5) missing args guarded
  let threw2 = false;
  try { await run({ email: '', password: '', deps: baseDeps }); } catch { threw2 = true; }
  assert(threw2, 'missing email/password throws');

  if (process.exitCode) console.error('\n[SELFTEST] FAILED — do not trust the login flow until fixed.');
  else console.log('[SELFTEST] OK — login → store → add → verify wiring proven (no token, no network).');
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const email = process.argv[2] || process.env.LOGIN_EMAIL || '';
  const password = process.argv[3] || process.env.LOGIN_PASSWORD || '';

  if (!REAL) {
    console.log('LOGIN_REAL is not 1 — running offline self-test only (no token, no network).');
    console.log('To onboard a real account:');
    console.log('  DEVIN_CONNECT_CRED_KEY=<key> LOGIN_REAL=1 LOGIN_EMAIL=<e> LOGIN_PASSWORD=<p> \\');
    console.log('    node scripts/devin-connect-login.mjs\n');
    await selfTest();
    process.exit(process.exitCode || 0);
  }

  if (!email || !password) {
    console.error('LOGIN_REAL=1 but no credentials — set LOGIN_EMAIL/LOGIN_PASSWORD or pass them on argv.');
    process.exit(2);
  }

  // Redact the email in logs the same way the rest of the codebase does.
  console.log(`[login] onboarding ${email.replace(/(.{2}).*(@.*)/, '$1***$2')} (real network)\n`);
  try {
    const r = await run({ email, password });
    console.log(`  ✓ logged in           → ${r.apiKeyPreview}`);
    console.log(`  ${r.stored ? '✓' : '·'} credential stored    → ${r.stored ? 'yes (auto-relogin armed)' : 'no'}`);
    console.log(`  ✓ added to pool       → account ${r.addedId}`);
    console.log(`  ✓ tier                → ${r.tier || 'unknown'}`);
    if (r.note) console.log(`  ! note                → ${r.note}`);
    console.log(`\n${'─'.repeat(60)}`);
    console.log(r.stored
      ? 'DONE — account onboarded and hands-off recovery armed.'
      : 'DONE — account onboarded. Set DEVIN_CONNECT_CRED_KEY to arm auto-relogin.');
    process.exit(0);
  } catch (e) {
    console.error(`\n[login] FAILED: ${e.message}`);
    console.error('(3 consecutive bad-credential attempts will lock the email locally — verify before retrying.)');
    process.exit(1);
  }
}

const isEntry = import.meta.main
  ?? (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href);
if (isEntry) await main();
