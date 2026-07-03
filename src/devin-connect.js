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

// Transport seam: defaults to https.request. Swappable in tests so the timeout
// / deadline logic can be exercised against a fake socket without a live call.
let requestImpl = https.request;
export function __setRequestImpl(fn) { requestImpl = fn || https.request; }

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
// Smallest temperature the upstream accepts; exactly 0 → server "internal error"
// (live-verified). Callers asking for 0 (greedy) get clamped to this instead.
const MIN_TEMPERATURE = 0.001;
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

// Native tool definitions — GROUNDWORK, gated behind DEVIN_CONNECT_TOOL_DEF_TAGS.
//
// The calibrated proto (get-chat-message-CALIBRATED.proto) VERIFIES the repeated
// `tools` field lives at GetChatMessageRequest #10 (req-6 carried ~24 ToolDefs).
// What is NOT calibrated is the SUBFIELD layout inside each ToolDef — the recon
// only saw "3 fields each (name/desc/schema-ish)" without confirmed tag numbers,
// because the prost binary embeds no descriptor and the capture didn't decode the
// inner message. So native tool defs are OFF by default: WindsurfAPI keeps folding
// tools into the prompt (tool-emulation), which works on every model.
//
// When an operator calibrates the inner tags against a paid capture, set e.g.
// DEVIN_CONNECT_TOOL_DEF_TAGS="10,1,2,3" (outer repeated tag, then name/desc/schema
// subfield tags). The encoder then emits real ToolDef sub-messages. Default unset
// → getToolDefTags() returns null → nothing emitted, identical to today.
export function getToolDefTags(env = process.env) {
  const raw = String(env.DEVIN_CONNECT_TOOL_DEF_TAGS || '').trim();
  if (!raw) return null; // unset → native tool defs disabled (prompt emulation stays)
  const nums = raw.split(',').map((s) => Number.parseInt(s.trim(), 10));
  if (nums.length !== 4 || nums.some((n) => !Number.isInteger(n) || n <= 0 || n >= 536870912)) {
    return null; // malformed → fail closed to emulation, never a broken frame
  }
  const [outer, name, description, schema] = nums;
  return { outer, name, description, schema };
}

/**
 * Encode one ToolDef sub-message from an OpenAI function-tool entry
 * ({ type:'function', function:{ name, description, parameters } }). The JSON
 * schema is serialized to a string for the schema subfield — the exact wire
 * representation (string vs nested message) is unconfirmed; string is the safe
 * first calibration target and matches how most prost tool schemas ride.
 */
