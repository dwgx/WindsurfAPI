/**
 * POST /v1/messages — Anthropic Messages API compatibility layer.
 *
 * Translates Anthropic request/response format to/from the internal OpenAI
 * format so Claude Code and any Anthropic SDK client can connect directly.
 *
 * Streaming path is a real-time translator: it pipes the OpenAI SSE stream
 * from handleChatCompletions through a response shim that parses each
 * chat.completion.chunk and emits the equivalent Anthropic message_start /
 * content_block_* / message_delta / message_stop events as bytes arrive.
 * No buffering, so first-token latency matches the upstream Cascade stream.
 */

import { createHash, randomUUID } from 'crypto';
import { handleChatCompletions, connectErrorToHttp } from './chat.js';
import { log } from '../config.js';

function genMsgId() {
  return 'msg_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

// Anthropic's Messages API recognizes a FIXED set of error `type` values, and
// its SDKs (incl. Claude Code) drive retry/backoff off the HTTP status:
//   400 invalid_request_error · 401 authentication_error · 403 permission_error
//   404 not_found_error · 413 request_too_large · 429 rate_limit_error
//   500 api_error · 529 overloaded_error
// Our internal OpenAI-shaped handler emits proxy-specific types
// (capacity_error, upstream_error, insufficient_quota, model_blocked, ...) and
// statuses (502/503/402) that are NOT in that enum. Leaking them makes an
// Anthropic SDK treat a transient capacity blip as a fatal unknown error
// instead of auto-retrying. This maps (status, internalType) → the correct
// Anthropic {status, type} so clients get the right retry semantics.
//
// The most important remap: our CAPACITY (HTTP 503 capacity_error, "high demand
// — try again later") → 529 overloaded_error, which Anthropic SDKs retry with
// backoff. See P0 #56/#57 and the CAPACITY classification in devin-connect.js.
function toAnthropicError(status, internalType, message) {
  let outStatus = status;
  let type;
  switch (internalType) {
    case 'capacity_error': type = 'overloaded_error'; outStatus = 529; break;
    case 'insufficient_quota': type = 'rate_limit_error'; outStatus = 429; break;
    case 'model_blocked': type = 'permission_error'; outStatus = 403; break;
    // Transient upstream/transport errors are the proxy's "back off and retry"
    // signal (the multi-account retry chain uses these). For an Anthropic client
    // that maps to overloaded_error (529), which SDKs auto-retry with backoff —
    // the same intent, expressed in Anthropic's vocabulary.
    case 'upstream_transient_error':
    case 'upstream_internal_error': type = 'overloaded_error'; outStatus = 529; break;
    case 'rate_limit_error':
    case 'rate_limit_exceeded': type = 'rate_limit_error'; outStatus = 429; break;
    default: type = null;
  }
  if (!type) {
    // Fall back on HTTP status — covers upstream_error (502/503), server_error,
    // and anything the switch didn't name explicitly.
    switch (status) {
      case 400: type = 'invalid_request_error'; break;
      case 401: type = 'authentication_error'; break;
      case 403: type = 'permission_error'; break;
      case 404: type = 'not_found_error'; break;
      case 413: type = 'request_too_large'; break;
      case 429: type = 'rate_limit_error'; break;
      case 529: type = 'overloaded_error'; break;
      case 502:
      case 503:
        // Upstream unavailable/overloaded → overloaded_error so SDKs back off
        // and retry rather than failing hard on an unknown type.
        type = 'overloaded_error'; outStatus = 529; break;
      default:
        type = status >= 500 ? 'api_error' : 'invalid_request_error';
    }
  }
  return {
    status: outStatus,
    body: { type: 'error', error: { type, message: message || 'Upstream error' } },
  };
}

// Exposed for the stream translator + tests.
export { toAnthropicError };

// Anthropic Messages API tool types whose execution lives on Anthropic's
// servers, not the client. The proxy treats these as opt-out: it cannot
// satisfy server_tool_result delivery without implementing each one
// against Cascade, so they're stripped from the request rather than
// translated into normal function tools.
//   web_search_20250305     server-side web search
//   code_execution_20250522 server-side python sandbox
//   advisor_20260301        Anthropic Advisor Strategy (sonnet+opus pair)
const SERVER_SIDE_ANTHROPIC_TOOL_TYPES = new Set([
  // v2.0.93: web_search_20250305 now mapped to function web_search via cascade search_web.
  // Keep code_execution (sandbox) and advisor removed — no cascade equivalents.
  'code_execution_20250522',
  'advisor_20260301',
]);

// v2.0.93: convert server-side Anthropic tools to function tools we can handle.
function convertServerSideTool(t) {
  if (t?.type === 'web_search_20250305') {
    return {
      type: 'function',
      function: {
        name: 'web_search',
        description: t.description || 'Search the web',
        parameters: t.input_schema || { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    };
  }
  return null;
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

// Real Claude Code 2.1.120 traffic carries metadata.user_id as a
// JSON-encoded string with shape {device_id, account_uuid, session_id}.
// Older Anthropic SDK clients send a plain string. The proxy currently
// derives callerKey from API key + IP/UA, which means every Claude Code
// client behind the same key shares one cascade pool — leading to cross-
// device session bleed. Extract a stable per-user tag from metadata so
// the pool can isolate concurrent users.
export function extractCallerSubKey(body) {
  const userId = body?.metadata?.user_id;
  if (typeof userId !== 'string' || !userId) return '';
  let parsed = null;
  try { parsed = JSON.parse(userId); } catch {}
  let tag = '';
  if (parsed && typeof parsed === 'object') {
    tag = parsed.device_id || parsed.deviceId
      || parsed.session_id || parsed.sessionId
      || parsed.account_uuid || parsed.accountUuid
      || '';
  } else {
    tag = userId;
  }
  if (!tag) return '';
  return sha256Hex(tag).slice(0, 16);
}

// Anthropic prompt caching (`cache_control`) — verified spec:
//   - shape: { type: 'ephemeral', ttl?: '5m' | '1h' }, default ttl 5m
//   - placeable on tools[], system[] blocks, messages[].content[] blocks
//   - prefix-cumulative, ordered tools → system → messages
//   - max 4 breakpoints per request
//
// Cascade upstream doesn't speak this dialect — its own caching layer
// reports cacheReadTokens/cacheWriteTokens that already flow through
// chat.js → openAIToAnthropic. We strip the markers before forwarding
// (so they don't leak into Cascade requests) and expose a policy
// summary for downstream stages: TTL hint for the conversation pool,
// 5m vs 1h split attribution in usage.cache_creation.
//
// Per-tool token estimate for the cache-prefix walk — mirrors the tool
// accounting handleCountTokens uses (name + description + serialized schema)
// so the cached-prefix estimate and the count_tokens estimate stay consistent.
function cacheToolTokens(t) {
  if (!t || typeof t !== 'object') return 0;
  let n = estimateTextTokens(t.name || '') + estimateTextTokens(t.description || '');
  if (t.input_schema) n += estimateTextTokens(JSON.stringify(t.input_schema));
  return n;
}

// Returns: { has1h, breakpointCount, estCacheCreationTokens } describing the
// request. estCacheCreationTokens is a LOCAL, CJK-aware estimate of the cached
// prefix size (see below) used only when the upstream reports no cache tokens.
function extractCachePolicy(body) {
  let breakpointCount = 0;
  let has1h = false;
  // Anthropic prompt caching is PREFIX-CUMULATIVE: a cache_control breakpoint
  // caches everything ordered before it (tools → system → messages) up to and
  // including the marked block. Cascade reports real cache tokens that flow
  // through chat.js, but DEVIN_CONNECT (free tier especially) returns none —
  // leaving Claude Code unable to tell whether caching engaged or to budget
  // its context window. We walk the prefix in cache order, accumulate a
  // CJK-aware token estimate (reusing estimateTextTokens / anthropicBlockTokens
  // so the weighting matches count_tokens), and snapshot the cumulative total
  // at the DEEPEST breakpoint — that prefix is what gets written to cache on a
  // first-seen turn. buildAnthropicUsage emits it as cache_creation_input_tokens
  // ONLY when upstream supplied no real cache numbers.
  // (unverified: this is a local estimate — true cache tokens need a paid
  //  account to calibrate against; see PAID ledger task E. We attribute the
  //  whole prefix to creation and leave cache_read to genuine upstream values,
  //  since detecting a real cross-turn hit needs a stateful tracker we
  //  deliberately don't build here.)
  let runningTokens = 0;
  let estCacheCreationTokens = 0;
  const visit = (block, tokens) => {
    if (!block || typeof block !== 'object') return;
    runningTokens += tokens;
    const cc = block.cache_control;
    if (cc && typeof cc === 'object' && cc.type === 'ephemeral') {
      breakpointCount++;
      if (cc.ttl === '1h') has1h = true;
      // Deepest breakpoint wins — its prefix subsumes all earlier ones.
      estCacheCreationTokens = runningTokens;
      delete block.cache_control;
    }
  };
  if (Array.isArray(body.tools)) for (const t of body.tools) visit(t, cacheToolTokens(t));
  if (typeof body.system === 'string') {
    // A string system prompt carries no marker but is still part of any
    // cached prefix a later breakpoint forms.
    runningTokens += estimateTextTokens(body.system);
  } else if (Array.isArray(body.system)) {
    for (const s of body.system) visit(s, estimateTextTokens(s?.text || ''));
  }
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (Array.isArray(m.content)) for (const c of m.content) visit(c, anthropicBlockTokens(c));
      else if (typeof m.content === 'string') runningTokens += estimateTextTokens(m.content);
    }
  }
  // Also accept top-level cache_control hint (auto-caching mode) — it caches
  // the whole request prefix walked above.
  if (body.cache_control && typeof body.cache_control === 'object') {
    if (body.cache_control.type === 'ephemeral') {
      breakpointCount++;
      if (body.cache_control.ttl === '1h') has1h = true;
      estCacheCreationTokens = runningTokens;
    }
    delete body.cache_control;
  }
  return { has1h, breakpointCount, estCacheCreationTokens };
}

// ─── Anthropic → OpenAI request translation ──────────────────

function anthropicToOpenAI(body) {
  const cachePolicy = extractCachePolicy(body);
  const mapAnthropicToolChoice = (toolChoice) => {
    if (!toolChoice || typeof toolChoice !== 'object') return toolChoice;
    if (toolChoice.type === 'auto') return 'auto';
    if (toolChoice.type === 'any') return 'required';
    if (toolChoice.type === 'none') return 'none';
    if (toolChoice.type === 'tool' && toolChoice.name) {
      return { type: 'function', function: { name: toolChoice.name } };
    }
    return toolChoice;
  };
  const pruneToolChoice = (toolChoice, forwardedTools) => {
    if (!toolChoice || !forwardedTools.length) return undefined;
    if (toolChoice.type === 'function') {
      const names = new Set(forwardedTools.map(t => t.function?.name).filter(Boolean));
      return names.has(toolChoice.function?.name) ? toolChoice : undefined;
    }
    return toolChoice;
  };
  const messages = [];
  const toolNameById = new Map();
  if (body.system) {
    const sysText = typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map(b => b.text || '').join('\n')
        : '';
    if (sysText) messages.push({ role: 'system', content: sysText });
  }
  for (const m of (body.messages || [])) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (typeof m.content === 'string') {
      messages.push({ role, content: m.content });
    } else if (Array.isArray(m.content)) {
      const textParts = [];
      const imageParts = [];
      const toolCalls = [];
      const toolResults = [];
      for (const block of m.content) {
        if (block.type === 'text') {
          textParts.push(block.text || '');
        } else if (block.type === 'image') {
          imageParts.push(block);
        } else if (block.type === 'thinking') {
          // Thinking blocks from assistant history — skip; the model will regenerate
        } else if (block.type === 'tool_use' && role === 'assistant') {
          const id = block.id || `call_${randomUUID().slice(0, 8)}`;
          toolNameById.set(id, block.name || '');
          toolCalls.push({
            id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
        } else if (block.type === 'tool_result') {
          let content = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map(b => b.text || '').join('\n')
              : JSON.stringify(block.content);
          content = annotateRiskyReadToolResult(content, {
            toolName: toolNameById.get(block.tool_use_id),
            isError: !!block.is_error,
          });
          toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id, content });
        }
      }
      // Tool results must directly follow the assistant tool_calls message
      // in OpenAI format. Push them before the user content message.
      for (const tr of toolResults) messages.push(tr);
      if (toolCalls.length) {
        messages.push({
          role: 'assistant',
          content: textParts.length ? textParts.join('\n') : null,
          tool_calls: toolCalls,
        });
      } else if (imageParts.length) {
        const contentArr = [...imageParts];
        if (textParts.length) contentArr.push({ type: 'text', text: textParts.join('\n') });
        messages.push({ role, content: contentArr });
      } else if (textParts.length) {
        messages.push({ role, content: textParts.join('\n') });
      }
    }
  }
  // Anthropic exposes a growing set of "server-side" tool types where
  // the service itself runs the work and the client only opts in via
  // type. The proxy can't honor any of these (each needs its own stage-2
  // implementation - Cascade-side opus advisor pass, web-search bridge,
  // sandbox code exec). Drop them silently from the OpenAI-shaped tools
  // forwarded upstream; otherwise the upstream model is free to invent
  // a normal function tool_use for "advisor" the client will never get
  // a server_tool_result for.
  const droppedServerTools = [];
  const convertedServerTools = [];
  const tools = (body.tools || []).reduce((acc, t) => {
    if (t?.type && SERVER_SIDE_ANTHROPIC_TOOL_TYPES.has(t.type)) {
      droppedServerTools.push(t.type);
      return acc;
    }
    // v2.0.93: web_search_20250305 is now converted to a function tool
    if (t?.type === 'web_search_20250305') {
      const converted = convertServerSideTool(t);
      if (converted) {
        acc.push(converted);
        convertedServerTools.push('web_search_20250305→web_search');
      }
      return acc;
    }
    acc.push({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || {},
      },
    });
    return acc;
  }, []);
  if (droppedServerTools.length) {
    log.info(`messages: dropped ${droppedServerTools.length} server-side tool(s) [${[...new Set(droppedServerTools)].join(',')}] - proxy does not implement them yet`);
  }
  if (convertedServerTools.length) {
    log.info(`messages: converted ${convertedServerTools.length} server-side tool(s) [${convertedServerTools.join(',')}]`);
  }
  const forwardedToolChoice = pruneToolChoice(
    body.tool_choice ? mapAnthropicToolChoice(body.tool_choice) : undefined,
    tools,
  );
  // Claude Code 2.x and Anthropic SDK clients send response shape and
  // reasoning controls inside body.output_config — output_config.effort
  // mirrors OpenAI's reasoning_effort, and output_config.format carries
  // structured-output schemas Anthropic-side instead of OpenAI's
  // response_format. The internal handler speaks OpenAI dialect, so
  // unwrap both here so chat.js sees them on the path it already knows.
  const oc = body.output_config;
  const ocEffort = oc?.effort;
  const ocFormat = oc?.format;
  let translatedResponseFormat = null;
  if (ocFormat?.type === 'json_schema' && ocFormat.schema) {
    translatedResponseFormat = {
      type: 'json_schema',
      json_schema: {
        name: ocFormat.name || 'response',
        schema: ocFormat.schema,
        strict: ocFormat.strict !== false,
      },
    };
  } else if (ocFormat?.type === 'json_object') {
    translatedResponseFormat = { type: 'json_object' };
  }
  return {
    model: body.model || 'claude-sonnet-4.6',
    messages,
    max_tokens: body.max_tokens || 8192,
    stream: !!body.stream,
    ...(tools.length ? { tools } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.top_p != null ? { top_p: body.top_p } : {}),
    ...(body.stop_sequences ? { stop: body.stop_sequences } : {}),
    ...(forwardedToolChoice ? { tool_choice: forwardedToolChoice } : {}),
    ...(body.thinking ? { thinking: body.thinking } : {}),
    ...(ocEffort ? { reasoning_effort: ocEffort } : {}),
    ...(translatedResponseFormat ? { response_format: translatedResponseFormat } : {}),
    ...(cachePolicy.breakpointCount > 0 ? { __cachePolicy: cachePolicy } : {}),
  };
}

