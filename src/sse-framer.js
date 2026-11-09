// Shared SSE framer: one line-terminator rule for the three translators and the
// downstream commit gate. No dependencies.
//
// The canonical producer (chat.js) writes whole `data: <json>\n\n` strings, so the
// happy path is byte-identical. The framer hardens the seam against CRLF, split
// UTF-8, multi-line data, EOF without a blank line, and an unbounded buffer.
//
// The cap bounds retained logical frame bytes (event + data), not the wire
// prefix, so a network chunk boundary cannot change whether a legal frame is
// accepted. Data and the current event have separate budgets; the combined
// frame payload is checked when the frame dispatches, so a later event may
// shrink a frame that temporarily exceeded the cap. An event value over the cap
// fails at its completed or partial line even if a later event would replace
// it. Comment/unknown lines and id/retry values are bounded on their own and
// never enter either payload budget. A partial line is charged by its value
// bytes as soon as its field prefix is decidable; the first
// MAX_FIELD_PREFIX_BYTES bytes of an undecided line are free.
//
// The partial line is kept as a list of chunks plus an 8-char head, never as a
// growing rope: classification and byte accounting stay O(1) per push and the
// whole line is joined once when its terminator arrives.
//
// Two budgets are enforced independently: `maxFrameBytes` (payload bytes of one
// frame) and `maxQueuedBytes` (what the framer retains while assembling it,
// including a per-line overhead charge). The second exists because a flood of
// one-byte `data:` lines can stay far under the payload cap while retaining
// hundreds of MB of array slots and strings.
//
// A `data:` payload carrying several concatenated JSON documents is repaired
// per line and dispatched as one frame per document; an unrepairable JSON
// payload becomes a typed `SSE_MALFORMED_JSON` error frame instead of a silent
// drop that would end the turn with zero content and a clean stop.

import { StringDecoder } from 'node:string_decoder';

export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;
// A second, independent budget for the bytes the framer RETAINS while a frame is
// being assembled. The frame cap alone bounds payload bytes, but one `data:`
// line costs far more RSS than its value: every retained line is an array slot
// plus a string object, so tens of millions of one-byte lines stay under the
// 64 MB payload cap while retaining hundreds of megabytes of JS objects. The
// queued budget charges a fixed per-line overhead on top of the value bytes, so
// an oversized line or an event flood trips here first, while a legitimate
// multi-megabyte image event (the 64 MB cap's reason for existing) still fits.
// Deliberately below the frame cap: it is the RSS bound, not the frame bound.
export const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;
// Retained-cost estimate for one data/event line: array slot + string header +
// join separator, rounded up. Charged so a flood of tiny lines cannot hide
// behind its small payload byte count.
const QUEUED_LINE_OVERHEAD_BYTES = 16;

const TERMINATOR_RE = /(\r\n\r\n|\r\n\n|\r\n\r|\n\r\n|\n\n|\n\r|\r\r)/g;
const NEWLINE_RE = /[\r\n]/g;
const FIELD_RE = /^(event|data|id|retry)(?::(.*))?$/;
const FIELDS = ['event', 'data', 'id', 'retry'];
const MAX_FIELD_PREFIX_BYTES = 7; // 'event: ' / 'retry: '
const HEAD_CHARS = MAX_FIELD_PREFIX_BYTES + 1;

export function findFrameEnd(text, from = 0) {
  TERMINATOR_RE.lastIndex = from;
  const match = TERMINATOR_RE.exec(text);
  if (!match) return null;
  return { frameEnd: match.index, next: match.index + match[0].length };
}

// One line rule for the framer and the deferred commit gate. SSE consumes at
// most one ASCII space after the colon; a tab stays in the value. A recognized
// field with no colon is a field with an empty value; other colon-less lines
// name no field and are ignored.
export function parseSseLine(line) {
  const match = FIELD_RE.exec(line);
  if (!match) return null;
  const raw = match[2] ?? '';
  return { field: match[1], value: raw.startsWith(' ') ? raw.slice(1) : raw };
}

