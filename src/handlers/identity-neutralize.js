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

/**
 * First index at or after `from` where `needle` occurs, case-SENSITIVELY. Same
 * `limit` contract as indexOfAsciiCI: it bounds where the needle may END (exclusive),
 * so a line scan cannot leak into the next line. a7-freeform needs this — the rule it
 * replaces was `/FREEFORM/g`, and the provenance clause does not license rewriting a
 * lowercase `freeform` that the caller wrote.
 */
function indexOfExact(text, needle, from, limit = text.length) {
  const last = Math.min(text.length, limit) - needle.length;
  for (let i = from > 0 ? from : 0; i <= last; i++) {
    if (text.startsWith(needle, i)) return i;
  }
  return -1;
}

// `\s` in the regexes this module replaces: space, tab, CR, LF, FF, VT and the
// Unicode spaces. The ASCII fast path matters because the anchor gap is scanned
// for every candidate anchor.
const isSpaceCode = (code) => code === 32 || (code >= 9 && code <= 13)
  || (code > 127 && /\s/.test(String.fromCharCode(code)));

// "Horizontal" whitespace for the line-scoped rules: every `\s` code unit a
// line can contain at its start — space, tab, VT, FF, CR and the Unicode space
// separators — EXCEPT LF, which cannot appear inside a line anyway
// (forEachLine splits on it). The `[space,tab]`-only class let NBSP/FF/VT/CR-
// indented fingerprint lines survive that the `\s*` these rules replaced used
// to eat. Written as explicit ranges so the indent skip stays allocation-free:
// isSpaceCode's `/\s/` test allocates a string per non-ASCII code unit.
const isHorizontalSpaceCode = (code) => code === 32 || (code >= 9 && code <= 13 && code !== 10)
  || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a)
  || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f
  || code === 0x3000 || code === 0xfeff;

// `\w` without the `u` flag is ASCII-only: [A-Za-z0-9_].
const isWordCode = (code) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90)
  || (code >= 97 && code <= 122) || code === 95;

// The a6-grok run class: [\w .-].
const isGrokRunCode = (code) => isWordCode(code) || code === 32 || code === 46 || code === 45;

/**
 * Index of the newline that OPENS a paragraph break at or after `from`, or
 * `text.length` when the paragraph runs to the end of the string.
 *
 * A blank line is a line whose only characters are whitespace OTHER than the
 * newline itself — spaces, tabs, CR, FF, VT and the Unicode spaces, the same class
 * the old `\s` matched. That matters: a blank line made of NBSP or U+3000 is a
 * paragraph break in the regex this module replaces, and treating it as content
 * let the span cross it and delete the caller's instructions (H1). A single
 * newline is NOT a break: the Environment block and the security paragraph wrap
 * across lines, so a scan that stopped at every newline would leave most of the
 * fingerprint upstream (a silent regression of the 529 / content-policy defence,
 * which is worse than the over-deletion this bound exists to stop).
 */
function paragraphEndAt(text, from) {
  for (let i = from; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue;
    let j = i + 1;
    while (j < text.length) {
      const c = text.charCodeAt(j);
      if (c !== 10 && isSpaceCode(c)) { j++; continue; }
      break;
    }
    if (j >= text.length || text.charCodeAt(j) === 10) return i;
  }
  return text.length;
}

/**
 * Visit every line once, left to right: (lineStart, lineEnd, hasNewline,
 * nextStart). Lines break on every JavaScript line terminator — \n, \r,
 * U+2028, U+2029 — the same set the `/^…/m` regexes this module replaced
 * anchored at. A `\r\n` pair is ONE break; `nextStart` is the first index of
 * the following line (past the whole terminator), which is what a span that
 * means "delete the line WITH its newline" must consume.
 */
