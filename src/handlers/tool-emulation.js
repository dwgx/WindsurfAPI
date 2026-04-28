/**
 * Prompt-level tool-call emulation for Cascade.
 *
 * Cascade's protocol has no per-request slot for client-defined function
 * schemas (verified against exa.cortex_pb.proto — SendUserCascadeMessageRequest
 * fields 1-9, none accept tool defs; CustomToolSpec exists only as a trajectory
 * event type, not an input). To expose OpenAI-style tool-calling to clients
 * anyway, we serialise the client's `tools[]` into a text protocol the model
 * follows, then parse the emitted <tool_call>...</tool_call> blocks back out
 * of the cascade text stream.
 *
 * Protocol:
 *   - System preamble tells the model the exact emission format
 *   - One-line JSON inside <tool_call>{"name":"...","arguments":{...}}</tool_call>
 *   - On emit, stop generating (we close the response with finish_reason=tool_calls)
 *   - Tool results come back as role:"tool" messages; we fold them into
 *     synthetic user turns wrapped in <tool_result tool_call_id="...">...</tool_result>
 *     so the next cascade turn can see them.
 */

import { log } from '../config.js';

// User-message-level fallback preamble.
//
// MINIMAL by design. The proto-level tool_calling_section override
// (buildToolPreambleForProto) is authoritative and carries the full
// function schemas. This fallback is only a short pointer that exists so
// Cascade NO_TOOL-mode models which ignore SectionOverride (issue #22)
// still see that tools exist and how to emit them.
//
// Why tiny? An earlier full-schema version (~1600+ chars of
// `### FnName / parameters schema: / ```json {...}```` blocks prepended
// to the user message) was reliably flagged by Opus-class injection
// detectors as "a pasted Claude Code system prompt in the user turn".
// The SHAPE — a wall of `### ToolName` blocks with JSON schemas — is the
// signature of Claude Code's own system prompt, so when it appears in a
// user slot the model treats it as a prompt-injection attempt and
// refuses to call tools. Keeping the fallback to a single short line of
// prose avoids that misidentification while still telling #22 models
// the protocol and listing tool names for recognition.
//
// Hard constraints:
//   - Single paragraph, no `### …` headers, no fenced ```json blocks.
//   - No jailbreak vocab ("IGNORE", "for THIS request only", etc.).
//   - No `---` fences or `[bracketed titles]`.
//   - Keep total emitted length under ~512 chars even with many tools
//     (names only, no schemas).

/**
 * Serialize an OpenAI-format tools[] array into a text preamble block.
 * Returns '' if no tools present.
 *
 * This version is for user-message injection (legacy fallback).
 * Prefer buildToolPreambleForProto() for system-prompt-level injection.
 */
export function buildToolPreamble(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const names = [];
  for (const t of tools) {
    if (t?.type !== 'function' || !t.function?.name) continue;
    names.push(t.function.name);
  }
  if (!names.length) return '';
  // Deliberately compact: names only, no per-tool schemas. See the
  // "User-message-level fallback preamble" comment block at the top of
  // this module for the injection-shape rationale. Full schemas live
  // in the proto-level tool_calling_section override.
  const hints = [];
  const lowerNames = new Set(names.map(n => n.toLowerCase()));
  if (lowerNames.has('bash')) hints.push('For Bash, put the complete shell command in arguments.command.');
  if (lowerNames.has('read')) hints.push('For Read, put the exact path in arguments.file_path.');
  return `Tools available this turn: ${names.join(', ')}. To call one, emit a single-line block: <tool_call>{"name":"...","arguments":{...}}</tool_call>. ${hints.join(' ')} Otherwise answer directly in plain text. After the last <tool_call>, stop generating; the caller returns results in the next turn as <tool_result tool_call_id="...">...</tool_result>.`;
}

/**
 * System-prompt-level preamble for proto-level injection via
 * CascadeConversationalPlannerConfig.tool_calling_section (field 10).
 *
 * Unlike buildToolPreamble (which wraps in user-message-style fences),
 * this version is written as authoritative system instructions so the
 * model treats the tool definitions as first-class, not as a "user hint"
 * that the baked-in system prompt can override.
 */