// ─── JSON document repair for `data:` payloads ───────────────────────────────
//
// An upstream may put several complete JSON documents on one `data:` line
// (`{"a":1}{"b":2}`) instead of one document per frame. `JSON.parse` rejects
// that payload as a whole, and a consumer that drops it ends the turn with zero
// content and a clean `stop` — the exact silent-empty failure this helper
// removes. The payload is split at document boundaries so every document
// reaches `onFrame` on its own; a JSON-looking payload that cannot be split
// into complete documents is reported as malformed, and the caller must fail
// typed instead of dropping it.
//
// Only object/array payloads are repair candidates. `[DONE]`, comments and
// plain-text data are not JSON frames and are returned untouched.

const JSON_WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

function isJsonSpace(code) {
  return JSON_WS.has(code);
}

/** Index one past the closing bracket of the JSON value at `start`, or -1. */
function scanJsonDocumentEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (c === 0x5c) { escaped = true; continue; }
      if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) { inString = true; continue; }
    if (c === 0x7b || c === 0x5b) depth += 1;
    else if (c === 0x7d || c === 0x5d) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * True when the payload is a JSON-object frame (its first non-whitespace
 * character is `{`). `[DONE]`, comments and plain text are not.
 */
function isJsonObjectPayload(text) {
  let start = 0;
  while (start < text.length && isJsonSpace(text.charCodeAt(start))) start += 1;
  return start < text.length && text.charCodeAt(start) === 0x7b;
}

function malformedDataFrame(event) {
  return {
    event,
    data: JSON.stringify({
      error: {
        message: 'upstream SSE data is not valid JSON and could not be repaired',
        type: 'api_error',
        code: 'SSE_MALFORMED_JSON',
      },
    }),
  };
}

/**
 * Split concatenated JSON documents (`{"a":1}{"b":2}`) into parsed values.
 * Returns `null` when the text is not a sequence of complete JSON values.
 */
export function splitJsonDocuments(text) {
  const docs = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && isJsonSpace(text.charCodeAt(i))) i += 1;
    if (i >= text.length) break;
    const first = text.charCodeAt(i);
    if (first !== 0x7b && first !== 0x5b) return null;
    const end = scanJsonDocumentEnd(text, i);
    if (end < 0) return null;
    try {
      docs.push(JSON.parse(text.slice(i, end)));
    } catch {
      return null;
    }
    i = end;
  }
  return docs.length ? docs : null;
}

/**
 * Parse an SSE `data:` payload into every JSON document it carries.
 *
 * Returns `{ docs, malformed }`:
 *   * `docs: [...]`   — one or more parsed documents (a plain JSON frame is one);
 *   * `docs: null`    — the payload is not a JSON object payload (`[DONE]`,
 *                       comments, plain text) and must be passed through as-is;
 *   * `malformed:true` — the payload starts like a JSON object but no complete
 *                       document sequence can be parsed from it.
 *
 * Repair is per `data:` line, not per frame: a frame's data is the joined value
 * of its `data:` lines, so the whole payload is tried first (a pretty-printed
 * document spans lines) and each line on its own afterwards.
 */
export function parseSseDataJson(data) {
  const text = typeof data === 'string' ? data : '';
  const trimmed = text.trim();
  if (!trimmed) return { docs: [], malformed: false };
  try {
    return { docs: [JSON.parse(trimmed)], malformed: false };
  } catch { /* try to repair below */ }
  if (trimmed.charCodeAt(0) !== 0x7b) return { docs: null, malformed: false };
  const whole = splitJsonDocuments(trimmed);
  if (whole && whole.length > 1) return { docs: whole, malformed: false };
  const docs = [];
  for (const line of trimmed.split('\n')) {
    const value = line.trim();
    if (!value) continue;
    if (value.charCodeAt(0) !== 0x7b) return { docs: null, malformed: true };
    try {
      docs.push(JSON.parse(value));
      continue;
    } catch { /* concatenated documents on one line */ }
    const split = splitJsonDocuments(value);
    if (!split) return { docs: null, malformed: true };
    docs.push(...split);
  }
  if (!docs.length) return { docs: null, malformed: true };
  return { docs, malformed: false };
}

