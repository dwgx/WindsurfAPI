/**
 * POST /v1/chat/completions — OpenAI-compatible chat completions.
 * Routes to RawGetChatMessage (legacy) or Cascade (premium) based on model type.
 */

import { createHash, randomUUID } from 'crypto';
import { WindsurfClient, contentToString, isCascadeTransportError, acquireLsUseOrThrow, detachedClaimLostError, classifyCascadeEnd } from '../client.js';
import { getApiKey, acquireAccountByKey, releaseAccountById, currentApiKeyForId, getAccountInternal, getAccountAvailability, reportError, reportSuccess, markRateLimited, markQuotaExhausted, markSelectorIneligible, reportInternalError, reportDeadToken, updateCapability, getAccountList, isAllRateLimited, isAllTemporarilyUnavailable, isAllConnectAccountsUnavailable, refundReservation, looksLikeBanSignal, reportBanSignal, clearBanSignals, isModelBlockedByDrought, isConnectSelectorBlockedByDrought, getDroughtSummary, getConnectFreeFallbackSelectors, reLoginAccount as _reLoginAccount, getAccountCount, hasConnectEntitledAccount, recordAccountSpend, recordAccountAttempt, ensureDeviceSeed, requestReauthCheck, getConnectSelectorImageCapabilityForAccount } from '../auth.js';

import { isStickyEnabled, setStickyBinding, peekStickyBinding } from '../account/sticky-session.js';
import { resolveModel, getModelInfo, pickRateLimitFallback, isModelDisabledUpstream, getModelCaps } from '../models.js';
import { getLsFor, ensureLs, beginLsUse, endLsUse, getLsEntryByPort } from '../langserver.js';
import { detachedKey, detachedRegistry, cascadeDetachEnabled } from '../detached-registry.js';
import { config, log } from '../config.js';
import { leakTraceEnabled, thinkMarkersIn, leakSample } from '../leak-trace.js';
import { safeAccountRef, safeKeyRef, safeLogValue } from '../log-safety.js';
import { recordRequest, recordTokenUsage, recordPolicyBlocked, recordRateLimited } from '../dashboard/stats.js';
import { extractIntentFromNarrative, detectToolIntentInNarrative, maskNonActionableRegions } from './intent-extractor.js';
import { isModelAllowed } from '../dashboard/model-access.js';
import { cacheKey as computeCacheKey, cacheGet, cacheSet, isCacheEnabled } from '../cache.js';
import { isExperimentalEnabled, getBreakerTunable, strictUsageTotal } from '../runtime-config.js';
import { budgetExceededError, isBudgetExceededError } from '../request-budget.js';
import { checkOutboundHistory, historyBudgetErrorMessage, HISTORY_BUDGET_ERROR_CODE } from '../history-budget.js';
import { neutralizeClientIdentity, neutralizeMessageContent } from './identity-neutralize.js';
import { chatServerSideToolUnsupported, firstUnsupportedServerToolType, forEachTool } from '../server-side-tools.js';
// Tool-name charset hygiene on the OpenAI Chat surface (Q1 audit G1). The
// Anthropic (messages.js) and Responses (responses.js) surfaces have built this
// map since tool hygiene shipped; this surface never imported it, so an invalid
// client tool name (`mcp::x`, `a.b`, `tool with space`) reached the Connect wire
// and the upstream answered with a misleading `invalid_argument` ("an internal
// error occurred") mid-stream. Same helper, same map shape, same reverse leg.
import { buildToolNameMap, restoreToolName } from '../tool-names.js';
import { toolHygieneEnabled } from '../tool-ids.js';
import { normalizeStop, applyStop, StopSequenceGate } from '../stop-sequences.js';
import { normalizeToolCallArgs, recordArgRepair } from './cline-compat.js';

// Cline compat tool-arg shim (see src/handlers/cline-compat.js). Active only
// when the request is routed/detected as Cline; otherwise a byte-identical
// passthrough of the legacy `raw || '{}'` expression. Normalizes an arguments
// string @ai-sdk/openai-compatible would reject (empty/whitespace/non-JSON) so
// a parameterless tool call isn't silently dropped (vercel/ai#6687).
function clineCompatArgs(raw, active) {
  if (!active) return raw || '{}';
  const fixed = normalizeToolCallArgs(raw);
  if (fixed !== (raw || '{}')) recordArgRepair();
  return fixed;
}
import { checkMessageRateLimit } from '../windsurf-api.js';
import { getEffectiveProxy } from '../dashboard/proxy-config.js';
import {
  fingerprintBefore, fingerprintAfter, checkout as poolCheckout, checkin as poolCheckin,
} from '../conversation-pool.js';
import {
  normalizeMessagesForCascade, ToolCallStreamParser, parseToolCallsFromText, stripToolMarkupFromText,
  buildToolPreambleForProto, buildCompactToolPreambleForProto,
  buildSchemaCompactToolPreambleForProto, buildSkinnyToolPreambleForProto,
  trimToolsForWeakModel, isWeakEmulationModel, interleaveParallelToolMessages,
  orderToolResultsAfterCalls,
} from './tool-emulation.js';
import {
  getNativeBridgeDecision, buildReverseLookup,
  buildNativeToolHistory, parseNativeFunctionCallsFromText,
  NativeFunctionCallStreamParser, TOOL_MAP, isNativeBridgeAccountAllowed,
  hasNativeBridgeAccountGate, nativeAllowlistNameForTool,
} from '../cascade-native-bridge.js';
import {
  handleSpecialAgentChatCompletion,
} from '../special-agent.js';
import { acpVisionEnabled } from '../devin-acp.js';
import { selectBackend, usesCascadeFlow } from '../backend-router.js';
import { toChatCompletion as _toChatCompletion, streamChatCompletion as _streamChatCompletion } from '../devin-connect-openai.js';
import { resolveConnectSelector, DROUGHT_SAFE_SELECTORS, getConnectSelectorImageCapability } from '../devin-connect-models.js';
import { getToolDefTags, parseToolCallTagMap, isParallelToolCallsHintIgnored, stripImageParts, findFilePartInMessages, unsupportedFilePartError } from '../devin-connect.js';
import { recordRateLimitBurstEvent, RATE_LIMIT_BURST_WINDOW_MS } from '../rate-limit-burst.js';
import { isRouterModel, assignModel as _assignModel } from '../devin-connect-catalog.js';
import { bumpConnect } from '../devin-connect-metrics.js';
import { resolveSessionId as resolveConnectSessionId, commitAfterResponse as commitConnectSession, getSessionModelConfig as getSessionConnectModelConfig, getSessionReasoningTrail as getSessionConnectReasoningTrail } from '../session-continuity.js';
import { newTraceId, traceClientRequest, traceRouting, traceClientResponse, traceEnabled } from '../trace.js';
import { sanitizeText, sanitizeToolCall, PathSanitizeStream } from '../sanitize.js';
import {
  CascadeMetadataEgressStream,
  neutralizeCascadeIdentity,
  transformCascadeEgressText,
} from './cascade-metadata-egress.js';
import { systemFingerprint } from '../system-fingerprint.js';
import { registerSseController } from '../sse-registry.js';
import { createBoundedWriter, resolveMaxDrainWaitMs } from '../stream-writer.js';
import { validateJsonSchema } from '../json-schema.js';
import { createStreamReasoningDedup, isReasoningDedupEnabled } from '../reasoning-dedup.js';
import { ThinkTextClassifier } from '../response-classifier.js';
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
// C2/V-08: the drain ceiling and the writer contract live in
// ../stream-writer.js — one implementation for every SSE exit. A slow reader
// gets a bounded wait, not an unbounded one: a half-open client (stops reading,
// keeps TCP open) never emits 'drain', so without a ceiling the poll loop and
// the account checkout would be pinned for the life of the connection. The
// bound is proportional — a fixed 30s plus the time the bytes written so far
// need at a minimum client rate — so a stalled 4KB frame aborts early while a
// slow reader of a multi-megabyte frame keeps its full budget. Override the
// fixed part with WINDSURFAPI_MAX_DRAIN_MS, the rate with
// WINDSURFAPI_MIN_CLIENT_RATE_BPS.
const QUEUE_RETRY_MS = 1_000;
const QUEUE_MAX_WAIT_MS = 30_000;
const IP_RATE_LIMIT_BURST_FLOOR_MS = 30_000;

// Kept as a chat.js export for existing callers/tests; implementation lives in
// the focused egress module so the streaming and one-shot paths share it.
export { neutralizeCascadeIdentity } from './cascade-metadata-egress.js';

// #250 — reroute a LEADING think-tagged span out of the CONTENT channel into
// reasoning on the Cascade stream path, using the same ThinkTextClassifier the
// connect layer already runs (src/devin-connect-openai.js:241). Until this, the
// Cascade path had no think-reroute defense at all — and it is the path the
// README points Claude Code at, so it carries most of the traffic #250 affects.
// Covers streamResponse's legacy `rawGetChatMessage` egress too: both flows
// funnel through the same emitContent, and leaving one unprotected would just
// relocate the leak. Named for the flow that matters.
//
// DEFAULT ON, off switch WINDSURFAPI_CASCADE_THINK_REROUTE=0.
//
// Why ON, given the sibling connect gate defaults OFF: #250's leak is
// self-reinforcing — the client stores rerouted-as-visible reasoning and resends
// it next turn, re-priming more reasoning-as-text. A fix that ships OFF protects
// nobody on the route that actually carries the traffic. The transform is
// narrow: ONLY a marker at the very start of the content stream (optional
// leading whitespace) is rerouted, so an ordinary answer is byte-identical.
//
// Both failure shapes named in review are bounded by machinery already on this
// path, which is what makes ON defensible rather than optimistic:
//   - content loss (rerouted bytes invisible to a content-only client) — a turn
//     that was ENTIRELY a think block lands in accThinking, where the existing
//     shouldFallbackThinkingToText net promotes it back to content for a
//     non-thinking model, exactly as it does for a genuine thinking-only turn;
//   - duplicated text (same bytes on both channels) — the rerouted span goes
//     through the reasoning sink, so reasoningDedup.noteReasoning() sees it and
//     a model that then repeats it verbatim as text is suppressed by the
//     existing duplicate logic instead of double-delivered.
// Setting it to '0' restores byte-identical egress to before this change.
export function isCascadeThinkRerouteEnabled(env = process.env) {
  return String(env.WINDSURFAPI_CASCADE_THINK_REROUTE || '1') !== '0';
}

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

function hasCallerVisibleCascadeTailToolCall(rawCalls, nativeOpts, declaredTools) {
  if (!Array.isArray(rawCalls) || rawCalls.length === 0) return false;
  const lookup = nativeOpts?.callerLookup || new Map();
  const mapped = [];
  for (const raw of rawCalls) {
    if (!raw?.cascade_native || isCompletedReadUrlNativeResult(raw)) continue;
    const callerName = (lookup.get(raw.name) || [])[0];
    if (!callerName) continue;
    const reverseFn = TOOL_MAP[callerName]?.reverse;
    let cascadeArgs;
    try { cascadeArgs = JSON.parse(raw.argumentsJson || '{}'); } catch { cascadeArgs = {}; }
    let openaiArgs;
    try { openaiArgs = reverseFn ? reverseFn(cascadeArgs) : cascadeArgs; }
    catch { openaiArgs = cascadeArgs; }
    mapped.push({
      id: raw.id || `preview_${mapped.length}`,
      name: callerName,
      argumentsJson: JSON.stringify(openaiArgs ?? {}),
    });
  }
  return filterToolCallsByAllowlist(mapped, declaredTools).length > 0;
}

// Cap exponential backoff before falling over to the next account when
// upstream Cascade returns "internal error occurred". Without this a
// 9-account pool hammers the upstream within ~10s and every attempt
// sees the same transient — the OpenClaw real-scenario probe (#28)
// caught this as 11/20 failures even though the proxy itself is
// healthy. With backoff capped at 5s the Nth attempt sees a cooler
// upstream and has a meaningful chance of succeeding.
//   retry 0 → 500ms, 1 → 1s, 2 → 2s, 3 → 4s, ≥4 → 5s
//
// The request budget clamps the wait: a backoff that outlives the deadline is
// pure lost time, and a retry after it would be refused anyway. Returns the
// milliseconds actually waited so the caller's log line stays truthful.
async function internalErrorBackoff(retryIdx, budget = null) {
  let ms = Math.min(500 * Math.pow(2, retryIdx), 5000);
  if (budget) {
    const remaining = budget.remainingMs();
    if (remaining <= 0) return 0;
    ms = Math.min(ms, remaining);
  }
  await new Promise(r => setTimeout(r, ms));
  return ms;
}

// ── Exhausted-pool admission fast-fail ──────────────────────────────────────
// A fully rate-limited/unavailable pool cannot free an account by waiting: the
// soonest cooldown is minutes out, while the queue wait is 30 s per attempt.
// Measured P0 (2026-10-22): a pool known-exhausted at t=0 still cost 30,338 ms
// on the Cascade route, while the connect route's equivalent preflight answered
// the same state in 22 ms. Degraded serve is the one exception — it deliberately
// serves the least-bad throttled account, so a pool it can serve is not
// "exhausted" for admission purposes.
function poolExhaustedFailure(modelKey) {
  const temporary = isAllTemporarilyUnavailable(modelKey);
  const rateLimited = isAllRateLimited(modelKey);
  if (!temporary.allUnavailable && !rateLimited.allLimited) return null;
  const degradable = getBreakerTunable('degradedServe') && rateLimited.allLimited && !temporary.allUnavailable;
  if (degradable) return null;
  const retryAfterMs = (temporary.allUnavailable ? temporary.retryAfterMs : rateLimited.retryAfterMs) || 60_000;
  return {
    retryAfterMs,
    reason: temporary.allUnavailable
      ? `所有可用账号暂时不可用，请 ${Math.ceil(retryAfterMs / 1000)} 秒后重试`
      : `所有可用账号均已达速率限制，请 ${Math.ceil(retryAfterMs / 1000)} 秒后重试`,
  };
}

// The hint a queue timeout advertises when the pool was merely busy: an
// in-flight slot frees on the queue's own retry cadence, not on a cooldown.
function queueTimeoutRetryAfterMs(temporaryUnavailable, rateLimited) {
  if (temporaryUnavailable.allUnavailable && temporaryUnavailable.retryAfterMs > 0) return temporaryUnavailable.retryAfterMs;
  if (rateLimited.allLimited && rateLimited.retryAfterMs > 0) return rateLimited.retryAfterMs;
  return QUEUE_RETRY_MS;
}

// Clamp every admission/attempt wait to the route's remaining budget. A layer
// may only shorten its own bound; the request deadline is the outer bound.
function budgetWaitMs(budget, capMs) {
  return budget ? budget.waitMs(capMs) : capMs;
}

// Consume one upstream turn before issuing work. Returns the error to surface
// when the budget is spent (callers break with it), or null when a turn was
// granted. Keeping the error construction here means every layer reports the
// same 504-class failure instead of inventing a per-layer one.
function takeUpstreamTurn(budget, label) {
  if (!budget) return null;
  if (budget.takeTurn()) return null;
  return budgetExceededError(
    budget.expired()
      ? `request budget exhausted before ${label} (${budget.describe()})`
      : `request upstream-turn cap reached before ${label} (${budget.describe()})`,
  );
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

// v3.4.x — content-policy-block observability. The upstream content policy is
// non-deterministic (same prompt blocks then passes), so we snapshot a small
// sample at block time for later A/B by the operator. SECURITY: sample ONLY
// system-role text — never user/tool content (avoids leaking user PII/tokens),
// and never the raw tools array. Hash the full system text; sample first ~512B.
function buildPolicyBlockSample(messages, model, account, traceId) {
  let systemText = '';
  if (Array.isArray(messages)) {
    const parts = [];
    for (const m of messages) {
      if (!m || m.role !== 'system') continue;
      const c = m.content;
      if (typeof c === 'string') {
        parts.push(c);
      } else if (Array.isArray(c)) {
        for (const blk of c) {
          if (blk && blk.type === 'text' && typeof blk.text === 'string') parts.push(blk.text);
        }
      }
    }
    systemText = parts.join('\n');
  }
  const SAMPLE_BYTES = Number(process.env.POLICY_BLOCK_SAMPLE_BYTES) || 512;
  return {
    ts: Date.now(),
    model,
    account: account || null,
    promptHash: shortHash(systemText),
    promptSample: systemText.slice(0, SAMPLE_BYTES),
    traceId: traceId || null,
  };
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

/**
 * A07/KH-003: validate the ORIGINAL tool/choice pair before any filtering.
 *
 * `effectiveToolsForToolChoice` is a filter, not a validator: a forced
 * `{type:'function', function:{name:'X'}}` that names a tool the caller never
 * declared reduces the effective list to empty. The request then runs with no
 * tools and no error, so the caller cannot tell its forced tool was discarded.
 * OpenAI itself rejects that request with a 400; this returns the same shape.
 *
 * Also refuse a `tool_choice` that names a server-executed tool: the proxy has
 * no executor for it, and silently dropping the choice would let the model
 * answer as if the caller had not forced anything.
 */
export function validateToolChoiceContract(tools, toolChoice) {
  if (!toolChoice || typeof toolChoice !== 'object') return null;
  const rejectedType = firstUnsupportedServerToolType([toolChoice]);
  if (rejectedType) {
    const err = chatServerSideToolUnsupported(rejectedType, 'tool_choice');
    return {
      status: 400,
      body: {
        error: {
          message: err.message,
          type: 'invalid_request_error',
          param: err.param,
          code: err.code,
        },
      },
    };
  }
  const forced = toolChoice.function?.name || toolChoice.name || '';
  if (!forced) return null;
  const declared = toolNameList(tools);
  if (!declared.includes(forced)) {
    return {
      status: 400,
      body: {
        error: {
          message: `Invalid 'tool_choice': function '${forced}' not found in 'tools'.`,
          type: 'invalid_request_error',
          param: 'tool_choice',
          code: 'tool_choice_tool_not_declared',
        },
      },
    };
  }
  return null;
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

// Tool names a conversation's HISTORY already carries. The Anthropic surface
// collects these before building its name map (messages.js historyToolNames)
// because a replayed assistant `tool_use` is re-encoded upstream: under the
// native Connect path it becomes a #6 ChatToolCall whose `name` the upstream
// validates against the declared #10 ToolDefs. A history name the map does not
// cover would therefore be sent as "a tool that was never declared".
function historyToolNamesOf(messages) {
  const names = [];
  if (!Array.isArray(messages)) return names;
  for (const m of messages) {
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      const name = tc?.function?.name || tc?.name;
      if (typeof name === 'string' && name) names.push(name);
    }
  }
  return names;
}

// Apply the wire names to the history's assistant tool_calls. Fresh objects, never
// in-place mutation: the same `messages` array is re-passed on retry/failover and
// is the caller's input. `wireName` is the request-scoped lookup.
function renameHistoryToolNames(messages, wireName) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const out = messages.map((m) => {
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) return m;
    let localChanged = false;
    const calls = m.tool_calls.map((tc) => {
      const raw = tc?.function?.name || tc?.name;
      if (typeof raw !== 'string' || !raw) return tc;
      const wire = wireName(raw);
      if (!wire || wire === raw) return tc;
      localChanged = true;
      return tc?.function ? { ...tc, function: { ...tc.function, name: wire } } : { ...tc, name: wire };
    });
    if (!localChanged) return m;
    changed = true;
    return { ...m, tool_calls: calls };
  });
  return changed ? out : messages;
}

// `tool_choice` carries a tool NAME when the caller forces one, so it has to be
// rewritten with the same request-scoped map as the declarations. Strings
// ('auto'/'required'/'none') and shapes without a name pass through untouched —
// the upstream contract check (validateToolChoiceContract) already ran against
// the CALLER's spelling, which is what the caller can see.
function mapToolChoiceToWire(toolChoice, wireName) {
  if (!toolChoice || typeof toolChoice !== 'object') return toolChoice;
  const raw = toolChoice.function?.name || toolChoice.name;
  if (typeof raw !== 'string' || !raw) return toolChoice;
  const wire = wireName(raw);
  if (!wire || wire === raw) return toolChoice;
  return toolChoice.function
    ? { ...toolChoice, function: { ...toolChoice.function, name: wire } }
    : { ...toolChoice, name: wire };
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

export function chatStreamError(message, type = 'upstream_error', code = null, extra = null) {
  return { error: { message: sanitizeText(message || 'Upstream stream error'), type, code, ...(extra || {}) } };
}

// O12: OpenAI chat.completion / chat.completion.chunk bodies carry
// service_tier next to system_fingerprint. This proxy has no paid-tier
// routing, so every successful completion reports 'default'. Error
// bodies are a different shape ({ error }) and must not grow this field.
const DEFAULT_SERVICE_TIER = 'default';

function applyChatCompletionCompatFields(data, fp) {
  if (!data || (data.object !== 'chat.completion' && data.object !== 'chat.completion.chunk')) return data;
  if (fp != null && data.system_fingerprint == null) data.system_fingerprint = fp;
  if (data.service_tier == null) data.service_tier = DEFAULT_SERVICE_TIER;
  return data;
}

function logprobsRequested(value) {
  if (value == null || value === false || value === 0) return false;
  if (value === true) return true;
  const n = Number(value);
  if (value !== '' && Number.isFinite(n)) return n !== 0;
  return true;
}

function topLogprobsRequested(value) {
  if (value == null || value === false || value === 0) return false;
  const n = Number(value);
  if (value !== '' && Number.isFinite(n)) return n > 0;
  return true;
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
    // SELECTOR_NOT_ELIGIBLE: the upstream refused this MODEL for THIS account
    // ("This model is no longer available for your account") while the session
    // token stays alive. 403 model_not_available is the same internal vocabulary
    // the Cascade path uses for "this account cannot serve this model → try the
    // next account", and it is what the failover loop above already did. It must
    // NOT read as 401 authentication_error: the account's auth state was never
    // in question, and a client that sees 401 re-authenticates for nothing.
    case 'SELECTOR_NOT_ELIGIBLE': return { status: 403, type: 'model_not_available' };
    case 'QUOTA_EXHAUSTED': return { status: 402, type: 'insufficient_quota' };
    case 'UNAUTHORIZED': return { status: 401, type: 'authentication_error' };
    case 'RATE_LIMITED': return { status: 429, type: 'rate_limit_error' };
    case 'CAPACITY': return { status: 503, type: 'capacity_error' };
    case 'UPSTREAM_INTERNAL': return { status: 503, type: 'upstream_transient_error' };
    // CONTENT_BLOCKED: upstream content policy rejected the REQUEST content (not an
    // auth or account fault). 400 invalid_request_error is the honest surface — the
    // caller must change the prompt, not retry or re-auth. NO account penalty.
    case 'CONTENT_BLOCKED': return { status: 400, type: 'invalid_request_error' };
    // REQUEST_REJECTED: the upstream request VALIDATOR refused the request itself
    // (gRPC invalid_argument / failed_precondition) — measured for an image sent
    // to a model whose /v1/models row omits supports_images
    // (evidence/AccountMatrix.md §7.1) and for a malformed native tool history
    // (#273.1). The token is alive, the account is healthy, and identical bytes
    // fail identically, so 400 invalid_request_error is the honest surface. This
    // used to read as 503 UPSTREAM_INTERNAL (the body says "an internal error
    // occurred") or 502 upstream_error (verbatim passthrough) — both tell a
    // client to retry a request that can never succeed.
    case 'REQUEST_REJECTED': return { status: 400, type: 'invalid_request_error' };
    // P-03: a file/document block cannot ride ChatMessage (text #3 + images #10
    // only). The handler rejects it before dispatch; this is the backstop for a
    // direct builder throw that reaches the shared error mapper.
    case 'unsupported_input_file': return { status: 400, type: 'invalid_request_error' };
    case 'NO_TOKEN': return { status: 401, type: 'authentication_error' };
    case 'TIMEOUT': return { status: 504, type: 'timeout_error' };
    // Absolute wall-clock deadline (upstream hung the full window). Same 504
    // surface as an idle TIMEOUT, but a DISTINCT code so it is NOT in
    // RETRYABLE_CODES — the stream replay gate must not re-run a doomed ≈2×
    // cycle against the same stuck upstream (external audit 2026-07-12, flaw 1).
    case 'DEADLINE_EXCEEDED': return { status: 504, type: 'timeout_error' };
    case 'windsurf_provider_deadline': return { status: 504, type: 'timeout_error' };
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
//
// SELECTOR_NOT_ELIGIBLE is the THIRD scope and must be here, not in the excluded
// list: "This model is no longer available for your account" is scoped to the
// (account, selector) PAIR, so a peer entitled to that selector can serve the
// request. While it classified as UNAUTHORIZED the request did hop — but only via
// the DEAD-TOKEN path, which charged the account's error budget, fired a re-login
// and a reauth probe for a token that was alive, and with no eligible peer
// surfaced as 401 "all accounts exhausted (dead session tokens)" instead of the
// selector's own verdict.
export function isAccountFailoverError(code) {
  return code === 'QUOTA_EXHAUSTED' || code === 'RATE_LIMITED' || code === 'SELECTOR_NOT_ELIGIBLE';
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

/**
 * Close a stream that already delivered content and THEN failed.
 *
 * A06/KH-002: this used to fabricate `finish_reason:'stop'` (plus `[DONE]`),
 * i.e. it told every direct `/v1/chat/completions` client that a dead turn was
 * a normal completion. A synthetic stop is not a terminal the client can act
 * on: it cannot distinguish it from a real answer, and the internal translators
 * had to carry a private `__synthetic_finish` marker just to undo the lie.
 *
 * The honest wire shape is an explicit error frame. `[DONE]` is deliberately
 * NOT written: it is the OpenAI "clean finish" sentinel, and a relay that sees
 * it treats the stream as whole (the same rule the pre-content failure path
 * already follows). The partial content the client already received stays on
 * the wire; the error frame is the terminal signal.
 *
 * The frame is handed back to the caller so a sequential (awaiting) caller can
 * wait for the socket. A synchronous caller keeps today's shape: its `send`
 * returns undefined, so the returned value is undefined too.
 */
export function finishPartialStreamAfterError({ id, created, model, send, res, internalRoute = false, error = null }) {
  const message = typeof error === 'string' ? error : error?.message;
  const type = (typeof error === 'object' && error?.type) || 'upstream_error';
  const code = (typeof error === 'object' && error?.code) || 'STREAM_TRUNCATED';
  const retryAfterMs = Number(error?.retry_after_ms);
  const written = typeof send === 'function'
    ? send({
      error: {
        message: message || 'Upstream stream ended before completion (response is incomplete)',
        type,
        ...(code ? { code } : {}),
        ...(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? { retry_after_ms: retryAfterMs } : {}),
      },
    })
    : undefined;
  return written;
}

/**
 * Close a stream whose Cascade poll loop stopped BEFORE the upstream said the
 * turn was done (`max_wait` / `stall_warm`). The partial bytes are already on
 * the wire, so the truthful OpenAI terminal is `finish_reason:'length'` — not
 * `'stop'`. `__windsurf_end_reason` distinguishes an upstream truncation from a
 * caller-imposed output cap for clients that care; internal translators also
 * receive `__synthetic_finish` so they do not treat this fabricated terminal as
 * proof the turn completed (and therefore never commit it to the response
 * store).
 */
export function finishTruncatedStream({ id, created, model, send, internalRoute = false, finishReason = 'length', endReason = 'upstream_truncated' }) {
  const written = typeof send === 'function'
    ? send({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      __windsurf_end_reason: endReason,
      ...(internalRoute ? { __synthetic_finish: true } : {}),
    })
    : undefined;
  return written;
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
  const clauses = text
    .split(/[,，;；:：.!?！？。]+/)
    .map(part => part.trim())
    .filter(Boolean);
  const jsonOnlyContract = clause => (
    /\b(?:(?:answer|respond|return|output)\s+)?nothing\s+(?:except|but)\s+(?:valid\s+)?JSON\b/i.test(clause)
    || /\b(?:do\s+not|don['’]?t|never)\s+(?:answer|respond|return|output|produce|provide|emit)\s+anything\s+(?:except|but)\s+(?:valid\s+)?JSON\b/i.test(clause)
    || /\b(?:do\s+not|don['’]?t|never)\s+(?:answer|respond|return|output|produce|provide|emit)\s+(?:any\s+)?non[-\s]?JSON(?:\s+(?:content|text|output|response|data))?\b/i.test(clause)
    || /(?:不要|请勿|别|禁止)\s*(?:返回|输出|生成|提供)\s*JSON\s*(?:以外|之外)\s*的?\s*任何(?:内容|格式|文本)/.test(clause)
    || /(?:除|除了)\s*JSON\s*(?:以外|之外|外)?\s*(?:不要|请勿|别|禁止)\s*(?:返回|输出|生成|提供)\s*任何(?:内容|格式|文本)/.test(clause)
    || /(?:不要|请勿|别|禁止|不得)\s*(?:返回|输出|生成|提供)\s*(?:任何)?\s*非\s*JSON\s*(?:内容|文本|格式|数据)?/.test(clause)
  );
  const jsonContractSuffix = (suffix, { allowContentSpec = false } = {}) => {
    const rest = String(suffix || '').trim();
    if (!rest || /^(?:only|please)$/i.test(rest)) return true;
    if (/^(?:[-\u2014\u2013]\s*)?(?:and\s+)?nothing\s+else$/i.test(rest)) return true;
    if (/^(?:(?:[-\u2014\u2013]\s*)|\(\s*)?(?:and\s+)?(?:without|no)\s+(?:any\s+)?(?:prose|plain\s+text|text|explanation|commentary|markdown(?:\s+fences?)?|code\s+fences?)(?:\s*\))?$/i.test(rest)) return true;
    return allowContentSpec && /^(?:with|containing)\b[\s\S]*$/i.test(rest);
  };
  const commandJsonContract = clause => {
    const match = clause.match(/\b(?:return|output|produce|provide|emit|(?:give|send)\s+me)\s+(?:only\s+)?(?:(?:a|an)\s+)?(?:(?:valid|compact|raw|strict|minified|well[-\s]?formed)\s+)*JSON(?:\s+(?:object|format|response|payload|document|data))?\b([\s\S]*)$/i);
    return !!match && jsonContractSuffix(match[1], { allowContentSpec: true });
  };
  const useJsonContract = clause => {
    const match = clause.match(/\buse\s+(?:(only)\s+)?(?:(?:a|an)\s+)?((?:(?:valid|compact|raw|strict|minified|well[-\s]?formed)\s+)*)JSON(?:\s+(object|format|response|payload|document|data))?\b([\s\S]*)$/i);
    if (!match) return false;
    const hasStrongCue = !!(match[1] || match[2].trim() || match[3]);
    return jsonContractSuffix(match[4], { allowContentSpec: hasStrongCue });
  };
  const answerJsonContract = clause => {
    const preposition = clause.match(/\b(?:answer|respond|reply)\s+(?:only\s+)?(?:with|in|as|using)\s+(?:only\s+)?(?:(?:a|an)\s+)?(?:(?:valid|compact|raw|strict|minified|well[-\s]?formed)\s+)*JSON(?:\s+(?:object|format|response|payload|document|data))?\b([\s\S]*)$/i);
    if (preposition) return jsonContractSuffix(preposition[1], { allowContentSpec: true });

    const direct = clause.match(/\b(?:answer|respond|reply)\s+(?:(only)\s+)?(?:(?:a|an)\s+)?((?:(?:valid|compact|raw|strict|minified|well[-\s]?formed)\s+)*)JSON(?:\s+(object|format|response|payload|document|data))?\b([\s\S]*)$/i);
    if (!direct) return false;
    const hasStrongCue = !!(direct[1] || direct[2].trim() || direct[3]);
    return jsonContractSuffix(direct[4], { allowContentSpec: hasStrongCue });
  };
  const modalJsonContract = clause => {
    const match = clause.match(/\b(?:(?:your|the)\s+)?(?:answer|response|reply|output|result)\s+(?:must|should|shall)\s+be\s+(?:only\s+)?(?:(?:a|an)\s+)?(?:(?:valid|compact|raw|strict|minified|well[-\s]?formed)\s+)*JSON(?:\s+(?:object|format|response|payload|document|data))?\b([\s\S]*)$/i);
    return !!match && jsonContractSuffix(match[1], { allowContentSpec: true });
  };
  const formattedJsonContract = clause => {
    const match = clause.match(/\b(?:format|encode)\s+(?:the\s+)?(?:answer|response|result|output)\s+as\s+(?:(?:valid|compact|raw|strict|minified|well[-\s]?formed)\s+)*JSON(?:\s+(?:object|format|response|payload|document|data))?\b([\s\S]*)$/i);
    return !!match && jsonContractSuffix(match[1], { allowContentSpec: true });
  };
  const positiveJsonContract = clause => (
    commandJsonContract(clause)
    || useJsonContract(clause)
    || answerJsonContract(clause)
    || modalJsonContract(clause)
    || formattedJsonContract(clause)
    || /^\s*(?:only\s+)?(?:(?:valid|compact|raw|strict|minified|well[-\s]?formed)\s+)*JSON(?:\s+(?:object|format|response|payload|document|data))?\s+only\s*$/i.test(clause)
    || /^\s*(?:(?:a|an|valid|compact|raw|strict|minified|well[-\s]?formed)\s+)*JSON\s+(?:object|format|response|payload|document|data)\s*$/i.test(clause)
    || /^\s*(?:(?:a|an|valid|compact|raw|strict|minified|well[-\s]?formed)\s+)*JSON(?:\s+(?:object|format|response|payload|document|data))?\s*,?\s*please[.!?]?\s*$/i.test(clause)
    // Chinese contracts require format/output adjacency. Merely answering the
    // meaning of “JSON” in text is not a structured-output request.
    || /(?:仅|只)\s*(?:以|用)\s*JSON\s*(?:格式|对象)?\s*(?:返回|输出|回答|响应)?/.test(clause)
    || /(?:仅|只)\s*(?:返回|输出|生成|提供)\s*(?:有效|合法|紧凑)?\s*JSON\s*(?:格式|对象)?(?=\s*(?:$|(?:即可|就好|就行)\s*$|(?:包含|含有|带有)))/.test(clause)
    || /(?:返回|输出|生成|提供)\s*(?:仅|只|必须)\s*(?:有效|合法|紧凑)?\s*JSON\s*(?:格式|对象)?(?=\s*(?:$|(?:即可|就好|就行)\s*$|(?:包含|含有|带有)))/.test(clause)
    || /(?:返回|输出|生成|提供)\s*(?:有效|合法|紧凑)\s*JSON\s*(?:格式|对象)?(?=\s*(?:$|(?:即可|就好|就行)\s*$|(?:包含|含有|带有)))/.test(clause)
    || /(?:返回|输出|生成|提供)\s*JSON\s*(?:格式|对象)(?=\s*(?:$|(?:即可|就好|就行)\s*$|(?:包含|含有|带有)))/.test(clause)
    || /(?:返回|输出|生成|提供)\s*JSON(?=\s*(?:$|(?:即可|就好|就行)\s*$|(?:包含|含有|带有)))/.test(clause)
    || /(?:以|用)\s*JSON\s*(?:格式)?\s*(?:返回|输出|回答|回复|响应)/.test(clause)
    || /(?:答案|回答|回复|响应|输出|结果)\s*(?:必须|应当|应该|应|须|需)\s*(?:是|为)\s*(?:有效|合法|紧凑)?\s*JSON\s*(?:格式|对象)?(?=\s*(?:$|(?:即可|就好|就行)\s*$|(?:包含|含有|带有)))/.test(clause)
  );
  const stripNegativeJsonSpans = clause => {
    let matched = false;
    const remaining = clause
      .replace(/\b(?:answer|respond|return|output|produce|provide|emit)\s+anything\s+(?:except|but)\s+(?:valid\s+)?JSON\b/gi, () => {
        matched = true;
        return ' ';
      })
      .replace(/\b(?:(?:your|the)\s+)?(?:answer|response|reply|output|result)\s+(?:(?:must|should|shall)\s+(?:not|never)|cannot|can['’]?t)\s+be\s+(?:only\s+)?(?:(?:a|an)\s+)?(?:(?:valid|compact|raw|strict|minified|well[-\s]?formed)\s+)*JSON(?:\s+(?:object|format|response|payload|document|data))?\b/gi, () => {
        matched = true;
        return ' ';
      })
      .replace(/\b(?:do\s+not|don['’]?t|never)\s+(?:only\s+)?(?:answer|respond|reply|return|output|use|produce|provide|emit|give|send|format|encode)(?:\s+me)?\s+(?:(?:in|with|using|as)\s+)?(?:(?:any|a|an|valid|compact|raw|strict|minified|well[-\s]?formed|only)\s+)*JSON(?:\s+(?:object|format|response|payload|document|data))?\b/gi, () => {
        matched = true;
        return ' ';
      })
      .replace(/\b(?:answer|respond|return|output|use|produce|provide|emit)\s+without\s+(?:(?:any|a|an|valid|compact|raw|strict|minified|well[-\s]?formed)\s+)*JSON(?:\s+(?:object|format|response|payload|document|data))?\b/gi, () => {
        matched = true;
        return ' ';
      })
      .replace(/\bavoid\s+(?:using\s+)?(?:(?:any|a|an|valid|compact|raw|strict|minified|well[-\s]?formed)\s+)*JSON(?:\s+(?:object|format|response|payload|document|data))?\b/gi, () => {
        matched = true;
        return ' ';
      })
      .replace(/\bno\s+(?:(?:any|valid|compact|raw|strict|minified|well[-\s]?formed)\s+)*JSON(?:\s+(?:output|response|object|format|payload|document|data))?\b/gi, () => {
        matched = true;
        return ' ';
      })
      .replace(/(?:答案|回答|回复|响应|输出|结果)\s*(?:不应当|不应该|不应|不能|不可|不得)\s*(?:是|为)?\s*(?:有效|合法|紧凑)?\s*JSON\s*(?:格式|对象)?/gi, () => {
        matched = true;
        return ' ';
      })
      .replace(/(?:不要|无需|不需要|禁止|请勿|勿|别|避免).{0,12}?JSON\s*(?:格式|对象)?/gi, () => {
        matched = true;
        return ' ';
      });
    return { matched, remaining };
  };

  let sawPositive = false;
  let sawNegative = false;
  for (const clause of clauses) {
    // A negated noun phrase can itself be the positive contract: “return
    // nothing except JSON”. Check it before classifying the clause as a ban.
    if (jsonOnlyContract(clause)) {
      sawPositive = true;
      continue;
    }
    const stripped = stripNegativeJsonSpans(clause);
    if (stripped.matched) {
      sawNegative = true;
      // Conjunctions are content too, so do not split blindly on but/and/但.
      // Instead remove only the local rejection span and let an independent
      // contract in the remainder keep structured output authoritative.
      if (jsonOnlyContract(stripped.remaining) || positiveJsonContract(stripped.remaining)) {
        sawPositive = true;
      }
      continue;
    }
    if (positiveJsonContract(clause)) sawPositive = true;
  }
  if (sawPositive) return true;
  if (sawNegative) return false;

  // Preserve historical cross-line phrasing (for example, an action on one
  // line and “with JSON” on the next) when no clause explicitly rejected it.
  return jsonOnlyContract(text) || positiveJsonContract(text);
}

const CASCADE_METADATA_FIELD_NAMES = ['name', 'provider', 'model', 'description'];

function isExplicitStructuredShapeRequestText(text) {
  const source = String(text || '').trim();
  if (!source) return false;

  // Topic questions that merely discuss objects/schemas must not disable the
  // #185 repair. Only an output command or an exact requested field shape is
  // authoritative.
  if (/^(?:(?:please|kindly)\s+)?(?:explain|discuss|compare|define|what|why|how)\b/i.test(source)) {
    return false;
  }
  if (/^(?:(?:please|kindly)\s+)?(?:provide|give(?:\s+me)?|return|answer|respond|reply|output|emit|produce|present)(?:\s+(?:with|using))?\s+(?:(?:a|an|the)\s+)?(?:explanation|tutorial|discussion|comparison|definition)\b/i.test(source)) {
    return false;
  }

  const outputFormatDeclaration = /^(?:(?:the\s+)?(?:answer|response|reply|output|result)\s+format|output\s+format)\s*(?::|=|\bis\b)\s*(?:only\s+)?(?:(?:a|an)\s+)?(?:(?:valid|strict|raw|compact|well[-\s]?formed|structured)\s+)*(?:JSON(?:\s+(?:object|format|response|payload|document|data))?|object|record|payload)\s*$/i;
  const declarativeStructuredOutput = /^(?:(?:all|every|each|your|the)\s+)?(?:answers?|responses?|replies|outputs?|results?)\s+(?:are|is)\s+(?:only\s+)?(?:(?:a|an)\s+)?(?:(?:valid|strict|raw|compact|well[-\s]?formed|structured)\s+)*(?:JSON(?:\s+(?:object|format|response|payload|document|data))?|objects?|records?|payloads?)\s*$/i;
  const namedFormatDeclaration = /^(?:(?:the\s+)?(?:answer|response|reply|output|result)\s+format|output\s+format)\s*(?::|=|\bis\b)\s*(?:only\s+)?(?:(?:a|an)\s+)?(?:(?:valid|strict|raw|compact|well[-\s]?formed|structured)\s+)*(?:YAML(?:\s+(?:object|mapping|document|record|payload|format))?|XML(?:\s+(?:object|mapping|document|record|payload|format))?)\s*[.!?]?\s*$/i;
  const declarativeNamedFormat = /^(?:(?:all|every|each|your|the)\s+)?(?:answers?|responses?|replies|outputs?|results?)\s+(?:are|is)\s+(?:only\s+)?(?:(?:a|an)\s+)?(?:(?:valid|strict|raw|compact|well[-\s]?formed|structured)\s+)*(?:YAML(?:\s+(?:objects?|mappings?|documents?|records?|payloads?|format))?|XML(?:\s+(?:objects?|mappings?|documents?|records?|payloads?|format))?)\s*[.!?]?\s*$/i;
  if (outputFormatDeclaration.test(source) || declarativeStructuredOutput.test(source)
      || namedFormatDeclaration.test(source) || declarativeNamedFormat.test(source)) return true;

  // A structured-output noun must end the command or introduce a shape cue.
  // A bare word boundary is too broad: `object-oriented`, `object-storage`, and
  // `object detector` are ordinary implementation topics, not output contracts.
  const directObject = /^(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you|you\s+(?:must|shall|should|are\s+required\s+to|have\s+to))\s+)?(?:always\s+)?(?:return|output|emit|provide|produce|send|give(?:\s+me)?|create|generate|build|construct)\s+(?:only\s+)?(?:(?:a|an|the)\s+)?(?:(?:valid|structured|JSON)\s+)*(?:object|record|payload)(?=\s*(?:[.!?]?\s*$|(?:with|containing|including|having|matching|using|following|conforming(?:\s+to)?)\b))/i;
  const answerWithObject = /^(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you|you\s+(?:must|shall|should|are\s+required\s+to|have\s+to))\s+)?(?:always\s+)?(?:answer|respond|reply)\s+(?:only\s+)?(?:with|as|using|in(?:\s+the)?\s+form\s+of)\s+(?:(?:a|an|the)\s+)?(?:(?:valid|structured|JSON)\s+)*(?:object|record|payload)(?=\s*(?:[.!?]?\s*$|(?:with|containing|including|having|matching|using|following|conforming(?:\s+to)?)\b))/i;
  const directNamedFormat = /^(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you|you\s+(?:must|shall|should|are\s+required\s+to|have\s+to))\s+)?(?:always\s+)?(?:return|output|emit|provide|produce|send|give(?:\s+me)?)\s+(?:only\s+)?(?:(?:a|an|the)\s+)?(?:(?:valid|strict|raw|compact|well[-\s]?formed|structured)\s+)*(?:YAML(?:\s+(?:object|mapping|document|record|payload|format))?|XML(?:\s+(?:object|mapping|document|record|payload|format))?)(?=\s*(?:[.!?]?\s*$|(?:with|containing|including|having|matching|using|following|conforming(?:\s+to)?)\b))/i;
  const answerWithNamedFormat = /^(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you|you\s+(?:must|shall|should|are\s+required\s+to|have\s+to))\s+)?(?:always\s+)?(?:answer|respond|reply)\s+(?:only\s+)?(?:with|as|using|in(?:\s+the)?\s+form\s+of)\s+(?:(?:a|an|the)\s+)?(?:(?:valid|strict|raw|compact|well[-\s]?formed|structured)\s+)*(?:YAML(?:\s+(?:object|mapping|document|record|payload|format))?|XML(?:\s+(?:object|mapping|document|record|payload|format))?)(?=\s*(?:[.!?]?\s*$|(?:with|containing|including|having|matching|using|following|conforming(?:\s+to)?)\b))/i;
  const resultAsNamedFormat = /^(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you|you\s+(?:must|shall|should|are\s+required\s+to|have\s+to))\s+)?(?:always\s+)?(?:return|output|emit|provide|produce|present|send|give(?:\s+me)?|structure|format|encode|render|represent|serialize)\s+(?:the\s+)?(?:answer|response|result|output|data|object|record|payload)\s+(?:as|into|using|in\s+the\s+form\s+of)\s+(?:(?:a|an)\s+)?(?:(?:valid|strict|raw|compact|well[-\s]?formed|structured)\s+)*(?:YAML|XML)(?=\s*[.!?]?\s*$)/i;
  const resultAsObject = /^(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you|you\s+(?:must|shall|should|are\s+required\s+to|have\s+to))\s+)?(?:always\s+)?(?:return|output|emit|provide|produce|present|send|give(?:\s+me)?|structure|format|encode)\s+(?:the\s+)?(?:answer|response|result|output|data)\s+(?:as|into|in\s+the\s+form\s+of)\s+(?:(?:a|an)\s+)?(?:(?:valid|structured|JSON)\s+)*(?:object|record|payload)(?=\s*(?:[.!?]?\s*$|(?:with|containing|including|having|matching|using|following|conforming(?:\s+to)?)\b))/i;
  const representationAsObject = /^(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you|you\s+(?:must|shall|should|are\s+required\s+to|have\s+to))\s+)?(?:always\s+)?(?:render|represent|serialize)\s+(?:the\s+)?(?:answer|response|result|output|data)\s+(?:as|into|in\s+the\s+form\s+of)\s+(?:(?:a|an)\s+)?(?:(?:valid|structured|JSON)\s+)*(?:object|record|payload)(?=\s*(?:[.!?]?\s*$|(?:with|containing|including|having|matching|using|following|conforming(?:\s+to)?)\b))/i;
  const representationAsSchema = /^(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you|you\s+(?:must|shall|should|are\s+required\s+to|have\s+to))\s+)?(?:always\s+)?(?:render|represent|serialize|format|encode)\s+(?:the\s+)?(?:answer|response|result|output|data)\s+(?:as|into|in\s+the\s+form\s+of)\s+(?:(?:a|an)\s+)?(?:JSON\s+)?schema\b/i;
  const schemaCommand = /^(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you|you\s+(?:must|shall|should|are\s+required\s+to|have\s+to))\s+)?(?:always\s+)?(?:(?:answer|respond|reply|return|output|emit|provide|produce|present|send|give(?:\s+me)?|format|encode)\b[\s\S]{0,80}?\b(?:matching|using|following|conforming\s+to)\s+|(?:use|follow|match|conform\s+to)\s+)(?:(?:this|the|following)\s+)?(?:JSON\s+)?schema\b/i;
  const applySchema = /^(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you|you\s+(?:must|shall|should|are\s+required\s+to|have\s+to))\s+)?(?:always\s+)?apply\s+(?:(?:this|the)\s+)?(?:following\s+)?(?:JSON\s+)?schema\s+(?:to|for)\s+(?:the\s+)?(?:answer|response|reply|result|output|data)\b/i;
  const modalSchema = /^(?:(?:all|every|each|your|the)\s+)?(?:answers?|responses?|replies|outputs?|results?)\s+(?:must|shall|should|are\s+required\s+to|have\s+to)\s+(?:match|follow|use|conform\s+to)\s+(?:(?:this|the|following)\s+)?(?:JSON\s+)?schema\b/i;
  const modalObject = /^(?:(?:all|every|each|your|the)\s+)?(?:answers?|responses?|replies|outputs?|results?)\s+(?:must|shall|should|are\s+required\s+to|have\s+to)\s+be\s+(?:only\s+)?(?:(?:a|an)\s+)?(?:(?:valid|strict|raw|compact|well[-\s]?formed|structured|JSON)\s+)*(?:objects?|records?|payloads?)(?=\s*(?:[.!?]?\s*$|(?:with|containing|including|having|matching|using|following|conforming(?:\s+to)?)\b))/i;
  const describeAsObject = /^(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you|you\s+(?:must|shall|should|are\s+required\s+to|have\s+to))\s+)?describe\b[\s\S]{0,120}\b(?:as|in)\s+(?:(?:a|an)\s+)?(?:object|record|payload)(?=\s*(?:[.!?]?\s*$|(?:with|containing|including|having|matching|using|following|conforming(?:\s+to)?)\b))/i;
  if (directObject.test(source) || answerWithObject.test(source) || directNamedFormat.test(source) || answerWithNamedFormat.test(source) || resultAsNamedFormat.test(source) || resultAsObject.test(source) || representationAsObject.test(source) || representationAsSchema.test(source) || schemaCommand.test(source) || applySchema.test(source) || modalSchema.test(source) || modalObject.test(source) || describeAsObject.test(source)) {
    return true;
  }

  const hasExactMetadataFieldSet = CASCADE_METADATA_FIELD_NAMES.every((field) => (
    new RegExp('(?:^|[^A-Za-z0-9_])' + field + '(?:$|[^A-Za-z0-9_])', 'i').test(source)
  ));
  if (!hasExactMetadataFieldSet) return false;
  const describeCommand = /^(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you|you\s+(?:must|shall|should|are\s+required\s+to|have\s+to))\s+)?describe\b/i.test(source);
  const firstFieldOffset = Math.min(...CASCADE_METADATA_FIELD_NAMES.map(field => source.search(new RegExp('\\b' + field + '\\b', 'i'))));
  const beforeFirstField = source.slice(0, firstFieldOffset);
  const leadingFieldCue = /\b(?:with|containing|including|include)\s+(?:(?:the|these|following|exact)\s+)*(?:(?:fields?|keys?|properties)\s*)?(?::|[-\u2014\u2013])?\s*$/i.test(source.slice(0, firstFieldOffset));
  const directFieldListCommand = /^(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you|you\s+(?:must|shall|should|are\s+required\s+to|have\s+to))\s+)?(?:always\s+)?(?:answer|respond|reply|return|output|emit|provide|produce|present|render|represent|serialize|send|give(?:\s+me)?|format|encode)\s+(?:only\s+|exactly\s+)?(?:(?:(?:the|these|following|exact)\s+)*(?:fields?|keys?|properties)\s*(?::|[-\u2014\u2013])?\s*)?$/i.test(beforeFirstField)
    || /^use\s+(?:(?:only|exactly)\s+)?(?:(?:the|these|following|exact)\s+)*(?:fields?|keys?|properties)\s*(?::|[-\u2014\u2013])?\s*$/i.test(beforeFirstField);
  const responseFieldListContract = /^(?:(?:the|your)\s+)?(?:answer|response|reply|output|result|payload)\s+(?:(?:must|shall|should|is\s+required\s+to|has\s+to)\s+)?(?:contain|include|have|use)\s+(?:(?:only|exactly)\s+)?(?:(?:(?:the|these|following|exact)\s+)*(?:fields?|keys?|properties)\s*)?(?::|[-\u2014\u2013])?\s*$/i.test(beforeFirstField);
  if (directFieldListCommand || responseFieldListContract) return true;

  // A bare structural noun is not enough to establish an output contract.
  // Implementation verbs (create/build/generate/construct) stay neutral unless
  // one of the explicit object/schema contracts above matched first. This keeps
  // “build an object detector with …” and “create a class with …” conversational
  // while preserving descriptive field-shape requests such as “render with …”.
  const implementationCommand = /^(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you|you\s+(?:must|shall|should|are\s+required\s+to|have\s+to))\s+)?(?:always\s+)?(?:create|generate|build|construct)\b/i.test(source);
  if (implementationCommand) return false;
  const descriptiveFieldCommand = /^(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you|you\s+(?:must|shall|should|are\s+required\s+to|have\s+to))\s+)?(?:always\s+)?(?:describe|serialize|render|represent)\b/i.test(source);
  const outputFieldCommand = /^(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you|you\s+(?:must|shall|should|are\s+required\s+to|have\s+to))\s+)?(?:always\s+)?(?:answer|respond|reply|return|output|emit|provide|produce|present|send|give(?:\s+me)?|format|encode|create|generate|build|construct)\b/i.test(source);
  return (describeCommand || descriptiveFieldCommand || outputFieldCommand) && leadingFieldCue;
}

function hasStrongSystemOrDeveloperStructuredOutputContract(messages) {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (message?.role !== 'system' && message?.role !== 'developer') continue;
    const text = textFromMessageContent(message.content);
    if (!text) continue;
    const clauses = text
      .split(/[;；.!?！？。]+/)
      .map(part => part.trim())
      .filter(Boolean);
    for (const clause of clauses) {
      if (isExplicitStructuredShapeRequestText(clause)) return true;
      const explicitJson = isExplicitJsonRequested([{ role: 'user', content: clause }]);
      const pluralModalJson = /^(?:(?:all|every|each|your|the)\s+)?(?:answers?|responses?|replies|outputs?|results?)\s+(?:must|shall|should|are\s+required\s+to|have\s+to)\s+be\s+(?:only\s+)?(?:(?:a|an)\s+)?(?:(?:valid|strict|raw|compact|well[-\s]?formed)\s+)*JSON(?:\s+(?:object|format|response|payload|document|data))?\b/i.test(clause);
      if (pluralModalJson) return true;
      if (!explicitJson) continue;
      const imperative = /^(?:(?:please|kindly)\s+)?(?:always\s+)?(?:answer|respond|reply|return|output|produce|provide|emit|use|format|encode)\b/i.test(clause);
      const modal = /^(?:(?:all|every|each|your|the)\s+)?(?:answers?|responses?|replies|outputs?|results?)\s+(?:must|shall|should|are\s+required\s+to|have\s+to)\b/i.test(clause);
      const standalone = /^(?:only\s+)?(?:(?:valid|strict|raw|compact|well[-\s]?formed)\s+)*JSON(?:\s+(?:object|format|response|payload|document|data))?\s+only$/i.test(clause);
      const chinese = /^(?:请)?(?:始终|总是)?(?:仅|只)?(?:以|用|返回|输出|生成|提供)|^(?:答案|回答|回复|响应|输出|结果)\s*(?:必须|应当|应该|应|须|需)/.test(clause);
      if (imperative || modal || standalone || chinese) return true;
    }
  }
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

  const out = {};
  for (const key of keys) {
    const v = findDeepValue(parsed, key);
    if (v !== undefined) out[key] = v;
  }
  for (const key of keys) {
    const lower = key.toLowerCase();
    if ((lower === 'versionsmatch' || lower === 'versionmatch') && !(key in out)) {
      const read = out.readVersion ?? out.read_version;
      const bash = out.bashVersion ?? out.bash_version;
      if (read != null && bash != null) out[key] = String(read).trim() === String(bash).trim();
    }
  }
  // Nothing projected: the model's own payload is the honest answer. Returning
  // `{}` would erase an answer that simply used different key names, and it is
  // not the projection's job to punish a drift it cannot fix.
  if (!Object.keys(out).length) return cleaned;
  return JSON.stringify(out);
}

/**
 * Does the final payload satisfy the caller's JSON Schema?
 *
 * Returns null when there is nothing to check or the payload conforms, otherwise
 * the first violation. The proxy cannot make the upstream obey a schema (Cascade
 * and the Connect wire have no such control), so the only honest options are to
 * check the answer and say so, or to stay silent — and silence is what let a
 * `strict` request return a body the caller's own validator rejects.
 */
export function structuredOutputViolation(text, schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (typeof text !== 'string' || !text.trim()) return { path: '$', message: 'the response is empty' };
  const parsed = safeJsonParse(extractJsonPayload(text));
  if (parsed === undefined) return { path: '$', message: 'the response is not valid JSON' };
  const verdict = validateJsonSchema(parsed, schema);
  return verdict.ok ? null : { path: verdict.path, message: verdict.message };
}

/** The typed failure returned when a schema-constrained turn does not conform. */
function structuredOutputError(violation) {
  return {
    // 5xx: the request was valid, the upstream answer was not. A 4xx would blame
    // the caller for a schema this proxy accepted.
    status: 502,
    body: {
      error: {
        message: `The model's answer does not conform to the requested JSON Schema (${violation.path}: ${violation.message}).`
          + ' This proxy cannot enforce structured output at the upstream, so it reports the mismatch instead of returning a payload that violates the schema.',
        type: 'server_error',
        code: 'STRUCTURED_OUTPUT_NOT_CONFORMING',
      },
    },
  };
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
export function hasPerUserScope(callerKey) {
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

// Keep both existing key sites gated without moving either snapshot in time.
// The outer key must still precede fallback/body rewrites; the inner fallback
// key must still describe the rewritten body. The cache module's public key
// function remains unconditional for its other callers.
function cacheKey(body, callerKey) {
  if (!isCacheEnabled() || !hasPerUserScope(callerKey)) return null;
  return computeCacheKey(body, callerKey);
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

/**
 * True when a user turn still carries something the model can answer.
 *
 * The pre-dispatch answerability guard deliberately counts ANY non-text part as
 * content (an image IS content). After the supports_images=false strip that
 * assumption no longer holds, so the same question has to be asked again:
 * whitespace-only text and a `content: []` left by stripping are both empty.
 */
function hasAnswerableUserContent(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (typeof part?.text === 'string') return part.text.trim().length > 0;
    return !!part && typeof part === 'object' && !!part.type && part.type !== 'text';
  });
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

/**
 * Commands the user's own text asked for, each tagged with HOW its end was found.
 *
 * `bounded` is the distinction that matters for rewriting a tool call. A backticked
 * span carries a boundary the USER declared, so everything inside it is the command.
 * The backtick-free fallback captures to end-of-line and the boundary is GUESSED, so
 * ordinary prose after the command becomes argv. MEASURED: "The crash: run rm -rf
 * varlog happened in the report" yielded `rm -rf varlog happened in the report`,
 * which a shell runs — deleting `varlog` — with no metacharacter anywhere, so the
 * chaining check cannot see it.
 *
 * An unbacked capture is only `bounded` when sentence punctuation actually ended it,
 * i.e. the user wrote a terminator rather than trailing off into prose.
 */
function extractRequestedBashCommands(text) {
  const src = String(text || '');
  const out = new Map();
  const patterns = [
    { re: /(?:command|run|execute)\s+(?:exactly\s+)?(?::\s*)?`([^`]+)`/gi, backticked: true },
    { re: /(?:command|run|execute)\s+(?:exactly\s+)?(?::\s*)?([^\n]+)/gi, backticked: false },
  ];
  for (const { re, backticked } of patterns) {
    for (const m of src.matchAll(re)) {
      const raw = m[1];
      const trimmed = trimCommandSentence(raw);
      const candidate = shellUnquote(trimmed).trim();
      if (!candidate || !/\s/.test(candidate)) continue;
      const bounded = backticked || trimmed.length < raw.trim().length;
      // A backticked capture wins over a bare one for the same command text.
      if (!out.has(candidate) || bounded) out.set(candidate, { command: candidate, bounded });
    }
  }
  return [...out.values()];
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
  // CPU bound (S1 audit), two layers. The window: the bare-path pattern ran on
  // the full last user message, and the second alternative
  //   [A-Za-z0-9._-]+(?:[\\/][A-Za-z0-9._-]+)*\.[A-Za-z0-9]{1,12}
  // is O(n²) on a long unbroken run of [A-Za-z0-9._-] — the `+` re-tries every
  // split before the mandatory `\.ext` — so a pasted token/base64 blob of a
  // few hundred KiB stalled the event loop for seconds per repair (measured:
  // 128 KiB ≈ 9.8 s). 200_000 matches the bound the NLU entry points already
  // use; a repair source is best-effort, so the head of the message is enough.
  // The caps inside the pattern (a real path segment is ≤255 chars, a real
  // path is far under 64 separators deep) bound the per-position backtracking
  // that made the run quadratic; every realistic path still matches whole.
  const text = recentUserText(messages).slice(0, 200_000);
  if (!text) return '';
  const backtick = [...text.matchAll(/`([^`\r\n]+)`/g)].map(m => m[1]);
  const bare = [...text.matchAll(/((?:[A-Za-z]:[\\/]|\/|~[\\/]|\.{1,2}[\\/])[^"'`<>\s]+|[A-Za-z0-9._-]{1,255}(?:[\\/][A-Za-z0-9._-]{1,255}){0,63}\.[A-Za-z0-9]{1,12})/g)].map(m => m[1]);
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

// Shell metacharacters that start a NEW command rather than continue the
// current one. Prefix repair exists to complete one command's arguments, so an
// "expansion" that introduces any of these is changing what runs, not
// finishing it: `npm install` -> `npm install && curl … | sh` is a different
// act from `node -p` -> `node -p "1+1"`.
const COMMAND_CHAINING_RE = /[;&|><`$\n]|\$\(/;

/**
 * Is `requested` a safe completion of the prefix `current`?
 *
 * Two conditions, both load-bearing, both found by probing rather than review:
 *
 * 1. TOKEN BOUNDARY. `startsWith` alone expands mid-token, which can invert the
 *    very flag that made the model's choice conservative — measured: `rm -i`
 *    (interactive) -> `rm -if /data` (force), and `deploy --dry` ->
 *    `deploy --dry-run=false --prod`. A completion must therefore continue at
 *    whitespace, so the model's last token stays the token that runs.
 * 2. NO NEW COMMAND. See COMMAND_CHAINING_RE. The tail may add arguments; it may
 *    not add a pipeline, a redirect, a separator, or a substitution.
 */
function isSafeCommandCompletion(current, requested) {
  if (requested.length <= current.length || !requested.startsWith(current)) return false;
  const tail = requested.slice(current.length);
  if (!/^\s/.test(tail)) return false;
  return !COMMAND_CHAINING_RE.test(tail);
}

// A decoded Anthropic `document` block, as messages.js marks it on translation.
// Unterminated is matched too: a truncated attachment loses its closing marker, and
// an unclosed attachment must not become readable as instruction text.
const DOCUMENT_SPAN_RE = /\[document:[^\]\n]*\]\n?([\s\S]*?)(?:\n?\[\/document\]|$)/g;

/**
 * Blank out attachment regions in a user turn.
 *
 * `latestRealUserText` skips a whole message when it is a synthetic `<tool_result>`
 * carrier, but that shape cannot work for attachments: messages.js joins a document
 * block and the caller's OWN words into one message, so skipping the message would
 * discard the genuine instruction along with the attachment. Blanking keeps the
 * instruction readable and removes only the attachment — and preserves length, so
 * every later regex offset stays valid, the same reason maskNonActionableRegions
 * blanks instead of deleting.
 */
function maskDocumentSpans(text) {
  return String(text).replace(DOCUMENT_SPAN_RE, m => m.replace(/[^\n]/g, ' '));
}

export function repairToolCallArguments(tc, messages) {
  tc = repairReadToolCallArguments(tc, messages);
  if (!tc || String(tc.name || '').toLowerCase() !== 'bash' || typeof tc.argumentsJson !== 'string') return tc;
  let args;
  try { args = JSON.parse(tc.argumentsJson); } catch { return tc; }
  if (!args || typeof args.command !== 'string') return tc;
  const current = args.command.trim();
  if (!current) return tc;
  // `latestRealUserText`, NOT `recentUserText`: the latter returns ANY trailing
  // role:'user' message, and clients that carry tool results as synthetic
  // `<tool_result>` user turns therefore made TOOL OUTPUT the command source —
  // a fetched page or a read file deciding what the client executes. MEASURED:
  // a `<tool_result>` turn containing "run `ls -la /etc/shadow`" expanded the
  // model's `ls -la` to that path. latestRealUserText skips those turns (see its
  // `/^\s*<tool_result\b/` test), which is the same reader the sibling recovery
  // paths in this file already use.
  //
  // Then mask fenced and negated regions. "Never execute `rm -rf /`" is a command
  // the user named in order to FORBID it; reading it as the intended command turns
  // a prohibition into an instruction. Same masking the NLU layer uses, so the two
  // cannot drift apart on what counts as actionable.
  //
  // CPU bound (S1 audit): maskNonActionableRegions rebuilds the string once per
  // masked region — K negated clauses or fences on an n-char text is O(K×n) —
  // and this was the only caller feeding it untruncated text. The NLU entry
  // points cap at 200_000 for exactly this reason (intent-extractor.js
  // detectToolIntentInNarrative / extractIntentFromNarrative); a repair source
  // is best-effort, so the same head-of-message window applies here.
  const source = maskNonActionableRegions(maskDocumentSpans(
    latestRealUserText(messages).slice(0, 200_000)));
  for (const { command: requested, bounded } of extractRequestedBashCommands(source)) {
    if (bounded && isSafeCommandCompletion(current, requested)) {
      // Every surviving expansion is logged, because one shape CANNOT be
      // decided here and must stay visible instead of looking handled.
      //
      // `ls -la` -> `ls -la /etc/shadow` is byte-for-byte isomorphic to the
      // legitimate `node -p` -> `node -p "1+1"`: same token boundary, same
      // absence of chaining. They differ only in whether the user's message was
      // an INSTRUCTION or PASTED CONTENT, which is not a property of the string.
      // A heuristic guessing between them would be indefensible and — worse —
      // would read as if the case were covered. So the residual is reported
      // rather than guessed, and this line is the only thing that makes a
      // command the model did not choose auditable after the fact.
      log.warn(`Chat: bash prefix repair rewrote the model's command — model=${JSON.stringify(current)} served=${JSON.stringify(requested)}`);
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
const CALLER_ENV_PATH_TAIL = `(?:[\\/~]|[A-Za-z]:\\\\)[^\\s\`'"<>\\n.,;)]+`;
// Adjective slot for "Working directory" — Claude Code 2.x uses
// "Primary working directory: D:\..." instead of the canonical
// "Working directory: ...". Other clients use "Current" / "Initial" /
// "Default" / "Active" / "Project" similarly. Optional, matched
// case-insensitively. (#106 / #107 follow-up: the user's 26 KB Claude
// Code system prompt mentions "current working directory" mid-prose
// first, then later has the actual `- Primary working directory: D:\...`
// bullet — old regex only allowed the canonical key so the bullet
// never matched and env never lifted.)
const CALLER_ENV_ADJ = `(?:Primary|Current|Initial|Default|Active|Project|My)\\s+`;
const CALLER_ENV_PATTERNS = [
  ['cwd', new RegExp(
    // Form (a): line-anchored key/value, optional adjective prefix
    `(?:^|\\n)\\s*(?:[-*]\\s+)?(?:${CALLER_ENV_ADJ})?(?:Working\\s+directory|cwd)\\s*[:=]\\s*\`?(${CALLER_ENV_PATH_TAIL})\`?` +
    // Form (b): prose "current working directory is /path" (adjacent path)
    `|(?:current\\s+working\\s+directory(?:\\s+is)?)\\s*[:=]?\\s*\`?(${CALLER_ENV_PATH_TAIL})\`?` +
    // Form (c): Codex / XML-style <cwd>/path/</cwd> tags (no :/= separator)
    `|<cwd>\\s*(${CALLER_ENV_PATH_TAIL})\\s*</cwd>`,
    'gi'
  ), (v) => `- Working directory: ${v}`],
  // Git repo: accept "Is directory a git repo" (Claude Code <2.x) AND
  // "Is a git repository" / "Is git repo" (Claude Code 2.x).
  ['git', /(?:^|\n)\s*(?:[-*]\s+)?Is(?:\s+(?:directory\s+)?(?:a\s+)?)git\s+repo(?:sitory)?\s*[:=]\s*([^\n<]+)/i, (v) => `- Is the directory a git repo: ${v}`],
  ['platform', /(?:^|\n)\s*(?:[-*]\s+)?Platform\s*[:=]\s*([^\n<]+)/i, (v) => `- Platform: ${v}`],
  ['os', /(?:^|\n)\s*(?:[-*]\s+)?OS\s+[Vv]ersion\s*[:=]\s*([^\n<]+)/i, (v) => `- OS version: ${v}`],
];

const CALLER_ENV_FILE_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|json|jsonc|md|mdx|py|pyc|go|rs|java|kt|swift|cpp|cc|cxx|c|h|hpp|html?|css|scss|sass|less|yaml|yml|toml|ini|cfg|conf|sh|bash|zsh|fish|ps1|bat|cmd|exe|dll|so|dylib|zip|tar|gz|bz2|xz|7z|rar|png|jpe?g|gif|webp|svg|ico|mp[34]|wav|flac|ogg|webm|mov|avi|mkv|pdf|docx?|xlsx?|pptx?|csv|tsv|sql|db|sqlite|log|lock|map|min\.js|min\.css)$/i;
const CALLER_ENV_BULLET = /^[\s]*[-*•]\s+`?((?:[A-Za-z]:[\\/]|\/[A-Za-z]|~[\\/])[^\s`'"<>\n]+)`?\s*$/gm;

export function extractCallerEnvironment(messages) {
  if (!Array.isArray(messages)) return '';
  const seen = new Set();
  const out = [];

  for (const m of messages) {
    if (!m) continue;
    let content;
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n');
    else continue;
    if (!content) continue;

    for (const [key, re, fmt] of CALLER_ENV_PATTERNS) {
      if (seen.has(key)) continue;
      // For the cwd pattern (global flag), iterate matches and pick the
      // first one that actually has a non-empty captured path. The earlier
      // matches in a long system prompt may be prose mentions like
      // "...and the current working directory." with no adjacent path
      // because the path lives in a later bullet — we must not stop at
      // the first textual hit.
      if (re.global) {
        // matchAll clones the expression and copies lastIndex. Reset the
        // shared source before cloning; early breaks cannot poison later calls.
        re.lastIndex = 0;
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
    if (seen.size === CALLER_ENV_PATTERNS.length) break;
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
  for (const m of messages) {
    if (m?.role !== 'system') continue;
    let content;
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n');
    else continue;
    if (!content) continue;
    // matchAll uses a clone, including its starting index. No exec/test call
    // advances this shared global expression; reset also makes that invariant explicit.
    CALLER_ENV_BULLET.lastIndex = 0;
    for (const match of content.matchAll(CALLER_ENV_BULLET)) {
      const cand = match[1];
      if (!cand || cand.length < 5) continue;
      if (CALLER_ENV_FILE_EXT.test(cand)) continue;
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

  // Pass-2 strip: remove every `<system-reminder>…</system-reminder>` pair
  // with a cursor-advancing scan. The regex equivalent
  // `content.replace(/<system-reminder\b[\s\S]*?<\/system-reminder>\s*/gi,'')`
  // is O(K×n) — each of K unterminated open tags makes the lazy `[\s\S]*?`
  // re-search the whole tail for a closer that is not there (measured: 512 KiB
  // of bare opens ≈ 2.1 s of synchronous event-loop time, ~4× per doubling).
  // Offsets only move forward, so this stays O(n) at any input size. Output is
  // byte-identical to the regex: a pair drops its span plus the whitespace
  // after the closer; an open with no closer keeps the tail.
  const REMINDER_OPEN = /<system-reminder\b/gi;
  const REMINDER_CLOSE = /<\/system-reminder>\s*/gi;
  const stripSystemReminderBlocks = (text) => {
    let out = '';
    let cursor = 0;
    for (;;) {
      REMINDER_OPEN.lastIndex = cursor;
      const open = REMINDER_OPEN.exec(text);
      if (!open) break;
      REMINDER_CLOSE.lastIndex = open.index + open[0].length;
      const close = REMINDER_CLOSE.exec(text);
      if (!close) break;
      out += text.slice(cursor, open.index);
      cursor = close.index + close[0].length;
    }
    return out + text.slice(cursor);
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
    const stripped = stripSystemReminderBlocks(content);
    const wrapped = tryMatch(stripped.slice(0, 500));
    if (wrapped) return wrapped;
  }
  return '';
}

// Rough token estimate (~4 chars/token). Used only to populate the
// OpenAI-compatible `usage.prompt_tokens_details.cached_tokens` field so
// upstream billing/dashboards (new-api) can recognise our local cache hits.
// V-14: the same chars/4 heuristic estimateTokens/buildUsageBody already bill
// with, reused for the local output cap so "max_tokens" means one thing here.
const OUTPUT_CHARS_PER_TOKEN = 4;

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

// Inject a tool-description preamble into the system prompt of a message
// list. DEVIN_CONNECT has no proto tool_calling_section slot, so the
// description-only preamble (buildToolPreambleForProto with
// nativeStructured:true — descriptions without the text-emulation protocol
// header) must ride the system prompt to give the model tool-selection
// context the stripped native #10 ToolDef cannot. If a system message
// already exists the preamble is prepended (separated by a blank line); if
// not, a new system message is inserted at the front. The list is not
// mutated in place — a shallow copy is returned so the caller's `messages`
// reference stays stable.
export function injectPreambleIntoSystemPrompt(messages, preamble) {
  if (!preamble || typeof preamble !== 'string' || !preamble.trim()) return messages;
  if (!Array.isArray(messages)) return messages;
  const idx = messages.findIndex(m => m?.role === 'system');
  if (idx >= 0) {
    const cur = messages[idx];
    const curContent = typeof cur.content === 'string' ? cur.content
      : Array.isArray(cur.content) ? cur.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n')
      : '';
    const merged = curContent && curContent.trim()
      ? `${preamble.trim()}\n\n${curContent}`
      : preamble.trim();
    const out = messages.slice();
    out[idx] = { ...cur, content: merged };
    return out;
  }
  return [{ role: 'system', content: preamble.trim() }, ...messages];
}

// The tier builders raise this to say "I already proved I am over the caller's cap;
// drop me instead of measuring me". Matched by NAME rather than by an imported class so
// the ladder keeps working against a builder from either side of the change.
const isTierOverBudgetSignal = (err) => err?.name === 'SchemaCompactTierDropped';

export function applyToolPreambleBudget(tools, toolChoice, callerEnv = '', opts = {}) {
  const modelKey = opts.modelKey || null;
  const provider = opts.provider || null;
  const route = opts.route || null;
  const nativeStructured = opts.nativeStructured === true;
  const softBytes = opts.softBytes ?? parseInt(process.env.TOOL_PREAMBLE_SOFT_BYTES || '24000', 10);
  const hardBytes = opts.hardBytes ?? parseInt(process.env.TOOL_PREAMBLE_HARD_BYTES || '48000', 10);
  const tierOpts = nativeStructured ? { nativeStructured: true } : {};
  // The byte cap the schema-compact builder may stop at, derived HERE so it cannot
  // drift from the caps this function actually enforces. A tier is rejected once its
  // length exceeds EITHER cap, so past min(softBytes, hardBytes) its rejection is
  // already certain and every further node the `$ref` inliner walks is work on a
  // string that gets thrown away — for a `$ref` diamond, megabytes of it, on the
  // one thread every other tenant shares. With the shipped defaults
  // (soft=24000 < hard=48000) this bound is the soft cap. It must be the MINIMUM of
  // the two, not the maximum: the builder prunes the string it returns, so the bound
  // has to be the first cap at which rejection is already certain, and a tier
  // between the caps is still rejected by the check below.
  const abortAtBytes = Math.min(softBytes, hardBytes);
  const tiers = [
    { tier: 'full', build: buildToolPreambleForProto },
    { tier: 'schema-compact', build: buildSchemaCompactToolPreambleForProto, opts: { abortAtBytes } },
    { tier: 'skinny', build: buildSkinnyToolPreambleForProto },
    { tier: 'names-only', build: buildCompactToolPreambleForProto },
  ];
  const full = tiers[0].build(tools || [], toolChoice, callerEnv, modelKey, provider, route, tierOpts);
  if (!full) {
    return { ok: true, preamble: '', fullBytes: 0, finalBytes: 0, compacted: false, tier: 'empty', softBytes, hardBytes };
  }
  const fullBytes = Buffer.byteLength(full, 'utf8');

  // Walk the tiers from largest to smallest; pick the first one that fits
  // under the soft cap. If none fit (extreme tool counts), fall through to
  // names-only and let the hard-cap check decide whether to reject. A tier that
  // reports it was PROVABLY over the cap is dropped unseen, which is the same
  // decision this loop would have reached by measuring it.
  let chosen = { tier: 'full', preamble: full, bytes: fullBytes };
  for (const t of tiers) {
    if (t.tier === 'full') {
      if (fullBytes <= softBytes) break;
      continue;
    }
    let text;
    try {
      text = t.build(tools || [], toolChoice, callerEnv, modelKey, provider, route, { ...tierOpts, ...t.opts });
    } catch (err) {
      if (isTierOverBudgetSignal(err)) continue;
      throw err;
    }
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

/**
 * Re-exported from runtime-config so this module's existing importers keep working. The
 * definition moved there because three modules need the same answer (Cascade here, connect
 * in devin-connect.js, ACP in special-agent.js) and each had been deriving it separately or
 * not at all.
 */
export { strictUsageTotal };

/**
 * `fullBillableTokens` used to live here. It moved to auth.js, beside recordAccountSpend —
 * its only caller — because the copy here had NO production caller while recordAccountSpend
 * re-implemented the same arithmetic inline. Two copies of a billing calculation is one too
 * many, and a mutation guard over the unused copy was protecting nothing on the wire.
 */

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
    //
    // This deliberately breaks OpenAI's arithmetic identity
    // (total == prompt + completion) whenever cache_write > 0, and #118 chose that
    // on purpose: the alternative was cache_write inside prompt_tokens, which made
    // relays bill it as ordinary input and burned trial quotas in hours.
    //
    // A client that VALIDATES the identity sees a violation, so
    // WINDSURFAPI_STRICT_USAGE_TOTAL=1 restores it. Default stays 0 because the
    // failure modes are not symmetric: the identity break is cosmetic for almost
    // every consumer, while dropping cache_write from the total under-reports real
    // spend — a relay metering on total_tokens would silently undercharge. Cosmetic
    // beats financial, so spec-strictness is the opt-in.
    // Read live rather than snapshotted at import: a module-level const here cannot
    // be flipped by a test, which is how a previous flag became untestable.
    const totalTokens = strictUsageTotal()
      ? promptTokens + outputTokens
      : promptTokens + outputTokens + cacheWrite;
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
//
// O3: one-time notice when session continuity is OFF. The reuse-ON path has always
// logged its session_id; a default deployment (reuse OFF) logged nothing, so the
// 7/7-fresh-id capture in evidence/ClientSandboxes.md §5.3 was invisible from the
// logs. Info once per process + debug per request keeps the signal without noise.
let _connectSessionSourceNoted = false;
let _connectDeps = {
  toChatCompletion: _toChatCompletion,
  streamChatCompletion: _streamChatCompletion,
  // assignModel is here purely so the router hop is testable. It performs a real
  // unaryCall, so without a seam the ONLY way to reach the post-hop state is a paid
  // account — which left the router branch of the degrade-honesty contract unguarded
  // (a mutation swapping connectParams.model back to `selector` passed every test).
  assignModel: _assignModel,
  // Same seam for the recovery side: the handler must forward the request's
  // AbortSignal into reLoginAccount so a caller that went away stops waiting for
  // a global login slot. Without this seam a test can only observe the real
  // (credential-gated) auth module, where the call is a no-op.
  reLoginAccount: _reLoginAccount,
};
async function toChatCompletion(...args) {
  const out = await _connectDeps.toChatCompletion(...args);
  if (out?.body) applyChatCompletionCompatFields(out.body);
  return out;
}
function streamChatCompletion(...args) { return _connectDeps.streamChatCompletion(...args); }
function assignModel(...args) { return _connectDeps.assignModel(...args); }
function reLoginAccount(...args) { return _connectDeps.reLoginAccount(...args); }
export function __setConnectDeps(overrides = {}) { _connectDeps = { ..._connectDeps, ...overrides }; }
// The "hint dropped" notice is logged once per process (see the connect-flow gate in
// handleChatCompletions), so tests need to re-arm it to assert the line.
let _parallelHintWarned = false;
export function __resetParallelToolCallsHintWarn() { _parallelHintWarned = false; }
export function __resetConnectDeps() {
  _connectDeps = {
    toChatCompletion: _toChatCompletion,
    streamChatCompletion: _streamChatCompletion,
    assignModel: _assignModel,
    reLoginAccount: _reLoginAccount,
  };
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
async function acquireConnectAccount(signal, callerKey, selector = null, budget = null) {
  // Empty pool (single-token deploy: only WINDSURF_API_KEY/DEVIN_CONNECT_TOKEN
  // in env) → there is nothing to wait for. Return null immediately for the
  // env-token fallback instead of blocking QUEUE_MAX_WAIT_MS on every request.
  if (getAccountCount().total === 0) return null;
  const tried = [];
  const acct = await waitForAccount(tried, signal, budgetWaitMs(budget, QUEUE_MAX_WAIT_MS), null, callerKey, selector);
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
// untried account is selectable after a bounded failover pause, or give up.
// This helper is never called for the initial, successful acquisition.
async function acquireConnectFailover(triedKeys, signal, callerKey, selector = null, budget = null) {
  if (signal?.aborted) return null;
  // Match Cascade's 500ms first backoff, but keep a fixed per-hop budget.
  // Wait before acquisition so an idle timer never holds an account reservation.
  // The request budget can only shorten the wait; a hop that would start after
  // the deadline is refused instead.
  const waitMs = budget ? budget.waitMs(500) : 500;
  if (waitMs <= 0) return null;
  await new Promise(resolve => {
    const timer = setTimeout(finish, waitMs);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
  if (signal?.aborted) return null;
  return getApiKey(triedKeys, null, callerKey, selector);
}

// Prompt-cache affinity for the DEVIN_CONNECT path.
//
// setStickyBinding is otherwise only reached from the two Cascade success paths,
// where it exists so a resumed cascade_id keeps its account. The connect path
// never wrote a binding, so on a DEVIN_CONNECT deployment STICKY_SESSION_ENABLED=1
// was a no-op: getApiKey's lookup ran on every turn and always missed, and the
// candidate sort (which ends on `lastUsed` ascending) then handed each turn of a
// conversation to a DIFFERENT account on purpose.
//
// Upstream prompt caches are per-account. Replaying an identical payload on a
// second account is a fresh cache WRITE, not a read — measured on a paid Teams
// account, three accounts in a row each reported metadata #7 tag 4 (write) for
// the same body, while a repeat on the FIRST account reported tag 5 (read).
// Because a write costs roughly an order of magnitude more than a read, rotating
// mid-conversation re-pays for the whole accumulated context every turn.
//
// The connect path always acquires with modelKey=null (acquireConnectAccount and
// acquireConnectFailover both pass null), so the binding MUST be written with null in
// the MODEL dimension too, or it would silently never resolve on lookup.
//
// The SELECTOR is a separate, third dimension. Writing it is what gives a caller
// per-selector affinity: with only (caller, modelKey=null) every connect selector of
// one caller shared the single slot `callerKey\0*`, so on a pool partitioned by
// entitlement a caller alternating between a free-reachable and a paid selector
// cleared and re-created that slot every request and got zero affinity. getApiKey
// already receives the selector, so both sides agree.
export function bindConnectSticky(callerKey, acct, selector = null) {
  if (!callerKey || !acct?.id || !isStickyEnabled()) return;
  // Same per-user-scope gate every Cascade sticky write sits behind (via
  // reuseEnabled → !sharedApiKeyNoScope, chat.js hasPerUserScope / SEC-W2):
  // a bare `api:<hash>` or guessed `:client:` callerKey is N end users behind
  // one key, not one conversation. Binding that collapses ALL of a shared-key
  // deployment's traffic into one slot — every request funnels onto a single
  // account until it saturates, then the whole herd migrates and mass
  // re-writes every conversation's prompt cache at once. Single-tenant
  // self-hosts opt in via WINDSURFAPI_SINGLE_TENANT_CACHE=1, exactly like
  // cascade reuse.
  if (!hasPerUserScope(callerKey)) return;
  try {
    setStickyBinding(callerKey, null, acct.id, currentApiKeyForId(acct.id, acct.apiKey), selector);
  } catch { /* affinity is best-effort — never fail a served request over it */ }
}

// How many times a single DEVIN_CONNECT request may hop to a fresh pooled
// account after a dead-token failure. 0 disables failover (same-account
// re-login still applies). Default 2 so a request survives a couple of stale
// session tokens without fanning out across the whole pool.
function connectFailoverMax(env = process.env) {
  const raw = Number(env.DEVIN_CONNECT_FAILOVER_MAX);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2;
}

// True when an error is an AbortError (client disconnect / server shutdown).
// Both name and code are checked because Node's AbortController sets `name` on
// errors it throws, while fetch/undici sometimes only sets `code: 'ABORT_ERR'`.
//
// The `/aborted/i` message arm exists for the undici shapes that carry NEITHER
// marker, but on its own it also swallowed genuine upstream faults:
// classifyUpstreamError puts the raw upstream body into `.message` and passes
// unknown gRPC codes through verbatim, so a real gRPC `aborted` trailer — or any
// 5xx / middlebox body containing the word — read as a client disconnect. The
// caller then returned 499 client_disconnect to a client that never left,
// suppressed cross-account failover, and recorded no cooldown or health signal.
// So the message arm is only consulted when the error carries NO upstream
// verdict: any code at all (the UPPER_SNAKE vocabulary classifyUpstreamError
// emits, a Node socket code, or a lowercase gRPC status) means the upstream
// spoke and this is not a local abort.
function hasUpstreamVerdict(err) {
  const code = err?.code;
  if (typeof code !== 'string' || !code) return false;
  return code !== 'ABORT_ERR';
}

function isAbortError(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return true;
  if (hasUpstreamVerdict(err)) return false;
  return /aborted/i.test(err.message);
}

// Pair with acquireConnectAccount on every exit path. Records billing/stats and
// returns the account to the pool. `err` null ⇒ success.
// Upstream-stall / transport / configuration faults: NOT account health problems.
// They are recorded as health-window events (so a genuinely sick account is still
// de-prioritized by selection) but never charge the errorCount budget that evicts
// an account. Kept as a named set rather than more `else if` arms so
// test/connect-error-blame.test.js can assert the whole classification from source
// — the `else reportError` fallthrough is silent, and every code that landed there
// by accident (STREAM_TRUNCATED, then these three) evicted healthy accounts.
//
// Two further families were sitting in that same fallthrough, and NEITHER is
// visible to a guard that only enumerates classifyUpstreamError's own UPPER_SNAKE
// literals — which is why v3.9.6's enumeration of "all 12 codes" missed them:
//
//   1. Node socket codes. They arrive with `.code` already set and travel through
//      the connect generator untouched, so no literal in devin-connect.js names
//      them. For THESE, devin-connect.js's own RETRYABLE_CODES already treats them
//      as retryable transport conditions, so blaming the account contradicts the
//      transport layer's own verdict.
//   2. LOWERCASE gRPC statuses that classifyUpstreamError PASSES THROUGH. Its last
//      line is `code: code || 'UPSTREAM_ERROR'`, so any status without a named
//      branch — `aborted`, `cancelled`, `deadline_exceeded` — exits verbatim.
//      Note the retryability argument above does NOT extend to these: measured,
//      isRetryable is false for all three (only `unavailable` is in
//      RETRYABLE_CODES). They belong here for a different reason — every one of
//      them describes the CALL or the UPSTREAM, not the caller's credentials.
//      `aborted` is a concurrency conflict, `cancelled` means someone hung up,
//      `deadline_exceeded` means it took too long. None of them is evidence that
//      this account's session token is bad, which is the only thing the error
//      budget should be measuring.
//
// Measured with a healthy peer seeded (so lastAccountExempt cannot mask it): three
// calls of ECONNRESET / ETIMEDOUT / EPIPE / ECONNREFUSED, and three of the
// lowercase `aborted` / `cancelled` / `deadline_exceeded`, each flipped a healthy
// account to status='error' with persisted backoff. An upstream shedding load with
// gRPC statuses walks the pool offline three faults at a time.
//
// `unavailable` is listed for completeness even though classifyUpstreamError maps
// it to CAPACITY before it can reach here — if that mapping is ever narrowed, the
// raw status must not fall through to an eviction.
// The set's test is "is this the ACCOUNT's fault?", not "is it a transport error"
// — NO_TOKEN has always been a configuration fault, and the request-shaped gRPC
// statuses below join it on the same reasoning: a malformed or unsupported request
// says nothing about the health of the session token that carried it. Leaving them
// in the fallthrough meant a client looping on a bad request could walk the pool
// offline three calls at a time, which is the failure mode the CONTENT_BLOCKED and
// UPSTREAM_ERROR exemptions were added to remove.
//
// `unauthenticated` is deliberately NOT here: it IS an account fault, and
// classifyUpstreamError now claims it explicitly so it gets the UNAUTHORIZED arm's
// re-login attempt rather than a bare eviction.
const TRANSPORT_FAULT_CODES = new Set([
  'TIMEOUT', 'DEADLINE_EXCEEDED', 'NO_TOKEN',
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH',
  'ENETUNREACH', 'EAI_AGAIN', 'ECONNABORTED',
  // Passed-through gRPC statuses: upstream load-shedding / stalls.
  'unavailable', 'aborted', 'cancelled', 'deadline_exceeded', 'internal',
  'unknown', 'data_loss',
  // Passed-through gRPC statuses: faults in the REQUEST, not in the account.
  'invalid_argument', 'not_found', 'already_exists', 'failed_precondition',
  'out_of_range', 'unimplemented',
]);

// An unclassified code is a GAP in the classification, not a verdict about the
// account (see the deny-by-default arm in finalizeConnectAccount). The counter is
// the dashboard signal; this line is the diagnostic that names the code. Bounded
// per process like the unknown-stop-reason log: a hostile or broken upstream that
// repeats one novel code must not turn a gap into a log flood.
const MAX_UNCLASSIFIED_FAULT_LOGS = 16;
const _unclassifiedFaultsLogged = new Set();
function noteUnclassifiedConnectFault(err) {
  const raw = typeof err?.code === 'string' && err.code ? err.code : '<no-code>';
  if (_unclassifiedFaultsLogged.has(raw) || _unclassifiedFaultsLogged.size >= MAX_UNCLASSIFIED_FAULT_LOGS) return;
  _unclassifiedFaultsLogged.add(raw);
  try {
    log.warn(`Chat: unclassified connect fault code=${safeLogValue(raw)} — treated as transport-class (health-window only); add an explicit blame arm if this is an account fault`);
  } catch { /* diagnostics must never fail the release path */ }
}

// `abortedHint` lets a caller say "the client went away" WITHOUT discarding the
// upstream error it was holding. The callers used to substitute a synthetic
// AbortError for the real one on disconnect, which erased the upstream verdict
// (e.g. RATE_LIMITED + resetMs) before this function could act on it.
//
// `credentialKey` is the credential the attempt ACTUALLY presented (a re-login
// retry presents a different one than the acquire-time snapshot). It defaults
// to acct.apiKey for the normal case.
//
// True when the credential an attempt presented is still the pool's current one
// for that account. An old credential's verdict must not be written onto the new
// credential: a 401 from a retired key must not charge the fresh key's error
// budget, trigger another re-login, or clear its errors on an old-key success.
// This is the same epoch test auth.js already uses for credit refreshes and
// catalog syncs; the immutable id is what makes the account findable at all.
function credentialEpochCurrent(acct, credentialKey = null) {
  if (!acct?.id) return true;
  const attempted = credentialKey || acct.apiKey;
  if (!attempted) return true;
  return currentApiKeyForId(acct.id, attempted) === attempted;
}

// Connection-shaped failures for the per-account history. Deliberately NOT the
// full TRANSPORT_FAULT_CODES set: that one answers "is this the ACCOUNT's
// fault?" and includes request-shaped codes (NO_TOKEN, invalid_argument, …)
// that are not connection failures. These are the codes where the socket or the
// upstream call itself failed.
const CONNECTION_FAULT_CODES = new Set([
  'TIMEOUT', 'DEADLINE_EXCEEDED',
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH',
  'ENETUNREACH', 'EAI_AGAIN', 'ECONNABORTED',
  'unavailable', 'aborted', 'cancelled', 'deadline_exceeded',
]);

// Classify a failed CONNECT attempt for the per-account history. The ring keeps
// a short machine label plus the HTTP-ish status the client saw; upstream
// message text never enters it (it can carry request content or headers).
function connectAttemptOutcome(err, aborted) {
  if (aborted) return { outcome: 'client_abort', status: 499 };
  const code = typeof err?.code === 'string' ? err.code : '';
  if (code === 'RATE_LIMITED') return { outcome: 'rate_limited', status: 429 };
  if (code === 'QUOTA_EXHAUSTED') return { outcome: 'quota_exhausted', status: 402 };
  if (CONNECTION_FAULT_CODES.has(code)) {
    // A stalled socket is a connection failure, not a model verdict. The two
    // timeout codes carry the 504 the HTTP mapper gives them; every other
    // connection code is a generic upstream/connection failure (502).
    return { outcome: 'connection_error', status: (code === 'TIMEOUT' || code === 'DEADLINE_EXCEEDED') ? 504 : 502 };
  }
  return { outcome: 'upstream_error', status: connectErrorToHttp(code).status };
}

// `model` is the ATTRIBUTION name: the dashboard request row (and the token
// row recorded next to it) files this attempt under it. The connect path passes
// the served display name (connectDisplayModel) so both rows land in the same
// bucket as the response's `model` field — a stream turn and a non-stream turn
// of the same request must not split across two model buckets (P2-6).
export function finalizeConnectAccount(acct, { model, selector = null, startTime, err, aborted: abortedHint = false, signal = null, credentialKey = null }) {
  if (!acct) {
    // env-token path: still record the request for dashboard totals.
    recordRequest(model, !err, Date.now() - startTime, null);
    return;
  }
  // The attempt belongs to the IMMUTABLE id, never to the apiKey snapshot. An
  // account can be removed while its request is still in flight (dashboard
  // delete / replace), and the replacement may legitimately be created with the
  // SAME synthetic key. `currentApiKeyForId(id, fallback)` cannot express
  // "gone" — its fallback exists for the env-token shape — so a removed id
  // would re-key every mark*/report* below onto whoever now holds that key:
  // A's late UNAUTHORIZED charged B's error budget, and a late success cleared
  // B's errors. Resolve the pool account FIRST and drop the outcome when it is
  // gone; a removed identity's verdict belongs to nobody.
  const live = acct.id ? getAccountInternal(acct.id) : null;
  if (acct.id && !live) {
    // The request itself still happened — record it globally with no account
    // attribution, exactly like the env-token path above.
    recordRequest(model, !err, Date.now() - startTime, null);
    return;
  }
  // REF-1/REF-2: acct.apiKey is a snapshot taken at acquire time. A background
  // re-login (UNAUTHORIZED path below) swaps the pool object's apiKey in place
  // without touching this snapshot, so every mark*/report*/release keyed on the
  // stale snapshot would silently no-op — leaking the in-flight slot and losing
  // the cooldown/health signal. Resolve the account's CURRENT apiKey via its
  // immutable id (a snapshot with no id keeps the snapshot key), and
  // release by id so the counter always finds its account.
  //
  // Credential-scoped verdicts are the exception: `apiKey` is the live key and
  // exists so account-level cooldowns still land after a rotation (REF-2), but
  // an auth/health verdict belongs to the credential that produced it. When the
  // attempt presented a key the pool has since replaced, charging the live key
  // would penalize the NEW epoch for the OLD one's failure.
  const apiKey = currentApiKeyForId(acct.id, acct.apiKey);
  const credentialCurrent = credentialEpochCurrent(acct, credentialKey);
  if (err) {
    // A client-side abort (caller disconnected) is not an account fault — release
    // without penalizing the account's error budget.
    //
    // But "no penalty" is NOT "no cooldown". This arm used to sit FIRST in the
    // chain, so a disconnect that raced an in-flight upstream 429 skipped the
    // whole classification below — including the account-wide reset window that
    // the RATE_LIMITED arm exists to apply. The upstream had already declared a
    // throttle (measured: a 3h window dropped to 0, account immediately
    // re-selectable), and agent clients cancel mid-turn constantly, so every
    // cancelled turn re-armed an already-throttled account and the pool kept
    // hammering the upstream velocity limiter.
    //
    // Split the two notions: an upstream-declared COOLDOWN is a fact about the
    // account or model that stays true regardless of whether our client is still
    // listening, so those arms run first and unconditionally. The HEALTH/penalty
    // arms below (errorCount eviction, re-login, internal-error streaks) are
    // judgements about whether the account misbehaved, and a client disconnect is
    // no evidence of that — those stay exempt.
    const aborted = abortedHint || isAbortError(err);
    // Per-account request history: a failed attempt is attributed to the account
    // that was asked to serve it, at zero cost. The early returns above are the
    // no-attribution cases (env token / account removed) and deliberately write
    // nothing — an unattributed failure must not be pinned on a replacement that
    // happens to hold the same synthetic key. Best-effort: the ring must never
    // fail the release path.
    try {
      const verdict = connectAttemptOutcome(err, aborted);
      recordAccountAttempt(live, {
        model,
        outcome: verdict.outcome,
        status: verdict.status,
        attemptId: acct.reservationTimestamp,
      });
    } catch { /* history is best-effort */ }
    if (err.code === 'QUOTA_EXHAUSTED') {
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
    else if (err.code === 'RATE_LIMITED') {
      // Honor an explicit upstream reset window when the classifier parsed one
      // (e.g. "message rate limit ... Resets in: 3h0m0s" → err.resetMs). Scope it
      // to the model/selector that was throttled, NOT the account: a 429 for one
      // model is no evidence about the others, and the old account-wide write
      // benched a healthy account for every other model it could still serve.
      // The old account-wide choice existed because connect selection calls
      // getApiKey(triedKeys, null, ...) with modelKey=null and
      // isRateLimitedForModel only consults _modelRateLimits for a truthy key —
      // so a model-scoped cooldown used to be structurally invisible. That
      // premise is gone: isCooledForRequest also checks the connect-selector
      // dimension, which is exactly what this write keys on (`selector || model`,
      // the same dimension the CAPACITY arm below uses). Falls back to a burst
      // cooldown when no window was given (generic 429 with no retry-after);
      // F2: that burst duration is the `rlBurstMs` tunable (default 300000 =
      // the historical 5min).
      if (Number.isFinite(err.resetMs) && err.resetMs > 0) {
        markRateLimited(apiKey, err.resetMs, selector || model, 'r');
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
      //
      // Key it on the CONNECT SELECTOR, not the client-facing model name. This is
      // the same structural trap #224 fixed for RATE_LIMITED, third occurrence:
      // connect selection calls getApiKey(triedKeys, null, callerKey, selector)
      // with modelKey=null, so a cooldown written under `model` (reqModelName, e.g.
      // "gpt-5.5") is invisible to a lookup that asks about the resolved selector
      // (e.g. "gpt-5-5-sol") — the pool re-picks the throttled account for the
      // throttled model immediately and the 60s window never applies. Unlike #224
      // the answer is NOT to go account-wide (that would bench a healthy account
      // for every other model, which this branch explicitly avoids); it is to write
      // the cooldown in the dimension the connect path actually queries. Falls back
      // to `model` for the Cascade path, which passes a real catalog modelKey.
      markRateLimited(apiKey, 60 * 1000, selector || model, 'c');
      bumpConnect('capacity_throttled');
    }
    else if (aborted) { /* no penalty — client left, and the upstream declared nothing */ }
    // QUEUE_OVERFLOW: the LOCAL consumer fell behind the upstream stream and the
    // bounded frame queue hit its cap (devin-connect.js). The upstream and the
    // account are healthy — the slowness is ours — so this must not charge the
    // error budget that evicts accounts. Counted so a fleet-wide spike points at
    // the queue cap or a downstream writer instead of the pool.
    else if (err.code === 'QUEUE_OVERFLOW') { bumpConnect('queue_overflow'); }
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
    // REQUEST_REJECTED is the same class as CONTENT_BLOCKED: the upstream
    // VALIDATOR refused the request (unsupported image / capability, malformed
    // tool history) while the session token stays alive. A caller looping on an
    // image the selected model cannot take must not walk the pool offline, and
    // the internal-error streak would quarantine a healthy account after two.
    // Counted so the shape is visible; no cooldown, no re-login, no eviction.
    else if (err.code === 'REQUEST_REJECTED') { bumpConnect('request_rejected'); }
    else if (err.code === 'ERR_CONNECT_ACCOUNT_HOST_NOT_ALLOWED') {
      // The account's stored apiServerUrl was refused by the allow-list before any
      // upstream call (DEVIN_CONNECT_ACCOUNT_HOST=1 path). The upstream never saw
      // the request and the account is not sick — this is an operator/config fault,
      // so it must not charge the error budget that evicts healthy accounts.
      /* no penalty — request configuration rejected, not an account fault */
    }
    // SELECTOR_NOT_ELIGIBLE: "This model is no longer available for your account".
    // The scope is the (account, canonical selector) PAIR — the session token is
    // alive and this same account keeps serving every other selector — so NOTHING
    // account-scoped may happen here:
    //   - no reportError (the old behaviour: three requests for one retired
    //     selector flipped a healthy account to status='error', persisted, and
    //     blacked out every OTHER model it could still serve);
    //   - no re-login (the token was never dead);
    //   - no dead-token verdict and no reauth-confirmation probe (the handler's
    //     dead-token path owns those, and it must never see this code).
    // What DOES happen: latch the selector as ineligible for this account, but only
    // when a peer could serve it right now (see markSelectorIneligible) — then the
    // failover arm below moves the request to that peer. With no such peer the
    // latch is skipped and the upstream verdict surfaces as 403, which is honest:
    // the selector cannot run anywhere in this pool.
    else if (err.code === 'SELECTOR_NOT_ELIGIBLE') {
      // The latch is availability state for the CURRENT credential. `apiKey` is
      // the live key, so a late denial from an attempt that presented a key the
      // pool has since replaced would otherwise write the old epoch's verdict
      // onto the new one — latching a selector the fresh credential may serve
      // (repro: A-old rejected → A-new succeeds → late A-old denial). Count the
      // observation, but only the current epoch may write the latch.
      markSelectorIneligible(apiKey, selector || model, { credentialCurrent });
      bumpConnect('selector_ineligible');
    }
    else if (err.code === 'UNAUTHORIZED') {
      // A 401 from a credential the pool has already replaced is evidence
      // about the OLD epoch only. Charging the live key's error budget would
      // walk the fresh credential toward eviction, and re-logging in would
      // mint a third key over it — both penalize the new epoch for the old
      // one's failure.
      if (credentialCurrent) {
        reportError(apiKey, { selector });
        // The DEVIN_CONNECT session token is an opaque session_id with no refresh
        // path — UNAUTHORIZED most likely means the server retired it. If the
        // account has stored credentials + auto-relogin is enabled, trigger a
        // background re-login (throttled/de-duped in auth.js) so the next request
        // lands on a fresh token instead of a permanently-dead account. The
        // request signal only bounds the QUEUED wait for a global login slot: a
        // caller that disconnected must not hold (or later spend) a slot.
        reLoginAccount(acct.id, { signal }).catch(() => {});
      }
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
      if (credentialCurrent) reportInternalError(apiKey, { selector });
      bumpConnect('upstream_internal');
    }
    else if (err.code === 'STREAM_TRUNCATED') {
      // The socket ended mid-answer without the mandatory end-of-stream frame.
      // This is a TRANSPORT fault (same class as ECONNRESET), not an account
      // fault: the session token is alive and the account is healthy. Without
      // this branch it fell through to `reportError`, which charges the error
      // budget — so a flaky network path or an upstream that drops connections
      // would flip a perfectly good account to status='error' after
      // errorStreakThreshold hits, with persisted exponential backoff. That is
      // exactly the failure mode the CONTENT_BLOCKED / UPSTREAM_ERROR exemptions
      // above were added to remove. Record it as a health-window event so a
      // genuinely sick account is still de-prioritized by selection, but skip the
      // errorCount eviction.
      if (credentialCurrent) reportInternalError(apiKey, { selector });
      bumpConnect('stream_truncated');
    }
    // UPSTREAM_ERROR carries the gRPC `internal` class, which classifyUpstreamError
    // documents as "PERMANENT client mistakes (short fingerprint, gzipped request
    // body) — fails identically every retry". That is a fault in the REQUEST, not in
    // the account: the session token is alive and the account is healthy. Same
    // shape as CONTENT_BLOCKED above, which is already exempt — so a plain
    // reportError here has the same failure mode that fix removed: three malformed
    // requests from one caller flip a perfectly good account to status='error'
    // (persisted), and a client looping on a bad request walks the whole pool
    // offline one account at a time. Record it as a health-window event so a
    // genuinely sick account is still de-prioritized by selection, but skip the
    // errorCount eviction. (Verified by repro: 3 UPSTREAM_ERROR calls disabled a
    // healthy account whenever a peer existed to void the last-account exemption.)
    else if (err.code === 'UPSTREAM_ERROR') {
      if (credentialCurrent) reportInternalError(apiKey, { selector });
      bumpConnect('upstream_error');
    }
    else if (TRANSPORT_FAULT_CODES.has(err.code)) {
      // Upstream stall / transport faults, by the same reasoning as
      // STREAM_TRUNCATED above. These reached the `else` below and charged the
      // error budget, so a stalling upstream evicted healthy accounts three
      // timeouts at a time:
      //   TIMEOUT            — idle timeout, no data for the idle window. This
      //                        file's own comment calls it "often a transient
      //                        upstream stall worth a same-token replay".
      //   DEADLINE_EXCEEDED  — the absolute wall-clock cap. The upstream hung;
      //                        the account is fine.
      //   NO_TOKEN           — no session token was configured for this call.
      //                        A CONFIGURATION fault, so charging the account's
      //                        health for it is doubly wrong — and it would fire
      //                        on every request until the config is fixed.
      // Measured before this branch: 3 calls of each flipped a healthy account to
      // status='error' with errorCount=3 (peer seeded so lastAccountExempt could
      // not mask it).
      if (credentialCurrent) reportInternalError(apiKey, { selector });
      bumpConnect('transport_fault');
    }
    // DENY-BY-DEFAULT. The chain above is an allow-list of NAMED verdicts, so
    // whatever reaches here is a code this file has not classified — and the
    // open-ended part of that space is the transport's: devin-connect.js uses
    // Node core `https.request` and surfaces the RAW socket error (res/req
    // 'error' → streamError), which no literal in devin-connect.js names. EPROTO,
    // the HPE_* header/parse family, and ERR_SSL_* (a corporate proxy, TLS
    // interception, or a misbehaving upstream edge produces these routinely)
    // landed in the old `else reportError` and charged the error budget, so three
    // in-window faults flipped a healthy account to status='error' with persisted
    // backoff — the exact failure mode the set above exists to remove.
    //
    // Enumerating is not a fix: the space is open-ended by construction and this
    // class has now recurred three times (STREAM_TRUNCATED, then TIMEOUT/
    // DEADLINE_EXCEEDED/NO_TOKEN, now the TLS/parse families). Charging the
    // budget for an unknown code is a bet that the unknown is the account's
    // fault; the measured cost of losing that bet is an evicted healthy account.
    // So the default is the safe side: a health-window event (selection still
    // de-prioritizes a genuinely sick account) and NO errorCount. An account
    // fault must be NAMED — UNAUTHORIZED is the only code that is positive
    // evidence about the credential; the quota/rate/capacity/model arms above are
    // account STATE, not health faults, and they write their own cooldown
    // dimensions instead.
    else {
      // The verdict belongs to the credential that produced it, so a retired
      // credential's unknown code records nothing; the counter still moves so an
      // operator can see the unclassified traffic.
      if (credentialCurrent) {
        reportInternalError(apiKey, { selector });
        noteUnclassifiedConnectFault(err);
      }
      bumpConnect('unclassified_fault');
    }
  } else if (credentialCurrent) {
    // An old-key success does not prove the new key works, so it must not
    // clear the new epoch's error budget either. The account-level stats below
    // still record the request.
    reportSuccess(apiKey);
  }
  recordRequest(model, !err, Date.now() - startTime, acct.id);
  releaseAccountById(acct.id);
}

// Wait until getApiKey returns a non-null account, or until maxWaitMs expires.
// Used when every account has momentarily exhausted its RPM budget so the
// client is queued instead of getting a 503.
/**
 * queue-on-pin: briefly WAIT for a sticky-bound caller's own account instead of
 * immediately rotating to a substitute. OFF by default (stickyQueueOnPinMs = 0).
 *
 * Why wait at all: rotating away from the pin costs a full prompt-cache WRITE on the
 * substitute, and the pin does NOT come back afterwards — the success path re-pins
 * whatever served, and there is no return-home mechanism. Measured over 6 blocked
 * turns, distinct accounts touched (each one a full-prefix write; a write is ~5.6x a
 * read, derived from devin-connect.js's "hit cost measured at 17.8% of miss"):
 * rotate-and-repin 2, keep-the-pin-but-rotate-anyway 4 (it SCATTERS, because the
 * candidate sort ends on lastUsed ASCENDING so each blocked turn picks a different
 * cold account), queue-on-pin 1. Waiting is the only one that stays on one account.
 *
 * Why it is off by default: waiting caps this caller's throughput at ONE account's RPM
 * (pro 60/min, unprobed 20/min) where rotating spreads it across the pool. Cost versus
 * latency is an operator's call, not the code's.
 *
 * MUST run before the first getApiKey below, because that call is what clears the pin —
 * once it returns, there is nothing left to wait for.
 *
 * @returns {Promise<{acct: object|null, aborted: boolean}>} `acct` is the pinned account
 *   when the wait succeeded. `aborted` is true only when the caller disconnected DURING a
 *   wait this function actually performed — see the note at its use site for why that has
 *   to be distinguishable from an ordinary give-up.
 */
async function waitForOwnPin(tried, signal, modelKey, callerKey, connectSelector) {
  const NO_WAIT = { acct: null, aborted: false };
  const budgetMs = getBreakerTunable('stickyQueueOnPinMs');
  if (!budgetMs || budgetMs <= 0) return NO_WAIT;
  if (!callerKey || !isStickyEnabled()) return NO_WAIT;

  // Non-mutating: a poll must not count as a hit or reorder the LRU.
  const pin = peekStickyBinding(callerKey, modelKey, connectSelector);
  if (!pin) return NO_WAIT;
  // Already burned this request — a failover hop passed it in tried. Waiting for an
  // account this request has just failed on is waiting for nothing.
  if (tried?.includes(pin.apiKey)) return NO_WAIT;

  // Only wait when the account's own stated recovery FITS the budget. Passing the
  // connect selector as the dimension is deliberate: connect acquires with
  // modelKey=null, and the CAPACITY cooldown finalizeConnectAccount writes is keyed on
  // the selector, so asking with null would miss exactly the cooldown we are waiting
  // out (the modelKey=null trap, #224 / #230 / v3.8.0).
  const avail = getAccountAvailability(pin.apiKey, connectSelector || modelKey);
  if (avail.available) return NO_WAIT;  // usable already — the ordinary path will pin it
  // Entitlement and structural misses never expire, so waiting is waiting forever.
  // Anything unrecognised is treated as non-waitable: the safe default is today's
  // behaviour, not an unbounded stall on a reason nobody classified.
  const WAITABLE = new Set(['rate_limited', 'model_rate_limited', 'rpm_full', 'quota_exhausted']);
  if (!WAITABLE.has(avail.reason)) return NO_WAIT;
  // The reason code alone is not enough: `rpm_full` is ~1.5s for a caller whose window is
  // about to roll over, and ~59s for one that just burst through its whole allowance.
  // Compare the account's OWN stated recovery against the budget.
  if (!Number.isFinite(avail.retryAfterMs) || avail.retryAfterMs > budgetMs) return NO_WAIT;

  const deadline = Date.now() + budgetMs;
  const started = Date.now();
  while (Date.now() < deadline) {
    if (signal?.aborted) return { acct: null, aborted: true };
    await new Promise(r => setTimeout(r, Math.min(QUEUE_RETRY_MS, Math.max(50, deadline - Date.now()))));
    if (signal?.aborted) return { acct: null, aborted: true };
    // pinOnly: reuses the real usability test, and cannot answer with a substitute or
    // clear the pin on a miss.
    const acct = getApiKey(tried, modelKey, callerKey, connectSelector, { pinOnly: true });
    if (acct) {
      log.info(`[sticky] QUEUE-ON-PIN served the pinned account after ${Date.now() - started}ms (reason was ${avail.reason})`);
      return { acct, aborted: false };
    }
  }
  log.info(`[sticky] QUEUE-ON-PIN gave up after ${Date.now() - started}ms (reason ${avail.reason}) — rotating`);
  return NO_WAIT;
}

async function waitForAccount(tried, signal, maxWaitMs = QUEUE_MAX_WAIT_MS, modelKey = null, callerKey = null, connectSelector = null) {
  const deadline = Date.now() + maxWaitMs;
  const pinWait = await waitForOwnPin(tried, signal, modelKey, callerKey, connectSelector);
  if (pinWait.acct) return pinWait.acct;
  // Aborted DURING a wait we chose to perform. The pre-existing contract below is "if an
  // account is free, serve it even if the signal is aborted" — the abort check sits inside
  // the retry loop, so a first-try success is handed back regardless. That is fine when
  // the call is instantaneous, but queue-on-pin deliberately spent up to a second first,
  // so continuing here would acquire an account — pushing an RPM reservation and an
  // in-flight count — for a caller we now KNOW has gone. Bail instead, which is also what
  // the loop below would do on its next iteration.
  if (pinWait.aborted) return null;
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
// Merge logic: the effort field is folded into the model id ONLY when the id
// carries no effort suffix. An explicit suffix in the requested model is the
// caller's tier selection and is AUTHORITATIVE — neither `reasoning.effort` nor
// `reasoning_effort` may rewrite it (see the suffix guard below). When the id
// has no suffix, `${reqModel}-${effort}` is used only if it resolves to a known
// catalog model; anything else returns reqModel unchanged.
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
  // An explicit effort suffix in the requested model wins.
  //
  // This used to strip the suffix and rebuild the id from the effort field, on
  // the theory that the field was the caller's "current selection". It is not:
  // codex CLI sends `reasoning:{effort:"medium"}` on EVERY turn, so a request
  // naming `gpt-6-luna-max` was silently served as `gpt-6-luna-medium` (a
  // cheaper tier, wrong output and wrong billing — CompatClients F1: 18/18
  // requests). The reverse direction is just as wrong: a caller who asked for
  // `-medium` did not ask us to promote it to `-xhigh`. A model id that already
  // names its tier is what runs; the separate effort field only supplies a
  // missing tier (the #115 case: bare `gpt-5.5` + xhigh → `gpt-5.5-xhigh`).
  for (const e of VALID) {
    const suffix = '-' + (e === 'minimal' ? 'none' : e);
    if (reqModel.toLowerCase().endsWith(suffix)) return reqModel;
  }
  const normalizedEffort = effort === 'minimal' ? 'none' : effort;
  // Try the merged form. resolveModel returns the model key if it exists,
  // unchanged input otherwise; getModelInfo returns null for unknown models.
  // Both checks together guard against accidentally inventing a model that
  // doesn't exist in the catalog.
  const merged = `${reqModel}-${normalizedEffort}`;
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
  // A fallback is a second full pass through the handler. When the route's
  // budget is already spent (or has no turn left) that pass could only fail
  // with a budget error, hiding the real 429 that prompted the fallback.
  if (context?.budget && !context.budget.canStartAttempt()) return false;
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

/**
 * Credit cost of one connect request, from the calibrated billing passthrough.
 *
 * Returns 0 when the tags are not calibrated (the default) so per-account spend is
 * unchanged on those deployments. `committed_acu_cost` is the ACU figure #239 asks
 * for; `credit_cost` is the credit figure. They are different units, so prefer the
 * credit one for the credit column and never add them together.
 */
function connectCreditCost(billing) {
  if (!billing || typeof billing !== 'object') return 0;
  const credit = Number(billing.credit_cost ?? billing.committed_credit_cost);
  return Number.isFinite(credit) && credit > 0 ? credit : 0;
}

function connectAcuCost(billing) {
  if (!billing || typeof billing !== 'object') return 0;
  const acu = Number(billing.committed_acu_cost);
  return Number.isFinite(acu) && acu > 0 ? acu : 0;
}

function connectSpendOpts(billing) {
  return { creditCost: connectCreditCost(billing), acuCost: connectAcuCost(billing) };
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
    response_format,
  } = body;
  // `tool_choice` is `let`, not a destructured const: the DEVIN_CONNECT branch
  // rewrites a FORCED tool name to the upstream charset (G1) once it has built the
  // request-scoped name map, and the preamble/description builders downstream must
  // see the same spelling the #10 ToolDefs advertise. Validation and the Cascade
  // path read the caller's spelling, which is what the caller can see.
  let tool_choice = body.tool_choice;
  // F3 (evidence/DataAuditTools/findings.md): this route had no tool-type gate at
  // all. Every consumer filters `type === 'function'` — the text preamble in
  // tool-emulation.js and the native #10 ToolDef encoder in devin-connect.js — so
  // a hosted (`web_search*`) or server-executed (`file_search`,
  // `code_interpreter`, `mcp`, …) tool was dropped in silence: the turn ran and
  // the caller got a 200 with the tool gone. /v1/responses already refuses the
  // same payload; use its predicates (../server-side-tools.js) so the two
  // surfaces cannot drift, and refuse HERE — before prompt assembly, account
  // acquisition, or any upstream call. One rejected tool poisons the request:
  // the caller declared an executor this proxy does not have, and running the
  // turn would hide that.
  if (Array.isArray(tools)) {
    const rejectedType = firstUnsupportedServerToolType(tools);
    if (rejectedType) {
      const err = chatServerSideToolUnsupported(rejectedType, 'tools');
      log.warn(`Chat[${reqId}]: rejecting server-executed tool type ${safeLogValue(rejectedType)} — this proxy has no executor for it (400, no upstream call)`);
      return {
        status: 400,
        body: {
          error: {
            message: err.message,
            type: 'invalid_request_error',
            param: err.param,
            code: err.code,
          },
        },
      };
    }
    // Everything below the refusal stays lenient on purpose: an unknown type is
    // not a server-executed one, and clients do send dialect entries this
    // surface does not implement. Keep the historical 200, but stop dropping
    // them without a trace — that silence is what made F3 invisible.
    forEachTool(tools, (tool) => {
      if (typeof tool.type !== 'string' || tool.type === 'function') return;
      if (tool.type === 'custom') {
        log.info(`Chat[${reqId}]: tool type "custom" (${safeLogValue(tool.name || tool.function?.name || 'unnamed')}) is not executed by this surface — dropping it before the upstream call`);
        return;
      }
      log.warn(`Chat[${reqId}]: dropping unknown tool type ${safeLogValue(tool.type)} — the chat surface only executes client-declared function tools`);
    });
  }
  // O3: honor `max_completion_tokens`, the field newer OpenAI SDKs and the o1/o3/
  // gpt-5 reasoning families send in place of `max_tokens` (which those models
  // reject outright). Accept either for compatibility and prefer the modern name
  // when both are present, matching OpenAI's own precedence. Everything downstream
  // (the connect CompletionConfig at ~1975, cache key) reads this resolved value,
  // so the two spellings converge to one output cap on every backend path.
  const max_tokens = Number.isFinite(body.max_completion_tokens)
    ? body.max_completion_tokens
    : body.max_tokens;
  // A07/KH-003: a forced choice must name a tool that exists in the ORIGINAL
  // tools[] and must not name a server-executed type. Validate before
  // effectiveToolsForToolChoice turns a typo/mismatch into an empty list.
  const toolChoiceError = validateToolChoiceContract(tools, tool_choice);
  if (toolChoiceError) {
    log.warn(`Chat[${reqId}]: rejecting tool_choice contract — ${safeLogValue(toolChoiceError.body.error.code)}`);
    return toolChoiceError;
  }
  const effectiveTools = effectiveToolsForToolChoice(tools, tool_choice);
  // v2.0.66: merge reasoning_effort into the model id BEFORE alias
  // resolution so `gpt-5.5 + reasoning.effort=xhigh` resolves to
  // `gpt-5.5-xhigh`, not the medium-tier default.
  const reqModel = mergeReasoningEffortIntoModel(body.model, body);
  let messages = body.messages;
  const callerKey = context.callerKey || body.__callerKey || '';
  const nativeBridgeCallerKey = context.nativeBridgeCallerKey || callerKey;
  const cachePolicy = body.__cachePolicy || null;
  // Cline compat layer active for this request? Resolved at the server edge
  // (src/handlers/cline-compat.js) and threaded via context. The deeply-nested
  // emit points read it three ways: connectMeta.clineCompat (DEVIN_CONNECT
  // path), a positional arg (nonStreamResponse), and deps.context.clineCompat
  // (streamResponse). Falsy for every non-Cline request → emit stays byte-identical.
  //
  // Resolve ONLY from context (the server-edge resolution). Never read it from
  // body: body is client-supplied JSON, so honouring a body field would let any
  // caller POST {"__clineCompat":true} to the standard /v1 path and
  // force-activate the shim past both activation gates (master toggle + the
  // /v1/cline namespace / UA detection).
  const clineCompatActive = !!context.clineCompat?.active;
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
    log.info(`Probe[${reqId}]: model=${safeLogValue(reqModel)} stream=${!!stream} rf=${response_format?.type || 'none'} tools=${Array.isArray(tools) ? tools.length : 0} reasoning=${body.reasoning_effort || body.thinking?.type || 'none'} ctypes=[${[...contentTypes].join(',')}] turns=${messages?.length || 0} lastUser=${requestLogSummary(lastUserText, 140)}`);
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
    // A conversation must END on something answerable — a user turn or a tool
    // result. Everything else (empty, system-only, assistant-only, or an item array
    // whose entries all got dropped) reaches the upstream as an unanswerable
    // request, comes back "an internal error occurred (trace ID …)", and is
    // classified UPSTREAM_INTERNAL → reportInternalError → two consecutive of those
    // quarantine the account for 120s. So a caller looping on such a request
    // degrades a pool toward its last account (lastAccountExempt keeps one survivor
    // per tier, so it cannot be blacked out entirely).
    //
    // This is deliberately a CLASS check at the shared layer rather than a
    // per-route emptiness test. An earlier attempt guarded `messages.length === 0`
    // inside handleResponses, and review showed both failure modes of that shape:
    // adding `instructions` made the array length 1 and sailed straight through
    // (live: 503 with a real trace ID), while `/v1/chat/completions` with only a
    // system message and `/v1/messages` with only an assistant message were never
    // covered at all (live: 503 and 529). One check here closes all of them.
    // The LAST message is what decides answerability, not merely the presence of a
    // user turn somewhere: a chain whose newest items all got dropped ends on an
    // `assistant` message and the upstream rejects it just the same. Verified
    // against the real upstream that an assistant-terminated conversation (the
    // Anthropic "prefill" shape) is NOT supported there either — it returns
    // UPSTREAM_INTERNAL — so converting it into a clear 400 removes an opaque 503
    // and an account penalty without taking away anything that worked.
    // `function` is the legacy OpenAI tool-result role (pre-`tool`); the wire
    // encoder maps it to the same source, and clients still send it. Leaving it out
    // of the answerable set rejected a working shape.
    const ANSWERABLE_ROLES = new Set(['user', 'tool', 'function']);
    const convo = (messages || []).filter(m => m?.role !== 'system');
    const last = convo[convo.length - 1];
    if (!last || !ANSWERABLE_ROLES.has(last.role)) {
      return {
        status: 400,
        body: {
          error: {
            message: 'The conversation must end with a user message or a tool result. '
              + 'Provide at least one user turn to respond to.',
            type: 'invalid_request_error',
            param: 'messages',
          },
        },
      };
    }
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

  // #136 / #191: refuse an oversized outbound transcript HERE — after the
  // answerability guard, before backend selection, account acquisition, the
  // response cache, or any upstream call. The measured failure is a 113-turn /
  // ~128 KB transcript that the upstream accepts and then abandons mid-stream
  // with `context deadline exceeded`; the caller has partial bytes and cannot
  // retry cleanly. One local 413 with the measured numbers and the knobs is
  // strictly better than that, and it costs no account and no prompt assembly.
  // Both dimensions are independent; a dimension set to 0 is disabled.
  // See src/history-budget.js for the units and the default rationale.
  {
    const history = checkOutboundHistory(messages, { tools: effectiveTools });
    if (!history.ok) {
      const b = history.measured.breakdown || {};
      log.warn(`Chat[${reqId}]: outbound history over budget — turns=${history.measured.turns}/${history.budget.maxTurns} bytes=${history.measured.bytes}/${history.budget.maxBytes} (messages=${b.messages || 0} tools=${b.tools || 0}; overTurns=${history.overTurns} overBytes=${history.overBytes}); rejecting before the upstream call`);
      return {
        status: 413,
        body: {
          error: {
            message: historyBudgetErrorMessage(history),
            type: 'payload_too_large',
            param: 'messages',
            code: HISTORY_BUDGET_ERROR_CODE,
          },
        },
      };
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

  // T1 (Grok audit): the upstream (Devin/Windsurf) completion API only accepts
  // temperature/top_p/top_k/max_tokens. seed / presence_penalty /
  // frequency_penalty / logit_bias used to be accepted by the OpenAI schema and
  // then SILENTLY dropped — the client believed they took effect (and they even
  // split the response cache), but upstream never saw them. Reject a non-default
  // value with a clear 400 instead of faking success. Neutral defaults (penalties
  // == 0, seed/logit_bias absent or empty) pass through untouched for compat.
  const unsupportedSampling = [];
  if (body.seed != null) unsupportedSampling.push('seed');
  if (Number.isFinite(body.presence_penalty) && body.presence_penalty !== 0) unsupportedSampling.push('presence_penalty');
  if (Number.isFinite(body.frequency_penalty) && body.frequency_penalty !== 0) unsupportedSampling.push('frequency_penalty');
  if (body.logit_bias != null && typeof body.logit_bias === 'object' && Object.keys(body.logit_bias).length > 0) unsupportedSampling.push('logit_bias');
  if (unsupportedSampling.length) {
    const p = unsupportedSampling[0];
    return {
      status: 400,
      body: {
        error: {
          message: `Unsupported sampling parameter(s): ${unsupportedSampling.join(', ')}. The upstream backend ignores these, so this proxy rejects them rather than silently dropping them (which would look like they took effect). Remove them, or set penalties to 0.`,
          type: 'invalid_request_error',
          param: p,
        },
      },
    };
  }

  // O7: the upstream never returns token log-probabilities. Chat clients send
  // a boolean; Completions clients send an integer 0–5. Anything other than
  // omitted / false / 0 used to 200 with empty choices[].logprobs.
  if (logprobsRequested(body.logprobs)) {
    return {
      status: 400,
      body: {
        error: {
          message: 'This proxy does not support logprobs. The upstream backend does not return token log probabilities, so this proxy rejects them rather than silently dropping them (which would look like they took effect). Omit logprobs, or set it to false / 0.',
          type: 'invalid_request_error',
          param: 'logprobs',
        },
      },
    };
  }
  if (topLogprobsRequested(body.top_logprobs)) {
    return {
      status: 400,
      body: {
        error: {
          message: 'This proxy does not support top_logprobs. The upstream backend does not return token log probabilities, so this proxy rejects them rather than silently dropping them (which would look like they took effect). Omit top_logprobs, or set it to 0.',
          type: 'invalid_request_error',
          param: 'top_logprobs',
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
  // V-10: the caller's schema (when one was supplied) is the contract this
  // route must check its answer against. `json_object` carries no schema, so it
  // keeps the old "must parse as JSON" behaviour only.
  const jsonSchema = response_format?.type === 'json_schema' && response_format.json_schema?.schema
    ? response_format.json_schema.schema
    : null;
  const strongSystemStructuredOutput = hasStrongSystemOrDeveloperStructuredOutputContract(messages);
  const latestUserStructuredShape = isExplicitStructuredShapeRequestText(latestRealUserText(messages));
  const preserveCascadeStructuredPayload = explicitJson
    || strongSystemStructuredOutput
    || latestUserStructuredShape;
  // #185: only an unqualified conversational turn may unwrap Cascade's
  // accidental metadata envelope. Any explicit response_format (including a
  // future/non-JSON format we do not interpret here), a strong system/developer
  // output contract, or a clear latest-user structured shape means the object
  // is intentional and must stay verbatim.
  const allowCascadeMetadataUnwrap = response_format == null && !preserveCascadeStructuredPayload;
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

  // Global model access control (allowlist / blocklist from dashboard).
  // MUST run before EVERY backend branch — special-agent, DEVIN_CONNECT, and
  // Cascade alike — or operator policy is silently bypassed. It used to sit
  // further down, after the DEVIN_CONNECT short-circuit below, which meant a
  // blocked model still served normally whenever DEVIN_CONNECT=1 (the default
  // for the packaged exe and the recommended binary-less config) — the gate
  // only ever fired on the Cascade path it happened to precede.
  // Set when the access policy retargets a blocked model to the operator's
  // configured default. The DEVIN_CONNECT branch resolves its selector from the
  // RAW request name (its own namespace), not routingModelKey, so it has to be
  // told about the retarget explicitly or the fallback would silently serve the
  // originally-blocked model on that path.
  let accessFallbackModel = null;
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
        // A8: every model/reason fragment on these two lines is caller- or
        // config-derived and used to reach the log sink raw — a model name
        // carrying ESC/BEL/newline forged console output (and split a line).
        // safeLogValue (same primitive the rest of this file uses for
        // caller-supplied identity) strips C0/C1/DEL and bounds the length;
        // `access.reason` carries the caller's model too, so it is sanitized with
        // them. Routing and the client-facing values below are untouched.
        log.info(`Chat[${reqId}]: ${safeLogValue(routingModelKey)} blocked (${safeLogValue(access.reason)}); falling back to default model ${safeLogValue(fallbackKey)}`);
        routingModelKey = fallbackKey;
        modelInfo = fallbackInfo;
        access = fallbackAccess;
        accessFallbackModel = fallbackRaw;
      } else {
        log.warn(`Chat[${reqId}]: ${safeLogValue(routingModelKey)} blocked and default model "${safeLogValue(fallbackRaw)}" is unusable (info=${!!fallbackInfo}, allowed=${fallbackAccess.allowed}); rejecting`);
        return { status: 403, body: { error: { message: access.reason, type: 'model_blocked' } } };
      }
    } else {
      return { status: 403, body: { error: { message: access.reason, type: 'model_blocked' } } };
    }
  }

  // Upstream tier gate (new). The cloud catalog's ClientModelConfig carries the
  // upstream's own `disabled` flag — "this account's tier may not use this model".
  // Without a preflight, a tier-forbidden model spends a chat roundtrip and then
  // fails with a permission_denied that is indistinguishable from a transient
  // fault, so the account pool burns a health penalty on a request that was never
  // going to succeed. Reading the flag costs nothing (the catalog already arrived
  // with the model list) and turns the failure into a deterministic 402 before any
  // roundtrip. Only an EXPLICIT `true` refuses — absence of the flag is not a "no"
  // (see models.js isModelDisabledUpstream: refusing on silence would break every
  // statically-catalogued model and every unsynced account).
  if (isModelDisabledUpstream(routingModelKey)) {
    const caps = getModelCaps(routingModelKey);
    const reason = caps?.disabledReason || 'This model is not enabled for this account\'s plan.';
    log.warn(`Chat[${reqId}]: ${routingModelKey} disabled by upstream for this tier — rejecting before any roundtrip`);
    return { status: 402, body: { error: { message: reason, type: 'model_blocked' } } };
  }

  // DEVIN_CONNECT short-circuit: the pure-HTTP egress owns its own model
  // dictionary (devin-connect-models.js → proto #21 selectors), which is a
  // different namespace from the Cascade catalog. An operator who flips
  // DEVIN_CONNECT=1 wants every request on that path, so route here BEFORE the
  // Cascade "Unsupported model" gate — otherwise a connect-only selector like
  // `swe-1-6-slow` (no Cascade catalog entry) would 400 before ever reaching
  // the backend. Unmapped names degrade to the free-tier selector downstream.
  if (selectBackend({ modelInfo }).flow === 'devin_connect') {
    const reqModelName = accessFallbackModel || reqModel || config.defaultModel;
    // P-03: ChatMessage (GetChatMessage) has text #3 and images #10 only — no
    // attachment field. A file/document block would be flattened to '' by
    // messageText() and the turn would run without the document. Refuse before
    // ACP reroute, prompt assembly, account acquisition, or any socket. The
    // Responses surface names its request field `input`; direct chat calls use
    // `messages`. Cascade is untouched: image.js:extractImages extracts PDFs.
    const filePart = findFilePartInMessages(messages);
    if (filePart) {
      const param = body.__route === 'responses' ? 'input' : 'messages';
      const err = unsupportedFilePartError(filePart, { param });
      log.warn(`Chat[${reqId}]: DEVIN_CONNECT rejecting file/document content part before any upstream call (${param}) — ChatMessage has no attachment field`);
      return {
        status: 400,
        body: {
          error: {
            message: err.message,
            type: 'invalid_request_error',
            param: err.param,
            code: err.code,
          },
        },
      };
    }
    // VISION reroute: when ACP vision is explicitly enabled, keep using the real
    // Devin CLI for its full multimodal session semantics. The direct Connect
    // path below can also carry source=USER images #10, including SWE-1.7, but ACP
    // remains the operator-selected transport when this gate is on.
    if (acpVisionEnabled() && hasMultimodalContent(messages)) {
      log.info(`Chat[${reqId}]: image request → rerouting ${safeLogValue(reqModelName)} to the configured ACP vision path`);
      // This reroute leaves the DEVIN_CONNECT branch BEFORE the neutralize pass
      // below, so without this the Claude Code / Grok / Cline identity would reach
      // the Devin CLI verbatim — the same fingerprint the neutralize step exists
      // to strip, just via a different egress. Same both-shapes helper as below.
      const acpMessages = messages.map((m) => {
        if (m?.role !== 'system') return m;
        const neut = neutralizeMessageContent(m.content);
        return neut === m.content ? m : { ...m, content: neut };
      });
      return handleSpecialAgentChatCompletion(body, {
        id: genId(),
        created: Math.floor(Date.now() / 1000),
        model: reqModelName,
        modelKey: routingModelKey,
        messages: acpMessages,
        callerKey,
      }, context.specialAgent || {});
    }
    // Live free selectors are the ONLY sound degrade targets (#258 residual): the
    // frozen `swe-1-6-slow` is absent from a synced catalog and 502s as a fake
    // "daily usage quota has been exhausted", so an unmapped name used to look
    // like an account fault. `freeFallback` lets the resolver prefer a selector
    // the upstream actually serves free right now; when none exists it returns
    // selector:null and we say so instead of routing to a dead name.
    const { selector, mapped } = resolveConnectSelector(reqModelName, {
      freeFallback: getConnectFreeFallbackSelectors(),
    });
    // No callable selector at all — not even a degrade target. Applies whatever
    // STRICT_MODEL says: the legacy opt-out only permits degrading to a WORKING
    // free model, never to one the live catalog proved absent.
    if (!selector) {
      log.warn(`Chat[${reqId}]: DEVIN_CONNECT cannot resolve "${safeLogValue(reqModelName)}" to any callable selector and no live free fallback exists — 400 model_not_found`);
      return {
        status: 400,
        body: { error: {
          message: `The model \`${reqModelName}\` is not a valid model for this endpoint, and no free-tier fallback is currently callable. Call GET /v1/models for the list of available models.`,
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found',
        } },
      };
    }
    // P1 whitelist guard: an unmapped model name (mapped:false) means the request
    // does NOT resolve to any real DEVIN_CONNECT selector and would otherwise
    // silently degrade to the free-tier fallback — the client
    // asked for opus/gpt/etc. and unknowingly runs a different, free model
    // (wrong output, wrong billing, and a junk name trips the upstream request
    // validator — invalid_argument, now surfaced as 400 REQUEST_REJECTED; before
    // the 2026-10-25 mapping fix it read as UPSTREAM_INTERNAL and charged the
    // account's health). Reject early with 400 instead of guessing.
    // The whitelist ceiling is the catalog snapshot (devin-catalog-snapshot.json);
    // set WINDSURFAPI_STRICT_MODEL=0 to restore the legacy silent-degrade if the
    // snapshot is stale and a genuinely-live selector is being rejected.
    if (!mapped && String(process.env.WINDSURFAPI_STRICT_MODEL || '1') !== '0') {
      log.warn(`Chat[${reqId}]: DEVIN_CONNECT rejecting unmapped model "${safeLogValue(reqModelName)}" (not in catalog whitelist) — 400 model_not_found`);
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
    // Upstream-declared image capability (GetCliModelConfigs #5, the same bit
    // /v1/models advertises) is applied AFTER account acquisition below — it is
    // an account-specific forwarding policy, not a pool-wide fact (P2-2).
    //
    // `parallel_tool_calls:false` is a caller PREFERENCE ("prefer one tool call per
    // turn"), not a correctness requirement. The connect upstream can only be told
    // about it through #11 `disable_parallel_tool_calls` — an opt-in field whose tag
    // is unconfirmed (third-party .proto declaration order, never a wire capture).
    // With DEVIN_CONNECT_TOOL_CHOICE unset the field is not emitted and the hint is
    // dropped: the live matrix measured 4/4 connect models still returning two calls
    // with the flag set false (evidence/ToolMatrixLive.md §8).
    //
    // This used to be a 400 `unsupported_parameter`. Both halves of that were wrong.
    // (1) A preference is not a malformed request — refusing it discards work the
    // proxy can serve. (2) It broke a shipped client outright: Codex CLI 0.164 sends
    // `parallel_tool_calls:false` on EVERY request (29/29 captured,
    // evidence/ClientSandboxes.md §3.3 C1), so under the shipped default its first
    // turn got 400, Codex surfaced `turn.failed` and exited 1. A proxy must not turn
    // a hint into an outage.
    //
    // Serve it, say the hint is being dropped ONCE per process (a warn per request
    // would fire on every Codex turn and drown the real ones), and count EVERY
    // occurrence in `parallel_tool_calls_hint_ignored`. The counter is the signal
    // that would justify calibrating #11 — the drop is never silent.
    //
    // Scoped to the connect flow on purpose: the switch and the wire field are
    // connect-only, so a Cascade request is never affected by a connect knob.
    if (isParallelToolCallsHintIgnored(body.parallel_tool_calls, process.env)) {
      bumpConnect('parallel_tool_calls_hint_ignored');
      if (!_parallelHintWarned) {
        _parallelHintWarned = true;
        log.warn(`Chat[${reqId}]: DEVIN_CONNECT event=parallel_tool_calls_hint_ignored — caller asked for parallel_tool_calls:false and the #11 passthrough is off (DEVIN_CONNECT_TOOL_CHOICE is not "1"; tag unconfirmed), so the request is served without the hint and the upstream may return several calls per turn. Counted per request; logged once per process.`);
      }
    }
    // Drought gate (#234). It has to live INSIDE this short-circuit block: every
    // exit path of this block returns, so the Cascade-path gate further down
    // (isModelBlockedByDrought, ~line 3700) is structurally unreachable whenever
    // DEVIN_CONNECT is on — which is the production default. It had therefore
    // never executed on the default backend.
    //
    // Placed here on purpose:
    //   - AFTER selector resolution + the strict-model guard, so a junk model name
    //     still gets its precise 400 model_not_found rather than a misleading 503.
    //   - BEFORE the tool-emulation rewrite and account acquisition, so a blocked
    //     request costs no prompt assembly and touches no account.
    //
    // Uses the CONNECT-namespace predicate. Reusing isModelBlockedByDrought here
    // would block `swe-1-6-slow` (the only free-reachable connect selector) and
    // admit `gemini-2.5-flash` (which connect cannot route to) — the two namespaces
    // have zero overlap. See auth.js isConnectSelectorBlockedByDrought.
    if (isConnectSelectorBlockedByDrought(selector)) {
      const summary = getDroughtSummary({ env: process.env });
      // #258: the gate admits DROUGHT_SAFE_SELECTORS (weekly-quota-exempt paid
      // selectors) on top of the free-reachable one. The suggested list has to
      // name them — it previously offered only swe-1-6-slow.
      const offeredModels = [...DROUGHT_SAFE_SELECTORS, ...(summary.freeTierModels || [])];
      const freeList = offeredModels.slice(0, 4).join(', ');
      const retryAfterSec = clientRetryAfterSeconds(30 * 60 * 1000);
      log.warn(`Chat[${reqId}]: DEVIN_CONNECT drought blocking premium selector "${safeLogValue(selector)}" (lowestWeekly=${summary.lowestWeeklyPercent}%, ${summary.quotaKnownAccounts}/${summary.activeAccounts} accounts measured)`);
      bumpConnect('drought_blocked');
      return {
        status: 503,
        headers: { 'Retry-After': String(retryAfterSec) },
        body: {
          error: {
            message: `账号池处于配额低水位（drought mode）：所有已测账号本周配额都低于 ${summary.threshold}%，已暂时屏蔽 premium 模型 ${reqModelName}。请改用免费层模型（${freeList}…），或等周配额重置。可在 Dashboard 实验性面板关闭 droughtRestrictPremium 强制下发（会消耗最后一点配额）。`,
            type: 'drought_mode',
            drought: {
              lowestWeeklyPercent: summary.lowestWeeklyPercent,
              lowestDailyPercent: summary.lowestDailyPercent,
              threshold: summary.threshold,
              activeAccounts: summary.activeAccounts,
              quotaKnownAccounts: summary.quotaKnownAccounts,
              allowedModels: offeredModels,
            },
            retry_after_ms: retryAfterSec * 1000,
          },
        },
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
    let connectTools = _trim.tools;
    if (_trim.trimmed) log.warn(`Chat[${reqId}]: DEVIN_CONNECT weak model ${safeLogValue(reqModelName)} — trimmed tools ${effectiveTools.length}→${_trim.kept} (dropped ${_trim.dropped}) to avoid upstream overload`);
    const emulateTools = Array.isArray(connectTools) && connectTools.length > 0;
    // G1 (Q1 audit §7): the upstream accepts only `^[A-Za-z0-9_-]{1,64}$` tool
    // names and rejects anything else with a MISLEADING `invalid_argument`
    // ("an internal error occurred", mid-stream) — so `mcp::x`, `a.b` or
    // `tool with space` looked like a proxy bug. messages.js and responses.js
    // already rewrite names through buildToolNameMap; this surface did not, and
    // it is the one every OpenAI-shaped client (Codex, Cline, omp) uses.
    //
    // The rewrite is reversible and request-scoped, and it must cover BOTH legs:
    //  - declarations (#10 ToolDef AND the prompt preamble the model reads) so the
    //    model can only ever emit a legal name;
    //  - history (assistant `tool_calls[].function.name`, re-encoded natively as
    //    #6 ChatToolCall) so a follow-up turn does not name a tool the upstream
    //    considers undeclared;
    //  - `tool_choice.function.name` (#12) so a forced call names the same tool
    //    the definitions advertise.
    // Every valid name (incl. `mcp__a__b`) maps to itself, so a client that
    // already sends legal names sees a byte-identical request.
    const toolNameMap = toolHygieneEnabled()
      ? buildToolNameMap([
        ...toolNameList(connectTools),
        ...toolNameList(effectiveTools),
        ...historyToolNamesOf(messages),
      ])
      : null;
    const wireToolName = (n) => (toolNameMap && typeof n === 'string' && n
      ? (toolNameMap.toUpstream.get(n) ?? n)
      : n);
    if (toolNameMap) {
      const renamed = connectTools.map((t) => {
        const raw = t?.function?.name || t?.name;
        const wire = wireToolName(raw);
        if (!wire || wire === raw) return t;
        return t?.function ? { ...t, function: { ...t.function, name: wire } } : { ...t, name: wire };
      });
      if (renamed.some((t, i) => t !== connectTools[i])) {
        log.info(`Chat[${reqId}]: DEVIN_CONNECT tool names rewritten to the upstream charset (${connectTools.length} tool(s))`);
        connectTools = renamed;
      }
      messages = renameHistoryToolNames(messages, wireToolName);
      // Same map for a FORCED tool_choice (#12) and for every builder downstream
      // that names the tool (the prompt preamble, the description preamble). It is
      // rewritten HERE rather than at the `connectParams` literal so the preamble
      // cannot disagree with the #10 ToolDefs.
      tool_choice = mapToolChoiceToWire(tool_choice, wireToolName);
    }
    // Client-visible leg: the upstream echoes (or reverse-looks-up) the WIRE name,
    // so every name leaving this handler is mapped back through toClient. No-op
    // for names the caller sent legally, and null when hygiene is off.
    const clientToolName = (n) => (toolNameMap ? restoreToolName(n, toolNameMap) : n);
    // Non-stream twin of the frame rewrite above: the adapter's completion body
    // carries the upstream's (wire) name. Restore before anything downstream reads
    // it — the caller's response, the session-continuity pair-chain (built from
    // `connectMessages`, which is caller-shaped) and the response cache.
    const restoreOutToolNames = (out) => {
      if (!toolNameMap) return out;
      const calls = out?.body?.choices?.[0]?.message?.tool_calls;
      if (Array.isArray(calls)) {
        for (const tc of calls) {
          const name = tc?.function?.name;
          if (typeof name === 'string' && name) tc.function.name = clientToolName(name);
        }
      }
      return out;
    };
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
    // HYBRID (2026-07-13): keep the prompt preamble ON even when native #10
    // ToolDef + #6 ChatToolCall are both engaged. The preamble carries full
    // human-readable tool descriptions (which upstream's MCP-gate does NOT
    // scan — it only fingerprints the protobuf #10 fields), so the model
    // keeps its tool-selection context while we still get reliable native
    // tool-call decode. Only the SOLO calibration probe suppresses the
    // preamble (it needs #10 to be the ONLY tool signal to verify tags).
    const suppressPreamble = soloProbe;
    if (soloProbe) log.info(`Chat[${reqId}]: DEVIN_CONNECT TOOL_DEF SOLO probe — preamble suppressed, native #10 is the only tool signal`);
    // Native tool_call observability: surface gate state so a paid probe can
    // confirm the native path actually engaged (flag on + tags resolved) vs
    // silently falling back to prompt emulation.
    if (emulateTools) log.info(`Chat[${reqId}]: TOOLCALL nativeFlag=${nativeFlag} defsOn=${nativeDefsOn} callsOn=${nativeCallsOn} suppressPreamble=${suppressPreamble} mode=${(nativeDefsOn && nativeCallsOn) ? 'NATIVE' : 'emulation'}`);
    const nativeStructured = nativeDefsOn && nativeCallsOn;
    if (String(process.env.DEVIN_CONNECT_REPLAY_SIGNED_THINKING || '').trim() === '1' && emulateTools && !nativeStructured
        && messages.some((m) => m?.role === 'assistant' && m.tool_calls?.length && m.reasoning_signature && String(m.reasoning_content || '').length > 0)) {
      return {
        status: 400,
        body: { error: {
          message: 'Signed thinking replay requires native tool history; prompt emulation would discard the signed assistant turn.',
          type: 'invalid_request_error',
          param: 'messages',
          code: 'signed_thinking_tool_history_unsupported',
        } },
      };
    }
    // P2-1: native #6/#7 encoding does NOT require tools to be declared. When the
    // native flag is on, connectParams.nativeToolCall below makes the builder emit
    // ChatToolCall/tool_result frames for the history even with `tools` absent
    // (or tools:[] / tool_choice:'none'), so the #273 repair must run on that
    // branch too. It used to run only inside normalizeMessagesForCascade under
    // nativeStructured, which is false without tools — a reversed pair then
    // reached the wire as [1,4,2,1], the exact shape measured as a 502.
    // The tools branch is unchanged: nativeStructured's normalizer already
    // repairs, and the text-emulation branch must keep its bytes (it folds
    // results into user turns, so there is no role=4 frame to order).
    let connectMessages = emulateTools
      ? normalizeMessagesForCascade(messages, connectTools, { modelKey: reqModelName, provider: null, route: 'devin_connect', toolChoice: tool_choice, injectUserPreamble: !suppressPreamble, stripOrphans: nativeDefsOn, nativeStructured })
      : nativeFlag
        ? interleaveParallelToolMessages(orderToolResultsAfterCalls(messages))
        : interleaveParallelToolMessages(messages);
    // HYBRID native path: DEVIN_CONNECT has no proto tool_calling_section
    // slot, so the description-only preamble (buildToolPreambleForProto with
    // nativeStructured:true) is never built by normalizeMessagesForCascade —
    // its user-message fallback (buildToolPreamble) returns '' for
    // nativeStructured. Without this injection the model gets ONLY the
    // stripped native #10 ToolDef (names + schemas, no descriptions) and
    // loses tool-selection context. Build the description-only preamble via
    // applyToolPreambleBudget and inject it into the system prompt so the
    // model keeps full human-readable tool descriptions (which upstream's
    // MCP-gate does NOT scan — it only fingerprints the protobuf #10
    // fields) while still calling tools through the native function-calling
    // interface. The preamble has NO text-emulation protocol header
    // (nativeStructured strips it), so there is no conflict with native
    // #6 ChatToolCall. SOLO probe mode (suppressPreamble) skips this too —
    // it needs #10 to be the ONLY tool signal.
    if (nativeStructured && !suppressPreamble && Array.isArray(connectMessages)) {
      const callerEnv = extractCallerEnvironment(messages);
      const descBudget = applyToolPreambleBudget(connectTools, tool_choice, callerEnv, {
        modelKey: reqModelName,
        provider: null,
        route: 'devin_connect',
        nativeStructured: true,
      });
      if (!descBudget.ok) {
        log.warn(`Chat[${reqId}]: DEVIN_CONNECT native desc preamble ${Math.round(descBudget.finalBytes / 1024)}KB exceeds hard cap ${Math.round(descBudget.hardBytes / 1024)}KB after ${descBudget.tier} tier; rejecting (${connectTools.length} tools)`);
        return {
          status: 400,
          body: {
            error: {
              message: `Tool definitions are too large (${Math.round(descBudget.finalBytes / 1024)}KB > ${Math.round(descBudget.hardBytes / 1024)}KB after ${descBudget.tier} compaction). Reduce the number of tools or shorten tool names.`,
              type: 'invalid_request_error',
              param: 'tools',
              code: 'tool_preamble_too_large',
            },
          },
        };
      }
      if (descBudget.preamble) {
        connectMessages = injectPreambleIntoSystemPrompt(connectMessages, descBudget.preamble);
        log.info(`Chat[${reqId}]: DEVIN_CONNECT native desc preamble injected into system prompt (${descBudget.tier} tier, ${Math.round(descBudget.finalBytes / 1024)}KB, ${connectTools.length} tools)`);
      }
    }
    // DEVIN_CONNECT public egress: neutralize competitor client-identity in the
    // system prompt BODY (529 fingerprint + content-policy triggers). This path
    // (incl. Codex /v1/responses and direct /v1/chat/completions) previously had
    // NO neutralization — only /v1/messages→anthropicToOpenAI did — so a Claude
    // Code / Agent-SDK system prompt reached Devin verbatim. Live A/B (2026-07-10)
    // proved the "You are a Claude agent, built on Anthropic's Claude Agent SDK"
    // line trips the content policy; neutralizing it serves the same request.
    // RUNS AFTER preamble injection (above): the native-path tool-description
    // preamble is injected into the system prompt at that step, so a trigger phrase
    // carried by a TOOL description (e.g. codex apply_patch's "FREEFORM …", rule a7
    // in identity-neutralize.js) is only reachable once the preamble is in place.
    // Running here covers the original system prompt AND both injected preambles
    // (emulation + native). Only rewrites system messages; user/assistant content
    // is untouched. Off-switch: WINDSURFAPI_NEUTRALIZE_CLIENT_ID=0.
    // Handles BOTH content shapes. Guarding on `typeof m.content === 'string'`
    // silently skipped array/parts content — the DEFAULT shape for Codex
    // /v1/responses, whose normalizeMessageContent returns `[{type:'text'}]` parts
    // rather than a flat string. Those messages were only flattened later, by
    // devin-connect.js's wire-time messageText(), so the identity fingerprint this
    // step exists to strip reached Devin verbatim on the single most common
    // Codex path.
    if (Array.isArray(connectMessages)) {
      connectMessages = connectMessages.map((m) => {
        if (m?.role !== 'system') return m;
        const neut = neutralizeMessageContent(m.content);
        return neut === m.content ? m : { ...m, content: neut };
      });
    }
    log.info(`Chat[${reqId}]: DEVIN_CONNECT ${safeLogValue(reqModelName)} -> selector=${safeLogValue(selector)}${mapped ? '' : ' [unmapped→free-tier]'} stream=${!!stream}${emulateTools ? ` tools=${connectTools.length}` : ''}`);
    const ccId = genId();
    const ccCreated = Math.floor(Date.now() / 1000);
    const ccStart = Date.now();

    // [STREAM-CACHE] Probe BEFORE the pool preflight/acquire: a hit needs neither
    // an RPM reservation nor a queue slot. The key is stream-agnostic
    // (normalize() has no stream field), so stream and non-stream turns share one
    // slot. cacheKey() gates isCacheEnabled + hasPerUserScope (-> null when
    // uncacheable, so no cross-user sharing).
    let __sCkey = null;
    let __sHit = null;
    try {
      __sCkey = cacheKey(body, callerKey);
      __sHit = __sCkey ? cacheGet(__sCkey) : null;
      if (__sHit) log.info('[STREAM-CACHE-HIT] ckey=' + __sCkey);
    } catch (e) { log.info('[STREAM-CACHE-ERR] pre ' + (e && e.message)); }

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
    // gets the queue benefit via acquireConnectAccount below. A cache hit skips
    // both: it is already the answer, and charging RPM for it would exhaust the
    // pool under exactly the retry storm the cache exists to absorb.
    if (!__sHit && getAccountCount().total > 0) {
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
      // P2-7: neither check above can see the rest of the selection conjunction.
      // Maintenance (a background / language-server swap holds the account, live by
      // default), the per-account in-flight cap and the selector latch all make an
      // account unselectable while leaving it outside rl/tu — so a pool blocked on
      // one of those passed this preflight, spent the full queue wait, and then
      // acquired null, which is indistinguishable from "no pool" and fell through to
      // the un-accounted env token. Ask the scheduler's own admission predicate
      // (read-only) so that shape fails fast instead.
      const adm = isAllConnectAccountsUnavailable(selector);
      // L2: when degraded-serve is on, DON'T fast-429 a fully-throttled pool here.
      // Fall through to acquireConnectAccount → getApiKey, which will degrade-serve
      // the least-bad transiently-cooled account (pickDegradedFallback) instead of
      // blacking out. A genuine dry-well (quota) still surfaces downstream since the
      // fallback strictly excludes quotaResetAt accounts. Default OFF = the original
      // fast-429 preflight is byte-identical. (tu = temporarily-unavailable = the
      // cooldown/RPM dimensions; degraded serve bypasses only those, so it must not
      // suppress the admission arm below — pickDegradedFallback skips maintenance
      // accounts and latched selectors, so it cannot serve a pool blocked on them.)
      const throttled = rl.allLimited || tu.allUnavailable;
      const degradable = getBreakerTunable('degradedServe') && rl.allLimited && !tu.allUnavailable;
      if ((throttled && !degradable) || (!throttled && adm.allUnavailable)) {
        const retryAfterMs = rl.retryAfterMs || tu.retryAfterMs || adm.retryAfterMs || 60000;
        // F3: clamp the advertised Retry-After so an agent client's auto-retry
        // backs off usefully (floor) and is never frozen by an over-long window
        // (ceil). header + body report the SAME clamped value.
        const retryAfterSec = clientRetryAfterSeconds(retryAfterMs);
        log.info(`Chat[${reqId}]: DEVIN_CONNECT pool exhausted (${throttled ? 'all accounts rate-limited/unavailable' : 'no account admitted for the selector — maintenance / in-flight cap / latch'}) → 429 retry_after=${retryAfterMs}ms (advertised ${retryAfterSec}s)`);
        bumpConnect('pool_exhausted');
        return {
          status: 429,
          headers: { 'Retry-After': String(retryAfterSec) },
          body: { error: {
            message: throttled
              ? `All DEVIN_CONNECT accounts are temporarily rate-limited. Retry in ~${retryAfterSec}s.`
              : `No DEVIN_CONNECT account is currently selectable for \`${reqModelName}\` (maintenance, in-flight cap, or model unavailable for the pool). Retry in ~${retryAfterSec}s.`,
            type: 'rate_limit_exceeded',
            retry_after_ms: retryAfterSec * 1000,
          } },
        };
      }
    }
    const ccAcct = __sHit ? null : await acquireConnectAccount(context.signal, callerKey, selector, context.budget || null);
    // Upstream-declared image capability (GetCliModelConfigs #5, the same bit
    // /v1/models advertises). Until this gate no request path read it, so an
    // image was forwarded to a model the same server had just told the client
    // was text-only (C3-01).
    //
    // PER ACCOUNT (P2-2): the catalog is account-scoped and `supports_images` is
    // a forwarding policy for the account that will serve THIS request. The
    // pool-wide union is first-writer-wins, so reading it here let one account's
    // true mask another's false — or strip a true peer's valid image — depending
    // only on sync order. Resolve the bit from the acquired account; an account
    // with no synced rows, no row for this selector, or a silent row is UNKNOWN
    // and forwards (never "no"). The env-token fallback has no pooled account, so
    // it keeps the union.
    //
    // Only an EXPLICIT false gates: a missing bit is unknown and must never be
    // read as "no" — the same three-state rule as disabled (#4). Unknown models
    // keep the historical wire byte-for-byte.
    //
    // Why STRIP and not a 400: the live catalog measured 2026-10-25 was 240 rows
    // (224 true / 0 false / 16 silent, evidence/Wave4-Images.md), so no model
    // exercises the false arm and there is no capture of one rejecting an image.
    // Refusing on a bit whose false arm has never been observed is the class of
    // bug the Codex `parallel_tool_calls` 400 was: a hard failure derived from an
    // unverified declaration, breaking a working client. Dropping the images
    // preserves the text turn; the counter and the warn make the drop visible
    // instead of silent. An image-ONLY last turn has no text to preserve and is
    // refused below (P2-3).
    //
    // The strip must touch BOTH arrays: `messages` is the caller-shaped history
    // and `connectMessages` is what was normalized (preamble/merge) from it just
    // above; only the latter rides the wire.
    if (!__sHit && hasMultimodalContent(messages)) {
      const imageCapability = ccAcct
        ? getConnectSelectorImageCapabilityForAccount(ccAcct.id, selector)
        : getConnectSelectorImageCapability(selector);
      if (imageCapability === false) {
        const stripped = stripImageParts(messages);
        const wireStripped = Array.isArray(connectMessages) ? stripImageParts(connectMessages) : null;
        const dropped = wireStripped ? wireStripped.dropped : stripped.dropped;
        messages = stripped.messages;
        if (wireStripped) connectMessages = wireStripped.messages;
        if (dropped > 0) {
          bumpConnect('images_dropped_capability', dropped);
          log.warn(`Chat[${reqId}]: DEVIN_CONNECT selector ${safeLogValue(selector)} declares supports_images=false for account ${ccAcct ? safeAccountRef(ccAcct) : 'env-token'} in the live catalog — dropped ${dropped} image block(s) before the wire; text preserved (counted in images_dropped_capability)`);
          // P2-3: the answerability guard ran BEFORE this strip and counted the
          // image as content. If the conversation ENDS on a user turn that is
          // now empty there is nothing left to answer: sending it would encode
          // an empty user frame (and consecutive user turns can merge it away
          // entirely, leaving the model to answer a stale earlier prompt).
          // Refuse with the reason. A conversation that ends on a tool result is
          // still answerable — an earlier stripped user turn is not the terminal
          // turn, so it must not turn a valid continuation into a 400.
          const wireMessages = Array.isArray(connectMessages) ? connectMessages : messages;
          const convo = wireMessages.filter(m => m?.role !== 'system');
          const last = convo[convo.length - 1];
          if (last?.role === 'user' && !hasAnswerableUserContent(last)) {
            log.warn(`Chat[${reqId}]: DEVIN_CONNECT selector ${safeLogValue(selector)} declares supports_images=false and the last user turn contained only image block(s) — refusing with 400 (no answerable content remains after the strip)`);
            if (ccAcct) {
              try { refundReservation(ccAcct.apiKey, ccAcct.reservationTimestamp); } catch {}
              try { releaseAccountById(ccAcct.id); } catch {}
            }
            return {
              status: 400,
              body: {
                error: {
                  message: `The last user message contains only image content, and model \`${reqModelName}\` declares supports_images=false in the live catalog. Send the image together with text, or use a model whose /v1/models row advertises supports_images.`,
                  type: 'invalid_request_error',
                  param: 'messages',
                  code: 'image_only_turn_unsupported',
                },
              },
            };
          }
        }
      }
    }
    const connectParams = {
      messages: connectMessages,
      model: selector,
      // Opt-in tool fields (#11 disable_parallel_tool_calls / #12 tool_choice).
      // buildGetChatMessageRequest ignores both unless DEVIN_CONNECT_TOOL_CHOICE=1,
      // so the default wire stays byte-identical. They are threaded here because the
      // handler is the only layer that knows what the caller asked for — before
      // this, streamChat() did not even accept them, so the live switch was inert
      // for every request that came through /v1/chat/completions.
      parallelToolCalls: body.parallel_tool_calls,
      toolChoice: tool_choice,
    };
    // Session continuity (opt-in, DEVIN_CONNECT_SESSION_REUSE, default OFF). Derive
    // a stable protobuf session_id (#16) from the conversation's completed request/
    // response pair chain so a multi-turn dialog reuses ONE session_id instead of
    // minting a fresh randomUUID per call — which the upstream velocity limiter
    // reads as N brand-new sessions. Resolves BEFORE dispatch on the client's own
    // history; returns null (⇒ fresh per-request uuid, byte-identical to today) when
    // the gate is off. Uses connectMessages so the fingerprint reflects exactly what
    // rides the wire.
    // T2 (Thinking-core): incoming reasoning as fallback continuity source —
    // anthropic-in thinking rides the body as __incomingThinking (messages.js
    // captures it before the drop); openai/responses-in still carry
    // reasoning_content on the last assistant turn here, before tool-emulation
    // rebuilds the history.
    let incomingConnectReasoning = body?.__incomingThinking || null;
    if (!incomingConnectReasoning) {
      for (let i = connectMessages.length - 1; i >= 0; i--) {
        const im = connectMessages[i];
        if (im?.role === 'assistant') {
          incomingConnectReasoning = im.reasoning_content || im.reasoning || null;
          break;
        }
      }
    }
    const connectSessionId = resolveConnectSessionId(callerKey || '', connectMessages);
    if (connectSessionId) {
      connectParams.sessionId = connectSessionId;
      const modelCfg = getSessionConnectModelConfig(callerKey || '', connectMessages);
      if (modelCfg) connectParams.sessionModelConfig = { id: modelCfg.configId, turn: modelCfg.turn };
      const reasoningTrail = getSessionConnectReasoningTrail(callerKey || '', connectMessages);
      if (reasoningTrail) connectParams.continuityTrail = reasoningTrail;
      log.info(`Chat[${reqId}]: DEVIN_CONNECT session reuse active → session_id=${connectSessionId}${modelCfg ? ` model_config=stable turn=${modelCfg.turn}` : ''} acct=${ccAcct?.account?.id || 'env-token'}`);
    } else {
      // O3: name the source on the DEFAULT path too. Without this line an operator
      // cannot tell a fresh-per-request uuid (#16) from a lost reuse hit, and the
      // upstream velocity limiter sees every turn as a new session.
      log.debug(`Chat[${reqId}]: DEVIN_CONNECT session_id source=fresh-per-request (DEVIN_CONNECT_SESSION_REUSE off)`);
      if (!_connectSessionSourceNoted) {
        _connectSessionSourceNoted = true;
        log.info(`Chat[${reqId}]: DEVIN_CONNECT session_id source=fresh-per-request (DEVIN_CONNECT_SESSION_REUSE off — every request mints a new #16; enable it for multi-turn continuity)`);
      }
    }
    if (ccAcct) {
      connectParams.token = ccAcct.apiKey;
      // Stable per-account device fingerprint (opt-in, WINDSURFAPI_STABLE_DEVICE).
      // undefined when the mode is off → wire layer falls back to per-request
      // random (#31 byte-identical to before). Failover paths below re-derive the
      // seed from the account they actually switch to.
      const seed = ensureDeviceSeed(ccAcct);
      if (seed) connectParams.deviceSeed = seed;
    }
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
    // its calibrated defaults. (NB: max_tokens is forwarded at #2 — see
    // buildCompletionConfig — and is enforced where the tier honours the cap.)
    const completionOverrides = {};
    if (Number.isFinite(body.temperature)) completionOverrides.temperature = body.temperature;
    if (Number.isFinite(body.top_p)) completionOverrides.topP = body.top_p;
    if (Number.isFinite(body.top_k)) completionOverrides.topK = body.top_k;
    if (Number.isFinite(max_tokens)) completionOverrides.maxTokens = max_tokens;
    // G02: the Responses surface forwards `text.verbosity` as a top-level
    // `verbosity` (responses.js). `buildCompletionConfig` has no verbosity
    // field, so this is accepted and intentionally a no-op on the wire —
    // carried here so the caller's value is not silently dropped at the proxy
    // boundary (the override set records that the request asked for it).
    if (typeof body.verbosity === 'string' && body.verbosity) {
      completionOverrides.verbosity = body.verbosity;
    }
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
        log.info(`Chat[${reqId}]: DEVIN_CONNECT router '${safeLogValue(reqModelName)}' resolved via AssignModel → ${asg.model_uid}`);
      } catch (e) {
        bumpConnect('assign_model_failed');
        log.warn(`Chat[${reqId}]: DEVIN_CONNECT AssignModel for '${safeLogValue(reqModelName)}' failed (${e.code || 'ERR'}): ${e.message} — falling back to selector=${selector}`);
      }
    }
    // Thread the client's abort signal into the upstream HTTP request so a
    // disconnected/cancelled caller tears down the in-flight connect call
    // instead of leaking it until the 120s timeout.
    if (context.signal) connectParams.signal = context.signal;
    // The name echoed back to the client. For a MAPPED request that stays the
    // requested name — alias resolution (claude-sonnet-4.6 → claude-sonnet-4-6-thinking)
    // must keep echoing what the caller asked for, which is also what OpenAI does.
    //
    // For an UNMAPPED name under WINDSURFAPI_STRICT_MODEL=0 it must not. That opt-out
    // degrades the request to the free selector, and the response used to report the
    // requested PAID name regardless — measured: `claude-opus-4.9` came back 200 with
    // `model: "claude-opus-4.9"` on the non-stream body and on every stream chunk, plus a
    // system_fingerprint derived from that name, while `swe-1-6-slow` ran upstream. The
    // degrade itself is a deliberate operator choice; misreporting it is not, and it
    // breaks both billing attribution and any client that trusts the echoed name.
    //
    // Source it from connectParams.model, NOT from `selector`. `selector` is captured
    // before the AssignModel router hop above (which reassigns connectParams.model to
    // asg.model_uid), and router names resolve mapped:false — so reporting `selector`
    // would swap one lie for another: an 'adaptive' request that really ran
    // claude-opus-4-8-medium would be reported as the free swe-1-6-slow. Reproduced
    // both ways before choosing this source.
    const connectDisplayModel = mapped ? reqModelName : connectParams.model;
    // O1: honor stream_options.include_usage on the connect path too — the
    // trailing usage frame is emitted only when the caller opted in.
    const connectMeta = { id: ccId, created: ccCreated, displayModel: connectDisplayModel, emulateTools, includeUsage: body.stream_options?.include_usage === true, stop: body.stop ?? null, clineCompat: clineCompatActive, reqId, account: ccAcct ? safeAccountRef(ccAcct) : null,
      // Route-owned request budget: the adapter consumes one upstream turn per
      // internal attempt (empty/rescue/outer retry) and clamps its backoffs to
      // the remaining deadline. See src/request-budget.js.
      budget: context.budget || null,
      // SEED-C3a: only the internal Anthropic Messages route needs the adapter's
      // exact matched stop sequence (it echoes it as the public `stop_sequence`).
      // Explicit opt-in from the route — a direct OpenAI client keeps the
      // public response shape untouched.
      stopCarrier: context.__messagesStopCarrier === true };
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
          // A pure pre-content error must not be terminated with [DONE]: the
          // OpenAI stream contract treats [DONE] as "the turn completed", so a
          // client would report a clean empty answer instead of the upstream
          // failure. `contentEmitted` distinguishes a real payload (text,
          // tool_calls, or finish) from the eager role-only prime.
          let contentEmitted = false;
          let terminalOk = false;
          // Derive from the name we actually echo, not the raw request name. The adapter
          // normally pre-sets the fingerprint from displayModel, so this is a dormant
          // fallback — but leaving it on reqModelName means a rare fallback emits a
          // fingerprint keyed to a model we are no longer claiming to have run.
          const fp = systemFingerprint(connectDisplayModel);
          // O10: 仅直连 OpenAI 客户端(route==='chat')在出口归一化 error.type;
          // messages/gemini/responses 路由写入各自 translator 的 captureRes,
          // 须保留内部词供其 remap。
          const isOpenAIClient = (body.__route || 'chat') === 'chat';
          // V-08: the Connect stream used to discard every write verdict, so a
          // slow reader bought unbounded upstream production. The adapter now
          // awaits `send`, so this writer's drain wait holds the producer: one
          // outstanding wait, no resend of the accepted frame, bounded by
          // WINDSURFAPI_MAX_DRAIN_MS, and a half-open client tears the turn down
          // instead of pinning an account.
          const maxDrainWaitMs = resolveMaxDrainWaitMs();
          const writer = createBoundedWriter({
            res,
            signal: abortController.signal,
            maxWaitMs: maxDrainWaitMs,
            onTimeout: () => {
              log.warn(`Chat[${reqId}]: no drain for ${maxDrainWaitMs}ms — client stopped reading, aborting the stream`);
              writeRaw(formatFrame(chatStreamError(
                'client stopped reading; the stream was aborted after the drain timeout',
                'server_error',
                'DRAIN_TIMEOUT',
              )));
              abortController.abort(new Error('drain timeout'));
            },
          });
          const writeRaw = (text) => writer.write(text);
          const formatFrame = (data) => `data: ${JSON.stringify(data)}\n\n`;
          // Returns the sequential-emission promise so the adapter can hold its
          // producer behind a pressured socket. The frame is written once, after
          // any outstanding drain.
          const send = (data) => {
            // O9/O12: connect 流 chunk 由 adapter 预置 fp；此处幂等补
            // system_fingerprint 与 service_tier。error 帧不动。
            applyChatCompletionCompatFields(data, fp);
            // G1 reverse leg: the model was told the WIRE names, so the tool_call
            // deltas it produces carry them. Map back before serialization, or an
            // OpenAI client receives a name it never declared (and the tool_result
            // it sends next cannot be matched by its own registry).
            if (toolNameMap && Array.isArray(data?.choices)) {
              for (const choice of data.choices) {
                const calls = choice?.delta?.tool_calls;
                if (!Array.isArray(calls)) continue;
                for (const tc of calls) {
                  const name = tc?.function?.name;
                  if (typeof name === 'string' && name) tc.function.name = clientToolName(name);
                }
              }
            }
            if (isOpenAIClient && data && data.error && typeof data.error.type === 'string') {
              data.error.type = normalizeOpenAIErrorType(data.error.type);
            }
            if (!res.writableEnded) {
              if (Array.isArray(data?.choices) && data.choices.some((c) => c?.delta?.content || c?.delta?.tool_calls || c?.finish_reason)) contentEmitted = true;
              emitted = true;
              return writer.writeFrame(formatFrame(data));
            }
            return undefined;
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
              // Best effort only, and deliberately SYNCHRONOUS: a shutdown
              // notice must not block behind a stalled writer, and the abort
              // below is what wakes that writer.
              writeRaw(formatFrame(chatStreamError(reason || 'server shutting down', 'server_error', 'server_shutdown')));
              if (!res.writableEnded) {
                writeRaw('data: [DONE]\n\n');
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
          // V-08: a tick is skipped while a drain is outstanding — the heartbeat
          // may never add bytes or a waiter behind a pressured writer.
          const heartbeat = setInterval(() => {
            if (!res.writableEnded && !writer.pending) writeRaw(': ping\n\n');
          }, HEARTBEAT_MS);
          const stopHeartbeat = () => clearInterval(heartbeat);
          res.on('close', stopHeartbeat);
          // [STREAM-CACHE] replay stored answer as SSE frames, skip upstream.
          // Placed AFTER heartbeat/registerSse wiring (unregisterSse + stopHeartbeat
          // are in scope here) and BEFORE the first upstream attempt, so a hit
          // never burns a pooled account or emits partial bytes.
          if (__sHit) {
            try { if (ccAcct) releaseAccountById(ccAcct.id); } catch {}
            try {
              const _st = applyStop(__sHit.text || '', normalizeStop(body.stop));
              const _txt = _st.hit ? _st.text : (__sHit.text || '');
              const _finishReason = __sHit.finishReason || 'stop';
              const _cachedStop = _st.hit ? _st.stop : (__sHit.stop || null);
              const _display = __sHit.displayModel || connectDisplayModel;
              // D4/V-27: no upstream turn ran, so nothing here is upstream
              // consumption. The cached usage still rides the client's frames
              // (it describes the answer it is replaying), but the dashboard
              // ledger must not be charged again and the row is marked
              // cache-served. Charging it made N identical requests report N
              // upstream turns and N credit charges.
              recordRequest(_display, true, 0, null, { cacheServed: true });
              const _use = __sHit.usage || cachedUsage(messages, _txt);
              await send({ id: ccId, object: 'chat.completion.chunk', created: ccCreated, model: _display,
                choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
              if (__sHit.thinking) {
                await send({ id: ccId, object: 'chat.completion.chunk', created: ccCreated, model: _display,
                  choices: [{ index: 0, delta: { reasoning_content: __sHit.thinking }, finish_reason: null }] });
              }
              if (_txt) {
                await send({ id: ccId, object: 'chat.completion.chunk', created: ccCreated, model: _display,
                  choices: [{ index: 0, delta: { content: _txt }, finish_reason: null }] });
              }
              const _finishChoice = { index: 0, delta: {}, finish_reason: _finishReason };
              if (context?.__messagesStopCarrier === true && _cachedStop && _finishReason === 'stop') {
                _finishChoice._windsurf_stop_sequence = _cachedStop;
              }
              await send({ id: ccId, object: 'chat.completion.chunk', created: ccCreated, model: _display,
                choices: [_finishChoice] });
              if (connectMeta.includeUsage) {
                await send({ id: ccId, object: 'chat.completion.chunk', created: ccCreated, model: _display,
                  choices: [], usage: _use });
              }
              if (!res.writableEnded) {
                await writer.settle();
                writeRaw('data: [DONE]\n\n');
                res.end();
              }
            } catch (e) { log.info('[STREAM-CACHE-ERR] replay ' + (e && e.message)); }
            unregisterSse();
            stopHeartbeat();
            return;
          }
          // Run one account through the stream, with same-account re-login as the
          // first recovery step. Returns 'ok', 'dead' (token unrecoverable on this
          // account → caller may fail over), or 'error' (non-recoverable). Every
          // recovery is gated on !emitted: once bytes are on the wire a replay
          // would duplicate content, so we surface the error instead.
          const attemptStream = async (a) => {
            const params = a ? { ...connectParams, token: a.apiKey, deviceSeed: ensureDeviceSeed(a) } : connectParams;
            // D2/V-10: a schema-constrained turn cannot be judged frame by frame
            // — the verdict needs the whole payload, and the adapter writes every
            // delta the moment it arrives. Buffer this attempt's frames instead of
            // putting them on the wire: they are flushed in order once the payload
            // conforms, and a non-conforming turn is replaced by one typed error.
            // `emitted` therefore stays false until the flush, so pre-flush
            // recovery (re-login, account failover) can still replay safely.
            const schemaFrames = jsonSchema ? [] : null;
            const sink = schemaFrames ? (data) => { schemaFrames.push(data); } : send;
            try {
              const _sr = await streamChatCompletion(params, sink, connectMeta);
              // Dashboard token-usage breakdown from the streaming connect path
              // (the return value carries the terminal usage). Was discarded
              // before → "Token 用量分布" empty on connect deployments.
              // Attribute under the SERVED name (connectDisplayModel), the same
              // name the response body/chunks carry and the non-stream arm files
              // under — reqModelName split one conversation across two buckets on
              // a degrade or a router hop (P2-6).
              try { recordTokenUsage(_sr?.usage, connectDisplayModel); } catch {}
              // K8: attribute the spend to THIS account (per-account lifetime total).
              // Pass the whole reservation, not its apiKey: the credential may have
              // rotated while the stream was in flight, and the ledger belongs to
              // the immutable account id (review #3).
              try { recordAccountSpend(a, _sr?.usage, connectSpendOpts(_sr?.billing)); } catch {}
              finalizeConnectAccount(a, { model: connectDisplayModel, selector, startTime: ccStart, err: null });
              return { kind: 'ok', sr: _sr, frames: schemaFrames };
            } catch (err) {
              // Client or server-level abort: the caller is gone (or the process
              // is shutting down). Don't penalize the account, don't log a scary
              // ERROR, and don't burn quota on more retries/failover.
              if (abortController.signal.aborted || isAbortError(err)) {
                finalizeConnectAccount(a, { model: connectDisplayModel, selector, startTime: ccStart, err: err || Object.assign(new Error('client disconnected'), { name: 'AbortError' }), aborted: true });
                return { kind: 'abort' };
              }
              // Transport retries belong to the adapter (devin-connect-openai
              // owns ONE bounded pre-emit retry for 5xx/ECONNRESET). The handler
              // owns ACCOUNT failover only — replaying the same token here as
              // well made a single 5xx cost three upstream attempts (adapter
              // maxRetries + this replay + failover).
              if (err.code === 'UNAUTHORIZED' && a && !emitted) {
                // No force: honor the 60s re-login cooldown. Concurrent callers
                // still coalesce on the inflight promise (auth.js), so a dead
                // token recovers once; sequential bursts within the window reuse
                // that result instead of each firing a fresh Auth1 login — the
                // cutover-day storm guard. force:true is reserved for the
                // scheduled liveness sweep, which is already interval-throttled.
                // The signal bounds only the QUEUED wait for a login slot, so a
                // client that disconnected stops consuming the queue.
                // Skip recovery when the pool rotated this account's key while
                // the attempt was in flight: the 401 belongs to the retired
                // credential. A re-login would overwrite the fresh key
                // (penalizing the new epoch for the old one's failure), and
                // finalize's epoch guard suppresses the auth penalty. The
                // failover loop moves on instead.
                if (credentialEpochCurrent(a)) {
                  const freshKey = await reLoginAccount(a.id, { signal: abortController.signal }).catch(() => false);
                  if (freshKey && !emitted) {
                    log.info(`Chat[${reqId}]: DEVIN_CONNECT re-login recovered token, replaying stream once`);
                    try {
                      // The first attempt may have buffered frames before it hit
                      // the 401; the replay replaces them, never appends.
                      if (schemaFrames) schemaFrames.length = 0;
                      const _sr3 = await streamChatCompletion({ ...connectParams, token: freshKey }, sink, connectMeta);
                      try { recordTokenUsage(_sr3?.usage, connectDisplayModel); } catch {}
                      // Billing identity is the account, not the credential: the
                      // retry presented freshKey, but the row belongs to a.id.
                      try { recordAccountSpend({ accountId: a.id, apiKey: freshKey, attemptId: a.reservationTimestamp }, _sr3?.usage, connectSpendOpts(_sr3?.billing)); } catch {}
                      finalizeConnectAccount(a, { model: connectDisplayModel, selector, startTime: ccStart, err: null, credentialKey: freshKey });
                      return { kind: 'ok', sr: _sr3, frames: schemaFrames };
                    } catch (retryErr) {
                      // Client disconnected while re-login was in flight — stop cleanly.
                      if (abortController.signal.aborted || isAbortError(retryErr)) {
                        finalizeConnectAccount(a, { model: connectDisplayModel, selector, startTime: ccStart, err: retryErr || Object.assign(new Error('client disconnected'), { name: 'AbortError' }), aborted: true, credentialKey: freshKey });
                        return { kind: 'abort' };
                      }
                      // Fresh token still UNAUTHORIZED ⇒ entitlement wall, not a dead
                      // session (see non-stream path). Reclassify as MODEL_BLOCKED so
                      // we surface a clean error instead of storming re-login +
                      // failover across the pool. Gated on !emitted as always.
                      const reErr = (retryErr.code === 'UNAUTHORIZED' && !emitted)
                        ? Object.assign(new Error('model requires a paid Devin entitlement (fresh session token still UNAUTHORIZED → not a dead token)'), { code: 'MODEL_BLOCKED' })
                        : retryErr;
                      finalizeConnectAccount(a, { model: connectDisplayModel, selector, startTime: ccStart, err: reErr, signal: abortController.signal, credentialKey: freshKey });
                      log.error(`Chat[${reqId}]: DEVIN_CONNECT stream retry error: ${reErr.message}`);
                      return { kind: 'error', err: reErr };
                    }
                  }
                }
                finalizeConnectAccount(a, { model: connectDisplayModel, selector, startTime: ccStart, err, signal: abortController.signal });
                return !emitted ? { kind: 'dead' } : { kind: 'error', err };
              }
              finalizeConnectAccount(a, { model: connectDisplayModel, selector, startTime: ccStart, err, signal: abortController.signal });
              log.error(`Chat[${reqId}]: DEVIN_CONNECT stream error: ${err.message}`);
              return { kind: 'error', err };
            }
          };
          try {
            let acct = ccAcct;
            let lastOkSr = null;
            for (let hops = 0; ; hops++) {
              // Client gone (disconnect or shutdown abort): stop before touching
              // another pooled account. Without this the failover loop keeps
              // hopping fresh accounts — burning quota and holding in-flight
              // slots — to a socket that will never read the bytes. Checked at
              // the top of every iteration so it gates each hop, not just the
              // first attempt.
              if (abortController.signal.aborted) {
                log.info(`Chat[${reqId}]: DEVIN_CONNECT stream aborted (client gone) — stopping account failover`);
                // REF-3 (audit #2/#3): `acct` was acquired (ccAcct before the
                // loop, or the failover `next` on a prior hop's continue) but
                // NOT yet attempted this iteration, so attemptStream →
                // finalizeConnectAccount never ran to release its in-flight slot.
                // Breaking here without releasing leaks that slot until the
                // acquire-time reservation ages out (≤15min), shrinking the
                // usable pool under client-disconnect churn. Release by id (never
                // by apiKey — a background re-login swaps the pool object's key,
                // REF-1) with NO penalty and NO recordRequest: an aborted,
                // never-attempted request is neither an account fault nor a
                // completed request. This is the ONLY unfinalized-account break;
                // the post-attempt abort check below runs after attemptStream has
                // already finalized `acct`, so releasing there would double-free.
                if (acct) releaseAccountById(acct.id);
                break;
              }
              // A spent budget must stop the failover chain before it acquires
              // and burns another account. The adapter consumes turns per
              // upstream attempt; this covers a hop that would start with none
              // left (or after the deadline passed during the last attempt).
              if (context.budget && !context.budget.canStartAttempt()) {
                const stop = budgetExceededError(`request budget exhausted before DEVIN_CONNECT stream failover hop ${hops + 1} (${context.budget.describe()})`);
                log.warn(`Chat[${reqId}]: ${stop.message}`);
                if (acct) releaseAccountById(acct.id);
                await send(chatStreamError(stop.message, 'upstream_deadline_exceeded', 'DEADLINE_EXCEEDED'));
                break;
              }
              if (acct) triedKeys.push(acct.apiKey);
              const r = await attemptStream(acct);
              if (r.kind === 'ok') {
                terminalOk = true;
                lastOkSr = r.sr;
                // DELIVERY GATE. attemptStream resolves normally when the
                // upstream turn completed even if the client vanished inside the
                // final-write window (`send()` no-ops on a closed socket, and the
                // upstream signal abort races the completed turn). Committing
                // the pair-chain, binding prompt-cache affinity, or storing the
                // response cache for a turn the client never received poisons the
                // NEXT turn: session-continuity overlap assumes the answer was
                // delivered, and the cache would replay it. The Cascade path
                // already gates every one of these on !abortController.signal
                // .aborted; this arm had no such check. Account-side success in
                // finalizeConnectAccount stays unconditional — the upstream turn
                // really ran and cost quota.
                if (abortController.signal.aborted) {
                  log.info(`Chat[${reqId}]: DEVIN_CONNECT stream completed after the client disconnected — skipping session commit, cache write and affinity`);
                } else {
                  if (r.frames) {
                    // D2/V-10: the buffered payload is the only place a schema
                    // verdict can be formed. A miss closes the turn exactly like
                    // the Cascade stream does: one typed error frame, no stop, no
                    // [DONE], and nothing cached or committed. Usage and account
                    // spend were already recorded in attemptStream — the upstream
                    // turn really ran; only its answer is unusable. A turn that
                    // delivered tool calls has no JSON payload to judge (same rule
                    // as the Cascade arm), so it keeps its normal terminal.
                    const deliveredText = r.sr?.delivered ?? r.sr?.content ?? '';
                    const hasToolCalls = (r.sr?.toolCalls?.length || 0) > 0;
                    const violation = (deliveredText || !hasToolCalls)
                      ? structuredOutputViolation(deliveredText, jsonSchema)
                      : null;
                    if (violation) {
                      log.warn(`Chat[${reqId}]: structured output does not conform (${violation.path}: ${violation.message}) — closing the stream with a typed error`);
                      terminalOk = false;
                      await send(chatStreamError(
                        `The model's answer does not conform to the requested JSON Schema (${violation.path}: ${violation.message}).`,
                        'server_error',
                        'STRUCTURED_OUTPUT_NOT_CONFORMING',
                      ));
                      break;
                    }
                    // Conforming: release the held frames in their original order,
                    // through the same sequential writer as any other frame.
                    for (const frame of r.frames) await send(frame);
                    r.frames.length = 0;
                  }
                  // Pin this conversation to the account that just served it, so the
                  // next turn reads the prompt cache back instead of re-writing it.
                  // Complementary to the pair-chain commit below: that keeps the
                  // upstream session_id stable, this keeps the ACCOUNT stable — the
                  // prompt cache lives on the account, so without both the next turn
                  // still lands elsewhere and re-writes the whole context.
                  bindConnectSticky(callerKey, acct, selector);
                  // Session continuity: commit the completed request→response pair
                  // from the streamed result so the next turn resolves to this same
                  // session_id via pair-chain overlap. Gate-checked + best-effort
                  // (no-op when reuse is off). r.sr is threaded from every success
                  // path (initial, transient replay, re-login retry) so the commit
                  // fires even after an upstream wobble — exactly when reuse helps.
                  try {
                    // Session continuity hashes the message pair (session-continuity
                    // canonicalize(): name + id + args). The NEXT turn's
                    // `connectMessages` carries the WIRE name, because this handler
                    // renames history before the wire — so the committed assistant
                    // turn must carry the same spelling, or the pair never matches
                    // and a fresh session_id is minted after every rewritten call.
                    // Ids are untouched by the name map and already client-normalized
                    // by the adapter, so `r.sr.toolCalls` is exactly the right shape.
                    const tc = r.sr?.toolCalls;
                    const commitMsgs = [...connectMessages, {
                      role: 'assistant',
                      content: r.sr?.content || '',
                      ...(tc?.length ? { tool_calls: tc.map((t, idx) => ({ id: t.id || `tc_${idx}`, function: { name: t.name, arguments: t.argumentsJson || t.arguments || '' } })) } : {}),
                    }];
                    commitConnectSession(callerKey || '', commitMsgs, undefined, { reasoning: r.sr?.reasoning || incomingConnectReasoning });
                  } catch { /* session commit is best-effort */ }
                  // [STREAM-CACHE] store full text + usage AFTER commit, BEFORE the
                  // loop-exit break (code after break is unreachable).
                  try {
                    const _sTxt = r.sr?.delivered ?? r.sr?.content ?? '';
                    const _sTc = r.sr?.toolCalls;
                    if (__sCkey && _sTxt && !(_sTc && _sTc.length)) {
                      const _sSt = applyStop(_sTxt, normalizeStop(body.stop));
                      cacheSet(__sCkey, { text: _sSt.hit ? _sSt.text : _sTxt, thinking: r.sr?.reasoning || '', stop: _sSt.hit ? _sSt.stop : (r.sr?.stop || null), finishReason: r.sr?.finish_reason || null, displayModel: connectDisplayModel, usage: r.sr?.usage || null });
                      log.info('[STREAM-CACHE-STORE] ckey=' + __sCkey);
                    }
                  } catch (e) { log.info('[STREAM-CACHE-ERR] store ' + (e && e.message)); }
                }
                break;
              }
              // #225: a client-gone abort is not an account fault — stop the
              // failover loop without penalty. No session commit here: the pair
              // never completed, so committing would poison the chain with a
              // half-turn that the next request could never match.
              if (r.kind === 'abort') {
                log.info(`Chat[${reqId}]: DEVIN_CONNECT stream aborted (client gone) — not failing over`);
                break;
              }
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
                  const next = await acquireConnectFailover(triedKeys, abortController.signal, callerKey, selector, context.budget || null);
                  if (next) {
                    log.info(`Chat[${reqId}]: DEVIN_CONNECT ${r.err.code} on account → stream failover hop ${hops + 1} to next pooled account`);
                    bumpConnect(r.err.code === 'SELECTOR_NOT_ELIGIBLE' ? 'selector_failover_hops' : 'quota_failover_hops');
                    acct = next;
                    continue;
                  }
                }
                // Preserve the 429 class on the streaming wire: `api_error` is
                // not what OpenAI SDKs back off on. The internal name is mapped
                // to the official `rate_limit_error` by the egress normalizer.
                // SELECTOR_NOT_ELIGIBLE keeps the same type the non-stream path
                // gets from connectErrorToHttp (403 model_not_available) instead
                // of collapsing into a generic upstream_error. REQUEST_REJECTED
                // is a 400-class caller fault, so it carries
                // invalid_request_error rather than a retryable upstream_error.
                const streamErrType = r.err.code === 'RATE_LIMITED' ? 'rate_limit_exceeded'
                  : (r.err.code === 'SELECTOR_NOT_ELIGIBLE' ? 'model_not_available'
                  : (r.err.code === 'REQUEST_REJECTED' ? 'invalid_request_error' : 'upstream_error'));
                const retryAfterMs = r.err.code === 'RATE_LIMITED'
                  ? (Number.isFinite(r.err.resetMs) && r.err.resetMs > 0 ? r.err.resetMs : getBreakerTunable('rlBurstMs'))
                  : null;
                await send(chatStreamError(r.err.message, streamErrType, r.err.code || null,
                  retryAfterMs ? { retry_after_ms: retryAfterMs } : null));
                break;
              }
              // r.kind === 'dead' — guaranteed !emitted, so a fresh account is safe.
              if (acct) reportDeadToken(currentApiKeyForId(acct.id, acct.apiKey));
              bumpConnect('dead_tokens');
              // SessionReauth: a chat 401 is NOT proof the token was retired —
              // the non-stream path documents an entitlement wall that is
              // byte-for-byte indistinguishable from one. One free GetUserStatus
              // probe decides; fire-and-forget (de-duped inside auth.js) so
              // failover never waits on it.
              if (acct) requestReauthCheck(acct.id, { source: 'request' }).catch(() => {});
              if (hops >= maxHops || emitted) { bumpConnect('failover_exhausted'); await send(chatStreamError('all DEVIN_CONNECT accounts exhausted (dead session tokens)', 'upstream_error', 'UNAUTHORIZED')); break; }
              const next = await acquireConnectFailover(triedKeys, abortController.signal, callerKey, selector, context.budget || null);
              if (!next) { bumpConnect('failover_exhausted'); await send(chatStreamError('all DEVIN_CONNECT accounts exhausted (dead session tokens)', 'upstream_error', 'UNAUTHORIZED')); break; }
              log.info(`Chat[${reqId}]: DEVIN_CONNECT failover hop ${hops + 1} → next pooled account`);
              bumpConnect('failover_hops');
              acct = next;
            }
            if (leakTraceEnabled()) {
              log.info('LEAK_TRACE settle', {
                reqId,
                model: connectDisplayModel,
                provider: null,
                // Why the fields are empty matters on the failure exits: this
                // log runs on EVERY loop exit, including error and abort paths
                // where lastOkSr never got set. An all-empty row without the
                // outcome reads as "traced, nothing found" — it is not.
                outcome: lastOkSr ? 'ok' : (abortController.signal.aborted ? 'client-abort' : 'upstream-error'),
                contentChars: (lastOkSr?.content ?? '').length,
                reasoningChars: (lastOkSr?.reasoning ?? '').length,
                rerouted: false,
                thinkInContent: thinkMarkersIn(lastOkSr?.content),
                sample: leakSample(lastOkSr?.content),
                durationMs: Date.now() - ccStart,
              });
            }
            // If the client already disconnected, don't try to write to a dead
            // socket — that can leave the handler stuck on a closed connection.
            // A pre-content error (`!terminalOk && !contentEmitted`) ends without
            // [DONE], so a client cannot mistake it for a completed turn.
            // V-08: the sentinel is part of the same sequential emission — it
            // must not overtake a frame the socket has not taken yet.
            if (!abortController.signal.aborted && !res.writableEnded) {
              if (terminalOk || contentEmitted) {
                await writer.settle();
                writeRaw('data: [DONE]\n\n');
              }
              res.end();
            }
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
      const params = a ? { ...connectParams, token: a.apiKey, deviceSeed: ensureDeviceSeed(a) } : connectParams;
      try {
        const out = await toChatCompletion(params, connectMeta);
        finalizeConnectAccount(a, { model: connectDisplayModel, selector, startTime: ccStart, err: null });
        return { kind: 'ok', out };
      } catch (err) {
        // Client or server-level abort: don't penalize the account or log ERROR.
        if ((context.signal?.aborted) || isAbortError(err)) {
          finalizeConnectAccount(a, { model: connectDisplayModel, selector, startTime: ccStart, err: err || Object.assign(new Error('client disconnected'), { name: 'AbortError' }), aborted: true });
          return { kind: 'abort' };
        }
        if (err.code === 'UNAUTHORIZED' && a) {
          // No force — see the streaming path: honor the 60s cooldown so a
          // mass token-death event recovers each account once instead of
          // storming Auth1 with one full login per in-flight request.
          // The request signal bounds the queued wait for a login slot only.
          //
          // Skip recovery when the pool rotated this account's key while the
          // attempt was in flight: the 401 belongs to the retired credential.
          // A re-login would overwrite the fresh key, and finalize's epoch
          // guard suppresses the auth penalty. Fail over instead.
          if (credentialEpochCurrent(a)) {
            const freshKey = await reLoginAccount(a.id, { signal: context.signal }).catch(() => false);
            if (freshKey) {
              log.info(`Chat[${reqId}]: DEVIN_CONNECT re-login recovered token, retrying once`);
              try {
                const out = await toChatCompletion({ ...connectParams, token: freshKey }, connectMeta);
                finalizeConnectAccount(a, { model: connectDisplayModel, selector, startTime: ccStart, err: null, credentialKey: freshKey });
                return { kind: 'ok', out };
              } catch (retryErr) {
                // Client aborted during the re-login retry.
                if ((context.signal?.aborted) || isAbortError(retryErr)) {
                  finalizeConnectAccount(a, { model: connectDisplayModel, selector, startTime: ccStart, err: retryErr || Object.assign(new Error('client disconnected'), { name: 'AbortError' }), aborted: true, credentialKey: freshKey });
                  return { kind: 'abort' };
                }
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
                finalizeConnectAccount(a, { model: connectDisplayModel, selector, startTime: ccStart, err: reErr, signal: context.signal, credentialKey: freshKey });
                log.error(`Chat[${reqId}]: DEVIN_CONNECT retry-after-relogin error (${reErr.code || 'UPSTREAM_ERROR'}): ${reErr.message}`);
                return { kind: 'error', err: reErr };
              }
            }
          }
          finalizeConnectAccount(a, { model: connectDisplayModel, selector, startTime: ccStart, err, signal: context.signal });
          return { kind: 'dead' };
        }
        finalizeConnectAccount(a, { model: connectDisplayModel, selector, startTime: ccStart, err, signal: context.signal });
        return { kind: 'error', err };
      }
    };
    // [STREAM-CACHE] non-stream replay: same slot as the stream path (the key
    // is stream-agnostic). Releases the acquired account and returns without
    // touching upstream. usage rides along when stored (usage passthrough),
    // otherwise falls back to cachedUsage estimation like the inner cache.
    if (__sHit) {
      try { if (ccAcct) releaseAccountById(ccAcct.id); } catch {}
      const _nst = applyStop(__sHit.text || '', normalizeStop(body.stop));
      const _ntxt = _nst.hit ? _nst.text : (__sHit.text || '');
      const _nfinishReason = __sHit.finishReason || 'stop';
      const _ncachedStop = _nst.hit ? _nst.stop : (__sHit.stop || null);
      const _nuse = __sHit.usage || cachedUsage(messages, _ntxt);
      const _nmodel = __sHit.displayModel || connectDisplayModel;
      // D4/V-27: same rule as the stream replay — the client keeps the cached
      // usage block, the upstream ledger and the credit card are untouched.
      try { recordRequest(_nmodel, true, 0, null, { cacheServed: true }); } catch {}
      const _nmsg = { role: 'assistant', content: _ntxt };
      if (__sHit.thinking) _nmsg.reasoning_content = __sHit.thinking;
      const _nchoice = { index: 0, message: _nmsg, finish_reason: _nfinishReason };
      if (context?.__messagesStopCarrier === true && _ncachedStop && _nfinishReason === 'stop') _nchoice._windsurf_stop_sequence = _ncachedStop;
      log.info('[STREAM-CACHE-HIT] non-stream replay ckey=' + __sCkey);
      return { status: 200, body: { id: ccId, object: 'chat.completion', created: ccCreated, model: _nmodel,
        system_fingerprint: systemFingerprint(_nmodel), choices: [_nchoice], usage: _nuse } };
    }
    let acct = ccAcct;
    for (let hops = 0; ; hops++) {
      if (context.signal?.aborted) {
        if (acct) releaseAccountById(acct.id);
        log.info(`Chat[${reqId}]: DEVIN_CONNECT non-stream aborted (client gone) — not failing over`);
        return { status: 499, body: { error: { message: 'Client closed request', type: 'client_disconnect', code: 'client_disconnect' } } };
      }
      if (context.budget && !context.budget.canStartAttempt()) {
        const stop = budgetExceededError(`request budget exhausted before DEVIN_CONNECT non-stream failover hop ${hops + 1} (${context.budget.describe()})`);
        log.warn(`Chat[${reqId}]: ${stop.message}`);
        if (acct) releaseAccountById(acct.id);
        const { status, type } = connectErrorToHttp('DEADLINE_EXCEEDED');
        return { status, body: { error: { message: stop.message, type, code: 'DEADLINE_EXCEEDED' } } };
      }
      if (acct) triedKeys.push(acct.apiKey);
      const r = await attempt(acct);
      if (r.kind === 'ok') {
        // V-10: a schema-constrained turn that does not conform is a failure, and
        // it must be reported BEFORE the cache write / session commit / affinity
        // pin — otherwise the next chained turn inherits a payload the caller
        // never accepted.
        const connectViolation = structuredOutputViolation(r.out?.body?.choices?.[0]?.message?.content, jsonSchema);
        if (connectViolation) {
          log.warn(`Chat[${reqId}]: structured output does not conform (${connectViolation.path}: ${connectViolation.message}) — returning a typed failure`);
          return structuredOutputError(connectViolation);
        }
        // Same cache-affinity pin as the streaming path above.
        bindConnectSticky(callerKey, acct, selector);
        // Feed the dashboard token-usage breakdown from the DEVIN_CONNECT path
        // too. Without this the non-stream connect responses never reached
        // recordTokenUsage (only the cascade paths did), so the "Token 用量分布"
        // card stayed empty on connect-only deployments (homecloud). Safe no-op
        // when usage is absent (recordTokenUsage guards null).
        // The adapter stamps the SERVED name on the body; the fallback is the same
        // attribution name the stream arm and finalizeConnectAccount use (P2-6).
        try { recordTokenUsage(r.out?.body?.usage, r.out?.body?.model || connectDisplayModel); } catch {}
        // K8: per-account lifetime spend (non-stream connect path).
        try { recordAccountSpend(acct, r.out?.body?.usage, connectSpendOpts(r.out?.body?._windsurf_billing)); } catch {}
        // Session continuity: commit the completed request→response pair so the
        // next turn resolves to this session_id via pair-chain overlap. The
        // response tool_calls already ride the OpenAI function shape here.
        // Gate-checked + best-effort (no-op when reuse is off).
        //
        // This runs BEFORE `restoreOutToolNames` on purpose. `canonicalize()` hashes
        // the tool name, and the NEXT turn's `connectMessages` carries the WIRE
        // spelling (this handler renames history before the wire). Committing the
        // caller's spelling here made the pair never match, so a new session_id was
        // minted after every rewritten tool call.
        try {
          const msg = r.out?.body?.choices?.[0]?.message;
          const commitMsgs = [...connectMessages, {
            role: 'assistant',
            content: msg?.content || '',
            ...(msg?.tool_calls ? { tool_calls: msg.tool_calls } : {}),
          }];
          commitConnectSession(callerKey || '', commitMsgs, undefined, { reasoning: msg?.reasoning_content || incomingConnectReasoning });
        } catch { /* session commit is best-effort */ }
        // [STREAM-CACHE] store non-stream text + usage BEFORE the return
        // (code after return is unreachable).
        try {
          const _nMsg = r.out?.body?.choices?.[0]?.message;
          const _nTxt = _nMsg?.content;
          if (__sCkey && typeof _nTxt === 'string' && _nTxt && !(_nMsg?.tool_calls?.length)) {
            const _nSt = applyStop(_nTxt, normalizeStop(body.stop));
            cacheSet(__sCkey, { text: _nSt.hit ? _nSt.text : _nTxt, thinking: _nMsg?.reasoning_content || '', stop: _nSt.hit ? _nSt.stop : (r.out?.stop || null), finishReason: r.out?.body?.choices?.[0]?.finish_reason || null, displayModel: connectDisplayModel, usage: r.out?.body?.usage || null });
            log.info('[STREAM-CACHE-STORE] ckey=' + __sCkey);
          }
        } catch (e) { log.info('[STREAM-CACHE-ERR] store ' + (e && e.message)); }
        // G1 client leg: everything above (pair-chain, cache, billing) has already
        // consumed the response, so restore the caller's own tool names last.
        return restoreOutToolNames(r.out);
      }
      if (r.kind === 'abort') {
        log.info(`Chat[${reqId}]: DEVIN_CONNECT non-stream aborted (client gone) — not failing over`);
        // Return a 499 Client Closed Request; if the response socket is already
        // gone the route handler will drop it harmlessly.
        return { status: 499, body: { error: { message: 'Client closed request', type: 'client_disconnect', code: 'client_disconnect' } } };
      }
      if (r.kind === 'error') {
        // R1: QUOTA_EXHAUSTED / RATE_LIMITED are ACCOUNT dry-wells — the offending
        // account was just cooled by finalizeConnectAccount, so if the pool still
        // has another account, move the request there instead of handing the client
        // a 402/429 while healthy accounts sit idle. Non-stream is always replay-safe
        // (nothing reached the client yet). Exhausted pool → fall through to surface.
        if (isAccountFailoverError(r.err.code) && hops < maxHops) {
          const next = await acquireConnectFailover(triedKeys, context.signal, callerKey, selector, context.budget || null);
          if (next) {
            log.info(`Chat[${reqId}]: DEVIN_CONNECT ${r.err.code} on account → failover hop ${hops + 1} to next pooled account`);
            bumpConnect(r.err.code === 'SELECTOR_NOT_ELIGIBLE' ? 'selector_failover_hops' : 'quota_failover_hops');
            acct = next;
            continue;
          }
        }
        // Map the classified upstream code to the right HTTP status/type so a
        // free-tier /upgrade rejection reads as 402 model_blocked, an auth failure
        // as 401, and a rate limit as 429 — not a blanket 502.
        const { status, type } = connectErrorToHttp(r.err.code);
        log.error(`Chat[${reqId}]: DEVIN_CONNECT error (${r.err.code || 'UPSTREAM_ERROR'} -> ${status}): ${r.err.message}`);
        return { status, body: { error: {
          message: r.err.message,
          type,
          code: r.err.code || null,
          ...(r.err.param ? { param: r.err.param } : {}),
        } } };
      }
      // r.kind === 'dead' — the session token couldn't be revived on this account.
      if (acct) reportDeadToken(currentApiKeyForId(acct.id, acct.apiKey));
      bumpConnect('dead_tokens');
      // Two-signal rule (same as the stream path): the free GetUserStatus probe
      // decides whether the token is really retired, and only that verdict
      // benches the account.
      if (acct) requestReauthCheck(acct.id, { source: 'request' }).catch(() => {});
      if (hops >= maxHops) {
        const { status, type } = connectErrorToHttp('UNAUTHORIZED');
        log.error(`Chat[${reqId}]: DEVIN_CONNECT failover exhausted after ${hops} hop(s)`);
        bumpConnect('failover_exhausted');
        return { status, body: { error: { message: 'all DEVIN_CONNECT accounts exhausted (dead session tokens)', type, code: 'UNAUTHORIZED' } } };
      }
      const next = await acquireConnectFailover(triedKeys, context.signal, callerKey, selector, context.budget || null);
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

  // ── V-14: Cascade completion controls ────────────────────────────────
  // The Cascade wire has exactly ONE caller-tunable completion control:
  // `max_output_tokens` (CascadePlannerConfig field 6). temperature / top_p /
  // top_k have no verified field on that message, so this route used to accept
  // them and drop them — the client believed its sampling took effect and the
  // model ran at the built-in defaults. Reject instead, exactly as the T1 gate
  // above does for seed/penalties/logit_bias: a 400 the caller can act on beats
  // a success that quietly ignored the request. The Devin Connect backend DOES
  // honour all three (buildCompletionConfig), so the message says so.
  const cascadeCompletion = useCascade && Number.isFinite(max_tokens)
    ? { maxTokens: max_tokens }
    : null;
  if (useCascade) {
    const unhonorable = [];
    if (Number.isFinite(body.temperature)) unhonorable.push('temperature');
    if (Number.isFinite(body.top_p)) unhonorable.push('top_p');
    if (Number.isFinite(body.top_k)) unhonorable.push('top_k');
    if (unhonorable.length) {
      log.warn(`Chat[${reqId}]: rejecting Cascade request — unhonorable completion control(s): ${unhonorable.join(', ')}`);
      return {
        status: 400,
        body: {
          error: {
            message: `Unsupported completion parameter(s) on the Cascade backend: ${unhonorable.join(', ')}.`
              + ' The Cascade wire exposes no sampling control, so this proxy rejects them rather than silently'
              + ' dropping them (which would look like they took effect). Remove them, or use the Devin Connect'
              + ' backend (DEVIN_CONNECT=1), which honours temperature, top_p and top_k.',
            type: 'invalid_request_error',
            param: unhonorable[0],
          },
        },
      };
    }
  }

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
  // Full candidate history: the wire call sites trim it to the delta when a
  // cascade is reused, and `emulationMessages` carries the unmapped pairs the
  // bridge cannot encode.
  const nativeHistory = nativeBridgeOn
    ? buildNativeToolHistory(messages || [])
    : null;
  const nativeAdditionalSteps = nativeHistory ? nativeHistory.steps : [];
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
  // mapped tool_result turns become additional_steps[9] entries on the
  // proto, so their call/result pairs are removed from the conversation
  // text to avoid duplicate context. Unmapped calls, lossy translations and
  // orphan tool results stay and are folded by the emulation normalizer —
  // the bridge must not discard history it cannot encode (V-13 / KH-034).
  let cascadeMessages;
  if (nativeBridgeOn) {
    const retained = nativeHistory?.emulationMessages || [];
    const hasToolHistory = retained.some(m => m?.role === 'tool'
      || (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length));
    cascadeMessages = hasToolHistory
      ? normalizeMessagesForCascade(retained, emulationTools, {
          // The proto-level tool_calling_section already carries the unmapped
          // tool definitions; this call only folds their history to text.
          injectUserPreamble: false,
          modelKey: routingModelKey,
          provider: modelInfo?.provider || null,
          route: body.__route || 'chat',
          toolChoice: tool_choice,
        })
      : retained;
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
    // Index of the newest pending tool round inside additionalSteps; the wire
    // call sites slice from here when the cascade is reused.
    deltaStart: nativeHistory ? nativeHistory.deltaStart : 0,
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
    // Namespace check (#234/#258): this is the CASCADE gate's suggestion list and
    // it must keep resolving from getTierModels('free') — the same source the
    // gate above reads, via the summary's non-connect branch. Do NOT "align" it
    // with the connect-side DROUGHT_SAFE_SELECTORS: Cascade cannot route those
    // selectors, so naming them here would offer models that error out.
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
  // PERF (2026-09-13): this key hashes `JSON.stringify(normalize(body))` — measured at
  // 1.09 ms for a 400-message body and 2.96 ms for a 4 MB image on this box — and it was
  // computed TWICE per request: once in handleChatCompletions (:2778, before any fallback
  // rewrite, threaded in as context.__originalCkey) and again here.
  //
  // Reuse the outer value when it describes the same request:
  //   - `__fallbackAttempt` means body.model was rewritten downstream, so the inner key is
  //     MEANT to differ from the original one (the H-3 design: look up the fallback model
  //     but write the result into the original slot).
  //   - the outer key is computed before any body mutation, so when this is not a fallback
  //     attempt the two inputs are identical.
  // Anything else computes fresh. This is an optimisation, never a behaviour change.
  const reuseOriginalCkey = typeof context.__originalCkey === 'string'
    && context.__originalCkey
    && !context.__fallbackAttempt;
  const ckey = reuseOriginalCkey ? context.__originalCkey : cacheKey(body, callerKey);
  // SEC-W2: only share the response cache ACROSS requests when the caller has a
  // trustworthy per-user scope. A guessed `:client:` bucket (shared key behind a
  // proxy) must never serve one user's cached answer to another — treat it as
  // cache-private (skip get+set) so there is zero cross-tenant leak by default.
  const cacheShareable = hasPerUserScope(callerKey);

  // Detach P1: a byte-identical retry may resume this turn. The key covers the
  // body + trusted scope + every output-affecting route decision; it is NOT
  // the handler's `ckey` (that is null when the response cache is disabled,
  // which must not disable detach). `hasPerUserScope` is the one authoritative
  // tenancy gate; the registry never re-implements it.
  const detachKeyValue = cascadeDetachEnabled() && hasPerUserScope(callerKey)
    ? detachedKey(body, callerKey, {
        scopeTrusted: true,
        route: body.__route || 'chat',
        modelKey: routingModelKey,
        toolPreambleTier: preambleTier || null,
        emulateTools,
        native: nativeOpts,
        stop: normalizeStop(body.stop),
        displayModel,
      })
    : null;

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
      // V-10: the JSON Schema the caller constrained this turn to, if any. The
      // stream buffers JSON content anyway, so a non-conforming payload can still
      // be reported honestly instead of closed as a clean stop.
      jsonSchema,
      // V-14: the caller's completion controls, for the local output cap.
      completion: cascadeCompletion,
      // O1: OpenAI only emits the trailing usage-only chunk when the caller opts
      // in via stream_options.include_usage:true; otherwise a streamed response
      // carries no usage frame. Passing this through lets streamResponse honor it
      // instead of unconditionally sending usage (which made some clients
      // double-count billing). Internal accounting (recordTokenUsage) still runs
      // regardless — only the client-facing frame is gated.
      includeUsage: body.stream_options?.include_usage === true,
      // SEED-C3b: the Cascade stream path had no local stop enforcement at all
      // (the Devin wire has no stop field), so the caller's `stop` was silently
      // ignored here while the Connect adapter honored it.
      stop: normalizeStop(body.stop),
      fpOpts: buildReuseOpts({ tools: effectiveTools, toolChoice: tool_choice, toolPreamble, preambleTier, emulateTools, route: body.__route || 'chat' }),
      tools: effectiveTools,
      route: body.__route || 'chat',
      nativeOpts,
      allowCascadeMetadataUnwrap,
      context,
      ensureLs: context.ensureLs,
      getLsFor: context.getLsFor,
      WindsurfClient: context.WindsurfClient,
      detachKey: detachKeyValue,
      // Lease seams for the resume path (tests inject a fake LS entry; the
      // production context leaves these undefined and the module helpers win).
      getLsEntryByPort: context.getLsEntryByPort,
      beginLsUse: context.beginLsUse,
      endLsUse: context.endLsUse,
      acquireLsUse: context.acquireLsUse,
    });
  }

  // ── Local response cache (exact body match) ─────────────
  // SEC-W2: skip cross-request cache reads for an untrusted (guessed) scope.
  const cached = cacheShareable ? cacheGet(ckey) : null;
  if (cached) {
    log.info(`Chat: cache HIT model=${displayModel} flow=non-stream`);
    recordRequest(displayModel, true, 0, null);
    // SEED-C3b: a replay must obey the caller's `stop` too. Entries written by
    // this build already store the visible text plus the cause; an entry from an
    // older build (or any raw text) is re-enforced here rather than replayed
    // verbatim.
    const replayed = applyStop(cached.text || '', normalizeStop(body.stop));
    const cachedStop = replayed.hit ? replayed.stop : (cached.stop || null);
    const cachedText = replayed.hit ? replayed.text : (cached.text || '');
    const message = { role: 'assistant', content: cachedText || null };
    if (cached.thinking) message.reasoning_content = cached.thinking;
    const choice = { index: 0, message, finish_reason: 'stop' };
    if (context.__messagesStopCarrier === true && cachedStop) choice._windsurf_stop_sequence = cachedStop;
    return {
      status: 200,
      body: {
        id: chatId, object: 'chat.completion', created, model: displayModel,
        system_fingerprint: systemFingerprint(displayModel),
        service_tier: DEFAULT_SERVICE_TIER,
        choices: [choice],
        usage: cachedUsage(messages, cachedText),
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

  // A checked-out entry has been REMOVED from the pool (conversation-pool.js
  // checkout), so it is not TTL-healed: poolCheckin is the only way back, and a
  // return that skips it loses the cascade permanently — the caller's next turn
  // then pays a full history replay (a prompt-cache WRITE is ~5.6x a read). Every
  // exit between the checkout above and the end of this function must funnel
  // through this gate. It is the same predicate the end-of-loop restore block has
  // always used, extracted so an early return cannot silently bypass it.
  const restoreCheckedOutReuse = (why) => {
    if (reuseEntryDead || !checkedOutReuseEntry || !fpBefore) return false;
    poolCheckin(fpBefore, checkedOutReuseEntry, callerKey, ttlHintFromCachePolicy(cachePolicy));
    log.info(`Chat[${reqId}]: restored checked-out cascade after ${why}`);
    return true;
  };

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
      // Exhausted pool at t=0: no amount of queueing can free an account whose
      // soonest cooldown is minutes out. Answer immediately with the same 429
      // the connect route's preflight produces instead of stalling for 30 s.
      const exhausted = poolExhaustedFailure(routingModelKey);
      if (exhausted) {
        log.info(`Chat[${reqId}]: non-stream pool exhausted at admission (retry_after=${exhausted.retryAfterMs}ms) → fast-fail`);
        // The entry was checked out before admission; this return is one of the
        // early exits that used to drop it. Nothing ran upstream, so the cascade
        // is exactly as it was when checked out.
        restoreCheckedOutReuse('exhausted-pool admission fast-fail');
        return {
          status: 429,
          headers: { 'Retry-After': String(clientRetryAfterSeconds(exhausted.retryAfterMs)) },
          body: { error: { message: `${displayModel} 账号队列耗尽: ${exhausted.reason}`, type: 'rate_limit_exceeded', retry_after_ms: exhausted.retryAfterMs } },
        };
      }
      // GAP-2: thread the request signal into the queue wait so a disconnected
      // caller bails instead of queueing for (and then pinning) an account it
      // will never use. No-signal callers keep the previous null — the
      // resolve-null contract is unchanged (abort ⇒ null, like a queue timeout).
      const waitMs = budgetWaitMs(context.budget, QUEUE_MAX_WAIT_MS);
      acct = context.signal
        ? await waitForAccountFn(tried, context.signal, waitMs, routingModelKey, callerKey)
        : await waitForAccountFn(tried, null, waitMs, routingModelKey, callerKey);
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
            : `${Math.ceil(waitMs / 1000)} 秒内没有账号变为可用 — 账号可能被速率限制或对当前模型无权限`;
          const retryAfterMs = queueTimeoutRetryAfterMs(tempUnavail, rateLimited);
          lastErr = {
            status: (tempUnavail.allUnavailable || rateLimited.allLimited) ? 429 : 503,
            // A busy (not limited) pool also frees on the queue cadence, so the
            // 503 arm carries the same hint as the 429 arm.
            headers: { 'Retry-After': String(clientRetryAfterSeconds(retryAfterMs)) },
            body: { error: { message: `${displayModel} 账号队列超时: ${reason}`, type: (tempUnavail.allUnavailable || rateLimited.allLimited) ? 'rate_limit_exceeded' : 'pool_exhausted', retry_after_ms: retryAfterMs } },
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
      try { recordAccountAttempt(acct, { model: displayModel, outcome: 'connection_error', status: e.status || 503 }); } catch {}
      break;
    }
    const ls = getLsForFn(acct.proxy);
    if (!ls) {
      lastErr = { status: 503, body: { error: { message: 'No LS instance available', type: 'ls_unavailable' } } };
      try { recordAccountAttempt(acct, { model: displayModel, outcome: 'connection_error', status: 503 }); } catch {}
      break;
    }
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
      // A07/KH-004: pass the EFFECTIVE list, not the raw request tools[]. The
      // stream path already receives effectiveTools (deps.tools below); the
      // non-stream path used the raw list, so tool_choice:'none' or a forced
      // choice was enforced in the preamble but not in any parse/recovery
      // filter — a fake XML/thinking call for an excluded tool still surfaced.
      emulateTools, toolPreamble, wantJson, cachePolicy, wantThinking, effectiveTools, body.__route || 'chat',
      nativeOpts,
      // v2.0.88 (audit H-3) — when this is the inner-pass of an auto-
      // fallback retry, the outer wrapper threads the ORIGINAL request's
      // ckey through context.__originalCkey. We pass it down so the
      // success-path cacheSet writes under the original key as well —
      // next identical original-model request hits cache instead of
      // re-burning the rate-limit + fallback cycle.
      reqId,
      cacheShareable ? (context.__originalCkey || null) : null,
      clineCompatActive,
      allowCascadeMetadataUnwrap,
      // SEED-C3b: the Cascade non-stream path ignored the caller's `stop` too.
      normalizeStop(body.stop),
      context.__messagesStopCarrier === true,
      // GAP-2: thread the request signal so a client disconnect can stop the
      // in-flight cascade/legacy calls instead of burning LS + account quota.
      context.signal,
      // Route-owned deadline/turn budget: clamps admission waits and the
      // per-attempt upstream spend; see src/request-budget.js.
      context.budget || null,
      // Ledger identity: the immutable account id (the credential may rotate
      // while this turn is in flight; see recordAccountSpend).
      acct.id,
      // V-10: the caller's JSON Schema, checked against the final payload below.
      jsonSchema,
      // V-14: the caller's completion controls (max_tokens), for the local cap.
      cascadeCompletion,
    );
    // Classify the entry's health BEFORE the abort branch can return: a 504 /
    // deadline verdict (or an explicit not_found) marks the cascade half-broken,
    // and restoring it on the way out is the #101 regression regardless of
    // whether the client also left.
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
    if (context.signal?.aborted || result?.body?.error?.code === 'client_disconnect') {
      // The client is gone, but the checked-out cascade's fate depends on what
      // the upstream did. Two shapes share this 499:
      //   - nonStreamResponse's post-call check (the turn COMPLETED, then the
      //     client vanished before the commit) marks reuseEntryRestorable;
      //   - the catch arm (the abort interrupted the turn mid-answer) does not.
      // Restoring the second shape would hand the next request a half-broken
      // trajectory (#101: a trailing tool_result with no user prompt), which
      // test/cascade-abort-side-effects.test.js pins as a deliberate drop. A
      // structured non-499 verdict means the call itself returned an upstream
      // error — the same failed-turn shape the end-of-loop block restores; the
      // gate above still refuses a deadline-dead entry.
      const restorable = result?.reuseEntryRestorable === true
        || (typeof result?.status === 'number' && result.status !== 200 && result.status !== 499);
      if (restorable) {
        restoreCheckedOutReuse('client abort');
      } else {
        log.info(`Chat[${reqId}]: cascade left checked out (client abort interrupted the turn)`);
      }
      return result;
    }
    if (result.status === 200) return result;
    reuseEntry = null; // don't try to reuse on the retry
    lastErr = result;
    const errType = result.body?.error?.type;
    // v2.0.61 (#113): policy_blocked → don't rotate accounts, return
    // immediately. The model refused the request, swapping accounts
    // gives the same refusal but burns more quota.
    if (errType === 'policy_blocked') { recordPolicyBlocked(buildPolicyBlockSample(messages, displayModel, acct?.id || null, context.traceId || null)); restoreCheckedOutReuse('policy block'); return result; }
    // Rate limit: this account is done for this model, try the next one
    if (errType === 'rate_limit_exceeded') {
      recordRateLimited();
      // v2.0.91 — IP-level circuit breaker: when Windsurf upstream
      // rate-limits several accounts for the same model in a tight
      // window, it's usually IP-wide cooldown, not per-account.
      // Burning through all 40+ accounts just marks them all dead
      // for 30 min. Detect and short-circuit.
      //
      // Q5: the window is PROCESS-scoped (src/rate-limit-burst.js), not
      // per-request. A per-request array could never observe a burst that
      // started in an earlier request, so the "IP-level" claim was false and
      // the pool kept burning accounts across requests.
      const burst = recordRateLimitBurstEvent({
        model: routingModelKey,
        account: acct.id,
        cooldownMs: rateLimitBurstCooldownMs({
          message: result.body?.error?.message || '',
          retryAfterMs: result.body?.error?.retry_after_ms,
          apiKey: acct.apiKey,
          modelKey: routingModelKey,
        }),
      });
      if (burst.tripped) {
        const maxCooldown = Math.max(burst.maxCooldownMs, IP_RATE_LIMIT_BURST_FLOOR_MS);
        log.warn(`Chat[${reqId}]: IP-rate-limit burst detected — ${burst.count} accounts rate-limited on ${displayModel} within ${RATE_LIMIT_BURST_WINDOW_MS}ms. Short-circuiting.`);
        restoreCheckedOutReuse('IP-rate-limit burst');
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
      const backoffMs = await internalErrorBackoff(internalCount - 1, context.budget || null);
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
  // A budget/deadline stop outranks the transient-account diagnosis: the chain
  // did not fail because every account was broken, it stopped because the
  // request ran out of time/turns. Returning the last result keeps its 504 and
  // its honest message instead of rewriting it as upstream_transient_error.
  if (lastErr?.body?.error?.type === 'upstream_deadline_exceeded') return lastErr;
  // 所有账号都遇到 Cascade transient 时，账号轮换已经无法修复；返回明确错误，避免误报成限流或模型不可用。
  if (internalCount > 0 && tried.length > 0 && internalCount >= tried.length) {
    restoreCheckedOutReuse('all-internal-error chain');
    const lastIsTransport = isCascadeTransportError(lastErr);
    log.error(`Chat[${reqId}]: ${tried.length}/${tried.length} accounts hit upstream transient error — surfacing upstream_transient_error`);
    return {
      status: 503,
      body: { error: { message: upstreamTransientErrorMessage(displayModel, tried.length, lastIsTransport ? 'cascade_transport' : 'internal_error'), type: 'upstream_transient_error' } },
    };
  }
  // If all accounts exhausted, check if it's because they're all rate-limited
  const temporaryUnavailable = isAllTemporarilyUnavailable(routingModelKey);
  if (temporaryUnavailable.allUnavailable) {
    restoreCheckedOutReuse('temporary unavailability');
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
      restoreCheckedOutReuse('rate limit');
      const retryAfterSec = Math.ceil(rl.retryAfterMs / 1000);
      return { status: 429, headers: { 'Retry-After': String(retryAfterSec) }, body: { error: { message: `${displayModel} 所有账号均已达速率限制，请 ${retryAfterSec} 秒后重试`, type: 'rate_limit_exceeded', retry_after_ms: rl.retryAfterMs } } };
    }
  }
  if (!restoreCheckedOutReuse('failed request') && reuseEntryDead) {
    log.info(`Chat[${reqId}]: reuse entry was invalidated (cascade not_found upstream); not restoring to pool`);
  }
  return lastErr || { status: 503, body: { error: { message: 'No active accounts available', type: 'pool_exhausted' } } };
}

async function nonStreamResponse(client, id, created, model, modelKey, messages, cascadeMessages, modelEnum, modelUid, useCascade, apiKey, ckey, poolCtx, provider, emulateTools, toolPreamble, wantJson = false, cachePolicy = null, wantThinking = false, tools = [], route = 'chat', nativeOpts = null, reqId = 'non-stream', aliasCkey = null, clineCompatActive = false, allowCascadeMetadataUnwrap = true, stopSequences = [], stopCarrier = false, signal = null, budget = null, accountId = '', jsonSchema = null, completion = null) {
  const startTime = Date.now();
  const nativeBridgeOn = !!nativeOpts?.enabled;
  // V-14: local enforcement of the caller's output cap. The wire field is a
  // REQUEST; an upstream that ignores it (or a deployment whose builder never
  // sent it) answered far past a small max_tokens and still reported
  // finish_reason:'stop'. chars/4 is this repo's own token estimator, so the cap
  // is enforced in the same units it already bills in.
  const outputCapChars = Number.isFinite(completion?.maxTokens) && completion.maxTokens > 0
    ? Math.floor(completion.maxTokens * OUTPUT_CHARS_PER_TOKEN)
    : null;
  let outputCapReached = false;
  const applyOutputCap = (text) => {
    if (outputCapChars == null || typeof text !== 'string' || text.length <= outputCapChars) return text;
    outputCapReached = true;
    return text.slice(0, outputCapChars);
  };
  try {
    let allText = '';
    let allThinking = '';
    let cascadeMeta = null;
    let toolCalls = [];
    let hasCompletedNativeReadUrlResult = false;
    let usedNativeReadUrlFallback = false;
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
      const turnErr = takeUpstreamTurn(budget, 'cascade non-stream attempt');
      if (turnErr) {
        return { status: 504, body: { error: { message: turnErr.message, type: 'upstream_deadline_exceeded', code: 'windsurf_provider_deadline' } } };
      }
      const chunks = await client.cascadeChat(cascadeMessages, modelEnum, modelUid, {
        reuseEntry: poolCtx?.reuseEntry || null,
        // V-14: same cap the stream path sends (`completion` is this function's
        // parameter; the outer handler's resolved object is cascadeCompletion).
        completion,
        // Clamp the internal poll window to what the request has left.
        ...(budget ? { maxWaitMs: budget.remainingMs() } : {}),
        toolPreamble: nativeBridgeOn ? '' : toolPreamble,
        nativeEnvironment: nativeBridgeOn ? (nativeOpts?.environment || '') : '',
        displayModel: model,
        nativeMode: nativeBridgeOn,
        nativeAllowlist: nativeOpts?.allowlist || null,
        // D3/V-13: hand over the FULL mapped history plus the index where the
        // newest pending round starts. cascadeChat slices it only while the send
        // continues an existing trajectory — it is the one place that knows a
        // resume was rejected and a fresh cascade was opened, and a fresh cascade
        // must carry every earlier observation again.
        additionalSteps: nativeBridgeOn ? (nativeOpts?.additionalSteps || null) : null,
        additionalStepsFrom: nativeBridgeOn ? (nativeOpts?.deltaStart ?? 0) : 0,
        signal,
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
      // A06/KH-018: the Cascade poll loop can return a truncated or empty turn
      // as a normal array (`max_wait` / `stall_warm` / `idle_empty`). Never let
      // that become a 200 `stop` response or a cache entry. A truncation keeps
      // the partial text but is typed `length`; an empty/failed turn is an
      // upstream error with no successful body.
      if (chunks.endReason != null) {
        const cascadeTerminal = classifyCascadeEnd(chunks.endReason, {
          totalYielded: allText.length,
          totalThinking: allThinking.length,
          toolCallCount: Array.isArray(chunks.toolCalls) ? chunks.toolCalls.length : 0,
        });
        if (!cascadeTerminal.ok) {
          const usage = buildUsageBody(chunks.usage || null, messages, allText, allThinking, cachePolicy);
          recordRequest(model, false, Date.now() - startTime, accountId);
          try { recordAccountAttempt({ id: accountId }, { model, outcome: 'upstream_error', status: cascadeTerminal.status || 502 }); } catch {}
          if (cascadeTerminal.kind === 'truncated') {
            const truncatedMessage = { role: 'assistant', content: allText || null };
            if (allThinking) truncatedMessage.reasoning_content = allThinking;
            return {
              status: 200,
              body: {
                id, object: 'chat.completion', created, model,
                system_fingerprint: systemFingerprint(model),
                service_tier: DEFAULT_SERVICE_TIER,
                choices: [{
                  index: 0,
                  message: truncatedMessage,
                  finish_reason: 'length',
                  _windsurf_end_reason: 'upstream_truncated',
                  _windsurf_truncated: true,
                }],
                usage,
                __windsurf_incomplete: true,
              },
            };
          }
          // Kimi's empty upstream deserves its existing actionable message.
          if (cascadeTerminal.kind === 'empty' && /^kimi/i.test(String(modelKey || '')) && !allText && !allThinking) {
            return {
              status: 502,
              reuseEntryInvalid: true,
              body: { error: {
                message: `${model} 在 Cascade 上游当前不可用（返回空响应）。请换用 claude-sonnet-4.6、gemini-2.5-flash 或 glm-4.7。`,
                type: 'upstream_model_unavailable',
              } },
            };
          }
          return {
            status: cascadeTerminal.status || 502,
            reuseEntryInvalid: true,
            body: { error: {
              message: cascadeTerminal.message,
              type: cascadeTerminal.type,
              code: cascadeTerminal.code,
            } },
          };
        }
      }
      if (nativeBridgeOn) {
        // v2.0.65: planner-native trajectory steps come back via
        // chunks.toolCalls with `cascade_native: true`. Translate each
        // back into the caller's OpenAI tool name + the schema the caller
        // declared. Steps without a caller mapping are dropped — they
        // can't be safely surfaced (caller wouldn't know how to execute).
        const lookup = nativeOpts?.callerLookup || new Map();
        const nativeCalls = [];
        const nativeResults = [];
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
        if (!usedNativeReadUrlFallback) allText = stripToolMarkupFromText(allText);
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
                // The correction is a second upstream turn; skip it (keeping the
                // narrative answer) when the request budget cannot pay for it.
                const retryTurnErr = takeUpstreamTurn(budget, 'non-stream correction retry');
                if (retryTurnErr) log.info(`Chat[non-stream]: NLU retry skipped — ${retryTurnErr.message}`);
                const retryChunks = retryTurnErr ? [] : await client.cascadeChat(correctionMessages, modelEnum, modelUid, {
                  reuseEntry: null,
                  ...(budget ? { maxWaitMs: budget.remainingMs() } : {}),
                  toolPreamble: nativeBridgeOn ? '' : toolPreamble,
                  nativeEnvironment: nativeBridgeOn ? (nativeOpts?.environment || '') : '',
                  displayModel: model,
                  nativeMode: nativeBridgeOn,
                  nativeAllowlist: nativeOpts?.allowlist || null,
                  additionalSteps: nativeOpts?.additionalSteps || null,
                  signal,
                });
                let retryText = '';
                let retryThinking = '';
                for (const c of retryChunks) {
                  if (c.text) retryText += c.text;
                  if (c.thinking) retryThinking += c.thinking;
                }
                // A06/A07 recovery path: a correction retry that itself ended
                // truncated/empty must not be parsed into an executable call
                // (or a "successful" narrative) from a half turn.
                if (retryChunks.endReason != null) {
                  const retryTerminal = classifyCascadeEnd(retryChunks.endReason, {
                    totalYielded: retryText.length,
                    totalThinking: retryThinking.length,
                    toolCallCount: Array.isArray(retryChunks.toolCalls) ? retryChunks.toolCalls.length : 0,
                  });
                  if (!retryTerminal.ok) {
                    log.warn(`Chat[non-stream]: NLU retry ended ${retryChunks.endReason} — discarding its partial output`);
                    retryText = '';
                    retryThinking = '';
                  }
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
      const turnErr = takeUpstreamTurn(budget, 'legacy non-stream attempt');
      if (turnErr) {
        return { status: 504, body: { error: { message: turnErr.message, type: 'upstream_deadline_exceeded', code: 'windsurf_provider_deadline' } } };
      }
      const chunks = await client.rawGetChatMessage(messages, modelEnum, modelUid, { signal });
      for (const c of chunks) {
        if (c.text) allText += c.text;
      }
    }

    // A client disconnect can land after the call resolved but before the turn
    // is committed (the NLU retry and resume-snapshot windows are awaits). The
    // success block below is fully synchronous, so this one check gates the
    // pool check-in, cache write, spend record, and success body: nothing can
    // fire between here and the return. A 499 is the same shape the connect
    // non-stream path returns for a client that left.
    if (signal?.aborted) {
      log.info('Chat[non-stream]: aborted (client gone) — discarding turn');
      return {
        status: 499,
        // The upstream call RESOLVED before this check, so the cascade holds a
        // complete turn: the handler may put the checked-out entry back in the
        // pool. The catch arm below returns the same 499 for a turn the abort
        // INTERRUPTED mid-answer and deliberately omits this marker — restoring
        // that shape would resume a half-broken trajectory (#101).
        reuseEntryRestorable: true,
        body: { error: { message: 'Client closed request', type: 'client_disconnect', code: 'client_disconnect' } },
      };
    }

    // #185 egress hotfix. The shared transform preserves all ordinary JSON,
    // unwraps only the exact Cascade metadata record on an unqualified chat
    // turn, then applies the same path + identity neutralizers ordinary prose
    // has always used. A real tool-call turn is an explicit structured result,
    // so its JSON is never treated as an accidental metadata envelope.
    if (usedNativeReadUrlFallback) {
      // A completed WebFetch document is caller-requested external data, not
      // model narration. Preserve its identity-bearing prose exactly; only the
      // established server-path redaction boundary applies.
      allText = sanitizeText(allText);
    } else {
      allText = transformCascadeEgressText(allText, model, {
        allowMetadataUnwrap: useCascade && allowCascadeMetadataUnwrap,
        hasToolCalls: toolCalls.length > 0,
      });
    }
    if (wantJson && allText && !usedNativeReadUrlFallback) {
      // A capped JSON answer is still cut at the cap: the caller asked for at
      // most N tokens, and the terminal says `length` so the cut is visible.
      allText = applyOutputCap(allText);
      allText = stabilizeJsonPayload(allText, messages);
      // V-10: the projection above no longer invents values, so a payload that
      // misses a schema-required key now stays missing. Say so instead of
      // answering 200 with a body the caller's own validator rejects.
      const violation = structuredOutputViolation(allText, jsonSchema);
      if (violation) {
        log.warn(`Chat[${reqId}]: structured output does not conform (${violation.path}: ${violation.message}) — returning a typed failure`);
        try { recordRequest(model, false, Date.now() - startTime, accountId); } catch {}
        return structuredOutputError(violation);
      }
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

    // SEED-C3b — the caller's `stop`, enforced locally at the FINAL visible prose
    // boundary. The Devin wire has no stop field, so this route used to return
    // the model's full answer including the sentinel and everything after it.
    // Position matters: this runs after the tool-call parse (so structured
    // arguments stay opaque), after the egress/sanitize/shaping transforms, and
    // after any thinking→content promotion — i.e. against exactly the bytes that
    // would otherwise be returned as `content`. The pre-stop text is kept for
    // usage accounting (a stop truncates what the client SEES; the upstream still
    // generated and billed the tokens).
    const usageText = allText;
    // V-14: enforce the cap on the bytes the client will actually receive.
    // `usageText` keeps the PRE-cap text for billing — the upstream generated
    // those tokens even though the caller asked for fewer (same rule as a local
    // stop sequence). A tool-call turn is never cut: the calls are the payload.
    if (!toolCalls.length && !wantJson) allText = applyOutputCap(allText);
    let localStop = null;
    if (!toolCalls.length) {
      const stopped = applyStop(allText, stopSequences);
      if (stopped.hit) { allText = stopped.text; localStop = stopped.stop; }
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

    // P2-1: Cascade's twin of the connect lane's REF-1/REF-2 identity fix
    // (finalizeConnectAccount, 2593). `apiKey` is the acquire-time snapshot and
    // every report*/updateCapability helper in auth.js resolves the account with
    // `accounts.find(a => a.apiKey === apiKey)`, so a mid-flight rotation
    // (dashboard token replace, or a connect re-login on the same shared
    // account) turned these writes into silent no-ops. The ACCOUNT owns its
    // capability/health state, so target the id's CURRENT key (the env-token
    // shape has no id and keeps the snapshot). The success verdict stays on the
    // credential's epoch, exactly like finalizeConnectAccount: an old-key
    // success does not prove the NEW credential works.
    const liveApiKey = currentApiKeyForId(accountId, apiKey);
    const credentialCurrent = credentialEpochCurrent({ id: accountId, apiKey }, apiKey);
    if (credentialCurrent) reportSuccess(liveApiKey);
    updateCapability(liveApiKey, modelKey, true, 'success');
    recordRequest(model, true, Date.now() - startTime, accountId);

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
        && (!allThinking || allThinking.trim().length === 0)
        // SEED-C3b: an empty VISIBLE prefix that a stop sequence produced is a
        // legitimate stopped answer (the caller asked generation to halt at byte
        // zero), not the idle_empty upstream outage this guard exists for.
        && !localStop) {
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
      // SEED-C3b: cache the VISIBLE (post-stop) text together with the local stop
      // cause, so a replay reproduces both the truncated answer and the
      // `stop_sequence` metadata the Messages route derives from it.
      cacheSet(ckey, { text: allText, thinking: allThinking, stop: localStop });
      if (aliasCkey && aliasCkey !== ckey) {
        cacheSet(aliasCkey, { text: allText, thinking: allThinking, stop: localStop });
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
          arguments: clineCompatArgs(tc.argumentsJson || tc.arguments, clineCompatActive),
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
    // `usageText` is the PRE-stop text on purpose: the stop sequence hides bytes
    // from the client, it does not un-generate (or un-bill) them.
    const usage = buildUsageBody(serverUsage, messages, usageText, allThinking, cachePolicy);
    // v2.0.69 (#118): feed bucket totals into stats so dashboard can show
    // fresh_input vs cache_read vs cache_write breakdown.
    try { recordTokenUsage(usage, model); } catch {}
    // K8: per-account lifetime spend (Cascade non-stream path). The account id
    // owns the row; apiKey is only the credential the attempt presented and may
    // have rotated while this turn was in flight (review #3).
    try { recordAccountSpend({ accountId, apiKey }, usage); } catch {}
    const finishReason = outputCapReached ? 'length' : (toolCalls.length ? 'tool_calls' : 'stop');
    const choice = { index: 0, message, finish_reason: finishReason };
    // SEED-C3a carrier on the internal Messages route only (same contract as the
    // Connect adapter): the exact sequence that truncated the visible prose. A
    // tool/tool_calls finish never carries it — only a genuine local stop.
    if (stopCarrier && localStop && finishReason === 'stop') choice._windsurf_stop_sequence = localStop;
    return {
      status: 200,
      body: {
        id, object: 'chat.completion', created, model,
        system_fingerprint: systemFingerprint(model),
        service_tier: DEFAULT_SERVICE_TIER,
        choices: [choice],
        usage,
      },
    };
  } catch (err) {
    // A client disconnect is not a turn failure: cascadeChat throws AbortError
    // and rawGetChatMessage rejects with the same shape when the request
    // signal aborts. Return the established 499 without billing, caching, or
    // counting an upstream fault — the caller's socket is already gone.
    if (signal?.aborted || err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
      log.info('Chat[non-stream]: aborted (client gone) — not billing or caching');
      // The turn did not complete, but the account was asked to serve it — keep
      // that fact in the per-account history at zero cost.
      try { recordAccountAttempt({ id: accountId }, { model, outcome: 'client_abort', status: 499 }); } catch {}
      return {
        status: 499,
        body: { error: { message: 'Client closed request', type: 'client_disconnect', code: 'client_disconnect' } },
      };
    }
    // Only count true auth failures against the account. Workspace/cascade/model
    // errors and transport issues shouldn't disable the key.
    const isAuthFail = /unauthenticated|invalid api key|invalid_grant|permission_denied.*account/i.test(err.message);
    const isRateLimit = /rate limit|rate_limit|too many requests|quota/i.test(err.message);
    const isInternal = /internal error occurred.*(error|trace)\s*id/i.test(err.message);
    // F3: the producer throws the route-budget stop from inside the turn
    // (warmup/StartCascade/Send/retry). Same 504 class as a provider deadline —
    // never a 502 "upstream error", and never an account rotation.
    const isDeadline = isUpstreamDeadlineExceeded(err) || isBudgetExceededError(err);
    const isTransport = isCascadeTransportError(err);
    const isTransient = !isDeadline && isUpstreamTransientError(err, isInternal);
    // v2.0.61 (#113): Anthropic / OpenAI content-policy / verification
    // challenges are NOT transient — rotating accounts won't help and
    // wastes quota. Detect and short-circuit with a clean 451 + clear
    // error so clients stop the retry loop. Patterns are conservative:
    // we only catch unambiguous policy markers, not generic "content
    // moderation" warnings (which can be retried on a different model).
    const isPolicyBlocked = /cyber\s*verification|content[\s_-]+policy|policy[\s_-]+(?:violation|blocked|denied)|safety[\s_-]+(?:policy|blocked)|prompt[\s_-]+(?:rejected|blocked)\s+by[\s_-]+policy|usage[\s_-]+policy[\s_-]+violation/i.test(err.message);
    // audit #8: guard reportError with the SAME transient-first exclusions the
    // ban branch below already uses. The upstream sometimes wraps a transient
    // stall / internal-error / rate-limit in a 401/403 auth shell whose text
    // matches isAuthFail ("unauthenticated ... permission_denied"); counting
    // that against the account's error budget would demote a perfectly healthy
    // account toward eviction on a purely transient blip. Transients must never
    // reach reportError (the invariant reliability rests on). A genuine auth
    // failure (no transient/rate-limit/internal marker) still penalizes as before.
    // P2-1: same identity split as the connect finalizer (2593/2594). The
    // account-level cooldown/capability writes target the id's CURRENT key,
    // while a verdict about the credential that failed stays on the epoch that
    // produced it (a retired key's 401 must not charge the fresh key).
    const liveApiKey = currentApiKeyForId(accountId, apiKey);
    const credentialCurrent = credentialEpochCurrent({ id: accountId, apiKey }, apiKey);
    if (isAuthFail && !isRateLimit && !isInternal && !isTransient && credentialCurrent) reportError(liveApiKey);
    if (isRateLimit) { markRateLimited(liveApiKey, rateLimitCooldownMs(err.message), modelKey); err.isRateLimit = true; err.isModelError = true; err.kind ||= 'model_error'; }
    if (isInternal) { if (credentialCurrent) reportInternalError(liveApiKey); err.isModelError = true; err.kind ||= 'transient_stall'; }
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
      if (credentialCurrent) reportBanSignal(liveApiKey, err.message);
      err.isModelError = true; err.kind ||= 'auth_error';
    }
    if (err.isModelError && err.kind !== 'transient_stall' && !isRateLimit && !isInternal) {
      updateCapability(liveApiKey, modelKey, false, 'model_error');
    }
    // Per-account history: one failed row per failed attempt, attributed to the
    // account that was asked to serve it. Cost fields are zero by construction,
    // so a failure can never move the billed summary.
    try {
      const verdict = isRateLimit ? { outcome: 'rate_limited', status: 429 }
        : isDeadline ? { outcome: 'upstream_error', status: 504 }
        : isPolicyBlocked ? { outcome: 'policy_blocked', status: 451 }
        : (isTransport || isTransient) ? { outcome: 'connection_error', status: 502 }
        : { outcome: 'upstream_error', status: err.isModelError ? 403 : 502 };
      recordAccountAttempt({ id: accountId }, { model, ...verdict });
    } catch {}
    recordRequest(model, false, Date.now() - startTime, accountId);
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
            // A route-budget stop has its own specific message; replacing it
            // with the ~240 s provider-deadline text would misreport why the
            // request ended (same rule the stream path already applies).
            message: isBudgetExceededError(err) ? sanitizeText(err.message) : upstreamDeadlineExceededMessage(model),
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
  const getLsEntryByPortFn = deps.getLsEntryByPort || getLsEntryByPort;
  const beginLsUseFn = deps.beginLsUse || beginLsUse;
  const acquireLsUseFn = deps.acquireLsUse || acquireLsUseOrThrow;
  const endLsUseFn = deps.endLsUse || endLsUse;
  const ClientClass = deps.WindsurfClient || WindsurfClient;
  // Detach P1 is available only for a Cascade turn with a trusted-scope key
  // and no native bridge (P1 admits no tool/native turn).
  const detachKeyValue = deps.detachKey || null;
  // Route-owned request budget (src/request-budget.js). Null for direct
  // callers that predate it (tests, embedders); every use below is guarded.
  const budget = deps.budget || deps.context?.budget || null;
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
  // SEED-C3b: the caller's normalized `stop` for this stream. Declared here (not
  // next to the gate below) because the cache-replay branch — which runs first —
  // must fence a stored answer the same way a fresh turn is fenced.
  const stopSequences = Array.isArray(deps.stop) ? deps.stop : [];
  // Cline compat active for this stream? Resolved at the edge, threaded via
  // deps.context. Falsy for every non-Cline request → emit stays byte-identical.
  const clineCompatActive = !!deps.context?.clineCompat?.active;
  // v2.0.65 (#115) — native tool bridge handles. Stream path consumes the
  // same shape as nonStreamResponse: `{enabled, allowlist, additionalSteps,
  // callerLookup, callerTools}`. When enabled, stream emits cascade-native
  // trajectory steps directly as OpenAI tool_call deltas (the planner is in
  // DEFAULT mode and proposes view_file / run_command / grep_search_v2 / find
  // / list_dir as first-class steps, not as <tool_call> markup in text).
  const nativeOpts = deps.nativeOpts || null;
  const nativeBridgeOn = !!nativeOpts?.enabled;
  // Detach P1: only a Cascade turn with a trusted-scope key. The native bridge
  // is excluded outright (P1 admits no native/tool turn), and the producer
  // additionally refuses any turn that emitted a tool chunk.
  const detachEnabled = !!detachKeyValue && useCascade && !nativeBridgeOn;
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
      // Detach P1 cause classification. Only a genuine client-gone may admit
      // an entry: a shutdown or drain timeout means the client may still be
      // reading, or the process is going away. Set BEFORE abort() so the
      // producer's handle reads the right cause.
      let detachCause = null;
      res.on('close', () => {
        if (!res.writableEnded) {
          if (detachCause === null) detachCause = drainTimedOut ? 'drain_timeout' : 'client_gone';
          log.info('Client disconnected mid-stream, aborting upstream');
          abortController.abort();
        }
      });
      // `resumeClaim` is the claimed registry entry for THIS request, if any.
      // It is also what makes the producer's handle switch from "admit a new
      // entry" to "release the claimed entry back to running" on a re-detach.
      let resumeClaim = null;
      // Port of the LS lease acquired for a claimed resume. Ownership moves to
      // the producer at the `leaseHeld` call; until then this handler's finally
      // is the only release, so a synchronous throw between `beginLsUse` and
      // the producer cannot leak `activeRequests` (which would pin the entry
      // from idle reaping and maintenance).
      let resumeLeasePort = null;
      // Delivery ledger: every tool call that reached the client — native
      // bridge, emulated <tool_call> markup, NLU recovery, or a tail lift from
      // thinking — is pushed here before its delta is written. The producer
      // only sees raw chunks, so markup is invisible to it; detach admission
      // must ask this handler (D2).
      const collectedToolCalls = [];
      const turnDeliveredToolCalls = () => collectedToolCalls.length > 0;
      // Release a claim that survived to an abort/throw. A resumed turn that
      // already delivered a tool call is NOT re-frozen: the frozen prefix
      // predates the call, so a retry would replay it under a fresh id and
      // re-execute it. Drop the entry instead; the retry goes upstream.
      const releaseResumeClaim = (snapshot) => {
        if (!resumeClaim) return;
        if (turnDeliveredToolCalls()) {
          detachedRegistry.evict(resumeClaim.key, 'resume_miss', resumeClaim.token);
        } else {
          detachedRegistry.release(resumeClaim.key, resumeClaim.token, {
            state: 'running',
            snapshot,
          });
        }
        resumeClaim = null;
      };
      const detachHandle = detachEnabled ? {
        // Read by the producer before it freezes anything. A turn that already
        // delivered a tool call must never enter the no-tool cache: the replay
        // presents the same call under a fresh id, and a client that executed
        // the first one can execute it again.
        hasToolCalls: turnDeliveredToolCalls,
        admit: (snapshot, pin) => {
          // Defence in depth: the producer checks hasToolCalls first, but the
          // admission boundary refuses on its own authority too. This covers
          // the resume re-detach path: the frozen prefix predates the call, so
          // re-freezing it would replay that call under a new id.
          if (turnDeliveredToolCalls()) return { refused: 'tools' };
          if (resumeClaim) {
            // A resumed request may only re-detach on a genuine client-gone;
            // a shutdown/drain is handled by the registry drain.
            if (detachCause !== 'client_gone') return { refused: detachCause || 'not_client_gone' };
            // Re-detach: replace the claimed snapshot, keep the original TTL.
            const ok = detachedRegistry.release(resumeClaim.key, resumeClaim.token, {
              state: 'running',
              snapshot,
            });
            return ok ? { token: null } : { refused: 'release_failed' };
          }
          const pinDeadline = Number.isFinite(pin?.deadline) ? pin.deadline : Infinity;
          const budgetDeadline = Number.isFinite(budget?.deadline) ? budget.deadline : Infinity;
          const deadline = Math.min(pinDeadline, budgetDeadline);
          // The registry is the ONE funnel: it counts not_client_gone /
          // draining / no_deadline refusals too.
          return detachedRegistry.admit({
            key: detachKeyValue,
            callerKey,
            snapshot,
            pin: { ...pin, deadline: Number.isFinite(deadline) ? deadline : null },
            cause: detachCause || 'unknown',
          });
        },
      } : null;
      const fp = systemFingerprint(model);
      // O10: 仅直连 OpenAI 客户端(route==='chat')归一化 error.type;
      // messages/gemini/responses 路由须保留内部词供下游 translator remap。
      const isOpenAIClient = (fpOpts?.route || 'chat') === 'chat';

      // ── Writer backpressure (C2 / V-08) ─────────────────────────────────
      // The contract lives in ../stream-writer.js so every SSE exit (Cascade,
      // Connect, Messages/Responses translators) shares one implementation
      // instead of each route re-deriving it. See that module for the rules:
      // one outstanding drain wait, never resend the false frame, race the wait
      // against close/error/abort, re-check gone before every write.
      //
      // Armed only for the Cascade producer: it is the only consumer that can
      // await (src/client.js awaits onChunk). The legacy rawGetChatMessage
      // channel consumes onChunk synchronously from a gRPC data callback and
      // cannot hold its producer, so arming it there would let onEnd overtake an
      // unfinished emission. Legacy backpressure stays exactly as it is.
      const backpressureArmed = useCascade;
      // Set once a drain has timed out: the stream is over, so no later write
      // may start a fresh wait (and a fresh timer) behind it. The writer owns
      // that latch; this mirror exists for the detach cause below.
      let drainTimedOut = false;
      const maxDrainWaitMs = resolveMaxDrainWaitMs();
      const writer = createBoundedWriter({
        res,
        signal: abortController.signal,
        enabled: backpressureArmed,
        maxWaitMs: maxDrainWaitMs,
        onTimeout: () => {
          drainTimedOut = true;
          log.warn(`Chat[${reqId}]: no drain for ${maxDrainWaitMs}ms — client stopped reading, aborting the stream`);
          // Best effort: the client is not reading, but a relay may be.
          writeRaw(formatFrame(chatStreamError(
            'client stopped reading; the stream was aborted after the drain timeout',
            'server_error',
            'DRAIN_TIMEOUT',
          )));
          detachCause = 'drain_timeout';
          abortController.abort(new Error('drain timeout'));
        },
      });
      const writerGone = () => writer.gone();
      const awaitWriter = () => writer.awaitDrain();
      const settleWriter = () => writer.settle();
      // A throwing write is left to propagate: the existing failure stages own
      // its diagnosis, and re-classifying it here would change how a broken
      // socket is reported. Closed/aborted is a separate, pre-checked state.
      const writeRaw = (text) => writer.write(text);
      // Writes one SSE frame. Sequential callers await it; the write happens
      // only after any outstanding drain, and only once. Returns undefined on
      // the unarmed (legacy) path so that consumer stays fully synchronous.
      const writeFrame = (text) => writer.writeFrame(text);

      const formatFrame = (data) => {
        // O9/O12: 给每个 chat.completion.chunk 注入合成 system_fingerprint 与
        // service_tier:'default'; error 帧不动。幂等 —— 已带值则不覆盖。
        applyChatCompletionCompatFields(data, fp);
        if (isOpenAIClient && data && data.error && typeof data.error.type === 'string') {
          data.error.type = normalizeOpenAIErrorType(data.error.type);
        }
        return `data: ${JSON.stringify(data)}\n\n`;
      };
      const send = (data) => writeFrame(formatFrame(data));
      unregisterSse = registerSseController({
        abort(reason) {
          // Detach P1: the response is ended BEFORE the abort below, so the
          // close hook sees writableEnded and never classifies this as a
          // client-gone. Set the cause explicitly for defence in depth.
          detachCause = 'shutdown';
          // Best effort only, and deliberately SYNCHRONOUS: a shutdown notice
          // must not block behind a stalled writer, and the abort below is what
          // wakes that writer. Writing after the abort would be dropped.
          writeRaw(formatFrame(chatStreamError(reason || 'server shutting down', 'server_error', 'server_shutdown')));
          writeRaw('data: [DONE]\n\n');
          if (!res.writableEnded) res.end();
          abortController.abort(reason);
        },
      });

      // SSE heartbeat: keep the TCP/HTTP connection alive through any silent
      // period (LS warmup, Cascade "thinking"). `:` prefix is a comment line per
      // the SSE spec — clients ignore it, intermediaries see bytes flowing,
      // idle timers get reset.
      //
      // Started lazily, AFTER admission. The heartbeat is also the first write
      // the deferred commit gate sees, and the gate arms its silence timer on
      // the first write; ticking during a queue wait would therefore commit
      // `200 text/event-stream` before the pool's answer (429/503) is known —
      // the measured P0. A cache replay starts it directly (no admission).
      // C2: a tick is skipped while a drain is outstanding — the heartbeat may
      // never add bytes or a waiter behind a pressured writer.
      let heartbeat = null;
      const stopHeartbeat = () => {
        if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        // Drop the listener with the timer: it closes over `res`, and a
        // finished stream must not leave per-response listeners behind.
        res.removeListener?.('close', stopHeartbeat);
      };
      const startHeartbeat = () => {
        if (heartbeat || res.writableEnded) return;
        heartbeat = setInterval(() => {
          if (res.writableEnded || writer.pending) return;
          // A heartbeat that reports backpressure is the same signal as any other
          // frame: the writer arms the single drain wait so the producer cannot
          // keep feeding a socket the client has stopped reading.
          writeRaw(': ping\n\n');
        }, HEARTBEAT_MS);
        heartbeat.unref?.();
        res.on('close', stopHeartbeat);
      };

      // ── Cache hit: replay stored response as a fake stream ──
      // SEC-W2: skip cross-request cache reads for an untrusted (guessed) scope.
      const cached = cacheShareable ? cacheGet(ckey) : null;
      if (cached) {
        log.info(`Chat: cache HIT model=${model} flow=stream`);
        startHeartbeat();
        recordRequest(model, true, 0, null);
        // SEED-C3b: the replay obeys the caller's `stop` like a fresh turn does.
        // This build caches the visible text + the cause; an entry from an older
        // build (or any raw text) is re-enforced here instead of replayed
        // verbatim. Reasoning is not prose-matched.
        const replayed = applyStop(cached.text || '', stopSequences);
        const cachedStop = replayed.hit ? replayed.stop : (cached.stop || null);
        const replayedText = replayed.hit ? replayed.text : (cached.text || '');
        try {
          // C2: the replay is a producer like any other — every frame goes
          // through the same one-outstanding-write gate, and the terminal DONE
          // cannot overtake a frame the socket has not accepted yet.
          await send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
          if (cached.thinking) {
            await send({ id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { reasoning_content: cached.thinking }, finish_reason: null }] });
          }
          if (replayedText) {
            await send({ id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { content: replayedText }, finish_reason: null }] });
          }
          const replayChoice = { index: 0, delta: {}, finish_reason: 'stop' };
          if (deps.context?.__messagesStopCarrier === true && cachedStop) replayChoice._windsurf_stop_sequence = cachedStop;
          await send({ id, object: 'chat.completion.chunk', created, model,
            choices: [replayChoice] });
          // O1: only the include_usage opt-in gets the trailing usage frame.
          if (deps.includeUsage) {
            await send({ id, object: 'chat.completion.chunk', created, model,
              choices: [], usage: cachedUsage(messages, replayedText) });
          }
          await awaitWriter();
          writeRaw('data: [DONE]\n\n');
          if (!res.writableEnded) res.end();
        } catch (err) {
          // A client that vanished while the replay was waiting gets no further
          // bytes and no error frame — teardown owns the response.
          if (!err?.isClientAbort) throw err;
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
      // Stable attribution for the request-log row: `currentApiKey` is the
      // credential the attempt presented and may rotate mid-flight; the
      // immutable id is what the ledger and the log must key on.
      let currentAccountId = null;
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

      // SEED-C3b — the caller's `stop`, enforced locally on the stream. The Devin
      // wire has no stop field, so this route used to deliver the sentinel and
      // everything after it. ONE gate per stream, shared by every content sink
      // (live deltas, dedup/buffered/cache flushes, released tails, and the
      // thinking→content promotion): a stop sequence may straddle two chunks, so
      // the gate withholds a (maxSeqLen-1)-char tail until it can prove no
      // sequence starts there, and after a hit it swallows everything, including
      // later tails. `accText` keeps the FULL generated text for usage
      // accounting; only the visible bytes are fenced.
      const contentGate = new StopSequenceGate(stopSequences);
      let stopMatched = null;
      // Text actually handed to the client on the content channel (pre-hit only,
      // plus the gate's released tail). Used as the cached text only when a stop
      // truncated the answer, so a replay reproduces the fenced view.
      let visibleText = '';
      // V-14: local output cap. The wire field is a request, not a guarantee —
      // this path used to stream the full turn and close with 'stop' even when
      // the caller asked for a handful of tokens. Enforced on the DELIVERED
      // bytes, in the same chars/4 units the usage estimator bills in.
      const outputCapChars = Number.isFinite(deps.completion?.maxTokens) && deps.completion.maxTokens > 0
        ? Math.floor(deps.completion.maxTokens * OUTPUT_CHARS_PER_TOKEN)
        : null;
      let outputCapReached = false;
      // C2: every content sink awaits the frame it hands to the writer, so a
      // pressured socket holds the caller instead of accumulating frames.
      const emitVisibleContent = async (out) => {
        if (!out) return;
        if (!wantJson && outputCapChars != null) {
          // A JSON payload is capped once, before shaping (see the wantJson
          // flush) — slicing it here would deliver invalid JSON.
          const room = outputCapChars - visibleText.length;
          if (room <= 0) { outputCapReached = true; return; }
          if (out.length > room) { out = out.slice(0, room); outputCapReached = true; }
        }
        visibleText += out;
        emittedClientPayload = true;
        await send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { content: out }, finish_reason: null }] });
      };
      const emitGatedContent = async (clean) => {
        if (!clean) return;
        if (!contentGate.active) return emitVisibleContent(clean);
        const { emit, hit } = contentGate.push(clean);
        if (hit) stopMatched = contentGate.matched;
        return emitVisibleContent(emit);
      };
      // Release the withheld tail once the turn is over — after every prose
      // fallback/promotion, before the terminal frames. No-op after a hit.
      const flushContentGate = async () => {
        if (!contentGate.active || stopMatched) return;
        const tail = contentGate.flush();
        if (tail) await emitVisibleContent(tail);
      };

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

      // Same lease-leak gate as the non-stream path. poolCheckout REMOVED the
      // entry, so a return that skips poolCheckin loses the cascade permanently
      // (no TTL heal for an entry that is no longer in the pool). The stream gate
      // also requires !hadSuccess: a turn that already emitted bytes is a
      // half-broken trajectory and must never re-enter the pool. This is the
      // predicate the failure tail's `pool-restore` stage already used; it lives
      // here so early returns cannot bypass it.
      const restoreCheckedOutReuse = (why) => {
        if (hadSuccess || reuseEntryDead || !checkedOutReuseEntry || !fpBefore) return false;
        poolCheckin(fpBefore, checkedOutReuseEntry, callerKey, ttlHintFromCachePolicy(cachePolicy));
        log.info(`Chat[${reqId}]: restored checked-out cascade after ${why}`);
        return true;
      };

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
      const completedNativeReadUrlResults = [];
      let usedNativeReadUrlFallback = false;
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

      // Streaming text egress. Ordinary prose still flows through the existing
      // PathSanitizeStream immediately; a syntactically possible JSON object,
      // array, or fenced JSON candidate is bounded-buffered until EOF can prove
      // its caller-visible structure. Only the exact #185 internal envelope is
      // eligible for unwrapping. Thinking keeps its independent path sanitizer.
      let pathStreamText = new CascadeMetadataEgressStream({
        modelName: model,
        allowMetadataUnwrap: useCascade && deps.allowCascadeMetadataUnwrap !== false,
      });
      let pathStreamThinking = new PathSanitizeStream();
      let nativeFunctionParser = nativeBridgeOn
        ? new NativeFunctionCallStreamParser(nativeOpts?.callerLookup || new Map())
        : null;

      // T4 dedup: incremental reasoning/content prefix comparison. Holds only
      // while content byte-matches a prefix of the streamed reasoning; the
      // moment it diverges everything is released. See src/reasoning-dedup.js.
      // WINDSURFAPI_REASONING_DEDUP=0 disables it (see reasoning-dedup.js).
      const reasoningDedup = isReasoningDedupEnabled()
        ? createStreamReasoningDedup({ wantThinking: !!deps.wantThinking })
        : null;
      // #250 — a fresh per-stream classifier. Content bytes that are rerouted to
      // the reasoning channel are excluded from what this path sends, so a
      // classifier must NOT be shared across streams (its pending/mode state is
      // mutated on every feed). Rebuilt on each retry attempt alongside
      // pathStreamText (see the attempt>0 reset block). Off when the gate is
      // off, or in wantJson (JSON is fenced/non-interleaved; a reroute there
      // would strip <think> spans from the payload, changing 5982-5988).
      let thinkClassifier = (useCascade && isCascadeThinkRerouteEnabled() && !wantJson)
        ? new ThinkTextClassifier()
        : null;

      const emitContent = async (clean) => {
        if (!clean) return;
        // #250 — reroute a LEADING think-tagged span out of content into
        // reasoning BEFORE the dedup, so the dedup's prefix tracking sees the
        // post-reroute split and cannot double-transform (a rerouted span feeds
        // the reasoning sink; a verbatim text repeat of it is then a duplicate
        // to suppress, not a fresh reroute). Rerouting calls emitThinking →
        // noteReasoning, which SEEDS seenReasoning — the reason the classifier
        // must run first: fed AFTER the dedup, its rerouted output would look
        // like a duplicate prefix to the dedup and get held.
        if (thinkClassifier) {
          const routed = thinkClassifier.feed(clean);
          if (routed.thinking) {
            // Treat a rerouted span EXACTLY as if upstream had delivered it on
            // the thinking channel, mirroring the chunk.thinking branch below —
            // including its emulateTools special case. In tool-emulation mode
            // thinking must NOT be streamed mid-turn: a reasoning_content delta
            // before a tail tool_call makes Claude Code report "Content block
            // not found". So buffer into accThinking exactly as that branch
            // does, and let the stream-end flush decide. Cascade+emulateTools is
            // the README's Claude Code config, i.e. the live case for #250.
            if (emulateTools) accThinking += routed.thinking;
            else await emitThinking(routed.thinking);
          }
          if (!routed.text) return;
          clean = routed.text;
        }
        accText += clean;
        // When response_format=json_object/json_schema is set, buffer text
        // instead of streaming it out. We can't safely fence-strip in the
        // middle of a stream (fence might straddle a chunk, and we'd need
        // lookahead). On finish we'll emit one clean JSON payload.
        if (wantJson) return;
        // T4 (incremental) — hold only while content byte-matches a prefix of
        // the accumulated reasoning; the moment it diverges, everything held
        // so far plus this chunk is released (see src/reasoning-dedup.js).
        if (reasoningDedup) {
          const { emit, hold } = reasoningDedup.feed(clean);
          if (hold || !emit) return;
          return emitGatedContent(emit);
        }
        // dedup off — pass through the stop gate untouched
        return emitGatedContent(clean);
      };
      const emitExternalContent = async (raw) => {
        const clean = sanitizeText(raw);
        if (!clean) return;
        // Completed WebFetch data is caller-requested external content. It is
        // not model narration, so it bypasses tool parsing, metadata/identity
        // transforms, think classification, reasoning dedup, and JSON shaping.
        usedNativeReadUrlFallback = true;
        accText += clean;
        return emitGatedContent(clean);
      };
      const emitThinking = async (clean, { accumulate = true } = {}) => {
        if (!clean) return;
        if (accumulate) {
          accThinking += clean;
          reasoningDedup?.noteReasoning(clean);
        }
        emittedClientPayload = true;
        await send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { reasoning_content: clean }, finish_reason: null }] });
      };

      const emitToolCallDelta = async (tc, idx) => {
        emittedClientPayload = true;
        await send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: {
            tool_calls: [{
              index: idx,
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: sanitizeText(clineCompatArgs(tc.argumentsJson, clineCompatActive)) },
            }],
          }, finish_reason: null }] });
      };

      const emitNativeFallbackCalls = async (rawCalls) => {
        const filtered = filterToolCallsByAllowlist(rawCalls || [], declaredTools);
        for (const rawTc of filtered) {
          const tc = sanitizeToolCall(repairToolCallArguments(rawTc, messages));
          const idx = collectedToolCalls.length;
          collectedToolCalls.push(tc);
          bridgeDiag.emulatedToolCalls++;
          bridgeDiag.emulatedNames.push(tc.name);
          recordNativeBridgeEmittedToolCall(tc.name, { source: 'provider_xml' });
          await emitToolCallDelta(tc, idx);
        }
        return filtered.length;
      };

      // The producer is held at the chunk boundary: every frame this chunk
      // produced must be accepted by the socket before the next chunk starts.
      const holdChunkBoundary = async () => {
        if (backpressureArmed) await awaitWriter();
      };
      // C2: the per-chunk emission. Sequential — each frame is awaited, so the
      // producer's `await onChunk` (src/client.js) is what holds the Cascade
      // poll loop and its next trajectory RPC while the socket is pressured.
      // Returns a promise; the legacy channel ignores it (and is never armed).
      const emitChunk = async (chunk) => {
        if (!rolePrinted) {
          rolePrinted = true;
          await send({ id, object: 'chat.completion.chunk', created, model,
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
          await holdChunkBoundary();
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
              await emitToolCallDelta(tc, idx);
            }
          } else {
            bridgeDiag.unmappedToolCalls++;
            bridgeDiag.unmappedKinds.push(raw.name);
            recordNativeBridgeUnmappedCascadeToolCall(raw.name);
          }
          await holdChunkBoundary();
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
            const emitted = await emitNativeFallbackCalls(nativeParsed.toolCalls);
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
                  await emitContent(pathStreamText.feed(item.text));
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
                  await emitToolCallDelta(tc, idx);
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
                await emitToolCallDelta(tc, idx);
              }
            }
          }
          if (safeText) await emitContent(pathStreamText.feed(safeText));
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
            await emitThinking(cleanThinking);
          }
        }
        await holdChunkBoundary();
      };

      // C2: serialize emissions. The Cascade producer awaits each call, so the
      // chain is length one there; a legacy data callback that ignores the
      // return value cannot interleave two half-finished emissions.
      let pendingEmission = null;
      const onChunk = (chunk) => {
        const run = pendingEmission
          ? pendingEmission.then(() => emitChunk(chunk))
          : emitChunk(chunk);
        pendingEmission = run;
        return run;
      };

      try {
        // ── Detach P1: lazy resume ──────────────────────────────────────────
        // Precedence: response cache (returned above) → detached registry →
        // upstream. A byte-identical retry claims the frozen entry and continues
        // the ORIGINAL turn's poll loop; nothing is replayed until the first
        // successful steps read proves the cascade survived (see client.js).
        // This block lives inside the try/finally below: a synchronous throw
        // between `beginLsUse` and the producer must still release the lease
        // and end the response.
        if (detachEnabled) {
          const found = detachedRegistry.lookup(detachKeyValue, callerKey);
          if (found) {
            const now = Date.now();
            if (found.state === 'claimed') {
              // `lookup` returns claimed entries by design. Another request
              // holds the CAS claim, so this entry belongs to a live resumer:
              // never evict it and never take its lease. Record the refused
              // CAS and stay foreground with a fresh upstream turn.
              detachedRegistry.claim(detachKeyValue, callerKey);
            } else if (now > found.deadline) {
              detachedRegistry.evict(detachKeyValue, 'deadline', found);
            } else if (now > found.expiresAt) {
              detachedRegistry.evict(detachKeyValue, 'ttl', found);
            } else {
              const lsEntry = getLsEntryByPortFn(found.pin.lsPort);
              const generationMismatch = lsEntry && found.pin.lsGeneration != null
                && lsEntry.generation !== found.pin.lsGeneration;
              if (!lsEntry || generationMismatch) {
                detachedRegistry.evict(detachKeyValue, 'resume_miss', found);
              } else {
                // The request lease covers this request only. The entry itself
                // pins no lease, so between detach and claim the LS is free to
                // be reaped; the re-read of the generation from the object
                // beginLsUse returned catches a restart in that window.
                const leased = beginLsUseFn(found.pin.lsPort);
                if (leased) resumeLeasePort = found.pin.lsPort;
                const leaseMismatch = leased && found.pin.lsGeneration != null
                  && leased.generation !== found.pin.lsGeneration;
                if (!leased || leaseMismatch) {
                  if (leased) {
                    endLsUseFn(found.pin.lsPort);
                    resumeLeasePort = null;
                  }
                  detachedRegistry.evict(detachKeyValue, 'resume_miss', found);
                } else {
                  const claimed = detachedRegistry.claim(detachKeyValue, callerKey);
                  if (claimed.entry) {
                    resumeClaim = {
                      key: detachKeyValue,
                      token: claimed.token,
                      entry: claimed.entry,
                      lsEntry: leased,
                    };
                    log.info(`Chat[${reqId}]: detached turn CLAIMED cascade=${String(found.pin.cascadeId).slice(0, 8)}… stepOffset=${claimed.entry.snapshot.stepOffset}`);
                  } else {
                    // Busy / expired between lookup and claim: stay foreground.
                    endLsUseFn(found.pin.lsPort);
                    resumeLeasePort = null;
                  }
                }
              }
            }
          }
        }

        // Replay the frozen prefix through the stream pipeline — never a direct
        // socket write. `onChunk` runs ToolCallStreamParser + PathSanitizeStream
        // + metadata egress + stop gate + think reroute + reasoning dedup, so the
        // prefix is transformed exactly as the live one was.
        const replayDetachedPrefix = async () => {
          // The last ownership gate before the first byte of a frozen prefix
          // reaches the client. The producer checks after its awaited read;
          // this check closes the window between that read and this write
          // (deadline timer, another request's sweep, account removal). No
          // byte of a claim we no longer own may be replayed.
          if (resumeClaim && !detachedRegistry.owns(resumeClaim.key, resumeClaim.token)) {
            throw detachedClaimLostError('Detached claim ended before the prefix replay');
          }
          let bytes = 0;
          for (const chunk of resumeClaim.entry.snapshot.chunks) {
            await onChunk(chunk);
            bytes += 2 * ((chunk?.text?.length || 0) + (chunk?.thinking?.length || 0));
          }
          detachedRegistry.noteReplay(bytes);
        };

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (abortController.signal.aborted) {
            // The client left between attempts. Nothing was emitted for THIS
            // attempt, and on attempt > 0 the previous attempt's failure tail
            // never ran (the loop `continue`d), so the checkout is still held.
            // Restore it through the same gate the failure tail uses; dropping
            // it here loses the cascade for a turn that never delivered a byte.
            restoreCheckedOutReuse('client abort before the next attempt');
            return;
          }
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
            pathStreamText = new CascadeMetadataEgressStream({
              modelName: model,
              allowMetadataUnwrap: useCascade && deps.allowCascadeMetadataUnwrap !== false,
            });
            pathStreamThinking = new PathSanitizeStream();
            thinkClassifier = (useCascade && isCascadeThinkRerouteEnabled() && !wantJson)
              ? new ThinkTextClassifier()
              : null;
            nativeFunctionParser = nativeBridgeOn
              ? new NativeFunctionCallStreamParser(nativeOpts?.callerLookup || new Map())
              : null;
          }
          let acct = null;
          // Attempt 0 may be the synthetic resume: no account checkout, no
          // ensureLs, no upstream turn. If the cascade turns out to be gone,
          // the catch evicts the entry and continues to a normal attempt.
          const resumeAttempt = attempt === 0 && !!resumeClaim;
          if (!resumeAttempt && reuseEntry && attempt === 0) {
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
          if (!acct && !resumeAttempt) {
            // Exhausted pool at t=0: waiting cannot produce an account, and a
            // 30 s stall would hide the 429 behind a committed stream. Fail the
            // admission now; the deferred gate is still uncommitted, so the
            // error frame below rewrites the HTTP status and Retry-After.
            const exhausted = poolExhaustedFailure(modelKey);
            if (exhausted) {
              log.info(`Chat[${reqId}]: stream pool exhausted at admission (retry_after=${exhausted.retryAfterMs}ms) → fast-fail`);
              lastErr = Object.assign(new Error(`${model} 账号队列耗尽: ${exhausted.reason}`), {
                type: 'rate_limit_exceeded',
                retry_after_ms: exhausted.retryAfterMs,
                status: 429,
              });
              break;
            }
            acct = await waitForAccountFn(tried, abortController.signal, budgetWaitMs(budget, QUEUE_MAX_WAIT_MS), modelKey, callerKey);
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
                  : `${Math.ceil(budgetWaitMs(budget, QUEUE_MAX_WAIT_MS) / 1000)} 秒内没有账号变为可用 — 账号可能被速率限制或对当前模型无权限`;
                lastErr = Object.assign(
                  new Error(`${model} 账号队列超时: ${reason}`),
                  {
                    type: (tempUnavail.allUnavailable || rateLimited.allLimited) ? 'rate_limit_exceeded' : 'pool_exhausted',
                    // The gate can still rewrite the status pre-content; carry a
                    // hint for both the 429 and the 503 arm so the client gets a
                    // Retry-After instead of guessing.
                    retry_after_ms: queueTimeoutRetryAfterMs(tempUnavail, rateLimited),
                  }
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
          // Admission is over: the request can no longer fail with a pool
          // status, so it is safe for the commit gate to start its silence
          // timer on the first heartbeat.
          startHeartbeat();
          if (acct) {
            tried.push(acct.apiKey);
            currentApiKey = acct.apiKey;
            currentAccountId = acct.id;
          } else {
            currentApiKey = null;
            // A synthetic resume has no checked-out account; the stable owner
            // id is the claim's pin, the same identity settleUsage() bills.
            currentAccountId = resumeAttempt ? (resumeClaim?.entry?.pin?.accountId || null) : null;
          }

          try {
            if (!resumeAttempt && nativeBridgeOn && !isNativeBridgeAccountAllowed(acct)) {
              recordNativeBridgeAccountGateSkip();
              log.info(`Chat[${reqId}]: native bridge account gate skipped ${safeAccountRef(acct)}`);
              continue;
            }
          // Pre-flight rate limit check (experimental)
          if (!resumeAttempt && isExperimentalEnabled('preflightRateLimit')) {
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

          let ls;
          if (resumeAttempt) {
            // The claim already holds a request lease on this LS entry; the
            // producer runs with `leaseHeld: true` and releases it in its
            // finally. No ensureLs: the entry exists and was generation-
            // checked, and a fresh spawn would not own the cascade anyway.
            ls = resumeClaim.lsEntry;
          } else {
            try { await ensureLsFn(acct.proxy); } catch (e) {
              lastErr = isLsPoolExhausted(e)
                ? Object.assign(new Error(e.message), { type: 'ls_pool_exhausted', status: e.status || 503 })
                : e;
              try { recordAccountAttempt(acct, { model, outcome: 'connection_error', status: e.status || 503 }); } catch {}
              break;
            }
            ls = getLsForFn(acct.proxy);
            if (!ls) {
              lastErr = new Error('No LS instance available');
              try { recordAccountAttempt(acct, { model, outcome: 'connection_error', status: 503 }); } catch {}
              break;
            }
            if (reuseEntry && reuseEntry.lsPort !== ls.port) {
              log.info(`Chat[${reqId}]: reuse MISS — LS port changed`);
              checkedOutReuseEntry = null;
              reuseEntry = null;
            }
          }
          const _msgCharsStream = (messages || []).reduce((n, m) => {
            const c = m?.content;
            return n + (typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((k, p) => k + (typeof p?.text === 'string' ? p.text.length : 0), 0) : 0);
          }, 0);
          log.info(`Chat: model=${model} flow=${useCascade ? 'cascade' : 'legacy'} stream=true attempt=${attempt + 1} ${resumeAttempt ? 'detached' : safeAccountRef(acct)} ls=${ls.port} turns=${(messages||[]).length} chars=${_msgCharsStream}${reuseEntry ? ' reuse=1' : ''}${resumeAttempt ? ' resume=1' : ''}`);
          // One upstream turn per attempt. The hard cap is per REQUEST, shared
          // with the connect wrapper's internal retries; a spent budget stops
          // the account loop here instead of multiplying it. A resume continues
          // the turn that was already counted before the detach.
          const turnErr = resumeAttempt ? null : takeUpstreamTurn(budget, 'cascade stream attempt');
          if (turnErr) { lastErr = turnErr; break; }
          const client = new ClientClass(resumeAttempt ? '' : acct.apiKey, ls.port, ls.csrfToken);
          let cascadeResult = null;
          const resumeBillingAccountId = resumeAttempt ? resumeClaim.entry.pin.accountId : null;
          const resumeMaxWaitMs = resumeAttempt
            ? Math.min(
                Number.isFinite(budget?.remainingMs?.()) ? budget.remainingMs() : Infinity,
                resumeClaim.entry.deadline - Date.now(),
              )
            : null;
          if (resumeAttempt && !(resumeMaxWaitMs > 0)) {
            detachedRegistry.evict(resumeClaim.key, 'deadline', resumeClaim.token);
            resumeClaim = null;
            // The claim acquired this request's lease; no producer ran to
            // release it.
            endLsUseFn(ls.port);
            resumeLeasePort = null;
            continue;
          }
          // Ownership of the request lease transfers to the producer here:
          // cascadeChat's own finally releases exactly this hold (leaseHeld),
          // including when it throws synchronously before its first await. The
          // handler finally below no longer releases it.
          if (resumeAttempt && useCascade) resumeLeasePort = null;
          try {
            if (useCascade) {
              cascadeResult = await client.cascadeChat(cascadeMessages, modelEnum, modelUid, {
                onChunk, signal: abortController.signal, reuseEntry,
                // V-14: the caller's output cap, threaded to the wire's
                // max_output_tokens and enforced locally below. `deps` is this
                // function's own carrier — the outer handler resolved it.
                completion: deps.completion || null,
                // Clamp the internal poll window to what the request has left.
                ...(resumeAttempt
                  ? {
                      resumeTurn: {
                        cascadeId: resumeClaim.entry.pin.cascadeId,
                        sessionId: resumeClaim.entry.pin.sessionId,
                        snapshot: resumeClaim.entry.snapshot,
                        onFirstRead: replayDetachedPrefix,
                        // Live ownership predicate: the producer checks it
                        // after every awaited trajectory read, so a claim
                        // whose deadline ended mid-read cannot be replayed or
                        // committed as a success.
                        ownsClaim: () => !!resumeClaim
                          && detachedRegistry.owns(resumeClaim.key, resumeClaim.token),
                      },
                      leaseHeld: true,
                      maxWaitMs: resumeMaxWaitMs,
                      detach: detachHandle,
                      acquireLease: acquireLsUseFn,
                      releaseLease: endLsUseFn,
                    }
                  : {
                      ...(budget ? { maxWaitMs: budget.remainingMs() } : {}),
                      accountId: acct?.id || null,
                      modelKey,
                      lsGeneration: ls.generation ?? null,
                      detach: detachHandle,
                    }),
                toolPreamble: nativeBridgeOn ? '' : toolPreamble,
                nativeEnvironment: nativeBridgeOn ? (nativeOpts?.environment || '') : '',
                displayModel: model,
                nativeMode: nativeBridgeOn,
                nativeAllowlist: nativeOpts?.allowlist || null,
                // Same contract as the non-stream path (D3/V-13): the producer
                // receives the full list + the newest-round index and decides per
                // send, so a fresh restart after a dead resume re-sends all rounds.
                additionalSteps: nativeBridgeOn ? (nativeOpts?.additionalSteps || null) : null,
                additionalStepsFrom: nativeBridgeOn ? (nativeOpts?.deltaStart ?? 0) : 0,
              });
            } else {
              await client.rawGetChatMessage(messages, modelEnum, modelUid, {
                // The legacy channel consumes onChunk synchronously and drops the
                // return value. Mark the promise handled so a write failure is
                // reported by the handler's own await below instead of escaping
                // as an unhandled rejection.
                onChunk: (chunk) => { const p = onChunk(chunk); p?.catch?.(() => {}); return p; },
                signal: abortController.signal,
              });
            }
            // A client disconnect can land after the client's last internal
            // abort check but before the turn is committed (the metadata RPC
            // is a window, and so is any await in the provider). Nothing below
            // may run for a socket that is gone: the tail flush would write
            // into a dead peer, and the success block would pool/bill/cache a
            // partial answer. `cascadeChat` itself throws AbortError when the
            // abort is observed during polling; this covers the return race.
            if (abortController.signal.aborted) {
              log.info(`Chat[${reqId}]: stream aborted (client gone) — discarding turn`);
              // The resumed turn completed upstream but the socket is gone:
              // P1 has no completed-entry replay, so drop the claim.
              if (resumeClaim) {
                detachedRegistry.release(resumeClaim.key, resumeClaim.token, { state: 'served' });
                resumeClaim = null;
              }
              return;
            }
            // C2: the Cascade producer awaited every emission, so this is
            // normally already settled. The legacy channel cannot await its
            // data callback, so the tail flush must not overtake an emission
            // still waiting on the writer.
            if (pendingEmission) await pendingEmission;
            // A06/KH-018: `max_wait` / `stall_warm` / `idle_empty` return
            // chunks normally, so without this check the success tail below
            // would pool the cascade, cache the text and write
            // finish_reason:"stop". Convert the poll loop's typed terminal
            // into the same failure continuation a thrown upstream error
            // takes; it flushes what was delivered and emits `length` for a
            // truncation or an explicit error for an empty turn.
            if (cascadeResult?.endReason != null) {
              const cascadeYielded = Number.isFinite(cascadeResult.totalYielded)
                ? cascadeResult.totalYielded
                : (Array.isArray(cascadeResult)
                  ? cascadeResult.reduce((n, c) => n + (c?.text?.length || 0), 0)
                  : accText.length);
              const cascadeThinking = Number.isFinite(cascadeResult.totalThinking)
                ? cascadeResult.totalThinking
                : (Array.isArray(cascadeResult)
                  ? cascadeResult.reduce((n, c) => n + (c?.thinking?.length || 0), 0)
                  : accThinking.length);
              const cascadeToolCount = Array.isArray(cascadeResult.toolCalls)
                ? cascadeResult.toolCalls.length
                : collectedToolCalls.length;
              const cascadeTerminal = classifyCascadeEnd(cascadeResult.endReason, {
                totalYielded: cascadeYielded,
                totalThinking: cascadeThinking,
                toolCallCount: cascadeToolCount,
              });
              if (!cascadeTerminal.ok) {
                const err = new Error(cascadeTerminal.message);
                err.type = cascadeTerminal.type;
                err.code = cascadeTerminal.code;
                err.status = cascadeTerminal.status;
                err.cascadeTerminal = cascadeTerminal;
                // The trajectory is half-finished; never return it to the pool.
                err.reuseEntryInvalid = true;
                throw err;
              }
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
              const emitted = await emitNativeFallbackCalls(nativeTail.toolCalls);
              if (emitted) {
                log.info(`Chat[stream]: native bridge parsed ${emitted} provider-native function_call(s) from stream tail`);
              }
              if (nativeTail.text) await emitContent(pathStreamText.feed(nativeTail.text));
            }
            if (toolParser) {
              const tail = toolParser.flush();
              if (tail.text) await emitContent(pathStreamText.feed(tail.text));
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
                await emitToolCallDelta(tc, idx);
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
                      await emitToolCallDelta(tc, idx);
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
            // Some real tool calls are only discoverable after cascadeChat
            // resolves: provider-native tail calls live on cascadeResult, while
            // emulated calls can be recovered from the accumulated thinking
            // channel below. The metadata gate must see that completed-turn
            // fact before deciding whether an exact JSON envelope is accidental.
            let lateThinkingHasToolCalls = false;
            if (emulateTools && collectedToolCalls.length === 0 && accThinking?.trim()) {
              const preview = parseToolCallsFromText(accThinking, { modelKey, provider, route: deps?.route || 'chat' });
              lateThinkingHasToolCalls = filterToolCallsByAllowlist(preview.toolCalls, declaredTools).length > 0;
            }
            const completedTurnHasToolCalls = collectedToolCalls.length > 0
              || (nativeBridgeOn && hasCallerVisibleCascadeTailToolCall(cascadeResult?.toolCalls, nativeOpts, declaredTools))
              || lateThinkingHasToolCalls;
            await emitContent(pathStreamText.flush({ hasToolCalls: completedTurnHasToolCalls }));
            // #250 — flush the think classifier BEFORE the thinking flush below:
            // an unterminated/undecided tail is delivered as text (visible beats
            // dropped), and doing it here lets the ACCUMULATE=true pathStreamThinking
            // flush below see any rerouted tail it should dedup against. flush() is
            // mandatory on this path — a forgotten flush drops an unterminated span.
            if (thinkClassifier) {
              const tail = thinkClassifier.flush();
              if (tail) await emitContent(tail);
            }
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
                      await emitToolCallDelta(tc, idx);
                    }
                  } else {
                    accThinking = '';
                    await emitThinking(bufferedThinking);
                  }
                } else {
                  // A tool_call was already emitted from text/native parsing;
                  // keep any buffered reasoning only for accounting/cache state.
                  accThinking = bufferedThinking;
                }
              } else {
                await emitThinking(thinkingTail);
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
                await emitToolCallDelta(tc, idx);
              }
              if (filteredNative.length === 0 && completedNativeReadUrlResults.length === 0 && cascadeResult.toolCalls.some(tc => tc.cascade_native)) {
                log.info(`Chat[stream]: nativeBridge=true received cascade tool calls but none mapped to caller tools (kinds=${cascadeResult.toolCalls.filter(tc => tc.cascade_native).map(tc => tc.name).join(',')})`);
              }
            }
            if (accText.length === 0 && collectedToolCalls.length === 0 && completedNativeReadUrlResults.length) {
              const fallbackText = completedNativeReadUrlResults.map(raw => raw.result).filter(Boolean).join('\n');
              // pathStreamText is already flushed above to preserve SSE block
              // ordering. A completed WebFetch document is not model metadata;
              // apply the same established path redaction directly instead of
              // feeding a closed gate.
              if (fallbackText) await emitExternalContent(fallbackText);
            }
            if (nativeBridgeOn && collectedToolCalls.length === 0 && completedNativeReadUrlResults.length === 0) recordNativeBridgeNoToolCallResponse();
            bridgeDiag.totalToolCalls = collectedToolCalls.length;
            bridgeDiag.noToolCalls = bridgeDiag.requestedTools && collectedToolCalls.length === 0 && completedNativeReadUrlResults.length === 0;
            logBridgeResultDiagnostics(reqId, bridgeDiag);
            // The socket can die between the post-call check and this commit
            // point: a tail-flush write above runs 'close' synchronously. An
            // aborted turn must never enter the reuse pool, move account
            // stats, or emit a success terminal, so re-check before the first
            // irreversible side effect.
            if (abortController.signal.aborted) {
              log.info(`Chat[${reqId}]: stream aborted before commit — discarding turn`);
              if (resumeClaim) {
                detachedRegistry.release(resumeClaim.key, resumeClaim.token, { state: 'served' });
                resumeClaim = null;
              }
              return;
            }
            // Settle this turn's usage by stable identity. A resume has no
            // checked-out account (`acct === null`), so the target is the
            // entry's owner id; the current key is only the fallback
            // credential. The claim's death must never erase the spend — the
            // upstream turn really ran (review: keep the 330-token
            // settlement).
            const settleUsage = () => {
              const usage = buildUsageBody(cascadeResult?.usage || null, messages, accText, accThinking, cachePolicy);
              try { recordTokenUsage(usage, model); } catch {}
              try {
                if (acct) {
                  recordAccountSpend(acct, usage);
                } else if (resumeBillingAccountId) {
                  const ownerKey = currentApiKeyForId(resumeBillingAccountId);
                  if (ownerKey) {
                    recordAccountSpend({ accountId: resumeBillingAccountId, apiKey: ownerKey }, usage);
                    detachedRegistry.noteBilled();
                  }
                }
              } catch {}
              return usage;
            };
            // A resumed turn commits success only while its claim is still
            // owned. The claim's deadline can pass during the post-loop
            // metadata RPC or the tail flush; release() checks that deadline
            // itself and returns false. The turn still ran upstream and is
            // settled above by its stable owner id, but no success side
            // effect (pool, account stats, finish, DONE, cache) may run for a
            // claim the registry no longer owns.
            let detachedServed = true;
            if (resumeAttempt && resumeClaim) {
              detachedServed = detachedRegistry.release(resumeClaim.key, resumeClaim.token, { state: 'served' });
              resumeClaim = null;
            }
            if (!detachedServed) {
              log.warn(`Chat[${reqId}]: detached claim deadline ended before commit — settling usage without a success terminal`);
              settleUsage();
              // The turn is not a success: count it as a failed request, but
              // keep the spend (settleUsage above) because it ran upstream.
              recordRequest(model, false, Date.now() - startTime, currentAccountId);
              await awaitWriter();
              if (!res.writableEnded) {
                await send(chatStreamError(
                  'Detached turn lost its claim before completion (request deadline exceeded)',
                  'upstream_deadline_exceeded',
                  'windsurf_provider_deadline',
                ));
                res.end();
              }
              return;
            }
            // Pool check-in on success (cascade only). A resumed turn is never
            // pooled in P1: the retry that resumed it may not be the client
            // that owns the next turn, and the pool key is fingerprint-based.
            if (!resumeAttempt && reuseEnabled && cascadeResult?.cascadeId && (accText || collectedToolCalls.length)) {
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
            // success — P2-1: same identity split as the non-stream twin
            // (nonStreamResponse). `currentApiKey` is the per-attempt snapshot;
            // the capability/health write belongs to the account's live key,
            // while the success verdict stays on the credential's epoch (an
            // old-key success does not prove the new key works).
            const liveApiKey = currentApiKeyForId(currentAccountId, currentApiKey);
            const credentialCurrent = credentialEpochCurrent({ id: currentAccountId, apiKey: currentApiKey }, currentApiKey);
            if (hadSuccess && credentialCurrent) reportSuccess(liveApiKey);
            updateCapability(liveApiKey, modelKey, true, 'success');
            recordRequest(model, true, Date.now() - startTime, currentAccountId);
            if (!rolePrinted) {
              await send({ id, object: 'chat.completion.chunk', created, model,
                choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
            }
            // T4 root dedup verdict: flush held content unless it is a
            // verbatim duplicate of the streamed reasoning. Client-visible
            // only — accText/accThinking keep the full view for the logic
            // below (fallback, narrative scan, cascade history).
            const settled = reasoningDedup?.settle() ?? { emit: '', suppressed: false };
            if (settled.emit) {
              await emitGatedContent(settled.emit);
            }
            // For response_format=json_* we buffered all content — flush one
            // clean JSON payload now. extractJsonPayload strips fences and
            // any preamble text, returning raw parseable JSON (or the
            // trimmed original when nothing parses).
            // A verbatim duplicate of the reasoning is suppressed here too
            // (degenerate echo, not JSON).
            if (wantJson && accText && !usedNativeReadUrlFallback && !(accThinking && accText === accThinking)) {
              // V-14: cap the model's JSON once, before shaping. The terminal
              // below then reports `length`, so a cut payload is visible.
              if (outputCapChars != null && accText.length > outputCapChars) {
                accText = accText.slice(0, outputCapChars);
                outputCapReached = true;
              }
              const cleaned = stabilizeJsonPayload(accText, messages);
              // V-10: JSON content is BUFFERED on this path (emitChunk returns
              // early for wantJson), so nothing invalid has reached the client yet.
              // A non-conforming payload therefore closes with the same typed error
              // frame the rest of the route uses for a failed turn — never with
              // finish_reason:'stop', which would tell the caller its schema held.
              const violation = structuredOutputViolation(cleaned, deps.jsonSchema);
              if (violation) {
                log.warn(`Chat[${reqId}]: structured output does not conform (${violation.path}: ${violation.message}) — closing with a typed error`);
                try {
                  await settleWriter();
                  if (!writerGone()) {
                    await send(chatStreamError(
                      `The model's answer does not conform to the requested JSON Schema (${violation.path}: ${violation.message}).`,
                      'server_error',
                      'STRUCTURED_OUTPUT_NOT_CONFORMING',
                    ));
                  }
                  // The upstream turn really ran; bill it even though the answer
                  // is unusable. No cache write and no [DONE]: this is a failure.
                  settleUsage();
                } catch { /* best effort — the client may already be gone */ }
                if (!res.writableEnded) res.end();
                return;
              }
              if (cleaned) {
                await emitGatedContent(cleaned);
                accText = cleaned;
              }
            }
            // GLM5.1 silence fallback (#86 follow-up KLFDan0534) — see
            // shouldFallbackThinkingToText comment for rationale.
            // Inside streamResponse the routing key arrives as the
            // `modelKey` param (caller passes routingModelKey there);
            // wantThinking comes through deps because body isn't in
            // scope here (#93 follow-up zhangzhang-bit).
            const thinkingPromotedToText = shouldFallbackThinkingToText({
              routingModelKey: modelKey,
              wantThinking: deps.wantThinking,
              accText,
              accThinking,
              hasToolCalls: collectedToolCalls.length > 0,
            });
            if (thinkingPromotedToText) {
              log.info(`Chat[${reqId}]: thinking-only stream from non-reasoning model ${modelKey}; promoting ${accThinking.length}c thinking → content`);
              await emitGatedContent(accThinking);
              accText = accThinking;
              accThinking = '';
            }
            if (leakTraceEnabled()) {
              log.info('LEAK_TRACE settle', {
                reqId,
                model,
                modelKey,
                provider,
                contentChars: accText.length,
                reasoningChars: accThinking.length,
                rerouted: thinkingPromotedToText,
                thinkInContent: thinkMarkersIn(accText),
                sample: leakSample(accText),
                durationMs: Date.now() - startTime,
              });
            }
            const finalReason = outputCapReached ? 'length' : (collectedToolCalls.length ? 'tool_calls' : 'stop');
            // Release the last withheld prose tail now that every fallback and
            // promotion has run; it must precede the terminal frames so no
            // content can arrive after them. No-op when a stop already fired.
            await flushContentGate();
            // OpenAI spec: the finish_reason chunk carries NO usage, then a
            // separate terminal chunk has empty choices[] + usage
            // (stream_options.include_usage convention). Emitting usage on
            // both made some clients double-count billing. Drop the first.
            const finishChoice = { index: 0, delta: {}, finish_reason: finalReason };
            // SEED-C3a carrier on the internal Messages route only: the exact
            // sequence that truncated the visible prose, so the Anthropic
            // translator can report stop_reason:'stop_sequence' + stop_sequence
            // instead of guessing from a suffix that no longer exists. A tool
            // finish never carries it.
            if (deps.context?.__messagesStopCarrier === true && stopMatched && finalReason === 'stop') finishChoice._windsurf_stop_sequence = stopMatched;
            // C2: the terminal frames are part of the same sequential emission —
            // no content may be written behind a frame the socket has not taken.
            await awaitWriter();
            await send({ id, object: 'chat.completion.chunk', created, model,
              choices: [finishChoice] });
            // If the terminal frame's own write is what discovered the close
            // (or the client left between the commit guard and here), stop
            // before billing and the cache write. The frame itself is already
            // gated by `send`.
            if (abortController.signal.aborted) {
              log.info(`Chat[${reqId}]: stream aborted before billing — discarding turn`);
              return;
            }
            {
              // Always build + record for internal billing; O1: only forward the
              // usage-only frame to the client when they opted in via
              // stream_options.include_usage (OpenAI omits it by default).
              // The accounting itself lives in `settleUsage` (shared with the
              // lost-claim path above); the abort guard above still runs first.
              const usage = settleUsage();
              // K8: per-account lifetime spend (Cascade STREAM path).
              //
              // This call point was missing while the other three had it (connect stream,
              // connect non-stream, Cascade non-stream at the
              // `recordAccountSpend({ accountId, apiKey }, usage)` below), so on a Cascade
              // deployment every streamed turn — the common
              // case for an agent client — added nothing to the account's lifetime tally.
              // The dashboard's per-account spend column therefore under-reported by
              // however much of the traffic was streamed.
              //
              // Placed here, not earlier, on purpose. Three double-count hazards, each
              // already realised once in this repo's history:
              //  - retry: this block sits inside the `for (let attempt...)` loop, but the
              //    success path returns immediately below, so a retried request records
              //    exactly once — the earlier attempts never reach here.
              //  - abort: a client disconnect aborts the request signal, and the
              //    guard above returns before this block (and before the cache
              //    write), so a cancelled turn is never billed or cached. That
              //    matches the rest of the codebase deliberately treating an
              //    abort as "nothing happened" (connect's finalizer exempts
              //    aborts from every penalty).
              //  - cache replay: a cache hit never enters this path at all.
              // `acct` is the reservation this attempt checked out. Pass the whole
              // reservation: the ledger is owned by its immutable id, so a re-login
              // that rotated the credential mid-turn cannot lose the row (review #3).
              //
              // Detach P1: a resume has NO checked-out account (`acct === null`).
              // Billing `acct` would silently bill nothing, so the target is the
              // entry's owner id (a re-auth may have rotated its key while the
              // turn was detached); the current key is only the fallback credential.
              // `settleUsage` above applies exactly this identity rule.
              if (deps.includeUsage) {
                await awaitWriter();
                await send({ id, object: 'chat.completion.chunk', created, model,
                  choices: [], usage });
              }
            }
            // C2: the DONE sentinel is the last byte of the stream; it waits for
            // the socket like every other frame.
            await awaitWriter();
            writeRaw('data: [DONE]\n\n');
            if (!res.writableEnded) res.end();
            if (ckey && !collectedToolCalls.length && cacheShareable && (accText || accThinking)
                && !abortController.signal.aborted) {
              // SEED-C3b: when a stop truncated the answer, cache the VISIBLE text
              // plus the cause so the replay reproduces both; otherwise the cached
              // text stays exactly what it was (accText = full generated text).
              // C2: a stream whose client vanished is not a successful turn and
              // must not seed the response cache.
              // A capped turn caches what was DELIVERED, exactly like a stopped
              // one: replaying bytes the client never received would change the
              // answer between the first and second identical request.
              cacheSet(ckey, { text: (stopMatched || outputCapReached) ? visibleText : accText, thinking: accThinking, stop: stopMatched });
            }
            return;
          } catch (err) {
            // A client disconnect is not a turn failure. cascadeChat raises
            // AbortError when its signal fired mid-poll; rawGetChatMessage
            // rejects with the same shape from grpcStream. Stop here — no
            // retry, no account penalty, no request stats, no error frame,
            // no terminal [DONE]. The partial cascade stays checked out (and
            // therefore un-reusable) rather than being restored into the pool
            // as if it were a complete turn.
            if (abortController.signal.aborted || err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
              log.info(`Chat[${reqId}]: stream aborted (client gone) — not retrying`);
              // The account was asked to serve this turn even though the client
              // left; keep the failed attempt in its history at zero cost.
              try { recordAccountAttempt({ id: currentAccountId }, { model, outcome: 'client_abort', status: 499 }); } catch {}
              if (resumeClaim) {
                // F21/F22/F24: re-detach with the turn's own snapshot when the
                // producer managed one; otherwise keep the frozen snapshot.
                // release() is idempotent: the producer may already have
                // released this token. A turn that delivered a tool call is
                // dropped instead of re-frozen (see releaseResumeClaim).
                releaseResumeClaim(resumeClaim.entry.snapshot);
              }
              return;
            }
            if (resumeAttempt && !hadSuccess) {
              // The cascade did not survive the detach (first read returned
              // not_found/expired) or the resume failed before any byte was
              // written. Drop the entry and fall through to a normal upstream
              // attempt; nothing was committed to the client.
              detachedRegistry.evict(resumeClaim.key, 'resume_miss', resumeClaim.token);
              resumeClaim = null;
              // The fallback attempt checks out a NEW account (only attempt 0
              // uses the reuse key). Passing the checked-out pool cascade on
              // would resume it under that account and re-bind it to the new
              // key; the normal failure path below drops the reuse intent for
              // the same reason. Drop the checkout too: the cascade just
              // proved it cannot be resumed.
              reuseEntry = null;
              checkedOutReuseEntry = null;
              lastErr = null;
              continue;
            }
            if (resumeAttempt && resumeClaim) {
              // Bytes were already on the wire; a completed-entry replay does
              // not exist in P1, so this claim cannot be served later.
              detachedRegistry.evict(resumeClaim.key, 'resume_miss', resumeClaim.token);
              resumeClaim = null;
            }
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
            const isDeadline = isUpstreamDeadlineExceeded(err) || isBudgetExceededError(err);
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
            // audit #8: same transient-first guard as the stream ban branch
            // below (5143) and the non-stream reportError. A transient stall /
            // internal error / rate-limit wrapped in a 401/403 auth shell must
            // NOT count against the account's error budget — transients never
            // reach reportError. A genuine auth failure still penalizes.
            // P2-1: same identity split as the non-stream twin — the account
            // cooldown targets the id's live key, credential verdicts stay on
            // the epoch that produced them.
            const liveApiKey = currentApiKeyForId(currentAccountId, currentApiKey);
            const credentialCurrent = credentialEpochCurrent({ id: currentAccountId, apiKey: currentApiKey }, currentApiKey);
            if (isAuthFail && !isRateLimit && !isInternal && !isTransient && credentialCurrent) reportError(liveApiKey);
            if (isRateLimit) { recordRateLimited(); markRateLimited(liveApiKey, rateLimitCooldownMs(err.message), modelKey); err.isRateLimit = true; err.isModelError = true; err.kind ||= 'model_error'; }
            // v2.0.91 — IP-level rate limit circuit breaker (stream path).
            // Same logic as non-stream: ≥3 accounts rate-limited for the
            // same model within 8s → Windsurf is doing IP-wide cooldown,
            // stop burning accounts and surface immediately. Q5: the window
            // is process-scoped (src/rate-limit-burst.js); per-request state
            // could not see a burst that began in an earlier request.
            const ctx = deps.context || {};
            if (isRateLimit && !ctx.__rlAborted) {
              const burst = recordRateLimitBurstEvent({
                model: modelKey,
                account: acct?.id,
                cooldownMs: rateLimitBurstCooldownMs({
                  message: err.message || '',
                  retryAfterMs: err.retry_after_ms,
                  apiKey: currentApiKey,
                  modelKey,
                }),
              });
              if (burst.tripped) {
                ctx.__rlAborted = true;
                log.warn(`Chat[${reqId}] stream: IP-rate-limit burst — ${burst.count} accounts rate-limited on ${model} within ${RATE_LIMIT_BURST_WINDOW_MS}ms. Short-circuiting.`);
                const cooldown = Math.max(burst.maxCooldownMs, IP_RATE_LIMIT_BURST_FLOOR_MS);
                lastErr = Object.assign(new Error(`All accounts temporarily rate-limited on ${model}. Windsurf upstream is applying IP-level cooldown. Wait ~${formatRetryAfter(cooldown)} before retrying.`), { type: 'rate_limit_exceeded', retry_after_ms: cooldown });
                break;
              }
            }
            if (isInternal) { if (credentialCurrent) reportInternalError(liveApiKey); err.isModelError = true; err.kind ||= 'transient_stall'; }
            if (isPolicyBlocked) { recordPolicyBlocked(buildPolicyBlockSample(messages, model, acct?.id || null, deps.context?.traceId || null)); err.isPolicyBlocked = true; err.isModelError = true; err.kind = 'policy_blocked'; }
            if (isTransport) { err.isModelError = true; err.kind ||= 'transient_stall'; }
            // v2.0.56 stream-path ban detection — same 2-strike logic as
            // non-stream. See nonStreamResponse for rationale, including the
            // transient-first guard (internal/transient errors wrapped in an
            // auth-shaped shell must not be promoted to a permanent ban).
            if (!isRateLimit && !isInternal && !isTransient && looksLikeBanSignal(err.message)) {
              if (credentialCurrent) reportBanSignal(liveApiKey, err.message);
              err.isModelError = true; err.kind ||= 'auth_error';
            }
            if (err.isModelError && err.kind !== 'transient_stall' && !isRateLimit && !isInternal) {
              updateCapability(liveApiKey, modelKey, false, 'model_error');
            }
            // Per-account history: one failed row per failed attempt, attributed
            // to the account that was asked to serve it. Cost fields are zero by
            // construction, so a failure can never move the billed summary.
            try {
              const verdict = isRateLimit ? { outcome: 'rate_limited', status: 429 }
                : isDeadline ? { outcome: 'upstream_error', status: 504 }
                : isPolicyBlocked ? { outcome: 'policy_blocked', status: 451 }
                : (isTransport || isTransient) ? { outcome: 'connection_error', status: 502 }
                : { outcome: 'upstream_error', status: err.isModelError ? 403 : 502 };
              recordAccountAttempt({ id: currentAccountId }, { model, ...verdict });
            } catch {}
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
                const backoffMs = await internalErrorBackoff(streamInternalCount - 1, budget);
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
        // C2: a producer that did not await its callback (the legacy channel,
        // or a fake) may still have an emission in flight. Settle it before the
        // failure tails read/mutate the same parser state; its own rejection is
        // the attempt's failure and is already accounted for.
        if (pendingEmission) {
          try { await pendingEmission; } catch { /* the failure path owns the outcome */ }
        }
        // C2: async so a stage can await the socket — the tails and the
        // synthetic finish frame are part of the same sequential emission. The
        // catch boundary is unchanged: a stage that throws still cannot take
        // the termination path down with it.
        async function failureStage(stage, action) {
          try {
            return await action();
          } catch (error) {
            // Never emit arbitrary error text: it may carry headers or tokens.
            // Stage + error class + digest is enough to correlate the failure.
            let line = `[stream-failure] stage=${stage}`;
            try {
              const name = ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError']
                .includes(error?.name) ? error.name : 'UnknownError';
              line += ` kind=${name} ${safeKeyRef(error?.message || '', 'error')}`;
            } catch {
              // A throwing getter/formatter must not disable the fixed stage log.
            }
            try {
              log.warn(line);
            } catch {
              // The primary sink failed; do not let diagnostics block termination.
              try { process.stderr.write(`${line} logger=failed\n`); }
              catch { /* Both local sinks failed; there is no remaining safe sink. */ }
            }
            return undefined;
          }
        }
        await failureStage('upstream-log', () => {
          // Maintainer note: the pre-existing #77 guard pins this exact fallback shape, and a
          // digest-only line turns a null lastErr into a constant that an operator cannot act
          // on. Redacting upstream text is SEC-6's job, on the message itself.
          log.error('Stream error after retries:', lastErr?.message || String(lastErr || 'account queue timed out without an error object'));
        });
        await failureStage('request-stats', () => {
          recordRequest(model, false, Date.now() - startTime, currentAccountId);
        });
        const failure = await failureStage('classify', () => {
          const temporaryUnavailable = isAllTemporarilyUnavailable(modelKey);
          const rl = isAllRateLimited(modelKey);
          const allInternal = streamInternalCount > 0 && tried.length > 0 && streamInternalCount >= tried.length;
          const poolExhausted = isLsPoolExhausted(lastErr);
          const poolTimedOut = lastErr?.type === 'pool_exhausted';
          const deadlineExceeded = isUpstreamDeadlineExceeded(lastErr) || lastErr?.type === 'upstream_deadline_exceeded' || isBudgetExceededError(lastErr);
          // Prefer upstream_transient over an account-limit diagnosis for transport failures.
          const lastIsTransport = isCascadeTransportError(lastErr);
          // A06: a typed Cascade terminal (max_wait/stall_warm/idle_empty) must
          // survive the generic classification instead of being flattened to
          // `upstream_error`.
          const cascadeTerminal = lastErr?.cascadeTerminal || null;
          // A deadline/budget stop outranks the transient-account diagnosis: the
          // chain stopped because the request ran out of time/turns, not because
          // every account was broken. A budget message is already specific, so
          // do not replace it with the ~240s provider-deadline text.
          const errMsg = cascadeTerminal
            ? sanitizeText(lastErr?.message || cascadeTerminal.message || 'Cascade turn ended incomplete')
            : deadlineExceeded
            ? (isBudgetExceededError(lastErr) || lastErr?.detachedClaimLost
              ? sanitizeText(lastErr?.message || 'request budget exhausted')
              : upstreamDeadlineExceededMessage(model))
            : allInternal
            ? upstreamTransientErrorMessage(model, tried.length, lastIsTransport ? 'cascade_transport' : 'internal_error')
            : poolExhausted
            ? sanitizeText(lastErr?.message || 'language server pool exhausted')
            : poolTimedOut
            ? sanitizeText(lastErr?.message || 'account pool timed out')
            : temporaryUnavailable.allUnavailable
            ? `${model} 所有账号暂时不可用，请 ${Math.ceil(temporaryUnavailable.retryAfterMs / 1000)} 秒后重试`
            : rl.allLimited
            ? `${model} 所有账号均已达速率限制，请 ${Math.ceil(rl.retryAfterMs / 1000)} 秒后重试`
            : sanitizeText(lastErr?.message || 'no accounts');
          return { temporaryUnavailable, allInternal, poolExhausted, poolTimedOut, deadlineExceeded, errMsg, cascadeTerminal };
        }) || {
          temporaryUnavailable: { allUnavailable: false }, allInternal: false,
          poolExhausted: false, poolTimedOut: false, deadlineExceeded: false, errMsg: 'Stream failed', cascadeTerminal: null,
        };
        const { temporaryUnavailable, allInternal, poolExhausted, poolTimedOut, deadlineExceeded, errMsg, cascadeTerminal } = failure;
        await failureStage('classification-log', () => {
          if (allInternal) log.error('Chat stream: all attempts hit an upstream transient error');
        });
        await failureStage('pool-restore', () => {
          if (!restoreCheckedOutReuse('failed stream') && !hadSuccess && reuseEntryDead) {
            log.info(`Chat[${reqId}]: stream reuse entry was invalidated (cascade not_found upstream); not restoring to pool`);
          }
        });
        await failureStage('egress-tail', async () => {
          // #185 failure tail: a candidate object may still be wholly buffered
          // because no terminal chunk arrived to prove it was the exact metadata
          // envelope. On an incomplete stream we must fail open and release those
          // bytes verbatim; otherwise a mismatch split across chunks disappears
          // and the client receives only an error frame.
          const egressTail = pathStreamText.flush({
            hasToolCalls: collectedToolCalls.length > 0,
            incomplete: true,
          });
          if (egressTail) { await settleWriter(); if (!writerGone()) await emitContent(egressTail); }

        });
        await failureStage('think-tail', async () => {
          // #250 failure path: release whatever the think classifier still holds
          // so an undecided/unterminated span is delivered as text rather than
          // dropped (visible beats dropped — same policy as the success tail).
          //
          // This runs BEFORE the emittedClientPayload branch on purpose. The
          // classifier can be holding the ENTIRE stream so far (a leading span
          // that never closed emits nothing until flush), in which case
          // emittedClientPayload is still false; flushing inside the branch would
          // therefore drop those bytes and send an error frame for a turn that
          // did produce content. Flushing here lets emitContent set the flag, so
          // the "partial delivered" branch is chosen correctly.
          if (thinkClassifier) {
            const rerouteTail = thinkClassifier.flush();
            if (rerouteTail) { await settleWriter(); if (!writerGone()) await emitContent(rerouteTail); }
          }

        });
        await failureStage('thinking-buffer', async () => {
          // #250 failure path, part 2 (adversarial review 2026-08-10): a CLOSED
          // think span that was already rerouted did NOT sit in the classifier —
          // it sat in accThinking (emulateTools buffers there to keep the Anthropic
          // block sequence clean). flush() above never touches it, so on a stream
          // failure that reasoning was silently dropped. Worse, an all-thinking
          // turn (no text) left emittedClientPayload false and the client got an
          // empty turn + raw error frame. Release accThinking here, choosing the
          // channel by the same rule the success tail uses: a client that cannot
          // see the reasoning channel gets it as text (accText), so nothing is lost.
          if (accThinking) {
            const bufferedThinking = accThinking;
            accThinking = '';
            const thinkingAsText = shouldFallbackThinkingToText({
              routingModelKey: modelKey, wantThinking: !!deps.wantThinking,
              accText, accThinking: bufferedThinking, hasToolCalls: collectedToolCalls.length > 0,
            });
            if (thinkingAsText) {
              if (accText) accText += '\n';
              accText += bufferedThinking;
              await settleWriter();
              if (!writerGone()) await emitContent(bufferedThinking);
            } else {
              // accThinking was non-empty so nothing was streamed yet — emitting
              // here is not a duplicate. accumulate:false because accThinking is
              // already reset and this would otherwise re-buffer + re-noteReasoning.
              await settleWriter();
              if (!writerGone()) await emitThinking(bufferedThinking, { accumulate: false });
            }
          }

        });
        if (emittedClientPayload) {
          await failureStage('dedup-tail', async () => {
            const heldTail = reasoningDedup?.release() ?? '';
            if (heldTail) { await settleWriter(); if (!writerGone()) await emitGatedContent(heldTail); }
          });
        }
        await failureStage('content-gate-tail', async () => { await settleWriter(); if (!writerGone()) await flushContentGate(); });
        // A detached claim that lost ownership must not be dressed up as a
        // completed turn: no terminal at all and no [DONE], even when the
        // prefix already reached the client. The error frame below is the
        // honest terminal for this stream.
        const claimLost = lastErr?.detachedClaimLost === true;
        // A06: a typed Cascade terminal overrides the generic pool/transport
        // classification. Without this an `idle_empty` would surface as a
        // generic `upstream_error` and a `max_wait` as `upstream_error` too,
        // losing the actionable type/code.
        const errType = cascadeTerminal?.type || (deadlineExceeded
          ? 'upstream_deadline_exceeded'
          : allInternal
            ? 'upstream_transient_error'
            : poolExhausted
              ? 'ls_pool_exhausted'
              : poolTimedOut
                ? 'capacity_error'
                : (temporaryUnavailable.allUnavailable || lastErr?.type === 'rate_limit_exceeded')
                  ? 'rate_limit_exceeded'
                  : 'upstream_error');
        const errCode = cascadeTerminal?.code || (deadlineExceeded
          ? 'windsurf_provider_deadline'
          : (temporaryUnavailable.allUnavailable || lastErr?.type === 'rate_limit_exceeded')
            ? 'RATE_LIMITED'
            : (poolExhausted || poolTimedOut)
              ? 'CAPACITY'
              : allInternal
                ? 'UPSTREAM_INTERNAL'
                : null);
        // Carry the hint for EVERY class that has one, not only 429: a
        // pre-content 503 (CAPACITY / budget) also benefits from telling the
        // client when to retry, and the commit gate turns it into a real
        // `Retry-After` header.
        const retryAfterMs = Number.isFinite(temporaryUnavailable.retryAfterMs) && temporaryUnavailable.retryAfterMs > 0
          ? temporaryUnavailable.retryAfterMs
          : (Number.isFinite(lastErr?.retry_after_ms) ? lastErr.retry_after_ms : null);
        if (emittedClientPayload && !claimLost) {
          if (cascadeTerminal?.kind === 'truncated') {
            // The poll loop stopped early but bytes are already on the wire.
            // A length terminal is the truthful OpenAI shape; internal
            // translators get __synthetic_finish and must not treat it as a
            // completed turn (so nothing is stored/chained).
            await failureStage('finish-frame', async () => {
              await settleWriter();
              if (writerGone()) return undefined;
              return finishTruncatedStream({ id, created, model, send,
                internalRoute: !isOpenAIClient });
            });
            await failureStage('partial-log', () => {
              log.warn(`Stream: partial response truncated (${safeKeyRef(errMsg, 'error')})`);
            });
          } else {
            // KH-002: an error after content is an error, not a synthetic
            // finish_reason:"stop". No [DONE]: the error frame is terminal.
            await failureStage('finish-frame', async () => {
              await settleWriter();
              if (writerGone()) return undefined;
              return finishPartialStreamAfterError({ id, created, model, send, res: null,
                internalRoute: !isOpenAIClient,
                error: {
                  message: errMsg,
                  type: errType,
                  code: errCode,
                  ...(retryAfterMs ? { retry_after_ms: retryAfterMs } : {}),
                } });
            });
            await failureStage('partial-log', () => {
              log.warn(`Stream: partial response delivered then failed (${safeKeyRef(errMsg, 'error')})`);
            });
          }
        } else {
          await failureStage('error-frame', async () => {
            await settleWriter();
            if (writerGone()) return;
            await send(chatStreamError(errMsg, errType, errCode, retryAfterMs ? { retry_after_ms: retryAfterMs } : null));
          });
        }
        await failureStage('done', async () => {
          // [DONE] is the OpenAI "clean finish" marker. It is written ONLY for
          // a truncation terminal (where finish_reason:"length" already told
          // the client the answer is incomplete). An error frame must never be
          // followed by it: a relay would read a failed request as a clean
          // empty success. A lost detached claim gets neither.
          await settleWriter();
          if (emittedClientPayload && !claimLost && cascadeTerminal?.kind === 'truncated') {
            writeRaw('data: [DONE]\n\n');
          }
        });
        await failureStage('end', () => {
          if (!res.writableEnded) res.end();
        });
      } catch (err) {
        // A synchronous throw before any terminal frame (e.g. constructing the
        // producer client after a resume claim) leaves the client waiting on an
        // open SSE socket. Close it; the lease and claim safety nets are in the
        // finally below.
        if (!res.writableEnded) {
          try { res.end(); } catch { /* the socket may already be gone */ }
        }
        throw err;
      } finally {
        // A resume claim that never reached the producer still holds this
        // request's LS lease; release it here so a throw cannot pin the entry
        // from idle reaping/maintenance.
        if (resumeLeasePort != null) {
          endLsUseFn(resumeLeasePort);
          resumeLeasePort = null;
        }
        // Safety net: every normal path above releases its claim (served or
        // running). A claim that survives to here means an early return or a
        // throw took a path that did not; re-detach with the frozen snapshot
        // rather than leaving the entry claimed until its deadline. A turn
        // that delivered a tool call is dropped instead (releaseResumeClaim).
        if (resumeClaim) releaseResumeClaim(resumeClaim.entry.snapshot);
        unregisterSse();
        stopHeartbeat();
      }
    },
  };
}

// Test-only surface. `waitForAccount` is the single async choke point every acquisition
// path funnels through (connect via acquireConnectAccount, both cascade paths directly),
// so queue-on-pin is tested by driving it end to end rather than by re-implementing the
// wait loop in a fixture — a fixture would pass while the real hook was wired wrong.
export const __testing = { waitForAccount, waitForOwnPin };
