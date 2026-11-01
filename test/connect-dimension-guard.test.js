// Structural guard: the `modelKey=null` trap on the DEVIN_CONNECT path.
//
// Connect selection always calls getApiKey(triedKeys, null, callerKey, selector)
// — modelKey is null because connect selectors live in a different namespace from
// the Cascade catalog. isRateLimitedForModel only consults _modelRateLimits when
// modelKey is truthy, so ANY per-model state written under the client-facing model
// name is structurally invisible to connect selection.
//
// This has now bitten three times:
//   #224  RATE_LIMITED wrote a model-scoped cooldown → pool re-picked the 429'd
//         account seconds later, hammering the upstream velocity limiter.
//   #230  the sticky binding had to be WRITTEN with modelKey=null or the lookup
//         (which asks for `caller\0*`) would silently never resolve.
//   v3.8.0 CAPACITY wrote its 60s cooldown under reqModelName → invisible, so the
//         window never applied and sticky re-pinned the overloaded account.
//
// These tests are the tripwire for a fourth occurrence — but only partly, and the
// distinction matters:
//
//   * The behavioural half below writes each cooldown BY HAND via markRateLimited
//     and asserts auth.js honours it. That covers the auth-side dimension logic.
//     It does NOT cover which dimension chat.js chooses, which is what was
//     actually wrong all three times above.
//   * The source half slices chat.js lexically. Measured: moving the CAPACITY
//     write into a helper declared after `waitForAccount` — same defect, same
//     reversed `model || selector` — leaves this whole file at 10/10.
//
// `connect-dimension-behaviour.test.js` closes that gap by driving the real
// `finalizeConnectAccount` and asserting the pool outcome, with `model` and
// `selector` deliberately different (they are the same string in the tests below,
// so a write in either dimension looks identical here). Both files are kept: this
// one also enforces "no new call site in the slice picks a bad dimension", which
// is a real and different property.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addAccountByKey, removeAccount, getAccountInternal,
  getApiKey, releaseAccountById, markRateLimited, markQuotaExhausted,
} from '../src/auth.js';

const created = [];
function seed(label) {
  const a = addAccountByKey(`devin-session-token$dim-${label}-${Math.random().toString(36).slice(2)}`, label);
  created.push(a.id);
  return getAccountInternal(a.id);
}
afterEach(() => { while (created.length) removeAccount(created.pop()); });

const SELECTOR = 'swe-1-6-slow';

