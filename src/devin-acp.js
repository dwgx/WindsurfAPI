import { spawn } from 'child_process';
import { VERSION } from './version.js';
import { log } from './config.js';

// Spawn seam: `spawn` is captured behind an indirection so a test can inject a
// fake child (EventEmitter stdio) to exercise the stdin 'error'/EPIPE guard
// without a real Devin CLI or network. Production always uses the real spawn.
let _spawn = spawn;
export function __setDevinAcpSpawnForTest(fn) { _spawn = fn || spawn; }

function intEnv(name, fallback, min = 0) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function runTimeoutMs() {
  return intEnv('DEVIN_TIMEOUT_MS', 10 * 60_000, 1000);
}

function outputLimitBytes() {
  return intEnv('DEVIN_OUTPUT_LIMIT_BYTES', 4 * 1024 * 1024, 1024);
}

function parseAcpArgs() {
  const raw = process.env.DEVIN_CLI_ACP_ARGS_JSON || '';
  if (!raw.trim()) return ['acp'];
  try {
    const args = JSON.parse(raw);
    if (!Array.isArray(args) || !args.every(x => typeof x === 'string')) {
      throw new Error('must be a JSON string array');
    }
    return args;
  } catch (err) {
    throw Object.assign(new Error(`Invalid DEVIN_CLI_ACP_ARGS_JSON: ${err.message}`), {
      status: 500,
      type: 'backend_misconfigured',
    });
  }
}

// ── Zero-billable proactive availability probe (AC1 gap-e / §4) ──────────────
// AC1 left "probe before we spawn" as a nice-to-have: today the ACP runner only
// learns the Devin CLI is missing AFTER it has reserved a pool account and
// spawned `devin acp`, then catches ENOENT → 503. probeDevinCliAvailable lets a
// router fail FAST and gracefully before burning a checkout/spawn.
//
// CRITICAL — this probe is strictly NON-billable. It runs `devin --version`
// (exit-code + presence check) and NOTHING else. It never calls
// initialize/authenticate/session.new/session/prompt, never opens a session,
// never sends a prompt — so it cannot consume account quota or upstream tokens.
// It only answers "is the binary on this box runnable?", which mirrors exactly
// what the real `spawn(command, ['acp'])` would hit, so a probe ENOENT predicts
// a runtime ENOENT.
//
// Result is cached for a short TTL (DEVIN_ACP_PROBE_TTL_MS) so a hot request
// path doesn't fork a child on every call. DEVIN_ACP_PROBE=0 disables the probe
// entirely (callers fall back to the passive post-spawn ENOENT→503 path).
let _probeCache = null; // { at: epochMs, result }

function parseProbeArgs() {
  const raw = process.env.DEVIN_ACP_PROBE_ARGS_JSON || '';
  if (!raw.trim()) return ['--version'];
  try {
    const args = JSON.parse(raw);
    if (!Array.isArray(args) || !args.every(x => typeof x === 'string')) {
      throw new Error('must be a JSON string array');
    }
    return args;
  } catch {
    // A misconfigured probe-args override must never block routing — fall back
    // to the safe default rather than throwing inside an availability check.
    return ['--version'];
  }
}

function probeOnce() {
  const command = process.env.DEVIN_CLI_PATH || 'devin';
  const args = parseProbeArgs();
  const timeoutMs = intEnv('DEVIN_ACP_PROBE_TIMEOUT_MS', 5000, 100);
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    } catch (err) {
      done({ available: false, reason: 'spawn_failed', detail: err?.code || err?.message || 'spawn threw' });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      // A version check that hangs past the timeout means a wedged binary; treat
      // it as unavailable so we don't route to something that can't respond.
      done({ available: false, reason: 'probe_timeout' });
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (err) => {
      clearTimeout(timer);
      // ENOENT = not installed; EACCES = present but not executable. Both mean
      // the same real `spawn(command, ['acp'])` would fail the same way.
      const reason = err?.code === 'ENOENT' ? 'not_found'
        : err?.code === 'EACCES' ? 'not_executable'
        : 'spawn_error';
      done({ available: false, reason, detail: err?.code || err?.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // The binary exists and is executable (it ran to exit). exitCode 0 is the
      // clean "version printed" signal; a non-zero exit still proves PRESENCE —
      // some CLI versions don't grok `--version` — so we keep it available to
      // avoid false-negatives that would wrongly disable a working backend, and
      // surface the code for observability.
      done({ available: true, reason: code === 0 ? 'ok' : 'present_nonzero_exit', exitCode: code });
    });
  });
}

