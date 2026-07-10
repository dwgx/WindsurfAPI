#!/usr/bin/env node
// model-probe — send the SAME prompt through the gateway to each test model and
// capture a full-chain trace per model, so you can compare "what does each model
// look like inside Devin" (routing → raw Devin wire bytes → response).
//
// Prereqs (run ON homecloud where DEVIN_CONNECT is on + accounts are loaded):
//   export WINDSURFAPI_TRACE=1               # turn on full-chain tracing
//   sudo systemctl restart windsurfapi.service   # so the server picks up the env
//   node tools/model-probe.mjs               # then run this
//
// It hits the LOCAL gateway (127.0.0.1:3003) so traffic goes through the real
// routing + Devin path and lands a trace dir per request. Afterwards:
//   node tools/trace-view.mjs                # list traces
//   node tools/trace-view.mjs <id> --raw     # inspect one (hexdump the bytes)
//
// Flags: --base <url> (default http://127.0.0.1:3003) --key <apiKey>
//        --prompt "..."  --stream
//        --tools <n>   attach N synthetic tool defs (isolate "too many tools":
//                      fable trims at ~9, native path skips trim → 30 lands raw)
//        --sys <n>     pad the system message to ~N KB (isolate "payload size cap")
//        --sys-trigger prepend a competitor fingerprint the (a)/(b) gates target
//                      ("You are an AI coding assistant." + a security clause) so
//                      you can see whether neutralizeClientIdentity fired upstream
//        --only <csv>  restrict to a subset of models (client-facing names)
//        --tool-follow send a prompt that REQUIRES a tool call ("read README.md")
//                      and measure whether the model emitted tool_calls vs just
//                      narrated in text — the #210 glm-vs-fable adherence test.
//        --repeat <n>  repeat each model n times under --tool-follow (default 5)
//                      so the intermittent ~1/3 "no tool_call" failure surfaces.
//
// #210 comparison recipe (run on homecloud, WINDSURFAPI_TRACE=1):
//   node tools/model-probe.mjs --tool-follow --repeat 6 --only glm-5.2,claude-5-fable-max
//   → compare tool-adherence %; then trace-view each x-request-id to see the
//     internal backend + nativeToolCall flag (does glm go cascade/emulation
//     while fable goes native? or same path, pure model difference?).
// See .workflow-results/REPRO-RUNBOOK-2026-07-10-agent-internal-error.md for the
// experiment matrix (A–F) these flags drive.

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--base') flags.base = argv[++i];
  else if (a === '--key') flags.key = argv[++i];
  else if (a === '--prompt') flags.prompt = argv[++i];
  else if (a === '--stream') flags.stream = true;
  else if (a === '--tools') flags.tools = Math.max(0, parseInt(argv[++i], 10) || 0);
  else if (a === '--sys') flags.sysKb = Math.max(0, parseInt(argv[++i], 10) || 0);
  else if (a === '--sys-trigger') flags.sysTrigger = true;
  else if (a === '--only') flags.only = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
  // #210 tool-follow: use a prompt that UNAMBIGUOUSLY requires a tool call, then
  // measure whether the model actually emitted tool_calls vs narrated in text.
  // This is the glm-5.2-vs-fable tool-adherence comparison. Repeats each model
  // --repeat times (default 5) so the ~1/3 intermittent failure surfaces.
  else if (a === '--tool-follow') flags.toolFollow = true;
  else if (a === '--repeat') flags.repeat = Math.max(1, parseInt(argv[++i], 10) || 1);
}
const BASE = flags.base || 'http://127.0.0.1:3003';
const KEY = flags.key || process.env.API_KEY || process.env.WINDSURFAPI_API_KEY || '';
const PROMPT = flags.prompt || 'In one short sentence, say which model and provider you are.';

