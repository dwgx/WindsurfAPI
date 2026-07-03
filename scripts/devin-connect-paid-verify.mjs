#!/usr/bin/env node
/**
 * DEVIN_CONNECT paid-entitlement verification harness.
 *
 * WHY: tasks #15/#28 ("does a paid token actually reach the claude / gpt / gemini
 * selectors, or do they tier-wall like a free account?") have been blocked for
 * weeks on one missing input: a PAID session token. Everything else is built and
 * green. This harness makes that verification a single command — point it at a
 * paid token and it walks EVERY paid selector in the live catalog, fires one
 * 1-token probe each, and prints a pass / tier-wall / error matrix plus a verdict.
 *
 * It is BILLABLE (one tiny completion per paid selector) and OFF by default —
 * set PAID_VERIFY_REAL=1 to actually fire. Without it, the script runs its
 * offline self-test (mocked transport) so the classification logic is proven
 * correct NOW, on no token at all; only the real firing waits for the credential.
 *
 * Usage (real):
 *   PAID_VERIFY_REAL=1 CONNECT_SMOKE_PAID_TOKEN=<paid-devin-session-token> \
 *   node scripts/devin-connect-paid-verify.mjs
 *
 * Optional:
 *   PAID_VERIFY_ONLY=claude-opus-4.8,gpt-5.5   only probe these aliases/selectors
 *   PAID_VERIFY_TIMEOUT_MS=60000               per-probe timeout
 *
 * Self-test (no token, no network, always safe — also what `npm test` could call):
 *   node scripts/devin-connect-paid-verify.mjs            # PAID_VERIFY_REAL unset
 */

import { fetchCatalog, fetchUserStatus } from '../src/devin-connect-catalog.js';
import { resolveConnectSelector } from '../src/devin-connect-models.js';
import * as connect from '../src/devin-connect.js';

const REAL = process.env.PAID_VERIFY_REAL === '1';
const TIMEOUT_MS = Number(process.env.PAID_VERIFY_TIMEOUT_MS || 60000);

function resolveToken(env = process.env) {
  for (const k of ['CONNECT_SMOKE_PAID_TOKEN', 'CONNECT_SMOKE_TOKEN', 'DEVIN_CONNECT_TOKEN', 'DEVIN_SESSION_TOKEN']) {
    if (env[k]) return env[k].trim();
  }
  return '';
}

/**
 * Classify one probe outcome into a stable bucket. Pure + exported so the
 * self-test can assert it without a network.
 *   - 'reachable'  → 200 with content: the paid entitlement WORKS for this model.
 *   - 'tier-wall'  → MODEL_BLOCKED / 402: the account lacks the plan for it
 *                    (expected on a FREE token; a RED FLAG on a token claiming paid).
 *   - 'dead-token' → UNAUTHORIZED: the session token itself is bad/expired.
 *   - 'error'      → anything else (rate limit, upstream 5xx, timeout).
 */
export function classifyProbe({ content, error }) {
  if (!error) {
    return content && content.trim()
      ? { bucket: 'reachable', detail: content.trim().slice(0, 40) }
      : { bucket: 'error', detail: 'empty content' };
  }
  const code = error.code || '';
  if (code === 'MODEL_BLOCKED') return { bucket: 'tier-wall', detail: error.message?.slice(0, 60) };
  if (code === 'UNAUTHORIZED') return { bucket: 'dead-token', detail: error.message?.slice(0, 60) };
  return { bucket: 'error', detail: `${code || 'ERR'}: ${error.message?.slice(0, 50)}` };
}

/**
 * Run the full sweep. `deps` is injectable for the self-test:
 *   { fetchUserStatus, fetchCatalog, chat }
 * Returns { isPaid, plan, rows:[{alias,selector,provider,bucket,detail}], verdict }.
 */
