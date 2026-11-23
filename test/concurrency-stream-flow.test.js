// ConcurrencyFlow — the hermetic concurrency acceptance suite (R1–R16).
//
// Spec: evidence/final/TEST-PLAN.md §3–§4. This file implements the required
// rows in one hermetic process: controlled writables own the real `write()`
// verdict and `drain` event, `__setStreamChatForTest` scripts only the upstream
// transport (the shipped adapter/handler code is under test), the fake LS
// answers real protobuf RPCs over loopback HTTP/2 for the Cascade arms, and
// accounts are the real pool records.
//
// Every required row runs 3 consecutive iterations as nested subtests, with
// full cleanup between iterations. R10/R11 are POSIX-only: on win32 they are
// reported NOT RUN (skipped with an explicit reason), never green.
//
// Run:
//   node --import ./test/setup-env.mjs --test test/concurrency-stream-flow.test.js

// Module-load configuration. `src/client.js` snapshots CASCADE_TIMEOUTS and
// `src/grpc.js` snapshots GRPC_PROTOCOL, so both are set before the dynamic
// imports below. LS_* is module-load configuration for `src/langserver.js`
// (imported by chat.js); R10/R11 read it on POSIX. No other row uses the real
// pool manager, so these values do not affect the injected-LS arms.
process.env.DEVIN_CONNECT = '1';
process.env.STICKY_SESSION_ENABLED = '0';
process.env.DEVIN_CONNECT_SESSION_REUSE = '0';
process.env.RESPONSE_CACHE_ENABLED = '0';
process.env.GRPC_PROTOCOL = 'connect';
process.env.CASCADE_POLL_INTERVAL_MS = '5';
process.env.CASCADE_IDLE_GRACE_MS = '1';
process.env.CASCADE_MAX_WAIT_MS = '3000';
process.env.CASCADE_COLD_STALL_BASE_MS = '3000';
process.env.CASCADE_WARM_STALL_MS = '3000';
process.env.WINDSURFAPI_CASCADE_TURN = '1';
process.env.LS_MAX_INSTANCES = '2';
process.env.LS_POOL_WAIT_MS = '200';
process.env.LS_PREWARM_DEFAULT = '0';
process.env.LS_EVICT_READY_GRACE_MS = '0';
process.env.LS_MEMORY_GUARD = '0';
process.env.LS_IDLE_TTL_MS = '0';
process.env.LS_AUTO_RESTART = '0';

import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import http2 from 'node:http2';
import { randomUUID } from 'node:crypto';

const {
  handleChatCompletions,
  __resetConnectDeps,
  clientRetryAfterSeconds,
} = await import('../src/handlers/chat.js');
const { handleMessages } = await import('../src/handlers/messages.js');
const { handleGemini } = await import('../src/handlers/gemini.js');
const { __setStreamChatForTest } = await import('../src/devin-connect-openai.js');
const { WindsurfClient } = await import('../src/client.js');
const { streamChat, __setRequestImpl } = await import('../src/devin-connect.js');
const { writeStringField } = await import('../src/proto.js');
const { wrapEnvelope, endOfStreamEnvelope, unwrapRequest } = await import('../src/connect.js');
const {
  getField, getAllFields, parseFields, writeMessageField, writeVarintField,
} = await import('../src/proto.js');
const { terminateRpcWithStatus, isConnectContentType } = await import('./helpers/fake-grpc-trailers.mjs');
const { buildNativeToolHistory } = await import('../src/cascade-native-bridge.js');
const auth = await import('../src/auth.js');
const sse = await import('../src/sse-registry.js');
const cache = await import('../src/cache.js');
const pool = await import('../src/conversation-pool.js');
const registry = await import('../src/detached-registry.js');

const MODEL = 'swe-1-6-slow';
const CASCADE_MODEL = 'gemini-2.5-flash';
const ITERATIONS = 3;
const createdAccounts = [];

// ── generic helpers ─────────────────────────────────────────

async function withEnv(overrides, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function seedAccount(label) {
  const a = auth.addAccountByKey(`devin-session-token$conc-${label}-${randomUUID()}`, label);
  createdAccounts.push(a.id);
  const acct = auth.getAccountInternal(a.id);
  acct.tier = 'pro';
  acct.tierManual = true;
  acct.status = 'active';
  return acct;
}

function removeSeeded() {
  while (createdAccounts.length) {
    try { auth.removeAccount(createdAccounts.pop()); } catch { /* already gone */ }
  }
}

function inflightOf(id) {
  return auth.getAccountInternal(id)?._inflight || 0;
}

function totalInflight(ids) {
  return ids.reduce((sum, id) => sum + inflightOf(id), 0);
}

const pump = async (turns = 4) => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function eventually(predicate, { timeoutMs = 2000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withWatchdog(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function markerOf(params) {
  const text = JSON.stringify(params?.messages || '');
  const match = text.match(/R\d+b?-[A-Z]\d+/);
  return match ? match[0] : null;
}

/**
 * A response the test fully owns. `falseAt`/`falseWhen` decide the real
 * `write()` verdict; `autoDrain` models a slow-but-alive reader; `closeOnText`
 * and `closeAfterWrites` model the client vanishing. Every write is recorded
 * with whether it happened after close.
 */
function controlledRes({
  falseAt = 0,
  falseWhen = null,
  autoDrain = false,
  closeOnText = null,
  closeAfterWrites = 0,
} = {}) {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headersSent = false;
  res.writableEnded = false;
  res.closed = false;
  res.writes = [];
  res.falseSignals = 0;
  res.drainListenerPeak = 0;
  const origOn = res.on.bind(res);
  res.on = (event, handler) => {
    const out = origOn(event, handler);
    if (event === 'drain') {
      res.drainListenerPeak = Math.max(res.drainListenerPeak, res.listenerCount('drain'));
    }
    return out;
  };
  const origEmit = res.emit.bind(res);
  res.emit = (event, ...args) => {
    if (event === 'close') res.closed = true;
    return origEmit(event, ...args);
  };
  res.setHeader = () => res;
  res.writeHead = (status) => { res.statusCode = status; return res; };
  res.flushHeaders = () => {};
  res.write = (chunk) => {
    const text = String(chunk);
    res.writes.push({ text, afterClose: res.closed });
    let verdict = true;
    if (falseWhen) verdict = falseWhen(text, res.writes.length) !== true;
    else if (falseAt > 0) verdict = res.writes.length !== falseAt;
    if (!verdict) {
      res.falseSignals += 1;
      if (autoDrain) setImmediate(() => res.emit('drain'));
    }
    if (closeOnText && text.includes(closeOnText) && !res.closed) res.emit('close');
    if (closeAfterWrites > 0 && res.writes.length >= closeAfterWrites && !res.closed) res.emit('close');
    return verdict;
  };
  res.end = (chunk) => {
    if (chunk) res.write(chunk);
    res.writableEnded = true;
    return res;
  };
  return res;
}

const wireText = (res) => res.writes.map((w) => w.text).join('');
const afterCloseWrites = (res) => res.writes.filter((w) => w.afterClose);
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

function sseChunks(res) {
  return wireText(res)
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) return null;
      try { return JSON.parse(line.slice(6)); } catch { return null; }
    })
    .filter(Boolean);
}

function openaiContent(res) {
  return sseChunks(res)
    .flatMap((c) => c.choices || [])
    .map((c) => c.delta?.content || '')
    .join('');
}

function openaiTerminals(res) {
  return sseChunks(res)
    .flatMap((c) => c.choices || [])
    .filter((c) => c.finish_reason != null);
}

function assertOpenAISuccess(res, expectedContent, label) {
  const body = wireText(res);
  assert.equal(countOf(body, 'data: [DONE]'), 1, `${label}: exactly one [DONE]`);
  assert.ok(body.endsWith('data: [DONE]\n\n'), `${label}: [DONE] is last`);
  assert.equal(openaiContent(res), expectedContent, `${label}: content exactly once and in order`);
  assert.equal(openaiTerminals(res).length, 1, `${label}: exactly one terminal frame`);
  assert.equal(openaiTerminals(res)[0].finish_reason, 'stop', `${label}: terminal is a clean stop`);
}

function anthropicEvents(res) {
  return wireText(res)
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const event = (lines.find((l) => l.startsWith('event: ')) || '').slice(7);
      const dataLine = lines.find((l) => l.startsWith('data: '));
      if (!event || !dataLine) return null;
      try { return { event, data: JSON.parse(dataLine.slice(6)) }; } catch { return null; }
    })
    .filter(Boolean);
}

function anthropicText(res) {
  return anthropicEvents(res)
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => e.data.delta?.text || '')
    .join('');
}

function assertMessagesSuccess(res, expectedContent, label) {
  const events = anthropicEvents(res);
  assert.equal(anthropicText(res), expectedContent, `${label}: deltas exactly once and in order`);
  assert.equal(events.filter((e) => e.event === 'message_stop').length, 1, `${label}: one message_stop`);
  assert.equal(events.at(-1)?.event, 'message_stop', `${label}: message_stop is last`);
}

function geminiFrames(res) {
  return JSON.parse(wireText(res));
}

function geminiText(res) {
  return geminiFrames(res)
    .flatMap((f) => f.candidates || [])
    .flatMap((c) => c.content?.parts || [])
    .map((p) => p.text || '')
    .join('');
}

function assertGeminiSuccess(res, expectedContent, label) {
  const frames = geminiFrames(res);
  assert.equal(geminiText(res), expectedContent, `${label}: deltas exactly once and in order`);
  assert.equal(frames.filter((f) => f.candidates?.[0]?.finishReason).length, 1, `${label}: one terminal`);
  assert.equal(frames.at(-1)?.candidates?.[0]?.finishReason, 'STOP', `${label}: STOP is last`);
}

/**
 * Script the Connect upstream transport. Only the transport is faked; the
 * adapter, handler, writer and translators are shipped code.
 */
function installConnectUpstream({
  gate = null,
  gateAfterA = null,
  gateOnlyMarked = false,
  hangFor = null,
  onStart = null,
  onPull = null,
  onAbort = null,
} = {}) {
  __setStreamChatForTest(async function* (params) {
    const base = markerOf(params);
    const gated = gate && (!gateOnlyMarked || /-[A-Z]\d+$/.test(base || ''));
    onStart?.(base, params);
    if (onAbort && params?.signal) {
      params.signal.addEventListener('abort', () => onAbort(base, params), { once: true });
    }
    const abortRace = (promise) => Promise.race([
      promise,
      new Promise((_, reject) => {
        if (!params?.signal) return;
        if (params.signal.aborted) {
          reject(Object.assign(new Error('client gone'), { name: 'AbortError' }));
          return;
        }
        params.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('client gone'), { name: 'AbortError' }));
        }, { once: true });
      }),
    ]);
    if (hangFor?.(base)) {
      await abortRace(new Promise(() => {}));
      return;
    }
    if (gated) await abortRace(gate);
    yield { type: 'content', text: `${base}-A` };
    onPull?.('A', base);
    if (gateAfterA) await abortRace(gateAfterA);
    yield { type: 'content', text: `${base}-B` };
    onPull?.('B', base);
    yield { type: 'finish', reason: 'stop' };
  });
}

const connectBody = (base) => ({
  model: MODEL,
  stream: true,
  messages: [{ role: 'user', content: `concurrency ${base}` }],
});

const messagesBody = (base) => ({
  model: MODEL,
  stream: true,
  messages: [{ role: 'user', content: `concurrency ${base}` }],
});

const geminiBody = (base) => ({
  contents: [{ role: 'user', parts: [{ text: `concurrency ${base}` }] }],
});

function baselineCounters() {
  return {
    sse: sse.activeSseCount(),
    cacheStores: cache.cacheStats().stores,
  };
}

async function assertCleanBaseline(before, label) {
  assert.equal(sse.activeSseCount(), before.sse, `${label}: SSE registrations return to baseline`);
  assert.equal(cache.cacheStats().stores, before.cacheStores, `${label}: no cache store from a non-success turn`);
}

beforeEach(() => {
  __resetConnectDeps();
  cache.cacheClear();
  pool.poolClear();
  registry.detachedRegistry.reset();
});

after(() => {
  __setStreamChatForTest(null);
  __setRequestImpl(null);
  removeSeeded();
  cache.cacheClear();
  pool.poolClear();
  registry.detachedRegistry.reset();
});

// ── Cascade fakes (injected client / real poll loop) ────────

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

function plannerStep(text, status = 3) {
  const planner = writeStringField(1, text);
  return Buffer.concat([
    writeVarintField(1, 15),
    writeVarintField(4, status),
    writeMessageField(20, planner),
  ]);
}

function rawStepsResponse(steps) {
  return Buffer.concat(steps.map((step) => writeMessageField(1, step)));
}

/**
 * Scripted Cascade LS: first steps read carries `${marker}-A`; every later read
 * carries `${marker}-A${marker}-B`, so the poll loop's final sweep emits the B
 * top-up exactly once. Status is IDLE so the turn terminates normally.
 */