export { extractCachePolicy };

export function annotateRiskyReadToolResult(content, { toolName = '', isError = false } = {}) {
  if (toolName !== 'Read' || typeof content !== 'string' || !content) return content;
  const lower = content.toLowerCase();
  const isOversizeNoContent = isError
    && /file content \([^)]+\) exceeds maximum allowed size/i.test(content)
    && /use offset and limit parameters/i.test(content);
  // Claude Code Read tool emits real file bodies in "<lineno>\t<line>" form.
  // Stub strings (cached/unchanged/truncated) never use that prefix, so the
  // presence of a line-numbered line means we're looking at actual content
  // and keyword heuristics would only false-positive on user code/comments.
  const looksLikeRealBody = /^\s*\d+\t/m.test(content);
  const isCachedStub = !looksLikeRealBody && (
    /(?:file )?(?:content )?(?:unchanged|cached)/i.test(content)
    || /(?:内容未变更|已缓存)/.test(content)
  ) && content.length < 2000;
  const mentionsTruncation = !looksLikeRealBody
    && /truncated|截断|丢失/.test(lower);
  if (!isOversizeNoContent && !isCachedStub && !mentionsTruncation) return content;

  return `${content}\n\n[WindsurfAPI note: This Read result does not prove the full file body is available in the current conversation. If the task depends on full file contents, use Read with offset/limit or another content-bearing tool result before returning PASS.]`;
}