const TOOL_PROTOCOL_SYSTEM_HEADER = `You have access to the following functions. To invoke a function, emit a block in this EXACT format:

<tool_call>{"name":"<function_name>","arguments":{...}}</tool_call>

Rules:
1. Each <tool_call>...</tool_call> block must fit on ONE line (no line breaks inside the JSON).
2. "arguments" must be a JSON object matching the function's parameter schema.
3. You MAY emit MULTIPLE <tool_call> blocks if the request requires calling several functions in parallel. Emit ALL needed calls consecutively, then STOP generating.
4. After emitting the last <tool_call> block, STOP. Do not write any explanation after it. The caller executes the functions and returns results wrapped in <tool_result tool_call_id="...">...</tool_result> tags in the next user turn.
5. NEVER say "I don't have access to tools" or "I cannot perform that action" — the functions listed below ARE your available tools.`;

// Behaviour suffix appended after the base rules, controlled by tool_choice.
const TOOL_CHOICE_SUFFIX = {
  // "auto" (default): prefer tools over direct answers when a tool is relevant
  auto: `
6. When a function is relevant to the user's request, you SHOULD call it rather than answering from memory. Prefer using a tool over guessing.`,
  // "required": MUST call at least one tool — never answer directly
  required: `
6. You MUST call at least one function for every request. Do NOT answer directly in plain text — always use a <tool_call>.`,
  // "none": never call tools (shouldn't normally reach here, but be safe)
  none: `
6. Do NOT call any functions. Answer the user's question directly in plain text.`,
};

function lowerToolName(t) {
  return String(t?.function?.name || '').trim().toLowerCase();
}

function toolSpecificRules(tools) {
  const names = new Set((tools || []).map(lowerToolName).filter(Boolean));
  const lines = [];
  if (names.has('bash')) {
    lines.push('- Bash: arguments MUST include the full command string in the "command" field. Preserve quotes, flags, pipes, redirections, and shell operators exactly as requested. Do not shorten, reinterpret, split, or ask for the command again when it was already provided.');
  }
  if (names.has('read')) {
    lines.push('- Read: use "file_path" exactly for the path argument. If the user gives a concrete path, copy that path exactly instead of substituting a workspace guess.');
  }
  if (names.has('write')) {
    lines.push('- Write: use "file_path" for the target path and "content" for bytes to write. Do not replace requested content with a summary or placeholder.');
  }
  if (names.has('edit') || names.has('multiedit')) {
    lines.push('- Edit/MultiEdit: preserve old_string/new_string text exactly, including whitespace and quotes. Do not paraphrase file edits.');
  }
  return lines;
}

/**
 * Resolve the OpenAI tool_choice parameter into a { mode, forceName } pair.
 *   tool_choice = "auto" | "required" | "none"
 *   tool_choice = { type: "function", function: { name: "X" } }
 */
function resolveToolChoice(tc) {
  if (!tc || tc === 'auto') return { mode: 'auto', forceName: null };
  if (tc === 'required' || tc === 'any') return { mode: 'required', forceName: null };
  if (tc === 'none') return { mode: 'none', forceName: null };
  if (typeof tc === 'object' && tc.function?.name) {
    return { mode: 'required', forceName: tc.function.name };
  }
  return { mode: 'auto', forceName: null };
}

/**
 * Build the proto-level tool_calling_section override.
 *
 * The optional `environment` parameter is a short multi-line summary of
 * authoritative environment facts extracted from the caller's request
 * (e.g. Claude Code's `<env>` block: working directory, git status,
 * platform). When provided, it is rendered BEFORE the tool protocol
 * header so the model treats those facts as ground truth rather than as
 * a user-message hint the baked-in Cascade planner system prompt could
 * override. This is the only reliable way to tell Opus "your real cwd is
 * X, not /tmp/windsurf-workspace" in a way that survives Cascade's
 * authoritative workspace prior. (#54 follow-up.)
 */
