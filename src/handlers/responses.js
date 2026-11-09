/**
 * POST /v1/responses - OpenAI Responses API compatibility layer.
 *
 * Translates Responses requests to the internal Chat Completions handler and
 * adapts Chat SSE chunks back into Responses SSE events.
 */

import { randomUUID } from 'crypto';
import { handleChatCompletions, normalizeOpenAIErrorType, connectErrorToHttp, hasPerUserScope } from './chat.js';
import { selectBackend } from '../backend-router.js';
import { findFilePartInMessages, unsupportedFilePartError } from '../devin-connect.js';
import { getResponse, putResponse, deleteResponse, isResponseStoreEnabled, wantsPersistence } from '../response-store.js';
import { safeLogValue } from '../log-safety.js';
import { log } from '../config.js';
import { SseFramer } from '../sse-framer.js';
import { createBoundedWriter, resolveMaxDrainWaitMs } from '../stream-writer.js';
import { buildToolNameMap, restoreToolName } from '../tool-names.js';
import { createToolIdAllocator, normalizeToolIdsInMessages, sanitizeToolId, toolHygieneEnabled } from '../tool-ids.js';
import { normalizeHistoryTail } from '../history-normalize.js';
import {
  forEachTool,
  hostedSearchUnsupported,
  isHostedSearchType,
  isServerSideToolType,
  serverSideToolUnsupported,
} from '../server-side-tools.js';

function genResponseId() {
  return 'resp_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

function genMessageId() {
  return 'msg_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

function genFunctionCallId() {
  return 'fc_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

function stringifyMaybe(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function safeJsonParse(value) {
  if (typeof value !== 'string' || !value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

// `toolOutput` — tool results (function_call_output / custom_tool_call_output
// `output`) are JSON payloads: an array with no typed content block keeps the
// pre-061d32f JSON rendering. Message content must NOT take that path —
// stringifying `[{text:'hi'}]` into the literal `'[{"text":"hi"}]'` fed the
// model JSON junk instead of the text, and stringifying `[{}]` / `[null]`
// masked an empty turn from the shared tail guard that already 400s those
// shapes on /v1/chat/completions. Message arrays run through the part loop
// below instead, whose own rule is: string parts and `{text}` parts become
// text parts, nulls are skipped, and a textless array falls through to the
// guard as an empty turn. The string case is a deliberate divergence from the
// chat surface — its empty-content guard counts only `p.text` and typed
// non-text parts (chat.js:3016-3019), so a newest-turn `["hi"]` answers 400
// there while this converter materialises it as text. The `{text}` case does
// match the chat layer (the guard counts it; the cascade flattener reads it,
// client.js:133-134). Unify only with a measurement, not by editing a pin.
function normalizeMessageContent(content, { toolOutput = false } = {}) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return stringifyMaybe(content);

  // A zero-length content array means "no content", not the two-character
  // string "[]". JSON.stringify([]) used to send that literal junk upstream
  // and slip past the shared empty-user 400 (predicate B); the Responses
  // surface must reach the same guard as the chat surface.
  // See docs/REQUEST-TAIL-CONTRACT.md.
  if (content.length === 0) return '';

  const hasContentBlock = content.some(part => part && typeof part === 'object' && typeof part.type === 'string');
  if (!hasContentBlock && toolOutput) {
    return stringifyMaybe(content);
  }

  const out = [];
  for (const part of content) {
    if (!part) continue;
    if (typeof part === 'string') {
      out.push({ type: 'text', text: part });
      continue;
    }
    if (typeof part !== 'object') continue;
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      out.push({ type: 'text', text: part.text || '' });
    } else if (part.type === 'input_image') {
      // H-1 (ultracode audit 2026-07-13): Responses API `input_image.image_url`
      // is a STRING (a URL or a `data:` base64 URI). Downstream image extractors
      // (image.js:568, devin-connect.js:210) read `block.image_url?.url`, so a
      // bare string yields `.url === undefined` → 0 images extracted → the model
      // is told "there's an image" (hasMultimodalContent is truthy on the
      // non-empty string) but silently answers blind. Normalize to the standard
      // Chat-Completions object shape `{ image_url: { url, detail? } }` so the
      // whole vision chain works for both string and (defensively) object forms.
      const raw = part.image_url;
      const url = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? (raw.url || '') : '');
      if (url) {
        const img = { url };
        if (part.detail) img.detail = part.detail;
        else if (raw && typeof raw === 'object' && raw.detail) img.detail = raw.detail;
        out.push({ type: 'image_url', image_url: img });
      } else {
        out.push(part);
      }
    } else if (part.type === 'input_file' || part.type === 'file' || part.type === 'document') {
      // P-03: keep the typed file/document block intact. Cascade's
      // image.js:extractImages turns PDF data URLs into model-visible text;
      // the Devin Connect path has no attachment field, so responsesToChat
      // rejects the request below when that backend is selected instead of
      // letting messageText() flatten the block to ''. Never drop it here:
      // that would also hide the block from Cascade.
      //
      // Responses `input_file` puts `file_data` / `filename` at the TOP level;
      // Chat Completions nests them under `file`, which is the only shape
      // image.js:extractImages reads. Normalise the Responses shape so Cascade
      // does not skip the canonical payload.
      if (!part.file && (part.file_data || part.file_id || part.filename)) {
        const file = {};
        if (part.filename) file.filename = part.filename;
        if (part.file_data) file.file_data = part.file_data;
        if (part.file_id) file.file_id = part.file_id;
        out.push({ ...part, file });
      } else {
        out.push(part);
      }
    } else if (typeof part.type !== 'string' && typeof part.text === 'string') {
      // Untyped part carrying text. The shared chat layer already coerces this
      // shape (its guard counts `p.text`; the wire builder reads it), but
      // normalise it to a real text part here so typed-only downstream steps —
      // identity neutralisation (identity-neutralize.js:346) — still see it.
      out.push({ type: 'text', text: part.text });
    } else {
      out.push(part);
    }
  }
  return out.length ? out : '';
}

// The tool-type predicates and refusal messages live in ../server-side-tools.js
// so /v1/chat/completions decides with the exact same set (F3).

/**
 * Walk a tool list (namespaces included) and refuse hosted search.
 * Called for `body.tools` and for every `additional_tools` input item.
 */
function assertNoHostedSearchTools(tools, param = 'tools') {
  forEachTool(tools, tool => {
    if (isHostedSearchType(tool.type)) throw hostedSearchUnsupported(param);
  });
}

/**
 * Scan the RAW request. `collectResponseTools` filters `additional_tools`
 * through responseLiteClientTool, which drops unknown types — a hosted search
 * hidden there must still be rejected, not silently discarded.
 */
function assertNoHostedSearchInRequest(body) {
  assertNoHostedSearchTools(body?.tools);
  if (!Array.isArray(body?.input)) return;
  for (const item of body.input) {
    if (item?.type === 'additional_tools') assertNoHostedSearchTools(item.tools, 'input');
  }
}

/**
 * Walk a tool list (namespaces included) and refuse server-executed tools.
 * Called for `body.tools` and for every `additional_tools` input item.
 */
function assertNoServerSideTools(tools, param = 'tools') {
  forEachTool(tools, tool => {
    if (isServerSideToolType(tool.type)) throw serverSideToolUnsupported(tool.type, param);
  });
}

/**
 * Scan the RAW request for the same reason as assertNoHostedSearchInRequest:
 * `responseLiteClientTool` discards any non-function/custom/namespace entry
 * before the flatten step, so a server-executed tool hidden in
 * `additional_tools` would otherwise vanish without the 400.
 */
function assertNoServerSideToolsInRequest(body) {
  assertNoServerSideTools(body?.tools);
  if (!Array.isArray(body?.input)) return;
  for (const item of body.input) {
    if (item?.type === 'additional_tools') assertNoServerSideTools(item.tools, 'input');
  }
}

/**
 * A `tool_choice` naming a tool this proxy cannot execute is a 400, never a
 * silent downgrade: dropping the choice (or the tool) leaves the caller unable
 * to tell its forced tool was discarded.
 */
function assertSupportedToolChoice(toolChoice) {
  if (!toolChoice || typeof toolChoice !== 'object') return;
  if (isHostedSearchType(toolChoice.type)) throw hostedSearchUnsupported('tool_choice');
  if (isServerSideToolType(toolChoice.type)) {
    throw serverSideToolUnsupported(toolChoice.type, 'tool_choice');
  }
}

// OpenAI's metadata contract. Kept next to the validator rather than in the store
// so the HTTP boundary and the store's defence-in-depth caps can be read together.
const METADATA_MAX_KEYS = 16;
const METADATA_MAX_KEY_CHARS = 64;
const METADATA_MAX_VALUE_CHARS = 512;

function invalidMetadata(detail) {
  const error = new Error(`Invalid 'metadata': ${detail}.`);
  error.type = 'invalid_request_error';
  error.param = 'metadata';
  error.code = 'invalid_metadata';
  return error;
}

/**
 * Validate and copy the request's `metadata` map (DataAuditTools F4).
 *
 * `metadata` is a top-level Responses parameter whose only purpose is the ECHO: a
 * client tags a request (trace id, tenant) and reads the tag back off the response
 * object, including from a later GET. Nothing on this route read it, so the tag
 * vanished behind a 200 with no signal — the exact silent-drop failure this file
 * refuses elsewhere for tools and tool_choice.
 *
 * Validated rather than normalized, because the OpenAI contract is explicit (a
 * flat map of at most 16 string pairs, keys <= 64 chars, values <= 512 chars) and
 * coercing or truncating would change the caller's data while still claiming to
 * echo it. `undefined`/`null` mean "no metadata": absence stays absent on the
 * response object.
 *
 * Values are never logged. The error messages name the rule and the field, never
 * the payload.
 */
export function normalizeResponseMetadata(metadata) {
  if (metadata == null) return undefined;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw invalidMetadata('expected an object mapping string keys to string values');
  }
  const keys = Object.keys(metadata);
  if (keys.length > METADATA_MAX_KEYS) {
    throw invalidMetadata(`at most ${METADATA_MAX_KEYS} key-value pairs are allowed, got ${keys.length}`);
  }
  // An EMPTY map is not a tag. Reporting it as absent keeps the POST and the later
  // GET identical (the store has no slot for zero entries) instead of echoing `{}`
  // once and omitting it the next time the same response is read.
  if (!keys.length) return undefined;
  const out = {};
  for (const key of keys) {
    if (!key) throw invalidMetadata('keys must be non-empty strings');
    if (key.length > METADATA_MAX_KEY_CHARS) {
      throw invalidMetadata(`keys must be at most ${METADATA_MAX_KEY_CHARS} characters`);
    }
    const value = metadata[key];
    if (typeof value !== 'string') {
      throw invalidMetadata(`the value for '${key}' must be a string`);
    }
    if (value.length > METADATA_MAX_VALUE_CHARS) {
      throw invalidMetadata(`values must be at most ${METADATA_MAX_VALUE_CHARS} characters`);
    }
    // defineProperty, not assignment: a key literally named `__proto__` is an own
    // data property here instead of a prototype write.
    Object.defineProperty(out, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return out;
}

function encodeToolName(name, namespace = '') {
  const toolName = name || 'unknown';
  if (!namespace) return toolName;
  return namespace.endsWith('__') ? `${namespace}${toolName}` : `${namespace}__${toolName}`;
}

function flattenResponseTool(tool, inheritedNamespace = '') {
  if (!tool) return [];

  if (tool.type === 'namespace') {
    const namespace = tool.name || tool.namespace || inheritedNamespace || '';
    const children = tool.tools || tool.children || tool.functions || tool.items || [];
    if (!Array.isArray(children)) return [];
    return children.flatMap(child => flattenResponseTool(child, namespace));
  }

  if (tool.type === 'function') {
    const base = tool.function || tool;
    const originalName = base.name || tool.name || 'unknown';
    return [{
      type: 'function',
      function: {
        name: encodeToolName(originalName, inheritedNamespace),
        description: base.description || tool.description || '',
        parameters: base.parameters || tool.parameters || {},
      },
      __response_tool: {
        type: inheritedNamespace ? 'namespace' : 'function',
        namespace: inheritedNamespace || '',
        originalName,
      },
    }];
  }

  if (tool.type === 'custom') {
    const base = tool.function || tool;
    const originalName = base.name || tool.name;
    if (!originalName) return [];
    return [{
      type: 'function',
      function: {
        name: encodeToolName(originalName, inheritedNamespace),
        description: base.description || tool.description || '',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            input: {
              type: 'string',
              description: 'Raw custom tool input.',
            },
          },
          required: ['input'],
        },
      },
      __response_tool: {
        type: 'custom',
        namespace: inheritedNamespace || '',
        originalName,
      },
    }];
  }

  if (tool.type === 'tool_search') {
    return [{
      type: 'function',
      function: {
        name: encodeToolName('tool_search', inheritedNamespace),
        description: tool.description || 'Search available tools.',
        parameters: {
          type: 'object',
          additionalProperties: true,
          properties: {
            query: {
              type: 'string',
              description: 'Tool search query.',
            },
          },
        },
      },
      __response_tool: {
        type: 'tool_search',
        namespace: inheritedNamespace || '',
        originalName: 'tool_search',
      },
    }];
  }

  // Every server-executed type was refused up front (assertNoServerSideTools),
  // so anything reaching here is genuinely unknown to this bridge. Keep the
  // historical leniency — warn, drop, no 500 — but never pretend it was
  // forwarded.
  log.warn(`responses: dropping unknown tool type "${tool.type}"`);
  return [];
}

// Canonical (key-order-independent) JSON serialization. Two objects that are
// semantically equal but whose keys were emitted in a different order (e.g. a
// tool mirrored across top-level `tools` and `input[].additional_tools`, each
// side built by a different serializer) MUST compare equal here — otherwise the
// dedup below would flag them as a name conflict and reject a legitimate request
// with a 400. `flattenResponseTool` passes `parameters` through by reference, so
// its inner key order is NOT normalized upstream; we normalize it at comparison
// time by recursively sorting object keys. Arrays normally keep their order
// (significant), EXCEPT JSON-Schema keys whose array value is semantically
// UNORDERED — `required` and `enum`. Two tools identical except for the order of
// their `required`/`enum` entries are the same tool; without sorting them, the
// dedup below would flag them as a name conflict and 400 a legitimate request
// (the array-order residue of the #217 key-order fix). Sorting here only affects
// the equality comparison, never the schema actually forwarded upstream.
const UNORDERED_SCHEMA_ARRAY_KEYS = new Set(['required', 'enum']);
function stableStringify(value, parentKey = '') {
  if (Array.isArray(value)) {
    const parts = value.map(v => stableStringify(v));
    if (UNORDERED_SCHEMA_ARRAY_KEYS.has(parentKey)) parts.sort();
    return '[' + parts.join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableStringify(value[k], k)).join(',') + '}';
  }
  return JSON.stringify(value);
}

function flattenResponseTools(tools = []) {
  if (!Array.isArray(tools)) return [];
  const flattened = tools.flatMap(tool => flattenResponseTool(tool));
  const unique = [];
  const seen = new Map();
  for (const tool of flattened) {
    const name = tool.function?.name || tool.name || '';
    // Compare canonical forms so cosmetic key-order (and required/enum array-order)
    // differences don't masquerade as a genuine same-name/different-definition conflict.
    const serialized = stableStringify(tool);
    if (seen.has(name)) {
      if (seen.get(name) !== serialized) throw new Error(`Ambiguous Responses tool name after flattening: ${name}`);
      continue;
    }
    seen.set(name, serialized);
    unique.push(tool);
  }
  return unique;
}

function responseLiteClientTool(tool) {
  if (!tool || typeof tool !== 'object') return null;
  if (tool.type === 'function' || tool.type === 'custom') return tool;
  if (tool.type !== 'namespace') return null;
  const childKey = ['tools', 'children', 'functions', 'items'].find(key => Array.isArray(tool[key]));
  const children = childKey ? tool[childKey].map(responseLiteClientTool).filter(Boolean) : [];
  return { ...tool, [childKey || 'tools']: children };
}

function collectResponseTools(body) {
  const tools = Array.isArray(body?.tools) ? [...body.tools] : [];
  if (!Array.isArray(body?.input)) return tools;
  for (const item of body.input) {
    if (item?.type !== 'additional_tools' || !Array.isArray(item.tools)) continue;
    tools.push(...item.tools.map(responseLiteClientTool).filter(Boolean));
  }
  return tools;
}

function responseItemToolName(item, toolNameMap = null) {
  const encoded = encodeToolName(item.name || item.function?.name || 'unknown', item.namespace || '');
  return toolNameMap?.toUpstream?.get(encoded) ?? encoded;
}
function normalizeResponseToolChoice(toolChoice) {
  if (toolChoice == null) return toolChoice;
  if (toolChoice === 'auto' || toolChoice === 'required' || toolChoice === 'none') return toolChoice;
  if (typeof toolChoice !== 'object') return toolChoice;
  if (toolChoice.type === 'tool_search') return 'auto';
  if (toolChoice.type === 'function' && (toolChoice.function?.name || toolChoice.name)) {
    return {
      type: 'function',
      function: {
        name: encodeToolName(toolChoice.function?.name || toolChoice.name, toolChoice.function?.namespace || toolChoice.namespace || ''),
      },
    };
  }
  if ((toolChoice.type === 'custom' || toolChoice.type === 'namespace') && (toolChoice.name || toolChoice.function?.name)) {
    return {
      type: 'function',
      function: {
        name: encodeToolName(toolChoice.name || toolChoice.function?.name, toolChoice.namespace || toolChoice.function?.namespace || ''),
      },
    };
  }
  return toolChoice;
}

function requestedResponseToolChoiceName(toolChoice) {
  if (!toolChoice || typeof toolChoice !== 'object') return '';
  if (toolChoice.type === 'function') {
    return encodeToolName(toolChoice.function?.name || toolChoice.name || '', toolChoice.function?.namespace || toolChoice.namespace || '');
  }
  if (toolChoice.type === 'custom' || toolChoice.type === 'namespace') {
    return encodeToolName(toolChoice.name || toolChoice.function?.name || '', toolChoice.namespace || toolChoice.function?.namespace || '');
  }
  if (toolChoice.type === 'tool_search') return 'tool_search';
  return toolChoice.name || toolChoice.function?.name || toolChoice.type || '';
}

function pruneResponseToolChoice(toolChoice, forwardedTools) {
  const normalized = normalizeResponseToolChoice(toolChoice);
  if (normalized == null) return undefined;
  const forwardedCount = Array.isArray(forwardedTools) ? forwardedTools.length : 0;
  if (normalized === 'none') return normalized;
  if (normalized === 'auto') return forwardedCount ? normalized : undefined;
  if (normalized === 'required') {
    if (!forwardedCount) {
      const err = new Error("Invalid 'tool_choice': tool_choice 'required' cannot be satisfied because no executable tools remain.");
      err.param = 'tool_choice';
      err.code = 'tool_choice_tool_not_declared';
      throw err;
    }
    return normalized;
  }

  const requested = requestedResponseToolChoiceName(toolChoice);
  const availableNames = new Set((forwardedTools || []).map(t => t.function?.name || t.name).filter(Boolean));
  const forcedName = normalized.function?.name || '';
  if (forcedName) {
    if (availableNames.has(forcedName)) return normalized;
    // A07/KH-003: never drop a forced choice. The caller asked for a specific
    // tool; continuing auto would hide that the tool was unavailable.
    const err = new Error(`Invalid 'tool_choice': function '${requested || forcedName}' not found in 'tools'.`);
    err.param = 'tool_choice';
    err.code = 'tool_choice_tool_not_declared';
    throw err;
  }

  // A forced server-executed tool_choice never reaches this point:
  // responsesToChat throws `unsupported_server_side_tool` for it up front, since
  // silently dropping the choice left the model free to answer as if the client
  // had not asked for that tool at all.
  return normalized;
}

function normalizeResponseTextFormat(format) {
  if (!format || typeof format !== 'object') return null;
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type !== 'json_schema') return null;
  const nested = format.json_schema && typeof format.json_schema === 'object'
    ? format.json_schema
    : null;
  const schema = format.schema || nested?.schema;
  if (!schema) return null;
  return {
    type: 'json_schema',
    json_schema: {
      name: format.name || nested?.name || 'response',
      schema,
      strict: format.strict ?? nested?.strict ?? false,
    },
  };
}


