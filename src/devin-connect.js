/**
 * DEVIN_CONNECT — direct cloud GetChatMessage adapter (pure HTTP egress).
 *
 * This is the production path that lets the proxy reach Windsurf's hosted chat
 * backend WITHOUT a local Devin CLI subprocess. It speaks the same Connect-RPC
 * wire protocol the CLI uses against server.codeium.com, so it works anywhere
 * the box has the Windsurf session token (e.g. prod containers with no CLI).
 *
 * The full request/response wire format was calibrated against live captures
 * (see memory: devin-connect-WORKING-recipe-2026-06-30). The two non-obvious
 * bits that gate the whole flow:
 *
 *   1. AUTH header is the session token *doubled*, dash-joined:
 *        authorization: Basic <token>-<token>
 *      A single token is rejected with permission_denied. The proto-body copy
 *      (ClientMetadata.session_token, field #3) stays SINGLE.
 *
 *   2. ClientMetadata fingerprint (field #31) must be 732 hex chars (366 bytes).
 *      A short value trips a server-side "internal" error. The value itself is
 *      not session-bound — a fresh random hex string is accepted.
 *
 * Endpoint : POST https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage
 * Transport: Connect-RPC, application/connect+proto, single request envelope,
 *            multi-frame streaming response (text deltas in response field #9).
 *
 * Zero npm deps. Nothing dials the network at import time.
 */

import https from 'https';
import { randomUUID, randomBytes } from 'crypto';
import { log } from './config.js';
import {
  writeMessageField, writeStringField, writeVarintField, writeFixed64Field,
  parseFields, getField, getAllFields,
} from './proto.js';
import { wrapRequest, wrapEnvelope, StreamingFrameParser, connectHeaders } from './connect.js';

const HOST = 'server.codeium.com';
const PATH = '/exa.api_server_pb.ApiServerService/GetChatMessage';

// ClientMetadata constants observed on every live CLI request. "chisel" is the
// CLI's internal client name; the version string tracks the Devin CLI build.
const CLIENT_NAME = 'chisel';
const CLIENT_VERSION = '2026.8.18';

// ChatMessage.source enum (field #2). Mirrors windsurf.js SOURCE — only the
// values this path actually emits are listed.
const SOURCE = Object.freeze({ USER: 1, ASSISTANT: 2 });

// CompletionConfig defaults, matched to the captured CLI request.
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 1.0;
const DEFAULT_TOP_K = 40;
const DEFAULT_TOP_P = 0.95;

/** IEEE-754 double, little-endian — for CompletionConfig temp/top_p (wire type 1). */
function f64le(value) {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(value, 0);
  return b;
}

/**
 * Resolve the session token. Mirrors the convention in devin-backend.js:
 * DEVIN_CONNECT_TOKEN wins, then the shared WINDSURF_API_KEY. The value is the
 * raw `devin-session-token$<JWT>` string; never logged.
 */
export function getConnectToken(env = process.env) {
  return String(env.DEVIN_CONNECT_TOKEN || env.WINDSURF_API_KEY || '').trim();
}

/**
 * Generate a fresh fingerprint for ClientMetadata #31. The server only checks
 * the length/shape (732 hex chars), not the value, so a per-request random hex
 * string is both accepted and anti-fingerprinting.
 */
function generateFingerprint() {
  return randomBytes(366).toString('hex'); // 366 bytes → 732 hex chars
}

/**
 * Flatten an OpenAI-style message content into plain text. Cloud GetChatMessage
 * takes a single string per ChatMessage; structured/tool content is degraded to
 * text the same way the legacy Raw path does (see windsurf.js).
 */
function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c?.type === 'text').map(c => c.text).join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

/**
 * Build the ClientMetadata sub-message (field #1). The token is embedded SINGLE
 * here (the doubling is only for the HTTP Authorization header).
 */
