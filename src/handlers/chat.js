/**
 * POST /v1/chat/completions — OpenAI-compatible chat completions.
 * Routes to RawGetChatMessage (legacy) or Cascade (premium) based on model type.
 */

import { createHash, randomUUID } from 'crypto';
import { WindsurfClient, contentToString, isCascadeTransportError } from '../client.js';
import { getApiKey, acquireAccountByKey, releaseAccountById, currentApiKeyForId, getAccountAvailability, reportError, reportSuccess, markRateLimited, markQuotaExhausted, reportInternalError, reportDeadToken, updateCapability, getAccountList, isAllRateLimited, isAllTemporarilyUnavailable, refundReservation, looksLikeBanSignal, reportBanSignal, clearBanSignals, isModelBlockedByDrought, getDroughtSummary, reLoginAccount, getAccountCount, hasConnectEntitledAccount } from '../auth.js';
import { isStickyEnabled, setStickyBinding } from '../account/sticky-session.js';
import { resolveModel, getModelInfo, pickRateLimitFallback } from '../models.js';
import { getLsFor, ensureLs } from '../langserver.js';
import { config, log } from '../config.js';
import { safeAccountRef, safeKeyRef } from '../log-safety.js';
import { recordRequest, recordTokenUsage, recordPolicyBlocked, recordRateLimited } from '../dashboard/stats.js';
import { extractIntentFromNarrative, detectToolIntentInNarrative } from './intent-extractor.js';
import { isModelAllowed } from '../dashboard/model-access.js';
import { cacheKey, cacheGet, cacheSet } from '../cache.js';
import { isExperimentalEnabled, getBreakerTunable } from '../runtime-config.js';
import { neutralizeClientIdentity } from './identity-neutralize.js';
import { checkMessageRateLimit } from '../windsurf-api.js';
import { getEffectiveProxy } from '../dashboard/proxy-config.js';
import {
  fingerprintBefore, fingerprintAfter, checkout as poolCheckout, checkin as poolCheckin,
} from '../conversation-pool.js';
import {
  normalizeMessagesForCascade, ToolCallStreamParser, parseToolCallsFromText, stripToolMarkupFromText,
  buildToolPreambleForProto, buildCompactToolPreambleForProto,
  buildSchemaCompactToolPreambleForProto, buildSkinnyToolPreambleForProto,
  trimToolsForWeakModel, isWeakEmulationModel,
} from './tool-emulation.js';
import {
  getNativeBridgeDecision, buildReverseLookup,
  buildAdditionalStepsFromHistory, parseNativeFunctionCallsFromText,
  NativeFunctionCallStreamParser, TOOL_MAP, isNativeBridgeAccountAllowed,
  hasNativeBridgeAccountGate, nativeAllowlistNameForTool,
} from '../cascade-native-bridge.js';
import {
  handleSpecialAgentChatCompletion,
} from '../special-agent.js';
import { acpVisionEnabled } from '../devin-acp.js';
import { selectBackend, usesCascadeFlow } from '../backend-router.js';
import { toChatCompletion as _toChatCompletion, streamChatCompletion as _streamChatCompletion } from '../devin-connect-openai.js';
import { resolveConnectSelector } from '../devin-connect-models.js';
import { isRetryable as isConnectRetryable, getToolDefTags, parseToolCallTagMap } from '../devin-connect.js';
import { isRouterModel, assignModel } from '../devin-connect-catalog.js';
import { bumpConnect } from '../devin-connect-metrics.js';
import { newTraceId, traceClientRequest, traceRouting, traceClientResponse, traceEnabled } from '../trace.js';
import { sanitizeText, sanitizeToolCall, PathSanitizeStream } from '../sanitize.js';
import { systemFingerprint } from '../system-fingerprint.js';
import { registerSseController } from '../sse-registry.js';
import {
  recordNativeBridgeAccountGateReject,
  recordNativeBridgeAccountGateSkip,
  recordNativeBridgeCascadeToolCall,
  recordNativeBridgeEmittedToolCall,
  recordNativeBridgeNoToolCallResponse,
  recordNativeBridgeDecision,
  recordNativeBridgeRequest,
  recordNativeBridgeUnmappedCascadeToolCall,
} from '../native-bridge-stats.js';

const HEARTBEAT_MS = 15_000;
const QUEUE_RETRY_MS = 1_000;
const QUEUE_MAX_WAIT_MS = 30_000;
const IP_RATE_LIMIT_BURST_FLOOR_MS = 30_000;

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