function forEachLine(text, visit) {
  let lineStart = 0;
  for (;;) {
    let lineEnd = -1;
    for (let i = lineStart; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) { lineEnd = i; break; }
    }
    const hasNewline = lineEnd >= 0;
    if (!hasNewline) lineEnd = text.length;
    let nextStart = text.length;
    if (hasNewline) {
      nextStart = lineEnd + 1;
      if (text.charCodeAt(lineEnd) === 13
        && nextStart < text.length && text.charCodeAt(nextStart) === 10) nextStart++;
    }
    visit(lineStart, lineEnd, hasNewline, nextStart);
    if (!hasNewline) return;
    lineStart = nextStart;
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
  for (;;) {
    const anchor = indexOfAsciiCI(text, SECURITY_ANCHOR, cursor);
    if (anchor < 0) return null;
    // The gap is required to be ALL whitespace — that requirement, not the
    // paragraph bound, is what keeps WA-002: an `IMPORTANT:` whose own
    // paragraph continues with text still cannot pair. But an anchor that is
    // alone before the break (`IMPORTANT:` + blank line(s) + phrase — the
    // shape the live preamble emits) must still reach the phrase the way the
    // old `\s*` did; refusing the cross let the whole sentence leak upstream.
    let at = anchor + SECURITY_ANCHOR.length;
    while (at < text.length && isSpaceCode(text.charCodeAt(at))) at++;
    if (at >= text.length || !matchesAsciiCI(text, at, SECURITY_PHRASE)) {
      cursor = anchor + 1;
      continue;
    }
    const from = at + SECURITY_PHRASE.length;
    // The terminator belongs to the notice itself, so the bound is the
    // paragraph the PHRASE sits in — the whitespace gap may have crossed into
    // it from the anchor's paragraph.
    const limit = paragraphEndAt(text, from);
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
  for (;;) {
    const anchor = indexOfAsciiCI(text, SECURITY_ANCHOR, cursor);
    if (anchor < 0) return spans;
    // Same all-whitespace gap rule as securitySpan(): the anchor's paragraph may
    // continue only with whitespace before the phrase, which is what lets an
    // `IMPORTANT:` that is alone before a blank line still pair — while an
    // anchor followed by real text never reaches across the break.
    let at = anchor + SECURITY_ANCHOR.length;
    while (at < text.length && isSpaceCode(text.charCodeAt(at))) at++;
    if (at >= text.length || !matchesAsciiCI(text, at, SECURITY_PHRASE)) {
      cursor = anchor + 1;
      continue;
    }
    let end = at + SECURITY_PHRASE.length;
    // "To end of its line" — same terminator set forEachLine splits on: the
    // whitespace gap may have carried the match across a \r / U+2028 / U+2029
    // boundary, so the run must stop at the first terminator of ANY kind or a
    // \r-terminated shape would swallow the next line too.
    while (end < text.length) {
      const c = text.charCodeAt(end);
      if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) break;
      end++;
    }
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
    const runStart = at + OPUS_TERMINATOR.length;
    let lastDot = -1;
    let j = runStart;
    while (j < limit) {
      const c = text.charCodeAt(j);
      if ((c >= 48 && c <= 57) || c === 46 || c === 47) {
        if (c === 46) lastDot = j;
        j++;
        continue;
      }
      break;
    }
    // Parity with `Opus [\d./]+\.`: the final dot needs at least one [\d./]
    // character before it, so a run whose only dot leads (`Opus .5x`) is no match.
    if (lastDot > runStart) return lastDot + 1;
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

const CATALOGUE_LINE_ANCHOR = 'the most recent claude models are';
const CATALOGUE_LINE_REPLACEMENT = 'The available models are';
const CATALOGUE_ID_PREFIX = 'claude-';
const CATALOGUE_ID_WORDS = ['opus', 'sonnet', 'haiku', 'fable'];
// Words allowed as `-`-separated components AFTER the head. The family words
// repeat because version-first IDs place them later (`claude-5-fable-medium`,
// `claude-3-5-sonnet`); the rest are the effort/size modifiers and the
// fast/thinking/beta suffixes real selectors carry. The set is CLOSED — it was
// checked against every claude-* selector and alias in
// src/data/devin-catalog-snapshot.json — so `-svc`, `-proxy`, `-internal` and
// `-lives` are caller words, not ID components.
const CATALOGUE_ID_COMPONENT_WORDS = [
  'opus', 'sonnet', 'haiku', 'fable',
  'max', 'min', 'high', 'medium', 'low', 'xhigh',
  'fast', 'thinking', 'beta',
];

const isAsciiDigit = (code) => code >= 48 && code <= 57;
const isAsciiLetter = (code) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

/**
 * End of the digit component starting at `at`: a digit run with optional
 * `.`-joined digit groups (version dots — `claude-opus-4.8`,
 * `claude-sonnet-4.6`) and an optional `m`/`M` context suffix (`-1m`). Returns
 * -1 when a letter or `_` is glued to the run (`claude-3d`, `claude-5.5x`,
 * `claude-1mx`): the token continues past what a catalogue component can be.
 */
function catalogueDigitComponentEnd(text, at, lineEnd) {
  let j = at;
  for (;;) {
    while (j < lineEnd && isAsciiDigit(text.charCodeAt(j))) j++;
    // `.` continues the version only before another digit (`4.8`, not `4.x`)
    if (j + 1 < lineEnd && text.charCodeAt(j) === 46 && isAsciiDigit(text.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    break;
  }
  if (j >= lineEnd) return j;
  const c = text.charCodeAt(j);
  // `m` context suffix (`-1m`): only when `m` itself is not glued to more word
  // characters — `1mx` stays prose.
  if (c === 109 || c === 77) {
    const after = j + 1;
    if (after >= lineEnd) return after;
    const n = text.charCodeAt(after);
    if (isAsciiLetter(n) || isAsciiDigit(n) || n === 95) return -1;
    return after;
  }
  if (isAsciiLetter(c) || c === 95) return -1;
  return j;
}

/**
 * End of the word component starting at `at`: one of `words` (ASCII-CI) that is
 * NOT glued to more word characters — `-maxi` is not `-max`. Returns -1 when no
 * listed word matches, which is what makes `-svc`, `-proxy` and `-lives` prose.
 */
function catalogueWordComponentEnd(text, at, words, lineEnd) {
  for (const word of words) {
    if (at + word.length > lineEnd || !matchesAsciiCI(text, at, word)) continue;
    const after = at + word.length;
    if (after >= lineEnd) return after;
    const next = text.charCodeAt(after);
    if (isAsciiLetter(next) || isAsciiDigit(next) || next === 95) continue;
    return after;
  }
  return -1;
}

/**
 * The character after an ID-shaped token must be a clean prose boundary:
 * whitespace/EOL, a closing bracket or quote, sentence punctuation, or a `.`
 * that does not continue a hostname or version (`.`+letter/digit ⇒ prose, so
 * `claude-opus-4-8.example.com` and `claude-opus-beta.5` are not IDs). `:` is a
 * boundary only before a non-digit — `id:8080` is host:port prose — while `/`
 * and `@` always glue the token into path/host/email shapes and are never
 * clean. Anything else (letters, digits, `_`, `+`, `=`, …) means the token
 * continues and the whole thing is prose.
 */
function catalogueIdBoundary(text, at, lineEnd) {
  if (at >= lineEnd) return true;
  const t = text.charCodeAt(at);
  if (isSpaceCode(t)) return true;
  if (t === 41 || t === 93 || t === 125 || t === 62) return true; // ) ] } >
  if (t === 39 || t === 34 || t === 8216 || t === 8217 || t === 8220 || t === 8221) return true; // ' " ‘ ’ “ ”
  if (t === 44 || t === 59 || t === 33 || t === 63) return true; // , ; ! ?
  if (t === 46) { // .
    if (at + 1 >= lineEnd) return true;
    const n = text.charCodeAt(at + 1);
    return !(isAsciiLetter(n) || isAsciiDigit(n));
  }
  if (t === 58) { // :
    if (at + 1 < lineEnd && isAsciiDigit(text.charCodeAt(at + 1))) return false; // :port
    return true;
  }
  return false; // / @ and every other glued character
}

/**
 * True when the `claude-` at `prefix` starts a MODEL ID rather than an ordinary
 * word or hostname that happens to share the prefix.
 *
 * The whole hyphenated token must be ID-shaped — `claude-<component>`
 * (`-`<component>)*` with at least two components — and it must END at a clean
 * prose boundary (catalogueIdBoundary). Checking only the head, as the previous
 * version did, classified `claude-opus:8080`, `claude-opus/path`,
 * `claude-fable's`, `claude-4-proxy` and `claude-3-internal:8443` as IDs, and
 * the anchor→EOL span then ate the caller's RULE text.
 *
 *   - head: a digit component (`claude-5-fable-…`, `claude-3-5-sonnet-…`) or a
 *     family word (`claude-opus-…`). A digit run followed by a letter
 *     (`claude-3d`, `claude-1password`) or a family word followed by a letter
 *     or `_` (`claude-opusx`) is a longer caller word — prose.
 *   - family head may fuse a version directly (`claude-sonnet4.6`), the shape
 *     the previous classifier accepted; hyphenated components use the full
 *     component vocabulary.
 *   - `-` followed by a non-component (`-svc`, `-proxy`, `-internal`, `-lives`)
 *     makes the token prose, not "ID + trailing punctuation": the hyphen glues
 *     it into one caller word.
 *   - a bare `claude-<head>` (`claude-opus`, `claude-5`, `claude-fable`) has no
 *     second component and is a name, not a selector — every real claude-*
 *     selector carries a version or effort component.
 */
function catalogueIdFollows(text, prefix, lineEnd) {
  const head = prefix + CATALOGUE_ID_PREFIX.length;
  if (head >= lineEnd) return false;
  let at;
  let components = 0;
  if (isAsciiDigit(text.charCodeAt(head))) {
    at = catalogueDigitComponentEnd(text, head, lineEnd);
    if (at < 0) return false;
    components = 1;
  } else {
    let wend = -1;
    for (const word of CATALOGUE_ID_WORDS) {
      if (head + word.length > lineEnd || !matchesAsciiCI(text, head, word)) continue;
      const after = head + word.length;
      if (after >= lineEnd) { wend = after; break; }
      const next = text.charCodeAt(after);
      // A letter or '_' glued on is a longer caller word (`claude-opusx`,
      // `claude-opus_beta`); a digit is the fused version form handled below.
      if (isAsciiLetter(next) || next === 95) continue;
      wend = after;
      break;
    }
    if (wend < 0) return false;
    components = 1;
    at = wend;
    if (at < lineEnd && isAsciiDigit(text.charCodeAt(at))) {
      const dend = catalogueDigitComponentEnd(text, at, lineEnd);
      if (dend < 0) return false;
      at = dend;
      components = 2;
    }
  }
  for (;;) {
    if (at >= lineEnd || text.charCodeAt(at) !== 45) break; // not '-'
    const compAt = at + 1;
    if (compAt >= lineEnd) return false; // dangling '-' at EOL
    const nextEnd = isAsciiDigit(text.charCodeAt(compAt))
      ? catalogueDigitComponentEnd(text, compAt, lineEnd)
      : catalogueWordComponentEnd(text, compAt, CATALOGUE_ID_COMPONENT_WORDS, lineEnd);
    if (nextEnd < 0) return false; // '-' + non-component ⇒ prose token
    at = nextEnd;
    components++;
  }
  if (components < 2) return false;
  return catalogueIdBoundary(text, at, lineEnd);
}

/**
 * True when an ID-SHAPED model-ID body continues between `from` and `lineEnd`:
 * `claude-<family|version>` — `claude-fable-5`, `claude-opus-4-8`,
 * `claude-3-5-sonnet` — and nothing looser.
 *
 * The test this replaces accepted bare English words (`claude-`, `fable`, `opus`,
 * `sonnet`) and the phrase `Model IDs` anywhere after the anchor. All of those are
 * ordinary caller prose, so lines such as
 *
 *   The most recent Claude models are documented at /docs; Sonnet is our default.
 *   The most recent Claude models are documented under Model IDs in the docs.
 *   The most recent Claude models are documented at claude-docs.example.com.
 *
 * were taken for the client's catalogue and lost everything to the end of the line
 * (the caller's RULE included). `Model IDs` is an English phrase, not a fingerprint,
 * and `claude-` needs a family name or version digit after it to be an ID.
 */
function catalogueBodyFollows(text, from, lineEnd) {
  let at = from;
  for (;;) {
    const prefix = indexOfAsciiCI(text, CATALOGUE_ID_PREFIX, at, lineEnd);
    if (prefix < 0) return false;
    if (catalogueIdFollows(text, prefix, lineEnd)) return true;
    at = prefix + CATALOGUE_ID_PREFIX.length;
  }
}

/**
 * a4-catalogue-line: every `The most recent Claude models are` phrase (ASCII-CI),
 * rewritten to `The available models are` in place.
 *
 * The rule this replaces was `The most recent Claude models are[^\n]*\n?` with an
 * empty replacement, i.e. it deleted the whole line. That is the right span for the
 * client's own catalogue header, but the line is not always the client's: a caller
 * prompt that happens to carry the phrase lost everything after it on that line —
 * measured `'… are listed below; RULE: keep me\nnext'` → `'next'` (66 → 4 bytes),
 * the caller's RULE gone with no WARN. The full a4-catalogue span still removes the
 * whole catalogue when its `… most capable Claude models.` terminator is present.
 *
 * The span therefore depends on what follows the anchor ON ITS LINE:
 *
 *   - no ID-shaped body after the anchor: only the phrase is the fingerprint, so
 *     the span is the phrase alone and every other byte of the line (prefix, caller
 *     RULE, newline) survives. A bare model NAME ("Sonnet is our default") is
 *     caller prose, not a catalogue body, and stays.
 *   - an ID-shaped body (`claude-<family|version>`) after the anchor: this is
 *     the client's catalogue header and its model-ID body, and the
 *     span runs from the anchor to the end of the line. Rewriting only the phrase
 *     left `Model IDs — Fable 5: 'claude-fable-5', Opus 4.8: 'claude-opus-4-8'` on
 *     the wire whenever the terminator sat in another paragraph and a4-catalogue
 *     (correctly) declined to cross the break — measured 253 → 244 bytes with
 *     `claude-fable-5` still present. The prefix before the anchor is still the
 *     caller's and is preserved.
 *
 * One pass over the lines; the cursor advances past each phrase-only span so a line
 * full of anchors is scanned once. A body span reaches the end of the line, so it is
 * the last span that line can contribute.
 *
 * The body test runs AT MOST ONCE per line. catalogueBodyFollows(from) scans the
 * whole suffix to lineEnd, so a false answer proves no ID-shaped `claude-` exists
 * anywhere in [from, lineEnd) — and every LATER anchor on the same line has a
 * larger `from`, hence the same false answer. Re-running the suffix scan per anchor
 * was O(anchors × line): a 512 KiB single line of repeated anchors with no `claude-`
 * took ~3.4 s of synchronous event-loop time (measured). The tri-state below keeps
 * the first answer and reuses it; a true answer still ends the line immediately.
 */
function catalogueLineSpans(text) {
  const spans = [];
  forEachLine(text, (lineStart, lineEnd) => {
    let cursor = lineStart;
    // -1 = not yet answered for this line, 0 = no ID-shaped body, 1 = body found.
    let body = -1;
    for (;;) {
      const anchor = indexOfAsciiCI(text, CATALOGUE_LINE_ANCHOR, cursor, lineEnd);
      if (anchor < 0) return;
      const afterAnchor = anchor + CATALOGUE_LINE_ANCHOR.length;
      if (body < 0) body = catalogueBodyFollows(text, afterAnchor, lineEnd) ? 1 : 0;
      if (body === 1) {
        spans.push({ start: anchor, end: lineEnd });
        return;
      }
      spans.push({ start: anchor, end: afterAnchor });
      cursor = afterAnchor;
    }
  });
  return spans;
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
  let lastEnd = 0;
  forEachLine(text, (lineStart, lineEnd, hasNewline, nextStart) => {
    let at = lineStart;
    while (at < lineEnd && isHorizontalSpaceCode(text.charCodeAt(at))) at++;
    if (at < lineEnd && text.charCodeAt(at) === 45) {
      at++;
      while (at < lineEnd && isHorizontalSpaceCode(text.charCodeAt(at))) at++;
    }
    if (!matchesAsciiCI(text, at, FAST_ANCHOR)) return;
    // Take the newline BEFORE the line too, unless the previous span already
    // consumed it as its trailing newline: two adjacent matches used to share
    // that character, violating applySpans' non-overlapping precondition. The
    // preceding terminator can be any of the JS line terminators, and a `\r\n`
    // pair is consumed whole.
    let start = lineStart;
    if (lineStart > 0 && lineStart - 1 >= lastEnd) {
      const prev = text.charCodeAt(lineStart - 1);
      if (prev === 10 || prev === 13 || prev === 0x2028 || prev === 0x2029) {
        start = lineStart - 1;
        if (prev === 10 && lineStart - 2 >= lastEnd && lineStart >= 2
          && text.charCodeAt(lineStart - 2) === 13) start = lineStart - 2;
      }
    }
    const end = nextStart;
    spans.push({ start, end });
    lastEnd = end;
  });
  return spans;
}

const CLI_ANCHOR = 'claude code is available as a cli';
const CLI_LINE_REPLACEMENT = 'This coding assistant runs in a terminal.\n';
const CLI_LONG_REPLACEMENT = 'This coding assistant runs in a terminal.';

/**
 * Above this many BYTES a line is caller content, not a client identity bullet.
 *
 * The real Environment bullet is ~150 bytes; 4,096 leaves room for a long variant
 * of it while staying far below a prompt-sized payload. Measured before this bound
 * existed: a caller prompt that was ONE 512 KiB line containing the anchor was
 * collapsed to 42 bytes, with a single WARN — the rule deleted from the anchor to
 * the end of the line, which was the whole payload.
 */
const CLI_SHORT_LINE_MAX_BYTES = 4096;

/**
 * True when text[start, end) is longer than `limit` UTF-8 BYTES.
 *
 * Computed in place instead of `Buffer.byteLength(text.slice(...))` so a prompt
 * with 100k short lines does not allocate 100k substrings, and it stops at the
 * first byte past the bound. Surrogate pairs are counted as 4 bytes, not 6: the
 * per-code-unit shortcut (each surrogate half is >= 0x800) would misclassify a
 * short line of astral text as long.
 */
function lineByteLengthExceeds(text, start, end, limit) {
  let bytes = 0;
  for (let i = start; i < end; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < end) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i++; } else bytes += 3;
    } else bytes += 3;
    if (bytes > limit) return true;
  }
  return false;
}

/**
 * a4-cli-line: `Claude Code is available as a CLI` on one line, with the span
 * bounded by WHAT the line is rather than by the regex's greed.
 *
 * The old `/Claude Code is available as a CLI[^\n]*\n?/gi` deleted the anchor and
 * everything to the end of its line. For the Environment bullet it was written
 * for that is correct; for a caller that sends a one-line payload it is the whole
 * prompt. Which span the rule takes therefore depends on the line:
 *
 *   - short line (<= CLI_SHORT_LINE_MAX_BYTES): from the ANCHOR to the end of the
 *     line, plus its trailing newline. The span must start at the anchor, not at the
 *     line start: the regex this replaces matched from the anchor, so whatever the
 *     caller wrote BEFORE the phrase is theirs. Starting at the line start deleted it
 *     (measured: "Always answer in French. Claude Code is available as a CLI" lost
 *     the French rule). A short line with no prefix is still replaced whole.
 *   - long line (> CLI_SHORT_LINE_MAX_BYTES): only the anchor phrase, in place and
 *     without a newline. Every other byte on the line is the caller's and comes
 *     back identical; the line structure is not ours to change.
 *
 * A line without the anchor is never touched, however long it is. The phrase can
 * repeat inside a long line and every occurrence is a fingerprint the 529 gate
 * can see, so all of them are collected (one linear walk per line).
 */
function cliLineSpans(text) {
  const short = [];
  const long = [];
  forEachLine(text, (lineStart, lineEnd, hasNewline, nextStart) => {
    const at = indexOfAsciiCI(text, CLI_ANCHOR, lineStart, lineEnd);
    if (at < 0) return;
    if (lineByteLengthExceeds(text, lineStart, lineEnd, CLI_SHORT_LINE_MAX_BYTES)) {
      let cursor = at;
      while (cursor >= 0) {
        long.push({ start: cursor, end: cursor + CLI_ANCHOR.length });
        cursor = indexOfAsciiCI(text, CLI_ANCHOR, cursor + CLI_ANCHOR.length, lineEnd);
      }
      return;
    }
    short.push({ start: at, end: nextStart });
  });
  return { short, long };
}

const BILLING_HEADER = 'x-anthropic-billing-header:';

/**
 * a3-billing: per line, optional leading horizontal whitespace then the exact
 * `x-anthropic-billing-header:` literal, to end of line. The span takes the trailing
 * newline so the line is gone without leaving a blank one behind.
 */
function billingSpans(text) {
  const spans = [];
  forEachLine(text, (lineStart, lineEnd, hasNewline, nextStart) => {
    let at = lineStart;
    while (at < lineEnd && isHorizontalSpaceCode(text.charCodeAt(at))) at++;
    if (!matchesAsciiCI(text, at, BILLING_HEADER)) return;
    spans.push({ start: lineStart, end: nextStart });
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

const FREEFORM_CLAUSE = 'do not wrap the patch in json';
const FREEFORM_TOKEN = 'FREEFORM';

/**
 * a7-freeform: `FREEFORM` only on a line that ALSO carries the apply_patch
 * JSON-wrap clause ("do not wrap the patch in JSON"). The old rule was a global
 * bare-token match, so it rewrote the CALLER's SQL enum literals and JavaScript
 * identifiers (WA-003) — text it was never aimed at. The clause is the provenance
 * boundary: the trigger is the codex apply_patch description sentence "This is a
 * FREEFORM tool, so do not wrap the patch in JSON.", and a line without the clause
 * is caller content and comes back byte-identical. Line-scoped on purpose: the
 * token and the clause sit in the same sentence, and a cross-line scan would let
 * any mention of the clause license rewriting FREEFORM tokens elsewhere.
 *
 * The token match is case-SENSITIVE, as the `/FREEFORM/g` it replaces was: the
 * clause licenses the uppercase enum the tool description uses, not a lowercase
 * `freeform` the caller wrote (a SQL type name, a column, an identifier). The
 * CLAUSE check stays case-insensitive — it only establishes provenance.
 */
function freeformSpans(text) {
  const spans = [];
  // The provenance boundary is the PARAGRAPH, not the line: a wrapped preamble
  // can carry `FREEFORM` on the line after its JSON-wrap clause, and a bare
  // token anywhere else is caller text (the WA-003 global rewrite corrupted
  // exactly that). A blank line — all non-terminator whitespace — ends the
  // scope, same paragraph model the security rules use.
  let paraHasClause = false;
  let paraStart = 0;
  const flush = (paraEnd) => {
    if (!paraHasClause) return;
    let at = paraStart;
    for (;;) {
      at = indexOfExact(text, FREEFORM_TOKEN, at, paraEnd);
      if (at < 0) break;
      spans.push({ start: at, end: at + FREEFORM_TOKEN.length });
      at += FREEFORM_TOKEN.length;
    }
  };
  forEachLine(text, (lineStart, lineEnd, hasNewline, nextStart) => {
    let blank = true;
    for (let i = lineStart; i < lineEnd; i++) {
      if (!isSpaceCode(text.charCodeAt(i))) { blank = false; break; }
    }
    if (blank) {
      flush(lineStart);
      paraHasClause = false;
      paraStart = nextStart;
      return;
    }
    if (indexOfAsciiCI(text, FREEFORM_CLAUSE, lineStart, lineEnd) >= 0) paraHasClause = true;
    if (!hasNewline) flush(text.length);
  });
  return spans;
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
// SQL DDL and in source code before H2 scoped it to the apply_patch description.
// Set above the plausible-identity count rather than at 1 so an ordinary
// two-mention prompt stays quiet.
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
   * which is the failure mode this is supposed to prevent. What distinguished
   * a7-freeform was that it was a GLOBAL BARE-TOKEN rule: it could hit an unbounded
   * number of times in text it was never aimed at. H2 has since given that rule a
   * paragraph-scoped provenance boundary (freeformSpans); the occurrence guard stays as
   * the safety net for any future bare-token rule. So the signal is "this rule fired
   * more times than a self-identification phrase plausibly appears".
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
  // a4-cli-line: line-scoped, but the span depends on the line. A short line is a
  // client identity bullet and is replaced from the anchor to its end, so any caller
  // prefix before the phrase survives; a LONG line is caller content that merely
  // mentions the phrase, so only the phrase is rewritten and every other byte
  // survives (measured before this bound: 512 KiB in, 42 B out). Long-line spans are
  // applied FIRST: the short-line spans are offsets into `out`, and each phrase
  // replacement shifts them, so they are re-scanned rather than adjusted.
  const cli = cliLineSpans(out);
  if (cli.long.length > 0) {
    applySpans('a4-cli-line-long', cli.long, CLI_LONG_REPLACEMENT, true);
    applySpans('a4-cli-line', cliLineSpans(out).short, CLI_LINE_REPLACEMENT, true);
  } else {
    applySpans('a4-cli-line', cli.short, CLI_LINE_REPLACEMENT, true);
  }
  // LINEAR: same paragraph-bounded shape as a4-brand-span; the terminator search
  // is bounded to the paragraph, and a paragraph without one is skipped whole.
  const catalogue = catalogueSpan(out);
  if (catalogue) applySpans('a4-catalogue', [catalogue], '');
  // Same fallback shape as a4-cli-line: if the catalogue's opening sentence and its
  // "… most capable Claude models." tail end up in different paragraphs, the span
  // above (correctly) declines, and this neutralizes the fingerprint-bearing header
  // on its own rather than leaving the model-ID catalogue header upstream. A line
  // whose remainder carries an ID-SHAPED model-ID body (`claude-<family|version>`)
  // loses that body with the header — leaving it behind kept the
  // model IDs on the wire (measured 253 → 244 bytes, `claude-fable-5` present). A
  // line with no such body is a caller sentence that merely opens with the phrase,
  // so only the phrase is rewritten: the old rule deleted the rest of the line, and a
  // caller RULE that shared the line with the phrase vanished (66 → 4 bytes, no WARN).
  applySpans('a4-catalogue-line', catalogueLineSpans(out), CATALOGUE_LINE_REPLACEMENT, true);
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
  // PROVENANCE BOUNDARY (H2/WA-003): FREEFORM is rewritten only on a line that also
  // carries the JSON-wrap clause above; the old global `/FREEFORM/g` also rewrote the
  // CALLER's SQL enum literals and JavaScript identifiers. The clause is still present
  // here because this rule runs BEFORE a7-json-wrap — swapping the two lines would
  // erase the provenance anchor first and leave FREEFORM in the description.
  // Live-confirmed ⇒ unconditional, on the main WINDSURFAPI_NEUTRALIZE_CLIENT_ID switch.
  applySpans('a7-freeform', freeformSpans(out), 'free-form', true);
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
