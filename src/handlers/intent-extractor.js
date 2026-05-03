/**
 * v2.0.72 (#115 #120 root-cause workaround) — NLU intent extractor.
 *
 * Cascade upstream's `SendUserCascadeMessage` proto has no OpenAI
 * `tools[]` field. The proxy injects tool definitions into the system
 * prompt (additional_instructions_section), but GPT / GLM / Kimi
 * weren't trained on prompt-level tool-calling protocols — they see the
 * `<tool_call>{"name":...}</tool_call>` instructions, decide to call
 * the tool, but emit it as natural-language NARRATION instead of the
 * exact markup we asked for. v2.0.71 fabricate detection just flagged
 * these as failures; v2.0.72 actually RECOVERS the call.
 *
 * Real probe captures (from scripts/probes/v2071-glm-kimi-tool-probe):
 *
 *   GLM-4.7  → "I should call the shell_exec function with the command
 *               'echo HELLO_FROM_PROBE'."
 *   GLM-5.1  → "I'll run the shell command as requested."  (no args!)
 *   GPT-5.5  → "PROBE_V0270_1777751588"  (pure fabricated output)
 *
 * The first one carries enough signal to reconstruct the call; the
 * second has the intent but no args; the third is hopeless. Layered
 * extraction:
 *
 *   Layer 1 (highest confidence) — explicit invocation syntax:
 *     "Let me run shell_command(command='echo HELLO')"
 *     "function_call: shell_exec(\"echo HELLO\")"
 *
 *   Layer 2 — backtick-quoted name + value:
 *     "I'll call `shell_exec` with command `echo HELLO`"
 *     "use the `Read` function with file_path `/etc/hosts`"
 *
 *   Layer 3 — natural narrative (model "thinking out loud"):
 *     "I should call the shell_exec function with the command 'echo HI'"
 *     "Let me invoke the Read tool to read /etc/hosts"
 *
 * Each layer requires the extracted name to match a caller-declared
 * tool. Layer 3 also requires the user prompt to plausibly want a
 * tool call (shell-style verbs in the most recent user message).
 *
 * Conservative by design: false-positive tool_calls drive agent loops
 * to execute things the model didn't actually decide on. When in
 * doubt, return [].
 */

import { log } from '../config.js';

/**
 * @typedef {Object} ExtractedToolCall
 * @property {string} name        OpenAI tool name (matches caller's tools[])
 * @property {string} argumentsJson  JSON-stringified args
 * @property {'explicit-syntax'|'backtick-quoted'|'narrative'} layer
 * @property {number} confidence  0..1
 */

/**
 * Build a Set of declared tool names + a name → primaryParamName map
 * for inference of single-arg shorthands ("with command 'echo X'" →
 * arguments.command = 'echo X').
 */
function indexTools(tools) {
  const names = new Set();
  const primaryParam = new Map(); // tool name → first required string param
  if (!Array.isArray(tools)) return { names, primaryParam };
  for (const t of tools) {
    if (t?.type !== 'function') continue;
    const name = t.function?.name;
    if (!name || typeof name !== 'string') continue;
    names.add(name);
    const params = t.function?.parameters;
    if (params?.type === 'object' && params.properties) {
      const required = Array.isArray(params.required) ? params.required : [];
      let primary = required[0];
      // Prefer the first required string-typed param (`command`,
      // `file_path`, `query`) — that's the one models naturally
      // mention with "with command X" / "with file Y" narrative.
      for (const r of required) {
        const p = params.properties[r];
        if (p?.type === 'string') { primary = r; break; }
      }
      // Fall through to first declared property if no required ones.
      if (!primary) {
        const keys = Object.keys(params.properties || {});
        primary = keys.find(k => params.properties[k]?.type === 'string') || keys[0];
      }
      if (primary) primaryParam.set(name, primary);
    }
  }
  return { names, primaryParam };
}

// Regex utilities — escape user-controlled tool name for regex insertion.
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// v2.0.78 (#120 follow-up + audit H-2): values extracted from narrative
// can easily be a generic noun phrase ("a shell command", "the file",
// "your input") or a literal placeholder keyword ("command",
// "argument"). Both produce garbage tool_calls — the agent loop will
// then try to execute `command` as a literal command, fail, and recurse.
// Reject these uniformly across all three layers.
const PLACEHOLDER_KEYWORDS = new Set([
  'command', 'argument', 'arguments', 'param', 'parameter',
  'parameters', 'input', 'value', 'file_path', 'filepath', 'path',
  'query', 'string', 'text', 'name', 'arg', 'output',
]);
const ARTICLE_PREFIX_RE = /^(?:a|an|the|this|that|these|those|your|my|our|some|any|each|every)\s+/i;

