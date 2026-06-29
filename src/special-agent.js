/**
 * Optional special-agent backend for models that do not work through the
 * direct Cascade chat path (SWE/adaptive/arena).
 *
 * The default backend mode is a conservative Devin CLI print-mode adapter. It
 * is disabled by default and intentionally does not execute or emulate caller
 * tools. DEVIN_CLI_MODE=acp is available as an experimental stdio backend; it
 * is kept small and separate in devin-acp.js so this routing module does not
 * become the protocol implementation.
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import {
  getApiKey,
  releaseAccount,
  reportError,
  reportSuccess,
  reportInternalError,
  markRateLimited,
  reportBanSignal,
  looksLikeBanSignal,
  refundReservation,
} from './auth.js';
import { config, log } from './config.js';
import { recordRequest } from './dashboard/stats.js';
import { sanitizeText, PathSanitizeStream } from './sanitize.js';
import { runDevinAcpProcess } from './devin-acp.js';

const SPECIAL_BACKEND = 'special_agent';
const DEFAULT_SPECIAL_MODELS = new Set([
  'swe-1.6',
  'swe-1.6-fast',
  'adaptive',
  'arena-fast',
  'arena-smart',
]);

function intEnv(name, fallback, min = 0) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function isEnabled() {
  // DEVIN_ONLY (Cascade retired) implies the special-agent backend is on — it's
  // the only backend left, so a single switch must enable the whole path.
  if (String(process.env.DEVIN_ONLY || '').trim() === '1') return true;
  const backend = String(process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND || '').trim().toLowerCase();
  return backend === 'devin-cli' || process.env.DEVIN_CLI_ENABLED === '1';
}

// Opt-in passthrough of the ACP thought stream (agent_thought_chunk) as
// OpenAI-style reasoning_content. Default OFF preserves the prior behaviour:
// result.reasoning is captured by the runner but discarded by the handler.
function exposeReasoning() {
  return process.env.DEVIN_ACP_EXPOSE_REASONING === '1';
}

export function isSpecialAgentEnabled() {
  return isEnabled();
}

function configuredBackend() {
  if (!isEnabled()) return '';
  return 'devin-cli';
}

function maxProcs() {
  return intEnv('DEVIN_MAX_PROCS', 1, 1);
}

function queueTimeoutMs() {
  return intEnv('DEVIN_QUEUE_TIMEOUT_MS', 30_000, 1000);
}

function runTimeoutMs() {
  return intEnv('DEVIN_TIMEOUT_MS', 10 * 60_000, 1000);
}

function outputLimitBytes() {
  return intEnv('DEVIN_OUTPUT_LIMIT_BYTES', 4 * 1024 * 1024, 1024);
}

// SSE keepalive interval for live ACP streams. Devin "thinking" can run for
// tens of seconds with no chunk; without periodic bytes, clients and
// intermediaries (nginx, CDNs) close the idle connection. Mirrors the 15s
// heartbeat on the Cascade path but uses a comment frame so OpenAI/Anthropic
// SSE parsers ignore it. Read at call time so tests can tune it.
function acpPingMs() {
  return intEnv('DEVIN_ACP_PING_MS', 25_000, 10);
}

export function isSpecialAgentModelInfo(info) {
  return info?.backend === SPECIAL_BACKEND;
}

export function isSpecialAgentModelKey(modelKey, info = null) {
  if (info && isSpecialAgentModelInfo(info)) return true;
  return DEFAULT_SPECIAL_MODELS.has(String(modelKey || ''));
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (part.type === 'text' && typeof part.content === 'string') return part.content;
      if (part.type === 'image_url' || part.type === 'input_image') return '[image omitted: print backend does not support media]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Render chat messages into a single prompt for the special-agent backend.
 *
 * The backend takes ONE text prompt per session/prompt call, so a multi-turn
 * chat has to be flattened. Two shapes:
 *   - Single turn (one user message, no prior assistant/tool turns): send the
 *     user's text as-is (optionally prefixed with system instructions). No role
 *     labels — it's just a prompt, and labels would be noise.
 *   - Multi-turn: render the prior turns as a labeled transcript, then call out
 *     the latest message and instruct the agent to continue AS THE ASSISTANT.
 *     Without this framing the agent tends to summarize/react to the whole
 *     transcript instead of answering the last turn.
 *
 * System messages are pulled out of the turn flow and surfaced as explicit
 * instructions, mirroring how real chat APIs treat the system role.
 */
