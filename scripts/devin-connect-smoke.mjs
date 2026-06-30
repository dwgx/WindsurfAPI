#!/usr/bin/env node
/**
 * DEVIN_CONNECT smoke — end-to-end check of the direct cloud GetChatMessage
 * adapter through the public OpenAI/Anthropic surfaces.
 *
 * Stages:
 *   0. Entitlement preflight (zero-billable): GetUserStatus + GetCliModelConfigs
 *      via the direct catalog probe. Prints the account tier and the selectors
 *      it can name. No chat turn, so no allowance is spent.
 *   0c. Recovery-chain preflight (zero-billable): liveness probe agrees with
 *      preflight; encrypted credential store roundtrips with no plaintext on
 *      disk; auto-relogin/liveness-sweep config is reported (and the half-armed
 *      "relogin on, no key" case is flagged).
 *   1. /v1/chat/completions non-stream on the free selector (swe-1-6-slow).
 *   2. /v1/chat/completions streaming — SSE deltas + [DONE].
 *   3. Multi-turn — prior assistant turn is honored.
 *   4. /v1/messages (Anthropic dialect) over the same connect backend.
 *   5. Error classification — a paid selector on a free account must surface a
 *      clean 402/401 (MODEL_BLOCKED/UNAUTHORIZED), not an opaque 500.
 *
 * Paid-account verification (#15): set CONNECT_SMOKE_PAID_MODEL=claude-opus-4.8
 * (or any paid selector). On a paid account stage 5 flips to expect a 200 with
 * real content — the one-command confirmation that paid routing works.
 *
 * Env:
 *   BASE_URL                       server base (default http://127.0.0.1:3003)
 *   API_KEY                        downstream auth (default 'test')
 *   CONNECT_SMOKE_TOKEN            devin session token for the direct preflight;
 *                                  falls back to accounts.json[0] then DEVIN_* env
 *   CONNECT_SMOKE_FREE_MODEL       free selector (default swe-1-6-slow)
 *   CONNECT_SMOKE_PAID_MODEL       paid selector to probe (default claude-opus-4.8)
 *   CONNECT_SMOKE_REAL_CALLS=0     skip billable chat stages (preflight only)
 *   CONNECT_SMOKE_TIMEOUT_MS       per-request timeout (default 120000)
 */

import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fetchCatalog, fetchUserStatus, checkSessionLiveness } from '../src/devin-connect-catalog.js';
import { storeCredential, getCredential } from '../src/devin-connect-credentials.js';
import { resolveConnectSelector } from '../src/devin-connect-models.js';

const baseUrl = (process.env.BASE_URL || process.env.WINDSURFAPI_BASE_URL || 'http://127.0.0.1:3003').replace(/\/+$/, '');
const apiKey = process.env.API_KEY || process.env.WINDSURFAPI_API_KEY || 'test';
const freeModel = process.env.CONNECT_SMOKE_FREE_MODEL || 'swe-1-6-slow';
const paidModel = process.env.CONNECT_SMOKE_PAID_MODEL || 'claude-opus-4.8';
const realCalls = process.env.CONNECT_SMOKE_REAL_CALLS !== '0';
const requestTimeoutMs = Math.max(5_000, Number(process.env.CONNECT_SMOKE_TIMEOUT_MS || 120_000));

function resolveToken() {
  if (process.env.CONNECT_SMOKE_TOKEN) return process.env.CONNECT_SMOKE_TOKEN;
  for (const k of ['DEVIN_CONNECT_TOKEN', 'DEVIN_SESSION_TOKEN', 'WINDSURF_SESSION_TOKEN']) {
    if (process.env[k]) return process.env[k];
  }
  // Last resort: first persisted account (local dev convenience).
  try {
    const accounts = JSON.parse(readFileSync(new URL('../accounts.json', import.meta.url), 'utf8'));
    const a = accounts.find((x) => String(x.apiKey || '').startsWith('devin-session-token$'));
    if (a) return a.apiKey;
  } catch { /* none */ }
  return '';
}