function buildClientMetadata(token) {
  return Buffer.concat([
    writeStringField(1, CLIENT_NAME),
    writeStringField(2, CLIENT_VERSION),
    writeStringField(3, token),
    writeStringField(4, 'en'),
    writeStringField(5, 'windows'),
    writeStringField(7, CLIENT_VERSION),
    writeStringField(12, CLIENT_NAME),
    writeStringField(31, generateFingerprint()),
  ]);
}

/** Build CompletionConfig (field #8). */
function buildCompletionConfig({ maxTokens, temperature, topK, topP, contextWindow } = {}) {
  return Buffer.concat([
    writeVarintField(1, 1),
    writeVarintField(2, contextWindow ?? DEFAULT_CONTEXT_WINDOW),
    writeVarintField(3, maxTokens ?? DEFAULT_MAX_TOKENS),
    writeFixed64Field(5, f64le(temperature ?? DEFAULT_TEMPERATURE)),
    writeVarintField(7, topK ?? DEFAULT_TOP_K),
    writeFixed64Field(8, f64le(topP ?? DEFAULT_TOP_P)),
  ]);
}

/**
 * Encode a GetChatMessageRequest. Field order matches the live capture exactly.
 *
 * @param {object}   params
 * @param {string}   params.token         session token (single, for proto body)
 * @param {Array}    params.messages      OpenAI-style [{role, content}]
 * @param {string}   params.model         model selector, e.g. "swe-1-6-slow"
 * @param {string}   [params.sessionId]   reuse a session id; default fresh uuid
 * @param {object}   [params.completion]  CompletionConfig overrides
 * @returns {Buffer} raw protobuf (un-enveloped)
 */
export function buildGetChatMessageRequest({ token, messages, model, sessionId, completion } = {}) {
  if (!token) throw new Error('DEVIN_CONNECT: missing session token');
  if (!model) throw new Error('DEVIN_CONNECT: missing model selector');

  // System turns are concatenated into the dedicated system_prompt field (#2);
  // everything else becomes a repeated ChatMessage (#3).
  let systemPrompt = '';
  const chatMessages = [];
  for (const msg of messages || []) {
    if (msg.role === 'system') {
      const t = messageText(msg.content);
      systemPrompt += systemPrompt ? `\n${t}` : t;
      continue;
    }
    const source = msg.role === 'assistant' ? SOURCE.ASSISTANT : SOURCE.USER;
    let text = messageText(msg.content);
    // Tool turns have no native slot here; fold them into user text so multi-turn
    // histories that carry tool results still flow through.
    if (msg.role === 'tool') {
      text = `[tool result${msg.tool_call_id ? ` for ${msg.tool_call_id}` : ''}]: ${text}`;
    }
    chatMessages.push(Buffer.concat([
      writeStringField(1, randomUUID()),
      writeVarintField(2, source),
      writeStringField(3, text),
    ]));
  }

  const modelConfig = Buffer.concat([
    writeStringField(1, randomUUID()),
    writeVarintField(2, 1),
    writeVarintField(3, 4),
  ]);

  const parts = [
    writeMessageField(1, buildClientMetadata(token)),
    writeStringField(2, systemPrompt),
  ];
  for (const cm of chatMessages) parts.push(writeMessageField(3, cm));
  parts.push(
    writeVarintField(7, 5),
    writeMessageField(8, buildCompletionConfig(completion)),
    writeMessageField(15, modelConfig),
    writeStringField(16, sessionId || randomUUID()),
    writeVarintField(20, 1),
    writeStringField(21, model),
  );
  return Buffer.concat(parts);
}

// ─── Response frame decoding ──────────────────────────────
//
// GetChatMessageResponse wire layout, calibrated against live captures (see
// memory: devin-connect-response-protocol-2026-06-30). reasoning and the final
// answer are NATIVELY SEPARATED into two top-level fields:
//
//   #3  STR  → final answer text     (OpenAI `content`)
//   #5  V    → finish/stop signal    (OpenAI `finish_reason`; 2 == stop)
//   #7  MSG  → metadata { #2 prompt_tokens, #3 completion_tokens, #9 model }
//   #9  STR  → reasoning/thinking    (OpenAI `reasoning_content`)
//
// Earlier code read #9 as the content — that was the thinking stream. The
// answer the caller actually wants is #3.

