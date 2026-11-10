#!/usr/bin/env node
// Support bundle: one archive that answers "please attach a trace" without asking the
// reporter to hand-collect files.
//
// WHAT GOES IN: the newest N trace directories (`WINDSURFAPI_TRACE_DIR`, default
// `<cwd>/.trace`), plus `environment.json` — the commit/version `GET /health` reports, the
// package version, and a REDACTED switch snapshot (WINDSURFAPI_*/DEVIN_*/CASCADE_* names
// whose values are booleans or short lowercase enums only). Token-shaped names are dropped
// by name, and path/model-shaped values are dropped by value, so a switch snapshot cannot
// become a credential leak.
//
// THE SECRET GATE: every staged file is scanned with `findRuleMatches()` from
// scripts/secret-rules.mjs — the SAME rule engine behind scripts/secret-scan.mjs (working
// tree) and scripts/history-secret-scan.mjs (git history). The two CLIs cannot be pointed at
// a staging directory: the tree scanner refuses paths outside the repository, and the
// history scanner reads git objects rather than files. Calling the shared matcher is what
// keeps this gate from becoming a third, drifting rule set. A hit means NOTHING is written.
//
// REDACTION: text legs have credential field values, account emails and presigned-URL query
// credentials replaced with `[redacted]` before the scan. Binary legs are NOT preserved
// verbatim. `03-upstream-req.bin` is a GetChatMessageRequest whose ClientMetadata carries
// the account session token (#3) and optionally a user JWT (#21) — credentials whose shape
// the shared rules cannot recognise when they are opaque. The bundler rewrites exactly those
// fields, copies every other byte, and then searches the whole staging tree for the removed
// credential values; a hit refuses the bundle. A binary leg that is not a recognisable
// GetChatMessageRequest is never shipped: the manifest records its path, byte count and
// sha256 so a maintainer can match it against a file sent separately. That is defence in
// depth, not the gate — the gate still refuses anything the redactor did not recognise.
//
// EXIT: 0 bundle written; 1 secret scan found a candidate (no zip, no manifest);
//       2 usage / I/O / environment failure. A partial bundle is never reported as success.

import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { crc32 } from 'node:zlib';
import { findRuleMatches, lineForOffset } from './secret-rules.mjs';
import { decodeVarint, writeMessageField, writeStringField } from '../src/proto.js';
import { getVersionInfo } from '../src/version.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_TRACE_COUNT = 5;
const DEFAULT_MAX_FILE_MB = 128;

// `GET /health` serves exactly these fields from `getVersionInfo()` (src/server.js). Reading
// the same function means the bundle cannot claim a different commit than the running
// server would have reported.
const HEALTH_SOURCE = 'src/version.js getVersionInfo() — the values GET /health serves';

const USAGE = `Usage: node scripts/support-bundle.mjs [options]

Pack the newest trace directories plus a redacted environment snapshot into
support-bundle-<utc>.zip (with manifest.json listing every file and its sha256).

Options:
  --trace-dir <dir>   trace root (default: $WINDSURFAPI_TRACE_DIR or <cwd>/.trace)
  --traces <n>        number of newest trace directories to include (default: ${DEFAULT_TRACE_COUNT})
  --out <dir>         output directory (default: cwd)
  --max-file-mb <n>   skip a single trace file larger than n MiB (default: ${DEFAULT_MAX_FILE_MB})
  --json              print a machine-readable summary
  -h, --help          show this help

The bundle is refused (exit 1, nothing written) when the shared secret rules match any
staged file, or when a credential removed from the upstream request is still present
elsewhere in the staging tree. Trace legs contain prompt fragments but no API keys: text
legs are redacted before the scan (field values, account emails, presigned-URL query
credentials), the upstream request protobuf has its ClientMetadata session token / user JWT
replaced with [redacted], and any other binary leg is omitted — the manifest records its
path, byte count and sha256 instead.`;