export function responsesToChat(body) {
  const messages = [];
  // Validated here, where every other request field is read, and carried on the
  // result as an internal field: `metadata` is not forwarded upstream (the chat
  // surface has no such parameter), so the response object is the only place it
  // can survive.
  const metadata = normalizeResponseMetadata(body.metadata);
  const requestedTools = collectResponseTools(body);
  // No hosted-search or server-executed executor exists on this route (see
  // ../server-side-tools.js). Refuse BEFORE calling the model: letting the turn
  // run and then reporting the proposal as a completed search is exactly the
  // false execution receipt this gate removes, and letting it run with the tool
  // silently dropped is the same failure without the receipt.
  assertNoHostedSearchInRequest(body);
  assertNoServerSideToolsInRequest(body);
  assertSupportedToolChoice(body.tool_choice);
  const tools = flattenResponseTools(requestedTools);
  const toolNameMap = toolHygieneEnabled()
    ? buildToolNameMap(tools.map((t) => t.function?.name || t.name).filter(Boolean))
    : null;
  const hasNameRewrites = toolNameMap
    ? [...toolNameMap.toUpstream].some(([client, wire]) => client !== wire)
    : false;
  // How many LEADING messages came from the request-level `instructions` field
  // (as opposed to an `input` conversation item). Reported on the result rather
  // than tagged onto the message objects: those get deep-compared in tests and
  // shipped upstream, so they must stay pristine.
  let instructionsLead = 0;
  // G01 (input side): a replayed `reasoning` item carries the previous turn's
  // summary text and, when the client asked for it, the opaque blob this route
  // emitted as `encrypted_content`. The Connect builder consumes that pair as
  // signed thinking on the assistant frame it precedes (#11 text + #12
  // signature — see devin-connect.js `signedThinking`), so the item is buffered
  // and attached to the NEXT assistant message instead of vanishing.
  let pendingReasoning = null;
  const attachPendingReasoning = (message) => {
    if (!pendingReasoning) return message;
    const { text, signature, signedSegments, unsignedText } = pendingReasoning;
    pendingReasoning = null;
    if (text) message.reasoning_content = text;
    // A signature seals exactly `text`; without the text it seals nothing, and
    // two signed segments cannot ride one assistant frame (the Connect decoder
    // drops the signature for the same reason — `multipleSignedSegments`).
    // `unsignedText` means some replayed item contributed summary text with no
    // blob: the accumulated `text` is then a superset of what the single
    // surviving signature sealed, and attaching it would claim coverage the
    // blob never had — same lie as the two-signature mix, so it is dropped.
    //
    // It is ALSO withheld from a turn that carries tool_calls: when
    // signed-thinking replay is enabled in prompt-emulation mode, the chat layer
    // refuses exactly that shape with 400
    // `signed_thinking_tool_history_unsupported` (chat.js) — and a Codex
    // `store:false` replay puts every reasoning item before a tool call. The
    // summary text still rides the turn; the signature is dropped rather than
    // turning the default path into a 400.
    const signedToolTurn = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (text && signature && signedSegments === 1 && !unsignedText && !signedToolTurn) {
      message.reasoning_signature = signature;
    }
    return message;
  };
  const flushToolCalls = (() => {
    let pending = [];
    return {
      add(item) {
        pending.push({
          id: item.call_id || item.id || `call_${randomUUID().slice(0, 8)}`,
          type: 'function',
          function: {
            name: responseItemToolName(item, toolNameMap),
            arguments: stringifyMaybe(item.arguments ?? item.function?.arguments ?? ''),
          },
        });
      },
      flush() {
        if (!pending.length) return;
        const message = attachPendingReasoning({ role: 'assistant', content: null, tool_calls: pending });
        pending = [];
        messages.push(message);
      },
    };
  })();

  if (body.instructions) {
    // Counted (see instructionsLead) so the caller can tell a REQUEST-LEVEL
    // instructions block apart from a system/developer message that arrived as a
    // conversation ITEM. Per the Responses contract the former does not carry over
    // across previous_response_id; the latter is part of the conversation and does.
    // The count rides the returned object, never the message — message objects get
    // deep-compared in tests and shipped upstream, so they stay pristine.
    messages.push({ role: 'system', content: stringifyMaybe(body.instructions) });
    instructionsLead = 1;
  }

  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== 'object') continue;
      // OpenAI Responses API input items may be bare {role, content} objects (no
      // explicit `type: "message"`) — Codex sends them this way. Treat any item
      // carrying a `role` (and no tool-oriented `type`) as a message so it isn't
      // silently dropped (which produced an empty messages array upstream →
      // UPSTREAM_INTERNAL). (PR #219, @forrinzhao)
      if (item.type === 'message' || (item.role && !item.type)) {
        flushToolCalls.flush();
        // `developer` is the OpenAI o-series / Codex system channel (its primary
        // instruction role, e.g. AGENTS.md / environment context). Map it to
        // `system` so it keeps system priority downstream AND passes through
        // neutralizeClientIdentity (which only inspects role:'system') — otherwise
        // a developer message carrying competitor-identity / policy wording would
        // both lose priority and bypass the 529 fingerprint gate. Matches kiro's
        // Codex developer→system mapping.
        const role = item.role === 'developer' ? 'system' : (item.role || 'user');
        const message = { role, content: normalizeMessageContent(item.content) };
        if (role === 'assistant') {
          messages.push(attachPendingReasoning(message));
        } else {
          // A user/system message opens a new turn: reasoning buffered before it
          // belongs to the previous one and must not leak forward.
          pendingReasoning = null;
          messages.push(message);
        }
      } else if (item.type === 'input_file' || item.type === 'file' || item.type === 'document') {
        // P-03: a file item sent at the top level of `input` (instead of inside
        // a message's content array) used to fall through every branch and
        // vanish before the backend saw it. Materialise it as a user content
        // part so Cascade can extract it and the Connect guard can reject it.
        flushToolCalls.flush();
        pendingReasoning = null;
        messages.push({ role: 'user', content: normalizeMessageContent([item]) });
      } else if (item.type === 'reasoning') {
        // G01 (input side): see pendingReasoning above. `summary` is the
        // human-readable text; `encrypted_content` is the opaque blob this route
        // emitted (absent/null when the upstream supplied none — keep it absent).
        const text = Array.isArray(item.summary)
          ? item.summary.map(part => (part && typeof part.text === 'string' ? part.text : '')).join('')
          : '';
        const signature = typeof item.encrypted_content === 'string' ? item.encrypted_content : '';
        if (text || signature) {
          if (!pendingReasoning) pendingReasoning = { text: '', signature: '', signedSegments: 0, unsignedText: false };
          pendingReasoning.text += text;
          if (signature) {
            pendingReasoning.signedSegments += 1;
            // Keep only one unambiguous signature: a second one cannot seal the
            // concatenated text.
            pendingReasoning.signature = pendingReasoning.signedSegments === 1 ? signature : '';
          } else if (text) {
            // Summary text with no blob: it can never be part of what a
            // signature seals, so its presence anywhere in the accumulated
            // text must disqualify the attach (see attachPendingReasoning).
            pendingReasoning.unsignedText = true;
          }
        }
      } else if (item.type === 'function_call') {
        flushToolCalls.add(item);
      } else if (item.type === 'function_call_output') {
        flushToolCalls.flush();
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || item.id,
          content: normalizeMessageContent(item.output ?? '', { toolOutput: true }),
        });
      } else if (item.type === 'custom_tool_call') {
        flushToolCalls.add({
          id: item.call_id || item.id,
          name: item.name,
          namespace: item.namespace,
          arguments: JSON.stringify({ input: stringifyMaybe(item.input) }),
        });
      } else if (item.type === 'custom_tool_call_output') {
        flushToolCalls.flush();
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || item.id,
          content: normalizeMessageContent(item.output ?? '', { toolOutput: true }),
        });
      }
    }
    flushToolCalls.flush();
  }

  for (const t of tools) {
    if (t?.function?.name) t.function.name = toolNameMap?.toUpstream.get(t.function.name) ?? t.function.name;
  }
  const responseFormat = normalizeResponseTextFormat(body.text?.format);
  // G02: `text.verbosity` is a first-class Responses parameter and the chat
  // surface carries it as a top-level `verbosity`. Only a non-empty string is
  // forwarded; absence stays absent so a caller that never sent it is
  // unaffected. The OpenAI enum is low/medium/high, but this bridge passes any
  // non-empty string through verbatim: enum validation belongs to the upstream
  // contract, and a local 400 here would reject requests a permissive backend
  // might have served (compat risk — same policy as unknown `include` below).
  const textVerbosity = typeof body.text?.verbosity === 'string' && body.text.verbosity.trim()
    ? body.text.verbosity.trim()
    : null;
  // G01: `include` is response-side only (the chat wire has no such parameter),
  // so it rides the result as an internal field like the other bookkeeping below
  // and is stripped before dispatch. The supported subset is exactly
  // 'reasoning.encrypted_content'; every other include value is silently
  // ignored BY DESIGN — no local 400, same compat policy as verbosity above.
  const includeReasoningEncrypted = Array.isArray(body.include)
    && body.include.includes('reasoning.encrypted_content');
  let forwardedToolChoice = body.tool_choice != null
    ? pruneResponseToolChoice(body.tool_choice, tools)
    : undefined;
  if (forwardedToolChoice?.type === 'function' && forwardedToolChoice.function?.name) {
    forwardedToolChoice = {
      ...forwardedToolChoice,
      function: {
        ...forwardedToolChoice.function,
        name: toolNameMap?.toUpstream.get(forwardedToolChoice.function.name) ?? forwardedToolChoice.function.name,
      },
    };
  }

  return {
    model: body.model || 'claude-sonnet-4.6',
    messages,
    stream: !!body.stream,
    ...(body.max_output_tokens != null ? { max_tokens: body.max_output_tokens } : {}),
    ...(body.reasoning?.effort != null ? { reasoning_effort: body.reasoning.effort } : {}),
    ...(tools.length ? { tools } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.top_p != null ? { top_p: body.top_p } : {}),
    // F1 (DataAuditTools): `parallel_tool_calls` is a first-class Responses
    // parameter and a caller preference ("prefer one tool call per turn"). This
    // allow-list never read it, so the chat handler's decision — honour it when
    // DEVIN_CONNECT_TOOL_CHOICE=1, otherwise serve the request and count the drop —
    // was unreachable from this surface. Forward the caller's value; the chat
    // handler owns the decision and never refuses it (Codex 0.164 sends it on every
    // request, and a 400 there made the CLI unusable — evidence/CodexParallelFix.md).
    ...(body.parallel_tool_calls != null ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
    ...(forwardedToolChoice != null ? { tool_choice: forwardedToolChoice } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(textVerbosity ? { verbosity: textVerbosity } : {}),
    // Internal, stripped before the upstream call (same convention as __route).
    ...(instructionsLead ? { __instructionsLead: instructionsLead } : {}),
    ...(hasNameRewrites && toolNameMap ? { __toolNameMap: toolNameMap } : {}),
    ...(metadata ? { __responseMetadata: metadata } : {}),
    ...(includeReasoningEncrypted ? { __includeReasoningEncrypted: true } : {}),
  };
}

/**
 * Did the upstream report ANY token count?
 *
 * An upstream that says nothing and an upstream that reports zero are different
 * facts, and mapUsage cannot tell them apart once it has defaulted everything to 0.
 * Asked here, on the raw object, before any defaulting.
 */
function hasReportedUsage(usage) {
  if (!usage || typeof usage !== 'object') return false;
  return ['prompt_tokens', 'input_tokens', 'completion_tokens', 'output_tokens', 'total_tokens']
    .some(k => typeof usage[k] === 'number');
}

function mapUsage(usage = {}) {
  const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
  const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
  const totalTokens = usage.total_tokens || inputTokens + outputTokens;
  const promptDetails = usage.prompt_tokens_details || {};
  const completionDetails = usage.completion_tokens_details || {};
  const cachedTokens = promptDetails.cached_tokens || 0;
  const reasoningTokens = completionDetails.reasoning_tokens || 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    input_tokens_details: {
      text_tokens: promptDetails.text_tokens ?? Math.max(0, inputTokens - cachedTokens),
      audio_tokens: promptDetails.audio_tokens || 0,
      image_tokens: promptDetails.image_tokens || 0,
      cached_tokens: cachedTokens,
    },
    output_tokens_details: {
      text_tokens: completionDetails.text_tokens ?? Math.max(0, outputTokens - reasoningTokens),
      audio_tokens: completionDetails.audio_tokens || 0,
      reasoning_tokens: reasoningTokens,
    },
  };
}