function isCompletedReadUrlNativeResult(raw) {
  return !!(raw?.cascade_native
    && raw.name === 'read_url_content'
    && raw.hasWebDocument
    && typeof raw.result === 'string'
    && raw.result.length > 0);
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

const UPSTREAM_DEADLINE_RE = /context deadline exceeded|context cancellation while reading body|client\.timeout/i;

export function isUpstreamDeadlineExceeded(errOrMessage) {
  const msg = typeof errOrMessage === 'string'
    ? errOrMessage
    : String(errOrMessage?.message || '');
  return UPSTREAM_DEADLINE_RE.test(msg);
}

function upstreamDeadlineExceededMessage(model) {
  return `${model} hit the upstream Windsurf provider deadline (~240s): model thinking/output ran longer than the single Cascade stream window. This is not controlled by WindsurfAPI timeout env vars. Split the task, lower reasoning/max output, or use a faster model.`;
}

function upstreamTransientErrorMessage(model, triedCount, reason = 'internal_error') {
  const detail = reason === 'cascade_transport'
    ? 'Cascade/语言服务器 HTTP/2 流被取消'
    : 'internal_error';
  return `${model} 上游 Windsurf Cascade 服务瞬态故障：已在 ${triedCount} 个账号上重试都收到 ${detail}。这是上游或本地语言服务器会话的瞬时问题，建议 30-60 秒后重试；若连续出现，请重启语言服务器。`;
}

export function buildToolRoutingPlan(tools, { useCascade = false, modelKey = '', model = '', provider = null, route = 'chat', callerKey = '' } = {}) {
  const hasTools = Array.isArray(tools) && tools.length > 0;
  const nativeDecision = getNativeBridgeDecision(tools || [], {
    useCascade,
    modelKey,
    model,
    provider,
    route,
    callerKey,
  });
  const { partition, ...nativeDecisionSummary } = nativeDecision;
  const nativeBridgeOn = !!nativeDecision.enabled;
  const emulationTools = nativeBridgeOn ? partition.unmapped : (tools || []);
  return {
    hasTools,
    partition,
    nativeBridgeOn,
    nativeDecision: nativeDecisionSummary,
    emulationTools,
    nativeCallerTools: nativeBridgeOn ? partition.mapped : [],
    shouldBuildToolPreamble: Array.isArray(emulationTools) && emulationTools.length > 0,
  };
}

function isLsPoolExhausted(err) {
  return err?.code === 'LS_POOL_EXHAUSTED' || err?.type === 'ls_pool_exhausted';
}

function lsPoolExhaustedResponse(err) {
  return {
    status: err?.status || 503,
    body: {
      error: {
        message: err?.message || 'Language server pool is exhausted',
        type: 'ls_pool_exhausted',
      },
    },
  };
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

export function effectiveToolsForToolChoice(tools, toolChoice) {
  if (!Array.isArray(tools) || tools.length === 0) return tools || [];
  if (toolChoice === 'none') return [];
  // O5: 'required'/'any' (Anthropic-normalized 'any' → 'required') keeps the
  // FULL tool set available — the "must call ≥1" constraint is enforced in the
  // preamble (resolveToolChoice) and surfaced in diagnostics, NOT by narrowing
  // tools[] here. Only a forced {function:{name}} object narrows the set. This
  // is why 'required' intentionally falls through to `return tools` below —
  // it must NOT be conflated with the 'none' (empty) branch.
  // NB: OpenAI 400s on required + empty tools[]; we early-return above instead
  // (that boundary check belongs to input validation, not O5). TODO(none — FREE).
  let forced = '';
  if (toolChoice && typeof toolChoice === 'object') {
    forced = toolChoice.function?.name || toolChoice.name || '';
  }
  if (!forced) return tools;
  return tools.filter(t => (t?.function?.name || t?.name || '') === forced);
}

function toolNameList(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map(t => t?.function?.name || t?.name || '').filter(Boolean);
}

export function summarizeToolRoutingDiagnostics({ tools, effectiveTools, toolChoice, toolRouting, preambleBudget = null }) {
  const requested = toolNameList(tools);
  const effective = toolNameList(effectiveTools);
  const forcedName = toolChoice && typeof toolChoice === 'object'
    ? (toolChoice.function?.name || toolChoice.name || '')
    : '';
  const reasons = [];

  // O5: classify tool_choice so 'required' is never silently equated to 'auto'
  // in logs/diag. String 'required'/'any' → must call ≥1 tool; forced object →
  // must call the named tool (surfaced separately via forcedName below).
  const toolChoiceMode = forcedName
    ? 'forced'
    : (toolChoice === 'required' || toolChoice === 'any')
      ? 'required'
      : (toolChoice === 'none' ? 'none' : 'auto');

  if (toolChoice === 'none') reasons.push('tool_choice_none');
  if (toolChoiceMode === 'required') reasons.push('tool_choice_required');
  if (forcedName && requested.length && !requested.includes(forcedName)) reasons.push('forced_tool_not_declared');
  if (requested.length && effective.length === 0 && toolChoice !== 'none') reasons.push('effective_tools_empty');
  if (toolRouting?.nativeDecision?.reason) reasons.push(toolRouting.nativeDecision.reason);
  if (toolRouting?.nativeBridgeOn) reasons.push('native_bridge_on');
  if (preambleBudget?.tier) reasons.push(`preamble_${preambleBudget.tier}`);
  if (preambleBudget?.compacted) reasons.push('preamble_compacted');
  if (preambleBudget && preambleBudget.ok === false) reasons.push('preamble_too_large');

  return {
    requested,
    effective,
    mapped: toolNameList(toolRouting?.partition?.mapped || []),
    unmapped: toolNameList(toolRouting?.partition?.unmapped || []),
    nativeBridgeOn: !!toolRouting?.nativeBridgeOn,
    nativeDecisionReason: toolRouting?.nativeDecision?.reason || '',
    preambleTier: preambleBudget?.tier || null,
    preambleBytes: preambleBudget?.finalBytes ?? null,
    forcedName,
    toolChoiceMode,
    reasons: [...new Set(reasons)],
  };
}

function logToolRoutingDiagnostics(reqId, diag) {
  if (!diag || (!diag.requested.length && !diag.reasons.length)) return;
  log.info(
    `ToolRoute[${reqId}]: requested=[${diag.requested.join(',') || 'none'}] ` +
    `effective=[${diag.effective.join(',') || 'none'}] ` +
    `mapped=[${diag.mapped.join(',') || 'none'}] unmapped=[${diag.unmapped.join(',') || 'none'}] ` +
    `native=${diag.nativeBridgeOn ? 'on' : 'off'} nativeReason=${diag.nativeDecisionReason || 'none'} ` +
    `preamble=${diag.preambleTier || 'none'}${diag.preambleBytes != null ? `/${Math.round(diag.preambleBytes / 1024)}KB` : ''} ` +
    `forced=${diag.forcedName || 'none'} reasons=[${diag.reasons.join(',') || 'none'}]`,
  );
}

function bridgeResultList(values) {
  const list = (Array.isArray(values) ? values : [])
    .map(v => String(v || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 80))
    .filter(Boolean);
  return [...new Set(list)].slice(0, 50).join(',') || 'none';
}

function logBridgeResultDiagnostics(reqId, diag) {
  if (!diag || !diag.requestedTools) return;
  log.info(
    `BridgeResult[${reqId}]: bridgeEnabled=${!!diag.bridgeEnabled} ` +
    `cascadeToolCalls=${diag.cascadeToolCalls || 0} ` +
    `mappedToolCalls=${diag.mappedToolCalls || 0} ` +
    `unmappedToolCalls=${diag.unmappedToolCalls || 0} ` +
    `emulatedToolCalls=${diag.emulatedToolCalls || 0} ` +
    `totalToolCalls=${diag.totalToolCalls || 0} ` +
    `noToolCalls=${!!diag.noToolCalls} ` +
    `argParseFailures=${diag.argParseFailures || 0} reverseFailures=${diag.reverseFailures || 0} ` +
    `cascadeKinds=[${bridgeResultList(diag.cascadeKinds)}] ` +
    `mapped=[${bridgeResultList(diag.mappedNames)}] ` +
    `unmapped=[${bridgeResultList(diag.unmappedKinds)}] ` +
    `emulated=[${bridgeResultList(diag.emulatedNames)}]`,
  );
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
 * Map a DEVIN_CONNECT classified error code (from devin-connect.js
 * classifyUpstreamError) to the OpenAI-shaped HTTP status + error type. A
 * free-tier account hitting a paid selector returns MODEL_BLOCKED, which must
 * read as 402 (payment/entitlement) rather than a generic 502.
 */
export function connectErrorToHttp(code) {
  switch (code) {
    case 'MODEL_BLOCKED': return { status: 402, type: 'model_blocked' };
    case 'QUOTA_EXHAUSTED': return { status: 402, type: 'insufficient_quota' };
    case 'UNAUTHORIZED': return { status: 401, type: 'authentication_error' };
    case 'RATE_LIMITED': return { status: 429, type: 'rate_limit_error' };
    case 'CAPACITY': return { status: 503, type: 'capacity_error' };
    case 'UPSTREAM_INTERNAL': return { status: 503, type: 'upstream_transient_error' };
    // CONTENT_BLOCKED: upstream content policy rejected the REQUEST content (not an
    // auth or account fault). 400 invalid_request_error is the honest surface — the
    // caller must change the prompt, not retry or re-auth. NO account penalty.
    case 'CONTENT_BLOCKED': return { status: 400, type: 'invalid_request_error' };
    case 'NO_TOKEN': return { status: 401, type: 'authentication_error' };
    case 'TIMEOUT': return { status: 504, type: 'timeout_error' };
    default: return { status: 502, type: 'upstream_error' };
  }
}

// R1: which classified upstream errors describe an ACCOUNT-specific dry-well
// that a *different* pooled account could satisfy — so the request should fail
// over instead of surfacing 402/429 to the client while healthy accounts sit
// idle. QUOTA_EXHAUSTED (out of credit) and RATE_LIMITED (this account throttled)
// are per-account: finalizeConnectAccount already cools the offending account, so
// the next hop lands on a funded/un-throttled one. Deliberately EXCLUDED:
//   - CAPACITY / UPSTREAM_INTERNAL: the MODEL is overloaded or the backend hiccuped
//     — not an account fault. Failing over would storm every account with the same
//     doomed request; these are handled by in-place replay + short soft cooldown.
//   - MODEL_BLOCKED: a tier/entitlement wall shared by every account of that tier
//     (free→paid selector) — the next account would reject identically.
//   - UNAUTHORIZED: already handled by the dead-token failover path (kind:'dead').
export function isAccountFailoverError(code) {
  return code === 'QUOTA_EXHAUSTED' || code === 'RATE_LIMITED';
}

// O10: official OpenAI error `type` vocabulary. Anything outside this set that
// reaches an OpenAI-family client (/v1/chat/completions, /v1/responses) is
// normalized to the closest official value at the egress boundary. The INTERNAL
// vocabulary (rate_limit_exceeded, upstream_transient_error, ...) is left intact
// everywhere it doubles as classification input for the retry loop,
// shouldAutoFallback, toAnthropicError (messages.js) and geminiError (gemini.js).
export const OFFICIAL_OPENAI_ERROR_TYPES = new Set([
  'invalid_request_error', 'authentication_error', 'permission_error',
  'not_found_error', 'rate_limit_error', 'insufficient_quota',
  'api_error', 'server_error',
]);

const INTERNAL_TO_OPENAI_TYPE = {
  invalid_request: 'invalid_request_error',
  auth_error: 'api_error',
  not_found: 'not_found_error',
  rate_limit_exceeded: 'rate_limit_error',
  pool_exhausted: 'api_error',
  ls_pool_exhausted: 'api_error',
  ls_unavailable: 'api_error',
  upstream_error: 'api_error',
  upstream_transient_error: 'api_error',
  upstream_internal_error: 'api_error',
  upstream_deadline_exceeded: 'api_error',
  timeout_error: 'api_error',
  capacity_error: 'api_error',
  model_blocked: 'permission_error',
  model_not_available: 'api_error',
  payload_too_large: 'invalid_request_error',
  unsupported_media: 'invalid_request_error',
  unsupported_tool_boundary: 'invalid_request_error',
  fabricated_tool_result: 'api_error',
  policy_blocked: 'invalid_request_error',
  backend_error: 'api_error',
  backend_unavailable: 'api_error',
  backend_pool_exhausted: 'api_error',
};

export function normalizeOpenAIErrorType(type, status) {
  if (typeof type === 'string' && OFFICIAL_OPENAI_ERROR_TYPES.has(type)) return type;
  if (type && Object.prototype.hasOwnProperty.call(INTERNAL_TO_OPENAI_TYPE, type)) {
    return INTERNAL_TO_OPENAI_TYPE[type];
  }
  const s = Number(status) || 500;
  if (s === 401) return 'authentication_error';
  if (s === 403) return 'permission_error';
  if (s === 404) return 'not_found_error';
  if (s === 429) return 'rate_limit_error';
  if (s >= 500) return 'api_error';
  return 'invalid_request_error';
}

// Mutate-in-place the error type of an OpenAI-shaped {error:{type}} body. No-op
// on success bodies (no .error) and on already-official types.
export function normalizeOpenAIErrorBody(body, status) {
  if (body && body.error && typeof body.error === 'object' && 'type' in body.error) {
    body.error.type = normalizeOpenAIErrorType(body.error.type, status);
  }
  return body;
}

export function finishPartialStreamAfterError({ id, created, model, send, res }) {
  if (typeof send === 'function') {
    send({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
  }
  if (res && !res.writableEnded) res.write('data: [DONE]\n\n');
}

/**
 * v2.0.71 (#115 server-side fabricate detection): when a tool-emulation
 * request comes back with `markers=none` AND the model output looks like
 * a fabricated tool-call result (epoch timestamp / file path stub /
 * "PROBE_xxx_" pattern), surface a structured error to the caller
 * instead of forwarding the hallucinated text. The model didn't call
 * the function — handing the fake "result" back as if it were real
 * silently corrupts agent loops (codex thinks the shell ran, schedules
 * the next step on a phantom output).
 *
 * The heuristic is intentionally conservative: only triggers when ALL
 * conditions hold:
 *   1. A tool_call was clearly expected (caller asked for it via the
 *      user prompt, or shell-style verbs are present)
 *   2. Model output is short (≤ 240 chars) and contains no narrative
 *   3. Output matches a known fabrication pattern (epoch ts, bare hash,
 *      timestamp-suffixed token, or "I'd run X and get Y" guess)
 *
 * Returns a non-null { reason, hint } when the response looks fabricated.
 */
export function detectFabricatedToolResult(text, { lastUserText = '' } = {}) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 240) return null;
  // Pure epoch / timestamp-only output (e.g. "1777751588" or
  // "PROBE_V0270_1777751588" from real probes seen in the wild).
  // Also catches `2026-05-02T19:53:08Z` style ISO ts the model writes
  // when it thinks it just ran `date`.
  const fabricatedPatterns = [
    /^\d{10,13}$/,                         // bare epoch
    /[A-Z][A-Z0-9_]{3,}_\d{10,}$/,         // PROBE_X_<epoch>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,// ISO timestamp
    /^[a-f0-9]{32,64}$/i,                  // bare hex hash
    /^total \d+\s/im,                      // ls -la fake output
    /^drwx[r-][w-][x-]/m,                  // ls -la directory line
  ];
  let matched = null;
  for (const re of fabricatedPatterns) {
    if (re.test(trimmed)) { matched = re.source; break; }
  }
  if (!matched) return null;
  // Require the user prompt to have clearly asked for an action — random
  // chat ("hi", "thanks") that happens to make the model output a number
  // shouldn't trip this. Look for shell-style verbs in the most recent
  // user turn.
  const askedForAction = /\b(?:run|exec|execute|cat|ls|echo|grep|find|read|search|list|invoke|call)\b/i.test(lastUserText)
    || /\bshell|bash|command|tool|function/i.test(lastUserText);
  if (!askedForAction) return null;
  return {
    reason: 'fabricated_tool_result',
    hint: 'The model returned text that pattern-matches a fabricated tool output (the model did NOT actually call the tool). This typically happens when GPT family runs through cascade emulation — Claude family handles tool calls more reliably. Try `--model claude-sonnet-4.6` or `claude-haiku-4.5`.',
    matchedPattern: matched,
    sample: trimmed.slice(0, 120),
  };
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

// SEC-W2: the `:client:<ip+ua>` bucket is a GUESSED identity, not a real one.
// Behind a reverse proxy every end user collapses to the same proxy IP + the
// same UA (e.g. everyone on Claude Code), so treating `:client:` as a stable
// per-user scope lets user B receive user A's cached answer / resumed cascade —
// a cross-tenant session leak (P0 for shared / relay deployments, which is the
// primary use here). So `:client:` is NOT trusted as a per-user dimension by
// default. A genuine single-user self-host can opt back in with
// WINDSURFAPI_SINGLE_TENANT_CACHE=1 (an opt-in to RELAX, never required for
// safety — fail-safe: forget the flag and you're still isolated).
const SINGLE_TENANT_CACHE = process.env.WINDSURFAPI_SINGLE_TENANT_CACHE === '1';

// True when callerKey has a TRUSTWORTHY per-user / per-session dimension beyond
// a bare API key (`api:<hash>`) or a guessed `:client:` bucket. Callers without
// one must not share response-cache hits or resume each other's cascade — see
// HIGH-3 and SEC-W2 above.
function hasPerUserScope(callerKey) {
  if (typeof callerKey !== 'string' || !callerKey) return false;
  // A real, client-supplied user/session signal is always trusted.
  if (callerKey.includes(':user:')) return true;
  if (callerKey.startsWith('session:')) return true;
  // A guessed `:client:<ip+ua>` bucket is trusted ONLY in explicit single-tenant
  // mode. Default (multi-tenant / relay) treats it as non-isolating so distinct
  // users behind one proxy never share cache/cascade state.
  if (SINGLE_TENANT_CACHE && (callerKey.includes(':client:') || callerKey.startsWith('client:'))) return true;
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

/**
 * Has this account been probed at all? "Probe pending" messaging must only
 * fire for genuinely fresh accounts. An account can carry a resolved tier
 * (e.g. 'expired') from the canary sweep while GetUserStatus came back empty
 * (userStatusLastFetched=0) — keying solely off userStatusLastFetched
 * mislabeled those as "just added, tier detection pending" and sent users to
 * re-probe when the real cause was plan/tier. lastProbed>0 OR a landed
 * GetUserStatus OR any resolved (non-'unknown') tier all mean "probed".
 */
export function accountIsProbed(a) {
  return (a?.lastProbed || 0) > 0
    || (a?.userStatusLastFetched || 0) > 0
    || (!!a?.tier && a.tier !== 'unknown');
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

function readPathKey(args) {
  if (Object.prototype.hasOwnProperty.call(args, 'file_path')) return 'file_path';
  if (Object.prototype.hasOwnProperty.call(args, 'path')) return 'path';
  if (Object.prototype.hasOwnProperty.call(args, 'absolute_path')) return 'absolute_path';
  if (Object.prototype.hasOwnProperty.call(args, 'absolute_path_uri')) return 'absolute_path_uri';
  return 'file_path';
}

function stripFileUriForRepair(path) {
  const raw = String(path || '').replace(/^file:\/\//i, '');
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function internalWorkspaceTail(path) {
  let s = stripFileUriForRepair(path).replace(/\\/g, '/');
  s = s.replace(/^\/([A-Za-z]:\/)/, '$1');
  const patterns = [
    /^(?:[A-Za-z]:)?\/home\/user\/projects\/workspace-[a-z0-9]+(?:\/(.*))?$/i,
    /^\/tmp\/windsurf-workspace(?:\/(.*))?$/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return (m[1] || '').replace(/^\/+/, '');
  }
  if (String(path || '').trim() === '<workspace>') return '';
  return null;
}

function callerWorkingDirectory(messages) {
  const env = extractCallerEnvironment(messages);
  const m = String(env || '').match(/(?:^|\n)- Working directory:\s*([^\n]+)/);
  return m ? m[1].trim() : '';
}

function joinCallerPath(cwd, rel) {
  const cleanRel = String(rel || '').replace(/^[\\/]+/, '');
  if (!cleanRel) return '';
  if (!cwd || internalWorkspaceTail(cwd) !== null || cwd === '<workspace>') return cleanRel;
  const sep = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/';
  return `${cwd.replace(/[\\/]+$/, '')}${sep}${cleanRel.replace(/[\\/]+/g, sep)}`;
}

function repairedPathForKey(key, path) {
  const s = String(path || '');
  if (key !== 'absolute_path_uri' || !s || /^file:\/\//i.test(s)) return s;
  if (/^[A-Za-z]:[\\/]/.test(s)) return `file:///${s.replace(/\\/g, '/')}`;
  if (s.startsWith('/')) return `file://${s}`;
  return s;
}

function extractRequestedReadPath(messages) {
  const text = recentUserText(messages);
  if (!text) return '';
  const backtick = [...text.matchAll(/`([^`\r\n]+)`/g)].map(m => m[1]);
  const bare = [...text.matchAll(/((?:[A-Za-z]:[\\/]|\/|~[\\/]|\.{1,2}[\\/])[^"'`<>\s]+|[A-Za-z0-9._-]+(?:[\\/][A-Za-z0-9._-]+)*\.[A-Za-z0-9]{1,12})/g)].map(m => m[1]);
  for (const candidate of [...backtick, ...bare]) {
    const tail = internalWorkspaceTail(candidate);
    if (tail !== null) return tail || '';
    if (candidate && candidate !== '<workspace>') return candidate;
  }
  return '';
}

function repairReadToolCallArguments(tc, messages) {
  const name = String(tc?.name || '').toLowerCase();
  if (!['read', 'read_file', 'view_file'].includes(name) || typeof tc.argumentsJson !== 'string') return tc;
  let args;
  try { args = JSON.parse(tc.argumentsJson); } catch { return tc; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return tc;
  const key = readPathKey(args);
  const current = args[key];
  if (typeof current !== 'string') return tc;
  const tail = internalWorkspaceTail(current);
  if (tail === null) return tc;
  const replacement = tail
    ? joinCallerPath(callerWorkingDirectory(messages), tail)
    : extractRequestedReadPath(messages);
  if (!replacement || replacement === current) return tc;
  const outputKey = key === 'absolute_path_uri' && name !== 'view_file' ? 'file_path' : key;
  const next = { ...args, [outputKey]: repairedPathForKey(outputKey, replacement) };
  if (outputKey !== key) delete next[key];
  return { ...tc, argumentsJson: JSON.stringify(next) };
}

export function repairToolCallArguments(tc, messages) {
  tc = repairReadToolCallArguments(tc, messages);
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

export function parseRateLimitCooldownMs(message = '') {
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
  return null;
}

export function rateLimitCooldownMs(message = '') {
  return parseRateLimitCooldownMs(message) || 60 * 1000;
}

function formatRetryAfter(ms) {
  const seconds = Math.max(1, Math.ceil(Number(ms) / 1000));
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.ceil((seconds - h * 3600) / 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds - m * 60;
    return s > 0 ? `${m}m${s}s` : `${m}m`;
  }
  return `${seconds}s`;
}

export function rateLimitBurstCooldownMs({ message = '', retryAfterMs = 0, apiKey = '', modelKey = '' } = {}) {
  const candidates = [IP_RATE_LIMIT_BURST_FLOOR_MS];
  const retry = Number(retryAfterMs);
  if (Number.isFinite(retry) && retry > 0) candidates.push(retry);
  const parsed = parseRateLimitCooldownMs(message);
  if (Number.isFinite(parsed) && parsed > 0) candidates.push(parsed);
  if (apiKey) {
    const availability = getAccountAvailability(apiKey, modelKey);
    if (!availability.available && Number.isFinite(availability.retryAfterMs) && availability.retryAfterMs > 0) {
      candidates.push(availability.retryAfterMs);
    }
  }
  return Math.max(...candidates);
}

// F3 (2026-07-10): client-replay mitigation for the Retry-After we advertise on a
// 429. Agent clients (Claude Code) honour Retry-After to schedule their automatic
// retry — so a too-SHORT hint (e.g. a 1s residual cooldown) makes the client
// re-hammer almost immediately and re-trip the same limit, while a too-LONG hint
// (an over-sized upstream reset window) freezes the client for minutes. Clamp the
// advertised value into [floor, ceil]:
//   floor = rlClientBackoffFloorMs (def 0 → NO floor = byte-identical to current
//           behaviour; set e.g. 30000 to make CC actually back off)
//   ceil  = rlClientBackoffCeilMs  (def 600000 → pure safety, only shortens absurd
//           hints; never lengthens a normal one)
// Returns whole seconds (the Retry-After header unit) so header + body agree.
export function clientRetryAfterSeconds(retryAfterMs, env = process.env) {
  const floorMs = getBreakerTunable('rlClientBackoffFloorMs', env);
  const ceilMs = getBreakerTunable('rlClientBackoffCeilMs', env);
  let ms = Number(retryAfterMs);
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (floorMs > 0) ms = Math.max(ms, floorMs);
  if (ceilMs > 0) ms = Math.min(ms, ceilMs);
  return Math.max(1, Math.ceil(ms / 1000));
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
  if (looksLikeJsonPayload(text)) return text;
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

function looksLikeJsonPayload(text) {
  if (typeof text !== 'string') return false;
  const s = text.trim();
  if (!s) return false;
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    return safeJsonParse(s) !== undefined;
  }
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (!fenced) return false;
  const inner = fenced[1].trim();
  if (!((inner.startsWith('{') && inner.endsWith('}')) || (inner.startsWith('[') && inner.endsWith(']')))) {
    return false;
  }
  return safeJsonParse(inner) !== undefined;
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
      `(?:^|\\n)\\s*(?:[-*]\\s+)?(?:${ADJ})?(?:Working\\s+directory|cwd)\\s*[:=]\\s*\`?(${PATH_TAIL})\`?` +
      // Form (b): prose "current working directory is /path" (adjacent path)
      `|(?:current\\s+working\\s+directory(?:\\s+is)?)\\s*[:=]?\\s*\`?(${PATH_TAIL})\`?` +
      // Form (c): Codex / XML-style <cwd>/path/</cwd> tags (no :/= separator)
      `|<cwd>\\s*(${PATH_TAIL})\\s*</cwd>`,
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
          const value = (match.slice(1).find(Boolean) || '').trim();
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

// O11: estimate reasoning (thinking) tokens with the same chars/4 heuristic used
// for completion tokens, so a client that reads
// usage.completion_tokens_details.reasoning_tokens sees a non-zero value whenever
// the model actually produced thinking content (previously hardcoded 0 even with
// visible reasoning). OpenAI's invariant is reasoning_tokens ⊆ completion_tokens,
// so the estimate is clamped to the reported completion count — never larger than
// the whole, and never negative.
function estimateReasoningTokens(thinkingText, completionTokens) {
  const t = typeof thinkingText === 'string' ? thinkingText : '';
  if (!t.length) return 0;
  const est = Math.ceil(t.length / 4);
  const cap = Number.isFinite(completionTokens) ? Math.max(0, completionTokens) : est;
  return Math.min(est, cap);
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
 * Decide whether the caller's <env> block should be lifted into the
 * proto-level tool_calling_section for this request.
 *
 * #209: weak models (claude-5-fable-*) return an empty completion
 * (0 text / 0 thinking / 0 tool_calls) whenever a caller <env> block is
 * lifted alongside tools. Users reproduced this and a non-fable control
 * with the identical payload works, so the lift is fable-toxic and buys
 * nothing there (its planner idles rather than using the facts). Skip the
 * lift for the weak-model family; every other model is unchanged.
 *
 * Only relevant on the emulation path (native tool models don't build the
 * proto preamble). WINDSURFAPI_ENV_LIFT=0 is a global escape hatch that
 * disables the lift for every model.
 */
export function shouldLiftCallerEnv(modelKey, { emulateTools, env = process.env } = {}) {
  if (!emulateTools) return false;
  if (String(env.WINDSURFAPI_ENV_LIFT ?? '1').trim().toLowerCase() === '0') return false;
  if (isWeakEmulationModel(modelKey)) return false;
  return true;
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
 *   prompt_tokens     = inputTokens + cacheReadTokens
 *                       (input the model saw this turn = fresh-input + cache-hit;
 *                       cacheReadTokens is a SUBSET of prompt_tokens per OpenAI's
 *                       cached_tokens spec, not an addition)
 *   completion_tokens = outputTokens
 *   prompt_tokens_details.cached_tokens       = cacheReadTokens
 *   cache_creation_input_tokens (Anthropic ext) = cacheWriteTokens
 *
 * v2.0.68 (#118 wnfilm): cacheWriteTokens is generation-side cache-write
 * cost, NOT input the model processed — it used to land in prompt_tokens
 * which made downstream billing relays (one-api / new-api / sub2api) bill
 * cache-write as if it were normal prompt tokens, blowing through trial
 * quotas in hours. cacheWriteTokens now ships only as the dedicated
 * `cache_creation_input_tokens` field (Anthropic extension already
 * supported by every modern relay). Total tokens still include it via
 * grand-total summation so cost reports stay accurate, but per-bucket
 * accounting matches OpenAI / Anthropic semantics.
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

export function buildUsageBody(serverUsage, messages, completionText, thinkingText = '', cachePolicy = null) {
  if (serverUsage && (serverUsage.inputTokens || serverUsage.outputTokens)) {
    const inputTokens = serverUsage.inputTokens || 0;
    const outputTokens = serverUsage.outputTokens || 0;
    const cacheRead = serverUsage.cacheReadTokens || 0;
    const cacheWrite = serverUsage.cacheWriteTokens || 0;
    // OpenAI semantics: prompt_tokens = total input the model saw this turn,
    // cached_tokens is a SUBSET of prompt_tokens that came from cache. So
    // prompt_tokens = freshInput + cacheRead. cacheWrite is generation-side
    // (the model wrote new content into cache for later reuse) and ships
    // separately on cache_creation_input_tokens, not bundled into
    // prompt_tokens. v2.0.68 (#118) — earlier code added cacheWrite to
    // prompt_tokens which blew up downstream billing relays.
    const promptTokens = inputTokens + cacheRead;
    // Grand total includes cache-write so per-account cost accounting
    // (auth.js usage tally, dashboard charts) still reflects the full
    // cascade-side cost — only the per-bucket fields follow strict
    // OpenAI/Anthropic semantics.
    const totalTokens = promptTokens + outputTokens + cacheWrite;
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
      prompt_tokens: promptTokens,
      completion_tokens: outputTokens,
      total_tokens: totalTokens,
      // OpenAI's `input_tokens` legacy field == prompt_tokens; same shape.
      input_tokens: promptTokens,
      output_tokens: outputTokens,
      prompt_tokens_details: { cached_tokens: cacheRead },
      // O11: reasoning_tokens is a subset of completion_tokens (here == the
      // upstream outputTokens, which already accounts for thinking output), so
      // clamp the estimate to it.
      completion_tokens_details: { reasoning_tokens: estimateReasoningTokens(thinkingText, outputTokens) },
      cache_creation_input_tokens: cacheWrite,
      cache_read_input_tokens: cacheRead,
      cache_creation: cacheCreationSplit,
      // Verbose breakdown for dashboards / billing relays that want the
      // raw cascade numbers without recombining. Non-standard fields are
      // ignored by spec-strict consumers.
      cascade_breakdown: {
        fresh_input_tokens: inputTokens,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        output_tokens: outputTokens,
      },
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
    // O11: completion here already folds thinkingText into the chars/4 estimate,
    // so reasoning_tokens is the thinking portion of that same total (⊆ completion).
    completion_tokens_details: { reasoning_tokens: estimateReasoningTokens(thinkingText, completion) },
  };
}

// ── DEVIN_CONNECT account lifecycle ──────────────────────────────────
// Indirection layer for the connect network calls + re-login, so the failover
// loop below can be exercised offline. Production wires the real modules;
// __setConnectDeps swaps in fakes for tests, __resetConnectDeps restores.
let _connectDeps = {
  toChatCompletion: _toChatCompletion,
  streamChatCompletion: _streamChatCompletion,
};
function toChatCompletion(...args) { return _connectDeps.toChatCompletion(...args); }
function streamChatCompletion(...args) { return _connectDeps.streamChatCompletion(...args); }
export function __setConnectDeps(overrides = {}) { _connectDeps = { ..._connectDeps, ...overrides }; }
export function __resetConnectDeps() {
  _connectDeps = { toChatCompletion: _toChatCompletion, streamChatCompletion: _streamChatCompletion };
}

// The connect path is token-based: it needs a Windsurf session key, which the
// account pool already manages (rotation, RPM budget, rate-limit cooldowns).
// We acquire from the pool so connect requests rotate and count toward quota
// just like Cascade requests. If the pool is empty (operator only set
// WINDSURF_API_KEY/DEVIN_CONNECT_TOKEN in env), acct is null and the connect
// client falls back to the env token — so a single-token deploy still works.
//
// Account selection passes the RESOLVED connect `selector` (not a Cascade
// catalog key) so the connect-namespace entitlement filter keeps a paid selector
// (e.g. a fable) off a free account, which the upstream rejects as
// permission_denied. modelKey stays null — connect selectors are a different
// namespace from the Cascade catalog and must not hit the catalog model-allow filter.
async function acquireConnectAccount(signal, callerKey, selector = null) {
  // Empty pool (single-token deploy: only WINDSURF_API_KEY/DEVIN_CONNECT_TOKEN
  // in env) → there is nothing to wait for. Return null immediately for the
  // env-token fallback instead of blocking QUEUE_MAX_WAIT_MS on every request.
  if (getAccountCount().total === 0) return null;
  const tried = [];
  const acct = await waitForAccount(tried, signal, QUEUE_MAX_WAIT_MS, null, callerKey, selector);
  return acct; // may be null → env-token fallback
}

// Cross-account failover for DEVIN_CONNECT. When the current account's token is
// dead (UNAUTHORIZED) and same-account re-login couldn't mint a fresh one — the
// account was added by raw token (no stored password), or the re-login itself
// failed — we fall through to the NEXT healthy pooled account instead of failing
// the request. `triedKeys` carries every key already burned this request so
// getApiKey never re-picks a known-dead account. Returns the next account or
// null when no untried account is available.
//
// Unlike the initial acquire this does NOT block on the queue: a dead account
// never re-enters the pool as "untried", so waiting on the queue deadline would
// just stall the request for QUEUE_MAX_WAIT_MS before failing. We take whatever
// untried account is selectable right now, or give up immediately.
function acquireConnectFailover(triedKeys, signal, callerKey, selector = null) {
  if (signal?.aborted) return null;
  return getApiKey(triedKeys, null, callerKey, selector);
}

// How many times a single DEVIN_CONNECT request may hop to a fresh pooled
// account after a dead-token failure. 0 disables failover (same-account
// re-login still applies). Default 2 so a request survives a couple of stale
// session tokens without fanning out across the whole pool.
function connectFailoverMax(env = process.env) {
  const raw = Number(env.DEVIN_CONNECT_FAILOVER_MAX);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2;
}

// Pair with acquireConnectAccount on every exit path. Records billing/stats and
// returns the account to the pool. `err` null ⇒ success.
export function finalizeConnectAccount(acct, { model, startTime, err }) {
  if (!acct) {
    // env-token path: still record the request for dashboard totals.
    recordRequest(model, !err, Date.now() - startTime, null);
    return;
  }
  // REF-1/REF-2: acct.apiKey is a snapshot taken at acquire time. A background
  // re-login (UNAUTHORIZED path below) swaps the pool object's apiKey in place
  // without touching this snapshot, so every mark*/report*/release keyed on the
  // stale snapshot would silently no-op — leaking the in-flight slot and losing
  // the cooldown/health signal. Resolve the account's CURRENT apiKey via its
  // immutable id (falls back to the snapshot when the id is unknown), and
  // release by id so the counter always finds its account.
  const apiKey = currentApiKeyForId(acct.id, acct.apiKey);
  if (err) {
    // A client-side abort (caller disconnected) is not an account fault — just
    // release without penalizing the account's error budget.
    const aborted = err.name === 'AbortError' || err.code === 'ABORT_ERR';
    if (aborted) { /* no penalty */ }
    // MODEL_BLOCKED is a tier/entitlement wall (free account asked for a paid
    // selector → upstream "/upgrade"), NOT an account-health problem. Penalizing
    // it would demote a perfectly good free account toward eviction every time a
    // client names claude-*/gpt-* — so release cleanly, same as a success.
    else if (err.code === 'MODEL_BLOCKED') { /* no penalty — tier wall, not a fault */ }
    // CONTENT_BLOCKED is an upstream content-policy rejection of the REQUEST
    // content — the session token is alive and the account is healthy. Penalizing
    // it (dead-token/re-login/cooldown) would bench a perfectly good account over a
    // prompt the caller sent; a single such request used to cascade the whole pool
    // to "exhausted (dead session tokens)". Release cleanly, exactly like a success.
    else if (err.code === 'CONTENT_BLOCKED') { /* no penalty — request content rejected, not an account fault */ }
    else if (err.code === 'QUOTA_EXHAUSTED') {
      // The account ran out of credit/quota — unlike a tier wall this IS an
      // account-specific dry-well. Cool it down so getApiKey stops re-selecting
      // it and serving 402 to every client; failover moves to a funded account.
      // R6: write the cooldown to the QUOTA dimension (quotaResetAt) — the same
      // self-healing dimension a proactive credits snapshot uses — not the
      // transient rateLimitedUntil. This keeps the reactive-402 and proactive-
      // snapshot views of "is this account quota-dry?" consistent; a later
      // balance-recovery snapshot then clears it. 30-min cooldown default bounds
      // the re-probe rate without a hard disable (quota refills per billing cycle).
      markQuotaExhausted(apiKey, 30 * 60 * 1000);
      bumpConnect('quota_exhausted');
    }
    else if (err.code === 'UNAUTHORIZED') {
      reportError(apiKey);
      // The DEVIN_CONNECT session token is an opaque session_id with no refresh
      // path — UNAUTHORIZED most likely means the server retired it. If the
      // account has stored credentials + auto-relogin is enabled, trigger a
      // background re-login (throttled/de-duped in auth.js) so the next request
      // lands on a fresh token instead of a permanently-dead account.
      reLoginAccount(acct.id).catch(() => {});
    }
    else if (err.code === 'RATE_LIMITED') {
      // Honor an explicit upstream reset window when the classifier parsed one
      // (e.g. "message rate limit ... Resets in: 3h0m0s" → err.resetMs). A hard
      // per-model limit is model-scoped, so cool THIS model only and let the pool
      // prefer another account/model for it, rather than benching the account for
      // every model. Falls back to an account-wide burst cooldown when no window
      // was given (generic 429 with no retry-after). F2: that burst duration is
      // now the `rlBurstMs` tunable (default 300000 = the historical 5min, so
      // this is byte-identical unless an operator shortens it — see the tunable's
      // note re: KiroStudio's "bare bursts self-heal in seconds" finding).
      if (Number.isFinite(err.resetMs) && err.resetMs > 0) {
        markRateLimited(apiKey, err.resetMs, model, 'r');
      } else {
        markRateLimited(apiKey, getBreakerTunable('rlBurstMs'), null);
      }
    }
    else if (err.code === 'CAPACITY') {
      // The MODEL is temporarily overloaded ("high demand, try again later") —
      // a transient upstream condition, NOT an account fault. We already replayed
      // it in place once; if it still failed, apply a SHORT model-scoped soft
      // cooldown (60s, auto-recovering via _modelRateLimits) so the pool briefly
      // prefers another account for THIS model, while the account stays fully
      // healthy for every other model. No error-budget penalty, no re-login.
      markRateLimited(apiKey, 60 * 1000, model, 'c');
      bumpConnect('capacity_throttled');
    }
    else if (err.code === 'UPSTREAM_INTERNAL') {
      // Transient upstream BACKEND fault ("an internal error occurred (trace
      // ID/error ID: ...)"), often wrapped in a 401/403 auth shell. NOT a dead
      // token (liveness passes) and NOT an entitlement wall — so no re-login and
      // no MODEL_BLOCKED escalation (#56/#57 shape, internal-error class).
      // reportInternalError tracks a consecutive streak (quarantines 5min after
      // 2 in a row — exactly the persistent backend-fault case) and records a
      // health-window error so selection de-prioritizes a genuinely sick
      // account, WITHOUT the errorCount eviction a plain reportError would cause.
      reportInternalError(apiKey);
      bumpConnect('upstream_internal');
    }
    else reportError(apiKey);
  } else {
    reportSuccess(apiKey);
  }
  recordRequest(model, !err, Date.now() - startTime, apiKey);
  releaseAccountById(acct.id);
}

// Wait until getApiKey returns a non-null account, or until maxWaitMs expires.
// Used when every account has momentarily exhausted its RPM budget so the
// client is queued instead of getting a 503.
async function waitForAccount(tried, signal, maxWaitMs = QUEUE_MAX_WAIT_MS, modelKey = null, callerKey = null, connectSelector = null) {
  const deadline = Date.now() + maxWaitMs;
  let acct = getApiKey(tried, modelKey, callerKey, connectSelector);
  while (!acct) {
    if (signal?.aborted) return null;
    if (Date.now() >= deadline) return null;
    if (callerKey && isStickyEnabled() && isExperimentalEnabled('stickyNoFallback')) {
      log.info('[sticky] NO-FALLBACK waitForAccount — bound account unavailable, failing immediately');
      return null;
    }
    await new Promise(r => setTimeout(r, QUEUE_RETRY_MS));
    acct = getApiKey(tried, modelKey, callerKey, connectSelector);
  }
  return acct;
}

// v2.0.66 (#115): codex CLI 0.128 sends `model="gpt-5.5"` together with a
// separate `reasoning: {effort:"xhigh"}` (or top-level `reasoning_effort`)
// field. Windsurf's catalog exposes per-effort variants as distinct model
// ids — `gpt-5.5-xhigh`, `gpt-5.5-high`, `gpt-5.5-medium`, etc — and the
// bare `gpt-5.5` alias resolves to `gpt-5.5-medium`. Without merging the
// two fields, the user's `xhigh` knob is silently dropped (zhqsuo's #115
// followup: log shows `model=gpt-5.5-medium reasoning=xhigh`).
//
// Merge logic: if reqModel has no effort suffix already AND
// `${reqModel}-${effort}` resolves to a known model in the catalog, swap.
// Anything else (unknown model, no effort, effort already in name)
// returns reqModel unchanged.
export function mergeReasoningEffortIntoModel(reqModel, body) {
  if (!reqModel || typeof reqModel !== 'string') return reqModel;
  const effort = String(
    body?.reasoning_effort
    || body?.reasoning?.effort
    || ''
  ).toLowerCase().trim();
  if (!effort) return reqModel;
  const VALID = new Set(['minimal', 'none', 'low', 'medium', 'high', 'xhigh', 'max']);
  if (!VALID.has(effort)) return reqModel;
  const normalizedEffort = effort === 'minimal' ? 'none' : effort;
  let baseModel = reqModel;
  // If the model already carries an effort suffix, replace it with the explicit
  // request effort instead of treating it as final. Claude Code can send
  // `claude-opus-4-8-medium` together with `reasoning.effort=xhigh`; the
  // separate effort field is the caller's current selection and must win.
  for (const e of VALID) {
    const suffix = '-' + (e === 'minimal' ? 'none' : e);
    if (baseModel.toLowerCase().endsWith(suffix)) {
      baseModel = baseModel.slice(0, -suffix.length);
      break;
    }
  }
  // Try the merged form. resolveModel returns the model key if it exists,
  // unchanged input otherwise; getModelInfo returns null for unknown models.
  // Both checks together guard against accidentally inventing a model that
  // doesn't exist in the catalog.
  const merged = `${baseModel}-${normalizedEffort}`;
  const resolved = resolveModel(merged);
  if (resolved && getModelInfo(resolved)) return merged;
  return reqModel;
}

/**
 * v2.0.85 (#126 KLFDan0534 + #128 wnfilm) — server-side auto-fallback
 * on rate_limit_exceeded.
 *
 * Default ON. When the inner handler returns 429 with a `fallback_model`
 * field (set by chat.js + stream.js when the whole pool is rate-limited
 * on a high-effort variant like `claude-opus-4-7-max`), the wrapper
 * silently retries the request against the suggested lower-effort
 * variant. The caller sees a successful response under the original
 * model name (we restore it post-flight) so existing client code is
 * unaffected.
 *
 * Stream requests are NOT auto-retried — by the time the inner
 * handler decides to error, no chunks have been written yet but the
 * caller flow is harder to rewind. Stream callers see the 429 with
 * the same `fallback_model` hint and can retry client-side.
 *
 * Disable via `WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT=0`.
 */
export function shouldAutoFallback(body, context, result) {
  if (body?.stream) return false;
  if (context?.__fallbackAttempt) return false;
  // v2.0.85 default ON → v2.0.86 default OFF (regression #129) →
  // v2.0.87 default ON again now that the cascade pool indexes the
  // fallback cascade under BOTH the original and the fallback model
  // fingerprint (alias write in conversation-pool.js + chat.js inner
  // — see context.__aliasModelKey threading). This means the next
  // turn from the client (under the original model name) finds the
  // cascade in the pool and reuse stays intact across the fallback.
  if (process.env.WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT === '0') return false;
  const err = result?.body?.error;
  if (!err) return false;
  if (err.type !== 'rate_limit_exceeded') return false;
  if (!err.fallback_model || typeof err.fallback_model !== 'string') return false;
  return true;
}

export async function handleChatCompletions(body, context = {}) {
  // Full-chain trace (gated WINDSURFAPI_TRACE=1): one traceId stitches client
  // request → routing → Devin wire bytes → client response. Reused as reqId so
  // logs and the trace dir share the same id. No-op when tracing is off.
  const traceId = context.traceId || newTraceId();
  const traceStart = Date.now();
  if (traceEnabled()) traceClientRequest(body, { ...context, traceId, protocol: context.protocol || 'openai' });
  // v2.0.88 (audit H-3) — compute original cache key BEFORE any
  // fallback rewrite. We pass it into the inner via context so a
  // successful fallback writes into the cache slot the NEXT identical
  // original-model request will look up, instead of the fallback-model
  // slot that the next request will miss.
  const originalCkey = cacheKey(body, context.callerKey || body.__callerKey || '');
  const result = await _handleChatCompletionsInner(body, { ...context, traceId, __originalCkey: originalCkey });
  if (traceEnabled()) traceClientResponse(traceId, { status: result?.status, stream: !!result?.stream, ms: Date.now() - traceStart, cached: !!result?.__cached });
  if (shouldAutoFallback(body, context, result)) {
    // v2.0.88 (audit H-1) — `body.model` is the RAW request string; the
    // inner handler resolves it through mergeReasoningEffortIntoModel +
    // resolveModel before computing fingerprints. If the client sends
    // `model: claude-opus-4-7` + `reasoning_effort: max` (codex CLI
    // pattern), `body.model` alone is `claude-opus-4-7`, but the
    // routingModelKey used for cascade-pool fingerprints is the merged
    // `claude-opus-4-7-max`. Passing raw `body.model` as
    // `__aliasModelKey` would fingerprint to a slot the next turn
    // never queries — silently re-introducing the v2.0.86 regression
    // for any client that separates effort from model name.
    const originalRoutingKey = resolveModel(mergeReasoningEffortIntoModel(body.model, body));
    const originalModel = body.model;
    const fallbackModel = result.body.error.fallback_model;
    log.info(`auto-fallback: ${originalModel} → ${fallbackModel} (alias-key=${originalRoutingKey} whole pool rate_limited)`);
    const fallbackResult = await _handleChatCompletionsInner(
      { ...body, model: fallbackModel },
      // __aliasModelKey carries the resolved/merged ORIGINAL routing
      // key so cascade pool dual-index hits the slot the next turn
      // will actually look up. __originalCkey threads through so
      // cacheSet writes also go to the original-model cache slot.
      { ...context, __fallbackAttempt: true, __aliasModelKey: originalRoutingKey, __originalCkey: originalCkey },
    );
    // Restore original model id in the response body so client code
    // matching on `response.model === requested model` still works.
    if (fallbackResult?.body) {
      if (typeof fallbackResult.body === 'object' && 'model' in fallbackResult.body) {
        fallbackResult.body.model = originalModel;
      }
      // v2.0.88 (audit M-5): nest under usage.cascade_breakdown
      // instead of body root. OpenAI ChatCompletion top-level fields
      // are spec'd; pydantic v2 with `extra='forbid'` (used by some
      // strict client SDKs) rejected our root-level `served_model`.
      // cascade_breakdown is already an accepted non-standard sibling
      // inside `usage`, so served_model + fallback_reason ride along.
      if (typeof fallbackResult.body === 'object' && !fallbackResult.body.error) {
        const usage = fallbackResult.body.usage = fallbackResult.body.usage || {};
        const cb = usage.cascade_breakdown = usage.cascade_breakdown || {};
        cb.served_model = fallbackModel;
        cb.fallback_reason = 'rate_limit_auto_fallback';
      }
    }
    return fallbackResult;
  }
  return result;
}

async function _handleChatCompletionsInner(body, context = {}) {
  // Reuse the trace id as reqId so log lines Chat[<id>] correlate 1:1 with the
  // <traceId>/ trace dir. Falls back to a random short id when untraced.
  const reqId = context.traceId || Math.random().toString(36).slice(2, 8);
  const {
    stream = false,
    tools,
    tool_choice,
    response_format,
  } = body;
  // O3: honor `max_completion_tokens`, the field newer OpenAI SDKs and the o1/o3/
  // gpt-5 reasoning families send in place of `max_tokens` (which those models
  // reject outright). Accept either for compatibility and prefer the modern name
  // when both are present, matching OpenAI's own precedence. Everything downstream
  // (the connect CompletionConfig at ~1975, cache key) reads this resolved value,
  // so the two spellings converge to one output cap on every backend path.
  const max_tokens = Number.isFinite(body.max_completion_tokens)
    ? body.max_completion_tokens
    : body.max_tokens;
  const effectiveTools = effectiveToolsForToolChoice(tools, tool_choice);
  // v2.0.66: merge reasoning_effort into the model id BEFORE alias
  // resolution so `gpt-5.5 + reasoning.effort=xhigh` resolves to
  // `gpt-5.5-xhigh`, not the medium-tier default.
  const reqModel = mergeReasoningEffortIntoModel(body.model, body);
  let messages = body.messages;
  const callerKey = context.callerKey || body.__callerKey || '';
  const nativeBridgeCallerKey = context.nativeBridgeCallerKey || callerKey;
  const cachePolicy = body.__cachePolicy || null;
  const checkMessageRateLimitFn = context.checkMessageRateLimit || checkMessageRateLimit;
  const waitForAccountFn = context.waitForAccount || waitForAccount;
  const ensureLsFn = context.ensureLs || ensureLs;
  const getLsForFn = context.getLsFor || getLsFor;
  const WindsurfClientClass = context.WindsurfClient || WindsurfClient;

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

  // O2: reject n>1 explicitly. OpenAI's `n` asks for N independent
  // completions, but the Cascade/Devin upstream only ever returns a
  // single choice (all response paths emit choices:[{index:0}]). Silently
  // returning one choice would let a client that reads choices[1..n-1]
  // pick up undefined — a subtler failure than a 400. n=1/null/undefined
  // (the default) pass through unchanged; only n>1 is refused, matching
  // OpenAI's own invalid_request_error shape for unsupported values.
  if (body.n != null && body.n !== 1) {
    return {
      status: 400,
      body: {
        error: {
          message: 'This proxy only supports n=1. The upstream backend returns a single completion per request; set n to 1 (or omit it).',
          type: 'invalid_request_error',
          param: 'n',
        },
      },
    };
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
  let routingModelKey = effectiveModelKey;
  let modelInfo = getModelInfo(effectiveModelKey) || getModelInfo(modelKey);

  // DEVIN_CONNECT short-circuit: the pure-HTTP egress owns its own model
  // dictionary (devin-connect-models.js → proto #21 selectors), which is a
  // different namespace from the Cascade catalog. An operator who flips
  // DEVIN_CONNECT=1 wants every request on that path, so route here BEFORE the
  // Cascade "Unsupported model" gate — otherwise a connect-only selector like
  // `swe-1-6-slow` (no Cascade catalog entry) would 400 before ever reaching
  // the backend. Unmapped names degrade to the free-tier selector downstream.
  if (selectBackend({ modelInfo }).flow === 'devin_connect') {
    const reqModelName = reqModel || config.defaultModel;
    // VISION reroute: the DEVIN_CONNECT synthetic-image path is a dead end for
    // extended-thinking models (un-forgeable #12 server signature). When the
    // request carries images AND ACP vision is enabled, hand it to the ACP path
    // instead — the real devin CLI builds the wire and the server signs its own
    // turns, so vision works for ALL models including opus-4-8 (verified E2E).
    if (acpVisionEnabled() && hasMultimodalContent(messages)) {
      log.info(`Chat[${reqId}]: image request → rerouting ${reqModelName} to ACP vision path (DEVIN_CONNECT synthetic-image path cannot serve thinking models)`);
      return handleSpecialAgentChatCompletion(body, {
        id: genId(),
        created: Math.floor(Date.now() / 1000),
        model: reqModelName,
        modelKey: routingModelKey,
        messages,
        callerKey,
      }, context.specialAgent || {});
    }
    const { selector, mapped } = resolveConnectSelector(reqModelName);
    // P1 whitelist guard: an unmapped model name (mapped:false) means the request
    // does NOT resolve to any real DEVIN_CONNECT selector and would otherwise
    // silently degrade to the free-tier fallback (swe-1-6-slow) — the client
    // asked for opus/gpt/etc. and unknowingly runs a different, free model
    // (wrong output, wrong billing, and a junk name can trip UPSTREAM_INTERNAL
    // and burn the account's health). Reject early with 400 instead of guessing.
    // The whitelist ceiling is the catalog snapshot (devin-catalog-snapshot.json);
    // set WINDSURFAPI_STRICT_MODEL=0 to restore the legacy silent-degrade if the
    // snapshot is stale and a genuinely-live selector is being rejected.
    if (!mapped && String(process.env.WINDSURFAPI_STRICT_MODEL || '1') !== '0') {
      log.warn(`Chat[${reqId}]: DEVIN_CONNECT rejecting unmapped model "${reqModelName}" (not in catalog whitelist) — 400 model_not_found`);
      return {
        status: 400,
        body: { error: {
          message: `The model \`${reqModelName}\` is not a valid model for this endpoint. Call GET /v1/models for the list of available models, or use a known selector (e.g. claude-opus-4-8-medium, claude-5-fable-medium, gpt-5-5-medium).`,
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found',
        } },
      };
    }
    // Tool calling: connect selectors have no native function-calling slot, so
    // we emulate exactly like the Cascade path — inject the tool protocol into
    // the prompt (normalizeMessagesForCascade folds role:tool history and
    // prepends a preamble) and parse <tool_call> markup back out downstream
    // (toChatCompletion / streamChatCompletion with emulateTools). Run the
    // rewrite BEFORE the connect call so no role:'tool' message survives to
    // devin-connect.js's non-protocol [tool result] text wrapper.
    // fable-tier guard: fable's backend hard-fails (UPSTREAM_INTERNAL → breaker →
    // 529) above ~9 tools ON THE PROMPT-EMULATION PATH. Clients like Claude Code
    // send 30. Intelligently trim to the weak-model limit (keeps tool_choice-forced
    // + top agent primitives). No-op for non-weak models and lists within the limit.
    // Env: WINDSURFAPI_WEAK_MODEL_TOOL_LIMIT.
    // NATIVE-PATH EXEMPTION: paid test (2026-07-08) confirmed the native protobuf
    // tool path (nativeToolCall flag) does NOT hit the emulation empty-reply /
    // tool-count ceiling — fable ran clean with tools on the native wire. So when
    // the flag is on, skip the trim and let weak models get the FULL tool set;
    // the trim was a prompt-emulation workaround, not a native-path need.
    const nativeToolFlag = isExperimentalEnabled('nativeToolCall');
    const _trim = nativeToolFlag
      ? { tools: effectiveTools, trimmed: false, kept: Array.isArray(effectiveTools) ? effectiveTools.length : 0, dropped: 0 }
      : trimToolsForWeakModel(effectiveTools, reqModelName, { toolChoice: tool_choice });
    const connectTools = _trim.tools;
    if (_trim.trimmed) log.warn(`Chat[${reqId}]: DEVIN_CONNECT weak model ${reqModelName} — trimmed tools ${effectiveTools.length}→${_trim.kept} (dropped ${_trim.dropped}) to avoid upstream overload`);
    const emulateTools = Array.isArray(connectTools) && connectTools.length > 0;
    // Double-send guard (#49): when the native ToolDef gate is calibrated, tools
    // also ride natively in the #10 `tools` field (connectParams.tools below), so
    // re-describing them in the prompt preamble is redundant and gives the model
    // conflicting instructions. Suppress the preamble ONLY when BOTH gates are on:
    //  - def gate (getToolDefTags): tools are encoded natively, no need to list
    //    them in prose.
    //  - call gate (parseToolCallTagMap): the response carries native tool_calls,
    //    so we don't need the `<tool_call>` markup contract in the preamble either.
    // If only the def gate is on, the response still comes back as <tool_call>
    // markup, so the preamble's protocol instructions MUST stay. role:tool /
    // assistant history folding always runs (still needed until the msg gate lands).
    // nativeToolCall flag: when on, an unset env falls back to the VERIFIED tag
    // constants (useDefault) so the calibrated wire is the default — else the gate
    // only fires on an explicit env override (legacy behavior). Flag default OFF
    // (runtime-config) keeps prompt emulation untouched until a paid probe confirms.
    const nativeFlag = nativeToolFlag; // hoisted above the tool-trim (same request)
    const nativeDefsOn = emulateTools && !!getToolDefTags(process.env, { useDefault: nativeFlag });
    const nativeCallsOn = !!parseToolCallTagMap(process.env, { useDefault: nativeFlag });
    // SOLO calibration mode (DEVIN_CONNECT_TOOL_DEF_SOLO=1, default OFF): force the
    // preamble OFF whenever the def gate is on, so native #10 tool defs are the
    // ONLY tool signal reaching the upstream. This is the black-box probe for the
    // candidate inner tags — if the upstream still understands the tools and emits
    // a tool_call with the preamble suppressed, the candidate ToolDef tags are
    // correct. Do NOT enable in production: with unverified inner tags the frame
    // may be misread. Normal path keeps the preamble unless both gates are on.
    const soloProbe = nativeDefsOn && String(process.env.DEVIN_CONNECT_TOOL_DEF_SOLO || '') === '1';
    const suppressPreamble = soloProbe || (nativeDefsOn && nativeCallsOn);
    if (soloProbe) log.info(`Chat[${reqId}]: DEVIN_CONNECT TOOL_DEF SOLO probe — preamble suppressed, native #10 is the only tool signal`);
    // Native tool_call observability: surface gate state so a paid probe can
    // confirm the native path actually engaged (flag on + tags resolved) vs
    // silently falling back to prompt emulation.
    if (emulateTools) log.info(`Chat[${reqId}]: TOOLCALL nativeFlag=${nativeFlag} defsOn=${nativeDefsOn} callsOn=${nativeCallsOn} suppressPreamble=${suppressPreamble} mode=${(nativeDefsOn && nativeCallsOn) ? 'NATIVE' : 'emulation'}`);
    const nativeStructured = nativeDefsOn && nativeCallsOn;
    let connectMessages = emulateTools
      ? normalizeMessagesForCascade(messages, connectTools, { modelKey: reqModelName, provider: null, route: 'devin_connect', toolChoice: tool_choice, injectUserPreamble: !suppressPreamble, stripOrphans: nativeDefsOn, nativeStructured })
      : messages;
    // DEVIN_CONNECT public egress: neutralize competitor client-identity in the
    // system prompt BODY. This path (incl. Codex /v1/responses and direct
    // /v1/chat/completions) previously had NO neutralization — only the
    // /v1/messages→anthropicToOpenAI path did — so a Claude Code / Agent-SDK
    // system prompt reached Devin verbatim. Live A/B (2026-07-10) proved the
    // "You are a Claude agent, built on Anthropic's Claude Agent SDK" line trips
    // Devin's content policy → permission_denied; neutralizing it lets the exact
    // same heavy request through. Only rewrites system messages; user/assistant
    // content is untouched. Off-switch: WINDSURFAPI_NEUTRALIZE_CLIENT_ID=0.
    if (Array.isArray(connectMessages)) {
      connectMessages = connectMessages.map((m) => {
        if (m?.role !== 'system' || typeof m.content !== 'string') return m;
        const neut = neutralizeClientIdentity(m.content);
        return neut === m.content ? m : { ...m, content: neut };
      });
    }
    log.info(`Chat[${reqId}]: DEVIN_CONNECT ${reqModelName} -> selector=${selector}${mapped ? '' : ' [unmapped→free-tier]'} stream=${!!stream}${emulateTools ? ` tools=${connectTools.length}` : ''}`);
    const ccId = genId();
    const ccCreated = Math.floor(Date.now() / 1000);
    const ccStart = Date.now();
    // Acquire a pooled account for rotation + quota accounting. null ⇒ either
    // the pool is empty (single-token deploy → env-token fallback is correct)
    // OR every account is rate-limited/unavailable (the pool exists but is
    // exhausted). Those two cases must NOT be conflated: silently serving an
    // exhausted-pool request on the un-accounted env token hammers one account
    // toward a ban with zero RPM accounting. Distinguish them and return a
    // clean 429 for genuine exhaustion instead. (P0-2)
    //
    // The check runs BEFORE the queue wait: when the whole pool is rate-limited
    // there's no point holding the connection for QUEUE_MAX_WAIT_MS (the limit
    // may be minutes out) — return a fast 429 with an accurate retry_after so
    // the client backs off. A momentarily-busy (not rate-limited) account still
    // gets the queue benefit via acquireConnectAccount below.
    if (getAccountCount().total > 0) {
      // No account entitled to this selector? (e.g. a paid selector like a fable
      // with only free-tier accounts in the pool.) Fail fast with a clear 403
      // instead of routing to an unentitled account and eating an upstream
      // permission_denied (which surfaces to the client as an opaque 529). A
      // single-token env deploy (DEVIN_CONNECT_TOKEN / WINDSURF_API_KEY) is
      // exempt: it has no pool to filter, so let the env token serve.
      const hasEnvToken = !!(process.env.DEVIN_CONNECT_TOKEN || process.env.WINDSURF_API_KEY);
      if (!hasEnvToken && !hasConnectEntitledAccount(selector)) {
        log.info(`Chat[${reqId}]: DEVIN_CONNECT no account entitled to selector "${selector}" → 403 model_not_entitled`);
        bumpConnect('model_not_entitled');
        return {
          status: 403,
          body: { error: {
            message: `No account in the pool is entitled to model \`${reqModelName}\`. This model requires a paid Windsurf account; the current pool has only free-tier accounts. Add a paid account or request a free-tier model (e.g. swe-1-6-slow).`,
            type: 'invalid_request_error',
            param: 'model',
            code: 'model_not_entitled',
          } },
        };
      }
      const rl = isAllRateLimited(null, selector);
      const tu = isAllTemporarilyUnavailable(null, selector);
      // L2: when degraded-serve is on, DON'T fast-429 a fully-throttled pool here.
      // Fall through to acquireConnectAccount → getApiKey, which will degrade-serve
      // the least-bad transiently-cooled account (pickDegradedFallback) instead of
      // blacking out. A genuine dry-well (quota) still surfaces downstream since the
      // fallback strictly excludes quotaResetAt accounts. Default OFF = the original
      // fast-429 preflight is byte-identical. (tu = temporarily-unavailable, e.g.
      // maintenance, is NOT degradable — only transient rate-limits are — so we only
      // suppress the 429 for the rate-limit arm when a degradable candidate exists.)
      const degradable = getBreakerTunable('degradedServe') && rl.allLimited && !tu.allUnavailable;
      if ((rl.allLimited || tu.allUnavailable) && !degradable) {
        const retryAfterMs = rl.retryAfterMs || tu.retryAfterMs || 60000;
        // F3: clamp the advertised Retry-After so an agent client's auto-retry
        // backs off usefully (floor) and is never frozen by an over-long window
        // (ceil). header + body report the SAME clamped value.
        const retryAfterSec = clientRetryAfterSeconds(retryAfterMs);
        log.info(`Chat[${reqId}]: DEVIN_CONNECT pool exhausted (all accounts rate-limited/unavailable) → 429 retry_after=${retryAfterMs}ms (advertised ${retryAfterSec}s)`);
        bumpConnect('pool_exhausted');
        return {
          status: 429,
          headers: { 'Retry-After': String(retryAfterSec) },
          body: { error: { message: `All DEVIN_CONNECT accounts are temporarily rate-limited. Retry in ~${retryAfterSec}s.`, type: 'rate_limit_exceeded', retry_after_ms: retryAfterSec * 1000 } },
        };
      }
    }
    const ccAcct = await acquireConnectAccount(context.signal, callerKey, selector);
    const connectParams = { messages: connectMessages, model: selector };
    if (ccAcct) connectParams.token = ccAcct.apiKey;
    // Thread the trace id into the connect params so the upstream wire-dump
    // (devin-connect dumpWire) names its .bin files with the same id → the raw
    // Devin request/response bytes land in this request's <traceId>/ dir.
    if (context.traceId) connectParams.traceId = context.traceId;
    // Record the routing decision (leg 02) now that backend + selector + account
    // are resolved. reqModelName is the client-requested model; selector is what
    // we actually send to Devin — the whole point of "what does fable/opus look
    // like in Devin" is captured here + in the wire bytes.
    if (traceEnabled()) traceRouting(context.traceId, {
      backend: 'devin-connect',
      requestedModel: reqModelName,
      selector,
      mapped,
      account: ccAcct ? (ccAcct.email || ccAcct.id) : null,
      accountTier: ccAcct ? ccAcct.tier : null,
      nativeToolCall: !!nativeFlag,
      toolCount: Array.isArray(connectTools) ? connectTools.length : 0,
    });
    // NOTE (2026-07-08): host-forwarding kept but DISARMED-BY-DEFAULT. Live capture
    // disproved the "teams token needs its own apiServerUrl host" theory — real
    // teams GetChatMessage goes to server.codeium.com (same host as the working
    // catalog RPC). streamChat ignores this unless DEVIN_CONNECT_ACCOUNT_HOST=1,
    // which must stay off in production (a non-codeium host breaks chat). Left
    // wired only so an operator can force a host during RE, not as a fix.
    if (ccAcct && ccAcct.apiServerUrl) connectParams.host = ccAcct.apiServerUrl;
    // Forward client sampling controls into the connect CompletionConfig. Without
    // this, temperature/top_p/top_k/max_tokens from the OpenAI (or Anthropic)
    // request were silently dropped on the DEVIN_CONNECT path — every call ran at
    // the built-in defaults regardless of what the caller asked for. Only set
    // keys the caller actually provided; buildCompletionConfig fills the rest with
    // its calibrated defaults. (NB: max_tokens #3 is not an enforced output cap on
    // the free tier — see buildCompletionConfig — but it is forwarded for paid.)
    const completionOverrides = {};
    if (Number.isFinite(body.temperature)) completionOverrides.temperature = body.temperature;
    if (Number.isFinite(body.top_p)) completionOverrides.topP = body.top_p;
    if (Number.isFinite(body.top_k)) completionOverrides.topK = body.top_k;
    if (Number.isFinite(max_tokens)) completionOverrides.maxTokens = max_tokens;
    if (Object.keys(completionOverrides).length) connectParams.completion = completionOverrides;
    // Native tool definitions (groundwork, #49). The connect request builder only
    // emits a real `tools` field when DEVIN_CONNECT_TOOL_DEF_TAGS is calibrated;
    // until then this is inert and tools continue to ride the prompt (emulateTools).
    // Forwarding is harmless when the tag map is unset — the encoder ignores it.
    if (Array.isArray(connectTools) && connectTools.length) connectParams.tools = connectTools;
    // Native tool_call flag: forward so streamChat/buildGetChatMessageRequest fall
    // back to the VERIFIED tag constants when no explicit env override is set.
    if (nativeFlag) connectParams.nativeToolCall = true;
    // Router-model hop (opt-in, default OFF). `adaptive`/`arena-*` are not real
    // model_uids — the server resolves them per request via the AssignModel RPC,
    // and GetChatMessage rejects the bare router uid. When DEVIN_CONNECT_ASSIGN_MODEL=1
    // and the requested name is a router, resolve it to a concrete model_uid here
    // before the chat call. Gated off by default because the AssignModel wire tags
    // are inferred (not yet calibrated on a paid account); a failed/empty resolve
    // degrades gracefully to the original selector rather than failing the request.
    if (process.env.DEVIN_CONNECT_ASSIGN_MODEL === '1' && isRouterModel(reqModelName) && connectParams.token) {
      try {
        const asg = await assignModel({ token: connectParams.token, modelUid: reqModelName, signal: context.signal });
        connectParams.model = asg.model_uid;
        log.info(`Chat[${reqId}]: DEVIN_CONNECT router '${reqModelName}' resolved via AssignModel → ${asg.model_uid}`);
      } catch (e) {
        bumpConnect('assign_model_failed');
        log.warn(`Chat[${reqId}]: DEVIN_CONNECT AssignModel for '${reqModelName}' failed (${e.code || 'ERR'}): ${e.message} — falling back to selector=${selector}`);
      }
    }
    // Thread the client's abort signal into the upstream HTTP request so a
    // disconnected/cancelled caller tears down the in-flight connect call
    // instead of leaking it until the 120s timeout.
    if (context.signal) connectParams.signal = context.signal;
    // O1: honor stream_options.include_usage on the connect path too — the
    // trailing usage frame is emitted only when the caller opted in.
    const connectMeta = { id: ccId, created: ccCreated, displayModel: reqModelName, emulateTools, includeUsage: body.stream_options?.include_usage === true };
    // Shared failover bookkeeping for both stream + non-stream paths. triedKeys
    // accumulates every session token burned this request so getApiKey never
    // re-picks a known-dead account when we hop to the next pool member.
    const triedKeys = [];
    const maxHops = connectFailoverMax();
    if (stream) {
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
        handler: async (res) => {
          // Client-disconnect wiring — mirror the Cascade stream path
          // (streamResponse): a single handler-local AbortController is the
          // one source of truth for teardown. res 'close' covers both the
          // direct OpenAI route (real res) and the messages/gemini/responses
          // routes (their translator fake-res fires 'close' on client
          // disconnect via _clientDisconnected). context.signal chains in the
          // server-level/graceful-shutdown abort threaded from the route.
          const abortController = new AbortController();
          let unregisterSse = () => {};
          res.on('close', () => {
            if (!res.writableEnded) {
              log.info(`Chat[${reqId}]: DEVIN_CONNECT client disconnected mid-stream, aborting upstream`);
              abortController.abort();
            }
          });
          if (context.signal) {
            if (context.signal.aborted) abortController.abort();
            else context.signal.addEventListener('abort', () => abortController.abort(), { once: true });
          }
          let emitted = false;
          const fp = systemFingerprint(reqModelName);
          // O10: 仅直连 OpenAI 客户端(route==='chat')在出口归一化 error.type;
          // messages/gemini/responses 路由写入各自 translator 的 captureRes,
          // 须保留内部词供其 remap。
          const isOpenAIClient = (body.__route || 'chat') === 'chat';
          const send = (data) => {
            // O9:见 streamResponse 的 send。connect 流的 chunk 由
            // devin-connect-openai.js 预置 fp(§2.3),此处 == null 守卫防重复注入;
            // 仅在极少数未预置场景兜底。error 帧不动。
            if (data && data.object === 'chat.completion.chunk' && data.system_fingerprint == null) {
              data.system_fingerprint = fp;
            }
            if (isOpenAIClient && data && data.error && typeof data.error.type === 'string') {
              data.error.type = normalizeOpenAIErrorType(data.error.type);
            }
            if (!res.writableEnded) { emitted = true; res.write(`data: ${JSON.stringify(data)}\n\n`); }
          };
          // Point the upstream connect HTTP call at the handler-local controller
          // (not the raw context.signal set at request setup) so a client
          // disconnect — or the server-shutdown abort below — tears down the
          // in-flight request instead of leaking it until the 120s timeout.
          connectParams.signal = abortController.signal;
          // Register with the SSE registry so graceful-shutdown drain can see
          // this stream and abort it — same contract as the Cascade path. The
          // finally below guarantees a matching unregister.
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
          // SSE heartbeat: keep the connection alive through any silent period
          // (account acquisition, upstream "thinking", failover hops). `:`
          // prefix is a comment line per the SSE spec — clients ignore it,
          // intermediaries see bytes flowing, idle timers reset. Same
          // HEARTBEAT_MS cadence as the Cascade path; the messages/gemini
          // translators forward the raw comment (see createCaptureRes).
          const heartbeat = setInterval(() => {
            if (!res.writableEnded) res.write(': ping\n\n');
          }, HEARTBEAT_MS);
          const stopHeartbeat = () => clearInterval(heartbeat);
          res.on('close', stopHeartbeat);
          // Run one account through the stream, with same-account re-login as the
          // first recovery step. Returns 'ok', 'dead' (token unrecoverable on this
          // account → caller may fail over), or 'error' (non-recoverable). Every
          // recovery is gated on !emitted: once bytes are on the wire a replay
          // would duplicate content, so we surface the error instead.
          const attemptStream = async (a) => {
            const params = a ? { ...connectParams, token: a.apiKey } : connectParams;
            try {
              await streamChatCompletion(params, send, connectMeta);
              finalizeConnectAccount(a, { model: reqModelName, startTime: ccStart, err: null });
              return { kind: 'ok' };
            } catch (err) {
              // Transient blip (5xx / ECONNRESET / server "unavailable") BEFORE
              // any byte hit the wire: the non-stream path already retries these
              // (devin-connect-openai.js maxRetries), but the stream path didn't,
              // so a one-off upstream hiccup surfaced as a hard error to the
              // client. Replay once on the SAME token while !emitted — replaying
              // after bytes are out would duplicate content, so it's gated.
              if (isConnectRetryable(err) && a && !emitted) {
                log.info(`Chat[${reqId}]: DEVIN_CONNECT stream transient error (${err.code || err.status}); replaying once on same token`);
                bumpConnect('transient_replays');
                try {
                  await streamChatCompletion(params, send, connectMeta);
                  finalizeConnectAccount(a, { model: reqModelName, startTime: ccStart, err: null });
                  return { kind: 'ok' };
                } catch (retryErr) {
                  // Retry failed too — fall through to the normal handling below
                  // (which may still recover an UNAUTHORIZED via re-login, or
                  // surface the error). Reassign so the branches below see it.
                  err = retryErr;
                }
              }
              if (err.code === 'UNAUTHORIZED' && a && !emitted) {
                // No force: honor the 60s re-login cooldown. Concurrent callers
                // still coalesce on the inflight promise (auth.js), so a dead
                // token recovers once; sequential bursts within the window reuse
                // that result instead of each firing a fresh Auth1 login — the
                // cutover-day storm guard. force:true is reserved for the
                // scheduled liveness sweep, which is already interval-throttled.
                const freshKey = await reLoginAccount(a.id).catch(() => false);
                if (freshKey && !emitted) {
                  log.info(`Chat[${reqId}]: DEVIN_CONNECT re-login recovered token, replaying stream once`);
                  try {
                    await streamChatCompletion({ ...connectParams, token: freshKey }, send, connectMeta);
                    finalizeConnectAccount(a, { model: reqModelName, startTime: ccStart, err: null });
                    return { kind: 'ok' };
                  } catch (retryErr) {
                    // Fresh token still UNAUTHORIZED ⇒ entitlement wall, not a dead
                    // session (see non-stream path). Reclassify as MODEL_BLOCKED so
                    // we surface a clean error instead of storming re-login +
                    // failover across the pool. Gated on !emitted as always.
                    const reErr = (retryErr.code === 'UNAUTHORIZED' && !emitted)
                      ? Object.assign(new Error('model requires a paid Devin entitlement (fresh session token still UNAUTHORIZED → not a dead token)'), { code: 'MODEL_BLOCKED' })
                      : retryErr;
                    finalizeConnectAccount(a, { model: reqModelName, startTime: ccStart, err: reErr });
                    log.error(`Chat[${reqId}]: DEVIN_CONNECT stream retry error: ${reErr.message}`);
                    return { kind: 'error', err: reErr };
                  }
                }
                finalizeConnectAccount(a, { model: reqModelName, startTime: ccStart, err });
                return !emitted ? { kind: 'dead' } : { kind: 'error', err };
              }
              finalizeConnectAccount(a, { model: reqModelName, startTime: ccStart, err });
              log.error(`Chat[${reqId}]: DEVIN_CONNECT stream error: ${err.message}`);
              return { kind: 'error', err };
            }
          };
          try {
            let acct = ccAcct;
            for (let hops = 0; ; hops++) {
              // Client gone (disconnect or shutdown abort): stop before touching
              // another pooled account. Without this the failover loop keeps
              // hopping fresh accounts — burning quota and holding in-flight
              // slots — to a socket that will never read the bytes. Checked at
              // the top of every iteration so it gates each hop, not just the
              // first attempt.
              if (abortController.signal.aborted) {
                log.info(`Chat[${reqId}]: DEVIN_CONNECT stream aborted (client gone) — stopping account failover`);
                break;
              }
              if (acct) triedKeys.push(acct.apiKey);
              const r = await attemptStream(acct);
              if (r.kind === 'ok') break;
              // Re-check after the (awaited) attempt: the client may have hung up
              // while the upstream call was in flight. Bail before failing over.
              if (abortController.signal.aborted) {
                log.info(`Chat[${reqId}]: DEVIN_CONNECT stream aborted (client gone) — not failing over`);
                break;
              }
              if (r.kind === 'error') {
                // R1: account dry-well (QUOTA/RATE_LIMITED) → fail over to another
                // pooled account instead of erroring the stream — but ONLY while
                // !emitted, since replaying after bytes are on the wire would
                // duplicate content. The offending account is already cooled.
                if (isAccountFailoverError(r.err.code) && !emitted && hops < maxHops) {
                  const next = await acquireConnectFailover(triedKeys, abortController.signal, callerKey, selector);
                  if (next) {
                    log.info(`Chat[${reqId}]: DEVIN_CONNECT ${r.err.code} on account → stream failover hop ${hops + 1} to next pooled account`);
                    bumpConnect('quota_failover_hops');
                    acct = next;
                    continue;
                  }
                }
                send(chatStreamError(r.err.message, 'upstream_error', r.err.code || null));
                break;
              }
              // r.kind === 'dead' — guaranteed !emitted, so a fresh account is safe.
              if (acct) reportDeadToken(acct.apiKey);
              bumpConnect('dead_tokens');
              if (hops >= maxHops || emitted) { bumpConnect('failover_exhausted'); send(chatStreamError('all DEVIN_CONNECT accounts exhausted (dead session tokens)', 'upstream_error', 'UNAUTHORIZED')); break; }
              const next = await acquireConnectFailover(triedKeys, abortController.signal, callerKey, selector);
              if (!next) { bumpConnect('failover_exhausted'); send(chatStreamError('all DEVIN_CONNECT accounts exhausted (dead session tokens)', 'upstream_error', 'UNAUTHORIZED')); break; }
              log.info(`Chat[${reqId}]: DEVIN_CONNECT failover hop ${hops + 1} → next pooled account`);
              bumpConnect('failover_hops');
              acct = next;
            }
            if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
          } finally {
            unregisterSse();
            stopHeartbeat();
          }
        },
      };
    }
    // Non-streaming: nothing reaches the client until we return, so recovery is
    // always safe. Same two-step escalation — same-account re-login, then
    // cross-account failover — wrapped in attempt() per account.
    const attempt = async (a) => {
      const params = a ? { ...connectParams, token: a.apiKey } : connectParams;
      try {
        const out = await toChatCompletion(params, connectMeta);
        finalizeConnectAccount(a, { model: reqModelName, startTime: ccStart, err: null });
        return { kind: 'ok', out };
      } catch (err) {
        if (err.code === 'UNAUTHORIZED' && a) {
          // No force — see the streaming path: honor the 60s cooldown so a
          // mass token-death event recovers each account once instead of
          // storming Auth1 with one full login per in-flight request.
          const freshKey = await reLoginAccount(a.id).catch(() => false);
          if (freshKey) {
            log.info(`Chat[${reqId}]: DEVIN_CONNECT re-login recovered token, retrying once`);
            try {
              const out = await toChatCompletion({ ...connectParams, token: freshKey }, connectMeta);
              finalizeConnectAccount(a, { model: reqModelName, startTime: ccStart, err: null });
              return { kind: 'ok', out };
            } catch (retryErr) {
              // The re-login above minted a verifiably-fresh token (windsurfLogin
              // succeeded), so a SECOND UNAUTHORIZED on that brand-new token cannot
              // be a dead session — the account simply lacks entitlement for this
              // selector (free account → paid model). Upstream returns a bare
              // `permission_denied` with a generic "internal error" body, byte-for-
              // byte indistinguishable from a retired token; the fresh-token retry
              // is what disambiguates. Treat it as a tier wall (MODEL_BLOCKED → 402,
              // no penalty) instead of `dead` — otherwise every free→paid request
              // would storm Auth1 with a re-login per pooled account and then lie to
              // the client with "all accounts exhausted (dead session tokens)".
              const reErr = retryErr.code === 'UNAUTHORIZED'
                ? Object.assign(new Error('model requires a paid Devin entitlement (fresh session token still UNAUTHORIZED → not a dead token)'), { code: 'MODEL_BLOCKED' })
                : retryErr;
              finalizeConnectAccount(a, { model: reqModelName, startTime: ccStart, err: reErr });
              log.error(`Chat[${reqId}]: DEVIN_CONNECT retry-after-relogin error (${reErr.code || 'UPSTREAM_ERROR'}): ${reErr.message}`);
              return { kind: 'error', err: reErr };
            }
          }
          finalizeConnectAccount(a, { model: reqModelName, startTime: ccStart, err });
          return { kind: 'dead' };
        }
        finalizeConnectAccount(a, { model: reqModelName, startTime: ccStart, err });
        return { kind: 'error', err };
      }
    };
    let acct = ccAcct;
    for (let hops = 0; ; hops++) {
      if (acct) triedKeys.push(acct.apiKey);
      const r = await attempt(acct);
      if (r.kind === 'ok') return r.out;
      if (r.kind === 'error') {
        // R1: QUOTA_EXHAUSTED / RATE_LIMITED are ACCOUNT dry-wells — the offending
        // account was just cooled by finalizeConnectAccount, so if the pool still
        // has another account, move the request there instead of handing the client
        // a 402/429 while healthy accounts sit idle. Non-stream is always replay-safe
        // (nothing reached the client yet). Exhausted pool → fall through to surface.
        if (isAccountFailoverError(r.err.code) && hops < maxHops) {
          const next = await acquireConnectFailover(triedKeys, context.signal, callerKey, selector);
          if (next) {
            log.info(`Chat[${reqId}]: DEVIN_CONNECT ${r.err.code} on account → failover hop ${hops + 1} to next pooled account`);
            bumpConnect('quota_failover_hops');
            acct = next;
            continue;
          }
        }
        // Map the classified upstream code to the right HTTP status/type so a
        // free-tier /upgrade rejection reads as 402 model_blocked, an auth failure
        // as 401, and a rate limit as 429 — not a blanket 502.
        const { status, type } = connectErrorToHttp(r.err.code);
        log.error(`Chat[${reqId}]: DEVIN_CONNECT error (${r.err.code || 'UPSTREAM_ERROR'} -> ${status}): ${r.err.message}`);
        return { status, body: { error: { message: r.err.message, type, code: r.err.code || null } } };
      }
      // r.kind === 'dead' — the session token couldn't be revived on this account.
      if (acct) reportDeadToken(acct.apiKey);
      bumpConnect('dead_tokens');
      if (hops >= maxHops) {
        const { status, type } = connectErrorToHttp('UNAUTHORIZED');
        log.error(`Chat[${reqId}]: DEVIN_CONNECT failover exhausted after ${hops} hop(s)`);
        bumpConnect('failover_exhausted');
        return { status, body: { error: { message: 'all DEVIN_CONNECT accounts exhausted (dead session tokens)', type, code: 'UNAUTHORIZED' } } };
      }
      const next = await acquireConnectFailover(triedKeys, context.signal, callerKey, selector);
      if (!next) {
        const { status, type } = connectErrorToHttp('UNAUTHORIZED');
        log.error(`Chat[${reqId}]: DEVIN_CONNECT no more pooled accounts for failover`);
        bumpConnect('failover_exhausted');
        return { status, body: { error: { message: 'all DEVIN_CONNECT accounts exhausted (dead session tokens)', type, code: 'UNAUTHORIZED' } } };
      }
      log.info(`Chat[${reqId}]: DEVIN_CONNECT failover hop ${hops + 1} → next pooled account`);
      bumpConnect('failover_hops');
      acct = next;
    }
  }

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

  // Global model access control (allowlist / blocklist from dashboard).
  // This must run before special-agent routing as well as Cascade routing;
  // otherwise SWE/adaptive models would bypass operator policy.
  let access = isModelAllowed(routingModelKey);
  if (!access.allowed) {
    // Optional fallback: if the operator configured a default model, retarget
    // a blocked/unlisted request to it instead of rejecting outright (#198).
    // The fallback target is re-validated against the catalog AND the access
    // policy, so it can neither resolve to an unknown model nor smuggle a
    // model the operator hasn't themselves allowed.
    const fallbackRaw = access.defaultModel;
    if (fallbackRaw) {
      const fallbackKey = resolveEffectiveModelKey(resolveModel(fallbackRaw), wantThinking);
      const fallbackInfo = getModelInfo(fallbackKey);
      const fallbackAccess = fallbackInfo ? isModelAllowed(fallbackKey) : { allowed: false };
      if (fallbackInfo && fallbackAccess.allowed) {
        log.info(`Chat[${reqId}]: ${routingModelKey} blocked (${access.reason}); falling back to default model ${fallbackKey}`);
        routingModelKey = fallbackKey;
        modelInfo = fallbackInfo;
        access = fallbackAccess;
      } else {
        log.warn(`Chat[${reqId}]: ${routingModelKey} blocked and default model "${fallbackRaw}" is unusable (info=${!!fallbackInfo}, allowed=${fallbackAccess.allowed}); rejecting`);
        return { status: 403, body: { error: { message: access.reason, type: 'model_blocked' } } };
      }
    } else {
      return { status: 403, body: { error: { message: access.reason, type: 'model_blocked' } } };
    }
  }

  // Backend selection is centralized in backend-router.selectBackend(). This
  // is behaviour-preserving: special_agent → special-agent handler; otherwise
  // useCascade mirrors the legacy `!!(modelUid || modelEnum)`. The router gives
  // P2/P3 a single seam to add Devin REST + entitlement routing.
  const backendSel = selectBackend({ modelInfo });
  if (backendSel.flow === 'special_agent') {
    log.info(`Chat[${reqId}]: routing ${routingModelKey} through special-agent backend (${backendSel.backend})`);
    return handleSpecialAgentChatCompletion(body, {
      id: genId(),
      created: Math.floor(Date.now() / 1000),
      model: displayModel,
      modelKey: routingModelKey,
      messages,
      callerKey,
    }, context.specialAgent || {});
  }

  const modelEnum = modelInfo?.enumValue || 0;
  const modelUid = modelInfo?.modelUid || null;
  // Cascade requires either a valid modelUid (string) or a recognized modelEnum.
  // Legacy RawGetChatMessage is deprecated (returns empty on current LS).
  // Models with only an old enum and no UID may fail with "neither PlanModel
  // nor RequestedModel" — those models were removed from Windsurf upstream.
  const useCascade = usesCascadeFlow(backendSel);

  // Tool-call emulation: if the client passed OpenAI-style tools[], we rewrite
  // tool-result turns into synthetic user text and inject the tool protocol
  // at the system-prompt level via CascadeConversationalPlannerConfig's
  // tool_calling_section (SectionOverrideConfig, OVERRIDE mode). This is far
  // more reliable than user-message-level injection because NO_TOOL mode's
  // baked-in system prompt tells the model "you have no tools" — which
  // overpowers user-message preambles. The section override replaces that
  // section directly so the model sees our emulated tool definitions as
  // authoritative system instructions.
  const hasTools = Array.isArray(effectiveTools) && effectiveTools.length > 0;
  const hasToolHistory = Array.isArray(messages) && messages.some(m => m?.role === 'tool' || (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length));
  const emulateTools = useCascade && (hasTools || hasToolHistory);

  // v2.0.66 (#115) — partition-mode native tool bridge.
  //
  // Splits caller's tools[] into:
  //   mapped:    have a TOOL_MAP entry → cascade native trajectory steps
  //              (DEFAULT planner_mode + tool_allowlist + additional_steps[9])
  //   unmapped:  no mapping → existing NO_TOOL emulation toolPreamble
  //              (additional_instructions_section)
  //
  // Both subsets coexist in the same request — when codex CLI 0.128 sends
  // 11 tools and only `shell_command` maps, the planner runs DEFAULT mode
  // with shell_command enabled while update_plan / apply_patch / etc stay
  // on the emulation path. See src/cascade-native-bridge.js for the
  // partition / canMap / shouldUseNativeBridge gate.
  //
  // v2.0.65 used canMapAllTools (all-or-nothing) which never fired for
  // codex CLI in production — the gate is now partitionTools().hasAny.
  const toolRouting = buildToolRoutingPlan(effectiveTools, {
    useCascade,
    modelKey: routingModelKey,
    model: reqModel || body.model || modelKey,
    provider: modelInfo?.provider || null,
    route: body.__route || 'chat',
    callerKey: nativeBridgeCallerKey,
  });
  if (Array.isArray(tools) || toolRouting.nativeDecision.mode) {
    recordNativeBridgeDecision({
      ...toolRouting.nativeDecision,
      toolChoiceFiltered: effectiveTools.length !== (Array.isArray(tools) ? tools.length : 0),
    });
  }
  const toolPartition = toolRouting.partition;
  const nativeBridgeOn = toolRouting.nativeBridgeOn;
  const nativeAdditionalSteps = nativeBridgeOn
    ? buildAdditionalStepsFromHistory(messages || [])
    : [];
  const nativeAllowlist = nativeBridgeOn
    ? Array.from(new Set(toolPartition.mapped
        .map(t => nativeAllowlistNameForTool(t?.function?.name))
        .filter(Boolean)))
    : [];
  // Tools we ship to the emulation toolPreamble: the unmapped subset when
  // bridge is on, or the full tools[] when bridge is off (legacy behaviour).
  const emulationTools = toolRouting.emulationTools;
  const nativeCallerTools = toolRouting.nativeCallerTools;
  if (nativeBridgeOn) {
    const mappedNames = toolPartition.mapped.map(t => t?.function?.name).join(',') || '(none)';
    const unmappedNames = toolPartition.unmapped.map(t => t?.function?.name).join(',') || '(none)';
    recordNativeBridgeRequest({
      mappedTools: toolPartition.mapped.map(t => t?.function?.name).filter(Boolean),
      unmappedTools: toolPartition.unmapped.map(t => t?.function?.name).filter(Boolean),
      additionalSteps: nativeAdditionalSteps.length,
    });
    log.info(`Chat[${reqId}]: native bridge ON — model=${routingModelKey} mapped=[${mappedNames}] unmapped=[${unmappedNames}] allowlist=${nativeAllowlist.join(',')} additional_steps=${nativeAdditionalSteps.length}`);
  }
  if (nativeBridgeOn && hasNativeBridgeAccountGate()) {
    const hasAllowedAccount = getAccountList()
      .some(a => a.status === 'active' && isNativeBridgeAccountAllowed(a));
    if (!hasAllowedAccount) {
      recordNativeBridgeAccountGateReject();
      return {
        status: 503,
        body: {
          error: {
            message: 'Native bridge is enabled, but no active account matches WINDSURFAPI_NATIVE_TOOL_BRIDGE_ACCOUNTS.',
            type: 'native_bridge_account_unavailable',
          },
        },
      };
    }
  }
  // Build proto-level preamble (goes into tool_calling_section override).
  // Also inject into the last user message as fallback — some models in
  // NO_TOOL mode ignore the SectionOverride entirely and refuse to call
  // tools unless they see the definitions in the conversation itself. (#22)
  // Lift the caller's environment hints (cwd, git status, platform) into
  // the proto-level system slot so Cascade's authoritative planner system
  // prompt can no longer override them with /tmp/windsurf-workspace
  // priors. See extractCallerEnvironment() above for the parser.
  //
  // #209: skip the env-lift for weak models (fable) that idle to an empty
  // completion when a caller <env> block rides into the tool_calling_section.
  // See shouldLiftCallerEnv() for the rationale + escape hatch.
  const callerEnv = shouldLiftCallerEnv(routingModelKey, { emulateTools })
    ? extractCallerEnvironment(messages) : '';
  let toolPreamble = '';
  let preambleTier = null;
  let toolPreambleBudget = null;
  // Payload budget for the proto-level tool preamble. The upstream LS
  // panel state caps total request size at ~30KB; the preamble alone can
  // approach that with 30+ tools (Claude Code, opencode, Cline). Past the
  // soft cap we drop full schemas and ship names-only — the model still
  // knows what tools exist and how to invoke them, just not parameter
  // shapes. Only the actual payload after fallback is compared with the
  // hard cap; v2.0.9 rejected on the full-schema size before compacting,
  // which broke real opencode / Claude Code setups with 30-50 MCP tools.
  if (emulateTools && toolRouting.shouldBuildToolPreamble) {
    // v2.0.66: when partition-mode native bridge is on, emulation only
    // describes the *unmapped* tools. Mapped tools are delivered via
    // cascade native trajectory steps and would only confuse the planner
    // if they also appeared in the toolPreamble emulation block.
    //
    // v2.0.69 (#115 follow-up): operator can opt to suppress emulation
    // toolPreamble entirely when partition mode is on
    // (WINDSURFAPI_NATIVE_BRIDGE_NO_EMUL=1) — useful for diagnosing
    // whether the long emulation block (200+ lines describing 10
    // unmapped tools) is what's pushing GPT into refuse mode. With the
    // flag on, the planner only sees its own native tool inventory and
    // unmapped tools become silently invisible to the model. Trade-off:
    // model can't call unmapped tools at all, but neither can it get
    // confused about whether it should be using the cascade-native path
    // or the emulation path.
    const suppressEmul = nativeBridgeOn && process.env.WINDSURFAPI_NATIVE_BRIDGE_NO_EMUL === '1';
    const budgetTools = suppressEmul ? [] : emulationTools;
    const budget = applyToolPreambleBudget(budgetTools, tool_choice, callerEnv, {
      modelKey: routingModelKey,
      provider: modelInfo?.provider || null,
      // v2.0.62 (#115) — pass route so GPT-family + Codex/Responses
      // route picks the gpt_native dialect (bare-JSON anti-refusal).
      route: body.__route || 'chat',
    });
    toolPreambleBudget = budget;
    preambleTier = budget.tier;
    if (budget.compacted) {
      log.warn(`Probe[${reqId}]: toolPreamble ${Math.round(budget.fullBytes / 1024)}KB exceeds soft cap ${Math.round(budget.softBytes / 1024)}KB; using ${budget.tier} tier (${Math.round(budget.finalBytes / 1024)}KB, ${budgetTools.length} tools)`);
    }
    if (!budget.ok) {
      log.warn(`Probe[${reqId}]: toolPreamble ${Math.round(budget.finalBytes / 1024)}KB exceeds hard cap ${Math.round(budget.hardBytes / 1024)}KB after ${budget.tier} tier; rejecting (${budgetTools.length} tools)`);
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
  logToolRoutingDiagnostics(reqId, summarizeToolRoutingDiagnostics({
    tools,
    effectiveTools,
    toolChoice: tool_choice,
    toolRouting,
    preambleBudget: toolPreambleBudget,
  }));
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
    cascadeMessages = normalizeMessagesForCascade(messages, effectiveTools, {
      injectUserPreamble: !disableUserToolFallback,
      modelKey: routingModelKey,
      provider: modelInfo?.provider || null,
      route: body.__route || 'chat',
      // O5: thread tool_choice so required/forced/none reach the user-message
      // fallback preamble too — the proto tool_calling_section already carries
      // it via applyToolPreambleBudget, but the fallback (for models that ignore
      // the proto override) previously hard-coded 'auto'. Mirrors the
      // DEVIN_CONNECT path above.
      toolChoice: tool_choice,
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
    environment: callerEnv || '',
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
    // #117 follow-up: "probe pending" should only describe a genuinely fresh
    // account — never one that's already been probed. An account can have a
    // resolved tier (e.g. 'expired') from the canary sweep while GetUserStatus
    // still returned empty (userStatusLastFetched=0); keying solely off
    // userStatusLastFetched mislabeled those as "账号刚添加还未完成 tier 检测",
    // sending users to re-probe when the real cause is plan/tier. Treat an
    // account as probed once lastProbed>0, GetUserStatus landed, or tier resolved.
    const hasUnprobedActive = accounts.some(a => a.status === 'active' && !accountIsProbed(a));
    // v2.0.71 (#117 follow-up): list models the pool actually CAN serve so
    // the caller's dashboard / test harness can fall back instead of just
    // showing "model_not_entitled" with no hint. Build the union of
    // availableModels across active accounts (top 8 by frequency).
    const counter = new Map();
    for (const a of accounts) {
      if (a.status !== 'active') continue;
      for (const m of (a.availableModels || [])) {
        counter.set(m, (counter.get(m) || 0) + 1);
      }
    }
    const availableInPool = [...counter.entries()].sort(([, a], [, b]) => b - a).slice(0, 8).map(([m]) => m);
    const remediation = hasUnprobedActive
      ? '账号刚添加，等 10-30 秒 tier 检测完成后重试，或 dashboard 手动 Probe。'
      : availableInPool.length
        ? `账号池里能用的模型：${availableInPool.join(', ')}。换其中一个，或加一个有 ${displayModel} 订阅权限的账号。`
        : '账号池里没有任何可用模型 — 检查账号是否被封禁或全部限流。';
    return {
      status: 403,
      body: {
        error: {
          message: hasUnprobedActive
            ? `模型 ${displayModel} 暂不可用：账号刚添加还未完成 tier 检测，请稍候 10-30 秒后重试，或在 dashboard 手动点 Probe`
            : `模型 ${displayModel} 在当前账号池中不可用（未订阅或已被封禁）`,
          type: hasUnprobedActive ? 'probe_pending' : 'model_not_entitled',
          remediation,
          available_in_pool: availableInPool,
        },
      },
    };
  }

  const chatId = genId();
  const created = Math.floor(Date.now() / 1000);
  const ckey = cacheKey(body, callerKey);
  // SEC-W2: only share the response cache ACROSS requests when the caller has a
  // trustworthy per-user scope. A guessed `:client:` bucket (shared key behind a
  // proxy) must never serve one user's cached answer to another — treat it as
  // cache-private (skip get+set) so there is zero cross-tenant leak by default.
  const cacheShareable = hasPerUserScope(callerKey);

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
      // O1: OpenAI only emits the trailing usage-only chunk when the caller opts
      // in via stream_options.include_usage:true; otherwise a streamed response
      // carries no usage frame. Passing this through lets streamResponse honor it
      // instead of unconditionally sending usage (which made some clients
      // double-count billing). Internal accounting (recordTokenUsage) still runs
      // regardless — only the client-facing frame is gated.
      includeUsage: body.stream_options?.include_usage === true,
      fpOpts: buildReuseOpts({ tools: effectiveTools, toolChoice: tool_choice, toolPreamble, preambleTier, emulateTools, route: body.__route || 'chat' }),
      tools: effectiveTools,
      route: body.__route || 'chat',
      nativeOpts,
      context,
      ensureLs: context.ensureLs,
      getLsFor: context.getLsFor,
      WindsurfClient: context.WindsurfClient,
    });
  }

  // ── Local response cache (exact body match) ─────────────
  // SEC-W2: skip cross-request cache reads for an untrusted (guessed) scope.
  const cached = cacheShareable ? cacheGet(ckey) : null;
  if (cached) {
    log.info(`Chat: cache HIT model=${displayModel} flow=non-stream`);
    recordRequest(displayModel, true, 0, null);
    const message = { role: 'assistant', content: cached.text || null };
    if (cached.thinking) message.reasoning_content = cached.thinking;
    return {
      status: 200,
      body: {
        id: chatId, object: 'chat.completion', created, model: displayModel,
        system_fingerprint: systemFingerprint(displayModel),
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
  const fpOpts = buildReuseOpts({ tools: effectiveTools, toolChoice: tool_choice, toolPreamble, preambleTier: preambleTier || null, emulateTools, route: body.__route || 'chat' });
  const fpBefore = reuseEnabled ? fingerprintBefore(messages, routingModelKey, callerKey, fpOpts) : null;
  let reuseEntry = reuseEnabled ? poolCheckout(fpBefore, callerKey, null, routingModelKey) : null;
  let checkedOutReuseEntry = reuseEntry;
  // v2.0.71 (#116 zhangzhang-bit follow-up): structured reuse log so
  // operators can see whether multi-turn cascades are actually reusing
  // server-side context, vs. hitting a fingerprint miss every turn
  // and replaying the entire history. Critical for diagnosing
  // "model keeps re-analysing the same data" loops.
  if (reuseEnabled) {
    log.info(`Chat[${reqId}]: reuse fp=${fpBefore?.slice(0, 12) || 'none'} ${reuseEntry ? `HIT cascade=${reuseEntry.cascadeId.slice(0, 8)}` : 'MISS'} turns=${(messages || []).length} model=${routingModelKey}`);
  } else if (sharedApiKeyNoScope) {
    log.info(`Chat[${reqId}]: reuse DISABLED (shared API key, no per-user scope)`);
  } else if (!shouldUseCascadeReuse({ useCascade, emulateTools, modelKey: routingModelKey })) {
    log.info(`Chat[${reqId}]: reuse DISABLED (model ineligible)`);
  } else {
    log.info(`Chat[${reqId}]: reuse DISABLED (experimental.cascadeConversationReuse=off)`);
  }
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
      acct = await waitForAccountFn(tried, null, QUEUE_MAX_WAIT_MS, routingModelKey, callerKey);
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
          // v2.0.84 (#118 0a00) — pool-wide rate limit on a high-effort
          // variant (`-max` / `-xhigh`)? Suggest the same-base lower-
          // effort sibling so the caller can switch off the weekly-
          // quota-tight tier.
          if (rateLimited.allLimited || tempUnavail.allUnavailable) {
            const fb = pickRateLimitFallback(routingModelKey || displayModel);
            if (fb) {
              lastErr.body.error.fallback_model = fb;
              lastErr.body.error.remediation = `池里所有账号在 ${displayModel} 上都已限流。这个 effort 变体上游限频严（每账号几十分钟滑窗），建议改用 ${fb}（同基础模型，effort 等级更低，daily quota 更宽松）。`;
            }
          }
        }
        break;
      }
    }
    tried.push(acct.apiKey);

    try {
      if (nativeBridgeOn && !isNativeBridgeAccountAllowed(acct)) {
        log.info(`Chat[${reqId}]: native bridge account gate skipped ${safeAccountRef(acct)}`);
        continue;
      }
    // Pre-flight rate limit check (experimental): ask server.codeium.com if
    // this account still has message capacity before burning an LS round trip.
    if (isExperimentalEnabled('preflightRateLimit')) {
      try {
        const px = getEffectiveProxy(acct.id) || null;
        const rl = await checkMessageRateLimitFn(acct.apiKey, px);
        if (!rl.hasCapacity) {
          log.warn(`Preflight: ${safeAccountRef(acct)} has no capacity (remaining=${rl.messagesRemaining}), skipping`);
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
        log.debug(`Preflight check failed for ${safeAccountRef(acct)}: ${e.message}`);
        // Fail open — proceed with the request
      }
    }

    try { await ensureLsFn(acct.proxy); } catch (e) {
      lastErr = isLsPoolExhausted(e) ? lsPoolExhaustedResponse(e) : { status: e.status || 503, body: { error: { message: e.message || String(e), type: e.type || 'ls_unavailable' } } };
      break;
    }
    const ls = getLsForFn(acct.proxy);
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
    log.info(`Chat[${reqId}]: model=${displayModel} flow=${useCascade ? 'cascade' : 'legacy'} attempt=${attempt + 1} ${safeAccountRef(acct)} ls=${ls.port} turns=${(messages||[]).length} chars=${_msgChars}${reuseEntry ? ' reuse=1' : ''}${emulateTools ? ' tools=emu' : ''}`);
    const client = new WindsurfClientClass(acct.apiKey, ls.port, ls.csrfToken);
    const result = await nonStreamResponse(
      client, chatId, created, displayModel, routingModelKey, messages, cascadeMessages, modelEnum, modelUid,
      // SEC-W2: pass a null cache key when the scope isn't trustworthy so
      // nonStreamResponse neither reads nor writes the shared response cache
      // (its cacheSet is gated on ckey truthiness). Guessed `:client:` buckets
      // stay cache-private → no cross-tenant answer leak behind a shared proxy.
      useCascade, acct.apiKey, cacheShareable ? ckey : null,
      // v2.0.87 (#129) — aliasModelKey is set by the outer wrapper
      // when this handler is the second pass of an auto-fallback
      // retry; it carries the ORIGINAL model name the client asked
      // for so the cascade pool entry gets indexed under both keys.
      reuseEnabled ? { reuseEntry, lsPort: ls.port, apiKey: acct.apiKey, accountId: acct.id, callerKey, cachePolicy, fpOpts, aliasModelKey: context.__aliasModelKey || null } : null,
      modelInfo?.provider || null,
      emulateTools, toolPreamble, wantJson, cachePolicy, wantThinking, tools, body.__route || 'chat',
      nativeOpts,
      // v2.0.88 (audit H-3) — when this is the inner-pass of an auto-
      // fallback retry, the outer wrapper threads the ORIGINAL request's
      // ckey through context.__originalCkey. We pass it down so the
      // success-path cacheSet writes under the original key as well —
      // next identical original-model request hits cache instead of
      // re-burning the rate-limit + fallback cycle.
      reqId,
      cacheShareable ? (context.__originalCkey || null) : null,
    );
    if (result.status === 200) return result;
    reuseEntry = null; // don't try to reuse on the retry
    if (result.reuseEntryInvalid) reuseEntryDead = true;
    // #101: same upstream-timeout invalidation as the stream path —
    // see the matching catch block in streamResponse for the full
    // rationale (cascade trajectory left half-broken, next reuse hits
    // it and the model "loses" the prior conversation).
    const _resultError = result.body?.error || {};
    const _resultMsg = String(_resultError.upstream_message || _resultError.message || '');
    if (
      result.status === 504
      || _resultError.type === 'upstream_deadline_exceeded'
      || _resultError.code === 'windsurf_provider_deadline'
      || isUpstreamDeadlineExceeded(_resultMsg)
    ) {
      reuseEntryDead = true;
    }
    lastErr = result;
    const errType = result.body?.error?.type;
    // v2.0.61 (#113): policy_blocked → don't rotate accounts, return
    // immediately. The model refused the request, swapping accounts
    // gives the same refusal but burns more quota.
    if (errType === 'policy_blocked') { recordPolicyBlocked(); return result; }
    // Rate limit: this account is done for this model, try the next one
    if (errType === 'rate_limit_exceeded') {
      recordRateLimited();
      // v2.0.91 — IP-level circuit breaker: when Windsurf upstream
      // rate-limits several accounts for the same model in a tight
      // window, it's usually IP-wide cooldown, not per-account.
      // Burning through all 40+ accounts just marks them all dead
      // for 30 min. Detect and short-circuit.
      if (!context.__rateLimitEvents) context.__rateLimitEvents = [];
      const RL_WINDOW_MS = 8_000;
      const RL_BURST_THRESHOLD = 3;
      context.__rateLimitEvents.push({
        time: Date.now(),
        model: routingModelKey,
        account: acct.id,
        cooldownMs: rateLimitBurstCooldownMs({
          message: result.body?.error?.message || '',
          retryAfterMs: result.body?.error?.retry_after_ms,
          apiKey: acct.apiKey,
          modelKey: routingModelKey,
        }),
      });
      // Prune old events
      const cutoff = Date.now() - RL_WINDOW_MS;
      while (context.__rateLimitEvents.length && context.__rateLimitEvents[0].time < cutoff) {
        context.__rateLimitEvents.shift();
      }
      const sameModelBurst = context.__rateLimitEvents.filter(e => e.model === routingModelKey);
      if (sameModelBurst.length >= RL_BURST_THRESHOLD) {
        const maxCooldown = Math.max(...sameModelBurst.map(e => e.cooldownMs || IP_RATE_LIMIT_BURST_FLOOR_MS));
        log.warn(`Chat[${reqId}]: IP-rate-limit burst detected — ${sameModelBurst.length} accounts rate-limited on ${displayModel} within ${RL_WINDOW_MS}ms. Short-circuiting.`);
        return {
          status: 429,
          headers: { 'Retry-After': String(Math.ceil(maxCooldown / 1000)) },
          body: {
            error: {
              message: `All accounts temporarily rate-limited on ${displayModel}. Windsurf upstream is applying IP-level cooldown. Wait ${formatRetryAfter(maxCooldown)} before retrying, or switch to a different model.`,
              type: 'rate_limit_exceeded',
              retry_after_ms: maxCooldown,
            },
          },
        };
      }
      if (acct?._sticky && isExperimentalEnabled('stickyNoFallback')) {
        log.warn(`Account ${safeAccountRef(acct)} (sticky-bound) rate-limited on ${displayModel}, stickyNoFallback enabled — not trying other accounts`);
        break;
      }
      log.warn(`Account ${safeAccountRef(acct)} rate-limited on ${displayModel}, trying next account`);
      continue;
    }
    // Cascade transient 错误通常是上游或本地 LS 短暂抖动，先退避再切账号，避免连续打爆同一热窗口。
    if (errType === 'upstream_deadline_exceeded') {
      break;
    }
    if (errType === 'upstream_internal_error' || errType === 'upstream_transient_error') {
      if (acct?._sticky && isExperimentalEnabled('stickyNoFallback')) {
        log.warn(`Chat[${reqId}]: ${safeAccountRef(acct)} (sticky-bound) upstream transient error, stickyNoFallback enabled — not trying other accounts`);
        break;
      }
      internalCount++;
      const backoffMs = await internalErrorBackoff(internalCount - 1);
      log.warn(`Chat[${reqId}]: ${safeAccountRef(acct)} upstream transient error, waited ${backoffMs}ms before next account`);
      continue;
    }
    // Model not available on this account (permission_denied, etc.)
    if (errType === 'model_not_available') {
      if (acct?._sticky && isExperimentalEnabled('stickyNoFallback')) {
        log.warn(`Account ${safeAccountRef(acct)} (sticky-bound) cannot serve ${displayModel}, stickyNoFallback enabled — not trying other accounts`);
        break;
      }
      log.warn(`Account ${safeAccountRef(acct)} cannot serve ${displayModel}, trying next account`);
      continue;
    }
    break; // other errors (502, transport) — don't retry
    } finally {
      // Pair every successful getApiKey/acquireAccountByKey with a release
      // so the in-flight-count based balancer in auth.js (issue #37) stays
      // accurate across success, retry, and abort paths.
      if (acct) releaseAccountById(acct.id);
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

async function nonStreamResponse(client, id, created, model, modelKey, messages, cascadeMessages, modelEnum, modelUid, useCascade, apiKey, ckey, poolCtx, provider, emulateTools, toolPreamble, wantJson = false, cachePolicy = null, wantThinking = false, tools = [], route = 'chat', nativeOpts = null, reqId = 'non-stream', aliasCkey = null) {
  const startTime = Date.now();
  const nativeBridgeOn = !!nativeOpts?.enabled;
  try {
    let allText = '';
    let allThinking = '';
    let cascadeMeta = null;
    let toolCalls = [];
    let hasCompletedNativeReadUrlResult = false;
    const bridgeDiag = {
      bridgeEnabled: nativeBridgeOn,
      requestedTools: Array.isArray(tools) && tools.length > 0,
      cascadeToolCalls: 0,
      mappedToolCalls: 0,
      unmappedToolCalls: 0,
      emulatedToolCalls: 0,
      totalToolCalls: 0,
      noToolCalls: false,
      argParseFailures: 0,
      reverseFailures: 0,
      cascadeKinds: [],
      mappedNames: [],
      unmappedKinds: [],
      emulatedNames: [],
    };
    // Server-reported token usage from CortexStepMetadata.model_usage, summed
    // across all trajectory steps. Preferred over the chars/4 estimate when
    // present so downstream billing (new-api, etc.) sees real Cascade numbers.
    let serverUsage = null;

    if (useCascade) {
      const chunks = await client.cascadeChat(cascadeMessages, modelEnum, modelUid, {
        reuseEntry: poolCtx?.reuseEntry || null,
        toolPreamble: nativeBridgeOn ? '' : toolPreamble,
        nativeEnvironment: nativeBridgeOn ? (nativeOpts?.environment || '') : '',
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
        const nativeResults = [];
        let usedNativeReadUrlFallback = false;
        for (const raw of (chunks.toolCalls || [])) {
          if (!raw?.cascade_native) continue;
          bridgeDiag.cascadeToolCalls++;
          bridgeDiag.cascadeKinds.push(raw.name);
          recordNativeBridgeCascadeToolCall(raw.name);
          if (isCompletedReadUrlNativeResult(raw)) {
            nativeResults.push(raw);
            hasCompletedNativeReadUrlResult = true;
            continue;
          }
          const candidates = lookup.get(raw.name) || [];
          const callerName = candidates[0];
          if (!callerName) {
            bridgeDiag.unmappedToolCalls++;
            bridgeDiag.unmappedKinds.push(raw.name);
            recordNativeBridgeUnmappedCascadeToolCall(raw.name);
            continue;
          }
          const reverseFn = TOOL_MAP[callerName]?.reverse;
          let cascadeArgs;
          try { cascadeArgs = JSON.parse(raw.argumentsJson || '{}'); } catch { bridgeDiag.argParseFailures++; cascadeArgs = {}; }
          let openaiArgs;
          try { openaiArgs = reverseFn ? reverseFn(cascadeArgs) : cascadeArgs; }
          catch { bridgeDiag.reverseFailures++; openaiArgs = cascadeArgs; }
          bridgeDiag.mappedToolCalls++;
          bridgeDiag.mappedNames.push(callerName);
          nativeCalls.push({
            id: raw.id || `call_${nativeCalls.length}_${Date.now().toString(36)}`,
            name: callerName,
            argumentsJson: JSON.stringify(openaiArgs ?? {}),
          });
        }
        toolCalls = filterToolCallsByAllowlist(nativeCalls, tools);
        for (const tc of toolCalls) recordNativeBridgeEmittedToolCall(tc.name, { source: 'cascade' });
        if (!allText && toolCalls.length === 0 && nativeResults.length) {
          allText = nativeResults.map(raw => raw.result).filter(Boolean).join('\n');
          usedNativeReadUrlFallback = !!allText;
        }
        if (toolCalls.length === 0 && allText && !usedNativeReadUrlFallback) {
          const fallback = parseNativeFunctionCallsFromText(allText, lookup);
          const filteredFallback = filterToolCallsByAllowlist(fallback.toolCalls, tools);
          allText = fallback.text || '';
          if (filteredFallback.length) {
            toolCalls = filteredFallback;
            bridgeDiag.emulatedToolCalls += filteredFallback.length;
            bridgeDiag.emulatedNames.push(...filteredFallback.map(tc => tc.name));
            for (const tc of toolCalls) recordNativeBridgeEmittedToolCall(tc.name, { source: 'provider_xml' });
            log.info(`Chat[non-stream]: native bridge parsed ${toolCalls.length} provider-native function_call(s) from text`);
          }
        }
        // Strip any tool-call markup that may have leaked into text — the
        // planner sometimes narrates "I'm going to look at X" alongside
        // emitting the cascade step, and the caller doesn't want that
        // noise.
        allText = stripToolMarkupFromText(allText);
        if (toolCalls.length === 0 && nativeResults.length === 0 && (chunks.toolCalls || []).length > 0) {
          log.info(`Chat[non-stream]: nativeBridge=true received ${chunks.toolCalls.length} cascade tool calls but none mapped to caller tools (kinds=${chunks.toolCalls.map(tc => tc.name).join(',')})`);
        }
        if (toolCalls.length === 0 && nativeResults.length === 0) recordNativeBridgeNoToolCallResponse();
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
        // v2.0.146 fix: Opus 4.8 xhigh and other high-reasoning models
        // sometimes emit <tool_call> blocks inside thinking (reasoning_content)
        // rather than in the main text response. parseToolCallsFromText only
        // ran against allText above — scan allThinking as a fallback when
        // no tool_calls came out of the text pass. Thinking-sourced calls are
        // always treated as emulation (never native); clear allThinking on
        // success so the client doesn't see a response that looks like both
        // a tool_call and a reasoning block at the same time.
        if (toolCalls.length === 0 && allThinking && allThinking.trim()) {
          const parsedFromThinking = parseToolCallsFromText(allThinking, { modelKey, provider, route });
          const fromThinking = filterToolCallsByAllowlist(parsedFromThinking.toolCalls, tools);
          if (fromThinking.length) {
            log.info(`Chat[non-stream]: lifted ${fromThinking.length} tool_call(s) from thinking content (model=${modelKey})`);
            toolCalls = fromThinking;
            allThinking = '';
          }
        }
        bridgeDiag.emulatedToolCalls += toolCalls.length;
        bridgeDiag.emulatedNames.push(...toolCalls.map(tc => tc.name));
        // Diagnostic: emulation was active and the model returned text but no
        // recognized tool call. Surface tool-shaped substrings so we can see
        // whether the model emitted an unsupported format (markdown-fenced
        // JSON, OpenAI native function_call, natural-language "I'll call X")
        // vs simply ignored the prompt and answered conversationally. Used to
        // diagnose "tool_use never appears" reports — issue #109 sub2api E2E.
        // v2.0.72 fix: GLM-4.7 / GLM-5.1 sometimes emit narration in
        // CortexStepPlannerResponse.thinking instead of .response, so
        // allText is empty while allThinking carries the actual model
        // output. Combine both for marker detection / NLU recovery so
        // we see narrate-style tool intents either way. Promotion to
        // allText (line ~2155 below) happens after this; we use the
        // combined source proactively.
        // v2.0.146 fix: always merge both so Opus 4.8 xhigh (and future
        // high-reasoning models) that place <tool_call> inside thinking
        // while producing non-empty text don't lose the markup. The old
        // text-first guard caused markers=xml_tag to be detected (marker
        // scan already saw combined strings) but NLU recovery ran on
        // text-only, missing the actual <tool_call> block.
        const narrativeSource = [allText, allThinking].filter(s => s && s.trim()).join('\n');
        if (toolCalls.length === 0 && narrativeSource) {
          const markers = [];
          if (/<tool_call/i.test(narrativeSource)) markers.push('xml_tag');
          if (/```\s*(?:json|tool_call)/i.test(narrativeSource)) markers.push('fenced_json');
          if (/"function"\s*:|"tool_calls"\s*:|"function_call"\s*:/.test(narrativeSource)) markers.push('openai_native');
          if (/\{\s*"name"\s*:\s*"[a-zA-Z0-9_-]+"\s*,\s*"arguments"/.test(narrativeSource)) markers.push('bare_json');
          if (/^\s*(?:I'?ll|I will|Let me|I'?m going to)\s+(?:call|use|invoke|run)/im.test(narrativeSource)) markers.push('natural_lang');
          log.info(`Chat[non-stream]: emulateTools=true but parser found 0 tool_calls (model=${modelKey} provider=${provider}); markers=${markers.join(',') || 'none'}; head="${rawTextHead}"`);
          // v2.0.72 (#115 #120) — NLU intent recovery. GPT/GLM/Kimi
          // narrate "I'll call X with Y" instead of emitting the
          // <tool_call> markup. Try to extract tool_call(s) from
          // natural-language narrative before falling back to
          // fabricate detection.
          //
          // v2.0.76 (#120 follow-up): widened to also fire when markers
          // were DETECTED but parsing produced 0 tool_calls. v2.0.75
          // probe caught GLM-4.7 emitting `markers=bare_json` (a JSON
          // sigil in thinking text) where the parser couldn't lift a
          // call but the surrounding narrative held everything NLU
          // needs. Restricting NLU to markers=none meant those cases
          // got 0 tool_calls back.
          if (Array.isArray(tools) && tools.length > 0) {
            const lastUser = latestRealUserText(messages) || '';
            const recovered = extractIntentFromNarrative(narrativeSource, tools, { lastUserText: lastUser, markers });
            if (recovered.length) {
              const recoveredCalls = recovered.map((r, i) => ({
                id: `nlu_${i}_${Date.now().toString(36)}`,
                name: r.name,
                argumentsJson: r.argumentsJson,
              }));
              const filtered = filterToolCallsByAllowlist(recoveredCalls, tools);
              if (filtered.length) {
                log.info(`Chat[non-stream]: NLU recovery — promoted ${filtered.length} narrative tool_call(s) (markers=${markers.join(',') || 'none'} head="${rawTextHead}")`);
                toolCalls = filtered;
                bridgeDiag.emulatedToolCalls += filtered.length;
                bridgeDiag.emulatedNames.push(...filtered.map(tc => tc.name));
                allText = '';
                allThinking = '';
              }
            }
          }
          // v2.0.82 (#125) — translator-layer retry-with-correction.
          // When NLU recovery can't lift a tool_call AND the narrative
          // clearly intended one (mentions a declared tool name + an
          // action verb + user prompt is actionable), spend one extra
          // cascade round-trip with the model's prior narrate folded
          // into history + a correction prompt asking it to re-emit
          // using the protocol. GLM-5.1 / Kimi-K2 narrate-without-
          // args case (#125 DuZunTianXia) goes from 0 tool_calls to
          // a real protocol emit on the second pass.
          //
          // Default ON for GLM/Kimi (notoriously narrate instead of calling
          // tools on first pass). Claude/GPT have good first-pass compliance
          // so they only get retry when explicitly opted in. Set
          // WINDSURFAPI_NLU_RETRY=0 to disable globally.
          const nluRetryEnabled = process.env.WINDSURFAPI_NLU_RETRY !== '0'
            && (process.env.WINDSURFAPI_NLU_RETRY === '1'
                || /zhipu|glm|moonshot|kimi/i.test(String(provider || ''))
                || /^(?:glm|kimi)/i.test(String(modelKey || '')));
          if (toolCalls.length === 0
              && nluRetryEnabled
              && Array.isArray(tools) && tools.length > 0
              && narrativeSource) {
            const lastUser = latestRealUserText(messages) || '';
            const intendedTool = detectToolIntentInNarrative(narrativeSource, tools, { lastUserText: lastUser });
            if (intendedTool) {
              try {
                // Build correction history. The cascade backend treats
                // the assistant turn as a "previous response" the model
                // can read, then the user turn frames the correction.
                // Bilingual phrasing because GLM/Kimi often run on
                // Chinese system prompts.
                const correctionMessages = [
                  ...cascadeMessages,
                  { role: 'assistant', content: narrativeSource.slice(0, 4000) },
                  { role: 'user', content:
                    `Your previous response described intending to call \`${intendedTool}\` but didn't emit the tool-call protocol block. ` +
                    `Re-emit the call now using the EXACT protocol format defined at the top of this conversation. ` +
                    `Do NOT narrate. Do NOT describe. Just the protocol block. ` +
                    `Provide a concrete argument value (the literal command / file path / query) — never placeholders like "command" or "the file". ` +
                    `\n\n你刚才描述了想用 \`${intendedTool}\` 工具但没按协议格式 emit。请直接重新 emit 协议块，不要 narrate。给具体的 argument 字面值（如 ls / /etc/hostname / "echo hi"），不要写"命令" / "文件" 这种占位词。` },
                ];
                log.info(`Chat[non-stream]: NLU retry — first pass narrate-only, retrying with correction (tool=${intendedTool} markers=${markers.join(',') || 'none'})`);
                const retryChunks = await client.cascadeChat(correctionMessages, modelEnum, modelUid, {
                  reuseEntry: null,
                  toolPreamble: nativeBridgeOn ? '' : toolPreamble,
                  nativeEnvironment: nativeBridgeOn ? (nativeOpts?.environment || '') : '',
                  displayModel: model,
                  nativeMode: nativeBridgeOn,
                  nativeAllowlist: nativeOpts?.allowlist || null,
                  additionalSteps: nativeOpts?.additionalSteps || null,
                });
                let retryText = '';
                let retryThinking = '';
                for (const c of retryChunks) {
                  if (c.text) retryText += c.text;
                  if (c.thinking) retryThinking += c.thinking;
                }
                const retryParsed = parseToolCallsFromText(retryText, { modelKey, provider, route });
                let retryCalls = filterToolCallsByAllowlist(retryParsed.toolCalls || [], tools);
                if (!retryCalls.length) {
                  const retrySource = retryText.trim() ? retryText : retryThinking;
                  const recovered2 = extractIntentFromNarrative(retrySource, tools, { lastUserText: lastUser });
                  if (recovered2.length) {
                    retryCalls = filterToolCallsByAllowlist(
                      recovered2.map((r, i) => ({ id: `nlu_retry_${i}_${Date.now().toString(36)}`, name: r.name, argumentsJson: r.argumentsJson })),
                      tools,
                    );
                  }
                }
                if (retryCalls.length) {
                  log.info(`Chat[non-stream]: NLU retry — promoted ${retryCalls.length} tool_call(s) on second pass (tool=${intendedTool})`);
                  toolCalls = retryCalls;
                  bridgeDiag.emulatedToolCalls += retryCalls.length;
                  bridgeDiag.emulatedNames.push(...retryCalls.map(tc => tc.name));
                  allText = retryParsed.text || '';
                  allThinking = '';
                } else {
                  log.warn(`Chat[non-stream]: NLU retry — second pass also produced 0 tool_calls; giving up (model=${modelKey})`);
                }
              } catch (retryErr) {
                log.warn(`Chat[non-stream]: NLU retry failed: ${retryErr.message}`);
              }
            }
          }
          // v2.0.71 (#115) — fabricate detection. When markers=none,
          // NLU recovery didn't pick up anything, AND output pattern-
          // matches a hallucinated tool result, warn at log level and
          // (optionally) reject so the agent loop doesn't treat fake
          // output as a real tool result.
          if (markers.length === 0 && toolCalls.length === 0) {
            const lastUser = latestRealUserText(messages) || '';
            const fab = detectFabricatedToolResult(narrativeSource, { lastUserText: lastUser });
            if (fab) {
              log.warn(`Chat[non-stream]: fabricate detected — model=${modelKey} pattern=${fab.matchedPattern} sample="${fab.sample}"`);
              if (process.env.WINDSURFAPI_FABRICATE_REJECT === '1') {
                return {
                  status: 502,
                  body: {
                    error: {
                      message: `Tool-call fabrication detected: ${fab.hint}`,
                      type: 'fabricated_tool_result',
                      sample: fab.sample,
                    },
                  },
                };
              }
            }
          }
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
    bridgeDiag.totalToolCalls = toolCalls.length;
    bridgeDiag.noToolCalls = bridgeDiag.requestedTools && toolCalls.length === 0 && !hasCompletedNativeReadUrlResult;
    logBridgeResultDiagnostics(reqId, bridgeDiag);

    // Check the cascade back into the pool under the *post-turn* fingerprint
    // so the next request in the same conversation can resume it.
    //
    // v2.0.87 (#129 wnfilm): when this request is an auto-fallback retry
    // (outer wrapper rewrote body.model from the original max → xhigh),
    // ALSO write the entry under the original modelKey's fingerprint.
    // The next turn from the client will arrive with the original model
    // name and would otherwise miss the pool, dropping cascade reuse and
    // making the model "forget" prior turns for clients that don't
    // re-send full history each turn.
    if (poolCtx && cascadeMeta?.cascadeId && (allText || toolCalls.length)) {
      const turnComplete = appendAssistantTurn(messages, allText, toolCalls);
      const fpAfter = fingerprintAfter(turnComplete, modelKey, poolCtx.callerKey || '', poolCtx.fpOpts);
      const aliasModelKey = poolCtx.aliasModelKey;
      const fpAfterAlias = aliasModelKey && aliasModelKey !== modelKey
        ? fingerprintAfter(turnComplete, aliasModelKey, poolCtx.callerKey || '', poolCtx.fpOpts)
        : null;
      const fingerprints = fpAfterAlias ? [fpAfter, fpAfterAlias] : fpAfter;
      const ttlHint = ttlHintFromCachePolicy(poolCtx.cachePolicy);
      // Explicit 0 (not undefined) clears any inherited 1h hint when the
      // current request didn't ask for it (MED-2). ttlHintFromCachePolicy
      // returns undefined for "no opinion"; pass 0 when we know the user
      // wants the default TTL.
      poolCheckin(fingerprints, {
        cascadeId: cascadeMeta.cascadeId,
        sessionId: cascadeMeta.sessionId,
        lsPort: poolCtx.lsPort,
        lsGeneration: cascadeMeta.lsGeneration || poolCtx.lsGeneration,
        apiKey: poolCtx.apiKey,
        modelKey: modelKey || '',
        stepOffset: Number.isFinite(cascadeMeta.stepOffset) ? cascadeMeta.stepOffset : poolCtx.reuseEntry?.stepOffset,
        generatorOffset: Number.isFinite(cascadeMeta.generatorOffset) ? cascadeMeta.generatorOffset : poolCtx.reuseEntry?.generatorOffset,
        historyCoverage: cascadeMeta.historyCoverage || poolCtx.reuseEntry?.historyCoverage || null,
        createdAt: poolCtx.reuseEntry?.createdAt,
      }, poolCtx.callerKey || '', ttlHint === undefined ? 0 : ttlHint);

      // Bind caller to this account for the next turn in the
      // conversation. Without this, the next request picks a different
      // account from the pool and the cascade_id becomes invalid.
      if (poolCtx.callerKey && isStickyEnabled() && poolCtx.accountId) {
        setStickyBinding(poolCtx.callerKey, modelKey, poolCtx.accountId, poolCtx.apiKey);
      }
    }

    reportSuccess(apiKey);
    updateCapability(apiKey, modelKey, true, 'success');
    recordRequest(model, true, Date.now() - startTime, apiKey);

    // Store in cache for next identical request. Skip caching tool_call
    // responses — they're inherently contextual and the cache doesn't
    // preserve the tool_calls array, so a cache hit would return a
    // content-only response with finish_reason:stop, breaking tool flow.
    //
    // v2.0.88 (audit H-3) — when this is the inner-pass of an
    // auto-fallback retry, ALSO cacheSet under the original-model
    // ckey (passed as aliasCkey by the outer wrapper). Otherwise the
    // next identical original-model request misses cache and re-
    // triggers the rate_limit + fallback cycle, burning cascade
    // quota for the whole rate-limit window.
    // v2.0.91 — kimi-k2 upstream outage. Cascade returns idle_empty
    // (null content, ~1-6 tokens). Return clear error with alternatives.
    if (/^kimi/i.test(String(modelKey || ''))
        && !toolCalls.length
        && (!allText || allText.trim().length === 0)
        && (!allThinking || allThinking.trim().length === 0)) {
      return {
        status: 502,
        body: {
          error: {
            message: `${model} 在 Cascade 上游当前不可用（返回空响应）。请换用 claude-sonnet-4.6、gemini-2.5-flash 或 glm-4.7。`,
            type: 'upstream_model_unavailable',
          },
        },
      };
    }

    if (ckey && !toolCalls.length) {
      cacheSet(ckey, { text: allText, thinking: allThinking });
      if (aliasCkey && aliasCkey !== ckey) {
        cacheSet(aliasCkey, { text: allText, thinking: allThinking });
      }
    }

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
    // v2.0.69 (#118): feed bucket totals into stats so dashboard can show
    // fresh_input vs cache_read vs cache_write breakdown.
    try { recordTokenUsage(usage); } catch {}
    const finishReason = toolCalls.length ? 'tool_calls' : 'stop';
    return {
      status: 200,
      body: {
        id, object: 'chat.completion', created, model,
        system_fingerprint: systemFingerprint(model),
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage,
      },
    };
  } catch (err) {
    // Only count true auth failures against the account. Workspace/cascade/model
    // errors and transport issues shouldn't disable the key.
    const isAuthFail = /unauthenticated|invalid api key|invalid_grant|permission_denied.*account/i.test(err.message);
    const isRateLimit = /rate limit|rate_limit|too many requests|quota/i.test(err.message);
    const isInternal = /internal error occurred.*(error|trace)\s*id/i.test(err.message);
    const isDeadline = isUpstreamDeadlineExceeded(err);
    const isTransport = isCascadeTransportError(err);
    const isTransient = !isDeadline && isUpstreamTransientError(err, isInternal);
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
    // don't conflate "out of quota" with "account dead". Also skip when the
    // error is internal or otherwise transient: the upstream sometimes wraps a
    // transient stall in a 401/403 shell whose text matches BAN_PATTERNS
    // (e.g. "authentication ... failed"), and promoting that to a permanent
    // ban would burn a healthy account — transient-first must win here.
    if (!isRateLimit && !isInternal && !isTransient && looksLikeBanSignal(err.message)) {
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
    if (isDeadline) {
      return {
        status: 504,
        reuseEntryInvalid: !!err.reuseEntryInvalid,
        body: {
          error: {
            message: upstreamDeadlineExceededMessage(model),
            type: 'upstream_deadline_exceeded',
            code: 'windsurf_provider_deadline',
            upstream_message: sanitizeText(err.message).slice(0, 240),
          },
        },
      };
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
  const ensureLsFn = deps.ensureLs || ensureLs;
  const getLsForFn = deps.getLsFor || getLsFor;
  const ClientClass = deps.WindsurfClient || WindsurfClient;
  // Cache policy threads through deps because streamResponse is a top-level
  // helper, not a closure. Without this, lines that compute TTL hints or
  // attribute usage to ephemeral_5m_input_tokens / ephemeral_1h_input_tokens
  // throw a ReferenceError mid-stream — the exact failure surface reported
  // in issues #82 and #83.
  const cachePolicy = deps.cachePolicy || null;
  // SEC-W2: same rule as the non-stream path — only share the response cache
  // across requests for a trustworthy per-user scope; a guessed `:client:`
  // bucket is cache-private (no cross-tenant leak behind a shared-key proxy).
  const cacheShareable = hasPerUserScope(callerKey);
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
      const fp = systemFingerprint(model);
      // O10: 仅直连 OpenAI 客户端(route==='chat')归一化 error.type;
      // messages/gemini/responses 路由须保留内部词供下游 translator remap。
      const isOpenAIClient = (fpOpts?.route || 'chat') === 'chat';
      const send = (data) => {
        // O9: 给每个 chat.completion.chunk 注入合成 system_fingerprint;error /
        // usage-only 等其它帧不动。幂等 —— 已带值(如 connect 路径预置)则不覆盖。
        if (data && data.object === 'chat.completion.chunk' && data.system_fingerprint == null) {
          data.system_fingerprint = fp;
        }
        if (isOpenAIClient && data && data.error && typeof data.error.type === 'string') {
          data.error.type = normalizeOpenAIErrorType(data.error.type);
        }
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
      // SEC-W2: skip cross-request cache reads for an untrusted (guessed) scope.
      const cached = cacheShareable ? cacheGet(ckey) : null;
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
          // O1: only the include_usage opt-in gets the trailing usage frame.
          if (deps.includeUsage) {
            send({ id, object: 'chat.completion.chunk', created, model,
              choices: [], usage: cachedUsage(messages, cached.text) });
          }
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
      let emittedClientPayload = false;

      // Cascade conversation pool (stream path). Opus 4.7 tool-emulated
      // requests opt in even when the global experiment toggle is off, because
      // replaying full Claude Code history is what triggers context blowups.
      const sharedApiKeyNoScopeStream = !hasPerUserScope(callerKey) && !CASCADE_REUSE_ALLOW_SHARED_API_KEY;
      const reuseEnabled = !sharedApiKeyNoScopeStream
        && shouldUseCascadeReuse({ useCascade, emulateTools, modelKey })
        && (isExperimentalEnabled('cascadeConversationReuse') || shouldForceCascadeReuse({ emulateTools, modelKey }));
      const strictReuse = shouldUseStrictCascadeReuse({ emulateTools, modelKey });
      const fpBefore = reuseEnabled ? fingerprintBefore(messages, modelKey, callerKey, fpOpts) : null;
      let reuseEntry = reuseEnabled ? poolCheckout(fpBefore, callerKey, null, modelKey) : null;
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
      const completedNativeReadUrlResults = [];
      const bridgeDiagCascadeSeen = new Set();
      const bridgeDiag = {
        bridgeEnabled: nativeBridgeOn,
        requestedTools: declaredTools.length > 0,
        cascadeToolCalls: 0,
        mappedToolCalls: 0,
        unmappedToolCalls: 0,
        emulatedToolCalls: 0,
        totalToolCalls: 0,
        noToolCalls: false,
        argParseFailures: 0,
        reverseFailures: 0,
        cascadeKinds: [],
        mappedNames: [],
        unmappedKinds: [],
        emulatedNames: [],
      };
      const markBridgeDiagCascadeRaw = (raw) => {
        if (!raw?.cascade_native) return false;
        if (raw?.id) {
          const key = `id:${raw.id}`;
          if (bridgeDiagCascadeSeen.has(key)) return false;
          bridgeDiagCascadeSeen.add(key);
        }
        bridgeDiag.cascadeToolCalls++;
        bridgeDiag.cascadeKinds.push(raw.name);
        return true;
      };

      // Streaming path sanitizers. Every text/thinking delta flows through a
      // PathSanitizeStream before leaving the server so /tmp/windsurf-workspace,
      // /opt/windsurf and /root/WindsurfAPI literals can never slip out even
      // if a path straddles a chunk boundary. See src/sanitize.js.
      let pathStreamText = new PathSanitizeStream();
      let pathStreamThinking = new PathSanitizeStream();
      let nativeFunctionParser = nativeBridgeOn
        ? new NativeFunctionCallStreamParser(nativeOpts?.callerLookup || new Map())
        : null;

      const emitContent = (clean) => {
        if (!clean) return;
        accText += clean;
        // When response_format=json_object/json_schema is set, buffer text
        // instead of streaming it out. We can't safely fence-strip in the
        // middle of a stream (fence might straddle a chunk, and we'd need
        // lookahead). On finish we'll emit one clean JSON payload.
        if (wantJson) return;
        emittedClientPayload = true;
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { content: clean }, finish_reason: null }] });
      };
      const emitThinking = (clean, { accumulate = true } = {}) => {
        if (!clean) return;
        if (accumulate) accThinking += clean;
        emittedClientPayload = true;
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { reasoning_content: clean }, finish_reason: null }] });
      };

      const emitToolCallDelta = (tc, idx) => {
        emittedClientPayload = true;
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

      const emitNativeFallbackCalls = (rawCalls) => {
        const filtered = filterToolCallsByAllowlist(rawCalls || [], declaredTools);
        for (const rawTc of filtered) {
          const tc = sanitizeToolCall(repairToolCallArguments(rawTc, messages));
          const idx = collectedToolCalls.length;
          collectedToolCalls.push(tc);
          bridgeDiag.emulatedToolCalls++;
          bridgeDiag.emulatedNames.push(tc.name);
          recordNativeBridgeEmittedToolCall(tc.name, { source: 'provider_xml' });
          emitToolCallDelta(tc, idx);
        }
        return filtered.length;
      };

      const onChunk = (chunk) => {
        if (!rolePrinted) {
          rolePrinted = true;
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
        }
        hadSuccess = true;

        // v2.0.70 — cascade native trajectory tool_call streamed live.
        // Translate the raw cascade kind name (run_command / view_file)
        // back into the caller's OpenAI tool name via callerLookup, then
        // emit as a tool_call delta. Old behaviour batched these at
        // turn end (release notes for v2.0.65 documented the gap).
        if (nativeBridgeOn && chunk.nativeToolResult) {
          const raw = chunk.nativeToolResult;
          if (markBridgeDiagCascadeRaw({ ...raw, cascade_native: true })) {
            recordNativeBridgeCascadeToolCall(raw.name);
          }
          if (isCompletedReadUrlNativeResult(raw)
              && !completedNativeReadUrlResults.some(existing => (existing.id || '') === (raw.id || ''))) {
            completedNativeReadUrlResults.push(raw);
          }
          return;
        }

        if (nativeBridgeOn && chunk.nativeToolCall) {
          const raw = chunk.nativeToolCall;
          markBridgeDiagCascadeRaw({ ...raw, cascade_native: true });
          recordNativeBridgeCascadeToolCall(raw.name);
          const lookup = nativeOpts?.callerLookup || new Map();
          const candidates = lookup.get(raw.name) || [];
          const callerName = candidates[0];
          if (callerName) {
            const reverseFn = TOOL_MAP[callerName]?.reverse;
            let cascadeArgs;
            try { cascadeArgs = JSON.parse(raw.argumentsJson || '{}'); } catch { bridgeDiag.argParseFailures++; cascadeArgs = {}; }
            let openaiArgs;
            try { openaiArgs = reverseFn ? reverseFn(cascadeArgs) : cascadeArgs; }
            catch { bridgeDiag.reverseFailures++; openaiArgs = cascadeArgs; }
            bridgeDiag.mappedToolCalls++;
            bridgeDiag.mappedNames.push(callerName);
            const candidate = {
              id: raw.id || `call_${collectedToolCalls.length}_${Date.now().toString(36)}`,
              name: callerName,
              argumentsJson: JSON.stringify(openaiArgs ?? {}),
            };
            const filtered = filterToolCallsByAllowlist([candidate], declaredTools);
            if (filtered.length) {
              const tc = sanitizeToolCall(repairToolCallArguments(filtered[0], messages));
              const idx = collectedToolCalls.length;
              collectedToolCalls.push(tc);
              recordNativeBridgeEmittedToolCall(tc.name, { source: 'cascade' });
              emitToolCallDelta(tc, idx);
            }
          } else {
            bridgeDiag.unmappedToolCalls++;
            bridgeDiag.unmappedKinds.push(raw.name);
            recordNativeBridgeUnmappedCascadeToolCall(raw.name);
          }
          return;
        }

        if (chunk.text) {
          // Pipeline for text deltas:
          //   raw chunk  →  ToolCallStreamParser (strip <tool_call> blocks)
          //              →  PathSanitizeStream   (scrub server paths)
          //              →  client
          let safeText = chunk.text;
          if (nativeFunctionParser) {
            const nativeParsed = nativeFunctionParser.feed(safeText);
            safeText = nativeParsed.text;
            const emitted = emitNativeFallbackCalls(nativeParsed.toolCalls);
            if (emitted) {
              log.info(`Chat[stream]: native bridge parsed ${emitted} provider-native function_call(s) from stream`);
            }
          }
          if (toolParser) {
            const parsed = toolParser.feed(safeText);
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
                  bridgeDiag.emulatedToolCalls++;
                  bridgeDiag.emulatedNames.push(tc.name);
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
                bridgeDiag.emulatedToolCalls++;
                bridgeDiag.emulatedNames.push(tc.name);
                emitToolCallDelta(tc, idx);
              }
            }
          }
          if (safeText) emitContent(pathStreamText.feed(safeText));
        }
        if (chunk.thinking) {
          const cleanThinking = pathStreamThinking.feed(chunk.thinking);
          if (emulateTools) {
            // In tool-emulation mode, high-reasoning models may hide a
            // <tool_call> block in reasoning_content. Buffer thinking until
            // stream end so we can either emit a clean tool_use turn OR emit
            // reasoning, but never stream reasoning first and append tool_use
            // later in the same assistant turn (Claude Code reports
            // "Content block not found" on that block-order pattern).
            if (cleanThinking) accThinking += cleanThinking;
          } else {
            emitThinking(cleanThinking);
          }
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
            nativeFunctionParser = nativeBridgeOn
              ? new NativeFunctionCallStreamParser(nativeOpts?.callerLookup || new Map())
              : null;
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
            acct = await waitForAccountFn(tried, abortController.signal, QUEUE_MAX_WAIT_MS, modelKey, callerKey);
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
                // v2.0.84 (#118) — same fallback hint logic as the
                // non-stream path. Attach after lastErr is set so
                // the lastErr-presence regression test still passes.
                if (rateLimited.allLimited || tempUnavail.allUnavailable) {
                  const fb = pickRateLimitFallback(modelKey || model);
                  if (fb) {
                    lastErr.fallback_model = fb;
                    lastErr.remediation = `池里所有账号在 ${model} 上都已限流。这个 effort 变体上游限频严，建议改用 ${fb}（同基础模型，effort 等级更低）。`;
                  }
                }
              }
              break;
            }
          }
          tried.push(acct.apiKey);
          currentApiKey = acct.apiKey;

          try {
            if (nativeBridgeOn && !isNativeBridgeAccountAllowed(acct)) {
              recordNativeBridgeAccountGateSkip();
              log.info(`Chat[${reqId}]: native bridge account gate skipped ${safeAccountRef(acct)}`);
              continue;
            }
          // Pre-flight rate limit check (experimental)
          if (isExperimentalEnabled('preflightRateLimit')) {
            try {
              const px = getEffectiveProxy(acct.id) || null;
              const rl = await checkMessageRateLimitFn(acct.apiKey, px);
              if (!rl.hasCapacity) {
                log.warn(`Preflight: ${safeAccountRef(acct)} has no capacity (remaining=${rl.messagesRemaining}), skipping`);
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
              log.debug(`Preflight check failed for ${safeAccountRef(acct)}: ${e.message}`);
            }
          }

          try { await ensureLsFn(acct.proxy); } catch (e) {
            lastErr = isLsPoolExhausted(e)
              ? Object.assign(new Error(e.message), { type: 'ls_pool_exhausted', status: e.status || 503 })
              : e;
            break;
          }
          const ls = getLsForFn(acct.proxy);
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
          log.info(`Chat: model=${model} flow=${useCascade ? 'cascade' : 'legacy'} stream=true attempt=${attempt + 1} ${safeAccountRef(acct)} ls=${ls.port} turns=${(messages||[]).length} chars=${_msgCharsStream}${reuseEntry ? ' reuse=1' : ''}`);
          const client = new ClientClass(acct.apiKey, ls.port, ls.csrfToken);
          let cascadeResult = null;
          try {
            if (useCascade) {
              cascadeResult = await client.cascadeChat(cascadeMessages, modelEnum, modelUid, {
                onChunk, signal: abortController.signal, reuseEntry,
                toolPreamble: nativeBridgeOn ? '' : toolPreamble,
                nativeEnvironment: nativeBridgeOn ? (nativeOpts?.environment || '') : '',
                displayModel: model,
                nativeMode: nativeBridgeOn,
                nativeAllowlist: nativeOpts?.allowlist || null,
                additionalSteps: nativeOpts?.additionalSteps || null,
              });
            } else {
              await client.rawGetChatMessage(messages, modelEnum, modelUid, { onChunk });
            }
            // Flush order matters:
            //   1. NativeFunctionCallStreamParser tail → may produce provider
            //      native tool_calls withheld from content deltas
            //   2. ToolCallStreamParser tail → may produce more text deltas
            //      (e.g., a dangling <tool_call> that never closed falls
            //      through as literal text)
            //   3. PathSanitizeStream tail (text) → scrubs anything the tool
            //      parser held back AND anything we were holding ourselves
            //   4. PathSanitizeStream tail (thinking)
            if (nativeFunctionParser) {
              const nativeTail = nativeFunctionParser.flush();
              const emitted = emitNativeFallbackCalls(nativeTail.toolCalls);
              if (emitted) {
                log.info(`Chat[stream]: native bridge parsed ${emitted} provider-native function_call(s) from stream tail`);
              }
              if (nativeTail.text) emitContent(pathStreamText.feed(nativeTail.text));
            }
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
                bridgeDiag.emulatedToolCalls++;
                bridgeDiag.emulatedNames.push(tc.name);
                emitToolCallDelta(tc, idx);
              }
              // Diagnostic: same as nonStreamResponse but for the SSE path —
              // surface why no tool_calls came out when emulation was active.
              // See nonStreamResponse for marker rationale (#109 sub2api E2E).
              // v2.0.72 fix: see non-stream comment — combine accText +
              // accThinking for marker / NLU detection so models that
              // route narrate output through reasoning_content (GLM-4.7,
              // some Claude models in thinking mode) don't slip past.
              // v2.0.146 fix: always merge both so Opus 4.8 xhigh that
              // emits <tool_call> inside thinking while producing non-empty
              // text doesn't lose the markup. The old text-only guard meant
              // markers=xml_tag was detected from thinking (the marker scan
              // ran on the combined string) but NLU/parse ran against text
              // only — missing the actual <tool_call> block entirely.
              const accNarrative = [accText, accThinking].filter(s => s && s.trim()).join('\n');
              if (emulateTools && collectedToolCalls.length === 0 && accNarrative) {
                const head = accNarrative.slice(0, 240).replace(/\s+/g, ' ');
                const markers = [];
                if (/<tool_call/i.test(accNarrative)) markers.push('xml_tag');
                if (/```\s*(?:json|tool_call)/i.test(accNarrative)) markers.push('fenced_json');
                if (/"function"\s*:|"tool_calls"\s*:|"function_call"\s*:/.test(accNarrative)) markers.push('openai_native');
                if (/\{\s*"name"\s*:\s*"[a-zA-Z0-9_-]+"\s*,\s*"arguments"/.test(accNarrative)) markers.push('bare_json');
                if (/^\s*(?:I'?ll|I will|Let me|I'?m going to)\s+(?:call|use|invoke|run)/im.test(accNarrative)) markers.push('natural_lang');
                log.info(`Chat[stream]: emulateTools=true but parser found 0 tool_calls (model=${modelKey} provider=${provider}); markers=${markers.join(',') || 'none'}; head="${head}"`);
                // v2.0.72 (#115 #120) — NLU intent recovery on stream
                // tail. If model narrate-d a tool intent without
                // emitting <tool_call> markup, extract + emit as
                // tool_call delta so client agent loop doesn't break.
                //
                // v2.0.76 (#120 follow-up): widened to fire even when
                // markers were detected but parser produced 0 calls
                // (mirrors the non-stream path).
                if (declaredTools.length > 0) {
                  const lastUser = latestRealUserText(messages) || '';
                  const recovered = extractIntentFromNarrative(accNarrative, declaredTools, { lastUserText: lastUser, markers });
                  if (recovered.length) {
                    const recoveredCalls = recovered.map((r, i) => ({
                      id: `nlu_${i}_${Date.now().toString(36)}`,
                      name: r.name,
                      argumentsJson: r.argumentsJson,
                    }));
                    const filtered = filterToolCallsByAllowlist(recoveredCalls, declaredTools);
                    for (const rawTc of filtered) {
                      const tc = sanitizeToolCall(repairToolCallArguments(rawTc, messages));
                      const idx = collectedToolCalls.length;
                      collectedToolCalls.push(tc);
                      bridgeDiag.emulatedToolCalls++;
                      bridgeDiag.emulatedNames.push(tc.name);
                      emitToolCallDelta(tc, idx);
                    }
                    if (filtered.length) {
                      log.info(`Chat[stream]: NLU recovery — promoted ${filtered.length} narrative tool_call(s) mid-stream (markers=${markers.join(',') || 'none'})`);
                    }
                  }
                }
                // v2.0.71 (#115) — fabricate detection on stream tail
                // (only if NLU didn't recover anything).
                if (markers.length === 0 && collectedToolCalls.length === 0) {
                  const lastUser = latestRealUserText(messages) || '';
                  const fab = detectFabricatedToolResult(accNarrative, { lastUserText: lastUser });
                  if (fab) {
                    log.warn(`Chat[stream]: fabricate detected — model=${modelKey} pattern=${fab.matchedPattern} sample="${fab.sample}"`);
                  }
                }
              }
            }
            emitContent(pathStreamText.flush());
            // v2.0.146 fix: scan accThinking for <tool_call> blocks when
            // the text-only toolParser produced nothing. Opus 4.8 xhigh
            // and similar high-reasoning models sometimes emit the full
            // <tool_call>{...}</tool_call> markup inside thinking
            // (reasoning_content) rather than in the text stream.
            //
            // ORDERING IS CRITICAL: this must run AFTER pathStreamText.flush()
            // and BEFORE pathStreamThinking.flush(). If it ran before the text
            // flush, emitToolCallDelta would be followed by emitContent/emitThinking
            // which produce additional content_block_start events in the
            // MessagesStreamTranslator — Claude Code then sees a tool_use block
            // followed by a text or thinking block without proper sequencing and
            // throws "Content block not found". Running here lets us suppress
            // the thinking flush (below) when tool_calls were recovered,
            // keeping the SSE block sequence clean: thinking block is already
            // closed by pathStreamThinking.flush returning empty string.
            {
              const thinkingTail = pathStreamThinking.flush();
              if (emulateTools) {
                const bufferedThinking = `${accThinking || ''}${thinkingTail || ''}`;
                if (collectedToolCalls.length === 0 && bufferedThinking.trim()) {
                  const parsedFromThinking = parseToolCallsFromText(bufferedThinking, { modelKey, provider, route: deps?.route || 'chat' });
                  const fromThinking = filterToolCallsByAllowlist(parsedFromThinking.toolCalls, declaredTools);
                  if (fromThinking.length) {
                    accThinking = bufferedThinking;
                    log.info(`Chat[stream]: lifted ${fromThinking.length} tool_call(s) from thinking content (model=${modelKey})`);
                    // Do NOT emit thinking when it yielded tool_calls. Emitting
                    // a reasoning_content block before a tail tool_call in the
                    // same assistant turn produces an invalid Anthropic event
                    // sequence for Claude Code (block index mismatch →
                    // "Content block not found").
                    for (const rawTc of fromThinking) {
                      const tc = sanitizeToolCall(repairToolCallArguments(rawTc, messages));
                      const idx = collectedToolCalls.length;
                      collectedToolCalls.push(tc);
                      bridgeDiag.emulatedToolCalls++;
                      bridgeDiag.emulatedNames.push(tc.name);
                      emitToolCallDelta(tc, idx);
                    }
                  } else {
                    accThinking = '';
                    emitThinking(bufferedThinking);
                  }
                } else {
                  // A tool_call was already emitted from text/native parsing;
                  // keep any buffered reasoning only for accounting/cache state.
                  accThinking = bufferedThinking;
                }
              } else {
                emitThinking(thinkingTail);
              }
            }

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
            // v2.0.70 — onChunk now emits cascade native tool_calls
            // mid-stream (see "Cascade native trajectory tool_call
            // streamed live" branch above). The batch path here only
            // catches the tail case where collectedToolCalls is still
            // empty after stream end (e.g. final-sweep step came late);
            // dedupe by id so we never emit a tool_call twice.
            if (nativeBridgeOn && cascadeResult?.toolCalls?.length && collectedToolCalls.length === 0) {
              const lookup = nativeOpts?.callerLookup || new Map();
              const nativeRaw = [];
              for (const raw of cascadeResult.toolCalls) {
                if (!raw?.cascade_native) continue;
                if (markBridgeDiagCascadeRaw(raw)) {
                  recordNativeBridgeCascadeToolCall(raw.name);
                }
                if (isCompletedReadUrlNativeResult(raw)) {
                  if (!completedNativeReadUrlResults.some(existing => (existing.id || '') === (raw.id || ''))) {
                    completedNativeReadUrlResults.push(raw);
                  }
                  continue;
                }
                const candidates = lookup.get(raw.name) || [];
                const callerName = candidates[0];
                if (!callerName) {
                  bridgeDiag.unmappedToolCalls++;
                  bridgeDiag.unmappedKinds.push(raw.name);
                  recordNativeBridgeUnmappedCascadeToolCall(raw.name);
                  continue;
                }
                const reverseFn = TOOL_MAP[callerName]?.reverse;
                let cascadeArgs;
                try { cascadeArgs = JSON.parse(raw.argumentsJson || '{}'); } catch { bridgeDiag.argParseFailures++; cascadeArgs = {}; }
                let openaiArgs;
                try { openaiArgs = reverseFn ? reverseFn(cascadeArgs) : cascadeArgs; }
                catch { bridgeDiag.reverseFailures++; openaiArgs = cascadeArgs; }
                bridgeDiag.mappedToolCalls++;
                bridgeDiag.mappedNames.push(callerName);
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
                recordNativeBridgeEmittedToolCall(tc.name, { source: 'cascade' });
                emitToolCallDelta(tc, idx);
              }
              if (filteredNative.length === 0 && completedNativeReadUrlResults.length === 0 && cascadeResult.toolCalls.some(tc => tc.cascade_native)) {
                log.info(`Chat[stream]: nativeBridge=true received cascade tool calls but none mapped to caller tools (kinds=${cascadeResult.toolCalls.filter(tc => tc.cascade_native).map(tc => tc.name).join(',')})`);
              }
            }
            if (accText.length === 0 && collectedToolCalls.length === 0 && completedNativeReadUrlResults.length) {
              const fallbackText = completedNativeReadUrlResults.map(raw => raw.result).filter(Boolean).join('\n');
              if (fallbackText) emitContent(pathStreamText.feed(fallbackText));
              emitContent(pathStreamText.flush());
            }
            if (nativeBridgeOn && collectedToolCalls.length === 0 && completedNativeReadUrlResults.length === 0) recordNativeBridgeNoToolCallResponse();
            bridgeDiag.totalToolCalls = collectedToolCalls.length;
            bridgeDiag.noToolCalls = bridgeDiag.requestedTools && collectedToolCalls.length === 0 && completedNativeReadUrlResults.length === 0;
            logBridgeResultDiagnostics(reqId, bridgeDiag);
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
                modelKey: modelKey || '',
                stepOffset: Number.isFinite(cascadeResult.stepOffset) ? cascadeResult.stepOffset : reuseEntry?.stepOffset,
                generatorOffset: Number.isFinite(cascadeResult.generatorOffset) ? cascadeResult.generatorOffset : reuseEntry?.generatorOffset,
                historyCoverage: cascadeResult.historyCoverage || reuseEntry?.historyCoverage || null,
                createdAt: reuseEntry?.createdAt,
              }, callerKey, ttlHint === undefined ? 0 : ttlHint);

              // Bind caller to this account for the next turn
              if (callerKey && isStickyEnabled() && acct) {
                setStickyBinding(callerKey, modelKey, acct.id, acct.apiKey);
              }
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
              // Always build + record for internal billing; O1: only forward the
              // usage-only frame to the client when they opted in via
              // stream_options.include_usage (OpenAI omits it by default).
              const usage = buildUsageBody(cascadeResult?.usage || null, messages, accText, accThinking, cachePolicy);
              try { recordTokenUsage(usage); } catch {}
              if (deps.includeUsage) {
                send({ id, object: 'chat.completion.chunk', created, model,
                  choices: [], usage });
              }
            }
            if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
            if (ckey && !collectedToolCalls.length && cacheShareable && (accText || accThinking)) {
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
            const isDeadline = isUpstreamDeadlineExceeded(err);
            if (isDeadline) {
              reuseEntryDead = true;
            }
            const isAuthFail = /unauthenticated|invalid api key|invalid_grant|permission_denied.*account/i.test(err.message);
            const isRateLimit = /rate limit|rate_limit|too many requests|quota/i.test(err.message);
            const isInternal = /internal error occurred.*(error|trace)\s*id/i.test(err.message);
            const isTransport = isCascadeTransportError(err);
            const isTransient = !isDeadline && isUpstreamTransientError(err, isInternal);
            // v2.0.61 (#113) — same policy detection as nonStreamResponse.
            const isPolicyBlocked = /cyber\s*verification|content[\s_-]+policy|policy[\s_-]+(?:violation|blocked|denied)|safety[\s_-]+(?:policy|blocked)|prompt[\s_-]+(?:rejected|blocked)\s+by[\s_-]+policy|usage[\s_-]+policy[\s_-]+violation/i.test(err.message);
            if (isAuthFail) reportError(currentApiKey);
            if (isRateLimit) { recordRateLimited(); markRateLimited(currentApiKey, rateLimitCooldownMs(err.message), modelKey); err.isRateLimit = true; err.isModelError = true; err.kind ||= 'model_error'; }
            // v2.0.91 — IP-level rate limit circuit breaker (stream path).
            // Same logic as non-stream: ≥3 accounts rate-limited for the
            // same model within 8s → Windsurf is doing IP-wide cooldown,
            // stop burning accounts and surface immediately.
            const ctx = deps.context || {};
            if (isRateLimit && !ctx.__rlAborted) {
              if (!ctx.__rateLimitEvents) ctx.__rateLimitEvents = [];
              const RL_WINDOW_MS = 8_000;
              const RL_BURST_THRESHOLD = 3;
              const now = Date.now();
              ctx.__rateLimitEvents.push({
                time: now,
                model: modelKey,
                account: acct?.id,
                cooldownMs: rateLimitBurstCooldownMs({
                  message: err.message || '',
                  retryAfterMs: err.retry_after_ms,
                  apiKey: currentApiKey,
                  modelKey,
                }),
              });
              const cutoff = now - RL_WINDOW_MS;
              while (ctx.__rateLimitEvents.length && ctx.__rateLimitEvents[0].time < cutoff) {
                ctx.__rateLimitEvents.shift();
              }
              const sameModelBurst = ctx.__rateLimitEvents.filter(e => e.model === modelKey);
              if (sameModelBurst.length >= RL_BURST_THRESHOLD) {
                ctx.__rlAborted = true;
                log.warn(`Chat[${reqId}] stream: IP-rate-limit burst — ${sameModelBurst.length} accounts rate-limited on ${model} within ${RL_WINDOW_MS}ms. Short-circuiting.`);
                const cooldown = Math.max(...sameModelBurst.map(e => e.cooldownMs || IP_RATE_LIMIT_BURST_FLOOR_MS));
                lastErr = Object.assign(new Error(`All accounts temporarily rate-limited on ${model}. Windsurf upstream is applying IP-level cooldown. Wait ~${formatRetryAfter(cooldown)} before retrying.`), { type: 'rate_limit_exceeded', retry_after_ms: cooldown });
                break;
              }
            }
            if (isInternal) { reportInternalError(currentApiKey); err.isModelError = true; err.kind ||= 'transient_stall'; }
            if (isPolicyBlocked) { recordPolicyBlocked(); err.isPolicyBlocked = true; err.isModelError = true; err.kind = 'policy_blocked'; }
            if (isTransport) { err.isModelError = true; err.kind ||= 'transient_stall'; }
            // v2.0.56 stream-path ban detection — same 2-strike logic as
            // non-stream. See nonStreamResponse for rationale, including the
            // transient-first guard (internal/transient errors wrapped in an
            // auth-shaped shell must not be promoted to a permanent ban).
            if (!isRateLimit && !isInternal && !isTransient && looksLikeBanSignal(err.message)) {
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
              log.warn(`Chat[${reqId}] stream: policy_blocked on ${safeKeyRef(currentApiKey, 'apiKey')}, not retrying`);
              break;
            }
            if (isDeadline) {
              err.type = 'upstream_deadline_exceeded';
              err.code = 'windsurf_provider_deadline';
              break;
            }
            // Retry only if nothing has been streamed yet AND it's a retryable error
            if (!hadSuccess && (err.isModelError || isRateLimit)) {
              if (acct?._sticky && isExperimentalEnabled('stickyNoFallback')) {
                const tag = isRateLimit ? 'rate_limit' : isTransient ? 'upstream_transient' : 'model_error';
                log.warn(`Account ${safeAccountRef(acct)} (sticky-bound) failed (${tag}) on ${model}, stickyNoFallback enabled — not trying other accounts`);
                break;
              }
              const tag = isRateLimit ? 'rate_limit' : isTransient ? 'upstream_transient' : 'model_error';
              if (isTransient) {
                streamInternalCount++;
                const backoffMs = await internalErrorBackoff(streamInternalCount - 1);
                log.warn(`Chat[${reqId}] stream: ${safeAccountRef(acct)} upstream transient error (${isTransport ? 'cascade_transport' : 'internal_error'}), waited ${backoffMs}ms before next account`);
              } else {
                log.warn(`Account ${safeAccountRef(acct)} failed (${tag}) on ${model}, trying next`);
              }
              continue;
            }
            break;
          }
          } finally {
            // Pair every successful getApiKey/acquireAccountByKey with a
            // release so the in-flight balancer in auth.js (issue #37)
            // stays accurate through stream success, retry, and abort.
            if (acct) releaseAccountById(acct.id);
          }
        }

        // All attempts failed
        log.error('Stream error after retries:', lastErr?.message || String(lastErr || 'account queue timed out without an error object'));
        recordRequest(model, false, Date.now() - startTime, currentApiKey);
        try {
          const temporaryUnavailable = isAllTemporarilyUnavailable(modelKey);
          const rl = isAllRateLimited(modelKey);
          const allInternal = streamInternalCount > 0 && tried.length > 0 && streamInternalCount >= tried.length;
          const poolExhausted = isLsPoolExhausted(lastErr);
          const deadlineExceeded = isUpstreamDeadlineExceeded(lastErr) || lastErr?.type === 'upstream_deadline_exceeded';
          // 优先暴露 upstream_transient，避免把 Cascade transport 抖动误报成账号限流。
          const lastIsTransport = isCascadeTransportError(lastErr);
          const errMsg = allInternal
            ? upstreamTransientErrorMessage(model, tried.length, lastIsTransport ? 'cascade_transport' : 'internal_error')
            : deadlineExceeded
            ? upstreamDeadlineExceededMessage(model)
            : poolExhausted
            ? sanitizeText(lastErr?.message || 'language server pool exhausted')
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

          if (emittedClientPayload) {
            // We already streamed real assistant content. Injecting
            // "[Error: ...]" as a content delta here would corrupt the
            // assistant message (clients display it verbatim as model
            // output). Close cleanly with a plain stop — the caller saw
            // whatever partial content we produced. Error details only
            // go to the server log.
            finishPartialStreamAfterError({ id, created, model, send, res });
            log.warn(`Stream: partial response delivered then failed (${errMsg})`);
          } else {
            const errType = allInternal
              ? 'upstream_transient_error'
              : deadlineExceeded
                ? 'upstream_deadline_exceeded'
              : poolExhausted
                ? 'ls_pool_exhausted'
              : (temporaryUnavailable.allUnavailable || lastErr?.type === 'rate_limit_exceeded')
                ? 'rate_limit_exceeded'
                : 'upstream_error';
            send(chatStreamError(errMsg, errType, deadlineExceeded ? 'windsurf_provider_deadline' : null));
          }
          if (!emittedClientPayload) res.write('data: [DONE]\n\n');
        } catch {}
        if (!res.writableEnded) res.end();
      } finally {
        unregisterSse();
        stopHeartbeat();
      }
    },
  };
}