describe('connect selection sees every cooldown a connect request can cause', () => {
  // The shape connect always uses. If a cooldown does not gate THIS call, the
  // pool will re-pick the account that just failed.
  const connectLookup = (excludeKeys = []) => getApiKey(excludeKeys, null, null, SELECTOR);

  // A cooled account may still come back as a DEGRADED serve when the whole pool
  // is throttled (auth.js pickDegradedFallback — the deliberate alternative to a
  // blanket 429). That is opt-in and clearly flagged. What must NEVER happen is a
  // NORMAL selection handing the cooled account back as if it were healthy.
  // 2026-11-01: the `picked === null` branch used to `return` silently. "Not
  // selected" alone is ambiguous — an EVICTED account (status='error') is also
  // unselectable, so a cooldown that wrongly evicted the account would pass this
  // guard for the wrong reason. The sibling file already carries this assertion
  // (connect-dimension-behaviour.test.js:89-96); this is the same check here.
  const assertNotNormallySelected = (picked, what, acct) => {
    if (picked === null) {
      if (acct) {
        const after = getAccountInternal(acct.id);
        assert.notEqual(after.status, 'error',
          `${what} evicted the account instead of cooling it. "Not selected" would `
          + 'then pass for the wrong reason.');
      }
      return;
    }
    assert.ok(picked._degraded,
      `${what} was handed back by normal selection — the cooldown is invisible to `
      + 'the connect lookup (modelKey=null). See #224 / v3.8.0 CAPACITY.');
    releaseAccountById(picked.id);
  };

  it('account-wide cooldown (RATE_LIMITED, #224) gates the connect lookup', () => {
    const a = seed('rl');
    markRateLimited(a.apiKey, 60_000, null, 'r');
    assertNotNormallySelected(connectLookup(), 'an account-wide cooldown', a);
  });

  it('selector-scoped cooldown (CAPACITY, v3.8.0) gates the connect lookup', () => {
    const a = seed('cap');
    markRateLimited(a.apiKey, 60_000, SELECTOR, 'c');
    assertNotNormallySelected(connectLookup(), 'a selector-scoped cooldown', a);
  });

  it('quota cooldown (QUOTA_EXHAUSTED) gates the connect lookup', () => {
    const a = seed('quota');
    markQuotaExhausted(a.apiKey, 60_000);
    assertNotNormallySelected(connectLookup(), 'a quota dry-well', a);
  });

  it('a healthy peer is preferred over any cooled account (no degraded serve needed)', () => {
    const cooled = seed('cooled');
    const healthy = seed('healthy');
    markRateLimited(cooled.apiKey, 60_000, SELECTOR, 'c');
    const picked = connectLookup();
    assert.ok(picked, 'the healthy peer must serve');
    assert.equal(picked.id, healthy.id, 'must not pick the cooled account while a healthy one exists');
    assert.ok(!picked._degraded, 'and it must be a normal serve, not a degraded one');
    releaseAccountById(picked.id);
  });

  it('a cooldown under the CLIENT-FACING model name is the trap — it must not be how connect state is written', () => {
    // This documents the failure mode rather than asserting it is fixed: writing
    // under a name connect never queries produces a cooldown that does nothing.
    // The guard below (source-level) is what prevents new code from doing this.
    const a = seed('trap');
    markRateLimited(a.apiKey, 60_000, 'gpt-5.5', 'c'); // a client-facing alias
    const picked = connectLookup();
    assert.ok(picked, 'demonstrates the trap: connect cannot see this dimension');
    releaseAccountById(picked.id);
  });
});

