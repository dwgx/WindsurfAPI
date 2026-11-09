/**
 * Tool types this proxy cannot execute, shared by the OpenAI-family surfaces.
 *
 * A tool is "server-executed" when its execution lives on the server side, not
 * the client's: file_search, computer_use_preview, mcp, code_interpreter,
 * image_generation, local_shell, shell and the hosted apply_patch. Hosted search
 * (web_search / web_search_preview) is the same contract — the caller is asking
 * THIS SERVER to run the search. This proxy has no executor for any of them, so
 * /v1/responses and /v1/chat/completions refuse them up front with an actionable
 * 400 instead of running a turn whose tool cannot exist.
 *
 * Refusing is the point. /v1/responses used to drop the three oldest types in
 * silence and every later one through its `unknown tool type` catch-all; the
 * chat surface dropped ALL of them silently — every consumer filters on
 * `type === 'function'` (the text preamble in tool-emulation.js and the native
 * #10 ToolDef encoder in devin-connect.js). Either way the client declared a
 * server-executed tool, received a normal answer, and never learned the tool did
 * not exist (evidence/DataAuditTools/findings.md F3).
 *
 * The one ambiguity is apply_patch: `{type:'apply_patch'}` is the hosted tool and
 * is refused, while `{type:'function'|'custom', name:'apply_patch'}` is the
 * client-run tool codex clients declare and passes through untouched. Only
 * `tool.type` decides.
 *
 * Both surfaces decide with these predicates so the set cannot drift apart.
 */

const UNBRIDGED_SERVER_SIDE_TYPES = new Set([
  'file_search',
  'computer_use_preview',
  'mcp',
  'code_interpreter',
  'image_generation',
  'local_shell',
  'shell',
  'apply_patch',
]);

// Server-executed tools are a VERSIONED family too: OpenAI ships dated snapshots
// (`code_interpreter_2025_03_11`) next to the unversioned aliases, and every
// spelling asks THIS SERVER to execute the tool. An exact-match set sent each
// new snapshot to the catch-all, which warned and dropped it — a 200 with the
// tool gone. Strip a trailing `_YYYY_MM_DD` and re-test the set: that covers
// every current and future snapshot of a member, and a type that is not a
// member either way still falls to the lenient warn+drop path.
const SERVER_SIDE_VERSION_SUFFIX = /_\d{4}_\d{2}_\d{2}$/;

export function isServerSideToolType(type) {
  if (typeof type !== 'string') return false;
  if (UNBRIDGED_SERVER_SIDE_TYPES.has(type)) return true;
  return UNBRIDGED_SERVER_SIDE_TYPES.has(type.replace(SERVER_SIDE_VERSION_SUFFIX, ''));
}

const HOSTED_SEARCH_TYPES = new Set(['web_search', 'web_search_preview']);
// Hosted search is a VERSIONED tool family: OpenAI ships dated snapshots of the
// same hosted tool (`web_search_preview_2025_03_11`, `web_search_2025_08_26`)
// next to the unversioned aliases. Every spelling asks THIS SERVER to execute
// the search, so the gate matches the family. An exact-match list forwards the
// next snapshot to the model and then drops it — the silent non-execution this
// rejection exists to prevent.
const HOSTED_SEARCH_VERSIONED_TYPE = /^web_search(?:_preview)?_\d{4}_\d{2}_\d{2}$/;

export function isHostedSearchType(type) {
  return typeof type === 'string'
    && (HOSTED_SEARCH_TYPES.has(type) || HOSTED_SEARCH_VERSIONED_TYPE.test(type));
}

/**
 * /v1/responses refusal for a hosted search tool. Kept separate from the
 * server-executed error because the Responses dialect has its own code
 * (`unsupported_hosted_tool`) and clients branch on it.
 */
export function hostedSearchUnsupported(param) {
  const err = new Error(
    'Hosted web_search is not supported by this proxy: it does not execute server-side searches. '
    + 'Remove the hosted web_search/web_search_preview tool (including its versioned aliases) and, '
    + 'if the client will run the search itself, declare a normal function tool named "web_search".',
  );
  err.param = param;
  err.code = 'unsupported_hosted_tool';
  return err;
}

/**
 * /v1/responses refusal for a server-executed tool.
 */
export function serverSideToolUnsupported(type, param) {
  const err = new Error(
    `Server-executed tool "${type}" is not supported by this proxy: it requires an executor that runs on `
    + 'this server, and this proxy has none. Remove it and, if the client will run the tool itself, declare '
    + `a normal function tool instead. Rejected server-side types: ${[...UNBRIDGED_SERVER_SIDE_TYPES].sort().join(', ')}.`,
  );
  err.param = param;
  err.code = 'unsupported_server_side_tool';
  return err;
}

