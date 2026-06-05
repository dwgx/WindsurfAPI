/**
 * Optional protobuf field-tree tracing for the local Windsurf language server.
 *
 * Disabled by default. Enable with WINDSURFAPI_PROTO_TRACE=1. String payloads
 * are redacted by default: traces keep byte length + hash, not raw API keys,
 * account emails, session tokens, prompts, or tool preambles.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { gunzipSync } from 'zlib';
import { parseFields } from './proto.js';

let _seq = 0;

function enabled() {
  return process.env.WINDSURFAPI_PROTO_TRACE === '1';
}

function traceDir() {
  return process.env.WINDSURFAPI_PROTO_TRACE_DIR || '/tmp/windsurf-proto-trace';
}

function positiveIntEnv(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function shortHash(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function safeMethodName(path) {
  const name = String(path || 'unknown').split('/').filter(Boolean).pop() || 'unknown';
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
}

function mostlyText(buf) {
  if (!buf || buf.length === 0) return false;
  const s = buf.toString('utf8');
  let printable = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127)) printable++;
  }
  return printable / Math.max(1, s.length) > 0.9;
}

function redactPreview(s) {
  return String(s)
    .replace(/\b(?:devin-session-token|sessionToken|api[_-]?key|firebase_id_token|idToken|refreshToken)\b\s*[:=]\s*["']?[^"',\s)]+/gi, '<redacted-secret>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<redacted-token>')
    .slice(0, 240);
}

function summarizeBytes(buf, depth, maxDepth) {
  const bytes = buf.length;
  const hash = shortHash(buf);
  if (depth < maxDepth) {
    try {
      const parsed = parseFields(buf);
      if (parsed.length && parsed.every(f => f.field > 0)) {
        const children = summarizeProtoForTrace(buf, { depth: depth + 1, maxDepth });
        if (children.length) return { type: 'message', bytes, sha256: hash, fields: children };
      }
    } catch {}
  }
  if (mostlyText(buf)) {
    const out = { type: 'string', bytes, sha256: hash };
    if (process.env.WINDSURFAPI_PROTO_TRACE_STRINGS === '1') {
      out.preview = redactPreview(buf.toString('utf8'));
    }
    return out;
  }
  if (depth >= maxDepth) return { type: 'bytes', bytes, sha256: hash, truncatedDepth: true };
  try {
    const children = summarizeProtoForTrace(buf, { depth: depth + 1, maxDepth });
    if (children.length) return { type: 'message', bytes, sha256: hash, fields: children };
  } catch {}
  return { type: 'bytes', bytes, sha256: hash };
}

export function summarizeProtoForTrace(buf, opts = {}) {
  const depth = opts.depth || 0;
  const maxDepth = opts.maxDepth || positiveIntEnv('WINDSURFAPI_PROTO_TRACE_DEPTH', 8);
  const fields = parseFields(Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []));
  return fields.map((f) => {
    const out = { field: f.field, wireType: f.wireType };
    if (f.wireType === 0) {
      out.type = 'varint';
      out.value = typeof f.value === 'bigint' ? f.value.toString() : f.value;
    } else if (f.wireType === 1 || f.wireType === 5) {
      out.type = f.wireType === 1 ? 'fixed64' : 'fixed32';
      out.bytes = f.value.length;
      out.hex = f.value.toString('hex');
    } else if (f.wireType === 2) {
      Object.assign(out, summarizeBytes(f.value, depth, maxDepth));
    }
    return out;
  });
}

export function unwrapTracePayload(body, transport = 'grpc') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
  if (transport === 'connect') {
    if (buf.length >= 5) {
      const flags = buf[0];
      const len = buf.readUInt32BE(1);
      if (len === buf.length - 5) {
        let payload = buf.subarray(5);
        if (flags & 0x01) payload = gunzipSync(payload);
        return payload;
      }
    }
    return buf;
  }
  if (buf.length >= 5 && buf[0] === 0) {
    const len = buf.readUInt32BE(1);
    if (len <= buf.length - 5) return buf.subarray(5, 5 + len);
  }
  return buf;
}

export function traceGrpcPayload({ port, path, direction, body, transport = 'grpc', framed = false } = {}) {
  if (!enabled()) return;
  try {
    const payload = framed ? unwrapTracePayload(body, transport) : (Buffer.isBuffer(body) ? body : Buffer.from(body || []));
    const maxBytes = positiveIntEnv('WINDSURFAPI_PROTO_TRACE_MAX_BYTES', 512 * 1024);
    const record = {
      ts: new Date().toISOString(),
      seq: ++_seq,
      pid: process.pid,
      port,
      path,
      method: safeMethodName(path),
      direction,
      transport,
      payloadBytes: payload.length,
      payloadSha256: shortHash(payload),
    };
    if (payload.length > maxBytes) {
      record.skipped = `payload exceeds ${maxBytes} bytes`;
    } else {
      record.fields = summarizeProtoForTrace(payload);
    }
    const dir = traceDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `ls-proto-${process.pid}-${safeMethodName(path)}.jsonl`);
    appendFileSync(file, JSON.stringify(record) + '\n');
  } catch (err) {
    try {
      const dir = traceDir();
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `ls-proto-${process.pid}-errors.log`), `${new Date().toISOString()} ${path || ''} ${direction || ''}: ${err.message}\n`);
    } catch {}
  }
}

export function _resetProtoTraceForTests() {
  _seq = 0;
}
