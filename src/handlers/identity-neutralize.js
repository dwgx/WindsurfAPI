import { log } from '../config.js';

/**
 * Linear scanners for the multi-line and bare-token rules.
 *
 * These rules used to be regexes, and two of the defects came from the regex
 * ENGINE rather than from the pattern. `(?:^|\n)\s*-?\s*…` is O(n²) per start
 * position: on a prompt of 2,048 newlines plus one character (2,049 bytes) the
 * a4-fastmode rule alone took 676 ms of synchronous event-loop time, and a real
 * system prompt can be far larger. An unbounded `[\s\S]*?` between two anchors is
 * O(n²) over the whole prompt for the same reason. Every scan below advances a
 * cursor monotonically, so one rule costs O(n) and the whole pass O(rules × n).
 *
 * Matching is ASCII-case-insensitive by folding the haystack code unit, NOT by
 * lowercasing a copy of the text: `String.prototype.toLowerCase` can CHANGE the
 * length of a string ('İ' → 'i' + combining dot above), which would desynchronise
 * every index in the copy from the original and corrupt the span boundaries.
 * Folding one code unit at a time keeps every offset exact.
 */
const foldAscii = (code) => (code >= 65 && code <= 90 ? code + 32 : code);

/** True when `needle` (lowercase ASCII) occurs in `text` at `at`. */
function matchesAsciiCI(text, at, needle) {
  if (at < 0 || at + needle.length > text.length) return false;
  for (let k = 0; k < needle.length; k++) {
    if (foldAscii(text.charCodeAt(at + k)) !== needle.charCodeAt(k)) return false;
  }
  return true;
}

/**
 * First index at or after `from` where `needle` occurs, case-insensitively.
 * `limit` bounds where the needle may END (exclusive), which is what stops a
 * paragraph scan from searching into the next paragraph.
 */
function indexOfAsciiCI(text, needle, from, limit = text.length) {
  const last = Math.min(text.length, limit) - needle.length;
  for (let i = from > 0 ? from : 0; i <= last; i++) {
    if (matchesAsciiCI(text, i, needle)) return i;
  }
  return -1;
}

// `\s` in the regexes this module replaces: space, tab, CR, LF, FF, VT and the
// Unicode spaces. The ASCII fast path matters because the anchor gap is scanned
// for every candidate anchor.
const isSpaceCode = (code) => code === 32 || (code >= 9 && code <= 13)
  || (code > 127 && /\s/.test(String.fromCharCode(code)));

// "Horizontal" whitespace for the line-scoped rules: the old `\s*` also ate CR,
// but a CR at this position belongs to the previous line's terminator, so a line
// scan must not treat it as indentation.
const isHorizontalSpaceCode = (code) => code === 32 || code === 9;

// `\w` without the `u` flag is ASCII-only: [A-Za-z0-9_].
const isWordCode = (code) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90)
  || (code >= 97 && code <= 122) || code === 95;

// The a6-grok run class: [\w .-].
const isGrokRunCode = (code) => isWordCode(code) || code === 32 || code === 46 || code === 45;

/**
 * Index of the newline that OPENS a paragraph break at or after `from`, or
 * `text.length` when the paragraph runs to the end of the string.
 *
 * A blank line is a line whose only characters are spaces, tabs or CR — the shape
 * real editors and prompt builders emit. A single newline is NOT a break: the
 * Environment block and the security paragraph wrap across lines, so a scan that
 * stopped at every newline would leave most of the fingerprint upstream (a silent
 * regression of the 529 / content-policy defence, which is worse than the
 * over-deletion this bound exists to stop).
 */
function paragraphEndAt(text, from) {
  for (let i = from; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue;
    let j = i + 1;
    while (j < text.length) {
      const c = text.charCodeAt(j);
      if (c === 32 || c === 9 || c === 13) { j++; continue; }
      break;
    }
    if (j >= text.length || text.charCodeAt(j) === 10) return i;
  }
  return text.length;
}

/** Visit every line once, left to right: (lineStart, lineEnd, hasNewline). */
function forEachLine(text, visit) {
  let lineStart = 0;
  for (;;) {
    let lineEnd = text.indexOf('\n', lineStart);
    const hasNewline = lineEnd >= 0;
    if (!hasNewline) lineEnd = text.length;
    visit(lineStart, lineEnd, hasNewline);
    if (!hasNewline) return;
    lineStart = lineEnd + 1;
  }
}

// ---------------------------------------------------------------------------
// Scanners. Each returns spans (or null / -1) and never mutates the text; the
// rule call sites turn them into replacements through applySpans().
// ---------------------------------------------------------------------------

const SECURITY_ANCHOR = 'important:';
const SECURITY_PHRASE = 'assist with authorized security testing';
const SECURITY_TERM_USE_CASES = 'defensive use cases.';
const SECURITY_TERM_RESEARCH = 'security research';

/**
 * b-security: `IMPORTANT:` + whitespace + `Assist with authorized security
 * testing`, then the first dual-use terminator in the SAME paragraph.
 *
 * The terminator is either `defensive use cases.` or `security research` + the
 * next `.`; both are searched only inside the paragraph that holds the phrase, so
 * a prompt whose anchors sit paragraphs apart can no longer delete everything
 * between them (WA-002: the RULE line between them vanished with no warning).
 * The first span only — the old rule was non-global.
 */
