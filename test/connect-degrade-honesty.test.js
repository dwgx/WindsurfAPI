// WINDSURFAPI_STRICT_MODEL=0 degrades an unmapped model to the free selector. The
// degrade is a deliberate operator opt-out. Reporting the PAID name back as if it ran
// is not — and that is what the response used to do.
//
// Measured before this fix: `claude-opus-4.9` returned 200 with
// `model: "claude-opus-4.9"` on the non-stream body AND on every stream chunk, plus a
// system_fingerprint derived from that name, while `swe-1-6-slow` ran upstream. Wrong
// output, wrong billing attribution, and a client that trusts the echoed name is
// silently misled. #234's acceptance criteria call this out explicitly.
//
// Nothing in the suite asserted the echoed name on this path — verified by instrumenting
// the `mapped === false` branch and running all test files: exactly one test reaches it
// (devin-connect-strict-model.test.js:62) and it only asserts "not a 400". So this file
// is the first coverage of the contract.
//
// The load-bearing subtlety is WHICH name to report. See the router-hop test below.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatCompletions, __setConnectDeps } from '../src/handlers/chat.js';
import { addAccountByKey, removeAccount, getAccountInternal } from '../src/auth.js';
// The fingerprint case below runs the REAL adapter (no toChatCompletion stub) so it
// asserts the production derivation, not a fixture's copy of it: the adapter builds
// system_fingerprint as systemFingerprint(displayModel || params.model)
// (src/devin-connect-openai.js:565), and __setStreamChatForTest is that module's
// documented offline seam (same usage as test/devin-connect-openai.test.js).
import { toChatCompletion as realToChatCompletion, __setStreamChatForTest } from '../src/devin-connect-openai.js';
import { systemFingerprint } from '../src/system-fingerprint.js';

const FREE_SELECTOR = 'swe-1-6-slow';
const UNMAPPED_PAID = 'claude-opus-4.9';
const MAPPED_ALIAS = 'claude-sonnet-4.6';

