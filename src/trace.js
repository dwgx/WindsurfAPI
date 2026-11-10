/**
 * Full-chain request tracing (gated, self-use debug/RE aid).
 *
 * When WINDSURFAPI_TRACE=1, each traced request drops a per-trace directory
 * <traceDir>/<traceId>/ that stitches the WHOLE chain together under one id:
 *
 *   01-client-req.json   inbound request from the client (model/messages/tools),
 *                        secrets redacted (no Authorization / apiKey values)
 *   02-routing.json      routing decision (chosen backend/selector/account,
 *                        native-tool flags, tool trimming)
 *   03-upstream-req.bin  raw protobuf sent to Devin (written by devin-connect's
 *                        existing wire-dump, keyed by the same traceId)
 *   04-upstream-res.bin  raw connect frames back from Devin (ditto)
 *   05-client-res.json   final response translated back to the client + status
 *   manifest.json        index + timeline tying the legs together
 *
 * Default OFF = zero overhead. This is a temporary self-use aid (offline RE +
 * debugging a live Claude Code session), never a served endpoint. Secrets are
 * redacted by default; raw upstream bytes are the point of the exercise and are
 * only written when WINDSURFAPI_TRACE=1 is explicitly set.
 */

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function traceEnabled(env = process.env) {
  return String(env.WINDSURFAPI_TRACE || '') === '1';
}

function traceRoot(env = process.env) {
  return env.WINDSURFAPI_TRACE_DIR || resolve(process.cwd(), '.trace');
}

// A short, sortable, unique trace id: <epoch-ms base36>-<rand>. Sortable so the
// trace dirs list in request order.
export function newTraceId() {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

// Redact obvious secrets from an object we're about to persist. Shallow + a few
// known-nested spots; the goal is "don't write raw tokens to disk", not perfect
// scrubbing. Keeps byte length hints where useful.
//
// Past MAX_TRACE_DEPTH a subtree is never traversed, so it cannot be redacted: the
// whole container is replaced by a constant marker. Returning the value (the old
// behavior) persisted whatever the deep container held — recognized secret-key
// values included — verbatim on disk. Diagnostic loss is the deliberate price:
// every object/array below depth 6 in a persisted leg reads as DEPTH_TRUNCATION
// instead of its contents.
// Anchored name match. The `_`-joined families used to leak here the same way
// they did in support-bundle.mjs: `access_token`/`session_token`/`csrf_token`
// needed explicit enumeration because the anchor + alternation never saw the
// tail inside a longer name, and jwt/bearer/credential/`*_key`/`*_secret` were
// absent entirely. Two catch-all alternatives normalise case / hyphen /
// underscore / camel spellings: <anything>[-_]<tail> covers access_token and
// __RequestVerificationToken; <alnum><tail> covers the camel/squashed forms
// OAuth payloads actually use (refreshToken, idToken, accessKey). Deliberate
// over-redaction: `monkey`/`passkey`-shaped names are claimed too — a wrong
// [redacted] in a diagnostic leg beats a live credential on disk. Plain
// `sort_keys`, `tokenizer`, `keystore` still do not match: the tail must
// terminate the name.
const SECRET_KEYS = /^(?:authorization|proxy-authorization|x-api-key|api[-_]?key|apikey|caller[-_]?key|token|jwt|bearer|secret|client[-_]?secret|password|passwd|cookie|set-cookie|credentials?|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|auth[-_]?token|csrf[-_]?token|xsrf[-_]?token|private[-_]?key|secret[-_]?key|session[-_]?key|signing[-_]?key|.*[-_][a-z0-9]*(?:token|jwt|key|secret|password|passwd|cookie|credentials?|bearer)|[a-z0-9]+(?:token|jwt|key|secret|password|passwd|cookie|credentials?|bearer))$/i;
const MAX_TRACE_DEPTH = 6;
const DEPTH_TRUNCATION = '[truncated:max-depth]';
function redact(value, depth = 0) {
  if (value == null) return value;
  const isContainer = Array.isArray(value) || typeof value === 'object';
  if (!isContainer) return value;
  if (depth > MAX_TRACE_DEPTH) return DEPTH_TRUNCATION;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.test(k)) {
      out[k] = typeof v === 'string' && v ? `[redacted:${v.length}b]` : '[redacted]';
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

function dirFor(traceId, env) {
  const dir = join(traceRoot(env), String(traceId).replace(/[^\w.-]/g, '_'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Append one line to the trace's timeline (manifest is rebuilt from these on
// each write so a crash mid-request still leaves a readable partial trace).
function stamp(traceId, leg, meta, env) {
  try {
    const dir = dirFor(traceId, env);
    const line = JSON.stringify({ t: Date.now(), leg, ...meta }) + '\n';
    appendFileSync(join(dir, 'timeline.jsonl'), line);
  } catch { /* tracing must never break the request */ }
}

/**
 * Record the inbound client request (leg 01). Returns the traceId (new one if
 * not supplied) so the caller can thread it through the rest of the chain.
 * No-op (returns the id) when tracing is disabled.
 */
export function traceClientRequest(body, ctx = {}, env = process.env) {
  const traceId = ctx.traceId || newTraceId();
  if (!traceEnabled(env)) return traceId;
  try {
    const dir = dirFor(traceId, env);
    const rec = {
      traceId,
      at: new Date().toISOString(),
      protocol: ctx.protocol || 'openai',
      model: body?.model || null,
      stream: !!body?.stream,
      messageCount: Array.isArray(body?.messages) ? body.messages.length : null,
      toolCount: Array.isArray(body?.tools) ? body.tools.length : null,
      callerKey: ctx.callerKey || null,
      body: redact(body),
    };
    writeFileSync(join(dir, '01-client-req.json'), JSON.stringify(rec, null, 2));
    stamp(traceId, 'client-req', { model: rec.model, stream: rec.stream }, env);
  } catch { /* never break the request */ }
  return traceId;
}

// Record the routing decision (leg 02): which backend/selector/account, native
// flags, tool trimming. Free-form meta object from chat.js.
export function traceRouting(traceId, meta = {}, env = process.env) {
  if (!traceEnabled(env) || !traceId) return;
  try {
    const dir = dirFor(traceId, env);
    writeFileSync(join(dir, '02-routing.json'), JSON.stringify({ traceId, at: new Date().toISOString(), ...redact(meta) }, null, 2));
    stamp(traceId, 'routing', { backend: meta.backend, selector: meta.selector, model: meta.model }, env);
  } catch {}
}

// Record the final client response (leg 05) + status/latency.
export function traceClientResponse(traceId, meta = {}, env = process.env) {
  if (!traceEnabled(env) || !traceId) return;
  try {
    const dir = dirFor(traceId, env);
    writeFileSync(join(dir, '05-client-res.json'), JSON.stringify({ traceId, at: new Date().toISOString(), ...redact(meta) }, null, 2));
    stamp(traceId, 'client-res', { status: meta.status, ms: meta.ms, cached: meta.cached }, env);
    writeManifest(traceId, env);
  } catch {}
}

// Rebuild manifest.json from the timeline so each trace has a single index.
function writeManifest(traceId, env) {
  try {
    const dir = dirFor(traceId, env);
    const legs = ['01-client-req.json', '02-routing.json', '03-upstream-req.bin', '04-upstream-res.bin', '05-client-res.json'];
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      traceId,
      builtAt: new Date().toISOString(),
      legs,
      note: 'Full-chain trace. 01=client in, 02=routing, 03/04=raw Devin wire bytes, 05=client out. timeline.jsonl = ordered events.',
    }, null, 2));
  } catch {}
}
