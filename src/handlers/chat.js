/**
 * POST /v1/chat/completions — OpenAI-compatible chat completions.
 * Routes to RawGetChatMessage (legacy) or Cascade (premium) based on model type.
 */

import { createHash, randomUUID } from 'crypto';
import { WindsurfClient, contentToString, isCascadeTransportError } from '../client.js';
import { getApiKey, acquireAccountByKey, releaseAccount, getAccountAvailability, reportError, reportSuccess, markRateLimited, reportInternalError, updateCapability, getAccountList, isAllRateLimited, isAllTemporarilyUnavailable, refundReservation, looksLikeBanSignal, reportBanSignal, clearBanSignals, isModelBlockedByDrought, getDroughtSummary } from '../auth.js';
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
  normalizeMessagesForCascade, ToolCallStreamParser, parseToolCallsFromText, stripToolMarkupFromText,
  buildToolPreambleForProto, buildCompactToolPreambleForProto,
  buildSchemaCompactToolPreambleForProto, buildSkinnyToolPreambleForProto,
} from './tool-emulation.js';
import {
  shouldUseNativeBridge, canMapAllTools, buildReverseLookup,
  buildAdditionalStepsFromHistory, TOOL_MAP,
} from '../cascade-native-bridge.js';
import { sanitizeText, sanitizeToolCall, PathSanitizeStream } from '../sanitize.js';
import { registerSseController } from '../sse-registry.js';

const HEARTBEAT_MS = 15_000;
const QUEUE_RETRY_MS = 1_000;
const QUEUE_MAX_WAIT_MS = 30_000;

// Build the option bag the v2.0.25 semantic key needs. tools / tool_choice /
// preamble are baked into the digest so a tool schema change misses instead
// of silently resuming a cascade where the upstream model has the old tool
// signatures cached.
function buildReuseOpts({ tools, toolChoice, toolPreamble, preambleTier, emulateTools, route }) {
  return {
    tools: Array.isArray(tools) ? tools : [],
    toolChoice: toolChoice ?? null,
    toolPreamble: toolPreamble || '',
    preambleTier: preambleTier || null,
    emulateTools: !!emulateTools,
    route: route || 'chat',
  };
}

// Build a synthetic assistant turn from the response we just produced so
// fingerprintAfter() reflects the post-turn server state. Without this, the
// next request from the same client (which carries [u1, ourA1, u2]) computes
// fpBefore over [u1, ourA1] but the stored fpAfter was over [u1] only — they
// no longer match and we silently miss the reuse we just set up.
function appendAssistantTurn(messages, allText, toolCalls) {
  const m = { role: 'assistant', content: allText || '' };
  if (Array.isArray(toolCalls) && toolCalls.length) {
    m.tool_calls = toolCalls.map(tc => ({
      function: {
        name: tc?.name || tc?.function?.name || '',
        arguments: tc?.argumentsJson || tc?.arguments || tc?.function?.arguments || '{}',
      },
    }));
  }
  return [...(messages || []), m];
}

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

// v2.0.55 (audit M2): salvage parser will accept any
// `{"name":"X","arguments":{...}}` JSON it finds in model output. If a user
// message contains a prompt-injection payload (and a non-Claude model
// faithfully echoes it), the parser would emit a tool_call for a name the
// caller never declared — e.g. `Bash` when the request only offered
// `get_weather`. Filter every emitted call against the request-declared
// tools[] before handing it to the client.
//
// Empty tools[] (caller never offered any) → caller is requesting tool
// emulation but didn't declare a list; treat it as "no tools allowed" so
// rogue parser output never reaches the client. Callers using
// `tool_choice:'none'` already get filtered upstream.
export function filterToolCallsByAllowlist(toolCalls, tools) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return toolCalls || [];
  const allowed = new Set();
  if (Array.isArray(tools)) {
    for (const t of tools) {
      const name = t?.function?.name || t?.name;
      if (typeof name === 'string' && name) allowed.add(name);
    }
  }
  if (!allowed.size) {
    // No declared tools but the parser emitted tool_calls — drop them all.
    // Surface once in logs so operators can spot prompt-injection attempts.
    const seenNames = [...new Set(toolCalls.map(tc => tc?.name).filter(Boolean))];
    if (seenNames.length) {
      log.warn(`ToolGuard: dropping ${toolCalls.length} tool_call(s) — request had no tools[] declared (names="${seenNames.join(',')}")`);
    }
    return [];
  }
  const filtered = [];
  const dropped = [];
  for (const tc of toolCalls) {
    if (tc?.name && allowed.has(tc.name)) filtered.push(tc);
    else if (tc?.name) dropped.push(tc.name);
  }
  if (dropped.length) {
    log.warn(`ToolGuard: dropping ${dropped.length} tool_call(s) not in declared tools[] (names="${[...new Set(dropped)].join(',')}", allowed="${[...allowed].join(',')}")`);
  }
  return filtered;
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

function textFromMessageContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => typeof p?.text === 'string')
      .map(p => p.text)
      .join('\n');
  }
  return '';
}

export function extractRequestedJsonKeys(messages) {
  if (!Array.isArray(messages)) return [];
  const text = latestRealUserText(messages) || '';
  if (!text) return [];
  const match = text.match(/\b(?:exact\s+)?keys\s+([A-Za-z_$][\w$-]*(?:\s*,\s*[A-Za-z_$][\w$-]*)*(?:\s+(?:and|&)\s+(?!no\b)[A-Za-z_$][\w$-]*)?)/i);
  if (!match) return [];
  return match[1]
    .replace(/\s+(?:and|&)\s+/gi, ',')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function latestRealUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const text = textFromMessageContent(m.content);
    if (!text || /^\s*<tool_result\b/i.test(text)) continue;
    return text;
  }
  return '';
}

export function isExplicitJsonRequested(messages) {
  const text = latestRealUserText(messages);
  if (!text) return false;
  if (/\b(?:compact\s+)?JSON\b/i.test(text) && /\b(?:answer|respond|return|output|containing|with|only|valid)\b/i.test(text)) {
    return true;
  }
  if (/\bJSON\s+(?:object|only|format)\b/i.test(text)) return true;
  if (/\b(?:answer|respond|return|output)\s+only\s+(?:with\s+)?(?:valid\s+)?JSON\b/i.test(text)) return true;
  return false;
}

function plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function findDeepValue(obj, wanted) {
  if (!plainObject(obj) && !Array.isArray(obj)) return undefined;
  const wantedLower = wanted.toLowerCase();
  const stack = [obj];
  while (stack.length) {
    const cur = stack.shift();
    if (plainObject(cur)) {
      for (const [k, v] of Object.entries(cur)) {
        if (k.toLowerCase() === wantedLower) return v;
        if (plainObject(v) || Array.isArray(v)) stack.push(v);
      }
    } else if (Array.isArray(cur)) {
      for (const v of cur) {
        if (plainObject(v) || Array.isArray(v)) stack.push(v);
      }
    }
  }
  return undefined;
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function collectToolFacts(messages) {
  const namesById = new Map();
  const facts = { byTool: {}, all: [] };
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) namesById.set(tc.id, tc.function?.name || '');
    }
    if (m?.role !== 'tool') continue;
    const toolName = namesById.get(m.tool_call_id) || 'tool';
    const key = toolName.toLowerCase();
    const content = typeof m.content === 'string' ? m.content.trim() : JSON.stringify(m.content ?? '');
    const parsed = safeJsonParse(extractJsonPayload(content));
    const fact = { toolName, content, parsed };
    facts.all.push(fact);
    if (!facts.byTool[key]) facts.byTool[key] = [];
    facts.byTool[key].push(fact);
  }
  return facts;
}

function valueFromToolFacts(key, facts) {
  const lower = key.toLowerCase();
  if (lower === 'versionsmatch' || lower === 'versionmatch') return undefined;
  const wantsRead = lower.startsWith('read') || lower.includes('read');
  const wantsBash = lower.startsWith('bash') || lower.includes('bash');
  const wantsVersion = lower.includes('version');
  const wantsName = lower.includes('name') || lower.includes('package');
  const candidates = wantsRead ? (facts.byTool.read || [])
    : wantsBash ? (facts.byTool.bash || [])
      : facts.all;

  if (wantsVersion) {
    for (const f of candidates) {
      if (plainObject(f.parsed)) {
        const v = findDeepValue(f.parsed, 'version');
        if (v !== undefined) return v;
      }
      const m = f.content.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
      if (m) return m[0];
    }
  }
  if (wantsName) {
    for (const f of candidates) {
      if (plainObject(f.parsed)) {
        const v = findDeepValue(f.parsed, 'name');
        if (v !== undefined) return v;
      }
    }
  }
  if (lower === 'ok') return true;
  return undefined;
}

export function stabilizeJsonPayload(text, messages) {
  const keys = extractRequestedJsonKeys(messages);
  if (!keys.length) return text;
  const cleaned = extractJsonPayload(text);
  const parsed = safeJsonParse(cleaned);
  if (!plainObject(parsed)) return cleaned;
  const existingKeys = Object.keys(parsed);
  if (existingKeys.length === keys.length && keys.every((k, i) => existingKeys[i] === k)) {
    return cleaned;
  }

  const facts = collectToolFacts(messages);
  const out = {};
  for (const key of keys) {
    let v = findDeepValue(parsed, key);
    if (v === undefined) v = valueFromToolFacts(key, facts);
    out[key] = v === undefined ? null : v;
  }
  for (const key of keys) {
    const lower = key.toLowerCase();
    if ((lower === 'versionsmatch' || lower === 'versionmatch') && out[key] == null) {
      const read = out.readVersion ?? out.read_version;
      const bash = out.bashVersion ?? out.bash_version;
      if (read != null && bash != null) out[key] = String(read).trim() === String(bash).trim();
    }
  }
  return JSON.stringify(out);
}

export function applyJsonResponseHint(messages, responseFormat) {
  // Inject ONLY a system message. Earlier versions also appended a long
  // "[You MUST respond with valid JSON only ...]" suffix to the latest
  // user turn's content, but that bled into the cascade reuse trajectory
  // upstream — every follow-up turn on the same conversation inherited
  // the JSON-only instruction even when the new turn never asked for
  // JSON, producing things like `{"reply":"你好"}` for a plain greeting
  // (#104). The system message is more authoritative for cascade routing
  // anyway, and is regenerated per request rather than persisted in the
  // conversation history, so it gets the work done without contaminating
  // the trajectory.
  let sysContent = 'Respond with valid JSON only. No markdown, no code fences, no explanation. Output must be parseable by JSON.parse(). Preserve the exact JSON field names requested by the user, and do not add extra fields when an exact key set is requested. If tool results contain the requested values, put only those values into JSON fields rather than describing them in prose or copying the full tool result.';
  if (responseFormat?.type === 'json_schema' && responseFormat?.json_schema?.schema) {
    sysContent += ' Conform to this JSON Schema:\n' + JSON.stringify(responseFormat.json_schema.schema);
  }
  return [{ role: 'system', content: sysContent }, ...(Array.isArray(messages) ? messages : [])];
}