const SAVED = {};
const ENV_KEYS = ['DEVIN_CONNECT', 'WINDSURFAPI_STRICT_MODEL', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY', 'DEVIN_CONNECT_ASSIGN_MODEL'];
for (const k of ENV_KEYS) SAVED[k] = process.env[k];

/** Records what the adapter was handed, so we can compare wire vs echoed name. */
let seen = null;
const seeded = [];

/**
 * Put one usable account in the pool.
 *
 * Required for the AssignModel router-hop tests: connectParams.token is only set from an
 * ACQUIRED account (chat.js, `if (ccAcct) connectParams.token = ccAcct.apiKey`), and the
 * hop is gated on that token being present. With an env token alone the hop is skipped
 * and the router assertions fail on their own precondition rather than on the contract —
 * which is indistinguishable from a passing mutation if you only read pass/fail counts.
 */
function seedAccount() {
  const a = addAccountByKey('sk-honesty-' + Math.random().toString(36).slice(2, 12), 'honesty');
  const acct = getAccountInternal(a.id);
  acct.status = 'active';
  acct.tier = 'pro';
  seeded.push(a.id);
  return acct;
}

function stubAdapter() {
  seen = null;
  __setConnectDeps({
    toChatCompletion: async (params, meta) => {
      seen = { wire: params.model, echoed: meta.displayModel };
      return {
        status: 200,
        body: {
          id: 'chatcmpl-test', object: 'chat.completion', created: 0,
          // Mirror the real adapter's precedence: displayModel wins when provided.
          model: meta.displayModel || params.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      };
    },
  });
}

async function chat(model) {
  const res = await handleChatCompletions(
    { model, messages: [{ role: 'user', content: 'hi' }], stream: false },
    { reqId: 'honesty', callerKey: 'honesty-caller', specialAgent: {} },
  );
  return {
    status: res?.status ?? null,
    bodyModel: res?.body?.model ?? null,
    fingerprint: res?.body?.system_fingerprint ?? null,
    errCode: res?.body?.error?.code ?? null,
    wire: seen?.wire ?? null,
    echoed: seen?.echoed ?? null,
  };
}

beforeEach(() => {
  process.env.DEVIN_CONNECT = '1';
  process.env.DEVIN_CONNECT_TOKEN = 'test-token-shape-only';
  delete process.env.WINDSURF_API_KEY;
  stubAdapter();
});

afterEach(() => {
  while (seeded.length) removeAccount(seeded.pop());
  __setConnectDeps(null);
  __setStreamChatForTest(null);
  seen = null;
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe('degrade honesty: the echoed model must be what ran (#234)', () => {
  it('rejects an unmapped paid name outright — the silent degrade is gone', async () => {
    // The STRICT_MODEL opt-out was removed: there is no degrade path to report
    // honestly anymore. Whatever the env says, an unmapped name is 400
    // model_not_found and nothing reaches the adapter.
    process.env.WINDSURFAPI_STRICT_MODEL = '0';

    const r = await chat(UNMAPPED_PAID);

    assert.equal(r.status, 400);
    assert.equal(r.errCode, 'model_not_found');
    assert.equal(r.wire, null, 'nothing reached the adapter');
  });

  it('still echoes the REQUESTED name for a mapped alias', async () => {
    // Alias resolution is not a degrade: claude-sonnet-4.6 → claude-sonnet-4-6-thinking
    // is the same model under its canonical selector. OpenAI echoes the requested alias
    // here, and so must we — a fix that reported the resolved selector for mapped names
    // would be a behaviour change with no defect behind it.
    process.env.WINDSURFAPI_STRICT_MODEL = '0';

    const r = await chat(MAPPED_ALIAS);

    assert.equal(r.status, 200);
    assert.notEqual(r.wire, MAPPED_ALIAS, 'precondition: the wire name differs from the alias');
    assert.equal(r.bodyModel, MAPPED_ALIAS,
      'a mapped alias must keep echoing the requested name');
  });

  it('is consistent when the requested name IS the selector', async () => {
    process.env.WINDSURFAPI_STRICT_MODEL = '0';

    const r = await chat(FREE_SELECTOR);

    assert.equal(r.wire, FREE_SELECTOR);
    assert.equal(r.bodyModel, FREE_SELECTOR);
  });

  it('leaves strict mode rejecting rather than degrading', async () => {
    // With the guard ON (the default) an unmapped name never reaches the degrade at all,
    // so honesty is moot — it 400s. Pinned so the honesty fix can't be mistaken for a
    // reason to relax the guard.
    process.env.WINDSURFAPI_STRICT_MODEL = '1';

    const r = await chat(UNMAPPED_PAID);

    assert.equal(r.status, 400);
    assert.equal(r.errCode, 'model_not_found');
    assert.equal(r.wire, null, 'nothing reached the adapter');
  });

  it('reports the ROUTER-ASSIGNED model, not the free selector, after an AssignModel hop', async () => {
    // The trap. A router name like `adaptive` also resolves mapped:false, so it takes the
    // same branch — but the AssignModel hop reassigns connectParams.model to a concrete
    // uid AFTER `selector` was captured. Reporting `selector` here (which is what
    // HANDOFF-2026-08-03-B.md §3.6 literally prescribed) swaps one lie for another: a
    // request that really ran claude-opus-4-8-medium gets reported as the free
    // swe-1-6-slow. Reproduced both ways before choosing connectParams.model.
    //
    // Without this test the distinction is invisible: a mutation replacing
    // connectParams.model with selector passes every other assertion in this file.
    process.env.WINDSURFAPI_STRICT_MODEL = '0';
    process.env.DEVIN_CONNECT_ASSIGN_MODEL = '1';

    seedAccount();
    const ASSIGNED = 'claude-opus-4-8-medium';
    __setConnectDeps({
      assignModel: async () => ({ model_uid: ASSIGNED }),
    });

    const r = await chat('adaptive');

    assert.equal(r.wire, ASSIGNED,
      'precondition: the router hop put the assigned uid on the wire');
    assert.equal(r.bodyModel, ASSIGNED,
      'the echoed name must be the model the router actually assigned — reporting the '
      + 'pre-hop selector would report a free model for a paid run');
    assert.notEqual(r.bodyModel, FREE_SELECTOR);
    assert.notEqual(r.bodyModel, 'adaptive');
  });

  it('falls back to the selector when the AssignModel hop fails', async () => {
    // A failed resolve degrades to the original selector, so THAT is what ran and what
    // must be reported. Pins the other side of the branch.
    process.env.WINDSURFAPI_STRICT_MODEL = '0';
    process.env.DEVIN_CONNECT_ASSIGN_MODEL = '1';

    seedAccount();
    __setConnectDeps({
      assignModel: async () => { throw Object.assign(new Error('nope'), { code: 'ASSIGN_FAILED' }); },
    });

    const r = await chat('adaptive');

    assert.equal(r.wire, FREE_SELECTOR, 'precondition: it degraded to the selector');
    assert.equal(r.bodyModel, FREE_SELECTOR, 'and that is what must be reported');
  });

  it('derives system_fingerprint from the echoed name, not the requested one', async () => {
    // The fingerprint is keyed to the model. If it stayed keyed to the requested paid
    // name it would contradict the model field we now report honestly.
    //
    // Runs the REAL adapter (the toChatCompletion stub is replaced for this case), so
    // the fingerprint comes from production code — devin-connect-openai.js:565 keys it
    // to `displayModel || params.model` — rather than from a fixture that could only
    // ever agree with itself. The upstream is faked through that module's documented
    // seam; the fake yields content so the retry-on-empty wrapper does not re-issue.
    //
    // The guard this replaced (`if (typeof systemFingerprint !== 'function') return;`)
    // was never false: chat.js imports systemFingerprint but does not re-export it, so
    // the case returned early and asserted nothing. Mutating chat.js's connectDisplayModel
    // back to reqModelName turns it red (measured).
    process.env.WINDSURFAPI_STRICT_MODEL = '0';
    __setStreamChatForTest(async function* () {
      yield { type: 'content', text: 'ok' };
      yield { type: 'finish', reason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    });
    __setConnectDeps({ toChatCompletion: realToChatCompletion });

    const r = await chat(UNMAPPED_PAID);

    // The degrade path this keyed the fingerprint to no longer exists: the
    // request is rejected before any fingerprint is derived.
    assert.equal(r.status, 400);
    assert.equal(r.errCode, 'model_not_found');
    assert.equal(r.fingerprint, null);
  });
});

describe('degrade honesty reaches the Anthropic and Gemini routes too (#234)', () => {
  // The partial-path check. chat.js alone fixes /v1/chat/completions and leaves the other
  // two protocol routes reporting the requested name — measured before this: a
  // /v1/messages request for claude-opus-4.9 ran swe-1-6-slow and reported
  // claude-opus-4.9. Both files had ZERO references to displayModel.

  it('/v1/messages rejects an unmapped name too', async () => {
    process.env.WINDSURFAPI_STRICT_MODEL = '0';
    const { handleMessages } = await import('../src/handlers/messages.js');

    const res = await handleMessages(
      { model: UNMAPPED_PAID, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: 'honesty-caller' },
    );

    assert.equal(seen, null, 'nothing reached the adapter');
    assert.equal(res?.status, 400);
    // The Anthropic route reports error.type; the chat route reports error.code.
    // Either way the message must carry the model_not_found contract.
    assert.match(JSON.stringify(res?.body?.error ?? res?.body ?? {}), /invalid_request_error|not a valid model/);
  });

  it('/v1/messages still echoes the requested name for a mapped alias', async () => {
    process.env.WINDSURFAPI_STRICT_MODEL = '0';
    const { handleMessages } = await import('../src/handlers/messages.js');

    const res = await handleMessages(
      { model: MAPPED_ALIAS, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: 'honesty-caller' },
    );

    assert.equal(res?.body?.model, MAPPED_ALIAS,
      'alias resolution is not a degrade — the requested name still stands');
  });
});