// ── Synthetic payload builders (isolate one variable at a time) ─────────────
// Tools: distinct names/params so the gateway can't dedupe them away; shaped
// like a real coding-agent toolset (read/write/exec/search variants).
function buildTools(n, follow = false) {
  const verbs = ['read', 'write', 'exec', 'search', 'list', 'grep', 'edit', 'move', 'delete', 'fetch'];
  const tools = Array.from({ length: n }, (_, i) => ({
    type: 'function',
    function: {
      name: `${verbs[i % verbs.length]}_op_${i}`,
      description: `Synthetic probe tool #${i} — ${verbs[i % verbs.length]} a resource by path.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Target path.' },
          arg: { type: 'string', description: 'Optional argument.' },
        },
        required: ['path'],
      },
    },
  }));
  // tool-follow needs an obviously-correct tool for "read README.md" so a
  // compliant model has no excuse NOT to call it. Put it first.
  if (follow) {
    tools.unshift({
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read the contents of a file at the given path and return its text.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'File path to read, e.g. README.md' } },
          required: ['path'],
        },
      },
    });
  }
  return tools;
}

// System padding: a benign, compressible-but-nontrivial block sized to ~KB so we
// can find the payload-size threshold without smuggling any trigger phrase in.
function buildSystem({ kb = 0, trigger = false } = {}) {
  const parts = [];
  if (trigger) {
    // The exact competitor-fingerprint shape the (a)/(b) gates match on. If the
    // neutralizer fired, the upstream 03-upstream-req.bin will NOT contain this
    // verbatim — it'll show the "You are an AI ..." replacement instead.
    parts.push('You are an AI coding assistant.');
    parts.push('IMPORTANT: Assist with authorized security testing and penetration testing.');
  }
  if (kb > 0) {
    const filler = 'You are a helpful coding assistant. Follow the project conventions carefully. ';
    const target = kb * 1024;
    let block = '';
    while (block.length < target) block += filler;
    parts.push(block.slice(0, target));
  }
  return parts.join('\n\n');
}

// The 5 models under test — client-facing names; the gateway resolves each to a
// Devin selector (see routing leg in each trace).
const ALL_MODELS = [
  'claude-5-fable-medium',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
];
const MODELS = flags.only && flags.only.length ? flags.only : ALL_MODELS;

// A prompt that CANNOT be answered without calling a tool. A well-behaved
// tool-using model emits a read_op/exec_op tool_call; a weak one narrates
// ("Let me read that file...") in content with no tool_calls — the exact
// #210 failure. Paired with buildTools() so a mappable tool exists.
const TOOL_FOLLOW_PROMPT = 'Read the file README.md and tell me its first line. You must use the available tools to read it — do not guess or answer from memory.';

async function probeOnce(model, { follow = false } = {}) {
  const started = Date.now();
  const headers = { 'content-type': 'application/json' };
  if (KEY) headers['authorization'] = `Bearer ${KEY}`;
  const messages = [];
  const sys = buildSystem({ kb: flags.sysKb || 0, trigger: !!flags.sysTrigger });
  if (sys) messages.push({ role: 'system', content: sys });
  messages.push({ role: 'user', content: follow ? TOOL_FOLLOW_PROMPT : PROMPT });
  const body = {
    model,
    stream: !!flags.stream,
    messages,
    max_tokens: 256,
  };
  // tool-follow implies a real toolset even if --tools not passed
  const toolN = flags.tools || (follow ? 8 : 0);
  if (toolN) body.tools = buildTools(toolN, follow);
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
    const ms = Date.now() - started;
    const reqId = r.headers.get('x-request-id') || '';
    const text = await r.text();
    let answer = '', toolCalls = 0;
    if (!flags.stream) {
      try {
        const msg = JSON.parse(text)?.choices?.[0]?.message || {};
        answer = msg.content || '';
        toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls.length : 0;
      } catch { answer = text.slice(0, 120); }
    } else {
      answer = '[stream]';
    }
    return { status: r.status, ms, reqId, answer, toolCalls, text, ok: r.status < 400 };
  } catch (e) {
    return { status: 0, ms: Date.now() - started, reqId: '', answer: '', toolCalls: 0, text: e.message, ok: false, failed: true };
  }
}

async function probe(model) {
  if (flags.toolFollow) {
    const n = flags.repeat || 5;
    let called = 0, narrated = 0, errored = 0;
    console.log(`\n■ ${model}  (tool-follow ×${n})`);
    for (let i = 0; i < n; i++) {
      const res = await probeOnce(model, { follow: true });
      if (res.failed || !res.ok) { errored++; console.log(`   [${i + 1}] status=${res.status} ERR ${String(res.text).slice(0, 100)}`); }
      else if (res.toolCalls > 0) { called++; console.log(`   [${i + 1}] status=${res.status} ${res.ms}ms  ✓ tool_calls=${res.toolCalls}  x-request-id=${res.reqId}`); }
      else { narrated++; console.log(`   [${i + 1}] status=${res.status} ${res.ms}ms  ✗ NO tool_call — narrated: "${String(res.answer).replace(/\s+/g, ' ').slice(0, 90)}"  x-request-id=${res.reqId}`); }
      await new Promise((r) => setTimeout(r, 1500));
    }
    const rate = ((called / n) * 100).toFixed(0);
    console.log(`   ── tool-adherence: ${called}/${n} called (${rate}%), ${narrated} narrated, ${errored} errored`);
    return;
  }
  const res = await probeOnce(model, { follow: false });
  console.log(`\n■ ${model}`);
  console.log(`   status=${res.status}  ${res.ms}ms  x-request-id=${res.reqId}`);
  console.log(`   answer: ${String(res.answer).replace(/\s+/g, ' ').slice(0, 160)}`);
  if (res.status >= 400) console.log(`   body: ${String(res.text).slice(0, 200)}`);
}

console.log(`model-probe → ${BASE}  (${MODELS.length} models)`);
console.log(`prompt: ${PROMPT}`);
console.log(`shape: tools=${flags.tools || 0}  sys≈${flags.sysKb || 0}KB  trigger=${!!flags.sysTrigger}  stream=${!!flags.stream}  tool-follow=${!!flags.toolFollow}${flags.toolFollow ? ` ×${flags.repeat || 5}` : ''}`);
if (!KEY) console.log('note: no --key/API_KEY set; sending unauthenticated (ok if gateway allows local no-auth)');
for (const m of MODELS) {
  await probe(m);           // sequential — single account is rate-limit fragile
  await new Promise((r) => setTimeout(r, 1500));  // gentle spacing, avoid 529
}
console.log(`\nDone. Inspect traces:\n  node tools/trace-view.mjs\n  node tools/trace-view.mjs <traceId> --raw`);