describe('source guard: finalizeConnectAccount never writes a client-facing model dimension', () => {
  const src = readFileSync(new URL('../src/handlers/chat.js', import.meta.url), 'utf8');
  const body = src.slice(
    src.indexOf('export function finalizeConnectAccount'),
    src.indexOf('async function waitForAccount'),
  );

  it('was located', () => assert.ok(body.length > 200, 'finalizeConnectAccount body not found'));

  // Split one cooldown call into balanced argument expressions.
  //
  // The previous version matched `mark...\([^)]*\)`, which stops at the FIRST
  // `)` — so any nested call truncated the argument list. On unmutated source
  // that already mis-parsed a real call site
  // (`markRateLimited(apiKey, getBreakerTunable('rlBurstMs'), null)` came back
  // as two arguments), and the missing third argument then defaulted to the
  // string 'null' and was waved through. Measured: rewriting that call's third
  // argument to the client-facing `model` — the #224 defect verbatim — left the
  // suite at 9/9.
  function argsOf(call) {
    const open = call.indexOf('(');
    let depth = 0;
    let current = '';
    const args = [];
    for (let i = open; i < call.length; i++) {
      const ch = call[i];
      if (ch === '(' || ch === '[') { depth++; if (depth === 1) continue; }
      else if (ch === ')' || ch === ']') {
        depth--;
        if (depth === 0) { args.push(current.trim()); return args; }
      } else if (ch === ',' && depth === 1) { args.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    return args;
  }

  // Grab each call with balanced parentheses so nested calls stay intact.
  function cooldownCalls(text) {
    const out = [];
    const re = /mark(?:RateLimited|QuotaExhausted)\(/g;
    for (const m of text.matchAll(re)) {
      let depth = 0;
      for (let i = m.index + m[0].length - 1; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')' && --depth === 0) { out.push(text.slice(m.index, i + 1)); break; }
      }
    }
    return out;
  }

  it('every cooldown it writes uses null (account-wide) or the resolved selector', () => {
    const calls = cooldownCalls(body);
    assert.ok(calls.length >= 3, `expected the cooldown calls, found ${calls.length}`);

    // Every call must be parsed to its real arity. A truncated parse is itself a
    // failure: it is how the guard used to accept the defect.
    for (const call of calls) {
      if (call.startsWith('markQuotaExhausted')) continue;
      const args = argsOf(call);
      assert.ok(
        args.length >= 3,
        `${call}\n  → parsed only ${args.length} argument(s). The dimension argument must be `
        + 'visible to this guard; a parse that loses it silently accepts the #224 defect.',
      );
    }

    // Accept exactly two spellings of the dimension, by set difference rather
    // than substring. `dimension.includes('selector')` used to accept
    // `model || selector` — the REVERSED fallback, which is the v3.8.0 CAPACITY
    // defect verbatim, because `model` is always truthy in production
    // (chat.js passes `{ model: reqModelName, selector }`). Measured: that
    // mutation left the suite at 9/9 while the pool re-picked the throttled
    // account. So the allowlist is literal.
    const ALLOWED_DIMENSIONS = new Set([
      'null',
      'undefined',
      'selector',
      // The Cascade path legitimately passes a real catalog modelKey, and the
      // connect path must win when both are present — so only this order.
      'selector || model',
    ]);

    const offenders = calls
      .filter((call) => !call.startsWith('markQuotaExhausted'))
      .map((call) => ({ call, dimension: argsOf(call)[2] ?? 'null' }))
      .filter(({ dimension }) => !ALLOWED_DIMENSIONS.has(dimension));

    assert.deepEqual(
      offenders.map(o => `${o.dimension}  in  ${o.call}`), [],
      'a cooldown is written in a dimension connect selection (modelKey=null) cannot see. '
      + `Allowed spellings: ${[...ALLOWED_DIMENSIONS].join(' | ')}. Note that \`model || selector\` `
      + 'is NOT allowed even though it mentions the selector: `model` is always truthy on the '
      + 'connect path, so the reversed order restores the v3.8.0 CAPACITY defect. See #224.',
    );
  });

  it('the guard itself parses the real call sites (meta-check)', () => {
    // A guard that silently parses nothing passes forever. Pin the shape it sees.
    const calls = cooldownCalls(body);
    const rateLimited = calls.filter(c => c.startsWith('markRateLimited'));
    assert.ok(rateLimited.length >= 2,
      `expected multiple markRateLimited call sites, parsed ${rateLimited.length}`);
    for (const call of rateLimited) {
      assert.ok(argsOf(call).length >= 3, `truncated parse of: ${call}`);
    }
    // And confirm the nested-call shape specifically, since that is what broke.
    const nested = rateLimited.find(c => c.includes('getBreakerTunable'));
    if (nested) {
      const args = argsOf(nested);
      assert.equal(args.length, 3,
        `the nested-call site must parse to 3 arguments, got ${args.length}: ${JSON.stringify(args)}`);
      assert.match(args[1], /getBreakerTunable/, 'the nested call must survive parsing intact');
    }
  });
});

describe('source guard: connect account acquisition keeps modelKey=null', () => {
  const src = readFileSync(new URL('../src/handlers/chat.js', import.meta.url), 'utf8');

  it('acquireConnectFailover passes null as modelKey', () => {
    const fn = src.slice(src.indexOf('function acquireConnectFailover'), src.indexOf('function connectFailoverMax'));
    assert.match(fn, /getApiKey\(triedKeys,\s*null,/,
      'connect failover must keep modelKey=null — the sticky binding and every '
      + 'cooldown dimension are written to match this lookup shape');
  });

  it('bindConnectSticky writes the binding with modelKey=null to match', () => {
    const fn = src.slice(src.indexOf('export function bindConnectSticky'), src.indexOf('// How many times a single DEVIN_CONNECT'));
    assert.match(fn, /setStickyBinding\(callerKey,\s*null,/,
      'a model-scoped write would land in a slot the connect lookup never asks for '
      + '(bindingKey is callerKey\\0(modelKey||"*")) — silently no-op, i.e. #230 regressed');
  });
});
