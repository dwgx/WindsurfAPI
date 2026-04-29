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
import { handleChatCompletions } from './chat.js';
import { log } from '../config.js';

function genMsgId() {
  return 'msg_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

// Anthropic Messages API tool types whose execution lives on Anthropic's
// servers, not the client. The proxy treats these as opt-out: it cannot
// satisfy server_tool_result delivery without implementing each one
// against Cascade, so they're stripped from the request rather than
// translated into normal function tools.
//   web_search_20250305     server-side web search
//   code_execution_20250522 server-side python sandbox
//   advisor_20260301        Anthropic Advisor Strategy (sonnet+opus pair)
const SERVER_SIDE_ANTHROPIC_TOOL_TYPES = new Set([
  'web_search_20250305',
  'code_execution_20250522',
  'advisor_20260301',
]);

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
// Returns: { has1h, breakpointCount } describing the request.
function extractCachePolicy(body) {
  let breakpointCount = 0;
  let has1h = false;
  const visit = (block) => {
    if (!block || typeof block !== 'object') return;
    const cc = block.cache_control;
    if (cc && typeof cc === 'object' && cc.type === 'ephemeral') {
      breakpointCount++;
      if (cc.ttl === '1h') has1h = true;
      delete block.cache_control;
    }
  };
  if (Array.isArray(body.tools)) for (const t of body.tools) visit(t);
  if (Array.isArray(body.system)) for (const s of body.system) visit(s);
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (Array.isArray(m.content)) for (const c of m.content) visit(c);
    }
  }
  // Also accept top-level cache_control hint (auto-caching mode).
  if (body.cache_control && typeof body.cache_control === 'object') {
    if (body.cache_control.type === 'ephemeral') {
      breakpointCount++;
      if (body.cache_control.ttl === '1h') has1h = true;
    }
    delete body.cache_control;
  }
  return { has1h, breakpointCount };
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
            function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
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
      for (const tr of toolResults) messages.push(tr);
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
  const tools = (body.tools || []).reduce((acc, t) => {
    if (t?.type && SERVER_SIDE_ANTHROPIC_TOOL_TYPES.has(t.type)) {
      droppedServerTools.push(t.type);
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

function openAIToAnthropic(result, model, msgId) {
  const choice = result.choices?.[0];
  const usage = result.usage || {};
  const content = [];
  if (choice?.message?.reasoning_content) {
    content.push({ type: 'thinking', thinking: choice.message.reasoning_content });
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
    usage: buildAnthropicUsage(usage),
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
function buildAnthropicUsage(usage) {
  const cacheRead = usage.cache_read_input_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? 0;
  const cacheCreationFlat = usage.cache_creation_input_tokens || 0;
  const split = usage.cache_creation && typeof usage.cache_creation === 'object'
    ? {
        ephemeral_5m_input_tokens: usage.cache_creation.ephemeral_5m_input_tokens || 0,
        ephemeral_1h_input_tokens: usage.cache_creation.ephemeral_1h_input_tokens || 0,
      }
    : { ephemeral_5m_input_tokens: cacheCreationFlat, ephemeral_1h_input_tokens: 0 };
  return {
    input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
    output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    cache_creation_input_tokens: cacheCreationFlat,
    cache_read_input_tokens: cacheRead,
    cache_creation: split,
  };
}

// ─── Streaming translator: intercepts OpenAI SSE, emits Anthropic SSE ──

class AnthropicStreamTranslator {
  constructor(res, msgId, model) {
    this.res = res;
    this.msgId = msgId;
    this.model = model;
    // Current content block: null | { type, index }
    // type: 'text' | 'thinking' | 'tool_use'
    this.current = null;
    this.blockIndex = 0;
    this.toolCallBufs = new Map();   // index → { id, name, argsBuffered }
    this.finalUsage = null;
    this.stopReason = 'end_turn';
    this.messageStarted = false;
    this.messageStopped = false;
    this.pendingSseBuf = '';
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
    if (buf.blockIndex == null && buf.id && buf.name) {
      this.startBlock('tool_use', { id: buf.id, name: buf.name });
      buf.blockIndex = this.current.index;
      if (buf.pendingArgs) {
        const pending = buf.pendingArgs;
        buf.pendingArgs = '';
        buf.argsBuffered += pending;
        this.send('content_block_delta', {
          type: 'content_block_delta',
          index: buf.blockIndex,
          delta: { type: 'input_json_delta', partial_json: pending },
        });
      }
    }
    if (argsChunk) {
      if (buf.blockIndex == null) {
        buf.pendingArgs += argsChunk;
        return;
      }
      buf.argsBuffered += argsChunk;
      this.send('content_block_delta', {
        type: 'content_block_delta',
        index: buf.blockIndex,
        delta: { type: 'input_json_delta', partial_json: argsChunk },
      });
    }
  }

  processChunk(chunk) {
    if (chunk.error) {
      this.error(chunk.error);
      return;
    }
    this.startMessage();
    const choice = chunk.choices?.[0];
    if (choice) {
      const delta = choice.delta || {};
      if (delta.reasoning_content) this.emitThinkingDelta(delta.reasoning_content);
      if (delta.content) this.emitTextDelta(delta.content);
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) this.emitToolCallDelta(tc);
      }
      if (choice.finish_reason) {
        const stopMap = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' };
        this.stopReason = stopMap[choice.finish_reason] || 'end_turn';
      }
    }
    if (chunk.usage) this.finalUsage = chunk.usage;
  }

  finish() {
    if (this.messageStopped) return;
    this.messageStopped = true;
    this.closeCurrentBlock();
    const u = this.finalUsage || {};
    this.send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.stopReason, stop_sequence: null },
      usage: buildAnthropicUsage(u),
    });
    this.send('message_stop', { type: 'message_stop' });
  }

  error(err) {
    if (this.messageStopped) return;
    this.messageStopped = true;
    this.closeCurrentBlock();
    this.send('error', {
      type: 'error',
      error: {
        type: err?.type || 'api_error',
        message: err?.message || 'Upstream stream error',
      },
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
        if (payload === '[DONE]') continue;
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
  const chatHandler = context.handleChatCompletions || handleChatCompletions;
  // Augment callerKey with the per-user tag from metadata.user_id when
  // present so the cascade pool can isolate concurrent Claude Code users
  // sharing one API key. Bare API-key callers and other client SDKs that
  // do not send metadata.user_id keep the original callerKey unchanged.
  const subKey = extractCallerSubKey(body);
  const effectiveContext = subKey
    ? { ...context, callerKey: `${context.callerKey || ''}:user:${subKey}` }
    : context;

  if (!wantStream) {
    const result = await chatHandler({ ...openaiBody, stream: false, __route: 'messages' }, effectiveContext);
    if (result.status !== 200) {
      return {
        status: result.status,
        body: {
          type: 'error',
          error: {
            type: result.body?.error?.type || 'api_error',
            message: result.body?.error?.message || 'Unknown error',
          },
        },
      };
    }
    return { status: 200, body: openAIToAnthropic(result.body, requestedModel, msgId) };
  }

  // Streaming path — ask handleChatCompletions for its streaming handler and
  // point its writes at our translator shim. This lets the upstream Cascade
  // poll loop drive the downstream SSE in real time — no buffer-then-replay.
  const streamResult = await chatHandler({ ...openaiBody, stream: true, __route: 'messages' }, effectiveContext);

  if (!streamResult.stream) {
    // The OpenAI path returned a non-stream error (e.g. 403 model_not_entitled)
    return {
      status: streamResult.status || 502,
      body: {
        type: 'error',
        error: {
          type: streamResult.body?.error?.type || 'api_error',
          message: streamResult.body?.error?.message || 'Upstream error',
        },
      },
    };
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
      const translator = new AnthropicStreamTranslator(realRes, msgId, requestedModel);
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
