// #234 — the drought gate must be REACHABLE on the production default backend,
// and must stay reachable.
//
// History this guards: the DEVIN_CONNECT short-circuit block in chat.js returns on
// every exit path, and the drought gate lived AFTER that block. Production defaults
// to DEVIN_CONNECT=1, so the gate had never executed on the default backend — the
// feature was structurally dead rather than subtly wrong.
//
// Two layers here, because either alone is escapable:
//
//   1. BEHAVIOURAL — drive handleChatCompletions and assert the 503 actually comes
//      back. This is the part that cannot be satisfied by rearranging source text.
//   2. STRUCTURAL — enumerate the block's ESCAPE POINTS (returns that leave before
//      the gate) and require each one to be either gated or explicitly listed as
//      exempt with a reason. Enumerating by escape point rather than by backend
//      flow is deliberate: the ACP vision reroute is not a `selectBackend` flow at
//      all, it is devin_connect escaping INTO special_agent, so a flow-based guard
//      cannot see it.
//
// The structural half strips comments before reading structure — a previous guard
// in this repo was satisfied by a code sample quoted in its own comment.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addAccountByKey, removeAccount, getAccountInternal, isDroughtMode,
} from '../src/auth.js';
import { handleChatCompletions } from '../src/handlers/chat.js';

const CHAT_PATH = new URL('../src/handlers/chat.js', import.meta.url);

const created = [];
const SAVED = {};
const ENV_KEYS = ['DEVIN_CONNECT', 'DROUGHT_RESTRICT_PREMIUM', 'WINDSURFAPI_STRICT_MODEL',
                  'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY'];
for (const k of ENV_KEYS) SAVED[k] = process.env[k];

function pool(weeklyPercent, n = 3) {
  for (let i = 0; i < n; i++) {
    const a = addAccountByKey('sk-reach-' + Math.random().toString(36).slice(2, 12), 'reach');
    const acct = getAccountInternal(a.id);
    acct.status = 'active';
    acct.credits = { weeklyPercent, dailyPercent: weeklyPercent };
    created.push(a.id);
  }
}

async function chat(model) {
  const res = await handleChatCompletions(
    { model, messages: [{ role: 'user', content: 'hi' }], stream: false },
    { reqId: 'reach', callerKey: 'reach-caller', specialAgent: {} },
  );
  return {
    status: res?.status ?? null,
    type: res?.body?.error?.type ?? null,
    code: res?.body?.error?.code ?? null,
    allowed: res?.body?.error?.drought?.allowedModels ?? null,
  };
}