export function buildToolPreambleForProto(tools, toolChoice, environment) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const { mode, forceName } = resolveToolChoice(toolChoice);

  const lines = [];
  if (environment && typeof environment === 'string' && environment.trim()) {
    lines.push('## Environment facts');
    lines.push('The facts below are provided by the calling agent and describe the active execution context. Tool calls operate on these paths.');
    lines.push('');
    lines.push(environment.trim());
    lines.push('');
  }
  lines.push(TOOL_PROTOCOL_SYSTEM_HEADER);
  // Append the appropriate behaviour suffix
  lines.push(TOOL_CHOICE_SUFFIX[mode] || TOOL_CHOICE_SUFFIX.auto);
  if (forceName) {
    lines.push(`7. You MUST call the function "${forceName}". No other function and no direct answer.`);
  }
  const specificRules = toolSpecificRules(tools);
  if (specificRules.length) {
    lines.push('');
    lines.push('Tool argument fidelity rules:');
    lines.push(...specificRules);
  }
  lines.push('');
  lines.push('Available functions:');
  for (const t of tools) {
    if (t?.type !== 'function' || !t.function) continue;
    const { name, description, parameters } = t.function;
    lines.push('');
    lines.push(`### ${name}`);
    if (description) lines.push(description);
    if (parameters) {
      lines.push('Parameters:');
      lines.push('```json');
      lines.push(JSON.stringify(parameters, null, 2));
      lines.push('```');
    }
  }
  return lines.join('\n');
}

/**
 * Strip schema fields that are documentation-only. Keeps `type`, `enum`,
 * `properties`, `items`, `required`, `oneOf`, `anyOf`, `allOf`. Drops
 * `description`, `examples`, `default`, `title`, `$schema`, `additionalProperties`,
 * which are useful for full-fidelity validation but blow up the preamble
 * by 2-4x with no real impact on tool-call correctness.
 */
