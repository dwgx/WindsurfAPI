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
// The CLI child receives the pool credential in its env (:428-431) and its stderr
// is folded into the message the CALLER sees (:504, and :692/:925 hand that message
// to the client), so a CLI that prints its own token on an auth failure would leak
// it. sanitizeText is a path/XML redactor and does not know any credential shape —
// measured 2026-09-13: auth1_/devin-session-token$/JWT all passed through it.
import { redactCredentialFragments, buildSubprocessEnv } from './log-safety.js';
import { runDevinAcpProcess, probeDevinCliAvailable, acpVisionEnabled } from './devin-acp.js';
import { extractInlineImages as extractImagesFromContent } from './devin-connect.js';
import { systemFingerprint } from './system-fingerprint.js';
import { getBackendSwitch, strictUsageTotal } from './runtime-config.js';
import { budgetExceededError, isBudgetExceededError } from './request-budget.js';
import { toClientToolCallId } from './tool-ids.js';

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
  if (getBackendSwitch('devinOnly')) return true;
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

// Collect inline images across ALL message contents (devin-connect's
// extractInlineImages works per-content; this walks the whole conversation).
// Returns [{ base64_data, mime_type }] in message order — the ACP runner turns
// them into image content blocks. Kiro-style hygiene: cap total images so a
// pathological history can't blow the request body.
const ACP_MAX_IMAGES = 20;
function extractInlineImages(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!Array.isArray(m?.content)) continue;
    for (const img of extractImagesFromContent(m.content)) {
      out.push(img);
      if (out.length >= ACP_MAX_IMAGES) return out;
    }
  }
  return out;
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
    // WINDSURFAPI_STRICT_USAGE_TOTAL=1 means the client validates OpenAI's arithmetic
    // identity, so honour it here too rather than passing the runner's total through.
    //
    // This front was missed when the flag shipped: it forwards whatever the ACP runner
    // reported, so with the flag ON a Devin CLI / ACP model could still emit
    // total != prompt + completion and the flag would be two-thirds true. A flag that
    // holds on some protocol fronts and not others is worse than no flag, because the
    // client cannot tell which response it is looking at. Sixth occurrence of the
    // partial-path trap in this repo.
    //
    // No billing consequence either way: this path records via recordRequest (dashboard
    // counters), never recordAccountSpend, so no per-account spend tally reads this number.
    total_tokens: strictUsageTotal() ? (prompt + completion) : (total ?? (prompt + completion)),
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
//
// cline-01: never report finish_reason:'tool_calls' unless tool_calls were
// actually emitted. Cline's @ai-sdk client treats a 'tool_calls' finish with no
// tool_calls array as a broken response and retries to death (cline#9622). The
// print runner is text-only, so a tool-ish stop from it maps to 'stop'. The
// built-in ACP runner rejects tool-ish stops as backend_tool_call_unmapped.
// An injected runner can return explicit caller-owned calls.
// The content_filter test is deliberately NARROW. A bare `includes('content')`
// classified any reason with the substring "content" as a refusal, and the words
// upstreams actually use for a NORMAL completion contain it: `content_complete`,
// `no_content`, `contents_delivered`, `end_turn_content` all resolved to
// content_filter. That is not a cosmetic mislabel — content_filter closes a
// /v1/responses turn as `response.incomplete` and surfaces on /v1/messages as
// Anthropic `stop_reason:'refusal'`, so a completed answer was reported to the
// client as the model refusing to answer. A real refusal is visible in the reply
// text; a fabricated one is not something the client can recover from.
//
// So the filter vocabulary is matched on whole tokens (split on non-letters), not
// as substrings. `refusal` / `content_filter` / `content_policy` / `safety` still
// classify; `content_complete` no longer does.
const FILTER_TOKENS = new Set(['filter', 'filtered', 'refusal', 'refused', 'refuse',
  'safety', 'unsafe', 'blocked', 'policy', 'moderation', 'moderated', 'censored']);

function mapFinishReason(stopReason, hasToolCalls = false) {
  const r = String(stopReason || '').toLowerCase();
  if (!r) return 'stop';
  if (r.includes('max_tokens') || r.includes('max_token') || r.includes('length') || r.includes('truncat')) return 'length';
  if (r.includes('tool')) return hasToolCalls ? 'tool_calls' : 'stop';
  const tokens = r.split(/[^a-z]+/).filter(Boolean);
  if (tokens.some(t => FILTER_TOKENS.has(t))) return 'content_filter';
  return 'stop';
}
export { mapFinishReason };

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

