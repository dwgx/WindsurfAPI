import { spawn } from 'child_process';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { VERSION } from './version.js';
import { log } from './config.js';
import { MODELS, resolveModel } from './models.js';
import { buildSubprocessEnv, buildMinimalSubprocessEnv } from './log-safety.js';
import { budgetExceededError } from './request-budget.js';

const ACP_PROTOCOL_VERSION = 1;

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
      // STRICTEST env of any spawn in the repo: this binary is resolved via
      // PATH (or an operator-supplied DEVIN_CLI_PATH), so a hijacked binary
      // would have received every credential in process.env — including the
      // credential-store KEK. `--version` needs nothing beyond exec basics.
      child = spawn(command, args, {
        env: buildMinimalSubprocessEnv(),
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
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
  const rpc = String(rpcCode);
  if (ACP_REQUEST_ERROR_CODES.has(rpc)) {
    return { code: rpc, type: 'backend_protocol_error', status: 502, retryable: false };
  }
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

const ACP_TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN',
  'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAGAIN',
]);
const ACP_UNCORRELATED_ERROR_CODES = new Set(['-32700', '-32600']);
const ACP_REQUEST_ERROR_CODES = new Set([...ACP_UNCORRELATED_ERROR_CODES, '-32601', '-32602']);
const ACP_TERMINAL_ERROR_CODES = new Set([
  ...ACP_REQUEST_ERROR_CODES, '-32000', '-32002', '-32800',
]);

function errorFromRpcResponse(resp, fallback = 'ACP request failed') {
  const msg = resp?.error?.message || fallback;
  const rpcCode = String(resp?.error?.code);
  const { code, type, status, retryable } = classifyAcpError(msg, resp?.error?.code);
  const err = new Error(msg);
  err.status = status;
  err.type = type;
  err.code = code;
  // An RPC error only warrants replay if it identifies a transient fault.
  const transport = type === 'backend_error' && (
    ACP_TRANSPORT_CODES.has(rpcCode) || ['502', '503', '504'].includes(rpcCode) || /\bsocket hang up\b/i.test(msg)
  );
  err.retryable = !ACP_TERMINAL_ERROR_CODES.has(rpcCode) && (retryable || transport);
  return err;
}

function acpUpdateKind(update) {
  return String(update?.sessionUpdate || update?.type || update?.kind || update?.name || '');
}

function extractAcpUpdate(params) {
  const update = params?.update || params?.sessionUpdate || params;
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
  return { kind: acpUpdateKind(update), text };
}

// Keep reasoning (observed with SWE-1.6 over ACP) separate from visible text
// so callers can drop it by default or surface it explicitly.
const ACP_TEXT_CHANNELS = new Map([
  ['agent_message_chunk', 'message'],
  ['agent_message_delta', 'message'],
  ['assistant_message_chunk', 'message'],
  ['agent_thought_chunk', 'thought'],
  ['agent_thought_delta', 'thought'],
  ['agent_reasoning_chunk', 'thought'],
]);

// ACP tool notifications describe agent-owned activity. Only assistant reply
// text and reasoning are projected from session/update into the HTTP result.
const TOOL_UPDATE_KINDS = new Set(['tool_call', 'tool_call_update']);

function collectAcpUpdate(params, buffers, onChunk, blockReplay) {
  const { kind, text } = extractAcpUpdate(params);
  if (TOOL_UPDATE_KINDS.has(kind)) {
    blockReplay();
    return;
  }
  const channel = ACP_TEXT_CHANNELS.get(kind);
  if (!text || !channel) return;
  if (!buffers) {
    // Late content still proves this child did work before any replacement
    // prompt, even though its closed prompt no longer owns the response.
    blockReplay();
    return;
  }
  buffers[channel].push(text);
  try { onChunk?.({ kind: channel, text }); } catch { /* isolate consumer errors */ }
}