// ── option parsing ────────────────────────────────────────────────────────────────────────

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      'trace-dir': { type: 'string' },
      traces: { type: 'string' },
      out: { type: 'string' },
      'max-file-mb': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return { help: true };
  const count = values.traces === undefined ? DEFAULT_TRACE_COUNT : Number(values.traces);
  if (!Number.isInteger(count) || count < 0 || count > 100) {
    throw new Error(`--traces must be an integer between 0 and 100 (got ${values.traces})`);
  }
  const maxFileMb = values['max-file-mb'] === undefined
    ? DEFAULT_MAX_FILE_MB
    : Number(values['max-file-mb']);
  if (!Number.isFinite(maxFileMb) || maxFileMb <= 0 || maxFileMb > 4096) {
    throw new Error(`--max-file-mb must be a number between 0 and 4096 (got ${values['max-file-mb']})`);
  }
  const fromFlag = values['trace-dir'] !== undefined;
  const fromEnv = !fromFlag && Boolean(process.env.WINDSURFAPI_TRACE_DIR);
  return {
    help: false,
    traceDir: resolve(values['trace-dir'] || process.env.WINDSURFAPI_TRACE_DIR || join(process.cwd(), '.trace')),
    traceDirSource: fromFlag ? '--trace-dir' : (fromEnv ? 'WINDSURFAPI_TRACE_DIR' : 'default'),
    traceCount: count,
    outDir: resolve(values.out || process.cwd()),
    maxFileBytes: Math.floor(maxFileMb * 1024 * 1024),
    json: values.json,
  };
}

// ── trace selection ──────────────────────────────────────────────────────────────────────

// Trace ids are sortable by design (`<epoch-ms base36>-<rand>`, src/trace.js), but mtime is
// what "newest" means to an operator copying directories around, so sort by mtime and use
// the id only to break ties deterministically.
function listTraceDirs(traceDir) {
  if (!existsSync(traceDir)) return null;
  const dirs = [];
  for (const entry of readdirSync(traceDir, { withFileTypes: true })) {
    // Dirent.isDirectory() is false for a symlink, so a link out of the trace root is never
    // followed into the bundle.
    if (!entry.isDirectory()) continue;
    const abs = join(traceDir, entry.name);
    let mtimeMs;
    try {
      mtimeMs = lstatSync(abs).mtimeMs;
    } catch {
      continue; // removed between readdir and lstat: not a trace we can read
    }
    dirs.push({ id: entry.name, abs, mtimeMs });
  }
  dirs.sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id));
  return dirs;
}

function collectFiles(rootAbs, maxFileBytes) {
  const files = [];
  const skipped = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`cannot read trace directory ${rel || '.'} (${error?.code || error?.message})`);
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        skipped.push({ path: relPath, reason: 'symlink (not followed)' });
        continue;
      }
      if (entry.isDirectory()) {
        walk(abs, relPath);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({ path: relPath, reason: 'not a regular file' });
        continue;
      }
      const size = statSync(abs).size;
      if (size > maxFileBytes) {
        skipped.push({ path: relPath, reason: `larger than ${maxFileBytes} bytes` });
        continue;
      }
      files.push({ abs, rel: relPath, size });
    }
  };
  walk(rootAbs, '');
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files, skipped };
}

// ── redaction + switch snapshot ─────────────────────────────────────────────────────────

// Every replacement value. A residual check below depends on this exact spelling: a value
// that is not `[redacted]` is treated as an unredacted leak.
const REDACTED = '[redacted]';

// Sensitive field names, shared by SECRET_FIELD / RESIDUAL_FIELD and the query
// pair below so the four patterns cannot drift apart.
//
// Two coverage gaps used to leak: (a) a bare `token`/`secret`/`key` tail after
// a `_` was invisible to `\b` (`_` is a word char, so `\btoken\b` never fired
// inside `csrf_token` — only the explicitly enumerated *_token spellings were
// covered); (b) jwt / bearer / credential / the *_key and *_secret families
// were missing outright. The three catch-all alternatives below claim any
// <name>[-_]<tail>, <sep-prefixed><tail> or <alnum><tail> spelling —
// access_token, session_token, csrf_token, client_secret, private-key,
// sort_key, __RequestVerificationToken, and the camel forms OAuth payloads use
// (accessToken, refreshToken) — without an allowlist to keep in sync. Bare
// `key`/`jwt`/`bearer` tails stay absent from the standalone list so
// `sort_keys`, `tokenizer` and `keystore` still don't match; the trailing \b
// in the consuming regexes keeps `xtokenizer` out as well. Deliberate
// over-redaction: a `monkey:`-shaped field loses its value — a wrong
// [redacted] beats a live credential in a public attachment.
const SECRET_NAME_SRC =
  'authorization|proxy-authorization|x-api-key|api[-_]?key|caller[-_]?key'
  + '|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|auth[-_]?token|csrf[-_]?token|xsrf[-_]?token'
  + '|token|jwt|bearer|secret|client[-_]?secret|password|passwd|cookie|set-cookie|credentials?'
  + '|private[-_]?key|secret[-_]?key|session[-_]?key|signing[-_]?key'
  + '|(?:[a-z0-9]+[-_])+(?:token|jwt|key|secret|password|passwd|cookie|credentials?|bearer)'
  + '|[-_]+[a-z0-9]*(?:token|jwt|key|secret|password|passwd|cookie|credentials?|bearer)'
  + '|[a-z0-9]+(?:token|jwt|key|secret|password|passwd|cookie|credentials?|bearer)';

