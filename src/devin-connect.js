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
 *            multi-frame streaming response (answer text in response field #3;
 *            #9 is the separate reasoning/thinking stream).
 *
 * Zero npm deps. Nothing dials the network at import time.
 */

import https from 'https';
import { StringDecoder } from 'string_decoder';
import { randomUUID, randomBytes, createHmac } from 'crypto';
import * as _wireFs from 'fs';
import * as _wirePath from 'path';
import { log } from './config.js';
import {
  writeMessageField, writeStringField, writeVarintField, writeFixed64Field,
  parseFields, getField, getAllFields,
} from './proto.js';
import { wrapRequest, wrapEnvelope, StreamingFrameParser, connectHeaders, tryGunzip } from './connect.js';
// Observability counter only (mirrors devin-connect-openai.js importing
// recordArgRepair from cline-compat). cc-compat is a zero-I/O, zero-pipeline-
// import pure module, so this cannot create a cycle or perturb the wire path.
import { recordSchemaNormalized } from './handlers/cc-compat.js';
// Observability only, same rationale as recordSchemaNormalized above: the
// metrics module has no imports of its own, so it cannot create a cycle.
import { bumpConnect } from './devin-connect-metrics.js';
// Bounded remote-image fetch (deadline, byte cap, MIME allowlist, per-hop SSRF
// lookup hook). image.js imports only config/pdf/net-safety/vendor codecs, so this
// cannot create a cycle back into the connect pipeline.
import {
  fetchImageUrl,
  MAX_SIZE as MAX_IMAGE_BYTES,
  MAX_BASE64_LEN as MAX_IMAGE_BASE64_LEN,
  MIME_OK as IMAGE_MIME_ALLOWLIST,
} from './image.js';

const HOST = 'server.codeium.com';
const PATH = '/exa.api_server_pb.ApiServerService/GetChatMessage';
// Short-lived user JWT. Four independent .proto reimplementations agree on the
// method and the response shape ({user_jwt=1, custom_api_server_url=2}); the
// credential is HS256 with roughly a 24-minute lifetime and rides the request as
// ClientMetadata #21. See mintUserJwt below for why this ships default-OFF.
const USER_JWT_PATH = '/exa.auth_pb.AuthService/GetUserJwt';
const METADATA_USER_JWT_FIELD = 21;

// Ceiling for an untrusted upstream response body. Generous next to any real
// Connect-RPC error — upstream returns a JSON envelope or a short text line —
// and far below V8's ~512MiB string limit, so the toString() can never be the
// thing that throws. 8MiB leaves room for a pathological proxy error page
// while keeping the process nowhere near the allocator's ceiling.
// Read once at module load rather than per response: this is a safety ceiling,
// not a tuning knob, and the hot path should not re-parse an env var on every
// error. Overridable so the ceiling itself is testable without allocating
// megabytes per case; a non-positive or unparseable value falls back to the
// default rather than disabling the cap, because "no cap" is the bug.
export const MAX_ERROR_BODY_BYTES = (() => {
  const raw = Number.parseInt(String(process.env.DEVIN_CONNECT_MAX_ERROR_BODY_BYTES ?? ''), 10);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 8 * 1024 * 1024;
})();

// Strict positive-integer env reader (same fallback rule as client.js/auth.js:
// unparseable or non-positive values fall back to the default rather than
// disabling the bound — "no cap" is the bug). Used by the per-stream queue
// caps below; read once per request, never on the per-frame path.
function positiveIntEnv(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}
// Appended when the ceiling is hit, so the truncation is visible to whoever
// reads the error rather than the error silently describing a prefix of
// itself. Mirrors RESPONSE_STORE's TRUNCATION_MARKER.
export const ERROR_BODY_TRUNCATION_MARKER = '\n[... truncated: upstream error body exceeded the cap ...]';

/**
 * Bounded accumulator for an upstream response body.
 *
 * EVERY reader that takes an HTTP body off the wire uses this — the streamChat
 * non-200 branch, postConnectUnary (GetUserJwt) and the catalog unary probe
 * (GetCliModelConfigs / GetUserStatus / AssignModel) — so the ceiling and the
 * truncation behavior cannot drift between call sites.
 *
 * Why a ceiling at all: concatenating without one is an availability bug, not
 * a parsing one. A misbehaving or hostile upstream can stream past V8's
 * ~512MiB string limit, at which point Buffer.concat(...).toString('utf8')
 * throws ERR_STRING_TOO_LONG. That throw happens inside the 'end' listener,
 * where nothing catches it: it escapes as an uncaughtException and
 * src/index.js exits the process, so one bad response from one upstream
 * disconnects every tenant. Same shape as the decodeGrpcMessage guard in
 * grpc.js:21-34.
 *
 * Keep a genuine prefix rather than whole chunks. Slicing the chunk that
 * crosses the ceiling is what makes this correct for a body that arrives as
 * one large chunk: dropping that chunk instead would leave nothing behind and
 * the error would be a bare truncation marker describing no upstream output at
 * all. The tail is discarded, never accumulated.
 */
export function createBoundedBodyAccumulator() {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  return {
    onData(chunk) {
      if (truncated) return;
      const room = MAX_ERROR_BODY_BYTES - bytes;
      if (chunk.length <= room) {
        bytes += chunk.length;
        chunks.push(chunk);
        return;
      }
      if (room > 0) chunks.push(chunk.subarray(0, room));
      bytes = MAX_ERROR_BODY_BYTES;
      truncated = true;
    },
    /** @returns {{ raw: Buffer, truncated: boolean }} */
    finish() {
      return { raw: Buffer.concat(chunks), truncated };
    },
  };
}

function validatedAccountConnectHost(host) {
  const refused = () => Object.assign(new Error('ERR_CONNECT_ACCOUNT_HOST_NOT_ALLOWED'), {
    code: 'ERR_CONNECT_ACCOUNT_HOST_NOT_ALLOWED',
  });
  // The URL parser normalizes whitespace and backslashes. Reject those inputs
  // explicitly, along with an empty/userinfo authority, before using its host.
  if (typeof host !== 'string' || /[\s\\]/.test(host)) throw refused();
  let url;
  try { url = new URL(host); }
  catch { throw refused(); }
  // Only the chat origin demonstrated by this tree is authorized to receive
  // a live session token. Do not infer trust from a suffix or imported URL.
  // WHATWG normalizes an explicit HTTPS :443 to an empty port.
  if (url.protocol !== 'https:' || url.hostname !== HOST || url.port !== ''
      || url.username !== '' || url.password !== '' || host.includes('@')
      || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw refused();
  }
  return url.hostname;
}

// ─── Wire capture (RE / vision analysis, gated) ─────────────────────────────
// When DEVIN_CONNECT_WIRE_DUMP=1, drop the raw upstream GetChatMessage
// request/response bytes to disk so the exact protobuf (thinking #12, vision,
// tool_call tags) can be analyzed offline. Default OFF = zero overhead; the dir
// defaults to <cwd>/.wire-dump. Filenames carry a timestamp + model + kind. This
// is a temporary self-use debug aid, never a served endpoint.
let _wireSeq = 0;
function dumpWire(kind, bytes, meta = {}) {
  const wireDump = String(process.env.DEVIN_CONNECT_WIRE_DUMP || '') === '1';
  const traced = String(process.env.WINDSURFAPI_TRACE || '') === '1' && meta.traceId;
  if (!wireDump && !traced) return;
  if (!bytes || !bytes.length) return;
  try {
    // Full-chain trace mode: drop the raw bytes into this request's trace dir
    // under the fixed leg name (03=req, 04=res) the manifest expects, so the
    // Devin wire bytes sit next to 01-client-req / 02-routing / 05-client-res.
    if (traced) {
      const root = process.env.WINDSURFAPI_TRACE_DIR || _wirePath.resolve(process.cwd(), '.trace');
      const tdir = _wirePath.join(root, String(meta.traceId).replace(/[^\w.-]/g, '_'));
      _wireFs.mkdirSync(tdir, { recursive: true });
      const leg = kind === 'req' ? '03-upstream-req' : '04-upstream-res';
      _wireFs.writeFileSync(_wirePath.join(tdir, `${leg}.bin`), bytes);
      if (meta.note) _wireFs.writeFileSync(_wirePath.join(tdir, `${leg}.txt`), meta.note);
    }
    // Standalone wire-dump mode (offline RE, no trace correlation needed).
    if (wireDump) {
      const dir = process.env.DEVIN_CONNECT_WIRE_DUMP_DIR || _wirePath.resolve(process.cwd(), '.wire-dump');
      _wireFs.mkdirSync(dir, { recursive: true });
      const seq = String(++_wireSeq).padStart(4, '0');
      const model = String(meta.model || 'model').replace(/[^\w.-]/g, '_').slice(0, 40);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = `${stamp}-${seq}-${model}-${kind}`;
      _wireFs.writeFileSync(_wirePath.join(dir, `${base}.bin`), bytes);
      if (meta.note) _wireFs.writeFileSync(_wirePath.join(dir, `${base}.txt`), meta.note);
    }
  } catch (e) {
    log.warn(`wire-dump failed: ${e.message}`);
  }
}

// Transport seam: defaults to https.request. Swappable in tests so the timeout
// / deadline logic can be exercised against a fake socket without a live call.
let requestImpl = https.request;
export function __setRequestImpl(fn) { requestImpl = fn || https.request; }

// ClientMetadata constants observed on every live CLI request. "chisel" is the
// CLI's internal client name; the version string tracks the Devin CLI build.
const CLIENT_NAME = 'chisel';
const CLIENT_VERSION = '2026.8.18';

// ChatMessage.source enum (field #2). Mirrors windsurf.js SOURCE — only the
// values this path actually emits are listed. TOOL_RESULT (4) and its matching
// tool_call_id #7 are verified by native tool-history captures; ordinary image
// input remains source=USER and uses repeated #10 on that same message.
const SOURCE = Object.freeze({ USER: 1, ASSISTANT: 2, TOOL_RESULT: 4 });

// CompletionConfig defaults, matched to the captured CLI request.
// #2 = max_tokens, #3 = max_newlines (schema-confirmed); see buildCompletionConfig.
const DEFAULT_MAX_NEWLINES = 128000;
const DEFAULT_MAX_TOKENS = 4096;
// What goes on the wire at #2 when the caller named no cap. Deliberately NOT
// DEFAULT_MAX_TOKENS: since the tag fix, #2 is an ENFORCED output cap, and a defaulted
// call must not be quietly capped below the repo's own output convention (config.js
// MAX_TOKENS=8192, and the `|| 8192` fallbacks in handlers/messages.js + gemini.js).
// Overridable so an operator can raise or lower it without a code change.
const WIRE_DEFAULT_MAX_TOKENS = (() => {
  const n = Number(process.env.DEVIN_CONNECT_WIRE_MAX_TOKENS);
  return Number.isInteger(n) && n > 0 ? n : 8192;
})();
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
 * Generate the fingerprint for ClientMetadata #31. The server only checks the
 * length/shape (732 hex chars = 366 bytes), NOT the value (see file header
 * §2 + the length-only check in this file), so both a per-request random hex
 * string and a stable per-account one are accepted at the wire level.
 *
 * @param {string} [deviceSeed] — when provided (per-account stable device mode,
 *   opt-in), the 366 bytes are DERIVED deterministically from the seed via an
 *   HMAC-SHA256 counter (HKDF-style expand), so the same account presents the
 *   same device fingerprint on every request. When absent (default), fall back
 *   to the historical per-request `randomBytes(366)` — BYTE-IDENTICAL behavior,
 *   so the default path is unchanged. The choice between the two is gated by the
 *   caller (WINDSURFAPI_STABLE_DEVICE + a per-account deviceSeed), never here.
 */
function generateFingerprint(deviceSeed) {
  if (!deviceSeed) return randomBytes(366).toString('hex'); // default: per-request random
  return deriveDeviceBytes(deviceSeed, 'devin-clientmeta', 366).toString('hex');
}

/**
 * HKDF-style expand: stretch a seed into `len` bytes deterministically using
 * HMAC-SHA256 in counter mode (RFC 5869 expand phase, no salt). Same (seed,
 * info, len) → same bytes; different accounts (different seeds) → different
 * bytes; the `info` label namespaces distinct fingerprints from one seed so the
 * #31 metadata and, later, the login UA cannot be cross-correlated or reversed.
 */
function deriveDeviceBytes(seed, info, len) {
  const out = [];
  let produced = 0;
  let counter = 0;
  let prev = Buffer.alloc(0);
  while (produced < len) {
    counter++;
    const h = createHmac('sha256', String(seed));
    h.update(prev);
    h.update(Buffer.from(info, 'utf8'));
    h.update(Buffer.from([counter & 0xff]));
    prev = h.digest();
    out.push(prev);
    produced += prev.length;
  }
  return Buffer.concat(out).subarray(0, len);
}

// ── File/document content (P-03) ─────────────────────────────────────────
//
// The GetChatMessage ChatMessage wire has NO attachment field. Its calibrated
// shape is {uuid #1, role #2, text #3, tool_call_id #7, images #10} plus the
// optional reasoning tag (see encodeChatMessage below); `text` is a single
// string. So a typed file/document block cannot be "preserved through the
// builder": there is nowhere on the wire to put it. `messageText()` used to
// filter only `{type:'text'}` parts, which turned a Responses `input_file`
// (or Chat `file`) block into '' — the model answered the instruction without
// the document and no layer reported the loss.
//
// Cascade is different: image.js `extractImages` turns PDF file blocks into
// text before the prompt is built, so responses.js deliberately keeps the
// typed block. This module is the Connect boundary and must refuse instead of
// silently flattening. The handler raises the 400 before account acquisition;
// buildGetChatMessageRequest repeats the check for direct callers.

const FILE_CONTENT_TYPES = new Set(['file', 'input_file', 'document']);
const NON_FILE_CONTENT_TYPES = new Set([
  'text', 'input_text', 'output_text', 'image', 'image_url', 'input_image',
  'input_audio', 'audio', 'thinking', 'tool_use', 'tool_result',
]);

/** True for a content block carrying a file/document payload. */
export function isFileContentPart(part) {
  if (!part || typeof part !== 'object') return false;
  const type = String(part.type || '').toLowerCase();
  if (FILE_CONTENT_TYPES.has(type)) return true;
  // Known text/image/tool blocks are never file payloads, even if a client
  // attaches an unrelated `file` property.
  if (NON_FILE_CONTENT_TYPES.has(type)) return false;
  // Shape-only / defensive variants: {file:{...}} with no type (or an unknown
  // type), or the Responses `file_data` / `file_id` fields at the top level.
  if (part.file && typeof part.file === 'object') return true;
  if (typeof part.file_data === 'string' && part.file_data) return true;
  if (typeof part.file_id === 'string' && part.file_id) return true;
  return false;
}

/** First file/document block in a content array, or null. */
export function findFileContentPart(content) {
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (isFileContentPart(part)) return part;
  }
  return null;
}

/** First file/document block anywhere in a [{role, content}] message list. */
export function findFilePartInMessages(messages) {
  if (!Array.isArray(messages)) return null;
  for (const msg of messages) {
    const found = findFileContentPart(msg?.content);
    if (found) return found;
  }
  return null;
}

/**
 * Stable 400-class error for a file/document block the Connect wire cannot
 * carry. `param` names the request field the caller must change: `input` on
 * /v1/responses, `messages` on /v1/chat/completions.
 */
export function unsupportedFilePartError(part, { param = 'input' } = {}) {
  const type = String(part?.type || 'file').toLowerCase();
  const rawName = part?.file?.filename || part?.filename || part?.file?.name || '';
  const name = String(rawName).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 120);
  const label = name ? `${type} "${name}"` : type;
  const error = new Error(
    `Unsupported content part (${label}): the Devin Connect backend carries only text and images `
    + '(ChatMessage has no file/document field), so this payload cannot reach the model. '
    + `Remove it from \`${param}\` or use a backend/model that supports document input.`,
  );
  error.code = 'unsupported_input_file';
  error.param = param;
  error.status = 400;
  return error;
}

/**
 * Flatten an OpenAI-style message content into plain text. Cloud GetChatMessage
 * takes a single string per ChatMessage; structured/tool content is degraded to
 * text the same way the legacy Raw path does (see windsurf.js).
 *
 * File/document parts are NOT silently flattened (P-03): they would become ''
 * here while `hasMultimodalContent`/the answerability guard still counted them
 * as content. They throw the stable unsupported-input error instead.
 */
export function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const filePart = findFileContentPart(content);
    if (filePart) throw unsupportedFilePartError(filePart);
    return content.filter(c => c?.type === 'text').map(c => c.text).join('\n');
  }
  if (content == null) return '';
  if (isFileContentPart(content)) throw unsupportedFilePartError(content);
  return JSON.stringify(content);
}

// Image (vision) support — VERIFIED-FROM-WIRE against real Devin clients.
//
// The `images` field lives NESTED inside each ChatMessage at TAG #10 (confirmed
// from the captured protobuf: ChatMessage {uuid #1, role #2, text #3,
// tool_call_id #7, images #10}). Each images entry is an ImageData sub-message
// { base64_data=1, mime_type=2 } — the SAME inner shape as the Cascade path
// (earlier RE guesses of 3,4 were wrong). A 2026-07-30 native SWE-1.7 capture
// proves ordinary multimodal input stays on source=USER with repeated images
// #10; synthesizing an assistant `read` tool call changes the conversation and
// fails on models whose assistant turns require a server-issued signature.
//
// The VERIFIED tag is 10. It is now the default: the extracted Devin schema and
// a native SWE-1.7 request/response both confirm that ordinary user images ride
// directly on the source=USER ChatMessage at repeated #10. Operators can still
// set DEVIN_CONNECT_IMAGE_TAG=0 to disable emission, or point the tag elsewhere
// temporarily when validating a future upstream wire change.
export const VERIFIED_IMAGE_TAG = 10;
export function getImageFieldTag(env = process.env) {
  const raw = String(env.DEVIN_CONNECT_IMAGE_TAG ?? '').trim();
  if (!raw) return VERIFIED_IMAGE_TAG;
  const tag = Number.parseInt(raw, 10);
  return Number.isInteger(tag) && tag > 0 && tag < 536870912 ? tag : 0;
}

/**
 * Pull data-URL / base64 image blocks out of OpenAI-style message content,
 * yielding the same { base64_data, mime_type } shape the Cascade ImageData
 * encoder consumes. Synchronous: only inline data-URL / base64 sources are
 * handled here. http(s) sources are resolved BEFORE the builder runs, by
 * `inlineRemoteImages` in streamChat(); a URL that still reaches this function
 * is named by the builder's unresolved-URL pass instead of vanishing silently.
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

/**
 * True for a content block that would ride the connect wire as an image.
 * Mirrors the two extractors (extractInlineImages above, remoteImageUrl below)
 * rather than a looser `type.startsWith('image')`: a PDF dressed as an Anthropic
 * image block is a document (extractInlineImages skips it), and a bare
 * `image_url` string without `.url` extracts to nothing.
 */
function isWireImageBlock(block) {
  if (!block || typeof block !== 'object') return false;
  const type = String(block.type || '').toLowerCase();
  if (type === 'image') {
    const src = block.source || {};
    const mime = String(src.media_type || '').toLowerCase();
    if (mime === 'application/pdf') return false;
    return (src.type === 'base64' || !src.type) && !!src.data;
  }
  if (type === 'image_url') {
    const url = block.image_url?.url;
    return typeof url === 'string' && url.length > 0;
  }
  // Responses-API shape; responses.js normalises it to image_url before the chat
  // handler, but a direct caller of this helper should still lose the image.
  if (type === 'input_image') {
    const raw = block.image_url;
    if (typeof raw === 'string') return raw.length > 0;
    return typeof raw?.url === 'string' && raw.url.length > 0;
  }
  return false;
}

/**
 * Remove wire-bound image blocks from OpenAI/Anthropic-shaped messages.
 *
 * Used when the live catalog EXPLICITLY declares the resolved selector
 * text-only (supports_images=false): the text turn is preserved, the images are
 * not sent, and the caller counts what was dropped. System turns are skipped —
 * they are hoisted into the text-only system_prompt field (#2), so an image
 * there was never going to ride the wire and counting it would be a false drop.
 *
 * Copy-on-write: the caller's array and message objects are never mutated (the
 * same params object is re-passed on retry/failover). Returns the input array
 * unchanged when nothing was dropped.
 *
 * @param {Array} messages
 * @returns {{messages: Array, dropped: number}}
 */
