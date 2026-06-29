#!/usr/bin/env node

const baseUrl = (process.env.BASE_URL || process.env.WINDSURFAPI_BASE_URL || 'http://127.0.0.1:3003').replace(/\/+$/, '');
const apiKey = process.env.API_KEY || process.env.WINDSURFAPI_API_KEY || '';
const model = process.env.MODEL || process.env.SPECIAL_AGENT_SMOKE_MODEL || 'swe-1.6-fast';
const requestTimeoutMs = Math.max(5_000, Number(process.env.SPECIAL_AGENT_SMOKE_TIMEOUT_MS || 180_000));
const requireEnabled = process.env.SPECIAL_AGENT_SMOKE_REQUIRE_ENABLED !== '0';
const prompt = process.env.SPECIAL_AGENT_SMOKE_PROMPT || 'Reply exactly SPECIAL_AGENT_OK.';
// Real-model stages (stream, multi-turn, anthropic) spend free-tier allowance.
// They are ON by default but can be skipped for a zero-billable structural run.
const realCalls = process.env.SPECIAL_AGENT_SMOKE_REAL_CALLS !== '0';

if (!apiKey) {
  console.error('API_KEY is required.');
  process.exit(2);
}

function compactText(text, max = 1200) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}...<truncated ${s.length - max} chars>` : s;
}

function report(out) {
  console.log(JSON.stringify(out, null, 2));
  return out.ok;
}

async function fetchJson(path, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      ...opts,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

// Read an SSE response and collect the raw `data:` payloads plus any
// `event:` names. Returns once the stream ends (terminated by [DONE] for
// OpenAI, message_stop for Anthropic, or socket close).
async function fetchSSE(path, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  const events = [];
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
      return { status: res.status, events, dataLines, error: text };
    }
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (line.startsWith('event:')) events.push(line.slice(6).trim());
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
    }
    return { status: res.status, events, dataLines };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Preflight: backend must be enabled ─────────────────────────────────────
const health = await fetchJson('/health?verbose=1');
const specialAgent = health.body?.specialAgent || null;
if (requireEnabled && !specialAgent?.enabled) {
  report({
    ok: false,
    stage: 'preflight',
    error: 'special-agent backend is disabled',
    specialAgent,
    hint: 'Set WINDSURFAPI_SPECIAL_AGENT_BACKEND=devin-cli and DEVIN_CLI_MODE=print or acp before running this smoke.',
  });
  process.exit(1);
}

const results = [];

// ─── Stage: non-stream chat (real call) ─────────────────────────────────────
{
  const started = Date.now();
  const chat = await fetchJson('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false, max_tokens: 128, messages: [{ role: 'user', content: prompt }] }),
  });
  const content = chat.body?.choices?.[0]?.message?.content || '';
  const ok = chat.status >= 200 && chat.status < 300 && !chat.body?.error;
  results.push(report({
    stage: 'positive_text_chat', ok, model, status: chat.status,
    latencyMs: Date.now() - started, specialAgent,
    content: compactText(content), error: chat.body?.error || null,
  }));
  // The non-stream chat is the baseline — if it fails nothing else is meaningful.
  if (!ok) process.exit(1);
}

// ─── Stage: streaming chat (real call) ──────────────────────────────────────
// Proves real incremental delivery: multiple content deltas, a terminal
// finish_reason, and the [DONE] sentinel.
if (realCalls) {
  const started = Date.now();
  const sse = await fetchSSE('/v1/chat/completions', {
    model, stream: true, max_tokens: 64,
    messages: [{ role: 'user', content: 'Count from 1 to 5, one number per line.' }],
  });
  let deltas = 0, text = '', sawStop = false;
  for (const d of sse.dataLines) {
    if (d === '[DONE]') continue;
    try {
      const obj = JSON.parse(d);
      const choice = obj.choices?.[0];
      if (choice?.delta?.content) { deltas++; text += choice.delta.content; }
      if (choice?.finish_reason === 'stop') sawStop = true;
    } catch {}
  }
  const sawDone = sse.dataLines.includes('[DONE]');
  const ok = sse.status === 200 && deltas >= 1 && sawStop && sawDone;
  results.push(report({
    stage: 'positive_stream_chat', ok, status: sse.status,
    latencyMs: Date.now() - started, deltas, sawStop, sawDone,
    content: compactText(text), error: ok ? undefined : sse.error,
  }));
}

// ─── Stage: multi-turn memory (real call) ───────────────────────────────────
// Feeds a prior turn the agent must use to answer the latest one.
if (realCalls) {
  const started = Date.now();
  const chat = await fetchJson('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, stream: false, max_tokens: 32,
      messages: [
        { role: 'user', content: 'My favorite number is 7. Remember it.' },
        { role: 'assistant', content: 'Got it, your favorite number is 7.' },
        { role: 'user', content: 'Multiply my favorite number by 6. Reply with just the number.' },
      ],
    }),
  });
  const content = chat.body?.choices?.[0]?.message?.content || '';
  const ok = chat.status === 200 && /\b42\b/.test(content);
  results.push(report({
    stage: 'multi_turn_memory', ok, status: chat.status,
    latencyMs: Date.now() - started, expected: '42',
    content: compactText(content), error: chat.body?.error || null,
  }));
}

// ─── Stage: Anthropic /v1/messages streaming (real call) ────────────────────
// Same backend, exercised through the Anthropic SSE translation layer.
if (realCalls) {
  const started = Date.now();
  const sse = await fetchSSE('/v1/messages', {
    model, stream: true, max_tokens: 64,
    messages: [{ role: 'user', content: 'Reply with exactly: ANTHROPIC_PONG' }],
  });
  let text = '';
  for (const d of sse.dataLines) {
    try {
      const obj = JSON.parse(d);
      if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') text += obj.delta.text || '';
    } catch {}
  }
  const sawStart = sse.events.includes('message_start');
  const sawDelta = sse.events.includes('content_block_delta');
  const sawStop = sse.events.includes('message_stop');
  const ok = sse.status === 200 && sawStart && sawDelta && sawStop && text.length > 0;
  results.push(report({
    stage: 'anthropic_messages_stream', ok, status: sse.status,
    latencyMs: Date.now() - started, sawStart, sawDelta, sawStop,
    content: compactText(text), error: ok ? undefined : sse.error,
  }));
}

// ─── Negative stages (free: rejected before any model call) ─────────────────
async function runNegativeSmoke(name, payload, expectedType) {
  const started = Date.now();
  const result = await fetchJson('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const error = result.body?.error || null;
  const ok = result.status === 400 && error?.type === expectedType;
  results.push(report({
    stage: name, result: ok ? 'PASS' : 'FAIL', ok,
    expectedStatus: 400, expectedType, status: result.status,
    latencyMs: Date.now() - started, error,
    body: ok ? undefined : result.body,
    text: ok ? undefined : compactText(result.text),
  }));
}

await runNegativeSmoke('negative_tools', {
  model, stream: false, max_tokens: 128,
  messages: [{ role: 'user', content: 'read package.json' }],
  tools: [{ type: 'function', function: { name: 'Read', description: 'Read tool', parameters: { type: 'object', properties: {} } } }],
}, 'unsupported_tool_boundary');

await runNegativeSmoke('negative_media', {
  model, stream: false, max_tokens: 128,
  messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } }] }],
}, 'unsupported_media');

if (results.some(ok => !ok)) process.exit(1);