const CASCADE_REUSE_STRICT = process.env.CASCADE_REUSE_STRICT === '1';
const CASCADE_REUSE_STRICT_RETRY_MS = (() => {
  const n = parseInt(process.env.CASCADE_REUSE_STRICT_RETRY_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();
const OPUS47_TOOL_EMULATED_REUSE = process.env.OPUS47_TOOL_EMULATED_REUSE !== '0';
const OPUS47_STRICT_REUSE = process.env.OPUS47_STRICT_REUSE !== '0';
// HIGH-3: a shared API key with no per-user / per-session signal lets two
// concurrent end users behind the same proxy step on each other's cascade
// state. Default off; set CASCADE_REUSE_ALLOW_SHARED_API_KEY=1 to opt back
// into the legacy permissive behavior (single-user proxies, internal use).
const CASCADE_REUSE_ALLOW_SHARED_API_KEY = process.env.CASCADE_REUSE_ALLOW_SHARED_API_KEY === '1';

// True when callerKey has any per-user / per-session dimension beyond a
// bare API key (`api:<hash>`). Bare API-key callers without a user signal
// share state across concurrent requests — see HIGH-3 above.
function hasPerUserScope(callerKey) {
  if (typeof callerKey !== 'string' || !callerKey) return false;
  if (callerKey.includes(':user:')) return true;
  // v2.0.37: apiKey-mode now appends `:client:<ip+ua>` when no body
  // user signal is present, so single-user self-hosted setups land on
  // a stable scope and cascade reuse works across turns. Match the
  // segment anywhere in the string (#93 follow-up zhangzhang-bit).
  if (callerKey.includes(':client:')) return true;
  if (callerKey.startsWith('session:') || callerKey.startsWith('client:')) return true;
  return false;
}

function isToolSensitiveOpusModel(modelKey = '') {
  // Opus-class models share the same prompt-injection / Claude-Code-tools
  // sensitivity profile, regardless of whether the version label is dotted
  // (claude-opus-4.6) or dashed (claude-opus-4-7-high). #59 confirmed 4.6
  // hits the same multi-turn tool-context loss as 4.7, so the strict-reuse
  // and multimodal-tool-fallback gates apply to both.
  return /^claude-opus-4(?:[.-]6|[.-]7)(?:[-.]|$)/i.test(String(modelKey || ''));
}

function isSonnet46ToolReuseDisabled() {
  return process.env.WINDSURFAPI_DISABLE_SONNET_TOOL_REUSE === '1';
}

function isSonnet46Model(modelKey = '') {
  return /^claude-sonnet-4(?:[.-]6)(?:[-.]|$)/i.test(String(modelKey || ''));
}

export function isToolEmulatedReusableModel(modelKey = '') {
  if (isToolSensitiveOpusModel(modelKey)) return true;
  return !isSonnet46ToolReuseDisabled() && isSonnet46Model(modelKey);
}

// Tool-emulated requests are normally kept out of cascade_id reuse because
// <tool_call>/<tool_result> bodies drift across turns. Opus 4.6 / 4.7 and
// Sonnet 4.6 + Claude Code are the exceptions: replaying the full
// prompt/tools/image history is worse than preserving the exact upstream
// cascade, so enable a narrow local path.
// thinking.type can be 'enabled' (Anthropic spec), 'adaptive' (what
// Claude Code 2.x sonnet defaults to), or any future variant — accept
// anything that isn't an explicit 'disabled' so the model still gets
// routed to the -thinking sibling. The previous strict 'enabled' check
// silently dropped every adaptive request to the non-thinking model.
export function isThinkingRequested(body) {
  const thinkingType = body?.thinking?.type;
  if (thinkingType && thinkingType !== 'disabled') return true;
  if (body?.reasoning_effort) return true;
  return false;
}

function isOpus47ModelKey(modelKey) {
  return /^claude-opus-4-7(?:-|$)/i.test(String(modelKey || ''));
}

function isOpus47ThinkingAutoRouteEnabled() {
  return process.env.WINDSURFAPI_OPUS47_THINKING_UIDS === '1';
}

export function resolveEffectiveModelKey(modelKey, wantThinking) {
  if (!wantThinking || !modelKey || modelKey.includes('thinking')) return modelKey;
  const thinkingModelKey = modelKey + '-thinking';
  if (!getModelInfo(thinkingModelKey)) return modelKey;
  if (isOpus47ModelKey(modelKey) && !isOpus47ThinkingAutoRouteEnabled()) {
    return modelKey;
  }
  return thinkingModelKey;
}

export function shouldUseCascadeReuse({ useCascade, emulateTools, modelKey, allowToolReuse = OPUS47_TOOL_EMULATED_REUSE }) {
  if (!useCascade) return false;
  if (!emulateTools) return true;
  return !!allowToolReuse && isToolEmulatedReusableModel(modelKey);
}

// Issue #86 follow-up (KLFDan0534): GLM 5.1 (and other non-reasoning models)
// silently produce nothing in claudecode/openclaw — claudecode shows the
// "thinking" indicator but the user sees no text and no thinking content.
//
// Root cause: cascade upstream sometimes packs the entire model response
// into `step.thinking` instead of `step.responseText`. client.js routes
// step.thinking → chunk.thinking → SSE `reasoning_content`. Claude Code
// (and many OpenAI-style clients) hide reasoning_content by default and
// only render `content` deltas. Result: visible silence.
//
// Fix: at stream end, for NON-reasoning models that produced ONLY thinking
// (no text, no tool_calls), promote the thinking buffer to a content delta.
// Reasoning models (caller asked for thinking, OR routing landed on a
// -thinking variant) keep the original split behaviour — those clients
// expect reasoning_content separately.
// `wantThinking` collapses the prior `body` arg — callers compute it via
// isThinkingRequested(body) at the entry point (handleChatCompletions),
// then thread the boolean through deps. The previous shape leaked a
// reference to `body` into streamResponse / nonStreamResponse where it
// wasn't in scope, ReferenceError'ing every stream finish (#93 follow-up
// reported by zhangzhang-bit).
export function shouldFallbackThinkingToText({ routingModelKey, wantThinking, accText, accThinking, hasToolCalls }) {
  if (hasToolCalls) return false;
  if (accText && accText.length) return false;
  if (!accThinking || !accThinking.length) return false;
  if (routingModelKey && /thinking/i.test(routingModelKey)) return false;
  if (wantThinking) return false;
  return true;
}

function shouldForceCascadeReuse({ emulateTools, modelKey }) {
  return !!emulateTools && OPUS47_TOOL_EMULATED_REUSE && isToolEmulatedReusableModel(modelKey);
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

function recentUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return contentToString(messages[i].content);
  }
  return '';
}

function shellUnquote(text) {
  const s = String(text || '').trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === '\'' && s.at(-1) === '\''))) {
    return s.slice(1, -1);
  }
  return s;
}

function trimCommandSentence(text) {
  const s = String(text || '').trim();
  let quote = '';
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && quote) { escaped = true; continue; }
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (ch === '.' && /\s/.test(s[i + 1] || '')) return s.slice(0, i).trim();
  }
  return s.replace(/[.。]\s*$/, '').trim();
}