function encodeToolDef(tool, tags) {
  const fn = tool?.function || {};
  const fields = [];
  if (fn.name) fields.push(writeStringField(tags.name, String(fn.name)));
  if (fn.description) fields.push(writeStringField(tags.description, String(fn.description)));
  if (fn.parameters !== undefined) {
    fields.push(writeStringField(tags.schema, JSON.stringify(fn.parameters)));
  }
  return Buffer.concat(fields);
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

/** Build CompletionConfig (field #8).
 *
 * Field→tag mapping is calibrated from a working live capture (this exact byte
 * layout produces correct completions). The recon (P5 §line60) confirms the
 * CompletionConfig field NAMES/arity (temperature, top_p, top_k, max_tokens = 4
 * fields) but NOT their tag numbers.
 *
 * KNOWN LIMIT (free-tier probe, 2026-06-30): varying `maxTokens` (#3 here) from
 * 16 to 1000 against `swe-1-6-slow` yields IDENTICAL output (256 completion
 * tokens, finish=stop) — i.e. #3 is NOT an enforced output cap on the free tier.
 * Either the free model ignores the cap or #3 is mis-tagged. We deliberately do
 * NOT re-tag it: the current layout demonstrably produces correct results, and a
 * blind tag change risks breaking a working request. Pin the real max_tokens tag
 * from a paid capture before relying on output-length limiting.
 */
function buildCompletionConfig({ maxTokens, temperature, topK, topP, contextWindow } = {}) {
  // LIVE FINDING (free-tier swe-1-6-slow, 2026-06-30): temperature=0 reliably
  // makes the upstream return "an internal error occurred" (3/3), while 0.001
  // succeeds. OpenAI/Anthropic clients routinely send temperature=0 for
  // deterministic output, so forwarding a raw 0 would turn every such call into
  // a hard upstream failure. Clamp to a tiny epsilon floor — as close to greedy
  // as the server accepts — instead of erroring. Only applies when the caller
  // explicitly asked for sub-epsilon; the default path is untouched.
  let temp = temperature ?? DEFAULT_TEMPERATURE;
  if (temp < MIN_TEMPERATURE) temp = MIN_TEMPERATURE;
  return Buffer.concat([
    writeVarintField(1, 1),
    writeVarintField(2, contextWindow ?? DEFAULT_CONTEXT_WINDOW),
    writeVarintField(3, maxTokens ?? DEFAULT_MAX_TOKENS),
    writeFixed64Field(5, f64le(temp)),
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
export function buildGetChatMessageRequest({ token, messages, model, sessionId, completion, tools } = {}) {
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
  // Native tool definitions (repeated #10) — only when the inner ToolDef tags are
  // calibrated (DEVIN_CONNECT_TOOL_DEF_TAGS). Default: tag map is null → nothing
  // emitted, tools keep flowing through prompt emulation upstream.
  const toolTags = getToolDefTags();
  if (toolTags && Array.isArray(tools)) {
    for (const tool of tools) {
      if (tool?.type !== 'function' || !tool.function?.name) continue;
      parts.push(writeMessageField(toolTags.outer, encodeToolDef(tool, toolTags)));
    }
  }
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
// The top-level #5 finish signal maps to the OpenAI finish_reason vocabulary in
// mapFinishReason() below (live-anchored 2→'stop', the rest calibratable).

// Billing passthrough (GROUNDWORK, opt-in via DEVIN_CONNECT_BILLING_TAGS).
//
// The static recon (P2-apiserver-methods-fields.md §2.4) verifies that the
// response carries `credit_cost`, `committed_credit_cost`, `committed_acu_cost`
// and `committed_overage_cost_cents` — but only as a FIELD DECLARATION ORDER,
// not wire tag numbers (prost allows gaps; declaration order ≠ tag). These
// fields could NOT be calibrated against a free account: a free tier isn't
// billed, the values are 0, and protobuf does not encode zero-valued scalars —
// so the fields are physically ABSENT from every free-account capture we have.
// This is the same shape as the vision image-tag (also un-calibratable on free).
//
// So billing decode is configuration-driven, default-OFF: until an operator
// runs the calibration on a PAID token and pins the real tags, nothing is
// parsed and usage carries no billing keys (zero regression). The env var maps
// logical billing keys to the integer tag observed in the metadata sub-message:
//
//   DEVIN_CONNECT_BILLING_TAGS="credit_cost=6,committed_credit_cost=7,committed_acu_cost=8"
//
// All tags are read from the #7 metadata sub-message as varints. A future paid
// calibration run (scripts/devin-connect-paid-verify.mjs style) discovers them.
function parseBillingTagMap(env = process.env) {
  const raw = String(env.DEVIN_CONNECT_BILLING_TAGS || '').trim();
  if (!raw) return null;
  const map = {};
  for (const pair of raw.split(',')) {
    const [key, tag] = pair.split('=').map((s) => s.trim());
    const n = Number.parseInt(tag, 10);
    // Only the known billing keys, only positive integer tags. Silently skip
    // garbage so a typo can't crash the hot decode path.
    if (key && Number.isInteger(n) && n > 0 &&
        ['credit_cost', 'committed_credit_cost', 'committed_acu_cost', 'committed_overage_cost_cents',
         // cache-token usage fields (ModelUsageStats.cache_read_tokens /
         // cache_write_tokens). Same un-calibratable-on-free situation; routed
         // into usage (not billing) by decodeFrame. Tags discovered via the
         // DEVIN_CONNECT_DEBUG_META dump on a paid/cached capture.
         'cache_read_tokens', 'cache_write_tokens'].includes(key)) {
      map[key] = n;
    }
  }
  return Object.keys(map).length ? map : null;
}

// Native tool-call DECODE (GROUNDWORK, opt-in via DEVIN_CONNECT_TOOL_CALL_TAGS).
//
// The response carries `delta_tool_calls` (repeated ChatToolCall). Per the
// reverse-engineering (NW1: .workflow-results/native-tool-wire/NATIVE-WIRE-FIELDS.md
// §1.2/§2, sourced from the devin.exe prost declaration string at
// strings-ascii.txt:249887) the ChatToolCall struct is, with [verified] FIELD NAMES:
//   ChatToolCall {
//     is_custom_tool_call  bool   (custom tool vs a built-in harness tool)
//     invalid_json_str     string (raw args the model emitted when they were NOT valid JSON)
//     arguments_json       string (the valid JSON args — OpenAI function.arguments)
//     id                   string (OpenAI tool_calls[].id)
//     invalid_json_err     string (parse-error description for invalid_json_str)
//   }
//
// ★ CRITICAL [verified]: the RESPONSE-side ChatToolCall has NO `name` field. The
// REQUEST-side ToolCall does, but the response item does not (NW1 §2 "最关键的实现锚点").
// A native decode therefore yields id + arguments but NOT the function name. We
// resolve name from, in priority order: (1) a pinned `name` tag IF a paid frame
// ever proves the release carries one in an unnamed subfield — CANDIDATE only,
// UNVERIFIED, NW1 §2 candidate #3; (2) caller-supplied reverse-lookup against the
// request-side tools (decodeFrame opts.toolNames), unambiguous when exactly one
// tool was offered. If neither resolves, name is left undefined and the OpenAI
// builder defaults it to 'unknown' (devin-connect-openai.js:127) — shape intact.
//
// As with billing/vision the FIELD NAMES are [verified] but every wire TAG is
// [unknown / UNVERIFIED]: a free capture never emits tool calls (the free models
// we can reach don't tool-call over this path), so the sub-message is physically
// absent and un-calibratable here. The tags are NOT guessed in code — they stay
// unset, and decode stays OFF, until a real PAID proto dump pins them. Default
// OFF → tool calls keep coming from prompt emulation (parseToolCallsFromText),
// which works everywhere and remains the only production path.
//
// Once a paid capture (DEVIN_CONNECT_DEBUG_META frame dump) reveals the tags, pin them
// (tag numbers below are placeholders for the doc only — DO NOT trust them):
//   DEVIN_CONNECT_TOOL_CALL_TAGS="outer=N,id=N,arguments_json=N,is_custom_tool_call=N,invalid_json_str=N,invalid_json_err=N"
// `outer` is the repeated delta_tool_calls tag on the top-level frame; the rest
// are subfields of each ChatToolCall. Missing keys are simply not read.
export function parseToolCallTagMap(env = process.env) {
  const raw = String(env.DEVIN_CONNECT_TOOL_CALL_TAGS || '').trim();
  if (!raw) return null;
  const map = {};
  // The [verified]-name subfields, plus `name` kept as a CANDIDATE key (response-side
  // ChatToolCall has no verified name field per NW1 §2; an operator may still pin it
  // if a paid dump proves the release carries one).
  const allowed = ['outer', 'id', 'name', 'arguments_json',
    'is_custom_tool_call', 'invalid_json_str', 'invalid_json_err'];
  for (const pair of raw.split(',')) {
    const [key, tag] = pair.split('=').map((s) => s.trim());
    const n = Number.parseInt(tag, 10);
    if (allowed.includes(key) && Number.isInteger(n) && n > 0 && n < 536870912) {
      map[key] = n;
    }
  }
  // `outer` is mandatory — without the repeated-field tag there's nothing to read.
  return map.outer ? map : null;
}

// Thinking-signature DECODE config (GROUNDWORK, opt-in). The response declares
// `delta_signature` (string, the encrypted-thinking payload increment),
// `delta_signature_type` (enum) and `thinking_id` (string) at the top level —
// names [verified] from recon, wire tags [unknown] (free tier never emits them).
// Default OFF: until a paid/thinking capture pins the tags, nothing is decoded
// and streamChat yields exactly as today (zero regression).
//
//   DEVIN_CONNECT_SIGNATURE_TAG=N           (the delta_signature tag; mandatory)
//   DEVIN_CONNECT_SIGNATURE_TYPE_TAG=N       (delta_signature_type; optional)
//   DEVIN_CONNECT_SIGNATURE_THINKING_ID_TAG=N (thinking_id; optional)
//
// `signature` is mandatory — without the delta_signature tag there is nothing to
// surface, so the whole map is null (decode stays off) when it's unset/garbage.
export function parseSignatureTagMap(env = process.env) {
  const sigTag = Number.parseInt(env.DEVIN_CONNECT_SIGNATURE_TAG || '', 10);
  if (!Number.isInteger(sigTag) || sigTag <= 0 || sigTag >= 536870912) return null;
  const map = { signature: sigTag };
  const typeTag = Number.parseInt(env.DEVIN_CONNECT_SIGNATURE_TYPE_TAG || '', 10);
  if (Number.isInteger(typeTag) && typeTag > 0 && typeTag < 536870912) map.type = typeTag;
  const tidTag = Number.parseInt(env.DEVIN_CONNECT_SIGNATURE_THINKING_ID_TAG || '', 10);
  if (Number.isInteger(tidTag) && tidTag > 0 && tidTag < 536870912) map.thinkingId = tidTag;
  return map;
}

/** A string is "valid JSON" iff JSON.parse accepts it. Used to decide whether the
 * upstream `arguments_json` can be trusted as-is or must fall back to a placeholder. */
function looksLikeValidJson(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  try { JSON.parse(s); return true; } catch { return false; }
}

/** Decode ONE ChatToolCall sub-message (already parsed into `sub` fields) into
 * { id?, name?, arguments?, isCustom?, invalidJson? }. `arguments` stays the raw
 * JSON STRING — the OpenAI builder passes it through to function.arguments.
 *
 * Fault tolerance mirrors the upstream control_loop.rs:2773 behavior NW1 §2 cites
 * ("Replacing malformed tool-call arguments with {} to prevent chain corruption"):
 *   - valid arguments_json                              → use it verbatim
 *   - arguments_json absent, invalid_json_str present   → emit {} placeholder,
 *                                                          preserve the original
 *                                                          + error as `invalidJson`
 *   - arguments_json present but unparseable, with an
 *     invalid_json signal                               → {} placeholder + invalidJson
 *   - arguments_json present but unparseable, NO signal → keep the raw string
 *                                                          (never silently drop data)
 *
 * NEVER throws: a malformed sub-message is a LOCAL parse problem, not an upstream
 * auth/transient signal. Returning a partial/empty result keeps the transient-first
 * motif intact — a decode miss can't be misread as UNAUTHORIZED and burn a token. */
function decodeOneToolCall(sub, tags) {
  const tc = {};
  if (tags.id) { const v = getField(sub, tags.id, 2); if (v) tc.id = v.value.toString('utf8'); }
  if (tags.is_custom_tool_call) {
    const v = getField(sub, tags.is_custom_tool_call, 0);
    if (v != null) tc.isCustom = Boolean(Number(v.value));
  }
  // name: a CANDIDATE native tag only (response-side ChatToolCall has no verified
  // name field — header note). When present, trust it; otherwise leave undefined for
  // the caller's reverse-lookup / 'unknown' default.
  if (tags.name) {
    const v = getField(sub, tags.name, 2);
    if (v) { const s = v.value.toString('utf8'); if (s) tc.name = s; }
  }

  const rawArgs = tags.arguments_json
    ? (getField(sub, tags.arguments_json, 2)?.value.toString('utf8') ?? null) : null;
  const invalidStr = tags.invalid_json_str
    ? (getField(sub, tags.invalid_json_str, 2)?.value.toString('utf8') ?? null) : null;
  const invalidErr = tags.invalid_json_err
    ? (getField(sub, tags.invalid_json_err, 2)?.value.toString('utf8') ?? null) : null;

  if (rawArgs != null && looksLikeValidJson(rawArgs)) {
    tc.arguments = rawArgs;
  } else if (rawArgs != null && (invalidStr != null || invalidErr != null)) {
    // Upstream args are malformed; downgrade to {} so the tool-call chain doesn't
    // corrupt, but keep the original + error around for debugging/passthrough.
    tc.arguments = '{}';
    tc.invalidJson = { str: invalidStr ?? rawArgs, err: invalidErr ?? null };
  } else if (rawArgs != null) {
    // Unparseable and no explicit invalid_json signal: never drop data — keep raw.
    tc.arguments = rawArgs;
  } else if (invalidStr != null || invalidErr != null) {
    // No arguments_json at all, only the malformed-args signal: {} placeholder.
    tc.arguments = '{}';
    tc.invalidJson = { str: invalidStr, err: invalidErr ?? null };
  }
  return tc;
}

/** Decode repeated ChatToolCall sub-messages from a frame, given calibrated tags
 * and an optional request-side tool list for name reverse-lookup.
 * Returns [{ id?, name?, arguments?, isCustom?, invalidJson? }] or [].
 *
 * @param {Array} fields    top-level parsed frame fields
 * @param {object} tags     calibrated tag map (parseToolCallTagMap)
 * @param {string[]} [toolNames]  request-side tool names, for the name fallback */
function decodeToolCalls(fields, tags, toolNames = null) {
  const out = [];
  // The single-tool reverse-lookup: if exactly one tool was offered this turn,
  // a response ChatToolCall (which carries no name) is unambiguously that tool.
  const soleName = (Array.isArray(toolNames) && toolNames.length === 1)
    ? toolNames[0] : null;
  for (const f of getAllFields(fields, tags.outer)) {
    if (f.wireType !== 2) continue;
    let sub;
    try { sub = parseFields(f.value); }
    catch { continue; } // malformed sub-message → skip this item, never throw
    const tc = decodeOneToolCall(sub, tags);
    // name fallback: native CANDIDATE tag (already set) → sole-tool reverse-lookup.
    if (!tc.name && soleName) tc.name = soleName;
    // Keep any item that carried real content (id / name / args / a malformed-args
    // signal). isCustom alone (a bare bool) isn't enough to count as a call.
    if (tc.id || tc.name || tc.arguments || tc.invalidJson) out.push(tc);
  }
  return out;
}

/**
 * Calibration-only: decode the INNER fields of a non-printable top-level
 * sub-message into `out[field] = { <innerTag>: {kind, preview} }`. This is how a
 * paid/tool/router capture reveals the structure of opaque trailers like the
 * recurring #28 (usage/billing/stop-metadata) that the flat frame dump can only
 * mark as "<msg Nb>". Read-only, best-effort: a sub-message that isn't valid
 * protobuf (e.g. a genuinely opaque encrypted blob) is skipped silently so the
 * calibration path can never throw on the hot stream. Mirrors the flat dump's
 * kind/preview contract: varint→number, printable len-delim→utf8 preview,
 * non-printable len-delim→"<msg Nb>", fixed32/64→hex preview.
 *
 * @param {{field:number,value:Buffer}} f  the top-level sub-message field
 * @param {Object<number,object>} into     accumulator keyed by top-level tag
 */
function decodeSubMessage(f, into) {
  let inner;
  try { inner = parseFields(f.value); }
  catch { return; } // not protobuf → leave as opaque (flat dump already noted presence)
  if (!inner.length) return;
  const bucket = {};
  for (const sf of inner) {
    if (sf.wireType === 0) bucket[sf.field] = { kind: 'varint', preview: Number(sf.value) };
    else if (sf.wireType === 2) {
      const s = sf.value.toString('utf8');
      if (/^[\x20-\x7e]*$/.test(s) && s.length) bucket[sf.field] = { kind: 'string', preview: s.slice(0, 48) };
      else bucket[sf.field] = { kind: 'message', preview: `<msg ${sf.value.length}b>` };
    } else if (sf.wireType === 5) bucket[sf.field] = { kind: 'fixed32', preview: sf.value.toString('hex') };
    else if (sf.wireType === 1) bucket[sf.field] = { kind: 'fixed64', preview: sf.value.toString('hex') };
  }
  if (Object.keys(bucket).length) into[f.field] = bucket;
}

/**
 * Decode one response frame into the deltas it carries. Any field may be absent
 * on a given frame (metadata-only frames are common at the head of the stream).
 *
 * @param {Buffer} payload
 * @param {object} [opts]
 * @param {object|null} [opts.billingTags]  logical-key → metadata tag number map
 *                                           (from parseBillingTagMap); null = off.
 * @param {object|null} [opts.toolCallTags]  ChatToolCall tag map (parseToolCallTagMap);
 *                                            null = off → native tool calls not decoded.
 * @param {string[]|null} [opts.toolNames]   request-side tool names, for the name
 *                                            reverse-lookup (response ChatToolCall has none).
 * @returns {{ content: string, reasoning: string, finish: number|null,
 *             usage: {prompt: number, completion: number}|null,
 *             billing: object|null }}
 */
export function decodeFrame(payload, opts = {}) {
  const fields = parseFields(payload);
  const content = getField(fields, FIELD.CONTENT, 2);
  const reasoning = getField(fields, FIELD.REASONING, 2);
  const finish = getField(fields, FIELD.FINISH, 0);
  const meta = getField(fields, FIELD.META, 2);

  // actual_model_uid: the concrete model that served the turn (differs from the
  // requested selector for router models — adaptive/arena-*). Tag unknown from
  // free-tier capture, so opt-in: pin DEVIN_CONNECT_ACTUAL_MODEL_TAG once a
  // dump (§8.5) reveals it. Off = null, no behavioral change.
  let actualModel = null;
  if (opts.actualModelTag) {
    const am = getField(fields, opts.actualModelTag, 2);
    if (am) {
      const s = am.value.toString('utf8');
      if (/^[\x20-\x7e]+$/.test(s)) actualModel = s; // printable selector only
    }
  }

  // Thinking signature (delta_signature / delta_signature_type / thinking_id):
  // top-level GetChatMessageResponse fields, the SAME layer as delta_thinking
  // (#9) — see NATIVE-WIRE-FIELDS §5. The reverse-engineering CONFIRMED the
  // field names [verified]; the earlier "upstream never produces a signature"
  // belief was wrong. But free swe-1.6 frames never carry them (free tier
  // produces no thinking signature), so the wire TAGS are [unknown] from every
  // capture we have. Opt-in via opts.signatureTags (default OFF → never decoded,
  // zero behavioral change). `delta_signature` is a declared string field — an
  // opaque encrypted payload the client only round-trips — so it is surfaced
  // verbatim as utf8 with NO printable filter (a base64 signature is preserved
  // byte-for-byte; mangling it would break the round-trip the upstream expects).
  let signature = null;
  if (opts.signatureTags && opts.signatureTags.signature) {
    const sig = getField(fields, opts.signatureTags.signature, 2);
    if (sig) {
      signature = { text: sig.value.toString('utf8') };
      // delta_signature_type: enum/int distinguishing anthropic vs gemini vs none.
      if (opts.signatureTags.type) {
        const t = getField(fields, opts.signatureTags.type, 0);
        if (t) signature.signatureType = Number(t.value);
      }
      // thinking_id: binds the signature to a specific thinking block (string).
      if (opts.signatureTags.thinkingId) {
        const ti = getField(fields, opts.signatureTags.thinkingId, 2);
        if (ti) {
          const s = ti.value.toString('utf8');
          if (/^[\x20-\x7e]+$/.test(s)) signature.thinkingId = s; // printable id only
        }
      }
    }
  }

  let usage = null;
  let billing = null;
  let metaDump = null;
  if (meta) {
    const mf = parseFields(meta.value);
    const prompt = getField(mf, 2, 0);
    const completion = getField(mf, 3, 0);
    // completion_tokens only rides the final metadata frame; treat the pair as
    // usage only when the completion count is present.
    if (completion) {
      usage = { prompt: prompt ? prompt.value : 0, completion: completion.value };
    }
    // Billing/usage passthrough: opt-in, only when an operator has pinned the
    // tags. Each is a varint; absent fields (free tier / un-billed / un-cached)
    // yield nothing. cache_*_tokens are usage stats → folded into `usage`; the
    // cost fields are billing → into `billing`.
    const billingTags = opts.billingTags;
    if (billingTags) {
      for (const [key, tag] of Object.entries(billingTags)) {
        const f = getField(mf, tag, 0);
        if (f == null) continue;
        if (key === 'cache_read_tokens' || key === 'cache_write_tokens') {
          (usage ||= { prompt: prompt ? prompt.value : 0, completion: completion ? completion.value : 0 })[key] = Number(f.value);
        } else {
          (billing ||= {})[key] = Number(f.value);
        }
      }
    }
    // Calibration hook (opt-in): expose EVERY varint subfield of the #7 metadata
    // sub-message as {tag: value}. This is how an operator discovers the unknown
    // tags for cache_read_tokens / cache_write_tokens / credit_cost etc. from a
    // real capture — the recon has the field NAMES (ModelUsageStats) but not the
    // integer tags. Off by default; pure read, no behavioral effect.
    if (opts.dumpMeta) {
      metaDump = {};
      for (const f of mf) {
        if (f.wireType === 0) metaDump[f.field] = Number(f.value);
      }
    }
  }

  const out = {
    content: content ? content.value.toString('utf8') : '',
    reasoning: reasoning ? reasoning.value.toString('utf8') : '',
    finish: finish ? finish.value : null,
    usage,
    billing,
  };
  if (actualModel) out.actualModel = actualModel;
  // Thinking signature (opt-in): surfaced only when DEVIN_CONNECT_SIGNATURE_TAG
  // is calibrated. Off → nothing added, the signature_delta passthrough in
  // messages.js keeps using its empty-string placeholder (forward-compatible).
  if (signature) out.signature = signature;
  // Native tool calls (opt-in): decode repeated ChatToolCall sub-messages when the
  // response-side tags are calibrated. Off → nothing added, prompt emulation owns
  // tool calls as today.
  if (opts.toolCallTags) {
    const calls = decodeToolCalls(fields, opts.toolCallTags, opts.toolNames);
    if (calls.length) out.toolCalls = calls;
  }
  if (metaDump) out.metaDump = metaDump;
  // Top-level frame calibration: when dumping, also surface every top-level
  // field so unknown tags like `actual_model_uid` (the concrete model that
  // served a router request) are discoverable. varints → numbers, short
  // length-delimited → utf8 preview; the rest noted by wire type.
  if (opts.dumpMeta) {
    const frameDump = {};
    const subDump = {};
    for (const f of fields) {
      if (f.wireType === 0) frameDump[f.field] = Number(f.value);
      else if (f.wireType === 2 && f.value.length <= 64) {
        const s = f.value.toString('utf8');
        if (/^[\x20-\x7e]+$/.test(s)) frameDump[f.field] = s; // printable preview only
        else { frameDump[f.field] = `<msg ${f.value.length}b>`; decodeSubMessage(f, subDump); } // non-printable sub-message → PRESENCE + inner decode
      } else if (f.wireType === 2) {
        // Oversized field: only mark presence if it's a binary sub-message, not a
        // long printable string (those stay out, per the dump's preview contract).
        const s = f.value.toString('utf8');
        if (!/^[\x20-\x7e]+$/.test(s)) { frameDump[f.field] = `<msg ${f.value.length}b>`; decodeSubMessage(f, subDump); }
      }
    }
    if (Object.keys(frameDump).length) out.frameDump = frameDump;
    // Inner fields of every non-printable top-level sub-message. This is what
    // turns the recurring #28 trailer (a 186b usage/billing/stop-metadata block
    // that the flat dump could only mark as "<msg 186b>") into DISCOVERABLE
    // {tag: {kind, preview}} — so `calibrate:devin` surfaces its guts in one run
    // instead of needing a hand-written probe. Opt-in (dumpMeta), additive, and
    // the flat frameDump above is unchanged → zero regression for existing
    // consumers (only the calibrate harness reads subDump).
    if (Object.keys(subDump).length) out.subDump = subDump;
  }
  return out;
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
  const lc = body.toLowerCase();

  // ── TRANSIENT-FIRST (the #56/#57 family) ─────────────────────────────────
  // The upstream wraps TRANSIENT faults (capacity, backend errors) inside a
  // 401/403 auth-shell. Every transient pattern MUST be matched BEFORE the
  // QUOTA / MODEL_BLOCKED / UNAUTHORIZED branches — otherwise a momentary blip
  // reads as a dead token or a permanent tier-wall, triggers a needless
  // re-login on a live token, and a second hit escalates to a permanent
  // MODEL_BLOCKED → a working free account is burned over a retryable hiccup.

  // The gRPC `internal` code is for PERMANENT client mistakes (short
  // fingerprint, gzipped request body) — fails identically every retry, so it
  // is NOT the transient backend fault below. Keep it non-retryable.
  if (code === 'internal') {
    return { code: 'UPSTREAM_ERROR', message: body || 'DEVIN_CONNECT: internal (client request rejected)' };
  }
  // Capacity / high-demand throttling. Observed live in a 401/403 shell:
  // "We're currently facing high demand for this model. Please try again later."
  // Widened to cover bare "service/backend/model unavailable" and "overloaded"
  // (audit F2) — the same delivery mode with a different upstream word.
  if (/high demand|try again later|currently (busy|overloaded|at capacity)|model is (busy|overloaded)|temporarily (busy|overloaded|unavailable)|server is busy|overloaded|(service|backend|model|server) (is )?(temporarily )?unavailable|capacity/i.test(lc)
      || code === 'unavailable') {
    return { code: 'CAPACITY', message: body || 'DEVIN_CONNECT: model temporarily at capacity' };
  }
  // "an internal error occurred (trace ID: ... / error ID: ...)" is a TRANSIENT
  // upstream BACKEND fault, NOT a dead session token — even in a 401/403 shell.
  // Observed live (free account <redacted>): GetUserStatus + liveness
  // both pass while completions return this 3/3 with fresh trace IDs. Distinct
  // from the gRPC `internal` code handled above.
  if (/internal error occurred/i.test(lc)) {
    return { code: 'UPSTREAM_INTERNAL', message: body || 'DEVIN_CONNECT: upstream internal error' };
  }

  // ── ACCOUNT-STATE / PERMANENT ────────────────────────────────────────────
  // Out-of-credit/quota is an ACCOUNT state (cool it down), checked before the
  // tier-wall pattern so "insufficient credit" never reads as a free-tier
  // /upgrade prompt. "entitlement" stays a tier wall (you lack the plan, not
  // the balance), matching the /upgrade semantics.
  if (/insufficient.*(credit|quota|balance|funds)|out of (credit|quota)|quota.*exceeded|credit.*exhausted/i.test(lc)) {
    return { code: 'QUOTA_EXHAUSTED', message: body || 'DEVIN_CONNECT: account out of credit/quota' };
  }
  if (/\/upgrade|upgrade to access|insufficient.*entitlement|requires? .*(paid|pro|team|enterprise)/i.test(lc)) {
    return { code: 'MODEL_BLOCKED', message: body || 'model requires a paid Devin entitlement' };
  }
  if (status === 401 || status === 403 || /permission_denied|unauthenticated|invalid.*token/i.test(lc) || code === 'permission_denied') {
    return { code: 'UNAUTHORIZED', message: body || 'DEVIN_CONNECT: authentication failed' };
  }
  if (status === 429 || /rate.?limit|too many requests|resource_exhausted/i.test(lc) || code === 'resource_exhausted') {
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
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'TIMEOUT', 'unavailable', 'CAPACITY']);

/** True when an error should be retried (vs surfaced immediately). */
export function isRetryable(err) {
  if (!err) return false;
  // UPSTREAM_INTERNAL is deliberately NON-retryable (observed persistent 3/3 —
  // same-token retry just amplifies load, #35). Short-circuit BEFORE the 5xx
  // status branch, which would otherwise re-admit it when the fault arrives as
  // a genuine 5xx rather than in a 401/403 shell (audit F4).
  if (err.code === 'UPSTREAM_INTERNAL') return false;
  if (err.code && RETRYABLE_CODES.has(err.code)) return true;
  // HTTP 5xx (except 501) are transient; 4xx are not.
  if (typeof err.status === 'number') return err.status >= 500 && err.status !== 501;
  return false;
}

/** Map the upstream finish enum to the OpenAI finish_reason vocabulary.
 *
 * The upstream `StopReason` enum's variant NAMES are known from the binary
 * (recon strings dump 208551): `end_turn, max_tokens, max_turn_requests,
 * refusal, cancelled` — Anthropic-style. But the integer→name mapping is only
 * partially calibrated: a normal free-tier completion was observed live as the
 * top-level #5 finish field == 2, which we anchor to OpenAI 'stop'. The enum's
 * zero value is almost certainly UNSPECIFIED (prost convention), so the named
 * variants start at 1; we can't pin each integer without a live capture of a
 * truncated / refused / tool-stopped turn.
 *
 * So the map is: the live-anchored 2→'stop' is fixed, a best-effort default for
 * the remaining values follows the Anthropic→OpenAI convention, and an operator
 * can override the whole table from a real capture via DEVIN_CONNECT_STOP_REASON_MAP
 * (e.g. "1=stop,2=stop,3=length,5=content_filter"). Unknown values fall back to
 * 'stop' so a completed stream is NEVER surfaced as an error.
 */
const STOP_REASON_DEFAULT = Object.freeze({
  // 0 = UNSPECIFIED (prost convention) → treat as a clean stop.
  0: 'stop',
  // 2 = LIVE-ANCHORED normal completion (free-tier observed). Do not change.
  2: 'stop',
  // Best-effort for the named variants (un-pinned integers): end_turn→stop,
  // max_tokens→length, max_turn_requests→length, refusal→content_filter,
  // cancelled→stop. These are guesses keyed off the variant NAME order and are
  // overridable; they only matter once a paid/edge capture pins the integers.
  1: 'stop',        // end_turn
  3: 'length',      // max_tokens (truncated)
  4: 'length',      // max_turn_requests
  5: 'content_filter', // refusal
  6: 'stop',        // cancelled
});

let _stopReasonMapCache = null;
let _stopReasonMapSrc = null;
function stopReasonMap(env = process.env) {
  const raw = String(env.DEVIN_CONNECT_STOP_REASON_MAP || '').trim();
  if (raw === _stopReasonMapSrc && _stopReasonMapCache) return _stopReasonMapCache;
  _stopReasonMapSrc = raw;
  const map = { ...STOP_REASON_DEFAULT };
  const allowed = new Set(['stop', 'length', 'tool_calls', 'content_filter']);
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split('=').map((s) => s.trim());
    const n = Number.parseInt(k, 10);
    if (Number.isInteger(n) && n >= 0 && allowed.has(v)) map[n] = v;
  }
  _stopReasonMapCache = map;
  return map;
}

export function mapFinishReason(finish, env = process.env) {
  if (finish == null) return null;
  const n = typeof finish === 'bigint' ? Number(finish) : finish;
  const map = stopReasonMap(env);
  // Unknown values → 'stop': a completed stream must never read as an error.
  return map[n] || 'stop';
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
 * @param {number} [params.timeoutMs]  socket IDLE timeout (no-activity); env
 *   DEVIN_CONNECT_IDLE_TIMEOUT_MS, default 120000.
 * @param {number} [params.deadlineMs]  ABSOLUTE wall-clock cap from request
 *   start; env DEVIN_CONNECT_TIMEOUT_MS, default 600000. Guards a hung-but-
 *   trickling upstream that the idle timer can never catch.
 * @param {object} [params.env]
 * @returns {AsyncGenerator<{type:string, text?:string, reason?:string, usage?:object}>}
 */
export async function* streamChat({
  messages, model, sessionId, completion, tools,
  token, signal, timeoutMs, deadlineMs, env = process.env,
} = {}) {
  // Idle timeout: socket inactivity. Absolute deadline: total wall-clock from
  // request start — this is the one that catches a stream that keeps dribbling
  // a byte at a time (defeating the idle timer) but never actually completes.
  const idleTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs : (Number(env.DEVIN_CONNECT_IDLE_TIMEOUT_MS) || 120000);
  const absoluteDeadlineMs = Number.isFinite(deadlineMs) && deadlineMs > 0
    ? deadlineMs : (Number(env.DEVIN_CONNECT_TIMEOUT_MS) || 600000);
  const sessionToken = token || getConnectToken(env);
  if (!sessionToken) {
    throw Object.assign(new Error('DEVIN_CONNECT: no session token configured'), { code: 'NO_TOKEN' });
  }
  // Billing tag map (opt-in, default null). Parsed once per request, off the
  // hot per-frame path.
  const billingTags = parseBillingTagMap(env);
  // Calibration: when set, dump every metadata varint subfield once per stream
  // (the terminal frame) so unknown tags (cache tokens / billing) are visible.
  const dumpMeta = env.DEVIN_CONNECT_DEBUG_META === '1';
  // Optional: surface actual_model_uid (concrete model behind a router) when the
  // operator has pinned its tag from a capture. Off → never decoded.
  const actualModelTag = Number.parseInt(env.DEVIN_CONNECT_ACTUAL_MODEL_TAG || '', 10) || null;
  // Optional: native tool-call decode (repeated ChatToolCall) when the response
  // tags are calibrated. Off → tool calls come from prompt emulation as today.
  const toolCallTags = parseToolCallTagMap(env);
  // Optional: thinking-signature decode (delta_signature/_type/thinking_id) when
  // DEVIN_CONNECT_SIGNATURE_TAG is pinned from a paid/thinking capture. Off →
  // never decoded, messages.js keeps its empty-string signature placeholder.
  const signatureTags = parseSignatureTagMap(env);
  // Request-side tool names, for the native-decode name fallback (response-side
  // ChatToolCall carries no name — see decodeToolCalls header). Only collected when
  // native decode is actually on, so it costs nothing on the default path. The
  // tools array is OpenAI-shaped ({type:'function', function:{name}}); fall back to
  // a bare {name} too.
  const toolNames = (toolCallTags && Array.isArray(tools))
    ? tools.map((t) => t?.function?.name || t?.name).filter(Boolean)
    : null;

  const proto = buildGetChatMessageRequest({ token: sessionToken, messages, model, sessionId, completion, tools });
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
  let lastBilling = null;
  let lastActualModel = null;
  let lastSignature = null;
  const nativeToolCalls = [];
  const pump = () => { if (wake) { const w = wake; wake = null; w(); } };

  const req = requestImpl({
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
        // Preserve the upstream Connect-RPC error code (audit F2): the trailer
        // path forwards parsed.error.code, but this non-200 path historically
        // dropped it (code=null), so an `unavailable`/`resource_exhausted`
        // delivered as a non-200 HTTP error lost the signal that classifies it
        // as transient. Best-effort JSON parse; falls back to body+status.
        let upstreamCode = null;
        try { upstreamCode = JSON.parse(body)?.error?.code || null; } catch { /* text body */ }
        const { code, message } = classifyUpstreamError(body, upstreamCode, res.statusCode);
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
        const { content, reasoning, finish, usage, billing, metaDump, frameDump, subDump, actualModel, toolCalls, signature } = decodeFrame(frame.payload, { billingTags, dumpMeta, actualModelTag, toolCallTags, signatureTags, toolNames });
        if (frameDump) log.info(`DEVIN_CONNECT frame dump (top-level tag=value): ${JSON.stringify(frameDump)}`);
        if (metaDump) log.info(`DEVIN_CONNECT meta dump (tag=value varints): ${JSON.stringify(metaDump)}`);
        if (subDump) log.info(`DEVIN_CONNECT sub-message dump (top-tag → inner tag=value): ${JSON.stringify(subDump)}`);
        // When dumping, also surface the raw dumps as a structured event so a
        // calibration consumer can aggregate tags without scraping logs. Pure
        // additive — only emitted under DEVIN_CONNECT_DEBUG_META.
        if (frameDump || metaDump || subDump) { queue.push({ type: 'frame-dump', frameDump: frameDump || null, metaDump: metaDump || null, subDump: subDump || null }); }
        if (actualModel) lastActualModel = actualModel;
        if (signature) {
          // delta_signature is an INCREMENT (like Anthropic signature_delta).
          // Accumulate the opaque payload for the terminal finish event AND emit
          // a per-frame delta so a streaming consumer can attach it to the open
          // thinking block. Field name `reasoning_signature` aligns with what
          // messages.js round-trips (handlers/messages.js:658). Additive event
          // type → current consumers (which switch on reasoning/content/finish)
          // ignore it; zero regression when the tag is uncalibrated (signature
          // is null and this whole branch is dead).
          lastSignature = {
            text: (lastSignature ? lastSignature.text : '') + signature.text,
            ...(signature.signatureType != null ? { signatureType: signature.signatureType } : {}),
            ...(signature.thinkingId != null ? { thinkingId: signature.thinkingId } : {}),
          };
          queue.push({
            type: 'signature',
            reasoning_signature: signature.text,
            ...(signature.signatureType != null ? { signatureType: signature.signatureType } : {}),
            ...(signature.thinkingId != null ? { thinkingId: signature.thinkingId } : {}),
          });
        }
        if (reasoning) { queue.push({ type: 'reasoning', text: reasoning }); }
        if (content) { queue.push({ type: 'content', text: content }); }
        if (finish != null) lastFinish = finish;
        if (usage) lastUsage = usage;
        if (billing) lastBilling = { ...lastBilling, ...billing };
        if (toolCalls) { for (const tc of toolCalls) nativeToolCalls.push(tc); }
        if (reasoning || content || frameDump || metaDump || signature) pump();
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
  req.setTimeout(idleTimeoutMs, () => {
    req.destroy();
    if (!streamError) streamError = Object.assign(new Error('DEVIN_CONNECT: idle timeout (no data)'), { code: 'TIMEOUT' });
    done = true;
    pump();
  });
  // Absolute wall-clock deadline: a hung upstream that trickles bytes keeps
  // resetting the idle timer above and would otherwise stream forever. This
  // fires regardless of activity and is the real backstop against a stuck
  // request pinning an account's _inflight slot.
  const deadlineTimer = setTimeout(() => {
    req.destroy();
    if (!streamError) streamError = Object.assign(new Error(`DEVIN_CONNECT: absolute deadline ${absoluteDeadlineMs}ms exceeded`), { code: 'TIMEOUT' });
    done = true;
    pump();
  }, absoluteDeadlineMs);
  // Don't let the deadline timer keep the event loop alive on its own.
  if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();

  req.write(framed);
  req.end();

  // Consumer loop: drain the queue, awaiting more data until the stream ends.
  try {
    while (true) {
      if (queue.length) { yield queue.shift(); continue; }
      if (streamError) throw streamError;
      if (done) {
        // One terminal event carrying finish_reason + usage for the caller to
        // close out an OpenAI-shaped response.
        yield {
          type: 'finish',
          reason: mapFinishReason(lastFinish, env),
          usage: lastUsage
            ? {
                prompt_tokens: lastUsage.prompt,
                completion_tokens: lastUsage.completion,
                total_tokens: lastUsage.prompt + lastUsage.completion,
                // Prompt-cache hits, OpenAI-standard shape. Only present when the
                // upstream carried cache_read_tokens AND the tag was calibrated
                // (DEVIN_CONNECT_BILLING_TAGS); absent on free tier (no caching).
                ...(lastUsage.cache_read_tokens != null
                  ? { prompt_tokens_details: { cached_tokens: lastUsage.cache_read_tokens } }
                  : {}),
                ...(lastUsage.cache_write_tokens != null
                  ? { cache_creation_input_tokens: lastUsage.cache_write_tokens }
                  : {}),
              }
            : null,
          // Billing detail (credit/acu cost) only present when an operator has
          // calibrated DEVIN_CONNECT_BILLING_TAGS against a paid token. Null on
          // free tier / un-configured deployments — zero behavioral change.
          billing: lastBilling,
          // Concrete model behind a router selector, when DEVIN_CONNECT_ACTUAL_MODEL_TAG
          // is pinned. Null otherwise — callers keep echoing the requested name.
          actualModel: lastActualModel,
          // Native tool calls (repeated ChatToolCall) when DEVIN_CONNECT_TOOL_CALL_TAGS
          // is calibrated. Empty otherwise — prompt emulation owns tool calls today.
          toolCalls: nativeToolCalls.length ? nativeToolCalls : null,
          // Full thinking signature (concatenated delta_signature) when
          // DEVIN_CONNECT_SIGNATURE_TAG is calibrated. Null on free tier /
          // un-configured deployments — messages.js then keeps its empty-string
          // signature_delta placeholder (forward-compatible round-trip).
          reasoning_signature: lastSignature ? lastSignature.text : null,
          signature: lastSignature,
        };
        return;
      }
      await new Promise((resolve) => { wake = resolve; });
    }
  } finally {
    // Clear the deadline timer on EVERY exit (success, error, or early return
    // when the caller stops consuming) so it never fires against a finished
    // request or leaks. The idle timer is cleared by req.destroy below.
    clearTimeout(deadlineTimer);
    if (!req.destroyed) req.destroy();
  }
}

/**
 * Convenience: collect a full (non-streamed) completion. Returns the answer
 * text plus the separated reasoning and terminal metadata, so callers can build
 * either a plain or reasoning-aware OpenAI response.
 *
 * @returns {Promise<{content: string, reasoning: string,
 *                    finish_reason: string|null, usage: object|null,
 *                    billing: object|null}>}
 */
export async function chat(params) {
  let content = '';
  let reasoning = '';
  let finish_reason = null;
  let usage = null;
  let billing = null;
  for await (const ev of streamChat(params)) {
    if (ev.type === 'content') content += ev.text;
    else if (ev.type === 'reasoning') reasoning += ev.text;
    else if (ev.type === 'finish') { finish_reason = ev.reason; usage = ev.usage; billing = ev.billing; }
  }
  return { content, reasoning, finish_reason, usage, billing };
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
  messageText, f64le, SOURCE, encodeImageData, parseBillingTagMap,
  encodeToolDef, parseToolCallTagMap, decodeToolCalls, decodeOneToolCall,
  looksLikeValidJson, parseSignatureTagMap,
};