afterEach(() => {
  while (created.length) removeAccount(created.pop());
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe('drought gate reachability on DEVIN_CONNECT (#234)', () => {
  function connectDroughtEnv() {
    process.env.DEVIN_CONNECT = '1';
    process.env.DROUGHT_RESTRICT_PREMIUM = '1';
    process.env.WINDSURFAPI_STRICT_MODEL = '1';
    delete process.env.DEVIN_CONNECT_TOKEN;
    delete process.env.WINDSURF_API_KEY;
  }

  it('returns 503 drought_mode for a premium selector on the connect backend', async () => {
    connectDroughtEnv();
    pool(1);
    assert.equal(isDroughtMode(), true, 'precondition: pool is in drought');

    const res = await chat('claude-opus-4-8-medium');
    assert.equal(res.status, 503, 'the gate must actually run on the default backend');
    assert.equal(res.type, 'drought_mode');
  });

  it('offers only connect-reachable models in the drought error body', async () => {
    connectDroughtEnv();
    pool(1);

    const res = await chat('claude-opus-4-8-medium');
    assert.ok(Array.isArray(res.allowed) && res.allowed.length > 0);
    assert.ok(res.allowed.includes('swe-1-6-slow'),
      'the fallback offered to the client must be routable on this backend');
    assert.ok(!res.allowed.includes('gemini-2.5-flash'),
      'connect cannot route to the Cascade free model, so it must not be advertised');
  });

  it('does NOT block the free-reachable selector during a drought', async () => {
    connectDroughtEnv();
    pool(1);

    const res = await chat('swe-1-6-slow');
    assert.notEqual(res.status, 503,
      'blocking the only free-reachable selector would black out a drought-mode pool');
    assert.notEqual(res.type, 'drought_mode');
  });

  it('keeps the strict-model 400 ahead of the drought 503', async () => {
    // Ordering matters for diagnosability: a typo'd model name must report
    // model_not_found, not "the pool is dry".
    connectDroughtEnv();
    pool(1);

    const res = await chat('TOTAL-GARBAGE');
    assert.equal(res.status, 400);
    assert.equal(res.code, 'model_not_found');
  });

  it('does not block a premium selector when the pool is healthy', async () => {
    connectDroughtEnv();
    pool(80);
    assert.equal(isDroughtMode(), false);

    const res = await chat('claude-opus-4-8-medium');
    assert.notEqual(res.status, 503);
    assert.notEqual(res.type, 'drought_mode');
  });

  it('respects the restriction toggle on the connect path', async () => {
    connectDroughtEnv();
    process.env.DROUGHT_RESTRICT_PREMIUM = '0';
    pool(1);
    assert.equal(isDroughtMode(), true, 'still a drought, just not enforcing');

    const res = await chat('claude-opus-4-8-medium');
    assert.notEqual(res.type, 'drought_mode');
  });
});

describe('drought gate structure — escape points (#234)', () => {
  /** chat.js with comments and string bodies removed, so structure is read from code only. */
  function codeOnly() {
    const raw = readFileSync(CHAT_PATH, 'utf8');
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
  }

  function connectBlockRange(code) {
    const lines = code.split('\n');
    const start = lines.findIndex((l) => /flow === 'devin_connect'/.test(l));
    assert.ok(start >= 0, 'the connect short-circuit block must be findable');
    let depth = 0;
    let began = false;
    for (let i = start; i < lines.length; i++) {
      const stripped = lines[i].replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
      for (const ch of stripped) {
        if (ch === '{') { depth++; began = true; } else if (ch === '}') { depth--; }
      }
      if (began && depth === 0) return { start, end: i, lines };
    }
    throw new Error('connect block end not found');
  }

  it('places the drought gate INSIDE the connect short-circuit block', () => {
    const code = codeOnly();
    const { start, end, lines } = connectBlockRange(code);
    const gateLine = lines.findIndex((l) => /isConnectSelectorBlockedByDrought\s*\(/.test(l));

    assert.ok(gateLine > start && gateLine < end,
      `the connect drought gate must sit inside the block (${start + 1}..${end + 1}); ` +
      `found at ${gateLine + 1}. Outside it, every exit path returns first and the gate is dead code.`);
  });

  it('enumerates every escape point above the gate and requires each to be justified', () => {
    const code = codeOnly();
    const { start, lines } = connectBlockRange(code);
    const gateLine = lines.findIndex((l) => /isConnectSelectorBlockedByDrought\s*\(/.test(l));

    // Escape points = returns between the block start and the gate. Each one leaves
    // the connect path WITHOUT passing the drought gate, so each needs a reason.
    //
    // Known and accepted, by design:
    //   - ACP vision reroute      -> hands off to the special_agent backend, whose
    //                                own MODELS-space gate applies there. It is a
    //                                DIFFERENT namespace, so applying the connect
    //                                selector predicate would be wrong.
    //   - strict-model 400        -> the model does not resolve at all; a precise
    //                                model_not_found beats a misleading 503.
    const ACCEPTED_ESCAPES = [
      { match: /handleSpecialAgentChatCompletion/, why: 'ACP vision reroute → special_agent namespace' },
      { match: /code: 'model_not_found'/, why: 'unresolvable model name → precise 400' },
    ];

    const escapes = [];
    for (let i = start; i < gateLine; i++) {
      if (/^\s*return\b/.test(lines[i])) {
        // Attribute this return to the nearest preceding recognisable marker.
        const window = lines.slice(Math.max(start, i - 14), i + 14).join('\n');
        const known = ACCEPTED_ESCAPES.find((e) => e.match.test(window));
        escapes.push({ line: i + 1, known: known ? known.why : null });
      }
    }

    const unexplained = escapes.filter((e) => !e.known);
    assert.deepEqual(unexplained, [],
      'A new return was added above the drought gate, so requests taking it now bypass ' +
      'the gate entirely. Either move the gate above it, or add it to ACCEPTED_ESCAPES ' +
      'with a reason. Unexplained escape points: ' + JSON.stringify(unexplained));

    // Guard the guard: if this drops to zero the enumeration silently stopped
    // matching anything and would pass no matter what got added.
    assert.ok(escapes.length >= 2,
      `expected to find the known escape points; found ${escapes.length}. ` +
      'The enumeration is probably no longer matching real returns.');
  });

  it('places the gate before any account is acquired', () => {
    // A blocked request must not consume an account slot or a queue wait.
    const code = codeOnly();
    const { start, end, lines } = connectBlockRange(code);
    const gateLine = lines.findIndex((l) => /isConnectSelectorBlockedByDrought\s*\(/.test(l));

    let firstAcquire = -1;
    for (let i = start; i < end; i++) {
      if (/acquireConnectAccount\s*\(|waitForAccount\s*\(/.test(lines[i])) { firstAcquire = i; break; }
    }
    assert.ok(firstAcquire > 0, 'expected an account acquisition inside the connect block');
    assert.ok(gateLine < firstAcquire,
      `the gate (line ${gateLine + 1}) must precede account acquisition (line ${firstAcquire + 1})`);
  });
});