function compact(text, max = 600) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}...<+${s.length - max}>` : s;
}

async function postJson(path, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    return { status: res.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

async function postSSE(path, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  const dataLines = [];
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(payload),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      return { status: res.status, dataLines, error: text };
    }
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
    }
    return { status: res.status, dataLines };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
function record(stage, ok, detail) {
  results.push({ stage, ok, ...detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${stage}${detail?.note ? ` — ${detail.note}` : ''}`);
}

// ─── Stage 0: entitlement preflight (zero-billable) ─────────────────────────
const token = resolveToken();
let isPaid = false;
let liveCatalog = null;
if (!token) {
  record('preflight', false, { note: 'no devin session token (set CONNECT_SMOKE_TOKEN or persist an account)' });
} else {
  try {
    const status = await fetchUserStatus({ token });
    isPaid = status.isPaid;
    const catalog = await fetchCatalog({ token });
    liveCatalog = catalog;
    const byProvider = catalog.reduce((acc, m) => { (acc[m.provider] ||= []).push(m.selector); return acc; }, {});
    record('preflight', true, {
      note: `tier=${status.plan} paid=${status.isPaid} models=${catalog.length}`,
      plan: status.plan,
      isPaid: status.isPaid,
      providers: Object.fromEntries(Object.entries(byProvider).map(([p, s]) => [p, s.length])),
    });
  } catch (err) {
    record('preflight', false, { note: `${err.code || 'ERR'}: ${err.message}` });
  }
}

// ─── Stage 0b: catalog drift diff (zero-billable) ───────────────────────────
// Compare the LIVE catalog against the committed snapshot + the resolver. New
// or renamed selectors that the SELECTOR_MAP can't resolve are surfaced here so
// the map + fixture get refreshed before a client silently degrades to free.
if (liveCatalog) {
  try {
    const snap = JSON.parse(readFileSync(new URL('../test/fixtures/devin-catalog-snapshot.json', import.meta.url), 'utf8'));
    const snapSelectors = new Set(snap.models.map((m) => m.selector));
    const liveSelectors = new Set(liveCatalog.map((m) => m.selector));
    const added = [...liveSelectors].filter((s) => !snapSelectors.has(s));
    const removed = [...snapSelectors].filter((s) => !liveSelectors.has(s));
    // Resolvability: every live selector AND its advertised alias must map
    // without degrading to the free default.
    const unresolved = [];
    for (const m of liveCatalog) {
      for (const name of [m.selector, m.alias].filter(Boolean)) {
        const { mapped } = resolveConnectSelector(name);
        if (!mapped) unresolved.push(name);
      }
    }
    const drift = added.length || removed.length || unresolved.length;
    record('catalog-drift', !drift, {
      note: drift
        ? `DRIFT: +${added.length} -${removed.length} unresolved=${unresolved.length} — refresh snapshot + SELECTOR_MAP`
        : `in sync with snapshot (${liveCatalog.length} models, all resolvable)`,
      added, removed, unresolved,
    });
  } catch (err) {
    record('catalog-drift', false, { note: `diff failed: ${err.message}` });
  }
}