export async function runSweep({ token, deps = {}, only = null, real = REAL } = {}) {
  const _status = deps.fetchUserStatus || fetchUserStatus;
  const _catalog = deps.fetchCatalog || fetchCatalog;
  const _chat = deps.chat || connect.chat;

  const status = await _status({ token });
  const catalog = await _catalog({ token });

  // Paid selectors = everything except the one free default. Dedup by selector.
  let paid = catalog.filter((m) => !m.isFreeDefault);
  if (only && only.length) {
    const want = new Set(only.map((s) => s.toLowerCase()));
    paid = paid.filter((m) => want.has(m.selector.toLowerCase()) || want.has((m.alias || '').toLowerCase()));
  }

  const rows = [];

  // Liveness baseline: probe the free default selector FIRST. Upstream returns a
  // bare `permission_denied`/"internal error" for BOTH a dead session token AND a
  // free→paid entitlement wall — indistinguishable from the paid probe alone (the
  // same ambiguity that bit the handler, see #42). The free-model probe breaks the
  // tie: if it returns content the token is provably ALIVE, so any UNAUTHORIZED on
  // a paid selector below is an entitlement wall, NOT a dead token. If the free
  // probe itself fails auth, the token is genuinely dead and the whole run is moot.
  let tokenAlive = null; // null = couldn't determine (only when !real)
  const freeModel = catalog.find((m) => m.isFreeDefault);
  if (real && freeModel) {
    try {
      const resolved = resolveConnectSelector(freeModel.alias || freeModel.selector);
      const selector = typeof resolved === 'string' ? resolved : resolved?.selector || freeModel.selector;
      const r = await _chat({
        token, model: selector,
        messages: [{ role: 'user', content: 'reply with exactly: ALIVE' }],
        maxTokens: 8, timeoutMs: TIMEOUT_MS,
      });
      tokenAlive = Boolean(r.content && r.content.trim());
    } catch {
      tokenAlive = false;
    }
  }

  for (const m of paid) {
    // Send the client-facing alias when present (that's what a real client sends);
    // the resolver maps it to the selector. Fall back to the raw selector.
    const clientModel = m.alias || m.selector;
    let outcome;
    if (!real) {
      outcome = { bucket: 'skipped', detail: 'PAID_VERIFY_REAL!=1 (dry run)' };
    } else {
      try {
        // resolveConnectSelector returns { selector, mapped } — chat() wants the
        // bare selector string.
        const resolved = resolveConnectSelector(clientModel);
        const selector = typeof resolved === 'string' ? resolved : resolved?.selector || clientModel;
        const r = await _chat({
          token,
          model: selector,
          messages: [{ role: 'user', content: 'reply with exactly: PAID_OK' }],
          maxTokens: 8,
          timeoutMs: TIMEOUT_MS,
        });
        outcome = classifyProbe({ content: r.content });
      } catch (error) {
        outcome = classifyProbe({ error });
        // Disambiguate UNAUTHORIZED using the liveness baseline: a provably-alive
        // token can't have a "dead" session, so this is an entitlement tier-wall.
        if (outcome.bucket === 'dead-token' && tokenAlive === true) {
          outcome = { bucket: 'tier-wall', detail: `entitlement wall (token verified alive via free model): ${outcome.detail}` };
        }
      }
    }
    rows.push({ alias: clientModel, selector: m.selector, provider: m.provider, ...outcome });
  }

  // Verdict: on a token claiming paid, every probed selector should be reachable.
  // tier-wall on a "paid" token means the entitlement isn't really active.
  let verdict;
  if (!real) verdict = 'dry-run (no probes fired)';
  else if (tokenAlive === false) verdict = 'token is DEAD — free-model liveness probe failed auth; re-login or replace it (paid results below are meaningless)';
  else if (!status.isPaid) verdict = 'token is FREE tier — tier-walls below are EXPECTED, not a bug';
  else {
    const walled = rows.filter((r) => r.bucket === 'tier-wall');
    const reachable = rows.filter((r) => r.bucket === 'reachable');
    verdict = walled.length === 0
      ? `PAID entitlement CONFIRMED — ${reachable.length}/${rows.length} selectors reachable`
      : `PARTIAL — ${reachable.length} reachable, ${walled.length} still tier-walled despite paid plan`;
  }

  return { isPaid: status.isPaid, plan: status.plan, tokenAlive, rows, verdict };
}