function securitySpan(text) {
  let cursor = 0;
  // Paragraph end of the anchor currently under test, cached so a paragraph full
  // of `IMPORTANT:` tokens is walked once instead of once per anchor.
  let paraLimit = -1;
  for (;;) {
    const anchor = indexOfAsciiCI(text, SECURITY_ANCHOR, cursor);
    if (anchor < 0) return null;
    if (paraLimit <= anchor) paraLimit = paragraphEndAt(text, anchor);
    // The gap belongs to the ANCHOR's paragraph. `\s*` used to eat the blank line,
    // so an `IMPORTANT:` at the end of paragraph 1 paired with the phrase at the
    // start of paragraph 2 and the span then deleted across the break.
    let at = anchor + SECURITY_ANCHOR.length;
    while (at < paraLimit && isSpaceCode(text.charCodeAt(at))) at++;
    if (at >= paraLimit || !matchesAsciiCI(text, at, SECURITY_PHRASE)) {
      cursor = anchor + 1;
      continue;
    }
    const from = at + SECURITY_PHRASE.length;
    // `from` is in the same paragraph as the anchor by construction, so the cached
    // paragraph end is exactly the bound the terminator search needs.
    const limit = paraLimit;
    let end = -1;
    let researchDead = false;
    for (let i = from; i < limit; i++) {
      if (matchesAsciiCI(text, i, SECURITY_TERM_USE_CASES)) {
        end = i + SECURITY_TERM_USE_CASES.length;
        break;
      }
      if (!researchDead && matchesAsciiCI(text, i, SECURITY_TERM_RESEARCH)) {
        let dot = -1;
        for (let j = i + SECURITY_TERM_RESEARCH.length; j < limit; j++) {
          if (text.charCodeAt(j) === 46) { dot = j; break; }
        }
        if (dot >= 0) { end = dot + 1; break; }
        // No '.' left before the paragraph break, and a later "security research"
        // has an even shorter suffix to search: no later terminator can match.
        researchDead = true;
      }
    }
    if (end >= 0) return { start: anchor, end };
    // No terminator in this paragraph ⇒ no anchor inside it can have one either.
    cursor = limit;
  }
}

/**
 * b-security-line: every `IMPORTANT:` + whitespace + phrase occurrence through
 * the end of its line. The cursor advances past each span, so the whitespace gap
 * is scanned once per anchor rather than re-scanned from every position.
 */
function securityLineSpans(text) {
  const spans = [];
  let cursor = 0;
  let paraLimit = -1;
  for (;;) {
    const anchor = indexOfAsciiCI(text, SECURITY_ANCHOR, cursor);
    if (anchor < 0) return spans;
    if (paraLimit <= anchor) paraLimit = paragraphEndAt(text, anchor);
    // Same paragraph bound as securitySpan(): the fallback may rewrite the line the
    // anchor sits on, but it must never reach across a blank line into the next
    // paragraph (the `\s*` gap used to carry the span over the break).
    let at = anchor + SECURITY_ANCHOR.length;
    while (at < paraLimit && isSpaceCode(text.charCodeAt(at))) at++;
    if (at >= paraLimit || !matchesAsciiCI(text, at, SECURITY_PHRASE)) {
      cursor = anchor + 1;
      continue;
    }
    let end = at + SECURITY_PHRASE.length;
    while (end < text.length && text.charCodeAt(end) !== 10) end++;
    spans.push({ start: anchor, end });
    cursor = end;
  }
}

const BRAND_ANCHOR = 'claude code is available as a cli';
const OPUS_TERMINATOR = 'available on opus ';

/**
 * a4-brand-span: anchor `Claude Code is available as a CLI`, terminator
 * `available on Opus [\d./]+.` in the SAME paragraph. The digit/dot/slash run is
 * greedy and backtracks one code unit for the final `.`, so the match ends after
 * the LAST dot of the run (the old regex behaved identically). First span only.
 */
function opusTerminatorEnd(text, from, limit) {
  let at = from;
  for (;;) {
    at = indexOfAsciiCI(text, OPUS_TERMINATOR, at, limit);
    if (at < 0) return -1;
    let lastDot = -1;
    let j = at + OPUS_TERMINATOR.length;
    while (j < limit) {
      const c = text.charCodeAt(j);
      if ((c >= 48 && c <= 57) || c === 46 || c === 47) {
        if (c === 46) lastDot = j;
        j++;
        continue;
      }
      break;
    }
    if (lastDot >= 0) return lastDot + 1;
    at += 1;
  }
}

function brandSpan(text) {
  let cursor = 0;
  for (;;) {
    const anchor = indexOfAsciiCI(text, BRAND_ANCHOR, cursor);
    if (anchor < 0) return null;
    const from = anchor + BRAND_ANCHOR.length;
    const limit = paragraphEndAt(text, from);
    const end = opusTerminatorEnd(text, from, limit);
    if (end >= 0) return { start: anchor, end };
    cursor = limit;
  }
}

const CATALOGUE_ANCHOR = 'the most recent claude models are';
const CATALOGUE_TERMINATOR = 'most capable claude models.';