// A field NAME followed by `:` or `=` and a scalar value. The value class excludes quotes,
// braces, brackets, commas and newlines, so JSON structure survives; spaces are allowed
// after the first character because an Authorization value is `Bearer <token>`. The first
// character must be non-whitespace: otherwise the optional whitespace before the value can
// backtrack and turn `"token": ""` into a match on the space alone, corrupting the JSON.
// The leading boundary is (?<![A-Za-z0-9]), not \b: \b treats _ as a word char and would
// keep the catch-alls from ever starting inside `foo_token`.
const SECRET_FIELD = new RegExp(
  `((?<![A-Za-z0-9])(?:${SECRET_NAME_SRC})\\b["']?\\s*[:=]\\s*["']?)([^"'{}[\\],\\r\\n\\s][^"'{}[\\],\\r\\n]*)`,
  'gi',
);

// A URL query credential. Presigned object URLs (S3 and compatible stores) put the whole
// grant in the query string; `X-Amz-*` covers SigV4's Credential/Signature/Security-Token
// and any later parameter, and the shared name list covers the other spellings in the
// wild (including `_`-joined forms like `?csrf_token=` that the same \b gap hid here).
// The value class stops at URL/JSON delimiters and at `[`/`]` so `[redacted]` is idempotent.
const QUERY_CREDENTIAL = new RegExp(
  `([?&](?:x-amz-[a-z0-9-]+|signature|key|${SECRET_NAME_SRC})=)([^&#"'\\s\\\\[\\]]+)`,
  'gi',
);

// Account identity rather than a credential, but the routing leg stores `ccAcct.email` and
// an issue attachment is public. Any address shape is removed, wherever it appears.
const EMAIL_ADDRESS = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

// Independent residual patterns: they look for a sensitive NAME and then assert the value
// that follows is exactly `[redacted]`. Deliberately not the redaction regexes — a future
// edit that changes a replacement must fail here instead of shipping the value. The NAME
// list itself is shared (SECRET_NAME_SRC): a name the redactor knows but the residual
// check cannot find is precisely the gap this pattern exists to catch.
const RESIDUAL_FIELD = new RegExp(`(?<![A-Za-z0-9])(?:${SECRET_NAME_SRC})\\b["']?\\s*[:=]\\s*["']?`, 'gi');
const RESIDUAL_QUERY = new RegExp(`[?&](?:x-amz-[a-z0-9-]+|signature|key|${SECRET_NAME_SRC})=`, 'gi');
const RESIDUAL_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

function redactText(text) {
  let count = 0;
  const redacted = text
    // The query pattern runs FIRST: its value class stops at `&`, so each
    // `?name=` parameter is redacted individually. SECRET_FIELD's value class
    // tolerates `&`, which used to be harmless — the shared name list now
    // includes `credential`, and `X-Amz-Credential=AKIA…&X-Amz-Signature=…`
    // would let the field regex swallow the signature (and every later
    // parameter) into one redaction. After QUERY_CREDENTIAL has run, the
    // remaining `name=[redacted]` text is idempotent for SECRET_FIELD: `[`
    // cannot start its value class.
    .replace(QUERY_CREDENTIAL, (_match, prefix) => {
      count += 1;
      return `${prefix}${REDACTED}`;
    })
    .replace(SECRET_FIELD, (_match, prefix) => {
      count += 1;
      return `${prefix}${REDACTED}`;
    })
    .replace(EMAIL_ADDRESS, () => {
      count += 1;
      return REDACTED;
    });
  return { text: redacted, count };
}