export function stripImageParts(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { messages, dropped: 0 };
  let out = null;
  let dropped = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role === 'system' || !Array.isArray(msg.content)) continue;
    const kept = msg.content.filter((block) => !isWireImageBlock(block));
    const removed = msg.content.length - kept.length;
    if (!removed) continue;
    dropped += removed;
    if (!out) out = messages.slice();
    out[i] = { ...msg, content: kept };
  }
  return { messages: out || messages, dropped };
}

// ─── Remote image_url resolution (http/https) ───────────────────────────────
//
// `extractInlineImages` is SYNCHRONOUS and only understands data: URLs, so an
// ordinary OpenAI `image_url` block pointing at https://… used to be discarded
// without a trace: the text reached the model, the picture did not, and nothing
// was logged. Measured 2026-10-23 on all four connect families
// (evidence/ToolMatrixLive.md §images): inline PNG answered "Red"/"Green" while
// the same PNG behind an HTTPS URL answered "Unknown"/"cannot see".
//
// The wire builder has to stay synchronous (dozens of call sites and wire tests
// depend on that), so the fetch happens once, here, in streamChat() — the only
// production caller of the builder — before the proto is assembled. Each URL is
// resolved through image.js's `fetchImageUrl`, which already carries every bound
// this needs: an 8 s absolute deadline shared across redirect hops, a 5 MB body
// cap, an image/* content-type allowlist, http(s)-only, and a DNS lookup hook
// that refuses private/loopback/link-local targets on EVERY hop (net-safety.js
// `isPrivateIp`). Reusing it keeps one SSRF policy in the tree instead of a
// second, subtly different one on the connect route.
//
// Bounds beyond the per-fetch ones: at most REMOTE_IMAGE_MAX_PER_REQUEST fetches
// per request, sequential, sharing one REMOTE_IMAGE_FETCH_BUDGET_MS wall-clock
// budget — a caller cannot turn one chat request into an unbounded stream of
// outbound connections. Failures are logged (host only: URLs may carry signed
// query strings), counted, and the image is dropped; the text still goes
// upstream.
export const REMOTE_IMAGE_MAX_PER_REQUEST = 20;
export const REMOTE_IMAGE_FETCH_BUDGET_MS = 8000;

function imageAbortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

/** The http(s) URL of an image_url block, or '' for every other block shape. */
function remoteImageUrl(block) {
  if (!block || typeof block !== 'object' || block.type !== 'image_url') return '';
  const url = block.image_url?.url;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '';
}

/** Host only — never log a full URL, which may carry a signed query string. */
function imageUrlHost(url) {
  try { return new URL(url).host || '(unparseable)'; } catch { return '(unparseable)'; }
}

// Reject with AbortError as soon as the caller aborts, without waiting for the
// fetch's own deadline. The underlying fetch keeps its promise handlers attached
// (no unhandled rejection) and still tears its socket down at the 8 s deadline.
function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(imageAbortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(imageAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

/**
 * Replace every http(s) `image_url` block with an equivalent data URL, fetching
 * it through a bounded transport. Returns a NEW messages array when anything was
 * fetched or dropped (the caller's array and message objects are never mutated —
 * the same params are re-passed on retry/failover), otherwise the input as-is.
 *
 * `fetchImpl` is injectable for tests; it must resolve { base64_data, mime_type }.
 *
 * @param {Array} messages OpenAI-shaped messages
 * @param {{ signal?: AbortSignal, fetchImpl?: Function }} [opts]
 * @returns {Promise<Array>}
 */
export async function inlineRemoteImages(messages, { signal, fetchImpl = fetchImageUrl } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  if (signal?.aborted) throw imageAbortError();

  const deadline = Date.now() + REMOTE_IMAGE_FETCH_BUDGET_MS;
  let fetched = 0;
  let out = null; // copy-on-write: untouched arrays stay shared with the caller

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    // System turns are hoisted into field #2 as text; they have no image slot.
    if (!msg || msg.role === 'system' || !Array.isArray(msg.content)) continue;
    if (!msg.content.some((b) => remoteImageUrl(b))) continue;

    const blocks = [];
    let changed = false;
    for (const block of msg.content) {
      const url = remoteImageUrl(block);
      if (!url) { blocks.push(block); continue; }

      if (fetched >= REMOTE_IMAGE_MAX_PER_REQUEST) {
        log.warn(`DEVIN_CONNECT: more than ${REMOTE_IMAGE_MAX_PER_REQUEST} remote image_url blocks in one request — image from ${imageUrlHost(url)} not fetched and dropped`);
        bumpConnect('remote_image_fetch_failed');
        changed = true;
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        log.warn(`DEVIN_CONNECT: remote image fetch budget (${REMOTE_IMAGE_FETCH_BUDGET_MS} ms) exhausted — image from ${imageUrlHost(url)} dropped`);
        bumpConnect('remote_image_fetch_failed');
        changed = true;
        continue;
      }
      fetched++;
      let img;
      try {
        img = await withAbort(
          fetchImpl(url, Math.min(remaining, REMOTE_IMAGE_FETCH_BUDGET_MS)),
          signal,
        );
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        log.warn(`DEVIN_CONNECT: remote image_url fetch failed (${imageUrlHost(url)}): ${err.message} — image dropped, text preserved`);
        bumpConnect('remote_image_fetch_failed');
        changed = true;
        continue;
      }

      const mime = String(img?.mime_type || '').toLowerCase();
      const data = typeof img?.base64_data === 'string' ? img.base64_data : '';
      // fetchImageUrl already enforces both, but this helper also accepts an
      // injected transport: re-check the RESULT so a different/regressed fetcher
      // cannot smuggle non-image bytes or an oversized payload onto the wire.
      if (!data || !IMAGE_MIME_ALLOWLIST.has(mime)) {
        log.warn(`DEVIN_CONNECT: remote image_url returned unsupported type "${mime || 'none'}" (${imageUrlHost(url)}) — image dropped`);
        bumpConnect('remote_image_fetch_failed');
        changed = true;
        continue;
      }
      if (data.length > MAX_IMAGE_BASE64_LEN) {
        log.warn(`DEVIN_CONNECT: remote image_url exceeds ${MAX_IMAGE_BYTES} bytes (${imageUrlHost(url)}) — image dropped`);
        bumpConnect('remote_image_fetch_failed');
        changed = true;
        continue;
      }

      blocks.push({
        ...block,
        image_url: { ...(block.image_url || {}), url: `data:${mime};base64,${data}` },
      });
      bumpConnect('remote_images_inlined');
      changed = true;
    }

    if (!changed) continue;
    if (!out) out = messages.slice();
    out[i] = { ...msg, content: blocks };
  }
  return out || messages;
}

/** Encode one ImageData sub-message. Inner tags are calibratable via
 * DEVIN_CONNECT_IMAGE_INNER_TAGS="base64,mime" (default "1,2").
 * VERIFIED-FROM-WIRE (req022 CM#5 #10): ImageData is a protobuf submessage
 * { base64_data=#1, mime_type=#2 }, and #1 carries a BASE64 TEXT string (starts
 * "iVBORw0KGgo…" = PNG magic after a base64 pass), NOT raw image bytes — hence
 * writeStringField, not writeBytesField. An earlier RE guess of 3,4 (from a
 * declaration-order reading of {width,height,base64_data,mime_type,source_path})
 * was DISPROVEN by the wire; the calibration hook is retained only as an escape
 * valve, the wire-proven default is 1,2. */
function encodeImageData(img, env = process.env) {
  let bTag = 1, mTag = 2;
  const raw = String(env.DEVIN_CONNECT_IMAGE_INNER_TAGS || '').trim();
  if (/^\d+,\d+$/.test(raw)) {
    const [b, m] = raw.split(',').map((n) => Number.parseInt(n, 10));
    if (b > 0 && m > 0) { bTag = b; mTag = m; }
  }
  return Buffer.concat([
    writeStringField(bTag, img.base64_data),
    writeStringField(mTag, img.mime_type || 'image/png'),
  ]);
}

function encodeChatMessage({
  source,
  text = '',
  images = [],
  imageTag = 0,
  toolCallId = '',
  reasoning = '',
  reasoningTagNum = 0,
  signature = '',
  env = process.env,
}) {
  const fields = [
    writeStringField(1, randomUUID()),
    writeVarintField(2, source),
    writeStringField(3, text),
  ];
  if (toolCallId) fields.push(writeStringField(7, toolCallId));
  if (imageTag) {
    for (const image of images) {
      fields.push(writeMessageField(imageTag, encodeImageData(image, env)));
    }
  }
  if (reasoning && reasoningTagNum) {
    fields.push(writeStringField(reasoningTagNum, reasoning));
  }
  // #12 thinking signature, only beside its #11 thinking (signed replay).
  if (signature && reasoning && reasoningTagNum === 11) fields.push(writeStringField(12, signature));
  return Buffer.concat(fields);
}

// Encode a role=2 assistant ChatMessage carrying one native #6 tool_call.
// VERIFIED-FROM-WIRE (req022 CM#4 #6): the request-side ToolCall is a PROTOBUF
// submessage { #1 id, #2 name, #3 argsJSON } — only #6.3 (args) is a JSON string.
// This CONTRADICTS the static-RE memory note "request-side ToolCall is
// serde-JSON": the ENVELOPE is protobuf, only the args VALUE is JSON. Wire wins.
// Symmetric with the response-side ChatToolCall #6{1:id,2:name,3:arguments}
// pinned in parseToolCallTagMap.
function encodeAssistantToolCall({ id, name, argsJson, reasoning, reasoningTagNum = 11, signature = '' }) {
  const toolCall = Buffer.concat([
    writeStringField(1, id),
    writeStringField(2, name),
    writeStringField(3, argsJson),
  ]);
  const parts = [
    writeStringField(1, randomUUID()),      // #1 per-message uuid
    writeVarintField(2, SOURCE.ASSISTANT),  // #2 role=2
    writeMessageField(6, toolCall),         // #6 tool_call submessage
  ];
  // The req022 note records #11 on its role=2 frames (59B-1470B); it is not a
  // requirement to emit reasoning when replay is disabled. Nor does that note
  // establish equal payloads across frames split from one logical turn.
  // Enabled replay copies the chosen value to preText and every native call
  // frame (#11 for '1', #9 for '9'). Deduplicating without a paired capture
  // would replace one unverified replay policy with another.
  // The tag-number guard is load-bearing even though callers currently pass reasoningText
  // only when reasoningTagNum is truthy: field 0 is RESERVED in protobuf and a zero tag
  // would serialize makeTag(0,2) — an invalid frame — so the encoder refuses it itself.
  if (reasoning && reasoningTagNum) parts.push(writeStringField(reasoningTagNum, reasoning));
  // #12 thinking signature, only beside its #11 thinking (signed replay).
  if (signature && reasoning && reasoningTagNum === 11) parts.push(writeStringField(12, signature));
  return Buffer.concat(parts);
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
// The OUTER tag is VERIFIED-FROM-BINARY: GetChatMessageRequest.tools lives at
// #10 (CALIBRATED.proto, a live capture carried ~24 ToolDefs there).
//
// The INNER tags are now VERIFIED-FROM-FRAME too (2026-07-04 paid probe, teams
// account, claude-opus-4-8): sending a native ToolDef at #10 with inner tags
// name=1/description=2/parameters=3 and NO prompt preamble, the upstream model
// correctly understood the tools and emitted native tool_calls (grep_repo with
// the right args). Two independent fires (def-only, then def+call closed loop)
// both confirmed. So `10,1,2,3` is the calibrated, working layout — no longer a
// guess. It STILL stays behind the env gate (default OFF → prompt emulation)
// because (a) the response decode gate (DEVIN_CONNECT_TOOL_CALL_TAGS) must be on
// in tandem for the native path to be useful, and (b) enabling by default is a
// behavior change we roll out deliberately, not implicitly.
//
// Accepted forms of DEVIN_CONNECT_TOOL_DEF_TAGS (fail-closed to null on any
// malformed value — never emit a broken frame):
//   - key=val:   "name=1,description=2,parameters=3[,strict=12][,outer=10]"
//     (strict is #12 on the current server; #4 is reserved there)
//   - positional (back-compat): STRICT 4-tuple "10,1,2,3" = outer,name,description,schema.
// To omit outer (use the #10 default), use the key=val form — a positional
// 3-tuple is ambiguous and fails closed to null.
// name/description/parameters are MANDATORY; missing any → null.
// custom_tool / defer_loading are Devin-proprietary with no OpenAI source and
// are deliberately NOT accepted (emitting them risks a broken frame).
const TOOL_DEF_INT_MAX = 536870912; // 2^29, protobuf field-number ceiling
function validTag(n) { return Number.isInteger(n) && n > 0 && n < TOOL_DEF_INT_MAX; }
// VERIFIED tool-def inner tags (paid frame-confirmed 2026-07-04, opus-4-8 on
// teams: outer #10, name=1, description=2, parameters=3). Used as the fallback
// when the nativeToolCall flag is on but no explicit env override is set.
export const DEFAULT_DEF_TAGS = Object.freeze({ outer: 10, name: 1, description: 2, parameters: 3, schema: 3 });

export function getToolDefTags(env = process.env, { useDefault = false } = {}) {
  const raw = String(env.DEVIN_CONNECT_TOOL_DEF_TAGS || '').trim();
  if (!raw) return useDefault ? { ...DEFAULT_DEF_TAGS } : null; // unset → default (flag on) or disabled

  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const map = {};
  if (parts.some((p) => p.includes('='))) {
    // key=val form
    for (const p of parts) {
      const [k, v] = p.split('=').map((s) => s.trim());
      const n = Number.parseInt(v, 10);
      // Only accept keys we know how to emit; silently ignore proprietary ones
      // so a stray custom_tool= can't break the whole gate.
      if (['outer', 'name', 'description', 'parameters', 'schema', 'strict'].includes(k) && validTag(n)) {
        map[k === 'schema' ? 'parameters' : k] = n;
      }
    }
  } else {
    // positional form is back-compat ONLY and STRICT: exactly 4 numbers =
    // outer,name,description,schema(=parameters). A 3- or 5-tuple is ambiguous
    // (is "10,1,2" outer,name,desc-missing-params, or name,desc,params?) so we
    // fail closed to null — use the explicit key=val form to omit outer.
    const nums = parts.map((s) => Number.parseInt(s, 10));
    if (nums.length !== 4 || nums.some((n) => !validTag(n))) return null;
    [map.outer, map.name, map.description, map.parameters] = nums;
  }

  if (map.outer === undefined) map.outer = 10; // VFB default
  // Mandatory inner tags; without all three there's nothing coherent to emit.
  if (!validTag(map.outer) || !validTag(map.name) || !validTag(map.description) || !validTag(map.parameters)) {
    return null; // fail closed to emulation
  }
  // `schema` kept as an alias of `parameters` for back-compat with existing
  // callers/tests that read tags.schema.
  const out = { outer: map.outer, name: map.name, description: map.description, parameters: map.parameters, schema: map.parameters };
  if (validTag(map.strict)) out.strict = map.strict;
  return out;
}

/**
 * Encode one ToolDef sub-message from an OpenAI function-tool entry
 * ({ type:'function', function:{ name, description, parameters, strict } }).
 *
 * parameters (the JSON Schema) is serialized to a STRING. Rationale: static RE
 * ruled out a nested google.protobuf.Struct (Struct/Value type count in the
 * binary is 0), and schemars→JSON + serde_json RawValue evidence points to a
 * serialized-JSON field. string vs bytes share wiretype 2 and are byte-identical
 * on the wire, so if a paid capture ever proves bytes, the ONLY change is
 * swapping writeStringField→writeBytesField here (zero risk). ← SWITCH POINT.
 *
 * strict (OpenAI function.strict) is emitted as a varint bool ONLY when the
 * operator calibrated a `strict` tag AND the tool asked for it — calibrate
 * `strict=12` (the field's number on the current server; #4 is reserved there).
 * The default tag map has no strict key, so nothing is emitted unless an
 * operator opts in. custom_tool / defer_loading are Devin-proprietary and
 * never emitted (getToolDefTags rejects their keys).
 */
// Normalize an OpenAI/MCP function-parameters JSON Schema into the minimal,
// well-formed shape upstream accepts. Real clients (OpenCode, MCP servers) emit
// schemas with missing/loose fields or proprietary keys ($schema, unevaluated
// keywords) that a strict upstream can reject (→ `invalid_argument` → 400
// REQUEST_REJECTED). Portable
// hardening (kiro's normalize_json_schema, repo-hank9999): guarantee an object
// schema with a `properties` object and a string[] `required`, and DROP keys the
// upstream doesn't want ($schema). Non-destructive to the caller's real schema
// content — only fixes the envelope. Returns a plain object safe to JSON.stringify.
export function normalizeToolSchema(schema) {
  // Non-object / missing schema → the canonical empty object schema.
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  const out = { ...schema };
  // $schema is a meta key some clients add; upstream schemas never carry it.
  delete out.$schema;
  // Strip top-level oneOf/anyOf/allOf BEFORE the properties/type normalization
  // below — a schema that is a bare top-level combinator (no properties) would
  // otherwise be forced to `{type:'object',properties:{}}` and lose its real
  // parameters. Recovering properties from a variant here lets the properties
  // guard below see the recovered object instead of overwriting it with {}.
  if (stripTopLevelCombinators(out)) recordSchemaNormalized();
  // Force an object schema (function parameters are always an object).
  if (out.type !== 'object') out.type = 'object';
  // properties must be an object (not array/null/absent).
  if (!out.properties || typeof out.properties !== 'object' || Array.isArray(out.properties)) {
    out.properties = {};
  }
  // required must be a string[] naming only real properties; drop anything else.
  if (out.required !== undefined) {
    if (!Array.isArray(out.required)) {
      delete out.required;
    } else {
      const keys = new Set(Object.keys(out.properties));
      const req = out.required.filter((r) => typeof r === 'string' && keys.has(r));
      if (req.length) out.required = req; else delete out.required;
    }
  }
  return normalizeSchemaTree(out);
}

// ★ Strip top-level oneOf/anyOf/allOf combinators in place (ported from kiro.rs
// converter.rs strip_top_level_combinators). Bedrock/Anthropic reject a tool
// parameters schema whose ROOT is a combinator instead of an object; a bare
// top-level oneOf also collides with our "force object" normalization. We remove
// the three combinator keys and, only when the schema had NO top-level
// properties of its own, recover properties/required/additionalProperties/
// description from the first `type:object` variant (never overwriting keys the
// schema already has — matches kiro's or_insert semantics). Byte-identical for
// any schema without a top-level combinator: the loop's `Array.isArray` guard
// means a schema lacking these keys is left completely untouched. Mutates `out`.
function stripTopLevelCombinators(out) {
  const hasPropsInitially = Object.prototype.hasOwnProperty.call(out, 'properties');
  let recovered = false;
  let stripped = false;
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (!Array.isArray(out[key])) continue;
    const variants = out[key];
    delete out[key];
    stripped = true;
    // Recover real parameters only if the root had none and we haven't already
    // pulled them from an earlier combinator.
    if (hasPropsInitially || recovered) continue;
    const objVariant = variants.find(
      (v) => v && typeof v === 'object' && !Array.isArray(v) && v.type === 'object',
    );
    if (!objVariant) continue;
    for (const field of ['properties', 'required', 'additionalProperties', 'description']) {
      if (Object.prototype.hasOwnProperty.call(objVariant, field)
          && !Object.prototype.hasOwnProperty.call(out, field)) {
        out[field] = objVariant[field];
      }
    }
    recovered = true;
  }
  return stripped;
}

const LITERAL_VALUE_KEYS = new Set(['default', 'examples', 'enum', 'const']);
// ★ Recursively normalize a JSON Schema tree for the native ToolDef path.
// Two jobs, both required by upstream's decoder:
//  1. Strip `description` ANNOTATIONS, but preserve properties that happen to
//     be NAMED "description" (a real parameter, e.g. Cursor's Task tool has a
//     `description` property). Only schema-annotation `description` keys
//     (siblings of `type`/`properties`/`required`) are removed. This
//     neutralizes upstream's MCP-gate fingerprinting on parameter descriptions
//     while keeping the full schema structure (types, required, enums, nested
//     objects) intact for the model.
//  2. Lower every `type` ARRAY to an equivalent `anyOf` of single-type members.
//     Upstream rejects the whole request with `invalid_argument` on
//     `"type": ["number","null"]` (reproduced live with omp grep's `skip`
//     parameter), while `anyOf: [{type:"number"},{type:"null"}]` is accepted.
//     The lowering is lossless: `anyOf` with one `{type: member}` per member
//     accepts exactly the same values, nullability included.
// The traversal is the existing one: every object/array is rebuilt (so the
// caller's schema is never mutated). `inProperties` keeps its original meaning
// (the current object is a `properties` MAP, whose keys are parameter names) so
// description stripping stays byte-identical. `kind` is the accurate container
// check used only for type lowering:
//   'schema'     — a JSON Schema object (the only place a `type` keyword lives)
//   'properties' — a properties MAP: its KEYS are parameter names, its VALUES
//                  are schemas (so a parameter named "properties"/"default"
//                  still gets lowered)
//   'literal'    — caller data from default/examples/enum/const. STICKY: every
//                  descendant, including through arrays and nested objects, is
//                  data, never a schema.
function normalizeSchemaTree(value, inProperties = false, kind = 'schema') {
  if (Array.isArray(value)) {
    // Tuple items/prefixItems/combinator arrays contain schemas; literal arrays
    // (enum/examples values) stay literal all the way down.
    const itemKind = kind === 'literal' ? 'literal' : 'schema';
    return value.map((item) => normalizeSchemaTree(item, false, itemKind));
  }
  if (!value || typeof value !== 'object') return value;
  const out = {};
  // Only a schema object carries the `type` keyword; inside a `properties` map
  // `type` is just a parameter name. A malformed (non-string-member) or empty
  // array is left untouched rather than rejected.
  const typeMembers = kind === 'schema'
    && Array.isArray(value.type)
    && value.type.length > 0
    && value.type.every((member) => typeof member === 'string')
    ? value.type
    : null;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'description' && !inProperties) continue;
    if (key === 'type' && typeMembers) continue;
    // A schema's `properties` value is a map; a schema's literal-value keys are
    // caller data. Inside a properties map every value is a schema; inside a
    // literal everything stays literal.
    const childKind = kind === 'literal'
      ? 'literal'
      : kind === 'properties'
        ? 'schema'
        : key === 'properties'
          ? 'properties'
          : LITERAL_VALUE_KEYS.has(key) ? 'literal' : 'schema';
    out[key] = normalizeSchemaTree(child, key === 'properties', childKind);
  }
  if (typeMembers) {
    const lowered = typeMembers.map((member) => ({ type: member }));
    // `anyOf` is the only combinator key the lowering would collide with. Keep
    // an existing one and AND the lowered union in through `allOf` (created, or
    // appended when it already exists) so neither semantic is dropped:
    //   anyOf(A...) AND type∈T  ≡  anyOf(A...) AND allOf(anyOf(T...))
    // (a sibling allOf is the intersection, so no branch cross-product is
    // needed). oneOf/allOf are independent keywords and simply coexist.
    if (out.anyOf === undefined) {
      out.anyOf = lowered;
    } else if (Array.isArray(out.allOf)) {
      out.allOf = [...out.allOf, { anyOf: lowered }];
    } else if (out.allOf === undefined) {
      out.allOf = [{ anyOf: lowered }];
    } else {
      out.type = [...value.type]; // malformed anyOf + allOf: preserve the original
    }
  }
  return out;
}