// ─── OpenAI → Anthropic non-stream response translation ──────

export function openAIToAnthropic(result, model, msgId, cachePolicy = null) {
  const choice = result.choices?.[0];
  const usage = result.usage || {};
  const content = [];
  if (choice?.message?.reasoning_content) {
    // Anthropic thinking blocks carry an opaque encrypted `signature` that the
    // *real* Anthropic server decrypts on multi-turn replay. Our upstream
    // (Devin #9 / Cascade) never emits one, so this is a proxy-synthesized
    // placeholder — the empty string is the Foxfishc-verified safe fallback
    // (client SDK accepts it; nothing on our path decrypts/verifies it because
    // the client only round-trips it and we discard thinking history inbound).
    // It is NOT a genuine Anthropic signature. If upstream ever supplies a real
    // signature we forward it (forward-compat for a future thinking/paid model).
    content.push({
      type: 'thinking',
      thinking: choice.message.reasoning_content,
      signature: choice.message.reasoning_signature || '',
    });
  }
  if (choice?.message?.tool_calls?.length) {
    if (choice.message.content) content.push({ type: 'text', text: choice.message.content });
    for (const tc of choice.message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name || 'unknown',
        input,
      });
    }
  } else {
    content.push({ type: 'text', text: choice?.message?.content || '' });
  }
  const stopMap = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' };
  return {
    id: msgId,
    type: 'message',
    role: 'assistant',
    content,
    model: model || result.model,
    stop_reason: stopMap[choice?.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: buildAnthropicUsage(usage, cachePolicy),
  };
}

