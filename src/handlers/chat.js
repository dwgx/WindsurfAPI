/**
 * POST /v1/chat/completions — OpenAI-compatible chat completions.
 * Routes to RawGetChatMessage (legacy) or Cascade (premium) based on model type.
 */

import { createHash, randomUUID } from 'crypto';
import { WindsurfClient, isCascadeTransportError } from '../client.js';
import { getApiKey, acquireAccountByKey, releaseAccount, getAccountAvailability, reportError, reportSuccess, markRateLimited, reportInternalError, updateCapability, getAccountList, isAllRateLimited, isAllTemporarilyUnavailable, refundReservation } from '../auth.js';
import { resolveModel, getModelInfo } from '../models.js';
import { getLsFor, ensureLs } from '../langserver.js';
import { config, log } from '../config.js';
import { recordRequest } from '../dashboard/stats.js';
import { isModelAllowed } from '../dashboard/model-access.js';
import { cacheKey, cacheGet, cacheSet } from '../cache.js';
import { isExperimentalEnabled } from '../runtime-config.js';
import { checkMessageRateLimit } from '../windsurf-api.js';
import { getEffectiveProxy } from '../dashboard/proxy-config.js';
import {
  fingerprintBefore, fingerprintAfter, checkout as poolCheckout, checkin as poolCheckin,
} from '../conversation-pool.js';
import {
  normalizeMessagesForCascade, ToolCallStreamParser, parseToolCallsFromText,
  buildToolPreambleForProto,
} from './tool-emulation.js';
import { sanitizeText, sanitizeToolCall, PathSanitizeStream } from '../sanitize.js';
import { registerSseController } from '../sse-registry.js';

const HEARTBEAT_MS = 15_000;
const QUEUE_RETRY_MS = 1_000;
const QUEUE_MAX_WAIT_MS = 30_000;

// Cap exponential backoff before falling over to the next account when
// upstream Cascade returns "internal error occurred". Without this a
// 9-account pool hammers the upstream within ~10s and every attempt
// sees the same transient — the OpenClaw real-scenario probe (#28)
// caught this as 11/20 failures even though the proxy itself is
// healthy. With backoff capped at 5s the Nth attempt sees a cooler
// upstream and has a meaningful chance of succeeding.
//   retry 0 → 500ms, 1 → 1s, 2 → 2s, 3 → 4s, ≥4 → 5s
async function internalErrorBackoff(retryIdx) {
  const ms = Math.min(500 * Math.pow(2, retryIdx), 5000);
  await new Promise(r => setTimeout(r, ms));
  return ms;
}

function upstreamTransientErrorMessage(model, triedCount, reason = 'internal_error') {
  const detail = reason === 'cascade_transport'
    ? 'Cascade/语言服务器 HTTP/2 流被取消'
    : 'internal_error';
  return `${model} 上游 Windsurf Cascade 服务瞬态故障：已在 ${triedCount} 个账号上重试都收到 ${detail}。这是上游或本地语言服务器会话的瞬时问题，建议 30-60 秒后重试；若连续出现，请重启语言服务器。`;
}

export function isUpstreamTransientError(err, isInternal = false) {
  return !!err && (isInternal || err.kind === 'transient_stall' || isCascadeTransportError(err));
}

function shortHash(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

export function redactRequestLogText(text) {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, 'sk-***')
    .replace(/(?:ant-api\d{2}|sk-ant-api\d{2})-[A-Za-z0-9_-]{20,}/g, 'sk-ant-***')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, 'jwt-***')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***')
    .replace(/\b(cookie|set-cookie)\s*:\s*[^\n\r]+/gi, '$1: ***')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '***@***');
}

function requestLogSummary(text, limit = 220) {
  const raw = String(text || '');
  if (process.env.DEBUG_REQUEST_BODIES === '1') {
    return `head="${redactRequestLogText(raw.slice(0, limit)).replace(/\n/g, '\\n').replace(/"/g, '\\"')}"`;
  }
  return `len=${raw.length} hash=${shortHash(raw)}`;
}

export function chatStreamError(message, type = 'upstream_error', code = null) {
  return { error: { message: sanitizeText(message || 'Upstream stream error'), type, code } };
}

/**
 * Extract a clean JSON payload from a model response. Handles three common
 * shapes a non-constrained-decoding model produces when asked for JSON:
 *
 *   1. Fenced code block:   ```json\n{...}\n```
 *   2. Preamble + fence:    Here is the JSON:\n```\n{...}\n```
 *   3. Bare JSON with noise: Sure! {...} Let me know if ...
 *
 * Returns the raw (unparsed) JSON substring so the caller can serialize it
 * straight through. Falls back to the trimmed original text if nothing
 * parseable is found, matching what OpenAI's json_object mode does when the
 * model produces invalid JSON (the response still flows, parsing is the
 * caller's responsibility).
 */
function extractJsonPayload(text) {
  if (!text) return text;
  // 1. Fenced code block — most common with Cascade
  const fence = text.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) {
    const inner = fence[1].trim();
    try { JSON.parse(inner); return inner; } catch { /* fall through */ }
  }
  // 2. Scan for the first balanced {...} or [...] block that parses
  const trimmed = text.trim();
  for (let start = 0; start < trimmed.length; start++) {
    const ch = trimmed[start];
    if (ch !== '{' && ch !== '[') continue;
    const open = ch;
    const close = ch === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (escape) { escape = false; continue; }
      if (c === '\\' && inStr) { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          const candidate = trimmed.slice(start, i + 1);
          try { JSON.parse(candidate); return candidate; } catch { /* keep scanning */ }
          break;
        }
      }
    }
  }
  return trimmed;
}