// Findings for text that still looks sensitive after redaction. `matchAll` clones nothing:
// each regex is global, so lastIndex is reset before use.
//
// An empty value is not a leak: `"token": ""` and `?token=&x=1` are harmless, and refusing
// them would turn ordinary prompt text into an unusable bundle. The prefix regex consumes
// an opening quote, so an empty quoted value leaves the closing quote at the front.
const EMPTY_VALUE = /^(?:$|[&#'"\s}\],])/;

function findResidualSensitive(text) {
  const findings = [];
  const afterName = (regex, rule) => {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const rest = text.slice(match.index + match[0].length);
      if (rest.startsWith(REDACTED) || EMPTY_VALUE.test(rest)) continue;
      findings.push({ rule, index: match.index + match[0].length });
    }
  };
  afterName(RESIDUAL_FIELD, 'secret-field');
  afterName(RESIDUAL_QUERY, 'presigned-url-credential');
  for (const match of text.matchAll(RESIDUAL_EMAIL)) findings.push({ rule: 'email-address', index: match.index });
  return findings;
}

const SWITCH_NAME = /^(?:WINDSURFAPI|DEVIN|CASCADE)_/;
// Name-level exclusions: a token can be short and lowercase, so value shape alone is not
// enough. `CRED` covers DEVIN_CONNECT_CRED_KEY; `SESSION` covers session-id switches.
const SECRET_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|(?:^|_)KEY(?:_|$)|COOKIE|CRED|EMAIL|PRIVATE|SESSION|AUTHORIZATION)/i;
const BOOLEAN_VALUE = /^(?:0|1|true|false|on|off|yes|no)$/i;
// Enums only: lowercase tokens such as `debug`, `native`, `legacy`, `auto`. Paths, model
// ids, versions and mixed-case/random strings all fail this shape.
const ENUM_VALUE = /^[a-z][a-z0-9_-]{0,23}$/;

function snapshotSwitches(env) {
  const switches = {};
  let excluded = 0;
  for (const name of Object.keys(env).sort()) {
    if (!SWITCH_NAME.test(name)) continue;
    if (SECRET_NAME.test(name)) {
      excluded += 1;
      continue;
    }
    const value = String(env[name] ?? '');
    if (!BOOLEAN_VALUE.test(value) && !ENUM_VALUE.test(value)) {
      excluded += 1;
      continue;
    }
    switches[name] = value;
  }
  return { switches, excluded };
}

// ── text/binary split ────────────────────────────────────────────────────────────────────

// A trace leg is text if it has no NUL byte AND its UTF-8 decode round-trips to the same
// bytes. Everything else is a binary leg and goes through `redactConnectRequest` below.
function isText(buffer) {
  if (buffer.includes(0)) return false;
  return Buffer.from(buffer.toString('utf8'), 'utf8').equals(buffer);
}

// ── binary legs: redact the request, omit what cannot be proved safe ────────────────────
//
// The only binary leg that ships is a GetChatMessageRequest the bundler can rewrite. Its
// field #1 is ClientMetadata (src/devin-connect.js buildClientMetadata): #1.#3 is the
// account session token and #1.#21 is the optional user JWT. Both are replaced with
// `[redacted]`; every other byte — system prompt, messages, model, tools, config — is
// copied verbatim. The removed values are returned so `main` can search the entire staging
// tree for them; a hit means the credential survives somewhere else and the bundle is
// refused. A buffer that is not recognisably this request is never shipped.
//
// The parser is schema-less and span-based on purpose: re-encoding untouched fields would
// change bytes the issue is about, and the repository has no protobuf dependency.

const CLIENT_NAME = 'chisel'; // src/devin-connect.js CLIENT_NAME, the #1.#1 marker
const CLIENT_NAME_BYTES = Buffer.from(CLIENT_NAME, 'utf8');
const METADATA_TOKEN_FIELD = 3;
const METADATA_USER_JWT_FIELD = 21;