export async function probeDevinCliAvailable({ force = false } = {}) {
  // Opt-out: skip the active probe and assume available, deferring to the
  // passive post-spawn ENOENT→503 path. Marked skipped so callers can tell.
  if (String(process.env.DEVIN_ACP_PROBE || '').trim() === '0') {
    return { available: true, skipped: true, reason: 'probe_disabled' };
  }
  const command = process.env.DEVIN_CLI_PATH || 'devin';
  const argsKey = (process.env.DEVIN_ACP_PROBE_ARGS_JSON || '').trim();
  const key = `${command} ${argsKey}`;
  const ttlMs = intEnv('DEVIN_ACP_PROBE_TTL_MS', 60_000, 0);
  const now = Date.now();
  // Cache keys on the resolved command (+ probe-args override): a config change
  // that points at a different binary must re-probe, not reuse a stale verdict.
  if (!force && ttlMs > 0 && _probeCache && _probeCache.key === key && (now - _probeCache.at) < ttlMs) {
    return { ..._probeCache.result, cached: true };
  }
  const result = await probeOnce();
  _probeCache = { at: now, key, result };
  return { ...result, cached: false };
}

// Test seam: drop the cached probe result so each test observes a fresh probe.
export function __resetDevinAcpProbeCache() {
  _probeCache = null;
}