export function buildSpecialAgentPrompt(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const systemParts = [];
  const turns = [];
  for (const m of list) {
    const role = m?.role || 'user';
    const text = textFromContent(m?.content).trim();
    if (!text) continue;
    if (role === 'system') { systemParts.push(text); continue; }
    turns.push({ role, text });
  }

  const systemBlock = systemParts.length ? `System instructions:\n${systemParts.join('\n\n')}` : '';
  const label = r => (r === 'assistant' ? 'Assistant' : r === 'tool' ? 'Tool result' : 'User');

  const priorTurns = turns.slice(0, -1);
  const last = turns[turns.length - 1];

  // Single turn (no prior conversation): just the user's text + optional system.
  if (priorTurns.length === 0) {
    return [systemBlock, last ? last.text : ''].filter(Boolean).join('\n\n').trim();
  }

  // Multi-turn: labeled history, highlighted latest message, continuation cue.
  const history = priorTurns.map(t => `${label(t.role)}:\n${t.text}`).join('\n\n');
  const instruction = 'Continue this conversation. Reply as the assistant to the latest message, using the prior turns as context.';
  return [
    systemBlock,
    'Conversation so far:',
    history,
    `Latest ${label(last.role)} message:\n${last.text}`,
    instruction,
  ].filter(Boolean).join('\n\n').trim();
}

function hasUnsupportedMedia(messages) {
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!Array.isArray(m?.content)) continue;
    for (const part of m.content) {
      if (part?.type && part.type !== 'text') return true;
    }
  }
  return false;
}

function estimateTokens(messages, completionText) {
  const promptChars = (Array.isArray(messages) ? messages : [])
    .reduce((n, m) => n + textFromContent(m?.content).length, 0);
  const prompt = Math.max(1, Math.ceil(promptChars / 4));
  const completion = Math.max(1, Math.ceil(String(completionText || '').length / 4));
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    input_tokens: prompt,
    output_tokens: completion,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  };
}

// H3: prefer the runner's real ACP usage over chars/4 estimation. ACP usage
// shapes vary (camelCase from JSON-RPC: inputTokens/outputTokens/totalTokens,
// or the snake_case Connect shape); accept either and fall back to estimation
// for any field the runner did not report. Estimation stays the floor so the
// stream is never billed at zero when the runner omits usage entirely.
function pickUsage(rawUsage, messages, completionText) {
  const est = estimateTokens(messages, completionText);
  if (!rawUsage || typeof rawUsage !== 'object') return est;
  const num = (...vals) => {
    for (const v of vals) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return null;
  };
  const input = num(rawUsage.input_tokens, rawUsage.inputTokens, rawUsage.prompt_tokens, rawUsage.promptTokens);
  const output = num(rawUsage.output_tokens, rawUsage.outputTokens, rawUsage.completion_tokens, rawUsage.completionTokens);
  const total = num(rawUsage.total_tokens, rawUsage.totalTokens);
  const cached = num(rawUsage.cache_read_tokens, rawUsage.cacheReadTokens, rawUsage.cached_tokens, rawUsage.cachedTokens);
  const reasoning = num(rawUsage.reasoning_tokens, rawUsage.reasoningTokens);
  const prompt = input ?? est.prompt_tokens;
  const completion = output ?? est.completion_tokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total ?? (prompt + completion),
    input_tokens: prompt,
    output_tokens: completion,
    prompt_tokens_details: { cached_tokens: cached ?? 0 },
    completion_tokens_details: { reasoning_tokens: reasoning ?? 0 },
  };
}