function textMessageItem(id, text, status = 'completed') {
  return {
    type: 'message',
    id,
    status,
    role: 'assistant',
    content: text ? [{ type: 'output_text', text, annotations: [] }] : [],
  };
}

function reasoningItem(id, text, status = 'completed', encryptedContent = '') {
  return {
    type: 'reasoning',
    id,
    status,
    summary: text ? [{ type: 'summary_text', text }] : [],
    // G01: only ever a value the UPSTREAM supplied, and only when the caller
    // asked for it via include:["reasoning.encrypted_content"]. Nothing on this
    // bridge can produce that blob, so an absent upstream field stays absent —
    // an invented value would be replayed by the client as if the model had
    // produced it.
    ...(encryptedContent ? { encrypted_content: encryptedContent } : {}),
  };
}

/**
 * The opaque reasoning blob an upstream attached, if any.
 *
 * The Responses contract exposes it as `encrypted_content`, gated on
 * `include:["reasoning.encrypted_content"]`. Two carriers reach this bridge:
 * a chat-compatible upstream that emits `encrypted_content` directly, and the
 * Connect thinking signature (`reasoning_signature`) that seals the very same
 * reasoning text (the established signature carrier for this field — see the
 * openai-responses conversion table: `reasoning.encrypted_content` ↔
 * `thinking.signature`). Both are upstream-supplied opaque values; neither is
 * synthesized here.
 */
function upstreamEncryptedContent(source) {
  if (!source || typeof source !== 'object') return '';
  if (typeof source.encrypted_content === 'string' && source.encrypted_content) {
    return source.encrypted_content;
  }
  return typeof source.reasoning_signature === 'string' ? source.reasoning_signature : '';
}

/**
 * The `input` of a custom tool call as the client must see it: the RAW string,
 * not the `{"input":"…"}` envelope this bridge declares to the chat upstream.
 * Falls back to the arguments text when the upstream did not send that shape
 * (nothing is lost, and no value is invented).
 */
function customToolInput(argsText) {
  const parsed = safeJsonParse(argsText);
  return parsed && typeof parsed === 'object' && parsed.input != null
    ? stringifyMaybe(parsed.input)
    : argsText;
}

/**
 * Decode the longest COMPLETE prefix of the `input` string in a partially
 * streamed custom-tool argument object.
 *
 * Upstream streams `{"input":"…"}` a few characters at a time, so the raw input
 * the client is owed (`response.custom_tool_call_input.delta`) has to be
 * recovered incrementally: the closing quote may not have arrived yet and an
 * escape sequence can be split across chunks. Anything not yet decodable is
 * withheld (returns the prefix so far) — a guessed character would corrupt the
 * tool input the client executes. Returns '' when the value is not a JSON
 * string (e.g. `{"input":123}`), in which case only the final item carries it.
 */
