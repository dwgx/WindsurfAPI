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
import { getAllFields, getField, parseFields } from './proto.js';

let _seq = 0;

function enabled() {
  return process.env.WINDSURFAPI_PROTO_TRACE === '1';
}

function traceDir() {
  return process.env.WINDSURFAPI_PROTO_TRACE_DIR || '/data/proto-trace';
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

function looksPathLike(s) {
  const value = String(s || '').trim();
  if (!value || value.length > 1024 || /[\r\n<>]/.test(value)) return false;
  if (/^file:\/\/\/?(?:[A-Za-z]:[\\/]|\/|~[\\/])/.test(value)) return true;
  if (/^(?:[A-Za-z]:[\\/]|\/|~[\\/]|\.{1,2}[\\/])\S+/.test(value)) return true;
  return /^[A-Za-z0-9._-]+(?:[\\/][A-Za-z0-9._-]+)*\.[A-Za-z0-9]{1,12}$/.test(value);
}

function looksPromptLike(s) {
  const value = String(s || '');
  if (!value) return false;
  if (value.includes('Working directory:') || value.includes('Use the Read tool')) return true;
  if (value.includes('<env>') || value.includes('</env>') || value.includes('<system-reminder>')) return true;
  return value.length > 512 && /(?:tool|prompt|environment|platform|workspace)/i.test(value);
}

function basenameOfPath(s) {
  const value = String(s || '').trim().replace(/^file:\/+/, '');
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1].slice(0, 120) : '';
}

function looksLikeMessage(buf) {
  if (!buf?.length) return false;
  const key = buf[0];
  const wireType = key & 7;
  const field = key >> 3;
  if (!field || ![0, 1, 2, 5].includes(wireType)) return false;
  try {
    const parsed = parseFields(buf);
    return parsed.length > 0 && parsed.every(f => f.field > 0);
  } catch {
    return false;
  }
}

function stringField(fields, num) {
  const f = getField(fields, num, 2);
  return f ? f.value.toString('utf8') : '';
}

function numberField(fields, num) {
  const f = getField(fields, num, 0);
  return f ? Number(f.value || 0) : null;
}

function boolField(fields, num) {
  const n = numberField(fields, num);
  return n == null ? null : n !== 0;
}

function countRepeatedMessageFields(fields, num) {
  return getAllFields(fields, num).filter(f => f.wireType === 2).length;
}

function summarizeMessageChildren(buf, maxFields = 12) {
  let children = [];
  try {
    children = parseFields(buf).slice(0, maxFields).map(child => ({
      field: child.field,
      wireType: child.wireType,
      type: Buffer.isBuffer(child.value)
        ? (mostlyText(child.value) ? 'string' : 'message_or_bytes')
        : 'varint',
      bytes: Buffer.isBuffer(child.value) ? child.value.length : undefined,
      value: Buffer.isBuffer(child.value) ? undefined : Number(child.value),
    }));
  } catch {
    children = [];
  }
  return {
    bytes: buf.length,
    fieldNumbers: children.map(child => child.field),
    fields: children,
  };
}

const NATIVE_TOOL_CONFIG_FIELDS = new Map([
  [5, 'find'],
  [8, 'run_command'],
  [13, 'search_web'],
  [10, 'view_file'],
  [19, 'list_dir'],
  [33, 'grep_v2'],
  [37, 'read_url_content'],
]);

const THIRD_PARTY_WEB_SEARCH_PROVIDER = new Map([
  [0, 'UNSPECIFIED'],
  [1, 'OPENAI'],
]);

const THIRD_PARTY_WEB_SEARCH_MODEL = new Map([
  [0, 'UNSPECIFIED'],
  [1, 'O3'],
  [2, 'GPT_4_1'],
  [3, 'O4_MINI'],
]);

const CASCADE_WEB_REQUESTS_AUTO_EXECUTION = new Map([
  [0, 'UNSPECIFIED'],
  [1, 'DISABLED'],
  [2, 'ALLOWLIST'],
  [3, 'TURBO'],
]);