// H7: map the ACP/Connect stop_reason onto an OpenAI finish_reason instead of
// hardcoding 'stop' (which made truncation / tool-call / refusal all look like
// a clean completion). Unknown reasons fall back to 'stop' so well-behaved
// completions are unaffected.
function mapFinishReason(stopReason) {
  const r = String(stopReason || '').toLowerCase();
  if (!r) return 'stop';
  if (r.includes('max_tokens') || r.includes('max_token') || r.includes('length') || r.includes('truncat')) return 'length';
  if (r.includes('tool')) return 'tool_calls';
  if (r.includes('filter') || r.includes('content') || r.includes('safety') || r.includes('refus')) return 'content_filter';
  if (r.includes('end_turn') || r.includes('stop') || r.includes('complete') || r.includes('eos')) return 'stop';
  return 'stop';
}

function errorResponse(status, type, message, extra = {}) {
  return {
    status,
    body: {
      error: {
        message,
        type,
        ...extra,
      },
    },
  };
}

function parseArgsTemplate(prompt, modelKey) {
  const raw = process.env.DEVIN_CLI_ARGS_JSON || '';
  let args;
  if (raw.trim()) {
    try {
      args = JSON.parse(raw);
    } catch (err) {
      throw Object.assign(new Error(`Invalid DEVIN_CLI_ARGS_JSON: ${err.message}`), {
        status: 500,
        type: 'backend_misconfigured',
      });
    }
    if (!Array.isArray(args) || !args.every(x => typeof x === 'string')) {
      throw Object.assign(new Error('DEVIN_CLI_ARGS_JSON must be a JSON string array'), {
        status: 500,
        type: 'backend_misconfigured',
      });
    }
  } else {
    args = ['-p', '{prompt}'];
  }
  return args.map(arg => arg
    .replaceAll('{prompt}', prompt)
    .replaceAll('{model}', modelKey || ''));
}

let activeProcs = 0;
const waiters = [];

function acquireSlot(signal) {
  if (activeProcs < maxProcs()) {
    activeProcs++;
    return Promise.resolve(() => releaseSlot());
  }

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const waiter = {
      resolve: () => {
        clearTimeout(timer);
        activeProcs++;
        resolve(() => releaseSlot());
      },
      reject,
    };
    const timer = setTimeout(() => {
      const idx = waiters.indexOf(waiter);
      if (idx !== -1) waiters.splice(idx, 1);
      reject(Object.assign(new Error(`Devin CLI process pool is full after ${Date.now() - started}ms`), {
        status: 503,
        type: 'backend_pool_exhausted',
      }));
    }, queueTimeoutMs());
    timer.unref?.();
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        const idx = waiters.indexOf(waiter);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(Object.assign(new Error('Request aborted while waiting for Devin CLI slot'), {
          status: 499,
          type: 'request_aborted',
        }));
      }, { once: true });
    }
    waiters.push(waiter);
  });
}

function releaseSlot() {
  activeProcs = Math.max(0, activeProcs - 1);
  const next = waiters.shift();
  if (next) next.resolve();
}

export function getSpecialAgentStatus() {
  return {
    backend: configuredBackend() || 'disabled',
    enabled: isEnabled(),
    activeProcs,
    queued: waiters.length,
    maxProcs: maxProcs(),
    queueTimeoutMs: queueTimeoutMs(),
    runTimeoutMs: runTimeoutMs(),
    outputLimitBytes: outputLimitBytes(),
    mode: process.env.DEVIN_CLI_MODE || 'print',
  };
}

export async function runDevinAcp(prompt, { modelKey = '', apiKey = '', apiServerUrl = '', signal = null, onChunk = null } = {}) {
  const release = await acquireSlot(signal);
  try {
    // GAP-ACP-05: forward onChunk so the live streamer's incremental chunks
    // actually reach the ACP pump. Without this the wrapper silently drops it
    // and the "real-time" stream degrades to a single buffered flush at the end.
    return await runDevinAcpProcess(prompt, { modelKey, apiKey, apiServerUrl, signal, onChunk });
  } finally {
    release();
  }
}

