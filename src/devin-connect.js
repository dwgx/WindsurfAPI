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
import { StringDecoder } from 'string_decoder';
import { randomUUID, randomBytes, createHmac } from 'crypto';
import * as _wireFs from 'fs';
import * as _wirePath from 'path';
import { log } from './config.js';
import { strictUsageTotal } from './runtime-config.js';
import {
  writeMessageField, writeStringField, writeVarintField, writeFixed64Field,
  parseFields, getField, getAllFields,
} from './proto.js';
import { wrapRequest, wrapEnvelope, StreamingFrameParser, connectHeaders, tryGunzip } from './connect.js';
// Observability counter only (mirrors devin-connect-openai.js importing
// recordArgRepair from cline-compat). cc-compat is a zero-I/O, zero-pipeline-
// import pure module, so this cannot create a cycle or perturb the wire path.
import { recordSchemaNormalized } from './handlers/cc-compat.js';

const HOST = 'server.codeium.com';
const PATH = '/exa.api_server_pb.ApiServerService/GetChatMessage';
// Short-lived user JWT. Four independent .proto reimplementations agree on the
// method and the response shape ({user_jwt=1, custom_api_server_url=2}); the
// credential is HS256 with roughly a 24-minute lifetime and rides the request as
// ClientMetadata #21. See mintUserJwt below for why this ships default-OFF.
const USER_JWT_PATH = '/exa.auth_pb.AuthService/GetUserJwt';
const METADATA_USER_JWT_FIELD = 21;

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
// values this path actually emits are listed. TOOL_RESULT (4) is VERIFIED-FROM-
// WIRE: the captured devin.exe request carries images on a role=4 message tied
// to a tool_call (see the vision block below).
const SOURCE = Object.freeze({ USER: 1, ASSISTANT: 2, TOOL_RESULT: 4 });

// CompletionConfig defaults, matched to the captured CLI request.
// #2 = max_tokens, #3 = max_newlines (schema-confirmed); see buildCompletionConfig.
const DEFAULT_CONTEXT_WINDOW = 128000;
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

/**
 * Flatten an OpenAI-style message content into plain text. Cloud GetChatMessage
 * takes a single string per ChatMessage; structured/tool content is degraded to
 * text the same way the legacy Raw path does (see windsurf.js).
 */
export function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c?.type === 'text').map(c => c.text).join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

// Image (vision) support — VERIFIED-FROM-WIRE 2026-07-06 (MITM capture of a real
// devin.exe GetChatMessage carrying an image, teams account).
//
// The `images` field lives NESTED inside each ChatMessage at TAG #10 (confirmed
// from the captured protobuf: ChatMessage {uuid #1, role #2, text #3,
// tool_call_id #7, images #10}). Each images entry is an ImageData sub-message
// { base64_data=1, mime_type=2 } — the SAME inner shape as the Cascade path
// (earlier RE guesses of 3,4 were wrong). In the captured turn the image rode a
// role=4 (tool_result) message tied to a `functions.read` tool_call, because the
// Devin CLI feeds images via a local read tool; a plain user-message image at
// #10 is the natural generalization.
//
// The VERIFIED tag is 10 — set DEVIN_CONNECT_IMAGE_TAG=10 to turn vision on.
// Kept OFF by default (unset → 0) to honor the project's env-gate discipline:
// enabling image emission for every request is a behavior change, and only a
// subset of models accept vision, so it stays opt-in with a now-known-correct
// value rather than flipping on implicitly.
export const VERIFIED_IMAGE_TAG = 10;
export function getImageFieldTag(env = process.env) {
  const raw = String(env.DEVIN_CONNECT_IMAGE_TAG || '').trim();
  if (!raw) return 0; // unset → images disabled (opt-in via DEVIN_CONNECT_IMAGE_TAG=10)
  const tag = Number.parseInt(raw, 10);
  return Number.isInteger(tag) && tag > 0 && tag < 536870912 ? tag : 0;
}

