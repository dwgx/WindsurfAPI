import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/handlers/chat.js', import.meta.url), 'utf8');
function topFunction(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  const end = source.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start, `actual ${name} definition must exist`);
  return source.slice(start, end);
}
async function run(pattern, env = {}, emittedInitially = false, freeOnlyDroughtAdmission = false) {
  const start = source.indexOf('          const attemptStream = async (a) => {');
  const end = source.indexOf('            if (leakTraceEnabled()) {', start);
  assert.ok(start >= 0 && end > start, 'the complete production attempt/loop block is required');
  const ladder = source.slice(start, end) + '\n          } finally {}';
  const accounts = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, apiKey: `key-${i}` }));
  let now = 0, scheduled = 0; const attempts = [], events = [], finalized = [], acquisitions = [];
  const deps = {
    accounts, env, emittedInitially,
    // Named like the handler's local so the extracted block closes over it.
    freeOnlyDroughtAdmission,
    getApiKey: (tried, _modelKey, _callerKey, _selector, opts) => {
      acquisitions.push(opts);
      return accounts.find(a => !tried.includes(a.apiKey)) || null;
    },
    setTimeout(fn, ms) { scheduled++; now += ms; queueMicrotask(fn); return scheduled; }, clearTimeout() {},
    streamChatCompletion: async params => {
      const n = attempts.length; attempts.push({ token: params.token, at: now });
      const code = typeof pattern === 'function' ? pattern(n) : pattern[n];
      if (code) throw Object.assign(new Error(code), { code });
      return { content: 'ok', toolCalls: [], finish_reason: 'stop' };
    },
    ensureDeviceSeed: () => undefined, recordTokenUsage() {}, recordAccountSpend() {}, connectSpendOpts: () => ({}),
    finalizeConnectAccount: (a, result) => finalized.push({ id: a?.id, err: result.err?.code }),
    isAbortError: e => e?.name === 'AbortError',
    reLoginAccount: async id => `fresh-${id}`, currentApiKeyForId: (_id, key) => key,
    bumpConnect: event => events.push(event), releaseAccountById() {}, bindConnectSticky() {}, commitConnectSession() {},
    reportDeadToken() {}, isAccountFailoverError: code => ['QUOTA_EXHAUSTED', 'RATE_LIMITED'].includes(code),
    // The failover loop reads the route budget from context; an empty context
    // means "no budget", which is the pre-budget behaviour these cases pin.
    context: {}, budgetExceededError: message => Object.assign(new Error(message), { code: 'DEADLINE_EXCEEDED' }),
    chatStreamError: (message, type, code) => ({ error: { message, type, code } }),
    // D2: attemptStream decides whether to buffer the adapter's frames from the
    // request's JSON Schema. This harness pins the failover ladder, so it runs
    // the no-schema arm (frames pass straight to `send`).
    jsonSchema: null,
    log: { info() {}, error() {} }, AbortController,
  };
  // The extracted success arm uses the real delivery helper and its private
  // Symbol, including the no-hook direct Chat behaviour pinned by this fixture.
  const deliverySymbol = source.match(/^export (const DEFER_STREAM_DELIVERY = Symbol\([^\r\n]*\);)$/m)?.[1];
  assert.ok(deliverySymbol, 'actual DEFER_STREAM_DELIVERY declaration must exist');
  const body = `${deliverySymbol}\n${topFunction('publishStreamDelivery')}\n${topFunction('acquireConnectFailover')}\n${topFunction('connectFailoverMax')}\nreturn (async () => {
    const connectParams = {}, connectMeta = {}, reqId = 'r', reqModelName = 'model', selector = 'model', connectDisplayModel = 'model';
    const ccStart = 0, ccAcct = accounts[0], callerKey = 'owner', connectMessages = [], incomingConnectReasoning = '';
    const abortController = new AbortController(), triedKeys = [], maxHops = connectFailoverMax(env);
    let emitted = emittedInitially;
    const send = frame => { emitted = true; };
    ${ladder}
  })();`;
  await new Function(...Object.keys(deps), body)(...Object.values(deps));
  return { attempts, events, finalized, scheduled, acquisitions };
}

test('R5 default outer ceiling is three adapter calls, with two account gaps', async () => {
  // Q5 ownership: the handler no longer replays transport faults (the adapter
  // owns that one bounded retry), so the only per-account retry left in this
  // block is account failover. A pool where every account is quota-dry burns
  // one adapter call per account: initial + two 500ms/1000ms hops.
  const r = await run(() => 'QUOTA_EXHAUSTED');
  assert.equal(r.attempts.length, 3);
  assert.deepEqual(r.attempts.map(a => a.at), [0, 500, 1000]);
  assert.equal(r.events.filter(x => x === 'quota_failover_hops').length, 2);
  assert.equal(r.finalized.length, 3);
  // Ordinary admission: the two failover acquisitions must not claim free-only.
  assert.equal(r.acquisitions.length, 2);
  assert.ok(r.acquisitions.every(opts => !opts?.freeOnly), 'ordinary hops must not fabricate a free-only admission');

  // Free-only drought admission rides every failover hop without changing the
  // ladder shape: still one adapter call per account, same two 500ms gaps.
  const free = await run(() => 'QUOTA_EXHAUSTED', {}, false, true);
  assert.equal(free.attempts.length, 3);
  assert.deepEqual(free.attempts.map(a => a.at), [0, 500, 1000]);
  assert.equal(free.events.filter(x => x === 'quota_failover_hops').length, 2);
  assert.equal(free.finalized.length, 3);
  assert.equal(free.acquisitions.length, 2);
  assert.ok(free.acquisitions.every(opts => opts?.freeOnly === true), 'each free-only hop must pass { freeOnly: true }');
});

test('R5 healthy first-attempt success has zero scheduled delay', async () => {
  const r = await run([]);
  assert.equal(r.attempts.length, 1); assert.equal(r.scheduled, 0); assert.equal(r.attempts[0].at, 0);
});

test('R5 repeated transient failures stay on one handler attempt and never hop', async () => {
  // The adapter (devin-connect-openai.js) owns the single transport retry, so
  // one handler attempt is the whole handler-side cost of a persistent 5xx.
  const r = await run(() => 'STREAM_TRUNCATED');
  assert.equal(r.attempts.length, 1); assert.equal(r.scheduled, 0);
});

test('R5 max=0 and already-emitted payload retain the original retry vetoes', async () => {
  const zero = await run(() => 'QUOTA_EXHAUSTED', { DEVIN_CONNECT_FAILOVER_MAX: '0' });
  assert.equal(zero.attempts.length, 1); assert.equal(zero.scheduled, 0);
  const emitted = await run(() => 'STREAM_TRUNCATED', {}, true);
  assert.equal(emitted.attempts.length, 1); assert.equal(emitted.scheduled, 0);
});