export async function runDevinPrint(prompt, { modelKey = '', apiKey = '', signal = null } = {}) {
  const release = await acquireSlot(signal);
  try {
    const mode = String(process.env.DEVIN_CLI_MODE || 'print').trim().toLowerCase();
    if (mode !== 'print') {
      throw Object.assign(new Error(`DEVIN_CLI_MODE=${mode} is not implemented yet; use print for the first PoC`), {
        status: 501,
        type: 'backend_mode_unsupported',
      });
    }

    const command = process.env.DEVIN_CLI_PATH || 'devin';
    const args = parseArgsTemplate(prompt, modelKey);
    const env = { ...process.env };
    if (apiKey && process.env.DEVIN_CLI_USE_ACCOUNT_POOL !== '0') {
      const envName = process.env.DEVIN_CLI_API_KEY_ENV || 'WINDSURF_API_KEY';
      env[envName] = apiKey;
    }

    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let killedByTimeout = false;
      let outputBytes = 0;
      let fatalError = null;
      const limit = outputLimitBytes();
      const timer = setTimeout(() => {
        killedByTimeout = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 1500).unref?.();
      }, runTimeoutMs());
      timer.unref?.();

      const onAbort = () => {
        fatalError = Object.assign(new Error('Request aborted'), { status: 499, type: 'request_aborted' });
        child.kill('SIGTERM');
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      const collect = (name, chunk) => {
        const s = chunk.toString('utf8');
        outputBytes += Buffer.byteLength(s);
        if (outputBytes > limit) {
          fatalError = Object.assign(new Error(`Devin CLI output exceeded ${limit} bytes`), {
            status: 502,
            type: 'backend_output_too_large',
          });
          child.kill('SIGTERM');
          return;
        }
        if (name === 'stdout') stdout += s;
        else stderr += s;
      };
      child.stdout.on('data', c => collect('stdout', c));
      child.stderr.on('data', c => collect('stderr', c));
      child.on('error', err => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (err.code === 'ENOENT') {
          reject(Object.assign(new Error(`Devin CLI not found: ${command}`), {
            status: 503,
            type: 'backend_unavailable',
          }));
        } else {
          reject(Object.assign(err, { status: 502, type: 'backend_error' }));
        }
      });
      child.on('close', code => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (killedByTimeout) {
          reject(Object.assign(new Error(`Devin CLI timed out after ${runTimeoutMs()}ms`), {
            status: 504,
            type: 'backend_timeout',
          }));
          return;
        }
        if (fatalError) {
          reject(fatalError);
          return;
        }
        if (code !== 0) {
          const detail = (stderr || stdout || `exit code ${code}`).trim();
          reject(Object.assign(new Error(`Devin CLI failed: ${detail.slice(0, 1000)}`), {
            status: 502,
            type: 'backend_error',
            exitCode: code,
          }));
          return;
        }
        resolve({ text: stdout.trim(), stderr: stderr.trim() });
      });
    });
  } finally {
    release();
  }
}

function chatCompletionBody({ id, created, model, messages, text, reasoning = '', usage = null, stopReason = null }) {
  const message = { role: 'assistant', content: text || null };
  if (reasoning) message.reasoning_content = reasoning;
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: mapFinishReason(stopReason),
    }],
    usage: pickUsage(usage, messages, text),
  };
}

function streamFromText({ id, created, model, messages, text, reasoning = '', usage = null, stopReason = null }) {
  return {
    status: 200,
    stream: true,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    handler: async (res) => {
      const send = data => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      send({ id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      if (reasoning) {
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }] });
      }
      if (text) {
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      }
      send({ id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(stopReason) }] });
      send({ id, object: 'chat.completion.chunk', created, model,
        choices: [], usage: pickUsage(usage, messages, text) });
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    },
  };
}

/**
 * Live SSE stream for ACP mode: the runner is driven INSIDE the handler so each
 * agent_message_chunk is forwarded the moment it arrives (real streaming, not
 * collect-then-slice). The handler owns the account lifecycle and request
 * accounting because it runs after handleSpecialAgentChatCompletion returns.
 *
 * Deltas are sanitized incrementally with PathSanitizeStream so no sensitive
 * literal can leak across a chunk boundary. Reasoning chunks are forwarded as
 * reasoning_content only when explicitly opted in.
 */