function clientDisconnectResponse() {
  return errorResponse(499, 'client_disconnect', 'Client closed request', { code: 'client_disconnect' });
}

function requestAbortedError() {
  return Object.assign(new Error('Request aborted'), { status: 499, type: 'request_aborted' });
}

function isClientDisconnect(err, signal) {
  return signal?.aborted || Number(err?.status) === 499 || err?.type === 'request_aborted';
}

function acpBudgetError(budget) {
  return budgetExceededError(`Devin ACP request budget exhausted (${budget.describe()})`);
}

function acpBudgetResponse(err) {
  return errorResponse(504, 'upstream_deadline_exceeded',
    redactCredentialFragments(sanitizeText(err.message || 'Devin ACP request budget exhausted')),
    { code: 'windsurf_provider_deadline' });
}

function checkRequestAdmission(signal, budget) {
  if (signal?.aborted) throw requestAbortedError();
  if (budget && !budget.canStartAttempt()) throw acpBudgetError(budget);
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

function acquireSlot(signal, budget = null) {
  checkRequestAdmission(signal, budget);
  if (activeProcs < maxProcs()) {
    activeProcs++;
    return Promise.resolve(() => releaseSlot());
  }

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const queueMs = queueTimeoutMs();
    const waitMs = budget ? budget.waitMs(queueMs) : queueMs;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const idx = waiters.indexOf(waiter);
      if (idx !== -1) waiters.splice(idx, 1);
    };
    const onAbort = () => {
      cleanup();
      reject(requestAbortedError());
    };
    const waiter = {
      resolve: () => {
        cleanup();
        activeProcs++;
        resolve(() => releaseSlot());
      },
    };
    const timer = setTimeout(() => {
      cleanup();
      if (budget && (waitMs < queueMs || !budget.canStartAttempt())) {
        reject(acpBudgetError(budget));
        return;
      }
      reject(Object.assign(new Error(`Devin CLI process pool is full after ${Date.now() - started}ms`), {
        status: 503,
        type: 'backend_pool_exhausted',
      }));
    }, Math.ceil(waitMs));
    timer.unref?.();
    waiters.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
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
    mode: getBackendSwitch('devinCliMode'),
  };
}

export async function runDevinAcp(prompt, {
  modelKey = '', apiKey = '', apiServerUrl = '', signal = null, budget = null, onChunk = null, modelDiagnostics = null,
} = {}) {
  const release = await acquireSlot(signal, budget);
  try {
    checkRequestAdmission(signal, budget);
    // GAP-ACP-05: forward onChunk so the live streamer's incremental chunks
    // actually reach the ACP pump. Without this the wrapper silently drops it
    // and the "real-time" stream degrades to a single buffered flush at the end.
    return await runDevinAcpProcess(prompt, { modelKey, apiKey, apiServerUrl, signal, budget, onChunk, modelDiagnostics });
  } finally {
    release();
  }
}

