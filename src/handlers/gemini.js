/**
 * Google Gemini API (generativelanguage) v1beta compatibility layer.
 *
 * Translates Gemini's GenerateContentRequest / GenerateContentResponse
 * format to/from the internal OpenAI chat format so any Gemini SDK or
 * raw v1beta client (`:generateContent`, `:streamGenerateContent`) can
 * connect directly to the DEVIN/Cascade backend.
 *
 * Mirrors src/handlers/messages.js (the Anthropic frontend):
 *   - geminiToOpenAI       request  : Gemini  → internal OpenAI
 *   - openAIToGemini       response : OpenAI  → Gemini (non-stream)
 *   - GeminiStreamTranslator        : pipes the OpenAI SSE stream from
 *     handleChatCompletions through a response shim and emits equivalent
 *     Gemini streaming frames as bytes arrive (no buffer-then-replay).
 *   - geminiError          : (status, internalType) → Gemini error body,
 *     preserving the transient-first semantics of connectErrorToHttp so a
 *     capacity blip never gets reported as a fatal PERMISSION_DENIED.
 *
 * Reference: Gemini v1beta request/response schema (Google AI for
 * Developers). Streaming `:streamGenerateContent` returns a JSON array of
 * GenerateContentResponse by default, or an SSE stream when `?alt=sse` is
 * set — both are supported here. Fields whose exact upstream shape we have
 * not verified against a live Gemini endpoint are marked TODO(unverified).
 */

import { handleChatCompletions, connectErrorToHttp } from './chat.js';
import { log } from '../config.js';
import { createBoundedWriter, resolveMaxDrainWaitMs } from '../stream-writer.js';
import { SseFramer } from '../sse-framer.js';
import { buildToolNameMap, restoreToolName, sanitizeToolName } from '../tool-names.js';
import { createToolIdAllocator, normalizeToolIdsInMessages, sanitizeToolId, toolHygieneEnabled } from '../tool-ids.js';
import { normalizeHistoryTail } from '../history-normalize.js';
import { firstUnsupportedGeminiServerTool, geminiServerSideToolUnsupported } from '../server-side-tools.js';

// ─── finish_reason mapping (OpenAI → Gemini) ────────────────────
// Gemini has no dedicated finishReason for function calls — a turn that
// ends in functionCall parts still reports STOP. content_filter → SAFETY.
//
// G3/Q2: the Connect decoder reports a turn that DELIVERED a payload but never
// named a stop reason as `finish_reason:'error'` (with `unterminated:true` when
// the marker rides the frame). That is a FAILED/truncated turn, not a finished
// one. It must never reach a client as STOP: Gemini's enum has OTHER for
// "ended for a reason this enum cannot express", and both egress paths below
// fail the turn with an error frame/body before a terminal candidate is
// emitted. The OTHER rows exist so a direct caller of this map (or a future
// path that forgets the guard) still cannot certify a half answer as clean.
const FINISH_MAP = {
  stop: 'STOP',
  length: 'MAX_TOKENS',
  tool_calls: 'STOP',
  content_filter: 'SAFETY',
  error: 'OTHER',
  unterminated: 'OTHER',
};
function mapFinishReason(openaiReason) {
  if (!openaiReason) return 'STOP';
  return FINISH_MAP[openaiReason] || 'STOP';
}

// The one message both Gemini exits report when the upstream closed a turn
// without saying how it ended. Mirrors messages.js / responses.js (G3).
const UPSTREAM_UNTERMINATED_MESSAGE =
  'The upstream ended the turn without a completion reason (truncated response).';

// G3: the Connect decoder's truncation terminal, on either the choice or the
// frame (responses.js accepts both shapes, so this route must too).
function isUnterminatedFinish(chunk) {
  return chunk?.unterminated === true
    || chunk?.choices?.[0]?.unterminated === true
    || chunk?.choices?.[0]?.finish_reason === 'error';
}

// Parse a tool call's `arguments` string into Gemini's functionCall.args struct.
//
// Mirrors messages.js "B4": a malformed arguments string used to be silently
// swallowed into `{}` here, dropping every tool parameter with no trace on
// either channel — no log line and no counter, so a truncated upstream reply
// was indistinguishable from a tool call that genuinely took no arguments.
// Log the tool name plus the raw string, and keep the raw string under a
// private key so a downstream consumer can still recover it (Gemini clients
// ignore unknown keys inside args, same as Anthropic on tool_use.input).
//
// Deliberately NOT mapped to Gemini's MALFORMED_FUNCTION_CALL finishReason:
// that would change the turn's terminal state, which is a bigger behaviour
// change than restoring observability, and the upstream — not the caller —
// is what malformed here.
function parseToolArgs(rawArgs, toolName) {
  try {
    return JSON.parse(rawArgs || '{}');
  } catch (e) {
    log.warn(`gemini: functionCall arguments JSON parse failed for tool "${toolName || 'unknown'}" — ${e.message}; raw=${JSON.stringify(rawArgs)}`);
    return { __raw_arguments: rawArgs ?? '' };
  }
}

// Gemini tool_choice (toolConfig.functionCallingConfig.mode) → OpenAI tool_choice.
// Gemini declares Schema.type as an UPPERCASE enum (STRING / OBJECT / ARRAY /
// NUMBER / INTEGER / BOOLEAN, plus TYPE_UNSPECIFIED), while everything downstream of
// this frontend is JSON-Schema shaped and compares the lowercase spelling. Nothing in
// the repo normalized it, so a spec-conforming Gemini client's tool schema was opaque
// to every consumer that inspects `type`.
//
// Measured before this: a tool sent as {type:'OBJECT', properties:{command:{type:
// 'STRING'}}, required:['command']} reached intent-extractor's indexTools, whose
// `params?.type === 'object'` test failed, so no primary parameter resolved and NLU
// recovery produced NOTHING for the same narrative that yields {"command":"ls -la"}
// from an equivalent lowercase schema. (The original report described a wrongly-NAMED
// argument instead; that symptom changed when layer 1 started dropping unresolvable
// slots rather than inventing `_value`. Same root cause, quieter failure — Gemini
// clients silently lost the recovery path altogether.)
//
// Normalizing here rather than at each consumer is deliberate: this function is the
// single boundary where Gemini's wire vocabulary becomes the internal one, and a
// consumer-side fix would have to be repeated for every reader of `type`.
const GEMINI_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);