// Vision sub-gate: when vision is ON, whether to ALSO inject a synthetic `read`
// ToolDef at top-level #10. VERIFIED-FROM-WIRE (req022): the real devin.exe
// request ALWAYS declares `read` at the top-level #10 ToolDef list (23 tools,
// `read` among them) whenever an image rides a read tool_result — so the paired
// tool_call is never orphaned. Whether upstream *requires* the declaration is
// UNVERIFIED (needs a paid probe), so this defaults ON (the wire-faithful,
// lower-rejection-risk path). Flip DEVIN_CONNECT_IMAGE_TOOLDEF=0 to run the
// minimal no-ToolDef probe. MEANINGFUL ONLY when getImageFieldTag() != 0 — with
// vision off no restructure happens and this is never consulted, so the gate-off
// wire stays byte-identical. ← SWITCH POINT: if a paid fire proves the ToolDef is
// unnecessary, change the default to false.
export function getImageToolDefEnabled(env = process.env) {
  const raw = String(env.DEVIN_CONNECT_IMAGE_TOOLDEF ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'off' || raw === 'false'); // default ON
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

// ─── Vision send-side (gated) — VERIFIED-FROM-WIRE 2026-07-06 (req022) ───
//
// On the wire an image NEVER rides a plain user message. Each image rides a
// role=4 (SOURCE.TOOL_RESULT) ChatMessage { #1 uuid, #2 role=4, #3 "[Image N]",
// #7 tool_call_id, #10 ImageData } that is PAIRED to a preceding role=2 assistant
// ChatMessage carrying a #6 tool_call { #1 id, #2 name="read", #3 argsJSON } whose
// #6.1 id EXACTLY equals the tool_result's #7. (Independently decoded from
// req022 by three agents; the two image pairs matched by exact-string id, both
// name="read".) The old blind outer-tag sweep on user messages failed because
// this is a STRUCTURE requirement, not a tag one.
//
// The referenced tool ("read") is ALSO declared in the request's top-level #10
// ToolDef list on the wire (23 tools). We inject a synthetic `read` ToolDef so
// the tool_call is not orphaned — see getImageToolDefEnabled / the injection in
// buildGetChatMessageRequest.

// The synthetic `read` ToolDef reuses the native ToolDef tag layout, which is
// VERIFIED-FROM-WIRE at #10{name=1, description=2, parameters=3} (same as the
// live catalog and the calibrated DEVIN_CONNECT_TOOL_DEF_TAGS default).
const SYNTHETIC_READ_TOOLDEF_TAGS = Object.freeze({ outer: 10, name: 1, description: 2, parameters: 3, schema: 3 });

// `read` ToolDef — description + JSON schema copied VERBATIM from the req022
// top-level #10[13] entry (decoded from the capture bytes). `parameters` is an
// OBJECT, not a string: encodeToolDef JSON.stringify()s it, so a string here
// would double-encode.
const SYNTHETIC_READ_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'read',
    description: "Reads a file from the local filesystem. The file_path parameter must be an absolute path, not a relative path. By default, it reads up to 20000 characters starting from the beginning of the file. You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters. Any lines longer than 2000 characters will be truncated.",
    parameters: {
      required: ['file_path'],
      properties: {
        file_path: { description: 'The absolute path to the file to read.', type: 'string' },
        offset: { description: 'Optional line number to start reading from (1-based).', type: 'integer' },
        limit: { description: 'Optional number of lines to read.', type: 'integer' },
      },
      type: 'object',
      additionalProperties: false,
    },
  },
});

// Non-empty absolute path so the synthetic read args satisfy the schema's
// required:["file_path"] (an empty value risks schema-level rejection). The path
// is backfill to shape the tool_call args — it is never actually read.
const syntheticImagePath = (n) => `C:\\windsurfapi\\image_${n + 1}.png`;

// Encode a role=2 assistant ChatMessage carrying one #6 tool_call.
// VERIFIED-FROM-WIRE (req022 CM#4 #6): the request-side ToolCall is a PROTOBUF
// submessage { #1 id, #2 name, #3 argsJSON } — only #6.3 (args) is a JSON string.
// This CONTRADICTS the static-RE memory note "request-side ToolCall is
// serde-JSON": the ENVELOPE is protobuf, only the args VALUE is JSON. Wire wins.
// Symmetric with the response-side ChatToolCall #6{1:id,2:name,3:arguments}
// pinned in parseToolCallTagMap.
function encodeAssistantToolCall({ id, name, argsJson, reasoning, provider, reasoningTagNum = 11 }) {
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
  // #11 reasoning text (or custom tag, e.g. #9 for negative control RE probes) —
  // VERIFIED-FROM-WIRE (req022: every role=2 assistant turn carries #11, 59B–1470B).
  // Our default synthetic path omits it; a probe can inject one via
  // DEVIN_CONNECT_IMAGE_REASONING or DEVIN_CONNECT_REPLAY_REASONING.
  // Emitted only when a non-empty string is supplied so default wire stays byte-identical.
  // The tag-number guard is load-bearing even though callers currently pass reasoningText
  // only when reasoningTagNum is truthy: field 0 is RESERVED in protobuf and a zero tag
  // would serialize makeTag(0,2) — an invalid frame — so the encoder refuses it itself.
  if (reasoning && reasoningTagNum) parts.push(writeStringField(reasoningTagNum, reasoning));
  // #18 provider marker — VERIFIED-FROM-WIRE (req022 MSG14, the DRIVING turn:
  // #18="anthropic"). Only the final/driving assistant tool_use carried it
  // (MSG4 did not). Env-gated, default off. A synthetic #12 thinking SIGNATURE
  // is deliberately NOT emitted: it is server-signed and cannot be fabricated,
  // so provider without a valid signature is itself a paid probe.
  if (provider) parts.push(writeStringField(18, provider));
  return Buffer.concat(parts);
}

// Encode a role=4 tool_result ChatMessage bearing image(s). Field order matches
// req022 CM#5 exactly: #1 uuid, #2 role=4, #3 placeholder text, #7 tool_call_id,
// #10 ImageData — do NOT interleave #10 before #7. `toolCallId` is echoed
// VERBATIM (two id formats coexist on the wire — "functions.read:0" and
// "toolu_…" — so never normalize or regenerate it).
function encodeImageToolResult({ toolCallId, text, images, imageTag, env = process.env }) {
  const fields = [
    writeStringField(1, randomUUID()),
    writeVarintField(2, SOURCE.TOOL_RESULT),
    writeStringField(3, text || '[Image 1]'),
    writeStringField(7, toolCallId),
  ];
  for (const img of images) fields.push(writeMessageField(imageTag, encodeImageData(img, env)));
  return Buffer.concat(fields);
}

