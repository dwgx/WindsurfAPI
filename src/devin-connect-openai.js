/**
 * DEVIN_CONNECT → OpenAI ChatCompletion adapter.
 *
 * Bridges the structured stream from devin-connect.js (content / reasoning /
 * finish / usage events) into the two OpenAI-compatible response shapes the rest
 * of the proxy already emits:
 *
 *   - non-stream: a single `chat.completion` object
 *   - stream:     a sequence of `chat.completion.chunk` SSE frames + [DONE]
 *
 * The output shape is matched field-for-field to the Cascade path in
 * handlers/chat.js (role-priming chunk, reasoning_content before content, a
 * finish_reason:'stop' chunk, then a usage-only chunk) so a client can't tell
 * which backend served the request. Reasoning maps to `reasoning_content`,
 * which OpenAI-style clients hide by default — see handlers/chat.js:737.
 *
 * Pure translation: no network of its own, it only consumes streamChat().
 */

import { randomUUID } from 'crypto';
import { streamChat as realStreamChat, isRetryable } from './devin-connect.js';
import { ToolCallStreamParser, parseToolCallsFromText } from './handlers/tool-emulation.js';
import { log } from './config.js';

// streamChat is injectable so the adapter can be unit-tested without touching
// the network — mirrors the __set…ForTest convention in windsurf-api.js.
let streamChatImpl = realStreamChat;
export function __setStreamChatForTest(fn) {
  streamChatImpl = typeof fn === 'function' ? fn : realStreamChat;
}

const OBJECT_COMPLETION = 'chat.completion';
const OBJECT_CHUNK = 'chat.completion.chunk';