// [{ field, wireType, start, valueStart, end }] with start/end covering the whole field
// (tag + length + value) so callers can copy untouched fields byte-for-byte.
function readFieldSpans(buffer) {
  const fields = [];
  let pos = 0;
  while (pos < buffer.length) {
    const start = pos;
    const tag = decodeVarint(buffer, pos);
    pos += tag.length;
    const field = Number(tag.value) >>> 3;
    const wireType = Number(tag.value) & 0x07;
    if (field === 0) throw new Error('protobuf field number 0');
    let valueStart;
    if (wireType === 0) {
      valueStart = pos;
      pos += decodeVarint(buffer, pos).length;
    } else if (wireType === 1) {
      valueStart = pos;
      pos += 8;
    } else if (wireType === 2) {
      const length = decodeVarint(buffer, pos);
      pos += length.length;
      valueStart = pos;
      pos += Number(length.value);
    } else if (wireType === 5) {
      valueStart = pos;
      pos += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
    if (pos > buffer.length) throw new Error('truncated protobuf field');
    fields.push({ field, wireType, start, valueStart, end: pos });
  }
  return fields;
}

function copyWithReplacements(buffer, fields, replacements) {
  const parts = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    parts.push(replacements.has(i) ? replacements.get(i) : buffer.subarray(field.start, field.end));
  }
  return Buffer.concat(parts);
}

// Returns { ok, buffer?, credentials, reason? }. `credentials` is always populated when a
// token field was found, including on the failure path, so the caller can still search for
// those bytes in text legs.
function redactConnectRequest(buffer) {
  let top;
  try {
    top = readFieldSpans(buffer);
  } catch {
    return { ok: false, credentials: [], reason: 'not a redactable GetChatMessageRequest: unparsable protobuf' };
  }
  const metadataFields = top.filter((field) => field.field === 1 && field.wireType === 2);
  if (metadataFields.length !== 1) {
    return { ok: false, credentials: [], reason: 'not a redactable GetChatMessageRequest: no single ClientMetadata' };
  }
  const metadataField = metadataFields[0];
  const metadata = buffer.subarray(metadataField.valueStart, metadataField.end);
  let metadataSpans;
  try {
    metadataSpans = readFieldSpans(metadata);
  } catch {
    return { ok: false, credentials: [], reason: 'not a redactable GetChatMessageRequest: unparsable ClientMetadata' };
  }
  const clientName = metadataSpans.find((field) => field.field === 1 && field.wireType === 2);
  if (!clientName || metadata.toString('utf8', clientName.valueStart, clientName.end) !== CLIENT_NAME) {
    return { ok: false, credentials: [], reason: 'not a redactable GetChatMessageRequest: ClientMetadata #1 != chisel' };
  }
  const tokenSpans = metadataSpans.filter(
    (field) => field.field === METADATA_TOKEN_FIELD || field.field === METADATA_USER_JWT_FIELD,
  );
  if (tokenSpans.some((field) => field.wireType !== 2)) {
    return { ok: false, credentials: [], reason: 'not a redactable GetChatMessageRequest: unexpected token wire type' };
  }
  const credentials = [];
  const metadataReplacements = new Map();
  for (let i = 0; i < metadataSpans.length; i += 1) {
    const field = metadataSpans[i];
    if (field.field !== METADATA_TOKEN_FIELD && field.field !== METADATA_USER_JWT_FIELD) continue;
    const value = metadata.subarray(field.valueStart, field.end);
    if (value.length > 0) credentials.push(Buffer.from(value));
    metadataReplacements.set(i, writeStringField(field.field, REDACTED));
  }
  if (credentials.length === 0) {
    return { ok: false, credentials, reason: 'not a redactable GetChatMessageRequest: ClientMetadata carries no token' };
  }
  const redactedMetadata = copyWithReplacements(metadata, metadataSpans, metadataReplacements);
  const topReplacements = new Map([
    [top.indexOf(metadataField), writeMessageField(1, redactedMetadata)],
  ]);
  const redacted = copyWithReplacements(buffer, top, topReplacements);
  // The proof: a removed credential must not survive anywhere in the rewritten leg. If the
  // same value also rides in a message/system prompt, the leg is not safe to ship.
  if (credentials.some((credential) => redacted.includes(credential))) {
    return { ok: false, credentials, reason: 'credential bytes also appear outside ClientMetadata' };
  }
  return { ok: true, buffer: redacted, credentials };
}

// ── staging + secret scan ────────────────────────────────────────────────────────────────