export async function runDevinPrint(prompt, { modelKey = '', apiKey = '', signal = null } = {}) {
  const release = await acquireSlot(signal);
  try {
    checkRequestAdmission(signal);
    const mode = getBackendSwitch('devinCliMode');
    if (mode !== 'print') {
      throw Object.assign(new Error(`DEVIN_CLI_MODE=${mode} is not implemented yet; use print for the first PoC`), {
        status: 501,
        type: 'backend_mode_unsupported',
      });
    }

    const command = process.env.DEVIN_CLI_PATH || 'devin';
    const args = parseArgsTemplate(prompt, modelKey);
    const envName = process.env.DEVIN_CLI_API_KEY_ENV || 'WINDSURF_API_KEY';
    // Denylist env (L3b env-leak fix): the CLI needs general env (PATH, HOME,
    // proxy vars, operator DEVIN_* config) but must not inherit the proxy's
    // credentials. keep: envName — the ONE deliberate credential channel:
    // when a pool key exists it is written below (overwriting any ambient
    // value); when none exists (or DEVIN_CLI_USE_ACCOUNT_POOL=0) an ambient
    // value under that same name still passes through, matching the pre-fix
    // reachability without leaking anything else. SSH_AUTH_SOCK/SSH_AGENT_PID
    // stay so the agent's local tools keep git-over-ssh.
    const env = buildSubprocessEnv(process.env, {
      keep: [envName, 'SSH_AUTH_SOCK', 'SSH_AGENT_PID'],
    });
    if (apiKey && process.env.DEVIN_CLI_USE_ACCOUNT_POOL !== '0') {
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
        fatalError = requestAbortedError();
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
          // REDACT FIRST, THEN TRUNCATE. Slicing first splits a JWT at its first
          // dot and the credential regex no longer matches — the exact trap
          // documented in log-safety.js next to sliceRedactedJson.
          reject(Object.assign(new Error(`Devin CLI failed: ${redactCredentialFragments(detail).slice(0, 1000)}`), {
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

// Project a runner's caller-owned tool requests into OpenAI assistant.tool_calls.
function openAiToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return null;
  return toolCalls.map((tc, index) => ({
    id: toClientToolCallId(tc.id, `call_${index}_${Date.now().toString(36)}`),
    type: 'function',
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.input ?? {}),
    },
  }));
}

function chatCompletionBody({ id, created, model, messages, text, reasoning = '', usage = null, stopReason = null, toolCalls = null }) {
  const calls = openAiToolCalls(toolCalls);
  const message = { role: 'assistant', content: text || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (calls) message.tool_calls = calls;
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    system_fingerprint: systemFingerprint(model),
    service_tier: 'default',
    choices: [{
      index: 0,
      message,
      finish_reason: mapFinishReason(stopReason, !!calls),
    }],
    usage: pickUsage(usage, messages, text),
  };
}

function streamFromText({ id, created, model, messages, text, reasoning = '', usage = null, stopReason = null, includeUsage = false }) {
  return {
    status: 200,
    stream: true,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    handler: async (res) => {
      const fp = systemFingerprint(model);
      const send = data => {
        if (data && data.object === 'chat.completion.chunk') {
          if (data.system_fingerprint == null) data.system_fingerprint = fp;
          if (data.service_tier == null) data.service_tier = 'default';
        }
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
      // O1: trailing usage frame only when the caller opted in via
      // stream_options.include_usage (OpenAI omits it by default).
      if (includeUsage) {
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [], usage: pickUsage(usage, messages, text) });
      }
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
function streamLiveAcp({ id, created, model, messages, prompt, modelKey, acct, runner, signal, budget, onDone, includeUsage = false, modelDiagnostics }) {
  return {
    status: 200,
    stream: true,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    handler: async (res) => {
      const fp = systemFingerprint(model);
      const abortController = new AbortController();
      const abortSignal = abortController.signal;
      const canWrite = () => !abortSignal.aborted && !res.writableEnded && !res.destroyed;
      const send = data => {
        if (data && data.object === 'chat.completion.chunk') {
          if (data.system_fingerprint == null) data.system_fingerprint = fp;
          if (data.service_tier == null) data.service_tier = 'default';
        }
        if (canWrite()) res.write(`data: ${JSON.stringify(data)}\n\n`);
      };
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
      const onRouteAbort = () => abortController.abort(signal.reason);
      if (signal) {
        if (signal.aborted) onRouteAbort();
        else signal.addEventListener('abort', onRouteAbort, { once: true });
      }
      const onClose = () => {
        if (!res.writableEnded) abortController.abort();
      };
      res.on?.('close', onClose);
      if (res.destroyed || res.writableEnded) abortController.abort();

      const onChunk = ({ kind, text }) => {
        if (!canWrite()) return;
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

      let completed = false;
      let runErr = null;
      let ping;
      try {
        checkRequestAdmission(abortSignal, budget);
        // Devin may be silent while reasoning. SSE comments keep the connection open.
        ping = setInterval(() => {
          if (canWrite()) res.write(': ping\n\n');
        }, acpPingMs());
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });

        checkRequestAdmission(abortSignal, budget);
        const result = await runner(prompt, {
          modelKey, apiKey: acct?.apiKey || '', apiServerUrl: acct?.apiServerUrl || '',
          signal: abortSignal, budget, onChunk, modelDiagnostics,
        });
        completed = true;
        if (!canWrite()) return;
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
        // Emit explicit caller-owned requests from a runner as complete
        // deltas before the terminal chunk.
        const calls = openAiToolCalls(result?.toolCalls);
        if (calls) {
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: {
              tool_calls: calls.map((tc, index) => ({ index, ...tc })),
            }, finish_reason: null }] });
        }
        // H7: map the ACP stop_reason instead of hardcoding 'stop'.
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(result?.stopReason, !!calls) }] });
        // H3: bill real ACP usage when the runner reported it; estimate otherwise.
        // O1: only forward the usage frame when the caller opted in.
        if (includeUsage) {
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [], usage: pickUsage(result?.usage, messages, emittedText) });
        }
      } catch (err) {
        runErr = err;
        if (!canWrite()) return;
        // Headers are already sent (200), so surface the failure as a terminal
        // SSE error event rather than an HTTP status the client can no longer
        // see. Use a non-stop finish_reason so clients that ignore the bare
        // error frame don't mistake a failed run for a clean completion (H2).
        const failure = isBudgetExceededError(err) ? acpBudgetResponse(err)
          : isClientDisconnect(err, abortSignal) ? clientDisconnectResponse() : null;
        const error = failure ? { ...failure.body.error, status: failure.status } : {
          type: err?.type || 'backend_error',
          message: redactCredentialFragments(sanitizeText(err?.message || 'Special-agent stream failed')),
        };
        send({ error });
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: {}, finish_reason: 'error' }] });
      } finally {
        clearInterval(ping);
        signal?.removeEventListener('abort', onRouteAbort);
        res.removeListener?.('close', onClose);
        try {
          if (canWrite()) res.write('data: [DONE]\n\n');
          if (canWrite()) res.end();
        } finally {
          onDone?.({
            completed,
            error: runErr,
            disconnected: (res.destroyed && !res.writableEnded) || isClientDisconnect(runErr, abortSignal),
          });
        }
      }
    },
  };
}

