// Response-content classifier (Thinking-core item 2, applied in item 1).
//
// Purpose: decide which parts of a streamed answer are *reasoning* vs *actionable
// text*, so misrouted content can be corrected at the egress and self-reinforcing
// loops can be broken.
//
// Degradation addressed: the model sometimes emits its reasoning through the CONTENT
// channel wrapped in its native markers. The client stores that as visible assistant
// text and resends it next turn, re-priming more reasoning-as-text — the loop.
//
// This module detects the markers in the content stream and lets the egress reroute
// the marked spans to the thinking channel (which clients do not resend), breaking the
// loop. Scope: a LEADING reasoning block only (marker at the very start, optional
// whitespace before it). No synthetic signatures, no router reliance, no guesses about
// unmarked or mid-answer content. Handles markers split across stream deltas.

const THINK_OPEN = '<' + 'think' + '>';
const THINK_CLOSE = '<' + '/' + 'think' + '>';

const MAX_PENDING = 32000; // hold ceiling for an unterminated think span
const MAX_LEAD = 8192;     // undecided-hold ceiling before committing to text


export class ThinkTextClassifier {
  constructor() {
    this.pending = '';
    this.mode = 'undecided'; // undecided | text | think
  }

  // Feed a content delta; returns { text, thinking } — slices to emit on each channel
  // right now ('' when nothing is due).
  feed(delta) {
    if (!delta) return { text: '', thinking: '' };
    if (this.mode === 'text') return { text: delta, thinking: '' };
    if (this.mode === 'think') return this._feedThink(delta);
    return this._feedUndecided(delta);
  }

  _feedUndecided(delta) {
    this.pending += delta;

    // Enough held without a decision -> it is plain text; commit.
    if (this.pending.length > MAX_LEAD) return this._commitText();

    const oi = this.pending.indexOf(THINK_OPEN);
    if (oi >= 0) {
      if (this.pending.slice(0, oi).trim() === '') {
        // Leading marker -> enter think mode; drop whitespace-only prefix.
        this.mode = 'think';
        this.pending = this.pending.slice(oi + THINK_OPEN.length);
        return this._feedThink(''); // process the remainder of this same delta
      }
      // Marker present but real text precedes it -> inline, not a leak.
      return this._commitText();
    }

    // No full marker yet. Could the pending still grow into one?
    const core = this.pending.replace(/^\s+/, '');
    if (core.length === 0) return { text: '', thinking: '' }; // only whitespace so far
    if (THINK_OPEN.startsWith(core)) return { text: '', thinking: '' }; // partial marker
    return this._commitText(); // definitively not a leading marker
  }

  _commitText() {
    const out = this.pending;
    this.pending = '';
    this.mode = 'text';
    return { text: out, thinking: '' };
  }

  _feedThink(delta) {
    this.pending += delta;

    const ci = this.pending.indexOf(THINK_CLOSE);
    if (ci >= 0) {
      const span = this.pending.slice(0, ci);
      const rest = this.pending.slice(ci + THINK_CLOSE.length);
      this.pending = '';
      this.mode = 'undecided'; // may catch a following block; normal text commits
      const cont = this._feedUndecided(rest);
      return { text: cont.text, thinking: span + cont.thinking };
    }

    if (this.pending.length > MAX_PENDING) {
      // Pathological unterminated span -> deliver as text (visible beats dropped,
      // and loop-break value is gone at this size anyway).
      const dump = this.pending;
      this.pending = '';
      this.mode = 'text';
      return { text: dump, thinking: '' };
    }

    return { text: '', thinking: '' }; // buffer until the close marker proves it
  }

  // Stream end: flush whatever is held. Undecided content is text; an unterminated
  // think span is NOT rerouted (it never proved it was reasoning) — delivered as text.
  flush() {
    const out = this.pending;
    this.pending = '';
    this.mode = 'text';
    return out;
  }
}

export const THINK_MARKERS = { open: THINK_OPEN, close: THINK_CLOSE };