// Anthropic's prompt-caching usage shape carries BOTH the legacy flat
// fields (cache_creation_input_tokens, cache_read_input_tokens) AND the
// newer nested split (cache_creation: { ephemeral_5m_input_tokens,
// ephemeral_1h_input_tokens }, GA since 2025-08-18). Emit both so SDK
// callers on either schema see consistent numbers — the flat total
// equals ephemeral_5m + ephemeral_1h. When chat.js doesn't supply a
// split (no cache_control on the request) we attribute the whole
// creation count to the 5m bucket since that's the spec default.
// Anthropic's prompt-caching usage shape carries BOTH the legacy flat
// fields (cache_creation_input_tokens, cache_read_input_tokens) AND the
// newer nested split (cache_creation: { ephemeral_5m_input_tokens,
// ephemeral_1h_input_tokens }, GA since 2025-08-18). Emit both so SDK
// callers on either schema see consistent numbers — the flat total
// equals ephemeral_5m + ephemeral_1h. When chat.js doesn't supply a
// split (no cache_control on the request) we attribute the whole
// creation count to the 5m bucket since that's the spec default.
//
// cachePolicy (optional) carries the LOCAL prefix estimate from
// extractCachePolicy. When the request had cache_control breakpoints but the
// upstream reported NO cache tokens (DEVIN_CONNECT free tier never does), we
// fall back to that estimate so Claude Code sees a non-zero, deterministic
// cache_creation_input_tokens instead of a misleading 0 — otherwise the client
// concludes caching never engaged and mis-budgets context. We only substitute
// when upstream gave nothing; a real upstream number always wins. The estimate
// goes to creation (first-seen prefix), TTL-split by has1h, default 5m.
// (unverified: local estimate — true cache token values require a paid account
//  to calibrate; see PAID ledger task E.)
function buildAnthropicUsage(usage, cachePolicy = null) {
  const cacheRead = usage.cache_read_input_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? 0;
  let cacheCreationFlat = usage.cache_creation_input_tokens || 0;
  let split = usage.cache_creation && typeof usage.cache_creation === 'object'
    ? {
        ephemeral_5m_input_tokens: usage.cache_creation.ephemeral_5m_input_tokens || 0,
        ephemeral_1h_input_tokens: usage.cache_creation.ephemeral_1h_input_tokens || 0,
      }
    : { ephemeral_5m_input_tokens: cacheCreationFlat, ephemeral_1h_input_tokens: 0 };
  // Local-estimate fallback: only when the request marked a cacheable prefix
  // AND upstream surfaced no cache tokens at all (both creation and read are 0).
  const upstreamGaveCache = cacheCreationFlat > 0 || cacheRead > 0;
  if (!upstreamGaveCache && cachePolicy?.breakpointCount > 0 && cachePolicy.estCacheCreationTokens > 0) {
    cacheCreationFlat = cachePolicy.estCacheCreationTokens;
    // Keep the established invariant: cache_creation_input_tokens ==
    // ephemeral_5m + ephemeral_1h. Default ttl 5m unless any 1h marker was set.
    split = cachePolicy.has1h
      ? { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cacheCreationFlat }
      : { ephemeral_5m_input_tokens: cacheCreationFlat, ephemeral_1h_input_tokens: 0 };
  }
  // v2.0.68 (#118): Anthropic semantics for input_tokens DIFFER from OpenAI.
  // OpenAI: prompt_tokens = freshInput + cacheRead (cached_tokens is a subset).
  // Anthropic: input_tokens = freshInput ONLY; cache_read_input_tokens and
  //            cache_creation_input_tokens are siblings (mutually exclusive).
  // The OpenAI prompt_tokens we receive here already follows the OpenAI
  // convention (chat.js buildUsageBody puts freshInput+cacheRead in
  // prompt_tokens). To get Anthropic's freshInput we subtract the cached
  // subset. Negative values clamp to 0 (defensive against upstream skew).
  const promptTotal = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const freshInput = Math.max(0, promptTotal - cacheRead);
  return {
    input_tokens: freshInput,
    output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    cache_creation_input_tokens: cacheCreationFlat,
    cache_read_input_tokens: cacheRead,
    cache_creation: split,
  };
}