function customToolInputPrefix(argsText) {
  if (typeof argsText !== 'string' || !argsText) return '';
  const match = /"input"\s*:\s*"/.exec(argsText);
  if (!match) return '';
  const simpleEscapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
  let out = '';
  for (let i = match.index + match[0].length; i < argsText.length; i++) {
    const ch = argsText[i];
    if (ch === '"') return out;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const esc = argsText[i + 1];
    if (esc === undefined) return out; // escape split across chunks
    if (esc === 'u') {
      const hex = argsText.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    if (!(esc in simpleEscapes)) return out; // unknown escape: stop at a safe boundary
    out += simpleEscapes[esc];
    i += 1;
  }
  return out;
}

function clientToolId(id) {
  return toolHygieneEnabled() ? sanitizeToolId(id) : (id || '');
}

function functionCallItem(toolCall, status = 'completed', requestedTools = [], toolNameMap = null, allocateId = null) {
  const wireName = toolCall.function?.name || 'unknown';
  const name = restoreToolName(wireName, toolNameMap) || wireName;
  const argsText = toolCall.function?.arguments || '';
  const requestedTool = Array.isArray(requestedTools)
    ? requestedTools.find(t => (t?.function?.name || t?.name) === wireName)
    : null;
  const responseTool = requestedTool?.__response_tool || null;
  // Upstream may reuse one call id for two distinct calls; the client must
  // never see the same call_id twice (GFProtocol Q1-04). The allocator keeps
  // the first id and suffixes later duplicates deterministically. An absent id
  // keeps this surface's historical generated fallback (per item type below).
  const callId = toolCall.id
    ? (allocateId ? allocateId(toolCall.id) : clientToolId(toolCall.id))
    : '';
  if (responseTool?.type === 'custom') {
    return {
      type: 'custom_tool_call',
      // Every output item carries an id; the streaming translator names its
      // custom_tool_call_input events with the same field, so both paths agree.
      id: genFunctionCallId(),
      call_id: callId || `call_${randomUUID().slice(0, 8)}`,
      name: responseTool.originalName || name,
      ...(responseTool.namespace ? { namespace: responseTool.namespace } : {}),
      input: customToolInput(argsText),
      status,
    };
  }
  // Hosted web_search is rejected in responsesToChat, so `__response_tool` with
  // type 'web_search' is never produced. If an older shape ever reaches here,
  // it falls through to the generic function_call below: a client-executed call
  // is truthful, a `web_search_call` claiming a completed search is not.
  return {
    type: 'function_call',
    id: genFunctionCallId(),
    call_id: callId || `call_${randomUUID().slice(0, 8)}`,
    name: responseTool?.originalName || name,
    ...(responseTool?.namespace ? { namespace: responseTool.namespace } : {}),
    arguments: argsText,
    status,
  };
}

/**
 * G3 (Q1 audit §7): the one message both exits report when the upstream closed a
 * turn without saying how it ended. The Connect decoder surfaces that shape as
 * `finish_reason:'error'` (an end-of-stream frame with a payload but no
 * stopReason); it must never reach a client as a clean completion.
 */
const UPSTREAM_UNTERMINATED_MESSAGE =
  'The upstream ended the turn without a completion reason (truncated response).';

export function chatToResponse(chatBody, requestedModel, responseId = genResponseId(), msgId = genMessageId(), requestedTools = [], toolNameMap = null, metadata = null, options = {}) {
  const choice = chatBody.choices?.[0] || {};
  const message = choice.message || {};
  const finishReason = choice.finish_reason || 'stop';
  // G3 (Q1 audit §7): the Connect decoder reports an end-of-stream frame that
  // carried an answer but NO stopReason as `finish_reason:'error'` (with
  // `unterminated:true` when the signal rides the choice). That is a FAILED
  // turn, not a finished one: closing it as `completed` — the old behaviour —
  // told the client a half answer was whole. `incomplete` is wrong too; it is
  // reserved for caller-imposed caps and benign content filters. Computed
  // before the output items are built so a failed turn cannot publish
  // item-level 'completed' entries inside a status:'failed' response.
  const upstreamUnterminated = finishReason === 'error' || choice.unterminated === true;
  const text = message.content || '';
  const output = [];
  // G01: the blob is emitted ONLY when the caller opted in through `include` and
  // the upstream actually supplied one. An upstream that sends reasoning without
  // it (this bridge's Connect path) yields no field at all — see reasoningItem.
  const encryptedContent = options.includeReasoningEncrypted ? upstreamEncryptedContent(message) : '';
  if (message.reasoning_content || encryptedContent) {
    output.push(reasoningItem('rs_' + msgId.slice(4), message.reasoning_content, 'completed', encryptedContent));
  }
  if (text) output.push(textMessageItem(msgId, text));
  // One allocator per turn: duplicate upstream call ids become distinct wire ids.
  const allocateCallId = toolHygieneEnabled() ? createToolIdAllocator() : null;
  for (const tc of (message.tool_calls || [])) output.push(functionCallItem(tc, upstreamUnterminated ? 'incomplete' : 'completed', requestedTools, toolNameMap, allocateCallId));

  // A turn that ends by emitting function calls is `completed` in the OpenAI
  // Responses API — `incomplete` is reserved for truncation (length /
  // content_filter). Both paths apply this same rule; the streaming translator
  // used to hardcode response.completed, which meant a truncated stream claimed to
  // be a finished answer while the identical non-stream request reported
  // incomplete. Verified after aligning them: a tool-call turn still closes as
  // `completed` on both paths, and only length / content_filter yields
  // `incomplete`.
  //
  // A06/KH-018: chat.js marks a Cascade poll truncation with
  // `_windsurf_end_reason:'upstream_truncated'`. That is NOT a caller-imposed
  // output cap — it means the upstream never finished the turn — so it must
  // report `upstream_incomplete` (not max_output_tokens) and must not be
  // committed to the response store (see commit() below).
  const upstreamTruncated = choice._windsurf_end_reason === 'upstream_truncated';
  const truncated = !upstreamUnterminated
    && (upstreamTruncated || finishReason === 'length' || finishReason === 'content_filter');
  return {
    id: responseId,
    object: 'response',
    created_at: chatBody.created || Math.floor(Date.now() / 1000),
    status: upstreamUnterminated ? 'failed' : (truncated ? 'incomplete' : 'completed'),
    ...(upstreamUnterminated ? {
      error: {
        code: 'UPSTREAM_UNTERMINATED',
        message: UPSTREAM_UNTERMINATED_MESSAGE,
      },
    } : {}),
    ...(truncated ? {
      incomplete_details: {
        reason: upstreamTruncated
          ? 'upstream_incomplete'
          : (finishReason === 'length' ? 'max_output_tokens' : 'content_filter'),
      },
    } : {}),
    // The SERVED name wins over the requested one, matching /v1/messages
    // (messages.js `result.model || model`). chat.js reports what actually ran —
    // the requested name for a mapped alias, the real selector when a request
    // degrades, and the authoritative tier when the caller named one — so
    // deferring to it is what makes this route honest. Before this, the
    // non-stream path echoed the raw request string, which MASKED the F1 tier
    // downgrade (requested gpt-6-luna-max, served gpt-6-luna-medium, body said
    // max) while the stream path adopted the served name from the chunk. The
    // fallback still covers a result with no model field at all.
    model: chatBody.model || requestedModel,
    // Echoed only when the caller sent it: absence stays absent rather than
    // becoming `{}`, which would claim the caller attached an empty tag set.
    ...(metadata ? { metadata } : {}),
    output,
    // Omitted, not zeroed, when the upstream reported nothing. `input_tokens: 0` is
    // an ASSERTION that the turn consumed no prompt tokens, which is false for any
    // request that reached a model — and a billing relay reading it silently
    // under-bills. Absence says "unknown", which is the truth and is what the Gemini
    // exit already does (buildUsageMetadata returns undefined for a silent upstream).
    // Only this exit asserted the zero: the OpenAI chat route emits no usage frame
    // unless stream_options.include_usage opts in, and Anthropic reports a documented
    // local estimate that message_delta later corrects.
    ...(hasReportedUsage(chatBody.usage) ? { usage: mapUsage(chatBody.usage) } : {}),
  };
}

class ResponsesStreamTranslator {
  constructor(res, responseId, model, requestedTools = [], toolNameMap = null, metadata = null, options = {}) {
    this.res = res;
    this.responseId = responseId;
    this.model = model;
    // Same echo contract as the non-stream path: present on every response object
    // the stream publishes (created / in_progress / completed / failed) when the
    // caller sent it, absent otherwise.
    this.metadata = metadata;
    // G01: include:["reasoning.encrypted_content"]. The reasoning item carries the
    // upstream blob only when this is set AND the upstream supplied one.
    this.includeReasoningEncrypted = !!options.includeReasoningEncrypted;
    this.requestedTools = Array.isArray(requestedTools) ? requestedTools : [];
    this.toolNameMap = toolNameMap;
    this.createdAt = Math.floor(Date.now() / 1000);
    this.msgId = genMessageId();
    this.sseFramer = new SseFramer({ onFrame: (frame) => this.handleSseFrame(frame) });
    this.createdSent = false;
    this.finished = false;
    // TWO accumulators, deliberately:
    //   `text`        — every text delta of the whole turn. Read by the response
    //                   store commit in handleResponses, which persists ONE
    //                   OpenAI-shaped assistant message whose `content` is a single
    //                   string. That shape cannot express text-tool-text ordering,
    //                   so storing only the final segment would silently drop the
    //                   pre-tool text from the next chained turn's history. Losing
    //                   text is worse than losing order, so the store gets all of it.
    //   `segmentText` — text of the CURRENT message item only, i.e. what this item's
    //                   output_text.done and its completed item must carry. Reset by
    //                   sealMessageSegment when a tool call closes the item.
    this.text = '';
    this.segmentText = '';
    this.messageOutputIndex = null;
    this.messageStarted = false;
    this.textPartStarted = false;
    this.messageDone = false;
    this.reasoningId = 'rs_' + randomUUID().replace(/-/g, '').slice(0, 24);
    this.reasoningOutputIndex = null;
    this.reasoningStarted = false;
    this.reasoningText = '';
    // Opaque upstream reasoning blob(s), concatenated in arrival order. Empty
    // unless the caller asked for it via include AND the upstream sent one.
    this.reasoningEncryptedContent = '';
    this.reasoningDone = false;
    this.nextOutputIndex = 0;
    this.outputItems = [];
    this.toolCalls = new Map();
    // Egress id allocator: upstream may reuse one call id for two distinct
    // calls, but the client must never see the same call_id twice
    // (GFProtocol Q1-04). First-seen id wins; duplicates get a stable suffix.
    this.allocateCallId = toolHygieneEnabled() ? createToolIdAllocator() : (id) => id || '';
    // Tool events buffered until a split function.name is settled. Without this,
    // output_item.added publishes the first fragment (e.g. "get_") and the name
    // cannot be corrected in the Responses event contract.
    this.deferred = null;
    this.finalUsage = {};
    this.sequenceNumber = 0;
    // Did the upstream stream ever deliver a terminal chunk? Every real success
    // path emits a finish_reason chunk (the connect adapter and the Cascade path
    // both always send one), so its ABSENCE means the stream died mid-answer. Kept
    // separate from streamFinishReason because `null` there is ambiguous: it is also
    // what a stream that is still running looks like.
    this.sawTerminalChunk = false;
    // G3: the upstream said it finished but named no reason (or named `error`).
    // Kept apart from sawTerminalChunk: a chunk DID arrive, so this is not the
    // dropped-connection shape; the turn is failed, not merely incomplete.
    this.sawUnterminated = false;
    // V-08: one abort-aware bounded writer for this egress. `res` here is the
    // real response (the Chat handler writes into `createCaptureRes`, which
    // reports THIS writer's pressure back to it), so a slow Responses client now
    // holds the upstream producer instead of letting frames pile up in the
    // socket. Half-open clients are bounded and tear the turn down.
    this.clientGone = false;
    const maxWaitMs = resolveMaxDrainWaitMs();
    this.writer = createBoundedWriter({
      res,
      maxWaitMs,
      onTimeout: () => {
        this.clientGone = true;
        log.warn(`Responses: no drain for ${maxWaitMs}ms — client stopped reading, ending the stream`);
        try { if (!res.writableEnded) res.end(); } catch { /* best effort */ }
      },
    });
  }

  /** True while the client's socket has not accepted the bytes we handed it. */
  get egressOk() {
    return !this.writer.pending;
  }

  /** Write one raw SSE frame through the shared writer (returns the real verdict). */
  writeRaw(text) {
    return this.writer.write(text);
  }

  /** Wait out an outstanding drain before a terminal frame. Never throws. */
  settleEgress() {
    return this.writer.settle();
  }

  _write(event, data) {
    if (!this.res.writableEnded) {
      const payload = { type: event, sequence_number: this.sequenceNumber++, ...data };
      // V-08: the verdict is the caller's backpressure signal. It is returned
      // (via send/feed → createCaptureRes.write) rather than discarded.
      return this.writer.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    }
    return true;
  }

  send(event, data) {
    if (this.deferred) {
      // ONE ordered buffer. The previous split into `events` and `text` replayed
      // every non-text event first, which moved a later call's output_item.done
      // ahead of the text item that had opened before it (measured: done oi=3
      // before oi=2). Arrival order is the only order that keeps output_index and
      // emission order in agreement.
      this.deferred.entries.push({ event, data });
      return true;
    }
    return this._write(event, data);
  }

  /**
   * End the deferral: publish the deferred call, then replay the buffered entries
   * in arrival order.
   *
   * Deferral exists for exactly one reason — `output_item.added` cannot be
   * corrected, so a split `function.name` must not be published as its first
   * fragment. It must therefore end the moment the name is final, not at
   * `finish()`. The old code only consulted `knownToolName` while `!this.deferred`,
   * so once a fragment set the flag the item could never open: the rest of the
   * stream was buffered and replayed at the end. Measured on text A -> split-name
   * call -> text B -> call 2 -> text C: bytes flat from the first fragment through
   * finish (1834), done oi=3 before oi=2, and B/C merged into one message item
   * because the seal that belongs between them never ran.
   *
   * Every caller proves the deferred call's name is final: its name completed, its
   * arguments started, or the stream ended. Text does NOT prove it (upstream can
   * send name -> text -> name), so text is held instead — see emitTextDelta.
   */
  resolveDeferred() {
    if (!this.deferred) return;
    const { entries, tool: pendingTool } = this.deferred;
    this.deferred = null;
    // The call began before anything in the buffer, so its item is published
    // first. Every buffered entry arrived after the delta that started the
    // deferral, and the pre-tool message was already sealed there.
    //
    // A different call is published only when its own name is already known —
    // publishing a fragment is the uncorrectable event this mechanism exists to
    // avoid.
    for (const tc of [...this.toolCalls.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      if (tc.item || !tc.wireName) continue;
      if (tc === pendingTool || this.knownToolName(tc.wireName)) this.openToolItem(tc);
    }
    for (const entry of entries) {
      // Held text goes through the normal path, so it accumulates into the item
      // that follows the call and keeps its arrival position among the events.
      if (entry.text !== undefined) this.emitTextDelta(entry.text);
      else this._write(entry.event, entry.data);
    }
  }

  knownToolName(name) {
    if (!name) return false;
    if (this.toolNameMap?.toClient?.has(name)) return true;
    return this.requestedTools.some((t) => {
      const n = t?.function?.name || t?.name;
      return n === name;
    });
  }

  responseBase(status, output = []) {
    return {
      object: 'response',
      id: this.responseId,
      created_at: this.createdAt,
      status,
      model: this.model,
      ...(this.metadata ? { metadata: this.metadata } : {}),
      output,
    };
  }

  resolveRequestedTool(name) {
    return this.requestedTools.find(t => (t?.function?.name || t?.name) === name) || null;
  }

  start() {
    if (this.createdSent) return;
    this.createdSent = true;
    this.send('response.created', { response: this.responseBase('in_progress') });
    this.send('response.in_progress', { response: this.responseBase('in_progress') });
  }

  processChunk(chunk) {
    // A terminal event has already gone out — `response.failed` from error(), or
    // `response.completed` from finish(). Both set `finished`, and finish() has
    // always consulted it; processChunk did not, so an upstream that kept sending
    // after an in-band error produced `response.failed` followed by
    // `response.output_text.delta`. Measured before this guard: the failed event
    // landed at index 5 of the event sequence and a text delta at index 6.
    //
    // That is not a cosmetic ordering problem. `response.failed` is a terminal
    // state in the Responses event contract, so an SDK has already settled the
    // request and torn down its accumulator; a later delta either throws inside
    // the client or silently reopens a finished turn.
    if (this.finished) return;
    if (chunk.created) this.createdAt = chunk.created;
    if (chunk.model) this.model = chunk.model;
    this.start();

    const choice = chunk.choices?.[0];
    // G3: the Connect decoder's additive `unterminated` marker (it also sets
    // finish_reason:'error'). Accepted on either the chunk or its choice so the
    // signal is not lost to envelope shape.
    if (chunk.unterminated === true || choice?.unterminated === true) this.sawUnterminated = true;
    if (choice) {
      // Remember the terminal reason: the Responses API signals truncation through
      // status:'incomplete' + incomplete_details, and without capturing it here the
      // stream always closed as 'completed'. An agent then accepted a half answer as
      // a finished one — the non-stream path on the identical request reported
      // incomplete/max_output_tokens. Live-reproduced.
      // A SYNTHETIC terminal chunk does not count as one. When a Cascade stream
      // dies after already delivering content, chat.js closes it with a
      // fabricated finish_reason:'stop' (injecting an error into the content
      // would corrupt the assistant message). That satisfied the check below, so
      // the truncation guard was defeated on the DEFAULT backend: a half answer
      // closed as `response.completed` and entered the store as the next turn's
      // context. Live-reproduced on three real failure shapes (HTTP/2 stream
      // cancel, provider deadline, ECONNRESET).
      if (choice.finish_reason) {
        // 'error' is terminal for the turn: once recorded it must not be
        // overwritten by a later chunk's 'stop'/'length', or finish() would
        // close a failed upstream as response.completed.
        if (this.streamFinishReason !== 'error') {
          this.streamFinishReason = choice.finish_reason;
        }
        // A06: an upstream-truncated length terminal is fabricated too; the
        // namespaced marker covers builds/routes that do not carry the private
        // __synthetic_finish flag.
        if (!chunk.__synthetic_finish && chunk.__windsurf_end_reason !== 'upstream_truncated') {
          this.sawTerminalChunk = true;
        }
      }
      const delta = choice.delta || {};
      if (delta.reasoning_content) this.emitReasoningDelta(delta.reasoning_content);
      // G01: the opaque blob can arrive on its own delta (the Connect signature
      // does), so it is captured independently of the summary text. It never
      // OPENS an item by itself unless the caller asked for it.
      if (this.includeReasoningEncrypted) this.noteReasoningEncrypted(delta);
      if (delta.content) this.emitTextDelta(delta.content);
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) this.emitToolCallDelta(tc);
      }
    }
    if (chunk.usage) this.finalUsage = chunk.usage;
  }

  /** Publish the reasoning item once; shared by summary text and the blob. */
  startReasoning() {
    if (this.reasoningStarted) return;
    this.reasoningStarted = true;
    this.reasoningOutputIndex = this.nextOutputIndex++;
    this.send('response.output_item.added', {
      output_index: this.reasoningOutputIndex,
      item: reasoningItem(this.reasoningId, '', 'in_progress'),
    });
  }

  /**
   * Accumulate an upstream-supplied opaque reasoning blob. A reasoning item with
   * an empty summary is still the truthful shape for a blob-only delta, so the
   * item is opened here when the text never arrives.
   */
  noteReasoningEncrypted(source) {
    const blob = upstreamEncryptedContent(source);
    if (!blob) return;
    this.reasoningEncryptedContent += blob;
    this.startReasoning();
  }

  emitReasoningDelta(text) {
    if (!text) return;
    this.startReasoning();
    this.reasoningText += text;
    this.send('response.reasoning_summary_text.delta', {
      item_id: this.reasoningId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      delta: text,
    });
  }

  finishReasoning() {
    if (!this.reasoningStarted || this.reasoningDone) return;
    this.reasoningDone = true;
    // The summary family opens only with the first reasoning_summary_text.delta.
    // A blob-only item (noteReasoningEncrypted opened it, no summary text ever
    // arrived) has no summary part to close, so a `summary_text.done` would be
    // a done event for a part that does not exist. The item itself still
    // closes below, carrying the blob.
    if (this.reasoningText) {
      this.send('response.reasoning_summary_text.done', {
        item_id: this.reasoningId,
        output_index: this.reasoningOutputIndex,
        summary_index: 0,
        text: this.reasoningText,
      });
    }
    const complete = reasoningItem(this.reasoningId, this.reasoningText, 'completed', this.reasoningEncryptedContent);
    this.send('response.output_item.done', { output_index: this.reasoningOutputIndex, item: complete });
    this.outputItems[this.reasoningOutputIndex] = complete;
  }

  ensureMessage() {
    if (this.messageStarted) return;
    this.messageStarted = true;
    this.messageOutputIndex = this.nextOutputIndex++;
    const addedItem = textMessageItem(this.msgId, '', 'in_progress');
    this.send('response.output_item.added', { output_index: this.messageOutputIndex, item: addedItem });
  }

  /**
   * Close the open message item so text arriving AFTER a tool call opens a new one.
   *
   * Without this the message item is a SINGLETON: `msgId` was minted once in the
   * constructor and `messageStarted` latched true forever, so post-tool text was
   * appended to item 0. MEASURED on frames text -> tool_call -> text: one message
   * item at oi=0 carrying "BEFORE AFTER" with the tool at oi=1, i.e. a client
   * reassembling the turn places ALL text before the call it actually followed.
   * Anthropic on identical frames opens content_block index=2 for the second text,
   * which is the shape this brings the Responses exit in line with.
   */
  closeTextBeforeTool() {
    this.sealMessageSegment();
  }

  sealMessageSegment() {
    if (!this.messageStarted || this.messageDone) return;
    this.finishMessage();
    // Reset only the per-ITEM state. `this.text` deliberately keeps accumulating —
    // see the comment on `segmentText`.
    this.msgId = genMessageId();
    this.messageStarted = false;
    this.textPartStarted = false;
    this.messageDone = false;
    this.messageOutputIndex = null;
    this.segmentText = '';
  }

  ensureTextPart() {
    if (this.textPartStarted) return;
    this.ensureMessage();
    this.textPartStarted = true;
    this.send('response.content_part.added', {
      item_id: this.msgId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  }

  emitTextDelta(text) {
    if (!text) return;
    if (this.deferred) {
      // A text delta does NOT prove the call's name is final: upstream can send
      // name:"get_" -> text -> name:"time", and publishing "get_" is uncorrectable.
      // Emitting the text now would also put it ahead of a call that started
      // first. Hold it in arrival order; resolveDeferred replays it through this
      // same method once the item is published.
      this.deferred.entries.push({ text });
      return;
    }
    this.ensureTextPart();
    this.text += text;
    this.segmentText += text;
    this.send('response.output_text.delta', {
      item_id: this.msgId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      delta: text,
    });
  }

  /**
   * Publish `output_item.added` for a call whose name is final. The caller
   * guarantees `tc.item` is still null.
   */
  openToolItem(tc, { seal = true } = {}) {
    if (tc.item) return;
    // A tool item is about to open, so any text already streamed belongs to a
    // message item that ENDED before it. Sealing here — at the point the tool
    // item is created, not in finish() — is what gives the post-tool text its own
    // item and keeps output_index ascending in emission order. `finishToolCalls`
    // opts out: it only reaches a nameless call after the stream ended, and
    // sealing there would close a message that opened after that call.
    if (seal) this.sealMessageSegment();
    const wireName = tc.wireName || tc.toolName || 'unknown';
    const clientName = restoreToolName(wireName, this.toolNameMap) || wireName;
    const responseTool = tc.responseTool;
    const item = responseTool?.type === 'custom'
      ? {
          type: 'custom_tool_call',
          // The item id is what the custom_tool_call_input events name; every
          // output item carries one (function calls already did).
          id: genFunctionCallId(),
          call_id: tc.callId || `call_${randomUUID().slice(0, 8)}`,
          name: responseTool.originalName || clientName,
          ...(responseTool.namespace ? { namespace: responseTool.namespace } : {}),
          input: '',
          status: 'in_progress',
        }
      : {
          type: 'function_call',
          id: genFunctionCallId(),
          call_id: tc.callId || `call_${randomUUID().slice(0, 8)}`,
          name: responseTool?.originalName || clientName,
          ...(responseTool?.namespace ? { namespace: responseTool.namespace } : {}),
          arguments: '',
          status: 'in_progress',
        };
    tc.item = item;
    this.send('response.output_item.added', { output_index: tc.outputIndex, item });
    // Arguments buffered while the name was unsettled belong to this item. Emit
    // them now in their original chunk boundaries and mark them sent, or
    // finishToolCalls would replay the same deltas a second time.
    if (tc.custom) {
      // G03: a custom tool's input streams through its own event family, as the
      // RAW string the client executes — not through function_call_arguments.
      this.emitCustomInputDelta(tc);
      tc.pendingArgDeltas = [];
    } else if (!tc.suppressArgDeltas && tc.pendingArgDeltas?.length) {
      for (const delta of tc.pendingArgDeltas) {
        this.send('response.function_call_arguments.delta', {
          item_id: item.id,
          output_index: tc.outputIndex,
          delta,
        });
      }
      tc.pendingArgDeltas = [];
      tc.emittedArgsLength = tc.argChunks.join('').length;
    }
  }

  /**
   * G03: publish the not-yet-emitted tail of a custom call's decoded input.
   *
   * The upstream streams the `{"input":"…"}` envelope, so only the COMPLETE
   * decodable prefix can be sent (customToolInputPrefix withholds a partial
   * escape). Idempotent: it always compares against the full accumulated
   * arguments, so a replayed chunk emits nothing.
   */
  emitCustomInputDelta(tc) {
    if (!tc?.custom || !tc.item) return;
    const prefix = customToolInputPrefix(tc.argChunks.join(''));
    if (prefix.length <= tc.emittedInputLength) return;
    const delta = prefix.slice(tc.emittedInputLength);
    tc.emittedInputLength = prefix.length;
    this.send('response.custom_tool_call_input.delta', {
      item_id: tc.item.id,
      output_index: tc.outputIndex,
      delta,
    });
  }

  emitToolCallDelta(toolCall) {
    const idx = toolCall.index ?? 0;
    let existing = this.toolCalls.get(idx);
    if (!existing) {
      existing = {
        item: null,
        outputIndex: this.nextOutputIndex++,
        argChunks: [],
        emittedArgsLength: 0,
        emittedInputLength: 0,
        done: false,
        custom: false,
        suppressArgDeltas: false,
        responseTool: null,
        callId: toolCall.id ? this.allocateCallId(toolCall.id) : null,
        rawId: toolCall.id || null,
        wireName: null,
        toolName: null,
        pendingArgDeltas: [],
      };
      this.toolCalls.set(idx, existing);
    }

    if (toolCall.id && toolCall.id !== existing.rawId) {
      // The id is delivered once, possibly on a later delta than the first. A
      // repeated id is the same call and must not be allocated twice.
      existing.rawId = toolCall.id;
      existing.callId = this.allocateCallId(toolCall.id) || existing.callId;
    }
    const nameFragment = toolCall.function?.name;
    if (nameFragment) {
      const rawName = nameFragment;
      // function.name may be split across deltas. Accumulate idempotently: a
      // repeated full name replaces the prefix, a prefix does not duplicate.
      if (!existing.wireName) existing.wireName = rawName;
      else if (rawName === existing.wireName || rawName.startsWith(existing.wireName)) existing.wireName = rawName;
      else if (!existing.wireName.startsWith(rawName)) existing.wireName += rawName;
      const wireName = existing.wireName;
      const clientName = restoreToolName(wireName, this.toolNameMap) || wireName;
      existing.toolName = clientName;
      const requestedTool = this.resolveRequestedTool(wireName);
      const responseTool = requestedTool?.__response_tool || null;
      if (responseTool) {
        existing.responseTool = responseTool;
        existing.custom = responseTool.type === 'custom';
        // Only tool_search suppresses argument deltas. Hosted web_search never
        // reaches the translator any more (rejected in responsesToChat).
        existing.suppressArgDeltas = responseTool.type === 'tool_search';
      }
      if (this.knownToolName(wireName)) {
        // The name is final: publish now. When an earlier fragment deferred the
        // stream, this is the moment it ends — that is the whole point of the
        // deferral, and leaving it until finish() froze the wire. A different
        // call settling does NOT prove the deferred call's name is final, so it
        // is published on its own (into the buffer, at its arrival position).
        if (!this.deferred) this.openToolItem(existing);
        else if (existing === this.deferred.tool) this.resolveDeferred();
        else this.openToolItem(existing);
      } else if (!this.deferred && !existing.item) {
        // An unknown fragment must wait: publishing output_item.added with the
        // fragment would be uncorrectable. Only the ITEM is deferred.
        this.closeTextBeforeTool();
        this.deferred = { entries: [], tool: existing };
      }
    }

    const argsChunk = toolCall.function?.arguments ?? '';
    if (argsChunk !== '') {
      const chunk = stringifyMaybe(argsChunk);
      existing.argChunks.push(chunk);
      // Only an UNPUBLISHED item needs its arguments held; a published one can
      // take them into the buffer in arrival order.
      if (this.deferred && !existing.item) existing.pendingArgDeltas.push(chunk);
    }
    // Arguments never arrive before the name is complete, so an args-only delta
    // proves the accumulated name is final even when it matches no declared tool.
    // Without this, an undeclared split name would still freeze until finish().
    if (this.deferred && !nameFragment && existing === this.deferred.tool) this.resolveDeferred();
    // A delta that only added a name fragment leaves the name pending: the item
    // must not be published yet. Anything it carried was buffered above.
    if (this.deferred && !existing.item) return;
    if (!existing.item && !existing.toolName) return;
    if (!existing.item) this.openToolItem(existing);

    if (existing.callId) existing.item.call_id = existing.callId;

    if (existing.custom) {
      this.emitCustomInputDelta(existing);
    } else if (!existing.suppressArgDeltas) {
      const allArgs = existing.argChunks.join('');
      const pendingArgs = allArgs.slice(existing.emittedArgsLength);
      if (pendingArgs) {
        this.send('response.function_call_arguments.delta', {
          item_id: existing.item.id,
          output_index: existing.outputIndex,
          delta: pendingArgs,
        });
        existing.emittedArgsLength = allArgs.length;
      }
    }
  }

  finishToolCalls() {
    const sorted = [...this.toolCalls.values()].sort((a, b) => a.outputIndex - b.outputIndex);
    for (const tc of sorted) {
      if (tc.done) continue;
      tc.done = true;
      // A call with no name at all reaches here (every named call is published by
      // resolveDeferred before this). `tc.callId` was sanitized when the id
      // arrived, so no second clientToolId pass is needed.
      if (!tc.item) this.openToolItem(tc, { seal: false });
      const args = tc.argChunks.join('');
      if (tc.custom) {
        // G03: flush the last decodable prefix, then close the event family with
        // the authoritative full input. `output_item.added` legitimately carried
        // input:'' (the in-progress shape); THIS done item is what the client
        // executes, so it must carry the whole value.
        this.emitCustomInputDelta(tc);
        const input = customToolInput(args);
        this.send('response.custom_tool_call_input.done', {
          item_id: tc.item.id,
          output_index: tc.outputIndex,
          input,
        });
        const complete = { ...tc.item, input, status: 'completed' };
        this.send('response.output_item.done', { output_index: tc.outputIndex, item: complete });
        this.outputItems[tc.outputIndex] = complete;
        continue;
      }
      if (tc.item.type === 'function_call' && tc.item.name === 'tool_search') {
        const complete = { ...tc.item, arguments: args, status: 'completed' };
        this.send('response.output_item.done', { output_index: tc.outputIndex, item: complete });
        this.outputItems[tc.outputIndex] = complete;
        continue;
      }
      const pendingDeltas = tc.pendingArgDeltas || [];
      if (pendingDeltas.length) {
        for (const delta of pendingDeltas) {
          this.send('response.function_call_arguments.delta', {
            item_id: tc.item.id,
            output_index: tc.outputIndex,
            delta,
          });
        }
        tc.pendingArgDeltas = [];
        tc.emittedArgsLength = args.length;
      } else {
        const pendingArgs = args.slice(tc.emittedArgsLength || 0);
        if (pendingArgs) {
          this.send('response.function_call_arguments.delta', {
            item_id: tc.item.id,
            output_index: tc.outputIndex,
            delta: pendingArgs,
          });
          tc.emittedArgsLength = args.length;
        }
      }
      this.send('response.function_call_arguments.done', {
        item_id: tc.item.id,
        output_index: tc.outputIndex,
        arguments: args,
      });
      const complete = { ...tc.item, arguments: args, status: 'completed' };
      this.send('response.output_item.done', { output_index: tc.outputIndex, item: complete });
      this.outputItems[tc.outputIndex] = complete;
    }
  }

  finishMessage() {
    if (this.messageDone) return;
    this.messageDone = true;
    this.ensureTextPart();
    // `segmentText`, not `text`: this event closes ONE item, and its text must be
    // what that item streamed. Using the whole-turn accumulator here republished
    // the pre-tool text inside the post-tool item.
    const donePart = { type: 'output_text', text: this.segmentText, annotations: [] };
    this.send('response.output_text.done', {
      item_id: this.msgId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      text: this.segmentText,
    });
    this.send('response.content_part.done', {
      item_id: this.msgId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      part: donePart,
    });
    const complete = textMessageItem(this.msgId, this.segmentText);
    this.send('response.output_item.done', { output_index: this.messageOutputIndex, item: complete });
    this.outputItems[this.messageOutputIndex] = complete;
  }

  /**
   * V-12: the exact ordered output items this turn published, ready to persist.
   *
   * This is what the response store keeps so GET can replay the SAME items
   * (ids, types, call_ids, custom inputs, namespaces) instead of regenerating
   * them from a lossy chat-shaped summary, and so the next chained turn can be
   * rebuilt in the order the client actually received.
   */
  get committedItems() {
    return this.outputItems.filter(Boolean).map(item => ({ ...item }));
  }

  /**
   * Completed tool calls in OpenAI chat shape, for the response store: the next
   * turn must see the same assistant tool_calls the client did, or the chained
   * conversation loses the call/result pairing.
   *
   * V-12: kept for the LEGACY flat fallback only. New commits use
   * `historyFromResponseItems(committedItems)`, which also carries custom calls,
   * their order, and the wire name.
   */
  get committedToolCalls() {
    return this.outputItems.filter(Boolean)
      .filter(i => i.type === 'function_call')
      .map((i, idx) => ({
        id: i.call_id || i.id || `call_${idx}`,
        type: 'function',
        function: { name: i.name, arguments: i.arguments || '' },
      }));
  }

  finish() {
    if (this.finished) return;
    this.sseFramer.end();
    if (this.finished) return;
    this.finished = true;
    this.start();
    // A name that never settled (no args, no text, no second fragment) is still
    // final at end of stream. Publish it here so its `added` precedes its `done`
    // and the buffered events keep their arrival order.
    this.resolveDeferred();
    this.finishReasoning();
    this.finishToolCalls();
    // `segmentText`, not `text`: the whole-turn accumulator is non-empty after any
    // pre-tool narration, so this gate closed an EMPTY trailing message item on
    // every turn that narrated and then called a tool.
    if (this.messageStarted || this.segmentText) this.finishMessage();
    const reason = this.streamFinishReason;
    // G3 (Q1 audit §7): an upstream that ended the turn with `error` (Connect:
    // an end-of-stream frame carrying a payload but no stopReason) or flagged it
    // `unterminated` did NOT finish. Closing as `response.completed` — the old
    // behaviour — told the client a half answer was whole. The partial items are
    // already closed above; the terminal is a failure, and `failed` keeps the
    // turn out of the response store and suppresses the `[DONE]` sentinel.
    if (reason === 'error' || this.sawUnterminated) {
      this.sendFailed({ code: 'UPSTREAM_UNTERMINATED', message: UPSTREAM_UNTERMINATED_MESSAGE });
      return;
    }
    // Same truncation rule as the non-streaming path (see chatToResponse):
    // 'incomplete' is reserved for length / content_filter, everything else closes
    // as 'completed'.
    //
    // An ABSENT reason is NOT the same as a benign one. Every real success path
    // emits a finish_reason chunk, so reaching the end of the stream without one
    // means the upstream connection died mid-answer. Reporting that as 'completed'
    // handed an agent a half answer as a finished one AND committed it to the
    // response store, where it became the next turn's context — a silent corruption
    // that outlived the request. It closes as 'incomplete' instead, and `truncated`
    // also gates the store commit below.
    const aborted = !this.sawTerminalChunk;
    const truncated = reason === 'length' || reason === 'content_filter' || aborted;
    const status = truncated ? 'incomplete' : 'completed';
    this.truncated = truncated;
    // Exposed SEPARATELY from `truncated` because the store gate needs exactly
    // this narrower question: was the turn cut off without the upstream ever
    // saying so? A legitimate 'length' / 'content_filter' turn is `truncated` but
    // NOT `aborted`, and it stays chainable — matching the non-streaming path.
    this.aborted = aborted;
    this.send(truncated ? 'response.incomplete' : 'response.completed', {
      response: {
        ...this.responseBase(status, this.outputItems.filter(Boolean)),
        ...(truncated
          ? {
            incomplete_details: {
              // A dropped connection is not a token limit; naming it as one would
              // send an auto-continuing client off to extend a turn the upstream
              // never finished.
              reason: aborted ? 'upstream_incomplete'
                : (reason === 'length' ? 'max_output_tokens' : 'content_filter'),
            },
          }
          : {}),
        // Same rule as the non-streaming path — see the comment on the other
        // mapUsage call site. Both paths must agree, or one exit reports unknown
        // usage as 0 while its sibling omits it for the identical upstream.
        ...(hasReportedUsage(this.finalUsage) ? { usage: mapUsage(this.finalUsage) } : {}),
      },
    });
  }

  /**
   * Emit the terminal `response.failed` frame.
   *
   * Shared by the mid-stream error path and by finish() when the upstream closed
   * a turn with `error` / `unterminated` instead of a completion reason — one
   * failure shape whether the stream died or the upstream merely failed to say
   * it finished. Setting `failed` is what keeps the turn out of the response
   * store and suppresses the `[DONE]` sentinel.
   */
  sendFailed(err) {
    this.failed = true;
    // Resolve the authoritative {status,type} from the DEVIN_CONNECT classification
    // first, exactly like messages.js and gemini.js do. Reading only err.type
    // collapsed every mid-stream CAPACITY / RATE_LIMITED / MODEL_BLOCKED into a
    // flat api_error, so a Responses client lost the retryable-vs-terminal
    // distinction the classifier had already computed.
    const http = err?.code
      ? connectErrorToHttp(err.code)
      : { status: err?.status || 500, type: err?.type || 'upstream_error' };
    this.send('response.failed', {
      response: {
        ...this.responseBase('failed', this.outputItems.filter(Boolean)),
        error: {
          message: err?.message || 'Upstream stream error',
          // O10: Responses 是 OpenAI 家族,其错误帧在 server.js 之前就写好 →
          // 就地归一化内部词到官方 OpenAI type。
          type: normalizeOpenAIErrorType(http.type, http.status),
          code: err?.code || null,
          ...(Number.isFinite(Number(err?.retry_after_ms)) ? { retry_after_ms: Number(err.retry_after_ms) } : {}),
        },
      },
    });
  }

  error(err) {
    if (this.finished) return;
    this.finished = true;
    // A failed stream has no complete assistant reply to chain from.
    this.deferred = null;
    this.start();
    this.sendFailed(err);
  }

  feed(rawChunk) {
    this.sseFramer.push(rawChunk);
    // V-08: the verdict the Chat producer reads. `push` dispatches every frame
    // synchronously, so `egressOk` is the state AFTER this chunk was emitted —
    // false means the socket reported backpressure and has not drained yet.
    return this.egressOk;
  }

  handleSseFrame({ data }) {
    if (!data || data === '[DONE]') return;
    try {
      const parsed = JSON.parse(data);
      if (parsed.error) {
        this.error(parsed.error);
      } else {
        this.processChunk(parsed);
      }
    } catch (e) {
      log.warn(`Responses SSE parse error: ${e.message}`);
    }
  }
}

/**
 * V-12 (KH-009/KH-020/KH-045): rebuild the internal Chat history from the
 * response's OWN ordered items.
 *
 * The old commit flattened a streamed turn into ONE assistant message whose
 * `content` was every text segment concatenated and whose `tool_calls` came
 * last. A turn that produced text → call → text therefore reached the next
 * chained request as "BEFORE AFTER" followed by the call, i.e. in an order the
 * client never saw. Custom calls were dropped entirely (the getter only kept
 * `function_call`), and namespaced calls were stored under the CLIENT name while
 * `tools[]` declared the WIRE name — so the upstream saw a call to a tool it had
 * never been offered.
 *
 * This walks the items in output order and emits one assistant message per run:
 * text runs keep their position, each call keeps its own call_id and its WIRE
 * name. Consecutive text-only assistant messages are merged by the Connect
 * encoder (and concatenated by Cascade), so the wire shape for the ordinary
 * single-text turn is unchanged.
 */
export function historyFromResponseItems(items, toolNameMap = null) {
  const out = [];
  let textRun = '';
  let pendingCalls = [];
  const flushText = () => {
    if (!textRun) return;
    out.push({ role: 'assistant', content: textRun });
    textRun = '';
  };
  const flushCalls = () => {
    if (!pendingCalls.length) return;
    // Consecutive calls are ONE assistant turn with several tool_calls — the
    // OpenAI shape for parallel calls, and the shape the flat commit always
    // produced. Splitting them into one message per call would build a longer
    // same-source run than the upstream validator tolerates.
    out.push({ role: 'assistant', content: null, tool_calls: pendingCalls });
    pendingCalls = [];
  };
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message') {
      flushCalls();
      textRun += responseItemText(item);
      continue;
    }
    if (item.type !== 'function_call' && item.type !== 'custom_tool_call') continue;
    flushText();
    const args = item.type === 'custom_tool_call'
      ? JSON.stringify({ input: item.input ?? '' })
      : (item.arguments || '');
    pendingCalls.push({
      id: item.call_id || item.id || `call_${out.length}`,
      type: 'function',
      function: { name: responseItemToolName(item, toolNameMap), arguments: args },
    });
  }
  flushText();
  flushCalls();
  return out;
}