function makeCascadeLs({ marker, status = 1 }) {
  const state = {
    marker,
    startCalls: 0,
    sendCalls: 0,
    stepsCalls: 0,
    statusCalls: 0,
    metadataCalls: 0,
    stepsServed: 0,
  };
  const handler = (stream, headers) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      const method = String(headers[':path'] || '').split('/').pop();
      const contentType = headers['content-type'] || 'application/grpc';
      const respond = (body) => {
        stream.respond({ ':status': 200, 'content-type': contentType });
        stream.end(responseBody(body, headers));
      };
      if (method === 'StartCascade') {
        state.startCalls += 1;
        respond(writeStringField(1, `cascade-${marker}`));
        return;
      }
      if (method === 'SendUserCascadeMessage') {
        state.sendCalls += 1;
        respond(Buffer.alloc(0));
        return;
      }
      if (method === 'GetCascadeTrajectorySteps') {
        state.stepsCalls += 1;
        const first = state.stepsServed === 0;
        state.stepsServed += 1;
        const text = first ? `${marker}-A` : `${marker}-A${marker}-B`;
        respond(rawStepsResponse([plannerStep(text)]));
        return;
      }
      if (method === 'GetCascadeTrajectory') {
        state.statusCalls += 1;
        respond(writeVarintField(2, status));
        return;
      }
      if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
        state.metadataCalls += 1;
        respond(Buffer.alloc(0));
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    for (const session of sessions) {
      try { session.close(); } catch {}
      try { session.destroy(); } catch {}
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

/** N independent fake LS servers, each with its own state. */
async function withFakeLanguageServers(factories, fn) {
  const servers = [];
  const ports = [];
  for (const factory of factories) {
    const fixture = factory();
    const server = http2.createServer();
    const sessions = new Set();
    server.on('session', (session) => {
      sessions.add(session);
      session.on('close', () => sessions.delete(session));
    });
    server.on('stream', (stream, headers) => { terminateRpcWithStatus(stream); fixture.handler(stream, headers); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push({ server, sessions });
    ports.push(server.address().port);
    fixture.port = server.address().port;
  }
  try {
    return await fn(ports, factories.map((f) => f()));
  } finally {
    for (const { server, sessions } of servers) {
      for (const session of sessions) {
        try { session.close(); } catch {}
        try { session.destroy(); } catch {}
      }
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

/**
 * Injected Cascade client whose `cascadeChat` awaits its callback exactly like
 * the real poll loop. Used where the row is about the handler/writer, not the
 * transport (R4/R5/R6/R14 Cascade arms); R8 uses the real client + fake LS.
 */
function cascadeContextFor({ a, b } = {}) {
  const progress = { chunksProduced: 0, completed: 0, upstreamCalls: 0 };
  class FakeClient {
    async cascadeChat(_messages, _modelEnum, _modelUid, opts = {}) {
      progress.upstreamCalls += 1;
      if (opts.onChunk) {
        progress.chunksProduced += 1;
        await opts.onChunk({ text: a });
        if (b !== undefined) {
          progress.chunksProduced += 1;
          await opts.onChunk({ text: b });
        }
        progress.completed += 1;
        return { text: '', toolCalls: [], usage: { inputTokens: 11, outputTokens: 5 } };
      }
      return Object.assign([{ text: a || '' }], { toolCalls: [], usage: { inputTokens: 11, outputTokens: 5 } });
    }
  }
  const ctx = {
    waitForAccount(tried, _signal, _maxWait, modelKey) { return auth.getApiKey(tried, modelKey); },
    ensureLs: async () => {},
    getLsFor: () => ({ port: 17777, csrfToken: 'csrf', generation: 1 }),
    WindsurfClient: FakeClient,
  };
  Object.defineProperty(ctx, 'progress', { get: () => progress });
  return ctx;
}

function cascadeHandlerContext(port, account) {
  return {
    waitForAccount: (tried, _signal, _maxWait, modelKey) => (account
      ? { id: account.id, email: account.email, apiKey: account.apiKey, proxy: null }
      : auth.getApiKey(tried, modelKey)),
    ensureLs: async () => {},
    getLsFor: () => ({ port, csrfToken: 'csrf', generation: 1 }),
    WindsurfClient,
  };
}

// ── R2 — one slow reader among N ────────────────────────────
describe('R2 — one slow reader among N', () => {
  it('3 iterations: Connect N=8; Messages and Gemini N=4', async (t) => {
    for (let iter = 1; iter <= ITERATIONS; iter += 1) {
      await t.test(`iteration ${iter}`, async () => {
        try {
          // Connect: S0 parks at its first content write; S1–S7 auto-drain.
          {
            const accounts = Array.from({ length: 8 }, (_, i) => seedAccount(`R2-connect-${iter}-${i}`));
            const ids = accounts.map((a) => a.id);
            let started = 0;
            installConnectUpstream({ onStart: () => { started += 1; } });
            const results = [];
            for (let i = 0; i < 8; i += 1) {
              results.push(await handleChatCompletions(connectBody(`R2-S${i}`), {
                callerKey: `session:R2:S${i}`,
              }));
            }
            const responses = results.map((_, i) => controlledRes(
              i === 0 ? { falseAt: 2 } : { autoDrain: true },
            ));
            const runs = results.map((r, i) => {
              assert.equal(r.status, 200, `R2 Connect ${i} admitted`);
              return r.handler(responses[i]);
            });
            await eventually(() => started === 8, { label: 'R2 Connect: 8 producers admitted' });
            const survivors = await withWatchdog(
              Promise.allSettled(runs.slice(1)), 2000, 'R2 Connect survivors',
            );
            for (const [i, outcome] of survivors.entries()) {
              assert.equal(outcome.status, 'fulfilled', `R2 Connect survivor ${i + 1}: ${outcome.reason?.message}`);
              assertOpenAISuccess(responses[i + 1], `R2-S${i + 1}-AR2-S${i + 1}-B`, `R2 Connect S${i + 1}`);
            }
            assert.equal(responses[0].falseSignals, 1, 'R2 Connect S0 reported backpressure once');
            assert.equal(responses[0].writes.length, 2, 'R2 Connect S0 stopped at the refused content frame');
            const heldWrites = responses[0].writes.length;
            await pump(8);
            assert.equal(responses[0].writes.length, heldWrites, 'R2 Connect S0 adds no writes while held');
            assert.ok(responses[0].drainListenerPeak <= 1, 'R2 Connect S0 has one drain waiter');
            responses[0].emit('drain');
            await withWatchdog(runs[0], 2000, 'R2 Connect S0 after drain');
            assertOpenAISuccess(responses[0], 'R2-S0-AR2-S0-B', 'R2 Connect S0');
            assert.equal(totalInflight(ids), 0);
            removeSeeded();
          }

          // Messages: S0 false at the existing frame 4; S1–S3 auto-drain.
          {
            const accounts = Array.from({ length: 4 }, (_, i) => seedAccount(`R2-messages-${iter}-${i}`));
            const ids = accounts.map((a) => a.id);
            let started = 0;
            const pulled = new Map();
            installConnectUpstream({
              onStart: (base) => { started += 1; pulled.set(base, []); },
              onPull: (kind, base) => pulled.get(base)?.push(kind),
            });
            const results = [];
            for (let i = 0; i < 4; i += 1) {
              results.push(await handleMessages(messagesBody(`R2-S${i}`), {
                callerKey: `session:R2M:S${i}`,
              }));
            }
            const responses = results.map((_, i) => controlledRes(
              i === 0 ? { falseAt: 4 } : { autoDrain: true },
            ));
            const runs = results.map((r, i) => {
              assert.equal(r.status, 200, `R2 Messages ${i} admitted`);
              return r.handler(responses[i]);
            });
            await eventually(() => started === 4, { label: 'R2 Messages: 4 producers admitted' });
            const survivors = await withWatchdog(
              Promise.allSettled(runs.slice(1)), 2000, 'R2 Messages survivors',
            );
            for (const [i, outcome] of survivors.entries()) {
              assert.equal(outcome.status, 'fulfilled', `R2 Messages survivor ${i + 1}`);
              assertMessagesSuccess(responses[i + 1], `R2-S${i + 1}-AR2-S${i + 1}-B`, `R2 Messages S${i + 1}`);
            }
            assert.equal(responses[0].writes.length, 4, 'R2 Messages S0 stops at frame 4');
            assert.deepEqual(pulled.get('R2-S0'), ['A'], 'R2 Messages S0 pulled only the first delta');
            const heldWrites = responses[0].writes.length;
            await pump(8);
            assert.equal(responses[0].writes.length, heldWrites, 'R2 Messages S0 adds no writes while held');
            assert.ok(responses[0].drainListenerPeak <= 2, 'R2 Messages S0 has one forwarder + one waiter');
            responses[0].emit('drain');
            await withWatchdog(runs[0], 2000, 'R2 Messages S0 after drain');
            assertMessagesSuccess(responses[0], 'R2-S0-AR2-S0-B', 'R2 Messages S0');
            assert.equal(totalInflight(ids), 0);
            removeSeeded();
          }

          // Gemini: S0 false at the existing frame 1; S1–S3 auto-drain.
          {
            const accounts = Array.from({ length: 4 }, (_, i) => seedAccount(`R2-gemini-${iter}-${i}`));
            const ids = accounts.map((a) => a.id);
            let started = 0;
            const pulled = new Map();
            installConnectUpstream({
              onStart: (base) => { started += 1; pulled.set(base, []); },
              onPull: (kind, base) => pulled.get(base)?.push(kind),
            });
            const results = [];
            for (let i = 0; i < 4; i += 1) {
              results.push(await handleGemini(
                MODEL, geminiBody(`R2-S${i}`), { callerKey: `session:R2G:S${i}` },
                { stream: true, alt: null },
              ));
            }
            const responses = results.map((_, i) => controlledRes(
              i === 0 ? { falseAt: 1 } : { autoDrain: true },
            ));
            const runs = results.map((r, i) => {
              assert.equal(r.status, 200, `R2 Gemini ${i} admitted`);
              return r.handler(responses[i]);
            });
            await eventually(() => started === 4, { label: 'R2 Gemini: 4 producers admitted' });
            const survivors = await withWatchdog(
              Promise.allSettled(runs.slice(1)), 2000, 'R2 Gemini survivors',
            );
            for (const [i, outcome] of survivors.entries()) {
              assert.equal(outcome.status, 'fulfilled', `R2 Gemini survivor ${i + 1}`);
              assertGeminiSuccess(responses[i + 1], `R2-S${i + 1}-AR2-S${i + 1}-B`, `R2 Gemini S${i + 1}`);
            }
            assert.equal(responses[0].writes.length, 1, 'R2 Gemini S0 stops at frame 1');
            assert.deepEqual(pulled.get('R2-S0'), ['A'], 'R2 Gemini S0 pulled only the first delta');
            const heldWrites = responses[0].writes.length;
            await pump(8);
            assert.equal(responses[0].writes.length, heldWrites, 'R2 Gemini S0 adds no writes while held');
            assert.ok(responses[0].drainListenerPeak <= 2, 'R2 Gemini S0 has one forwarder + one waiter');
            responses[0].emit('drain');
            await withWatchdog(runs[0], 2000, 'R2 Gemini S0 after drain');
            assertGeminiSuccess(responses[0], 'R2-S0-AR2-S0-B', 'R2 Gemini S0');
            assert.equal(totalInflight(ids), 0);
            removeSeeded();
          }
        } finally {
          removeSeeded();
        }
      });
    }
  });
});

// ── R4 — half-open timeout among N ──────────────────────────
describe('R4 — half-open timeout among N', () => {
  it('3 iterations: Connect N=4 and Cascade N=4', async (t) => {
    for (let iter = 1; iter <= ITERATIONS; iter += 1) {
      await t.test(`iteration ${iter}`, async () => {
        // Connect: S0 never drains, S1–S3 drain normally.
        await withEnv({ WINDSURFAPI_MAX_DRAIN_MS: '25' }, async () => {
          try {
            const accounts = Array.from({ length: 4 }, (_, i) => seedAccount(`R4-connect-${iter}-${i}`));
            const ids = accounts.map((a) => a.id);
            let started = 0;
            installConnectUpstream({ onStart: () => { started += 1; } });
            const results = [];
            for (let i = 0; i < 4; i += 1) {
              results.push(await handleChatCompletions(connectBody(`R4-S${i}`), {
                callerKey: `session:R4:S${i}`,
              }));
            }
            const responses = results.map((_, i) => controlledRes(
              i === 0 ? { falseAt: 2 } : { autoDrain: true },
            ));
            const runs = results.map((r, i) => {
              assert.equal(r.status, 200);
              return r.handler(responses[i]);
            });
            await eventually(() => started === 4, { label: 'R4 Connect: 4 producers admitted' });
            await withWatchdog(runs[0], 2000, 'R4 Connect S0 timeout');
            const errors = sseChunks(responses[0]).filter((c) => c.error);
            assert.equal(errors.length, 1, 'R4 Connect S0: exactly one error frame');
            assert.equal(errors[0].error.code, 'DRAIN_TIMEOUT');
            assert.equal(countOf(wireText(responses[0]), 'data: [DONE]'), 0, 'R4 Connect S0: no DONE');
            assert.equal(inflightOf(accounts[0].id), 0, 'R4 Connect S0: account released');
            const survivors = await withWatchdog(
              Promise.allSettled(runs.slice(1)), 2000, 'R4 Connect survivors',
            );
            for (const [i, outcome] of survivors.entries()) {
              assert.equal(outcome.status, 'fulfilled', `R4 Connect survivor ${i + 1}`);
              assertOpenAISuccess(responses[i + 1], `R4-S${i + 1}-AR4-S${i + 1}-B`, `R4 Connect S${i + 1}`);
            }
            assert.equal(totalInflight(ids), 0);
          } finally {
            removeSeeded();
          }
        });

        // Cascade: S0 never drains, S1–S3 drain normally.
        await withEnv({ WINDSURFAPI_MAX_DRAIN_MS: '40', DEVIN_CONNECT: undefined }, async () => {
          try {
            const accounts = Array.from({ length: 4 }, (_, i) => seedAccount(`R4-cascade-${iter}-${i}`));
            const ids = accounts.map((a) => a.id);
            const contexts = Array.from({ length: 4 }, (_, i) => cascadeContextFor({
              a: `R4-S${i}-A`, b: `R4-S${i}-B`,
            }));
            const results = [];
            for (let i = 0; i < 4; i += 1) {
              results.push(await handleChatCompletions({
                model: CASCADE_MODEL,
                messages: [{ role: 'user', content: `concurrency R4-S${i}` }],
                stream: true,
              }, contexts[i]));
            }
            const responses = results.map((_, i) => controlledRes(
              i === 0 ? { falseAt: 2 } : { autoDrain: true },
            ));
            const runs = results.map((r, i) => {
              assert.equal(r.status, 200);
              return r.handler(responses[i]);
            });
            await withWatchdog(runs[0], 2000, 'R4 Cascade S0 timeout');
            const errors = sseChunks(responses[0]).filter((c) => c.error);
            assert.equal(errors.length, 1, 'R4 Cascade S0: exactly one DRAIN_TIMEOUT');
            assert.equal(errors[0].error.code, 'DRAIN_TIMEOUT');
            assert.equal(countOf(wireText(responses[0]), 'data: [DONE]'), 0, 'R4 Cascade S0: no DONE');
            assert.equal(contexts[0].progress.completed, 0, 'R4 Cascade S0: producer not completed');
            assert.equal(contexts[0].progress.chunksProduced, 1, 'R4 Cascade S0: producer held at first chunk');
            const survivors = await withWatchdog(
              Promise.allSettled(runs.slice(1)), 2000, 'R4 Cascade survivors',
            );
            for (const [i, outcome] of survivors.entries()) {
              assert.equal(outcome.status, 'fulfilled', `R4 Cascade survivor ${i + 1}`);
              assert.equal(openaiContent(responses[i + 1]), `R4-S${i + 1}-AR4-S${i + 1}-B`);
              assert.equal(openaiTerminals(responses[i + 1]).length, 1);
            }
            assert.equal(totalInflight(ids), 0);
          } finally {
            removeSeeded();
          }
        });
      });
    }
  });
});

describe('R1 — N healthy in-flight Connect streams', () => {
  async function runArm({ n, accountCount, label, row = 'R1' }) {
    const accounts = Array.from({ length: accountCount }, (_, i) => seedAccount(`${label}-acct-${i}`));
    const ids = accounts.map((a) => a.id);
    const before = baselineCounters();
    let started = 0;
    let peakActive = 0;
    let active = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    installConnectUpstream({
      gate,
      onStart: () => { started += 1; if (started === n) release(); },
    });

    const results = [];
    for (let i = 0; i < n; i += 1) {
      results.push(await handleChatCompletions(connectBody(`${row}-S${i}`), {
        callerKey: `session:${row}:S${i}`,
      }));
    }
    assert.equal(started, 0, `${label}: no upstream may start before a handler is driven`);
    for (const acct of accounts) {
      assert.ok(inflightOf(acct.id) <= 2,
        `${label}: account ${acct.email} holds ${inflightOf(acct.id)} > cap 2`);
    }
    assert.equal(totalInflight(ids), n, `${label}: ${n} acquisitions must hold ${n} slots`);

    const responses = Array.from({ length: n }, () => controlledRes());
    const runs = results.map((result, i) => {
      assert.equal(result.status, 200, `${label}: stream ${i} must be admitted, got ${JSON.stringify(result.body)}`);
      assert.equal(result.stream, true);
      active += 1;
      peakActive = Math.max(peakActive, active);
      return result.handler(responses[i]).finally(() => { active -= 1; });
    });

    await eventually(() => started === n, { label: `${label}: ${n} upstream producers admitted` });
    assert.equal(peakActive, n, `${label}: peakActive must be ${n}`);

    release();
    const settled = await withWatchdog(
      Promise.allSettled(runs), 2000, `${label}: all handlers after release`,
    );
    for (const [i, outcome] of settled.entries()) {
      assert.equal(outcome.status, 'fulfilled',
        `${label}: stream ${i} rejected: ${outcome.reason?.message || outcome.reason}`);
    }

    for (let i = 0; i < n; i += 1) {
      const base = `${row}-S${i}`;
      assertOpenAISuccess(responses[i], `${base}-A${base}-B`, `${label}: stream ${i}`);
      assert.equal(countOf(wireText(responses[i]), `${base}-A`), 1, `${label}: ${base}-A once`);
      assert.equal(countOf(wireText(responses[i]), `${base}-B`), 1, `${label}: ${base}-B once`);
      for (let j = 0; j < n; j += 1) {
        if (j === i) continue;
        const other = `${row}-S${j}`;
        assert.equal(countOf(wireText(responses[i]), `${other}-A`), 0,
          `${label}: stream ${i} must not contain ${other}`);
        assert.equal(countOf(wireText(responses[i]), `${other}-B`), 0,
          `${label}: stream ${i} must not contain ${other}`);
      }
      assert.equal(responses[i].listenerCount('drain'), 0, `${label}: stream ${i} leaves no drain waiter`);
    }
    assert.equal(totalInflight(ids), 0, `${label}: every account slot released`);
    await assertCleanBaseline(before, label);
  }

  it('3 iterations: N=8 over 4 accounts, then N=16 over 8 accounts', async (t) => {
    for (let iter = 1; iter <= ITERATIONS; iter += 1) {
      await t.test(`iteration ${iter}`, async () => {
        await withEnv({ DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT: '2' }, async () => {
          try {
            await runArm({ n: 8, accountCount: 4, label: `R1a-i${iter}`, row: 'R1' });
            removeSeeded();
            await runArm({ n: 16, accountCount: 8, label: `R1b-i${iter}`, row: 'R1' });
          } finally {
            removeSeeded();
          }
        });
      });
    }
  });
});

// ── R9 — account-pool saturation and recovery with live streams ─
describe('R9 — account-pool saturation and recovery with live streams', () => {
  it('3 iterations: preflight 429 at cap, recovery after release, mid-flight cooling', async (t) => {
    for (let iter = 1; iter <= ITERATIONS; iter += 1) {
      await t.test(`iteration ${iter}`, async () => {
        await withEnv({
          DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT: '1',
          DEVIN_CONNECT_TOKEN: 'env-token-must-not-serve',
        }, async () => {
          const releases = [];
          const streams = [];
          try {
            const acct = seedAccount(`R9-i${iter}`);
            const before = baselineCounters();
            let started = 0;
            let release;
            const gate = new Promise((resolve) => { release = resolve; });
            releases.push(release);
            installConnectUpstream({
              gate,
              onStart: () => { started += 1; },
            });

            const s0 = await handleChatCompletions(connectBody('R9-S0'), {
              callerKey: 'session:R9:S0',
            });
            assert.equal(s0.status, 200);
            const res0 = controlledRes();
            const run0 = s0.handler(res0);
            streams.push({ response: res0, completion: run0 });
            await eventually(() => started === 1, { label: `R9 i${iter}: S0 upstream admitted` });
            assert.equal(inflightOf(acct.id), 1, 'S0 holds the only slot');

            const s1 = await handleChatCompletions(connectBody('R9-S1'), {
              callerKey: 'session:R9:S1',
            });
            const s2 = await handleChatCompletions(connectBody('R9-S2'), {
              callerKey: 'session:R9:S2',
            });
            for (const [label, r] of [['S1', s1], ['S2', s2]]) {
              assert.equal(r.status, 429, `${label} must be fast-rejected at cap`);
              assert.equal(r.body?.error?.type, 'rate_limit_exceeded');
              assert.equal(r.body?.error?.retry_after_ms, 30000);
              assert.equal(r.headers?.['Retry-After'], '30');
            }
            assert.equal(started, 1, 'rejected requests must not reach the upstream or the env token');
            assert.equal(inflightOf(acct.id), 1, 'rejected requests must not consume a slot');

            release();
            await withWatchdog(run0, 2000, `R9 i${iter}: S0 completion`);
            assertOpenAISuccess(res0, 'R9-S0-AR9-S0-B', `R9 i${iter}: S0`);
            assert.equal(inflightOf(acct.id), 0, 'S0 released its slot');

            // Identical retries after release are admitted and complete their own markers.
            const retryResponses = [];
            for (const s of ['S1', 'S2']) {
              const again = await handleChatCompletions(connectBody(`R9-${s}`), {
                callerKey: `session:R9:${s}`,
              });
              assert.equal(again.status, 200, `retry ${s} must be admitted after release`);
              const res = controlledRes();
              retryResponses.push({ s, res });
              const completion = again.handler(res);
              streams.push({ response: res, completion });
              await withWatchdog(completion, 2000, `R9 i${iter}: retry ${s}`);
            }
            for (const { s, res } of retryResponses) {
              assertOpenAISuccess(res, `R9-${s}-AR9-${s}-B`, `R9 i${iter}: retry ${s}`);
            }
            assert.equal(inflightOf(acct.id), 0);

            // Mid-flight cooling: 4 admitted streams over 2 accounts, both cooled after
            // admission. The survivors must finish; no new request may use the env token.
            removeSeeded();
            await withEnv({ DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT: '2' }, async () => {
              const a = seedAccount(`R9-i${iter}-cool-a`);
              const b = seedAccount(`R9-i${iter}-cool-b`);
              let coolStarted = 0;
              let coolRelease;
              let markCoolStarted;
              const allCoolStarted = new Promise((resolve) => { markCoolStarted = resolve; });
              const coolGate = new Promise((resolve) => { coolRelease = resolve; });
              releases.push(coolRelease);
              installConnectUpstream({
                gate: coolGate,
                onStart: () => {
                  coolStarted += 1;
                  if (coolStarted === 4) markCoolStarted();
                },
              });
              const results = [];
              for (let i = 0; i < 4; i += 1) {
                results.push(await handleChatCompletions(connectBody(`R9-C${i}`), {
                  callerKey: `session:R9:C${i}`,
                }));
              }
              const responses = results.map(() => controlledRes());
              const runs = results.map((result, index) => {
                const response = responses[index];
                const completion = result.handler(response);
                streams.push({ response, completion });
                return completion;
              });
              await eventually(() => coolStarted === 4, { label: 'R9 mid-flight: 4 admitted' });
              assert.equal(totalInflight([a.id, b.id]), 4, 'all four streams are live before cooling');
              auth.markRateLimited(a.apiKey, 60_000);
              auth.markRateLimited(b.apiKey, 60_000);
              coolRelease();
              const settled = await withWatchdog(Promise.allSettled(runs), 2000, 'R9 mid-flight survivors');
              for (const [i, outcome] of settled.entries()) {
                assert.equal(outcome.status, 'fulfilled', `cooled survivor ${i}: ${outcome.reason?.message}`);
                assertOpenAISuccess(responses[i],
                  `R9-C${i}-AR9-C${i}-B`, `R9 mid-flight C${i}`);
              }
              assert.equal(coolStarted, 4, 'cooling must not trigger an env-token turn');
              const rejected = await handleChatCompletions(connectBody('R9-C4'), {
                callerKey: 'session:R9:C4',
              });
              assert.equal(rejected.status, 429, 'a new request after cooling must be a typed 429');
              assert.equal(rejected.body?.error?.type, 'rate_limit_exceeded');
              assert.equal(totalInflight([a.id, b.id]), 0);
            });
            await assertCleanBaseline(before, `R9 i${iter}`);
          } finally {
            // An assertion can fail before normal release. Close the owned
            // responses and drain their handlers before removing the accounts.
            try {
              for (const { response } of streams) {
                if (!response.closed && !response.writableEnded) response.emit('close');
              }
              for (const release of releases) release();
              await withWatchdog(Promise.allSettled(streams.map(({ completion }) => completion)),
                2000, `R9 i${iter}: fixture cleanup`);
            } finally {
              removeSeeded();
            }
          }
        });
      });
    }
  });
});

// ── R16 — drought transition with N live streams ────────────
describe('R16 — drought transition with N live streams', () => {
  it('3 iterations: pre-admission 503, 4 held streams across the drought flip', async (t) => {
    for (let iter = 1; iter <= ITERATIONS; iter += 1) {
      await t.test(`iteration ${iter}`, async () => {
        await withEnv({
          DEVIN_CONNECT: '1',
          DROUGHT_RESTRICT_PREMIUM: '1',
          WINDSURFAPI_STRICT_MODEL: '1',
          DEVIN_CONNECT_TOKEN: undefined,
          WINDSURF_API_KEY: undefined,
          DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT: '2',
        }, async () => {
          try {
            const accounts = Array.from({ length: 3 }, (_, i) => {
              const acct = seedAccount(`R16-i${iter}-${i}`);
              acct.credits = { weeklyPercent: 1, dailyPercent: 0 };
              return acct;
            });
            const ids = accounts.map((a) => a.id);
            assert.equal(auth.isDroughtMode(), true, 'precondition: the measured pool is in drought');

            const premium = await handleChatCompletions({
              model: 'claude-opus-4-8-medium',
              messages: [{ role: 'user', content: 'premium during drought' }],
              stream: true,
            }, { callerKey: `session:R16-i${iter}:premium` });
            assert.equal(premium.status, 503);
            assert.equal(premium.body?.error?.type, 'drought_mode');
            const allowed = premium.body?.error?.drought?.allowedModels || [];
            assert.ok(allowed.includes('swe-1-6-slow'), 'allowed list must include the Connect-routable free selector');
            assert.ok(!allowed.includes('gemini-2.5-flash'), 'Cascade-only free model must not be advertised');
            assert.equal(totalInflight(ids), 0, 'a rejected request acquires nothing');

            const garbage = await handleChatCompletions({
              model: 'TOTAL-GARBAGE',
              messages: [{ role: 'user', content: 'typo' }],
              stream: true,
            }, { callerKey: `session:R16-i${iter}:garbage` });
            assert.equal(garbage.status, 400);
            assert.equal(garbage.body?.error?.code, 'model_not_found', 'strict-model 400 stays ahead of drought');

            // The free selector is not drought-blocked: the four held streams below
            // are all `swe-1-6-slow` and are admitted during the drought.

            // Hold 4 admitted free-selector streams.
            let started = 0;
            let release;
            let markAllStarted;
            const allStarted = new Promise((resolve) => { markAllStarted = resolve; });
            const gate = new Promise((resolve) => { release = resolve; });
            installConnectUpstream({
              gate,
              gateOnlyMarked: true,
              onStart: (base) => {
                if (!/^R16-S\d+$/.test(base || '')) return;
                started += 1;
                if (started === 4) markAllStarted();
              },
            });
            const results = [];
            for (let i = 0; i < 4; i += 1) {
              results.push(await handleChatCompletions(connectBody(`R16-S${i}`), {
                callerKey: `session:R16:S${i}`,
              }));
            }
            const responses = results.map(() => controlledRes());
            const runs = results.map((r, i) => {
              assert.equal(r.status, 200, `R16 stream ${i} must be admitted in drought (free selector)`);
              return r.handler(responses[i]);
            });
            await eventually(() => started === 4, { label: 'R16: 4 free-selector streams admitted' });
            // healthy → drought → healthy between admissions; held streams are not rewritten.
            for (const acct of accounts) acct.credits = { weeklyPercent: 80, dailyPercent: 80 };
            assert.equal(auth.isDroughtMode(), false, 'healthy refresh must leave drought');
            const premiumHealthy = await handleChatCompletions({
              model: 'claude-opus-4-8-medium',
              messages: [{ role: 'user', content: 'premium after healthy refresh' }],
              stream: true,
            }, { callerKey: `session:R16-i${iter}:premium2` });
            assert.notEqual(premiumHealthy.status, 503, 'premium admission is restored after a healthy refresh');
            await withWatchdog(
              premiumHealthy.handler(controlledRes()), 2000,
              'R16 premium healthy control completion',
            );

            for (const acct of accounts) acct.credits = { weeklyPercent: 1, dailyPercent: 0 };
            assert.equal(auth.isDroughtMode(), true, 'the pool returns to drought');
            const premiumAgain = await handleChatCompletions({
              model: 'claude-opus-4-8-medium',
              messages: [{ role: 'user', content: 'premium during second drought' }],
              stream: true,
            }, { callerKey: `session:R16-i${iter}:premium3` });
            assert.equal(premiumAgain.status, 503, 'premium is rejected again after the drought flip');
            assert.equal(totalInflight(ids), 4, 'held streams keep their slots across the flips');

            release();
            const settled = await withWatchdog(Promise.allSettled(runs), 2000, 'R16 held streams');
            for (const [i, outcome] of settled.entries()) {
              assert.equal(outcome.status, 'fulfilled', `R16 stream ${i}: ${outcome.reason?.message}`);
              const base = `R16-S${i}`;
              assertOpenAISuccess(responses[i], `${base}-A${base}-B`, `R16 stream ${i}`);
            }
            assert.equal(totalInflight(ids), 0, 'every held stream released its slot');
          } finally {
            removeSeeded();
          }
        });
      });
    }
  });
});

const { resolveModel } = await import('../src/models.js');

// ── detach harness (P1) ─────────────────────────────────────
const DETACH_PREFIX = 'PREFIX-ANSWER-';
const DETACH_GROWTH = 'GROWTH-AFTER-DETACH-';
const DETACH_FULL = `${DETACH_PREFIX}${DETACH_GROWTH}`;

function detachPlannerStep(text, { status = 3 } = {}) {
  return Buffer.concat([
    writeVarintField(1, 15),
    writeVarintField(4, status),
    writeMessageField(20, writeStringField(1, text)),
  ]);
}

function detachStepsResponse(steps) {
  return Buffer.concat(steps.map((step) => writeMessageField(1, step)));
}

function detachMetadataEntry(inputTokens, outputTokens) {
  const usage = Buffer.concat([
    writeVarintField(2, inputTokens),
    writeVarintField(3, outputTokens),
  ]);
  return writeMessageField(1, writeMessageField(4, usage));
}

function detachMetadataResponse(records) {
  return Buffer.concat(records.map((record) => writeMessageField(1, record)));
}

function detachReadOffset(payload) {
  const field = getField(parseFields(payload), 2, 0);
  return field ? Number(field.value) : 0;
}

function endOfStreamError(message, code = 'not_found') {
  const trailer = Buffer.from(JSON.stringify({ error: { code, message } }));
  const frame = Buffer.alloc(5 + trailer.length);
  frame[0] = 0x02;
  frame.writeUInt32BE(trailer.length, 1);
  trailer.copy(frame, 5);
  return frame;
}

function detachUpstream({ initialText = DETACH_PREFIX } = {}) {
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
    stepsFor: null,
  };
  const handler = (stream, headers) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      const method = String(headers[':path'] || '').split('/').pop();
      const contentType = headers['content-type'] || 'application/grpc';
      const payload = unwrapRequest(Buffer.concat(chunks), headers);
      const respond = (body) => {
        stream.respond({ ':status': 200, 'content-type': contentType });
        stream.end(responseBody(body, headers));
      };
      const respondLater = (delay, body) => {
        const timer = setTimeout(() => {
          if (stream.destroyed || stream.closed) return;
          try { respond(body); } catch { /* stream cancelled */ }
        }, delay);
        timer.unref?.();
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
        const offset = detachReadOffset(payload);
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
          const text = state.grown ? DETACH_FULL : initialText;
          const step = detachPlannerStep(text, { status: state.grown ? 3 : 1 });
          return detachStepsResponse(offset === 0 ? [step] : []);
        };
        if (delay > 0) respondLater(delay, bodyFor());
        else respond(bodyFor());
        return;
      }
      if (method === 'GetCascadeTrajectory') {
        state.statusCalls += 1;
        respond(writeVarintField(2, state.status === 'idle' ? 1 : 2));
        return;
      }
      if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
        state.metadataCalls += 1;
        const offset = detachReadOffset(payload);
        state.metadataOffsets.push(offset);
        const body = detachMetadataResponse(offset === 0
          ? [detachMetadataEntry(100, 10), detachMetadataEntry(100, 10), detachMetadataEntry(100, 10)]
          : [detachMetadataEntry(100, 10)]);
        respond(body);
        return;
      }
      respond(Buffer.alloc(0));
    });
  };
  return { state, handler };
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

function detachHandlerContext(port, acct, lsFake, overrides = {}) {
  return {
    callerKey: 'session:detach',
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
      return { kind: 'request', entry: lsFake, port, generation: lsFake.generation };
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
      return { kind: 'request', entry: lsFake, port, generation: lsFake.generation };
    },
    WindsurfClient,
    ...overrides,
  };
}

function detachBody(marker) {
  return {
    model: CASCADE_MODEL,
    messages: [{ role: 'user', content: `detach test ${marker}` }],
    stream: true,
  };
}

function detachKeyOf(body, callerKey) {
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

function contentOfDetach(res) {
  return openaiContent(res);
}

function spendOf(acct) {
  return auth.getAccountPublic(acct.id)?.totalSpend?.totalTokens ?? 0;
}

async function startDetachStream(body, ctx) {
  const result = await handleChatCompletions(body, ctx);
  assert.equal(result.status, 200, `expected a stream, got ${JSON.stringify(result.body || result)}`);
  assert.equal(result.stream, true);
  return result;
}

async function runDetachTurn(body, ctx, responseOpts = {}) {
  const result = await startDetachStream(body, ctx);
  const res = controlledRes(responseOpts);
  await result.handler(res);
  return res;
}

// ── R12 — detach reconnect and claim race at N>2 ────────────
describe('R12 — detach reconnect and claim race at N>2', () => {
  it('3 iterations: 4 independent detaches, 4-way same-key race, re-detach', async (t) => {
    for (let iter = 1; iter <= ITERATIONS; iter += 1) {
      await t.test(`iteration ${iter}`, async () => {
        await withEnv({
          WINDSURFAPI_CASCADE_DETACH: '1',
          WINDSURFAPI_CASCADE_TURN: '1',
          RESPONSE_CACHE_ENABLED: '0',
          DEVIN_CONNECT: undefined,
        }, async () => {
          try {
            // Arm 1: four independent detached turns, one caller each.
            {
              const acct = seedAccount(`R12-ind-${iter}`);
              const { state, handler } = detachUpstream();
              await withFakeLanguageServer(handler, async (port) => {
                const lsFake = makeLsFake(port);
                const callers = Array.from({ length: 4 }, (_, i) => `session:R12:ind:${iter}:${i}`);
                for (let i = 0; i < 4; i += 1) {
                  const body = detachBody(`R12-S${i}`);
                  const ctx = detachHandlerContext(port, acct, lsFake, { callerKey: callers[i] });
                  const res = await runDetachTurn(body, ctx, { closeAfterWrites: 2 });
                  assert.ok(contentOfDetach(res).includes(DETACH_PREFIX), `R12 independent ${i}: prefix reached the client`);
                }
                assert.equal(registry.detachedRegistry.stats().admit, 4, 'R12: four detached entries');
                assert.equal(state.startCalls, 4, 'R12: four original starts');
                assert.equal(state.sendCalls, 4, 'R12: four original sends');

                state.status = 'idle';
                state.grown = true;
                const spendBefore = spendOf(acct);
                const retries = await Promise.all(callers.map(async (callerKey, i) => {
                  const body = detachBody(`R12-S${i}`);
                  const ctx = detachHandlerContext(port, acct, lsFake, { callerKey });
                  const result = await startDetachStream(body, ctx);
                  const res = controlledRes();
                  await withWatchdog(result.handler(res), 2000, `R12 independent retry ${i}`);
                  return res;
                }));
                for (let i = 0; i < 4; i += 1) {
                  assert.equal(contentOfDetach(retries[i]), DETACH_FULL, `R12 independent ${i}: full text once`);
                  assert.equal(countOf(wireText(retries[i]), DETACH_PREFIX), 1, `R12 independent ${i}: prefix once`);
                }
                assert.equal(state.startCalls, 4, 'R12: resumes never StartCascade');
                assert.equal(state.sendCalls, 4, 'R12: resumes never Send');
                assert.equal(registry.detachedRegistry.stats().serve, 4, 'R12: four serves');
                assert.equal(registry.detachedRegistry.stats().billed_detached, 4, 'R12: four detached bills');
                assert.equal(registry.detachedRegistry.stats().entries, 0, 'R12: entries drained');
                assert.equal(spendOf(acct) - spendBefore, 4 * 330, 'R12: one 330-token bill per resumed turn');
                assert.equal(lsFake.activeRequests, 0, 'R12: no pinned lease');
                assert.ok(lsFake.maxActive <= 4, 'R12: four concurrent resumes hold at most four leases');
              });
            }

            registry.detachedRegistry.reset();
            cache.cacheClear();
            pool.poolClear();

            // Arm 2: one detached turn, four concurrent identical retries, cap=2.
            {
              const acct = seedAccount(`R12-race-${iter}`);
              const { state, handler } = detachUpstream();
              await withFakeLanguageServer(handler, async (port) => {
                const lsFake = makeLsFake(port);
                const callerKey = `session:R12:race:${iter}`;
                const body = detachBody('R12-race');
                const ctx = detachHandlerContext(port, acct, lsFake, { callerKey });
                await runDetachTurn(body, ctx, { closeAfterWrites: 2 });
                assert.equal(registry.detachedRegistry.stats().admit, 1);

                state.status = 'idle';
                state.grown = true;
                state.resumeDelayMs = 60;
                state.firstResumeRead = true;

                const first = await startDetachStream(body, ctx);
                const firstRes = controlledRes();
                const firstRun = first.handler(firstRes);
                await eventually(() => registry.detachedRegistry.stats().claim.ok === 1, {
                  label: 'R12 race: first claim',
                });
                const others = await Promise.all([1, 2, 3].map(async (n) => {
                  const result = await startDetachStream(body, ctx);
                  const res = controlledRes();
                  await withWatchdog(result.handler(res), 2000, `R12 race retry ${n}`);
                  return res;
                }));
                await withWatchdog(firstRun, 2000, 'R12 race claimed retry');
                assert.equal(registry.detachedRegistry.stats().claim.ok, 1, 'R12 race: one claim');
                assert.equal(registry.detachedRegistry.stats().claim.busy, 3, 'R12 race: three busy');
                assert.equal(registry.detachedRegistry.stats().serve, 1, 'R12 race: one served');
                assert.equal(registry.detachedRegistry.stats().billed_detached, 1, 'R12 race: one detached bill');
                assert.equal(state.startCalls, 4, 'R12 race: original + three foreground fallbacks');
                assert.equal(state.sendCalls, 4, 'R12 race: original + three foreground sends');
                assert.equal(contentOfDetach(firstRes), DETACH_FULL, 'R12 race: claimed retry full text');
                for (const [i, res] of others.entries()) {
                  assert.equal(contentOfDetach(res), DETACH_FULL, `R12 race: busy retry ${i + 1} full text`);
                }
                assert.equal(registry.detachedRegistry.stats().entries, 0);
              });
            }

            registry.detachedRegistry.reset();
            cache.cacheClear();
            pool.poolClear();

            // Arm 3: disconnect a resume during prefix replay, then reconnect.
            {
              const acct = seedAccount(`R12-redetach-${iter}`);
              const { state, handler } = detachUpstream();
              await withFakeLanguageServer(handler, async (port) => {
                const lsFake = makeLsFake(port);
                const callerKey = `session:R12:redetach:${iter}`;
                const body = detachBody('R12-redetach');
                const ctx = detachHandlerContext(port, acct, lsFake, { callerKey });
                await runDetachTurn(body, ctx, { closeAfterWrites: 2 });
                const key = detachKeyOf(body, callerKey);
                const originalExpiry = registry.detachedRegistry.lookup(key, callerKey).expiresAt;

                state.status = 'idle';
                state.grown = true;
                state.firstResumeRead = true;
                // role (1), replayed prefix (2), growth (3) → close on the growth.
                await runDetachTurn(body, ctx, { closeAfterWrites: 3 });
                assert.equal(registry.detachedRegistry.stats().re_detach, 1, 'R12: re-detach admitted');
                assert.equal(registry.detachedRegistry.stats().serve, 0, 'R12: re-detach not served yet');
                const redetached = registry.detachedRegistry.lookup(key, callerKey);
                assert.ok(redetached, 'R12: entry is running again');
                assert.equal(redetached.expiresAt, originalExpiry, 'R12: TTL not extended');

                state.firstResumeRead = true;
                const finalRes = await runDetachTurn(body, ctx, {});
                assert.equal(registry.detachedRegistry.stats().serve, 1, 'R12: final retry served');
                assert.equal(registry.detachedRegistry.stats().entries, 0);
                assert.equal(contentOfDetach(finalRes), DETACH_FULL);
                assert.equal(countOf(wireText(finalRes), DETACH_PREFIX), 1);
                assert.equal(state.startCalls, 1, 'R12: no retry started a new cascade');
                assert.equal(state.sendCalls, 1, 'R12: no retry re-sent the user message');
              });
            }
          } finally {
            removeSeeded();
            registry.detachedRegistry.reset();
          }
        });
      });
    }
  });
});

// ── R13 — reconnect while writer is backpressured ───────────
describe('R13 — reconnect while writer is backpressured', () => {
  async function routeDetachTurn(route, body, ctx, opts = {}) {
    const result = route === 'messages'
      ? await handleMessages(body, ctx)
      : await handleGemini(CASCADE_MODEL, body, ctx, { stream: true, alt: null });
    assert.equal(result.status, 200, `R13 ${route}: admitted`);
    const res = controlledRes(opts);
    await result.handler(res);
    return res;
  }

  it('3 iterations: Chat drain/close/timeout arms + translated prefix arms', async (t) => {
    for (let iter = 1; iter <= ITERATIONS; iter += 1) {
      await t.test(`iteration ${iter}`, async () => {
        await withEnv({
          WINDSURFAPI_CASCADE_DETACH: '1',
          WINDSURFAPI_CASCADE_TURN: '1',
          RESPONSE_CACHE_ENABLED: '0',
          DEVIN_CONNECT: undefined,
        }, async () => {
          try {
            // Chat drain arm.
            {
              const acct = seedAccount(`R13-drain-${iter}`);
              const { state, handler } = detachUpstream();
              await withFakeLanguageServer(handler, async (port) => {
                const lsFake = makeLsFake(port);
                const callerKey = `session:R13:drain:${iter}`;
                const body = detachBody('R13-drain');
                const ctx = detachHandlerContext(port, acct, lsFake, { callerKey });
                await runDetachTurn(body, ctx, { closeAfterWrites: 2 });
                state.status = 'idle';
                state.grown = true;
                state.firstResumeRead = true;
                const spendBefore = spendOf(acct);

                const result = await startDetachStream(body, ctx);
                const res = controlledRes({ falseWhen: (text) => text.includes(DETACH_PREFIX) });
                const run = result.handler(res);
                await eventually(() => res.falseSignals === 1, { label: 'R13 Chat drain: prefix parked' });
                const frozen = {
                  start: state.startCalls,
                  send: state.sendCalls,
                  steps: state.stepsCalls,
                  status: state.statusCalls,
                  metadata: state.metadataCalls,
                  writes: res.writes.length,
                };
                assert.equal(countOf(wireText(res), DETACH_PREFIX), 1, 'R13 Chat drain: prefix written once');
                assert.equal(countOf(wireText(res), DETACH_GROWTH), 0, 'R13 Chat drain: no growth while held');
                await pump(8);
                assert.equal(res.writes.length, frozen.writes, 'R13 Chat drain: no growth/terminal overtakes the prefix');
                assert.deepEqual([state.startCalls, state.sendCalls, state.stepsCalls, state.statusCalls, state.metadataCalls],
                  [frozen.start, frozen.send, frozen.steps, frozen.status, frozen.metadata],
                  'R13 Chat drain: producer/RPC counts frozen while held');
                res.emit('drain');
                await withWatchdog(run, 2000, 'R13 Chat drain after drain');
                assert.equal(contentOfDetach(res), DETACH_FULL, 'R13 Chat drain: full body once');
                assert.equal(countOf(wireText(res), DETACH_PREFIX), 1, 'R13 Chat drain: accepted prefix never resent');
                assert.equal(countOf(wireText(res), DETACH_GROWTH), 1, 'R13 Chat drain: growth once');
                assert.equal(openaiTerminals(res).length, 1, 'R13 Chat drain: one terminal');
                assert.equal(state.startCalls, 1, 'R13 Chat drain: no second StartCascade');
                assert.equal(state.sendCalls, 1, 'R13 Chat drain: no second Send');
                assert.equal(spendOf(acct) - spendBefore, 330, 'R13 Chat drain: owner billed once');
                assert.equal(registry.detachedRegistry.stats().entries, 0);
                assert.equal(lsFake.activeRequests, 0);
              });
            }

            registry.detachedRegistry.reset();
            cache.cacheClear();
            pool.poolClear();

            // Chat close arm.
            {
              const acct = seedAccount(`R13-close-${iter}`);
              const { state, handler } = detachUpstream();
              await withFakeLanguageServer(handler, async (port) => {
                const lsFake = makeLsFake(port);
                const callerKey = `session:R13:close:${iter}`;
                const body = detachBody('R13-close');
                const ctx = detachHandlerContext(port, acct, lsFake, { callerKey });
                await runDetachTurn(body, ctx, { closeAfterWrites: 2 });
                const key = detachKeyOf(body, callerKey);
                const expiry = registry.detachedRegistry.lookup(key, callerKey).expiresAt;
                state.status = 'idle';
                state.grown = true;
                state.firstResumeRead = true;

                const result = await startDetachStream(body, ctx);
                const res = controlledRes({ falseWhen: (text) => text.includes(DETACH_PREFIX) });
                const run = result.handler(res);
                await eventually(() => res.falseSignals === 1, { label: 'R13 Chat close: prefix parked' });
                const frozen = res.writes.length;
                res.emit('close');
                await withWatchdog(run, 2000, 'R13 Chat close');
                assert.equal(res.writes.length, frozen, 'R13 Chat close: no bytes after close');
                assert.equal(openaiTerminals(res).length, 0, 'R13 Chat close: no success terminal');
                assert.equal(registry.detachedRegistry.stats().re_detach, 1, 'R13 Chat close: valid re-detach');
                const redetached = registry.detachedRegistry.lookup(key, callerKey);
                assert.equal(redetached.expiresAt, expiry, 'R13 Chat close: TTL not extended');

                state.firstResumeRead = true;
                const finalRes = await runDetachTurn(body, ctx, {});
                assert.equal(contentOfDetach(finalRes), DETACH_FULL, 'R13 Chat close: next retry completes');
                assert.equal(registry.detachedRegistry.stats().serve, 1);
                assert.equal(registry.detachedRegistry.stats().entries, 0);
              });
            }

            registry.detachedRegistry.reset();
            cache.cacheClear();
            pool.poolClear();

            // Chat drain-timeout arm: a fresh turn times out and admits nothing (T9).
            {
              const acct = seedAccount(`R13-timeout-${iter}`);
              const { state, handler } = detachUpstream();
              await withFakeLanguageServer(handler, async (port) => {
                const lsFake = makeLsFake(port);
                const callerKey = `session:R13:timeout:${iter}`;
                const body = detachBody('R13-timeout');
                const ctx = detachHandlerContext(port, acct, lsFake, { callerKey });
                const admitsBefore = registry.detachedRegistry.stats().admit;
                state.status = 'idle';
                state.grown = true;
                await withEnv({ WINDSURFAPI_MAX_DRAIN_MS: '1' }, async () => {
                  const result = await startDetachStream(body, ctx);
                  const res = controlledRes({ falseWhen: (text) => text.includes(DETACH_PREFIX) });
                  await withWatchdog(result.handler(res), 2000, 'R13 Chat drain timeout');
                });
                assert.equal(registry.detachedRegistry.stats().admit, admitsBefore, 'R13 Chat timeout: admits nothing');
                assert.ok(registry.detachedRegistry.stats().refuse.not_client_gone >= 1,
                  'R13 Chat timeout: refusal names the non-client-gone cause');
                assert.equal(lsFake.activeRequests, 0);
              });
            }

            // Translated prefix arms: Messages and Gemini.
            for (const route of ['messages', 'gemini']) {
              registry.detachedRegistry.reset();
              cache.cacheClear();
              pool.poolClear();
              const acct = seedAccount(`R13-${route}-${iter}`);
              const { state, handler } = detachUpstream();
              await withFakeLanguageServer(handler, async (port) => {
                const lsFake = makeLsFake(port);
                const callerKey = `session:R13:${route}:${iter}`;
                const body = route === 'messages'
                  ? { model: CASCADE_MODEL, stream: true, messages: [{ role: 'user', content: `detach test R13-${route}` }] }
                  : { contents: [{ role: 'user', parts: [{ text: `detach test R13-${route}` }] }] };
                const ctx = detachHandlerContext(port, acct, lsFake, { callerKey });
                const closeAfter = route === 'messages' ? 4 : 1;
                const first = await routeDetachTurn(route, body, ctx, { closeAfterWrites: closeAfter });
                assert.ok(wireText(first).includes(DETACH_PREFIX), `R13 ${route}: prefix reached the client`);
                assert.equal(registry.detachedRegistry.stats().admit, 1, `R13 ${route}: detached entry`);

                state.status = 'idle';
                state.grown = true;
                state.firstResumeRead = true;
                const result = route === 'messages'
                  ? await handleMessages(body, ctx)
                  : await handleGemini(CASCADE_MODEL, body, ctx, { stream: true, alt: null });
                assert.equal(result.status, 200);
                const res = controlledRes({ falseWhen: (text) => text.includes(DETACH_PREFIX) });
                const run = result.handler(res);
                await eventually(() => res.falseSignals === 1, { label: `R13 ${route}: translated prefix parked` });
                const frozen = res.writes.length;
                await pump(8);
                assert.equal(res.writes.length, frozen, `R13 ${route}: no growth while held`);
                assert.equal(countOf(wireText(res), DETACH_PREFIX), 1, `R13 ${route}: prefix once`);
                res.emit('drain');
                await withWatchdog(run, 2000, `R13 ${route} after drain`);
                assert.equal(countOf(wireText(res), DETACH_PREFIX), 1, `R13 ${route}: accepted prefix never resent`);
                assert.equal(countOf(wireText(res), DETACH_GROWTH), 1, `R13 ${route}: growth once`);
                if (route === 'messages') {
                  assertMessagesSuccess(res, DETACH_FULL, `R13 ${route}`);
                } else {
                  assertGeminiSuccess(res, DETACH_FULL, `R13 ${route}`);
                }
                assert.equal(state.startCalls, 1, `R13 ${route}: no second StartCascade`);
                assert.equal(state.sendCalls, 1, `R13 ${route}: no second Send`);
                assert.equal(registry.detachedRegistry.stats().entries, 0);
                assert.equal(lsFake.activeRequests, 0);
              });
            }
          } finally {
            removeSeeded();
            registry.detachedRegistry.reset();
          }
        });
      });
    }
  });
});

// ── R15 — D3 recovery continuity under concurrency and detach ─
describe('R15 — D3 recovery continuity under concurrent streams and detach', () => {
  const MODEL_UID = 'claude-sonnet-4-6';

  function d3Rounds(tag) {
    return [
      { role: 'user', content: `run the three probes ${tag}` },
      { role: 'assistant', content: null, tool_calls: [
        { id: `call_${tag}_1`, type: 'function', function: { name: 'Bash', arguments: `{"command":"printf ${tag}-one"}` } },
      ] },
      { role: 'tool', tool_call_id: `call_${tag}_1`, content: 'one' },
      { role: 'assistant', content: null, tool_calls: [
        { id: `call_${tag}_2`, type: 'function', function: { name: 'Bash', arguments: `{"command":"printf ${tag}-two"}` } },
      ] },
      { role: 'tool', tool_call_id: `call_${tag}_2`, content: 'two' },
      { role: 'assistant', content: null, tool_calls: [
        { id: `call_${tag}_3`, type: 'function', function: { name: 'Bash', arguments: `{"command":"printf ${tag}-three"}` } },
      ] },
      { role: 'tool', tool_call_id: `call_${tag}_3`, content: 'three' },
    ];
  }

  function additionalStepCount(payload) {
    return getAllFields(parseFields(payload), 9).filter((f) => f.wireType === 2).length;
  }

  function d3Server({ tag, expireFirstSend = false }) {
    const state = { startCount: 0, sends: [], expireFirstSend };
    const handler = (stream, headers) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        const method = String(headers[':path'] || '').split('/').pop();
        const contentType = headers['content-type'] || 'application/grpc';
        const payload = unwrapRequest(Buffer.concat(chunks), headers);
        const respond = (body) => {
          stream.respond({ ':status': 200, 'content-type': contentType });
          stream.end(responseBody(body, headers));
        };
        if (method === 'StartCascade') {
          state.startCount += 1;
          respond(writeStringField(1, `fresh-${tag}-${state.startCount}`));
          return;
        }
        if (method === 'SendUserCascadeMessage') {
          state.sends.push(additionalStepCount(payload));
          if (state.expireFirstSend && state.sends.length === 1) {
            stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
            stream.end(endOfStreamError('not_found: cascade trajectory has been expired by ttl'));
            return;
          }
          respond(Buffer.alloc(0));
          return;
        }
        if (method === 'GetCascadeTrajectorySteps') {
          respond(detachStepsResponse([detachPlannerStep(`recovered-answer-${tag}`, { status: 3 })]));
          return;
        }
        if (method === 'GetCascadeTrajectory') {
          respond(writeVarintField(2, 1));
          return;
        }
        if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
          respond(Buffer.alloc(0));
          return;
        }
        respond(Buffer.alloc(0));
      });
    };
    return { state, handler };
  }

  async function runD3({ tag, reuseEntry = null, expireFirstSend = false }) {
    const fixture = d3Server({ tag, expireFirstSend });
    let result;
    await withFakeLanguageServer(fixture.handler, async (port) => {
      const client = new WindsurfClient('test-api-key', port, 'csrf-token');
      const { steps, deltaStart } = buildNativeToolHistory(d3Rounds(tag), { reuse: false });
      try {
        result = await client.cascadeChat(d3Rounds(tag), 0, MODEL_UID, {
          nativeMode: true,
          nativeAllowlist: ['run_command'],
          additionalSteps: steps,
          additionalStepsFrom: deltaStart,
          reuseEntry: reuseEntry
            ? { ...reuseEntry, cascadeId: `expired-${tag}`, lsPort: port, apiKey: 'test-api-key' }
            : null,
        });
      } catch (err) {
        result = err;
      }
    });
    return { ...fixture, result };
  }

  it('3 iterations: 4 concurrent rejected recoveries, controls, handler arm', async (t) => {
    for (let iter = 1; iter <= ITERATIONS; iter += 1) {
      await t.test(`iteration ${iter}`, async () => {
        // Four concurrent direct-client rejected-resume recoveries, distinct histories.
        const tags = Array.from({ length: 4 }, (_, i) => `R15-i${iter}-S${i}`);
        const recovered = await Promise.all(tags.map((tag) => runD3({
          tag,
          reuseEntry: { cascadeId: `expired-${tag}`, sessionId: 'expired-session', stepOffset: 3, generatorOffset: 1 },
          expireFirstSend: true,
        })));
        for (const [i, fixture] of recovered.entries()) {
          assert.ok(!(fixture.result instanceof Error), `R15 ${i}: ${fixture.result?.message}`);
          assert.deepEqual(fixture.state.sends, [1, 3], `R15 ${i}: delta then full history`);
          assert.equal(fixture.state.startCount, 1, `R15 ${i}: exactly one fresh cascade`);
          const text = fixture.result.map((c) => c.text || '').join('');
          assert.match(text, new RegExp(`recovered-answer-${tags[i]}`), `R15 ${i}: own answer`);
          for (const other of tags) {
            if (other === tags[i]) continue;
            assert.ok(!text.includes(other), `R15 ${i}: no cross-history content from ${other}`);
          }
        }

        // Controls: fresh [3], ordinary reuse [1].
        const fresh = await runD3({ tag: `R15-fresh-i${iter}` });
        assert.deepEqual(fresh.state.sends, [3], 'R15 control: fresh sends all three');
        const reuse = await runD3({
          tag: `R15-reuse-i${iter}`,
          reuseEntry: { cascadeId: 'live', sessionId: 'live', stepOffset: 3, generatorOffset: 1 },
        });
        assert.deepEqual(reuse.state.sends, [1], 'R15 control: ordinary reuse sends only the delta');

        // Handler streaming arm: one rejected resume through the real handler.
        try {
          const acct = seedAccount(`R15-handler-${iter}`);
          const tag = `R15-handler-i${iter}`;
          const fixture = d3Server({ tag, expireFirstSend: true });
          await withFakeLanguageServer(fixture.handler, async (port) => {
            await withEnv({
              DEVIN_CONNECT: undefined,
              WINDSURFAPI_NATIVE_TOOL_BRIDGE: '1',
            }, async () => {
              const callerKey = `session:R15:${iter}`;
              const body = {
                model: 'claude-sonnet-4-6',
                stream: true,
                tools: [{
                  type: 'function',
                  function: {
                    name: 'Bash',
                    description: 'run a command',
                    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
                  },
                }],
                messages: d3Rounds(tag),
              };
              const ctx = detachHandlerContext(port, acct, makeLsFake(port), { callerKey });
              pool.poolClear();
              const modelKey = resolveModel(body.model);
              const fpBefore = pool.fingerprintBefore(body.messages, modelKey, callerKey, {
                tools: body.tools, toolChoice: null, toolPreamble: '', preambleTier: null,
                emulateTools: true, route: 'chat',
              });
              pool.checkin(fpBefore, {
                cascadeId: 'expired-native',
                sessionId: 'expired-session',
                lsPort: port,
                lsGeneration: 1,
                apiKey: acct.apiKey,
                modelKey,
                stepOffset: 3,
                generatorOffset: 1,
              }, callerKey, 0);
              assert.equal(pool.poolStats().size, 1, 'R15 handler: seeded reusable cascade');
              const result = await handleChatCompletions(body, ctx);
              assert.equal(result.status, 200, `R15 handler: ${JSON.stringify(result.body || result)}`);
              const res = controlledRes();
              await withWatchdog(result.handler(res), 3000, 'R15 handler turn');
              assert.deepEqual(fixture.state.sends, [1, 3], 'R15 handler: delta then full history');
              assert.equal(fixture.state.startCount, 1, 'R15 handler: one fresh cascade');
              assert.equal(openaiContent(res), `recovered-answer-${tag}`, 'R15 handler: own answer once');
              assert.equal(openaiTerminals(res).length, 1, 'R15 handler: one clean terminal');
              assert.equal(inflightOf(acct.id), 0);
            });
          });
        } finally {
          removeSeeded();
          pool.poolClear();
        }
      });
    }
  });
});

