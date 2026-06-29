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
import { getApiKey, releaseAccount } from './auth.js';
import { config, log } from './config.js';
import { recordRequest } from './dashboard/stats.js';
import { sanitizeText } from './sanitize.js';
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

export function buildSpecialAgentPrompt(messages) {
  const lines = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m?.role || 'user';
    const text = textFromContent(m?.content).trim();
    if (!text) continue;
    if (role === 'system') lines.push(`System:\n${text}`);
    else if (role === 'assistant') lines.push(`Assistant:\n${text}`);
    else if (role === 'tool') lines.push(`Tool result:\n${text}`);
    else lines.push(`User:\n${text}`);
  }
  return lines.join('\n\n').trim();
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

export async function runDevinAcp(prompt, { modelKey = '', apiKey = '', apiServerUrl = '', signal = null } = {}) {
  const release = await acquireSlot(signal);
  try {
    return await runDevinAcpProcess(prompt, { modelKey, apiKey, apiServerUrl, signal });
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

function chatCompletionBody({ id, created, model, messages, text, reasoning = '' }) {
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
      finish_reason: 'stop',
    }],
    usage: estimateTokens(messages, text),
  };
}

function streamFromText({ id, created, model, messages, text, reasoning = '' }) {
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
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      send({ id, object: 'chat.completion.chunk', created, model,
        choices: [], usage: estimateTokens(messages, text) });
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    },
  };
}

async function checkoutAccount(callerKey) {
  if (process.env.DEVIN_CLI_USE_ACCOUNT_POOL === '0') return null;
  return getApiKey([], null, callerKey);
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
  try {
    if (process.env.DEVIN_CLI_USE_ACCOUNT_POOL !== '0') {
      const checkout = deps.checkoutAccount || checkoutAccount;
      acct = await checkout(route?.callerKey || '');
      if (!acct) {
        return errorResponse(503, 'pool_exhausted', 'No active account is available for Devin CLI special-agent backend.');
      }
    }
    const mode = String(process.env.DEVIN_CLI_MODE || 'print').trim().toLowerCase();
    const runner = mode === 'acp'
      ? (deps.runDevinAcp || runDevinAcp)
      : (deps.runDevinPrint || runDevinPrint);
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
    if (body?.stream) return streamFromText({ id, created, model, messages, text, reasoning });
    return { status: 200, body: chatCompletionBody({ id, created, model, messages, text, reasoning }) };
  } catch (err) {
    const status = err?.status || 502;
    const type = err?.type || 'backend_error';
    log.warn(`special-agent ${modelKey} failed: ${err.message}`);
    recordRequest(model, false, Date.now() - started, acct?.id || null);
    return errorResponse(status, type, sanitizeText(err.message || 'Special-agent backend failed'), {
      backend: 'devin-cli',
    });
  } finally {
    if (acct?.apiKey) {
      const releaser = deps.releaseAccount || releaseAccount;
      releaser(acct.apiKey);
    }
  }
}