function extractRequestedBashCommands(text) {
  const src = String(text || '');
  const out = [];
  const patterns = [
    /(?:command|run|execute)\s+(?:exactly\s+)?(?::\s*)?`([^`]+)`/gi,
    /(?:command|run|execute)\s+(?:exactly\s+)?(?::\s*)?([^\n]+)/gi,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const candidate = shellUnquote(trimCommandSentence(m[1])).trim();
      if (candidate && /\s/.test(candidate)) out.push(candidate);
    }
  }
  return [...new Set(out)];
}

export function repairToolCallArguments(tc, messages) {
  if (!tc || String(tc.name || '').toLowerCase() !== 'bash' || typeof tc.argumentsJson !== 'string') return tc;
  let args;
  try { args = JSON.parse(tc.argumentsJson); } catch { return tc; }
  if (!args || typeof args.command !== 'string') return tc;
  const current = args.command.trim();
  if (!current) return tc;
  for (const requested of extractRequestedBashCommands(recentUserText(messages))) {
    if (requested.length > current.length && requested.startsWith(current)) {
      return { ...tc, argumentsJson: JSON.stringify({ ...args, command: requested }) };
    }
  }
  return tc;
}

export function rateLimitCooldownMs(message = '') {
  const reset = String(message || '').match(/resets?\s+in\s*:?\s*((?:(?:\d+)\s*[hms]\s*)+)/i);
  if (reset) {
    let total = 0;
    for (const part of reset[1].matchAll(/(\d+)\s*([hms])/gi)) {
      const n = Number(part[1]);
      const unit = part[2].toLowerCase();
      if (unit === 'h') total += n * 60 * 60 * 1000;
      else if (unit === 'm') total += n * 60 * 1000;
      else total += n * 1000;
    }
    if (total > 0) return total;
  }
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
export function extractCallerEnvironment(messages) {
  if (!Array.isArray(messages)) return '';
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
  const PATH_TAIL = `(?:[\\/~]|[A-Za-z]:\\\\)[^\\s\`'"<>\\n.,;)]+`;
  // Adjective slot for "Working directory" — Claude Code 2.x uses
  // "Primary working directory: D:\..." instead of the canonical
  // "Working directory: ...". Other clients use "Current" / "Initial" /
  // "Default" / "Active" / "Project" similarly. Optional, matched
  // case-insensitively. (#106 / #107 follow-up: the user's 26 KB Claude
  // Code system prompt mentions "current working directory" mid-prose
  // first, then later has the actual `- Primary working directory: D:\...`
  // bullet — old regex only allowed the canonical key so the bullet
  // never matched and env never lifted.)
  const ADJ = `(?:Primary|Current|Initial|Default|Active|Project|My)\\s+`;
  const PATTERNS = [
    ['cwd', new RegExp(
      // Form (a): line-anchored key/value, optional adjective prefix
      `(?:^|\\n)\\s*(?:[-*]\\s+)?(?:${ADJ})?(?:Working\\s+directory|cwd|<cwd>)\\s*[:=]\\s*\`?(${PATH_TAIL})\`?` +
      // Form (b): prose "current working directory is /path" (adjacent path)
      `|(?:current\\s+working\\s+directory(?:\\s+is)?)\\s*[:=]?\\s*\`?(${PATH_TAIL})\`?`,
      'gi'
    ), (v) => `- Working directory: ${v}`],
    // Git repo: accept "Is directory a git repo" (Claude Code <2.x) AND
    // "Is a git repository" / "Is git repo" (Claude Code 2.x).
    ['git', /(?:^|\n)\s*(?:[-*]\s+)?Is(?:\s+(?:directory\s+)?(?:a\s+)?)git\s+repo(?:sitory)?\s*[:=]\s*([^\n<]+)/i, (v) => `- Is the directory a git repo: ${v}`],
    ['platform', /(?:^|\n)\s*(?:[-*]\s+)?Platform\s*[:=]\s*([^\n<]+)/i, (v) => `- Platform: ${v}`],
    ['os', /(?:^|\n)\s*(?:[-*]\s+)?OS\s+[Vv]ersion\s*[:=]\s*([^\n<]+)/i, (v) => `- OS version: ${v}`],
  ];

  for (const m of messages) {
    if (!m) continue;
    let content;
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n');
    else continue;
    if (!content) continue;

    for (const [key, re, fmt] of PATTERNS) {
      if (seen.has(key)) continue;
      // For the cwd pattern (global flag), iterate matches and pick the
      // first one that actually has a non-empty captured path. The earlier
      // matches in a long system prompt may be prose mentions like
      // "...and the current working directory." with no adjacent path
      // because the path lives in a later bullet — we must not stop at
      // the first textual hit.
      if (re.global) {
        for (const match of content.matchAll(re)) {
          const value = (match[1] || match[2] || '').trim();
          if (!value || /[\x00-\x1f]/.test(value) || value === '<workspace>') continue;
          seen.add(key);
          out.push(fmt(value));
          break;
        }
      } else {
        const match = content.match(re);
        if (!match) continue;
        const value = (match[1] || match[2] || '').trim();
        if (!value || /[\x00-\x1f]/.test(value) || value === '<workspace>') continue;
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
  if (!seen.has('cwd')) {
    // #100 (yunduobaba) fallback — when the canonical extractors miss
    // the cwd (some Claude Code forks / OpenCode variants don't emit
    // a `<env>` block at all), scan the head of the first real user
    // message for a bare absolute path. The user's prompt
    //   "C:\Users\renfei\Downloads\WindsurfAPI-master 分析下这个项目"
    // makes their intended workspace obvious — without this, cascade's
    // built-in /tmp/windsurf-workspace prior wins and the model invents
    // a JSON apology about Linux not being able to read Windows paths.
    const cwd = scanUserMessageForBareCwd(messages);
    if (cwd) return `- Working directory: ${cwd}`;

    // #107 (zhangzhang-bit) fallback — the system prompt was 26 KB and
    // referenced "current working directory" mid-prose with no adjacent
    // path. The actual path was buried somewhere else as a bullet. The
    // canonical regex now allows adjective prefixes ("Primary working
    // directory") which covers the common Claude Code 2.x case, but
    // some custom clients put the cwd on its own bullet with no key at
    // all (just `- D:\Project\foo`). Scan all system messages for a
    // standalone bullet/list line whose value is a single absolute path.
    const bulletCwd = scanForBulletCwdInSystem(messages);
    if (bulletCwd) return `- Working directory: ${bulletCwd}`;
    return '';
  }
  return out.join('\n');
}

// Last-resort cwd scan: walk every system message and look for a line
// like `  - D:\Project\foo` or `* /home/dev/proj` whose only content is
// a single absolute-looking path. This catches the case where a custom
// agent prompt enumerates environment facts in a bulleted list but
// uses no explicit "Working directory:" key. Restricted to system role
// to avoid grabbing a path the user mentioned in passing later in chat.
function scanForBulletCwdInSystem(messages) {
  if (!Array.isArray(messages)) return '';
  const FILE_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|json|jsonc|md|mdx|py|pyc|go|rs|java|kt|swift|cpp|cc|cxx|c|h|hpp|html?|css|scss|sass|less|yaml|yml|toml|ini|cfg|conf|sh|bash|zsh|fish|ps1|bat|cmd|exe|dll|so|dylib|zip|tar|gz|bz2|xz|7z|rar|png|jpe?g|gif|webp|svg|ico|mp[34]|wav|flac|ogg|webm|mov|avi|mkv|pdf|docx?|xlsx?|pptx?|csv|tsv|sql|db|sqlite|log|lock|map|min\.js|min\.css)$/i;
  const BULLET = /^[\s]*[-*•]\s+`?((?:[A-Za-z]:[\\/]|\/[A-Za-z]|~[\\/])[^\s`'"<>\n]+)`?\s*$/m;
  for (const m of messages) {
    if (m?.role !== 'system') continue;
    let content;
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n');
    else continue;
    if (!content) continue;
    // matchAll requires the regex to be global; build a fresh global copy.
    const re = new RegExp(BULLET.source, 'gm');
    for (const match of content.matchAll(re)) {
      const cand = match[1];
      if (!cand || cand.length < 5) continue;
      if (FILE_EXT.test(cand)) continue;
      if (cand === '<workspace>') continue;
      return cand;
    }
  }
  return '';
}

// Bare-path fallback for extractCallerEnvironment. Looks at the FIRST
// user-role message only (so a path appearing inside an assistant or
// tool reply later in the conversation doesn't override the original
// intent), takes the leading 200 chars (paths users care about appear
// near the top of a prompt, not buried mid-sentence), and matches one
// of three explicit absolute-path shapes:
//
//   - Windows  C:\... or C:/...
//   - Unix     /home/..., /Users/..., /var/..., etc.
//   - Tilde    ~/projects/...
//
// The path-tail charset is restricted to ASCII filesystem characters
// (alnum, `_`, `-`, `.`, `/`, `\`) so a CJK character or whitespace
// terminates the match cleanly — matters for prompts where the path is
// glued straight to Chinese text without a space ("C:\foo分析这个").
//
// File-extension reject: a path ending in a common file extension is
// almost certainly the user pointing at a single file, not the cwd.
// We could try dirname() it but the heuristic is shaky enough that we
// rather miss than mis-attribute.
function scanUserMessageForBareCwd(messages) {
  if (!Array.isArray(messages)) return '';
  const FILE_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|json|jsonc|md|mdx|py|pyc|go|rs|java|kt|swift|cpp|cc|cxx|c|h|hpp|html?|css|scss|sass|less|yaml|yml|toml|ini|cfg|conf|sh|bash|zsh|fish|ps1|bat|cmd|exe|dll|so|dylib|zip|tar|gz|bz2|xz|7z|rar|png|jpe?g|gif|webp|svg|ico|mp[34]|wav|flac|ogg|webm|mov|avi|mkv|pdf|docx?|xlsx?|pptx?|csv|tsv|sql|db|sqlite|log|lock|map|min\.js|min\.css)$/i;
  // Reject content that is `<text> followed by <path>`. We anchor at ^ so the
  // path must be the first non-trivial token after some leading punctuation /
  // whitespace. After stripping wrappers like <system-reminder> the user's
  // real prompt usually starts cleanly with the path.
  const PATH_AT_HEAD = /^[\s,;:.，。、；：　"'`(\[]*((?:[A-Za-z]:[\\/]|\/[A-Za-z]|~[\\/])[A-Za-z0-9._\\/-]+)/;

  const tryMatch = (text) => {
    const match = text.match(PATH_AT_HEAD);
    if (!match) return '';
    const cand = match[1];
    if (cand.length < 5) return '';
    if (FILE_EXT.test(cand)) return '';
    return cand;
  };

  for (const m of messages) {
    if (m?.role !== 'user') continue;
    let content;
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n');
    else continue;
    if (!content) continue;

    // Pass 1: head of the raw message. Cheapest path; covers vanilla CLIs
    // that don't wrap user input in any preamble.
    const direct = tryMatch(content.slice(0, 300));
    if (direct) return direct;

    // Pass 2 (#100 follow-up, yunduobaba): Claude Code's hooks inject one or
    // more `<system-reminder>...</system-reminder>` blocks at the very top of
    // every user message — frequently 1–5 KB before the user's actual text.
    // That pushes the bare path past the 300-char head and pass 1 misses,
    // even though the path is still the first thing the user typed. Strip
    // those wrappers and try again with a slightly bigger window (the prose
    // that follows tends to be longer than the raw input).
    if (!/<system-reminder\b/i.test(content)) continue;
    const stripped = content.replace(/<system-reminder\b[\s\S]*?<\/system-reminder>\s*/gi, '');
    const wrapped = tryMatch(stripped.slice(0, 500));
    if (wrapped) return wrapped;
  }
  return '';
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

export function applyToolPreambleBudget(tools, toolChoice, callerEnv = '', opts = {}) {
  const modelKey = opts.modelKey || null;
  const provider = opts.provider || null;
  const route = opts.route || null;
  const softBytes = opts.softBytes ?? parseInt(process.env.TOOL_PREAMBLE_SOFT_BYTES || '24000', 10);
  const hardBytes = opts.hardBytes ?? parseInt(process.env.TOOL_PREAMBLE_HARD_BYTES || '48000', 10);
  const tiers = [
    { tier: 'full', build: buildToolPreambleForProto },
    { tier: 'schema-compact', build: buildSchemaCompactToolPreambleForProto },
    { tier: 'skinny', build: buildSkinnyToolPreambleForProto },
    { tier: 'names-only', build: buildCompactToolPreambleForProto },
  ];
  const full = tiers[0].build(tools || [], toolChoice, callerEnv, modelKey, provider, route);
  if (!full) {
    return { ok: true, preamble: '', fullBytes: 0, finalBytes: 0, compacted: false, tier: 'empty', softBytes, hardBytes };
  }
  const fullBytes = Buffer.byteLength(full, 'utf8');

  // Walk the tiers from largest to smallest; pick the first one that fits
  // under the soft cap. If none fit (extreme tool counts), fall through to
  // names-only and let the hard-cap check decide whether to reject.
  let chosen = { tier: 'full', preamble: full, bytes: fullBytes };
  for (const t of tiers) {
    const text = t.tier === 'full' ? full : t.build(tools || [], toolChoice, callerEnv, modelKey, provider, route);
    const bytes = Buffer.byteLength(text, 'utf8');
    chosen = { tier: t.tier, preamble: text, bytes };
    if (bytes <= softBytes) break;
  }

  const compacted = chosen.tier !== 'full';
  if (chosen.bytes > hardBytes) {
    return { ok: false, preamble: chosen.preamble, fullBytes, finalBytes: chosen.bytes, compacted, tier: chosen.tier, softBytes, hardBytes };
  }
  return { ok: true, preamble: chosen.preamble, fullBytes, finalBytes: chosen.bytes, compacted, tier: chosen.tier, softBytes, hardBytes };
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
// Anthropic prompt-caching ttl='1h' markers should keep the cascade
// pool entry alive past its 30-minute default. 90 minutes = 1h cache
// window + 30 min slack so the next turn comfortably falls inside the
// extended TTL. 5m markers (the spec default) need no hint — the
// pool's default already covers them.
function ttlHintFromCachePolicy(cachePolicy) {
  if (!cachePolicy?.has1h) return undefined;
  return 90 * 60 * 1000;
}

function buildUsageBody(serverUsage, messages, completionText, thinkingText = '', cachePolicy = null) {
  if (serverUsage && (serverUsage.inputTokens || serverUsage.outputTokens)) {
    const inputTokens = serverUsage.inputTokens || 0;
    const outputTokens = serverUsage.outputTokens || 0;
    const cacheRead = serverUsage.cacheReadTokens || 0;
    const cacheWrite = serverUsage.cacheWriteTokens || 0;
    const promptTotal = inputTokens + cacheRead + cacheWrite;
    // Anthropic prompt-caching split: when the client tagged any block
    // with ttl='1h' the creation tokens go to ephemeral_1h, otherwise to
    // ephemeral_5m. Cascade doesn't separate the pools so we can't
    // attribute byte-for-byte; this is the binary "any 1h?" routing
    // Anthropic's own API documents and matches what real clients see
    // when they use a single TTL per request (which is the common case).
    const cacheCreationSplit = {
      ephemeral_5m_input_tokens: cachePolicy?.has1h ? 0 : cacheWrite,
      ephemeral_1h_input_tokens: cachePolicy?.has1h ? cacheWrite : 0,
    };
    return {
      prompt_tokens: promptTotal,
      completion_tokens: outputTokens,
      total_tokens: promptTotal + outputTokens,
      input_tokens: promptTotal,
      output_tokens: outputTokens,
      prompt_tokens_details: { cached_tokens: cacheRead },
      completion_tokens_details: { reasoning_tokens: 0 },
      cache_creation_input_tokens: cacheWrite,
      cache_read_input_tokens: cacheRead,
      cache_creation: cacheCreationSplit,
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
  const cachePolicy = body.__cachePolicy || null;
  const checkMessageRateLimitFn = context.checkMessageRateLimit || checkMessageRateLimit;
  const waitForAccountFn = context.waitForAccount || waitForAccount;

  // Probe diagnostics: dump compact request shape for every call, plus a
  // tail of the last user turn. Keeps us able to see how third-party
  // verifiers (hvoy.ai) actually probe PDF / JSON / thinking capabilities
  // without exposing full conversation content.
  try {
    const contentTypes = new Set();
    let lastUserText = '';
    for (const m of (messages || [])) {
      if (typeof m?.content === 'string') contentTypes.add('string');
      else if (Array.isArray(m.content)) for (const p of m.content) contentTypes.add(p?.type || typeof p);
      if (m?.role === 'user') {
        const c = m.content;
        lastUserText = typeof c === 'string'
          ? c
          : Array.isArray(c) ? c.filter(p => p?.type === 'text').map(p => p.text || '').join(' ') : '';
      }
    }
    log.info(`Probe[${reqId}]: model=${reqModel} stream=${!!stream} rf=${response_format?.type || 'none'} tools=${Array.isArray(tools) ? tools.length : 0} reasoning=${body.reasoning_effort || body.thinking?.type || 'none'} ctypes=[${[...contentTypes].join(',')}] turns=${messages?.length || 0} lastUser=${requestLogSummary(lastUserText, 140)}`);
    // Also dump first-user / system content so we can see preambles.
    for (let mi = 0; mi < Math.min((messages || []).length, 3); mi++) {
      const m = messages[mi];
      const c = typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map(p => p?.type === 'text' ? p.text : `[${p?.type}]`).join('|') : '';
      log.info(`Probe[${reqId}] msg[${mi}] role=${m?.role} ${requestLogSummary(c)}`);
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

  const explicitJson = isExplicitJsonRequested(messages);
  const wantJson = response_format?.type === 'json_object' || response_format?.type === 'json_schema' || explicitJson;
  if (wantJson) {
    messages = applyJsonResponseHint(messages, response_format);
  }

  const modelKey = resolveModel(reqModel || config.defaultModel);
  const wantThinking = isThinkingRequested(body);
  const effectiveModelKey = resolveEffectiveModelKey(modelKey, wantThinking);
  if (effectiveModelKey !== modelKey) {
    log.info(`Chat[${reqId}]: routed ${modelKey} -> ${effectiveModelKey} (wantThinking=${wantThinking})`);
  } else if (wantThinking && isOpus47ModelKey(modelKey) && getModelInfo(modelKey + '-thinking') && !isOpus47ThinkingAutoRouteEnabled()) {
    log.warn(`Chat[${reqId}]: Opus 4.7 thinking auto-route disabled; using base model ${modelKey}. Upstream LS rejects ${modelKey}-thinking as model not found. Set WINDSURFAPI_OPUS47_THINKING_UIDS=1 only after upstream registers it.`);
  }
  const routingModelKey = effectiveModelKey;
  const modelInfo = getModelInfo(effectiveModelKey) || getModelInfo(modelKey);
  // Reject unknown models. Without this, chat.js used to fall through to
  // legacy rawGetChatMessage with modelEnum=0 and modelUid=null, which
  // upstream silently routed to a default model. Callers saw "I'm Claude 4.5"
  // when they asked for `claude-4.6` (issue #68), or got blank responses for
  // typos. Fail fast with the same shape OpenAI uses.
  if (!modelInfo) {
    return {
      status: 400,
      body: {
        error: {
          message: `Unsupported model: ${reqModel || config.defaultModel}`,
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found',
        },
      },
    };
  }
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

  // v2.0.65 (#115) — native tool bridge gate. When every caller-declared
  // tool maps onto a Cascade-native IDE step kind AND the activation
  // condition fires (env override OR auto-on for GPT family / Codex CLI),
  // we switch the planner from NO_TOOL+emulation to DEFAULT planner mode +
  // CascadeToolConfig.tool_allowlist + additional_steps[9] history
  // injection. The emulation tool preamble is NOT shipped in this mode —
  // the planner sees its own native tool inventory and the history
  // already contains "completed" trajectory steps for prior tool turns.
  // See src/cascade-native-bridge.js for full rationale.
  const nativeBridgeOn = useCascade && hasTools && shouldUseNativeBridge(tools, {
    modelKey: routingModelKey,
    provider: modelInfo?.provider || null,
    route: body.__route || 'chat',
  });
  const nativeAdditionalSteps = nativeBridgeOn
    ? buildAdditionalStepsFromHistory(messages || [])
    : [];
  const nativeAllowlist = nativeBridgeOn
    ? Array.from(new Set((tools || [])
        .map(t => TOOL_MAP[t?.function?.name]?.kind)
        .filter(Boolean)))
    : [];
  const nativeCallerTools = nativeBridgeOn ? tools : [];
  if (nativeBridgeOn) {
    log.info(`Chat[${reqId}]: native bridge ON — model=${routingModelKey} tools=${(tools || []).map(t => t?.function?.name).join(',')} allowlist=${nativeAllowlist.join(',')} additional_steps=${nativeAdditionalSteps.length}`);
  }
  // Build proto-level preamble (goes into tool_calling_section override).
  // Also inject into the last user message as fallback — some models in
  // NO_TOOL mode ignore the SectionOverride entirely and refuse to call
  // tools unless they see the definitions in the conversation itself. (#22)
  // Lift the caller's environment hints (cwd, git status, platform) into
  // the proto-level system slot so Cascade's authoritative planner system
  // prompt can no longer override them with /tmp/windsurf-workspace
  // priors. See extractCallerEnvironment() above for the parser.
  const callerEnv = emulateTools ? extractCallerEnvironment(messages) : '';
  let toolPreamble = '';
  let preambleTier = null;
  // Payload budget for the proto-level tool preamble. The upstream LS
  // panel state caps total request size at ~30KB; the preamble alone can
  // approach that with 30+ tools (Claude Code, opencode, Cline). Past the
  // soft cap we drop full schemas and ship names-only — the model still
  // knows what tools exist and how to invoke them, just not parameter
  // shapes. Only the actual payload after fallback is compared with the
  // hard cap; v2.0.9 rejected on the full-schema size before compacting,
  // which broke real opencode / Claude Code setups with 30-50 MCP tools.
  if (emulateTools) {
    const budget = applyToolPreambleBudget(tools || [], tool_choice, callerEnv, {
      modelKey: routingModelKey,
      provider: modelInfo?.provider || null,
      // v2.0.62 (#115) — pass route so GPT-family + Codex/Responses
      // route picks the gpt_native dialect (bare-JSON anti-refusal).
      route: body.__route || 'chat',
    });
    preambleTier = budget.tier;
    if (budget.compacted) {
      log.warn(`Probe[${reqId}]: toolPreamble ${Math.round(budget.fullBytes / 1024)}KB exceeds soft cap ${Math.round(budget.softBytes / 1024)}KB; using ${budget.tier} tier (${Math.round(budget.finalBytes / 1024)}KB, ${(tools || []).length} tools)`);
    }
    if (!budget.ok) {
      log.warn(`Probe[${reqId}]: toolPreamble ${Math.round(budget.finalBytes / 1024)}KB exceeds hard cap ${Math.round(budget.hardBytes / 1024)}KB after ${budget.tier} tier; rejecting (${(tools || []).length} tools)`);
      return {
        status: 400,
        body: {
          error: {
            message: `Tool definitions are too large (${Math.round(budget.finalBytes / 1024)}KB > ${Math.round(budget.hardBytes / 1024)}KB after ${budget.tier} compaction). Reduce the number of tools or shorten tool names.`,
            type: 'invalid_request_error',
            param: 'tools',
            code: 'tool_preamble_too_large',
          },
        },
      };
    }
    toolPreamble = budget.preamble;
  }
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
  const disableUserToolFallback = emulateTools && isToolSensitiveOpusModel(routingModelKey) && hasMultimodalContent(messages);
  if (disableUserToolFallback) {
    log.info(`Chat[${reqId}]: disabled user-message tool fallback for Opus 4.x multimodal turn`);
  }
  // Native bridge mutates the message list differently from emulation:
  // tool_result turns become additional_steps[9] entries on the proto, not
  // synthetic <tool_result> user turns in the conversation text. We strip
  // those tool messages and assistant tool_calls entries from the cascade
  // message list so the planner only sees real human / assistant text plus
  // its trajectory inheritance — duplicate context would confuse it.
  let cascadeMessages;
  if (nativeBridgeOn) {
    cascadeMessages = (messages || []).filter(m => {
      if (m?.role === 'tool') return false;
      if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length && !m.content) return false;
      return true;
    });
  } else if (emulateTools) {
    cascadeMessages = normalizeMessagesForCascade(messages, tools, {
      injectUserPreamble: !disableUserToolFallback,
      modelKey: routingModelKey,
      provider: modelInfo?.provider || null,
      route: body.__route || 'chat',
    });
  } else {
    cascadeMessages = [...messages];
  }
  // Bundle the v2.0.65 native bridge handles into one opts object so we
  // can thread it through nonStreamResponse / streamResponse / cascadeChat
  // without growing every signature by 3+ params.
  const nativeOpts = nativeBridgeOn ? {
    enabled: true,
    allowlist: nativeAllowlist,
    additionalSteps: nativeAdditionalSteps,
    callerLookup: buildReverseLookup(nativeCallerTools),
    callerTools: nativeCallerTools,
  } : null;

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

  // v2.0.58 — drought mode + premium model gate. When every active
  // account is below the weekly threshold AND the operator has the
  // restriction enabled (default ON, toggleable from dashboard or env
  // DROUGHT_RESTRICT_PREMIUM=0), refuse premium models with a clean
  // 503 + retry-after instead of letting the request burn its way to
  // an upstream rate-limit. Free-tier models (gemini-2.5-flash etc.)
  // still go through.
  if (isModelBlockedByDrought(routingModelKey)) {
    const summary = getDroughtSummary();
    const freeList = (summary.freeTierModels || []).slice(0, 4).join(', ') || 'gemini-2.5-flash';
    const retryAfterSec = Math.max(60, Math.min(60 * 60 * 24, 60 * 30)); // hint 30 min by default
    log.warn(`Chat[drought]: blocking premium model ${routingModelKey} (lowestWeekly=${summary.lowestWeeklyPercent}%, ${summary.knownAccounts}/${summary.activeAccounts} accounts known)`);
    return {
      status: 503,
      headers: { 'Retry-After': String(retryAfterSec) },
      body: {
        error: {
          message: `账号池处于配额低水位（drought mode）：所有账号本周配额都低于 ${summary.threshold}%，已暂时屏蔽 premium 模型 ${displayModel}。请改用免费层模型（${freeList}…），或等周配额重置。可在 Dashboard 实验性面板关闭 droughtRestrictPremium 强制下发（会消耗最后一点配额）。`,
          type: 'drought_mode',
          drought: {
            lowestWeeklyPercent: summary.lowestWeeklyPercent,
            lowestDailyPercent: summary.lowestDailyPercent,
            threshold: summary.threshold,
            activeAccounts: summary.activeAccounts,
            allowedModels: summary.freeTierModels,
          },
        },
      },
    };
  }

  // Global model access control (allowlist / blocklist from dashboard)
  const access = isModelAllowed(routingModelKey);
  if (!access.allowed) {
    return { status: 403, body: { error: { message: access.reason, type: 'model_blocked' } } };
  }

  // Per-account model routing preflight: if NO active account has this
  // model in its tier ∩ available list, fail fast instead of looping
  // through every account trying to find one. This surfaces tier
  // entitlement and blocklist errors as a clean 403 rather than a 30s
  // queue timeout → pool_exhausted.
  //
  // QQ-group 2026-04-30 follow-up: if the only ineligibility is that a
  // freshly-added account hasn't been probed yet (userStatusLastFetched=0),
  // the unknown tier is now optimistic (= pro catalog) so this branch
  // shouldn't fire for that case. If we DO end up here with un-probed
  // accounts, surface a different message hinting at probe-pending state
  // rather than the misleading "model not entitled" — that error shaped
  // user reports of "获取不到模型" / "添加账号后不能调用".
  const accounts = getAccountList();
  const anyEligible = accounts.some(a =>
    a.status === 'active' && (a.availableModels || []).includes(routingModelKey)
  );
  if (!anyEligible) {
    const hasUnprobedActive = accounts.some(a => a.status === 'active' && !a.userStatusLastFetched);
    return {
      status: 403,
      body: {
        error: {
          message: hasUnprobedActive
            ? `模型 ${displayModel} 暂不可用：账号刚添加还未完成 tier 检测，请稍候 10-30 秒后重试，或在 dashboard 手动点 Probe`
            : `模型 ${displayModel} 在当前账号池中不可用（未订阅或已被封禁）`,
          type: hasUnprobedActive ? 'probe_pending' : 'model_not_entitled',
        },
      },
    };
  }

  const chatId = genId();
  const created = Math.floor(Date.now() / 1000);
  const ckey = cacheKey(body, callerKey);

  if (stream) {
    return streamResponse(
      chatId,
      created,
      displayModel,
      routingModelKey,
      modelInfo?.provider || null,
      messages,
      cascadeMessages,
      modelEnum,
      modelUid,
      useCascade,
      ckey,
      emulateTools,
      toolPreamble,
      reqId,
      wantJson,
      callerKey,
      {
      checkMessageRateLimit: checkMessageRateLimitFn,
      waitForAccount: waitForAccountFn,
      cachePolicy,
      wantThinking,
      fpOpts: buildReuseOpts({ tools, toolChoice: tool_choice, toolPreamble, preambleTier, emulateTools, route: body.__route || 'chat' }),
      tools,
      route: body.__route || 'chat',
      nativeOpts,
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
  const sharedApiKeyNoScope = !hasPerUserScope(callerKey) && !CASCADE_REUSE_ALLOW_SHARED_API_KEY;
  if (sharedApiKeyNoScope) {
    log.info(`Chat[${reqId}]: cascade reuse disabled — shared API key with no per-user dimension (set CASCADE_REUSE_ALLOW_SHARED_API_KEY=1 to override)`);
  }
  const reuseEnabled = !sharedApiKeyNoScope
    && shouldUseCascadeReuse({ useCascade, emulateTools, modelKey: routingModelKey })
    && (isExperimentalEnabled('cascadeConversationReuse') || shouldForceCascadeReuse({ emulateTools, modelKey: routingModelKey }));
  const strictReuse = shouldUseStrictCascadeReuse({ emulateTools, modelKey: routingModelKey });
  const fpOpts = buildReuseOpts({ tools, toolChoice: tool_choice, toolPreamble, preambleTier: preambleTier || null, emulateTools, route: body.__route || 'chat' });
  const fpBefore = reuseEnabled ? fingerprintBefore(messages, routingModelKey, callerKey, fpOpts) : null;
  let reuseEntry = reuseEnabled ? poolCheckout(fpBefore, callerKey) : null;
  let checkedOutReuseEntry = reuseEntry;
  // v2.0.25 HIGH-2: a SendUserCascadeMessage that hit "cascade not found"
  // marks the entry dead — any restore path further down must drop it
  // instead of putting a known-dead cascadeId back in the pool.
  let reuseEntryDead = false;
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
      acct = acquireAccountByKey(reuseEntry.apiKey, routingModelKey);
      if (!acct) {
        // Owning account busy — wait up to 5s for it instead of immediately
        // giving up. Dropping reuse means falling back to text-blob history
        // which loses context on most models.
        for (let w = 0; w < 10 && !acct; w++) {
          await new Promise(r => setTimeout(r, 500));
          acct = acquireAccountByKey(reuseEntry.apiKey, routingModelKey);
        }
        if (!acct) {
          log.info(`Chat[${reqId}]: reuse MISS — owning account not available after 5s wait`);
          if (strictReuse && checkedOutReuseEntry && fpBefore) {
            const availability = getAccountAvailability(checkedOutReuseEntry.apiKey, routingModelKey);
            const retryAfterMs = strictReuseRetryMs(availability);
            poolCheckin(fpBefore, checkedOutReuseEntry, callerKey, ttlHintFromCachePolicy(cachePolicy));
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
      acct = await waitForAccountFn(tried, null, QUEUE_MAX_WAIT_MS, routingModelKey);
      if (!acct) {
        // Same diagnostic-error fix as the stream path — surface real reason
        // for the queue timeout (rate limit / no entitlement / upstream stall)
        // so the client gets a useful message instead of falling through to
        // a generic pool_exhausted error from the bottom of this function.
        if (!lastErr) {
          const tempUnavail = isAllTemporarilyUnavailable(routingModelKey);
          const rateLimited = isAllRateLimited(routingModelKey);
          const reason = tempUnavail.allUnavailable
            ? `所有可用账号暂时不可用，请 ${Math.ceil(tempUnavail.retryAfterMs / 1000)} 秒后重试`
            : rateLimited.allLimited
            ? `所有可用账号均已达速率限制，请 ${Math.ceil(rateLimited.retryAfterMs / 1000)} 秒后重试`
            : `${Math.ceil(QUEUE_MAX_WAIT_MS / 1000)} 秒内没有账号变为可用 — 账号可能被速率限制或对当前模型无权限`;
          lastErr = {
            status: (tempUnavail.allUnavailable || rateLimited.allLimited) ? 429 : 503,
            body: { error: { message: `${displayModel} 账号队列超时: ${reason}`, type: (tempUnavail.allUnavailable || rateLimited.allLimited) ? 'rate_limit_exceeded' : 'pool_exhausted' } },
          };
        }
        break;
      }
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
            markRateLimited(acct.apiKey, rl.retryAfterMs, routingModelKey);
          }
          if (!reuseEntryDead && strictReuse && checkedOutReuseEntry && fpBefore && checkedOutReuseEntry.apiKey === acct.apiKey) {
            const availability = getAccountAvailability(acct.apiKey, routingModelKey);
            const retryAfterMs = strictReuseRetryMs(availability);
            poolCheckin(fpBefore, checkedOutReuseEntry, callerKey, ttlHintFromCachePolicy(cachePolicy));
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
      client, chatId, created, displayModel, routingModelKey, messages, cascadeMessages, modelEnum, modelUid,
      useCascade, acct.apiKey, ckey,
      reuseEnabled ? { reuseEntry, lsPort: ls.port, apiKey: acct.apiKey, callerKey, cachePolicy, fpOpts } : null,
      modelInfo?.provider || null,
      emulateTools, toolPreamble, wantJson, cachePolicy, wantThinking, tools, body.__route || 'chat',
      nativeOpts,
    );
    if (result.status === 200) return result;
    reuseEntry = null; // don't try to reuse on the retry
    if (result.reuseEntryInvalid) reuseEntryDead = true;
    // #101: same upstream-timeout invalidation as the stream path —
    // see the matching catch block in streamResponse for the full
    // rationale (cascade trajectory left half-broken, next reuse hits
    // it and the model "loses" the prior conversation).
    const _resultMsg = String(result.body?.error?.message || '');
    if (/context deadline exceeded|context cancellation while reading body|client\.timeout/i.test(_resultMsg)) {
      reuseEntryDead = true;
    }
    lastErr = result;
    const errType = result.body?.error?.type;
    // v2.0.61 (#113): policy_blocked → don't rotate accounts, return
    // immediately. The model refused the request, swapping accounts
    // gives the same refusal but burns more quota.
    if (errType === 'policy_blocked') return result;
    // Rate limit: this account is done for this model, try the next one
    if (errType === 'rate_limit_exceeded') {
      if (!reuseEntryDead && strictReuse && checkedOutReuseEntry && fpBefore && checkedOutReuseEntry.apiKey === acct.apiKey) {
        const availability = getAccountAvailability(acct.apiKey, routingModelKey);
        const retryAfterMs = strictReuseRetryMs(availability);
        poolCheckin(fpBefore, checkedOutReuseEntry, callerKey, ttlHintFromCachePolicy(cachePolicy));
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
    if (!reuseEntryDead && checkedOutReuseEntry && fpBefore) {
      poolCheckin(fpBefore, checkedOutReuseEntry, callerKey, ttlHintFromCachePolicy(cachePolicy));
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
  const temporaryUnavailable = isAllTemporarilyUnavailable(routingModelKey);
  if (temporaryUnavailable.allUnavailable) {
    if (!reuseEntryDead && checkedOutReuseEntry && fpBefore) {
      poolCheckin(fpBefore, checkedOutReuseEntry, callerKey, ttlHintFromCachePolicy(cachePolicy));
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
    const rl = isAllRateLimited(routingModelKey);
    if (rl.allLimited) {
      if (checkedOutReuseEntry && fpBefore) {
        poolCheckin(fpBefore, checkedOutReuseEntry, callerKey, ttlHintFromCachePolicy(cachePolicy));
        log.info(`Chat[${reqId}]: restored checked-out cascade after rate limit`);
      }
      const retryAfterSec = Math.ceil(rl.retryAfterMs / 1000);
      return { status: 429, headers: { 'Retry-After': String(retryAfterSec) }, body: { error: { message: `${displayModel} 所有账号均已达速率限制，请 ${retryAfterSec} 秒后重试`, type: 'rate_limit_exceeded', retry_after_ms: rl.retryAfterMs } } };
    }
  }
  if (!reuseEntryDead && checkedOutReuseEntry && fpBefore) {
    poolCheckin(fpBefore, checkedOutReuseEntry, callerKey, ttlHintFromCachePolicy(cachePolicy));
    log.info(`Chat[${reqId}]: restored checked-out cascade after failed request`);
  } else if (reuseEntryDead) {
    log.info(`Chat[${reqId}]: reuse entry was invalidated (cascade not_found upstream); not restoring to pool`);
  }
  return lastErr || { status: 503, body: { error: { message: 'No active accounts available', type: 'pool_exhausted' } } };
}

async function nonStreamResponse(client, id, created, model, modelKey, messages, cascadeMessages, modelEnum, modelUid, useCascade, apiKey, ckey, poolCtx, provider, emulateTools, toolPreamble, wantJson = false, cachePolicy = null, wantThinking = false, tools = [], route = 'chat', nativeOpts = null) {
  const startTime = Date.now();
  const nativeBridgeOn = !!nativeOpts?.enabled;
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
      const chunks = await client.cascadeChat(cascadeMessages, modelEnum, modelUid, {
        reuseEntry: poolCtx?.reuseEntry || null,
        toolPreamble: nativeBridgeOn ? '' : toolPreamble,
        displayModel: model,
        nativeMode: nativeBridgeOn,
        nativeAllowlist: nativeOpts?.allowlist || null,
        additionalSteps: nativeOpts?.additionalSteps || null,
      });
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
      if (nativeBridgeOn) {
        // v2.0.65: planner-native trajectory steps come back via
        // chunks.toolCalls with `cascade_native: true`. Translate each
        // back into the caller's OpenAI tool name + the schema the caller
        // declared. Steps without a caller mapping are dropped — they
        // can't be safely surfaced (caller wouldn't know how to execute).
        const lookup = nativeOpts?.callerLookup || new Map();
        const nativeCalls = [];
        for (const raw of (chunks.toolCalls || [])) {
          if (!raw?.cascade_native) continue;
          const candidates = lookup.get(raw.name) || [];
          const callerName = candidates[0];
          if (!callerName) continue;
          const reverseFn = TOOL_MAP[callerName]?.reverse;
          let cascadeArgs;
          try { cascadeArgs = JSON.parse(raw.argumentsJson || '{}'); } catch { cascadeArgs = {}; }
          let openaiArgs;
          try { openaiArgs = reverseFn ? reverseFn(cascadeArgs) : cascadeArgs; }
          catch { openaiArgs = cascadeArgs; }
          nativeCalls.push({
            id: raw.id || `call_${nativeCalls.length}_${Date.now().toString(36)}`,
            name: callerName,
            argumentsJson: JSON.stringify(openaiArgs ?? {}),
          });
        }
        toolCalls = filterToolCallsByAllowlist(nativeCalls, tools);
        // Strip any tool-call markup that may have leaked into text — the
        // planner sometimes narrates "I'm going to look at X" alongside
        // emitting the cascade step, and the caller doesn't want that
        // noise.
        allText = stripToolMarkupFromText(allText);
        if (toolCalls.length === 0 && (chunks.toolCalls || []).length > 0) {
          log.info(`Chat[non-stream]: nativeBridge=true received ${chunks.toolCalls.length} cascade tool calls but none mapped to caller tools (kinds=${chunks.toolCalls.map(tc => tc.name).join(',')})`);
        }
      } else if (emulateTools) {
        // Capture pre-parse text once for diagnostic logging — useful when
        // non-Claude models emit a tool call in a format the parser missed.
        // Sample only the first 240 chars to keep logs sane.
        const rawTextHead = allText.slice(0, 240).replace(/\s+/g, ' ');
        const parsed = parseToolCallsFromText(allText, {
          modelKey,
          provider,
          // v2.0.62 (#115) — route lets the parser pick the gpt_native
          // dialect when responses.js routed here for a GPT-family model.
          route,
        });
        allText = parsed.text;
        // v2.0.55 audit M2: drop tool_calls whose name isn't in the
        // request-declared tools[] (salvage parser otherwise lets
        // prompt-injection payloads emit calls for tools the caller
        // never offered, e.g. `Bash` when only `get_weather` is declared).
        toolCalls = filterToolCallsByAllowlist(parsed.toolCalls, tools);
        // Diagnostic: emulation was active and the model returned text but no
        // recognized tool call. Surface tool-shaped substrings so we can see
        // whether the model emitted an unsupported format (markdown-fenced
        // JSON, OpenAI native function_call, natural-language "I'll call X")
        // vs simply ignored the prompt and answered conversationally. Used to
        // diagnose "tool_use never appears" reports — issue #109 sub2api E2E.
        if (toolCalls.length === 0 && allText) {
          const markers = [];
          if (/<tool_call/i.test(allText)) markers.push('xml_tag');
          if (/```\s*(?:json|tool_call)/i.test(allText)) markers.push('fenced_json');
          if (/"function"\s*:|"tool_calls"\s*:|"function_call"\s*:/.test(allText)) markers.push('openai_native');
          if (/\{\s*"name"\s*:\s*"[a-zA-Z0-9_-]+"\s*,\s*"arguments"/.test(allText)) markers.push('bare_json');
          if (/^\s*(?:I'?ll|I will|Let me|I'?m going to)\s+(?:call|use|invoke|run)/im.test(allText)) markers.push('natural_lang');
          log.info(`Chat[non-stream]: emulateTools=true but parser found 0 tool_calls (model=${modelKey} provider=${provider}); markers=${markers.join(',') || 'none'}; head="${rawTextHead}"`);
        }
      } else {
        allText = stripToolMarkupFromText(allText);
      }
      // Built-in Cascade tool calls (chunks.toolCalls — edit_file, view_file,
      // list_directory, run_command, etc.) are intentionally DROPPED in
      // emulation/legacy paths. Their argumentsJson and result fields may
      // reference server-internal paths like /tmp/windsurf-workspace/config.yaml
      // and must never be exposed to an API caller. The native bridge path
      // above is the ONLY surface that surfaces these — and it sanitises
      // each tool call's args via reverse mapping before emitting.
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
      allText = stabilizeJsonPayload(allText, messages);
    }
    allThinking = sanitizeText(allThinking);
    if (toolCalls.length) {
      toolCalls = toolCalls.map(tc => sanitizeToolCall(repairToolCallArguments(tc, messages)));
    }
    // GLM5.1 silence fallback (#86 follow-up KLFDan0534) — non-stream path.
    // Same logic as streamResponse: if a non-reasoning model produced ONLY
    // thinking content (and no tool_calls), promote thinking to text so the
    // OpenAI-compatible client renders it as `content`, not `reasoning_content`.
    if (shouldFallbackThinkingToText({
      routingModelKey: modelKey,
      wantThinking,
      accText: allText,
      accThinking: allThinking,
      hasToolCalls: toolCalls.length > 0,
    })) {
      log.info(`Chat[non-stream]: thinking-only response from non-reasoning model ${modelKey}; promoting ${allThinking.length}c thinking → content`);
      allText = allThinking;
      allThinking = '';
    }

    // Check the cascade back into the pool under the *post-turn* fingerprint
    // so the next request in the same conversation can resume it.
    if (poolCtx && cascadeMeta?.cascadeId && (allText || toolCalls.length)) {
      const turnComplete = appendAssistantTurn(messages, allText, toolCalls);
      const fpAfter = fingerprintAfter(turnComplete, modelKey, poolCtx.callerKey || '', poolCtx.fpOpts);
      const ttlHint = ttlHintFromCachePolicy(poolCtx.cachePolicy);
      // Explicit 0 (not undefined) clears any inherited 1h hint when the
      // current request didn't ask for it (MED-2). ttlHintFromCachePolicy
      // returns undefined for "no opinion"; pass 0 when we know the user
      // wants the default TTL.
      poolCheckin(fpAfter, {
        cascadeId: cascadeMeta.cascadeId,
        sessionId: cascadeMeta.sessionId,
        lsPort: poolCtx.lsPort,
        lsGeneration: cascadeMeta.lsGeneration || poolCtx.lsGeneration,
        apiKey: poolCtx.apiKey,
        stepOffset: Number.isFinite(cascadeMeta.stepOffset) ? cascadeMeta.stepOffset : poolCtx.reuseEntry?.stepOffset,
        generatorOffset: Number.isFinite(cascadeMeta.generatorOffset) ? cascadeMeta.generatorOffset : poolCtx.reuseEntry?.generatorOffset,
        historyCoverage: cascadeMeta.historyCoverage || poolCtx.reuseEntry?.historyCoverage || null,
        createdAt: poolCtx.reuseEntry?.createdAt,
      }, poolCtx.callerKey || '', ttlHint === undefined ? 0 : ttlHint);
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
    // the trajectory didn't include a ModelUsageStats field. cachePolicy is
    // threaded through as its own parameter rather than via poolCtx so that
    // non-reuse requests with `cache_control: { ttl: '1h' }` still attribute
    // their tokens to ephemeral_1h_input_tokens correctly (see #82, #83).
    const usage = buildUsageBody(serverUsage, messages, allText, allThinking, cachePolicy);
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
    // v2.0.61 (#113): Anthropic / OpenAI content-policy / verification
    // challenges are NOT transient — rotating accounts won't help and
    // wastes quota. Detect and short-circuit with a clean 451 + clear
    // error so clients stop the retry loop. Patterns are conservative:
    // we only catch unambiguous policy markers, not generic "content
    // moderation" warnings (which can be retried on a different model).
    const isPolicyBlocked = /cyber\s*verification|content[\s_-]+policy|policy[\s_-]+(?:violation|blocked|denied)|safety[\s_-]+(?:policy|blocked)|prompt[\s_-]+(?:rejected|blocked)\s+by[\s_-]+policy|usage[\s_-]+policy[\s_-]+violation/i.test(err.message);
    if (isAuthFail) reportError(apiKey);
    if (isRateLimit) { markRateLimited(apiKey, rateLimitCooldownMs(err.message), modelKey); err.isRateLimit = true; err.isModelError = true; err.kind ||= 'model_error'; }
    if (isInternal) { reportInternalError(apiKey); err.isModelError = true; err.kind ||= 'transient_stall'; }
    if (isTransport) { err.isModelError = true; err.kind ||= 'transient_stall'; }
    if (isPolicyBlocked) { err.isPolicyBlocked = true; err.isModelError = true; err.kind = 'policy_blocked'; }
    // v2.0.56: ban-shaped error → reportBanSignal handles the 2-strike
    // promotion to status='banned'. Skip when also a rate-limit so we
    // don't conflate "out of quota" with "account dead".
    if (!isRateLimit && looksLikeBanSignal(err.message)) {
      reportBanSignal(apiKey, err.message);
      err.isModelError = true; err.kind ||= 'auth_error';
    }
    if (err.isModelError && err.kind !== 'transient_stall' && !isRateLimit && !isInternal) {
      updateCapability(apiKey, modelKey, false, 'model_error');
    }
    recordRequest(model, false, Date.now() - startTime, apiKey);
    log.error('Chat error:', err.message);
    // v2.0.61 — policy block surfaces as 451 Unavailable For Legal Reasons,
    // which is exactly the semantic clients need (the model refuses the
    // request itself, no retry will help).
    if (isPolicyBlocked) {
      return {
        status: 451,
        body: {
          error: {
            message: `请求被上游 policy 拦截 (${model})。这不是账号问题 — 切账号也救不回来；请改 prompt 或换模型再试。原始上游消息：${err.message.slice(0, 200)}`,
            type: 'policy_blocked',
          },
        },
      };
    }
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
      reuseEntryInvalid: !!err.reuseEntryInvalid,
      body: { error: {
        message: isTransient
          ? upstreamTransientErrorMessage(model, 1, isTransport ? 'cascade_transport' : 'internal_error')
          : sanitizeText(err.message),
        type: isTransient ? 'upstream_transient_error' : (err.isModelError ? 'model_not_available' : 'upstream_error'),
      } },
    };
  }
}

function streamResponse(id, created, model, modelKey, provider, messages, cascadeMessages, modelEnum, modelUid, useCascade, ckey, emulateTools, toolPreamble, reqId, wantJson = false, callerKey = '', deps = {}) {
  const checkMessageRateLimitFn = deps.checkMessageRateLimit || checkMessageRateLimit;
  const waitForAccountFn = deps.waitForAccount || waitForAccount;
  // Cache policy threads through deps because streamResponse is a top-level
  // helper, not a closure. Without this, lines that compute TTL hints or
  // attribute usage to ephemeral_5m_input_tokens / ephemeral_1h_input_tokens
  // throw a ReferenceError mid-stream — the exact failure surface reported
  // in issues #82 and #83.
  const cachePolicy = deps.cachePolicy || null;
  const fpOpts = deps.fpOpts || { route: 'chat' };
  // v2.0.55 audit M2: stream parser also needs the request-declared
  // tools[] to filter out tool_calls whose name isn't on the allowlist.
  // Same threat model as nonStreamResponse — prompt-injection content
  // can drive a non-Claude model to emit `<tool_call>{"name":"Bash"}…`
  // even when the caller only declared `get_weather`.
  const declaredTools = Array.isArray(deps.tools) ? deps.tools : [];
  // v2.0.65 (#115) — native tool bridge handles. Stream path consumes the
  // same shape as nonStreamResponse: `{enabled, allowlist, additionalSteps,
  // callerLookup, callerTools}`. When enabled, stream emits cascade-native
  // trajectory steps directly as OpenAI tool_call deltas (the planner is in
  // DEFAULT mode and proposes view_file / run_command / grep_search_v2 / find
  // / list_dir as first-class steps, not as <tool_call> markup in text).
  const nativeOpts = deps.nativeOpts || null;
  const nativeBridgeOn = !!nativeOpts?.enabled;
  return {
    status: 200,
    stream: true,
    headers: {
      'Content-Type': 'text/event-stream',
      // no-store (not no-cache) so middlebox aggregators like sub2api (#97)
      // don't priority-cache SSE chunks and replay them for fresh requests.
      'Cache-Control': 'no-store',
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
      const sharedApiKeyNoScopeStream = !hasPerUserScope(callerKey) && !CASCADE_REUSE_ALLOW_SHARED_API_KEY;
      const reuseEnabled = !sharedApiKeyNoScopeStream
        && shouldUseCascadeReuse({ useCascade, emulateTools, modelKey })
        && (isExperimentalEnabled('cascadeConversationReuse') || shouldForceCascadeReuse({ emulateTools, modelKey }));
      const strictReuse = shouldUseStrictCascadeReuse({ emulateTools, modelKey });
      const fpBefore = reuseEnabled ? fingerprintBefore(messages, modelKey, callerKey, fpOpts) : null;
      let reuseEntry = reuseEnabled ? poolCheckout(fpBefore, callerKey) : null;
      let checkedOutReuseEntry = reuseEntry;
      // v2.0.25 HIGH-2: same dead-entry signal as the non-stream path.
      let reuseEntryDead = false;
      if (reuseEntry) log.info(`Chat: cascade reuse HIT cascadeId=${reuseEntry.cascadeId.slice(0, 8)}… stream model=${model}`);

      // Strip <tool_call>/<tool_result> blocks in Cascade mode.
      // In emulation mode, parsed calls are emitted as OpenAI tool_calls.
      // In non-emulation mode, blocks are silently stripped (defense-in-depth
      // against Cascade's system prompt inducing tool markup).
      //
      // These are re-created at the start of each retry attempt (before the
      // first chunk is consumed) so stale buffers from a failed attempt —
      // e.g. a half-read `<tool_call>` tag — can't corrupt the next
      // account's stream. `let` bindings so the retry loop below can
      // reassign.
      let toolParser = useCascade ? new ToolCallStreamParser({
        parseBareJson: emulateTools,
        parseToolCode: emulateTools,
        modelKey,
        provider,
        route: deps?.route || 'chat',
      }) : null;
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
                if (emulateTools) {
                  // v2.0.55 audit M2: filter against declaredTools allowlist
                  // before emitting. Empty list → block everything (caller
                  // didn't declare any tools).
                  const filtered = filterToolCallsByAllowlist([item.toolCall], declaredTools);
                  if (!filtered.length) continue;
                  const tc = sanitizeToolCall(repairToolCallArguments(filtered[0], messages));
                  const idx = collectedToolCalls.length;
                  collectedToolCalls.push(tc);
                  emitToolCallDelta(tc, idx);
                }
              }
              safeText = '';
            } else {
              // Only emit tool_call deltas when emulating — otherwise the
              // parsed calls came from Cascade's built-in tools and are
              // silently discarded. Sanitize server-internal paths out of
              // the emulated call's input too (issue #38) — otherwise Claude
              // Code tries to Read the sandbox path and fails.
              const filteredCalls = emulateTools
                ? filterToolCallsByAllowlist(parsed.toolCalls, declaredTools)
                : [];
              for (const rawTc of filteredCalls) {
                const tc = sanitizeToolCall(repairToolCallArguments(rawTc, messages));
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
            if (useCascade) {
              toolParser = new ToolCallStreamParser({
                parseBareJson: emulateTools,
                parseToolCode: emulateTools,
                modelKey,
                provider,
                route: deps?.route || 'chat',
              });
            }
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
            if (!acct) {
              // Without an explicit lastErr here, the final retry-failed log
              // ends up printing an empty message and the SSE error event
              // surfaces as a 30s silent stall to the client — issue #77 from
              // zhangzhang-bit. Diagnose what kept the queue empty so the
              // operator sees the real cause (rate limit / no entitlement /
              // upstream stall) instead of guessing.
              if (!lastErr) {
                const tempUnavail = isAllTemporarilyUnavailable(modelKey);
                const rateLimited = isAllRateLimited(modelKey);
                const reason = tempUnavail.allUnavailable
                  ? `所有可用账号暂时不可用，请 ${Math.ceil(tempUnavail.retryAfterMs / 1000)} 秒后重试`
                  : rateLimited.allLimited
                  ? `所有可用账号均已达速率限制，请 ${Math.ceil(rateLimited.retryAfterMs / 1000)} 秒后重试`
                  : `${Math.ceil(QUEUE_MAX_WAIT_MS / 1000)} 秒内没有账号变为可用 — 账号可能被速率限制或对当前模型无权限`;
                lastErr = Object.assign(
                  new Error(`${model} 账号队列超时: ${reason}`),
                  { type: (tempUnavail.allUnavailable || rateLimited.allLimited) ? 'rate_limit_exceeded' : 'pool_exhausted' }
                );
              }
              break;
            }
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
                if (!reuseEntryDead && strictReuse && checkedOutReuseEntry && fpBefore && checkedOutReuseEntry.apiKey === acct.apiKey) {
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
                onChunk, signal: abortController.signal, reuseEntry,
                toolPreamble: nativeBridgeOn ? '' : toolPreamble,
                displayModel: model,
                nativeMode: nativeBridgeOn,
                nativeAllowlist: nativeOpts?.allowlist || null,
                additionalSteps: nativeOpts?.additionalSteps || null,
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
              // M2 allowlist on the tail flush as well — stream end can
              // still emit tail tool_calls and they need the same filter.
              const filteredTail = emulateTools
                ? filterToolCallsByAllowlist(tail.toolCalls, declaredTools)
                : [];
              for (const rawTc of filteredTail) {
                const tc = sanitizeToolCall(repairToolCallArguments(rawTc, messages));
                const idx = collectedToolCalls.length;
                collectedToolCalls.push(tc);
                emitToolCallDelta(tc, idx);
              }
              // Diagnostic: same as nonStreamResponse but for the SSE path —
              // surface why no tool_calls came out when emulation was active.
              // See nonStreamResponse for marker rationale (#109 sub2api E2E).
              if (emulateTools && collectedToolCalls.length === 0 && accText) {
                const head = accText.slice(0, 240).replace(/\s+/g, ' ');
                const markers = [];
                if (/<tool_call/i.test(accText)) markers.push('xml_tag');
                if (/```\s*(?:json|tool_call)/i.test(accText)) markers.push('fenced_json');
                if (/"function"\s*:|"tool_calls"\s*:|"function_call"\s*:/.test(accText)) markers.push('openai_native');
                if (/\{\s*"name"\s*:\s*"[a-zA-Z0-9_-]+"\s*,\s*"arguments"/.test(accText)) markers.push('bare_json');
                if (/^\s*(?:I'?ll|I will|Let me|I'?m going to)\s+(?:call|use|invoke|run)/im.test(accText)) markers.push('natural_lang');
                log.info(`Chat[stream]: emulateTools=true but parser found 0 tool_calls (model=${modelKey} provider=${provider}); markers=${markers.join(',') || 'none'}; head="${head}"`);
              }
            }
            emitContent(pathStreamText.flush());
            emitThinking(pathStreamThinking.flush());

            // v2.0.65 native bridge: cascade trajectory steps come back on
            // cascadeResult.toolCalls with cascade_native:true. Translate
            // each into the caller's OpenAI tool name + reverse-mapped
            // args, allowlist-filter, then emit as tool_call deltas. We do
            // this at the tail (after pathStreamText flush) rather than
            // mid-stream because cascadeChat doesn't expose per-step
            // callbacks for native steps yet — clients see one batched
            // tool_calls turn instead of fully-streamed deltas. That's a
            // known gap; trades streaming-grain for shipping a working
            // bridge first.
            if (nativeBridgeOn && cascadeResult?.toolCalls?.length) {
              const lookup = nativeOpts?.callerLookup || new Map();
              const nativeRaw = [];
              for (const raw of cascadeResult.toolCalls) {
                if (!raw?.cascade_native) continue;
                const candidates = lookup.get(raw.name) || [];
                const callerName = candidates[0];
                if (!callerName) continue;
                const reverseFn = TOOL_MAP[callerName]?.reverse;
                let cascadeArgs;
                try { cascadeArgs = JSON.parse(raw.argumentsJson || '{}'); } catch { cascadeArgs = {}; }
                let openaiArgs;
                try { openaiArgs = reverseFn ? reverseFn(cascadeArgs) : cascadeArgs; }
                catch { openaiArgs = cascadeArgs; }
                nativeRaw.push({
                  id: raw.id || `call_${nativeRaw.length}_${Date.now().toString(36)}`,
                  name: callerName,
                  argumentsJson: JSON.stringify(openaiArgs ?? {}),
                });
              }
              const filteredNative = filterToolCallsByAllowlist(nativeRaw, declaredTools);
              for (const rawTc of filteredNative) {
                const tc = sanitizeToolCall(repairToolCallArguments(rawTc, messages));
                const idx = collectedToolCalls.length;
                collectedToolCalls.push(tc);
                emitToolCallDelta(tc, idx);
              }
              if (filteredNative.length === 0 && cascadeResult.toolCalls.some(tc => tc.cascade_native)) {
                log.info(`Chat[stream]: nativeBridge=true received cascade tool calls but none mapped to caller tools (kinds=${cascadeResult.toolCalls.filter(tc => tc.cascade_native).map(tc => tc.name).join(',')})`);
              }
            }
            // Pool check-in on success (cascade only)
            if (reuseEnabled && cascadeResult?.cascadeId && (accText || collectedToolCalls.length)) {
              const turnComplete = appendAssistantTurn(messages, accText, collectedToolCalls);
              const fpAfter = fingerprintAfter(turnComplete, modelKey, callerKey, fpOpts);
              const ttlHint = ttlHintFromCachePolicy(cachePolicy);
              poolCheckin(fpAfter, {
                cascadeId: cascadeResult.cascadeId,
                sessionId: cascadeResult.sessionId,
                lsPort: ls.port,
                lsGeneration: cascadeResult.lsGeneration || ls.generation,
                apiKey: currentApiKey,
                stepOffset: Number.isFinite(cascadeResult.stepOffset) ? cascadeResult.stepOffset : reuseEntry?.stepOffset,
                generatorOffset: Number.isFinite(cascadeResult.generatorOffset) ? cascadeResult.generatorOffset : reuseEntry?.generatorOffset,
                historyCoverage: cascadeResult.historyCoverage || reuseEntry?.historyCoverage || null,
                createdAt: reuseEntry?.createdAt,
              }, callerKey, ttlHint === undefined ? 0 : ttlHint);
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
              const cleaned = stabilizeJsonPayload(accText, messages);
              if (cleaned) {
                send({ id, object: 'chat.completion.chunk', created, model,
                  choices: [{ index: 0, delta: { content: cleaned }, finish_reason: null }] });
                accText = cleaned;
              }
            }
            // GLM5.1 silence fallback (#86 follow-up KLFDan0534) — see
            // shouldFallbackThinkingToText comment for rationale.
            // Inside streamResponse the routing key arrives as the
            // `modelKey` param (caller passes routingModelKey there);
            // wantThinking comes through deps because body isn't in
            // scope here (#93 follow-up zhangzhang-bit).
            if (shouldFallbackThinkingToText({
              routingModelKey: modelKey,
              wantThinking: deps.wantThinking,
              accText,
              accThinking,
              hasToolCalls: collectedToolCalls.length > 0,
            })) {
              log.info(`Chat[${reqId}]: thinking-only stream from non-reasoning model ${modelKey}; promoting ${accThinking.length}c thinking → content`);
              send({ id, object: 'chat.completion.chunk', created, model,
                choices: [{ index: 0, delta: { content: accThinking }, finish_reason: null }] });
              accText = accThinking;
              accThinking = '';
            }
            const finalReason = collectedToolCalls.length ? 'tool_calls' : 'stop';
            // OpenAI spec: the finish_reason chunk carries NO usage, then a
            // separate terminal chunk has empty choices[] + usage
            // (stream_options.include_usage convention). Emitting usage on
            // both made some clients double-count billing. Drop the first.
            send({ id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: {}, finish_reason: finalReason }] });
            {
              const usage = buildUsageBody(cascadeResult?.usage || null, messages, accText, accThinking, cachePolicy);
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
            // v2.0.25 HIGH-2: client.js marks the error when it tried to
            // recover from a "cascade not found" but couldn't. The entry
            // we held is dead — never restore it on the way out.
            if (err.reuseEntryInvalid) reuseEntryDead = true;
            // #101 (nalayahfowlkest-ship-it): when the upstream model
            // provider times out mid-stream ("context deadline exceeded"
            // / "Client.Timeout or context cancellation while reading
            // body"), the cascade trajectory is left in an inconsistent
            // state — the assistant never finished, but the prior
            // tool_result is still in there. Restoring this cascade to
            // the pool causes the NEXT request to reuse a half-broken
            // trajectory, and the model only sees the trailing tool
            // result with no earlier user prompts ("I can see the
            // content from a previous tool call ... but I don't have
            // the earlier conversation context").
            if (/context deadline exceeded|context cancellation while reading body|client\.timeout/i.test(err.message || '')) {
              reuseEntryDead = true;
            }
            const isAuthFail = /unauthenticated|invalid api key|invalid_grant|permission_denied.*account/i.test(err.message);
            const isRateLimit = /rate limit|rate_limit|too many requests|quota/i.test(err.message);
            const isInternal = /internal error occurred.*error id/i.test(err.message);
            const isTransport = isCascadeTransportError(err);
            const isTransient = isUpstreamTransientError(err, isInternal);
            // v2.0.61 (#113) — same policy detection as nonStreamResponse.
            const isPolicyBlocked = /cyber\s*verification|content[\s_-]+policy|policy[\s_-]+(?:violation|blocked|denied)|safety[\s_-]+(?:policy|blocked)|prompt[\s_-]+(?:rejected|blocked)\s+by[\s_-]+policy|usage[\s_-]+policy[\s_-]+violation/i.test(err.message);
            if (isAuthFail) reportError(currentApiKey);
            if (isRateLimit) { markRateLimited(currentApiKey, rateLimitCooldownMs(err.message), modelKey); err.isRateLimit = true; err.isModelError = true; err.kind ||= 'model_error'; }
            if (isInternal) { reportInternalError(currentApiKey); err.isModelError = true; err.kind ||= 'transient_stall'; }
            if (isPolicyBlocked) { err.isPolicyBlocked = true; err.isModelError = true; err.kind = 'policy_blocked'; }
            if (isTransport) { err.isModelError = true; err.kind ||= 'transient_stall'; }
            // v2.0.56 stream-path ban detection — same 2-strike logic as
            // non-stream. See nonStreamResponse for rationale.
            if (!isRateLimit && looksLikeBanSignal(err.message)) {
              reportBanSignal(currentApiKey, err.message);
              err.isModelError = true; err.kind ||= 'auth_error';
            }
            if (err.isModelError && err.kind !== 'transient_stall' && !isRateLimit && !isInternal) {
              updateCapability(currentApiKey, modelKey, false, 'model_error');
            }
            if (isRateLimit && strictReuse && checkedOutReuseEntry && fpBefore && checkedOutReuseEntry.apiKey === currentApiKey) {
              log.info(`Chat[${reqId}]: strict reuse preserved cascade after rate limit`);
              break;
            }
            // v2.0.61 (#113): policy refusal isn't account-bound, drop
            // out of the retry loop immediately and let the SSE error
            // path emit a 451-style chunk to the client.
            if (isPolicyBlocked) {
              log.warn(`Chat[${reqId}] stream: policy_blocked on ${currentApiKey?.slice(0, 12)}..., not retrying`);
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
        log.error('Stream error after retries:', lastErr?.message || String(lastErr || 'account queue timed out without an error object'));
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
          if (!hadSuccess && !reuseEntryDead && checkedOutReuseEntry && fpBefore) {
            poolCheckin(fpBefore, checkedOutReuseEntry, callerKey, ttlHintFromCachePolicy(cachePolicy));
            log.info(`Chat[${reqId}]: restored checked-out cascade after failed stream`);
          } else if (!hadSuccess && reuseEntryDead) {
            log.info(`Chat[${reqId}]: stream reuse entry was invalidated (cascade not_found upstream); not restoring to pool`);
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