function classifyHead(head) {
  if (head.charCodeAt(0) === 58) return { comment: true, prefixBytes: 0 };
  for (const field of FIELDS) {
    if (head.length <= field.length) continue;
    if (!head.startsWith(field) || head.charCodeAt(field.length) !== 58) continue;
    // Wait for the next character before deciding whether a space belongs to
    // the prefix; the choice changes the charged value bytes by one.
    if (head.length === field.length + 1) return undefined;
    const prefixBytes = field.length + 1 + (head.charCodeAt(field.length + 1) === 32 ? 1 : 0);
    return { field, prefixBytes };
  }
  return undefined;
}

export class SseFramer {
  constructor({
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    maxQueuedBytes = DEFAULT_MAX_QUEUED_BYTES,
    onFrame,
    onComment,
    onOverflow,
  } = {}) {
    this.maxFrameBytes = maxFrameBytes;
    this.maxQueuedBytes = maxQueuedBytes;
    this.onFrame = onFrame;
    this.onComment = onComment;
    this.onOverflow = onOverflow;
    this.decoder = new StringDecoder('utf8');
    // A UTF-8 BOM is transport decoration for the first field, not payload;
    // it is dropped once, before the first line is classified.
    this.atStart = true;
    this.parts = [];
    this.partialBytes = 0;
    this.lineHead = '';
    this.partialClass = undefined;
    this.pendingCr = false;
    this.event = null;
    this.data = [];
    this.payloadBytes = 0;
    this.dataBytes = 0;
    this.eventBytes = 0;
    // Retained-cost accounting for the queued-byte budget: partial line bytes
    // plus every retained data/event line (value + per-line overhead).
    this.queuedBytes = 0;
    this.dataCharge = 0;
    this.eventCharge = 0;
    this.failed = false;
    this.ended = false;
  }

  get bufferedBytes() {
    return this.payloadBytes + this.partialBytes;
  }

  push(chunk) {
    if (this.failed || this.ended) return;
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(Buffer.from(chunk));
    if (text) this.#feed(text);
    const over = this.failed ? null : this.#overCapReason();
    if (over) this.#overflow(over);
  }

  end() {
    if (this.failed || this.ended) return;
    this.ended = true;
    const tail = this.decoder.end();
    if (tail) this.#feed(tail);
    if (!this.failed && this.pendingCr) {
      this.pendingCr = false;
      this.#completeLine();
    }
    if (!this.failed && this.parts.length) this.#completeLine();
    if (!this.failed) this.#dispatch();
    const over = this.failed ? null : this.#overCapReason();
    if (over) this.#overflow(over);
  }