/** Concatenated visible text of one message item (Responses `content` parts). */
function responseItemText(item) {
  if (typeof item?.text === 'string') return item.text;
  if (!Array.isArray(item?.content)) return '';
  return item.content.map(part => (typeof part === 'string' ? part : (part?.text || ''))).join('');
}

function createCaptureRes(translator, realRes) {
  const listeners = new Map();
  const fire = (event) => {
    const cbs = listeners.get(event) || [];
    for (const cb of cbs) { try { cb(); } catch {} }
  };
  // V-08: the producer (chat.js) waits for 'drain' on THIS fake response. Without
  // the forward, its bounded writer would park on a signal that can never arrive
  // — the real socket's drain is the only one that exists.
  if (realRes?.on) {
    realRes.on('drain', () => fire('drain'));
    realRes.on('error', () => fire('error'));
  }
  return {
    writableEnded: false,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    write(chunk) {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (str.startsWith(':') && realRes && !realRes.writableEnded) {
        try { realRes.write(str); } catch {}
      }
      translator.feed(chunk);
      // Return the REAL socket's verdict. A constant `true` (the old shape) kept
      // chat.js's bounded writer permanently disarmed on every translated route.
      return translator.egressOk;
    },
    end(chunk) {
      if (this.writableEnded) return;
      if (chunk) translator.feed(chunk);
      translator.finish();
      this.writableEnded = true;
      fire('close');
    },
    _clientDisconnected() { fire('close'); },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
    once(event, cb) {
      const self = this;
      const wrapped = function onceWrapper() {
        self.off(event, wrapped);
        cb.apply(self, arguments);
      };
      return self.on(event, wrapped);
    },
    off(event, cb) {
      const arr = listeners.get(event);
      if (arr) {
        const idx = arr.indexOf(cb);
        if (idx !== -1) arr.splice(idx, 1);
      }
      return this;
    },
    removeListener(event, cb) { return this.off(event, cb); },
    emit() { return true; },
  };
}