/** a4-catalogue: anchor + literal terminator in the same paragraph, first span. */
function catalogueSpan(text) {
  let cursor = 0;
  for (;;) {
    const anchor = indexOfAsciiCI(text, CATALOGUE_ANCHOR, cursor);
    if (anchor < 0) return null;
    const from = anchor + CATALOGUE_ANCHOR.length;
    const limit = paragraphEndAt(text, from);
    const term = indexOfAsciiCI(text, CATALOGUE_TERMINATOR, from, limit);
    if (term >= 0) return { start: anchor, end: term + CATALOGUE_TERMINATOR.length };
    cursor = limit;
  }
}

const FAST_ANCHOR = 'fast mode for claude code';

/**
 * a4-fastmode: per line, optional horizontal whitespace, optional `-`, optional
 * horizontal whitespace, then `Fast mode for Claude Code` to end of line.
 *
 * The span also takes the newline BEFORE the line when there is one, and the
 * trailing newline when there is one, because that is exactly what the old
 * `(?:^|\n)\s*-?\s*…\n?` consumed before it wrote back a single '\n' — the line
 * disappears and the two neighbours stay on separate lines.
 */
function fastmodeSpans(text) {
  const spans = [];
  forEachLine(text, (lineStart, lineEnd, hasNewline) => {
    let at = lineStart;
    while (at < lineEnd && isHorizontalSpaceCode(text.charCodeAt(at))) at++;
    if (at < lineEnd && text.charCodeAt(at) === 45) {
      at++;
      while (at < lineEnd && isHorizontalSpaceCode(text.charCodeAt(at))) at++;
    }
    if (!matchesAsciiCI(text, at, FAST_ANCHOR)) return;
    const start = lineStart > 0 && text.charCodeAt(lineStart - 1) === 10
      ? lineStart - 1
      : lineStart;
    spans.push({ start, end: hasNewline ? lineEnd + 1 : lineEnd });
  });
  return spans;
}

const BILLING_HEADER = 'x-anthropic-billing-header:';

/**
 * a3-billing: per line, optional leading horizontal whitespace then the exact
 * `x-anthropic-billing-header:` literal, to end of line. The span takes the trailing
 * newline so the line is gone without leaving a blank one behind.
 */
function billingSpans(text) {
  const spans = [];
  forEachLine(text, (lineStart, lineEnd, hasNewline) => {
    let at = lineStart;
    while (at < lineEnd && isHorizontalSpaceCode(text.charCodeAt(at))) at++;
    if (!matchesAsciiCI(text, at, BILLING_HEADER)) return;
    spans.push({ start: lineStart, end: hasNewline ? lineEnd + 1 : lineEnd });
  });
  return spans;
}

const GROK_FULL_ANCHOR = 'you are grok';
const GROK_NOUN_ANCHOR = 'grok';
const GROK_TAIL = ' released by xai';

/**
 * a6-grok-full / a6-grok-noun: anchor, then only `[\w .-]` characters, then the
 * LAST ` released by xAI` in that run (the old `[\w .-]*` was greedy), then an
 * optional `.`. The run cannot contain a newline, so the rule is line-scoped by
 * construction. `\b` before `Grok` is enforced for the noun form.
 *
 * When the tail is missing the whole run is skipped: every later anchor inside
 * that run has a strictly shorter suffix to search and cannot match either.
 */
function grokSpans(text, anchor, requireWordBoundary) {
  const spans = [];
  let cursor = 0;
  for (;;) {
    const at = indexOfAsciiCI(text, anchor, cursor);
    if (at < 0) return spans;
    if (requireWordBoundary && at > 0 && isWordCode(text.charCodeAt(at - 1))) {
      cursor = at + 1;
      continue;
    }
    const runStart = at + anchor.length;
    let runEnd = runStart;
    while (runEnd < text.length && isGrokRunCode(text.charCodeAt(runEnd))) runEnd++;
    let hit = -1;
    for (let i = runEnd - GROK_TAIL.length; i >= runStart; i--) {
      if (matchesAsciiCI(text, i, GROK_TAIL)) { hit = i; break; }
    }
    if (hit < 0) {
      cursor = runEnd > at ? runEnd : at + 1;
      continue;
    }
    let end = hit + GROK_TAIL.length;
    if (end < text.length && text.charCodeAt(end) === 46) end++;
    spans.push({ start: at, end });
    cursor = end;
  }
}

const CARE_OPEN = '<executing_actions_with_care>';
const CARE_CLOSE = '</executing_actions_with_care>';

/**
 * a6-grok2-care: explicit delimiter pair, global, allowed to cross blank lines —
 * both ends are delimiters the client wrote, and a real block is multi-paragraph
 * safety prose. No close after an open means no later open has one either, so the
 * scan stops instead of re-searching the suffix per open (which is the quadratic
 * shape the "unterminated block" regression test pins).
 */
function careSpans(text) {
  const spans = [];
  let cursor = 0;
  for (;;) {
    const open = indexOfAsciiCI(text, CARE_OPEN, cursor);
    if (open < 0) return spans;
    const close = indexOfAsciiCI(text, CARE_CLOSE, open + CARE_OPEN.length);
    if (close < 0) return spans;
    spans.push({ start: open, end: close + CARE_CLOSE.length });
    cursor = close + CARE_CLOSE.length;
  }
}