// ─── Offline self-test: proves classifyProbe + runSweep wiring with a mocked
// transport, so the harness is verified correct before any paid token exists.
async function selfTest() {
  const fakeCatalog = [
    { selector: 'swe-1-6-slow', alias: 'swe-1.6-slow', provider: 'cognition', isFreeDefault: true },
    { selector: 'claude-opus-4-8-medium', alias: 'claude-opus-4.8', provider: 'anthropic', isFreeDefault: false },
    { selector: 'gpt-5-5-low', alias: 'gpt-5.5', provider: 'openai', isFreeDefault: false },
  ];
  const assert = (cond, msg) => { if (!cond) { console.error(`[SELFTEST FAIL] ${msg}`); process.exitCode = 1; } };

  // 1) classifyProbe buckets
  assert(classifyProbe({ content: 'PAID_OK' }).bucket === 'reachable', 'content → reachable');
  assert(classifyProbe({ error: { code: 'MODEL_BLOCKED', message: 'x' } }).bucket === 'tier-wall', 'MODEL_BLOCKED → tier-wall');
  assert(classifyProbe({ error: { code: 'UNAUTHORIZED', message: 'x' } }).bucket === 'dead-token', 'UNAUTHORIZED → dead-token');
  assert(classifyProbe({ error: { code: 'RATE_LIMITED', message: 'x' } }).bucket === 'error', 'other → error');
  assert(classifyProbe({ content: '   ' }).bucket === 'error', 'empty content → error');

  // A model-aware fake transport: the free selector is alive (returns content),
  // paid selectors behave per `paidBehavior`. Mirrors the real liveness-baseline
  // flow where the free probe fires first.
  const FREE_SELECTOR = 'swe-1-6-slow';
  const makeChat = (paidBehavior) => async ({ model }) => {
    if (model === FREE_SELECTOR) return { content: 'ALIVE' };
    return paidBehavior(model);
  };

  // 2) free token, paid models tier-wall cleanly (MODEL_BLOCKED) → tier-wall, EXPECTED
  const freeRun = await runSweep({
    token: 'fake', real: true,
    deps: {
      fetchUserStatus: async () => ({ isPaid: false, plan: 'free' }),
      fetchCatalog: async () => fakeCatalog,
      chat: makeChat(() => { throw { code: 'MODEL_BLOCKED', message: 'requires paid' }; }),
    },
  });
  assert(freeRun.rows.length === 2, `free run probes 2 paid selectors (got ${freeRun.rows.length})`);
  assert(freeRun.rows.every((r) => r.bucket === 'tier-wall'), 'free run: all tier-wall');
  assert(/FREE tier/.test(freeRun.verdict), 'free run verdict flags expected tier-wall');

  // 2b) THE #42 case: free token, paid models return bare UNAUTHORIZED (no MODEL_BLOCKED
  // text) — indistinguishable from a dead token in isolation. The free-model liveness
  // baseline proves the token is alive, so these MUST reclassify dead-token → tier-wall.
  const ambiguousRun = await runSweep({
    token: 'fake', real: true,
    deps: {
      fetchUserStatus: async () => ({ isPaid: false, plan: 'free' }),
      fetchCatalog: async () => fakeCatalog,
      chat: makeChat(() => { throw { code: 'UNAUTHORIZED', message: 'an internal error occurred (trace ID: x)' }; }),
    },
  });
  assert(ambiguousRun.tokenAlive === true, 'ambiguous run: free probe proved token alive');
  assert(ambiguousRun.rows.every((r) => r.bucket === 'tier-wall'),
    `ambiguous run: bare UNAUTHORIZED reclassified to tier-wall via liveness (got ${ambiguousRun.rows.map((r) => r.bucket).join(',')})`);

  // 2c) genuinely DEAD token: even the free liveness probe fails auth → verdict says DEAD.
  const deadRun = await runSweep({
    token: 'fake', real: true,
    deps: {
      fetchUserStatus: async () => ({ isPaid: false, plan: 'free' }),
      fetchCatalog: async () => fakeCatalog,
      chat: async () => { throw { code: 'UNAUTHORIZED', message: 'dead' }; },
    },
  });
  assert(deadRun.tokenAlive === false, 'dead run: liveness probe failed');
  assert(/DEAD/.test(deadRun.verdict), 'dead run verdict flags a dead token');
  // Without a live baseline, paid UNAUTHORIZED stays dead-token (not falsely tier-wall).
  assert(deadRun.rows.every((r) => r.bucket === 'dead-token'), 'dead run: paid probes stay dead-token');

  // 3) paid token: every selector reachable; verdict CONFIRMED
  const paidRun = await runSweep({
    token: 'fake', real: true,
    deps: {
      fetchUserStatus: async () => ({ isPaid: true, plan: 'pro' }),
      fetchCatalog: async () => fakeCatalog,
      chat: makeChat(() => ({ content: 'PAID_OK' })),
    },
  });
  assert(paidRun.rows.every((r) => r.bucket === 'reachable'), 'paid run: all reachable');
  assert(/CONFIRMED/.test(paidRun.verdict), 'paid run verdict CONFIRMED');

  // 4) PAID_VERIFY_ONLY filter narrows the sweep
  const onlyRun = await runSweep({
    token: 'fake', real: true, only: ['gpt-5.5'],
    deps: {
      fetchUserStatus: async () => ({ isPaid: true, plan: 'pro' }),
      fetchCatalog: async () => fakeCatalog,
      chat: makeChat(() => ({ content: 'PAID_OK' })),
    },
  });
  assert(onlyRun.rows.length === 1 && onlyRun.rows[0].alias === 'gpt-5.5', 'only-filter narrows to 1');

  if (process.exitCode) console.error('\n[SELFTEST] FAILED — do not trust the harness until fixed.');
  else console.log('[SELFTEST] OK — classification + sweep wiring verified (7 scenarios, mocked transport).');
}