function writeStaged(staging, rel, bytes) {
  const abs = join(staging, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
}

function listStagedFiles(dir) {
  const files = [];
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) files.push(childRel);
      else throw new Error(`unexpected non-regular file in staging: ${childRel}`);
    }
  };
  walk(dir, '');
  return files.sort();
}

// The rule matcher is shared, but its fixture exemption is path-based (`test/` only). The
// staged path is what a reviewer would open in the zip, so that is the path it gets.
function scanStaged(staging) {
  const files = listStagedFiles(staging);
  const findings = [];
  for (const rel of files) {
    const buffer = readFileSync(join(staging, ...rel.split('/')));
    const textual = isText(buffer);
    const text = textual ? buffer.toString('utf8') : buffer.toString('latin1');
    for (const match of findRuleMatches(text, [rel])) {
      findings.push({ path: rel, line: lineForOffset(text, match.index), rule: match.rule });
    }
    // Binary legs are already redacted or omitted; only text can still carry a field value,
    // an email or a URL query credential after `redactText`.
    if (textual) {
      for (const residual of findResidualSensitive(text)) {
        findings.push({ path: rel, line: lineForOffset(text, residual.index), rule: residual.rule });
      }
    }
  }
  findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule));
  return { files: files.length, findings };
}

// Every credential value removed from a request leg, searched across everything staged.
// This is what makes the opaque-token case provable: the shared rules cannot recognise the
// shape, so the exact bytes taken out of ClientMetadata are the ground truth. A hit means
// the redactor missed an occurrence elsewhere and the bundle must not be written.
function findCredentialBytes(staging, credentials) {
  const findings = [];
  if (credentials.length === 0) return findings;
  for (const rel of listStagedFiles(staging)) {
    const buffer = readFileSync(join(staging, ...rel.split('/')));
    for (const credential of credentials) {
      if (credential.length === 0) continue;
      const index = buffer.indexOf(credential);
      if (index === -1) continue;
      // latin1 keeps the byte offset 1:1 with the character offset `lineForOffset` counts.
      findings.push({ path: rel, line: lineForOffset(buffer.toString('latin1'), index), rule: 'credential-value' });
      break;
    }
  }
  return findings;
}

// ── zip (STORE, no compression) ─────────────────────────────────────────────────────────
//
// A store-only writer keeps the archive dependency-free and makes every stored entry
// byte-identical to what the manifest hashed (the redacted request included; omitted binary
// legs are simply absent). The repository has zero npm runtime dependencies by design;
// adding one for a debug bundle would be a poor trade. Node's built-in zlib supplies CRC-32.

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11)
    | ((date.getMinutes() & 0x3f) << 5)
    | ((date.getSeconds() >> 1) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9)
    | (((date.getMonth() + 1) & 0x0f) << 5)
    | (date.getDate() & 0x1f);
  return { time, day };
}