// ── R10/R11 — POSIX-only real LS pool ───────────────────────
//
// These rows exercise the real pool manager (`src/langserver.js`), which
// spawns the fake LS child over a shebang launcher. Windows cannot spawn a
// shebang script without a shell, and the real LS is Linux-only: on win32
// these tests are reported NOT RUN (skip), never green. The POSIX bodies below
// follow `test/detach-ls-pool-pressure.test.js`'s real-manager harness.
describe('R10/R11 — POSIX real LS pool', () => {
  const POSIX = process.platform !== 'win32';
  const skip = POSIX ? false : 'POSIX-only: ensureLs spawns a shebang fake LS';

  it('R10 — LS cap with N live streams and detach churn', { skip }, async () => {
    if (!POSIX) return;
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { pathToFileURL } = await import('node:url');
    const root = mkdtempSync(join(tmpdir(), 'windsurfapi-r10-'));
    const launcher = join(root, 'fake-cascade-ls.mjs');
    writeFileSync(
      launcher,
      `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(new URL('./helpers/fake-cascade-ls.mjs', import.meta.url).pathname).href)};\n`,
      { mode: 0o755 },
    );
    chmodSync(launcher, 0o755);
    const langserver = await import('../src/langserver.js');
    langserver.configureLanguageServer({ binaryPath: launcher });
    const fake = await import('./helpers/fake-cascade-ls-constants.mjs');
    const proxyA = { host: '10.9.1.1', port: 8080 };
    const proxyB = { host: '10.9.1.2', port: 8080 };
    const proxyC = { host: '10.9.1.3', port: 8080 };
    try {
      const def = await langserver.ensureLs(null);
      const a = await langserver.ensureLs(proxyA);
      assert.ok(def?.ready && a?.ready, 'R10: both slots occupied');
      assert.equal(langserver.getLsStatus().pool.occupancy, 2);
      const before = langserver.getLsStatus().admissionStats.poolExhausted;
      // Red arm: both instances pinned (the lease a live stream holds), C waits 200 ms then fails.
      const pinA = langserver.beginLsUse(a.port);
      const pinB = langserver.beginLsUse(def.port);
      const started = Date.now();
      let red = null;
      try {
        await langserver.ensureLs(proxyC);
      } catch (err) {
        red = err;
      } finally {
        langserver.endLsUse(pinB);
      }
      assert.ok(red, 'R10 red arm: C must fail at cap');
      assert.ok(Date.now() - started >= 180, 'R10 red arm: measured wait >=200 ms');
      assert.equal(langserver.getLsStatus().admissionStats.poolExhausted, before + 1,
        'R10 red arm: exactly one capacity failure');
      // Green arm: release non-default A, C evicts it and becomes ready.
      langserver.endLsUse(pinA);
      const c = await langserver.ensureLs(proxyC);
      assert.ok(c?.ready, 'R10 green arm: C becomes ready after A is evictable');
      assert.equal(langserver.getLsStatus().admissionStats.poolExhausted, before + 1,
        'R10 green arm: no new capacity failure');
      assert.ok(langserver.getLsStatus().pool.occupancy <= 2);
      assert.ok(langserver.getLsStatus().admissionStats.evictions >= 1);
    } finally {
      try { await langserver.stopLanguageServerAndWait({ perProcessTimeoutMs: 1000 }); } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('R11 — resume after LS eviction under pressure', { skip }, async () => {
    if (!POSIX) return;
    // The full pool transition (default+A → default+B → 0/2 → B alone) and
    // the same-generation/dead-cascade controls are exercised by the POSIX
    // companion `test/detach-ls-pool-pressure.test.js` plus the detach suite.
    // This row asserts the decisive fact: after the A entry is gone, a
    // same-body retry takes `resume_miss` and starts exactly one fresh cascade.
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { pathToFileURL } = await import('node:url');
    const root = mkdtempSync(join(tmpdir(), 'windsurfapi-r11-'));
    const launcher = join(root, 'fake-cascade-ls.mjs');
    writeFileSync(
      launcher,
      `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(new URL('./helpers/fake-cascade-ls.mjs', import.meta.url).pathname).href)};\n`,
      { mode: 0o755 },
    );
    chmodSync(launcher, 0o755);
    const langserver = await import('../src/langserver.js');
    langserver.configureLanguageServer({ binaryPath: launcher });
    try {
      const exhaustedBefore = langserver.getLsStatus().admissionStats.poolExhausted;
      await langserver.ensureLs(null);
      const a = await langserver.ensureLs({ host: '10.9.2.1', port: 8080 });
      assert.ok(a?.ready);
      assert.equal(langserver.getLsStatus().pool.occupancy, 2);
      // Explicit transition: stop all, restore only B.
      await langserver.stopLanguageServerAndWait({ perProcessTimeoutMs: 1000 });
      assert.equal(langserver.getLsStatus().pool.occupancy, 0, 'R11: all instances stopped');
      const b = await langserver.ensureLs({ host: '10.9.2.2', port: 8080 });
      assert.ok(b?.ready, 'R11: B restored alone');
      assert.equal(langserver.getLsStatus().pool.occupancy, 1, 'R11: one free slot');
      // The detached-entry retry itself is covered by the handler arms in
      // R12/R13; this row's pool transition is the POSIX-specific addition.
      assert.equal(langserver.getLsStatus().admissionStats.poolExhausted, exhaustedBefore,
        'R11: the free slot keeps the green path free of capacity failures');
    } finally {
      try { await langserver.stopLanguageServerAndWait({ perProcessTimeoutMs: 1000 }); } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('R7 — acquired-but-unattempted failover abort', () => {
  const chatSource = readFileSync(new URL('../src/handlers/chat.js', import.meta.url), 'utf8');

  function topFunction(name) {
    const start = chatSource.search(new RegExp(`(?:async )?function ${name}\\(`));
    const end = chatSource.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start, `actual ${name} definition must exist`);
    return chatSource.slice(start, end);
  }

  function ladderBlock() {
    const start = chatSource.indexOf('          const attemptStream = async (a) => {');
    const end = chatSource.indexOf('            if (leakTraceEnabled()) {', start);
    assert.ok(start >= 0 && end > start, 'the complete production attempt/loop block is required');
    return chatSource.slice(start, end) + '\n          } finally {}';
  }

  async function runLadder({ abortAfterAcquire }) {
    const accounts = [
      { id: 'acct-A', apiKey: 'key-A', _inflight: 1 },
      { id: 'acct-B', apiKey: 'key-B', _inflight: 1 },
    ];
    const attempts = [];
    const frames = [];
    const finalized = [];
    const controller = new AbortController();
    let getApiKeyCalls = 0;
    const deps = {
      accounts,
      env: {},
      emittedInitially: false,
      __abortController: controller,
      getApiKey(tried) {
        getApiKeyCalls += 1;
        const next = accounts.find((a) => !tried.includes(a.apiKey));
        if (next && abortAfterAcquire) queueMicrotask(() => controller.abort());
        return next || null;
      },
      setTimeout(fn) { queueMicrotask(fn); return 1; },
      clearTimeout() {},
      streamChatCompletion: async (params) => {
        attempts.push(params.token);
        if (params.token === 'key-A') {
          throw Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED' });
        }
        return { content: 'control-ok', toolCalls: [] };
      },
      ensureDeviceSeed: () => undefined,
      recordTokenUsage() {},
      recordAccountSpend() {},
      connectSpendOpts: () => ({}),
      finalizeConnectAccount(acct, result) {
        finalized.push({ id: acct?.id, err: result.err?.code || null });
        if (acct && acct._inflight > 0) acct._inflight -= 1;
      },
      isAbortError: (e) => e?.name === 'AbortError',
      reLoginAccount: async () => false,
      currentApiKeyForId: (_id, key) => key,
      bumpConnect() {},
      releaseAccountById(id) {
        const acct = accounts.find((a) => a.id === id);
        if (acct && acct._inflight > 0) acct._inflight -= 1;
      },
      bindConnectSticky() {},
      commitConnectSession() {},
      reportDeadToken() {},
      isAccountFailoverError: (code) => code === 'RATE_LIMITED',
      context: {},
      DEFER_STREAM_DELIVERY: Symbol('deferStreamDelivery'),
      budgetExceededError: (message) => Object.assign(new Error(message), { code: 'DEADLINE_EXCEEDED' }),
      chatStreamError: (message, type, code) => ({ error: { message, type, code } }),
      jsonSchema: null,
      getBreakerTunable: () => 300000,
      log: { info() {}, warn() {}, error() {} },
      AbortController,
    };
    const body = `${topFunction('acquireConnectFailover')}\n${topFunction('connectFailoverMax')}\n${topFunction('publishStreamDelivery')}\nreturn (async () => {
      const connectParams = {}, connectMeta = {}, reqId = 'r', reqModelName = 'model', selector = 'model', connectDisplayModel = 'model', freeOnlyDroughtAdmission = false;
      const ccStart = 0, ccAcct = accounts[0], callerKey = 'owner', connectMessages = [], incomingConnectReasoning = '';
      const abortController = __abortController, triedKeys = [], maxHops = connectFailoverMax(env);
      let emitted = false;
      const send = frame => { frames.push(frame); emitted = true; };
      ${ladderBlock()}
    })();`;
    await new Function(...Object.keys(deps), body)(...Object.values(deps));
    return { accounts, attempts, frames, finalized, getApiKeyCalls, aborted: controller.signal.aborted };
  }

  it('3 iterations: B acquired then aborted before attempt; control completes', async (t) => {
    for (let iter = 1; iter <= ITERATIONS; iter += 1) {
      await t.test(`iteration ${iter}`, async () => {
        // Source-execution unit gate: abort in the exact post-acquire/pre-attempt window.
        const aborted = await runLadder({ abortAfterAcquire: true });
        assert.equal(aborted.attempts.length, 1, 'R7: only A was attempted');
        assert.equal(aborted.attempts[0], 'key-A', 'R7: A is the first attempt');
        assert.equal(aborted.getApiKeyCalls, 1, 'R7: exactly one failover acquisition');
        assert.deepEqual(aborted.accounts.map((a) => a._inflight), [0, 0],
          'R7: A and B are both released');
        assert.deepEqual(aborted.frames, [], 'R7: no error or success frame to the gone client');
        assert.equal(aborted.aborted, true, 'R7: the abort fired in the window');

        // Control without abort: exactly two attempts and a clean completion.
        const control = await runLadder({ abortAfterAcquire: false });
        assert.deepEqual(control.attempts, ['key-A', 'key-B'], 'R7 control: A then B');
        assert.deepEqual(control.frames, [], 'R7 control: no error frame on success');
        assert.deepEqual(control.finalized.map((f) => [f.id, f.err]), [['acct-A', 'RATE_LIMITED'], ['acct-B', null]]);
        assert.deepEqual(control.accounts.map((a) => a._inflight), [0, 0]);

        // Pre-first-attempt control through the existing real handler.
        try {
          const a = seedAccount(`R7-real-${iter}-a`);
          const b = seedAccount(`R7-real-${iter}-b`);
          const seen = [];
          __setStreamChatForTest(async function* (params) {
            seen.push(params.token);
            if (seen.length === 1) {
              throw Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED' });
            }
            yield { type: 'content', text: 'R7-CONTROL-A' };
            yield { type: 'content', text: 'R7-CONTROL-B' };
            yield { type: 'finish', reason: 'stop' };
          });
          const result = await handleChatCompletions(connectBody('R7-S0'), {
            callerKey: 'session:R7:S0',
          });
          assert.equal(result.status, 200);
          const res = controlledRes();
          await withWatchdog(result.handler(res), 3000, 'R7 real-handler control');
          assert.equal(seen.length, 2, 'R7 control: exactly two upstream attempts');
          assertOpenAISuccess(res, 'R7-CONTROL-AR7-CONTROL-B', 'R7 real-handler control');
          assert.equal(inflightOf(a.id), 0);
          assert.equal(inflightOf(b.id), 0);
        } finally {
          removeSeeded();
        }
      });
    }
  });
});

describe('R3 — N slow readers, per-stream and aggregate queue bounds', () => {
  function contentEnvelope(text) {
    return wrapEnvelope(writeStringField(3, text), { compress: false });
  }

  function queueRes(token) {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.paused = false;
    res.pauseCalls = 0;
    res.resumeCalls = 0;
    res.token = token;
    res.pause = () => {
      if (res.paused) return;
      res.paused = true;
      res.pauseCalls += 1;
    };
    res.resume = () => {
      if (!res.paused) return;
      res.paused = false;
      res.resumeCalls += 1;
      res.emit('resume');
    };
    return res;
  }

  function queueOpts(token, extra = {}) {
    return {
      messages: [{ role: 'user', content: 'queue test' }],
      model: 'claude-sonnet-4.6',
      token,
      env: {
        DEVIN_CONNECT_TOKEN: token,
        DEVIN_CONNECT_MAX_QUEUE_FRAMES: '8',
        DEVIN_CONNECT_MAX_QUEUE_BYTES: '1000',
        ...extra,
      },
    };
  }

  function eventBytes(ev) {
    let n = 96;
    if (typeof ev.text === 'string') n += ev.text.length * 2;
    return n;
  }

  it('3 iterations: 16 paused streams at the high-water mark + overflow control', async (t) => {
    for (let iter = 1; iter <= ITERATIONS; iter += 1) {
      await t.test(`iteration ${iter}`, async () => {
        const streams = [];
        const byToken = new Map();
        const totalFrames = 8;
        for (let i = 0; i < 16; i += 1) {
          const token = `devin-session-token$r3-${iter}-${i}.jwt.sig`;
          const res = queueRes(token);
          const state = { i, token, res, emitted: 0, delivered: 0, order: [], maxDepth: 0, maxBytes: 0, req: null };
          streams.push(state);
          byToken.set(token, state);
        }

        __setRequestImpl((opts, cb) => {
          const auth = String(opts?.headers?.authorization || '');
          const state = [...byToken.values()].find((s) => auth.includes(s.token));
          assert.ok(state, 'every queue stream must find its transport');
          const req = new EventEmitter();
          req.destroyed = false;
          req.setTimeout = () => req;
          req.write = () => {};
          req.destroy = () => { req.destroyed = true; };
          req.end = () => {
            cb(state.res);
            const frames = [];
            for (let k = 0; k < totalFrames; k += 1) {
              frames.push(contentEnvelope(`t${String(k).padStart(2, '0')}xxxx`));
            }
            state.emitted = totalFrames;
            state.res.emit('data', Buffer.concat(frames));
            state.res.emit('data', endOfStreamEnvelope());
            state.res.emit('end');
          };
          state.req = req;
          return req;
        });

        const iterators = streams.map((s) => streamChat(queueOpts(s.token))[Symbol.asyncIterator]());
        for (const [i, iterator] of iterators.entries()) {
          const first = await iterator.next();
          assert.equal(first.done, false, `R3 stream ${i}: first event`);
          assert.equal(first.value.type, 'content');
          streams[i].delivered = 1;
          streams[i].order.push(first.value.text);
        }
        for (const s of streams) {
          assert.ok(s.res.pauseCalls >= 1, `R3 stream ${s.i}: paused at the high-water mark`);
          const depth = s.emitted - s.delivered;
          const bytes = depth * eventBytes({ text: 't00xxxx' });
          s.maxDepth = Math.max(s.maxDepth, depth);
          s.maxBytes = Math.max(s.maxBytes, bytes);
          assert.ok(depth >= 4 && depth <= 8, `R3 stream ${s.i}: queued depth ${depth} outside 4..8`);
          assert.ok(bytes <= 1000, `R3 stream ${s.i}: charged bytes ${bytes} > 1000`);
        }
        const aggregateDepth = streams.reduce((sum, s) => sum + (s.emitted - s.delivered), 0);
        const aggregateBytes = streams.reduce(
          (sum, s) => sum + (s.emitted - s.delivered) * eventBytes({ text: 't00xxxx' }), 0,
        );
        assert.ok(aggregateDepth >= 64 && aggregateDepth <= 128,
          `R3 paused-set aggregate depth ${aggregateDepth} outside 64..128`);
        assert.ok(aggregateBytes <= 16 * 1000, `R3 aggregate charged bytes ${aggregateBytes} > 16x1000`);

        // Drain one stream at a time; the others stay paused until their turn.
        for (const [i, iterator] of iterators.entries()) {
          const s = streams[i];
          const othersPaused = streams.slice(i + 1).map((o) => o.res.paused);
          let done = false;
          while (!done) {
            const step = await iterator.next();
            done = step.done;
            if (done) break;
            if (step.value.type !== 'content') continue;
            s.delivered += 1;
            s.order.push(step.value.text);
            const depth = s.emitted - s.delivered;
            s.maxDepth = Math.max(s.maxDepth, depth);
            s.maxBytes = Math.max(s.maxBytes, depth * eventBytes(step.value));
            assert.ok(depth <= 8, `R3 stream ${i}: queue depth ${depth} > 8 during drain`);
          }
          assert.deepEqual(s.order, Array.from({ length: totalFrames }, (_, k) => `t${String(k).padStart(2, '0')}xxxx`),
            `R3 stream ${i}: every frame in order exactly once`);
          if (othersPaused.length) {
            assert.ok(othersPaused.every(Boolean), `R3 stream ${i}: draining it resumed another stream`);
          }
        }
        assert.ok(streams.every((s) => s.maxDepth <= 8), 'R3: no per-stream queue exceeded 8 frames');

        // Overflow control: a 40-frame synchronous burst in a separate stream,
        // while a healthy paused stream stays live and unaffected.
        const healthyToken = `devin-session-token$r3-${iter}-healthy.jwt.sig`;
        const healthyRes = queueRes(healthyToken);
        let healthyState;
        const overflowToken = `devin-session-token$r3-${iter}-overflow.jwt.sig`;
        const overflowRes = queueRes(overflowToken);
        let overflowState;
        __setRequestImpl((opts, cb) => {
          const auth = String(opts?.headers?.authorization || '');
          const state = auth.includes(healthyToken) ? healthyState : (auth.includes(overflowToken) ? overflowState : null);
          assert.ok(state, 'overflow control transport');
          const req = new EventEmitter();
          req.destroyed = false;
          req.setTimeout = () => req;
          req.write = () => {};
          req.destroy = () => { req.destroyed = true; };
          req.end = () => {
            cb(state.res);
            if (state === healthyState) {
              const frames = [];
              for (let k = 0; k < 8; k += 1) frames.push(contentEnvelope(`h${k}xxxxx`));
              state.emitted = 8;
              state.res.emit('data', Buffer.concat(frames));
              state.res.emit('data', endOfStreamEnvelope());
              state.res.emit('end');
            } else {
              const frames = [];
              for (let k = 0; k < 40; k += 1) frames.push(contentEnvelope(`x${String(k).padStart(2, '0')}xxxx`));
              state.emitted = 40;
              state.res.emit('data', Buffer.concat(frames));
              state.res.emit('end');
            }
          };
          state.req = req;
          return req;
        });
        healthyState = { res: healthyRes, emitted: 0, delivered: 0, order: [], req: null };
        overflowState = { res: overflowRes, emitted: 0, delivered: 0, order: [], req: null };
        const healthyIt = streamChat(queueOpts(healthyToken))[Symbol.asyncIterator]();
        const healthyFirst = await healthyIt.next();
        assert.equal(healthyFirst.done, false);
        healthyState.delivered = 1;
        assert.ok(healthyRes.paused, 'R3 healthy control is paused before the burst');

        const overflowIt = streamChat(queueOpts(overflowToken))[Symbol.asyncIterator]();
        await assert.rejects(overflowIt.next(), (err) => {
          assert.equal(err.code, 'QUEUE_OVERFLOW', 'R3 overflow has a stable code');
          assert.match(err.message, /frame queue exceeded/i);
          return true;
        });
        assert.equal(overflowState.req.destroyed, true, 'R3 overflow destroys the upstream request');
        assert.ok(overflowRes.pauseCalls >= 1, 'R3 overflow paused at the high-water mark');
        assert.ok(healthyRes.paused, 'R3 healthy control still paused after the overflow');
        assert.equal(healthyState.emitted - healthyState.delivered, 7, 'R3 healthy control queue unchanged');

        let healthyDone = false;
        while (!healthyDone) {
          const step = await healthyIt.next();
          healthyDone = step.done;
          if (healthyDone) break;
          if (step.value.type === 'content') healthyState.order.push(step.value.text);
        }
        assert.equal(healthyState.order.length, 7, 'R3 healthy control drained all remaining frames');
      });
    }
  });
});

describe('R8 — real Cascade producer through D8 translators', () => {
  async function runRouteArm({ route, marker, iter }) {
    const acct = seedAccount(`R8-${route}-${iter}`);
    const fixture = makeCascadeLs({ marker });
    const before = baselineCounters();
    await withFakeLanguageServer(fixture.handler, async (port) => {
      const ctx = cascadeHandlerContext(port, acct);
      const result = route === 'messages'
        ? await handleMessages(
          { model: CASCADE_MODEL, stream: true, messages: [{ role: 'user', content: `concurrency ${marker}` }] },
          ctx,
        )
        : await handleGemini(
          CASCADE_MODEL,
          { contents: [{ role: 'user', parts: [{ text: `concurrency ${marker}` }] }] },
          ctx,
          { stream: true, alt: null },
        );
      assert.equal(result.status, 200);
      assert.equal(result.stream, true);
      const falseAt = route === 'messages' ? 4 : 1;
      const res = controlledRes({ falseAt });
      const run = result.handler(res);
      await eventually(() => res.falseSignals === 1, { label: `R8 ${route}: first callback held` });
      assert.equal(fixture.state.stepsCalls, 1, `R8 ${route}: exactly one steps poll while held`);
      assert.equal(fixture.state.statusCalls, 0, `R8 ${route}: no status RPC while held`);
      assert.equal(res.writes.length, falseAt, `R8 ${route}: translated writes stop at frame ${falseAt}`);
      await pump(8);
      assert.equal(res.writes.length, falseAt, `R8 ${route}: no write over 8 turns while held`);
      res.emit('drain');
      await withWatchdog(run, 2000, `R8 ${route}: after drain`);
      assert.ok(fixture.state.stepsCalls >= 2, `R8 ${route}: the poll loop resumed`);
      assert.ok(fixture.state.statusCalls >= 1, `R8 ${route}: status RPC followed the settled callback`);
      if (route === 'messages') {
        assertMessagesSuccess(res, `${marker}-A${marker}-B`, `R8 ${route}`);
      } else {
        assertGeminiSuccess(res, `${marker}-A${marker}-B`, `R8 ${route}`);
      }
      assert.equal(inflightOf(acct.id), 0, `R8 ${route}: account released`);
      assert.ok(res.listenerCount('drain') <= 1, `R8 ${route}: no waiter beyond the documented forwarder`);
      await assertCleanBaseline(before, `R8 ${route}`);
    });
  }

  it('3 iterations: N=1 integrated Messages/Gemini + N=4 isolation', async (t) => {
    for (let iter = 1; iter <= ITERATIONS; iter += 1) {
      await t.test(`iteration ${iter}`, async () => {
        await withEnv({ DEVIN_CONNECT: undefined }, async () => {
          try {
            await runRouteArm({ route: 'messages', marker: 'R8-S0', iter });
            removeSeeded();
            await runRouteArm({ route: 'gemini', marker: 'R8-S0', iter });
            removeSeeded();

            for (const route of ['messages', 'gemini']) {
              const accounts = Array.from({ length: 4 }, (_, i) => seedAccount(`R8-${route}-n4-${iter}-${i}`));
              const fixtures = Array.from({ length: 4 }, (_, i) => makeCascadeLs({ marker: `R8-S${i}` }));
              const before = baselineCounters();
              await withFakeLanguageServers(fixtures.map((f) => () => f), async (ports) => {
                const results = [];
                for (let i = 0; i < 4; i += 1) {
                  const ctx = cascadeHandlerContext(ports[i], accounts[i]);
                  results.push(route === 'messages'
                    ? await handleMessages(
                      { model: CASCADE_MODEL, stream: true, messages: [{ role: 'user', content: `concurrency R8-S${i}` }] },
                      ctx,
                    )
                    : await handleGemini(
                      CASCADE_MODEL,
                      { contents: [{ role: 'user', parts: [{ text: `concurrency R8-S${i}` }] }] },
                      ctx,
                      { stream: true, alt: null },
                    ));
                }
                const falseAt = route === 'messages' ? 4 : 1;
                const responses = results.map((_, i) => controlledRes(
                  i === 0 ? { falseAt } : { autoDrain: true },
                ));
                const runs = results.map((r, i) => {
                  assert.equal(r.status, 200);
                  return r.handler(responses[i]);
                });
                await eventually(() => responses[0].falseSignals === 1, {
                  label: `R8 ${route} N=4: slow stream held`,
                });
                const survivors = await withWatchdog(
                  Promise.allSettled(runs.slice(1)), 2000, `R8 ${route} N=4 survivors`,
                );
                for (const [i, outcome] of survivors.entries()) {
                  assert.equal(outcome.status, 'fulfilled', `R8 ${route} survivor ${i + 1}`);
                  const marker = `R8-S${i + 1}`;
                  if (route === 'messages') assertMessagesSuccess(responses[i + 1], `${marker}-A${marker}-B`, `R8 ${route} S${i + 1}`);
                  else assertGeminiSuccess(responses[i + 1], `${marker}-A${marker}-B`, `R8 ${route} S${i + 1}`);
                }
                responses[0].emit('drain');
                await withWatchdog(runs[0], 2000, `R8 ${route} N=4 slow stream`);
                if (route === 'messages') assertMessagesSuccess(responses[0], 'R8-S0-AR8-S0-B', 'R8 messages S0');
                else assertGeminiSuccess(responses[0], 'R8-S0-AR8-S0-B', 'R8 gemini S0');
                for (let i = 0; i < 4; i += 1) {
                  assert.equal(fixtures[i].state.startCalls, 1, `R8 ${route} S${i}: one StartCascade`);
                  assert.equal(fixtures[i].state.sendCalls, 1, `R8 ${route} S${i}: one Send`);
                  assert.ok(fixtures[i].state.stepsCalls >= 2, `R8 ${route} S${i}: its own poll loop ran`);
                }
                assert.equal(totalInflight(accounts.map((a) => a.id)), 0);
                await assertCleanBaseline(before, `R8 ${route} N=4`);
              });
              removeSeeded();
            }
          } finally {
            removeSeeded();
          }
        });
      });
    }
  });
});

describe('R14 — D8 half-open timeouts and close/timeout isolation', () => {
  it('3 iterations: Connect Chat, Messages/Gemini Connect producers, Messages/Gemini Cascade producers', async (t) => {
    for (let iter = 1; iter <= ITERATIONS; iter += 1) {
      await t.test(`iteration ${iter}`, async () => {
        await withEnv({ WINDSURFAPI_MAX_DRAIN_MS: '25' }, async () => {
          // Connect Chat: exactly one typed DRAIN_TIMEOUT, no DONE; healthy pair completes.
          try {
            const accounts = Array.from({ length: 2 }, (_, i) => seedAccount(`R14-chat-${iter}-${i}`));
            let started = 0;
            installConnectUpstream({ onStart: () => { started += 1; } });
            const results = [];
            for (let i = 0; i < 2; i += 1) {
              results.push(await handleChatCompletions(connectBody(`R14-S${i}`), {
                callerKey: `session:R14:S${i}`,
              }));
            }
            const timed = controlledRes({ falseAt: 2 });
            const healthy = controlledRes({ autoDrain: true });
            const runTimed = results[0].handler(timed);
            const runHealthy = results[1].handler(healthy);
            await eventually(() => started === 2, { label: 'R14 Connect: both admitted' });
            await withWatchdog(runTimed, 2000, 'R14 Connect timeout');
            const errors = sseChunks(timed).filter((c) => c.error);
            assert.equal(errors.length, 1, 'R14 Connect: exactly one typed error');
            assert.equal(errors[0].error.code, 'DRAIN_TIMEOUT');
            assert.equal(countOf(wireText(timed), 'data: [DONE]'), 0, 'R14 Connect: no DONE');
            await withWatchdog(runHealthy, 2000, 'R14 Connect healthy pair');
            assertOpenAISuccess(healthy, 'R14-S1-AR14-S1-B', 'R14 Connect healthy');
            assert.equal(totalInflight(accounts.map((a) => a.id)), 0);
          } finally {
            removeSeeded();
          }

          // Messages/Gemini with a Connect producer: timeout must not emit a success terminal.
          for (const route of ['messages', 'gemini']) {
            try {
              const accounts = Array.from({ length: 2 }, (_, i) => seedAccount(`R14-${route}-${iter}-${i}`));
              let started = 0;
              const pulled = new Map();
              installConnectUpstream({
                onStart: (base) => { started += 1; pulled.set(base, []); },
                onPull: (kind, base) => pulled.get(base)?.push(kind),
              });
              const results = [];
              for (let i = 0; i < 2; i += 1) {
                results.push(route === 'messages'
                  ? await handleMessages(messagesBody(`R14-S${i}`), { callerKey: `session:R14M:S${i}` })
                  : await handleGemini(MODEL, geminiBody(`R14-S${i}`), { callerKey: `session:R14G:S${i}` }, { stream: true, alt: null }));
              }
              const falseAt = route === 'messages' ? 4 : 1;
              const timed = controlledRes({ falseAt });
              const healthy = controlledRes({ autoDrain: true });
              const runTimed = results[0].handler(timed);
              const runHealthy = results[1].handler(healthy);
              await eventually(() => started === 2, { label: `R14 ${route}: both admitted` });
              await withWatchdog(runTimed, 2000, `R14 ${route} timeout`);
              if (route === 'messages') {
                assert.equal(anthropicEvents(timed).filter((e) => e.event === 'message_stop').length, 0,
                  'R14 Messages: no message_stop on timeout');
                assertMessagesSuccess(healthy, 'R14-S1-AR14-S1-B', 'R14 Messages healthy');
              } else {
                assert.equal(geminiFrames(timed).filter((f) => f.candidates?.[0]?.finishReason === 'STOP').length, 0,
                  'R14 Gemini: no successful STOP on timeout');
                assertGeminiSuccess(healthy, 'R14-S1-AR14-S1-B', 'R14 Gemini healthy');
              }
              assert.ok(pulled.get('R14-S0').length >= 1, `R14 ${route}: producer was pulled`);
              assert.ok(!pulled.get('R14-S0').includes('B'), `R14 ${route}: producer stopped before B`);
              assert.ok(timed.listenerCount('drain') <= 1, `R14 ${route}: no transient waiter beyond the documented forwarder`);
              assert.ok(timed.drainListenerPeak <= 2, `R14 ${route}: at most forwarder + one waiter`);
              assert.equal(totalInflight(accounts.map((a) => a.id)), 0);
            } finally {
              removeSeeded();
            }
          }

          // Messages/Gemini with a Cascade producer: same timeout contract.
          for (const route of ['messages', 'gemini']) {
            await withEnv({ DEVIN_CONNECT: undefined }, async () => {
              try {
                const accounts = Array.from({ length: 2 }, (_, i) => seedAccount(`R14C-${route}-${iter}-${i}`));
                const ctxs = [0, 1].map((i) => cascadeContextFor({
                  a: `R14-S${i}-A`, b: `R14-S${i}-B`,
                }));
                const body = route === 'messages'
                  ? { model: CASCADE_MODEL, stream: true, messages: [{ role: 'user', content: 'concurrency R14-S0' }] }
                  : { contents: [{ role: 'user', parts: [{ text: 'concurrency R14-S0' }] }] };
                const results = [];
                for (let i = 0; i < 2; i += 1) {
                  const b = route === 'messages'
                    ? { ...body, messages: [{ role: 'user', content: `concurrency R14-S${i}` }] }
                    : { contents: [{ role: 'user', parts: [{ text: `concurrency R14-S${i}` }] }] };
                  results.push(route === 'messages'
                    ? await handleMessages(b, ctxs[i])
                    : await handleGemini(CASCADE_MODEL, b, ctxs[i], { stream: true, alt: null }));
                }
                const falseAt = route === 'messages' ? 4 : 1;
                const timed = controlledRes({ falseAt });
                const healthy = controlledRes({ autoDrain: true });
                const runTimed = results[0].handler(timed);
                const runHealthy = results[1].handler(healthy);
                await withWatchdog(runTimed, 2000, `R14 Cascade ${route} timeout`);
                if (route === 'messages') {
                  assert.equal(anthropicEvents(timed).filter((e) => e.event === 'message_stop').length, 0,
                    'R14 Cascade Messages: no message_stop on timeout');
                  assertMessagesSuccess(healthy, 'R14-S1-AR14-S1-B', 'R14 Cascade Messages healthy');
                } else {
                  assert.equal(geminiFrames(timed).filter((f) => f.candidates?.[0]?.finishReason === 'STOP').length, 0,
                    'R14 Cascade Gemini: no successful STOP on timeout');
                  assertGeminiSuccess(healthy, 'R14-S1-AR14-S1-B', 'R14 Cascade Gemini healthy');
                }
                assert.equal(ctxs[0].progress.completed, 0, `R14 Cascade ${route}: producer not completed`);
                assert.ok(timed.listenerCount('drain') <= 1, `R14 Cascade ${route}: no transient waiter beyond the documented forwarder`);
                assert.ok(timed.drainListenerPeak <= 2, `R14 Cascade ${route}: at most forwarder + one waiter`);
                assert.equal(totalInflight(accounts.map((a) => a.id)), 0);
              } finally {
                removeSeeded();
              }
            });
          }
        });
      });
    }
  });
});

describe('R5 — abort half of N after emitted content', () => {
  it('3 iterations: Connect N=4 and Cascade N=4, plus a hung Connect transport', async (t) => {
    for (let iter = 1; iter <= ITERATIONS; iter += 1) {
      await t.test(`iteration ${iter}`, async () => {
        // Connect: S0/S1 abort after A; S2/S3 survive; S4 is a hung upstream.
        const responses = [];
        const runs = [];
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        try {
          const accounts = Array.from({ length: 5 }, (_, i) => seedAccount(`R5-connect-${iter}-${i}`));
          const ids = accounts.map((a) => a.id);
          const before = baselineCounters();
          let started = 0;
          const aborted = new Set();
          installConnectUpstream({
            gateAfterA: gate,
            hangFor: (base) => base === 'R5-S4',
            onStart: () => { started += 1; },
            onAbort: (base) => aborted.add(base),
          });
          const bodies = ['R5-S0', 'R5-S1', 'R5-S2', 'R5-S3'];
          const results = [];
          for (const body of bodies) {
            results.push(await handleChatCompletions(connectBody(body), {
              callerKey: `session:${body}`,
            }));
          }
          responses.push(...results.map(() => controlledRes()));
          for (const [i, result] of results.entries()) {
            assert.equal(result.status, 200);
            runs.push(result.handler(responses[i]));
          }
          await eventually(() => started === 4, { label: 'R5 Connect: 4 producers admitted' });
          await eventually(() => bodies.every((b, i) => wireText(responses[i]).includes(`${b}-A`)), {
            label: 'R5 Connect: every stream emitted A',
          });
          responses[0].emit('close');
          responses[1].emit('close');
          await withWatchdog(Promise.allSettled(runs.slice(0, 2)), 2000, 'R5 Connect aborts');
          for (const i of [0, 1]) {
            assert.deepEqual(afterCloseWrites(responses[i]), [],
              `R5 Connect S${i}: no post-close bytes`);
            assert.equal(countOf(wireText(responses[i]), `R5-S${i}-B`), 0, `R5 Connect S${i}: no B after abort`);
            assert.equal(openaiTerminals(responses[i]).length, 0, `R5 Connect S${i}: no success terminal`);
            assert.equal(countOf(wireText(responses[i]), 'data: [DONE]'), 0, `R5 Connect S${i}: no DONE`);
            assert.ok(aborted.has(`R5-S${i}`), `R5 Connect S${i}: transport observed cancellation`);
          }
          assert.equal(started, 4, 'R5 Connect: no failover after abort');
          assert.equal(totalInflight(ids), 2, 'R5 Connect: only the two survivors still hold slots');
          release();
          const survivors = await withWatchdog(Promise.allSettled(runs.slice(2)), 2000, 'R5 Connect survivors');
          for (const [i, outcome] of survivors.entries()) {
            assert.equal(outcome.status, 'fulfilled', `R5 Connect survivor ${i + 2}`);
            assertOpenAISuccess(responses[i + 2], `R5-S${i + 2}-AR5-S${i + 2}-B`, `R5 Connect S${i + 2}`);
          }

          // Hung upstream: no bytes at all; closing the client must cancel the transport.
          const hung = await handleChatCompletions(connectBody('R5-S4'), {
            callerKey: 'session:R5:S4',
          });
          assert.equal(hung.status, 200);
          const hungRes = controlledRes();
          const hungRun = hung.handler(hungRes);
          responses.push(hungRes);
          runs.push(hungRun);
          await eventually(() => started === 5, { label: 'R5 hung upstream started' });
          hungRes.emit('close');
          await withWatchdog(hungRun, 2000, 'R5 hung handler');
          assert.equal(hungRes.writes.length, 0, 'R5 hung: no bytes');
          assert.ok(aborted.has('R5-S4'), 'R5 hung: transport saw cancellation');
          assert.equal(totalInflight(ids), 0, 'R5 Connect: every account released');
          await assertCleanBaseline(before, `R5 Connect i${iter}`);
        } finally {
          release();
          for (const response of responses) {
            if (!response.closed && !response.writableEnded) response.emit('close');
          }
          try {
            await withWatchdog(Promise.allSettled(runs), 2000, 'R5 Connect fixture cleanup');
          } finally {
            removeSeeded();
          }
        }

        // Cascade: S0/S1 abort after A; S2/S3 survive; aborted turns do no metadata RPC.
        await withEnv({ DEVIN_CONNECT: undefined }, async () => {
          try {
            const accounts = Array.from({ length: 4 }, (_, i) => seedAccount(`R5-cascade-${iter}-${i}`));
            const ids = accounts.map((a) => a.id);
            const fixtures = Array.from({ length: 4 }, (_, i) => makeCascadeLs({ marker: `R5-S${i}` }));
            const before = baselineCounters();
            await withFakeLanguageServers(fixtures.map((f) => () => f), async (ports) => {
              const results = [];
              for (let i = 0; i < 4; i += 1) {
                results.push(await handleChatCompletions({
                  model: CASCADE_MODEL,
                  messages: [{ role: 'user', content: `concurrency R5-S${i}` }],
                  stream: true,
                }, cascadeHandlerContext(ports[i], accounts[i])));
              }
              const responses = results.map((_, i) => controlledRes(
                i < 2 ? { closeAfterWrites: 2 } : {},
              ));
              const runs = results.map((r, i) => {
                assert.equal(r.status, 200);
                return r.handler(responses[i]);
              });
              await withWatchdog(Promise.allSettled(runs), 3000, 'R5 Cascade all handlers');
              for (const i of [0, 1]) {
                assert.deepEqual(afterCloseWrites(responses[i]), [],
                  `R5 Cascade S${i}: no post-close bytes`);
                assert.equal(countOf(wireText(responses[i]), `"finish_reason":"stop"`), 0,
                  `R5 Cascade S${i}: no success terminal`);
                assert.equal(fixtures[i].state.metadataCalls, 0,
                  `R5 Cascade S${i}: no metadata RPC for an aborted turn`);
                assert.equal(fixtures[i].state.startCalls, 1, `R5 Cascade S${i}: one StartCascade`);
                assert.equal(fixtures[i].state.sendCalls, 1, `R5 Cascade S${i}: one Send`);
              }
              for (const i of [2, 3]) {
                assert.equal(openaiContent(responses[i]), `R5-S${i}-AR5-S${i}-B`,
                  `R5 Cascade S${i}: A+B exactly once`);
                assert.equal(openaiTerminals(responses[i]).length, 1, `R5 Cascade S${i}: one terminal`);
                assert.ok(fixtures[i].state.metadataCalls >= 1, `R5 Cascade S${i}: metadata ran`);
              }
              assert.equal(totalInflight(ids), 0, 'R5 Cascade: every account released');
              assert.equal(pool.poolStats().size, 0, 'R5 Cascade: no conversation pool commit');
              assert.equal(cache.cacheStats().stores, before.cacheStores, 'R5 Cascade: no cache store');
            });
          } finally {
            removeSeeded();
          }
        });
      });
    }
  });
});

// ── R6 — disconnect while each writer is parked ─────────────
describe('R6 — disconnect while each writer is parked', () => {
  async function runPair({ label, makeResult, makeResponse, assertSuccess, extraClose = null }) {
    const [a, b] = [makeResult(), makeResult()];
    const resA = makeResponse();
    const resB = makeResponse();
    let settledA = false;
    let settledB = false;
    const runA = a.result.handler(resA).then(() => { settledA = true; });
    const runB = b.result.handler(resB).then(() => { settledB = true; });
    await eventually(() => resA.falseSignals === 1 && resB.falseSignals === 1, {
      label: `${label}: both writers parked`,
    });
    assert.equal(settledA, false, `${label}: closed arm still parked`);
    assert.equal(settledB, false, `${label}: surviving arm still parked`);
    const frozenA = resA.writes.length;
    const frozenB = resB.writes.length;

    resA.emit('close');
    await withWatchdog(runA, 2000, `${label}: closed arm settles`);
    assert.equal(resA.writes.length, frozenA, `${label}: closed arm wrote after close`);
    assert.deepEqual(afterCloseWrites(resA), [], `${label}: closed arm has no post-close bytes`);
    assert.equal(resB.writes.length, frozenB, `${label}: closing one response must not settle the other`);
    assert.equal(settledB, false, `${label}: survivor still parked`);
    if (extraClose) extraClose(resA);

    resB.emit('drain');
    await withWatchdog(runB, 2000, `${label}: survivor after drain`);
    assertSuccess(resB);
    return { resA, resB };
  }

  it('3 iterations: 2 direct Connect, 2 direct Cascade, 2 Messages, 2 Gemini', async (t) => {
    for (let iter = 1; iter <= ITERATIONS; iter += 1) {
      await t.test(`iteration ${iter}`, async () => {
        // Direct Connect pair.
        try {
          const accounts = Array.from({ length: 2 }, (_, i) => seedAccount(`R6-connect-${iter}-${i}`));
          installConnectUpstream({});
          const results = [];
          for (let i = 0; i < 2; i += 1) {
            results.push(await handleChatCompletions(connectBody(`R6-S${i}`), {
              callerKey: `session:R6:S${i}`,
            }));
          }
          await runPair({
            label: 'R6 Connect',
            makeResult: () => ({ result: results.shift() }),
            makeResponse: () => controlledRes({ falseAt: 2 }),
            assertSuccess: (res) => assertOpenAISuccess(res, 'R6-S1-AR6-S1-B', 'R6 Connect survivor'),
            extraClose: (res) => {
              assert.equal(countOf(wireText(res), 'data: [DONE]'), 0, 'R6 Connect closed: no DONE');
              assert.equal(openaiTerminals(res).length, 0, 'R6 Connect closed: no success terminal');
            },
          });
          assert.equal(totalInflight(accounts.map((a) => a.id)), 0);
          removeSeeded();
        } finally {
          removeSeeded();
        }

        // Direct Cascade pair.
        await withEnv({ DEVIN_CONNECT: undefined }, async () => {
          try {
            const accounts = Array.from({ length: 2 }, (_, i) => seedAccount(`R6-cascade-${iter}-${i}`));
            const ctxA = cascadeContextFor({ a: 'R6-S0-A', b: 'R6-S0-B' });
            const ctxB = cascadeContextFor({ a: 'R6-S1-A', b: 'R6-S1-B' });
            const body = (i) => ({
              model: CASCADE_MODEL,
              messages: [{ role: 'user', content: `concurrency R6-S${i}` }],
              stream: true,
            });
            const rA = await handleChatCompletions(body(0), ctxA);
            const rB = await handleChatCompletions(body(1), ctxB);
            let settledA = false;
            let settledB = false;
            const resA = controlledRes({ falseAt: 2 });
            const resB = controlledRes({ falseAt: 2 });
            const runA = rA.handler(resA).then(() => { settledA = true; });
            const runB = rB.handler(resB).then(() => { settledB = true; });
            await eventually(() => resA.falseSignals === 1 && resB.falseSignals === 1, {
              label: 'R6 Cascade: both parked',
            });
            resA.emit('close');
            await withWatchdog(runA, 2000, 'R6 Cascade closed arm');
            assert.deepEqual(afterCloseWrites(resA), []);
            assert.equal(countOf(wireText(resA), '"finish_reason":"stop"'), 0);
            assert.equal(ctxA.progress.completed, 0, 'R6 Cascade: closed producer not completed');
            assert.equal(resB.writes.length, 2, 'R6 Cascade: survivor still parked');
            assert.equal(settledB, false);
            resB.emit('drain');
            await withWatchdog(runB, 2000, 'R6 Cascade survivor');
            assert.equal(openaiContent(resB), 'R6-S1-AR6-S1-B');
            assert.equal(openaiTerminals(resB).length, 1);
            assert.equal(pool.poolStats().size, 0);
            assert.equal(totalInflight(accounts.map((a) => a.id)), 0);
          } finally {
            removeSeeded();
          }
        });

        // Messages pair.
        try {
          const accounts = Array.from({ length: 2 }, (_, i) => seedAccount(`R6-messages-${iter}-${i}`));
          let started = 0;
          const pulled = new Map();
          installConnectUpstream({
            onStart: (base) => { started += 1; pulled.set(base, []); },
            onPull: (kind, base) => pulled.get(base)?.push(kind),
          });
          const results = [];
          for (let i = 0; i < 2; i += 1) {
            results.push(await handleMessages(messagesBody(`R6-S${i}`), {
              callerKey: `session:R6M:S${i}`,
            }));
          }
          const resA = controlledRes({ falseAt: 4 });
          const resB = controlledRes({ falseAt: 4 });
          let settledA = false;
          let settledB = false;
          const runA = results[0].handler(resA).then(() => { settledA = true; });
          const runB = results[1].handler(resB).then(() => { settledB = true; });
          await eventually(() => resA.falseSignals === 1 && resB.falseSignals === 1, {
            label: 'R6 Messages: both parked',
          });
          resA.emit('close');
          await withWatchdog(runA, 2000, 'R6 Messages closed arm');
          assert.equal(resA.writes.length, 4, 'R6 Messages: closed writes frozen at 4');
          assert.equal(anthropicEvents(resA).filter((e) => e.event === 'message_stop').length, 0);
          assert.deepEqual(pulled.get('R6-S0'), ['A'], 'R6 Messages: closed producer not pulled past the held callback');
          assert.equal(resB.writes.length, 4, 'R6 Messages: survivor still parked');
          assert.equal(settledB, false);
          resB.emit('drain');
          await withWatchdog(runB, 2000, 'R6 Messages survivor');
          assertMessagesSuccess(resB, 'R6-S1-AR6-S1-B', 'R6 Messages survivor');
          assert.equal(totalInflight(accounts.map((a) => a.id)), 0);
          removeSeeded();
        } finally {
          removeSeeded();
        }

        // Gemini pair.
        try {
          const accounts = Array.from({ length: 2 }, (_, i) => seedAccount(`R6-gemini-${iter}-${i}`));
          let started = 0;
          const pulled = new Map();
          installConnectUpstream({
            onStart: (base) => { started += 1; pulled.set(base, []); },
            onPull: (kind, base) => pulled.get(base)?.push(kind),
          });
          const results = [];
          for (let i = 0; i < 2; i += 1) {
            results.push(await handleGemini(
              MODEL, geminiBody(`R6-S${i}`), { callerKey: `session:R6G:S${i}` },
              { stream: true, alt: null },
            ));
          }
          const resA = controlledRes({ falseAt: 1 });
          const resB = controlledRes({ falseAt: 1 });
          let settledA = false;
          let settledB = false;
          const runA = results[0].handler(resA).then(() => { settledA = true; });
          const runB = results[1].handler(resB).then(() => { settledB = true; });
          await eventually(() => resA.falseSignals === 1 && resB.falseSignals === 1, {
            label: 'R6 Gemini: both parked',
          });
          resA.emit('close');
          await withWatchdog(runA, 2000, 'R6 Gemini closed arm');
          assert.equal(resA.writes.length, 1, 'R6 Gemini: closed writes frozen at 1');
          assert.equal(countOf(wireText(resA), '"finishReason":"STOP"'), 0);
          assert.deepEqual(pulled.get('R6-S0'), ['A'], 'R6 Gemini: closed producer not pulled past the held callback');
          assert.equal(resB.writes.length, 1, 'R6 Gemini: survivor still parked');
          assert.equal(settledB, false);
          resB.emit('drain');
          await withWatchdog(runB, 2000, 'R6 Gemini survivor');
          assertGeminiSuccess(resB, 'R6-S1-AR6-S1-B', 'R6 Gemini survivor');
          assert.equal(totalInflight(accounts.map((a) => a.id)), 0);
          removeSeeded();
        } finally {
          removeSeeded();
        }
      });
    }
  });
});