function stripSchemaDocs(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(stripSchemaDocs);
  const KEEP = new Set(['type', 'enum', 'properties', 'items', 'required', 'oneOf', 'anyOf', 'allOf', 'const', 'format']);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!KEEP.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      const props = {};
      for (const [pk, pv] of Object.entries(v)) props[pk] = stripSchemaDocs(pv);
      out[k] = props;
    } else if ((k === 'items' || k === 'oneOf' || k === 'anyOf' || k === 'allOf') && v) {
      out[k] = stripSchemaDocs(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function firstSentence(text) {
  if (typeof text !== 'string' || !text) return '';
  const trimmed = text.trim().split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  const m = trimmed.match(/^.{1,160}?[.!?](?=\s|$)/);
  return (m ? m[0] : trimmed.slice(0, 160)).trim();
}

function paramSignature(parameters) {
  if (!parameters || typeof parameters !== 'object' || !parameters.properties) return '';
  const required = new Set(Array.isArray(parameters.required) ? parameters.required : []);
  const parts = [];
  for (const [name, schema] of Object.entries(parameters.properties)) {
    const optional = required.has(name) ? '' : '?';
    let type = schema?.type || 'any';
    if (Array.isArray(type)) type = type.join('|');
    if (Array.isArray(schema?.enum) && schema.enum.length <= 6) {
      type = schema.enum.map(v => JSON.stringify(v)).join('|');
    }
    parts.push(`${name}${optional}: ${type}`);
  }
  return parts.join(', ');
}

/**
 * Schema-compact preamble: same shape as full, but strips schema docs and
 * minifies JSON. Saves ~40-60% with no loss of tool-call correctness.
 */
export function buildSchemaCompactToolPreambleForProto(tools, toolChoice, environment) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const { mode, forceName } = resolveToolChoice(toolChoice);
  const lines = [];
  if (environment && typeof environment === 'string' && environment.trim()) {
    lines.push('## Environment facts');
    lines.push('The facts below are provided by the calling agent and describe the active execution context. Tool calls operate on these paths.');
    lines.push('');
    lines.push(environment.trim());
    lines.push('');
  }
  lines.push(TOOL_PROTOCOL_SYSTEM_HEADER);
  lines.push(TOOL_CHOICE_SUFFIX[mode] || TOOL_CHOICE_SUFFIX.auto);
  if (forceName) {
    lines.push(`7. You MUST call the function "${forceName}". No other function and no direct answer.`);
  }
  const specificRules = toolSpecificRules(tools);
  if (specificRules.length) {
    lines.push('');
    lines.push('Tool argument fidelity rules:');
    lines.push(...specificRules);
  }
  lines.push('');
  lines.push('Available functions:');
  for (const t of tools) {
    if (t?.type !== 'function' || !t.function) continue;
    const { name, description, parameters } = t.function;
    lines.push('');
    lines.push(`### ${name}`);
    if (description) lines.push(firstSentence(description));
    if (parameters) {
      lines.push(`Params: ${JSON.stringify(stripSchemaDocs(parameters))}`);
    }
  }
  return lines.join('\n');
}

/**
 * Skinny preamble: name + one-line description + parameter signature
 * (`file_path: string, encoding?: string`). Drops full JSON schema. Last
 * stop before names-only — keeps enough for the model to know which
 * params each tool needs without paying the schema serialization cost.
 */
export function buildSkinnyToolPreambleForProto(tools, toolChoice, environment) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const { mode, forceName } = resolveToolChoice(toolChoice);
  const lines = [];
  if (environment && typeof environment === 'string' && environment.trim()) {
    lines.push('## Environment facts');
    lines.push(environment.trim());
    lines.push('');
  }
  lines.push(TOOL_PROTOCOL_SYSTEM_HEADER);
  lines.push(TOOL_CHOICE_SUFFIX[mode] || TOOL_CHOICE_SUFFIX.auto);
  if (forceName) {
    lines.push(`7. You MUST call the function "${forceName}". No other function and no direct answer.`);
  }
  const specificRules = toolSpecificRules(tools);
  if (specificRules.length) {
    lines.push('');
    lines.push('Tool argument fidelity rules:');
    lines.push(...specificRules);
  }
  lines.push('');
  lines.push('Available functions (signature shown; full JSON schemas omitted to fit upstream payload budget):');
  for (const t of tools) {
    if (t?.type !== 'function' || !t.function?.name) continue;
    const { name, description, parameters } = t.function;
    const sig = paramSignature(parameters);
    const desc = description ? firstSentence(description) : '';
    if (sig && desc) lines.push(`- ${name}(${sig}) — ${desc}`);
    else if (sig) lines.push(`- ${name}(${sig})`);
    else if (desc) lines.push(`- ${name}() — ${desc}`);
    else lines.push(`- ${name}()`);
  }
  return lines.join('\n');
}

/**
 * Compact, names-only proto preamble. Same protocol header + environment
 * block as `buildToolPreambleForProto`, but lists tools by name only and
 * drops every parameter schema. Used as a payload-budget fallback when a
 * caller (e.g. Claude Code with 30+ tools) would otherwise blow past the
 * upstream LS panel-state ceiling — see chat.js TOOL_PREAMBLE_MAX_BYTES.
 *
 * The model loses parameter-shape detail in this mode, so it must rely on
 * the tool names matching the calling agent's contract. Acceptable trade
 * because the alternative is the request failing with panel_state_missing
 * retries until the proxy gives up.
 */
export function buildCompactToolPreambleForProto(tools, toolChoice, environment) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const { mode, forceName } = resolveToolChoice(toolChoice);
  const names = [];
  for (const t of tools) {
    if (t?.type !== 'function' || !t.function?.name) continue;
    names.push(t.function.name);
  }
  if (!names.length) return '';

  const lines = [];
  if (environment && typeof environment === 'string' && environment.trim()) {
    lines.push('## Environment facts');
    lines.push('The facts below are provided by the calling agent and describe the active execution context. Tool calls operate on these paths.');
    lines.push('');
    lines.push(environment.trim());
    lines.push('');
  }
  lines.push(TOOL_PROTOCOL_SYSTEM_HEADER);
  lines.push(TOOL_CHOICE_SUFFIX[mode] || TOOL_CHOICE_SUFFIX.auto);
  if (forceName) {
    lines.push(`7. You MUST call the function "${forceName}". No other function and no direct answer.`);
  }
  const specificRules = toolSpecificRules(tools);
  if (specificRules.length) {
    lines.push('');
    lines.push('Tool argument fidelity rules:');
    lines.push(...specificRules);
  }
  lines.push('');
  lines.push(`Available functions: ${names.join(', ')}.`);
  lines.push('Parameter schemas are omitted in this preamble due to total tool-list size. Match each <tool_call> to the function name; the calling agent will validate argument shapes when it executes the call.');
  return lines.join('\n');
}

