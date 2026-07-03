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

// ─── finish_reason mapping (OpenAI → Gemini) ────────────────────
// Gemini has no dedicated finishReason for function calls — a turn that
// ends in functionCall parts still reports STOP. content_filter → SAFETY.
const FINISH_MAP = {
  stop: 'STOP',
  length: 'MAX_TOKENS',
  tool_calls: 'STOP',
  content_filter: 'SAFETY',
};
function mapFinishReason(openaiReason) {
  if (!openaiReason) return 'STOP';
  return FINISH_MAP[openaiReason] || 'STOP';
}

// Gemini tool_choice (toolConfig.functionCallingConfig.mode) → OpenAI tool_choice.
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
// deterministic ids and track the most recent id per name to wire the
// matching tool result back to the right call.
function callIdFor(name, seq) {
  return `call_${(name || 'fn').replace(/[^a-zA-Z0-9_]/g, '_')}_${seq}`;
}

// ─── Gemini → OpenAI request translation ────────────────────────
export function geminiToOpenAI(body, modelFromPath) {
  const messages = [];

  // systemInstruction can be a string, { parts:[{text}] }, or { text }.
  const sysText = extractText(body?.systemInstruction);
  if (sysText) messages.push({ role: 'system', content: sysText });

  // Track the latest synthesized id for each function name so a later
  // functionResponse part can reference the correct tool_call_id.
  const lastIdByName = new Map();
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
        const name = part.functionCall.name || 'unknown';
        const id = callIdFor(name, callSeq++);
        lastIdByName.set(name, id);
        toolCalls.push({
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
        });
      } else if (part.functionResponse) {
        const name = part.functionResponse.name || 'unknown';
        const id = lastIdByName.get(name) || callIdFor(name, 0);
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
  // tools (googleSearch, codeExecution) as bare keys on a tool object; the
  // proxy can't honor those, so they're dropped (parity with the Anthropic
  // server-side tool drop in messages.js).
  const tools = [];
  let droppedServerTools = 0;
  for (const t of (body?.tools || [])) {
    if (Array.isArray(t?.functionDeclarations)) {
      for (const fd of t.functionDeclarations) {
        tools.push({
          type: 'function',
          function: {
            name: fd.name,
            description: fd.description || '',
            parameters: fd.parameters || fd.parametersJsonSchema || {},
          },
        });
      }
    }
    if (t?.googleSearch || t?.googleSearchRetrieval || t?.codeExecution || t?.urlContext) {
      droppedServerTools++;
    }
  }
  if (droppedServerTools) {
    log.info(`gemini: dropped ${droppedServerTools} server-side tool(s) (googleSearch/codeExecution/urlContext) - proxy does not implement them`);
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

  const toolChoice = mapGeminiToolChoice(body?.toolConfig);

  return {
    model: modelFromPath || body?.model || 'gemini-2.5-pro',
    messages,
    // Gemini defaults to a model-specific max; pick a safe default when unset.
    max_tokens: gc.maxOutputTokens || 8192,
    stream: false, // caller overrides per path
    ...(tools.length ? { tools } : {}),
    ...(gc.temperature != null ? { temperature: gc.temperature } : {}),
    ...(gc.topP != null ? { top_p: gc.topP } : {}),
    ...(Array.isArray(gc.stopSequences) && gc.stopSequences.length ? { stop: gc.stopSequences } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(thinking ? { thinking } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
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
export function openAIToGemini(result, model) {
  const choice = result?.choices?.[0];
  const msg = choice?.message || {};
  const parts = [];

  // Reasoning trace → thought part (Gemini marks thinking parts with thought:true).
  if (msg.reasoning_content) {
    parts.push({ text: msg.reasoning_content, thought: true });
  }
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    if (msg.content) parts.push({ text: msg.content });
    for (const tc of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
      parts.push({ functionCall: { name: tc.function?.name || 'unknown', args } });
    }
  } else {
    parts.push({ text: msg.content || '' });
  }

  const candidate = {
    content: { role: 'model', parts },
    finishReason: mapFinishReason(choice?.finish_reason),
    index: 0,
  };

  const out = {
    candidates: [candidate],
    modelVersion: model || result?.model || '',
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
  constructor(res, model, { mode = 'sse' } = {}) {
    this.res = res;
    this.model = model;
    this.mode = mode;
    this.toolCallBufs = new Map(); // index → { id, name, argsBuffered }
    this.finalUsage = null;
    this.finishReason = 'STOP';
    this.started = false;     // emitted real content (text/thought) or buffered a tool call
    this.finished = false;
    this.pendingSseBuf = '';
    this.frameCount = 0;
    // True once a terminal signal is seen: choice.finish_reason, an upstream
    // error chunk, or the `[DONE]` sentinel. finish() relies on this to tell a
    // normal completion apart from an abnormally cut-off stream.
    this.sawTerminalSignal = false;
  }

  // Write one Gemini frame (a GenerateContentResponse) in the active mode.
  writeFrame(obj) {
    if (this.res.writableEnded) return;
    const json = JSON.stringify(obj);
    if (this.mode === 'sse') {
      this.res.write(`data: ${json}\r\n\r\n`);
    } else {
      // JSON array: open bracket on first frame, comma-separate the rest.
      this.res.write(this.frameCount === 0 ? `[${json}` : `,${json}`);
    }
    this.frameCount++;
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
    this.started = true;
    const part = { text };
    if (thought) part.thought = true;
    this.emitPart(part);
  }

  bufferToolCall(tc) {
    const idx = tc.index ?? 0;
    this.started = true;
    let existing = this.toolCallBufs.get(idx);
    if (!existing) {
      existing = { id: tc.id, name: tc.function?.name, argsBuffered: '' };
      this.toolCallBufs.set(idx, existing);
    } else {
      if (tc.id) existing.id = tc.id;
      if (tc.function?.name) existing.name = tc.function.name;
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
      let args = {};
      try { args = JSON.parse(buf.argsBuffered || '{}'); } catch {}
      const isLast = i === bufs.length - 1;
      this.emitPart(
        { functionCall: { name: buf.name || 'unknown', args } },
        isLast ? { finishReason, usageMetadata } : {},
      );
    });
    return true;
  }

  processChunk(chunk) {
    if (chunk.error) {
      this.sawTerminalSignal = true;
      this.error(chunk.error);
      return;
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
        this.sawTerminalSignal = true;
        this.finishReason = mapFinishReason(choice.finish_reason);
      }
    }
    if (chunk.usage) this.finalUsage = chunk.usage;
  }

  finish() {
    if (this.finished) return;
    // An abnormally cut-off stream (network drop, upstream abort, hung-stream
    // deadline) reaches finish() with content already started but NO terminal
    // signal — no choice.finish_reason, no [DONE], no error frame. Emitting a
    // terminal candidate with finishReason:'STOP' here tells the Gemini client
    // the answer is complete when it was truncated mid-flight, so it accepts the
    // partial answer as final instead of retrying. Gemini's finishReason enum
    // has no "truncated" value, so a truncation must surface as an `error` frame
    // (502 → UNAVAILABLE, retryable) — same fix as the Anthropic frontend's BUG1.
    if (this.started && !this.sawTerminalSignal) {
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
      if (!this.res.writableEnded) this.res.write(this.frameCount === 0 ? '[]' : ']');
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
      const json = JSON.stringify(mapped.body);
      if (this.mode === 'sse') {
        this.res.write(`data: ${json}\r\n\r\n`);
      } else {
        this.res.write(this.frameCount === 0 ? `[${json}]` : `,${json}]`);
      }
      this.frameCount++;
    }
    this.finished = true;
  }

  // SSE parser — handleChatCompletions writes `data: {...}\n\n` frames.
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
        if (payload === '[DONE]') { this.sawTerminalSignal = true; continue; }
        try {
          this.processChunk(JSON.parse(payload));
        } catch (e) {
          log.warn(`Gemini SSE parse error: ${e.message}`);
        }
      }
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
      return true;
    },
    end(chunk) {
      if (this.writableEnded) return;
      if (chunk) translator.feed(chunk);
      translator.finish();
      this.writableEnded = true;
      fire('close');
    },
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

// ─── Error mapping (transient-first, parity with connectErrorToHttp) ──
// Produces a Gemini-style error body { error: { code, message, status } }.
// Google's `status` enum uses gRPC canonical codes. The critical invariant:
// CAPACITY / upstream transient errors map to UNAVAILABLE (503, retryable),
// NOT PERMISSION_DENIED — leaking a transient blip as PERMISSION_DENIED would
// make a Gemini SDK give up instead of backing off, and (on our side) a
// retryable upstream error must never be confused with a dead token.
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
  const openaiBody = geminiToOpenAI(body, requestedModel);
  const chatHandler = context.handleChatCompletions || handleChatCompletions;

  if (!stream) {
    const result = await chatHandler({ ...openaiBody, stream: false, __route: 'gemini' }, context);
    if (result.status !== 200) {
      return geminiError(result.status, result.body?.error?.type, result.body?.error?.message);
    }
    return { status: 200, body: openAIToGemini(result.body, requestedModel) };
  }

  // Streaming path — ask handleChatCompletions for its streaming handler and
  // point its writes at our translator shim so the upstream poll loop drives
  // the downstream Gemini stream in real time.
  const streamResult = await chatHandler({ ...openaiBody, stream: true, __route: 'gemini' }, context);

  if (!streamResult.stream) {
    // Non-stream error before any byte streamed — map to the Gemini error enum.
    return geminiError(
      streamResult.status || 502,
      streamResult.body?.error?.type,
      streamResult.body?.error?.message,
    );
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
      const translator = new GeminiStreamTranslator(realRes, requestedModel, { mode });
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