function streamLiveAcp({ id, created, model, messages, prompt, modelKey, acct, runner, signal, onDone }) {
  return {
    status: 200,
    stream: true,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    handler: async (res) => {
      const send = data => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };
      const msgSanitizer = new PathSanitizeStream();
      const showReasoning = exposeReasoning();
      let emittedText = '';
      let emittedReasoning = false;

      // SURV-02: own a per-request AbortController bound to client disconnect.
      // The route-level signal (server shutdown etc.) is chained in. Without
      // this, a client hangup leaves the spawned ACP process running until
      // DEVIN_TIMEOUT_MS (10 min default); with DEVIN_MAX_PROCS=1 that wedges
      // the whole backend on a single abandoned stream. runDevinAcpProcess
      // already kills the child on abort — we just have to fire it.
      const abortController = new AbortController();
      const onUpstreamAbort = () => abortController.abort();
      if (signal) {
        if (signal.aborted) abortController.abort();
        else signal.addEventListener('abort', onUpstreamAbort, { once: true });
      }
      // res is a Node http.ServerResponse in production (always has .on); guard
      // for minimal test/writable mocks that omit the EventEmitter surface.
      if (typeof res.on === 'function') {
        res.on('close', () => {
          if (!res.writableEnded) abortController.abort();
        });
      }

      // P0-3: SSE keepalive. Devin "thinking" can be silent for tens of
      // seconds; without bytes, idle timers (client, nginx, CDN) drop the
      // stream. `:` comment frames are ignored by SSE parsers.
      const ping = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
      }, acpPingMs());
      const stopPing = () => clearInterval(ping);

      send({ id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });

      const onChunk = ({ kind, text }) => {
        if (kind === 'message') {
          const safe = msgSanitizer.feed(text);
          if (safe) {
            emittedText += safe;
            send({ id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { content: safe }, finish_reason: null }] });
          }
        } else if (kind === 'thought' && showReasoning) {
          emittedReasoning = true;
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] });
        }
      };

      let ok = true;
      let runErr = null;
      try {
        const result = await runner(prompt, { modelKey, apiKey: acct?.apiKey || '', apiServerUrl: acct?.apiServerUrl || '', signal: abortController.signal, onChunk });
        const tail = msgSanitizer.flush();
        if (tail) {
          emittedText += tail;
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { content: tail }, finish_reason: null }] });
        }
        // Fallback for runners that return text/reasoning without streaming via
        // onChunk (non-chunking runners or test mocks): emit the returned value
        // so the stream is never empty when the runner produced output.
        if (showReasoning && !emittedReasoning && result?.reasoning) {
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { reasoning_content: sanitizeText(result.reasoning) }, finish_reason: null }] });
        }
        if (!emittedText && result?.text) {
          const safe = sanitizeText(result.text);
          emittedText = safe;
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { content: safe }, finish_reason: null }] });
        }
        // H7: map the ACP stop_reason instead of hardcoding 'stop'.
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(result?.stopReason) }] });
        // H3: bill real ACP usage when the runner reported it; estimate otherwise.
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [], usage: pickUsage(result?.usage, messages, emittedText) });
      } catch (err) {
        ok = false;
        runErr = err;
        // Headers are already sent (200), so surface the failure as a terminal
        // SSE error event rather than an HTTP status the client can no longer
        // see. Use a non-stop finish_reason so clients that ignore the bare
        // error frame don't mistake a failed run for a clean completion (H2).
        send({ error: { type: err?.type || 'backend_error', message: sanitizeText(err?.message || 'Special-agent stream failed') } });
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: {}, finish_reason: 'error' }] });
      } finally {
        stopPing();
        if (signal) signal.removeEventListener('abort', onUpstreamAbort);
        if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
        if (onDone) onDone(ok, runErr);
      }
    },
  };
}

async function checkoutAccount(callerKey, modelKey = null) {
  if (process.env.DEVIN_CLI_USE_ACCOUNT_POOL === '0') return null;
  // AP-GAP-1: thread the real modelKey so getApiKey applies the same
  // entitlement filter the Cascade path gets — without it a free account with
  // no SWE/Devin entitlement is selected, then fails late at ACP authenticate,
  // burning a process spawn + RPM slot.
  return getApiKey([], modelKey, callerKey);
}

