/**
 * v2.0.65 — Cascade native tool bridge (#115 root-cause fix).
 *
 * Translates between OpenAI-shaped client tools (Read/Bash/Glob/Grep/...) and
 * Cascade's built-in IDE step kinds (view_file/run_command/find/grep_search_v2/...).
 *
 * Why this layer exists
 * ─────────────────────
 * v2.0.62-v2.0.64 (#115) shipped dialect/anti-refusal infra under the
 * NO_TOOL planner mode + tool-prompt emulation umbrella. Real-world GPT
 * traces (Codex CLI, gpt-5.x) still surfaced markers=none on non-trivial
 * turns — the gateway's baked system prompt outweighs anything we inject
 * via additional_instructions_section. The tools the gateway DOES respect
 * are Cascade's own — view_file, run_command, grep_search_v2, find — because
 * those names appear inside the planner's training distribution as first-
 * class function-calling tokens, not as proxy-injected text.
 *
 * The bridge never enables planner_mode=DEFAULT on its own — that path
 * triggers server-side workspace mocking ("/tmp/windsurf-workspace path
 * leaks", #98 / pre-v2.0.64 stall_warm bursts). Instead, the bridge:
 *
 *   1. Forward translates the caller's OpenAI tool inventory + tool history
 *      into Cascade-vocabulary names so the gateway sees a familiar
 *      tool list and a sequence of completed cascade-style steps.
 *
 *   2. Reverse translates each trajectory step (view_file, run_command,
 *      grep_search_v2, find, list_directory) the planner emits back into
 *      the caller's original OpenAI tool name (Read, Bash, Grep, Glob, ...).
 *
 *   3. When ANY tool the caller declared cannot be mapped, the entire
 *      request falls back to the existing emulation path. Mixed mapped/
 *      unmapped requests are not split — partial native coverage would
 *      confuse the planner about which tools it actually has.
 *
 * Activation: gated by env var WINDSURFAPI_NATIVE_TOOL_BRIDGE=1 OR opt-in
 * runtime config flag `nativeToolBridge`. Default OFF until field-tested.
 */

import {
  writeStringField, writeMessageField, writeVarintField, writeBoolField, writeBytesField,
  parseFields, getField, getAllFields,
} from './proto.js';

// ─── Cascade step type enums ───────────────────────────────────────
//
// CortexStepType field numbers from exa.cortex_pb.proto (see
// scripts/ls-protos/proto/exa_cortex_pb_cortex.proto). The enum is the
// CortexTrajectoryStep.type (field 1) value. The matching oneof field
// number for each step is also the same number — Cascade keeps them
// aligned so the discriminator and the body share an integer.

export const CASCADE_STEP = {
  // step kind → { typeEnum, oneofField }
  view_file:       { typeEnum: 14,  oneofField: 14  },
  list_directory:  { typeEnum: 15,  oneofField: 15  },
  write_to_file:   { typeEnum: 23,  oneofField: 23  },
  run_command:     { typeEnum: 28,  oneofField: 28  },
  propose_code:    { typeEnum: 32,  oneofField: 32  },
  find:            { typeEnum: 34,  oneofField: 34  },
  read_url_content:{ typeEnum: 40,  oneofField: 40  },
  grep_search:     { typeEnum: 13,  oneofField: 13  },
  grep_search_v2:  { typeEnum: 105, oneofField: 105 },
};

// CortexStepStatus — used for the step.status field (CortexTrajectoryStep
// field 4). DONE=3 marks a step as complete-and-observed; UNSPECIFIED=0
// would leave the planner thinking work is still in progress.
export const CASCADE_STEP_STATUS_DONE = 3;

// ─── argument translators ─────────────────────────────────────────
//
// Each translator maps OpenAI-style arguments (the JSON object the caller
// puts in tool_calls[].function.arguments) to and from cascade step
// fields. They MUST be pure — identical args in produce identical cascade
// step proto bytes, and a round-trip translator(reverse(forward(args))) is
// the identity. The reverse direction is exercised for two reasons:
// (a) the planner emits trajectory steps in cascade vocabulary and we have
// to surface them as OpenAI tool_calls with arguments the caller's schema
// validator accepts; (b) tests assert lossless round-trip per tool.

function safeJsonParse(s) {
  if (typeof s !== 'string' || !s) return {};
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : {}; }
  catch { return {}; }
}

