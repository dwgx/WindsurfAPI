// Detach P1 — end-to-end lazy resume (T1–T19).
//
// Harness: a scripted loopback LS (the shape used by
// test/cascade-abort-side-effects.test.js) plus a response double that closes
// the socket at a chosen write. The producer is the real cascadeChat; the
// handler is the real streamResponse.
//
// What P1 promises and these tests pin:
//   - an aborted mid-stream turn freezes a v2 snapshot (T1);
//   - a byte-identical retry CLAIMS it and continues the original poll loop:
//     no StartCascade, no SendUserCascadeMessage, prefix replayed exactly once
//     (T5, T7, T11);
//   - billing starts the metadata RPC at the snapshot's generatorOffset (T3)
//     and lands on the entry's owner account even though the resume has no
//     checked-out account (T5);
//   - every negative (pre-content, tool call, tenant, shutdown, drain, TTL,
//     generation, cascade gone, account removed) admits nothing and falls
//     back to upstream, each with a positive control in the same file.
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { terminateRpcWithStatus, isConnectContentType } from './helpers/fake-grpc-trailers.mjs';
import { endOfStreamEnvelope, unwrapRequest, wrapEnvelope } from '../src/connect.js';
import { getField, parseFields, writeMessageField, writeStringField, writeVarintField } from '../src/proto.js';

// Module-level env (client.js snapshots CASCADE_TIMEOUTS, grpc.js snapshots
// GRPC_PROTOCOL). Both switches are on for this file; the flag-off parity test
// deletes the detach switch around its request.
process.env.GRPC_PROTOCOL = 'connect';
process.env.CASCADE_POLL_INTERVAL_MS = '5';
process.env.CASCADE_IDLE_GRACE_MS = '1';
process.env.CASCADE_MAX_WAIT_MS = '200000';
process.env.CASCADE_COLD_STALL_BASE_MS = '200000';
process.env.CASCADE_WARM_STALL_MS = '200000';
process.env.RESPONSE_CACHE_ENABLED = '0';
process.env.WINDSURFAPI_CASCADE_TURN = '1';
process.env.WINDSURFAPI_CASCADE_DETACH = '1';

const PREFIX = 'PREFIX-ANSWER-';
const GROWTH = 'GROWTH-AFTER-DETACH-';
const FULL_TEXT = `${PREFIX}${GROWTH}`;

let WindsurfClient;
let handleChatCompletions;
let resolveModel;
let auth;
let cache;
let pool;
let registry;
let sse;

// ── proto helpers ────────────────────────────────────────────
function grpcFrame(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.alloc(5 + buf.length);
  frame[0] = 0;
  frame.writeUInt32BE(buf.length, 1);
  buf.copy(frame, 5);
  return frame;
}

function responseBody(payload, headers) {
  const contentType = String(headers['content-type'] || '');
  if (isConnectContentType(contentType)) {
    return Buffer.concat([wrapEnvelope(payload, { compress: false }), endOfStreamEnvelope()]);
  }
  return grpcFrame(payload);
}

function endOfStreamError(message, code = 'not_found') {
  const trailer = Buffer.from(JSON.stringify({ error: { code, message } }));
  const frame = Buffer.alloc(5 + trailer.length);
  frame[0] = 0x02;
  frame.writeUInt32BE(trailer.length, 1);
  trailer.copy(frame, 5);
  return frame;
}

function plannerStep(text, { status = 3, thinking = '', toolCall = null } = {}) {
  const plannerParts = [writeStringField(1, text)];
  if (thinking) plannerParts.push(writeStringField(3, thinking));
  const parts = [
    writeVarintField(1, 15), // CORTEX_STEP_TYPE_PLANNER_RESPONSE
    writeVarintField(4, status),
    writeMessageField(20, Buffer.concat(plannerParts)),
  ];
  if (toolCall) {
    const call = Buffer.concat([
      writeStringField(1, toolCall.id),
      writeStringField(2, toolCall.name),
      writeStringField(3, toolCall.argumentsJson),
    ]);
    // 49 = tool_call_proposal { 1 = ChatToolCall }
    parts.push(writeMessageField(49, writeMessageField(1, call)));
  }
  return Buffer.concat(parts);
}

function rawStepsResponse(steps) {
  return Buffer.concat(steps.map(step => writeMessageField(1, step)));
}