// Expand ONE OpenAI message carrying inline images into the wire-faithful
// ChatMessage sequence. VERIFIED-FROM-WIRE (req022): image → role=4 tool_result
// tied by #7 tool_call_id to a preceding role=2 assistant #6 read tool_call.
//
// Ordering: the caller's own text is emitted FIRST on its natural role, then per
// image a [role=2 read tool_call, role=4 tool_result] pair — matching the wire's
// causal order (question → read → image) and ending on a role=4 tool_result,
// which req022 proves is an acceptable final message (CM#15 is the last #3).
//
// A real OpenAI role:'tool' image message already has a genuine tool_call_id —
// echo it verbatim into both #6.1 and #7 and carry all its images in ONE
// tool_result. A user message has no id, so synth "functions.read:N" ids (that
// wire path carried NO #12 thinking-signature, so a minimal synthetic assistant
// message with only #6 stays faithful).
//
// ROOT CAUSE FOUND (2026-07-07, 2 paid fires + byte-diff): a SYNTHETIC image
// turn is REJECTED (UPSTREAM_INTERNAL) by extended-thinking models (opus-4-8),
// even with #11 reasoning + #18 provider + the real 19KB system prompt added.
// Byte-diff vs the real req-022 driving turn shows the ONLY remaining difference
// is #12 — a 324-byte server-issued thinking signature that the client CANNOT
// forge (it is minted server-side during a genuine Bedrock extended-thinking
// turn). So faking an assistant tool_use turn to smuggle an image does NOT work
// for thinking models. Do NOT fire more opus probes (they will reject).
// Possible unexplored paths: (a) a vision-capable model that does NOT use
// extended-thinking / needs no #12; (b) a real tool loop so the server signs #12
// itself; (c) document as a known limit. See memory vision-image-tag-state.
//
// @param {object}   msg     OpenAI-style { role, content, tool_call_id? }
// @param {Array}    images  pre-extracted [{ base64_data, mime_type }] (length ≥ 1)
// @param {object}   ctx     { imageTag, source, nextReadId, env }
// @returns {Buffer[]}       encoded ChatMessage buffers (length ≥ 1)
export function expandVisionMessage(msg, images, ctx) {
  const { imageTag, source, nextReadId, env = process.env } = ctx;
  const out = [];
  const text = messageText(msg.content);
  // Optional synthetic #11 reasoning / #18 provider on the read tool_call turn —
  // both default OFF (unset → byte-identical to the pre-probe wire). Populated
  // only for paid experiment fires that isolate the reasoning / provider
  // hypotheses. See getImageReasoning / getImageProvider.
  const reasoning = getImageReasoning(env);
  const provider = getImageProvider(env);

  if (msg.role === 'tool' && msg.tool_call_id) {
    // Real tool result: one tool_call genuinely happened. Reuse its opaque id
    // verbatim for both #6.1 and #7; carry every image in ONE tool_result.
    const id = msg.tool_call_id;
    out.push(encodeAssistantToolCall({ id, name: 'read', argsJson: JSON.stringify({ file_path: syntheticImagePath(0) }), reasoning, provider }));
    out.push(encodeImageToolResult({ toolCallId: id, text: text || '[Image 1]', images, imageTag, env }));
    return out;
  }

  // User/other message: caller text first (its own turn), then one read pair per
  // image — mirrors the wire's one-#10-per-tool_result shape.
  if (text) {
    out.push(Buffer.concat([
      writeStringField(1, randomUUID()),
      writeVarintField(2, source),
      writeStringField(3, text),
    ]));
  }
  images.forEach((img, i) => {
    const id = nextReadId();
    out.push(encodeAssistantToolCall({ id, name: 'read', argsJson: JSON.stringify({ file_path: syntheticImagePath(i) }), reasoning, provider }));
    out.push(encodeImageToolResult({ toolCallId: id, text: `[Image ${i + 1}]`, images: [img], imageTag, env }));
  });
  return out;
}

// Optional synthetic #11 reasoning text for the vision read tool_call turn.
// Default OFF (unset/empty → not emitted, wire byte-identical). A paid probe
// sets DEVIN_CONNECT_IMAGE_REASONING="..." to test whether the agent-loop
// requires the assistant turn to carry reasoning (req022 always did).
export function getImageReasoning(env = process.env) {
  const raw = env.DEVIN_CONNECT_IMAGE_REASONING;
  return typeof raw === 'string' && raw.trim() ? raw : '';
}