const CASCADE_REUSE_STRICT = process.env.CASCADE_REUSE_STRICT === '1';
const CASCADE_REUSE_STRICT_RETRY_MS = (() => {
  const n = parseInt(process.env.CASCADE_REUSE_STRICT_RETRY_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();
const OPUS47_TOOL_EMULATED_REUSE = process.env.OPUS47_TOOL_EMULATED_REUSE !== '0';
const OPUS47_STRICT_REUSE = process.env.OPUS47_STRICT_REUSE !== '0';

function isToolSensitiveOpusModel(modelKey = '') {
  // Opus-class models share the same prompt-injection / Claude-Code-tools
  // sensitivity profile, regardless of whether the version label is dotted
  // (claude-opus-4.6) or dashed (claude-opus-4-7-high). #59 confirmed 4.6
  // hits the same multi-turn tool-context loss as 4.7, so the strict-reuse
  // and multimodal-tool-fallback gates apply to both.
  return /^claude-opus-4(?:[.-]6|[.-]7)(?:[-.]|$)/i.test(String(modelKey || ''));
}

// Tool-emulated requests are normally kept out of cascade_id reuse because
// <tool_call>/<tool_result> bodies drift across turns. Opus 4.6 / 4.7 +
// Claude Code is the exception: replaying the full prompt/tools/image
// history is worse than preserving the exact upstream cascade, so enable
// a narrow local path.
export function shouldUseCascadeReuse({ useCascade, emulateTools, modelKey, allowToolReuse = OPUS47_TOOL_EMULATED_REUSE }) {
  if (!useCascade) return false;
  if (!emulateTools) return true;
  return !!allowToolReuse && isToolSensitiveOpusModel(modelKey);
}

function shouldForceCascadeReuse({ emulateTools, modelKey }) {
  return !!emulateTools && OPUS47_TOOL_EMULATED_REUSE && isToolSensitiveOpusModel(modelKey);
}

export function shouldUseStrictCascadeReuse({ emulateTools, modelKey, strict = CASCADE_REUSE_STRICT, allowOpus47Strict = OPUS47_STRICT_REUSE }) {
  return !!strict || (!!emulateTools && !!allowOpus47Strict && isToolSensitiveOpusModel(modelKey));
}

function hasMultimodalContent(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some(m => Array.isArray(m?.content) && m.content.some(p => {
    const type = String(p?.type || '').toLowerCase();
    return type === 'image' || type === 'image_url' || type === 'input_image'
      || type === 'document' || type === 'file' || type === 'input_file'
      || p?.source?.type === 'base64' || p?.image_url;
  }));
}

function strictReuseRetryMs(availability) {
  return Math.max(1000, availability?.retryAfterMs || CASCADE_REUSE_STRICT_RETRY_MS);
}

function strictReuseMessage(model, retryMs, reason = 'temporarily unavailable') {
  return `${model} 上下文复用绑定账号暂不可用（${reason}）。为避免切换账号导致上下文丢失，请 ${Math.ceil(retryMs / 1000)} 秒后重试`;
}

export function rateLimitCooldownMs(message = '') {
  const m = String(message || '').match(/(?:retry (?:after|in)|after)\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (unit.startsWith('h')) return n * 60 * 60 * 1000;
    if (unit.startsWith('m')) return n * 60 * 1000;
    return n * 1000;
  }
  if (/about an hour|in an hour|try again in.*hour/i.test(message)) return 60 * 60 * 1000;
  return 60 * 1000;
}

function genId() {
  return 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 29);
}

const MODEL_PROVIDERS = {
  claude: 'Anthropic', gpt: 'OpenAI', gemini: 'Google', deepseek: 'DeepSeek',
  grok: 'xAI', qwen: 'Alibaba', kimi: 'Moonshot', glm: 'Zhipu', swe: 'Windsurf',
  o3: 'OpenAI', o4: 'OpenAI',
};

export function neutralizeCascadeIdentity(text, modelName) {
  if (!text || !modelName) return text;
  const provider = MODEL_PROVIDERS[Object.keys(MODEL_PROVIDERS).find(k => modelName.toLowerCase().startsWith(k)) || ''];
  if (!provider) return text;
  return text
    // First-person identity claims
    .replace(/\bI am Cascade\b/gi, `I am ${modelName}`)
    .replace(/\bI'm Cascade\b/gi, `I'm ${modelName}`)
    .replace(/\bmy name is Cascade\b/gi, `my name is ${modelName}`)
    // Third-person self-reference common in Cascade prose
    .replace(/\bCascade, an AI coding assistant\b/gi, `${modelName}, an AI assistant`)
    .replace(/\bCascade is an? (?:AI )?(?:coding )?assistant\b/gi, `${modelName} is an AI assistant`)
    .replace(/\b(?:As|Acting as) Cascade\b/g, `As ${modelName}`)
    // Provider attribution
    .replace(/\bCascade, made by (?:Codeium|Windsurf)\b/gi, `${modelName}, made by ${provider}`)
    .replace(/\b(?:Codeium|Windsurf)(?:['’]s)? Cascade\b/g, modelName)
    .replace(/\bdeveloped by (?:Codeium|Windsurf)\b/gi, `developed by ${provider}`)
    .replace(/\bcreated by (?:Codeium|Windsurf)\b/gi, `created by ${provider}`)
    .replace(/\bbuilt by (?:Codeium|Windsurf)\b/gi, `built by ${provider}`)
    // Cascade-flavoured workspace narration. The model regularly says things
    // like "Cascade's workspace at /tmp/windsurf-workspace" — sanitizeText
    // already scrubs the path; this strips the lingering "Cascade's" /
    // "the Cascade" prefix so the sentence reads naturally. The leading
    // "the " is consumed by the same regex so we don't end up with the
    // double-article artefact ("the the workspace").
    .replace(/\b(?:the )?Cascade(?:['’]s)? workspace\b/gi, 'the workspace');
}

/**
 * Lift authoritative environment facts from the caller's request so they
 * can be re-emitted into the proto-level tool_calling_section override.
 *
 * Why this exists: Claude Code (and most Anthropic-format clients) put
 * working-directory / git / platform info in an `<env>` block inside the
 * system prompt or a `<system-reminder>` user block. That information IS
 * forwarded to Cascade (client.js prepends sysText to the user text), but
 * Cascade's own planner system prompt is structurally more authoritative
 * to the upstream model than user-message text — and Cascade's prompt
 * tells the model "your workspace is /tmp/windsurf-workspace". Result:
 * Opus issues LS / Read against /tmp/windsurf-workspace instead of the
 * user's real cwd, and confidently narrates the contents of an empty
 * scratch dir back as if it were the user's project.
 *
 * Lifting cwd into tool_calling_section gives it equal authority weight
 * inside the model's mental model, and the surrounding wording in
 * buildToolPreambleForProto explicitly tells the model to prefer THIS
 * environment over any prior workspace assumption.
 *
 * Parser is intentionally lenient: it scans every message's text content
 * (string or content-block array) and pulls out the standard Claude Code
 * `<env>` keys. If nothing is found, returns '' and the override gets no
 * environment block (existing behaviour preserved).
 */
export function extractCallerEnvironment(messages, options = {}) {
  if (!Array.isArray(messages)) return '';
  const allowed = new Set(
    Array.isArray(options.fields) && options.fields.length
      ? options.fields.map(v => String(v || '').toLowerCase())
      : ['cwd', 'git', 'platform', 'os']
  );
  const seen = new Set();
  const out = [];

  // Match the cwd phrasing every Anthropic-format client we have seen in
  // the wild emits, while staying narrow enough that prose mentions like
  // "the working directory in the docs" don't trip it. Two formats matter:
  //
  //   (a) Canonical `<env>` key/value block (older Claude Code, opencode,
  //       Cline): `Working directory: /path` on its own line. Must allow
  //       a leading `<env>` tag, optional `-`/`*` bullet prefix, and `:`
  //       or `=` separator.
  //
  //   (b) Claude Code 2.1+ prose system prompt: `…and the current working
  //       directory is /path.`  No newline anchor, no separator, the path
  //       just trails the phrase. (Confirmed via the env-NOT-lifted probe
  //       diagnostic against Claude Code v2.1.114.)
  //
  // The capture group is locked to `[/~]…` so we only grab actual-looking
  // paths — "the working directory you choose" or similar abstract prose
  // never has a `/` or `~` in the captured slot and is rejected.
  const PATH_TAIL = `[\\/~][^\\s\`'"<>\\n.,;)]+`;
  const PATTERNS = [
    ['cwd', new RegExp(
      // Form (a): line-anchored key/value
      `(?:^|\\n)\\s*(?:[-*]\\s+)?(?:Working directory|cwd|<cwd>)\\s*[:=]\\s*\`?(${PATH_TAIL})\`?` +
      // Form (b): prose "current working directory is /path"
      `|(?:current\\s+working\\s+directory(?:\\s+is)?)\\s*[:=]?\\s*\`?(${PATH_TAIL})\`?`,
      'i'
    ), (v) => `- Working directory: ${v}`],
    ['git', /(?:^|\n)\s*(?:[-*]\s+)?Is directory a git repo\s*[:=]\s*([^\n<]+)/i, (v) => `- Is the directory a git repo: ${v}`],
    ['platform', /(?:^|\n)\s*(?:[-*]\s+)?Platform\s*[:=]\s*([^\n<]+)/i, (v) => `- Platform: ${v}`],
    ['os', /(?:^|\n)\s*(?:[-*]\s+)?OS Version\s*[:=]\s*([^\n<]+)/i, (v) => `- OS version: ${v}`],
  ];

  for (const m of messages) {
    if (!m) continue;
    let content;
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n');
    else continue;
    if (!content) continue;

    for (const [key, re, fmt] of PATTERNS) {
      if (!allowed.has(key)) continue;
      if (seen.has(key)) continue;
      const match = content.match(re);
      if (match) {
        // The cwd pattern has two alternative capture groups (one per
        // accepted form); the others have one. Pick the first non-empty.
        const value = (match[1] || match[2] || '').trim();
        // Reject obvious garbage (empty after trim, control chars, our own
        // redaction marker leaking back in).
        if (!value || /[\x00-\x1f]/.test(value) || value === '…') continue;
        seen.add(key);
        out.push(fmt(value));
      }
    }
    if (seen.size === PATTERNS.length) break;
  }

  // Only emit an environment block if we actually have the cwd. Platform /
  // OS / git status without cwd are useless for the original goal (tell
  // the model where to run tools) AND adding them anyway makes the
  // tool_calling_section preamble look like a system prompt with no
  // real signal — which trips Opus 4.7's injection guard, observed live
  // when Claude Code v2.1.114 (which does NOT include cwd in its system
  // prompt) caused us to emit an env block containing only Platform +
  // OS Version, and Opus refused with "the message I received is a
  // system prompt for Claude Code along with truncated tool output".
  // Sticking to the rule "no cwd → no block" both removes the noise and
  // lets the model learn cwd via its own `pwd` tool call (which already
  // works on every Anthropic-format client we have tested).
  if (!allowed.has('cwd') || !seen.has('cwd')) return '';
  return out.join('\n');
}

export function resolveForwardedCallerEnvironment(messages, options = {}) {
  const enabled = options.enabled == null ? !!config.forwardCallerEnv : !!options.enabled;
  if (!enabled) return '';
  const fields = Array.isArray(options.fields) ? options.fields : config.forwardCallerEnvFields;
  return extractCallerEnvironment(messages, { fields });
}

// Rough token estimate (~4 chars/token). Used only to populate the
// OpenAI-compatible `usage.prompt_tokens_details.cached_tokens` field so
// upstream billing/dashboards (new-api) can recognise our local cache hits.
function estimateTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    if (typeof m?.content === 'string') chars += m.content.length;
    else if (Array.isArray(m?.content)) {
      for (const p of m.content) if (typeof p?.text === 'string') chars += p.text.length;
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}

function cachedUsage(messages, completionText) {
  const prompt = estimateTokens(messages);
  const completion = Math.max(1, Math.ceil((completionText || '').length / 4));
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    input_tokens: prompt,
    output_tokens: completion,
    prompt_tokens_details: { cached_tokens: prompt },
    completion_tokens_details: { reasoning_tokens: 0 },
    cached: true,
  };
}

/**
 * Build an OpenAI-shaped `usage` object, preferring server-reported token
 * counts from Cascade's CortexStepMetadata.model_usage when available, and
 * falling back to the local chars/4 estimate otherwise. Keeps the same shape
 * in both branches so downstream billing doesn't have to care which source
 * produced the numbers.
 *
 * The Cascade backend reports usage as {inputTokens, outputTokens,
 * cacheReadTokens, cacheWriteTokens}. We map them onto the OpenAI shape:
 *   prompt_tokens     = inputTokens + cacheReadTokens + cacheWriteTokens
 *                       (total input tokens the model processed, whether fresh,
 *                       cache-read, or cache-written — matches the OpenAI
 *                       convention where prompt_tokens is the grand total)
 *   completion_tokens = outputTokens
 *   prompt_tokens_details.cached_tokens       = cacheReadTokens
 *   cache_creation_input_tokens (Anthropic ext) = cacheWriteTokens
 */
function buildUsageBody(serverUsage, messages, completionText, thinkingText = '') {
  if (serverUsage && (serverUsage.inputTokens || serverUsage.outputTokens)) {
    const inputTokens = serverUsage.inputTokens || 0;
    const outputTokens = serverUsage.outputTokens || 0;
    const cacheRead = serverUsage.cacheReadTokens || 0;
    const cacheWrite = serverUsage.cacheWriteTokens || 0;
    const promptTotal = inputTokens + cacheRead + cacheWrite;
    return {
      prompt_tokens: promptTotal,
      completion_tokens: outputTokens,
      total_tokens: promptTotal + outputTokens,
      input_tokens: promptTotal,
      output_tokens: outputTokens,
      prompt_tokens_details: { cached_tokens: cacheRead },
      completion_tokens_details: { reasoning_tokens: 0 },
      cache_creation_input_tokens: cacheWrite,
    };
  }
  const prompt = estimateTokens(messages);
  const completion = Math.max(1, Math.ceil(((completionText || '').length + (thinkingText || '').length) / 4));
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

// Wait until getApiKey returns a non-null account, or until maxWaitMs expires.
// Used when every account has momentarily exhausted its RPM budget so the
// client is queued instead of getting a 503.
async function waitForAccount(tried, signal, maxWaitMs = QUEUE_MAX_WAIT_MS, modelKey = null) {
  const deadline = Date.now() + maxWaitMs;
  let acct = getApiKey(tried, modelKey);
  while (!acct) {
    if (signal?.aborted) return null;
    if (Date.now() >= deadline) return null;
    await new Promise(r => setTimeout(r, QUEUE_RETRY_MS));
    acct = getApiKey(tried, modelKey);
  }
  return acct;
}

export async function handleChatCompletions(body, context = {}) {
  const reqId = Math.random().toString(36).slice(2, 8);
  const {
    model: reqModel,
    stream = false,
    max_tokens,
    tools,
    tool_choice,
    response_format,
  } = body;
  let messages = body.messages;
  const callerKey = context.callerKey || body.__callerKey || '';
  const checkMessageRateLimitFn = context.checkMessageRateLimit || checkMessageRateLimit;
  const waitForAccountFn = context.waitForAccount || waitForAccount;

  // Probe diagnostics: default to structure-only metadata, with optional
  // prompt sampling when LOG_PROMPT_SAMPLES=1.
  try {
    const contentTypes = new Set();
    let lastUserBytes = 0;
    for (const m of (messages || [])) {
      if (typeof m?.content === 'string') contentTypes.add('string');
      else if (Array.isArray(m.content)) for (const p of m.content) contentTypes.add(p?.type || typeof p);
      if (m?.role === 'user') {
        const c = m.content;
        const lastUserText = typeof c === 'string'
          ? c
          : Array.isArray(c) ? c.filter(p => p?.type === 'text').map(p => p.text || '').join(' ') : '';
        lastUserBytes = lastUserText.length;
      }
    }
    log.info(`Probe[${reqId}]: model=${reqModel} stream=${!!stream} rf=${response_format?.type || 'none'} tools=${Array.isArray(tools) ? tools.length : 0} reasoning=${body.reasoning_effort || body.thinking?.type || 'none'} ctypes=[${[...contentTypes].join(',')}] turns=${messages?.length || 0} lastUserBytes=${lastUserBytes}`);
    if (config.logPromptSamples) {
      for (let mi = 0; mi < Math.min((messages || []).length, 3); mi++) {
        const m = messages[mi];
        const c = typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map(p => p?.type === 'text' ? p.text : `[${p?.type}]`).join('|') : '';
        log.info(`Probe[${reqId}] msg[${mi}] role=${m?.role} ${requestLogSummary(c)}`);
      }
    }
  } catch {}

  // Reject pathologically empty user turns. Without this, an empty
  // `user.content` slips through and the model answers against the
  // system prompt as if it were the user's prompt, producing nonsense
  // output (caught by the OpenClaw human-scenario probe — scenario #14).
  // Match OpenAI's behaviour: 400 invalid_request_error.
  {
    const lastUser = (messages || []).filter(m => m?.role === 'user').pop();
    if (lastUser) {
      const c = lastUser.content;
      let trimmedBytes = 0;
      if (typeof c === 'string') trimmedBytes = c.trim().length;
      else if (Array.isArray(c)) trimmedBytes = c.reduce((n, p) => {
        if (typeof p?.text === 'string') return n + p.text.trim().length;
        // Non-text parts (image_url / input_audio / file / etc.) count as
        // non-empty content — only pure-text empties trigger the 400.
        if (p && typeof p === 'object' && p.type && p.type !== 'text') return n + 1;
        return n;
      }, 0);
      if (trimmedBytes === 0) {
        return {
          status: 400,
          body: {
            error: {
              message: 'The last user message has empty content. Provide a non-empty user prompt.',
              type: 'invalid_request_error',
              param: 'messages',
            },
          },
        };
      }
    }
  }

  // Heavy clients (OpenClaw 24KB, opencode + omo, Cline with full tool
  // catalog) ship system prompts that approach Cascade's ~30KB panel-
  // state ceiling. When that happens upstream intermittently returns
  // `internal error occurred` or invalidates panel state. Surface the
  // size in logs so intermittent failures can be correlated with caller
  // payload rather than chased as proxy bugs.
  {
    const sysBytes = (messages || []).filter(m => m?.role === 'system').reduce((n, m) => {
      const c = m?.content;
      return n + (typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((k, p) => k + (typeof p?.text === 'string' ? p.text.length : 0), 0) : 0);
    }, 0);
    if (sysBytes >= 8000) {
      log.warn(`Probe[${reqId}]: large system prompt ${Math.round(sysBytes/1024)}KB — heavy clients (OpenClaw / Cline / opencode) may hit upstream panel-state retries above ~30KB`);
    }
  }

  const wantJson = response_format?.type === 'json_object' || response_format?.type === 'json_schema';
  if (wantJson) {
    let jsonHint = '\n\n[You MUST respond with valid JSON only. No markdown code fences, no explanation text, no prefix/suffix. Your entire response must be a single parseable JSON object.';
    if (response_format?.type === 'json_schema' && response_format?.json_schema?.schema) {
      jsonHint += ' Conform to this JSON Schema:\n' + JSON.stringify(response_format.json_schema.schema);
    }
    jsonHint += ']';
    const sysJsonMsg = { role: 'system', content: 'Respond with valid JSON only. No markdown, no code fences, no explanation. Output must be parseable by JSON.parse().' };
    messages = [sysJsonMsg, ...messages.map((m, i) => {
      if (i === messages.length - 1 && m.role === 'user') {
        const content = typeof m.content === 'string' ? m.content + jsonHint : m.content;
        return { ...m, content };
      }
      return m;
    })];
  }

  const modelKey = resolveModel(reqModel || config.defaultModel);
  const wantThinking = !!(body.thinking?.type === 'enabled' || body.reasoning_effort);
  let effectiveModelKey = modelKey;
  if (wantThinking && !modelKey.includes('thinking') && getModelInfo(modelKey + '-thinking')) {
    effectiveModelKey = modelKey + '-thinking';
  }
  const modelInfo = getModelInfo(effectiveModelKey) || getModelInfo(modelKey);
  // Return the user's original model name in response.model / response headers
  // so external test harnesses (e.g. hvoy.ai "model signature" check) see
  // exactly what they sent, not a Windsurf-internal alias like
  // `claude-opus-4-7-medium`. Fall back to the canonical name if the request
  // omitted model.
  const displayModel = reqModel || modelInfo?.name || config.defaultModel;
  const modelEnum = modelInfo?.enumValue || 0;
  const modelUid = modelInfo?.modelUid || null;
  // Cascade requires either a valid modelUid (string) or a recognized modelEnum.
  // Legacy RawGetChatMessage is deprecated (returns empty on current LS).
  // Models with only an old enum and no UID may fail with "neither PlanModel
  // nor RequestedModel" — those models were removed from Windsurf upstream.
  const useCascade = !!(modelUid || modelEnum);

  // Tool-call emulation: if the client passed OpenAI-style tools[], we rewrite
  // tool-result turns into synthetic user text and inject the tool protocol
  // at the system-prompt level via CascadeConversationalPlannerConfig's
  // tool_calling_section (SectionOverrideConfig, OVERRIDE mode). This is far
  // more reliable than user-message-level injection because NO_TOOL mode's
  // baked-in system prompt tells the model "you have no tools" — which
  // overpowers user-message preambles. The section override replaces that
  // section directly so the model sees our emulated tool definitions as
  // authoritative system instructions.
  const hasTools = Array.isArray(tools) && tools.length > 0;
  const hasToolHistory = Array.isArray(messages) && messages.some(m => m?.role === 'tool' || (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length));
  const emulateTools = useCascade && (hasTools || hasToolHistory);
  // Build proto-level preamble (goes into tool_calling_section override).
  // Also inject into the last user message as fallback — some models in
  // NO_TOOL mode ignore the SectionOverride entirely and refuse to call
  // tools unless they see the definitions in the conversation itself. (#22)
  // Lift the caller's environment hints (cwd, git status, platform) into
  // the proto-level system slot so Cascade's authoritative planner system
  // prompt can no longer override them with /tmp/windsurf-workspace
  // priors. See extractCallerEnvironment() above for the parser.
  const callerEnv = emulateTools ? resolveForwardedCallerEnvironment(messages) : '';
  const toolPreamble = emulateTools ? buildToolPreambleForProto(tools || [], tool_choice, callerEnv) : '';
  // Diagnostic: surface whether environment lifting actually fired so a real
  // request log immediately tells us if Claude Code 2.x changed `<env>` block
  // wording, or if the extraction guard rejected a valid hint. Cheap to log,
  // and the alternative is a 200-char Probe head that hides the env block.
  if (emulateTools) {
    if (callerEnv) {
      const compact = callerEnv.replace(/\s+/g, ' ').slice(0, 200);
      log.info(`Chat[${reqId}]: env lifted into tool_calling_section: ${compact}`);
    } else {
      // Hunt for env-shaped substrings so we can see WHY the extractor
      // missed (e.g. Claude Code put cwd in a freeform paragraph instead
      // of the canonical `Working directory: …` line).
      let probe = '';
      for (const m of (messages || [])) {
        const c = typeof m?.content === 'string' ? m.content
          : Array.isArray(m?.content) ? m.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n')
          : '';
        const hit = c.match(/[^.\n]{0,40}(?:working directory|cwd|<env>|<cwd>)[^.\n]{0,80}/i);
        if (hit) { probe = hit[0].replace(/\s+/g, ' ').slice(0, 160); break; }
      }
      log.info(`Chat[${reqId}]: env NOT lifted (extractor returned empty)${probe ? '; nearest env-shaped substring in messages: ' + probe : '; no env-shaped substring found in any message'}`);
    }
  }
  const disableUserToolFallback = emulateTools && isToolSensitiveOpusModel(modelKey) && hasMultimodalContent(messages);
  if (disableUserToolFallback) {
    log.info(`Chat[${reqId}]: disabled user-message tool fallback for Opus 4.x multimodal turn`);
  }
  let cascadeMessages = emulateTools
    ? normalizeMessagesForCascade(messages, tools, { injectUserPreamble: !disableUserToolFallback })
    : [...messages];

  // Note: previous versions injected (a) a CJK language-following hint into
  // the last user message and (b) a per-provider identity system prompt
  // ("You are Claude Opus...") when the experimental modelIdentityPrompt
  // toggle was on. Both were removed per issue #48 — users reported unwanted
  // system prompt residue even after turning the toggle off, and the CJK
  // hint surfaced as an English `[IMPORTANT...]` line appended to their own
  // message. Cascade's own communication_section (proto field 13) already
  // handles identity neutrally; response-side neutralizeCascadeIdentity
  // still rewrites stray "I am Cascade" leaks without touching inputs.

  // Deprecated models were dropped from Windsurf upstream; their Cascade
  // request returns a cryptic "neither PlanModel nor RequestedModel
  // specified" 502 that callers mis-diagnose as a transient failure and
  // retry forever. Surface it as a clean 410 + model_deprecated so the
  // caller knows to switch models. Baseline probe (scripts/probes/
  // tool-emission-probe.mjs) hit this on gpt-4o-mini ×3 variants × 5
  // samples = 15/15 upstream_error; 9 models are currently flagged
  // deprecated in src/models.js.
  if (modelInfo?.deprecated) {
    return {
      status: 410,
      body: {
        error: {
          message: `模型 ${displayModel} 已被 Windsurf 上游废弃，不再可用。建议切换到当前可用模型（如 gemini-2.5-flash、claude-haiku-4-5、claude-sonnet-4-6）。`,
          type: 'model_deprecated',
        },
      },
    };
  }

  // Global model access control (allowlist / blocklist from dashboard)
  const access = isModelAllowed(modelKey);
  if (!access.allowed) {
    return { status: 403, body: { error: { message: access.reason, type: 'model_blocked' } } };
  }

  // Per-account model routing preflight: if NO active account has this
  // model in its tier ∩ available list, fail fast instead of looping
  // through every account trying to find one. This surfaces tier
  // entitlement and blocklist errors as a clean 403 rather than a 30s
  // queue timeout → pool_exhausted.
  const anyEligible = getAccountList().some(a =>
    a.status === 'active' && (a.availableModels || []).includes(modelKey)
  );
  if (!anyEligible) {
    return {
      status: 403,
      body: {
        error: {
          message: `模型 ${displayModel} 在当前账号池中不可用（未订阅或已被封禁）`,
          type: 'model_not_entitled',
        },
      },
    };
  }

  const chatId = genId();
  const created = Math.floor(Date.now() / 1000);
  const ckey = cacheKey(body);

  if (stream) {
    return streamResponse(chatId, created, displayModel, modelKey, messages, cascadeMessages, modelEnum, modelUid, useCascade, ckey, emulateTools, toolPreamble, reqId, wantJson, callerKey, {
      checkMessageRateLimit: checkMessageRateLimitFn,
      waitForAccount: waitForAccountFn,
    });
  }

  // ── Local response cache (exact body match) ─────────────
  const cached = cacheGet(ckey);
  if (cached) {
    log.info(`Chat: cache HIT model=${displayModel} flow=non-stream`);
    recordRequest(displayModel, true, 0, null);
    const message = { role: 'assistant', content: cached.text || null };
    if (cached.thinking) message.reasoning_content = cached.thinking;
    return {
      status: 200,
      body: {
        id: chatId, object: 'chat.completion', created, model: displayModel,
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage: cachedUsage(messages, cached.text),
      },
    };
  }

  // ── Cascade conversation pool (experimental) ──
  // If the client is continuing a prior conversation and we still hold the
  // cascade_id from last turn, pin this request to that exact (account, LS)
  // pair so the Windsurf backend serves from its hot per-cascade context
  // instead of replaying the whole history.
  //
  // Conversation reuse lets Cascade keep server-side context across turns.
  const reuseEnabled = shouldUseCascadeReuse({ useCascade, emulateTools, modelKey })
    && (isExperimentalEnabled('cascadeConversationReuse') || shouldForceCascadeReuse({ emulateTools, modelKey }));
  const strictReuse = shouldUseStrictCascadeReuse({ emulateTools, modelKey });
  const fpBefore = reuseEnabled ? fingerprintBefore(messages, modelKey, callerKey) : null;
  let reuseEntry = reuseEnabled ? poolCheckout(fpBefore, callerKey) : null;
  let checkedOutReuseEntry = reuseEntry;
  if (reuseEntry) log.info(`Chat[${reqId}]: reuse HIT cascade=${reuseEntry.cascadeId.slice(0, 8)} model=${displayModel}`);

  // Non-stream: retry with a different account on model-not-available errors
  const tried = [];
  let lastErr = null;
  // Count upstream_internal_error hits separately from rate_limit / model
  // errors. When >0 we add backoff between attempts (give upstream a
  // breather), and when ALL attempts hit it we surface a clean
  // upstream_transient_error instead of the misleading "rate limit"
  // message the all-accounts-exhausted branch would otherwise produce.
  let internalCount = 0;
  // Dynamic: try every active account in the pool (capped at 10) so a
  // large pool with many rate-limited accounts can still fall through
  // to a free one. Was hardcoded 3 — in pools bigger than 3 with the
  // first accounts rate-limited, healthy accounts were never reached
  // even though they would have worked (issue #5).
  const maxAttempts = Math.min(10, Math.max(3, getAccountList().filter(a => a.status === 'active').length));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let acct = null;
    if (reuseEntry && attempt === 0) {
      acct = acquireAccountByKey(reuseEntry.apiKey, modelKey);
      if (!acct) {
        // Owning account busy — wait up to 5s for it instead of immediately
        // giving up. Dropping reuse means falling back to text-blob history
        // which loses context on most models.
        for (let w = 0; w < 10 && !acct; w++) {
          await new Promise(r => setTimeout(r, 500));
          acct = acquireAccountByKey(reuseEntry.apiKey, modelKey);
        }
        if (!acct) {
          log.info(`Chat[${reqId}]: reuse MISS — owning account not available after 5s wait`);
          if (strictReuse && checkedOutReuseEntry && fpBefore) {
            const availability = getAccountAvailability(checkedOutReuseEntry.apiKey, modelKey);
            const retryAfterMs = strictReuseRetryMs(availability);
            poolCheckin(fpBefore, checkedOutReuseEntry, callerKey);
            log.info(`Chat[${reqId}]: strict reuse preserved cascade; owner unavailable reason=${availability.reason}`);
            return {
              status: 429,
              headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) },
              body: {
                error: {
                  message: strictReuseMessage(displayModel, retryAfterMs, availability.reason),
                  type: 'rate_limit_exceeded',
                  retry_after_ms: retryAfterMs,
                },
              },
            };
          }
          reuseEntry = null;
        }
      }
    }
    if (!acct) {
      acct = await waitForAccountFn(tried, null, QUEUE_MAX_WAIT_MS, modelKey);
      if (!acct) break;
    }
    tried.push(acct.apiKey);

    try {
    // Pre-flight rate limit check (experimental): ask server.codeium.com if
    // this account still has message capacity before burning an LS round trip.
    if (isExperimentalEnabled('preflightRateLimit')) {
      try {
        const px = getEffectiveProxy(acct.id) || null;
        const rl = await checkMessageRateLimitFn(acct.apiKey, px);
        if (!rl.hasCapacity) {
          log.warn(`Preflight: ${acct.email} has no capacity (remaining=${rl.messagesRemaining}), skipping`);
          refundReservation(acct.apiKey, acct.reservationTimestamp);
          if (Number.isFinite(rl.retryAfterMs) && rl.retryAfterMs > 0) {
            markRateLimited(acct.apiKey, rl.retryAfterMs, modelKey);
          }
          if (strictReuse && checkedOutReuseEntry && fpBefore && checkedOutReuseEntry.apiKey === acct.apiKey) {
            const availability = getAccountAvailability(acct.apiKey, modelKey);
            const retryAfterMs = strictReuseRetryMs(availability);
            poolCheckin(fpBefore, checkedOutReuseEntry, callerKey);
            log.info(`Chat[${reqId}]: strict reuse preserved cascade after preflight rate limit`);
            return {
              status: 429,
              headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) },
              body: {
                error: {
                  message: strictReuseMessage(displayModel, retryAfterMs, availability.reason),
                  type: 'rate_limit_exceeded',
                  retry_after_ms: retryAfterMs,
                },
              },
            };
          }
          continue;
        }
      } catch (e) {
        log.debug(`Preflight check failed for ${acct.email}: ${e.message}`);
        // Fail open — proceed with the request
      }
    }

    await ensureLs(acct.proxy);
    const ls = getLsFor(acct.proxy);
    if (!ls) { lastErr = { status: 503, body: { error: { message: 'No LS instance available', type: 'ls_unavailable' } } }; break; }
    // Cascade pins cascade_id to a specific LS port too; if the LS it was
    // born on has been replaced, the cascade_id is dead.
    if (reuseEntry && reuseEntry.lsPort !== ls.port) {
      log.info(`Chat[${reqId}]: reuse MISS — LS port changed`);
      checkedOutReuseEntry = null;
      reuseEntry = null;
    }
    const _msgChars = (messages || []).reduce((n, m) => {
      const c = m?.content;
      return n + (typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((k, p) => k + (typeof p?.text === 'string' ? p.text.length : 0), 0) : 0);
    }, 0);
    log.info(`Chat[${reqId}]: model=${displayModel} flow=${useCascade ? 'cascade' : 'legacy'} attempt=${attempt + 1} account=${acct.email} ls=${ls.port} turns=${(messages||[]).length} chars=${_msgChars}${reuseEntry ? ' reuse=1' : ''}${emulateTools ? ' tools=emu' : ''}`);
    const client = new WindsurfClient(acct.apiKey, ls.port, ls.csrfToken);
    const result = await nonStreamResponse(
      client, chatId, created, displayModel, modelKey, messages, cascadeMessages, modelEnum, modelUid,
      useCascade, acct.apiKey, ckey,
      reuseEnabled ? { reuseEntry, lsPort: ls.port, apiKey: acct.apiKey, callerKey } : null,
      emulateTools, toolPreamble, wantJson,
    );
    if (result.status === 200) return result;
    reuseEntry = null; // don't try to reuse on the retry
    lastErr = result;
    const errType = result.body?.error?.type;
    // Rate limit: this account is done for this model, try the next one
    if (errType === 'rate_limit_exceeded') {
      if (strictReuse && checkedOutReuseEntry && fpBefore && checkedOutReuseEntry.apiKey === acct.apiKey) {
        const availability = getAccountAvailability(acct.apiKey, modelKey);
        const retryAfterMs = strictReuseRetryMs(availability);
        poolCheckin(fpBefore, checkedOutReuseEntry, callerKey);
        log.info(`Chat[${reqId}]: strict reuse preserved cascade after rate limit`);
        return {
          status: 429,
          headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) },
          body: {
            error: {
              message: strictReuseMessage(displayModel, retryAfterMs, availability.reason),
              type: 'rate_limit_exceeded',
              retry_after_ms: retryAfterMs,
            },
          },
        };
      }
      log.warn(`Account ${acct.email} rate-limited on ${displayModel}, trying next account`);
      continue;
    }
    // Cascade transient 错误通常是上游或本地 LS 短暂抖动，先退避再切账号，避免连续打爆同一热窗口。
    if (errType === 'upstream_internal_error' || errType === 'upstream_transient_error') {
      internalCount++;
      const backoffMs = await internalErrorBackoff(internalCount - 1);
      log.warn(`Chat[${reqId}]: ${acct.email} upstream transient error, waited ${backoffMs}ms before next account`);
      continue;
    }
    // Model not available on this account (permission_denied, etc.)
    if (errType === 'model_not_available') {
      log.warn(`Account ${acct.email} cannot serve ${displayModel}, trying next account`);
      continue;
    }
    break; // other errors (502, transport) — don't retry
    } finally {
      // Pair every successful getApiKey/acquireAccountByKey with a release
      // so the in-flight-count based balancer in auth.js (issue #37) stays
      // accurate across success, retry, and abort paths.
      if (acct) releaseAccount(acct.apiKey);
    }
  }
  // 所有账号都遇到 Cascade transient 时，账号轮换已经无法修复；返回明确错误，避免误报成限流或模型不可用。
  if (internalCount > 0 && tried.length > 0 && internalCount >= tried.length) {
    if (checkedOutReuseEntry && fpBefore) {
      poolCheckin(fpBefore, checkedOutReuseEntry, callerKey);
      log.info(`Chat[${reqId}]: restored checked-out cascade after all-internal-error chain`);
    }
    const lastIsTransport = isCascadeTransportError(lastErr);
    log.error(`Chat[${reqId}]: ${tried.length}/${tried.length} accounts hit upstream transient error — surfacing upstream_transient_error`);
    return {
      status: 502,
      body: { error: { message: upstreamTransientErrorMessage(displayModel, tried.length, lastIsTransport ? 'cascade_transport' : 'internal_error'), type: 'upstream_transient_error' } },
    };
  }
  // If all accounts exhausted, check if it's because they're all rate-limited
  const temporaryUnavailable = isAllTemporarilyUnavailable(modelKey);
  if (temporaryUnavailable.allUnavailable) {
    if (checkedOutReuseEntry && fpBefore) {
      poolCheckin(fpBefore, checkedOutReuseEntry, callerKey);
      log.info(`Chat[${reqId}]: restored checked-out cascade after temporary unavailability`);
    }
    const retryAfterSec = Math.ceil(temporaryUnavailable.retryAfterMs / 1000);
    return {
      status: 429,
      headers: { 'Retry-After': String(retryAfterSec) },
      body: {
        error: {
          message: `${displayModel} 所有账号暂时不可用，请 ${retryAfterSec} 秒后重试`,
          type: 'rate_limit_exceeded',
          retry_after_ms: temporaryUnavailable.retryAfterMs,
        },
      },
    };
  }
  if (!lastErr || lastErr.status === 429) {
    const rl = isAllRateLimited(modelKey);
    if (rl.allLimited) {
      if (checkedOutReuseEntry && fpBefore) {
        poolCheckin(fpBefore, checkedOutReuseEntry, callerKey);
        log.info(`Chat[${reqId}]: restored checked-out cascade after rate limit`);
      }
      const retryAfterSec = Math.ceil(rl.retryAfterMs / 1000);
      return { status: 429, headers: { 'Retry-After': String(retryAfterSec) }, body: { error: { message: `${displayModel} 所有账号均已达速率限制，请 ${retryAfterSec} 秒后重试`, type: 'rate_limit_exceeded', retry_after_ms: rl.retryAfterMs } } };
    }
  }
  if (checkedOutReuseEntry && fpBefore) {
    poolCheckin(fpBefore, checkedOutReuseEntry, callerKey);
    log.info(`Chat[${reqId}]: restored checked-out cascade after failed request`);
  }
  return lastErr || { status: 503, body: { error: { message: 'No active accounts available', type: 'pool_exhausted' } } };
}