/**
 * Splice a client's new turn onto the stored conversation.
 *
 * Per the Responses contract a chained client sends only what is NEW — for a tool
 * loop that is the `function_call_output` items, because the `function_call`s were
 * produced by the server and are already in the stored response. But clients do
 * re-send them (it reads as the safer thing to do), and then the upstream sees the
 * SAME assistant tool_call twice and rejects the whole conversation with an opaque
 * "an internal error occurred (trace ID …)" — a 503 the caller cannot act on.
 * Verified with a real agent loop: re-sending the calls failed every turn 2, while
 * sending only the outputs completed the task.
 *
 * So drop assistant tool_calls the stored history already carries, keyed by id.
 * Anything genuinely new (tool results, fresh user turns, calls with unseen ids)
 * passes through untouched.
 */
export function mergeChainedMessages(storedMessages, newMessages) {
  // Request-level instructions do NOT carry over. The spec is explicit: "when used
  // along with previous_response_id, the instructions from a previous response will
  // not be carried over to the next response." So the stored chain's
  // instructions-derived system block is dropped and the current request's wins.
  //
  // This replaced an append-with-dedup first cut, which had two problems the review
  // caught: the stored copy accumulated one per turn (turn N shipped N copies,
  // because devin-connect concatenates every system message into one
  // system_prompt), and — worse — an instructions TOGGLE-BACK silently kept the
  // revoked value. With X→Y→X, turn 3's X was dropped as a "duplicate", leaving Y
  // as the last and therefore winning line: the model followed instructions the
  // client had just replaced. Live-reproduced (EN→JA→EN answered in Japanese).
  //
  // A system/developer message that arrived as a conversation ITEM is untouched —
  // that is part of the conversation, not a request-level override.
  const stored = storedMessages;

  const known = new Set();
  for (const m of stored) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc?.id) known.add(tc.id);
    }
  }
  if (!known.size) return [...stored, ...newMessages];

  const merged = [...stored];
  for (const m of newMessages) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const fresh = m.tool_calls.filter(tc => !tc?.id || !known.has(tc.id));
      // Every call already known and no text of its own → a pure duplicate, drop it.
      if (!fresh.length && !messageHasText(m)) continue;
      merged.push(fresh.length === m.tool_calls.length ? m : { ...m, tool_calls: fresh });
      for (const tc of fresh) if (tc?.id) known.add(tc.id);
      continue;
    }
    merged.push(m);
  }
  return merged;
}

