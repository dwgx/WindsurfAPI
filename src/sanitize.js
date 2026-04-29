/**
 * Strip server-internal filesystem paths from model output before it reaches
 * the API caller.
 *
 * Background: Cascade's baked-in system context tells the model its workspace
 * lives at /tmp/windsurf-workspace. Even after we removed CascadeToolConfig
 * .run_command (see windsurf.js buildCascadeConfig) the model still
 *   (a) narrates "I'll look at /tmp/windsurf-workspace/config.yaml" in plain
 *       text, and
 *   (b) occasionally emits built-in edit_file / view_file / list_directory
 *       trajectory steps whose argumentsJson references these paths.
 * Both routes leak the proxy's internal filesystem layout to API callers.
 *
 * This module provides two scrubbers:
 *   - sanitizeText(s)        — one-shot, use on accumulated buffers
 *   - PathSanitizeStream     — incremental, use on streaming chunks
 *
 * The streaming version holds back any tail that could be an incomplete
 * prefix of a sensitive literal OR a match-in-progress whose path-tail hasn't
 * hit a terminator yet, so a path cannot slip through by straddling a chunk
 * boundary.
 */

// Detect the actual project root from this module's path so the sanitizer
// covers deployments outside /root/WindsurfAPI (e.g. /srv/WindsurfAPI).
import { fileURLToPath as _fileURLToPath } from 'url';
const _repoRoot = (() => {
  try {
    const thisFile = _fileURLToPath(import.meta.url);
    // sanitize.js is in src/, so project root is one directory up.
    // Handle both / and \ separators for cross-platform support.
    return thisFile.replace(/[/\\]src[/\\]sanitize\.js$/, '');
  } catch { return process.cwd(); }
})();

// Placeholder history: every marker has to avoid becoming either a fake path
// the model reuses in tool calls or a fake answer the model repeats to users.
//   ./tail                    → LLM Reads ./src/main.py → ENOENT → loops
//   [internal]                → LLM runs `ls [internal]` → ENOENT → loops
//   <redacted-path>           → LLM passes to Read/Bash → ENOENT (Linux) /
//                               Errno 22 (Windows) → loops
//   (internal path redacted)  → zsh parses `cd (internal path redacted)`
//                               as glob-qualifier syntax → cryptic
//                               "unknown file attribute: i" error
//   redacted internal path    → Opus 4.7 echoes it verbatim into bash
//                               commands; reads to the model as a
//                               plausible directory name and the
//                               failure mode is `cd: too many arguments`
//                               which still wastes 2-3 turns
//   …                         → avoids shell loops, but Sonnet 4.6 can echo
//                               it in prose as "your path is …", causing a
//                               user-visible answer loop when asked for the
//                               project path.
// Current marker is structural and explicit: it tells the user/model the
// workspace path is intentionally hidden, without looking like a real absolute
// path or a literal ellipsis answer. The proto/tool preamble also tells the
// model not to answer project-path questions by echoing this marker.
// Verified with the drift probe (scripts/_agent_drift_probe.py).
const REDACTED_PATH = '<workspace>';