function readStepOffset(payload) {
  const field = getField(parseFields(payload), 2, 0);
  return field ? Number(field.value) : 0;
}

function metadataEntry(inputTokens, outputTokens) {
  const usage = Buffer.concat([
    writeVarintField(2, inputTokens),
    writeVarintField(3, outputTokens),
  ]);
  const chatModel = writeMessageField(4, usage);
  return writeMessageField(1, chatModel); // CortexStepGeneratorMetadata.chat_model
}

function metadataResponse(records) {
  return Buffer.concat(records.map(record => writeMessageField(1, record)));
}

// ── scripted upstream ────────────────────────────────────────
/**
 * One fake LS per test. `state.grown` flips the same step from PREFIX to
 * FULL_TEXT (in-place growth, the E2b shape). `state.status` is ACTIVE until
 * the test flips it to IDLE. `state.failNextSteps` makes the next steps read
 * a Connect end-stream error (cascade gone).
 */
function cascadeUpstream({ initialText = PREFIX, toolCall = null, thinkingOnly = false } = {}) {
  const state = {
    startCalls: 0,
    sendCalls: 0,
    stepsCalls: 0,
    statusCalls: 0,
    metadataCalls: 0,
    metadataOffsets: [],
    stepsOffsets: [],
    grown: false,
    status: 'active',
    failNextSteps: 0,
    resumeDelayMs: 0,
    firstResumeRead: true,
    stepsFor: null, // optional (offset) => Buffer
  };
  const handler = (stream, headers) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => {
      const method = String(headers[':path'] || '').split('/').pop();
      const contentType = headers['content-type'] || 'application/grpc';
      const payload = unwrapRequest(Buffer.concat(chunks), headers);
      const respond = (body) => {
        stream.respond({ ':status': 200, 'content-type': contentType });
        stream.end(responseBody(body, headers));
      };

      if (method === 'StartCascade') {
        state.startCalls += 1;
        respond(writeStringField(1, 'detach-cascade'));
        return;
      }
      if (method === 'SendUserCascadeMessage') {
        state.sendCalls += 1;
        respond(Buffer.alloc(0));
        return;
      }
      if (method === 'GetCascadeTrajectorySteps') {
        state.stepsCalls += 1;
        const offset = readStepOffset(payload);
        state.stepsOffsets.push(offset);
        if (state.failNextSteps > 0) {
          state.failNextSteps -= 1;
          stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
          stream.end(endOfStreamError('cascade not found'));
          return;
        }
        const delay = state.grown && state.firstResumeRead ? state.resumeDelayMs : 0;
        state.firstResumeRead = false;
        const bodyFor = () => {
          if (state.stepsFor) return state.stepsFor(offset);
          const text = state.grown ? (thinkingOnly ? '' : FULL_TEXT) : initialText;
          const step = plannerStep(text, {
            status: state.grown ? 3 : 1,
            thinking: thinkingOnly ? (state.grown ? `${PREFIX}${GROWTH}` : PREFIX) : '',
            toolCall: state.grown ? null : toolCall,
          });
          return rawStepsResponse(offset === 0 ? [step] : []);
        };
        if (delay > 0) {
          setTimeout(() => respond(bodyFor()), delay);
        } else {
          respond(bodyFor());
        }
        return;
      }
      if (method === 'GetCascadeTrajectory') {
        state.statusCalls += 1;
        respond(writeVarintField(2, state.status === 'idle' ? 1 : 2));
        return;
      }
      if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
        state.metadataCalls += 1;
        const offset = readStepOffset(payload);
        state.metadataOffsets.push(offset);
        // Offset 0 reports THREE records (the whole cascade history); offset 7
        // reports ONE (the current turn only). A resume that forgets the
        // snapshot offset over-bills by the difference.
        respond(metadataResponse(offset === 0
          ? [metadataEntry(100, 10), metadataEntry(100, 10), metadataEntry(100, 10)]
          : [metadataEntry(100, 10)]));
        return;
      }
      respond(Buffer.alloc(0));
    });
  };
  return { state, handler };
}

async function withFakeLanguageServer(handler, fn) {
  const server = http2.createServer();
  const sessions = new Set();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => { terminateRpcWithStatus(stream); handler(stream, headers); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    for (const session of sessions) {
      try { session.close(); } catch {}
      try { session.destroy(); } catch {}
    }
    await new Promise(resolve => server.close(resolve));
  }
}