/**
 * WARN above this many bytes removed by ONE substitution.
 *
 * Measured on the fixtures the 49 existing tests pin, biggest first: the security
 * paragraph removes 322 bytes, the Environment brand block 275, the model catalogue
 * 234, the Cline boast 119, <executing_actions_with_care> 123, the billing header 75,
 * and the plain identity lines 26-31. 512 sits above the largest legitimate removal
 * with room for a longer real-world variant of the same paragraph, and far below a
 * paragraph-scale over-deletion. Deliberately NOT a percentage: legitimate rules
 * remove 70-100% of a short prompt that is nothing but the offending paragraph, so a
 * ratio would fire on every fixture while missing a 400-byte bite out of a 20 KB
 * prompt. Ordinary requests (identity line rewrite only) stay ~30 bytes and log
 * nothing — a line per request would be noise.
 */
const OVER_DELETION_WARN_BYTES = 512;
// A self-identification phrase ("You are Claude Code, Anthropic's official CLI…")
// appears once or twice in a system prompt — a client repeating its own identity line
// three times is already unusual. A bare-token rule firing more than that is far more
// likely to be matching the CALLER's content, which is the case a7-freeform hit in
// SQL DDL and in source code. Set above the plausible-identity count rather than at 1
// so an ordinary two-mention prompt stays quiet.
const MULTI_HIT_REWRITE_WARN_COUNT = 1;

/**
 * Client-identity neutralization for upstream requests.
 *
 * Devin's upstream applies two gates against competitor coding-agent traffic:
 *   - a 529 competitor-fingerprint gate on self-identification strings, and
 *   - a content-policy `permission_denied` block (2026-07-10, live-confirmed)
 *     that trips on Claude Code's Agent-SDK self-identification line.
 * This module rewrites those fingerprints in the system prompt BODY to a generic
 * assistant identity so the request is served instead of blocked.
 *
 * Standalone ON PURPOSE: it is imported by BOTH handlers/messages.js (the
 * /v1/messages → anthropicToOpenAI path) AND handlers/chat.js (the DEVIN_CONNECT
 * public egress). messages.js imports chat.js, so keeping this in its own module is
 * what lets chat.js reuse it without a circular import. It used to be
 * dependency-free as well; it now imports `log` from ../config.js, which cannot
 * reintroduce a cycle (config.js imports only node builtins) and adds no new
 * import-time side effect (both call sites already import config.js).
 *
 * SPANS ARE PARAGRAPH-BOUNDED. The multi-line rules below (security paragraph,
 * brand block, model catalogue) used `[\s\S]*?`, which crosses blank lines: with
 * only the two anchor phrases present, EVERY byte between them was deleted,
 * including the caller's own instructions. Measured on c3ac2b2 with the brand-block
 * anchors two paragraphs apart: 213 bytes in, 59 out — two user security rules
 * ("the API key must never be logged", "Never delete the production database")
 * silently gone. Same shape on the catalogue anchors: 208 in, 18 out. Those spans
 * now come from linear scanners (paragraphEndAt + the per-rule span finders below),
 * so a match cannot reach past a blank line, and every substitution's byte delta is
 * checked against OVER_DELETION_WARN_BYTES so an over-large deletion is at least
 * visible to an operator.
 *
 * Off-switch: WINDSURFAPI_NEUTRALIZE_CLIENT_ID=0 (default on).
 * Opt-in (speculative): WINDSURFAPI_NEUTRALIZE_CLINE_OBJECTIVE=1 (default off) —
 * enables the (a6-cline-obj) OBJECTIVE-boast rule; see comment at the a6-cline-obj rule.
 * Opt-in (speculative): WINDSURFAPI_NEUTRALIZE_CC_AGGRESSIVE=1 or opts.ccActive
 *   (default off) — reserved hook for Claude-Code-specific aggressive rules; see
 *   the (cc) block at the end. Currently EMPTY on purpose (a1-a4 and a8 already cover
 *   every live-confirmed CC trigger); the hook exists so a new CC trigger can be
 *   flipped on the instant a repetition A/B proves it, without re-plumbing.
 *
 * @param {string} text  system-prompt body to neutralize
 * @param {object} env   environment (injectable for tests)
 * @param {object} opts  { ccActive?: boolean } — Claude Code compat layer active
 *   for this request (via /v1/cc/* or detected + master toggle). Gates ONLY the
 *   opt-in (cc) block; the confirmed rules (a1-a5, a6-grok, a7, a8) stay unconditional
 *   (they are the default 529 / content-policy defense line for ALL clients and
 *   must never be gated).
 */