function buildZip(entries) {
  if (entries.length > 0xffff) throw new Error('too many files for a zip archive (max 65535)');
  const { time, day } = dosDateTime(new Date());
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const checksum = crc32(data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // UTF-8 file name
    local.writeUInt16LE(0, 8);            // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length
    chunks.push(local, nameBytes, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);  // central directory header
    header.writeUInt16LE(20, 4);          // version made by
    header.writeUInt16LE(20, 6);          // version needed
    header.writeUInt16LE(0x0800, 8);      // UTF-8 file name
    header.writeUInt16LE(0, 10);          // method: store
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(day, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30);          // extra field length
    header.writeUInt16LE(0, 32);          // comment length
    header.writeUInt16LE(0, 34);          // disk number
    header.writeUInt16LE(0, 36);          // internal attributes
    header.writeUInt32LE(0, 38);          // external attributes
    header.writeUInt32LE(offset, 42);     // local header offset
    central.push(header, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralBytes = Buffer.concat(central);
  if (offset + centralBytes.length > 0xffffffff) {
    throw new Error('bundle exceeds the 4 GiB zip limit');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory
  end.writeUInt16LE(0, 4);                // disk number
  end.writeUInt16LE(0, 6);                // central directory start disk
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);               // comment length
  return Buffer.concat([...chunks, centralBytes, end]);
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function utcStamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

// ── main ────────────────────────────────────────────────────────────────────────────────

function main(argv) {
  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    console.error(`support-bundle: ${error.message}`);
    console.error(USAGE);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const versionInfo = getVersionInfo();

  const allTraceDirs = listTraceDirs(options.traceDir);
  if (allTraceDirs === null) {
    if (options.traceDirSource !== 'default') {
      console.error(`support-bundle: trace directory ${options.traceDir} does not exist — refusing to build a bundle that silently has no traces`);
      return 2;
    }
    console.error(`support-bundle: ${options.traceDir} does not exist; packaging the environment snapshot only`);
  }
  const traceDirs = allTraceDirs || [];
  const selected = traceDirs.slice(Math.max(0, traceDirs.length - options.traceCount));

  mkdirSync(options.outDir, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), 'windsurfapi-support-'));
  try {
    const redactions = [];
    const skippedFiles = [];
    const binaryRedactions = [];
    const binaryOmitted = [];
    const credentials = [];
    let traceFileCount = 0;
    for (const trace of selected) {
      const { files, skipped } = collectFiles(trace.abs, options.maxFileBytes);
      for (const item of skipped) skippedFiles.push({ trace: trace.id, ...item });
      traceFileCount += files.length;
      for (const file of files) {
        const raw = readFileSync(file.abs);
        const rel = `traces/${trace.id}/${file.rel}`;
        // Content first: a GetChatMessageRequest is redacted even if it would pass the
        // text heuristic, so a future builder that emits only printable bytes cannot turn
        // the request leg into a "text" leg that skips protobuf redaction. The `chisel`
        // marker is a cheap precondition; only matching buffers pay for the parser.
        const request = raw.includes(CLIENT_NAME_BYTES) ? redactConnectRequest(raw) : null;
        if (request && (request.ok || request.credentials.length > 0)) {
          for (const credential of request.credentials) credentials.push(credential);
          if (request.ok) {
            writeStaged(staging, rel, request.buffer);
            binaryRedactions.push({
              path: rel,
              sourceBytes: raw.length,
              sourceSha256: sha256(raw),
              credentialsRedacted: request.credentials.length,
            });
          } else {
            binaryOmitted.push({ path: rel, bytes: raw.length, sha256: sha256(raw), reason: request.reason });
          }
        } else if (isText(raw)) {
          const { text, count } = redactText(raw.toString('utf8'));
          if (count > 0) redactions.push({ path: rel, count });
          writeStaged(staging, rel, Buffer.from(text, 'utf8'));
        } else {
          // Any other binary leg is omitted with a size+sha256 record: the bundler cannot
          // prove an opaque credential is absent from bytes it does not understand.
          binaryOmitted.push({
            path: rel,
            bytes: raw.length,
            sha256: sha256(raw),
            reason: request?.reason || 'binary leg: not a GetChatMessageRequest (no ClientMetadata marker)',
          });
        }
      }
    }

    const { switches, excluded: switchesExcluded } = snapshotSwitches(process.env);
    const createdAt = new Date().toISOString();
    const environment = {
      createdAt,
      version: packageJson.version,
      health: {
        source: HEALTH_SOURCE,
        status: 'ok',
        version: versionInfo.version,
        commit: versionInfo.commit,
        commitMessage: versionInfo.commitMessage,
        commitDate: versionInfo.commitDate,
        branch: versionInfo.branch,
        buildSource: versionInfo.source,
        packageVersion: packageJson.version,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      switches,
      switchesExcluded,
      traces: {
        source: options.traceDirSource,
        requested: options.traceCount,
        found: traceDirs.length,
        included: selected.map((trace) => trace.id),
        omitted: Math.max(0, traceDirs.length - selected.length),
        files: traceFileCount,
        skipped: skippedFiles,
        redactions,
        binaryLegs: { redacted: binaryRedactions, omitted: binaryOmitted },
      },
    };
    // environment.json is generated, but `health.commitMessage` is free text from git and
    // can carry an address. Redact it with the same rules as a trace leg so the residual
    // gate has nothing to refuse on our own metadata.
    const environmentText = `${JSON.stringify(environment, null, 2)}\n`;
    const environmentRedaction = redactText(environmentText);
    let stagedEnvironment = environmentRedaction.text;
    if (environmentRedaction.count > 0) {
      const parsed = JSON.parse(stagedEnvironment);
      parsed.environmentRedactions = environmentRedaction.count;
      stagedEnvironment = `${JSON.stringify(parsed, null, 2)}\n`;
    }
    writeStaged(staging, 'environment.json', Buffer.from(stagedEnvironment, 'utf8'));

    // THE GATE: scan everything that would enter the archive, including environment.json,
    // then prove the exact bytes removed from any request leg are nowhere in the staging
    // tree. The second check is the one that covers opaque tokens.
    const scan = scanStaged(staging);
    const findings = [...scan.findings, ...findCredentialBytes(staging, credentials)]
      .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule));
    if (findings.length > 0) {
      if (options.json) {
        console.log(JSON.stringify({ ok: false, error: 'secret-scan', findings }, null, 2));
      } else {
        for (const finding of findings) {
          console.error(`${finding.path}:${finding.line} ${finding.rule}`);
        }
        console.error(`support-bundle: refusing to package — ${findings.length} credential candidate(s) found; nothing was written`);
      }
      return 1;
    }

    const redactedByPath = new Map(binaryRedactions.map((item) => [item.path, item]));
    const manifestFiles = listStagedFiles(staging).map((rel) => {
      const data = readFileSync(join(staging, ...rel.split('/')));
      const entry = { path: rel, bytes: data.length, sha256: sha256(data) };
      const redaction = redactedByPath.get(rel);
      if (redaction) {
        entry.sourceBytes = redaction.sourceBytes;
        entry.sourceSha256 = redaction.sourceSha256;
        entry.transforms = ['client-metadata-credentials'];
      }
      return entry;
    });
    const redactedValues = redactions.reduce((sum, item) => sum + item.count, 0);
    const manifest = {
      createdAt,
      tool: 'scripts/support-bundle.mjs',
      version: packageJson.version,
      commit: versionInfo.commit,
      scan: { engine: 'scripts/secret-rules.mjs', files: scan.files, findings: 0 },
      redactions: { files: redactions.length, values: redactedValues, environment: environmentRedaction.count },
      binaryLegs: { redacted: binaryRedactions, omitted: binaryOmitted },
      files: manifestFiles,
      note: 'manifest.json is not listed: it is this file. sha256 is over the exact bytes stored in the zip. A redacted binary leg carries sourceBytes/sourceSha256 for the original; an omitted binary leg is not in the zip at all.',
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    writeStaged(staging, 'manifest.json', Buffer.from(manifestText, 'utf8'));

    const zipName = `support-bundle-${utcStamp(new Date())}.zip`;
    const zipPath = join(options.outDir, zipName);
    const manifestPath = join(options.outDir, zipName.replace(/\.zip$/, '.manifest.json'));
    const entries = listStagedFiles(staging).map((rel) => ({
      name: rel,
      data: readFileSync(join(staging, ...rel.split('/'))),
    }));
    const zip = buildZip(entries);
    writeFileSync(zipPath, zip);
    writeFileSync(manifestPath, manifestText);

    if (options.json) {
      console.log(JSON.stringify({
        ok: true,
        zip: zipPath,
        manifest: manifestPath,
        bytes: zip.length,
        files: entries.length,
        traces: selected.map((trace) => trace.id),
        redactions: redactedValues,
        binaryLegs: { redacted: binaryRedactions.length, omitted: binaryOmitted.length },
        scan: { files: scan.files, findings: 0 },
      }, null, 2));
    } else {
      console.log(`support-bundle: wrote ${zipPath} (${entries.length} files, ${zip.length} bytes, ${selected.length} trace dir(s))`);
      console.log(`support-bundle: manifest ${manifestPath}`);
      console.log(`support-bundle: secret scan clean (${scan.files} files, 0 findings); ${redactedValues} text value(s) redacted; ${binaryRedactions.length} request leg(s) redacted; ${binaryOmitted.length} binary leg(s) omitted`);
      if (binaryOmitted.length) {
        console.error(`support-bundle: ${binaryOmitted.length} binary leg(s) omitted (cannot prove credential-free); size + sha256 are in manifest.json`);
      }
      if (skippedFiles.length) {
        console.error(`support-bundle: ${skippedFiles.length} trace file(s) skipped (symlink/oversize); listed in environment.json`);
      }
    }
    return 0;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`support-bundle: ${error?.stack || error}`);
  process.exitCode = 2;
}