// ★ Tool-description length cap (2026-07-10, verified from live paid probes).
// SUPERSEDED (2026-07-13): the MCP-gate fix below (encodeToolDef replaces the
// top-level description with the tool name and normalizeSchemaTree removes
// parameter-schema `description` annotations) is the authoritative approach —
// it neutralizes BOTH the description-length threshold AND the MCP-gate
// fingerprint match in one pass. capToolDescription is no longer called by
// encodeToolDef. The function + env knob are retained as an escape hatch in
// case a future upstream change reintroduces a pure length threshold without
// the fingerprint match; set WINDSURFAPI_TOOL_DESC_MAX to re-enable truncation
// if you wire it back into encodeToolDef. Default 500 (proven-safe for the
// length-only threshold); 0 = no cap.
function toolDescMax(env = process.env) {
  const raw = Number(env.WINDSURFAPI_TOOL_DESC_MAX);
  return Number.isFinite(raw) && raw >= 0 ? raw : 500;
}
function capToolDescription(desc, env = process.env) {
  const cap = toolDescMax(env);
  const s = String(desc);
  if (cap <= 0 || s.length <= cap) return s;
  return s.slice(0, cap);
}

// ★ MCP-gate neutralization (2026-07-13, verified from live A/B probes).
// Upstream server.codeium.com pattern-matches tool descriptions (both the
// top-level ToolDef #10.description AND parameter schema `description` keys)
// for known tool signatures and rejects the whole request with
// permission_denied: "Unable to process request due to an MCP configuration
// issue." Live A/B on Cursor's real 21-tool inventory found 8 of 21 tools
// triggered the gate (AskQuestion, Glob, Grep, Read, ReadLints, Shell,
// WebFetch, WebSearch). The gate fires on a COMBINATION of top-level
// description + parameter descriptions — removing either alone is
// insufficient for most tools.
//
// Fix: replace the top-level description with the tool name (the model
// identifies tools by name, not by description prose) and strip all
// `description` annotations from the parameter JSON Schema (see
// normalizeSchemaTree in normalizeToolSchema). Schema structure (types,
// required, enums, nested objects, properties named "description") is
// preserved — only human-readable annotation text is removed.
//
// ONLY needed on the native tool-def path (DEVIN_CONNECT_TOOL_DEF_TAGS on).
// With native OFF (prompt emulation), descriptions ride in prompt text which
// upstream does not scan — no gate, no neutralization needed.

function encodeToolDef(tool, tags) {
  const fn = tool?.function || {};
  const fields = [];
  if (fn.name) fields.push(writeStringField(tags.name, String(fn.name)));
  if (fn.description) fields.push(writeStringField(tags.description, String(fn.name || 'tool')));
  if (fn.parameters !== undefined) {
    // SWITCH POINT (see header): string today; writeBytesField if RE/capture proves bytes.
    // Normalize the schema envelope first so a malformed client/MCP schema can't
    // corrupt the ToolDef and trip a strict upstream decode.
    fields.push(writeStringField(tags.parameters, JSON.stringify(normalizeToolSchema(fn.parameters))));
  }
  if (tags.strict && fn.strict === true) {
    fields.push(writeVarintField(tags.strict, 1));
  }
  return Buffer.concat(fields);
}

// ─── Short-lived user JWT (GetUserJwt), opt-in ──────────────────────────────
//
// The upstream exposes exa.auth_pb.AuthService/GetUserJwt, which exchanges the
// long-lived session token for a short-lived HS256 JWT (~24 min) that rides the
// chat request as ClientMetadata #21. Four independent .proto reimplementations
// agree on the method name and the response shape, and one third-party client
// treats the JWT as REQUIRED for chat RPCs.
//
// It ships default-OFF (DEVIN_CONNECT_USER_JWT=1 to enable), for one reason: our
// chat path demonstrably works WITHOUT it today. "Another client sends this" is a
// coordinate, not evidence that our requests need it, and adding an unrequested
// credential field to a working wire is the kind of change that fails in a way
// only production traffic reveals. Enabling it is therefore an operator decision
// backed by their own capture. When off, not a single byte of the request changes
// and no extra RPC is issued.
//
// Cache design, mirroring the one third-party client that ships this: keyed per
// (token, host), refreshed 60s before expiry, with in-flight coalescing so a burst
// of concurrent requests mints once — plus a monotonic epoch that invalidates a
// mint already in flight. The epoch is the part worth copying deliberately: without
// it, a mint started before a logout/rotation can land afterwards and repopulate
// the cache with a credential belonging to the PREVIOUS account, which then rides
// the next tenant's request. The failure is silent and cross-account, so the guard
// is not optional.
const _userJwtCache = new Map(); // `${token}\0${host}` → { jwt, expMs, epoch }
const _userJwtInflight = new Map(); // same key → Promise<string|null>
let _userJwtEpoch = 0;

/** Bump the epoch so any in-flight mint is discarded instead of cached. */
export function invalidateUserJwtCache() {
  _userJwtEpoch += 1;
  _userJwtCache.clear();
  _userJwtInflight.clear();
}

export function isUserJwtEnabled(env = process.env) {
  return String(env.DEVIN_CONNECT_USER_JWT ?? '').trim() === '1';
}

/** Seconds of headroom before `exp` at which a cached JWT is considered stale. */
const USER_JWT_REFRESH_SKEW_MS = 60_000;
const USER_JWT_CACHE_MAX = 500;

/**
 * Absolute deadline for one GetUserJwt mint, ms. Overridable per call via
 * `mintUserJwt(token, { timeoutMs })`; a non-finite or non-positive override
 * falls back here.
 *
 * This RPC runs BEFORE the chat request is built (`streamChat` awaits the mint),
 * so a peer that accepts the connection and then never answers used to pin the
 * whole chat request — and, through the coalescing map above, every other
 * request sharing that token — with no timer running anywhere: the stream's own
 * absolute deadline (DEVIN_CONNECT_TIMEOUT_MS) starts later, and a cold cache
 * has nothing to serve. 15s is the ceiling for an RPC that gates a user-visible
 * request: a healthy mint is one small round trip well under a second, so a peer
 * still silent at 15s is dead and the caller is better off on the historical
 * no-JWT wire. The catalog's metadata unary probe waits 30s
 * (devin-connect-catalog.js:84) but sits in front of no user request.
 *
 * Deliberately NOT env-configurable: the failure this bound prevents is
 * unbounded, so every value a switch could offer is a worse one.
 */
export const USER_JWT_MINT_TIMEOUT_MS = 15_000;

function pruneUserJwtCache(now) {
  for (const [key, entry] of _userJwtCache) {
    if (entry.expMs - USER_JWT_REFRESH_SKEW_MS <= now) _userJwtCache.delete(key);
  }
  while (_userJwtCache.size > USER_JWT_CACHE_MAX) {
    _userJwtCache.delete(_userJwtCache.keys().next().value);
  }
}

/**
 * `exp` (ms) out of a JWT payload, or null when it carries none.
 *
 * A JWT with no readable `exp` is treated as non-cacheable rather than
 * cached-forever: holding a credential we cannot age out is how a rotated or
 * revoked token keeps getting presented until the process restarts.
 */
export function userJwtExpiryMs(jwt) {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = Number(JSON.parse(json)?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    // A malformed payload is "no expiry known", never a throw: this runs on the
    // request path and an upstream that returns junk must degrade, not 500.
    return null;
  }
}

/**
 * Mint (or reuse) the short-lived user JWT for one session token.
 *
 * Returns null on ANY failure — unreachable upstream, non-200, unparseable frame,
 * missing field. Null is a first-class outcome, not an error: the chat request is
 * known to work without #21, so a mint failure must degrade to the historical wire
 * rather than fail the user's request. That is also why nothing here throws.
 *
 * @param {string} sessionToken
 * @param {{host?: string, signal?: AbortSignal, now?: number, timeoutMs?: number}} [opts]
 *   `timeoutMs` overrides USER_JWT_MINT_TIMEOUT_MS for this mint (non-finite or
 *   non-positive → that default, never "no deadline").
 * @returns {Promise<string|null>}
 */
export async function mintUserJwt(sessionToken, opts = {}) {
  if (!sessionToken) return null;
  const host = opts.host || HOST;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const key = `${sessionToken} ${host}`;

  pruneUserJwtCache(now);
  const hit = _userJwtCache.get(key);
  if (hit && hit.expMs - USER_JWT_REFRESH_SKEW_MS > now) {
    _userJwtCache.delete(key);
    _userJwtCache.set(key, hit);
    return hit.jwt;
  }

  // Coalesce: a burst of concurrent requests on a cold cache must mint once.
  const pending = _userJwtInflight.get(key);
  if (pending) return pending;

  // Captured BEFORE the await. If invalidateUserJwtCache() runs while this mint is
  // in flight, the epoch moves and the result is dropped instead of repopulating
  // the cache with a credential for an account that is no longer current.
  const epoch = _userJwtEpoch;
  const task = (async () => {
    try {
      const proto = writeMessageField(1, buildClientMetadata(sessionToken, opts.deviceSeed));
      const framed = wrapEnvelope(proto, { compress: false });
      const raw = await postConnectUnary(host, USER_JWT_PATH, framed, sessionToken, opts.signal, opts.timeoutMs);
      if (!raw) return null;
      const jwt = getField(parseFields(raw), 1, 2)?.value?.toString('utf8')?.trim();
      if (!jwt) return null;
      if (epoch !== _userJwtEpoch) return null; // account changed under us
      const expMs = userJwtExpiryMs(jwt);
      // No readable exp → usable once, never cached. See userJwtExpiryMs.
      const cacheNow = Number.isFinite(opts.now) ? opts.now : Date.now();
      if (expMs && expMs - USER_JWT_REFRESH_SKEW_MS > cacheNow) {
        _userJwtCache.set(key, { jwt, expMs, epoch });
        pruneUserJwtCache(cacheNow);
      }
      return jwt;
    } catch (e) {
      log.debug(`GetUserJwt mint failed (degrading to the no-JWT wire): ${e.message}`);
      return null;
    }
  })();
  // An old-epoch mint must not delete a newer epoch's pending task. Attach
  // cleanup after creation so synchronous encoding failures are cleaned too.
  const pendingTask = task.finally(() => {
    if (_userJwtInflight.get(key) === pendingTask) _userJwtInflight.delete(key);
  });
  _userJwtInflight.set(key, pendingTask);
  return pendingTask;
}

/**
 * One unary Connect-RPC round trip → the response's single protobuf frame.
 *
 * Resolves null (never rejects) for any non-200, malformed body, transport
 * failure, or `timeoutMs` expiry: every caller here treats failure as "carry on
 * without the optional credential".
 */
function postConnectUnary(host, path, framed, sessionToken, signal, timeoutMs) {
  // The one place the deadline is resolved, so a bad override can neither
  // disable the bound nor arm an instant timer — a 0 here would fire on the
  // next turn of the loop, kill a healthy mint and silently turn the opt-in
  // feature into an always-null no-op.
  const deadlineMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs : USER_JWT_MINT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (v) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      resolve(v);
    };
    let req;
    try {
      req = requestImpl({
        hostname: host,
        port: 443,
        path,
        method: 'POST',
        headers: connectHeaders({
          authorization: `Basic ${sessionToken}-${sessionToken}`,
          'Content-Length': framed.length,
          Accept: '*/*',
        }),
        signal,
      }, (res) => {
        // Bounded read even though a non-200 body is discarded below: the
        // response is attacker-controlled and reading it unbounded is the same
        // availability bug the streamChat non-200 branch is guarded against
        // (see createBoundedBodyAccumulator). The same ceiling also covers a
        // 200 body — a unary frame (GetUserJwt) is small, so a body past the
        // ceiling is malformed either way and is treated as such rather than
        // parsed from a truncated prefix.
        const buffer = createBoundedBodyAccumulator();
        res.on('data', buffer.onData);
        res.on('end', () => {
          const { raw: body, truncated } = buffer.finish();
          if (truncated) {
            log.warn(`[devin-connect] ${path} response body exceeded ${MAX_ERROR_BODY_BYTES} bytes; truncated`);
            return done(null);
          }
          if (res.statusCode !== 200) return done(null);
          // Connect envelope: [flags][len:4BE][payload]. A trailer-only response
          // (flag 0x02) carries no message and must not be parsed as one.
          if (body.length < 5) return done(null);
          const flags = body[0];
          const len = body.readUInt32BE(1);
          if (flags & 0x02) return done(null);
          // subarray CLAMPS an over-long declared length; refuse explicitly
          // like the streaming path does instead of feeding a truncated
          // payload to the decoder (S4-D8).
          if (5 + len > body.length) return done(null);
          const payload = body.subarray(5, 5 + len);
          done((flags & 0x01) ? tryGunzip(payload) : payload);
        });
        res.on('error', () => done(null));
      });
      req.on('error', () => done(null));
      // Absolute deadline from request start — not a socket idle timeout, which
      // any byte of traffic resets and which does not cover the connect phase.
      // Armed BEFORE end() so the write can never run ahead of the bound; on
      // expiry the socket is destroyed and the promise leaves through the same
      // resolve(null) door as every other failure above.
      timer = setTimeout(() => {
        try { req.destroy(); } catch { /* already closed */ }
        done(null);
      }, deadlineMs);
      req.end(framed);
    } catch {
      done(null);
    }
  });
}

/**
 * Build the ClientMetadata sub-message (field #1). The token is embedded SINGLE
 * here (the doubling is only for the HTTP Authorization header).
 *
 * `userJwt` (optional) is appended as #21. Absent → byte-identical to before, so
 * the default path is untouched.
 */
function buildClientMetadata(token, deviceSeed, userJwt) {
  return Buffer.concat([
    writeStringField(1, CLIENT_NAME),
    writeStringField(2, CLIENT_VERSION),
    writeStringField(3, token),
    writeStringField(4, 'en'),
    writeStringField(5, 'windows'),
    writeStringField(7, CLIENT_VERSION),
    writeStringField(12, CLIENT_NAME),
    // #21 short-lived user JWT, only when the caller minted one (opt-in). Emitted
    // before #31 to keep the fields ascending, matching every other field here.
    // An empty/absent value contributes NOTHING — not a zero-length #21 — so the
    // default request stays byte-identical to the pre-JWT wire.
    ...(userJwt ? [writeStringField(METADATA_USER_JWT_FIELD, userJwt)] : []),
    // #31 device fingerprint. deviceSeed (per-account stable mode, opt-in) makes
    // it deterministic; undefined → historical per-request random (byte-equiv).
    writeStringField(31, generateFingerprint(deviceSeed)),
  ]);
}

/** Build CompletionConfig (field #8).
 *
 * TAG MAP RE-CALIBRATED FROM THE SCHEMA (was: guessed from field NAME ORDER).
 * Four independent `.proto` definitions of CompletionConfiguration agree:
 *   #2 = max_tokens, #3 = max_newlines.
 * The earlier layout had those two swapped — it sent the 128000 context window as
 * max_tokens and the caller's output cap as max_newlines. That is why the
 * free-tier probe (2026-06-30) saw `maxTokens` 16 → 1000 produce IDENTICAL output
 * (256 completion tokens, finish=stop): the cap never reached the field that
 * enforces it, and max_tokens was pinned wide open at the context window. The old
 * comment read that as "the free model ignores the cap" and declined to re-tag.
 *
 * The swapped wire still produced correct completions (both fields are plausible
 * varints, and a large max_newlines is a no-op), so "a working capture" was never
 * evidence for the mapping — only the schema is.
 */
// ─── tool_choice / parallel_tool_calls passthrough (#12 / #11), opt-in ──────
//
// OpenAI clients send tool_choice ('auto' | 'none' | 'required' | 'any' |
// {type:'function', function:{name}}) and parallel_tool_calls. Today the repo can
// only CLASSIFY tool_choice for cache-keying and prompt-emulation decisions
// (handlers/chat.js:347) — it never reaches the upstream, so 'required' cannot be
// honoured natively and a forced tool name is a request we silently downgrade.
//
// Third-party .proto reimplementations report:
//   #12 tool_choice → ChatToolChoice { option_name = 1, tool_name = 2 }
//   #11 disable_parallel_tool_calls (bool)
//
// UNCONFIRMED COORDINATES. These are DECLARATION ORDER in someone else's .proto,
// not a wire capture, and prost allows tag gaps — so declaration order is not a tag
// number. This is the same epistemic position as the billing tags and #13 above, and
// it gets the same treatment: default-OFF, and the comment says so rather than
// implying the mapping is known. The option_name STRINGS are a second unknown: the
// upstream vocabulary is not observed either, so the map is operator-overridable.
//
// Enable with DEVIN_CONNECT_TOOL_CHOICE=1. Off → neither field is emitted and the
// request is unchanged. An operator who has a capture can also re-point the tags via
// DEVIN_CONNECT_TOOL_CHOICE_TAGS="choice=12,parallel=11".
const TOOL_CHOICE_DEFAULT_TAGS = Object.freeze({ choice: 12, parallel: 11 });

export function isToolChoicePassthroughEnabled(env = process.env) {
  return String(env.DEVIN_CONNECT_TOOL_CHOICE ?? '').trim() === '1';
}