function writeJsonLine(child, payload) {
  if (!child.stdin?.writable) return;
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// ── Transient-first ACP error classification ────────────────────────────────
// The ACP path spawns `devin acp` which talks to the SAME upstream as
// DEVIN_CONNECT (server.codeium.com — authenticate _meta.api_server_url). That
// upstream is observed (DEVIN_CONNECT live, free account <redacted>) to
// wrap TRANSIENT faults inside an auth-shaped envelope:
//   - "We're currently facing high demand for this model..." (capacity)
//   - "an internal error occurred (trace ID: ...)" (backend blip in a 401/403)
// If those reach the pool as a plain 502 backend_error they fall through to the
// windowed generic-error streak and DISABLE a perfectly healthy account after
// 3 hits — i.e. a retryable hiccup burns a working credential.
//
// So we classify ACP RPC errors with the SAME transient-first ordering as
// devin-connect.js classifyUpstreamError, then choose an (status, type, message)
// tuple that makes the EXISTING reportRunFailure (special-agent.js) route safely
// WITHOUT changing that file:
//   - CAPACITY        → status 429 → reportRunFailure → markRateLimited
//                       (fixed cooldown, rotates out, NOT disabled). retryable.
//   - UPSTREAM_INTERNAL→ status 502 + message keeps "internal error" →
//                       reportRunFailure → reportInternalError (account-sticky
//                       quarantine, NOT a re-login storm). NON-retryable
//                       (observed persistent 3/3 — same-process replay just
//                       amplifies load, mirrors devin-connect isRetryable).
//   - UNAUTHORIZED    → status 401 → reportRunFailure → genericError; a GENUINE
//                       dead token disables after the streak. Transient blips in
//                       a 401 shell are already caught by the two branches above
//                       (transient-first), so only real auth failures land here.
//   - RATE_LIMITED    → status 429 → markRateLimited.
//   - else            → 502 backend_error (unchanged legacy behaviour).
export function classifyAcpError(message, rpcCode = null) {
  const body = String(message || '').trim();
  const lc = body.toLowerCase();

  // Capacity / high-demand throttling — match BEFORE auth so a momentary blip
  // never reads as a dead token. Pattern parity with devin-connect.js:597.
  if (/high demand|try again later|currently (busy|overloaded|at capacity)|model is (busy|overloaded)|temporarily (busy|overloaded|unavailable)|server is busy|overloaded|(service|backend|model|server) (is )?(temporarily )?unavailable|capacity/i.test(lc)) {
    return { code: 'CAPACITY', type: 'capacity_error', status: 429, retryable: true };
  }
  // "an internal error occurred (trace ID: ...)" — a transient BACKEND fault,
  // NOT a dead session token, even inside a 401/403 shell. NON-retryable
  // (devin-connect.js:643-647: observed persistent, same-token replay amplifies).
  if (/internal error occurred|internal error/i.test(lc)) {
    return { code: 'UPSTREAM_INTERNAL', type: 'upstream_internal', status: 502, retryable: false };
  }
  // Real auth failure.
  if (/permission_denied|unauthenticated|unauthorized|invalid.*(api ?key|token)|authentication failed/i.test(lc)) {
    return { code: 'UNAUTHORIZED', type: 'unauthorized', status: 401, retryable: false };
  }
  // Explicit rate limiting.
  if (/rate.?limit|too many requests|resource_exhausted/i.test(lc)) {
    return { code: 'RATE_LIMITED', type: 'rate_limited', status: 429, retryable: false };
  }
  return { code: rpcCode ? String(rpcCode) : 'UPSTREAM_ERROR', type: 'backend_error', status: 502, retryable: false };
}

function errorFromRpcResponse(resp, fallback = 'ACP request failed') {
  const msg = resp?.error?.message || fallback;
  const { code, type, status, retryable } = classifyAcpError(msg, resp?.error?.code);
  const err = new Error(msg);
  err.status = status;
  err.type = type;
  err.code = code;
  err.retryable = retryable;
  return err;
}

function extractAcpUpdate(params) {
  const update = params?.update || params?.sessionUpdate || params;
  const kind = update?.sessionUpdate || update?.type || update?.kind || update?.name || '';
  let text = '';
  const content = update?.content || update?.delta || update?.message || null;
  if (typeof update?.text === 'string') text = update.text;
  else if (typeof content === 'string') text = content;
  else if (typeof content?.text === 'string') text = content.text;
  else if (Array.isArray(content)) {
    text = content
      .map(part => typeof part === 'string' ? part : (part?.text || ''))
      .filter(Boolean)
      .join('');
  }
  return { kind: String(kind || ''), text };
}

// The assistant's user-visible reply. Only these land in the final text.
const MESSAGE_CHUNK_KINDS = new Set([
  'agent_message_chunk',
  'agent_message_delta',
  'assistant_message_chunk',
]);
// The agent's thinking stream (verified live 2026-06-29 with SWE-1.6 over real
// ACP). It is intentionally kept OUT of the reply text and captured separately
// as reasoning so callers can drop it by default or surface it explicitly.
const THOUGHT_CHUNK_KINDS = new Set([
  'agent_thought_chunk',
  'agent_thought_delta',
  'agent_reasoning_chunk',
]);

function collectAcpTextFromNotification(obj, buffers, onChunk) {
  if (obj?.method !== 'session/update') return;
  const { kind, text } = extractAcpUpdate(obj.params || {});
  if (!text) return;
  if (MESSAGE_CHUNK_KINDS.has(kind)) {
    buffers.message.push(text);
    // Real-time fan-out: fire the chunk as it arrives so callers can stream it
    // verbatim. Buffers are still filled, so getText() remains the source of
    // truth for non-streaming callers. onChunk is optional — when absent the
    // behaviour is identical to before (collect-then-return).
    if (onChunk) { try { onChunk({ kind: 'message', text }); } catch { /* never let a consumer error kill the pump */ } }
  } else if (THOUGHT_CHUNK_KINDS.has(kind)) {
    buffers.thought.push(text);
    if (onChunk) { try { onChunk({ kind: 'thought', text }); } catch { /* ignore consumer error */ } }
  }
  // Any other update kind (tool calls, plans, status) is not part of the
  // text/reasoning split and is ignored here on purpose.
}

function makeAcpClient({ command, args, env, signal, timeoutMs, outputLimit, onChunk }) {
  const child = _spawn(command, args, {
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let nextId = 1;
  let stderr = '';
  let outputBytes = 0;
  let closed = false;
  let closeCode = null;
  let fatalError = null;
  let stdoutBuffer = '';
  // Active session id, set after session/new. Held here so an abort can send a
  // graceful `session/cancel` notification (spec §6.1) before SIGTERM.
  let activeSessionId = null;
  // True once onAbort has sent session/cancel and scheduled the deferred kill.
  // close() (called from runDevinAcpProcess's finally the instant the prompt
  // rejects) must NOT pre-empt that grace window with an immediate SIGTERM —
  // otherwise the child is killed before it can read the cancel notification.
  let gracefulKillPending = false;
  const pending = new Map();
  const buffers = { message: [], thought: [] };

  const cleanup = () => {
    for (const { timer } of pending.values()) clearTimeout(timer);
    pending.clear();
  };

  const failAll = (err) => {
    fatalError = fatalError || err;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    pending.clear();
  };

  const onData = (name, chunk) => {
    const s = chunk.toString('utf8');
    outputBytes += Buffer.byteLength(s);
    if (outputBytes > outputLimit) {
      const err = Object.assign(new Error(`Devin ACP output exceeded ${outputLimit} bytes`), {
        status: 502,
        type: 'backend_output_too_large',
      });
      failAll(err);
      child.kill('SIGTERM');
      return;
    }
    if (name === 'stderr') {
      stderr += s;
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
      return;
    }
    stdoutBuffer += s;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const obj = parseJsonLine(line);
      if (!obj) continue;
      collectAcpTextFromNotification(obj, buffers, onChunk);
      if (obj.method === 'session/request_permission' && obj.id != null) {
        writeJsonLine(child, {
          jsonrpc: '2.0',
          id: obj.id,
          result: { outcome: 'cancelled' },
        });
        continue;
      }
      if (obj.id == null) continue;
      const waiter = pending.get(obj.id);
      if (!waiter) continue;
      pending.delete(obj.id);
      clearTimeout(waiter.timer);
      waiter.resolve(obj);
    }
  };

  child.stdout.on('data', c => onData('stdout', c));
  child.stderr.on('data', c => onData('stderr', c));
  // stdin 'error' guard (audit finding): every writeJsonLine already checks
  // child.stdin?.writable, but that check races the child dying mid-write — if
  // the CLI exits between the guard and the write, the write emits EPIPE on
  // stdin as an async 'error' event. With no listener that becomes an
  // uncaughtException and takes down the WHOLE proxy (every tenant), not just
  // this request. Attach a swallow-and-log handler so a dead child only fails
  // its own in-flight requests via the 'close'/'error' paths above. Wrapped in
  // try/catch so the handler itself can never throw and re-trigger the crash.
  if (child.stdin) {
    child.stdin.on('error', err => {
      try {
        // EPIPE/ECONNRESET here just mean the child went away mid-write; the
        // 'close' handler will fail all pending requests with a proper status.
        // Log at debug for the expected teardown races, warn for anything else.
        if (err?.code === 'EPIPE' || err?.code === 'ECONNRESET') {
          log.debug(`Devin ACP stdin closed mid-write (${err.code}); child likely exited`);
        } else {
          log.warn(`Devin ACP stdin error: ${err?.code || err?.message || err}`);
        }
      } catch { /* a logging failure must never escalate into a crash */ }
    });
  }
  child.on('error', err => {
    if (err.code === 'ENOENT') {
      failAll(Object.assign(new Error(`Devin CLI not found: ${command}`), {
        status: 503,
        type: 'backend_unavailable',
      }));
    } else {
      failAll(Object.assign(err, { status: 502, type: 'backend_error' }));
    }
  });
  child.on('close', code => {
    closed = true;
    closeCode = code;
    const err = fatalError || Object.assign(new Error(`Devin ACP exited with code ${code}`), {
      status: 502,
      type: 'backend_error',
    });
    if (code !== 0) {
      failAll(err);
    } else if (pending.size > 0) {
      // GAP-ACP-01: a clean exit (code 0) that still has in-flight requests
      // means the CLI closed before answering — e.g. it exited without
      // emitting the session/prompt result. cleanup() alone would clear the
      // pending map WITHOUT settling those promises, hanging the awaiting
      // caller forever and permanently leaking its concurrency slot (fatal
      // under DEVIN_MAX_PROCS=1). Reject them so the slot releases.
      failAll(Object.assign(new Error('Devin ACP exited (code 0) before responding'), {
        status: 502,
        type: 'backend_error',
      }));
    } else {
      cleanup();
    }
  });

  const onAbort = () => {
    // Graceful cancel: tell the agent to abort in-flight work for the session
    // (spec §6.1 `session/cancel` is a notification — no id, no response) so it
    // can clean up before we hard-kill the process. We give it a short grace
    // window (DEVIN_ACP_CANCEL_GRACE_MS, default 250ms, 0 disables) for the
    // notification to be read and acted on, THEN SIGTERM. The grace timer is
    // unref'd so it never holds the event loop open, and the close handler
    // clears it if the child exits cleanly on its own first. Best-effort: if
    // stdin is already gone the write is a no-op and we SIGTERM immediately.
    // The reject below uses request_aborted (499) which classifyAcpError leaves
    // alone — an abort is a CLIENT action, never an upstream fault, so it must
    // not touch pool health.
    const err = Object.assign(new Error('Request aborted'), { status: 499, type: 'request_aborted' });
    failAll(err);
    const graceMs = intEnv('DEVIN_ACP_CANCEL_GRACE_MS', 250, 0);
    if (activeSessionId && child.stdin?.writable && graceMs > 0) {
      gracefulKillPending = true;
      writeJsonLine(child, { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: activeSessionId } });
      const killTimer = setTimeout(() => { if (!closed) child.kill('SIGTERM'); }, graceMs);
      killTimer.unref?.();
    } else {
      child.kill('SIGTERM');
    }
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const request = (method, params = {}, timeout = timeoutMs) => {
    if (closed) {
      return Promise.reject(Object.assign(new Error(`Devin ACP is closed (code ${closeCode})`), {
        status: 502,
        type: 'backend_error',
      }));
    }
    const id = nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`Devin ACP ${method} timed out after ${timeout}ms`), {
          status: 504,
          type: 'backend_timeout',
        }));
      }, timeout);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      writeJsonLine(child, payload);
    });
  };

  const close = () => {
    if (signal) signal.removeEventListener('abort', onAbort);
    cleanup();
    // Don't pre-empt a graceful cancel-then-kill already scheduled by onAbort.
    if (!closed && !gracefulKillPending) child.kill('SIGTERM');
  };

  return {
    request,
    close,
    // Register the live session id so onAbort can emit `session/cancel` for it.
    setSessionId: (id) => { activeSessionId = id || null; },
    getText: () => buffers.message.join('').trim(),
    getReasoning: () => buffers.thought.join('').trim(),
    getStderr: () => stderr.trim(),
  };
}