// Path body char class: anything that's not whitespace or syntax-terminator.
// Used in patterns and in cut-point detection — must match.
// Note: `\\` is INSIDE the char class so backslash-separated tails (Windows
// style: `\home\user\projects\workspace-x\src\index.js`) keep extending the
// match instead of terminating at the first backslash.
const PATTERNS = [
  [/\/tmp\/windsurf-workspace(?:[/\\][^\s"'`<>)}\],*;]*)?/g, REDACTED_PATH],
  // Unix and Windows-mixed forms — issue #86 reports of
  // `C:\home\user\projects\workspace-devinxse` leaking despite the Unix-only
  // regex catching `/home/user/projects/workspace-skxwsx01`. Cover:
  //   /home/user/projects/workspace-x[/...]
  //   \home\user\projects\workspace-x[\...]
  //   C:\home\user\projects\workspace-x[\...]
  //   C:\home/user/projects/workspace-x  (mixed separators, GLM-style hallucination)
  [/(?:[A-Za-z]:)?[/\\]home[/\\]user[/\\]projects[/\\]workspace-[a-z0-9]+(?:[/\\][^\s"'`<>)}\],*;]*)?/g, REDACTED_PATH],
  [/\/opt\/windsurf(?:[/\\][^\s"'`<>)}\],*;]*)?/g, REDACTED_PATH],
  [new RegExp(_repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[/\\\\][^\\s"\'`<>)}\\],*;]*)?', 'g'), REDACTED_PATH],
];

// Bare literals (no path tail) used by the streaming cut-point finder.
// Listed once per separator/prefix shape so the partial-prefix detection
// can hold back the right tail length on stream chunks.
const SENSITIVE_LITERALS = [
  '/tmp/windsurf-workspace',
  '/home/user/projects/workspace-',
  '\\home\\user\\projects\\workspace-',
  '/opt/windsurf',
  _repoRoot,
];

// Character class that counts as part of a path body. Mirrors the PATTERNS
// regex char class so cut-point detection matches replacement behaviour.
const PATH_BODY_RE = /[^\s"'`<>)}\],*;]/;

/**
 * Apply all path redactions to `s` in one pass. Safe to call on any string;
 * non-strings and empty strings are returned unchanged.
 */
export function sanitizeText(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/**
 * Incremental sanitizer for streamed deltas.
 *
 * Usage:
 *   const stream = new PathSanitizeStream();
 *   for (const chunk of deltas) emit(stream.feed(chunk));
 *   emit(stream.flush());
 *
 * The returned string from feed()/flush() is guaranteed to contain no
 * sensitive literal. Any trailing text that COULD extend into a sensitive
 * literal (either as a partial prefix or as an unterminated path tail) is
 * held internally until the next feed or the flush.
 */
export class PathSanitizeStream {
  constructor() {
    this.buffer = '';
  }

  feed(delta) {
    if (!delta) return '';
    this.buffer += delta;
    const cut = this._safeCutPoint();
    if (cut === 0) return '';
    const safeRegion = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    return sanitizeText(safeRegion);
  }

  // Largest index into this.buffer such that buffer[0:cut] contains no
  // match that could extend past `cut`. Two conditions back off the cut:
  //   (1) a full sensitive literal was found but its path body ran to the
  //       end of the buffer — the next delta might append more path chars,
  //       in which case the fully-rendered path would differ. Hold from the
  //       literal's start.
  //   (2) the buffer tail is itself a proper prefix of a sensitive literal
  //       (e.g., ends with "/tmp/win") — the next delta might complete it.
  //       Hold from that tail start.
  _safeCutPoint() {
    const buf = this.buffer;
    const len = buf.length;
    let cut = len;

    // (1) unterminated full literal
    for (const lit of SENSITIVE_LITERALS) {
      let searchFrom = 0;
      while (searchFrom < len) {
        const idx = buf.indexOf(lit, searchFrom);
        if (idx === -1) break;
        let end = idx + lit.length;
        while (end < len && PATH_BODY_RE.test(buf[end])) end++;
        if (end === len) {
          if (idx < cut) cut = idx;
          break;
        }
        searchFrom = end + 1;
      }
    }

    // (2) partial-prefix tail
    for (const lit of SENSITIVE_LITERALS) {
      const maxLen = Math.min(lit.length - 1, len);
      for (let plen = maxLen; plen > 0; plen--) {
        if (buf.endsWith(lit.slice(0, plen))) {
          const start = len - plen;
          if (start < cut) cut = start;
          break;
        }
      }
    }

    return cut;
  }

  flush() {
    const out = sanitizeText(this.buffer);
    this.buffer = '';
    return out;
  }
}

/**
 * Sanitize a tool call before surfacing to the client. Covers three carriers
 * a leaked path can ride:
 *   - argumentsJson  (OpenAI-emulated + legacy native)
 *   - result         (native Cascade tool result)
 *   - input          (Anthropic-format parsed input dict — the hot path
 *                     used by Claude Code streaming, issue #38)
 * Without the `input` scrub, the stream handler would emit a tool_use
 * delta whose file_path still references /home/user/projects/workspace-x
 * and Claude Code would try to Read a path that doesn't exist locally.
 */
export function sanitizeToolCall(tc) {
  if (!tc) return tc;
  const out = { ...tc };
  if (typeof tc.argumentsJson === 'string') out.argumentsJson = sanitizeText(tc.argumentsJson);
  if (typeof tc.result === 'string') out.result = sanitizeText(tc.result);
  if (tc.input && typeof tc.input === 'object' && !Array.isArray(tc.input)) {
    const safe = {};
    for (const [k, v] of Object.entries(tc.input)) {
      safe[k] = typeof v === 'string' ? sanitizeText(v) : v;
    }
    out.input = safe;
  }
  return out;
}
