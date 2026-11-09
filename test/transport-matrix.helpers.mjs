/**
 * Fixtures, scripted upstream, SSE parsing and metric helpers for
 * `test/transport-matrix.test.js`.
 *
 * The fake upstream is the repo's existing `__setConnectDeps` seam (the same
 * wiring `test/startserver-harness-shapes.test.js` uses; `test/helpers/
 * smoke-matrix-upstream.mjs` documents the "module seams, not a fake listener"
 * rationale): the real `startServer` HTTP router, the real OpenAI / Anthropic /
 * Responses / Gemini translators, and ZERO outbound sockets.
 *
 * `createScriptedUpstream()` returns a `deps` object that can be passed
 * straight to `__setConnectDeps`, plus the observable state the matrix asserts
 * against (last params per lane, images the router forwarded, call count).
 */

/** A model id the connect router accepts in this repo's model table. */
export const TRANSPORT_MODEL = 'claude-haiku-5-5-low';

/**
 * Synthetic credentials. Distinctive on purpose: the suite scans every
 * response body for these exact strings, so an error path that echoes the
 * client key or the env token fails the run.
 */
export const TRANSPORT_SECRETS = Object.freeze([
  { label: 'client api key', value: 'sk-fixture-transport-matrix-client-8f3c2a7e' },
  { label: 'connect env token', value: 'transport-matrix-connect-token-4b7d9e1c' },
]);

/** 1x1 PNG; small enough to keep bodies readable, real enough to decode. */
export const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export const PNG_DATA_URL = `data:image/png;base64,${PNG_1PX}`;

const CHAT_ID = 'chatcmpl-transport-matrix';
const CREATED = 1_700_000_000;
const USAGE = Object.freeze({ prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 });

/** The tool call every tool-call flow must round-trip verbatim. */
export const TOOL_CALL = Object.freeze({
  id: 'call_transport_1',
  name: 'get_weather',
  arguments: '{"city":"Tokyo","unit":"c"}',
});

function chunk(delta, finishReason = null) {
  return {
    id: CHAT_ID,
    object: 'chat.completion.chunk',
    created: CREATED,
    model: TRANSPORT_MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function completion(message, finishReason = 'stop') {
  return {
    status: 200,
    body: {
      id: CHAT_ID,
      object: 'chat.completion',
      created: CREATED,
      model: TRANSPORT_MODEL,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: USAGE,
    },
  };
}

function collectImageUrls(params) {
  const urls = [];
  for (const message of params?.messages || []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (typeof part?.image_url?.url === 'string') urls.push(part.image_url.url);
    }
  }
  return urls;
}

function lastUserText(params) {
  const messages = Array.isArray(params?.messages) ? params.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => (typeof part === 'string' ? part : part?.text || ''))
        .join('');
    }
  }
  return '';
}

/**
 * Scripted upstream for the four API families.
 *
 * `state.scenario` selects the next response: `text` (default), `tool`, or
 * `image` (identical to text, but the matrix asserts the image part survived
 * the translator). Scenarios are set by the test immediately before a call;
 * node:test runs the file's tests sequentially, matching the pattern the
 * existing startserver suite uses.
 */
export function createScriptedUpstream() {
  const state = {
    scenario: 'text',
    lastParams: null,
    lastStreamParams: null,
    calls: [],
    imageUrls: [],
  };

  function observe(kind, params) {
    state.lastParams = params;
    if (kind === 'stream') state.lastStreamParams = params;
    const images = collectImageUrls(params);
    state.imageUrls.push(...images);
    state.calls.push({ kind, params, imageUrls: images, text: lastUserText(params) });
  }

  const deps = {
    async toChatCompletion(params) {
      observe('nonstream', params);
      if (state.scenario === 'tool') {
        return completion({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: TOOL_CALL.id,
            type: 'function',
            function: { name: TOOL_CALL.name, arguments: TOOL_CALL.arguments },
          }],
        }, 'tool_calls');
      }
      return completion({ role: 'assistant', content: 'PONG' });
    },

    async streamChatCompletion(params, send) {
      observe('stream', params);
      if (state.scenario === 'tool') {
        // Split BOTH the function name and the argument JSON across deltas so
        // the protocol translators have to reassemble them, not copy one blob.
        await send(chunk({ role: 'assistant', content: '' }));
        await send(chunk({ tool_calls: [{ index: 0, id: TOOL_CALL.id, type: 'function', function: { name: 'get_', arguments: '{"city":"Tokyo",' } }] }));
        await send(chunk({ tool_calls: [{ index: 0, function: { name: 'weather', arguments: '"unit":"c"}' } }] }));
        await send(chunk({}, 'tool_calls'));
        return {
          content: '',
          reasoning: '',
          toolCalls: [{ id: TOOL_CALL.id, name: TOOL_CALL.name, arguments: TOOL_CALL.arguments }],
          finish_reason: 'tool_calls',
          usage: USAGE,
        };
      }
      // Text is split into three deltas; the matrix asserts the reassembled
      // answer equals 'PONG' exactly once (no duplicated or dropped frames).
      await send(chunk({ role: 'assistant', content: 'PO' }));
      await send(chunk({ content: 'N' }));
      await send(chunk({ content: 'G' }));
      await send(chunk({}, 'stop'));
      return {
        content: 'PONG',
        reasoning: '',
        toolCalls: [],
        finish_reason: 'stop',
        usage: USAGE,
      };
    },
  };

  return { state, deps };
}

/** Split an SSE body into `{event, data, raw}` frames. */
export function sseFrames(body) {
  return String(body)
    .split(/\r?\n\r?\n/)
    .filter((frame) => frame.trim())
    .map((frame) => {
      const lines = frame.split(/\r?\n/);
      const eventLine = lines.find((line) => /^event:/.test(line));
      const dataLines = lines.filter((line) => /^data:/.test(line));
      return {
        event: eventLine ? eventLine.replace(/^event:\s?/, '') : null,
        data: dataLines.length ? dataLines.map((line) => line.replace(/^data:\s?/, '')).join('\n') : null,
        raw: frame,
      };
    });
}

/** SSE frames whose data is JSON (everything except the OpenAI `[DONE]` sentinel). */
export function jsonFrames(body) {
  return sseFrames(body)
    .filter((frame) => frame.data != null && frame.data.trim() !== '[DONE]')
    .map((frame) => ({ ...frame, json: JSON.parse(frame.data) }));
}

/** Nearest-rank percentile; documented here because n is small (3–5 reps). */
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summarize(values) {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

export function byteLength(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

/** Fixed-width table; empty rows still print the header. */
export function formatTable(rows, columns) {
  const cells = rows.map((row) => columns.map((column) => String(row[column.key] ?? '')));
  const widths = columns.map((column, index) => Math.max(
    column.label.length,
    ...cells.map((row) => row[index].length),
  ));
  const line = (values) => values.map((value, index) => value.padEnd(widths[index])).join('  ').trimEnd();
  return [
    line(columns.map((column) => column.label)),
    line(widths.map((width) => '-'.repeat(width))),
    ...cells.map(line),
  ].join('\n');
}