export async function runDevinAcpProcess(prompt, { modelKey = '', apiKey = '', apiServerUrl = '', signal = null, onChunk = null } = {}) {
  if (!apiKey) {
    throw Object.assign(new Error('Devin ACP mode requires an upstream Windsurf account apiKey.'), {
      status: 503,
      type: 'backend_unavailable',
    });
  }
  const command = process.env.DEVIN_CLI_PATH || 'devin';
  const env = { ...process.env };
  const args = parseAcpArgs();
  const client = makeAcpClient({
    command,
    args,
    env,
    signal,
    timeoutMs: runTimeoutMs(),
    outputLimit: outputLimitBytes(),
    onChunk,
  });

  try {
    const init = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'WindsurfAPI', version: VERSION },
    }, 30_000);
    if (init.error) throw errorFromRpcResponse(init, 'Devin ACP initialize failed');

    const authMeta = {
      api_key: apiKey,
      ...(apiServerUrl ? { api_server_url: apiServerUrl } : {}),
    };
    const auth = await client.request('authenticate', {
      methodId: 'windsurf-api-key',
      _meta: authMeta,
    }, 45_000);
    if (auth.error) throw errorFromRpcResponse(auth, 'Devin ACP authenticate failed');

    const session = await client.request('session/new', {
      cwd: process.env.DEVIN_CLI_WORKDIR || process.cwd(),
      mcpServers: [],
    }, 60_000);
    if (session.error) throw errorFromRpcResponse(session, 'Devin ACP session/new failed');
    const sessionId = session?.result?.sessionId || session?.result?.session_id;
    if (!sessionId) {
      throw Object.assign(new Error('Devin ACP session/new did not return sessionId'), {
        status: 502,
        type: 'backend_error',
      });
    }
    // Arm graceful cancellation: a later abort can now send session/cancel.
    client.setSessionId(sessionId);

    const modelHint = modelKey ? `Model requested by caller: ${modelKey}\n\n` : '';
    const result = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: `${modelHint}${prompt}` }],
    }, runTimeoutMs());
    if (result.error) throw errorFromRpcResponse(result, 'Devin ACP session/prompt failed');

    return {
      text: client.getText(),
      reasoning: client.getReasoning(),
      stderr: client.getStderr(),
      usage: result?.result?.usage || null,
      stopReason: result?.result?.stopReason || result?.result?.stop_reason || null,
    };
  } finally {
    client.close();
  }
}