function safeParseJson(s) {
  if (typeof s !== 'string') return null;
  // Fast path
  try { return JSON.parse(s); } catch { /* fall through */ }
  // Lenient path — small models sometimes tack on a trailing `}`/`]` or
  // wrap the block in stray whitespace / code fences / BOM. Scan from the
  // first `{` or `[` and grab the first balanced block that parses. Seen
  // in the wild with claude-4.5-haiku emitting
  //   <tool_call>{"name":"read_file","arguments":{"path":"x"}}}</tool_call>
  // (note the triple `}`), which previously left the <tool_call> literal
  // in the response verbatim and broke client tool dispatch.
  const t = s.trim();
  const start = t.search(/[\[{]/);
  if (start < 0) return null;
  const open = t[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * Normalise an OpenAI messages[] array into a form Cascade understands.
 * - Prepends the tool preamble as a system message (or merges into the first system message)
 * - Rewrites role:"tool" messages as user turns with <tool_result> wrappers
 * - Rewrites assistant messages that carry tool_calls so the model sees its
 *   own prior emissions in the canonical <tool_call> format
 */
function contentTextForPreambleCheck(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content
    .filter(p => typeof p?.text === 'string')
    .map(p => p.text)
    .join('');
}

function prependPreambleToContent(content, preamble) {
  if (Array.isArray(content)) {
    return [{ type: 'text', text: `${preamble}\n\n` }, ...content];
  }
  const cur = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  return `${preamble}\n\n${cur}`;
}

export function normalizeMessagesForCascade(messages, tools, options = {}) {
  if (!Array.isArray(messages)) return messages;
  const injectUserPreamble = options.injectUserPreamble !== false;
  const out = [];

  for (const m of messages) {
    if (!m || !m.role) { out.push(m); continue; }

    if (m.role === 'tool') {
      const id = m.tool_call_id || 'unknown';
      const content = typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content ?? '');
      out.push({
        role: 'user',
        content: `<tool_result tool_call_id="${id}">\n${content}\n</tool_result>`,
      });
      continue;
    }

    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const parts = [];
      if (m.content) parts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      for (const tc of m.tool_calls) {
        const name = tc.function?.name || 'unknown';
        const args = tc.function?.arguments;
        const parsed = typeof args === 'string' ? (safeParseJson(args) ?? {}) : (args ?? {});
        parts.push(`<tool_call>${JSON.stringify({ name, arguments: parsed })}</tool_call>`);
      }
      out.push({ role: 'assistant', content: parts.join('\n') });
      continue;
    }

    out.push(m);
  }

  // Inject the preamble into the LAST user message that carries an actual
  // user query — NOT a synthetic <tool_result> wrapper. The proto-level
  // tool_calling_section / additional_instructions_section already carry
  // the authoritative tool protocol; the user-message fallback only exists
  // to bootstrap models that ignore the proto override on the very first
  // turn. Re-injecting it on every later turn (where the last user message
  // is a tool_result) makes Opus see a "Tools available this turn: …"
  // banner immediately before a tool_result block — which it reliably
  // pattern-matches as conversation truncation / prompt injection and
  // refuses to continue ("the conversation got mixed up — fragments of
  // tool output without a clear request"). Live-confirmed against Claude
  // Code v2.1.114 / Opus 4.7: by turn ~22 the model would emit 40KB+ of
  // confused prose with zero tool_calls and hit max_wait. Skipping the
  // preamble on tool_result turns lets Opus stay in tool-using mode for
  // the full conversation, matching native-Anthropic-API behaviour.
  const preamble = buildToolPreamble(tools);
  if (preamble && injectUserPreamble) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role !== 'user') continue;
      const cur = contentTextForPreambleCheck(out[i].content);
      // Skip synthetic tool_result-only turns; they are not a place to
      // re-introduce tools. (A user turn that happens to MENTION the
      // marker but also has real text is fine — only pure tool_result
      // wrappers are skipped.)
      if (/^\s*<tool_result\b/.test(cur)) break;
      out[i] = { ...out[i], content: prependPreambleToContent(out[i].content, preamble) };
      break;
    }
  }

  return out;
}

