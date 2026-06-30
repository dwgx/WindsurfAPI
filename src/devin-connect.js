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

// Image (vision) support — GROUNDWORK, gated behind DEVIN_CONNECT_IMAGE_TAG.
//
// The `images` field lives NESTED inside each ChatMessage (unlike the Cascade
// path, which carries images at the request level as field #6). The ImageData
// sub-message shape is known and proven on the Cascade path
// ({ base64_data=1, mime_type=2 }), but the protobuf TAG NUMBER of the `images`
// field inside ChatMessage is NOT calibrated — the live capture was text-only
// and the prost binary embeds no descriptor (see memory:
// devin-connect-tools-vision-2026-06-30). So image emission is OFF unless the
// operator sets DEVIN_CONNECT_IMAGE_TAG=<n> after calibrating it against a
// vision-capable (paid) model — see scripts/devin-connect-image-calibrate.mjs.
// Free-tier swe-1.6 is not a vision model, so this can't be end-to-end verified
// here; the encoder is wired and unit-tested so it's ready the moment the tag
// is known.
export function getImageFieldTag(env = process.env) {
  const raw = String(env.DEVIN_CONNECT_IMAGE_TAG || '').trim();
  if (!raw) return 0; // unset → images disabled (current production behavior)
  const tag = Number.parseInt(raw, 10);
  return Number.isInteger(tag) && tag > 0 && tag < 536870912 ? tag : 0;
}

/**
 * Pull data-URL / base64 image blocks out of OpenAI-style message content,
 * yielding the same { base64_data, mime_type } shape the Cascade ImageData
 * encoder consumes. Synchronous: only inline data-URL / base64 sources are
 * handled here (remote https image URLs would need an async fetch and are out
 * of scope for the wire builder — extract those upstream if needed).
 */
export function extractInlineImages(content) {
  if (!Array.isArray(content)) return [];
  const images = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'image') {
      const src = block.source || {};
      const mime = String(src.media_type || '').toLowerCase();
      // PDFs are text-extracted upstream, not sent as images.
      if (mime === 'application/pdf') continue;
      if ((src.type === 'base64' || !src.type) && src.data) {
        images.push({ base64_data: src.data, mime_type: src.media_type || 'image/png' });
      }
    } else if (block.type === 'image_url') {
      const url = block.image_url?.url || '';
      const m = url.replace(/\s/g, '').match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
      if (m) images.push({ base64_data: m[2], mime_type: m[1].toLowerCase() });
    }
  }
  return images;
}