// ─── Streaming translator: intercepts OpenAI SSE, emits Anthropic SSE ──

class AnthropicStreamTranslator {
  constructor(res, msgId, model, cachePolicy = null) {
    this.res = res;
    this.msgId = msgId;
    this.model = model;
    // Local cache-prefix estimate from extractCachePolicy; used by finish() to
    // fill cache_creation_input_tokens when upstream reports none (see
    // buildAnthropicUsage). null when the request had no cache_control markers.
    this.cachePolicy = cachePolicy;
    // Current content block: null | { type, index }
    // type: 'text' | 'thinking' | 'tool_use'
    this.current = null;
    this.blockIndex = 0;
    this.toolCallBufs = new Map();   // index → { id, name, argsBuffered }
    this.finalUsage = null;
    this.stopReason = 'end_turn';
    this.messageStarted = false;
    this.messageStopped = false;
    // True once the upstream delivered an authoritative end-of-stream signal:
    // a choice.finish_reason, a `data: [DONE]` frame, or an explicit error
    // frame. finish() uses this to tell a clean completion apart from an
    // abnormal cutoff (network drop / upstream abort / deadline) — see BUG1.
    this.sawTerminalSignal = false;
    this.pendingSseBuf = '';
    // Anthropic requires a thinking block to close with a `signature_delta`
    // (before content_block_stop) carrying the encrypted-thinking signature.
    // Our upstream never produces one, so we emit the empty-string fallback
    // (proxy-synthesized, NOT a real Anthropic signature). If a future upstream
    // delta supplies delta.reasoning_signature we round-trip the real value.
    this.pendingThinkingSignature = '';
  }

  send(event, data) {
    if (!this.res.writableEnded) {
      this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }

  startMessage() {
    if (this.messageStarted) return;
    this.messageStarted = true;
    this.send('message_start', {
      type: 'message_start',
      message: {
        id: this.msgId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        },
      },
    });
  }

  startBlock(type, extra = {}) {
    this.closeCurrentBlock();
    this.current = { type, index: this.blockIndex };
    let content_block;
    if (type === 'text') content_block = { type: 'text', text: '' };
    else if (type === 'thinking') content_block = { type: 'thinking', thinking: '' };
    else if (type === 'tool_use') content_block = { type: 'tool_use', id: extra.id, name: extra.name, input: {} };
    this.send('content_block_start', {
      type: 'content_block_start',
      index: this.blockIndex,
      content_block,
    });
  }

  closeCurrentBlock() {
    if (!this.current) return;
    // BUG3: before stopping a tool_use block, flush any buffered arg fragments
    // WHILE the block is still the open/current one. After content_block_stop
    // the index is closed and any input_json_delta against it would be invalid.
    if (this.current.type === 'tool_use') {
      this.flushToolArgs(this.toolBufForBlockIndex(this.current.index));
    }
    // A thinking block must close with a signature_delta BEFORE content_block_stop
    // (Anthropic sequence: start → thinking_delta* → signature_delta → stop). Only
    // thinking blocks get it — never text/tool_use. Empty-string fallback when the
    // upstream supplied no real signature (see constructor note).
    if (this.current.type === 'thinking') {
      this.send('content_block_delta', {
        type: 'content_block_delta',
        index: this.current.index,
        delta: { type: 'signature_delta', signature: this.pendingThinkingSignature || '' },
      });
      this.pendingThinkingSignature = '';
    }
    this.send('content_block_stop', { type: 'content_block_stop', index: this.current.index });
    this.blockIndex++;
    this.current = null;
  }

  emitTextDelta(text) {
    if (!text) return;
    if (this.current?.type !== 'text') this.startBlock('text');
    this.send('content_block_delta', {
      type: 'content_block_delta',
      index: this.current.index,
      delta: { type: 'text_delta', text },
    });
  }

  emitThinkingDelta(text) {
    if (!text) return;
    if (this.current?.type !== 'thinking') this.startBlock('thinking');
    this.send('content_block_delta', {
      type: 'content_block_delta',
      index: this.current.index,
      delta: { type: 'thinking_delta', thinking: text },
    });
  }

  // Find the tool buffer whose open block has this content-block index.
  toolBufForBlockIndex(index) {
    for (const buf of this.toolCallBufs.values()) {
      if (buf.blockIndex === index) return buf;
    }
    return null;
  }