function permissionResponse(options, cancelled) {
  if (cancelled) return { result: { outcome: { outcome: 'cancelled' } } };

  const optionKinds = new Map();
  if (Array.isArray(options)) {
    for (const option of options) {
      const id = option?.optionId;
      if (typeof id !== 'string' || !id.trim()) continue;
      // A duplicate ID is ambiguous even if one entry claims it rejects.
      optionKinds.set(id, optionKinds.has(id) ? null : option.kind);
    }
  }
  let rejectOnce;
  let rejectAlways;
  for (const [id, kind] of optionKinds) {
    if (kind === 'reject_once') rejectOnce ??= id;
    if (kind === 'reject_always') rejectAlways ??= id;
  }
  const optionId = rejectOnce ?? rejectAlways;
  if (optionId) return { result: { outcome: { outcome: 'selected', optionId } } };
  return { error: { code: -32602, message: 'Permission request has no usable rejection option' } };
}

function acpTransportError(message) {
  return Object.assign(new Error(message), { status: 502, type: 'backend_error', retryable: true });
}

function acpTimeoutError(operation, timeoutMs, retryable = false) {
  return Object.assign(new Error(`Devin ACP ${operation} timed out after ${timeoutMs}ms`), {
    status: 504,
    type: 'backend_timeout',
    retryable,
  });
}

function acpAbortError() {
  return Object.assign(new Error('Request aborted'), { status: 499, type: 'request_aborted' });
}

function acpTurnDeadline(timeoutMs, budget) {
  const started = performance.now();
  const localEnd = started + timeoutMs;
  const routeEnd = started + (budget?.remainingMs() ?? Infinity);
  const end = Math.min(localEnd, routeEnd);
  return {
    // Keep the original monotonic ceiling across retries, and also consult
    // the route clock in case it has already advanced past its deadline.
    remainingMs: () => Math.min(end - performance.now(), budget?.remainingMs() ?? Infinity),
    error: () => budget && (routeEnd <= localEnd || budget.remainingMs() <= Math.max(0, localEnd - performance.now()))
      ? budgetExceededError('Request deadline reached during Devin ACP')
      : acpTimeoutError('turn', timeoutMs),
  };
}

