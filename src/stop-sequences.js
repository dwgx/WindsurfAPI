/**
 * OpenAI `stop` sequence enforcement (proto-openai-03).
 *
 * The OpenAI /v1/chat/completions path accepted `stop` (string | string[]) and
 * folded it into the cache key, but NEVER enforced it: the upstream Devin wire
 * has no calibrated stop field, so the model ran to its own natural end and the
 * caller's stop sequence was silently ignored. Clients that rely on `stop` to
 * fence output (e.g. "stop at \n\n" or a custom sentinel) got over-long
 * completions.
 *
 * Fix = local enforcement, mirroring what the Anthropic path already does for
 * stop_sequences (handlers/messages.js): truncate the assistant text at the
 * FIRST occurrence of any stop sequence and report finish_reason:'stop'. The
 * matched sequence itself is removed from the output (OpenAI semantics — the
 * stop text is not included in the returned content).
 */

// OpenAI documents only the count limit (4 sequences); no per-sequence length
// is published. Locally a sequence's length IS the enforcement cost: the
// streaming gate holds back (len - 1) chars per delta and indexOf-scans that
// window for every upstream chunk, so an unbounded sequence is an unbounded
// per-delta scan AND an unbounded holdback buffer. Cap each entry at 1024
// chars — far past any real-world sentinel. An over-limit sequence is DROPPED,
// not truncated: a truncated sequence could match where the caller's full
// sequence never would, cutting output upstream would have returned (wrong
// truncation). Dropping is fail-open — the request behaves as if that sequence
// were absent, exactly like the non-string / empty entries already discarded
// here — and can never invent a stop the caller did not write.
export const MAX_STOP_SEQUENCE_CHARS = 1024;

// OpenAI allows a bare string or an array of up to 4 strings. Normalize to a
// clean string[] (drop non-strings / empties / over-long entries); return []
// when nothing usable.
export function normalizeStop(stop) {
  const usable = (s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_STOP_SEQUENCE_CHARS;
  if (typeof stop === 'string') return usable(stop) ? [stop] : [];
  if (Array.isArray(stop)) {
    return stop.filter(usable).slice(0, 4);
  }
  return [];
}

// Non-streaming: truncate `text` at the earliest stop-sequence hit. Returns
// { text, hit, stop } — hit is true when any sequence matched (→ finish_reason:'stop'),
// and `stop` is the EXACT sequence that won (null when nothing matched). Callers
// that must report the cause — the Anthropic Messages route echoes it as
// `stop_sequence` — need the cause at THIS layer: the matched bytes are removed
// from the returned text, so nothing downstream can recover which sequence fired.
// When multiple sequences appear, the one with the EARLIEST index wins so the
// output is the shortest correct prefix; on an exact tie the earlier entry in the
// caller's list wins (unchanged).
export function applyStop(text, stopSequences) {
  if (typeof text !== 'string' || !text) return { text: text || '', hit: false, stop: null };
  const seqs = normalizeStop(stopSequences);
  if (!seqs.length) return { text, hit: false, stop: null };
  let cut = -1;
  let matched = null;
  for (const seq of seqs) {
    const idx = text.indexOf(seq);
    if (idx !== -1 && (cut === -1 || idx < cut)) { cut = idx; matched = seq; }
  }
  if (cut === -1) return { text, hit: false, stop: null };
  return { text: text.slice(0, cut), hit: true, stop: matched };
}

/**
 * Streaming enforcement. A stop sequence can straddle two content chunks, so we
 * hold back a tail of up to (maxSeqLen - 1) chars until we know it is NOT the
 * start of a stop sequence. Usage per stream:
 *
 *   const gate = new StopSequenceGate(stop);
 *   for each content chunk:
 *     const { emit, hit } = gate.push(chunk);
 *     if (emit) send(emit);
 *     if (hit) { finish_reason = 'stop'; break; }   // suppress the rest
 *   // if the stream ends naturally:
 *   const tail = gate.flush(); if (tail) send(tail);
 */
export class StopSequenceGate {
  constructor(stop) {
    this.seqs = normalizeStop(stop);
    this.maxLen = this.seqs.reduce((m, s) => Math.max(m, s.length), 0);
    this.buf = '';
    this.done = false;
    // The sequence that ended the stream (null until a hit). Same reason as
    // applyStop's `stop`: the matched bytes never reach the caller's text, so the
    // cause has to be captured where the match happened.
    this.matched = null;
  }

  get active() { return this.seqs.length > 0; }

  // Feed one content delta. Returns { emit, hit }:
  //   emit — the safe-to-send prefix (may be '')
  //   hit  — true once a stop sequence completed; caller should stop the stream.
  // After a hit, further push() calls return nothing.
  push(chunk) {
    if (!this.active || this.done) {
      return { emit: this.done ? '' : (chunk || ''), hit: false };
    }
    this.buf += (chunk || '');
    // Earliest stop match in the running buffer (ties keep the earlier list entry).
    let cut = -1;
    let matched = null;
    for (const seq of this.seqs) {
      const idx = this.buf.indexOf(seq);
      if (idx !== -1 && (cut === -1 || idx < cut)) { cut = idx; matched = seq; }
    }
    if (cut !== -1) {
      const emit = this.buf.slice(0, cut);
      this.buf = '';
      this.done = true;
      this.matched = matched;
      return { emit, hit: true };
    }
    // No full match yet. Emit everything except a trailing (maxLen-1) window that
    // could still become the head of a stop sequence in the next chunk.
    const hold = this.maxLen - 1;
    if (this.buf.length <= hold) return { emit: '', hit: false };
    const emit = this.buf.slice(0, this.buf.length - hold);
    this.buf = this.buf.slice(this.buf.length - hold);
    return { emit, hit: false };
  }

  // Stream ended with no stop hit — release whatever is still held.
  flush() {
    if (this.done) return '';
    const out = this.buf;
    this.buf = '';
    return out;
  }
}
