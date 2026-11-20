// Detach P1 — gate 2: N concurrent aborts under LS_MAX_INSTANCES=2 must not
// starve a live request of an LS slot.
//
// The design's gate 2 (§7.4): "N concurrent aborts cannot produce
// `ls_pool_exhausted` for a live request." The property under test is the
// registry's contract that a detached entry pins NO `beginLsUse` lease: only
// the request that produced it holds one, and `cascadeChat`'s finally releases
// it on every exit path. A leaked lease would make the producing LS instance
// non-evictable (`activeRequests > 0`), so at a two-instance cap the next
// proxy's `ensureLs` would wait `LS_POOL_WAIT_MS` and throw.
//
// Unlike the lazy-resume suite (which injects a fake LS entry through the
// handler deps), this harness drives the REAL pool manager: `ensureLs` spawns
// `test/helpers/fake-cascade-ls.mjs` as the LS binary, marks the entry ready
// from a real TCP connect, and `beginLsUse`/`endLsUse` account on that entry.
// The handler/client/producer/registry are the production modules.
//
// Phases (one test, because the admission counters are module-global):
//   1. default + proxyA occupy both slots; fire ABORTS (> 2) concurrent
//      aborts on proxyA. Every abort detaches; leases return to zero.
//   2. a live request on proxyB evicts the now-idle proxyA instance and
//      completes — `poolExhausted` stays 0.
//   3. NEGATIVE CONTROL: pin proxyB's lease by hand (the shape a leaked detach
//      lease would have). The same live request on proxyC must now fail with
//      the pool-capacity error (`code=CAPACITY`; internally `ls_pool_exhausted`)
//      and bump `admissionStats.poolExhausted`. A gate that cannot go red on
//      this sample is decoration.
//   4. unpin and retry: the live request completes, `poolExhausted` unchanged.
//
// POSIX-only: `ensureLs` spawns the binary directly, and the fake LS is a
// shebang script. Windows cannot spawn a shebang script without a shell, and
// the real LS is Linux-only anyway.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const POSIX = process.platform !== 'win32';
const MAX_INSTANCES = 2;
const ABORTS = 3;
const POOL_WAIT_MS = 1200;
const CALLER_KEY = 'session:detach-pressure';
const MODEL = 'gemini-2.5-flash';

// Read at module load by src/langserver.js (MAX_LS_INSTANCES) and by the
// producer (CASCADE_TIMEOUTS). Must be set before the dynamic imports below.
process.env.LS_MAX_INSTANCES = String(MAX_INSTANCES);
process.env.LS_POOL_WAIT_MS = String(POOL_WAIT_MS);
process.env.LS_EVICT_READY_GRACE_MS = '0';
process.env.LS_MEMORY_GUARD = '0';
process.env.LS_IDLE_TTL_MS = '0';
process.env.LS_AUTO_RESTART = '0';
process.env.LS_PREWARM_DEFAULT = '0';
process.env.GRPC_PROTOCOL = 'connect';
process.env.CASCADE_POLL_INTERVAL_MS = '5';
process.env.CASCADE_IDLE_GRACE_MS = '1';
process.env.CASCADE_MAX_WAIT_MS = '20000';
process.env.CASCADE_COLD_STALL_BASE_MS = '20000';
process.env.CASCADE_WARM_STALL_MS = '20000';
process.env.RESPONSE_CACHE_ENABLED = '0';
process.env.WINDSURFAPI_CASCADE_TURN = '1';
process.env.WINDSURFAPI_CASCADE_DETACH = '1';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeResponse({ closeAfterWrites = 0 } = {}) {
  const listeners = new Map();
  const writes = [];
  const state = { closed: false, writableEnded: false, statusCode: 0, body: '' };
  const res = {
    statusCode: 0,
    get writableEnded() { return state.writableEnded; },
    writeHead(status) { state.statusCode = status; res.statusCode = status; },
    write(chunk) {
      const text = String(chunk);
      state.body += text;
      writes.push({ text, afterClose: state.closed });
      if (closeAfterWrites && writes.length >= closeAfterWrites && !state.closed) {
        res.emit('close');
      }
      return true;
    },
    end(chunk) {
      if (chunk) res.write(chunk);
      state.writableEnded = true;
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
    },
    once(event, cb) {
      const wrap = (...args) => { res.removeListener(event, wrap); cb(...args); };
      res.on(event, wrap);
    },
    removeListener(event, cb) {
      const list = listeners.get(event) || [];
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    },
    emit(event, ...args) {
      if (event === 'close') state.closed = true;
      for (const cb of [...(listeners.get(event) || [])]) cb(...args);
    },
  };
  return { res, state };
}

function dataFrames(state) {
  return state.body
    .split('\n\n')
    .filter(frame => frame.startsWith('data: '))
    .map(frame => {
      const raw = frame.slice(6).trim();
      if (!raw || raw === '[DONE]') return null;
      try { return JSON.parse(raw); } catch { return null; }
    })
    .filter(Boolean);
}

