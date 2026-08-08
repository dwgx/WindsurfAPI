// Incremental reasoning/content duplicate suppression (Thinking dedup rework).
//
// PROBLEM
// The upstream behind devin-connect can deliver the reasoning twice in one
// response: first as reasoning tokens (reasoning_content), then verbatim as
// content. The first T4 design held ALL content until stream end and only then
// decided whether to emit it ("settle-flush"). That was rejected: holding the
// whole stream delays every chunk of a normal answer, which breaks progressive
// streaming for all thinking models.
//
// POLICY (this rework)
// We never hold the normal answer. Instead:
//
//   - While a content chunk byte-matches a prefix of the accumulated reasoning,
//     the chunk may be HELD in a tiny buffer that lives fractions of a second.
//   - As soon as content diverges from the reasoning prefix, EVERYTHING held so
//     far plus the current chunk is emitted immediately, and the stream then
//     passes through with no further delay.
//   - Suppression happens ONLY when, at stream end, the accumulated content
//     is byte-identical to the FULL reasoning AND the caller explicitly requested
//     thinking (wantThinking: true). If wantThinking is false (default), standard
//     OpenAI SDK clients only read delta.content — reasoning_content is invisible
//     to them, so the held tail is emitted at settle() to prevent an empty answer.
//
// Net effect: exact full-length duplicates are suppressed when thinking is enabled;
// a normal answer never waits for a single extra chunk beyond the divergence point.
//
// INVARIANTS
//   - content == reasoning AND wantThinking: true        → suppressed at settle()
//   - content == reasoning AND wantThinking: false       → released at settle()
//   - content is a strict prefix of the reasoning        → released at settle()
//   - content diverges from the reasoning              → everything emitted at
//     the moment of divergence; the stream passes through afterwards
//   - no reasoning seen yet                            → pure passthrough
//   - settle() with an empty held buffer               → no-op
//   - stream error/abort path                          → caller uses release():
//     nothing is suppressed on the failure path, a held duplicate tail beats
//     a silently missing tail
//
// The module is protocol-agnostic and dependency-free: it only ever compares
// strings. It never sees SSE frames, model names or client state, and it has
// no imports from the rest of the codebase.
//
// API (returned by createStreamReasoningDedup()):
//   noteReasoning(text) → void
//       Append a reasoning delta to the accumulated reasoning string. Call only
//       with non-empty text; empty input is ignored.
//   feed(text) → { emit: string, hold: boolean }
//       Feed a content delta. `emit` is the string the caller must send NOW
//       ('' = nothing to emit); `hold` is true when the chunk was absorbed into
//       the held buffer and must NOT be emitted.
//         - empty text                          → { emit: '', hold: false }
//         - no reasoning seen yet               → { emit: text, hold: false }
//         - already diverged                    → { emit: text, hold: false }
//         - held + text is still a reasoning
//           prefix                              → { emit: '',  hold: true  }
//         - otherwise (DIVERGE)                 → { emit: held + text, hold: false }
//   settle() → { emit: string, suppressed: boolean }
//       Stream end, success path. If the held buffer is byte-identical to the
//       FULL reasoning → suppressed=true, emit=''. If it is a strict prefix
//       (shorter) → suppressed=false, emit=held (released in one frame).
//       Otherwise (nothing held) → { emit: '', suppressed: false }.
//   release() → string
//       Failure path (stream error / abort / client disconnect). Returns the
//       held buffer unconditionally — never suppresses — and clears it. The
//       caller emits the returned tail if non-empty.
//
// held is bounded by HELD_CAP: crossing it latches divergence (the buffer is
// released) instead of growing without limit on a default-on path. In
// practice held is already bounded by the reasoning length — the cap is
// defense in depth, not the mechanism.
//
// Prefix checks run against the FULL accumulated reasoning string
// (seenReasoning.startsWith(candidate)), which makes the comparison incremental:
// O(candidate) per chunk, never a full-string rescan beyond the candidate
// length.

const HELD_CAP = 1024 * 1024;

export function createStreamReasoningDedup({ wantThinking = false } = {}) {
  let seenReasoning = '';
  let held = '';
  let diverged = false;

  function noteReasoning(text) {
    if (!text) return;
    seenReasoning += text;
  }

  function feed(text) {
    if (!text) return { emit: '', hold: false };
    if (!seenReasoning) return { emit: text, hold: false };
    if (diverged) return { emit: text, hold: false };
    const candidate = held + text;
    if (seenReasoning.startsWith(candidate)) {
      if (candidate.length > HELD_CAP) {
        // Cap crossed: latch divergence and flush rather than hold an
        // unbounded buffer.
        diverged = true;
        held = '';
        return { emit: candidate, hold: false };
      }
      held = candidate;
      return { emit: '', hold: true };
    }
    // DIVERGE: release everything held so far plus this chunk in one frame,
    // then pass through untouched for the rest of the stream.
    diverged = true;
    const release = held + text;
    held = '';
    return { emit: release, hold: false };
  }

  function settle() {
    if (held) {
      // Verbatim full duplicate is suppressed ONLY when the caller explicitly
      // requested thinking (wantThinking === true). Standard OpenAI SDK clients
      // only read delta.content — reasoning_content is invisible to them, so
      // suppressing identical content would yield an empty client answer.
      const suppress = held === seenReasoning && wantThinking;
      const out = suppress ? '' : held;
      held = '';
      return { emit: out, suppressed: suppress };
    }
    return { emit: '', suppressed: false };
  }

  // Failure path (stream error / abort / client disconnect): returns the held
  // tail unconditionally — nothing is suppressed here — and clears it.
  function release() {
    const out = held;
    held = '';
    return out;
  }

  return { noteReasoning, feed, settle, release };
}