async function nonStreamResponse(client, id, created, model, modelKey, messages, cascadeMessages, modelEnum, modelUid, useCascade, apiKey, ckey, poolCtx, emulateTools, toolPreamble, wantJson = false) {
  const startTime = Date.now();
  try {
    let allText = '';
    let allThinking = '';
    let cascadeMeta = null;
    let toolCalls = [];
    // Server-reported token usage from CortexStepMetadata.model_usage, summed
    // across all trajectory steps. Preferred over the chars/4 estimate when
    // present so downstream billing (new-api, etc.) sees real Cascade numbers.
    let serverUsage = null;

    if (useCascade) {
      const chunks = await client.cascadeChat(cascadeMessages, modelEnum, modelUid, { reuseEntry: poolCtx?.reuseEntry || null, toolPreamble, displayModel: model });
      for (const c of chunks) {
        if (c.text) allText += c.text;
        if (c.thinking) allThinking += c.thinking;
      }
      cascadeMeta = {
        cascadeId: chunks.cascadeId,
        sessionId: chunks.sessionId,
        stepOffset: chunks.stepOffset,
        generatorOffset: chunks.generatorOffset,
      };
      serverUsage = chunks.usage || null;
      {
        const parsed = parseToolCallsFromText(allText);
        allText = parsed.text;
        toolCalls = parsed.toolCalls;
      }
      // Built-in Cascade tool calls (chunks.toolCalls — edit_file, view_file,
      // list_directory, run_command, etc.) are intentionally DROPPED. Their
      // argumentsJson and result fields reference server-internal paths like
      // /tmp/windsurf-workspace/config.yaml and must never be exposed to an
      // API caller. Emulated tool calls (above) are safe because they
      // reference the caller's own tool schema.
    } else {
      const chunks = await client.rawGetChatMessage(messages, modelEnum, modelUid);
      for (const c of chunks) {
        if (c.text) allText += c.text;
      }
    }

    // Scrub server-internal filesystem paths from everything we're about to
    // return. See src/sanitize.js for the patterns and rationale.
    allText = sanitizeText(allText);
    allText = neutralizeCascadeIdentity(allText, model);
    if (wantJson && allText) {
      allText = extractJsonPayload(allText);
    }
    allThinking = sanitizeText(allThinking);
    if (toolCalls.length) {
      toolCalls = toolCalls.map(tc => sanitizeToolCall(tc));
    }

    // Check the cascade back into the pool under the *post-turn* fingerprint
    // so the next request in the same conversation can resume it.
    if (poolCtx && cascadeMeta?.cascadeId && (allText || toolCalls.length)) {
      const fpAfter = fingerprintAfter(messages, modelKey, poolCtx.callerKey || '');
      poolCheckin(fpAfter, {
        cascadeId: cascadeMeta.cascadeId,
        sessionId: cascadeMeta.sessionId,
        lsPort: poolCtx.lsPort,
        apiKey: poolCtx.apiKey,
        stepOffset: Number.isFinite(cascadeMeta.stepOffset) ? cascadeMeta.stepOffset : poolCtx.reuseEntry?.stepOffset,
        generatorOffset: Number.isFinite(cascadeMeta.generatorOffset) ? cascadeMeta.generatorOffset : poolCtx.reuseEntry?.generatorOffset,
        createdAt: poolCtx.reuseEntry?.createdAt,
      }, poolCtx.callerKey || '');
    }

    reportSuccess(apiKey);
    updateCapability(apiKey, modelKey, true, 'success');
    recordRequest(model, true, Date.now() - startTime, apiKey);

    // Store in cache for next identical request. Skip caching tool_call
    // responses — they're inherently contextual and the cache doesn't
    // preserve the tool_calls array, so a cache hit would return a
    // content-only response with finish_reason:stop, breaking tool flow.
    if (ckey && !toolCalls.length) cacheSet(ckey, { text: allText, thinking: allThinking });

    const message = { role: 'assistant', content: allText || null };
    if (allThinking) message.reasoning_content = allThinking;
    if (toolCalls.length) {
      message.tool_calls = toolCalls.map((tc, i) => ({
        id: tc.id || `call_${i}_${Date.now().toString(36)}`,
        type: 'function',
        function: {
          name: tc.name || 'unknown',
          arguments: tc.argumentsJson || tc.arguments || '{}',
        },
      }));
      // OpenAI convention: content is null when finish_reason is tool_calls.
      // In text emulation the model often emits an inline answer alongside the
      // <tool_call> block (e.g., hallucinated weather data). Set content to
      // null so clients that check `content !== null` behave correctly and the
      // caller waits for the real tool result rather than showing hallucinated
      // data.
      message.content = null;
    }

    // Prefer server-reported usage; fall back to chars/4 estimate only when
    // the trajectory didn't include a ModelUsageStats field.
    const usage = buildUsageBody(serverUsage, messages, allText, allThinking);
    const finishReason = toolCalls.length ? 'tool_calls' : 'stop';
    return {
      status: 200,
      body: {
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage,
      },
    };
  } catch (err) {
    // Only count true auth failures against the account. Workspace/cascade/model
    // errors and transport issues shouldn't disable the key.
    const isAuthFail = /unauthenticated|invalid api key|invalid_grant|permission_denied.*account/i.test(err.message);
    const isRateLimit = /rate limit|rate_limit|too many requests|quota/i.test(err.message);
    const isInternal = /internal error occurred.*error id/i.test(err.message);
    const isTransport = isCascadeTransportError(err);
    const isTransient = isUpstreamTransientError(err, isInternal);
    if (isAuthFail) reportError(apiKey);
    if (isRateLimit) { markRateLimited(apiKey, rateLimitCooldownMs(err.message), modelKey); err.isRateLimit = true; err.isModelError = true; err.kind ||= 'model_error'; }
    if (isInternal) { reportInternalError(apiKey); err.isModelError = true; err.kind ||= 'transient_stall'; }
    if (isTransport) { err.isModelError = true; err.kind ||= 'transient_stall'; }
    if (err.isModelError && err.kind !== 'transient_stall' && !isRateLimit && !isInternal) {
      updateCapability(apiKey, modelKey, false, 'model_error');
    }
    recordRequest(model, false, Date.now() - startTime, apiKey);
    log.error('Chat error:', err.message);
    // Rate limits → 429 with Retry-After; model errors → 403; others → 502
    if (isRateLimit) {
      const rl = isAllRateLimited(modelKey);
      const retryMs = rl.retryAfterMs || 60000;
      return {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(retryMs / 1000)) },
        body: { error: { message: `${model} 已达速率限制，请稍后重试`, type: 'rate_limit_exceeded', retry_after_ms: retryMs } },
      };
    }
    // LS crash on oversized payload — gRPC surfaces this as "pending stream
    // has been canceled" within a second. Give the user an actionable hint.
    const isStreamCanceled = /pending stream has been canceled|panel state|ECONNRESET/i.test(err.message);
    if (isStreamCanceled) {
      const chars = (messages || []).reduce((n, m) => {
        const c = m?.content;
        return n + (typeof c === 'string' ? c.length :
          Array.isArray(c) ? c.reduce((k, p) => k + (typeof p?.text === 'string' ? p.text.length : 0), 0) : 0);
      }, 0);
      if (chars > 500_000) {
        return {
          status: 413,
          body: { error: {
            message: `请求过大（${Math.round(chars / 1024)}KB 输入）导致语言服务器中断。请尝试：1) 分块发送；2) 先用摘要/summarization 预处理 PDF；3) 减少历史轮数`,
            type: 'payload_too_large',
          } },
        };
      }
    }
    return {
      status: isTransient ? 502 : (err.isModelError ? 403 : 502),
      body: { error: {
        message: isTransient
          ? upstreamTransientErrorMessage(model, 1, isTransport ? 'cascade_transport' : 'internal_error')
          : sanitizeText(err.message),
        type: isTransient ? 'upstream_transient_error' : (err.isModelError ? 'model_not_available' : 'upstream_error'),
      } },
    };
  }
}