  // BUG3: emit any pending arg fragments for a tool ONLY while its block is the
  // currently-open content block. Anthropic requires every input_json_delta to
  // land inside its tool_use block's open window (between content_block_start
  // and content_block_stop). If the block isn't current (a text delta or another
  // tool interleaved and pushed a new block open), we must NOT send — keep the
  // fragments buffered until that tool's block becomes current again. A tool_use
  // block is never reopened, so buffering is the only spec-correct option.
  flushToolArgs(buf) {
    if (!buf || buf.blockIndex == null || !buf.pendingArgs) return;
    if (!this.current || this.current.index !== buf.blockIndex) return;
    const pending = buf.pendingArgs;
    buf.pendingArgs = '';
    buf.argsBuffered += pending;
    this.send('content_block_delta', {
      type: 'content_block_delta',
      index: buf.blockIndex,
      delta: { type: 'input_json_delta', partial_json: pending },
    });
  }

  emitToolCallDelta(toolCall) {
    const idx = toolCall.index ?? 0;
    let existing = this.toolCallBufs.get(idx);
    const id = toolCall.id || existing?.id;
    const name = toolCall.function?.name || existing?.name;
    const argsChunk = toolCall.function?.arguments || '';

    if (!existing) {
      existing = { id, name, blockIndex: null, argsBuffered: '', pendingArgs: '' };
      this.toolCallBufs.set(idx, existing);
    } else {
      if (id) existing.id = id;
      if (name) existing.name = name;
    }
    const buf = this.toolCallBufs.get(idx);
    // Open this tool's block the first time we have both id and name. If another
    // block is currently open (text/thinking/another tool), startBlock closes it
    // first, so on return `this.current` is guaranteed to be THIS tool's block.
    if (buf.blockIndex == null && buf.id && buf.name) {
      this.startBlock('tool_use', { id: buf.id, name: buf.name });
      buf.blockIndex = this.current.index;
    }
    // Always accumulate into pendingArgs, then attempt a guarded flush. The flush
    // only fires while this tool's block is current (BUG3), so interleaved deltas
    // arriving after the block was stopped — or before it's opened — stay buffered
    // instead of being sent to a closed/nonexistent index.
    if (argsChunk) buf.pendingArgs += argsChunk;
    this.flushToolArgs(buf);
  }

  processChunk(chunk) {
    if (chunk.error) {
      this.sawTerminalSignal = true;
      this.error(chunk.error);
      return;
    }
    this.startMessage();
    const choice = chunk.choices?.[0];
    if (choice) {
      const delta = choice.delta || {};
      if (delta.reasoning_content) this.emitThinkingDelta(delta.reasoning_content);
      // Forward-compat: if a future upstream attaches a real encrypted signature
      // to the reasoning stream, capture it so closeCurrentBlock round-trips the
      // genuine value instead of the empty-string placeholder.
      if (delta.reasoning_signature) this.pendingThinkingSignature = delta.reasoning_signature;
      if (delta.content) this.emitTextDelta(delta.content);
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) this.emitToolCallDelta(tc);
      }
      if (choice.finish_reason) {
        this.sawTerminalSignal = true;
        const stopMap = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' };
        this.stopReason = stopMap[choice.finish_reason] || 'end_turn';
      }
    }
    if (chunk.usage) this.finalUsage = chunk.usage;
  }

  finish() {
    if (this.messageStopped) return;
    // BUG1: An abnormally cut-off stream (network drop, upstream abort, hung-
    // stream deadline) reaches finish() with content already started but NO
    // terminal signal — no choice.finish_reason, no [DONE], no error frame.
    // Faking stop_reason:end_turn here tells Claude Code the answer is complete
    // when it was truncated mid-flight. Anthropic's stop_reason enum has no
    // "truncated" value, so a truncation must be surfaced as an `error` event
    // rather than a bogus stop_reason. 502 maps (via toAnthropicError) to a
    // retryable 529 overloaded_error so the SDK backs off and retries instead
    // of accepting the partial answer as final.
    if (this.messageStarted && !this.sawTerminalSignal) {
      this.error({
        status: 502,
        type: 'upstream_error',
        message: 'Upstream stream ended before completion (no terminal signal — response is incomplete)',
      });
      return;
    }
    this.messageStopped = true;
    // Ensure message_start is always sent — when the upstream stream
    // fails before any content arrives (e.g. cascade immediate error,
    // new-api timeout), Claude Code still expects a complete event
    // sequence. Without this, the client sees message_delta + stop
    // with no preceding start and reports "Content block not found".
    if (!this.messageStarted) this.startMessage();
    this.closeCurrentBlock();
    const u = this.finalUsage || {};
    this.send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.stopReason, stop_sequence: null },
      usage: buildAnthropicUsage(u, this.cachePolicy),
    });
    this.send('message_stop', { type: 'message_stop' });
  }

  error(err) {
    if (this.messageStopped) return;
    this.messageStopped = true;
    this.closeCurrentBlock();
    // The mid-stream error chunk is shaped { type: 'upstream_error', code, message }
    // where `code` is the DEVIN_CONNECT classification (CAPACITY, UNAUTHORIZED,
    // ...). Resolve the authoritative {status,type} from the code first (so
    // CAPACITY → 503 capacity_error → 529 overloaded_error), then normalize to a
    // valid Anthropic error type. Falls back to the OpenAI-stream type when no
    // code is present (e.g. a generic api_error from the catch block).
    const http = err?.code ? connectErrorToHttp(err.code) : { status: err?.status || 500, type: err?.type };
    const mapped = toAnthropicError(http.status, http.type, err?.message);
    this.send('error', {
      type: 'error',
      error: mapped.body.error,
    });
  }

  // SSE parser — handleChatCompletions writes `data: {...}\n\n` frames;
  // accumulate and flush each complete frame as a translated event.
  feed(rawChunk) {
    this.pendingSseBuf += typeof rawChunk === 'string' ? rawChunk : rawChunk.toString('utf8');
    let idx;
    while ((idx = this.pendingSseBuf.indexOf('\n\n')) !== -1) {
      const frame = this.pendingSseBuf.slice(0, idx);
      this.pendingSseBuf = this.pendingSseBuf.slice(idx + 2);
      const lines = frame.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') {
          // [DONE] is the OpenAI stream's authoritative terminator. Treat it as
          // a clean end-of-stream signal (BUG1) even though it carries no
          // finish_reason of its own.
          this.sawTerminalSignal = true;
          continue;
        }
        try {
          this.processChunk(JSON.parse(payload));
        } catch (e) {
          log.warn(`Messages SSE parse error: ${e.message}`);
        }
      }
    }
  }
}