function enumSummary(value, names) {
  return value == null ? null : {
    value,
    name: names.get(value) || `UNKNOWN_${value}`,
  };
}

function summarizeThirdPartyWebSearchConfig(buf) {
  const fields = parseFields(buf);
  return {
    provider: enumSummary(numberField(fields, 1), THIRD_PARTY_WEB_SEARCH_PROVIDER),
    model: enumSummary(numberField(fields, 2), THIRD_PARTY_WEB_SEARCH_MODEL),
    fieldNumbers: fields.map(f => f.field),
  };
}

function summarizeAutoWebRequestConfig(buf) {
  const fields = parseFields(buf);
  const allowlist = getAllFields(fields, 1)
    .filter(f => f.wireType === 2)
    .map(f => ({ bytes: f.value.length, sha256: shortHash(f.value) }));
  return {
    allowlistCount: allowlist.length,
    allowlist,
    autoExecutionPolicy: enumSummary(numberField(fields, 2), CASCADE_WEB_REQUESTS_AUTO_EXECUTION),
    fieldNumbers: fields.map(f => f.field),
  };
}

function summarizeNativeToolSubconfig(fields, num) {
  const f = getField(fields, num, 2);
  if (!f) return null;
  const summary = summarizeMessageChildren(f.value);
  const kind = NATIVE_TOOL_CONFIG_FIELDS.get(num) || `field_${num}`;
  let decoded = null;
  try {
    const subFields = parseFields(f.value);
    if (kind === 'search_web') {
      const thirdParty = getField(subFields, 2, 2);
      decoded = {
        forceDisable: boolField(subFields, 1),
        thirdPartyConfig: thirdParty ? summarizeThirdPartyWebSearchConfig(thirdParty.value) : null,
      };
    } else if (kind === 'read_url_content') {
      const autoWeb = getField(subFields, 2, 2);
      decoded = {
        forceDisable: boolField(subFields, 1),
        autoWebRequestConfig: autoWeb ? summarizeAutoWebRequestConfig(autoWeb.value) : null,
      };
    }
  } catch {}
  return {
    field: num,
    kind,
    bytes: summary.bytes,
    fieldNumbers: summary.fieldNumbers,
    fields: summary.fields.map(child => ({
      field: child.field,
      wireType: child.wireType,
      bytes: child.bytes,
    })),
    ...(decoded ? { decoded } : {}),
  };
}

function summarizeNativeToolConfig(toolCfgBuf) {
  const fields = parseFields(toolCfgBuf);
  const subconfigs = [...NATIVE_TOOL_CONFIG_FIELDS.keys()]
    .map(num => summarizeNativeToolSubconfig(fields, num))
    .filter(Boolean);
  const known = new Set([...NATIVE_TOOL_CONFIG_FIELDS.keys(), 32]);
  const unknownFields = fields
    .filter(f => f.wireType === 2 && !known.has(f.field))
    .slice(0, positiveIntEnv('WINDSURFAPI_PROTO_TRACE_TOOL_CONFIG_UNKNOWN_LIMIT', 24))
    .map(f => ({
      field: f.field,
      bytes: f.value.length,
      summary: summarizeMessageChildren(f.value, 10),
    }));
  return {
    subconfigFields: subconfigs.map(s => s.field),
    subconfigs,
    unknownFields,
    allowlist: getAllFields(fields, 32)
      .filter(f => f.wireType === 2)
      .map(f => f.value.toString('utf8')),
  };
}