function normalizeSchemaTypes(node, depth = 0) {
  // Depth bound mirrors the one in response-store's field walk: a hostile or merely
  // silly schema must not turn this into unbounded recursion.
  if (depth > 12 || node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((v) => normalizeSchemaTypes(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' && typeof v === 'string') {
      const lower = v.toLowerCase();
      // Only rewrite spellings that ARE the JSON-Schema vocabulary. TYPE_UNSPECIFIED
      // and anything unrecognized pass through untouched — inventing a type for them
      // would be worse than leaving a consumer to ignore it, and `type` also appears
      // in non-schema positions (a tool_result block's discriminator, for instance).
      out[k] = GEMINI_SCHEMA_TYPES.has(lower) ? lower : v;
    } else if (k === 'type' && Array.isArray(v)) {
      // JSON-Schema union form, e.g. ['STRING','NULL'].
      out[k] = v.map((t) => (typeof t === 'string' && GEMINI_SCHEMA_TYPES.has(t.toLowerCase()) ? t.toLowerCase() : t));
    } else {
      out[k] = normalizeSchemaTypes(v, depth + 1);
    }
  }
  return out;
}

function mapGeminiToolChoice(toolConfig) {
  const mode = toolConfig?.functionCallingConfig?.mode;
  if (!mode) return undefined;
  switch (String(mode).toUpperCase()) {
    case 'AUTO': return 'auto';
    case 'ANY': {
      // ANY with a single allowed name pins that function; otherwise "required".
      const allowed = toolConfig.functionCallingConfig.allowedFunctionNames;
      if (Array.isArray(allowed) && allowed.length === 1) {
        return { type: 'function', function: { name: allowed[0] } };
      }
      return 'required';
    }
    case 'NONE': return 'none';
    default: return 'auto';
  }
}

// Build a stable tool_call id from a Gemini functionCall. Gemini matches a
// functionResponse to its call by NAME (no id field on the wire), so we mint
// deterministic ids and pair each functionResponse to its functionCall. Gemini
// wire has no per-call id historically, so we mint one and FIFO-match by name;
// modern v1beta parts may carry an explicit `id`, which we prefer when present.
function callIdFor(name, seq) {
  return sanitizeToolId(`call_${sanitizeToolName(name || 'fn')}_${seq}`);
}

// ─── Gemini → OpenAI request translation ────────────────────────
export function geminiToOpenAI(body, modelFromPath) {
  const messages = [];

  // systemInstruction can be a string, { parts:[{text}] }, or { text }.
  const sysText = extractText(body?.systemInstruction);
  if (sysText) messages.push({ role: 'system', content: sysText });

  // FIFO queue of synthesized ids per function name so a later functionResponse
  // pairs to the correct functionCall — even when the same function is called
  // multiple times in parallel in one turn (the old "last id per name" Map
  // misrouted every same-name response to the FINAL call, orphaning the earlier
  // ones and duplicating a tool_call_id → upstream 400 / mis-fed tool results).
  const historyNames = [];
  for (const c of (body?.contents || [])) {
    for (const part of (Array.isArray(c?.parts) ? c.parts : [])) {
      if (typeof part?.functionCall?.name === 'string' && part.functionCall.name) historyNames.push(part.functionCall.name);
      if (typeof part?.functionResponse?.name === 'string' && part.functionResponse.name) historyNames.push(part.functionResponse.name);
    }
  }
  const declaredNames = [];
  for (const t of (body?.tools || [])) {
    for (const fd of (t?.functionDeclarations || [])) {
      if (typeof fd?.name === 'string' && fd.name) declaredNames.push(fd.name);
    }
  }
  const allowedNames = Array.isArray(body?.toolConfig?.functionCallingConfig?.allowedFunctionNames)
    ? body.toolConfig.functionCallingConfig.allowedFunctionNames.filter((n) => typeof n === 'string' && n)
    : [];
  const toolNameMap = toolHygieneEnabled()
    ? buildToolNameMap([...declaredNames, ...historyNames, ...allowedNames])
    : null;
  const hasNameRewrites = toolNameMap
    ? [...toolNameMap.toUpstream].some(([client, wire]) => client !== wire)
    : false;

  const pendingIdsByName = new Map();
  let callSeq = 0;

  for (const c of (body?.contents || [])) {
    const geminiRole = c?.role;
    const role = geminiRole === 'model' ? 'assistant' : 'user';
    const parts = Array.isArray(c?.parts) ? c.parts : [];

    const textParts = [];
    const imageParts = [];
    const toolCalls = [];
    const functionResponses = [];

    for (const part of parts) {
      if (part == null) continue;
      if (typeof part.text === 'string') {
        // Gemini marks model "thinking" output with `thought: true`. Those
        // are reasoning traces from a prior turn; the model regenerates them,
        // so drop from the forwarded history (parity with messages.js skipping
        // assistant `thinking` blocks).
        if (part.thought === true) continue;
        textParts.push(part.text);
      } else if (part.inlineData && part.inlineData.data) {
        // Gemini inline media → OpenAI image_url data URL (chat.js accepts
        // both `image` and `image_url`; data URL is the canonical OpenAI form
        // and is what src/image.js / cache.js normalize).
        const mime = part.inlineData.mimeType || 'image/png';
        imageParts.push({
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${part.inlineData.data}` },
        });
      } else if (part.fileData && part.fileData.fileUri) {
        // fileData references a Google Files API upload by URI. We can't fetch
        // it server-side here, so forward the URI as image_url and let the
        // backend's media handling decide. TODO(unverified): Files API URI
        // resolution against the DEVIN/Cascade backend is not implemented.
        imageParts.push({
          type: 'image_url',
          image_url: { url: part.fileData.fileUri },
        });
      } else if (part.functionCall) {
        const seq = callSeq++;
        const clientName = part.functionCall.name || 'unknown';
        const wireName = toolNameMap?.toUpstream.get(clientName) ?? clientName;
        const explicitId = part.functionCall.id == null || part.functionCall.id === ''
          ? ''
          : (toolHygieneEnabled() ? sanitizeToolId(String(part.functionCall.id)) : String(part.functionCall.id));
        const id = explicitId || callIdFor(wireName, seq);
        // Enqueue every call: a functionResponse may legally omit `id`, and FIFO
        // must pair to this call instead of minting a second id.
        if (!pendingIdsByName.has(clientName)) pendingIdsByName.set(clientName, []);
        pendingIdsByName.get(clientName).push(id);
        toolCalls.push({
          id,
          type: 'function',
          function: { name: wireName, arguments: JSON.stringify(part.functionCall.args ?? {}) },
        });
      } else if (part.functionResponse) {
        const name = part.functionResponse.name || 'unknown';
        const explicitId = part.functionResponse.id == null || part.functionResponse.id === ''
          ? ''
          : (toolHygieneEnabled() ? sanitizeToolId(String(part.functionResponse.id)) : String(part.functionResponse.id));
        const queue = pendingIdsByName.get(name);
        let id;
        if (explicitId) {
          id = explicitId;
          const at = queue ? queue.indexOf(explicitId) : -1;
          if (at !== -1) queue.splice(at, 1);
        } else if (queue && queue.length) {
          id = queue.shift();
        } else {
          id = callIdFor(toolNameMap?.toUpstream.get(name) ?? name, callSeq++);
        }
        const resp = part.functionResponse.response;
        const content = typeof resp === 'string' ? resp : JSON.stringify(resp ?? {});
        functionResponses.push({ role: 'tool', tool_call_id: id, content });
      }
    }

    // Tool results must directly follow the assistant tool_calls message in
    // OpenAI format. Emit them first (they belong to a prior assistant turn).
    for (const tr of functionResponses) messages.push(tr);

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

  // tools.functionDeclarations → OpenAI tools. Gemini also allows server-side
  // tools (googleSearch, codeExecution, urlContext) as bare keys on a tool
  // object. The proxy cannot execute those, and the old behaviour — count and
  // drop them with a log line — returned a 200 for a turn whose search/exec
  // never ran (Q4 G06). Refuse the request instead, through the same
  // `unsupported_server_side_tool` code the OpenAI/Anthropic surfaces use, so
  // no caller has to guess why the tool disappeared. Checked before any
  // functionDeclarations are translated: one bad tool rejects the request.
  const unsupportedGeminiTool = firstUnsupportedGeminiServerTool(body?.tools);
  if (unsupportedGeminiTool) throw geminiServerSideToolUnsupported(unsupportedGeminiTool);
  const tools = [];
  for (const t of (body?.tools || [])) {
    if (Array.isArray(t?.functionDeclarations)) {
      for (const fd of t.functionDeclarations) {
        tools.push({
          type: 'function',
          function: {
            name: toolNameMap?.toUpstream.get(fd.name) ?? fd.name,
            description: fd.description || '',
            // `parametersJsonSchema` is already JSON-Schema (lowercase by
            // definition); `parameters` is Gemini's Schema with UPPERCASE type
            // enums. normalizeSchemaTypes only rewrites the recognized vocabulary,
            // so running it over both is safe and keeps one code path.
            parameters: normalizeSchemaTypes(fd.parameters || fd.parametersJsonSchema || {}),
          },
        });
      }
    }
  }

  const gc = body?.generationConfig || {};
  // Structured output: responseMimeType application/json (+ optional
  // responseSchema / responseJsonSchema) → OpenAI response_format.
  let responseFormat = null;
  if (gc.responseMimeType === 'application/json') {
    const schema = gc.responseSchema || gc.responseJsonSchema;
    if (schema) {
      responseFormat = {
        type: 'json_schema',
        json_schema: { name: 'response', schema, strict: true },
      };
    } else {
      responseFormat = { type: 'json_object' };
    }
  }

  // thinkingConfig → reasoning hint. Gemini 2.5 exposes thinkingBudget
  // (token budget) and includeThoughts. The internal handler speaks the
  // `thinking` dialect (passed through to chat.js, same as messages.js).
  // TODO(unverified): exact thinkingBudget→effort mapping against this
  // backend is not calibrated; we forward a coarse enabled/disabled hint.
  let thinking = null;
  if (gc.thinkingConfig && typeof gc.thinkingConfig === 'object') {
    const budget = gc.thinkingConfig.thinkingBudget;
    if (budget === 0) {
      thinking = { type: 'disabled' };
    } else {
      thinking = { type: 'enabled', ...(typeof budget === 'number' ? { budget_tokens: budget } : {}) };
    }
  }

  const mappedToolChoice = mapGeminiToolChoice(body?.toolConfig);
  const toolChoice = mappedToolChoice?.type === 'function'
    ? { ...mappedToolChoice, function: { ...mappedToolChoice.function, name: toolNameMap?.toUpstream.get(mappedToolChoice.function.name) ?? mappedToolChoice.function.name } }
    : mappedToolChoice;

  return {
    model: modelFromPath || body?.model || 'gemini-2.5-pro',
    messages,
    // Gemini defaults to a model-specific max; pick a safe default when unset.
    max_tokens: gc.maxOutputTokens || 8192,
    stream: false, // caller overrides per path
    ...(tools.length ? { tools } : {}),
    ...(gc.temperature != null ? { temperature: gc.temperature } : {}),
    ...(gc.topP != null ? { top_p: gc.topP } : {}),
    // F5 (DataAuditTools): `topK` is Gemini's flagship sampling knob and the
    // chat DEVIN_CONNECT path consumes the internal `top_k` into
    // CompletionConfig.topK — /v1/messages already forwards the same field.
    // Dropping it here made the caller's determinism/quality setting a silent
    // no-op on the one surface that names it topK.
    ...(gc.topK != null ? { top_k: gc.topK } : {}),
    ...(Array.isArray(gc.stopSequences) && gc.stopSequences.length ? { stop: gc.stopSequences } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(thinking ? { thinking } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(hasNameRewrites ? { __toolNameMap: toolNameMap } : {}),
  };
}

// systemInstruction / Content text extraction helper.
function extractText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (typeof node.text === 'string') return node.text;
  if (Array.isArray(node.parts)) {
    return node.parts.map(p => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
  }
  return '';
}

// ─── usageMetadata builder (OpenAI usage → Gemini) ──────────────
function buildUsageMetadata(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const candidates = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const cached = usage.cache_read_input_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? 0;
  const thoughts = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  const total = usage.total_tokens ?? (prompt + candidates);
  const meta = {
    promptTokenCount: prompt,
    candidatesTokenCount: candidates,
    totalTokenCount: total,
  };
  if (cached) meta.cachedContentTokenCount = cached;
  if (thoughts) meta.thoughtsTokenCount = thoughts;
  return meta;
}

// ─── OpenAI → Gemini non-stream response translation ────────────
export function openAIToGemini(result, model, toolNameMap = null) {
  const choice = result?.choices?.[0];
  const msg = choice?.message || {};
  const parts = [];

  // Reasoning trace → thought part (Gemini marks thinking parts with thought:true).
  if (msg.reasoning_content) {
    parts.push({ text: msg.reasoning_content, thought: true });
  }
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    if (msg.content) parts.push({ text: msg.content });
    // Upstream may reuse one call id for two distinct calls; the client must
    // never see the same functionCall id twice (GFProtocol Q1-04).
    const allocateToolId = toolHygieneEnabled() ? createToolIdAllocator() : (id) => id || '';
    for (const tc of msg.tool_calls) {
      const name = restoreToolName(tc.function?.name, toolNameMap) || 'unknown';
      const args = parseToolArgs(tc.function?.arguments, name);
      const functionCall = { name, args };
      if (tc.id) functionCall.id = allocateToolId(tc.id);
      parts.push({ functionCall });
    }
  } else {
    parts.push({ text: msg.content || '' });
  }

  const candidate = {
    content: { role: 'model', parts },
    // G3: the unterminated marker can ride next to a fabricated 'stop'
    // finish_reason. It wins: the turn did not complete, so never render it as
    // a clean STOP (OTHER is the non-clean fallback for direct callers; the
    // route itself fails the turn before reaching this map).
    finishReason: isUnterminatedFinish(result) ? 'OTHER' : mapFinishReason(choice?.finish_reason),
    index: 0,
  };

  const out = {
    candidates: [candidate],
    // Same precedence flip as messages.js: chat.js already reports what actually ran,
    // so the upstream name wins over the requested one and this route stops
    // misreporting a degraded request.
    modelVersion: result?.model || model || '',
  };
  const usageMetadata = buildUsageMetadata(result?.usage);
  if (usageMetadata) out.usageMetadata = usageMetadata;
  return out;
}

// ─── Streaming translator: OpenAI SSE → Gemini frames ───────────
// Mode 'sse'   → each frame written as `data: {json}\r\n\r\n` (?alt=sse).
// Mode 'array' → frames streamed inside a JSON array: `[`, frame, `,frame`, `]`
//                (the default :streamGenerateContent wire format).
class GeminiStreamTranslator {
  constructor(res, model, { mode = 'sse', toolNameMap = null } = {}) {
    this.res = res;
    this.model = model;
    this.mode = mode;
    this.toolNameMap = toolNameMap;
    this.toolCallBufs = new Map(); // index → { id, rawId, name, argsBuffered }
    // Egress id allocator: upstream may reuse one call id for two distinct
    // calls, but the client must never see the same functionCall id twice
    // (GFProtocol Q1-04). First-seen id wins; duplicates get a stable suffix.
    this.allocateToolId = toolHygieneEnabled() ? createToolIdAllocator() : (id) => id || '';
    this.finalUsage = null;
    this.finishReason = 'STOP';
    this.finished = false;
    this.sseFramer = new SseFramer({ onFrame: (frame) => this.handleSseFrame(frame) });
    this.frameCount = 0;
    // True once a terminal signal is seen: choice.finish_reason, an upstream
    // error chunk, or the `[DONE]` sentinel. finish() relies on this to tell a
    // normal completion apart from an abnormally cut-off stream.
    this.sawTerminalSignal = false;
    // True when the ONLY finish frame seen was one chat.js fabricated to close a
    // stream that died mid-answer. It suppresses the `[DONE]` shortcut above, since
    // chat.js emits `[DONE]` on that path too — so both signals must be discounted
    // together or BUG1's guard stays defeated.
    this.sawSyntheticFinish = false;
    // G3: set when the upstream's terminal frame says the turn was NOT completed
    // (`finish_reason:'error'` / `unterminated:true`). finish() fails the turn
    // with an error frame instead of emitting a terminal candidate — otherwise
    // mapFinishReason would have to invent a reason and the client would read a
    // truncated answer as final.
    this.upstreamError = false;
    // V-08/D8: one abort-aware bounded writer for this egress. `res` is the REAL
    // response; the Chat producer writes into `createCaptureRes`, which reports
    // THIS writer's pressure back to it. Without the wait the translator consumed
    // `res.write()`'s false verdict itself, so the Cascade/Connect producer was
    // never held and a slow reader bought unbounded upstream production.
    const maxWaitMs = resolveMaxDrainWaitMs();
    this.writer = createBoundedWriter({
      res,
      maxWaitMs,
      onTimeout: () => {
        // Teardown belongs to chat.js's own bounded writer (it writes the typed
        // DRAIN_TIMEOUT frame and aborts the upstream turn). Log only: ending the
        // response here would race that stage and strip the error frame.
        log.warn(`Gemini: no drain for ${maxWaitMs}ms — the client stopped reading`);
      },
    });
  }

  /** True while the client's socket has not accepted the bytes we handed it. */
  get egressOk() {
    return !this.writer.pending;
  }

  // Write one Gemini frame (a GenerateContentResponse) in the active mode.
  writeFrame(obj) {
    if (this.res.writableEnded) return true;
    const json = JSON.stringify(obj);
    const text = this.mode === 'sse'
      ? `data: ${json}\r\n\r\n`
      // JSON array: open bracket on first frame, comma-separate the rest.
      : (this.frameCount === 0 ? `[${json}` : `,${json}`);
    this.frameCount++;
    // V-08/D8: the real verdict, so a pressured socket holds the producer.
    return this.writer.write(text);
  }

  // Emit a candidate frame carrying a single part (text or functionCall).
  emitPart(part, { finishReason = null, usageMetadata = null } = {}) {
    const candidate = { content: { role: 'model', parts: [part] }, index: 0 };
    if (finishReason) candidate.finishReason = finishReason;
    const frame = { candidates: [candidate], modelVersion: this.model };
    if (usageMetadata) frame.usageMetadata = usageMetadata;
    this.writeFrame(frame);
  }

  emitTextDelta(text, { thought = false } = {}) {
    if (!text) return;
    const part = { text };
    if (thought) part.thought = true;
    this.emitPart(part);
  }

  bufferToolCall(tc) {
    const idx = tc.index ?? 0;
    let existing = this.toolCallBufs.get(idx);
    if (!existing) {
      existing = {
        id: tc.id ? this.allocateToolId(tc.id) : null,
        rawId: tc.id || null,
        wireName: '',
        name: '',
        argsBuffered: '',
      };
      this.toolCallBufs.set(idx, existing);
    } else if (tc.id && tc.id !== existing.rawId) {
      // The id is delivered once, possibly on a later delta than the first. A
      // repeated id is the same call and must not be allocated twice.
      existing.rawId = tc.id;
      existing.id = this.allocateToolId(tc.id);
    }
    const rawName = tc.function?.name;
    if (rawName) {
      // function.name may be split across deltas. Accumulate idempotently: a
      // repeated full name replaces the prefix, a prefix does not duplicate.
      if (!existing.wireName) existing.wireName = rawName;
      else if (rawName === existing.wireName || rawName.startsWith(existing.wireName)) existing.wireName = rawName;
      else if (!existing.wireName.startsWith(rawName)) existing.wireName += rawName;
      existing.name = restoreToolName(existing.wireName, this.toolNameMap) || existing.wireName;
    }
    if (tc.function?.arguments) existing.argsBuffered += tc.function.arguments;
  }

  // Flush accumulated tool calls as functionCall parts. Gemini transmits a
  // functionCall as a complete object (not incremental JSON), so we buffer
  // the OpenAI argument fragments and emit once the stream finishes.
  flushToolCalls(finishReason, usageMetadata) {
    const bufs = [...this.toolCallBufs.values()];
    if (!bufs.length) return false;
    bufs.forEach((buf, i) => {
      const name = restoreToolName(buf.name, this.toolNameMap) || 'unknown';
      const args = parseToolArgs(buf.argsBuffered, name);
      const isLast = i === bufs.length - 1;
      const functionCall = { name, args };
      if (buf.id) functionCall.id = buf.id;
      this.emitPart(
        { functionCall },
        isLast ? { finishReason, usageMetadata } : {},
      );
    });
    return true;
  }

  processChunk(chunk) {
    // The check below only handles an error carried by THIS chunk. Once error() or
    // finish() has run, `finished` is set and nothing further may be written — but
    // processChunk did not consult it, so a stream that kept sending after an
    // in-band error went on emitting candidate frames.
    //
    // In array mode that is not merely a stray frame: error() closes the JSON array
    // with `]`, and writeFrame (which checks only `writableEnded`) then appends
    // `,{...}` AFTER the closing bracket. Measured before this guard, the response
    // body was `[{...},{"error":...}],{"candidates":...}` and JSON.parse threw
    // "Unexpected non-whitespace character after JSON at position 180" — the whole
    // body unparseable, not just the trailing frame lost.
    if (this.finished) return;
    if (chunk.error) {
      this.sawTerminalSignal = true;
      this.error(chunk.error);
      return;
    }
    // G3: the Connect decoder's truncation terminal. Checked before the normal
    // finish-reason branch so the turn is failed in finish() even though the
    // frame itself is a terminal signal.
    if (isUnterminatedFinish(chunk)) this.upstreamError = true;
    // Adopt the upstream's model name before the first frame is emitted.
    //
    // Constructed with the REQUESTED name (it must exist before the upstream call), so a
    // degraded connect request — WINDSURFAPI_STRICT_MODEL=0 rewriting an unmapped paid
    // name to the free selector — would report the paid name it never ran. Every OpenAI
    // chunk carries the truthful name.
    //
    // Gated on frameCount rather than on a "started" flag: EVERY gemini frame carries
    // modelVersion, so adopting after the first frame would emit two different names
    // within one response.
    if (this.frameCount === 0 && typeof chunk.model === 'string' && chunk.model) {
      this.model = chunk.model;
    }
    const choice = chunk.choices?.[0];
    if (choice) {
      const delta = choice.delta || {};
      if (delta.reasoning_content) this.emitTextDelta(delta.reasoning_content, { thought: true });
      if (delta.content) this.emitTextDelta(delta.content);
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) this.bufferToolCall(tc);
      }
      if (choice.finish_reason) {
        // A SYNTHETIC terminal chunk is not a terminal signal. chat.js closes a
        // stream that died AFTER delivering content with a FABRICATED
        // finish_reason:'stop' (injecting the error as a content delta would
        // corrupt the assistant message). That satisfied this check and defeated
        // the truncation guard in finish() — verified: a mid-stream death returned
        // finishReason:'STOP' with no error frame, telling the client the answer
        // was complete. Same guard as messages.js and responses.js.
        if (chunk.__synthetic_finish || chunk.__windsurf_end_reason === 'upstream_truncated') this.sawSyntheticFinish = true;
        else this.sawTerminalSignal = true;
        this.finishReason = mapFinishReason(choice.finish_reason);
      }
    }
    if (chunk.usage) this.finalUsage = chunk.usage;
  }

  finish() {
    if (this.finished) return;
    this.sseFramer.end();
    if (this.finished) return;
    // An abnormally cut-off stream (network drop, upstream abort, hung-stream
    // deadline) reaches finish() with NO terminal signal — no choice.finish_reason,
    // no [DONE], no error frame. Emitting a terminal candidate with
    // finishReason:'STOP' here tells the Gemini client the answer is complete when
    // it was truncated mid-flight, so it accepts the partial answer as final
    // instead of retrying. Gemini's finishReason enum has no "truncated" value, so
    // a truncation must surface as an `error` frame (502 → UNAVAILABLE, retryable)
    // — same fix as the Anthropic frontend's BUG1.
    //
    // The condition was `this.started && !this.sawTerminalSignal`, so a stream that
    // died having produced ZERO content skipped the guard entirely and fell through
    // to the normal terminal below. MEASURED on master c3ac2b2: exactly ONE SSE
    // frame, candidates[0].finishReason === 'STOP', parts [{text:''}], no error
    // frame — the client reads "the answer is complete, and it is empty". The
    // `started` half was never load-bearing: an upstream that dies before its first
    // delta is the SAME fault as one that dies after, and /v1/responses already
    // treated both alike (`aborted = !this.sawTerminalChunk`, no started gate).
    //
    // What still must NOT error: zero content WITH a terminal signal. A
    // legitimately empty completion happens in production (DEVIN_CONNECT
    // retry-on-empty and the reasoning-only rescue both exist because of it, and
    // #238 is about a strict client erroring on an empty answer), and it keeps a
    // clean STOP terminal because sawTerminalSignal is set. Only the ABSENCE of the
    // signal is the fault.
    // G3: the upstream named a truncation terminal (`finish_reason:'error'` /
    // `unterminated:true`). It IS a terminal signal, so the guard below would
    // let it through; fail the turn explicitly with the same retryable shape as
    // an abnormally cut-off stream instead of emitting a terminal candidate.
    // Gemini's enum has no "truncated", and mapFinishReason's OTHER fallback is
    // a last resort for direct callers — a real client must see the error.
    if (this.upstreamError) {
      this.error({
        status: 502,
        type: 'upstream_error',
        message: UPSTREAM_UNTERMINATED_MESSAGE,
      });
      return;
    }
    if (!this.sawTerminalSignal) {
      this.error({
        status: 502,
        type: 'upstream_error',
        message: 'Upstream stream ended before completion (no terminal signal — response is incomplete)',
      });
      return;
    }
    this.finished = true;
    const usageMetadata = buildUsageMetadata(this.finalUsage);
    // If tool calls were buffered, the terminating frame carries the last
    // functionCall part + finishReason. Otherwise emit a final empty-text
    // candidate carrying finishReason + usage (Gemini's terminal frame shape).
    const hadTools = this.flushToolCalls(this.finishReason, usageMetadata);
    if (!hadTools) {
      this.emitPart({ text: '' }, { finishReason: this.finishReason, usageMetadata });
    }
    if (this.mode === 'array') {
      // Close the JSON array. If no frame ever wrote, still emit `[]`.
      if (!this.res.writableEnded) this.writer.write(this.frameCount === 0 ? '[]' : ']');
    }
  }

  error(err) {
    if (this.finished) return;
    // Resolve the authoritative {status,type} from the DEVIN_CONNECT code
    // first (so CAPACITY → 503 → UNAVAILABLE), then map to a Gemini error.
    const http = err?.code
      ? connectErrorToHttp(err.code)
      : { status: err?.status || 500, type: err?.type };
    const mapped = geminiError(http.status, http.type, err?.message);
    // Emit the error as a frame, then terminate. Gemini surfaces a mid-stream
    // error as a GenerateContentResponse-shaped object carrying `error`.
    if (!this.res.writableEnded) {
      const body = err?.code
        ? { ...mapped.body, error: {
          ...mapped.body.error,
          __upstream_code: err.code,
          ...(Number.isFinite(Number(err.retry_after_ms)) ? { retry_after_ms: Number(err.retry_after_ms) } : {}),
        } }
        : mapped.body;
      const json = JSON.stringify(body);
      if (this.mode === 'sse') {
        this.writer.write(`data: ${json}\r\n\r\n`);
      } else {
        this.writer.write(this.frameCount === 0 ? `[${json}]` : `,${json}]`);
      }
      this.frameCount++;
    }
    this.finished = true;
  }

  // SSE parser — handleChatCompletions writes `data: {...}\n\n` frames.
  // SseFramer owns CRLF, split UTF-8, multi-line data and EOF flush.
  feed(rawChunk) {
    this.sseFramer.push(rawChunk);
    // V-08/D8: the verdict the Chat producer reads. `push` dispatches every frame
    // synchronously, so `egressOk` is the state AFTER this chunk was emitted —
    // false means the socket reported backpressure and has not drained yet.
    return this.egressOk;
  }

  handleSseFrame({ data }) {
    if (!data) return;
    // `[DONE]` is the OpenAI stream's terminator, but it is NOT proof the turn
    // completed: chat.js writes it on the truncated path too (right after the
    // synthetic finish frame). Treating it as authoritative is the SECOND way
    // the truncation guard was defeated — plugging only the finish-frame check
    // above leaves this one open, which is why both are needed.
    if (data === '[DONE]') {
      if (!this.sawSyntheticFinish) this.sawTerminalSignal = true;
      return;
    }
    try {
      this.processChunk(JSON.parse(data));
    } catch (e) {
      log.warn(`Gemini SSE parse error: ${e.message}`);
    }
  }
}

export { GeminiStreamTranslator };

// ─── Fake ServerResponse that pipes writes into the translator ──
// Equivalent to messages.js createCaptureRes; kept self-contained here so we
// never have to modify the Anthropic frontend's exports.
function createCaptureRes(translator, realRes) {
  const listeners = new Map();
  const fire = (event) => {
    const cbs = listeners.get(event) || [];
    for (const cb of cbs) { try { cb(); } catch {} }
  };
  // V-08/D8: the producer (chat.js) waits for 'drain' on THIS fake response. The
  // translator's bounded writer owns the wait on the real socket, and the real
  // socket's drain is the only one that exists — without this forward the chat
  // writer would park on a signal that can never arrive (the 120s half-fix).
  if (realRes?.on) {
    realRes.on('drain', () => fire('drain'));
    realRes.on('error', () => fire('error'));
  }
  return {
    writableEnded: false,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    write(chunk) {
      // chat.js emits SSE heartbeat comments (`: ping\n\n`) while the upstream
      // is slow-polling. Gemini clients don't parse comments and the JSON-array
      // wire format can't carry them, so heartbeats are dropped here (the
      // translator only consumes `data:` lines). First-token latency is
      // unaffected because real content frames pass straight through.
      translator.feed(chunk);
      // V-08/D8: return the REAL socket's verdict (via the translator's bounded
      // writer). A constant `true` kept chat.js's bounded writer permanently
      // disarmed on this route, so the Cascade producer never paused.
      return translator.egressOk;
    },
    end(chunk) {
      if (this.writableEnded) return;
      if (chunk) translator.feed(chunk);
      translator.finish();
      this.writableEnded = true;
      fire('close');
    },
    _clientDisconnected() {
      // V-08/D8: settle the translator's outstanding drain wait and refuse any
      // further byte — a terminal frame must not be written into a socket that is
      // already gone. (The chat writer's own wait settles through fire('close').)
      translator.writer.dispose();
      // Release whatever the SSE framer still retains: after teardown no push
      // may reach it, and its "flood bytes unreachable" contract is only
      // enforced if dispose actually runs here.
      translator.sseFramer?.dispose();
      fire('close');
    },
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

// ─── Error mapping (transient-first, parity with connectErrorToHttp) ──
// Produces a Gemini-style error body { error: { code, message, status } }.
// Google's `status` enum uses gRPC canonical codes. The critical invariant:
// CAPACITY / upstream transient errors map to UNAVAILABLE (503, retryable),
// NOT PERMISSION_DENIED — leaking a transient blip as PERMISSION_DENIED would
// make a Gemini SDK give up instead of backing off, and (on our side) a
// retryable upstream error must never be confused with a dead token.
// Attach the upstream handler's transport headers to a translated error response.
// Mirrors the helper of the same name in messages.js — the error BODY is route
// vocabulary and geminiError owns it, but Retry-After is plain HTTP and belongs to
// whoever computed it. Measured before this: a non-stream 429 reached a Gemini client
// with no retry-after, while /v1/responses forwarded the same handler's header.
function withUpstreamHeaders(response, headers) {
  if (!headers || typeof headers !== 'object' || !Object.keys(headers).length) return response;
  return { ...response, headers: { ...headers, ...response.headers } };
}

export function geminiError(status, internalType, message) {
  let outStatus = status;
  let statusEnum;
  switch (internalType) {
    case 'capacity_error':
    case 'upstream_transient_error':
    case 'upstream_internal_error':
      statusEnum = 'UNAVAILABLE'; outStatus = 503; break;
    case 'insufficient_quota':
    case 'rate_limit_error':
    case 'rate_limit_exceeded':
      statusEnum = 'RESOURCE_EXHAUSTED'; outStatus = 429; break;
    case 'model_blocked':
      statusEnum = 'PERMISSION_DENIED'; outStatus = 403; break;
    default:
      statusEnum = null;
  }
  if (!statusEnum) {
    switch (status) {
      case 400: statusEnum = 'INVALID_ARGUMENT'; break;
      case 401: statusEnum = 'UNAUTHENTICATED'; break;
      case 403: statusEnum = 'PERMISSION_DENIED'; break;
      case 404: statusEnum = 'NOT_FOUND'; break;
      case 413: statusEnum = 'INVALID_ARGUMENT'; break;
      case 429: statusEnum = 'RESOURCE_EXHAUSTED'; break;
      case 504: statusEnum = 'DEADLINE_EXCEEDED'; break;
      case 502:
      case 503:
        // Upstream unavailable/overloaded → UNAVAILABLE so SDKs back off and
        // retry rather than failing hard.
        statusEnum = 'UNAVAILABLE'; outStatus = 503; break;
      default:
        statusEnum = status >= 500 ? 'INTERNAL' : 'INVALID_ARGUMENT';
    }
  }
  return {
    status: outStatus,
    body: {
      error: {
        code: outStatus,
        message: message || 'Upstream error',
        status: statusEnum,
      },
    },
  };
}

// ─── Main entry ─────────────────────────────────────────────────
// model       : resolved from the URL path ({model}:generateContent)
// body        : Gemini GenerateContentRequest
// context     : { callerKey, nativeBridgeCallerKey, handleChatCompletions? }
// opts.stream : streaming path (:streamGenerateContent)
// opts.alt    : 'sse' → SSE wire format; otherwise JSON-array wire format
export async function handleGemini(model, body, context = {}, { stream = false, alt = null } = {}) {
  const requestedModel = model || body?.model || 'gemini-2.5-pro';
  // F2 (DataAuditTools): `generationConfig.candidateCount` is the Gemini
  // spelling of OpenAI's `n`, and the chat route already refuses n>1 because
  // the upstream returns exactly one choice (chat.js "O2"). geminiToOpenAI
  // never read the field, so that gate was unreachable from this surface: a
  // caller sampling/voting across candidates got a 200 with a single candidate
  // and read `candidates[1..]` as undefined — a subtler failure than a 400.
  // Mirror the chat gate in Gemini vocabulary, before any model turn.
  const candidateCount = body?.generationConfig?.candidateCount;
  if (candidateCount != null && candidateCount !== 1) {
    return geminiError(
      400,
      null,
      'This proxy only supports candidateCount=1. The upstream backend returns a single candidate per request; set generationConfig.candidateCount to 1 (or omit it).',
    );
  }
  let openaiBody;
  try {
    openaiBody = geminiToOpenAI(body, requestedModel);
  } catch (err) {
    if (err?.code === 'unsupported_server_side_tool') {
      // The translator refuses a server-executed tool (G06). Gemini's envelope
      // carries a numeric `code` + status enum, so the shared string code rides
      // as `type` (the field OpenAI-family clients branch on) instead of
      // clobbering the numeric code.
      const mapped = geminiError(err.status || 400, null, err.message);
      mapped.body.error.type = err.code;
      if (err.param) mapped.body.error.param = err.param;
      return mapped;
    }
    throw err;
  }
  const toolNameMap = openaiBody.__toolNameMap || null;
  delete openaiBody.__toolNameMap;
  if (toolHygieneEnabled()) {
    openaiBody.messages = normalizeHistoryTail(
      normalizeToolIdsInMessages(openaiBody.messages, { seed: requestedModel }),
      { fold: true },
    );
  }
  const chatHandler = context.handleChatCompletions || handleChatCompletions;

  if (!stream) {
    const result = await chatHandler({ ...openaiBody, stream: false, __route: 'gemini' }, context);
    if (result.status !== 200) {
      return withUpstreamHeaders(geminiError(result.status, result.body?.error?.type, result.body?.error?.message), result.headers);
    }
    // G3: a 200 body whose terminal choice says the turn was NOT completed
    // (`finish_reason:'error'` / `unterminated:true`) is a truncated answer, not
    // a clean one. Surface it through the route's error path — Gemini has no
    // candidate status for "incomplete", and a STOP/OTHER candidate would tell
    // the client the partial answer is final.
    if (isUnterminatedFinish(result.body)) {
      return withUpstreamHeaders(geminiError(502, 'upstream_error', UPSTREAM_UNTERMINATED_MESSAGE), result.headers);
    }
    return { status: 200, body: openAIToGemini(result.body, requestedModel, toolNameMap) };
  }

  // Streaming path — ask handleChatCompletions for its streaming handler and
  // point its writes at our translator shim so the upstream poll loop drives
  // the downstream Gemini stream in real time.
  // O1: the internal chat stream omits the trailing usage-only frame unless the
  // caller opts in via stream_options.include_usage. This translator consumes
  // chunk.usage (→ this.finalUsage → the final frame's usageMetadata), so it must
  // opt in regardless of what the downstream Gemini client asked for — Gemini
  // always reports usageMetadata on the terminal frame. messages.js and
  // responses.js were updated when O1 landed; this route was missed, so every
  // Gemini streaming response shipped with usageMetadata entirely absent.
  const streamResult = await chatHandler(
    { ...openaiBody, stream: true, __route: 'gemini', stream_options: { ...(openaiBody.stream_options || {}), include_usage: true } },
    context,
  );

  if (!streamResult.stream) {
    // Non-stream error before any byte streamed — map to the Gemini error enum.
    return withUpstreamHeaders(geminiError(
      streamResult.status || 502,
      streamResult.body?.error?.type,
      streamResult.body?.error?.message,
    ), streamResult.headers);
  }

  const mode = alt === 'sse' ? 'sse' : 'array';
  return {
    status: 200,
    stream: true,
    mode,
    headers: {
      // SSE uses text/event-stream; the default array form is application/json
      // streamed incrementally (Gemini's :streamGenerateContent contract).
      'Content-Type': mode === 'sse' ? 'text/event-stream' : 'application/json',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
    async handler(realRes) {
      const translator = new GeminiStreamTranslator(realRes, requestedModel, { mode, toolNameMap });
      const captureRes = createCaptureRes(translator, realRes);

      // Forward client disconnect so the upstream is cancelled. Don't call
      // captureRes.end() here — that would set writableEnded and suppress the
      // abort path inside chat.js's stream handler.
      realRes.on('close', () => {
        if (!captureRes.writableEnded) captureRes._clientDisconnected();
      });

      try {
        await streamResult.handler(captureRes);
      } catch (e) {
        log.error(`Gemini stream error: ${e.message}`);
        translator.error({ type: 'api_error', message: e.message });
      }

      if (!realRes.writableEnded) realRes.end();
    },
  };
}

// Parse a Gemini v1beta path into { model, method }. Accepts:
//   /v1beta/models/gemini-2.5-pro:generateContent
//   /v1beta/models/gemini-2.5-pro:streamGenerateContent
//   /v1/models/...                (v1 alias)
//   /models/gemini-2.5-pro:generateContent
// Model ids can contain dots and dashes; the method is the suffix after the
// final ':'. Returns null when the path is not a generate call.
export function parseGeminiPath(pathname) {
  const m = pathname.match(/\/models\/([^:/]+):(\w+)$/);
  if (!m) return null;
  return { model: decodeURIComponent(m[1]), method: m[2] };
}