function newId() {
  return `chatcmpl-${randomUUID().replace(/-/g, '')}`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Collect a full DEVIN_CONNECT completion and shape it as a non-streaming
 * `chat.completion` object.
 *
 * @param {object} params  forwarded to streamChat (messages, model, token, …)
 * @param {object} [opts]
 * @param {string} [opts.id]            response id (default chatcmpl-…)
 * @param {number} [opts.created]       unix seconds (default now)
 * @param {string} [opts.displayModel]  model name echoed back to the client
 * @param {boolean} [opts.emulateTools] when true, parse <tool_call> markup out of
 *                                      the buffered answer and surface OpenAI
 *                                      tool_calls (text-emulation, swe-1.6 etc).
 * @returns {Promise<{status:number, body:object}>}
 */
export async function toChatCompletion(params, { id = newId(), created = nowSeconds(), displayModel, maxRetries = 2, retryBaseMs = 400, emulateTools = false } = {}) {
  const model = displayModel || params.model;

  // Non-stream path buffers the whole answer, so a transient failure (network
  // blip, 5xx, rate limit) can be retried cleanly — a discarded partial buffer
  // never duplicates tokens. Terminal errors (MODEL_BLOCKED / UNAUTHORIZED)
  // are not retryable and throw straight through for the handler to map.
  let content = '';
  let reasoning = '';
  let finishReason = 'stop';
  let usage = null;
  // Native tool calls (DEVIN_CONNECT_TOOL_CALL_TAGS calibrated) ride the terminal
  // finish event as ev.toolCalls (devin-connect.js:927). Null/empty on free tier
  // and un-calibrated deployments, where prompt emulation owns tool calls.
  let nativeToolCalls = [];
  for (let attempt = 0; ; attempt++) {
    try {
      content = ''; reasoning = ''; finishReason = 'stop'; usage = null; nativeToolCalls = [];
      for await (const ev of streamChatImpl(params)) {
        if (ev.type === 'content') content += ev.text;
        else if (ev.type === 'reasoning') reasoning += ev.text;
        else if (ev.type === 'finish') {
          if (ev.reason) finishReason = ev.reason;
          if (ev.usage) usage = ev.usage;
          if (ev.toolCalls && ev.toolCalls.length) nativeToolCalls = ev.toolCalls;
        }
      }
      break;
    } catch (err) {
      if (!isRetryable(err) || attempt >= maxRetries) throw err;
      const backoff = retryBaseMs * 2 ** attempt;
      log.warn(`DEVIN_CONNECT: retryable error (${err.code || err.message}); retry ${attempt + 1}/${maxRetries} in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  // Tool calls come from one of two sources, never both. Native decode wins:
  // when DEVIN_CONNECT_TOOL_CALL_TAGS is calibrated, streamChat surfaces real
  // ChatToolCall structs ({id, name, arguments}) on the finish event, so the
  // text never carries <tool_call> markup to parse. Otherwise (free tier /
  // un-calibrated) the connect models have no native function-calling slot, so
  // tool defs were injected into the prompt (normalizeMessagesForCascade) and
  // the model answers with <tool_call>…</tool_call> markup we pull back out,
  // mirroring the Cascade non-stream path (handlers/chat.js buildToolCalls).
  let toolCalls = [];
  if (nativeToolCalls.length) {
    // arguments is the raw JSON string off the wire (decodeToolCalls); map it to
    // the same shape parseToolCallsFromText produces so the message builder below
    // is source-agnostic.
    toolCalls = nativeToolCalls.map((tc) => ({
      id: tc.id, name: tc.name, argumentsJson: tc.arguments,
    }));
    finishReason = 'tool_calls';
  } else if (emulateTools) {
    const parsed = parseToolCallsFromText(content, {
      modelKey: params.model, provider: null, route: 'devin_connect',
    });
    if (parsed.toolCalls.length) {
      content = parsed.text;
      toolCalls = parsed.toolCalls;
    }
  }

  // OpenAI convention: content is a string (may be empty), never undefined.
  const message = { role: 'assistant', content: content || '' };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((tc, i) => ({
      id: tc.id || `call_${i}_${Date.now().toString(36)}`,
      type: 'function',
      function: { name: tc.name || 'unknown', arguments: tc.argumentsJson || tc.arguments || '{}' },
    }));
    // content is null when the turn is a tool call (the inline text is usually
    // a hallucinated preview the caller shouldn't show).
    message.content = null;
    finishReason = 'tool_calls';
  }

  const body = {
    id,
    object: OBJECT_COMPLETION,
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  if (usage) body.usage = usage;
  return { status: 200, body };
}

/**
 * Stream a DEVIN_CONNECT completion as OpenAI `chat.completion.chunk` SSE
 * frames. `send` is the SSE writer used in handlers/chat.js — a function taking
 * a JS object that it JSON-encodes onto the `data:` line. This helper does NOT
 * write `data: [DONE]` or close the response; the caller owns the socket
 * lifecycle (heartbeat, unregister, res.end) exactly as the Cascade path does.
 *
 * Emission order mirrors the Cascade stream:
 *   1. role-priming chunk (delta {role, content:''})
 *   2. reasoning_content deltas as they arrive
 *   3. content deltas as they arrive
 *   4. finish chunk (delta {}, finish_reason)
 *   5. usage-only chunk (choices [], usage) when usage is known
 *
 * @returns {Promise<{content:string, reasoning:string, finish_reason:string, usage:object|null}>}
 *          the assembled result, so callers can cache it after streaming.
 */
export async function streamChatCompletion(params, send, { id = newId(), created = nowSeconds(), displayModel, emulateTools = false } = {}) {
  const model = displayModel || params.model;
  const base = { id, object: OBJECT_CHUNK, created, model };

  // 1. Prime the stream with the assistant role so clients open the message
  //    even before any token arrives.
  send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });

  let content = '';
  let reasoning = '';
  let finishReason = 'stop';
  let usage = null;
  // Native tool calls (DEVIN_CONNECT_TOOL_CALL_TAGS calibrated) ride the terminal
  // finish event, not the content stream — captured here, emitted after the loop.
  let nativeToolCalls = [];

  // Tool emulation: run content deltas through the same streaming parser the
  // Cascade path uses. It strips <tool_call> markup from the text deltas and
  // surfaces fully-closed calls; we emit each as an OpenAI tool_calls delta
  // (whole arguments at once, keyed by index — matching Cascade, not
  // token-by-token argument streaming). finish_reason flips to tool_calls.
  const toolParser = emulateTools
    ? new ToolCallStreamParser({ modelKey: params.model, provider: null, route: 'devin_connect' })
    : null;
  const collectedToolCalls = [];
  const emitToolCalls = (calls) => {
    for (const tc of calls || []) {
      const idx = collectedToolCalls.length;
      collectedToolCalls.push(tc);
      send({ ...base, choices: [{ index: 0, delta: {
        tool_calls: [{
          index: idx,
          id: tc.id || `call_${idx}_${Date.now().toString(36)}`,
          type: 'function',
          function: { name: tc.name || 'unknown', arguments: tc.argumentsJson || '{}' },
        }],
      }, finish_reason: null }] });
    }
  };

  for await (const ev of streamChatImpl(params)) {
    if (ev.type === 'reasoning') {
      reasoning += ev.text;
      send({ ...base, choices: [{ index: 0, delta: { reasoning_content: ev.text }, finish_reason: null }] });
    } else if (ev.type === 'content') {
      content += ev.text;
      if (toolParser) {
        const { text, toolCalls } = toolParser.feed(ev.text);
        if (text) send({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
        emitToolCalls(toolCalls);
      } else {
        send({ ...base, choices: [{ index: 0, delta: { content: ev.text }, finish_reason: null }] });
      }
    } else if (ev.type === 'finish') {
      if (ev.reason) finishReason = ev.reason;
      if (ev.usage) usage = ev.usage;
      if (ev.toolCalls && ev.toolCalls.length) nativeToolCalls = ev.toolCalls;
    }
  }

  // Drain any tool_call still buffered at end-of-stream, plus the trailing text.
  if (toolParser) {
    const { text, toolCalls } = toolParser.flush();
    if (text) send({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
    emitToolCalls(toolCalls);
    if (collectedToolCalls.length) finishReason = 'tool_calls';
  }

  // Native tool calls win over text emulation (the two are mutually exclusive:
  // when native decode is calibrated the text carries no <tool_call> markup).
  // Only emit native if emulation produced nothing, so a call is never counted
  // twice. Native arrives whole on the finish event, so it's emitted here rather
  // than inline — same wire shape as the emulated deltas above.
  if (nativeToolCalls.length && !collectedToolCalls.length) {
    emitToolCalls(nativeToolCalls.map((tc) => ({
      id: tc.id, name: tc.name, argumentsJson: tc.arguments,
    })));
    finishReason = 'tool_calls';
  }

  // 4. Terminal finish chunk.
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });

  // 5. Usage-only chunk (OpenAI streams usage in a trailing choices:[] frame).
  if (usage) {
    send({ ...base, choices: [], usage });
  }

  return { content, reasoning, finish_reason: finishReason, usage, toolCalls: collectedToolCalls };
}

export const __testing = { newId, nowSeconds, OBJECT_COMPLETION, OBJECT_CHUNK };