// ─── Fake ServerResponse that pipes writes into the translator ──

function createCaptureRes(translator, realRes) {
  const listeners = new Map();
  const fire = (event) => {
    const cbs = listeners.get(event) || [];
    for (const cb of cbs) { try { cb(); } catch {} }
  };
  return {
    writableEnded: false,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    write(chunk) {
      // chat.js writes SSE heartbeat comments (`: ping\n\n`) every 15s
      // while Cascade is slow-polling its trajectory. The translator
      // only parses `data:` lines, so pings are silently dropped —
      // leaving the real Anthropic stream quiet for minutes until a
      // CDN/proxy/client decides the connection is dead and bails. Pass
      // heartbeat comments straight through so Claude Code stays happy.
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (str.startsWith(':') && realRes && !realRes.writableEnded) {
        try { realRes.write(str); } catch {}
      }
      translator.feed(chunk);
      return true;
    },
    end(chunk) {
      if (this.writableEnded) return;
      if (chunk) translator.feed(chunk);
      translator.finish();
      this.writableEnded = true;
      fire('close');
    },
    // Fire 'close' without marking writableEnded=true so chat.js's
    // close handler sees an un-ended stream and triggers its abort path.
    _clientDisconnected() { fire('close'); },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
    once(event, cb) {
      const self = this;
      const wrapped = function onceWrapper() {
        self.off(event, wrapped);
        cb.apply(self, arguments);
      };
      return self.on(event, wrapped);
    },
    off(event, cb) {
      const arr = listeners.get(event);
      if (arr) {
        const idx = arr.indexOf(cb);
        if (idx !== -1) arr.splice(idx, 1);
      }
      return this;
    },
    removeListener(event, cb) { return this.off(event, cb); },
    emit() { return true; },
  };
}

// ─── Main entry ───────────────────────────────────────────────

export async function handleMessages(body, context = {}) {
  const msgId = genMsgId();
  const requestedModel = body.model || 'claude-sonnet-4.6';
  const wantStream = !!body.stream;
  const openaiBody = anthropicToOpenAI(body);
  // anthropicToOpenAI attaches __cachePolicy only when the request carried
  // cache_control breakpoints; reuse it for the local cache-token estimate.
  const cachePolicy = openaiBody.__cachePolicy || null;
  const chatHandler = context.handleChatCompletions || handleChatCompletions;
  // Augment callerKey with the per-user tag from metadata.user_id when
  // present so the cascade pool can isolate concurrent Claude Code users
  // sharing one API key. Bare API-key callers and other client SDKs that
  // do not send metadata.user_id keep the original callerKey unchanged.
  const subKey = extractCallerSubKey(body);
  const alreadyUserScoped = context.callerKey && context.callerKey.includes(':user:');
  const effectiveContext = (subKey && !alreadyUserScoped)
    ? {
        ...context,
        callerKey: `${context.callerKey || ''}:user:${subKey}`,
        nativeBridgeCallerKey: context.nativeBridgeCallerKey
          ? `${context.nativeBridgeCallerKey}:user:${subKey}`
          : context.nativeBridgeCallerKey,
      }
    : context;

  if (!wantStream) {
    const result = await chatHandler({ ...openaiBody, stream: false, __route: 'messages' }, effectiveContext);
    if (result.status !== 200) {
      return toAnthropicError(
        result.status,
        result.body?.error?.type,
        result.body?.error?.message,
      );
    }
    return { status: 200, body: openAIToAnthropic(result.body, requestedModel, msgId, cachePolicy) };
  }

  // Streaming path — ask handleChatCompletions for its streaming handler and
  // point its writes at our translator shim. This lets the upstream Cascade
  // poll loop drive the downstream SSE in real time — no buffer-then-replay.
  const streamResult = await chatHandler({ ...openaiBody, stream: true, __route: 'messages' }, effectiveContext);

  if (!streamResult.stream) {
    // The OpenAI path returned a non-stream error (e.g. 403 model_not_entitled,
    // 503 capacity_error) before any byte streamed — map it to the Anthropic
    // error enum so the SDK applies correct retry/backoff.
    return toAnthropicError(
      streamResult.status || 502,
      streamResult.body?.error?.type,
      streamResult.body?.error?.message,
    );
  }

  return {
    status: 200,
    stream: true,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
    async handler(realRes) {
      const translator = new AnthropicStreamTranslator(realRes, msgId, requestedModel, cachePolicy);
      const captureRes = createCaptureRes(translator, realRes);

      // Forward client disconnect so the upstream cascade is cancelled.
      // We don't call captureRes.end() here — that would set writableEnded=true
      // and suppress the abort path inside chat.js's stream handler.
      realRes.on('close', () => {
        if (!captureRes.writableEnded) captureRes._clientDisconnected();
      });

      try {
        await streamResult.handler(captureRes);
      } catch (e) {
        log.error(`Messages stream error: ${e.message}`);
        translator.error({ type: 'api_error', message: e.message });
      }

      if (!realRes.writableEnded) realRes.end();
    },
  };
}