function messageHasText(m) {
  if (typeof m?.content === 'string') return m.content.trim() !== '';
  if (Array.isArray(m?.content)) return m.content.some(p => (p?.text || '').trim() !== '');
  return false;
}

/**
 * Reconstruct a stored conversation as a Responses object.
 *
 * The store keeps the accumulated MESSAGE list, not the response body that was
 * originally emitted, so this rebuilds the output items from the trailing assistant
 * turn. Everything a chaining client needs (id, model, status, output text, tool
 * calls) round-trips; per-request usage does not, because the store never held it —
 * so usage is reported as zeroed rather than invented.
 */
/**
 * The assistant turn that ANSWERS the stored conversation's last user message.
 *
 * The search stops at the last user message instead of scanning the whole array.
 * An unbounded `reverse().find(role === 'assistant')` walks straight past it and
 * returns an ANCESTOR turn's answer, because the store holds the accumulated
 * conversation — every earlier assistant reply is still in the array. Measured on
 * a two-turn chain whose second turn produced no output: GET returned
 * `"It is 4."` while the last user message asked `"And 3+3?"`, reported as
 * `status: 'completed'`.
 *
 * Bounding the search is the fix rather than gating the one call site that can
 * produce the state, because that call site is not the property worth relying on:
 * `commit(null)` is unreachable today (every non-stream 200 in chat.js builds a
 * `message` object), so the defect is latent — the day any new path omits it, an
 * unbounded search silently serves a stale answer. A bounded one reports no
 * output, which is the truth.
 */
function assistantAnsweringLastUserTurn(messages) {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') { lastUser = i; break; }
  }
  for (let i = messages.length - 1; i > lastUser; i--) {
    if (messages[i]?.role === 'assistant') return messages[i];
  }
  return null;
}

function storedResponseBody(responseId, entry) {
  const assistant = assistantAnsweringLastUserTurn(entry.messages) || null;
  // V-12 (KH-045): when the creating turn persisted its exact ordered items,
  // replay THOSE. Rebuilding from the flat chat message re-typed custom calls as
  // `function_call`, dropped namespaces, and minted fresh item ids on every read
  // — a GET that did not match the POST it was retrieving.
  const persistedItems = Array.isArray(assistant?.__responses_items) && assistant.__responses_items.length
    ? assistant.__responses_items
    : null;
  if (persistedItems) {
    const output = persistedItems.map(item => ({ ...item }));
    return {
      object: 'response',
      id: responseId,
      created_at: Math.floor((entry.createdAt || Date.now()) / 1000),
      status: entry.status || 'completed',
      ...(entry.incompleteReason ? { incomplete_details: { reason: entry.incompleteReason } } : {}),
      model: entry.model || null,
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
      output,
      output_text: output.filter(i => i.type === 'message').map(responseItemText).join(''),
    };
  }
  // The store holds Chat-shaped messages, whose content may be a PARTS ARRAY (the
  // Responses `input` items are normalized that way). Passing an array straight into
  // output_text produced a structurally invalid body — `text` held an array instead
  // of a string. Flatten to the text parts, which is what a Responses client reads.
  const rawContent = assistant?.content;
  const text = typeof rawContent === 'string'
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent.map(p => (typeof p === 'string' ? p : (p?.text || ''))).filter(Boolean).join('')
      : '';
  // Strip the store's own trim bookkeeping. capEntryBytes prepends a notice to the
  // first surviving message when it drops earlier ones, and when that survivor IS
  // the assistant turn, the notice was served back as if the MODEL had written it —
  // gateway-internal text masquerading as the answer. It stays in the CHAINED
  // context (where it is a useful signal to the next turn) but must not be presented
  // to the client as model output.
  const answer = text.replace(/^\[\.\.\. \d+ earlier message\(s\) dropped by the response store[^\]]*\]\n\n/, '');
  const output = [];
  if (answer) output.push(textMessageItem(genMessageId(), answer));
  // A stored turn may predate the egress dedupe (or come from a non-stream
  // response): never hand two items the same call_id on retrieval either.
  const allocateCallId = toolHygieneEnabled() ? createToolIdAllocator() : null;
  for (const tc of assistant?.tool_calls || []) output.push(functionCallItem(tc, 'completed', [], null, allocateCallId));
  return {
    object: 'response',
    id: responseId,
    created_at: Math.floor((entry.createdAt || Date.now()) / 1000),
    // The turn's real terminal status, as recorded at creation. Hardcoding
    // 'completed' made GET contradict what POST reported for the SAME id: a
    // legitimately truncated turn (finish_reason length / content_filter) is stored
    // and chainable since 8fa5e97, and retrieval laundered it into a completed one —
    // the exact stream/non-stream status divergence this release line kept fixing.
    status: entry.status || 'completed',
    ...(entry.incompleteReason
      ? { incomplete_details: { reason: entry.incompleteReason } }
      : {}),
    model: entry.model || null,
    // The tag the CREATING request attached. Absent when it had none, for the
    // same reason the POST omits it: `{}` would be an assertion the caller made.
    ...(entry.metadata ? { metadata: entry.metadata } : {}),
    output,
    output_text: answer,
    // usage is OPTIONAL on the Response model in both official SDKs, and the store
    // never held it. An all-zero block is indistinguishable from "this turn really
    // used 0 tokens" and would be metered as such by a billing relay, so omit it.
  };
}

/** Shared 404 for a response id that is unknown, expired, or another caller's. */
function responseNotFound(responseId) {
  return {
    status: 404,
    body: {
      error: {
        message: `Response with id '${safeLogValue(responseId, 64)}' not found.`,
        type: 'invalid_request_error',
        param: 'response_id',
        code: 'response_not_found',
      },
    },
  };
}

/** Shared 400 for the store being switched off. */
function storeDisabled(verb) {
  return {
    status: 400,
    body: {
      error: {
        message: `${verb} a stored response requires the response store, which is disabled on this server (RESPONSE_STORE_ENABLED=0).`,
        type: 'invalid_request_error',
      },
    },
  };
}

/**
 * GET /v1/responses/{id} — retrieve a stored response.
 *
 * Scoped exactly like the chaining lookup: a caller can only read ids minted for
 * its own callerKey, and an untrustworthy `:client:<ip+ua>` identity cannot read
 * anything at all. Without that second gate this endpoint would be a way to read
 * another tenant's conversation from behind a shared reverse proxy — the same
 * cross-tenant leak the store's own commit path is gated against.
 */
export function handleGetResponse(responseId, deps = {}) {
  const callerKey = deps.context?.callerKey || '';
  if (!isResponseStoreEnabled()) return storeDisabled('Retrieving');
  if (!hasPerUserScope(callerKey)) return responseNotFound(responseId);
  const found = getResponse(responseId, callerKey);
  if (!found.ok) return responseNotFound(responseId);
  return {
    status: 200,
    // Forward the whole lookup result: hand-listing fields here is what silently
    // dropped `status` / `incompleteReason` and kept retrieval reporting 'completed'.
    body: storedResponseBody(responseId, found),
  };
}

/**
 * DELETE /v1/responses/{id} — drop a stored response.
 *
 * Same scoping as the retrieval above. Reports OpenAI's deletion shape; an id the
 * caller cannot see is a 404, never a silent success, so a caller is never told it
 * deleted something that still exists.
 */
export function handleDeleteResponse(responseId, deps = {}) {
  const callerKey = deps.context?.callerKey || '';
  if (!isResponseStoreEnabled()) return storeDisabled('Deleting');
  if (!hasPerUserScope(callerKey)) return responseNotFound(responseId);
  if (!deleteResponse(responseId, callerKey)) return responseNotFound(responseId);
  return {
    status: 200,
    body: { id: responseId, object: 'response.deleted', deleted: true },
  };
}