function summarizeSendUserCascadeMessage(payload) {
  const top = parseFields(payload);
  const out = {
    cascadeIdHash: null,
    hasText: !!getField(top, 2, 2),
    hasMetadata: !!getField(top, 3, 2),
    imageCount: countRepeatedMessageFields(top, 6),
    additionalStepCount: countRepeatedMessageFields(top, 9),
    plannerMode: null,
    hasNativeToolConfig: false,
    nativeToolConfig: null,
  };
  const cascadeId = stringField(top, 1);
  if (cascadeId) out.cascadeIdHash = shortHash(Buffer.from(cascadeId, 'utf8'));
  const cfgField = getField(top, 5, 2);
  if (!cfgField) return out;
  const cfg = parseFields(cfgField.value);
  const plannerField = getField(cfg, 1, 2);
  if (!plannerField) return out;
  const planner = parseFields(plannerField.value);
  const convField = getField(planner, 2, 2);
  if (convField) {
    const conv = parseFields(convField.value);
    out.plannerMode = numberField(conv, 4);
    out.hasToolCallingSection = !!getField(conv, 10, 2);
    out.hasAdditionalInstructionsSection = !!getField(conv, 12, 2);
  }
  const toolCfgField = getField(planner, 13, 2);
  if (toolCfgField) {
    out.hasNativeToolConfig = true;
    out.nativeToolConfig = summarizeNativeToolConfig(toolCfgField.value);
  }
  return out;
}

const NATIVE_STEP_FIELDS = new Map([
  [13, 'grep_search'],
  [14, 'view_file'],
  [15, 'list_directory'],
  [23, 'write_to_file'],
  [28, 'run_command'],
  [34, 'find'],
  [40, 'read_url_content'],
  [42, 'search_web'],
  [105, 'grep_search_v2'],
]);

function summarizeNativeStepBody(kind, bodyBuf) {
  const f = parseFields(bodyBuf);
  if (kind === 'view_file') {
    return {
      absolutePathUriBytes: stringField(f, 1).length,
      contentBytes: stringField(f, 4).length,
      offset: numberField(f, 11) || 0,
      limit: numberField(f, 12) || 0,
    };
  }
  if (kind === 'run_command') {
    const combined = getField(f, 21, 2);
    let combinedOutputBytes = 0;
    if (combined) {
      try {
        combinedOutputBytes = stringField(parseFields(combined.value), 1).length;
      } catch {}
    }
    return {
      commandBytes: (stringField(f, 23) || stringField(f, 1)).length,
      cwdBytes: stringField(f, 2).length,
      combinedOutputBytes,
      stdoutBytes: stringField(f, 4).length,
      stderrBytes: stringField(f, 5).length,
    };
  }
  if (kind === 'grep_search_v2') {
    return {
      patternBytes: stringField(f, 2).length,
      pathBytes: stringField(f, 3).length,
      globBytes: stringField(f, 4).length,
      outputModeBytes: stringField(f, 5).length,
      headLimit: numberField(f, 12) || 0,
      rawOutputBytes: stringField(f, 15).length,
    };
  }
  if (kind === 'grep_search') {
    return {
      queryBytes: stringField(f, 1).length,
      searchPathUriBytes: stringField(f, 11).length,
      resultBytes: stringField(f, 3).length,
    };
  }
  if (kind === 'find') {
    return {
      patternBytes: stringField(f, 1).length,
      searchDirectoryBytes: stringField(f, 10).length,
      rawOutputBytes: stringField(f, 11).length,
    };
  }
  if (kind === 'list_directory') {
    return {
      directoryPathUriBytes: stringField(f, 1).length,
      childCount: getAllFields(f, 2).filter(x => x.wireType === 2).length,
    };
  }
  if (kind === 'search_web') {
    return {
      queryBytes: stringField(f, 1).length,
      webDocumentCount: getAllFields(f, 2).filter(x => x.wireType === 2).length,
      domainBytes: stringField(f, 3).length,
      summaryBytes: stringField(f, 5).length,
      fieldNumbers: f.map(x => x.field),
      messageFields: f
        .filter(x => x.wireType === 2 && ![1, 3, 5].includes(x.field))
        .slice(0, 8)
        .map(x => ({ field: x.field, ...summarizeMessageChildren(x.value, 8) })),
    };
  }
  if (kind === 'read_url_content') {
    return {
      urlBytes: stringField(f, 1).length,
      summaryBytes: stringField(f, 5).length,
      fieldNumbers: f.map(x => x.field),
      messageFields: f
        .filter(x => x.wireType === 2 && ![1, 5].includes(x.field))
        .slice(0, 8)
        .map(x => ({ field: x.field, ...summarizeMessageChildren(x.value, 8) })),
    };
  }
  return { fieldCount: f.length };
}