/**
 * /v1/chat/completions refusal. The chat dialect carries ONE code for both
 * families (`unsupported_server_side_tool`) because chat clients written against
 * the 2025 surface branch on that family; the message still names the concrete
 * type and the workaround.
 */
export function chatServerSideToolUnsupported(type, param = 'tools') {
  const detail = isHostedSearchType(type)
    ? `Hosted tool "${type}" is not supported by this proxy: it does not execute server-side web searches. `
      + 'Remove it and, if the client will run the search itself, declare a normal function tool named "web_search".'
    : `Server-executed tool "${type}" is not supported by this proxy: it requires an executor that runs on `
      + 'this server, and this proxy has none. Remove it and, if the client will run the tool itself, declare '
      + 'a normal function tool instead.';
  const err = new Error(
    `${detail} Rejected types: ${[...UNBRIDGED_SERVER_SIDE_TYPES].sort().join(', ')}, `
    + 'plus hosted web_search/web_search_preview (versioned snapshots included).',
  );
  err.param = param;
  err.code = 'unsupported_server_side_tool';
  return err;
}

// A namespace may carry its children under any of these keys. The gates walk
// EVERY array-valued one: a namespace with `tools: []` and `children: [mcp]`
// used to walk the empty first key and miss the server-executed child entirely,
// returning a 200 with that tool gone and not even a warning.
// (responses.js flattenResponseTool still picks a single key when forwarding;
// that selection is unchanged — this walk only decides what must be refused.)
const NAMESPACE_CHILD_KEYS = ['tools', 'children', 'functions', 'items'];

/**
 * Visit every tool in a list, recursing into namespaces. Shared by the
 * hosted-search and server-executed gates so both cover the same positions.
 */
export function forEachTool(tools, visit) {
  for (const tool of tools || []) {
    if (!tool || typeof tool !== 'object') continue;
    visit(tool);
    if (tool.type === 'namespace') {
      for (const key of NAMESPACE_CHILD_KEYS) {
        if (Array.isArray(tool[key])) forEachTool(tool[key], visit);
      }
    }
  }
}

/**
 * First tool type in `tools` (namespaces included) that this proxy cannot
 * execute, or null. The chat admission gate reports one 400 for the request.
 */
export function firstUnsupportedServerToolType(tools) {
  let found = null;
  forEachTool(tools, (tool) => {
    if (found) return;
    if (isHostedSearchType(tool.type) || isServerSideToolType(tool.type)) found = tool.type;
  });
  return found;
}

// ─── Gemini native server-side tools ────────────────────────────────────────
//
// Gemini declares server-executed tools as BARE KEYS on a tool object
// (`{googleSearch:{}}`, `{codeExecution:{}}`, `{urlContext:{}}`) rather than as
// a `type` string. The translator used to count them and drop them with a log
// line, so a spec-conforming Gemini client received a normal answer for a turn
// whose search/execution never happened — the same silent non-execution that
// the OpenAI-family gates above exist to prevent (Q4 G06). They are refused
// here, through the same `unsupported_server_side_tool` code, so every surface
// reports the same typed error.
//
// `googleSearchRetrieval` is the pre-2.0 alias for googleSearch; both spellings
// ask this server to run the search. googleMaps / fileSearch / computerUse /
// mcpServers are also server-executed, but no client in the repo sends them and
// the audit scoped this gate to the three documented tools; leave the rest to
// the catch-all rather than widening the refusal without a measured caller.
const GEMINI_SERVER_SIDE_TOOL_KEYS = ['googleSearch', 'googleSearchRetrieval', 'codeExecution', 'urlContext'];

/** First Gemini server-executed tool key declared in `tools`, or null. */
export function firstUnsupportedGeminiServerTool(tools) {
  for (const tool of tools || []) {
    if (!tool || typeof tool !== 'object') continue;
    for (const key of GEMINI_SERVER_SIDE_TOOL_KEYS) {
      if (tool[key]) return key;
    }
  }
  return null;
}

/**
 * Gemini-surface refusal for a server-executed tool. The Gemini error envelope
 * is built by `geminiError`; this only carries the typed code + the message so
 * the handler can map it without inventing a second vocabulary.
 */
export function geminiServerSideToolUnsupported(name, param = 'tools') {
  const err = new Error(
    `Gemini server-side tool "${name}" is not supported by this proxy: it requires an executor that runs on `
    + 'this server, and this proxy has none. Remove it and, if the client will run the tool itself, declare '
    + `a normal functionDeclaration instead. Rejected tools: ${GEMINI_SERVER_SIDE_TOOL_KEYS.join(', ')}.`,
  );
  err.param = param;
  err.code = 'unsupported_server_side_tool';
  err.status = 400;
  return err;
}