/**
 * Streaming parser for <tool_call>...</tool_call> blocks.
 *
 * Feed text deltas via .feed(delta). It returns:
 *   { text: string, toolCalls: Array<{id,name,argumentsJson}> }
 * where `text` is the portion safe to emit as a normal content delta (tool_call
 * markup stripped), and `toolCalls` is any fully-closed blocks detected in this
 * feed. Partial blocks across delta boundaries are held until the close tag
 * arrives. Partial OPEN tags at the buffer tail are also held back so we don't
 * accidentally leak `<tool_ca` to the client and then open a real block on the
 * next delta.
 */
const TOOL_PARSE_MODE = process.env.TOOL_PARSE_MODE || 'auto';

export class ToolCallStreamParser {
  constructor(options = {}) {
    this.buffer = '';
    this.inToolCall = false;
    this.inToolResult = false;
    this.inToolCode = false;
    this.inBareCall = false;
    this._totalSeen = 0;
    this.parseToolCode = options.parseToolCode !== false;
    this.parseBareJson = options.parseBareJson !== false;
  }

  _findClosingBrace() {
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inStr) { escaped = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      if (ch === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  _consumeJsonBlock(parseFn, pushTool, pushText) {
    if (this.buffer.length > 65_536) {
      log.warn(`ToolCallStreamParser: JSON block exceeds 65KB (${this.buffer.length} bytes), emitting as text`);
      pushText(this.buffer);
      this.buffer = '';
      return true;
    }
    const endIdx = this._findClosingBrace();
    if (endIdx === -1) return false;
    const jsonStr = this.buffer.slice(0, endIdx + 1);
    this.buffer = this.buffer.slice(endIdx + 1);
    const tc = parseFn(jsonStr);
    if (tc) {
      pushTool(tc);
    } else {
      pushText(jsonStr);
    }
    return true;
  }

  _parseToolCodeJson(jsonStr) {
    const parsed = safeParseJson(jsonStr);
    if (!parsed || typeof parsed.tool_code !== 'string') return null;
    const m = parsed.tool_code.match(/^([^(]+)\(([^]*)\)$/);
    if (!m) return null;
    const name = m[1].trim();
    let args = m[2].trim();
    if (args.startsWith('"') && args.endsWith('"')) args = `{"input":${args}}`;
    else if (!args.startsWith('{')) args = args ? `{"input":"${args}"}` : '{}';
    const parsedArgs = safeParseJson(args) || { input: args };
    log.debug(`ToolParser: matched tool_code format, name=${name}`);
    return {
      id: `call_tc_${this._totalSeen}_${Date.now().toString(36)}`,
      name,
      argumentsJson: JSON.stringify(parsedArgs),
    };
  }

  _parseBareToolCallJson(jsonStr) {
    const parsed = safeParseJson(jsonStr);
    if (!parsed || typeof parsed.name !== 'string' || !('arguments' in parsed)) return null;
    const args = parsed.arguments;
    const argsJson = typeof args === 'string' ? args : JSON.stringify(args ?? {});
    log.debug(`ToolParser: matched bare json format, name=${parsed.name}`);
    return {
      id: `call_${this._totalSeen}_${Date.now().toString(36)}`,
      name: parsed.name,
      argumentsJson: argsJson,
    };
  }

  feed(delta) {
    if (!delta) return { text: '', toolCalls: [], items: [] };
    this.buffer += delta;
    const safeParts = [];
    const doneCalls = [];
    const items = [];
    const pushText = (text) => {
      if (!text) return;
      safeParts.push(text);
      items.push({ type: 'text', text });
    };
    const pushTool = (toolCall) => {
      if (!toolCall) return;
      doneCalls.push(toolCall);
      items.push({ type: 'tool_call', toolCall });
      this._totalSeen++;
    };
    const TC_OPEN = '<tool_call>';
    const TC_CLOSE = '</tool_call>';
    const TR_PREFIX = '<tool_result';
    const TR_CLOSE = '</tool_result>';
    const TC_CODE = '{"tool_code"';
    const TC_BARE = '{"name"';

    while (true) {
      // ── Inside a <tool_result …>…</tool_result> block — discard body ──
      if (this.inToolResult) {
        const closeIdx = this.buffer.indexOf(TR_CLOSE);
        if (closeIdx === -1) break;
        this.buffer = this.buffer.slice(closeIdx + TR_CLOSE.length);
        this.inToolResult = false;
        continue;
      }

      // ── Inside a <tool_call>…</tool_call> block — parse JSON body ──
      if (this.inToolCall) {
        const closeIdx = this.buffer.indexOf(TC_CLOSE);
        if (closeIdx === -1) break;
        const body = this.buffer.slice(0, closeIdx).trim();
        this.buffer = this.buffer.slice(closeIdx + TC_CLOSE.length);
        this.inToolCall = false;

        const parsed = safeParseJson(body);
        if (parsed && typeof parsed.name === 'string') {
          const args = parsed.arguments;
          const argsJson = typeof args === 'string' ? args : JSON.stringify(args ?? {});
          log.debug(`ToolParser: matched xml format, name=${parsed.name}`);
          pushTool({
            id: `call_${this._totalSeen}_${Date.now().toString(36)}`,
            name: parsed.name,
            argumentsJson: argsJson,
          });
        } else {
          pushText(`<tool_call>${body}</tool_call>`);
        }
        continue;
      }

      // ── Inside a {"tool_code": "…"} block ──
      if (this.inToolCode) {
        if (!this._consumeJsonBlock(s => this._parseToolCodeJson(s), pushTool, pushText)) break;
        this.inToolCode = false;
        continue;
      }

      // ── Inside a bare {"name":"…","arguments":{…}} block ──
      if (this.inBareCall) {
        if (!this._consumeJsonBlock(s => this._parseBareToolCallJson(s), pushTool, pushText)) break;
        this.inBareCall = false;
        continue;
      }

      // ── Normal mode — scan for the next opening tag ──
      const mode = TOOL_PARSE_MODE;
      const tcIdx = (mode === 'auto' || mode === 'xml') ? this.buffer.indexOf(TC_OPEN) : -1;
      const trIdx = this.buffer.indexOf(TR_PREFIX);
      const tcCodeIdx = this.parseToolCode && (mode === 'auto' || mode === 'tool_code') ? this.buffer.indexOf(TC_CODE) : -1;
      const tcBareIdx = this.parseBareJson && (mode === 'auto' || mode === 'json') ? this.buffer.indexOf(TC_BARE) : -1;

      let nextIdx = -1;
      let tagType = null;
      const candidates = [];
      if (tcIdx !== -1) candidates.push({ idx: tcIdx, type: 'tc' });
      if (trIdx !== -1) candidates.push({ idx: trIdx, type: 'tr' });
      if (tcCodeIdx !== -1) candidates.push({ idx: tcCodeIdx, type: 'code' });
      if (tcBareIdx !== -1 && tcBareIdx !== tcCodeIdx) candidates.push({ idx: tcBareIdx, type: 'bare' });
      if (candidates.length) {
        candidates.sort((a, b) => a.idx - b.idx);
        nextIdx = candidates[0].idx;
        tagType = candidates[0].type;
      }

      if (nextIdx === -1) {
        let holdLen = 0;
        const holdPrefixes = [TC_OPEN, TR_PREFIX];
        if (this.parseToolCode) holdPrefixes.push(TC_CODE);
        if (this.parseBareJson) holdPrefixes.push(TC_BARE);
        for (const prefix of holdPrefixes) {
          const maxHold = Math.min(prefix.length - 1, this.buffer.length);
          for (let len = maxHold; len > 0; len--) {
            if (this.buffer.endsWith(prefix.slice(0, len))) {
              holdLen = Math.max(holdLen, len);
              break;
            }
          }
        }
        const emitUpto = this.buffer.length - holdLen;
        if (emitUpto > 0) pushText(this.buffer.slice(0, emitUpto));
        this.buffer = this.buffer.slice(emitUpto);
        break;
      }

      if (nextIdx > 0) pushText(this.buffer.slice(0, nextIdx));

      if (tagType === 'tc') {
        this.buffer = this.buffer.slice(nextIdx + TC_OPEN.length);
        this.inToolCall = true;
      } else if (tagType === 'tr') {
        const closeAngle = this.buffer.indexOf('>', nextIdx + TR_PREFIX.length);
        if (closeAngle === -1) {
          this.buffer = this.buffer.slice(nextIdx);
          break;
        }
        this.buffer = this.buffer.slice(closeAngle + 1);
        this.inToolResult = true;
      } else if (tagType === 'code') {
        this.buffer = this.buffer.slice(nextIdx);
        this.inToolCode = true;
      } else if (tagType === 'bare') {
        this.buffer = this.buffer.slice(nextIdx);
        this.inBareCall = true;
      }
    }

    return { text: safeParts.join(''), toolCalls: doneCalls, items };
  }

  flush() {
    const remaining = this.buffer;
    this.buffer = '';
    if (this.inToolCall) {
      this.inToolCall = false;
      return { text: `<tool_call>${remaining}`, toolCalls: [] };
    }
    if (this.inToolResult) {
      this.inToolResult = false;
      return { text: '', toolCalls: [] };
    }
    if (this.inToolCode) {
      this.inToolCode = false;
      const endIdx = this._findClosingBrace();
      if (endIdx !== -1) {
        const jsonStr = remaining.slice(0, endIdx + 1);
        const tail = remaining.slice(endIdx + 1);
        const tc = this._parseToolCodeJson(jsonStr);
        if (tc) { this._totalSeen++; return { text: tail, toolCalls: [tc] }; }
      }
      return { text: remaining, toolCalls: [] };
    }
    if (this.inBareCall) {
      this.inBareCall = false;
      const endIdx = this._findClosingBrace();
      if (endIdx !== -1) {
        const jsonStr = remaining.slice(0, endIdx + 1);
        const tail = remaining.slice(endIdx + 1);
        const tc = this._parseBareToolCallJson(jsonStr);
        if (tc) { this._totalSeen++; return { text: tail, toolCalls: [tc] }; }
      }
      return { text: remaining, toolCalls: [] };
    }
    // Fallback: detect any remaining tool_code patterns in leftover buffer
    const toolCalls = [];
    const cleaned = remaining.replace(/\{"tool_code"\s*:\s*"([^"]+?)\(([^]*?)\)"\s*\}/g, (_match, name, rawArgs) => {
      try {
        let args = rawArgs.replace(/\\"/g, '"').trim();
        if (args.startsWith('"') && args.endsWith('"')) args = `{"input":${args}}`;
        else if (!args.startsWith('{')) args = `{"input":"${args}"}`;
        const parsed = safeParseJson(args) || { input: args };
        toolCalls.push({
          id: `call_tc_${this._totalSeen}_${Date.now().toString(36)}`,
          name,
          argumentsJson: JSON.stringify(parsed),
        });
        this._totalSeen++;
      } catch {}
      return '';
    });
    return { text: toolCalls.length ? cleaned.trim() : remaining, toolCalls };
  }
}

/**
 * Run a complete (non-streamed) text through the parser in one shot.
 * Convenience wrapper for the non-stream response path.
 */
export function parseToolCallsFromText(text) {
  const parser = new ToolCallStreamParser();
  const a = parser.feed(text);
  const b = parser.flush();
  return {
    text: a.text + b.text,
    toolCalls: [...a.toolCalls, ...b.toolCalls],
  };
}

export function stripToolMarkupFromText(text) {
  const parser = new ToolCallStreamParser({ parseToolCode: false, parseBareJson: false });
  const a = parser.feed(text);
  const b = parser.flush();
  return a.text + b.text;
}