function makeAcpClient({ command, args, env, signal, deadline, timeoutMs, outputLimit, onChunk, blockReplay, beforeWrite }) {
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
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  // Active session id, set after session/new. Held here so an abort can send a
  // graceful `session/cancel` notification (spec §6.1) before SIGTERM.
  let activeSessionId = null;
  // True once onAbort has sent session/cancel and scheduled the deferred kill.
  // close() (called from runDevinAcpProcess's finally the instant the prompt
  // rejects) must NOT pre-empt that grace window with an immediate SIGTERM —
  // otherwise the child is killed before it can read the cancel notification.
  let gracefulKillPending = false;
  const pending = new Map();
  let promptId = null;
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

  const appendStderr = (text) => {
    stderr += text;
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  };

  const onData = (name, chunk) => {
    if (!signal?.aborted && deadline.remainingMs() <= 0) {
      failAll(deadline.error());
      return;
    }
    // A pipe chunk can end inside a UTF-8 character. Count the original bytes
    // before decoding and keep each pipe's unfinished character separate.
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    outputBytes += bytes.byteLength;
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
      appendStderr(stderrDecoder.write(bytes));
      return;
    }
    stdoutBuffer += stdoutDecoder.write(bytes);
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const obj = parseJsonLine(line);
      if (!obj) continue;
      if (obj.method === 'session/update') {
        // Resolving a prompt removes its pending entry synchronously, including
        // when its response and trailing updates arrive in the same pipe read.
        collectAcpUpdate(obj.params || {}, pending.has(promptId) ? buffers : null, onChunk, blockReplay);
      }
      if (obj.method === 'session/request_permission') {
        blockReplay();
        if (obj.id != null) {
          writeJsonLine(child, {
            jsonrpc: '2.0',
            id: obj.id,
            ...permissionResponse(obj.params?.options, signal?.aborted),
          });
        }
        continue;
      }
      if (obj.id === null && pending.size === 1 && ACP_UNCORRELATED_ERROR_CODES.has(String(obj.error?.code))) {
        // JSON-RPC uses a null ID when the peer cannot identify the request.
        // This client sends only one RPC at a time.
        failAll(errorFromRpcResponse(obj));
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
  child.stderr.on('end', () => appendStderr(stderrDecoder.end()));
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
      failAll(Object.assign(err, { status: 502, type: 'backend_error', retryable: ACP_TRANSPORT_CODES.has(err.code) }));
    }
  });
  child.on('close', code => {
    closed = true;
    closeCode = code;
    if (code !== 0) {
      failAll(fatalError || acpTransportError(`Devin ACP exited with code ${code}`));
    } else if (pending.size > 0) {
      // GAP-ACP-01: a clean exit (code 0) that still has in-flight requests
      // means the CLI closed before answering — e.g. it exited without
      // emitting the session/prompt result. cleanup() alone would clear the
      // pending map WITHOUT settling those promises, hanging the awaiting
      // caller forever and permanently leaking its concurrency slot (fatal
      // under DEVIN_MAX_PROCS=1). Reject them so the slot releases.
      failAll(acpTransportError('Devin ACP exited (code 0) before responding'));
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
    failAll(acpAbortError());
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
    if (signal?.aborted) return Promise.reject(acpAbortError());
    if (fatalError) return Promise.reject(fatalError);
    if (closed) {
      return Promise.reject(acpTransportError(`Devin ACP is closed (code ${closeCode})`));
    }
    const id = nextId++;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    const remaining = deadline.remainingMs();
    if (remaining <= 0) return Promise.reject(deadline.error());
    if (!child.stdin?.writable) return Promise.reject(acpTransportError('Devin ACP stdin is closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const phaseTimedOut = timeout < remaining && deadline.remainingMs() > 0;
        reject(phaseTimedOut ? acpTimeoutError(method, timeout, true) : deadline.error());
      }, Math.ceil(Math.min(timeout, remaining)));
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      beforeWrite(method);
      if (method === 'session/prompt') promptId = id;
      child.stdin.write(line);
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

// Build the ACP `session/prompt` content-block array. VISION (gated by
// DEVIN_ACP_VISION): the ACP path is the CLEAN vision route — the real devin CLI
// builds the downstream GetChatMessage wire and the server signs its own thinking
// turns, so we NEVER forge the un-forgeable #12 signature that blocks the
// DEVIN_CONNECT synthetic-tool_result path. Devin's own `initialize` advertises
// promptCapabilities.image=true, and the ACP ContentBlock union has a first-class
// image variant { type:'image', data:<base64>, mimeType }.
//
// `prompt` may be a plain string (text-only, unchanged behavior) or a structured
// { text, images:[{base64_data, mime_type}] } object. Images are only emitted
// when DEVIN_ACP_VISION is on; otherwise they are dropped and we degrade to text
// (identical to prior behavior — no silent behavior change when the gate is off).
export function acpVisionEnabled(env = process.env) {
  const raw = String(env.DEVIN_ACP_VISION ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'on' || raw === 'true';
}

export function buildAcpPromptBlocks(prompt, modelHint = '', env = process.env) {
  // String prompt → text-only block (back-compat).
  if (typeof prompt === 'string' || prompt == null) {
    return [{ type: 'text', text: `${modelHint}${prompt ?? ''}` }];
  }
  const text = typeof prompt.text === 'string' ? prompt.text : '';
  const images = Array.isArray(prompt.images) ? prompt.images : [];
  const blocks = [{ type: 'text', text: `${modelHint}${text}` }];
  if (acpVisionEnabled(env)) {
    for (const img of images) {
      const data = img?.base64_data || img?.data;
      if (!data) continue;
      // ACP ContentBlock image variant (route A, inline base64). mimeType is the
      // ACP field name (camelCase), distinct from our internal mime_type.
      blocks.push({ type: 'image', data, mimeType: img.mime_type || img.mimeType || 'image/png' });
    }
  }
  return blocks;
}

function acpRetryBaseMs() {
  const raw = Number(process.env.DEVIN_ACP_RETRY_BASE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 250;
}

// Capture the bundled keys before runtime catalog sync can add provider data.
const diagnosticModelKeys = new Set(Object.keys(MODELS));

function diagnosticModel(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:/-]{0,95}$/i.test(value)) return null;
  return diagnosticModelKeys.has(resolveModel(value)) ? value : null;
}

function observeLaunchModel(args, operatorArgCount) {
  let source = 'none';
  let value = null;
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    const arg = args[i];
    if (arg !== '--model' && !arg.startsWith('--model=')) continue;
    // Keep the existing argv semantics, including mixed equal/split forms.
    if (source !== 'none') return { source: 'ambiguous', value: null };
    source = i < operatorArgCount ? 'operator_argv' : 'request_argv';
    const candidate = arg === '--model' ? args[i + 1] : arg.slice('--model='.length);
    value = typeof candidate === 'string' && candidate && !candidate.startsWith('-') ? candidate : null;
  }
  return { source, value };
}

function readAcpConfigSelection(response, configId) {
  const configOptions = response.result?.configOptions;
  if (response.jsonrpc !== '2.0' || typeof configId !== 'string' || !Array.isArray(configOptions)) return null;
  // ACP v1 returns the complete option list. The reply is correlated to the
  // request by the pump, and the same option id must appear exactly once.
  const matches = configOptions.filter(option => option?.id === configId);
  if (matches.length !== 1) return null;
  const { name, type, currentValue, options } = matches[0];
  if (type !== 'select' || typeof name !== 'string' || typeof currentValue !== 'string'
    || !currentValue || !Array.isArray(options)) return null;
  const grouped = options.some(option => option?.group !== undefined || Array.isArray(option?.options));
  if (grouped && !options.every(group => typeof group?.group === 'string'
    && typeof group.name === 'string' && Array.isArray(group.options))) return null;
  const choices = grouped ? options.flatMap(group => group.options) : options;
  if (!choices.every(choice => typeof choice?.value === 'string' && typeof choice.name === 'string')) return null;
  const values = new Set(choices.map(choice => choice.value));
  return values.size === choices.length && values.has(currentValue) ? currentValue : null;
}

function logAcpModelSelection({ modelDiagnostics, launch, sessionStatus, sessionAttempt, sessionCurrent, hasHint, attempt }) {
  const { requestId, requestedModel } = modelDiagnostics || {};
  const rejected = sessionStatus === 'rejected';
  if (!requestId && !rejected) return;
  const launchModel = diagnosticModel(launch.value);
  const sessionModel = diagnosticModel(sessionCurrent);
  let source = 'unknown';
  let effectiveModel = null;

  if (launch.source !== 'ambiguous' && sessionStatus !== 'unresolved') {
    if (sessionStatus === 'acknowledged') {
      if (launch.source !== 'none' && launch.value !== sessionCurrent) {
        source = 'conflict';
      } else if (sessionModel) {
        source = 'session_config';
        effectiveModel = sessionModel;
      }
    } else if (launchModel) {
      source = launch.source;
      effectiveModel = launchModel;
    } else if (launch.source === 'none' && hasHint) {
      source = 'prompt_hint';
    }
  }

  const level = rejected ? 'warn' : 'info';
  log[level]('Devin ACP model selection', {
    requestId: typeof requestId === 'string' && /^[a-z0-9_-]{1,96}$/i.test(requestId) ? requestId : null,
    attempt,
    requested_model: diagnosticModel(requestedModel),
    launch_model: launchModel,
    launch_source: launch.source,
    session_attempted_model: diagnosticModel(sessionAttempt),
    session_model: sessionModel,
    session_config_status: sessionStatus,
    prompt_hint: hasHint,
    // Effective refers to local selection evidence such as submitted argv.
    effective_model: effectiveModel,
    selection_source: source,
    // No calibrated upstream served-model field is consumed by this adapter.
    backend_confirmed_model: null,
    tool_owner: 'agent',
  });
}

export async function runDevinAcpProcess(prompt, { modelKey = '', apiKey = '', apiServerUrl = '', signal = null, onChunk = null, modelDiagnostics = null, budget = null } = {}) {
  if (signal?.aborted) throw acpAbortError();
  if (!apiKey) {
    throw Object.assign(new Error('Devin ACP mode requires an upstream Windsurf account apiKey.'), {
      status: 503,
      type: 'backend_unavailable',
    });
  }
  const timeoutMs = runTimeoutMs();
  const deadline = acpTurnDeadline(timeoutMs, budget);
  const command = process.env.DEVIN_CLI_PATH || 'devin';
  // Denylist env: the CLI gets the operator's general environment (PATH, HOME,
  // proxy vars, DEVIN_* config like DEVIN_PERMISSION_MODE) but no credentials —
  // the upstream apiKey travels ONLY through the ACP `authenticate` RPC's
  // _meta.api_key, never env. keep: SSH agent vars so the agent's local tools
  // can still reach git-over-ssh; nothing else secret-shaped survives.
  const env = buildSubprocessEnv(process.env, {
    keep: ['SSH_AUTH_SOCK', 'SSH_AGENT_PID'],
  });
  const args = parseAcpArgs();
  const operatorArgCount = args.length;
  // One channel only: `devin acp --model` (do not also set DEVIN_MODEL — the
  // two can disagree). Leave DEVIN_PERMISSION_MODE to the operator; do not
  // default it to auto.
  if (modelKey && !args.includes('--model')) {
    args.push('--model', modelKey);
  }
  const launch = observeLaunchModel(args, operatorArgCount);

  // A retry starts another child and replays the whole turn. Stop when the
  // client has received content or the agent has reported tool activity.
  let previousAttempt = null;
  const checkRetry = () => {
    if (previousAttempt?.progressed) throw previousAttempt.error;
  };
  const checkAdmission = () => {
    if (signal?.aborted) throw acpAbortError();
    checkRetry();
    if (deadline.remainingMs() <= 0) throw deadline.error();
    if (budget && !budget.canStartAttempt()) throw budgetExceededError('No upstream turns remaining for Devin ACP');
  };
  const beforeWrite = (method) => {
    checkRetry();
    if (method === 'session/prompt') {
      budget?.takeTurnOrThrow('Devin ACP');
      // This prompt is now being issued. Later activity from the retired child
      // cannot change which attempt's terminal error belongs to this prompt.
      previousAttempt = null;
    }
  };

  const maxRetries = 1;
  for (let attempt = 0; ; attempt++) {
    checkAdmission();
    const currentAttempt = { progressed: false, error: null };
    const blockReplay = () => { currentAttempt.progressed = true; };
    const trackedChunk = onChunk ? (chunk) => { blockReplay(); onChunk(chunk); } : null;
    try {
      return await runDevinAcpAttempt(prompt, {
        command, args, env, modelKey, apiKey, apiServerUrl, signal, deadline, timeoutMs,
        onChunk: trackedChunk, blockReplay, beforeWrite, modelDiagnostics, launch, attempt: attempt + 1,
      });
    } catch (err) {
      if (signal?.aborted) throw acpAbortError();
      checkRetry();
      if (attempt >= maxRetries || currentAttempt.progressed || err?.retryable !== true) throw err;
      // Keep listening to this child's stdio until the next prompt write. A
      // notice from that child's pipe may arrive during the new handshake.
      currentAttempt.error = err;
      previousAttempt = currentAttempt;
      checkAdmission();
      const remaining = deadline.remainingMs();
      const backoff = acpRetryBaseMs();
      if (backoff >= remaining) throw err;
      log.warn(`Devin ACP: retryable ${err.code || err.type || err.status} (${err.message}); retry ${attempt + 1}/${maxRetries} in ${backoff}ms`);
      try {
        if (backoff) await delay(backoff, undefined, { signal: signal ?? undefined });
      } catch (waitError) {
        if (signal?.aborted) throw acpAbortError();
        throw waitError;
      }
    }
  }
}

async function runDevinAcpAttempt(prompt, {
  command, args, env, modelKey, apiKey, apiServerUrl, signal, deadline, timeoutMs,
  onChunk, blockReplay, beforeWrite, modelDiagnostics, launch, attempt,
}) {
  const client = makeAcpClient({
    command,
    args,
    env,
    signal,
    deadline,
    timeoutMs,
    outputLimit: outputLimitBytes(),
    onChunk,
    blockReplay,
    beforeWrite,
  });

  let sessionStatus = 'not_reached';
  let sessionAttempt = null;
  let sessionCurrent = null;
  let hasHint = false;
  try {
    const init = await client.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: process.env.DEVIN_ACP_CLIENT_NAME || 'WindsurfAPI', version: VERSION },
    }, 30_000);
    if (init.error) throw errorFromRpcResponse(init, 'Devin ACP initialize failed');
    const selectedVersion = init.result?.protocolVersion;
    if (selectedVersion !== ACP_PROTOCOL_VERSION) {
      const received = Number.isSafeInteger(selectedVersion) ? selectedVersion : 'missing or invalid';
      throw Object.assign(new Error(`Devin ACP protocol version mismatch: expected ${ACP_PROTOCOL_VERSION}, received ${received}`), {
        status: 502, type: 'backend_protocol_error', code: 'ACP_PROTOCOL_VERSION', retryable: false,
      });
    }

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

    // Optional native config: the CLI advertises configOptions on session/new.
    // Flag-off by default because the live option ids/values are not calibrated
    // against a real ACP peer yet; the prompt hint remains the fallback.
    sessionStatus = 'disabled';
    if (modelKey && process.env.DEVIN_ACP_CONFIG_OPTIONS === '1') {
      sessionStatus = 'not_advertised';
      const rawOptions = session?.result?.configOptions || session?.result?.config_options || [];
      const modelOption = Array.isArray(rawOptions)
        ? rawOptions.find((o) => {
          const id = String(o?.id || o?.configId || o?.key || o?.name || '').toLowerCase();
          return id === 'model' || id.includes('model');
        })
        : null;
      const configId = modelOption?.id || modelOption?.configId || modelOption?.key || modelOption?.name;
      if (configId) {
        const choices = Array.isArray(modelOption.options) ? modelOption.options : [];
        const chosen = choices.find((c) => {
          const v = c?.value ?? c?.id ?? c?.name;
          return v === modelKey;
        });
        const value = chosen ? (chosen.value ?? chosen.id ?? chosen.name) : modelKey;
        sessionAttempt = value;
        sessionStatus = 'unresolved';
        const cfg = await client.request('session/set_config_option', {
          sessionId,
          configId,
          value,
        }, 15_000);
        if (cfg.error) {
          sessionStatus = 'rejected';
        } else {
          sessionCurrent = readAcpConfigSelection(cfg, configId);
          if (sessionCurrent !== null) sessionStatus = 'acknowledged';
        }
      }
    }

    const modelHint = modelKey ? `Model requested by caller: ${modelKey}\n\n` : '';
    hasHint = Boolean(modelHint);
    const result = await client.request('session/prompt', {
      sessionId,
      prompt: buildAcpPromptBlocks(prompt, modelHint, env),
    });
    if (result.error) throw errorFromRpcResponse(result, 'Devin ACP session/prompt failed');

    const stopReason = result?.result?.stopReason || result?.result?.stop_reason || null;
    // ACP v1 has no tool stop reason. An extension would need an explicit
    // delegation path to the HTTP caller before it can end a turn this way.
    if (/tool/i.test(String(stopReason || ''))) {
      throw Object.assign(new Error(
        `Devin ACP stopped with stopReason "${stopReason}" without a supported caller tool handoff`,
      ), { status: 502, type: 'backend_tool_call_unmapped' });
    }
    return {
      text: client.getText(),
      reasoning: client.getReasoning(),
      stderr: client.getStderr(),
      usage: result?.result?.usage || null,
      stopReason,
    };
  } finally {
    client.close();
    logAcpModelSelection({ modelDiagnostics, launch, sessionStatus, sessionAttempt, sessionCurrent, hasHint, attempt });
  }
}