// BUG2: CJK token estimate. Anthropic's tokenizer splits CJK (Chinese /
// Japanese / Korean) text far more finely than Latin: a single Han ideograph
// or Kana/Hangul syllable typically costs ~1 token (sometimes more), whereas
// Latin text averages ~4 chars/token. The old flat chars/4 heuristic therefore
// under-counted CJK prompts by roughly 4×, so Claude Code budgeted its context
// window far too low. This estimator weights CJK-range code points at ~1 token
// each (a conservative upper bound — real cost is ~0.5–1.5) and the rest at the
// usual ~chars/4. It is still an ESTIMATE, not Anthropic's real tokenizer, but a
// deterministic one that no longer collapses CJK to a quarter of its true size.
function isCjkCodePoint(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x11FF) ||   // Hangul Jamo
    (cp >= 0x2E80 && cp <= 0x2FDF) ||   // CJK Radicals / Kangxi Radicals
    (cp >= 0x3000 && cp <= 0x303F) ||   // CJK Symbols and Punctuation (full-width)
    (cp >= 0x3040 && cp <= 0x30FF) ||   // Hiragana + Katakana
    (cp >= 0x3100 && cp <= 0x312F) ||   // Bopomofo
    (cp >= 0x3130 && cp <= 0x318F) ||   // Hangul Compatibility Jamo
    (cp >= 0x31F0 && cp <= 0x31FF) ||   // Katakana Phonetic Extensions
    (cp >= 0x3200 && cp <= 0x33FF) ||   // Enclosed CJK Letters/Months + Compatibility
    (cp >= 0x3400 && cp <= 0x4DBF) ||   // CJK Unified Ideographs Extension A
    (cp >= 0x4E00 && cp <= 0x9FFF) ||   // CJK Unified Ideographs
    (cp >= 0xA000 && cp <= 0xA4CF) ||   // Yi Syllables
    (cp >= 0xAC00 && cp <= 0xD7AF) ||   // Hangul Syllables
    (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK Compatibility Ideographs
    (cp >= 0xFF00 && cp <= 0xFFEF) ||   // Halfwidth and Fullwidth Forms
    (cp >= 0x20000 && cp <= 0x2FA1F)    // CJK Unified Ideographs Extension B–F + Supplement
  );
}

function estimateTextTokens(str) {
  if (!str) return 0;
  let cjk = 0;
  let other = 0;
  // Iterating with for…of yields whole code points (surrogate pairs included),
  // so astral-plane CJK (Extension B+) is classified correctly.
  for (const ch of String(str)) {
    if (isCjkCodePoint(ch.codePointAt(0))) cjk += 1;
    else other += 1;
  }
  // CJK ≈ 1 token/char (conservative upper bound); the rest ≈ chars/4.
  return cjk + Math.ceil(other / 4);
}

// Per-attachment token estimate for image/document blocks. Real vision token
// cost depends on dimensions we don't decode here; ~1500 tokens is a reasonable
// upper-middle guess that keeps clients from under-budgeting.
const ATTACHMENT_TOKEN_ESTIMATE = 1500;

// Recursively estimate the token count of any Anthropic content shape: a bare
// string, an array of content blocks (text/tool_use/tool_result/image), or a
// nested block. Image/document blocks contribute a flat per-attachment estimate
// rather than their base64 length (which would wildly overcount).
function anthropicContentTokens(content) {
  if (content == null) return 0;
  if (typeof content === 'string') return estimateTextTokens(content);
  if (Array.isArray(content)) {
    let n = 0;
    for (const block of content) n += anthropicBlockTokens(block);
    return n;
  }
  if (typeof content === 'object') return anthropicBlockTokens(content);
  return 0;
}

function anthropicBlockTokens(block) {
  if (!block || typeof block !== 'object') return 0;
  switch (block.type) {
    case 'text': return estimateTextTokens(block.text || '');
    case 'tool_use': return estimateTextTokens(block.name || '') + estimateTextTokens(JSON.stringify(block.input || {}));
    case 'tool_result': return anthropicContentTokens(block.content);
    case 'thinking': return estimateTextTokens(block.thinking || '');
    case 'image':
    case 'document':
      return ATTACHMENT_TOKEN_ESTIMATE;
    default:
      // Unknown block: fall back to its serialized text content if present.
      return typeof block.text === 'string' ? estimateTextTokens(block.text) : 0;
  }
}

// POST /v1/messages/count_tokens — Anthropic's token-estimate endpoint. Claude
// Code and the Anthropic SDK call this before sending a request to budget the
// context window; a 404 here degrades those clients. We don't have Anthropic's
// exact tokenizer, so this returns a deterministic CJK-aware estimate over the
// system prompt, every message's content blocks, and tool schemas (see
// estimateTextTokens). It is an ESTIMATE, clearly so, but a stable, non-zero one
// that keeps clients functioning and no longer under-counts CJK prompts ~4×.
export function handleCountTokens(body) {
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return {
      status: 400,
      body: { type: 'error', error: { type: 'invalid_request_error', message: 'messages must be a non-empty array' } },
    };
  }
  let tokens = 0;
  // system can be a string or an array of text blocks.
  tokens += anthropicContentTokens(body.system);
  for (const m of body.messages) tokens += anthropicContentTokens(m?.content);
  // Tool schemas are part of the prompt the model sees.
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      tokens += estimateTextTokens(t?.name || '') + estimateTextTokens(t?.description || '');
      if (t?.input_schema) tokens += estimateTextTokens(JSON.stringify(t.input_schema));
    }
  }
  const input_tokens = Math.max(1, tokens);
  return { status: 200, body: { input_tokens } };
}