export async function handleResponses(body, deps = {}) {
  const chatHandler = deps.handleChatCompletions || handleChatCompletions;
  const context = deps.context || {};
  const responseId = genResponseId();
  const requestedModel = body.model || 'claude-sonnet-4.6';
  let chatBody;
  let toolNameMap = null;
  let responseMetadata = null;
  let includeReasoningEncrypted = false;
  try {
    chatBody = responsesToChat(body);
    toolNameMap = chatBody.__toolNameMap || null;
    delete chatBody.__toolNameMap;
    // The tag the caller attached, validated by responsesToChat. Stripped here so
    // it never reaches the upstream request body: it is a response-side echo, not
    // a chat parameter.
    responseMetadata = chatBody.__responseMetadata || null;
    if ('__responseMetadata' in chatBody) {
      chatBody = { ...chatBody };
      delete chatBody.__responseMetadata;
    }
    // G01: `include` is response-side only. Stripped from the dispatch body and
    // carried to the two translators that build the reasoning items.
    includeReasoningEncrypted = chatBody.__includeReasoningEncrypted === true;
    if ('__includeReasoningEncrypted' in chatBody) {
      chatBody = { ...chatBody };
      delete chatBody.__includeReasoningEncrypted;
    }
  } catch (err) {
    return {
      status: 400,
      body: {
        error: {
          message: err?.message || 'Invalid Responses request',
          type: 'invalid_request_error',
          ...(err?.param ? { param: err.param } : {}),
          ...(err?.code ? { code: err.code } : {}),
        },
      },
    };
  }

  const requestedTools = chatBody.tools || [];
  const callerKey = context.callerKey || '';

  // The request-level instructions message is never persisted. Per the Responses
  // contract it does not carry over across previous_response_id, so keeping it out
  // of the store is both correct and simpler than tracking where it sits after a
  // merge. Captured HERE, before the merge — reading messages[0] afterwards picks
  // up the first message of the PREPENDED history instead, which silently dropped
  // real conversation content while leaving the instructions behind.
  //
  // Identified by object identity: responsesToChat created it, and the merge copies
  // arrays but preserves element references.
  const instructionsMsg = (chatBody.__instructionsLead && (chatBody.messages || [])[0]) || null;
  if ('__instructionsLead' in chatBody) {
    chatBody = { ...chatBody };
    delete chatBody.__instructionsLead;
  }

  // Storing requires a TRUSTWORTHY caller identity. A `:client:<ip+ua>` bucket is a
  // GUESSED one: behind a reverse proxy every end user collapses to the same proxy
  // IP and the same UA (verified: two callers with identical ip/ua derive a
  // byte-identical callerKey), so treating it as a per-caller scope would let user B
  // chain from user A's response id and read A's conversation — the exact
  // cross-tenant leak SEC-W2 forbids, and the same gate cascade reuse and
  // bindConnectSticky already sit behind.
  //
  // A genuine single-user self-host opts back in with
  // WINDSURFAPI_SINGLE_TENANT_CACHE=1 (which is what hasPerUserScope consults).
  // Without it such a caller simply cannot chain, and the 404 below says so.
  const chainable = hasPerUserScope(callerKey);
  // Responses API server-side state: when the caller chains with
  // previous_response_id it sends ONLY the new turn, so the stored conversation
  // has to be prepended here. A miss must FAIL — proceeding with just the new turn
  // is what made a chained client answer every turn blind, with no diagnosable
  // signal (the whole reason response-store.js exists).
  if (body.previous_response_id) {
    const prior = getResponse(body.previous_response_id, callerKey);
    if (prior.ok) {
      chatBody = {
        ...chatBody,
        messages: mergeChainedMessages(prior.messages, chatBody.messages || []),
      };
    } else if (prior.reason === 'disabled') {
      return {
        status: 400,
        body: {
          error: {
            message: 'previous_response_id requires the response store, which is disabled on this server (RESPONSE_STORE_ENABLED=0). Send the full conversation in `input` instead.',
            type: 'invalid_request_error',
            param: 'previous_response_id',
          },
        },
      };
    } else {
      // Matches OpenAI: an unknown / expired / foreign id is a 404, never a
      // silent context reset.
      return {
        status: 404,
        body: {
          error: {
            // The id is client-supplied: sanitize before echoing it back. Raw
            // control characters would let a caller forge lines in any log that
            // records this error, and an unbounded value would be reflected in
            // full (safeLogValue strips C0/C1 + DEL and caps the length).
            message: `Previous response with id '${safeLogValue(body.previous_response_id, 64)}' not found.`
              + (chainable
                ? ' It may have expired (server-side conversations are retained for a limited time)'
                  + ' or was created with store:false.'
                : ' Server-side conversations require a per-caller identity: send `user`,'
                  + ' `safety_identifier` or `prompt_cache_key` on every turn of the conversation'
                  + ' (a single-user self-host can instead set WINDSURFAPI_SINGLE_TENANT_CACHE=1).')
              + ' Send the full conversation in `input` to continue without server-side state.',
            type: 'invalid_request_error',
            param: 'previous_response_id',
            code: 'response_not_found',
          },
        },
      };
    }
  }

  if (toolHygieneEnabled()
    && (chatBody.messages || []).some((m) => m?.role === 'assistant')) {
    chatBody = {
      ...chatBody,
      messages: normalizeHistoryTail(
        normalizeToolIdsInMessages(chatBody.messages || [], { seed: body.previous_response_id || 'responses' }),
        { fold: true },
      ),
    };
  }

  // P-03: the Devin Connect wire has no file/document field. responsesToChat
  // deliberately preserves typed file blocks for Cascade's image.js extractor,
  // so the backend-aware rejection belongs here: check the merged conversation
  // before dispatch, account acquisition, or any socket, and return 400 naming
  // `input`. Checking AFTER the previous_response_id merge also covers a stored
  // history written before this guard existed.
  if (selectBackend({ modelInfo: null }).flow === 'devin_connect') {
    const filePart = findFilePartInMessages(chatBody.messages || []);
    if (filePart) {
      const err = unsupportedFilePartError(filePart, { param: 'input' });
      return {
        status: 400,
        body: {
          error: {
            message: err.message,
            type: 'invalid_request_error',
            param: err.param,
            code: err.code,
          },
        },
      };
    }
  }

  // The conversation to persist for the NEXT turn: everything the upstream saw.
  const priorMessages = chatBody.messages || [];
  // V-12: the item sidecar is THIS module's bookkeeping (exact ordered output
  // items for GET replay and ordered chaining). It must never reach the upstream
  // request body, so every dispatch below uses this stripped copy while the
  // store keeps the annotated one.
  const dispatchMessages = priorMessages.map((m) => {
    if (!m || typeof m !== 'object' || !('__responses_items' in m)) return m;
    const { __responses_items, ...rest } = m;
    return rest;
  });
  // `terminal` carries the status this request REPORTED to the client, so a later
  // GET /v1/responses/{id} answers with the same thing instead of assuming
  // 'completed'. Defaults to a clean completion when the caller passes nothing.
  // `servedModel` is what the POST reported as response.model (the served name,
  // not the raw request string) so a later retrieval cannot contradict it.
  const commit = (assistantMessage, terminal = {}, servedModel = requestedModel, items = null) => {
    if (!isResponseStoreEnabled() || !chainable) return;
    // A06/KH-018: an upstream-truncated turn is not a completed assistant
    // reply. Committing it would poison the next request's context with a
    // half answer the client only saw as `incomplete` (or never received).
    // A LEGITIMATE length/content_filter truncation is still chainable — only
    // `upstream_incomplete` (the upstream never finished) is excluded.
    if (terminal.incompleteReason === 'upstream_incomplete') return;
    // G3: a FAILED turn (finish_reason 'error' / unterminated) has no complete
    // assistant reply either. Storing it would hand the next chained request a
    // half answer the client was explicitly told had failed.
    if (terminal.status === 'failed') return;
    try {
      const stored = putResponse(
        responseId,
        (() => {
          const base = instructionsMsg
            ? priorMessages.filter(m => m !== instructionsMsg)
            : priorMessages;
          // V-12: prefer the turn's ORDERED items. The flat assistant message is
          // only the fallback (no items available, or a turn that produced
          // nothing the item list could express). The sidecar on the last
          // assistant message is what GET replays and what keeps the exact item
          // identity across turns; it is stripped before anything is dispatched
          // upstream.
          const ordered = items?.length ? historyFromResponseItems(items, toolNameMap) : [];
          if (ordered.length) {
            ordered[ordered.length - 1] = { ...ordered[ordered.length - 1], __responses_items: items };
            return [...base, ...ordered];
          }
          return assistantMessage ? [...base, assistantMessage] : base;
        })(),
        callerKey,
        {
          model: servedModel || requestedModel,
          store: body.store,
          status: terminal.status || 'completed',
          incompleteReason: terminal.incompleteReason || null,
          metadata: responseMetadata,
        },
      );
      // putResponse's return value used to be dropped, so a refusal to store was
      // invisible from here: the client got 200 plus an id, and the id first
      // showed itself as a 404 on the NEXT turn — one round trip away from the
      // request that actually failed, with no server-side line to correlate.
      //
      // Only the surprising refusals are logged. `store:false` is not one: the
      // caller asked for no retention and got it, which is the OpenAI contract.
      // Nor is a missing callerKey reachable — `chainable` already returned above
      // for that, which is why `_stats.rejected`, whose only bump sits on that
      // branch, can never move from this call site. What IS reachable is an empty
      // conversation (`input: []` or omitted `input` both normalize to zero
      // messages, and neither is rejected upstream with a 400).
      if (!stored && wantsPersistence(body.store)) {
        log.warn(`Responses: store refused ${responseId} — client holds an id that will 404 (messages=${priorMessages.length}, assistant=${assistantMessage ? 'yes' : 'no'})`);
      }
    } catch { /* best-effort — never fail a served request over bookkeeping */ }
  };

  if (!body.stream) {
    const result = await chatHandler({ ...chatBody, messages: dispatchMessages, stream: false, __route: 'responses' }, context);
    if (result.status !== 200) return result;
    const msg = result.body?.choices?.[0]?.message;
    const responseBody = chatToResponse(result.body, requestedModel, responseId, genMessageId(), requestedTools, toolNameMap, responseMetadata, { includeReasoningEncrypted });
    // Record the status THIS response reported, so retrieval agrees with it.
    commit(msg ? {
      role: 'assistant',
      content: msg.content || '',
      ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
    } : null, {
      status: responseBody.status,
      incompleteReason: responseBody.incomplete_details?.reason || null,
    }, responseBody.model, responseBody.output);
    return { status: 200, body: responseBody };
  }

  // O1: the internal chat stream now omits the trailing usage frame unless the
  // caller opts in. This translator consumes chunk.usage (→ finalUsage → the
  // response.completed usage block), so it must opt in regardless of what the
  // Responses client sent — the Responses API reports usage on its own terminal
  // event, not via an OpenAI-style stream_options toggle.
  const streamResult = await chatHandler(
    { ...chatBody, messages: dispatchMessages, stream: true, __route: 'responses', stream_options: { ...(chatBody.stream_options || {}), include_usage: true } },
    context,
  );
  if (!streamResult.stream) return streamResult;

  return {
    status: 200,
    stream: true,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
    async handler(realRes) {
      const translator = new ResponsesStreamTranslator(realRes, responseId, requestedModel, requestedTools, toolNameMap, responseMetadata, { includeReasoningEncrypted });
      const captureRes = createCaptureRes(translator, realRes);

      realRes.on('close', () => {
        if (!captureRes.writableEnded) captureRes._clientDisconnected();
      });

      try {
        await streamResult.handler(captureRes);
        // Persist only a COMPLETED turn. Committing a half-turn (aborted or
        // errored) would poison the next request's context with a truncated
        // assistant reply the client never received.
        //
        // The gate is `aborted`, NOT `truncated`. Those are different things and
        // conflating them broke chaining for legitimate truncation: a turn that
        // ended with a real finish_reason of 'length' / 'content_filter' IS a
        // complete, client-delivered turn — the model stopped for a reason the
        // client can see and act on, and OpenAI lets it be chained from. The
        // non-streaming path always committed those, so gating the streaming path
        // on `truncated` split the two paths' behaviour for the identical
        // finish_reason (verified: streaming length → not chainable, non-streaming
        // length → chainable). That is this repo's recurring "fix covered only some
        // paths" trap.
        //
        // `aborted` is the case `failed` cannot see: a stream that ended with no
        // (real) terminal chunk at all raises no error, so it reached here looking
        // clean and its half answer was stored as the next turn's context.
        // `clientGone` (V-08): a drain timeout means the client stopped reading,
        // so the half turn it never received must not become the next turn's
        // context either.
        if (translator.finished && !translator.failed && !translator.aborted && !translator.clientGone) {
          // Same as the non-streaming path: persist the status the client was told,
          // so a later retrieval does not report a truncated turn as completed.
          const reason = translator.streamFinishReason;
          commit({
            role: 'assistant',
            content: translator.text || '',
            ...(translator.committedToolCalls?.length ? { tool_calls: translator.committedToolCalls } : {}),
          }, translator.truncated
            ? {
              status: 'incomplete',
              incompleteReason: reason === 'length' ? 'max_output_tokens' : 'content_filter',
            }
            : { status: 'completed' }, translator.model, translator.committedItems);
        }
      } catch (e) {
        log.error(`Responses stream error: ${e.message}`);
        translator.error(e);
      }

      // The `[DONE]` sentinel, after the terminal event and before the socket closes.
      // A direct Responses client does not need it — this API carries its outcome on
      // response.completed / .incomplete / .failed — but the relays sitting in front of
      // this one are OpenAI-shaped and read `[DONE]` as "the stream ended cleanly".
      // new-api drops the terminal event of a stream that lacks it, and that event is
      // the ONLY carrier of the usage block on this route (see the O1 comment above),
      // so its billing row silently came out empty. The chat exit has always written
      // this frame on both its success and its post-error path; this one never did,
      // which split the two routes' wire shape for the identical upstream.
      //
      // Gated on `finished` for the same reason finish() refuses to report an absent
      // finish_reason as 'completed': `[DONE]` is what a relay reads as "whole". A
      // client that vanished mid-answer never reaches captureRes.end(), so no terminal
      // `[DONE]` is what a relay reads as "whole". A client that vanished mid-answer
      // never reaches captureRes.end(), so no terminal event goes out — writing the
      // sentinel there would dress a half turn in an ending it never earned. Same rule
      // for a FAILED stream: `[DONE]` on `response.failed`/`response.incomplete` makes
      // a relay treat the failure as a clean stop, which is the exact hole this fix
      // exists to plug, on the failure side. chat.js's post-error path writes an
      // explicit error chunk before `[DONE]`; here the failure is already in the
      // terminal event, so the sentinel must simply not be written.
      // A06/KH-024: `aborted` is an upstream truncation, not a clean end. A
      // relay that sees [DONE] treats the stream as whole, which would erase
      // the only failure signal the Responses client got.
      // V-08: the sentinel is part of the same sequential emission — wait out any
      // outstanding drain so it cannot overtake a frame the socket has not taken.
      if (translator.finished && !translator.failed && !translator.aborted && !realRes.writableEnded) {
        await translator.settleEgress();
        translator.writeRaw('data: [DONE]\n\n');
      }
      if (!realRes.writableEnded) realRes.end();
    },
  };
}