/**
 * Report the outcome of a special-agent run back to the account pool so the
 * pool's health tracking (error streak → status='error', rate-limit windows,
 * ban detection) actually works on the Devin path. Without this the pool has
 * zero feedback: a banned/rate-limited key keeps getting reselected and failing
 * on every request (AP-GAP-2, the top P0 from both the self-audit and the
 * kiro.rs study). Mirrors how the Cascade path classifies upstream errors.
 *
 * Cooldowns use FIXED durations, never an accumulating default — kiro.rs's
 * hard-won lesson was that exponential default_duration snowballs (60→90→135s)
 * into a self-inflicted outage. markRateLimited already clamps to a fixed
 * window per call.
 */
function reportRunFailure(apiKey, err, deps = {}) {
  if (!apiKey) return;
  const status = Number(err?.status) || 0;
  const message = String(err?.message || '');
  const banSignal = deps.reportBanSignal || reportBanSignal;
  const rateLimited = deps.markRateLimited || markRateLimited;
  const internalError = deps.reportInternalError || reportInternalError;
  const genericError = deps.reportError || reportError;
  // Account-level ban/suspension shapes — promote to banned after 2 hits.
  if (looksLikeBanSignal(message)) {
    banSignal(apiKey, message);
    return;
  }
  // 429 rate limit — fixed-window cooldown, optionally per-model upstream.
  if (status === 429) {
    rateLimited(apiKey);
    return;
  }
  // 402 quota exhausted — treat as a longer rate-limit so the key rotates out
  // without being permanently disabled (it recovers when quota resets).
  if (status === 402) {
    rateLimited(apiKey, 30 * 60 * 1000);
    return;
  }
  // Upstream "internal error" shapes are account-specific and sticky.
  if (status >= 500 && /internal error/i.test(message)) {
    internalError(apiKey);
    return;
  }
  // Generic failure — feeds the windowed error streak (3-in-window disables).
  genericError(apiKey);
}