function buildFileUri(absolutePath) {
  if (typeof absolutePath !== 'string' || !absolutePath) return '';
  // Cascade's view_file uses absolute_path_uri — `file://` prefix optional
  // depending on LS version. Both forms are accepted in the wild; we leave
  // already-prefixed paths intact and add the prefix to bare ones.
  if (/^file:\/\//.test(absolutePath)) return absolutePath;
  if (/^[a-zA-Z]:[\\/]/.test(absolutePath) || absolutePath.startsWith('/')) {
    return `file://${absolutePath.replace(/\\/g, '/')}`;
  }
  // Relative path — leave as-is. Caller's environment block tells the
  // planner what cwd to resolve against.
  return absolutePath;
}

function stripFileUri(uri) {
  if (typeof uri !== 'string') return '';
  return uri.replace(/^file:\/\//, '');
}

// ── Read / view_file ────────────────────────────────────────────
function forwardReadArgs(args) {
  const file_path = args.file_path || args.path || args.absolute_path || '';
  const offset = Number(args.offset) || 0;
  const limit = Number(args.limit) || 0;
  return {
    absolute_path_uri: buildFileUri(file_path),
    offset,
    limit,
  };
}
function reverseReadArgs(cascade) {
  return {
    file_path: stripFileUri(cascade.absolute_path_uri || ''),
    ...(cascade.offset ? { offset: cascade.offset } : {}),
    ...(cascade.limit ? { limit: cascade.limit } : {}),
  };
}

// ── Bash / run_command ──────────────────────────────────────────
function forwardBashArgs(args) {
  const command = args.command || args.shell_command || '';
  return {
    command_line: String(command),
    cwd: typeof args.cwd === 'string' ? args.cwd : '',
    blocking: true,
  };
}
function reverseBashArgs(cascade) {
  return {
    command: cascade.command_line || cascade.proposed_command_line || '',
    ...(cascade.cwd ? { cwd: cascade.cwd } : {}),
  };
}

// ── Glob / find ─────────────────────────────────────────────────
function forwardGlobArgs(args) {
  return {
    pattern: args.pattern || '',
    search_directory: args.path || args.cwd || '',
  };
}
function reverseGlobArgs(cascade) {
  return {
    pattern: cascade.pattern || '',
    ...(cascade.search_directory ? { path: cascade.search_directory } : {}),
  };
}

// ── Grep / grep_search_v2 ───────────────────────────────────────
function forwardGrepArgs(args) {
  return {
    pattern: args.pattern || '',
    path: args.path || '',
    glob: args.glob || '',
    output_mode: args.output_mode || 'files_with_matches',
    case_insensitive: !!args['-i'],
    multiline: !!args.multiline,
    type: args.type || '',
    head_limit: Number(args.head_limit) || 0,
    lines_after: Number(args['-A']) || 0,
    lines_before: Number(args['-B']) || 0,
    lines_both: Number(args['-C'] ?? args.context) || 0,
  };
}
function reverseGrepArgs(cascade) {
  const out = { pattern: cascade.pattern || '' };
  if (cascade.path) out.path = cascade.path;
  if (cascade.glob) out.glob = cascade.glob;
  if (cascade.output_mode) out.output_mode = cascade.output_mode;
  if (cascade.case_insensitive) out['-i'] = true;
  if (cascade.multiline) out.multiline = true;
  if (cascade.type) out.type = cascade.type;
  if (cascade.head_limit) out.head_limit = cascade.head_limit;
  if (cascade.lines_after) out['-A'] = cascade.lines_after;
  if (cascade.lines_before) out['-B'] = cascade.lines_before;
  if (cascade.lines_both) out['-C'] = cascade.lines_both;
  return out;
}

// ── Write / write_to_file ──────────────────────────────────────
function forwardWriteArgs(args) {
  const file_path = args.file_path || args.path || '';
  const content = args.content || '';
  return {
    target_file_uri: buildFileUri(file_path),
    code_content: typeof content === 'string' ? [content] : Array.isArray(content) ? content : [String(content)],
  };
}
function reverseWriteArgs(cascade) {
  const lines = Array.isArray(cascade.code_content) ? cascade.code_content : [];
  return {
    file_path: stripFileUri(cascade.target_file_uri || ''),
    content: lines.join(''),
  };
}

// ── list_dir / list_directory ──────────────────────────────────
function forwardListDirArgs(args) {
  return {
    directory_path_uri: buildFileUri(args.path || args.directory_path || args.cwd || ''),
  };
}
function reverseListDirArgs(cascade) {
  return {
    path: stripFileUri(cascade.directory_path_uri || ''),
  };
}

// ── identity (when caller already speaks cascade vocabulary) ───
function identityArgs(x) { return { ...x }; }

// ─── OpenAI tool name → cascade kind table ──────────────────────────
//
// Keys are the EXACT tool name the caller declares in tools[].function.name.
// Casing matters — Claude Code uses TitleCase (Read, Bash); Codex CLI uses
// snake_case (view_file, run_command). Both are honored here.

export const TOOL_MAP = {
  // Claude Code
  Read:       { kind: 'view_file',      forward: forwardReadArgs,     reverse: reverseReadArgs },
  Bash:       { kind: 'run_command',    forward: forwardBashArgs,     reverse: reverseBashArgs },
  Glob:       { kind: 'find',           forward: forwardGlobArgs,     reverse: reverseGlobArgs },
  Grep:       { kind: 'grep_search_v2', forward: forwardGrepArgs,     reverse: reverseGrepArgs },
  Write:      { kind: 'write_to_file',  forward: forwardWriteArgs,    reverse: reverseWriteArgs },
  Edit:       { kind: 'propose_code',   forward: forwardEditArgs,     reverse: reverseEditArgs },
  MultiEdit:  { kind: 'propose_code',   forward: forwardEditArgs,     reverse: reverseEditArgs },

  // Codex CLI (already speaks cascade-ish vocabulary)
  view_file:       { kind: 'view_file',      forward: identityArgs, reverse: identityArgs },
  run_command:     { kind: 'run_command',    forward: forwardRunCommandPassThrough, reverse: reverseRunCommandPassThrough },
  grep_search:     { kind: 'grep_search_v2', forward: identityArgs, reverse: identityArgs },
  grep_search_v2:  { kind: 'grep_search_v2', forward: identityArgs, reverse: identityArgs },
  find:            { kind: 'find',           forward: identityArgs, reverse: identityArgs },
  list_dir:        { kind: 'list_directory', forward: forwardListDirArgs, reverse: reverseListDirArgs },
  list_directory:  { kind: 'list_directory', forward: forwardListDirArgs, reverse: reverseListDirArgs },
  write_to_file:   { kind: 'write_to_file',  forward: identityArgs, reverse: identityArgs },

  // Common synonyms surfaced by other clients
  read_file:       { kind: 'view_file',      forward: forwardReadArgs,  reverse: reverseReadArgs },
  shell:           { kind: 'run_command',    forward: forwardBashArgs,  reverse: reverseBashArgs },
};

// Edit / MultiEdit translate to propose_code. ActionSpec / ActionResult are
// nested messages with their own schemas — for v2.0.65 we degrade Edit to a
// pass-through that preserves args inside CustomToolSpec.arguments_json so
// the planner sees a structured record without us shipping the full
// ActionSpec proto. The caller's reverse translator restores its original
// payload because we keep the arguments_json verbatim.
function forwardEditArgs(args) {
  return { __raw_edit: JSON.stringify(args || {}) };
}
function reverseEditArgs(cascade) {
  if (cascade && typeof cascade.__raw_edit === 'string') return safeJsonParse(cascade.__raw_edit);
  return cascade || {};
}

// run_command pass-through: cascade and Codex both name the param
// "command" / "command_line" — accept either, normalise on the cascade side.
function forwardRunCommandPassThrough(args) {
  return {
    command_line: args.command_line || args.command || '',
    cwd: args.cwd || '',
    blocking: true,
  };
}
function reverseRunCommandPassThrough(cascade) {
  return {
    command_line: cascade.command_line || cascade.proposed_command_line || '',
    ...(cascade.cwd ? { cwd: cascade.cwd } : {}),
  };
}

// ─── Caller-tools introspection ─────────────────────────────────────

/**
 * canMapAllTools(tools) — returns true when EVERY caller-declared tool is
 * present in TOOL_MAP. Mixed-coverage requests fall back to emulation
 * because partial native coverage confuses the planner ("you have view_file
 * but get_weather is also available" is not a valid Cascade tool inventory).
 *
 * The check is purely structural — name lookup, no schema compat checks.
 * Schema mismatch surfaces at translate time as a best-effort coercion.
 */
export function canMapAllTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return false;
  for (const t of tools) {
    if (t?.type !== 'function') return false;
    const name = t.function?.name;
    if (!name || !TOOL_MAP[name]) return false;
  }
  return true;
}

/**
 * Build the inverse lookup table: cascade kind → list of caller tool names
 * that map onto it. Used by translateCascadeStepToToolCall to pick the
 * caller-visible name when the planner emits a step (the caller might have
 * declared `Read` OR `view_file` for the same kind; we emit the one they
 * actually declared).
 */
export function buildReverseLookup(callerTools) {
  const out = new Map();
  if (!Array.isArray(callerTools)) return out;
  for (const t of callerTools) {
    if (t?.type !== 'function' || !t.function?.name) continue;
    const name = t.function.name;
    const entry = TOOL_MAP[name];
    if (!entry) continue;
    if (!out.has(entry.kind)) out.set(entry.kind, []);
    out.get(entry.kind).push(name);
  }
  return out;
}

// ─── Forward: build cascade trajectory step proto ───────────────────
//
// These produce raw protobuf bytes that drop straight into
// CortexTrajectoryStep oneof — caller wraps them with the trajectory step
// envelope (type, status, etc) via buildAdditionalStep below.

function buildViewFileBody(args) {
  const parts = [];
  if (args.absolute_path_uri) parts.push(writeStringField(1, args.absolute_path_uri));
  if (args.offset) parts.push(writeVarintField(11, args.offset));
  if (args.limit)  parts.push(writeVarintField(12, args.limit));
  if (typeof args.content === 'string') parts.push(writeStringField(4, args.content));
  return Buffer.concat(parts);
}

function buildRunCommandBody(args) {
  const parts = [];
  if (args.command_line) parts.push(writeStringField(23, args.command_line));
  if (args.cwd) parts.push(writeStringField(2, args.cwd));
  if (args.blocking) parts.push(writeBoolField(11, true));
  if (typeof args.stdout === 'string') parts.push(writeStringField(4, args.stdout));
  if (typeof args.stderr === 'string') parts.push(writeStringField(5, args.stderr));
  if (Number.isFinite(args.exit_code)) parts.push(writeVarintField(6, args.exit_code));
  // combined_output (field 21) — RunCommandOutput { full=1 }. The planner
  // reads this when reasoning about command results, so we mirror stdout
  // there in addition to the legacy stdout field.
  if (typeof args.full_output === 'string') {
    const inner = writeStringField(1, args.full_output);
    parts.push(writeMessageField(21, inner));
  }
  return Buffer.concat(parts);
}

function buildGrepSearchV2Body(args) {
  const parts = [];
  if (args.pattern) parts.push(writeStringField(2, args.pattern));
  if (args.path) parts.push(writeStringField(3, args.path));
  if (args.glob) parts.push(writeStringField(4, args.glob));
  if (args.output_mode) parts.push(writeStringField(5, args.output_mode));
  if (args.case_insensitive) parts.push(writeBoolField(10, true));
  if (args.multiline) parts.push(writeBoolField(13, true));
  if (args.type) parts.push(writeStringField(11, args.type));
  if (args.head_limit) parts.push(writeVarintField(12, args.head_limit));
  if (args.lines_after) parts.push(writeVarintField(6, args.lines_after));
  if (args.lines_before) parts.push(writeVarintField(7, args.lines_before));
  if (args.lines_both) parts.push(writeVarintField(8, args.lines_both));
  if (typeof args.raw_output === 'string') parts.push(writeStringField(15, args.raw_output));
  return Buffer.concat(parts);
}

function buildFindBody(args) {
  const parts = [];
  if (args.search_directory) parts.push(writeStringField(10, args.search_directory));
  if (args.pattern) parts.push(writeStringField(1, args.pattern));
  if (typeof args.raw_output === 'string') parts.push(writeStringField(11, args.raw_output));
  return Buffer.concat(parts);
}

function buildListDirectoryBody(args) {
  const parts = [];
  if (args.directory_path_uri) parts.push(writeStringField(1, args.directory_path_uri));
  // children (field 2, repeated string) — populated when emitting a fake
  // "we already listed this dir, here are the names" step on tool_result.
  if (Array.isArray(args.children)) {
    for (const c of args.children) parts.push(writeStringField(2, String(c)));
  }
  return Buffer.concat(parts);
}

function buildWriteToFileBody(args) {
  const parts = [];
  if (args.target_file_uri) parts.push(writeStringField(1, args.target_file_uri));
  if (Array.isArray(args.code_content)) {
    for (const line of args.code_content) parts.push(writeStringField(2, String(line)));
  }
  if (args.file_created) parts.push(writeBoolField(4, true));
  return Buffer.concat(parts);
}

const STEP_BODY_BUILDER = {
  view_file:       buildViewFileBody,
  run_command:     buildRunCommandBody,
  grep_search_v2:  buildGrepSearchV2Body,
  grep_search:     buildGrepSearchV2Body,
  find:            buildFindBody,
  list_directory:  buildListDirectoryBody,
  write_to_file:   buildWriteToFileBody,
  // propose_code is intentionally NOT registered — Edit currently goes
  // through emulation fallback even when bridge is on. Adding propose_code
  // requires shipping ActionSpec / ActionResult / DiffBlock encoders, which
  // is its own scope.
};

/**
 * Build a CortexTrajectoryStep proto carrying a completed cascade-side step.
 * Used to inject "the caller's tool result, expressed as if the planner
 * already ran the equivalent cascade tool" into
 * SendUserCascadeMessageRequest.additional_steps[9]. The planner sees a
 * trajectory that already contains the answer and continues reasoning from
 * there instead of asking again.
 *
 * Returns null if `kind` has no encoder (caller should fall back).
 */
export function buildAdditionalStep(kind, args) {
  const meta = CASCADE_STEP[kind];
  const builder = STEP_BODY_BUILDER[kind];
  if (!meta || !builder) return null;
  const body = builder(args || {});
  // CortexTrajectoryStep envelope: type=1, status=4, oneof step body
  return Buffer.concat([
    writeVarintField(1, meta.typeEnum),
    writeVarintField(4, CASCADE_STEP_STATUS_DONE),
    writeMessageField(meta.oneofField, body),
  ]);
}

// ─── Reverse: parse cascade trajectory step → OpenAI tool_call ────────
//
// CortexTrajectoryStep parser shared with windsurf.js parseTrajectorySteps.
// This module's variant focuses on the args side — given an already-parsed
// step (with the oneof body extracted), produce a {kind, args, observation}
// triple. windsurf.js handles the integer-tag pass; here we only decode the
// per-kind field schema.

function decodeViewFileStep(buf) {
  const f = parseFields(buf);
  return {
    absolute_path_uri: getField(f, 1, 2)?.value?.toString('utf8') || '',
    start_line: Number(getField(f, 2, 0)?.value || 0),
    end_line: Number(getField(f, 3, 0)?.value || 0),
    offset: Number(getField(f, 11, 0)?.value || 0),
    limit: Number(getField(f, 12, 0)?.value || 0),
    content: getField(f, 4, 2)?.value?.toString('utf8') || '',
    raw_content: getField(f, 9, 2)?.value?.toString('utf8') || '',
  };
}

function decodeRunCommandStep(buf) {
  const f = parseFields(buf);
  const decoded = {
    command_line: getField(f, 23, 2)?.value?.toString('utf8')
                || getField(f, 1, 2)?.value?.toString('utf8') || '',
    proposed_command_line: getField(f, 25, 2)?.value?.toString('utf8') || '',
    cwd: getField(f, 2, 2)?.value?.toString('utf8') || '',
    stdout: getField(f, 4, 2)?.value?.toString('utf8') || '',
    stderr: getField(f, 5, 2)?.value?.toString('utf8') || '',
    exit_code: getField(f, 6, 0)?.value,
  };
  // combined_output (RunCommandOutput { full=1 })
  const combined = getField(f, 21, 2);
  if (combined) {
    const c = parseFields(combined.value);
    const full = getField(c, 1, 2)?.value?.toString('utf8') || '';
    if (full) decoded.full_output = full;
  }
  return decoded;
}

function decodeGrepSearchV2Step(buf) {
  const f = parseFields(buf);
  return {
    pattern: getField(f, 2, 2)?.value?.toString('utf8') || '',
    path: getField(f, 3, 2)?.value?.toString('utf8') || '',
    glob: getField(f, 4, 2)?.value?.toString('utf8') || '',
    output_mode: getField(f, 5, 2)?.value?.toString('utf8') || '',
    lines_after: Number(getField(f, 6, 0)?.value || 0),
    lines_before: Number(getField(f, 7, 0)?.value || 0),
    lines_both: Number(getField(f, 8, 0)?.value || 0),
    case_insensitive: !!getField(f, 10, 0)?.value,
    multiline: !!getField(f, 13, 0)?.value,
    type: getField(f, 11, 2)?.value?.toString('utf8') || '',
    head_limit: Number(getField(f, 12, 0)?.value || 0),
    raw_output: getField(f, 15, 2)?.value?.toString('utf8') || '',
  };
}

function decodeFindStep(buf) {
  const f = parseFields(buf);
  return {
    search_directory: getField(f, 10, 2)?.value?.toString('utf8') || '',
    pattern: getField(f, 1, 2)?.value?.toString('utf8') || '',
    raw_output: getField(f, 11, 2)?.value?.toString('utf8') || '',
  };
}

function decodeListDirectoryStep(buf) {
  const f = parseFields(buf);
  return {
    directory_path_uri: getField(f, 1, 2)?.value?.toString('utf8') || '',
    children: getAllFields(f, 2)
      .filter(x => x.wireType === 2)
      .map(x => x.value.toString('utf8')),
  };
}

function decodeWriteToFileStep(buf) {
  const f = parseFields(buf);
  return {
    target_file_uri: getField(f, 1, 2)?.value?.toString('utf8') || '',
    code_content: getAllFields(f, 2)
      .filter(x => x.wireType === 2)
      .map(x => x.value.toString('utf8')),
    file_created: !!getField(f, 4, 0)?.value,
  };
}

const STEP_BODY_DECODER = {
  view_file:       decodeViewFileStep,
  run_command:     decodeRunCommandStep,
  grep_search_v2:  decodeGrepSearchV2Step,
  grep_search:     decodeGrepSearchV2Step,
  find:            decodeFindStep,
  list_directory:  decodeListDirectoryStep,
  write_to_file:   decodeWriteToFileStep,
};

/**
 * Given a CortexTrajectoryStep envelope (already parsed) and the caller's
 * declared tools[], emit an OpenAI-shaped tool_call:
 *
 *   { id, name, argumentsJson, observation }
 *
 * - `id` is synthesised from cascadeId + step index by the caller of this
 *   function (we don't have those handles here).
 * - `name` is the caller-visible OpenAI tool name (Read/Bash/Grep/...) —
 *   resolved via buildReverseLookup. Falls back to the cascade kind name
 *   when the caller didn't declare a matching tool, which lets the proxy
 *   STILL surface trajectory tool calls for diagnostic purposes.
 * - `argumentsJson` is `JSON.stringify(reverse(decoded))`.
 * - `observation` is the part of the step the planner already filled in
 *   (file content, command stdout, etc) — the proxy DROPS this when
 *   forwarding to the caller (the caller will run their own version) but
 *   it's exposed here so callers that want to short-circuit on cached
 *   results can detect them.
 */
export function decodeCascadeStepToToolCall(stepFields, kind, callerLookup) {
  const decoder = STEP_BODY_DECODER[kind];
  const meta = CASCADE_STEP[kind];
  if (!decoder || !meta) return null;
  const oneof = getField(stepFields, meta.oneofField, 2);
  if (!oneof) return null;
  const decoded = decoder(oneof.value);
  const candidates = callerLookup?.get(kind) || [];
  // Pick the caller's preferred name. If they declared multiple tools that
  // map onto this kind (rare — e.g., both Read and read_file) we use the
  // first one in declaration order, which matches what they'd get from
  // calling the same tool twice in their own code.
  const callerName = candidates[0] || kind;
  const reverseFn = TOOL_MAP[callerName]?.reverse || identityArgs;
  let args;
  try {
    args = reverseFn(decoded);
  } catch {
    args = decoded;
  }
  return {
    name: callerName,
    arguments: args,
    cascade_kind: kind,
    observation: decoded,
  };
}

// ─── Inject caller's tool history as additional_steps ───────────────
//
// When the caller's prior turns include role:"tool" messages (responses to
// tool_calls the assistant made), we want the planner to see a trajectory
// that already contains those steps with their results. This lets the
// planner reason from the post-tool state instead of re-asking.

/**
 * Translate a single OpenAI assistant turn { tool_calls, ...} + the
 * matching tool messages into an array of CortexTrajectoryStep buffers
 * suitable for SendUserCascadeMessageRequest.additional_steps[9].
 *
 * Inputs:
 *   - assistantMessage: { role:'assistant', tool_calls: [{id, function:{name, arguments}}, ...] }
 *   - toolResults: Map<tool_call_id, content_string>
 *
 * For each tool_call we look up the cascade kind, encode the call args
 * AS IF the planner had emitted them, and overlay the tool result onto
 * the step (e.g. view_file.content = result_string for Read). Any
 * tool_call whose name isn't in TOOL_MAP is skipped — those go through
 * the existing user-message tool_result emulation fallback.
 *
 * Returns: Buffer[] (each one already has the CortexTrajectoryStep
 * envelope baked in via buildAdditionalStep).
 */
export function buildAdditionalStepsFromHistory(messages) {
  if (!Array.isArray(messages) || !messages.length) return [];
  const out = [];

  // Index tool result content by tool_call_id for fast lookup.
  const toolResultById = new Map();
  for (const m of messages) {
    if (m?.role !== 'tool' || !m.tool_call_id) continue;
    const content = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content)
          ? m.content.filter(p => typeof p?.text === 'string').map(p => p.text).join('\n')
          : JSON.stringify(m.content ?? ''));
    toolResultById.set(m.tool_call_id, content);
  }

  for (const m of messages) {
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      const name = tc.function?.name;
      const entry = TOOL_MAP[name];
      if (!entry) continue;
      const args = safeJsonParse(tc.function?.arguments);
      let cascadeArgs;
      try { cascadeArgs = entry.forward(args); } catch { continue; }
      const observation = toolResultById.get(tc.id);
      if (typeof observation === 'string') {
        // Overlay the result onto the cascade step's "this is what came
        // back" field. Per-kind because the result field varies:
        //   view_file       → content (4)
        //   run_command     → full_output / stdout (proxied via combined_output)
        //   grep_search_v2  → raw_output (15)
        //   find            → raw_output (11)
        //   list_directory  → children (2, repeated)
        //   write_to_file   → file_created (4) ← bool, ignore content
        if (entry.kind === 'view_file') cascadeArgs.content = observation;
        else if (entry.kind === 'run_command') {
          cascadeArgs.full_output = observation;
          cascadeArgs.stdout = observation;
          cascadeArgs.exit_code = 0;
        } else if (entry.kind === 'grep_search_v2' || entry.kind === 'grep_search') {
          cascadeArgs.raw_output = observation;
        } else if (entry.kind === 'find') {
          cascadeArgs.raw_output = observation;
        } else if (entry.kind === 'list_directory') {
          cascadeArgs.children = observation
            .split(/\r?\n/)
            .map(s => s.trim())
            .filter(Boolean);
        }
      }
      const buf = buildAdditionalStep(entry.kind, cascadeArgs);
      if (buf) out.push(buf);
    }
  }
  return out;
}

// ─── Activation gate ────────────────────────────────────────────────

/**
 * Return true when the native bridge should be used for this request.
 * Currently env-flagged; once field-tested we'll flip the default and
 * gate it on per-model heuristics instead (e.g., GPT family always-on,
 * Anthropic/Gemini default-off because they already work via NO_TOOL+emul).
 */
export function shouldUseNativeBridge(tools, { modelKey = '', provider = '', route = '' } = {}) {
  if (process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF === '1') return false;
  const explicitOn = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE === '1';
  if (!canMapAllTools(tools)) return false;
  if (explicitOn) return true;
  // Auto-on: GPT family on Codex CLI / Responses route. That's the only
  // path where v2.0.64 emulation reliably fails (markers=none). Keep
  // Claude / Gemini on emulation — they already work and switching would
  // be a regression vector.
  const isGpt = String(provider).toLowerCase() === 'openai'
    || /^(?:gpt-|o3|o4)/i.test(String(modelKey).toLowerCase());
  if (isGpt && route === 'responses') return true;
  return false;
}