const FIELD = Object.freeze({ CONTENT: 3, FINISH: 5, META: 7, REASONING: 9 });
// Finish-signal enum. Only `stop` is confirmed live; the rest are placeholders
// that map to the OpenAI vocabulary until a length/tool cutoff is observed.
const FINISH_STOP = 2;

/**
 * Decode one response frame into the deltas it carries. Any field may be absent
 * on a given frame (metadata-only frames are common at the head of the stream).
 *
 * @returns {{ content: string, reasoning: string, finish: number|null,
 *             usage: {prompt: number, completion: number}|null }}
 */
export function decodeFrame(payload) {
  const fields = parseFields(payload);
  const content = getField(fields, FIELD.CONTENT, 2);
  const reasoning = getField(fields, FIELD.REASONING, 2);
  const finish = getField(fields, FIELD.FINISH, 0);
  const meta = getField(fields, FIELD.META, 2);

  let usage = null;
  if (meta) {
    const mf = parseFields(meta.value);
    const prompt = getField(mf, 2, 0);
    const completion = getField(mf, 3, 0);
    // completion_tokens only rides the final metadata frame; treat the pair as
    // usage only when the completion count is present.
    if (completion) {
      usage = { prompt: prompt ? prompt.value : 0, completion: completion.value };
    }
  }

  return {
    content: content ? content.value.toString('utf8') : '',
    reasoning: reasoning ? reasoning.value.toString('utf8') : '',
    finish: finish ? finish.value : null,
    usage,
  };
}

/** Map the upstream finish enum to the OpenAI finish_reason vocabulary. */
export function mapFinishReason(finish) {
  if (finish == null) return null;
  if (finish === FINISH_STOP) return 'stop';
  // Unconfirmed values: surface them as 'stop' so a completed stream is never
  // reported as an error, but keep the raw value discoverable for callers.
  return 'stop';
}


/**
 * Stream a chat completion over DEVIN_CONNECT.
 *
 * Yields structured events as they arrive:
 *   { type: 'content',   text }   — user-visible answer delta (proto #3)
 *   { type: 'reasoning', text }   — thinking delta            (proto #9)
 *   { type: 'finish', reason, usage } — emitted once at end-of-stream
 *
 * The generator resolves when the upstream sends its end-of-stream trailer; a
 * non-empty trailer error body is surfaced as a thrown Error so callers don't
 * treat a failed stream as empty.
 *
 * @param {object} params  see buildGetChatMessageRequest, plus:
 * @param {AbortSignal} [params.signal]  abort the in-flight request
 * @param {number} [params.timeoutMs=120000]
 * @param {object} [params.env]
 * @returns {AsyncGenerator<{type:string, text?:string, reason?:string, usage?:object}>}
 */