/**
 * True when the caller asked for sequential tool calls (`parallel_tool_calls:false`)
 * and this build will serve the request WITHOUT honouring that hint.
 *
 * The hint can only be honoured natively, through #11 `disable_parallel_tool_calls`,
 * which is opt-in because its tag is unconfirmed (see the header above). With the
 * switch off the field is not emitted, so the request goes upstream unchanged and
 * the model is free to return N calls in one turn — the live matrix measured 4/4
 * models doing exactly that with the flag set false (evidence/ToolMatrixLive.md §8).
 *
 * This is a PREFERENCE, not a correctness requirement, so the handler serves the
 * request, logs the drop once per process and counts it
 * (`parallel_tool_calls_hint_ignored`). It used to answer 400 `unsupported_parameter`
 * instead, which made Codex CLI 0.164 — it sends the hint on every request — fail on
 * its first turn under the shipped default (evidence/ClientSandboxes.md §3.3 C1).
 *
 * Serialising at the proxy is NOT an alternative either: the upstream decides the
 * call count inside one turn, so emitting only the first of N would discard work the
 * model already performed and the client would never learn the rest existed.
 */
export function isParallelToolCallsHintIgnored(parallelToolCalls, env = process.env) {
  return parallelToolCalls === false && !isToolChoicePassthroughEnabled(env);
}

// Top-level tags GetChatMessageRequest already occupies. An override that lands on
// one of these does not "win" — protobuf permits a repeated appearance of a
// non-repeated field and decoders take the LAST, so pointing `choice` at #1 emits a
// second #1 next to the 800-byte ClientMetadata and lets a 10-byte tool_choice
// overwrite the metadata the upstream authenticates on. Silent, and it looks like an
// auth failure rather than a config typo. Measured: with choice=1 the request carried
// TWO #1 fields (814 and 10 bytes).
//
// #11/#12/#13 are absent from this set on purpose — they are the (unconfirmed)
// coordinates this feature and the prompt-cache switch are here to occupy.
const REQUEST_OCCUPIED_TAGS = Object.freeze(new Set([1, 2, 3, 7, 8, 15, 16, 20, 21, 22]));

/**
 * Operator-overridable tag map. Invalid entries are skipped, never fatal.
 *
 * "Invalid" includes an override that collides with a field the request already
 * emits: keeping the default is strictly better than corrupting the message, and the
 * skip is logged so the typo is discoverable instead of silent.
 */
export function getToolChoiceTags(env = process.env) {
  const raw = String(env.DEVIN_CONNECT_TOOL_CHOICE_TAGS ?? '').trim();
  if (!raw) return TOOL_CHOICE_DEFAULT_TAGS;
  const out = { ...TOOL_CHOICE_DEFAULT_TAGS };
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split('=').map((s) => s.trim());
    const n = Number.parseInt(v, 10);
    if (k !== 'choice' && k !== 'parallel') continue;
    if (!Number.isInteger(n) || n <= 0) continue;
    if (REQUEST_OCCUPIED_TAGS.has(n)) {
      log.warn(`DEVIN_CONNECT_TOOL_CHOICE_TAGS: ${k}=${n} collides with an existing request field; keeping default ${out[k]}`);
      continue;
    }
    // Both keys pointing at one tag is the same collision, one step removed.
    if (k === 'parallel' && n === out.choice) {
      log.warn(`DEVIN_CONNECT_TOOL_CHOICE_TAGS: parallel=${n} collides with choice; keeping default ${out.parallel}`);
      continue;
    }
    out[k] = n;
  }
  if (out.choice === out.parallel) {
    log.warn(`DEVIN_CONNECT_TOOL_CHOICE_TAGS: choice and parallel both ${out.choice}; reverting both to defaults`);
    return TOOL_CHOICE_DEFAULT_TAGS;
  }
  return Object.freeze(out);
}

/**
 * Normalize an OpenAI tool_choice into {optionName, toolName}, or null.
 *
 * Returns null for 'auto' as well as for absent input: 'auto' IS the upstream
 * default, so emitting it would add a field that changes nothing while widening the
 * unconfirmed surface. Only a non-default intent is worth sending.
 */
export function normalizeToolChoice(toolChoice) {
  if (toolChoice == null) return null;
  if (typeof toolChoice === 'string') {
    const v = toolChoice.trim().toLowerCase();
    if (v === 'none') return { optionName: 'none', toolName: null };
    // 'any' is Anthropic's spelling of OpenAI's 'required'; both mean "call ≥1".
    if (v === 'required' || v === 'any') return { optionName: 'required', toolName: null };
    return null; // 'auto' or anything unrecognized
  }
  const name = toolChoice?.function?.name ?? toolChoice?.name;
  if (typeof name === 'string' && name.trim()) {
    return { optionName: 'function', toolName: name.trim() };
  }
  return null;
}

/**
 * ChatToolChoice sub-message (#12 payload), or null when there is nothing to say.
 *
 * @param {string|object} toolChoice  the caller's OpenAI-shaped tool_choice
 * @param {object} [env]
 * @returns {Buffer|null}
 */
export function buildToolChoice(toolChoice, env = process.env) {
  if (!isToolChoicePassthroughEnabled(env)) return null;
  const norm = normalizeToolChoice(toolChoice);
  if (!norm) return null;
  // ChatToolChoice is `oneof choice { option_name = 1; tool_name = 2; }`
  // (exa.chat_pb). Emitting BOTH members is a schema violation — a conformant
  // decoder keeps only the last one, so a forced tool name and the "function"
  // option overwrote each other. Write exactly one: the name when the caller
  // forced a tool, otherwise the option keyword.
  const parts = norm.toolName
    ? [writeStringField(2, norm.toolName)]
    : [writeStringField(1, norm.optionName)];
  return Buffer.concat(parts);
}

// ─── Explicit prompt caching (#13) ──────────────────────────────────────────
//
// WHAT IS MEASURED (repo history, paid Teams account):
//   - A cache HIT costs ~17.8% of a miss (#220). The upside is real and large.
//   - Caching is per-ACCOUNT and matches on the prompt PREFIX, NOT on the session
//     id. Three independent measurements say so: the #220 read A/B (bc0fd13) and
//     the write A/B (2d1a6aa) both scored hits while this file emitted a FRESH
//     randomUUID as session id on every request (session continuity did not exist
//     on the connect path until b0f8330, a day later), and chat.js:2004 records the
//     three-account experiment — identical body on a second account is a WRITE, a
//     repeat on the first is a READ.
//   - So Claude-family selectors already get IMPLICIT caching, and the
//     sticky-session subsystem pins a caller to one account, which is the condition
//     that makes it work.
//
// WHAT IS NOT MEASURED: that field #13 is the tag for system_prompt_cache_options,
// or that requesting EPHEMERAL improves on what we get implicitly. #13 comes from
// third-party .proto reimplementations, i.e. DECLARATION ORDER — and prost allows
// tag gaps, so declaration order is not a wire tag. Same epistemic position as the
// billing tags above: we know where to look, not what is true.
//
// WHY THE gpt-6 FAMILY DEFAULTS ON (2026-10-23): the live matrix
// (evidence/ToolMatrixLive.md §cache) sent five identical gpt-6-luna-max requests.
// Every one reported fresh prompt=3, cache_write=3984, and ZERO cache reads — a
// write on every round, never a hit — while Claude served 6884 cached tokens on
// every warm round and Gemini 2031. So the implicit-caching argument above does
// NOT hold for this family as observed. Two explanations survive the data:
// (a) the upstream only serves GPT reads when asked (this hint is the only
// cache-control field the wire exposes), or (b) the usage map's read tag (5,
// calibrated on Claude) is wrong for GPT and the reads exist but are invisible.
// Defaulting the hint ON for this family makes the next live sample settle (a):
// reads appear → hint required; reads stay 0 with writes still counted → the next
// suspect is (b), the tag map, not the hint. The field carries a single enum and
// no prompt bytes, so the experiment is bounded and reversible.
//
// Defaults: UNSET → ON for the gpt-6 family only, OFF everywhere else (historical
// wire unchanged). "1" → ON for every family. Any other non-empty value
// ("0", "false", …) → OFF, preserving the exact-"1" opt-in rule for operators.
// Confirm the effect with DEVIN_CONNECT_BILLING_TAGS=cache_read_tokens=5 (already
// calibrated) showing a higher read share.
const PROMPT_CACHE_EPHEMERAL = 1;

// Selectors the catalog exposes for this family: gpt-6-luna-*, gpt-6-sol-*,
// gpt-6-astra-*, and the 6.1 sol variants. Dotted aliases are accepted too so a
// caller that passes the raw name (not the resolved selector) still matches.
const GPT6_CACHE_DEFAULT = /^(?:gpt-6|gpt6)(?:[.-]1)?-(?:luna|sol|astra)(?:-|$)/i;

/**
 * @param {object} [env]
 * @param {string} [model] resolved model selector; decides the family default
 */
export function isPromptCacheEnabled(env = process.env, model = '') {
  const raw = String(env.DEVIN_CONNECT_PROMPT_CACHE ?? '').trim();
  if (raw) return raw === '1';
  return GPT6_CACHE_DEFAULT.test(String(model || ''));
}

/**
 * SystemPromptCacheOptions sub-message, or null when the switch is off.
 *
 * Null (not an empty buffer) is what keeps the default wire byte-identical: the
 * caller spreads nothing rather than emitting a zero-length #13.
 *
 * @param {string} systemPrompt  the prompt the cache would key on
 * @param {object} [env]
 * @param {string} [model] resolved model selector; decides the family default
 * @returns {Buffer|null}
 */
export function buildSystemPromptCacheOptions(systemPrompt, env = process.env, model = '') {
  if (!isPromptCacheEnabled(env, model)) return null;
  // Nothing to cache: an absent or trivially short system prompt cannot pay for a
  // cache write. Upstream bills a write at roughly an order of magnitude more than
  // a read (chat.js:2004), so asking to cache a 20-byte prompt is a pure loss.
  // The floor is deliberately low — it excludes "no system prompt" and obvious
  // noise without second-guessing an operator who has a real prefix.
  if (typeof systemPrompt !== 'string' || systemPrompt.trim().length < 64) return null;
  return writeVarintField(1, PROMPT_CACHE_EPHEMERAL);
}