function looksLikePlaceholderValue(value) {
  if (typeof value !== 'string' || !value.trim()) return true;
  const v = value.trim();
  // Strip trailing punctuation (`.`, `,`, `;`, `:`) before comparison.
  const stripped = v.replace(/[.,;:!?]+$/, '');
  if (PLACEHOLDER_KEYWORDS.has(stripped.toLowerCase())) return true;
  // Article-led phrase ("a shell command", "the file") — model
  // narrating about the call rather than supplying the call value.
  if (ARTICLE_PREFIX_RE.test(stripped)) return true;
  return false;
}

/**
 * Layer 1: explicit invocation syntax.
 *
 *   shell_command(command="echo X")
 *   shell_exec("echo X")
 *   function_call: name=shell_exec args={"command":"echo X"}
 */
function extractLayer1(text, names) {
  const out = [];
  // function_name(arg=value) or function_name("value")
  const reExplicit = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(?:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)?["'`]([^"'`)]{1,2000})["'`]\s*\)/g;
  let m;
  while ((m = reExplicit.exec(text)) !== null) {
    const [, fn, paramName, value] = m;
    if (!names.has(fn)) continue;
    if (looksLikePlaceholderValue(value)) continue;
    const args = paramName ? { [paramName]: value } : { _value: value };
    out.push({
      name: fn,
      argumentsJson: JSON.stringify(args),
      layer: 'explicit-syntax',
      confidence: paramName ? 0.95 : 0.85,
    });
  }
  // function_call: name=X args={...}
  const reFc = /function[_\s]?call\s*[:=][^{]*?\bname\s*[:=]\s*["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?[^{]*?(\{[\s\S]{1,2000}?\})/g;
  while ((m = reFc.exec(text)) !== null) {
    const [, fn, argsBlob] = m;
    if (!names.has(fn)) continue;
    let args = {};
    try { args = JSON.parse(argsBlob); } catch {}
    out.push({
      name: fn,
      argumentsJson: JSON.stringify(args),
      layer: 'explicit-syntax',
      confidence: 0.9,
    });
  }
  return out;
}

/**
 * Layer 2: backtick-quoted name + later backtick-quoted value.
 *
 *   "I'll call `shell_exec` with command `echo HELLO`"
 *   "use the `Read` function with file_path `/etc/hosts`"
 */
function extractLayer2(text, names, primaryParam) {
  const out = [];
  for (const fn of names) {
    const fnRe = new RegExp(`\\\`${escapeRe(fn)}\\\``, 'g');
    let m;
    while ((m = fnRe.exec(text)) !== null) {
      // Look for next backtick-quoted token within 200 chars
      const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 200);
      // Capture optional "with PARAM `value`" or just "`value`"
      const argRe = /(?:with\s+)?(?:the\s+)?(?:argument|param|parameter|input|command|file[_-]?path|path|query)?\s*[:=]?\s*`([^`]{1,1000})`/i;
      const a = tail.match(argRe);
      if (!a) continue;
      const value = a[1];
      if (looksLikePlaceholderValue(value)) continue;
      const param = primaryParam.get(fn) || 'input';
      out.push({
        name: fn,
        argumentsJson: JSON.stringify({ [param]: value }),
        layer: 'backtick-quoted',
        confidence: 0.8,
      });
    }
  }
  return out;
}

/**
 * Layer 3: natural narrative.
 *
 *   "I should call the shell_exec function with the command 'echo HI'"
 *   "Let me invoke the Read tool to read /etc/hosts"
 *   "I'll run shell_command with command echo HELLO"
 */
function extractLayer3(text, names, primaryParam) {
  const out = [];
  // Verbs models actually use to announce a tool call.
  const verbs = '(?:call|invoke|run|use|execute|exec|trigger|fire)';
  const articles = '(?:the\\s+)?';
  const suffix = '(?:\\s+(?:function|tool|method|command))?';
  for (const fn of names) {
    // Pattern: "<verb> [the] [function|tool] <fn> [function|tool]"
    const namePat = new RegExp(
      `\\b${verbs}\\s+${articles}(?:function|tool|method)?\\s*\\\`?${escapeRe(fn)}\\\`?${suffix}`,
      'gi',
    );
    let m;
    while ((m = namePat.exec(text)) !== null) {
      // Hunt for value within next 200 chars: "with [the] [param] '<value>'"
      // OR "with [the] [param] `<value>`" OR "to <verb> <value>"
      const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 300);
      // ordered by specificity:
      const argPatterns = [
        // with the command 'echo X' / with command "echo X" / with command `echo X`
        /\bwith\s+(?:the\s+)?(?:command|argument|param(?:eter)?|input|file[_-]?path|path|query)\s+["'`]([^"'`\n]{1,500})["'`]/i,
        // with 'echo X' (no param keyword)
        /\bwith\s+["'`]([^"'`\n]{1,500})["'`]/i,
        // to read /etc/hosts (positional after action verb)
        /\bto\s+(?:read|run|execute|view|search|find|cat|ls)\s+([\S][^\n]{0,200})/i,
        // : 'echo X' / = 'echo X'
        /[:=]\s*["'`]([^"'`\n]{1,500})["'`]/,
      ];
      let value = null;
      for (const pat of argPatterns) {
        const a = tail.match(pat);
        if (a && a[1]) { value = a[1].trim(); break; }
      }
      if (!value) continue;
      // v2.0.76 + v2.0.78 (audit H-2): reject placeholder keywords
      // (`command` / `argument` / ...) AND article-led prose phrases
      // (`a shell command` / `the file` / `your input`). GLM-4.7
      // narrative reproducer "to run a shell command" was capturing
      // "a shell command." as the value pre-v2.0.78 even with the
      // single-word filter in place.
      if (looksLikePlaceholderValue(value)) continue;
      const param = primaryParam.get(fn) || 'input';
      out.push({
        name: fn,
        argumentsJson: JSON.stringify({ [param]: value }),
        layer: 'narrative',
        confidence: 0.65,
      });
    }
  }
  return out;
}

/**
 * Detect whether the user prompt asked for an action a function could
 * perform. Layer 3 (narrative) only fires when this is true to avoid
 * false-positive tool_call extraction from casual chat.
 */
function userPromptLooksActionable(lastUserText) {
  if (!lastUserText) return false;
  return /\b(?:run|exec|execute|cat|ls|echo|grep|find|read|search|list|invoke|call|fetch|get|fix|edit|write|patch)\b/i.test(lastUserText)
    || /\b(?:shell|bash|terminal|command|tool|function|file|path)\b/i.test(lastUserText);
}

/**
 * Top-level extractor. Returns a deduped, confidence-sorted list of
 * extracted tool_calls. Empty array when nothing is recoverable.
 *
 * Set the `WINDSURFAPI_NLU_RECOVERY=0` env to turn off entirely
 * (default ON).
 */
export function extractIntentFromNarrative(text, tools, opts = {}) {
  if (process.env.WINDSURFAPI_NLU_RECOVERY === '0') return [];
  if (typeof text !== 'string' || !text.trim()) return [];
  if (!Array.isArray(tools) || !tools.length) return [];
  const lastUserText = opts.lastUserText || '';
  const minConfidence = typeof opts.minConfidence === 'number' ? opts.minConfidence : 0.65;
  // v2.0.78 (audit H-4): structural markers MAY indicate a malformed
  // protocol attempt — Layer 3 narrative around it tends to be
  // descriptive prose, not args. v2.0.79 narrowed the gate after
  // GLM-4.7 e2e probe regressed: GLM emits `markers=bare_json`
  // (because thinking text contains JSON-shaped fragments) AND a
  // legitimate narrate; Layer 3 is exactly what catches the narrate.
  // Now we only skip Layer 3 for `xml_tag` (Claude's tool_use shape)
  // — that's where parser-failure → Layer 3 most often produces
  // false positives. fenced_json / bare_json / openai_native still
  // allow Layer 3 because models emitting those shapes (GLM, Kimi,
  // some GPT) also reliably narrate the call in surrounding prose.
  const markers = Array.isArray(opts.markers) ? opts.markers : [];
  const skipLayer3 = markers.includes('xml_tag') && !markers.includes('natural_lang');

  const { names, primaryParam } = indexTools(tools);
  if (!names.size) return [];

  const all = [
    ...extractLayer1(text, names),
    ...extractLayer2(text, names, primaryParam),
    ...(!skipLayer3 && userPromptLooksActionable(lastUserText) ? extractLayer3(text, names, primaryParam) : []),
  ];
  if (!all.length) return [];

  // Dedupe by (name, argumentsJson). Keep the highest-confidence pick.
  const byKey = new Map();
  for (const tc of all) {
    if (tc.confidence < minConfidence) continue;
    const key = `${tc.name}::${tc.argumentsJson}`;
    const existing = byKey.get(key);
    if (!existing || tc.confidence > existing.confidence) byKey.set(key, tc);
  }
  const recovered = [...byKey.values()].sort((a, b) => b.confidence - a.confidence);
  if (recovered.length) {
    log.info(`NLU recovery: extracted ${recovered.length} tool_call(s) from narrative — ${recovered.map(t => `${t.name}@${t.layer}/${t.confidence.toFixed(2)}`).join(', ')}${skipLayer3 ? ' (layer3-skipped: structural markers seen)' : ''}`);
  }
  return recovered;
}