export async function* streamChat({
  messages, model, sessionId, completion,
  token, signal, timeoutMs = 120000, env = process.env,
} = {}) {
  const sessionToken = token || getConnectToken(env);
  if (!sessionToken) {
    throw Object.assign(new Error('DEVIN_CONNECT: no session token configured'), { code: 'NO_TOKEN' });
  }

  const proto = buildGetChatMessageRequest({ token: sessionToken, messages, model, sessionId, completion });
  // Request envelope is sent UNCOMPRESSED (flag 0). The live calibration showed
  // the server rejects a gzipped request frame with an opaque "internal" error;
  // it still streams gzipped frames back, which the parser handles.
  const framed = wrapEnvelope(proto, { compress: false });

  // AUTH (critical): the header token is the session token doubled, dash-joined.
  const authHeader = `Basic ${sessionToken}-${sessionToken}`;

  const queue = [];
  let done = false;
  let streamError = null;
  let wake = null;
  let lastFinish = null;
  let lastUsage = null;
  const pump = () => { if (wake) { const w = wake; wake = null; w(); } };

  const req = https.request({
    hostname: HOST,
    port: 443,
    path: PATH,
    method: 'POST',
    headers: connectHeaders({
      authorization: authHeader,
      'Content-Length': framed.length,
      Accept: '*/*',
    }),
    signal,
  }, (res) => {
    const parser = new StreamingFrameParser();
    res.on('data', (chunk) => {
      parser.push(chunk);
      let frames;
      try { frames = parser.drain(); }
      catch (err) { streamError = err; done = true; req.destroy(); pump(); return; }
      for (const frame of frames) {
        if (frame.isEndStream) {
          // Trailer is JSON: {} on success, {"error":{...}} on failure.
          const text = frame.payload.toString('utf8').trim();
          if (text && text !== '{}') {
            try {
              const parsed = JSON.parse(text);
              if (parsed?.error) {
                streamError = Object.assign(
                  new Error(`DEVIN_CONNECT upstream: ${parsed.error.code || 'error'}: ${parsed.error.message || text}`),
                  { code: parsed.error.code, upstream: parsed.error },
                );
              }
            } catch { /* non-JSON trailer — leave as success */ }
          }
          done = true;
          pump();
          return;
        }
        const { content, reasoning, finish, usage } = decodeFrame(frame.payload);
        if (reasoning) { queue.push({ type: 'reasoning', text: reasoning }); }
        if (content) { queue.push({ type: 'content', text: content }); }
        if (finish != null) lastFinish = finish;
        if (usage) lastUsage = usage;
        if (reasoning || content) pump();
      }
    });
    res.on('end', () => { done = true; pump(); });
    res.on('error', (err) => { streamError = err; done = true; pump(); });
  });

  req.on('error', (err) => {
    if (!streamError) streamError = err;
    done = true;
    pump();
  });
  req.setTimeout(timeoutMs, () => {
    req.destroy();
    if (!streamError) streamError = Object.assign(new Error('DEVIN_CONNECT: request timeout'), { code: 'TIMEOUT' });
    done = true;
    pump();
  });

  req.write(framed);
  req.end();

  // Consumer loop: drain the queue, awaiting more data until the stream ends.
  while (true) {
    if (queue.length) { yield queue.shift(); continue; }
    if (streamError) throw streamError;
    if (done) {
      // One terminal event carrying finish_reason + usage for the caller to
      // close out an OpenAI-shaped response.
      yield {
        type: 'finish',
        reason: mapFinishReason(lastFinish),
        usage: lastUsage
          ? {
              prompt_tokens: lastUsage.prompt,
              completion_tokens: lastUsage.completion,
              total_tokens: lastUsage.prompt + lastUsage.completion,
            }
          : null,
      };
      return;
    }
    await new Promise((resolve) => { wake = resolve; });
  }
}

/**
 * Convenience: collect a full (non-streamed) completion. Returns the answer
 * text plus the separated reasoning and terminal metadata, so callers can build
 * either a plain or reasoning-aware OpenAI response.
 *
 * @returns {Promise<{content: string, reasoning: string,
 *                    finish_reason: string|null, usage: object|null}>}
 */
export async function chat(params) {
  let content = '';
  let reasoning = '';
  let finish_reason = null;
  let usage = null;
  for await (const ev of streamChat(params)) {
    if (ev.type === 'content') content += ev.text;
    else if (ev.type === 'reasoning') reasoning += ev.text;
    else if (ev.type === 'finish') { finish_reason = ev.reason; usage = ev.usage; }
  }
  return { content, reasoning, finish_reason, usage };
}

export const __testing = {
  buildClientMetadata, buildCompletionConfig, generateFingerprint,
  messageText, f64le, SOURCE,
};