// Optional #18 provider marker (e.g. "anthropic"). Default OFF. In req022 only
// the DRIVING assistant turn (MSG14) carried #18 alongside a server-signed #12
// thinking signature we cannot fabricate; emitting #18 without a valid #12 is
// itself a paid probe, hence gated and off by default.
export function getImageProvider(env = process.env) {
  const raw = env.DEVIN_CONNECT_IMAGE_PROVIDER;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
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
//   - key=val:   "name=1,description=2,parameters=3[,strict=6][,outer=10]"
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
 * operator calibrated a `strict` tag AND the tool asked for it. custom_tool /
 * defer_loading are Devin-proprietary and never emitted (getToolDefTags rejects
 * their keys).
 */
// Normalize an OpenAI/MCP function-parameters JSON Schema into the minimal,
// well-formed shape upstream accepts. Real clients (OpenCode, MCP servers) emit
// schemas with missing/loose fields or proprietary keys ($schema, unevaluated
// keywords) that a strict upstream can reject (→ UPSTREAM_INTERNAL). Portable
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
  return stripSchemaDescriptions(out);
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

// ★ Strip `description` annotations from JSON Schema recursively, but preserve
// properties that happen to be NAMED "description" (a real parameter, e.g.
// Cursor's Task tool has a `description` property). Only schema-annotation
// `description` keys (siblings of `type`/`properties`/`required`) are removed.
// This neutralizes upstream's MCP-gate fingerprinting on parameter descriptions
// while keeping the full schema structure (types, required, enums, nested
// objects) intact for the model.
function stripSchemaDescriptions(value, inProperties = false) {
  if (Array.isArray(value)) return value.map((item) => stripSchemaDescriptions(item));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'description' && !inProperties) continue;
    out[key] = stripSchemaDescriptions(child, key === 'properties');
  }
  return out;
}

// ★ Tool-description length cap (2026-07-10, verified from live paid probes).
// SUPERSEDED (2026-07-13): the MCP-gate fix below (encodeToolDef replaces the
// top-level description with the tool name and stripSchemaDescriptions removes
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
// stripSchemaDescriptions in normalizeToolSchema). Schema structure (types,
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
 * @param {{host?: string, signal?: AbortSignal, now?: number}} [opts]
 * @returns {Promise<string|null>}
 */
export async function mintUserJwt(sessionToken, opts = {}) {
  if (!sessionToken) return null;
  const host = opts.host || HOST;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const key = `${sessionToken} ${host}`;

  const hit = _userJwtCache.get(key);
  if (hit && hit.expMs - USER_JWT_REFRESH_SKEW_MS > now) return hit.jwt;

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
      const raw = await postConnectUnary(host, USER_JWT_PATH, framed, sessionToken, opts.signal);
      if (!raw) return null;
      const jwt = getField(parseFields(raw), 1, 2)?.value?.toString('utf8')?.trim();
      if (!jwt) return null;
      if (epoch !== _userJwtEpoch) return null; // account changed under us
      const expMs = userJwtExpiryMs(jwt);
      // No readable exp → usable once, never cached. See userJwtExpiryMs.
      if (expMs) _userJwtCache.set(key, { jwt, expMs, epoch });
      return jwt;
    } catch (e) {
      log.debug(`GetUserJwt mint failed (degrading to the no-JWT wire): ${e.message}`);
      return null;
    } finally {
      _userJwtInflight.delete(key);
    }
  })();
  _userJwtInflight.set(key, task);
  return task;
}

/**
 * One unary Connect-RPC round trip → the response's single protobuf frame.
 *
 * Resolves null (never rejects) for any non-200 or malformed body: every caller
 * here treats failure as "carry on without the optional credential".
 */
function postConnectUnary(host, path, framed, sessionToken, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
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
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) return done(null);
          const body = Buffer.concat(chunks);
          // Connect envelope: [flags][len:4BE][payload]. A trailer-only response
          // (flag 0x02) carries no message and must not be parsed as one.
          if (body.length < 5) return done(null);
          const flags = body[0];
          const len = body.readUInt32BE(1);
          if (flags & 0x02) return done(null);
          const payload = body.subarray(5, 5 + len);
          done((flags & 0x01) ? tryGunzip(payload) : payload);
        });
        res.on('error', () => done(null));
      });
      req.on('error', () => done(null));
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
  const parts = [writeStringField(1, norm.optionName)];
  if (norm.toolName) parts.push(writeStringField(2, norm.toolName));
  return Buffer.concat(parts);
}

// ─── Explicit prompt caching (#13), opt-in ──────────────────────────────────
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
//   - So we already get IMPLICIT caching, and the sticky-session subsystem already
//     pins a caller to one account, which is the condition that makes it work.
//
// WHAT IS NOT MEASURED: that field #13 is the tag for system_prompt_cache_options,
// or that requesting EPHEMERAL improves on what we get implicitly. #13 comes from
// third-party .proto reimplementations, i.e. DECLARATION ORDER — and prost allows
// tag gaps, so declaration order is not a wire tag. Same epistemic position as the
// billing tags above: we know where to look, not what is true.
//
// Hence default-OFF (DEVIN_CONNECT_PROMPT_CACHE=1). Off → no #13 on the wire and
// the request is unchanged. An operator turns it on with a capture in hand, and can
// confirm the effect with DEVIN_CONNECT_BILLING_TAGS=cache_read_tokens=5 (already
// calibrated) showing a higher read share.
const PROMPT_CACHE_EPHEMERAL = 1;

export function isPromptCacheEnabled(env = process.env) {
  return String(env.DEVIN_CONNECT_PROMPT_CACHE ?? '').trim() === '1';
}