export async function handleSpecialAgentChatCompletion(body, route, deps = {}) {
  const started = Date.now();
  const modelKey = route?.modelKey || body?.model || '';
  const model = route?.model || body?.model || modelKey || config.defaultModel;
  const messages = Array.isArray(route?.messages) ? route.messages : (body?.messages || []);
  const id = route?.id || 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 29);
  const created = route?.created || Math.floor(Date.now() / 1000);
  const tools = Array.isArray(body?.tools) ? body.tools : [];

  if (!configuredBackend()) {
    return errorResponse(
      503,
      'backend_unavailable',
      `${model} requires the optional special-agent backend. Set WINDSURFAPI_SPECIAL_AGENT_BACKEND=devin-cli and DEVIN_CLI_PATH to test Devin CLI/ACP routing.`,
      { backend: 'special_agent' },
    );
  }
  if (tools.length && process.env.DEVIN_CLI_ALLOW_CLIENT_TOOLS !== '1') {
    return errorResponse(
      400,
      'unsupported_tool_boundary',
      'Devin CLI print backend does not safely expose caller-local tools yet. Use a normal Cascade model, or wait for ACP tool bridging.',
      { backend: 'devin-cli', tool_count: tools.length },
    );
  }
  if (hasUnsupportedMedia(messages) && process.env.DEVIN_CLI_ALLOW_MEDIA !== '1') {
    return errorResponse(
      400,
      'unsupported_media',
      'Devin CLI print backend currently accepts text-only requests. Media/vision requires ACP or an explicit media adapter.',
      { backend: 'devin-cli' },
    );
  }

  const prompt = buildSpecialAgentPrompt(messages);
  if (!prompt) {
    return errorResponse(400, 'invalid_request_error', 'Special-agent request has no text prompt.', { param: 'messages' });
  }

  let acct = null;
  let handedOff = false;
  try {
    if (process.env.DEVIN_CLI_USE_ACCOUNT_POOL !== '0') {
      const checkout = deps.checkoutAccount || checkoutAccount;
      acct = await checkout(route?.callerKey || '', modelKey);
      if (!acct) {
        return errorResponse(503, 'pool_exhausted', 'No active account is available for Devin CLI special-agent backend.');
      }
    }
    const mode = String(process.env.DEVIN_CLI_MODE || 'print').trim().toLowerCase();
    const runner = mode === 'acp'
      ? (deps.runDevinAcp || runDevinAcp)
      : (deps.runDevinPrint || runDevinPrint);

    // Live streaming is only meaningful for ACP, whose runner emits chunks via
    // onChunk. Print mode has no incremental output, so it keeps the buffered
    // streamFromText path. The live streamer runs the runner itself, so it owns
    // the account release + request accounting via onDone.
    if (body?.stream && mode === 'acp') {
      const releaser = deps.releaseAccount || releaseAccount;
      const onSuccess = deps.reportSuccess || reportSuccess;
      const stream = streamLiveAcp({
        id, created, model, messages, prompt, modelKey, acct, runner,
        signal: route?.signal || null,
        onDone: (ok, err) => {
          recordRequest(model, ok, Date.now() - started, acct?.id || null);
          // AP-GAP-2: feed pool health from the streaming path too.
          if (acct?.apiKey) {
            if (ok) onSuccess(acct.apiKey);
            else {
              reportRunFailure(acct.apiKey, err, deps);
              // AP-RISK-3: a failed request shouldn't keep burning an RPM slot
              // (free tier RPM=10; consecutive failures would fake-saturate).
              (deps.refundReservation || refundReservation)(acct.apiKey, acct.reservationTimestamp);
            }
            releaser(acct.apiKey);
          }
        },
      });
      handedOff = true;
      return stream;
    }

    const result = await runner(prompt, {
      modelKey,
      apiKey: acct?.apiKey || '',
      apiServerUrl: acct?.apiServerUrl || '',
      signal: route?.signal || null,
    });
    const text = sanitizeText(result?.text || '');
    const reasoning = exposeReasoning() ? sanitizeText(result?.reasoning || '') : '';
    if (result?.stderr) log.debug(`special-agent devin stderr: ${String(result.stderr).slice(0, 240)}`);
    recordRequest(model, true, Date.now() - started, acct?.id || null);
    if (acct?.apiKey) (deps.reportSuccess || reportSuccess)(acct.apiKey);
    // H3/H7: carry the runner's real usage + stop_reason through both shapes
    // (null on print runners → pickUsage/mapFinishReason fall back gracefully).
    const usage = result?.usage || null;
    const stopReason = result?.stopReason || null;
    if (body?.stream) return streamFromText({ id, created, model, messages, text, reasoning, usage, stopReason });
    return { status: 200, body: chatCompletionBody({ id, created, model, messages, text, reasoning, usage, stopReason }) };
  } catch (err) {
    const status = err?.status || 502;
    const type = err?.type || 'backend_error';
    log.warn(`special-agent ${modelKey} failed: ${err.message}`);
    recordRequest(model, false, Date.now() - started, acct?.id || null);
    // AP-GAP-2: classify the failure back to the pool (rate-limit / ban /
    // internal / generic error) so a bad key stops being reselected.
    if (acct?.apiKey) {
      reportRunFailure(acct.apiKey, err, deps);
      // AP-RISK-3: refund the RPM reservation so a failed request doesn't keep
      // a free-tier slot (RPM=10) occupied and fake-saturate the account.
      (deps.refundReservation || refundReservation)(acct.apiKey, acct.reservationTimestamp);
    }
    return errorResponse(status, type, sanitizeText(err.message || 'Special-agent backend failed'), {
      backend: 'devin-cli',
    });
  } finally {
    // The live streamer owns the account when handedOff: it releases in onDone
    // after the stream completes. Releasing here would pull the key mid-stream.
    if (!handedOff && acct?.apiKey) {
      const releaser = deps.releaseAccount || releaseAccount;
      releaser(acct.apiKey);
    }
  }
}