function streamResponse(id, created, model, modelKey, messages, cascadeMessages, modelEnum, modelUid, useCascade, ckey, emulateTools, toolPreamble, reqId, wantJson = false, callerKey = '', deps = {}) {
  const checkMessageRateLimitFn = deps.checkMessageRateLimit || checkMessageRateLimit;
  const waitForAccountFn = deps.waitForAccount || waitForAccount;
  return {
    status: 200,
    stream: true,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
    async handler(res) {
      const abortController = new AbortController();
      let unregisterSse = () => {};
      res.on('close', () => {
        if (!res.writableEnded) {
          log.info('Client disconnected mid-stream, aborting upstream');
          abortController.abort();
        }
      });
      const send = (data) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      unregisterSse = registerSseController({
        abort(reason) {
          send(chatStreamError(reason || 'server shutting down', 'server_error', 'server_shutdown'));
          if (!res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
          abortController.abort(reason);
        },
      });

      // SSE heartbeat: keep the TCP/HTTP connection alive through any silent
      // period (LS warmup, Cascade "thinking", queue wait). `:` prefix is a
      // comment line per the SSE spec — clients ignore it, intermediaries see
      // bytes flowing, idle timers get reset.
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
      }, HEARTBEAT_MS);
      const stopHeartbeat = () => clearInterval(heartbeat);
      res.on('close', stopHeartbeat);

      // ── Cache hit: replay stored response as a fake stream ──
      const cached = cacheGet(ckey);
      if (cached) {
        log.info(`Chat: cache HIT model=${model} flow=stream`);
        recordRequest(model, true, 0, null);
        try {
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
          if (cached.thinking) {
            send({ id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { reasoning_content: cached.thinking }, finish_reason: null }] });
          }
          if (cached.text) {
            send({ id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { content: cached.text }, finish_reason: null }] });
          }
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [], usage: cachedUsage(messages, cached.text) });
          if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
        } finally {
          unregisterSse();
          stopHeartbeat();
        }
        return;
      }

      const startTime = Date.now();
      const tried = [];
      let hadSuccess = false;
      let rolePrinted = false;
      let currentApiKey = null;
      let lastErr = null;
      // Same purpose as nonStreamResponse's internalCount: track upstream
      // internal_error hits across attempts so we can (a) back off
      // between accounts and (b) surface upstream_transient_error when
      // every attempt hit it.
      let streamInternalCount = 0;
      // Dynamic: try every active account in the pool (capped at 10) so a
  // large pool with many rate-limited accounts can still fall through
  // to a free one. Was hardcoded 3 — in pools bigger than 3 with the
  // first accounts rate-limited, healthy accounts were never reached
  // even though they would have worked (issue #5).
  const maxAttempts = Math.min(10, Math.max(3, getAccountList().filter(a => a.status === 'active').length));

      // Accumulate chunks so we can cache a successful response at the end.
      let accText = '';
      let accThinking = '';

      // Cascade conversation pool (stream path). Opus 4.7 tool-emulated
      // requests opt in even when the global experiment toggle is off, because
      // replaying full Claude Code history is what triggers context blowups.
      const reuseEnabled = shouldUseCascadeReuse({ useCascade, emulateTools, modelKey })
        && (isExperimentalEnabled('cascadeConversationReuse') || shouldForceCascadeReuse({ emulateTools, modelKey }));
      const strictReuse = shouldUseStrictCascadeReuse({ emulateTools, modelKey });
      const fpBefore = reuseEnabled ? fingerprintBefore(messages, modelKey, callerKey) : null;
      let reuseEntry = reuseEnabled ? poolCheckout(fpBefore, callerKey) : null;
      let checkedOutReuseEntry = reuseEntry;
      if (reuseEntry) log.info(`Chat: cascade reuse HIT cascadeId=${reuseEntry.cascadeId.slice(0, 8)}… stream model=${model}`);

      // Always strip <tool_call>/<tool_result> blocks in Cascade mode.
      // In emulation mode, parsed calls are emitted as OpenAI tool_calls.
      // In non-emulation mode, blocks are silently stripped (defense-in-depth
      // against Cascade's system prompt inducing tool markup).
      //
      // These are re-created at the start of each retry attempt (before the
      // first chunk is consumed) so stale buffers from a failed attempt —
      // e.g. a half-read `<tool_call>` tag — can't corrupt the next
      // account's stream. `let` bindings so the retry loop below can
      // reassign.
      let toolParser = useCascade ? new ToolCallStreamParser() : null;
      const collectedToolCalls = [];

      // Streaming path sanitizers. Every text/thinking delta flows through a
      // PathSanitizeStream before leaving the server so /tmp/windsurf-workspace,
      // /opt/windsurf and /root/WindsurfAPI literals can never slip out even
      // if a path straddles a chunk boundary. See src/sanitize.js.
      let pathStreamText = new PathSanitizeStream();
      let pathStreamThinking = new PathSanitizeStream();

      const emitContent = (clean) => {
        if (!clean) return;
        accText += clean;
        // When response_format=json_object/json_schema is set, buffer text
        // instead of streaming it out. We can't safely fence-strip in the
        // middle of a stream (fence might straddle a chunk, and we'd need
        // lookahead). On finish we'll emit one clean JSON payload.
        if (wantJson) return;
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { content: clean }, finish_reason: null }] });
      };
      const emitThinking = (clean) => {
        if (!clean) return;
        accThinking += clean;
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { reasoning_content: clean }, finish_reason: null }] });
      };

      const emitToolCallDelta = (tc, idx) => {
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: {
            tool_calls: [{
              index: idx,
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: sanitizeText(tc.argumentsJson || '{}') },
            }],
          }, finish_reason: null }] });
      };

      const onChunk = (chunk) => {
        if (!rolePrinted) {
          rolePrinted = true;
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
        }
        hadSuccess = true;

        if (chunk.text) {
          // Pipeline for text deltas:
          //   raw chunk  →  ToolCallStreamParser (strip <tool_call> blocks)
          //              →  PathSanitizeStream   (scrub server paths)
          //              →  client
          let safeText = chunk.text;
          if (toolParser) {
            const parsed = toolParser.feed(chunk.text);
            safeText = parsed.text;
            if (Array.isArray(parsed.items) && parsed.items.length) {
              for (const item of parsed.items) {
                if (item.type === 'text') {
                  emitContent(pathStreamText.feed(item.text));
                  continue;
                }
                const tc = sanitizeToolCall(item.toolCall);
                const idx = collectedToolCalls.length;
                collectedToolCalls.push(tc);
                emitToolCallDelta(tc, idx);
              }
              safeText = '';
            } else {
              // Only emit tool_call deltas when emulating — otherwise the
              // parsed calls came from Cascade's built-in tools and are
              // silently discarded. Sanitize server-internal paths out of
              // the emulated call's input too (issue #38) — otherwise Claude
              // Code tries to Read the sandbox path and fails.
              for (const rawTc of parsed.toolCalls) {
                const tc = sanitizeToolCall(rawTc);
                const idx = collectedToolCalls.length;
                collectedToolCalls.push(tc);
                emitToolCallDelta(tc, idx);
              }
            }
          }
          if (safeText) emitContent(pathStreamText.feed(safeText));
        }
        if (chunk.thinking) {
          emitThinking(pathStreamThinking.feed(chunk.thinking));
        }
      };

      try {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (abortController.signal.aborted) return;
          // Rebuild per-attempt stream state so a prior failure's residue
          // (partial <tool_call>, half-scrubbed path) can't leak into the
          // retry. Skip on attempt 0 — already fresh. hadSuccess=true
          // means we already emitted content so no retry happens anyway.
          if (attempt > 0 && !hadSuccess) {
            if (useCascade) toolParser = new ToolCallStreamParser();
            pathStreamText = new PathSanitizeStream();
            pathStreamThinking = new PathSanitizeStream();
          }
          let acct = null;
          if (reuseEntry && attempt === 0) {
            acct = acquireAccountByKey(reuseEntry.apiKey, modelKey);
            if (!acct) {
              for (let w = 0; w < 10 && !acct && !abortController.signal.aborted; w++) {
                await new Promise(r => setTimeout(r, 500));
                acct = acquireAccountByKey(reuseEntry.apiKey, modelKey);
              }
              if (!acct) {
                log.info(`Chat[${reqId}]: reuse MISS — owning account not available after 5s wait`);
                if (strictReuse && checkedOutReuseEntry && fpBefore) {
                  const availability = getAccountAvailability(checkedOutReuseEntry.apiKey, modelKey);
                  const retryAfterMs = strictReuseRetryMs(availability);
                  lastErr = Object.assign(
                    new Error(strictReuseMessage(model, retryAfterMs, availability.reason)),
                    { type: 'rate_limit_exceeded' }
                  );
                  log.info(`Chat[${reqId}]: strict reuse preserved cascade; owner unavailable reason=${availability.reason}`);
                  break;
                }
                reuseEntry = null;
              }
            }
          }
          if (!acct) {
            acct = await waitForAccountFn(tried, abortController.signal, QUEUE_MAX_WAIT_MS, modelKey);
            if (!acct) break;
          }
          tried.push(acct.apiKey);
          currentApiKey = acct.apiKey;

          try {
          // Pre-flight rate limit check (experimental)
          if (isExperimentalEnabled('preflightRateLimit')) {
            try {
              const px = getEffectiveProxy(acct.id) || null;
              const rl = await checkMessageRateLimitFn(acct.apiKey, px);
              if (!rl.hasCapacity) {
                log.warn(`Preflight: ${acct.email} has no capacity (remaining=${rl.messagesRemaining}), skipping`);
                refundReservation(acct.apiKey, acct.reservationTimestamp);
                if (Number.isFinite(rl.retryAfterMs) && rl.retryAfterMs > 0) {
                  markRateLimited(acct.apiKey, rl.retryAfterMs, modelKey);
                }
                if (strictReuse && checkedOutReuseEntry && fpBefore && checkedOutReuseEntry.apiKey === acct.apiKey) {
                  const availability = getAccountAvailability(acct.apiKey, modelKey);
                  const retryAfterMs = strictReuseRetryMs(availability);
                  lastErr = Object.assign(
                    new Error(strictReuseMessage(model, retryAfterMs, availability.reason)),
                    { type: 'rate_limit_exceeded' }
                  );
                  log.info(`Chat[${reqId}]: strict reuse preserved cascade after preflight rate limit`);
                  break;
                }
                continue;
              }
            } catch (e) {
              log.debug(`Preflight check failed for ${acct.email}: ${e.message}`);
            }
          }

          try { await ensureLs(acct.proxy); } catch (e) { lastErr = e; break; }
          const ls = getLsFor(acct.proxy);
          if (!ls) { lastErr = new Error('No LS instance available'); break; }
          if (reuseEntry && reuseEntry.lsPort !== ls.port) {
            log.info(`Chat[${reqId}]: reuse MISS — LS port changed`);
            checkedOutReuseEntry = null;
            reuseEntry = null;
          }
          const _msgCharsStream = (messages || []).reduce((n, m) => {
            const c = m?.content;
            return n + (typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((k, p) => k + (typeof p?.text === 'string' ? p.text.length : 0), 0) : 0);
          }, 0);
          log.info(`Chat: model=${model} flow=${useCascade ? 'cascade' : 'legacy'} stream=true attempt=${attempt + 1} account=${acct.email} ls=${ls.port} turns=${(messages||[]).length} chars=${_msgCharsStream}${reuseEntry ? ' reuse=1' : ''}`);
          const client = new WindsurfClient(acct.apiKey, ls.port, ls.csrfToken);
          let cascadeResult = null;
          try {
            if (useCascade) {
              cascadeResult = await client.cascadeChat(cascadeMessages, modelEnum, modelUid, {
                onChunk, signal: abortController.signal, reuseEntry, toolPreamble, displayModel: model,
              });
            } else {
              await client.rawGetChatMessage(messages, modelEnum, modelUid, { onChunk });
            }
            // Flush order matters:
            //   1. ToolCallStreamParser tail → may produce more text deltas
            //      (e.g., a dangling <tool_call> that never closed falls
            //      through as literal text)
            //   2. PathSanitizeStream tail (text) → scrubs anything the tool
            //      parser held back AND anything we were holding ourselves
            //   3. PathSanitizeStream tail (thinking)
            if (toolParser) {
              const tail = toolParser.flush();
              if (tail.text) emitContent(pathStreamText.feed(tail.text));
              for (const rawTc of tail.toolCalls) {
                const tc = sanitizeToolCall(rawTc);
                const idx = collectedToolCalls.length;
                collectedToolCalls.push(tc);
                emitToolCallDelta(tc, idx);
              }
            }
            emitContent(pathStreamText.flush());
            emitThinking(pathStreamThinking.flush());
            // Pool check-in on success (cascade only)
            if (reuseEnabled && cascadeResult?.cascadeId && (accText || collectedToolCalls.length)) {
              const fpAfter = fingerprintAfter(messages, modelKey, callerKey);
              poolCheckin(fpAfter, {
                cascadeId: cascadeResult.cascadeId,
                sessionId: cascadeResult.sessionId,
                lsPort: ls.port,
                apiKey: currentApiKey,
                stepOffset: Number.isFinite(cascadeResult.stepOffset) ? cascadeResult.stepOffset : reuseEntry?.stepOffset,
                generatorOffset: Number.isFinite(cascadeResult.generatorOffset) ? cascadeResult.generatorOffset : reuseEntry?.generatorOffset,
                createdAt: reuseEntry?.createdAt,
              }, callerKey);
            }
            // success
            if (hadSuccess) reportSuccess(currentApiKey);
            updateCapability(currentApiKey, modelKey, true, 'success');
            recordRequest(model, true, Date.now() - startTime, currentApiKey);
            if (!rolePrinted) {
              send({ id, object: 'chat.completion.chunk', created, model,
                choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
            }
            // For response_format=json_* we buffered all content — flush one
            // clean JSON payload now. extractJsonPayload strips fences and
            // any preamble text, returning raw parseable JSON (or the
            // trimmed original when nothing parses).
            if (wantJson && accText) {
              const cleaned = extractJsonPayload(accText);
              if (cleaned) {
                send({ id, object: 'chat.completion.chunk', created, model,
                  choices: [{ index: 0, delta: { content: cleaned }, finish_reason: null }] });
                accText = cleaned;
              }
            }
            const finalReason = collectedToolCalls.length ? 'tool_calls' : 'stop';
            // OpenAI spec: the finish_reason chunk carries NO usage, then a
            // separate terminal chunk has empty choices[] + usage
            // (stream_options.include_usage convention). Emitting usage on
            // both made some clients double-count billing. Drop the first.
            send({ id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: {}, finish_reason: finalReason }] });
            {
              const usage = buildUsageBody(cascadeResult?.usage || null, messages, accText, accThinking);
              send({ id, object: 'chat.completion.chunk', created, model,
                choices: [], usage });
            }
            if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
            if (ckey && !collectedToolCalls.length && (accText || accThinking)) {
              cacheSet(ckey, { text: accText, thinking: accThinking });
            }
            return;
          } catch (err) {
            lastErr = err;
            reuseEntry = null; // don't try to reuse on retry
            const isAuthFail = /unauthenticated|invalid api key|invalid_grant|permission_denied.*account/i.test(err.message);
            const isRateLimit = /rate limit|rate_limit|too many requests|quota/i.test(err.message);
            const isInternal = /internal error occurred.*error id/i.test(err.message);
            const isTransport = isCascadeTransportError(err);
            const isTransient = isUpstreamTransientError(err, isInternal);
            if (isAuthFail) reportError(currentApiKey);
            if (isRateLimit) { markRateLimited(currentApiKey, rateLimitCooldownMs(err.message), modelKey); err.isRateLimit = true; err.isModelError = true; err.kind ||= 'model_error'; }
            if (isInternal) { reportInternalError(currentApiKey); err.isModelError = true; err.kind ||= 'transient_stall'; }
            if (isTransport) { err.isModelError = true; err.kind ||= 'transient_stall'; }
            if (err.isModelError && err.kind !== 'transient_stall' && !isRateLimit && !isInternal) {
              updateCapability(currentApiKey, modelKey, false, 'model_error');
            }
            if (isRateLimit && strictReuse && checkedOutReuseEntry && fpBefore && checkedOutReuseEntry.apiKey === currentApiKey) {
              log.info(`Chat[${reqId}]: strict reuse preserved cascade after rate limit`);
              break;
            }
            // Retry only if nothing has been streamed yet AND it's a retryable error
            if (!hadSuccess && (err.isModelError || isRateLimit)) {
              const tag = isRateLimit ? 'rate_limit' : isTransient ? 'upstream_transient' : 'model_error';
              if (isTransient) {
                streamInternalCount++;
                const backoffMs = await internalErrorBackoff(streamInternalCount - 1);
                log.warn(`Chat[${reqId}] stream: ${acct.email} upstream transient error (${isTransport ? 'cascade_transport' : 'internal_error'}), waited ${backoffMs}ms before next account`);
              } else {
                log.warn(`Account ${acct.email} failed (${tag}) on ${model}, trying next`);
              }
              continue;
            }
            break;
          }
          } finally {
            // Pair every successful getApiKey/acquireAccountByKey with a
            // release so the in-flight balancer in auth.js (issue #37)
            // stays accurate through stream success, retry, and abort.
            if (acct) releaseAccount(acct.apiKey);
          }
        }

        // All attempts failed
        log.error('Stream error after retries:', lastErr?.message);
        recordRequest(model, false, Date.now() - startTime, currentApiKey);
        try {
          const temporaryUnavailable = isAllTemporarilyUnavailable(modelKey);
          const rl = isAllRateLimited(modelKey);
          const allInternal = streamInternalCount > 0 && tried.length > 0 && streamInternalCount >= tried.length;
          // 优先暴露 upstream_transient，避免把 Cascade transport 抖动误报成账号限流。
          const lastIsTransport = isCascadeTransportError(lastErr);
          const errMsg = allInternal
            ? upstreamTransientErrorMessage(model, tried.length, lastIsTransport ? 'cascade_transport' : 'internal_error')
            : temporaryUnavailable.allUnavailable
            ? `${model} 所有账号暂时不可用，请 ${Math.ceil(temporaryUnavailable.retryAfterMs / 1000)} 秒后重试`
            : rl.allLimited
            ? `${model} 所有账号均已达速率限制，请 ${Math.ceil(rl.retryAfterMs / 1000)} 秒后重试`
            : sanitizeText(lastErr?.message || 'no accounts');
          if (allInternal) {
            log.error(`Chat[${reqId}] stream: ${tried.length}/${tried.length} accounts hit upstream transient error — surfacing upstream_transient_error`);
          }
          if (!hadSuccess && checkedOutReuseEntry && fpBefore) {
            poolCheckin(fpBefore, checkedOutReuseEntry, callerKey);
            log.info(`Chat[${reqId}]: restored checked-out cascade after failed stream`);
          }

          if (hadSuccess) {
            // We already streamed real assistant content. Injecting
            // "[Error: ...]" as a content delta here would corrupt the
            // assistant message (clients display it verbatim as model
            // output). Close cleanly with a plain stop — the caller saw
            // whatever partial content we produced. Error details only
            // go to the server log.
            const errType = allInternal
              ? 'upstream_transient_error'
              : (temporaryUnavailable.allUnavailable || lastErr?.type === 'rate_limit_exceeded')
                ? 'rate_limit_exceeded'
                : 'upstream_error';
            send(chatStreamError(errMsg, errType));
            log.warn(`Stream: partial response delivered then failed (${errMsg})`);
          } else {
            const errType = allInternal
              ? 'upstream_transient_error'
              : (temporaryUnavailable.allUnavailable || lastErr?.type === 'rate_limit_exceeded')
                ? 'rate_limit_exceeded'
                : 'upstream_error';
            send(chatStreamError(errMsg, errType));
          }
          res.write('data: [DONE]\n\n');
        } catch {}
        if (!res.writableEnded) res.end();
      } finally {
        unregisterSse();
        stopHeartbeat();
      }
    },
  };
}