/** Encode one ImageData sub-message: { base64_data=1, mime_type=2 } (Cascade-proven). */
function encodeImageData(img) {
  return Buffer.concat([
    writeStringField(1, img.base64_data),
    writeStringField(2, img.mime_type || 'image/png'),
  ]);
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
  const imageTag = getImageFieldTag();
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
    const fields = [
      writeStringField(1, randomUUID()),
      writeVarintField(2, source),
      writeStringField(3, text),
    ];
    // Vision (gated): append repeated ImageData under the calibrated tag. When
    // DEVIN_CONNECT_IMAGE_TAG is unset, imageTag is 0 and nothing is emitted —
    // identical to the prior text-only behavior.
    if (imageTag) {
      for (const img of extractInlineImages(msg.content)) {
        fields.push(writeMessageField(imageTag, encodeImageData(img)));
      }
    }
    chatMessages.push(Buffer.concat(fields));
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

/**
 * Classify an upstream error body/code into a stable, caller-mappable shape.
 * Cases that matter for routing decisions in chat.js:
 *   - a free-tier account asking for a paid selector → "/upgrade to access..."
 *     surfaces as MODEL_BLOCKED so the handler returns 402 and does NOT penalize
 *     the account (it's a tier wall, the account itself is healthy).
 *   - a PAID account that has run out of credit/quota → QUOTA_EXHAUSTED. This is
 *     account-specific and must be cooled down (otherwise getApiKey keeps
 *     re-selecting a dry account that 402s every client). Distinct from the tier
 *     wall above, which would wrongly demote a healthy free account.
 *   - auth failures (permission_denied / 401) → UNAUTHORIZED.
 * Everything else keeps its upstream code (or UPSTREAM_ERROR).
 *
 * @param {string} text   raw body or trailer message
 * @param {string|null} code  upstream code if already known
 * @param {number|null} status  HTTP status if a non-200 was seen
 * @returns {{code: string, message: string}}
 */
export function classifyUpstreamError(text, code = null, status = null) {
  const body = String(text || '').trim();
  // Out-of-credit/quota is an ACCOUNT state (cool it down), checked before the
  // tier-wall pattern so "insufficient credit" never reads as a free-tier
  // /upgrade prompt. "entitlement" stays a tier wall (you lack the plan, not
  // the balance), matching the /upgrade semantics.
  if (/insufficient.*(credit|quota|balance|funds)|out of (credit|quota)|quota.*exceeded|credit.*exhausted/i.test(body)) {
    return { code: 'QUOTA_EXHAUSTED', message: body || 'DEVIN_CONNECT: account out of credit/quota' };
  }
  if (/\/upgrade|upgrade to access|insufficient.*entitlement|requires? .*(paid|pro|team|enterprise)/i.test(body)) {
    return { code: 'MODEL_BLOCKED', message: body || 'model requires a paid Devin entitlement' };
  }
  if (status === 401 || status === 403 || /permission_denied|unauthenticated|invalid.*token/i.test(body) || code === 'permission_denied') {
    return { code: 'UNAUTHORIZED', message: body || 'DEVIN_CONNECT: authentication failed' };
  }
  if (status === 429 || /rate.?limit|too many requests|resource_exhausted/i.test(body) || code === 'resource_exhausted') {
    return { code: 'RATE_LIMITED', message: body || 'DEVIN_CONNECT: rate limited' };
  }
  return { code: code || 'UPSTREAM_ERROR', message: body || `DEVIN_CONNECT upstream error${status ? ` (HTTP ${status})` : ''}` };
}

// Transient codes worth an in-process retry: network blips + server "unavailable"
// only. Deliberately EXCLUDES:
//   - RATE_LIMITED: retrying the same token 2x before the pool-level cooldown
//     applies just triples the load on an already-throttled upstream. Let the
//     cooldown + cross-account failover handle it.
//   - internal: per this file's header the server returns `internal` for
//     PERMANENT client mistakes (short fingerprint, gzipped request body) — those
//     fail identically every retry, so retrying burns attempts for nothing.
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'TIMEOUT', 'unavailable']);

/** True when an error should be retried (vs surfaced immediately). */
export function isRetryable(err) {
  if (!err) return false;
  if (err.code && RETRYABLE_CODES.has(err.code)) return true;
  // HTTP 5xx (except 501) are transient; 4xx are not.
  if (typeof err.status === 'number') return err.status >= 500 && err.status !== 501;
  return false;
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
    // Non-200: the body is an error payload (JSON/text), NOT connect frames.
    // Buffer it and classify, so callers get a stable code (MODEL_BLOCKED for
    // free-tier /upgrade, UNAUTHORIZED, RATE_LIMITED) instead of an opaque
    // frame-parse failure from feeding an error body to StreamingFrameParser.
    if (res.statusCode && res.statusCode !== 200) {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const { code, message } = classifyUpstreamError(body, null, res.statusCode);
        streamError = Object.assign(new Error(message), { code, status: res.statusCode });
        done = true;
        pump();
      });
      res.on('error', (err) => { streamError = err; done = true; pump(); });
      return;
    }
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
                const { code, message } = classifyUpstreamError(
                  parsed.error.message || text, parsed.error.code || null, null);
                streamError = Object.assign(new Error(message), { code, upstream: parsed.error });
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

/**
 * Non-stream completion with bounded retry on transient failures. Safe to retry
 * because chat() buffers the whole answer — a mid-stream blip discards a partial
 * buffer and starts clean (no duplicated tokens). Non-retryable errors
 * (MODEL_BLOCKED, UNAUTHORIZED) throw immediately so the caller can map them.
 *
 * @param {object} params  see streamChat
 * @param {number} [params.maxRetries=2]
 * @param {number} [params.retryBaseMs=400]
 */
export async function chatWithRetry(params = {}) {
  const { maxRetries = 2, retryBaseMs = 400 } = params;
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await chat(params);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxRetries) throw err;
      const backoff = retryBaseMs * 2 ** attempt;
      log.warn(`DEVIN_CONNECT: retryable error (${err.code || err.message}); retry ${attempt + 1}/${maxRetries} in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

export const __testing = {
  buildClientMetadata, buildCompletionConfig, generateFingerprint,
  messageText, f64le, SOURCE, encodeImageData,
};