// ─── Main ────────────────────────────────────────────────────────────────────
// Guard so importing this module (the test harness does) doesn't run the CLI or
// call process.exit — only direct `node scripts/...` invocation executes below.
async function main() {
  const only = (process.env.PAID_VERIFY_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
  const token = resolveToken();

  if (!REAL) {
    console.log('PAID_VERIFY_REAL is not 1 — running offline self-test only (no token, no network, no billing).');
    console.log('To verify a real paid entitlement: PAID_VERIFY_REAL=1 CONNECT_SMOKE_PAID_TOKEN=<token> node scripts/devin-connect-paid-verify.mjs\n');
    await selfTest();
    process.exit(process.exitCode || 0);
  }

  if (!token) {
    console.error('PAID_VERIFY_REAL=1 but no token — set CONNECT_SMOKE_PAID_TOKEN.');
    process.exit(2);
  }

  console.log(`[paid-verify] firing real probes (timeout ${TIMEOUT_MS}ms each)${only.length ? ` — only: ${only.join(', ')}` : ''}\n`);
  const result = await runSweep({ token, only, real: true });

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`tier=${result.plan} paid=${result.isPaid}\n`);
  console.log(`${pad('ALIAS', 22)} ${pad('SELECTOR', 36)} ${pad('PROVIDER', 11)} ${pad('RESULT', 11)} DETAIL`);
  console.log('-'.repeat(110));
  for (const r of result.rows) {
    console.log(`${pad(r.alias, 22)} ${pad(r.selector, 36)} ${pad(r.provider, 11)} ${pad(r.bucket, 11)} ${r.detail || ''}`);
  }
  console.log('-'.repeat(110));
  console.log(`\nVERDICT: ${result.verdict}`);

  const reachable = result.rows.filter((r) => r.bucket === 'reachable').length;
  const walled = result.rows.filter((r) => r.bucket === 'tier-wall').length;
  console.log(JSON.stringify({ ok: result.isPaid ? walled === 0 : true, isPaid: result.isPaid, plan: result.plan, reachable, walled, total: result.rows.length }));
  process.exit(result.isPaid && walled > 0 ? 1 : 0);
}

// import.meta.main is true only when run as the entry point (Node 24+). Fall back
// to an argv comparison for older runtimes.
const isEntry = import.meta.main
  ?? (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href);
if (isEntry) await main();