function summarizeReadWrapperField19(wrapperBuf) {
  const fields = parseFields(wrapperBuf);
  return {
    bytes: wrapperBuf.length,
    fieldNumbers: fields.map(f => f.field),
    children: fields.slice(0, positiveIntEnv('WINDSURFAPI_PROTO_TRACE_READ_WRAPPER_CHILD_LIMIT', 24))
      .map((f) => {
        const out = {
          field: f.field,
          wireType: f.wireType,
        };
        if (f.wireType === 0) {
          out.type = 'varint';
          out.value = typeof f.value === 'bigint' ? f.value.toString() : f.value;
          return out;
        }
        if (!Buffer.isBuffer(f.value)) return out;
        out.bytes = f.value.length;
        out.sha256 = shortHash(f.value);
        if (looksLikeMessage(f.value)) {
          out.type = 'message_or_bytes';
          out.summary = summarizeMessageChildren(f.value, 8);
          return out;
        }
        if (mostlyText(f.value)) {
          const text = f.value.toString('utf8');
          out.type = 'string';
          out.hasNewline = /[\r\n]/.test(text);
          out.hasAngleBracket = /[<>]/.test(text);
          out.looksPathLike = looksPathLike(text);
          out.looksPromptLike = looksPromptLike(text);
          out.basename = out.looksPathLike ? basenameOfPath(text) : '';
          if (process.env.WINDSURFAPI_PROTO_TRACE_READ_WRAPPER_STRINGS === '1') {
            out.preview = redactPreview(text);
          }
          return out;
        }
        out.type = 'message_or_bytes';
        out.summary = summarizeMessageChildren(f.value, 8);
        return out;
      }),
  };
}

function summarizeTrajectoryStep(stepBuf, index) {
  const fields = parseFields(stepBuf);
  const oneofFields = [];
  for (const [fieldNum, kind] of NATIVE_STEP_FIELDS) {
    const oneof = getField(fields, fieldNum, 2);
    if (!oneof) continue;
    oneofFields.push({
      field: fieldNum,
      kind,
      bodyBytes: oneof.value.length,
      body: summarizeNativeStepBody(kind, oneof.value),
    });
  }
  const interestingFields = fields
    .filter(f => f.wireType === 2 && ![5].includes(f.field))
    .slice(0, positiveIntEnv('WINDSURFAPI_PROTO_TRACE_SEMANTIC_FIELD_LIMIT', 12))
    .map(f => ({
      field: f.field,
      ...summarizeMessageChildren(f.value, 8),
    }));
  const type = numberField(fields, 1);
  const wrapper19 = type === 14 ? getField(fields, 19, 2) : null;
  return {
    index,
    type,
    status: numberField(fields, 4),
    fieldNumbers: fields.map(f => f.field),
    nativeOneofs: oneofFields,
    messageFields: interestingFields,
    ...(wrapper19 ? { readWrapperField19: summarizeReadWrapperField19(wrapper19.value) } : {}),
  };
}

function summarizeGetCascadeTrajectorySteps(payload) {
  const top = parseFields(payload);
  return {
    stepCount: countRepeatedMessageFields(top, 1),
    steps: getAllFields(top, 1)
      .filter(f => f.wireType === 2)
      .slice(0, positiveIntEnv('WINDSURFAPI_PROTO_TRACE_SEMANTIC_STEP_LIMIT', 40))
      .map((f, index) => summarizeTrajectoryStep(f.value, index)),
  };
}

function semanticSummary(method, direction, payload) {
  try {
    if (method === 'SendUserCascadeMessage' && direction === 'request') {
      return summarizeSendUserCascadeMessage(payload);
    }
    if (method === 'GetCascadeTrajectorySteps' && direction === 'response') {
      return summarizeGetCascadeTrajectorySteps(payload);
    }
  } catch (err) {
    return { error: err.message };
  }
  return null;
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
    const semantic = semanticSummary(record.method, direction, payload);
    if (semantic) record.semantic = semantic;
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