async function checkoutAccount(callerKey, modelKey = null, trackReservation = false) {
  if (process.env.DEVIN_CLI_USE_ACCOUNT_POOL === '0') return null;
  // AP-GAP-1: thread the real modelKey so getApiKey applies the same
  // entitlement filter the Cascade path gets — without it a free account with
  // no SWE/Devin entitlement is selected, then fails late at ACP authenticate,
  // burning a process spawn + RPM slot.
  return getApiKey([], modelKey, callerKey, null, { trackReservation });
}

function canReportAccountHealth(acct) {
  return Boolean(acct?.apiKey && (acct.canReportHealth?.() ?? true));
}

function settleAccountCheckout(acct, refund, deps) {
  if (acct?.settleReservation) {
    acct.settleReservation(refund);
    return;
  }
  if (!acct?.apiKey) return;
  try {
    if (refund) (deps.refundReservation || refundReservation)(acct.apiKey, acct.reservationTimestamp);
  } finally {
    (deps.releaseAccount || releaseAccount)(acct.apiKey);
  }
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
  const type = String(err?.type || '');
  const message = String(err?.message || '');
  const banSignal = deps.reportBanSignal || reportBanSignal;
  const rateLimited = deps.markRateLimited || markRateLimited;
  const internalError = deps.reportInternalError || reportInternalError;
  const genericError = deps.reportError || reportError;
  // AC1 gap-c: a 503 backend_unavailable means the Devin CLI binary is missing
  // or not executable — an ENVIRONMENT fault, not an account fault. It must NOT
  // feed the windowed generic-error streak, or a missing/removed CLI would
  // wrongly disable every healthy account it touches (3 hits → status='error').
  // The proactive probe normally catches this before checkout, but the passive
  // post-spawn ENOENT→503 (probe disabled, print mode, or a TOCTOU race where
  // the binary vanishes between probe and spawn) still lands here, so guard it.
  if (status === 503 || type === 'backend_unavailable') {
    return;
  }
  // Cancellation and the route's budget do not report an account failure.
  if (isClientDisconnect(err) || isBudgetExceededError(err)) {
    return;
  }
  // Errors in the local ACP exchange should not change the account's health.
  if (type === 'backend_tool_call_unmapped' || type === 'backend_protocol_error') {
    return;
  }
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
  const signal = route?.signal ?? null;
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  // O1: OpenAI streams the trailing usage-only frame only when the caller sets
  // stream_options.include_usage:true; otherwise it is omitted.
  const includeUsage = body?.stream_options?.include_usage === true;

  if (!configuredBackend()) {
    return errorResponse(
      503,
      'backend_unavailable',
      `${model} requires the optional special-agent backend. Set WINDSURFAPI_SPECIAL_AGENT_BACKEND=devin-cli and DEVIN_CLI_PATH to test Devin CLI/ACP routing.`,
      { backend: 'special_agent' },
    );
  }
  if (tools.length && !getBackendSwitch('allowClientTools')) {
    return errorResponse(
      400,
      'unsupported_tool_boundary',
      'Caller-local tool declarations are disabled for the Devin CLI backend. Use a Cascade model for caller-local tool execution.',
      { backend: 'devin-cli', tool_count: tools.length },
    );
  }
  // Vision over ACP (gated by DEVIN_ACP_VISION): the ACP path forwards images as
  // first-class content blocks and the real CLI + server produce genuinely
  // signed turns — the clean route that works even for extended-thinking models
  // (opus-4-8), which the DEVIN_CONNECT synthetic-tool_result path CANNOT serve
  // (un-forgeable #12 signature). Verified end-to-end: opus saw a red/blue image.
  const acpMode = getBackendSwitch('devinCliMode') === 'acp';
  const visionOverAcp = acpMode && acpVisionEnabled() && hasUnsupportedMedia(messages);
  if (hasUnsupportedMedia(messages) && !visionOverAcp && process.env.DEVIN_CLI_ALLOW_MEDIA !== '1') {
    return errorResponse(
      400,
      'unsupported_media',
      'Devin CLI print backend currently accepts text-only requests. Media/vision requires ACP (set DEVIN_CLI_MODE=acp + DEVIN_ACP_VISION=1) or an explicit media adapter.',
      { backend: 'devin-cli' },
    );
  }

  const promptText = buildSpecialAgentPrompt(messages);
  // When vision-over-ACP is active, carry the extracted images alongside the text
  // as a structured prompt the ACP runner turns into image content blocks. Text
  // prompt alone must still be non-empty (an image with no text is allowed — the
  // images are the payload), so accept the request if EITHER text or images exist.
  const visionImages = visionOverAcp ? extractInlineImages(messages) : [];
  const prompt = visionImages.length ? { text: promptText, images: visionImages } : promptText;
  if (!promptText && !visionImages.length) {
    return errorResponse(400, 'invalid_request_error', 'Special-agent request has no text prompt.', { param: 'messages' });
  }

  let acct = null;
  let handedOff = false;
  let completed = false;
  try {
    const mode = getBackendSwitch('devinCliMode');
    const budget = mode === 'acp' ? route?.budget ?? null : null;
    checkRequestAdmission(signal, budget);
    // AC1 gap-e: proactively confirm the Devin CLI is runnable BEFORE we reserve
    // a pool account / spawn the ACP child. A missing or non-executable binary
    // is an ENVIRONMENT fault, not an account fault, so failing fast here avoids
    // burning a checkout + RPM slot only to hit ENOENT post-spawn. The probe is
    // zero-billable (devin --version only) and short-TTL cached. ACP-only:
    // print mode keeps its own post-spawn ENOENT→503.
    if (mode === 'acp') {
      const probe = deps.probeDevinCliAvailable || probeDevinCliAvailable;
      const status = await probe();
      checkRequestAdmission(signal, budget);
      if (status && status.available === false) {
        // 503 backend_unavailable — same shape the post-spawn ENOENT path emits,
        // so the upper layer (failover / client) handles it identically. The
        // pool is untouched because no account was checked out.
        return errorResponse(
          503,
          'backend_unavailable',
          `Devin CLI is not available for ACP routing (${status.reason || 'unavailable'}). Install the CLI or set DEVIN_CLI_PATH.`,
          { backend: 'devin-cli', probe_reason: status.reason || 'unavailable' },
        );
      }
    }
    if (process.env.DEVIN_CLI_USE_ACCOUNT_POOL !== '0') {
      const callerKey = route?.callerKey || '';
      acct = deps.checkoutAccount
        ? await deps.checkoutAccount(callerKey, modelKey)
        : await checkoutAccount(callerKey, modelKey, mode === 'acp');
      checkRequestAdmission(signal, budget);
      if (!acct) {
        return errorResponse(503, 'pool_exhausted', 'No active account is available for Devin CLI special-agent backend.');
      }
    }
    const runner = mode === 'acp'
      ? (deps.runDevinAcp || runDevinAcp)
      : (deps.runDevinPrint || runDevinPrint);
    const modelDiagnostics = { requestId: route?.requestId || id, requestedModel: body?.model ?? null };

    // Live streaming is only meaningful for ACP, whose runner emits chunks via
    // onChunk. Print mode has no incremental output, so it keeps the buffered
    // streamFromText path. The live streamer runs the runner itself, so it owns
    // the account release + request accounting via onDone.
    if (body?.stream && mode === 'acp') {
      const onSuccess = deps.reportSuccess || reportSuccess;
      const stream = streamLiveAcp({
        id, created, model, messages, prompt, modelKey, acct, runner, includeUsage, modelDiagnostics,
        signal, budget,
        onDone: ({ completed, error, disconnected }) => {
          try {
            recordRequest(model, completed && !error && !disconnected, Date.now() - started, acct?.id || null);
            // AP-GAP-2: feed pool health from the streaming path too.
            if (canReportAccountHealth(acct)) {
              if (completed) onSuccess(acct.apiKey);
              else if (!disconnected) reportRunFailure(acct.apiKey, error, deps);
            }
          } finally {
            settleAccountCheckout(acct, !completed, deps);
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
      signal,
      ...(mode === 'acp' ? { budget, modelDiagnostics } : {}),
    });
    completed = true;
    // A completed turn keeps its reservation even if the caller closed
    // before the buffered response could be delivered.
    const disconnected = signal?.aborted === true;
    let response;
    if (disconnected) {
      response = clientDisconnectResponse();
    } else {
      const text = sanitizeText(result?.text || '');
      const reasoning = exposeReasoning() ? sanitizeText(result?.reasoning || '') : '';
      if (result?.stderr) log.debug(`special-agent devin stderr: ${String(result.stderr).slice(0, 240)}`);
      // H3/H7: ACP usage and stop_reason pass through both shapes.
      const usage = result?.usage || null;
      const stopReason = result?.stopReason || null;
      const toolCalls = result?.toolCalls || null;
      response = body?.stream
        ? streamFromText({ id, created, model, messages, text, reasoning, usage, stopReason, includeUsage })
        : { status: 200, body: chatCompletionBody({ id, created, model, messages, text, reasoning, usage, stopReason, toolCalls }) };
    }
    recordRequest(model, !disconnected, Date.now() - started, acct?.id || null);
    if (canReportAccountHealth(acct)) (deps.reportSuccess || reportSuccess)(acct.apiKey);
    return response;
  } catch (err) {
    recordRequest(model, false, Date.now() - started, acct?.id || null);
    if (isClientDisconnect(err, signal)) return clientDisconnectResponse();
    if (isBudgetExceededError(err)) return acpBudgetResponse(err);
    const status = err?.status || 502;
    const type = err?.type || 'backend_error';
    log.warn(`special-agent ${modelKey} failed: ${err?.message}`);
    // AP-GAP-2: classify the failure back to the pool (rate-limit / ban /
    // internal / generic error) so a bad key stops being reselected.
    if (!completed && canReportAccountHealth(acct)) reportRunFailure(acct.apiKey, err, deps);
    // sanitizeText handles paths; redactCredentialFragments handles credentials.
    // Both are needed: err.message can carry CLI stderr, which can carry a token.
    return errorResponse(status, type, redactCredentialFragments(sanitizeText(err?.message || 'Special-agent backend failed')), {
      backend: 'devin-cli',
    });
  } finally {
    // The live streamer owns the account when handedOff: it releases in onDone
    // after the stream completes. Releasing here would pull the key mid-stream.
    if (!handedOff) settleAccountCheckout(acct, !completed, deps);
  }
}

// Test-only surface. pickUsage decides this front's total_tokens shape, and it was the one
// usage builder the WINDSURFAPI_STRICT_USAGE_TOTAL flag missed on its first pass — exposing
// it means that front is checked by assertion rather than by reading.
export const __testing = { pickUsage, estimateTokens };