function buildCompletionConfig({ maxTokens, temperature, topK, topP, maxNewlines } = {}) {
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
    // Schema ground truth: #2 = max_tokens (caller's output cap), #3 = max_newlines.
    //
    // The default here is load-bearing in a way it was NOT before the tag fix. While
    // max_tokens sat on #3 (max_newlines) the value was a no-op, so DEFAULT_MAX_TOKENS
    // could be anything. Now #2 is the real cap and this default lands on the wire for
    // every caller that omits max_tokens — and two of them do: /v1/responses only sets
    // it when max_output_tokens is present (handlers/responses.js), and chat callers
    // that pass only temperature/top_p. Sending 4096 there would silently truncate
    // answers that used to complete, and — because resolveFinishReason compares
    // completion_tokens against the CALLER's cap, not the encoded one — the truncation
    // would be invisible on a defaulted call and mis-reported as 'length' on a call
    // that happened to ask for 4096.
    //
    // So the default is the repo-wide output convention (config.js MAX_TOKENS, and the
    // `|| 8192` fallbacks in handlers/messages.js and handlers/gemini.js), not the old
    // dead constant. DEFAULT_MAX_TOKENS stays 4096 for callers that read it directly.
    writeVarintField(2, maxTokens ?? WIRE_DEFAULT_MAX_TOKENS),
    // #3 = max_newlines: an explicit value wins, else the calibrated default.
    // A context window has no member in CompletionConfiguration and is never
    // written here.
    writeVarintField(3, maxNewlines ?? DEFAULT_MAX_NEWLINES),
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
export function buildGetChatMessageRequest({ token, messages, model, sessionId, completion, tools, nativeToolCall = false, deviceSeed, userJwt, toolChoice, parallelToolCalls, env = process.env, sessionModelConfig, continuityTrail } = {}) {
  if (!token) throw new Error('DEVIN_CONNECT: missing session token');
  if (!model) throw new Error('DEVIN_CONNECT: missing model selector');
  // P-03: refuse a file/document payload before any encoding. ChatMessage has
  // no attachment field, and messageText() would otherwise flatten the block
  // to '' and let the turn run without the document. This is the last-line
  // guard for direct builder callers; the HTTP handlers reject even earlier.
  const unsupportedFilePart = findFilePartInMessages(messages);
  if (unsupportedFilePart) throw unsupportedFilePartError(unsupportedFilePart);

  // Probe: gated replay of reasoning into tag #11 (or #9 for negative control).
  // Fact A3 (2026-08-03): upstream swe-1-7 accepts reasoning tags (#11, #9) without error
  // but does not consume them (0/3 effect). Kept as permanent gated RE probe tool.
  // Reference req022: genuine Bedrock/Claude client wire where #11 actually lives on assistant turns.
  const replayTag = String(env.DEVIN_CONNECT_REPLAY_REASONING || '').trim();
  const reasoningTagNum = replayTag === '1' ? 11 : (replayTag === '9' ? 9 : 0);

  // System turns normally ride the dedicated system_prompt field (#2). The
  // opt-in collapse mode moves them into the next source=USER message instead,
  // preserving message order while avoiding the stricter field-#2 policy path.
  const collapseSystem = String(env.DEVIN_CONNECT_COLLAPSE_SYSTEM || '').trim() === '1';
  const imageTag = getImageFieldTag(env);
  let systemPrompt = '';
  let continuityCollapsed = false;
  let pendingSystemParts = [];
  const chatMessages = [];

  // Images on an ASSISTANT turn never reach the model: role=2 #10 is accepted on
  // the wire but ignored upstream (measured 2026-10-21, issue #272 — the same
  // image on a user turn answers "Checkerboard", on an assistant turn the model
  // reports no image, on Anthropic and Gemini alike). Two paths therefore
  // DISCARD such images: the empty-turn filter below (image-only turn → dropped
  // whole) and the native tool-call branch (only #6 calls are encoded). Both call
  // this, because issue #272 is about the drop being SILENT, not about the drop.
  // The wire itself is unchanged: admitting an image-only turn would ship bytes
  // the upstream throws away.
  const noteDroppedAssistantImages = (msg) => {
    if (!imageTag) return 0;
    // Remote URLs count too: a direct builder caller can reach this branch with
    // one, and that drop must be named for the same reason (#272 is about the
    // silence, not the drop). streamChat resolves them first, so in production
    // this is the data-URL count.
    const inline = extractInlineImages(msg.content);
    const remote = Array.isArray(msg.content) ? msg.content.filter((b) => remoteImageUrl(b)).length : 0;
    const dropped = inline.length + remote;
    if (!dropped) return 0;
    bumpConnect('assistant_images_dropped', dropped);
    log.warn(`DEVIN_CONNECT: dropped ${dropped} inline image(s) from an assistant turn (#272) — the upstream ignores image fields on role=assistant, so they are not encoded; put the image on a user turn to have the model see it`);
    return dropped;
  };

  const consumeCollapsedSystem = (text = '') => {
    if (!collapseSystem) return text;
    if (!continuityCollapsed && continuityTrail) {
      pendingSystemParts.push(continuityTrail);
      continuityCollapsed = true;
    }
    if (!pendingSystemParts.length) return text;
    const wrapped = `<system>\n${pendingSystemParts.join('\n\n')}\n</system>`;
    pendingSystemParts = [];
    return text ? `${wrapped}\n${text}` : wrapped;
  };

  // Coalesce consecutive same-source text-only turns before wire encoding.
  // Clients that persist streamed output per-part (an agent that splits one
  // turn into several stored entries) emit runs of consecutive same-role
  // text messages — e.g. [assistant,assistant,assistant]. The upstream
  // request validator rejects a same-source run of length >= 3 with
  // invalid_argument ("an internal error occurred") — a run of 2 is
  // tolerated (verified by wire-shape comparison, PR #267 review): the
  // request decodes and begins processing, then the trailer fails. Merging
  // keeps the text identical while shrinking the run below the threshold.
  // Text-only guard: never merge entries carrying tool_calls/tool_call_id,
  // reasoning payloads, or non-text content parts (images) — those encode to
  // distinct wire types and must stay separate.
  const isMergeableText = (m) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return false;
    if (m.tool_calls?.length || m.tool_call_id) return false;
    if (m.reasoning || m.reasoning_content) return false;
    if (Array.isArray(m.content)) return m.content.every((c) => c?.type === 'text');
    return true;
  };
  const mergedMessages = [];
  for (const m of messages || []) {
    // Default: system turns hoist to field #2 and vanish from the chat
    // sequence, so look past them when judging same-source adjacency.
    // COLLAPSE_SYSTEM=1 keeps them in the sequence (wrapped into the next
    // user), so they break adjacency the same way a real turn does — looking
    // past them would merge the surrounding users and squeeze the system
    // out of its injection slot.
    let pi = mergedMessages.length - 1;
    while (pi >= 0 && mergedMessages[pi].role === 'system' && !collapseSystem) pi--;
    const prev = pi >= 0 ? mergedMessages[pi] : null;
    if (prev && prev.role === m.role && isMergeableText(prev) && isMergeableText(m)) {
      const a = messageText(prev.content);
      const b = messageText(m.content);
      // Fresh object, never mutate caller state — the same `messages` array is
      // re-passed on retry/failover and an in-place merge would double-append.
      mergedMessages[pi] = { ...prev, content: b ? (a ? `${a}\n\n${b}` : b) : a };
      continue;
    }
    mergedMessages.push(m);
  }

  // Name any remote image_url that reached the SYNC builder unresolved. In
  // production streamChat() has already turned those into data URLs
  // (inlineRemoteImages), so this fires only for a direct caller of this
  // function — and it fires instead of the old silent drop. Assistant turns are
  // excluded: their images are dropped on purpose and already reported by
  // noteDroppedAssistantImages (#272), so warning here too would double-report.
  if (imageTag) {
    for (const msg of mergedMessages) {
      if (msg.role === 'system' || msg.role === 'assistant') continue;
      for (const block of Array.isArray(msg.content) ? msg.content : []) {
        const url = remoteImageUrl(block);
        if (!url) continue;
        log.warn(`DEVIN_CONNECT: remote image_url (${imageUrlHost(url)}) reached the wire builder unresolved — the image is NOT sent; streamChat() inlines http(s) images, direct buildGetChatMessageRequest() callers must resolve them first`);
        bumpConnect('remote_image_unresolved');
      }
    }
  }

  for (const msg of mergedMessages) {
    if (msg.role === 'system') {
      const t = messageText(msg.content);
      if (collapseSystem) {
        if (t) pendingSystemParts.push(t);
        continue;
      }
      systemPrompt += systemPrompt ? `\n${t}` : t;
      continue;
    }
    // The Kimi workaround records 10/10 empty retries for empty assistant turns.
    // Preserve that exclusion unless enabled replay supplies a non-blank payload;
    // otherwise a disabled probe would reintroduce a text-empty wire frame.
    //
    // IMAGE-ONLY ASSISTANT TURNS (#272): messageText() reads `text` parts only, so
    // a turn whose whole payload is an inline image arrives here with empty text
    // and is dropped — BEFORE the `images:` extraction at the two encode sites
    // below, which is why the loss used to leave no trace anywhere.
    //
    // The drop itself is DELIBERATE and stays. Measured 2026-10-21 on a paid
    // account: the same image on a role=user turn answers "Checkerboard", while
    // on role=assistant the model reports no image (Anthropic and Gemini alike)
    // even though #10 arrives intact on the wire. Admitting the turn would ship
    // bytes the upstream discards and change the default wire for no capability.
    // What was actually wrong is the SILENCE — issue #272 is filed as "silently
    // dropped" — so the drop is named in the log and counted. If a future
    // upstream starts honouring assistant-role images, this is the single place
    // to change (plus test/wire-h1-empty-assistant.test.js T4 and mutation M5).
    if (msg.role === 'assistant' && messageText(msg.content).trim() === '' && !msg.tool_calls?.length
      && !(reasoningTagNum && String(msg.reasoning || msg.reasoning_content || '').trim())
      && !(msg.reasoning_signature && String(msg.reasoning_content || '').length > 0)) {
      noteDroppedAssistantImages(msg);
      continue;
    }
    const source = msg.role === 'assistant' ? SOURCE.ASSISTANT : SOURCE.USER;
    // Native multi-turn history (nativeToolCall): a prior assistant turn that
    // carried tool_calls, and a role:'tool' result, are encoded as STRUCTURED
    // wire messages (#6 ChatToolCall / role=4 tool_result #7) instead of being
    // folded into text — so the upstream sees a self-consistent native turn
    // history, symmetric with how we decode #6. Gated: only when nativeToolCall
    // is on (else the text-fold path below keeps the emulation wire unchanged).
    if (nativeToolCall && msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      // With enabled, non-empty replay, text plus k calls repeats reasoning k+1
      // times; without text, k times. This counts calls arriving here, not
      // the client's original batch: preprocessing may already have split it.
      // Keep first-truthy alias precedence. Concatenating equal aliases would
      // duplicate the payload, and changing precedence would rewrite history.
      // Unlike the fallback branch, native replay retains whitespace verbatim.
      const preText = messageText(msg.content);
      // Signed Claude thinking (messages.js, DEVIN_CONNECT_REPLAY_SIGNED_THINKING)
      // rides #11 thinking + #12 signature on EVERY role=2 frame of the turn — the
      // exact shape measured 2026-10-28 (verified upstream, recalled in the tool
      // loop). It wins over the REPLAY_REASONING probe so #11 is never doubled.
      const signedThinking = msg.reasoning_signature && msg.reasoning_content
        ? { text: String(msg.reasoning_content), signature: String(msg.reasoning_signature) }
        : null;
      const turnReasoningTag = signedThinking ? 11 : reasoningTagNum;
      const probeReasoningText = reasoningTagNum && (msg.reasoning || msg.reasoning_content) ? String(msg.reasoning || msg.reasoning_content) : '';
      const reasoningText = signedThinking ? signedThinking.text : probeReasoningText;
      // This branch encodes text and #6 tool calls only — no image slot exists —
      // so any image riding this turn is discarded. Say so (#272).
      noteDroppedAssistantImages(msg);
      if (preText) {
        const parts = [
          writeStringField(1, randomUUID()),
          writeVarintField(2, SOURCE.ASSISTANT),
          writeStringField(3, preText),
        ];
        if (reasoningText) parts.push(writeStringField(turnReasoningTag, reasoningText));
        if (signedThinking) parts.push(writeStringField(12, signedThinking.signature));
        chatMessages.push(Buffer.concat(parts));
      }
      for (const tc of msg.tool_calls) {
        const name = tc.function?.name || tc.name || 'unknown';
        const rawArgs = tc.function?.arguments ?? tc.arguments;
        const argsJson = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {});
        chatMessages.push(encodeAssistantToolCall({
          id: tc.id || randomUUID(),
          name,
          argsJson,
          reasoning: reasoningText,
          reasoningTagNum: turnReasoningTag,
          signature: signedThinking ? signedThinking.signature : '',
        }));
      }
      continue;
    }
    if (nativeToolCall && msg.role === 'tool' && msg.tool_call_id) {
      // role=4 tool_result carrying the result text, tied by #7 tool_call_id to
      // the preceding native #6 assistant tool_call (id echoed verbatim).
      chatMessages.push(encodeChatMessage({
        source: SOURCE.TOOL_RESULT,
        text: messageText(msg.content) || '[tool result]',
        images: imageTag ? extractInlineImages(msg.content) : [],
        imageTag,
        toolCallId: msg.tool_call_id,
        env,
      }));
      continue;
    }
    let text = messageText(msg.content);
    if (collapseSystem && msg.role === 'user') {
      text = consumeCollapsedSystem(text);
    }
    // Tool turns have no native slot here; fold them into user text so multi-turn
    // histories that carry tool results still flow through.
    if (msg.role === 'tool') {
      text = `[tool result${msg.tool_call_id ? ` for ${msg.tool_call_id}` : ''}]: ${text}`;
    }
    // Alias precedence matches native replay, but retain this branch's trim:
    // whitespace in the winning alias suppresses emission, not precedence.
    const reasoningText = source === SOURCE.ASSISTANT && reasoningTagNum
      ? String(msg.reasoning || msg.reasoning_content || '').trim()
      : '';
    // Signed Claude thinking on a plain assistant turn: #11 verbatim (never
    // trimmed, the signature seals the exact text) + #12, same as the tool-call
    // branch. Wins over the REPLAY_REASONING probe so #11 is never doubled.
    const signedThinking = source === SOURCE.ASSISTANT && msg.reasoning_signature && msg.reasoning_content
      ? { text: String(msg.reasoning_content), signature: String(msg.reasoning_signature) }
      : null;
    chatMessages.push(encodeChatMessage({
      source,
      text,
      images: imageTag ? extractInlineImages(msg.content) : [],
      imageTag,
      reasoning: signedThinking ? signedThinking.text : reasoningText,
      reasoningTagNum: signedThinking ? 11 : reasoningTagNum,
      signature: signedThinking ? signedThinking.signature : '',
      env,
    }));
  }

  if (collapseSystem && (pendingSystemParts.length || (!continuityCollapsed && continuityTrail))) {
    chatMessages.push(encodeChatMessage({
      source: SOURCE.USER,
      text: consumeCollapsedSystem(''),
      env,
    }));
  }

  // ★ EMPTY-SYSTEM + TOOLS GUARD (2026-07-10, verified from live devin.exe capture).
  // Devin's upstream rejects a Claude-family request that declares tools (#10
  // ToolDef) but carries an EMPTY/absent system prompt (#2) → "an internal error
  // occurred (trace ID ...)". Boundary nailed live: no-system + tools = ERR;
  // empty-string system + tools = ERR; a SINGLE character of system + tools = OK.
  // Real devin.exe always sends a ~20KB system, so it never hit this; a bare
  // API client (curl / a minimal agent) that sends tools without a system did.
  // gpt/swe-family tolerate an empty system; Claude-family does not. When we have
  // tool defs but no system text, inject a minimal benign system so the request is
  // well-formed. Harmless for models that don't need it (one short sentence).
  if (!systemPrompt && Array.isArray(tools) && tools.length > 0) {
    systemPrompt = 'You are a helpful assistant. Use the available tools when appropriate.';
  }
  // T1 reasoning continuity (Thinking-core): append the prior-analysis checkpoint
  // block to the system prompt — the only wire position where context rides without
  // becoming an assistant turn (self-reflection-loop anti-pattern). Byte-compatible:
  // tag #2 just gets longer; absent when the gate is off or the queue is empty.
  //
  // ORDERING vs identity-neutralize (cf. #219 preamble ordering): the neutralize
  // pass rewrites system-role message content in chat.js BEFORE this wire builder
  // runs; this trail is appended here, AFTER it — so the a4-a7 rules never see the
  // trail and the digest reaches the upstream verbatim. That is intentional: the
  // trail's whole purpose is letting the next turn see the prior reasoning as-is.
  if (!collapseSystem && continuityTrail) systemPrompt += continuityTrail;

  // #15 CortexTrajectoryReference — descriptor: exa.cortex_pb
  //   { trajectory_id=1, step_index=2, trajectory_type=3, step_type=4 }.
  // RE-CALIBRATED FROM THE FULL CAPTURE SET (not just req022): decoding all 9
  // GetChatMessage requests of one live session (9501aa2c) shows
  //   #15.1 = a STABLE per-session trajectory UUID (same across every turn),
  //   #15.2 = a MONOTONIC per-session turn counter (req009→022: 1,2,3,4,5,6,7,8),
  //   #15.3 = 4 (trajectory_type = CORTEX_TRAJECTORY_TYPE_CASCADE).
  // The CLI also sends #15.4 step_type = USER_INPUT (14); we omit it (the sibling
  // Go implementation sends it — see the Q7 field map).
  // Stateless default (fresh uuid, turn 1) matches turn-1 capture req009. Since
  // PR #226 the gateway CAN hold a stable session; when it does and the
  // DEVIN_CONNECT_MODEL_CONFIG_STABLE gate is on, chat.js passes the session's
  // {id, turn} via sessionModelConfig so #15 matches devin.exe's shape too.
  const trajectoryRefBuf = Buffer.concat([
    writeStringField(1, sessionModelConfig?.id || randomUUID()),
    writeVarintField(2, sessionModelConfig?.turn || 1),
    writeVarintField(3, 4),
  ]);

  // Null unless the switch resolves ON for this model (gpt-6 defaults on; every
  // other family needs DEVIN_CONNECT_PROMPT_CACHE=1) and the prompt is worth caching.
  const cacheOptionsBuf = buildSystemPromptCacheOptions(systemPrompt, env, model);
  // Both null unless DEVIN_CONNECT_TOOL_CHOICE=1. `disableParallel` is only emitted
  // when the caller explicitly said parallel_tool_calls:false — protobuf omits a
  // false bool anyway, so sending it for the default (true) would be a no-op field.
  const toolChoiceBuf = buildToolChoice(toolChoice, env);
  const toolChoiceTags = getToolChoiceTags(env);
  const disableParallel = isToolChoicePassthroughEnabled(env) && parallelToolCalls === false;

  const parts = [
    writeMessageField(1, buildClientMetadata(token, deviceSeed, userJwt)),
    writeStringField(2, systemPrompt),
  ];
  for (const cm of chatMessages) parts.push(writeMessageField(3, cm));
  parts.push(
    writeVarintField(7, 5),
    writeMessageField(8, buildCompletionConfig(completion)),
    // #11 disable_parallel_tool_calls / #12 tool_choice — opt-in, unconfirmed tags.
    ...(disableParallel ? [writeVarintField(toolChoiceTags.parallel, 1)] : []),
    ...(toolChoiceBuf ? [writeMessageField(toolChoiceTags.choice, toolChoiceBuf)] : []),
    // #13 system_prompt_cache_options — opt-in, see buildSystemPromptCacheOptions.
    ...(cacheOptionsBuf ? [writeMessageField(13, cacheOptionsBuf)] : []),
    writeMessageField(15, trajectoryRefBuf),
    // #16 = cascade_id (descriptor). The value is the cascade the CLI was
    // launched with, NOT a session id; the newer web schema adds `session_id`
    // at #28, which we do not emit.
    writeStringField(16, sessionId || randomUUID()),
    writeVarintField(20, 1),
    writeStringField(21, model),
    // #22 request_id — DELIBERATELY OMITTED. RE-CALIBRATED FROM THE FULL CAPTURE
    // SET: the verified turn-1 request (req009, which the real CLI chats fine)
    // carries NO #22. It only appears from turn 2 onward, where it reuses ONE id
    // across a user-turn's tool loop (turns 2-3 share it, 5-6 share, 7-8 share) —
    // i.e. it's a user-exchange id tied to conversation state, NOT a fresh
    // per-request uuid. The earlier "the real CLI always sends #22" reading came
    // from decoding only req022 (turn 8). Our gateway is stateless (turn-1 every
    // request), so emitting a random #22 matched neither the turn-1 (absent) nor
    // the turn-2+ (reused) wire. Match the verified turn-1 wire: send nothing.
  );
  // Native tool definitions (repeated #10) — only when the inner ToolDef tags are
  // calibrated (DEVIN_CONNECT_TOOL_DEF_TAGS). Default: tag map is null → nothing
  // emitted, tools keep flowing through prompt emulation upstream.
  const toolTags = getToolDefTags(env, { useDefault: nativeToolCall });
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
// mapFinishReason() below (descriptor-backed; 2 and 4 additionally live-anchored).

// Billing passthrough (GROUNDWORK, opt-in via DEVIN_CONNECT_BILLING_TAGS).
//
// The binary descriptor set (exa.api_server_pb.GetChatMessageResponse /
// exa.codeium_common_pb) pins the paid scalars: credit_cost=14,
// committed_credit_cost=18, committed_acu_cost=22 (double),
// committed_quota_cost_basis_points=26 and committed_overage_cost_cents=27.
// They could NOT be calibrated against a free account: a free tier isn't
// billed, the values are 0, and protobuf does not encode zero-valued scalars —
// so the fields are physically ABSENT from every free-account capture we have,
// and the paid frames seen so far carry no values either.
//
// So billing decode is configuration-driven, default-OFF: nothing is parsed
// until an operator points the map at the tags they want (the descriptor
// coordinates above are the verified starting point), and usage carries no
// billing keys (zero regression). The env var maps logical billing keys to the
// integer tag observed in the metadata sub-message:
//
//   DEVIN_CONNECT_BILLING_TAGS="credit_cost=6,committed_credit_cost=7,committed_acu_cost=8"
//
// All tags are read from the #7 metadata sub-message; readNumericProtoField
// handles the varint / fixed64 / fixed32 encodings.
//
// CONFIRMED 2026-07-23 (paid teams account, live A/B — issue #220): the cache-read
// counter is tag 5. Two requests sharing a long system prefix: round-1 (miss) meta
// dump = {2,3,6}, round-2 (hit) meta dump = {2,3,5,6} with tag5=3840 and tag2(fresh
// input)=436, and 436+3840 == 4276 == round-1's total prompt_tokens. Cross-checked
// against the response's labeled "Cached input tokens" fixed32 (== 3840.0). So
// `DEVIN_CONNECT_BILLING_TAGS=cache_read_tokens=5` is safe on any paid account and
// surfaces prompt_tokens_details.cached_tokens. This also settles #220: caching is
// billed correctly (hit cost measured at 17.8% of miss); the gap was purely that
// the dashboard couldn't SEE the cache split, not that credits were over-spent.
// credit_cost / committed_* now have descriptor-verified coordinates
// (14/18/22/26/27) but no observed values yet, so they stay out of the default map.
// CONFIRMED 2026-07-25 (same paid account): the cache-WRITE counter is tag 4.
// Claude-family selectors split prompt input the way Anthropic's own API does —
// fresh input in tag 2, cache-creation in tag 4 — so a cache-writing turn reported
// prompt_tokens=3 for a 13.4K-token system prompt (99.98% under-reported) because
// tag 4 was never decoded. Live A/B on claude-sonnet-4.6:
//   round-1 (cache write): {2:3, 3:4, 4:14361, 6:4}
//   round-2 (cache read):  {2:3, 3:4, 4:5, 5:14356, 6:4}
// and 14356 (read back) + 5 (the new user turn written) == 14361 (round-1 write),
// which pins tag 4 exactly. GPT-family selectors carry no tag 4 at all (their full
// input rides tag 2, matching OpenAI's no-charge-for-cache-write model), so the
// default is a no-op there rather than a mis-read.
//
// Both tags are calibration-confirmed, so they ship ON by default — otherwise
// prompt_tokens_details.cached_tokens / cache_creation_input_tokens are always 0
// and the dashboard silently mis-attributes cached and cache-written input (#220).
// Safe on free accounts too: the counters are zero there, and protobuf omits
// zero-valued scalars, so the tags are simply absent and nothing is decoded.
// Operators can override the whole map (or drop the defaults) via
// DEVIN_CONNECT_BILLING_TAGS; set it to `off` to decode nothing at all.
const DEFAULT_BILLING_TAGS = 'cache_read_tokens=5,cache_write_tokens=4';