/**
 * SystemPromptCacheOptions sub-message, or null when the switch is off.
 *
 * Null (not an empty buffer) is what keeps the default wire byte-identical: the
 * caller spreads nothing rather than emitting a zero-length #13.
 *
 * @param {string} systemPrompt  the prompt the cache would key on
 * @param {object} [env]
 * @returns {Buffer|null}
 */
export function buildSystemPromptCacheOptions(systemPrompt, env = process.env) {
  if (!isPromptCacheEnabled(env)) return null;
  // Nothing to cache: an absent or trivially short system prompt cannot pay for a
  // cache write. Upstream bills a write at roughly an order of magnitude more than
  // a read (chat.js:2004), so asking to cache a 20-byte prompt is a pure loss.
  // The floor is deliberately low — it excludes "no system prompt" and obvious
  // noise without second-guessing an operator who has a real prefix.
  if (typeof systemPrompt !== 'string' || systemPrompt.trim().length < 64) return null;
  return writeVarintField(1, PROMPT_CACHE_EPHEMERAL);
}

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
    writeVarintField(3, contextWindow ?? DEFAULT_CONTEXT_WINDOW),
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

  // Probe: gated replay of reasoning into tag #11 (or #9 for negative control).
  // Fact A3 (2026-08-03): upstream swe-1-7 accepts reasoning tags (#11, #9) without error
  // but does not consume them (0/3 effect). Kept as permanent gated RE probe tool.
  // Reference req022: genuine Bedrock/Claude client wire where #11 actually lives on assistant turns.
  const replayTag = String(env.DEVIN_CONNECT_REPLAY_REASONING || '').trim();
  const reasoningTagNum = replayTag === '1' ? 11 : (replayTag === '9' ? 9 : 0);

  // System turns are concatenated into the dedicated system_prompt field (#2);
  // everything else becomes a repeated ChatMessage (#3).
  //
  // COLLAPSE-SYSTEM mode (DEVIN_CONNECT_COLLAPSE_SYSTEM=1): instead of sending
  // system content as field #2 (system_prompt), wrap it in <system> tags and
  // prepend to the next user message (source=1). This mirrors the devin-proxy
  // approach and bypasses the server-side content policy that scans field #2
  // more aggressively than user messages. The system_prompt field gets a minimal
  // placeholder so the empty-system + tools guard stays satisfied.
  const collapseSystem = String(env.DEVIN_CONNECT_COLLAPSE_SYSTEM || '').trim() === '1';
  const imageTag = getImageFieldTag();
  // Vision restructure only fires when the master gate is on AND a message
  // actually carries images (see the loop). injectReadToolDef gates the synthetic
  // top-level #10 `read` ToolDef; it is consulted ONLY when imageTag != 0, so the
  // gate-off wire is byte-identical to the pre-vision path.
  const injectReadToolDef = Boolean(imageTag) && getImageToolDefEnabled();
  let readCounter = 0;
  const nextReadId = () => `functions.read:${readCounter++}`; // mirrors wire "functions.read:0"
  let syntheticReadPairs = 0;
  let systemPrompt = '';
  let pendingSystemParts = [];
  const chatMessages = [];
  for (const msg of messages || []) {
    if (msg.role === 'system') {
      const t = messageText(msg.content);
      if (collapseSystem) {
        if (t) pendingSystemParts.push(t);
        continue;
      }
      systemPrompt += systemPrompt ? `\n${t}` : t;
      continue;
    }
    // Empty assistant turns are sent verbatim upstream and measurably provoke repeated
    // empty completions (kimi client retries failed 10/10 because of this).
    if (msg.role === 'assistant' && messageText(msg.content).trim() === '' && !msg.tool_calls?.length) {
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
      // Optional leading assistant text stays on its own role=2 text message.
      const preText = messageText(msg.content);
      const reasoningText = reasoningTagNum && (msg.reasoning || msg.reasoning_content) ? String(msg.reasoning || msg.reasoning_content) : '';
      if (preText) {
        const parts = [
          writeStringField(1, randomUUID()),
          writeVarintField(2, SOURCE.ASSISTANT),
          writeStringField(3, preText),
        ];
        if (reasoningText) parts.push(writeStringField(reasoningTagNum, reasoningText));
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
          reasoningTagNum,
        }));
      }
      continue;
    }
    if (nativeToolCall && msg.role === 'tool' && msg.tool_call_id) {
      // role=4 tool_result carrying the result text, tied by #7 tool_call_id to
      // the preceding native #6 assistant tool_call (id echoed verbatim).
      chatMessages.push(Buffer.concat([
        writeStringField(1, randomUUID()),
        writeVarintField(2, SOURCE.TOOL_RESULT),
        writeStringField(3, messageText(msg.content) || '[tool result]'),
        writeStringField(7, msg.tool_call_id),
      ]));
      continue;
    }
    // Vision (gated): a message carrying inline images is expanded to mirror the
    // wire — the image rides a role=4 tool_result paired to a role=2 read
    // tool_call, NOT the user message (req022). imageTag == 0 → this is skipped
    // and encoding falls through to the text-only path, byte-identical to before.
    if (imageTag) {
      const imgs = extractInlineImages(msg.content);
      if (imgs.length) {
        for (const cm of expandVisionMessage(msg, imgs, { imageTag, source, nextReadId, env: process.env })) {
          chatMessages.push(cm);
        }
        syntheticReadPairs += imgs.length;
        continue;
      }
    }
    let text = messageText(msg.content);
    // COLLAPSE-SYSTEM: prepend pending system parts to the next user/assistant message,
    // wrapped in <system> tags (mirrors devin-proxy's collapseSystemIntoUser).
    if (collapseSystem && pendingSystemParts.length > 0 && msg.role !== 'tool') {
      const sysWrap = `<system>\n${pendingSystemParts.join('\n\n')}\n</system>\n`;
      text = sysWrap + text;
      pendingSystemParts = [];
    }
    // Tool turns have no native slot here; fold them into user text so multi-turn
    // histories that carry tool results still flow through.
    if (msg.role === 'tool') {
      text = `[tool result${msg.tool_call_id ? ` for ${msg.tool_call_id}` : ''}]: ${text}`;
    }
    const msgParts = [
      writeStringField(1, randomUUID()),
      writeVarintField(2, source),
      writeStringField(3, text),
    ];
    if (source === SOURCE.ASSISTANT && reasoningTagNum) {
      const reasoningText = msg.reasoning || msg.reasoning_content;
      if (reasoningText && String(reasoningText).trim()) {
        msgParts.push(writeStringField(reasoningTagNum, String(reasoningText)));
      }
    }
    chatMessages.push(Buffer.concat(msgParts));
  }

  // COLLAPSE-SYSTEM: if there are trailing system parts with no following user message,
  // synthesize a user turn so they still reach the model (mirrors devin-proxy).
  if (collapseSystem && pendingSystemParts.length > 0) {
    const text = `<system>\n${pendingSystemParts.join('\n\n')}\n</system>`;
    chatMessages.push(Buffer.concat([
      writeStringField(1, randomUUID()),
      writeVarintField(2, SOURCE.USER),
      writeStringField(3, text),
    ]));
    pendingSystemParts = [];
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
  if (continuityTrail) systemPrompt += continuityTrail;

  // ModelConfig #15. RE-CALIBRATED FROM THE FULL CAPTURE SET (not just req022):
  // decoding all 9 GetChatMessage requests of one live session (9501aa2c) shows
  //   #15.1 = a STABLE per-session config UUID (same across every turn),
  //   #15.2 = a MONOTONIC per-session turn counter (req009→022: 1,2,3,4,5,6,7,8),
  //   #15.3 = 4 (constant).
  // Stateless default (fresh uuid, turn 1) matches turn-1 capture req009. Since
  // PR #226 the gateway CAN hold a stable session (#16); when it does and the
  // DEVIN_CONNECT_MODEL_CONFIG_STABLE gate is on, chat.js passes the session's
  // {id, turn} via sessionModelConfig so #15 matches devin.exe's shape too.
  const modelConfigBuf = Buffer.concat([
    writeStringField(1, sessionModelConfig?.id || randomUUID()),
    writeVarintField(2, sessionModelConfig?.turn || 1),
    writeVarintField(3, 4),
  ]);

  // Null unless DEVIN_CONNECT_PROMPT_CACHE=1 and the prompt is worth caching.
  const cacheOptionsBuf = buildSystemPromptCacheOptions(systemPrompt, env);
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
    writeMessageField(15, modelConfigBuf),
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
  const toolTags = getToolDefTags(process.env, { useDefault: nativeToolCall });
  let emittedReadToolDef = false;
  if (toolTags && Array.isArray(tools)) {
    for (const tool of tools) {
      if (tool?.type !== 'function' || !tool.function?.name) continue;
      if (tool.function.name === 'read') emittedReadToolDef = true;
      parts.push(writeMessageField(toolTags.outer, encodeToolDef(tool, toolTags)));
    }
  }
  // Synthetic `read` ToolDef for vision — INDEPENDENT of the default-off native
  // tool-def gate (getToolDefTags), which would silently no-op under the vision
  // gate. VERIFIED-FROM-WIRE (req022): the real client always declares `read` at
  // top-level #10 when an image rides a read tool_result. Emitted only when image
  // pairs were produced and `read` wasn't already declared by the native path.
  // Protobuf field order is not load-bearing for decode, so appending #10 here
  // (after #21, consistent with the native tool-def placement) is safe even
  // though the wire has #10 before #15. ← SWITCH POINT: drop if a paid fire proves
  // the ToolDef is not required (also see getImageToolDefEnabled default).
  if (injectReadToolDef && syntheticReadPairs > 0 && !emittedReadToolDef) {
    parts.push(writeMessageField(SYNTHETIC_READ_TOOLDEF_TAGS.outer, encodeToolDef(SYNTHETIC_READ_TOOL, SYNTHETIC_READ_TOOLDEF_TAGS)));
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
// credit_cost / committed_* remain declaration-order-only and still need their own
// paid calibration run.
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
// The response carries `delta_tool_calls` (repeated ChatToolCall). Per the
// reverse-engineering (NW1: docs-internal/workflow-results/native-tool-wire/NATIVE-WIRE-FIELDS.md
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

  // Top-level billing pass. Runs OUTSIDE the `if (meta)` block on purpose: a
  // response can carry credit_cost at the top level with no #7 sub-message at all
  // (the sub-message holds token counts, and a billed turn is not obliged to
  // report them), so nesting this would silently skip exactly the frames it
  // exists for. Same varint-or-nothing rule as the sub-message pass.
  if (opts.billingTags) {
    for (const [key, tag] of Object.entries(opts.billingTags)) {
      if (tag >= 0) continue; // sub-message tags were handled above
      const f = getField(fields, -tag, 0);
      if (f == null) continue;
      if (key === 'cache_read_tokens' || key === 'cache_write_tokens') {
        // Token counts stay usage, wherever they were read from. Routing them into
        // `billing` because of the location they were pinned at would move
        // prompt_tokens_details.cached_tokens out of usage and silently zero the
        // dashboard's cache split — the exact mis-attribution #220 was about.
        // prompt/completion live inside the `if (meta)` block above, so recompute
        // the usage defaults here rather than reference block-scoped locals.
        (usage ||= { prompt: Number(getField(fields, 2, 0)?.value ?? 0), completion: Number(getField(fields, 3, 0)?.value ?? 0) })[key] = Number(f.value);
      } else {
        (billing ||= {})[key] = Number(f.value);
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
  if (/internal error occurred/i.test(lc)) {
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
  if (/insufficient.*(credit|quota|balance|funds)|out of (credit|quota)|quota.*exceeded|credit.*exhausted/i.test(lc)) {
    return { code: 'QUOTA_EXHAUSTED', message: body || 'DEVIN_CONNECT: account out of credit/quota' };
  }
  if (/\/upgrade|upgrade to access|insufficient.*entitlement|requires? .*(paid|pro|team|enterprise)/i.test(lc)) {
    return { code: 'MODEL_BLOCKED', message: body || 'model requires a paid Devin entitlement' };
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
  // 3 WAS 'length' on the strength of the variant NAME order alone. That guess is
  // now retired, for the same reason the 4→'length' guess had to be: an integer
  // guessed wrong makes every COMPLETE response read as truncated, and on
  // /v1/responses a 'length' closes the turn as `response.incomplete`, which is a
  // whole-turn hard failure for Codex-style clients. 4 proved the guess wrong once
  // already (paid capture, §8.7). Truncation is not something to infer from an
  // uncalibrated enum: real truncation is corroborated by completion_tokens
  // reaching the requested cap, which resolveFinishReason checks from the usage
  // block, so nothing is lost by defaulting to a clean stop here.
  3: 'stop',        // was max_tokens→'length' (name-order guess, retired)
  // 4 = LIVE-ANCHORED normal completion on a PAID (teams) account, calibrated
  // 2026-07-27 — §8.7 had been waiting for exactly this capture. Three probes on
  // claude-sonnet-4.6 with max_tokens 300 / 8 / 40 all returned 4, and the
  // max_tokens=300 one answered "HI" (2 chars — unambiguously complete), so 4 is
  // the paid tier's clean stop, not a turn-limit. It was guessed as
  // max_turn_requests→'length' from the variant NAME order, which made EVERY
  // complete paid response read as truncated: finish_reason='length' on
  // /v1/chat/completions and status='incomplete' on /v1/responses. Clients that
  // auto-continue on a length finish would loop on complete answers.
  // Override with DEVIN_CONNECT_STOP_REASON_MAP if a future capture disagrees.
  4: 'stop',        // normal completion (paid); was max_turn_requests guess
  // 5 WAS 'content_filter' from the same name-order guess, and it is the most
  // damaging one to get wrong: content_filter also closes /v1/responses as
  // `response.incomplete`, AND the messages route maps it to Anthropic
  // `stop_reason:'refusal'` — so a normal completion would be reported to the
  // client as the model refusing. A real refusal is visible in the answer text;
  // a fabricated one is not recoverable by the client.
  5: 'stop',        // was refusal→'content_filter' (name-order guess, retired)
  6: 'stop',        // cancelled
});

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
 * Same semantics the Cascade path settled on (#118):
 *   prompt_tokens  = fresh input + cache_read   (cached_tokens is a SUBSET detail)
 *   total_tokens   = prompt + completion + cache_write  (full billable cost)
 *   cache_write stays OUT of prompt_tokens — it is generation-side and ships on
 *   cache_creation_input_tokens.
 *
 * Returns null for a missing usage block so callers can pass it straight through.
 */
export function normalizeConnectUsage(lastUsage) {
  if (!lastUsage) return null;
  const fresh = lastUsage.prompt || 0;
  const cacheRead = lastUsage.cache_read_tokens || 0;
  const cacheWrite = lastUsage.cache_write_tokens || 0;
  const completion = lastUsage.completion || 0;
  const promptTokens = fresh + cacheRead;
  // WINDSURFAPI_STRICT_USAGE_TOTAL=1 restores OpenAI's arithmetic identity
  // (total == prompt + completion) for clients that validate it. Off by default: the
  // identity break is cosmetic for nearly every consumer, whereas dropping cache_write
  // from the total under-reports real spend, so spec-strictness is the opt-in.
  //
  // IMPORTED rather than re-parsed here. This line used to be its own
  // `String(process.env...) === '1'`, which meant the "only the literal 1 counts" rule —
  // the one with an explicit assertion behind it — bound chat.js and silently not this
  // module. Two copies of an env parse is one copy too many when the thing it gates is
  // billing-shaped.
  const strictTotal = strictUsageTotal();
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completion,
    total_tokens: strictTotal
      ? promptTokens + completion
      : promptTokens + completion + cacheWrite,
    ...(lastUsage.cache_read_tokens != null
      ? { prompt_tokens_details: { cached_tokens: cacheRead } }
      : {}),
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
  return map[n] || 'stop';
}

/**
 * Resolve the OpenAI finish_reason for a completed connect turn.
 *
 * The enum alone cannot tell us about truncation: only 2 and 4 are pinned by live
 * captures, and every name-order guess for the rest has been wrong so far (4 was
 * 'length' and made every complete paid response read as truncated). So the enum
 * now defaults to 'stop' and truncation is detected from a signal that does not
 * depend on the un-calibrated integers: `completion_tokens` reaching the output cap
 * the caller asked for. That is the same test an OpenAI client would apply itself.
 *
 * The check is deliberately conservative — equality with the cap, not >=, and only
 * when the caller set an explicit cap:
 *   - `max_tokens` is NOT enforced upstream on every tier (a free-tier probe varied
 *     16 → 1000 with byte-identical output), so a turn that never approaches the cap
 *     is unaffected either way;
 *   - reporting a complete answer as truncated is the more harmful error (clients
 *     that auto-continue on 'length' loop forever), so ambiguity resolves to 'stop'.
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
  // Only a clean stop can be upgraded to 'length'. tool_calls / content_filter are
  // stronger signals about what the turn actually did and must not be overwritten.
  if (mapped !== 'stop') return mapped;
  const cap = Number(maxTokens);
  const completion = Number(usage?.completion_tokens);
  if (Number.isFinite(cap) && cap > 0 && Number.isFinite(completion) && completion === cap) {
    return 'length';
  }
  return mapped;
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
  deviceSeed, sessionModelConfig, continuityTrail,
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
  const proto = buildGetChatMessageRequest({ token: sessionToken, messages, model, sessionId, completion, tools, nativeToolCall, deviceSeed, userJwt, env, sessionModelConfig, continuityTrail });
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
    try {
      const h = /^https?:\/\//i.test(host) ? new URL(host).hostname : String(host).replace(/\/.*$/, '');
      if (h) effectiveHost = h;
    } catch { /* keep default */ }
  }

  const queue = [];
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
        if (frame.isEndStream) {
          sawEndOfStream = true;
          // Trailer is JSON: {} on success, {"error":{...}} on failure.
          const text = frame.payload.toString('utf8').trim();
          // Calibration (DEBUG-gated, default OFF): surface the raw trailer bytes
          // so a probe can check whether usage/billing ever rides the trailer
          // rather than a frame. Pure additive; zero effect on production.
          if (env.DEVIN_CONNECT_DUMP_RAW === '1') {
            queue.push({ type: 'raw-frame', endStream: true, hex: frame.payload.toString('hex'), text });
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
          queue.push({ type: 'raw-frame', endStream: false, hex: frame.payload.toString('hex') });
        }
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
        if (toolCalls) { for (const tc of toolCalls) mergeToolCallFragment(nativeToolCalls, tc); }
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
        // wire-01: flush any trailing bytes the decoders were holding (an
        // incomplete multi-byte sequence at the very end of the stream). Normally
        // empty — the upstream doesn't split the final char — but flushing keeps
        // the invariant that all received bytes are emitted.
        const tailContent = contentDecoder.end();
        const tailReasoning = reasoningDecoder.end();
        if (tailReasoning) yield { type: 'reasoning', text: tailReasoning };
        if (tailContent) yield { type: 'content', text: tailContent };
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
          reason: resolveFinishReason(lastFinish, finishUsage, completion?.maxTokens ?? WIRE_DEFAULT_MAX_TOKENS, env),
          // Same normalization the Cascade path already applies (chat.js, #118):
          // prompt_tokens INCLUDES cache_read (cached_tokens is a SUBSET detail of
          // it, per OpenAI's shape), and total_tokens carries the full cost
          // including cache_write so per-account accounting stays honest.
          //
          // Without this the connect path reported the upstream's raw fresh-input
          // figure as prompt_tokens, so on a cache-hit turn it emitted
          // cached_tokens=1765 alongside prompt_tokens=3 — a superset field larger
          // than the field it is a subset of — and total_tokens=158 against ~1768
          // real input tokens, a ~91% under-report. Every relay in front of this
          // proxy (one-api / new-api and friends) meters from exactly these
          // numbers, and all four protocol routes read this one object, so fixing
          // it at the birth point corrects them together. Live-reproduced.
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
  encodeAssistantToolCall, encodeImageToolResult, expandVisionMessage,
  getImageToolDefEnabled, SYNTHETIC_READ_TOOL,
  getImageReasoning, getImageProvider,
};