// ─── Stage 0c: recovery-chain preflight (zero-billable) ─────────────────────
// Exercises the dead-session_id recovery wiring WITHOUT spending allowance:
//   - checkSessionLiveness on the live token (the same GetUserStatus probe the
//     scheduled liveness sweep uses) must agree with the preflight.
//   - the encrypted credential store roundtrips under an ephemeral key.
//   - the auto-relogin + liveness-probe env flags are reported so an operator
//     can see at a glance whether hands-off recovery is actually armed.
if (token) {
  try {
    const live = await checkSessionLiveness({ token });
    record('liveness', live.alive === true, {
      note: live.alive ? `session alive (plan=${live.plan || '?'})` : `session DEAD (${live.code})`,
      code: live.code,
    });
  } catch (err) {
    record('liveness', false, { note: `probe threw: ${err.message}` });
  }
}
try {
  // Ephemeral key in a temp store so we never touch the real accounts.creds.json.
  const tmp = mkdtempSync(join(tmpdir(), 'connect-smoke-cred-'));
  const prevKey = process.env.DEVIN_CONNECT_CRED_KEY;
  const prevFile = process.env.DEVIN_CONNECT_CRED_FILE;
  process.env.DEVIN_CONNECT_CRED_KEY = 'smoke-ephemeral-key-' + Math.random().toString(36).slice(2);
  process.env.DEVIN_CONNECT_CRED_FILE = join(tmp, 'creds.json');
  storeCredential('smoke@example.com', 's3cret-pw');
  const ok = getCredential('smoke@example.com') === 's3cret-pw';
  const onDisk = readFileSync(process.env.DEVIN_CONNECT_CRED_FILE, 'utf8');
  const leaks = onDisk.includes('s3cret-pw');
  record('cred-store', ok && !leaks, {
    note: ok && !leaks ? 'roundtrip OK, plaintext absent from disk' : `roundtrip=${ok} leaked=${leaks}`,
  });
  rmSync(tmp, { recursive: true, force: true });
  if (prevKey === undefined) delete process.env.DEVIN_CONNECT_CRED_KEY; else process.env.DEVIN_CONNECT_CRED_KEY = prevKey;
  if (prevFile === undefined) delete process.env.DEVIN_CONNECT_CRED_FILE; else process.env.DEVIN_CONNECT_CRED_FILE = prevFile;
} catch (err) {
  record('cred-store', false, { note: `store failed: ${err.message}` });
}
{
  const autoRelogin = process.env.DEVIN_CONNECT_AUTO_RELOGIN === '1';
  const livenessSweep = process.env.DEVIN_CONNECT_LIVENESS_PROBE === '1';
  const credKeySet = !!process.env.DEVIN_CONNECT_CRED_KEY;
  const armed = autoRelogin && credKeySet;
  // Informational, not a hard fail: recovery is opt-in. We only flag the
  // half-configured case (relogin on, no key) since that silently can't work.
  record('recovery-config', !(autoRelogin && !credKeySet), {
    note: armed
      ? 'hands-off recovery ARMED (auto-relogin + cred key + ' + (livenessSweep ? 'liveness sweep on)' : 'sweep OFF)')
      : `auto-relogin=${autoRelogin} cred-key=${credKeySet} liveness-sweep=${livenessSweep}`,
  });
}