// Billing scalars are not one protobuf wire type. Token counters are varints;
// paid ACU arrives as fixed64/double. Read all three numeric encodings so
// DEVIN_CONNECT_BILLING_TAGS=committed_acu_cost=^22 can see a real double.
// Default map does NOT include that tag — same class as IMAGE_TAG #4.
function readNumericProtoField(fields, tag) {
  for (const f of getAllFields(fields, tag)) {
    let value = null;
    if (f.wireType === 0) value = Number(f.value);
    else if (f.wireType === 1 && f.value.length === 8) value = f.value.readDoubleLE(0);
    else if (f.wireType === 5 && f.value.length === 4) value = f.value.readFloatLE(0);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function fixedWidthDumpEntry(f) {
  if (f.wireType === 1 && f.value.length === 8) {
    return { kind: 'fixed64', preview: f.value.readDoubleLE(0), raw: f.value.toString('hex') };
  }
  if (f.wireType === 5 && f.value.length === 4) {
    return { kind: 'fixed32', preview: f.value.readFloatLE(0), raw: f.value.toString('hex') };
  }
  return null;
}

function parseBillingTagMap(env = process.env) {
  const configured = String(env.DEVIN_CONNECT_BILLING_TAGS ?? '').trim();
  if (configured.toLowerCase() === 'off') return null;
  const raw = configured || DEFAULT_BILLING_TAGS;
  if (!raw) return null;
  const map = {};
  for (const pair of raw.split(',')) {
    const [key, tag] = pair.split('=').map((s) => s.trim());
    // `^N` reads tag N from the TOP level of the response instead of the #7
    // metadata sub-message, stored as -N so the decode path can tell them apart
    // without a second map. The four .proto reimplementations put credit_cost at
    // top-level #14 (committed_acu_cost #22, quota basis points #26, overage cents
    // #27), while every tag calibrated so far lived in #7 — so both locations have
    // to be expressible. Example, once a paid capture confirms it:
    //   DEVIN_CONNECT_BILLING_TAGS="cache_read_tokens=5,cache_write_tokens=4,credit_cost=^14"
    const topLevel = typeof tag === 'string' && tag.startsWith('^');
    const n0 = Number.parseInt(topLevel ? tag.slice(1) : tag, 10);
    const n = topLevel && Number.isInteger(n0) && n0 > 0 ? -n0 : n0;
    // Only the known billing keys, only nonzero integer tags (negative = top-level).
    // Silently skip garbage so a typo can't crash the hot decode path.
    if (key && Number.isInteger(n0) && n0 > 0 &&
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
// The response carries `delta_tool_calls` (repeated ChatToolCall). The
// descriptor (exa.codeium_common_pb.ChatToolCall) defines, with tags:
//   ChatToolCall {
//     id                   string (1) — OpenAI tool_calls[].id
//     name                 string (2) — OpenAI function.name
//     arguments_json       string (3) — the valid JSON args (OpenAI function.arguments)
//     invalid_json_str     string (4) — raw args the model emitted when NOT valid JSON
//     invalid_json_err     string (5) — parse-error description for invalid_json_str
//     is_custom_tool_call  bool   (6) — custom tool vs a built-in harness tool
//   }
//
// ★ The response ChatToolCall DOES carry the function name: `name = 2`, and the
// live CLI captures populate it (id + name on the first fragment, arguments_json
// on later frames). The earlier "the response item has no name" reading was
// wrong. decodeFrame still falls back to a caller-supplied reverse-lookup
// (opts.toolNames) when a frame omits it, unambiguous when exactly one tool was
// offered. If neither resolves, name is left undefined and the OpenAI builder
// defaults it to 'unknown' (devin-connect-openai.js:127) — shape intact.
//
// Every tag below is descriptor-verified and was independently pinned from
// static disasm of devin.exe (2026-07-04). Default OFF → tool calls keep coming
// from prompt emulation (parseToolCallsFromText), which works everywhere and
// remains the only production path.
//
// Tags PINNED from static disasm of devin.exe (2026-07-04, verified-from-binary):
//   DEVIN_CONNECT_TOOL_CALL_TAGS="outer=6,id=1,name=2,arguments_json=3,invalid_json_str=4,invalid_json_err=5,is_custom_tool_call=6"
// `outer` is the repeated delta_tool_calls tag on the top-level frame (#6, from the
// merge_field jump table); the rest are ChatToolCall subfields, read from prost
// encode_raw @0x1442fe1f0. Re-verify with scripts/re/proto_tags.py. Missing keys
// are simply not read. See .devin-connect-calibrated.env for the pinned values.
// VERIFIED tool_call decode tags (static-disasm pinned from encode_raw
// @0x1442fe1f0 + merge_field jump table). Fallback when nativeToolCall flag is
// on but no explicit env override is set.
export const DEFAULT_CALL_TAGS = Object.freeze({
  outer: 6, id: 1, name: 2, arguments_json: 3,
  invalid_json_str: 4, invalid_json_err: 5, is_custom_tool_call: 6,
});

export function parseToolCallTagMap(env = process.env, { useDefault = false } = {}) {
  const raw = String(env.DEVIN_CONNECT_TOOL_CALL_TAGS || '').trim();
  if (!raw) return useDefault ? { ...DEFAULT_CALL_TAGS } : null;
  const map = {};
  // All 7 subfield keys are verified-from-binary (encode_raw @0x1442fe1f0 + the
  // merge_field jump table). `name` is a real ChatToolCall field (#2), not a guess.
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

// Thinking-signature DECODE config (GROUNDWORK, opt-in). The descriptor pins the
// top-level fields: delta_signature = 10 (string, the encrypted-thinking payload
// increment), delta_signature_type = 21 (enum), thinking_id = 16 (string), and
// thinking_redacted = 11 (bool, not decoded). Free-tier captures never emit them.
// Default OFF: nothing is decoded until an operator opts in, and streamChat
// yields exactly as today (zero regression).
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
/** Coalesce a per-frame ChatToolCall fragment into the running accumulator.
 *
 * FRAME-VERIFIED 2026-07-05 (paid opus-4-8 native tool_call capture): a single
 * logical tool call is streamed across MULTIPLE frames — the first frame carries
 * {id, name}, then later frames carry ONLY an `arguments_json` fragment (#6.3)
 * with no id (`{"patter` → `n": "DEV` → `IN_CONNECT"}`). The naive "push every
 * decoded item" collapses one call into several broken half-calls and truncates
 * the JSON. So merge by id: a fragment carrying an id (distinct from the open
 * call) starts a new call; an id-less fragment appends its argument bytes to the
 * currently-open call. Concatenating the raw fragments reconstructs the full,
 * valid arguments JSON. (audit §4 P3 — per-frame non-coalescing.) */
export function mergeToolCallFragment(acc, tc) {
  const open = acc.length ? acc[acc.length - 1] : null;
  const startsNew = !open || (tc.id && tc.id !== open.id);
  if (startsNew) {
    acc.push({ ...tc, arguments: tc.arguments ?? '' });
    return;
  }
  if (tc.id && !open.id) open.id = tc.id;
  if (tc.name && !open.name) open.name = tc.name;
  if (tc.isCustom != null && open.isCustom == null) open.isCustom = tc.isCustom;
  if (tc.arguments) open.arguments = (open.arguments || '') + tc.arguments;
  if (tc.invalidJson) open.invalidJson = tc.invalidJson;
}

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
// How deep to recurse into nested sub-messages when dumping. The recurring #28
// "Response Statistics" trailer nests the real usage/billing counters one level
// down (#28.2), and #7.8 nests further — a flat one-level decode would only mark
// those "<msg Nb>". Depth-capped so a pathological / mis-parsed blob can't recurse
// unbounded; this is an opt-in (dumpMeta) diagnostic path only.
const SUB_DUMP_MAX_DEPTH = 4;

// Decode the inner fields of a protobuf sub-message into {tag: {kind, preview}}.
// A non-printable length-delimited field is itself likely a nested message: recurse
// (up to SUB_DUMP_MAX_DEPTH) and attach the decoded children under `.fields` while
// still recording the presence preview, so `#28.2`'s real counters surface in one
// capture. Returns the bucket, or null if the buffer isn't parseable protobuf.
function decodeInnerFields(buf, depth) {
  let inner;
  try { inner = parseFields(buf); }
  catch { return null; } // not protobuf → opaque (caller keeps the flat presence note)
  if (!inner.length) return null;
  const bucket = {};
  for (const sf of inner) {
    if (sf.wireType === 0) bucket[sf.field] = { kind: 'varint', preview: Number(sf.value) };
    else if (sf.wireType === 2) {
      const s = sf.value.toString('utf8');
      if (/^[\x20-\x7e]*$/.test(s) && s.length) bucket[sf.field] = { kind: 'string', preview: s.slice(0, 48) };
      else {
        const entry = { kind: 'message', preview: `<msg ${sf.value.length}b>` };
        // Retain the FULL raw bytes (hex) of every non-printable sub-message. The
        // 48-char preview above threw the tail away — that is exactly how #28.2's
        // 40-byte counter block was lost on the last capture. With the complete
        // hex here, a single text-only PAID capture is enough to reverse ALL inner
        // tags OFFLINE, collapsing "one PAID probe per field" into a single closed
        // loop. This path is only reached under dumpMeta (via decodeSubMessage), so
        // it stays a diagnostic-only cost with zero effect on production decoding.
        entry.raw = sf.value.toString('hex');
        if (depth < SUB_DUMP_MAX_DEPTH) {
          const nested = decodeInnerFields(sf.value, depth + 1);
          if (nested) entry.fields = nested; // one level deeper decoded
        }
        bucket[sf.field] = entry;
      }
    } else if (sf.wireType === 5) bucket[sf.field] = { kind: 'fixed32', preview: sf.value.toString('hex') };
    else if (sf.wireType === 1) bucket[sf.field] = { kind: 'fixed64', preview: sf.value.toString('hex') };
  }
  return Object.keys(bucket).length ? bucket : null;
}

function decodeSubMessage(f, into) {
  const bucket = decodeInnerFields(f.value, 1);
  if (bucket) into[f.field] = bucket;
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
  // Malformed / truncated upstream protobuf must never bubble out of here: this
  // runs inside the res.on('data') callback (devin-connect.js:1097), and a synchronous
  // throw there escapes the streamChat generator's try/finally and lands as an
  // uncaughtException → index.js process.exit(1), tearing down every concurrent
  // tenant's connection over one bad frame from the upstream / US-proxy. parseFields
  // throws on unknown wire types (3/4/6/7) and truncated varints/len-delims; treat any
  // such frame as an empty delta and skip it, matching the defensive contract already
  // applied on the parseTrajectorySteps hot path (audit FRAME-1).
  let fields;
  try { fields = parseFields(payload); }
  catch (err) {
    log.warn(`DEVIN_CONNECT: skipping malformed frame (parse failed): ${err.message}`);
    return { content: '', reasoning: '', finish: null, usage: null, billing: null };
  }
  const content = getField(fields, FIELD.CONTENT, 2);
  const reasoning = getField(fields, FIELD.REASONING, 2);
  const finish = getField(fields, FIELD.FINISH, 0);
  const meta = getField(fields, FIELD.META, 2);

  // actual_model_uid: the concrete model that served the turn (differs from the
  // requested selector for router models — adaptive/arena-*). FRAME-VERIFIED
  // 2026-07-05 (paid teams, opus-4-8): it rides the #7 metadata sub-message at
  // INNER tag 9 (#7.9 echoed "claude-opus-4-8-medium"), NOT a top-level field —
  // so it is decoded inside the `if (meta)` block below from `mf`. Opt-in via
  // DEVIN_CONNECT_ACTUAL_MODEL_TAG (calibrated value = 9). Off = null, no change.
  let actualModel = null;

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
  let topLevelDump = null;
  if (meta) {
    // Same defensive contract as the top-level parse: the #7 metadata sub-message
    // is length-delimited so its bounds are valid, but its CONTENTS can still be
    // malformed protobuf (unknown wire type / truncated varint). A throw here would
    // escape res.on('data') → uncaughtException just the same, so treat an
    // unparseable meta block as "no usage/billing" rather than crashing (audit FRAME-1).
    let mf;
    try { mf = parseFields(meta.value); }
    catch (err) { log.warn(`DEVIN_CONNECT: skipping malformed frame metadata: ${err.message}`); mf = []; }
    const prompt = getField(mf, 2, 0);
    const completion = getField(mf, 3, 0);
    // actual_model_uid at #7.9 (frame-verified) — read from the metadata block.
    if (opts.actualModelTag) {
      const am = getField(mf, opts.actualModelTag, 2);
      if (am) {
        const s = am.value.toString('utf8');
        if (/^[\x20-\x7e]+$/.test(s)) actualModel = s; // printable selector only
      }
    }
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
        // A NEGATIVE tag means "read this from the TOP level, not from #7".
        // Four independent .proto reimplementations put credit_cost at top-level
        // #14 (with committed_acu_cost #22 and the quota basis-point / overage-cent
        // pair at #26/#27), i.e. NOT in the #7 metadata sub-message where every
        // calibrated tag so far has lived. That is a coordinate, not a measurement:
        // these fields are still zero-and-therefore-absent on a free account, so the
        // .protos tell us WHERE to look while a paid capture is still what confirms
        // the value. Encoding the location as `credit_cost=^14` lets an operator
        // point at the top level without a second env var, and keeps the sub-message
        // default untouched for the tags that were measured there.
        if (tag < 0) continue; // handled in the top-level pass below
        const value = readNumericProtoField(mf, tag);
        if (value == null) continue;
        if (key === 'cache_read_tokens' || key === 'cache_write_tokens') {
          (usage ||= { prompt: prompt ? prompt.value : 0, completion: completion ? completion.value : 0 })[key] = value;
        } else {
          (billing ||= {})[key] = value;
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

  // Top-level billing pass. Runs OUTSIDE the `if (meta)` block on purpose: a
  // response can carry credit_cost at the top level with no #7 sub-message at all
  // (the sub-message holds token counts, and a billed turn is not obliged to
  // report them), so nesting this would silently skip exactly the frames it
  // exists for. Same varint-or-nothing rule as the sub-message pass.
  if (opts.billingTags) {
    for (const [key, tag] of Object.entries(opts.billingTags)) {
      if (tag >= 0) continue; // sub-message tags were handled above
      const value = readNumericProtoField(fields, -tag);
      if (value == null) continue;
      if (key === 'cache_read_tokens' || key === 'cache_write_tokens') {
        // Token counts stay usage, wherever they were read from. Routing them into
        // `billing` because of the location they were pinned at would move
        // prompt_tokens_details.cached_tokens out of usage and silently zero the
        // dashboard's cache split — the exact mis-attribution #220 was about.
        // prompt/completion live inside the `if (meta)` block above, so recompute
        // the usage defaults here rather than reference block-scoped locals.
        (usage ||= { prompt: Number(getField(fields, 2, 0)?.value ?? 0), completion: Number(getField(fields, 3, 0)?.value ?? 0) })[key] = value;
      } else {
        (billing ||= {})[key] = value;
      }
    }
  }
  // Calibration hook for the top level, mirroring dumpMeta for the sub-message.
  // The .protos name top-level #14/#22/#26/#27 but declaration order is not a wire
  // tag, so an operator still has to see a real paid frame to pin them. This prints
  // every top-level varint EXCEPT the ones already decoded by name, so the output
  // is a short list of candidates rather than a haystack.
  if (opts.dumpMeta) {
    topLevelDump = {};
    for (const f of fields) {
      if (f.wireType === 0 && f.field !== FIELD.FINISH) topLevelDump[f.field] = Number(f.value);
    }
  }

  const out = {
    content: content ? content.value.toString('utf8') : '',
    reasoning: reasoning ? reasoning.value.toString('utf8') : '',
    // wire-01: raw content/reasoning bytes for the streaming path. A multi-byte
    // UTF-8 char (Chinese / emoji) can be split across two frames; decoding each
    // frame in isolation with toString('utf8') turns the split char into U+FFFD
    // garbage. The streaming consumer feeds these Buffers through a StringDecoder
    // that holds an incomplete trailing sequence until the next frame completes
    // it. Non-streaming callers keep using the per-frame `content` string above
    // (a whole message in one frame decodes identically either way).
    contentBytes: content ? content.value : null,
    reasoningBytes: reasoning ? reasoning.value : null,
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
  if (topLevelDump) out.topLevelDump = topLevelDump;
  // Top-level frame calibration: when dumping, also surface every top-level
  // field so unknown tags like `actual_model_uid` (the concrete model that
  // served a router request) are discoverable. varints → numbers, short
  // length-delimited → utf8 preview; the rest noted by wire type.
  if (opts.dumpMeta) {
    const frameDump = {};
    const subDump = {};
    for (const f of fields) {
      if (f.wireType === 0) frameDump[f.field] = Number(f.value);
      else if (f.wireType === 1 || f.wireType === 5) {
        const entry = fixedWidthDumpEntry(f);
        if (entry) frameDump[f.field] = entry;
      }
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
/**
 * Parse a Go-duration reset window out of a rate-limit message into ms.
 * The backend renders retry-after with Go's time.Duration.String() — e.g.
 * "Resets in: 3h0m0s", "Resets in: 1m30s", "resets in 45s". Returns the total
 * milliseconds, or null when no parseable duration is present (caller then falls
 * back to its default cooldown). Bounded to a sane ceiling so a bogus huge value
 * can't cool an account down for days.
 */
export function parseResetDuration(text) {
  const m = /resets? in[:\s]+((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)/i.exec(String(text || ''));
  if (!m || !m[1]) return null;
  const dur = m[1];
  const h = /(\d+)h/.exec(dur);
  const min = /(\d+)m(?!s)/.exec(dur); // m not followed by s (avoid matching "ms")
  const s = /(\d+(?:\.\d+)?)s/.exec(dur);
  if (!h && !min && !s) return null;
  let ms = 0;
  if (h) ms += Number(h[1]) * 3600_000;
  if (min) ms += Number(min[1]) * 60_000;
  if (s) ms += Number(s[1]) * 1000;
  if (ms <= 0) return null;
  // Ceiling at 6h — the observed window is 3h; guard against a garbage value.
  return Math.min(ms, 6 * 3600_000);
}

// gRPC 4xx-class statuses that mean "the REQUEST itself is invalid" — the
// upstream request VALIDATOR refused these bytes. `invalid_argument` is measured
// for both an unsupported image (evidence/AccountMatrix.md §7.1) and a malformed
// tool history (#273.1: "There is an issue with this request, please try a
// different model."); `failed_precondition` is its sibling status. The quota-dry
// body also rides `failed_precondition`, which is why the narrower QUOTA_EXHAUSTED
// text arm runs BEFORE these codes are claimed.
//
// Permanent by construction: identical bytes fail identically on every retry, and
// nothing here is evidence about the account or its credential.
const REQUEST_REJECTION_CODES = new Set(['invalid_argument', 'failed_precondition']);
function isRequestRejectionCode(code) {
  return typeof code === 'string' && REQUEST_REJECTION_CODES.has(code);
}

/**
 * @param {string} text   raw body or trailer message
 * @param {string|null} code  upstream code if already known
 * @param {number|null} status  HTTP status if a non-200 was seen
 * @returns {{code: string, message: string, resetMs?: number}}
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
  // HARD per-model rate limit with an explicit reset window. Observed live
  // (paid teams, 2026-07-08): "Reached message rate limit for this model. Please
  // try again later. Resets in: 3h0m0s". This is a real account-scoped throttle
  // the backend hands back with a Go-duration retry-after — NOT the transient
  // "high demand" capacity blip below. It MUST be matched BEFORE the CAPACITY
  // branch, because that branch's `try again later` sub-pattern also matches this
  // text and would misclassify it as CAPACITY → which is RETRYABLE + a 60s
  // cooldown. Retrying into a 3h hard limit just amplifies load against an already
  // throttled account (exactly how a single-account pool self-inflicts an outage).
  // We surface it as RATE_LIMITED (non-retryable) and parse the reset window onto
  // resetMs so the handler can cool the account for the REAL duration.
  if (/(message |request )?rate limit(ed)?/i.test(lc) && /resets? in[:\s]/i.test(lc)) {
    const resetMs = parseResetDuration(lc);
    const out = { code: 'RATE_LIMITED', message: body || 'DEVIN_CONNECT: message rate limit reached' };
    if (resetMs != null) out.resetMs = resetMs;
    return out;
  }
  // rel-01: an EXPLICIT HTTP 429 (or gRPC resource_exhausted) is an authoritative
  // account-scoped rate-limit signal from the transport layer — it MUST win over
  // the text-based CAPACITY heuristic below. Otherwise a 429 whose body happens to
  // contain "try again later" / "capacity" / "overloaded" gets read as CAPACITY
  // (retryable + a short 60s cooldown), so the pool retries straight back into a
  // real rate limit, amplifying load and under-cooling the account. Classifying it
  // as RATE_LIMITED (non-retryable) lets the cross-account failover + cooldown do
  // their job. The hard "...Resets in: 3h" branch above already ran, so any
  // parseable reset window has been honored; a bare 429 falls here.
  if (status === 429 || code === 'resource_exhausted') {
    return { code: 'RATE_LIMITED', message: body || 'DEVIN_CONNECT: rate limited (HTTP 429)' };
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
  //
  // The TEXT alone is not the verdict: an explicit 4xx-class VALIDATOR code wins
  // over it. Measured 2026-10-25 (evidence/AccountMatrix.md §7.1), an image sent
  // to a model whose /v1/models row OMITS `supports_images` returned a 106-byte
  // trailer `{"error":{"code":"invalid_argument","message":"an internal error
  // occurred"}}` — the validator refusing these exact bytes, identical on every
  // retry. Claiming it here surfaced a permanent capability rejection as 503
  // UPSTREAM_INTERNAL and charged the internal-error breaker. See the
  // REQUEST_REJECTED arm at the end of this function.
  if (/internal error occurred/i.test(lc) && !isRequestRejectionCode(code)) {
    return { code: 'UPSTREAM_INTERNAL', message: body || 'DEVIN_CONNECT: upstream internal error' };
  }
  // CONTENT POLICY block (2026-07-10, live-confirmed). Upstream returns
  // `permission_denied` with "blocked by our content policy / remove sensitive or
  // unsafe content from your prompt" when the REQUEST CONTENT trips Devin's policy
  // (observed: a full Claude-Code system prompt with git status + security-flavored
  // commit messages). This is a PER-REQUEST content rejection, NOT an auth failure
  // — the session token is perfectly alive (a plain prompt on the same account
  // succeeds immediately after). It MUST be matched BEFORE the UNAUTHORIZED branch
  // below, because that branch's `permission_denied` pattern would otherwise read
  // it as a dead token → re-login storm + the account cooled/failed-over → a live
  // account wrongly benched and the client told "all accounts exhausted (dead
  // session tokens)" instead of the real "your content was blocked". Non-retryable
  // (retrying identical content just re-trips the policy) and NO account penalty.
  if (/blocked by (our |the )?content policy|remove (sensitive|unsafe) content|content[_ ]policy/i.test(lc)) {
    return { code: 'CONTENT_BLOCKED', message: body || 'DEVIN_CONNECT: request blocked by upstream content policy' };
  }

  // ── ACCOUNT-STATE / PERMANENT ────────────────────────────────────────────
  // Out-of-credit/quota is an ACCOUNT state (cool it down), checked before the
  // tier-wall pattern so "insufficient credit" never reads as a free-tier
  // /upgrade prompt. "entitlement" stays a tier wall (you lack the plan, not
  // the balance), matching the /upgrade semantics.
  //
  // `(quota|credit|usage|balance|allowance).*exhausted` is load-bearing and was
  // measured missing. The live body for a Pro account whose daily bucket is dry is
  //
  //   "Your daily usage quota has been exhausted. Visit
  //    https://app.devin.ai/settings/usage ... (trace ID: …)"
  //
  // carried on gRPC code `failed_precondition`. The old pattern only knew
  // `quota.*exceeded`, so that body matched NOTHING here, fell through to the
  // verbatim passthrough below, and came back as `failed_precondition`. That code
  // is (a) rendered as HTTP 502 `upstream_error` by connectErrorToHttp, (b) NOT in
  // isAccountFailoverError, so a dry account never failed over to a funded peer,
  // and (c) in TRANSPORT_FAULT_CODES, so every quota-dry call incremented the
  // internal-error breaker (2 hits → 120 s quarantine). One missing word turned a
  // routine per-account dry-well into a client-visible 502 plus a benched account.
  //
  // Also covers the on-demand shapes ("Your on-demand usage has been exhausted",
  // "on-demand balance exhausted") and the balance/allowance variants, all of
  // which are the same account state. Ordered after CAPACITY and CONTENT_BLOCKED
  // so those keep their narrower meanings.
  if (code === 'insufficient_quota'
      || /insufficient.*(credit|quota|balance|funds)/i.test(lc)
      || /out of (credit|quota|balance|funds)/i.test(lc)
      || /(credit|quota|balance|allowance|usage)[\s\w-]{0,40}?(exceeded|exhausted|depleted|used up)/i.test(lc)
      || /on.?demand[^.]{0,60}(exhausted|exceeded|depleted|out of|insufficient)/i.test(lc)
      || /run(?:ning)? out of (credit|quota|balance|funds|usage)/i.test(lc)) {
    return { code: 'QUOTA_EXHAUSTED', message: body || 'DEVIN_CONNECT: account out of credit/quota' };
  }
  // ── MODEL-LEVEL rejection scoped to (ACCOUNT, SELECTOR) ──────────────────
  // Measured body: "This model is no longer available for your account",
  // carried on gRPC `permission_denied` / HTTP 401. The session token is ALIVE
  // — the same account serves every other selector — so this must NOT reach
  // the UNAUTHORIZED arm below. Before this branch existed it did, and the
  // whole chain was wrong for it:
  //   (a) finalizeConnectAccount charged the account's error budget, so three
  //       requests for one retired selector flipped a perfectly healthy
  //       account to status='error' (persisted) — a pool-wide blackout for
  //       every OTHER model the account could still serve;
  //   (b) the same arm fired a re-login for a token that was never dead, and
  //       the handler's dead-token path ran requestReauthCheck, i.e. an
  //       account-scoped reauth verdict from a selector-scoped fact;
  //   (c) the request never failed over, because isAccountFailoverError only
  //       knew QUOTA_EXHAUSTED / RATE_LIMITED.
  // The honest scope is the PAIR: this canonical selector is no longer
  // entitled for THIS account, while the account stays healthy for the rest.
  // Checked BEFORE the /upgrade tier-wall arm so a per-account signal wins
  // over an inferred tier wall (a tier wall is shared by every account of a
  // tier; this one is not, so a peer may well serve it).
  //
  // NARROWED to the measured account-scoped wording. This arm used to also
  // accept plan/tier/subscription/workspace and the "not available" variant,
  // which reclassified an explicit tier wall ("… no longer available for your
  // plan. Please /upgrade …") as a per-account selector verdict. The two codes
  // route differently: MODEL_BLOCKED is excluded from failover on purpose
  // (every account of that tier hits the same wall), while
  // SELECTOR_NOT_ELIGIBLE hops and latches. Those nouns are not evidence
  // about ONE account; only "your account" is.
  if (/(?:this |the )?(?:model|selector)\b[^.]{0,60}?\bno longer available for your account\b/i.test(lc)) {
    return { code: 'SELECTOR_NOT_ELIGIBLE', message: body || 'DEVIN_CONNECT: model not available for this account' };
  }
  if (/\/upgrade|upgrade to access|insufficient.*entitlement|requires? .*(paid|pro|team|enterprise)/i.test(lc)) {
    return { code: 'MODEL_BLOCKED', message: body || 'model requires a paid Devin entitlement' };
  }
  // ── REQUEST VALIDATOR REJECTION (4xx-class) ─────────────────────────────
  // `invalid_argument` / `failed_precondition` that matched no narrower verdict:
  // the upstream refused the REQUEST, not the account. Measured shapes are the
  // §7.1 image frame handled above (its text arm is skipped when the code is in
  // this set) and #273.1's "There is an issue with this request, please try a
  // different model." Both are permanent — the same bytes fail identically on
  // every retry — yet they used to surface as 503 (UPSTREAM_INTERNAL) or 502
  // (verbatim passthrough), telling clients to retry something that can never
  // succeed.
  //
  // PRECEDENCE (P2-5): this arm MUST run before the HTTP 401/403 auth shell
  // below. The measured delivery mode for a validator verdict is a 401/403
  // shell (the §7.1 trailer), so the status arm used to claim it first: the
  // proxy charged account health and started a re-login for a token that was
  // never dead. An explicit 4xx-class code is evidence about the BYTES and is
  // strictly more specific than the HTTP status; a real auth failure carries
  // no such code (or `permission_denied`/`unauthenticated`, which are not in
  // this set) and still reaches the UNAUTHORIZED arm unchanged.
  //
  // 400 invalid_request_error with the upstream message PLUS the capability hint
  // the caller needs to act on: the §7.1 rows are exactly the models whose
  // /v1/models row omits `supports_images`. Keep the hint free of the internal
  // leak markers messages.js generalizes on (devin_connect / session token /
  // failover / ...), or an Anthropic client would receive the generic text.
  // NO account penalty (the token is alive) and NO in-process retry
  // (isRetryable excludes the code).
  if (isRequestRejectionCode(code)) {
    const detail = body || `upstream rejected the request (${code})`;
    return {
      code: 'REQUEST_REJECTED',
      message: `${detail} [upstream rejected the request as invalid (${code}): the selected model `
        + 'may not support this input — e.g. an image on a model whose /v1/models row omits '
        + 'supports_images — or the message/tool shape is unsupported. Check supports_images in '
        + 'GET /v1/models and retry with a capable model or request shape]',
    };
  }
  // `code === 'unauthenticated'` is claimed here alongside 'permission_denied'. The
  // body-text arm already caught the common shape, but a bare gRPC status with a
  // body that does not repeat the word fell through to the verbatim passthrough at
  // the end — where it reached the account-fault fallthrough in
  // finalizeConnectAccount and evicted the account WITHOUT the re-login attempt
  // that a retired session token needs. Same verdict, but now via the arm that
  // knows what to do about it.
  if (status === 401 || status === 403 || /permission_denied|unauthenticated|invalid.*token/i.test(lc)
      || code === 'permission_denied' || code === 'unauthenticated') {
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
//   - STREAM_TRUNCATED: the socket ended mid-stream without the mandatory
//     end-of-stream frame. Transport-level, indistinguishable from ECONNRESET in
//     cause, and a replay usually lands a complete answer. The stream path only
//     replays while nothing has been emitted, so a truncated turn that already
//     wrote bytes surfaces as an error instead.
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'TIMEOUT', 'unavailable', 'CAPACITY', 'STREAM_TRUNCATED']);

/** True when an error should be retried (vs surfaced immediately). */
export function isRetryable(err) {
  if (!err) return false;
  // UPSTREAM_INTERNAL is deliberately NON-retryable (observed persistent 3/3 —
  // same-token retry just amplifies load, #35). Short-circuit BEFORE the 5xx
  // status branch, which would otherwise re-admit it when the fault arrives as
  // a genuine 5xx rather than in a 401/403 shell (audit F4).
  //
  // REQUEST_REJECTED joins it for the same reason and one more: the rejection is
  // about the BYTES, so a replay is guaranteed to fail identically. The 5xx
  // status branch would otherwise re-admit it when the upstream wraps the
  // validator verdict in a 5xx shell (measured delivery mode for transient
  // faults), turning a permanent 400-class verdict into a retry storm.
  if (err.code === 'UPSTREAM_INTERNAL' || err.code === 'REQUEST_REJECTED') return false;
  if (err.code && RETRYABLE_CODES.has(err.code)) return true;
  // HTTP 5xx (except 501) are transient; 4xx are not.
  if (typeof err.status === 'number') return err.status >= 500 && err.status !== 501;
  return false;
}

/** Map the upstream finish enum to the OpenAI finish_reason vocabulary.
 *
 * `StopReason` is no longer inferred from variant names: the binary descriptor
 * set (exa.codeium_common_pb.StopReason, 0–13, Q7 audit) pins every integer,
 * and the independent Go decoder in devin-2api agrees on the non-trivial rows
 * (INCOMPLETE / MAX_TOKENS / PARTIAL → length, FUNCTION_CALL → tool_use,
 * ERROR → error).
 *
 *   0 UNSPECIFIED               → stop
 *   1 INCOMPLETE                → length
 *   2 STOP_PATTERN              → stop   (live-anchored free-tier stop)
 *   3 MAX_TOKENS                → length
 *   4 MIN_LOG_PROB              → stop   (live-anchored paid stop)
 *   5 MAX_NEWLINES              → length
 *   6 EXIT_SCOPE                → stop
 *   7 NONFINITE_LOGIT_OR_PROB   → stop
 *   8 FIRST_NON_WHITESPACE_LINE → stop
 *   9 PARTIAL                   → length
 *  10 FUNCTION_CALL             → tool_calls
 *  11 CONTENT_FILTER            → content_filter
 *  12 NON_INSERTION             → stop
 *  13 ERROR                     → error
 *
 * 2 and 4 keep their live anchors: a free-tier completion returned 2, and a
 * paid teams capture (2026-07-27) returned 4 on complete answers — neither
 * contradicts the descriptor (a min-logprob cutoff is still a finished turn).
 * 13 has no OpenAI vocabulary entry; 'error' matches the existing special-agent
 * stream-failure convention, and resolveFinishReason never upgrades it.
 *
 * An operator can override any integer from a real capture via
 * DEVIN_CONNECT_STOP_REASON_MAP (e.g. "3=stop,13=stop"). Values outside 0–13
 * fall back to 'stop' so a completed stream is never surfaced as an error, and
 * are logged once per distinct value.
 */
const STOP_REASON_DEFAULT = Object.freeze({
  0: 'stop',            // STOP_REASON_UNSPECIFIED
  1: 'length',          // INCOMPLETE
  2: 'stop',            // STOP_PATTERN (live-anchored clean stop)
  3: 'length',          // MAX_TOKENS
  4: 'stop',            // MIN_LOG_PROB (live-anchored paid clean stop)
  5: 'length',          // MAX_NEWLINES
  6: 'stop',            // EXIT_SCOPE
  7: 'stop',            // NONFINITE_LOGIT_OR_PROB
  8: 'stop',            // FIRST_NON_WHITESPACE_LINE
  9: 'length',          // PARTIAL
  10: 'tool_calls',     // FUNCTION_CALL
  11: 'content_filter', // CONTENT_FILTER
  12: 'stop',           // NON_INSERTION
  13: 'error',          // ERROR
});

// Unknown enum values are logged once each: a single mis-mapped turn should be
// visible in the log, but a server that repeats an out-of-range value must not
// turn one bug into a log flood. Capped so a hostile stream cannot grow the set.
const MAX_UNKNOWN_STOP_REASON_LOGS = 16;
const _unknownStopReasonsLogged = new Set();
function noteUnknownStopReason(n) {
  if (_unknownStopReasonsLogged.has(n) || _unknownStopReasonsLogged.size >= MAX_UNKNOWN_STOP_REASON_LOGS) return;
  _unknownStopReasonsLogged.add(n);
  log.warn(`devin-connect: unknown StopReason ${String(n)}; reporting finish_reason 'stop'`);
}

let _stopReasonMapCache = null;
let _stopReasonMapSrc = null;
// Which integers the OPERATOR explicitly pinned, as opposed to the ones that
// merely have a built-in default. resolveFinishReason needs this distinction: the
// default table already contains 0..6, so testing membership there would treat
// every value as "operator-calibrated" the moment ANY override is set.
let _stopReasonOverridesCache = null;
function stopReasonMapAndOverrides(env = process.env) {
  const raw = String(env.DEVIN_CONNECT_STOP_REASON_MAP || '').trim();
  if (raw === _stopReasonMapSrc && _stopReasonMapCache) {
    return { map: _stopReasonMapCache, overrides: _stopReasonOverridesCache };
  }
  _stopReasonMapSrc = raw;
  const map = { ...STOP_REASON_DEFAULT };
  const overrides = new Set();
  const allowed = new Set(['stop', 'length', 'tool_calls', 'content_filter']);
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split('=').map((s) => s.trim());
    const n = Number.parseInt(k, 10);
    if (Number.isInteger(n) && n >= 0 && allowed.has(v)) { map[n] = v; overrides.add(n); }
  }
  _stopReasonMapCache = map;
  _stopReasonOverridesCache = overrides;
  return { map, overrides };
}

function stopReasonMap(env = process.env) {
  return stopReasonMapAndOverrides(env).map;
}

/**
 * Normalize the upstream usage counters into the OpenAI-shaped object every
 * protocol route reads. Exported so it can be tested against the real
 * implementation rather than a copy — the earlier test mirrored this arithmetic
 * inline, which meant degrading the production path did not fail it.
 *
 * Connect semantics (O2, evidence/ClientSandboxes.md §5.3):
 *   prompt_tokens  = fresh + cache_read + cache_write  (the input the model processed)
 *   total_tokens   = prompt + completion               (identity holds by construction)
 *   prompt_tokens_details.cached_tokens = cache_read   (a SUBSET of prompt_tokens)
 *   cache_creation_input_tokens        = cache_write   (Anthropic sibling for relays)
 *   fresh_input_tokens                 = fresh         (explicit bucket; see below)
 *
 * Why cache_write is INSIDE prompt_tokens here while the Cascade path keeps it out
 * (#118): on a connect cache-write turn the upstream reports the prefix it just
 * processed on tag 4 and only the new tail on tag 2. Measured on claude-sonnet-4.6:
 * round-1 write=14361, round-2 read=14356 + fresh=5 — i.e. the write IS the same
 * input, not a generation-side extra. Excluding it made omp render "3 in" for an
 * 11.5k prompt on 2/7 turns, and those two turns were exactly the prefix-miss
 * (cache-write) requests. The Cascade split stays as #118 chose it, so consumers
 * must NOT re-derive fresh as `prompt - cached` on this shape: `fresh_input_tokens`
 * carries it explicitly (auth.js fullBillableTokens, messages.js, dashboard stats).
 *
 * `prompt_tokens_details` is emitted even when the upstream reported no cache read
 * (tag 5 is absent on a write turn). Omitting it made the breakdown vanish on
 * exactly the responses that needed explaining.
 *
 * Returns null for a missing usage block so callers can pass it straight through.
 */
export function normalizeConnectUsage(lastUsage) {
  if (!lastUsage) return null;
  const fresh = lastUsage.prompt || 0;
  const cacheRead = lastUsage.cache_read_tokens || 0;
  const cacheWrite = lastUsage.cache_write_tokens || 0;
  const completion = lastUsage.completion || 0;
  // cache_write is input on this path, so it is part of prompt_tokens and must not
  // be added to the total a second time. WINDSURFAPI_STRICT_USAGE_TOTAL is therefore
  // a no-op here — the OpenAI identity already holds (asserted in
  // test/strict-usage-total.test.js so a future re-split has to revisit it).
  const promptTokens = fresh + cacheRead + cacheWrite;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completion,
    total_tokens: promptTokens + completion,
    prompt_tokens_details: { cached_tokens: cacheRead },
    fresh_input_tokens: fresh,
    ...(lastUsage.cache_write_tokens != null
      ? { cache_creation_input_tokens: cacheWrite }
      : {}),
  };
}

export function mapFinishReason(finish, env = process.env) {
  if (finish == null) return null;
  const n = typeof finish === 'bigint' ? Number(finish) : finish;
  const map = stopReasonMap(env);
  // Unknown values → 'stop': a completed stream must never read as an error.
  // hasOwn keeps a non-numeric finish from resolving through Object.prototype.
  if (Object.hasOwn(map, n)) return map[n];
  noteUnknownStopReason(n);
  return 'stop';
}

/**
 * Apply the caller's output cap to a terminal finish reason.
 *
 * LIVE FINDING (evidence/ToolMatrixLive.md, flag 2): `gemini-3-6-flash-medium`
 * max_tokens does not bound thinking. Probes returned completion_tokens 105
 * under max_tokens:64 and 271 under 128 while the visible answer was a short
 * string — the upstream counts thinking inside completion_tokens but spends it
 * OUTSIDE the cap. The old check here used strict equality (`completion === cap`),
 * so every overrun sailed past it and the turn reported a clean 'stop': a budget
 * overrun indistinguishable from a complete answer. GPT overran the same way at
 * 16 (32 > 16), so the rule is model-agnostic, not Gemini-specific.
 *
 * `>=` is the honest test: the caller asked for at most `cap` output tokens and
 * the upstream produced at least that many. The equality half keeps the older,
 * narrower truncation signal.
 *
 * Why this reports instead of enforces: the only EXACT token count is the
 * upstream's, and it arrives on the terminal frame after every delta has been
 * delivered. The proxy has no tokenizer (chars/4 is an estimate), so cutting the
 * stream at the cap would drop delivered content mid-answer and could label a
 * complete answer truncated — the failure mode this same comment has warned
 * about since the paid stop-reason calibration. Reporting 'length' leaves the
 * answer intact and tells the client its budget was exceeded.
 *
 * Only a clean 'stop' can be upgraded: tool_calls / content_filter / error are
 * stronger statements about what the turn did. An explicit operator override in
 * resolveFinishReason still wins over this inference.
 *
 * @param {string} finishReason  already-mapped OpenAI finish_reason
 * @param {object|null} usage    normalized usage ({completion_tokens})
 * @param {number|null} maxTokens  output cap the caller requested, if any
 * @returns {string} the reason to report
 */
export function applyOutputCap(finishReason, usage, maxTokens) {
  if (finishReason !== 'stop') return finishReason;
  const cap = Number(maxTokens);
  const completion = Number(usage?.completion_tokens);
  if (Number.isFinite(cap) && cap > 0 && Number.isFinite(completion) && completion >= cap) {
    return 'length';
  }
  return finishReason;
}

/**
 * Resolve the OpenAI finish_reason for a completed connect turn.
 *
 * The descriptor now pins the enum (see STOP_REASON_DEFAULT), so MAX_TOKENS (3)
 * reports 'length' without inference. The usage check stays as a second line of
 * defense for the values the descriptor calls a clean stop (2/4): a turn that
 * reached or overran the caller's output budget is still truncated, and that
 * signal does not depend on the enum at all — it is the same test an OpenAI
 * client would apply itself. See applyOutputCap for why the comparison is `>=`
 * rather than equality (thinking is counted in completion_tokens but not bounded
 * by the cap on every tier).
 *
 * An explicit DEVIN_CONNECT_STOP_REASON_MAP override always wins: an operator who
 * HAS captured the real integers is a better authority than this inference.
 *
 * @param {number|bigint|null} finish  raw upstream enum (proto #5)
 * @param {object|null} usage         normalized usage ({completion_tokens})
 * @param {number|null} maxTokens     output cap the caller requested, if any
 */
export function resolveFinishReason(finish, usage, maxTokens, env = process.env) {
  const mapped = mapFinishReason(finish, env);
  // A calibrated override for THIS value takes precedence over the inference.
  //
  // It must consult the keys the operator actually PINNED, not the built-in table:
  // the defaults already cover 0..6, so an `Object.hasOwn(map, n)` test made any
  // single unrelated override (e.g. "7=length") read as "value 2 is calibrated" and
  // silently disabled the usage-based truncation inference for every real turn.
  const { overrides } = stopReasonMapAndOverrides(env);
  const key = typeof finish === 'bigint' ? Number(finish) : finish;
  if (finish != null && overrides.has(key)) return mapped;
  return applyOutputCap(mapped, usage, maxTokens);
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
  token, signal, timeoutMs, deadlineMs, host, env = process.env, nativeToolCall = false, traceId = null,
  deviceSeed, sessionModelConfig, continuityTrail, toolChoice, parallelToolCalls,
} = {}) {
  if (signal?.aborted) {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    err.code = 'ABORT_ERR';
    throw err;
  }
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
  const toolCallTags = parseToolCallTagMap(env, { useDefault: nativeToolCall });
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

  // Optional short-lived credential (#21). Awaited before the proto is built
  // because it travels INSIDE the message, not as a header. mintUserJwt never
  // throws and resolves null on every failure path, so enabling the switch cannot
  // turn an upstream JWT problem into a failed user request — it degrades to the
  // historical no-JWT wire. Minted against the DEFAULT host on purpose: the
  // per-account host override below is a default-off RE aid, and pointing the auth
  // service at an overridden host would mint against a different origin than the
  // one the .protos describe.
  const userJwt = isUserJwtEnabled(env)
    ? await mintUserJwt(sessionToken, { host: HOST, signal, deviceSeed })
    : undefined;
  // Remote (http/https) image_url blocks are fetched HERE, before the synchronous
  // wire builder, because extractInlineImages cannot fetch. Gated on the image
  // field being emitted at all: DEVIN_CONNECT_IMAGE_TAG=0 means images are off,
  // so spending network time on them would be pure waste. The returned array is
  // new only when something changed; the caller's messages are never mutated
  // (they are re-passed on retry/failover).
  const imageTag = getImageFieldTag(env);
  const wireMessages = imageTag
    ? await inlineRemoteImages(messages, { signal })
    : messages;
  const proto = buildGetChatMessageRequest({ token: sessionToken, messages: wireMessages, model, sessionId, completion, tools, nativeToolCall, deviceSeed, userJwt, env, sessionModelConfig, continuityTrail, toolChoice, parallelToolCalls });
  // Request envelope is sent UNCOMPRESSED (flag 0). The live calibration showed
  // the server rejects a gzipped request frame with an opaque "internal" error;
  // it still streams gzipped frames back, which the parser handles.
  const framed = wrapEnvelope(proto, { compress: false });

  // Wire capture (gated): dump the exact request protobuf (pre-envelope `proto`,
  // the clean bytes) for offline RE. No-op unless DEVIN_CONNECT_WIRE_DUMP=1.
  dumpWire('req', proto, { model, traceId, note: `model=${model} sessionId=${sessionId || ''} tools=${Array.isArray(tools) ? tools.length : 0} nativeToolCall=${nativeToolCall}` });

  // AUTH (critical): the header token is the session token doubled, dash-joined.
  const authHeader = `Basic ${sessionToken}-${sessionToken}`;

  // Host resolution. REVERTED (2026-07-08): the DEVIN_CONNECT_ACCOUNT_HOST
  // override was built on the hypothesis that a teams/self-serve token must send
  // GetChatMessage to its own apiServerUrl. Live capture DISPROVES this — the real
  // teams CLI sends GetChatMessage to server.codeium.com (captures/req-00N-
  // server.codeium.com-CHAT.bin, session 9501aa2c), the SAME host where our
  // GetCliModelConfigs / GetUserStatus already succeed. The 401 was never a host
  // problem. The override is kept behind its (default-off) flag purely so an
  // operator can still force a host during future RE, but it is NOT a fix and must
  // not be enabled in production — a wrong host will break chat. Default: HOST.
  let effectiveHost = HOST;
  if (host && String(env.DEVIN_CONNECT_ACCOUNT_HOST || '') === '1') {
    // Reject this Connect attempt explicitly; never send its token to an
    // unapproved origin or silently change account/backend policy here.
    effectiveHost = validatedAccountConnectHost(host);
  }

  // Bounded frame queue (GFReliability). `res.on('data')` decodes frames far
  // faster than a slow consumer drains them (a client applying backpressure
  // suspends the generator at `yield`), and this array used to be unbounded —
  // one stalled client could pin a whole upstream stream's decoded output in
  // memory. Cap by frames AND bytes: pause the socket at half the cap so TCP
  // carries the backpressure upstream, and fail the stream with QUEUE_OVERFLOW
  // if one chunk still crosses the cap (a single data event can carry thousands
  // of tiny frames, and pausing cannot interrupt the synchronous loop that is
  // already running). Below the pause threshold nothing changes — same events,
  // same order, no pause/resume.
  const maxQueueFrames = positiveIntEnv(env.DEVIN_CONNECT_MAX_QUEUE_FRAMES, 4096);
  const maxQueueBytes = positiveIntEnv(env.DEVIN_CONNECT_MAX_QUEUE_BYTES, 8 * 1024 * 1024);
  const pauseQueueFrames = Math.max(1, Math.ceil(maxQueueFrames / 2));
  const pauseQueueBytes = Math.max(1, Math.ceil(maxQueueBytes / 2));
  // Resume well below the pause point: resuming at the threshold itself would
  // let the producer refill to it immediately, cycling pause/resume once per
  // event. Half the pause point lets a real batch through per cycle.
  const resumeQueueFrames = Math.max(1, Math.floor(pauseQueueFrames / 2));
  const resumeQueueBytes = Math.max(1, Math.floor(pauseQueueBytes / 2));
  const queue = [];
  let queueBytes = 0;
  let queuePaused = false;
  let queueOverflowed = false;
  // Assigned by the response handler (it needs `res`); the consumer loop calls
  // it after every shift. A no-op until the response arrives.
  let noteQueueConsumed = () => {};
  let done = false;
  let streamError = null;
  let wake = null;
  // Did the upstream send its mandatory end-of-stream frame? Connect-RPC always
  // terminates a stream with one (carrying `{}` on success or an error trailer), so
  // a socket that just ends without it delivered a PARTIAL answer. Before this flag
  // that case was indistinguishable from a clean completion: the generator returned
  // normally with reason=null, mapFinishReason defaulted null→'stop', and the half
  // answer was reported as a finished turn — on /v1/responses closing the turn as
  // `response.completed` and entering the response store as the next turn's context.
  let sawEndOfStream = false;
  // Did ANY frame carry the terminal stopReason (#5)? The end-of-stream frame
  // proves the RPC completed; it says nothing about whether the TURN completed.
  // Live evidence (Q1 audit §3 S01, docs/upstream-protocol.md:106): every provider
  // observed so far (STOP_PATTERN / MIN_LOG_PROB / UNSPECIFIED) reports a value on
  // a clean finish, and "clean EOF with no stopReason IS truncation, not a normal
  // end" — their decoder raises a stream error instead of synthesizing end_turn.
  // Without this flag the two shapes were indistinguishable: lastFinish stayed
  // null, and null defaults to 'stop' at every consumer, so a truncated turn was
  // reported as a completed one.
  let sawStopReason = false;
  // Was any answer payload delivered? A stream that ends with nothing on it and no
  // stopReason is the EMPTY-turn shape (the adapter's empty/rescue retry owns it),
  // not a truncated answer — it must keep its null reason so that machinery is
  // untouched.
  let sawPayload = false;
  let lastFinish = null;
  let lastUsage = null;
  let lastBilling = null;
  let lastActualModel = null;
  let lastSignature = null;
  const nativeToolCalls = [];
  // wire-01: StringDecoder holds an incomplete trailing multi-byte UTF-8 sequence
  // between frames, so a Chinese char / emoji split across two frames decodes
  // whole instead of becoming U+FFFD on each half. One decoder per text stream.
  const contentDecoder = new StringDecoder('utf8');
  const reasoningDecoder = new StringDecoder('utf8');
  const pump = () => { if (wake) { const w = wake; wake = null; w(); } };

  const req = requestImpl({
    hostname: effectiveHost,
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
      // Bound the buffer. An error body is a diagnostic, not a payload: the
      // only thing downstream does with it is classifyUpstreamError, which
      // reads a code, a message and an optional reset window. Reading it
      // unbounded is an availability bug — see createBoundedBodyAccumulator
      // for the crash it causes and why the crossing chunk is sliced.
      const buffer = createBoundedBodyAccumulator();
      res.on('data', buffer.onData);
      res.on('end', () => {
        const { raw, truncated } = buffer.finish();
        const body = raw.toString('utf8') + (truncated ? ERROR_BODY_TRUNCATION_MARKER : '');
        if (truncated) {
          log.warn(`[devin-connect] upstream ${res.statusCode} error body exceeded ${MAX_ERROR_BODY_BYTES} bytes; truncated for classification`);
        }
        // Preserve the upstream Connect-RPC error code (audit F2): the trailer
        // path forwards parsed.error.code, but this non-200 path historically
        // dropped it (code=null), so an `unavailable`/`resource_exhausted`
        // delivered as a non-200 HTTP error lost the signal that classifies it
        // as transient. Best-effort JSON parse; falls back to body+status.
        let upstreamCode = null;
        try { upstreamCode = JSON.parse(body)?.error?.code || null; } catch { /* text body */ }
        // Preserve resetMs (audit F3): classifyUpstreamError parses an explicit
        // reset window (e.g. "Resets in: 3h0m0s" → resetMs) but this path used to
        // destructure only { code, message }, dropping it — so the handler cooled
        // the account for a generic burst window instead of the real 3h. Forward
        // it when present so finalizeConnectAccount can honor the true duration.
        const classified = classifyUpstreamError(body, upstreamCode, res.statusCode);
        streamError = Object.assign(new Error(classified.message), {
          code: classified.code,
          status: res.statusCode,
          ...(classified.resetMs != null ? { resetMs: classified.resetMs } : {}),
        });
        done = true;
        pump();
      });
      res.on('error', (err) => { streamError = err; done = true; pump(); });
      return;
    }
    const parser = new StreamingFrameParser();
    // Queue accounting. Text dominates the retained memory (UTF-16 chars) and
    // hex dumps are one char per wire byte; 96 bytes covers the event object
    // itself. Deliberately cheap — it runs once per pushed event, not per byte,
    // and the caps are safety bounds rather than an exact allocator.
    const eventBytes = (ev) => {
      let n = 96;
      if (typeof ev.text === 'string') n += ev.text.length * 2;
      // Reasoning signatures are opaque payloads of the same order as content,
      // but they ride in `reasoning_signature`, not `text`. Without this the
      // byte cap would charge them a flat 96 bytes and a thinking-heavy stream
      // could exceed the bound by maxQueueFrames × signature size.
      if (typeof ev.reasoning_signature === 'string') n += ev.reasoning_signature.length * 2;
      if (typeof ev.hex === 'string') n += ev.hex.length;
      return n;
    };
    const pushEvent = (ev) => {
      if (queueOverflowed) return;
      queue.push(ev);
      queueBytes += eventBytes(ev);
      if (queue.length > maxQueueFrames || queueBytes > maxQueueBytes) {
        // Hard cap. Drop what is buffered: the consumer has not seen these
        // events yet and the stream is failing anyway — retaining them would
        // defeat the bound this exists to enforce.
        queueOverflowed = true;
        queue.length = 0;
        queueBytes = 0;
        streamError = Object.assign(
          new Error(`DEVIN_CONNECT: frame queue exceeded ${maxQueueFrames} frames / ${maxQueueBytes} bytes (consumer too slow)`),
          { code: 'QUEUE_OVERFLOW' },
        );
        done = true;
        req.destroy();
        pump();
        return;
      }
      // High-water mark: stop reading the socket and let TCP carry the
      // backpressure upstream. A transport without pause() still gets the hard
      // cap above, so the bound holds either way.
      if (!queuePaused && typeof res.pause === 'function'
          && (queue.length >= pauseQueueFrames || queueBytes >= pauseQueueBytes)) {
        queuePaused = true;
        res.pause();
      }
    };
    noteQueueConsumed = (ev) => {
      queueBytes = Math.max(0, queueBytes - eventBytes(ev));
      if (queuePaused && !queueOverflowed
          && queue.length <= resumeQueueFrames && queueBytes <= resumeQueueBytes) {
        queuePaused = false;
        if (typeof res.resume === 'function') res.resume();
      }
    };
    const _wireCapture = String(process.env.DEVIN_CONNECT_WIRE_DUMP || '') === '1'
      || (String(process.env.WINDSURFAPI_TRACE || '') === '1' && !!traceId);
    const _wireResChunks = _wireCapture ? [] : null;
    res.on('data', (chunk) => {
      if (_wireResChunks) _wireResChunks.push(chunk);
      parser.push(chunk);
      let frames;
      try { frames = parser.drain(); }
      catch (err) { streamError = err; done = true; req.destroy(); pump(); return; }
      for (const frame of frames) {
        if (queueOverflowed) break;
        if (frame.isEndStream) {
          sawEndOfStream = true;
          // Trailer is JSON: {} on success, {"error":{...}} on failure.
          const text = frame.payload.toString('utf8').trim();
          // Calibration (DEBUG-gated, default OFF): surface the raw trailer bytes
          // so a probe can check whether usage/billing ever rides the trailer
          // rather than a frame. Pure additive; zero effect on production.
          if (env.DEVIN_CONNECT_DUMP_RAW === '1') {
            pushEvent({ type: 'raw-frame', endStream: true, hex: frame.payload.toString('hex'), text });
          }
          if (text && text !== '{}') {
            try {
              const parsed = JSON.parse(text);
              if (parsed?.error) {
                const classified = classifyUpstreamError(
                  parsed.error.message || text, parsed.error.code || null, null);
                streamError = Object.assign(new Error(classified.message), {
                  code: classified.code,
                  upstream: parsed.error,
                  ...(classified.resetMs != null ? { resetMs: classified.resetMs } : {}),
                });
              }
            } catch { /* non-JSON trailer — leave as success */ }
          }
          if (_wireResChunks) dumpWire('res', Buffer.concat(_wireResChunks), { model, traceId, note: `raw connect frames (gzip-as-sent), trailer=${text.slice(0, 200)}` });
          done = true;
          pump();
          return;
        }
        const { contentBytes, reasoningBytes, finish, usage, billing, metaDump, frameDump, subDump, actualModel, toolCalls, signature } = decodeFrame(frame.payload, { billingTags, dumpMeta, actualModelTag, toolCallTags, signatureTags, toolNames });
        // wire-01: decode across frame boundaries so split multi-byte chars survive.
        const content = contentBytes ? contentDecoder.write(contentBytes) : '';
        const reasoning = reasoningBytes ? reasoningDecoder.write(reasoningBytes) : '';
        // Calibration (DEBUG-gated, default OFF): emit the raw frame payload hex
        // so a probe can re-decode it WIDE — the production frameDump/metaDump
        // only collect wireType 0/2 and miss wt1(double)/wt5(float), which is
        // exactly where billing cost fields (likely doubles) would hide. Pure
        // additive; only under DEVIN_CONNECT_DUMP_RAW.
        if (env.DEVIN_CONNECT_DUMP_RAW === '1') {
          pushEvent({ type: 'raw-frame', endStream: false, hex: frame.payload.toString('hex') });
        }
        if (frameDump) log.info(`DEVIN_CONNECT frame dump (top-level tag=value): ${JSON.stringify(frameDump)}`);
        if (metaDump) log.info(`DEVIN_CONNECT meta dump (tag=value varints): ${JSON.stringify(metaDump)}`);
        if (subDump) log.info(`DEVIN_CONNECT sub-message dump (top-tag → inner tag=value): ${JSON.stringify(subDump)}`);
        // When dumping, also surface the raw dumps as a structured event so a
        // calibration consumer can aggregate tags without scraping logs. Pure
        // additive — only emitted under DEVIN_CONNECT_DEBUG_META.
        if (frameDump || metaDump || subDump) { pushEvent({ type: 'frame-dump', frameDump: frameDump || null, metaDump: metaDump || null, subDump: subDump || null }); }
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
          pushEvent({
            type: 'signature',
            reasoning_signature: signature.text,
            ...(signature.signatureType != null ? { signatureType: signature.signatureType } : {}),
            ...(signature.thinkingId != null ? { thinkingId: signature.thinkingId } : {}),
          });
        }
        if (reasoning) { pushEvent({ type: 'reasoning', text: reasoning }); }
        if (content) { pushEvent({ type: 'content', text: content }); }
        if (finish != null) { lastFinish = finish; sawStopReason = true; }
        if (content || reasoning || signature) sawPayload = true;
        if (usage) lastUsage = usage;
        if (billing) lastBilling = { ...lastBilling, ...billing };
        if (toolCalls) {
          for (const tc of toolCalls) mergeToolCallFragment(nativeToolCalls, tc);
          sawPayload = true;
        }
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
    // DEADLINE_EXCEEDED is deliberately DISTINCT from the idle 'TIMEOUT' above.
    // Idle timeout (120s of silence) is often a transient upstream stall worth a
    // same-token replay, so 'TIMEOUT' is in RETRYABLE_CODES. But this absolute
    // wall-clock deadline means the upstream has been hung for the full window
    // (600s) — a replay just runs another full idle+deadline cycle against the
    // SAME stuck upstream (≈2× wall-clock, ~1200s to finally error), almost
    // always failing again. Give it its own non-retryable code so the stream
    // replay gate (chat.js isConnectRetryable) surfaces it immediately instead
    // of doubling the user's wait. (external audit 2026-07-12, flaw 1)
    if (!streamError) streamError = Object.assign(new Error(`DEVIN_CONNECT: absolute deadline ${absoluteDeadlineMs}ms exceeded`), { code: 'DEADLINE_EXCEEDED' });
    done = true;
    pump();
  }, absoluteDeadlineMs);
  // The deadline timer stays OUT of the loop's ref set by default: it must never hold the
  // process open on its own (a caller that walks away from the iterator without closing it
  // would otherwise pin shutdown for up to absoluteDeadlineMs). The consumer wait below
  // re-refs it for exactly the window in which it is the only thing that can make progress.
  if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();

  req.write(framed);
  req.end();

  // Consumer loop: drain the queue, awaiting more data until the stream ends.
  try {
    while (true) {
      if (queue.length) {
        const ev = queue.shift();
        noteQueueConsumed(ev);
        yield ev;
        continue;
      }
      if (streamError) throw streamError;
      if (done) {
        // wire-01: flush any trailing bytes the decoders were holding (an
        // incomplete multi-byte sequence at the very end of the stream). Normally
        // empty — the upstream doesn't split the final char — but flushing keeps
        // the invariant that all received bytes are emitted.
        const tailContent = contentDecoder.end();
        const tailReasoning = reasoningDecoder.end();
        if (tailReasoning) { sawPayload = true; yield { type: 'reasoning', text: tailReasoning }; }
        if (tailContent) { sawPayload = true; yield { type: 'content', text: tailContent }; }
        // The socket ended without the mandatory end-of-stream frame: the answer is
        // TRUNCATED, not finished. Throwing here (rather than yielding a finish
        // event) is what keeps a partial answer out of every "completed turn"
        // pathway — the /v1/responses translator only commits to the response store
        // on a clean finish, the session-continuity pair-chain only commits on 'ok',
        // and the stream path can still replay while nothing was emitted. Raised
        // AFTER the tail flush so a caller that already streamed bytes to its client
        // has delivered everything the upstream actually sent.
        if (!sawEndOfStream) {
          throw Object.assign(
            new Error('DEVIN_CONNECT: upstream stream ended without an end-of-stream frame (truncated response)'),
            { code: 'STREAM_TRUNCATED' },
          );
        }
        // One terminal event carrying finish_reason + usage for the caller to
        // close out an OpenAI-shaped response.
        const finishUsage = normalizeConnectUsage(lastUsage);
        // G3 (Q1 audit §7): an end-of-stream frame with an ANSWER on it but NO
        // stopReason is a truncated turn, not a finished one (S01
        // docs/upstream-protocol.md:106: "缺 stopReason 的干净 EOF = 截断不是正常结束",
        // measured on a real incident where a coding agent marked the task complete
        // on a half answer). `lastFinish === null` therefore cannot be allowed to
        // reach a consumer as "no reason yet", because every consumer defaults a
        // null reason to 'stop' (devin-connect-openai.js: `if (ev.reason)`).
        //
        // Reported as the finish_reason 'error' — the vocabulary entry the enum's
        // own ERROR value (13) already uses — instead of throwing: the bytes are
        // already on the client's wire by this point, and the missing end-of-stream
        // frame above is the case that genuinely cannot be trusted at all. A stream
        // that delivered NOTHING and named no reason keeps its null reason: that is
        // the empty-turn shape the adapter's empty/rescue retry exists for.
        const unterminated = !sawStopReason && sawPayload;
        const terminalReason = unterminated
          ? 'error'
          : resolveFinishReason(lastFinish, finishUsage, completion?.maxTokens ?? WIRE_DEFAULT_MAX_TOKENS, env);
        yield {
          type: 'finish',
          // Truncation is inferred from completion_tokens hitting the cap that was
          // actually ENCODED, NOT from the un-calibrated enum — see resolveFinishReason.
          //
          // It must be the effective cap, not `completion?.maxTokens`: since the #2/#3
          // tag fix the wire carries WIRE_DEFAULT_MAX_TOKENS whenever the caller named
          // no cap, so reading the caller's (absent) value here would leave every
          // defaulted call's truncation undetectable — the stream would stop at the
          // wire cap and still report a clean 'stop'.
          reason: terminalReason,
          // Additive, and only for the shape above: a consumer that wants to tell
          // "the model errored" from "the upstream never said how the turn ended"
          // does not have to infer it from a missing enum.
          ...(unterminated ? { unterminated: true } : {}),
          // Normalized at the birth point, so all four protocol routes read one
          // object: prompt_tokens is the FULL input (fresh + cache_read +
          // cache_write), cached_tokens is its SUBSET detail, and total_tokens is
          // prompt + completion. Without this the connect path reported the
          // upstream's raw fresh-input figure as prompt_tokens, so on a cache-hit
          // turn it emitted cached_tokens=1765 alongside prompt_tokens=3 — a
          // superset field larger than the field it is a subset of — and on a
          // cache-WRITE turn it showed "3 in" for an 11.5k prompt (O2,
          // evidence/ClientSandboxes.md §5.3). Every relay in front of this proxy
          // (one-api / new-api and friends) meters from exactly these numbers.
          // Live-reproduced.
          usage: finishUsage,
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
      // While this wait is pending, the absolute deadline is the ONLY handle that can make
      // progress (the fake/hung upstream delivers no data, no error and no socket activity),
      // so it must be ref'd for the duration. Node 20/22 cancel a pending await the moment the
      // event loop drains — "Promise resolution is still pending but the event loop has
      // already resolved" — which turned a hung upstream into a cancelled test and, in
      // production, into a request the runtime silently gives up on. It is unref'd again as
      // soon as the wait settles, so it still never holds the process open (Node 24 behaviour
      // is unchanged: the timer fires at the same instant and the same code is thrown).
      await new Promise((resolve) => {
        wake = resolve;
        if (typeof deadlineTimer.ref === 'function') deadlineTimer.ref();
      });
      if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
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
  encodeAssistantToolCall, encodeChatMessage,
};