// ── response doubles ────────────────────────────────────────
/**
 * A response with Node's destroyed-peer facts: `close` fires, writableEnded
 * stays false, writes after close are accepted silently. `closeAfterWrites`
 * fires the close AFTER the Nth write is recorded.
 */
function makeResponse({ closeAfterWrites = 0, backpressure = false } = {}) {
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
      if (backpressure && text.includes('"content":"')) return false;
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
  return { res, writes, state };
}

// ── handler context + accounts ──────────────────────────────
function seedAccount(label) {
  const a = auth.addAccountByKey(`devin-session-token$xk-detach-${label}-${Math.random().toString(36).slice(2)}`, label);
  const acct = auth.getAccountInternal(a.id);
  acct.tier = 'pro';
  acct.status = 'active';
  return acct;
}

function makeLsFake(port) {
  return {
    port,
    csrfToken: 'csrf',
    generation: 1,
    activeRequests: 0,
    maxActive: 0,
    beginCalls: 0,
    endCalls: 0,
    acquireCalls: 0,
  };
}

function handlerContext(port, acct, lsFake, overrides = {}) {
  return {
    callerKey: 'session:detach-lazy-resume',
    waitForAccount: (tried, _signal, _maxWait, modelKey) => (acct
      ? { id: acct.id, email: acct.email, apiKey: acct.apiKey, proxy: null }
      : auth.getApiKey(tried, modelKey)),
    ensureLs: async () => {},
    getLsFor: () => ({ port, csrfToken: 'csrf', generation: lsFake ? lsFake.generation : 1 }),
    getLsEntryByPort: (p) => (lsFake && p === port ? lsFake : null),
    beginLsUse: (p) => {
      if (!lsFake || p !== port) return null;
      lsFake.beginCalls += 1;
      lsFake.activeRequests += 1;
      lsFake.maxActive = Math.max(lsFake.maxActive, lsFake.activeRequests);
      return { entry: lsFake, key: 'default', port, generation: lsFake.generation };
    },
    endLsUse: (lease) => {
      if (!lsFake || lease?.entry !== lsFake) return;
      lsFake.endCalls += 1;
      lsFake.activeRequests = Math.max(0, lsFake.activeRequests - 1);
    },
    acquireLsUse: (p) => {
      if (!lsFake || p !== port) return null;
      lsFake.acquireCalls += 1;
      if (lsFake.activeRequests > 0) throw new Error('resume acquired a second LS lease');
      lsFake.activeRequests += 1;
      lsFake.maxActive = Math.max(lsFake.maxActive, lsFake.activeRequests);
      return lsFake;
    },
    WindsurfClient,
    ...overrides,
  };
}

function bodyFor(marker) {
  return {
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: `detach test ${marker}` }],
    stream: true,
  };
}

const createdIds = [];

before(async () => {
  ({ WindsurfClient } = await import('../src/client.js'));
  ({ handleChatCompletions } = await import('../src/handlers/chat.js'));
  ({ resolveModel } = await import('../src/models.js'));
  auth = await import('../src/auth.js');
  cache = await import('../src/cache.js');
  pool = await import('../src/conversation-pool.js');
  registry = await import('../src/detached-registry.js');
  sse = await import('../src/sse-registry.js');
});

beforeEach(() => {
  cache.cacheClear();
  pool.poolClear();
  registry.detachedRegistry.reset();
});

after(() => {
  registry.detachedRegistry.reset();
  while (createdIds.length) {
    try { auth.removeAccount(createdIds.pop()); } catch {}
  }
  cache.cacheClear();
  pool.poolClear();
});

// ── drivers ─────────────────────────────────────────────────
async function startStream(body, ctx) {
  const result = await handleChatCompletions(body, ctx);
  assert.equal(result.status, 200, `expected a stream, got ${JSON.stringify(result.body || result)}`);
  assert.equal(result.stream, true);
  return result;
}

async function runToCompletion(body, ctx, responseOpts) {
  const result = await startStream(body, ctx);
  const { res, writes, state } = makeResponse(responseOpts);
  await result.handler(res);
  return { res, writes, state };
}

function detachKeyOf(body, callerKey = 'session:detach-lazy-resume') {
  return registry.detachedKey(body, callerKey, {
    scopeTrusted: true,
    route: 'chat',
    modelKey: resolveModel(body.model),
    toolPreambleTier: null,
    emulateTools: false,
    native: null,
    stop: [],
    displayModel: body.model,
  });
}