function contentOf(state) {
  return dataFrames(state)
    .map(data => data.choices?.[0]?.delta?.content || '')
    .join('');
}

function errorTypeOf(state) {
  const frame = dataFrames(state).find(data => data?.error);
  return frame?.error?.type || null;
}

function errorFrameOf(state) {
  return dataFrames(state).find(data => data?.error)?.error || null;
}

function proxyFor(octet) {
  // Never dialled: the fake LS ignores its proxy env. The key only needs to be
  // distinct so the pool treats each account as a separate LS instance.
  return { host: `10.9.0.${octet}`, port: 8080 };
}

describe('Detach gate 2 — LS pool pressure', {
  skip: POSIX ? false : 'ensureLs needs to spawn a POSIX shebang fake LS',
}, () => {
  let WindsurfClient;
  let handleChatCompletions;
  let auth;
  let cache;
  let pool;
  let registry;
  let langserver;
  let fakeLsText;
  let root;
  let launcher;
  const createdIds = [];

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'windsurfapi-detach-pressure-'));
    process.env.LS_DATA_DIR = join(root, 'lsdata');
    launcher = join(root, 'fake-cascade-ls.mjs');
    writeFileSync(
      launcher,
      `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(join(__dirname, 'helpers', 'fake-cascade-ls.mjs')).href)};\n`,
      { mode: 0o755 },
    );
    chmodSync(launcher, 0o755);

    ({ WindsurfClient } = await import('../src/client.js'));
    ({ handleChatCompletions } = await import('../src/handlers/chat.js'));
    auth = await import('../src/auth.js');
    cache = await import('../src/cache.js');
    pool = await import('../src/conversation-pool.js');
    registry = await import('../src/detached-registry.js');
    langserver = await import('../src/langserver.js');
    ({ FAKE_LS_TEXT: fakeLsText } = await import('./helpers/fake-cascade-ls-constants.mjs'));
    langserver.configureLanguageServer({ binaryPath: launcher });
  });

  after(async () => {
    try { await langserver.stopLanguageServerAndWait({ perProcessTimeoutMs: 1000 }); } catch {}
    registry.detachedRegistry.reset();
    while (createdIds.length) {
      try { auth.removeAccount(createdIds.pop()); } catch {}
    }
    cache.cacheClear();
    pool.poolClear();
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  });

  function seedAccount(label) {
    const account = auth.addAccountByKey(
      `devin-session-token$xk-pressure-${label}-${Math.random().toString(36).slice(2)}`,
      label,
    );
    const internal = auth.getAccountInternal(account.id);
    internal.tier = 'pro';
    internal.status = 'active';
    createdIds.push(account.id);
    return internal;
  }

  function contextFor(acct, proxy) {
    return {
      callerKey: CALLER_KEY,
      waitForAccount: () => ({
        id: acct.id,
        email: acct.email,
        apiKey: acct.apiKey,
        proxy,
      }),
      WindsurfClient,
    };
  }

  function bodyFor(marker) {
    return {
      model: MODEL,
      messages: [{ role: 'user', content: `detach pressure ${marker}` }],
      stream: true,
    };
  }

  async function runRequest(body, ctx, responseOpts = {}) {
    const result = await handleChatCompletions(body, ctx);
    assert.equal(result.status, 200, `expected a stream, got ${JSON.stringify(result.body || result)}`);
    assert.equal(result.stream, true);
    const { res, state } = makeResponse(responseOpts);
    await result.handler(res);
    return state;
  }

  it('N>2 concurrent aborts leave a live request an evictable slot (and a leaked lease reproduces ls_pool_exhausted)', async () => {
    const acctA = seedAccount('a');
    const acctB = seedAccount('b');
    const acctC = seedAccount('c');
    const proxyA = proxyFor(1);
    const proxyB = proxyFor(2);
    const proxyC = proxyFor(3);

    registry.detachedRegistry.reset();
    cache.cacheClear();
    pool.poolClear();

    // Both slots occupied: the default instance plus account A's proxy. This is
    // the tight shape — a third key must evict, not spawn a third instance.
    const defaultEntry = await langserver.ensureLs(null);
    assert.ok(defaultEntry?.ready, 'default LS must be ready');
    const entryA = await langserver.ensureLs(proxyA);
    assert.ok(entryA?.ready, 'proxy A LS must be ready');
    let status = langserver.getLsStatus();
    assert.equal(status.maxInstances, MAX_INSTANCES);
    assert.equal(status.pool.occupancy, MAX_INSTANCES);
    assert.equal(status.admissionStats.poolExhausted, 0);

    // ── Phase 1: N concurrent aborts on the same pool entry ──────────────
    let peakActive = 0;
    const sampler = setInterval(() => {
      peakActive = Math.max(peakActive, entryA.activeRequests || 0);
    }, 1);
    sampler.unref?.();

    const aborts = [];
    try {
      for (let i = 0; i < ABORTS; i++) {
        aborts.push(runRequest(bodyFor(`abort-${i}`), contextFor(acctA, proxyA), { closeAfterWrites: 2 }));
      }
      const states = await Promise.all(aborts);
      for (const [i, state] of states.entries()) {
        assert.equal(state.closed, true, `abort ${i}: precondition — the client hung up mid-stream`);
        assert.ok(state.body.includes(fakeLsText), `abort ${i}: precondition — the prefix reached the client`);
      }
    } finally {
      clearInterval(sampler);
    }

    const afterAborts = registry.detachedRegistry.stats();
    assert.equal(afterAborts.admit, ABORTS, 'every abort must freeze a resumable snapshot');
    assert.equal(afterAborts.serve, 0, 'no abort may be counted as a resume');
    assert.ok(afterAborts.entries <= 2, `per-caller cap must bound entries (got ${afterAborts.entries})`);
    assert.equal(entryA.activeRequests, 0, 'a detached entry must pin no beginLsUse lease');
    assert.equal(peakActive, ABORTS, `concurrent aborts must overlap on the LS (peak ${peakActive})`);
    assert.equal(langserver.getLsStatus().admissionStats.poolExhausted, 0);

    // ── Phase 2: live request on a third key must evict the idle instance ─
    const liveB = await runRequest(bodyFor('live-b'), contextFor(acctB, proxyB));
    assert.ok(contentOf(liveB).includes(fakeLsText), `live request must complete, got ${JSON.stringify(liveB.body.slice(0, 400))}`);
    assert.equal(errorTypeOf(liveB), null, 'live request must not fail');
    status = langserver.getLsStatus();
    const livePoolExhausted = status.admissionStats.poolExhausted;
    assert.equal(livePoolExhausted, 0, 'a live request must never hit ls_pool_exhausted');
    assert.ok(status.admissionStats.evictions >= 1, 'the idle proxy A instance must be evicted, not a third slot spawned');
    assert.equal(status.pool.occupancy, MAX_INSTANCES);

    // ── Phase 3: negative control — a pinned lease reproduces the failure ─
    const entryB = langserver.getLsFor(proxyB);
    assert.ok(entryB?.port, 'proxy B LS must be the live non-default instance');
    const pin = langserver.beginLsUse(entryB.port);
    assert.ok(pin, 'negative control: pin the live instance');
    const exhaustedBefore = langserver.getLsStatus().admissionStats.poolExhausted;
    let starvedError = null;
    try {
      const starved = await runRequest(bodyFor('live-c-red'), contextFor(acctC, proxyC));
      starvedError = errorFrameOf(starved);
      // The OpenAI egress maps the internal `ls_pool_exhausted` type to the
      // official `api_error` (O10); `CAPACITY` and the pool message are the
      // observable wire facts. The internal classification is asserted below
      // through admissionStats.poolExhausted.
      assert.equal(starvedError?.code, 'CAPACITY',
        `negative control: a pinned lease must starve the live request, got ${JSON.stringify(starved.body.slice(0, 400))}`);
      assert.match(starvedError?.message || '', /LS pool at cap \(2\)/,
        'negative control: the failure must be the pool-capacity one');
      assert.equal(langserver.getLsStatus().admissionStats.poolExhausted, exhaustedBefore + 1,
        'the pool must record exactly one capacity failure');
    } finally {
      langserver.endLsUse(pin);
    }

    // ── Phase 4: unpin and retry — green again, same code path ───────────
    const liveC = await runRequest(bodyFor('live-c-green'), contextFor(acctC, proxyC));
    assert.ok(contentOf(liveC).includes(fakeLsText), `retry after unpin must complete, got ${JSON.stringify(liveC.body.slice(0, 400))}`);
    assert.equal(errorTypeOf(liveC), null);
    assert.equal(langserver.getLsStatus().admissionStats.poolExhausted, exhaustedBefore + 1,
      'the green path must not add a capacity failure');
    assert.equal(registry.detachedRegistry.stats().admit, ABORTS, 'a foreground live request admits nothing');

    // Decisive line for the evidence file: every number the gate claims.
    console.log(
      `GATE2 pressure: maxInstances=${MAX_INSTANCES} aborts=${ABORTS} peakActive=${peakActive} `
      + `admit=${afterAborts.admit} serve=${afterAborts.serve} entries=${afterAborts.entries} `
      + `liveGreenPoolExhausted=${livePoolExhausted} `
      + `redCode=${starvedError?.code} redPoolExhausted=${exhaustedBefore + 1} `
      + `greenAfterUnpinPoolExhausted=${langserver.getLsStatus().admissionStats.poolExhausted}`,
    );
  });
});