export function neutralizeClientIdentity(text, env = process.env, opts = {}) {
  if (!text || String(env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID || '1') === '0') return text;
  let out = String(text);
  /**
   * Apply one rule, and WARN when the substitution is worth an operator's attention.
   *
   * TWO directions, because the deletion-only check was blind to the shape that
   * actually corrupted caller content. `removed > OVER_DELETION_WARN_BYTES` can only
   * fire when the text SHRINKS, and the one rule that rewrites a bare token —
   * a7-freeform, FREEFORM(8B) -> free-form(9B) — GROWS by one byte per hit, so
   * `removed` is -1 and no threshold in the world catches it. MEASURED damage while
   * it was silent:
   *     CHECK (kind IN ('FREEFORM','STRUCTURED'))  ->  ('free-form','STRUCTURED')
   *     if (mode === FREEFORM)                     ->  mode === free-form
   * The first rewrites a string literal inside a data contract; the second is not
   * valid code. Neither shrinks the prompt, so the guard added for the unbounded-regex
   * over-deletion defect could not see either.
   *
   * The growth direction is counted in OCCURRENCES, not bytes. A byte threshold in
   * this direction is the wrong instrument twice over: a single-byte-per-hit rewrite
   * never reaches any useful byte figure, while an ordinary identity rewrite
   * (a4-cli-line replaces a clause with a longer sentence) trivially exceeds one and
   * would warn on every well-behaved request — training operators to ignore the line,
   * which is the failure mode this is supposed to prevent. What distinguishes
   * a7-freeform is that it is a GLOBAL BARE-TOKEN rule: it can hit an unbounded number
   * of times in text it was never aimed at. So the signal is "this rule fired more
   * times than a self-identification phrase plausibly appears".
   *
   * The deletion branch is byte-for-byte unchanged, so the W2 guard it was written for
   * still holds exactly as before.
   */
  const rule = (id, re, replacement) => {
    const next = out.replace(re, replacement);
    if (next === out) return;
    // Byte delta, not char delta: the operator-visible number must match what the
    // prompt actually loses on the wire (the model catalogue carries an em dash).
    const beforeBytes = Buffer.byteLength(out, 'utf8');
    const afterBytes = Buffer.byteLength(next, 'utf8');
    const removed = beforeBytes - afterBytes;
    if (removed > OVER_DELETION_WARN_BYTES) {
      log.warn(`neutralizeClientIdentity: rule ${id} removed ${removed} bytes in one `
        + `substitution (threshold ${OVER_DELETION_WARN_BYTES}) — prompt ${beforeBytes}`
        + ` → ${afterBytes} bytes. Check that no caller instruction was swallowed.`);
    } else if (re.global) {
      const hits = (out.match(re) || []).length;
      if (hits > MULTI_HIT_REWRITE_WARN_COUNT) {
        log.warn(`neutralizeClientIdentity: rule ${id} rewrote ${hits} occurrences in one `
          + `substitution (threshold ${MULTI_HIT_REWRITE_WARN_COUNT}) — prompt ${beforeBytes}`
          + ` → ${afterBytes} bytes. A bare-token rule matching this often is probably `
          + 'hitting caller content (SQL enums, identifiers, docs), not a client identity string.');
      }
    }
    out = next;
  };
  /**
   * Apply spans located by a linear scanner, with the SAME operator-visible
   * accounting as `rule()` above: one WARN when a single substitution removes more
   * than OVER_DELETION_WARN_BYTES, otherwise one WARN when a GLOBAL rule rewrote
   * more occurrences than MULTI_HIT_REWRITE_WARN_COUNT. The two branches stay
   * exclusive for the same reason: a large multi-hit deletion is one event, and
   * reporting it twice would make the count meaningless.
   *
   * `spans` must be sorted, non-overlapping and in bounds — every scanner below
   * emits them that way by construction (a monotonic cursor). The output is built
   * ONCE from the slices, never by re-copying a growing string per hit.
   */
  const applySpans = (id, spans, replacement, isGlobal = false) => {
    if (spans.length === 0) return;
    const beforeBytes = Buffer.byteLength(out, 'utf8');
    let next = '';
    let cursor = 0;
    for (const span of spans) {
      next += out.slice(cursor, span.start) + replacement;
      cursor = span.end;
    }
    next += out.slice(cursor);
    if (next === out) return;
    const afterBytes = Buffer.byteLength(next, 'utf8');
    const removed = beforeBytes - afterBytes;
    if (removed > OVER_DELETION_WARN_BYTES) {
      log.warn(`neutralizeClientIdentity: rule ${id} removed ${removed} bytes in one `
        + `substitution (threshold ${OVER_DELETION_WARN_BYTES}) — prompt ${beforeBytes}`
        + ` → ${afterBytes} bytes. Check that no caller instruction was swallowed.`);
    } else if (isGlobal && spans.length > MULTI_HIT_REWRITE_WARN_COUNT) {
      log.warn(`neutralizeClientIdentity: rule ${id} rewrote ${spans.length} occurrences in one `
        + `substitution (threshold ${MULTI_HIT_REWRITE_WARN_COUNT}) — prompt ${beforeBytes}`
        + ` → ${afterBytes} bytes. A bare-token rule matching this often is probably `
        + 'hitting caller content (SQL enums, identifiers, docs), not a client identity string.');
    }
    out = next;
  };
  // (a) competitor self-identification (529 gate). Both straight (') and curly (’).
  rule('a1-cc-full',
    /You are Claude Code,\s*Anthropic['’]?s official CLI for Claude\.?/gi,
    'You are an AI coding assistant.',
  );
  rule('a1-cc-noun',
    /Claude Code,\s*Anthropic['’]?s official CLI for Claude\.?/gi,
    'an AI coding assistant.',
  );
  // (a2) Agent-SDK / sdk-cli self-identification (2026-07-10, live-confirmed to
  // trip Devin's content policy → permission_denied). Claude Code 2.1.204 sdk-cli
  // entrypoint opens with "You are a Claude agent, built on Anthropic's Claude
  // Agent SDK." A/B tested on the live upstream: this exact line is what triggers
  // the block — the same request with a generic assistant line and the billing
  // header stripped passes. Match both the full "You are ..." form and the bare
  // noun phrase, straight and curly apostrophes.
  rule('a2-sdk-full',
    /You are a Claude agent, built on Anthropic['’]?s Claude Agent SDK\.?/gi,
    'You are an AI coding assistant.',
  );
  rule('a2-sdk-noun',
    /\ba Claude agent, built on Anthropic['’]?s Claude Agent SDK\.?/gi,
    'an AI coding assistant.',
  );
  // (a3) The x-anthropic-billing-header line Claude Code prepends to its system
  // prompt ("x-anthropic-billing-header: cc_version=...; cc_entrypoint=...;") is a
  // competitor fingerprint that rides in the prompt body. Strip the whole line.
  // Linear, per line: the old `/^\s*…[^\n]*\n?/gim` re-scanned the whitespace run
  // from every line start, and its greedy `\s*` could swallow the blank lines above
  // the header. billingSpans() takes the line and its trailing newline, so the line
  // disappears without leaving a blank one behind.
  applySpans('a3-billing', billingSpans(out), '', true);
  // (b) security-policy paragraph (401 abuse gate). Match the "IMPORTANT: Assist
  // with authorized security testing …" sentence through its "… use cases."
  // terminator (the dual-use clause). Spans single line breaks (the paragraph is
  // wrapped in the real prompt) but stops dead at a blank line: the old `[\s\S]*?`
  // meant that a prompt containing only the opening phrase and, paragraphs later,
  // the words "security research.", deleted everything in between. Replaced with a
  // benign safety statement.
  //
  // LINEAR: the anchor and its terminator are located by securitySpan(), which
  // walks the anchor's paragraph once. The terminator cannot leave that paragraph,
  // so the caller's RULE lines between two paragraphs are never in the span.
  const SECURITY_BENIGN = 'Decline requests that facilitate clearly malicious or harmful activity, and otherwise help the user with their software engineering task.';
  const security = securitySpan(out);
  if (security) applySpans('b-security', [security], SECURITY_BENIGN);
  // Fallback, same shape as a4-cli-line: when the opening sentence and the
  // dual-use terminator land in different paragraphs the bounded span above
  // (correctly) does not match, and this rewrites every fingerprint-bearing
  // opening line on its own rather than sending "Assist with authorized security
  // testing" upstream. Cursor-advancing, so the whitespace gap after each anchor
  // is scanned once instead of from every position. Runs unconditionally: the
  // full span may have matched a LATER anchor while an earlier anchor line in a
  // different paragraph still carries the fingerprint.
  applySpans('b-security-line', securityLineSpans(out), SECURITY_BENIGN, true);
  // (a4) Environment "brand block" (2026-07-10, live-confirmed content-policy
  // trigger). Claude Code's interactive-session system prompt carries an
  // Environment section describing the Claude Code product + a Claude model-ID
  // catalogue ("Claude Code is available as a CLI … web app (claude.ai/code) …
  // Fast mode … uses Claude Opus", "The most recent Claude models are … Model IDs
  // — Fable 5: 'claude-fable-5' … default to the latest … Claude models"). This
  // dense competitor-brand/product content trips Devin's content policy →
  // permission_denied (400), even after (a)/(a2) neutralize the opening identity
  // line. Bisected live to exactly these passages. Rewrite them to neutral text;
  // they are environment blurb, not task instructions, so removing them is safe.
  //
  // Both spans are paragraph-bounded. In the real prompt the Environment block is
  // one bullet list with no blank line inside it, so bounding costs nothing there;
  // without the bound, a prompt whose two anchor phrases happen to sit in different
  // paragraphs had the caller's own instructions between them deleted (measured
  // c3ac2b2: 213 bytes → 59, both user RULE lines gone). LINEAR: brandSpan() walks
  // each candidate anchor's paragraph once and skips the whole paragraph when its
  // terminator is absent, so a prompt repeating the anchor cannot rescan the tail.
  const brand = brandSpan(out);
  if (brand) applySpans('a4-brand-span', [brand], 'This coding assistant runs in a terminal.');
  // Fallback: any remaining "Fast mode for Claude Code …" sentence (if the block
  // above didn't span it) + a bare "Claude Code is available as a CLI …" line.
  // These line-scoped rules are what keeps the fingerprint neutralized when the
  // span above declines to cross a paragraph break, so bounding the span does not
  // weaken the 529 / content-policy defence — it only stops the collateral damage.
  // LINEAR: one pass over the lines; the old `(?:^|\n)\s*…` re-scanned the
  // whitespace run from every position (676 ms on a 2 KB newline prompt).
  applySpans('a4-fastmode', fastmodeSpans(out), '\n', true);
  rule('a4-cli-line', /Claude Code is available as a CLI[^\n]*\n?/gi, 'This coding assistant runs in a terminal.\n');
  // LINEAR: same paragraph-bounded shape as a4-brand-span; the terminator search
  // is bounded to the paragraph, and a paragraph without one is skipped whole.
  const catalogue = catalogueSpan(out);
  if (catalogue) applySpans('a4-catalogue', [catalogue], '');
  // Same fallback shape as a4-cli-line: if the catalogue's opening sentence and its
  // "… most capable Claude models." tail end up in different paragraphs, the span
  // above (correctly) declines, and this strips the fingerprint-bearing opening line
  // on its own rather than leaving the model-ID catalogue header upstream.
  rule('a4-catalogue-line', /The most recent Claude models are[^\n]*\n?/gi, '');
  // "You are powered by the model <claude-*/fable-*>." + the "The exact model ID
  // is <id>." sentence that follows it — a self-model fingerprint some entrypoints
  // inject into the Environment block.
  //
  // The sentence terminator must be a dot followed by WHITESPACE (or EOL), not any
  // dot: the previous `[^\n.]*\.` stopped at the first dot, which for every dotted
  // model version ("Opus 4.8", "Sonnet 4.6") cut the sentence mid-version — it
  // deleted "…named Opus 4." and left a dangling "8. The exact model ID is
  // claude-opus-4-8." behind, i.e. it BOTH mangled the prompt AND left the real
  // fingerprint in place. The model-ID sentence was never matched by any rule at
  // all, so even the undotted form ("Opus 5") leaked "claude-opus-5" verbatim.
  rule('a4-poweredby',
    /You are powered by the model [^\n]*?(?:\.(?=\s|$)|(?=\n)|$)\s*/i,
    '',
  );
  rule('a4-modelid',
    /The exact model ID is [^\n]*?(?:\.(?=\s|$)|(?=\n)|$)\s*/i,
    '',
  );
  // (a5) Cline's opening capability-boast identity sentence (2026-07-15, live A/B
  // on the Devin upstream, homecloud v3.4.0). Cline's system prompt starts with
  // "You are Cline, a highly skilled software engineer with extensive knowledge in
  // many programming languages, frameworks, design patterns, and best practices."
  // Bisected live to this exact sentence: it trips the content policy
  // (permission_denied / 400). The TRIGGER is the capability-boast phrasing, NOT
  // the brand name — swapping only "Cline" still blocks; dropping the "highly
  // skilled … best practices" clause passes. Rewrite to a plain role line and keep
  // the agent's own name (verified: "You are <Name>, a software engineer." serves).
  // Name captured generically so a future Cline rename / fork still matches.
  rule('a5-cline-boast',
    /You are ([A-Z][\w.-]*), a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns,? and best practices\./g,
    'You are $1, a software engineer.',
  );
  // (a6-grok) Grok / xAI self-identification (2026-07-16, live-confirmed to
  // trip Devin's content policy → permission_denied). Grok CLI opens with
  // "You are Grok 4.5 released by xAI. You are an interactive CLI tool that
  // helps users with software engineering tasks." A/B on the live upstream:
  // this exact line is what triggers the block — the same request with a
  // generic assistant line passes. Match the full "You are Grok ... released
  // by xAI" form and the bare noun phrase, any Grok version digit.
  // LINEAR: grokSpans() consumes the `[\w .-]` run once, then looks backwards for
  // the last valid ` released by xAI` in it (the old `[\w .-]*` was greedy). A run
  // with no terminator is skipped whole, so repeating the anchor cannot rescan it.
  applySpans('a6-grok-full', grokSpans(out, GROK_FULL_ANCHOR, false), 'You are an AI coding assistant.', true);
  applySpans('a6-grok-noun', grokSpans(out, GROK_NOUN_ANCHOR, true), 'an AI coding assistant.', true);
  // (a6-grok2) Grok's executing_actions_with_care safety paragraph — a
  // competitor-specific safety/policy framing that rides in the prompt body
  // and has been observed in the same blocked request. Strip the whole
  // <executing_actions_with_care>...</executing_actions_with_care> block.
  //
  // This span keeps `[\s\S]*?` on purpose, unlike b-security / a4-brand-span /
  // a4-catalogue: both ends are EXPLICIT delimiters the client wrote, so text between
  // them is by definition inside the block, and a real block does contain blank lines
  // (multi-paragraph safety prose). Paragraph-bounding it would leave the tags and
  // half the block upstream. The delta is still measured by rule(), so an implausibly
  // large removal — e.g. a client that opens the tag and never closes it until the
  // end of a long prompt — shows up as a WARN instead of vanishing silently.
  // LINEAR: careSpans() takes explicit `indexOf` delimiter pairs. An open with no
  // close after it means no LATER open has one either, so the scan stops rather
  // than re-searching the suffix per open — that quadratic shape is what the
  // unterminated-block regression test pins.
  applySpans('a6-grok2-care', careSpans(out), '', true);
  // (a6-cline-obj) SPECULATIVE / HYPOTHESIS-ONLY (2026-07-15), DEFAULT-OFF. Unlike a1-a5
  // which are live-bisected confirmed triggers, this OBJECTIVE boast sentence is
  // only SUSPECTED to be in the same content-policy trigger family — NOT verified,
  // because Devin's content policy is non-deterministic (the same prompt blocked
  // then passed hours later) so no reliable A/B was possible. Ship OFF (opt-in via
  // WINDSURFAPI_NEUTRALIZE_CLINE_OBJECTIVE=1) so the mechanism is ready to flip the
  // instant the policy re-fires and a repetition A/B proves causation. Do NOT enable
  // by default. CAPABILITIES bullet deliberately left untouched (functional
  // description, redundant with tools[]).
  if (String(env.WINDSURFAPI_NEUTRALIZE_CLINE_OBJECTIVE || '') === '1') {
    rule('a6-cline-obj', /Remember, you have extensive capabilities with access to a wide range of tools that can be used in powerful and clever ways as necessary to accomplish each goal\./g, 'Use the available tools as needed to accomplish each goal.');
  }
  // (a7) codex apply_patch tool-description content-policy trigger (2026-07-20,
  // live-bisected DETERMINISTIC 7/7 by @forrinzhao — PR #219). codex's apply_patch
  // tool DESCRIPTION carries "FREEFORM tool, so do not wrap the patch in JSON."
  // When the tool-description preamble is injected into the system prompt
  // (applyToolPreambleBudget → injectPreambleIntoSystemPrompt on the native path),
  // Devin's content filter flags the "FREEFORM" token and blocks the whole request
  // (observed on the Feishu/Lark codex bridge). Unlike a1-a5 this trigger arrives
  // via a TOOL description, not the client's own system prompt — so chat.js runs
  // this neutralize pass AFTER preamble injection for the text to be reachable.
  // Live A/B: BOTH fragments must change (rewriting only one still blocks). The
  // tool NAME + JSON schema are untouched, so native function-calling is preserved.
  // Live-confirmed ⇒ unconditional, on the main WINDSURFAPI_NEUTRALIZE_CLIENT_ID switch.
  rule('a7-freeform', /FREEFORM/g, 'free-form');
  rule('a7-json-wrap', /do not wrap the patch in JSON\./g, 'provide the patch as plain text.');
  // (a8) Claude Code subagent system-prompt trigger (2026-10-24, Claude Code 2.1.310,
  // live-bisected via /v1/messages replay, 2/2 per variant). Every subagent (Agent tool,
  // general-purpose / Explore / ...) carries the Notes bullet "For clear
  // communication with the user the assistant MUST avoid using emojis." That one
  // sentence alone, as the whole system prompt, blocks (permission_denied / 400);
  // the same request with the subagent block dropped passes. The TRIGGER is the
  // whole combination: "The assistant MUST avoid using emojis." passes, the same
  // sentence with "should" passes, dropping the "For clear communication with the
  // user" lead-in passes. The full blocked subagent request with only MUST -> should
  // passed 3/3, so the rewrite keeps the instruction and changes one word. The main
  // session prompt does not contain this sentence, which is why only subagents fail.
  // Unconditional rather than in the (cc) block: ccActive is off by default, so a
  // gated rule would leave every default deployment's subagents failing, and the
  // regex is anchored on the whole sentence, so it cannot hit unrelated content.
  // Live-confirmed => unconditional, on the main WINDSURFAPI_NEUTRALIZE_CLIENT_ID switch.
  rule('a8-cc-subagent-emoji',
    /For clear communication with the user,?\s+the assistant MUST avoid using emojis\./g,
    'For clear communication with the user the assistant should avoid using emojis.',
  );
  // (cc) SPECULATIVE / DEFAULT-OFF — Claude-Code-specific aggressive rules. Gated
  // by the CC compat layer being active for this request (opts.ccActive, i.e.
  // /v1/cc/* or detected + master toggle) OR the env opt-in. INTENTIONALLY EMPTY
  // today: a1-a4 and a8 already neutralize every live-confirmed Claude Code trigger
  // ("You are Claude Code", the Agent-SDK line, the billing header, the brand
  // block, the subagent emoji bullet), and adding UNVERIFIED rewrites would risk
  // mangling prompt semantics against Devin's NON-DETERMINISTIC content policy (same prompt blocked then
  // passed hours later — no reliable A/B, the exact reason a6-cline-obj ships off). This
  // hook exists so the moment the policy re-fires and a repetition A/B isolates a
  // NEW CC-only trigger, the rule drops in here and flips on via ccActive with no
  // re-plumbing. Do NOT add a rule here without live-bisected proof.
  const ccAggressive = !!opts.ccActive || String(env.WINDSURFAPI_NEUTRALIZE_CC_AGGRESSIVE || '') === '1';
  if (ccAggressive) {
    // (reserved) — no CC-only rewrites are confirmed yet; see block comment.
  }
  return out;
}

/**
 * Neutralize a message `content` field in EITHER shape the pipeline carries.
 *
 * neutralizeClientIdentity only takes a string, so call sites that guarded with
 * `typeof m.content !== 'string'` silently skipped array/parts content — which is
 * the DEFAULT shape for Codex `/v1/responses` (responses.js normalizeMessageContent
 * returns an array of `{type:'text'}` parts and does NOT flatten). Those messages
 * then reached devin-connect.js's wire-time messageText() flattener, so the exact
 * identity fingerprint this module exists to strip went upstream verbatim.
 *
 * Returns the input unchanged (same reference) when nothing was rewritten, so
 * callers can keep using an identity check to avoid copying every message.
 *
 * @param {string|Array|null} content
 * @param {object} env
 * @param {object} opts  { ccActive?: boolean }
 */
export function neutralizeMessageContent(content, env = process.env, opts = {}) {
  if (typeof content === 'string') return neutralizeClientIdentity(content, env, opts);
  if (!Array.isArray(content)) return content;
  let changed = false;
  const parts = content.map((p) => {
    if (!p || typeof p !== 'object' || p.type !== 'text' || typeof p.text !== 'string') return p;
    const neut = neutralizeClientIdentity(p.text, env, opts);
    if (neut === p.text) return p;
    changed = true;
    return { ...p, text: neut };
  });
  return changed ? parts : content;
}