function contentOf(state) {
  return state.body
    .split('\n\n')
    .filter(frame => frame.startsWith('data: '))
    .map(frame => {
      try { return JSON.parse(frame.slice(6)); } catch { return null; }
    })
    .filter(Boolean)
    .map(data => data.choices?.[0]?.delta?.content || '')
    .join('');
}

function spendOf(acct) {
  return auth.getAccountPublic(acct.id)?.totalSpend?.totalTokens ?? 0;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  return false;
}


// ── soak scenarios ──────────────────────────────────────────
function snap() { return registry.detachedRegistry.stats(); }

// Opt-in: SOAK-2 waits the real 120 s TTL, so the whole file is ~2 min and the
// shard runner cancels it at 90 s. The unit suites pin the same behaviour with
// fake timers; run this one deliberately:
//   DETACH_SOAK=1 node --import ./test/setup-env.mjs --test test/detach-soak.test.js
const SOAK_ENABLED = process.env.DETACH_SOAK === '1';

describe('Detach P1 soak', { skip: SOAK_ENABLED ? false : 'set DETACH_SOAK=1 (real 120 s TTL)' }, () => {
  it('SOAK-1 ten detach/resume cycles: claim, replay, lease and bill stay exact', async () => {
    const acct = seedAccount('soak1');
    createdIds.push(acct.id);
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      for (let i = 0; i < 10; i++) {
        state.grown = false;
        state.status = 'active';
        state.firstResumeRead = true;
        const body = bodyFor(`soak1-${i}`);
        const ctx = handlerContext(port, acct, lsFake);
        const s0 = snap();
        const starts0 = state.startCalls;
        const sends0 = state.sendCalls;
        const spend0 = spendOf(acct);

        await runToCompletion(body, ctx, { closeAfterWrites: 2 });
        assert.equal(snap().admit - s0.admit, 1, `cycle ${i}: admit`);
        assert.equal(lsFake.activeRequests, 0, `cycle ${i}: detach pins no lease`);

        state.status = 'idle';
        state.grown = true;
        const { state: resState } = await runToCompletion(body, ctx, {});

        assert.equal(snap().serve - s0.serve, 1, `cycle ${i}: served`);
        assert.equal(snap().entries, 0, `cycle ${i}: entry deleted`);
        assert.equal(snap().bytes, 0, `cycle ${i}: bytes released`);
        assert.equal(state.startCalls - starts0, 1, `cycle ${i}: resume did not StartCascade`);
        assert.equal(state.sendCalls - sends0, 1, `cycle ${i}: resume did not SendUserCascadeMessage`);
        assert.equal(spendOf(acct) - spend0, 330, `cycle ${i}: owner billed once (3-record metadata at offset 0)`);
        assert.equal(resState.body.split(PREFIX).length - 1, 1, `cycle ${i}: prefix once`);
        assert.equal(resState.body.split(GROWTH).length - 1, 1, `cycle ${i}: growth once`);
        assert.equal(lsFake.activeRequests, 0, `cycle ${i}: lease released`);
        assert.equal(lsFake.maxActive, 1, `cycle ${i}: exactly one lease`);
      }
    });
  });

  it('SOAK-2 the real 120 s timer evicts and the retry goes upstream', async () => {
    const acct = seedAccount('soak2');
    createdIds.push(acct.id);
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const body = bodyFor('soak2');
      const ctx = handlerContext(port, acct, lsFake);
      await runToCompletion(body, ctx, { closeAfterWrites: 2 });
      const key = detachKeyOf(body);
      const entry = registry.detachedRegistry.lookup(key, ctx.callerKey);
      assert.ok(entry, 'precondition: admitted');
      const ttl0 = snap().evict.ttl;
      const t0 = Date.now();
      await new Promise(resolve => setTimeout(resolve, 121_000));
      const waited = Date.now() - t0;
      assert.ok(waited >= 120_000, `waited ${waited} ms`);
      assert.equal(snap().entries, 0, 'the unref timer evicted the entry');
      assert.equal(snap().evict.ttl - ttl0, 1, 'evict{ttl} counted once');
      assert.equal(lsFake.activeRequests, 0, 'no lease pinned by the entry');

      const starts0 = state.startCalls;
      state.status = 'idle';
      state.grown = true;
      await runToCompletion(body, ctx, {});
      assert.equal(state.startCalls - starts0, 1, 'the expired retry reaches upstream');
      assert.equal(snap().serve, 0, 'nothing was resumed');
    });
  });

  it('SOAK-3a per-caller cap evicts the oldest running entry; the evicted retry goes upstream', async () => {
    const acct = seedAccount('soak3a');
    createdIds.push(acct.id);
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const ctx = handlerContext(port, acct, lsFake);
      registry.detachedRegistry.maxPerCaller = 1;
      try {
        state.grown = false;
        state.status = 'active';
        state.firstResumeRead = true;
        const bodyA = bodyFor('soak3a-a');
        const bodyB = bodyFor('soak3a-b');
        await runToCompletion(bodyA, ctx, { closeAfterWrites: 2 });
        await runToCompletion(bodyB, ctx, { closeAfterWrites: 2 });
        assert.equal(snap().admit, 2);
        assert.equal(snap().evict.capacity, 1);
        assert.equal(snap().entries, 1);
        assert.equal(registry.detachedRegistry.lookup(detachKeyOf(bodyA), ctx.callerKey), null);

        state.status = 'idle';
        state.grown = true;
        const starts0 = state.startCalls;
        await runToCompletion(bodyA, ctx, {});
        assert.equal(state.startCalls - starts0, 1, 'the evicted retry goes upstream');
        state.firstResumeRead = true;
        await runToCompletion(bodyB, ctx, {});
        assert.equal(snap().serve, 1, 'the surviving entry still resumes');
        assert.equal(snap().entries, 0);
        assert.equal(lsFake.activeRequests, 0);
      } finally {
        registry.detachedRegistry.maxPerCaller = 2;
      }
    });
  });

  it('SOAK-3b entry cap evicts only running entries; a claimed entry is never dropped', async () => {
    const acct = seedAccount('soak3b');
    createdIds.push(acct.id);
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const ctx = handlerContext(port, acct, lsFake);
      registry.detachedRegistry.maxEntries = 1;
      try {
        state.grown = false;
        state.status = 'active';
        state.firstResumeRead = true;
        await runToCompletion(bodyFor('soak3b-a'), ctx, { closeAfterWrites: 2 });
        await runToCompletion(bodyFor('soak3b-b'), ctx, { closeAfterWrites: 2 });
        assert.equal(snap().entries, 1);
        assert.equal(snap().evict.capacity, 1);
      } finally {
        registry.detachedRegistry.maxEntries = 8;
      }
      const reg = new registry.DetachedRegistry({ maxEntries: 1, timers: false });
      const snapOk = {
        version: 2, stepOffset: 1, pollFloor: 0, yieldedByStep: [], thinkingByStep: [],
        consumedThrough: 1, generatorOffset: 0, sawActive: false, usageByStep: [], chunks: [],
      };
      const pin = { deadline: Date.now() + 60_000 };
      assert.ok(reg.admit({ key: 'claimed', callerKey: 'session:a', snapshot: snapOk, pin }).token);
      assert.ok(reg.claim('claimed', 'session:a').entry);
      assert.equal(
        reg.admit({ key: 'next', callerKey: 'session:b', snapshot: snapOk, pin }).refused,
        'over_entries',
        'a claimed entry cannot be evicted to make room',
      );
      assert.ok(reg.lookup('claimed', 'session:a'), 'the claimed entry survives');
    });
  });

  it('SOAK-3c byte cap refuses without truncation; the turn still falls back upstream', async () => {
    const acct = seedAccount('soak3c');
    createdIds.push(acct.id);
    const big = cascadeUpstream({ initialText: 'X'.repeat(2000) });
    await withFakeLanguageServer(big.handler, async (port) => {
      const lsFake = makeLsFake(port);
      const ctx = handlerContext(port, acct, lsFake);
      registry.detachedRegistry.maxEntryBytes = 2048;
      try {
        const bytes0 = snap().refuse.over_bytes;
        await runToCompletion(bodyFor('soak3c'), ctx, { closeAfterWrites: 2 });
        assert.equal(snap().refuse.over_bytes - bytes0, 1, 'over_bytes refusal');
        assert.equal(snap().entries, 0, 'no truncated entry');
        assert.equal(lsFake.activeRequests, 0);
        big.state.status = 'idle';
        big.state.grown = true;
        const starts0 = big.state.startCalls;
        await runToCompletion(bodyFor('soak3c'), ctx, {});
        assert.equal(big.state.startCalls - starts0, 1, 'the refused retry reaches upstream');
      } finally {
        registry.detachedRegistry.maxEntryBytes = 4 * 1024 * 1024;
      }
    });
  });

  it('SOAK-4 abort during prefix replay re-detaches three times without extending TTL', async () => {
    const acct = seedAccount('soak4');
    createdIds.push(acct.id);
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      for (let i = 0; i < 3; i++) {
        state.grown = false;
        state.status = 'active';
        state.firstResumeRead = true;
        const body = bodyFor(`soak4-${i}`);
        const ctx = handlerContext(port, acct, lsFake);
        await runToCompletion(body, ctx, { closeAfterWrites: 2 });
        const key = detachKeyOf(body);
        const originalExpiry = registry.detachedRegistry.lookup(key, ctx.callerKey).expiresAt;
        state.status = 'idle';
        state.grown = true;
        const s0 = snap();
        const spend0 = spendOf(acct);
        await runToCompletion(body, ctx, { closeAfterWrites: 3 });
        assert.equal(snap().re_detach - s0.re_detach, 1, `cycle ${i}: re-detach`);
        assert.equal(snap().serve - s0.serve, 0, `cycle ${i}: not served`);
        const re = registry.detachedRegistry.lookup(key, ctx.callerKey);
        assert.ok(re, `cycle ${i}: entry is running again`);
        assert.equal(re.expiresAt, originalExpiry, `cycle ${i}: TTL unchanged`);
        assert.equal(
          re.snapshot.chunks.map(chunk => chunk.text || '').join(''),
          FULL_TEXT,
          `cycle ${i}: snapshot has the full answer`,
        );
        assert.equal(spendOf(acct) - spend0, 0, `cycle ${i}: the aborted replay billed nothing`);
        state.firstResumeRead = true;
        const { state: finalState } = await runToCompletion(body, ctx, {});
        assert.equal(snap().serve - s0.serve, 1, `cycle ${i}: the final retry is served`);
        assert.equal(snap().entries, 0, `cycle ${i}: entry deleted`);
        assert.equal(finalState.body.split(PREFIX).length - 1, 1, `cycle ${i}: prefix once`);
        assert.equal(finalState.body.split(GROWTH).length - 1, 1, `cycle ${i}: growth once`);
        assert.equal(spendOf(acct) - spend0, 330, `cycle ${i}: billed once`);
        assert.equal(lsFake.activeRequests, 0, `cycle ${i}: lease released`);
      }
    });
  });

  it('SOAK-5 three claim races: one serve, one busy upstream, one detached bill', async () => {
    const acct = seedAccount('soak5');
    createdIds.push(acct.id);
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      for (let i = 0; i < 3; i++) {
        state.grown = false;
        state.status = 'active';
        state.firstResumeRead = true;
        const body = bodyFor(`soak5-${i}`);
        const ctx = handlerContext(port, acct, lsFake);
        await runToCompletion(body, ctx, { closeAfterWrites: 2 });
        state.status = 'idle';
        state.grown = true;
        state.resumeDelayMs = 60;
        const s0 = snap();
        const starts0 = state.startCalls;
        const first = await startStream(body, ctx);
        const firstRes = makeResponse({});
        const firstRun = first.handler(firstRes.res);
        await new Promise(resolve => setTimeout(resolve, 15));
        const second = await startStream(body, ctx);
        const secondRes = makeResponse({});
        await second.handler(secondRes.res);
        await firstRun;
        assert.equal(snap().claim.ok - s0.claim.ok, 1, `cycle ${i}: one claim`);
        assert.equal(snap().claim.busy - s0.claim.busy, 1, `cycle ${i}: one busy`);
        assert.equal(snap().serve - s0.serve, 1, `cycle ${i}: one serve`);
        assert.equal(snap().billed_detached - s0.billed_detached, 1, `cycle ${i}: one detached bill`);
        assert.equal(state.startCalls - starts0, 1, `cycle ${i}: the busy retry starts upstream`);
        assert.ok(contentOf(firstRes.state).includes(GROWTH), `cycle ${i}: the resumed answer grew`);
        assert.equal(contentOf(secondRes.state), FULL_TEXT, `cycle ${i}: the busy retry answers from upstream`);
        assert.equal(lsFake.activeRequests, 0, `cycle ${i}: leases released`);
      }
    });
  });

  it('SOAK-6 a seeded multi-turn resume bills one record on the owner, not the retry account', async () => {
    const owner = seedAccount('soak6-owner');
    const other = seedAccount('soak6-other');
    createdIds.push(owner.id, other.id);
    const { state, handler } = cascadeUpstream();
    state.stepsFor = (offset) => {
      if (offset !== 7) return rawStepsResponse([]);
      return rawStepsResponse([
        plannerStep(state.grown ? FULL_TEXT : PREFIX, { status: state.grown ? 3 : 1 }),
      ]);
    };
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const body = {
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'user', content: 'first turn' },
          { role: 'assistant', content: 'first answer' },
          { role: 'user', content: 'detach soak t6' },
        ],
        stream: true,
      };
      const ownerCtx = handlerContext(port, owner, lsFake);
      const modelKey = resolveModel(body.model);
      const fpBefore = pool.fingerprintBefore(body.messages, modelKey, ownerCtx.callerKey, {
        tools: [], toolChoice: null, toolPreamble: '', preambleTier: null,
        emulateTools: false, route: 'chat',
      });
      pool.checkin(fpBefore, {
        cascadeId: 'seeded-detach-soak6',
        sessionId: 'seeded-session',
        lsPort: port,
        lsGeneration: 1,
        apiKey: owner.apiKey,
        modelKey,
        stepOffset: 7,
        generatorOffset: 7,
      }, ownerCtx.callerKey, 0);

      await runToCompletion(body, ownerCtx, { closeAfterWrites: 2 });
      assert.equal(state.startCalls, 0, 'precondition: the original resumed the seeded cascade');
      assert.equal(snap().admit, 1);
      const entry = registry.detachedRegistry.lookup(detachKeyOf(body), ownerCtx.callerKey);
      assert.equal(entry.snapshot.generatorOffset, 7);
      assert.equal(entry.snapshot.stepOffset, 8);

      state.status = 'idle';
      state.grown = true;
      state.metadataOffsets.length = 0;
      const ownerBefore = spendOf(owner);
      const otherBefore = spendOf(other);
      const retryCtx = handlerContext(port, other, lsFake);
      await runToCompletion(body, retryCtx, {});
      assert.deepEqual(state.metadataOffsets, [7], 'the metadata RPC starts at the snapshot offset');
      assert.equal(spendOf(owner) - ownerBefore, 110, 'the owner is billed exactly one record');
      assert.equal(spendOf(other) - otherBefore, 0, 'the retry account is not billed');
      assert.equal(snap().billed_detached, 1);
      assert.equal(snap().entries, 0);
    });
  });

  it('SOAK-7 account removal and drain evict entries; the retries reach upstream', async () => {
    const owner = seedAccount('soak7-owner');
    const other = seedAccount('soak7-other');
    createdIds.push(owner.id, other.id);
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const lsFake = makeLsFake(port);
      const body = bodyFor('soak7');
      await runToCompletion(body, handlerContext(port, owner, lsFake), { closeAfterWrites: 2 });
      assert.equal(snap().admit, 1);
      auth.removeAccount(owner.id);
      assert.ok(await waitFor(() => snap().entries === 0), 'account removal evicts the entry');
      assert.equal(snap().evict.account_removed, 1);
      assert.equal(lsFake.activeRequests, 0);
      state.status = 'idle';
      state.grown = true;
      const starts0 = state.startCalls;
      await runToCompletion(body, handlerContext(port, other, lsFake), {});
      assert.equal(state.startCalls - starts0, 1, 'the removed-owner retry goes upstream');

      const body2 = bodyFor('soak7-drain');
      state.grown = false;
      state.status = 'active';
      state.firstResumeRead = true;
      await runToCompletion(body2, handlerContext(port, other, lsFake), { closeAfterWrites: 2 });
      assert.equal(snap().admit, 2);
      registry.detachedRegistry.beginDrain();
      assert.equal(snap().entries, 0);
      assert.equal(snap().draining, true);
      assert.equal(lsFake.activeRequests, 0);
      const starts1 = state.startCalls;
      state.status = 'idle';
      state.grown = true;
      await runToCompletion(body2, handlerContext(port, other, lsFake), {});
      assert.equal(state.startCalls - starts1, 1, 'the drained retry goes upstream');
      assert.equal(snap().bytes, 0);
      registry.detachedRegistry.reset();
      assert.equal(snap().draining, false);
    });
  });
});