  #feed(text) {
    if (this.atStart) {
      this.atStart = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      if (!text) return;
    }
    let i = 0;
    const n = text.length;
    if (this.pendingCr) {
      // The previous chunk ended with CR. LF makes it one CRLF terminator;
      // anything else makes the CR a lone terminator.
      if (text.charCodeAt(0) === 10) i = 1;
      this.pendingCr = false;
      this.#completeLine();
      if (this.failed) return;
    }
    while (i < n) {
      NEWLINE_RE.lastIndex = i;
      const match = NEWLINE_RE.exec(text);
      if (!match) {
        this.#appendSegment(text.slice(i));
        return;
      }
      const idx = match.index;
      if (idx > i) this.#appendSegment(text.slice(i, idx));
      if (text.charCodeAt(idx) === 13) {
        if (idx + 1 === n) {
          this.pendingCr = true;
          return;
        }
        this.#completeLine();
        i = idx + (text.charCodeAt(idx + 1) === 10 ? 2 : 1);
      } else {
        this.#completeLine();
        i = idx + 1;
      }
      if (this.failed) return;
    }
  }

  #appendSegment(segment) {
    if (!segment) return;
    const bytes = Buffer.byteLength(segment, 'utf8');
    this.parts.push(segment);
    this.partialBytes += bytes;
    this.queuedBytes += bytes;
    if (this.lineHead.length < HEAD_CHARS) {
      this.lineHead += segment.slice(0, HEAD_CHARS - this.lineHead.length);
    }
  }

  #partialInfo() {
    if (this.partialClass !== undefined) return this.partialClass;
    const info = classifyHead(this.lineHead);
    if (info !== undefined) {
      this.partialClass = info;
      return info;
    }
    if (this.partialBytes > MAX_FIELD_PREFIX_BYTES) {
      this.partialClass = null;
      return null;
    }
    return undefined;
  }

  // Two independent budgets. The frame cap bounds payload bytes (data + event)
  // and keeps its exact previous semantics. The queued budget bounds what the
  // framer RETAINS: partial line bytes plus every retained line charged with a
  // per-line overhead, so a flood of tiny lines cannot grow the array/strings
  // unbounded while staying under the payload cap. Returns the tripped budget's
  // name so the overflow error is typed correctly, or null.
  #overCapReason() {
    if (this.dataBytes > this.maxFrameBytes) return 'frame';
    if (this.queuedBytes > this.maxQueuedBytes) return 'queue';
    if (this.partialBytes === 0) return null;
    const info = this.#partialInfo();
    if (info === undefined) return null;
    if (info === null || info.comment) {
      return this.partialBytes > this.maxFrameBytes ? 'frame' : null;
    }
    const valueBytes = Math.max(0, this.partialBytes - info.prefixBytes);
    if (info.field === 'data') {
      return this.dataBytes + valueBytes > this.maxFrameBytes ? 'frame' : null;
    }
    return valueBytes > this.maxFrameBytes ? 'frame' : null;
  }

  #completeLine() {
    const line = this.parts.length === 1 ? this.parts[0] : this.parts.join('');
    this.queuedBytes = Math.max(0, this.queuedBytes - this.partialBytes);
    this.parts = [];
    this.partialBytes = 0;
    this.lineHead = '';
    this.partialClass = undefined;
    this.#line(line);
  }

  #overflow(reason = 'frame') {
    if (this.failed) return;
    this.failed = true;
    this.parts = [];
    this.partialBytes = 0;
    this.lineHead = '';
    this.partialClass = undefined;
    this.pendingCr = false;
    this.event = null;
    this.data = [];
    this.payloadBytes = 0;
    this.dataBytes = 0;
    this.eventBytes = 0;
    // Release the queued bytes with the buffers: a failed stream must not keep
    // its flood reachable from the framer while the caller tears it down.
    this.queuedBytes = 0;
    this.dataCharge = 0;
    this.eventCharge = 0;
    const queue = reason === 'queue';
    const error = Object.assign(
      new Error(queue ? 'SSE queued bytes exceed cap' : 'SSE frame exceeds cap'),
      { code: queue ? 'SSE_QUEUE_OVERFLOW' : 'SSE_FRAME_TOO_LARGE' },
    );
    this.onOverflow?.(error);
    // A queue overflow is a transport failure, not a partial frame: emit the
    // typed upstream error every translator already maps to its protocol error
    // event. Without this the consumer saw `failed` with no frame and finished
    // the turn with zero content and a clean `stop`.
    if (queue) {
      this.onFrame?.({
        event: null,
        data: JSON.stringify({
          error: {
            message: 'upstream SSE exceeded the queued-byte budget',
            type: 'api_error',
            code: 'SSE_QUEUE_OVERFLOW',
          },
        }),
      });
    }
  }

  #line(line) {
    if (line === '') {
      this.#dispatch();
      return;
    }
    if (line.charCodeAt(0) === 58) {
      if (Buffer.byteLength(line, 'utf8') > this.maxFrameBytes) {
        this.#overflow('frame');
        return;
      }
      this.onComment?.(line);
      return;
    }
    const parsed = parseSseLine(line);
    if (!parsed) {
      if (Buffer.byteLength(line, 'utf8') > this.maxFrameBytes) this.#overflow('frame');
      return;
    }
    if (parsed.field === 'event') {
      const bytes = Buffer.byteLength(parsed.value, 'utf8');
      this.queuedBytes = Math.max(0, this.queuedBytes - this.eventCharge);
      this.eventCharge = bytes + QUEUED_LINE_OVERHEAD_BYTES;
      this.queuedBytes += this.eventCharge;
      this.eventBytes = bytes;
      this.payloadBytes = this.dataBytes + this.eventBytes;
      this.event = parsed.value;
      if (this.eventBytes > this.maxFrameBytes) { this.#overflow('frame'); return; }
      if (this.queuedBytes > this.maxQueuedBytes) { this.#overflow('queue'); return; }
      return;
    }
    if (parsed.field === 'data') {
      const bytes = Buffer.byteLength(parsed.value, 'utf8');
      const separator = this.data.length ? 1 : 0;
      this.dataBytes += separator + bytes;
      this.payloadBytes = this.dataBytes + this.eventBytes;
      this.data.push(parsed.value);
      this.dataCharge += separator + bytes + QUEUED_LINE_OVERHEAD_BYTES;
      this.queuedBytes += separator + bytes + QUEUED_LINE_OVERHEAD_BYTES;
      if (this.dataBytes > this.maxFrameBytes) { this.#overflow('frame'); return; }
      if (this.queuedBytes > this.maxQueuedBytes) { this.#overflow('queue'); return; }
      return;
    }
    // id/retry are not part of the emitted frame; bound the value so a partial
    // field cannot retain unbounded wire data.
    if (Buffer.byteLength(parsed.value, 'utf8') > this.maxFrameBytes) this.#overflow('frame');
  }

  #dispatch() {
    if (this.failed) return;
    if (this.event !== null || this.data.length) {
      if (this.payloadBytes > this.maxFrameBytes) {
        this.#overflow('frame');
        return;
      }
      const data = this.data.join('\n');
      if (isJsonObjectPayload(data)) {
        // JSON-object frames are validated so an unrepairable payload becomes a
        // typed error instead of a silent drop. A single document is forwarded
        // byte-identically; concatenated documents are delivered one per frame.
        const parsed = parseSseDataJson(data);
        if (parsed.malformed) {
          this.onFrame?.(malformedDataFrame(this.event));
        } else if (parsed.docs && parsed.docs.length > 1) {
          for (const doc of parsed.docs) {
            this.onFrame?.({ event: this.event, data: JSON.stringify(doc) });
          }
        } else {
          this.onFrame?.({ event: this.event, data });
        }
      } else {
        // `[DONE]`, comments and plain-text data are not JSON frames.
        this.onFrame?.({ event: this.event, data });
      }
    }
    this.event = null;
    this.data = [];
    this.payloadBytes = 0;
    this.dataBytes = 0;
    this.eventBytes = 0;
    this.queuedBytes = 0;
    this.dataCharge = 0;
    this.eventCharge = 0;
  }

  /**
   * Cancel the stream and release everything it retains. Callers that tear a
   * translation down (client gone, route abort) must not leave a flood's bytes
   * reachable from the framer until GC.
   */
  dispose() {
    this.ended = true;
    this.parts = [];
    this.partialBytes = 0;
    this.lineHead = '';
    this.partialClass = undefined;
    this.pendingCr = false;
    this.event = null;
    this.data = [];
    this.payloadBytes = 0;
    this.dataBytes = 0;
    this.eventBytes = 0;
    this.queuedBytes = 0;
    this.dataCharge = 0;
    this.eventCharge = 0;
  }
}