// ─── Billable chat stages ───────────────────────────────────────────────────
if (!realCalls) {
  console.log('\n[skip] CONNECT_SMOKE_REAL_CALLS=0 — chat stages skipped (preflight only).');
} else {
  // Stage 1: non-stream
  const r1 = await postJson('/v1/chat/completions', {
    model: freeModel, stream: false,
    messages: [{ role: 'user', content: 'reply with exactly: CONNECT_OK' }],
  });
  const c1 = r1.body?.choices?.[0]?.message?.content;
  record('non-stream', r1.status === 200 && /CONNECT_OK/i.test(c1 || ''), {
    note: `status=${r1.status} content="${compact(c1, 80)}"`,
    usage: r1.body?.usage,
  });

  // Stage 2: streaming
  const r2 = await postSSE('/v1/chat/completions', {
    model: freeModel, stream: true,
    messages: [{ role: 'user', content: 'count: one two three' }],
  });
  const deltas = r2.dataLines.filter((l) => l && l !== '[DONE]');
  const sawDone = r2.dataLines.includes('[DONE]');
  record('stream', r2.status === 200 && deltas.length > 0 && sawDone, {
    note: `status=${r2.status} deltas=${deltas.length} done=${sawDone}`,
  });

  // Stage 3: multi-turn
  const r3 = await postJson('/v1/chat/completions', {
    model: freeModel, stream: false,
    messages: [
      { role: 'user', content: 'My favorite color is teal. Remember it.' },
      { role: 'assistant', content: 'Got it, teal.' },
      { role: 'user', content: 'What is my favorite color? One word.' },
    ],
  });
  const c3 = r3.body?.choices?.[0]?.message?.content;
  record('multi-turn', r3.status === 200 && /teal/i.test(c3 || ''), {
    note: `status=${r3.status} content="${compact(c3, 80)}"`,
  });

  // Stage 4: Anthropic /v1/messages over the same backend
  const r4 = await postJson('/v1/messages', {
    model: freeModel, max_tokens: 64, stream: false,
    messages: [{ role: 'user', content: 'reply with exactly: MSG_OK' }],
  });
  const c4 = Array.isArray(r4.body?.content) ? r4.body.content.map((b) => b.text).join('') : '';
  record('anthropic-messages', r4.status === 200 && /MSG_OK/i.test(c4 || ''), {
    note: `status=${r4.status} content="${compact(c4, 80)}"`,
  });

  // Stage 5: paid-model behavior. Free account → clean 402/401, not an opaque
  // 5xx. Paid account → 200 with content (the #15 verification).
  const r5 = await postJson('/v1/chat/completions', {
    model: paidModel, stream: false,
    messages: [{ role: 'user', content: 'reply with exactly: PAID_OK' }],
  });
  if (isPaid) {
    const c5 = r5.body?.choices?.[0]?.message?.content;
    record('paid-model', r5.status === 200 && /PAID_OK/i.test(c5 || ''), {
      note: `[PAID ACCOUNT] ${paidModel} status=${r5.status} content="${compact(c5, 80)}"`,
      usage: r5.body?.usage,
    });
  } else {
    const cleanReject = r5.status === 402 || r5.status === 401 || r5.status === 403;
    record('paid-model', cleanReject, {
      note: `[FREE ACCOUNT] ${paidModel} → status=${r5.status} (expected clean 402/401, got error="${compact(r5.body?.error?.message || r5.text, 100)}")`,
    });
  }

  // Stage 6: tool/function calling (text-emulation). Works on the free swe-1.6
  // model — tool defs are injected into the prompt and <tool_call> markup is
  // parsed back into OpenAI tool_calls. A weather query with a tool defined
  // should come back as a tool_calls turn, not a prose answer.
  const weatherTool = [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name' } },
        required: ['city'],
      },
    },
  }];
  const r6 = await postJson('/v1/chat/completions', {
    model: freeModel, stream: false, tools: weatherTool, tool_choice: 'auto',
    messages: [{ role: 'user', content: 'What is the weather in Tokyo right now? Use the tool.' }],
  });
  const m6 = r6.body?.choices?.[0]?.message;
  const tc6 = m6?.tool_calls?.[0];
  const calledWeather = tc6?.function?.name === 'get_weather';
  record('tool-call-nonstream', r6.status === 200 && calledWeather, {
    note: `status=${r6.status} finish=${r6.body?.choices?.[0]?.finish_reason} tool=${tc6?.function?.name || 'none'} args=${compact(tc6?.function?.arguments || '', 60)}`,
  });

  // Stage 7: tool calling over SSE — the parser must surface a tool_calls delta.
  const r7 = await postSSE('/v1/chat/completions', {
    model: freeModel, stream: true, tools: weatherTool, tool_choice: 'auto',
    messages: [{ role: 'user', content: 'Check the weather in Berlin. Use the tool.' }],
  });
  const toolDelta = r7.dataLines
    .filter((l) => l && l !== '[DONE]')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((o) => o?.choices?.[0]?.delta?.tool_calls);
  const streamToolName = toolDelta?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name;
  record('tool-call-stream', r7.status === 200 && streamToolName === 'get_weather', {
    note: `status=${r7.status} streamedTool=${streamToolName || 'none'}`,
  });
}

// ─── Summary ────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n${'─'.repeat(60)}`);
console.log(JSON.stringify({ ok: failed.length === 0, isPaid, stages: results }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
